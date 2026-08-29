/**
 * Response cleaning, value normalization, filter escaping and path validation.
 *
 * Split out of server.ts so it can be tested without starting a server or
 * touching the network. Everything here is side-effect free; see test/unit.ts.
 */

// Thrown for bad tool arguments. Reported back to the model as an error result
// with a message explaining how to fix the call, rather than being silently
// ignored or surfacing as an opaque stack trace.
export class UsageError extends Error {}

// ---------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------

// The epoch value is already UTC; a trailing offset is display information,
// so it is matched to keep the regex anchored but deliberately not applied.
const SAP_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

// Edm.Time arrives as an ISO 8601 duration measured from midnight. Every
// component is optional in the format — PT20H17M49S, but also PT5M, PT45S,
// PT1H30M — and seconds may carry a fraction. Left raw, a model has to be told
// how to read it.
const SAP_TIME = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?$/;

export function normalizeValue(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const date = value.match(SAP_DATE);
  if (date) {
    const parsed = new Date(Number(date[1]));
    if (Number.isNaN(parsed.getTime())) return value;
    const iso = parsed.toISOString();
    // Pure dates (midnight UTC) read better without a time component.
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }

  const time = value.match(SAP_TIME);
  // A bare "PT" matches the regex with no components captured; that carries no
  // time and is left alone rather than becoming a misleading 00:00:00.
  if (time && (time[1] || time[2] || time[3])) {
    const pad = (part: string | undefined) => (part ?? "0").padStart(2, "0");
    return `${pad(time[1])}:${pad(time[2])}:${pad(time[3])}`;
  }

  return value;
}

// ---------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------
// __metadata blocks and __deferred navigation links are about 59% of a
// five-record read and carry nothing a model can act on. See README.

export function isDeferred(value: unknown): boolean {
  return (
    Boolean(value) && typeof value === "object" && "__deferred" in (value as object)
  );
}

export function cleanRecord(record: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "__metadata") continue;
    if (isDeferred(value)) continue;
    out[key] = normalizeValue(value);
  }
  return out;
}

export function unwrapResults(data: any): Record<string, unknown>[] {
  const results = data?.d?.results ?? (data?.d ? [data.d] : []);
  const list = Array.isArray(results) ? results : [results];
  return list.map(cleanRecord);
}

// ---------------------------------------------------------------------
// Filter values
// ---------------------------------------------------------------------

// Escape a value for use inside an OData string literal.
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// An all-whitespace filter value means the caller did not really supply one.
// Building a filter from it (substringof('',…)) is accepted by some SAP
// systems and rejected by others, and either way it matches everything — so
// treat it as no filter at all.
export function meaningful(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// ---------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------

// OData identifiers only — this value is interpolated into $select.
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

export function assertFieldNames(fields: string[], entityName: string): string[] {
  const bad = fields.filter((f) => !FIELD_NAME.test(f.trim()));
  if (bad.length > 0) {
    throw new UsageError(
      `Invalid field name(s): ${bad.join(", ")}. Field names are letters, ` +
        `digits and underscores. Call list-entity-fields with entity ` +
        `"${entityName}" to see what is available.`
    );
  }
  return fields.map((f) => f.trim());
}

// ---------------------------------------------------------------------
// Request safety
// ---------------------------------------------------------------------
// Requests carry Basic Auth credentials, and axios lets an absolute URL
// override baseURL — so an unchecked endpoint would send those credentials
// wherever it was pointed. Tool arguments come from a model, and a model can be
// influenced by text coming back from SAP, so the path is checked, not trusted.

export function assertSafePath(endpoint: string): string {
  const value = endpoint.trim();

  if (value === "") {
    throw new UsageError(
      `endpoint is empty. Pass an OData path such as ` +
        `"/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=5".`
    );
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new UsageError(
      `endpoint must be a path on the configured SAP host, not a full URL. ` +
        `Got "${value}". Pass something like ` +
        `"/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=5".`
    );
  }

  // "//host/path" and "\\host\path" are both authority-relative URLs pointing
  // at a different host. A single leading slash is the only accepted form.
  if (/^[/\\]{2}/.test(value)) {
    throw new UsageError(
      `endpoint must start with a single "/" — "//host/path" addresses ` +
        `another host, which this server will not call.`
    );
  }
  if (value.startsWith("\\")) {
    throw new UsageError(`endpoint must start with "/". Got "${value}".`);
  }

  // A path with no leading slash is unambiguous and resolves against the same
  // host, so normalize it rather than rejecting — the previous version of this
  // server accepted it, and refusing would be a pointless regression.
  return value.startsWith("/") ? value : `/${value}`;
}

// ---------------------------------------------------------------------
// Error description
// ---------------------------------------------------------------------
// SAP error bodies range from a tidy OData error object to a full HTML page
// (its "Service cannot be reached" screen is over 9,000 characters). All of it
// would land in the model's context, so pull out the useful sentence where
// there is one and cap the rest.

export const MAX_ERROR_BODY = 600;

export function describeSapError(data: unknown): string {
  const odataMessage = (data as any)?.error?.message?.value;
  if (typeof odataMessage === "string" && odataMessage.trim()) {
    const code = (data as any)?.error?.code;
    return code ? `${odataMessage} [${code}]` : odataMessage;
  }

  let text: string;
  if (typeof data === "string") text = data;
  else if (Buffer.isBuffer(data)) text = data.toString("utf8");
  else text = JSON.stringify(data) ?? "";

  if (!text) return "";
  return text.length > MAX_ERROR_BODY
    ? `${text.slice(0, MAX_ERROR_BODY)}… (${text.length} characters, truncated)`
    : text;
}

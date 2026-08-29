/**
 * sap-mcp-server — read-only SAP S/4HANA access over MCP, spoken over stdio.
 *
 * Three typed per-entity tools build the OData query in code so the model picks
 * a tool and a couple of parameters instead of writing a URL. list-entity-fields
 * covers field discovery, and get-sap-data stays as an escape hatch for paths
 * this server does not model. README has the reasoning.
 *
 * One gotcha worth recording: this uses the high-level McpServer API. The
 * low-level Server class has no .tool(), and mixing the two up throws
 * "TypeError: server.tool is not a function".
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  UsageError,
  assertFieldNames,
  assertSafePath,
  describeSapError,
  isDeferred,
  meaningful,
  odataString,
  unwrapResults,
} from "./lib/odata.js";

// Resolve .env against this file, not the working directory. Clients spawn the
// server from wherever they happen to be, so cwd is not something to rely on.
// Keeping it here also means no client config has to hold a second copy of the
// credentials.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, ".env") });

// ---------------------------------------------------------------------
// 1. Environment / configuration
// ---------------------------------------------------------------------
// Fail fast and loudly if required config is missing, rather than
// letting every tool call fail with a confusing auth error later.

const SAP_HOST = process.env.SAP_HOST;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

const missing = ["SAP_HOST", "SAP_USER", "SAP_PASS"].filter(
  (key) => !process.env[key]
);

if (missing.length > 0) {
  console.error(
    `Fatal: missing required environment variable(s): ${missing.join(", ")}.\n` +
      `Create a .env file next to server.ts (copy .env.example) or set them ` +
      `in your MCP client's "env" config block.`
  );
  process.exit(1);
}

if (/^http:\/\//i.test(SAP_HOST!)) {
  // Basic Auth over plain HTTP is base64, not encryption. Warn on stderr,
  // which MCP clients surface in their logs, rather than failing outright —
  // an internal sandbox on a trusted network is a legitimate setup.
  console.error(
    "Warning: SAP_HOST uses http://. Basic Auth credentials are sent " +
      "base64-encoded, which is reversible. Use https:// unless this " +
      "network is fully trusted."
  );
}

const SAP_AUTH = Buffer.from(`${SAP_USER}:${SAP_PASS}`).toString("base64");

// Optional. Some S/4HANA systems require an explicit client number; where it
// is set, it must go on every request, so it is applied at the axios instance
// rather than in each tool. axios merges these into whatever query string the
// request already has.
const SAP_CLIENT = process.env.SAP_CLIENT?.trim();

const sap = axios.create({
  baseURL: SAP_HOST,
  headers: {
    Authorization: `Basic ${SAP_AUTH}`,
    Accept: "application/json",
  },
  params: SAP_CLIENT ? { "sap-client": SAP_CLIENT } : undefined,
  // Generous enough for a large `top` or an $expand, short enough that a
  // wedged request doesn't leave the client waiting indefinitely.
  timeout: 30000,
});

// ---------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------
// The pure logic lives in lib/odata.ts so it can be tested without a server or
// a network. What stays here is the MCP result shape.

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function toErrorResult(err: any) {
  if (err instanceof UsageError) return failure(err.message);
  const status = err.response?.status;
  const body = err.response?.data;
  const message =
    body !== undefined && body !== null && body !== ""
      ? describeSapError(body)
      : err.message;
  return failure(
    `SAP request failed${status ? ` (HTTP ${status})` : ""}: ${message}`
  );
}

// ---------------------------------------------------------------------
// 3. Entity definitions
// ---------------------------------------------------------------------
// `select` lists are deliberately short: the fields you would actually put
// in a table. Callers that need others pass `fields`, or fall back to
// get-sap-data. `key` is always included so every row stays identifiable.

interface Entity {
  path: string;
  key: string;
  select: string[];
  orderby: string;
}

const ENTITIES = {
  businessPartner: {
    path: "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner",
    key: "BusinessPartner",
    select: [
      "BusinessPartner",
      "BusinessPartnerFullName",
      "BusinessPartnerCategory",
      "BusinessPartnerGrouping",
      "Customer",
      "Supplier",
      "CreatedByUser",
      "CreationDate",
    ],
    orderby: "BusinessPartner",
  },
  salesOrder: {
    path: "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder",
    key: "SalesOrder",
    select: [
      "SalesOrder",
      "SalesOrderType",
      "SalesOrganization",
      "SoldToParty",
      "SalesOrderDate",
      "TotalNetAmount",
      "TransactionCurrency",
      "OverallSDProcessStatus",
      "OverallDeliveryStatus",
    ],
    orderby: "SalesOrder",
  },
  purchaseOrder: {
    path: "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder",
    key: "PurchaseOrder",
    select: [
      "PurchaseOrder",
      "PurchaseOrderType",
      "CompanyCode",
      "Supplier",
      "AddressName",
      "AddressCityName",
      "AddressRegion",
      "PurchaseOrderDate",
      "DocumentCurrency",
      "PurchasingProcessingStatus",
    ],
    orderby: "PurchaseOrder",
  },
} satisfies Record<string, Entity>;

type EntityName = keyof typeof ENTITIES;

const ENTITY_NAMES = Object.keys(ENTITIES) as [EntityName, ...EntityName[]];

async function readEntity(
  entityName: EntityName,
  top: number,
  filter?: string,
  fields?: string[]
) {
  const entity: Entity = ENTITIES[entityName];

  // A caller-supplied field list replaces the curated default, but the key
  // is always kept so rows can be told apart.
  const select = fields?.length
    ? Array.from(new Set([entity.key, ...assertFieldNames(fields, entityName)]))
    : entity.select;

  // Built by hand rather than with URLSearchParams, which percent-encodes the
  // "$" of every system query option as %24. This sandbox accepts that, but it
  // is not universal across SAP Gateway configurations and reads as corrupt in
  // a log. Option names are fixed strings here; only values are encoded.
  const query = [
    `$top=${top}`,
    `$orderby=${entity.orderby}`,
    `$select=${select.join(",")}`,
    "$format=json",
  ];
  if (filter) query.push(`$filter=${encodeURIComponent(filter)}`);

  const res = await sap.get(`${entity.path}?${query.join("&")}`);
  const rows = unwrapResults(res.data);

  // SAP accepts a navigation property in $select and then returns it as a
  // __deferred link, which the cleaner drops — so the caller would get a row
  // missing the very field it asked for, with no error. Say so instead.
  if (fields?.length && rows.length > 0) {
    const returned = new Set(Object.keys(rows[0]));
    const absent = select.filter((name) => !returned.has(name));
    if (absent.length > 0) {
      throw new UsageError(
        `SAP did not return these requested field(s): ${absent.join(", ")}. ` +
          `They are most likely navigation properties, which cannot be used ` +
          `with \`fields\` — call list-entity-fields to see which names are ` +
          `data fields, and use get-sap-data with $expand for the rest.`
      );
    }
  }

  // Always valid JSON, including when empty — a client that parses the result
  // must not have to special-case "no matches". Compact on purpose: every
  // character lands in the model's context.
  return textResult(JSON.stringify(rows));
}

// ---------------------------------------------------------------------
// 4. MCP server + tool registration
// ---------------------------------------------------------------------

const server = new McpServer({
  name: "s4hana-sandbox",
  version: "2.0.0",
});

const topParam = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe(
    "How many records to return. Defaults to 5. Large values produce large " +
      "results — roughly 60 tokens per record — so keep this small unless you " +
      "need the whole set. An empty result array means nothing matched."
  );

const fieldsParam = z
  .array(z.string())
  .optional()
  .describe(
    "Field names to return instead of the default set (this becomes the " +
      "OData $select). Use list-entity-fields to see what is available."
  );

server.tool(
  "get-business-partners",
  "List Business Partners (customers, suppliers and organizations) from SAP S/4HANA. " +
    "Returns the first N in ascending Business Partner ID order. " +
    "By default returns ID, name, category, grouping, customer and supplier numbers, " +
    "and creation details — pass `fields` for anything else.",
  {
    top: topParam,
    nameContains: z
      .string()
      .optional()
      .describe("Only return partners whose full name contains this text."),
    fields: fieldsParam,
  },
  async ({ top, nameContains, fields }) => {
    try {
      const search = meaningful(nameContains);
      const filter = search
        ? `substringof(${odataString(search)},BusinessPartnerFullName)`
        : undefined;
      return await readEntity("businessPartner", top ?? 5, filter, fields);
    } catch (err: any) {
      return toErrorResult(err);
    }
  }
);

server.tool(
  "get-sales-orders",
  "List Sales Orders from SAP S/4HANA, including net value, currency and " +
    "processing status. Returns the first N in ascending Sales Order number order. " +
    "Pass `fields` to return different columns.",
  {
    top: topParam,
    soldToParty: z
      .string()
      .optional()
      .describe("Only return orders for this sold-to party (customer) number."),
    fields: fieldsParam,
  },
  async ({ top, soldToParty, fields }) => {
    try {
      const party = meaningful(soldToParty);
      const filter = party
        ? `SoldToParty eq ${odataString(party)}`
        : undefined;
      return await readEntity("salesOrder", top ?? 5, filter, fields);
    } catch (err: any) {
      return toErrorResult(err);
    }
  }
);

server.tool(
  "get-purchase-orders",
  "List Purchase Orders from SAP S/4HANA, including supplier and address. " +
    "Returns the first N in ascending Purchase Order number order. " +
    "Pass `fields` to return different columns.",
  {
    top: topParam,
    supplier: z
      .string()
      .optional()
      .describe("Only return purchase orders for this supplier number."),
    fields: fieldsParam,
  },
  async ({ top, supplier, fields }) => {
    try {
      const supplierId = meaningful(supplier);
      const filter = supplierId
        ? `Supplier eq ${odataString(supplierId)}`
        : undefined;
      return await readEntity("purchaseOrder", top ?? 5, filter, fields);
    } catch (err: any) {
      return toErrorResult(err);
    }
  }
);

server.tool(
  "list-entity-fields",
  "List the field names available on a SAP entity. Call this before passing " +
    "`fields` to one of the get-* tools, instead of guessing field names.",
  {
    entity: z
      .enum(ENTITY_NAMES)
      .describe("Which entity to describe."),
  },
  async ({ entity }) => {
    try {
      const def: Entity = ENTITIES[entity];
      // One record is enough to enumerate the shape, and costs far less
      // than fetching and parsing the service's $metadata document.
      const res = await sap.get(`${def.path}?$top=1&$format=json`);
      const raw: Record<string, unknown> | undefined =
        res.data?.d?.results?.[0] ?? res.data?.d;
      if (!raw) {
        return failure(
          `Could not list fields: ${def.path} returned no records.`
        );
      }

      // Navigation properties can't go in $select, but they are reachable
      // through get-sap-data with $expand, so report them separately rather
      // than hiding them.
      const dataFields: string[] = [];
      const navigationProperties: string[] = [];
      for (const [key, value] of Object.entries(raw)) {
        if (key === "__metadata") continue;
        (isDeferred(value) ? navigationProperties : dataFields).push(key);
      }

      return textResult(
        JSON.stringify({
          entity,
          path: def.path,
          defaultFields: def.select,
          availableFields: dataFields.sort(),
          navigationProperties: navigationProperties.sort(),
          note:
            "availableFields can be passed as `fields`. navigationProperties " +
            "cannot — reach them with get-sap-data using $expand.",
        })
      );
    } catch (err: any) {
      return toErrorResult(err);
    }
  }
);

// The generic escape hatch. Use it for anything the typed tools do not
// cover — other entities, other query options, navigation properties.
// Returns SAP's raw JSON, which is large: roughly 12,000 tokens for five
// full Business Partner records.
server.tool(
  "get-sap-data",
  "Fetch data from any SAP S/4HANA OData path (read-only, GET only). " +
    "Prefer get-business-partners / get-sales-orders / get-purchase-orders when " +
    "they fit — they return far less data. Use this for other entities, entity-key " +
    "reads like A_BusinessPartner('1'), navigation properties, $expand, $count and " +
    "$metadata. Returns raw SAP JSON including __metadata, so keep $top small.",
  {
    endpoint: z
      .string()
      .describe(
        "Path on the configured SAP host, starting with '/'. Not a full URL. " +
          "e.g. /sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=5"
      ),
  },
  async ({ endpoint }) => {
    try {
      const path = assertSafePath(endpoint);

      // Ensure JSON is returned even if the caller forgot $format=json — but
      // not for the service-document endpoints. SAP Gateway rejects $format on
      // $metadata, $count and $value with an HTTP 400, so blindly appending it
      // makes those legitimate reads unreachable.
      const isRawEndpoint = /\/\$(metadata|count|value)(\?|$)/i.test(path);
      const separator = path.includes("?") ? "&" : "?";
      const url =
        isRawEndpoint || path.includes("$format=")
          ? path
          : `${path}${separator}$format=json`;

      // $metadata is XML and $count is plain text. The instance-wide
      // "Accept: application/json" makes SAP answer those with HTTP 406, so
      // widen it for exactly those endpoints.
      const res = await sap.get(
        url,
        isRawEndpoint ? { headers: { Accept: "*/*" } } : undefined
      );

      // $metadata returns XML and $count returns a bare number; neither is
      // JSON, so pass them through as text rather than re-serializing.
      const body =
        typeof res.data === "string"
          ? res.data
          : JSON.stringify(res.data, null, 2);
      return textResult(body);
    } catch (err: any) {
      return toErrorResult(err);
    }
  }
);

// ---------------------------------------------------------------------
// 5. Extend here
// ---------------------------------------------------------------------
// To add another entity: add an entry to ENTITIES with its path, key, a
// short default `select` and a stable `orderby`, then register a tool for
// it in the same shape as the three above. It is picked up by
// list-entity-fields automatically.
//
// GET only. Writes need SAP's CSRF two-handshake: fetch a token from
// .../$metadata with header x-csrf-token: fetch, then send that token and the
// session cookie on the write. Without it a write just 403s.

// ---------------------------------------------------------------------
// 6. Start
// ---------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sap-mcp-server: connected and ready (stdio).");
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

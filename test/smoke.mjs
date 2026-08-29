/**
 * Integration tests. Spawns server.ts as a child process speaking JSON-RPC over
 * stdio, the same way a real client does, and calls every tool against the SAP
 * host in .env.
 *
 * Integration rather than mocks on purpose: the failures worth catching here
 * are a renamed OData service, an expired password, a firewall change. A mock
 * catches none of them.
 *
 *   npm run test:smoke          Exit 0 = all passed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(projectRoot, "server.ts");
const tsxPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

if (!existsSync(tsxPath)) {
  console.error(
    `Cannot find tsx at ${tsxPath}.\n` +
      `Run "npm install" in the project folder first. If you installed with a ` +
      `package manager that does not use a flat node_modules layout, run the ` +
      `server with "npm start" instead and adapt this path.`
  );
  process.exit(1);
}
const envPath = join(projectRoot, ".env");
if (!existsSync(envPath)) {
  console.error(
    `Cannot find .env next to server.ts. These are integration tests — they ` +
      `call the real SAP host. Copy .env.example to .env and fill it in first.`
  );
  process.exit(1);
}

// Copying .env.example and forgetting to edit it is the obvious way to get
// here, and the resulting DNS failure is a lot less clear than saying so.
const envText = readFileSync(envPath, "utf8");
if (/REPLACE_ME|your-s4hana-host\.example\.com/.test(envText)) {
  console.error(
    `.env still contains the placeholder values from .env.example.\n` +
      `Open it and set SAP_HOST, SAP_USER and SAP_PASS to your real SAP ` +
      `connection details, then run this again.`
  );
  process.exit(1);
}

const child = spawn(process.execPath, [tsxPath, serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

let buffer = "";
const pending = new Map();
let nextId = 0;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}`)),
      30000
    );
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

async function call(name, args = {}) {
  const response = await request("tools/call", { name, arguments: args });
  if (response.error) {
    return { isError: true, text: JSON.stringify(response.error) };
  }
  return {
    isError: Boolean(response.result?.isError),
    text: response.result?.content?.[0]?.text ?? "",
  };
}

let passed = 0;
let failed = 0;

let skipped = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

// Used when this SAP system simply has no data to exercise a check with — a
// sales order with no sold-to party, say. Not a failure, but never silent:
// a skipped check is a check that proved nothing.
function skip(label, why) {
  skipped++;
  console.log(`  SKIP  ${label}\n        ${why}`);
}

function section(title) {
  console.log(`\n${title}`);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  notify("notifications/initialized");

  section("Handshake");
  check(
    "server identifies as s4hana-sandbox",
    init.result?.serverInfo?.name === "s4hana-sandbox",
    `got ${JSON.stringify(init.result?.serverInfo)}`
  );

  const list = await request("tools/list", {});
  const toolNames = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "get-business-partners",
    "get-purchase-orders",
    "get-sales-orders",
    "get-sap-data",
    "list-entity-fields",
  ];
  check(
    "advertises all five tools",
    JSON.stringify(toolNames) === JSON.stringify(expected),
    `got ${toolNames.join(", ")}`
  );

  // ------------------------------------------------------------------
  // Fixtures
  // ------------------------------------------------------------------
  // Discovered from whichever SAP system .env points at, never hardcoded.
  // Filter tests need a value that genuinely exists, and every system holds
  // different data — hardcoding this sandbox's business partners would make
  // the suite fail on someone else's system for reasons that say nothing
  // about whether the server works.

  section("Fixtures");
  const fixtures = {};

  async function firstRow(tool) {
    const result = await call(tool, { top: 1 });
    if (result.isError) return null;
    try {
      return JSON.parse(result.text)[0] ?? null;
    } catch {
      return null;
    }
  }

  const bpRow = await firstRow("get-business-partners");
  const soRow = await firstRow("get-sales-orders");
  const poRow = await firstRow("get-purchase-orders");

  fixtures.bpKey = bpRow?.BusinessPartner ?? null;
  fixtures.soldToParty = soRow?.SoldToParty || null;
  fixtures.supplier = poRow?.Supplier || null;

  // A fragment of a real partner name, for the substring filter. Prefer the
  // first whole word; fall back to the first few characters.
  const bpName = String(bpRow?.BusinessPartnerFullName ?? "").trim();
  const firstWord = bpName.split(/\s+/)[0] ?? "";
  fixtures.nameFragment =
    firstWord.length >= 3 ? firstWord : bpName.length >= 3 ? bpName.slice(0, 3) : null;

  // Field names to exercise `fields` with: real ones this system reports,
  // outside the curated default set.
  const describedBp = await call("list-entity-fields", { entity: "businessPartner" });
  let bpMeta = null;
  try {
    bpMeta = JSON.parse(describedBp.text);
  } catch {
    /* reported by the check below */
  }
  fixtures.extraFields = (bpMeta?.availableFields ?? [])
    .filter((f) => f !== "BusinessPartner" && !(bpMeta?.defaultFields ?? []).includes(f))
    .slice(0, 2);
  fixtures.navProperty = (bpMeta?.navigationProperties ?? [])[0] ?? null;

  check(
    "discovered a business partner key",
    Boolean(fixtures.bpKey),
    "get-business-partners returned no usable row"
  );
  check(
    "discovered two non-default field names",
    fixtures.extraFields.length === 2,
    `got ${JSON.stringify(fixtures.extraFields)}`
  );
  console.log(
    `        using: bp=${fixtures.bpKey} name~"${fixtures.nameFragment}" ` +
      `soldTo=${fixtures.soldToParty ?? "-"} supplier=${fixtures.supplier ?? "-"} ` +
      `fields=${fixtures.extraFields.join(",")} nav=${fixtures.navProperty ?? "-"}`
  );

  section("Typed entity reads");
  for (const [tool, keyField] of [
    ["get-business-partners", "BusinessPartner"],
    ["get-sales-orders", "SalesOrder"],
    ["get-purchase-orders", "PurchaseOrder"],
  ]) {
    const result = await call(tool, {});
    let rows = null;
    try {
      rows = JSON.parse(result.text);
    } catch {
      /* handled by the checks below */
    }
    check(
      `${tool} returns records`,
      !result.isError && Array.isArray(rows) && rows.length > 0,
      result.text.slice(0, 200)
    );
    check(
      `${tool} includes its key field`,
      Array.isArray(rows) && rows.every((r) => keyField in r),
      `missing ${keyField}`
    );
    check(
      `${tool} strips SAP metadata`,
      !result.text.includes("__metadata") && !result.text.includes("__deferred")
    );
    check(
      `${tool} converts SAP dates`,
      !result.text.includes("/Date("),
      "raw /Date(...)/ value leaked through"
    );
  }

  section("Ordering is stable");
  const first = await call("get-business-partners", { top: 5 });
  const second = await call("get-business-partners", { top: 5 });
  check("repeated calls return identical rows", first.text === second.text);

  section("Row count");
  const two = await call("get-business-partners", { top: 2 });
  check("top is honored", JSON.parse(two.text).length === 2);

  section("Filtering");
  if (!fixtures.nameFragment) {
    skip("nameContains narrows the result set", "no partner with a usable name");
  } else {
    const filtered = await call("get-business-partners", {
      nameContains: fixtures.nameFragment,
    });
    const filteredRows = JSON.parse(filtered.text);
    check(
      "nameContains narrows the result set",
      filteredRows.length > 0 &&
        filteredRows.every((r) =>
          String(r.BusinessPartnerFullName)
            .toUpperCase()
            .includes(fixtures.nameFragment.toUpperCase())
        ),
      filtered.text.slice(0, 200)
    );
  }

  // These build an OData $filter containing spaces (`SoldToParty eq '...'`),
  // which the URL encoder turns into '+'. SAP has to accept that or every
  // equality filter silently breaks.
  if (!fixtures.soldToParty) {
    skip(
      "soldToParty equality filter works (spaces in $filter)",
      "no sales order with a sold-to party to filter on"
    );
  } else {
    const byCustomer = await call("get-sales-orders", {
      soldToParty: fixtures.soldToParty,
    });
    const customerRows = JSON.parse(byCustomer.text);
    check(
      "soldToParty equality filter works (spaces in $filter)",
      !byCustomer.isError &&
        customerRows.length > 0 &&
        customerRows.every((r) => r.SoldToParty === fixtures.soldToParty),
      byCustomer.text.slice(0, 200)
    );
  }

  if (!fixtures.supplier) {
    skip("supplier equality filter works", "no purchase order with a supplier");
  } else {
    const bySupplier = await call("get-purchase-orders", {
      supplier: fixtures.supplier,
    });
    const supplierRows = JSON.parse(bySupplier.text);
    check(
      "supplier equality filter works",
      !bySupplier.isError &&
        supplierRows.length > 0 &&
        supplierRows.every((r) => r.Supplier === fixtures.supplier),
      bySupplier.text.slice(0, 200)
    );
  }

  const quoted = await call("get-business-partners", { nameContains: "O'Brien" });
  check(
    "apostrophes in a filter value are escaped, not a syntax error",
    !quoted.isError && Array.isArray(JSON.parse(quoted.text)),
    quoted.text.slice(0, 200)
  );

  // Must fit SoldToParty's 10-character limit, or SAP rejects the filter
  // outright instead of returning an empty set.
  const none = await call("get-sales-orders", { soldToParty: "9999999999" });
  check(
    "an empty result set is still valid JSON",
    !none.isError && JSON.parse(none.text).length === 0,
    none.text.slice(0, 200)
  );

  const tooLong = await call("get-sales-orders", { soldToParty: "THIS_IS_FAR_TOO_LONG" });
  check(
    "an over-length filter value reports SAP's error clearly",
    tooLong.isError && tooLong.text.startsWith("SAP request failed"),
    tooLong.text.slice(0, 200)
  );

  if (!fixtures.nameFragment || fixtures.extraFields.length === 0) {
    skip("fields and a filter work together", "no name fragment or spare field");
  } else {
    const extra = fixtures.extraFields[0];
    const combined = await call("get-business-partners", {
      nameContains: fixtures.nameFragment,
      fields: ["BusinessPartnerFullName", extra],
    });
    const combinedRows = JSON.parse(combined.text);
    check(
      "fields and a filter work together",
      combinedRows.length > 0 &&
        combinedRows.every(
          (r) =>
            extra in r &&
            String(r.BusinessPartnerFullName)
              .toUpperCase()
              .includes(fixtures.nameFragment.toUpperCase())
        ),
      combined.text.slice(0, 200)
    );
  }

  section("Field selection");
  const fields = await call("get-business-partners", {
    top: 2,
    fields: fixtures.extraFields,
  });
  const fieldRows = JSON.parse(fields.text);
  check(
    "custom fields are returned",
    fieldRows.every((r) => fixtures.extraFields.every((f) => f in r)),
    fields.text.slice(0, 200)
  );
  check(
    "key field is always included",
    fieldRows.every((r) => "BusinessPartner" in r)
  );
  check(
    "default fields are replaced, not merged",
    fieldRows.every((r) => !("CreatedByUser" in r))
  );

  const badField = await call("get-business-partners", {
    fields: ["Business Partner; DROP"],
  });
  check(
    "invalid field names are rejected with guidance",
    badField.isError && badField.text.includes("list-entity-fields"),
    badField.text.slice(0, 200)
  );

  // SAP accepts a navigation property in $select and returns it as a
  // __deferred link, which the cleaner drops — the caller must not silently
  // get a row missing the field it asked for.
  if (!fixtures.navProperty) {
    skip(
      "a navigation property in fields is reported, not silently dropped",
      "list-entity-fields reported no navigation properties"
    );
  } else {
    const navField = await call("get-business-partners", {
      top: 1,
      fields: [fixtures.navProperty],
    });
    check(
      "a navigation property in fields is reported, not silently dropped",
      navField.isError && navField.text.includes("navigation properties"),
      navField.text.slice(0, 200)
    );
  }

  const emptyFields = await call("get-business-partners", { top: 1, fields: [] });
  check(
    "an empty fields array falls back to the defaults",
    !emptyFields.isError && "CreatedByUser" in JSON.parse(emptyFields.text)[0],
    emptyFields.text.slice(0, 200)
  );

  section("Value normalization");
  const times = await call("get-business-partners", {
    top: 2,
    fields: ["CreationTime", "CreationDate"],
  });
  const timeRows = JSON.parse(times.text);
  check(
    "Edm.Time durations become readable clock times",
    timeRows.every((r) => /^\d{2}:\d{2}:\d{2}$/.test(String(r.CreationTime))),
    times.text.slice(0, 200)
  );

  const stamps = await call("get-sales-orders", {
    top: 2,
    fields: ["LastChangeDateTime"],
  });
  check(
    "timestamps with a time component keep it, in ISO form",
    JSON.parse(stamps.text).every((r) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(r.LastChangeDateTime))
    ),
    stamps.text.slice(0, 200)
  );

  const blankFilter = await call("get-business-partners", {
    top: 2,
    nameContains: "   ",
  });
  check(
    "a whitespace-only filter value is treated as no filter",
    !blankFilter.isError && JSON.parse(blankFilter.text).length === 2,
    blankFilter.text.slice(0, 200)
  );

  section("Field discovery");
  for (const entity of ["businessPartner", "salesOrder", "purchaseOrder"]) {
    const result = await call("list-entity-fields", { entity });
    let parsed = null;
    try { parsed = JSON.parse(result.text); } catch { /* checked below */ }
    check(
      `list-entity-fields works for ${entity}`,
      !result.isError && Array.isArray(parsed?.availableFields) &&
        parsed.availableFields.length > 0,
      result.text.slice(0, 200)
    );
  }

  const described = await call("list-entity-fields", { entity: "businessPartner" });
  const description = JSON.parse(described.text);
  check(
    "list-entity-fields reports available fields",
    Array.isArray(description.availableFields) &&
      description.availableFields.includes("BusinessPartner") &&
      description.availableFields.length > description.defaultFields.length
  );
  check(
    "list-entity-fields reports the current defaults",
    Array.isArray(description.defaultFields) &&
      description.defaultFields.includes("BusinessPartnerFullName")
  );
  check(
    "list-entity-fields separates navigation properties",
    Array.isArray(description.navigationProperties) &&
      description.navigationProperties.length > 0 &&
      description.navigationProperties.every(
        (n) => !description.availableFields.includes(n)
      )
  );

  // Every name it advertises must actually be accepted by `fields`.
  const advertised = description.availableFields.slice(0, 25);
  const roundTrip = await call("get-business-partners", {
    top: 1,
    fields: advertised,
  });
  check(
    "fields advertised by list-entity-fields are accepted",
    !roundTrip.isError && Array.isArray(JSON.parse(roundTrip.text)),
    roundTrip.text.slice(0, 250)
  );

  section("get-sap-data escape hatch");
  const raw = await call("get-sap-data", {
    endpoint: "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=1",
  });
  check(
    "still returns raw SAP JSON",
    !raw.isError && raw.text.includes("__metadata"),
    raw.text.slice(0, 200)
  );

  // Everything the previous single-tool version could reach must still work.
  const shapes = [
    [
      "entity-key read",
      `/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner('${fixtures.bpKey}')`,
      (t) => t.includes(`"BusinessPartner": "${fixtures.bpKey}"`),
    ],
    [
      "navigation property",
      `/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner('${fixtures.bpKey}')/${fixtures.navProperty}?$top=2`,
      (t) => t.includes('"d"'),
    ],
    [
      "$expand",
      `/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=1&$expand=${fixtures.navProperty}`,
      (t) => t.includes(fixtures.navProperty),
    ],
    [
      "caller-specified $format is respected",
      "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=1&$format=xml",
      (t) => t.includes("<feed") || t.includes("<?xml"),
    ],
    [
      "path without a leading slash is normalized",
      "sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=1",
      (t) => t.includes("__metadata"),
    ],
    [
      "$metadata (no $format appended)",
      "/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata",
      (t) => t.includes("<edmx:Edmx") || t.includes("EntityType"),
    ],
    [
      "$count (no $format appended)",
      "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner/$count",
      (t) => /^\s*"?\d+"?\s*$/.test(t),
    ],
  ];
  for (const [label, endpoint, predicate] of shapes) {
    const result = await call("get-sap-data", { endpoint });
    check(
      `get-sap-data: ${label}`,
      !result.isError && predicate(result.text),
      result.text.slice(0, 200)
    );
  }

  section("Request safety");
  for (const [label, endpoint] of [
    ["absolute http URL", "http://127.0.0.1:9/exfil"],
    ["absolute https URL", "https://example.com/exfil"],
    ["scheme-relative with uppercase", "HTTPS://example.com/exfil"],
    ["protocol-relative URL", "//example.com/exfil"],
    ["backslash authority", "\\\\example.com\\exfil"],
  ]) {
    const blocked = await call("get-sap-data", { endpoint });
    check(
      `${label} is refused`,
      blocked.isError && !blocked.text.includes("SAP request failed"),
      blocked.text.slice(0, 200)
    );
  }

  for (const [label, endpoint] of [
    ["an empty endpoint", ""],
    ["a whitespace-only endpoint", "   "],
  ]) {
    const empty = await call("get-sap-data", { endpoint });
    check(
      `${label} is refused before any request is made`,
      empty.isError && empty.text.includes("endpoint is empty"),
      empty.text.slice(0, 200)
    );
  }

  section("Concurrency");
  // MCP clients can have several tool calls in flight at once; responses are
  // matched by id, so a shared axios instance must not cross them over.
  const concurrent = await Promise.all([
    call("get-business-partners", { top: 3 }),
    call("get-sales-orders", { top: 3 }),
    call("get-purchase-orders", { top: 3 }),
  ]);
  check(
    "three simultaneous calls all return valid, distinct results",
    concurrent.every((r) => !r.isError) &&
      concurrent.every((r) => Array.isArray(JSON.parse(r.text))) &&
      new Set(concurrent.map((r) => r.text)).size === 3,
    concurrent.map((r) => r.text.slice(0, 60)).join(" | ")
  );

  section("Error reporting");
  const notFound = await call("get-sap-data", {
    endpoint: "/sap/opu/odata/sap/NO_SUCH_SERVICE/Nothing?$top=1",
  });
  check(
    "an unknown service reports a SAP error, not a crash",
    notFound.isError && notFound.text.startsWith("SAP request failed"),
    notFound.text.slice(0, 200)
  );
  check(
    "a SAP OData error is reduced to its message",
    notFound.text.length < 400,
    `${notFound.text.length} chars`
  );

  // SAP's "Service cannot be reached" screen is a >9,000 character HTML page.
  // Passing that through would flood the model's context.
  const htmlError = await call("get-sap-data", { endpoint: "/definitely/not/a/service" });
  check(
    "an HTML error page is truncated",
    htmlError.isError && htmlError.text.length < 900,
    `${htmlError.text.length} chars: ${htmlError.text.slice(0, 120)}`
  );
  // Spawned separately, with a host nothing is listening on, to exercise the
  // path someone actually hits when the VPN is down or SAP is offline.
  section("Unreachable host");
  const offline = spawn(process.execPath, [tsxPath, serverPath], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, SAP_HOST: "http://127.0.0.1:1", SAP_USER: "u", SAP_PASS: "p" },
  });
  try {
    const text = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("timed out")), 20000);
      offline.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 2) {
            clearTimeout(timer);
            resolve(m.result?.content?.[0]?.text ?? "");
          }
        }
      });
      offline.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get-business-partners", arguments: { top: 1 } } }) + "\n"
      );
    });
    check(
      "a connection failure is reported as a short message, not a stack trace",
      text.startsWith("SAP request failed") && !text.includes("    at ") && text.length < 200,
      text.slice(0, 200)
    );
  } finally {
    offline.kill();
  }
} catch (err) {
  failed++;
  console.log(`\n  FAIL  harness error: ${err.message}`);
} finally {
  child.kill();
}

console.log(
  `\n${passed} passed, ${failed} failed` + (skipped ? `, ${skipped} skipped` : "")
);
if (stderr.trim()) {
  console.log(`\nserver stderr:\n${stderr.trim()}`);
}
process.exit(failed === 0 ? 0 : 1);

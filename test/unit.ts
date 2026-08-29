/**
 * Unit tests for lib/odata.ts. No network, no server, no .env.
 *
 * These cover the shapes that are awkward to provoke from a live system:
 * unusual Edm.Time durations, pre-epoch dates, oversized and binary error
 * bodies, hostile endpoint strings.
 *
 *   npx tsx test/unit.ts        (or the first half of `npm test`)
 */

import {
  UsageError,
  assertFieldNames,
  assertSafePath,
  cleanRecord,
  describeSapError,
  meaningful,
  normalizeValue,
  odataString,
  unwrapResults,
} from "../lib/odata.js";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function equals(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, `expected ${e}, got ${a}`);
}

function throwsUsageError(label: string, fn: () => unknown, mustInclude = "") {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (err) {
    const ok =
      err instanceof UsageError &&
      (!mustInclude || err.message.includes(mustInclude));
    check(label, ok, err instanceof Error ? err.message : String(err));
  }
}

console.log("\nDate normalization");
equals("midnight UTC becomes a plain date", normalizeValue("/Date(1667260800000)/"), "2022-11-01");
equals("a timestamp keeps its time", normalizeValue("/Date(1682601886471+0000)/"), "2023-04-27T13:24:46.471Z");
equals("the epoch itself is handled", normalizeValue("/Date(0)/"), "1970-01-01");
equals("a pre-epoch date is handled", normalizeValue("/Date(-86400000)/"), "1969-12-31");
equals("a malformed date is left alone", normalizeValue("/Date(nonsense)/"), "/Date(nonsense)/");
equals("a non-date string is left alone", normalizeValue("BP02"), "BP02");
equals("non-strings pass through", normalizeValue(42), 42);
equals("null passes through", normalizeValue(null), null);

console.log("\nTime normalization (Edm.Time durations)");
equals("full duration", normalizeValue("PT20H17M49S"), "20:17:49");
equals("single digits are padded", normalizeValue("PT5H6M7S"), "05:06:07");
equals("midnight", normalizeValue("PT00H00M00S"), "00:00:00");
equals("hours omitted", normalizeValue("PT5M30S"), "00:05:30");
equals("minutes omitted", normalizeValue("PT2H30S"), "02:00:30");
equals("seconds only", normalizeValue("PT45S"), "00:00:45");
equals("hours only", normalizeValue("PT1H"), "01:00:00");
equals("fractional seconds are truncated", normalizeValue("PT10H30M15.500S"), "10:30:15");
equals("a bare PT is not turned into midnight", normalizeValue("PT"), "PT");
equals("an ISO duration with days is left alone", normalizeValue("P1DT2H"), "P1DT2H");

console.log("\nRecord cleaning");
equals(
  "metadata and deferred links are stripped, values normalized",
  cleanRecord({
    __metadata: { id: "x", uri: "x" },
    BusinessPartner: "1",
    CreationDate: "/Date(1667260800000)/",
    CreationTime: "PT20H17M49S",
    to_Customer: { __deferred: { uri: "x" } },
  }),
  { BusinessPartner: "1", CreationDate: "2022-11-01", CreationTime: "20:17:49" }
);
equals("a null-valued field is kept", cleanRecord({ A: null }), { A: null });
equals("a nested non-deferred object is kept", cleanRecord({ A: { b: 1 } }), { A: { b: 1 } });

console.log("\nResult unwrapping");
equals("a results array is unwrapped", unwrapResults({ d: { results: [{ A: "1" }] } }), [{ A: "1" }]);
equals("a single entity is wrapped in an array", unwrapResults({ d: { A: "1" } }), [{ A: "1" }]);
equals("an empty result set gives an empty array", unwrapResults({ d: { results: [] } }), []);
equals("a missing d gives an empty array", unwrapResults({}), []);
equals("undefined gives an empty array", unwrapResults(undefined), []);

console.log("\nOData string escaping");
equals("a plain value is quoted", odataString("ACME"), "'ACME'");
equals("an apostrophe is doubled", odataString("O'Brien"), "'O''Brien'");
equals("several apostrophes are all doubled", odataString("''"), "''''''");
equals("an empty string is still quoted", odataString(""), "''");

console.log("\nMeaningful filter values");
equals("a real value survives", meaningful(" ACME "), "ACME");
equals("whitespace becomes undefined", meaningful("   "), undefined);
equals("an empty string becomes undefined", meaningful(""), undefined);
equals("undefined stays undefined", meaningful(undefined), undefined);

console.log("\nField name validation");
equals("valid names pass through trimmed", assertFieldNames([" BusinessPartner ", "ZZ1_x"], "businessPartner"), ["BusinessPartner", "ZZ1_x"]);
equals("a leading underscore is allowed", assertFieldNames(["_x"], "businessPartner"), ["_x"]);
throwsUsageError("a name with a space is rejected", () => assertFieldNames(["Business Partner"], "businessPartner"), "list-entity-fields");
throwsUsageError("an injection attempt is rejected", () => assertFieldNames(["A;DROP"], "businessPartner"));
throwsUsageError("a name starting with a digit is rejected", () => assertFieldNames(["1Field"], "businessPartner"));
throwsUsageError("an empty name is rejected", () => assertFieldNames([""], "businessPartner"));

console.log("\nRequest path safety");
equals("an absolute path passes through", assertSafePath("/sap/opu/odata"), "/sap/opu/odata");
equals("a query string is preserved", assertSafePath("/a?$top=5&$filter=x eq '1'"), "/a?$top=5&$filter=x eq '1'");
equals("a relative path is normalized", assertSafePath("sap/opu/odata"), "/sap/opu/odata");
equals("surrounding whitespace is trimmed", assertSafePath("  /sap  "), "/sap");
throwsUsageError("http:// is refused", () => assertSafePath("http://evil.example/x"), "not a full URL");
throwsUsageError("https:// is refused", () => assertSafePath("https://evil.example/x"));
throwsUsageError("mixed-case scheme is refused", () => assertSafePath("HtTpS://evil.example/x"));
throwsUsageError("a non-http scheme is refused", () => assertSafePath("file:///etc/passwd"));
throwsUsageError("protocol-relative is refused", () => assertSafePath("//evil.example/x"));
throwsUsageError("backslash authority is refused", () => assertSafePath("\\\\evil.example\\x"));
throwsUsageError("a single backslash is refused", () => assertSafePath("\\evil"));
throwsUsageError("an empty endpoint is refused", () => assertSafePath(""), "endpoint is empty");
throwsUsageError("a whitespace endpoint is refused", () => assertSafePath("   "));

console.log("\nError description");
equals(
  "an OData error is reduced to message and code",
  describeSapError({ error: { code: "ABC", message: { lang: "en", value: "Resource not found." } } }),
  "Resource not found. [ABC]"
);
equals(
  "an OData error without a code keeps the message",
  describeSapError({ error: { message: { value: "Nope." } } }),
  "Nope."
);
check(
  "a long HTML body is truncated",
  (() => {
    const out = describeSapError("<html>" + "x".repeat(20000) + "</html>");
    return out.length < 700 && out.includes("truncated");
  })()
);
check(
  "a short body is returned whole",
  describeSapError("boom") === "boom"
);
check(
  "a Buffer body is decoded rather than shown as byte soup",
  describeSapError(Buffer.from("kaboom", "utf8")) === "kaboom"
);
equals("undefined yields an empty string", describeSapError(undefined), "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

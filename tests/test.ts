/**
 * Self-contained test runner. Run with `npm test`.
 * Exits with code 1 on any failure, 0 on success.
 */

import { redactPII, isValidFodselsnummer } from "../src/utils/pii-redact";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`✗ ${label}`);
  }
}

// Construct a checksum-valid fødselsnummer at test time so we don't hardcode a
// real-looking one in the repo.
function makeValidFnr(first9: string): string {
  if (!/^\d{9}$/.test(first9)) throw new Error("first9 must be 9 digits");
  const d = first9.split("").map(Number);
  const w1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
  let s1 = 0;
  for (let i = 0; i < 9; i++) s1 += d[i]! * w1[i]!;
  let c1 = 11 - (s1 % 11);
  if (c1 === 11) c1 = 0;
  if (c1 === 10) throw new Error("first9 yields c1=10; pick another");
  d.push(c1);
  const w2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s2 = 0;
  for (let i = 0; i < 10; i++) s2 += d[i]! * w2[i]!;
  let c2 = 11 - (s2 % 11);
  if (c2 === 11) c2 = 0;
  if (c2 === 10) throw new Error("first9 yields c2=10; pick another");
  return first9 + String(c1) + String(c2);
}

console.log("── pii-redact tests ──");

// ── SHOULD REDACT ──────────────────────────────────────────────────────
assertEq(redactPII("skf@hjortegarden.no"), "[skjult e-post]", "email: bare address");
assertEq(redactPII("Kontakt oss: post@farm.com om du har spørsmål"),
  "Kontakt oss: [skjult e-post] om du har spørsmål", "email: in sentence");
assertEq(redactPII("test.me+tag@sub.example.co.uk"), "[skjult e-post]", "email: plus-tag + subdomain + 2nd-level TLD");
assertEq(redactPII("+47 41 63 22 99"), "[skjult tlf]", "phone: +47 with spaces");
assertEq(redactPII("+4741632299"), "[skjult tlf]", "phone: +47 no spaces");
assertEq(redactPII("Ring 41632299 i dag"), "Ring [skjult tlf] i dag", "phone: plain 8-digit starting with 4");
assertEq(redactPII("90012345"), "[skjult tlf]", "phone: plain 8-digit starting with 9");

const validFnr = makeValidFnr("010190125"); // 01-01-1990, male, low individual number
assertTrue(isValidFodselsnummer(validFnr), `isValidFodselsnummer(${validFnr})`);
assertEq(redactPII(`Fødselsnummer ${validFnr}`), "Fødselsnummer [skjult]", "fnr: valid checksum redacted");
assertEq(redactPII(`Fnr: ${validFnr.slice(0, 6)} ${validFnr.slice(6)}`),
  "Fnr: [skjult]", "fnr: 6+5 split with space also matched");

// ── SHOULD NOT REDACT (false-positive guards) ─────────────────────────
assertEq(redactPII("Hjortegården"), "Hjortegården", "producer name");
assertEq(redactPII("oslo"), "oslo", "city name");
assertEq(redactPII("organic honey near Bergen"), "organic honey near Bergen", "English query");
assertEq(redactPII("ost og kjøtt"), "ost og kjøtt", "category terms");
assertEq(redactPII("gamkinn"), "gamkinn", "obscure search term");
assertEq(redactPII("Brønnøysund org 923456789"), "Brønnøysund org 923456789", "9-digit org number");
assertEq(redactPII("Postnr 3577"), "Postnr 3577", "4-digit postal code");
assertEq(redactPII("kr 150,-"), "kr 150,-", "price format");
assertEq(redactPII("10:00-17:00"), "10:00-17:00", "opening hours");
assertEq(redactPII("https://rettfrabonden.com/teknologi"),
  "https://rettfrabonden.com/teknologi", "URL with path");
assertEq(redactPII("60.494, 8.513"), "60.494, 8.513", "coordinates");
assertEq(redactPII("12345678"), "12345678", "8-digit starting with 1 — not Norwegian phone range");
assertEq(redactPII("Product-456-789"), "Product-456-789", "SKU / product code");
assertEq(redactPII("12345678901"), "12345678901", "11-digit without valid checksum (not a fnr)");
assertEq(redactPII("98765432109"), "98765432109", "another random 11-digit — random checksum miss");
assertEq(redactPII("Ordrenummer 109295152"), "Ordrenummer 109295152", "9-digit order number");
assertEq(redactPII("Se 2026-04-23 for dato"), "Se 2026-04-23 for dato", "ISO date");

// ── EDGE CASES ────────────────────────────────────────────────────────
assertEq(redactPII(""), "", "empty string returns empty");
assertEq(redactPII(null), "", "null returns empty string");
assertEq(redactPII(undefined), "", "undefined returns empty string");
assertEq(
  redactPII("Send til post@farm.no og ring +47 40404040"),
  "Send til [skjult e-post] og ring [skjult tlf]",
  "multiple PII in one string",
);
assertEq(
  redactPII("hjortegården stokke"),
  "hjortegården stokke",
  "actual search term from query logs",
);
assertEq(
  redactPII("skf@hjortegarden.no"),
  "[skjult e-post]",
  "actual PII search term from query logs (the one that triggered this work)",
);

// ── REPORT ────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("✓ all tests passed");

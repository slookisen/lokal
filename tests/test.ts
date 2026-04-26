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

// ── trust-score community signal tests ──
console.log("── trust-score community signal tests ──");

// Spin up an in-memory database that mimics the production schema so the
// service's direct SQL works without touching a real DB file.
import Database from "better-sqlite3";
import { __setDbForTesting } from "../src/database/init";
import { trustScoreService } from "../src/services/trust-score-service";

const memdb = new Database(":memory:");
memdb.exec(`
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    role TEXT,
    city TEXT,
    categories TEXT,
    tags TEXT,
    languages TEXT,
    schema_version TEXT,
    agent_version INTEGER,
    is_verified INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    trust_score REAL DEFAULT 0.5,
    created_at TEXT,
    last_seen_at TEXT
  );
  CREATE TABLE agent_knowledge (
    agent_id TEXT PRIMARY KEY,
    google_rating REAL,
    google_review_count INTEGER,
    address TEXT, postal_code TEXT, website TEXT, phone TEXT, email TEXT,
    opening_hours TEXT, products TEXT, about TEXT, specialties TEXT,
    certifications TEXT, payment_methods TEXT, delivery_options TEXT,
    tripadvisor_rating REAL, external_reviews TEXT, external_links TEXT,
    images TEXT, seasonality TEXT, delivery_radius INTEGER, min_order_value INTEGER,
    data_source TEXT, auto_sources TEXT, last_enriched_at TEXT,
    owner_updated_at TEXT, updated_at TEXT
  );
  CREATE TABLE agent_metrics (
    agent_id TEXT PRIMARY KEY,
    times_discovered INTEGER DEFAULT 0,
    times_contacted INTEGER DEFAULT 0,
    times_chosen INTEGER DEFAULT 0,
    last_interaction_at TEXT
  );
  CREATE TABLE agent_claims (
    id INTEGER PRIMARY KEY,
    agent_id TEXT,
    status TEXT
  );
`);
__setDbForTesting(memdb as any);

function seedAgent(id: string, rating: number | null, reviews: number) {
  memdb.prepare("INSERT INTO agents (id, name, role, is_active) VALUES (?, ?, ?, 1)").run(id, "Test " + id, "producer");
  if (rating !== null) {
    memdb.prepare("INSERT INTO agent_knowledge (agent_id, google_rating, google_review_count) VALUES (?, ?, ?)")
      .run(id, rating, reviews);
  }
}

// Use a private accessor — TS won't expose communitySignal directly,
// so test it through the breakdown which surfaces the value.
function getCommunity(id: string): number {
  return trustScoreService.getBreakdown(id).signals.community.value;
}

// Case 1: no rating → 0.3 neutral baseline
seedAgent("test-no-rating", null, 0);
assertEq(Math.round(getCommunity("test-no-rating") * 1000), 300, "no rating → 0.3 neutral");

// Case 2: 4.7/5 with 22 reviews → ~0.925 (Homme Gård profile in prod)
seedAgent("test-homme", 4.7, 22);
const homme = getCommunity("test-homme");
assertTrue(homme > 0.9 && homme < 0.95, `Homme-like (4.7, 22 reviews) → ${homme.toFixed(3)} expected ~0.925`);

// Case 3: 5.0 with only 1 review → moderate, NOT 1.0 (volume guard)
seedAgent("test-cherrypicked", 5.0, 1);
const cherry = getCommunity("test-cherrypicked");
assertTrue(cherry > 0.5 && cherry < 0.7, `5.0 + 1 review → ${cherry.toFixed(3)}, expected 0.5–0.7 (volume guard)`);

// Case 4: 5.0 with 20 reviews → exactly 1.0 ceiling
seedAgent("test-perfect", 5.0, 20);
const perfect = getCommunity("test-perfect");
assertEq(Math.round(perfect * 1000), 1000, "5.0 + 20 reviews → 1.0 ceiling");

// Case 5: 2.0 with 100 reviews → genuine penalty
seedAgent("test-bad", 2.0, 100);
const bad = getCommunity("test-bad");
assertTrue(bad < 0.3, `2.0 + 100 reviews → ${bad.toFixed(3)}, expected <0.3 (real penalty)`);

// Case 6: full trust score with all signals at max — confirms 100% is now reachable
memdb.prepare("UPDATE agents SET is_verified = 1, last_seen_at = ?, created_at = ? WHERE id = ?")
  .run(new Date().toISOString(), new Date().toISOString(), "test-perfect");
memdb.prepare("UPDATE agent_knowledge SET address = \'x\', postal_code = \'1\', website = \'x\', phone = \'1\', email = \'x@y\', opening_hours = \'[1]\', products = \'[1]\', about = \'x\', specialties = \'[1]\', certifications = \'[1]\', payment_methods = \'[1]\', delivery_options = \'[1]\', images = \'[1]\', owner_updated_at = ? WHERE agent_id = ?")
  .run(new Date().toISOString(), "test-perfect");
memdb.prepare("INSERT INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen, last_interaction_at) VALUES (?, 100, 30, 10, ?)")
  .run("test-perfect", new Date().toISOString());
const fullScore = trustScoreService.calculate("test-perfect");
assertTrue(fullScore >= 0.99, `max-everything agent → ${fullScore}, expected ≥ 0.99 (100% now reachable)`);

memdb.close();

// ── REPORT ────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("✓ all tests passed");

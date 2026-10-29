/**
 * debio-register-s1c.test.ts — økologi S1c: field mapping against Debio's REAL
 * register row shape (captured live 2026-10-29; bare array of
 * { sid, name, street, houseNr, zipCode, city, companyNumber, producerCode,
 *   clientCode, certificates: [{sid, from, to, enquiryOrigSid}], mainProductGroups,
 *   resultSids, … }).
 *
 *   norm      the captured sample + every fixture row in
 *             tests/fixtures/debio-register-real-shape-rows.json
 *   orgnr     companyNumber / producerCode are never an org.nr.
 *   sync      dry run over ≥ 2500 real-shape rows → rows_without_valid_to 0,
 *             status_counts right; write run: valid 509 → okologisk +
 *             debio_verified = 1, expired → not verified, companyNumber equal
 *             to our org.nr. → no match.
 *
 * In-memory DB on the production schema, injected fake fetch (no network).
 * Exported runDebioRegisterS1cTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/debio-register-s1c.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-10-29T12:00:00.000Z");
type Raw = Record<string, unknown>;

/** The row captured live (one element of the bare array), verbatim. */
const CAPTURED: Raw = {
  sid: 30531, name: "Torheim Gard AS", street: "Strynevegen 3196", houseNr: null, zipCode: "6798", city: "HJELLEDALEN",
  dispCertificate: true, companyNumber: "45613", producerCode: null, clientCode: "934608526",
  certificates: [{ sid: 344399, from: 1782079200000, to: 1830207600000, enquiryOrigSid: 2427498 }],
  mainProductGroups: [{ sid: 5016, name: "FIO – Foredling, import og omsetning", caption: "Foredling, import og omsetning", subProductGroups: null }],
  productGroupSids: [5318, 5283, 5282, 5286, 5281, 5260, 5285, 5314, 5328, 5317, 5264, 5577],
  regionSid: 11024, resultSids: [509], certificateAttachments: null,
};

function fixtureRows(): Raw[] {
  const p = path.join(__dirname, "..", "..", "tests", "fixtures", "debio-register-real-shape-rows.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Raw[];
}

const VALID_CERT = [{ sid: 1, from: 1782079200000, to: 1830207600000, enquiryOrigSid: 2 }];
const EXPIRED_CERT = [{ sid: 1, from: 1735772400000, to: 1790805600000, enquiryOrigSid: 2 }];

// Oslo-midnight instants, like Debio's (stored as the previous UTC date): from 2026-12-01 / to 2028-12-01 (not yet
// started on NOW), and an expired one ending 2026-09-01.
const FUTURE_CERT = { sid: 3, from: Date.UTC(2026, 10, 30, 23), to: Date.UTC(2028, 10, 30, 23), enquiryOrigSid: 4 };
const GAP_EXPIRED_CERT = { sid: 5, from: Date.UTC(2025, 7, 31, 22), to: Date.UTC(2026, 7, 31, 22), enquiryOrigSid: 6 };
const FUTURE_ROW: Raw = { ...CAPTURED, sid: 920001, name: "Framtid Gard AS", street: "Framtidsvegen 1", clientCode: "931000011", companyNumber: "70001", certificates: [FUTURE_CERT] };
const GAP_ROW: Raw = { ...CAPTURED, sid: 920002, name: "Hullet Gard AS", street: "Hullvegen 2", clientCode: "931000012", companyNumber: "70002", certificates: [GAP_EXPIRED_CERT, FUTURE_CERT] };

/** n synthetic rows in the real shape; status mix by index. */
function fillerRows(n: number): Raw[] {
  const out: Raw[] = [];
  const codes = [[509], [509], [502], [501], [5012], [509, 503]];
  for (let i = 0; i < n; i++) {
    out.push({
      sid: 200000 + i, name: `Syntetisk Virksomhet ${i} AS`, street: `Syntetvegen ${i + 1}`, houseNr: null, zipCode: "9990", city: "FYLLBY",
      dispCertificate: i % 2 === 0, companyNumber: String(60000 + i), producerCode: null, clientCode: String(850000000 + i),
      certificates: i % 7 === 0 ? EXPIRED_CERT : VALID_CERT,
      mainProductGroups: [{ sid: 5015, name: "LBP – Landbruksproduksjon", caption: "Landbruksproduksjon", subProductGroups: null }],
      productGroupSids: [5260], regionSid: 11000, resultSids: codes[i % codes.length], certificateAttachments: null,
    });
  }
  return out;
}

function fakeFetch(rows: Raw[]): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("getcertificates")) {
      if (init?.method !== "POST") return new Response("bad", { status: 400 });
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("finnoko.debio.no/api/acm/companies")) return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

interface Seed { id: string; name: string; city: string; org_nr: string }

// Our producers: names/cities unlike any register row, so only org.nr. can match.
const AGENTS: Seed[] = [
  { id: "c-valid", name: "Kvernhuset Mølle", city: "Andeby", org_nr: "931000001" },
  { id: "c-expired", name: "Steinrøys Gård", city: "Bebyen", org_nr: "931000002" },
  { id: "c-karens", name: "Vindfang Gård", city: "Cestad", org_nr: "931000003" },
  { id: "c-annet", name: "Ospelia Mat", city: "Dedal", org_nr: "931000004" },
  { id: "c-multi", name: "Nyhagen Grønt", city: "Eby", org_nr: "931000005" },
  { id: "c-company", name: "Torvbu Handel", city: "Effby", org_nr: "931999999" },
  { id: "c-house", name: "Løvbakken Gård", city: "Geby", org_nr: "931000007" },
  { id: "c-future", name: "Ospetun Gård", city: "Hby", org_nr: "931000011" },
  { id: "c-gap", name: "Rognlia Gård", city: "Iby", org_nr: "931000012" },
];

function seed(db: Database.Database, a: Seed): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified, org_nr)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9, 10.7, ?, '["vegetables"]', '["gårdsutsalg"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, 0, ?)`,
  ).run(a.id, a.name, "Familiegård med gårdsutsalg.", `post@${a.id}.example.no`, `https://${a.id}.example.no`, `key-${a.id}`, a.city, a.org_nr);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, address, postal_code, about, products, specialties, certifications,
        verification_status, enrichment_status, last_verified_at)
     VALUES (?, ?, ?, NULL, NULL, 'Vi selger grønnsaker.', '[]', '[]', '[]', 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
  ).run(a.id, `post@${a.id}.example.no`, `https://${a.id}.example.no`);
}

export async function runDebioRegisterS1cTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(m); if (log) console.info("  " + m); }
  };

  const client = require("./debio-register-client") as typeof import("./debio-register-client");
  const sync = require("./debio-register-sync") as typeof import("./debio-register-sync");
  const approval = require("./debio-approval") as typeof import("./debio-approval");
  const view = (r: ReturnType<typeof client.normalizeRegisterRow>) => r && {
    sid: r.sid, orgNr: r.orgNr, street: r.street, postal: r.postalCode, city: r.city, codes: r.statusCodes, status: r.status,
    validFrom: r.validFrom, validTo: r.validTo, groups: r.productGroups, labels: r.productGroupLabels,
  };

  // ── normalizer: the captured sample ───────────────────────────────────────
  assertEq(view(client.normalizeRegisterRow(CAPTURED, NOW)), {
    sid: "30531", orgNr: "934608526", street: "Strynevegen 3196", postal: "6798", city: "HJELLEDALEN", codes: [509], status: "okologisk",
    validFrom: "2026-06-21", validTo: "2027-12-30", groups: ["FIO"], labels: ["Foredling, import og omsetning"],
  }, "norm-captured: the live sample maps org.nr., sid, validity, status, groups, address");
  assertEq(client.normalizeRegisterResponse([CAPTURED], NOW).rows.length, 1, "norm-captured-2: bare array response");

  // ── normalizer: fixture rows ──────────────────────────────────────────────
  const fx = fixtureRows();
  const n = fx.map((r) => client.normalizeRegisterRow(r, NOW));
  assertEq(n.every((r) => r !== null && r.validTo !== null), true, "norm-fx-0: every fixture row normalized with a valid_to");
  assertEq(view(n[0]), { sid: "910001", orgNr: "931000001", street: "Fjelltunvegen 14", postal: "6798", city: "SYNTETBYGD", codes: [509], status: "okologisk",
    validFrom: "2026-06-21", validTo: "2027-12-30", groups: ["FIO"], labels: ["Foredling, import og omsetning"] }, "norm-fx-1: valid 509");
  assertEq([n[1]?.status, n[1]?.validTo, approval.certValidOn(n[1]?.validTo, NOW)], ["okologisk", "2026-09-30", false], "norm-fx-2: expired 509 → validTo in the past");
  assertEq([n[2]?.statusCodes, n[2]?.status, n[2]?.productGroups, n[2]?.productGroupLabels], [[502], "karens", ["LBP"], ["Landbruksproduksjon"]], "norm-fx-3: karens 502, LBP");
  assertEq([n[3]?.statusCodes, n[3]?.status], [[501], "annet"], "norm-fx-4: 501 only → annet");
  assertEq([n[4]?.validFrom, n[4]?.validTo, n[4]?.status], ["2025-09-30", "2027-06-30", "okologisk"], "norm-fx-5: expired + current certificate → the current one");
  assertEq([n[5]?.orgNr, n[5]?.sid], [null, "910006"], "norm-fx-6: clientCode null → no org.nr. (companyNumber never used), sid kept");
  assertEq([n[6]?.street, n[6]?.productGroups, n[6]?.productGroupLabels, n[6]?.status], ["Bakkevegen 12", ["LBP", "FIO"], ["Landbruksproduksjon", "Foredling, import og omsetning"], "okologisk"],
    "norm-fx-7: houseNr appended, LBP + FIO, 509 wins over 5012");
  assertEq([n[7]?.statusCodes, n[7]?.status, n[7]?.productGroups], [[5012], "annet", []], "norm-fx-8: serveringsmerket only → annet, null groups");

  // ── org.nr. never from companyNumber / producerCode ──────────────────────
  assertEq(client.normalizeRegisterRow({ ...CAPTURED, clientCode: null, companyNumber: "987654321", producerCode: "912345678" }, NOW)?.orgNr, null,
    "orgnr-1: 9-digit companyNumber / producerCode are not an org.nr.");
  assertEq(client.normalizeRegisterRow({ ...CAPTURED, clientCode: "12345678901" }, NOW)?.orgNr, null, "orgnr-2: an 11-digit clientCode is not an org.nr.");
  assertEq(client.normalizeRegisterRow({ ...CAPTURED, houseNr: "7" }, NOW)?.street, "Strynevegen 3196", "street-1: houseNr not appended when the street has a number");
  assertEq(client.normalizeRegisterRow({ ...CAPTURED, certificates: [] }, NOW)?.validTo, null, "valid-1: no certificates → no valid_to");
  const fut = client.normalizeRegisterRow(FUTURE_ROW, NOW);
  assertEq([fut?.validFrom, fut?.validTo, approval.certValidOn(fut?.validTo, NOW)], ["2026-11-30", null, false], "valid-2: only a not-yet-started certificate → no valid_to");
  const gap = client.normalizeRegisterRow(GAP_ROW, NOW);
  assertEq([gap?.validFrom, gap?.validTo, approval.certValidOn(gap?.validTo, NOW)], ["2025-08-31", "2026-08-31", false], "valid-3: expired + not-yet-started → the expired one");
  assertEq(client.certificateValidity([{ from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) }, FUTURE_CERT], NOW)?.validTo, "2027-01-01", "valid-4: current + future → max to among the current only");
  assertEq(sync.buildEntities([{ ...client.normalizeRegisterRow(CAPTURED, NOW)!, validFrom: "2026-12-01" }], NOW)[0]?.status, "ingen", "valid-5: a future validFrom never counts as okologisk, even with a valid_to");
  assertEq(approval.debioApprovalText("no", n[0]!.productGroups, "2026-10-29"), "Godkjent av Debio for foredling, import og omsetning — sjekket 29.10.2026", "text-1: FIO code feeds the label map");

  // ── sync over the real shape ──────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  const prevWarn = console.warn;
  const prevFlag = process.env.RFB_DEBIO_REGISTER_SYNC;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null; marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0; marketplaceRegistry._statsCacheTime = 0;
  };
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    clearRegistryCaches();
    for (const a of AGENTS) seed(db, a);
    process.env.RFB_DEBIO_REGISTER_SYNC = "1";
    const rows = [...fillerRows(2600), ...fx, FUTURE_ROW, GAP_ROW];

    const dry = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(rows), now: NOW, skipCache: true });
    assertEq([dry.accepted, dry.fetched_raw, dry.normalized, dry.rejected_rows, dry.rows_without_valid_to], [true, 2610, 2610, 0, 1],
      "sync-dry-1: ≥ 2500 real-shape rows accepted, all but the not-yet-started one with valid_to");
    assertEq(dry.status_counts, { okologisk: 3, karens: 1, annet: 1, ingen: 4 }, "sync-dry-2: status_counts from resultSids + certificates");
    assertEq([dry.matched.org_nr, dry.verified], [8, 3], "sync-dry-3: eight org.nr. matches, three would be verified");

    const wet = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(rows), dryRun: false, now: NOW, skipCache: true });
    assertEq(wet.accepted, true, "sync-wet-0: write run accepted");
    const row = (id: string) => db.prepare(`SELECT a.debio_verified AS v, s.debio_status AS st, s.debio_cert_valid_to AS vt, s.debio_product_groups AS g, s.debio_match_method AS m
      FROM agents a LEFT JOIN agent_debio_status s ON s.agent_id = a.id WHERE a.id = ?`).get(id) as any;
    const r1 = row("c-valid");
    assertEq([r1.st, r1.v, r1.vt, r1.g, r1.m], ["okologisk", 1, "2027-12-30", '["FIO"]', "org_nr"], "sync-wet-1: valid 509 → okologisk + debio_verified = 1");
    assertEq([row("c-expired").st, row("c-expired").v], ["ingen", 0], "sync-wet-2: expired 509 → not verified");
    assertEq([row("c-karens").st, row("c-karens").v], ["karens", 0], "sync-wet-3: karens → not verified");
    assertEq([row("c-annet").st, row("c-annet").v], ["annet", 0], "sync-wet-4: 501 → annet, not verified");
    assertEq([row("c-multi").st, row("c-multi").v, row("c-multi").vt], ["okologisk", 1, "2027-06-30"], "sync-wet-5: current of two certificates → verified");
    assertEq([row("c-company").st, row("c-company").v, row("c-company").m], ["ingen", 0, null], "sync-wet-6: companyNumber = our org.nr. → no match");
    assertEq([row("c-house").st, row("c-house").v], ["okologisk", 1], "sync-wet-7: houseNr row verified by org.nr.");
    assertEq([row("c-future").st, row("c-future").v], ["ingen", 0], "sync-wet-8: only a not-yet-started certificate → debio_verified = 0");
    assertEq([row("c-gap").st, row("c-gap").v], ["ingen", 0], "sync-wet-9: expired + not-yet-started (gap) → debio_verified = 0");
    // privacy: no register name / street persisted
    const dump = JSON.stringify([db.prepare("SELECT * FROM agent_debio_status").all(), db.prepare("SELECT * FROM debio_match_review").all(), db.prepare("SELECT * FROM agents").all()]);
    assertEq(["Fjelltun Foredling", "Fjelltunvegen", "Bakkevegen", "Torget 2"].filter((s) => dump.includes(s)), [], "privacy-1: no register name / street persisted");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    if (prevFlag === undefined) delete process.env.RFB_DEBIO_REGISTER_SYNC; else process.env.RFB_DEBIO_REGISTER_SYNC = prevFlag;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDebioRegisterS1cTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

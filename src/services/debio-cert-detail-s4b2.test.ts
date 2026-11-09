/**
 * debio-cert-detail-s4b2.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S4b-2: weekly storage of
 * Debio certificate-detail lines (services/debio-cert-detail-sync.ts) behind
 * RFB_DEBIO_CERT_DETAIL_SYNC (off by default).
 *
 *   flag        only "1" turns it on.
 *   selection   only okologisk + non-empty debio_sid; 7-day cutoff; missing
 *               first, then oldest fetched_at; maxPerRun (clamped 1–50).
 *   sync        zero candidates → no network call; exactly one register call
 *               per run; register failure → no writes; no id →
 *               'no_enquiry_orig_sid' row; fetch failure → ok=0 with a
 *               body-free last_error; dry run → register call only, no
 *               detail calls, no writes; partnerFullName never stored; agents
 *               / agent_debio_status byte-identical before and after; delay
 *               between detail calls.
 *   routes      POST /cert-detail-sync (admin key, 400 on invalid body,
 *               dry_run defaults true), GET /cert-detail-status shape.
 *   scheduler   index.ts registers the 6-hourly job behind the flag.
 *
 * Injected fake fetch (no network). Exported runDebioCertDetailS4b2Tests({log})
 * -> TestSummary; wired into tests/test.ts. Standalone:
 *   npx tsx src/services/debio-cert-detail-s4b2.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-09T12:00:00.000Z");
const T = NOW.getTime();
const DAY = 86_400_000;
// Synthetic Debio partner (person) name / street — must never be stored or returned.
const PARTNER = "Ola Nordmann";
const STREET = "Hemmeligveien 93";

type Raw = Record<string, unknown>;

function regRow(sid: number, enquiryOrigSid: number | null): Raw {
  return {
    sid, name: PARTNER, street: STREET, houseNr: null, zipCode: "3101", city: "PROBEBY",
    dispCertificate: true, companyNumber: String(70000 + sid), producerCode: null, clientCode: String(934000000 + sid),
    certificates: [{ sid: 1, from: T - 100 * DAY, to: T + 400 * DAY, ...(enquiryOrigSid === null ? {} : { enquiryOrigSid }) }],
    mainProductGroups: [{ sid: 5015, name: "LBP – Landbruksproduksjon", caption: "Landbruksproduksjon", subProductGroups: null }],
    productGroupSids: [5260], regionSid: 11000, resultSids: [509], certificateAttachments: null,
  };
}

function register(): Raw[] {
  return [regRow(100, 1001), regRow(200, 2001), regRow(300, 3001), regRow(700, 7001), regRow(800, null), regRow(900, 9001)];
}

function pos(name: string | null, category: string | null, sid: unknown, resultName: string | null = null): Raw {
  return { amount: null, category, name, partnerFullName: PARTNER, result: { caption: null, name: resultName, sid, subResult: null }, unit: "stk" };
}

function realDetail(): Raw {
  return {
    additionalDWReports: [],
    certificateDetailPos: [
      pos("Melk", "Husdyr", 509, "Økologisk"),
      pos("Korn", null, 501, "Ikke økologisk"),
      pos("Egg", "Husdyr", 12345, "Ukjent"),
    ],
    enquiryOrigSid: 1001, from: 1735689600000, sid: 99, to: 1767225600000,
    clientName: PARTNER, street: STREET,
  };
}

interface Counters { register: number; detail: number; detailIds: number[] }

function registerFetch(c: Counters, body: unknown = register(), status = 200): typeof fetch {
  return (async (url: any) => {
    c.register++;
    if (!String(url).includes("getcertificates")) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Detail fetch: per-id responses; 7001 → HTTP 500 whose body carries the person name. */
function detailFetch(c: Counters, byId: Record<number, { body: unknown; status?: number }> = {}): typeof fetch {
  return (async (_url: any, init: any) => {
    const id = Number(JSON.parse(String(init?.body ?? "{}")).enquiryOrigSid);
    c.detail++;
    c.detailIds.push(id);
    const hit = byId[id] ?? (id === 7001 ? { body: `error for ${PARTNER} at ${STREET}`, status: 500 } : { body: realDetail() });
    const b = hit.body;
    return new Response(typeof b === "string" ? b : JSON.stringify(b), { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export async function runDebioCertDetailS4b2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(m); if (log) console.info("  " + m); }
  };
  const assertTrue = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`); if (log) console.info(`  ✗ ${label}`); }
  };

  const svc = require("./debio-cert-detail-sync") as typeof import("./debio-cert-detail-sync");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const dbs: Database.Database[] = [];
  const ENV_KEYS = ["ADMIN_KEY", "DEBIO_REGISTER_EXTRA_CA_PEM", "RFB_DEBIO_CERT_DETAIL_SYNC"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevLog = console.log;
  const prevWarn = console.warn;
  const prevFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  let routeMod: any = null;

  try {
    delete process.env.DEBIO_REGISTER_EXTRA_CA_PEM;
    // Any un-injected network call is a test failure.
    (globalThis as any).fetch = async () => { globalFetchCalls++; throw new Error("network disabled in test"); };
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    /**
     * Fresh DB. Status rows:
     *   a1 okologisk 100, no detail       → candidate (missing)
     *   a2 okologisk 200, detail 10 d old → candidate
     *   a3 okologisk 300, detail 3 d old  → not (fresh)
     *   a4 karens    400                  → not (status)
     *   a5 okologisk NULL sid             → not
     *   a6 okologisk '' sid               → not
     *   a7 okologisk 700, detail 20 d old → candidate (HTTP 500)
     *   a8 okologisk 800, no detail       → candidate (no id in register)
     *   a9 annet     900                  → not (status)
     */
    const freshDb = (): Database.Database => {
      const db = new Database(":memory:");
      dbs.push(db);
      db.pragma("foreign_keys = ON");
      initMod.__initSchemaForTesting(db as any);
      const ins = db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified, org_nr)
         VALUES (?, ?, 'Familiegård.', 'test', ?, ?, 'producer', ?, 59.9, 10.7, 'Annenby', '["vegetables"]', '[]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?, ?)`,
      );
      const st = db.prepare(
        `INSERT INTO agent_debio_status (agent_id, debio_status, debio_cert_valid_to, debio_product_groups, debio_sid, debio_checked_at, debio_match_method)
         VALUES (?, ?, '2027-12-31', '["LBP"]', ?, '2026-11-08T04:00:00.000Z', 'org_nr')`,
      );
      const rows: Array<[string, string, string | null]> = [
        ["s4b2-a1", "okologisk", "100"], ["s4b2-a2", "okologisk", "200"], ["s4b2-a3", "okologisk", "300"],
        ["s4b2-a4", "karens", "400"], ["s4b2-a5", "okologisk", null], ["s4b2-a6", "okologisk", ""],
        ["s4b2-a7", "okologisk", "700"], ["s4b2-a8", "okologisk", "800"], ["s4b2-a9", "annet", "900"],
      ];
      rows.forEach(([id, status, sid], i) => {
        ins.run(id, `Testprodusent ${i}`, `post@p${i}.example.no`, `https://p${i}.example.no`, `key-s4b2-${i}`, status === "okologisk" ? 1 : 0, String(860000100 + i));
        st.run(id, status, sid);
      });
      const det = db.prepare(
        `INSERT INTO agent_debio_cert_detail (agent_id, enquiry_orig_sid, fetched_at, ok, recognized, lines_json, status_counts_json, organic_line_count, line_count, last_error)
         VALUES (?, ?, ?, 1, 1, '[]', '{}', 0, 0, NULL)`,
      );
      det.run("s4b2-a2", 2001, new Date(T - 10 * DAY).toISOString());
      det.run("s4b2-a3", 3001, new Date(T - 3 * DAY).toISOString());
      det.run("s4b2-a7", 7001, new Date(T - 20 * DAY).toISOString());
      return db;
    };
    const snapshot = (db: Database.Database) => JSON.stringify({
      agents: db.prepare("SELECT * FROM agents WHERE id LIKE 's4b2-%' ORDER BY id").all(),
      status: db.prepare("SELECT * FROM agent_debio_status ORDER BY agent_id").all(),
    });
    const detailRows = (db: Database.Database) => db.prepare("SELECT * FROM agent_debio_cert_detail ORDER BY agent_id").all() as any[];
    const newCounters = (): Counters => ({ register: 0, detail: 0, detailIds: [] });

    // ── flag ─────────────────────────────────────────────────────────────
    assertEq(svc.DEBIO_CERT_DETAIL_SYNC_ENV, "RFB_DEBIO_CERT_DETAIL_SYNC", "flag-1: env name");
    assertEq(
      [undefined, "1", "true", "0", "", "yes", " 1"].map((v) => svc.debioCertDetailSyncEnabled(v === undefined ? {} : { RFB_DEBIO_CERT_DETAIL_SYNC: v })),
      [false, true, false, false, false, false, false],
      "flag-2: only the literal \"1\" turns it on (off by default)",
    );

    // ── schema ───────────────────────────────────────────────────────────
    {
      const db = freshDb();
      const cols = (db.prepare("PRAGMA table_info(agent_debio_cert_detail)").all() as Array<{ name: string; pk: number }>);
      assertEq(cols.map((c) => c.name), ["agent_id", "enquiry_orig_sid", "fetched_at", "ok", "recognized", "lines_json", "status_counts_json", "organic_line_count", "line_count", "last_error"], "schema-1: agent_debio_cert_detail columns");
      assertEq(cols.filter((c) => c.pk).map((c) => c.name), ["agent_id"], "schema-2: agent_id primary key");
      initMod.__initSchemaForTesting(db as any);
      assertEq(detailRows(db).length, 3, "schema-3: re-running init keeps existing rows (CREATE TABLE IF NOT EXISTS)");
    }

    // ── selection ────────────────────────────────────────────────────────
    {
      const db = freshDb();
      assertEq(svc.selectCertDetailCandidates(db, NOW, 50).map((c) => c.agent_id), ["s4b2-a1", "s4b2-a8", "s4b2-a7", "s4b2-a2"],
        "sel-1: okologisk + debio_sid only, fresh (3 d) skipped; missing first, then oldest fetched_at");
      assertEq(svc.selectCertDetailCandidates(db, NOW, 2).map((c) => c.agent_id), ["s4b2-a1", "s4b2-a8"], "sel-2: limited to max");
      assertEq(svc.selectCertDetailCandidates(db, new Date(T - 4 * DAY), 50).map((c) => c.agent_id), ["s4b2-a1", "s4b2-a8", "s4b2-a7"],
        "sel-3: 7-day cutoff relative to now (10 d old row is only 6 d old 4 days earlier)");
      assertEq(svc.selectCertDetailCandidates(db, new Date(T + 5 * DAY), 50).map((c) => c.agent_id), ["s4b2-a1", "s4b2-a8", "s4b2-a7", "s4b2-a2", "s4b2-a3"],
        "sel-4: the 3 d old row becomes a candidate once older than 7 days");
      assertEq([svc.clampCertDetailMax(undefined), svc.clampCertDetailMax(0), svc.clampCertDetailMax(-3), svc.clampCertDetailMax(999), svc.clampCertDetailMax(7.9), svc.clampCertDetailMax(NaN)],
        [25, 1, 1, 50, 7, 25], "sel-5: maxPerRun default 25, clamped 1–50");

      const c = newCounters();
      const r = await svc.syncDebioCertDetails(db, { now: NOW, maxPerRun: 1, delayMs: 0, registerFetchImpl: registerFetch(c), fetchImpl: detailFetch(c) });
      assertEq([r.candidates, r.with_id, r.fetched, r.stored, c.register, c.detail], [1, 1, 1, 1, 1, 1], "sel-6: maxPerRun 1 → one candidate handled");
      assertEq(c.detailIds, [1001], "sel-7: the missing row (a1) went first, with the register's enquiryOrigSid");
    }

    // ── full write run ───────────────────────────────────────────────────
    {
      const db = freshDb();
      const before = snapshot(db);
      const c = newCounters();
      const sleeps: number[] = [];
      const r = await svc.syncDebioCertDetails(db, {
        now: NOW, registerFetchImpl: registerFetch(c), fetchImpl: detailFetch(c),
        sleep: async (ms) => { sleeps.push(ms); },
      });
      assertEq(r, { ok: true, dry_run: false, candidates: 4, with_id: 3, fetched: 2, stored: 4, recognized: 2, errors: 1, skipped_no_id: 1, organic_lines: 2 },
        "run-1: result counts");
      assertEq(c.register, 1, "run-2: exactly one register call per run");
      assertEq(c.detailIds, [1001, 7001, 2001], "run-3: one detail call per candidate with an id, in candidate order");
      assertEq(sleeps, [2000, 2000], "run-4: default delay 2000 ms between detail calls (not before the first)");
      assertEq(snapshot(db), before, "run-5: agents / agent_debio_status byte-identical (debio_verified untouched)");

      const rows = detailRows(db);
      const byId = Object.fromEntries(rows.map((x) => [x.agent_id, x]));
      const a1 = byId["s4b2-a1"];
      assertEq([a1.enquiry_orig_sid, a1.fetched_at, a1.ok, a1.recognized, a1.organic_line_count, a1.line_count, a1.last_error],
        [1001, NOW.toISOString(), 1, 1, 1, 3, null], "run-6: ok row fields");
      assertEq(JSON.parse(a1.lines_json), [
        { label: "Melk (Husdyr)", statusCode: 509, statusText: "Økologisk", organic: true },
        { label: "Korn", statusCode: 501, statusText: "Ikke økologisk", organic: false },
        { label: "Egg (Husdyr)", statusCode: null, statusText: "Ukjent", organic: false },
      ], "run-7: lines_json holds only {label,statusCode,statusText,organic}; codeless line kept");
      assertEq(JSON.parse(a1.status_counts_json), { "509": 1, "501": 1, "none": 1 }, "run-8: status_counts_json");
      const a7 = byId["s4b2-a7"];
      assertEq([a7.enquiry_orig_sid, a7.fetched_at, a7.ok, a7.recognized, a7.lines_json, a7.status_counts_json, a7.line_count, a7.last_error],
        [7001, NOW.toISOString(), 0, 0, null, null, 0, "http_500"], "run-9: fetch failure → ok=0, last_error the body-free reason");
      const a8 = byId["s4b2-a8"];
      assertEq([a8.enquiry_orig_sid, a8.fetched_at, a8.ok, a8.lines_json, a8.last_error], [null, NOW.toISOString(), 0, null, "no_enquiry_orig_sid"],
        "run-10: no id in the register → no_enquiry_orig_sid row");
      assertEq([byId["s4b2-a2"].ok, byId["s4b2-a2"].fetched_at, byId["s4b2-a3"].fetched_at],
        [1, NOW.toISOString(), new Date(T - 3 * DAY).toISOString()], "run-11: stale row refreshed, fresh row untouched");
      assertEq(rows.map((x) => x.agent_id), ["s4b2-a1", "s4b2-a2", "s4b2-a3", "s4b2-a7", "s4b2-a8"], "run-12: no rows for non-candidates");
      const dump = JSON.stringify(rows);
      assertTrue(!dump.includes(PARTNER) && !dump.includes("Nordmann") && !dump.includes(STREET) && !dump.includes("Hemmelig"),
        "run-13: partnerFullName / person name / street never stored", dump);
      const all = JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => db.prepare(`SELECT * FROM "${t.name}"`).all()));
      assertTrue(!all.includes(PARTNER) && !all.includes(STREET), "run-14: person name / street in no table at all");

      // Zero candidates → no network call at all.
      const c2 = newCounters();
      const r2 = await svc.syncDebioCertDetails(db, { now: NOW, delayMs: 0, registerFetchImpl: registerFetch(c2), fetchImpl: detailFetch(c2) });
      assertEq([r2.ok, r2.candidates, r2.stored, c2.register, c2.detail], [true, 0, 0, 0, 0], "run-15: zero candidates → returns early, no register / detail call");

      // A week later everything is due again (no_enquiry_orig_sid row waited 7 days).
      const c3 = newCounters();
      const r3 = await svc.syncDebioCertDetails(db, { now: new Date(T + 8 * DAY), delayMs: 0, registerFetchImpl: registerFetch(c3), fetchImpl: detailFetch(c3) });
      assertEq([r3.candidates, c3.register], [5, 1], "run-16: 8 days later every okologisk row with a sid is due, one register call");
      const c4 = newCounters();
      const r4 = await svc.syncDebioCertDetails(db, { now: new Date(T + 6 * DAY), delayMs: 0, registerFetchImpl: registerFetch(c4), fetchImpl: detailFetch(c4) });
      assertEq([r4.candidates, c4.register], [0, 0], "run-17: failed / no-id rows are not retried before 7 days");
    }

    // ── register failure → no writes ─────────────────────────────────────
    {
      const cases: Array<[string, typeof fetch, string | RegExp]> = [
        ["HTTP 503", registerFetch(newCounters(), `down ${PARTNER} ${STREET}`, 503), "register_http_503"],
        ["invalid JSON", registerFetch(newCounters(), `{"name":"${PARTNER}"`, 200), "register_invalid_json"],
        ["throwing fetch", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, /^register_fetch_failed: /],
      ];
      for (const [label, f, want] of cases) {
        const db = freshDb();
        const before = JSON.stringify(detailRows(db)) + snapshot(db);
        const c = newCounters();
        const r = await svc.syncDebioCertDetails(db, { now: NOW, delayMs: 0, registerFetchImpl: f, fetchImpl: detailFetch(c) });
        assertTrue(r.ok === false && (typeof want === "string" ? r.reason === want : want.test(String(r.reason))), `reg-fail-1: ${label} → ok:false, reason ${String(want)}`, r);
        assertTrue(!String(r.reason).includes(PARTNER) && !String(r.reason).includes(STREET), `reg-fail-2: ${label} → reason carries no body`, r.reason);
        assertEq([r.stored, c.detail], [0, 0], `reg-fail-3: ${label} → no detail call, nothing stored`);
        assertEq(JSON.stringify(detailRows(db)) + snapshot(db), before, `reg-fail-4: ${label} → no table changed`);
      }
    }

    // ── fetch failures: body never stored, reason ≤ 300 chars ────────────
    {
      const db = freshDb();
      const c = newCounters();
      const throwing = (async () => { throw new Error(`boom ${"x".repeat(600)}`); }) as unknown as typeof fetch;
      await svc.syncDebioCertDetails(db, { now: NOW, delayMs: 0, registerFetchImpl: registerFetch(c), fetchImpl: throwing });
      const errs = detailRows(db).filter((x) => x.ok === 0 && x.last_error !== "no_enquiry_orig_sid").map((x) => x.last_error as string);
      assertTrue(errs.length === 3 && errs.every((e) => e.length <= 300), "fail-1: thrown fetch error → last_error truncated to ≤ 300 chars", errs.map((e) => e.length));
      const db2 = freshDb();
      const c2 = newCounters();
      await svc.syncDebioCertDetails(db2, { now: NOW, delayMs: 0, registerFetchImpl: registerFetch(c2),
        fetchImpl: detailFetch(c2, { 1001: { body: `{"partnerFullName":"${PARTNER}"`, status: 200 } }) });
      const a1 = detailRows(db2).find((x) => x.agent_id === "s4b2-a1");
      assertEq([a1.ok, a1.last_error, a1.lines_json], [0, "invalid_json", null], "fail-2: invalid JSON body → ok=0, invalid_json, nothing of the body stored");
    }

    // ── normalizer edge: no line has a code ──────────────────────────────
    {
      const db = freshDb();
      const c = newCounters();
      const codeless = { certificateDetailPos: [pos("Melk", null, 7), pos("Korn", null, null)] };
      await svc.syncDebioCertDetails(db, { now: NOW, delayMs: 0, maxPerRun: 1, registerFetchImpl: registerFetch(c), fetchImpl: detailFetch(c, { 1001: { body: codeless } }) });
      const a1 = detailRows(db).find((x) => x.agent_id === "s4b2-a1");
      assertEq([a1.ok, a1.recognized, a1.lines_json, a1.line_count, a1.organic_line_count, a1.status_counts_json], [1, 0, "[]", 0, 0, "{}"],
        "codeless-1: no line with a code → stored as normalizeCertDetail returns it (recognized 0, no lines)");
    }

    // ── dry run ──────────────────────────────────────────────────────────
    {
      const db = freshDb();
      const before = JSON.stringify(detailRows(db)) + snapshot(db);
      const c = newCounters();
      const r = await svc.syncDebioCertDetails(db, { now: NOW, dryRun: true, delayMs: 0, registerFetchImpl: registerFetch(c), fetchImpl: detailFetch(c) });
      assertEq(r, { ok: true, dry_run: true, candidates: 4, with_id: 3, fetched: 0, stored: 0, recognized: 0, errors: 0, skipped_no_id: 1, organic_lines: 0 },
        "dry-1: dry run reports candidates / ids");
      assertEq([c.register, c.detail], [1, 0], "dry-2: dry run → one register call, no detail call");
      assertEq(JSON.stringify(detailRows(db)) + snapshot(db), before, "dry-3: dry run writes nothing");
    }

    // ── routes ───────────────────────────────────────────────────────────
    {
      const db = freshDb();
      initMod.__setDbForTesting(db as any);
      process.env.ADMIN_KEY = "s4b2-admin-key";
      delete process.env.RFB_DEBIO_CERT_DETAIL_SYNC;
      const ADMIN = process.env.ADMIN_KEY;
      try { delete require.cache[require.resolve("../routes/admin-debio-cross-check")]; } catch { /* not loaded */ }
      routeMod = require("../routes/admin-debio-cross-check");
      const adminRouter = routeMod.default as any;
      const find = (p: string, m: string) => (adminRouter.stack as any[]).find((x: any) => x.route && x.route.path === p && x.route.methods?.[m]);
      const syncLayer = find("/cert-detail-sync", "post");
      const statusLayer = find("/cert-detail-status", "get");
      assertTrue(!!syncLayer && !!statusLayer, "route-1: POST /cert-detail-sync and GET /cert-detail-status registered");
      const mk = (layer: any) => (body: any, headers: any = { "x-admin-key": ADMIN }) => new Promise<{ status: number; body: any }>((resolve) => {
        let status = 200;
        const res: any = { status(code: number) { status = code; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
        const handler = layer.route.stack[layer.route.stack.length - 1].handle as Function;
        Promise.resolve(handler({ headers, query: {}, params: {}, body }, res)).catch((e: any) => resolve({ status: 599, body: String(e) }));
      });
      const callSync = mk(syncLayer);
      const callStatus = mk(statusLayer);
      const c = newCounters();
      routeMod.__setCertDetailSyncForTesting({ registerFetchImpl: registerFetch(c), fetchImpl: detailFetch(c), delayMs: 0, now: NOW });

      assertEq((await callSync({}, {})).status, 403, "route-2: sync without X-Admin-Key → 403");
      assertEq((await callSync({}, { "x-admin-key": "nope" })).status, 403, "route-3: sync with wrong key → 403");
      assertEq((await callStatus(undefined, {})).status, 403, "route-4: status without X-Admin-Key → 403");

      const bad: Array<[string, any]> = [
        ["dry_run string", { dry_run: "false" }], ["dry_run number", { dry_run: 0 }], ["dry_run null", { dry_run: null }],
        ["max 0", { max: 0 }], ["max 51", { max: 51 }], ["max fraction", { max: 2.5 }], ["max string", { max: "5" }],
        ["max negative", { max: -1 }], ["max null", { max: null }], ["body array", [1]], ["body string", "x"],
      ];
      for (const [label, b] of bad) {
        const r = await callSync(b);
        assertEq([r.status, r.body?.success, typeof r.body?.error], [400, false, "string"], `route-5: ${label} → 400`);
      }
      assertEq([c.register, c.detail, detailRows(db).length], [0, 0, 3], "route-6: no fetch and no write on auth / validation failure");

      const before = JSON.stringify(detailRows(db)) + snapshot(db);
      const dflt = await callSync({});
      assertEq([dflt.status, dflt.body.success, dflt.body.dry_run, dflt.body.candidates, dflt.body.with_id], [200, true, true, 4, 3], "route-7: empty body → dry_run defaults to true");
      const noBody = await callSync(undefined);
      assertEq([noBody.status, noBody.body.dry_run], [200, true], "route-8: no body → dry run");
      assertEq([c.register, c.detail], [2, 0], "route-9: dry runs made register calls only");
      assertEq(JSON.stringify(detailRows(db)) + snapshot(db), before, "route-10: dry runs wrote nothing");

      const wet = await callSync({ dry_run: false, max: 1 });
      assertEq([wet.status, wet.body.success, wet.body.dry_run, wet.body.candidates, wet.body.stored, c.detail], [200, true, false, 1, 1, 1], "route-11: dry_run:false + max 1 → one row stored");
      assertTrue(!JSON.stringify(wet.body).includes(PARTNER), "route-12: sync response carries no person name");

      routeMod.__setCertDetailSyncForTesting({ registerFetchImpl: registerFetch(newCounters(), "x", 502), fetchImpl: detailFetch(c), delayMs: 0, now: NOW });
      const regFail = await callSync({ dry_run: false });
      assertEq([regFail.status, regFail.body.success, regFail.body.ok, regFail.body.reason], [200, false, false, "register_http_502"], "route-13: register failure → success:false with reason");

      const st = await callStatus(undefined);
      assertEq(Object.keys(st.body), ["ok", "flag_enabled", "rows", "ok_rows", "recognized_rows", "agents_with_organic_line", "oldest_fetched_at", "newest_fetched_at"], "route-14: status endpoint shape");
      assertEq([st.body.ok, st.body.flag_enabled, st.body.rows, st.body.ok_rows, st.body.recognized_rows, st.body.agents_with_organic_line, st.body.oldest_fetched_at, st.body.newest_fetched_at],
        [true, false, 4, 4, 4, 1, new Date(T - 20 * DAY).toISOString(), NOW.toISOString()], "route-15: status counts and fetched_at range");
      assertTrue(!JSON.stringify(st.body).includes("s4b2-a") && !JSON.stringify(st.body).includes("Melk"), "route-16: status has no ids / labels");
      process.env.RFB_DEBIO_CERT_DETAIL_SYNC = "1";
      assertEq((await callStatus(undefined)).body.flag_enabled, true, "route-17: flag_enabled reflects RFB_DEBIO_CERT_DETAIL_SYNC");
      const empty = freshDb();
      empty.exec("DELETE FROM agent_debio_cert_detail");
      initMod.__setDbForTesting(empty as any);
      const st0 = (await callStatus(undefined)).body;
      assertEq([st0.rows, st0.ok_rows, st0.recognized_rows, st0.agents_with_organic_line, st0.oldest_fetched_at, st0.newest_fetched_at], [0, 0, 0, 0, null, null], "route-18: empty table → zeros and nulls");
    }

    // ── scheduler wiring (source) ────────────────────────────────────────
    {
      const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8");
      const i = indexSrc.indexOf('trackJob("debio-cert-detail-sync"');
      assertTrue(i > 0, "sched-1: index.ts registers trackJob(\"debio-cert-detail-sync\", …)");
      const block = indexSrc.slice(Math.max(0, i - 200), i + 900);
      assertTrue(/RFB_DISABLE_DEBIO_SYNC !== "1"/.test(block), "sched-2: registered only when RFB_DISABLE_DEBIO_SYNC !== \"1\"");
      assertTrue(/if \(!debioCertDetailSyncEnabled\(\)\) return;/.test(block), "sched-3: tick returns unless the flag is on");
      assertTrue(/6 \* 3600_000/.test(block), "sched-4: every 6 hours");
      assertTrue(/dryRun: false/.test(block) && /catch \(err\)/.test(block), "sched-5: writes when on, wrapped in try/catch");
    }

    assertEq(globalFetchCalls, 0, "net-1: no un-injected network call");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    (globalThis as any).fetch = prevFetch;
    try { routeMod?.__setCertDetailSyncForTesting(undefined); } catch { /* not loaded */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    for (const d of dbs) { try { d.close(); } catch { /* closed */ } }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDebioCertDetailS4b2Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

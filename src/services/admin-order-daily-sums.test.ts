/**
 * admin-order-daily-sums.test.ts — slice S5 of the admin order-statistics
 * dev-request (2026-10-23-admin-ordre-og-henvisningsdashbord, spec point 9):
 * the nightly frozen day sums (services/admin-order-daily-sums.ts) and the
 * read rule in services/admin-order-stats.ts. No network, no production DB:
 * in-memory SQLite DBs with the real lokal.db / experiences.db schemas, a
 * fixed clock.
 *
 *   S5-AC7a  after the nightly job, yesterday's sums (and marker) exist for
 *            every source with data
 *   S5-AC7b  deleting an underlying row (order, booking, click) from a past
 *            day changes neither that day's frozen sum (also after a rerun)
 *            nor the oversikt numbers for that day
 *   S5-TODAY the job never writes today (or later)
 *   S5-IDEM  a rerun writes nothing and changes nothing
 *   S5-PII   the table has only the six aggregate columns and no buyer /
 *            guest / producer name, e-mail, phone, note or session value
 *   S5-EQ    for undeleted data the oversikt / CSV numbers after the job are
 *            identical to the live-only numbers; reading EVERY frozen day
 *            from the sums (force) also gives the identical numbers, per
 *            dag / uke / maaned
 *   S5-LIVE  a status change after a day was frozen is still shown (live
 *            rows are used while no row has disappeared)
 *   S5-CAP   backfill: newest day first, per-source day cap, lookback cap,
 *            row cap, window
 *
 * Standalone: npx tsx src/services/admin-order-daily-sums.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminOrderDailySumsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e.slice(0, 600)}\n    actual:   ${a.slice(0, 600)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const expInit = require("../database/init-experiences") as typeof import("../database/init-experiences");
  const svc = require("./admin-order-stats") as typeof import("./admin-order-stats");
  const job = require("./admin-order-daily-sums") as typeof import("./admin-order-daily-sums");
  const routeMod = require("../routes/admin-order-stats") as typeof import("../routes/admin-order-stats");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ENABLE_EXPERIENCES", "PROFILE_AI_DELIVERIES_COUNTING_SINCE", "ADMIN_ORDER_DAILY_SUMS_DISABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const ADMIN_KEY = "daily-sums-test-admin-key";
  // 03:30 UTC: inside the job window. Today = 2026-11-08, yesterday = 2026-11-07.
  const NOW = new Date("2026-11-08T03:30:00.000Z");
  const TODAY = "2026-11-08";
  const YESTERDAY = "2026-11-07";

  const BUYER = { name: "Kari Hemmeligsen", email: "kari.hemmelig@privat-eksempel.no", phone: "+47 999 88 777", note: "HEMMELIGNOTAT" };
  const GUEST = { name: "Ola Gjestesen", email: "ola.gjest@privat-eksempel.no", phone: "+47 911 22 333", notes: "HEMMELIGGJEST" };
  const SESSION = "iphashHEMMELIGSESJON:Mozilla/5.0";

  const db = new Database(":memory:");
  const exp = new Database(":memory:");
  let server: http.Server | null = null;
  const T = svc.DAILY_SUMS_TABLE;

  function dump(d: Database.Database): string {
    return JSON.stringify(d.prepare(`SELECT plattform, metrikk, dimensjon, dag, verdi FROM ${T} ORDER BY plattform, metrikk, dimensjon, dag`).all());
  }
  function count(d: Database.Database): number {
    return (d.prepare(`SELECT COUNT(*) AS n FROM ${T}`).get() as { n: number }).n;
  }
  function sumValue(d: Database.Database, plattform: string, metrikk: string, dimensjon: string, dag: string): number | null {
    const r = d.prepare(`SELECT verdi FROM ${T} WHERE plattform = ? AND metrikk = ? AND dimensjon = ? AND dag = ?`).get(plattform, metrikk, dimensjon, dag) as { verdi: number } | undefined;
    return r ? r.verdi : null;
  }

  try {
    initMod.__initSchemaForTesting(db as any);
    expInit.initExperiencesSchema(exp);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-01";

    // ── Seed RFB ───────────────────────────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Produsent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')
    `);
    insAgent.run("ag-a", "Alfa Gård", "alfa@produsent-eksempel.no", "key-a");
    insAgent.run("ag-b", "Beta Gård", "beta@produsent-eksempel.no", "key-b");
    insAgent.run("ag-test", "Testprodusent (kun test)", "test@produsent-eksempel.no", "key-t");
    db.prepare("UPDATE agents SET origin = 'test_fixture', catalog_hidden = 1 WHERE id = 'ag-test'").run();

    db.prepare(`INSERT INTO carts (id, buyer_ref, status, buyer_name, buyer_email, buyer_phone, delivery_note)
                VALUES ('cart-1', 'buyer-ref-1', 'submitted', ?, ?, ?, ?)`).run(BUYER.name, BUYER.email, BUYER.phone, BUYER.note);
    const insOrder = db.prepare(`
      INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, total_nok, created_at,
                          buyer_name, buyer_email, buyer_phone, delivery_note, confirm_token)
      VALUES (?, 'cart-1', ?, 'buyer-ref-1', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const order = (id: string, agent: string, status: string, total: number | null, created: string) =>
      insOrder.run(id, agent, status, total, created, BUYER.name, BUYER.email, BUYER.phone, BUYER.note, "tok-" + id);
    order("o1", "ag-a", "pending", 100, "2026-11-01 10:00:00");
    order("o2", "ag-a", "confirmed", 200, "2026-11-02 08:00:00");
    order("o3", "ag-a", "completed", 300.25, "2026-11-02 09:00:00");
    order("o4", "ag-a", "declined", 50, "2026-10-15 12:00:00");
    order("o5", "ag-b", "cancelled", 80, "2026-10-20 12:00:00");
    order("o6", "ag-b", "ready", 120.5, "2026-11-07 06:00:00");      // yesterday
    order("o7", "ag-b", "confirmed", 75, "2026-11-02 18:00:00");
    order("o9", "ag-a", "pending", 60, "2026-11-08 01:00:00");       // today → never frozen
    order("t1", "ag-test", "completed", 999, "2026-11-03 10:00:00");
    order("t2", "ag-test", "pending", 10, "2026-11-02 10:00:00");

    const insHandoff = db.prepare("INSERT INTO cart_handoffs (id, agent_id, cart_id, item_count, created_at) VALUES (?, ?, 'cart-1', 1, ?)");
    insHandoff.run("h1", "ag-a", "2026-11-01 10:00:00");
    insHandoff.run("h2", "ag-b", "2026-11-01 11:00:00");
    insHandoff.run("h3", "ag-test", "2026-11-03 10:00:00");
    insHandoff.run("h4", "ag-a", "2026-11-08 02:00:00");             // today

    const insClick = db.prepare(`INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, utm_source, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insClick.run("ag-a", "website", SESSION, 0, "chatgpt.com-utmkilde", "2026-11-01 10:00:00");
    insClick.run("ag-a", "website", SESSION, 0, null, "2026-11-01 11:00:00");
    insClick.run("ag-a", "external:facebook", SESSION, 0, null, "2026-11-02 09:00:00");
    insClick.run("ag-b", "external:instagram", SESSION, 0, null, "2026-11-03 09:00:00");
    insClick.run("ag-b", "phone", SESSION, 0, null, "2026-11-03 12:00:00");
    insClick.run("ag-a", "email", SESSION, 0, null, "2026-10-20 08:00:00");
    insClick.run("ag-a", "website", SESSION, 1, null, "2026-11-01 12:00:00");   // bot
    insClick.run("ag-test", "website", SESSION, 0, null, "2026-11-02 10:00:00"); // test producer
    insClick.run("ag-b", "website", SESSION, 0, null, "2026-11-07 23:59:59");   // yesterday, last second
    insClick.run("ag-b", "website", SESSION, 0, null, "2026-11-08 00:00:01");   // today

    const insPlc = db.prepare(`INSERT INTO profile_link_clicks (platform, entity_type, entity_id, provider_id, kind, session_id, is_bot, is_test, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insPlc.run("opplevelser", "experience", "exp-1", "prov-a", "booking", SESSION, 0, 0, "2026-11-02 10:00:00");
    insPlc.run("opplevelser", "experience", "exp-1", "prov-a", "booking", SESSION, 1, 0, "2026-11-02 11:00:00");
    insPlc.run("gardssalg", "provider", "prov-b", "prov-b", "website", SESSION, 0, 0, "2026-11-03 10:00:00");
    insPlc.run("gardssalg", "provider", "prov-test", "prov-test", "phone", SESSION, 0, 1, "2026-11-03 11:00:00");
    insPlc.run("tannlege", "clinic", "cl-1", "cl-1", "directory", SESSION, 0, 0, "2026-11-04 10:00:00");
    insPlc.run("tannlege", "clinic", "cl-1", "cl-1", "email", SESSION, 0, 0, "2026-11-07 10:00:00");

    // ── Seed Opplevagent gårdssalg ─────────────────────────────────────────
    const insProv = exp.prepare(`INSERT INTO experience_providers (id, navn, vertical, enrichment_state, verification_status, source, confidence)
                                 VALUES (?, ?, 'experiences', 'raw', 'pending_verify', 'test-fixture', 'medium')`);
    insProv.run("prov-a", "Gård A");
    insProv.run("prov-b", "Gård B");
    insProv.run("prov-test", "Testgård (kun test)");
    exp.prepare("UPDATE experience_providers SET is_test_provider = 1 WHERE id = 'prov-test'").run();
    const insBooking = exp.prepare(`
      INSERT INTO gardssalg_bookings (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone,
        booking_ref, confirm_token, status, pre_status, respond_token_used_at, billable, notes, is_test, created_at)
      VALUES (@id, @prov, '2026-11-20T10:00:00.000Z', @party, @gn, @ge, @gp, @ref, @tok, @status, @pre, @used, @bill, @notes, @test, @created)
    `);
    const booking = (id: string, prov: string, status: string, pre: string, party: number, created: string, o: { used?: string; bill?: number; test?: number } = {}) =>
      insBooking.run({ id, prov, party, gn: GUEST.name, ge: GUEST.email, gp: GUEST.phone, ref: "GS-" + id.toUpperCase(), tok: "ctok-" + id,
        status, pre, used: o.used ?? null, bill: o.bill ?? 0, notes: GUEST.notes, test: o.test ?? 0, created });
    booking("g1", "prov-a", "reserved", "awaiting_provider", 2, "2026-11-01T10:00:00.000Z");
    booking("g2", "prov-a", "confirmed_attended", "provider_confirmed", 4, "2026-11-01T11:00:00.000Z", { used: "2026-11-01T14:00:00.000Z", bill: 1 });
    booking("g3", "prov-b", "no_show", "provider_confirmed", 3, "2026-11-03T08:00:00.000Z", { used: "2026-11-03T13:00:00.000Z" });
    booking("g4", "prov-b", "reserved", "awaiting_provider", 1, "2026-11-07T08:00:00.000Z");
    booking("g5", "prov-a", "reserved", "awaiting_provider", 2, "2026-11-08T01:00:00.000Z"); // today
    booking("gt1", "prov-test", "reserved", "awaiting_provider", 5, "2026-11-02T09:00:00.000Z");

    // ── Server (the real route, DBs pinned) ────────────────────────────────
    routeMod.__setAdminOrderStatsTestDbs(db, exp);
    routeMod.__setAdminOrderStatsNowForTesting(new Date("2026-11-08T12:00:00.000Z"));
    const express = require("express");
    const app = express();
    app.use("/admin/api/ordre", routeMod.default);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server!.address() as any).port as number;
    function get(urlPath: string): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const r = http.request({ method: "GET", host: "127.0.0.1", port, path: urlPath, headers: { "X-Admin-Key": ADMIN_KEY } }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({ status: resp.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
        });
        r.on("error", reject);
        r.end();
      });
    }
    const QUERIES: string[] = [];
    for (const oppl of ["dag", "uke", "maaned"]) {
      QUERIES.push(`/admin/api/ordre/oversikt?plattform=alle&fra=2026-10-01&til=2026-11-08&oppl=${oppl}`);
      QUERIES.push(`/admin/api/ordre/eksport.csv?plattform=alle&fra=2026-10-01&til=2026-11-08&oppl=${oppl}`);
    }
    QUERIES.push("/admin/api/ordre/oversikt?plattform=gardssalg&fra=2026-11-01&til=2026-11-07&oppl=dag");
    QUERIES.push("/admin/api/ordre/oversikt?plattform=rfb&fra=2026-11-02&til=2026-11-02&oppl=dag");
    async function snapshot(): Promise<string[]> {
      const out: string[] = [];
      for (const q of QUERIES) {
        const r = await get(q);
        out.push(`${r.status} ${r.text}`);
      }
      return out;
    }

    // Live-only numbers before the job ever ran.
    const before = await snapshot();
    assertTrue(before.every((s) => s.startsWith("200 ")), "setup: every oversikt/CSV query answers 200 before the job");

    // ── Guards: window, switch, running flag ───────────────────────────────
    {
      const r = await job.runAdminOrderDailySums(db, exp, { now: () => new Date("2026-11-08T12:00:00.000Z") });
      assertEq(r.stopped_reason, "outside_window", "window: 12:00 UTC is outside 03–06 → nothing written");
      const r2 = await job.runAdminOrderDailySums(db, exp, { now: () => new Date("2026-11-08T06:00:00.000Z") });
      assertEq(r2.stopped_reason, "outside_window", "window: 06:00 UTC is outside (stop hour exclusive)");
      process.env.ADMIN_ORDER_DAILY_SUMS_DISABLED = "1";
      const r3 = await job.runAdminOrderDailySums(db, exp, { now: () => NOW });
      assertEq(r3.stopped_reason, "disabled", "switch: ADMIN_ORDER_DAILY_SUMS_DISABLED=1 → disabled");
      delete process.env.ADMIN_ORDER_DAILY_SUMS_DISABLED;
      job.__setAdminOrderDailySumsRunningForTesting(true);
      const r4 = await job.runAdminOrderDailySums(db, exp, { now: () => NOW });
      assertEq(r4.stopped_reason, "already_running", "running flag: overlapping run is skipped");
      job.__setAdminOrderDailySumsRunningForTesting(false);
      assertEq(count(db), 0, "guards: no row written by a skipped run");
      assertEq(job.isAdminOrderDailySumsDisabled(undefined), false, "switch: default (unset) is on");
    }

    // ── The nightly run ────────────────────────────────────────────────────
    const run1 = await job.runAdminOrderDailySums(db, exp, { now: () => NOW });
    assertEq(run1.stopped_reason, "done", "run1: done");
    assertEq(run1.newest_day, YESTERDAY, "run1: newest day = yesterday");
    assertEq(run1.skipped, [], "run1: no source skipped (both DBs present)");
    assertTrue(run1.rows_written > 0, "run1: rows written");

    // S5-AC7a: yesterday exists for every source with data up to yesterday.
    for (const [plattform, kilde] of [["rfb", "ordre"], ["rfb", "overleveringer"], ["rfb", "klikk"], ["gardssalg", "forespoersler"],
      ["opplevelser", "klikk"], ["gardssalg", "klikk"], ["tannlege", "klikk"]]) {
      assertTrue(sumValue(db, plattform, `${kilde}.rader`, "", YESTERDAY) !== null, `ac7a: ${plattform}/${kilde} has a marker for yesterday`);
    }
    assertEq(sumValue(db, "rfb", "ordre.rader", "", YESTERDAY), 1, "ac7a: rfb orders yesterday = 1 (o6)");
    assertEq(sumValue(db, "rfb", "ordre.antall", JSON.stringify({ agent_id: "ag-b", status: "ready", is_test: 0 }), YESTERDAY), 1, "ac7a: o6 frozen as ag-b/ready");
    assertEq(sumValue(db, "rfb", "ordre.sum_nok", JSON.stringify({ agent_id: "ag-b", status: "ready", is_test: 0 }), YESTERDAY), 120.5, "ac7a: o6 sum_nok frozen");
    assertEq(sumValue(db, "rfb", "klikk.rader", "", YESTERDAY), 1, "ac7a: click at 23:59:59 yesterday belongs to yesterday");
    assertEq(sumValue(db, "gardssalg", "forespoersler.personer", JSON.stringify({ provider_id: "prov-b", status: "reserved", pre_status: "awaiting_provider", is_test: 0 }), YESTERDAY), 1,
      "ac7a: gårdssalg party size frozen for yesterday");
    // A day with zero rows still gets its marker (frozen as zero).
    assertEq(sumValue(db, "rfb", "ordre.rader", "", "2026-11-05"), 0, "ac7a: a day without orders is frozen as 0");

    // Frozen per-day counts = direct SQL counts.
    {
      const days = db.prepare(`SELECT dag, verdi FROM ${T} WHERE plattform = 'rfb' AND metrikk = 'ordre.rader' AND verdi > 0 ORDER BY dag`).all() as Array<{ dag: string; verdi: number }>;
      for (const d of days) {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < date(?, '+1 day')").get(d.dag, d.dag) as { n: number }).n;
        assertEq(d.verdi, n, `sql: rfb ordre.rader ${d.dag} = COUNT(*)`);
      }
      const gs = exp.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE created_at >= '2026-11-01' AND created_at < '2026-11-02'").get() as { n: number };
      assertEq(sumValue(db, "gardssalg", "forespoersler.rader", "", "2026-11-01"), gs.n, "sql: gårdssalg 2026-11-01 = COUNT(*)");
      assertEq(sumValue(db, "rfb", "klikk.antall", JSON.stringify({ agent_id: "ag-a", kind: "website", is_bot: 1, is_test: 0 }), "2026-11-01"), 1, "sql: bot click frozen apart");
      assertEq(sumValue(db, "rfb", "klikk.antall", JSON.stringify({ agent_id: "ag-a", kind: "website", is_bot: 0, is_test: 0 }), "2026-11-01"), 2, "sql: human clicks frozen");
      assertEq(sumValue(db, "rfb", "ordre.antall", JSON.stringify({ agent_id: "ag-test", status: "completed", is_test: 1 }), "2026-11-03"), 1, "sql: test order frozen with is_test=1");
    }

    // S5-TODAY: never today or later.
    assertEq((db.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE dag >= ?`).get(TODAY) as { n: number }).n, 0, "today: no row for today or later");
    // Lookback/first-row bound: nothing before the first source row.
    assertEq((db.prepare(`SELECT MIN(dag) AS d FROM ${T} WHERE plattform = 'rfb' AND metrikk = 'ordre.rader'`).get() as { d: string }).d, "2026-10-15",
      "backfill: rfb orders start at the first order day");

    // S5-PII: the table holds aggregates only.
    {
      const cols = (db.prepare(`PRAGMA table_info(${T})`).all() as Array<{ name: string }>).map((c) => c.name);
      assertEq(cols, ["plattform", "metrikk", "dimensjon", "dag", "verdi", "computed_at"], "pii: exactly the six aggregate columns");
      const all = JSON.stringify(db.prepare(`SELECT * FROM ${T}`).all());
      for (const needle of [BUYER.name, BUYER.email, BUYER.phone, BUYER.note, GUEST.name, GUEST.email, GUEST.phone, GUEST.notes,
        "HEMMELIG", "iphash", "Mozilla", "utmkilde", "chatgpt.com", "Alfa Gård", "Gård A", "@", "buyer", "guest", "tok-", "GS-"]) {
        assertTrue(!all.includes(needle), `pii: table dump has no ${JSON.stringify(needle)}`);
      }
      const allowedKeys = new Set(["agent_id", "provider_id", "status", "pre_status", "kind", "is_bot", "is_test"]);
      const dims = db.prepare(`SELECT DISTINCT dimensjon FROM ${T} WHERE dimensjon <> ''`).all() as Array<{ dimensjon: string }>;
      let bad = 0;
      for (const d of dims) for (const k of Object.keys(JSON.parse(d.dimensjon))) if (!allowedKeys.has(k)) bad++;
      assertEq(bad, 0, "pii: every dimension key is an id, status, click type or flag");
    }

    // S5-EQ: undeleted data → identical route output after the job.
    const afterJob = await snapshot();
    for (let i = 0; i < QUERIES.length; i++) assertEq(afterJob[i], before[i], `eq: identical after the job (nothing deleted): ${QUERIES[i]}`);

    // S5-EQ (force): reading every frozen day from the sums reproduces the live numbers.
    {
      const periods = [
        { fra: "2026-10-01", til: "2026-11-07", til_eksklusiv: "2026-11-08" },  // fully frozen
        { fra: "2026-10-01", til: "2026-11-08", til_eksklusiv: "2026-11-09" },  // frozen + today live
        { fra: "2026-11-02", til: "2026-11-02", til_eksklusiv: "2026-11-03" },
      ];
      const nameOf = (id: string) => (exp.prepare("SELECT navn FROM experience_providers WHERE id = ?").get(id) as { navn: string } | undefined)?.navn ?? null;
      const forced = { db, force: true };
      for (const per of periods) {
        for (const oppl of ["dag", "uke", "maaned"] as const) {
          const tag = `${per.fra}..${per.til} ${oppl}`;
          const liveR = svc.computeRfbOverview(db, per, oppl, NOW, null);
          const sumR = svc.computeRfbOverview(db, per, oppl, NOW, forced);
          assertTrue(Array.isArray(sumR.dagssummer?.dager) && sumR.dagssummer!.dager.length > 0, `eq-force: rfb read frozen days (${tag})`);
          const { dagssummer: _d1, ...sumRRest } = sumR;
          assertEq(sumRRest, liveR, `eq-force: rfb overview identical (${tag})`);
          const liveG = svc.computeGardssalgOverview(exp, per, oppl, null);
          const { dagssummer: _d2, ...sumG } = svc.computeGardssalgOverview(exp, per, oppl, forced) as any;
          assertEq(sumG, liveG, `eq-force: gårdssalg overview identical (${tag})`);
          const liveC = svc.computeRfbReferrals(db, per, oppl, null);
          const { dagssummer: _d3, ...sumC } = svc.computeRfbReferrals(db, per, oppl, forced) as any;
          assertEq(sumC, liveC, `eq-force: rfb clicks identical (${tag})`);
          for (const p of svc.PROFIL_HENVISNING_PLATTFORMER) {
            const liveP = svc.computeProfilReferrals(db, p, per, oppl, nameOf, null);
            const { dagssummer: _d4, ...sumP } = svc.computeProfilReferrals(db, p, per, oppl, nameOf, forced) as any;
            assertEq(sumP, liveP, `eq-force: ${p} clicks identical (${tag})`);
          }
        }
      }
    }

    // S5-IDEM: a rerun writes nothing.
    {
      const d0 = dump(db);
      const run2 = await job.runAdminOrderDailySums(db, exp, { now: () => new Date("2026-11-08T04:10:00.000Z") });
      assertEq(run2.rows_written, 0, "idem: rerun the same night writes 0 rows");
      assertEq(Object.values(run2.days_written).reduce((a, b) => a + b, 0), 0, "idem: rerun writes 0 days");
      assertEq(dump(db), d0, "idem: table unchanged");
    }

    // S5-LIVE: a status change after freezing is still shown (no row disappeared).
    {
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = 'o1'").run();
      const r = svc.computeRfbOverview(db, { fra: "2026-11-01", til: "2026-11-01", til_eksklusiv: "2026-11-02" }, "dag", NOW, { db });
      assertEq([r.by_status.pending, r.by_status.completed, r.sum_nok.amount], [0, 1, 100], "live: later status change shown (live rows used)");
      assertEq(r.dagssummer, undefined, "live: no dagssummer field when nothing was deleted");
      db.prepare("UPDATE orders SET status = 'pending' WHERE id = 'o1'").run();
    }

    // S5-AC7b: delete underlying rows from past days.
    {
      const frozenBefore = dump(db);
      const csvAndBodyBefore = await snapshot();
      db.prepare("DELETE FROM orders WHERE id = 'o3'").run();                                 // 2026-11-02
      db.prepare("DELETE FROM cart_handoffs WHERE id = 'h2'").run();                          // 2026-11-01
      db.prepare("DELETE FROM contact_clicks WHERE created_at = '2026-11-03 12:00:00'").run(); // 2026-11-03
      db.prepare("DELETE FROM profile_link_clicks WHERE platform = 'tannlege' AND kind = 'directory'").run(); // 2026-11-04
      exp.prepare("DELETE FROM gardssalg_bookings WHERE booking_id = 'g2'").run();             // 2026-11-01

      assertEq(dump(db), frozenBefore, "ac7b: deleting rows changes no frozen sum");
      const rerun = await job.runAdminOrderDailySums(db, exp, { now: () => new Date("2026-11-08T04:20:00.000Z") });
      assertEq(rerun.rows_written, 0, "ac7b: rerun after the deletion writes nothing");
      assertEq(dump(db), frozenBefore, "ac7b: frozen sums unchanged after a rerun");

      const after = await snapshot();
      for (let i = 0; i < QUERIES.length; i++) {
        // The body gains a `dagssummer` field (and nothing else) for the blocks
        // that used the frozen sums; the numbers stay the same.
        // Response-time figures are live-only by design (a median cannot be
        // rebuilt from day sums), so they are left out of the comparison.
        if (QUERIES[i].includes("/oversikt")) {
          const strip = (s: string) => {
            const o = JSON.parse(s.slice(4));
            for (const v of Object.values(o)) if (v && typeof v === "object") {
              delete (v as any).dagssummer;
              delete (v as any).response_time;
              for (const w of Object.values(v as object)) if (w && typeof w === "object") delete (w as any).dagssummer;
            }
            return o;
          };
          assertEq(strip(after[i]), strip(csvAndBodyBefore[i]), `ac7b: oversikt numbers unchanged after deletion: ${QUERIES[i]}`);
        } else {
          const strip = (s: string) => s.split("\r\n").filter((l) => !l.includes(",svartid,")).join("\r\n");
          assertEq(strip(after[i]), strip(csvAndBodyBefore[i]), `ac7b: CSV unchanged after deletion: ${QUERIES[i]}`);
        }
      }
      const body = JSON.parse((await get("/admin/api/ordre/oversikt?plattform=alle&fra=2026-10-01&til=2026-11-08&oppl=dag")).text);
      assertEq(body.rfb.dagssummer?.dager, ["2026-11-01", "2026-11-02"], "ac7b: rfb block names the days read from the sums");
      assertEq(body.gardssalg.dagssummer?.dager, ["2026-11-01"], "ac7b: gårdssalg block names the day read from the sums");
      assertEq(body.henvisninger.rfb.dagssummer?.dager, ["2026-11-03"], "ac7b: rfb clicks block names the day");
      assertEq(body.henvisninger.tannlege.dagssummer?.dager, ["2026-11-04"], "ac7b: tannlege clicks block names the day");
      assertEq(body.henvisninger.opplevelser.dagssummer, undefined, "ac7b: untouched block has no dagssummer field");
      assertEq([body.rfb.by_status.completed, body.rfb.cart_handoffs.count, body.gardssalg.by_status.confirmed_attended, body.henvisninger.rfb.by_type.telefon],
        [1, 3, 1, 1], "ac7b: deleted order / handoff / booking / click still counted");
      // Sanity: the live-only numbers did drop (the deletion was real).
      const liveOnly = svc.computeRfbOverview(db, { fra: "2026-10-01", til: "2026-11-08", til_eksklusiv: "2026-11-09" }, "dag", NOW, null);
      assertEq(liveOnly.by_status.completed, 0, "ac7b: sanity — live-only count dropped after the deletion");
      assertTrue(typeof body.forklaring === "string" && body.forklaring.includes("dagssummer"), "ac7b: top-level forklaring explains the daily sums");
    }

    // ── S5-CAP: backfill caps on a fresh DB ────────────────────────────────
    {
      const big = new Database(":memory:");
      initMod.__initSchemaForTesting(big as any);
      const ins = big.prepare(`INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, created_at) VALUES ('ag-x', 'website', ?, 0, ?)`);
      const start = Date.parse("2026-11-08T00:00:00.000Z");
      for (let i = 1; i <= 300; i++) ins.run(SESSION, new Date(start - i * 86_400_000 + 3_600_000).toISOString().slice(0, 19).replace("T", " "));
      const r1 = await job.runAdminOrderDailySums(big, null, { now: () => NOW, maxDaysPerSource: 10, lookbackDays: 200 });
      assertEq(r1.days_written["rfb.klikk"], 10, "cap: at most maxDaysPerSource days per source per run");
      assertEq(r1.remaining["rfb.klikk"], 190, "cap: remaining days reported");
      assertTrue(r1.skipped.includes("gardssalg.forespoersler"), "cap: gårdssalg skipped without the experiences DB");
      assertTrue(sumValue(big, "rfb", "klikk.rader", "", YESTERDAY) === 1, "cap: newest day (yesterday) written first");
      assertEq((big.prepare(`SELECT MIN(dag) AS d FROM ${T} WHERE metrikk = 'klikk.rader'`).get() as { d: string }).d, "2026-10-29", "cap: the 10 newest days");
      let guard = 0;
      while (guard++ < 50) {
        const r = await job.runAdminOrderDailySums(big, null, { now: () => NOW, maxDaysPerSource: 10, lookbackDays: 200 });
        if (r.days_written["rfb.klikk"] === 0) break;
      }
      const span = big.prepare(`SELECT MIN(dag) AS lo, MAX(dag) AS hi, COUNT(*) AS n FROM ${T} WHERE metrikk = 'klikk.rader'`).get() as { lo: string; hi: string; n: number };
      assertEq([span.lo, span.hi, span.n], ["2026-04-22", YESTERDAY, 200], "cap: later nights fill history, never beyond the lookback");

      const big2 = new Database(":memory:");
      initMod.__initSchemaForTesting(big2 as any);
      const ins2 = big2.prepare(`INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, created_at) VALUES (?, 'website', ?, 0, ?)`);
      for (let i = 1; i <= 60; i++) for (let a = 0; a < 5; a++) ins2.run(`ag-${a}`, SESSION, new Date(start - i * 86_400_000).toISOString().slice(0, 19).replace("T", " "));
      const r2 = await job.runAdminOrderDailySums(big2, null, { now: () => NOW, chunkDays: 7, maxRowsPerRun: 20 });
      assertEq(r2.stopped_reason, "row_cap", "cap: row cap stops the run");
      assertTrue(r2.rows_written >= 20 && r2.rows_written <= 20 + 7 * 6, `cap: row cap checked between chunks (${r2.rows_written})`);

      // Window closes mid-run → stops between chunks.
      const big3 = new Database(":memory:");
      initMod.__initSchemaForTesting(big3 as any);
      const ins3 = big3.prepare(`INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, created_at) VALUES ('ag-x', 'website', ?, 0, ?)`);
      for (let i = 1; i <= 60; i++) ins3.run(SESSION, new Date(start - i * 86_400_000).toISOString().slice(0, 19).replace("T", " "));
      let calls = 0;
      const r3 = await job.runAdminOrderDailySums(big3, null, {
        now: () => (calls++ < 2 ? new Date("2026-11-08T05:59:00.000Z") : new Date("2026-11-08T06:00:00.000Z")),
        chunkDays: 7,
      });
      assertEq(r3.stopped_reason, "window_closed", "window: run stops when 06 UTC is reached");
      assertEq(r3.days_written["rfb.klikk"], 7, "window: only the first chunk was written");
      big.close(); big2.close(); big3.close();
    }

    // The table is created by the schema (idempotent).
    {
      initMod.__initSchemaForTesting(db as any);
      assertTrue(count(db) > 0, "schema: re-running the schema keeps the rows (CREATE TABLE IF NOT EXISTS)");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    routeMod.__setAdminOrderStatsTestDbs(null);
    routeMod.__setAdminOrderStatsNowForTesting(null);
    job.__setAdminOrderDailySumsRunningForTesting(false);
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    try { db.close(); } catch { /* ignore */ }
    try { exp.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminOrderDailySumsTests({ log: true }).then((r) => {
    console.log(`\nadmin-order-daily-sums: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

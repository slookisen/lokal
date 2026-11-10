/**
 * admin-order-stats.test.ts — slice S1 of the admin order-statistics
 * dev-request: GET /admin/api/ordre/oversikt + GET /admin/api/ordre/liste.
 * No network, no production DB: fresh in-memory SQLite DBs with the real
 * production schemas (lokal.db + experiences.db), a fixed clock.
 *
 *   AC1  401 without / with a wrong X-Admin-Key, 200 with; POST/PUT/DELETE
 *        are not handled (404)
 *   AC2  no buyer/guest value, field name or e-mail address in either route
 *   AC3  counts per status / producer / period equal direct SQL counts
 *   AC4  test producer / test provider rows are out of the main totals and in
 *        the separate test block
 *   AC5  parameter validation → 400; defaults (last 30 days, oppl=dag)
 *
 * Slice S2 (same harness):
 *   S2-AC1  GET /admin/api/ordre/eksport.csv 401 without / wrong key, 200
 *           with; GET /admin/ordre follows the admin-crm.html pattern (page
 *           served without a key, holds no data, its data calls need the
 *           key); POST/PUT/DELETE/PATCH not handled
 *   S2-AC2  no buyer/guest value, note or e-mail address anywhere in the CSV
 *   S2-AC8  the CSV holds aggregates only: no order/booking id or ref column
 *           or value, row count = aggregate rows of the oversikt body
 *   S2-PS   GET /admin/orders/pilot-status keeps its shape and its 30-day
 *           counts match oversikt (real + test) on a DB seeded relative to now
 *
 * Standalone: npx tsx src/routes/admin-order-stats.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminOrderStatsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
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
  const routeMod = require("./admin-order-stats") as typeof import("./admin-order-stats");
  const svc = require("../services/admin-order-stats") as typeof import("../services/admin-order-stats");
  const adminOrdersMod = require("./admin-orders") as typeof import("./admin-orders");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ENABLE_EXPERIENCES"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const ADMIN_KEY = "order-stats-test-admin-key";
  const NOW = new Date("2026-11-08T12:00:00.000Z");

  const db = new Database(":memory:");
  const exp = new Database(":memory:");
  const db2 = new Database(":memory:"); // S2 pilot-status agreement, seeded relative to the real clock
  let server: http.Server | null = null;

  // Distinctive personal data that must never appear in a response.
  const BUYER = { name: "Kari Hemmeligsen", email: "kari.hemmelig@privat-eksempel.no", phone: "+47 999 88 777", note: "Ring på bakdøra HEMMELIGNOTAT" };
  const GUEST = { name: "Ola Gjestesen", email: "ola.gjest@privat-eksempel.no", phone: "+47 911 22 333", notes: "Allergisk mot HEMMELIGGJEST" };

  try {
    initMod.__initSchemaForTesting(db as any);
    expInit.initExperiencesSchema(exp);
    routeMod.__setAdminOrderStatsTestDbs(db, exp);
    routeMod.__setAdminOrderStatsNowForTesting(NOW);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;

    // ── Seed RFB ───────────────────────────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Produsent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')
    `);
    insAgent.run("ag-a", "Alfa Gård", "alfa@produsent-eksempel.no", "key-a");
    insAgent.run("ag-b", "Beta Gård", "beta@produsent-eksempel.no", "key-b");
    insAgent.run("ag-test", "Testprodusent (kun test)", "test@produsent-eksempel.no", "key-t");
    db.prepare("UPDATE agents SET origin = 'test_fixture', catalog_hidden = 1 WHERE id = 'ag-test'").run();
    insAgent.run(svc.RFB_LEGACY_TEST_AGENT_ID, "Test Gard Brreg", "legacy@produsent-eksempel.no", "key-l");

    db.prepare(`INSERT INTO carts (id, buyer_ref, status, buyer_name, buyer_email, buyer_phone, delivery_note)
                VALUES ('cart-1', 'buyer-ref-1', 'submitted', ?, ?, ?, ?)`).run(BUYER.name, BUYER.email, BUYER.phone, BUYER.note);
    const insOrder = db.prepare(`
      INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, total_nok, created_at, payment_mode,
                          buyer_name, buyer_email, buyer_phone, delivery_note, confirm_token)
      VALUES (?, 'cart-1', ?, 'buyer-ref-1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const order = (id: string, agent: string, status: string, total: number | null, created: string, prepay = false) =>
      insOrder.run(id, agent, status, total, created, prepay ? "prepay" : null, BUYER.name, BUYER.email, BUYER.phone, BUYER.note, "tok-" + id);
    order("o1", "ag-a", "pending", 100, "2026-11-01 10:00:00");
    order("o2", "ag-a", "confirmed", 200, "2026-11-02 08:00:00");
    order("o3", "ag-a", "completed", 300, "2026-11-02 09:00:00");
    order("o4", "ag-a", "declined", 50, "2026-10-15 12:00:00");
    order("o5", "ag-b", "cancelled", 80, "2026-10-20 12:00:00");
    order("o6", "ag-b", "ready", 120.5, "2026-11-07 06:00:00");
    order("o7", "ag-b", "pending", 40, "2026-11-01 10:00:00", true);
    order("o8", "ag-a", "completed", 500, "2026-09-15 10:00:00"); // outside the period
    order("t1", "ag-test", "completed", 999, "2026-11-03 10:00:00");
    order("t2", "ag-test", "pending", 10, "2026-11-01 10:00:00");
    order("t3", svc.RFB_LEGACY_TEST_AGENT_ID, "confirmed", 25, "2026-11-04 10:00:00");

    const insItem = db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, 'p', 'Poteter', 1, 10, 10)");
    insItem.run("i1", "o2"); insItem.run("i2", "o2"); insItem.run("i3", "o3");

    const insEvent = db.prepare("INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insEvent.run("e1", "o2", "pending", "confirmed", "producer", "seller", "2026-11-02 10:00:00");          // 2 h
    insEvent.run("e2", "o3", "pending", "confirmed", "producer", "seller", "2026-11-02 13:00:00");          // 4 h
    insEvent.run("e3", "o3", "confirmed", "completed", "admin", "admin", "2026-11-02 14:00:00");
    insEvent.run("e4", "o4", "pending", "declined", "producer", "seller", "2026-10-15 13:00:00");          // 1 h
    insEvent.run("e5", "o5", "pending", "cancelled", "system", "system", "2026-10-23 12:00:00");          // not a producer answer
    insEvent.run("e6", "o6", "pending", "confirmed", null, "seller", "2026-11-07 12:00:00");               // 6 h (owner portal)
    insEvent.run("e7", "t1", "pending", "confirmed", "producer", "seller", "2026-11-03 10:30:00");

    const insHandoff = db.prepare("INSERT INTO cart_handoffs (id, agent_id, cart_id, item_count, created_at) VALUES (?, ?, 'cart-1', 1, ?)");
    insHandoff.run("h1", "ag-a", "2026-11-01 10:00:00");
    insHandoff.run("h2", "ag-b", "2026-10-11 10:00:00");
    insHandoff.run("h3", "ag-a", "2026-09-01 10:00:00"); // outside
    insHandoff.run("h4", "ag-test", "2026-11-01 10:00:00");

    // ── Seed Opplevagent gårdssalg ─────────────────────────────────────────
    const insProv = exp.prepare(`INSERT INTO experience_providers (id, navn, vertical, enrichment_state, verification_status, source, confidence)
                                 VALUES (?, ?, 'experiences', 'raw', 'pending_verify', 'test-fixture', 'medium')`);
    insProv.run("prov-a", "Gård A");
    insProv.run("prov-b", "Gård B");
    insProv.run("prov-test", "Testgård (kun test)");
    exp.prepare("UPDATE experience_providers SET is_test_provider = 1 WHERE id = 'prov-test'").run();
    const insBooking = exp.prepare(`
      INSERT INTO gardssalg_bookings (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone,
        booking_ref, confirm_token, status, pre_status, respond_token_used_at, suggested_slot_at, billable, notes, is_test, created_at)
      VALUES (@id, @prov, '2026-11-20T10:00:00.000Z', @party, @gn, @ge, @gp, @ref, @tok, @status, @pre, @used, @sugg, @bill, @notes, @test, @created)
    `);
    const booking = (id: string, prov: string, status: string, pre: string, party: number, created: string,
      o: { used?: string; sugg?: string; bill?: number; test?: number } = {}) =>
      insBooking.run({ id, prov, party, gn: GUEST.name, ge: GUEST.email, gp: GUEST.phone, ref: "GS-" + id.toUpperCase(), tok: "ctok-" + id,
        status, pre, used: o.used ?? null, sugg: o.sugg ?? null, bill: o.bill ?? 0, notes: GUEST.notes, test: o.test ?? 0, created });
    booking("g1", "prov-a", "reserved", "awaiting_provider", 2, "2026-11-01T10:00:00.000Z");
    booking("g2", "prov-a", "confirmed_attended", "provider_confirmed", 4, "2026-11-01T11:00:00.000Z", { used: "2026-11-01T14:00:00.000Z", bill: 1 }); // 3 h
    booking("g3", "prov-b", "no_show", "provider_confirmed", 3, "2026-11-03T08:00:00.000Z", { used: "2026-11-03T13:00:00.000Z" });              // 5 h
    booking("g4", "prov-b", "cancelled", "provider_declined", 1, "2026-11-04T08:00:00.000Z", { used: "2026-11-06T08:00:00.000Z", sugg: "2026-11-21T10:00:00.000Z" }); // excluded
    booking("g5", "prov-a", "reserved", "awaiting_provider", 2, "2026-10-10T09:00:00.000Z");
    booking("g6", "prov-a", "reserved", "awaiting_provider", 2, "2026-09-01T09:00:00.000Z"); // outside
    booking("gt1", "prov-test", "reserved", "awaiting_provider", 5, "2026-11-02T09:00:00.000Z");
    booking("gt2", "prov-a", "confirmed_attended", "provider_confirmed", 1, "2026-11-02T09:00:00.000Z", { test: 1 });

    // ── Server ─────────────────────────────────────────────────────────────
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/admin/api/ordre", routeMod.default);
    app.use("/admin/ordre", routeMod.adminOrderPageRouter);
    app.use("/admin/orders", adminOrdersMod.default);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
      return new Promise((resolve, reject) => {
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
            resolve({ status: resp.statusCode || 0, body: parsed, text: raw });
          });
        });
        r.on("error", reject);
        r.end();
      });
    }
    function reqH(method: string, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
      return new Promise((resolve, reject) => {
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, text: Buffer.concat(chunks).toString("utf8") }));
        });
        r.on("error", reject);
        r.end();
      });
    }
    const K = { "X-Admin-Key": ADMIN_KEY };
    const P = "fra=2026-10-01&til=2026-11-08";

    // ── AC1: auth + methods ────────────────────────────────────────────────
    for (const path of ["/admin/api/ordre/oversikt", "/admin/api/ordre/liste"]) {
      assertEq((await req("GET", path)).status, 401, `ac1: ${path} without key -> 401`);
      assertEq((await req("GET", path, { "X-Admin-Key": "wrong" })).status, 401, `ac1: ${path} wrong key -> 401`);
      assertEq((await req("GET", path, K)).status, 200, `ac1: ${path} with key -> 200`);
      for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await req(m, path, K);
        assertTrue(r.status === 404 || r.status === 405, `ac1: ${m} ${path} not handled (${r.status})`);
      }
    }
    {
      delete process.env.ADMIN_KEY;
      assertEq((await req("GET", "/admin/api/ordre/oversikt", K)).status, 503, "ac1: no admin key configured -> 503");
      process.env.ADMIN_KEY = ADMIN_KEY;
    }

    // ── AC2: no personal data ──────────────────────────────────────────────
    {
      const texts: string[] = [];
      for (const pl of ["alle", "rfb", "gardssalg"]) {
        for (const o of ["dag", "uke", "maaned"]) texts.push((await req("GET", `/admin/api/ordre/oversikt?plattform=${pl}&${P}&oppl=${o}`, K)).text);
        texts.push((await req("GET", `/admin/api/ordre/liste?plattform=${pl}&${P}`, K)).text);
      }
      texts.push((await req("GET", `/admin/api/ordre/liste?plattform=alle&${P}&status=pending`, K)).text);
      const all = texts.join("\n");
      for (const v of [BUYER.name, BUYER.email, BUYER.phone, BUYER.note, GUEST.name, GUEST.email, GUEST.phone, GUEST.notes,
        "Hemmelig", "HEMMELIG", "buyer-ref-1", "tok-o1", "ctok-g1"]) {
        assertTrue(!all.includes(v), `ac2: response never contains «${v}»`);
      }
      for (const f of ["buyer_name", "buyer_email", "buyer_phone", "delivery_note", "guest_name", "guest_email", "guest_phone", "notes"]) {
        assertTrue(!all.includes(`"${f}"`), `ac2: no field named ${f}`);
      }
      assertTrue(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(all), "ac2: no e-mail address pattern anywhere");
      const list = (await req("GET", `/admin/api/ordre/liste?plattform=alle&${P}`, K)).body;
      const allowedKeys = ["platform", "id", "ref", "date", "producer_id", "producer_name", "status", "pre_status", "item_count", "party_size", "amount_nok", "is_test"];
      assertTrue(list.rows.length > 0 && list.rows.every((r: any) => Object.keys(r).every((k) => allowedKeys.includes(k))), "ac2: list rows carry only the allowed keys");
    }

    // ── AC3: counts equal direct SQL ───────────────────────────────────────
    const ov = (await req("GET", `/admin/api/ordre/oversikt?plattform=alle&${P}&oppl=dag`, K)).body;
    {
      const range = ["2026-10-01", "2026-11-09"];
      const notTest = `NOT (COALESCE(a.origin,'') IN ('test_fixture','test_claim_fixture') OR o.agent_id = '${svc.RFB_LEGACY_TEST_AGENT_ID}')`;
      const sqlStatus = db.prepare(`SELECT o.status AS s, COUNT(*) AS n FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
        WHERE o.created_at >= ? AND o.created_at < ? AND ${notTest} GROUP BY o.status`).all(...range) as Array<{ s: string; n: number }>;
      for (const r of sqlStatus) assertEq(ov.rfb.by_status[r.s], r.n, `ac3: rfb by_status.${r.s} = SQL`);
      assertEq(ov.rfb.total, sqlStatus.reduce((a, r) => a + r.n, 0), "ac3: rfb total = SQL");
      assertEq(ov.rfb.total, 7, "ac3: rfb total is 7 (o1–o7)");
      assertEq(ov.rfb.by_status, { pending: 2, confirmed: 1, declined: 1, ready: 1, completed: 1, cancelled: 1 }, "ac3: rfb by_status zero-filled");
      const sqlProd = db.prepare(`SELECT o.agent_id AS id, COUNT(*) AS n FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
        WHERE o.created_at >= ? AND o.created_at < ? AND ${notTest} GROUP BY o.agent_id`).all(...range) as Array<{ id: string; n: number }>;
      for (const r of sqlProd) assertEq(ov.rfb.producers.find((p: any) => p.agent_id === r.id)?.total, r.n, `ac3: rfb producer ${r.id} = SQL`);
      assertEq(ov.rfb.producers.map((p: any) => [p.agent_id, p.name]), [["ag-a", "Alfa Gård"], ["ag-b", "Beta Gård"]], "ac3: producers with display name");
      const sqlDay = db.prepare(`SELECT date(o.created_at) AS d, COUNT(*) AS n FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
        WHERE o.created_at >= ? AND o.created_at < ? AND ${notTest} GROUP BY d`).all(...range) as Array<{ d: string; n: number }>;
      for (const r of sqlDay) assertEq(ov.rfb.series.find((s: any) => s.bucket === r.d)?.total, r.n, `ac3: rfb day ${r.d} = SQL`);
      assertEq(ov.rfb.series.length, 39, "ac3: zero-filled day series (2026-10-01..2026-11-08)");
      assertEq(ov.rfb.series.reduce((a: number, s: any) => a + s.total, 0), 7, "ac3: series sums to total");
      assertEq(ov.rfb.sum_nok.amount, 620.5, "ac3: sum_nok = confirmed+ready+completed (200+300+120.5)");
      assertEq([ov.rfb.response_time.measured, ov.rfb.response_time.unanswered, ov.rfb.response_time.median_hours, ov.rfb.response_time.avg_hours],
        [4, 3, 3, 3.25], "ac3: response time from producer events (1,2,4,6 h)");
      assertEq(ov.rfb.unanswered_over_24h.count, 1, "ac3: pending > 24 h (prepay excluded)");
      assertEq(ov.rfb.cart_handoffs.count, 2, "ac3: cart_handoffs in period");

      const gRange = ["2026-10-01", "2026-11-09"];
      const gNotTest = "NOT (COALESCE(p.is_test_provider,0) = 1 OR COALESCE(b.is_test,0) = 1)";
      const gStatus = exp.prepare(`SELECT b.status AS s, COUNT(*) AS n FROM gardssalg_bookings b LEFT JOIN experience_providers p ON p.id = b.provider_id
        WHERE b.created_at >= ? AND b.created_at < ? AND ${gNotTest} GROUP BY b.status`).all(...gRange) as Array<{ s: string; n: number }>;
      for (const r of gStatus) assertEq(ov.gardssalg.by_status[r.s], r.n, `ac3: gardssalg by_status.${r.s} = SQL`);
      assertEq(ov.gardssalg.total, 5, "ac3: gardssalg total 5 (g1–g5)");
      const gProv = exp.prepare(`SELECT b.provider_id AS id, COUNT(*) AS n FROM gardssalg_bookings b LEFT JOIN experience_providers p ON p.id = b.provider_id
        WHERE b.created_at >= ? AND b.created_at < ? AND ${gNotTest} GROUP BY b.provider_id`).all(...gRange) as Array<{ id: string; n: number }>;
      for (const r of gProv) assertEq(ov.gardssalg.providers.find((p: any) => p.provider_id === r.id)?.total, r.n, `ac3: gardssalg provider ${r.id} = SQL`);
      const gDay = exp.prepare(`SELECT date(b.created_at) AS d, COUNT(*) AS n FROM gardssalg_bookings b LEFT JOIN experience_providers p ON p.id = b.provider_id
        WHERE b.created_at >= ? AND b.created_at < ? AND ${gNotTest} GROUP BY d`).all(...gRange) as Array<{ d: string; n: number }>;
      for (const r of gDay) assertEq(ov.gardssalg.series.find((s: any) => s.bucket === r.d)?.total, r.n, `ac3: gardssalg day ${r.d} = SQL`);
      assertEq([ov.gardssalg.party_size_sum, ov.gardssalg.attended, ov.gardssalg.no_show, ov.gardssalg.billable.count], [12, 1, 1, 1], "ac3: party_size, attended, no_show, billable");
      assertEq(ov.gardssalg.by_pre_status, { awaiting_provider: 2, provider_confirmed: 2, provider_declined: 1, time_suggested: 0, expired: 0 }, "ac3: by_pre_status");
      assertEq([ov.gardssalg.response_time.measured, ov.gardssalg.response_time.median_hours], [2, 4], "ac3: gardssalg response time (3 h, 5 h; suggested-time row excluded)");
      assertTrue(Array.isArray(ov.gardssalg.merknader) && ov.gardssalg.merknader.length > 0, "ac3: gardssalg merknader explains the response-time limit");
      assertTrue(typeof ov.forklaring === "string" && typeof ov.rfb.forklaring === "string" && typeof ov.gardssalg.forklaring === "string"
        && typeof ov.rfb.test.forklaring === "string" && typeof ov.gardssalg.billable.forklaring === "string", "ac3: every block carries a forklaring");

      // Week + month buckets.
      const wk = (await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}&oppl=uke`, K)).body;
      assertEq(wk.rfb.series[0].bucket, "2026-09-28", "ac3: week buckets start on the Monday of fra's week");
      assertEq(wk.rfb.series.find((s: any) => s.bucket === "2026-10-26")?.total, 2, "ac3: week of 2026-10-26 (Mon–Sun) holds o1 + o7");
      assertEq(wk.rfb.series.find((s: any) => s.bucket === "2026-11-02")?.total, 3, "ac3: week of 2026-11-02 holds o2, o3, o6");
      const sqlWeek = db.prepare(`SELECT date(o.created_at, 'weekday 0', '-6 days') AS w, COUNT(*) AS n FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
        WHERE o.created_at >= ? AND o.created_at < ? AND ${notTest} GROUP BY w`).all(...range) as Array<{ w: string; n: number }>;
      for (const r of sqlWeek) assertEq(wk.rfb.series.find((s: any) => s.bucket === r.w)?.total, r.n, `ac3: rfb week ${r.w} = SQL`);
      const mo = (await req("GET", `/admin/api/ordre/oversikt?plattform=gardssalg&${P}&oppl=maaned`, K)).body;
      assertEq(mo.gardssalg.series.map((s: any) => [s.bucket, s.total]), [["2026-10", 1], ["2026-11", 4]], "ac3: month buckets");
      assertTrue(mo.rfb === undefined, "ac3: plattform=gardssalg returns no rfb block");

      // List.
      const li = (await req("GET", `/admin/api/ordre/liste?plattform=rfb&${P}`, K)).body;
      assertEq(li.count, 10, "ac3: rfb list = 7 real + 3 test orders in period");
      assertEq(li.rows[0].id, "o6", "ac3: newest first");
      const o2 = li.rows.find((r: any) => r.id === "o2");
      assertEq([o2.item_count, o2.amount_nok, o2.producer_name, o2.status], [2, 200, "Alfa Gård", "confirmed"], "ac3: list row content");
      const ls = (await req("GET", `/admin/api/ordre/liste?plattform=alle&${P}&status=reserved`, K)).body;
      assertEq(ls.rows.map((r: any) => r.id), ["gt1", "g1", "g5"], "ac3: status filter + cross-platform merge newest first");
      assertEq(ls.rows.find((r: any) => r.id === "g1").party_size, 2, "ac3: gardssalg row has party_size");
      const lp = (await req("GET", `/admin/api/ordre/liste?plattform=alle&${P}&status=pending`, K)).body;
      assertEq(lp.rows.map((r: any) => r.id).sort(), ["o1", "o7", "t2"], "ac3: an RFB-only status matches no bookings");
    }

    // ── AC4: test data apart ───────────────────────────────────────────────
    {
      assertTrue(!ov.rfb.producers.some((p: any) => p.agent_id === "ag-test" || p.agent_id === svc.RFB_LEGACY_TEST_AGENT_ID), "ac4: test producers not in the producer list");
      assertEq([ov.rfb.test.total, ov.rfb.test.by_status.completed, ov.rfb.test.by_status.pending, ov.rfb.test.by_status.confirmed], [3, 1, 1, 1], "ac4: rfb test block counts t1–t3");
      assertEq(ov.rfb.test.sum_nok, 1024, "ac4: test sum (999 + 25)");
      assertEq([ov.rfb.test.unanswered_over_24h, ov.rfb.test.cart_handoffs], [1, 1], "ac4: test unanswered + handoffs");
      assertEq(ov.rfb.test.producers.map((p: any) => p.agent_id).sort(), ["ag-test", svc.RFB_LEGACY_TEST_AGENT_ID].sort(), "ac4: test producers listed in the test block");
      assertEq([ov.gardssalg.test.total, ov.gardssalg.test.party_size_sum], [2, 6], "ac4: gardssalg test block (provider flag + booking is_test)");
      assertTrue(!ov.gardssalg.providers.some((p: any) => p.provider_id === "prov-test"), "ac4: test provider not in the provider list");
      const li = (await req("GET", `/admin/api/ordre/liste?plattform=alle&${P}`, K)).body;
      assertEq(li.rows.filter((r: any) => r.is_test).map((r: any) => r.id).sort(), ["gt1", "gt2", "t1", "t2", "t3"], "ac4: list flags test rows");
      const adminTestProducer = require("./admin-test-producer") as typeof import("./admin-test-producer");
      assertEq(svc.RFB_LEGACY_TEST_AGENT_ID, adminTestProducer.LEGACY_TEST_FIXTURE_ID, "ac4: legacy test id matches admin-test-producer");
      assertEq(adminTestProducer.TEST_FIXTURE_ORIGIN, svc.RFB_TEST_ORIGINS[0], "ac4: test origin matches admin-test-producer");
    }

    // ── AC5: validation + defaults ─────────────────────────────────────────
    {
      const bad = [
        "/admin/api/ordre/oversikt?plattform=xyz",
        "/admin/api/ordre/oversikt?oppl=aar",
        "/admin/api/ordre/oversikt?fra=2026-13-01",
        "/admin/api/ordre/oversikt?fra=2026-02-30",
        "/admin/api/ordre/oversikt?fra=01.11.2026",
        "/admin/api/ordre/oversikt?fra=2026-11-05&til=2026-11-01",
        "/admin/api/ordre/oversikt?fra=2020-01-01&til=2026-11-01",
        "/admin/api/ordre/oversikt?plattform=rfb&plattform=alle",
        "/admin/api/ordre/liste?plattform=nope",
        "/admin/api/ordre/liste?status=foo",
        "/admin/api/ordre/liste?plattform=rfb&status=no_show",
        "/admin/api/ordre/liste?plattform=gardssalg&status=pending",
        "/admin/api/ordre/liste?til=2026-11-31",
      ];
      for (const u of bad) {
        const r = await req("GET", u, K);
        assertTrue(r.status === 400 && r.body?.success === false && typeof r.body?.error === "string", `ac5: ${u} -> 400 (${r.status})`);
      }
      const d = (await req("GET", "/admin/api/ordre/oversikt", K)).body;
      assertEq([d.plattform, d.periode.fra, d.periode.til, d.periode.oppl], ["alle", "2026-10-10", "2026-11-08", "dag"], "ac5: defaults = alle, last 30 days, dag");
      assertEq(d.rfb.series.length, 30, "ac5: default day series has 30 buckets");
      assertEq(d.rfb.total, 7, "ac5: default period (2026-10-10..2026-11-08) holds o1–o7, not o8");
    }

    // Experiences DB unavailable → gårdssalg block says so, RFB still served.
    {
      routeMod.__setAdminOrderStatsTestDbs(db, null);
      const r = await req("GET", `/admin/api/ordre/oversikt?${P}`, K);
      assertTrue(r.status === 200 && r.body.gardssalg.available === false && r.body.rfb.total === 7, "exp-off: gardssalg unavailable, rfb served");
      const l = await req("GET", `/admin/api/ordre/liste?${P}`, K);
      assertTrue(l.status === 200 && l.body.merknader.length === 1 && l.body.rows.every((x: any) => x.platform === "rfb"), "exp-off: list serves rfb with a merknad");
      routeMod.__setAdminOrderStatsTestDbs(db, exp);
    }

    // ══ Slice S2 ════════════════════════════════════════════════════════════
    // Minimal RFC 4180 parser (quotes, doubled quotes, commas, CR/LF in cells).
    function parseCsv(text: string): string[][] {
      const out: string[][] = [];
      let row: string[] = [];
      let cell = "";
      let q = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
          if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
          else cell += ch;
        } else if (ch === '"') q = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\r") { /* CRLF: handled on \n */ }
        else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; }
        else cell += ch;
      }
      if (cell !== "" || row.length > 0) { row.push(cell); out.push(row); }
      return out;
    }
    const CSV = "/admin/api/ordre/eksport.csv";

    // ── S2-AC1: auth + methods (CSV + page) ────────────────────────────────
    {
      assertEq((await reqH("GET", `${CSV}?${P}`)).status, 401, "s2-ac1: eksport.csv without key -> 401");
      assertEq((await reqH("GET", `${CSV}?${P}`, { "X-Admin-Key": "wrong" })).status, 401, "s2-ac1: eksport.csv wrong key -> 401");
      const noKey = await reqH("GET", `${CSV}?${P}`);
      assertTrue(!noKey.text.includes("Alfa Gård") && !noKey.text.includes("antall"), "s2-ac1: 401 body carries no data");
      const ok = await reqH("GET", `${CSV}?${P}`, K);
      assertEq(ok.status, 200, "s2-ac1: eksport.csv with key -> 200");
      assertEq(ok.headers["content-type"], "text/csv; charset=utf-8", "s2-ac1: Content-Type text/csv; charset=utf-8");
      assertTrue(/^attachment; filename="ordre-oversikt-alle-2026-10-01-2026-11-08-dag\.csv"$/.test(String(ok.headers["content-disposition"])), `s2-ac1: Content-Disposition attachment (${ok.headers["content-disposition"]})`);
      for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await reqH(m, `${CSV}?${P}`, K);
        assertTrue(r.status === 404 || r.status === 405, `s2-ac1: ${m} eksport.csv not handled (${r.status})`);
        const pg = await reqH(m, "/admin/ordre", K);
        assertTrue(pg.status === 404 || pg.status === 405, `s2-ac1: ${m} /admin/ordre not handled (${pg.status})`);
      }
      for (const u of [`${CSV}?plattform=xyz`, `${CSV}?oppl=aar`, `${CSV}?fra=2026-11-05&til=2026-11-01`]) {
        assertEq((await reqH("GET", u, K)).status, 400, `s2-ac1: ${u} -> 400`);
      }
      delete process.env.ADMIN_KEY;
      assertEq((await reqH("GET", CSV, K)).status, 503, "s2-ac1: eksport.csv with no admin key configured -> 503");
      process.env.ADMIN_KEY = ADMIN_KEY;

      // Page: same pattern as admin-crm.html — HTML served without a key,
      // no data in it; the data it loads needs X-Admin-Key (asserted above
      // and in AC1 for /oversikt).
      const page = await reqH("GET", "/admin/ordre");
      assertEq(page.status, 200, "s2-ac1: /admin/ordre HTML served (admin-crm pattern: login in the page)");
      const withKey = await reqH("GET", "/admin/ordre", K);
      assertEq(withKey.status, 200, "s2-ac1: /admin/ordre with key -> 200");
      assertTrue(String(page.headers["content-type"]).startsWith("text/html"), "s2-ac1: /admin/ordre is HTML");
      assertTrue(String(page.headers["x-robots-tag"]).includes("noindex"), "s2-ac1: X-Robots-Tag noindex");
      assertTrue(page.text.includes('<meta name="robots" content="noindex">'), "s2-ac1: robots noindex meta");
      assertTrue(page.text.includes("'X-Admin-Key': adminKey") && page.text.includes("sessionStorage.getItem('rfb_admin_key')"), "s2-ac1: page uses the admin-crm login pattern (sessionStorage key → X-Admin-Key)");
      assertTrue(page.text.includes("/admin/api/ordre") && page.text.includes("eksport.csv"), "s2-ac1: page reads the S1 API and links the CSV export");
      for (const v of ["Alfa Gård", "Gård A", BUYER.name, GUEST.name, "620"]) assertTrue(!page.text.includes(v), `s2-ac1: page HTML holds no data («${v}»)`);
      assertTrue(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(page.text), "s2-ac1: page never writes HTML strings into the DOM");
      assertTrue(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(page.text), "s2-ac1: page makes no write calls");
      assertTrue(page.text.includes("Opplevagent — opplevelser") && page.text.includes("Finn-tannlege") && page.text.includes("Kommer"), "s2-ac1: placeholders for later platforms");
    }

    // ── S2-AC2: no personal data in any CSV ────────────────────────────────
    const csvTexts: string[] = [];
    {
      for (const pl of ["alle", "rfb", "gardssalg"]) {
        for (const o of ["dag", "uke", "maaned"]) csvTexts.push((await reqH("GET", `${CSV}?plattform=${pl}&${P}&oppl=${o}`, K)).text);
      }
      csvTexts.push((await reqH("GET", CSV, K)).text);
      const all = csvTexts.join("\n");
      for (const v of [BUYER.name, BUYER.email, BUYER.phone, BUYER.note, GUEST.name, GUEST.email, GUEST.phone, GUEST.notes,
        "Hemmelig", "HEMMELIG", "buyer-ref-1", "tok-o1", "ctok-g1", "GS-G1", "cart-1", "Ring på", "Allergisk"]) {
        assertTrue(!all.includes(v), `s2-ac2: CSV never contains «${v}»`);
      }
      for (const f of ["buyer_", "guest_", "delivery_note", "notes", "contact_email"]) assertTrue(!all.includes(f), `s2-ac2: CSV has no ${f} field`);
      assertTrue(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(all), "s2-ac2: no e-mail address pattern anywhere in the CSV");
    }

    // ── S2-AC8: aggregates only ────────────────────────────────────────────
    {
      const r = await reqH("GET", `${CSV}?plattform=alle&${P}&oppl=dag`, K);
      assertTrue(r.text.startsWith("﻿"), "s2-ac8: UTF-8 BOM first");
      const rows = parseCsv(r.text.replace(/^﻿/, ""));
      const header = rows[0];
      assertEq(header, [...svc.CSV_COLUMNS], "s2-ac8: header = the aggregate columns");
      for (const c of header) assertTrue(!/(^id$|_id$|ref|order|booking|bestilling)/i.test(c), `s2-ac8: no order id/ref column (${c})`);
      const data = rows.slice(1);
      const ovA = (await req("GET", `/admin/api/ordre/oversikt?plattform=alle&${P}&oppl=dag`, K)).body;
      const expected = svc.oversiktCsvRows({ plattform: "alle", periode: { fra: ovA.periode.fra, til: ovA.periode.til, til_eksklusiv: "" }, oppl: "dag", rfb: ovA.rfb, gardssalg: ovA.gardssalg });
      assertEq(data.length, expected.length, "s2-ac8: CSV row count = aggregate rows of the oversikt body");
      // Independent count of the aggregate rows from the oversikt numbers.
      const rf = ovA.rfb, gs = ovA.gardssalg;
      const rfbRows = 1 + 1 + Object.keys(rf.by_status).length + 1 + 2 * rf.producers.length + 2 * rf.series.length + 4 + 1 + 1
        + 1 + Object.keys(rf.test.by_status).length + 1 + 1 + 1 + rf.test.producers.length;
      const gsRows = 1 + 1 + Object.keys(gs.by_status).length + Object.keys(gs.by_pre_status).length + 1 + 1 + 2 * gs.providers.length + 2 * gs.series.length + 3
        + 1 + Object.keys(gs.test.by_status).length + 1 + gs.test.providers.length;
      assertEq(data.length, rfbRows + gsRows, "s2-ac8: row count = independent aggregate count");
      assertEq(data.length, 215, "s2-ac8: 215 aggregate rows for the seeded period (39 days, dag)");
      assertTrue(data.length < 2 * 39 + 200, "s2-ac8: rows are aggregates, not one per order");
      assertTrue(data.every((d) => d.length === header.length), "s2-ac8: every row has every column");
      const orderIds = ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "t1", "t2", "t3", "g1", "g2", "g3", "g4", "g5", "g6", "gt1", "gt2",
        "GS-G1", "GS-G2", "GS-GT1", "e1", "i1", "h1"];
      assertTrue(data.every((d) => d.every((c) => !orderIds.includes(c))), "s2-ac8: no order / booking / item / event / handoff id as a cell");
      const vi = header.indexOf("verdi");
      assertTrue(data.every((d) => d[vi] === "" || /^-?\d+(\.\d+)?$/.test(d[vi])), "s2-ac8: every verdi is a number (or empty)");
      const mi = header.indexOf("maal");
      const allowedMaal = ["tilgjengelig", "antall", "antall_naa", "sum_nok", "sum_personer", "maalt", "uten_svar", "median_timer", "snitt_timer"];
      assertTrue(data.every((d) => allowedMaal.includes(d[mi])), "s2-ac8: every maal is an aggregate measure");
      const find = (pl: string, om: string, kat: string, key: string, maal: string) =>
        data.find((d) => d[0] === pl && d[1] === om && d[2] === kat && d[3] === key && d[5] === maal)?.[vi];
      assertEq(find("rfb", "ekte", "total", "", "antall"), "7", "s2-ac8: rfb total matches oversikt");
      assertEq(find("rfb", "ekte", "omsetning", "", "sum_nok"), "620.5", "s2-ac8: rfb sum matches oversikt");
      assertEq(find("rfb", "ekte", "status", "pending", "antall"), "2", "s2-ac8: rfb pending matches oversikt");
      assertEq(find("rfb", "test", "total", "", "antall"), "3", "s2-ac8: rfb test row apart");
      assertEq(find("gardssalg", "ekte", "total", "", "antall"), "5", "s2-ac8: gardssalg total matches oversikt");
      assertEq(find("gardssalg", "test", "total", "", "antall"), "2", "s2-ac8: gardssalg test row apart");
      assertEq(find("rfb", "ekte", "produsent", "ag-a", "antall"), String(rf.producers.find((p: any) => p.agent_id === "ag-a").total), "s2-ac8: producer aggregate");
      const rfbOnly = parseCsv((await reqH("GET", `${CSV}?plattform=rfb&${P}&oppl=maaned`, K)).text.replace(/^﻿/, "")).slice(1);
      assertTrue(rfbOnly.length > 0 && rfbOnly.every((d) => d[0] === "rfb"), "s2-ac8: plattform=rfb exports only rfb rows");
      routeMod.__setAdminOrderStatsTestDbs(db, null);
      const off = parseCsv((await reqH("GET", `${CSV}?plattform=gardssalg&${P}`, K)).text.replace(/^﻿/, "")).slice(1);
      assertEq(off.map((d) => [d[0], d[2], d[6]]), [["gardssalg", "tilgjengelig", "0"]], "s2-ac8: unavailable gårdssalg → one 0 flag row, no free text");
      routeMod.__setAdminOrderStatsTestDbs(db, exp);
    }

    // ── CSV cell escaping + formula guard ──────────────────────────────────
    {
      assertEq(svc.csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)", "csv: = gets a ' prefix");
      assertEq(svc.csvCell("+47 Gård"), "'+47 Gård", "csv: + gets a ' prefix");
      assertEq(svc.csvCell("-Gård"), "'-Gård", "csv: - gets a ' prefix");
      assertEq(svc.csvCell("@Gård"), "'@Gård", "csv: @ gets a ' prefix");
      assertEq(svc.csvCell("Gård, Nord"), '"Gård, Nord"', "csv: comma quoted");
      assertEq(svc.csvCell('Gården "Lia"'), '"Gården ""Lia"""', "csv: quotes doubled");
      assertEq(svc.csvCell("Linje1\nLinje2"), '"Linje1\nLinje2"', "csv: newline quoted");
      assertEq(svc.csvCell("=1,\"2\""), '"\'=1,""2"""', "csv: formula guard + quoting together");
      assertEq(svc.csvCell(-3.5), "-3.5", "csv: numbers are not prefixed");
      assertEq(svc.csvCell(null), "", "csv: null → empty");
      assertEq(svc.csvCell("Gård post@gard-eksempel.no"), "Gård [e-post skjult]", "csv: e-mail in text masked");
      assertEq(svc.csvCell("Ålesund Gård"), "Ålesund Gård", "csv: plain text unchanged");
    }

    // ── S2-PS: pilot-status agrees with oversikt (DB seeded relative to now) ─
    {
      initMod.__initSchemaForTesting(db2 as any);
      const realNow = new Date();
      const ago = (d: number) => svc.sqliteDaysAgo(realNow, d);
      const a2 = db2.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
        VALUES (?, ?, 'Produsent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')`);
      a2.run("p-a", "Gård Alfa", "alfa@produsent-eksempel.no", "k2-a");
      a2.run("p-x", "=HYPERLINK(\"http://x\") post@gard-eksempel.no", "x@produsent-eksempel.no", "k2-x");
      a2.run("p-test", "Testprodusent", "t@produsent-eksempel.no", "k2-t");
      db2.prepare("UPDATE agents SET origin = 'test_fixture' WHERE id = 'p-test'").run();
      db2.prepare(`INSERT INTO carts (id, buyer_ref, status, buyer_name, buyer_email, buyer_phone, delivery_note)
                  VALUES ('c2', 'br-2', 'submitted', ?, ?, ?, ?)`).run(BUYER.name, BUYER.email, BUYER.phone, BUYER.note);
      const o2 = db2.prepare(`INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, total_nok, created_at, buyer_name, buyer_email, buyer_phone, delivery_note, confirm_token)
        VALUES (?, 'c2', ?, 'br-2', ?, ?, ?, ?, ?, ?, ?, ?)`);
      const seed: Array<[string, string, string, number]> = [
        ["q1", "p-a", "pending", 1], ["q2", "p-a", "confirmed", 3], ["q3", "p-a", "completed", 5], ["q4", "p-x", "completed", 8],
        ["q5", "p-x", "declined", 12], ["q6", "p-a", "cancelled", 20], ["q7", "p-test", "completed", 2], ["q8", "p-test", "pending", 4],
        ["q9", "p-a", "completed", 45], // outside both windows
      ];
      for (const [id, ag, st, d] of seed) o2.run(id, ag, st, 100, ago(d), BUYER.name, BUYER.email, BUYER.phone, BUYER.note, "tok-" + id);
      db2.prepare("UPDATE orders SET completion_source = 'auto' WHERE id IN ('q3', 'q7')").run();

      adminOrdersMod.__setAdminOrdersTestDb(db2);
      routeMod.__setAdminOrderStatsTestDbs(db2, null);
      routeMod.__setAdminOrderStatsNowForTesting(null);
      const ps = await req("GET", "/admin/orders/pilot-status", K);
      const ovNow = (await req("GET", "/admin/api/ordre/oversikt?plattform=rfb", K)).body;
      assertEq(ps.status, 200, "s2-ps: pilot-status 200");
      assertEq((await req("GET", "/admin/orders/pilot-status")).status, 401, "s2-ps: pilot-status still 401 without key");
      assertEq(Object.keys(ps.body), ["success", "opt_in", "passes_gate", "verified_count", "orders_30d", "auto_complete", "unanswered"], "s2-ps: pilot-status top-level shape unchanged");
      assertEq(Object.keys(ps.body.orders_30d), ["window_days", "by_status", "total", "completed_auto", "completed_confirmed"], "s2-ps: orders_30d shape unchanged");
      assertEq(Object.keys(ps.body.orders_30d.by_status), ["pending", "confirmed", "declined", "ready", "completed", "cancelled"], "s2-ps: by_status keys unchanged");
      assertEq(ps.body.orders_30d.by_status, { pending: 2, confirmed: 1, declined: 1, ready: 0, completed: 3, cancelled: 1 }, "s2-ps: pilot-status counts every order in 30 days (test included, as before)");
      assertEq([ps.body.orders_30d.total, ps.body.orders_30d.completed_auto, ps.body.orders_30d.completed_confirmed], [8, 2, 1], "s2-ps: total / completed_auto / completed_confirmed");
      // Same numbers the pre-S2 inline SQL gave.
      const legacy = db2.prepare("SELECT status, COUNT(*) AS n FROM orders WHERE created_at >= datetime('now', '-30 days') GROUP BY status").all() as Array<{ status: string; n: number }>;
      for (const r of legacy) assertEq(ps.body.orders_30d.by_status[r.status], r.n, `s2-ps: by_status.${r.status} = pre-S2 SQL`);
      const legacyAuto = (db2.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'completed' AND completion_source = 'auto' AND created_at >= datetime('now', '-30 days')").get() as any).n;
      assertEq(ps.body.orders_30d.completed_auto, legacyAuto, "s2-ps: completed_auto = pre-S2 SQL");
      // Agreement with oversikt for the same (default 30-day) period.
      for (const st of Object.keys(ps.body.orders_30d.by_status)) {
        assertEq(ps.body.orders_30d.by_status[st], ovNow.rfb.by_status[st] + ovNow.rfb.test.by_status[st], `s2-ps: pilot-status ${st} = oversikt real + test`);
      }
      assertEq(ps.body.orders_30d.total, ovNow.rfb.total + ovNow.rfb.test.total, "s2-ps: pilot-status total = oversikt total + test total");
      // The module function agrees with oversikt on the oversikt period too.
      const per = svc.parseOversiktParams({}, realNow);
      if (per.ok) {
        const c = svc.countRfbOrdersByStatus(db2, per.params.periode.fra, per.params.periode.til_eksklusiv);
        assertEq(c.real.by_status, ovNow.rfb.by_status, "s2-ps: countRfbOrdersByStatus(real) = oversikt by_status");
        assertEq([c.real.total, c.test.total], [ovNow.rfb.total, ovNow.rfb.test.total], "s2-ps: module real/test totals = oversikt");
      } else assertTrue(false, "s2-ps: default period parses");

      // End-to-end CSV guard on a producer name holding a formula + an e-mail.
      const csvX = (await reqH("GET", `${CSV}?plattform=rfb`, K)).text;
      assertTrue(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(csvX), "s2-ps: producer-name e-mail masked in the CSV");
      assertTrue(csvX.includes(`"'=HYPERLINK(""http://x"") [e-post skjult]"`), "s2-ps: formula-like producer name neutralised and quoted");
      assertTrue(!csvX.includes(BUYER.email) && !csvX.includes(BUYER.name), "s2-ps: no buyer data in the CSV");

      adminOrdersMod.__setAdminOrdersTestDb(null);
      routeMod.__setAdminOrderStatsTestDbs(db, exp);
      routeMod.__setAdminOrderStatsNowForTesting(NOW);
    }

    // Read-only: nothing changed in either DB.
    {
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n, 11, "ro: orders unchanged");
      assertEq((exp.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as any).n, 8, "ro: bookings unchanged");
    }
  } catch (err) {
    failed++;
    failures.push(`admin-order-stats: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    routeMod.__setAdminOrderStatsTestDbs(null);
    routeMod.__setAdminOrderStatsNowForTesting(null);
    adminOrdersMod.__setAdminOrdersTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    try { db.close(); } catch { /* best-effort */ }
    try { exp.close(); } catch { /* best-effort */ }
    try { db2.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminOrderStatsTests({ log: true }).then((r) => {
    console.log(`\nadmin-order-stats: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

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

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ENABLE_EXPERIENCES"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const ADMIN_KEY = "order-stats-test-admin-key";
  const NOW = new Date("2026-11-08T12:00:00.000Z");

  const db = new Database(":memory:");
  const exp = new Database(":memory:");
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
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    try { db.close(); } catch { /* best-effort */ }
    try { exp.close(); } catch { /* best-effort */ }
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

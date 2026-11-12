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
 * Slice S3 (same harness): RFB referrals (contact_clicks, /ut/) + «levert
 * til AI-assistent» (profile_ai_deliveries) in oversikt, CSV and page
 *   S3-AC6  a click with a known bot UA (parseUserAgent, the classifier that
 *           stamps contact_clicks.is_bot) is not in the main click count but
 *           is in the separate bot count
 *   S3-SQL  clicks per type and per period equal a direct SQL count
 *   S3-AI   AI deliveries are a separate block, never added to clicks
 *   S3-TEST test-producer clicks / deliveries are in their own row
 *   S3-AC2  no IP hash, session id, UA, utm or e-mail in any response / CSV
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

  const analytics = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ENABLE_EXPERIENCES", "PROFILE_AI_DELIVERIES_COUNTING_SINCE"];
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

    // ── Seed RFB clicks (S3) ───────────────────────────────────────────────
    // is_bot is stamped exactly as routes/contact-tracking.ts recordClick()
    // does: parseUserAgent(ua).isBot. session_id has the production shape
    // "<ipHash>:<userAgent>" and must never reach a response.
    const UA_HUMAN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
    const UA_GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
    const UA_CURL = "curl/8.4.0";
    const insClick = db.prepare(`INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, utm_source, ai_source, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const click = (agent: string, kind: string, ua: string, created: string, utm: string | null = null, ai: string | null = null) =>
      insClick.run(agent, kind, "iphashHEMMELIGSESJON:" + ua, analytics.parseUserAgent(ua).isBot ? 1 : 0, utm, ai, created);
    click("ag-a", "website", UA_HUMAN, "2026-11-01 10:00:00", "chatgpt.com-utmkilde", "chatgpt");
    click("ag-a", "website", UA_HUMAN, "2026-11-01 11:00:00");
    click("ag-a", "external:facebook", UA_HUMAN, "2026-11-02 09:00:00");
    click("ag-b", "external:instagram", UA_HUMAN, "2026-11-03 09:00:00");
    click("ag-b", "phone", UA_HUMAN, "2026-11-03 12:00:00");
    click("ag-a", "email", UA_HUMAN, "2026-10-20 08:00:00");
    click("ag-a", "website", UA_GPTBOT, "2026-11-01 12:00:00");          // AC6: known bot UA
    click("ag-b", "phone", UA_CURL, "2026-11-04 12:00:00");              // script → bot
    click("ag-test", "website", UA_HUMAN, "2026-11-02 10:00:00");       // test producer
    click(svc.RFB_LEGACY_TEST_AGENT_ID, "email", UA_HUMAN, "2026-11-05 10:00:00"); // legacy test producer
    click("ag-test", "website", UA_GPTBOT, "2026-11-02 11:00:00");      // bot at the test producer → bot row
    click("ag-a", "website", UA_HUMAN, "2026-09-15 10:00:00");          // outside the period

    // ── Seed AI deliveries (S3) ────────────────────────────────────────────
    const insDel = db.prepare(`INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)`);
    insDel.run("rfb", "ag-a", "2026-11-01", "ai_page_list", "chatgpt", 5);
    insDel.run("rfb", "ag-a", "2026-11-02", "mcp", "claude", 3);
    insDel.run("rfb", "ag-b", "2026-11-02", "ai_page_profile", "perplexity", 2);
    insDel.run("rfb", "ag-test", "2026-11-02", "mcp", "claude", 4);          // test producer
    insDel.run("rfb", "ag-a", "2026-10-20", "a2a", "other", 7);             // before the counting start (2026-10-26)
    insDel.run("dental", "clinic-x", "2026-11-02", "ai_page_list", "chatgpt", 9); // other vertical
    insDel.run("rfb", "ag-a", "2026-11-09", "mcp", "chatgpt", 1);           // after til

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
      // S4 replaced the S2 placeholders for opplevelser and Finn-tannlege with their click sections.
      assertTrue(page.text.includes("Opplevagent opplevelser — henvisninger") && page.text.includes("Finn-tannlege — henvisninger"), "s2-ac1: sections for the platforms without orders (S4: their clicks)");
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
      const dataAll = rows.slice(1);
      const ovA = (await req("GET", `/admin/api/ordre/oversikt?plattform=alle&${P}&oppl=dag`, K)).body;
      const expected = svc.oversiktCsvRows({ plattform: "alle", periode: { fra: ovA.periode.fra, til: ovA.periode.til, til_eksklusiv: "" }, oppl: "dag",
        rfb: ovA.rfb, gardssalg: ovA.gardssalg, henvisninger: ovA.henvisninger, ai_leveranser: ovA.ai_leveranser });
      assertEq(dataAll.length, expected.length, "s2-ac8: CSV row count = aggregate rows of the oversikt body");
      // The S2 order rows (S3's henvisninger_* / ai_leveranser_* rows are checked in the S3 block).
      const isS3 = (d: string[]) => /^(henvisninger_|ai_leveranser_)/.test(d[2]);
      const data = dataAll.filter((d) => !isS3(d));
      // Independent count of the aggregate rows from the oversikt numbers.
      const rf = ovA.rfb, gs = ovA.gardssalg;
      const rfbRows = 1 + 1 + Object.keys(rf.by_status).length + 1 + 2 * rf.producers.length + 2 * rf.series.length + 4 + 1 + 1
        + 1 + Object.keys(rf.test.by_status).length + 1 + 1 + 1 + rf.test.producers.length;
      const gsRows = 1 + 1 + Object.keys(gs.by_status).length + Object.keys(gs.by_pre_status).length + 1 + 1 + 2 * gs.providers.length + 2 * gs.series.length + 3
        + 1 + Object.keys(gs.test.by_status).length + 1 + gs.test.providers.length;
      assertEq(data.length, rfbRows + gsRows, "s2-ac8: row count = independent aggregate count");
      assertEq(data.length, 215, "s2-ac8: 215 aggregate rows for the seeded period (39 days, dag)");
      assertTrue(data.length < 2 * 39 + 200, "s2-ac8: rows are aggregates, not one per order");
      assertTrue(dataAll.every((d) => d.length === header.length), "s2-ac8: every row has every column");
      const orderIds = ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "t1", "t2", "t3", "g1", "g2", "g3", "g4", "g5", "g6", "gt1", "gt2",
        "GS-G1", "GS-G2", "GS-GT1", "e1", "i1", "h1"];
      assertTrue(dataAll.every((d) => d.every((c) => !orderIds.includes(c))), "s2-ac8: no order / booking / item / event / handoff id as a cell");
      const vi = header.indexOf("verdi");
      assertTrue(dataAll.every((d) => d[vi] === "" || /^-?\d+(\.\d+)?$/.test(d[vi])), "s2-ac8: every verdi is a number (or empty)");
      const mi = header.indexOf("maal");
      const allowedMaal = ["tilgjengelig", "antall", "antall_naa", "sum_nok", "sum_personer", "maalt", "uten_svar", "median_timer", "snitt_timer", "antall_klikk", "levert_til_ai"];
      assertTrue(dataAll.every((d) => allowedMaal.includes(d[mi])), "s2-ac8: every maal is an aggregate measure");
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
      // S4: the gårdssalg click rows come from lokal.db (profile_link_clicks), not the experiences DB.
      assertEq(off.filter((d) => !d[2].startsWith("henvisninger_")).map((d) => [d[0], d[2], d[6]]), [["gardssalg", "tilgjengelig", "0"]], "s2-ac8: unavailable gårdssalg → one 0 flag row, no free text");
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

    // ══ Slice S3 ════════════════════════════════════════════════════════════
    const ov3 = (await req("GET", `/admin/api/ordre/oversikt?plattform=alle&${P}&oppl=dag`, K)).body;
    const henv = ov3.henvisninger?.rfb;
    const aiDel = ov3.ai_leveranser?.rfb;

    // ── S3-AC6: bot clicks out of the main count, in the bot count ─────────
    {
      assertTrue(analytics.parseUserAgent(UA_GPTBOT).isBot && !analytics.parseUserAgent(UA_HUMAN).isBot, "s3-ac6: fixture UAs classified by the existing parseUserAgent (bot / human)");
      assertTrue(henv && henv.available === true, "s3-ac6: henvisninger.rfb present for plattform=alle");
      assertEq(henv.by_type.nettside, 2, "s3-ac6: the GPTBot website click is NOT in the main nettside count (2 human clicks)");
      assertEq(henv.bot.total, 3, "s3-ac6: bot count holds GPTBot + curl + GPTBot at the test producer");
      assertEq(henv.bot.by_type.nettside, 2, "s3-ac6: the GPTBot website clicks ARE in the bot nettside count");
      assertEq(henv.bot.by_type.telefon, 1, "s3-ac6: the curl phone click is in the bot telefon count");
      assertEq(henv.series.find((s: any) => s.bucket === "2026-11-01")?.by_type.nettside, 2, "s3-ac6: bot click not in the day series either");
      const allRows = (db.prepare("SELECT COUNT(*) AS n FROM contact_clicks WHERE created_at >= ? AND created_at < ?").get("2026-10-01", "2026-11-09") as any).n;
      assertEq(henv.total + henv.bot.total + henv.test.total, allRows, "s3-ac6: main + bot + test = every click in the period (no double count)");
    }

    // ── S3-SQL: per type and per period = direct SQL ───────────────────────
    {
      const range = ["2026-10-01", "2026-11-09"];
      const notTest = `NOT (COALESCE(a.origin,'') IN ('test_fixture','test_claim_fixture') OR c.agent_id = '${svc.RFB_LEGACY_TEST_AGENT_ID}')`;
      const typeCase = `CASE WHEN c.kind = 'website' THEN 'nettside' WHEN c.kind = 'phone' THEN 'telefon' WHEN c.kind = 'email' THEN 'e_post'
                             WHEN c.kind LIKE 'external:%' THEN 'sosiale_medier' ELSE 'annet' END`;
      const sqlType = db.prepare(`SELECT ${typeCase} AS t, COUNT(*) AS n FROM contact_clicks c LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.created_at >= ? AND c.created_at < ? AND c.is_bot = 0 AND ${notTest} GROUP BY t`).all(...range) as Array<{ t: string; n: number }>;
      for (const r of sqlType) assertEq(henv.by_type[r.t], r.n, `s3-sql: by_type.${r.t} = SQL`);
      assertEq(henv.total, sqlType.reduce((a, r) => a + r.n, 0), "s3-sql: total = SQL");
      assertEq(henv.by_type, { nettside: 2, sosiale_medier: 2, telefon: 1, e_post: 1, annet: 0 }, "s3-sql: by_type zero-filled (6 human clicks c1–c6)");
      assertEq(henv.sosiale_medier_per_kanal, { facebook: 1, instagram: 1 }, "s3-sql: social clicks per external channel");
      const sqlDay = db.prepare(`SELECT date(c.created_at) AS d, COUNT(*) AS n FROM contact_clicks c LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.created_at >= ? AND c.created_at < ? AND c.is_bot = 0 AND ${notTest} GROUP BY d`).all(...range) as Array<{ d: string; n: number }>;
      for (const r of sqlDay) assertEq(henv.series.find((s: any) => s.bucket === r.d)?.total, r.n, `s3-sql: day ${r.d} = SQL`);
      assertEq(henv.series.length, 39, "s3-sql: zero-filled day series (same buckets as the orders)");
      assertEq(henv.series.reduce((a: number, s: any) => a + s.total, 0), henv.total, "s3-sql: series sums to total");
      const wk = (await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}&oppl=uke`, K)).body.henvisninger.rfb;
      const sqlWeek = db.prepare(`SELECT date(c.created_at, 'weekday 0', '-6 days') AS w, COUNT(*) AS n FROM contact_clicks c LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.created_at >= ? AND c.created_at < ? AND c.is_bot = 0 AND ${notTest} GROUP BY w`).all(...range) as Array<{ w: string; n: number }>;
      for (const r of sqlWeek) assertEq(wk.series.find((s: any) => s.bucket === r.w)?.total, r.n, `s3-sql: week ${r.w} = SQL`);
      assertEq(wk.series[0].bucket, "2026-09-28", "s3-sql: week buckets start on the Monday of fra's week");
      const mo = (await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}&oppl=maaned`, K)).body.henvisninger.rfb;
      assertEq(mo.series.map((s: any) => [s.bucket, s.total]), [["2026-10", 1], ["2026-11", 5]], "s3-sql: month buckets");
      const narrow = (await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&fra=2026-11-01&til=2026-11-01`, K)).body.henvisninger.rfb;
      assertEq([narrow.total, narrow.by_type.nettside, narrow.bot.total], [2, 2, 1], "s3-sql: one-day period (fra = til) counts that day only");
      // Per-type explanations exist for the page / API reader.
      assertTrue(Object.keys(henv.by_type).every((t) => typeof henv.type_forklaring[t] === "string" && henv.type_forklaring[t].length > 0), "s3-sql: every type carries a Norwegian explanation");
      assertTrue(typeof henv.forklaring === "string" && typeof henv.bot.forklaring === "string" && typeof henv.test.forklaring === "string", "s3-sql: every block carries a forklaring");
    }

    // ── S3-TEST: test-producer clicks in their own row ─────────────────────
    {
      assertEq([henv.test.total, henv.test.by_type.nettside, henv.test.by_type.e_post], [2, 1, 1], "s3-test: test row holds ag-test website + legacy email");
      assertEq(henv.test.producers.map((p: any) => p.agent_id).sort(), ["ag-test", svc.RFB_LEGACY_TEST_AGENT_ID].sort(), "s3-test: test producers listed in the test row");
      const testSql = (db.prepare(`SELECT COUNT(*) AS n FROM contact_clicks c LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.created_at >= ? AND c.created_at < ? AND c.is_bot = 0 AND (COALESCE(a.origin,'') IN ('test_fixture','test_claim_fixture') OR c.agent_id = ?)`)
        .get("2026-10-01", "2026-11-09", svc.RFB_LEGACY_TEST_AGENT_ID) as any).n;
      assertEq(henv.test.total, testSql, "s3-test: test row = SQL");
      assertEq(henv.series.find((s: any) => s.bucket === "2026-11-02")?.total, 1, "s3-test: test click not in the day series (only c3 on 2026-11-02)");
      assertEq([aiDel.test.total, aiDel.test.by_channel.mcp], [4, 4], "s3-test: test-producer AI deliveries in their own row");
    }

    // ── S3-AI: AI deliveries separate, never added to clicks ───────────────
    {
      assertTrue(aiDel && aiDel.available === true, "s3-ai: ai_leveranser.rfb present");
      assertEq(aiDel.etikett, "levert til AI-assistent", "s3-ai: labelled «levert til AI-assistent»");
      assertEq(aiDel.total, 10, "s3-ai: 5 + 3 + 2 (test, before counting start, other vertical and after til excluded)");
      const aiSql = (db.prepare(`SELECT SUM(d.count) AS n FROM profile_ai_deliveries d LEFT JOIN agents a ON a.id = d.profile_id
        WHERE d.vertical_id = 'rfb' AND d.day >= ? AND d.day <= ?
          AND NOT (COALESCE(a.origin,'') IN ('test_fixture','test_claim_fixture') OR d.profile_id = ?)`)
        .get("2026-10-26", "2026-11-08", svc.RFB_LEGACY_TEST_AGENT_ID) as any).n;
      assertEq(aiDel.total, aiSql, "s3-ai: total = SQL (from the counting start)");
      assertEq(aiDel.counting_since, "2026-10-26", "s3-ai: counting_since reported");
      assertEq(aiDel.by_channel, { ai_page_list: 5, ai_page_profile: 2, mcp: 3, a2a: 0 }, "s3-ai: per channel");
      assertEq(aiDel.by_vendor, { chatgpt: 5, claude: 3, perplexity: 2, other: 0, unknown: 0 }, "s3-ai: per AI");
      assertEq(aiDel.series.find((s: any) => s.bucket === "2026-11-02")?.total, 5, "s3-ai: day series (3 + 2, test excluded)");
      assertEq(aiDel.series.reduce((a: number, s: any) => a + s.total, 0), aiDel.total, "s3-ai: series sums to total");
      assertEq(henv.total, 6, "s3-ai: click total unchanged by the 10 deliveries (not summed)");
      assertTrue(!("ai_leveranser" in henv) && !("henvisninger" in aiDel) && !("total" in ov3.henvisninger) , "s3-ai: two separate blocks, no combined click+delivery number");
      assertTrue(ov3.rfb.total === 7 && Object.keys(ov3.rfb).every((k: string) => !/henvis|ai_lev/.test(k)), "s3-ai: the S1 rfb order block is unchanged");
      const gsOnly = (await req("GET", `/admin/api/ordre/oversikt?plattform=gardssalg&${P}`, K)).body;
      // S4: plattform=gardssalg carries the gårdssalg profile clicks, never the RFB ones.
      assertTrue(gsOnly.henvisninger?.rfb === undefined && gsOnly.ai_leveranser === undefined, "s3-ai: plattform=gardssalg has no RFB click / AI blocks");
      const rfbOnly = (await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}`, K)).body;
      assertTrue(rfbOnly.henvisninger.rfb.total === 6 && rfbOnly.ai_leveranser.rfb.total === 10, "s3-ai: plattform=rfb has both blocks");
    }

    // ── S3 CSV: aggregate rows, clicks and deliveries in separate measures ─
    {
      const r = await reqH("GET", `${CSV}?plattform=alle&${P}&oppl=dag`, K);
      const rows = parseCsv(r.text.replace(/^﻿/, ""));
      const header = rows[0];
      // S4 adds henvisninger_* rows for opplevelser / gardssalg / tannlege; the S3 count is RFB's.
      const data = rows.slice(1).filter((d) => d[0] === "rfb" && /^(henvisninger_|ai_leveranser_)/.test(d[2]));
      const vi = header.indexOf("verdi");
      const find = (om: string, kat: string, key: string, maal: string) =>
        data.find((d) => d[0] === "rfb" && d[1] === om && d[2] === kat && d[3] === key && d[5] === maal)?.[vi];
      assertEq(find("ekte", "henvisninger_total", "", "antall_klikk"), "6", "s3-csv: main click total");
      assertEq(find("bot", "henvisninger_total", "", "antall_klikk"), "3", "s3-csv: bot clicks in their own row");
      assertEq(find("test", "henvisninger_total", "", "antall_klikk"), "2", "s3-csv: test clicks in their own row");
      assertEq(find("ekte", "henvisninger_type", "nettside", "antall_klikk"), "2", "s3-csv: per type");
      assertEq(find("ekte", "henvisninger_sosiale_medier", "facebook", "antall_klikk"), "1", "s3-csv: social per channel");
      assertEq(find("ekte", "ai_leveranser_total", "", "levert_til_ai"), "10", "s3-csv: AI deliveries total");
      assertEq(find("ekte", "ai_leveranser_ai", "claude", "levert_til_ai"), "3", "s3-csv: AI deliveries per AI");
      assertEq(find("test", "ai_leveranser_total", "", "levert_til_ai"), "4", "s3-csv: test AI deliveries apart");
      assertTrue(data.filter((d) => d[2].startsWith("henvisninger_")).every((d) => d[5] === "antall_klikk" || d[5] === "tilgjengelig")
        && data.filter((d) => d[2].startsWith("ai_leveranser_")).every((d) => d[5] === "levert_til_ai" || d[5] === "tilgjengelig"),
        "s3-csv: clicks and AI deliveries use different measures (never one sum)");
      const expectedS3 = 2 + 5 + 2 + 39 + 1 + 5 + 1 + 5 + 2   // henvisninger: flag, total, 5 types, 2 social, 39 days, bot total+5, test total+5, 2 test producers
        + 2 + 4 + 5 + 39 + 1 + 4;                              // ai_leveranser: flag, total, 4 channels, 5 AIs, 39 days, test total+4 channels
      assertEq(data.length, expectedS3, "s3-csv: S3 aggregate row count");
      const gsCsv = parseCsv((await reqH("GET", `${CSV}?plattform=gardssalg&${P}`, K)).text.replace(/^﻿/, "")).slice(1);
      assertTrue(gsCsv.every((d) => d[0] !== "rfb" && !/^ai_leveranser_/.test(d[2])), "s3-csv: plattform=gardssalg exports no S3 (RFB) rows");
    }

    // ── S3-AC2 / AC1: no personal data, auth unchanged ─────────────────────
    {
      const jsonTexts: string[] = [];
      const csvTexts3: string[] = [];
      for (const pl of ["alle", "rfb"]) {
        for (const o of ["dag", "uke", "maaned"]) {
          jsonTexts.push((await req("GET", `/admin/api/ordre/oversikt?plattform=${pl}&${P}&oppl=${o}`, K)).text);
          csvTexts3.push((await reqH("GET", `${CSV}?plattform=${pl}&${P}&oppl=${o}`, K)).text);
        }
      }
      const all = [...jsonTexts, ...csvTexts3].join("\n");
      const jsonAll = jsonTexts.join("\n");
      const csvAll = csvTexts3.join("\n");
      for (const v of ["iphash", "HEMMELIG", "Mozilla", "iPhone", "GPTBot", "curl/", "chatgpt.com-utmkilde", BUYER.name, BUYER.email, GUEST.name]) {
        assertTrue(!all.includes(v), `s3-ac2: no «${v}» (IP hash / session id / UA / utm / buyer) in any response or CSV`);
      }
      for (const f of ["session_id", "utm_source", "ai_source", "is_bot", "user_agent", "buyer_", "guest_", "delivery_note", "notes"]) {
        assertTrue(!jsonAll.includes(`"${f}"`) && !csvAll.includes(f), `s3-ac2: no field named ${f}`);
      }
      assertTrue(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(all), "s3-ac2: no e-mail address pattern anywhere");
      assertTrue(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(all), "s3-ac2: no IP address pattern anywhere");
      assertEq((await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}`)).status, 401, "s3-ac1: oversikt without key -> 401");
      assertEq((await reqH("GET", `${CSV}?plattform=rfb&${P}`)).status, 401, "s3-ac1: eksport.csv without key -> 401");
      const noKey = await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}`);
      assertTrue(!noKey.text.includes("henvisninger") && !noKey.text.includes("ai_leveranser"), "s3-ac1: 401 body carries no S3 data");
      for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await req(m, `/admin/api/ordre/oversikt?plattform=rfb&${P}`, K);
        assertTrue(r.status === 404 || r.status === 405, `s3-ac1: ${m} oversikt not handled (${r.status})`);
      }
    }

    // ── S3 page ────────────────────────────────────────────────────────────
    {
      const page = (await reqH("GET", "/admin/ordre")).text;
      assertTrue(page.includes("henvisninger") && page.includes("Levert til AI-assistent") && page.includes("Bot-klikk"), "s3-page: section for clicks, bot clicks and «levert til AI-assistent»");
      assertTrue(page.includes("ikke lagt sammen med klikkene"), "s3-page: explains AI deliveries are not added to clicks");
      assertTrue(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(page), "s3-page: still no HTML strings written into the DOM");
      assertTrue(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(page), "s3-page: still no write calls");
    }

    // ── S3 counting-start override + unavailable tables ────────────────────
    {
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-01";
      const early = (await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}`, K)).body.ai_leveranser.rfb;
      assertEq([early.total, early.by_channel.a2a, early.counting_since], [17, 7, "2026-10-01"], "s3-ai: the configured counting start is honoured");
      delete process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
      const bare = new Database(":memory:");
      try {
        bare.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, origin TEXT)");
        const per = svc.parseOversiktParams({ fra: "2026-11-01", til: "2026-11-02" }, NOW);
        if (per.ok) {
          const h = svc.computeRfbReferrals(bare, per.params.periode, "dag");
          const a = svc.computeRfbAiDeliveries(bare, per.params.periode, "dag");
          assertTrue(h.available === false && a.available === false, "s3: missing tables → available=false, no throw");
          const csvRows = svc.oversiktCsvRows({ plattform: "rfb", periode: per.params.periode, oppl: "dag", henvisninger: { rfb: h }, ai_leveranser: { rfb: a } });
          assertEq(csvRows.map((x) => [x.kategori, x.verdi]), [["henvisninger_tilgjengelig", 0], ["ai_leveranser_tilgjengelig", 0]], "s3: unavailable → one 0 flag row each");
        } else assertTrue(false, "s3: period parses");
      } finally { bare.close(); }
      assertEq(svc.henvisningType("external:tiktok"), "sosiale_medier", "s3: external:<type> → sosiale_medier");
      assertEq(svc.henvisningType("weird"), "annet", "s3: unknown kind → annet");
    }

    // Read-only: nothing changed in either DB.
    {
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM contact_clicks").get() as any).n, 12, "ro: contact_clicks unchanged");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM profile_ai_deliveries").get() as any).n, 7, "ro: profile_ai_deliveries unchanged");
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

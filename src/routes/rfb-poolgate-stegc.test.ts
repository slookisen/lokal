/**
 * rfb-poolgate-stegc.test.ts — tests for "Steg C" of dev-request
 * 2026-07-31-rfb-poolgate-uten-telefon-og-batchkapasitet:
 *
 *   C1 — POST /admin/run-verifier (src/routes/admin-run-verifier.ts):
 *        the verifier batch-size default now reads VERIFY_BATCH_SIZE when
 *        the caller omits `batchSize`, falling back to the literal "30"
 *        when the env var is also unset. Explicit body/query `batchSize`
 *        still wins over the env var, and the existing [1,100] clamp is
 *        unchanged.
 *
 *   C2 — POST /admin/crm/compose (src/routes/crm.ts): a new atomic
 *        daily-send-cap reservation guard (`outreach_daily_send_cap`,
 *        OUTREACH_MAX_PER_DAY, default 50) gates the cold-outreach send
 *        point (intent='resend_send', createdBy='claude', !force), inserted
 *        as the FIRST check in that block, ahead of the pre-existing
 *        cooldown/24h-duplicate guards. A failed send decrements the
 *        reservation back so it doesn't permanently eat into the day's cap.
 *
 *   C3 — GET /admin/crm/sent-log (src/routes/crm.ts): now additionally
 *        surfaces `sent_today` / `cap` / `remaining_today`, read from
 *        today's `outreach_daily_send_cap` row.
 *
 * Harness conventions (matching this repo's established patterns):
 *   - DB: a fresh in-memory RFB db via database/init's
 *     __setDbForTesting/__initSchemaForTesting (the shared getDb()
 *     singleton every route/service in this file reads), same convention as
 *     crm.test.ts / admin-run-verifier-drain-observability.test.ts /
 *     opplevelser-gardssalg-outreach-pilot-send.test.ts.
 *   - Email: emailService.sendRaw is mocked directly on the singleton
 *     instance (require.cache cleared for both '../services/email-service'
 *     and './crm' first, so crm.ts's static import binds to the SAME
 *     mocked instance this test controls — the require-cache-clear-then-
 *     patch-then-require-the-route-module order is exactly
 *     opplevelser-gardssalg-outreach-pilot-send.test.ts's convention for
 *     controlling the real send boundary from outside).
 *   - Router dispatch: router.handle(req, res, next) directly, no HTTP
 *     server — same convention as every route test in this repo.
 *   - Tail-registered into tests/test.ts's runSerial() chain (this suite
 *     swaps the shared DB singleton and mutates process.env).
 *
 * Exported runRfbPoolgateStegCTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-poolgate-stegc.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, any>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function runRfbPoolgateStegCTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevVerifyBatchSize = process.env.VERIFY_BATCH_SIZE;
    const prevOutreachMaxPerDay = process.env.OUTREACH_MAX_PER_DAY;
    const prevOutreachCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const prevOutreachPaused = process.env.OUTREACH_PAUSED;
    const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-poolgate-stegc";

    const db = new Database(":memory:");

    const emailPath = require.resolve("../services/email-service");
    const crmPath = require.resolve("./crm");
    const runVerifierPath = require.resolve("./admin-run-verifier");
    const cachePaths = [emailPath, crmPath, runVerifierPath];
    for (const p of cachePaths) delete require.cache[p];

    let emailSvc: any = null;
    let sendCalls: Array<Record<string, any>> = [];
    let sendMode: "success" | "fail" = "success";

    try {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.OUTREACH_PAUSED;
      process.env.OUTREACH_COOLDOWN_DAYS = "60";
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      emailSvc = emailMod.emailService as any;
      emailSvc.sendRaw = async (_options: any) => {
        sendCalls.push(_options);
        if (sendMode === "fail") return { success: false, error: "mock failure" };
        return { success: true, messageId: `mock-${sendCalls.length}` };
      };

      const crmRouter = (require("./crm") as typeof import("./crm")).default as any;
      const runVerifierRouter = (require("./admin-run-verifier") as any).default as any;

      // ═══════════════════════════════════════════════════════════════
      // C1 — VERIFY_BATCH_SIZE default for POST /admin/run-verifier
      // ═══════════════════════════════════════════════════════════════
      //
      // Seed a large pool of pickable agents (verification_status
      // 'unverified', no website => no live HTTP fetch, last_verified_at
      // NULL => picked first by pickBatch's oldest-first ordering). Every
      // round below passes bias_growth=0 so the plain pickBatch() picker is
      // used (any non-opt_out status, oldest last_verified_at first) —
      // avoids pickBatchBiased's 70/30 status-quota complexity, which is
      // orthogonal to what this test is about (batchSize resolution, not
      // pick-strategy). force=1 bypasses the 22:00-06:00 UTC night-window
      // gate so this test is time-of-day-independent.
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'unverified')`,
      );
      // 30 (default) + 15 (env) + 7 (explicit-over-env) + 100 (clamped) +
      // 30 (default again, env unset) = 182. Seed a comfortable margin.
      const STEGC1_POOL = 220;
      for (let i = 0; i < STEGC1_POOL; i++) {
        const id = `stegc1-agent-${i}`;
        insertAgent.run(id, `Stegc1 Gard ${i}`, `key-${id}`);
        insertKnowledge.run(id, "Testveien 1, 1400 Ski", "91234567", "info@gmail.com", "Kort tekst.", "[]", JSON.stringify({}));
      }

      // (a) No batchSize, no VERIFY_BATCH_SIZE -> default 30 (unchanged).
      delete process.env.VERIFY_BATCH_SIZE;
      const r1 = await callRoute(runVerifierRouter, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: {},
      });
      assertEq(r1.status, 200, "c1-1: round 1 (no batchSize, no env) responds 200");
      assertEq(r1.body.processed, 30, "c1-2: no batchSize/no VERIFY_BATCH_SIZE -> default batchSize 30 (byte-identical to pre-change behavior)");

      // (b) VERIFY_BATCH_SIZE=15 set, no explicit batchSize -> 15.
      process.env.VERIFY_BATCH_SIZE = "15";
      const r2 = await callRoute(runVerifierRouter, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: {},
      });
      assertEq(r2.body.processed, 15, "c1-3: VERIFY_BATCH_SIZE=15, batchSize omitted -> used as default (15)");

      // (c) VERIFY_BATCH_SIZE=15 still set, explicit batchSize=7 -> explicit wins.
      const r3 = await callRoute(runVerifierRouter, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: { batchSize: 7 },
      });
      assertEq(r3.body.processed, 7, "c1-4: explicit body batchSize=7 wins over VERIFY_BATCH_SIZE=15");

      // (d) VERIFY_BATCH_SIZE=500 (out of [1,100] range), no explicit batchSize
      // -> still clamped to 100. Proves the clamp is unchanged/still enforced
      // against the ENV-sourced value, not just the literal/explicit ones.
      process.env.VERIFY_BATCH_SIZE = "500";
      const r4 = await callRoute(runVerifierRouter, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: {},
      });
      assertEq(r4.body.processed, 100, "c1-5: VERIFY_BATCH_SIZE=500 (out of range) still clamps to 100");

      // (e) VERIFY_BATCH_SIZE unset again -> default stays 30 (re-read fresh
      // per request, not cached/sticky from an earlier round).
      delete process.env.VERIFY_BATCH_SIZE;
      const r5 = await callRoute(runVerifierRouter, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: {},
      });
      assertEq(r5.body.processed, 30, "c1-6: VERIFY_BATCH_SIZE unset again -> default 30 (env re-read per request, no stickiness)");

      // (f) Explicit batchSize alone (no env) still clamps to [1,100] as before.
      const r6 = await callRoute(runVerifierRouter, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: { batchSize: 250 },
      });
      assertEq(r6.body.processed, 100, "c1-7: explicit batchSize=250 (no env) still clamps to 100 — [1,100] ceiling untouched");

      delete process.env.VERIFY_BATCH_SIZE;

      // ═══════════════════════════════════════════════════════════════
      // C2 — daily send-cap guard for POST /admin/crm/compose
      // ═══════════════════════════════════════════════════════════════

      function baseComposeBody(overrides: Record<string, any> = {}): Record<string, any> {
        return {
          to: "post@stegc2-fixture.no",
          subject: "Test",
          bodyText: "Hei, dette er en test.",
          intent: "resend_send",
          createdBy: "claude",
          vertical: "rfb",
          ...overrides,
        };
      }

      function capRow(day: string): { reserved_count: number } | undefined {
        return db.prepare(`SELECT reserved_count FROM outreach_daily_send_cap WHERE day = ?`).get(day) as any;
      }

      // ── (2) cap already reached -> 429, sendRaw NOT called ──────────────
      {
        process.env.OUTREACH_MAX_PER_DAY = "2";
        const today = todayUTC();
        db.prepare(
          `INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 2)
             ON CONFLICT(day) DO UPDATE SET reserved_count = 2`,
        ).run(today);
        sendCalls = [];
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-cap-reached.no" }),
        });
        assertEq(res.status, 429, "c2-1: cap already at OUTREACH_MAX_PER_DAY -> 429");
        assertEq(res.body.success, false, "c2-2: success=false");
        assertEq(res.body.error, "daily_cap_reached", "c2-3: error='daily_cap_reached'");
        assertTrue(String(res.body.reason || "").includes("2"), "c2-4: reason includes the cap number (2)");
        assertEq(res.body.cap, 2, "c2-5: cap field reflects OUTREACH_MAX_PER_DAY=2");
        assertEq(sendCalls.length, 0, "c2-6: emailService.sendRaw was NOT called");
        assertEq(capRow(today)?.reserved_count, 2, "c2-7: reserved_count untouched by the rejected attempt (still 2, not incremented)");
      }

      // ── (3) sequential reservations against cap=1: first succeeds, second
      // fails to reserve — proves the WHERE-guarded UPSERT actually refuses
      // a second reservation once the cap is hit. ─────────────────────────
      {
        process.env.OUTREACH_MAX_PER_DAY = "1";
        // Fresh "day" bucket for this sub-test: delete any row for today so
        // this scenario starts from an empty cap.
        db.prepare(`DELETE FROM outreach_daily_send_cap WHERE day = ?`).run(todayUTC());
        sendMode = "success";
        sendCalls = [];

        const first = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-cap1-first.no" }),
        });
        assertEq(first.status, 200, "c2-8: first send under cap=1 succeeds (200)");
        assertEq(sendCalls.length, 1, "c2-9: sendRaw called exactly once for the first send");
        assertEq(capRow(todayUTC())?.reserved_count, 1, "c2-10: reserved_count is 1 after the first reservation");

        const second = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-cap1-second.no" }),
        });
        assertEq(second.status, 429, "c2-11: second send against the same cap=1 day -> 429 (WHERE-guarded UPSERT refuses)");
        assertEq(second.body.error, "daily_cap_reached", "c2-12: second send error='daily_cap_reached'");
        assertEq(sendCalls.length, 1, "c2-13: sendRaw still called only once — the second attempt never reached the send boundary");
        assertEq(capRow(todayUTC())?.reserved_count, 1, "c2-14: reserved_count stays at 1 (the failed reservation attempt didn't increment it)");
      }

      // ── (4) a failed sendRaw decrements reserved_count, and a following
      // call the same day can reserve again. ──────────────────────────────
      {
        process.env.OUTREACH_MAX_PER_DAY = "1";
        db.prepare(`DELETE FROM outreach_daily_send_cap WHERE day = ?`).run(todayUTC());
        sendMode = "fail";
        sendCalls = [];

        const failedSend = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-failcompensate.no" }),
        });
        assertEq(failedSend.status, 500, "c2-15: mocked sendRaw failure -> 500 (unchanged existing failure-path status)");
        assertEq(sendCalls.length, 1, "c2-16: sendRaw WAS attempted (reservation succeeded first)");
        assertEq(capRow(todayUTC())?.reserved_count, 0, "c2-17: reserved_count decremented back to 0 after the failed send — the failed attempt does not permanently eat the cap");

        sendMode = "success";
        const retrySend = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-failcompensate.no" }),
        });
        assertEq(retrySend.status, 200, "c2-18: a following call the SAME day can reserve again after the compensating decrement -> 200");
        assertEq(capRow(todayUTC())?.reserved_count, 1, "c2-19: reserved_count is back to 1 after the successful retry");
      }

      // ── (5) force:true + createdBy:'daniel' bypasses the cap entirely ──
      {
        process.env.OUTREACH_MAX_PER_DAY = "1";
        const today = todayUTC();
        db.prepare(
          `INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 1)
             ON CONFLICT(day) DO UPDATE SET reserved_count = 1`,
        ).run(today);
        sendMode = "success";
        sendCalls = [];

        const bypass = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-bypass.no", createdBy: "daniel", force: true }),
        });
        assertEq(bypass.status, 200, "c2-20: createdBy=daniel + force=true bypasses the cap even though today's cap is already reached (200, not 429)");
        assertEq(sendCalls.length, 1, "c2-21: sendRaw WAS called — the send is not blocked by the cap for this override combo");
        assertEq(capRow(today)?.reserved_count, 1, "c2-22: reserved_count stays at 1 — no reservation was attempted for the bypassed call");
      }

      // ── (6) non-resend_send intent, or non-claude createdBy, unaffected ──
      {
        process.env.OUTREACH_MAX_PER_DAY = "1";
        const today = todayUTC();
        db.prepare(
          `INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 1)
             ON CONFLICT(day) DO UPDATE SET reserved_count = 1`,
        ).run(today);
        sendCalls = [];

        // (6a) gmail_draft/claude: never reaches the send boundary at all
        // (gmail_draft path doesn't call sendRaw), and must not be blocked
        // by the cap either.
        const draft = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-gmaildraft.no", intent: "gmail_draft" }),
        });
        assertEq(draft.status, 200, "c2-23: gmail_draft/claude is not blocked by the cap even though today's cap is reached");
        assertEq(capRow(today)?.reserved_count, 1, "c2-24: gmail_draft does not touch reserved_count");

        // (6b) resend_send/daniel (no force): bypass condition is
        // createdBy==='claude' — createdBy='daniel' alone already skips the
        // whole guarded block, force or not.
        const daniel = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: "post@stegc2-danielsend.no", createdBy: "daniel" }),
        });
        assertEq(daniel.status, 200, "c2-25: resend_send/createdBy=daniel (no force) is not blocked by the cap");
        assertEq(capRow(today)?.reserved_count, 1, "c2-26: createdBy=daniel send does not touch reserved_count either");
      }

      // ═══════════════════════════════════════════════════════════════
      // C3 — GET /admin/crm/sent-log surfaces sent_today/cap/remaining_today
      // ═══════════════════════════════════════════════════════════════
      {
        process.env.OUTREACH_MAX_PER_DAY = "10";
        const today = todayUTC();
        db.prepare(
          `INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 4)
             ON CONFLICT(day) DO UPDATE SET reserved_count = 4`,
        ).run(today);

        const sentLog = await callRoute(crmRouter, {
          method: "GET",
          url: "/sent-log",
          headers: { "x-admin-key": ADMIN_KEY },
          query: {},
        });
        assertEq(sentLog.status, 200, "c3-1: GET /sent-log responds 200");
        assertEq(sentLog.body.sent_today, 4, "c3-2: sent_today reflects today's outreach_daily_send_cap.reserved_count (4)");
        assertEq(sentLog.body.cap, 10, "c3-3: cap reflects OUTREACH_MAX_PER_DAY=10");
        assertEq(sentLog.body.remaining_today, 6, "c3-4: remaining_today = cap - sent_today = 6");
        assertTrue(Array.isArray(sentLog.body.messages), "c3-5: existing `messages` field is still present (purely additive change)");
        assertEq(sentLog.body.success, true, "c3-6: existing `success` field unchanged");

        // No row yet for a day with zero sends -> sent_today falls back to 0.
        db.prepare(`DELETE FROM outreach_daily_send_cap WHERE day = ?`).run(today);
        const sentLogEmpty = await callRoute(crmRouter, {
          method: "GET",
          url: "/sent-log",
          headers: { "x-admin-key": ADMIN_KEY },
          query: {},
        });
        assertEq(sentLogEmpty.body.sent_today, 0, "c3-7: no outreach_daily_send_cap row for today -> sent_today falls back to 0");
        assertEq(sentLogEmpty.body.remaining_today, 10, "c3-8: remaining_today = cap (10) when sent_today is 0");
      }
    } catch (err: any) {
      failed++;
      failures.push(
        "rfb-poolgate-stegc: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevVerifyBatchSize === undefined) delete process.env.VERIFY_BATCH_SIZE; else process.env.VERIFY_BATCH_SIZE = prevVerifyBatchSize;
      if (prevOutreachMaxPerDay === undefined) delete process.env.OUTREACH_MAX_PER_DAY; else process.env.OUTREACH_MAX_PER_DAY = prevOutreachMaxPerDay;
      if (prevOutreachCooldownDays === undefined) delete process.env.OUTREACH_COOLDOWN_DAYS; else process.env.OUTREACH_COOLDOWN_DAYS = prevOutreachCooldownDays;
      if (prevOutreachPaused === undefined) delete process.env.OUTREACH_PAUSED; else process.env.OUTREACH_PAUSED = prevOutreachPaused;
      if (prevDb) initMod.__setDbForTesting(prevDb);
      for (const p of cachePaths) delete require.cache[p];
      try { db.close(); } catch { /* best-effort */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runRfbPoolgateStegCTests({ log: true }).then((r) => {
    console.log(`\nrfb-poolgate-stegc: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

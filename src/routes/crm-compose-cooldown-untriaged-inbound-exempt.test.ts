/**
 * crm-compose-cooldown-untriaged-inbound-exempt.test.ts — regression tests
 * for dev-request 2026-09-07-compose-cooldown-suppressed-blokkerer-cs-svar-
 * outreach (slookisen/A2A), the live "Kollerud" incident.
 *
 * Root cause (src/routes/crm.ts, POST /admin/crm/compose): the
 * `hasRecentInbound` guard that exempts a reply from the cold-outreach
 * cooldown/rate-limit block reads ONLY `crm_messages` (joined through
 * crm_threads/crm_contacts). A reply delivered directly to Daniel's
 * personal inbox — not via a recognized platform alias, e.g. forwarded, or
 * answered from an address the sender typed by hand instead of hitting
 * Reply — fails deriveVertical()'s header match in POST /admin/crm/ingest
 * and is routed to `parkUntriaged()` (crm-triage.ts) instead of through
 * `crmService.ingestThread()`. parkUntriaged() ONLY inserts into
 * crm_untriaged (see database/init.ts's crm_untriaged table comment) — it
 * never writes crm_messages/crm_threads/crm_contacts. So a genuine reply
 * that lands as `202 untriaged` is structurally invisible to
 * hasRecentInbound's crm_messages-only query, no matter how its join or
 * lookback window is tuned — the row it needs was never written.
 *
 * This is exactly what happened live on 2026-09-07: elinkollerud@hotmail.com
 * replied on the platform's own outreach thread (compose-936fd748…) at
 * 09:06Z — forwarded straight to Daniel's personal inbox — after an
 * outbound send at 08:22Z the same day. POST /admin/crm/ingest parked the
 * reply 202 untriaged. The subsequent POST /admin/crm/compose
 * (intent:"resend_send") reply attempt was then wrongly rejected
 * `cooldown_suppressed` even though the contact had unmistakably been in
 * touch since the last outbound. A second attempt via
 * POST /admin/crm/threads/:id/send succeeded (a different code path that
 * does not use hasRecentInbound at all).
 *
 * Fix: /compose now ALSO treats a recent (same 7-day window, same
 * case-insensitive email match) crm_untriaged row for the recipient as
 * evidence of "this contact is mid-conversation with us" — exactly as
 * strong a signal as a routed crm_messages inbound row, just not yet
 * triaged to a thread. Purely additive: it can only turn a false 429 into a
 * correct 200. A contact with NEITHER a crm_messages inbound NOR a
 * crm_untriaged row (a genuine, unsolicited repeat cold-send) is unaffected
 * and still falls through to cooldown_suppressed.
 *
 * Covers:
 *   (1) Kollerud-shaped repro: outreach_sent_log entry (same-day, within the
 *       60-day cooldown) + a matching crm_untriaged row created AFTER that
 *       send, NO crm_messages inbound row -> POST /compose
 *       (intent:"resend_send") now succeeds (200), was 429
 *       cooldown_suppressed before this fix.
 *   (2) Regression guard (Acceptance Criterion 2, non-goal): a genuine
 *       repeat cold-send — outreach_sent_log entry, NO crm_messages inbound,
 *       NO crm_untriaged row at all for the address — is still correctly
 *       rejected 429 cooldown_suppressed. No weakening of the cooldown's
 *       real purpose.
 *   (3) Targeted root-cause regression: a crm_untriaged row exists for the
 *       address but OUTSIDE the 7-day lookback window -> still rejected
 *       429 cooldown_suppressed (the fix respects the existing window, it
 *       does not blindly trust any untriaged row ever seen).
 *   (4) crm_untriaged.from_email matched case-insensitively, mirroring the
 *       existing LOWER(c.email)/LOWER(from_email) convention used
 *       throughout this guard.
 *   (5) Isolation: a crm_untriaged row for a DIFFERENT recipient email does
 *       not exempt this contact's cooldown check.
 *
 * Harness conventions (matching this repo's established patterns — see
 * rfb-poolgate-stegc.test.ts and crm-max-touch-vern-send-guard.test.ts):
 *   - DB: fresh in-memory db via database/init's
 *     __setDbForTesting/__initSchemaForTesting.
 *   - Email: emailService.sendRaw mocked directly on the singleton instance
 *     (require.cache cleared for both '../services/email-service' and
 *     './crm' before re-requiring, so crm.ts's static import binds to the
 *     SAME mocked instance).
 *   - Router dispatch: router.handle(req, res, next) directly, no HTTP
 *     server.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/crm-compose-cooldown-untriaged-inbound-exempt.test.ts
 *   2. Wired into the gate via tests/test.ts.
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
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: {},
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

export function runCrmComposeCooldownUntriagedInboundExemptTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevOutreachCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const prevOutreachMaxPerDay = process.env.OUTREACH_MAX_PER_DAY;
    const prevOutreachPaused = process.env.OUTREACH_PAUSED;
    const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-compose-untriaged-exempt";

    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");

    const emailPath = require.resolve("../services/email-service");
    const crmPath = require.resolve("./crm");
    const cachePaths = [emailPath, crmPath];
    for (const p of cachePaths) delete require.cache[p];

    let sendCalls: Array<Record<string, any>> = [];

    try {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.OUTREACH_PAUSED;
      process.env.OUTREACH_COOLDOWN_DAYS = "60";
      delete process.env.OUTREACH_MAX_PER_DAY; // default (50) is plenty for this suite
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const emailSvc = emailMod.emailService as any;
      emailSvc.sendRaw = async (_options: any) => {
        sendCalls.push(_options);
        return { success: true, messageId: `mock-${sendCalls.length}` };
      };

      const crmRouter = (require("./crm") as typeof import("./crm")).default as any;

      function baseComposeBody(overrides: Record<string, any> = {}): Record<string, any> {
        return {
          to: "elin@kollerud-test.no",
          subject: "Kollerud Gård — Hemnes: takk, og velkommen som verifisert eier",
          bodyText: "Hei, tusen takk for at du tok eierskap til siden.",
          intent: "resend_send",
          createdBy: "claude",
          vertical: "rfb",
          ...overrides,
        };
      }

      // Prior cold outreach send, same-day, well within the 60-day cooldown —
      // mirrors the real Kollerud batch send (outreach_sent_log, email-keyed).
      function insertPriorOutreach(email: string, hoursAgo: number): void {
        db.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior-outreach', 'rfb')`,
        ).run(`agent-${email}`, email.toLowerCase(), `-${hoursAgo} hours`, `msg-${email}`);
      }

      // A reply that landed as 202 untriaged — parkUntriaged()'s actual
      // write shape (crm_untriaged only, no crm_messages/crm_threads row).
      function insertUntriaged(id: string, fromEmail: string, hoursAgo: number): void {
        db.prepare(
          `INSERT INTO crm_untriaged (id, thread_id, from_email, subject, snippet, reason, signals, raw_payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', datetime('now', ?))`,
        ).run(
          id,
          `gmail-thread-${id}`,
          fromEmail,
          "Fw: Profil-utkast for Kollerud Gård — Hemnes",
          "Jeg har nå tatt eierskap til siden…",
          "test:direct-to-personal-inbox",
          `-${hoursAgo} hours`,
        );
      }

      // ══ (1) Kollerud repro: prior outreach + recent untriaged reply,
      // NO crm_messages inbound row -> /compose succeeds directly ═══════════
      {
        const email = "elin@kollerud-test.no";
        insertPriorOutreach(email, 2); // sent 2h ago (like the 08:22Z send)
        insertUntriaged("untri-kollerud", email, 1); // parked 1h ago (like the 09:06Z reply, AFTER the send)
        sendCalls = [];

        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: email }),
        });

        assertEq(res.status, 200, "1a: Kollerud-shaped repro -> /compose succeeds (200), not 429");
        assertEq(res.body?.success, true, "1b: success:true");
        assertEq(res.body?.channel, "resend_smtp", "1c: channel:resend_smtp (actually sent, not just queued)");
        assertEq(sendCalls.length, 1, "1d: emailService.sendRaw WAS called — the send actually went through");
      }

      // ══ (2) Regression guard: genuine repeat cold-send, no inbound
      // anywhere (no crm_messages, no crm_untriaged) -> still rejected ═════
      {
        const email = "genuine-repeat-cold-send@kollerud-test.no";
        insertPriorOutreach(email, 3);
        sendCalls = [];

        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: email }),
        });

        assertEq(res.status, 429, "2a: genuine repeat cold-send with zero inbound signal -> still 429");
        assertEq(res.body?.error, "cooldown_suppressed", "2b: error:cooldown_suppressed (no regression on the cooldown's real purpose)");
        assertEq(sendCalls.length, 0, "2c: emailService.sendRaw was NOT called");
      }

      // ══ (3) Targeted root-cause regression: crm_untriaged row exists but
      // is OUTSIDE the 7-day lookback -> still rejected (window respected) ═
      {
        const email = "stale-untriaged@kollerud-test.no";
        insertPriorOutreach(email, 4);
        insertUntriaged("untri-stale", email, 24 * 10); // 10 days ago -> outside the 7-day window
        sendCalls = [];

        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: email }),
        });

        assertEq(res.status, 429, "3a: crm_untriaged row older than 7 days does NOT exempt -> still 429");
        assertEq(res.body?.error, "cooldown_suppressed", "3b: error:cooldown_suppressed");
      }

      // ══ (4) Case-insensitive email match on crm_untriaged.from_email ════
      {
        const email = "casing@kollerud-test.no";
        insertPriorOutreach(email, 2);
        insertUntriaged("untri-casing", "CASING@Kollerud-Test.NO", 1);
        sendCalls = [];

        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: email }),
        });

        assertEq(res.status, 200, "4a: crm_untriaged.from_email matched case-insensitively -> /compose succeeds");
      }

      // ══ (5) Isolation: an untriaged row for a DIFFERENT recipient does
      // not exempt THIS contact's cooldown check ══════════════════════════
      {
        const email = "isolated@kollerud-test.no";
        insertPriorOutreach(email, 2);
        insertUntriaged("untri-other", "someone-else@kollerud-test.no", 1);
        sendCalls = [];

        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/compose",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseComposeBody({ to: email }),
        });

        assertEq(res.status, 429, "5a: an untriaged row for a different email does not exempt this contact -> still 429");
        assertEq(res.body?.error, "cooldown_suppressed", "5b: error:cooldown_suppressed");
      }
    } catch (err: any) {
      failed++;
      failures.push(
        "crm-compose-cooldown-untriaged-inbound-exempt: unexpected error: " +
          String(err?.stack || err?.message || err),
      );
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevOutreachCooldownDays === undefined) delete process.env.OUTREACH_COOLDOWN_DAYS; else process.env.OUTREACH_COOLDOWN_DAYS = prevOutreachCooldownDays;
      if (prevOutreachMaxPerDay === undefined) delete process.env.OUTREACH_MAX_PER_DAY; else process.env.OUTREACH_MAX_PER_DAY = prevOutreachMaxPerDay;
      if (prevOutreachPaused === undefined) delete process.env.OUTREACH_PAUSED; else process.env.OUTREACH_PAUSED = prevOutreachPaused;
      if (prevDb) initMod.__setDbForTesting(prevDb);
      for (const p of cachePaths) delete require.cache[p];
      try { db.close(); } catch { /* best-effort */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmComposeCooldownUntriagedInboundExemptTests({ log: true }).then((r) => {
    console.log(`\ncrm-compose-cooldown-untriaged-inbound-exempt: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

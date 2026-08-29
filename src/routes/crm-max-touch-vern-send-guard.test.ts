/**
 * crm-max-touch-vern-send-guard.test.ts — regression pins for dev-request
 * 2026-08-29-outreach-max-touch-vern's Part B: the send-time invariant on
 * BOTH POST /admin/crm/threads/:id/send and POST /admin/crm/compose
 * (src/routes/crm.ts).
 *
 * "Can't cause spam" — an address with >= threshold prior outreach_sent_log
 * rows (any vertical) and ZERO inbound messages ever must be refused at
 * send time, unconditionally: regardless of intent (resend_send/
 * gmail_draft), createdBy (claude/daniel), or force. Unlike the existing
 * hard-cooldown/daily-cap checks, there is no override — this is checked
 * BEFORE those bypassable guards, mirroring the branding-lint's
 * unconditional placement in /threads/:id/send.
 *
 * Covers:
 *   (1) /compose: 3 prior sends + 0 inbound -> 429 max_touch_suppressed,
 *       carrying send_count/threshold/last_sent_at.
 *   (2) /compose: force:true + createdBy:'daniel' does NOT bypass it (the
 *       "no override" property that distinguishes it from cooldown_suppressed).
 *   (3) /compose boundary: 3 prior sends + 1 inbound reply -> NOT suppressed,
 *       the send proceeds (gmail_draft, no SMTP needed).
 *   (4) /compose: 2 prior sends (below default threshold 3) -> NOT suppressed.
 *   (5) /threads/:id/send: 3 prior sends + 0 inbound -> 429
 *       max_touch_suppressed, checked BEFORE the double-send guard.
 *   (6) /threads/:id/send: a multi-recipient toEmails where only the SECOND
 *       address is suppressed still refuses the whole send.
 *   (7) the send-count log itself is never touched by a refusal or by an
 *       inbound reply arriving (no delete/reset) — outreach_sent_log row
 *       count is unchanged across the whole test.
 *
 * Mirrors crm.test.ts's harness (fresh require of ./crm per env mutation,
 * router.handle() exercised directly, in-memory DB via __setDbForTesting +
 * __initSchemaForTesting) and admin-crm-chimera-agent-clear.test.ts's
 * callRoute() (method/url/body/headers, Promise-resolving on res.json/end).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/crm-max-touch-vern-send-guard.test.ts
 *   2. Wired into the gate: tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      // else: unmatched route — leave the promise pending is wrong for a
      // never-resolving test, but every route this suite calls exists, so a
      // fall-through here would be a genuine bug worth seeing as a timeout.
    });
  });
}

export async function runCrmMaxTouchVernSendGuardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const testKey = "crm-max-touch-vern-send-guard-test-key";

  function insertPriorContacts(email: string, count: number, daysAgoStart: number): void {
    for (let i = 0; i < count; i++) {
      testDb
        .prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior', 'rfb')`,
        )
        .run(`agent-${email}`, email.toLowerCase(), `-${daysAgoStart + i} days`, `msg-${email}-${i}`);
    }
  }

  function insertInboundReply(email: string): { contactId: string; threadId: string } {
    const contactId = `c-${email}`;
    const threadId = `thread-${email}`;
    testDb
      .prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run(contactId, "producer", null, email, email);
    testDb
      .prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to, vertical_id)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(threadId, contactId, "Svar", "innkommende", "in_progress", "claude", "rfb");
    testDb
      .prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, received_at, delivery_status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`m-${email}-in`, threadId, "in", email, JSON.stringify(["kontakt@rettfrabonden.com"]), "Svar", "hei", "2026-05-01T00:00:00Z", "sent");
    return { contactId, threadId };
  }

  // A thread with NO inbound at all — used for /threads/:id/send fixtures
  // (that route sends against an EXISTING thread; max-touch-vern is keyed on
  // the recipient email, not thread history, so the thread itself carries no
  // reply even though the address being suppressed is checked independently).
  function insertOutboundOnlyThread(threadId: string, contactEmail: string): string {
    const contactId = `c-${threadId}`;
    testDb
      .prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run(contactId, "producer", null, contactEmail, contactEmail);
    testDb
      .prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to, vertical_id)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(threadId, contactId, "Hei", "innkommende", "new", "claude", "rfb");
    return contactId;
  }

  try {
    __setDbForTesting(testDb);
    __initSchemaForTesting(testDb);
    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const routePath = require.resolve("./crm");
    delete require.cache[routePath];

    function freshRouter(): any {
      delete require.cache[routePath];
      return (require("./crm") as typeof import("./crm")).default as any;
    }

    // ── fixtures ──────────────────────────────────────────────────────────
    insertPriorContacts("suppressed@mtv-send-test.no", 3, 100);
    insertPriorContacts("replied@mtv-send-test.no", 3, 100);
    insertInboundReply("replied@mtv-send-test.no");
    insertPriorContacts("below@mtv-send-test.no", 2, 100);
    // Distinct addresses for the /threads/:id/send fixtures below — each
    // /compose call above (intent:gmail_draft, once past the max-touch-vern
    // check) auto-creates a crm_contacts row for its `to` address via
    // composeNewThread(), so reusing those same addresses for a MANUALLY
    // inserted crm_contacts row here would collide on the (email,
    // vertical_id) unique constraint. Address-based suppression doesn't care
    // which literal address is used, so fresh ones prove the same thing.
    insertPriorContacts("suppressed-thread@mtv-send-test.no", 3, 100);

    const beforeLogCount = (testDb.prepare(`SELECT COUNT(*) n FROM outreach_sent_log`).get() as any).n;

    // ══ (1) /compose: 3 sends + 0 inbound -> 429 max_touch_suppressed ═════
    {
      const router = freshRouter();
      const res = await callRoute(router, {
        method: "POST",
        url: "/compose",
        headers: { "x-admin-key": testKey },
        body: {
          to: "suppressed@mtv-send-test.no",
          subject: "Hei fra Rett fra Bonden",
          bodyText: "Hei!",
          intent: "gmail_draft",
          createdBy: "claude",
          vertical: "rfb",
        },
      });
      assertEq(res.status, 429, "1a: /compose to a 3-sends/0-inbound address -> 429");
      assertEq(res.body?.error, "max_touch_suppressed", "1b: error:max_touch_suppressed");
      assertEq(res.body?.send_count, 3, "1c: send_count:3 in the refusal body");
      assertEq(res.body?.threshold, 3, "1d: threshold:3 in the refusal body");
      assertEq(typeof res.body?.last_sent_at, "string", "1e: last_sent_at is present");
    }

    // ══ (2) /compose: force:true + createdBy:'daniel' does NOT bypass ═════
    {
      const router = freshRouter();
      const res = await callRoute(router, {
        method: "POST",
        url: "/compose",
        headers: { "x-admin-key": testKey },
        body: {
          to: "suppressed@mtv-send-test.no",
          subject: "Hei fra Rett fra Bonden",
          bodyText: "Hei!",
          intent: "gmail_draft",
          createdBy: "daniel",
          force: true,
          vertical: "rfb",
        },
      });
      assertEq(res.status, 429, "2a: force:true + createdBy:'daniel' still -> 429 (no override, unlike cooldown)");
      assertEq(res.body?.error, "max_touch_suppressed", "2b: error:max_touch_suppressed even with force:true");
    }

    // ══ (3) /compose boundary: 3 sends + 1 inbound reply -> NOT suppressed ═
    {
      const router = freshRouter();
      const res = await callRoute(router, {
        method: "POST",
        url: "/compose",
        headers: { "x-admin-key": testKey },
        body: {
          to: "replied@mtv-send-test.no",
          subject: "Oppfølging",
          bodyText: "Hei igjen!",
          intent: "gmail_draft",
          createdBy: "claude",
          vertical: "rfb",
        },
      });
      assertEq(res.status, 200, "3a: 3 sends + 1 inbound reply -> compose succeeds (200), NOT max_touch_suppressed");
      assertEq(res.body?.success, true, "3b: success:true");
    }

    // ══ (4) /compose: 2 sends (below threshold) -> NOT suppressed ═════════
    {
      const router = freshRouter();
      const res = await callRoute(router, {
        method: "POST",
        url: "/compose",
        headers: { "x-admin-key": testKey },
        body: {
          to: "below@mtv-send-test.no",
          subject: "Hei",
          bodyText: "Hei!",
          intent: "gmail_draft",
          createdBy: "claude",
          vertical: "rfb",
        },
      });
      assertEq(res.status, 200, "4a: 2 prior sends (below threshold 3) -> compose succeeds (200)");
    }

    // ══ (5) /threads/:id/send: 3 sends + 0 inbound -> 429 ═════════════════
    {
      insertOutboundOnlyThread("thread-mtv-send-1", "suppressed-thread@mtv-send-test.no");
      const router = freshRouter();
      const res = await callRoute(router, {
        method: "POST",
        url: "/threads/thread-mtv-send-1/send",
        headers: { "x-admin-key": testKey },
        body: {
          intent: "gmail_draft",
          toEmails: ["suppressed-thread@mtv-send-test.no"],
          subject: "Oppfølging",
          bodyText: "Hei!",
          createdBy: "claude",
        },
      });
      assertEq(res.status, 429, "5a: /threads/:id/send to a 3-sends/0-inbound address -> 429");
      assertEq(res.body?.error, "max_touch_suppressed", "5b: error:max_touch_suppressed");
      assertEq(res.body?.send_count, 3, "5c: send_count:3 in the refusal body");
    }

    // ══ (6) /threads/:id/send: SECOND recipient suppressed -> whole send refused ═
    {
      insertOutboundOnlyThread("thread-mtv-send-2", "clean-thread@mtv-send-test.no");
      const router = freshRouter();
      const res = await callRoute(router, {
        method: "POST",
        url: "/threads/thread-mtv-send-2/send",
        headers: { "x-admin-key": testKey },
        body: {
          intent: "gmail_draft",
          toEmails: ["clean-thread@mtv-send-test.no", "suppressed-thread@mtv-send-test.no"],
          subject: "Oppfølging",
          bodyText: "Hei!",
          createdBy: "claude",
        },
      });
      assertEq(res.status, 429, "6a: a multi-recipient send with ONE suppressed address is refused entirely");
      assertEq(res.body?.error, "max_touch_suppressed", "6b: error:max_touch_suppressed");
      assertEq(res.body?.to, "suppressed-thread@mtv-send-test.no", "6c: refusal names the suppressed address specifically");
    }

    // ══ (7) send-count log is never touched (no delete/reset) ════════════
    const afterLogCount = (testDb.prepare(`SELECT COUNT(*) n FROM outreach_sent_log`).get() as any).n;
    assertEq(
      afterLogCount,
      beforeLogCount,
      "7a: outreach_sent_log row count unchanged by refusals, successful sends, or the inbound reply — read-only check",
    );
  } catch (err) {
    failed++;
    failures.push(`crm-max-touch-vern-send-guard: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try {
      delete require.cache[require.resolve("./crm")];
    } catch {
      /* ignore */
    }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── crm max-touch-vern send guard (dev-request 2026-08-29-outreach-max-touch-vern) ──");
  runCrmMaxTouchVernSendGuardTests({ log: true }).then((r) => {
    console.log(`\ncrm-max-touch-vern-send-guard: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

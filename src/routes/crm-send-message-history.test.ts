/**
 * crm-send-message-history.test.ts — dev-request
 * 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk, skive 1.
 *
 * POST /threads/:id/send queued a crm_outbox row, sent (or drafted) the
 * message, and logged a crm_actions row — but never wrote a crm_messages
 * row. A thread that HAD been answered kept its pre-reply message_count and
 * looked unanswered to anyone reading the thread's message history,
 * including the CS-agent deciding whether a thread still needs a reply.
 *
 * Covers:
 *   m1-m4   a gmail_draft reply through the real route shows up as a
 *           crm_messages row (direction='out', delivery_status='queued')
 *           and grows the thread's message_count / last_message_at — this
 *           is the test that FAILS without the recordOutboundReply() fix.
 *   m5-m7   the double-send guard: an identical subject+body reply on the
 *           SAME thread within the window is hard-rejected (409) and does
 *           NOT create a second crm_messages row or grow message_count
 *           again; a genuinely DIFFERENT reply on the same thread is NOT
 *           blocked.
 *   m8-m9   a resend_send reply (stubbed transport) is recorded with
 *           delivery_status='sent' and a real sent_at.
 *   m10-m12 the crm_outbox backfill migration: a pre-existing
 *           status='completed' outbox row with no crm_messages row gets one
 *           on the next schema boot, idempotently (re-running the boot does
 *           not double-insert or double-count message_count).
 *
 * Standalone: npx tsx src/routes/crm-send-message-history.test.ts
 * Wired into tests/test.ts via runCrmSendMessageHistoryTests().
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runCrmSendMessageHistoryTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = initMod;

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  // adopt-ambient (see tests/test.ts's SHARED GLOBAL STATE contract): reuse
  // the suite's canonical ADMIN_KEY when present so concurrent runSerial
  // blocks never race on this process-global; fall back to a literal for
  // standalone runs.
  const adminKey = process.env.ADMIN_KEY || "crm-send-history-test-key";

  try {
    __setDbForTesting(db);
    __initSchemaForTesting(db);
    process.env.ADMIN_KEY = adminKey;
    process.env.ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || adminKey;

    const crmServiceMod = require("../services/crm-service") as typeof import("../services/crm-service");
    const { crmService } = crmServiceMod;

    const routePath = require.resolve("./crm");
    delete require.cache[routePath];
    const crmRoutes = require("./crm") as typeof import("./crm");
    const router = crmRoutes.default as any;

    function call(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
      const req: any = {
        method, url, query: {}, body,
        headers: { "x-admin-key": adminKey },
        get(n: string) { return this.headers[n.toLowerCase()]; },
      };
      return new Promise((resolve) => {
        const res: any = {
          statusCode: 200,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this.body = b; resolve({ status: this.statusCode, body: b }); return this; },
        };
        router.handle(req, res, () => resolve({ status: res.statusCode, body: res.body }));
      });
    }

    // ── Seed a contact + thread with one inbound message, the normal shape
    // of a thread this route replies to. ─────────────────────────────────
    const contact = crmService.resolveContact("kunde@example.no", "Kunde", "rfb");
    const threadId = "send-history-thread-1";
    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
      VALUES (?, ?, 'Spørsmål om levering', 'innkommende', 'normal', 'rfb', 1)
    `).run(threadId, contact.id);
    db.prepare(`
      INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
      VALUES ('inbound-1', ?, 'in', 'kunde@example.no', '[]', '[]', 'Spørsmål om levering', 'Når leveres bestillingen?', datetime('now','-1 hour'), 'sent', 'rfb')
    `).run(threadId);

    // ═══════════════════════════════════════════════════════════════
    // m1-m4 — gmail_draft reply shows up in the thread's message history.
    // THIS IS THE TEST THAT FAILS WITHOUT recordOutboundReply().
    // ═══════════════════════════════════════════════════════════════
    {
      const before = crmService.getThreadDetail(threadId) as any;
      assertEq(before.messages.length, 1, "m1: before the reply, the thread has exactly the seeded inbound message");
      assertEq(before.thread.message_count, 1, "m1b: …and message_count reads 1");

      const res = await call("POST", `/threads/${threadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["kunde@example.no"],
        subject: "Re: Spørsmål om levering",
        bodyText: "Bestillingen leveres torsdag.",
        createdBy: "daniel",
      });
      assertEq(res.status, 200, "m2: POST /threads/:id/send (gmail_draft) succeeds");
      assertTrue(typeof res.body?.internalMessageId === "string", "m2b: …and returns the new crm_messages id");

      const after = crmService.getThreadDetail(threadId) as any;
      assertEq(after.messages.length, 2, "m3: the reply is now a SECOND row in the thread's own message list — this is the bug this PR fixes");
      const reply = (after.messages as any[]).find((m) => m.direction === "out");
      assertTrue(!!reply, "m3b: …and it is the OUTBOUND message");
      assertEq(reply?.subject, "Re: Spørsmål om levering", "m3c: …with the subject actually sent");
      assertEq(reply?.body_text, "Bestillingen leveres torsdag.", "m3d: …and the body actually sent");
      assertEq(reply?.delivery_status, "queued", "m3e: gmail_draft is recorded as 'queued' — not yet confirmed sent");
      assertEq(after.thread.message_count, 2, "m4: message_count GREW from 1 to 2 — a thread that has been answered no longer looks unanswered");
    }

    // ═══════════════════════════════════════════════════════════════
    // m5-m7 — double-send guard: identical content is hard-rejected;
    // genuinely different content is not.
    // ═══════════════════════════════════════════════════════════════
    {
      const dup = await call("POST", `/threads/${threadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["kunde@example.no"],
        subject: "Re: Spørsmål om levering",
        bodyText: "Bestillingen leveres torsdag.",
        createdBy: "daniel",
      });
      assertEq(dup.status, 409, "m5: an IDENTICAL subject+body reply on the same thread, seconds later, is hard-rejected");
      assertEq(dup.body?.error, "duplicate_send", "m5b: …with the duplicate_send error code");

      const afterDup = crmService.getThreadDetail(threadId) as any;
      assertEq(afterDup.messages.length, 2, "m6: the rejected duplicate did NOT create a second crm_messages row");
      assertEq(afterDup.thread.message_count, 2, "m6b: …and message_count did not grow again");

      const distinct = await call("POST", `/threads/${threadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["kunde@example.no"],
        subject: "Re: Spørsmål om levering",
        bodyText: "Korrigering: bestillingen leveres fredag, ikke torsdag.",
        createdBy: "daniel",
      });
      assertEq(distinct.status, 200, "m7: a genuinely DIFFERENT reply on the same thread is NOT blocked by the guard");
      const afterDistinct = crmService.getThreadDetail(threadId) as any;
      assertEq(afterDistinct.thread.message_count, 3, "m7b: …and it grows message_count to 3");
    }

    // ═══════════════════════════════════════════════════════════════
    // m8-m9 — resend_send is recorded with delivery_status='sent'.
    // ═══════════════════════════════════════════════════════════════
    {
      const emailMod = require("../services/email-service") as any;
      const svc = emailMod.emailService;
      const realSendRaw = svc.sendRaw.bind(svc);
      svc.sendRaw = async () => ({ success: true, messageId: "stub-resend-1" });
      try {
        const res = await call("POST", `/threads/${threadId}/send`, {
          intent: "resend_send",
          toEmails: ["kunde@example.no"],
          subject: "Re: Spørsmål om levering (bekreftet)",
          bodyText: "Bekrefter: levering fredag.",
          createdBy: "daniel",
        });
        assertEq(res.status, 200, "m8: resend_send reaches the (stubbed) transport and succeeds");

        const after = crmService.getThreadDetail(threadId) as any;
        const sentMsg = (after.messages as any[]).find((m: any) => m.subject === "Re: Spørsmål om levering (bekreftet)");
        assertTrue(!!sentMsg, "m9: the resend_send reply is in the thread's message list");
        assertEq(sentMsg?.delivery_status, "sent", "m9b: …recorded as delivery_status='sent'");
        assertTrue(!!sentMsg?.sent_at, "m9c: …with a real sent_at (not null, unlike the queued gmail_draft rows above)");
      } finally {
        svc.sendRaw = realSendRaw;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // m10-m12 — the crm_outbox 'completed' -> crm_messages backfill.
    // ═══════════════════════════════════════════════════════════════
    {
      const backfillThreadId = "send-history-backfill-thread-1";
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
        VALUES (?, ?, 'Historisk sak', 'innkommende', 'normal', 'rfb', 1)
      `).run(backfillThreadId, contact.id);
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
        VALUES ('inbound-backfill-1', ?, 'in', 'kunde@example.no', '[]', '[]', 'Historisk sak', 'Gammel henvendelse', datetime('now','-3 days'), 'sent', 'rfb')
      `).run(backfillThreadId);
      // A historical outbox row from BEFORE this fix existed: completed, but
      // with no corresponding crm_messages row — exactly the gap skive 1.2
      // backfills.
      const outboxId = "outbox-backfill-1";
      db.prepare(`
        INSERT INTO crm_outbox (id, thread_id, contact_id, intent, status, to_emails, cc_emails, subject, body_text, result_id, created_at, processed_at, created_by, vertical_id)
        VALUES (?, ?, ?, 'resend_send', 'completed', ?, '[]', 'Re: Historisk sak', 'Historisk svar sendt.', 'resend-hist-1', datetime('now','-2 days'), datetime('now','-2 days'), 'daniel', 'rfb')
      `).run(outboxId, backfillThreadId, contact.id, JSON.stringify(["kunde@example.no"]));

      const beforeBackfill = crmService.getThreadDetail(backfillThreadId) as any;
      assertEq(beforeBackfill.messages.length, 1, "m10: before the migration runs, the historical outbox send is NOT in crm_messages");

      // The migration is gated by the `migrations` table so it runs exactly
      // once in production — and the very first __initSchemaForTesting(db)
      // call at the top of this test already consumed that gate (against a
      // DB with zero outbox rows, since none existed yet). Reset the gate
      // here to simulate the real production sequence: historical data
      // already in the DB, THEN the migration's first-ever run.
      db.prepare("DELETE FROM migrations WHERE name = 'backfill_outbox_completed_to_crm_messages_v1'").run();
      __initSchemaForTesting(db);

      const afterBackfill = crmService.getThreadDetail(backfillThreadId) as any;
      assertEq(afterBackfill.messages.length, 2, "m11: after the migration, the historical outbox send is promoted into crm_messages");
      const backfilled = (afterBackfill.messages as any[]).find((m: any) => m.direction === "out");
      assertTrue(!!backfilled, "m11b: …as an outbound message");
      assertEq(backfilled?.delivery_status, "sent", "m11c: …with delivery_status='sent' (intent was resend_send, status was completed)");
      assertEq(backfilled?.body_text, "Historisk svar sendt.", "m11d: …carrying the original outbox body");
      assertEq(afterBackfill.thread.message_count, 2, "m11e: …and message_count is recomputed to include it");

      // Idempotency: running the boot again must NOT double-insert.
      __initSchemaForTesting(db);
      const afterSecondBoot = crmService.getThreadDetail(backfillThreadId) as any;
      assertEq(afterSecondBoot.messages.length, 2, "m12: re-running the migration a second time does not create a duplicate row");
      assertEq(afterSecondBoot.thread.message_count, 2, "m12b: …or double-count message_count");
    }
  } catch (err) {
    failed++;
    failures.push(`crm-send-message-history: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./crm")]; } catch { /* ignore */ }
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── crm-send-message-history (dev-request 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk, skive 1) ──");
  runCrmSendMessageHistoryTests({ log: true }).then((r) => {
    console.log(`\ncrm-send-message-history: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

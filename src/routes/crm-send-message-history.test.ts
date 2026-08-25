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
 *   m13-m17 post-review bugfix — the double-send guard closes the RACE, not
 *           just the already-recorded case: two genuinely concurrent
 *           identical resend_send requests (fired back-to-back before
 *           either's first `await`, against a latency-stubbed transport)
 *           produce exactly one 200 and one 409, and only one crm_messages
 *           row / one message_count increment.
 *   m18-m24 post-review bugfix — /outbox/:id/result resolves the RIGHT
 *           message via the new crm_outbox.crm_message_id link once a
 *           thread has more than one outstanding queued reply: resolving
 *           the second-queued outbox item before the first updates the
 *           SECOND message, leaving the first untouched (not the
 *           "most recent" heuristic's wrong answer).
 *   m25-m30 post-review bugfix (iteration 2) — POST /compose's outbox row
 *           now links crm_message_id too: a /compose draft (message A,
 *           outbox O) followed by a distinct /threads/:id/send reply
 *           (message B) on the same thread, then POST /outbox/O/result,
 *           correctly resolves message A and leaves B untouched — before
 *           the fix, /compose's outbox row was never linked, so this fell
 *           through to the "most recent for thread" fallback and wrongly
 *           flipped B instead.
 *   m31-m35 dev-request 2026-08-17-cs-plattformparitet-og-verifisert-
 *           utfoerelse (Skive F), akseptansekriterium 9 — a subject that's
 *           empty after trim, or trims to exactly a reply/svar prefix
 *           ("Re:"/"Sv:", any case, with or without surrounding
 *           whitespace), is rejected 400 before any send is attempted, with
 *           no crm_messages/outbox side effects; a real subject (including
 *           "Re: faktisk oppfølging", which has content beyond the prefix)
 *           still succeeds.
 *   m36-m41 dev-request 2026-08-25-cs-outbox-result-mangler-superseded-
 *           status — POST /outbox/:id/result accepts status:"superseded"
 *           for a row whose case actually resolved via a different channel:
 *           it leaves the pending queue without ever being recorded as
 *           "completed", and the linked crm_messages row is left untouched
 *           rather than guessed at a delivery outcome.
 *   m42-m44 same dev-request, post-review fix — the upgrade path: a legacy
 *           (pre-PR) crm_outbox with a real, already-backfilled non-'rfb'
 *           vertical_id survives the 'superseded' CHECK-widening rebuild
 *           without that column being silently dropped and reset to 'rfb'.
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
    // ═══════════════════════════════════════════════════════════════
    // m13-m17 — double-send guard closes the RACE, not just the
    // already-recorded case (post-review bugfix).
    //
    // Before the fix, findRecentIdenticalOutbound() was checked BEFORE
    // `await emailService.sendRaw(...)`, but the crm_messages row that makes
    // the guard "see" a send was only written AFTER that await resolved. Two
    // genuinely concurrent identical resend_send requests both passed the
    // pre-check before either had recorded anything, so both went through —
    // reproduced below by firing two identical requests back-to-back
    // (synchronously, before either's first `await`) against a
    // latency-stubbed transport, exactly like two real concurrent HTTP
    // requests would interleave at the `await`.
    // ═══════════════════════════════════════════════════════════════
    {
      const raceThreadId = "send-history-race-thread-1";
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
        VALUES (?, ?, 'Race-test sak', 'innkommende', 'normal', 'rfb', 1)
      `).run(raceThreadId, contact.id);
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
        VALUES ('inbound-race-1', ?, 'in', 'kunde@example.no', '[]', '[]', 'Race-test sak', 'Hei, har et spørsmål.', datetime('now','-1 hour'), 'sent', 'rfb')
      `).run(raceThreadId);

      const emailMod = require("../services/email-service") as any;
      const svc = emailMod.emailService;
      const realSendRaw = svc.sendRaw.bind(svc);
      let sendCount = 0;
      // Latency stub — the send only resolves after a delay, so the window
      // between the synchronous duplicate-check/reservation and the actual
      // send outcome is wide open, same as the real Resend round-trip that
      // produced the observed double-send.
      svc.sendRaw = async () => {
        sendCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { success: true, messageId: `stub-race-${sendCount}` };
      };

      try {
        const beforeRace = crmService.getThreadDetail(raceThreadId) as any;
        assertEq(beforeRace.thread.message_count, 1, "m13: race thread starts with just the seeded inbound message");

        const payload = {
          intent: "resend_send",
          toEmails: ["kunde@example.no"],
          subject: "Re: Race-test sak",
          bodyText: "Identisk svar sendt to ganger samtidig.",
          createdBy: "daniel",
        };
        // Fire both requests synchronously, back-to-back — this is what
        // Promise.all([...]) does: both `call()` invocations run (and each
        // async route handler starts executing) before either Promise is
        // awaited, so this reproduces two genuinely concurrent requests
        // hitting the same synchronous JS event loop, exactly like two
        // real concurrent HTTP requests interleaving at the same `await`.
        const p1 = call("POST", `/threads/${raceThreadId}/send`, payload);
        const p2 = call("POST", `/threads/${raceThreadId}/send`, payload);
        const [r1, r2] = await Promise.all([p1, p2]);

        const statuses = [r1.status, r2.status].sort();
        assertEq(statuses, [200, 409], "m14: of two genuinely concurrent identical sends, exactly ONE succeeds and ONE is hard-rejected as a duplicate — the guard now actually closes the race it exists for");

        const rejected = r1.status === 409 ? r1 : r2;
        assertEq(rejected.body?.error, "duplicate_send", "m14b: the rejected one carries the duplicate_send error code");

        const afterRace = crmService.getThreadDetail(raceThreadId) as any;
        assertEq(afterRace.thread.message_count, 2, "m15: message_count grew by exactly ONE (1 -> 2), not two — no double-send got through");
        const raceReplies = (afterRace.messages as any[]).filter((m: any) => m.direction === "out");
        assertEq(raceReplies.length, 1, "m16: exactly ONE crm_messages row exists for the reply, not two");
        assertEq(raceReplies[0]?.delivery_status, "sent", "m17: …and it reflects the real, confirmed outcome ('sent'), not left dangling at 'queued'");
      } finally {
        svc.sendRaw = realSendRaw;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // m18-m24 — /outbox/:id/result resolves the RIGHT message once a
    // thread has more than one outstanding queued reply (post-review
    // bugfix).
    //
    // Before the fix, getLatestOutboundMessageId(threadId) picked the
    // thread's most-recent outbound crm_messages row with no link back to
    // which crm_outbox row produced it. With recordOutboundReply() now
    // leaving 'queued' rows for replies on EXISTING threads too, a thread
    // can have multiple outstanding queued replies — reproduced below by
    // queuing two distinct gmail_draft replies on the same thread, then
    // resolving the SECOND-queued outbox item FIRST (out of order).
    // ═══════════════════════════════════════════════════════════════
    {
      const multiThreadId = "send-history-multi-pending-thread-1";
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
        VALUES (?, ?, 'Flere ubesvarte utkast', 'innkommende', 'normal', 'rfb', 1)
      `).run(multiThreadId, contact.id);
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
        VALUES ('inbound-multi-1', ?, 'in', 'kunde@example.no', '[]', '[]', 'Flere ubesvarte utkast', 'Første spørsmål.', datetime('now','-2 hour'), 'sent', 'rfb')
      `).run(multiThreadId);

      const reply1 = await call("POST", `/threads/${multiThreadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["kunde@example.no"],
        subject: "Re: Flere ubesvarte utkast (svar 1)",
        bodyText: "Første svar-utkast.",
        createdBy: "daniel",
      });
      assertEq(reply1.status, 200, "m18: first queued reply on the thread succeeds");
      const reply2 = await call("POST", `/threads/${multiThreadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["kunde@example.no"],
        subject: "Re: Flere ubesvarte utkast (svar 2)",
        bodyText: "Andre, distinkte svar-utkast.",
        createdBy: "daniel",
      });
      assertEq(reply2.status, 200, "m19: a second, DISTINCT queued reply on the SAME thread also succeeds — the thread now has two outstanding 'queued' messages");

      const outboxId1 = reply1.body?.outboxId as string;
      const outboxId2 = reply2.body?.outboxId as string;
      const messageId1 = reply1.body?.internalMessageId as string;
      const messageId2 = reply2.body?.internalMessageId as string;
      assertTrue(typeof outboxId1 === "string" && typeof outboxId2 === "string" && outboxId1 !== outboxId2, "m20: the two replies produced two DIFFERENT crm_outbox ids");

      const linkedOutbox1 = db.prepare("SELECT crm_message_id FROM crm_outbox WHERE id = ?").get(outboxId1) as any;
      const linkedOutbox2 = db.prepare("SELECT crm_message_id FROM crm_outbox WHERE id = ?").get(outboxId2) as any;
      assertEq(linkedOutbox1?.crm_message_id, messageId1, "m20b: crm_outbox row 1 is explicitly linked to crm_messages row 1");
      assertEq(linkedOutbox2?.crm_message_id, messageId2, "m20c: crm_outbox row 2 is explicitly linked to crm_messages row 2 — NOT row 1");

      // Resolve the SECOND-queued item FIRST — the exact out-of-order
      // sequence the bug report reproduced.
      const result2 = await call("POST", `/outbox/${outboxId2}/result`, { status: "completed", resultId: "draft-2" });
      assertEq(result2.status, 200, "m21: resolving outbox item 2 (out of order, before item 1) succeeds");

      const afterResult2 = crmService.getThreadDetail(multiThreadId) as any;
      const msg1AfterResult2 = (afterResult2.messages as any[]).find((m: any) => m.id === messageId1);
      const msg2AfterResult2 = (afterResult2.messages as any[]).find((m: any) => m.id === messageId2);
      assertEq(msg2AfterResult2?.delivery_status, "draft_in_gmail", "m22: message 2 (the one outbox item 2 actually produced) is updated to 'draft_in_gmail'");
      assertEq(msg1AfterResult2?.delivery_status, "queued", "m23: message 1 is UNTOUCHED, still 'queued' — this is the bug: before the fix, 'most recent' would have wrongly updated message 1 here instead");

      // Now resolve item 1 — it must land on message 1, not double-update message 2.
      const result1 = await call("POST", `/outbox/${outboxId1}/result`, { status: "completed", resultId: "draft-1" });
      assertEq(result1.status, 200, "m24: resolving outbox item 1 afterwards also succeeds");
      const afterResult1 = crmService.getThreadDetail(multiThreadId) as any;
      const msg1Final = (afterResult1.messages as any[]).find((m: any) => m.id === messageId1);
      assertEq(msg1Final?.delivery_status, "draft_in_gmail", "m24b: message 1 is now ALSO correctly updated to 'draft_in_gmail', resolved via its own explicit link");
    }

    // ═══════════════════════════════════════════════════════════════
    // m25-m30 — post-review bugfix (iteration 2): POST /compose's outbox
    // row now links crm_message_id too, not just POST /threads/:id/send's.
    //
    // Before this fix, composeNewThread() created message A and
    // enqueueOutbox() created outbox O right after — but nothing set
    // O.crm_message_id, so it stayed NULL forever. /outbox/O/result then
    // fell through to getLatestOutboundMessageId(threadId) ("most recent
    // outbound for thread"), which is wrong as soon as a SECOND outbound
    // message lands on that same thread before O's result comes back.
    //
    // Reproduced exactly as the reviewer found it: a /compose draft
    // (message A, outbox O) on a brand-new thread, then a DISTINCT
    // /threads/:id/send reply (message B) on that SAME thread, then
    // POST /outbox/O/result. Before the fix this wrongly flipped B and
    // left A stuck at 'queued' forever; after the fix it must resolve A.
    // ═══════════════════════════════════════════════════════════════
    {
      const composeRes = await call("POST", "/compose", {
        to: "ny-kontakt@example.no",
        subject: "Velkommen",
        bodyText: "Her er informasjonen du ba om.",
        intent: "gmail_draft",
        createdBy: "daniel",
        vertical: "rfb",
      });
      assertEq(composeRes.status, 200, "m25: POST /compose (gmail_draft) succeeds");
      const composeThreadId = composeRes.body?.threadId as string;
      const outboxIdA = composeRes.body?.outboxId as string;
      assertTrue(typeof composeThreadId === "string" && typeof outboxIdA === "string", "m25b: …and returns a threadId and outboxId");

      const linkedComposeOutbox = db.prepare("SELECT crm_message_id FROM crm_outbox WHERE id = ?").get(outboxIdA) as any;
      const composeMessageId = (db.prepare(
        "SELECT id FROM crm_messages WHERE thread_id = ? AND direction = 'out' ORDER BY received_at ASC LIMIT 1"
      ).get(composeThreadId) as any)?.id as string;
      assertTrue(typeof composeMessageId === "string", "m26: the compose draft produced a crm_messages row (message A)");
      assertEq(linkedComposeOutbox?.crm_message_id, composeMessageId,
        "m26b: THE FIX — crm_outbox row from /compose is explicitly linked to message A, not left NULL");

      // Backdate message A's received_at. SQLite datetime('now') is
      // 1-second granularity, so a fast in-memory test can otherwise create
      // A and B in the same second — making the OLD "most recent for
      // thread" fallback's tie-break coincidental rather than a real
      // reproduction of the reported bug. Backdating forces B to be
      // unambiguously the most recent, which is what actually exposes the
      // misattribution without the crm_message_id link.
      db.prepare("UPDATE crm_messages SET received_at = datetime('now', '-10 seconds') WHERE id = ?").run(composeMessageId);

      // A second, DISTINCT reply lands on the SAME thread before O's result
      // comes back — the exact ambiguity that broke the old "most recent
      // for thread" fallback.
      const replyB = await call("POST", `/threads/${composeThreadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["ny-kontakt@example.no"],
        subject: "Re: Velkommen",
        bodyText: "Oppfølging: her er mer informasjon.",
        createdBy: "daniel",
      });
      assertEq(replyB.status, 200, "m27: a second, distinct reply on the same thread also succeeds");
      const messageIdB = replyB.body?.internalMessageId as string;
      assertTrue(typeof messageIdB === "string" && messageIdB !== composeMessageId, "m27b: …producing a DIFFERENT message (B), newer than A");

      // Now resolve outbox O — the one /compose created for message A.
      const resultA = await call("POST", `/outbox/${outboxIdA}/result`, { status: "completed", resultId: "draft-compose-a" });
      assertEq(resultA.status, 200, "m28: resolving outbox O (compose's outbox row) succeeds");

      const afterResultA = crmService.getThreadDetail(composeThreadId) as any;
      const msgAAfter = (afterResultA.messages as any[]).find((m: any) => m.id === composeMessageId);
      const msgBAfter = (afterResultA.messages as any[]).find((m: any) => m.id === messageIdB);
      assertEq(msgAAfter?.delivery_status, "draft_in_gmail",
        "m29: message A (the one outbox O actually produced) is updated to 'draft_in_gmail'");
      assertEq(msgBAfter?.delivery_status, "queued",
        "m30: message B is UNTOUCHED, still 'queued' — this is the reported bug: before the fix, the 'most recent for thread' fallback would have wrongly flipped B here instead of A");
    }
    // ═══════════════════════════════════════════════════════════════
    // m31-m40 — dev-request 2026-08-17-cs-plattformparitet-og-verifisert-
    // utfoerelse (Skive F), akseptansekriterium 9: a subject that's empty
    // (after trim) or that trims to NOTHING but a reply/svar prefix
    // ("Re:"/"Sv:", case-insensitive) is rejected before any send is
    // attempted. Concrete background: an outreach thread got two
    // auto-replies four seconds apart, both subject "Re:" — the empty
    // subject was the symptom of a reply the agent never actually composed.
    // ═══════════════════════════════════════════════════════════════
    {
      const subjectThreadId = "send-history-subject-guard-thread-1";
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
        VALUES (?, ?, 'Subjektvakt-sak', 'innkommende', 'normal', 'rfb', 1)
      `).run(subjectThreadId, contact.id);
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
        VALUES ('inbound-subject-guard-1', ?, 'in', 'kunde@example.no', '[]', '[]', 'Subjektvakt-sak', 'Har et spørsmål.', datetime('now','-1 hour'), 'sent', 'rfb')
      `).run(subjectThreadId);

      async function sendWithSubject(subject: string) {
        return call("POST", `/threads/${subjectThreadId}/send`, {
          intent: "gmail_draft",
          toEmails: ["kunde@example.no"],
          subject,
          bodyText: "Et faktisk svar.",
          createdBy: "daniel",
        });
      }

      const rejectedSubjects = ["", "Re:", "Sv:", "re:", "RE:", "  Re:  "];
      for (const subject of rejectedSubjects) {
        const res = await sendWithSubject(subject);
        assertEq(res.status, 400, `m31: subject ${JSON.stringify(subject)} is rejected with 400`);
        assertEq(res.body?.error, "invalid body", `m31b: …with the same 'invalid body' shape sendSchema failures already use, for subject ${JSON.stringify(subject)}`);
        const issues = (res.body?.details as any[]) || [];
        assertTrue(
          issues.some((i) => Array.isArray(i.path) && i.path[0] === "subject"),
          `m31c: …and the schema issue is attributed to the 'subject' field, for subject ${JSON.stringify(subject)}`
        );
      }

      const afterRejections = crmService.getThreadDetail(subjectThreadId) as any;
      assertEq(afterRejections.messages.length, 1, "m32: none of the rejected sends created a crm_messages row");
      assertEq(afterRejections.thread.message_count, 1, "m32b: …and message_count is untouched");

      // Regression guards — real subjects (including a real "Re: ..." reply)
      // must NOT be rejected.
      const okPlain = await sendWithSubject("Spørsmål om levering (svar)");
      assertEq(okPlain.status, 200, "m33: a normal, non-empty, non-prefix-only subject still succeeds");

      const okReply = await sendWithSubject("Re: faktisk oppfølging");
      assertEq(okReply.status, 200, "m34: 'Re: faktisk oppfølging' (real content beyond the prefix) still succeeds — only an exact prefix-only match is rejected");

      const afterOk = crmService.getThreadDetail(subjectThreadId) as any;
      assertEq(afterOk.messages.length, 3, "m35: the two legitimate sends both landed (1 seeded inbound + 2 outbound replies)");
    }

    // ═══════════════════════════════════════════════════════════════
    // m36-m41 — dev-request 2026-08-25-cs-outbox-result-mangler-
    // superseded-status: POST /outbox/:id/result accepts status:"superseded"
    // for a row whose case actually resolved via a DIFFERENT channel than
    // the row itself represents — distinct from "completed" and without
    // guessing a delivery outcome for the linked crm_messages row.
    // ═══════════════════════════════════════════════════════════════
    {
      const supersededThreadId = "send-history-superseded-thread-1";
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
        VALUES (?, ?, 'Løst via annen kanal', 'innkommende', 'normal', 'rfb', 1)
      `).run(supersededThreadId, contact.id);
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
        VALUES ('inbound-superseded-1', ?, 'in', 'kunde@example.no', '[]', '[]', 'Løst via annen kanal', 'Spørsmål.', datetime('now','-1 hour'), 'sent', 'rfb')
      `).run(supersededThreadId);

      const draftReply = await call("POST", `/threads/${supersededThreadId}/send`, {
        intent: "gmail_draft",
        toEmails: ["kunde@example.no"],
        subject: "Re: Løst via annen kanal",
        bodyText: "Utkast som viser seg unødvendig.",
        createdBy: "daniel",
      });
      assertEq(draftReply.status, 200, "m36: queuing the gmail_draft reply succeeds");
      const supersededOutboxId = draftReply.body?.outboxId as string;
      const supersededMessageId = draftReply.body?.internalMessageId as string;

      const pendingBefore = crmService.listPendingOutbox("gmail_draft", 200);
      assertTrue(pendingBefore.some((o: any) => o.id === supersededOutboxId), "m37: the row is in the pending queue before resolution");

      // Case actually resolved via resend_send on the same thread, not via
      // this queued draft — report the outbox row as superseded, carrying
      // the OTHER channel's message id as resultId for the audit trail.
      const result = await call("POST", `/outbox/${supersededOutboxId}/result`, {
        status: "superseded",
        resultId: "resend-msg-elsewhere-1",
      });
      assertEq(result.status, 200, "m38: POST /outbox/:id/result accepts status:\"superseded\"");

      const row = db.prepare("SELECT status, result_id FROM crm_outbox WHERE id = ?").get(supersededOutboxId) as any;
      assertEq(row?.status, "superseded", "m39: crm_outbox.status is 'superseded', not folded into 'completed'");
      assertEq(row?.result_id, "resend-msg-elsewhere-1", "m39b: the other channel's id is still recorded as result_id");

      const pendingAfter = crmService.listPendingOutbox("gmail_draft", 200);
      assertTrue(!pendingAfter.some((o: any) => o.id === supersededOutboxId), "m40: the row is gone from the pending queue without ever having counted as 'completed'");

      const linkedMessage = db.prepare("SELECT delivery_status FROM crm_messages WHERE id = ?").get(supersededMessageId) as any;
      assertEq(linkedMessage?.delivery_status, "queued", "m41: the linked crm_messages row is left untouched (still 'queued') — 'superseded' means THIS row's own draft never happened, so there is no delivery outcome to guess at for it");
    }

    // ═══════════════════════════════════════════════════════════════
    // m42-m44 — THE UPGRADE PATH for the 'superseded' migration (post-review
    // fix). Every other test here boots a fresh DB, which already has
    // 'superseded' baked into crm_outbox's inline CREATE TABLE — the
    // table-rebuild migration never fires and its column list is never
    // exercised. A real prod DB is NOT fresh: it already went through the
    // Phase 4.6a vertical_id backfill (crm_outbox.vertical_id populated with
    // real values like 'dental'/'experiences', not just 'rfb') long before
    // this PR ships. A first version of the rebuild's explicit column list
    // omitted vertical_id entirely, which silently dropped the column and
    // let the later Phase 4.6a ALTER re-add it fresh with DEFAULT 'rfb' for
    // EVERY row — reclassifying every existing non-rfb outbox row. Mirrors
    // crm-vertical.test.ts's own cv47-cv49 legacy-DB upgrade pattern.
    // ═══════════════════════════════════════════════════════════════
    {
      const legacy = new Database(":memory:");
      try {
        __setDbForTesting(legacy);
        __initSchemaForTesting(legacy);

        // Recreate today's real prod shape: crm_outbox WITHOUT 'superseded'
        // in the CHECK (pre-this-PR), but WITH vertical_id already present
        // and populated with a real non-'rfb' value (post-Phase-4.6a).
        legacy.exec(`DROP TABLE crm_outbox`);
        legacy.exec(`
          CREATE TABLE crm_outbox (
            id TEXT PRIMARY KEY,
            thread_id TEXT REFERENCES crm_threads(id) ON DELETE SET NULL,
            contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
            intent TEXT NOT NULL CHECK(intent IN ('gmail_draft','resend_send')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
            to_emails TEXT NOT NULL,
            cc_emails TEXT,
            subject TEXT NOT NULL,
            body_text TEXT NOT NULL,
            body_html TEXT,
            reply_to_message_id TEXT,
            result_id TEXT,
            error TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            processed_at TEXT,
            created_by TEXT NOT NULL CHECK(created_by IN ('claude','daniel')),
            crm_message_id TEXT REFERENCES crm_messages(id) ON DELETE SET NULL,
            vertical_id TEXT NOT NULL DEFAULT 'rfb'
          )
        `);
        legacy.prepare(`
          INSERT INTO crm_outbox (id, intent, status, to_emails, subject, body_text, created_by, vertical_id)
          VALUES ('legacy-outbox-1', 'gmail_draft', 'completed', '[]', 'Historisk', 'Historisk utkast.', 'daniel', 'dental')
        `).run();

        const beforeCheck = (legacy.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='crm_outbox'`
        ).get() as any).sql as string;
        assertTrue(!/'superseded'/.test(beforeCheck), "m42: the legacy pre-PR shape is in place before the upgrade — no 'superseded' in the CHECK yet");
        const beforeVertical = (legacy.prepare(`SELECT vertical_id FROM crm_outbox WHERE id = 'legacy-outbox-1'`).get() as any).vertical_id;
        assertEq(beforeVertical, "dental", "m42b: …and the row's real vertical_id ('dental') is in place before the upgrade");

        __initSchemaForTesting(legacy); // the upgrade boot — fires the rebuild migration

        const afterCheck = (legacy.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='crm_outbox'`
        ).get() as any).sql as string;
        assertTrue(/'superseded'/.test(afterCheck), "m43: upgrading actually widens the CHECK to include 'superseded'");

        const afterVertical = (legacy.prepare(`SELECT vertical_id FROM crm_outbox WHERE id = 'legacy-outbox-1'`).get() as any).vertical_id;
        assertEq(afterVertical, "dental", "m44: …and the pre-existing row's vertical_id survives the rebuild as 'dental' — NOT silently reset to 'rfb'");
      } finally {
        try { legacy.close(); } catch { /* already closed */ }
        __setDbForTesting(db);
      }
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

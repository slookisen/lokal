/**
 * crm-service.test.ts — unit tests for crmService.listThreadsByStatus()
 * (src/services/crm-service.ts), used by GET /admin/crm/threads (src/routes/crm.ts).
 *
 * Regression pin for the P2 bug flagged across supervisor cycles 2026-07-01/02 and
 * Daniel work-order 2026-07-03 item 2: `GET /admin/crm/threads?contact_email=<email>`
 * silently ignored the `contact_email` query param and always returned whatever was
 * in the default `status=awaiting_review` bucket, regardless of which contact was
 * asked for.
 *
 * listThreadsByStatus() now takes an OPTIONAL status plus an optional
 * opts.contactEmail filter, building the WHERE clause dynamically:
 *   - contact_email given            → filters to that contact across ALL statuses
 *                                       (unless an explicit status is also given)
 *   - contact_email omitted          → defaults to status=awaiting_review, as before
 *     (dashboard-badge behaviour, unchanged — regression guard)
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/crm-service.test.ts
 *   2. Wired into the gate: tests/test.ts imports runCrmServiceTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";
import { crmService } from "./crm-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmServiceTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  // ─── Fixture DB: real prod schema via __initSchemaForTesting, so
  // crm_contacts / crm_threads / crm_messages / agents all exist. ───────────
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db);
  __initSchemaForTesting(db);

  function insertContact(id: string, email: string, name: string): void {
    db.prepare(`
      INSERT INTO crm_contacts (id, type, email, name)
      VALUES (?, 'producer', ?, ?)
    `).run(id, email, name);
  }

  function insertThread(id: string, contactId: string, status: string, subject: string): void {
    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, status, subject, last_message_at, created_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, contactId, status, subject);
  }

  // ── Seed: two distinct contacts, each with a thread; contact A's thread is
  // in the non-default "done" status, contact B's is "awaiting_review". ────
  insertContact("contact-a", "a@example.no", "Contact A");
  insertContact("contact-b", "b@example.no", "Contact B");
  insertThread("thread-a1", "contact-a", "done", "A's resolved thread");
  insertThread("thread-b1", "contact-b", "awaiting_review", "B's pending thread");

  // (a) contact_email filter returns ONLY that contact's thread(s) …
  {
    const rows = crmService.listThreadsByStatus(undefined, { contactEmail: "a@example.no" });
    assertEq(rows.length, 1, "contact_email=a returns exactly 1 thread");
    assertEq(rows[0]?.id, "thread-a1", "contact_email=a returns thread-a1");
    assertTrue(
      !rows.some((r: any) => r.id === "thread-b1"),
      "contact_email=a does NOT return contact B's thread"
    );
  }

  // (b) … and INCLUDES a thread in a non-default status ("done") — proves
  // status is no longer forced to "awaiting_review" when contact_email is given.
  {
    const rows = crmService.listThreadsByStatus(undefined, { contactEmail: "a@example.no" });
    assertEq(rows[0]?.status, "done", "contact_email=a's thread is included despite status=done");
  }

  // Case-insensitive match on contact_email.
  {
    const rows = crmService.listThreadsByStatus(undefined, { contactEmail: "A@EXAMPLE.NO" });
    assertEq(rows.length, 1, "contact_email match is case-insensitive");
    assertEq(rows[0]?.id, "thread-a1", "case-insensitive contact_email=A@EXAMPLE.NO returns thread-a1");
  }

  // (c) Omitting contact_email entirely preserves the old dashboard-badge
  // behaviour: defaults to awaiting_review, excludes A's "done" thread.
  {
    const rows = crmService.listThreadsByStatus("awaiting_review", {});
    assertEq(rows.length, 1, "status=awaiting_review (no contact_email) returns exactly 1 thread");
    assertEq(rows[0]?.id, "thread-b1", "status=awaiting_review (no contact_email) returns thread-b1 only");
    assertTrue(
      !rows.some((r: any) => r.id === "thread-a1"),
      "status=awaiting_review (no contact_email) excludes A's done thread — regression guard"
    );
  }

  // An explicit status alongside contact_email is still honoured (AND'ed).
  {
    const rows = crmService.listThreadsByStatus("done", { contactEmail: "a@example.no" });
    assertEq(rows.length, 1, "explicit status=done + contact_email=a returns thread-a1");
    const none = crmService.listThreadsByStatus("awaiting_review", { contactEmail: "a@example.no" });
    assertEq(none.length, 0, "explicit status=awaiting_review + contact_email=a (mismatched status) returns nothing");
  }

  // A contact_email with no matching contact returns an empty array, not an error.
  {
    const rows = crmService.listThreadsByStatus(undefined, { contactEmail: "nobody@example.no" });
    assertEq(rows.length, 0, "unknown contact_email returns empty array");
  }

  // ─── getThreadDetail() must surface c.provider_id ───────────────────────
  // Regression guard: the SELECT in getThreadDetail() read c.agent_id but not
  // c.provider_id, so GET /admin/crm/threads/:id had no way to tell a caller
  // (e.g. the customer-service routine) which Opplevagent producer a
  // experiences-vertical thread's contact was matched to. Fixed by adding
  // `c.provider_id AS provider_id` to the SELECT — pure additive read, no
  // schema change.
  {
    // rfb-vertical contact: agent_id set, provider_id must come back null.
    // agent_id is a real FK into `agents`, so seed the row it points at first.
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
      VALUES ('agent-123', 'Test Agent', 'x', 'test', 'rfb@example.no', 'https://example.no', 'producer', 'test-key-123', 1)
    `).run();
    db.prepare(`
      INSERT INTO crm_contacts (id, type, email, name, vertical_id, agent_id)
      VALUES ('contact-rfb', 'producer', 'rfb@example.no', 'RFB Contact', 'rfb', 'agent-123')
    `).run();
    insertThread("thread-rfb1", "contact-rfb", "awaiting_review", "RFB thread");

    const rfbDetail = crmService.getThreadDetail("thread-rfb1") as any;
    assertTrue(rfbDetail?.thread !== null && rfbDetail?.thread !== undefined, "getThreadDetail(rfb thread) returns a thread");
    assertEq(rfbDetail.thread.agent_id, "agent-123", "rfb thread detail carries agent_id");
    assertEq(rfbDetail.thread.provider_id, null, "rfb thread detail's provider_id is null — regression guard");

    // experiences-vertical contact: provider_id set, must be returned.
    db.prepare(`
      INSERT INTO crm_contacts (id, type, email, name, vertical_id, provider_id)
      VALUES ('contact-exp', 'producer', 'exp@example.no', 'Experiences Contact', 'experiences', 'provider-456')
    `).run();
    insertThread("thread-exp1", "contact-exp", "awaiting_review", "Experiences thread");

    const expDetail = crmService.getThreadDetail("thread-exp1") as any;
    assertTrue(expDetail?.thread !== null && expDetail?.thread !== undefined, "getThreadDetail(experiences thread) returns a thread");
    assertEq(expDetail.thread.provider_id, "provider-456", "experiences thread detail carries provider_id — the bug this test guards against");
    assertEq(expDetail.thread.agent_id, null, "experiences thread detail's agent_id is null");
  }

  // ─── recomputeThreadStats() rollup bugs (Skive G) ───────────────────────
  // Three confirmed bugs in the CRM "have we replied?" rollup:
  //   1. last_inbound_at always NULL (inbound rows never carry a real
  //      sent_at; recomputeThreadStats didn't fall back to received_at).
  //   2. last_outbound_at froze at a stale value because
  //      updateMessageDeliveryStatus() never re-ran recomputeThreadStats()
  //      after confirming a 'queued' reservation as 'sent'.
  //   3. listSentMessages()'s since_hours filter silently dropped rows whose
  //      sent_at/received_at was written in SQLite's own
  //      "YYYY-MM-DD HH:MM:SS" format (raw string >= against a JS ISO
  //      cutoff misorders on the 'T'/' ' separator).

  // (1) ingestThread() with a real inbound message (sentAt omitted) sets
  // last_inbound_at — regression guard for bug 1.
  {
    insertContact("contact-bug1", "inbound1@example.no", "Inbound Sender 1");
    const { threadId } = crmService.ingestThread(
      {
        threadId: "thread-bug1-inbound",
        subject: "Spørsmål om levering",
        messages: [
          {
            messageId: "gmail-msg-bug1-in",
            direction: "in",
            fromEmail: "inbound1@example.no",
            bodyText: "Når kommer bestillingen min?",
            sentAt: null,
          },
        ],
      },
      "inbound1@example.no",
      "rfb",
    );
    const row = db.prepare("SELECT last_inbound_at, last_message_at, message_count FROM crm_threads WHERE id = ?")
      .get(threadId) as { last_inbound_at: string | null; last_message_at: string | null; message_count: number };
    assertTrue(row.last_inbound_at !== null, "ingestThread(inbound, no sentAt) sets last_inbound_at — regression guard for bug 1");
    assertTrue(row.last_message_at !== null, "ingestThread(inbound, no sentAt) also sets last_message_at via the same COALESCE fallback");
    assertEq(row.message_count, 1, "ingestThread(inbound) counts the message");
  }

  // (2) recordOutboundReply({deliveryStatus:'queued'}) followed by
  // updateMessageDeliveryStatus(id,'sent') moves last_outbound_at to the
  // real confirmed sent_at — regression guard for bug 2. A 'failed'
  // transition must NOT move it.
  {
    insertContact("contact-bug2", "outbound2@example.no", "Outbound Contact 2");
    insertThread("thread-bug2-outbound", "contact-bug2", "in_progress", "Reply thread");

    // Seed a PRIOR confirmed outbound reply with an old, explicit sentAt —
    // this is the "stale value" last_outbound_at must move away from.
    crmService.recordOutboundReply({
      threadId: "thread-bug2-outbound",
      vertical: "rfb",
      toEmails: ["outbound2@example.no"],
      subject: "Første svar",
      bodyText: "Her er svaret ditt.",
      deliveryStatus: "sent",
      sentAt: "2020-01-01T00:00:00.000Z",
    });
    const beforeReserve = db.prepare("SELECT last_outbound_at FROM crm_threads WHERE id = ?")
      .get("thread-bug2-outbound") as { last_outbound_at: string | null };
    assertEq(beforeReserve.last_outbound_at, "2020-01-01T00:00:00.000Z", "seeded prior reply sets last_outbound_at to the old sentAt");

    // resend_send reservation shape: inserted 'queued', sent_at stays null.
    const { messageId: reservedId } = crmService.recordOutboundReply({
      threadId: "thread-bug2-outbound",
      vertical: "rfb",
      toEmails: ["outbound2@example.no"],
      subject: "Nytt svar",
      bodyText: "Her er et nytt svar.",
      deliveryStatus: "queued",
    });
    const afterReserve = db.prepare("SELECT last_outbound_at FROM crm_threads WHERE id = ?")
      .get("thread-bug2-outbound") as { last_outbound_at: string | null };
    assertEq(afterReserve.last_outbound_at, "2020-01-01T00:00:00.000Z", "a 'queued' reservation (sent_at still null) does NOT move last_outbound_at");

    // Confirm the send — this is the fix under test.
    crmService.updateMessageDeliveryStatus(reservedId, "sent");
    const afterSent = db.prepare("SELECT last_outbound_at FROM crm_threads WHERE id = ?")
      .get("thread-bug2-outbound") as { last_outbound_at: string | null };
    assertTrue(
      afterSent.last_outbound_at !== null && afterSent.last_outbound_at !== "2020-01-01T00:00:00.000Z",
      "updateMessageDeliveryStatus(id,'sent') moves last_outbound_at off the stale prior value — regression guard for bug 2",
    );
    const confirmedSentAt = db.prepare("SELECT sent_at FROM crm_messages WHERE id = ?").get(reservedId) as { sent_at: string };
    assertEq(afterSent.last_outbound_at, confirmedSentAt.sent_at, "last_outbound_at exactly matches the just-confirmed message's sent_at");

    // A second reservation that ends in 'failed' must NOT move last_outbound_at.
    const { messageId: failedId } = crmService.recordOutboundReply({
      threadId: "thread-bug2-outbound",
      vertical: "rfb",
      toEmails: ["outbound2@example.no"],
      subject: "Mislykket svar",
      bodyText: "Dette skal feile.",
      deliveryStatus: "queued",
    });
    crmService.updateMessageDeliveryStatus(failedId, "failed");
    const afterFailed = db.prepare("SELECT last_outbound_at FROM crm_threads WHERE id = ?")
      .get("thread-bug2-outbound") as { last_outbound_at: string | null };
    assertEq(afterFailed.last_outbound_at, afterSent.last_outbound_at, "a 'failed' transition does NOT move last_outbound_at");
  }

  // (3) listSentMessages({sinceHours}) must not drop a row whose
  // sent_at/received_at is written in SQLite's own datetime('now') format
  // — regression guard for bug 3.
  {
    insertContact("contact-bug3", "outbound3@example.no", "Outbound Contact 3");
    insertThread("thread-bug3-sincehours", "contact-bug3", "in_progress", "Sent-log thread");

    // Recent row, SQLite datetime('now') format: reserve 'queued' (sent_at
    // null) then confirm 'sent' via updateMessageDeliveryStatus, which
    // writes sent_at = datetime('now') — no 'T'/'Z', exactly the legacy
    // format class that was previously silently dropped.
    const { messageId: recentId } = crmService.recordOutboundReply({
      threadId: "thread-bug3-sincehours",
      vertical: "rfb",
      toEmails: ["outbound3@example.no"],
      subject: "Nylig svar",
      bodyText: "Dette er nylig.",
      deliveryStatus: "queued",
    });
    crmService.updateMessageDeliveryStatus(recentId, "sent");
    const recentRow = db.prepare("SELECT sent_at FROM crm_messages WHERE id = ?").get(recentId) as { sent_at: string };
    assertTrue(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(recentRow.sent_at),
      `recent message's sent_at is written in SQLite datetime('now') format, no 'T'/'Z' (got ${JSON.stringify(recentRow.sent_at)})`,
    );

    // Control: an old row, JS-ISO format, well outside the window. Inserted
    // directly (not via recordOutboundReply) so received_at can ALSO be
    // backdated — recordOutboundReply always leaves received_at at its
    // schema default of datetime('now'), which would make this row look
    // "just recorded" via the OR received_at branch regardless of sent_at.
    db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, snippet, sent_at, received_at, delivery_status, vertical_id)
      VALUES ('msg-bug3-old', 'thread-bug3-sincehours', 'out', 'kontakt@rettfrabonden.com', '["outbound3@example.no"]', '[]', 'Gammelt svar', 'Dette er gammelt.', 'Dette er gammelt.', '2020-01-01T00:00:00.000Z', '2020-01-01 00:00:00', 'sent', 'rfb')
    `).run();

    const sinceHours = crmService.listSentMessages({ sinceHours: 1 });
    assertTrue(
      sinceHours.some((r) => r.message_id === recentId),
      "listSentMessages({sinceHours:1}) includes the recent SQLite-format-timestamp row — regression guard for bug 3",
    );
    assertTrue(
      !sinceHours.some((r) => r.subject === "Gammelt svar"),
      "listSentMessages({sinceHours:1}) correctly excludes a row well outside the window (control case)",
    );
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCrmServiceTests({ log: true });
  console.log(`\ncrm-service: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

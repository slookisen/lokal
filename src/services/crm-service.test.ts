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

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCrmServiceTests({ log: true });
  console.log(`\ncrm-service: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

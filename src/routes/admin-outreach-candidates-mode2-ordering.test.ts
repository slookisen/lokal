/**
 * admin-outreach-candidates-mode2-ordering.test.ts — regression pins for the
 * mode=second "eldst-kontaktet-først" ordering added to
 * GET /admin/outreach-candidates (2026-07-12, Daniel).
 *
 * mode=second returns producers eligible for a second touch (email nr. 2): they
 * were contacted once, >cooldown_days ago. Daniel wants the batch to reach the
 * producers contacted LONGEST ago first, so a limit-capped batch prioritizes the
 * most-overdue candidates. This test proves:
 *   (1) candidates come back ordered oldest-last-contact-first;
 *   (2) the ordering is keyed on the immutable recipient_email / agent_id via the
 *       same lastSentFor() the cooldown check uses;
 *   (3) EVERY existing suppression is untouched — a blocklisted producer and a
 *       producer who already replied are BOTH excluded even though their last
 *       contact is old enough to otherwise qualify.
 *
 * Mirrors admin-outreach-candidates-crm-send-guard.test.ts: synchronous route
 * exercise, real init.ts schema, wired into tests/test.ts.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = { method: "GET", url: "/", query: opts.query || {}, headers: opts.headers || {} };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { result = { status: this.statusCode, body: payload }; return this; },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminOutreachCandidatesMode2OrderingTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = "admin-outreach-candidates-mode2-ordering-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertVerifiedPoolAgent(id: string, name: string, email: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, name, email, `key-${id}`);
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed)
      VALUES (?, ?, '{}', 'verified', 'rich', 200, datetime('now'))
    `).run(id, email);
  }

  // A prior contact recorded in outreach_sent_log (the mode=second cooldown source),
  // keyed on both agent_id and recipient_email. daysAgo controls "how long ago".
  function insertPriorContact(agentId: string, email: string, daysAgo: number): void {
    db.prepare(`
      INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
      VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior')
    `).run(agentId, email.toLowerCase(), `-${daysAgo} days`, `msg-prior-${agentId}`);
  }

  try {
    // Three eligible second-touch producers, all contacted >60d ago, at DIFFERENT
    // times: A longest ago (133d), B (102d), C most-recent-but-still->60d (72d).
    insertVerifiedPoolAgent("oa-A", "Prod A eldst", "a@prod-test.no");
    insertPriorContact("oa-A", "a@prod-test.no", 133);
    insertVerifiedPoolAgent("oa-B", "Prod B midt", "b@prod-test.no");
    insertPriorContact("oa-B", "b@prod-test.no", 102);
    insertVerifiedPoolAgent("oa-C", "Prod C nyest", "c@prod-test.no");
    insertPriorContact("oa-C", "c@prod-test.no", 72);

    // A blocklisted producer, old contact — must be EXCLUDED despite being overdue.
    insertVerifiedPoolAgent("oa-BL", "Prod Blocklisted", "blocked@prod-test.no");
    insertPriorContact("oa-BL", "blocked@prod-test.no", 150);
    db.prepare(`
      INSERT INTO agent_blocklist (identifier_type, identifier_value, reason)
      VALUES ('email', 'blocked@prod-test.no', 'test: blocklist mode=second ordering')
    `).run();

    // A producer who already REPLIED, old contact — must be EXCLUDED.
    insertVerifiedPoolAgent("oa-RE", "Prod Replied", "replied@prod-test.no");
    insertPriorContact("oa-RE", "replied@prod-test.no", 150);
    db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run("c-RE", "producer", "oa-RE", "replied@prod-test.no", "Prod Replied");
    db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to) VALUES (?,?,?,?,?,?)`)
      .run("thread-RE", "c-RE", "Svar", "innkommende", "in_progress", "claude");
    db.prepare(`
      INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, received_at, delivery_status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run("m-RE-in", "thread-RE", "in", "replied@prod-test.no", JSON.stringify(["kontakt@rettfrabonden.com"]),
           "Svar", "hei", "2026-05-01T00:00:00Z", "sent");

    const router = require("./admin-outreach-candidates").default;
    const res = callRouteSync(router, { query: { mode: "second", cooldown_days: "60" }, headers: { "x-admin-key": testKey } });

    assertEq(res.status, 200, "mode2-ordering: GET mode=second → 200");

    const emails = (res.body?.candidates || []).map((c: any) => c.email.toLowerCase());
    // (1) THE ordering: oldest-contacted first → A (133d), B (102d), C (72d).
    assertEq(emails, ["a@prod-test.no", "b@prod-test.no", "c@prod-test.no"],
      "mode2-ordering: candidates ordered oldest-last-contact first (A→B→C)");

    // (3) Suppressions untouched: blocklisted + replied excluded despite being overdue.
    assertEq(emails.includes("blocked@prod-test.no"), false,
      "mode2-ordering: blocklisted producer excluded (suppression unchanged by ordering)");
    assertEq(emails.includes("replied@prod-test.no"), false,
      "mode2-ordering: already-replied producer excluded (suppression unchanged by ordering)");
    assertEq(res.body?.suppressed_counts?.blocklisted >= 1, true,
      "mode2-ordering: suppressed_counts.blocklisted reflects the blocklist catch");
    assertEq(res.body?.suppressed_counts?.replied >= 1, true,
      "mode2-ordering: suppressed_counts.replied reflects the reply catch");

    // (2) limit cap respects the order — top-1 is the oldest (A).
    const resCap = callRouteSync(router, { query: { mode: "second", cooldown_days: "60", limit: "1" }, headers: { "x-admin-key": testKey } });
    const capEmails = (resCap.body?.candidates || []).map((c: any) => c.email.toLowerCase());
    assertEq(capEmails, ["a@prod-test.no"],
      "mode2-ordering: a limit=1 batch returns the SINGLE most-overdue producer (A)");
  } catch (err) {
    failed++;
    failures.push(`mode2-ordering: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runAdminOutreachCandidatesMode2OrderingTests({ log: true });
  console.log(`\nmode2-ordering: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

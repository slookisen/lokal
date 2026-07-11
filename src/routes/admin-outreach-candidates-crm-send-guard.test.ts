/**
 * admin-outreach-candidates-crm-send-guard.test.ts — regression pins for the
 * belt-and-suspenders recipient-email suppression check added to
 * GET /admin/outreach-candidates (src/routes/admin-outreach-candidates.ts).
 *
 * Root cause of the 2026-07-11 P0 incident (dev-request
 * outreach-suppression-gate-failure-P0, confirmed live: 91 recipients
 * re-mailed on 2-4 consecutive days, e.g. post@beiarmat.no on
 * 2026-07-07/08/09): the gate's ONLY suppression signal for "already
 * contacted" was outreach_sent_log, which is populated exclusively via a
 * DB trigger that requires the sending contact's crm_contacts.agent_id to
 * already be resolved (see crm-service.ts resolveContact). When that link
 * was missing/broken, the actual Resend send still happened (visible in
 * crm_messages, queryable via GET /admin/crm/sent-log) but outreach_sent_log
 * never got the row, so the SAME producer resurfaced as "never contacted"
 * on the very next batch.
 *
 * The fix adds an INDEPENDENT check: read raw outbound marketing sends
 * (crm_messages, thread_id LIKE 'marketing-batch-%') by RECIPIENT EMAIL and
 * suppress a candidate whose email was already sent to within the cooldown
 * window — regardless of whether outreach_sent_log/agent_id linkage is
 * intact. This is the "suspenders" layer; crm-service-resolve-contact.test.ts
 * covers the root-cause "belt" fix.
 *
 * Router is exercised directly (no HTTP server, no Promise/await — the
 * handler chain here is fully synchronous), mirroring this repo's simpler
 * synchronous test convention (see crm-service.test.ts). Kept synchronous
 * deliberately: tests/test.ts serializes several tests that swap the
 * module-level DB singleton (__setDbForTesting); running async here would
 * risk interleaving with an unrelated fire-and-forget async test block.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-outreach-candidates-crm-send-guard.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminOutreachCandidatesCrmSendGuardTests() and folds its pass/fail
 *      counts into the `npm test` summary.
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

// Synchronous: the route handler under test does no async I/O (better-sqlite3
// is synchronous), so res.json() is always called before router.handle()
// returns — no need for a Promise/callback dance here.
function callRouteSync(
  router: any,
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: "GET",
    url: "/",
    query: opts.query || {},
    headers: opts.headers || {},
  };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminOutreachCandidatesCrmSendGuardTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = "admin-outreach-candidates-crm-send-guard-test-key";
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

  function insertMarketingSend(agentEmail: string, sentAtIso: string): void {
    const contactId = `contact-${agentEmail}`;
    const threadId = `marketing-batch-e1-${agentEmail}`;
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name)
      VALUES (?, 'producer', NULL, ?, ?)
    `).run(contactId, agentEmail, agentEmail);
    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category)
      VALUES (?, ?, 'Har vi info riktig?', 'innkommende')
    `).run(threadId, contactId);
    db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, subject, sent_at)
      VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, 'Har vi info riktig?', ?)
    `).run(`msg-${agentEmail}-${sentAtIso}`, threadId, JSON.stringify([agentEmail]), sentAtIso);
    // delivery_status defaults to 'sent' — matches the real ingest path
    // (POST /admin/crm/ingest -> crmService.ingestThread(), which never sets
    // delivery_status explicitly). agent_id on the contact stays NULL,
    // simulating the broken-link P0 scenario: outreach_sent_log's trigger
    // (WHEN ... AND cc.agent_id IS NOT NULL) never fires for this send.
  }

  const nowIso = new Date().toISOString();

  // ── (a) Beiarmat scenario: verified pool candidate that WAS already
  // emailed (crm_messages row, broken agent_id link) must be suppressed. ──
  insertVerifiedPoolAgent("agent-beiarmat", "Beiarmat AS", "post@beiarmat.no");
  insertMarketingSend("post@beiarmat.no", nowIso);

  // ── (b) A genuinely never-contacted verified candidate must still pass
  // through — the new check must not over-suppress. ───────────────────────
  insertVerifiedPoolAgent("agent-fresh", "Fresh Gård", "post@freshgard.no");

  // require()'d after the fixture DB is installed, matching this repo's
  // convention for route-under-test modules whose top-level code should see
  // the swapped-in test DB (see admin-db-table-sizes.test.ts).
  const router = require("./admin-outreach-candidates").default;

  const res = callRouteSync(router, {
    query: { mode: "first" },
    headers: { "x-admin-key": testKey },
  });

  assertEq(res.status, 200, "GET /admin/outreach-candidates?mode=first returns 200");
  const emails = (res.body?.candidates || []).map((c: any) => c.email);
  assertEq(
    emails.includes("post@beiarmat.no"),
    false,
    "already-emailed producer (broken agent_id link) is suppressed despite having NO outreach_sent_log row",
  );
  assertEq(
    emails.includes("post@freshgard.no"),
    true,
    "never-contacted producer is NOT over-suppressed by the new check",
  );
  assertEq(
    res.body?.suppressed_counts?.recent_crm_send_email_match,
    1,
    "suppressed_counts.recent_crm_send_email_match reflects exactly the 1 belt-and-suspenders catch",
  );
  assertEq(
    res.body?.suppressed_counts?.contacted_or_cooldown,
    0,
    "the broken-link send does NOT get counted as contacted_or_cooldown (that counter stays keyed on outreach_sent_log, unchanged)",
  );

  if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = prevAdminKey;

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAdminOutreachCandidatesCrmSendGuardTests({ log: true });
  console.log(`\nadmin-outreach-candidates-crm-send-guard: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

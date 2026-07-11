/**
 * crm-service-resolve-contact.test.ts — regression pins for the self-healing
 * fix in crmService.resolveContact() (src/services/crm-service.ts).
 *
 * Root cause of the 2026-07-11 P0 incident (dev-request
 * outreach-suppression-gate-failure-P0): a crm_contacts row that failed to
 * resolve an agent_id on its FIRST touch (e.g. the producer wasn't yet
 * `verified`/had no agent_knowledge row at that time) stayed unlinked
 * forever, because resolveContact() only re-ran classifyEmail() when the
 * contact's `type` was still 'unknown'. A contact whose type had already
 * settled to 'producer' (or 'marketing') with agent_id=NULL never got a
 * second chance.
 *
 * Consequence: the outreach_sent_log auto-record trigger (PR-38) requires
 * `cc.agent_id IS NOT NULL`. An unlinked contact's outbound marketing sends
 * NEVER populate outreach_sent_log, so the outreach_ready_pool VIEW's
 * suppression NOT EXISTS check never sees them — the producer resurfaces as
 * "never contacted" on every subsequent batch (confirmed live: 91 recipients
 * re-mailed 2-4 days running, 2026-07-04..09, e.g. post@beiarmat.no).
 *
 * The fix: resolveContact() now also retries classifyEmail() whenever the
 * EXISTING contact's agent_id is NULL (not just when type==='unknown'),
 * self-healing the link the next time the contact is touched. A contact
 * classified as 'vendor' (which legitimately never gets an agent_id) is
 * excluded from the retry to avoid pointless repeat lookups.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/crm-service-resolve-contact.test.ts
 *   2. Wired into the gate: tests/test.ts imports runCrmServiceResolveContactTests()
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

export function runCrmServiceResolveContactTests(opts: { log?: boolean } = {}): TestSummary {
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

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db);
  __initSchemaForTesting(db);

  function insertAgent(id: string, name: string, contactEmail: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, name, contactEmail, `key-${id}`);
  }

  function insertAgentKnowledgeEmail(agentId: string, email: string): void {
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, email, field_provenance)
      VALUES (?, ?, '{}')
    `).run(agentId, email);
  }

  // ── (a) The exact P0 scenario: a contact stuck at type='producer',
  // agent_id=NULL (simulating a failed first-touch resolution — e.g. the
  // agent_knowledge row didn't exist yet at first contact time). A later
  // resolveContact() call for the SAME email, after the agent_knowledge row
  // now exists, must self-heal the link. ────────────────────────────────
  {
    insertAgent("agent-beiarmat", "Beiarmat AS", "other-contact@beiarmat.no");
    insertAgentKnowledgeEmail("agent-beiarmat", "post@beiarmat.no");

    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name)
      VALUES ('contact-beiarmat', 'producer', NULL, 'post@beiarmat.no', 'Beiarmat')
    `).run();

    const result = crmService.resolveContact("post@beiarmat.no");
    assertEq(result.id, "contact-beiarmat", "stuck producer contact: resolveContact returns the SAME contact id");
    assertEq(result.created, false, "stuck producer contact: not re-created");

    const row = db.prepare("SELECT type, agent_id FROM crm_contacts WHERE id = 'contact-beiarmat'").get() as any;
    assertEq(row.type, "producer", "stuck producer contact: type stays 'producer'");
    assertEq(row.agent_id, "agent-beiarmat", "stuck producer contact: agent_id self-heals to the matching agent");
  }

  // ── (b) A contact still genuinely unresolvable (no agent_knowledge/agents
  // match at all) stays agent_id=NULL — no false-positive linking. ────────
  {
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name)
      VALUES ('contact-nomatch', 'producer', NULL, 'nomatch@nowhere.no', 'Nomatch')
    `).run();

    crmService.resolveContact("nomatch@nowhere.no");
    const row = db.prepare("SELECT type, agent_id FROM crm_contacts WHERE id = 'contact-nomatch'").get() as any;
    assertEq(row.agent_id, null, "genuinely unresolvable contact: agent_id stays NULL, no false link");
  }

  // ── (c) A 'vendor' contact (agent_id=NULL is its PERMANENT correct state)
  // is not perturbed by the retry. ─────────────────────────────────────────
  {
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name, domain)
      VALUES ('contact-vendor', 'vendor', NULL, 'billing@resend.com', 'Resend', 'resend.com')
    `).run();

    crmService.resolveContact("billing@resend.com");
    const row = db.prepare("SELECT type, agent_id FROM crm_contacts WHERE id = 'contact-vendor'").get() as any;
    assertEq(row.type, "vendor", "vendor contact: type stays 'vendor'");
    assertEq(row.agent_id, null, "vendor contact: agent_id stays NULL (expected/permanent), no wasted relink attempt");
  }

  // ── (c2) reviewer finding (2026-07-11): a contact manually tagged
  // 'marketing' (e.g. a press/partner contact whose email happens to
  // domain-match a producer, set via POST /admin/crm/contacts/:id/type) must
  // NOT get silently flipped back to 'producer' just because agent_id is
  // NULL — classifyEmail() never produces type='marketing' itself, so
  // without excluding it here every future touch would overwrite the
  // deliberate manual classification. ──────────────────────────────────────
  {
    insertAgent("agent-domain-match", "Domain-match Gård", "other2@example.no");
    insertAgentKnowledgeEmail("agent-domain-match", "press@example.no");
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name, domain)
      VALUES ('contact-marketing', 'marketing', NULL, 'press@example.no', 'Press contact', 'example.no')
    `).run();

    crmService.resolveContact("press@example.no");
    const row = db.prepare("SELECT type, agent_id FROM crm_contacts WHERE id = 'contact-marketing'").get() as any;
    assertEq(row.type, "marketing", "manually-tagged marketing contact: type is NOT overwritten back to 'producer'");
    assertEq(row.agent_id, null, "manually-tagged marketing contact: agent_id stays NULL, no forced relink");
  }

  // ── (d) Regression guard: a contact already correctly linked (agent_id
  // set) is left untouched — no unnecessary reclassification churn. ───────
  {
    insertAgent("agent-other", "Other Gård", "other@example.no");
    insertAgentKnowledgeEmail("agent-other", "post@other.no");
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name)
      VALUES ('contact-linked', 'producer', 'agent-other', 'post@other.no', 'Other')
    `).run();

    crmService.resolveContact("post@other.no");
    const row = db.prepare("SELECT type, agent_id FROM crm_contacts WHERE id = 'contact-linked'").get() as any;
    assertEq(row.agent_id, "agent-other", "already-linked contact: agent_id unchanged");
  }

  // ── (e) Pre-existing behaviour preserved: an 'unknown' contact still
  // reclassifies (including to 'vendor', agent_id legitimately null). ─────
  {
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name, domain)
      VALUES ('contact-unknown-vendor', 'unknown', NULL, 'support@resend.com', 'Resend Support', 'resend.com')
    `).run();

    crmService.resolveContact("support@resend.com");
    const row = db.prepare("SELECT type, agent_id FROM crm_contacts WHERE id = 'contact-unknown-vendor'").get() as any;
    assertEq(row.type, "vendor", "unknown->vendor reclassification still works (regression guard)");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCrmServiceResolveContactTests({ log: true });
  console.log(`\ncrm-service-resolve-contact: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

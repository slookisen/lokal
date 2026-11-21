/**
 * admin-outreach-candidates-reply-by-email.test.ts — reply suppression in
 * GET /admin/outreach-candidates must also see replies that sit on a
 * crm_contacts row which is NOT linked to the producer (agent_id NULL), by
 * matching the contact e-mail against agent_knowledge.email
 * (LOWER(TRIM()), RFB vertical only).
 *
 * Covers:
 *   AK1  an agent whose inbound reply is on an unlinked contact with the same
 *        e-mail (different case / whitespace) is NOT a candidate, in both
 *        mode=first and mode=second, and is counted in suppressed_counts.replied.
 *        Same for a retention marker (retention_last_inbound_at) with no
 *        messages left.
 *   AK2  no false suppression: an agent with no reply stays a candidate even
 *        when an unrelated contact (other e-mail) has replied, and when a
 *        same-e-mail contact exists with only outbound messages (mode=second;
 *        an outbound send makes an agent contacted, so it cannot be mode=first).
 *   AK3  a same-e-mail contact in another vertical (experiences) with an
 *        inbound reply does NOT suppress RFB outreach ("same vertical").
 *
 * Mirrors admin-outreach-candidates-max-touch-vern.test.ts's setup.
 *
 * Standalone: npx tsx src/routes/admin-outreach-candidates-reply-by-email.test.ts
 * Wired into the gate: tests/test.ts.
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
  opts: { method?: string; url?: string; query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: opts.method || "GET",
    url: opts.url || "/",
    query: opts.query || {},
    headers: opts.headers || {},
    get(name: string) {
      return (opts.headers || {})[name.toLowerCase()];
    },
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

export function runAdminOutreachCandidatesReplyByEmailTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-outreach-candidates-reply-by-email-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertVerifiedPoolAgent(id: string, email: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, `Svar ${id} AS`, email, `key-${id}`);
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, about, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed)
      VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))
    `).run(id, email, "x".repeat(200));
  }

  function insertPriorSend(agentId: string, email: string): void {
    db.prepare(`
      INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
      VALUES (?, ?, datetime('now', '-100 days'), 'email', ?, 'test:prior')
    `).run(agentId, email.toLowerCase(), `msg-${agentId}-prior`);
  }

  /** An UNLINKED contact (agent_id NULL) with messages in the given directions. */
  function insertUnlinkedContact(
    contactId: string,
    email: string,
    directions: Array<"in" | "out">,
    extra: { vertical?: string; retentionInbound?: boolean } = {},
  ): void {
    db.prepare(
      `INSERT INTO crm_contacts (id, type, agent_id, email, name, vertical_id) VALUES (?, 'producer', NULL, ?, ?, ?)`,
    ).run(contactId, email, contactId, extra.vertical ?? "rfb");
    if (extra.retentionInbound) {
      db.prepare(`UPDATE crm_contacts SET retention_last_inbound_at = datetime('now', '-800 days') WHERE id = ?`).run(
        contactId,
      );
    }
    if (directions.length === 0) return;
    const threadId = `thread-${contactId}`;
    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to)
      VALUES (?, ?, 'Svar', 'innkommende', 'in_progress', 'claude')
    `).run(threadId, contactId);
    directions.forEach((dir, i) => {
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, received_at, delivery_status)
        VALUES (?, ?, ?, ?, ?, 'Svar', 'hei', datetime('now', '-100 days'), datetime('now', '-100 days'), 'sent')
      `).run(
        `m-${contactId}-${i}`,
        threadId,
        dir,
        dir === "in" ? email.trim() : "kontakt@rettfrabonden.com",
        JSON.stringify([dir === "in" ? "kontakt@rettfrabonden.com" : email.trim()]),
      );
    });
  }

  try {
    // mode=first fixtures (never contacted)
    insertVerifiedPoolAgent("f-unlinked", "post@f-unlinked.svar-test.no");
    insertUnlinkedContact("c-f-unlinked", "  POST@F-Unlinked.svar-test.no ", ["in"]);

    insertVerifiedPoolAgent("f-retention", "post@f-retention.svar-test.no");
    insertUnlinkedContact("c-f-retention", "Post@F-Retention.svar-test.no", [], { retentionInbound: true });

    insertVerifiedPoolAgent("f-clean", "post@f-clean.svar-test.no");
    insertUnlinkedContact("c-unrelated", "someone@unrelated.svar-test.no", ["in"]);

    insertVerifiedPoolAgent("f-other-vertical", "post@f-othervert.svar-test.no");
    insertUnlinkedContact("c-f-othervert", "post@f-othervert.svar-test.no", ["in"], { vertical: "experiences" });

    // mode=second fixtures (contacted once, 100 days ago, outside a 60-day cooldown)
    insertVerifiedPoolAgent("s-unlinked", "post@s-unlinked.svar-test.no");
    insertPriorSend("s-unlinked", "post@s-unlinked.svar-test.no");
    insertUnlinkedContact("c-s-unlinked", "Post@S-Unlinked.svar-test.no  ", ["in"]);

    insertVerifiedPoolAgent("s-retention", "post@s-retention.svar-test.no");
    insertPriorSend("s-retention", "post@s-retention.svar-test.no");
    insertUnlinkedContact("c-s-retention", "POST@S-RETENTION.SVAR-TEST.NO", [], { retentionInbound: true });

    insertVerifiedPoolAgent("s-clean", "post@s-clean.svar-test.no");
    insertPriorSend("s-clean", "post@s-clean.svar-test.no");

    // Outbound-only same-e-mail contact. The cold-outreach trigger records the
    // outbound (sent 100 days ago) in outreach_sent_log, which is what makes this
    // a mode=second (follow-up) case; it must NOT read as a reply.
    insertVerifiedPoolAgent("s-outbound-only", "post@s-outbound.svar-test.no");
    insertUnlinkedContact("c-s-outbound", "POST@s-outbound.svar-test.no", ["out"]);

    const candidatesRouter = require("./admin-outreach-candidates").default;
    const auth = { "x-admin-key": testKey };

    // ══ mode=first ══════════════════════════════════════════════════════
    const first = callRouteSync(candidatesRouter, { query: { mode: "first" }, headers: auth });
    assertEq(first.status, 200, "first-0: GET mode=first -> 200");
    const firstEmails: string[] = (first.body?.candidates || []).map((c: any) => String(c.email).toLowerCase());
    assertEq(
      firstEmails.includes("post@f-unlinked.svar-test.no"),
      false,
      "AK1-first-a: reply on an unlinked same-e-mail contact (case/whitespace differ) -> not a candidate",
    );
    assertEq(
      firstEmails.includes("post@f-retention.svar-test.no"),
      false,
      "AK1-first-b: retention reply marker on an unlinked same-e-mail contact -> not a candidate",
    );
    assertEq(
      first.body?.suppressed_counts?.replied,
      2,
      "AK1-first-c: suppressed_counts.replied counts both unlinked-contact replies",
    );
    assertEq(
      firstEmails.includes("post@f-clean.svar-test.no"),
      true,
      "AK2-first-a: no reply (only an unrelated contact replied) -> still a candidate",
    );
    assertEq(
      firstEmails.includes("post@f-othervert.svar-test.no"),
      true,
      "AK3-first: same-e-mail contact in another vertical replied -> RFB candidate unaffected",
    );

    // ══ mode=second ═════════════════════════════════════════════════════
    const second = callRouteSync(candidatesRouter, {
      query: { mode: "second", cooldown_days: "60" },
      headers: auth,
    });
    assertEq(second.status, 200, "second-0: GET mode=second -> 200");
    const secondEmails: string[] = (second.body?.candidates || []).map((c: any) => String(c.email).toLowerCase());
    assertEq(
      secondEmails.includes("post@s-unlinked.svar-test.no"),
      false,
      "AK1-second-a: follow-up NOT selected when the reply sits on an unlinked same-e-mail contact",
    );
    assertEq(
      secondEmails.includes("post@s-retention.svar-test.no"),
      false,
      "AK1-second-b: follow-up NOT selected when only a retention reply marker is left",
    );
    // mode=second scans the whole pool (incl. the never-contacted f-* rows), so
    // replied = f-unlinked, f-retention, s-unlinked, s-retention. Not the
    // outbound-only or other-vertical rows.
    assertEq(
      second.body?.suppressed_counts?.replied,
      4,
      "AK1-second-c: suppressed_counts.replied counts exactly the four unlinked-contact replies",
    );
    assertEq(
      secondEmails.includes("post@s-clean.svar-test.no"),
      true,
      "AK2-second-a: contacted, no reply, past cooldown -> still a follow-up candidate",
    );
    assertEq(
      secondEmails.includes("post@s-outbound.svar-test.no"),
      true,
      "AK2-second-b: same-e-mail contact with only outbound messages -> still a follow-up candidate",
    );

    // ══ helper unit check ═══════════════════════════════════════════════
    const { loadRfbRepliedContactEmails } = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
    const replied = loadRfbRepliedContactEmails(db as any);
    assertEq(
      [...replied].sort(),
      [
        "post@f-retention.svar-test.no",
        "post@f-unlinked.svar-test.no",
        "post@s-retention.svar-test.no",
        "post@s-unlinked.svar-test.no",
        "someone@unrelated.svar-test.no",
      ],
      "helper: normalized RFB replied e-mails (no outbound-only, no other-vertical)",
    );
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAdminOutreachCandidatesReplyByEmailTests({ log: true });
  console.log(`\nadmin-outreach-candidates-reply-by-email: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

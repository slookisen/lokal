/**
 * admin-agents-duplicate-merge-history.test.ts — dev-request
 * 2026-11-22-rfb-dubletter-samme-nettsted-sammenslaaing-og-utsending, point 2
 * (AK2): POST /admin/agents/duplicate-merge carries the duplicate's CRM
 * contact / outreach history onto the survivor in the merge transaction.
 *
 * Incident shape: the farm replied from a CRM contact whose agent_id pointed
 * at the duplicate profile; after the merge the survivor's has_replied
 * (crm_contacts.agent_id = a.id → crm_threads → crm_messages 'in') found
 * nothing and the farm got a follow-up after having answered.
 *
 * Covers:
 *   h1  dry-run reports would_move counts per table and moves nothing
 *   h2  apply re-points crm_contacts.agent_id, outreach_sent_log.agent_id and
 *       rfb_marketing_send_ledger.agent_id; threads follow their contact;
 *       response `moved` counts; one merge_moved:<table> audit row per moved
 *       table with the moved ids (rollback)
 *   h3  the REAL outreach gate (GET /admin/outreach-candidates): before the
 *       merge the survivor is a follow-up (mode=second) candidate although the
 *       farm replied on the duplicate's contact; after the merge it is
 *       suppressed as replied. A send logged on the duplicate makes a
 *       never-contacted survivor drop out of mode=first after the merge.
 *   h4  survivor already has its own contact / sends / same-day ledger row:
 *       the merge does not throw, the survivor's rows are untouched and the
 *       duplicate's are added next to them (union)
 *   h5  a pair with no history: would_move / moved all zero, no merge_moved
 *       audit rows
 *
 * Fresh in-memory SQLite with the real schema, pinned as the getDb()
 * singleton for the run (computeOutreachCandidates requires it) and restored
 * after; the merge route is pointed at the same DB through its own seam.
 *
 * Standalone: npx tsx src/routes/admin-agents-duplicate-merge-history.test.ts
 * Wired into the gate: tests/test.ts.
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
}

function callRouteSync(
  router: any,
  opts: { method: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any },
): RouteResult {
  let result: RouteResult = { status: 0, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method,
    url: "/",
    originalUrl: "/",
    query: opts.query || {},
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
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminAgentsDuplicateMergeHistoryTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };

  // SHARED-GLOBAL DISCIPLINE (tests/test.ts): use the ambient admin key; set
  // one only when none exists (standalone), and restore.
  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "duplicate-merge-history-standalone-key";
  const auth = { "x-admin-key": (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string };

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  let mergeMod: typeof import("./admin-agents-duplicate-merge") | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    // Pool-eligible RFB producer (same fixture shape as
    // admin-outreach-candidates-reply-by-email.test.ts).
    function poolAgent(id: string, email: string): void {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)`,
      ).run(id, `Gård ${id} AS`, email, `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed)
         VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))`,
      ).run(id, email, "x".repeat(200));
    }
    function contact(id: string, agentId: string, email: string, inbound: boolean): void {
      db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name, vertical_id) VALUES (?, 'producer', ?, ?, ?, 'rfb')`).run(
        id,
        agentId,
        email,
        id,
      );
      if (!inbound) return;
      db.prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to)
         VALUES (?, ?, 'Svar', 'innkommende', 'in_progress', 'claude')`,
      ).run(`t-${id}`, id);
      db.prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, received_at, delivery_status)
         VALUES (?, ?, 'in', ?, '["kontakt@rettfrabonden.com"]', 'Svar', 'Takk, vi er med!', datetime('now', '-50 days'), datetime('now', '-50 days'), 'sent')`,
      ).run(`m-${id}`, `t-${id}`, email);
    }
    function sent(agentId: string, email: string, daysAgo = 100): void {
      db.prepare(
        `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
         VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior')`,
      ).run(agentId, email.toLowerCase(), `-${daysAgo} days`, `msg-${agentId}-${email}`);
    }
    function ledger(agentId: string, email: string, day: string): void {
      db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at)
         VALUES (?, 'run-test', ?, ?, 'first', 'sent', ?)`,
      ).run(day, agentId, email, `${day}T08:00:00.000Z`);
    }
    const contactAgent = (id: string) => (db.prepare(`SELECT agent_id FROM crm_contacts WHERE id = ?`).get(id) as any)?.agent_id;
    const sentLogAgents = (email: string) =>
      (db.prepare(`SELECT agent_id FROM outreach_sent_log WHERE recipient_email = ? ORDER BY id`).all(email) as any[]).map((r) => r.agent_id);
    const ledgerAgent = (email: string) =>
      (db.prepare(`SELECT agent_id FROM rfb_marketing_send_ledger WHERE recipient_email = ?`).get(email) as any)?.agent_id;
    const threadAgent = (threadId: string) =>
      (db.prepare(`SELECT c.agent_id AS a FROM crm_threads t JOIN crm_contacts c ON c.id = t.contact_id WHERE t.id = ?`).get(threadId) as any)?.a;
    const movedAudit = (dupId: string) =>
      db
        .prepare(`SELECT field_name, old_value, new_value, notes FROM agent_knowledge_audit WHERE agent_id = ? AND field_name LIKE 'merge_moved:%' ORDER BY rowid`)
        .all(dupId) as Array<{ field_name: string; old_value: string; new_value: string; notes: string }>;

    // ── fixtures ────────────────────────────────────────────────────────
    // Aimees-like farm: survivor mailed 100 days ago (first touch, by its own
    // address); the farm answered from another address on a contact linked to
    // the duplicate profile, where the RFB job also logged a send.
    poolAgent("hm-surv", "post@aimee-surv.example.no");
    sent("hm-surv", "post@aimee-surv.example.no");
    poolAgent("hm-dup", "post@aimee-dup.example.no");
    contact("hm-c-dup", "hm-dup", "aimee.gard@svar.example.no", true);
    sent("hm-dup", "aimee.gard@svar.example.no", 90);
    ledger("hm-dup", "aimee.gard@svar.example.no", "2026-08-24");

    // Never-contacted survivor; the duplicate carries the only send.
    poolAgent("hm-first-surv", "post@first-surv.example.no");
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
       VALUES ('hm-first-dup', 'Gård hm-first-dup AS', 'dup', 'test', '', 'https://example.no', 'producer', 'key-hm-first-dup')`,
    ).run();
    sent("hm-first-dup", "annen@first-dup.example.no", 10);

    // Survivor with its own history (union / no-conflict case).
    poolAgent("hm-u-surv", "post@u-surv.example.no");
    contact("hm-c-u-surv", "hm-u-surv", "post@u-surv.example.no", true);
    sent("hm-u-surv", "post@u-surv.example.no");
    ledger("hm-u-surv", "post@u-surv.example.no", "2026-09-01");
    poolAgent("hm-u-dup", "post@u-dup.example.no");
    contact("hm-c-u-dup", "hm-u-dup", "post@u-dup.example.no", true);
    contact("hm-c-u-dup2", "hm-u-dup", "kontor@u-dup.example.no", false);
    sent("hm-u-dup", "post@u-dup.example.no");
    ledger("hm-u-dup", "post@u-dup.example.no", "2026-09-01");

    // No history at all.
    poolAgent("hm-n-surv", "post@n-surv.example.no");
    poolAgent("hm-n-dup", "post@n-dup.example.no");

    delete require.cache[require.resolve("./admin-agents-duplicate-merge")];
    mergeMod = require("./admin-agents-duplicate-merge") as typeof import("./admin-agents-duplicate-merge");
    mergeMod.__setDuplicateMergeDbForTesting(db as any);
    const mergeRouter = mergeMod.default;
    const candidatesRouter = require("./admin-outreach-candidates").default;

    const merge = (survivor_id: string, duplicate_id: string, apply: boolean) =>
      callRouteSync(mergeRouter, {
        method: "POST",
        headers: auth,
        body: { pairs: [{ survivor_id, duplicate_id, reason: "same_website_duplicate" }] },
        query: apply ? { apply: "1" } : {},
      });
    const candidateIds = (mode: "first" | "second"): string[] => {
      const r = callRouteSync(candidatesRouter, { method: "GET", headers: auth, query: { mode, cooldown_days: "60" } });
      return (r.body?.candidates || []).map((c: any) => c.agent_id);
    };

    // ── h3 (before): the gap the incident fell into ──────────────────────
    eq(candidateIds("second").includes("hm-surv"), true, "h3-pre: before the merge the survivor is a follow-up candidate (reply sits on the duplicate's contact)");
    eq(candidateIds("first").includes("hm-first-surv"), true, "h3-pre: before the merge the never-contacted survivor is a first-touch candidate");

    // ── h1: dry-run ──────────────────────────────────────────────────────
    let r = merge("hm-surv", "hm-dup", false);
    eq(r.body?.results?.[0]?.outcome, "would_merge", "h1: dry-run outcome would_merge");
    eq(
      r.body?.results?.[0]?.would_move,
      { crm_contacts: 1, crm_threads: 1, outreach_sent_log: 1, rfb_marketing_send_ledger: 1 },
      "h1: dry-run reports would_move per table",
    );
    eq("moved" in (r.body?.results?.[0] ?? {}), false, "h1: dry-run carries no `moved`");
    eq(
      [contactAgent("hm-c-dup"), sentLogAgents("aimee.gard@svar.example.no"), ledgerAgent("aimee.gard@svar.example.no")],
      ["hm-dup", ["hm-dup"], "hm-dup"],
      "h1: dry-run moved nothing",
    );
    eq(movedAudit("hm-dup").length, 0, "h1: dry-run wrote no merge_moved audit rows");

    // ── h2: apply ────────────────────────────────────────────────────────
    r = merge("hm-surv", "hm-dup", true);
    eq(r.body?.results?.[0]?.outcome, "merged", "h2: apply outcome merged");
    eq(
      r.body?.results?.[0]?.moved,
      { crm_contacts: 1, crm_threads: 1, outreach_sent_log: 1, rfb_marketing_send_ledger: 1 },
      "h2: apply reports moved per table",
    );
    eq("would_move" in (r.body?.results?.[0] ?? {}), false, "h2: apply carries no `would_move`");
    eq(contactAgent("hm-c-dup"), "hm-surv", "h2: crm_contacts.agent_id re-pointed to the survivor");
    eq(threadAgent("t-hm-c-dup"), "hm-surv", "h2: the reply thread now resolves to the survivor via its contact");
    eq(sentLogAgents("aimee.gard@svar.example.no"), ["hm-surv"], "h2: outreach_sent_log.agent_id re-pointed");
    eq(ledgerAgent("aimee.gard@svar.example.no"), "hm-surv", "h2: rfb_marketing_send_ledger.agent_id re-pointed");
    const audit = movedAudit("hm-dup");
    eq(
      audit.map((a) => a.field_name),
      ["merge_moved:crm_contacts", "merge_moved:crm_threads", "merge_moved:outreach_sent_log", "merge_moved:rfb_marketing_send_ledger"],
      "h2: one merge_moved audit row per moved table (on the duplicate)",
    );
    eq([audit[0]?.old_value, audit[0]?.new_value], ["hm-dup", "hm-surv"], "h2: audit old/new = duplicate/survivor");
    const notes0 = JSON.parse(audit[0]?.notes ?? "{}");
    eq([notes0.count, notes0.ids, notes0.reason], [1, ["hm-c-dup"], "same_website_duplicate"], "h2: audit notes carry count + moved ids + reason");

    // ── h3 (after): the real gate now blocks the follow-up ───────────────
    eq(candidateIds("second").includes("hm-surv"), false, "h3: after the merge the survivor is suppressed as replied (no follow-up)");

    r = merge("hm-first-surv", "hm-first-dup", true);
    eq(r.body?.results?.[0]?.moved?.outreach_sent_log, 1, "h3: duplicate's send moved");
    eq(candidateIds("first").includes("hm-first-surv"), false, "h3: after the merge the survivor counts as contacted (not first-touch)");

    // ── h4: survivor has its own history → union, no throw ───────────────
    r = merge("hm-u-surv", "hm-u-dup", true);
    eq(r.body?.results?.[0]?.outcome, "merged", "h4: merge with history on both sides does not fail");
    eq(
      r.body?.results?.[0]?.moved,
      { crm_contacts: 2, crm_threads: 1, outreach_sent_log: 1, rfb_marketing_send_ledger: 1 },
      "h4: all of the duplicate's rows moved",
    );
    eq(
      (db.prepare(`SELECT id FROM crm_contacts WHERE agent_id = 'hm-u-surv' ORDER BY id`).all() as any[]).map((x) => x.id),
      ["hm-c-u-dup", "hm-c-u-dup2", "hm-c-u-surv"],
      "h4: survivor keeps its own contact and gains the duplicate's (union)",
    );
    eq(
      (db.prepare(`SELECT email FROM crm_contacts WHERE id = 'hm-c-u-surv'`).get() as any)?.email,
      "post@u-surv.example.no",
      "h4: survivor's own contact untouched",
    );
    eq(
      (db.prepare(`SELECT COUNT(*) AS n FROM rfb_marketing_send_ledger WHERE agent_id = 'hm-u-surv' AND day = '2026-09-01'`).get() as any).n,
      2,
      "h4: same-day ledger rows for both addresses sit on the survivor (UNIQUE(day, recipient_email) not hit)",
    );
    eq((db.prepare(`SELECT is_active, merged_into FROM agents WHERE id = 'hm-u-dup'`).get() as any), { is_active: 0, merged_into: "hm-u-surv" }, "h4: duplicate deactivated as before");

    // ── h5: nothing to move ──────────────────────────────────────────────
    r = merge("hm-n-surv", "hm-n-dup", false);
    eq(r.body?.results?.[0]?.would_move, { crm_contacts: 0, crm_threads: 0, outreach_sent_log: 0, rfb_marketing_send_ledger: 0 }, "h5: dry-run zero counts");
    r = merge("hm-n-surv", "hm-n-dup", true);
    eq(r.body?.results?.[0]?.moved, { crm_contacts: 0, crm_threads: 0, outreach_sent_log: 0, rfb_marketing_send_ledger: 0 }, "h5: apply zero counts");
    eq(movedAudit("hm-n-dup").length, 0, "h5: no merge_moved audit rows when nothing moved");
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    if (mergeMod) mergeMod.__setDuplicateMergeDbForTesting(null);
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  const s = runAdminAgentsDuplicateMergeHistoryTests({ log: true });
  console.log(`\nadmin-agents-duplicate-merge-history: ${s.passed} passed, ${s.failed} failed`);
  if (s.failed) for (const f of s.failures) console.log(f);
  process.exit(s.failed ? 1 : 0);
}

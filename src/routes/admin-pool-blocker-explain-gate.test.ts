/**
 * admin-pool-blocker-explain-gate.test.ts — tests for dev-request
 * 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-gate-felt, punkt 2:
 * GET /admin/pool-blocker-explain now reports a `gate` object per agent
 * (`blocklisted`, `recent_crm_send_email_match`, `cross_platform_cooldown`),
 * computed via the SAME helpers the real gate
 * (GET /admin/outreach-candidates?mode=first) uses — isBlocked()
 * (blocklist-service.ts) and getRecentlyEmailedAddresses() /
 * getCrossPlatformSuppressors() (outreach-suppression-signals.ts) — never a
 * parallel reimplementation.
 *
 * Covers:
 *   (a) blocklisted: an agent_id on agent_blocklist -> gate.blocklisted=true
 *       here AND excluded by the real gate's own suppressed_counts.blocklisted.
 *   (b) recent_crm_send_email_match: a cold crm_messages send to the row's
 *       email within the cooldown window -> gate.recent_crm_send_email_match
 *       =true here AND excluded by the real gate's own
 *       suppressed_counts.recent_crm_send_email_match.
 *   (c) cross_platform_cooldown: an outreach_sent_log row for the SAME email
 *       under a non-'rfb' vertical, within cooldown -> gate.cross_platform_
 *       cooldown=true here AND excluded by the real gate's own
 *       cross_platform_cooldown.count.
 *   (d) a clean row -> all 3 gate fields false.
 *   (e) ?cooldown_days= override changes gate.recent_crm_send_email_match
 *       (a send outside the shorter window is no longer flagged), and the
 *       response echoes cooldown_days_used.
 *
 * Wired into tests/test.ts (runSerial), same convention as
 * admin-run-verifier-drain-observability.test.ts.
 * Standalone: npx tsx src/routes/admin-pool-blocker-explain-gate.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function callRouteSync(
  router: any,
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): { status: number; body: any } {
  let result: { status: number; body: any } = { status: 200, body: undefined };
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

export function runAdminPoolBlockerExplainGateTests(opts: { log?: boolean } = {}): TestSummary {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "pbe-gate-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    // Fresh module instances so each route sees the swapped-in test DB at
    // its own top-level require time (matches admin-pool-blocker-explain.test.ts).
    const explainPath = require.resolve("../routes/admin-pool-blocker-explain");
    delete require.cache[explainPath];
    const explainRouter = (require("../routes/admin-pool-blocker-explain") as
      typeof import("../routes/admin-pool-blocker-explain")).default;

    const candidatesPath = require.resolve("../routes/admin-outreach-candidates");
    delete require.cache[candidatesPath];
    const candidatesRouter = (require("../routes/admin-outreach-candidates") as
      typeof import("../routes/admin-outreach-candidates")).default;

    const explainLayer = (explainRouter as any).stack.find(
      (l: any) => l.route && l.route.path === "/" && l.route.methods && l.route.methods.get,
    );
    const explainHandler = explainLayer.route.stack[0].handle;

    function callExplain(query: Record<string, string>): { status: number; body: any } {
      const res = fakeRes();
      explainHandler({ headers: { "x-admin-key": ADMIN_KEY }, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function callCandidatesFirst(): { status: number; body: any } {
      return callRouteSync(candidatesRouter, {
        query: { mode: "first" },
        headers: { "x-admin-key": ADMIN_KEY },
      });
    }

    // ── Fixture helpers — a fully outreach_ready_pool-eligible row, mirroring
    // admin-outreach-candidates-crm-send-guard.test.ts's insertVerifiedPoolAgent ──
    function insertPoolEligibleAgent(id: string, name: string, email: string): void {
      testDb.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
        VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
      `).run(id, name, email, `key-${id}`);
      testDb.prepare(`
        INSERT INTO agent_knowledge
          (agent_id, email, about, field_provenance, verification_status, enrichment_status,
           url_last_status, url_last_probed)
        VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))
      `).run(id, email, "x".repeat(200));
    }

    function insertColdCrmSend(agentEmail: string, sentAtIso: string): void {
      const contactId = `contact-${agentEmail}`;
      const threadId = `compose-${agentEmail}`;
      testDb.prepare(`
        INSERT INTO crm_contacts (id, type, agent_id, email, name)
        VALUES (?, 'producer', NULL, ?, ?)
      `).run(contactId, agentEmail, agentEmail);
      testDb.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category)
        VALUES (?, ?, 'Har vi info riktig?', 'innkommende')
      `).run(threadId, contactId);
      testDb.prepare(`
        INSERT INTO crm_messages
          (id, thread_id, direction, from_email, to_emails, subject, sent_at)
        VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, 'Har vi info riktig?', ?)
      `).run(`msg-${agentEmail}-${sentAtIso}`, threadId, JSON.stringify([agentEmail]), sentAtIso);
      // The v2 trigger auto-heals this into outreach_sent_log (agent_id via
      // agent_knowledge.email) — delete it so this fixture isolates the
      // belt-and-suspenders recent-crm-send check, same convention as
      // admin-outreach-candidates-crm-send-guard.test.ts's insertMarketingSend.
      testDb.prepare(`DELETE FROM outreach_sent_log WHERE LOWER(recipient_email) = LOWER(?)`).run(agentEmail);
    }

    function insertCrossPlatformSend(otherAgentId: string, recipientEmail: string, sentAtIso: string, vertical: string): void {
      testDb.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
        VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.no', 'producer', ?, ?)
      `).run(otherAgentId, `${otherAgentId} AS`, `key-${otherAgentId}`, vertical);
      testDb.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
        VALUES (?, LOWER(?), ?, 'email', ?)
      `).run(otherAgentId, recipientEmail, sentAtIso, vertical);
    }

    const nowIso = new Date().toISOString();
    const daysAgoIso = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

    // ── (a) blocklisted ──────────────────────────────────────────────────
    insertPoolEligibleAgent("gate-blocked", "Blokkert Gard", "post@blokkertgard.no");
    testDb.prepare(
      `INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('agent_id', ?, 'test')`,
    ).run("gate-blocked".toLowerCase());

    {
      const rExplain = callExplain({ agentId: "gate-blocked" });
      assertEq(rExplain.status, 200, "a1: 200 response");
      assertEq(rExplain.body.agents[0].gate.blocklisted, true, "a2: gate.blocklisted=true for a blocklisted agent_id");
      assertEq(rExplain.body.agents[0].gate.recent_crm_send_email_match, false, "a3: the other 2 gate reasons stay false");
      assertEq(rExplain.body.agents[0].gate.cross_platform_cooldown, false, "a4: cross_platform_cooldown stays false");

      const rCand = callCandidatesFirst();
      const emails = (rCand.body?.candidates || []).map((c: any) => c.email);
      assertTrue(
        !emails.includes("post@blokkertgard.no"),
        "a5: the real gate (mode=first) also excludes this row via the blocklist",
      );
      assertTrue((rCand.body?.suppressed_counts?.blocklisted ?? 0) >= 1, "a6: real gate's own blocklisted counter caught it too");
    }

    // ── (b) recent_crm_send_email_match ──────────────────────────────────
    insertPoolEligibleAgent("gate-crmsend", "CRM-sendt Gard", "post@crmsendtgard.no");
    insertColdCrmSend("post@crmsendtgard.no", nowIso);

    {
      const rExplain = callExplain({ agentId: "gate-crmsend" });
      assertEq(rExplain.body.agents[0].gate.recent_crm_send_email_match, true, "b1: gate.recent_crm_send_email_match=true");
      assertEq(rExplain.body.agents[0].gate.blocklisted, false, "b2: blocklisted stays false for this row");

      const rCand = callCandidatesFirst();
      const emails = (rCand.body?.candidates || []).map((c: any) => c.email);
      assertTrue(
        !emails.includes("post@crmsendtgard.no"),
        "b3: the real gate (mode=first) also excludes this row via the belt-and-suspenders check",
      );
      assertTrue(
        (rCand.body?.suppressed_counts?.recent_crm_send_email_match ?? 0) >= 1,
        "b4: real gate's own recent_crm_send_email_match counter caught it too",
      );
    }

    // ── (c) cross_platform_cooldown ──────────────────────────────────────
    insertPoolEligibleAgent("gate-crossplat", "Kryssplattform Gard", "post@kryssplattformgard.no");
    insertCrossPlatformSend("other-vertical-agent-1", "post@kryssplattformgard.no", nowIso, "opplevagent");

    {
      const rExplain = callExplain({ agentId: "gate-crossplat" });
      assertEq(rExplain.body.agents[0].gate.cross_platform_cooldown, true, "c1: gate.cross_platform_cooldown=true");
      assertEq(rExplain.body.agents[0].gate.blocklisted, false, "c2: blocklisted stays false for this row");
      assertEq(rExplain.body.agents[0].gate.recent_crm_send_email_match, false, "c3: recent_crm_send_email_match stays false for this row");

      const rCand = callCandidatesFirst();
      const emails = (rCand.body?.candidates || []).map((c: any) => c.email);
      assertTrue(
        !emails.includes("post@kryssplattformgard.no"),
        "c4: the real gate (mode=first) also excludes this row via cross-platform cooldown",
      );
      assertTrue(
        (rCand.body?.cross_platform_cooldown?.count ?? 0) >= 1,
        "c5: real gate's own cross_platform_cooldown.count caught it too",
      );
    }

    // ── (d) a clean row -> all 3 gate fields false ───────────────────────
    insertPoolEligibleAgent("gate-clean", "Ren Gard", "post@rengard.no");
    {
      const rExplain = callExplain({ agentId: "gate-clean" });
      assertEq(
        rExplain.body.agents[0].gate,
        { blocklisted: false, recent_crm_send_email_match: false, cross_platform_cooldown: false },
        "d1: a fully clean row reports all 3 gate reasons as false",
      );

      const rCand = callCandidatesFirst();
      const emails = (rCand.body?.candidates || []).map((c: any) => c.email);
      assertTrue(emails.includes("post@rengard.no"), "d2: the real gate admits the clean row as a candidate");
    }

    // ── (e) ?cooldown_days= override + cooldown_days_used echo ───────────
    insertPoolEligibleAgent("gate-cooldown40", "Cooldown40 Gard", "post@cooldown40gard.no");
    insertColdCrmSend("post@cooldown40gard.no", daysAgoIso(40));

    {
      const rDefault = callExplain({ agentId: "gate-cooldown40" });
      assertEq(rDefault.body.cooldown_days_used, 60, "e1: default cooldown_days_used=60 (matches the real gate's own default)");
      assertEq(
        rDefault.body.agents[0].gate.recent_crm_send_email_match, true,
        "e2: a 40-day-old send IS inside the default 60-day cooldown -> flagged",
      );

      const rShort = callExplain({ agentId: "gate-cooldown40", cooldown_days: "30" });
      assertEq(rShort.body.cooldown_days_used, 30, "e3: cooldown_days_used echoes the override");
      assertEq(
        rShort.body.agents[0].gate.recent_crm_send_email_match, false,
        "e4: the SAME 40-day-old send is OUTSIDE a 30-day override window -> no longer flagged",
      );
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-pool-blocker-explain-gate: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const summary = runAdminPoolBlockerExplainGateTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

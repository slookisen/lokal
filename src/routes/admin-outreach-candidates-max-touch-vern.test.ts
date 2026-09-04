/**
 * admin-outreach-candidates-max-touch-vern.test.ts — regression pins for
 * dev-request 2026-08-29-outreach-max-touch-vern's Part A: the mode=second
 * exclusion in GET /admin/outreach-candidates (src/routes/admin-outreach-
 * candidates.ts).
 *
 * Daniel, live, after a CRM audit found 99 addresses stuck in repeat-send
 * with zero inbound reply ever: never send new cold outreach to an address
 * that already has >= threshold outreach_sent_log rows (any vertical) AND
 * no reply ever. mode=second is the ONLY mode this can ever fire on
 * (mode=first is guaranteed 0 prior sends by construction).
 *
 * Covers:
 *   (1) an address with 3 prior sends and 0 inbound is EXCLUDED from
 *       mode=second candidates, and surfaced explicitly (never silently
 *       dropped) as suppressed_counts.max_touch_suppressed +
 *       max_touch_suppressed.producers, reason "max_touch_suppressed".
 *   (2) boundary: an address with 3 prior sends AND 1 inbound reply is NOT
 *       suppressed by max-touch-vern (an unrelated address below threshold
 *       stays a normal candidate, proving over-suppression didn't happen).
 *   (3) an address with only 2 prior sends (below the default threshold 3)
 *       is NOT suppressed.
 *   (4) mode=first is completely unaffected — a fresh (never-contacted)
 *       agent is unaffected by the config even if the knob is misconfigured.
 *   (5) the admin lever (GET/POST /admin/outreach-max-touch-vern) changes
 *       the threshold live, no restart: lowering it from 3 to 2 suppresses
 *       a previously-eligible 2-prior-sends address on the very next call.
 *   (6) enabled:false turns the suppression off entirely, even for an
 *       address that would otherwise qualify.
 *
 * Mirrors admin-outreach-candidates-mode2-ordering.test.ts's setup (real
 * init.ts schema, __setDbForTesting + __initSchemaForTesting, router.handle()
 * exercised directly, synchronous).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-outreach-candidates-max-touch-vern.test.ts
 *   2. Wired into the gate: tests/test.ts.
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
  opts: { method?: string; url?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: opts.method || "GET",
    url: opts.url || "/",
    query: opts.query || {},
    headers: opts.headers || {},
    body: opts.body,
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

export function runAdminOutreachCandidatesMaxTouchVernTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-outreach-candidates-max-touch-vern-test-key";
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
    // dev-request 2026-09-02-rfb-pool-view-rich-vs-partial: outreach_ready_pool
    // now ALSO requires POOL_CONTENT_THRESHOLD_SQL (about>=80 chars OR
    // products>=3) against the raw columns, not just enrichment_status='rich'
    // — an explicit about text keeps this synthetic fixture pool-eligible
    // (this test is about max-touch-vern, not content depth).
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, about, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed)
      VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))
    `).run(id, email, "x".repeat(200));
  }

  // Prior contacts recorded in outreach_sent_log — mode=second's cooldown/
  // count source. All far outside the cooldown window (150 days) so ONLY
  // max-touch-vern (not the cooldown check) governs eligibility here.
  function insertPriorContacts(agentId: string, email: string, count: number, daysAgoStart: number): void {
    for (let i = 0; i < count; i++) {
      db.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
        VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior')
      `).run(agentId, email.toLowerCase(), `-${daysAgoStart + i} days`, `msg-${agentId}-${i}`);
    }
  }

  function insertInboundReply(agentId: string, email: string): void {
    const contactId = `c-${agentId}`;
    const threadId = `thread-${agentId}`;
    db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run(contactId, "producer", agentId, email, agentId);
    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to)
      VALUES (?,?,?,?,?,?)
    `).run(threadId, contactId, "Svar", "innkommende", "in_progress", "claude");
    db.prepare(`
      INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, received_at, delivery_status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(`m-${agentId}-in`, threadId, "in", email, JSON.stringify(["kontakt@rettfrabonden.com"]), "Svar", "hei", "2026-05-01T00:00:00Z", "sent");
  }

  try {
    // ── (1) 3 prior sends, 0 inbound -> suppressed (default threshold 3) ──
    insertVerifiedPoolAgent("mt-suppressed", "MaxTouch Suppressed AS", "suppressed@mtv-test.no");
    insertPriorContacts("mt-suppressed", "suppressed@mtv-test.no", 3, 100);

    // ── (2) 3 prior sends, 1 inbound reply -> NOT suppressed (reply lifts it) ──
    insertVerifiedPoolAgent("mt-replied", "MaxTouch Replied AS", "replied@mtv-test.no");
    insertPriorContacts("mt-replied", "replied@mtv-test.no", 3, 100);
    insertInboundReply("mt-replied", "replied@mtv-test.no");

    // ── (3) 2 prior sends (below threshold), 0 inbound -> NOT suppressed ──
    insertVerifiedPoolAgent("mt-below", "MaxTouch Below AS", "below@mtv-test.no");
    insertPriorContacts("mt-below", "below@mtv-test.no", 2, 100);

    // ══ pure classifier boundary check (unambiguous, no other suppression
    // bucket in the way): 3 sends + 1 inbound reply -> NOT suppressed. ══════
    const maxTouchSvc = require("../services/outreach-max-touch-vern") as typeof import("../services/outreach-max-touch-vern");
    assertEq(
      maxTouchSvc.computeMaxTouchSuppressed(3, true, { enabled: true, threshold: 3 }),
      false,
      "0a: computeMaxTouchSuppressed(3 sends, hasInboundEver:true, threshold:3) -> false (reply always wins)",
    );
    assertEq(
      maxTouchSvc.computeMaxTouchSuppressed(3, false, { enabled: true, threshold: 3 }),
      true,
      "0b: computeMaxTouchSuppressed(3 sends, hasInboundEver:false, threshold:3) -> true (the suppression itself)",
    );
    assertEq(
      maxTouchSvc.computeMaxTouchSuppressed(2, false, { enabled: true, threshold: 3 }),
      false,
      "0c: computeMaxTouchSuppressed(2 sends, hasInboundEver:false, threshold:3) -> false (below threshold)",
    );
    assertEq(
      maxTouchSvc.computeMaxTouchSuppressed(5, false, { enabled: false, threshold: 3 }),
      false,
      "0d: computeMaxTouchSuppressed(…, enabled:false) -> false regardless of count",
    );

    const candidatesRouter = require("./admin-outreach-candidates").default;
    const maxTouchVernRouter = require("./admin-outreach-max-touch-vern").default;
    const auth = { "x-admin-key": testKey };

    // ══ (1)+(2)+(3): default config (enabled:true, threshold:3) ═══════════
    const res1 = callRouteSync(candidatesRouter, {
      query: { mode: "second", cooldown_days: "60" },
      headers: auth,
    });
    assertEq(res1.status, 200, "1a: GET mode=second -> 200");
    const emails1 = (res1.body?.candidates || []).map((c: any) => c.email.toLowerCase());

    assertEq(
      emails1.includes("suppressed@mtv-test.no"),
      false,
      "1b: 3 prior sends + 0 inbound -> excluded from mode=second candidates",
    );
    // NOTE: replied@mtv-test.no is excluded from `candidates` regardless of
    // max-touch-vern — this gate ALSO has a pre-existing, independent
    // suppressedForReplied bucket (row.has_replied) that excludes any address
    // with an inbound message, for a different reason (a replied producer is
    // a live conversation, routed through CRM, not a cold-outreach target at
    // all). The boundary this test proves is narrower and specific to
    // max-touch-vern: the address must NOT be attributed to
    // max_touch_suppressed — it is legitimately excluded for "replied",
    // never double-counted or mis-reasoned as "max_touch_suppressed".
    const maxTouchEmails = (res1.body?.max_touch_suppressed?.producers || []).map((p: any) => p.email.toLowerCase());
    assertEq(
      maxTouchEmails.includes("replied@mtv-test.no"),
      false,
      "2a: 3 prior sends + 1 inbound reply -> NOT attributed to max_touch_suppressed (reply lifts THAT suppression; " +
        "it is excluded for the separate, pre-existing 'replied' reason instead — see suppressed_counts.replied)",
    );
    assertEq(
      (res1.body?.suppressed_counts?.replied ?? 0) >= 1,
      true,
      "2b: suppressed_counts.replied reflects the replied@mtv-test.no catch (the actual, unrelated reason)",
    );
    assertEq(
      emails1.includes("below@mtv-test.no"),
      true,
      "3a: 2 prior sends (below threshold 3) -> NOT suppressed, stays a candidate",
    );

    // Never silently dropped — visible reason in the response.
    assertEq(
      res1.body?.suppressed_counts?.max_touch_suppressed,
      1,
      "1c: suppressed_counts.max_touch_suppressed reflects exactly the 1 catch",
    );
    assertEq(
      res1.body?.max_touch_suppressed?.count,
      1,
      "1d: max_touch_suppressed.count === 1",
    );
    const producer1 = (res1.body?.max_touch_suppressed?.producers || [])[0];
    assertEq(producer1?.email, "suppressed@mtv-test.no", "1e: max_touch_suppressed.producers names the address");
    assertEq(producer1?.reason, "max_touch_suppressed", "1f: producer entry carries reason:max_touch_suppressed");
    assertEq(producer1?.send_count, 3, "1g: producer entry carries send_count:3");
    assertEq(producer1?.threshold, 3, "1h: producer entry carries threshold:3");

    // ══ (4) mode=first completely unaffected ══════════════════════════════
    insertVerifiedPoolAgent("mt-firsttouch", "MaxTouch First Touch AS", "firsttouch@mtv-test.no");
    const res1First = callRouteSync(candidatesRouter, { query: { mode: "first" }, headers: auth });
    assertEq(res1First.status, 200, "4a: GET mode=first -> 200");
    const firstEmails = (res1First.body?.candidates || []).map((c: any) => c.email.toLowerCase());
    assertEq(
      firstEmails.includes("firsttouch@mtv-test.no"),
      true,
      "4b: a never-contacted agent is unaffected by max-touch-vern in mode=first",
    );
    assertEq(
      res1First.body?.suppressed_counts?.max_touch_suppressed,
      0,
      "4c: mode=first reports 0 max_touch_suppressed (by definition — 0 prior sends)",
    );

    // ══ (5) the admin lever moves the threshold live, no restart ═════════
    const lowerThreshold = callRouteSync(maxTouchVernRouter, {
      method: "POST",
      headers: auth,
      body: { threshold: 2, apply: true },
    });
    assertEq(lowerThreshold.status, 200, "5a: POST /admin/outreach-max-touch-vern threshold:2 apply:true -> 200");
    assertEq(lowerThreshold.body?.config?.threshold, 2, "5b: config.threshold persisted as 2");

    const res2 = callRouteSync(candidatesRouter, {
      query: { mode: "second", cooldown_days: "60" },
      headers: auth,
    });
    const emails2 = (res2.body?.candidates || []).map((c: any) => c.email.toLowerCase());
    assertEq(
      emails2.includes("below@mtv-test.no"),
      false,
      "5c: with threshold lowered to 2, the 2-prior-sends address is NOW suppressed — SAME process, no restart",
    );

    // ══ (6) enabled:false turns the suppression off entirely ══════════════
    const disable = callRouteSync(maxTouchVernRouter, {
      method: "POST",
      headers: auth,
      body: { enabled: false, apply: true },
    });
    assertEq(disable.status, 200, "6a: POST enabled:false apply:true -> 200");
    assertEq(disable.body?.config?.enabled, false, "6b: config.enabled false persisted");

    const res3 = callRouteSync(candidatesRouter, {
      query: { mode: "second", cooldown_days: "60" },
      headers: auth,
    });
    const emails3 = (res3.body?.candidates || []).map((c: any) => c.email.toLowerCase());
    assertEq(
      emails3.includes("suppressed@mtv-test.no"),
      true,
      "6c: with the gate disabled, even the 3-prior-sends/0-inbound address stays a candidate",
    );
    assertEq(
      res3.body?.suppressed_counts?.max_touch_suppressed,
      0,
      "6d: suppressed_counts.max_touch_suppressed is 0 while disabled",
    );

    // Restore for cleanliness.
    callRouteSync(maxTouchVernRouter, {
      method: "POST",
      headers: auth,
      body: { enabled: true, threshold: 3, apply: true },
    });

    // ══ GET/POST /admin/outreach-max-touch-vern lever basics ══════════════
    const freshDb = new Database(":memory:");
    __setDbForTesting(freshDb as any);
    __initSchemaForTesting(freshDb as any);
    delete require.cache[require.resolve("./admin-outreach-max-touch-vern")];
    const freshRouter = require("./admin-outreach-max-touch-vern").default;

    const noKeyGet = callRouteSync(freshRouter, { method: "GET" });
    assertEq(noKeyGet.status, 403, "L1: GET without X-Admin-Key -> 403");
    const noKeyPost = callRouteSync(freshRouter, { method: "POST", body: { threshold: 5 } });
    assertEq(noKeyPost.status, 403, "L2: POST without X-Admin-Key -> 403");

    const defaultGet = callRouteSync(freshRouter, { method: "GET", headers: auth });
    assertEq(defaultGet.status, 200, "L3: GET -> 200");
    assertEq(defaultGet.body?.config?.enabled, true, "L4: default enabled:true (Daniel's order IS the on-decision)");
    assertEq(defaultGet.body?.config?.threshold, 3, "L5: default threshold:3");
    assertEq(defaultGet.body?.config?.is_default, true, "L6: is_default:true before any write");

    const dryRun = callRouteSync(freshRouter, { method: "POST", headers: auth, body: { threshold: 5 } });
    assertEq(dryRun.status, 200, "L7: POST without apply -> 200");
    assertEq(dryRun.body?.dry_run, true, "L8: dry_run:true when apply is omitted");
    assertEq(dryRun.body?.would_be?.threshold, 5, "L9: would_be.threshold reflects the proposed value");
    const confirmNoWrite = callRouteSync(freshRouter, { method: "GET", headers: auth });
    assertEq(confirmNoWrite.body?.config?.threshold, 3, "L10: dry-run wrote NOTHING — threshold still 3");

    // Restore singleton db for anything running after this block in the same process.
    __setDbForTesting(db as any);
  } catch (err) {
    failed++;
    failures.push(`max-touch-vern: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    delete require.cache[require.resolve("./admin-outreach-max-touch-vern")];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAdminOutreachCandidatesMaxTouchVernTests({ log: true });
  console.log(`\nadmin-outreach-candidates-max-touch-vern: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

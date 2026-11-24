/**
 * admin-outreach-candidates-sibling-domain.test.ts — dev-request
 * 2026-11-22-rfb-dubletter-samme-nettsted-sammenslaaing-og-utsending, point 4
 * (AK4): "the outreach gate sees the whole group".
 *
 * A profile is held back when ANOTHER active RFB profile on the same
 * registrable website domain has replied, opted out / is blocklisted, or was
 * sent to inside cooldown_days. Enforced only with
 * RFB_OUTREACH_SIBLING_DOMAIN_HOLD_ENABLED (default OFF); the shadow block
 * `sibling_domain_shadow` is returned regardless.
 *
 *   on:  replied / recently sent (sent log + send ledger) / opted-out /
 *        blocklisted sibling holds the profile, with its own
 *        suppressed_counts.sibling_domain_<reason>.
 *   no false hold: a profile without such siblings, a sibling sent to before
 *        the cooldown, an inactive sibling and a hosted-platform domain
 *        (wixsite.com) never hold.
 *   off: candidate list identical to a run without the rule; the shadow
 *        counts the would-hold profiles; no e-mail address in the shadow.
 * Both mode=first and mode=second. Also covers computeOutreachCandidates()
 * directly (the function the RFB daily job runs).
 *
 * Standalone: npx tsx src/routes/admin-outreach-candidates-sibling-domain.test.ts
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

function callRouteSync(router: any, query: Record<string, string>, headers: Record<string, string>): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: "GET",
    url: "/",
    query,
    headers,
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

const FLAG = "RFB_OUTREACH_SIBLING_DOMAIN_HOLD_ENABLED";

export function runAdminOutreachCandidatesSiblingDomainTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-outreach-candidates-sibling-domain-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevFlag = process.env[FLAG];
  const prevPaused = process.env.OUTREACH_PAUSED;
  process.env.ADMIN_KEY = testKey;
  delete process.env[FLAG];
  delete process.env.OUTREACH_PAUSED;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function agent(id: string, url: string, o: { active?: 0 | 1; website?: string | null } = {}): string {
    const email = `post@${id}.sibling-test.no`;
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
      VALUES (?, ?, 'test producer', 'test', ?, ?, 'producer', ?, ?)
    `).run(id, `Gard ${id}`, email, url, `key-${id}`, o.active ?? 1);
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, website, about, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed)
      VALUES (?, ?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))
    `).run(id, email, o.website === undefined ? url : o.website, "x".repeat(200));
    return email;
  }
  function sent(id: string, daysAgo: number): void {
    db.prepare(`
      INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
      VALUES (?, ?, datetime('now', '-${daysAgo} days'), 'email', ?, 'test')
    `).run(id, `post@${id}.sibling-test.no`, `msg-${id}-${daysAgo}`);
  }
  function replied(id: string): void {
    const email = `post@${id}.sibling-test.no`;
    db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?, 'producer', ?, ?, ?)`).run(
      `c-${id}`, id, email, id,
    );
    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to)
      VALUES (?, ?, 'Svar', 'innkommende', 'in_progress', 'claude')
    `).run(`t-${id}`, `c-${id}`);
    db.prepare(`
      INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, received_at, delivery_status)
      VALUES (?, ?, 'in', ?, '["kontakt@rettfrabonden.com"]', 'Svar', 'nei takk', datetime('now', '-3 days'), datetime('now', '-3 days'), 'sent')
    `).run(`m-${id}`, `t-${id}`, email);
  }

  try {
    // ── mode=first fixtures: candidate *-1, sibling *-2 on the same domain ──
    agent("rep-1", "https://www.svar-gard.no/");
    agent("rep-2", "https://svar-gard.no/butikk", { website: null });
    replied("rep-2"); // (a) sibling replied

    agent("snt-1", "https://sendt-gard.no");
    agent("snt-2", "https://www.sendt-gard.no");
    sent("snt-2", 10); // (c) sibling sent inside the 60-day cooldown

    agent("led-1", "https://ledger-gard.no");
    agent("led-2", "https://ledger-gard.no");
    db.prepare(`
      INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at, updated_at)
      VALUES (date('now', '-5 days'), 'run-x', 'led-2', 'post@led-2.sibling-test.no', 'first', 'sent',
              datetime('now', '-5 days'), datetime('now', '-5 days'))
    `).run(); // (c) via the RFB marketing send ledger

    agent("opt-1", "https://optout-gard.no");
    agent("opt-2", "https://optout-gard.no");
    db.prepare(`UPDATE agent_knowledge SET verification_status = 'opt_out' WHERE agent_id = 'opt-2'`).run(); // (b)

    agent("uns-1", "https://avmeldt-gard.no");
    agent("uns-2", "https://avmeldt-gard.no");
    db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('post@uns-2.sibling-test.no', datetime('now'), 'unsubscribe')`).run(); // (b) asked for removal

    agent("blk-1", "https://sperret-gard.no");
    agent("blk-2", "https://sperret-gard.no");
    const blocklist = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
    blocklist.addManualEntry({ identifierType: "agent_id", identifierValue: "blk-2" }); // (b) blocklisted

    // No false holds.
    agent("old-1", "https://gammel-gard.no");
    agent("old-2", "https://gammel-gard.no");
    sent("old-2", 100); // sibling sent BEFORE the cooldown window

    agent("ina-1", "https://inaktiv-gard.no");
    agent("ina-2", "https://inaktiv-gard.no", { active: 0 });
    replied("ina-2"); // inactive sibling replied — does not count

    agent("hst-1", "https://hst-1.wixsite.com/gard");
    agent("hst-2", "https://hst-2.wixsite.com/gard");
    replied("hst-2"); // hosted platform — never groups

    agent("cln-1", "https://ren-gard.no"); // no siblings
    agent("par-1", "https://par-gard.no"); // clean pair
    agent("par-2", "https://par-gard.no");

    // ── mode=second fixtures (contacted 100 days ago, outside cooldown) ──
    agent("two-1", "https://andre-gard.no");
    sent("two-1", 100);
    agent("two-2", "https://andre-gard.no");
    sent("two-2", 10); // sibling sent inside cooldown → holds two-1's follow-up
    agent("two-ok", "https://andre-ok-gard.no");
    sent("two-ok", 100);

    const aoc = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
    const router = aoc.default as any;
    const auth = { "x-admin-key": testKey };
    const ids = (body: any): string[] => (body?.candidates || []).map((c: any) => c.agent_id).sort();
    const shadowView = (s: any) => (s?.examples || []).map((e: any) => [e.agent_id, e.sibling_agent_id, e.domain, e.reason]);

    const HELD_FIRST = ["blk-1", "led-1", "opt-1", "rep-1", "snt-1", "uns-1"];
    // led-2 only has a ledger row (no sent-log row), so it is still in the
    // first-touch pool itself; its sibling led-1 has no signal.
    const KEPT_FIRST = ["cln-1", "hst-1", "ina-1", "led-2", "old-1", "par-1", "par-2"];

    // ══ flag OFF ═════════════════════════════════════════════════════════
    const firstOff = callRouteSync(router, { mode: "first", cooldown_days: "60" }, auth);
    assertEq(firstOff.status, 200, "off-first: 200");
    assertEq(
      ids(firstOff.body),
      [...HELD_FIRST, ...KEPT_FIRST].sort(),
      "off-first: candidate list unchanged — would-hold profiles are still candidates",
    );
    const sOff = firstOff.body.sibling_domain_shadow;
    assertEq([sOff.flag, sOff.flag_enabled], [FLAG, false], "off-first: shadow names the flag, flag_enabled false");
    assertEq(sOff.would_hold, 6, "off-first: shadow would_hold = 6");
    assertEq(
      sOff.by_reason,
      { replied: 1, opted_out: 2, blocklisted: 1, recently_sent: 2 },
      "off-first: shadow by_reason",
    );
    assertEq(
      shadowView(sOff).sort(),
      [
        ["blk-1", "blk-2", "sperret-gard.no", "blocklisted"],
        ["led-1", "led-2", "ledger-gard.no", "recently_sent"],
        ["opt-1", "opt-2", "optout-gard.no", "opted_out"],
        ["rep-1", "rep-2", "svar-gard.no", "replied"],
        ["snt-1", "snt-2", "sendt-gard.no", "recently_sent"],
        ["uns-1", "uns-2", "avmeldt-gard.no", "opted_out"],
      ],
      "off-first: shadow examples (agent, sibling, domain, reason)",
    );
    assertEq(JSON.stringify(sOff).includes("@"), false, "off-first: no e-mail address in the shadow");
    assertEq(
      [
        firstOff.body.suppressed_counts.sibling_domain_replied,
        firstOff.body.suppressed_counts.sibling_domain_opted_out,
        firstOff.body.suppressed_counts.sibling_domain_blocklisted,
        firstOff.body.suppressed_counts.sibling_domain_recently_sent,
      ],
      [0, 0, 0, 0],
      "off-first: sibling suppression counters stay 0 while the flag is off",
    );
    // The sibling itself keeps its own reasons (unchanged counters).
    assertEq(
      [firstOff.body.suppressed_counts.replied, firstOff.body.suppressed_counts.opted_out, firstOff.body.suppressed_counts.blocklisted],
      [2, 0, 1],
      "off-first: own counters unchanged — replied (rep-2, hst-2; ina-2 inactive is outside the pool), opt-2 outside the pool (not verified), blocklisted blk-2",
    );

    const secondOff = callRouteSync(router, { mode: "second", cooldown_days: "60" }, auth);
    assertEq(secondOff.status, 200, "off-second: 200");
    assertEq(ids(secondOff.body), ["old-2", "two-1", "two-ok"], "off-second: follow-ups unchanged (two-1 still listed)");
    assertEq(
      [secondOff.body.sibling_domain_shadow.would_hold, shadowView(secondOff.body.sibling_domain_shadow)],
      [1, [["two-1", "two-2", "andre-gard.no", "recently_sent"]]],
      "off-second: shadow counts two-1 (sibling sent inside cooldown)",
    );

    // Same body via the function the RFB daily job calls.
    const direct = aoc.computeOutreachCandidates(db as any, { mode: "first", cooldownDays: 60, limit: 100 });
    assertEq(JSON.stringify(direct), JSON.stringify(firstOff.body), "off: computeOutreachCandidates() === route body (daily-job parity)");

    // ══ flag ON ══════════════════════════════════════════════════════════
    process.env[FLAG] = "true";
    const firstOn = callRouteSync(router, { mode: "first", cooldown_days: "60" }, auth);
    assertEq(firstOn.status, 200, "on-first: 200");
    assertEq(ids(firstOn.body), KEPT_FIRST, "on-first: replied / sent / ledger / opted-out / unsubscribed / blocklisted siblings hold; others stay");
    for (const id of HELD_FIRST) {
      assertEq(ids(firstOn.body).includes(id), false, `on-first: ${id} is not a candidate`);
    }
    assertEq(ids(firstOn.body).includes("cln-1"), true, "on-first: profile without siblings is still a candidate");
    assertEq(ids(firstOn.body).includes("old-1"), true, "on-first: sibling sent before the cooldown does not hold");
    assertEq(ids(firstOn.body).includes("ina-1"), true, "on-first: inactive sibling does not group");
    assertEq(ids(firstOn.body).includes("hst-1"), true, "on-first: hosted-platform domain does not group (hst-2 replied, hst-1 kept)");
    assertEq(
      [
        firstOn.body.suppressed_counts.sibling_domain_replied,
        firstOn.body.suppressed_counts.sibling_domain_opted_out,
        firstOn.body.suppressed_counts.sibling_domain_blocklisted,
        firstOn.body.suppressed_counts.sibling_domain_recently_sent,
      ],
      [1, 2, 1, 2],
      "on-first: own skip reasons sibling_domain_* in suppressed_counts",
    );
    const sOn = firstOn.body.sibling_domain_shadow;
    assertEq([sOn.flag_enabled, sOn.would_hold], [true, 6], "on-first: shadow reports what was held");
    assertEq(JSON.stringify(sOn).includes("@"), false, "on-first: no e-mail address in the shadow");

    const secondOn = callRouteSync(router, { mode: "second", cooldown_days: "60" }, auth);
    assertEq(ids(secondOn.body), ["old-2", "two-ok"], "on-second: two-1 held (sibling sent inside cooldown); others stay");
    assertEq(secondOn.body.suppressed_counts.sibling_domain_recently_sent >= 1, true, "on-second: counted as sibling_domain_recently_sent");

    // Wider cooldown: old-2's send (100 days) now inside → old-1 held too.
    const firstOnWide = callRouteSync(router, { mode: "first", cooldown_days: "120" }, auth);
    assertEq(ids(firstOnWide.body).includes("old-1"), false, "on-first: the gate's cooldown_days is the sibling window");

    // Pure helper: hosted platforms / free mail never group.
    const sib = require("../services/rfb-domain-siblings") as typeof import("../services/rfb-domain-siblings");
    assertEq(
      [
        sib.websiteDomainKey("https://www.svar-gard.no/om"),
        sib.websiteDomainKey("https://hst-1.wixsite.com/gard"),
        sib.websiteDomainKey("https://www.facebook.com/gard"),
        sib.websiteDomainKey("http://home.online.no/~gard"),
      ],
      ["svar-gard.no", null, null, null],
      "helper: registrable domain; hosted platforms and ISP home pages are no key",
    );
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
    if (prevPaused === undefined) delete process.env.OUTREACH_PAUSED;
    else process.env.OUTREACH_PAUSED = prevPaused;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAdminOutreachCandidatesSiblingDomainTests({ log: true });
  console.log(`\nadmin-outreach-candidates-sibling-domain: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

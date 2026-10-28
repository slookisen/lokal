/**
 * avmeld-fixup.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * follow-up F1–F3 to S1a (lokal#1228, review supervisor-inbox/2026-10-23-session-pr-1228-review.md).
 *
 *   F1 — an 'unsubscribe' row in email_bounces (outreach-only suppression) must
 *        not stop the claim flows from finding the farm's own address:
 *        knowledgeService.resolveFarmContactEmail (RFB) and
 *        wasEpostDeliveredOutreachNoBounce (gårdssalg). Hard/complaint/legacy
 *        NULL-typed bounces still block.
 *   F2 — /avmeld/ is a skip path in the analytics middleware (the signed token
 *        in the URL must not be stored as a page view).
 *   F3 — UNSUBSCRIBE_TOKEN_SECRET signs the tokens when set (ADMIN_KEY rotation
 *        no longer breaks sent links); without it ADMIN_KEY still works, so
 *        tokens already sent stay valid.
 *
 * Exported runAvmeldFixupTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/avmeld-fixup.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAvmeldFixupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const saved: Record<string, string | undefined> = {
    ADMIN_KEY: process.env.ADMIN_KEY,
    ANALYTICS_ADMIN_KEY: process.env.ANALYTICS_ADMIN_KEY,
    UNSUBSCRIBE_TOKEN_SECRET: process.env.UNSUBSCRIBE_TOKEN_SECRET,
  };
  const claimSvc = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    claimSvc.__setRfbDbForTesting(db as any);
    const { knowledgeService } = require("./knowledge-service") as typeof import("./knowledge-service");

    // ═══ F1 ═══════════════════════════════════════════════════════════════
    const osl = db.prepare("INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id) VALUES (?, ?, ?, 'email', ?)");
    let tick = 0;
    const bounce = (email: string, type: string | null) =>
      db.prepare("INSERT INTO email_bounces (email, bounced_at, resend_email_id, bounce_type) VALUES (?, ?, ?, ?)").run(email, "2026-10-20 10:00:00", `rid-${++tick}`, type);

    osl.run("f1-unsub", "Post@f1-unsub.example.test", "2026-10-01 10:00:00", "rfb");
    bounce("post@f1-unsub.example.test", "unsubscribe");
    assertEq(knowledgeService.resolveFarmContactEmail("f1-unsub"), "post@f1-unsub.example.test", "f1-1: RFB — an unsubscribe does not hide the delivered farm address");

    osl.run("f1-hard", "post@f1-hard.example.test", "2026-10-01 10:00:00", "rfb");
    bounce("post@f1-hard.example.test", "hard");
    assertEq(knowledgeService.resolveFarmContactEmail("f1-hard"), null, "f1-2: RFB — a hard bounce still blocks");

    osl.run("f1-compl", "post@f1-compl.example.test", "2026-10-01 10:00:00", "rfb");
    bounce("post@f1-compl.example.test", "complaint");
    assertEq(knowledgeService.resolveFarmContactEmail("f1-compl"), null, "f1-3: RFB — a complaint still blocks");

    osl.run("f1-null", "post@f1-null.example.test", "2026-10-01 10:00:00", "rfb");
    bounce("post@f1-null.example.test", null);
    assertEq(knowledgeService.resolveFarmContactEmail("f1-null"), null, "f1-4: RFB — a legacy bounce row without type still blocks");

    osl.run("f1-mixed", "post@f1-mixed.example.test", "2026-10-01 10:00:00", "rfb");
    bounce("post@f1-mixed.example.test", "unsubscribe");
    bounce("post@f1-mixed.example.test", "hard");
    assertEq(knowledgeService.resolveFarmContactEmail("f1-mixed"), null, "f1-5: RFB — unsubscribe plus a hard bounce still blocks");

    const ox = db.prepare("INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id) VALUES (?, ?, '2026-10-01 10:00:00', 'email', 'experiences')");
    ox.run("g-unsub", "eier@g-unsub.example.test"); bounce("eier@g-unsub.example.test", "unsubscribe");
    ox.run("g-hard", "eier@g-hard.example.test"); bounce("eier@g-hard.example.test", "hard");
    ox.run("g-null", "eier@g-null.example.test"); bounce("eier@g-null.example.test", null);
    ox.run("g-none", "eier@g-none.example.test");
    assertEq(claimSvc.wasEpostDeliveredOutreachNoBounce("eier@g-unsub.example.test"), true, "f1-6: gårdssalg — an unsubscribe does not make the address 'bounced'");
    assertEq(claimSvc.wasEpostDeliveredOutreachNoBounce("eier@g-hard.example.test"), false, "f1-7: gårdssalg — a hard bounce still blocks");
    assertEq(claimSvc.wasEpostDeliveredOutreachNoBounce("eier@g-null.example.test"), false, "f1-8: gårdssalg — a legacy untyped bounce still blocks");
    assertEq(claimSvc.wasEpostDeliveredOutreachNoBounce("eier@g-none.example.test"), true, "f1-9: gårdssalg — no bounce, delivered (unchanged)");

    // ═══ F2 ═══════════════════════════════════════════════════════════════
    const { AnalyticsService } = require("./analytics-service") as typeof import("./analytics-service");
    const mw = new AnalyticsService().middleware();
    const probe = (path: string) => {
      let listeners = 0; let nexted = false;
      const req: any = { method: "GET", path, query: {}, headers: {}, ip: "127.0.0.1", cookies: {}, get: () => undefined };
      const res: any = { on: () => { listeners++; }, statusCode: 200, getHeader: () => undefined };
      mw(req, res, () => { nexted = true; });
      return { listeners, nexted };
    };
    const skipped = probe("/avmeld/abc.def");
    assertEq([skipped.nexted, skipped.listeners], [true, 0], "f2-1: /avmeld/:token passes through without page-view tracking");
    const control = probe("/produsent/noe");
    assertEq([control.nexted, control.listeners > 0], [true, true], "f2-2: control — an ordinary page is still tracked");

    // ═══ F3 ═══════════════════════════════════════════════════════════════
    const av = require("./avmeld-service") as typeof import("./avmeld-service");
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    process.env.ADMIN_KEY = "f3-admin-old";
    const tOld = av.makeUnsubscribeToken("post@f3.example.test")!;
    assertEq(av.verifyUnsubscribeToken(tOld)?.email, "post@f3.example.test", "f3-1: without the dedicated secret, ADMIN_KEY signs (links already sent stay valid)");
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "f3-dedicated";
    const tNew = av.makeUnsubscribeToken("post@f3.example.test")!;
    assertEq(tNew !== tOld, true, "f3-2: the dedicated secret changes the signature");
    process.env.ADMIN_KEY = "f3-admin-rotated";
    assertEq(av.verifyUnsubscribeToken(tNew)?.email, "post@f3.example.test", "f3-3: with the dedicated secret, rotating ADMIN_KEY does not break the token");
    assertEq(av.verifyUnsubscribeToken(tOld), null, "f3-4: a token signed with the old ADMIN_KEY is not accepted once the dedicated secret is set");
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET; delete process.env.ADMIN_KEY; delete process.env.ANALYTICS_ADMIN_KEY;
    assertEq(av.makeUnsubscribeToken("a@b.no"), null, "f3-5: no secret at all -> no token");
  } catch (err) {
    failed++;
    failures.push("avmeld-fixup: unexpected error: " + String((err as any)?.stack || err));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { claimSvc.__setRfbDbForTesting(null); } catch { /* ignore */ }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAvmeldFixupTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}

/**
 * gardssalg-outreach-eide-avmeld-g1s7.test.ts — dev-request
 * 2026-10-22-opplevagent-mine-valg-gardssalg, slice G1 point 6 / AC 6.
 *
 *   • an OWNED gårdssalg profile (content_source='claim', claimed_at set, or a live
 *     used + non-revoked gardssalg_claims row) is not a cold-outreach candidate (modes
 *     first + second), is not eligible, and is refused at send time; default ON,
 *     rollback GARDSSALG_OUTREACH_EXCLUDE_OWNED=0;
 *   • the gårdssalg outreach mail carries a signed List-Unsubscribe (opplevagent.no)
 *     + List-Unsubscribe-Post: List-Unsubscribe=One-Click (behind OUTREACH_UNSUBSCRIBE_ENABLED);
 *   • GET /avmeld/:token changes nothing; POST sets the suppression without touching the
 *     profile; the suppressed address then drops out of the candidates; Opplevagent pages
 *     never name Rett fra Bonden.
 *
 * Exported runGardssalgOutreachEideAvmeldG1s7Tests({log}) -> TestSummary; wired into
 * tests/test.ts (runSerial, tail). Standalone: npx tsx src/routes/gardssalg-outreach-eide-avmeld-g1s7.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const VERIFIED_STAMP = JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
const UNSUB_FLAG = "OUTREACH_UNSUBSCRIBE_ENABLED";
const OWNED_FLAG = "GARDSSALG_OUTREACH_EXCLUDE_OWNED";

function callRoute(router: any, query: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const url = "/admin/gardssalg-outreach-candidates" + (qs ? `?${qs}` : "");
    const req: any = { method: "GET", url, originalUrl: url, path: "/admin/gardssalg-outreach-candidates", query, headers, body: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
    };
    router.handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
  });
}

export function runGardssalgOutreachEideAvmeldG1s7Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (a: unknown, e: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(e)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
  };
  const assertTrue = (c: boolean, label: string) => {
    if (c) { passed++; if (log) console.log(`  ok ${label}`); } else { failed++; failures.push(`✗ ${label}`); }
  };

  return (async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ["EXPERIENCES_DB_PATH", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS", "OUTREACH_COOLDOWN_DAYS", UNSUB_FLAG, OWNED_FLAG]) saved[k] = process.env[k];
    const testKey = "g1s7-test-admin-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS = "30";
    process.env.OUTREACH_COOLDOWN_DAYS = "60";
    delete process.env[UNSUB_FLAG];
    delete process.env[OWNED_FLAG];

    const cachePaths = [require.resolve("../database/db-factory"), require.resolve("../services/blocklist-service"), require.resolve("./opplevelser")];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    let prevRfbDb: any = null;
    const prevLog = console.log;
    const prevWarn = console.warn;

    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      if (!log) { console.log = () => {}; console.warn = () => {}; }

      const opp = require("./opplevelser") as typeof import("./opplevelser");
      const router = opp.default as any;
      const av = require("../services/avmeld-service") as typeof import("../services/avmeld-service");
      const avRouter = require("./avmeld").default as any;
      const { emailService } = require("../services/email-service") as typeof import("../services/email-service");
      const auth = { "x-admin-key": testKey };

      const insert = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, vertical, hjemmeside, epost, about_text, products, brreg_verified, catalog_hidden, slug,
           field_provenance, producer_type, enrichment_state, verification_status, source, confidence, created_at,
           content_source, claimed_at)
        VALUES (@id, @navn, 'experiences', @hjemmeside, @epost, 'En fin gård.', 'Cider, sider', 1, 0, @slug,
           @fp, 'sideri', 'raw', 'pending_verify', 'test-fixture', 'medium', '2026-01-01 00:00:00', @cs, @ca)`);
      const mk = (id: string, cs: string | null = null, ca: string | null = null) =>
        insert.run({ id, navn: `Gård ${id}`, hjemmeside: `https://${id}.example.no`, epost: `post@${id}.example.no`, slug: id, fp: VERIFIED_STAMP, cs, ca });
      const sentAgo = (id: string, days: number) =>
        expDb.prepare(`INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, channel, is_test) VALUES (?, ?, datetime('now', '-${days} days'), 'email', 0)`)
          .run(id, `post@${id}.example.no`);
      const ids = async (mode: string) => ((await callRoute(router, { mode }, auth)).body.candidates as any[]).map((c) => c.provider_id);

      // ═══ Owned profiles are not cold-outreach candidates ═════════════
      mk("g1-free");
      mk("g1-claim", "claim");
      mk("g1-badge", null, "2026-10-01T10:00:00.000Z");
      mk("g1-live");
      expDb.prepare(`INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, expires_at) VALUES ('c1', 'g1-live', 'post@g1-live.example.no', 'brreg_contact', 'tok-live', 1, datetime('now'), datetime('now', '+7 days'))`).run();
      mk("g1-revoked");
      expDb.prepare(`INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, expires_at) VALUES ('c2', 'g1-revoked', 'post@g1-revoked.example.no', 'brreg_contact', 'tok-rev', 1, datetime('now'), datetime('now'), datetime('now', '+7 days'))`).run();
      mk("g1-unused");
      expDb.prepare(`INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, expires_at) VALUES ('c3', 'g1-unused', 'post@g1-unused.example.no', 'brreg_contact', 'tok-unused', 0, datetime('now', '+7 days'))`).run();

      const first = await ids("first");
      assertTrue(first.includes("g1-free"), "o1: an unowned profile is a mode=first candidate");
      assertTrue(!first.includes("g1-claim"), "o2: content_source='claim' is not a candidate");
      assertTrue(!first.includes("g1-badge"), "o3: claimed_at set is not a candidate");
      assertTrue(!first.includes("g1-live"), "o4: a live verified claim is not a candidate");
      assertTrue(first.includes("g1-revoked"), "o5: a revoked claim with no badge/content_source is still a candidate");
      assertTrue(first.includes("g1-unused"), "o6: an unused (unverified) claim link does not make a profile owned");
      const firstBody = (await callRoute(router, { mode: "first" }, auth)).body;
      assertEq(firstBody.suppressed_counts.owner_claimed, 3, "o7: suppressed_counts.owner_claimed counts the three owned rows");

      const elig = opp.computeGardssalgOutreachSendEligibility(expDb as any, ["g1-claim", "g1-free"], { skipRecipientDedupe: true });
      assertEq(elig.map((e) => [e.provider_id, e.eligible, (e as any).reason ?? null]), [["g1-claim", false, "owner_claimed"], ["g1-free", true, null]], "o8: eligibility reports owner_claimed for the owned row only");

      // mode=second: owned rows with an old send are dropped too
      for (const id of ["g1-free", "g1-claim", "g1-badge", "g1-live"]) sentAgo(id, 45);
      const second = await ids("second");
      assertTrue(second.includes("g1-free"), "o9: unowned old-contact profile is a mode=second candidate");
      assertTrue(!second.includes("g1-claim") && !second.includes("g1-badge") && !second.includes("g1-live"), "o10: owned profiles are not mode=second candidates");

      // send-time re-check (a claim landing after the eligibility pass)
      const sendLog = () => (expDb.prepare(`SELECT COUNT(*) AS c FROM experience_outreach_sent_log`).get() as any).c as number;
      const before = sendLog();
      const sentMails: any[] = [];
      const es: any = emailService;
      const prevT = es.transporter, prevC = es.isConfigured;
      es.transporter = { sendMail: async (m: any) => { sentMails.push(m); return { messageId: "<g1@test>" }; } };
      es.isConfigured = true;
      try {
        const eligRow = opp.computeGardssalgOutreachSendEligibility(expDb as any, ["g1-revoked"])[0] as any;
        assertEq(eligRow.eligible, true, "s0: g1-revoked is eligible before the claim lands");
        expDb.prepare(`UPDATE experience_providers SET content_source = 'claim' WHERE id = 'g1-revoked'`).run();
        const refused = await opp.sendGardssalgOutreachToEligibleProvider(expDb as any, eligRow, { template: "standard", isTest: false, source: "g1s7-test" });
        assertEq([refused.status, (refused as any).reason], ["skipped", "owner_claimed"], "s1: send-time check refuses a profile claimed after the eligibility pass");
        assertEq([sentMails.length, sendLog()], [0, before], "s2: nothing sent, no sent_log row reserved");

        // rollback switch
        process.env[OWNED_FLAG] = "0";
        assertTrue((await ids("second")).includes("g1-claim"), "o11: GARDSSALG_OUTREACH_EXCLUDE_OWNED=0 restores the old behaviour (rollback)");
        delete process.env[OWNED_FLAG];
        assertTrue(!(await ids("second")).includes("g1-claim"), "o12: filter is back ON when the switch is unset (default ON)");

        // ═══ List-Unsubscribe headers on the gårdssalg outreach mail ═════
        delete process.env[UNSUB_FLAG];
        await emailService.sendGardssalgOutreach("post@g1-free.example.no", "Gård g1-free", "https://opplevagent.no/kategori/gardssalg/produsent/g1-free");
        assertTrue(sentMails[0].headers["List-Unsubscribe"] === undefined && sentMails[0].headers["List-Unsubscribe-Post"] === undefined, "h1: flag off -> no unsubscribe headers (the /avmeld route is a 404 then)");

        process.env[UNSUB_FLAG] = "1";
        await emailService.sendGardssalgOutreach("Post@g1-free.example.no", "Gård g1-free", "https://opplevagent.no/kategori/gardssalg/produsent/g1-free");
        const hdr = sentMails[1].headers;
        assertEq(hdr["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "h2: List-Unsubscribe-Post: List-Unsubscribe=One-Click");
        const m = String(hdr["List-Unsubscribe"]).match(/^<https:\/\/opplevagent\.no\/avmeld\/([^>]+)>$/);
        assertTrue(!!m, "h3: List-Unsubscribe is one https opplevagent.no/avmeld/<token> URL");
        const tokenInfo = m ? av.verifyUnsubscribeToken(m[1]) : null;
        assertEq(tokenInfo, { email: "post@g1-free.example.no", vertical: "experiences" }, "h4: token is signed for exactly this recipient + platform");
        assertTrue(!/Rett fra Bonden/i.test(String(sentMails[1].text) + String(sentMails[1].html || "")), "h5: mail body does not name Rett fra Bonden");
        await emailService.sendGardssalgOutreach("post@g1-free.example.no", "Gård g1-free", "https://opplevagent.no/x", { template: "personal" });
        assertEq(sentMails[2].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "h6: the personal template variant carries the headers too");
        // RFB-format tokens are unchanged and still verify as rfb
        assertEq(av.verifyUnsubscribeToken(av.makeUnsubscribeToken("a@b.no")!), { email: "a@b.no", vertical: "rfb" }, "h7: RFB tokens are unchanged");
        assertEq(av.verifyUnsubscribeToken(av.makeUnsubscribeToken("a@b.no", "experiences")!)?.vertical, "experiences", "h8: experiences token round-trips");

        // ═══ /avmeld: GET changes nothing, POST suppresses, profile kept ═
        const findH = (method: "get" | "post"): Function => {
          const l = (avRouter.stack as any[]).find((x: any) => x.route && x.route.path === "/avmeld/:token" && x.route.methods?.[method]);
          return l.route.stack[l.route.stack.length - 1].handle;
        };
        const call = (h: Function, token: string, host = "opplevagent.no") =>
          new Promise<{ status: number; body: any }>((resolve) => {
            let status = 200;
            const res: any = { status(c: number) { status = c; return res; }, send(p: any) { resolve({ status, body: p }); return res; }, json(p: any) { resolve({ status, body: p }); return res; }, setHeader() { return res; } };
            h({ params: { token }, body: {}, query: {}, headers: {}, ip: "127.0.0.1", hostname: host, get: () => undefined }, res, () => resolve({ status: 0, body: "next" }));
          });
        const bounces = () => (rfbDb.prepare(`SELECT COUNT(*) AS c FROM email_bounces`).get() as any).c as number;
        const profile = () => JSON.stringify(expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'g1-free'`).get());
        const token = m![1];
        const profBefore = profile();
        const g = await call(findH("get"), token);
        assertEq(g.status, 200, "u1: GET valid token -> 200 confirm page");
        assertTrue(String(g.body).includes('method="post"') && String(g.body).includes("Opplevagent"), "u2: GET shows the confirm form in Opplevagent wording");
        assertTrue(!/Rett fra Bonden/i.test(String(g.body)), "u3: the Opplevagent GET page never names Rett fra Bonden");
        assertEq([bounces(), profile() === profBefore, (await ids("second")).includes("g1-free")], [0, true, true], "u4: GET writes nothing and leaves the profile a candidate");
        await call(findH("get"), token); // idempotent
        assertEq(bounces(), 0, "u5: repeated GET still writes nothing");
        assertEq((await call(findH("get"), "bad.token", "opplevagent.no")).status, 400, "u6: GET invalid token -> 400");
        assertTrue(!/Rett fra Bonden/i.test(String((await call(findH("get"), "bad.token", "opplevagent.no")).body)), "u7: invalid-token page on opplevagent.no does not name Rett fra Bonden");

        const p = await call(findH("post"), token);
        assertEq(p.status, 200, "u8: POST valid token -> 200");
        assertTrue(/Opplevagent/.test(String(p.body)) && !/Rett fra Bonden/i.test(String(p.body)) && String(p.body).includes("ikke slettet"), "u9: POST page: Opplevagent wording, profile kept");
        assertEq(rfbDb.prepare(`SELECT email, bounce_type FROM email_bounces`).all(), [{ email: "post@g1-free.example.no", bounce_type: "unsubscribe" }], "u10: POST wrote exactly one unsubscribe row");
        await call(findH("post"), token);
        assertEq(bounces(), 1, "u11: POST is idempotent");
        assertEq(profile(), profBefore, "u12: the profile row is byte-identical (not deleted, not hidden)");
        assertTrue(!(await ids("first")).includes("g1-free") && !(await ids("second")).includes("g1-free"), "u13: the unsubscribed address is no longer a candidate in either mode");
        const e2 = opp.computeGardssalgOutreachSendEligibility(expDb as any, ["g1-free"])[0] as any;
        assertEq([e2.eligible, e2.reason, e2.bounce_type], [false, "hard_bounced", "unsubscribe"], "u14: eligibility reports the unsubscribe suppression");
        const mailsBefore = sentMails.length;
        const e3 = await opp.sendGardssalgOutreachToEligibleProvider(expDb as any, { provider_id: "g1-free", eligible: true, status: "would_send", navn: "Gård g1-free", slug: "g1-free", epost: "post@g1-free.example.no" }, { template: "standard", isTest: false, source: "g1s7-test" });
        assertEq([e3.status, sentMails.length], ["skipped", mailsBefore], "u15: send-time guard refuses an unsubscribed address");
        assertEq((await call(findH("post"), "bad.token")).status, 400, "u16: POST invalid token -> 400");
        assertEq(bounces(), 1, "u17: invalid POST writes nothing");
        delete process.env[UNSUB_FLAG];
        assertEq((await call(findH("get"), token)).status, 404, "u18: flag off -> GET 404");
        assertEq((await call(findH("post"), token)).status, 404, "u19: flag off -> POST 404");
        assertTrue(!(await ids("first")).includes("g1-free"), "u20: an existing suppression is honoured with the flag off");
      } finally {
        es.transporter = prevT; es.isConfigured = prevC;
      }
    } catch (err) {
      failed++;
      failures.push("gardssalg-outreach-eide-avmeld-g1s7: unexpected error: " + String((err as any)?.stack || err));
    } finally {
      console.log = prevLog;
      console.warn = prevWarn;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      try { const initMod = require("../database/init") as typeof import("../database/init"); if (prevRfbDb) initMod.__setDbForTesting(prevRfbDb); } catch { /* best effort */ }
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgOutreachEideAvmeldG1s7Tests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}

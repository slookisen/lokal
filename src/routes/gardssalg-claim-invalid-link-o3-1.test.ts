/**
 * gardssalg-claim-invalid-link-o3-1.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o3-eierkrav-og-innlogging, slice O3-1 (funn R12): an expired,
 * unknown or otherwise dead gårdssalg claim link shows a message and a
 * «Send ny lenke» form.
 *
 * Covers:
 *   (g) AK1: GET magic-link-verify with an unknown / expired / missing token
 *       answers 200 with the OA-4 texts verbatim, the resend form and the help
 *       line, no-store; a GET changes no row; only a token-shaped value is
 *       echoed into the form.
 *   (p) AK2: POST send-ny-lenke sends only to the address on the existing
 *       claim (an address in the body is ignored), answers byte-identically
 *       whether or not a claim exists, sends nothing for revoked / draft /
 *       later-revoked rows, «for mange» after 3 per token per hour — the same
 *       for a token that matches nothing — and the new link logs in.
 *   (s) service: the per-key window ends after an hour; the per-provider limit
 *       stays silent (outcome done, no row).
 *   (l) nothing logs a token or a link.
 *
 * Exported runGardssalgClaimInvalidLinkO31Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-claim-invalid-link-o3-1.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgClaimInvalidLinkO31Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const routerPath = require.resolve("./gardssalg-claim");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      dbFactoryPath,
      claimSvcPath,
      routerPath,
    ]);
    const { emailService } = require("../services/email-service") as typeof import("../services/email-service");
    const origSend = emailService.sendGardssalgClaimMagicLink;
    const sent: Array<{ to: string; verifyUrl: string; providerName: string; isTestSend: boolean }> = [];
    (emailService as any).sendGardssalgClaimMagicLink = async (o: any) => {
      sent.push({ to: o.to, verifyUrl: o.verifyUrl, providerName: o.providerName, isTestSend: o.isTestSend === true });
      return { success: true };
    };
    const logged: string[] = [];
    const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    let server: any = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      claimSvc.__resetClaimResendLimiterForTesting();
      // Harvest network calls stubbed as in gardssalg-claim.test.ts (no fixture
      // has a hjemmeside, so none should happen at all).
      const fetchCalls: string[] = [];
      claimSvc.__setClaimHarvestFetchForTesting((async (input: unknown) => {
        fetchCalls.push(String(input));
        throw new Error("no network in tests");
      }) as unknown as typeof fetch);
      claimSvc.__resetClaimHarvestCacheForTesting();
      const T = (require("./gardssalg-claim-texts") as typeof import("./gardssalg-claim-texts")).CLAIM_LINK_TEXTS;
      const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      const insertProvider = db.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, content_source, epost, enrichment_state, verification_status, source, confidence)
        VALUES (@id, @navn, @slug, 'experiences', @org_nr, @brreg, 'manual', @epost, 'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      // content_source='manual' + epost makes epost a current candidate
      // (stored_epost_verified, c-epost) without any harvest or RFB lookup.
      let orgSeq = 913100001;
      const prov = (id: string, navn: string, epost: string | null, brreg = 1) =>
        insertProvider.run({ id, navn, slug: id, org_nr: String(orgSeq++), brreg, epost });
      prov("prov-o31", "Lenketest Gård", "eier@lenketest.no");
      db.prepare("UPDATE experience_providers SET slug = 'lenketest-gard' WHERE id = 'prov-o31'").run();
      prov("prov-o31-rev", "Tilbakekalt Gård", "gammel@tilbakekalt.no");
      prov("prov-o31-busy", "Travel Gård", "eier@travel.no");
      prov("prov-o31-nocand", "Byttet Gård", "ny@byttet.no");
      prov("prov-o31-nobrreg", "Uverifisert Gård", "eier@uverifisert.no", 0);
      prov("prov-o31-old", "Gammel Lenke Gård", "eier@gammel.no");
      prov("prov-o31-test", "Testsending Gård", null, 0);
      prov("prov-o31-sd", "Samme Dag Gård", "eier@sammedag.no");

      const hex = (c: string) => c.repeat(64).slice(0, 64);
      const insertClaimStmt = db.prepare(`
        INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at, revoked_at, draft_mode, is_test)
        VALUES (@id, @provider_id, @email, @email_source, @token, @used, @created_at, @expires_at, @revoked_at, @draft_mode, @is_test)
      `);
      const insertClaim = { run: (r: Record<string, unknown>) => insertClaimStmt.run({ email_source: "stored_epost_verified", is_test: 0, ...r }) };
      const DAY = 86400000;
      const isoAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
      const sqlAgo = (days: number) => isoAgo(days).slice(0, 19).replace("T", " ");
      // Expired (7-day link) but inside the 30-day resend bound.
      const old = { created_at: isoAgo(10), expires_at: isoAgo(3) };
      const EXPIRED = hex("a");
      insertClaim.run({ id: "gsc_o31_exp", provider_id: "prov-o31", email: "eier@lenketest.no", token: EXPIRED, used: 0, revoked_at: null, draft_mode: 0, ...old });
      const REVOKED = hex("b");
      // Revoked (a logout) BEFORE the expired link was issued: does not block that link.
      insertClaim.run({ id: "gsc_o31_rev", provider_id: "prov-o31", email: "eier@lenketest.no", token: REVOKED, used: 1, revoked_at: sqlAgo(19), draft_mode: 0,
        created_at: isoAgo(20), expires_at: isoAgo(13) });
      const DRAFT = hex("c");
      insertClaim.run({ id: "gsc_o31_draft", provider_id: "prov-o31", email: "utkast@lenketest.no", token: DRAFT, used: 0, revoked_at: null, draft_mode: 1, ...old });
      // An old unused link, then an admin revoke of a later claim on the same provider.
      const LATER_REVOKED = hex("d");
      insertClaim.run({ id: "gsc_o31_lr1", provider_id: "prov-o31-rev", email: "gammel@tilbakekalt.no", token: LATER_REVOKED, used: 0, revoked_at: null, draft_mode: 0, ...old });
      insertClaim.run({ id: "gsc_o31_lr2", provider_id: "prov-o31-rev", email: "annen@tilbakekalt.no", token: hex("e"), used: 1, revoked_at: sqlAgo(5), draft_mode: 0, created_at: isoAgo(8), expires_at: isoAgo(1) });
      // B1 gates: address no longer a candidate / provider not brreg-verified / source row too old.
      const NOCAND = hex("1a");
      insertClaim.run({ id: "gsc_o31_nocand", provider_id: "prov-o31-nocand", email: "gammel@byttet.no", token: NOCAND, used: 0, revoked_at: null, draft_mode: 0, ...old });
      const NOBRREG = hex("1b");
      insertClaim.run({ id: "gsc_o31_nobrreg", provider_id: "prov-o31-nobrreg", email: "eier@uverifisert.no", token: NOBRREG, used: 0, revoked_at: null, draft_mode: 0, ...old });
      const TOO_OLD = hex("1c");
      insertClaim.run({ id: "gsc_o31_old", provider_id: "prov-o31-old", email: "eier@gammel.no", token: TOO_OLD, used: 0, revoked_at: null, draft_mode: 0,
        created_at: isoAgo(31), expires_at: isoAgo(24) });
      // N2: an admin-granted (manual) test row: only the age bound applies, and is_test survives.
      const TESTROW = hex("1d");
      insertClaim.run({ id: "gsc_o31_test", provider_id: "prov-o31-test", email: "test@testsending.no", email_source: "manual", is_test: 1, token: TESTROW, used: 0, revoked_at: null, draft_mode: 0, ...old });
      // N3: a revoke later the SAME day (SQLite format vs ISO 'T' format) still blocks.
      const SAMEDAY = hex("1e");
      const sdDay = isoAgo(3).slice(0, 10);
      insertClaim.run({ id: "gsc_o31_sd1", provider_id: "prov-o31-sd", email: "eier@sammedag.no", token: SAMEDAY, used: 0, revoked_at: null, draft_mode: 0,
        created_at: `${sdDay}T10:00:00.000Z`, expires_at: isoAgo(1) });
      insertClaim.run({ id: "gsc_o31_sd2", provider_id: "prov-o31-sd", email: "eier@sammedag.no", token: hex("1f"), used: 1, revoked_at: `${sdDay} 11:00:00`, draft_mode: 0,
        created_at: `${sdDay}T09:00:00.000Z`, expires_at: isoAgo(1) });
      const UNKNOWN = hex("f");

      const claimCount = () => (db.prepare("SELECT COUNT(*) AS c FROM gardssalg_claims").get() as any).c as number;
      const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM gardssalg_claims ORDER BY id").all())
        + JSON.stringify(db.prepare("SELECT id, content_source, claimed_at FROM experience_providers ORDER BY id").all());

      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use("/", routerMod.default);
      const httpMod = require("http") as typeof import("http");
      server = httpMod.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const req = (method: string, path: string, body?: string) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const headers: Record<string, string> = { "X-Forwarded-For": "203.0.113.31" };
          if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body !== undefined) r.write(body);
          r.end();
        });
      const VERIFY = "/kategori/gardssalg/eier/magic-link-verify";
      const RESEND = "/kategori/gardssalg/eier/send-ny-lenke";

      // Capture everything logged from here on (l).
      for (const k of ["log", "warn", "error", "info"] as const) {
        (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      }

      // ── (g) AK1 ─────────────────────────────────────────────────────────
      const before = snapshot();
      const gUnknown = await req("GET", `${VERIFY}?token=${UNKNOWN}`);
      assertEq(gUnknown.status, 200, "g1: GET verify, unknown token -> 200");
      assertTrue(gUnknown.body.includes('data-gc-claim-invalid="1"'), "g2: … invalid-link marker");
      assertTrue(gUnknown.body.includes(`<h1>${T["claim.invalid.heading"]}</h1>`), "g3: … claim.invalid.heading verbatim");
      assertTrue(gUnknown.body.includes(T["claim.invalid.body"]), "g4: … claim.invalid.body verbatim");
      assertTrue(gUnknown.body.includes(`id="gc-claim-resend-form" method="post" action="${RESEND}"`), "g5: … resend form posts to send-ny-lenke");
      assertTrue(gUnknown.body.includes(`>${T["claim.invalid.button"]}</button>`), "g6: … button «Send ny lenke»");
      assertTrue(gUnknown.body.includes('Får du ikke e-posten? Skriv til <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>, så hjelper vi deg.'),
        "g7: … claim.help with the existing contact address");
      assertEq([gUnknown.headers["cache-control"], gUnknown.headers["referrer-policy"]], ["no-store", "no-referrer"], "g8: … no-store, no-referrer");
      assertTrue(gUnknown.body.includes(`name="token" value="${UNKNOWN}"`), "g9: … the token-shaped value is posted back by the form");

      const gExpired = await req("GET", `${VERIFY}?token=${EXPIRED}`);
      assertEq([gExpired.status, gExpired.body.includes('data-gc-claim-invalid="1"'), gExpired.headers["set-cookie"]], [200, true, undefined],
        "g10: GET verify, expired claim token -> 200 message, no session cookie");
      const gNone = await req("GET", VERIFY);
      assertEq([gNone.status, gNone.body.includes('name="token" value=""')], [200, true], "g11: GET verify without token -> 200, empty token field");
      const gOdd = await req("GET", `${VERIFY}?token=%22%3E%3Cscript%3Ex`);
      assertEq([gOdd.status, gOdd.body.includes("<script>x"), gOdd.body.includes('name="token" value=""')], [200, false, true],
        "g12: a non-token value is not echoed into the page");
      assertEq(snapshot(), before, "g13: the GETs changed no row");

      // ── (p) AK2 ─────────────────────────────────────────────────────────
      const n0 = claimCount();
      const pReal = await req("POST", RESEND, `token=${EXPIRED}&email=angriper%40example.com&to=angriper%40example.com`);
      assertEq(pReal.status, 200, "p1: POST resend, expired real claim -> 200");
      assertTrue(pReal.body.includes(T["claim.resend.done"]) && pReal.body.includes('data-gc-claim-resend="done"'), "p2: … claim.resend.done verbatim");
      assertEq(pReal.headers["cache-control"], "no-store", "p3: … no-store");
      assertEq(sent.map((s) => s.to), ["eier@lenketest.no"], "p4: one mail, only to the address already on the claim (body address ignored)");
      const newRow = db.prepare("SELECT email, email_source, token, used, created_at FROM gardssalg_claims WHERE provider_id = 'prov-o31' ORDER BY rowid DESC LIMIT 1").get() as any;
      assertEq([claimCount(), newRow.email, newRow.email_source, newRow.used], [n0 + 1, "eier@lenketest.no", "stored_epost_verified", 0], "p5: one new claim row on the same address and source");
      assertTrue(sent[0]?.verifyUrl.endsWith(`${VERIFY}?token=${newRow.token}`) && newRow.token !== EXPIRED, "p6: the mail carries the NEW link");
      assertEq(sent[0]?.providerName, "Lenketest Gård", "p7: … with the existing claim-link e-mail for that provider");

      const pUnknown = await req("POST", RESEND, `token=${UNKNOWN}&email=angriper%40example.com`);
      // Response identity: status, body and every header except per-request ones.
      const shape = (r: { status: number; headers: any; body: string }) => JSON.stringify([r.status, r.body,
        Object.entries(r.headers).filter(([k]) => !["date", "etag"].includes(k) && !k.includes("ratelimit")).sort()]);
      assertEq(shape(pUnknown), shape(pReal), "p8: unknown token -> identical status, body and headers");
      const pEmpty = await req("POST", RESEND, "");
      assertEq([pEmpty.status, pEmpty.body], [pReal.status, pReal.body], "p9: no token -> identical status and body");
      const pRevoked = await req("POST", RESEND, `token=${REVOKED}`);
      const pDraft = await req("POST", RESEND, `token=${DRAFT}`);
      const pLater = await req("POST", RESEND, `token=${LATER_REVOKED}`);
      assertEq([pRevoked, pDraft, pLater].every((r) => shape(r) === shape(pReal)), true, "p10: revoked / draft / later-revoked -> identical response");
      assertEq([sent.length, claimCount()], [1, n0 + 1], "p11: … and nothing sent, no row added for any of them");
      const pNoCand = await req("POST", RESEND, `token=${NOCAND}`);
      assertEq([shape(pNoCand), sent.length, claimCount()], [shape(pUnknown), 1, n0 + 1], "b1: address no longer a candidate -> nothing sent, identical response");
      const pNoBrreg = await req("POST", RESEND, `token=${NOBRREG}`);
      assertEq([shape(pNoBrreg), sent.length, claimCount()], [shape(pUnknown), 1, n0 + 1], "b2: provider brreg_verified=0 -> nothing sent, identical response");
      const pOld = await req("POST", RESEND, `token=${TOO_OLD}`);
      assertEq([shape(pOld), sent.length, claimCount()], [shape(pUnknown), 1, n0 + 1], "b3: source row older than 30 days -> nothing sent, identical response");
      const pSameDay = await req("POST", RESEND, `token=${SAMEDAY}`);
      assertEq([shape(pSameDay), sent.length], [shape(pUnknown), 1], "n3: a revoke later the same day still blocks (datetime-normalized compare)");
      const pTest = await req("POST", RESEND, `token=${TESTROW}`);
      const testRow = db.prepare("SELECT email, email_source, is_test FROM gardssalg_claims WHERE provider_id = 'prov-o31-test' ORDER BY rowid DESC LIMIT 1").get() as any;
      assertEq([shape(pTest), sent.length, sent[1]?.to, sent[1]?.isTestSend, testRow.email_source, testRow.is_test],
        [shape(pUnknown), 2, "test@testsending.no", true, "manual", 1], "n2: a manual is_test row is resent (age bound only) and keeps the test-send flag");
      sent.splice(1, 1);
      assertEq(fetchCalls, [], "b4: no harvest network call was made");

      // The new link logs in (existing verify path).
      const v = await req("GET", `${VERIFY}?token=${newRow.token}`);
      assertEq([v.status, v.headers.location], [302, "/kategori/gardssalg/eier/lenketest-gard/portal"], "p12: the resent link logs in as before");

      // «for mange»: 3 per token per hour, real or not.
      await req("POST", RESEND, `token=${EXPIRED}`);
      await req("POST", RESEND, `token=${EXPIRED}`);
      const pRealMany = await req("POST", RESEND, `token=${EXPIRED}`);
      assertEq(sent.length, 3, "p13: three sends for the real token, then the limit");
      assertTrue(pRealMany.body.includes(T["claim.resend.tooMany"]) && pRealMany.body.includes('data-gc-claim-resend="too_many"'), "p14: 4th request -> claim.resend.tooMany verbatim");
      await req("POST", RESEND, `token=${UNKNOWN}`);
      await req("POST", RESEND, `token=${UNKNOWN}`);
      const pUnknownMany = await req("POST", RESEND, `token=${UNKNOWN}`);
      assertEq([pUnknownMany.status, pUnknownMany.body], [pRealMany.status, pRealMany.body], "p15: the same tooMany answer for a token that matches nothing");
      assertEq(sent.length, 3, "p16: … and still no extra send");

      // ── (s) service ─────────────────────────────────────────────────────
      const now = Date.now();
      assertEq((await claimSvc.resendClaimLinkForToken(UNKNOWN, now)).outcome, "too_many", "s1: still limited inside the hour");
      assertEq((await claimSvc.resendClaimLinkForToken(UNKNOWN, now + 60 * 60 * 1000 + 1)).outcome, "done", "s2: the window ends after one hour (matches «Vent en time»)");
      const BUSY = hex("9");
      insertClaim.run({ id: "gsc_o31_busy0", provider_id: "prov-o31-busy", email: "eier@travel.no", token: BUSY, used: 0, revoked_at: null, draft_mode: 0, ...old });
      for (let i = 1; i <= 3; i++) {
        insertClaim.run({ id: `gsc_o31_busy${i}`, provider_id: "prov-o31-busy", email: "eier@travel.no", token: hex(String(i)), used: 0, revoked_at: null, draft_mode: 0,
          created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });
      }
      const nBusy = claimCount();
      const busy = await claimSvc.resendClaimLinkForToken(BUSY);
      assertEq([busy.outcome, busy.outcome === "done" ? busy.issued : "x", claimCount()], ["done", null, nBusy], "s3: provider over its own limit -> done, silently, no row");

      // ── (l) logs ────────────────────────────────────────────────────────
      const allLogs = logged.join("\n");
      const tokens = [EXPIRED, UNKNOWN, REVOKED, DRAFT, LATER_REVOKED, NOCAND, NOBRREG, TOO_OLD, TESTROW, SAMEDAY, newRow.token];
      assertTrue(!tokens.some((t) => allLogs.includes(t)) && !allLogs.includes("token="), "l1: no token or link in any log line");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-claim-invalid-link-o3-1: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      Object.assign(console, origConsole);
      (emailService as any).sendGardssalgClaimMagicLink = origSend;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgClaimInvalidLinkO31Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}

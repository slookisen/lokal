/**
 * gardssalg-claim-confirm-step-o3-2.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o3-eierkrav-og-innlogging, slice O3-2: a GET on the claim link
 * does not grant ownership (flag GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED).
 *
 * Covers:
 *   (c) flag on, the link GET renders the confirm page with the OA-4 part 2
 *       texts verbatim and a form that POSTs the token; no cookie, no-store.
 *   (a1) AK1 flag on: the GET changes no row (owner fields and the token's
 *       used state read before and after); a used or expired link gets the
 *       O3-1 page; «Dette er ikke meg» changes nothing.
 *   (a2) AK2 flag on: the POST sets ownership once and issues the session;
 *       a second POST with the same token is rejected with the O3-1 page.
 *   (a3) AK3 flag off: the GET grants ownership as before; the POST route
 *       does not answer.
 *   (l) nothing logs a token or a link.
 *
 * Exported runGardssalgClaimConfirmStepO32Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-claim-confirm-step-o3-2.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgClaimConfirmStepO32Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevFlag = process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const routerPath = require.resolve("./gardssalg-claim");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      dbFactoryPath,
      claimSvcPath,
      routerPath,
    ]);
    const logged: string[] = [];
    const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    let server: any = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const texts = require("./gardssalg-claim-texts") as typeof import("./gardssalg-claim-texts");
      const T = texts.CLAIM_CONFIRM_TEXTS;
      const TL = texts.CLAIM_LINK_TEXTS;
      const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      const insertProvider = db.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, content_source, epost, enrichment_state, verification_status, source, confidence)
        VALUES (@id, @navn, @slug, 'experiences', @org_nr, 1, NULL, NULL, 'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      insertProvider.run({ id: "prov-o32", navn: "Bekreft & Gård", slug: "bekreft-gard", org_nr: "913200001" });
      insertProvider.run({ id: "prov-o32-off", navn: "Flagg Av Gård", slug: "flagg-av-gard", org_nr: "913200002" });

      const hex = (c: string) => c.repeat(64).slice(0, 64);
      const insertClaimStmt = db.prepare(`
        INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at, revoked_at, draft_mode, is_test)
        VALUES (@id, @provider_id, 'eier@example.test', 'stored_epost_verified', @token, @used, @created_at, @expires_at, NULL, 0, 0)
      `);
      const DAY = 86400000;
      const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
      const live = { created_at: iso(0), expires_at: iso(1) };
      const FRESH = hex("5");
      insertClaimStmt.run({ id: "gsc_o32_fresh", provider_id: "prov-o32", token: FRESH, used: 0, ...live });
      const USED = hex("6");
      insertClaimStmt.run({ id: "gsc_o32_used", provider_id: "prov-o32", token: USED, used: 1, ...live });
      const EXPIRED = hex("7");
      insertClaimStmt.run({ id: "gsc_o32_exp", provider_id: "prov-o32", token: EXPIRED, used: 0, created_at: iso(-10), expires_at: iso(-3) });
      const OFF = hex("8");
      insertClaimStmt.run({ id: "gsc_o32_off", provider_id: "prov-o32-off", token: OFF, used: 0, ...live });

      const owner = (id: string) => db.prepare("SELECT content_source, claimed_at FROM experience_providers WHERE id = ?").get(id) as any;
      const usedOf = (token: string) => (db.prepare("SELECT used FROM gardssalg_claims WHERE token = ?").get(token) as any).used as number;
      const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM gardssalg_claims ORDER BY id").all())
        + JSON.stringify(db.prepare("SELECT id, content_source, claimed_at, updated_at FROM experience_providers ORDER BY id").all());

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
          const headers: Record<string, string> = { "X-Forwarded-For": "203.0.113.32" };
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
      const CONFIRM = "/kategori/gardssalg/eier/magic-link-confirm";
      const PORTAL = "/kategori/gardssalg/eier/bekreft-gard/portal";
      const isInvalidPage = (r: { status: number; body: string; headers: any }) =>
        r.status === 200 && r.body.includes('data-gc-claim-invalid="1"') && r.body.includes(TL["claim.invalid.body"]) && r.headers["set-cookie"] === undefined;

      for (const k of ["log", "warn", "error", "info"] as const) {
        (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      }

      // ── flag on ─────────────────────────────────────────────────────────
      process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED = "true";

      // (c) the confirm page
      const ownerBefore = owner("prov-o32");
      const usedBefore = usedOf(FRESH);
      const before = snapshot();
      const g = await req("GET", `${VERIFY}?token=${FRESH}`);
      assertEq([g.status, g.headers["set-cookie"], g.headers.location], [200, undefined, undefined], "c1: flag on, GET valid link -> 200 page, no cookie, no redirect");
      assertTrue(g.body.includes('data-gc-claim-confirm="1"'), "c2: … confirm-page marker");
      assertTrue(g.body.includes("<h1>Ta over profilen til Bekreft &amp; Gård</h1>"), "c3: … claim.confirm.heading verbatim with {produsent} filled (escaped)");
      assertTrue(g.body.includes(T["claim.confirm.body"]), "c4: … claim.confirm.body verbatim");
      assertTrue(g.body.includes("Du bekrefter at du har rett til å representere Bekreft &amp; Gård."), "c5: … claim.confirm.responsibility verbatim");
      assertTrue(g.body.includes(`>${T["claim.confirm.button"]}</button>`) && g.body.includes(`>${T["claim.confirm.notMe"]}</button>`), "c6: … both buttons verbatim");
      assertTrue(g.body.includes(`id="gc-claim-confirm-form" method="post" action="${CONFIRM}"`), "c7: … the form POSTs to magic-link-confirm");
      assertTrue(g.body.includes(`name="token" value="${FRESH}"`), "c8: … the token travels in the form body");
      assertEq([g.headers["cache-control"], g.headers["referrer-policy"]], ["no-store", "no-referrer"], "c9: … no-store, no-referrer");

      // (a1) AK1: the GET changed no row
      await req("GET", `${VERIFY}?token=${FRESH}`); // a scanner opening it twice
      assertEq(owner("prov-o32"), ownerBefore, "a1-1: AK1 owner fields (content_source, claimed_at) unchanged after GET");
      assertEq([usedBefore, usedOf(FRESH)], [0, 0], "a1-2: AK1 token still unused after GET");
      assertEq(snapshot(), before, "a1-3: AK1 no row at all changed");
      assertEq(claimSvc.verifyGardssalgOwnerSessionToken(FRESH).valid, false, "a1-4: … and no session exists for the token");
      const gUsed = await req("GET", `${VERIFY}?token=${USED}`);
      assertTrue(isInvalidPage(gUsed), "a1-5: flag on, GET an already-used link -> O3-1 page, no cookie");
      const gExp = await req("GET", `${VERIFY}?token=${EXPIRED}`);
      assertTrue(isInvalidPage(gExp), "a1-6: flag on, GET an expired link -> O3-1 page as before");
      const gNone = await req("GET", VERIFY);
      assertTrue(isInvalidPage(gNone), "a1-7: flag on, GET without token -> O3-1 page as before");
      const notMe = await req("POST", CONFIRM, `token=${FRESH}&action=not_me`);
      assertEq([notMe.status, notMe.headers["set-cookie"], notMe.body.includes(T["claim.confirm.notMe.done"])], [200, undefined, true],
        "a1-8: «Dette er ikke meg» -> claim.confirm.notMe.done, no cookie");
      assertEq(snapshot(), before, "a1-9: … and nothing changed");

      // (a2) AK2: POST sets ownership once
      const p1 = await req("POST", CONFIRM, `token=${FRESH}&action=confirm`);
      assertEq([p1.status, p1.headers.location], [302, PORTAL], "a2-1: AK2 POST -> 302 to the portal, as the GET did");
      const cookie = String((p1.headers["set-cookie"] || [])[0] || "");
      assertTrue(cookie.startsWith(`oa_owner_session=${FRESH};`) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie),
        "a2-2: … session cookie as today (HttpOnly, Secure, SameSite=Lax)");
      const ownerAfter = owner("prov-o32");
      assertEq([usedOf(FRESH), ownerAfter.content_source, typeof ownerAfter.claimed_at], [1, "claim", "string"], "a2-3: … token used, content_source=claim, claimed_at set");
      assertEq(claimSvc.verifyGardssalgOwnerSessionToken(FRESH).valid, true, "a2-4: … the session is valid");
      const afterFirst = snapshot();
      const p2 = await req("POST", CONFIRM, `token=${FRESH}&action=confirm`);
      assertTrue(isInvalidPage(p2), "a2-5: AK2 second POST with the same token -> rejected with the O3-1 page, no cookie");
      assertEq(snapshot(), afterFirst, "a2-6: … and changes nothing");
      const pNone = await req("POST", CONFIRM, "action=confirm");
      const pUsed = await req("POST", CONFIRM, `token=${USED}`);
      const pExp = await req("POST", CONFIRM, `token=${EXPIRED}`);
      assertTrue(isInvalidPage(pNone) && isInvalidPage(pUsed) && isInvalidPage(pExp), "a2-7: POST without token / used / expired -> O3-1 page");
      const gAgain = await req("GET", `${VERIFY}?token=${FRESH}`);
      assertTrue(isInvalidPage(gAgain), "a2-8: flag on, GET the confirmed link again -> O3-1 page, no new session");
      assertEq(snapshot(), afterFirst, "a2-9: … nothing changed by any of these");

      // ── (a3) AK3 flag off: as today ─────────────────────────────────────
      delete process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED;
      const offBefore = snapshot();
      const pOff = await req("POST", CONFIRM, `token=${OFF}&action=confirm`);
      assertEq([pOff.status, pOff.headers["set-cookie"]], [404, undefined], "a3-1: flag off, POST magic-link-confirm is not answered (404)");
      assertEq(snapshot(), offBefore, "a3-2: … and changes nothing");
      const gOff = await req("GET", `${VERIFY}?token=${OFF}`);
      assertEq([gOff.status, gOff.headers.location], [302, "/kategori/gardssalg/eier/flagg-av-gard/portal"], "a3-3: AK3 flag off, GET -> 302 to the portal as today");
      assertTrue(String((gOff.headers["set-cookie"] || [])[0] || "").startsWith(`oa_owner_session=${OFF};`), "a3-4: … session cookie set by the GET");
      const offOwner = owner("prov-o32-off");
      assertEq([usedOf(OFF), offOwner.content_source, typeof offOwner.claimed_at], [1, "claim", "string"], "a3-5: … GET grants ownership as before");
      const gOff2 = await req("GET", `${VERIFY}?token=${OFF}`);
      assertEq([gOff2.status, gOff2.headers.location], [302, "/kategori/gardssalg/eier/flagg-av-gard/portal"], "a3-6: … a used link still logs in again via GET, as today");
      const gOffExp = await req("GET", `${VERIFY}?token=${EXPIRED}`);
      assertTrue(isInvalidPage(gOffExp), "a3-7: flag off, expired link -> O3-1 page as before");
      process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED = "false";
      const gOffFalse = await req("GET", `${VERIFY}?token=${OFF}`);
      assertEq(gOffFalse.status, 302, "a3-8: GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED=false is off too");

      // ── (l) logs ────────────────────────────────────────────────────────
      const allLogs = logged.join("\n");
      assertTrue(![FRESH, USED, EXPIRED, OFF].some((t) => allLogs.includes(t)) && !allLogs.includes("token="), "l1: no token or link in any log line");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-claim-confirm-step-o3-2: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      Object.assign(console, origConsole);
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevFlag === undefined) delete process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED;
      else process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED = prevFlag;
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
  runGardssalgClaimConfirmStepO32Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}

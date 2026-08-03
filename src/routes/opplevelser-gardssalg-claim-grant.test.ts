/**
 * opplevelser-gardssalg-claim-grant.test.ts — tests for the admin
 * claim-grant lever (dev-request 2026-07-30-opplevagent-claim-epost-og-
 * perfelt-laas, item 2 ONLY):
 *
 *   - issueAdminGrantedClaimMagicLink() / hasActiveNonRevokedClaim()
 *     (src/services/gardssalg-claim.ts)
 *   - POST /admin/gardssalg-claim-grant (src/routes/opplevelser.ts)
 *
 * For a producer who emails kontakt@opplevagent.no directly asking to claim
 * their profile (rather than qualifying for/using the self-serve flow), this
 * lets an admin grant a claim magic-link to an operator-supplied email. It
 * reuses the SAME insertGardssalgClaimRow() mechanics issueClaimMagicLink()
 * itself uses (this test pins email_source='manual' — the 4th, admin-only
 * tier — as proof it isn't a divergent mechanism), and it must NEVER stamp
 * experience_providers.content_source='manual' (that would freeze the row
 * from the owner's own future edits) — content_source only ever becomes
 * 'claim' once the link is actually verified, same as every self-serve tier.
 *
 * Mirrors opplevelser-gardssalg-address-enrichment.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * gardssalg-claim + opplevelser router per run, callRoute() exercised
 * directly against router.handle() with X-Admin-Key via headers) plus
 * opplevelser-booking-send-guard.test.ts's fake-transporter injection (so a
 * real `apply:true` grant's fire-and-forget email is observed at the actual
 * send boundary, not merely assumed).
 *
 * Covers:
 *   (a) unauthenticated -> 403
 *   (b) missing provider_id -> 400 provider_id_required
 *   (c) missing / malformed email -> 400 invalid_email (dry-run and apply)
 *   (d) unknown provider_id -> 404 provider_not_found
 *   (e) dry-run (default, no `apply`) -> dry_run:true, would_grant echoes the
 *       normalized email + email_source:'manual', but creates NO
 *       gardssalg_claims row and sends NO email
 *   (f) apply:true -> dry_run:false, a real gardssalg_claims row is created
 *       with email_source='manual', experience_providers.content_source is
 *       COMPLETELY untouched (stays whatever it was — nul/'claim'/etc, never
 *       forced to 'manual'), and the magic-link email is actually sent (seen
 *       at the fake transporter) to the exact operator-supplied address
 *   (g) once that granted claim is verified (verifyClaimToken, unchanged),
 *       content_source becomes 'claim' — NOT 'manual' — so the portal's
 *       edit form stays enabled for this producer (acceptance criterion 3)
 *   (h) an already-claimed, NON-revoked provider -> 409 already_claimed, in
 *       BOTH dry-run and apply, and apply creates no new row
 *   (i) a claimed-but-REVOKED provider is NOT blocked — a fresh grant is
 *       allowed through (hasActiveNonRevokedClaim's revoked_at IS NULL
 *       condition is what's actually gating this, not "was ever claimed")
 *   (j) email is normalized (trim + lowercase) before being stored/sent
 *   (k) apply=1 (string) and ?apply=true (query) are honored the same as the
 *       literal boolean, same convention as every sibling admin route
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-claim-grant";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: opts.query || {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgClaimGrantTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-claim-grant-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const emailPath = require.resolve("../services/email-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, claimSvcPath, emailPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;

    try {
      // EmailService.sendEmail() derives its From-address via getConfig(),
      // which insists boot-time config loading has happened. Idempotent.
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fake transport at the REAL send boundary (mirrors
      // opplevelser-booking-send-guard.test.ts) ───────────────────────────
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      let sent: Array<Record<string, any>> = [];
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (mailOptions: Record<string, any>) => {
          sent.push(mailOptions);
          return { messageId: `stub-${sent.length}` };
        },
      };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, slug, vertical, content_source, created_at)
         VALUES (@id, @navn, @slug, 'experiences', @content_source, @created_at)`,
      );

      function getProviderRow(id: string): any {
        return expDb.prepare(`SELECT id, content_source FROM experience_providers WHERE id = ?`).get(id);
      }
      function getClaimRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at ASC`,
        ).all(providerId);
      }

      insertProvider.run({
        id: "grant-fresh", navn: "Grant Fresh Gard", slug: "grant-fresh-gard",
        content_source: null, created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "grant-already-claimed", navn: "Grant Already Claimed Gard", slug: "grant-already-claimed-gard",
        content_source: "claim", created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "grant-revoked", navn: "Grant Revoked Gard", slug: "grant-revoked-gard",
        content_source: "claim", created_at: "2026-02-01 00:00:00",
      });

      const auth = { "x-admin-key": testKey };

      // ── (a) unauthenticated -> 403 ───────────────────────────────────────
      const noKeyRes = await callRoute(opplevelserRouter, {
        body: { provider_id: "grant-fresh", email: "eier@grantfresh.no" },
      });
      assertEq(noKeyRes.status, 403, "a1: missing X-Admin-Key -> 403");

      // ── (b) missing provider_id -> 400 ───────────────────────────────────
      const noProviderId = await callRoute(opplevelserRouter, {
        headers: auth, body: { email: "eier@grantfresh.no" },
      });
      assertEq(noProviderId.status, 400, "b1: missing provider_id -> 400");
      assertEq(noProviderId.body.error, "provider_id_required", "b2: with error=provider_id_required");

      // ── (c) missing / malformed email -> 400 ─────────────────────────────
      const noEmail = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-fresh" },
      });
      assertEq(noEmail.status, 400, "c1: missing email -> 400");
      assertEq(noEmail.body.error, "invalid_email", "c2: with error=invalid_email");

      const badEmail = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-fresh", email: "not-an-email" },
      });
      assertEq(badEmail.status, 400, "c3: malformed email -> 400 invalid_email");

      const badEmailApply = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-fresh", email: "not-an-email", apply: true },
      });
      assertEq(badEmailApply.status, 400, "c4: malformed email rejected the same way with apply:true");
      assertEq(getClaimRows("grant-fresh").length, 0, "c5: no claim row created by the rejected apply attempt");

      // ── (d) unknown provider_id -> 404 ───────────────────────────────────
      const unknownProvider = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "does-not-exist", email: "eier@nowhere.no" },
      });
      assertEq(unknownProvider.status, 404, "d1: unknown provider_id -> 404 provider_not_found");
      assertEq(unknownProvider.body.error, "provider_not_found", "d2: with error=provider_not_found");

      // ── (e) dry-run (default) ─────────────────────────────────────────────
      sent = [];
      const dryRun = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-fresh", email: "  Eier@GrantFresh.no  " },
      });
      assertEq(dryRun.status, 200, "e1: dry-run (no apply) -> 200");
      assertEq(dryRun.body.dry_run, true, "e2: dry_run:true by default");
      assertEq(dryRun.body.would_grant.provider_id, "grant-fresh", "e3: would_grant echoes provider_id");
      assertEq(dryRun.body.would_grant.email, "eier@grantfresh.no", "e4: would_grant echoes the NORMALIZED (trimmed+lowercased) email");
      assertEq(dryRun.body.would_grant.email_source, "manual", "e5: would_grant reports email_source=manual");
      assertEq(getClaimRows("grant-fresh").length, 0, "e6: dry-run creates ZERO gardssalg_claims rows");
      assertEq(sent.length, 0, "e7: dry-run sends ZERO emails");
      assertEq(getProviderRow("grant-fresh").content_source, null, "e8: dry-run never touches content_source");

      // ── (f) apply:true -> real grant ─────────────────────────────────────
      sent = [];
      const applyRes = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-fresh", email: "Eier@GrantFresh.no", apply: true },
      });
      assertEq(applyRes.status, 200, "f1: apply:true -> 200");
      assertEq(applyRes.body.dry_run, false, "f2: dry_run:false");
      assertTrue(typeof applyRes.body.claim_id === "string" && applyRes.body.claim_id.length > 0, "f3: response carries a claim_id");
      assertEq(applyRes.body.email, "eier@grantfresh.no", "f4: response echoes the normalized email");
      assertEq(applyRes.body.email_source, "manual", "f5: response's email_source is 'manual'");

      const claimRowsAfterApply = getClaimRows("grant-fresh");
      assertEq(claimRowsAfterApply.length, 1, "f6: exactly one gardssalg_claims row created");
      assertEq(claimRowsAfterApply[0].email, "eier@grantfresh.no", "f7: the persisted row's email is normalized");
      assertEq(claimRowsAfterApply[0].email_source, "manual", "f8: the persisted row's email_source is 'manual'");
      assertEq(claimRowsAfterApply[0].used, 0, "f9: the persisted row is not yet used (still just an issued link)");

      assertEq(getProviderRow("grant-fresh").content_source, null, "f10: content_source is COMPLETELY untouched by granting (never forced to 'manual')");

      assertEq(sent.length, 1, "f11: exactly one email was actually sent");
      assertEq(sent[0].to, "eier@grantfresh.no", "f12: the email went to the exact operator-supplied (normalized) address");
      assertTrue(String(sent[0].html || sent[0].text || "").includes(claimRowsAfterApply[0].token), "f13: the sent email carries the real verify token");

      // ── (g) verifying the granted claim sets content_source='claim', not
      //     'manual' ────────────────────────────────────────────────────────
      const verifyResult = claimSvc.verifyClaimToken(claimRowsAfterApply[0].token);
      assertTrue(verifyResult.valid, "g1: the admin-granted token verifies successfully");
      assertEq(getProviderRow("grant-fresh").content_source, "claim", "g2: content_source becomes 'claim' (NOT 'manual') once verified — portal stays editable");

      // ── (h) already-claimed, non-revoked provider -> 409 ─────────────────
      // grant-already-claimed has content_source='claim' from its fixture but
      // no gardssalg_claims row yet — insert one directly (used=1, not
      // revoked) to represent "someone already completed a claim".
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, created_at, expires_at)
         VALUES ('gsc_fixture_used', 'grant-already-claimed', 'forrige-eier@alt.no', 'verified_domain_address', 'tok-used-1', 1, datetime('now'), datetime('now'), datetime('now', '+7 days'))`,
      ).run();

      const alreadyClaimedDry = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-already-claimed", email: "ny-eier@alt.no" },
      });
      assertEq(alreadyClaimedDry.status, 409, "h1: already-claimed, non-revoked provider -> 409 (dry-run)");
      assertEq(alreadyClaimedDry.body.error, "already_claimed", "h2: with error=already_claimed (dry-run)");

      const alreadyClaimedApply = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-already-claimed", email: "ny-eier@alt.no", apply: true },
      });
      assertEq(alreadyClaimedApply.status, 409, "h3: already-claimed, non-revoked provider -> 409 (apply)");
      assertEq(getClaimRows("grant-already-claimed").length, 1, "h4: apply on an already-claimed provider creates NO new claim row");

      // ── (i) a claimed-but-REVOKED provider is NOT blocked ────────────────
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES ('gsc_fixture_revoked', 'grant-revoked', 'tidligere-eier@alt.no', 'verified_domain_address', 'tok-revoked-1', 1, datetime('now'), datetime('now'), datetime('now'), datetime('now', '+7 days'))`,
      ).run();
      assertTrue(!claimSvc.hasActiveNonRevokedClaim("grant-revoked"), "i0: hasActiveNonRevokedClaim is false when the only claim is revoked");

      sent = [];
      const revokedGrant = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-revoked", email: "ny-eier@revoked.no", apply: true },
      });
      assertEq(revokedGrant.status, 200, "i1: a revoked prior claim does NOT block a new grant -> 200");
      assertEq(getClaimRows("grant-revoked").filter((r: any) => r.used === 0).length, 1, "i2: a fresh (unused) claim row was created for the revoked provider");
      assertEq(sent.length, 1, "i3: the new grant's email was actually sent");

      // ── (k) apply=1 (string) / ?apply=true (query) honored ───────────────
      insertProvider.run({
        id: "grant-apply-string", navn: "Grant Apply String Gard", slug: "grant-apply-string-gard",
        content_source: null, created_at: "2026-02-01 00:00:00",
      });
      sent = [];
      const applyStringRes = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "grant-apply-string", email: "eier@applystring.no", apply: "1" },
      });
      assertEq(applyStringRes.body.dry_run, false, "k1: apply='1' (string) is honored the same as apply:true");
      assertEq(getClaimRows("grant-apply-string").length, 1, "k2: apply='1' actually created a claim row");

      insertProvider.run({
        id: "grant-apply-query", navn: "Grant Apply Query Gard", slug: "grant-apply-query-gard",
        content_source: null, created_at: "2026-02-01 00:00:00",
      });
      sent = [];
      const applyQueryRes = await callRoute(opplevelserRouter, {
        headers: auth, query: { apply: "true" },
        body: { provider_id: "grant-apply-query", email: "eier@applyquery.no" },
      });
      assertEq(applyQueryRes.body.dry_run, false, "k3: ?apply=true (query) is honored the same as body apply:true");
      assertEq(getClaimRows("grant-apply-query").length, 1, "k4: ?apply=true actually created a claim row");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-claim-grant: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-claim-grant.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgClaimGrantTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

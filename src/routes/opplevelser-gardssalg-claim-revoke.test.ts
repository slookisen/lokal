/**
 * opplevelser-gardssalg-claim-revoke.test.ts — tests for the admin
 * claim-revoke lever (dev-request 2026-08-10-gardssalg-eier-flyt-e2e-
 * repeterbar-revoke-og-editable-fixtur, item A):
 *
 *   POST /api/opplevelser/admin/gardssalg-claim-revoke (src/routes/opplevelser.ts)
 *
 * A session running the owner-claim E2E live against prod on the hidden
 * test-provider row found there was NO way to un-claim a claimed row again
 * — hasActiveNonRevokedClaim()'s "already claimed, non-revoked" guard
 * (services/gardssalg-claim.ts) then permanently blocks both POST
 * /admin/gardssalg-claim-grant and the public self-serve .../request route
 * with 409 already_claimed, making the E2E a one-shot. revokeClaimToken()
 * already existed but was only ever called from the owner's OWN /logout
 * route (keyed off their own session token) — there was no admin lever to
 * revoke on a producer's behalf. This route is that lever.
 *
 * Mirrors opplevelser-gardssalg-claim-grant.test.ts's harness exactly
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * gardssalg-claim + opplevelser router per run, callRoute() driving
 * router.handle() directly with X-Admin-Key via headers).
 *
 * Covers:
 *   (a) unauthenticated -> 403
 *   (b) missing provider_id -> 400 provider_id_required
 *   (c) unknown provider_id -> 404 provider_not_found
 *   (d) dry-run (default, no `apply`) on a provider with one active,
 *       non-revoked claim -> dry_run:true, would_revoke lists exactly that
 *       claim (masked email), and writes/revokes NOTHING
 *   (e) apply:true -> dry_run:false, the claim's revoked_at is actually set,
 *       claimed_at and content_source are COMPLETELY untouched, and exactly
 *       one gardssalg_content_audit row is written
 *   (f) idempotent: a second apply:true call on the same provider finds
 *       zero active/non-revoked claims left and revokes/audits nothing
 *       further
 *   (g) after a real revoke, hasActiveNonRevokedClaim() is false and a
 *       fresh POST /admin/gardssalg-claim-grant against the same provider
 *       succeeds again (was previously blocked with 409 already_claimed)
 *   (h) a provider with NO active/non-revoked claims (never claimed, or
 *       only ever had unused/expired/already-revoked rows) -> 200 with an
 *       empty would_revoke / revoked list, not an error
 *   (i) a provider with an unused (used=0) claim row is left alone — only
 *       used=1 rows are ever revoked
 *   (j) multiple active, non-revoked claims for one provider are ALL
 *       revoked in a single apply call, each with its own audit row
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
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-claim-revoke";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
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

export function runOpplevelserGardssalgClaimRevokeTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-claim-revoke-test-key";
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
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        /* already loaded by an earlier suite in the same process */
      }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // Fake transport — needed so a follow-up gardssalg-claim-grant call in
      // test (g) doesn't throw trying to actually send mail.
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
        `INSERT INTO experience_providers (id, navn, slug, vertical, content_source, claimed_at, created_at)
         VALUES (@id, @navn, @slug, 'experiences', @content_source, @claimed_at, @created_at)`,
      );
      const insertClaim = expDb.prepare(
        `INSERT INTO gardssalg_claims
           (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES (@id, @provider_id, @email, @email_source, @token, @used, @used_at, @revoked_at, @created_at, @expires_at)`,
      );

      function getProviderRow(id: string): any {
        return expDb.prepare(`SELECT id, content_source, claimed_at FROM experience_providers WHERE id = ?`).get(id);
      }
      function getClaimRows(providerId: string): any[] {
        return expDb.prepare(`SELECT * FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at ASC`).all(providerId);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb
          .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'gardssalg_claim_revoked' ORDER BY changed_at ASC`)
          .all(providerId);
      }

      const auth = { "x-admin-key": testKey };

      // ── fixture: one claimed provider with a single active, non-revoked
      //    claim ─────────────────────────────────────────────────────────
      insertProvider.run({
        id: "revoke-fresh", navn: "Revoke Fresh Gard", slug: "revoke-fresh-gard",
        content_source: "claim", claimed_at: "2026-08-01 10:00:00", created_at: "2026-02-01 00:00:00",
      });
      insertClaim.run({
        id: "gsc_revoke_fresh_1", provider_id: "revoke-fresh", email: "eier@revokefresh.no",
        email_source: "stored_epost_verified", token: "tok-revoke-fresh-1", used: 1,
        used_at: "2026-08-01 10:00:00", revoked_at: null, created_at: "2026-08-01 09:00:00",
        expires_at: "2026-08-08 09:00:00",
      });

      // ── (a) unauthenticated -> 403 ───────────────────────────────────────
      const noKeyRes = await callRoute(opplevelserRouter, { body: { provider_id: "revoke-fresh" } });
      assertEq(noKeyRes.status, 403, "a1: missing X-Admin-Key -> 403");

      // ── (b) missing provider_id -> 400 ───────────────────────────────────
      const noProviderId = await callRoute(opplevelserRouter, { headers: auth, body: {} });
      assertEq(noProviderId.status, 400, "b1: missing provider_id -> 400");
      assertEq(noProviderId.body.error, "provider_id_required", "b2: with error=provider_id_required");

      // ── (c) unknown provider_id -> 404 ───────────────────────────────────
      const unknownProvider = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "does-not-exist" },
      });
      assertEq(unknownProvider.status, 404, "c1: unknown provider_id -> 404 provider_not_found");
      assertEq(unknownProvider.body.error, "provider_not_found", "c2: with error=provider_not_found");

      // ── (d) dry-run (default) ────────────────────────────────────────────
      const dryRun = await callRoute(opplevelserRouter, { headers: auth, body: { provider_id: "revoke-fresh" } });
      assertEq(dryRun.status, 200, "d1: dry-run (no apply) -> 200");
      assertEq(dryRun.body.dry_run, true, "d2: dry_run:true by default");
      assertEq(dryRun.body.would_revoke.length, 1, "d3: would_revoke lists exactly the one active claim");
      assertEq(dryRun.body.would_revoke[0].claim_id, "gsc_revoke_fresh_1", "d4: ...naming its claim_id");
      assertTrue(
        typeof dryRun.body.would_revoke[0].email_masked === "string" &&
          !dryRun.body.would_revoke[0].email_masked.includes("eier@revokefresh.no"),
        "d5: would_revoke reports a MASKED email, never the raw address",
      );
      assertEq(getClaimRows("revoke-fresh")[0].revoked_at, null, "d6: dry-run writes NOTHING — revoked_at is still NULL");

      // ── (e) apply:true -> real revoke ────────────────────────────────────
      const applyRes = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "revoke-fresh", apply: true },
      });
      assertEq(applyRes.status, 200, "e1: apply:true -> 200");
      assertEq(applyRes.body.dry_run, false, "e2: dry_run:false");
      assertEq(applyRes.body.revoked.length, 1, "e3: exactly one claim reported revoked");
      assertEq(applyRes.body.revoked[0].claim_id, "gsc_revoke_fresh_1", "e4: ...naming the revoked claim_id");

      const claimAfterRevoke = getClaimRows("revoke-fresh")[0];
      assertTrue(typeof claimAfterRevoke.revoked_at === "string" && claimAfterRevoke.revoked_at.length > 0, "e5: revoked_at is actually set on the claim row");
      assertEq(claimAfterRevoke.used, 1, "e6: used is left alone (still 1 — a real historical claim happened)");

      const providerAfterRevoke = getProviderRow("revoke-fresh");
      assertEq(providerAfterRevoke.claimed_at, "2026-08-01 10:00:00", "e7: claimed_at is COMPLETELY untouched by revoke (historical badge survives)");
      assertEq(providerAfterRevoke.content_source, "claim", "e8: content_source is COMPLETELY untouched by revoke");

      const auditRows = getAuditRows("revoke-fresh");
      assertEq(auditRows.length, 1, "e9: exactly ONE gardssalg_content_audit row was written for the revoke");
      assertEq(auditRows[0].old_value, "gsc_revoke_fresh_1", "e10: the audit row's old_value names the revoked claim id");
      assertEq(auditRows[0].new_value, "revoked", "e11: the audit row's new_value is 'revoked'");
      assertEq(auditRows[0].changed_by, "admin", "e12: the audit row's changed_by is 'admin'");

      // ── (f) idempotent — a second apply:true finds nothing left ─────────
      const secondApply = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "revoke-fresh", apply: true },
      });
      assertEq(secondApply.status, 200, "f1: a second apply:true call -> 200 (not an error)");
      assertEq(secondApply.body.revoked.length, 0, "f2: ...revokes ZERO claims (already revoked)");
      assertEq(getAuditRows("revoke-fresh").length, 1, "f3: ...and writes NO additional audit row");

      // ── (g) hasActiveNonRevokedClaim() is now false, and a fresh grant
      //     succeeds where it would previously have hit 409 already_claimed ──
      assertTrue(!claimSvc.hasActiveNonRevokedClaim("revoke-fresh"), "g1: hasActiveNonRevokedClaim is false after the revoke");

      const preGrantCheck = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-claim-grant",
        headers: auth,
        body: { provider_id: "revoke-fresh", email: "ny-eier@revokefresh.no" },
      });
      assertEq(preGrantCheck.status, 200, "g2: a dry-run gardssalg-claim-grant against the revoked provider no longer 409s");
      assertTrue(preGrantCheck.body.dry_run === true, "g3: ...(still a normal dry-run response, not an error)");

      sent = [];
      const freshGrant = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-claim-grant",
        headers: auth,
        body: { provider_id: "revoke-fresh", email: "ny-eier@revokefresh.no", apply: true },
      });
      assertEq(freshGrant.status, 200, "g4: a fresh apply:true grant against the revoked provider succeeds (was 409 before this dev-request's revoke lever existed)");
      assertEq(sent.length, 1, "g5: ...and actually sends the new magic-link email");
      assertEq(getClaimRows("revoke-fresh").filter((r: any) => r.used === 0).length, 1, "g6: ...creating a fresh, unused claim row");

      // ── (h) a provider with no active/non-revoked claims at all -> 200,
      //     empty lists, not an error ───────────────────────────────────────
      insertProvider.run({
        id: "revoke-never-claimed", navn: "Never Claimed Gard", slug: "revoke-never-claimed-gard",
        content_source: null, claimed_at: null, created_at: "2026-02-01 00:00:00",
      });
      const dryNever = await callRoute(opplevelserRouter, { headers: auth, body: { provider_id: "revoke-never-claimed" } });
      assertEq(dryNever.status, 200, "h1: dry-run on a never-claimed provider -> 200");
      assertEq(dryNever.body.would_revoke, [], "h2: ...with an empty would_revoke");
      const applyNever = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "revoke-never-claimed", apply: true },
      });
      assertEq(applyNever.status, 200, "h3: apply:true on a never-claimed provider -> 200 (not an error)");
      assertEq(applyNever.body.revoked, [], "h4: ...with an empty revoked list");
      assertEq(getAuditRows("revoke-never-claimed").length, 0, "h5: ...and no audit row");

      // ── (i) an UNUSED (used=0) claim is left alone ───────────────────────
      insertProvider.run({
        id: "revoke-unused-only", navn: "Unused Only Gard", slug: "revoke-unused-only-gard",
        content_source: null, claimed_at: null, created_at: "2026-02-01 00:00:00",
      });
      insertClaim.run({
        id: "gsc_unused_1", provider_id: "revoke-unused-only", email: "eier@unusedonly.no",
        email_source: "stored_epost_verified", token: "tok-unused-1", used: 0,
        used_at: null, revoked_at: null, created_at: "2026-08-01 09:00:00", expires_at: "2026-08-08 09:00:00",
      });
      const dryUnused = await callRoute(opplevelserRouter, { headers: auth, body: { provider_id: "revoke-unused-only" } });
      assertEq(dryUnused.body.would_revoke, [], "i1: an unused (not-yet-clicked) claim link is NOT reported as would-revoke");
      const applyUnused = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "revoke-unused-only", apply: true },
      });
      assertEq(applyUnused.body.revoked, [], "i2: ...nor actually revoked");
      assertEq(getClaimRows("revoke-unused-only")[0].revoked_at, null, "i3: the unused claim row's revoked_at stays NULL");

      // ── (j) multiple active, non-revoked claims -> ALL revoked, each with
      //     its own audit row ──────────────────────────────────────────────
      insertProvider.run({
        id: "revoke-multi", navn: "Multi Claim Gard", slug: "revoke-multi-gard",
        content_source: "claim", claimed_at: "2026-08-01 10:00:00", created_at: "2026-02-01 00:00:00",
      });
      insertClaim.run({
        id: "gsc_multi_1", provider_id: "revoke-multi", email: "forste@multi.no",
        email_source: "stored_epost_verified", token: "tok-multi-1", used: 1,
        used_at: "2026-08-01 10:00:00", revoked_at: null, created_at: "2026-08-01 09:00:00", expires_at: "2026-08-08 09:00:00",
      });
      insertClaim.run({
        id: "gsc_multi_2", provider_id: "revoke-multi", email: "andre@multi.no",
        email_source: "manual", token: "tok-multi-2", used: 1,
        used_at: "2026-08-02 10:00:00", revoked_at: null, created_at: "2026-08-02 09:00:00", expires_at: "2026-08-09 09:00:00",
      });
      const dryMulti = await callRoute(opplevelserRouter, { headers: auth, body: { provider_id: "revoke-multi" } });
      assertEq(dryMulti.body.would_revoke.length, 2, "j1: dry-run lists BOTH active claims");
      const applyMulti = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_id: "revoke-multi", apply: true },
      });
      assertEq(applyMulti.body.revoked.length, 2, "j2: apply revokes BOTH claims in one call");
      const multiRowsAfter = getClaimRows("revoke-multi");
      assertTrue(multiRowsAfter.every((r: any) => typeof r.revoked_at === "string" && r.revoked_at.length > 0), "j3: both claim rows now have revoked_at set");
      assertEq(getAuditRows("revoke-multi").length, 2, "j4: two separate audit rows were written, one per revoked claim");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-claim-revoke: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-claim-revoke.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgClaimRevokeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

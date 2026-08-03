/**
 * opplevelser-hjemmeside-write.test.ts — unit tests for
 *
 *   POST /api/opplevelser/admin/providers/hjemmeside-write
 *
 * Steg 4 of the 2026-08-03-hjemmeside-skrivespak dev-request: the batch
 * write-lever for experience_providers.hjemmeside, modeled structurally on
 * admin-agents-url-write.ts but adapted to experience_providers' own
 * conventions (content_source-only lock, hostFromUrlLike/
 * isDirectoryOrAggregatorHost from cross-source-validator.ts, a local
 * platform-host denylist, field_provenance.hjemmeside_verification
 * invalidation, and a new generalized audit table).
 *
 * Setup mirrors opplevelser-admin-providers-hjemmeside.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle()
 * (X-Admin-Key via headers, JSON body passed as req.body directly since
 * calling the router bypasses the app-level express.json() middleware) —
 * no real HTTP server / supertest needed.
 *
 * Covers (per the dev-request's own "at minimum" list):
 *   (a) dry-run (default / apply:false) vs apply:true
 *   (b) lock rejection for content_source='manual' and 'claim', plus the
 *       allow_locked_override escape hatch (both top-level and per-row)
 *   (c) directory/aggregator host rejection (rejected_directory_host)
 *   (d) platform-host rejection (rejected_platform_host), including the
 *       userinfo-trick case (https://evil.com@rettfrabonden.com/)
 *   (e) clearing via hjemmeside: null
 *   (f) empty-string rejection (rejected_invalid_item, distinct from null)
 *   (g) skip-if-unchanged (no write, no audit row)
 *   (h) batch cap (HJEMMESIDE_WRITE_MAX_ITEMS = 200)
 *   (i) audit row content in experience_provider_field_write_audit
 *       (old_value/new_value correct, one row per successful write)
 *   (j) field_provenance.hjemmeside_verification invalidation-on-change:
 *       a prior verified:true stamp flips to verified:false after a REAL
 *       URL change, and is left byte-for-byte alone when the write is
 *       rejected, skipped-unchanged, or only a dry-run
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
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const query = opts.query || {};
    const basePath = opts.path || "/";
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method,
      url: basePath + qs,
      originalUrl: basePath + qs,
      path: basePath,
      query,
      params: opts.params || {},
      headers: opts.headers || {},
      body: opts.body,
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

export function runOpplevelserHjemmesideWriteTests(
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
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "hjemmeside-write-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, field_provenance, updated_at,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @field_provenance, @updated_at,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      const verifiedTrueProvenance = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-07-01T00:00:00.000Z" },
      });

      insertProvider.run({
        id: "prov-open", navn: "Åpen Gård AS",
        hjemmeside: "https://open-farm.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-manual-locked", navn: "Manuelt Låst AS",
        hjemmeside: "https://manual-farm.example.no",
        content_source: "manual", field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-claim-locked", navn: "Krevd Gård AS",
        hjemmeside: "https://claim-farm.example.no",
        content_source: "claim", field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-verified", navn: "Verifisert Gård AS",
        hjemmeside: "https://verified-farm.example.no",
        content_source: null, field_provenance: verifiedTrueProvenance,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-verified-reject", navn: "Verifisert Låst Gård AS",
        hjemmeside: "https://verified-locked-farm.example.no",
        content_source: "manual", field_provenance: verifiedTrueProvenance,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-verified-unchanged", navn: "Verifisert Uendret Gård AS",
        hjemmeside: "https://verified-unchanged-farm.example.no",
        content_source: null, field_provenance: verifiedTrueProvenance,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-verified-dryrun", navn: "Verifisert Dry-run Gård AS",
        hjemmeside: "https://verified-dryrun-farm.example.no",
        content_source: null, field_provenance: verifiedTrueProvenance,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-unchanged", navn: "Uendret Gård AS",
        hjemmeside: "https://same-farm.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-clear", navn: "Ryddes Gård AS",
        hjemmeside: "https://clear-me.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-aggregator", navn: "Aggregator-mål Gård AS",
        hjemmeside: "https://own-site.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-platform", navn: "Platform-mål Gård AS",
        hjemmeside: "https://own-site-2.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-platform-userinfo", navn: "Platform Userinfo Gård AS",
        hjemmeside: "https://own-site-3.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-empty-string", navn: "Tom Streng Gård AS",
        hjemmeside: "https://before-empty.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-audit", navn: "Revisjonsspor Gård AS",
        hjemmeside: "https://before-audit.example.no",
        content_source: null, field_provenance: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function getRow(id: string): { hjemmeside: string | null; content_source: string | null; field_provenance: string | null } | undefined {
        return expDb
          .prepare("SELECT hjemmeside, content_source, field_provenance FROM experience_providers WHERE id = ?")
          .get(id) as any;
      }

      function auditRowsFor(providerId: string): any[] {
        return expDb
          .prepare("SELECT * FROM experience_provider_field_write_audit WHERE provider_id = ? ORDER BY written_at")
          .all(providerId) as any[];
      }

      const ROUTE_PATH = "/admin/providers/hjemmeside-write";
      function post(body: any) {
        return callRoute(opplevelserRouter, {
          method: "POST",
          path: ROUTE_PATH,
          headers: { "x-admin-key": testKey },
          body,
        });
      }

      // ── (a) dry-run (default) vs apply ───────────────────────────────────
      const dryRunDefault = await post({
        items: [{ provider_id: "prov-open", hjemmeside: "https://new-open-farm.example.no" }],
      });
      assertEq(dryRunDefault.status, 200, "a1: dry-run (no apply field) -> 200");
      assertEq(dryRunDefault.body.dry_run, true, "a2: dry_run:true by default");
      assertEq(dryRunDefault.body.results[0].status, "would_write", "a3: dry-run reports would_write");
      assertEq(getRow("prov-open")?.hjemmeside, "https://open-farm.example.no", "a4: dry-run performs NO database write");
      assertEq(auditRowsFor("prov-open").length, 0, "a5: dry-run inserts NO audit row");

      const applyExplicitFalse = await post({
        apply: false,
        items: [{ provider_id: "prov-open", hjemmeside: "https://new-open-farm.example.no" }],
      });
      assertEq(applyExplicitFalse.body.dry_run, true, "a6: apply:false is still a dry-run");

      const applied = await post({
        apply: true,
        items: [{ provider_id: "prov-open", hjemmeside: "https://new-open-farm.example.no" }],
      });
      assertEq(applied.status, 200, "a7: apply:true -> 200");
      assertEq(applied.body.dry_run, false, "a8: dry_run:false when apply:true");
      assertEq(applied.body.results[0].status, "written", "a9: apply:true actually writes -> status written");
      assertEq(applied.body.results[0].previous_hjemmeside, "https://open-farm.example.no", "a10: response reports previous value");
      assertEq(applied.body.results[0].new_hjemmeside, "https://new-open-farm.example.no", "a11: response reports new value");
      assertEq(getRow("prov-open")?.hjemmeside, "https://new-open-farm.example.no", "a12: DB row actually updated on apply");

      // ── (b) lock rejection + override ────────────────────────────────────
      const manualLockedNoOverride = await post({
        apply: true,
        items: [{ provider_id: "prov-manual-locked", hjemmeside: "https://override-attempt.example.no" }],
      });
      assertEq(manualLockedNoOverride.body.results[0].status, "rejected_locked", "b1: content_source='manual' rejected without override");
      assertEq(getRow("prov-manual-locked")?.hjemmeside, "https://manual-farm.example.no", "b2: locked row untouched without override");

      const claimLockedNoOverride = await post({
        apply: true,
        items: [{ provider_id: "prov-claim-locked", hjemmeside: "https://override-attempt.example.no" }],
      });
      assertEq(claimLockedNoOverride.body.results[0].status, "rejected_locked", "b3: content_source='claim' rejected without override");
      assertEq(getRow("prov-claim-locked")?.hjemmeside, "https://claim-farm.example.no", "b4: claim-locked row untouched without override");

      const manualLockedTopLevelOverride = await post({
        apply: true,
        allow_locked_override: true,
        items: [{ provider_id: "prov-manual-locked", hjemmeside: "https://override-success.example.no" }],
      });
      assertEq(manualLockedTopLevelOverride.body.results[0].status, "written", "b5: top-level allow_locked_override:true unlocks the write");
      assertEq(getRow("prov-manual-locked")?.hjemmeside, "https://override-success.example.no", "b6: DB row updated with top-level override");

      const claimLockedRowOverride = await post({
        apply: true,
        items: [{ provider_id: "prov-claim-locked", hjemmeside: "https://row-override-success.example.no", allow_locked_override: true }],
      });
      assertEq(claimLockedRowOverride.body.results[0].status, "written", "b7: per-row allow_locked_override:true unlocks the write");
      assertEq(getRow("prov-claim-locked")?.hjemmeside, "https://row-override-success.example.no", "b8: DB row updated with per-row override");

      // ── (c) directory/aggregator host rejection ──────────────────────────
      const aggregatorDryRun = await post({
        items: [{ provider_id: "prov-aggregator", hjemmeside: "https://www.tripadvisor.com/Attraction-farm" }],
      });
      assertEq(aggregatorDryRun.body.results[0].status, "rejected_directory_host", "c1: known aggregator host (tripadvisor.com) -> rejected_directory_host");

      const aggregatorApply = await post({
        apply: true,
        items: [{ provider_id: "prov-aggregator", hjemmeside: "https://facebook.com/farmpage" }],
      });
      assertEq(aggregatorApply.body.results[0].status, "rejected_directory_host", "c2: known aggregator host (facebook.com) rejected on apply too");
      assertEq(getRow("prov-aggregator")?.hjemmeside, "https://own-site.example.no", "c3: row untouched by aggregator-host rejection");

      // ── (d) platform-host rejection (incl. userinfo trick) ──────────────
      const platformHost = await post({
        apply: true,
        items: [{ provider_id: "prov-platform", hjemmeside: "https://rettfrabonden.com/some-page" }],
      });
      assertEq(platformHost.body.results[0].status, "rejected_platform_host", "d1: rettfrabonden.com host -> rejected_platform_host");
      assertEq(getRow("prov-platform")?.hjemmeside, "https://own-site-2.example.no", "d2: row untouched by platform-host rejection");

      const platformSubdomain = await post({
        apply: true,
        items: [{ provider_id: "prov-platform", hjemmeside: "https://admin.rettfrabonden.com/x" }],
      });
      assertEq(platformSubdomain.body.results[0].status, "rejected_platform_host", "d3: *.rettfrabonden.com subdomain also rejected");

      const platformFlyDev = await post({
        apply: true,
        items: [{ provider_id: "prov-platform", hjemmeside: "https://opplevagent.fly.dev/x" }],
      });
      assertEq(platformFlyDev.body.results[0].status, "rejected_platform_host", "d4: *.fly.dev host also rejected");

      // Userinfo-trick: naive URL parsing that reads everything before the
      // first '/' as the "host" would see "evil.com@rettfrabonden.com" and
      // miss the platform match. hostFromUrlLike strips userinfo before the
      // last '@', so the REAL host resolved is rettfrabonden.com and this
      // must still be rejected — this is the exact bypass class the route's
      // header comment calls out.
      const userinfoTrick = await post({
        apply: true,
        items: [{ provider_id: "prov-platform-userinfo", hjemmeside: "https://evil.com@rettfrabonden.com/" }],
      });
      assertEq(userinfoTrick.body.results[0].status, "rejected_platform_host", "d5: userinfo-trick URL (evil.com@rettfrabonden.com) still resolves host as rettfrabonden.com -> rejected");
      assertEq(getRow("prov-platform-userinfo")?.hjemmeside, "https://own-site-3.example.no", "d6: row untouched by the userinfo-trick attempt");

      // ── (e) clearing via null ─────────────────────────────────────────────
      const clearNull = await post({
        apply: true,
        items: [{ provider_id: "prov-clear", hjemmeside: null }],
      });
      assertEq(clearNull.body.results[0].status, "written", "e1: hjemmeside:null on a non-null row -> written");
      assertEq(clearNull.body.results[0].new_hjemmeside, null, "e2: response reports new_hjemmeside:null");
      assertEq(getRow("prov-clear")?.hjemmeside, null, "e3: DB row's hjemmeside is actually NULL after clearing");

      // ── (f) empty-string rejection ────────────────────────────────────────
      const emptyString = await post({
        apply: true,
        items: [{ provider_id: "prov-empty-string", hjemmeside: "" }],
      });
      assertEq(emptyString.body.results[0].status, "rejected_invalid_item", "f1: empty string -> rejected_invalid_item (never treated as clear)");
      assertTrue(
        typeof emptyString.body.results[0].detail === "string" && emptyString.body.results[0].detail.includes("null"),
        "f2: rejection detail explains to send hjemmeside: null instead",
      );
      assertEq(getRow("prov-empty-string")?.hjemmeside, "https://before-empty.example.no", "f3: row untouched by empty-string rejection");

      // ── (g) skip-if-unchanged ─────────────────────────────────────────────
      const unchangedApply = await post({
        apply: true,
        items: [{ provider_id: "prov-unchanged", hjemmeside: "https://same-farm.example.no" }],
      });
      assertEq(unchangedApply.body.results[0].status, "skipped_unchanged", "g1: identical value -> skipped_unchanged");
      assertEq(auditRowsFor("prov-unchanged").length, 0, "g2: no audit row written for a skipped-unchanged write");
      assertEq(getRow("prov-unchanged")?.hjemmeside, "https://same-farm.example.no", "g3: row value unchanged (sanity)");

      // ── (h) batch cap ──────────────────────────────────────────────────────
      const overCapItems = Array.from({ length: 201 }, (_, i) => ({ provider_id: `nope-${i}`, hjemmeside: null }));
      const overCap = await post({ items: overCapItems });
      assertEq(overCap.status, 400, "h1: batch over 200 items -> 400");
      assertTrue(typeof overCap.body?.error === "string" && overCap.body.error.length > 0, "h2: 400 body carries a clear error message");

      const atCapItems = Array.from({ length: 200 }, (_, i) => ({ provider_id: `nope-${i}`, hjemmeside: null }));
      const atCap = await post({ items: atCapItems });
      assertEq(atCap.status, 200, "h3: batch of exactly 200 items is accepted");
      assertEq(atCap.body.results.length, 200, "h4: all 200 items produce a result");

      // ── (i) audit row content ────────────────────────────────────────────
      const auditWrite = await post({
        apply: true,
        items: [{ provider_id: "prov-audit", hjemmeside: "https://after-audit.example.no" }],
      });
      assertEq(auditWrite.body.results[0].status, "written", "i1: audit-target write succeeds");
      const auditRows = auditRowsFor("prov-audit");
      assertEq(auditRows.length, 1, "i2: exactly one audit row inserted per successful write");
      assertEq(auditRows[0].field_name, "hjemmeside", "i3: audit row field_name is 'hjemmeside'");
      assertEq(auditRows[0].old_value, "https://before-audit.example.no", "i4: audit row old_value is the pre-write value");
      assertEq(auditRows[0].new_value, "https://after-audit.example.no", "i5: audit row new_value is the written value");
      assertTrue(typeof auditRows[0].batch_id === "string" && auditRows[0].batch_id.length > 0, "i6: audit row carries a batch_id");
      assertTrue(typeof auditRows[0].id === "string" && auditRows[0].id.length > 0, "i7: audit row has its own id");

      // ── (j) field_provenance.hjemmeside_verification invalidation ───────

      // j-reject: locked + verified:true -> write rejected -> provenance untouched
      const verifiedRejectAttempt = await post({
        apply: true,
        items: [{ provider_id: "prov-verified-reject", hjemmeside: "https://new-verified-locked.example.no" }],
      });
      assertEq(verifiedRejectAttempt.body.results[0].status, "rejected_locked", "j1: verified+locked row still rejected without override (sanity)");
      {
        const row = getRow("prov-verified-reject");
        const prov = JSON.parse(row!.field_provenance!);
        assertEq(prov.hjemmeside_verification.verified, true, "j2: rejected write leaves prior verified:true stamp untouched");
      }

      // j-unchanged: verified:true + write to the SAME value -> skipped -> provenance untouched
      const verifiedUnchangedAttempt = await post({
        apply: true,
        items: [{ provider_id: "prov-verified-unchanged", hjemmeside: "https://verified-unchanged-farm.example.no" }],
      });
      assertEq(verifiedUnchangedAttempt.body.results[0].status, "skipped_unchanged", "j3: same-value write is skipped-unchanged (sanity)");
      {
        const row = getRow("prov-verified-unchanged");
        const prov = JSON.parse(row!.field_provenance!);
        assertEq(prov.hjemmeside_verification.verified, true, "j4: skipped-unchanged write leaves prior verified:true stamp untouched");
      }

      // j-dryrun: verified:true + dry-run (no apply) -> provenance untouched
      const verifiedDryRunAttempt = await post({
        items: [{ provider_id: "prov-verified-dryrun", hjemmeside: "https://new-verified-dryrun.example.no" }],
      });
      assertEq(verifiedDryRunAttempt.body.results[0].status, "would_write", "j5: dry-run reports would_write (sanity)");
      {
        const row = getRow("prov-verified-dryrun");
        const prov = JSON.parse(row!.field_provenance!);
        assertEq(prov.hjemmeside_verification.verified, true, "j6: dry-run leaves prior verified:true stamp untouched");
        assertEq(row!.hjemmeside, "https://verified-dryrun-farm.example.no", "j7: dry-run performs no DB write (sanity)");
      }

      // j-real-change: verified:true + a REAL apply write to a NEW value -> flips to verified:false
      const verifiedRealChange = await post({
        apply: true,
        items: [{ provider_id: "prov-verified", hjemmeside: "https://new-verified-farm.example.no" }],
      });
      assertEq(verifiedRealChange.body.results[0].status, "written", "j8: real-change write on a previously-verified row succeeds");
      {
        const row = getRow("prov-verified");
        assertEq(row!.hjemmeside, "https://new-verified-farm.example.no", "j9: hjemmeside actually updated");
        const prov = JSON.parse(row!.field_provenance!);
        assertEq(prov.hjemmeside_verification.verified, false, "j10: prior verified:true stamp flipped to verified:false after a real URL change");
        assertEq(prov.hjemmeside_verification.classification, "unverified", "j11: classification flipped to 'unverified'");
        assertEq(
          prov.hjemmeside_verification.reason,
          "hjemmeside_write_invalidated_prior_verification",
          "j12: reason explains why verification was invalidated",
        );
        assertTrue(typeof prov.hjemmeside_verification.checked_at === "string", "j13: checked_at stamp refreshed");
      }

      // j-no-prior: a row with NO prior verification entry stays that way
      // (never invents one) after a normal write.
      const noProvenanceWrite = await post({
        apply: true,
        items: [{ provider_id: "prov-open", hjemmeside: "https://third-open-farm.example.no" }],
      });
      assertEq(noProvenanceWrite.body.results[0].status, "written", "j14: write on a row with no field_provenance succeeds");
      {
        const row = getRow("prov-open");
        assertTrue(
          row!.field_provenance === null || JSON.parse(row!.field_provenance!).hjemmeside_verification === undefined,
          "j15: a row with no prior verification entry never gets one invented on write",
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-hjemmeside-write: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-hjemmeside-write.test.ts`
if (require.main === module) {
  runOpplevelserHjemmesideWriteTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

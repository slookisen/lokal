/**
 * opplevelser-gardssalg-experience-conflict.test.ts — route-level tests for
 * dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
 * Steg 2:
 *
 *   - GET  /admin/gardssalg-experience-conflict-audit        (Part A, dry-run)
 *   - POST /admin/gardssalg-experience-conflict-remediation  (Part B, write)
 *   - POST /admin/gardssalg-content-rollback with entity_type: "experience"
 *     (rollback lever for Part B's writes, wired into the EXISTING endpoint)
 *
 * The pure matching-logic tests (findGardssalgProducerExperienceMatches,
 * incl. the Atlungstad case) live in
 * services/gardssalg-experience-conflict.test.ts — this file exercises the
 * same Atlungstad-shaped fixture end-to-end through the real HTTP routes and
 * a real (in-memory) DB, PLUS the write/audit/rollback machinery those pure
 * tests don't touch.
 *
 * Mirrors opplevelser-gardssalg-content-audit.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercising
 * router.handle() directly with X-Admin-Key via headers).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on all three endpoints
 *   (b) GET .../gardssalg-experience-conflict-audit: the Atlungstad-shaped
 *       fixture is reported as a matched, CONFLICTING pair; an agreeing pair
 *       and an unrelated pair are correctly classified; summary counts match
 *   (c) POST .../gardssalg-experience-conflict-remediation dry-run (apply
 *       omitted): reports the correction that WOULD be made, performs ZERO
 *       writes (experiences.booking_url unchanged in the DB)
 *   (d) POST .../gardssalg-experience-conflict-remediation apply=true:
 *       corrects the conflicting experience's booking_url to the producer's
 *       hjemmeside, stamps content_field_evidence.booking_url, inserts an
 *       experience_provider_conflict_audit row — and leaves the AGREEING
 *       pair's experience completely untouched (byte-identical booking_url)
 *   (e) a producer whose OWN hjemmeside is a directory/aggregator host
 *       (hanen.no) -> remediation NULLS the conflicting booking_url instead
 *       of copying an aggregator link into it
 *   (f) a manual/claim-sourced (locked) experience is never written by apply,
 *       reported in `skipped` with reason "locked"
 *   (g) POST .../gardssalg-content-rollback { entity_type: "experience" }
 *       dry-run reports the restore target without writing; apply=true
 *       restores the PRE-remediation booking_url and inserts a NEW audit row
 *       (the rollback itself is audited)
 *   (h) the default/omitted entity_type on POST .../gardssalg-content-
 *       rollback is completely unaffected (still targets experience_providers
 *       via provider_id, exactly as before this slice) — regression guard
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
    const method = opts.method || "GET";
    const url = opts.url || "/admin/gardssalg-experience-conflict-audit";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
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

export function runOpplevelserGardssalgExperienceConflictTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-experience-conflict-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const conflictServicePath = require.resolve("../services/gardssalg-experience-conflict");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, conflictServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, catalog_hidden, producer_type, rfb_seed_source,
            content_source, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @catalog_hidden, @producer_type, @rfb_seed_source,
            @content_source, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, title_no, booking_url, content_source, verification_status,
            provider_match_status, confidence)
         VALUES
           (@id, @provider_id, @title, @title_no, @booking_url, @content_source, @verification_status,
            'unmatched', 'high')`,
      );

      // ── The Atlungstad-shaped fixture (dev-request Funn 2, the concrete
      //    confirmed case) — real ids from the dev-request, a realistic title
      //    that shares no token with the producer name (host_name signal only,
      //    same shape proven in the pure-logic test file). ────────────────────
      insertProvider.run({
        id: "atlungstad-brenneri--bbe4185d", navn: "Atlungstad Brenneri",
        hjemmeside: "https://atlungstadbrenneri.no", catalog_hidden: 0,
        producer_type: "destilleri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "norway-s-oldest-distillery-tours-tastings--68220487", provider_id: null,
        title: "Norway's Oldest Distillery: Tours & Tastings", title_no: null,
        booking_url: "https://atlungstad.no", content_source: null, verification_status: "pending_verify",
      });

      // ── An agreeing pair — must be reported as "agree" and NEVER written by
      //    remediation. ─────────────────────────────────────────────────────
      insertProvider.run({
        id: "prod-ciderhuset", navn: "Ciderhuset Balestrand",
        hjemmeside: "https://ciderhusetbalestrand.no", catalog_hidden: 0,
        producer_type: "cideri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-ciderhuset", provider_id: null,
        title: "Ciderhuset Balestrand — smaking og omvisning", title_no: null,
        booking_url: "https://www.ciderhusetbalestrand.no/besok", content_source: null,
        verification_status: "pending_verify",
      });

      // ── A conflicting pair whose producer's OWN hjemmeside is a curated
      //    directory/aggregator host (hanen.no) — remediation must NULL the
      //    conflicting booking_url rather than copy an aggregator link into
      //    it. ───────────────────────────────────────────────────────────────
      insertProvider.run({
        id: "prod-aggregator-home", navn: "Aggregatorgaarden",
        hjemmeside: "https://hanen.no/gardsutsalg/aggregatorgaarden", catalog_hidden: 0,
        producer_type: "bryggeri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-aggregator-home", provider_id: null,
        title: "Aggregatorgaarden — bryggeribesøk", title_no: null,
        booking_url: "https://wrong-host.example/aggregatorgaarden", content_source: null,
        verification_status: "pending_verify",
      });

      // ── A conflicting pair on a MANUAL (locked) experience row — remediation
      //    must skip it (reason "locked"), never overwrite curator-authored
      //    content. ──────────────────────────────────────────────────────────
      insertProvider.run({
        id: "prod-locked", navn: "Fossmoen Frukt",
        hjemmeside: "https://fossmoenfrukt.no", catalog_hidden: 0,
        producer_type: "cideri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-locked", provider_id: null,
        title: "Fossmoen Frukt — gårdsbesøk og smaking", title_no: null,
        booking_url: "https://wrong-host.example/fossmoen", content_source: "manual",
        verification_status: "pending_verify",
      });

      // ── An ambiguous collision — TWO producers independently name_token-
      //    match the SAME experience_id via the shared rare token "nordkapp"
      //    (used by neither producer_type vocabulary nor the generic
      //    stoplist, and shared by only these 2 of the fixture's producers —
      //    well under SHARED_TOKEN_GENERIC_MIN). Both producers' hjemmeside
      //    domains differ from the experience's booking_url domain, so both
      //    would independently classify "conflict" before the same-
      //    experience/multiple-producer reclassification demotes them both
      //    to "ambiguous" — this is the ambiguous_detail grouping fixture. ──
      insertProvider.run({
        id: "prod-ambig-a", navn: "Nordkapp Bryggeri",
        hjemmeside: "https://nordkappbryggeri.no", catalog_hidden: 0,
        producer_type: "bryggeri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertProvider.run({
        id: "prod-ambig-b", navn: "Nordkapp Sjokolade",
        hjemmeside: "https://nordkappsjokolade.no", catalog_hidden: 0,
        producer_type: "gårdsbutikk", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-ambig", provider_id: null,
        title: "Nordkapp Fyr — Omvisning og kaffestue", title_no: null,
        booking_url: "https://booking-portal.example/aktivitet/12345", content_source: null,
        verification_status: "pending_verify",
      });

      // ── A genuinely unrelated producer/experience — must never appear in
      //    any pair list at all. ───────────────────────────────────────────
      insertProvider.run({
        id: "prod-unrelated", navn: "Hebnes Vingård",
        hjemmeside: "https://hebnesvingard.no", catalog_hidden: 0,
        producer_type: "vingård", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-unrelated", provider_id: null,
        title: "Fjelltur til Galdhøpiggen med guide", title_no: null,
        booking_url: "https://turoperator.example/galdhopiggen", content_source: null,
        verification_status: "pending_verify",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function getExperienceRow(id: string): any {
        return expDb
          .prepare(`SELECT id, booking_url, content_field_evidence, content_source FROM experiences WHERE id = ?`)
          .get(id);
      }
      function getConflictAuditRows(experienceId: string): any[] {
        return expDb
          .prepare(`SELECT * FROM experience_provider_conflict_audit WHERE experience_id = ? ORDER BY rowid ASC`)
          .all(experienceId);
      }

      // ── (a) 403 without X-Admin-Key, all three endpoints ────────────────
      const noKeyGet = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-experience-conflict-audit" });
      assertEq(noKeyGet.status, 403, "a1: GET .../gardssalg-experience-conflict-audit without X-Admin-Key -> 403");
      const noKeyPost = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-remediation",
      });
      assertEq(noKeyPost.status, 403, "a2: POST .../gardssalg-experience-conflict-remediation without X-Admin-Key -> 403");
      const noKeyRollback = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        body: { entity_type: "experience", experience_id: "norway-s-oldest-distillery-tours-tastings--68220487" },
      });
      assertEq(noKeyRollback.status, 403, "a3: POST .../gardssalg-content-rollback without X-Admin-Key -> 403");

      // ── (b) GET .../gardssalg-experience-conflict-audit ─────────────────
      const auditRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-audit",
        headers: { "x-admin-key": testKey },
      });
      assertEq(auditRes.status, 200, "b1: audit GET -> 200");
      const pairs: any[] = auditRes.body.pairs;
      assertTrue(Array.isArray(pairs), "b2: response carries a pairs array");

      const atlungstadPair = pairs.find(
        (p) =>
          p.producer_id === "atlungstad-brenneri--bbe4185d" &&
          p.experience_id === "norway-s-oldest-distillery-tours-tastings--68220487",
      );
      assertTrue(!!atlungstadPair, "b3: the Atlungstad pair IS in the dry-run report (acceptance criterion 3)");
      assertEq(atlungstadPair?.status, "conflict", "b4: Atlungstad pair status is 'conflict'");
      assertEq(atlungstadPair?.match_basis, "host_name", "b5: Atlungstad pair matched via host_name");
      assertEq(atlungstadPair?.producer_hjemmeside, "https://atlungstadbrenneri.no", "b6: producer hjemmeside in the report");
      assertEq(atlungstadPair?.experience_booking_url, "https://atlungstad.no", "b7: experience booking_url in the report");

      const ciderhusetPair = pairs.find((p) => p.producer_id === "prod-ciderhuset");
      assertTrue(!!ciderhusetPair, "b8: Ciderhuset pair present");
      assertEq(ciderhusetPair?.status, "agree", "b9: Ciderhuset pair status is 'agree'");

      const unrelatedPresent = pairs.some(
        (p) => p.producer_id === "prod-unrelated" || p.experience_id === "exp-unrelated",
      );
      assertTrue(!unrelatedPresent, "b10: the genuinely unrelated producer/experience never appears in any pair");

      assertTrue(auditRes.body.summary.matched_pairs >= 4, "b11: summary.matched_pairs counts at least the 4 real fixture pairs");
      assertTrue(auditRes.body.summary.conflicting >= 3, "b12: summary.conflicting counts Atlungstad + aggregator-home + locked pairs");
      assertTrue(auditRes.body.summary.agreeing >= 1, "b13: summary.agreeing counts the Ciderhuset pair");

      // ── (b14-b18) ambiguous_detail: grouped, additive escalation section ──
      const ambiguousPairsInResponse = pairs.filter((p) => p.experience_id === "exp-ambig");
      assertEq(ambiguousPairsInResponse.length, 2, "b14: both Nordkapp producers appear as flat 'exp-ambig' pairs");
      assertTrue(
        ambiguousPairsInResponse.every((p) => p.status === "ambiguous"),
        "b15: both flat 'exp-ambig' pairs are classified 'ambiguous' (same-experience/multiple-producer collision)",
      );

      assertTrue(Array.isArray(auditRes.body.ambiguous_detail), "b16: response carries an 'ambiguous_detail' array");
      const nordkappDetail = auditRes.body.ambiguous_detail.find((d: any) => d.experience_id === "exp-ambig");
      assertTrue(!!nordkappDetail, "b17: ambiguous_detail includes a grouped entry for exp-ambig");
      assertEq(nordkappDetail?.experience_title, "Nordkapp Fyr — Omvisning og kaffestue", "b17b: grouped entry carries the experience_title");
      const collidingIds = (nordkappDetail?.colliding_producers ?? []).map((p: any) => p.producer_id).sort();
      assertEq(collidingIds, ["prod-ambig-a", "prod-ambig-b"], "b18: grouped entry lists BOTH colliding producers (not duplicated, not just one)");
      const collidingNames = (nordkappDetail?.colliding_producers ?? []).map((p: any) => p.producer_name).sort();
      assertEq(collidingNames, ["Nordkapp Bryggeri", "Nordkapp Sjokolade"], "b18b: grouped entry carries each colliding producer's name");
      assertTrue(
        typeof nordkappDetail?.reason === "string" && nordkappDetail.reason.includes("2 producers"),
        "b19: reason names the collision count",
      );

      // Atlungstad (a genuine "conflict", not ambiguous in this fixture —
      // only one producer matches it) must NOT appear in ambiguous_detail.
      assertTrue(
        !auditRes.body.ambiguous_detail.some((d: any) => d.experience_id === "norway-s-oldest-distillery-tours-tastings--68220487"),
        "b20: the genuinely single-producer Atlungstad conflict is absent from ambiguous_detail",
      );

      // The ambiguous fixture must never appear in remediation's plan (it's
      // never a "conflict" pair) — regression guard shared with (c)/(d) below.
      const nordkappStillUnwritten = getExperienceRow("exp-ambig");
      assertEq(
        nordkappStillUnwritten.booking_url,
        "https://booking-portal.example/aktivitet/12345",
        "b21: ambiguous pair's booking_url untouched by the scan itself (read-only)",
      );

      // ── (c) POST .../gardssalg-experience-conflict-remediation — dry-run
      //     (apply omitted) performs ZERO writes ──────────────────────────
      const beforeDryRun = getExperienceRow("norway-s-oldest-distillery-tours-tastings--68220487");
      assertEq(beforeDryRun.booking_url, "https://atlungstad.no", "c1: pre-check — Atlungstad experience still has the wrong booking_url");

      const dryRunRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-remediation",
        headers: { "x-admin-key": testKey },
        body: {},
      });
      assertEq(dryRunRes.status, 200, "c2: remediation dry-run -> 200");
      assertEq(dryRunRes.body.dry_run, true, "c3: dry_run defaults true");

      // Response-form hardening (dev-request 2026-08-01-gardssalg-steg2-
      // apply-tar-ikke-varig-effekt): dry-run reports its plan under
      // `planned`, and `applied` MUST be empty — a caller reading
      // `.applied.length` on a dry-run response must see 0, never the plan
      // size, so a dry-run can never be misread as a completed write.
      assertTrue(Array.isArray(dryRunRes.body.planned), "c3b: dry-run response carries a 'planned' array");
      assertEq(dryRunRes.body.applied, [], "c3c: dry-run response's 'applied' array is EMPTY (not the plan)");

      const dryRunAtlungstad = dryRunRes.body.planned.find(
        (a: any) => a.experience_id === "norway-s-oldest-distillery-tours-tastings--68220487",
      );
      assertTrue(!!dryRunAtlungstad, "c4: dry-run 'planned' list includes the Atlungstad correction that WOULD be made");
      assertEq(dryRunAtlungstad?.would_write, "https://atlungstadbrenneri.no", "c5: dry-run reports the correct target hjemmeside");
      assertEq(dryRunAtlungstad?.action, "corrected", "c6: dry-run action is 'corrected' (producer hjemmeside is a safe, non-aggregator host)");

      const afterDryRun = getExperienceRow("norway-s-oldest-distillery-tours-tastings--68220487");
      assertEq(afterDryRun.booking_url, "https://atlungstad.no", "c7: dry-run performed ZERO writes — booking_url completely unchanged");
      assertEq(getConflictAuditRows("norway-s-oldest-distillery-tours-tastings--68220487").length, 0, "c8: dry-run inserted zero audit rows");

      // ── (d) apply=true — the real write, PLUS the agreeing pair must be
      //     left completely untouched ──────────────────────────────────────
      const batchId = "test-batch-steg2";
      const applyRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true, batch_id: batchId },
      });
      assertEq(applyRes.status, 200, "d1: remediation apply -> 200");
      assertEq(applyRes.body.dry_run, false, "d2: dry_run is false on an apply call");
      assertEq(applyRes.body.planned, [], "d2b: apply response's 'planned' array is empty (symmetry with dry-run's field split)");
      assertTrue(Array.isArray(applyRes.body.applied) && applyRes.body.applied.length > 0, "d2c: apply response's 'applied' array carries the real writes");

      // Post-apply read-back verification (dev-request 2026-08-01-gardssalg-
      // steg2-apply-tar-ikke-varig-effekt §3): a clean apply must report a
      // read-back count from the DB, and zero mismatches.
      assertEq(applyRes.body.verified_written, applyRes.body.applied.length, "d2d: verified_written from the DB read-back matches the number of items applied");
      assertEq(applyRes.body.verification_mismatches, [], "d2e: no verification mismatches on a clean apply");

      const afterApply = getExperienceRow("norway-s-oldest-distillery-tours-tastings--68220487");
      assertTrue(
        afterApply.booking_url !== "https://atlungstad.no",
        "d3: acceptance criterion 4 — after apply, the Atlungstad experience no longer points to atlungstad.no",
      );
      assertEq(afterApply.booking_url, "https://atlungstadbrenneri.no", "d4: booking_url corrected to the producer's verified hjemmeside");
      assertEq(afterApply.content_source, null, "d5: content_source is deliberately left untouched by this write (not a homepage-fetch)");

      const evidence = JSON.parse(afterApply.content_field_evidence || "{}");
      assertEq(evidence.booking_url, "producer:atlungstad-brenneri--bbe4185d", "d6: content_field_evidence.booking_url stamped with the producer provenance marker");

      const atlungstadAudit = getConflictAuditRows("norway-s-oldest-distillery-tours-tastings--68220487");
      assertEq(atlungstadAudit.length, 1, "d7: exactly one experience_provider_conflict_audit row inserted");
      assertEq(atlungstadAudit[0].old_value, "https://atlungstad.no", "d8: audit old_value is the pre-correction booking_url");
      assertEq(atlungstadAudit[0].new_value, "https://atlungstadbrenneri.no", "d9: audit new_value is the corrected booking_url");
      assertEq(atlungstadAudit[0].batch_id, batchId, "d10: audit batch_id matches the request's batch_id");
      assertEq(atlungstadAudit[0].field_name, "booking_url", "d11: audit field_name is booking_url");

      const ciderhusetAfterApply = getExperienceRow("exp-ciderhuset");
      assertEq(
        ciderhusetAfterApply.booking_url,
        "https://www.ciderhusetbalestrand.no/besok",
        "d12: the AGREEING pair's booking_url is completely untouched by apply",
      );
      assertEq(getConflictAuditRows("exp-ciderhuset").length, 0, "d13: no audit row for the agreeing pair — apply never touches agree/unknown pairs");

      const nordkappAfterApply = getExperienceRow("exp-ambig");
      assertEq(
        nordkappAfterApply.booking_url,
        "https://booking-portal.example/aktivitet/12345",
        "d14: the AMBIGUOUS pair's booking_url is completely untouched by apply — status!=='conflict' is never in the remediation plan",
      );
      assertEq(getConflictAuditRows("exp-ambig").length, 0, "d15: no audit row for the ambiguous pair either");

      // ── (e) producer hjemmeside is itself an aggregator host -> NULL, never
      //     copy the aggregator link ────────────────────────────────────────
      const aggregatorAfterApply = getExperienceRow("exp-aggregator-home");
      assertEq(aggregatorAfterApply.booking_url, null, "e1: aggregator-hjemmeside producer -> conflicting booking_url is NULLED, not copied");
      const aggregatorAudit = getConflictAuditRows("exp-aggregator-home");
      assertEq(aggregatorAudit.length, 1, "e2: still exactly one audit row for the nulled field");
      assertEq(aggregatorAudit[0].new_value, null, "e3: audit new_value is null (matches the nulled write)");

      // ── (f) manual/claim-locked experience — never written ──────────────
      const lockedAfterApply = getExperienceRow("exp-locked");
      assertEq(lockedAfterApply.booking_url, "https://wrong-host.example/fossmoen", "f1: locked (manual) experience's booking_url is completely unchanged");
      assertEq(getConflictAuditRows("exp-locked").length, 0, "f2: no audit row for the locked experience");
      assertTrue(
        applyRes.body.skipped.some((s: any) => s.experience_id === "exp-locked" && s.reason === "locked"),
        "f3: apply response reports exp-locked skipped with reason 'locked'",
      );

      // ── (g) POST .../gardssalg-content-rollback { entity_type: "experience" } ──
      const rollbackDryRun = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { entity_type: "experience", experience_id: "norway-s-oldest-distillery-tours-tastings--68220487" },
      });
      assertEq(rollbackDryRun.status, 200, "g1: experience rollback dry-run -> 200");
      assertEq(rollbackDryRun.body.dry_run, true, "g2: dry_run defaults true");
      assertEq(rollbackDryRun.body.restored.length, 1, "g3: dry-run finds exactly one restorable field");
      assertEq(rollbackDryRun.body.restored[0].would_restore_to, "https://atlungstad.no", "g4: dry-run reports it would restore the ORIGINAL (pre-remediation) value");

      const stillCorrected = getExperienceRow("norway-s-oldest-distillery-tours-tastings--68220487");
      assertEq(stillCorrected.booking_url, "https://atlungstadbrenneri.no", "g5: rollback dry-run performed zero writes — booking_url still the corrected value");

      const rollbackApply = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { entity_type: "experience", experience_id: "norway-s-oldest-distillery-tours-tastings--68220487", apply: true },
      });
      assertEq(rollbackApply.status, 200, "g6: experience rollback apply -> 200");
      assertEq(rollbackApply.body.dry_run, false, "g7: dry_run is false");
      assertEq(rollbackApply.body.restored[0].restored_to, "https://atlungstad.no", "g8: rollback restored the pre-remediation value");

      const afterRollback = getExperienceRow("norway-s-oldest-distillery-tours-tastings--68220487");
      assertEq(afterRollback.booking_url, "https://atlungstad.no", "g9: booking_url is back to the ORIGINAL (wrong) value after rollback — the rollback lever genuinely works");

      const auditAfterRollback = getConflictAuditRows("norway-s-oldest-distillery-tours-tastings--68220487");
      assertEq(auditAfterRollback.length, 2, "g10: the rollback ITSELF is audited — a second audit row now exists");
      assertEq(auditAfterRollback[1].old_value, "https://atlungstadbrenneri.no", "g11: rollback audit row's old_value is the pre-rollback (corrected) value");
      assertEq(auditAfterRollback[1].new_value, "https://atlungstad.no", "g12: rollback audit row's new_value is the restored (original) value");
      assertEq(auditAfterRollback[1].source_url, "internal://rollback", "g13: rollback audit row is stamped with the rollback marker");

      // ── (h) default/omitted entity_type is unaffected — regression guard ──
      // Reuse this file's own provider fixtures indirectly by hitting the
      // provider-rollback path with a provider_id that has NO gardssalg_content_audit
      // history at all: must behave EXACTLY as before this slice (skipped,
      // no_audit_row), never accidentally routed through the new experience
      // branch.
      const providerRollbackRegression = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { provider_id: "atlungstad-brenneri--bbe4185d", field_name: "about_text" },
      });
      assertEq(providerRollbackRegression.status, 200, "h1: default entity_type (omitted) still targets the provider path -> 200");
      assertEq(providerRollbackRegression.body.restored, [], "h2: nothing restorable (no gardssalg_content_audit history) — unchanged behavior");
      assertTrue(
        providerRollbackRegression.body.skipped.some(
          (s: any) => s.provider_id === "atlungstad-brenneri--bbe4185d" && s.reason === "no_audit_row",
        ),
        "h3: skipped with reason no_audit_row — the pre-existing provider-rollback path is untouched by this slice",
      );
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-experience-conflict: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-experience-conflict.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgExperienceConflictTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

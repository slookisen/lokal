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
 * Also covers dev-request 2026-08-07-dublett-evidensbasis-og-pool-
 * avblokkering, slice 3's two remediation write-layer gaps (see (c-gapA)/
 * (c-gapB)/(c-gapB-nulled)/(f-gapA)/(f-gapB)/(f-gapB-nulled) below):
 *
 *   - Gap A: a name_token/host_name pair is only write-eligible with a
 *     "confirmed" gardssalg_experience_conflict_review verdict (slice 2's
 *     queue table) — no decision, or a "rejected" one, lands in `skipped`
 *     with reason "not_evidence_basis", never in `planned`/`applied`.
 *     provider_link pairs are unaffected (always eligible, as before).
 *   - Gap B ("the Lervig lesson"): even a write-eligible pair is never
 *     written when its CURRENT booking_url is already a working, specific
 *     deep link (non-trivial path/query) that differs from the producer's
 *     bare homepage — `skipped`/"existing_deep_link_preserved" instead of
 *     overwriting a useful URL with a strictly-worse generic one. Covered on
 *     BOTH sides of the corrected/nulled branch: exp-lervig (would-be
 *     "corrected" — producer's own hjemmeside is a normal site) and
 *     exp-aggregator-deeplink (would-be "nulled" — producer's own hjemmeside
 *     is itself a directory/aggregator host) — review fix-up, since
 *     isDeepLinkUrl() runs before that branch decides and nulling a deep
 *     link is just as destructive as overwriting it.
 *   - Gap B host-mismatch widening (post-deploy fix, found live 2026-08-08
 *     via a production dry-run probe of the shipped slice-3 code): the
 *     original Gap B check (isDeepLinkUrl) only looked at PATH/QUERY depth,
 *     so a bare-root current booking_url on a DIFFERENT domain than the
 *     producer's own bare-root hjemmeside — the literal live Lervig
 *     acceptance example itself (lerviglocal.no vs lervig.no, no path on
 *     either side) — was NOT protected and would have been overwritten on
 *     apply=true. exp-fjordblink-bareroot below reproduces that exact shape.
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
      // booking_url is deliberately ROOT-ONLY (no path) — this fixture's
      // purpose is isolating the aggregator-hjemmeside-nulls-instead-of-
      // copies rule (e1-e3 below) from slice 3's Gap B deep-link-preservation
      // rule (a non-trivial path would trip THAT gate instead and the pair
      // would be skipped rather than nulled — see exp-lervig below for that
      // case tested on its own).
      insertExperience.run({
        id: "exp-aggregator-home", provider_id: null,
        title: "Aggregatorgaarden — bryggeribesøk", title_no: null,
        booking_url: "https://wrong-host.example", content_source: null,
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

      // ── Slice 3 (dev-request 2026-08-07-dublett-evidensbasis-og-pool-
      //    avblokkering) fixtures — Gap A (evidence-basis write-eligibility)
      //    and Gap B (deep-link preservation). ──────────────────────────────

      // (i) provider_link basis, root-only current booking_url — regression
      //     guard: provider_link pairs are ALWAYS write-eligible (never
      //     gated by Gap A), and a root-only booking_url is NOT a deep link,
      //     so this must still get planned/applied as "corrected" exactly as
      //     before slice 3 (acceptance criterion 3).
      insertProvider.run({
        id: "prod-providerlink", navn: "Providerlink Gard",
        hjemmeside: "https://providerlinkgard.no", catalog_hidden: 0,
        producer_type: "gardsbutikk", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-providerlink", provider_id: "prod-providerlink",
        title: "En helt annen tittel uten delte token", title_no: null,
        booking_url: "https://wrong-host4.example", content_source: null,
        verification_status: "pending_verify",
      });

      // (ii) name_token basis, NO review decision recorded at all — Gap A:
      //      must be planned as `skipped` with reason "not_evidence_basis",
      //      never in `planned`, regardless of what its booking_url looks
      //      like (evidence-basis is checked before the deep-link check).
      insertProvider.run({
        id: "prod-nodecision", navn: "Kanonbryggeriet Spesial",
        hjemmeside: "https://kanonbryggeriet.no", catalog_hidden: 0,
        producer_type: "bryggeri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-nodecision", provider_id: null,
        title: "Kanonbryggeriet Ølsmaking", title_no: null,
        booking_url: "https://wrong-host5.example/smaking", content_source: null,
        verification_status: "pending_verify",
      });

      // (iii) name_token basis, REJECTED review decision — Gap A: a rejected
      //       verdict must ALSO land in `skipped`/"not_evidence_basis" (not
      //       a distinct "rejected" reason) — rejected is exactly as
      //       ineligible as "no decision yet".
      insertProvider.run({
        id: "prod-rejected", navn: "Stjerneskudd Gardsutsalg",
        hjemmeside: "https://stjerneskudd.no", catalog_hidden: 0,
        producer_type: "gardsbutikk", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-rejected", provider_id: null,
        title: "Stjerneskudd Sommeraktivitet", title_no: null,
        booking_url: "https://wrong-host6.example/aktivitet", content_source: null,
        verification_status: "pending_verify",
      });

      // (iv) name_token basis, CONFIRMED review decision, AND the current
      //      booking_url is a working, specific deep link that differs from
      //      the producer's bare homepage — "the Lervig lesson" (Gap B):
      //      must be planned as `skipped`/"existing_deep_link_preserved",
      //      NEVER silently overwritten with the generic producer homepage,
      //      even though the pair has real (human-confirmed) evidence.
      insertProvider.run({
        id: "prod-lervig", navn: "Lervig Bryggeri",
        hjemmeside: "https://lervig.no", catalog_hidden: 0,
        producer_type: "bryggeri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-lervig", provider_id: null,
        title: "Lervig Ølsmaking og bryggeribesøk", title_no: null,
        booking_url: "https://lerviglocal.no/book", content_source: null,
        verification_status: "pending_verify",
      });

      // (v) provider_link basis (always write-eligible, no review decision
      //     needed), producer's OWN hjemmeside is itself a directory/
      //     aggregator host (hanen.no — same curated host exp-aggregator-home
      //     above exercises), AND the current booking_url is a working,
      //     specific deep link. Absent Gap B this would plan as action
      //     "nulled" (aggregator hjemmeside -> newValue=null, same rule
      //     exp-aggregator-home exercises) — this fixture combines that with
      //     Gap B's deep-link current value to prove isDeepLinkUrl() is
      //     checked BEFORE the corrected/nulled branch decides, not only on
      //     the "would have been corrected" path exp-lervig above covers
      //     (review CHANGES-REQUESTED finding: nulling a deep link is just as
      //     destructive as overwriting it, and was previously unverified by
      //     any test).
      insertProvider.run({
        id: "prod-aggregator-deeplink", navn: "Dyplenkegaarden",
        hjemmeside: "https://hanen.no/gardsutsalg/dyplenkegaarden", catalog_hidden: 0,
        producer_type: "gardsbutikk", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-aggregator-deeplink", provider_id: "prod-aggregator-deeplink",
        title: "Dyplenkegaarden — gårdsbutikk med nettbestilling", title_no: null,
        booking_url: "https://wrong-host7.example/bestill-omvisning", content_source: null,
        verification_status: "pending_verify",
      });

      // (vi) — POST-DEPLOY REGRESSION FIXTURE (found live 2026-08-08 via a
      //       production dry-run probe of PR #530, the shipped slice-3 code):
      //       name_token basis, CONFIRMED review decision, producer's
      //       hjemmeside is a BARE-ROOT domain (with a "www." prefix — must
      //       be treated as the SAME host as the bare domain for this
      //       comparison), and the experience's CURRENT booking_url is ALSO
      //       a BARE-ROOT URL — empty path, no query, so isDeepLinkUrl()
      //       alone (the original slice-3 Gap B check) does NOT fire for
      //       it — but on a DIFFERENT registrable domain than the producer's
      //       homepage. This is the exact shape of the literal live Lervig
      //       acceptance example itself (lerviglocal.no vs lervig.no, no
      //       path on either side) — deliberately NOT reusing the
      //       prod-lervig/exp-lervig ids/tokens above (which already share
      //       the "lervig" token and would collide into "ambiguous" via the
      //       same-experience/multiple-producer guard if reused here), same
      //       conceptual shape with a different brand name instead. Must be
      //       planned as `skipped`/"existing_deep_link_preserved" on BOTH
      //       dry-run and apply=true, with a DB read-back confirming
      //       booking_url is unchanged and zero new audit rows — this is
      //       the regression the host-mismatch widening exists to fix.
      insertProvider.run({
        id: "prod-fjordblink-bareroot", navn: "Fjordblink Bryggeri",
        hjemmeside: "https://www.fjordblink.no", catalog_hidden: 0,
        producer_type: "bryggeri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertExperience.run({
        id: "exp-fjordblink-bareroot", provider_id: null,
        title: "Fjordblink Ølsmaking direkte fra bryggeriet", title_no: null,
        booking_url: "https://fjordblinklokal.no", content_source: null,
        verification_status: "pending_verify",
      });

      const conflictService = require("../services/gardssalg-experience-conflict") as
        typeof import("../services/gardssalg-experience-conflict");

      // Confirmed decisions for the three PRE-EXISTING name_token/host_name
      // fixtures above ((b)-(h)): under slice 3's Gap A, a candidate pair is
      // no longer write-eligible without one, so — since those fixtures'
      // whole point is exercising the corrected/nulled/locked remediation
      // paths, not Gap A itself — they need a "confirmed" verdict recorded to
      // keep exercising exactly what they did before this slice.
      conflictService.recordGardssalgExperienceConflictReviewDecision(expDb, {
        producer_id: "atlungstad-brenneri--bbe4185d",
        experience_id: "norway-s-oldest-distillery-tours-tastings--68220487",
        verdict: "confirmed",
        decided_by: "test-seed",
      });
      conflictService.recordGardssalgExperienceConflictReviewDecision(expDb, {
        producer_id: "prod-aggregator-home",
        experience_id: "exp-aggregator-home",
        verdict: "confirmed",
        decided_by: "test-seed",
      });
      conflictService.recordGardssalgExperienceConflictReviewDecision(expDb, {
        producer_id: "prod-locked",
        experience_id: "exp-locked",
        verdict: "confirmed",
        decided_by: "test-seed",
      });
      // (iii)'s rejected decision.
      conflictService.recordGardssalgExperienceConflictReviewDecision(expDb, {
        producer_id: "prod-rejected",
        experience_id: "exp-rejected",
        verdict: "rejected",
        decided_by: "test-seed",
      });
      // (iv)'s confirmed decision — evidence-basis alone is NOT enough to
      // overwrite the deep link; Gap B must still catch it.
      conflictService.recordGardssalgExperienceConflictReviewDecision(expDb, {
        producer_id: "prod-lervig",
        experience_id: "exp-lervig",
        verdict: "confirmed",
        decided_by: "test-seed",
      });
      // (vi)'s confirmed decision — post-deploy regression fixture (bare-root
      // domains on both sides, different hosts): evidence-basis alone must
      // still not be enough to overwrite it — the host-mismatch widening of
      // Gap B is what has to catch this one.
      conflictService.recordGardssalgExperienceConflictReviewDecision(expDb, {
        producer_id: "prod-fjordblink-bareroot",
        experience_id: "exp-fjordblink-bareroot",
        verdict: "confirmed",
        decided_by: "test-seed",
      });
      // (ii) — prod-nodecision/exp-nodecision deliberately gets NO decision
      // recorded at all.

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

      // ── (c-gapA/c-gapB) slice 3 — Gap A (evidence-basis write-eligibility)
      //     and Gap B (deep-link preservation), dry-run ────────────────────
      const dryRunProviderlink = dryRunRes.body.planned.find((a: any) => a.experience_id === "exp-providerlink");
      assertTrue(!!dryRunProviderlink, "c9: provider_link pair with root-only booking_url IS planned (acceptance criterion 3 — no regression)");
      assertEq(dryRunProviderlink?.would_write, "https://providerlinkgard.no", "c10: provider_link pair's plan targets the producer hjemmeside");
      assertEq(dryRunProviderlink?.action, "corrected", "c11: provider_link pair's action is 'corrected'");

      const dryRunNoDecisionPlanned = dryRunRes.body.planned.some((a: any) => a.experience_id === "exp-nodecision");
      assertTrue(!dryRunNoDecisionPlanned, "c12: name_token pair with NO review decision NEVER appears in 'planned' (Gap A)");
      const skippedNoDecision = dryRunRes.body.skipped.find((s: any) => s.experience_id === "exp-nodecision");
      assertTrue(!!skippedNoDecision, "c13: name_token pair with no decision IS in 'skipped' (never silently dropped)");
      assertEq(skippedNoDecision?.reason, "not_evidence_basis", "c14: reason is 'not_evidence_basis'");

      const dryRunRejectedPlanned = dryRunRes.body.planned.some((a: any) => a.experience_id === "exp-rejected");
      assertTrue(!dryRunRejectedPlanned, "c15: name_token pair with a REJECTED decision NEVER appears in 'planned' (Gap A)");
      const skippedRejected = dryRunRes.body.skipped.find((s: any) => s.experience_id === "exp-rejected");
      assertTrue(!!skippedRejected, "c16: rejected-decision pair IS in 'skipped'");
      assertEq(skippedRejected?.reason, "not_evidence_basis", "c17: a REJECTED decision gets the SAME reason as no decision — 'not_evidence_basis', not a distinct 'rejected' reason");

      const dryRunLervigPlanned = dryRunRes.body.planned.some((a: any) => a.experience_id === "exp-lervig");
      assertTrue(!dryRunLervigPlanned, "c18: Lervig-shaped pair (confirmed, existing deep link) NEVER appears in 'planned' — Gap B (acceptance criterion 2)");
      const skippedLervig = dryRunRes.body.skipped.find((s: any) => s.experience_id === "exp-lervig");
      assertTrue(!!skippedLervig, "c19: Lervig-shaped pair IS in 'skipped'");
      assertEq(skippedLervig?.reason, "existing_deep_link_preserved", "c20: reason is 'existing_deep_link_preserved' — evidence-basis alone does not license overwriting a working deep link");

      // ── (c-gapB-bareroot) POST-DEPLOY REGRESSION — the literal live shape
      //     that broke: both the producer's hjemmeside and the experience's
      //     CURRENT booking_url are bare-root URLs (no path, no query), so
      //     the original path/query-depth check (isDeepLinkUrl) does NOT fire
      //     for either side — only the host-mismatch widening catches this.
      const dryRunFjordblinkPlanned = dryRunRes.body.planned.some((a: any) => a.experience_id === "exp-fjordblink-bareroot");
      assertTrue(!dryRunFjordblinkPlanned, "c24: bare-root-on-both-sides, cross-domain pair (confirmed) NEVER appears in 'planned' — Gap B host-mismatch widening");
      const skippedFjordblink = dryRunRes.body.skipped.find((s: any) => s.experience_id === "exp-fjordblink-bareroot");
      assertTrue(!!skippedFjordblink, "c25: bare-root cross-domain pair IS in 'skipped'");
      assertEq(skippedFjordblink?.reason, "existing_deep_link_preserved", "c26: reason is 'existing_deep_link_preserved' — a host mismatch protects a bare-root current value exactly like a deep path does");

      // ── (c-gapB-nulled) Gap B guards the NULLED path too, not only the
      //     corrected-would-be path exp-lervig covers above — a write-
      //     eligible (provider_link) pair whose producer's OWN hjemmeside is
      //     an aggregator host (so absent Gap B the plan would be action
      //     "nulled") must ALSO be skipped when the current booking_url is a
      //     deep link, never appear in 'planned' as 'applicable'/'nulled'.
      const dryRunAggregatorDeeplinkPlanned = dryRunRes.body.planned.some(
        (a: any) => a.experience_id === "exp-aggregator-deeplink",
      );
      assertTrue(
        !dryRunAggregatorDeeplinkPlanned,
        "c21: aggregator-hjemmeside pair (would-be 'nulled') with an existing deep link NEVER appears in 'planned' — Gap B guards the nulled path too",
      );
      const skippedAggregatorDeeplink = dryRunRes.body.skipped.find(
        (s: any) => s.experience_id === "exp-aggregator-deeplink",
      );
      assertTrue(!!skippedAggregatorDeeplink, "c22: aggregator-hjemmeside + deep-link pair IS in 'skipped'");
      assertEq(
        skippedAggregatorDeeplink?.reason,
        "existing_deep_link_preserved",
        "c23: reason is 'existing_deep_link_preserved', not 'not_evidence_basis' — provider_link is always evidence-eligible, Gap B is what catches this pair",
      );

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

      // ── (f-gapA/f-gapB) slice 3 — Gap A/Gap B on apply=true: eligible pairs
      //     get written for real; ineligible/deep-link pairs are genuinely
      //     never touched, not just absent from a dry-run preview ──────────
      const providerlinkAfterApply = getExperienceRow("exp-providerlink");
      assertEq(providerlinkAfterApply.booking_url, "https://providerlinkgard.no", "f4: provider_link pair WAS written on apply (acceptance criterion 3 — no regression)");
      assertEq(getConflictAuditRows("exp-providerlink").length, 1, "f5: provider_link pair's write is audited");
      assertTrue(
        applyRes.body.applied.some((a: any) => a.experience_id === "exp-providerlink" && a.action === "corrected"),
        "f6: apply response's 'applied' array reports the provider_link write",
      );

      const noDecisionAfterApply = getExperienceRow("exp-nodecision");
      assertEq(noDecisionAfterApply.booking_url, "https://wrong-host5.example/smaking", "f7: name_token pair with no decision — booking_url completely untouched by apply=true (Gap A)");
      assertEq(getConflictAuditRows("exp-nodecision").length, 0, "f8: no audit row for the undecided pair");
      assertTrue(
        applyRes.body.skipped.some((s: any) => s.experience_id === "exp-nodecision" && s.reason === "not_evidence_basis"),
        "f9: apply response reports exp-nodecision skipped with reason 'not_evidence_basis'",
      );

      const rejectedAfterApply = getExperienceRow("exp-rejected");
      assertEq(rejectedAfterApply.booking_url, "https://wrong-host6.example/aktivitet", "f10: rejected-decision pair — booking_url completely untouched by apply=true (Gap A)");
      assertEq(getConflictAuditRows("exp-rejected").length, 0, "f11: no audit row for the rejected pair");
      assertTrue(
        applyRes.body.skipped.some((s: any) => s.experience_id === "exp-rejected" && s.reason === "not_evidence_basis"),
        "f12: apply response reports exp-rejected skipped with reason 'not_evidence_basis' (same as no-decision, not a distinct 'rejected' reason)",
      );

      const lervigAfterApply = getExperienceRow("exp-lervig");
      assertEq(
        lervigAfterApply.booking_url,
        "https://lerviglocal.no/book",
        "f13: 'the Lervig lesson' — a CONFIRMED pair whose current booking_url is a working deep link is NEVER overwritten with the generic producer homepage, even on apply=true (acceptance criterion 2)",
      );
      assertEq(getConflictAuditRows("exp-lervig").length, 0, "f14: no audit row for the deep-link-preserved pair — genuinely never written, not just skipped-in-response");
      assertTrue(
        applyRes.body.skipped.some((s: any) => s.experience_id === "exp-lervig" && s.reason === "existing_deep_link_preserved"),
        "f15: apply response reports exp-lervig skipped with reason 'existing_deep_link_preserved'",
      );

      // ── (f-gapB-bareroot) same regression as (c-gapB-bareroot) above, but
      //     for real on apply=true: the DB read-back must show booking_url
      //     genuinely unchanged and zero new audit rows — this is the exact
      //     production shape (POST /admin/gardssalg-experience-conflict-
      //     remediation dry-run, 2026-08-08) that would otherwise have
      //     written `www.lervig.no`-shaped overwrites over a correct,
      //     working, more-specific booking domain.
      const fjordblinkAfterApply = getExperienceRow("exp-fjordblink-bareroot");
      assertEq(
        fjordblinkAfterApply.booking_url,
        "https://fjordblinklokal.no",
        "f20: bare-root cross-domain pair — booking_url completely unchanged by apply=true (host-mismatch widening, not just the path/query check)",
      );
      assertEq(getConflictAuditRows("exp-fjordblink-bareroot").length, 0, "f21: no audit row for the bare-root cross-domain pair — genuinely never written, not just skipped-in-response");
      assertTrue(
        applyRes.body.skipped.some((s: any) => s.experience_id === "exp-fjordblink-bareroot" && s.reason === "existing_deep_link_preserved"),
        "f22: apply response reports exp-fjordblink-bareroot skipped with reason 'existing_deep_link_preserved'",
      );
      assertTrue(
        !applyRes.body.applied.some((a: any) => a.experience_id === "exp-fjordblink-bareroot"),
        "f23: exp-fjordblink-bareroot never appears in 'applied'",
      );

      // ── (f-gapB-nulled) same as (c-gapB-nulled) above, but for real: on
      //     apply=true, the aggregator-hjemmeside + deep-link pair must be
      //     genuinely UNWRITTEN — booking_url unchanged in the DB (not just
      //     absent from the response), and no audit row inserted. Without
      //     this fixture, isDeepLinkUrl() being checked before the
      //     corrected/nulled branch was unverified by any test — a bug here
      //     would silently NULL a working deep link.
      const aggregatorDeeplinkAfterApply = getExperienceRow("exp-aggregator-deeplink");
      assertEq(
        aggregatorDeeplinkAfterApply.booking_url,
        "https://wrong-host7.example/bestill-omvisning",
        "f16: aggregator-hjemmeside + deep-link pair — booking_url completely unchanged by apply=true (NOT nulled, NOT overwritten)",
      );
      assertEq(
        getConflictAuditRows("exp-aggregator-deeplink").length,
        0,
        "f17: no audit row for exp-aggregator-deeplink — genuinely never written, not just skipped-in-response",
      );
      assertTrue(
        applyRes.body.skipped.some(
          (s: any) => s.experience_id === "exp-aggregator-deeplink" && s.reason === "existing_deep_link_preserved",
        ),
        "f18: apply response reports exp-aggregator-deeplink skipped with reason 'existing_deep_link_preserved'",
      );
      assertTrue(
        !applyRes.body.applied.some((a: any) => a.experience_id === "exp-aggregator-deeplink"),
        "f19: exp-aggregator-deeplink never appears in 'applied' (not written as 'nulled' or otherwise)",
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

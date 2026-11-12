/**
 * opplevelser-experiences-admission-promotion.test.ts — tests for dev-request
 * 2026-09-02-experiences-karantene-utgang-match-til-verified.
 *
 * PROBLEM this closes: POST /admin/experiences-content-judge-sweep
 * (src/routes/opplevelser.ts) only ever DEMOTED a row (MISMATCH ->
 * needs_review) — a MATCH verdict never promoted anything back OUT of
 * quarantine, so a `needs_review` row that gets freshly re-enriched from a
 * genuinely verified owner-controlled source and correctly re-judged MATCH
 * stayed invisible forever (never reachable by PUBLISH_GATE_SQL, which is
 * what /discover, detail pages, MCP get_experience and A2A all gate on).
 *
 * THE FIX: the SAME sweep call now also evaluates ONE conservative
 * promotion transition per row, gated on THREE independent requirements ALL
 * being true (never the judge verdict alone), PLUS a `confidence` eligibility
 * precondition:
 *   1. judge (this call's own fresh re-judge) renders MATCH.
 *   2. the row's provider has brreg_active=1 (absolute — independent of the
 *      judge verdict; a Brreg-quarantined row is never promoted this way).
 *   3. source_verified: isHjemmesideVerified(provider.field_provenance) OR
 *      isEvidenceUrlVerified(experiences.evidence_url_verification).
 *   4. confidence is already 'high' or 'medium' (a 'low'-confidence row is
 *      never promoted no matter what 1-3 say; confidence itself is left
 *      completely unchanged either way).
 * Only fires for a row whose verification_status was 'needs_review' going
 * INTO this same iteration (SWEEP_ELIGIBLE_WHERE is NOT scoped to
 * needs_review — both published and unpublished rows are swept — so the
 * promotion check re-scopes itself per-row).
 *
 * Same test-harness conventions as
 * opplevelser-experiences-content-judge-sweep.test.ts: in-memory experiences
 * DB (EXPERIENCES_DB_PATH=":memory:"), fresh requires per run, router.handle()
 * as the HTTP entry point, and a mocked globalThis.fetch keyed on URL for
 * both evidence pages and the Anthropic judge endpoint — no live network
 * anywhere in this file.
 *
 * Covers:
 *   (AC1) dry-run reports, per row, `judge`/`brreg_active`/`source_verified`
 *       evaluated SEPARATELY (never a generic bool), and a row satisfying
 *       only some of the requirements shows `promotion.status === "held"`
 *       with `promotion.missing` naming exactly which one(s) failed — ZERO
 *       writes either way.
 *   (AC2) apply:true promotes ONLY rows where all requirements are true —
 *       one test per way a row can be correctly withheld (judge != MATCH;
 *       brreg_active != 1; source not verified; confidence 'low'), each
 *       proving the row stays needs_review and is NOT written to
 *       experience_admission_promotion_audit.
 *   (AC2-positive) both promotion sources (hjemmeside-verified AND
 *       evidence-url-verified) actually promote to 'verified', stamp
 *       admission_verdict with a "promoted:" prefix, advance
 *       admission_checked_at, and write exactly one
 *       experience_admission_promotion_audit row keyed to the sweep's own
 *       batch_id.
 *   (AC1/AC2 composition) a row that was NOT needs_review going in (already
 *       'verified') reports promotion.status "not_applicable" and is never
 *       touched by this mechanism even though it would otherwise qualify.
 *   (AC6) POST /admin/experiences-admission-promotion-rollback: (a) a
 *       promoted batch's rows revert to needs_review; (b) a row NOT in that
 *       batch (never promoted) is untouched; (c) an unknown batch_id is a
 *       graceful no-op (reverted: []), and an EMPTY batch_id is a clear 400,
 *       neither ever crashes.
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
  opts: { url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/experiences-content-judge-sweep";
    const query: Record<string, string> = {};
    let path = url;
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) {
      path = url.slice(0, qIdx);
      new URLSearchParams(url.slice(qIdx + 1)).forEach((v, k) => {
        query[k] = v;
      });
    }
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path,
      query,
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

/** fetchPage()-compatible Response stub (arrayBuffer + headers.get). */
function mkPageResponse(html: string, finalUrl: string): Response {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function mkAnthropicResponse(verdictLine: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: verdictLine }] }),
  } as unknown as Response;
}

export function runOpplevelserExperiencesAdmissionPromotionTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply route under test reads enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
  let restoreMainDb: (() => void) | null = null;

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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "admission-promotion-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-admission-promotion";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const contentJudgePath = require.resolve("../services/experience-content-judge");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, contentJudgePath, opplevelserPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // producer_type is hardcoded (not a bound param) so EVERY provider this
      // file seeds is, by construction, in the gårdssalg cohort per
      // experience-scope.ts's isProviderInGardssalgCohort() — this file's own
      // subject (quarantine-exit promotion) is unrelated to the 2026-09-18
      // scope gate, so its fixtures stay in scope rather than tripping it.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, hjemmeside, brreg_active, field_provenance, producer_type)
         VALUES (@id, @navn, @hjemmeside, @brreg_active, @field_provenance, 'bryggeri')`,
      );
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, slug, description, category, price_band, price_from, evidence_url,
            evidence_url_verification, verification_status, confidence, canonical_id, content_source, enrichment_state)
         VALUES
           (@id, @provider_id, @title, @slug, @description, @category, @price_band, @price_from, @evidence_url,
            @evidence_url_verification, @verification_status, @confidence, @canonical_id, 'provider_site', 'enriched')`,
      );

      const snapshot = (id: string) =>
        expDb
          .prepare(
            `SELECT verification_status, admission_verdict, admission_checked_at FROM experiences WHERE id = ?`,
          )
          .get(id) as { verification_status: string; admission_verdict: string | null; admission_checked_at: string | null } | undefined;

      const auditRowsFor = (experienceId: string) =>
        expDb
          .prepare(`SELECT * FROM experience_admission_promotion_audit WHERE experience_id = ?`)
          .all(experienceId) as Array<{
          id: string;
          experience_id: string;
          batch_id: string;
          from_status: string;
          to_status: string;
          reason: string | null;
        }>;

      const hjemmesideVerifiedProvenance = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" },
      });

      // ── providers ──────────────────────────────────────────────────────
      insertProvider.run({
        id: "prov-active-hjemmeside-verified",
        navn: "Fjordguide AS",
        hjemmeside: "https://fjordguide.example.no",
        brreg_active: 1,
        field_provenance: hjemmesideVerifiedProvenance,
      });
      insertProvider.run({
        id: "prov-active-unverified",
        navn: "Ukjent Kilde AS",
        hjemmeside: "https://ukjentkilde.example.no",
        brreg_active: 1,
        field_provenance: null,
      });
      insertProvider.run({
        id: "prov-inactive-hjemmeside-verified",
        navn: "Nedlagt Firma AS",
        hjemmeside: "https://nedlagt.example.no",
        brreg_active: 0,
        field_provenance: hjemmesideVerifiedProvenance,
      });

      // ── experiences ────────────────────────────────────────────────────
      // (1) promotes via hjemmeside-verified provider source.
      insertExperience.run({
        id: "adm-promote-hjemmeside", provider_id: "prov-active-hjemmeside-verified",
        title: "Fjordtur med guide", slug: "adm-promote-hjemmeside",
        description: "Kort om fjordturen.", category: "aktivitet", price_band: "standard", price_from: 600,
        evidence_url: "https://good.no/fjordtur", evidence_url_verification: null,
        verification_status: "needs_review", confidence: "high", canonical_id: null,
      });
      // (2) promotes via the row's OWN evidence_url_verification (provider's
      //     hjemmeside is NOT verified — proves the "EITHER/OR" is real).
      insertExperience.run({
        id: "adm-promote-evidenceurl", provider_id: "prov-active-unverified",
        title: "Kanotur i skjærgården", slug: "adm-promote-evidenceurl",
        description: "Kort om kanoturen.", category: "aktivitet", price_band: "standard", price_from: 450,
        evidence_url: "https://good.no/kanotur",
        evidence_url_verification: JSON.stringify({ verified: true, classification: "verified" }),
        verification_status: "needs_review", confidence: "medium", canonical_id: null,
      });
      // (3) held: judge renders MISMATCH -> missing=['judge'].
      insertExperience.run({
        id: "adm-held-judge", provider_id: "prov-active-hjemmeside-verified",
        title: "Klatretur i fjellet", slug: "adm-held-judge",
        description: "Kort om klatreturen.", category: "aktivitet", price_band: "standard", price_from: 700,
        evidence_url: "https://mismatch.no/klatretur", evidence_url_verification: null,
        verification_status: "needs_review", confidence: "high", canonical_id: null,
      });
      // (4) held: provider brreg_active=0 -> missing=['brreg_active'],
      //     EVEN THOUGH the provider's hjemmeside IS verified and the judge
      //     will render MATCH — brreg_active is absolute, independent of
      //     everything else.
      insertExperience.run({
        id: "adm-held-brreg", provider_id: "prov-inactive-hjemmeside-verified",
        title: "Isbretur med brefører", slug: "adm-held-brreg",
        description: "Kort om isbreturen.", category: "aktivitet", price_band: "standard", price_from: 900,
        evidence_url: "https://good.no/isbretur", evidence_url_verification: null,
        verification_status: "needs_review", confidence: "high", canonical_id: null,
      });
      // (5) held: neither hjemmeside nor evidence_url independently verified
      //     -> missing=['source_verified'].
      insertExperience.run({
        id: "adm-held-source", provider_id: "prov-active-unverified",
        title: "Rafting i elva", slug: "adm-held-source",
        description: "Kort om raftingturen.", category: "aktivitet", price_band: "standard", price_from: 550,
        evidence_url: "https://good.no/rafting", evidence_url_verification: null,
        verification_status: "needs_review", confidence: "high", canonical_id: null,
      });
      // (6) held: confidence is 'low' -> missing includes 'confidence', even
      //     though judge/brreg/source all pass.
      insertExperience.run({
        id: "adm-held-confidence", provider_id: "prov-active-hjemmeside-verified",
        title: "Sopptur med kjentmann", slug: "adm-held-confidence",
        description: "Kort om sopptur.", category: "aktivitet", price_band: "standard", price_from: 300,
        evidence_url: "https://good.no/sopptur", evidence_url_verification: null,
        verification_status: "needs_review", confidence: "low", canonical_id: null,
      });
      // (7) not applicable: already 'verified' going in — every other
      //     requirement would pass, but this must never be "promoted" (it's
      //     already there) and promotion.applicable must be false.
      insertExperience.run({
        id: "adm-not-applicable", provider_id: "prov-active-hjemmeside-verified",
        title: "Elvepadling for familier", slug: "adm-not-applicable",
        description: "Kort om elvepadling.", category: "aktivitet", price_band: "standard", price_from: 400,
        evidence_url: "https://good.no/elvepadling", evidence_url_verification: null,
        verification_status: "verified", confidence: "high", canonical_id: null,
      });
      // (8) baseline control for the rollback tests below: verified, but
      //     NEVER touched by any promotion this file runs (no evidence_url
      //     at all -> outside SWEEP_ELIGIBLE_WHERE entirely).
      insertExperience.run({
        id: "adm-baseline-untouched", provider_id: "prov-active-hjemmeside-verified",
        title: "Fisketur ved fjorden", slug: "adm-baseline-untouched",
        description: "d", category: "aktivitet", price_band: "standard", price_from: 200,
        evidence_url: null, evidence_url_verification: null,
        verification_status: "verified", confidence: "high", canonical_id: null,
      });

      // Regression-scenario (Defect 1) fixture: a dedicated row + evidence
      // URL whose judge verdict this test flips across THREE separate
      // sweep calls (MATCH -> MISMATCH -> MATCH again), via a call counter
      // keyed on the row's title — see the regression test block below for
      // why (rollback must not revert a row a LATER, independent batch
      // re-promoted).
      const regressionTitle = "Brefjordekspedisjon";
      const regressionUrl = "https://good.no/brefjordekspedisjon";
      let regressionJudgeCalls = 0;

      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr === "https://api.anthropic.com/v1/messages") {
          const body = JSON.parse(init?.body ?? "{}");
          const promptText: string = body?.messages?.[0]?.content ?? "";
          if (promptText.includes(regressionTitle)) {
            regressionJudgeCalls++;
            // 1st and 3rd calls: MATCH (batch A promotes, batch B
            // re-promotes). 2nd call: MISMATCH (demotes back to
            // needs_review in between, so batch B is a genuinely
            // independent later promotion, not a re-run of batch A).
            if (regressionJudgeCalls === 2) {
              return mkAnthropicResponse("MISMATCH\nMidlertidig avvik i produktteksten.");
            }
            return mkAnthropicResponse("MATCH\nStemmer godt med kilden.");
          }
          if (promptText.includes("Seiltur i skjærgården")) {
            // Review N1: a MATCH whose own reason names the nav menu — the
            // sweep must pass outcome.reason into the promotion guard.
            return mkAnthropicResponse("MATCH\nBeskrivelsen gjengir navigasjonsmenyen på nettsiden.");
          }
          if (promptText.includes("Klatretur i fjellet")) {
            return mkAnthropicResponse("MISMATCH\nSiden handler om noe helt annet.");
          }
          return mkAnthropicResponse("MATCH\nStemmer godt med kilden.");
        }
        if (urlStr === regressionUrl) {
          return mkPageResponse(
            "<html><body>Brefjordekspedisjon med sertifisert fjellfører, hele dagen langs innsjøen.</body></html>",
            urlStr,
          );
        }
        if (urlStr === "https://good.no/fjordtur") {
          return mkPageResponse("<html><body>Fjordtur med guide, avgang hver dag fra brygga.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/kanotur") {
          return mkPageResponse("<html><body>Kanotur i skjærgården, to timer med erfaren guide.</body></html>", urlStr);
        }
        if (urlStr === "https://mismatch.no/klatretur") {
          return mkPageResponse("<html><body>Dette er en side om noe helt annet.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/isbretur") {
          return mkPageResponse("<html><body>Isbretur med sertifisert brefører, hele dagen.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/rafting") {
          return mkPageResponse("<html><body>Rafting i elva, familievennlig klasse 2-3.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/sopptur") {
          return mkPageResponse("<html><body>Sopptur med kjentmann, høst i skogen.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/elvepadling") {
          return mkPageResponse("<html><body>Elvepadling for hele familien, rolig vann.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/navreason") {
          return mkPageResponse("<html><body>Seiltur i skjærgården med skipper, tre timer.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/topptur") {
          return mkPageResponse("<html><body>Guidet fjelltur til toppen av fjellet med lokal fjellfører.</body></html>", urlStr);
        }
        if (urlStr.startsWith("https://good.no/preview-")) {
          return mkPageResponse("<html><body>Gårdsbesøk med omvisning og smaksprøver fra gården.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/navdump") {
          return mkPageResponse("<html><body>Kajakktur på fjorden med guide, avgang hver dag fra brygga.</body></html>", urlStr);
        }
        throw new Error("admission-promotion test: unexpected fetch URL: " + urlStr);
      }) as unknown as typeof fetch;

      // ═══ (AC1) dry-run — per-row requirement breakdown, ZERO writes ══════
      let dryRunBody: any;
      {
        const before = new Map(
          [
            "adm-promote-hjemmeside", "adm-promote-evidenceurl", "adm-held-judge", "adm-held-brreg",
            "adm-held-source", "adm-held-confidence", "adm-not-applicable", "adm-baseline-untouched",
          ].map((id) => [id, snapshot(id)]),
        );

        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        dryRunBody = r.body;
        assertEq(r.status, 200, "adm-1a: dry-run -> 200");
        assertEq(r.body.dry_run, true, "adm-1b: dry_run:true");

        const byId = new Map<string, any>((r.body.results as any[]).map((x) => [x.id, x]));

        // Positive cases: both would_promote, all three requirement fields true.
        const p1 = byId.get("adm-promote-hjemmeside")?.promotion;
        assertEq(p1?.applicable, true, "adm-2a: adm-promote-hjemmeside promotion.applicable=true");
        assertEq(p1?.judge, "MATCH", "adm-2b: adm-promote-hjemmeside promotion.judge='MATCH'");
        assertEq(p1?.brreg_active, true, "adm-2c: adm-promote-hjemmeside promotion.brreg_active=true");
        assertEq(p1?.source_verified, true, "adm-2d: adm-promote-hjemmeside promotion.source_verified=true (via hjemmeside)");
        assertEq(p1?.confidence_ok, true, "adm-2e: adm-promote-hjemmeside promotion.confidence_ok=true");
        assertEq(p1?.status, "would_promote", "adm-2f: adm-promote-hjemmeside promotion.status='would_promote' in dry-run");
        assertEq(p1?.missing, undefined, "adm-2g: no 'missing' field when eligible");
        assertEq(p1?.content_quality, true, "adm-2h: promotion.content_quality=true reported per row (short Norwegian description is not nav chrome)");
        assertEq(p1?.judge_reason_nav, true, "adm-2i: promotion.judge_reason_nav=true reported per row (judge reason has no nav/menu terms)");
        assertEq(p1?.judge_reason_org, true, "adm-2j: promotion.judge_reason_org=true reported per row (judge reason is not organisation-only)");

        const p2 = byId.get("adm-promote-evidenceurl")?.promotion;
        assertEq(p2?.source_verified, true, "adm-3a: adm-promote-evidenceurl promotion.source_verified=true (via evidence_url, hjemmeside NOT verified)");
        assertEq(p2?.status, "would_promote", "adm-3b: adm-promote-evidenceurl promotion.status='would_promote'");

        // Held cases: exactly the one missing requirement named, nothing else.
        const pJudge = byId.get("adm-held-judge")?.promotion;
        assertEq(pJudge?.status, "held", "adm-4a: adm-held-judge status='held'");
        assertEq(pJudge?.missing, ["judge"], "adm-4b: adm-held-judge missing=['judge'] only (brreg_active+source_verified+confidence all pass)");

        const pBrreg = byId.get("adm-held-brreg")?.promotion;
        assertEq(pBrreg?.judge, "MATCH", "adm-5a: adm-held-brreg still judged MATCH");
        assertEq(pBrreg?.source_verified, true, "adm-5b: adm-held-brreg source_verified=true (hjemmeside IS verified)");
        assertEq(pBrreg?.status, "held", "adm-5c: adm-held-brreg status='held'");
        assertEq(pBrreg?.missing, ["brreg_active"], "adm-5d: adm-held-brreg missing=['brreg_active'] ONLY — proves brreg_active is absolute/independent of judge+source both passing");

        const pSource = byId.get("adm-held-source")?.promotion;
        assertEq(pSource?.brreg_active, true, "adm-6a: adm-held-source brreg_active=true");
        assertEq(pSource?.status, "held", "adm-6b: adm-held-source status='held'");
        assertEq(pSource?.missing, ["source_verified"], "adm-6c: adm-held-source missing=['source_verified'] only");

        const pConf = byId.get("adm-held-confidence")?.promotion;
        assertEq(pConf?.judge, "MATCH", "adm-7a: adm-held-confidence still judged MATCH");
        assertEq(pConf?.brreg_active, true, "adm-7b: adm-held-confidence brreg_active=true");
        assertEq(pConf?.source_verified, true, "adm-7c: adm-held-confidence source_verified=true");
        assertEq(pConf?.confidence_ok, false, "adm-7d: adm-held-confidence confidence_ok=false ('low')");
        assertEq(pConf?.status, "held", "adm-7e: adm-held-confidence status='held'");
        assertEq(pConf?.missing, ["confidence"], "adm-7f: adm-held-confidence missing=['confidence'] only, even though judge/brreg/source all pass");

        const pNa = byId.get("adm-not-applicable")?.promotion;
        assertEq(pNa?.applicable, false, "adm-8a: adm-not-applicable promotion.applicable=false (was already 'verified', not needs_review)");
        assertEq(pNa?.status, "not_applicable", "adm-8b: adm-not-applicable promotion.status='not_applicable'");

        // Zero writes anywhere.
        let allUnchanged = true;
        for (const [id, snap] of before) {
          if (JSON.stringify(snap) !== JSON.stringify(snapshot(id))) allUnchanged = false;
        }
        assertTrue(allUnchanged, "adm-9: dry-run wrote NOTHING — every row's verification_status/admission_verdict/admission_checked_at unchanged");

        // Audit table is empty after dry-run.
        const auditCount = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_admission_promotion_audit`).get() as { n: number }).n;
        assertEq(auditCount, 0, "adm-10: experience_admission_promotion_audit has ZERO rows after dry-run");

        // counts.promoted mirrors match/mismatch/unresolved's "verdict
        // reached this call" semantics: it counts the 2 would_promote rows
        // even on dry-run (previously always 0 until apply:true, even when
        // results[] already reported would_promote rows).
        assertEq(dryRunBody.counts.promoted, 2, "adm-10b: dry-run counts.promoted == 2 (would_promote rows), not stuck at 0");
      }

      // ═══ (AC2) apply:true — promotes ONLY the eligible rows ═════════════
      let applyBody: any;
      let batchId: string;
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        applyBody = r.body;
        batchId = r.body.batch_id;
        assertEq(r.status, 200, "adm-11a: apply -> 200");
        assertEq(r.body.dry_run, false, "adm-11b: dry_run:false");
        assertTrue(typeof batchId === "string" && batchId.length > 0, "adm-11c: response carries a non-empty batch_id");

        const byId = new Map<string, any>((r.body.results as any[]).map((x) => [x.id, x]));

        // ── positive: hjemmeside-verified source ──────────────────────────
        const s1 = snapshot("adm-promote-hjemmeside")!;
        assertEq(s1.verification_status, "verified", "adm-12a: adm-promote-hjemmeside promoted to 'verified'");
        assertTrue(!!s1.admission_verdict?.startsWith("promoted:"), "adm-12b: admission_verdict starts with 'promoted:'");
        assertTrue(!!s1.admission_checked_at, "adm-12c: admission_checked_at advanced");
        assertEq(byId.get("adm-promote-hjemmeside")?.verification_status, "verified", "adm-12d: response reports post-write verification_status='verified'");
        assertEq(byId.get("adm-promote-hjemmeside")?.promotion?.status, "promoted", "adm-12e: response promotion.status='promoted'");
        const audit1 = auditRowsFor("adm-promote-hjemmeside");
        assertEq(audit1.length, 1, "adm-13a: exactly ONE experience_admission_promotion_audit row written for adm-promote-hjemmeside");
        assertEq(audit1[0]?.batch_id, batchId, "adm-13b: audit row's batch_id == the sweep call's own batch_id");
        assertEq(audit1[0]?.from_status, "needs_review", "adm-13c: audit row from_status='needs_review'");
        assertEq(audit1[0]?.to_status, "verified", "adm-13d: audit row to_status='verified'");
        assertTrue(!!audit1[0]?.reason && audit1[0].reason.length > 0, "adm-13e: audit row carries the judge's reasoning text");

        // ── positive: evidence_url-verified source (hjemmeside NOT verified) ──
        const s2 = snapshot("adm-promote-evidenceurl")!;
        assertEq(s2.verification_status, "verified", "adm-14a: adm-promote-evidenceurl promoted to 'verified' via its OWN evidence_url_verification");
        assertTrue(!!s2.admission_verdict?.startsWith("promoted:"), "adm-14b: admission_verdict starts with 'promoted:'");
        assertEq(auditRowsFor("adm-promote-evidenceurl").length, 1, "adm-14c: exactly one audit row for adm-promote-evidenceurl");

        // ── withheld #1: judge != MATCH ────────────────────────────────────
        const sJudge = snapshot("adm-held-judge")!;
        assertEq(sJudge.verification_status, "needs_review", "adm-15a: adm-held-judge STAYS needs_review (judge rendered MISMATCH)");
        assertTrue(!!sJudge.admission_verdict?.startsWith("mismatch:"), "adm-15b: admission_verdict stamped 'mismatch:' (normal demotion path, unaffected by promotion logic)");
        assertEq(auditRowsFor("adm-held-judge").length, 0, "adm-15c: ZERO experience_admission_promotion_audit rows for adm-held-judge");

        // ── withheld #2: brreg_active != 1 ─────────────────────────────────
        const sBrreg = snapshot("adm-held-brreg")!;
        assertEq(sBrreg.verification_status, "needs_review", "adm-16a: adm-held-brreg STAYS needs_review (provider brreg_active=0)");
        assertTrue(!!sBrreg.admission_verdict?.startsWith("match:"), "adm-16b: admission_verdict stamped plain 'match:' (NOT 'promoted:') since promotion never happened");
        assertEq(auditRowsFor("adm-held-brreg").length, 0, "adm-16c: ZERO experience_admission_promotion_audit rows for adm-held-brreg");

        // ── withheld #3: source not verified ───────────────────────────────
        const sSource = snapshot("adm-held-source")!;
        assertEq(sSource.verification_status, "needs_review", "adm-17a: adm-held-source STAYS needs_review (neither hjemmeside nor evidence_url independently verified)");
        assertTrue(!!sSource.admission_verdict?.startsWith("match:"), "adm-17b: admission_verdict stamped plain 'match:'");
        assertEq(auditRowsFor("adm-held-source").length, 0, "adm-17c: ZERO experience_admission_promotion_audit rows for adm-held-source");

        // ── withheld #4: confidence 'low' ───────────────────────────────────
        const sConf = snapshot("adm-held-confidence")!;
        assertEq(sConf.verification_status, "needs_review", "adm-18a: adm-held-confidence STAYS needs_review ('low' confidence)");
        assertTrue(!!sConf.admission_verdict?.startsWith("match:"), "adm-18b: admission_verdict stamped plain 'match:'");
        assertEq(auditRowsFor("adm-held-confidence").length, 0, "adm-18c: ZERO experience_admission_promotion_audit rows for adm-held-confidence");
        const expConfRow = expDb.prepare(`SELECT confidence FROM experiences WHERE id = ?`).get("adm-held-confidence") as { confidence: string };
        assertEq(expConfRow.confidence, "low", "adm-18d: confidence itself untouched (still 'low') — this is a read-only eligibility gate, never a write");

        // ── not-applicable: never touched ────────────────────────────────
        const sNa = snapshot("adm-not-applicable")!;
        assertEq(sNa.verification_status, "verified", "adm-19a: adm-not-applicable stays 'verified' (was never needs_review)");
        assertEq(auditRowsFor("adm-not-applicable").length, 0, "adm-19b: ZERO audit rows for adm-not-applicable — this mechanism only ever fires from needs_review");

        // counts.promoted == exactly the 2 genuinely promoted rows.
        assertEq(r.body.counts.promoted, 2, "adm-20: counts.promoted == 2 (adm-promote-hjemmeside + adm-promote-evidenceurl)");

        // AC3 (best-effort): before/after needs_review totals move by exactly
        // the 2 rows promoted OUT this call — the 4 "held" rows (adm-held-
        // judge/brreg/source/confidence) were ALREADY needs_review going in
        // and stay needs_review (adm-held-judge's MISMATCH write is a no-op
        // re-write of the same status), so they contribute zero net movement.
        assertEq(
          r.body.needs_review_after,
          r.body.needs_review_before - 2,
          "adm-21: needs_review_after == needs_review_before - 2 (exactly the 2 rows promoted OUT this call)",
        );
      }

      // ═══ (AC6) rollback ══════════════════════════════════════════════════
      {
        // (c-empty) empty batch_id -> 400, never a crash.
        const rEmpty = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: "" },
        });
        assertEq(rEmpty.status, 400, "adm-22a: empty batch_id -> 400");
        assertTrue(typeof rEmpty.body?.error === "string" && rEmpty.body.error.length > 0, "adm-22b: 400 carries a non-empty JSON error message");

        // (c-unknown) unknown batch_id -> graceful no-op, not a crash/error.
        const rUnknown = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: "content-judge-sweep-does-not-exist" },
        });
        assertEq(rUnknown.status, 200, "adm-23a: unknown batch_id -> 200 (no-op, not an error)");
        assertEq(rUnknown.body.success, true, "adm-23b: unknown batch_id success:true");
        assertEq(rUnknown.body.reverted, [], "adm-23c: unknown batch_id reverted:[] (nothing matched)");

        // Snapshot the untouched baseline row BEFORE the real rollback.
        const baselineBefore = snapshot("adm-baseline-untouched")!;

        // (a) the real batch: both promoted rows revert to needs_review.
        const rReal = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: batchId },
        });
        assertEq(rReal.status, 200, "adm-24a: real batch_id rollback -> 200");
        assertEq(rReal.body.success, true, "adm-24b: success:true");
        const revertedIds = new Set((rReal.body.reverted as any[]).map((x) => x.experience_id));
        assertTrue(revertedIds.has("adm-promote-hjemmeside"), "adm-24c: adm-promote-hjemmeside is in the reverted list");
        assertTrue(revertedIds.has("adm-promote-evidenceurl"), "adm-24d: adm-promote-evidenceurl is in the reverted list");
        assertEq(revertedIds.size, 2, "adm-24e: exactly 2 rows reverted (only this batch's promotions)");

        const s1After = snapshot("adm-promote-hjemmeside")!;
        assertEq(s1After.verification_status, "needs_review", "adm-25a: adm-promote-hjemmeside back to 'needs_review'");
        const s2After = snapshot("adm-promote-evidenceurl")!;
        assertEq(s2After.verification_status, "needs_review", "adm-25b: adm-promote-evidenceurl back to 'needs_review'");

        // (b) a row NOT in that batch (a pre-existing, never-promoted
        //     'verified' row) is completely untouched.
        const baselineAfter = snapshot("adm-baseline-untouched")!;
        assertEq(baselineAfter, baselineBefore, "adm-26: adm-baseline-untouched (not part of this batch) is byte-for-byte unchanged by the rollback");
        assertEq(baselineAfter.verification_status, "verified", "adm-27: adm-baseline-untouched still 'verified'");

        // Re-running the SAME batch_id rollback again is a safe no-op — the
        // rows are no longer verification_status='verified', so nothing
        // matches the second time (never double-reverts / never crashes).
        const rAgain = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: batchId },
        });
        assertEq(rAgain.status, 200, "adm-28a: re-running the same rollback -> 200, no crash");
        assertEq(rAgain.body.reverted, [], "adm-28b: second run reverts nothing (rows are no longer 'verified')");
      }

      // ═══ Regression (Defect 1 fix): rollback must not revert a row a
      // LATER, independent batch re-promoted ═════════════════════════════
      //
      // SWEEP_ELIGIBLE_WHERE is NOT scoped to needs_review, so an
      // already-verified row is re-swept every call and can be re-demoted
      // by a later MISMATCH, then re-promoted by a DIFFERENT, later batch.
      // A rollback aimed at the FIRST (now-superseded) batch must leave the
      // row's current, independently-re-promoted state alone.
      {
        insertExperience.run({
          id: "adm-regression-latest-batch", provider_id: "prov-active-hjemmeside-verified",
          title: regressionTitle, slug: "adm-regression-latest-batch",
          description: "Kort om brefjordekspedisjonen.", category: "aktivitet", price_band: "standard", price_from: 800,
          evidence_url: regressionUrl, evidence_url_verification: null,
          verification_status: "needs_review", confidence: "high", canonical_id: null,
        });

        // ── batch A: promote (judge call #1 -> MATCH) ──────────────────────
        const rA = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        const batchA: string = rA.body.batch_id;
        const sAfterA = snapshot("adm-regression-latest-batch")!;
        assertEq(sAfterA.verification_status, "verified", "adm-29a: adm-regression-latest-batch promoted to 'verified' in batch A");

        // ── demote: re-sweep (judge call #2 -> MISMATCH) ───────────────────
        const rDemote = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        const demoteBatchId: string = rDemote.body.batch_id;
        const sAfterDemote = snapshot("adm-regression-latest-batch")!;
        assertEq(sAfterDemote.verification_status, "needs_review", "adm-29b: adm-regression-latest-batch demoted back to 'needs_review' (later MISMATCH)");

        // ── batch B: re-promote, a COMPLETELY INDEPENDENT later batch
        //    (judge call #3 -> MATCH again) ─────────────────────────────────
        const rB = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        const batchB: string = rB.body.batch_id;
        const sAfterB = snapshot("adm-regression-latest-batch")!;
        assertEq(sAfterB.verification_status, "verified", "adm-29c: adm-regression-latest-batch re-promoted to 'verified' in batch B");

        // Defect 2: three consecutive apply calls, issued back-to-back (same
        // wall-clock second, in practice), must never produce colliding
        // batch_ids.
        assertTrue(
          new Set([batchA, demoteBatchId, batchB]).size === 3,
          "adm-30: three consecutive apply calls produce three distinct batch_ids, even issued back-to-back in the same wall-clock second",
        );

        // Audit trail: two promotion rows for this experience, batch A then
        // batch B, in that (insertion) order.
        const auditHistory = expDb
          .prepare(
            `SELECT batch_id, from_status, to_status FROM experience_admission_promotion_audit WHERE experience_id = ? ORDER BY rowid`,
          )
          .all("adm-regression-latest-batch") as Array<{ batch_id: string; from_status: string; to_status: string }>;
        assertEq(auditHistory.length, 2, "adm-31a: exactly 2 promotion-audit rows for adm-regression-latest-batch (batch A + batch B)");
        assertEq(auditHistory[0]?.batch_id, batchA, "adm-31b: first audit row is batch A's promotion");
        assertEq(auditHistory[1]?.batch_id, batchB, "adm-31c: second (latest) audit row is batch B's promotion");

        // ── the actual regression: roll back batch A (STALE — superseded by
        //    batch B's later, independent promotion) — the row must be left
        //    COMPLETELY UNTOUCHED, even though an audit row for batch A
        //    genuinely exists for it and it is currently verification_
        //    status='verified'. ───────────────────────────────────────────
        const rRollbackStale = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: batchA },
        });
        assertEq(rRollbackStale.status, 200, "adm-32a: stale-batch rollback -> 200");
        const staleRevertedIds = new Set((rRollbackStale.body.reverted as any[]).map((x) => x.experience_id));
        assertTrue(
          !staleRevertedIds.has("adm-regression-latest-batch"),
          "adm-32b: adm-regression-latest-batch is NOT in batch A's rollback revert list (its latest promotion is batch B, not batch A)",
        );

        const sAfterStaleRollback = snapshot("adm-regression-latest-batch")!;
        assertEq(sAfterStaleRollback.verification_status, "verified", "adm-33a: adm-regression-latest-batch is STILL 'verified' after batch A's rollback");
        assertEq(sAfterStaleRollback, sAfterB, "adm-33b: row is byte-for-byte unchanged from its post-batch-B snapshot — batch A's rollback touched nothing about it");

        // ── control: rolling back batch B (its ACTUAL latest promotion)
        //    DOES revert it — proves the rollback route still works when
        //    the requested batch_id genuinely IS the latest promotion. ────
        const rRollbackLatest = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: batchB },
        });
        const latestRevertedIds = new Set((rRollbackLatest.body.reverted as any[]).map((x) => x.experience_id));
        assertTrue(
          latestRevertedIds.has("adm-regression-latest-batch"),
          "adm-34a: adm-regression-latest-batch IS in batch B's rollback revert list (batch B genuinely is its latest promotion)",
        );
        const sAfterLatestRollback = snapshot("adm-regression-latest-batch")!;
        assertEq(sAfterLatestRollback.verification_status, "needs_review", "adm-34b: adm-regression-latest-batch reverted to 'needs_review' by its OWN (latest) batch's rollback");
      }

      // ── Promotion guard 2026-11-09: content_quality + judge_reason_nav ──
      // Pure tests of the shared evaluateContentJudgePromotion() (sweep AND
      // content-judgement job). Every old requirement is met in `base`, so
      // the only possible `missing` entries are the two new ones.
      {
        const mod = require("./opplevelser") as typeof import("./opplevelser");
        const base = {
          verification_status: "needs_review",
          confidence: "high",
          evidence_url_verification: null,
          p_brreg_active: 1,
          p_field_provenance: hjemmesideVerifiedProvenance,
        };
        const okReason = "Stemmer godt med kilden.";
        const navDump =
          "Hjem | Om oss | Opplevelser | Overnatting | Kontakt | Velkommen til Fjordgarden " +
          "Hjem | Om oss | Opplevelser | Overnatting | Kontakt";
        const navDumpFlat = "Hjem Om Oss Gårdsbutikk Opplevelser Overnatting Galleri Nyheter Kontakt Bestill";
        const skipLink = "Skip to content Fjordgarden Velkommen til oss på gården";

        const d1 = mod.evaluateContentJudgePromotion({ ...base, description: navDump }, "MATCH", okReason);
        assertEq(d1.eligible, false, "adm-g1a: nav-menu-dump description + MATCH + all old requirements -> NOT eligible");
        assertEq(d1.missing, ["content_quality"], "adm-g1b: missing=['content_quality'] only");
        assertEq(d1.contentQualityOk, false, "adm-g1c: contentQualityOk=false for the nav dump");
        const d1b = mod.evaluateContentJudgePromotion({ ...base, description: navDumpFlat }, "MATCH", okReason);
        assertEq(d1b.missing, ["content_quality"], "adm-g1d: flat Title-Case nav bar description -> missing=['content_quality']");
        const d1c = mod.evaluateContentJudgePromotion({ ...base, description: skipLink }, "MATCH", okReason);
        assertEq(d1c.missing, ["content_quality"], "adm-g1e: skip-link chrome description -> missing=['content_quality']");

        const noProse =
          "Bli med på en guidet kajakktur langs fjorden. Vi serverer lokal mat underveis, og turen passer for hele familien.";
        const d2 = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", okReason);
        assertEq(d2.eligible, true, "adm-g2a: real Norwegian prose description -> eligible as before");
        assertEq(d2.missing, [], "adm-g2b: Norwegian prose -> missing=[]");
        const enProse =
          "Craft Beer Tasting & Brewery Experience: join our brewer for a guided tour of the brewhouse and taste five local beers.";
        const d3 = mod.evaluateContentJudgePromotion({ ...base, description: enProse }, "MATCH", okReason);
        assertEq(d3.eligible, true, "adm-g3a: real English prose description -> eligible (English is NOT blocked by content_quality)");
        assertEq(d3.contentQualityOk, true, "adm-g3b: English prose contentQualityOk=true");
        const dShort = mod.evaluateContentJudgePromotion({ ...base, description: "Kort om fjordturen." }, "MATCH", okReason);
        assertEq(dShort.eligible, true, "adm-g3c: short Norwegian description (<80 chars) is NOT blocked by content_quality");

        const d4 = mod.evaluateContentJudgePromotion(
          { ...base, description: noProse },
          "MATCH",
          "Beskrivelsen inneholder samme navigasjonsmeny og strukturinformasjon som nettsiden.",
        );
        assertEq(d4.eligible, false, "adm-g4a: MATCH with reason mentioning 'navigasjonsmeny' -> NOT eligible");
        assertEq(d4.missing, ["judge_reason_nav"], "adm-g4b: missing=['judge_reason_nav'] only");
        assertEq(d4.judgeReasonNavOk, false, "adm-g4c: judgeReasonNavOk=false");
        for (const [i, reason] of [
          "The stored description is a direct excerpt from the site's NAVIGATION menu and welcome text.",
          "Gjenspeiler meny-struktur og velkomsttekst.",
          "Teksten er hentet fra menystrukturen på siden.",
          "Matches the nav menu of the page.",
          "Inneholder nav-menyen og overskrifter.",
          "Tekst fra menylinjen.",
        ].entries()) {
          const d = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", reason);
          assertEq(d.missing, ["judge_reason_nav"], `adm-g4d.${i}: reason "${reason}" -> missing=['judge_reason_nav']`);
        }

        // Review N3: more nav-chrome phrasings in the judge's reason.
        for (const [i, reason] of [
          "Teksten er hentet fra hovedmenyen på siden.",
          "Gjengir toppmenyen og overskrifter.",
          "Matches the navbar of the page.",
          "The stored text is the site's nav bar.",
          "Copied from the main menu.",
        ].entries()) {
          const d = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", reason);
          assertEq(d.missing, ["judge_reason_nav"], `adm-g4e.${i}: reason "${reason}" -> missing=['judge_reason_nav']`);
        }

        // Review B1: "til toppen" is ordinary summit-hike prose in the
        // experience catalogue — it must NOT count as a nav marker here;
        // only the full anchor phrase "tilbake til toppen" does.
        for (const [i, summit] of [
          "Vi tar deg med til toppen av fjellet.",
          "Guidet tur til toppen med lokal fjellfører.",
        ].entries()) {
          const d = mod.evaluateContentJudgePromotion({ ...base, description: summit }, "MATCH", okReason);
          assertEq(d.contentQualityOk, true, `adm-g9a.${i}: summit prose "${summit}" -> contentQualityOk=true`);
          assertEq(d.eligible, true, `adm-g9b.${i}: summit prose "${summit}" -> eligible`);
        }
        const dTop = mod.evaluateContentJudgePromotion(
          { ...base, description: "Kajakktur på fjorden med guide. Tilbake til toppen" },
          "MATCH",
          okReason,
        );
        assertEq(dTop.missing, ["content_quality"], "adm-g9c: 'Tilbake til toppen' anchor still flags content_quality");

        // 2026-11-10 (navtekst i beskrivelse): a RUN of site-nav / social-link
        // words embedded in otherwise prose-like text (hasNavWordRun). Both
        // strings are real prod descriptions that used to pass content_quality.
        {
          const se = require("../services/search-enrich") as typeof import("../services/search-enrich");
          const annoProd =
            "Anno &#8211; Spise og Drikke Hjem Meny Meny Pizzameny Gruppemeny Booking Kontakt Bestill Takeaway " +
            "Velkommen til Anno vi ønsker deg velkommen til oss og gleder oss til å varte deg opp!";
          const frithjofProd =
            "Losskøyta Frithjof II | Facebook X Instagram RSS Stiftelsen Venneforeningen Medlemsblad Linker " +
            "Seilingsplan Hovedside Aktiviteter Historie Bilder Frithjof-vise Bøker/rekvisitter Velg en side Velkommen";
          for (const [name, desc] of [["anno-36014679", annoProd], ["frithjof-a6f08b66", frithjofProd]] as const) {
            assertEq(se.hasNavWordRun(desc), true, `adm-g10a.${name}: hasNavWordRun=true`);
            assertEq(se.looksLikeNavBoilerplate(desc), true, `adm-g10b.${name}: looksLikeNavBoilerplate=true`);
            const d = mod.evaluateContentJudgePromotion({ ...base, description: desc }, "MATCH", okReason);
            assertEq(d.wasNeedsReview && !d.eligible, true, `adm-g10c.${name}: otherwise-eligible row -> held (not eligible)`);
            assertEq(d.missing, ["content_quality"], `adm-g10d.${name}: missing=['content_quality']`);
          }
          // Frithjof with more prose after the nav run is still flagged.
          assertEq(
            se.looksLikeNavBoilerplate(frithjofProd + " til Losskøyta Frithjof II. Båten ble bygget i 1919 og seiler fortsatt hver sommer."),
            true,
            "adm-g10e: nav run followed by real prose is still flagged",
          );

          // Must NOT flag: prose mentioning menu/contact/booking, short, English,
          // summit prose, comma-separated activity listing.
          for (const [i, prose] of [
            "Vi serverer en egen meny med lokale råvarer. Kontakt oss for booking av grupper.",
            "Se menyen og bestill bord på nettsiden vår.",
            "Kort om fjordturen.",
            "A guided tour of the farm with tastings of local cheese and cider. Book via our website or contact us.",
            "Vi tar deg med til toppen av fjellet.",
            "Her kan du oppleve historie, aktiviteter for barn, bilder fra gamle dager og en hyggelig kafé.",
          ].entries()) {
            assertEq(se.hasNavWordRun(prose), false, `adm-g10f.${i}: hasNavWordRun=false for prose "${prose}"`);
            assertEq(se.looksLikeNavBoilerplate(prose), false, `adm-g10g.${i}: looksLikeNavBoilerplate=false for "${prose}"`);
            const d = mod.evaluateContentJudgePromotion({ ...base, description: prose }, "MATCH", okReason);
            assertEq(d.contentQualityOk, true, `adm-g10h.${i}: contentQualityOk=true for "${prose}"`);
            assertEq(d.eligible, true, `adm-g10i.${i}: eligible for "${prose}"`);
          }

          // Entity decoding: &nbsp; between nav words keeps the run; &amp; and
          // &#8211; are neutralized (not words, not punctuation).
          assertEq(se.hasNavWordRun("Gården&nbsp;Hjem&nbsp;Meny&nbsp;Kontakt"), true, "adm-g10j: &nbsp;-joined nav words form a run");
          assertEq(se.hasNavWordRun("Mat &amp; Drikke &#8211; Hjem Booking Kontakt oss"), true, "adm-g10k: &amp;/&#8211; decoded, run still detected");
          // Punctuation between tokens breaks a run.
          assertEq(se.hasNavWordRun("Hjem Meny Kontakt"), true, "adm-g10l: bare nav run -> true");
          assertEq(se.hasNavWordRun("Hjem. Meny. Kontakt."), false, "adm-g10m: periods break the run");
          assertEq(se.hasNavWordRun("Hjem, Meny, Kontakt"), false, "adm-g10n: commas break the run");
          assertEq(se.hasNavWordRun("Hjem Meny: Kontakt; Booking"), false, "adm-g10o: colon/semicolon break the run");
          // Multi-word term counts once ("Kontakt oss" = one term), and two
          // distinct terms are below the threshold.
          assertEq(se.hasNavWordRun("Kontakt oss Booking"), false, "adm-g10p: only 2 distinct terms -> false");
          // Lower-case mid-sentence words are prose, not menu labels.
          assertEq(se.hasNavWordRun("vi har meny booking og kontakt her"), false, "adm-g10q: lower-case words never count");
          assertEq(se.hasNavWordRun(null), false, "adm-g10r: null -> false");
        }

        const d5 = mod.evaluateContentJudgePromotion(
          { ...base, description: noProse },
          "MATCH",
          "Kilden beskriver menyen med lokale retter fra samme gård; stemmer med lagret beskrivelse.",
        );
        assertEq(d5.eligible, true, "adm-g5a: reason about a restaurant 'meny' (food menu) -> still eligible");
        assertEq(d5.judgeReasonNavOk, true, "adm-g5b: plain 'meny'/'menyen' does NOT trigger judge_reason_nav");

        // 2026-11-10 (vaktutvidelse): more nav/footer-chrome phrasings an
        // independent dry-run control found the guard missed — incl.
        // plural/inflected forms and capitalisation.
        for (const [i, reason] of [
          "Beskrivelsen er menytekst fra nettsiden.",
          "Teksten består av menyelementer og overskrifter.",
          "Gjengir menypunkter fra siden.",
          "Hentet fra sidemenyen.",
          "Inneholder bunnteksten med kontaktinfo.",
          "Matches the Footer of the page.",
          "Teksten er nav-elementer fra toppen av siden.",
          "Lagret tekst er nav-lenker og velkomsttekst.",
        ].entries()) {
          const d = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", reason);
          assertEq(d.eligible, false, `adm-g4f.${i}: reason "${reason}" -> NOT eligible (held)`);
          assertEq(d.missing, ["judge_reason_nav"], `adm-g4g.${i}: reason "${reason}" -> missing=['judge_reason_nav']`);
        }
        // ...while ordinary food-menu prose still does NOT trigger.
        for (const [i, reason] of [
          "Kilden nevner en meny med lokale retter.",
          "Siden beskriver menyen for sommeren.",
          "Stemmer: dagens meny serveres i gårdskafeen.",
          "Gården tilbyr menyer med lokale retter; stemmer med lagret beskrivelse.",
        ].entries()) {
          const d = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", reason);
          assertEq(d.judgeReasonNavOk, true, `adm-g5c.${i}: food-menu reason "${reason}" -> judgeReasonNavOk=true`);
          assertEq(d.eligible, true, `adm-g5d.${i}: food-menu reason "${reason}" -> still eligible`);
        }

        const d6 = mod.evaluateContentJudgePromotion({ ...base, description: null }, "MATCH", okReason);
        assertEq(d6.eligible, true, "adm-g6a: null description -> not blocked by content_quality");
        assertEq(d6.contentQualityOk, true, "adm-g6b: null description contentQualityOk=true");
        const d6b = mod.evaluateContentJudgePromotion({ ...base, description: "   " }, "MATCH", okReason);
        assertEq(d6b.contentQualityOk, true, "adm-g6c: blank description contentQualityOk=true");
        const d6c = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", null);
        assertEq(d6c.judgeReasonNavOk, true, "adm-g6d: null judge reason -> judgeReasonNavOk=true");

        // Both new reasons stack with an old one, in a stable order.
        const d7 = mod.evaluateContentJudgePromotion(
          { ...base, confidence: "low", description: navDump },
          "MATCH",
          "Gjenspeiler nøyaktig navigasjonsmeny og overskrifter.",
        );
        assertEq(d7.missing, ["confidence", "content_quality", "judge_reason_nav"], "adm-g7: missing lists old + both new requirements in order");

        // ── Promotion guard 2026-11-11: judge_reason_org ──
        // Prod row 73f9ed8c "Rørosmat Local Food Trail" was would_promote on a
        // MATCH whose reason only described an ORGANISATION (producer
        // cooperative / brand) and nothing a visitor can do.
        for (const [i, reason] of [
          "Rørosmat er et produsentsamvirke/merkevare for lokalmat fra Røros-regionen.",
          "Rørosmat er et produsentsamvirke/merkevare for lokalmat fra Røros-regionen",
          "This is a cooperative brand.",
          "This is a cooperative brand",
          "Rørosmat er en merkevare.",
          "RØROSMAT ER ET SAMVIRKE.",
          "Røros-merkevaren for lokalmat.",
          "Brand of local food; same organisation.",
          "Merkevare for markedsføring av lokalmat.",
          "Rørosmat er en organisasjon og merkevare for lokale produsenter.",
          "Andelslaget er et nettverk av produsenter i regionen.",
          "The page describes the same producer organisation and its brands.",
          "Paraplyorganisasjon for lokalmatprodusenter, samme organisasjonsnummer.",
          "Organisasjon for lokale matprodusenter i Trøndelag.",
          "An organisation of local food producers.",
          "Samvirke for kultur og struktur i bygda.",
        ].entries()) {
          assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation(reason), true, `adm-o1.${i}: org-only reason "${reason}" -> true`);
          const d = mod.evaluateContentJudgePromotion({ ...base, description: null }, "MATCH", reason);
          assertEq(d.judgeReasonOrgOk, false, `adm-o2.${i}: org-only reason "${reason}" -> judgeReasonOrgOk=false`);
          assertEq(d.eligible, false, `adm-o3.${i}: org-only reason "${reason}" -> NOT eligible (held)`);
          assertEq(d.missing, ["judge_reason_org"], `adm-o4.${i}: org-only reason "${reason}" -> missing=['judge_reason_org']`);
        }

        // "No loss of real rows": reasons naming an organisation AND an
        // experience are NOT held.
        for (const [i, reason] of [
          "Samvirket tilbyr guidet gårdsbesøk med smaking.",
          "Organisasjonen arrangerer omvisning i ysteriet.",
          "The cooperative runs guided tasting tours.",
          "Rørosmat er et samvirke som tilbyr matsti gjennom Røros sentrum.",
          "Andelslaget driver kajakkutleie og guidede padleturer på fjorden.",
          "Merkevaren står bak en matopplevelse med lokale råvarer i gamle Røros.",
          "Foreningen arrangerer seiltur med veteranbåten hver søndag.",
          "Turistforeningen tilbyr fjellturer med overnatting på hytta.",
          "Produsentsamvirket holder ostekurs for grupper.",
          "Organisasjonen driver gårdsbutikk med servering av lokal mat.",
          "Bondelagets lokalforening inviterer til åpen gård med aktiviteter for barn.",
          "Samvirket har en sykkeltur mellom gårdene med smaksprøver.",
          "The association organises an annual food festival.",
          "The brand offers a guided farm visit with cheese tasting.",
          "Samme organisasjon; beskrivelsen av fjellturen stemmer med kilden.",
          "Andelslaget arrangerer julemarked og konserter på låven.",
          // Review B1 (lokal#1519): these were held by the first version.
          "Bondens marked-foreningen tilbyr markedsdager på torget.",
          "Andelslaget driver gårdsbutikk.",
          "Foreningen driver museet.",
          "Kunstforeningen har utstilling i galleriet.",
          "Organisasjonen driver restaurant og kafé.",
          "Samvirket driver hotell på gården.",
          "Foreningen tilbyr fiske i elva med fiskekort.",
          "Turistforeningen driver hytta.",
          "Bryggeriet er et andelslag med bryggeripub.",
          "Samvirket har åpent fjøs for barnefamilier.",
          "Teaterforeningen setter opp friluftsspill hver sommer.",
          "Seterforeningen holder seterdrift med melking og ysting om sommeren.",
          "The association runs a museum.",
          "The cooperative runs a farm shop and café.",
          "Same organisation; the boat trip matches the source.",
          "Same association; description matches the hiking trip.",
          // ...and the same experience types next to a NARROW org term.
          "Samvirket arrangerer bondens marked.",
          "The cooperative runs a farmers market.",
          "Merkevaren har egen pub.",
          "Andelslaget driver veterantog på den gamle jernbanen.",
          "Samvirket tilbyr ridning og klatring.",
          "Andelslaget har badstue og sauna ved fjorden.",
          "Samvirket driver dyrepark og bygdetun.",
          "The cooperative offers a day trip by boat.",
        ].entries()) {
          assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation(reason), false, `adm-o5.${i}: org+experience reason "${reason}" -> false`);
          const d = mod.evaluateContentJudgePromotion({ ...base, description: null }, "MATCH", reason);
          assertEq(d.judgeReasonOrgOk, true, `adm-o6.${i}: org+experience reason "${reason}" -> judgeReasonOrgOk=true`);
          assertEq(d.eligible, true, `adm-o7.${i}: org+experience reason "${reason}" -> still eligible`);
        }

        // Plain experience / neutral reasons (no organisation term) are never
        // held; neither are null/empty reasons nor org-number mentions.
        for (const [i, reason] of [
          "Stemmer godt med kilden.",
          "Guidet kajakktur langs fjorden, som beskrevet på siden.",
          "Kilden beskriver en natur- og kulturvandring.",
          "Same provider and same farm shop; consistent with the source.",
          "Samme organisasjonsnummer og navn som kilden.",
          "Gården i Brandbu tilbyr samme produkter.",
          // Review B1 (lokal#1519): bare organisasjon/forening/association is
          // no longer an organisation term — these were held by the first
          // version and are now NOT held.
          "Samme organisasjon som på nettsiden.",
          "Kulturorganisasjon i naturskjønne omgivelser.",
          "Interesseorganisasjon for gårdbrukere i Valdres; samme navn som kilden.",
          "Foreningen jobber for lokal kultur og struktur i bygda.",
          "Same association as on the website.",
          "",
          null,
        ].entries()) {
          assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation(reason), false, `adm-o8.${i}: reason ${JSON.stringify(reason)} -> false`);
          const d = mod.evaluateContentJudgePromotion({ ...base, description: noProse }, "MATCH", reason);
          assertEq(d.judgeReasonOrgOk, true, `adm-o9.${i}: reason ${JSON.stringify(reason)} -> judgeReasonOrgOk=true`);
        }
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation(undefined), false, "adm-o10: undefined reason -> false");

        // "tur"/"kurs" word-boundary pitfalls: natur/kultur/struktur/konkurs
        // are NOT experience words, real compounds are.
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket for natur og kultur."), true, "adm-o11a: natur/kultur do not count as 'tur'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket gikk konkurs."), true, "adm-o11b: konkurs does not count as 'kurs'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket tilbyr turer."), false, "adm-o11c: 'turer' counts as experience");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Andelslaget holder matkurs."), false, "adm-o11d: 'matkurs' counts as experience");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Hildebrand-samvirket."), true, "adm-o11e: org term still detected; 'Hildebrand' is not the word 'brand'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Hildebrand-gården."), false, "adm-o11g: 'Hildebrand' alone is not an organisation term");
        // Marketing words are NOT the experience word "marked"/"market";
        // "strip" is not "trip"; "public" is not "pub".
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket driver markedsføring og markedsfører lokalmat."), true, "adm-o11h: markedsføring/markedsfører are not 'marked'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("A cooperative brand for marketing local food."), true, "adm-o11i: 'marketing' is not 'market'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("The cooperative brand on the comic strip."), true, "adm-o11j: 'strip' is not 'trip'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("A public cooperative brand."), true, "adm-o11k: 'public' is not 'pub'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket har stor markedsandel."), true, "adm-o11l: 'markedsandel' is not 'marked'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Brandbu-gården, samme navn."), false, "adm-o11f: 'Brandbu' is not the word 'brand'");

        // judge_reason_org stacks after the other requirements, in order.
        // (Review r2: judge_reason_org only applies with an EMPTY description,
        // so the stack test uses description "" — and a nav-dump description
        // now no longer adds judge_reason_org.)
        const dOrgStack = mod.evaluateContentJudgePromotion(
          { ...base, confidence: "low", description: "" },
          "MATCH",
          "Navigasjonsmeny for et produsentsamvirke.",
        );
        assertEq(dOrgStack.missing, ["confidence", "judge_reason_nav", "judge_reason_org"], "adm-o12: judge_reason_org listed last after the other requirements");
        const dOrgStackDesc = mod.evaluateContentJudgePromotion(
          { ...base, confidence: "low", description: navDump },
          "MATCH",
          "Navigasjonsmeny for et produsentsamvirke.",
        );
        assertEq(dOrgStackDesc.missing, ["confidence", "content_quality", "judge_reason_nav"], "adm-o12b: non-empty description -> judge_reason_org never added");

        // ── Review r2 (lokal#1519): STRUCTURAL GATE — judge_reason_org only
        // applies when the stored description is empty (null/""/blank).
        const orgOnlyReasons = [
          "Rørosmat er et produsentsamvirke/merkevare for lokalmat fra Røros-regionen",
          "This is a cooperative brand",
          "Rørosmat er en merkevare.",
          "RØROSMAT ER ET SAMVIRKE.",
          "Brand of local food; same organisation.",
        ];
        for (const [i, reason] of orgOnlyReasons.entries()) {
          for (const [j, desc] of [null, "", "   ", "\n\t "].entries()) {
            const d = mod.evaluateContentJudgePromotion({ ...base, description: desc }, "MATCH", reason);
            assertEq(d.missing, ["judge_reason_org"], `adm-r2a.${i}.${j}: empty description ${JSON.stringify(desc)} + org-only reason "${reason}" -> held`);
            assertEq(d.eligible, false, `adm-r2b.${i}.${j}: empty description + org-only reason -> NOT eligible`);
          }
          for (const [j, desc] of ["Kort om gården.", noProse, "x"].entries()) {
            const d = mod.evaluateContentJudgePromotion({ ...base, description: desc }, "MATCH", reason);
            assertEq(d.judgeReasonOrgOk, true, `adm-r2c.${i}.${j}: non-empty description + org-only reason "${reason}" -> judgeReasonOrgOk=true`);
            assertEq(d.eligible, true, `adm-r2d.${i}.${j}: non-empty description + org-only reason -> eligible`);
            assertEq(d.missing, [], `adm-r2e.${i}.${j}: non-empty description -> missing=[]`);
          }
        }

        // Hyphenated / soft-hyphenated org terms are detected.
        for (const [i, reason] of [
          "Andels-laget i bygda.",
          "Merke\u00advare for lokalmat.",
          "Sam-virke for gårdbrukere.",
          "Sam\u2011virket i dalen.",
          "A co-operative brand.",
        ].entries()) {
          assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation(reason), true, `adm-r2f.${i}: hyphenated org term in "${reason}" detected`);
          const d = mod.evaluateContentJudgePromotion({ ...base, description: null }, "MATCH", reason);
          assertEq(d.missing, ["judge_reason_org"], `adm-r2g.${i}: hyphenated org-only reason + empty description -> held`);
        }

        // Reviewer r2 phrasings (empty description) no longer held thanks to
        // the added experience terms.
        for (const [i, reason] of [
          "Samvirket driver sykkelutleie.",
          "Andelslaget leier ut båter.",
          "Samvirket har ysteri-visning for grupper.",
          "Andelslaget driver sjokoladeverksted.",
          "Merkevaren driver gjestegård i dalen.",
          "Samvirket driver pensjonat og vertshus.",
          "Andelslaget har camping og glamping ved sjøen.",
          "Samvirket har merket tursti mellom gårdene.",
          "Andelslaget driver golfbane.",
          "Samvirket tilbyr hundekjøring og kanoturer.",
          "Andelslaget arrangerer jakt på småvilt.",
          "The cooperative runs a guesthouse.",
          "The cooperative offers accommodation and canoe rental.",
          "The brand runs a B&B.",
          "Samvirket driver turløype og turistinformasjon.",
        ].entries()) {
          assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation(reason), false, `adm-r2h.${i}: "${reason}" -> describes an experience`);
          const d = mod.evaluateContentJudgePromotion({ ...base, description: null }, "MATCH", reason);
          assertEq(d.judgeReasonOrgOk, true, `adm-r2i.${i}: "${reason}" + empty description -> not held`);
          assertEq(d.eligible, true, `adm-r2j.${i}: "${reason}" + empty description -> eligible`);
        }
        // "turn..."/"turb..." are not the prefix "tur".
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket har høy turnover."), true, "adm-r2k: 'turnover' is not 'tur'");
        assertEq(mod.contentJudgeReasonOnlyDescribesOrganisation("Samvirket eier en turbin."), true, "adm-r2l: 'turbin' is not 'tur'");
      }

      // ── Promotion guard through the sweep route (dry-run): a needs_review
      // row with a nav-dump description that would otherwise promote is
      // held, and its per-row `promotion` reports content_quality:false.
      {
        insertExperience.run({
          id: "adm-guard-navdump", provider_id: "prov-active-hjemmeside-verified",
          title: "Kajakktur på fjorden", slug: "adm-guard-navdump",
          description: "Hjem | Om oss | Opplevelser | Overnatting | Kontakt | Bestill",
          category: "aktivitet", price_band: "standard", price_from: 600,
          evidence_url: "https://good.no/navdump",
          evidence_url_verification: null, verification_status: "needs_review", confidence: "high", canonical_id: null,
        });
        insertExperience.run({
          id: "adm-guard-navreason", provider_id: "prov-active-hjemmeside-verified",
          title: "Seiltur i skjærgården", slug: "adm-guard-navreason",
          description: "Seiltur i skjærgården med erfaren skipper. Turen varer i tre timer og passer for alle.",
          category: "aktivitet", price_band: "standard", price_from: 700,
          evidence_url: "https://good.no/navreason",
          evidence_url_verification: null, verification_status: "needs_review", confidence: "high", canonical_id: null,
        });
        insertExperience.run({
          id: "adm-guard-summit", provider_id: "prov-active-hjemmeside-verified",
          title: "Guidet fjelltur", slug: "adm-guard-summit",
          description: "Vi tar deg med til toppen av fjellet. Guidet tur til toppen med lokal fjellfører.",
          category: "aktivitet", price_band: "standard", price_from: 900,
          evidence_url: "https://good.no/topptur",
          evidence_url_verification: null, verification_status: "needs_review", confidence: "high", canonical_id: null,
        });
        const rGuard = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        const g = (rGuard.body.results as any[]).find((x) => x.id === "adm-guard-navdump");
        const gReason = (rGuard.body.results as any[]).find((x) => x.id === "adm-guard-navreason");
        assertEq(gReason?.verdict, "MATCH", "adm-g8f: nav-reason row judged MATCH");
        assertEq(gReason?.promotion?.judge_reason_nav, false, "adm-g8g: sweep passes the judge's reason -> promotion.judge_reason_nav=false");
        assertEq(gReason?.promotion?.status, "held", "adm-g8h: nav-reason row held");
        assertEq(gReason?.promotion?.missing, ["judge_reason_nav"], "adm-g8i: nav-reason row missing=['judge_reason_nav']");
        const gSummit = (rGuard.body.results as any[]).find((x) => x.id === "adm-guard-summit");
        assertEq(gSummit?.promotion?.content_quality, true, "adm-g8j: summit-hike description -> promotion.content_quality=true");
        assertEq(gSummit?.promotion?.status, "would_promote", "adm-g8k: summit-hike row would_promote in dry-run (B1)");
        assertEq(g?.verdict, "MATCH", "adm-g8a: guard row judged MATCH");
        assertEq(g?.promotion?.content_quality, false, "adm-g8b: dry-run promotion.content_quality=false for the nav-dump row");
        assertEq(g?.promotion?.judge_reason_nav, true, "adm-g8c: dry-run promotion.judge_reason_nav=true (judge reason clean)");
        assertEq(g?.promotion?.judge_reason_org, true, "adm-g8l: dry-run promotion.judge_reason_org=true (judge reason clean)");
        assertEq(gReason?.promotion?.judge_reason_org, true, "adm-g8m: nav-reason row promotion.judge_reason_org=true (no organisation term)");
        assertEq(g?.promotion?.status, "held", "adm-g8d: nav-dump row held (not would_promote)");
        assertEq(g?.promotion?.missing, ["content_quality"], "adm-g8e: dry-run promotion.missing=['content_quality']");
      }

      // ── 2026-11-10 (vaktutvidelse): dry-run rows carry `title` +
      // `description_preview` (first 200 chars, whitespace-collapsed; null
      // for a null description); apply-mode rows do not.
      {
        const longDesc = ("Gårdsbesøk   med omvisning i fjøset,\n\nsmaksprøver og   historier fra gården. ").repeat(6);
        insertExperience.run({
          id: "adm-preview-long", provider_id: "prov-active-hjemmeside-verified",
          title: "Gårdsbesøk med omvisning", slug: "adm-preview-long",
          description: longDesc,
          category: "aktivitet", price_band: "standard", price_from: 250,
          evidence_url: "https://good.no/preview-long",
          evidence_url_verification: null, verification_status: "verified", confidence: "high", canonical_id: null,
        });
        insertExperience.run({
          id: "adm-preview-null", provider_id: "prov-active-hjemmeside-verified",
          title: "Smaksprøver på gården", slug: "adm-preview-null",
          description: null,
          category: "aktivitet", price_band: "standard", price_from: 150,
          evidence_url: "https://good.no/preview-null",
          evidence_url_verification: null, verification_status: "verified", confidence: "high", canonical_id: null,
        });
        const rPrev = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        assertEq(rPrev.body.dry_run, true, "adm-p1: preview sweep is a dry-run");
        const pLong = (rPrev.body.results as any[]).find((x) => x.id === "adm-preview-long");
        const pNull = (rPrev.body.results as any[]).find((x) => x.id === "adm-preview-null");
        const pShort = (rPrev.body.results as any[]).find((x) => x.id === "adm-promote-hjemmeside");
        const expectedLong = longDesc.replace(/\s+/g, " ").trim().slice(0, 200);
        assertEq(pLong?.title, "Gårdsbesøk med omvisning", "adm-p2: dry-run row carries title");
        assertEq(pLong?.description_preview, expectedLong, "adm-p3: long description -> whitespace-collapsed first 200 chars");
        assertEq(pLong?.description_preview?.length, 200, "adm-p4: long description preview truncated to exactly 200 chars");
        assertTrue(longDesc.length > 200, "adm-p4b: fixture description is genuinely longer than 200 chars");
        assertEq(pNull?.title, "Smaksprøver på gården", "adm-p5: null-description row still carries title");
        assertEq(pNull?.description_preview, null, "adm-p6: null description -> description_preview=null");
        assertEq(pShort?.description_preview, "Kort om fjordturen.", "adm-p7: short description -> preview is the full (≤200 chars) text");
        assertTrue((rPrev.body.results as any[]).every((x) => "title" in x && "description_preview" in x), "adm-p8: every dry-run row has title + description_preview");

        const rApply = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        assertEq(rApply.body.dry_run, false, "adm-p9: apply sweep is not a dry-run");
        const aLong = (rApply.body.results as any[]).find((x) => x.id === "adm-preview-long");
        assertTrue(aLong !== undefined, "adm-p10: apply-mode results include the preview row");
        assertTrue(!("title" in aLong) && !("description_preview" in aLong), "adm-p11: apply-mode row carries neither title nor description_preview");
        assertTrue((rApply.body.results as any[]).every((x) => !("title" in x) && !("description_preview" in x)), "adm-p12: no apply-mode row carries title/description_preview");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-admission-promotion: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-admission-promotion.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesAdmissionPromotionTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

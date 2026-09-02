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
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, hjemmeside, brreg_active, field_provenance)
         VALUES (@id, @navn, @hjemmeside, @brreg_active, @field_provenance)`,
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
      for (const p of cachePaths) delete require.cache[p];
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

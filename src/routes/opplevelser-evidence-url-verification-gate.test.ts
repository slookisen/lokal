/**
 * opplevelser-evidence-url-verification-gate.test.ts — tests for dev-request
 * 2026-08-24-evidence-url-verifisering-gate.
 *
 * PROBLEM this closes: content-refresh/gardssalg-content-refresh fetch and
 * verify `hjemmeside` (the provider's own website) before a row is enriched
 * — a real, coded gate (isHjemmesideVerified(), field_provenance.
 * hjemmeside_verification). But `evidence_url` — the field meant to
 * substantiate that a specific experience/supplier actually exists/is
 * accurate — was NEVER independently fetched or checked by anything
 * downstream: not by content-refresh, not by any sweep, not by
 * GET /admin/providers/recently-enriched's spot-check basis. A row could
 * therefore pass normal hjemmeside-based enrichment forever while keeping
 * an evidence_url nothing ever actually fetched.
 *
 * THE FIX mirrors the hjemmeside gate's exact shape for the evidence_url
 * field:
 *   - isEvidenceUrlVerified()/deriveEvidenceUrlStatus() (routes/opplevelser
 *     .ts) — the fail-closed read side, same contract as isHjemmesideVerified
 *     but reading experiences.evidence_url_verification (NEW, additive
 *     column — init-experiences.ts) instead of field_provenance.
 *   - POST /admin/evidence-url-verification-sweep — the fetch+evidence-match
 *     write side (gardssalgWebsiteEvidenceMatch reused unchanged, same
 *     fetch-integrity/contamination-retry pattern as tryGardssalgCandidateHosts).
 *   - GET /admin/providers/recently-enriched now exposes the derived status
 *     as `evidence_url_status` on each enriched_experiences[] row.
 *
 * Covers:
 *   (a) AC1 — a row whose evidence_url was never fetched stays marked
 *       "evidence_url_unverified" after an ORDINARY content-refresh run
 *       (which fetches+verifies hjemmeside and successfully enriches the
 *       row) — content-refresh never touches evidence_url_verification at
 *       all, and never fetches the evidence_url host.
 *   (b) isEvidenceUrlVerified()/deriveEvidenceUrlStatus() unit coverage,
 *       INCLUDING the explicit negative control: `verified: "true"` (a
 *       truthy string, not boolean true) must NOT verify — proves the
 *       strict `=== true` comparison is actually wired in, the same
 *       discipline isHjemmesideVerified's own tests rely on.
 *   (c) AC2 — POST /admin/evidence-url-verification-sweep actually fetches
 *       evidence_url and stamps verified:true on a real name/org_nr match,
 *       and NEVER touches the `evidence_url` column itself.
 *   (d) AC2 negative — a fetched page with no matching evidence stays
 *       unverified (classification/reason observable), evidence_url column
 *       still untouched.
 *   (e) AC2 fetch-integrity — a fetch failure classifies unverified/
 *       fetch_failed; a self-reference-marker miss on BOTH the original
 *       fetch AND the one retry classifies unverified/fetch_contaminated
 *       (exactly 2 fetch attempts, never a retry loop); a miss on the
 *       FIRST fetch that recovers on the retry ends up verified (the retry
 *       content is what gets evidence-matched, not the first).
 *   (f) AC2 — an aggregator/directory host (visitnorway.com) is never
 *       fetched at all; classifies unverified/aggregator_host.
 *   (g) AC3 — GET /admin/providers/recently-enriched exposes
 *       `evidence_url_status` per enriched_experiences[] row: "verified"
 *       when independently confirmed, "evidence_url_unverified" when not,
 *       and the key is ABSENT entirely on a row with no evidence_url set at
 *       all ("not applicable" is a different claim than "unverified").
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
    query?: Record<string, string>;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const query = opts.query || {};
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const path = opts.url || "/admin/content-refresh";
    const url = path + qs;
    const req: any = {
      method,
      url,
      originalUrl: url,
      path,
      query,
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

function mkResp(ok: boolean, html: string, url: string): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    url,
    text: async () => html,
    headers: { get: () => null },
  } as unknown as Response;
}

export function runOpplevelserEvidenceUrlVerificationGateTests(
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "evidence-url-verification-gate-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser") & { default: any };
      const opplevelserRouter = opplevelserModule.default;
      const { isEvidenceUrlVerified, deriveEvidenceUrlStatus } = opplevelserModule;

      // ══════════════════════════════════════════════════════════════════
      // (b) isEvidenceUrlVerified() / deriveEvidenceUrlStatus() — pure unit
      // coverage, including the explicit negative control.
      // ══════════════════════════════════════════════════════════════════
      assertEq(isEvidenceUrlVerified(null), false, "unit-b1: null -> false");
      assertEq(isEvidenceUrlVerified(""), false, "unit-b2: empty string -> false");
      assertEq(isEvidenceUrlVerified("{not valid json"), false, "unit-b3: malformed JSON -> false (fail-closed)");
      assertEq(
        isEvidenceUrlVerified(JSON.stringify({ classification: "verified" })),
        false,
        "unit-b4: verified key entirely absent -> false",
      );
      assertEq(
        isEvidenceUrlVerified(JSON.stringify({ verified: true, classification: "verified" })),
        true,
        "unit-b5: verified:true (boolean) -> true — positive control",
      );
      // THE EXPLICIT NEGATIVE TEST (mirrors this codebase's own discipline —
      // see gardssalgWebsiteEvidenceMatch's "Strict boolean comparison"
      // doc comment): a truthy STRING "true" must NOT verify. If the
      // implementation were ever weakened from `entry.verified === true` to
      // a bare truthy check (`if (entry.verified)`), this assertion is the
      // one that would catch it.
      assertEq(
        isEvidenceUrlVerified(JSON.stringify({ verified: "true", classification: "verified" })),
        false,
        "unit-b6 NEGATIVE CONTROL: verified:\"true\" (string, not boolean) -> false — proves strict === true, not a truthy check",
      );
      assertEq(
        isEvidenceUrlVerified(JSON.stringify({ verified: 1, classification: "verified" })),
        false,
        "unit-b7 NEGATIVE CONTROL: verified:1 (number, not boolean) -> false",
      );
      assertEq(deriveEvidenceUrlStatus(null, null), null, "unit-b8: no evidence_url at all -> null (not applicable, not 'unverified')");
      assertEq(deriveEvidenceUrlStatus("", null), null, "unit-b9: blank evidence_url -> null");
      assertEq(
        deriveEvidenceUrlStatus("https://x.example/proof", null),
        "evidence_url_unverified",
        "unit-b10: evidence_url set, never checked -> 'evidence_url_unverified'",
      );
      assertEq(
        deriveEvidenceUrlStatus("https://x.example/proof", JSON.stringify({ verified: true, classification: "verified" })),
        "verified",
        "unit-b11: evidence_url set + verified:true stamp -> 'verified'",
      );
      assertEq(
        deriveEvidenceUrlStatus("https://x.example/proof", JSON.stringify({ verified: false, classification: "unverified" })),
        "evidence_url_unverified",
        "unit-b12: evidence_url set + explicit verified:false stamp -> stays 'evidence_url_unverified'",
      );

      // ══════════════════════════════════════════════════════════════════
      // (a) AC1 — an ORDINARY content-refresh run (hjemmeside verified,
      // fetch succeeds, description IS written) must NEVER silently treat
      // evidence_url as verified just because hjemmeside passed. Mirrors
      // seedProvider() from opplevelser-content-refresh-website-
      // verification-gate.test.ts.
      // ══════════════════════════════════════════════════════════════════
      const HJEMMESIDE_VERIFIED_STAMP = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const ac1ProviderId = store.createProvider({
        navn: "AC1 Gard AS", org_nr: "900100100",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://ac1-hjemmeside.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(HJEMMESIDE_VERIFIED_STAMP, ac1ProviderId);
      const ac1ExperienceId = store.createExperience({
        title: "AC1 Gard opplevelse", provider_id: ac1ProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://ac1-evidence-never-fetched.example/proof",
      });

      const AC1_ABOUT_TEXT =
        "Vi driver et koselig gårdsutsalg med egne grønnsaker, bær og syltetøy rett fra tunet hver helg om sommeren.";
      const ac1Html = `<html><head><meta property="og:description" content="${AC1_ABOUT_TEXT}"></head><body></body></html>`;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "ac1-hjemmeside.example") {
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new TextEncoder().encode(ac1Html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        // AC1's whole point: content-refresh must NEVER reach the
        // evidence_url host at all — a fetch attempt against it is itself a
        // test failure, not just a wrong classification.
        throw new Error(`AC1: content-refresh must NEVER fetch host "${host}" (evidence_url is not its job)`);
      }) as typeof fetch;

      const ac1Result = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: [ac1ProviderId], apply: true },
      });
      assertEq(ac1Result.status, 200, "ac1-1: content-refresh call -> 200");
      assertTrue(
        Array.isArray(ac1Result.body.changed) && ac1Result.body.changed.some((c: any) => c.provider_id === ac1ProviderId),
        "ac1-2: sanity — the provider genuinely enriched this run (hjemmeside gate passed, content written)",
      );
      const ac1Row = db
        .prepare("SELECT description, evidence_url, evidence_url_verification FROM experiences WHERE id = ?")
        .get(ac1ExperienceId) as { description: string | null; evidence_url: string | null; evidence_url_verification: string | null };
      assertEq(ac1Row.description, AC1_ABOUT_TEXT, "ac1-3: sanity — description WAS actually written by this run");
      assertEq(ac1Row.evidence_url_verification, null, "ac1-4: THE FIX — evidence_url_verification untouched by content-refresh (still null)");
      assertEq(
        deriveEvidenceUrlStatus(ac1Row.evidence_url, ac1Row.evidence_url_verification),
        "evidence_url_unverified",
        "ac1-5: THE FIX — derived status is 'evidence_url_unverified', NEVER silently 'verified' just because hjemmeside passed",
      );

      // ══════════════════════════════════════════════════════════════════
      // (c)-(f) AC2 — POST /admin/evidence-url-verification-sweep. One
      // shared provider (org_nr-bearing) whose several experiences each
      // carry a DIFFERENT evidence_url exercising one branch each. Own
      // fetch mock, call-counted per host.
      // ══════════════════════════════════════════════════════════════════
      const sweepProviderId = store.createProvider({
        navn: "Sweep Gard AS", org_nr: "912345678",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://sweep-gard.example", // never fetched by this route
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      const expVerified = store.createExperience({
        title: "Sweep verified experience", provider_id: sweepProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://evidence-verified.example/proof",
      });
      const expMismatch = store.createExperience({
        title: "Sweep mismatch experience", provider_id: sweepProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://evidence-mismatch.example/proof",
      });
      const expUnreachable = store.createExperience({
        title: "Sweep unreachable experience", provider_id: sweepProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://evidence-unreachable.example/proof",
      });
      const expContaminated = store.createExperience({
        title: "Sweep contaminated experience", provider_id: sweepProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://evidence-contaminated.example/proof",
      });
      const expRecovers = store.createExperience({
        title: "Sweep recovers-on-retry experience", provider_id: sweepProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://evidence-recovers.example/proof",
      });
      const expAggregator = store.createExperience({
        title: "Sweep aggregator experience", provider_id: sweepProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://visitnorway.com/some-listing",
      });

      const VERIFIED_HTML =
        `<html><head><link rel="canonical" href="https://evidence-verified.example/proof">` +
        `<title>Sweep Gard</title></head><body><p>Org.nr 912 345 678</p></body></html>`;
      const MISMATCH_HTML =
        `<html><head><link rel="canonical" href="https://evidence-mismatch.example/proof">` +
        `<title>Noe helt annet</title></head><body><p>Vi selger epler og bær, ingen tilknytning her.</p></body></html>`;
      // Deliberately mentions NEITHER its own host label NOR any of the
      // provider's evidence fields — this is what a proxy/cache returning a
      // completely different site's HTML looks like.
      const UNRELATED_HTML = `<html><body><p>Completely unrelated third-party page content.</p></body></html>`;

      const fetchCallsByHost: Record<string, number> = {};
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = new URL(String(url));
        const host = u.hostname;
        fetchCallsByHost[host] = (fetchCallsByHost[host] || 0) + 1;
        const n = fetchCallsByHost[host];
        if (host === "evidence-verified.example") return mkResp(true, VERIFIED_HTML, String(url));
        if (host === "evidence-mismatch.example") return mkResp(true, MISMATCH_HTML, String(url));
        if (host === "evidence-unreachable.example") return mkResp(false, "", String(url));
        if (host === "evidence-contaminated.example") return mkResp(true, UNRELATED_HTML, String(url));
        if (host === "evidence-recovers.example") {
          return n === 1
            ? mkResp(true, UNRELATED_HTML, String(url))
            : mkResp(true, VERIFIED_HTML.replace("evidence-verified.example", "evidence-recovers.example"), String(url));
        }
        // (f): visitnorway.com must NEVER be reached — the aggregator check
        // happens before any fetch.
        throw new Error(`AC2 sweep test: fetch must NOT be called for host "${host}"`);
      }) as typeof fetch;

      const sweepRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        url: "/admin/evidence-url-verification-sweep",
        body: {
          experienceIds: [expVerified, expMismatch, expUnreachable, expContaminated, expRecovers, expAggregator],
          apply: true,
        },
      });
      assertEq(sweepRes.status, 200, "sweep-1: sweep call -> 200");
      assertEq(sweepRes.body.scanned, 6, "sweep-2: all 6 explicit ids scanned");

      const byId = new Map<string, any>((sweepRes.body.results as any[]).map((r) => [r.experience_id, r]));

      // (c) verified
      assertEq(byId.get(expVerified)?.classification, "verified", "sweep-c1: real org_nr match -> classification 'verified'");
      const verifiedRow = db
        .prepare("SELECT evidence_url, evidence_url_verification FROM experiences WHERE id = ?")
        .get(expVerified) as { evidence_url: string; evidence_url_verification: string | null };
      assertEq(verifiedRow.evidence_url, "https://evidence-verified.example/proof", "sweep-c2: evidence_url column ITSELF untouched (still the original value)");
      assertEq(isEvidenceUrlVerified(verifiedRow.evidence_url_verification), true, "sweep-c3: evidence_url_verification stamp reads verified via isEvidenceUrlVerified()");
      assertEq(deriveEvidenceUrlStatus(verifiedRow.evidence_url, verifiedRow.evidence_url_verification), "verified", "sweep-c4: derived status 'verified'");

      // (d) mismatch -> stays unverified
      assertEq(byId.get(expMismatch)?.classification, "unverified", "sweep-d1: no evidence in fetched content -> 'unverified'");
      assertEq(byId.get(expMismatch)?.reason, "evidence_mismatch", "sweep-d2: reason is 'evidence_mismatch'");
      const mismatchRow = db
        .prepare("SELECT evidence_url, evidence_url_verification FROM experiences WHERE id = ?")
        .get(expMismatch) as { evidence_url: string; evidence_url_verification: string | null };
      assertEq(mismatchRow.evidence_url, "https://evidence-mismatch.example/proof", "sweep-d3: evidence_url column untouched on a mismatch too");
      assertEq(deriveEvidenceUrlStatus(mismatchRow.evidence_url, mismatchRow.evidence_url_verification), "evidence_url_unverified", "sweep-d4: derived status stays 'evidence_url_unverified'");

      // (e) fetch failure
      assertEq(byId.get(expUnreachable)?.classification, "unverified", "sweep-e1: fetch failure -> 'unverified'");
      assertEq(byId.get(expUnreachable)?.reason, "fetch_failed", "sweep-e2: reason 'fetch_failed'");

      // (e) contamination — miss on BOTH the original fetch and the one
      // retry -> fetch_contaminated, exactly 2 attempts (never a retry loop).
      assertEq(byId.get(expContaminated)?.classification, "unverified", "sweep-e3: self-reference marker missing on both attempts -> 'unverified'");
      assertEq(byId.get(expContaminated)?.reason, "fetch_contaminated", "sweep-e4: reason 'fetch_contaminated'");
      assertEq(fetchCallsByHost["evidence-contaminated.example"], 2, "sweep-e5: exactly ONE retry (2 total fetch attempts), never a retry loop");

      // (e) contamination recovers on the retry -> the RETRY's content is
      // what gets evidence-matched, and it verifies.
      assertEq(byId.get(expRecovers)?.classification, "verified", "sweep-e6: marker missing on 1st fetch, present + evidence matches on the retry -> 'verified'");
      assertEq(fetchCallsByHost["evidence-recovers.example"], 2, "sweep-e7: exactly 2 fetch attempts (1 original + 1 retry) on the recovery path too");

      // (f) aggregator host — never fetched at all (mock throws if it is).
      assertEq(byId.get(expAggregator)?.classification, "unverified", "sweep-f1: aggregator host -> 'unverified'");
      assertEq(byId.get(expAggregator)?.reason, "aggregator_host", "sweep-f2: reason 'aggregator_host'");
      assertEq(fetchCallsByHost["visitnorway.com"], undefined, "sweep-f3: visitnorway.com was NEVER fetched — no entry in the per-host call tally");

      // ══════════════════════════════════════════════════════════════════
      // (g) AC3 — GET /admin/providers/recently-enriched exposes
      // evidence_url_status per enriched_experiences[] row.
      // ══════════════════════════════════════════════════════════════════
      const ac3ProviderId = store.createProvider({
        navn: "AC3 Gard AS", org_nr: "900300300",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://ac3-gard.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET last_enriched_at = datetime('now') WHERE id = ?").run(ac3ProviderId);

      // NOTE: description and evidence_url are deliberately set via a
      // follow-up raw UPDATE, NOT together in the createExperience() call —
      // createExperience() auto-stamps content_field_evidence.description =
      // harvestProvenanceOf(evidence_url) whenever BOTH are passed together
      // at insert time (its own new-row provenance discipline, see that
      // function's doc comment), which would make the route's UNRELATED
      // per-field homepage-provenance screen blank/drop this row (evidence_
      // url's host != the provider's hjemmeside host) — a fixture artifact
      // that has nothing to do with what THIS test is proving.
      const ac3Verified = store.createExperience({
        title: "AC3 verified evidence experience", provider_id: ac3ProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        content_source: "provider_site", enrichment_state: "enriched",
      });
      db.prepare(
        "UPDATE experiences SET description = ?, evidence_url = ?, evidence_url_verification = ? WHERE id = ?"
      ).run(
        "En fin opplevelse.",
        "https://ac3-evidence-verified.example/proof",
        JSON.stringify({ verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" }),
        ac3Verified,
      );

      const ac3Unverified = store.createExperience({
        title: "AC3 unverified evidence experience", provider_id: ac3ProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        content_source: "provider_site", enrichment_state: "enriched",
      });
      db.prepare(
        "UPDATE experiences SET description = ?, evidence_url = ? WHERE id = ?"
      ).run("En annen fin opplevelse.", "https://ac3-evidence-never-checked.example/proof", ac3Unverified);

      const ac3NoEvidence = store.createExperience({
        title: "AC3 no evidence_url at all", provider_id: ac3ProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        content_source: "provider_site", enrichment_state: "enriched",
      });
      db.prepare("UPDATE experiences SET description = ? WHERE id = ?").run("Tredje opplevelse.", ac3NoEvidence);

      const ac3Res = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/providers/recently-enriched",
        headers: { "x-admin-key": testKey },
        query: { limit: "10" },
      });
      assertEq(ac3Res.status, 200, "ac3-1: recently-enriched call -> 200");
      const ac3Provider = (ac3Res.body.providers as any[]).find((p) => p.id === ac3ProviderId);
      assertTrue(!!ac3Provider, "ac3-2: sanity — the seeded provider appears in the response");
      const ac3Exps = new Map<string, any>((ac3Provider?.enriched_experiences ?? []).map((e: any) => [e.id, e]));

      assertEq(ac3Exps.get(ac3Verified)?.evidence_url_status, "verified", "ac3-3: independently-confirmed row exposes evidence_url_status:'verified'");
      assertEq(ac3Exps.get(ac3Unverified)?.evidence_url_status, "evidence_url_unverified", "ac3-4: never-checked row exposes evidence_url_status:'evidence_url_unverified'");
      assertTrue(
        !Object.prototype.hasOwnProperty.call(ac3Exps.get(ac3NoEvidence) ?? {}, "evidence_url_status"),
        "ac3-5: a row with NO evidence_url at all carries no evidence_url_status key (absent, not null/false — 'not applicable' is a different claim)",
      );
      // The raw provenance JSON is an internal representation, not part of
      // the public response — same convention as content_field_evidence
      // just above it in the route.
      assertTrue(
        !Object.prototype.hasOwnProperty.call(ac3Exps.get(ac3Verified) ?? {}, "evidence_url_verification"),
        "ac3-6: the raw evidence_url_verification JSON is never leaked into the response",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-evidence-url-verification-gate: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-evidence-url-verification-gate.test.ts`
if (require.main === module) {
  runOpplevelserEvidenceUrlVerificationGateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

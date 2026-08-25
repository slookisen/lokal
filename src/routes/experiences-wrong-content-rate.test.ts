/**
 * experiences-wrong-content-rate.test.ts — tests for dev-request
 * 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene, item 5
 * ("wrong_content_rate holdout"), slice claimed 2026-08-07T05:56Z:
 *
 *   - src/services/experience-content-judge.ts's judgeExperienceContentMatch()
 *     fail-closed contract (mirrors judgeGardssalgAboutCandidate's, but
 *     surfaced through a discriminated-union {ok:false} sentinel so the
 *     route can distinguish "judge failed" from "judge said MISMATCH" —
 *     see that module's header comment for why).
 *   - POST /api/opplevelser/admin/experiences-wrong-content-rate
 *     (src/routes/opplevelser.ts): requireAdmin gate, rate math (incl. the
 *     0-denominator → null case), fetchPage-failure rows landing in
 *     `unresolved` (never silently counted as matched), and sample_size
 *     cap enforcement (>100 clamps to 100).
 *
 * Same conventions as opplevelser-listing-homepage-discovery.test.ts: an
 * in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:"), fresh requires
 * per run, router.handle() as the HTTP entry point, and a mocked
 * globalThis.fetch keyed on URL — no live network/API calls anywhere in
 * this file.
 */

import {
  judgeExperienceContentMatch,
  sampleEnrichedExperiencesForHoldout,
  resolveHoldoutEvidenceUrl,
  type HoldoutExperienceRow,
} from "../services/experience-content-judge";

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
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = "/admin/experiences-wrong-content-rate";
    const req: any = {
      method: "POST",
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

/** Builds a fetchPage()-compatible Response stub (arrayBuffer + headers.get,
 * not .text() — fetchPage decodes the raw body itself, unlike some of this
 * file's older local fetch helpers). */
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

const ROW_BASE: HoldoutExperienceRow = {
  id: "row-1",
  title: "Fjelltur med guide",
  description: "En guidet fjelltur i vakker natur.",
  category: "aktivitet",
  price_band: "standard",
  price_from: 500,
  evidence_url: "https://provider.no/fjelltur",
  content_field_evidence: null,
};

export function runExperiencesWrongContentRateTests(log = false): Promise<TestSummary> {
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
    const prevFetch = globalThis.fetch;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

    try {
      // ═══════════════════════════════════════════════════════════════════
      // (a) judgeExperienceContentMatch — fail-closed contract, direct unit
      //     tests against the service module (no HTTP layer involved).
      // ═══════════════════════════════════════════════════════════════════

      // ── jc-1: missing ANTHROPIC_API_KEY → ok:false, fetch never invoked. ──
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("jc-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "Fjelltur med guide i vakker natur.");
        assertEq(r.ok, false, "jc-1: missing ANTHROPIC_API_KEY -> ok:false (fail-closed)");
        if (!r.ok) assertTrue(r.reasoning.length > 0, "jc-1b: reasoning string present");
      }

      process.env.ANTHROPIC_API_KEY = "test-wcr-judge-key";

      // ── jc-2: mocked 200 MATCH response -> ok:true, verdict MATCH, request
      //    carries the exact Anthropic contract. ────────────────────────────
      let capturedUrl: any = null;
      let capturedInit: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return mkAnthropicResponse("MATCH\nInnholdet stemmer med kildesiden.");
      }) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "Fjelltur med guide i vakker natur.");
        assertEq(r.ok, true, "jc-2a: mocked MATCH response -> ok:true");
        if (r.ok) assertEq(r.verdict, "MATCH", "jc-2b: verdict is MATCH");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "jc-2c: calls the exact Anthropic messages endpoint");
        const reqBody = JSON.parse(capturedInit.body);
        assertEq(reqBody.model, "claude-haiku-4-5", "jc-2d: model is claude-haiku-4-5");
        assertTrue(typeof reqBody.messages?.[0]?.content === "string" && reqBody.messages[0].content.includes(ROW_BASE.title), "jc-2e: prompt includes the row title");
        assertEq(capturedInit.headers["x-api-key"], "test-wcr-judge-key", "jc-2f: x-api-key header carries ANTHROPIC_API_KEY");
      }

      // ── jc-3: mocked 200 MISMATCH response -> ok:true, verdict MISMATCH. ──
      globalThis.fetch = (async () =>
        mkAnthropicResponse("MISMATCH\nSiden handler om en helt annen aktivitet.")) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "Dette er en helt annen side om fisking.");
        assertEq(r.ok, true, "jc-3a: mocked MISMATCH response -> ok:true");
        if (r.ok) {
          assertEq(r.verdict, "MISMATCH", "jc-3b: verdict is MISMATCH");
          assertTrue(r.reasoning.includes("annen aktivitet"), "jc-3c: reasoning carried through");
        }
      }

      // ── jc-4: network throw -> ok:false, never re-thrown. ─────────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-4: fetch throw (network failure) -> ok:false, not re-thrown");
      }

      // ── jc-5: non-200 response -> ok:false. ───────────────────────────────
      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-5: non-200 response -> ok:false");
      }

      // ── jc-6: unparseable JSON body -> ok:false. ──────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      })) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-6: unparseable JSON response body -> ok:false");
      }

      // ── jc-7: non-array content field (defensive) -> ok:false, no throw. ──
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-7: non-array content field -> ok:false, not a thrown TypeError");
      }

      // ── jc-8: ambiguous/garbage verdict text -> ok:false, never a silent
      //    approval on ambiguity. ────────────────────────────────────────────
      globalThis.fetch = (async () =>
        mkAnthropicResponse("Dette virker greit, kanskje et treff.")) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-8: ambiguous verdict text -> ok:false, fail-closed");
      }

      // ── jc-9: empty response text -> ok:false. ────────────────────────────
      globalThis.fetch = (async () => mkAnthropicResponse("   ")) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-9: empty/whitespace-only response text -> ok:false");
      }

      // ── jc-10: verdict token embedded mid-sentence (not the exact
      //    first-line token) does NOT resolve -> ok:false. ──────────────────
      globalThis.fetch = (async () =>
        mkAnthropicResponse("Jeg tror kanskje MATCH er riktig her, men usikker.")) as unknown as typeof fetch;
      {
        const r = await judgeExperienceContentMatch(ROW_BASE, "tekst");
        assertEq(r.ok, false, "jc-10: verdict token embedded mid-sentence -> ok:false, fail-closed");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) sampleEnrichedExperiencesForHoldout — pure DB read, direct unit
      //     test (own in-memory better-sqlite3 handle, no route involved).
      // ═══════════════════════════════════════════════════════════════════
      {
        const Database = require("better-sqlite3") as typeof import("better-sqlite3");
        const db = new Database(":memory:");
        db.exec(`
          CREATE TABLE experiences (
            id TEXT PRIMARY KEY,
            title TEXT,
            description TEXT,
            category TEXT,
            price_band TEXT,
            price_from INTEGER,
            evidence_url TEXT,
            content_field_evidence TEXT,
            enrichment_state TEXT,
            content_source TEXT,
            updated_at TEXT
          );
        `);
        const insert = db.prepare(
          `INSERT INTO experiences (id, title, description, category, price_band, price_from, evidence_url, content_field_evidence, enrichment_state, content_source, updated_at)
           VALUES (@id, @title, @description, @category, @price_band, @price_from, @evidence_url, @content_field_evidence, @enrichment_state, @content_source, @updated_at)`,
        );
        insert.run({ id: "e-eligible-1", title: "A", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://a.no", content_field_evidence: null, enrichment_state: "enriched", content_source: "provider_site", updated_at: "2026-08-01" });
        insert.run({ id: "e-eligible-2", title: "B", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://b.no", content_field_evidence: null, enrichment_state: "enriched", content_source: "provider_site", updated_at: "2026-08-02" });
        // Not eligible: wrong enrichment_state.
        insert.run({ id: "e-not-enriched", title: "C", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://c.no", content_field_evidence: null, enrichment_state: "matched", content_source: "provider_site", updated_at: "2026-08-01" });
        // Not eligible: wrong content_source.
        insert.run({ id: "e-not-provider-site", title: "D", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://d.no", content_field_evidence: null, enrichment_state: "enriched", content_source: "manual", updated_at: "2026-08-01" });
        // Not eligible: no evidence_url AND no per-field evidence -> nothing
        // genuinely checkable, resolveHoldoutEvidenceUrl() returns null.
        insert.run({ id: "e-no-evidence", title: "E", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: null, content_field_evidence: null, enrichment_state: "enriched", content_source: "provider_site", updated_at: "2026-08-01" });
        // Eligible: no legacy evidence_url, but content_field_evidence carries
        // a genuine per-field URL — resolveHoldoutEvidenceUrl() must still
        // resolve this row (root-cause fix: content_field_evidence is the
        // trustworthy citation, evidence_url is not required for eligibility).
        insert.run({ id: "e-eligible-3-field-evidence-only", title: "F", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: null, content_field_evidence: JSON.stringify({ description: "https://f.no/real-page" }), enrichment_state: "enriched", content_source: "provider_site", updated_at: "2026-08-03" });
        // Not eligible: content_field_evidence exists but only carries the
        // harvest-no-evidence-url sentinel for the judged fields, and there is
        // no legacy evidence_url either -> still nothing genuinely checkable.
        insert.run({ id: "e-sentinel-only", title: "G", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: null, content_field_evidence: JSON.stringify({ description: "harvest:no-evidence-url" }), enrichment_state: "enriched", content_source: "provider_site", updated_at: "2026-08-01" });

        const sampled = sampleEnrichedExperiencesForHoldout(db as any, 10);
        assertEq(sampled.length, 3, "se-1: only the 3 genuinely-eligible rows are sampled");
        const sampledIds = sampled.map((r) => r.id).sort();
        assertEq(sampledIds, ["e-eligible-1", "e-eligible-2", "e-eligible-3-field-evidence-only"], "se-2: exactly the eligible rows, ineligible ones excluded (including the sentinel-only and no-evidence-at-all rows)");

        const sampledSmall = sampleEnrichedExperiencesForHoldout(db as any, 1);
        assertEq(sampledSmall.length, 1, "se-3: n=1 returns exactly 1 row from a larger eligible pool");

        const sampledZero = sampleEnrichedExperiencesForHoldout(db as any, 0);
        assertEq(sampledZero.length, 0, "se-4: n=0 returns an empty array, no query-limit edge case crash");

        db.close();
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b2) resolveHoldoutEvidenceUrl — root-cause regression (2026-08-25,
      //      wrong_content_rate 0.25): the stale, DISCOVERY-time `evidence_url`
      //      column must NEVER be preferred over a genuine per-field
      //      `content_field_evidence` citation, even though both are present.
      // ═══════════════════════════════════════════════════════════════════
      {
        // rh-1: content_field_evidence.description is a real URL that DIFFERS
        // from evidence_url -> the per-field URL wins (this is the exact
        // Ringve/Røros-shaped bug: a row's evidence_url points at the
        // ORIGINAL discovery page, while the ACTUAL homepage the description
        // was enriched from is recorded per-field).
        const drifted: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: "https://stale-discovery-listing.no/original-find",
          content_field_evidence: JSON.stringify({ description: "https://real-provider-homepage.no/" }),
        };
        assertEq(
          resolveHoldoutEvidenceUrl(drifted),
          "https://real-provider-homepage.no/",
          "rh-1: per-field content_field_evidence.description wins over a differing legacy evidence_url"
        );

        // rh-2: category carries the real citation when description doesn't.
        const categoryOnly: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: "https://stale.no/",
          content_field_evidence: JSON.stringify({ category: "https://real.no/category-source" }),
        };
        assertEq(
          resolveHoldoutEvidenceUrl(categoryOnly),
          "https://real.no/category-source",
          "rh-2: falls through to category's per-field URL when description has none"
        );

        // rh-3: only the harvest-sentinel is recorded (a re-harvest candidate
        // with no evidence_url of its own) -> not a real URL, falls back to
        // the legacy evidence_url rather than trying to fetch the sentinel.
        const sentinelOnly: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: "https://legacy-fallback.no/",
          content_field_evidence: JSON.stringify({ description: "harvest:no-evidence-url" }),
        };
        assertEq(
          resolveHoldoutEvidenceUrl(sentinelOnly),
          "https://legacy-fallback.no/",
          "rh-3: a sentinel-only per-field entry is skipped, legacy evidence_url used as last resort"
        );

        // rh-4: no per-field evidence at all -> legacy evidence_url (older
        // rows written before content_field_evidence existed keep working).
        const noFieldEvidence: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: "https://legacy-only.no/",
          content_field_evidence: null,
        };
        assertEq(
          resolveHoldoutEvidenceUrl(noFieldEvidence),
          "https://legacy-only.no/",
          "rh-4: content_field_evidence absent entirely -> falls back to evidence_url"
        );

        // rh-5: neither a usable per-field URL nor a legacy evidence_url ->
        // null, never a fabricated comparison.
        const nothingUsable: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: null,
          content_field_evidence: JSON.stringify({ description: "unknown:blank-source-url" }),
        };
        assertEq(
          resolveHoldoutEvidenceUrl(nothingUsable),
          null,
          "rh-5: no genuine citation anywhere -> null, never fabricates a URL to check against"
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c) POST /admin/experiences-wrong-content-rate — route-level tests:
      //     auth gate, rate math (incl. 0-denominator -> null), fetchPage
      //     failures landing in `unresolved` (never `matched`), sample_size
      //     cap enforcement.
      // ═══════════════════════════════════════════════════════════════════
      const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
      const prevAdminKey = process.env.ADMIN_KEY;
      const testKey = process.env.ADMIN_KEY || "wcr-test-admin-key";
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      process.env.ADMIN_KEY = testKey;

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
        const oppl = require("./opplevelser") as typeof import("./opplevelser");
        const opplevelserRouter = oppl.default as any;
        const adminHeaders = { "x-admin-key": testKey };

        const insertExperience = expDb.prepare(
          `INSERT INTO experiences
             (id, title, slug, description, category, price_band, price_from, evidence_url, content_source, enrichment_state)
           VALUES
             (@id, @title, @slug, @description, @category, @price_band, @price_from, @evidence_url, 'provider_site', 'enriched')`,
        );

        // ── wcr-1: auth gate — no X-Admin-Key -> 403. ───────────────────────
        {
          const r = await callRoute(opplevelserRouter, { body: {} });
          assertEq(r.status, 403, "wcr-1: no admin key -> 403");
        }

        // ── wcr-2: empty catalog -> 0-denominator -> wrong_content_rate is
        //    null (not 0, not a crash), status under_threshold. ─────────────
        {
          const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
          assertEq(r.status, 200, "wcr-2a: empty catalog -> 200");
          assertEq(r.body.sample_size, 0, "wcr-2b: sample_size is 0 for an empty eligible pool");
          assertEq(r.body.matched, 0, "wcr-2c: matched is 0");
          assertEq(r.body.mismatched, 0, "wcr-2d: mismatched is 0");
          assertEq(r.body.unresolved, 0, "wcr-2e: unresolved is 0");
          assertEq(r.body.wrong_content_rate, null, "wcr-2f: wrong_content_rate is null on 0-denominator, never 0 or NaN");
          assertEq(r.body.status, "under_threshold", "wcr-2g: status is under_threshold with no evidence of a problem");
          assertEq(r.body.threshold, 0.02, "wcr-2h: threshold is 0.02");
        }

        // ── wcr-3: seeded mixed cohort — MATCH, MISMATCH, fetchPage failure,
        //    and judge failure — correct rate math + unresolved routing. ────
        insertExperience.run({ id: "wcr-match", title: "Fjelltur med guide", slug: "wcr-match", description: "d", category: "c", price_band: "standard", price_from: 500, evidence_url: "https://good.no/fjelltur" });
        insertExperience.run({ id: "wcr-mismatch", title: "Kajakktur", slug: "wcr-mismatch", description: "d", category: "c", price_band: "standard", price_from: 500, evidence_url: "https://mismatch.no/kajakk" });
        // Blocked by the SSRF guard before any network call — no fetch mock
        // needed for this one; guarantees a deterministic fetchPage failure.
        insertExperience.run({ id: "wcr-fetchfail", title: "Fisketur", slug: "wcr-fetchfail", description: "d", category: "c", price_band: "standard", price_from: 500, evidence_url: "http://localhost/fisk" });
        insertExperience.run({ id: "wcr-judgefail", title: "Skitur", slug: "wcr-judgefail", description: "d", category: "c", price_band: "standard", price_from: 500, evidence_url: "https://judgefail.no/ski" });

        globalThis.fetch = (async (url: any, init: any) => {
          const urlStr = String(url);
          if (urlStr === "https://good.no/fjelltur") {
            return mkPageResponse("<html><body>Fjelltur med guide i vakker natur.</body></html>", urlStr);
          }
          if (urlStr === "https://mismatch.no/kajakk") {
            return mkPageResponse("<html><body>Dette er en side om noe helt annet.</body></html>", urlStr);
          }
          if (urlStr === "https://judgefail.no/ski") {
            return mkPageResponse("<html><body>Skitur i fjellet.</body></html>", urlStr);
          }
          if (urlStr === "https://api.anthropic.com/v1/messages") {
            const body = JSON.parse(init?.body ?? "{}");
            const promptText: string = body?.messages?.[0]?.content ?? "";
            if (promptText.includes("Kajakktur")) {
              return mkAnthropicResponse("MISMATCH\nSiden handler om noe annet.");
            }
            if (promptText.includes("Skitur")) {
              // Simulate a judge-side failure (unparseable JSON) for this row.
              return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response;
            }
            return mkAnthropicResponse("MATCH\nStemmer med kilden.");
          }
          throw new Error("wcr-3: unexpected fetch URL: " + urlStr);
        }) as unknown as typeof fetch;

        {
          const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
          assertEq(r.status, 200, "wcr-3a: mixed cohort -> 200");
          assertEq(r.body.sample_size, 4, "wcr-3b: sample_size covers all 4 eligible rows");
          assertEq(r.body.matched, 1, "wcr-3c: exactly 1 matched (wcr-match)");
          assertEq(r.body.mismatched, 1, "wcr-3d: exactly 1 mismatched (wcr-mismatch)");
          assertEq(r.body.unresolved, 2, "wcr-3e: exactly 2 unresolved (fetchfail + judgefail)");
          assertEq(r.body.wrong_content_rate, 0.5, "wcr-3f: wrong_content_rate = mismatched/(matched+mismatched) = 1/2 = 0.5");
          assertEq(r.body.status, "over_threshold", "wcr-3g: 0.5 > 0.02 threshold -> over_threshold");

          const byId = new Map<string, any>((r.body.results as any[]).map((x) => [x.experience_id, x]));
          assertEq(byId.get("wcr-match")?.verdict, "MATCH", "wcr-3h: wcr-match's own result verdict is MATCH");
          assertEq(byId.get("wcr-mismatch")?.verdict, "MISMATCH", "wcr-3i: wcr-mismatch's own result verdict is MISMATCH");
          assertEq(byId.get("wcr-fetchfail")?.verdict, "unresolved", "wcr-3j: fetchPage-failed row is 'unresolved', NEVER 'matched'");
          assertEq(byId.get("wcr-judgefail")?.verdict, "unresolved", "wcr-3k: judge-failed row is 'unresolved', NEVER 'matched' or 'mismatched'");
        }

        // ── wcr-3.5: root-cause regression (2026-08-25, wrong_content_rate
        //    0.25) — a row whose legacy evidence_url is a STALE discovery-time
        //    page (would judge MISMATCH if ever fetched) but whose
        //    content_field_evidence.description carries the REAL enrichment
        //    source (would judge MATCH). The route must fetch and grade
        //    against the content_field_evidence URL, never the evidence_url
        //    one — proving the Ringve/Røros-shaped bug (grading enriched
        //    content against the wrong, stale citation) is fixed. ───────────
        {
          const insertWithFieldEvidence = expDb.prepare(
            `INSERT INTO experiences
               (id, title, slug, description, category, price_band, price_from, evidence_url, content_field_evidence, content_source, enrichment_state)
             VALUES
               (@id, @title, @slug, @description, @category, @price_band, @price_from, @evidence_url, @content_field_evidence, 'provider_site', 'enriched')`,
          );
          insertWithFieldEvidence.run({
            id: "wcr-drifted-evidence",
            title: "Hagevandring",
            slug: "wcr-drifted-evidence",
            description: "d",
            category: "c",
            price_band: "standard",
            price_from: 500,
            evidence_url: "https://stale-discovery-listing.no/wrong-page",
            content_field_evidence: JSON.stringify({ description: "https://real-homepage.no/hagevandring" }),
          });

          let staleUrlWasFetched = false;
          // Covers both the wcr-3 cohort's URLs (still present in the table —
          // sample_size below is set large enough to pull in every eligible
          // row, not just this one) AND the new drifted-evidence row's two
          // candidate URLs, so nothing here throws on an "unexpected" URL
          // regardless of sampling order.
          globalThis.fetch = (async (url: any, init: any) => {
            const urlStr = String(url);
            if (urlStr === "https://stale-discovery-listing.no/wrong-page") {
              staleUrlWasFetched = true;
              // If the bug regressed and this WAS fetched, return content
              // that reads as an obvious mismatch against "Hagevandring" so
              // the assertion below would also fail on verdict, not just on
              // the flag — two independent signals of the same regression.
              return mkPageResponse("<html><body>Dette er en helt urelatert side.</body></html>", urlStr);
            }
            if (urlStr === "https://real-homepage.no/hagevandring") {
              return mkPageResponse("<html><body>Hagevandring i vakker natur.</body></html>", urlStr);
            }
            if (urlStr === "https://good.no/fjelltur") {
              return mkPageResponse("<html><body>Fjelltur med guide i vakker natur.</body></html>", urlStr);
            }
            if (urlStr === "https://mismatch.no/kajakk") {
              return mkPageResponse("<html><body>Dette er en side om noe helt annet.</body></html>", urlStr);
            }
            if (urlStr === "https://judgefail.no/ski") {
              return mkPageResponse("<html><body>Skitur i fjellet.</body></html>", urlStr);
            }
            if (urlStr === "https://api.anthropic.com/v1/messages") {
              const body = JSON.parse(init?.body ?? "{}");
              const promptText: string = body?.messages?.[0]?.content ?? "";
              if (promptText.includes("Kajakktur")) return mkAnthropicResponse("MISMATCH\nSiden handler om noe annet.");
              if (promptText.includes("Skitur")) {
                return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response;
              }
              return mkAnthropicResponse("MATCH\nStemmer med kilden.");
            }
            throw new Error("wcr-3.5: unexpected fetch URL: " + urlStr);
          }) as unknown as typeof fetch;

          // Large enough to pull in every eligible row seeded so far (well
          // under WCR_MAX_SAMPLE_SIZE), so the drifted-evidence row is always
          // included regardless of the sampler's internal shuffle.
          const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample_size: 50 } });
          assertEq(r.status, 200, "wcr-3.5a: request succeeds");
          const ownResult = (r.body.results as any[]).find((x) => x.experience_id === "wcr-drifted-evidence");
          assertTrue(!!ownResult, "wcr-3.5b: the drifted-evidence row was sampled and has its own result");
          assertTrue(!staleUrlWasFetched, "wcr-3.5c: the stale, DISCOVERY-time evidence_url was NEVER fetched");
          assertEq(
            ownResult?.verdict,
            "MATCH",
            "wcr-3.5d: verdict is MATCH — the route graded content_field_evidence's real homepage page, not the stale evidence_url page (which reads as an obvious mismatch)"
          );
        }

        // ── wcr-4: sample_size cap enforcement — requesting >100 clamps the
        //    actual query to 100, never processing more than that. Seed a
        //    105-row pool of SSRF-blocked (localhost) evidence_urls so every
        //    row resolves instantly to `unresolved` with zero live fetch
        //    calls needed — fast and deterministic. Also doubles as another
        //    0-denominator -> null case at a much larger n. ──────────────────
        for (let i = 0; i < 105; i++) {
          insertExperience.run({
            id: `wcr-cap-${i}`,
            title: `Cap Test ${i}`,
            slug: `wcr-cap-${i}`,
            description: "d",
            category: "c",
            price_band: "standard",
            price_from: 500,
            evidence_url: `http://localhost/cap-${i}`,
          });
        }
        globalThis.fetch = (async () => {
          throw new Error("wcr-4: no live fetch expected — every seeded row is SSRF-blocked before any fetch call");
        }) as unknown as typeof fetch;
        {
          const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample_size: 150 } });
          assertEq(r.status, 200, "wcr-4a: sample_size:150 request -> 200");
          assertEq(r.body.sample_size, 100, "wcr-4b: sample_size clamped to 100 even though 105 eligible rows + a request for 150 exist");
          assertEq(r.body.matched, 0, "wcr-4c: matched is 0 (every row SSRF-blocked)");
          assertEq(r.body.mismatched, 0, "wcr-4d: mismatched is 0");
          assertEq(r.body.unresolved, 100, "wcr-4e: all 100 sampled rows land in unresolved");
          assertEq(r.body.wrong_content_rate, null, "wcr-4f: wrong_content_rate is null (0 denominator) at this larger n too");
        }

        // ── wcr-5: a non-numeric / zero / negative sample_size falls back to
        //    the default (30), not a crash or an unbounded query. ───────────
        {
          const r1 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample_size: "not-a-number" } });
          assertEq(r1.status, 200, "wcr-5a: non-numeric sample_size -> 200, falls back to default");
          assertTrue(r1.body.sample_size <= 30, "wcr-5b: non-numeric sample_size falls back to the default cap (30), not unbounded");

          const r2 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample_size: -5 } });
          assertEq(r2.status, 200, "wcr-5c: negative sample_size -> 200, falls back to default");
          assertTrue(r2.body.sample_size <= 30, "wcr-5d: negative sample_size falls back to the default cap (30)");
        }
      } finally {
        for (const p of cachePaths) delete require.cache[p];
        if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
        else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
        if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey;
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-wrong-content-rate: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-wrong-content-rate.test.ts`
if (require.main === module) {
  runExperiencesWrongContentRateTests(true).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

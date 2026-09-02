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
 *   - Slice F2 honest-measurement fixes (dev-request 2026-06-23-
 *     experiences-richer-profiles, section (d) below): the judge sees the
 *     page's labeled og:description/meta-description content (a verbatim
 *     meta-derived description grades MATCH, not the pre-F2 false
 *     MISMATCH); parked-domain and hard-404 citations land in `unresolved`
 *     with distinct `citation_gone:*` reasons and stay out of BOTH the
 *     numerator and the denominator; and the additive published/unpublished
 *     sub-aggregates stratify the rate over the SAME publish-gate predicate
 *     /discover uses.
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
  samplePublishedExperiencesForHoldout,
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
      // (b1) samplePublishedExperiencesForHoldout — dev-request 2026-08-25-
      //     wcr-holdout-pool-dekker-ikke-publisert-flate: the published-quota
      //     sampler pulls straight from PUBLISH_GATE_SQL (verification_status
      //     = 'verified', confidence NULL/high/medium, provider brreg_active
      //     or no provider, canonical_id NULL) — independent of enrichment_
      //     state/content_source — and reports `considered` (gate-passing
      //     rows examined) vs `checkable` (of those, how many resolveHoldout
      //     EvidenceUrl() actually resolves for) so an honest exclusion rate
      //     can be reported instead of unchecka­ble rows silently vanishing.
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
            verification_status TEXT,
            confidence TEXT,
            canonical_id TEXT,
            provider_id TEXT,
            updated_at TEXT
          );
          -- PUBLISH_GATE_SQL LEFT JOINs this table even when every row here
          -- leaves provider_id NULL (its "p.id IS NULL OR ..." branch is what
          -- passes then) — the table must still exist for the JOIN to parse.
          -- catalog_hidden: referenced by the gate's fifth clause (dev-request
          -- 2026-09-02-experiences-skrivepause-catalog-hidden-og-rapportspraak,
          -- del 2) — LEFT-JOIN-safe, so with no provider rows it still passes.
          CREATE TABLE experience_providers (
            id TEXT PRIMARY KEY,
            brreg_active INTEGER,
            catalog_hidden INTEGER
          );
        `);
        const insertP = db.prepare(
          `INSERT INTO experiences (id, title, description, category, price_band, price_from, evidence_url, content_field_evidence, verification_status, confidence, canonical_id, provider_id, updated_at)
           VALUES (@id, @title, @description, @category, @price_band, @price_from, @evidence_url, @content_field_evidence, @verification_status, @confidence, @canonical_id, @provider_id, @updated_at)`,
        );
        // Passes PUBLISH_GATE_SQL, checkable via evidence_url. provider_id
        // left NULL -> PUBLISH_GATE_SQL's "p.id IS NULL OR p.brreg_active = 1"
        // passes without any experience_providers row needing to exist.
        insertP.run({ id: "p-pub-1", title: "A", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://p1.no", content_field_evidence: null, verification_status: "verified", confidence: null, canonical_id: null, provider_id: null, updated_at: "2026-08-01" });
        insertP.run({ id: "p-pub-2", title: "B", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://p2.no", content_field_evidence: null, verification_status: "verified", confidence: "high", canonical_id: null, provider_id: null, updated_at: "2026-08-02" });
        // Passes PUBLISH_GATE_SQL but carries NO checkable citation at all
        // (no evidence_url, no content_field_evidence) — must be counted in
        // `considered` but excluded from both `checkable` and `rows`.
        insertP.run({ id: "p-pub-no-citation", title: "C", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: null, content_field_evidence: null, verification_status: "verified", confidence: null, canonical_id: null, provider_id: null, updated_at: "2026-08-03" });
        // Does NOT pass PUBLISH_GATE_SQL (verification_status != 'verified')
        // -> excluded entirely, not even counted in `considered`.
        insertP.run({ id: "p-not-published", title: "D", description: "d", category: "c", price_band: "standard", price_from: 100, evidence_url: "https://d.no", content_field_evidence: null, verification_status: "pending_verify", confidence: null, canonical_id: null, provider_id: null, updated_at: "2026-08-01" });

        const publishedPool = samplePublishedExperiencesForHoldout(db as any, 10);
        assertEq(publishedPool.rows.length, 2, "sp-1: only the 2 checkable, gate-passing rows land in rows");
        const publishedIds = publishedPool.rows.map((r) => r.id).sort();
        assertEq(publishedIds, ["p-pub-1", "p-pub-2"], "sp-2: exactly the checkable published rows, no-citation and non-published rows excluded from rows");
        assertEq(publishedPool.considered, 3, "sp-3: considered counts all 3 gate-passing rows (including the no-citation one), NOT the non-published row");
        assertEq(publishedPool.checkable, 2, "sp-4: checkable counts only the 2 rows resolveHoldoutEvidenceUrl() actually resolves for");

        const smallPool = samplePublishedExperiencesForHoldout(db as any, 1);
        assertEq(smallPool.rows.length, 1, "sp-5: n=1 returns exactly 1 row from a larger checkable pool");
        assertEq(smallPool.considered, 3, "sp-6: considered is unaffected by n — it reflects the full gate-passing pool, not the requested slice");
        assertEq(smallPool.checkable, 2, "sp-7: checkable is likewise unaffected by n");

        const zeroPool = samplePublishedExperiencesForHoldout(db as any, 0);
        assertEq(zeroPool, { rows: [], considered: 0, checkable: 0 }, "sp-8: n=0 returns an empty pool with considered/checkable both 0, no query-limit edge case crash");

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

        // rh-6 (2026-08-25 review round 2): a THIRD, real sentinel this module
        // didn't previously know about by name — "generated:katalogfelt-llm",
        // written by the LLM description-backfill endpoint — must be rejected
        // by SHAPE (not an http(s) URL), same as any other non-URL value,
        // falling through to the legacy evidence_url. Locks in that the fix
        // is enumeration-proof against sentinels this module has never heard
        // of, not just the two it imported before.
        const unknownSentinel: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: "https://legacy-fallback-2.no/",
          content_field_evidence: JSON.stringify({ description: "generated:katalogfelt-llm" }),
        };
        assertEq(
          resolveHoldoutEvidenceUrl(unknownSentinel),
          "https://legacy-fallback-2.no/",
          "rh-6: an unenumerated sentinel is rejected by shape, legacy evidence_url used as last resort"
        );

        // rh-7 (2026-08-25 review round 2): a malformed row where a judged
        // field's content_field_evidence value is not a string at all (e.g.
        // a number) must never throw — it falls through exactly like a
        // missing/sentinel value, never crashing the whole holdout endpoint
        // over one bad row.
        const nonStringField: HoldoutExperienceRow = {
          ...ROW_BASE,
          evidence_url: "https://legacy-fallback-3.no/",
          content_field_evidence: JSON.stringify({ description: 12345 }),
        };
        assertEq(
          resolveHoldoutEvidenceUrl(nonStringField),
          "https://legacy-fallback-3.no/",
          "rh-7: a non-string per-field value never throws, falls through to legacy evidence_url"
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

          // Slice F2 (honest measurement) — machine-readable unresolved
          // causes: an ordinary fetch failure and a judge failure carry their
          // OWN reason codes, distinct from the citation_gone:* family
          // exercised in section (d) below.
          assertEq(byId.get("wcr-fetchfail")?.reason, "fetch_failed:ssrf_blocked", "wcr-3l: fetch-failure carries reason 'fetch_failed:<FetchFailureReason>'");
          assertEq(byId.get("wcr-judgefail")?.reason, "judge_failed", "wcr-3m: judge-failure carries reason 'judge_failed'");
          assertEq(byId.get("wcr-match")?.reason, undefined, "wcr-3n: a genuine MATCH verdict carries NO reason field");

          // Slice F2 — additive strata are present and consistent with the
          // overall tallies (all 4 seeded rows are unpublished: none is
          // verification_status='verified', so the publish gate fails).
          assertEq(r.body.published, { sample_size: 0, matched: 0, mismatched: 0, unresolved: 0, wrong_content_rate: null }, "wcr-3o: published stratum is empty (no seeded row passes the publish gate) with a null rate");
          assertEq(r.body.unpublished, { sample_size: 4, matched: 1, mismatched: 1, unresolved: 2, wrong_content_rate: 0.5 }, "wcr-3p: unpublished stratum carries all 4 rows with the same rate math as the top level");
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

      // ═══════════════════════════════════════════════════════════════════
      // (d) Slice F2 — honest-measurement fixes (dev-request 2026-06-23-
      //     experiences-richer-profiles): meta-description inclusion,
      //     citation_gone routing (parked / hard 404), and published/
      //     unpublished stratification. Own fresh in-memory DB + fresh
      //     router require, same harness shape as section (c), so the
      //     mixed fixture set here is exactly what the aggregates cover.
      // ═══════════════════════════════════════════════════════════════════

      // ── md-1..md-5: extractMetaDescriptions — pure unit tests of the
      //    shared extractor (search-enrich.ts) the route feeds the judge
      //    with. og first, meta-name fallback, dedupe, entity decode. ──────
      {
        const { extractMetaDescriptions } = require("../services/search-enrich") as
          typeof import("../services/search-enrich");
        assertEq(
          extractMetaDescriptions('<html><head><meta property="og:description" content="Fra og-taggen."><meta name="description" content="Fra meta-taggen."></head><body></body></html>'),
          ["Fra og-taggen.", "Fra meta-taggen."],
          "md-1: both og:description and meta description extracted, og first",
        );
        assertEq(
          extractMetaDescriptions('<html><head><meta name="description" content="Bare meta her."></head><body></body></html>'),
          ["Bare meta her."],
          "md-2: meta name=description alone is extracted",
        );
        assertEq(
          extractMetaDescriptions('<html><head><meta property="og:description" content="Samme tekst."><meta name="description" content="Samme tekst."></head><body></body></html>'),
          ["Samme tekst."],
          "md-3: identical og + meta values are deduped to one entry",
        );
        assertEq(
          extractMetaDescriptions("<html><head></head><body><p>Ingen meta.</p></body></html>"),
          [],
          "md-4: a page with neither tag -> [], never a fabricated entry",
        );
        assertEq(
          extractMetaDescriptions('<html><head><meta name="description" content="R&oslash;yk &amp; sild"></head><body></body></html>'),
          ["Røyk & sild"],
          "md-5: HTML entities in the attribute are decoded",
        );
      }

      const prevDbPathD = process.env.EXPERIENCES_DB_PATH;
      const prevAdminKeyD = process.env.ADMIN_KEY;
      const testKeyD = process.env.ADMIN_KEY || "wcr-test-admin-key";
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      process.env.ADMIN_KEY = testKeyD;

      const cachePathsD = [
        require.resolve("../database/db-factory"),
        require.resolve("../services/experience-store"),
        require.resolve("../services/experience-content-judge"),
        require.resolve("./opplevelser"),
      ];
      for (const p of cachePathsD) delete require.cache[p];

      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
        const expDb = dbFactory.getDb("experiences");
        const oppl = require("./opplevelser") as typeof import("./opplevelser");
        const opplevelserRouter = oppl.default as any;
        const adminHeaders = { "x-admin-key": testKeyD };

        // verification_status is explicit per row here — 'verified' rows (no
        // provider, confidence NULL, canonical_id NULL) pass the SAME
        // PUBLISH_GATE_SQL predicate /discover uses; 'pending_verify' rows
        // fail it. That split IS the stratification fixture.
        const insertD = expDb.prepare(
          `INSERT INTO experiences
             (id, title, slug, description, category, price_band, price_from,
              evidence_url, verification_status, content_source, enrichment_state)
           VALUES
             (@id, @title, @slug, @description, @category, @price_band, @price_from,
              @evidence_url, @verification_status, 'provider_site', 'enriched')`,
        );
        const baseD = { description: "d", category: "c", price_band: "standard", price_from: 500 };
        // Published stratum: 2 that will MATCH + 1 parked citation.
        insertD.run({ ...baseD, id: "d-pub-match-1", title: "Seterbesøk med smaksprøver", slug: "d-pub-match-1", evidence_url: "https://pub-match-1.no/", verification_status: "verified" });
        insertD.run({ ...baseD, id: "d-pub-match-2", title: "Fjelltur med guide", slug: "d-pub-match-2", evidence_url: "https://pub-match-2.no/", verification_status: "verified" });
        insertD.run({ ...baseD, id: "d-pub-parked", title: "Sirdalstur", slug: "d-pub-parked", evidence_url: "https://parked-domain.no/", verification_status: "verified" });
        // Unpublished stratum: the meta-derived-description row (the IDDIS
        // shape), 2 genuine mismatches, and a hard-404 citation.
        insertD.run({
          ...baseD,
          id: "d-unpub-meta",
          title: "Sildehuset museum",
          slug: "d-unpub-meta",
          // Stored description is VERBATIM the page's meta description — the
          // live IDDIS case. The page's visible body says nothing like it.
          description: "Kjenn røyken fra brislingovnene i det gamle sjøhuset.",
          evidence_url: "https://meta-only.no/",
          verification_status: "pending_verify",
        });
        insertD.run({ ...baseD, id: "d-unpub-mm-1", title: "Kajakkutleie", slug: "d-unpub-mm-1", evidence_url: "https://unpub-mm-1.no/", verification_status: "pending_verify" });
        insertD.run({ ...baseD, id: "d-unpub-mm-2", title: "Vandretur i lia", slug: "d-unpub-mm-2", evidence_url: "https://unpub-mm-2.no/", verification_status: "pending_verify" });
        insertD.run({ ...baseD, id: "d-unpub-404", title: "Fjordcruise", slug: "d-unpub-404", evidence_url: "https://gone-404.no/", verification_status: "pending_verify" });

        // Parked lander: HTTP 200, tiny visible text with registrar
        // boilerplate — and deliberately WITH a meta description, locking in
        // that the parked check runs BEFORE meta extraction (parking
        // boilerplate must never be fed to the judge as page content).
        const parkedHtml =
          '<html><head><meta name="description" content="Domenet parked-domain.no kan være til salgs."></head>' +
          "<body><h1>Domenet er til salgs</h1><p>Kontakt oss for å kjøpe dette domenet.</p></body></html>";
        const metaOnlyHtml =
          '<html><head><meta name="description" content="Kjenn røyken fra brislingovnene i det gamle sjøhuset."></head>' +
          "<body><nav>Hjem Program Billetter Kontakt</nav></body></html>";

        let metaRowPrompt: string | null = null;
        globalThis.fetch = (async (url: any, init: any) => {
          const urlStr = String(url);
          if (urlStr === "https://pub-match-1.no/") return mkPageResponse("<html><body>Seterbesøk med smaksprøver av egen ost hele sommeren.</body></html>", urlStr);
          if (urlStr === "https://pub-match-2.no/") return mkPageResponse("<html><body>Fjelltur med guide i vakker natur.</body></html>", urlStr);
          if (urlStr === "https://parked-domain.no/") return mkPageResponse(parkedHtml, urlStr);
          if (urlStr === "https://meta-only.no/") return mkPageResponse(metaOnlyHtml, urlStr);
          if (urlStr === "https://unpub-mm-1.no/") return mkPageResponse("<html><body>Denne siden handler om noe helt annet.</body></html>", urlStr);
          if (urlStr === "https://unpub-mm-2.no/") return mkPageResponse("<html><body>Også en helt urelatert side.</body></html>", urlStr);
          if (urlStr === "https://gone-404.no/") {
            // fetchPage classifies this via classifyHttpStatus -> http_404
            // (permanent) with no retry — no body read happens.
            return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null } } as unknown as Response;
          }
          if (urlStr === "https://api.anthropic.com/v1/messages") {
            const body = JSON.parse(init?.body ?? "{}");
            const promptText: string = body?.messages?.[0]?.content ?? "";
            if (promptText.includes("Kajakkutleie") || promptText.includes("Vandretur")) {
              return mkAnthropicResponse("MISMATCH\nSiden handler om noe annet.");
            }
            if (promptText.includes("Sildehuset")) {
              metaRowPrompt = promptText;
              // The judge only sees a match for the meta-derived row if the
              // route actually handed it the labeled meta content — a
              // body-only page text (the pre-F2 behavior) grades MISMATCH.
              return promptText.includes("Sidens meta-beskrivelse:") && promptText.includes("brislingovnene")
                ? mkAnthropicResponse("MATCH\nBeskrivelsen er ordrett sidens egen meta-beskrivelse.")
                : mkAnthropicResponse("MISMATCH\nBeskrivelsen finnes ikke i sideteksten.");
            }
            return mkAnthropicResponse("MATCH\nStemmer med kilden.");
          }
          throw new Error("wcr-d: unexpected fetch URL: " + urlStr);
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample_size: 50 } });
        assertEq(r.status, 200, "wcr-d1: mixed published/unpublished cohort -> 200");
        assertEq(r.body.sample_size, 7, "wcr-d2: all 7 eligible rows sampled");

        const byId = new Map<string, any>((r.body.results as any[]).map((x) => [x.experience_id, x]));

        // Gap 1 — meta inclusion: the IDDIS-shaped row now grades MATCH.
        assertEq(byId.get("d-unpub-meta")?.verdict, "MATCH", "wcr-d3: a description verbatim from the page's meta description grades MATCH (was a false MISMATCH when the judge saw body text only)");
        assertTrue(metaRowPrompt !== null, "wcr-d4: the judge WAS invoked for the meta row (not short-circuited)");
        {
          const p = metaRowPrompt ?? "";
          const labelIdx = p.indexOf("Sidens meta-beskrivelse:");
          const bodyIdx = p.indexOf("Hjem Program Billetter");
          assertTrue(labelIdx >= 0, "wcr-d5a: judged page text carries the labeled meta block");
          assertTrue(bodyIdx >= 0, "wcr-d5b: judged page text still carries the visible body text");
          assertTrue(labelIdx < bodyIdx, "wcr-d5c: meta block comes FIRST, so the 4000-char combined cap can never silently truncate it away");
        }

        // Gap 2 — citation-gone routing: parked + hard 404 land in
        // unresolved with distinct citation_gone:* reasons, never MISMATCH.
        assertEq(byId.get("d-pub-parked")?.verdict, "unresolved", "wcr-d6a: a parked-domain citation is 'unresolved', never a MISMATCH");
        assertEq(byId.get("d-pub-parked")?.reason, "citation_gone:parked", "wcr-d6b: parked citation carries reason 'citation_gone:parked'");
        assertEq(byId.get("d-unpub-404")?.verdict, "unresolved", "wcr-d7a: a hard-404 citation is 'unresolved', never a MISMATCH");
        assertEq(byId.get("d-unpub-404")?.reason, "citation_gone:http_404", "wcr-d7b: hard-404 citation carries reason 'citation_gone:http_404'");

        // Both citation_gone rows are excluded from BOTH numerator and
        // denominator: rate = 2 mismatches / (3 matched + 2 mismatched).
        assertEq(r.body.matched, 3, "wcr-d8a: matched = 3 (2 published + the meta-derived row)");
        assertEq(r.body.mismatched, 2, "wcr-d8b: mismatched = 2 (citation_gone rows NOT counted as mismatches)");
        assertEq(r.body.unresolved, 2, "wcr-d8c: unresolved = 2 (parked + 404)");
        assertEq(r.body.wrong_content_rate, 0.4, "wcr-d8d: rate = 2/5 — citation_gone rows in neither numerator nor denominator");

        // Gap 3 — stratification: published (the guardrail number) vs
        // unpublished sub-aggregates, same rate math per stratum.
        assertEq(
          r.body.published,
          { sample_size: 3, matched: 2, mismatched: 0, unresolved: 1, wrong_content_rate: 0 },
          "wcr-d9a: published stratum — 2 matched, 0 mismatched, 1 unresolved (parked), rate 0",
        );
        assertEq(
          r.body.unpublished,
          { sample_size: 4, matched: 1, mismatched: 2, unresolved: 1, wrong_content_rate: 2 / 3 },
          "wcr-d9b: unpublished stratum — 1 matched (meta row), 2 mismatched, 1 unresolved (404), rate 2/3",
        );
        assertEq(byId.get("d-pub-match-1")?.published, true, "wcr-d9c: a verified row's result is flagged published:true");
        assertEq(byId.get("d-unpub-meta")?.published, false, "wcr-d9d: a pending_verify row's result is flagged published:false");
        // Top-level semantics unchanged: overall counts equal the strata sums.
        assertEq(
          r.body.published.sample_size + r.body.unpublished.sample_size,
          r.body.sample_size,
          "wcr-d9e: strata partition the sample exactly (no row double-counted or dropped)",
        );
      } finally {
        for (const p of cachePathsD) delete require.cache[p];
        if (prevDbPathD === undefined) delete process.env.EXPERIENCES_DB_PATH;
        else process.env.EXPERIENCES_DB_PATH = prevDbPathD;
        if (prevAdminKeyD === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKeyD;
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) dev-request 2026-08-25-wcr-holdout-pool-dekker-ikke-publisert-
      //     flate — route-level AC1 regression test: a genuinely published
      //     row (verification_status='verified'), deliberately NOT matching
      //     the enrichment_state='enriched'/content_source='provider_site'
      //     selector (proving it is samplePublishedExperiencesForHoldout, not
      //     the pre-existing enriched-pool selector, surfacing it), must
      //     produce published.sample_size >= 1 — before this dev-request the
      //     `published` stratum always came back sample_size:0 in production.
      // ═══════════════════════════════════════════════════════════════════
      const prevDbPathE = process.env.EXPERIENCES_DB_PATH;
      const prevAdminKeyE = process.env.ADMIN_KEY;
      const testKeyE = process.env.ADMIN_KEY || "wcr-test-admin-key";
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      process.env.ADMIN_KEY = testKeyE;

      const cachePathsE = [
        require.resolve("../database/db-factory"),
        require.resolve("../services/experience-store"),
        require.resolve("../services/experience-content-judge"),
        require.resolve("./opplevelser"),
      ];
      for (const p of cachePathsE) delete require.cache[p];

      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
        const expDb = dbFactory.getDb("experiences");
        const oppl = require("./opplevelser") as typeof import("./opplevelser");
        const opplevelserRouter = oppl.default as any;
        const adminHeaders = { "x-admin-key": testKeyE };

        const insertE = expDb.prepare(
          `INSERT INTO experiences
             (id, title, slug, description, category, price_band, price_from,
              evidence_url, content_field_evidence, verification_status, confidence,
              canonical_id, provider_id, content_source, enrichment_state)
           VALUES
             (@id, @title, @slug, @description, @category, @price_band, @price_from,
              @evidence_url, @content_field_evidence, @verification_status, @confidence,
              @canonical_id, @provider_id, @content_source, @enrichment_state)`,
        );
        const baseE = { description: "d", category: "c", price_band: "standard", price_from: 500, confidence: null, canonical_id: null, provider_id: null };
        // Genuinely published — but deliberately harvest-shaped
        // (content_source != 'provider_site', enrichment_state != 'enriched')
        // so it can ONLY be surfaced by samplePublishedExperiencesForHoldout,
        // never by the pre-existing sampleEnrichedExperiencesForHoldout.
        insertE.run({
          ...baseE,
          id: "e-served-1",
          title: "Breføring på isbreen",
          slug: "e-served-1",
          evidence_url: "https://epub1.no/brefoering",
          content_field_evidence: null,
          verification_status: "verified",
          content_source: "harvest",
          enrichment_state: "matched",
        });
        // Published, but no checkable citation at all — must count in
        // published_pool.considered without crashing, and must NOT appear in
        // `results`/`rows`, pulling checkable < considered (excluded_rate > 0).
        insertE.run({
          ...baseE,
          id: "e-served-no-citation",
          title: "Bærplukking i skogen",
          slug: "e-served-no-citation",
          evidence_url: null,
          content_field_evidence: null,
          verification_status: "verified",
          content_source: "harvest",
          enrichment_state: "matched",
        });

        globalThis.fetch = (async (url: any, init: any) => {
          const urlStr = String(url);
          if (urlStr === "https://epub1.no/brefoering") {
            return mkPageResponse("<html><body>Breføring på isbreen med erfaren guide.</body></html>", urlStr);
          }
          if (urlStr === "https://api.anthropic.com/v1/messages") {
            return mkAnthropicResponse("MATCH\nStemmer med kilden.");
          }
          throw new Error("wcr-e: unexpected fetch URL: " + urlStr);
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        assertEq(r.status, 200, "wcr-e1: request succeeds");
        assertTrue(r.body.published.sample_size >= 1, "wcr-e2 (AC1): published.sample_size >= 1 — the published stratum is no longer always 0");
        const servedResult = (r.body.results as any[]).find((x) => x.experience_id === "e-served-1");
        assertTrue(!!servedResult, "wcr-e3: the harvest-shaped published row was sampled and judged even though it fails the enriched-pool selector");
        assertEq(servedResult?.published, true, "wcr-e4: its own result is flagged published:true");

        assertTrue(!!r.body.published_pool, "wcr-e5 (AC2): published_pool is present in the response");
        assertTrue(r.body.published_pool.considered >= 2, "wcr-e6: published_pool.considered counts both published-gate rows (including the no-citation one)");
        assertTrue(r.body.published_pool.checkable < r.body.published_pool.considered, "wcr-e7: published_pool.checkable is strictly less than considered — the no-citation row is excluded from checkable");
        assertTrue(
          typeof r.body.published_pool.excluded_rate === "number" && r.body.published_pool.excluded_rate > 0,
          "wcr-e8: published_pool.excluded_rate is a positive number reflecting the unchecka­ble published row — never silently absent",
        );
        const noCitationResult = (r.body.results as any[]).find((x) => x.experience_id === "e-served-no-citation");
        assertEq(noCitationResult, undefined, "wcr-e9: the no-citation published row is honestly excluded from rows/results, never fabricated a comparison");
      } finally {
        for (const p of cachePathsE) delete require.cache[p];
        if (prevDbPathE === undefined) delete process.env.EXPERIENCES_DB_PATH;
        else process.env.EXPERIENCES_DB_PATH = prevDbPathE;
        if (prevAdminKeyE === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKeyE;
      }

      // ═══════════════════════════════════════════════════════════════════
      // (f) route-level regression — CHANGES-REQUESTED fix: a row eligible
      //     for BOTH samplePublishedExperiencesForHoldout AND the enriched-
      //     pool selector must not cause dedup to under-fill `rows` below
      //     sample_size. Before this fix, the unpublished draw was sized DOWN
      //     to `sampleSize - publishedPool.rows.length` BEFORE dedup, so a
      //     row the published quota already claimed had no spare unpublished
      //     capacity to backfill it from — with a 10-row fully-overlapping
      //     eligible pool and sample_size:10, dedup could (and, over many
      //     runs, reliably did) leave `rows` short of 10. Seeding exactly
      //     sample_size (10) doubly-eligible rows means the fixed code's
      //     full-size unpublished draw (sampleEnrichedExperiencesForHoldout
      //     called with `sampleSize`, not the old sized-down value) alone
      //     already covers all 10 distinct ids, so the merged+capped `rows`
      //     is deterministically 10 regardless of shuffle order or overlap —
      //     proving the fix without relying on getting an unlucky draw.
      // ═══════════════════════════════════════════════════════════════════
      const prevDbPathF = process.env.EXPERIENCES_DB_PATH;
      const prevAdminKeyF = process.env.ADMIN_KEY;
      const testKeyF = process.env.ADMIN_KEY || "wcr-test-admin-key";
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      process.env.ADMIN_KEY = testKeyF;

      const cachePathsF = [
        require.resolve("../database/db-factory"),
        require.resolve("../services/experience-store"),
        require.resolve("../services/experience-content-judge"),
        require.resolve("./opplevelser"),
      ];
      for (const p of cachePathsF) delete require.cache[p];

      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
        const expDb = dbFactory.getDb("experiences");
        const oppl = require("./opplevelser") as typeof import("./opplevelser");
        const opplevelserRouter = oppl.default as any;
        const adminHeaders = { "x-admin-key": testKeyF };

        const insertF = expDb.prepare(
          `INSERT INTO experiences
             (id, title, slug, description, category, price_band, price_from,
              evidence_url, verification_status, confidence, canonical_id,
              provider_id, content_source, enrichment_state)
           VALUES
             (@id, @title, @slug, @description, @category, @price_band, @price_from,
              @evidence_url, @verification_status, @confidence, @canonical_id,
              @provider_id, @content_source, @enrichment_state)`,
        );
        const baseF = {
          description: "d",
          category: "c",
          price_band: "standard",
          price_from: 500,
          confidence: null,
          canonical_id: null,
          provider_id: null,
          verification_status: "verified",
          content_source: "provider_site",
          enrichment_state: "enriched",
        };
        // 10 distinct rows, each satisfying BOTH PUBLISH_GATE_SQL (verified,
        // confidence NULL, no provider row so the provider clause passes
        // vacuously, canonical_id NULL) AND the enriched-pool selector
        // (enrichment_state='enriched', content_source='provider_site') —
        // exactly the realistic overlap the module's own comments call out.
        // http://localhost/* is SSRF-blocked before any network call, so
        // every row resolves deterministically to `unresolved` with no fetch
        // mock needed — sample_size (== rows.length, set before the per-row
        // fetch/judge loop even runs) is all this test needs to check.
        for (let i = 0; i < 10; i++) {
          insertF.run({
            ...baseF,
            id: `wcr-overlap-${i}`,
            title: `Overlap Test ${i}`,
            slug: `wcr-overlap-${i}`,
            evidence_url: `http://localhost/overlap-${i}`,
          });
        }
        globalThis.fetch = (async () => {
          throw new Error("wcr-f: no live fetch expected — every seeded row is SSRF-blocked before any fetch call");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample_size: 10 } });
        assertEq(r.status, 200, "wcr-f1: request succeeds");
        assertEq(
          r.body.sample_size,
          10,
          "wcr-f2: sample_size comes back as the FULL requested count (10), not short — the dedup-under-fill bug is fixed",
        );
        const distinctIds = new Set((r.body.results as any[]).map((x) => x.experience_id));
        assertEq(distinctIds.size, 10, "wcr-f3: all 10 results are for distinct experience ids, no double-counted row");
      } finally {
        for (const p of cachePathsF) delete require.cache[p];
        if (prevDbPathF === undefined) delete process.env.EXPERIENCES_DB_PATH;
        else process.env.EXPERIENCES_DB_PATH = prevDbPathF;
        if (prevAdminKeyF === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKeyF;
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

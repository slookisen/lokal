/**
 * homepage-provenance-low-quality-selector.test.ts — tests the `select:
 * "low_quality"` opt-in cohort added to POST /admin/homepage-provenance-batch
 * (dev-request 2026-07-13-enrichment-tynne-profiler-trust-score, items 1 + 3
 * — items 2/4/5 are separate slices, see marketplace.ts's module doc comment
 * on the handler) — plus the matching `low_quality_cohort` breakdown added to
 * GET /admin/outreach-ready-pool/stats.
 *
 * Daniel's ask this implements: "lokal-agent-enrichment skal ... i større
 * grad plukke opp dårlige/tynne agent profiler og forbedre dem. du kan bruke
 * blant annet trust score til å finne profiler som er dårlige. bruk
 * hjemmeside som source."
 *
 * Covered here:
 *   (1) low_quality ranks worst-first: trust_score is the dominant term
 *       (a very-low-trust agent outranks a higher-(but still <0.5)-trust
 *       agent regardless of junk signals), and junk/thinness signal count
 *       breaks ties between agents at the same trust_score.
 *   (2) trust_score >= 0.5 is never a low_quality candidate (threshold gate).
 *   (3) umbrella-tagged agents are excluded even at a rock-bottom trust_score
 *       (existing file-wide safety invariant, re-asserted for the new mode).
 *   (4) `limit` is honored under low_quality mode.
 *   (5) low_quality mode does NOT require field_provenance to lack a
 *       "homepage" source (the default auto-select's own gate) — an
 *       already-"rich"-looking agent with a stale/junk homepage source is
 *       still selectable here.
 *   (6) the DEFAULT (no `select`) auto-select is byte-for-byte unaffected:
 *       it still selects purely on its own pre-existing criteria, is blind
 *       to trust_score, and does NOT pick up low_quality-only-eligible
 *       agents (verified status, or already has homepage provenance).
 *   (7) the existing no_yield_streak backoff (same NO_YIELD_BACKOFF_DAYS
 *       mechanism as the default auto-select) also excludes agents from
 *       low_quality selection — reused as-is per spec, not reinvented.
 *   (8) trust_score is recomputed and persisted immediately after an
 *       'enriched' outcome ONLY when the request was `select: "low_quality"`
 *       — a default-mode (or agentIds-only) enrichment leaves trust_score
 *       untouched until the next periodic recalculateAll() sweep, same as
 *       today.
 *   (9) "low_quality" is accepted (200, not the 400 unknown-select rejection).
 *   (10) GET /admin/outreach-ready-pool/stats exposes a low_quality_cohort
 *        breakdown (total / junk_email / junk_description / thin) computed
 *        with the SAME isJunkEmail/isJunkDescription predicates the selector
 *        ranks with.
 *
 * Mirrors homepage-provenance-selector-rotation.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - routers are exercised directly (router.handle(req, res, next)), no
 *     HTTP server / supertest.
 *   - global.fetch is stubbed and restored after.
 *   - exported runHomepageProvenanceLowQualitySelectorTests({log}) ->
 *     TestSummary; wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-provenance-low-quality-selector.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runHomepageProvenanceLowQualitySelectorTests(
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
    const prevDb = initMod.getDb();
    const testKey = "homepage-provenance-low-quality-selector-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;
    const prevParkingDisabled = process.env.HOMEPAGE_PARKING_DISABLED;
    delete process.env.HOMEPAGE_PARKING_DISABLED;
    const prevNoYieldBackoffDays = process.env.NO_YIELD_BACKOFF_DAYS;
    delete process.env.NO_YIELD_BACKOFF_DAYS;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const JUNK_DESC = "Skip to content. Meny Forside Produksjon.";
      const CLEAN_DESC = "Vi driver med økologisk grønnsaksdyrking og selger direkte fra gården hver lørdag.";
      const JUNK_EMAIL_LOCAL = "noreply@";
      const CLEAN_PRODUCTS = '[{"name":"Poteter","category":"vegetables"}]';

      const insertAgent = db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, trust_score, umbrella_type)
         VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      );

      type Fixture = {
        id: string;
        name: string;
        host: string;
        trustScore: number;
        umbrellaType: string | null;
        contactEmail: string;
        description: string;
        about: string | null;
        products: string;
        fieldProvenance: string;
        verificationStatus: string;
      };

      // Two-phase insert (mirrors homepage-provenance-selector-rotation.test.ts's
      // "insert the agent_knowledge row only right before the phase that needs
      // it" idiom): the SQL selection queries all JOIN agent_knowledge, so an
      // agents-only row (no agent_knowledge row yet) is fully invisible to
      // every select mode. Used below to keep the trust-refresh/control/
      // backoff fixtures out of the broad (unrestricted) low_quality sweeps
      // run by earlier sections, so those sections can't dilute/contaminate
      // fixtures that later sections still need in a known-pristine state.
      function addAgentRow(f: Fixture): void {
        insertAgent.run(
          f.id, f.name, f.description, f.contactEmail, `https://${f.host}`, `key-${f.id}`,
          f.trustScore, f.umbrellaType,
        );
      }
      function addKnowledgeRow(f: Fixture): void {
        insertKnowledge.run(
          f.id, `https://${f.host}`, f.about, f.products, f.fieldProvenance, f.verificationStatus,
        );
      }
      function addAgent(f: Fixture): void {
        addAgentRow(f);
        addKnowledgeRow(f);
      }

      // ── (1)+(2)+(3)+(4) ranking / threshold / umbrella / limit fixtures ────
      // All four ranking-cohort trust_scores are kept strictly BELOW every
      // other fixture's trust_score in this file (isolation/backoff/refresh
      // fixtures start at 0.15) so the global (unfiltered) top-of-list order
      // is deterministic for the `limit` assertion below, regardless of how
      // many other <0.5 candidates exist elsewhere in the fixture set.
      //
      // lq-c: rock-bottom trust_score, otherwise CLEAN (no junk signals) —
      // must still rank FIRST (trust_score is the dominant term).
      addAgent({
        id: "agent-lq-c", name: "LQ C Gard", host: "lqc-gard.no", trustScore: 0.01,
        umbrellaType: null, contactEmail: "post@lqc-gard.no", description: CLEAN_DESC,
        about: "Vi selger grønnsaker.", products: CLEAN_PRODUCTS,
        fieldProvenance: "{}", verificationStatus: "verified",
      });
      // lq-a / lq-b: SAME trust_score (0.05) — lq-a is dirty (3 junk/thin
      // signals), lq-b is clean (0 signals). lq-a must rank before lq-b.
      addAgent({
        id: "agent-lq-a", name: "LQ A Gard", host: "lqa-gard.no", trustScore: 0.05,
        umbrellaType: null, contactEmail: JUNK_EMAIL_LOCAL + "lqa-gard.no", description: JUNK_DESC,
        about: null, products: "[]",
        fieldProvenance: "{}", verificationStatus: "verified",
      });
      addAgent({
        id: "agent-lq-b", name: "LQ B Gard", host: "lqb-gard.no", trustScore: 0.05,
        umbrellaType: null, contactEmail: "post@lqb-gard.no", description: CLEAN_DESC,
        about: "Vi selger honning.", products: CLEAN_PRODUCTS,
        fieldProvenance: "{}", verificationStatus: "verified",
      });
      // lq-d: worse trust_score than lq-a/lq-b but still under the 0.5
      // threshold, dirty — must rank LAST among the four (trust_score 0.1
      // is the least-bad of the candidates), despite having 3 junk signals
      // like lq-a — proves trust_score beats signal count, not the reverse.
      addAgent({
        id: "agent-lq-d", name: "LQ D Gard", host: "lqd-gard.no", trustScore: 0.1,
        umbrellaType: null, contactEmail: JUNK_EMAIL_LOCAL + "lqd-gard.no", description: JUNK_DESC,
        about: null, products: "[]",
        fieldProvenance: "{}", verificationStatus: "verified",
      });
      // Never a candidate: trust_score >= 0.5 threshold.
      addAgent({
        id: "agent-hightrust", name: "Hightrust Gard", host: "hightrust-gard.no", trustScore: 0.9,
        umbrellaType: null, contactEmail: "post@hightrust-gard.no", description: CLEAN_DESC,
        about: "Bra gård.", products: CLEAN_PRODUCTS,
        fieldProvenance: "{}", verificationStatus: "verified",
      });
      // Never a candidate despite a rock-bottom trust_score: umbrella-tagged.
      addAgent({
        id: "agent-umbrella", name: "Umbrella Gard", host: "umbrella-gard.no", trustScore: 0.02,
        umbrellaType: "market_network", contactEmail: JUNK_EMAIL_LOCAL + "umbrella-gard.no", description: JUNK_DESC,
        about: null, products: "[]",
        fieldProvenance: "{}", verificationStatus: "verified",
      });

      // ── (5)+(6) default-vs-low_quality isolation fixtures ──────────────────
      // Visible to the DEFAULT auto-select (pending_verify, has about, no
      // homepage provenance yet) — must be selected under default mode
      // regardless of its (low) trust_score, proving default ignores
      // trust_score entirely.
      addAgent({
        id: "agent-def-visible", name: "Def Visible Gard", host: "defvisible-gard.no", trustScore: 0.3,
        umbrellaType: null, contactEmail: "post@defvisible-gard.no", description: CLEAN_DESC,
        about: "Gårdsbutikk med egne varer.", products: CLEAN_PRODUCTS,
        fieldProvenance: "{}", verificationStatus: "pending_verify",
      });
      // Invisible to default (already has a homepage source in
      // field_provenance) but a low_quality candidate — low_quality must NOT
      // apply the "lacks homepage provenance" restriction.
      addAgent({
        id: "agent-def-invisible-hashomepage", name: "Def Invisible Homepage Gard",
        host: "definvisible-gard.no", trustScore: 0.3, umbrellaType: null,
        contactEmail: "post@definvisible-gard.no", description: CLEAN_DESC,
        about: "Gårdsbutikk.", products: CLEAN_PRODUCTS,
        fieldProvenance: '{"phone":{"sources":[{"source_type":"homepage","value":"12345678"}]}}',
        verificationStatus: "pending_verify",
      });

      // ── (8) trust-score-refresh fixtures ────────────────────────────────────
      // Thin (about/products empty), trust_score explicitly stamped low —
      // its homepage fetch will yield an extractable phone number. Only the
      // `agents` row is created now (agents-only rows are invisible to every
      // select mode, which all JOIN agent_knowledge) — its agent_knowledge
      // row is inserted later, immediately before the trust-refresh test
      // phase, so the broad (unrestricted) low_quality sweeps run by the
      // ranking/isolation sections above cannot fetch+enrich it first and
      // contaminate the "before" trust_score reading that phase depends on.
      const trustRefreshFixture: Fixture = {
        id: "agent-trust-refresh", name: "Trustrefresh Gard", host: "trustrefresh-gard.no",
        trustScore: 0.2, umbrellaType: null, contactEmail: "post@trustrefresh-gard.no",
        description: CLEAN_DESC, about: null, products: "[]",
        fieldProvenance: "{}", verificationStatus: "pending_verify",
      };
      addAgentRow(trustRefreshFixture);
      // Control: identical setup, used with the DEFAULT (no select) mode to
      // prove trust_score is NOT refreshed outside low_quality mode. Same
      // delayed-knowledge-row treatment as above, same reason.
      const trustControlFixture: Fixture = {
        id: "agent-trust-control", name: "Trustcontrol Gard", host: "trustcontrol-gard.no",
        trustScore: 0.2, umbrellaType: null, contactEmail: "post@trustcontrol-gard.no",
        description: CLEAN_DESC, about: null, products: "[]",
        fieldProvenance: "{}", verificationStatus: "pending_verify",
      };
      addAgentRow(trustControlFixture);

      // ── (7) no_yield backoff fixture ────────────────────────────────────────
      // Same delayed-knowledge-row treatment: its agent_knowledge row is only
      // inserted right before the backoff test phase, so the earlier broad
      // low_quality sweeps can't pre-accumulate no_yield_streak on it and
      // throw off the "exactly 3 consecutive no-yield outcomes" assertion.
      const lqBackoffFixture: Fixture = {
        id: "agent-lq-backoff", name: "LQ Backoff Gard", host: "lqbackoff-gard.no",
        trustScore: 0.15, umbrellaType: null, contactEmail: "post@lqbackoff-gard.no",
        description: CLEAN_DESC, about: null, products: "[]",
        fieldProvenance: "{}", verificationStatus: "verified",
      };
      addAgentRow(lqBackoffFixture);

      // Fresh require so the routers pick up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      const nameByHost: Record<string, string> = {
        "lqc-gard.no": "LQ C Gard", "lqa-gard.no": "LQ A Gard", "lqb-gard.no": "LQ B Gard",
        "lqd-gard.no": "LQ D Gard", "hightrust-gard.no": "Hightrust Gard", "umbrella-gard.no": "Umbrella Gard",
        "defvisible-gard.no": "Def Visible Gard", "definvisible-gard.no": "Def Invisible Homepage Gard",
        "trustrefresh-gard.no": "Trustrefresh Gard", "trustcontrol-gard.no": "Trustcontrol Gard",
        "lqbackoff-gard.no": "LQ Backoff Gard",
      };

      const fetchedHosts: string[] = [];
      (globalThis as any).fetch = async (url: string) => {
        const host = new URL(url).hostname;
        fetchedHosts.push(host);
        const name = nameByHost[host] ?? "Ukjent AS";
        if (host === "trustrefresh-gard.no" || host === "trustcontrol-gard.no") {
          // Mentions the producer AND carries an extractable phone number —
          // yields 'enriched'.
          return {
            ok: true,
            status: 200,
            text: async () =>
              `<html><head><title>${name}</title></head><body><h1>${name}</h1><p>Ring oss på 91 23 45 67</p></body></html>`,
          } as any;
        }
        // Everyone else: mentions the producer (passes ownership guard) but
        // yields nothing extractable — irrelevant to the ranking/isolation
        // assertions, which only inspect WHICH agents were fetched and IN
        // WHAT ORDER, never the outcome.
        return {
          ok: true,
          status: 200,
          text: async () => `<html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
        } as any;
      };

      async function post(body: any): Promise<RouteResult> {
        fetchedHosts.length = 0;
        return callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }

      function agentRow(agentId: string): { trust_score: number } {
        return db.prepare("SELECT trust_score FROM agents WHERE id = ?").get(agentId) as { trust_score: number };
      }

      // ── (9) select:"low_quality" is accepted, not the 400 rejection ────────
      let result = await post({ select: "low_quality", limit: 20 });
      assertEq(result.status, 200, "lq-01: select:\"low_quality\" -> 200 (not the unknown-select 400)");

      // ── (1)+(2)+(3)+(4) ranking / threshold / umbrella / limit ─────────────
      // Restrict this assertion to just the ranking cohort's own hosts (the
      // def-*/trust-*/backoff fixtures are also <0.5 and would otherwise
      // interleave by trust_score — irrelevant to what THIS assertion is
      // checking, so filter them out rather than fight over exact global
      // order).
      const rankingHosts = ["lqc-gard.no", "lqa-gard.no", "lqb-gard.no", "lqd-gard.no", "hightrust-gard.no", "umbrella-gard.no"];
      const rankingOrder = fetchedHosts.filter((h) => rankingHosts.includes(h));
      assertEq(rankingOrder, ["lqc-gard.no", "lqa-gard.no", "lqb-gard.no", "lqd-gard.no"],
        "lq-02: worst-first composite order — lowest trust_score first (lqc), then trust_score ties broken by junk-signal count desc (lqa before lqb), then the least-bad trust_score last (lqd) — hightrust/umbrella never appear");
      assertTrue(!fetchedHosts.includes("hightrust-gard.no"),
        "lq-03: trust_score >= 0.5 is never a low_quality candidate");
      assertTrue(!fetchedHosts.includes("umbrella-gard.no"),
        "lq-04: umbrella-tagged agents are excluded even at a rock-bottom trust_score");

      result = await post({ select: "low_quality", limit: 2 });
      const limitedRanking = fetchedHosts.filter((h) => rankingHosts.includes(h));
      assertEq(limitedRanking, ["lqc-gard.no", "lqa-gard.no"],
        "lq-05: limit is honored under low_quality mode and returns the 2 WORST-ranked candidates");

      // ── (5)+(6) default-vs-low_quality isolation ────────────────────────────
      result = await post({}); // default auto-select, no `select` param
      assertTrue(fetchedHosts.includes("defvisible-gard.no"),
        "lq-06: default auto-select still selects a pending_verify/no-homepage-provenance agent regardless of its (low) trust_score — proves default is trust_score-blind");
      assertTrue(!fetchedHosts.includes("definvisible-gard.no"),
        "lq-07: default auto-select still excludes an agent whose field_provenance already has a homepage source — the pre-existing restriction is UNCHANGED");
      assertTrue(!fetchedHosts.includes("lqc-gard.no") && !fetchedHosts.includes("lqa-gard.no"),
        "lq-08: default auto-select does not pick up the verified-status low_quality-only ranking fixtures (verification_status gate unchanged)");

      result = await post({ select: "low_quality", limit: 20 });
      assertTrue(fetchedHosts.includes("definvisible-gard.no"),
        "lq-09: low_quality mode SELECTS an agent whose field_provenance already has a homepage source — the 'lacks homepage provenance' restriction is deliberately relaxed for this cohort");

      // ── (8) trust_score refresh — low_quality mode only ─────────────────────
      // NOW give trust-refresh/control their agent_knowledge rows — from this
      // point on only, so the broad low_quality sweeps above (lq-01/lq-05/
      // lq-09) played no part in enriching/refreshing them first.
      addKnowledgeRow(trustRefreshFixture);
      addKnowledgeRow(trustControlFixture);
      const beforeRefresh = agentRow("agent-trust-refresh").trust_score;
      result = await post({ agentIds: ["agent-trust-refresh"], select: "low_quality" });
      assertTrue(fetchedHosts.includes("trustrefresh-gard.no"), "lq-10: trust-refresh agent fetched");
      const afterRefresh = agentRow("agent-trust-refresh").trust_score;
      assertTrue(afterRefresh !== beforeRefresh,
        "lq-11: trust_score changed after a low_quality 'enriched' outcome (phone backfilled -> completeness signal moved)");
      // Cross-check against a fresh independent calculation of the SAME
      // formula (trust-score-service.ts) over the now-persisted row, proving
      // the persisted value isn't just "some other number" but the actual
      // recomputed score.
      const { trustScoreService } = require("../services/trust-score-service") as
        typeof import("../services/trust-score-service");
      const recomputedNow = trustScoreService.calculate("agent-trust-refresh");
      assertEq(afterRefresh, recomputedNow,
        "lq-12: persisted trust_score exactly matches trustScoreService.calculate() over the post-write row");

      const beforeControl = agentRow("agent-trust-control").trust_score;
      result = await post({ agentIds: ["agent-trust-control"] }); // default mode — no `select`
      assertTrue(fetchedHosts.includes("trustcontrol-gard.no"), "lq-13: trust-control agent fetched");
      const afterControl = agentRow("agent-trust-control").trust_score;
      assertEq(afterControl, beforeControl,
        "lq-14: trust_score is UNCHANGED after a default-mode (non-low_quality) 'enriched' outcome — the refresh is gated to select:\"low_quality\" only");

      // ── (7) no_yield backoff also excludes low_quality candidates ──────────
      // NOW give the backoff fixture its agent_knowledge row — from this
      // point on only, so the broad low_quality sweeps above couldn't
      // pre-accumulate no_yield_streak on it.
      addKnowledgeRow(lqBackoffFixture);
      await post({ agentIds: ["agent-lq-backoff"], select: "low_quality" });
      await post({ agentIds: ["agent-lq-backoff"], select: "low_quality" });
      await post({ agentIds: ["agent-lq-backoff"], select: "low_quality" });
      const backoffRow = db.prepare(
        "SELECT no_yield_streak, last_enrichment_attempt_at FROM agent_knowledge WHERE agent_id = ?",
      ).get("agent-lq-backoff") as { no_yield_streak: number; last_enrichment_attempt_at: string };
      assertEq(backoffRow.no_yield_streak, 3, "lq-15: 3 consecutive no-yield outcomes -> no_yield_streak=3");

      result = await post({ select: "low_quality", limit: 20 });
      assertTrue(!fetchedHosts.includes("lqbackoff-gard.no"),
        "lq-16: an agent with no_yield_streak>=3 and a RECENT attempt is excluded from low_quality selection too (reuses the existing backoff, not a new mechanism)");

      db.prepare(
        "UPDATE agent_knowledge SET last_enrichment_attempt_at = datetime('now','-15 days') WHERE agent_id = 'agent-lq-backoff'",
      ).run();
      result = await post({ select: "low_quality", limit: 20 });
      assertTrue(fetchedHosts.includes("lqbackoff-gard.no"),
        "lq-17: once the backoff window has passed, the agent is selectable again under low_quality mode too");

      // ── (10) GET /admin/outreach-ready-pool/stats -> low_quality_cohort ────
      delete require.cache[require.resolve("./admin-outreach-pool")];
      const statsRouteMod = require("./admin-outreach-pool");
      const statsRouter = statsRouteMod.default;
      const statsResult = await callRoute(statsRouter, {
        method: "GET",
        url: "/stats",
        headers: { "x-admin-key": testKey },
      });
      assertEq(statsResult.status, 200, "lq-18: GET /admin/outreach-ready-pool/stats -> 200");
      assertTrue(!!statsResult.body?.low_quality_cohort,
        "lq-19: response includes a low_quality_cohort object");
      // Every fixture with trust_score < 0.5, non-umbrella, and a homepage on
      // file counts toward `total` regardless of verification_status/backoff
      // (a "how big is the universe" gauge, not an exact "would be selected
      // right now" count — see the comment on this block in
      // admin-outreach-pool.ts): agent-lq-c/a/b/d, agent-def-visible,
      // agent-def-invisible-hashomepage, agent-trust-refresh,
      // agent-trust-control, agent-lq-backoff = 9. agent-hightrust (>=0.5)
      // and agent-umbrella (umbrella-tagged) are excluded.
      assertEq(statsResult.body.low_quality_cohort.total, 9,
        "lq-20: low_quality_cohort.total counts every <0.5-trust_score, non-umbrella, has-a-homepage agent");
      // junk_email fires for: agent-lq-a, agent-lq-d (noreply@ pattern).
      // agent-trust-refresh/control/def-*/lq-backoff/lq-c/lq-b all have a
      // normal post@ address.
      assertEq(statsResult.body.low_quality_cohort.junk_email, 2,
        "lq-21: junk_email breakdown matches isJunkEmail applied to the same candidate set");
      // junk_description fires for: agent-lq-a, agent-lq-d ("Skip to
      // content" boilerplate).
      assertEq(statsResult.body.low_quality_cohort.junk_description, 2,
        "lq-22: junk_description breakdown matches isJunkDescription applied to the same candidate set");
      // thin (about or products empty) fires for: agent-lq-a, agent-lq-d,
      // agent-def... no — def-visible/def-invisible-hashomepage both have
      // about+products filled. agent-trust-refresh, agent-trust-control,
      // agent-lq-backoff all have about=NULL/products='[]' -> thin. So:
      // lq-a, lq-d, trust-refresh, trust-control, lq-backoff = 5.
      assertEq(statsResult.body.low_quality_cohort.thin, 5,
        "lq-23: thin breakdown counts agents with an empty about or an empty products list");
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED;
      else process.env.HOMEPAGE_PARKING_DISABLED = prevParkingDisabled;
      if (prevNoYieldBackoffDays === undefined) delete process.env.NO_YIELD_BACKOFF_DAYS;
      else process.env.NO_YIELD_BACKOFF_DAYS = prevNoYieldBackoffDays;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageProvenanceLowQualitySelectorTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

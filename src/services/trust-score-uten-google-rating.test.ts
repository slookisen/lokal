/**
 * trust-score-uten-google-rating.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt,
 * S4-A1b (Daniel's decision 2=A, after the terms check
 * protocols/juridisk-sjekk-google-ratinger-2026-10-17.md).
 *
 * trust_score gets its own community signal: first-party reviews only, and
 * none exist yet, so every agent gets the neutral 0.3 an agent without a
 * rating already had. The stored Google rating is no longer read by
 * trust_score, no longer shown in GET /agents/:id/trust, and no longer passed
 * on by the finn-tannlege REST answers. The stored values stay untouched.
 * Groups, by prefix:
 *   T   trustScoreService on the production schema: a Google rating (high,
 *       low, without a count, plus Tripadvisor and Google entries in
 *       external_reviews) changes no signal and no score; changing the
 *       stored rating changes nothing (the spec's acceptance test); the
 *       weights are unchanged and community is 0.3; recalculateAll and the
 *       chunked variant store the same; the service source reads no
 *       third-party rating column;
 *   P   GET /api/marketplace/agents/:id/trust (public): community detail is
 *       a fixed text without the rating, the count or «Google»;
 *   B   boot-trust-recalc stamps per TRUST_SCORE_FORMULA_VERSION: the first
 *       boot after this deploy recalculates although the unversioned stamp
 *       is < 24 h old, a restart on the same version skips, a later version
 *       runs again; end to end it rewrites a stale stored score; index.ts
 *       passes the version;
 *   R   GET /api/tannlege/agents and /agents/:id (by id and org_nr): no
 *       rating, rating_count or rating_source; every other key unchanged.
 *
 * Harnesses: the production schema in an in-memory DB and the real routers
 * through router.handle() (google-rating-utfasing-visning-og-deling.test.ts),
 * and the dental router with DENTAL_DB_PATH=":memory:"
 * (dental-agent-provenance.test.ts). The DB, module cache and env are
 * restored in finally.
 *
 * Exported runTrustScoreUtenGoogleRatingTests({log}) -> TestSummary; wired
 * into tests/test.ts.
 * Standalone: npx tsx src/services/trust-score-uten-google-rating.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { trustScoreService, TRUST_SCORE_FORMULA_VERSION } from "./trust-score-service";
import {
  scheduleBootTrustRecalc, trustRecalcJobKey, runExclusiveBootJob, getJobLastCompletedAt, markJobCompleted,
  TRUST_RECALC_JOB,
} from "./boot-job-gate";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

/** Drives one request through an express Router directly — no HTTP server. */
function callRoute(router: any, url: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET", url, originalUrl: url, path: url.split("?")[0], params: {}, query: {}, headers: {},
      ip: "127.0.0.1", lang: "no", get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      set() { return this; },
      vary() { return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined });
    });
  });
}

/** Every key path in a JSON value, e.g. "agents[0].rating". */
function keyPaths(value: unknown, prefix = "", out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => keyPaths(v, `${prefix}[${i}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

/** Key paths that carry a stored rating: the RFB and the dental column/field names. */
function ratingPaths(value: unknown): string[] {
  return keyPaths(value).filter((p) =>
    /(^|\.)(googleRating|googleReviewCount|google_rating|google_review_count|rating|rating_count|rating_source)$/.test(p)
    || /(^|\.)ratings\.google(\.|$)/.test(p));
}

/** trust-score-service's community detail since S4-A1b. */
const COMMUNITY_DETAIL = "Ingen egne omtaler på Rett fra Bonden ennå – samme nøytrale verdi for alle";

const UNRATED = "a1b00000-0000-4000-8000-000000000001";
const RATED_HIGH = "a1b00000-0000-4000-8000-000000000002";     // Google 4.9 / 2371 (v2 community 0.975)
const RATED_LOW = "a1b00000-0000-4000-8000-000000000003";      // Google 1.2 / 2371 (v2 community 0.05)
const RATED_NO_COUNT = "a1b00000-0000-4000-8000-000000000004"; // Google 4.3 / NULL (v2 community 0.5)
const SEEDED_COUNT = "2371";

const SEED: Array<{ id: string; name: string; rating: number | null; count: number | null; tripadvisor: number | null; external: string }> = [
  { id: UNRATED, name: "Uvurdert Gård A1b", rating: null, count: null, tripadvisor: null, external: "[]" },
  { id: RATED_HIGH, name: "Høy Rating Gård A1b", rating: 4.9, count: 2371, tripadvisor: 4.8,
    external: JSON.stringify([{ source: "Google", text: "Veldig bra", rating: 5 }]) },
  { id: RATED_LOW, name: "Lav Rating Gård A1b", rating: 1.2, count: 2371, tripadvisor: null, external: "[]" },
  { id: RATED_NO_COUNT, name: "Rating Uten Antall A1b", rating: 4.3, count: null, tripadvisor: null, external: "[]" },
];

/** Identical agents apart from the rating columns: same profile, same timestamps, same metrics. */
function seed(db: Database.Database, nowIso: string): void {
  const agentStmt = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            60.79, 11.07, 'Hamar', '["vegetables"]', '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, ?, ?)
  `);
  const knowledgeStmt = db.prepare(`
    INSERT INTO agent_knowledge
      (agent_id, address, postal_code, website, products, about, google_rating, google_review_count,
       tripadvisor_rating, external_reviews, owner_updated_at, updated_at)
    VALUES (?, 'Gårdsvegen 1', '2318', ?, '[{"name":"Poteter","category":"vegetables"}]', 'Poteter og gulrøtter fra Hamar.',
            ?, ?, ?, ?, ?, ?)
  `);
  const metricsStmt = db.prepare(`
    INSERT INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen, last_interaction_at)
    VALUES (?, 40, 6, 2, ?)
  `);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`, `key-${s.id}`, nowIso, nowIso);
    knowledgeStmt.run(s.id, `https://${s.id}.example.no`, s.rating, s.count, s.tripadvisor, s.external, nowIso, nowIso);
    metricsStmt.run(s.id, nowIso);
  }
}

/** Source with // and /* *\/ comments removed, so a column named in a comment does not count as read. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export async function runTrustScoreUtenGoogleRatingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    assertTrue(ok, ok ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); } catch (err) {
      failed++;
      failures.push(`✗ ${name}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // T, P, B — RFB trust_score, /trust and the boot recalculation
  // ══════════════════════════════════════════════════════════════
  {
    const prevDb = __peekDbForTesting();
    const db = new Database(":memory:");
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    seed(db, new Date().toISOString());
    const prevLog = console.log;
    if (!log) console.log = () => { /* silence registry chatter */ };
    try {
      const signalsOf = (id: string) => trustScoreService.getBreakdown(id).signals;
      const valuesOf = (id: string) => {
        const s = signalsOf(id);
        return [s.verification.value, s.completeness.value, s.freshness.value, s.interaction.value, s.community.value];
      };
      const storedScore = (id: string) => (db.prepare("SELECT trust_score FROM agents WHERE id = ?").get(id) as any)?.trust_score;
      const setRating = (id: string, rating: number | null, count: number | null) =>
        db.prepare("UPDATE agent_knowledge SET google_rating = ?, google_review_count = ? WHERE agent_id = ?").run(rating, count, id);

      await section("T: trust_score without the Google rating", () => {
        const stored = db.prepare("SELECT google_rating, google_review_count, tripadvisor_rating FROM agent_knowledge WHERE agent_id = ?").get(RATED_HIGH) as any;
        assertEq([stored?.google_rating, stored?.google_review_count, stored?.tripadvisor_rating], [4.9, 2371, 4.8],
          "T0: (the stored ratings are there, and stay untouched)");

        const base = trustScoreService.calculate(UNRATED);
        const baseValues = valuesOf(UNRATED);
        assertTrue(base > 0 && base < 1, `T0: the unrated fixture has a real score (${base})`);
        for (const id of [RATED_HIGH, RATED_LOW, RATED_NO_COUNT]) {
          assertEq(trustScoreService.calculate(id), base, `T1 ${id}: same trust_score as the identical agent without a rating`);
          assertEq(valuesOf(id), baseValues, `T2 ${id}: every signal value is the unrated agent's (no double counting elsewhere)`);
        }
        for (const s of SEED) {
          const c = signalsOf(s.id).community;
          assertEq([c.value, c.weight], [0.3, 0.1], `T3 ${s.id}: community is the neutral 0.3 at weight 0.1`);
        }

        // The spec's acceptance test: a change in google_rating does not change trust_score.
        const before = trustScoreService.calculate(RATED_HIGH);
        for (const [rating, count] of [[5, 9000], [1, 9000], [null, null], [3.3, 7], [4.9, 2371]] as Array<[number | null, number | null]>) {
          setRating(RATED_HIGH, rating, count);
          assertEq(trustScoreService.calculate(RATED_HIGH), before, `T4 google_rating ${rating}/${count}: calculate() unchanged`);
          assertEq(trustScoreService.getBreakdown(RATED_HIGH).score, before, `T4 google_rating ${rating}/${count}: getBreakdown().score unchanged`);
          assertEq(trustScoreService.update(RATED_HIGH), before, `T4 google_rating ${rating}/${count}: update() persists the same score`);
          assertEq(storedScore(RATED_HIGH), before, `T4 google_rating ${rating}/${count}: agents.trust_score is the same`);
        }

        // Weights unchanged; community enters as 0.1 × 0.3.
        const [v, c, f, i] = baseValues;
        const expected = Math.round(Math.min(1, Math.max(0, v * 0.3 + c * 0.2 + f * 0.2 + i * 0.2 + 0.3 * 0.1)) * 1000) / 1000;
        assertEq(base, expected, "T5: score = 0.3·verification + 0.2·completeness + 0.2·freshness + 0.2·interaction + 0.1·0.3");

        db.prepare("UPDATE agents SET trust_score = 0.999").run();
        const all = trustScoreService.recalculateAll();
        assertEq(all.updated, SEED.length, "T6: recalculateAll() updates every active agent");
        assertEq(SEED.map((s) => storedScore(s.id)), SEED.map(() => base), "T6: recalculateAll() stores the same score for rated and unrated agents");
        assertTrue(Object.values(all.distribution).reduce((a, b) => a + b, 0) === SEED.length, "T6: the distribution counts every agent once");

        const src = codeOnly(fs.readFileSync(path.join(__dirname, "trust-score-service.ts"), "utf8"));
        assertTrue(!/google_rating|google_review_count|tripadvisor_rating|external_reviews|googleRating/.test(src),
          "T7: trust-score-service.ts code reads no Google/Tripadvisor rating column (comments aside)");
        assertTrue(!/Google:/.test(src), "T7: and builds no «Google: x/5» text");
      });

      await section("T: chunked recalculation", async () => {
        db.prepare("UPDATE agents SET trust_score = 0.999").run();
        const r = await trustScoreService.recalculateAllChunked({ chunkSize: 2, pauseMs: 0 });
        const base = trustScoreService.calculate(UNRATED);
        assertEq([r.updated, r.chunks], [SEED.length, 2], "T8: recalculateAllChunked() updates every agent in slices");
        assertEq(SEED.map((s) => storedScore(s.id)), SEED.map(() => base), "T8: the chunked variant stores the same scores");
      });

      await section("P: GET /agents/:id/trust", async () => {
        const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
        try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
        const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
        marketplaceRegistry._agentsCache = null;
        const router = (require("../routes/marketplace") as typeof import("../routes/marketplace")).default as any;
        const base = trustScoreService.calculate(UNRATED);
        for (const s of SEED) {
          const r = await callRoute(router, `/agents/${s.id}/trust`);
          assertEq([r.status, r.body?.success], [200, true], `P1 ${s.id}: GET /agents/:id/trust → 200`);
          const community = r.body?.data?.signals?.community;
          assertEq(community, { value: 0.3, weight: 0.1, detail: COMMUNITY_DETAIL }, `P1 ${s.id}: community is 0.3 with the fixed detail`);
          assertEq(r.body?.data?.score, base, `P2 ${s.id}: the breakdown's score is the unrated agent's`);
          const json = JSON.stringify(r.body);
          assertEq(ratingPaths(r.body), [], `P3 ${s.id}: no rating key in the answer`);
          assertTrue(!json.includes("Google") && !json.includes(SEEDED_COUNT) && !/anmeldelse/.test(json),
            `P3 ${s.id}: no «Google», no seeded count (${SEEDED_COUNT}) and no «anmeldelser» (also no invented 0) anywhere in the answer`);
          if (s.rating !== null) {
            const details = Object.values(r.body?.data?.signals ?? {}).map((x: any) => String(x?.detail ?? "")).join(" | ");
            assertTrue(!details.includes(String(s.rating)), `P3 ${s.id}: the stored rating ${s.rating} is in no signal detail`);
          }
        }
        marketplaceRegistry._agentsCache = null;
      });

      await section("B: boot recalculation per formula version", async () => {
        assertEq(trustRecalcJobKey(TRUST_SCORE_FORMULA_VERSION), `${TRUST_RECALC_JOB}@${TRUST_SCORE_FORMULA_VERSION}`,
          "B1: the stamp key carries the formula version");
        assertTrue(TRUST_SCORE_FORMULA_VERSION.length > 0 && trustRecalcJobKey(TRUST_SCORE_FORMULA_VERSION) !== TRUST_RECALC_JOB,
          "B1: and differs from the unversioned key prod has stamped so far");

        const sdb = new Database(":memory:");
        const now = new Date("2026-10-18T08:00:00Z");
        const timers: Array<() => void> = [];
        const fakeSet = (fn: () => void) => { timers.push(fn); return 0; };
        const logs: string[] = [];
        let recalcs = 0;
        const boot = (formulaVersion: string) => {
          scheduleBootTrustRecalc({
            getDb: () => sdb, formulaVersion, recalc: async () => { recalcs++; }, log: (m) => logs.push(m),
            now: () => now, setTimeoutFn: fakeSet,
          });
          timers[timers.length - 1]();
          return runExclusiveBootJob(() => undefined);
        };
        const oneHourAgo = new Date(now.getTime() - 3600_000);
        markJobCompleted(sdb, TRUST_RECALC_JOB, oneHourAgo); // the stamp a v2 boot wrote an hour ago

        await boot(TRUST_SCORE_FORMULA_VERSION);
        assertEq(recalcs, 1, "B2: the first boot with the new version recalculates although the v2 stamp is 1 h old");
        assertEq(getJobLastCompletedAt(sdb, trustRecalcJobKey(TRUST_SCORE_FORMULA_VERSION))?.toISOString(), now.toISOString(),
          "B2: and stamps the versioned key");
        assertEq(getJobLastCompletedAt(sdb, TRUST_RECALC_JOB)?.toISOString(), oneHourAgo.toISOString(), "B2: the unversioned stamp is left as it was");

        await boot(TRUST_SCORE_FORMULA_VERSION);
        assertEq(recalcs, 1, "B3: a restart on the same version within 24 h skips");
        assertTrue(logs.some((l) => l.includes("skipped") && l.includes(TRUST_SCORE_FORMULA_VERSION)), "B3: the skip log names the formula version");

        await boot("2099-01-01-next-formula");
        assertEq(recalcs, 2, "B4: a later version bump recalculates again, also right after the current one ran");
        sdb.close();

        // End to end on the seeded DB: a stale stored score (v2-ish) is rewritten by the boot job.
        db.prepare("UPDATE agents SET trust_score = 0.999 WHERE id = ?").run(RATED_HIGH);
        scheduleBootTrustRecalc({
          getDb: () => db, formulaVersion: TRUST_SCORE_FORMULA_VERSION, log: () => undefined, now: () => now, setTimeoutFn: fakeSet,
          recalc: () => trustScoreService.recalculateAllChunked({ chunkSize: 20, pauseMs: 0 }),
        });
        timers[timers.length - 1]();
        await runExclusiveBootJob(() => undefined);
        assertEq(storedScore(RATED_HIGH), trustScoreService.calculate(UNRATED), "B5: the boot job stores the v3 score over the stale one");

        const idx = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
        assertTrue(/import \{[^}]*\bTRUST_SCORE_FORMULA_VERSION\b[^}]*\} from "\.\/services\/trust-score-service"/.test(idx),
          "B6: index.ts imports TRUST_SCORE_FORMULA_VERSION from trust-score-service");
        assertTrue(/scheduleBootTrustRecalc\(\{[\s\S]{0,300}?formulaVersion: TRUST_SCORE_FORMULA_VERSION,/.test(idx),
          "B6: index.ts passes it to scheduleBootTrustRecalc");
      });
    } catch (err) {
      failed++;
      failures.push(`RFB section: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      console.log = prevLog;
      try {
        const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
        marketplaceRegistry._agentsCache = null;
      } catch { /* ignore */ }
      __setDbForTesting(prevDb as any);
      db.close();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // R — finn-tannlege REST answers
  // ══════════════════════════════════════════════════════════════
  {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../routes/dental"),
      require.resolve("./dental-store"),
    ]);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const ddb = dbFactory.getDb("dental");
      const dstore = require("./dental-store") as typeof import("./dental-store");
      const { isDisplayablePhone } = require("./contact-normalizer") as typeof import("./contact-normalizer");
      const dentalRouter = (require("../routes/dental") as typeof import("../routes/dental")).default as any;

      const clinic = (navn: string, orgNr: string, rating: number | null, count: number | null): string => {
        const id = dstore.createDentalAgent({
          navn, org_nr: orgNr, adresse: "Strandgata 4", postnummer: "2317", poststed: "HAMAR", fylke: "Innlandet",
          telefon: "+47 62 51 00 00", hjemmeside: `https://${orgNr}.example.no`,
        } as any);
        ddb.prepare("UPDATE dental_agents SET rating = ?, rating_count = ?, rating_source = ? WHERE id = ?")
          .run(rating, count, rating === null ? null : "google_places|2026-06-27", id);
        return id;
      };
      const rated = clinic("Hamar Tannklinikk A1b AS", "918800201", 4.7, 2371);
      const ratedZero = clinic("Stange Tannklinikk A1b AS", "918800202", 4.2, 0);
      const unrated = clinic("Løten Tannklinikk A1b AS", "918800203", null, null);
      const ids = [rated, ratedZero, unrated];

      /**
       * What the route answered before S4-A1b, less the three rating keys.
       * Same dev-request, A4-D: a public answer also leaves out field_provenance
       * (it holds the Places values) and Stage V's pending map (a read-only
       * side column of the hydrated row). Nothing here comes from Places, so
       * every other value is as stored. A2A dev-request
       * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon (F2-S8): nor the
       * side values the «Verifisert» claim reads.
       */
      const expectedRow = (id: string): Record<string, unknown> => {
        const {
          rating: _r,
          rating_count: _c,
          rating_source: _s,
          field_provenance: _p,
          stage_v_pending_correction: _v,
          brreg_status: _b,
          website_ownership: _w,
          rich_field_count: _n,
          ...row
        } = dstore.getDentalAgentById(id) as Record<string, unknown>;
        return {
          ...row,
          telefon: isDisplayablePhone(row.telefon as string | null) ? row.telefon : null,
          mobil: isDisplayablePhone(row.mobil as string | null) ? row.mobil : null,
        };
      };
      const noRating = (body: unknown, label: string) => {
        assertEq(ratingPaths(body), [], `${label}: no rating, rating_count or rating_source key`);
        const json = JSON.stringify(body);
        assertTrue(!json.includes(SEEDED_COUNT) && !json.includes("google_places|"), `${label}: neither the seeded count nor the rating source is passed on`);
      };

      await section("R: GET /api/tannlege/agents", async () => {
        const stored = ddb.prepare("SELECT rating, rating_count, rating_source FROM dental_agents WHERE id = ?").get(rated) as any;
        assertEq([stored?.rating, stored?.rating_count, stored?.rating_source], [4.7, 2371, "google_places|2026-06-27"],
          "R0: (the clinic's stored rating is there, and stays untouched)");
        const r = await callRoute(dentalRouter, "/agents");
        assertEq(r.status, 200, "R1: GET /agents → 200");
        const listed = (r.body?.agents ?? []) as Array<Record<string, unknown>>;
        assertEq(listed.map((a) => a.id).filter((id) => ids.includes(id as string)).sort(), [...ids].sort(), "R1: all three clinics are listed");
        noRating(r.body, "R1 list");
        for (const a of listed.filter((x) => ids.includes(x.id as string))) {
          assertEq(a, expectedRow(a.id as string), `R2 ${a.navn}: every other key and value is what the list gave before`);
        }
      });

      await section("R: GET /api/tannlege/agents/:id", async () => {
        for (const id of ids) {
          const r = await callRoute(dentalRouter, `/agents/${id}`);
          assertEq(r.status, 200, `R3 ${id}: GET /agents/:id → 200`);
          noRating(r.body, `R3 ${id}`);
          assertEq(r.body?.agent, expectedRow(id), `R4 ${id}: every other key and value is what the route gave before`);
        }
        const byOrg = await callRoute(dentalRouter, "/agents/918800201");
        assertEq([byOrg.status, byOrg.body?.agent?.id], [200, rated], "R5: the org_nr lookup finds the rated clinic");
        noRating(byOrg.body, "R5 org_nr lookup");
      });
    } catch (err) {
      failed++;
      failures.push(`dental section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── trust_score without Google ratings, /trust and dental REST without them (dev-request 2026-10-16 S4-A1b) ──");
  runTrustScoreUtenGoogleRatingTests({ log: true }).then((r) => {
    console.log(`\ntrust-score-uten-google-rating: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

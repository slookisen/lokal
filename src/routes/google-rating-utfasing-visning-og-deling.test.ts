/**
 * google-rating-utfasing-visning-og-deling.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt,
 * S4-A1a (Daniel's decision 2=A, after the terms check
 * protocols/juridisk-sjekk-google-ratinger-2026-10-17.md).
 *
 * The stored Google ratings are no longer shown on finn-tannlege.com and no
 * longer passed on by any RFB REST or A2A answer. The values themselves stay
 * in the database untouched, and trust_score is not part of this slice
 * (S4-A1b). Groups, by prefix:
 *   K   knowledgeService.getAgentInfo: no googleRating/googleReviewCount and
 *       no ratings.google (so no invented `reviews: 0` either); a
 *       Tripadvisor rating is kept as before; the site's own pages still get
 *       the stored values with { withGoogleRating: true };
 *   R   REST: GET /api/marketplace/agents/:id/card and /agents/:id/info;
 *   A   A2A: GET /agents/:id/agent.json (x-knowledge) and JSON-RPC agent/info;
 *   D   finn-tannlege /klinikk/id/:id: no rating badge and no rating info row
 *       in the default mode; with the test override 'attributed' both go
 *       through formatRatingDisplay (Google named, never "0 anmeldelser").
 * The RFB pages (producer profile and both rich homepage cards) in the
 * default mode are covered by rfb-rating-visning-kildeangivelse.test.ts.
 *
 * Every answer is also checked for the seeded review count (2371), so a
 * rating that came back under another key would fail too. getAgentInfo is
 * what the MCP resource lokal://producers/{agentId} serialises as well (K
 * covers it; the resource is registered under that literal URI, not as a
 * template, so it cannot be read for a real producer today).
 *
 * Harnesses: the production schema in an in-memory DB and the real routers
 * through router.handle() (knowledge-remaining-readers.test.ts), and the
 * dental pages with DENTAL_DB_PATH=":memory:" (rfb-jsonld-ingen-
 * tredjepartsrating.test.ts). The DB, store producers, module cache and the
 * display mode are restored in finally.
 *
 * Exported runGoogleRatingUtfasingTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 * Standalone: npx tsx src/routes/google-rating-utfasing-visning-og-deling.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

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
function callRoute(router: any, opts: { method?: string; url: string; body?: any }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url.split("?")[0],
      query: {},
      headers: {},
      body: opts.body,
      ip: "127.0.0.1",
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
      redirect(code: number) { resolve({ status: code, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined });
    });
  });
}

/** Every key path in a JSON value, e.g. "knowledge.ratings.google.score". */
function keyPaths(value: unknown, prefix = "", out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => keyPaths(v, `${prefix}[${i}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      keyPaths(v, path, out);
    }
  }
  return out;
}

/** The key paths that carry a Google rating: googleRating/googleReviewCount (any case form) or a `google` entry under ratings. */
function googleRatingPaths(value: unknown): string[] {
  return keyPaths(value).filter((p) => /(^|\.)(googleRating|googleReviewCount|google_rating|google_review_count)$/.test(p) || /(^|\.)ratings\.google(\.|$)/.test(p));
}

const RATED = "5a1a0000-0000-4000-8000-000000000001";        // Google 4.3 / 2371
const RATED_NO_COUNT = "5a1a0000-0000-4000-8000-000000000002"; // Google 4.3 / NULL (used to become reviews: 0)
const RATED_TRIPADVISOR = "5a1a0000-0000-4000-8000-000000000003"; // Google 4.3 / 2371 + Tripadvisor 4.1
const UNRATED = "5a1a0000-0000-4000-8000-000000000004";
const SEEDED_COUNT = "2371";

const SEED: Array<{ id: string; name: string; rating: number | null; count: number | null; tripadvisor: number | null }> = [
  { id: RATED, name: "Rating Gård Fixture", rating: 4.3, count: 2371, tripadvisor: null },
  { id: RATED_NO_COUNT, name: "Rating Uten Antall Fixture", rating: 4.3, count: null, tripadvisor: null },
  { id: RATED_TRIPADVISOR, name: "Rating Tripadvisor Fixture", rating: 4.3, count: 2371, tripadvisor: 4.1 },
  { id: UNRATED, name: "Uvurdert Gård Fixture", rating: null, count: null, tripadvisor: null },
];

function seed(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            60.79, 11.07, 'Hamar', '["vegetables"]', '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  const knowledgeStmt = db.prepare(`
    INSERT INTO agent_knowledge (agent_id, address, postal_code, website, products, google_rating, google_review_count, tripadvisor_rating)
    VALUES (?, 'Gårdsvegen 1', '2318', ?, '[{"name":"Poteter","category":"vegetables"}]', ?, ?, ?)
  `);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`, `key-${s.id}`);
    knowledgeStmt.run(s.id, `https://${s.id}.example.no`, s.rating, s.count, s.tripadvisor);
  }
}

/** The legacy store producer agentCardService.generateCard needs for GET /agents/:id/agent.json. */
function storeProducer(id: string, name: string): any {
  const now = new Date().toISOString();
  return {
    id, name, description: "", type: "farm",
    location: { lat: 60.79, lng: 11.07, city: "Hamar" },
    openingHours: [], tags: [], certifications: [], deliveryOptions: ["pickup"],
    trustScore: 0.5, totalTransactions: 0, availabilityAccuracy: 0.5,
    registeredAt: now, lastActiveAt: now, isActive: true,
  };
}

export async function runGoogleRatingUtfasingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  /** No Google rating under any key, and not the seeded count either. */
  function assertNoGoogleRating(value: unknown, label: string): void {
    assertEq(googleRatingPaths(value), [], `${label}: no googleRating/googleReviewCount/ratings.google key`);
    assertTrue(!JSON.stringify(value ?? null).includes(SEEDED_COUNT), `${label}: the seeded review count (${SEEDED_COUNT}) is not passed on`);
  }
  async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); } catch (err) {
      failed++;
      failures.push(`✗ ${name}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
  }

  const policy = require("../services/structured-data-policy") as typeof import("../services/structured-data-policy");

  // ══════════════════════════════════════════════════════════════
  // K, R, A — RFB answers
  // ══════════════════════════════════════════════════════════════
  {
    const prevDb = __peekDbForTesting();
    const db = new Database(":memory:");
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    seed(db);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const { store } = require("../services/store") as typeof import("../services/store");
    for (const s of SEED) store.addProducer(storeProducer(s.id, s.name));

    const prevLog = console.log;
    if (!log) console.log = () => { /* silence registry / interaction chatter */ };
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      marketplaceRegistry._agentsCache = null;
      const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");

      await section("K: getAgentInfo", () => {
        const stored = db.prepare("SELECT google_rating, google_review_count FROM agent_knowledge WHERE agent_id = ?").get(RATED) as any;
        assertEq([stored?.google_rating, stored?.google_review_count], [4.3, 2371], "K0: (the stored rating is there, and stays untouched)");
        for (const id of [RATED, RATED_NO_COUNT, RATED_TRIPADVISOR, UNRATED]) {
          const info = knowledgeService.getAgentInfo(id);
          assertTrue(!!info, `K1 ${id}: getAgentInfo returns the agent`);
          assertTrue(!!info && !("googleRating" in info.knowledge) && !("googleReviewCount" in info.knowledge),
            `K1 ${id}: knowledge has no googleRating/googleReviewCount key`);
          assertNoGoogleRating(info, `K1 ${id}`);
        }
        assertEq(knowledgeService.getAgentInfo(RATED)?.knowledge.ratings, undefined, "K2: a Google-only rating gives no ratings object");
        assertEq(knowledgeService.getAgentInfo(RATED_NO_COUNT)?.knowledge.ratings, undefined,
          "K3: a Google rating without a count gives no ratings object (it used to invent reviews: 0)");
        assertEq(knowledgeService.getAgentInfo(RATED_TRIPADVISOR)?.knowledge.ratings, { tripadvisor: { score: 4.1 } },
          "K4: a Tripadvisor rating is kept as before; only the Google entry is gone");
        const own = knowledgeService.getAgentInfo(RATED, { withGoogleRating: true })?.knowledge;
        assertEq([own?.googleRating, own?.googleReviewCount], [4.3, 2371],
          "K5: the site's own pages still get the stored values (withGoogleRating); RATING_DISPLAY_MODE decides there");
        assertEq(own?.ratings, undefined, "K6: withGoogleRating does not bring ratings.google back");
        assertEq(knowledgeService.getAgentInfo(RATED, { withGoogleRating: false })?.knowledge.googleRating, undefined,
          "K7: withGoogleRating: false is the same as leaving it out");
      });

      const marketplaceRouter = (require("./marketplace") as typeof import("./marketplace")).default as any;
      await section("R: REST card and info", async () => {
        for (const id of [RATED, RATED_NO_COUNT, RATED_TRIPADVISOR]) {
          const card = await callRoute(marketplaceRouter, { url: `/agents/${id}/card` });
          assertEq(card.status, 200, `R1 ${id}: GET /agents/:id/card → 200`);
          assertTrue(card.body?.contact?.address === "Gårdsvegen 1", `R1 ${id}: the card is the enriched one (contact block present)`);
          assertTrue(!!card.body && !("googleRating" in card.body) && !("googleReviewCount" in card.body),
            `R1 ${id}: card has no googleRating/googleReviewCount (nor the invented 0)`);
          assertNoGoogleRating(card.body, `R1 ${id} card`);

          const info = await callRoute(marketplaceRouter, { url: `/agents/${id}/info` });
          assertEq(info.status, 200, `R2 ${id}: GET /agents/:id/info → 200`);
          assertTrue(info.body?.data?.knowledge?.address === "Gårdsvegen 1", `R2 ${id}: /info carries the knowledge block`);
          assertNoGoogleRating(info.body, `R2 ${id} info`);
        }
        const ta = await callRoute(marketplaceRouter, { url: `/agents/${RATED_TRIPADVISOR}/info` });
        assertEq(ta.body?.data?.knowledge?.ratings, { tripadvisor: { score: 4.1 } }, "R3: /info keeps the Tripadvisor rating as before");
      });

      const a2aRouter = (require("./a2a") as typeof import("./a2a")).default as any;
      await section("A: A2A agent.json and agent/info", async () => {
        for (const id of [RATED, RATED_NO_COUNT]) {
          const card = await callRoute(a2aRouter, { url: `/agents/${id}/agent.json` });
          assertEq(card.status, 200, `A1 ${id}: GET /agents/:id/agent.json → 200`);
          const xk = card.body?.["x-knowledge"];
          assertTrue(xk?.address === "Gårdsvegen 1", `A1 ${id}: x-knowledge is there`);
          assertTrue(!!xk && !("googleRating" in xk) && !("googleReviewCount" in xk), `A1 ${id}: x-knowledge has no googleRating/googleReviewCount`);
          assertNoGoogleRating(card.body, `A1 ${id} agent.json`);

          const rpc = await callRoute(a2aRouter, {
            method: "POST", url: "/a2a",
            body: { jsonrpc: "2.0", method: "agent/info", params: { agentId: id }, id: `info-${id}` },
          });
          const data = rpc.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
          assertTrue(data?.agent?.id === id && data?.knowledge?.address === "Gårdsvegen 1", `A2 ${id}: agent/info answers with the agent's knowledge`);
          assertNoGoogleRating(rpc.body, `A2 ${id} agent/info`);
        }
      });

    } catch (err) {
      failed++;
      failures.push(`RFB section: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      console.log = prevLog;
      const producers = (store as unknown as { producers: Map<string, unknown> }).producers;
      for (const s of SEED) producers.delete(s.id);
      try {
        const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
        marketplaceRegistry._agentsCache = null;
      } catch { /* ignore */ }
      __setDbForTesting(prevDb as any);
      db.close();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // D — finn-tannlege clinic profile
  // ══════════════════════════════════════════════════════════════
  {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./dental-seo"),
      require.resolve("../services/dental-store"),
    ]);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const ddb = dbFactory.getDb("dental");
      const dstore = require("../services/dental-store") as typeof import("../services/dental-store");
      const dentalSeoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;

      const clinic = (navn: string, orgNr: string, rating: number | null, count: number | null): string => {
        const id = dstore.createDentalAgent({
          navn, org_nr: orgNr, adresse: "Strandgata 4", postnummer: "2317", poststed: "HAMAR", fylke: "Innlandet",
          telefon: "+47 62 51 00 00", hjemmeside: `https://${orgNr}.example.no`,
        } as any);
        ddb.prepare("UPDATE dental_agents SET rating = ?, rating_count = ?, rating_source = ? WHERE id = ?")
          .run(rating, count, rating === null ? null : "google_places|2026-06-27", id);
        return id;
      };
      const rated = clinic("Hamar Tannklinikk AS", "918800101", 4.7, 88);
      const ratedZero = clinic("Stange Tannklinikk AS", "918800102", 4.2, 0);
      const unrated = clinic("Løten Tannklinikk AS", "918800103", null, null);
      const page = async (id: string): Promise<string> => {
        const r = await callRoute(dentalSeoRouter, { url: `/klinikk/id/${id}` });
        assertEq(r.status, 200, `D: /klinikk/id/${id} renders 200`);
        return typeof r.body === "string" ? r.body : String(r.body ?? "");
      };
      const badges = (html: string): string[] => [...html.matchAll(/<span class="badge badge-rating"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
      const infoRow = (html: string): string | null =>
        /<div class="info-label">Vurdering[^<]*<\/div><div class="info-value">([^<]*)<\/div>/.exec(html)?.[1] ?? null;
      const noRatingText = (html: string): boolean =>
        !html.includes("badge-rating") && infoRow(html) === null && !/Vurdering \(Google\)/.test(html)
        && !/\b4[.,]7\b/.test(html) && !/\b88 anmeldelser/.test(html) && !/(anmeldelser?|anmeldelse) på Google/.test(html) && !/★/.test(html);

      await section("D: default mode", async () => {
        assertTrue(policy.RATING_DISPLAY_MODE === "hidden", "D0: RATING_DISPLAY_MODE is 'hidden' (S4-A1a)");
        const stored = ddb.prepare("SELECT rating, rating_count FROM dental_agents WHERE id = ?").get(rated) as any;
        assertEq([stored?.rating, stored?.rating_count], [4.7, 88], "D0: (the clinic's stored rating is there, and stays untouched)");
        for (const id of [rated, ratedZero, unrated]) {
          const html = await page(id);
          assertTrue(html.includes("Strandgata 4"), `D1 ${id}: the profile renders (address in the info grid)`);
          assertTrue(noRatingText(html), `D1 ${id}: no rating badge, no rating info row, no rating text`);
        }
      });

      await section("D: mode 'attributed' (test override)", async () => {
        policy.__setRatingDisplayModeForTesting("attributed");
        try {
          const html = await page(rated);
          assertEq(badges(html), ["★ 4.7 · 88 anmeldelser på Google"], "D2: the badge names Google (formatRatingDisplay), as on RFB");
          assertEq(infoRow(html), "★ 4.7 · 88 anmeldelser på Google", "D3: the info row shows the same text");
          const zero = await page(ratedZero);
          assertEq(badges(zero), ["★ 4.2 på Google"], "D4: a zero count is left out, never «0 anmeldelser»");
          assertTrue(!/\b0 anmeldelser/.test(zero), "D4: no «0 anmeldelser» anywhere on the page");
          const none = await page(unrated);
          assertTrue(badges(none).length === 0 && infoRow(none) === null, "D5: a clinic without a rating shows none");
        } finally {
          policy.__setRatingDisplayModeForTesting(null);
        }
      });
    } catch (err) {
      failed++;
      failures.push(`dental section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      policy.__setRatingDisplayModeForTesting(null);
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── Google ratings phased out of display and API answers (dev-request 2026-10-16 S4-A1a) ──");
  runGoogleRatingUtfasingTests({ log: true }).then((r) => {
    console.log(`\ngoogle-rating-utfasing-visning-og-deling: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

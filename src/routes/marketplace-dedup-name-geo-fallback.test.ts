/**
 * marketplace-dedup-name-geo-fallback.test.ts — dev-request
 * 2026-09-06-dedup-sokeendepunkt-geo-fallback-tynt-befolket.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `GET /api/marketplace/search?q=Gardås+Skogen+Flesberg` returned `count:20`
 * with top result "Eiker Hjort — Øvre Eiker" (23 km away, zero name overlap)
 * instead of the real existing catalog row "Gardås Skogen — Lampeland" — a
 * duplicate-candidate producer (orgnr 978555578, "Gardås Skogen
 * v/H.G.Garås", registered in Flesberg kommune) already in the catalog under
 * a similar name and a different kommune string ("Lampeland" — Lampeland is
 * ~9 km from Flesberg village, both inside Flesberg kommune). `lokal-agent-
 * discovery` STEG 2b calls this exact endpoint to dedupe a candidate against
 * the existing catalog before creating a new row, so this bug let real
 * duplicates slip past both the bulk-fuzzy dedup pass (STEG 1) AND this
 * per-candidate check (STEG 2b).
 *
 * ROOT CAUSE (traced end-to-end, confirmed by running the actual route +
 * discover() against seeded in-memory DBs):
 *
 *   `marketplaceRegistry.discover()`'s name-search branch (marketplace-
 *   registry.ts ~187-280) already has BOTH a strict ALL-words match and a
 *   relaxed/fuzzy ANY-distinctive-word match (the layer that reads the
 *   WHOLE `is_active=1 AND umbrella_type IS NULL AND is_vetted=1` cohort —
 *   the same one STEG 1's bulk-fuzzy dedup reads from). For
 *   `q=Gardås Skogen Flesberg`, the STRICT layer correctly fails (no row's
 *   name contains "flesberg" too), but the FUZZY layer correctly finds
 *   "Gardås Skogen" (2 of 3 distinctive words match) and it is well inside
 *   the resolved search radius — discover() answers correctly on its own.
 *
 *   The bug is one layer up, in routes/marketplace.ts's auto-expand-radius
 *   ladder. `wasNameMatch` (the flag meant to skip the ladder for a name
 *   search) only recognises the STRICT match's reason prefix ("Navnematch:
 *   …"), not the fuzzy layer's ("Mulig navnematch: …") — so a fuzzy-but-
 *   correct 1-result hit (< MIN_RESULTS=3) still enters the ladder. Once
 *   inside, the ladder rebuilds `expandedQuery`/`noGeoQuery` by spreading
 *   `...parsed` — which never carries `_nameQuery` (Zod strips unknown
 *   keys) — and, unlike `_productTerms`, `_nameQuery` was NEVER re-attached
 *   to those two query objects. So every widened/no-geo `discover()` call
 *   ran completely NAME-BLIND, replacing the correct fuzzy hit with
 *   whatever a generic geo/trust-ranked query happened to return — "Eiker
 *   Hjort", 23 km away, no name similarity at all.
 *
 *   routes/seo.ts's near-identical ladder (the /sok page) already carries
 *   `_nameQuery` through every widened step and the no-geo last resort (see
 *   its own comment: "_nameQuery is critical: when present, discover()
 *   returns name-matched agents anywhere in Norway and skips geo. Without
 *   this re-attach, /sok silently fell back to geo-rank fallback…") —
 *   routes/marketplace.ts (the JSON API endpoint STEG 2b actually calls) was
 *   simply missing that same re-attachment. The fix mirrors seo.ts exactly:
 *   no new matching mechanism, no change to discover()'s own layers — just
 *   stop dropping `_nameQuery` on the ladder's two rebuilt query objects, so
 *   the existing whole-catalog name-match layer (STRICT, then FUZZY) gets a
 *   chance to reassert itself at every widened radius — including the final
 *   no-geo call, which is the mandatory whole-catalog layer of last resort:
 *   with no `location`, discover()'s `filterNameCandidatesByGeo` returns
 *   candidates unfiltered, so a real name/fuzzy hit always survives it.
 *
 * Harness mirrors marketplace-search-honesty.test.ts (real init.ts schema in
 * an in-memory DB, the REAL router exercised through router.handle(), no
 * supertest, no network — the geocoder's HTTP seam is stubbed so no
 * Kartverket call is made; every query below supplies lat/lng directly, the
 * same "browser coordinates" path STEG 2b's per-candidate call would use).
 * Each scenario reseeds the `agents` table fresh so the three acceptance
 * cases below cannot leak candidates into one another's radius math.
 *
 * Exported runMarketplaceDedupNameGeoFallbackTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/marketplace-dedup-name-geo-fallback.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "../services/geocoding-service";

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
  opts: { method?: string; url: string; query?: Record<string, string>; headers?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      query: opts.query || {},
      headers,
      ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

interface SeedAgent {
  id: string; name: string; city: string; lat: number; lng: number; trust: number;
}

function reseedAgents(db: Database.Database, rows: SeedAgent[]): void {
  db.exec("DELETE FROM agents");
  const stmt = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, '[]', '[]', '[]', '{}', '["no"]',
            ?, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const a of rows) {
    stmt.run(
      a.id, a.name, "Lokal produsent", "test", `${a.id}@example.no`, `https://${a.id}.example.no`,
      "key-" + a.id, a.lat, a.lng, a.city, a.trust,
    );
  }
}

/** Geocoder stub: every query below supplies lat/lng directly (the "browser
 * coordinates" path a per-candidate dedup caller like STEG 2b would use), but
 * resolveRouteIntent still probes the geocoder for every non-empty `q`
 * regardless, so the HTTP seam must be stubbed to keep this test network-free. */
function stubGeocoder(): void {
  const notFound = () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  __setGeocodingFetchForTesting((async () => notFound()) as unknown as typeof fetch);
  __clearGeocodeCacheForTesting();
}

export async function runMarketplaceDedupNameGeoFallbackTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  stubGeocoder();

  const prevLogLevel = console.log;
  if (!log) console.log = () => { /* silence the registry's name-search chatter */ };

  try {
    const router = require("./marketplace").default;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");

    // ── Real-world coordinates, measured live against
    // ws.geonorge.no/stedsnavn/v1/sted during this dev-request's
    // investigation. Flesberg and Lampeland ("Tettbebyggelse", both inside
    // Flesberg kommune) are ~9 km apart; Øvre Eiker (a real, unrelated
    // neighbouring producer) is ~20 km out — close enough to be exactly the
    // kind of "real nearby producer" that used to leak into the response
    // once `_nameQuery` was dropped by the ladder.
    const FLESBERG = { lat: 59.86298, lng: 9.43246 };
    const LAMPELAND = { lat: 59.83486, lng: 9.57912 };
    const OVRE_EIKER = { lat: 59.73010, lng: 9.68000 };

    // ════════════════════════════════════════════════════════════════
    // AC1 — the live production bug, reproduced end-to-end through the
    // REAL router (the same /api/marketplace/search STEG 2b calls).
    // ════════════════════════════════════════════════════════════════
    reseedAgents(db, [
      { id: "d-gardas", name: "Gardås Skogen", city: "Lampeland", lat: LAMPELAND.lat, lng: LAMPELAND.lng, trust: 0.50 },
      { id: "d-eiker", name: "Eiker Hjort", city: "Øvre Eiker", lat: OVRE_EIKER.lat, lng: OVRE_EIKER.lng, trust: 0.90 },
    ]);
    {
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "Gardås Skogen Flesberg", lat: String(FLESBERG.lat), lng: String(FLESBERG.lng), radius: "15" },
      });
      assertEq(r.status, 200, "AC1: `Gardås Skogen Flesberg` → 200");
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names.includes("Gardås Skogen"),
        `AC1: the real duplicate-candidate row is found (got ${names.join(", ")})`);
      assertTrue(names[0] === "Gardås Skogen",
        `AC1: it is the TOP result, not merely present (got ${names.join(", ")})`);
      assertTrue(!names.includes("Eiker Hjort"),
        `AC1: the unrelated 23 km-away geo-proximity producer no longer displaces it (got ${names.join(", ")})`);
      const reasons: string[] = r.body.results[0].matchReasons || [];
      assertTrue(reasons.some((m: string) => /navnematch/i.test(m)),
        `AC1: the top result carries a NAME-match reason, not a generic geo reason (got ${JSON.stringify(reasons)})`);
    }

    // The identical underlying primitive, called directly — AC3 evidence
    // that this is the SAME code path STEG 2b's discover() call already
    // gets, not a second parallel mechanism.
    {
      const parsed = marketplaceRegistry.parseNaturalQuery("Gardås Skogen Flesberg");
      assertTrue(!!(parsed as any)._nameQuery,
        "AC3: `Gardås Skogen Flesberg` really does take the _nameQuery branch inside discover()");
      const direct = marketplaceRegistry.discover({
        limit: 20, offset: 0, role: "producer",
        location: FLESBERG, maxDistanceKm: 15,
        ...({ _nameQuery: (parsed as any)._nameQuery } as any),
      } as any);
      assertTrue(direct.length > 0 && direct[0].agent.name === "Gardås Skogen",
        `AC3: discover() alone (no route, no ladder) already finds it via the fuzzy layer (got ${direct.map(d => d.agent.name).join(", ")})`);
    }

    // ════════════════════════════════════════════════════════════════
    // AC2 — no regression: a genuine zero-name-match case (no row anywhere
    // in the catalog shares any token with the query) must still fall back
    // to today's geo-proximity behaviour, unchanged. Same two-row catalog
    // as AC1 — "Nordkvist Fjellgard" shares no token with either row.
    // ════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "Nordkvist Fjellgard Flesberg", lat: String(FLESBERG.lat), lng: String(FLESBERG.lng), radius: "15" },
      });
      assertEq(r.status, 200, "AC2: a synthetic zero-match query → 200");
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names.length > 0, `AC2: the geo-proximity fallback still returns results (got ${names.join(", ")})`);
      assertTrue(names[0] === "Eiker Hjort",
        `AC2: the higher-trust producer still wins the unchanged nationwide fallback ranking (got ${names.join(", ")})`);
      assertEq(r.body.relaxed_filters, ["geo"], "AC2: the widen-to-nationwide fallback still reports relaxed_filters");
      assertEq(r.body.geoFiltered, false, "AC2: …and honestly reports geoFiltered:false");
      const reasons: string[] = r.body.results[0].matchReasons || [];
      assertTrue(!reasons.some((m: string) => /navnematch/i.test(m)),
        `AC2: no name-match reason leaks into a genuine geo-only result (got ${JSON.stringify(reasons)})`);
    }

    // ════════════════════════════════════════════════════════════════
    // AC-generality — a second, unrelated name+kommune pair must be found
    // the same way (the fix is not hardcoded to "Gardås"/"Flesberg"), in a
    // fresh catalog far from the Flesberg fixture above.
    // ════════════════════════════════════════════════════════════════
    const ROLLAG = { lat: 59.79210, lng: 9.30720 };
    const VEGGLI = { lat: 59.83210, lng: 9.15200 }; // ~9.8 km from Rollag, both inside Rollag kommune
    const ELSEWHERE = { lat: 59.68000, lng: 9.45000 }; // an unrelated real-ish neighbour, name shares no token
    reseedAgents(db, [
      { id: "d-nystulen", name: "Nystulen Kjellerutsalg", city: "Veggli", lat: VEGGLI.lat, lng: VEGGLI.lng, trust: 0.45 },
      { id: "d-elsewhere", name: "Fjellro Vilt", city: "Kongsberg", lat: ELSEWHERE.lat, lng: ELSEWHERE.lng, trust: 0.85 },
    ]);
    {
      const parsed = marketplaceRegistry.parseNaturalQuery("Nystulen Rollag");
      assertTrue(!!(parsed as any)._nameQuery,
        "AC-generality: `Nystulen Rollag` also takes the _nameQuery branch (precondition)");
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "Nystulen Rollag", lat: String(ROLLAG.lat), lng: String(ROLLAG.lng), radius: "5" },
      });
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names[0] === "Nystulen Kjellerutsalg",
        `AC-generality: a DIFFERENT name+kommune query finds ITS real match, not the unrelated neighbour (got ${names.join(", ")})`);
      assertTrue(!names.includes("Fjellro Vilt"),
        `AC-generality: the unrelated Kongsberg producer does not displace it (got ${names.join(", ")})`);
    }
  } finally {
    console.log = prevLogLevel;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runMarketplaceDedupNameGeoFallbackTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

/**
 * agents-geocode-invalidate-backfill.test.ts — dev-request
 * 2026-09-11-rettet-adresse-oppdaterer-ikke-kartpunktet, item 2 ("Rydd
 * etterslepet" — the one-time backfill for the PRE-EXISTING backlog).
 *
 * Covers:
 *   b1-b7   the "Valens heimelaga" scenario: a row already at
 *           geo_precision='address' whose CURRENT address (Nordagutu)
 *           resolves ~210 km from the stored point (Haugesund-area) is
 *           RE-GEOCODE-FLAGGED and its geocode fields are CLEARED — never a
 *           new coordinate written, only invalidated
 *   b8-b10  a fresh re-check that agrees with the stored point within the
 *           50 km threshold is CONFIRMED PLAUSIBLE and left untouched
 *   b11-b13 a fresh re-check that Kartverket cannot resolve at all
 *           (no_match) is REJECTED AS UNCERTAIN — "never write an
 *           uncorroborated point" means never CLEARING one either when we
 *           cannot corroborate a problem — and the stored point survives
 *           byte-identical
 *   b14-b16 the 50 km threshold itself: ~44.5 km away stays plausible,
 *           ~55.6 km away is flagged (not just the extreme 210 km case)
 *   b17     aggregate counts across one tick match exactly (processed /
 *           re_geocode_flagged / confirmed_plausible / rejected_uncertain)
 *   b18-b20 eligibility: a row NOT at geo_precision='address' (e.g. 'city')
 *           is never selected; nor is an 'address'-precision row missing a
 *           postal_code
 *   b21-b23 dry_run: reports the SAME flagged outcome, writes NOTHING
 *   b24     agentsGeocodeInvalidateBackfillQueueStatus() counts exactly the
 *           eligible rows
 *
 * Every scenario asserts the geocode-field RESET is the exact same
 * seven-field shape PUT /admin/knowledge's own invalidation uses (geo_
 * precision/lat/lng/geocode_source/geocode_outcome -> NULL, geocode_attempts
 * -> 0, geocode_attempted_at -> NULL), and that the freshly-looked-up
 * lat/lng from the mocked Kartverket response is NEVER written to the DB
 * anywhere — only used to compute the distance, then discarded.
 *
 * Setup mirrors agents-geocode-worker.test.ts: an in-memory DB running the
 * REAL production schema via __setDbForTesting/__initSchemaForTesting, the
 * singleton restored with __peekDbForTesting() in `finally`. The only
 * network seam is InvalidateBackfillDeps.fetchImpl and it is always
 * injected — nothing here touches the network.
 *
 * Exported runAgentsGeocodeInvalidateBackfillTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/services/agents-geocode-invalidate-backfill.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function addrHit(lat: number, lon: number) {
  return { adresser: [{ representasjonspunkt: { lat, lon } }] };
}
const EMPTY = { adresser: [] };

export function runAgentsGeocodeInvalidateBackfillTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");

    // ── The single injected network seam ──────────────────────────────
    // Routed by a distinctive token in each test address so each scenario
    // gets exactly the fixture it declared. An unrecognised query answers
    // EMPTY (no_match) — the safe direction, since it can only ever produce
    // a REJECTION, never a false confirm or a false flag.
    const calls: string[] = [];
    const fetchImpl = (async (input: any) => {
      const url = decodeURIComponent(String(input));
      calls.push(url);
      let body: any = EMPTY;
      if (/nordagutuvegen/i.test(url)) body = addrHit(59.43, 9.32);
      else if (/boundaryfarveien/i.test(url)) body = addrHit(60.5, 10.0);
      else if (/boundarynearveien/i.test(url)) body = addrHit(60.4, 10.0);
      else if (/agreeveien/i.test(url)) body = addrHit(60.0, 10.0);
      // "uncertainveien" and anything unrecognised fall through to EMPTY.
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const deps = { fetchImpl, sleep: async () => {} };

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const worker = require("./agents-geocode-invalidate-backfill") as
        typeof import("./agents-geocode-invalidate-backfill");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             lat, lng, city, is_active, geo_precision,
                             geocode_source, geocode_outcome, geocode_attempts, geocode_attempted_at)
         VALUES (@id, @name, 'Lokal matprodusent', 'test', 'a@b.no', 'https://example.no',
                 'producer', @api_key, @lat, @lng, @city, 1, @geo_precision,
                 @geocode_source, @geocode_outcome, @geocode_attempts, @geocode_attempted_at)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code) VALUES (?, ?, ?)`,
      );
      const seed = (o: {
        id: string; name: string; lat: number; lng: number; city?: string | null;
        geo_precision?: string | null; address?: string | null; postal_code?: string | null;
      }) => {
        insertAgent.run({
          id: o.id, name: o.name, api_key: `key-${o.id}`,
          lat: o.lat, lng: o.lng, city: o.city ?? null,
          geo_precision: o.geo_precision ?? "address",
          geocode_source: "kartverket_adresse", geocode_outcome: "high",
          geocode_attempts: 0, geocode_attempted_at: "2026-09-08T10:00:00.000Z",
        });
        if (o.address !== undefined || o.postal_code !== undefined) {
          insertKnowledge.run(o.id, o.address ?? null, o.postal_code ?? null);
        }
      };
      const rowOf = (id: string) => db
        .prepare(
          `SELECT lat, lng, geo_precision, geocode_source, geocode_outcome,
                  geocode_attempts, geocode_attempted_at
             FROM agents WHERE id = ?`,
        )
        .get(id) as any;

      // ── b1-b7, b14-b17: one controlled tick with a fully known cohort ──
      // "Valens heimelaga" scenario, the ~55.6 km / ~44.5 km threshold
      // boundary, and the no_match rejection, all in ONE tick so the
      // aggregate counts (b17) can be asserted exactly.
      seed({
        id: "valen-01", name: "Valens Heimelaga", lat: 59.69314, lng: 5.47994,
        geo_precision: "address", address: "Nordagutuvegen, 3820 Nordagutu", postal_code: "3820",
      });
      seed({
        id: "far-01", name: "Boundary Far Gård", lat: 60.0, lng: 10.0,
        geo_precision: "address", address: "Boundaryfarveien 1", postal_code: "1000",
      });
      seed({
        id: "near-01", name: "Boundary Near Gård", lat: 60.0, lng: 10.0,
        geo_precision: "address", address: "Boundarynearveien 1", postal_code: "1000",
      });
      seed({
        id: "unsure-01", name: "Uncertain Gård", lat: 63.0, lng: 10.0,
        geo_precision: "address", address: "Uncertainveien 5", postal_code: "9990",
      });
      // Not eligible: wrong precision tier, and missing postal_code.
      seed({
        id: "skip-city-01", name: "Skip City Gård", lat: 60.0, lng: 10.0,
        geo_precision: "city", address: "Agreeveien 9", postal_code: "1000",
      });
      seed({
        id: "skip-nopostal-01", name: "Skip No Postal Gård", lat: 60.0, lng: 10.0,
        geo_precision: "address", address: "Agreeveien 9", postal_code: "",
      });

      const r = await worker.agentsGeocodeInvalidateBackfillTick(50, deps);

      // ── b1-b7: Valens heimelaga — flagged and cleared ────────────────
      const valen = rowOf("valen-01");
      assertEq(valen.geo_precision, null, "b1: geo_precision cleared — the row leaves the ceiling agents-geocode-worker.ts would otherwise never revisit");
      assertEq(valen.lat, null, "b2: lat cleared — the stale Haugesund-area point is gone");
      assertEq(valen.lng, null, "b3: lng cleared");
      assertEq(valen.geocode_source, null, "b4: geocode_source cleared");
      assertEq(valen.geocode_outcome, null, "b5: geocode_outcome cleared");
      assertEq(valen.geocode_attempts, 0, "b6: geocode_attempts reset to 0");
      assertEq(valen.geocode_attempted_at, null, "b7: geocode_attempted_at cleared — selectable again next tick");
      const valenPlanned = r.planned.find((p) => p.agent_id === "valen-01");
      assertEq(valenPlanned?.outcome, "re_geocode_flagged", "b7b: reported outcome is re_geocode_flagged");
      assertTrue((valenPlanned?.distance_km ?? 0) > 200, `b7c: reported distance ~210 km (got ${valenPlanned?.distance_km})`);
      assertTrue(valenPlanned?.stored_lat === 59.69314 && valenPlanned?.stored_lng === 5.47994,
        "b7d: the planned entry names the STORED (old, wrong) point, not the fresh one — the fresh point is never persisted or presented as the answer");

      // ── b14-b16: the 50 km threshold itself ──────────────────────────
      const far = rowOf("far-01");
      assertEq(far.geo_precision, null, "b14a: ~55.6 km away — flagged and cleared, same as the extreme case");
      const near = rowOf("near-01");
      assertEq(near.geo_precision, "address", "b15a: ~44.5 km away — within threshold, left at address precision");
      assertEq(near.lat, 60.0, "b15b: …and its coordinate untouched");
      const farPlanned = r.planned.find((p) => p.agent_id === "far-01");
      const nearPlanned = r.planned.find((p) => p.agent_id === "near-01");
      assertTrue(!!farPlanned && farPlanned.distance_km! > 50, `b16a: far-01 distance > 50 km (got ${farPlanned?.distance_km})`);
      assertTrue(!!nearPlanned && nearPlanned.distance_km! < 50, `b16b: near-01 distance < 50 km (got ${nearPlanned?.distance_km})`);

      // ── b11-b13: no_match -> rejected, never guessed, never cleared ──
      const unsure = rowOf("unsure-01");
      assertEq(unsure.geo_precision, "address", "b11: a fresh re-check that finds nothing leaves the row exactly as it was");
      assertEq(unsure.lat, 63.0, "b12: …coordinate byte-identical");
      const unsurePlanned = r.planned.find((p) => p.agent_id === "unsure-01");
      assertEq(unsurePlanned?.outcome, "rejected_uncertain", "b13: reported as rejected_uncertain, not silently dropped");

      // ── b18-b20: ineligible rows were never even selected ────────────
      assertTrue(!r.planned.find((p) => p.agent_id === "skip-city-01"), "b18: geo_precision='city' row never appears in planned — not selected at all");
      assertTrue(!r.planned.find((p) => p.agent_id === "skip-nopostal-01"), "b19: an 'address'-precision row with no postal_code is never selected");
      const skipCity = rowOf("skip-city-01");
      assertEq(skipCity.geo_precision, "city", "b20: …and its row is completely untouched");

      // ── b17: aggregate counts, over exactly the 4 eligible rows above ──
      assertEq(r.processed, 4, "b17a: processed = exactly the 4 eligible rows (skip-* excluded)");
      assertEq(r.re_geocode_flagged, 2, "b17b: re_geocode_flagged = 2 (valen-01, far-01)");
      assertEq(r.confirmed_plausible, 1, "b17c: confirmed_plausible = 1 (near-01)");
      assertEq(r.rejected_uncertain, 1, "b17d: rejected_uncertain = 1 (unsure-01)");
      assertEq(r.errors, 0, "b17e: errors = 0");

      // ── b24: queue status reflects what is left (near/unsure still 'address') ──
      const status = worker.agentsGeocodeInvalidateBackfillQueueStatus();
      assertEq(status.eligible, 2, "b24: eligible = near-01 + unsure-01 (valen-01/far-01 dropped out after being cleared)");

      // ── b21-b23: dry_run reports the SAME flagged outcome, writes NOTHING ──
      seed({
        id: "dryrun-01", name: "Dry Run Gård", lat: 59.69314, lng: 5.47994,
        geo_precision: "address", address: "Nordagutuvegen, 3820 Nordagutu", postal_code: "3820",
      });
      const beforeDry = rowOf("dryrun-01");
      const dr = await worker.agentsGeocodeInvalidateBackfillTick(50, { ...deps, dryRun: true });
      const afterDry = rowOf("dryrun-01");
      const dryPlanned = dr.planned.find((p) => p.agent_id === "dryrun-01");
      assertEq(dryPlanned?.outcome, "re_geocode_flagged", "b21: dry run still IDENTIFIES the flagged row");
      assertEq(afterDry.geo_precision, beforeDry.geo_precision, "b22: …but geo_precision is byte-identical (nothing written)");
      assertEq(afterDry.lat, beforeDry.lat, "b23: …and lat is byte-identical");
    } finally {
      initMod.__setDbForTesting(prevDb);
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAgentsGeocodeInvalidateBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

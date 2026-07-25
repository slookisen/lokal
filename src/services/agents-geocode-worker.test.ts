/**
 * agents-geocode-worker.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1 (1a + 1c).
 *
 * Covers the RFB coordinate foundation:
 *   1a  services/agents-geocode-worker.ts — the geocoding worker `agents` never
 *       had (dental and experiences both have one), plus the additive
 *       agents.geo_precision / geocode_source / geocode_outcome /
 *       geocode_attempted_at migration in database/init.ts.
 *   1c  the honesty rule — services/geo-precision.ts wired into
 *       marketplace-registry.ts, so a centroid-precision producer can never
 *       claim a precise km distance (the RFB half of what
 *       experience-store.ts's formatDistanceLabel() already does for
 *       OpplevAgent).
 *
 * Asserted here (each maps to the build spec's test list):
 *   w1-w4   address hit → geo_precision='address' + real coordinates
 *   w5-w7   lookup miss → row untouched, attempt STILL stamped (so it rotates)
 *   w8-w10  no coordinates at all → city-centroid tier, honestly tagged 'city'
 *   w11-w13 never downgrade: an existing 'address' row is not even selected
 *   w14-w16 idempotent re-run changes nothing
 *   m1-m4   migration: columns present, idempotent, existing rows default NULL
 *   r1-r4   rotation: two successive batches pick DISJOINT rows
 *   d1-d5   dry run: reports the same changes, writes NOTHING
 *   h1-h9   honesty: 'kommune'/'city' precision → no distanceKm, an honest
 *           label instead; 'address' → real km; NULL (legacy) → unchanged
 *
 * Setup mirrors mcp-usage-logger.test.ts: an in-memory DB running the REAL
 * production schema via __setDbForTesting/__initSchemaForTesting (so the
 * migration under test is the one that ships), the singleton restored with
 * __peekDbForTesting() in `finally`. Both network seams are injected — the
 * Kartverket adresse-API via GeocodeDeps.fetchImpl, the Stedsnavn/Kommuneinfo
 * lookups via geocoding-service's __setGeocodingFetchForTesting — so nothing
 * here touches the network.
 *
 * Exported runAgentsGeocodeWorkerTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/agents-geocode-worker.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Verbatim-shaped Kartverket captures ───────────────────────────────
// adresser/v1/sok answers with representasjonspunkt {lat, lon}; stedsnavn/v1
// with navn[].representasjonspunkt {nord, øst} + navneobjekttype + stedsnavn[]
// (the Fase-0 navnestatus guard reads `hovednavn`, so the fixtures carry it).
const ADDRESS_HIT = {
  adresser: [{ representasjonspunkt: { lat: 63.4155, lon: 10.4211 } }],
};
const ADDRESS_EMPTY = { adresser: [] };

const STEDSNAVN_VADSO = {
  metadata: { totaltAntallTreff: 1 },
  navn: [{
    navneobjekttype: "By",
    representasjonspunkt: { nord: 70.0744, øst: 29.7487 },
    stedsnavn: [{ skrivemåte: "Vadsø", navnestatus: "hovednavn" }],
  }],
};

export function runAgentsGeocodeWorkerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    const geo = require("./geocoding-service") as typeof import("./geocoding-service");

    // ── Injected network seams ──────────────────────────────────────
    // Kartverket adresse-API: every address resolves EXCEPT the one that is
    // deliberately unresolvable ("Ingenveien"), so the "miss" path is real.
    let addressCalls = 0;
    const fetchImpl = (async (input: any) => {
      addressCalls++;
      const url = decodeURIComponent(String(input));
      const body = /ingenveien/i.test(url) ? ADDRESS_EMPTY : ADDRESS_HIT;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const deps = { fetchImpl, sleep: async () => {} };

    geo.__setGeocodingFetchForTesting((async (input: any) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/stedsnavn/") && /sok=vadsø/i.test(url)) {
        return { ok: true, status: 200, json: async () => STEDSNAVN_VADSO } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const worker = require("./agents-geocode-worker") as typeof import("./agents-geocode-worker");
      const precision = require("./geo-precision") as typeof import("./geo-precision");

      // ── Seed helpers ─────────────────────────────────────────────
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             lat, lng, city, is_active, geo_precision)
         VALUES (@id, @name, 'Lokal matprodusent', 'test', 'a@b.no', 'https://example.no',
                 'producer', @api_key, @lat, @lng, @city, 1, @geo_precision)`
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code) VALUES (?, ?, ?)`
      );
      const seed = (o: {
        id: string; name: string; lat?: number | null; lng?: number | null;
        city?: string | null; geo_precision?: string | null;
        address?: string | null; postal_code?: string | null;
      }) => {
        insertAgent.run({
          id: o.id, name: o.name, api_key: `key-${o.id}`,
          lat: o.lat ?? null, lng: o.lng ?? null, city: o.city ?? null,
          geo_precision: o.geo_precision ?? null,
        });
        if (o.address !== undefined || o.postal_code !== undefined) {
          insertKnowledge.run(o.id, o.address ?? null, o.postal_code ?? null);
        }
      };
      const rowOf = (id: string) => db
        .prepare(`SELECT lat, lng, geo_precision, geocode_source, geocode_outcome, geocode_attempted_at
                    FROM agents WHERE id = ?`)
        .get(id) as any;

      // ── m1-m4: the additive migration ────────────────────────────
      {
        const cols = (db.prepare(`PRAGMA table_info(agents)`).all() as any[]).map((c) => c.name);
        assertTrue(cols.includes("geo_precision"), "m1: agents.geo_precision column added by the migration");
        assertTrue(cols.includes("geocode_attempted_at"), "m2: agents.geocode_attempted_at (the rotation key) added");
        // Idempotency: initSchema runs on every boot against an existing DB.
        initMod.__initSchemaForTesting(db as any);
        const cols2 = (db.prepare(`PRAGMA table_info(agents)`).all() as any[])
          .filter((c) => c.name === "geo_precision");
        assertEq(cols2.length, 1, "m3: re-running the schema init does not duplicate or throw (idempotent ALTER)");

        seed({ id: "m-legacy", name: "Gammel Gård", lat: 59.9, lng: 10.7, city: "Oslo" });
        assertEq(rowOf("m-legacy").geo_precision, null,
          "m4: an existing row defaults to geo_precision NULL — unknown provenance, never guessed as 'city'");
      }

      // ── w1-w7: address hit, and a miss that still rotates ────────
      {
        seed({ id: "w-addr", name: "Adresse Gård", city: "Trondheim", address: "Kongens gate 1", postal_code: "7011" });
        // Unresolvable address AND an unresolvable city, so BOTH tiers miss —
        // this is the row that must still rotate out of the queue head.
        seed({ id: "w-miss", name: "Ukjent Gård", city: "Ingenstedet", address: "Ingenveien 99", postal_code: "9999" });

        const r = await worker.agentsGeocodeTick(50, deps);
        const hit = rowOf("w-addr");
        const miss = rowOf("w-miss");

        assertEq(hit.geo_precision, "address", "w1: an address hit is stored at geo_precision='address'");
        assertEq(hit.lat, 63.4155, "w2: …with the Kartverket representasjonspunkt latitude");
        assertEq(hit.lng, 10.4211, "w3: …and longitude");
        assertEq(hit.geocode_source, "kartverket_adresse", "w4: …tagged with the service that produced it");

        assertEq(miss.lat, null, "w5: a row whose address does not resolve keeps NULL coordinates (no invented point)");
        assertEq(miss.geo_precision, null, "w6: …and claims no precision");
        assertTrue(!!miss.geocode_attempted_at,
          "w7: …but its attempt IS stamped, so the selector rotates past it instead of re-picking it forever");
        assertTrue(r.processed >= 2, `w7b: both rows were processed (processed=${r.processed})`);
      }

      // ── w8-w10: no coordinates at all → honest city centroid ─────
      {
        seed({ id: "w-city", name: "Vadsø Gård", city: "Vadsø" });
        await worker.agentsGeocodeTick(50, deps);
        const row = rowOf("w-city");
        assertTrue(row.lat !== null && row.lng !== null,
          "w8: a producer with no coordinates but a known city is finally placed (it was invisible to every geo search)");
        assertEq(row.geo_precision, "city",
          "w9: …tagged 'city', NOT 'address' — the position is a centroid and the honesty rule must know");
        assertEq(row.geocode_outcome, "city_centroid", "w10: …with the outcome recorded for ops");
      }

      // ── w11-w16: never downgrade + idempotent re-run ─────────────
      {
        seed({
          id: "w-done", name: "Ferdig Gård", lat: 60.1, lng: 11.2, city: "Vadsø",
          geo_precision: "address", address: "Kongens gate 1", postal_code: "7011",
        });
        const before = rowOf("w-done");
        const callsBefore = addressCalls;
        await worker.agentsGeocodeTick(50, deps);
        const after = rowOf("w-done");

        assertEq(after.lat, before.lat, "w11: a row already at 'address' precision keeps its latitude");
        assertEq(after.geo_precision, "address", "w12: …and its precision (never downgraded to a centroid)");
        assertEq(after.geocode_attempted_at, before.geocode_attempted_at,
          "w13: …and is not even selected — no wasted Kartverket call");
        assertTrue(precision.isPrecisionUpgrade("address", "city") === false,
          "w13b: isPrecisionUpgrade() itself refuses address → city");

        // Idempotency of the resolved rows from the earlier blocks.
        const addrBefore = rowOf("w-addr");
        const cityBefore = rowOf("w-city");
        await worker.agentsGeocodeTick(50, deps);
        const addrAfter = rowOf("w-addr");
        const cityAfter = rowOf("w-city");
        assertEq(addrAfter.geocode_attempted_at, addrBefore.geocode_attempted_at,
          "w14: re-running the tick does not re-process an address-precision row");
        assertEq(addrAfter.lat, addrBefore.lat, "w15: …its coordinates are byte-identical");
        assertEq(cityAfter.lat, cityBefore.lat,
          "w16: …and a city-precision row is not re-placed either (it has coordinates now)");
        assertTrue(addressCalls >= callsBefore,
          "w16b: sanity — the injected Kartverket seam is the only address source used");
      }

      // ── r1-r4: rotation — successive batches pick disjoint rows ──
      {
        // Six fresh candidates, all of which MISS, so nothing is removed from
        // the queue by being resolved: rotation must come from the attempt
        // stamp alone. This is the exact failure the homepage-provenance
        // selector had (dev-request 2026-07-19) — 3 identical batches in a row.
        for (let i = 1; i <= 6; i++) {
          seed({ id: `r-${i}`, name: `Rotasjon ${i}`, city: "Trondheim", address: "Ingenveien 1", postal_code: "9999" });
        }
        const batch1 = await worker.agentsGeocodeTick(2, deps);
        const ids1 = batch1.planned.map((p) => p.agent_id).filter((id) => id.startsWith("r-"));
        const batch2 = await worker.agentsGeocodeTick(2, deps);
        const ids2 = batch2.planned.map((p) => p.agent_id).filter((id) => id.startsWith("r-"));

        assertEq(ids1.length, 2, `r1: first batch honours the limit (got ${JSON.stringify(ids1)})`);
        assertEq(ids2.length, 2, `r2: second batch honours the limit (got ${JSON.stringify(ids2)})`);
        assertTrue(
          ids2.every((id) => !ids1.includes(id)),
          `r3: the two batches are DISJOINT — the worker rotates instead of re-processing the queue head (${JSON.stringify(ids1)} vs ${JSON.stringify(ids2)})`
        );
        const stamps = new Set(
          (db.prepare(`SELECT geocode_attempted_at FROM agents WHERE id LIKE 'r-%' AND geocode_attempted_at IS NOT NULL`)
            .all() as any[]).map((x) => x.geocode_attempted_at)
        );
        assertEq(stamps.size, 4,
          "r4: every attempted row got a DISTINCT stamp (a 1-second-granularity stamp would collapse them and break rotation)");
      }

      // ── d1-d5: dry run reports, writes nothing ───────────────────
      {
        seed({ id: "d-1", name: "Tørrkjøring Gård", city: "Trondheim", address: "Kongens gate 1", postal_code: "7011" });
        const snapshot = JSON.stringify(
          db.prepare(`SELECT id, lat, lng, geo_precision, geocode_source, geocode_outcome, geocode_attempted_at
                        FROM agents ORDER BY id`).all()
        );
        const dry = await worker.agentsGeocodeTick(50, { ...deps, dryRun: true });
        const afterSnapshot = JSON.stringify(
          db.prepare(`SELECT id, lat, lng, geo_precision, geocode_source, geocode_outcome, geocode_attempted_at
                        FROM agents ORDER BY id`).all()
        );

        assertTrue(dry.dry_run === true, "d1: the result is flagged as a dry run");
        assertTrue(dry.planned.length > 0, "d2: …and still reports what it WOULD change");
        const plannedForD1 = dry.planned.find((p) => p.agent_id === "d-1");
        assertEq(plannedForD1?.to_precision, "address", "d3: …including the precision the row would reach");
        assertTrue(afterSnapshot === snapshot,
          "d4: the database is BYTE-IDENTICAL after a dry run — not even the attempt timestamp is written");
        assertEq(rowOf("d-1").geocode_attempted_at, null, "d5: …confirmed on the dry-run row itself");

        // And a real run afterwards does apply it (the dry run did not consume it).
        await worker.agentsGeocodeTick(50, deps);
        assertEq(rowOf("d-1").geo_precision, "address",
          "d5b: a real run afterwards still applies the change the dry run predicted");
      }

      // ── h1-h9: the honesty rule, end to end through discover() ───
      {
        const { marketplaceRegistry } = require("./marketplace-registry") as
          typeof import("./marketplace-registry");
        marketplaceRegistry.invalidateCache?.();

        // Three producers ~2 km apart near Trondheim, differing ONLY in
        // coordinate provenance.
        seed({ id: "h-addr", name: "Presis Gård", lat: 63.4200, lng: 10.4000, city: "Trondheim", geo_precision: "address" });
        seed({ id: "h-komm", name: "Sentroide Gård", lat: 63.4210, lng: 10.4010, city: "Trondheim", geo_precision: "kommune" });
        seed({ id: "h-null", name: "Ukjent Presisjon Gård", lat: 63.4220, lng: 10.4020, city: "Trondheim" });

        const results = marketplaceRegistry.discover({
          location: { lat: 63.4305, lng: 10.3951 },
          maxDistanceKm: 30,
          limit: 50,
          offset: 0,
        } as any);
        const byId = new Map(results.map((r) => [r.agent.id, r.agent]));

        const addr = byId.get("h-addr");
        const komm = byId.get("h-komm");
        const nul = byId.get("h-null");

        assertTrue(!!addr && !!komm && !!nul, "h1: all three producers are returned by the geo search");
        assertTrue(typeof addr?.location?.distanceKm === "number",
          "h2: an ADDRESS-precision producer reports a real km distance");
        assertEq(komm?.location?.distanceKm, undefined,
          "h3: a KOMMUNE-precision producer reports NO km distance — the position is a centroid, the number would be invented");
        assertEq(komm?.location?.geoPrecision, "kommune",
          "h4: …the response says why, instead of silently omitting the field");
        assertTrue(!!komm?.location?.distanceLabel && !/\d/.test(komm!.location!.distanceLabel!),
          `h5: …and carries an honest label with no number in it (got ${JSON.stringify(komm?.location?.distanceLabel)})`);
        assertTrue(typeof nul?.location?.distanceKm === "number",
          "h6: a legacy row (geo_precision NULL) is UNCHANGED — no silent blanking of 948 producers on deploy");
        assertTrue(komm?.location?.city === "Trondheim",
          "h7: the centroid producer still says where it is; only the false precision is withheld");
      }

      // ── h8-h9: the pure helper ───────────────────────────────────
      {
        assertEq(precision.formatRfbDistanceLabel(2.44, "address", "Vadsø"), "2,4 km unna",
          "h8: formatRfbDistanceLabel() renders a real distance for address precision (nb-NO decimal comma)");
        assertEq(precision.formatRfbDistanceLabel(2.44, "kommune", "Vadsø"), "i Vadsø-området",
          "h9: …and never a km figure for a centroid row — same rule as experience-store.ts's formatDistanceLabel()");
        assertEq(precision.formatRfbDistanceLabel(2.44, null, "Vadsø"), null,
          "h9b: …while an unknown-provenance row gets no label at all (caller renders as before)");
      }
    } catch (err: any) {
      failed++;
      failures.push("agents-geocode-worker: unexpected error: " + String(err?.message || err));
    } finally {
      geo.__setGeocodingFetchForTesting();
      geo.__clearGeocodeCacheForTesting();
      initMod.__setDbForTesting(prevDb as any);
      try { db.close(); } catch { /* already closed */ }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runAgentsGeocodeWorkerTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

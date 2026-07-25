/**
 * geocode-coverage-boost.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a THROUGHPUT +
 * COVERAGE follow-up.
 *
 * Daniel, hours after Fase 1a shipped, looking at the live queue:
 *   «Det ser ut som veldig mange fortsatt står med ukjent opphav. Vi burde lage
 *    en pr som forbedrer og fikser dette.»
 *
 * Measured live 2026-07-25T22:17Z: 1 022 pending ÷ 50 rows/hour ≈ 20 hours, and
 * 423 rows the selector could not reach AT ALL. This suite covers the four
 * things that fixes:
 *
 *   b1-b6      REVIEW B1 — a hamlet must not outrank the kommune it shares a
 *              name with. Two REAL producers landed on the Gjerdrum Grend in
 *              Innlandet, 79.6 km from Gjerdrum kommune in Akershus.
 *   db1-db3    REVIEW B2 — the centroid tiers must never consult the local
 *              `agents` table (reproduced: «Ny Gård — Hegra» adopting a sibling
 *              row's Tromsø coordinate).
 *   lb1-lb4    The honesty label must say WHERE the producer is — this cohort
 *              has city = NULL, and the registry's legacy `|| "Oslo"` default
 *              would have announced ~250 of them as «i Oslo-området».
 *   tb1-tb2    REVIEW B3 — Tier B's own no-coordinates guard, the one
 *              protecting the ~110 seed-coordinate rows.
 *   hb1-hb2    REVIEW B3 — the postal backlog probe counts only NEVER-attempted
 *              rows, so a permanently-unresolvable row cannot pin the fast
 *              cadence on for ever.
 *   tc1-tc14   Tier C — the place suffix in the producer's own name. Including
 *              the LAST-TOKEN-FIRST rule, which is a measured safety property:
 *              locality-first resolved «Mevika, Gildeskål» ~600 km wrong.
 *   pk1-pk9    Parking — an honest terminal state instead of an infinite retry,
 *              the counter resetting on progress, and unpark.
 *   bg1-bg6    kartverket-budget.ts — ONE process-wide 2 req/s ceiling shared by
 *              both RFB backfill workers, drawn per REQUEST (so geocodeOne's
 *              4-step ladder is counted exactly, not estimated at 1/row).
 *   sc1-sc9    backfill-scheduler.ts — the adaptive cadence, and the
 *              ALWAYS-RESCHEDULE invariant: a scheduler whose failure path does
 *              not re-arm stops for ever, which is the scheduler-level twin of
 *              the ALWAYS-STAMP bug this worker took two blockers for.
 *   ob1-ob7    Observability — `unreachable` is a true PARTITION (the buckets
 *              sum to the total, so no row can hide), `pending_by_tier`, and
 *              the drain ETA.
 *   dr1-dr4    dry_run writes NOTHING — verified with a WHOLE-DB hash, not a
 *              column spot-check, and including the new `unpark` write path.
 *   co1-co3    The two workers COOPERATE: postal-backfill resetting the parking
 *              counter when it lands the postnummer that was blocking a row.
 *
 * MUTATION-TESTED. Every guarantee claimed above was verified by breaking the
 * source and confirming this suite goes red — 28 mutants, 28 killed, listed
 * against each block below. A test that passes with its guard removed is worse
 * than no test: THREE vacuous tests were found this way in this very file
 * (tc4 used a name with no hyphen; tc9 and the Tier-B twin were both masked by
 * the SQL selector), and an independent reviewer found two more the first pass
 * had missed. The mutation list is part of the deliverable, not a footnote.
 *
 * Setup mirrors agents-geocode-worker.test.ts: in-memory DB running the REAL
 * production schema via __setDbForTesting/__initSchemaForTesting, singleton
 * restored in `finally`, both network seams injected.
 *
 * Exported runGeocodeCoverageBoostTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/geocode-coverage-boost.test.ts
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Verbatim-shaped Kartverket captures ─────────────────────────────
// stedsnavn/v1/sted returns navn[].representasjonspunkt {nord, øst} plus
// navneobjekttype and a stedsnavn[] array carrying navnestatus — confirmed
// against the LIVE API while building this slice (the flat-field shape belongs
// to the /navn endpoint, which this repo does not call).
const stedsnavn = (name: string, type: string, nord: number, ost: number) => ({
  metadata: { totaltAntallTreff: 1 },
  navn: [{
    navneobjekttype: type,
    representasjonspunkt: { nord, øst: ost },
    stedsnavn: [{ skrivemåte: name, navnestatus: "hovednavn" }],
  }],
});

const ADDRESS_HIT = { adresser: [{ representasjonspunkt: { lat: 63.4155, lon: 10.4211 } }] };
const ADDRESS_EMPTY = { adresser: [] };

/** Whole-DB fingerprint: every table, every row. Not a column spot-check. */
function hashDb(db: any): string {
  const tables = (db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as any[]).map((r) => r.name);
  const h = createHash("sha256");
  for (const t of tables) {
    h.update(`::${t}::`);
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as any[];
    // Row order is not guaranteed by SELECT *, so sort the serialised rows.
    const serialised = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
    for (const s of serialised) h.update(s);
  }
  return h.digest("hex");
}

export function runGeocodeCoverageBoostTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const budget = require("./kartverket-budget") as typeof import("./kartverket-budget");

    // ── Injected network seams ──────────────────────────────────────
    let addressCalls = 0;
    const fetchImpl = (async (input: any) => {
      addressCalls++;
      const url = decodeURIComponent(String(input));
      const body = /ingenveien/i.test(url) ? ADDRESS_EMPTY : ADDRESS_HIT;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const deps = { fetchImpl, sleep: async () => {} };

    // Stedsnavn: "Rana" and "Gildeskål" resolve; "Mevika" resolves to a WRONG
    // place ~600 km away (the real measured trap); "Ingenstedet"/"Nowhere" do
    // not resolve at all.
    let stedsnavnCalls: string[] = [];
    let kommuneCalls: string[] = [];
    geo.__setGeocodingFetchForTesting((async (input: any) => {
      const url = decodeURIComponent(String(input));
      const m = /sok=([^&]+)/i.exec(url);
      const q = (m?.[1] || "").toLowerCase();
      if (url.includes("/stedsnavn/")) {
        stedsnavnCalls.push(q);
        if (q === "rana") return json(stedsnavn("Rana", "Kommune", 66.31, 14.14));
        // The live B1 case: Kartverket's top acceptable hit for «Gjerdrum» is a
        // Grend in Våler, Innlandet — 79.6 km from Gjerdrum kommune in Akershus.
        if (q === "gjerdrum") return json(stedsnavn("Gjerdrum", "Grend", 60.68335, 11.7955));
        // The 600-km Boligfelt.
        if (q === "mevika") return json(stedsnavn("Mevika", "Boligfelt", 61.77669, 5.27334));
        // A genuine bygd with no same-named kommune — must survive untouched.
        if (q === "hegra") return json(stedsnavn("Hegra", "Bygdelag (bygd)", 63.464, 11.114));
        if (q === "stokmarknes") return json(stedsnavn("Stokmarknes", "By", 68.5655, 14.9046));
        if (q === "gildeskål") return json(stedsnavn("Gildeskål", "Kommune", 67.006, 13.9437));
        if (q === "misvær") return json(stedsnavn("Misvær", "Tettsted", 67.1188, 14.9992));
        if (q === "vadsø") return json(stedsnavn("Vadsø", "By", 70.0744, 29.7487));
      }
      if (url.includes("/kommuneinfo/")) {
        const kn = /knavn=([^&]+)/i.exec(url)?.[1]?.toLowerCase() || "";
        kommuneCalls.push(kn);
        // Only these names are real kommuner. «Hegra», «Mevika» and «Misvær»
        // are not — Kommuneinfo answers 404, which is the case that must NOT
        // discard an otherwise-good bygd hit.
        const K: Record<string, [number, number]> = {
          "gjerdrum": [60.0788, 11.0206],
          "gildeskål": [67.006, 13.9437],
          "rana": [66.31, 14.14],
          "senja": [69.2311, 17.9873],
        };
        const hit = K[kn];
        if (!hit) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        return json({ kommuner: [{
          kommunenavn: kn, kommunenavnNorsk: kn, kommunenummer: "9999",
          punktIOmrade: { coordinates: [hit[1], hit[0]] },
        }] });
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch);
    const json = (body: any) =>
      ({ ok: true, status: 200, json: async () => body } as unknown as Response);

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      geo.__clearGeocodeCacheForTesting();
      budget.__resetKartverketBudgetForTesting();

      const worker = require("./agents-geocode-worker") as typeof import("./agents-geocode-worker");
      const postal = require("./agents-postal-backfill") as typeof import("./agents-postal-backfill");
      const sched = require("./backfill-scheduler") as typeof import("./backfill-scheduler");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             lat, lng, city, is_active, geo_precision, geocode_attempts)
         VALUES (@id, @name, 'Lokal matprodusent', 'test', 'a@b.no', 'https://example.no',
                 'producer', @api_key, @lat, @lng, @city, 1, @geo_precision, @geocode_attempts)`
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code) VALUES (?, ?, ?)`
      );
      const seed = (o: {
        id: string; name: string; lat?: number | null; lng?: number | null;
        city?: string | null; geo_precision?: string | null; geocode_attempts?: number;
        address?: string | null; postal_code?: string | null;
      }) => {
        insertAgent.run({
          id: o.id, name: o.name, api_key: `key-${o.id}`,
          lat: o.lat ?? null, lng: o.lng ?? null, city: o.city ?? null,
          geo_precision: o.geo_precision ?? null,
          geocode_attempts: o.geocode_attempts ?? 0,
        });
        if (o.address !== undefined || o.postal_code !== undefined) {
          insertKnowledge.run(o.id, o.address ?? null, o.postal_code ?? null);
        }
      };
      const rowOf = (id: string) => db
        .prepare(`SELECT lat, lng, geo_precision, geocode_source, geocode_outcome,
                         geocode_attempted_at, geocode_attempts, geo_place_label
                    FROM agents WHERE id = ?`)
        .get(id) as any;

      // ═══════════════════════════════════════════════════════════════
      // tc1-tc12 — Tier C: the place suffix in the producer's own name
      // Mutations verified to turn these red:
      //   • drop `.reverse()` in placeSuffixCandidates  → tc5 + tc11 fail
      //   • allow "-" in NAME_PLACE_SUFFIX              → tc4 fails
      //   • drop the `hasNoPosition` guard on Tier C    → tc9 fails
      //   • let Tier C write 'address'                  → tc8 fails
      //   • drop normalizeCityLabel()                   → tc6 fails
      // ═══════════════════════════════════════════════════════════════
      {
        const cands = worker.placeSuffixCandidates;
        assertEq(JSON.stringify(cands("Straumbotn Gård — Rana")), JSON.stringify(["Rana"]),
          "tc1: a plain «Navn — Sted» suffix yields the place");
        assertEq(JSON.stringify(cands("Bjertnæs & Hoel")), JSON.stringify([]),
          "tc2: a name with no dash yields nothing to try");
        assertEq(JSON.stringify(cands("Beiarmat")), JSON.stringify([]),
          "tc3: a single-word name yields nothing (no suffix to mine)");
        assertEq(JSON.stringify(cands("Bent Gate Brewing")), JSON.stringify([]),
          "tc4a: a name with neither dash nor separator yields nothing");
        // Both of these are LIVE names from the cohort, and both contain a
        // hyphen INSIDE the place. Admitting "-" as a separator would silently
        // truncate them to "Ål" and "Telemark" — different places.
        assertEq(cands("Ål Markedshage — Øvre-Ål")[0], "Øvre-Ål",
          "tc4: a plain HYPHEN is not a suffix separator — «Øvre-Ål» stays ONE token");
        assertEq(cands("Eventyrmost — Midt-Telemark")[0], "Midt-Telemark",
          "tc4b: …and so does «Midt-Telemark» (admitting '-' would leave just «Telemark»)");

        // The measured trap. Locality-first sent «Mevika, Gildeskål» to a
        // Boligfelt in Vestland, ~600 km from Gildeskål in Nordland.
        assertEq(cands("Solvold Gård — Mevika, Gildeskål")[0], "Gildeskål",
          "tc5: LAST token first — the administrative container, not the locality (the Mevika trap)");
        assertEq(JSON.stringify(cands("Tjamsland Ysteri — Agder")), JSON.stringify([]),
          "tc6: a fylke label is dropped by normalizeCityLabel before it costs a request");
        assertEq(cands("Kapczynska Bakeri — Husøy i Senja")[0], "Senja",
          "tc7: « i » separates too — «Husøy i Senja» → Senja (measured recovery)");

        // End-to-end: no address, no city, only the name.
        seed({ id: "tc-name", name: "Straumbotn Gård — Rana" });
        const r = await worker.agentsGeocodeTick(50, deps);
        const row = rowOf("tc-name");
        assertEq(row.geo_precision, "kommune",
          "tc8: Tier C places a name-only row at kommune precision — NEVER 'address', so no km figure is licensed");
        assertEq(row.lat, 66.31, "tc8b: …at the resolved place's point");
        assertEq(row.geocode_outcome, "name_suffix_centroid", "tc8c: …stamped with its own outcome");
        assertEq(r.name_suffix_precision, 1, "tc8d: …and counted separately from the city tier");

        // A row that already HAS a position is never touched by Tier C.
        seed({ id: "tc-hascoords", name: "Bakeverkstedet Salten — Misvær", lat: 60.1, lng: 11.2 });
        await worker.agentsGeocodeTick(50, deps);
        const hc = rowOf("tc-hascoords");
        assertEq(hc.lat, 60.1,
          "tc9: a row that already has coordinates is NOT overwritten by a name-suffix centroid");
        assertEq(hc.geocode_attempted_at, null,
          "tc9b: …it is not even selected, so no attempt is spent on it");

        // The compound case, end to end.
        stedsnavnCalls = [];
        geo.__clearGeocodeCacheForTesting();
        seed({ id: "tc-compound", name: "Solvold Gård — Mevika, Gildeskål" });
        await worker.agentsGeocodeTick(50, deps);
        const comp = rowOf("tc-compound");
        assertEq(comp.lat, 67.006,
          "tc10: the compound suffix resolves to Gildeskål (67.006), NOT the 600-km-wrong Mevika point");
        assertTrue(stedsnavnCalls[0] === "gildeskål",
          `tc11: …because the container is queried FIRST (queries: ${JSON.stringify(stedsnavnCalls)})`);
        assertTrue(!stedsnavnCalls.includes("mevika"),
          "tc12: …and the locality is never queried at all once the container answers");

        // tc13-tc14: the in-loop no-coordinates guard, exercised on a row the
        // SELECTOR does let through. The SQL predicate for Tier C already
        // requires NO coordinates, so tc9 above can only prove the selector —
        // it passes even with the in-loop guard deleted (found by mutating this
        // very file). This row qualifies on TIER A (address + postnummer), so it
        // IS selected, its address then misses, and control reaches Tier C with
        // a seed coordinate present. Only the in-loop guard stops the overwrite.
        seed({
          id: "tc-tierA-fallthrough", name: "Seedgård — Rana",
          lat: 59.9, lng: 10.7,
          address: "Ingenveien 1", postal_code: "9999",
        });
        await worker.agentsGeocodeTick(50, deps);
        const ft = rowOf("tc-tierA-fallthrough");
        assertEq(ft.lat, 59.9,
          "tc13: a SELECTED row whose address misses keeps its seed coordinate — Tier C does not overwrite it");
        assertEq(ft.geocode_outcome, "no_match",
          "tc14: …and is honestly stamped no_match rather than given a centroid it did not earn");
      }

      // ═══════════════════════════════════════════════════════════════
      // b1-b6 — REVIEW B1: a hamlet must not outrank the kommune it shares
      // a name with. Two REAL producers (Bent Gate Brewing, Haukerudhagen)
      // landed on the Gjerdrum Grend in Innlandet — 79.6 km from Gjerdrum
      // kommune in Akershus, a different fylke.
      // Mutations verified to turn these red:
      //   • drop the kommune-corroboration step  → b1/b2 fail
      //   • drop the boligfelt refusal           → b5 fails
      //   • corroborate MAJOR hits too           → b4 fails (extra request)
      // ═══════════════════════════════════════════════════════════════
      {
        geo.__clearGeocodeCacheForTesting();
        kommuneCalls = [];
        seed({ id: "b1-gjerdrum", name: "Bent Gate Brewing — Gjerdrum" });
        await worker.agentsGeocodeTick(50, deps);
        const g = rowOf("b1-gjerdrum");
        assertEq(g.lat, 60.0788,
          "b1: a Grend hit is corroborated against Kommuneinfo and the KOMMUNE wins (Akershus, not the Innlandet hamlet)");
        assertEq(g.geo_precision, "kommune",
          "b2: …and the claim is the coarse tier, which the honesty rule renders without a km figure");
        assertEq(g.geo_place_label, "gjerdrum",
          "b3: …labelled with the place that actually answered");

        // A town-scale hit must NOT pay an extra Kommuneinfo request.
        geo.__clearGeocodeCacheForTesting();
        kommuneCalls = [];
        // Stokmarknes, not Vadsø: Vadsø is in the curated MAJOR_CITIES table and
        // so never reaches Kartverket, which would make this assert nothing.
        seed({ id: "b1-major", name: "Bakeri — Stokmarknes" });
        await worker.agentsGeocodeTick(50, deps);
        assertEq(kommuneCalls.length, 0,
          "b4: a MAJOR settlement hit is trusted outright — no extra corroboration request");
        assertEq(rowOf("b1-major").geo_precision, "city",
          "b4b: …and a town is the only thing allowed to claim the 'city' tier");

        // The curated MAJOR_CITIES table holds regions and fylker («Hallingdal»,
        // «Setesdal», «Trøndelag») alongside towns, and carries no
        // navneobjekttype of its own. It is classified by its own documented
        // radius heuristic so a town still claims 'city' while a region claims
        // the coarse tier — getting this wrong demoted every major city at once
        // (caught by the Fase-1a suite, not by this one, which is why it is
        // asserted here now).
        geo.__clearGeocodeCacheForTesting();
        seed({ id: "b1-hardcoded", name: "Bakeri — Vadsø" });
        await worker.agentsGeocodeTick(50, deps);
        assertEq(rowOf("b1-hardcoded").geo_precision, "city",
          "b4c: a curated TOWN entry still claims 'city' — the table is not blanket-demoted");
        const region = await geo.geocodingService.geocodePlaceForBackfill("Hallingdal");
        assertEq(worker.precisionForPlaceType(region?.placeType), "kommune",
          "b4d: …while a curated REGION entry claims the coarse tier, never 'city'");

        // Boligfelt: refused outright. This is the 600 km «Mevika» point.
        geo.__clearGeocodeCacheForTesting();
        seed({ id: "b1-mevika", name: "Solvold Gård — Mevika" });
        await worker.agentsGeocodeTick(50, deps);
        const mv = rowOf("b1-mevika");
        assertEq(mv.lat, null,
          "b5: a Boligfelt is REFUSED — «Mevika» does not get written at 61.78/5.27, ~600 km from Gildeskål");
        assertEq(mv.geocode_outcome, "no_match", "b5b: …and the row is honestly stamped no_match");

        // A genuine bygd with no same-named kommune survives untouched — this
        // is what "refuse tier-4 outright" would have cost 18 producers.
        geo.__clearGeocodeCacheForTesting();
        seed({ id: "b1-hegra", name: "Fuldseth Gård — Hegra" });
        await worker.agentsGeocodeTick(50, deps);
        assertEq(rowOf("b1-hegra").lat, 63.464,
          "b6: a Bygdelag with no same-named kommune is KEPT (Kommuneinfo 404 must not discard a good hit)");
      }

      // ═══════════════════════════════════════════════════════════════
      // db1-db3 — REVIEW B2: the centroid tiers must never consult the local
      // `agents` table. geocode() tries it BEFORE Kartverket and answers with
      // another producer's seed coordinate; 80 of 183 live Tier-C tokens match
      // an existing agents.city, so production would have taken that path.
      // Mutation verified: point placeCentroid back at geocodingService.geocode
      //   → db1/db2 fail (the row adopts the sibling's Tromsø position).
      // ═══════════════════════════════════════════════════════════════
      {
        geo.__clearGeocodeCacheForTesting();
        // A sibling row whose city is «Hegra» but whose coordinate is TROMSØ —
        // exactly the shape lookupInDatabase() would hand back.
        seed({ id: "db-sibling", name: "Sibling", city: "Hegra", lat: 69.6496, lng: 18.956,
               geo_precision: "address" });
        seed({ id: "db-victim", name: "Ny Gård — Hegra" });
        await worker.agentsGeocodeTick(50, deps);
        const v = rowOf("db-victim");
        assertEq(v.lat, 63.464,
          "db1: Tier C resolves «Hegra» through KARTVERKET, not through a sibling row's coordinate");
        assertTrue(v.lat !== 69.6496,
          "db2: …so it does not adopt the sibling's Tromsø position (the reproduced B2 bug)");
        assertTrue(v.geocode_source !== "database",
          `db3: …and never records source=database (got ${JSON.stringify(v.geocode_source)})`);
      }

      // ═══════════════════════════════════════════════════════════════
      // lb1-lb4 — the honesty LABEL must say where the producer is.
      // This cohort has city = NULL by definition, and the registry's legacy
      // `row.city || "Oslo"` default would have announced ~250 producers in
      // Rana/Misvær/Flåm as «i Oslo-området».
      // Mutations verified to turn these red:
      //   • stop persisting geo_place_label      → lb1/lb3 fail
      //   • drop the geo_place_label fallback in
      //     marketplace-registry's location map  → lb3/lb4 fail («Oslo»)
      // ═══════════════════════════════════════════════════════════════
      {
        geo.__clearGeocodeCacheForTesting();
        seed({ id: "lb-1", name: "Straumbotn Gård — Rana" });
        await worker.agentsGeocodeTick(50, deps);
        assertEq(rowOf("lb-1").geo_place_label, "Rana",
          "lb1: the resolved place is PERSISTED — without it the label has nothing to say");

        const precision = require("./geo-precision") as typeof import("./geo-precision");
        assertEq(precision.formatRfbDistanceLabel(4.2, "kommune", "Rana"), "i Rana-området",
          "lb2: a centroid row with a place renders «i X-området», never a km figure");
        assertEq(precision.formatRfbDistanceLabel(4.2, "kommune", null), "omtrentlig posisjon",
          "lb2b: …and without one it degrades to the useless bare string — which is why lb1 matters");

        const registry = require("./marketplace-registry") as any;
        const agent = registry.marketplaceRegistry.getAgent("lb-1");
        assertEq(agent?.location?.city, "Rana",
          "lb3: the registry surfaces the resolved place as the location label…");
        assertTrue(agent?.location?.city !== "Oslo",
          "lb4: …instead of the legacy «Oslo» default, which would name the wrong city outright");
      }

      // ═══════════════════════════════════════════════════════════════
      // pk1-pk9 — parking: a terminal state, not an infinite retry
      // Mutations verified to turn these red:
      //   • drop NOT_PARKED from SELECTABLE           → pk3 fails
      //   • stop incrementing geocode_attempts        → pk1/pk2/pk3 fail
      //   • stop resetting geocode_attempts on write  → pk6 fails
      //   • make unpark a no-op                       → pk7/pk8 fail
      // ═══════════════════════════════════════════════════════════════
      {
        // Start from an empty universe: the Tier-C fixtures above include rows
        // that also miss for ever, and parking counts are assertions about the
        // WHOLE queue. (Found by re-running the mutation harness after adding
        // tc13 — the pk block silently started counting two parked rows.)
        db.exec(`DELETE FROM agent_knowledge; DELETE FROM agents;`);

        const MAX = worker.AGENTS_GEOCODE_MAX_ATTEMPTS;
        seed({ id: "pk-miss", name: "Ukjent Gård — Nowhere", address: "Ingenveien 99", postal_code: "9999" });

        for (let i = 0; i < MAX; i++) await worker.agentsGeocodeTick(50, deps);
        const parked = rowOf("pk-miss");
        assertEq(parked.geocode_attempts, MAX,
          `pk1: ${MAX} fruitless attempts accumulate on the counter`);
        assertEq(parked.geocode_outcome, "no_match", "pk2: …each one stamped honestly");

        const before = parked.geocode_attempted_at;
        const t = await worker.agentsGeocodeTick(50, deps);
        assertEq(rowOf("pk-miss").geocode_attempted_at, before,
          "pk3: a PARKED row is no longer selected — the infinite retry stops");
        assertEq(t.processed, 0, "pk3b: …and there was nothing else to do");

        const st = worker.agentsGeocodeQueueStatus();
        assertEq(st.unreachable.parked_after_retries, 1,
          "pk4: …and it is REPORTED as parked, not hidden in 'unknown, might be fixable'");
        assertEq(st.pending, 0, "pk5: …and no longer counted as pending");

        // Progress resets the counter.
        seed({ id: "pk-reset", name: "Fin Gård", city: "Trondheim", address: "Kongens gate 1", postal_code: "7011",
               geocode_attempts: MAX - 1 });
        await worker.agentsGeocodeTick(50, deps);
        assertEq(rowOf("pk-reset").geocode_attempts, 0,
          "pk6: a successful write RESETS the counter — a row is never parked while it is improving");

        // unpark
        const wouldClear = worker.unparkAgentsGeocode(true);
        assertEq(wouldClear, 1, "pk7: unpark(dryRun) reports what it WOULD clear");
        assertEq(rowOf("pk-miss").geocode_attempts, MAX, "pk7b: …and writes nothing");
        assertEq(worker.unparkAgentsGeocode(false), 1, "pk8: unpark(real) clears it");
        assertEq(rowOf("pk-miss").geocode_attempts, 0, "pk8b: …so the row is selectable again");
        assertTrue(worker.agentsGeocodeQueueStatus().pending > 0,
          "pk9: …and shows up as pending once more");
      }

      // ═══════════════════════════════════════════════════════════════
      // tb1-tb2 — REVIEW B3 / M21: Tier B's own no-coordinates guard.
      // This is the guard protecting the ~110 `seed_coordinates_no_address`
      // rows — the cohort the whole "do we reclassify seed coordinates"
      // question is about — and deleting it left every suite green, exactly
      // like the Tier-C twin (tc9→tc13) found earlier by self-mutation.
      // Same fixture shape: the SQL selector requires NO coordinates for Tier
      // B, so only a row selected on TIER A (address + postnummer) whose
      // address then MISSES can reach Tier B with a coordinate present. Only
      // the in-loop guard stops the overwrite there.
      // Mutation verified: delete `hasNoPosition` from the Tier B condition
      //   → tb1/tb2 fail (the seed coordinate is replaced by a city centroid).
      // ═══════════════════════════════════════════════════════════════
      {
        db.exec(`DELETE FROM agent_knowledge; DELETE FROM agents;`);
        geo.__clearGeocodeCacheForTesting();
        seed({
          id: "tb-seed", name: "Seedgård uten navnesuffiks",
          lat: 59.9, lng: 10.7,          // unknown-provenance seed coordinate
          city: "Vadsø",                 // Tier B would resolve this…
          address: "Ingenveien 1", postal_code: "9999",  // …but Tier A selects and misses
        });
        await worker.agentsGeocodeTick(50, deps);
        const tb = rowOf("tb-seed");
        assertEq(tb.lat, 59.9,
          "tb1: Tier B does NOT overwrite an existing seed coordinate with a city centroid, even on a selected row");
        assertEq(tb.geo_precision, null,
          "tb2: …and the row keeps its honest unknown provenance rather than being relabelled 'city'");
      }

      // ═══════════════════════════════════════════════════════════════
      // hb1-hb2 — REVIEW B3 / M24: the postal worker's backlog probe must
      // count only NEVER-ATTEMPTED rows. Counting every row still missing a
      // postnummer would keep the fast cadence on for ever, because most of
      // this worker's refusals are permanent (an address with no house number
      // never becomes unique) — "a hot loop dressed as a backlog", as the
      // source comment puts it. Nothing asserted it.
      // Mutation verified: drop the postal_backfill_attempted_at IS NULL
      //   clause → hb2 fails (backlog still true after the row was attempted).
      // ═══════════════════════════════════════════════════════════════
      {
        db.exec(`DELETE FROM agent_knowledge; DELETE FROM agents;`);
        seed({ id: "hb-1", name: "Uten postnummer", city: "Vadsø", address: "Gate 1" });
        assertTrue(postal.postalBackfillHasBacklog(),
          "hb1: a never-attempted address-without-postnummer row IS a backlog");

        db.prepare(
          `UPDATE agent_knowledge SET postal_backfill_attempted_at = ?, postal_backfill_outcome = 'unusable_input'
            WHERE agent_id = 'hb-1'`
        ).run(new Date().toISOString());
        assertTrue(!postal.postalBackfillHasBacklog(),
          "hb2: once attempted it is NOT — a permanently-unresolvable row must let the cadence decay, not pin it fast for ever");
      }

      // ═══════════════════════════════════════════════════════════════
      // bg1-bg6 — the shared 2 req/s ceiling
      // Mutations verified to turn these red:
      //   • return without waiting in takeKartverketBudget → bg1/bg2 fail
      //   • make budgetedFetch pass through unwrapped      → bg4 fails
      //   • give each worker its own bucket again          → bg5 fails
      // ═══════════════════════════════════════════════════════════════
      {
        budget.__resetKartverketBudgetForTesting();
        const waits: number[] = [];
        const sleep = async (ms: number) => { waits.push(ms); };

        // The ceiling is KARTVERKET_MAX_RPS per window; the (MAX+1)-th request
        // in the same window must WAIT rather than go straight out.
        for (let i = 0; i < budget.KARTVERKET_MAX_RPS; i++) {
          await budget.takeKartverketBudget(sleep, 1);
        }
        assertEq(waits.length, 0,
          `bg1: the first ${budget.KARTVERKET_MAX_RPS} requests in a window pass without waiting`);
        await budget.takeKartverketBudget(sleep, 1);
        assertEq(waits.length, 1,
          "bg2: the one that would breach the ceiling waits for the window instead");

        budget.__resetKartverketBudgetForTesting();
        const waits2: number[] = [];
        await budget.takeKartverketBudget(async (ms) => { waits2.push(ms); }, budget.KARTVERKET_MAX_RPS + 1);
        assertEq(waits2.length, 1,
          "bg3: a cost>1 reservation is charged per slot, so it waits exactly like separate takes");

        // budgetedFetch draws one token PER REQUEST — this is what makes
        // geocodeOne's 4-step ladder counted exactly instead of estimated at 1.
        budget.__resetKartverketBudgetForTesting();
        const waits3: number[] = [];
        let inner = 0;
        const wrapped = budget.budgetedFetch(
          (async () => { inner++; return { ok: true, status: 200, json: async () => ({}) } as any; }) as any,
          async (ms: number) => { waits3.push(ms); }
        );
        for (let i = 0; i < budget.KARTVERKET_MAX_RPS + 1; i++) await wrapped("https://x" as any);
        assertEq(inner, budget.KARTVERKET_MAX_RPS + 1, "bg4: the wrapped fetch still performs every request");
        assertEq(waits3.length, 1, "bg4b: …and each one drew a token, so the ceiling bit");

        // ONE bucket, not one per worker: a take from the postal worker's side
        // must consume budget the geocode worker then has to wait for.
        budget.__resetKartverketBudgetForTesting();
        const shared: number[] = [];
        const s2 = async (ms: number) => { shared.push(ms); };
        for (let i = 0; i < budget.KARTVERKET_MAX_RPS; i++) await budget.takeKartverketBudget(s2, 1);
        const w2 = budget.budgetedFetch(
          (async () => ({ ok: true, status: 200, json: async () => ({}) } as any)) as any, s2
        );
        await w2("https://y" as any);
        assertEq(shared.length, 1,
          "bg5: the budget is PROCESS-WIDE — traffic taken by one worker throttles the other");
        assertEq(budget.KARTVERKET_MAX_RPS, 2, "bg6: the documented ceiling is 2 req/s");
      }

      // ═══════════════════════════════════════════════════════════════
      // sc1-sc9 — the adaptive scheduler and ALWAYS-RESCHEDULE
      // Mutations verified to turn these red:
      //   • DELETE the `finally` (so a throwing tick escapes)  → sc5/sc6 fail
      //     — the earlier claim here was "move the re-arm out of finally into
      //     the try", which is NOT a killable mutant: `finally` still runs when
      //     the catch returns, so that edit changes nothing. Review caught the
      //     bad claim; the corrected mutation above does kill sc5/sc6.
      //   • drop the try/catch around hasBacklog()         → sc7 throws, sc7/sc8 fail
      //   • return backlogDelayMs unconditionally          → sc3 fails
      // ═══════════════════════════════════════════════════════════════
      {
        assertEq(sched.nextBackfillDelayMs(true, 60_000, 3_600_000), 60_000,
          "sc1: a backlog picks the fast cadence");
        assertEq(sched.nextBackfillDelayMs(false, 60_000, 3_600_000), 3_600_000,
          "sc2: a drained queue decays to the slow one");

        // Drive the chain synchronously through an injected timer.
        const runTimer = async (opts: {
          runTick: () => Promise<void>;
          hasBacklog: () => boolean;
          cycles: number;
        }) => {
          const delays: number[] = [];
          let pending: (() => void) | null = null;
          const h = sched.startBackfillScheduler({
            label: "test",
            runTick: opts.runTick,
            hasBacklog: opts.hasBacklog,
            backlogDelayMs: 60_000,
            idleDelayMs: 3_600_000,
            bootDelayMs: 1,
            log: () => {},
            setTimer: (fn: () => void, ms: number) => { delays.push(ms); pending = fn; return 1; },
            clearTimer: () => { pending = null; },
          });
          for (let i = 0; i < opts.cycles; i++) {
            const fn = pending;
            if (!fn) break;
            pending = null;
            fn();
            // let the async cycle settle
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
          }
          h.stop();
          return delays;
        };

        let backlog = true;
        let ticks = 0;
        const d1 = await runTimer({
          runTick: async () => { ticks++; if (ticks >= 2) backlog = false; },
          hasBacklog: () => backlog,
          cycles: 3,
        });
        assertEq(d1[0], 1, "sc3a: the first tick is armed at the boot delay");
        assertEq(d1[1], 60_000, "sc3: while a backlog exists the cadence is the fast one");
        assertEq(d1[2], 3_600_000, "sc4: once drained it decays to hourly BY ITSELF — no flag to unset");

        // THE INVARIANT. A throwing tick must not stop the chain.
        let thrown = 0;
        const d2 = await runTimer({
          runTick: async () => { thrown++; throw new Error("simulated tick failure"); },
          hasBacklog: () => true,
          cycles: 3,
        });
        assertTrue(thrown >= 3, `sc5: a tick that THROWS is retried, not abandoned (ran ${thrown}×)`);
        assertTrue(d2.length >= 3,
          `sc6: …because the re-arm lives in finally — ${d2.length} timers were armed`);

        // …and so must a throwing backlog probe.
        let probed = 0;
        const d3 = await runTimer({
          runTick: async () => {},
          hasBacklog: () => { probed++; throw new Error("db not ready"); },
          cycles: 2,
        });
        assertTrue(probed >= 2, `sc7: a THROWING backlog probe does not stop the chain either (${probed}×)`);
        assertEq(d3[1], 3_600_000,
          "sc8: …and an unknown queue state falls back to the SLOW cadence, never a hot loop");

        // stop() actually stops.
        let after = 0;
        const h = sched.startBackfillScheduler({
          label: "test-stop",
          runTick: async () => { after++; },
          hasBacklog: () => true,
          backlogDelayMs: 1, idleDelayMs: 1, bootDelayMs: 1,
          log: () => {},
          setTimer: () => 1,
          clearTimer: () => {},
        });
        h.stop();
        assertEq(after, 0, "sc9: stop() before the first tick means no tick runs");
      }

      // ═══════════════════════════════════════════════════════════════
      // ob1-ob7 — observability: no row may hide
      // Mutations verified to turn these red:
      //   • drop `parked` from the unreachable buckets  → ob1 fails (sum ≠ total)
      //   • report `pending` from the OLD selector      → ob4 fails
      // ═══════════════════════════════════════════════════════════════
      {
        // Fresh DB so the counts are about the fixture, not the earlier blocks.
        const db2 = new Database(":memory:");
        initMod.__setDbForTesting(db2 as any);
        initMod.__initSchemaForTesting(db2 as any);
        const ins = db2.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                               lat, lng, city, is_active, geo_precision, geocode_attempts)
           VALUES (@id, @name, 'x', 'test', 'a@b.no', 'https://e.no', 'producer', @api_key,
                   @lat, @lng, @city, 1, @gp, @at)`
        );
        const insK = db2.prepare(`INSERT INTO agent_knowledge (agent_id, address, postal_code) VALUES (?,?,?)`);
        const s2 = (o: any) => {
          ins.run({ id: o.id, name: o.name, api_key: `k-${o.id}`, lat: o.lat ?? null, lng: o.lng ?? null,
                    city: o.city ?? null, gp: o.gp ?? null, at: o.at ?? 0 });
          if (o.address !== undefined || o.postal_code !== undefined) {
            insK.run(o.id, o.address ?? null, o.postal_code ?? null);
          }
        };
        s2({ id: "o-a", name: "A — Rana", address: "Vei 1", postal_code: "7011" });        // tier A
        s2({ id: "o-b", name: "B", city: "Vadsø" });                                        // tier B
        s2({ id: "o-c", name: "C — Rana" });                                                // tier C
        s2({ id: "o-post", name: "D", lat: 1, lng: 2, address: "Vei 2" });                  // awaiting postal
        s2({ id: "o-seed", name: "E", lat: 1, lng: 2, city: "Oslo" });                      // seed coords
        s2({ id: "o-none", name: "F" });                                                    // no signal
        s2({ id: "o-park", name: "G — Rana", at: worker.AGENTS_GEOCODE_MAX_ATTEMPTS });     // parked
        s2({ id: "o-done", name: "H", lat: 1, lng: 2, gp: "address" });                     // finished
        // Placed by THIS worker at kommune precision — honest, and different
        // from the unknown-provenance seed row above.
        s2({ id: "o-placed", name: "I", lat: 1, lng: 2, gp: "kommune" });

        const st = worker.agentsGeocodeQueueStatus(50);
        const u = st.unreachable;
        assertEq(u.awaiting_postal_backfill + u.seed_coordinates_no_address +
                 u.placed_at_centroid_no_address + u.no_usable_signal +
                 u.parked_after_retries, u.total,
          "ob1: the unreachable buckets are a true PARTITION — they sum to the total, so no row can hide");
        assertEq(st.pending + u.total, st.active - st.address_precision,
          "ob2: pending + unreachable accounts for EVERY row below address precision");
        assertEq(JSON.stringify(st.pending_by_tier), JSON.stringify({ address: 1, city_centroid: 1, name_suffix: 1 }),
          "ob3: pending is broken down by which ladder tier will be tried");
        assertEq(st.pending, 3, "ob4: pending counts exactly the rows the selector will pick");
        assertEq(u.awaiting_postal_backfill, 1,
          "ob5: an address-without-postnummer row is named as the SIBLING worker's queue, not as stuck");
        assertEq(u.seed_coordinates_no_address, 1,
          "ob6: a row with an UNKNOWN-provenance seed coordinate and no address is named for what it is");
        assertEq(u.placed_at_centroid_no_address, 1,
          "ob6a: …and one we placed honestly at a centroid is counted APART from it — different states");
        assertEq(u.no_usable_signal, 1, "ob6b: …and one with nothing at all likewise");
        assertEq(u.parked_after_retries, 1, "ob6c: …and the parked one likewise");
        assertTrue(st.drain.rows_per_hour > 1000 && st.drain.eta_hours !== null &&
                   st.drain.max_requests_per_second === 2,
          `ob7: drain answers "will this finish" — ${JSON.stringify(st.drain)}`);

        // ═════════════════════════════════════════════════════════════
        // dr1-dr4 — dry_run writes NOTHING (whole-DB hash)
        // Mutation verified: remove `if (dryRun) return` from record()
        //   → dr1 fails. Remove it from unpark → dr3 fails.
        // ═════════════════════════════════════════════════════════════
        const h0 = hashDb(db2);
        const dry = await worker.agentsGeocodeTick(50, { ...deps, dryRun: true });
        assertEq(hashDb(db2), h0,
          "dr1: a dry-run tick leaves the WHOLE DATABASE byte-identical (hash over every table)");
        assertTrue(dry.planned.length > 0, "dr2: …while still reporting what it would have done");
        worker.unparkAgentsGeocode(true);
        assertEq(hashDb(db2), h0, "dr3: unpark(dryRun) writes nothing either");
        const strict = worker.parseDryRunFlag("true");
        assertTrue(strict.ok === false,
          "dr4: the STRING \"true\" is still rejected — the flag that once performed a real prod write");

        db2.close();
        initMod.__setDbForTesting(db as any);
      }

      // ═══════════════════════════════════════════════════════════════
      // co1-co3 — the two workers cooperate
      // Mutation verified: drop `geocode_attempts = 0` from requeueGeocode
      //   → co2 fails (the row stays parked and the postnummer is never used).
      // ═══════════════════════════════════════════════════════════════
      {
        const db3 = new Database(":memory:");
        initMod.__setDbForTesting(db3 as any);
        initMod.__initSchemaForTesting(db3 as any);
        db3.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                               city, is_active, geocode_attempts, geocode_attempted_at)
           VALUES ('co-1','Gård — Rana','x','test','a@b.no','https://e.no','producer','k-co1',
                   'Rana', 1, ?, '2020-01-01T00:00:00.000Z')`
        ).run(worker.AGENTS_GEOCODE_MAX_ATTEMPTS);
        db3.prepare(`INSERT INTO agent_knowledge (agent_id, address, postal_code)
                     VALUES ('co-1','Nesnaveien 832, 8725 Utskarpen', NULL)`).run();

        assertEq(worker.agentsGeocodeQueueStatus().pending, 0,
          "co1: the parked row is not in the geocode queue");

        const pbFetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({
            metadata: { totaltAntallTreff: 1 },
            adresser: [{ postnummer: "8725", poststed: "UTSKARPEN", kommunenavn: "RANA",
                         kommunenummer: "1833", adressetekst: "Nesnaveien 832" }],
          }),
        } as any)) as unknown as typeof fetch;
        await postal.postalBackfillTick(10, { fetchImpl: pbFetch, sleep: async () => {} });

        const after = db3.prepare(`SELECT geocode_attempts, geocode_attempted_at FROM agents WHERE id='co-1'`)
          .get() as any;
        assertEq(after.geocode_attempts, 0,
          "co2: landing the postnummer UNPARKS the row — the blocker is gone, so the retry budget resets");
        assertEq(after.geocode_attempted_at, null,
          "co2b: …and clears the rotation stamp so it goes to the head of the queue, not the back");
        assertEq(worker.agentsGeocodeQueueStatus().pending, 1,
          "co3: …and it is pending again, now on Tier A");

        db3.close();
        initMod.__setDbForTesting(db as any);
      }
    } finally {
      // No-arg restores the real global fetch — same convention as the
      // sibling suite (agents-geocode-worker.test.ts:495).
      geo.__setGeocodingFetchForTesting();
      geo.__clearGeocodeCacheForTesting();
      budget.__resetKartverketBudgetForTesting();
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGeocodeCoverageBoostTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

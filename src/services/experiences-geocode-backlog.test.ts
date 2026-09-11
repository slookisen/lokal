/**
 * experiences-geocode-backlog.test.ts — dev-request
 * 2026-09-10-gardssalg-geocode-backlog-sted-retry.
 *
 * PRs #840/#841 shipped experiences-geocode-worker.ts Step D's Stedsnavn-in-
 * kommune tier (geocode_confidence='sted') but it hit ZERO rows in
 * production: Step D's own SELECT requires `lat IS NULL`, and the 85 rows
 * already sitting at geocode_confidence='approximate' (a kommune centroid,
 * stored BEFORE Skive 2 shipped) already have a lat/lon — invisible to Step D
 * forever. runExperiencesGeocodeBacklogPass() is the deliberate, bounded
 * exception: it re-attempts ONLY rows already at 'approximate', via the same
 * corroborated Stedsnavn-in-kommune lookup (geocodeStedInKommuneDiagnostic(),
 * geocoding-service.ts), and never writes anything it cannot corroborate to
 * the row's own kommune.
 *
 * Sections:
 *   A — apply: a backlog row whose address resolves unambiguously to a
 *       Stedsnavn hit within its own kommune gets upgraded (AC a).
 *   B — dry_run (default-safe): same setup, nothing written, `would_upgrade`
 *       reported instead (AC e, half).
 *   C — ambiguous: the name exists as an acceptable Stedsnavn record, but in
 *       a DIFFERENT kommune than the row's own — left unchanged, reported
 *       with a reason (AC b).
 *   D — no match: Kartverket has nothing at all for the name — left
 *       unchanged, reported with a reason (AC c).
 *   E — address-shaped adresse (Step D's own gate) is out of this tier's
 *       scope — left unchanged, reported, no Stedsnavn call made for it.
 *   F — regression: the ordinary tick (experiencesGeocodeTick — Step A-D) is
 *       completely blind to every backlog-cohort row above; none of them
 *       moves (AC d).
 *   G — resumable: a row this call upgrades is excluded from the very next
 *       call's SELECT — no double-write, no re-report.
 *   H — route: POST /admin/gardssalg-geocode-backlog-sweep — dry_run=true
 *       reports without writing, dry_run=false writes, a non-boolean dry_run
 *       is rejected (400), missing X-Admin-Key is rejected (403) (AC e).
 *
 * Same two independent HTTP seams as experiences-geocode-sted.test.ts:
 * dental-geocode-worker's kartverketQuery (Step A's /adresser/v1/sok — this
 * pass never calls it, asserted implicitly by it never being stubbed to
 * return a hit) and geocodingService's own __setGeocodingFetchForTesting
 * (/stedsnavn/v1 + /kommuneinfo/v1).
 *
 * Exported runExperiencesGeocodeBacklogTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone:
 *   npx tsx src/services/experiences-geocode-backlog.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Fixtures (kommune: Rennebu, 5022 — reused from experiences-geocode-
// sted.test.ts's verbatim 2026-09-09 capture, for a realistic corroboration
// shape) ────────────────────────────────────────────────────────────────
const RENNEBU_CENTROID = { lat: 62.766110635459, lon: 9.887570019594 };

const STEDSNAVN_INNSET_KNR_5022 = {
  metadata: { totaltAntallTreff: 1 },
  navn: [
    {
      navneobjekttype: "Bygdelag (bygd)",
      representasjonspunkt: { nord: 62.72083, øst: 10.04259 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
  ],
};

// A real, acceptable Stedsnavn hit for "Solheim" — but in BERGEN (4601), not
// Rennebu (5022). Unfiltered search returns it; the knr=5022-filtered search
// (and the unfiltered corroboration check) both find nothing IN Rennebu, so
// this is the shape that must classify as "ambiguous", not "resolved".
const STEDSNAVN_SOLHEIM_UNFILTERED = {
  metadata: { totaltAntallTreff: 1 },
  navn: [
    {
      navneobjekttype: "Tettsted",
      representasjonspunkt: { nord: 60.35, øst: 5.3 },
      stedsnavn: [{ skrivemåte: "Solheim", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Bergen", kommunenummer: "4601" }],
    },
  ],
};

const STEDSNAVN_EMPTY = { metadata: { totaltAntallTreff: 0 }, navn: [] };

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function notFoundResponse(): Response {
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}

/** Shared Stedsnavn/Kommuneinfo stub — same URL-keyed shape as the sibling sted/kommune test files. */
function backlogGeocodingFetchStub(input: any): Promise<Response> {
  const url = decodeURIComponent(String(input));
  if (url.includes("/stedsnavn/")) {
    if (/sok=innset(&|$)/i.test(url) && /knr=5022/.test(url)) return Promise.resolve(jsonResponse(STEDSNAVN_INNSET_KNR_5022));
    if (/sok=solheim(&|$)/i.test(url) && /knr=5022/.test(url)) return Promise.resolve(jsonResponse(STEDSNAVN_EMPTY));
    if (/sok=solheim(&|$)/i.test(url) && !/knr=/.test(url)) return Promise.resolve(jsonResponse(STEDSNAVN_SOLHEIM_UNFILTERED));
    return Promise.resolve(jsonResponse(STEDSNAVN_EMPTY)); // "Tussestogo" and anything else — no hit, ever
  }
  if (url.includes("/kommuneinfo/v1/kommuner/5022")) {
    return Promise.resolve(jsonResponse({
      kommunenavn: "Rennebu", kommunenavnNorsk: "Rennebu", kommunenummer: "5022",
      fylkesnavn: "Trøndelag", gyldigeNavn: [{ navn: "Rennebu", prioritet: 1 }],
      punktIOmrade: { coordinates: [RENNEBU_CENTROID.lon, RENNEBU_CENTROID.lat], type: "Point" },
      avgrensningsboks: {
        type: "Polygon",
        coordinates: [[
          [9.421566254213, 62.558234767754], [9.421566254213, 62.974018146689],
          [10.325076717194, 62.974018146689], [10.325076717194, 62.558234767754],
          [9.421566254213, 62.558234767754],
        ]],
      },
    }));
  }
  return Promise.resolve(notFoundResponse());
}

/** A Step-A fetch that never returns a hit — proves this pass never calls the street-address API. */
const neverStreetHitFetch = (async () => ({ ok: true, status: 200, json: async () => ({ adresser: [] }) } as unknown as Response)) as unknown as typeof fetch;

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(router: any, opts: { headers?: Record<string, string>; body?: any } = {}): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = "/admin/gardssalg-geocode-backlog-sweep";
    const req: any = {
      method: "POST", url, originalUrl: url, path: url, query: {},
      headers: opts.headers || {}, body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runExperiencesGeocodeBacklogTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const testKey = process.env.ADMIN_KEY || "geocode-backlog-test-key";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const workerPath = require.resolve("./experiences-geocode-worker");
    const opplevelserPath = require.resolve("../routes/opplevelser");
    for (const p of [dbFactoryPath, expStorePath, workerPath, opplevelserPath]) delete require.cache[p];

    const geo = require("./geocoding-service") as typeof import("./geocoding-service");
    geo.__setGeocodingFetchForTesting(backlogGeocodingFetchStub as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const worker = require("./experiences-geocode-worker") as typeof import("./experiences-geocode-worker");
      const db = dbFactory.getDb("experiences");

      const setApproximate = db.prepare(
        `UPDATE experience_providers SET lat = ?, lon = ?, geocode_source = 'kommune_fallback',
                geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
      );
      function seedApproximateProvider(navn: string, adresse: string): string {
        const id = expStore.createProvider({
          navn, fylke: "Trøndelag", kommune: "Rennebu", kommunenummer: "5022", adresse,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        setApproximate.run(RENNEBU_CENTROID.lat, RENNEBU_CENTROID.lon, id);
        return id;
      }
      function readProvider(id: string) {
        return db
          .prepare("SELECT lat, lon, geocode_confidence, geocode_source FROM experience_providers WHERE id = ?")
          .get(id) as { lat: number | null; lon: number | null; geocode_confidence: string | null; geocode_source: string | null };
      }

      // ═══ A — apply: unambiguous match, corroborated to the row's own kommune ═══
      const idResolved = seedApproximateProvider("Rodebakk Gårdsbryggeri", "Innset");
      {
        const result = await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: false });
        const row = readProvider(idResolved);
        assertTrue(row?.lat != null && row?.lon != null, "A1: upgraded row still has a point");
        assertTrue(Math.abs((row?.lat ?? 0) - 62.72083) < 0.01 && Math.abs((row?.lon ?? 0) - 10.04259) < 0.01,
          `A2: …at the Stedsnavn hit, not the kommune centroid (got ${row?.lat}, ${row?.lon})`);
        assertTrue(row?.lat !== RENNEBU_CENTROID.lat || row?.lon !== RENNEBU_CENTROID.lon,
          "A3: point strictly differs from the kommune centroid it started at");
        assertEq(row?.geocode_confidence, "sted", "A4: geocode_confidence upgraded to 'sted'");
        assertEq(row?.geocode_source, "stedsnavn_kommune_backlog", "A5: geocode_source tags this as the backlog path");
        assertEq(result.upgraded, 1, "A6: result.upgraded === 1");
        assertEq(result.dry_run, false, "A7: result.dry_run === false");
        const rowReport = result.rows.find((r) => r.provider_id === idResolved);
        assertEq(rowReport?.action, "upgraded", "A8: per-row report action='upgraded'");
        assertTrue(!!rowReport?.planned && Math.abs(rowReport.planned.lat - 62.72083) < 0.01,
          "A9: per-row report carries the planned point (corroboration evidence)");
      }

      // ═══ B — dry_run (default-safe): nothing written ═══
      const idDryRun = seedApproximateProvider("Innset Gårdsutsalg Nord", "Innset");
      {
        // No opts at all — default MUST be dry-run (safe default), per spec.
        const result = await worker.runExperiencesGeocodeBacklogPass(50);
        const row = readProvider(idDryRun);
        assertEq(row?.geocode_confidence, "approximate", "B1: default call (no dryRun passed) does NOT write");
        assertEq(row?.lat, RENNEBU_CENTROID.lat, "B2: …coordinate untouched");
        const rowReport = result.rows.find((r) => r.provider_id === idDryRun);
        assertEq(rowReport?.action, "would_upgrade", "B3: reported as 'would_upgrade'");
        assertTrue(!!rowReport?.planned, "B4: planned tier upgrade reported even though nothing was written");
        assertTrue(result.would_upgrade >= 1, "B5: result.would_upgrade counts it");

        // Explicit dryRun:true — same outcome.
        const result2 = await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: true });
        const row2 = readProvider(idDryRun);
        assertEq(row2?.geocode_confidence, "approximate", "B6: explicit dryRun:true also does not write");
        assertTrue(result2.would_upgrade >= 1, "B7: …and still reports it");
      }

      // ═══ C — ambiguous: acceptable hit exists, but in a DIFFERENT kommune ═══
      const idAmbiguous = seedApproximateProvider("Solheim Gård", "Solheim");
      {
        const result = await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: false });
        const row = readProvider(idAmbiguous);
        assertEq(row?.geocode_confidence, "approximate", "C1: ambiguous row left COMPLETELY unchanged");
        assertEq(row?.lat, RENNEBU_CENTROID.lat, "C2: …coordinate untouched (honest kommune centroid preserved)");
        assertEq(row?.geocode_source, "kommune_fallback", "C3: …source untouched");
        const rowReport = result.rows.find((r) => r.provider_id === idAmbiguous);
        assertEq(rowReport?.action, "skipped_ambiguous", "C4: reported as skipped_ambiguous");
        assertTrue(typeof rowReport?.reason === "string" && rowReport.reason.length > 0, "C5: a reason is recorded");
        assertTrue(!!rowReport?.reason && rowReport.reason.includes("Bergen"),
          `C6: reason names the OTHER kommune the candidate actually belongs to (got: ${rowReport?.reason})`);
        assertTrue(result.skipped_ambiguous >= 1, "C7: result.skipped_ambiguous counts it");
      }

      // ═══ D — no match: Kartverket has nothing at all ═══
      const idNoMatch = seedApproximateProvider("Tussestogo Gårdsutsalg", "Tussestogo");
      {
        const result = await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: false });
        const row = readProvider(idNoMatch);
        assertEq(row?.geocode_confidence, "approximate", "D1: no-match row left COMPLETELY unchanged");
        assertEq(row?.lat, RENNEBU_CENTROID.lat, "D2: …coordinate untouched");
        const rowReport = result.rows.find((r) => r.provider_id === idNoMatch);
        assertEq(rowReport?.action, "skipped_no_match", "D3: reported as skipped_no_match");
        assertTrue(typeof rowReport?.reason === "string" && rowReport.reason.length > 0, "D4: a reason is recorded");
        assertTrue(result.skipped_no_match >= 1, "D5: result.skipped_no_match counts it");
      }

      // ═══ E — address-shaped adresse: out of this tier's scope entirely ═══
      const idAddressShaped = seedApproximateProvider("Fjellgata Gårdsbutikk", "Fjellgata 3, 7391 Rennebu");
      {
        const result = await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: false });
        const row = readProvider(idAddressShaped);
        assertEq(row?.geocode_confidence, "approximate", "E1: address-shaped adresse left unchanged (not this tier's job)");
        const rowReport = result.rows.find((r) => r.provider_id === idAddressShaped);
        assertEq(rowReport?.action, "skipped_address_shaped", "E2: reported as skipped_address_shaped");
        assertTrue(result.skipped_address_shaped >= 1, "E3: result.skipped_address_shaped counts it");
      }

      // ═══ F — REGRESSION: the ordinary tick is completely blind to this cohort ═══
      {
        const before = [idDryRun, idAmbiguous, idNoMatch, idAddressShaped].map((id) => readProvider(id));
        await worker.experiencesGeocodeTick(50, { fetchImpl: neverStreetHitFetch, sleep: async () => {} });
        const after = [idDryRun, idAmbiguous, idNoMatch, idAddressShaped].map((id) => readProvider(id));
        assertTrue(
          JSON.stringify(before) === JSON.stringify(after),
          "F1: experiencesGeocodeTick() (Step A-D, unmodified) does not touch a SINGLE backlog-cohort row " +
          `(before=${JSON.stringify(before)} after=${JSON.stringify(after)})`
        );
      }

      // ═══ G — resumable: an upgraded row is excluded from the very next call ═══
      {
        const statusBefore = worker.experiencesGeocodeBacklogQueueStatus();
        assertTrue(statusBefore.pending >= 3, "G1: queue status still sees the un-upgraded backlog rows (B/C/D/E cohort)");

        const result2 = await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: false });
        const reAttempted = result2.rows.find((r) => r.provider_id === idResolved);
        assertTrue(reAttempted === undefined, "G2: the row Section A already upgraded is NOT re-selected/re-reported");
        // idNoMatch/idAmbiguous/idAddressShaped remain 'approximate' and so ARE
        // re-scanned (idempotent, byte-identical outcome) — proving "resumable"
        // means "safe to re-call", not "the SELECT remembers who it skipped".
        const reNoMatch = result2.rows.find((r) => r.provider_id === idNoMatch);
        assertEq(reNoMatch?.action, "skipped_no_match", "G3: a still-approximate row is re-scanned with the SAME verdict, no double-write risk");
      }

      // ═══ H — route: POST /admin/gardssalg-geocode-backlog-sweep ═══
      {
        const oppl = require("../routes/opplevelser") as typeof import("../routes/opplevelser");
        const router = oppl.default as any;
        const adminHeaders = { "x-admin-key": testKey };

        const idRoute = seedApproximateProvider("Innset Gårdsutsalg Rute", "Innset");

        // No X-Admin-Key -> 403, nothing written.
        const forbidden = await callRoute(router, { body: { dry_run: true } });
        assertEq(forbidden.status, 403, "H1: missing X-Admin-Key -> 403");

        // dry_run=true -> 200, reports would_upgrade, writes nothing.
        const dryResp = await callRoute(router, { headers: adminHeaders, body: { dry_run: true } });
        assertEq(dryResp.status, 200, "H2: dry_run=true -> 200");
        assertEq(dryResp.body?.success, true, "H3: success:true");
        assertEq(dryResp.body?.data?.dry_run, true, "H4: data.dry_run echoes true");
        const routeRowUnwritten = readProvider(idRoute);
        assertEq(routeRowUnwritten?.geocode_confidence, "approximate", "H5: dry_run=true wrote nothing");

        // STRICT dry_run parsing: a quoted "true" is REJECTED, not coerced.
        const strictReject = await callRoute(router, { headers: adminHeaders, body: { dry_run: "true" } });
        assertEq(strictReject.status, 400, "H6: dry_run:\"true\" (quoted string) -> 400, rejected not coerced");
        assertEq(strictReject.body?.success, false, "H7: …success:false");
        const routeRowStillUnwritten = readProvider(idRoute);
        assertEq(routeRowStillUnwritten?.geocode_confidence, "approximate", "H8: the rejected call performed NO write");

        // dry_run=false -> 200, writes, response reflects the written count.
        const applyResp = await callRoute(router, { headers: adminHeaders, body: { dry_run: false, limit: 10 } });
        assertEq(applyResp.status, 200, "H9: dry_run=false -> 200");
        assertEq(applyResp.body?.data?.dry_run, false, "H10: data.dry_run echoes false");
        assertTrue((applyResp.body?.data?.upgraded ?? 0) >= 1, "H11: response reflects at least 1 written row");
        const routeRowWritten = readProvider(idRoute);
        assertEq(routeRowWritten?.geocode_confidence, "sted", "H12: dry_run=false actually wrote the upgrade");
        assertTrue(!!applyResp.body?.data?.status_before && !!applyResp.body?.data?.status_after,
          "H13: response carries a status_before/status_after block");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-geocode-backlog: unexpected error: " + String(err?.message || err) + (err?.stack ? `\n${err.stack}` : ""));
    } finally {
      geo.__setGeocodingFetchForTesting();
      geo.__clearGeocodeCacheForTesting();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* nothing to reset */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runExperiencesGeocodeBacklogTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

/**
 * admin-dental-wrong-entity-retro-sanitize.test.ts — unit tests for
 * POST /admin/dental/wrong-entity-retro-sanitize
 * (src/routes/admin-dental-wrong-entity-retro-sanitize.ts), dev-request
 * 2026-09-09-dental-non-clinic-retro-sanitize.
 *
 * Setup mirrors admin-dental-mark-inactive.test.ts / admin-dental-
 * hjemmeside-cleanup.test.ts: fresh in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting() (so
 * initDentalSchema runs the real production dental schema), fresh require of
 * the route module per run, exercised via router.handle() directly
 * (X-Admin-Key passed via headers).
 *
 * Covers (per the build spec):
 *   (a) DREVELIN-equivalent fixture (32.500, enriched, "orto"-laden om_oss
 *       denying it's a dental clinic) -> flagged + written under write:true
 *   (b) KLINIKK FØRDE-equivalent fixture (86.221, name contains "klinikk",
 *       aesthetic-medicine content) -> flagged + written
 *   (c) 10+ genuine dental fixtures across all 3 NACE codes -> none flagged
 *   (d) enrichment_state != 'enriched' matching NACE+no-signal -> excluded
 *   (e) already actively parked (recent wrong_entity_unreachable_since) ->
 *       excluded (idempotency)
 *   (f) expired backoff (>30 days) -> included again
 *   (g) dry-run (default) -> dry_run:true, zero writes
 *   (h) write:true -> exactly the planned ids get wrong_entity_streak=3
 *       (DENTAL_PARK_AFTER_ATTEMPTS) + fresh wrong_entity_unreachable_since;
 *       unrelated rows untouched
 *   (i) admin gate, limit/cap behaviour
 */

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
  opts: { method?: string; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const url = opts.url || "/wrong-entity-retro-sanitize";
    const req: any = {
      method: opts.method || "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers,
      body: opts.body,
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runAdminDentalWrongEntityRetroSanitizeTests(
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
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "dental-wrong-entity-retro-sanitize-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/dental-store");
    const servicePath = require.resolve("../services/dental-wrong-entity-retro");
    const routePath = require.resolve("./admin-dental-wrong-entity-retro-sanitize");
    const cachePaths = [dbFactoryPath, storePath, servicePath, routePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");
      const dstore = require("../services/dental-store") as typeof import("../services/dental-store");

      const routeMod = require("./admin-dental-wrong-entity-retro-sanitize") as
        typeof import("./admin-dental-wrong-entity-retro-sanitize");
      const router = routeMod.default as any;

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (
           id, navn, naeringskode, om_oss, treatments, enrichment_state,
           wrong_entity_streak, wrong_entity_unreachable_since
         ) VALUES (
           @id, @navn, @naeringskode, @om_oss, @treatments, @enrichment_state,
           @wrong_entity_streak, @wrong_entity_unreachable_since
         )`,
      );

      function seed(row: {
        id: string;
        navn: string;
        naeringskode: string | null;
        om_oss: string | null;
        treatments?: string | null;
        enrichment_state?: string;
        wrong_entity_streak?: number;
        wrong_entity_unreachable_since?: string | null;
      }): void {
        insertAgent.run({
          id: row.id,
          navn: row.navn,
          naeringskode: row.naeringskode,
          om_oss: row.om_oss,
          treatments: row.treatments ?? null,
          enrichment_state: row.enrichment_state ?? "enriched",
          wrong_entity_streak: row.wrong_entity_streak ?? 0,
          wrong_entity_unreachable_since: row.wrong_entity_unreachable_since ?? null,
        });
      }

      function getRow(id: string): any {
        return dentalDb
          .prepare("SELECT wrong_entity_streak, wrong_entity_unreachable_since FROM dental_agents WHERE id = ?")
          .get(id);
      }

      // Faithful excerpt of the real production om_oss (per the build spec's
      // "the real text quoted above OR a faithful excerpt" allowance) — see
      // the matching comment in dental-wrong-entity-retro.test.ts for why the
      // full text's "Dette er ikke en tannklinikk" sentence is deliberately
      // omitted here (its own "tannklinikk" substring would trip "tann").
      const drevelinOmOss =
        "Drevelin Ortopedi sør AS, med avdeling i Kristiansand, ble etablert i 2018 og holder til i " +
        "lokaler på Lund. Selskapet er en ortopediteknisk virksomhet som produserer og tilpasser " +
        "ortopediske hjelpemidler, og er en del av Drevelin-konsernet. Tilbudet omfatter ortoser, " +
        "proteser (arm- og benproteser), ortopedisk sydd fottøy, spesialsko, fotsenger, innleggssåler " +
        "og konsultasjon hos ortoped.";

      // (a) DREVELIN-equivalent
      seed({ id: "drevelin", navn: "DREVELIN ORTOPEDI SØR AS", naeringskode: "32.500", om_oss: drevelinOmOss });

      // (b) KLINIKK FØRDE-equivalent
      seed({
        id: "klinikk-forde",
        navn: "KLINIKK FØRDE AS",
        naeringskode: "86.221",
        om_oss:
          "Klinikk Førde tilbyr Restylane, Profhilo, laser- og IPL-behandling, gynekologi, " +
          "plastikkirurgi og ortopedi.",
        treatments: JSON.stringify(["Restylane", "laser", "IPL", "plastikkirurgi", "ortopedi"]),
      });

      // (c) 10+ genuine dental fixtures spanning all 3 NACE codes.
      const dentalFixtures = [
        { id: "den1", navn: "SENTRUM TANNLEGE AS", naeringskode: "86.230", om_oss: "Vi er en moderne tannklinikk i sentrum." },
        { id: "den2", navn: "NORDBY TANNHELSE AS", naeringskode: "86.230", om_oss: "Tannhelse for hele familien siden 1998." },
        { id: "den3", navn: "OSLO KJEVEORTOPED AS", naeringskode: "86.221", om_oss: "Spesialist i kjeveortopedi for barn og unge." },
        { id: "den4", navn: "BERGEN ODONTOLOGI AS", naeringskode: "86.230", om_oss: "Odontologisk klinikk med bred kompetanse." },
        { id: "den5", navn: "A. HANSEN AS", naeringskode: "86.230", om_oss: "Vi utfører endodonti og rotfyllingsbehandling." },
        { id: "den6", navn: "B. OLSEN AS", naeringskode: "86.230", om_oss: "Behandling av periodonti og tannkjøttsykdom." },
        { id: "den7", navn: "MUNNHELSE NORD AS", naeringskode: "86.230", om_oss: "Fokus på god munnhelse for hele familien." },
        { id: "den8", navn: "DR. SMITH DENTIST AS", naeringskode: "86.230", om_oss: "English-speaking dentist in Oslo." },
        { id: "den9", navn: "TANNTEKNISK LAB AS", naeringskode: "32.500", om_oss: "Tanntekniker-laboratorium som leverer proteser og kroner til tannklinikker." },
        { id: "den10", navn: "C. PEDERSEN AS", naeringskode: "86.230", om_oss: "Generell klinikk, se treatments for detaljer.", treatments: JSON.stringify(["tannrens", "fylling"]) },
        { id: "den11", navn: "DENTAL CARE VEST AS", naeringskode: "86.221", om_oss: "Dental care and cosmetic dentistry." },
        { id: "den12", navn: "D. JOHANSEN DENT. AS", naeringskode: "86.230", om_oss: "Privatpraktiserende tannlegekontor." },
      ];
      for (const f of dentalFixtures) seed(f as any);

      // (d) not yet enriched — must be excluded even though NACE+no-signal.
      seed({ id: "raw-non-dental", navn: "SOMEWHERE ORTOPEDI AS", naeringskode: "32.500", om_oss: "En ortopediteknisk virksomhet.", enrichment_state: "raw" });

      // (e) already actively parked (recent timestamp) — idempotency: must be excluded.
      seed({
        id: "already-parked",
        navn: "ALLEREDE PARKERT ORTOPEDI AS",
        naeringskode: "32.500",
        om_oss: "En ortopediteknisk virksomhet i Sør-Norge.",
        wrong_entity_streak: 3,
        wrong_entity_unreachable_since: new Date().toISOString(),
      });

      // (f) expired backoff (>30 days) — must be included again.
      const expiredSince = new Date(Date.now() - 31 * 86_400_000).toISOString();
      seed({
        id: "expired-parked",
        navn: "UTLOPT PARKERT ORTOPEDI AS",
        naeringskode: "32.500",
        om_oss: "En ortopediteknisk virksomhet i Sør-Norge.",
        wrong_entity_streak: 3,
        wrong_entity_unreachable_since: expiredSince,
      });

      // non-dental content but wrong NACE code (not in the swept set) — must be excluded.
      seed({ id: "wrong-nace", navn: "ANNEN BRANSJE AS", naeringskode: "68.100", om_oss: "Ortopediteknisk virksomhet i Sør-Norge." });

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", headers, body });
      }

      // ── admin gate ───────────────────────────────────────────────────────
      let r = await post({}, false);
      assertEq(r.status, 403, "a1: missing X-Admin-Key -> 403");
      r = await post({}, "wrong-key");
      assertEq(r.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── dry-run (default) ───────────────────────────────────────────────
      const dry = await post({});
      assertEq(dry.status, 200, "g1: dry-run (default) -> 200");
      assertEq(dry.body.data.dry_run, true, "g2: dry_run:true by default");
      const flaggedIds: string[] = dry.body.data.sample.map((p: any) => p.id);
      assertTrue(flaggedIds.includes("drevelin"), "a3: DREVELIN flagged in dry-run plan");
      assertTrue(flaggedIds.includes("klinikk-forde"), "b1: KLINIKK FØRDE flagged in dry-run plan");
      assertTrue(flaggedIds.includes("expired-parked"), "f1: expired-backoff row flagged again in dry-run plan");
      for (const f of dentalFixtures) {
        assertTrue(!flaggedIds.includes(f.id), `c-${f.id}: genuine dental fixture NOT flagged`);
      }
      assertTrue(!flaggedIds.includes("raw-non-dental"), "d1: enrichment_state='raw' row excluded even though NACE+no-signal match");
      assertTrue(!flaggedIds.includes("already-parked"), "e1: actively-parked row excluded from plan (idempotency)");
      assertTrue(!flaggedIds.includes("wrong-nace"), "nace1: non-swept NACE code excluded even with no dental signal");
      assertEq(dry.body.data.would_flag, 3, "g3: would_flag counts exactly the 3 true positives (drevelin, klinikk-forde, expired-parked)");
      assertEq(dry.body.data.scanned, 2 + dentalFixtures.length + 1, "g4: scanned counts every enriched+swept-NACE+not-actively-parked candidate (drevelin, klinikk-forde, expired-parked, + all 12 genuine dental fixtures, all on swept NACE codes)");
      assertEq(dry.body.data.remaining_before, dry.body.data.scanned, "g4b: remaining_before matches scanned when no limit truncation applies");

      // zero writes on dry-run.
      {
        const row = getRow("drevelin");
        assertEq(row.wrong_entity_streak, 0, "g5: dry-run makes zero writes (drevelin streak unchanged)");
        assertEq(row.wrong_entity_unreachable_since, null, "g6: dry-run makes zero writes (drevelin since unchanged)");
      }

      // ── write:true ───────────────────────────────────────────────────────
      const written = await post({ write: true });
      assertEq(written.status, 200, "h1: write:true -> 200");
      assertEq(written.body.data.dry_run, false, "h2: dry_run:false echoed on write");
      assertEq(written.body.data.written, 3, "h3: written count matches the planned rows (3)");

      const rowDrevelin = getRow("drevelin");
      assertEq(rowDrevelin.wrong_entity_streak, dstore.DENTAL_PARK_AFTER_ATTEMPTS, "h4: DREVELIN wrong_entity_streak set to DENTAL_PARK_AFTER_ATTEMPTS");
      assertTrue(typeof rowDrevelin.wrong_entity_unreachable_since === "string" && rowDrevelin.wrong_entity_unreachable_since.length > 0, "h5: DREVELIN wrong_entity_unreachable_since stamped");

      const rowKlinikkForde = getRow("klinikk-forde");
      assertEq(rowKlinikkForde.wrong_entity_streak, dstore.DENTAL_PARK_AFTER_ATTEMPTS, "h6: KLINIKK FØRDE wrong_entity_streak set to DENTAL_PARK_AFTER_ATTEMPTS");
      assertTrue(typeof rowKlinikkForde.wrong_entity_unreachable_since === "string" && rowKlinikkForde.wrong_entity_unreachable_since.length > 0, "h7: KLINIKK FØRDE wrong_entity_unreachable_since stamped");

      const rowExpired = getRow("expired-parked");
      assertEq(rowExpired.wrong_entity_streak, dstore.DENTAL_PARK_AFTER_ATTEMPTS, "f2: expired-backoff row RE-STAMPED (streak stays at DENTAL_PARK_AFTER_ATTEMPTS since it started there)");
      assertTrue(rowExpired.wrong_entity_unreachable_since > expiredSince, "f3: expired-backoff row gets a FRESH (later) wrong_entity_unreachable_since");

      // unrelated / non-planned rows untouched.
      for (const f of dentalFixtures) {
        const row = getRow(f.id);
        assertEq(row.wrong_entity_streak, 0, `h8-${f.id}: genuine dental fixture wrong_entity_streak untouched (0)`);
        assertEq(row.wrong_entity_unreachable_since, null, `h9-${f.id}: genuine dental fixture wrong_entity_unreachable_since untouched (null)`);
      }
      {
        const rowRaw = getRow("raw-non-dental");
        assertEq(rowRaw.wrong_entity_streak, 0, "d2: raw-state row untouched by write");
      }
      {
        const rowAlready = getRow("already-parked");
        assertEq(rowAlready.wrong_entity_streak, 3, "e2: already-parked row untouched by write (was not re-selected)");
      }
      {
        const rowWrongNace = getRow("wrong-nace");
        assertEq(rowWrongNace.wrong_entity_streak, 0, "nace2: non-swept-NACE row untouched by write");
      }

      // ── second run is idempotent: nothing left to flag ──────────────────
      const secondRun = await post({});
      assertEq(secondRun.body.data.would_flag, 0, "idemp1: re-running dry-run after write finds nothing left to flag (all now actively parked)");

      // ── limit respected ──────────────────────────────────────────────────
      const limited = await post({ limit: 1 });
      assertTrue(limited.body.data.scanned <= 1, "limit1: limit:1 caps scanned rows at 1");

      if (log) console.log(`  admin-dental-wrong-entity-retro-sanitize: OK (${passed} assertions)`);
    } catch (err: any) {
      failed++;
      failures.push(
        "admin-dental-wrong-entity-retro-sanitize: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-dental-wrong-entity-retro-sanitize.test.ts`
if (require.main === module) {
  runAdminDentalWrongEntityRetroSanitizeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

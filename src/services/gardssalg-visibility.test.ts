/**
 * gardssalg-visibility.test.ts — dev-request 2026-10-22-opplevagent-mine-valg-
 * gardssalg, G1 point 5 («Synlighet per flate»).
 *
 * Proves that the single predicate in gardssalg-visibility.ts
 *   (a) gives EXACTLY the same answer as the old scattered predicates on a
 *       matrix of rows x surfaces (legacy SQL/JS reproduced literally below),
 *       both as SQL fragment and as row-level function, and through the
 *       real store entry points (list / count / map / search / by-slug /
 *       claim lookup / route corridor / searchGardssalgProviders per door);
 *   (b) is actually USED by every surface — mutation check: for each surface
 *       the rule table entry is weakened, the surface's real entry point is
 *       called, and the hidden/merged fixture row must then show up (and be
 *       gone again after restoring). Plus a source scan that the old inline
 *       fragments are gone from the three files that carried them and that
 *       every door passes its own surface.
 *
 * Same in-memory-DB + module-cache-swap pattern as
 * experience-store-gardssalg-sok.test.ts. Standalone:
 *   npx tsx src/services/gardssalg-visibility.test.ts
 */
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgVisibilityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const prevPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./route-corridor-service"),
      require.resolve("./gardssalg-visibility"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("./experience-store") as typeof import("./experience-store");
      const claim = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
      const corridor = require("./route-corridor-service") as typeof import("./route-corridor-service");
      const vis = require("./gardssalg-visibility") as typeof import("./gardssalg-visibility");
      const { GARDSSALG_SURFACES, GARDSSALG_SURFACE_RULES, gardssalgVisibleSql, isGardssalgVisibleOnSurface } = vis;

      // ── Legacy reference: the predicates exactly as they were scattered ──
      const LEGACY_GROUP = "(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')";
      const LEGACY_HIDDEN = "(catalog_hidden IS NULL OR catalog_hidden != 1)";
      // claim: lokal#1235 lets the owner's own pause (reason 'owner_pause') through.
      // O2a: and the test fixture (reason 'test_fixture' on is_test_provider = 1 only).
      const LEGACY_HIDDEN_CLAIM = "(catalog_hidden IS NULL OR catalog_hidden != 1 OR catalog_hidden_reason = 'owner_pause' OR (catalog_hidden_reason = 'test_fixture' AND is_test_provider = 1))";
      const LEGACY_MERGED = "(merged_into IS NULL OR merged_into = '')";
      const legacySql = (surface: string, includeHidden = false): string =>
        surface === "claim"
          ? `${LEGACY_HIDDEN_CLAIM} AND ${LEGACY_MERGED}` // getClaimProviderBySlug: no group clause
          : includeHidden
            ? `${LEGACY_GROUP} AND ${LEGACY_MERGED}` // searchGardssalgProviders include_hidden
            : `${LEGACY_GROUP} AND ${LEGACY_HIDDEN} AND ${LEGACY_MERGED}`;

      // ── Fixture matrix: producer_type x rfb_seed_source x catalog_hidden x merged_into ──
      const types: Array<string | null> = [null, "bryggeri", ""];
      const seeds: Array<string | null> = [null, "rfb-seed", "other"];
      const hiddens: Array<number | null> = [null, 0, 1];
      const mergeds: Array<string | null> = [null, "", "keep-1"];
      const insert = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, rfb_seed_source, catalog_hidden, merged_into,
            lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', 'Vestland', 'Bergen', 'Bergen', @pt, @seed, @hid, @mrg,
            60.39, 5.32, 'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      type M = { id: string; slug: string; pt: string | null; seed: string | null; hid: number | null; mrg: string | null };
      const matrix: M[] = [];
      let n = 0;
      for (const pt of types) for (const seed of seeds) for (const hid of hiddens) for (const mrg of mergeds) {
        n++;
        const m: M = { id: `vm-${n}`, slug: `vismatrix-${n}`, pt, seed, hid, mrg };
        matrix.push(m);
        insert.run({ id: m.id, navn: `Vismatrix Rad ${n}`, slug: m.slug, pt, seed, hid, mrg });
      }
      const allIds = matrix.map((m) => m.id);

      // (a1) SQL fragment == legacy SQL, per surface, on the DB.
      const idsWhere = (where: string): string[] =>
        (db.prepare(`SELECT id FROM experience_providers WHERE id LIKE 'vm-%' AND ${where} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
      for (const s of GARDSSALG_SURFACES) {
        assertEq(idsWhere(gardssalgVisibleSql(s)), idsWhere(legacySql(s)), `a1 sql[${s}] == legacy sql`);
        assertEq(gardssalgVisibleSql(s), legacySql(s), `a1 sql text[${s}] == legacy text`);
      }
      assertEq(idsWhere(gardssalgVisibleSql("rest", { includeHidden: true })), idsWhere(legacySql("rest", true)), "a1 includeHidden sql == legacy");
      assertEq(gardssalgVisibleSql("rest", { includeHidden: true }), legacySql("rest", true), "a1 includeHidden text == legacy");

      // (a1b) owner_pause (lokal#1235): hidden row stays reachable on `claim` only.
      {
        const paused = { producer_type: "bryggeri", catalog_hidden: 1, catalog_hidden_reason: "owner_pause", merged_into: null };
        const removed = { ...paused, catalog_hidden_reason: "remove_request" };
        for (const s of GARDSSALG_SURFACES) {
          assertEq(isGardssalgVisibleOnSurface(paused, s), s === "claim", `a1b owner_pause visible only on claim [${s}]`);
          assertEq(isGardssalgVisibleOnSurface(removed, s), false, `a1b other reason stays hidden [${s}]`);
        }
      }

      // (a2) row-level function == SQL result, every row x every surface.
      for (const s of GARDSSALG_SURFACES) {
        const viaSql = new Set(idsWhere(gardssalgVisibleSql(s)));
        const viaFn = matrix
          .filter((m) => isGardssalgVisibleOnSurface({ producer_type: m.pt, rfb_seed_source: m.seed, catalog_hidden: m.hid, merged_into: m.mrg }, s))
          .map((m) => m.id)
          .sort();
        assertEq(viaFn, [...viaSql].sort(), `a2 row fn[${s}] == sql on ${matrix.length} rows`);
      }
      assertEq(
        matrix.filter((m) => isGardssalgVisibleOnSurface({ producer_type: m.pt, rfb_seed_source: m.seed, catalog_hidden: m.hid, merged_into: m.mrg }, "rest", { includeHidden: true })).map((m) => m.id).sort(),
        idsWhere(legacySql("rest", true)).sort(),
        "a2 row fn includeHidden == legacy",
      );
      // All public surfaces share one rule; claim differs only by the group clause.
      for (const s of GARDSSALG_SURFACES) {
        const r = GARDSSALG_SURFACE_RULES[s];
        assertEq([r.requireGroup, r.hideCatalogHidden, r.hideMerged], [s !== "claim", true, true], `a3 rule table[${s}]`);
      }

      // (a4) real store entry points == legacy SQL result.
      const legacyPublic = new Set(idsWhere(legacySql("web")));
      const legacyClaim = new Set(idsWhere(legacySql("claim")));
      const ofMatrix = (ids: string[]): string[] => ids.filter((i) => i.startsWith("vm-")).sort();
      const expectPublic = [...legacyPublic].sort();
      assertEq(ofMatrix(store.listGardssalgProviders(5000, 0).map((r) => r.id)), expectPublic, "a4 listGardssalgProviders[web]");
      assertEq(ofMatrix(store.listGardssalgProviders(5000, 0, undefined, "sitemap").map((r) => r.id)), expectPublic, "a4 listGardssalgProviders[sitemap]");
      assertEq(store.countGardssalgProviders(), expectPublic.length, "a4 countGardssalgProviders[web]");
      assertEq(store.countGardssalgProviders(undefined, "mcp"), expectPublic.length, "a4 countGardssalgProviders[mcp]");
      assertEq(
        store.countGardssalgProvidersByType().reduce((a, r) => a + r.count, 0),
        expectPublic.length,
        "a4 countGardssalgProvidersByType total",
      );
      assertEq(ofMatrix(store.listGardssalgProviderMapPoints().map((r) => r.slug.replace("vismatrix-", "vm-"))), expectPublic, "a4 map points[map]");
      assertEq(
        ofMatrix(store.searchGardssalgProvidersByQuery("vismatrix", 100).map((r) => r.id)),
        expectPublic,
        "a4 searchGardssalgProvidersByQuery[search]",
      );
      for (const s of ["mcp", "a2a", "rest"] as const) {
        const got = ofMatrix(store.searchGardssalgProviders({ q: "vismatrix" }, 500, { surface: s }).map((r) => r.id));
        assertEq(got, expectPublic, `a4 searchGardssalgProviders[${s}]`);
      }
      assertEq(
        ofMatrix(store.searchGardssalgProviders({ q: "vismatrix", include_hidden: true }, 500).map((r) => r.id)),
        idsWhere(legacySql("rest", true)).sort(),
        "a4 searchGardssalgProviders include_hidden (admin) == legacy",
      );
      const bySlugVisible = matrix.filter((m) => store.getGardssalgProviderBySlug(m.slug) !== null).map((m) => m.id).sort();
      assertEq(bySlugVisible, expectPublic, "a4 getGardssalgProviderBySlug[web]");
      const claimVisible = matrix.filter((m) => claim.getClaimProviderBySlug(m.slug) !== null).map((m) => m.id).sort();
      assertEq(claimVisible, [...legacyClaim].sort(), "a4 getClaimProviderBySlug[claim] (no group clause)");
      const box = { minLat: 59, maxLat: 61, minLng: 4, maxLng: 6 };
      const corr = corridor.loadGardssalgCandidates(box, db).map((c) => c.id);
      assertEq(ofMatrix(corr), expectPublic, "a4 route corridor candidates[map]");

      // (b1) Mutation: weaken each surface's rule; its real entry point must change.
      // Probe rows: one hidden-but-otherwise-public, one merged-but-otherwise-public,
      // one non-group (claim only).
      const hiddenRow = matrix.find((m) => m.pt === "bryggeri" && m.seed === null && m.hid === 1 && m.mrg === null)!;
      const mergedRow = matrix.find((m) => m.pt === "bryggeri" && m.seed === null && m.hid === null && m.mrg === "keep-1")!;
      const nonGroupRow = matrix.find((m) => m.pt === null && m.seed === null && m.hid === null && m.mrg === null)!;
      const probes = [hiddenRow.id, mergedRow.id, nonGroupRow.id];
      const seen = (ids: string[]): string[] => probes.filter((p) => ids.includes(p));

      const entry: Record<string, () => string[]> = {
        web: () => [
          ...store.listGardssalgProviders(5000, 0).map((r) => r.id),
          ...matrix.filter((m) => store.getGardssalgProviderBySlug(m.slug)).map((m) => m.id),
        ],
        map: () => [
          ...store.listGardssalgProviderMapPoints().map((r) => r.slug.replace("vismatrix-", "vm-")),
          ...corridor.loadGardssalgCandidates(box, db).map((c) => c.id),
        ],
        search: () => store.searchGardssalgProvidersByQuery("vismatrix", 100).map((r) => r.id),
        sitemap: () => store.listGardssalgProviders(5000, 0, undefined, "sitemap").map((r) => r.id),
        mcp: () => store.searchGardssalgProviders({ q: "vismatrix" }, 500, { surface: "mcp" }).map((r) => r.id),
        a2a: () => store.searchGardssalgProviders({ q: "vismatrix" }, 500, { surface: "a2a" }).map((r) => r.id),
        rest: () => store.searchGardssalgProviders({ q: "vismatrix" }, 500, { surface: "rest" }).map((r) => r.id),
        claim: () => matrix.filter((m) => claim.getClaimProviderBySlug(m.slug)).map((m) => m.id),
      };
      for (const s of GARDSSALG_SURFACES) {
        const before = seen(entry[s]!());
        const rule = GARDSSALG_SURFACE_RULES[s];
        const saved = { ...rule };
        rule.requireGroup = false;
        rule.hideCatalogHidden = false;
        rule.hideMerged = false;
        let broken: string[] = [];
        try { broken = seen(entry[s]!()); } finally { Object.assign(rule, saved); }
        const after = seen(entry[s]!());
        assertEq(
          before.includes(hiddenRow.id) || before.includes(mergedRow.id),
          false,
          `b1 [${s}] baseline hides the hidden + merged probe rows`,
        );
        assertTrue(
          broken.includes(hiddenRow.id) && broken.includes(mergedRow.id) && broken.includes(nonGroupRow.id),
          `b1 [${s}] weakening ONLY this surface's rule changes its real entry point (mutation caught)`,
        );
        assertEq(after, before, `b1 [${s}] restored rule restores the original answer`);
      }
      // …and weakening one surface leaves another untouched (rules are per-surface).
      {
        const saved = { ...GARDSSALG_SURFACE_RULES.map };
        GARDSSALG_SURFACE_RULES.map.hideCatalogHidden = false;
        try {
          assertEq(seen(entry.web!()).includes(hiddenRow.id), false, "b2 breaking map does not affect web");
        } finally {
          Object.assign(GARDSSALG_SURFACE_RULES.map, saved);
        }
      }

      // (b3) Source scan: old inline fragments gone; every door names its surface.
      const root = path.resolve(__dirname, "..");
      const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
      const OLD_MERGED = "(merged_into IS NULL OR merged_into = '')";
      for (const rel of ["services/experience-store.ts", "services/route-corridor-service.ts", "services/gardssalg-claim.ts"]) {
        assertEq(read(rel).includes(OLD_MERGED), false, `b3 ${rel} carries no inline merged_into visibility fragment`);
      }
      assertTrue(read("services/gardssalg-claim.ts").includes('gardssalgVisibleSql("claim")'), "b3 claim lookup uses surface claim");
      assertTrue(read("services/route-corridor-service.ts").includes('gardssalgVisibleSql("map")'), "b3 corridor uses surface map");
      assertTrue(read("routes/experiences-seo.ts").includes('listGardssalgProviders(5000, 0, undefined, "sitemap")'), "b3 sitemap passes surface sitemap");
      assertTrue(read("routes/experiences-a2a.ts").includes('surface: "a2a"'), "b3 A2A passes surface a2a");
      const mcp = read("routes/experiences-mcp.ts");
      assertTrue(mcp.includes('surface: "mcp"') && mcp.includes('countGardssalgProviders(undefined, "mcp")'), "b3 MCP passes surface mcp (search + counts)");
      assertTrue(mcp.includes('resolveGardssalgProviderByQuery(pq, { surface: "mcp" })'), "b3 MCP book resolver passes surface mcp");
      const rest = read("routes/opplevelser.ts");
      assertTrue(rest.includes('searchGardssalgProviders(gsFilter, limit, { surface: "rest" })'), "b3 REST discover passes surface rest");
      const store_src = read("services/experience-store.ts");
      for (const s of ["web", "map", "search"]) {
        assertTrue(store_src.includes(`gardssalgVisibleSql("${s}")`), `b3 store uses surface ${s}`);
      }
    } finally {
      if (prevPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best effort */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgVisibilityTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}

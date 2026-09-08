/**
 * admin-dental-offentlig-klinikk-hjemmeside-korrigering.test.ts — tests for
 * dev-request 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning,
 * slice 2d: POST /admin/dental/offentlig-klinikk-hjemmeside-korrigering
 * (src/routes/admin-dental-offentlig-klinikk-hjemmeside-korrigering.ts).
 *
 * Setup mirrors admin-dental-hjemmeside-discovery.test.ts exactly (this
 * route calls that file's exported discoverDentalClinicWebsite, so it shares
 * the SAME injectable fetch/search seams and the SAME brreg-client
 * per-process contactCache hazard): fresh in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + db-factory __resetDbFactoryForTesting(), fresh
 * require of both route modules per run, exercised via router.handle()
 * directly (X-Admin-Key passed via headers), Brreg + page fetches stubbed
 * via __setDentalWdFetchForTesting / __setDentalWdSearchForTesting (both
 * exported from admin-dental-hjemmeside-discovery.ts, imported here rather
 * than re-implemented — there is exactly ONE fetch/search seam pair in this
 * codebase's dental-website-discovery code, shared by both route files).
 *
 * Registered in tests/test.ts's runSerial() chain, immediately after
 * admin-dental-hjemmeside-discovery.test.ts's own block — same reasoning as
 * that file's own registration comment: this suite exercises the identical
 * gardssalgWebsiteEvidenceMatch / gardssalgPageText / brreg-client
 * contactCache shared-per-process state, so it must never run concurrently
 * with another block touching the same state.
 *
 * Covers (per the byggspec's acceptance criteria):
 *   (a) admin gate: missing / wrong X-Admin-Key -> 403.
 *   AC1 (b): catalog_class='offentlig_klinikk' + a PUBLIC_DENTAL_SERVICE_
 *       HOSTS hjemmeside + org_nr resolving to a genuine, evidence-verified
 *       site -> apply writes directory_url = old fylkeskommune URL,
 *       hjemmeside = new verified URL, both provenance-stamped, attempted-at
 *       marker set, exactly one outcome (replaced_count=1) in the response.
 *   (b2) same shape but verified via the navnesøk (tier 2) fallback leg
 *       instead of the Brreg-field leg -> source_type is
 *       'search_verified_website' (regression proof the shared discovery
 *       step's tier-2 leg is reachable from this route too).
 *   AC2 (c): discovery finds nothing (mocked) -> apply touches ONLY the
 *       attempted-at marker; hjemmeside/directory_url/catalog_class
 *       unchanged, kept_no_candidate_count=1.
 *   AC3 (d): a row already carrying offentlig_klinikk_korrigering_
 *       attempted_at is excluded from the candidate set on a subsequent
 *       call — never scanned, never fetched, never re-written.
 *   AC4 (e): negative controls — catalog_class='klinikk' (not
 *       'offentlig_klinikk') with a PUBLIC_DENTAL_SERVICE_HOSTS hjemmeside,
 *       and an 'offentlig_klinikk' row whose hjemmeside is NOT a
 *       PUBLIC_DENTAL_SERVICE_HOSTS host — neither is ever touched, dry-run
 *       or apply.
 *   (f) dry-run reports would_replace / kept_no_candidate, makes ZERO
 *       writes (row state, including the attempted-at marker, is unchanged
 *       after a dry-run).
 *   (g) field_provenance is MERGED, not clobbered, on the replace path — a
 *       pre-existing unrelated field's provenance survives the write.
 *   (h) applyOffentligKlinikkKorrigeringToRow's own re-verify "skip stale
 *       row" branch, unit-tested directly (mirrors applyHjemmesideCleanup
 *       ToRow's own direct-unit-test convention in the sibling cleanup
 *       route's test file): a row whose hjemmeside/catalog_class/attempted-
 *       at marker changed since the scan is skipped, never clobbered.
 *   (i) OFFENTLIG_KLINIKK_KORRIGERING_BATCH_CAP is exported and is 25.
 *
 * AC5 (regression: hjemmeside-discovery-batch/-approve's own existing test
 * suite stays green, unchanged) is proven by admin-dental-hjemmeside-
 * discovery.test.ts itself staying green in the SAME `npm test` run — that
 * file's own assertions were not touched by the slice 2d extraction, only
 * the internal implementation the batch route calls into changed shape.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-dental-offentlig-klinikk-hjemmeside-korrigering.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminDentalOffentligKlinikkKorrigeringTests() and folds its
 *      pass/fail counts into the `npm test` summary.
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
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const path = opts.path || "/";
    const req: any = {
      method: opts.method || "POST",
      url: path,
      originalUrl: path,
      path,
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

function htmlResponse(html: string, opts: { finalUrl?: string } = {}): Response {
  return {
    ok: true,
    status: 200,
    url: opts.finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  } as unknown as Response;
}

export async function runAdminDentalOffentligKlinikkKorrigeringTests(
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

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "dental-okk-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;

  const dbFactoryPath = require.resolve("../database/db-factory");
  const discoveryRoutePath = require.resolve("./admin-dental-hjemmeside-discovery");
  const cleanupRoutePath = require.resolve("./admin-dental-hjemmeside-cleanup");
  const routePath = require.resolve("./admin-dental-offentlig-klinikk-hjemmeside-korrigering");
  const cachePaths = [dbFactoryPath, discoveryRoutePath, cleanupRoutePath, routePath];
  for (const p of cachePaths) delete require.cache[p];

  const brregFixtures: Map<string, Record<string, unknown>> = new Map();
  const pageFixtures: Map<string, Response> = new Map();
  const fetchCalls: string[] = [];

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      fetchCalls.push(u);
      const dm = /\/enheter\/(\d{9})$/.exec(u);
      if (dm) {
        const fx = brregFixtures.get(dm[1]);
        if (!fx) return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
        return { status: 200, ok: true, json: async () => fx } as unknown as Response;
      }
      const fx = pageFixtures.get(u);
      if (fx) return fx;
      throw new Error(`stubFetch: unexpected page fetch for ${u}`);
    }) as typeof fetch;
  }

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");

    const discoveryMod = require("./admin-dental-hjemmeside-discovery") as
      typeof import("./admin-dental-hjemmeside-discovery");
    discoveryMod.__setDentalWdFetchForTesting(stubFetch());

    const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
    brregClient.__clearBrregWebsiteCacheForTesting();

    const routeMod = require("./admin-dental-offentlig-klinikk-hjemmeside-korrigering") as
      typeof import("./admin-dental-offentlig-klinikk-hjemmeside-korrigering");
    const router = routeMod.default as any;

    const insertClinic = dentalDb.prepare(
      `INSERT INTO dental_agents
         (id, navn, org_nr, poststed, telefon, mobil, adresse, postnummer, hjemmeside, directory_url,
          catalog_class, is_inactive, field_provenance, offentlig_klinikk_korrigering_attempted_at, created_at)
       VALUES
         (@id, @navn, @org_nr, @poststed, @telefon, @mobil, @adresse, @postnummer, @hjemmeside, @directory_url,
          @catalog_class, @is_inactive, @field_provenance, @attempted_at, @created_at)`,
    );

    let seedSeq = 0;
    function seedClinic(o: {
      id: string;
      navn: string;
      org_nr?: string | null;
      poststed?: string | null;
      telefon?: string | null;
      mobil?: string | null;
      adresse?: string | null;
      postnummer?: string | null;
      hjemmeside?: string | null;
      directory_url?: string | null;
      catalog_class?: string | null;
      is_inactive?: number;
      field_provenance?: string | null;
      attempted_at?: string | null;
    }): void {
      seedSeq++;
      insertClinic.run({
        id: o.id,
        navn: o.navn,
        org_nr: o.org_nr ?? null,
        poststed: o.poststed ?? null,
        telefon: o.telefon ?? null,
        mobil: o.mobil ?? null,
        adresse: o.adresse ?? null,
        postnummer: o.postnummer ?? null,
        hjemmeside: o.hjemmeside ?? null,
        directory_url: o.directory_url ?? null,
        catalog_class: o.catalog_class ?? "offentlig_klinikk",
        is_inactive: o.is_inactive ?? 0,
        field_provenance: o.field_provenance ?? null,
        attempted_at: o.attempted_at ?? null,
        // Deterministic oldest-first ordering across the seeded rows.
        created_at: `2026-01-01T00:00:${String(seedSeq).padStart(2, "0")}.000Z`,
      });
    }

    function readClinic(id: string): any {
      return dentalDb.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id);
    }

    function post(path: string, body: any, key: string | false = testKey): Promise<RouteResult> {
      const headers: Record<string, string> = {};
      if (key !== false) headers["x-admin-key"] = key;
      return callRoute(router, { method: "POST", path, headers, body });
    }

    // ── (a) admin gate ────────────────────────────────────────────────────
    {
      const p1 = await post("/", {}, false);
      assertEq(p1.status, 403, "a1: no X-Admin-Key -> 403");
      const p2 = await post("/", {}, "wrong-key");
      assertEq(p2.status, 403, "a2: wrong X-Admin-Key -> 403");
    }

    // ── (i) batch cap constant ───────────────────────────────────────────
    assertEq(routeMod.OFFENTLIG_KLINIKK_KORRIGERING_BATCH_CAP, 25, "i1: batch cap is 25");

    // ── AC1 (b): Brreg-field leg finds + verifies a genuine site ─────────
    seedClinic({
      id: "okk-replace-a",
      navn: "Fjordkommune Tannklinikk",
      org_nr: "111111111",
      poststed: "Molde",
      hjemmeside: "https://mrfylke.no/tannhelse/fjordklinikk",
      field_provenance: JSON.stringify({ telefon: { source_type: "phone_directory", value: "12345678" } }),
    });
    brregFixtures.set("111111111", { hjemmeside: "https://fjordklinikk.no" });
    pageFixtures.set(
      "https://fjordklinikk.no",
      htmlResponse("<html><body>Fjordklinikk — org.nr 111 111 111</body></html>", { finalUrl: "https://fjordklinikk.no" }),
    );

    // ── AC2 (c): nothing verifies for this row ───────────────────────────
    seedClinic({
      id: "okk-nocand-b",
      navn: "Nordkyst Tannklinikk",
      org_nr: "222222222",
      poststed: "Kristiansund",
      hjemmeside: "https://tannhelserogaland.no/klinikk-b",
    });
    // Deliberately no brregFixtures entry for "222222222" -> no_brreg_website,
    // and no search seam wired yet at this point -> tier 2 never attempted.

    // ── AC3 (d): already attempted -> excluded from the candidate set ────
    seedClinic({
      id: "okk-already-attempted-c",
      navn: "Alt Forsøkt Tannklinikk",
      org_nr: "333333333",
      hjemmeside: "https://oslo.kommune.no/klinikk-c",
      attempted_at: "2026-01-01T00:00:00.000Z",
    });

    // ── AC4 (e1): catalog_class='klinikk' (not offentlig_klinikk), even
    // with a PUBLIC_DENTAL_SERVICE_HOSTS hjemmeside -> never a candidate.
    seedClinic({
      id: "okk-neg-klinikk-d",
      navn: "Almindelig Tannklinikk",
      org_nr: "444444444",
      hjemmeside: "https://afk.no/klinikk-d",
      catalog_class: "klinikk",
    });

    // ── AC4 (e2): offentlig_klinikk but hjemmeside is a REAL clinic site
    // (not a PUBLIC_DENTAL_SERVICE_HOSTS host) -> never a candidate.
    seedClinic({
      id: "okk-neg-realsite-e",
      navn: "Ekte Tannklinikk",
      org_nr: "555555555",
      hjemmeside: "https://ektetannklinikk.no",
      catalog_class: "offentlig_klinikk",
    });

    // ── dry-run over the whole seeded set ─────────────────────────────────
    const dry1 = await post("/", { dry_run: true });
    assertEq(dry1.status, 200, "dry1: 200");
    assertEq(dry1.body.scanned, 2, "dry1: scanned=2 (only okk-replace-a + okk-nocand-b are true candidates)");
    const wouldReplaceIds = new Set((dry1.body.would_replace as any[]).map((r) => r.id));
    const keptIds = new Set((dry1.body.kept_no_candidate as any[]).map((r) => r.id));
    assertTrue(wouldReplaceIds.has("okk-replace-a"), "dry2: okk-replace-a in would_replace");
    assertTrue(keptIds.has("okk-nocand-b"), "dry3: okk-nocand-b in kept_no_candidate");
    assertTrue(!wouldReplaceIds.has("okk-already-attempted-c") && !keptIds.has("okk-already-attempted-c"), "dry4 (AC3): already-attempted row absent from BOTH lists");
    assertTrue(!wouldReplaceIds.has("okk-neg-klinikk-d") && !keptIds.has("okk-neg-klinikk-d"), "dry5 (AC4a): catalog_class='klinikk' row absent, even with a public-service hjemmeside");
    assertTrue(!wouldReplaceIds.has("okk-neg-realsite-e") && !keptIds.has("okk-neg-realsite-e"), "dry6 (AC4b): non-public-host hjemmeside row absent");
    assertTrue(!fetchCalls.some((u) => u.includes("333333333")), "dry7 (AC3): already-attempted row's org_nr was NEVER looked up at Brreg");
    assertTrue(!fetchCalls.some((u) => u.includes("444444444")), "dry8 (AC4a): klinikk-class row's org_nr was never looked up");
    assertTrue(!fetchCalls.some((u) => u.includes("555555555")), "dry9 (AC4b): real-site row's org_nr was never looked up");

    // ── (f) dry-run makes ZERO writes ─────────────────────────────────────
    {
      const rowA = readClinic("okk-replace-a");
      assertEq(rowA.hjemmeside, "https://mrfylke.no/tannhelse/fjordklinikk", "f1: dry-run never changes hjemmeside");
      assertEq(rowA.directory_url, null, "f2: dry-run never sets directory_url");
      assertEq(rowA.offentlig_klinikk_korrigering_attempted_at, null, "f3: dry-run never stamps the attempted-at marker");
      const rowB = readClinic("okk-nocand-b");
      assertEq(rowB.offentlig_klinikk_korrigering_attempted_at, null, "f4: dry-run never stamps the marker on a no-candidate row either");
    }

    // ── apply over the same set ────────────────────────────────────────────
    const apply1 = await post("/", { dry_run: false });
    assertEq(apply1.status, 200, "apply1: 200");
    assertEq(apply1.body.replaced_count, 1, "AC1a: replaced_count=1 (exactly one outcome)");
    assertEq(apply1.body.kept_no_candidate_count, 1, "AC2a: kept_no_candidate_count=1");

    {
      const rowA = readClinic("okk-replace-a");
      assertEq(rowA.directory_url, "https://mrfylke.no/tannhelse/fjordklinikk", "AC1b: old fylkeskommune URL moved into directory_url");
      assertEq(rowA.hjemmeside, "https://fjordklinikk.no", "AC1c: new verified URL written into hjemmeside");
      assertTrue(!!rowA.offentlig_klinikk_korrigering_attempted_at, "AC1d: attempted-at marker set");
      const prov = JSON.parse(rowA.field_provenance);
      assertTrue(!!prov.directory_url, "AC1e: directory_url provenance entry present");
      assertTrue(!!prov.hjemmeside, "AC1f: hjemmeside provenance entry present");
      assertEq(prov.hjemmeside.source_type, "brreg_registered_website", "AC1g: hjemmeside provenance source_type is brreg_registered_website (tier 1)");
      assertEq(prov.hjemmeside.replaced_offentlig_klinikk_host, "https://mrfylke.no/tannhelse/fjordklinikk", "AC1h: provenance records what was replaced");
      // (g) pre-existing unrelated field_provenance entry survives the merge.
      assertTrue(!!prov.telefon, "g1: pre-existing 'telefon' provenance survives the merge");
      assertEq(prov.telefon.value, "12345678", "g2: pre-existing 'telefon' provenance value untouched");
    }
    {
      const rowB = readClinic("okk-nocand-b");
      assertEq(rowB.hjemmeside, "https://tannhelserogaland.no/klinikk-b", "AC2b: hjemmeside UNCHANGED (still the fylkeskommune URL)");
      assertEq(rowB.directory_url, null, "AC2c: directory_url UNCHANGED (still null)");
      assertEq(rowB.catalog_class, "offentlig_klinikk", "AC2d: catalog_class UNCHANGED");
      assertTrue(!!rowB.offentlig_klinikk_korrigering_attempted_at, "AC2e: ONLY the attempted-at marker was set");
      assertEq(rowB.field_provenance, null, "AC2f: field_provenance untouched (still null — no candidate was ever found)");
    }
    // AC4 negative controls: still completely untouched after apply too.
    {
      const rowD = readClinic("okk-neg-klinikk-d");
      assertEq(rowD.hjemmeside, "https://afk.no/klinikk-d", "AC4c: klinikk-class row's hjemmeside untouched by apply");
      assertEq(rowD.offentlig_klinikk_korrigering_attempted_at, null, "AC4d: klinikk-class row's marker never set");
      const rowE = readClinic("okk-neg-realsite-e");
      assertEq(rowE.hjemmeside, "https://ektetannklinikk.no", "AC4e: real-site row's hjemmeside untouched by apply");
      assertEq(rowE.offentlig_klinikk_korrigering_attempted_at, null, "AC4f: real-site row's marker never set");
    }

    // ── AC3, continued: a second call no longer scans okk-replace-a /
    // okk-nocand-b (both now carry the attempted-at marker from apply1) ───
    const dry2 = await post("/", { dry_run: true });
    assertEq(dry2.body.scanned, 0, "AC3g: a subsequent call scans 0 — every previously-attempted row is excluded");

    // ── (b2) navnesøk (tier 2) fallback leg reachable from this route ────
    {
      const searchCalls: string[] = [];
      discoveryMod.__setDentalWdSearchForTesting(async (query: string) => {
        searchCalls.push(query);
        return [{ title: "Havkyst Tannklinikk", url: "https://havkysttannklinikk.no", description: "Havkyst Tannklinikk i Ålesund" }];
      });

      seedClinic({
        id: "okk-search-f",
        navn: "Havkyst Tannklinikk",
        org_nr: "666666666",
        poststed: "Ålesund",
        hjemmeside: "https://tromsfylke.no/klinikk-f",
      });
      // No brregFixtures entry for "666666666" -> Brreg leg finds nothing,
      // tier 2 (navnesøk) is what verifies this row.
      pageFixtures.set(
        "https://havkysttannklinikk.no",
        htmlResponse("<html><body>Havkyst Tannklinikk — org.nr 666 666 666</body></html>", {
          finalUrl: "https://havkysttannklinikk.no",
        }),
      );

      const applyF = await post("/", { dry_run: false });
      assertEq(applyF.body.replaced_count, 1, "b2a: navnesøk-verified row -> replaced_count=1");
      const rowF = readClinic("okk-search-f");
      assertEq(rowF.hjemmeside, "https://havkysttannklinikk.no", "b2b: hjemmeside set to the navnesøk-discovered URL");
      assertEq(rowF.directory_url, "https://tromsfylke.no/klinikk-f", "b2c: old fylkeskommune URL moved to directory_url");
      const provF = JSON.parse(rowF.field_provenance);
      assertEq(provF.hjemmeside.source_type, "search_verified_website", "b2d: provenance source_type is search_verified_website (tier 2)");
      assertTrue(searchCalls.length >= 1, "b2e: the navnesøk search seam was actually invoked");

      discoveryMod.__setDentalWdSearchForTesting(null);
    }

    // ── (h) applyOffentligKlinikkKorrigeringToRow: stale-skip branch,
    // unit-tested directly (mirrors applyHjemmesideCleanupToRow's own
    // direct-unit-test convention) ─────────────────────────────────────────
    {
      seedClinic({
        id: "okk-stale-g",
        navn: "Stale Tannklinikk",
        org_nr: "777777777",
        hjemmeside: "https://ffk.no/klinikk-g",
      });
      const scanned = readClinic("okk-stale-g");
      // Row changes AFTER the scan snapshot was taken (e.g. a concurrent
      // hand-edit) — hjemmeside no longer matches what was scanned.
      dentalDb.prepare("UPDATE dental_agents SET hjemmeside = ? WHERE id = ?").run("https://someone-else-edited.no", "okk-stale-g");

      const outcomeFound: any = {
        found: true,
        candidate_url: "https://wouldbewrong.no",
        final_url: "https://wouldbewrong.no",
        confidence: 1.0,
        queue_reason: "brreg_field",
      };
      const result = routeMod.applyOffentligKlinikkKorrigeringToRow(
        dentalDb,
        { ...scanned, hjemmeside: scanned.hjemmeside } as any,
        outcomeFound,
        new Date().toISOString(),
      );
      assertEq(result.action, "skipped_stale", "h1: row changed since scan -> skipped_stale, never clobbered");
      const after = readClinic("okk-stale-g");
      assertEq(after.hjemmeside, "https://someone-else-edited.no", "h2: hjemmeside untouched by the skipped write");
      assertEq(after.offentlig_klinikk_korrigering_attempted_at, null, "h3: attempted-at marker NOT set on a skipped-stale row");
    }

    // ── mergeOffentligKlinikkKorrigeringProvenance: pure-function coverage ─
    {
      const merged = routeMod.mergeOffentligKlinikkKorrigeringProvenance(
        JSON.stringify({ adresse: { source_type: "brreg", value: "Sentrumsgata 1" } }),
        { moved_reason: "offentlig_klinikk_korrigering", previous_field: "hjemmeside", moved_at: "2026-09-08T00:00:00.000Z" },
        {
          source_type: "brreg_registered_website",
          value: "https://x.no",
          source_url: "https://x.no",
          replaced_offentlig_klinikk_host: "https://mrfylke.no/x",
          fetched_at: "2026-09-08T00:00:00.000Z",
        },
      );
      const parsed = JSON.parse(merged);
      assertTrue(!!parsed.adresse, "merge1: pre-existing 'adresse' entry survives");
      assertTrue(!!parsed.directory_url && !!parsed.hjemmeside, "merge2: both directory_url and hjemmeside entries are set");
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-dental-offentlig-klinikk-hjemmeside-korrigering: unexpected error: " + String(err?.stack || err?.message || err));
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
    try {
      const discoveryMod = require("./admin-dental-hjemmeside-discovery") as typeof import("./admin-dental-hjemmeside-discovery");
      discoveryMod.__setDentalWdFetchForTesting();
      discoveryMod.__setDentalWdSearchForTesting(null);
      discoveryMod.__setDentalWdRenderPageImplForTesting(null);
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-dental-offentlig-klinikk-hjemmeside-korrigering.test.ts`
if (require.main === module) {
  runAdminDentalOffentligKlinikkKorrigeringTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

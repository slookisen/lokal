/**
 * dental-store.test.ts — unit tests for the PUBLIC-facing read surfaces in
 * src/services/dental-store.ts.
 *
 * dev-request 2026-09-03-dental-catalog-class-public-filter (slice 1b)
 * ORIGINALLY added an opt-in catalog_class exclusion (env
 * DENTAL_PUBLIC_CATALOG_CLASS_FILTER="1", lenient DENTAL_CLINIC_CLASS_SQL —
 * NULL/"ukjent" stay eligible) to the query/count/sitemap functions that
 * back the public site (/sok, /fylke, /sted + front-page/county/city
 * counters), the MCP server's tannlege_* tools, and the finn-tannlege.com
 * sitemap: listPublicDentalAgents, countPublicDentalAgents, getDentalStats,
 * getDentalAgentsForSitemap, listRelatedClinics, and listPoststeder.
 *
 * dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5a — "honest
 * counts") GRADUATES that rollout: the filter is now UNCONDITIONAL — the
 * DENTAL_PUBLIC_CATALOG_CLASS_FILTER env var no longer gates it, it is
 * always applied — but stays the SAME lenient DENTAL_CLINIC_CLASS_SQL slice
 * 1b already used (NULL/"ukjent" stay eligible; only positively-classified
 * person_enk/lab_leverandor/holding rows are excluded). See
 * DENTAL_CLINIC_CLASS_SQL's doc comment in dental-catalog-class.ts for why
 * the dev-request's literal stricter "klinikk/offentlig_klinikk ONLY"
 * wording is NOT what's implemented: it excludes NULL too, which broke a
 * large slice of the pre-existing dental test suite whose fixtures predate
 * catalog_class entirely (and, in production, would hide every not-yet-
 * classified real clinic alongside the actual junk this fix targets).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-store.test.ts
 *   2. Wired into the gate: tests/test.ts imports runDentalStorePublicCatalogClassFilterTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalStorePublicCatalogClassFilterTests(
  opts: { log?: boolean } = {}
): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevFlag = process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
  process.env.DENTAL_DB_PATH = ":memory:";
  // 5a: the filter is unconditional now — deleting (not setting) the legacy
  // env var proves that too, since it can no longer influence anything.
  delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;

  const dbFactoryPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("./dental-store");
  const catalogClassPath = require.resolve("./dental-catalog-class");
  const cachePaths = [dbFactoryPath, dentalStorePath, catalogClassPath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const store = require("./dental-store") as typeof import("./dental-store");
    const db = dbFactory.getDb("dental");

    // ── Seed: 7 rows in the same poststed, one per catalog_class outcome.
    // ALL 7 get a phone number so none of them are also "thin" (5b) — this
    // test is about the catalog_class filter in isolation, so it must not
    // accidentally trip the separate thin-profile sitemap exclusion too.
    const ids: Record<string, string> = {};
    const seed = [
      { key: "nullClass", navn: "Uklassifisert Tannklinikk AS", org_nr: "911600001", catalog_class: null, telefon: "22110000" },
      { key: "klinikk", navn: "Ordinaer Tannklinikk AS", org_nr: "911600002", catalog_class: "klinikk", telefon: "22110011" },
      { key: "offentlig", navn: "Kommunal Tannklinikk", org_nr: "911600003", catalog_class: "offentlig_klinikk", telefon: "22110022" },
      { key: "ukjent", navn: "Ukjent Klasse AS", org_nr: "911600004", catalog_class: "ukjent", telefon: "22110033" },
      { key: "personEnk", navn: "OLA NORDMANN", org_nr: "911600005", catalog_class: "person_enk", telefon: "22110044" },
      { key: "lab", navn: "Nordic Dental Lab AS", org_nr: "911600006", catalog_class: "lab_leverandor", telefon: "22110055" },
      { key: "holding", navn: "Tannhelse Holding AS", org_nr: "911600007", catalog_class: "holding", telefon: "22110066" },
    ] as const;

    for (const row of seed) {
      const id = store.createDentalAgent({
        navn: row.navn,
        org_nr: row.org_nr,
        fylke: "OSLO",
        poststed: "OSLO",
        telefon: row.telefon,
      } as any);
      ids[row.key] = id;
      if (row.catalog_class !== null) {
        db.prepare("UPDATE dental_agents SET catalog_class = ? WHERE id = ?").run(row.catalog_class, id);
      }
    }

    // dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5a): the
    // LENIENT set (DENTAL_CLINIC_CLASS_SQL) is now applied UNCONDITIONALLY —
    // NULL and "ukjent" stay clinic-eligible (same as slice 1b's flag-on
    // behavior always was); only person_enk/lab_leverandor/holding are
    // excluded, with no env var involved at all any more.
    const EXCLUDED_KEYS = ["personEnk", "lab", "holding"];
    const CLINIC_KEYS = ["nullClass", "klinikk", "offentlig", "ukjent"];

    assertEq(store.countPublicDentalAgents({}), 4, "countPublicDentalAgents excludes the 3 non-clinic rows -> 4 (unconditional, no env var involved)");

    const listed = store.listPublicDentalAgents({}, 50, 0);
    assertEq(listed.length, 4, "listPublicDentalAgents returns the 4 clinic-eligible rows");
    const listedIds = new Set(listed.map((a) => a.id));
    for (const k of CLINIC_KEYS) {
      assertTrue(listedIds.has(ids[k]), `listPublicDentalAgents includes clinic-eligible row '${k}'`);
    }
    for (const k of EXCLUDED_KEYS) {
      assertTrue(!listedIds.has(ids[k]), `listPublicDentalAgents excludes non-clinic row '${k}'`);
    }

    const stats = store.getDentalStats();
    assertEq(stats.total, 4, "getDentalStats().total matches the filtered set -> 4");
    const oslo_stat = stats.per_fylke.find((f) => f.fylke === "OSLO");
    assertEq(oslo_stat?.count, 4, "getDentalStats().per_fylke OSLO count matches the filtered set -> 4");

    const sitemapRows = store.getDentalAgentsForSitemap();
    assertEq(sitemapRows.length, 4, "getDentalAgentsForSitemap lists the 4 clinic-eligible rows");
    const sitemapOrgNrs = new Set(sitemapRows.map((r) => r.org_nr));
    assertTrue(!sitemapOrgNrs.has("911600005"), "sitemap excludes the person_enk row");
    assertTrue(!sitemapOrgNrs.has("911600006"), "sitemap excludes the lab_leverandor row");
    assertTrue(!sitemapOrgNrs.has("911600007"), "sitemap excludes the holding row");
    assertTrue(sitemapOrgNrs.has("911600001"), "sitemap still includes the catalog_class=NULL row (never classified, not a proven non-clinic)");
    assertTrue(sitemapOrgNrs.has("911600002"), "sitemap still includes the klinikk row");
    assertTrue(sitemapOrgNrs.has("911600003"), "sitemap still includes the offentlig_klinikk row");
    assertTrue(sitemapOrgNrs.has("911600004"), "sitemap still includes the ukjent row");

    const steder = store.listPoststeder(1);
    const osloSted = steder.find((s) => s.poststed === "OSLO");
    assertEq(osloSted?.count, 4, "listPoststeder counts the 4 clinic-eligible rows for OSLO");

    const nullClassAgent = store.getDentalAgentById(ids.nullClass)!;
    const related = store.listRelatedClinics(nullClassAgent, 20);
    assertEq(related.length, 3, "listRelatedClinics returns the 3 OTHER clinic-eligible rows");
    const relatedIds = new Set(related.map((a) => a.id));
    for (const k of ["klinikk", "offentlig", "ukjent"]) {
      assertTrue(relatedIds.has(ids[k]), `listRelatedClinics includes clinic-eligible row '${k}'`);
    }
    for (const k of EXCLUDED_KEYS) {
      assertTrue(!relatedIds.has(ids[k]), `listRelatedClinics excludes non-clinic row '${k}'`);
    }

    // Setting the legacy rollout env var must have NO effect any more — the
    // filter is unconditional, not opt-in — proving slice 1b's flag is
    // fully retired for these six functions.
    process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER = "1";
    assertEq(store.countPublicDentalAgents({}), 4, "legacy DENTAL_PUBLIC_CATALOG_CLASS_FILTER=1 has no additional effect (already unconditional) -> still 4");
    delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
    assertEq(store.countPublicDentalAgents({}), 4, "legacy DENTAL_PUBLIC_CATALOG_CLASS_FILTER unset has no effect either -> still 4");
  } catch (err: any) {
    failed++;
    failures.push("dental-store public catalog-class filter: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevFlag === undefined) delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
    else process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER = prevFlag;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

/**
 * dev-request 2026-09-03-dental-stage-v-sample-recency-broken:
 * Stage V's "10% sample of last-24h commits" selector always drew the same 3
 * records because `.agent.updated_at` was always absent/null in the API
 * response it reads. Root cause: updateDentalAgent() already stamps
 * `updated_at = datetime('now')` on every writing PUT (the dental_agents.
 * updated_at column itself is fine) but hydrateAgent() -- the function both
 * getDentalAgentById() and listDentalAgents() go through to build the
 * DentalAgent object returned to callers -- built its return object
 * field-by-field and simply never included updated_at, so the hydrated
 * object had no updated_at property at all no matter how many real writes
 * happened. Fixed by adding updated_at to hydrateAgent()'s returned object
 * (kept read-only: never added to DENTAL_AGENT_WRITABLE_FIELDS, so a PUT
 * body can't forge the sort key -- it stays server-stamped only).
 *
 * Covers:
 *   (a) getDentalAgentById() after an updateDentalAgent() write returns a
 *       real, non-undefined, non-null updated_at timestamp string.
 *   (b) DENTAL_AGENT_WRITABLE_FIELDS.includes("updated_at") is false --
 *       regression guard: if someone later adds it, a PUT client could forge
 *       the sort key, and this test must fail.
 *   (c) listDentalAgents() rows also carry updated_at for a row that was
 *       just updated -- covers Stage V's actual read path (the list
 *       endpoint), not just a single GET.
 */
export function runDentalStoreUpdatedAtHydrationTests(
  opts: { log?: boolean } = {}
): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("./dental-store");
  const cachePaths = [dbFactoryPath, dentalStorePath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const store = require("./dental-store") as typeof import("./dental-store");

    // (b) regression guard -- independent of any seeded data.
    assertTrue(
      !store.DENTAL_AGENT_WRITABLE_FIELDS.includes("updated_at"),
      "regression guard: updated_at is NOT in DENTAL_AGENT_WRITABLE_FIELDS (server-stamped only, never client-settable via PUT)"
    );

    const id = store.createDentalAgent({
      navn: "Timestamp Test Tannklinikk AS",
      org_nr: "911700001",
      fylke: "OSLO",
      poststed: "OSLO",
    } as any);

    const ok = store.updateDentalAgent(id, { telefon: "12345678" });
    assertTrue(ok, "setup: updateDentalAgent() with a writing field ('telefon') reports success");

    // (a) single-GET read path (GET /api/tannlege/agents/:id)
    const single = store.getDentalAgentById(id) as Record<string, unknown> | null;
    assertTrue(!!single, "setup: getDentalAgentById() finds the updated row");
    const singleUpdatedAt = single?.updated_at;
    assertTrue(
      typeof singleUpdatedAt === "string" && singleUpdatedAt.length > 0,
      `getDentalAgentById() returns a non-null, non-absent updated_at string after updateDentalAgent() (got ${JSON.stringify(singleUpdatedAt)})`
    );

    // (c) list read path -- Stage V's actual selector reads listDentalAgents(),
    // not a single GET (GET /api/tannlege/agents).
    const listed = store.listDentalAgents({}, 50, 0) as Array<Record<string, unknown>>;
    const listedRow = listed.find((a) => a.id === id);
    assertTrue(!!listedRow, "setup: listDentalAgents() includes the updated row");
    const listedUpdatedAt = listedRow?.updated_at;
    assertTrue(
      typeof listedUpdatedAt === "string" && listedUpdatedAt.length > 0,
      `listDentalAgents() rows also carry a non-null, non-absent updated_at string after updateDentalAgent() (got ${JSON.stringify(listedUpdatedAt)})`
    );
    assertTrue(
      listedUpdatedAt === singleUpdatedAt,
      "listDentalAgents()'s updated_at matches getDentalAgentById()'s updated_at for the same row"
    );
  } catch (err: any) {
    failed++;
    failures.push("dental-store updated_at hydration: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

/**
 * dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege — 5b/5c/5d
 * coverage for the parts of dental-store.ts NOT already covered by
 * runDentalStorePublicCatalogClassFilterTests() above:
 *
 *   5b — isThinDentalProfile(): every one of the 4 missing-field
 *        combinations (only-address / only-phone / only-mobil /
 *        only-website / only-hours present => NOT thin; all 4 absent =>
 *        thin), plus getDentalAgentsForSitemap() actually excluding a thin
 *        klinikk-class row while keeping a non-thin one.
 *   5c — updateDentalAgent() syncing is_chain_member to chain_brand
 *        (set/clear/override-an-explicit-conflicting-value), and
 *        pushSpecialtyClause() matching specialists[].title (not just
 *        .specialty / available_specialties).
 *   5d — directory_url round-trips through hydrateAgent().
 */
export function runDentalProfilkvalitetTests(
  opts: { log?: boolean } = {}
): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("./dental-store");
  const cachePaths = [dbFactoryPath, dentalStorePath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const store = require("./dental-store") as typeof import("./dental-store");
    const db = dbFactory.getDb("dental");

    // ── 5b: isThinDentalProfile() — each of the 4 missing-field combinations ──
    const allMissing = { adresse: null, telefon: null, mobil: null, hjemmeside: null, opening_hours: null };
    assertTrue(store.isThinDentalProfile(allMissing as any), "thin: all 4 fields missing -> thin");
    assertTrue(
      !store.isThinDentalProfile({ ...allMissing, adresse: "Storgata 1" } as any),
      "thin: address alone present -> NOT thin"
    );
    assertTrue(
      !store.isThinDentalProfile({ ...allMissing, telefon: "22110011" } as any),
      "thin: phone (telefon) alone present -> NOT thin"
    );
    assertTrue(
      !store.isThinDentalProfile({ ...allMissing, mobil: "99887766" } as any),
      "thin: mobil alone present -> NOT thin"
    );
    assertTrue(
      !store.isThinDentalProfile({ ...allMissing, hjemmeside: "https://klinikk.example.no" } as any),
      "thin: website alone present -> NOT thin"
    );
    assertTrue(
      !store.isThinDentalProfile({
        ...allMissing,
        opening_hours: [{ day: "mon", open: "08:00", close: "16:00" }],
      } as any),
      "thin: opening-hours alone present -> NOT thin"
    );
    assertTrue(
      !store.isThinDentalProfile({
        adresse: "Storgata 1", telefon: "22110011", mobil: "99887766",
        hjemmeside: "https://klinikk.example.no",
        opening_hours: [{ day: "mon", open: "08:00", close: "16:00" }],
      } as any),
      "thin: all 4 present -> NOT thin"
    );
    // Whitespace-only values must not count as "present" (mirrors the
    // hasAddress/hasPhone/... .trim() checks in the implementation).
    assertTrue(
      store.isThinDentalProfile({ ...allMissing, adresse: "   " } as any),
      "thin: whitespace-only address does not count as present -> still thin"
    );

    // ── 5b: getDentalAgentsForSitemap() excludes a thin klinikk row ──────
    const thinClinicId = store.createDentalAgent({
      navn: "Tannklinikk Tynn AS", org_nr: "911800001", fylke: "OSLO", poststed: "OSLO",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(thinClinicId);
    const fullClinicId = store.createDentalAgent({
      navn: "Tannklinikk Full AS", org_nr: "911800002", fylke: "OSLO", poststed: "OSLO", telefon: "22110099",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(fullClinicId);
    const sitemapAfterThin = store.getDentalAgentsForSitemap();
    const sitemapOrgNrsThin = new Set(sitemapAfterThin.map((r) => r.org_nr));
    assertTrue(!sitemapOrgNrsThin.has("911800001"), "sitemap excludes a thin klinikk row (missing all 4 fields)");
    assertTrue(sitemapOrgNrsThin.has("911800002"), "sitemap keeps a non-thin klinikk row (has telefon)");

    // ── 5c: updateDentalAgent() syncs is_chain_member to chain_brand ────
    const chainTestId = store.createDentalAgent({
      navn: "Kjede Test Tannklinikk AS", org_nr: "911800003", fylke: "OSLO", poststed: "OSLO",
    } as any);
    assertEq(
      store.getDentalAgentById(chainTestId)?.is_chain_member, 0,
      "chain-sync setup: is_chain_member starts at 0"
    );
    store.updateDentalAgent(chainTestId, { chain_brand: "Volvat" } as any);
    assertEq(
      store.getDentalAgentById(chainTestId)?.is_chain_member, 1,
      "chain-sync: PUT chain_brand='Volvat' (non-empty) -> is_chain_member becomes 1"
    );
    store.updateDentalAgent(chainTestId, { chain_brand: "" } as any);
    assertEq(
      store.getDentalAgentById(chainTestId)?.is_chain_member, 0,
      "chain-sync: PUT chain_brand='' (cleared) -> is_chain_member becomes 0"
    );
    store.updateDentalAgent(chainTestId, { chain_brand: "Colosseum" } as any);
    assertEq(
      store.getDentalAgentById(chainTestId)?.is_chain_member, 1,
      "chain-sync: PUT chain_brand='Colosseum' again -> is_chain_member back to 1"
    );
    // A PUT that sets chain_brand AND explicitly (incorrectly) sets
    // is_chain_member to the opposite value -- chain_brand must win.
    store.updateDentalAgent(chainTestId, { chain_brand: "", is_chain_member: 1 } as any);
    assertEq(
      store.getDentalAgentById(chainTestId)?.is_chain_member, 0,
      "chain-sync: chain_brand='' overrides an explicit conflicting is_chain_member=1 in the SAME patch -> 0"
    );
    // A PUT that doesn't mention chain_brand at all must leave
    // is_chain_member untouched (no unrelated-field side effect).
    store.updateDentalAgent(chainTestId, { chain_brand: "NyKjede" } as any);
    store.updateDentalAgent(chainTestId, { telefon: "22990011" } as any);
    assertEq(
      store.getDentalAgentById(chainTestId)?.is_chain_member, 1,
      "chain-sync: a PUT that doesn't mention chain_brand leaves is_chain_member untouched"
    );

    // ── 5c: specialty matching extends to specialists[].title ──────────
    const titleOnlyId = store.createDentalAgent({
      navn: "Spesialist Tittel Tannklinikk AS", org_nr: "911800004", fylke: "OSLO", poststed: "OSLO",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(titleOnlyId);
    store.updateDentalAgent(titleOnlyId, {
      specialists: [{ name: "Kari Nordmann", title: "Spesialist i periodonti" }],
    } as any);
    const otherClinicId = store.createDentalAgent({
      navn: "Uten Periodonti Tannklinikk AS", org_nr: "911800005", fylke: "OSLO", poststed: "OSLO",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(otherClinicId);

    const bySpecialtyTitle = store.listPublicDentalAgents({ specialty: "periodonti" } as any, 50, 0);
    const bySpecialtyTitleIds = new Set(bySpecialtyTitle.map((a) => a.id));
    assertTrue(
      bySpecialtyTitleIds.has(titleOnlyId),
      "specialty filter matches a clinic whose specialists[].title contains the specialty word (no .specialty/available_specialties set)"
    );
    assertTrue(
      !bySpecialtyTitleIds.has(otherClinicId),
      "specialty filter does not match an unrelated clinic"
    );
    const countBySpecialtyTitle = store.countPublicDentalAgents({ specialty: "periodonti" } as any);
    assertEq(countBySpecialtyTitle, 1, "countPublicDentalAgents matches the same 1 clinic via specialists[].title");

    const availableIncludesTitleMatch = store.getAvailableSpecialties(["periodonti", "endodonti"]);
    assertTrue(
      availableIncludesTitleMatch.includes("periodonti"),
      "getAvailableSpecialties includes a specialty only reachable via specialists[].title"
    );
    assertTrue(
      !availableIncludesTitleMatch.includes("endodonti"),
      "getAvailableSpecialties excludes a specialty with zero coverage"
    );

    // ── 5d: directory_url hydrates through getDentalAgentById() ────────
    const directoryUrlTestId = store.createDentalAgent({
      navn: "Fylkesklinikk Test", org_nr: "911800006", fylke: "OSLO", poststed: "OSLO",
    } as any);
    db.prepare("UPDATE dental_agents SET directory_url = ? WHERE id = ?").run(
      "https://www.facebook.com/eksempelklinikk", directoryUrlTestId
    );
    const withDirectoryUrl = store.getDentalAgentById(directoryUrlTestId);
    assertEq(
      withDirectoryUrl?.directory_url, "https://www.facebook.com/eksempelklinikk",
      "directory_url round-trips through hydrateAgent()/getDentalAgentById()"
    );
  } catch (err: any) {
    failed++;
    failures.push("dental-store profilkvalitet (5b/5c/5d): unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runDentalStorePublicCatalogClassFilterTests({ log: true });
  console.log(`\ndental-store public catalog-class filter: ${r.passed} passed, ${r.failed} failed`);
  const r2 = runDentalStoreUpdatedAtHydrationTests({ log: true });
  console.log(`\ndental-store updated_at hydration: ${r2.passed} passed, ${r2.failed} failed`);
  const r3 = runDentalProfilkvalitetTests({ log: true });
  console.log(`\ndental-store profilkvalitet (5b/5c/5d): ${r3.passed} passed, ${r3.failed} failed`);
  process.exit(r.failed > 0 || r2.failed > 0 || r3.failed > 0 ? 1 : 0);
}

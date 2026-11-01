/**
 * dental-import-display.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S10 (Daniel's
 * choice B on question 32, 2026-10-19): no public surface shows a value that
 * only the directory import of May 2026 gave (dental-import-display.ts). By
 * prefix:
 *   T   the truth table of (a): no org.nr. and no Brreg field is (a); an
 *       organisasjonsform or a naeringskode alone, or an org.nr., is not;
 *       blanks count as empty; the switch off hides nothing;
 *   S   SQL↔JS parity: DENTAL_IMPORT_ONLY_ROW_SQL picks exactly the rows
 *       isImportOnlyRow() does, over every combination of NULL, empty,
 *       blank (every String.prototype.trim blank) and filled values of the
 *       three columns, on the stored and the hydrated row; the public list
 *       and count leave exactly those rows out;
 *   B   (b): a column in the map without a source is hidden; one a real
 *       source confirms (same value once normalised) is shown; a
 *       google_places or inference record, or another value, does not
 *       confirm; website_ownership 'verified' shows the website; an org.nr.
 *       outside the map, or the switch off, gives the same object; the
 *       provenance summary loses the hidden column's entries;
 *   D   the data file: sorted 9-digit org.nr., columns from {adresse,
 *       hjemmeside} only, no values, and its meta counts (1 388 clinics,
 *       1 386 addresses, 544 websites, 821 rows without an org.nr.) are the
 *       file's own; the loader reads every entry;
 *   F   the surfaces for (a): the profile 404s (/klinikk/id/:id) like a
 *       rejected row, tannlege_info «Klinikk ikke funnet.», tannlege_search,
 *       A2A search, /discover, /sok, /sted and a facet page do not list it,
 *       the raw REST list and /:id leave it out without the key (count
 *       follows; 404 {"error":"Not found"}) and are as stored with it; the
 *       area and facet counts, the honest count, getDentalStats,
 *       getDentalMarketplaceStats, getAvailableSpecialties, listPoststeder,
 *       listRelatedClinics, listDentalNamesakes and listChains leave it out;
 *       the admin list keeps it;
 *   G   the surfaces for (b): the profile, its JSON-LD, the cards, A2A and
 *       REST without the key have no import address or website, with the key
 *       they do, postnummer and poststed stay; the sitemap's thin check
 *       leaves out a clinic whose only content was the import address;
 *   K   the card key sets (search, detail, A2A) are the same with the switch
 *       on and off;
 *   O   the switch off: every surface lists and shows the rows as stored,
 *       and buildDentalWhere adds no clause;
 *   Q   the structure test: every query in dental-store.ts with
 *       verification_status != 'rejected' also has dentalPublicRowSql();
 *       a query without it is caught (negative control);
 *   N   no row is written.
 *
 * Standalone: npx tsx src/services/dental-import-display.test.ts
 * Wired into tests/test.ts via runDentalImportDisplayTests().
 */

import * as fs from "fs";
import * as path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[] }

interface RouteResult { status: number; text: string; body: any; headers: Record<string, string> }

function callRoute(router: any, routePath: string, query: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<RouteResult> {
  return new Promise((resolve) => {
    const id = routePath.startsWith("/agents/") ? routePath.slice("/agents/".length) : undefined;
    const req: any = { method: "GET", url: routePath, originalUrl: routePath, path: routePath, params: id ? { id } : {}, query, headers, ip: "127.0.0.1", get() { return undefined; } };
    const set: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      locals: {},
      status(c: number) { this.statusCode = c; return this; },
      setHeader(k: string, v: string) { set[k.toLowerCase()] = v; return this; },
      set(k: string, v: string) { set[k.toLowerCase()] = v; return this; },
      header(k: string, v: string) { set[k.toLowerCase()] = v; return this; },
      vary(v: string) { set.vary = set.vary ? `${set.vary}, ${v}` : v; return this; },
      once() { return this; },
      send(p: any) { resolve({ status: this.statusCode, text: String(p ?? ""), body: p, headers: set }); return this; },
      json(p: any) { resolve({ status: this.statusCode, text: JSON.stringify(p), body: p, headers: set }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled"), body: null, headers: set }));
  });
}

/** Every query in `source` (comment lines left out) with verification_status != 'rejected' and no dentalPublicRowSql() before the next one. */
export function queriesWithoutPublicRowClause(source: string): string[] {
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const marker = "verification_status != 'rejected'";
  const missing: string[] = [];
  let at = code.indexOf(marker);
  while (at !== -1) {
    const next = code.indexOf(marker, at + marker.length);
    const window = code.slice(at, Math.min(next === -1 ? code.length : next, at + 400));
    if (!window.includes("dentalPublicRowSql()")) missing.push(code.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, " "));
    at = next;
  }
  return missing;
}

export async function runDentalImportDisplayTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => {
    if (c) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  const sorted = (xs: string[]) => [...xs].sort();

  const prevDb = process.env.DENTAL_DB_PATH;
  const prevKey = process.env.ADMIN_KEY;
  const adminKey = "dental-import-display-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = adminKey;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
    require.resolve("./dental-catalog-class"),
    require.resolve("./dental-search-gazetteer"),
    require.resolve("./dental-area-facts"),
    require.resolve("./dental-clinic-card"),
    require.resolve("../routes/dental-seo"),
    require.resolve("../routes/dental-mcp"),
    require.resolve("../routes/dental-a2a"),
    require.resolve("../routes/dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const imp = require("./dental-import-display") as typeof import("./dental-import-display");
  // tests/test.ts runs the older suites with the switch off (their fixtures
  // have no org.nr.); this suite runs on the default and puts that back.
  const outerOverride = imp.__setImportValuesHiddenForTesting(null);
  const { analyticsService } = require("./analytics-service") as typeof import("./analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  (analyticsService as any).logWebSearch = () => {};
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("./dental-store") as typeof import("./dental-store");
    const display = require("./dental-places-display") as typeof import("./dental-places-display");
    const card = require("./dental-clinic-card") as typeof import("./dental-clinic-card");
    const areaFacts = require("./dental-area-facts") as typeof import("./dental-area-facts");
    const gazetteer = require("./dental-search-gazetteer") as typeof import("./dental-search-gazetteer");
    const resetCaches = () => {
      areaFacts.__resetDentalAreaFactsForTesting();
      gazetteer.__resetDentalSearchGazetteerForTesting();
    };
    resetCaches();

    eq(imp.IMPORT_VALUES_HIDDEN, true, "T0: the switch is on by default");

    // ── T: the truth table of (a) ─────────────────────────────────────────
    {
      const none = { org_nr: null, organisasjonsform: null, naeringskode: null };
      const cases: Array<[string, Record<string, unknown>, boolean]> = [
        ["no org.nr., no Brreg field", none, true],
        ["all three empty strings", { org_nr: "", organisasjonsform: "", naeringskode: "" }, true],
        ["all three blank (spaces, tab, no-break space)", { org_nr: "  ", organisasjonsform: "\t", naeringskode: " " }, true],
        ["columns missing on the object", {}, true],
        ["no org.nr., but organisasjonsform", { ...none, organisasjonsform: "AS" }, false],
        ["no org.nr., but naeringskode", { ...none, naeringskode: "86.230" }, false],
        ["with org.nr.", { ...none, org_nr: "918880001" }, false],
        ["with org.nr. and Brreg fields", { org_nr: "918880001", organisasjonsform: "AS", naeringskode: "86.230" }, false],
      ];
      for (const [label, row, expected] of cases) {
        eq(imp.isImportOnlyRow(row), expected, `T1 isImportOnlyRow: ${label}`);
        eq(imp.isHiddenImportRow(row), expected, `T2 isHiddenImportRow (switch on): ${label}`);
        eq(imp.isHiddenImportRow(row, false), false, `T3 switch off shows it: ${label}`);
      }
      ok(imp.dentalPublicRowSql() === imp.DENTAL_PUBLIC_ROW_SQL && imp.dentalPublicRowSql(false) === "1" &&
        imp.DENTAL_PUBLIC_ROW_SQL === `NOT ${imp.DENTAL_IMPORT_ONLY_ROW_SQL}`, "T4: the public clause follows the switch («1» while off)");
      imp.__setImportValuesHiddenForTesting(false);
      ok(imp.importValuesHidden() === false && imp.isHiddenImportRow(none) === false && imp.dentalPublicRowSql() === "1", "T5: the test override turns the switch off");
      imp.__setImportValuesHiddenForTesting(null);
      ok(imp.importValuesHidden() === true, "T5b: … and null restores it");
    }

    // ── S: SQL↔JS parity ──────────────────────────────────────────────────
    {
      const values: Array<string | null> = [null, "", " ", "\t\n", "\u00a0\u3000\ufeff", "\u2028", "918880001", " 918880001 ", "AS", "x\u200b"];
      // Every combination, in a table of the three columns (org_nr is UNIQUE
      // in dental_agents, so a repeated blank cannot be stored there).
      db.exec("CREATE TEMP TABLE import_parity (id TEXT, org_nr TEXT, organisasjonsform TEXT, naeringskode TEXT)");
      const insT = db.prepare("INSERT INTO import_parity VALUES (?,?,?,?)");
      const expectedT: string[] = [];
      let t = 0;
      for (const o of values) for (const f of values) for (const k of values) {
        const id = `p-${t++}`;
        insT.run(id, o, f, k);
        if (imp.isImportOnlyRow({ org_nr: o, organisasjonsform: f, naeringskode: k })) expectedT.push(id);
      }
      const sqlT = (db.prepare(`SELECT id FROM import_parity WHERE ${imp.DENTAL_IMPORT_ONLY_ROW_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
      ok(expectedT.length > 1 && expectedT.length < t, `S1: (the table has ${t} rows, ${expectedT.length} of them (a))`);
      eq(sorted(sqlT), sorted(expectedT), "S2: DENTAL_IMPORT_ONLY_ROW_SQL picks exactly the rows isImportOnlyRow() does (stored values)");
      eq((db.prepare(`SELECT COUNT(*) AS c FROM import_parity WHERE ${imp.DENTAL_PUBLIC_ROW_SQL}`).get() as { c: number }).c, t - expectedT.length,
        "S2b: DENTAL_PUBLIC_ROW_SQL is its exact complement (no NULL result)");
      db.exec("DROP TABLE import_parity");
      // In dental_agents: no org.nr. with every organisasjonsform and
      // naeringskode, and each org.nr. value once.
      const ins = db.prepare("INSERT INTO dental_agents (id, navn, poststed, fylke, org_nr, organisasjonsform, naeringskode, catalog_class) VALUES (?,?,?,?,?,?,?,?)");
      const expected: string[] = [];
      let n = 0;
      const rows: Array<[string | null, string | null, string | null]> = [];
      for (const f of values) for (const k of values) rows.push([null, f, k]);
      for (const o of values.slice(1)) rows.push([o, null, null]);
      for (const [o, f, k] of rows) {
        const id = `spar-${n++}`;
        ins.run(id, `Paritet ${n}`, "PARITETBY", "Oslo", o, f, k, "klinikk");
        if (imp.isImportOnlyRow({ org_nr: o, organisasjonsform: f, naeringskode: k })) expected.push(id);
      }
      const sqlIds = (db.prepare(`SELECT id FROM dental_agents WHERE id LIKE 'spar-%' AND ${imp.DENTAL_IMPORT_ONLY_ROW_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
      eq(sorted(sqlIds), sorted(expected), "S2c: … and in dental_agents");
      const hydrated = store.listDentalAgents({ poststed: "PARITETBY" }, 2000, 0);
      eq(sorted(hydrated.filter((r) => imp.isImportOnlyRow(r)).map((r) => r.id)), sorted(expected), "S3: … and isImportOnlyRow() on the hydrated rows");
      const pub = store.listPublicDentalAgents({ poststed: "PARITETBY" }, 500, 0).map((r) => r.id);
      ok(expected.length > 1 && pub.length === n - expected.length && pub.every((id) => !expected.includes(id)), "S4: the public list leaves out exactly those rows");
      eq(store.countPublicDentalAgents({ poststed: "PARITETBY" }), n - expected.length, "S5: … and so does the public count");
      db.prepare("DELETE FROM dental_agents WHERE id LIKE 'spar-%'").run();
    }

    // ── D: the data file ──────────────────────────────────────────────────
    const dataFile = path.join(__dirname, "..", "data", "dental-import-2026-05.json");
    const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const fields: Record<string, string[]> = data?.fields_by_org_nr ?? {};
    const orgNrs = Object.keys(fields);
    {
      ok(orgNrs.length > 0 && orgNrs.every((o) => /^\d{9}$/.test(o)), "D1: fields_by_org_nr is keyed by 9-digit org.nr.");
      eq(orgNrs, [...orgNrs].sort(), "D2: … sorted");
      ok(Object.values(fields).every((cols) => Array.isArray(cols) && cols.length > 0 && cols.every((c) => c === "adresse" || c === "hjemmeside") &&
        new Set(cols).size === cols.length && JSON.stringify(cols) === JSON.stringify([...cols].sort())),
        "D3: each entry is a sorted, non-empty list of columns from {adresse, hjemmeside}: no values");
      const meta = data?.meta?.fields_by_org_nr;
      const counts = meta?.counts ?? {};
      eq([counts.clinics_in_map, counts.adresse, counts.hjemmeside, counts.rows_without_orgnr], [1388, 1386, 544, 821], "D4: meta counts (1 388 clinics, 1 386 addresses, 544 websites, 821 rows without an org.nr.)");
      eq([orgNrs.length, Object.values(fields).filter((c) => c.includes("adresse")).length, Object.values(fields).filter((c) => c.includes("hjemmeside")).length],
        [counts.clinics_in_map, counts.adresse, counts.hjemmeside], "D5: … and they are the map's own");
      eq(counts.rows_without_orgnr, data?.directory_import?.entries_added_without_orgnr, "D6: the rows without an org.nr. are the merge report's");
      ok(Object.values(meta?.sha256 ?? {}).length >= 2 && Object.values(meta?.sha256 ?? {}).every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)),
        "D7: meta has the sha256 of the generator's inputs");
      eq(Object.keys(data ?? {}), ["meta", "enhetsregisteret_search", "directory_import", "fields_by_org_nr"], "D8: no other top-level key (no rows)");
      eq(imp.importFieldsMap().size, orgNrs.length, "D9: the loader reads every entry");
    }

    // Org.nr. from the map: one with both columns, one with the address only.
    const both = orgNrs.find((o) => fields[o]!.length === 2)!;
    const adrOnly = orgNrs.find((o) => fields[o]!.length === 1 && fields[o]![0] === "adresse")!;
    const adrOnly2 = orgNrs.filter((o) => fields[o]!.length === 1 && fields[o]![0] === "adresse")[1]!;

    // ── B: (b) on hand-built rows ─────────────────────────────────────────
    {
      const row = (over: Record<string, unknown>) => ({
        adresse: "Storgata 1", telefon: "22110099", opening_hours: null, hjemmeside: "https://www.eksempel-klinikk.no/",
        field_provenance: null, organisasjonsform: "AS", org_nr: both, website_ownership: null, ...over,
      }) as any;
      const shown = (over: Record<string, unknown>) => {
        const s = display.shownDentalAgent(row(over));
        return [s.adresse, s.hjemmeside];
      };
      eq(shown({}), [null, null], "B1: both columns in the map, no source: hidden");
      eq(shown({ field_provenance: { adresse: [{ source_type: "brreg", value: "STORGATA 1" }] } }), ["Storgata 1", null], "B2: an address a real source confirms (same once normalised) is shown");
      eq(shown({ field_provenance: { address: [{ source_type: "kartverket", value: "Storgata 1" }] } }), ["Storgata 1", null], "B2b: … under the key «address» too");
      eq(shown({ field_provenance: { hjemmeside: [{ source_type: "brreg", value: "http://eksempel-klinikk.no" }] } }), [null, "https://www.eksempel-klinikk.no/"], "B3: a website a real source confirms (same host) is shown");
      eq(shown({ field_provenance: { adresse: [{ source_type: "google_places", value: "Storgata 1" }], hjemmeside: [{ source_type: "google_places", value: "https://www.eksempel-klinikk.no/" }] } }), [null, null],
        "B4: a google_places record does not confirm");
      eq(shown({ field_provenance: { adresse: [{ source_type: "web_search", value: "Storgata 1" }], website: [{ source_type: "web_search", value: "https://www.eksempel-klinikk.no/" }] } }), [null, null],
        "B5: an inference record does not confirm");
      eq(shown({ field_provenance: { adresse: [{ source_type: "brreg", value: "Lillegata 9" }] } }), [null, null], "B6: a real source with another value does not confirm");
      eq(shown({ field_provenance: { telefon: [{ source_type: "brreg", value: "Storgata 1" }] } }), [null, null], "B6b: a record under another column does not confirm");
      eq(shown({ website_ownership: "verified" }), [null, "https://www.eksempel-klinikk.no/"], "B7: website_ownership 'verified' shows the website (not the address)");
      eq(shown({ website_ownership: "unverified" }), [null, null], "B7b: … another value does not");
      eq(shown({ org_nr: adrOnly }), [null, "https://www.eksempel-klinikk.no/"], "B8: only the columns in the map for the org.nr. are hidden");
      eq(shown({ org_nr: `${both.slice(0, 3)} ${both.slice(3, 6)} ${both.slice(6)}` }), [null, null], "B8b: an org.nr. stored with spaces is the same org.nr.");
      const outside = row({ org_nr: "918880001" });
      ok(display.shownDentalAgent(outside) === outside, "B9: an org.nr. outside the map: the same object (unchanged)");
      const noOrg = row({ org_nr: null });
      ok(display.shownDentalAgent(noOrg) === noOrg, "B9b: no org.nr.: (b) does not apply");
      const r = row({});
      ok(display.shownDentalAgent(r, false).adresse === null, "B10: (b) does not depend on the Places switch");
      imp.__setImportValuesHiddenForTesting(false);
      try {
        ok(display.shownDentalAgent(r) === r && JSON.stringify(display.shownDentalFieldProvenance(row({ field_provenance: { adresse: [{ source_type: "x", value: "y" }] } })))
          === JSON.stringify({ adresse: [{ source_type: "x", value: "y" }] }), "B11: the switch off: the same object, provenance as stored");
      } finally {
        imp.__setImportValuesHiddenForTesting(null);
      }
      const prov = { adresse: [{ source_type: "brreg", value: "Lillegata 9" }], telefon: [{ source_type: "brreg", value: "22110099" }] };
      eq(display.shownDentalFieldProvenance(row({ field_provenance: prov })), { telefon: prov.telefon }, "B12: the provenance summary loses the hidden column's entries");
      eq(display.shownDentalAgent(row({ adresse: "  ", hjemmeside: null })).adresse, "  ", "B13: a blank stored value has nothing to hide");
    }

    // ── The fixture: one place, (a) rows, (b) rows and ordinary clinics ───
    const helfoSrc = { helfo_agreement: [{ value: "true", source_type: "homepage", source_url: "https://example.no/helfo" }] };
    const ins = db.prepare(`INSERT INTO dental_agents (id, navn, org_nr, organisasjonsform, naeringskode, catalog_class, adresse, postnummer, poststed, fylke,
      telefon, hjemmeside, helfo_agreement, field_provenance, available_specialties, chain_brand, verification_status, updated_at)
      VALUES (@id, @navn, @org_nr, @organisasjonsform, @naeringskode, @catalog_class, @adresse, @postnummer, @poststed, @fylke,
      @telefon, @hjemmeside, @helfo_agreement, @field_provenance, @available_specialties, @chain_brand, @verification_status, @updated_at)`);
    const base = {
      org_nr: null, organisasjonsform: "AS", naeringskode: "86.230", catalog_class: "klinikk", adresse: "Torget 2", postnummer: "5003",
      poststed: "IMPORTBY", fylke: "Vestland", telefon: "55112233", hjemmeside: null, helfo_agreement: "true",
      field_provenance: JSON.stringify(helfoSrc), available_specialties: JSON.stringify(["Kjeveortopedi"]), chain_brand: "Fiktivkjeden",
      verification_status: "pending_verify", updated_at: "2026-10-01T10:00:00.000Z",
    };
    const add = (row: Record<string, unknown>) => { ins.run({ ...base, ...row }); return row.id as string; };
    const C1 = add({ id: "00000000-0000-4000-8000-0000000000c1", navn: "Fiktiv Tannklinikk En AS", org_nr: "918880001" });
    const C2 = add({ id: "00000000-0000-4000-8000-0000000000c2", navn: "Fiktiv Tannklinikk To AS", org_nr: "918880002" });
    const C3 = add({ id: "00000000-0000-4000-8000-0000000000c3", navn: "Fiktiv Tannklinikk Tre AS", org_nr: "918880003" });
    // (a): no org.nr., no Brreg field; offentlig_klinikk as rule 4 gives it.
    const A1 = add({ id: "00000000-0000-4000-8000-0000000000a1", navn: "Fiktiv Tannklinikk En AS", organisasjonsform: null, naeringskode: null, catalog_class: "offentlig_klinikk",
      adresse: "Importveien 1", telefon: "55000001", updated_at: "2026-10-30T10:00:00.000Z" });
    const A2 = add({ id: "00000000-0000-4000-8000-0000000000a2", navn: "Fiktiv Importrad To", organisasjonsform: " ", naeringskode: "", catalog_class: null, poststed: "BARE-IMPORT",
      adresse: "Importveien 2", available_specialties: JSON.stringify(["Endodonti"]) });
    // (b): org.nr. in the map; the address (and website) only the import gave.
    const B1 = add({ id: "00000000-0000-4000-8000-0000000000b1", navn: "Fiktiv Kartklinikk AS", org_nr: both, adresse: "Kartveien 3", hjemmeside: "https://www.fiktiv-kartklinikk.no/" });
    const B2 = add({ id: "00000000-0000-4000-8000-0000000000b2", navn: "Fiktiv Tynnklinikk AS", org_nr: adrOnly, adresse: "Tynnveien 4", telefon: null, helfo_agreement: "unknown", field_provenance: null, available_specialties: null });
    const B3 = add({ id: "00000000-0000-4000-8000-0000000000b3", navn: "Fiktiv Bekreftet Klinikk AS", org_nr: adrOnly2, adresse: "Kildeveien 5",
      field_provenance: JSON.stringify({ ...helfoSrc, adresse: [{ source_type: "brreg", value: "KILDEVEIEN 5" }] }) });
    const hiddenA = [A1, A2];
    const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM dental_agents ORDER BY id").all());
    const before = snapshot();
    resetCaches();

    const listIds = (filter: Record<string, unknown>) => store.listPublicDentalAgents(filter as any, 500, 0).map((r) => r.id);
    const seo = (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default as any;
    const rest = (require("../routes/dental") as typeof import("../routes/dental")).default as any;
    const a2a = require("../routes/dental-a2a") as typeof import("../routes/dental-a2a");
    const key = { "x-admin-key": adminKey };

    const mcp = require("../routes/dental-mcp") as typeof import("../routes/dental-mcp");
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-import-display-test", version: "0.0.0" });
    mcp.registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-import-display-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const callText = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as any;
      return { text: String(r.content[0].text), isError: !!r.isError };
    };

    const surfacesA = async (label: string, expectHidden: boolean) => {
      // The lists below are of IMPORTBY, where A1 is (A2 is in a place of its own).
      const want = (ids: string[]) => expectHidden ? !ids.includes(A1) : ids.includes(A1);
      const which = expectHidden ? "leaves out" : "lists";
      resetCaches();
      // Profile.
      for (const id of hiddenA) {
        const page = await callRoute(seo, `/klinikk/id/${id}`);
        const rejected = expectHidden ? 404 : 200;
        eq(page.status, rejected, `${label} profile /klinikk/id/${id}`);
        if (expectHidden) ok(page.text.includes("Klinikk ikke funnet") && !page.text.includes("Importveien"), `${label} … the not-found page, as for a rejected row, and no value`);
      }
      // tannlege_info by id.
      const info = await callText("tannlege_info", { id: A1 });
      ok(expectHidden ? info.text === "Klinikk ikke funnet." && info.isError : info.text.includes("Importveien 1"), `${label} tannlege_info {id}: ${expectHidden ? "«Klinikk ikke funnet.»" : "the card"}`);
      // tannlege_search.
      const search = JSON.parse((await callText("tannlege_search", { query: "tannlege Importby", limit: 25 })).text);
      // The search card has no id; a row without an org.nr. links /klinikk/id/<id>.
      ok((search.klinikker ?? []).length >= 6 && (JSON.stringify(search.klinikker).includes(A1) !== expectHidden), `${label} tannlege_search ${which} the (a) row of IMPORTBY`);
      // A2A search.
      const resp = a2a.handleDentalMessageSend({ message: { data: { poststed: "IMPORTBY" } } }, "f2s10") as any;
      const a2aIds = ((resp?.result?.artifacts?.[1]?.parts?.[0]?.data?.clinics ?? []) as any[]).map((c) => c.id);
      ok(a2aIds.length > 0 && (expectHidden ? !a2aIds.includes(A1) : a2aIds.includes(A1)), `${label} A2A search ${which} it`);
      // /discover.
      const disc = await callRoute(rest, "/discover", { poststed: "IMPORTBY", limit: "100" });
      ok(disc.status === 200 && (expectHidden ? !disc.body.results.some((r: any) => r.id === A1) : disc.body.results.some((r: any) => r.id === A1)) &&
        disc.body.total === disc.body.results.length, `${label} /discover ${which} it, total follows`);
      // /sok and /sted.
      const sok = await callRoute(seo, "/sok", { poststed: "IMPORTBY" });
      ok(sok.status === 200 && (expectHidden ? !sok.text.includes(`/klinikk/id/${A1}`) : sok.text.includes(`/klinikk/id/${A1}`)), `${label} /sok ${which} it`);
      const sted = await callRoute(seo, "/sted/importby");
      ok(sted.status === 200 && (expectHidden ? !sted.text.includes(`/klinikk/id/${A1}`) : sted.text.includes(`/klinikk/id/${A1}`)), `${label} /sted/importby ${which} it`);
      const facet = await callRoute(seo, "/sted/importby/kjeveortopedi");
      ok(facet.status === 200 && (expectHidden ? !facet.text.includes(`/klinikk/id/${A1}`) : facet.text.includes(`/klinikk/id/${A1}`)), `${label} the facet page /sted/importby/kjeveortopedi ${which} it (status ${facet.status})`);
      const bare = await callRoute(seo, "/sted/bare-import");
      eq(bare.status, expectHidden ? 404 : 200, `${label} /sted of a place with only (a) rows`);
      // Raw REST.
      const listNoKey = await callRoute(rest, "/agents", { poststed: "IMPORTBY", limit: "500" });
      const noKeyIds = listNoKey.body.agents.map((a: any) => a.id);
      ok(want(noKeyIds) && listNoKey.body.count === noKeyIds.length, `${label} GET /agents without the key ${which} it, count follows`);
      ok(listNoKey.headers["cache-control"] === "private" && /X-Admin-Key/.test(listNoKey.headers.vary ?? ""), `${label} … Cache-Control: private, Vary: X-Admin-Key`);
      const listKey = await callRoute(rest, "/agents", { poststed: "IMPORTBY", limit: "500" }, key);
      ok(listKey.body.agents.some((a: any) => a.id === A1 && a.adresse === "Importveien 1"), `${label} GET /agents with the key lists it as stored`);
      const oneNoKey = await callRoute(rest, `/agents/${A1}`);
      if (expectHidden) eq([oneNoKey.status, oneNoKey.body], [404, { error: "Not found" }], `${label} GET /agents/:id without the key: 404 {"error":"Not found"}`);
      else eq(oneNoKey.body?.agent?.adresse, "Importveien 1", `${label} GET /agents/:id without the key: as stored`);
      const oneKey = await callRoute(rest, `/agents/${A1}`, {}, key);
      eq([oneKey.status, oneKey.body?.agent?.id, oneKey.body?.agent?.navn], [200, A1, "Fiktiv Tannklinikk En AS"], `${label} GET /agents/:id with the key: as stored`);
      const wrongKey = await callRoute(rest, `/agents/${A1}`, {}, { "x-admin-key": "wrong" });
      eq(wrongKey.status, expectHidden ? 404 : 200, `${label} … a wrong key gets the public answer`);
      // Counts.
      const facts = areaFacts.getDentalAreaFacts();
      eq(facts.byPoststed.get("IMPORTBY")?.total, expectHidden ? 6 : 7, `${label} area facts: the IMPORTBY total`);
      eq(facts.byPoststed.get("IMPORTBY")?.facets?.["kjeveortopedi"]?.total, expectHidden ? 5 : 6, `${label} … and its kjeveortopedi facet`);
      eq(facts.byPoststed.has("BARE-IMPORT"), !expectHidden, `${label} … a place with only (a) rows has no facts`);
      const honest = store.countHonestDentalClinics();
      eq(honest, expectHidden ? 6 : 8, `${label} countHonestDentalClinics`);
      eq(store.getDentalStats().total, honest, `${label} getDentalStats().total is the honest count`);
      const ms = store.getDentalMarketplaceStats();
      eq([ms.activeProducers, ms.cities.includes("BARE-IMPORT"), ms.totalAgents], [expectHidden ? 6 : 8, !expectHidden, 8], `${label} getDentalMarketplaceStats (totalAgents stays the raw count)`);
      eq(store.getAvailableSpecialties(["Endodonti", "Kjeveortopedi"]), expectHidden ? ["Kjeveortopedi"] : ["Endodonti", "Kjeveortopedi"], `${label} getAvailableSpecialties`);
      eq(store.listPoststeder().map((p) => p.poststed).includes("BARE-IMPORT"), !expectHidden, `${label} listPoststeder`);
      eq(store.listPoststeder().find((p) => p.poststed === "IMPORTBY")?.count, expectHidden ? 6 : 7, `${label} … its IMPORTBY count`);
      const c1 = store.getDentalAgentById(C1)! as any;
      ok(want(store.listRelatedClinics(c1, 20).map((r) => r.id)), `${label} listRelatedClinics ${which} it`);
      eq(store.listDentalNamesakes(c1).map((r) => r.id), expectHidden ? [] : [A1], `${label} listDentalNamesakes`);
      eq(store.listChains().find((c) => c.chain_brand === "Fiktivkjeden")?.antall_lokasjoner_i_db, expectHidden ? 6 : 8, `${label} listChains`);
      ok(want(listIds({ poststed: "IMPORTBY" })), `${label} listPublicDentalAgents ${which} it`);
      ok(store.listDentalAgents({ poststed: "IMPORTBY" }, 500, 0).some((r) => r.id === A1) && store.countDentalAgents({ poststed: "IMPORTBY" }) === 7,
        `${label} the admin list and count keep it`);
    };

    // ── F: (a) on every surface ───────────────────────────────────────────
    await surfacesA("F", true);

    // ── G: (b) on every surface ───────────────────────────────────────────
    {
      const page = await callRoute(seo, `/klinikk/id/${B1}`);
      ok(page.status === 200 && !page.text.includes("Kartveien 3") && !page.text.includes("fiktiv-kartklinikk.no") && page.text.includes("5003"),
        "G1: the profile and its JSON-LD have no import address or website; postnummer stays");
      const confirmed = await callRoute(seo, `/klinikk/id/${B3}`);
      ok(confirmed.status === 200 && confirmed.text.includes("Kildeveien 5"), "G2: a confirmed address is on the profile");
      const b1 = store.getDentalAgentById(B1)! as any;
      const s = card.toDentalClinicCard(b1, "search") as any;
      const d = card.toDentalClinicCard(b1, "detail", { specialists: [] }) as any;
      const a = card.toDentalA2aClinic(b1) as any;
      eq([s.adresse ?? null, d.adresse, d.hjemmeside, a.adresse, a.hjemmeside, a.postnummer, a.poststed], [null, null, null, null, null, "5003", "IMPORTBY"],
        "G3: the search, detail and A2A cards have neither; postnummer and poststed stay");
      const restNoKey = await callRoute(rest, `/agents/${B1}`);
      eq([restNoKey.body.agent.adresse, restNoKey.body.agent.hjemmeside, restNoKey.body.agent.postnummer], [null, null, "5003"], "G4: REST /:id without the key: neither");
      const restKey = await callRoute(rest, `/agents/${B1}`, {}, key);
      eq([restKey.body.agent.adresse, restKey.body.agent.hjemmeside], ["Kartveien 3", "https://www.fiktiv-kartklinikk.no/"], "G5: … with the key, as stored");
      const listNoKey = await callRoute(rest, "/agents", { poststed: "IMPORTBY", limit: "500" });
      eq(listNoKey.body.agents.find((x: any) => x.id === B1)?.adresse, null, "G6: REST list without the key: no import address");
      const info = JSON.parse((await callText("tannlege_info", { org_nr: both })).text);
      eq([info.adresse, info.hjemmeside], [null, null], "G7: tannlege_info by org.nr.: neither");
      const sitemap = store.getDentalAgentsForSitemap().map((r) => r.org_nr);
      ok(!sitemap.includes(adrOnly) && sitemap.includes(both) && sitemap.includes(adrOnly2), "G8: the sitemap's thin check leaves out a clinic whose only content was the import address");
      const thin = await callRoute(seo, `/klinikk/id/${B2}`);
      ok(thin.status === 200 && /noindex/.test(thin.text) && !thin.text.includes("Tynnveien 4"), "G9: … and its profile is noindex, without the address");
    }

    // ── K: the card key sets ──────────────────────────────────────────────
    {
      const keys = (o: object) => Object.keys(o).join(",");
      const b1 = store.getDentalAgentById(B1)! as any;
      const on = [keys(card.toDentalClinicCard(b1, "search")), keys(card.toDentalClinicCard(b1, "detail", { specialists: [] })), keys(card.toDentalA2aClinic(b1))];
      imp.__setImportValuesHiddenForTesting(false);
      let off: string[];
      try {
        off = [keys(card.toDentalClinicCard(b1, "search")), keys(card.toDentalClinicCard(b1, "detail", { specialists: [] })), keys(card.toDentalA2aClinic(b1))];
      } finally {
        imp.__setImportValuesHiddenForTesting(null);
      }
      eq(on, off, "K1: the search, detail and A2A card key sets are the same with the switch on and off");
    }

    // ── O: the switch off ─────────────────────────────────────────────────
    imp.__setImportValuesHiddenForTesting(false);
    try {
      await surfacesA("O", false);
      const { where } = store.buildDentalWhere({}, { publicOnly: true });
      ok(!where.some((w) => w.includes(imp.DENTAL_IMPORT_ONLY_ROW_SQL)) && !where.includes("1"), "O1: buildDentalWhere adds no clause");
      const page = await callRoute(seo, `/klinikk/id/${B1}`);
      ok(page.text.includes("Kartveien 3") && page.text.includes("fiktiv-kartklinikk.no"), "O2: the profile shows the import address and website as stored");
      const restNoKey = await callRoute(rest, `/agents/${B1}`);
      eq([restNoKey.body.agent.adresse, restNoKey.body.agent.hjemmeside], ["Kartveien 3", "https://www.fiktiv-kartklinikk.no/"], "O3: REST without the key as stored");
      ok(store.getDentalAgentsForSitemap().map((r) => r.org_nr).includes(adrOnly), "O4: the sitemap lists the clinic again");
    } finally {
      imp.__setImportValuesHiddenForTesting(null);
    }

    // ── Q: the structure test ─────────────────────────────────────────────
    {
      const src = fs.readFileSync(path.join(__dirname, "dental-store.ts"), "utf8");
      const count = (src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n").match(/verification_status != 'rejected'/g) ?? []).length;
      ok(count >= 10, `Q1 control: dental-store.ts has ${count} public queries with verification_status != 'rejected'`);
      eq(queriesWithoutPublicRowClause(src), [], "Q2: every one of them also has dentalPublicRowSql()");
      const bad = "const sql = `SELECT 1 FROM dental_agents\n  WHERE verification_status != 'rejected'\n    AND (is_inactive IS NULL OR is_inactive = 0)`;\n" +
        "const ok = `SELECT 1 FROM dental_agents WHERE verification_status != 'rejected' AND ${dentalPublicRowSql()}`;";
      eq(queriesWithoutPublicRowClause(bad).length, 1, "Q3 control: a query without the clause is caught, the one with it is not");
    }

    eq(snapshot(), before, "N1: no row was written");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
    if (log) console.log(`  ✗ unexpected error: ${err?.stack || err}`);
  } finally {
    imp.__setImportValuesHiddenForTesting(outerOverride);
    if (closeMcp) await closeMcp().catch(() => {});
    (analyticsService as any).logWebSearch = realLogWebSearch;
    restoreModuleCache();
    if (prevDb === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDb;
    if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalImportDisplayTests({ log: true }).then((r) => {
    console.log(`\ndental-import-display (F2-S10): ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

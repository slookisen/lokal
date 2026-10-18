/**
 * dental-store-search.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S2).
 *
 * The four dental list/count functions now share buildDentalWhere(). Checked
 * against an in-memory fixture:
 *   R   regression: for every filter field that existed before, list ids/order
 *       and counts equal a verbatim copy of the old per-function WHERE code
 *       (LEGACY_* below; a public acute_vakt 1 is the akutt claim since S2b,
 *       see dental-acute-filter.test.ts); GET /api/tannlege/agents?limit=200 returns the same
 *       rows, in the same order, with the same JSON.
 *   N   name_terms (AND, LIKE-escaped), poststed_in, postnummer_in.
 *   F   fylke and poststed input normalisation (vestland/Hordaland, bergen).
 *   SP  specialty title stems (Kjeveortoped), oralkirurg vs kjevekirurg,
 *       getAvailableSpecialties uses the same predicate.
 *   U   natural (S3): explicit AND (parsed OR legacy), legacy matches listed
 *       first, an empty parsed branch matches every row, branch parameters
 *       never clash with the top-level ones; fylke_in.
 *   P   count/list parity for every field, public and admin; countDentalAgents
 *       now applies poststed.
 *   Z   schema bounds for the new fields.
 *   T   timing on a 10,000-row fixture: each query under 20 ms, or under 3x
 *       the old whole-text q scan on the same machine when that is slower
 *       (a loaded CI runner), so the check tracks the cost, not the runner.
 *
 * Standalone: npx tsx src/services/dental-store-search.test.ts
 * Wired into tests/test.ts via runDentalStoreSearchTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── The WHERE code as it was before S2 (dental-store.ts at a6edc5c) ────────
// Copied verbatim in behaviour, to prove the shared builder changed nothing
// for the old fields. Only the specialty clause is left out (S2 widens it on
// purpose; covered by SP below).
function legacyWhere(
  f: Record<string, any>,
  kind: "public" | "admin",
  sql: { clinicClass: string; notProbe: string }
): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = kind === "public"
    ? ["verification_status != 'rejected'", "(is_inactive IS NULL OR is_inactive = 0)", sql.clinicClass, sql.notProbe]
    : [sql.notProbe];
  const params: Record<string, unknown> = {};
  if (f.fylke) { where.push("fylke = @fylke"); params.fylke = f.fylke; }
  if (f.chain_brand) { where.push("chain_brand = @chain_brand"); params.chain_brand = f.chain_brand; }
  if (f.verification_status && (kind === "admin" || f.verification_status !== "rejected")) {
    where.push("verification_status = @verification_status");
    params.verification_status = f.verification_status;
  }
  if (f.q) { where.push("(nb_lower(navn) LIKE @q OR nb_lower(poststed) LIKE @q)"); params.q = `%${String(f.q).toLowerCase()}%`; }
  if (f.helfo_agreement !== undefined) { where.push("helfo_agreement = @helfo_agreement"); params.helfo_agreement = f.helfo_agreement; }
  if (f.acute_vakt !== undefined) { where.push("acute_vakt = @acute_vakt"); params.acute_vakt = f.acute_vakt; }
  if (f.enrichment_state !== undefined) { where.push("enrichment_state = @enrichment_state"); params.enrichment_state = f.enrichment_state; }
  if (f.poststed) { where.push("poststed = @poststed"); params.poststed = f.poststed; }
  return { where, params };
}
const LEGACY_PUBLIC_ORDER =
  " ORDER BY CASE verification_status WHEN 'verified' THEN 0 ELSE 1 END ASC," +
  " CASE enrichment_state WHEN 'enriched' THEN 0 ELSE 1 END ASC," +
  " CASE WHEN hjemmeside IS NOT NULL OR telefon IS NOT NULL THEN 0 ELSE 1 END ASC, navn ASC";

function callRoute(router: any, path: string, query: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query, headers: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: String(err ?? "unhandled") }));
  });
}

export async function runDentalStoreSearchTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
    require.resolve("./dental-catalog-class"),
    require.resolve("../routes/dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("./dental-store") as typeof import("./dental-store");
    const { DENTAL_CLINIC_CLASS_SQL } = require("./dental-catalog-class") as typeof import("./dental-catalog-class");
    const { DENTAL_NOT_SYNTHETIC_PROBE_SQL } = require("./dental-contamination") as typeof import("./dental-contamination");
    const legacySql = { clinicClass: DENTAL_CLINIC_CLASS_SQL, notProbe: DENTAL_NOT_SYNTHETIC_PROBE_SQL };

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent(row as any);
      const cols = Object.keys(extra);
      if (cols.length) db.prepare(`UPDATE dental_agents SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...extra, id });
      return id;
    };
    const soloIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      soloIds.push(add({ navn: `Sok Solo Tannlege ${i}`, poststed: "OSLO", fylke: "Oslo", postnummer: "0150", helfo_agreement: i % 2 === 0 ? "true" : "false" }));
    }
    const bergenUpper = add({ navn: "Bergen Sentrum Tann", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003", helfo_agreement: "true", telefon: "55000000" }, { verification_status: "verified" });
    const bergenMixed = add({ navn: "Bryggen Tann", poststed: "Bergen", fylke: "Vestland", postnummer: "5003" }, { enrichment_state: "enriched", acute_vakt: 1 });
    const kristiansand = add({ navn: "Sørlandet Tann", poststed: "Kristiansand", fylke: "Agder", postnummer: "4611" });
    const sandvika = add({ navn: "Sandvika Tannklinikk", poststed: "SANDVIKA", fylke: "Akershus", postnummer: "1337", chain_brand: "Kjede A" });
    const baerumBogus = add({ navn: "Stabekk Tann", poststed: "Baerum", fylke: "Akershus", postnummer: "1368" });
    const ukjent = add({ navn: "Ukjent Fylke Tann", poststed: "TEST STED", fylke: "Ukjent" });
    const osloUpperFylke = add({ navn: "Gammel Fylke Tann", poststed: "OSLO", fylke: "OSLO", postnummer: "0151" });
    const pct = add({ navn: "50%_x Klinikk", poststed: "OSLO", fylke: "Oslo" });
    const pctDecoy = add({ navn: "50abcx Klinikk", poststed: "OSLO", fylke: "Oslo" });
    const titleOnly = add({ navn: "Regulering Bergen", poststed: "BERGEN", fylke: "Vestland" }, { specialists: JSON.stringify([{ name: "Kari", title: "Kjeveortoped" }]) });
    const structured = add({ navn: "Kjeve Senter", poststed: "OSLO", fylke: "Oslo", available_specialties: ["kjeveortopedi"] });
    const oralTitle = add({ navn: "Kirurgi Klinikk", poststed: "OSLO", fylke: "Oslo" }, { specialists: JSON.stringify([{ name: "Per", title: "Oralkirurg og kjevekirurg" }]) });
    const kjevekirurg = add({ navn: "Kjevekirurg Klinikk", poststed: "OSLO", fylke: "Oslo" }, { specialists: JSON.stringify([{ name: "Ola", title: "Kjevekirurg" }]) });
    const rejected = add({ navn: "Avvist Bergen Tann", poststed: "BERGEN", fylke: "Vestland" }, { verification_status: "rejected" });
    const inactive = add({ navn: "Nedlagt Bergen Tann", poststed: "BERGEN", fylke: "Vestland" }, { is_inactive: 1 });
    const holding = add({ navn: "Bergen Tann Holding AS", poststed: "BERGEN", fylke: "Vestland" }, { catalog_class: "holding" });
    void kristiansand; void ukjent; void structured; void rejected; void inactive; void holding;

    const pubIds = (f: Record<string, unknown>) => store.listPublicDentalAgents(f as any, 500, 0).map((a) => a.id);
    const admIds = (f: Record<string, unknown>) => store.listDentalAgents(f as any, 500, 0).map((a) => a.id);
    const legacyIds = (f: Record<string, unknown>, kind: "public" | "admin") => {
      const { where, params } = legacyWhere(f, kind, legacySql);
      const order = kind === "public" ? LEGACY_PUBLIC_ORDER : " ORDER BY navn ASC";
      return (db.prepare(`SELECT id FROM dental_agents WHERE ${where.join(" AND ")}${order} LIMIT 500`).all(params) as Array<{ id: string }>).map((r) => r.id);
    };

    // ── R: old fields behave exactly as before ────────────────────────────
    // (a canonical fylke and an upper-case poststed; non-canonical input is
    // folded on purpose, see F below)
    const oldFilters: Array<Record<string, unknown>> = [
      {}, { fylke: "Oslo" }, { fylke: "Vestland" }, { fylke: "Ukjent" }, { chain_brand: "Kjede A" },
      { verification_status: "verified" }, { verification_status: "rejected" }, { q: "Solo Tannlege" }, { q: "bergen" },
      { q: "50%_x" }, { helfo_agreement: "true" }, { acute_vakt: 1 }, { enrichment_state: "enriched" },
      { poststed: "BERGEN" }, { poststed: "Kristiansand" }, { poststed: "SANDVIKA" },
      { fylke: "Vestland", helfo_agreement: "true", q: "tann" },
    ];
    for (const f of oldFilters) {
      const label = JSON.stringify(f);
      // S2b changed one old field on purpose: a public acute_vakt 1 is the
      // akutt claim (src/routes/dental-acute-filter.test.ts), and only the
      // admin listing (R3) keeps the raw flag.
      if (f.acute_vakt !== 1) {
        assertEq(pubIds(f), legacyIds(f, "public"), `R1: listPublicDentalAgents ${label} == old WHERE (ids and order)`);
        assertEq(store.countPublicDentalAgents(f as any), legacyIds(f, "public").length, `R2: countPublicDentalAgents ${label} == old count`);
      }
      assertEq(admIds(f), legacyIds(f, "admin"), `R3: listDentalAgents ${label} == old WHERE`);
    }
    assertEq(store.countPublicDentalAgents({ specialty: "implantologi" } as any), 0, "R4: a specialty outside the vocabulary keeps the old three clauses");
    {
      const route = (require("../routes/dental") as typeof import("../routes/dental")).default as any;
      const r = await callRoute(route, "/agents", { limit: "200" });
      const ids = legacyIds({}, "admin").slice(0, 200);
      assertEq(r.status, 200, "R5: GET /api/tannlege/agents?limit=200 -> 200");
      assertEq(Object.keys(r.body), ["count", "agents"], "R6: response shape {count, agents}");
      assertEq(r.body.agents.map((a: any) => a.id), ids, "R7: same rows in the same order as the old query");
      const { isDisplayablePhone } = require("./contact-normalizer") as typeof import("./contact-normalizer");
      // dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-
      // places-treffvakt, S4-A1b: the route leaves the stored Google rating
      // (rating, rating_count, rating_source) out, so the snapshot does too.
      // Same dev-request, A4-D: a public answer also leaves out
      // field_provenance (it holds the Places values) and Stage V's pending
      // map (a read-only side column of the hydrated row). No fixture value
      // comes from Places, so every other value is as stored.
      const snapshot = ids.map((id) => {
        const {
          rating: _rating,
          rating_count: _ratingCount,
          rating_source: _ratingSource,
          field_provenance: _provenance,
          stage_v_pending_correction: _pending,
          ...a
        } = store.getDentalAgentById(id)!;
        return { ...a, telefon: isDisplayablePhone(a.telefon) ? a.telefon : null, mobil: isDisplayablePhone(a.mobil) ? a.mobil : null };
      });
      assertEq(JSON.stringify(r.body), JSON.stringify({ count: snapshot.length, agents: snapshot }), "R8: response JSON equals the per-row snapshot, less the three Google rating keys, field_provenance and the pending map (A4-D)");
      const q = await callRoute(route, "/agents", { limit: "200", name_terms: "solo", postnummer_in: "0150" });
      assertEq(q.body.count, ids.length, "R9: the new fields are not read from GET /agents query params");
    }

    // ── N: new fields ─────────────────────────────────────────────────────
    assertEq(pubIds({ name_terms: ["solo", "tannlege"] }).sort(), pubIds({ q: "Solo Tannlege" }).sort(), "N1: name_terms [solo, tannlege] -> the same rows as q «Solo Tannlege»");
    assertEq(store.countPublicDentalAgents({ name_terms: ["solo", "tannlege"] }), 20, "N2: ... which are the 20 solo clinics");
    const reversed = add({ navn: "Tannlege Solo Vest", poststed: "OSLO", fylke: "Oslo" });
    assertTrue(pubIds({ name_terms: ["solo", "tannlege"] }).includes(reversed), "N3: name words are AND-ed in any order");
    assertTrue(!pubIds({ q: "Solo Tannlege" }).includes(reversed), "N4: (q stays one contiguous substring)");
    assertEq(pubIds({ name_terms: ["tann", "bergen"] }).sort(), [bergenUpper, bergenMixed].sort(), "N5: each word may match navn or poststed");
    assertEq(pubIds({ name_terms: ["50%_x"] }), [pct], "N6: %/_ in a name word are literal (escaped)");
    assertEq(pubIds({ q: "50%_x" }).sort(), [pct, pctDecoy].sort(), "N7: (q is not escaped — unchanged legacy behaviour)");
    assertEq(store.countPublicDentalAgents({ name_terms: ["back\\slash"] }), 0, "N8: a backslash in a name word is literal too");
    assertEq(pubIds({ poststed_in: ["BERGEN", "Bergen"] }).sort(), [bergenUpper, bergenMixed, titleOnly].sort(), "N9: poststed_in matches every stored spelling");
    assertEq(pubIds({ postnummer_in: ["1337", "1338", "1368"] }).sort(), [sandvika, baerumBogus].sort(), "N10: postnummer_in matches by postnummer");
    assertEq(pubIds({ postnummer_in: ["1337"], name_terms: ["sandvika"] }), [sandvika], "N11: new fields combine with AND");

    // ── F: fylke / poststed input ─────────────────────────────────────────
    const vest = pubIds({ fylke: "Vestland" }).sort();
    assertEq(pubIds({ fylke: "vestland" }).sort(), vest, "F1: fylke «vestland» == «Vestland»");
    assertEq(pubIds({ fylke: "Hordaland" }).sort(), vest, "F2: fylke «Hordaland» == «Vestland»");
    assertEq(pubIds({ fylke: "VESTLAND" }).sort(), vest, "F3: fylke «VESTLAND» == «Vestland»");
    assertTrue(pubIds({ fylke: "OSLO" }).includes(osloUpperFylke), "F4: a fylke stored verbatim still matches its raw value");
    assertEq(pubIds({ fylke: "OSLO" }).sort(), [...pubIds({ fylke: "Oslo" }), osloUpperFylke].sort(), "F4b: ... and the input is also folded to the canonical «Oslo»");
    assertEq(pubIds({ fylke: "Ukjent" }), [ukjent], "F5: a fylke with no canonical form matches as before");
    assertEq(pubIds({ poststed: "bergen" }).sort(), pubIds({ poststed: "BERGEN" }).sort(), "F6: poststed «bergen» == «BERGEN»");
    assertEq(pubIds({ poststed: "Kristiansand" }), [kristiansand], "F7: a mixed-case stored poststed still matches itself (/sted pages unchanged)");
    {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM dental_agents WHERE poststed IN ('BERGEN', 'bergen')`).all() as Array<{ detail: string }>;
      assertTrue(plan.some((p) => /idx_dental_poststed/.test(p.detail)), "F8: the poststed IN (...) form uses idx_dental_poststed");
      const fplan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM dental_agents WHERE fylke IN ('Vestland', 'vestland')`).all() as Array<{ detail: string }>;
      assertTrue(fplan.some((p) => /idx_dental_fylke/.test(p.detail)), "F9: the fylke IN (...) form uses idx_dental_fylke");
    }

    // ── SP: specialty ─────────────────────────────────────────────────────
    const kjeve = pubIds({ specialty: "kjeveortopedi" });
    assertTrue(kjeve.includes(titleOnly), "SP1: kjeveortopedi now matches the title «Kjeveortoped»");
    assertTrue(kjeve.includes(structured), "SP2: ... and still the structured available_specialties row");
    {
      const { where, params } = legacyWhere({}, "public", legacySql);
      const before = (db.prepare(
        `SELECT id FROM dental_agents WHERE ${where.join(" AND ")} AND (available_specialties LIKE @s OR specialists LIKE @p OR nb_lower(specialists) LIKE @t)`
      ).all({ ...params, s: '%"kjeveortopedi"%', p: '%"specialty":"kjeveortopedi"%', t: '%"title":"%kjeveortopedi%' }) as Array<{ id: string }>).map((r) => r.id);
      assertTrue(before.length > 0 && before.every((id) => kjeve.includes(id)) && kjeve.length > before.length, `SP3: every clinic the old three clauses found is still found, plus the title-only one (${before.length} -> ${kjeve.length})`);
    }
    assertTrue(pubIds({ specialty: "oral kirurgi og oral medisin" }).includes(oralTitle), "SP4: title «Oralkirurg og kjevekirurg» counts as oral kirurgi (stem oralkirurg)");
    assertTrue(!pubIds({ specialty: "oral kirurgi og oral medisin" }).includes(kjevekirurg), "SP5: a plain «Kjevekirurg» title does not");
    assertEq(store.getAvailableSpecialties(["kjeveortopedi", "periodonti", "oral kirurgi og oral medisin"]), ["kjeveortopedi", "oral kirurgi og oral medisin"], "SP6: the /sok dropdown uses the same predicate (stems included)");
    db.prepare("UPDATE dental_agents SET available_specialties = NULL WHERE id = ?").run(structured);
    assertEq(store.getAvailableSpecialties(["kjeveortopedi"]), ["kjeveortopedi"], "SP7: a title-only clinic is enough for the dropdown to offer it");
    {
      const titleClauses = (specialty: string) => store.buildDentalWhere({ specialty }).where.join(" ").split("nb_lower(specialists)").length - 1;
      assertEq(
        ["kjeveortopedi", "periodonti", "oral protetikk", "oral kirurgi og oral medisin", "implantologi"].map(titleClauses),
        [1, 1, 1, 2, 1],
        "SP8: a title word that contains a stem is left out (one nb_lower(specialists) per row; oral kirurgi needs both)"
      );
      const realPrepare = db.prepare;
      let prepared = 0;
      (db as any).prepare = function (this: any, sql: string) { prepared++; return realPrepare.call(this, sql); };
      try {
        const { DENTAL_SEARCH_VOCABULARY } = require("../config/dental-search-vocabulary") as typeof import("../config/dental-search-vocabulary");
        store.getAvailableSpecialties(DENTAL_SEARCH_VOCABULARY.specialties.map((sp) => sp.canonical));
      } finally {
        (db as any).prepare = realPrepare;
      }
      assertEq(prepared, 0, "SP9: the dropdown's statements (one per SQL shape) are prepared once per DB handle, not on every /sok request");
    }
    {
      // An explicit synonym or slug (MCP spesialitet) also matches the stored
      // name; the clauses for the raw value are kept, so it only widens.
      const canonical = pubIds({ specialty: "kjeveortopedi" }).sort();
      for (const v of ["kjeveortoped", "Orthodontist", "regulering"]) {
        assertEq(pubIds({ specialty: v }).sort(), canonical, `SP10: specialty «${v}» == kjeveortopedi`);
      }
      assertEq(pubIds({ specialty: "oral-kirurgi-og-oral-medisin" }), pubIds({ specialty: "oral kirurgi og oral medisin" }), "SP11: a slug == its stored name");
      const rawTitle = add({ navn: "Rå Tittel", poststed: "OSLO", fylke: "Oslo" }, { specialists: JSON.stringify([{ name: "Eva", title: "Spesialist i oral kirurgi" }]) });
      assertTrue(pubIds({ specialty: "oral kirurgi" }).includes(rawTitle) && pubIds({ specialty: "oral kirurgi" }).includes(oralTitle), "SP12: «oral kirurgi» (A2A's old value) keeps its own title match and adds the stored name's");
      db.prepare("DELETE FROM dental_agents WHERE id = ?").run(rawTitle);
    }

    // ── U: natural = explicit AND (parsed OR legacy) ──────────────────────
    const natural = (parsedF: Record<string, unknown>, q: string, extra: Record<string, unknown> = {}) =>
      ({ ...extra, natural: { parsed: parsedF, legacy: { q } } });
    {
      const f = natural({ poststed_in: ["SANDVIKA"] }, "Bergen Sentrum");
      const ids = pubIds(f);
      assertEq([...ids].sort(), [sandvika, bergenUpper].sort(), "U1: a row matches the parsed fields OR the whole-text q");
      assertEq(ids[0], bergenUpper, "U2: whole-text matches are listed first");
      assertEq(admIds(f)[0], bergenUpper, "U3: ... in the admin listing too");
      assertEq(store.countPublicDentalAgents(f as any), 2, "U4: count agrees");
    }
    {
      const f = natural({ poststed_in: ["OSLO"] }, "tann", { fylke: "Vestland" });
      assertEq(pubIds(f).sort(), pubIds({ fylke: "Vestland", q: "tann" }).sort(), "U5: explicit fields apply to both branches");
    }
    {
      const f = natural({}, "solo");
      const ids = pubIds(f);
      assertEq(ids.length, store.countPublicDentalAgents({}), "U6: an empty parsed branch matches every row");
      assertEq(ids.slice(0, 20).sort(), [...soloIds].sort(), "U7: ... with the whole-text matches (the 20 solo clinics) first");
    }
    {
      // The same fields at the top level and in both branches: no parameter clash.
      const f = {
        fylke: "Vestland", q: "regulering", specialty: "kjeveortopedi", name_terms: ["bergen"],
        natural: {
          parsed: { fylke: "Oslo", q: "kjeve", specialty: "kjeveortopedi", name_terms: ["senter"], poststed_in: ["OSLO"] },
          legacy: { q: "regulering bergen", specialty: "kjeveortopedi", name_terms: ["bergen"] },
        },
      };
      assertEq(pubIds(f), [titleOnly], "U8: top-level and branch fields with the same names are bound separately");
    }
    {
      const legacyFirst = (f: Record<string, unknown>) => {
        const q = ((f.natural as any).legacy.q as string).toLowerCase();
        const rows = store.listPublicDentalAgents(f as any, 500, 0);
        const flags = rows.map((a) => (a.navn.toLowerCase().includes(q) || String(a.poststed ?? "").toLowerCase().includes(q) ? 0 : 1));
        return flags.every((v, i) => i === 0 || flags[i - 1] <= v);
      };
      assertTrue(
        [natural({ fylke: "Oslo" }, "bergen"), natural({ name_terms: ["tann"] }, "50%_x"), natural({ poststed_in: ["BERGEN", "Bergen"] }, "kjeve")].every(legacyFirst),
        "U9: every whole-text match comes before every other row"
      );
    }
    assertTrue(store.listPublicDentalAgents({ fylke: "Oslo" } as any, 500, 0).length > 0 && store.buildDentalWhere({ fylke: "Oslo" }).orderFirst.length === 0, "U10: without natural the order is unchanged");
    {
      const throws = (f: Record<string, unknown>) => { try { store.countPublicDentalAgents(f as any); return false; } catch { return true; } };
      assertTrue(throws({ natural: { parsed: {}, legacy: {} } }), "U11: natural.legacy must set a field (an empty one would match every row)");
      assertTrue(throws({ natural: { parsed: { name_terms: ["x".repeat(101)] }, legacy: { q: "x" } } }), "U12: branch fields keep their bounds");
    }
    assertEq(pubIds({ fylke_in: ["Viken", "Akershus", "Buskerud", "Østfold"] }).sort(), [sandvika, baerumBogus].sort(), "U13: fylke_in matches any of the fylker");
    {
      // A2A's old keyword reading as the legacy branch: structured fields, no q.
      const f = { natural: { parsed: { poststed_in: ["SANDVIKA"] }, legacy: { fylke: "Vestland", helfo_agreement: "true" } } };
      const ids = pubIds(f);
      const old = pubIds({ fylke: "Vestland", helfo_agreement: "true" });
      assertEq([[...ids].sort(), ids.slice(0, old.length)], [[...old, sandvika].sort(), old], "U14: a legacy branch without q: its rows first, in their old order, then the parsed ones");
    }

    // ── P: count/list parity ──────────────────────────────────────────────
    const allFilters: Array<Record<string, unknown>> = [
      ...oldFilters,
      { name_terms: ["tann"] }, { poststed_in: ["BERGEN", "Bergen"] }, { postnummer_in: ["1337", "1368"] },
      { specialty: "kjeveortopedi" }, { fylke: "vestland", specialty: "kjeveortopedi", name_terms: ["regulering"] },
      { fylke_in: ["Akershus", "Oslo"] }, natural({ poststed_in: ["SANDVIKA"] }, "Bergen"), natural({}, "tann", { fylke: "Oslo" }),
    ];
    for (const f of allFilters) {
      const label = JSON.stringify(f);
      assertEq(store.countPublicDentalAgents(f as any), pubIds(f).length, `P1: public count == list length for ${label}`);
      assertEq(store.countDentalAgents(f as any), admIds(f).length, `P2: admin count == list length for ${label}`);
    }
    assertEq(store.countDentalAgents({ poststed: "BERGEN" }), 5, "P3: countDentalAgents applies poststed (it used to ignore it)");

    // ── Z: schema bounds ──────────────────────────────────────────────────
    const throws = (f: Record<string, unknown>) => { try { store.countPublicDentalAgents(f as any); return false; } catch { return true; } };
    assertTrue(throws({ name_terms: ["a", "b", "c", "d", "e", "f", "g"] }), "Z1: more than 6 name_terms is rejected");
    assertTrue(throws({ name_terms: [] }), "Z2: an empty name_terms list is rejected");
    assertTrue(throws({ postnummer_in: ["12a4"] }), "Z3: a postnummer that is not 4 digits is rejected");
    assertTrue(throws({ postnummer_in: Array.from({ length: 401 }, (_, i) => String(1000 + i)) }), "Z4: more than 400 postnumre is rejected");
    assertTrue(!throws({ postnummer_in: Array.from({ length: 400 }, (_, i) => String(1000 + i)) }), "Z5: 400 postnumre is accepted");
    assertTrue(throws({ poststed_in: [] }), "Z6: an empty poststed_in list is rejected");
    assertTrue(!throws({ name_terms: ["x'); DROP TABLE dental_agents; --"] }) && store.countDentalAgents({}) > 0, "Z7: name words are bound parameters");

    // ── T: timing on 10,000 rows ──────────────────────────────────────────
    dbFactory.__resetDbFactoryForTesting();
    const big = dbFactory.getDb("dental");
    const ins = big.prepare("INSERT INTO dental_agents (id, navn, poststed, postnummer, fylke, helfo_agreement, specialists) VALUES (?,?,?,?,?,?,?)");
    const steder = ["OSLO", "BERGEN", "Bergen", "TRONDHEIM", "STAVANGER", "TROMSØ", "SANDVIKA", "DRAMMEN"];
    const fylker = ["Oslo", "Vestland", "Vestland", "Trøndelag", "Rogaland", "Troms", "Akershus", "Buskerud"];
    big.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const k = i % steder.length;
        ins.run(`perf-${i}`, `Klinikk ${i} ${i % 7 === 0 ? "Solo Tannlege" : "Tannhelse"}`, steder[k], String(1000 + (i % 3000)), fylker[k],
          i % 2 ? "true" : "false", JSON.stringify([{ name: "Dr", title: i % 13 === 0 ? "Kjeveortoped" : "Tannlege" }]));
      }
    })();
    const timed = (fn: () => unknown) => {
      let best = Infinity;
      for (let r = 0; r < 7; r++) {
        const t = process.hrtime.bigint();
        fn();
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      return best;
    };
    // The old whole-text q (one full scan, two nb_lower calls per row) on the
    // same rows: the budget is 20 ms, or 3x this where the machine is slower.
    const baseline = timed(() => store.countPublicDentalAgents({ q: "solo tannlege" }));
    const budget = Math.max(20, 3 * baseline);
    if (log) console.log(`    baseline q: ${baseline.toFixed(1)} ms, budget ${budget.toFixed(1)} ms`);
    const perfFilters: Array<[string, Record<string, unknown>]> = [
      ["name_terms", { name_terms: ["solo", "tannlege"] }],
      ["poststed_in", { poststed_in: ["BERGEN", "Bergen"] }],
      ["postnummer_in (300)", { postnummer_in: Array.from({ length: 300 }, (_, i) => String(1300 + i)) }],
      ["fylke", { fylke: "vestland" }],
      ["specialty", { specialty: "kjeveortopedi" }],
      ["combined", { specialty: "kjeveortopedi", poststed_in: ["BERGEN", "Bergen"], name_terms: ["klinikk"], helfo_agreement: "true" }],
      ["natural", { natural: { parsed: { poststed_in: ["BERGEN", "Bergen"] }, legacy: { q: "tannlege i bergen" } } }],
      ["natural, nothing parsed", { natural: { parsed: {}, legacy: { q: "tannlege" } } }],
      // S3b: a poststed OR its kommune's postnumre (Bergen kommune has 144).
      ["poststed_or_postnummer (144)", { poststed_or_postnummer: { poststed_in: ["BERGEN", "Bergen"], postnummer_in: Array.from({ length: 144 }, (_, i) => String(1000 + i)) } }],
      ["natural, poststed_or_postnummer", { natural: { parsed: { poststed_or_postnummer: { poststed_in: ["BERGEN", "Bergen"], postnummer_in: Array.from({ length: 144 }, (_, i) => String(1000 + i)) } }, legacy: { q: "tannlege i bergen" } } }],
    ];
    assertEq(store.countPublicDentalAgents({}), 10_000, "T0: the timing fixture has 10,000 public rows");
    for (const [label, f] of perfFilters) {
      const c = timed(() => store.countPublicDentalAgents(f as any));
      const l = timed(() => store.listPublicDentalAgents(f as any, 50, 0));
      if (log) console.log(`    ${label}: count ${c.toFixed(1)} ms, list ${l.toFixed(1)} ms`);
      // Stable label (no measured numbers): the CI determinism gate compares failure texts across runs.
      assertTrue(c < budget && l < budget, `T1: ${label}: count and list each within budget (best of 7)`);
    }
  } catch (err: any) {
    failed++;
    failures.push("dental-store search: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalStoreSearchTests({ log: true }).then((r) => {
    console.log(`\ndental-store search: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

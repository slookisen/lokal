/**
 * dental-namesake-titler.test.ts -- dev-request 2026-10-17-dental-d3-rettelser,
 * skive D3e (klinikker med samme navn på samme poststed får ulike titler).
 *
 *   U  namesakeDisambiguator: no namesake -> null; the clinic's own real
 *      postnummer when no namesake has it ("0190 Oslo"); else the org.nr;
 *      else null. Placeholder 0000, empty and non-four-digit postnumre never
 *      tell a page apart.
 *   B  buildClinicDescription: the opening sentence names the place with the
 *      postnummer or ends with «Org.nr N.»; the short variant never cuts it;
 *      without a namesake the output is byte-identical to the 3-argument call.
 *   S  listDentalNamesakes: same place (any spelling passed in), another id,
 *      the name equal once trimmed and case-folded (Æ/Ø/Å too); never a
 *      rejected row or the synthetic probe; closed and non-clinic rows count;
 *      runs on idx_dental_poststed; LIMIT 20.
 *   T  the clinic page (/klinikk/<slug>): TRAN (two postnumre) -> «i 0190
 *      Oslo» / «i 0596 Oslo»; MEMA (one postnummer) -> «(org.nr N)»; one
 *      postnummer missing; names that differ only in case; two spellings of
 *      the place; all three title templates; title, og:title, twitter:title
 *      and meta differ, H1 and JSON-LD name stay the registered name, the
 *      JSON-LD (full) description and an om_oss meta are unchanged.
 *   N  negatives: another poststed, no namesake, a rejected or probe
 *      namesake -> title and meta byte-identical to before; no c/o or
 *      «Bruksenhetsnummer» in a title or meta.
 *   M  the sitemap: every clinic slug prefix shared by several org.nr has a
 *      different <title> per URL.
 *
 * Same harness as dental-sted-stavemater.test.ts (in-memory dental DB, the
 * router driven through router.handle(), req.query filled from the URL).
 *
 * Standalone: npx tsx src/routes/dental-namesake-titler.test.ts
 * Wired into tests/test.ts via runDentalNamesakeTitlerTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
}

function callRoute(router: any, url: string): Promise<RouteResult> {
  const parsed = new URL(url, "http://finn-tannlege.test");
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => { query[k] = v; });
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: parsed.pathname,
      params: {},
      query,
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      send(payload: any) {
        resolve({ status: this.statusCode, text: String(payload ?? "") });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, text: JSON.stringify(payload) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, text: String(err) });
      else resolve({ status: 404, text: "unhandled" });
    });
  });
}

const unescape = (s: string): string =>
  s.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const titleOf = (html: string): string | null => {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? unescape(m[1]!) : null;
};
const metaOf = (html: string, attr: string): string | null => {
  const m = html.match(new RegExp(`<meta ${attr} content="([^"]*)">`));
  return m ? unescape(m[1]!) : null;
};
const descriptionOf = (html: string): string | null => metaOf(html, 'name="description"');
const h1Of = (html: string): string | null => {
  const m = html.match(/<h1 class="profile-name">([^<]*)<\/h1>/);
  return m ? unescape(m[1]!) : null;
};
/** The Dentist JSON-LD node, or null (non-clinic pages have none). */
function dentistJsonLd(html: string): Record<string, any> | null {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const node = JSON.parse(m[1]!);
    if (node && node["@type"] === "Dentist") return node;
  }
  return null;
}

export async function runDentalNamesakeTitlerTests(
  opts: { log?: boolean } = {}
): Promise<TestSummary> {
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
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const { __resetDentalSearchGazetteerForTesting } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    const { DENTAL_SYNTHETIC_PROBE_IDS } = require("../services/dental-contamination") as typeof import("../services/dental-contamination");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    const { namesakeDisambiguator, buildClinicDescription } = dentalSeo;

    // ── U. namesakeDisambiguator (pure) ──────────────────────────────────
    {
      const oslo = { org_nr: "930159026", postnummer: "0190", poststed: "OSLO" };
      assertEq(namesakeDisambiguator(oslo, []), null, "U1: no namesake -> null");
      assertEq(namesakeDisambiguator(oslo, [{ postnummer: "0596" }]), { place: "0190 Oslo" }, "U2: own postnummer, no namesake has it -> place «0190 Oslo»");
      assertEq(namesakeDisambiguator(oslo, [{ postnummer: "0596" }, { postnummer: "0190" }]), { orgnr: "930159026" }, "U3: a namesake has the same postnummer -> org.nr");
      assertEq(namesakeDisambiguator(oslo, [{ postnummer: " 0190 " }]), { orgnr: "930159026" }, "U4: the namesake's postnummer is compared trimmed");
      for (const pnr of [null, undefined, "", "   ", "0000", " 0000 ", "190", "01900", "O190"]) {
        assertEq(namesakeDisambiguator({ ...oslo, postnummer: pnr as any }, [{ postnummer: "0596" }]), { orgnr: "930159026" }, `U5: own postnummer ${JSON.stringify(pnr)} is not a real one -> org.nr`);
      }
      assertEq(namesakeDisambiguator(oslo, [{ postnummer: "0000" }, { postnummer: null }]), { place: "0190 Oslo" }, "U6: a namesake's 0000 or missing postnummer collides with nothing");
      assertEq(namesakeDisambiguator({ ...oslo, poststed: "Ukjent" }, [{ postnummer: "0596" }]), { orgnr: "930159026" }, "U7: no valid poststed to name -> org.nr");
      assertEq(namesakeDisambiguator({ ...oslo, org_nr: null }, [{ postnummer: "0190" }]), null, "U8: neither a unique postnummer nor an org.nr -> null (page as before)");
      assertEq(namesakeDisambiguator({ ...oslo, org_nr: " 930159026 " }, [{ postnummer: "0190" }]), { orgnr: "930159026" }, "U9: the org.nr is trimmed");
      assertEq(namesakeDisambiguator({ org_nr: "1", postnummer: "8601", poststed: "MO I RANA" }, [{ postnummer: "8602" }]), { place: "8601 Mo i Rana" }, "U10: the place is title-cased like the rest of the page");
    }

    // ── B. buildClinicDescription with a namesake ────────────────────────
    {
      const agent: any = { navn: "TANNLEGE TRAN", poststed: "OSLO", fylke: "Oslo", postnummer: "0190", adresse: "Storgata 1", org_nr: "930159026", opening_hours: [] };
      assertEq(buildClinicDescription(agent, 9, true, { place: "0190 Oslo" }), "TANNLEGE TRAN er en tannlegeklinikk i 0190 Oslo. Det finnes 9 klinikker i Oslo.", "B1: place: «i 0190 Oslo» in the opening sentence; the count sentence is unchanged");
      const trd: any = { navn: "MEMA KJEVEORTOPEDI AS", poststed: "TRONDHEIM", fylke: "Trøndelag", postnummer: "7011", org_nr: "812849352" };
      assertEq(buildClinicDescription(trd, 0, true, { place: "7011 Trondheim" }), "MEMA KJEVEORTOPEDI AS er en tannlegeklinikk i 7011 Trondheim, Trøndelag.", "B2: place with a fylke: «i 7011 Trondheim, Trøndelag.»");
      assertEq(buildClinicDescription(trd, 0, true, { orgnr: "812849352" }), "MEMA KJEVEORTOPEDI AS er en tannlegeklinikk i Trondheim, Trøndelag. Org.nr 812849352.", "B3: org.nr: «Org.nr N.» right after the opening sentence");
      assertEq(buildClinicDescription({ ...trd, poststed: null, fylke: null }, 0, true, { orgnr: "812849352" }), "MEMA KJEVEORTOPEDI AS er en tannlegeklinikk. Org.nr 812849352.", "B4: org.nr without any locality");

      // Byte-identical without a namesake, for both variants and a spread of agents.
      const spread: any[] = [
        agent, trd,
        { navn: "Ukjent Sted AS", poststed: "Ukjent", fylke: "Ukjent" },
        { navn: "Bare Fylke AS", poststed: null, fylke: "Nordland" },
        { navn: "Rik Klinikk AS", poststed: "MO I RANA", fylke: "Nordland", adresse: "Gata 2", postnummer: "8601", helfo_agreement: "true", available_specialties: ["kjeveortopedi", "endodonti"], treatments: ["fyllinger", "rens"], opening_hours: [{ day: "mon", open: "08:00", close: "16:00" }], chain_brand: "Kjede" },
        { navn: "L".repeat(150) + " AS", poststed: "OSLO", fylke: "Oslo" },
      ];
      let same = 0;
      for (const a of spread) for (const short of [true, false]) for (const n of [0, 2, 978]) {
        const before = buildClinicDescription(a, n, short);
        if (buildClinicDescription(a, n, short, null) === before && buildClinicDescription(a, n, short, undefined) === before) same++;
      }
      assertEq(same, spread.length * 6, "B5: no namesake (null/undefined) -> byte-identical to the 3-argument call, short and full");

      // A long name: the cut must not drop or split «Org.nr N.».
      const longName = "TANNLEGENE I DEN GAMLE BYGARDEN VED ELVA OG TORGET " + "X".repeat(50) + " AS";
      const long: any = { navn: longName, poststed: "TRONDHEIM", fylke: "Trøndelag", helfo_agreement: "true", opening_hours: [{ day: "mon", open: "08:00", close: "16:00" }] };
      const withOrgnr = buildClinicDescription(long, 164, true, { orgnr: "812849352" });
      assertEq(withOrgnr, `${longName} er en tannlegeklinikk i Trondheim, Trøndelag. Org.nr 812849352.`, "B6: long name: the opening sentence and «Org.nr N.» are kept whole (regression: cut to «… Org.»)");
      const other = buildClinicDescription(long, 164, true, { orgnr: "937277148" });
      assertTrue(withOrgnr !== other, "B7: two long-named namesakes still get different metas");
      assertEq(buildClinicDescription(long, 164, true), buildClinicDescription(long, 164, true, null), "B8: the long name without a namesake is cut as before");
      const shortName: any = { ...trd, helfo_agreement: "true", available_specialties: ["kjeveortopedi"], opening_hours: [1, 2, 3, 4, 5].map(() => ({ day: "mon", open: "08:00", close: "16:00" })), chain_brand: "Kjeden Med Et Langt Navn" };
      const cut = buildClinicDescription(shortName, 164, true, { orgnr: "812849352" });
      assertTrue(cut.length <= 160 && cut.startsWith("MEMA KJEVEORTOPEDI AS er en tannlegeklinikk i Trondheim, Trøndelag. Org.nr 812849352."), `B9: an ordinary name keeps the 160 cap and the org.nr sentence (${cut.length}: ${cut})`);
    }

    // ── fixture ──────────────────────────────────────────────────────────
    let orgSeq = 918770000;
    type Extra = { klass?: string; rejected?: boolean; inactive?: boolean; id?: string; omOss?: string; orgnr?: string };
    type Made = { id: string; navn: string; org_nr: string; slug: string };
    const mk = (navn: string, poststed: string, fylke: string, postnummer: string | null, x: Extra = {}): Made => {
      const org_nr = x.orgnr ?? String(++orgSeq);
      const id = store.createDentalAgent({ ...(x.id ? { id: x.id } : {}), navn, org_nr, poststed, fylke, postnummer, adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare(
        "UPDATE dental_agents SET catalog_class = ?, is_inactive = ?, verification_status = ?, om_oss = ? WHERE id = ?"
      ).run(x.klass ?? "klinikk", x.inactive ? 1 : 0, x.rejected ? "rejected" : "unverified", x.omOss ?? null, id);
      return { id, navn, org_nr, slug: dentalSeo.slugifyClinic(navn, org_nr) };
    };
    // The live pairs (dev-request acceptance): TRAN with two postnumre, MEMA
    // and TRONDHEIM TANNLEGESENTER with one each.
    const tranA = mk("TANNLEGE TRAN", "OSLO", "Oslo", "0190", { orgnr: "930159026" });
    const tranB = mk("TANNLEGE TRAN", "OSLO", "Oslo", "0596", { orgnr: "933714942" });
    db.prepare("UPDATE dental_agents SET adresse = ? WHERE id = ?").run("c/o Tran Holding AS, Bruksenhetsnummer H0101, Storgata 1", tranA.id);
    const tranBergen = mk("TANNLEGE TRAN", "BERGEN", "Vestland", "5003");
    const memaA = mk("MEMA KJEVEORTOPEDI AS", "TRONDHEIM", "Trøndelag", "7011", { orgnr: "812849352" });
    const memaB = mk("MEMA KJEVEORTOPEDI AS", "TRONDHEIM", "Trøndelag", "7011", { orgnr: "937277148" });
    const tsA = mk("TRONDHEIM TANNLEGESENTER AS", "TRONDHEIM", "Trøndelag", "7030", { orgnr: "915426328" });
    const tsB = mk("TRONDHEIM TANNLEGESENTER AS", "TRONDHEIM", "Trøndelag", "7030", { orgnr: "918273107" });
    // One postnummer missing (the placeholder 0000).
    const hansenA = mk("TANNLEGE HANSEN AS", "STAVANGER", "Rogaland", "4006");
    const hansenB = mk("TANNLEGE HANSEN AS", "STAVANGER", "Rogaland", "0000");
    // Names that differ only in case (and Å, which SQLite's upper() leaves alone).
    const aasA = mk("Tannlegene på Ås", "ÅS", "Akershus", "1430");
    const aasB = mk("TANNLEGENE PÅ ÅS", "ÅS", "Akershus", "1431");
    // Two spellings of one place: both pages read «i Bergen».
    const vestUpper = mk("VEST TANN AS", "BERGEN", "Vestland", "5003");
    const vestLower = mk("VEST TANN AS", "Bergen", "Vestland", "5011");
    // The other two templates: sole proprietor and non-clinic (lab).
    const enkA = mk("KARI NORDMANN", "OSLO", "Oslo", "0150", { klass: "person_enk" });
    const enkB = mk("KARI NORDMANN", "OSLO", "Oslo", "0151", { klass: "person_enk" });
    const labA = mk("TANNTEKNIKK OSLO AS", "OSLO", "Oslo", "0160", { klass: "lab_leverandor" });
    const labB = mk("TANNTEKNIKK OSLO AS", "OSLO", "Oslo", "0160", { klass: "lab_leverandor" });
    // A namesake with its own om_oss text.
    const omA = mk("OM OSS TANN AS", "OSLO", "Oslo", "0170", { omOss: "Vi er en hyggelig klinikk midt i Oslo sentrum, med lang erfaring og moderne utstyr." });
    const omB = mk("OM OSS TANN AS", "OSLO", "Oslo", "0171");
    // Negatives: alone in its place, but with a rejected and a probe namesake.
    const solo = mk("SOLO TANN AS", "OSLO", "Oslo", "0180");
    const soloRejected = mk("SOLO TANN AS", "OSLO", "Oslo", "0181", { rejected: true });
    const probeId = [...DENTAL_SYNTHETIC_PROBE_IDS][0]!;
    mk("SOLO TANN AS", "OSLO", "Oslo", "0182", { id: probeId });
    // A closed namesake still counts (dev-request risk: an active clinic can
    // get a suffix because of a closed one).
    const nordA = mk("NORD TANN AS", "TROMSØ", "Troms", "9008");
    const nordClosed = mk("NORD TANN AS", "TROMSØ", "Troms", "9008", { inactive: true });
    __resetDentalSearchGazetteerForTesting();
    dentalSeo.__resetDentalSitemapCacheForTesting();

    const page = async (c: Made): Promise<RouteResult> => callRoute(router, `/klinikk/${c.slug}`);
    const agentOf = (c: Made) => store.getDentalAgentById(c.id)!;
    const stedCount = (c: Made): number => {
      const a = agentOf(c);
      const g = dentalSeo.findStedGroup(dentalSeo.slugifyText(a.poststed!));
      return g ? store.countPublicDentalAgents(dentalSeo.stedFilter(g)) : 0;
    };

    // ── S. listDentalNamesakes ───────────────────────────────────────────
    {
      const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id).sort();
      assertEq(store.listDentalNamesakes(agentOf(tranA)), [{ id: tranB.id, org_nr: "933714942", postnummer: "0596" }], "S1: TRAN in OSLO finds the other TRAN with its org.nr and postnummer, not itself and not Bergen's");
      assertEq(ids(store.listDentalNamesakes(agentOf(aasA))), [aasB.id], "S2: «Tannlegene på Ås» and «TANNLEGENE PÅ ÅS» are namesakes (Å folded too)");
      assertEq(ids(store.listDentalNamesakes({ id: "x", navn: "  tannlegene på ås ", poststed: "ÅS" })), [aasA.id, aasB.id].sort(), "S3: leading/trailing spaces and case are ignored");
      assertEq(store.listDentalNamesakes(agentOf(tranBergen)), [], "S4 (N1): the same name in another poststed is no namesake");
      assertEq(store.listDentalNamesakes(agentOf(solo)), [], "S5 (N3): a rejected row and the synthetic probe row are never namesakes");
      assertEq(ids(store.listDentalNamesakes({ ...agentOf(solo), id: soloRejected.id })), [solo.id], "S6: seen from the rejected row, only the public one");
      assertEq(ids(store.listDentalNamesakes(agentOf(nordA))), [nordClosed.id], "S7: a closed namesake counts (deliberately no is_inactive filter)");
      assertEq(ids(store.listDentalNamesakes(agentOf(labA))), [labB.id], "S8: non-clinic rows count (deliberately no catalog_class filter)");
      assertEq(store.listDentalNamesakes(agentOf(vestUpper)), [], "S9: without the other spellings, only the clinic's own poststed is searched");
      assertEq(ids(store.listDentalNamesakes(agentOf(vestUpper), ["BERGEN", "Bergen"])), [vestLower.id], "S10: with the place's spellings, «Bergen» is found from «BERGEN»");
      assertEq(store.listDentalNamesakes({ id: "x", navn: "TANNLEGE TRAN", poststed: null }), [], "S11: no poststed -> []");

      // The lookup runs on idx_dental_poststed: capture the statement the store prepares.
      const seen: string[] = [];
      const realPrepare = db.prepare;
      (db as any).prepare = function (sql: string) { seen.push(sql); return realPrepare.call(this, sql); };
      try { store.listDentalNamesakes(agentOf(tranA), ["OSLO", "Oslo"]); } finally { delete (db as any).prepare; }
      const sql = seen.find((s) => s.includes("nb_lower(trim(navn))"));
      const plan = sql ? (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("OSLO", "Oslo", tranA.id, "TANNLEGE TRAN") as Array<{ detail: string }>) : [];
      assertTrue(plan.some((p) => /idx_dental_poststed/.test(p.detail)), `S12: the namesake lookup uses idx_dental_poststed (${plan.map((p) => p.detail).join("; ")})`);

      const many = Array.from({ length: 23 }, () => mk("KOPI TANN AS", "MOLDE", "Møre og Romsdal", "6413"));
      assertEq(store.listDentalNamesakes(agentOf(many[0]!)).length, 20, "S13: at most 20 namesakes");
      db.prepare("DELETE FROM dental_agents WHERE navn = 'KOPI TANN AS'").run();
    }

    // ── T. the clinic page ───────────────────────────────────────────────
    const cOrC = /c\/o|bruksenhetsnummer/i;
    {
      const a = await page(tranA);
      const b = await page(tranB);
      assertEq([a.status, b.status], [200, 200], "T1a: both TRAN pages render");
      assertEq(titleOf(a.text), "TANNLEGE TRAN — Tannlegeklinikk i 0190 Oslo | Finn-tannlege.com", "T1b: TRAN 0190 is titled «… i 0190 Oslo»");
      assertEq(titleOf(b.text), "TANNLEGE TRAN — Tannlegeklinikk i 0596 Oslo | Finn-tannlege.com", "T1c: TRAN 0596 is titled «… i 0596 Oslo»");
      assertTrue(descriptionOf(a.text) !== descriptionOf(b.text), "T1d: the two meta descriptions differ");
      assertEq(descriptionOf(a.text), `TANNLEGE TRAN er en tannlegeklinikk i 0190 Oslo. Det finnes ${stedCount(tranA)} klinikker i Oslo.`, "T1e: the meta names the place with the postnummer; the count sentence is unchanged");
      for (const [name, r] of [["0190", a], ["0596", b]] as const) {
        assertEq([metaOf(r.text, 'property="og:title"'), metaOf(r.text, 'name="twitter:title"')], [titleOf(r.text), titleOf(r.text)], `T1f: TRAN ${name}: og:title and twitter:title carry the same title`);
        assertEq([h1Of(r.text), dentistJsonLd(r.text)?.name], ["TANNLEGE TRAN", "TANNLEGE TRAN"], `T1g: TRAN ${name}: H1 and JSON-LD name are the registered name`);
        assertTrue(!cOrC.test(titleOf(r.text) ?? "") && !cOrC.test(descriptionOf(r.text) ?? ""), `N4: TRAN ${name}: no c/o or Bruksenhetsnummer in title or meta`);
      }
      assertTrue(!/tannlegeklinikk i 0190|Org\.nr/.test(dentistJsonLd(a.text)?.description ?? "x"), "T1h: the JSON-LD (full) description is unchanged");

      const memaPages = [await page(memaA), await page(memaB)];
      assertEq(memaPages.map((p) => titleOf(p.text)), [
        "MEMA KJEVEORTOPEDI AS — Tannlegeklinikk i Trondheim (org.nr 812849352) | Finn-tannlege.com",
        "MEMA KJEVEORTOPEDI AS — Tannlegeklinikk i Trondheim (org.nr 937277148) | Finn-tannlege.com",
      ], "T2a: MEMA, same postnummer -> the org.nr in the title");
      assertTrue((descriptionOf(memaPages[0]!.text) ?? "").startsWith("MEMA KJEVEORTOPEDI AS er en tannlegeklinikk i Trondheim, Trøndelag. Org.nr 812849352.") && descriptionOf(memaPages[0]!.text) !== descriptionOf(memaPages[1]!.text), "T2b: MEMA metas carry «Org.nr N.» and differ");
      const tsTitles = [titleOf((await page(tsA)).text), titleOf((await page(tsB)).text)];
      assertTrue(tsTitles[0] !== tsTitles[1] && tsTitles.every((t) => / \(org\.nr \d{9}\) \| Finn-tannlege\.com$/.test(t ?? "")), `T2c: TRONDHEIM TANNLEGESENTER: different titles with an org.nr suffix (${tsTitles.join(" / ")})`);

      const hansen = [await page(hansenA), await page(hansenB)];
      assertEq(hansen.map((p) => titleOf(p.text)), [
        "TANNLEGE HANSEN AS — Tannlegeklinikk i 4006 Stavanger | Finn-tannlege.com",
        `TANNLEGE HANSEN AS — Tannlegeklinikk i Stavanger (org.nr ${hansenB.org_nr}) | Finn-tannlege.com`,
      ], "T3: one postnummer is the placeholder 0000 -> that page gets the org.nr, the other its postnummer");
      assertTrue(!(descriptionOf(hansen[1]!.text) ?? "").includes("0000"), "T3b: 0000 is never shown in the meta");

      const aas = [await page(aasA), await page(aasB)];
      assertEq(aas.map((p) => titleOf(p.text)), [
        "Tannlegene på Ås — Tannlegeklinikk i 1430 Ås | Finn-tannlege.com",
        "TANNLEGENE PÅ ÅS — Tannlegeklinikk i 1431 Ås | Finn-tannlege.com",
      ], "T4: names that differ only in case are namesakes");

      const vest = [await page(vestUpper), await page(vestLower)];
      assertEq(vest.map((p) => titleOf(p.text)), [
        "VEST TANN AS — Tannlegeklinikk i 5003 Bergen | Finn-tannlege.com",
        "VEST TANN AS — Tannlegeklinikk i 5011 Bergen | Finn-tannlege.com",
      ], "T5: «BERGEN» and «Bergen» are one place (regression: both «… i Bergen»)");

      const enk = [await page(enkA), await page(enkB)];
      assertEq(enk.map((p) => titleOf(p.text)), [
        "Tannlege KARI NORDMANN i 0150 Oslo | Finn-tannlege.com",
        "Tannlege KARI NORDMANN i 0151 Oslo | Finn-tannlege.com",
      ], "T6: the sole-proprietor template gets the postnummer too");
      const lab = [await page(labA), await page(labB)];
      assertEq(lab.map((p) => titleOf(p.text)), [
        `TANNTEKNIKK OSLO AS i Oslo (org.nr ${labA.org_nr}) | Finn-tannlege.com`,
        `TANNTEKNIKK OSLO AS i Oslo (org.nr ${labB.org_nr}) | Finn-tannlege.com`,
      ], "T7: the non-clinic template gets the org.nr too");

      const om = [await page(omA), await page(omB)];
      assertEq(titleOf(om[0]!.text), "OM OSS TANN AS — Tannlegeklinikk i 0170 Oslo | Finn-tannlege.com", "T8a: a clinic with om_oss gets the title suffix");
      assertEq(descriptionOf(om[0]!.text), "Vi er en hyggelig klinikk midt i Oslo sentrum, med lang erfaring og moderne utstyr.", "T8b: the om_oss meta is unchanged");
      assertTrue(descriptionOf(om[1]!.text)!.startsWith("OM OSS TANN AS er en tannlegeklinikk i 0171 Oslo."), "T8c: its namesake's structured meta names its postnummer");

      const nord = [await page(nordA), await page(nordClosed)];
      assertEq(nord.map((p) => titleOf(p.text)), [
        `NORD TANN AS — Tannlegeklinikk i Tromsø (org.nr ${nordA.org_nr}) | Finn-tannlege.com`,
        `NORD TANN AS — Tannlegeklinikk i Tromsø (org.nr ${nordClosed.org_nr}) | Finn-tannlege.com`,
      ], "T9: a closed namesake gives the active clinic a suffix (deliberate)");
    }

    // ── N. no namesake: byte-identical ───────────────────────────────────
    {
      const bergen = await page(tranBergen);
      assertEq(titleOf(bergen.text), "TANNLEGE TRAN — Tannlegeklinikk i Bergen | Finn-tannlege.com", "N1: the same name in another poststed -> the title as before");
      assertEq(descriptionOf(bergen.text), buildClinicDescription(agentOf(tranBergen), stedCount(tranBergen), true), "N1b: … and the meta as before");
      const soloPage = await page(solo);
      assertEq(titleOf(soloPage.text), "SOLO TANN AS — Tannlegeklinikk i Oslo | Finn-tannlege.com", "N2/N3: no public namesake (only a rejected and the probe row) -> the title as before");
      assertEq(descriptionOf(soloPage.text), buildClinicDescription(agentOf(solo), stedCount(solo), true), "N2/N3b: … and the meta as before");
    }

    // ── M. the sitemap: shared slug prefixes have different titles ──────
    {
      const sm = await callRoute(router, "/sitemap.xml");
      const locs = Array.from(sm.text.matchAll(/<loc>([^<]*\/klinikk\/[^<]*)<\/loc>/g), (m) => m[1]!);
      const byPrefix = new Map<string, string[]>();
      for (const loc of locs) {
        const prefix = loc.slice(loc.lastIndexOf("/") + 1).replace(/--\d{9}$/, "");
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), loc]);
      }
      const shared = [...byPrefix.entries()].filter(([, l]) => l.length > 1);
      const clashes: string[] = [];
      for (const [prefix, l] of shared) {
        const titles = await Promise.all(l.map(async (loc) => titleOf((await callRoute(router, loc.slice(base.length))).text)));
        if (new Set(titles).size !== titles.length || titles.includes(null)) clashes.push(`${prefix}: ${titles.join(" / ")}`);
      }
      assertTrue(shared.length >= 7 && shared.some(([p]) => p === "tannlege-tran"), `M1: fixture sanity — ${shared.length} shared slug prefixes in the sitemap, TRAN among them`);
      assertEq(clashes, [], "M2: every slug prefix shared by several org.nr has a different <title> per URL");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental namesake-titler: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalNamesakeTitlerTests({ log: true }).then((r) => {
    console.log(`\ndental namesake-titler (D3e): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

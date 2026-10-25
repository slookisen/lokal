/**
 * dental-profil-skrivemate.test.ts -- dev-request 2026-10-17-dental-d3-rettelser,
 * skive D3d punkt 2 trinn 3 (klinikksiden bruker offisiell stedsskrivemåte).
 *
 *   H  titleCasePoststed capitalises each part of a hyphenated name
 *      ("SØR-FRON" -> "Sør-Fron"; review of #1157, S3); small words stay
 *      lower case; every 2024 kommune name reads as it is written.
 *   U  officialPlaceLabel: a stored ASCII or hyphen fold gets the official
 *      spelling, title-cased (Tromsoe -> Tromsø, Baerum -> Bærum, Nord Aurdal
 *      -> Nord-Aurdal); a value qualified with « i …» gets the official
 *      spelling of the place before it (Heroey I M Og R -> Herøy i M og R,
 *      FUNN dental-ascii-poststed-med-suffiks); anything else (BERGEN, Mo i
 *      Rana, Kaafjord, MOEN, Ukjent, foreign) reads exactly as
 *      titleCasePoststed; the label always slugs like the stored value, so the
 *      page's name and its /sted link are the same place.
 *   R  the bundled register: every official poststed and kommune name keeps
 *      its label, and the ASCII fold of each finds the same label.
 *   P  parity: the page names a place as the MCP/A2A card does, title-cased.
 *   T  the clinic page (/klinikk/id/:id) of a «Tromsoe» clinic: <title>,
 *      og:title, twitter:title, meta description («Det finnes N klinikker i
 *      Tromsø», N over both spellings), Dentist JSON-LD (addressLocality,
 *      areaServed, description), BreadcrumbList, the header's place and the
 *      related-clinics section all say Tromsø; no «Tromsoe» in <head> or
 *      JSON-LD; the /sted link and the info box's stored address unchanged.
 *      Namesakes in two spellings (D3e, FUNN
 *      dental-stedsetikett-to-kallsteder-trinn3) never mix «Tromsoe» and
 *      «Tromsø»; kommune, hyphen, qualifier, sole-proprietor and non-clinic
 *      pages likewise.
 *   N  negatives: a page whose stored place is already in official form, or
 *      unknown to the register, names it exactly as titleCasePoststed did.
 *
 * Same harness as dental-namesake-titler.test.ts (in-memory dental DB, the
 * router driven through router.handle(), req.query filled from the URL).
 *
 * Standalone: npx tsx src/routes/dental-profil-skrivemate.test.ts
 * Wired into tests/test.ts via runDentalProfilSkrivemateTests().
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
const headOf = (html: string): string => html.slice(0, html.indexOf("</head>"));
/** Every JSON-LD node on the page. */
const jsonLdNodes = (html: string): Array<Record<string, any>> =>
  Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g), (m) => JSON.parse(m[1]!));
const dentistOf = (html: string) => jsonLdNodes(html).find((n) => n["@type"] === "Dentist") ?? null;
/** The BreadcrumbList item for the place: [name, url], or null. */
const breadcrumbPlaceOf = (html: string): [string, string] | null => {
  const list = jsonLdNodes(html).find((n) => n["@type"] === "BreadcrumbList");
  const item = (list?.itemListElement ?? []).find((i: any) => /\/sted\//.test(String(i.item)));
  return item ? [item.name, item.item] : null;
};
const profileLocOf = (html: string): string | null => {
  const m = html.match(/<div class="profile-loc">[\s\S]*?<\/svg> ([^<]*)<\/div>/);
  return m ? unescape(m[1]!) : null;
};
const infoAddressOf = (html: string): string | null => {
  const m = html.match(/<div class="info-label">Adresse<\/div><div class="info-value">([^<]*)<\/div>/);
  return m ? unescape(m[1]!) : null;
};

export async function runDentalProfilSkrivemateTests(
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
    require.resolve("../services/dental-clinic-card"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const card = require("../services/dental-clinic-card") as typeof import("../services/dental-clinic-card");
    const { kommuner2024, officialPoststedKommuner } = require("../services/norway-postnummer") as typeof import("../services/norway-postnummer");
    const { officialPlaceSpelling } = require("../services/search-intent/norwegian-query") as typeof import("../services/search-intent/norwegian-query");
    const { __resetDentalSearchGazetteerForTesting } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    const { titleCasePoststed, officialPlaceLabel, slugifyText } = dentalSeo;

    // ── H. titleCasePoststed and hyphens ─────────────────────────────────
    {
      assertEq(
        ["SØR-FRON", "NORD-LENANGEN", "ÅNA-SIRA", "AURSKOG-HØLAND", "sør-fron"].map(titleCasePoststed),
        ["Sør-Fron", "Nord-Lenangen", "Åna-Sira", "Aurskog-Høland", "Sør-Fron"],
        "H1: each part of a hyphenated name is capitalised (regression: «Sør-fron»)"
      );
      assertEq(
        ["OSLO", "MO I RANA", "STORD OG FITJAR", "ÅS", "BERGEN", "", "X-", "A--B"].map(titleCasePoststed),
        ["Oslo", "Mo i Rana", "Stord og Fitjar", "Ås", "Bergen", "", "X-", "A--B"],
        "H2: names without a hyphen, small words and edge cases read as before"
      );
      const kommuner = kommuner2024().map((k) => k.kommune);
      const off = kommuner.filter((k) => titleCasePoststed(k.toUpperCase()) !== k);
      assertTrue(kommuner.length > 300 && off.length === 0, `H3: every 2024 kommune name, stored in capitals, title-cases to its written form (${kommuner.length} names; off: ${off.join(", ")})`);
    }

    // ── U. officialPlaceLabel (pure) ─────────────────────────────────────
    {
      const folds: Array<[string, string]> = [
        ["Tromsoe", "Tromsø"], ["TROMSOE", "Tromsø"], ["Bodoe", "Bodø"], ["Aalesund", "Ålesund"],
        ["Lillestroem", "Lillestrøm"], ["Aamot", "Åmot"], ["Aas", "Ås"], ["Haa", "Hå"], ["Aal", "Ål"],
      ];
      for (const [stored, label] of folds) assertEq(officialPlaceLabel(stored), label, `U1: poststed «${stored}» -> «${label}»`);
      const kommuner: Array<[string, string]> = [
        ["Baerum", "Bærum"], ["Indre Oestfold", "Indre Østfold"], ["Nord Aurdal", "Nord-Aurdal"],
        ["Aurskog Hoeland", "Aurskog-Høland"], ["Soer Varanger", "Sør-Varanger"], ["Karlsoey", "Karlsøy"], ["Kvaenangen", "Kvænangen"],
      ];
      for (const [stored, label] of kommuner) assertEq(officialPlaceLabel(stored), label, `U2: kommune «${stored}» -> «${label}», as the kommune is written`);
      assertEq(
        ["Heroey I M Og R", "HEROEY I M OG R", "Vaaler I Innlandet"].map(officialPlaceLabel),
        ["Herøy i M og R", "Herøy i M og R", "Våler i Innlandet"],
        "U3: a qualified value gets the official spelling of the place before « i …» (FUNN dental-ascii-poststed-med-suffiks)"
      );
      const asStored = ["BERGEN", "Bergen", "bergen", "OSLO", "MO I RANA", "Mo i Rana", "Mo I Rana", "TROMSØ", "Tromsø", "ÅS", "Nesttun", "SØR-FRON",
        "Kaafjord", "MOEN", "MOELV", "GARDERMOEN", "SOLBERGMOEN", "Tromso", "As", "TEST", "Ukjent", "Se-44338 Lerum", "Ukjentsted i Nordland", "Amsterdam"];
      const differs = asStored.filter((v) => officialPlaceLabel(v) !== titleCasePoststed(v));
      assertEq(differs, [], "U4: a value already in official form, the visitor's ASCII alias (Tromso, As) or a name the register does not know (Kaafjord, MOEN, Ukjent, foreign) reads exactly as titleCasePoststed");
      // placeKey finds the official name, but its slug would be another /sted page: keep the stored value.
      assertEq(["NordAurdal", "Tromsö"].map(officialPlaceLabel), ["Nordaurdal", "Tromsö"], "U5: the official spelling is not taken when it slugs differently (the page's /sted link would name another place)");
      const sample = [...folds.map((f) => f[0]), ...kommuner.map((k) => k[0]), "Heroey I M Og R", "Vaaler I Innlandet", ...asStored, "NordAurdal", "Tromsö", "BERGEN ", " Tromsoe"];
      const slugOff = sample.filter((v) => slugifyText(officialPlaceLabel(v)) !== slugifyText(v));
      assertEq(slugOff, [], "U6: the label always slugs like the stored value");
      assertEq(officialPlaceLabel(" Tromsoe "), "Tromsø", "U7: surrounding spaces do not stop the lookup");
    }

    // ── R. the bundled register ──────────────────────────────────────────
    {
      const poststeder = [...officialPoststedKommuner().keys()];
      const kommuner = kommuner2024().map((k) => k.kommune);
      const off = poststeder.filter((p) => officialPlaceLabel(p) !== titleCasePoststed(p));
      assertTrue(poststeder.length > 1000 && off.length === 0, `R1: every official poststed reads as titleCasePoststed reads it (${poststeder.length}; off: ${off.slice(0, 5).join(", ")})`);
      const offK = kommuner.filter((k) => titleCasePoststed(officialPlaceLabel(k)) !== titleCasePoststed(k));
      assertTrue(offK.length === 0, `R2: every 2024 kommune name keeps its own label (off: ${offK.slice(0, 5).join(", ")})`);
      const ascii = (s: string) => s.replace(/Æ/g, "AE").replace(/Ø/g, "OE").replace(/Å/g, "AA").replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa");
      const named = [...poststeder, ...kommuner].filter((n) => /[æøåÆØÅ]/.test(n) && officialPlaceSpelling(n) !== null);
      const lost = named.filter((n) => officialPlaceLabel(ascii(n)) !== officialPlaceLabel(n));
      assertTrue(named.length > 300 && lost.length === 0, `R3: the ASCII fold of every official name with æ/ø/å finds the same label (${named.length} names; lost: ${lost.slice(0, 5).join(", ")})`);
    }

    // ── P. parity with the MCP/A2A card ──────────────────────────────────
    {
      const cardPlace = (poststed: string) =>
        card.toDentalClinicCard({ id: "p", navn: "Paritet Tann AS", org_nr: "918760000", poststed, fylke: "Troms" } as any, "detail", { specialists: [] }).poststed;
      const values = ["Tromsoe", "TROMSOE", "Baerum", "Aurskog Hoeland", "Soer Varanger", "Nord Aurdal", "Aamot", "Bodoe", "BERGEN", "Bergen", "Mo I Rana", "SØR-FRON", "Soer-Fron", "Kaafjord", "TEST"];
      const off = values.filter((v) => officialPlaceLabel(v) !== titleCasePoststed(String(cardPlace(v))));
      assertEq(off, [], "P1: the page names the place as the card does, title-cased (Tromsoe: card «Tromsø», page «Tromsø»)");
      assertEq(cardPlace("Soer-Fron"), "Sør-Fron", "P2: the card's poststed branch gets the hyphen fix too («Sør-Fron», was «Sør-fron»)");
      assertEq([cardPlace("Heroey I M Og R"), officialPlaceLabel("Heroey I M Og R")], ["Heroey I M Og R", "Herøy i M og R"], "P3: (known gap) the qualified form is read on the page only; the card keeps the stored value");
    }

    // ── fixture ──────────────────────────────────────────────────────────
    let orgSeq = 918760000;
    type Extra = { klass?: string; omOss?: string; adresse?: string };
    type Made = { id: string; navn: string; org_nr: string; poststed: string };
    const mk = (navn: string, poststed: string, fylke: string, postnummer: string | null, x: Extra = {}): Made => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({ navn, org_nr, poststed, fylke, postnummer, adresse: x.adresse ?? "Storgata 1", telefon: "77123456" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = ?, om_oss = ? WHERE id = ?").run(x.klass ?? "klinikk", x.omOss ?? null, id);
      return { id, navn, org_nr, poststed };
    };
    // Tromsø in two spellings: TROMSØ is the larger, so /sted/tromsoe is named «Tromsø».
    const ishavet = mk("Ishavet Tann AS", "Tromsoe", "Troms", "9008");
    mk("Polar Tann AS", "Tromsoe", "Troms", "9010");
    mk("Sentrum Tann Tromsø AS", "TROMSØ", "Troms", "9008");
    mk("Fjellheisen Tann AS", "TROMSØ", "Troms", "9020");
    mk("Breivika Tann AS", "TROMSØ", "Troms", "9019");
    // Namesakes across the two spellings (D3e): postnumre that differ, and one that does not.
    const nordUpper = mk("NORD TANN AS", "TROMSØ", "Troms", "9019");
    const nordAscii = mk("NORD TANN AS", "Tromsoe", "Troms", "9008");
    const sorUpper = mk("SØR TANN AS", "TROMSØ", "Troms", "9008");
    const sorAscii = mk("SØR TANN AS", "Tromsoe", "Troms", "9008");
    // A kommune stored as poststed, a hyphenated poststed, qualified values.
    const baerum = mk("Sandvika Tann AS", "Baerum", "Akershus", "1337");
    const fron = mk("Fron Tann AS", "SØR-FRON", "Innlandet", "2647");
    const aurdal = mk("Fagernes Tann AS", "Nord Aurdal", "Innlandet", "2900");
    const heroy = mk("Fosnavåg Tann AS", "Heroey I M Og R", "Møre og Romsdal", "6090");
    const vaaler = mk("Solør Tann AS", "Vaaler I Innlandet", "Innlandet", "2436");
    // The other two title templates.
    const enk = mk("KARI HANSEN", "Bodoe", "Nordland", "8006", { klass: "person_enk" });
    const lab = mk("TANNTEKNIKK NORD AS", "Aalesund", "Møre og Romsdal", "6002", { klass: "lab_leverandor" });
    // Negatives: already official, or unknown to the register.
    const negatives = [
      mk("Bryggen Tann AS", "BERGEN", "Vestland", "5003"),
      mk("Nesttun Tann AS", "Bergen", "Vestland", "5221"),
      mk("Rana Tann AS", "MO I RANA", "Nordland", "8601"),
      mk("Olderdalen Tann AS", "Kaafjord", "Troms", "9146"),
      mk("Moen Tann AS", "MOEN", "Troms", "9321"),
      mk("Ukjent Tann AS", "Ukjent", "Oslo", "0150"),
      mk("Lerum Tann AS", "Se-44338 Lerum", "Oslo", "0151"),
    ];
    __resetDentalSearchGazetteerForTesting();
    dentalSeo.__resetDentalSitemapCacheForTesting();

    const page = async (c: Made): Promise<string> => {
      const r = await callRoute(router, `/klinikk/id/${c.id}`);
      if (r.status !== 200) throw new Error(`/klinikk/id/${c.id} gave ${r.status}`);
      return r.text;
    };
    const stedCount = (c: Made): number => {
      const g = dentalSeo.findStedGroup(slugifyText(c.poststed));
      return g ? store.countPublicDentalAgents(dentalSeo.stedFilter(g)) : 0;
    };

    // ── T. the clinic page of a «Tromsoe» clinic ─────────────────────────
    {
      const html = await page(ishavet);
      const head = headOf(html);
      const title = "Ishavet Tann AS — Tannlegeklinikk i Tromsø | Finn-tannlege.com";
      assertEq([titleOf(html), metaOf(html, 'property="og:title"'), metaOf(html, 'name="twitter:title"')], [title, title, title], "T1: <title>, og:title and twitter:title say «i Tromsø» (was «i Tromsoe»)");
      assertEq(stedCount(ishavet), 9, "T2: (fixture: /sted/tromsoe counts both spellings, 9)");
      const meta = `Ishavet Tann AS er en tannlegeklinikk i Tromsø, Troms. Det finnes 9 klinikker i Tromsø.`;
      assertEq([metaOf(html, 'name="description"'), metaOf(html, 'property="og:description"'), metaOf(html, 'name="twitter:description"')], [meta, meta, meta], "T3: the meta description names Tromsø, and its count is the /sted count over both spellings");
      const ld = dentistOf(html);
      assertEq([ld?.address?.addressLocality, ld?.areaServed?.name, ld?.address?.postalCode, ld?.address?.addressRegion], ["Tromsø", "Tromsø", "9008", "Troms"], "T4: JSON-LD addressLocality and areaServed say Tromsø; postalCode and addressRegion unchanged");
      assertTrue(String(ld?.description).startsWith("Ishavet Tann AS er en tannlegeklinikk i Tromsø, Troms. Adresse: Storgata 1, 9008 Tromsø."), `T5: the JSON-LD description names Tromsø in the opening and the address (${ld?.description})`);
      assertEq(breadcrumbPlaceOf(html), ["Tromsø", `${base}/sted/tromsoe`], "T6: BreadcrumbList names Tromsø and links /sted/tromsoe (the same /sted page as before)");
      assertEq(profileLocOf(html), "Tromsø, Troms", "T7: the header's place reads «Tromsø, Troms»");
      assertTrue(html.includes("<h2>Flere tannleger i Tromsø</h2>") && html.includes(`<a href="/sted/tromsoe">Se alle tannleger i Tromsø &rarr;</a>`), "T8: the related-clinics section says Tromsø and links /sted/tromsoe");
      assertTrue(!head.includes("Tromsoe") && !jsonLdNodes(html).some((n) => JSON.stringify(n).includes("Tromsoe")), "T9: «Tromsoe» is nowhere in <head> or the JSON-LD");
      assertEq(infoAddressOf(html), "Storgata 1, 9008 Tromsoe", "T10: (non-goal) the info box shows the registered address as stored");
    }

    // Namesakes in two spellings: both title labels go through one rule.
    {
      const nord = [await page(nordUpper), await page(nordAscii)];
      assertEq(nord.map(titleOf), [
        "NORD TANN AS — Tannlegeklinikk i 9019 Tromsø | Finn-tannlege.com",
        "NORD TANN AS — Tannlegeklinikk i 9008 Tromsø | Finn-tannlege.com",
      ], "T11: namesakes in TROMSØ and Tromsoe: «i 9019 Tromsø» / «i 9008 Tromsø» (regression: «i 9008 Tromsoe»)");
      assertTrue((metaOf(nord[1]!, 'name="description"') ?? "").startsWith("NORD TANN AS er en tannlegeklinikk i 9008 Tromsø, Troms."), "T12: … and the meta names «9008 Tromsø»");
      const sor = [await page(sorUpper), await page(sorAscii)];
      assertEq(sor.map(titleOf), [
        `SØR TANN AS — Tannlegeklinikk i Tromsø (org.nr ${sorUpper.org_nr}) | Finn-tannlege.com`,
        `SØR TANN AS — Tannlegeklinikk i Tromsø (org.nr ${sorAscii.org_nr}) | Finn-tannlege.com`,
      ], "T13: same postnummer -> org.nr, and both pages say «i Tromsø»");
      assertTrue(nord.concat(sor).every((h) => !headOf(h).includes("Tromsoe")), "T14: no namesake page has «Tromsoe» in <head> (FUNN dental-stedsetikett-to-kallsteder-trinn3)");
    }

    // Kommune, hyphen and qualified values; the other two templates.
    {
      const cases: Array<[Made, string, string]> = [
        [baerum, "Sandvika Tann AS — Tannlegeklinikk i Bærum | Finn-tannlege.com", "Bærum"],
        [fron, "Fron Tann AS — Tannlegeklinikk i Sør-Fron | Finn-tannlege.com", "Sør-Fron"],
        [aurdal, "Fagernes Tann AS — Tannlegeklinikk i Nord-Aurdal | Finn-tannlege.com", "Nord-Aurdal"],
        [heroy, "Fosnavåg Tann AS — Tannlegeklinikk i Herøy i M og R | Finn-tannlege.com", "Herøy i M og R"],
        [vaaler, "Solør Tann AS — Tannlegeklinikk i Våler i Innlandet | Finn-tannlege.com", "Våler i Innlandet"],
      ];
      for (const [c, title, place] of cases) {
        const html = await page(c);
        const ld = dentistOf(html);
        assertEq(
          [titleOf(html), ld?.address?.addressLocality, ld?.areaServed?.name, breadcrumbPlaceOf(html), profileLocOf(html)?.split(",")[0]],
          [title, place, place, [place, `${base}/sted/${slugifyText(c.poststed)}`], place],
          `T15: «${c.poststed}» is «${place}» in title, JSON-LD, breadcrumb and header; the /sted link is unchanged`
        );
      }
      const enkHtml = await page(enk);
      assertEq([titleOf(enkHtml), metaOf(enkHtml, 'name="description"')], ["Tannlege KARI HANSEN i Bodø | Finn-tannlege.com", "KARI HANSEN i Bodø. Registeroppføring."], "T16: the sole-proprietor template and its meta say «i Bodø»");
      const labHtml = await page(lab);
      assertEq([titleOf(labHtml), metaOf(labHtml, 'name="description"')], ["TANNTEKNIKK NORD AS i Ålesund | Finn-tannlege.com", "TANNTEKNIKK NORD AS i Ålesund. Registeroppføring."], "T17: the non-clinic template and its meta say «i Ålesund»");
      const sted = await callRoute(router, "/sted/soer-fron");
      assertEq(titleOf(sted.text), "Tannlege i Sør-Fron — Finn-tannlege.com", "T18: /sted/soer-fron gets the hyphen fix too (was «Sør-fron»)");
    }

    // ── N. negatives: the page names the place as before ─────────────────
    for (const c of negatives) {
      const html = await page(c);
      const before = titleCasePoststed(c.poststed);
      const valid = dentalSeo.isValidLocality(c.poststed);
      const ld = dentistOf(html);
      assertEq(
        [titleOf(html), ld?.address?.addressLocality ?? null, breadcrumbPlaceOf(html)?.[0] ?? null],
        [`${c.navn} — Tannlegeklinikk i ${before} | Finn-tannlege.com`, valid ? before : null, valid ? before : null],
        `N1: «${c.poststed}» reads «${before}» as before, in title, JSON-LD and breadcrumb`
      );
    }
  } catch (err: any) {
    failed++;
    failures.push("dental profil-skrivemate: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalProfilSkrivemateTests({ log: true }).then((r) => {
    console.log(`\ndental profil-skrivemåte (D3d trinn 3): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

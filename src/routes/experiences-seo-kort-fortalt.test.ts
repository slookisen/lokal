/**
 * experiences-seo-kort-fortalt.test.ts — dev-request
 * 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E2-S1: one fact
 * list (services/experience-page-facts.ts) feeds the «Kort fortalt» box, the
 * facts table and the fallback meta / JSON-LD description of
 * /opplevelse/<slug>. Plus the three lokal#1092 review follow-ups:
 * S1 per_adult unit from uiLang, S2 one sitemap log line per build,
 * S3 description on PublishedSlugRow.
 *
 * Covers:
 *   (a) buildExperienceFacts(): only set fields; thin and full rows; the
 *       per_adult rule (adult price, never «fra»); per_person / per_group /
 *       unknown unit; price band and band 'ukjent'; age; booking; Brreg
 *       provider; en/sv words; the facts table keeps its 11 rows.
 *   (b) buildExperienceFactSentence(): exact thin-row text; facts added whole
 *       or not at all within the 155-char budget; unknown price skipped;
 *       deterministic; no number without a source in the row's own fields
 *       (expDescHasUngroundedNumbers, the enrichment's own check).
 *   (c) formatFactDate(): «Sist oppdatert» in no/en/sv, null when unparseable.
 *   (d) the page: every detail page has one .kort-fortalt over the lede;
 *       box and table share labels and values; «Sist oppdatert» follows
 *       updated_at; a described page keeps its description as meta; a page
 *       without (or with a junk) description gets the fact sentence as meta,
 *       og:description and JSON-LD description; 20 such pages have 20
 *       different metas, none from the old shared template, every number
 *       grounded in the row.
 *   (e) S1: /en with the switcher off shows «per voksen» under lang="nb";
 *       with the switcher on, «per adult» under lang="en".
 *   (f) S2: one `[experiences-sitemap] detail listed=<n> noindex_skipped=<m>`
 *       line per sitemap build, with the counts the sitemap really has.
 *   (g) S3: listPublishedExperienceSlugs() carries description; the second
 *       description query is gone.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-kort-fortalt.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const OLD_TEMPLATE = "håndplukkede norske opplevelser";

function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: {},
      headers: {},
      // i18n/middleware.ts strips "/en" and sets req.lang before the router runs.
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() {},
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<[^>]*>/g, "")).trim();
}
function metaDescription(html: string): string {
  return unescapeHtml(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "");
}
function ogDescription(html: string): string {
  return unescapeHtml(/<meta property="og:description" content="([^"]*)"/.exec(html)?.[1] ?? "");
}
function ldBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].replace(/<\\\//g, "</"))); } catch { /* ignore */ }
  }
  return out;
}
function kortFortaltSection(html: string): string {
  return /<section class="kort-fortalt"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}
/** label → plain-text value, from the box's <dt>/<dd> pairs. */
function boxPairs(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g;
  let m: RegExpExecArray | null;
  const section = kortFortaltSection(html);
  while ((m = re.exec(section))) out.set(stripTags(m[1]), stripTags(m[2]));
  return out;
}
/** label → plain-text value, from the facts table's rows. */
function tablePairs(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const table = /<table class="facts">[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
  const re = /<tr><th scope="row">([\s\S]*?)<\/th><td>([\s\S]*?)<\/td><\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(table))) out.set(stripTags(m[1]), stripTags(m[2]));
  return out;
}

export function runExperiencesSeoKortFortaltTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    const prevNoindex = process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      const pf = require("../services/experience-page-facts") as typeof import("../services/experience-page-facts");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const { expDescHasUngroundedNumbers } = require("./opplevelser") as typeof import("./opplevelser");
      const NO = seo.experienceFactWords("no");
      const EN = seo.experienceFactWords("en");
      const SV = seo.experienceFactWords("sv");

      type Row = import("../services/experience-page-facts").ExperienceFactsInput;
      const blank: Row = {
        category: null, kommune: null, fylke: null, indoor_outdoor: null, season: [], duration_min: null, duration_max: null,
        group_min: null, group_max: null, min_age: null, age_suitability: null, price_from: null, price_band: null,
        price_unit: null, languages: [], accessibility: [], meeting_point: null, booking_type: null, booking_url: null,
      };
      const thinRow: Row = { ...blank, category: "natur_friluft", kommune: "Strand", fylke: "Rogaland" };
      const fullRow: Row = {
        ...thinRow, indoor_outdoor: "outdoor", season: ["summer", "autumn"], duration_min: 90, duration_max: 120,
        group_min: 2, group_max: 8, min_age: 12, price_from: 990, price_unit: "per_adult",
        languages: ["norsk", "engelsk"], accessibility: ["rullestol"], meeting_point: "Kaia i Forsand",
        booking_type: "request", booking_url: "https://book.example.no",
      };
      const verifiedProvider = { id: "p-1", slug: "fjord-fjell", navn: "Fjord & Fjell AS", brreg_verified: 1 };
      const value = (facts: ReturnType<typeof pf.buildExperienceFacts>, key: string) => facts.find((f) => f.key === key)?.value;

      // ── (a) buildExperienceFacts ───────────────────────────────────────────
      {
        const thin = pf.buildExperienceFacts(thinRow, null, NO);
        assertTrue(JSON.stringify(thin.map((f) => f.key)) === JSON.stringify(["category", "place", "fylke", "kommune"]),
          `kf-a1: thin row → only category/place/fylke/kommune (got ${thin.map((f) => f.key).join(",")})`);
        assertTrue(thin[0].label === "Kategori" && thin[0].value === "Natur & friluft" && thin[0].href === "/kategori/natur_friluft",
          "kf-a2: category fact = label, catLabel value and the category page");
        assertTrue(value(thin, "place") === "Strand, Rogaland", "kf-a3: place = «kommune, fylke»");
        assertTrue(pf.buildExperienceFacts(blank, null, NO).length === 0, "kf-a4: a row with no fields set → no facts at all");

        const full = pf.buildExperienceFacts(fullRow, verifiedProvider, NO);
        const fullKeys = ["category", "place", "fylke", "kommune", "indoor", "season", "duration", "group", "age", "price", "languages", "accessibility", "meeting", "booking", "provider"];
        assertTrue(JSON.stringify(full.map((f) => f.key)) === JSON.stringify(fullKeys), `kf-a5: full row → every fact once (got ${full.map((f) => f.key).join(",")})`);
        assertTrue(value(full, "price") === "990 kr per voksen", `kf-a6: per_adult → «990 kr per voksen», no «fra» (got ${value(full, "price")})`);
        assertTrue(value(full, "duration") === "90–120 min" && value(full, "group") === "2–8 personer" && value(full, "season") === "Sommer, Høst",
          "kf-a7: duration, group and season keep the table's wording");
        assertTrue(value(full, "age") === "fra 12 år", `kf-a8: min_age → «fra 12 år» (got ${value(full, "age")})`);
        assertTrue(value(full, "booking") === "På forespørsel hos tilbyderen", "kf-a9: booking_type request → «På forespørsel hos tilbyderen»");
        const prov = full.find((f) => f.key === "provider");
        assertTrue(prov?.value === "Fjord & Fjell AS (Brreg-verifisert)" && prov?.href === "/tilbyder/fjord-fjell",
          "kf-a10: a Brreg-verified provider is named as verified and linked to its page");
        assertTrue(value(full, "meeting") === "Kaia i Forsand", "kf-a11: meeting point is the value handed in");

        const priceOf = (row: Partial<Row>) => value(pf.buildExperienceFacts({ ...thinRow, ...row }, null, NO), "price");
        assertTrue(priceOf({ price_from: 450, price_unit: "per_person" }) === "fra 450 kr pr. person", "kf-a12: per_person → «fra 450 kr pr. person»");
        assertTrue(priceOf({ price_from: 3000, price_unit: "per_group" }) === "fra 3000 kr pr. gruppe", "kf-a13: per_group → «fra 3000 kr pr. gruppe»");
        assertTrue(priceOf({ price_from: 990, price_unit: "unknown" }) === "fra 990 kr", "kf-a14: unknown unit → «fra 990 kr» (the old fallback)");
        assertTrue(priceOf({ price_band: "rimelig" }) === "Rimelig", "kf-a15: band only → its label");
        const ukjent = pf.buildExperienceFacts({ ...thinRow, price_band: "ukjent" }, null, NO).find((f) => f.key === "price");
        assertTrue(ukjent?.value === "Pris ikke oppgitt" && ukjent?.unknown === true, "kf-a16: band 'ukjent' → «Pris ikke oppgitt», marked unknown");
        assertTrue(priceOf({ price_from: 0 }) === undefined, "kf-a17: price_from 0 and no band → no price fact (as before)");

        const ageOf = (row: Partial<Row>) => value(pf.buildExperienceFacts({ ...thinRow, ...row }, null, NO), "age");
        assertTrue(ageOf({ age_suitability: "family" }) === "Familievennlig", "kf-a18: age_suitability family → «Familievennlig»");
        assertTrue(ageOf({ min_age: 0, age_suitability: "all" }) === "Alle aldre", "kf-a19: min_age 0 is no limit → age_suitability");
        assertTrue(ageOf({}) === undefined, "kf-a20: no age fields → no age fact");

        const bookingOf = (row: Partial<Row>) => value(pf.buildExperienceFacts({ ...thinRow, ...row }, null, NO), "booking");
        assertTrue(bookingOf({ booking_url: "https://book.example.no/x" }) === "Via tilbyderens bestillingsside", "kf-a21: booking_url only → «Via tilbyderens bestillingsside»");
        assertTrue(bookingOf({ booking_url: "javascript:alert(1)" }) === undefined, "kf-a22: a non-http booking_url is no booking fact");
        assertTrue(bookingOf({ booking_type: "none" }) === "Ingen forhåndsbestilling", "kf-a23: booking_type none → «Ingen forhåndsbestilling»");

        const provOf = (p: Record<string, unknown> | null) => pf.buildExperienceFacts(thinRow, p, NO).find((f) => f.key === "provider");
        assertTrue(provOf({ id: "p-2", navn: "Uverifisert AS", brreg_verified: 0 })?.value === "Uverifisert AS", "kf-a24: an unverified provider is named without the Brreg claim");
        assertTrue(provOf({ id: "p-3", navn: "   ", brreg_verified: 1 }) === undefined && provOf(null) === undefined, "kf-a25: no provider name → no provider fact");

        assertTrue(value(pf.buildExperienceFacts(fullRow, null, EN), "price") === "990 NOK per adult", "kf-a26: en words → «990 NOK per adult»");
        assertTrue(value(pf.buildExperienceFacts(fullRow, null, SV), "price") === "990 NOK per vuxen", "kf-a27: sv words → «990 NOK per vuxen»");

        assertTrue(JSON.stringify(pf.TABLE_FACT_KEYS) === JSON.stringify(["category", "fylke", "kommune", "indoor", "season", "duration", "group", "price", "languages", "accessibility", "meeting"]),
          "kf-a28: the facts table keeps exactly its 11 pre-E2-S1 rows, in order");
        const picked = pf.pickFacts(full, pf.KORT_FORTALT_FACT_KEYS).map((f) => f.key);
        assertTrue(JSON.stringify(picked) === JSON.stringify(["category", "place", "price", "duration", "season", "group", "age", "booking", "provider"]),
          `kf-a29: the box picks what/where/price/length/season/group/age/booking/provider in that order (got ${picked.join(",")})`);
      }

      // ── (b) buildExperienceFactSentence ────────────────────────────────────
      {
        const thinSentence = pf.buildExperienceFactSentence("Kajakktur i Lysefjorden", pf.buildExperienceFacts(thinRow, null, NO), NO);
        assertTrue(thinSentence === "Kajakktur i Lysefjorden – natur & friluft i Strand, Rogaland.",
          `kf-b1: thin row → «<tittel> – <kategori> i <sted>.» (got ${JSON.stringify(thinSentence)})`);
        assertTrue(!/\d/.test(thinSentence), "kf-b2: a row without numbers gives a sentence without numbers");

        const fullFacts = pf.buildExperienceFacts(fullRow, verifiedProvider, NO);
        const s = pf.buildExperienceFactSentence("Kajakktur i Lysefjorden", fullFacts, NO);
        assertTrue(s.startsWith("Kajakktur i Lysefjorden – natur & friluft i Strand, Rogaland. Pris: 990 kr per voksen."),
          `kf-b3: full row → head, then the adult price first (got ${JSON.stringify(s)})`);
        assertTrue(!s.includes("fra 990"), "kf-b4: per_adult is never «fra» in the sentence");
        assertTrue(s.length <= pf.META_DESCRIPTION_MAX_LENGTH, `kf-b5: fits the ${pf.META_DESCRIPTION_MAX_LENGTH}-char meta budget (got ${s.length})`);
        // Every sentence fact is in it whole, or its label is not in it at all.
        let whole = 0;
        const sentenceKeys = ["price", "duration", "season", "group", "age", "booking", "provider"];
        for (const f of fullFacts.filter((x) => sentenceKeys.includes(x.key))) {
          const clause = `${f.label}: ${f.value}.`;
          if (s.includes(clause) || !s.includes(`${f.label}:`)) whole++;
        }
        assertTrue(whole === sentenceKeys.length, `kf-b6: no fact is cut — each is whole or absent (${whole}/${sentenceKeys.length})`);
        assertTrue(!s.includes("Inne / ute") && !s.includes("Språk"), "kf-b7: only the sentence facts (no indoor/languages)");
        const tight = pf.buildExperienceFactSentence("Kajakktur i Lysefjorden", fullFacts, NO, 90);
        assertTrue(tight.length <= 90 && tight.includes("Pris: 990 kr per voksen.") && !tight.includes("Tilbyder"),
          `kf-b8: a smaller budget keeps the highest-priority facts that fit (got ${JSON.stringify(tight)})`);
        assertTrue(pf.buildExperienceFactSentence("Kajakktur i Lysefjorden", [...fullFacts].reverse(), NO) === s,
          "kf-b9: deterministic — the same facts give the same sentence, whatever their order");

        const ukjentSentence = pf.buildExperienceFactSentence("Smaking", pf.buildExperienceFacts({ ...thinRow, price_band: "ukjent" }, null, NO), NO);
        assertTrue(!ukjentSentence.includes("Pris"), `kf-b10: an unknown price is no fact for the sentence (got ${JSON.stringify(ukjentSentence)})`);
        assertTrue(pf.buildExperienceFactSentence("Hvalsafari.", [], NO) === "Hvalsafari.", "kf-b11: no facts → the title, with a single full stop");
        const longTitle = "Lang tittel ".repeat(20).trim();
        assertTrue(pf.buildExperienceFactSentence(longTitle, fullFacts, NO) === `${longTitle} – natur & friluft i Strand, Rogaland.`,
          "kf-b12: an over-long head gets no facts appended (the page's usual truncation applies)");

        // Every number comes from the row's own fields — the enrichment's check.
        const rows: Array<[string, Row, Record<string, unknown> | null]> = [
          ["Kajakktur i Lysefjorden", fullRow, verifiedProvider],
          ["Ribbetur 2 timer", { ...thinRow, duration_min: 120, group_max: 12, price_from: 1290, price_unit: "per_person", season: ["summer"] }, { id: "p-4", navn: "Rib 24 AS", brreg_verified: 1 }],
          ["Familiedag", { ...thinRow, min_age: 4, price_band: "gratis", booking_type: "none" }, null],
        ];
        for (const [title, row, provider] of rows) {
          const sentence = pf.buildExperienceFactSentence(title, pf.buildExperienceFacts(row, provider, NO), NO);
          const grounding = JSON.stringify({ title, ...row }) + JSON.stringify(provider ?? {});
          assertTrue(!expDescHasUngroundedNumbers(sentence, grounding), `kf-b13: every number in «${sentence}» is in the row's own fields`);
        }
        assertTrue(expDescHasUngroundedNumbers("Kajakktur. Pris: 991 kr per voksen.", JSON.stringify(fullRow)),
          "kf-b14: control — the same check flags a number the row does not have");
      }

      // ── (c) formatFactDate ─────────────────────────────────────────────────
      {
        const d = pf.formatFactDate("2026-10-16 12:34:56", "no");
        assertTrue(d?.iso === "2026-10-16" && d?.text === "16. oktober 2026", `kf-c1: SQLite datetime → 2026-10-16 / «16. oktober 2026» (got ${JSON.stringify(d)})`);
        assertTrue(pf.formatFactDate("2026-03-01T23:30:00Z", "no")?.text === "1. mars 2026", "kf-c2: ISO input; the date part as written (no TZ shift)");
        assertTrue(pf.formatFactDate("2026-10-16", "en")?.text === "16 October 2026" && pf.formatFactDate("2026-10-16", "sv")?.text === "16 oktober 2026",
          "kf-c3: en and sv month names");
        assertTrue(pf.formatFactDate(null, "no") === null && pf.formatFactDate("", "no") === null
          && pf.formatFactDate("i går", "no") === null && pf.formatFactDate("2026-13-01", "no") === null,
          "kf-c4: missing or unparseable → null (no «Sist oppdatert» line)");
      }

      // ── fixtures for the page ──────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;
      const router = seo.default as any;

      const provId = expStore.createProvider({
        navn: "Lysefjorden Padling AS", org_nr: "912345670",
        fylke: "Rogaland", kommune: "Strand", hjemmeside: "https://padling.example.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const mk = (title: string, fields: Record<string, unknown>): string => {
        const id = expStore.createExperience({
          title, provider_id: provId, provider_match_status: "matched",
          category: "natur_friluft", fylke: "Rogaland", kommune: "Strand",
          confidence: "high", verification_status: "verified", ...fields,
        } as any);
        return (expStore.getExperienceById(id) as any).slug as string;
      };
      const DESCRIPTION = "Guidet kajakktur i Lysefjorden med erfarne guider og alt utstyr inkludert.";
      const JUNK = "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no Facebook-f Instagram Forside Gårdsutsalg Produksjon Meny";
      const describedSlug = mk("Kajakktur i Lysefjorden", { description: DESCRIPTION, price_from: 990, price_unit: "per_adult", duration_min: 120 });
      const adultSlug = mk("Fjordsafari med rib", { price_from: 990, price_unit: "per_adult", duration_min: 90, duration_max: 120, season: ["summer"] });
      const junkSlug = mk("Gårdsbesøk i Strand", { description: JUNK, group_max: 15 });
      const thinSlug = mk("Preikestolen ved soloppgang", {});
      // Two rows whose facts table was captured from the pre-E2-S1 renderer.
      const tableFullSlug = mk("Full rad", {
        indoor_outdoor: "outdoor", season: ["summer", "autumn"], duration_min: 90, duration_max: 120, group_min: 2, group_max: 8,
        price_from: 990, price_unit: "per_adult", languages: ["norsk", "engelsk"], accessibility: ["rullestol"],
        meeting_point: "Kaia i Forsand", min_age: 12, booking_type: "request", description: "Ekte beskrivelse av turen med guide.",
      });
      const tableBandSlug = mk("Band rad", {
        category: "mat_drikke", fylke: "Vestland", kommune: null, indoor_outdoor: "both", duration_min: 60, group_max: 12,
        price_band: "ukjent", description: "Ekte beskrivelse av smakingen.",
      });
      db.prepare("UPDATE experiences SET updated_at = '2026-05-03 10:00:00' WHERE slug = ?").run(describedSlug);

      // 20 pages without a description — varied, some sharing every fact but the title.
      const kommuner: Array<[string, string]> = [["Strand", "Rogaland"], ["Voss", "Vestland"], ["Tromsø", "Troms"], ["Lom", "Innlandet"]];
      const categories = ["natur_friluft", "kultur_historie", "mat_drikke", "dyreliv_safari", "vinter_sno"];
      const placeholderSlugs: string[] = [];
      for (let i = 0; i < 20; i++) {
        const [kommune, fylke] = kommuner[i % kommuner.length];
        placeholderSlugs.push(mk(`Opplevelse nummer ${i + 1}`, {
          category: categories[i % categories.length], kommune, fylke,
          ...(i % 3 === 0 ? { price_from: 200 + i * 50, price_unit: i % 2 ? "per_person" : "per_adult" } : {}),
          ...(i % 4 === 0 ? { duration_min: 60 + i } : {}),
          ...(i % 5 === 0 ? { group_min: 2, group_max: 10 + i } : {}),
        }));
      }
      const allSlugs = [describedSlug, adultSlug, junkSlug, thinSlug, tableFullSlug, tableBandSlug, ...placeholderSlugs];

      // ── (d) the page ───────────────────────────────────────────────────────
      {
        let withBox = 0;
        let boxBeforeLede = 0;
        let labelsAgree = 0;
        for (const slug of allSlugs) {
          const r = await callHtmlRoute(router, `/opplevelse/${slug}`);
          const count = (r.body.match(/<section class="kort-fortalt"/g) || []).length;
          if (r.status === 200 && count === 1) withBox++;
          const box = r.body.indexOf('<section class="kort-fortalt"');
          const lede = r.body.indexOf('<p class="lede');
          const hero = r.body.indexOf('class="hero-');
          if (box > hero && hero > -1 && lede > box) boxBeforeLede++;
          const bp = boxPairs(r.body);
          const tp = tablePairs(r.body);
          const shared = [...bp.keys()].filter((k) => tp.has(k));
          if (shared.length >= 1 && shared.every((k) => bp.get(k) === tp.get(k))) labelsAgree++;
        }
        assertTrue(withBox === allSlugs.length, `kf-d1: 100 % of detail pages have exactly one .kort-fortalt (${withBox}/${allSlugs.length})`);
        assertTrue(boxBeforeLede === allSlugs.length, `kf-d2: the box sits after the hero media and over the lede (${boxBeforeLede}/${allSlugs.length})`);
        assertTrue(labelsAgree === allSlugs.length, `kf-d3: box and facts table show the same label and value for every fact they share (${labelsAgree}/${allSlugs.length})`);
      }
      {
        const r = await callHtmlRoute(router, `/opplevelse/${describedSlug}`);
        const box = kortFortaltSection(r.body);
        assertTrue(box.includes('<h2 id="kf-h">Kort fortalt</h2>') && box.includes('aria-labelledby="kf-h"'), "kf-d4: the box is a labelled section «Kort fortalt»");
        assertTrue(box.includes('Sist oppdatert <time datetime="2026-05-03">3. mai 2026</time>'), "kf-d5: «Sist oppdatert» shows the row's updated_at");
        const bp = boxPairs(r.body);
        assertTrue(bp.get("Pris") === "990 kr per voksen" && bp.get("Varighet") === "ca. 120 min" && bp.get("Sted") === "Strand, Rogaland",
          `kf-d6: the box answers price, length and place (got ${JSON.stringify([...bp])})`);
        assertTrue(bp.get("Tilbyder") === "Lysefjorden Padling AS (Brreg-verifisert)", "kf-d7: the box names the Brreg-verified provider");
        assertTrue(metaDescription(r.body) === DESCRIPTION && ogDescription(r.body) === DESCRIPTION, "kf-d8: a described page keeps its description as meta and og:description");
        const ld = ldBlocks(r.body).find((b) => b["@type"] === "TouristAttraction");
        assertTrue(ld?.description === DESCRIPTION, "kf-d9: … and as JSON-LD description");
        assertTrue(r.body.includes(`<p class="lede">${DESCRIPTION}</p>`), "kf-d10: the lede is unchanged (no new prose next to it)");
      }
      {
        // The facts table moved onto pageFacts with its rows, labels and values
        // byte-identical (HTML captured from the renderer before E2-S1). Age and
        // booking are box-only facts, so they do not appear here.
        const tableOf = (html: string) => /<table class="facts">[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
        const full = tableOf((await callHtmlRoute(router, `/opplevelse/${tableFullSlug}`)).body);
        assertTrue(full === '<table class="facts"><caption class="skip-link">Fakta om opplevelsen</caption><tbody>'
          + '<tr><th scope="row">Kategori</th><td><a href="/kategori/natur_friluft">Natur &amp; friluft</a></td></tr>'
          + '<tr><th scope="row">Fylke</th><td><a href="/fylke/Rogaland">Rogaland</a></td></tr>'
          + '<tr><th scope="row">Kommune</th><td><a href="/kommune/Strand">Strand</a></td></tr>'
          + '<tr><th scope="row">Inne / ute</th><td>Utendørs</td></tr>'
          + '<tr><th scope="row">Sesong</th><td>Sommer, Høst</td></tr>'
          + '<tr><th scope="row">Varighet</th><td>90–120 min</td></tr>'
          + '<tr><th scope="row">Gruppe</th><td>2–8 personer</td></tr>'
          + '<tr><th scope="row">Pris</th><td>990 kr per voksen</td></tr>'
          + '<tr><th scope="row">Språk</th><td>norsk, engelsk</td></tr>'
          + '<tr><th scope="row">Tilgjengelighet</th><td>rullestol</td></tr>'
          + '<tr><th scope="row">Oppmøte</th><td>Kaia i Forsand</td></tr>'
          + '</tbody></table>', `kf-d10b: the full row's facts table is byte-identical to before E2-S1 (got ${full})`);
        const band = tableOf((await callHtmlRoute(router, `/opplevelse/${tableBandSlug}`)).body);
        assertTrue(band === '<table class="facts"><caption class="skip-link">Fakta om opplevelsen</caption><tbody>'
          + '<tr><th scope="row">Kategori</th><td><a href="/kategori/mat_drikke">Mat &amp; drikke</a></td></tr>'
          + '<tr><th scope="row">Fylke</th><td><a href="/fylke/Vestland">Vestland</a></td></tr>'
          + '<tr><th scope="row">Inne / ute</th><td>Inne og ute</td></tr>'
          + '<tr><th scope="row">Varighet</th><td>ca. 60 min</td></tr>'
          + '<tr><th scope="row">Gruppe</th><td>inntil 12 personer</td></tr>'
          + '<tr><th scope="row">Pris</th><td>Pris ikke oppgitt</td></tr>'
          + '</tbody></table>', `kf-d10c: a band-only row's facts table is byte-identical to before E2-S1 (got ${band})`);
        const bp = boxPairs((await callHtmlRoute(router, `/opplevelse/${tableFullSlug}`)).body);
        assertTrue(bp.get("Alder") === "fra 12 år" && bp.get("Bestilling") === "På forespørsel hos tilbyderen",
          "kf-d10d: the box adds the age limit and booking type the table does not show");
      }
      {
        const r = await callHtmlRoute(router, `/opplevelse/${adultSlug}`);
        const meta = metaDescription(r.body);
        // The provider clause would pass 155 chars, so it is left out whole.
        assertTrue(meta === "Fjordsafari med rib – natur & friluft i Strand, Rogaland. Pris: 990 kr per voksen. Varighet: 90–120 min. Sesong: Sommer.",
          `kf-d11: no description → the fact sentence is the meta (got ${JSON.stringify(meta)})`);
        assertTrue(ogDescription(r.body) === meta, "kf-d12: og:description is the same sentence");
        const ld = ldBlocks(r.body).find((b) => b["@type"] === "TouristAttraction");
        assertTrue(ld?.description === meta, "kf-d13: JSON-LD description is the same sentence");
        assertTrue(ld?.name === "Fjordsafari med rib" && ld?.offers?.price === 990, "kf-d14: the rest of the JSON-LD is untouched (E2-S2 owns it)");
        assertTrue(!r.body.includes("fra 990 kr"), "kf-d15: per_adult is never «fra» anywhere on the page");
      }
      {
        const r = await callHtmlRoute(router, `/opplevelse/${junkSlug}`);
        const meta = metaDescription(r.body);
        assertTrue(meta.startsWith("Gårdsbesøk i Strand – natur & friluft i Strand, Rogaland.") && !meta.includes("Skip to content"),
          `kf-d16: a junk description falls back to the fact sentence (got ${JSON.stringify(meta)})`);
        assertTrue(meta.includes("Gruppe: inntil 15 personer."), "kf-d17: … with the row's group limit");
      }
      {
        const r = await callHtmlRoute(router, `/opplevelse/${thinSlug}`);
        const bp = boxPairs(r.body);
        assertTrue(bp.get("Kategori") === "Natur & friluft" && bp.get("Sted") === "Strand, Rogaland" && !bp.has("Pris"),
          "kf-d18: a thin row's box shows only what is set");
        assertTrue(metaDescription(r.body).startsWith("Preikestolen ved soloppgang – natur & friluft i Strand, Rogaland."), "kf-d19: thin row → head of the sentence as meta");
      }
      {
        const metas: string[] = [];
        let grounded = 0;
        for (const slug of placeholderSlugs) {
          const r = await callHtmlRoute(router, `/opplevelse/${slug}`);
          const meta = metaDescription(r.body);
          metas.push(meta);
          const row = db.prepare("SELECT * FROM experiences WHERE slug = ?").get(slug);
          const prov = db.prepare("SELECT * FROM experience_providers WHERE id = ?").get(row.provider_id);
          if (!expDescHasUngroundedNumbers(meta, JSON.stringify(row) + JSON.stringify(prov))) grounded++;
        }
        assertTrue(new Set(metas).size === placeholderSlugs.length, `kf-d20: 20 pages without a description → 20 different metas (got ${new Set(metas).size})`);
        assertTrue(metas.every((m) => !m.includes(OLD_TEMPLATE) && !m.includes("på Opplevagent")), "kf-d21: no meta uses the old shared template");
        assertTrue(grounded === placeholderSlugs.length, `kf-d22: every number in every fallback meta is in the row's own fields (${grounded}/${placeholderSlugs.length})`);
        assertTrue(metas.every((m) => m.length <= 155), "kf-d23: every fallback meta fits 155 chars");
      }

      // ── (e) S1: the per_adult unit follows uiLang, not req.lang ────────────
      {
        const off = await callHtmlRoute(router, `/opplevelse/${adultSlug}`, "en");
        assertTrue(off.body.includes('<html lang="nb">'), "kf-e1: /en with the switcher off is lang=\"nb\"");
        assertTrue(off.body.includes("990 kr per voksen") && !off.body.includes("per adult"), "kf-e2: … and shows «990 kr per voksen», never «per adult»");
        assertTrue(kortFortaltSection(off.body).includes(">Kort fortalt</h2>"), "kf-e3: … with the Norwegian box heading");
        process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
        const on = await callHtmlRoute(router, `/opplevelse/${adultSlug}`, "en");
        assertTrue(on.body.includes('<html lang="en">') && on.body.includes("990 NOK per adult") && !on.body.includes("per voksen"),
          "kf-e4: switcher on → lang=\"en\" and «990 NOK per adult»");
        assertTrue(kortFortaltSection(on.body).includes(">At a glance</h2>"), "kf-e5: … with the English box heading");
        const no = await callHtmlRoute(router, `/opplevelse/${adultSlug}`, "no");
        assertTrue(no.body.includes("990 kr per voksen"), "kf-e6: /no is Norwegian with the switcher on too");
        delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
      }

      // ── (f) S2: one log line per sitemap build ─────────────────────────────
      {
        const lines: string[] = [];
        const origLog = console.log;
        const buildAndCapture = (now?: number): string => {
          console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
          try { return seo.getExperiencesSitemapXml(now); } finally { console.log = origLog; }
        };
        const countDetail = (xml: string) => (xml.match(/<loc>[^<]*\/opplevelse\//g) || []).length;
        seo.__resetExperiencesSitemapCacheForTesting();
        const xml = buildAndCapture();
        const logLines = lines.filter((l) => l.startsWith("[experiences-sitemap] detail"));
        const m = /^\[experiences-sitemap\] detail listed=(\d+) noindex_skipped=(\d+)$/.exec(logLines[0] ?? "");
        assertTrue(logLines.length === 1 && !!m, `kf-f1: one «[experiences-sitemap] detail listed=<n> noindex_skipped=<m>» line per build (got ${JSON.stringify(logLines)})`);
        // Pages without a real description: adult, junk, thin and the 20 placeholders.
        const expectedSkipped = 3 + placeholderSlugs.length;
        assertTrue(!!m && Number(m[1]) === countDetail(xml) && Number(m[1]) === allSlugs.length - expectedSkipped,
          `kf-f2: listed= is the number of /opplevelse/ URLs in the sitemap (log ${m?.[1]}, xml ${countDetail(xml)})`);
        assertTrue(!!m && Number(m[2]) === expectedSkipped, `kf-f3: noindex_skipped= counts the placeholder pages (got ${m?.[2]}, want ${expectedSkipped})`);
        lines.length = 0;
        buildAndCapture();
        assertTrue(!lines.some((l) => l.startsWith("[experiences-sitemap] detail")), "kf-f4: a cached sitemap logs nothing (one line per build, not per request)");
        process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX = "false";
        lines.length = 0;
        const xmlOff = buildAndCapture(Date.now() + 61 * 60_000);
        const off = /listed=(\d+) noindex_skipped=(\d+)/.exec(lines.find((l) => l.startsWith("[experiences-sitemap] detail")) ?? "");
        assertTrue(!!off && Number(off[1]) === allSlugs.length && Number(off[2]) === 0 && countDetail(xmlOff) === allSlugs.length,
          `kf-f5: kill switch off → listed=${allSlugs.length} noindex_skipped=0 (got ${off?.[0]})`);
        delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;
        seo.__resetExperiencesSitemapCacheForTesting();
      }

      // ── (g) S3: description on PublishedSlugRow, no second query ───────────
      {
        const rows = expStore.listPublishedExperienceSlugs();
        const bySlug = new Map(rows.map((r) => [r.slug, r]));
        assertTrue(bySlug.get(describedSlug)?.description === DESCRIPTION && bySlug.get(junkSlug)?.description === JUNK,
          "kf-g1: listPublishedExperienceSlugs() carries each row's raw description");
        assertTrue(bySlug.has(thinSlug) && bySlug.get(thinSlug)?.description === null, "kf-g2: a row without description → description: null");
        const hiddenSlug = mk("Upublisert tur", { description: "Ekte beskrivelse av en upublisert tur.", verification_status: "pending_verify" });
        assertTrue(!expStore.listPublishedExperienceSlugs().some((r) => r.slug === hiddenSlug), "kf-g3: the list (and its descriptions) stays behind the publish gate");
        const ix = require("../services/experience-indexability") as Record<string, unknown>;
        assertTrue(!("experienceDescriptionsBySlug" in ix), "kf-g4: the separate unfiltered description query is gone");
      }

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      if (prevNoindex === undefined) delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX; else process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX = prevNoindex;
      try {
        (require("./experiences-seo") as typeof import("./experiences-seo")).__resetExperiencesSitemapCacheForTesting();
      } catch { /* best-effort */ }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoKortFortaltTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}

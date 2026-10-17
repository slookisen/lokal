/**
 * experiences-seo-fylke-faq.test.ts — dev-request
 * 2026-10-16-opplevagent-stedssider-kvalitet, E4-S2: one place helper gives
 * /kommune/:kommune and /fylke/:fylke their answer-first opening and FAQPage,
 * and every place page shows its FAQ as visible text built from the same Q/A
 * objects as the JSON-LD. Plus the #1101 review follow-ups that live in the
 * same files.
 *
 * Covers:
 *   (a) getPlaceFaqStats({ fylke } | { kommune }): total, categoryCount,
 *       kommuneCount, providerCount and minPriceFrom over the publish gate
 *       (a draft is not counted); an unknown place and a blank name give
 *       zeros, never catalog-wide numbers; getKommuneFaqStats() is a thin
 *       wrapper with the same numbers.
 *   (b) the place builders: buildPlaceFaqJsonLd() and
 *       buildPlaceAnswerFirstOpening() share the ≥2-real-facts gate (both or
 *       neither, one question per fact); counts and prices are the real
 *       ones, singular and plural; a negative price is not a fact, 0 kr is;
 *       a fylke states its kommune spread and a kommune its fylke; the
 *       kommune wrappers return exactly the pre-E4-S2 output for the
 *       pre-E4-S2 inputs (frozen reference copies below).
 *   (c) AC1: for every fylke in listPublishedFylker() that has ≥2 real
 *       facts, /fylke/<x> opens with the answer-first lede (real numbers),
 *       has a FAQPage with ≥2 questions and a visible #faq with the same
 *       text, below the grid and the map; a thin fylke keeps the generic
 *       lede, has no FAQPage and no #faq section, and the fallback is logged.
 *   (d) AC2: on category, kommune and combo pages the visible FAQ text equals
 *       the JSON-LD name/acceptedAnswer.text, in order; pages without
 *       faqVisible (/opplevelser, /sok) get no section and no FAQ CSS;
 *       renderFaqSectionHtml() escapes and renders nothing for no FAQ.
 *   (e) #1101 follow-ups: the produkt×by builders gate on
 *       countProduktByRealFacts(); the combo redirect keeps the language
 *       prefix (localizedPath); listProduktByCombos() skips rows without a
 *       slug like browseWhere() does, so route, sitemap and chips agree; the
 *       /kommune chips read a cached combo list (no query per request, gate
 *       still applied per request, TTL = the sitemap's, keyed to the DB
 *       handle).
 *
 * Run standalone: npx tsx src/routes/experiences-seo-fylke-faq.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type RouteResult = {
  handled: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
  location: string | null;
};

// Same synthetic router.handle() shortcut as experiences-seo-produktby-gate.test.ts,
// with the request language as a parameter.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      ip: "127.0.0.1",
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: "", headers, location: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body), headers, location: null }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "", headers, location: null });
    });
  });
}

type Qa = { q: string; a: string };

/** The FAQPage among a page's JSON-LD blocks, as Q/A pairs; null if none. */
function jsonLdFaq(html: string): Qa[] | null {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const o = JSON.parse(m[1]);
    if (o && o["@type"] === "FAQPage") {
      return (o.mainEntity as any[]).map((e) => ({ q: e.name, a: e.acceptedAnswer.text }));
    }
  }
  return null;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The visible #faq section's Q/A pairs (unescaped); null if no section. */
function visibleFaq(html: string): Qa[] | null {
  const section = html.match(/<section id="faq"[^>]*>([\s\S]*?)<\/section>/);
  if (!section) return null;
  const out: Qa[] = [];
  const re = /<div class="faq-item"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section[1]))) out.push({ q: unescapeHtml(m[1]), a: unescapeHtml(m[2]) });
  return out;
}

function lede(html: string): string | null {
  const m = html.match(/<p class="lede">([\s\S]*?)<\/p>/);
  return m ? unescapeHtml(m[1]) : null;
}

/** "<category>/<kommune>" for every combo page an HTML page links to. */
function linkedCombos(html: string): string[] {
  const out: string[] = [];
  const re = /href="\/kategori\/([^"/]+)\/([^"/]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Frozen reference copies of the pre-E4-S2 kommune builders ────────────────
// Verbatim from experiences-seo.ts at main 8a88a476, so the wrappers can be
// checked against what /kommune rendered before the place helper existed.
function legacyKommuneFaqJsonLd(params: {
  kommune: string; fylke: string | null; url: string; total: number; categoryCount: number; minPriceFrom: number | null;
}): any | null {
  const qas: Array<{ q: string; a: string }> = [];
  if (params.total > 0) {
    qas.push({
      q: `Hvor mange opplevelser finnes i ${params.kommune}?`,
      a: `Det er ${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"} i ${params.kommune}${params.fylke ? ` (${params.fylke})` : ""} på Opplevagent.`,
    });
  }
  if (params.categoryCount > 0) {
    qas.push({
      q: `Hva slags opplevelser kan jeg finne i ${params.kommune}?`,
      a: `Opplevelsene i ${params.kommune} spenner over ${params.categoryCount} ${params.categoryCount === 1 ? "kategori" : "kategorier"} på Opplevagent.`,
    });
  }
  if (params.minPriceFrom !== null && params.minPriceFrom >= 0) {
    qas.push({
      q: `Hva koster en opplevelse i ${params.kommune}?`,
      a: `Prisene i ${params.kommune} starter fra ${params.minPriceFrom} kr — alle tilbydere er verifisert mot Brønnøysundregistrene.`,
    });
  }
  if (qas.length < 2) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${params.url}#faq`,
    "mainEntity": qas.map(({ q, a }) => ({ "@type": "Question", "name": q, "acceptedAnswer": { "@type": "Answer", "text": a } })),
  };
}

function legacyKommuneAnswerFirstOpening(params: {
  kommune: string; fylke: string | null; total: number; categoryCount: number; minPriceFrom: number | null;
}): string | null {
  const hasTotal = params.total > 0;
  const hasCategories = params.categoryCount > 0;
  const hasPrice = params.minPriceFrom !== null && params.minPriceFrom >= 0;
  const factCount = (hasTotal ? 1 : 0) + (hasCategories ? 1 : 0) + (hasPrice ? 1 : 0);
  if (factCount < 2) return null;
  const countPhrase = hasTotal ? `${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"}` : "opplevelser";
  const categoryPhrase = hasCategories ? ` fordelt på ${params.categoryCount} ${params.categoryCount === 1 ? "kategori" : "kategorier"}` : "";
  const pricePhrase = hasPrice ? `, fra ${params.minPriceFrom} kr` : "";
  const fylkePart = params.fylke ? ` (${params.fylke})` : "";
  return `Opplevelser i ${params.kommune}${fylkePart}: ${countPhrase}${categoryPhrase}${pricePhrase} — håndplukket og verifisert mot Brønnøysundregistrene.`;
}

export function runExperiencesSeoFylkeFaqTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  const ENV = "OPPLEVAGENT_COMBO_MIN_EXPERIENCES";

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevThreshold = process.env[ENV];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[ENV];

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = seo.default as any;

      // ── (b) the place builders, pure ───────────────────────────────────────
      {
        // Gate: both builders or neither, one question per real fact.
        let checked = 0;
        let drift = 0;
        let questionMismatch = 0;
        for (const kind of ["kommune", "fylke"] as const) {
          for (const total of [0, 1, 5]) {
            for (const categoryCount of [0, 1, 3]) {
              for (const providerCount of [0, 1, 2]) {
                for (const minPriceFrom of [null, -1, 0, 250]) {
                  const facts = { kind, name: "Vestland", fylke: null, total, categoryCount, kommuneCount: 2, providerCount, minPriceFrom };
                  const factCount = [total > 0, categoryCount > 0, providerCount > 0, minPriceFrom !== null && minPriceFrom >= 0].filter(Boolean).length;
                  const faq = seo.buildPlaceFaqJsonLd({ ...facts, url: "https://opplevagent.no/fylke/Vestland" });
                  const opening = seo.buildPlaceAnswerFirstOpening(facts);
                  checked++;
                  if (factCount >= 2 ? (faq === null || opening === null) : (faq !== null || opening !== null)) drift++;
                  if (faq && faq.mainEntity.length !== factCount) questionMismatch++;
                }
              }
            }
          }
        }
        assertTrue(checked === 216 && drift === 0,
          `pf-b1: FAQPage and answer-first opening exist exactly when ≥2 real facts hold (${checked} combinations, drift in ${drift})`);
        assertTrue(questionMismatch === 0, `pf-b2: one FAQ question per real fact, never padding (mismatch in ${questionMismatch})`);

        const base = { name: "Vestland", fylke: null, total: 0, categoryCount: 0, kommuneCount: 0, providerCount: 0, minPriceFrom: null as number | null };
        assertTrue(seo.buildPlaceFaqJsonLd({ ...base, kind: "fylke", url: "u", total: 9 }) === null
          && seo.buildPlaceAnswerFirstOpening({ ...base, kind: "fylke", total: 9 }) === null,
          "pf-b3: a fylke with only a count (1 fact) gets no FAQ and no answer-first opening");
        assertTrue(seo.buildPlaceFaqJsonLd({ ...base, kind: "fylke", url: "u", total: 9, minPriceFrom: -5 }) === null,
          "pf-b4: a negative price is not a fact (count + price -5 → no FAQ)");
        {
          const faq = seo.buildPlaceFaqJsonLd({ ...base, kind: "fylke", url: "u", total: 9, minPriceFrom: 0 });
          assertTrue(!!faq && faq.mainEntity.length === 2 && faq.mainEntity[1].acceptedAnswer.text.includes("fra 0 kr"),
            "pf-b5: a stated price of 0 kr is a real fact and is stated");
        }

        const vestland = { kind: "fylke" as const, name: "Vestland", fylke: "IGNORED", total: 7, categoryCount: 4, kommuneCount: 2, providerCount: 4, minPriceFrom: 300 };
        const faq = seo.buildPlaceFaqJsonLd({ ...vestland, url: "https://opplevagent.no/fylke/Vestland" });
        assertTrue(!!faq && faq["@type"] === "FAQPage" && faq["@id"] === "https://opplevagent.no/fylke/Vestland#faq",
          "pf-b6: the fylke FAQPage anchors to <canonical>#faq");
        assertTrue(!!faq && same(faq.mainEntity.map((e: any) => [e.name, e.acceptedAnswer.text]), [
          ["Hvor mange opplevelser finnes i Vestland?", "Det er 7 opplevelser i Vestland på Opplevagent, fordelt på 2 kommuner."],
          ["Hva slags opplevelser kan jeg finne i Vestland?", "Opplevelsene i Vestland spenner over 4 kategorier på Opplevagent."],
          ["Hvor mange tilbydere har opplevelser i Vestland?", "Opplevelsene i Vestland kommer fra 4 tilbydere på Opplevagent."],
          ["Hva koster en opplevelse i Vestland?", "Prisene i Vestland starter fra 300 kr — alle tilbydere er verifisert mot Brønnøysundregistrene."],
        ]), `pf-b7: fylke FAQ states the real count with its kommune spread, categories, providers and price (got ${JSON.stringify(faq?.mainEntity)})`);
        assertTrue(seo.buildPlaceAnswerFirstOpening(vestland)
          === "Opplevelser i Vestland: 7 opplevelser i 2 kommuner fordelt på 4 kategorier hos 4 tilbydere, fra 300 kr — håndplukket og verifisert mot Brønnøysundregistrene.",
          `pf-b8: fylke answer-first opening states the real numbers, no parent region (got ${JSON.stringify(seo.buildPlaceAnswerFirstOpening(vestland))})`);

        const one = { kind: "fylke" as const, name: "Troms", total: 1, categoryCount: 1, kommuneCount: 1, providerCount: 1, minPriceFrom: 1200 };
        assertTrue(seo.buildPlaceAnswerFirstOpening(one)
          === "Opplevelser i Troms: 1 opplevelse i 1 kommune fordelt på 1 kategori hos 1 tilbyder, fra 1200 kr — håndplukket og verifisert mot Brønnøysundregistrene.",
          `pf-b9: singular forms (got ${JSON.stringify(seo.buildPlaceAnswerFirstOpening(one))})`);
        {
          const f = seo.buildPlaceFaqJsonLd({ ...one, url: "u" });
          assertTrue(!!f && f.mainEntity[0].acceptedAnswer.text === "Det er 1 opplevelse i Troms på Opplevagent, fordelt på 1 kommune."
            && f.mainEntity[2].acceptedAnswer.text === "Opplevelsene i Troms kommer fra 1 tilbyder på Opplevagent.",
            "pf-b10: singular forms in the FAQ answers");
        }

        const bergen = { kind: "kommune" as const, name: "Bergen", fylke: "Vestland", total: 6, categoryCount: 3, kommuneCount: 1, providerCount: 3, minPriceFrom: 300 };
        assertTrue(seo.buildPlaceAnswerFirstOpening(bergen)
          === "Opplevelser i Bergen (Vestland): 6 opplevelser fordelt på 3 kategorier hos 3 tilbydere, fra 300 kr — håndplukket og verifisert mot Brønnøysundregistrene.",
          `pf-b11: kommune opening names its fylke and never a kommune spread (got ${JSON.stringify(seo.buildPlaceAnswerFirstOpening(bergen))})`);
        {
          const f = seo.buildPlaceFaqJsonLd({ ...bergen, url: "u" });
          assertTrue(!!f && f.mainEntity[0].acceptedAnswer.text === "Det er 6 opplevelser i Bergen (Vestland) på Opplevagent.",
            "pf-b12: kommune count answer names its fylke, no spread clause");
        }

        // The kommune wrappers return exactly what the pre-E4-S2 builders did.
        let wrapperChecked = 0;
        let wrapperDrift = 0;
        for (const fylke of [null, "Møre og Romsdal"]) {
          for (const total of [0, 1, 7]) {
            for (const categoryCount of [0, 1, 2]) {
              for (const minPriceFrom of [null, -1, 0, 199]) {
                const p = { kommune: "Ålesund", fylke, total, categoryCount, minPriceFrom };
                const url = "https://opplevagent.no/kommune/%C3%85lesund";
                wrapperChecked++;
                if (!same(seo.buildKommuneFaqJsonLd({ ...p, url }), legacyKommuneFaqJsonLd({ ...p, url }))) wrapperDrift++;
                if (seo.buildKommuneAnswerFirstOpening(p) !== legacyKommuneAnswerFirstOpening(p)) wrapperDrift++;
              }
            }
          }
        }
        assertTrue(wrapperChecked === 72 && wrapperDrift === 0,
          `pf-b13: buildKommuneFaqJsonLd/buildKommuneAnswerFirstOpening are thin wrappers with the pre-E4-S2 output (${wrapperChecked} inputs, drift in ${wrapperDrift})`);
      }

      // ── (d) renderFaqSectionHtml(), pure ───────────────────────────────────
      {
        assertTrue(seo.renderFaqSectionHtml(null) === "" && seo.renderFaqSectionHtml(undefined) === ""
          && seo.renderFaqSectionHtml({ mainEntity: [] }) === "" && seo.renderFaqSectionHtml({} as any) === "",
          "pf-d1: no FAQPage (or an empty one) renders nothing");
        const html = seo.renderFaqSectionHtml({ mainEntity: [{ name: `Hva er <b>"Mat & drikke"</b>?`, acceptedAnswer: { text: "Svar <script>x</script> 'ok'" } }] });
        assertTrue(html.startsWith('<section id="faq" class="faq" aria-labelledby="faq-title"><h2 id="faq-title">Ofte stilte spørsmål</h2>'),
          "pf-d2: a labelled <section id=\"faq\"> with its heading");
        assertTrue(!html.includes("<b>") && !html.includes("<script>")
          && html.includes("Hva er &lt;b&gt;&quot;Mat &amp; drikke&quot;&lt;/b&gt;?") && html.includes("Svar &lt;script&gt;x&lt;/script&gt; &#39;ok&#39;"),
          "pf-d3: question and answer text are HTML-escaped");
        assertTrue(same(visibleFaq(html), [{ q: `Hva er <b>"Mat & drikke"</b>?`, a: "Svar <script>x</script> 'ok'" }]),
          "pf-d4: the escaped text reads back as the original Q/A");
      }

      // ── fixtures ───────────────────────────────────────────────────────────
      const mkProvider = (navn: string, fylke: string, kommune: string): string =>
        expStore.createProvider({ navn, fylke, kommune, brreg_verified: 1, brreg_active: 1, verification_status: "verified" });
      const mkExp = (o: { title: string; category: string | null; fylke: string; kommune: string; providerId: string | null; price?: number; draft?: boolean; at?: [number, number] }): string => {
        const id = expStore.createExperience({
          title: o.title,
          provider_id: o.providerId,
          provider_match_status: o.providerId ? "matched" : "unmatched",
          category: o.category, fylke: o.fylke, kommune: o.kommune,
          ...(o.price !== undefined ? { price_from: o.price } : {}),
          ...(o.at ? { loc_lat: o.at[0], loc_lon: o.at[1], geo_precision: "address" as const } : {}),
          description: `${o.title} — guidet opplevelse med lokal tilbyder.`,
          confidence: "high", verification_status: o.draft ? "needs_review" : "verified",
        });
        return id;
      };
      const provA = mkProvider("Bergen Fjellguide AS", "Vestland", "Bergen");
      const provB = mkProvider("Fløyen Friluft AS", "Vestland", "Bergen");
      const provC = mkProvider("Bryggen Smak AS", "Vestland", "Bergen");
      const provD = mkProvider("Voss Rafting AS", "Vestland", "Voss");
      const provE = mkProvider("Tromsø Hvalsafari AS", "Troms", "Tromsø");
      const provF = mkProvider("Sandnes Gårdsmat AS", "Rogaland", "Sandnes");
      const provG = mkProvider("Jæren Smak AS", "Rogaland", "Sandnes");
      // Vestland: Bergen 6 (natur 2, mat 3, kultur 1; providers A, B, C; prices 450/300) + Voss 1 (D, 900).
      mkExp({ title: "Ulriken på tvers", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provA, at: [60.377, 5.387] });
      mkExp({ title: "Fløyen ved solnedgang", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provB });
      mkExp({ title: "Fiskemarkedet smakstur", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provC, price: 450 });
      mkExp({ title: "Bryggen ølsmaking", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provC, price: 300 });
      mkExp({ title: "Lokal matkurs i Bergen", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provC });
      mkExp({ title: "Byvandring på Bryggen", category: "kultur_historie", fylke: "Vestland", kommune: "Bergen", providerId: provA });
      mkExp({ title: "Elverafting på Voss", category: "adrenalin_action", fylke: "Vestland", kommune: "Voss", providerId: provD, price: 900 });
      // A draft with a lower price: never counted, never the minimum.
      mkExp({ title: "Utkast billig tur", category: "velvaere_spa", fylke: "Vestland", kommune: "Bergen", providerId: provB, price: 10, draft: true });
      // Troms: one experience, every fact present.
      mkExp({ title: "Hvalsafari fra Tromsø", category: "dyreliv_safari", fylke: "Troms", kommune: "Tromsø", providerId: provE, price: 1200 });
      // Nordland: one experience without category, provider or price — 1 fact.
      mkExp({ title: "Ukjent tur i Bodø", category: null, fylke: "Nordland", kommune: "Bodø", providerId: null });
      // Rogaland: Sandnes mat_drikke 2 (F, G) — used by the slug-parity check.
      mkExp({ title: "Gårdsmat i Sandnes", category: "mat_drikke", fylke: "Rogaland", kommune: "Sandnes", providerId: provF });
      const sandnesSecond = mkExp({ title: "Jærsk smaksrunde", category: "mat_drikke", fylke: "Rogaland", kommune: "Sandnes", providerId: provG });

      // ── (a) getPlaceFaqStats() ─────────────────────────────────────────────
      {
        const v = expStore.getPlaceFaqStats({ fylke: "Vestland" });
        assertTrue(same(v, { total: 7, categoryCount: 4, kommuneCount: 2, providerCount: 4, minPriceFrom: 300 }),
          `pf-a1: Vestland: 7 experiences, 4 categories, 2 kommuner, 4 providers, from 300 kr; the draft (10 kr) is not counted (got ${JSON.stringify(v)})`);
        const b = expStore.getPlaceFaqStats({ kommune: "Bergen" });
        assertTrue(same(b, { total: 6, categoryCount: 3, kommuneCount: 1, providerCount: 3, minPriceFrom: 300 }),
          `pf-a2: Bergen: 6 experiences, 3 categories, 3 providers, from 300 kr (got ${JSON.stringify(b)})`);
        const n = expStore.getPlaceFaqStats({ fylke: "Nordland" });
        assertTrue(same(n, { total: 1, categoryCount: 0, kommuneCount: 1, providerCount: 0, minPriceFrom: null }),
          `pf-a3: Nordland: a null category, no provider and no price are not counted (got ${JSON.stringify(n)})`);
        const zero = { total: 0, categoryCount: 0, kommuneCount: 0, providerCount: 0, minPriceFrom: null };
        assertTrue(same(expStore.getPlaceFaqStats({ fylke: "Atlantis" }), zero) && same(expStore.getPlaceFaqStats({ kommune: "Nowhereville" }), zero),
          "pf-a4: an unknown fylke or kommune gives zeros");
        assertTrue(same(expStore.getPlaceFaqStats({ fylke: "" }), zero) && same(expStore.getPlaceFaqStats({ kommune: "" }), zero),
          "pf-a5: a blank place name gives zeros, never catalog-wide numbers");
        let totalsMatch = true;
        for (const f of expStore.listPublishedFylker()) {
          if (expStore.getPlaceFaqStats({ fylke: f.fylke }).total !== expStore.countPublishedExperiences({ fylke: f.fylke })) totalsMatch = false;
        }
        assertTrue(totalsMatch, "pf-a6: each fylke's total equals what its page lists (countPublishedExperiences)");
        assertTrue(same(expStore.getKommuneFaqStats("Bergen"), { categoryCount: 3, minPriceFrom: 300 }),
          "pf-a7: getKommuneFaqStats() is a thin wrapper with the same numbers");
      }

      // ── (c) AC1: every fylke page ──────────────────────────────────────────
      {
        const fylker = expStore.listPublishedFylker().map((f) => f.fylke).sort();
        assertTrue(same(fylker, ["Nordland", "Rogaland", "Troms", "Vestland"]), `pf-c0: the fixture has 4 published fylker (got ${JSON.stringify(fylker)})`);
        for (const fylke of fylker) {
          const stats = expStore.getPlaceFaqStats({ fylke });
          const factCount = [stats.total > 0, stats.categoryCount > 0, stats.providerCount > 0, stats.minPriceFrom !== null && stats.minPriceFrom >= 0].filter(Boolean).length;
          if (factCount < 2) continue; // the thin fylke has its own checks below
          const r = await callHtmlRoute(router, `/fylke/${encodeURIComponent(fylke)}`);
          const expectedLede = seo.buildPlaceAnswerFirstOpening({ kind: "fylke", name: fylke, ...stats });
          const l = lede(r.body);
          assertTrue(r.status === 200 && !!expectedLede && l === expectedLede && l.includes(`${stats.total} opplevelse`),
            `pf-c1 (AC1): /fylke/${fylke} opens with the answer-first lede and the real count (got ${JSON.stringify(l)})`);
          const ld = jsonLdFaq(r.body);
          assertTrue(!!ld && ld.length >= 2, `pf-c2 (AC1): /fylke/${fylke} has a FAQPage with ≥2 questions (got ${ld ? ld.length : "none"})`);
          const vis = visibleFaq(r.body);
          assertTrue(!!vis && !!ld && same(vis, ld), `pf-c3 (AC1): /fylke/${fylke} shows the same Q/A text as its JSON-LD, in order`);
          assertTrue(r.body.includes(`"@id":"https://opplevagent.no/fylke/${encodeURIComponent(fylke)}#faq"`) && (r.body.match(/id="faq"/g) || []).length === 1,
            `pf-c4: /fylke/${fylke}'s FAQPage @id points at the one <section id="faq">`);
          const iGrid = r.body.indexOf('<div class="grid"');
          const iMap = r.body.indexOf('class="fylke-map');
          const iFaq = r.body.indexOf('<section id="faq"');
          const iMainEnd = r.body.indexOf("</main>");
          assertTrue(iGrid > 0 && iFaq > iGrid && (iMap < 0 || iFaq > iMap) && iFaq < iMainEnd,
            `pf-c5: /fylke/${fylke}'s FAQ sits below the grid${iMap > 0 ? " and the map" : ""}, inside <main>`);
          assertTrue(r.body.includes("<style>\n  .faq{"), `pf-c6: /fylke/${fylke} carries the FAQ styles`);
        }

        const vest = await callHtmlRoute(router, "/fylke/Vestland");
        assertTrue(lede(vest.body) === "Opplevelser i Vestland: 7 opplevelser i 2 kommuner fordelt på 4 kategorier hos 4 tilbydere, fra 300 kr — håndplukket og verifisert mot Brønnøysundregistrene.",
          `pf-c7: /fylke/Vestland's lede has the fixture's real numbers (got ${JSON.stringify(lede(vest.body))})`);
        assertTrue(vest.body.includes('class="fylke-map'), "pf-c8: the fylke map section is still rendered (FAQ does not replace it)");

        // The thin fylke: generic lede, no FAQ anywhere, and the fallback is logged.
        const logged: string[] = [];
        const origLog = console.log;
        console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
        let nord: RouteResult;
        try {
          nord = await callHtmlRoute(router, "/fylke/Nordland");
        } finally {
          console.log = origLog;
        }
        assertTrue(nord.status === 200 && lede(nord.body) === "Hva kan du finne på i Nordland? Håndplukket oversikt over opplevelser i fylket.",
          `pf-c9: a fylke with 1 real fact keeps the generic lede (got ${JSON.stringify(lede(nord.body))})`);
        assertTrue(jsonLdFaq(nord.body) === null && !nord.body.includes('id="faq"') && !nord.body.includes(".faq{"),
          "pf-c10: … and has no FAQPage, no #faq section and no FAQ styles");
        assertTrue(logged.includes("[experiences-seo] /fylke/Nordland: answer-first opening skipped (insufficient real facts) — falling back to generic lede"),
          `pf-c11: the fallback is logged, not swallowed (logged ${JSON.stringify(logged)})`);
      }

      // ── (d) AC2: category, kommune and combo pages ─────────────────────────
      {
        const pages = ["/kategori/mat_drikke", "/kommune/Bergen", "/kategori/mat_drikke/Bergen"];
        for (const url of pages) {
          const r = await callHtmlRoute(router, url);
          const ld = jsonLdFaq(r.body);
          const vis = visibleFaq(r.body);
          assertTrue(r.status === 200 && !!ld && ld.length >= 2, `pf-d5: ${url} answers 200 with a FAQPage (got ${r.status}, ${ld ? ld.length : "no"} questions)`);
          assertTrue(!!vis && !!ld && same(vis, ld),
            `pf-d6 (AC2): ${url} shows exactly its JSON-LD name/acceptedAnswer.text as visible text, in order (visible ${JSON.stringify(vis)})`);
          assertTrue(r.body.indexOf('<section id="faq"') > r.body.indexOf('<div class="grid"') && (r.body.match(/id="faq"/g) || []).length === 1,
            `pf-d7: ${url} has one #faq section, below the grid`);
        }
        // "Mat & drikke" is escaped on the page and raw in the JSON-LD.
        const cat = await callHtmlRoute(router, "/kategori/mat_drikke");
        assertTrue(cat.body.includes("<h3>Hvor mange opplevelser finnes i kategorien Mat &amp; drikke?</h3>"),
          "pf-d8: a category label with & is escaped in the visible question");

        const kommune = await callHtmlRoute(router, "/kommune/Bergen");
        assertTrue(lede(kommune.body) === "Opplevelser i Bergen (Vestland): 6 opplevelser fordelt på 3 kategorier hos 3 tilbydere, fra 300 kr — håndplukket og verifisert mot Brønnøysundregistrene.",
          `pf-d9: /kommune/Bergen's lede comes from the same place helper, now with its providers (got ${JSON.stringify(lede(kommune.body))})`);
        const kq = (jsonLdFaq(kommune.body) || []).map((x) => x.q);
        assertTrue(same(kq, [
          "Hvor mange opplevelser finnes i Bergen?",
          "Hva slags opplevelser kan jeg finne i Bergen?",
          "Hvor mange tilbydere har opplevelser i Bergen?",
          "Hva koster en opplevelse i Bergen?",
        ]), `pf-d10: /kommune/Bergen's FAQ has the count, category, provider and price questions (got ${JSON.stringify(kq)})`);

        const combo = visibleFaq((await callHtmlRoute(router, "/kategori/mat_drikke/Bergen")).body) || [];
        assertTrue(combo.some((x) => x.a.startsWith("1 verifisert tilbyder av mat & drikke i Bergen")),
          "pf-d12: the combo FAQ uses the singular for one provider (\"1 verifisert tilbyder\"), now that it is visible");

        for (const url of ["/opplevelser", "/sok?q=tur"]) {
          const r = await callHtmlRoute(router, url);
          assertTrue(r.status === 200 && !r.body.includes('id="faq"') && !r.body.includes(".faq{"),
            `pf-d11: ${url} does not opt in → no #faq section and no FAQ styles`);
        }
      }

      // ── (e) #1101 follow-ups ───────────────────────────────────────────────
      {
        const fs = require("fs") as typeof import("fs");
        const path = require("path") as typeof import("path");
        const src = fs.readFileSync(path.join(__dirname, "experiences-seo.ts"), "utf8");
        const body = (name: string): string => {
          const start = src.indexOf(`export function ${name}(`);
          return start < 0 ? "" : src.slice(start, src.indexOf("\n}\n", start));
        };
        for (const name of ["buildProduktByFaqJsonLd", "buildProduktByAnswerFirstOpening"]) {
          const b = body(name);
          assertTrue(b.includes("countProduktByRealFacts(params) < 2") && !b.includes("factCount") && !b.includes("qas.length < 2"),
            `pf-e1 (S3): ${name} gates on countProduktByRealFacts(), not its own fact count`);
        }

        // S2: the combo redirect keeps the language prefix.
        const thinNo = await callHtmlRoute(router, "/kategori/dyreliv_safari/Troms%C3%B8", "no");
        const thinEn = await callHtmlRoute(router, "/kategori/dyreliv_safari/Troms%C3%B8", "en");
        assertTrue(thinNo.status === 301 && thinNo.location === "/kommune/Troms%C3%B8",
          `pf-e2 (S2): a Norwegian request below the gate → 301 /kommune/Troms%C3%B8 (got ${thinNo.status} ${thinNo.location})`);
        assertTrue(thinEn.status === 301 && thinEn.location === "/en/kommune/Troms%C3%B8",
          `pf-e3 (S2): an /en request below the gate → 301 /en/kommune/Troms%C3%B8 (got ${thinEn.status} ${thinEn.location})`);

        // S4: a published row without a slug is in neither the listing nor the combo list.
        const sandnesBefore = expStore.listProduktByCombos().find((c) => c.category === "mat_drikke" && c.kommune === "Sandnes");
        assertTrue(!!sandnesBefore && sandnesBefore.total === 2, "pf-e4: before: Sandnes mat_drikke has 2 slugged experiences");
        dbFactory.getDb("experiences").prepare("UPDATE experiences SET slug = NULL WHERE id = ?").run(sandnesSecond);
        const sandnesAfter = expStore.listProduktByCombos().find((c) => c.category === "mat_drikke" && c.kommune === "Sandnes");
        const routeStats = expStore.getProduktByStats("mat_drikke", "Sandnes");
        assertTrue(!!sandnesAfter && sandnesAfter.total === 1 && sandnesAfter.providerCount === 1
          && sandnesAfter.total === routeStats.total && sandnesAfter.providerCount === routeStats.providerCount,
          `pf-e5 (S4): listProduktByCombos() skips the slugless row, like getProduktByStats()/browseWhere() (combo ${JSON.stringify(sandnesAfter)}, route ${JSON.stringify(routeStats)})`);
        seo.__resetExperiencesSitemapCacheForTesting();
        const sm = await callHtmlRoute(router, "/sitemap.xml");
        const sandnesRoute = await callHtmlRoute(router, "/kategori/mat_drikke/Sandnes");
        assertTrue(!sm.body.includes("/kategori/mat_drikke/Sandnes<") && sandnesRoute.status === 301,
          `pf-e6 (S4): the sitemap no longer lists a cell the route redirects (route ${sandnesRoute.status})`);

        // S1: the /kommune chips read a cached combo list.
        seo.__resetProduktByCombosCacheForTesting();
        const chipsBefore = linkedCombos((await callHtmlRoute(router, "/kommune/Bergen")).body).sort();
        assertTrue(same(chipsBefore, ["mat_drikke/Bergen", "natur_friluft/Bergen"]), `pf-e7: /kommune/Bergen links its 2 passing cells (got ${JSON.stringify(chipsBefore)})`);
        // A second kultur_historie experience lifts that cell over the gate.
        mkExp({ title: "Hanseatisk museum omvisning", category: "kultur_historie", fylke: "Vestland", kommune: "Bergen", providerId: provB });
        const chipsCached = linkedCombos((await callHtmlRoute(router, "/kommune/Bergen")).body).sort();
        assertTrue(same(chipsCached, chipsBefore), "pf-e8 (S1): within the TTL a /kommune request does not re-run the combo query (the new cell is not linked yet)");
        const cachedRows = seo.getCachedProduktByCombos();
        assertTrue(cachedRows === seo.getCachedProduktByCombos(Date.now() + 1000), "pf-e9: the cached list is reused inside the TTL");
        process.env[ENV] = "3";
        const chipsAt3 = linkedCombos((await callHtmlRoute(router, "/kommune/Bergen")).body).sort();
        delete process.env[ENV];
        assertTrue(same(chipsAt3, ["mat_drikke/Bergen"]), `pf-e10: the gate is still applied per request on the cached rows (threshold 3 → ${JSON.stringify(chipsAt3)})`);
        const { resolveSitemapCacheTtlMs } = require("./sitemap-cache-util") as typeof import("./sitemap-cache-util");
        const fresh = seo.getCachedProduktByCombos(Date.now() + resolveSitemapCacheTtlMs() + 1);
        assertTrue(fresh !== cachedRows && fresh.some((c) => c.category === "kultur_historie" && c.kommune === "Bergen" && c.total === 2),
          "pf-e11: after the sitemap TTL the list is read again and has the new cell");
        seo.__resetProduktByCombosCacheForTesting();
        const chipsAfter = linkedCombos((await callHtmlRoute(router, "/kommune/Bergen")).body).sort();
        assertTrue(same(chipsAfter, ["kultur_historie/Bergen", "mat_drikke/Bergen", "natur_friluft/Bergen"]),
          `pf-e12: a fresh read links the new cell (got ${JSON.stringify(chipsAfter)})`);
        const kulturRoute = await callHtmlRoute(router, "/kategori/kultur_historie/Bergen");
        assertTrue(kulturRoute.status === 200, `pf-e13: and the newly linked cell answers 200 (got ${kulturRoute.status})`);

        // The cache belongs to its DB handle: a reopened (empty) DB never sees the old rows.
        assertTrue(seo.getCachedProduktByCombos().length > 0, "pf-e14: the cache holds the fixture's combos");
        dbFactory.__resetDbFactoryForTesting();
        dbFactory.getDb("experiences");
        assertTrue(seo.getCachedProduktByCombos().length === 0, "pf-e15: after the DB is reopened the cache re-reads (empty DB → no combos)");
      }

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevThreshold === undefined) delete process.env[ENV]; else process.env[ENV] = prevThreshold;
      try {
        const seoMod = require("./experiences-seo") as typeof import("./experiences-seo");
        seoMod.__resetExperiencesSitemapCacheForTesting();
        seoMod.__resetProduktByCombosCacheForTesting();
      } catch { /* best-effort */ }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoFylkeFaqTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}

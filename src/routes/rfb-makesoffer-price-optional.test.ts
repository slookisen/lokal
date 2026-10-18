/**
 * rfb-makesoffer-price-optional.test.ts — dev-request
 * 2026-09-24-ai-sok-bli-svaret-rfb, slice B1 (Daniel-GO 2026-09-24, see
 * daniel-responses/2026-09-24-go-chatgpt-claude-spor-a-b-c.md in the A2A repo).
 *
 * Covers `src/routes/seo.ts`'s `GET /produsent/:slug` JSON-LD builder for
 * `jsonLd.makesOffer`. Contract as of dev-request
 * 2026-09-29-gsc-strukturerte-data-og-5xx (supersedes B1: Google rejects
 * Offers without price): only products with a valid numeric price > 0 become
 * Offer/Product; unpriced ones go to a name-only hasOfferCatalog; makesOffer
 * is omitted (never []) when nothing is priced. Also unit-tests parseNokPrice,
 * buildBmEventJsonLd and the permanent "no Offer without price" invariant
 * (offersWithoutPrice, now in tests/helpers/jsonld-invariants.ts). Since
 * dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
 * (S1) the inner Offer carries no return/shipping terms. Since S6 del A of the
 * same dev-request a price comes from the product NAME only when "kr" names
 * it, and the name is cut only then (splitNamePrice; unit tests (d), live
 * names on the NO and EN page (e)). Since S6 del B a priced product is an
 * Offer from the farm with exactly @type, name, price and priceCurrency, and
 * the page has no Product node (productNodes); (e) also renders the same
 * fixtures in rollback mode (PRODUCER_PAGE_PRODUCT_NODES true), where the
 * Product form comes back with the same names and prices, and the HTML
 * outside the ld+json blocks is byte-identical in both modes (SQL RANDOM()
 * is a constant in this suite's DB).
 *
 * Same synthetic router.handle()-less harness as
 * rfb-trust-score-public-display-removed.test.ts (own `Database(":memory:")`,
 * `__setDbForTesting`/`__initSchemaForTesting`, the real `seo.ts` router's
 * `/produsent/:slug` handler pulled directly off the route stack — no HTTP
 * server, no port). Products are seeded via `agent_knowledge.products`, a
 * JSON array column (see `knowledgeService.getAgentInfo`/`getKnowledge`),
 * following the same `INSERT INTO agent_knowledge (... products ...)`
 * convention as homepage-content-refresh-parking.test.ts.
 *
 * The JSON-LD payload is extracted from the rendered HTML by picking out
 * the `<script type="application/ld+json">` block(s) and parsing whichever
 * one carries `makesOffer` — robust to whether the FAQ block is also present
 * as a sibling script tag (this page renders either a single jsonLd object,
 * or `[jsonLd, faqJsonLd]`, depending on unrelated FAQ data).
 *
 * Exported runMakesOfferPriceOptionalTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/rfb-makesoffer-price-optional.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMakesOfferPriceOptionalTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

import Database from "better-sqlite3";
import { jsonLdBlocks, offersWithoutPrice, forbiddenNodes, productNodes } from "../../tests/helpers/jsonld-invariants";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runMakesOfferPriceOptionalTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertSame(got: unknown, want: unknown, label: string): void {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    assertTrue(g === w, g === w ? label : `${label} — got ${g}, want ${w}`);
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const policy = require("../services/structured-data-policy") as typeof import("../services/structured-data-policy");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  // (e) compares two renders of a page byte for byte. Related producers
  // (seo.ts getRelatedBySameCity/getRelatedBySameCategory) break ties with SQL
  // RANDOM(), so it is a constant in this suite's own DB.
  testDb.function("random", () => 0);

  function seedAgent(row: { id: string; name: string; city?: string | null; lat?: number | null; lng?: number | null }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
        0.5, 1, 0, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, row.city ?? null, row.lat ?? null, row.lng ?? null,
    );
  }

  function seedProducts(agentId: string, products: unknown[]): void {
    testDb.prepare(
      `INSERT INTO agent_knowledge (agent_id, products) VALUES (?, ?)`,
    ).run(agentId, JSON.stringify(products));
  }

  function resetRegistryCache(): void {
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }

    const seoRoutePath = require.resolve("./seo");
    delete require.cache[seoRoutePath];
    const seoRouter = require("./seo").default as any;

    function findLayer(routePath: string) {
      return (seoRouter.stack as any[]).find(
        (l: any) => l.route && l.route.path === routePath && l.route.methods?.get,
      );
    }
    function invoke(routePath: string, req: any): { status: number; body: string } {
      const layer = findLayer(routePath);
      assertTrue(!!layer, `setup: GET ${routePath} layer is registered`);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: (_c: number, _l: string) => { status = 301; return res; },
      };
      handler(req, res, (_e?: unknown) => {});
      return { status, body };
    }

    /** Extracts every JSON-LD <script> block on the page and returns whichever parsed object/array-member carries `makesOffer`. */
    function extractMakesOfferJsonLd(body: string): any {
      const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      for (const b of blocks) {
        let parsed: any;
        try { parsed = JSON.parse(b[1]); } catch { continue; }
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of candidates) {
          if (c && Array.isArray(c.makesOffer)) return c;
        }
      }
      return null;
    }

    /** The page with each ld+json block replaced by a marker: the HTML outside the JSON-LD, block positions included. */
    const outsideJsonLd = (body: string): string =>
      body.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "<!--ld+json-->");
    /** null when a === b, else the first differing offset with the text around it on both sides. */
    function firstDiff(a: string, b: string): string | null {
      if (a === b) return null;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      const around = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
      return `offset ${i} of ${a.length}/${b.length}: ${around(a)} vs ${around(b)}`;
    }

    // ══════════════════════════════════════════════════════════════
    // (a) Clean numeric price -> one priced Offer (regression guard for the
    // existing path). dev-request
    // 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
    // (S6 del B): an Offer from the farm, exactly name, price and currency,
    // no Product (policy rule 7). The Product form is the rollback mode.
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "priced-gard", name: "Priset Gaard", city: "Oslo", lat: 59.91, lng: 10.75 });
      seedProducts("priced-gard", [{ name: "Lammelår", price: "275" }]);
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "priset-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "priced: renders 200");
      const ld = extractMakesOfferJsonLd(r.body);
      assertTrue(!!ld, "priced: a JSON-LD block with makesOffer is present");
      assertSame(ld?.makesOffer, [{ "@type": "Offer", "name": "Lammelår", "price": 275, "priceCurrency": "NOK" }],
        "priced: makesOffer is exactly one Offer {@type, name, price, priceCurrency} (no Product, availability, seller or brand)");
      const blocks = jsonLdBlocks(r.body);
      assertSame(productNodes(blocks), [], "priced: productNodes is [] (no Product node anywhere)");
      assertSame(offersWithoutPrice(blocks), 0, "priced: offersWithoutPrice is 0");
      assertSame(forbiddenNodes(blocks), [], "priced: no forbidden rating/review/return/shipping node anywhere");

      // Rollback mode: the Product form as before S6 del B.
      let rb: { status: number; body: string } = { status: 0, body: "" };
      try {
        policy.__setProducerPageProductNodesForTesting(true);
        rb = invoke("/produsent/:slug", { params: { slug: "priset-gaard" }, lang: "no", ip: "127.0.0.1" });
      } finally {
        policy.__setProducerPageProductNodesForTesting(null);
      }
      assertTrue(rb.status === 200, "priced rollback: renders 200");
      const rbLd = extractMakesOfferJsonLd(rb.body);
      assertTrue(!!rbLd && rbLd.makesOffer.length === 1, "priced rollback: makesOffer has exactly one entry");
      const offer = rbLd?.makesOffer?.[0] || {};
      const inner = offer.itemOffered?.offers || {};

      assertTrue(offer["@type"] === "Offer", "priced rollback: outer @type is Offer");
      assertTrue(offer.price === 275, "priced rollback: outer price is the parsed numeric value (275)");
      assertTrue(offer.priceCurrency === "NOK", "priced rollback: outer priceCurrency is NOK");
      assertTrue(offer.availability === "https://schema.org/InStock", "priced rollback: outer availability is InStock");

      assertTrue(offer.itemOffered?.["@type"] === "Product", "priced rollback: itemOffered @type is Product");
      assertTrue(offer.itemOffered?.name === "Lammelår", "priced rollback: itemOffered.name is unchanged");
      assertTrue(inner["@type"] === "Offer", "priced rollback: inner offers @type is Offer");
      assertTrue(inner.price === 275, "priced rollback: inner offers.price is the parsed numeric value (275)");
      assertTrue(inner.priceCurrency === "NOK", "priced rollback: inner offers.priceCurrency is NOK");
      assertTrue(inner.availability === "https://schema.org/InStock", "priced rollback: inner offers.availability is InStock");
      assertTrue(inner.seller && inner.seller["@type"] === "LocalBusiness", "priced rollback: inner offers.seller is still present");
      // dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
      // (S1): WO-17's fixed return/shipping terms are gone (no per-producer policy).
      assertTrue(!("hasMerchantReturnPolicy" in inner), "priced rollback: inner offers has no hasMerchantReturnPolicy");
      assertTrue(!("shippingDetails" in inner), "priced rollback: inner offers has no shippingDetails");
      assertTrue(forbiddenNodes(jsonLdBlocks(rb.body)).length === 0, "priced rollback: no forbidden rating/review/return/shipping node anywhere");
    }

    // Permanent invariant (dev-request 2026-09-29-gsc-strukturerte-data-og-5xx):
    // offersWithoutPrice now lives in tests/helpers/jsonld-invariants.ts so the
    // other sites' page tests can run the same walk (Opplevagent in S5).
    const allJsonLd = (body: string): any[] => jsonLdBlocks(body) as any[];
    function mainLd(body: string): any {
      for (const p of allJsonLd(body)) for (const c of (Array.isArray(p) ? p : [p])) if (c && c["@type"] && c.name) return c;
      return null;
    }

    // (a2) invariant on the priced page
    {
      const r = invoke("/produsent/:slug", { params: { slug: "priset-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(offersWithoutPrice(allJsonLd(r.body)) === 0, "invariant: priced page has no Offer without price > 0");
    }

    // (b) Unpriced only -> no makesOffer at all (never []), name-only OfferCatalog, no Offer.
    {
      seedAgent({ id: "unpriced-gard", name: "Uprist Gaard", city: "Bergen", lat: 60.39, lng: 5.32 });
      seedProducts("unpriced-gard", [{ name: "Ost <b>" }, { name: "Egg", price: "på forespørsel" }, { name: "Honning", price: "0" }]);
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "uprist-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "unpriced: renders 200");
      const ld = mainLd(r.body);
      assertTrue(!!ld, "unpriced: main JSON-LD present");
      assertTrue(!("makesOffer" in ld), "unpriced: makesOffer omitted entirely (no [])");
      assertTrue(ld.hasOfferCatalog && ld.hasOfferCatalog["@type"] === "OfferCatalog", "unpriced: OfferCatalog present");
      const items = ld.hasOfferCatalog.itemListElement;
      assertTrue(items.length === 3 && items.every((i: any) => i["@type"] === "Thing" && i.name && !("price" in i) && !("offers" in i)),
        "unpriced: catalog holds name-only Things");
      assertTrue(!/"@type":"(Offer|Product)"/.test(r.body.replace(/\s/g, "")), "unpriced: no Offer/Product at all in page JSON-LD");
      assertTrue([...r.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].every(b => !b[1].includes("<")),
        "unpriced: JSON-LD payload contains no raw '<' (escaped as \\u003c)");
      assertTrue(offersWithoutPrice(allJsonLd(r.body)) === 0, "invariant: unpriced page has no Offer without price");
    }

    // (c) Mixed -> only priced in makesOffer; unpriced in catalog.
    {
      seedAgent({ id: "mixed-gard", name: "Blandet Gaard", city: "Trondheim", lat: 63.43, lng: 10.39 });
      seedProducts("mixed-gard", [
        { name: "Lammelår", price: "275" },
        { name: "Ost" },
        { name: "Skinke", price: "kr 150–200/kg" },
        { name: "Pølse – kr 1.200,50" },
      ]);
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "blandet-gaard" }, lang: "no", ip: "127.0.0.1" });
      const ld = mainLd(r.body);
      assertTrue(Array.isArray(ld.makesOffer) && ld.makesOffer.length === 2, "mixed: only the two validly priced products in makesOffer");
      // S6 del B: the Offer names the product itself (no itemOffered).
      const names = ld.makesOffer.map((o: any) => o.name);
      assertTrue(names.includes("Lammelår") && names.includes("Pølse"), "mixed: priced names present");
      const pol = ld.makesOffer.find((o: any) => o.name === "Pølse");
      assertTrue(pol?.price === 1200.5, "mixed: Norwegian 1.200,50 parsed as 1200.5");
      const cat = ld.hasOfferCatalog.itemListElement.map((i: any) => i.name);
      assertTrue(cat.length === 2 && cat.includes("Ost") && cat.includes("Skinke"), "mixed: Ost + range-priced Skinke go to the catalog");
      assertTrue(offersWithoutPrice(allJsonLd(r.body)) === 0, "invariant: mixed page has no Offer without price");
    }

    // ══════════════════════════════════════════════════════════════
    // (d) dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
    // (S6 del A): splitNamePrice. A price comes from the name only when "kr"
    // names it, and the name is cut only then. Live 2026-10-17 the old rule
    // (any dash before a digit) gave Product «Sesonggrønnsaker (40» at 50
    // (Avdem), three «Gardsmjølk» at 1, 2 and 3 kr (Ødhumbla), «Pøyg (lagret
    // ost, 3» at 6 (ryfylke-gardsysteri), cut Things («Tørrfisk, original
    // filet 2», «Fenalår (spekebein lam), 1,5») and unclosed Bjerkelund names.
    // ══════════════════════════════════════════════════════════════
    const { splitNamePrice, productLabel, parseNokPrice: parsePrice } = require("./seo") as typeof import("./seo");
    const balanced = (s: string): boolean => {
      let depth = 0;
      for (const ch of s) {
        if (ch === "(") depth++;
        else if (ch === ")" && --depth < 0) return false;
      }
      return depth === 0;
    };
    {
      // [name, JSON-LD name on the NO page, price]: a "kr" price the name shows.
      const NAME_PRICED: Array<[string, string, number]> = [
        // Bjerkelund ×5: the price sits inside the parenthesis, so the cut closes it.
        ["Selvplukk bringebær (kasse 3,6 kg - kr 600)", "Selvplukk bringebær (kasse 3,6 kg)", 600],
        ["Selvplukk bringebær (kurv 300g - kr 50)", "Selvplukk bringebær (kurv 300g)", 50],
        ["Ferdigplukka bringebær (kurv 300g - kr 60)", "Ferdigplukka bringebær (kurv 300g)", 60],
        ["Ferdigplukka bringebær (kasse 3,6 kg - kr 700)", "Ferdigplukka bringebær (kasse 3,6 kg)", 700],
        ["Frosne bringebær (kasse 3,6 kg - kr 600)", "Frosne bringebær (kasse 3,6 kg)", 600],
        // A closing parenthesis anywhere in the price part, not only at its end.
        ["Egg (6 stk – kr 40) økologisk", "Egg (6 stk)", 40],
        // True prices knowledge-service's stricter parseProductPrice would lose.
        ["Lammelår – kr 275/kg", "Lammelår", 275],
        ["Pølse – kr 1.200,50", "Pølse", 1200.5],
        ["Honning - kr. 150", "Honning", 150],
        ["Lam 1/2 – kr 3500", "Lam 1/2", 3500],
        ["Ost - kr. 89,-", "Ost", 89],
        ["Øl kr. 50,-", "Øl", 50],
        ["Honning – kr 150 (500g)", "Honning", 150],
        ["Sesonggrønnsaker (40-50 sorter) – kr 300", "Sesonggrønnsaker (40-50 sorter)", 300],
        ["Spekeskinke - kr 1 200", "Spekeskinke", 1200],
        ["Kjøtt (lam) – kr 200", "Kjøtt (lam)", 200],
        ["Lam (hel) kr 3000", "Lam (hel)", 3000],
        ["Brød (stort) - kr 60 (bestill)", "Brød (stort)", 60],
        ["Egg 6 stk – kr 50", "Egg 6 stk", 50],
        ["Lam – kr 275 pr kg", "Lam", 275],
      ];
      // [name, what the old rule made of it]: no price, and the JSON-LD name is the whole name.
      const NAME_UNPRICED: Array<[string, string]> = [
        ["Sesonggrønnsaker (40-50 sorter)", "«Sesonggrønnsaker (40» at 50"],
        ["Gardsmjølk – 1 liter/veke abonnement", "«Gardsmjølk» at 1"],
        ["Gardsmjølk – 2 liter/veke abonnement", "«Gardsmjølk» at 2"],
        ["Gardsmjølk – 3 liter/veke abonnement", "«Gardsmjølk» at 3"],
        ["Pøyg (lagret ost, 3-6 mnd)", "«Pøyg (lagret ost, 3» at 6"],
        ["Poteter 5-10 kg", "Thing «Poteter 5»"],
        ["Tørrfisk, original filet 2-3kg", "Thing «Tørrfisk, original filet 2»"],
        ["Fenalår (spekebein lam), 1,5–2,7 kg", "Thing «Fenalår (spekebein lam), 1,5»"],
        // An interval is no price.
        ["Skinke kr 150–200/kg", "«Skinke kr 150» at 200"],
        // A multi-buy is no price for one item.
        ["Gave - 2 for kr 100", "«Gave» at 2"],
        ["Honning 2 for kr 100", "«Honning 2 for» at 100"],
        ["Gave 2 x kr 100", "«Gave 2 x» at 100"],
        ["Gave 2x kr 100", "«Gave 2x» at 100"],
        ["Rømme - pr kr 50", "«Rømme - pr» at 50"],
        ["Pakke kr 100 for 2", "Thing «Pakke»"],
        // More than one kr price: no single number is the product's price.
        ["Kake – kr 50 (liten), kr 90 (stor)", "«Kake» at 50"],
        ["Ost – kr 89 / kr 150", "«Ost» at 89"],
        ["Egg kr 40 – kr 70", "«Egg kr 40» at 70"],
        // Known, deliberate loss: a price after the number. The 2026-10-17
        // feed had no name of this form (dev-request S6 del A).
        ["Egg – 60 kr", "«Egg» at 60"],
        // "kr" inside a parenthesis without a separator: no price, as before.
        ["Hjortekjøtt (kr 350/kg)", "Hjortekjøtt (kr 350/kg), no price"],
      ];
      for (const [raw, name, price] of NAME_PRICED) {
        assertSame(splitNamePrice(raw, "no"), { name, price }, `splitNamePrice no: ${JSON.stringify(raw)} → ${JSON.stringify(name)} at ${price}`);
        assertSame(splitNamePrice(raw, "en"), { name: productLabel(name, "en"), price },
          `splitNamePrice en: ${JSON.stringify(raw)} → the cut name through productLabel, at ${price}`);
        assertTrue(balanced(raw) && balanced(name), `splitNamePrice: ${JSON.stringify(name)} has balanced parentheses, as its source`);
      }
      for (const [raw, before] of NAME_UNPRICED) {
        assertSame(splitNamePrice(raw, "no"), { name: raw, price: null },
          `splitNamePrice no: ${JSON.stringify(raw)} gives no price and the whole name (old rule: ${before})`);
        assertSame(splitNamePrice(raw, "en"), { name: productLabel(raw, "en"), price: null },
          `splitNamePrice en: ${JSON.stringify(raw)} gives no price and the whole name through productLabel`);
      }
      // On an EN page the cut name is translated like a whole name.
      for (const [raw, en] of [
        ["Honning - kr. 150", "Honey"],
        ["Pølse – kr 1.200,50", "Sausage"],
        ["Ost - kr. 89,-", "Cheese"],
        ["Kjøtt (lam) – kr 200", "Meat (lamb)"],
      ] as const) {
        assertSame(splitNamePrice(raw, "en").name, en, `splitNamePrice en: ${JSON.stringify(raw)} → ${JSON.stringify(en)}`);
      }
      assertSame(splitNamePrice("", "no"), { name: "", price: null }, "splitNamePrice: an empty name gives no price");
    }

    // ══════════════════════════════════════════════════════════════
    // (e) S6 del A on the page: live product names (Bjerkelund, Avdem,
    // Ødhumbla, and one producer with the other forms) on the NO and the EN
    // producer page. Each JSON-LD price is the price the same product's row
    // shows, no name is cut without a price, and each name-only Thing is its
    // row's visible name. Rows and JSON-LD are matched by order (the first 20
    // products, Things skipped), since on EN «Honning - kr. 150» is the Offer
    // «Honey» while the row keeps the whole name. S6 del B: each Offer has
    // exactly @type, name, price and priceCurrency and the page has no Product
    // node; in rollback mode the same names and prices come back as Products,
    // and the rest of the page is byte for byte the same.
    // ══════════════════════════════════════════════════════════════
    {
      type Row = { name: string; price?: string; want: [string, number] | null };
      const FIXTURES: Array<{ id: string; name: string; slug: string; rows: Row[] }> = [
        { id: "bjerkelund-gard", name: "Bjerkelund Gaard", slug: "bjerkelund-gaard", rows: [
          { name: "Selvplukk bringebær (kasse 3,6 kg - kr 600)", want: ["Selvplukk bringebær (kasse 3,6 kg)", 600] },
          { name: "Selvplukk bringebær (kurv 300g - kr 50)", want: ["Selvplukk bringebær (kurv 300g)", 50] },
          { name: "Ferdigplukka bringebær (kurv 300g - kr 60)", want: ["Ferdigplukka bringebær (kurv 300g)", 60] },
          { name: "Ferdigplukka bringebær (kasse 3,6 kg - kr 700)", want: ["Ferdigplukka bringebær (kasse 3,6 kg)", 700] },
          { name: "Frosne bringebær (kasse 3,6 kg - kr 600)", want: ["Frosne bringebær (kasse 3,6 kg)", 600] },
        ] },
        // Before: Product «Sesonggrønnsaker (40» at an invented 50, and 3 Things.
        { id: "avdem-gard", name: "Avdem Gaard", slug: "avdem-gaard", rows: [
          { name: "Grønnsaksabonnement (ukentlig kasse)", want: null },
          { name: "Sesonggrønnsaker (40-50 sorter)", want: null },
          { name: "Urter", want: null },
          { name: "Selvplukk fra Avdemsbue", want: null },
        ] },
        // Before: three Products «Gardsmjølk» at 1, 2 and 3 kr.
        { id: "odhumbla-gard", name: "Odhumbla Gaard", slug: "odhumbla-gaard", rows: [
          { name: "Gardsmjølk – 1 liter/veke abonnement", want: null },
          { name: "Gardsmjølk – 2 liter/veke abonnement", want: null },
          { name: "Gardsmjølk – 3 liter/veke abonnement", want: null },
        ] },
        { id: "navnepris-gard", name: "Navnepris Gaard", slug: "navnepris-gaard", rows: [
          { name: "Pøyg (lagret ost, 3-6 mnd)", want: null },
          { name: "Poteter 5-10 kg", want: null },
          { name: "Tørrfisk, original filet 2-3kg", want: null },
          { name: "Fenalår (spekebein lam), 1,5–2,7 kg", want: null },
          { name: "Lammelår – kr 275/kg", want: ["Lammelår", 275] },
          { name: "Pølse – kr 1.200,50", want: ["Pølse", 1200.5] },
          { name: "Honning - kr. 150", want: ["Honning", 150] },
          { name: "Lam 1/2 – kr 3500", want: ["Lam 1/2", 3500] },
          { name: "Ost - kr. 89,-", want: ["Ost", 89] },
          { name: "Øl kr. 50,-", want: ["Øl", 50] },
          { name: "Honning – kr 150 (500g)", want: ["Honning", 150] },
          { name: "Sesonggrønnsaker (40-50 sorter) – kr 300", want: ["Sesonggrønnsaker (40-50 sorter)", 300] },
          { name: "Egg (6 stk – kr 40) økologisk", want: ["Egg (6 stk)", 40] },
          { name: "Skinke kr 150–200/kg", want: null },
          { name: "Gave - 2 for kr 100", want: null },
          { name: "Egg – 60 kr", want: null },
          { name: "Kake – kr 50 (liten), kr 90 (stor)", want: null },
          // The price field still wins, and the name stays whole.
          { name: "Flatbrød", price: "kr 65", want: ["Flatbrød", 65] },
          { name: "Kjøtt (lam) – kr 200", want: ["Kjøtt (lam)", 200] },
        ] },
      ];
      const unescapeHtml = (s: string): string =>
        s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      const rowsOnPage = (body: string): Array<{ name: string; price: string }> =>
        [...body.matchAll(/<div class="prod-item"><span class="prod-name">([\s\S]*?)<\/span>(?:<span class="prod-price">([\s\S]*?)<\/span>)?/g)]
          .map((m) => ({ name: unescapeHtml(m[1]), price: unescapeHtml(m[2] || "") }));
      const digits = (s: string): string => s.replace(/\D/g, "");

      for (const f of FIXTURES) {
        assertTrue(f.rows.length <= 20, `S6 setup: ${f.slug} has at most the 20 products the JSON-LD reads`);
        seedAgent({ id: f.id, name: f.name, city: "Lesja", lat: 62.13, lng: 8.86 });
        seedProducts(f.id, f.rows.map((x) => (x.price ? { name: x.name, price: x.price } : { name: x.name })));
      }
      resetRegistryCache();

      const OFFER_KEYS = ["@type", "name", "price", "priceCurrency"];
      for (const f of FIXTURES) {
        for (const lang of ["no", "en"] as const) {
          const tag = `S6 ${f.slug} (${lang})`;
          const r = invoke("/produsent/:slug", { params: { slug: f.slug }, lang, ip: "127.0.0.1" });
          assertTrue(r.status === 200, `${tag}: renders 200`);
          const blocks = jsonLdBlocks(r.body);
          const ld = mainLd(r.body);
          assertTrue(!!ld, `${tag}: main JSON-LD present`);
          const offers: any[] = Array.isArray(ld?.makesOffer) ? ld.makesOffer : [];
          const things: any[] = ld?.hasOfferCatalog?.itemListElement || [];
          const wantOffers = f.rows.filter((x) => x.want).map((x) => [productLabel(x.want![0], lang), x.want![1]]);
          const wantThings = f.rows.filter((x) => !x.want).map((x) => productLabel(x.name, lang));

          assertSame(offers.map((o) => [o.name, o.price]), wantOffers, `${tag}: makesOffer names and prices`);
          assertTrue(offers.every((o) => JSON.stringify(Object.keys(o)) === JSON.stringify(OFFER_KEYS) && o["@type"] === "Offer" && o.priceCurrency === "NOK"),
            `${tag}: each Offer has exactly @type, name, price and priceCurrency (NOK)`);
          assertSame(productNodes(blocks), [], `${tag}: productNodes is [] (no Product node)`);
          assertTrue(wantOffers.length > 0 || !("makesOffer" in (ld || {})), `${tag}: no makesOffer when nothing is priced`);
          assertSame(things.map((x) => x.name), wantThings, `${tag}: the catalog Things are the whole names`);
          if (lang === "en") {
            for (const [no, en] of [["Honning", "Honey"], ["Pølse", "Sausage"], ["Kjøtt (lam)", "Meat (lamb)"]]) {
              if (!f.rows.some((x) => x.want?.[0] === no)) continue;
              const names = offers.map((o) => o.name);
              assertTrue(names.includes(en) && !names.includes(no), `${tag}: the cut name ${JSON.stringify(no)} is translated (${JSON.stringify(en)})`);
            }
          }

          const rows = rowsOnPage(r.body);
          assertSame(rows.map((x) => x.name), f.rows.map((x) => productLabel(x.name, lang)), `${tag}: the visible rows keep the whole names`);
          // The price a row shows: parseNokPrice on its price, else the name rule on its name.
          const shown = rows.map((x) => parsePrice(x.price) ?? splitNamePrice(x.name, "no").price);
          const pricedRows = rows.filter((_, i) => shown[i] !== null);
          const unpricedRows = rows.filter((_, i) => shown[i] === null);
          assertSame(offers.map((o) => o.price), shown.filter((p) => p !== null), `${tag}: each JSON-LD price is the price its row shows, in order`);
          assertTrue(offers.every((o, i) => !!pricedRows[i] && digits(`${pricedRows[i].name} ${pricedRows[i].price}`).includes(digits(String(o.price)))),
            `${tag}: each JSON-LD price's digits stand in its row`);
          assertSame(things.map((x) => x.name), unpricedRows.map((x) => x.name), `${tag}: each Thing.name is its row's visible name`);
          assertTrue([...offers.map((o) => String(o.name)), ...things.map((x) => String(x.name))].every(balanced),
            `${tag}: no JSON-LD name has an unbalanced parenthesis (every source name is balanced)`);
          if (lang === "no") {
            assertTrue(offers.every((o, i) => !!pricedRows[i] && pricedRows[i].name.startsWith(String(o.name).replace(/\)+$/, ""))),
              `${tag}: each Offer name, less a parenthesis the cut closed, starts its row's name`);
          }
          assertSame(offersWithoutPrice(blocks), 0, `${tag}: offersWithoutPrice stays 0`);
          assertSame(forbiddenNodes(blocks), [], `${tag}: no forbidden rating/review/return/shipping node`);

          // Rollback mode (PRODUCER_PAGE_PRODUCT_NODES = true): the Product
          // form, with the same names and prices as the Offers above, so no
          // Product for an unpriced name such as «Sesonggrønnsaker (40-50
          // sorter)», and the catalog is the same.
          let rb: { status: number; body: string } = { status: 0, body: "" };
          try {
            policy.__setProducerPageProductNodesForTesting(true);
            rb = invoke("/produsent/:slug", { params: { slug: f.slug }, lang, ip: "127.0.0.1" });
          } finally {
            policy.__setProducerPageProductNodesForTesting(null);
          }
          const rbBlocks = jsonLdBlocks(rb.body);
          const rbLd = mainLd(rb.body);
          const rbOffers: any[] = Array.isArray(rbLd?.makesOffer) ? rbLd.makesOffer : [];
          assertSame(rbOffers.map((o) => [o.itemOffered?.name, o.price]), wantOffers, `${tag} rollback: Product names and prices are the Offers' above`);
          assertTrue(rbOffers.every((o) => o.itemOffered?.["@type"] === "Product" && o.itemOffered?.offers?.price === o.price),
            `${tag} rollback: each Offer wraps a Product whose offers.price is the Offer price`);
          assertSame(productNodes(rbBlocks), rbOffers.map((_, i) => `$[0].makesOffer[${i}].itemOffered`), `${tag} rollback: productNodes finds exactly those Products`);
          assertTrue(rbOffers.every((o) => balanced(String(o.itemOffered?.name))), `${tag} rollback: no Product name has an unbalanced parenthesis`);
          assertSame((rbLd?.hasOfferCatalog?.itemListElement || []).map((x: any) => x.name), wantThings, `${tag} rollback: the catalog Things are the same`);
          assertSame(offersWithoutPrice(rbBlocks), 0, `${tag} rollback: offersWithoutPrice stays 0`);
          assertSame(forbiddenNodes(rbBlocks), [], `${tag} rollback: no forbidden node`);

          // S6 del B changes the JSON-LD only. Rollback mode renders the page
          // as on main (rfb-seo-feiltypede-knowledge-felt.test.ts holds main's
          // golden), so this is the before/after check: with the ld+json
          // blocks cut out, the two pages are byte for byte the same (rows,
          // prices, FAQ, related producers). With nothing priced the whole
          // page is.
          const again = invoke("/produsent/:slug", { params: { slug: f.slug }, lang, ip: "127.0.0.1" });
          assertSame(firstDiff(again.body, r.body), null, `${tag}: two renders in the same mode are byte-identical (RANDOM() fixed)`);
          const cut = outsideJsonLd(r.body);
          assertTrue(blocks.length > 0 && cut.split("<!--ld+json-->").length - 1 === blocks.length && !cut.includes("application/ld+json")
            && cut.includes(`<div class="prod-item">`) && cut.includes(`class="rp-card"`),
            `${tag}: the HTML outside the JSON-LD has every ld+json block cut, the product rows and the related producers`);
          assertSame(firstDiff(cut, outsideJsonLd(rb.body)), null, `${tag}: the HTML outside the ld+json blocks is byte-identical in rollback mode (main)`);
          if (wantOffers.length) assertTrue(r.body !== rb.body, `${tag}: the two modes differ, in the JSON-LD only`);
          else assertSame(firstDiff(r.body, rb.body), null, `${tag}: with nothing priced the whole page is byte-identical in rollback mode`);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // parseNokPrice unit tests
    // ══════════════════════════════════════════════════════════════
    {
      const { parseNokPrice, buildBmEventJsonLd } = require("./seo") as typeof import("./seo");
      const eq = (input: unknown, want: number | null) =>
        assertTrue(parseNokPrice(input) === want, `parseNokPrice(${JSON.stringify(input)}) === ${want}`);
      eq("275", 275); eq("kr 350", 350); eq("kr 275/kg", 275); eq("275,50", 275.5); eq("99.90", 99.9);
      eq("1.200,50", 1200.5); eq("1 200", 1200); eq("1.200.000", 1200000); eq(275, 275);
      eq("kr 150–200/kg", null); eq("150-200", null); eq("150 til 200", null);
      eq("275/500g", null); eq("500g", null);
      eq("1.200", null); eq("1,500", null);
      eq("0", null); eq("kr 0", null); eq("0,00", null); eq(0, null); eq(-5, null);
      eq("1 200,-", 1200); eq("kr 1 200,-", 1200); eq("1 200 kr", 1200); eq("275,-", 275); eq("fra 99", 99);
      eq("2 for 100", null); eq("2 x 50", null); eq("100 kr for 2", null); eq("99 kr per 100g", null);
      eq("1 2000", null);
      for (const d of ["\u2212", "\u2012", "\u2010", "\u2011", "\u2015"]) eq(`150${d}200`, null);
      eq("", null); eq("   ", null); eq(undefined, null); eq(null, null); eq("på forespørsel", null);

      // Event fields
      const base = { event_name: "Bondens marked Oslo", location_text: "Youngstorget", start_at: "2026-10-10T10:00:00+02:00",
        end_at: "2026-10-10T15:00:00+02:00", source_url: "https://bondensmarked.no/oslo", venue_name: "Youngstorget", city: "Oslo", lat: 59.9, lng: 10.7 };
      const ev = buildBmEventJsonLd(base, "https://cdn.example.no/x.jpg", "https://rettfrabonden.com");
      assertTrue(ev.eventStatus === "https://schema.org/EventScheduled", "event: eventStatus");
      assertTrue(ev.eventAttendanceMode === "https://schema.org/OfflineEventAttendanceMode", "event: attendance mode");
      assertTrue(ev.organizer.url === "https://bondensmarked.no", "event: organizer.url");
      assertTrue(ev.image === "https://cdn.example.no/x.jpg", "event: venue image used");
      assertTrue(typeof ev.description === "string" && ev.description.includes("Youngstorget") && ev.description.includes("10:00"), "event: description from known fields");
      assertTrue(ev.startDate === "2026-10-10T10:00:00+02:00" && ev.endDate === "2026-10-10T15:00:00+02:00", "event: ISO offsets preserved");
      assertTrue(!("offers" in ev), "event: no offers");
      const ev2 = buildBmEventJsonLd({ ...base, end_at: null, source_url: null, city: null, lat: null, lng: null }, null, "https://rettfrabonden.com");
      assertTrue(ev2.image === "https://rettfrabonden.com/logo-512.png", "event: logo fallback is absolute https");
      assertTrue(!("endDate" in ev2) && !("url" in ev2), "event: no empty optional keys");
      assertTrue(!JSON.stringify(ev2).includes("undefined") && !JSON.stringify(ev2).includes('""'), "event: no undefined/empty values");
      assertTrue(buildBmEventJsonLd(base, "/relative.jpg", "https://rettfrabonden.com").image === "https://rettfrabonden.com/logo-512.png", "event: non-http image rejected");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-makesoffer-price-optional: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    policy.__setProducerPageProductNodesForTesting(null);
    if (prevDb) __setDbForTesting(prevDb);
    try {
      const regModCleanup = require("../services/marketplace-registry");
      regModCleanup.marketplaceRegistry._agentsCache = null;
      regModCleanup.marketplaceRegistry._statsCache = null;
    } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-makesoffer-price-optional.test.ts`
if (require.main === module) {
  console.log("── RFB makesOffer price-optional (dev-request 2026-09-24-ai-sok-bli-svaret-rfb slice B1) unit tests ──");
  runMakesOfferPriceOptionalTests({ log: true }).then((r) => {
    console.log(`\nrfb-makesoffer-price-optional: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

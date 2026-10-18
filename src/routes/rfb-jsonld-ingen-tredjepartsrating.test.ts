/**
 * rfb-jsonld-ingen-tredjepartsrating.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt, S1
 * and S6 del B.
 *
 * Rendered-page check that the JSON-LD only claims what the platform can back:
 *   (A) the shared checker (tests/helpers/jsonld-invariants.ts) is not
 *       vacuous: a WO-17-shaped payload yields every forbidden node, a clean
 *       one none, and a broken ld+json block throws; productNodes finds a
 *       Product in itemOffered, in an array @type, a ProductGroup with its
 *       variant and the schema.org URL spelling, and not an Offer, a Thing or
 *       an OfferCatalog;
 *   (B) RFB GET /produsent/:slug with a Google rating (4.6 / 236, and 4.6
 *       with googleReviewCount NULL — the case that used to get an invented
 *       reviewCount 1), externalReviews from Google (one without an author —
 *       the case that used to get an invented author «Kunde»), one priced and
 *       one unpriced product: 0 aggregateRating, 0 review, 0
 *       hasMerchantReturnPolicy, 0 shippingDetails anywhere (incl. the nested
 *       Product), no reviewCount/ratingValue at all, and offersWithoutPrice
 *       is 0. Since S6 del B the priced product is an Offer with exactly
 *       @type, name, price > 0 and priceCurrency, and productNodes is [];
 *       in rollback mode (PRODUCER_PAGE_PRODUCT_NODES true) it is the old
 *       Product with price, priceCurrency, availability, seller and brand,
 *       still without a forbidden node. (knowledgeService.getAgentInfo does not pass
 *       externalReviews to the page today, so the seeded reviews only guard
 *       the day it does; seo.ts has no Review builder either way.)
 *   (C) Opplevagent and (D) finn-tannlege pages: forbiddenNodes is [] on
 *       every page tested (dental with a stored Google rating on the clinic);
 *       on Opplevagent, offersWithoutPrice is 0 too (S5: the live gårdssalg
 *       page signals a ReserveAction instead of a price-less Offer).
 *   (E) source check (S6 del B): seo.ts's makesOffer builder asks
 *       producerPageProductNodes() before it builds a Product.
 *
 * Harnesses: (B) same as rfb-makesoffer-price-optional.test.ts (own
 * `Database(":memory:")`, the real seo.ts handler off the route stack);
 * (C) same as experiences-seo-visning-mcp-tilbyder.test.ts and (D) same as
 * dental-seo.test.ts (EXPERIENCES_DB_PATH / DENTAL_DB_PATH=":memory:",
 * db-factory reset, router.handle()).
 *
 * Exported runRfbJsonLdIngenTredjepartsratingTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-jsonld-ingen-tredjepartsrating.test.ts
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";
import { jsonLdBlocks, offersWithoutPrice, forbiddenNodes, productNodes } from "../../tests/helpers/jsonld-invariants";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      params: {},
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() { return this; },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); return this; },
      json(body: unknown) { resolve({ handled: true, status: statusCode, body: JSON.stringify(body) }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: err ? 500 : 404, body: err ? String(err) : "" });
    });
  });
}

export async function runRfbJsonLdIngenTredjepartsratingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  /** Asserts the page parsed into ≥1 ld+json block and carries no forbidden node; returns the blocks. */
  function assertCleanPage(body: string, label: string): unknown[] {
    let blocks: unknown[] = [];
    try { blocks = jsonLdBlocks(body); } catch (err) { assertTrue(false, `${label}: ld+json parses (${String(err)})`); }
    assertTrue(blocks.length > 0, `${label}: page has ld+json to check`);
    assertEq(forbiddenNodes(blocks), [], `${label}: no aggregateRating/review/hasMerchantReturnPolicy/shippingDetails`);
    return blocks;
  }

  // ══════════════════════════════════════════════════════════════
  // (A) checker self-test
  // ══════════════════════════════════════════════════════════════
  {
    const rating = { "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 1 };
    const review = [{ "@type": "Review", author: { "@type": "Person", name: "Kunde" } }];
    const wo17Shaped = [{
      "@type": "LocalBusiness",
      name: "X",
      aggregateRating: rating,
      review,
      makesOffer: [{
        "@type": "Offer", price: 275,
        itemOffered: {
          "@type": "Product", name: "Lam", aggregateRating: rating, review,
          offers: {
            "@type": "Offer", price: 275,
            hasMerchantReturnPolicy: { "@type": "MerchantReturnPolicy", merchantReturnDays: 14 },
            shippingDetails: { "@type": "OfferShippingDetails" },
          },
        },
      }],
      subjectOf: { "@type": "AggregateRating", ratingValue: 5 },
    }];
    assertEq(forbiddenNodes(wo17Shaped), [
      "$[0].aggregateRating",
      "$[0].review",
      "$[0].makesOffer[0].itemOffered.aggregateRating",
      "$[0].makesOffer[0].itemOffered.review",
      "$[0].makesOffer[0].itemOffered.offers.hasMerchantReturnPolicy",
      "$[0].makesOffer[0].itemOffered.offers.shippingDetails",
      "$[0].subjectOf",
    ], "checker: the WO-17 payload shape yields every forbidden node once (by key, and by @type under another key)");
    assertEq(forbiddenNodes([{ "@type": "LocalBusiness", name: "X", makesOffer: [{ "@type": "Offer", price: 1 }] }]), [], "checker: a clean payload yields none");
    assertEq(offersWithoutPrice([{ "@type": ["Offer"], price: "275" }, { "@type": "Offer", price: 0 }, { "@type": "Offer", price: 5 }]), 2,
      "checker: offersWithoutPrice counts string/zero prices, also with an array @type");
    let threw = false;
    try { jsonLdBlocks('<script type="application/ld+json">{"broken":</script>'); } catch { threw = true; }
    assertTrue(threw, "checker: a broken ld+json block throws instead of being skipped");

    // S6 del B: productNodes.
    assertEq(productNodes(wo17Shaped), ["$[0].makesOffer[0].itemOffered"], "checker: productNodes finds the Product nested in itemOffered");
    assertEq(productNodes([
      { "@type": "LocalBusiness", name: "X", makesOffer: [{ "@type": "Offer", itemOffered: { "@type": ["Product", "Thing"], name: "Lam" } }] },
      { "@type": "ProductGroup", name: "Ost", hasVariant: [{ "@type": "Product", name: "Ost 500 g" }, { "@type": "Thing", name: "Ost 1 kg" }] },
      [{ "@type": "Offer", price: 1, itemOffered: { "@type": "https://schema.org/Product", name: "Egg" } }],
      { "@type": "Car", name: "Traktor" },
    ]), [
      "$[0].makesOffer[0].itemOffered",
      "$[1]",
      "$[1].hasVariant[0]",
      "$[2][0].itemOffered",
      "$[3]",
    ], "checker: productNodes finds an array @type, a ProductGroup and its variant, nodes in nested arrays, the schema.org URL spelling and a subtype");
    assertEq(productNodes([{
      "@type": "LocalBusiness", name: "Product",
      makesOffer: [{ "@type": "Offer", name: "Product", price: 79, priceCurrency: "NOK" }],
      hasOfferCatalog: { "@type": "OfferCatalog", name: "Produkter", itemListElement: [{ "@type": "Thing", name: "Product" }] },
      brand: { "@type": "Brand", name: "Product" },
    }]), [], "checker: productNodes finds none in an Offer, a Thing, an OfferCatalog or a Brand (a name \"Product\" is no @type)");
  }

  // ══════════════════════════════════════════════════════════════
  // (B) RFB /produsent/:slug
  // ══════════════════════════════════════════════════════════════
  {
    const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
      typeof import("../database/init");
    const prevDb = (() => {
      try { return getDb(); } catch { return undefined; }
    })();
    const testDb = new Database(":memory:");
    testDb.pragma("journal_mode = DELETE");
    testDb.pragma("foreign_keys = OFF");

    function seedAgent(id: string, name: string): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          '[]', '[]', '[]', '{}', '["no"]', 'Voss', 60.63, 6.42,
          0.5, 1, 0, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run(id, name, "En beskrivelse", name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`);
    }
    function seedKnowledge(agentId: string, k: { rating: number; count: number | null; reviews: unknown[] }): void {
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code, products, google_rating, google_review_count, external_reviews)
         VALUES (?, 'Gardsvegen 1', '5700', ?, ?, ?, ?)`,
      ).run(
        agentId,
        JSON.stringify([{ name: "Lammelår", price: "275" }, { name: "Ost" }]),
        k.rating, k.count, JSON.stringify(k.reviews),
      );
    }

    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }

      seedAgent("rated-236", "Vurdert Gaard");
      seedKnowledge("rated-236", {
        rating: 4.6, count: 236,
        reviews: [{ source: "Google", text: "Supert lam fra gården", rating: 5 }, { source: "Google", author: "Kari", text: "Fin ost", rating: 4, date: "2026-09-01" }],
      });
      seedAgent("rated-nocount", "Uten Antall Gaard");
      seedKnowledge("rated-nocount", { rating: 4.6, count: null, reviews: [{ source: "Google", text: "Gode egg", rating: 4 }] });
      const policy = require("../services/structured-data-policy") as typeof import("../services/structured-data-policy");
      const regMod = require("../services/marketplace-registry");
      regMod.marketplaceRegistry._agentsCache = null;
      regMod.marketplaceRegistry._statsCache = null;

      const seoRoutePath = require.resolve("./seo");
      delete require.cache[seoRoutePath];
      const seoRouter = require("./seo").default as any;
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route?.path === "/produsent/:slug" && l.route.methods?.get);
      assertTrue(!!layer, "rfb setup: GET /produsent/:slug layer is registered");
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const invoke = (slug: string, lang: "no" | "en"): { status: number; body: string } => {
        let status = 200;
        let body = "";
        const res: any = {
          status: (c: number) => { status = c; return res; },
          send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
          redirect: (_c: number, _l: string) => { status = 301; return res; },
        };
        handler({ params: { slug }, lang, ip: "127.0.0.1" }, res, () => {});
        return { status, body };
      };

      for (const [slug, label] of [["vurdert-gaard", "rfb 4.6/236"], ["uten-antall-gaard", "rfb 4.6/null"]] as const) {
        for (const lang of ["no", "en"] as const) {
          const tag = `${label} (${lang})`;
          const r = invoke(slug, lang);
          assertTrue(r.status === 200, `${tag}: renders 200`);
          const blocks = assertCleanPage(r.body, tag);
          const ldText = JSON.stringify(blocks);
          assertTrue(!ldText.includes("reviewCount") && !ldText.includes("ratingValue"), `${tag}: no reviewCount/ratingValue anywhere in the JSON-LD`);
          assertTrue(!ldText.includes("Kunde"), `${tag}: no invented review author in the JSON-LD`);
          assertEq(offersWithoutPrice(blocks), 0, `${tag}: offersWithoutPrice stays 0`);

          const biz = (blocks.flatMap((b) => (Array.isArray(b) ? b : [b])) as any[]).find((n) => n?.["@type"] === "LocalBusiness");
          assertTrue(!!biz, `${tag}: LocalBusiness block present`);
          const offers = Array.isArray(biz?.makesOffer) ? biz.makesOffer : [];
          assertTrue(offers.length === 1, `${tag}: exactly the one priced product is in makesOffer`);
          // S6 del B: an Offer from the farm, no Product (policy rule 7).
          const offer = offers[0];
          assertEq(Object.keys(offer || {}).sort(), ["@type", "name", "price", "priceCurrency"], `${tag}: the Offer has exactly @type, name, price and priceCurrency`);
          assertTrue(offer?.["@type"] === "Offer" && typeof offer?.name === "string" && offer.name !== "", `${tag}: the Offer is typed Offer and names the product`);
          assertTrue(typeof offer?.price === "number" && offer.price > 0 && offer.priceCurrency === "NOK", `${tag}: the Offer has price > 0 + priceCurrency NOK`);
          assertEq(productNodes(blocks), [], `${tag}: productNodes is [] (no Product node on the producer page)`);
          const catalog = biz?.hasOfferCatalog?.itemListElement || [];
          assertTrue(catalog.length === 1 && catalog[0]?.["@type"] === "Thing" && typeof catalog[0]?.name === "string" && catalog[0].name !== "",
            `${tag}: the unpriced product stays in the name-only catalog`);
        }
      }

      // Rollback mode (PRODUCER_PAGE_PRODUCT_NODES = true): the Product form
      // as before S6 del B, and still none of S1's forbidden nodes.
      try {
        policy.__setProducerPageProductNodesForTesting(true);
        for (const [slug, label] of [["vurdert-gaard", "rfb 4.6/236"], ["uten-antall-gaard", "rfb 4.6/null"]] as const) {
          for (const lang of ["no", "en"] as const) {
            const tag = `${label} (${lang}, rollback mode)`;
            const r = invoke(slug, lang);
            assertTrue(r.status === 200, `${tag}: renders 200`);
            const blocks = assertCleanPage(r.body, tag);
            assertEq(offersWithoutPrice(blocks), 0, `${tag}: offersWithoutPrice stays 0`);
            const biz = (blocks.flatMap((b) => (Array.isArray(b) ? b : [b])) as any[]).find((n) => n?.["@type"] === "LocalBusiness");
            const offers = Array.isArray(biz?.makesOffer) ? biz.makesOffer : [];
            assertTrue(offers.length === 1, `${tag}: exactly the one priced product is in makesOffer`);
            const product = offers[0]?.itemOffered;
            const inner = product?.offers;
            assertTrue(product?.["@type"] === "Product" && product?.brand?.["@type"] === "Brand" && !!product?.brand?.name, `${tag}: Product keeps brand`);
            assertTrue(typeof inner?.price === "number" && inner.price > 0 && inner.priceCurrency === "NOK", `${tag}: Product.offers keeps price > 0 + priceCurrency`);
            assertTrue(inner?.availability === "https://schema.org/InStock" && inner?.seller?.["@type"] === "LocalBusiness", `${tag}: Product.offers keeps availability + seller`);
            assertEq(productNodes(blocks), ["$[0].makesOffer[0].itemOffered"], `${tag}: productNodes finds the one Product`);
          }
        }
      } finally {
        policy.__setProducerPageProductNodesForTesting(null);
      }
    } catch (err) {
      failed++;
      failures.push(`rfb section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDb) __setDbForTesting(prevDb);
      try {
        const regModCleanup = require("../services/marketplace-registry");
        regModCleanup.marketplaceRegistry._agentsCache = null;
        regModCleanup.marketplaceRegistry._statsCache = null;
      } catch { /* ignore */ }
      try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
      testDb.close();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // (C) Opplevagent pages
  // ══════════════════════════════════════════════════════════════
  {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./experiences-seo"),
    ]);
    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      const insGs = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', 'bryggeri', @bl, NULL, 60.63, 6.42,
            'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insGs.run({ id: "inv-paused", navn: "Pauset Bryggeri", bl: 0, slug: "pauset-bryggeri" });
      insGs.run({ id: "inv-live", navn: "Aktivt Bryggeri", bl: 1, slug: "aktivt-bryggeri" });
      for (let i = 1; i <= 5; i++) insGs.run({ id: `inv-f${i}`, navn: `Fyllgård ${i}`, bl: 0, slug: `fyll-${i}` });
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, adresse, postnummer, poststed, fylke, kommune, telefon, hjemmeside, slug,
            brreg_active, brreg_verified, verification_status, source, confidence)
         VALUES ('inv-prov', 'Full Tilbyder AS', 'experiences', '123456789', 'Storgata 1', '5700', 'Voss', 'Vestland', 'Voss',
            '+47 91234567', 'https://full.example.no', 'full-tilbyder', 1, 1, 'verified', 'test-fixture', 'high')`,
      ).run();
      db.prepare(
        `INSERT INTO experiences (id, provider_id, slug, title, title_no, description, category, kommune, fylke,
           indoor_outdoor, verification_status, evidence_url, booking_url, price_from, price_unit)
         VALUES ('inv-exp', 'inv-prov', 'inv-opplevelse', 'Matvandring', 'Matvandring',
           'En ekte opplevelse med lokal guide for små grupper og familier.', 'mat_drikke', 'Voss', 'Vestland',
           'outdoor', 'verified', 'https://kilde.example.no/a', 'https://book.example.no', 990, 'per_adult')`,
      ).run();

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      for (const path of [
        "/",
        "/opplevelse/inv-opplevelse",
        "/kategori/mat_drikke",
        "/kommune/Voss",
        "/tilbyder/full-tilbyder",
        "/kategori/gardssalg/produsent/pauset-bryggeri",
        "/kategori/gardssalg/produsent/aktivt-bryggeri",
      ]) {
        const r = await callHtmlRoute(seoRouter, path);
        assertTrue(r.handled && r.status === 200, `oa ${path}: renders 200 (status ${r.status})`);
        const blocks = assertCleanPage(r.body, `oa ${path}`);
        // S5: the live gårdssalg page's price-less Offer is gone, so the
        // permanent no-Offer-without-price invariant now holds for OA too.
        assertEq(offersWithoutPrice(blocks), 0, `oa ${path}: offersWithoutPrice is 0`);
      }
    } catch (err) {
      failed++;
      failures.push(`oa section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevDispatch === undefined) delete process.env.BOOKING_DISPATCH_ENABLED; else process.env.BOOKING_DISPATCH_ENABLED = prevDispatch;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // (D) finn-tannlege pages
  // ══════════════════════════════════════════════════════════════
  {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./dental-seo"),
      require.resolve("../services/dental-store"),
    ]);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");
      const store = require("../services/dental-store") as typeof import("../services/dental-store");
      const dentalSeoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;

      const clinicId = store.createDentalAgent({
        navn: "Voss Tannklinikk AS",
        org_nr: "918800099",
        adresse: "Storgata 2",
        postnummer: "5700",
        poststed: "VOSS",
        fylke: "Vestland",
        telefon: "+47 56 51 00 00",
        hjemmeside: "https://voss-tann.example.no",
      } as any);
      // A stored Google rating must not turn into markup on the clinic page.
      db.prepare("UPDATE dental_agents SET rating = 4.7, rating_count = 88 WHERE id = ?").run(clinicId);

      for (const [path, label] of [["/", "/"], [`/klinikk/id/${clinicId}`, "/klinikk/id/:id"]]) {
        const r = await callHtmlRoute(dentalSeoRouter, path);
        assertTrue(r.handled && r.status === 200, `dental ${label}: renders 200 (status ${r.status})`);
        const blocks = assertCleanPage(r.body, `dental ${label}`);
        if (path !== "/") {
          assertTrue((blocks.flatMap((b) => (Array.isArray(b) ? b : [b])) as any[]).some((n) => n?.["@type"] === "Dentist"),
            `dental ${label}: the Dentist block was among the blocks checked`);
        }
      }
    } catch (err) {
      failed++;
      failures.push(`dental section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // (E) source check (S6 del B): the makesOffer builder in seo.ts asks the
  // policy module before it builds a Product, so the Product form is only
  // reached in rollback mode.
  // ══════════════════════════════════════════════════════════════
  {
    const seoSrc = readFileSync(join(__dirname, "seo.ts"), "utf8");
    assertTrue(/import \{[^}]*\bproducerPageProductNodes\b[^}]*\} from "\.\.\/services\/structured-data-policy";/.test(seoSrc),
      "source: seo.ts imports producerPageProductNodes from structured-data-policy");
    const start = seoSrc.indexOf("const pricedOffers = productsList");
    const end = seoSrc.indexOf("jsonLd.makesOffer = pricedOffers", start);
    const builder = start >= 0 && end > start ? seoSrc.slice(start, end) : "";
    assertTrue(builder !== "", "source: seo.ts's makesOffer builder is found");
    const ask = builder.indexOf("if (!producerPageProductNodes())");
    const product = builder.indexOf("const product: any = {");
    assertTrue(ask >= 0 && product > ask, "source: the builder calls producerPageProductNodes() before const product");
    assertEq((seoSrc.match(/producerPageProductNodes\(\)/g) || []).length, 1, "source: seo.ts reads producerPageProductNodes() in one place");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-jsonld-ingen-tredjepartsrating.test.ts`
if (require.main === module) {
  console.log("── RFB/OA/dental JSON-LD without third-party rating (dev-request 2026-10-16 S1, S6 del B) ──");
  runRfbJsonLdIngenTredjepartsratingTests({ log: true }).then((r) => {
    console.log(`\nrfb-jsonld-ingen-tredjepartsrating: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

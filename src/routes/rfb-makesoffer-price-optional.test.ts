/**
 * rfb-makesoffer-price-optional.test.ts — dev-request
 * 2026-09-24-ai-sok-bli-svaret-rfb, slice B1 (Daniel-GO 2026-09-24, see
 * daniel-responses/2026-09-24-go-chatgpt-claude-spor-a-b-c.md in the A2A repo).
 *
 * Covers `src/routes/seo.ts`'s `GET /produsent/:slug` JSON-LD builder for
 * `jsonLd.makesOffer`: a product with no parseable numeric price used to be
 * dropped entirely (`if (!numericPrice || isNaN(parseFloat(numericPrice)))
 * return null;`). That gate is gone — every product with a name now gets an
 * Offer entry, and `price` is included ONLY when a real numeric price was
 * actually found in the source data (never fabricated as 0/null/"").
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

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

    // ══════════════════════════════════════════════════════════════
    // (a) Clean numeric price -> unchanged has-price behavior
    // (regression guard for the existing path).
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "priced-gard", name: "Priset Gaard", city: "Oslo", lat: 59.91, lng: 10.75 });
      seedProducts("priced-gard", [{ name: "Lammelår", price: "275" }]);
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "priset-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "priced: renders 200");
      const ld = extractMakesOfferJsonLd(r.body);
      assertTrue(!!ld, "priced: a JSON-LD block with makesOffer is present");
      assertTrue(ld.makesOffer.length === 1, "priced: makesOffer has exactly one entry");
      const offer = ld.makesOffer[0];
      const inner = offer.itemOffered.offers;

      assertTrue(offer["@type"] === "Offer", "priced: outer @type is Offer");
      assertTrue(offer.price === 275, "priced: outer price is the parsed numeric value (275)");
      assertTrue(offer.priceCurrency === "NOK", "priced: outer priceCurrency is NOK");
      assertTrue(offer.availability === "https://schema.org/InStock", "priced: outer availability is InStock");

      assertTrue(offer.itemOffered["@type"] === "Product", "priced: itemOffered @type is Product");
      assertTrue(offer.itemOffered.name === "Lammelår", "priced: itemOffered.name is unchanged");
      assertTrue(inner["@type"] === "Offer", "priced: inner offers @type is Offer");
      assertTrue(inner.price === 275, "priced: inner offers.price is the parsed numeric value (275)");
      assertTrue(inner.priceCurrency === "NOK", "priced: inner offers.priceCurrency is NOK");
      assertTrue(inner.availability === "https://schema.org/InStock", "priced: inner offers.availability is InStock");
      assertTrue(inner.seller && inner.seller["@type"] === "LocalBusiness", "priced: inner offers.seller is still present");
      assertTrue(!!inner.hasMerchantReturnPolicy, "priced: inner offers.hasMerchantReturnPolicy is still present");
      assertTrue(inner.hasMerchantReturnPolicy.merchantReturnDays === 14, "priced: hasMerchantReturnPolicy.merchantReturnDays is unchanged (14)");
      assertTrue(!!inner.shippingDetails, "priced: inner offers.shippingDetails is still present");
      assertTrue(inner.shippingDetails["@type"] === "OfferShippingDetails", "priced: shippingDetails @type is unchanged");
    }

    // ══════════════════════════════════════════════════════════════
    // (b) No price anywhere (name only, no parseable price in the name
    // string either) -> product still appears, price key truly absent.
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "unpriced-gard", name: "Uprist Gaard", city: "Bergen", lat: 60.39, lng: 5.32 });
      seedProducts("unpriced-gard", [{ name: "Ost" }]);
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "uprist-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "unpriced: renders 200");
      const ld = extractMakesOfferJsonLd(r.body);
      assertTrue(!!ld, "unpriced: a JSON-LD block with makesOffer is present");
      assertTrue(ld.makesOffer.length === 1, "unpriced: makesOffer still contains the priceless product (not silently dropped)");
      const offer = ld.makesOffer[0];
      const inner = offer.itemOffered.offers;

      assertTrue(offer.itemOffered.name === "Ost", "unpriced: itemOffered.name is the seeded product name");
      assertTrue(offer.priceCurrency === "NOK", "unpriced: outer priceCurrency is still set");
      assertTrue(offer.availability === "https://schema.org/InStock", "unpriced: outer availability is still set");
      assertTrue(!("price" in offer), "unpriced: outer offer has NO price key at all (not 0/null/empty)");
      assertTrue(inner.priceCurrency === "NOK", "unpriced: inner offers.priceCurrency is still set");
      assertTrue(inner.availability === "https://schema.org/InStock", "unpriced: inner offers.availability is still set");
      assertTrue(!("price" in inner), "unpriced: inner offers has NO price key at all (not 0/null/empty)");
    }

    // ══════════════════════════════════════════════════════════════
    // (c) Mixed priced + unpriced products in the same list -> both
    // survive into makesOffer (today's code would silently drop the
    // unpriced one).
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "mixed-gard", name: "Blandet Gaard", city: "Trondheim", lat: 63.43, lng: 10.39 });
      seedProducts("mixed-gard", [
        { name: "Lammelår", price: "275" },
        { name: "Ost" },
      ]);
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "blandet-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "mixed: renders 200");
      const ld = extractMakesOfferJsonLd(r.body);
      assertTrue(!!ld, "mixed: a JSON-LD block with makesOffer is present");
      assertTrue(ld.makesOffer.length === 2, "mixed: both the priced and unpriced product survive into makesOffer");

      const names = ld.makesOffer.map((o: any) => o.itemOffered.name);
      assertTrue(names.includes("Lammelår") && names.includes("Ost"), "mixed: both product names are present");

      const pricedOffer = ld.makesOffer.find((o: any) => o.itemOffered.name === "Lammelår");
      const unpricedOffer = ld.makesOffer.find((o: any) => o.itemOffered.name === "Ost");
      assertTrue(pricedOffer.price === 275, "mixed: priced entry keeps its price");
      assertTrue(!("price" in unpricedOffer), "mixed: unpriced entry has no price key");
      assertTrue(unpricedOffer.priceCurrency === "NOK" && unpricedOffer.availability === "https://schema.org/InStock",
        "mixed: unpriced entry still has priceCurrency/availability");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-makesoffer-price-optional: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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

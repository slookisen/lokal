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
 * buildBmEventJsonLd and the permanent "no Offer without price" invariant.
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

    /** Permanent invariant (dev-request 2026-09-29-gsc-strukturerte-data-og-5xx): no Offer without numeric price > 0, anywhere in the JSON-LD. */
    function offersWithoutPrice(node: any): number {
      let bad = 0;
      if (Array.isArray(node)) { for (const n of node) bad += offersWithoutPrice(n); return bad; }
      if (node && typeof node === "object") {
        if (node["@type"] === "Offer" && !(typeof node.price === "number" && node.price > 0)) bad++;
        for (const k of Object.keys(node)) bad += offersWithoutPrice(node[k]);
      }
      return bad;
    }
    function allJsonLd(body: string): any[] {
      return [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(b => { try { return JSON.parse(b[1]); } catch { return null; } }).filter(Boolean);
    }
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
      const names = ld.makesOffer.map((o: any) => o.itemOffered.name);
      assertTrue(names.includes("Lammelår") && names.includes("Pølse"), "mixed: priced names present");
      const pol = ld.makesOffer.find((o: any) => o.itemOffered.name === "Pølse");
      assertTrue(pol.price === 1200.5 && pol.itemOffered.offers.price === 1200.5, "mixed: Norwegian 1.200,50 parsed as 1200.5");
      const cat = ld.hasOfferCatalog.itemListElement.map((i: any) => i.name);
      assertTrue(cat.length === 2 && cat.includes("Ost") && cat.includes("Skinke"), "mixed: Ost + range-priced Skinke go to the catalog");
      assertTrue(offersWithoutPrice(allJsonLd(r.body)) === 0, "invariant: mixed page has no Offer without price");
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

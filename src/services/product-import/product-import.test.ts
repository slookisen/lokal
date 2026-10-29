/**
 * product-import.test.ts — dev-request 2026-10-21-rfb-produktimport-fra-egen-
 * nettside, Skive 1 (extractor + dry-run measurement, no write path).
 *
 *   AC1  POST /admin/product-import/dry-run: 403 without X-Admin-Key; with the
 *        key it runs (202 + background job), and agent_knowledge / products
 *        are byte-identical (row count AND content) afterwards. Flag off → 404.
 *   AC2  robots.txt `Disallow: /` → robots_blocked, only robots.txt fetched.
 *   AC3  Shopify /products.json, WooCommerce Store API and JSON-LD
 *        Product/Offer fixtures → right name, price and unit.
 *   AC4  LLM fixture: a price not in the source → price dropped; a name not
 *        in the source → product dropped; invalid JSON stays invalid.
 *   AC5  a link to another host is never fetched; a private-IP website is
 *        rejected by fetchPage()'s SSRF guard before any request.
 *   + normalisation cases, robots parsing, js_unreadable, fetch failures,
 *     LLM budget cap, stratified sample.
 *
 * No network: every request goes to an injected fake fetch; the LLM is an
 * injected function. The DB is a pinned in-memory instance (restored in
 * finally).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type FakeRoute = { status?: number; body: string; contentType?: string; url?: string };

function makeFetch(routes: Record<string, FakeRoute | ((url: string) => FakeRoute)>) {
  const calls: string[] = [];
  const impl = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    calls.push(url);
    const hit = routes[url];
    const r: FakeRoute = typeof hit === "function" ? hit(url) : hit ?? { status: 404, body: "<html><body>404</body></html>" };
    const resp = new Response(r.body, {
      status: r.status ?? 200,
      headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" },
    });
    if (r.url) Object.defineProperty(resp, "url", { value: r.url });
    return resp;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "GET",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: {},
      headers: opts.headers || {},
      body: opts.body,
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      set() {
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: { error: String(err ?? "no route") } });
    });
  });
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));

const ROBOTS_OPEN = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };
const HTML = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

export function runProductImportTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertTrue(cond: boolean, label: string): void {
    assertEq(cond, true, label);
  }

  return (async () => {
    const norm = require("./normalize") as typeof import("./normalize");
    const robots = require("./robots") as typeof import("./robots");
    const ex = require("./extractor") as typeof import("./extractor");
    const llmMod = require("./llm") as typeof import("./llm");

    const noLlm = async () => {
      throw new Error("LLM must not be called");
    };

    // ── Normalisation ──────────────────────────────────────────────────────
    const p = (t: string) => norm.parseNokPrice(t);
    assertEq(p("kr 250"), { price_nok: 250, price_is_from: false, unit: null }, "norm: kr 250");
    assertEq(p("250 kr"), { price_nok: 250, price_is_from: false, unit: null }, "norm: 250 kr");
    assertEq(p("250,-"), { price_nok: 250, price_is_from: false, unit: null }, "norm: 250,-");
    assertEq(p("NOK 1 250"), { price_nok: 1250, price_is_from: false, unit: null }, "norm: NOK 1 250");
    assertEq(p("1.250,50 kr"), { price_nok: 1250.5, price_is_from: false, unit: null }, "norm: 1.250,50 kr");
    assertEq(p("89,50 kr/kg"), { price_nok: 89.5, price_is_from: false, unit: "kg" }, "norm: 89,50 kr/kg");
    assertEq(p("fra 250"), { price_nok: 250, price_is_from: true, unit: null }, "norm: fra 250 → price_is_from");
    assertEq(p("Fra kr 250,- pr kg"), { price_nok: 250, price_is_from: true, unit: "kg" }, "norm: Fra kr 250,- pr kg");
    assertEq(p("120 kr per stk").unit, "stk", "norm: per stk");
    assertEq(p("kr 60 pr. pakke").unit, "pakke", "norm: pr. pakke");
    assertEq(p("45 kr/l").unit, "l", "norm: /l");
    assertEq(p("Ring for pris").price_nok, null, "norm: no number → null");
    assertEq(p("2 for 100").price_nok, null, "norm: ambiguous bare numbers → null");
    assertEq(p("€ 25").price_nok, null, "norm: non-NOK → null");
    assertEq(norm.detectSizeUnit("500 g"), "g", "norm: size 500 g");
    assertEq(norm.detectSizeUnit("1 kg"), "kg", "norm: size 1 kg");
    assertEq(norm.detectSizeUnit("Default Title"), null, "norm: Default Title → null");
    assertEq(norm.normalizeProductName("  Lam   med  ben \n"), "Lam med ben", "norm: name trimmed + collapsed");
    assertEq(norm.normalizeProductName("x".repeat(500)), null, "norm: over-long name dropped");

    // ── robots.txt parsing ─────────────────────────────────────────────────
    const star = robots.parseRobotsTxt("User-agent: *\nDisallow: /");
    assertEq(robots.isPathAllowed(star, "/"), false, "robots: * Disallow: / blocks /");
    const own = robots.parseRobotsTxt("User-agent: *\nDisallow: /\n\nUser-agent: Lokal-RFB-Scraper\nAllow: /\n");
    assertEq(own.matched, "ua", "robots: our own group wins over *");
    assertEq(robots.isPathAllowed(own, "/produkter"), true, "robots: own group Allow: /");
    const ownBlock = robots.parseRobotsTxt("User-agent: lokal-rfb-scraper\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    assertEq(robots.isPathAllowed(ownBlock, "/"), false, "robots: own-UA Disallow honoured (case-insensitive)");
    const mixed = robots.parseRobotsTxt("User-agent: *\nDisallow: /wp-json/\nAllow: /wp-json/wc/store/\nDisallow: /*.json$\n");
    assertEq(robots.isPathAllowed(mixed, "/wp-json/wc/store/v1/products?per_page=100"), true, "robots: longest Allow wins");
    assertEq(robots.isPathAllowed(mixed, "/wp-json/wp/v2/users"), false, "robots: Disallow prefix");
    assertEq(robots.isPathAllowed(mixed, "/a/products.json"), false, "robots: wildcard + $ anchor");
    assertEq(robots.isPathAllowed(mixed, "/products.json?limit=250"), true, "robots: $ anchor does not match with query");
    assertEq(robots.isPathAllowed(robots.parseRobotsTxt("User-agent: *\nDisallow:\n"), "/"), true, "robots: empty Disallow allows all");
    assertEq(robots.isPathAllowed(robots.parseRobotsTxt("User-agent: Googlebot\nDisallow: /\n"), "/"), true, "robots: other bot's group does not apply");
    assertEq(robots.isPathAllowed(robots.parseRobotsTxt("User-agent: *\nDisallow: /a**b$\n"), "/axxb"), false, "robots: collapsed ** + $ matches");
    assertEq(robots.isPathAllowed(robots.parseRobotsTxt("User-agent: *\nDisallow: /ab*b$\n"), "/ab"), true, "robots: $ tail may not overlap consumed prefix");
    assertEq(robots.isPathAllowed(robots.parseRobotsTxt("User-agent: *\nDisallow: /*x*y\n"), "/qqxzzyrr"), false, "robots: multi-wildcard unanchored match");
    assertEq(robots.isPathAllowed(robots.parseRobotsTxt(`User-agent: *\nDisallow: /${"a".repeat(600)}\n`), `/${"a".repeat(700)}`), true, "robots: overlong rule ignored");
    {
      // ReDoS guard: these patterns took minutes with the old RegExp matcher.
      const evil = robots.parseRobotsTxt("User-agent: *\nDisallow: /****************z\nDisallow: /*a*a*a*a*a*a*a*a*a*a*a*a*b\nDisallow: /*a*a*a*a*a*a*a*a*b$\n");
      const t0 = Date.now();
      const ok = robots.isPathAllowed(evil, "/" + "a".repeat(5000));
      const ms = Date.now() - t0;
      assertTrue(ok === true && ms < 50, `robots: many-star rules on a long path finish fast (${ms} ms)`);
    }

    // ── AC2: robots Disallow: / → robots_blocked, nothing else fetched ─────
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({
        "https://blokkert.no/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
        "https://blokkert.no/products.json?limit=250": { body: '{"products":[{"title":"X","variants":[{"price":"1.00"}]}]}', contentType: "application/json" },
      });
      const r = await ex.extractProductsFromWebsite("https://blokkert.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "robots_blocked", "AC2: Disallow: / → robots_blocked");
      assertEq(f.calls, ["https://blokkert.no/robots.txt"], "AC2: only robots.txt fetched");
      assertEq(r.pages_fetched, 0, "AC2: zero product pages fetched");
      assertEq(r.products.length, 0, "AC2: no products");
    }
    // Cached: the second run on the same host does not re-read robots.txt.
    {
      const f = makeFetch({});
      const r = await ex.extractProductsFromWebsite("https://blokkert.no/", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "robots_blocked", "robots cache: still blocked");
      assertEq(f.calls.length, 0, "robots cache: no request within 24 h");
    }
    // Path-level Disallow: products.json skipped, never requested.
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({
        "https://delvis.no/robots.txt": { body: "User-agent: *\nDisallow: /products.json\nDisallow: /wp-json/\n", contentType: "text/plain" },
        "https://delvis.no/": { body: HTML("<p>Velkommen til gården vår. Vi selger egg og honning fra egne bikuber hele sommeren og høsten.</p><p>Honning 250 g koster 120 kr.</p>") },
      });
      const r = await ex.extractProductsFromWebsite("delvis.no", {
        fetchImpl: f.impl,
        llm: async () => ({ text: '[{"name":"Honning","price":"120 kr","unit":null}]' }),
      });
      assertTrue(!f.calls.some((u) => u.includes("products.json") || u.includes("wp-json")), "robots: disallowed paths never requested");
      assertEq(r.robots_skipped.length, 2, "robots: two skipped URLs recorded");
      assertEq(r.outcome, "ok", "robots: allowed homepage still processed");
    }
    // robots.txt 404 = no rules published = allowed.
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({
        "https://ingenrobots.no/robots.txt": { status: 404, body: "not found", contentType: "text/plain" },
        "https://ingenrobots.no/products.json?limit=250": {
          body: JSON.stringify({ products: [{ title: "Egg", handle: "egg", variants: [{ title: "Default Title", price: "60.00" }] }] }),
          contentType: "application/json",
        },
      });
      const r = await ex.extractProductsFromWebsite("https://ingenrobots.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "ok", "robots 404 → allowed");
    }
    // robots.txt 503 twice → fetch_failed, nothing else fetched.
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({ "https://nede.no/robots.txt": { status: 503, body: "down", contentType: "text/plain" } });
      const r = await ex.extractProductsFromWebsite("https://nede.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "fetch_failed:http_5xx", "robots 5xx → fetch_failed:http_5xx (never assumed allowed)");
      assertTrue(f.calls.every((u) => u.endsWith("/robots.txt")), "robots 5xx: no page fetched");
    }

    // ── AC3: Shopify ───────────────────────────────────────────────────────
    robots.__clearRobotsCacheForTesting();
    {
      const shopify = {
        products: [
          { title: "Lammelår", handle: "lammelar", variants: [{ title: "1 kg", price: "289.00" }] },
          {
            title: "Honning &amp; propolis",
            handle: "honning",
            variants: [
              { title: "250 g", price: "120.00" },
              { title: "500 g", price: "210.00" },
            ],
          },
          { title: "Gavekort", handle: "gavekort", variants: [] },
        ],
      };
      const f = makeFetch({
        "https://butikk.no/robots.txt": ROBOTS_OPEN,
        "https://butikk.no/products.json?limit=250": { body: JSON.stringify(shopify), contentType: "application/json" },
      });
      const r = await ex.extractProductsFromWebsite("https://butikk.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "ok", "AC3 shopify: ok");
      assertEq(r.tier, "shopify", "AC3 shopify: tier");
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.unit, x.price_is_from, x.source_url]),
        [
          ["Lammelår", 289, "kg", false, "https://butikk.no/products/lammelar"],
          ["Honning & propolis", 120, "g", true, "https://butikk.no/products/honning"],
          ["Gavekort", null, null, false, "https://butikk.no/products/gavekort"],
        ],
        "AC3 shopify: names, prices, units, from-price, source_url",
      );
      assertEq(f.calls.length, 2, "AC3 shopify: stops at tier 1 (robots + products.json)");
    }

    // ── AC3: WooCommerce Store API ─────────────────────────────────────────
    robots.__clearRobotsCacheForTesting();
    {
      const woo = [
        {
          name: "Storfe kjøttdeig pr kg",
          permalink: "https://www.gardwoo.no/produkt/kjottdeig/",
          prices: { price: "18900", currency_code: "NOK", currency_minor_unit: 2, price_range: null },
        },
        {
          name: "Pølsepakke",
          permalink: "https://annet-domene.no/x",
          prices: { price: "15000", currency_code: "NOK", currency_minor_unit: 2, price_range: { min_amount: "15000", max_amount: "25000" } },
        },
        { name: "Utenlandsk", permalink: "https://www.gardwoo.no/produkt/u/", prices: { price: "1000", currency_code: "EUR", currency_minor_unit: 2 } },
      ];
      const f = makeFetch({
        "https://www.gardwoo.no/robots.txt": ROBOTS_OPEN,
        "https://www.gardwoo.no/products.json?limit=250": { status: 404, body: "<html><body>nope</body></html>" },
        "https://www.gardwoo.no/wp-json/wc/store/v1/products?per_page=100": { body: JSON.stringify(woo), contentType: "application/json" },
      });
      const r = await ex.extractProductsFromWebsite("https://www.gardwoo.no/", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.tier, "woocommerce", "AC3 woo: tier");
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.unit, x.price_is_from, x.source_url]),
        [
          ["Storfe kjøttdeig pr kg", 189, "kg", false, "https://www.gardwoo.no/produkt/kjottdeig/"],
          ["Pølsepakke", 150, null, true, "https://www.gardwoo.no/wp-json/wc/store/v1/products"],
          ["Utenlandsk", null, null, false, "https://www.gardwoo.no/produkt/u/"],
        ],
        "AC3 woo: minor units, price range → from, off-host permalink not used, non-NOK price dropped",
      );
    }

    // ── AC3: JSON-LD Product / Offer ───────────────────────────────────────
    robots.__clearRobotsCacheForTesting();
    {
      const ld1 = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Røkt laks",
        offers: {
          "@type": "Offer",
          price: "349.00",
          priceCurrency: "NOK",
          priceSpecification: { "@type": "UnitPriceSpecification", price: "349.00", priceCurrency: "NOK", referenceQuantity: { unitCode: "KGM" } },
        },
      };
      const ld2 = {
        "@graph": [
          { "@type": "WebPage", name: "Produkter" },
          { "@type": ["Product"], name: "Fiskesuppe", url: "/produkter/suppe", offers: { "@type": "AggregateOffer", lowPrice: "95", highPrice: "180", priceCurrency: "NOK" } },
        ],
      };
      const productPage = `<!doctype html><html><head>
        <script type="application/ld+json">${JSON.stringify(ld1)}</script>
        <script type="application/ld+json">${JSON.stringify(ld2)}</script>
        <script type="application/ld+json">{"@type":"Product","name":"Ødelagt",</script>
        </head><body><h1>Våre produkter</h1></body></html>`;
      const f = makeFetch({
        "https://fisk.no/robots.txt": ROBOTS_OPEN,
        "https://fisk.no/": { body: HTML('<a href="/produkter">Produkter</a> <a href="/kontakt">Kontakt</a> <a href="https://facebook.com/produkter">FB</a>') },
        "https://fisk.no/produkter": { body: productPage },
      });
      const r = await ex.extractProductsFromWebsite("https://fisk.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.tier, "jsonld", "AC3 jsonld: tier");
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.unit, x.price_is_from, x.source_url]),
        [
          ["Røkt laks", 349, "kg", false, "https://fisk.no/produkter"],
          ["Fiskesuppe", 95, null, true, "https://fisk.no/produkter/suppe"],
        ],
        "AC3 jsonld: Offer + unitCode, AggregateOffer → from, @graph, invalid block ignored (not repaired)",
      );
      assertTrue(!f.calls.some((u) => u.includes("facebook.com")), "AC5: off-host link never fetched");
      assertTrue(r.rejected_urls.some((x) => x.url.startsWith("https://facebook.com") && x.reason === "other_host"), "AC5: off-host link recorded as rejected");
      assertTrue(!f.calls.includes("https://fisk.no/kontakt"), "links: non-product page not fetched");
    }

    // ── AC4: LLM grounding ─────────────────────────────────────────────────
    const llmSite = (host: string) => ({
      [`https://${host}/robots.txt`]: ROBOTS_OPEN,
      [`https://${host}/`]: { body: HTML(`<a href="/priser">Priser</a><p>Velkommen til ${host}. Vi er en liten gård med sau og høner.</p>`) },
      [`https://${host}/priser`]: {
        body: HTML("<h1>Prisliste</h1><ul><li>Lammelår 250 kr/kg</li><li>Honning – ring for pris</li><li>Egg, 12 stk: 60,-</li></ul><p>Henting på gården lørdager.</p>"),
      },
    });
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch(llmSite("sau.no"));
      let prompt = "";
      const r = await ex.extractProductsFromWebsite("https://sau.no", {
        fetchImpl: f.impl,
        llm: async (pr) => {
          prompt = pr;
          return {
            text: JSON.stringify([
              { name: "Lammelår", price: "250 kr/kg", unit: "kg" },
              { name: "Honning", price: "199 kr", unit: null },
              { name: "Elgpølse", price: "89 kr", unit: "stk" },
              { name: "Egg, 12 stk", price: "60,-", unit: "stk" },
            ]),
          };
        },
      });
      assertEq(r.tier, "llm", "AC4: tier llm");
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.unit, x.source_url]),
        [
          ["Lammelår", 250, "kg", "https://sau.no/priser"],
          ["Honning", null, null, "https://sau.no/priser"],
          ["Egg, 12 stk", 60, "stk", "https://sau.no/priser"],
        ],
        "AC4: ungrounded price dropped (product kept), ungrounded name dropped",
      );
      assertEq(r.grounding, { llm_candidates: 4, names_rejected: 1, prices_rejected: 1 }, "AC4: grounding counts");
      assertEq(r.llm_calls, 1, "AC4: one LLM call");
      assertTrue(prompt.indexOf("Prisliste") < prompt.indexOf("Velkommen"), "AC4: product page text before homepage text");
    }
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch(llmSite("ugyldig.no"));
      const r = await ex.extractProductsFromWebsite("https://ugyldig.no", {
        fetchImpl: f.impl,
        llm: async () => ({ text: '[{"name":"Lammelår","price":"250 kr"},' }),
      });
      assertEq([r.outcome, r.llm_status, r.products.length], ["no_products_found", "invalid_json", 0], "AC4: invalid JSON stays invalid → nothing extracted");
    }
    assertEq(llmMod.parseLlmAnswer('```json\n[{"name":"A","price":null}]\n```').status, "ok", "AC4: a complete code fence is unwrapped");
    assertEq(llmMod.parseLlmAnswer('```json\n[{"name":"A"}').status, "invalid_json", "AC4: half a fence is not repaired");
    assertEq(llmMod.parseLlmAnswer("[{'name':'A'}]").status, "invalid_json", "AC4: single-quoted JSON not repaired");
    assertEq(llmMod.parseLlmAnswer('{"name":"A"}').status, "not_array", "AC4: object is not an array");
    assertEq(llmMod.parseLlmAnswer("INGEN_PRODUKTER_FUNNET").status, "sentinel", "AC4: sentinel");
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch(llmSite("oppdiktet.no"));
      const r = await ex.extractProductsFromWebsite("https://oppdiktet.no", {
        fetchImpl: f.impl,
        llm: async () => ({ text: '[{"name":"Reinsdyrfilet","price":"499 kr"},{"name":"Elgpølse","price":null}]' }),
      });
      assertEq(r.outcome, "grounding_rejected_all", "AC4: every name ungrounded → grounding_rejected_all");
    }
    // Shared LLM budget: exhausted → model not called.
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch(llmSite("budsjett.no"));
      const budget = { cap: 1, used: 1 };
      const r = await ex.extractProductsFromWebsite("https://budsjett.no", { fetchImpl: f.impl, llm: noLlm, llmBudget: budget });
      assertEq([r.outcome, r.llm_status, r.llm_calls, budget.used], ["no_products_found", "budget_exhausted", 0, 1], "LLM cap: no call past the cap");
    }

    // ── Accuracy rules (prod measurement 2026-10-29, 70.6 %) ──────────────
    // A2A reports/2026-10-29-produktimport-maaling.md, error types 1–4.
    const wooItem = (o: Record<string, any>) => ({
      id: 1,
      type: "simple",
      is_purchasable: true,
      is_in_stock: true,
      is_password_protected: false,
      categories: [],
      add_to_cart: { text: "Legg i handlekurv" },
      ...o,
      prices: {
        currency_code: "NOK",
        currency_minor_unit: 2,
        price_range: null,
        ...(o.prices ?? {}),
      },
    });
    robots.__clearRobotsCacheForTesting();
    {
      // Shapes copied from real Store API responses (bjerkemat.no,
      // ergagardsutsalg.no, torresvangen.no, kringler.no — 2026-10-29).
      const woo = [
        wooItem({ name: "Brie de Paris", permalink: "https://gardwoo2.no/produkt/brie-de-paris/", is_purchasable: false, add_to_cart: { text: "Les mer" }, prices: { price: "0", regular_price: "0" } }),
        wooItem({ name: "Kvitlin", permalink: "https://gardwoo2.no/produkt/kvitlin/", add_to_cart: { text: "Skriv inn sum" }, prices: { price: "0", regular_price: "0" } }),
        wooItem({ name: "Julepølser 500 g", permalink: "https://gardwoo2.no/produkt/julepolser-500-g/", categories: [{ name: "Gårdsmat" }], prices: { price: "11500" } }),
        wooItem({ name: "Gammel stabbur-pris", permalink: "https://gardwoo2.no/produkt/gammel/", is_purchasable: false, prices: { price: "9900" } }),
        wooItem({ name: "Kjøttpakke", type: "variable", permalink: "https://gardwoo2.no/produkt/kjottpakke/", prices: { price: "120000", price_range: { min_amount: "120000", max_amount: "180000" } } }),
        wooItem({ name: "Veterinærtreff (91) på Kringler Gjestegård 3.april 2027", type: "variable", is_password_protected: true, permalink: "https://gardwoo2.no/nettbutikk/veterinaertreff/", prices: { price: "285000", price_range: { min_amount: "285000", max_amount: "465000" } } }),
        wooItem({ name: "Operapub på gården fredag 18. desember", permalink: "https://gardwoo2.no/nettbutikk/operapub/", categories: [{ name: "Arrangement" }], prices: { price: "37500" } }),
        wooItem({ name: "Ostesmaking for grupper", permalink: "https://gardwoo2.no/nettbutikk/ostesmaking/", prices: { price: "45000" } }),
        wooItem({ name: "Gavekort hos partner", type: "external", is_purchasable: false, permalink: "https://gardwoo2.no/produkt/gavekort/", prices: { price: "50000" } }),
      ];
      const f = makeFetch({
        "https://gardwoo2.no/robots.txt": ROBOTS_OPEN,
        "https://gardwoo2.no/wp-json/wc/store/v1/products?per_page=100": { body: JSON.stringify(woo), contentType: "application/json" },
      });
      const r = await ex.extractProductsFromWebsite("https://gardwoo2.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.tier, "woocommerce", "rules woo: tier");
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.price_is_from, x.rules]),
        [
          ["Brie de Paris", null, false, ["price_not_purchasable"]],
          ["Kvitlin", null, false, ["price_zero_dropped"]],
          ["Julepølser 500 g", 115, false, []],
          ["Gammel stabbur-pris", null, false, ["price_not_purchasable"]],
          ["Kjøttpakke", 1200, true, []],
          ["Gavekort hos partner", 500, false, []],
        ],
        "rules woo: not purchasable / price 0 → no price; normal item unchanged; variation range → lowest + from",
      );
      assertEq(r.products[0]!.raw_price_text, "price=0 minor=2 NOK", "rules woo: raw Store API price kept for audit");
      assertEq(r.products[2]!.price_text, "115 NOK", "rules woo: normal item price text unchanged");
      assertEq(
        r.excluded.map((x) => [x.name, x.reason]),
        [
          ["Veterinærtreff (91) på Kringler Gjestegård 3.april 2027", "excluded_password_protected"],
          ["Operapub på gården fredag 18. desember", "excluded_event_category"],
          ["Ostesmaking for grupper", "excluded_service"],
        ],
        "rules woo: password-protected, the shop's «Arrangement» category (import-only) and service (gate classifier) excluded with reason",
      );
    }
    // A Woo shop selling only events: the tier found candidates and excluded
    // them all → no_products_found, NO fall-through to HTML/LLM, no duplicates.
    for (const [host, items] of [
      ["bare-event.no", [wooItem({ name: "Operapub fredag 18. desember", permalink: "https://bare-event.no/x/", categories: [{ name: "Arrangement" }], prices: { price: "37500" } })]],
      ["bare-smaking.no", [wooItem({ name: "Ostesmaking for grupper", permalink: "https://bare-smaking.no/x/", prices: { price: "45000" } })]],
    ] as Array<[string, any[]]>) {
      robots.__clearRobotsCacheForTesting();
      const f = makeFetch({
        [`https://${host}/robots.txt`]: ROBOTS_OPEN,
        [`https://${host}/wp-json/wc/store/v1/products?per_page=100`]: { body: JSON.stringify(items), contentType: "application/json" },
        [`https://${host}/`]: { body: HTML('<a href="/priser">Priser</a><p>Operapub fredag 18. desember 375 kr. Ostesmaking for grupper 450 kr.</p>') },
      });
      const r = await ex.extractProductsFromWebsite(`https://${host}`, { fetchImpl: f.impl, llm: noLlm });
      assertEq(
        [r.outcome, r.tier, r.products.length, r.llm_calls, r.excluded.length],
        ["no_products_found", null, 0, 0, 1],
        `rules woo ${host}: events-only shop → no_products_found, no LLM call, one exclusion`,
      );
      assertTrue(!f.calls.includes(`https://${host}/`), `rules woo ${host}: no fall-through to the homepage`);
    }
    // Shopify variants at different prices → lowest + from (unchanged rule, pinned).
    robots.__clearRobotsCacheForTesting();
    {
      const shopify = {
        products: [
          { title: "Spekeskinke", handle: "spekeskinke", variants: [{ title: "Hel", price: "1890.00" }, { title: "Halv", price: "990.00" }, { title: "Skiver 100 g", price: "179.00" }] },
          { title: "Gratisprøve", handle: "prove", variants: [{ title: "Default Title", price: "0.00" }] },
          { title: "Ostesmaking", handle: "ostesmaking", variants: [{ title: "Default Title", price: "450.00" }] },
        ],
      };
      const f = makeFetch({
        "https://shopvar.no/robots.txt": ROBOTS_OPEN,
        "https://shopvar.no/products.json?limit=250": { body: JSON.stringify(shopify), contentType: "application/json" },
      });
      const r = await ex.extractProductsFromWebsite("https://shopvar.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.price_is_from, x.raw_price_text, x.rules]),
        [
          ["Spekeskinke", 179, true, "1890.00 | 990.00 | 179.00", []],
          ["Gratisprøve", null, false, "0.00", ["price_zero_dropped"]],
        ],
        "rules shopify: variants at different prices → lowest + from; price 0 → no price",
      );
      assertEq(r.excluded.map((x) => [x.name, x.reason, x.tier]), [["Ostesmaking", "excluded_service", "shopify"]], "rules shopify: service excluded by the gate classifier");
    }

    // LLM tier: pack weight, unit price, several prices, placeholder.
    robots.__clearRobotsCacheForTesting();
    {
      const host = "pakke.no";
      const page = HTML(
        "<h1>Prisliste</h1><ul>" +
          "<li>Poteter 10 kg 160,-</li>" +
          "<li>Lam, 189 kr/kg</li>" +
          "<li>Kjøttdeigspakken</li><li>5kg. 1.200,-</li>" +
          "<li>Kokos, mango &amp; pasjonsfrukt 585,- 8-10 porsjoner / 985,- 16-20 porsjoner</li>" +
          "<li>Sommerhonning fra Lillestrøm, 250g 0 NOK – kommer høsten</li>" +
          "<li>Høsthonning 150 kr – kommer høsten</li>" +
          "<li>Lammelår 299 kr</li>" +
          "<li>Juleribbe – kommer i desember 349 kr</li>" +
          "<li>Gårdsomvisning 250 kr</li>" +
          "</ul>",
      );
      const f = makeFetch({
        [`https://${host}/robots.txt`]: ROBOTS_OPEN,
        [`https://${host}/`]: { body: HTML('<a href="/priser">Priser</a><p>Velkommen til gården.</p>') },
        [`https://${host}/priser`]: { body: page },
      });
      const r = await ex.extractProductsFromWebsite(`https://${host}`, {
        fetchImpl: f.impl,
        llm: async () => ({
          text: JSON.stringify([
            { name: "Poteter 10 kg", price: "160,-", unit: "kg" },
            { name: "Lam", price: "189 kr", unit: "kg" },
            { name: "Kjøttdeigspakken", price: "1.200,-", unit: "kg" },
            { name: "Kokos, mango & pasjonsfrukt", price: "585,- / 985,-", unit: null },
            { name: "Sommerhonning fra Lillestrøm, 250g", price: "0 NOK", unit: "g" },
            { name: "Høsthonning", price: "150 kr – kommer høsten", unit: null },
            { name: "Lammelår", price: "299 kr", unit: "kg" },
            { name: "Juleribbe – kommer i desember", price: "349 kr", unit: null },
            { name: "Gårdsomvisning", price: "250 kr", unit: null },
          ]),
        }),
      });
      assertEq(r.tier, "llm", "rules llm: tier");
      assertEq(
        r.products.map((x) => [x.name, x.price_nok, x.unit, x.pack_size, x.price_is_from, x.rules]),
        [
          ["Poteter 10 kg", 160, "pakke", "10 kg", false, ["unit_pack_weight"]],
          ["Lam", 189, "kg", null, false, []],
          ["Kjøttdeigspakken", 1200, "pakke", "5 kg", false, ["unit_pack_weight"]],
          ["Kokos, mango & pasjonsfrukt", 585, null, null, true, ["price_multiple_lowest"]],
          ["Sommerhonning fra Lillestrøm, 250g", null, null, null, false, ["price_zero_dropped"]],
          ["Høsthonning", null, null, null, false, ["price_placeholder_dropped"]],
          ["Lammelår", 299, null, null, false, ["unit_unstated_dropped"]],
          ["Juleribbe – kommer i desember", 349, null, null, false, []],
        ],
        "rules llm: pack weight → pakke (name keeps «10 kg»); explicit kr/kg → kg; 585/985 → 585 + from; 0 NOK and «kommer høsten» → no price",
      );
      assertEq(r.products[0]!.raw_price_text, "160,-", "rules llm: the model's raw price kept for audit");
      assertEq(r.excluded.map((x) => [x.name, x.reason, x.tier]), [["Gårdsomvisning", "excluded_service", "llm"]], "rules llm: service excluded by the gate classifier");
    }
    // Pure helpers.
    assertEq(norm.statesUnitPrice("Lam, 189 kr/kg", "kg"), true, "statesUnitPrice: kr/kg");
    assertEq(norm.statesUnitPrice("155,- kiloen inkl. mva", "kg"), true, "statesUnitPrice: kiloen");
    assertEq(norm.statesUnitPrice("45 kr pr. liter", "l"), true, "statesUnitPrice: pr. liter");
    assertEq(norm.statesUnitPrice("Poteter 10 kg 160,-", "kg"), false, "statesUnitPrice: pack weight is not a unit price");
    assertEq(norm.statesUnitPrice("à 500 g", "g"), false, "statesUnitPrice: «à 500 g» is a pack");
    assertEq(norm.nokPriceValues("kr 585,- / 985,-"), [585, 985], "nokPriceValues: two variants");
    assertEq(norm.nokPriceValues("585,- 8-10 porsjoner / 985,- 16-20 porsjoner"), [585, 985], "nokPriceValues: portion counts are not prices");
    assertEq(norm.nokPriceValues("1.200,-"), [1200], "nokPriceValues: thousands");
    assertEq(norm.nokPriceValues("150–250 kr"), [150, 250], "nokPriceValues: range");
    assertEq(norm.packSizeIn("5kg. 1.200,-"), "5 kg", "packSizeIn: 5kg.");
    const rulesMod = require("./rules") as typeof import("./rules");
    assertEq(
      [rulesMod.isEventShopCategory("Gårdsmat Arrangement"), rulesMod.isEventShopCategory("Arrangementer"), rulesMod.isEventShopCategory("Arrangementsmat"), rulesMod.isEventShopCategory("Gårdsmat")],
      [true, true, false, false],
      "isEventShopCategory: whole token only",
    );
    assertTrue(llmMod.buildProductImportPrompt("x").includes("pakkestørrelsen"), "prompt: pack-weight rule stated");

    // ── AC5: host + SSRF ───────────────────────────────────────────────────
    {
      const allowed = ex.allowedHostsFor("gard.no");
      assertEq(ex.isAllowedHost("https://www.gard.no/x", allowed), true, "AC5: www variant allowed");
      assertEq(ex.isAllowedHost("https://gard.no.evil.com/x", allowed), false, "AC5: suffix trick rejected");
      assertEq(ex.isAllowedHost("https://shop.gard.no/x", allowed), false, "AC5: other subdomain rejected");
    }
    for (const bad of [
      "http://192.168.1.10/", "http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080", "http://localhost/",
      "http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:0:10.0.0.1]/", "http://[::ffff:7f00:1]/",
      "http://[::]/", "http://[::1]/", "http://[64:ff9b::192.168.1.1]/", "http://[fc00::1]/", "http://[fd12::1]/", "http://[fe80::1]/",
    ]) {
      const f = makeFetch({});
      const r = await ex.extractProductsFromWebsite(bad, { fetchImpl: f.impl, llm: noLlm });
      assertEq([r.outcome, f.calls.length], ["fetch_failed:ssrf_blocked", 0], `AC5: private target rejected before any request (${bad})`);
    }
    {
      const { isSafeFetchUrl } = require("../fetch-page") as typeof import("../fetch-page");
      for (const pub of ["http://[2001:4860:4860::8888]/", "http://[2a00:1450:400f:80d::200e]/", "http://[::ffff:8.8.8.8]/", "https://gard.no/"]) {
        assertEq(isSafeFetchUrl(pub), true, `AC5: public address still allowed (${pub})`);
      }
    }
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({
        "https://redir.no/robots.txt": ROBOTS_OPEN,
        "https://redir.no/": { body: HTML("<p>Lammelår 250 kr. Mye tekst her om gården og produktene som selges gjennom hele året.</p>"), url: "https://annen-vert.no/" },
      });
      const r = await ex.extractProductsFromWebsite("https://redir.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "fetch_failed:offhost", "AC5: redirect to another host → body discarded");
    }

    // ── js_unreadable / fetch failures ─────────────────────────────────────
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({
        "https://spa.no/robots.txt": ROBOTS_OPEN,
        "https://spa.no/": { body: '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div><noscript>Aktiver JavaScript</noscript></body></html>' },
      });
      const r = await ex.extractProductsFromWebsite("https://spa.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "js_unreadable", "js_unreadable: near-empty page, no LLM call");
    }
    robots.__clearRobotsCacheForTesting();
    {
      const f = makeFetch({
        "https://feil.no/robots.txt": ROBOTS_OPEN,
        "https://feil.no/": { status: 503, body: "Service Unavailable", contentType: "text/plain" },
      });
      const r = await ex.extractProductsFromWebsite("https://feil.no", { fetchImpl: f.impl, llm: noLlm });
      assertEq(r.outcome, "fetch_failed:http_5xx", "fetch_failed:<reason> from fetchPage");
    }
    assertEq((await ex.extractProductsFromWebsite("ikke en url ://", { llm: noLlm })).outcome, "fetch_failed:invalid_url", "invalid URL");
    // Fetch cap: never more than PRODUCT_IMPORT_MAX_FETCHES counted requests.
    robots.__clearRobotsCacheForTesting();
    {
      const links = Array.from({ length: 20 }, (_, i) => `<a href="/produkt-${i}">Produkt ${i}</a>`).join(" ");
      const f = makeFetch({
        "https://mange.no/robots.txt": ROBOTS_OPEN,
        "https://mange.no/": { body: HTML(links + "<p>" + "Gårdsbutikk med mye tekst. ".repeat(10) + "</p>") },
      });
      const r = await ex.extractProductsFromWebsite("https://mange.no", {
        fetchImpl: f.impl,
        llm: async () => ({ text: "INGEN_PRODUKTER_FUNNET" }),
      });
      assertEq(r.pages_fetched, ex.PRODUCT_IMPORT_MAX_FETCHES, "fetch cap: pages_fetched = max");
      assertEq(f.calls.filter((u) => !u.endsWith("/robots.txt")).length <= ex.PRODUCT_IMPORT_MAX_FETCHES * 2, true, "fetch cap: bounded requests (incl. retries)");
      assertEq(new Set(f.calls.filter((u) => /produkt-/.test(u))).size, ex.PRODUCT_IMPORT_MAX_FETCHES - 3, "fetch cap: product pages fill the remaining budget only");
    }
    // Per-host pacing waits between two requests to one host.
    {
      let t = 0;
      const slept: number[] = [];
      const pacer = new ex.HostPacer(1000, () => t, async (ms) => {
        slept.push(ms);
        t += ms;
      });
      await pacer.wait("a.no");
      await pacer.wait("www.a.no");
      await pacer.wait("b.no");
      assertEq(slept, [1000], "pacing: www twin shares the host slot; other host not delayed");
    }

    // ── AC1 + flag: the dry-run endpoint ───────────────────────────────────
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevFlag = process.env.PRODUCT_IMPORT_DRYRUN_ENABLED;
    const initMod = require("../../database/init") as typeof import("../../database/init");
    const restoreDb = initMod.__pinInMemoryDbForTesting();
    const dry = require("./dry-run") as typeof import("./dry-run");
    try {
      const key = "product-import-test-key";
      process.env.ADMIN_KEY = key;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const db = initMod.getDb();
      const addAgent = (id: string, o: { verified?: number; umbrella?: string | null; website?: string | null }) => {
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified, umbrella_type)
           VALUES (?, ?, 'd', 'p', ?, 'https://x', 'producer', ?, ?, ?)`,
        ).run(id, `Gård ${id}`, `${id}@ex.no`, `key-${id}`, o.verified ?? 0, o.umbrella ?? null);
        db.prepare(`INSERT INTO agent_knowledge (agent_id, website, products) VALUES (?, ?, ?)`).run(
          id,
          o.website ?? null,
          JSON.stringify([{ name: "Eksisterende vare" }]),
        );
      };
      addAgent("pi-own-1", { verified: 1, website: "https://eier1.no" });
      addAgent("pi-own-2", { verified: 1, website: "https://eier2.no" });
      addAgent("pi-un-1", { website: "https://uten1.no" });
      addAgent("pi-un-2", { website: "https://uten2.no" });
      addAgent("pi-umbrella", { umbrella: "venue", website: "https://paraply.no" });
      addAgent("pi-nosite", { website: "  " });
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, source) VALUES ('prod-1', 'pi-own-1', 'Eksisterende vare', 'eksisterende vare', 100, 'enrichment')`,
      ).run();

      const snapshot = () =>
        JSON.stringify({
          k: db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all(),
          p: db.prepare(`SELECT * FROM products ORDER BY id`).all(),
          kc: db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge`).get(),
          pc: db.prepare(`SELECT COUNT(*) AS n FROM products`).get(),
        });
      const before = snapshot();

      // Sampling (read-only): umbrella and no-website rows never selected; stratified.
      const all = dry.selectDryRunSample({ sampleSize: 100 }).map((r) => r.agent_id).sort();
      assertEq(all, ["pi-own-1", "pi-own-2", "pi-un-1", "pi-un-2"], "sample: umbrellas and rows without website excluded");
      const two = dry.selectDryRunSample({ sampleSize: 2 });
      assertEq([two.filter((r) => r.is_owned === 1).length, two.filter((r) => r.is_owned === 0).length], [1, 1], "sample: stratified owned/unowned");
      assertEq(dry.selectDryRunSample({ agentIds: ["pi-umbrella", "pi-un-1"] }).map((r) => r.agent_id), ["pi-un-1"], "sample: agentIds still filtered");

      // Fake network for the four sample sites.
      const routes: Record<string, FakeRoute> = {};
      for (const h of ["eier1.no", "eier2.no", "uten1.no", "uten2.no"]) {
        routes[`https://${h}/robots.txt`] = ROBOTS_OPEN;
      }
      routes["https://eier1.no/products.json?limit=250"] = {
        body: JSON.stringify({ products: [{ title: "Lammelår", handle: "lam", variants: [{ title: "1 kg", price: "289.00" }] }] }),
        contentType: "application/json",
      };
      routes["https://uten1.no/robots.txt"] = { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" };
      Object.assign(routes, llmSite("eier2.no"));
      routes["https://uten2.no/"] = { status: 503, body: "down", contentType: "text/plain" };
      const f = makeFetch(routes);
      robots.__clearRobotsCacheForTesting();
      dry.__setDryRunDepsForTesting({
        fetchImpl: f.impl,
        llm: async () => ({ text: '[{"name":"Lammelår","price":"250 kr/kg"},{"name":"Honning","price":"99 kr"}]' }),
        sleep: async () => {},
        hostIntervalMs: 0,
      });

      const router = (require("../../routes/admin-product-import") as { default: any }).default;

      // Flag off → 404 (even with the key).
      delete process.env.PRODUCT_IMPORT_DRYRUN_ENABLED;
      const off = await callRoute(router, { method: "POST", path: "/dry-run", headers: { "x-admin-key": key }, body: {} });
      assertEq(off.status, 404, "flag off: POST → 404");
      const offGet = await callRoute(router, { method: "GET", path: "/dry-run/x", headers: { "x-admin-key": key } });
      assertEq(offGet.status, 404, "flag off: GET → 404");
      assertEq(f.calls.length, 0, "flag off: nothing fetched");

      process.env.PRODUCT_IMPORT_DRYRUN_ENABLED = "1";
      const noKey = await callRoute(router, { method: "POST", path: "/dry-run", body: {} });
      assertTrue(noKey.status === 401 || noKey.status === 403, "AC1: no X-Admin-Key → 401/403");
      const wrongKey = await callRoute(router, { method: "POST", path: "/dry-run", headers: { "x-admin-key": "nope" }, body: {} });
      assertEq(wrongKey.status, 403, "AC1: wrong key → 403");
      const badBody = await callRoute(router, { method: "POST", path: "/dry-run", headers: { "x-admin-key": key }, body: { agentIds: "x" } });
      assertEq(badBody.status, 400, "body validation: agentIds must be a list");

      const started = await callRoute(router, { method: "POST", path: "/dry-run", headers: { "x-admin-key": key }, body: { sampleSize: 100 } });
      assertEq(started.status, 202, "AC1: with key → 202");
      assertEq(started.body.profiles_total, 4, "AC1: four profiles sampled");
      const runId = String(started.body.run_id);
      const busy = await callRoute(router, { method: "POST", path: "/dry-run", headers: { "x-admin-key": key }, body: {} });
      assertEq(busy.status, 409, "one run at a time → 409");
      await dry.__awaitDryRunForTesting(runId);

      const got = await callRoute(router, { method: "GET", path: `/dry-run/${runId}`, headers: { "x-admin-key": key } });
      assertEq(got.status, 200, "GET run → 200");
      assertEq(got.body.status, "completed", "run completed");
      assertEq(got.body.mode, "dry_run", "mode dry_run");
      const byId = Object.fromEntries((got.body.results as any[]).map((r) => [r.agent_id, r]));
      assertEq(
        [byId["pi-own-1"]?.outcome, byId["pi-own-2"]?.outcome, byId["pi-un-1"]?.outcome, byId["pi-un-2"]?.outcome],
        ["ok", "ok", "robots_blocked", "fetch_failed:http_5xx"],
        "per-profile outcomes",
      );
      assertEq(byId["pi-own-1"]?.candidates?.[0], {
        name: "Lammelår", price_nok: 289, price_text: "289 NOK", unit: "kg", price_is_from: false,
        source_url: "https://eier1.no/products/lam", tier: "shopify",
        raw_price_text: "289.00", pack_size: null, rules: [],
      }, "candidate carries source_url, tier and the audit fields (raw price, pack size, rules)");
      assertEq(byId["pi-own-1"]?.excluded, [], "result carries the excluded list");
      const s = got.body.summary;
      assertEq(sortKeys(s.outcome_counts), sortKeys({ ok: 2, robots_blocked: 1, "fetch_failed:http_5xx": 1 }), "summary: per-outcome counts");
      assertEq(sortKeys(s.tier_counts), sortKeys({ shopify: 1, llm: 1, none: 2 }), "summary: tier distribution");
      assertEq([s.profiles_with_priced_product, s.share_with_priced_product], [2, 0.5], "summary: share with ≥1 priced product");
      assertEq(s.grounding.prices_rejected, 1, "summary: grounding price rejections");
      assertEq([s.llm_calls_total, got.body.llm_calls], [1, 1], "summary: LLM calls");
      assertTrue(typeof s.duration_ms?.mean_per_profile === "number", "summary: time per profile");
      assertTrue(typeof s.products_per_profile?.mean_with_products === "number", "summary: products per profile");
      assertEq(s.by_ownership.owned.profiles, 2, "summary: by ownership");
      assertEq([s.excluded_total, s.excluded_reasons, typeof s.rule_counts], [0, {}, "object"], "summary: rule audit fields");
      const noCand = await callRoute(router, { method: "GET", path: `/dry-run/${runId}`, headers: { "x-admin-key": key } });
      assertTrue(Array.isArray(noCand.body.results), "GET results list");
      const list = await callRoute(router, { method: "GET", path: "/dry-run", headers: { "x-admin-key": key } });
      assertEq(list.body.count, 1, "GET list → one run");

      // AC1: agent_knowledge and products untouched (row count AND content).
      assertEq(snapshot(), before, "AC1: agent_knowledge + products unchanged after the run");
      assertEq((db.prepare(`SELECT COUNT(*) AS n FROM product_import_run_results WHERE run_id = ?`).get(runId) as any).n, 4, "results stored in product_import_run_results");

      // llmCallCap 0 → the LLM tier never runs.
      robots.__clearRobotsCacheForTesting();
      dry.__setDryRunDepsForTesting({ fetchImpl: f.impl, llm: noLlm, sleep: async () => {}, hostIntervalMs: 0 });
      const capped = await callRoute(router, { method: "POST", path: "/dry-run", headers: { "x-admin-key": key }, body: { agentIds: ["pi-own-2"], llmCallCap: 0 } });
      assertEq(capped.status, 202, "cap run started");
      await dry.__awaitDryRunForTesting(String(capped.body.run_id));
      const cappedRun = dry.getDryRun(String(capped.body.run_id))!;
      assertEq([cappedRun.results[0]?.outcome, cappedRun.results[0]?.llm_status, cappedRun.llm_calls], ["no_products_found", "budget_exhausted", 0], "LLM cap 0: no model call");
      assertEq(dry.getDryRun("pir-missing"), null, "unknown run → null");
      assertEq(snapshot(), before, "AC1: still unchanged after the second run");
    } finally {
      dry.__setDryRunDepsForTesting(null);
      robots.__clearRobotsCacheForTesting();
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsKey;
      if (prevFlag === undefined) delete process.env.PRODUCT_IMPORT_DRYRUN_ENABLED;
      else process.env.PRODUCT_IMPORT_DRYRUN_ENABLED = prevFlag;
      restoreDb();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runProductImportTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}

/**
 * site-diagnostics.test.ts — dev-request 2026-11-24-rfb-vareopphenting-til-
 * alle-eiere, slice 1 (measurement instrumentation before "måling 3").
 *
 *   D1  detectSitePlatform: one HTML fixture per platform fingerprint, the
 *       tier override, plain vs unknown.
 *   D2  diagnoseNoHit: one case per reason code.
 *   D3  the extractor attaches diagnostics while outcome / tier / products /
 *       requests are exactly what they were (no extra fetch).
 *   D4  summarizeDryRun: per-platform breakdown (owned / unowned) and
 *       no-hit reason counts; a stored row without diagnostics → unknown.
 *   D5  slice 2 — ReDoS hardening: every changed scanner finishes a ~200 KB
 *       hostile string in < 200 ms; discoverProductLinks / scanAnchorTags
 *       give exactly the old regex's links, order and rejects.
 *   D6  slice 2 — a mere mention of WooCommerce / Mystore in body text is no
 *       fingerprint; an asset path, handle, class or generator tag is.
 *   D7  slice 2 — an LLM call that failed (infra_failure / invalid_json /
 *       not_array) → `llm_failed`, counted by the dry-run summary.
 *
 * No network: an injected fake fetch; the LLM is an injected function.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type FakeRoute = { status?: number; body: string; contentType?: string };

function makeFetch(routes: Record<string, FakeRoute>) {
  const calls: string[] = [];
  const impl = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: "<html><body>404</body></html>" };
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ROBOTS_OPEN = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };
const HTML = (head: string, body: string) =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const FILLER = "<p>Velkommen til gården vår i dalen. Vi driver med sau, høner og bier, og har gårdsbutikk åpen hver lørdag hele sommeren.</p>";

export function runSiteDiagnosticsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const sd = require("./site-diagnostics") as typeof import("./site-diagnostics");
    const ex = require("./extractor") as typeof import("./extractor");
    const robots = require("./robots") as typeof import("./robots");
    const dry = require("./dry-run") as typeof import("./dry-run");

    // ── D1: platform fingerprints ──────────────────────────────────────────
    const fixtures: Array<[string, string, string]> = [
      ["shopify", HTML('<link href="https://cdn.shopify.com/s/files/1/theme.css" rel="stylesheet">', FILLER), "cdn.shopify.com"],
      ["shopify", HTML('<script>Shopify.theme = {"name":"Dawn"};</script>', FILLER), "Shopify.theme"],
      ["woocommerce", HTML('<link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">', FILLER), "woocommerce plugin assets"],
      ["woocommerce", HTML("", `<div class="wc-block-grid__products">${FILLER}</div>`), "wc-block class"],
      ["wix", HTML('<meta name="generator" content="Wix.com Website Builder">', FILLER), "wix generator meta"],
      ["wix", HTML("", `<img src="https://static.wixstatic.com/media/a.jpg">${FILLER}`), "wixstatic asset"],
      ["squarespace", HTML('<script src="https://static1.squarespace.com/static/x.js"></script>', FILLER), "squarespace asset"],
      ["mystore", HTML('<link rel="stylesheet" href="https://cdn.mystore.no/themes/a.css">', FILLER), "mystore asset"],
      ["webflow", `<html data-wf-site="5f1a" data-wf-page="5f1b"><body>${FILLER}</body></html>`, "data-wf-site"],
      ["jimdo", HTML('<link href="https://assets.jimstatic.com/web.css" rel="stylesheet">', FILLER), "jimstatic asset"],
      ["wordpress", HTML('<link rel="stylesheet" href="/wp-content/themes/gard/style.css">', FILLER), "wp-content without WooCommerce"],
      ["other_shop", HTML("", `${FILLER}<button class="add-to-cart">Kjøp</button>`), "generic add-to-cart"],
      ["other_shop", HTML("", `${FILLER}<a href="/handlekurv">Handlekurv</a>`), "Norwegian cart link"],
      ["plain", HTML("", FILLER), "readable HTML, no signal"],
      ["unknown", "", "no HTML"],
    ];
    for (const [want, html, label] of fixtures) {
      assertEq(sd.detectSitePlatform({ html }), want, `D1 platform: ${label} → ${want}`);
    }
    assertEq(sd.detectSitePlatform({ html: null }), "unknown", "D1 platform: null HTML → unknown");
    assertEq(
      sd.detectSitePlatform({ html: HTML('<link href="/wp-content/x.css">', FILLER), tier: "shopify" }),
      "shopify",
      "D1 platform: a shopify tier hit overrides the HTML",
    );
    assertEq(sd.detectSitePlatform({ html: "", tier: "woocommerce" }), "woocommerce", "D1 platform: woocommerce tier without HTML");
    assertEq(sd.detectSitePlatform({ html: HTML("", FILLER), tier: "jsonld" }), "plain", "D1 platform: jsonld tier does not decide the platform");
    assertEq(sd.detectSitePlatform({ html: "", headers: { "x-shopid": "123" } }), "shopify", "D1 platform: Shopify response header");
    assertEq(sd.detectSitePlatform({ html: HTML("", "<p>Se shopify.com for mer</p>") }), "plain", "D1 platform: a mere mention is no fingerprint");

    // ── D2: price text, pagination, reasons ────────────────────────────────
    assertEq(
      ["Honning kr 120", "Egg 60,-", "Lam 289 kr/kg", "NOK 1 250", "Pris: 45 kroner", "Ring for pris", "Åpent 10-16", "Tlf 22 33 44 55"].map(sd.hasNokPriceText),
      [true, true, true, true, true, false, false, false],
      "D2 price text: kr N / N,- / N kr / NOK N / N kroner yes; none, opening hours, phone no",
    );
    assertEq(
      ['<a href="/produkter?page=2">2</a>', '<a href="/butikk/page/2/">2</a>', '<a href="?side=2">Neste</a>', '<a href="/side-2">x</a>', '<a href="/page/12">x</a>'].map(sd.hasPaginationHint),
      [true, true, true, false, false],
      "D2 pagination: ?page=2, /page/2/, side=2 yes; others no",
    );
    const reason = (outcome: string, extra: Partial<{ llm_status: string; excluded_count: number; has_price_text: boolean }> = {}) =>
      sd.diagnoseNoHit({ outcome, has_price_text: false, ...extra }) ?? null;
    assertEq(
      [
        reason("ok"),
        reason("fetch_failed:http_5xx"),
        reason("robots_blocked"),
        reason("js_unreadable"),
        reason("grounding_rejected_all"),
        reason("no_products_found", { excluded_count: 2, llm_status: "budget_exhausted" }),
        reason("no_products_found", { llm_status: "budget_exhausted", has_price_text: true }),
        reason("no_products_found", { llm_status: "ok", has_price_text: true }),
        reason("no_products_found", { llm_status: "ok" }),
      ],
      [
        null,
        "fetch_failed",
        "robots_blocked",
        "js_shell",
        "grounding_rejected_all",
        "excluded_by_rules",
        "llm_budget_exhausted",
        "prices_on_page_not_extracted",
        "no_price_text",
      ],
      "D2 reasons: one per outcome / signal, exclusion before budget, price text before none",
    );

    // ── D3: extractor carries diagnostics, nothing else changes ────────────
    const noLlm = async () => {
      throw new Error("LLM must not be called");
    };
    const emptyLlm = async () => ({ text: "[]" });
    const sleep = async () => {};
    robots.__clearRobotsCacheForTesting();
    try {
      {
        const f = makeFetch({
          "https://diag-shop.no/robots.txt": ROBOTS_OPEN,
          "https://diag-shop.no/products.json?limit=250": {
            body: JSON.stringify({ products: [{ title: "Egg", handle: "egg", variants: [{ title: "Default Title", price: "60.00" }] }] }),
            contentType: "application/json",
          },
        });
        const r = await ex.extractProductsFromWebsite("https://diag-shop.no", { fetchImpl: f.impl, llm: noLlm, sleep });
        assertEq([r.outcome, r.tier, r.products.map((p) => [p.name, p.price_nok])], ["ok", "shopify", [["Egg", 60]]], "D3 shopify: outcome, tier, products as before");
        assertEq(f.calls, ["https://diag-shop.no/robots.txt", "https://diag-shop.no/products.json?limit=250"], "D3 shopify: no extra request");
        assertEq(r.diagnostics, { site_platform: "shopify", has_price_text: false, has_pagination_hint: false, pages_seen: 0 }, "D3 shopify: diagnostics from the tier, no reason");
      }
      {
        const home = HTML(
          '<link rel="stylesheet" href="/wp-content/themes/g/style.css">',
          `${FILLER}<a href="/produkter">Produkter</a>`,
        );
        const products = HTML("", `<h1>Produkter</h1><p>Honning 250 g kr 120</p><a href="/produkter/page/2/">Neste side</a>`);
        const f = makeFetch({
          "https://diag-wp.no/robots.txt": ROBOTS_OPEN,
          "https://diag-wp.no/": { body: home },
          "https://diag-wp.no/produkter": { body: products },
        });
        const r = await ex.extractProductsFromWebsite("https://diag-wp.no", { fetchImpl: f.impl, llm: emptyLlm, sleep });
        assertEq([r.outcome, r.tier, r.products.length, r.llm_calls, r.pages_fetched], ["no_products_found", null, 0, 1, 4], "D3 wordpress: outcome and counts as before");
        assertEq(
          f.calls,
          [
            "https://diag-wp.no/robots.txt",
            "https://diag-wp.no/products.json?limit=250",
            "https://diag-wp.no/wp-json/wc/store/v1/products?per_page=100",
            "https://diag-wp.no/",
            "https://diag-wp.no/produkter",
          ],
          "D3 wordpress: the same requests, none added (pagination link not followed)",
        );
        assertEq(
          r.diagnostics,
          { site_platform: "wordpress", has_price_text: true, has_pagination_hint: true, pages_seen: 2, no_hit_reason: "prices_on_page_not_extracted" },
          "D3 wordpress: platform, price text seen, pagination hint, reason",
        );
      }
      {
        const f = makeFetch({
          "https://diag-plain.no/robots.txt": ROBOTS_OPEN,
          "https://diag-plain.no/": { body: HTML("", FILLER) },
        });
        const r = await ex.extractProductsFromWebsite("https://diag-plain.no", {
          fetchImpl: f.impl,
          llm: noLlm,
          sleep,
          llmBudget: { cap: 0, used: 0 },
        });
        assertEq([r.outcome, r.llm_status, r.llm_calls], ["no_products_found", "budget_exhausted", 0], "D3 budget: outcome as before");
        assertEq([r.diagnostics?.site_platform, r.diagnostics?.no_hit_reason], ["plain", "llm_budget_exhausted"], "D3 budget: plain site, budget reason");
      }
      {
        const f = makeFetch({
          "https://diag-plain2.no/robots.txt": ROBOTS_OPEN,
          "https://diag-plain2.no/": { body: HTML("", FILLER) },
        });
        const r = await ex.extractProductsFromWebsite("https://diag-plain2.no", { fetchImpl: f.impl, llm: emptyLlm, sleep });
        assertEq([r.outcome, r.diagnostics?.no_hit_reason, r.diagnostics?.has_price_text], ["no_products_found", "no_price_text", false], "D3 no price text on the page");
      }
      {
        const f = makeFetch({
          "https://diag-wix.no/robots.txt": ROBOTS_OPEN,
          "https://diag-wix.no/": { body: HTML('<script src="https://static.parastorage.com/a.js"></script>', '<div id="root"></div>') },
        });
        const r = await ex.extractProductsFromWebsite("https://diag-wix.no", { fetchImpl: f.impl, llm: noLlm, sleep });
        assertEq([r.outcome, r.diagnostics?.site_platform, r.diagnostics?.no_hit_reason], ["js_unreadable", "wix", "js_shell"], "D3 js shell on Wix");
      }
      {
        const f = makeFetch({ "https://diag-block.no/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" } });
        const r = await ex.extractProductsFromWebsite("https://diag-block.no", { fetchImpl: f.impl, llm: noLlm, sleep });
        assertEq([r.outcome, r.diagnostics?.site_platform, r.diagnostics?.no_hit_reason], ["robots_blocked", "unknown", "robots_blocked"], "D3 robots blocked → unknown platform");
      }
      {
        const r = await ex.extractProductsFromWebsite("not a url at all ::", { llm: noLlm, sleep });
        assertEq([r.outcome, r.diagnostics?.no_hit_reason], ["fetch_failed:invalid_url", "fetch_failed"], "D3 invalid URL → fetch_failed");
      }
    } finally {
      robots.__clearRobotsCacheForTesting();
    }

    // ── D4: dry-run aggregation ────────────────────────────────────────────
    const base = (over: Record<string, unknown>) =>
      ({
        website: "x",
        outcome: "no_products_found",
        tier: null,
        products: [],
        excluded: [],
        pages_fetched: 1,
        fetched_urls: [],
        rejected_urls: [],
        robots_skipped: [],
        llm_calls: 0,
        llm_status: "not_needed",
        grounding: { llm_candidates: 0, names_rejected: 0, prices_rejected: 0 },
        duration_ms: 0,
        ...over,
      }) as any;
    const priced = [{ name: "Egg", price_nok: 60 }];
    const sum = dry.summarizeDryRun([
      { agent_id: "1", agent_name: "a", website: "a", is_owned: 1, result: base({ outcome: "ok", tier: "shopify", products: priced, diagnostics: { site_platform: "shopify", has_price_text: false, has_pagination_hint: false, pages_seen: 0 } }) },
      { agent_id: "2", agent_name: "b", website: "b", is_owned: 0, result: base({ diagnostics: { site_platform: "wix", no_hit_reason: "js_shell", has_price_text: false, has_pagination_hint: false, pages_seen: 1 } }) },
      { agent_id: "3", agent_name: "c", website: "c", is_owned: 0, result: base({ diagnostics: { site_platform: "wix", no_hit_reason: "prices_on_page_not_extracted", has_price_text: true, has_pagination_hint: true, pages_seen: 3 } }) },
      { agent_id: "4", agent_name: "d", website: "d", is_owned: 1, result: base({}) },
      { agent_id: "5", agent_name: "e", website: "e", is_owned: 0, result: base({ outcome: "ok", tier: "llm", products: [{ name: "Lam", price_nok: null }] }) },
    ]);
    const sdSum = sum.site_diagnostics;
    assertEq(
      sdSum.by_platform,
      {
        shopify: { sites: 1, ok: 1, priced: 1, owned: { sites: 1, ok: 1, priced: 1 }, unowned: { sites: 0, ok: 0, priced: 0 } },
        wix: { sites: 2, ok: 0, priced: 0, owned: { sites: 0, ok: 0, priced: 0 }, unowned: { sites: 2, ok: 0, priced: 0 } },
        unknown: { sites: 2, ok: 1, priced: 0, owned: { sites: 1, ok: 0, priced: 0 }, unowned: { sites: 1, ok: 1, priced: 0 } },
      },
      "D4 summary: per-platform sites / ok / priced, owned and unowned; rows without diagnostics → unknown",
    );
    assertEq(
      sdSum.no_hit_reason_counts,
      { js_shell: 1, prices_on_page_not_extracted: 1, unknown: 1 },
      "D4 summary: no-hit reasons counted for non-ok rows only; an old row → unknown",
    );
    assertEq([sdSum.pagination_hint_sites, sdSum.no_hit_with_price_text], [1, 1], "D4 summary: pagination hints and no-hit sites with price text");
    assertEq(sum.profiles_total, 5, "D4 summary: the existing fields are still there");

    // ── D5: ReDoS hardening (linear time) + link-scanner parity ────────────
    const HOSTILE = 200_000;
    const fast = (label: string, f: () => unknown) => {
      const t0 = Date.now();
      f();
      const ms = Date.now() - t0;
      assertEq(ms < 200 ? "fast" : `${ms} ms`, "fast", `D5 < 200 ms on ~200 KB: ${label}`);
    };
    const hostAllowed = ex.allowedHostsFor("garden.no");
    const rep = (unit: string) => unit.repeat(Math.ceil(HOSTILE / unit.length));
    fast("links: unclosed <a href=\"x\" repeated", () => ex.discoverProductLinks(rep('<a href="x"'), "https://garden.no/", hostAllowed, 8));
    fast("links: <a href=\"x\" + spaces, no >", () => ex.discoverProductLinks('<a href="x"' + " ".repeat(HOSTILE), "https://garden.no/", hostAllowed, 8));
    fast("links: <a <a href=… with a far >", () => ex.discoverProductLinks(rep('<a <a <a href="x" href="" ') + ">", "https://garden.no/", hostAllowed, 8));
    fast("links: anchors never closed by </a>", () => ex.discoverProductLinks(rep('<a href="/produkter">x'), "https://garden.no/", hostAllowed, 8));
    fast("pageTextOf: unclosed <script repeated", () => ex.pageTextOf(rep("<script")));
    fast("pageTextOf: unclosed <!-- repeated", () => ex.pageTextOf(rep("<!--")));
    fast("pageTextOf: < with no >", () => ex.pageTextOf(rep("<")));
    fast("pageTextOf: <br with no >", () => ex.pageTextOf(rep("<br")));
    fast("pageTextOf: whitespace run with no newline", () => ex.pageTextOf(rep("\r\f ")));
    fast("price text: long run of digit groups", () => sd.hasNokPriceText(rep("111 ")));
    fast("price text: long digit run", () => sd.hasNokPriceText("1".repeat(HOSTILE)));
    fast("platform: <meta name=\"generator\" repeated without >", () => sd.detectSitePlatform({ html: rep('<meta name="generator"') }));
    fast("platform: <meta repeated without >", () => sd.detectSitePlatform({ html: rep("<meta ") }));
    fast("platform: unclosed class= / id=wc- / mystore href", () =>
      sd.detectSitePlatform({ html: rep('class="') + rep('id="wc-') + rep('href="//a.mystore.no/') }),
    );

    // Old anchor regex, kept here as the reference the scanner must equal.
    const OLD_ANCHOR = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
    const PARITY_PAGE = [
      "<!doctype html><html><head><title>Gården</title></head><body>",
      '<nav><a href="/">Hjem</a> <A HREF="/Produkter/">Produkter</A> <a class="x" href=\'/prisliste\' title="Priser">Se <b>prisliste</b></a>',
      '<a href="/nettbutikk?kat=kjott&amp;side=1">Nettbutikk</a> <a href="#top">Til toppen</a> <a href="mailto:post@garden.no">E-post</a>',
      '<a href="https://www.garden.no/vare/honning-250g">Honning 250 g</a> <a href="https://andre.no/butikk">Annen butikk</a>',
      '<a data-href="/feil" href="/sortiment">Vårt sortiment</a> <a href="/bilder/produkt.jpg">Bilde</a> <a href="/om-oss">Om oss</a>',
      '<a href="/gårdsbutikk">Gårdsbutikk</a> <a href="/p%C3%A5melding">påmelding</a> <a href="/shop" >Shop</a>',
      '<a href="/bestill">',
      "x".repeat(170),
      '</a> <a href="/kjøp">Kjøp her</a> <a href="/salg"\n>Salg</a>',
      '<a href="/meny">Meny <a href="/varer">Varer</a> <a href="">tom</a> <a href="/produkter/">Produkter igjen</a>',
      '<abbr href="/produkt-abbr">x</abbr> <a\nhref="/pris">Pris</a> <a href="/product?id=1&amp;x=2">Product</a>',
      "</body></html>",
    ].join("");
    // Captured from the regex implementation before slice 2.
    assertEq(
      ex.discoverProductLinks(PARITY_PAGE, "https://garden.no/", hostAllowed, 20),
      {
        links: [
          "https://garden.no/pris",
          "https://garden.no/prisliste",
          "https://garden.no/meny",
          "https://garden.no/product?id=1&x=2",
          "https://garden.no/produkter/",
          "https://garden.no/Produkter/",
          "https://garden.no/sortiment",
          "https://www.garden.no/vare/honning-250g",
          "https://garden.no/g%C3%A5rdsbutikk",
          "https://garden.no/kj%C3%B8p",
          "https://garden.no/nettbutikk?kat=kjott&side=1",
          "https://garden.no/shop",
          "https://garden.no/salg",
        ],
        rejected: ["https://andre.no/butikk"],
      },
      "D5 parity: discoverProductLinks gives the same links, ranking and rejects as before",
    );
    assertEq(
      ex.discoverProductLinks(PARITY_PAGE, "https://garden.no/", hostAllowed, 5).links,
      ["https://garden.no/pris", "https://garden.no/prisliste", "https://garden.no/meny", "https://garden.no/product?id=1&x=2", "https://garden.no/produkter/"],
      "D5 parity: the cap keeps the top-ranked links",
    );
    const parityCases = [
      PARITY_PAGE,
      '<a href="a>b" title="t">x</a>',
      "<a href=\"x' href='y\">t</a>",
      '<a href="/a" <a href="/b">t</a></a>',
      '<a href="/a">' + "y".repeat(161) + '</a><a href="/b">' + "y".repeat(160) + "</a>",
      '<a href="/a"><a href="/b">t</A>',
      '<a href="" href="/c">t</a><a href="/d" href="">u</a>',
      '<a href="/unclosed>no close <a href="/next">n</a>',
    ];
    for (const [i, html] of parityCases.entries()) {
      assertEq(
        ex.scanAnchorTags(html),
        [...html.matchAll(OLD_ANCHOR)].map((m) => ({ href: m[1], text: m[2] })),
        `D5 parity: scanAnchorTags equals the old anchor regex (case ${i})`,
      );
    }
    assertEq(
      ex.pageTextOf('<p>Honning<br>kr 120</p><script>x<y</script><!-- c --><style>a{}</style>\n \r\n<div\n class="a">Egg  60,-</div> <b'),
      "Honning\nkr 120\nEgg 60,-\n<b",
      "D5 parity: pageTextOf output unchanged (blocks, tags, whitespace runs, unclosed tail)",
    );

    // ── D6: mentions in body text are no fingerprint ───────────────────────
    const platformCases: Array<[string, string, string]> = [
      ["plain", HTML("", `${FILLER}<p>Vi bruker WooCommerce i nettbutikken vår.</p>`), "WooCommerce mentioned in text"],
      ["plain", HTML("", `${FILLER}<p>Bestill på gardsbutikk.mystore.no eller mystore.no</p>`), "mystore.no mentioned in text"],
      ["plain", HTML("", `${FILLER}<a href="https://www.mystore.no/">Laget med Mystore</a>`), "a plain link to mystore.no"],
      ["woocommerce", HTML("<link rel='stylesheet' id='woocommerce-layout-css' href='/x/layout.css'>", FILLER), "woocommerce style handle"],
      ["woocommerce", HTML("<script id='wc-add-to-cart-js' src='/x/add-to-cart.min.js'></script>", FILLER), "wc- script handle"],
      ["woocommerce", `<html><body class="home page woocommerce-js">${FILLER}</body></html>`, "woocommerce body class"],
      ["woocommerce", HTML('<meta name="generator" content="WooCommerce 8.9.1">', FILLER), "WooCommerce generator meta"],
      ["mystore", HTML("", `${FILLER}<img src="https://gard.mystore.no/uploads/egg.jpg">`), "image served from a mystore.no host"],
      ["mystore", HTML('<script src="//cdn.mystore.no/js/app.js"></script>', FILLER), "script from the mystore CDN"],
      ["mystore", HTML('<meta name="generator" content="Mystore">', FILLER), "Mystore generator meta"],
      ["wordpress", HTML('<meta name="generator" content="WordPress 6.6">', FILLER), "WordPress generator meta"],
      ["webflow", HTML('<meta name="generator" content="Webflow">', FILLER), "Webflow generator meta"],
      ["plain", HTML('<meta name="description" content="Vi lagde siden i Wix.com">', FILLER), "Wix.com in a non-generator meta"],
    ];
    for (const [want, html, label] of platformCases) {
      assertEq(sd.detectSitePlatform({ html }), want, `D6 platform: ${label} → ${want}`);
    }
    assertEq(
      sd.generatorMetaTexts('<meta charset="utf-8"><META NAME="Generator" CONTENT="Wix.com Website Builder"><meta name="x">'),
      ['" CONTENT="Wix.com Website Builder"'],
      "D6 generatorMetaTexts: only generator tags, the text after the word",
    );
    assertEq(
      ["NOK 1 250", "kr 12 500 000", "12.500,50 kr", "60,-", "Tlf 22 33 44 55"].map(sd.hasNokPriceText),
      [true, true, true, true, false],
      "D6 price text: capped digit runs still see normal prices",
    );

    // ── D7: LLM failure is its own reason ──────────────────────────────────
    assertEq(
      ["infra_failure", "invalid_json", "not_array", "sentinel", "ok"].map((st) =>
        sd.diagnoseNoHit({ outcome: "no_products_found", llm_status: st, has_price_text: true }),
      ),
      ["llm_failed", "llm_failed", "llm_failed", "prices_on_page_not_extracted", "prices_on_page_not_extracted"],
      "D7 reasons: a failed LLM call → llm_failed; the model's own no-products answer is not a failure",
    );
    assertEq(
      sd.diagnoseNoHit({ outcome: "no_products_found", llm_status: "infra_failure", excluded_count: 1, has_price_text: false }),
      "excluded_by_rules",
      "D7 reasons: a rule exclusion is still named first",
    );
    robots.__clearRobotsCacheForTesting();
    try {
      const page = HTML("", `${FILLER}<p>Honning 250 g kr 120</p>`);
      for (const [label, llm, status] of [
        ["throws", async () => { throw new Error("upstream 500"); }, "infra_failure"],
        ["not JSON", async () => ({ text: "Beklager, jeg kan ikke" }), "invalid_json"],
      ] as const) {
        const f = makeFetch({ "https://diag-llm.no/robots.txt": ROBOTS_OPEN, "https://diag-llm.no/": { body: page } });
        robots.__clearRobotsCacheForTesting();
        const r = await ex.extractProductsFromWebsite("https://diag-llm.no", { fetchImpl: f.impl, llm, sleep });
        assertEq(
          [r.outcome, r.tier, r.products.length, r.llm_status, r.llm_calls, r.diagnostics?.no_hit_reason, r.diagnostics?.has_price_text],
          ["no_products_found", null, 0, status, 1, "llm_failed", true],
          `D7 extractor: LLM ${label} → outcome unchanged, reason llm_failed`,
        );
      }
    } finally {
      robots.__clearRobotsCacheForTesting();
    }
    const sum2 = dry.summarizeDryRun([
      { agent_id: "1", agent_name: "a", website: "a", is_owned: 0, result: base({ llm_status: "infra_failure", diagnostics: { site_platform: "plain", no_hit_reason: "llm_failed", has_price_text: true, has_pagination_hint: false, pages_seen: 1 } }) },
      { agent_id: "2", agent_name: "b", website: "b", is_owned: 1, result: base({ llm_status: "invalid_json", diagnostics: { site_platform: "wordpress", no_hit_reason: "llm_failed", has_price_text: false, has_pagination_hint: false, pages_seen: 2 } }) },
      { agent_id: "3", agent_name: "c", website: "c", is_owned: 0, result: base({ diagnostics: { site_platform: "wix", no_hit_reason: "no_price_text", has_price_text: false, has_pagination_hint: false, pages_seen: 1 } }) },
    ]);
    assertEq(
      sum2.site_diagnostics.no_hit_reason_counts,
      { llm_failed: 2, no_price_text: 1 },
      "D7 summary: llm_failed counted apart from the price reasons",
    );

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runSiteDiagnosticsTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}

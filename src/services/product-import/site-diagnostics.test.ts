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

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runSiteDiagnosticsTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}

/**
 * experiences-seo-jsonld.test.ts — valid structured data on Opplevagent's
 * profile pages.
 *
 * dev-request 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E2-S2
 * (/opplevelse/<slug>): one title everywhere, offers and provider on a
 * separate Service node, no blanket InStock. Plus the lokal#1094 review
 * finding: the site nav and footer follow uiLang, so /en with the language
 * switcher off has no English menus under lang="nb".
 *
 * dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
 * treffvakt, S5 (/kategori/gardssalg/produsent/<slug>): a live-booking page
 * signals the visit request as a ReserveAction instead of a price-less Offer;
 * a paused page carries neither.
 *
 * Covers:
 *   (a) every detail page (with price, without price, per_adult, with
 *       title_no, without provider, bare): the shared invariants
 *       (tests/helpers/jsonld-invariants.ts) — forbiddenNodes [] and
 *       offersWithoutPrice 0; no «InStock» and no `availability` anywhere;
 *       no TouristAttraction carries offers, provider or touristType; the
 *       TouristAttraction name, the Service name, the BreadcrumbList's last
 *       item, og:title, the share-image alt, the visible breadcrumb and
 *       <title> all use the <h1>'s title (E2-S3: the share image itself is
 *       the category's PNG card, without a title); the Service links to the
 *       place by @id; BreadcrumbList kept.
 *   (b) each case's exact nodes: alternateName only when the title differs;
 *       category as keywords / serviceType; the Offer is exactly
 *       {price, priceCurrency, url?, name?} (no availability); a provider-
 *       less row has no provider; a row with neither provider nor price has
 *       no Service node at all.
 *   (c) language: /en with the switcher off — the original title (tnr-4d)
 *       on <h1> and in the JSON-LD, and the nav and footer byte-identical to
 *       /no; switcher on — English nav and footer, and a published EN title
 *       becomes the name with the original as alternateName.
 *   (d) gårdssalg (S5): live page → LocalBusiness.potentialAction is a
 *       ReserveAction whose EntryPoint is the page's own /book CTA, no
 *       offers; paused page → no potentialAction and no offers; both clean
 *       under the shared invariants.
 *   (e) lokal#1097 review follow-ups, landed with E2-S3: S1 — the «publiseres
 *       fortløpende» placeholder names the <h1>'s title (title_no on /no, the
 *       original on /en with the switcher off, a published EN title with it
 *       on); S4 — a per_adult Offer.name follows the page language
 *       («Voksenpris» on /no and on /en with the switcher off, «Adult price»
 *       on /en with it on).
 *
 * Run standalone: npx tsx src/routes/experiences-seo-jsonld.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { jsonLdBlocks, offersWithoutPrice, forbiddenNodes } from "../../tests/helpers/jsonld-invariants";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const BASE = "https://opplevagent.no";

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
function metaProperty(html: string, prop: string): string {
  return unescapeHtml(new RegExp(`<meta property="${prop}" content="([^"]*)"`).exec(html)?.[1] ?? "");
}
function h1Text(html: string): string {
  return unescapeHtml(/<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? "");
}
function titleTag(html: string): string {
  return unescapeHtml(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
}
/** Plain text after the visible breadcrumb's last separator. */
function visibleCrumbLast(html: string): string {
  const nav = /<nav class="breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  const parts = nav.split('<span class="sep">/</span>');
  return unescapeHtml((parts[parts.length - 1] ?? "").replace(/<[^>]*>/g, "")).trim();
}
function siteNav(html: string): string {
  return /<header class="site-nav">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
}
function siteFooter(html: string): string {
  return /<footer class="site-footer"[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "";
}
/** Every object node in the parsed blocks, depth-first. */
function allNodes(ld: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    out.push(n as Record<string, unknown>);
    Object.values(n as Record<string, unknown>).forEach(walk);
  };
  walk(ld);
  return out;
}
const isType = (n: Record<string, unknown>, t: string): boolean =>
  n["@type"] === t || (Array.isArray(n["@type"]) && (n["@type"] as unknown[]).includes(t));

export function runExperiencesSeoJsonLdTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    const prevServe = process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = "true";
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;
      const router = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── fixtures ───────────────────────────────────────────────────────────
      const provId = expStore.createProvider({
        navn: "Arktisk Hval AS", org_nr: "912345670",
        fylke: "Troms", kommune: "Tromsø", hjemmeside: "https://hval.example.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const mk = (title: string, fields: Record<string, unknown>): { id: string; slug: string } => {
        const id = expStore.createExperience({
          title, provider_match_status: "matched",
          category: "dyreliv_safari", fylke: "Troms", kommune: "Tromsø",
          confidence: "high", verification_status: "verified", ...fields,
        } as any);
        return { id, slug: (expStore.getExperienceById(id) as any).slug as string };
      };
      const DESCRIPTION = "Hvalsafari fra Tromsø med erfarne guider, varme drakter og plass til små grupper.";
      const withPrice = mk("Whale Safari Tromso", {
        provider_id: provId, description: DESCRIPTION, price_from: 1290, price_unit: "per_person",
        booking_url: "https://book.hval.example.no/safari",
      });
      db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run("Hvalsafari fra Tromsø", withPrice.id);
      const noPrice = mk("Fjellvandring på Senja", { provider_id: provId, price_band: "middels" });
      const adult = mk("Fjordsafari med rib", { provider_id: provId, price_from: 990, price_unit: "per_adult" });
      const noProvider = mk("Nordlysjakt med buss", { price_from: 800, price_unit: "per_person" });
      const bare = mk("Utsiktspunkt ved fjorden", { category: null });
      // (e) #1097 S1: title_no and no description → the placeholder lede.
      const placeholder = mk("Kayak Tour Lofoten", { provider_id: provId });
      db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run("Kajakktur i Lofoten", placeholder.id);
      // A published EN title for the noPrice row (served only with the switcher on).
      db.prepare(
        `INSERT INTO profile_translations (platform, entity_type, entity_id, field, lang, source_text, source_hash, translated_text, status, published_at)
         VALUES ('opplevagent', 'experience', ?, 'title', 'en', ?, 'h', ?, 'published', datetime('now'))`,
      ).run(noPrice.id, "Fjellvandring på Senja", "Mountain hike on Senja");

      const cases: Array<{ key: string; slug: string; h1: string }> = [
        { key: "with price + title_no", slug: withPrice.slug, h1: "Hvalsafari fra Tromsø" },
        { key: "without price", slug: noPrice.slug, h1: "Fjellvandring på Senja" },
        { key: "per_adult", slug: adult.slug, h1: "Fjordsafari med rib" },
        { key: "without provider", slug: noProvider.slug, h1: "Nordlysjakt med buss" },
        { key: "bare", slug: bare.slug, h1: "Utsiktspunkt ved fjorden" },
      ];
      const pages = new Map<string, { body: string; blocks: any[] }>();
      for (const c of cases) {
        const r = await callHtmlRoute(router, `/opplevelse/${c.slug}`);
        let blocks: any[] = [];
        try { blocks = jsonLdBlocks(r.body) as any[]; } catch (err) { assertTrue(false, `jl-0 ${c.key}: ld+json parses (${String(err)})`); }
        assertTrue(r.handled && r.status === 200 && blocks.length >= 2, `jl-0 ${c.key}: renders 200 with ld+json (status ${r.status}, ${blocks.length} blocks)`);
        pages.set(c.key, { body: r.body, blocks });
      }

      // ── (a) every detail page ──────────────────────────────────────────────
      for (const c of cases) {
        const { body, blocks } = pages.get(c.key)!;
        const canonical = `${BASE}/opplevelse/${c.slug}`;
        const nodes = allNodes(blocks);
        const ta = blocks.find((b) => b["@type"] === "TouristAttraction");
        const service = blocks.find((b) => b["@type"] === "Service");
        const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList");
        assertEq(forbiddenNodes(blocks), [], `jl-a1 ${c.key}: no forbidden node (shared checker)`);
        assertEq(offersWithoutPrice(blocks), 0, `jl-a2 ${c.key}: offersWithoutPrice is 0 (shared checker)`);
        assertTrue(!body.includes("InStock") && !nodes.some((n) => "availability" in n), `jl-a3 ${c.key}: no InStock and no availability anywhere`);
        assertTrue(nodes.filter((n) => isType(n, "TouristAttraction")).every((n) => !("offers" in n) && !("provider" in n) && !("touristType" in n)),
          `jl-a4 ${c.key}: no TouristAttraction carries offers, provider or touristType`);
        assertTrue(blocks.every((b) => b["@context"] === "https://schema.org" && typeof b["@type"] === "string"),
          `jl-a5 ${c.key}: every block is a top-level schema.org node (no @graph)`);
        assertTrue(h1Text(body) === c.h1, `jl-a6 ${c.key}: <h1> is «${c.h1}» (got «${h1Text(body)}»)`);
        assertTrue(ta?.name === c.h1, `jl-a7 ${c.key}: TouristAttraction name is the <h1> (got ${JSON.stringify(ta?.name)})`);
        const crumbItems = crumbs?.itemListElement ?? [];
        assertTrue(crumbItems.length >= 2 && crumbItems[crumbItems.length - 1]?.name === c.h1 && crumbItems[crumbItems.length - 1]?.item === canonical,
          `jl-a8 ${c.key}: BreadcrumbList kept, last item is the <h1> at the canonical URL`);
        assertTrue(metaProperty(body, "og:title") === c.h1, `jl-a9 ${c.key}: og:title is the <h1> (got «${metaProperty(body, "og:title")}»)`);
        assertTrue(metaProperty(body, "og:image:alt").startsWith(`${c.h1}`),
          `jl-a10 ${c.key}: the share-image alt uses the <h1> (got «${metaProperty(body, "og:image:alt")}»)`);
        assertTrue(visibleCrumbLast(body) === c.h1, `jl-a11 ${c.key}: the visible breadcrumb ends with the <h1> (got «${visibleCrumbLast(body)}»)`);
        assertTrue(titleTag(body).startsWith(c.h1), `jl-a12 ${c.key}: <title> starts with the <h1>`);
        assertTrue(ta?.["@id"] === `${canonical}#attraction`, `jl-a13 ${c.key}: TouristAttraction has @id <canonical>#attraction`);
        if (service) {
          assertTrue(service.name === c.h1 && service["@id"] === `${canonical}#service` && service.areaServed?.["@id"] === ta?.["@id"],
            `jl-a14 ${c.key}: Service names the <h1> and links to the place by @id (got ${JSON.stringify({ name: service.name, id: service["@id"], areaServed: service.areaServed })})`);
        }
      }

      // ── (b) each case's exact nodes ────────────────────────────────────────
      {
        const { blocks } = pages.get("with price + title_no")!;
        const ta = blocks.find((b) => b["@type"] === "TouristAttraction");
        const service = blocks.find((b) => b["@type"] === "Service");
        assertTrue(ta?.alternateName === "Whale Safari Tromso", "jl-b1: title_no on /no → the original title is the alternateName");
        assertTrue(ta?.keywords === "Dyreliv & safari" && service?.serviceType === "Dyreliv & safari", "jl-b2: the category is keywords on the place and serviceType on the Service");
        assertTrue(ta?.description === DESCRIPTION && ta?.address?.addressLocality === "Tromsø" && ta?.url === `${BASE}/opplevelse/${withPrice.slug}`,
          "jl-b3: the place keeps description, address and url");
        assertEq(service?.provider, { "@type": "Organization", name: "Arktisk Hval AS", url: "https://hval.example.no" }, "jl-b4: the provider is an Organization on the Service");
        assertEq(service?.offers, { "@type": "Offer", price: 1290, priceCurrency: "NOK", url: "https://book.hval.example.no/safari" },
          "jl-b5: the Offer is the row's price, currency and booking URL — no availability, no name for per_person");
        assertEq(blocks.map((b) => b["@type"]), ["TouristAttraction", "Service", "BreadcrumbList"], "jl-b6: three blocks: place, Service, breadcrumb");
      }
      {
        const { blocks } = pages.get("without price")!;
        const ta = blocks.find((b) => b["@type"] === "TouristAttraction");
        const service = blocks.find((b) => b["@type"] === "Service");
        assertTrue(!!ta && !("alternateName" in ta), "jl-b7: no title_no → no alternateName");
        assertTrue(!!service && !("offers" in service) && service.provider?.name === "Arktisk Hval AS",
          "jl-b8: no price → the Service names the provider and has no Offer (a price band is not a price)");
        assertTrue(!allNodes(blocks).some((n) => isType(n, "Offer")), "jl-b9: … and there is no Offer node anywhere");
      }
      {
        const { blocks } = pages.get("per_adult")!;
        const service = blocks.find((b) => b["@type"] === "Service");
        assertEq(service?.offers, { "@type": "Offer", price: 990, priceCurrency: "NOK", name: "Voksenpris", url: "https://hval.example.no" },
          "jl-b10: per_adult → the Offer is named «Voksenpris» on /no (#1097 S4); without a booking URL it points to the provider's site");
      }
      {
        const { blocks } = pages.get("without provider")!;
        const service = blocks.find((b) => b["@type"] === "Service");
        assertTrue(!allNodes(blocks).some((n) => "provider" in n || isType(n, "Organization")), "jl-b11: no provider → no provider or Organization anywhere");
        assertEq(service?.offers, { "@type": "Offer", price: 800, priceCurrency: "NOK" }, "jl-b12: … the Service still carries the row's price (no url without a booking URL or site)");
      }
      {
        const { blocks } = pages.get("bare")!;
        assertEq(blocks.map((b) => b["@type"]), ["TouristAttraction", "BreadcrumbList"], "jl-b13: neither provider nor price → no Service node at all");
        const ta = blocks[0];
        assertTrue(!("keywords" in ta), "jl-b14: no category → no keywords (no invented «Opplevelse» category)");
        assertTrue(blocks[1]?.itemListElement?.length === 2, "jl-b15: no category → a two-item breadcrumb");
      }

      // ── (c) language ───────────────────────────────────────────────────────
      {
        const no = pages.get("with price + title_no")!.body;
        const en = await callHtmlRoute(router, `/opplevelse/${withPrice.slug}`, "en");
        const enBlocks = jsonLdBlocks(en.body) as any[];
        const ta = enBlocks.find((b) => b["@type"] === "TouristAttraction");
        assertTrue(en.body.includes('<html lang="nb">') && h1Text(en.body) === "Whale Safari Tromso",
          "jl-c1: /en, switcher off: lang=\"nb\" and the original title on <h1> (tnr-4d)");
        assertTrue(ta?.name === "Whale Safari Tromso" && !("alternateName" in ta) && metaProperty(en.body, "og:title") === "Whale Safari Tromso"
          && visibleCrumbLast(en.body) === "Whale Safari Tromso",
          "jl-c2: … and the same title in the JSON-LD, og:title and breadcrumb");
        const navNo = siteNav(no);
        const footNo = siteFooter(no);
        assertTrue(navNo.length > 0 && footNo.length > 0, "jl-c3: the page has the shared site nav and footer");
        assertTrue(siteNav(en.body) === navNo && siteFooter(en.body) === footNo,
          "jl-c4: /en, switcher off: nav and footer are byte-identical to /no (lokal#1094 review finding)");
        assertTrue(siteNav(en.body).includes(">Alle opplevelser<") && !siteNav(en.body).includes(">All experiences<")
          && siteFooter(en.body).includes(">Kontakt oss<") && !siteFooter(en.body).includes(">Contact us<"),
          "jl-c5: … so no English menu text under lang=\"nb\"");

        process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
        try {
          const on = await callHtmlRoute(router, `/opplevelse/${withPrice.slug}`, "en");
          assertTrue(on.body.includes('<html lang="en">') && siteNav(on.body).includes(">All experiences<") && siteFooter(on.body).includes(">Contact us<"),
            "jl-c6: switcher on: /en has English nav and footer under lang=\"en\"");
          const tr = await callHtmlRoute(router, `/opplevelse/${noPrice.slug}`, "en");
          const trBlocks = jsonLdBlocks(tr.body) as any[];
          const trTa = trBlocks.find((b) => b["@type"] === "TouristAttraction");
          const trService = trBlocks.find((b) => b["@type"] === "Service");
          const trCrumbs = trBlocks.find((b) => b["@type"] === "BreadcrumbList")?.itemListElement ?? [];
          assertTrue(h1Text(tr.body) === "Mountain hike on Senja" && trTa?.name === "Mountain hike on Senja" && trService?.name === "Mountain hike on Senja"
            && metaProperty(tr.body, "og:title") === "Mountain hike on Senja" && trCrumbs[trCrumbs.length - 1]?.name === "Mountain hike on Senja",
            "jl-c7: switcher on + published EN title: <h1>, JSON-LD names, og:title and breadcrumb all use it");
          assertTrue(trTa?.alternateName === "Fjellvandring på Senja" && trTa?.["@id"] === `${BASE}/en/opplevelse/${noPrice.slug}#attraction`,
            "jl-c8: … with the original title as alternateName and @id on the /en canonical");
          const noOn = await callHtmlRoute(router, `/opplevelse/${withPrice.slug}`, "no");
          assertTrue(siteNav(noOn.body).includes(">Alle opplevelser<") && (jsonLdBlocks(noOn.body) as any[])[0]?.name === "Hvalsafari fra Tromsø",
            "jl-c9: switcher on: /no stays Norwegian, title_no as name");
        } finally {
          delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
        }
      }

      // ── (d) gårdssalg (S5) ─────────────────────────────────────────────────
      {
        const insGs = db.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
              geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
           VALUES
             (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', 'bryggeri', @bl, NULL, 60.63, 6.42,
              'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        );
        insGs.run({ id: "jl-live", navn: "Aktivt Bryggeri", bl: 1, slug: "aktivt-bryggeri" });
        insGs.run({ id: "jl-paused", navn: "Pauset Bryggeri", bl: 0, slug: "pauset-bryggeri" });

        const live = await callHtmlRoute(router, "/kategori/gardssalg/produsent/aktivt-bryggeri");
        const liveBlocks = jsonLdBlocks(live.body) as any[];
        const biz = liveBlocks.find((b) => b["@type"] === "LocalBusiness");
        assertTrue(live.handled && live.status === 200 && !!biz, `jl-d1: live producer page renders with a LocalBusiness (status ${live.status})`);
        assertEq(biz?.potentialAction, {
          "@type": "ReserveAction",
          name: "Be om gårdsbesøk hos Aktivt Bryggeri",
          target: { "@type": "EntryPoint", urlTemplate: `${BASE}/kategori/gardssalg/book/aktivt-bryggeri` },
        }, "jl-d2: live booking → a ReserveAction to the /book route");
        assertTrue(live.body.includes('id="reserve-cta" class="reserve-cta" href="/kategori/gardssalg/book/aktivt-bryggeri"'),
          "jl-d3: … the same route as the page's own «Reserver besøk» CTA");
        assertTrue(!("offers" in (biz ?? {})) && !allNodes(liveBlocks).some((n) => isType(n, "Offer")) && !live.body.includes("InStock"),
          "jl-d4: … and no Offer node and no InStock");
        assertEq(forbiddenNodes(liveBlocks), [], "jl-d5: live page: no forbidden node (shared checker)");
        assertEq(offersWithoutPrice(liveBlocks), 0, "jl-d6: live page: offersWithoutPrice is 0 (it was 1 before S5)");

        const paused = await callHtmlRoute(router, "/kategori/gardssalg/produsent/pauset-bryggeri");
        const pausedBlocks = jsonLdBlocks(paused.body) as any[];
        const pbiz = pausedBlocks.find((b) => b["@type"] === "LocalBusiness");
        assertTrue(paused.handled && paused.status === 200 && !!pbiz, `jl-d7: paused producer page renders with a LocalBusiness (status ${paused.status})`);
        assertTrue(!("potentialAction" in (pbiz ?? {})) && !("offers" in (pbiz ?? {})) && !paused.body.includes("ReserveAction") && !paused.body.includes("InStock"),
          "jl-d8: paused booking → neither a ReserveAction nor an Offer");
        assertEq(forbiddenNodes(pausedBlocks), [], "jl-d9: paused page: no forbidden node (shared checker)");
        assertEq(offersWithoutPrice(pausedBlocks), 0, "jl-d10: paused page: offersWithoutPrice is 0");
      }

      // ── (e) lokal#1097 review follow-ups: S1 placeholder lede, S4 Offer.name ─
      {
        const placeholderLede = (html: string): string =>
          unescapeHtml(/<p class="lede lede-soft">([^<]*)<\/p>/.exec(html)?.[1] ?? "");
        const adultOfferName = async (lang: "no" | "en"): Promise<unknown> =>
          (jsonLdBlocks((await callHtmlRoute(router, `/opplevelse/${adult.slug}`, lang)).body) as any[])
            .find((b) => b["@type"] === "Service")?.offers?.name;

        const no = await callHtmlRoute(router, `/opplevelse/${placeholder.slug}`);
        assertTrue(h1Text(no.body) === "Kajakktur i Lofoten" && placeholderLede(no.body).includes("Kajakktur i Lofoten er en ")
          && !placeholderLede(no.body).includes("Kayak Tour Lofoten"),
          `jl-e1: /no: the placeholder names the <h1> (title_no), not the original title (got «${placeholderLede(no.body)}»)`);
        const en = await callHtmlRoute(router, `/opplevelse/${placeholder.slug}`, "en");
        assertTrue(h1Text(en.body) === "Kayak Tour Lofoten" && placeholderLede(en.body).includes("Kayak Tour Lofoten er en "),
          `jl-e2: /en, switcher off: the placeholder names the <h1> (the original title, tnr-4d) (got «${placeholderLede(en.body)}»)`);
        assertEq(await adultOfferName("en"), "Voksenpris", "jl-e3: /en, switcher off (lang=\"nb\"): the per_adult Offer stays «Voksenpris»");

        process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
        try {
          const tr = await callHtmlRoute(router, `/opplevelse/${noPrice.slug}`, "en");
          assertTrue(placeholderLede(tr.body).includes("Mountain hike on Senja er en "),
            `jl-e4: switcher on + published EN title: the placeholder names the <h1> (got «${placeholderLede(tr.body)}»)`);
          assertEq(await adultOfferName("en"), "Adult price", "jl-e5: switcher on: /en names the per_adult Offer «Adult price»");
          assertEq(await adultOfferName("no"), "Voksenpris", "jl-e6: switcher on: /no keeps «Voksenpris»");
        } finally {
          delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
        }
      }

      return { passed, failed, failures };
    } catch (err) {
      failed++;
      failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      if (prevServe === undefined) delete process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED; else process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = prevServe;
      if (prevDispatch === undefined) delete process.env.BOOKING_DISPATCH_ENABLED; else process.env.BOOKING_DISPATCH_ENABLED = prevDispatch;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-seo-jsonld.test.ts`
if (require.main === module) {
  console.log("── Opplevagent JSON-LD: one title, Service node, no InStock, ReserveAction (dev-requests 2026-10-16 E2-S2 + S5) ──");
  runExperiencesSeoJsonLdTests({ log: true }).then((r) => {
    console.log(`\nexperiences-seo-jsonld: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

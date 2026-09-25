/**
 * rfb-breadcrumblist-jsonld.test.ts — dev-request 2026-09-24-ai-sok-bli-svaret-rfb,
 * slice B3 (Daniel-GO 2026-09-24, see
 * daniel-responses/2026-09-24-go-chatgpt-claude-spor-a-b-c.md in the A2A repo).
 *
 * Adds schema.org `BreadcrumbList` JSON-LD to the three page types that
 * already render a visible `.bc`/`.sk-crumbs` breadcrumb nav in `seo.ts`:
 *   - GET /produsent/:slug        (producer page)      -> Hjem [› kommune] › produsent
 *   - GET /kategori/:slug         (salgskanal category) -> Hjem › Salgskanaler › kategori
 *   - GET /:city                  (kommune page)         -> Hjem › kommune
 *
 * `buildBreadcrumbJsonLd()` itself is a pure function (no DB) — see the first
 * block below for direct unit tests of it, following the same
 * import-straight-from-seo.ts convention as
 * rfb-producer-answer-first-opening-sale-signal.test.ts. The rest of this
 * file exercises the three route handlers end-to-end the same way
 * rfb-bm-event-jsonld.test.ts / rfb-makesoffer-price-optional.test.ts do:
 * own `Database(":memory:")`, `__setDbForTesting`/`__initSchemaForTesting`,
 * the real `seo.ts` router's handlers pulled directly off the route stack —
 * no HTTP server, no port.
 *
 * Purely additive: every assertion below also checks the page's pre-existing
 * JSON-LD (LocalBusiness / CollectionPage / FAQPage) is still present
 * unchanged, so this slice cannot silently regress B1/B2 or the original
 * schema.
 *
 * Exported runBreadcrumbListJsonLdTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/rfb-breadcrumblist-jsonld.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runBreadcrumbListJsonLdTests() and folds its pass/fail counts into the
 *      `npm test` summary.
 */

import Database from "better-sqlite3";
import { buildBreadcrumbJsonLd } from "./seo";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runBreadcrumbListJsonLdTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ══════════════════════════════════════════════════════════════════════
  // (0) Pure unit tests for buildBreadcrumbJsonLd() — no DB.
  // ══════════════════════════════════════════════════════════════════════
  {
    const two = buildBreadcrumbJsonLd([
      { name: "Hjem", url: "https://rettfrabonden.com/" },
      { name: "Oslo", url: "https://rettfrabonden.com/oslo" },
    ]);
    assertTrue(two["@context"] === "https://schema.org", "pure: @context is schema.org");
    assertTrue(two["@type"] === "BreadcrumbList", "pure: @type is BreadcrumbList");
    assertTrue(Array.isArray(two.itemListElement) && two.itemListElement.length === 2, "pure: 2 items in, 2 ListItems out");
    assertTrue(two.itemListElement[0].position === 1 && two.itemListElement[1].position === 2, "pure: positions are 1-based and sequential");
    assertTrue(two.itemListElement[0]["@type"] === "ListItem", "pure: each entry is a ListItem");
    assertTrue(two.itemListElement[0].name === "Hjem" && two.itemListElement[0].item === "https://rettfrabonden.com/", "pure: position 1 name/item match input verbatim");
    assertTrue(two.itemListElement[1].name === "Oslo" && two.itemListElement[1].item === "https://rettfrabonden.com/oslo", "pure: position 2 name/item match input verbatim");

    const three = buildBreadcrumbJsonLd([
      { name: "A", url: "https://x/a" },
      { name: "B", url: "https://x/b" },
      { name: "C", url: "https://x/c" },
    ]);
    assertTrue(three.itemListElement.length === 3, "pure: 3 items in, 3 ListItems out");
    assertTrue(three.itemListElement.map((i: any) => i.position).join(",") === "1,2,3", "pure: 3-item positions are 1,2,3");
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedAgent(row: {
    id: string; name: string; city?: string | null; lat?: number | null; lng?: number | null;
    categories?: string[];
  }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        ?, '[]', '[]', '{}', '["no"]', ?, ?, ?,
        0.5, 1, 0, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, JSON.stringify(row.categories || []), row.city ?? null, row.lat ?? null, row.lng ?? null,
    );
  }

  function seedSalgskanal(agentId: string, categorySlug: string): void {
    testDb.prepare(
      `INSERT INTO agent_salgskanal (agent_id, category_slug, source) VALUES (?, ?, 'manual')`,
    ).run(agentId, categorySlug);
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

    /** Extracts every JSON-LD <script> block on the page, parsed (shell() renders each jsonLd array element as its own <script> tag). */
    function extractJsonLdBlocks(body: string): any[] {
      const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      const parsed: any[] = [];
      for (const b of blocks) {
        try { parsed.push(JSON.parse(b[1])); } catch { /* ignore unparsable block */ }
      }
      return parsed;
    }

    const BASE_URL = "https://rettfrabonden.com";

    // ══════════════════════════════════════════════════════════════
    // (a) Producer page WITH a kommune -> BreadcrumbList has 3 items:
    // Hjem › kommune › produsent. Existing LocalBusiness jsonLd untouched.
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "gaardsbutikken-as", name: "Gårdsbutikken AS", city: "Lillehammer", lat: 61.11, lng: 10.46 });
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "gardsbutikken-as" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "producer+city: renders 200");

      const blocks = extractJsonLdBlocks(r.body);
      const lb = blocks.find((x: any) => x["@type"] === "LocalBusiness");
      const bc = blocks.find((x: any) => x["@type"] === "BreadcrumbList");
      assertTrue(!!lb, "producer+city: LocalBusiness jsonLd is still present (no regression)");
      assertTrue(!!lb && lb.name === "Gårdsbutikken AS", "producer+city: LocalBusiness.name unaffected");
      assertTrue(!!bc, "producer+city: a BreadcrumbList entry is present");
      assertTrue(!!bc && bc["@context"] === "https://schema.org", "producer+city: BreadcrumbList carries its own @context");
      assertTrue(!!bc && Array.isArray(bc.itemListElement) && bc.itemListElement.length === 3, "producer+city: 3 breadcrumb items (Hjem › kommune › produsent)");
      if (bc) {
        const [i1, i2, i3] = bc.itemListElement;
        assertTrue(i1.position === 1 && i1.name === "Hjem" && i1.item === `${BASE_URL}/`, "producer+city: item 1 is Hjem -> homepage");
        assertTrue(i2.position === 2 && i2.name === "Lillehammer" && i2.item === `${BASE_URL}/lillehammer`, "producer+city: item 2 is the kommune, matching the visible .bc nav's city link");
        assertTrue(i3.position === 3 && i3.name === "Gårdsbutikken AS" && i3.item === `${BASE_URL}/produsent/gardsbutikken-as`, "producer+city: item 3 is the producer itself, matching the canonical URL");
      }
    }

    // ══════════════════════════════════════════════════════════════
    // (b) Producer page WITHOUT a city -> BreadcrumbList has only 2 items
    // (Hjem › produsent) — no fabricated middle crumb.
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "ukjent-sted-gard", name: "Ukjent Sted Gård", city: null });
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "ukjent-sted-gard" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "producer-no-city: renders 200");

      const blocks = extractJsonLdBlocks(r.body);
      const bc = blocks.find((x: any) => x["@type"] === "BreadcrumbList");
      assertTrue(!!bc, "producer-no-city: a BreadcrumbList entry is present");
      assertTrue(!!bc && bc.itemListElement.length === 2, "producer-no-city: only 2 breadcrumb items — no fabricated city crumb");
      if (bc) {
        assertTrue(bc.itemListElement[0].name === "Hjem", "producer-no-city: item 1 is still Hjem");
        assertTrue(bc.itemListElement[1].name === "Ukjent Sted Gård" && bc.itemListElement[1].item === `${BASE_URL}/produsent/ukjent-sted-gard`, "producer-no-city: item 2 is the producer");
      }
    }

    // ══════════════════════════════════════════════════════════════
    // (c) Category page /kategori/:slug -> BreadcrumbList has 3 items:
    // Hjem › Salgskanaler (index) › this category. Existing CollectionPage
    // jsonLd untouched.
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "reko-bonden", name: "REKO-bonden", city: "Bergen", lat: 60.39, lng: 5.32 });
      seedSalgskanal("reko-bonden", "gardsbutikk");
      resetRegistryCache();

      const r = invoke("/kategori/:slug", { params: { slug: "gardsbutikk" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "category: renders 200");

      const blocks = extractJsonLdBlocks(r.body);
      const cp = blocks.find((x: any) => x["@type"] === "CollectionPage");
      const bc = blocks.find((x: any) => x["@type"] === "BreadcrumbList");
      assertTrue(!!cp, "category: CollectionPage jsonLd is still present (no regression)");
      assertTrue(!!bc, "category: a BreadcrumbList entry is present");
      assertTrue(!!bc && bc.itemListElement.length === 3, "category: 3 breadcrumb items (Hjem › Salgskanaler › kategori)");
      if (bc) {
        const [i1, i2, i3] = bc.itemListElement;
        assertTrue(i1.name === "Hjem" && i1.item === `${BASE_URL}/`, "category: item 1 is Hjem -> homepage");
        assertTrue(i2.name === "Salgskanaler" && i2.item === `${BASE_URL}/kategori`, "category: item 2 is the Salgskanaler index, matching the visible .sk-crumbs link");
        assertTrue(i3.name === "Gårdsbutikk" && i3.item === `${BASE_URL}/kategori/gardsbutikk`, "category: item 3 is this category, matching the canonical URL");
      }
    }

    // ══════════════════════════════════════════════════════════════
    // (d) Kommune page /:city -> BreadcrumbList has 2 items: Hjem › kommune.
    // Existing LocalBusiness jsonLd items untouched.
    // ══════════════════════════════════════════════════════════════
    {
      seedAgent({ id: "trondheim-gront", name: "Trondheim Grønt", city: "Trondheim", lat: 63.43, lng: 10.39 });
      resetRegistryCache();

      const r = invoke("/:city", { params: { city: "trondheim" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "kommune: renders 200");

      const blocks = extractJsonLdBlocks(r.body);
      const lb = blocks.find((x: any) => x["@type"] === "LocalBusiness");
      const bc = blocks.find((x: any) => x["@type"] === "BreadcrumbList");
      assertTrue(!!lb, "kommune: LocalBusiness jsonLd item(s) still present (no regression)");
      assertTrue(!!bc, "kommune: a BreadcrumbList entry is present");
      assertTrue(!!bc && bc.itemListElement.length === 2, "kommune: 2 breadcrumb items (Hjem › kommune)");
      if (bc) {
        const [i1, i2] = bc.itemListElement;
        assertTrue(i1.name === "Hjem" && i1.item === `${BASE_URL}/`, "kommune: item 1 is Hjem -> homepage");
        assertTrue(i2.name === "Trondheim" && i2.item === `${BASE_URL}/trondheim`, "kommune: item 2 is the kommune, matching the canonical URL");
      }
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-breadcrumblist-jsonld: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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

// Standalone runner: `npx tsx src/routes/rfb-breadcrumblist-jsonld.test.ts`
if (require.main === module) {
  console.log("── RFB BreadcrumbList JSON-LD (dev-request 2026-09-24-ai-sok-bli-svaret-rfb slice B3) unit tests ──");
  runBreadcrumbListJsonLdTests({ log: true }).then((r) => {
    console.log(`\nrfb-breadcrumblist-jsonld: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

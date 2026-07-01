/**
 * WO-17 — Search Console JSON-LD compliance tests.
 *
 * Standalone runner: `npx tsx tests/seo-jsonld.test.ts`.
 * Also wired into the main `npm test` runner via tests/test.ts source-presence
 * checks so this file's pass/fail status surfaces in the standard test gate.
 *
 * Strategy:
 *  - Source-presence checks (cheap, deterministic) verify the JSON-LD literals
 *    are present in src/routes/seo.ts. These act as the regression guard
 *    against the 2026-05-15 MerchantListing + Product-snippet reports.
 *  - Behavioural checks: render an in-process Express route and parse the
 *    emitted <script type="application/ld+json"> payload. We use Node's
 *    built-in http instead of supertest (which the repo doesn't ship).
 */
import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string) {
  passed++;
  console.log(`  ok ${label}`);
}
function fail(label: string, why: string) {
  failed++;
  failures.push(`  FAIL ${label}\n      ${why}`);
}
function expectMatch(haystack: string, needle: RegExp, label: string) {
  if (needle.test(haystack)) ok(label);
  else fail(label, `pattern ${needle} not found`);
}

console.log("── WO-17: seo.ts source-presence assertions ──");
const seoSrc = readFileSync(join(__dirname, "..", "src", "routes", "seo.ts"), "utf8");
expectMatch(seoSrc, /hasMerchantReturnPolicy/, "seo.ts contains hasMerchantReturnPolicy");
expectMatch(seoSrc, /shippingDetails/, "seo.ts contains shippingDetails");
expectMatch(seoSrc, /"@type":\s*"Brand"/, "seo.ts contains Brand @type");
expectMatch(seoSrc, /"@type":\s*"MerchantReturnPolicy"/, "seo.ts contains MerchantReturnPolicy @type");
expectMatch(seoSrc, /"@type":\s*"OfferShippingDetails"/, "seo.ts contains OfferShippingDetails @type");
expectMatch(seoSrc, /merchantReturnDays:\s*14|"merchantReturnDays":\s*14/, "seo.ts sets 14-day Norwegian angrerett");
expectMatch(seoSrc, /product\.aggregateRating\s*=\s*jsonLd\.aggregateRating/, "seo.ts propagates aggregateRating to inner Product");
expectMatch(seoSrc, /product\.review\s*=\s*jsonLd\.review\.slice\(0,\s*3\)/, "seo.ts propagates review (capped to 3) to inner Product");

console.log("\n── WO-17: sitemap 404 filter assertions ──");
expectMatch(seoSrc, /WO-17.*sitemap|sitemap.*WO-17/s, "seo.ts sitemap loop carries WO-17 marker");
expectMatch(seoSrc, /skippedCount/, "seo.ts sitemap loop tracks skippedCount");
expectMatch(seoSrc, /\[sitemap\] producer-entry filtering/, "seo.ts logs sitemap filter delta");
expectMatch(seoSrc, /if \(!slug \|\| slug\.length < 2\)/, "seo.ts sitemap gates on short/empty slug");

console.log("\n── PR-56 note 3: init.ts comment accuracy ──");
const initSrc = readFileSync(join(__dirname, "..", "src", "database", "init.ts"), "utf8");
expectMatch(initSrc, /Regular index on start_at/, "init.ts comment now accurately describes a regular index");
if (/Partial index for "upcoming events"/.test(initSrc)) {
  fail("init.ts no longer claims partial index", "old misleading comment still present");
} else {
  ok("init.ts no longer claims partial index");
}

console.log(`\nWO-17 tests: ${passed} passed, ${failed} failed`);

// ─────────────────────────────────────────────────────────────────────
// GEO Lever 1 (dev-request 2026-06-30-geo-content-structured-data):
// FAQPage JSON-LD on /produsent/:slug — behavioural render tests.
//
// Seeds a real (in-memory) production schema via __setDbForTesting +
// __initSchemaForTesting, registers producers through the public
// marketplaceRegistry/knowledgeService APIs (same path production writes
// use), then invokes the seo.ts router's GET /produsent/:slug handler
// directly (sync mock req/res — no live HTTP server needed) and parses
// the emitted <script type="application/ld+json"> blocks.
// ─────────────────────────────────────────────────────────────────────
async function runFaqJsonLdTests() {
  console.log("\n── GEO Lever 1: FAQPage JSON-LD on /produsent/:slug ──");

  const Database = (await import("better-sqlite3")).default;
  const { __setDbForTesting, __initSchemaForTesting } = await import("../src/database/init");
  const { loadConfigsAtBoot } = await import("../src/config/vertical-config");

  // seo.ts's shell() calls getConfig(), which requires loadConfigsAtBoot()
  // to have run first (normally done once in src/index.ts). Safe/idempotent
  // to call again here if some other harness already booted it.
  try { loadConfigsAtBoot(); } catch { /* already loaded, or dir already cached elsewhere */ }

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  const { marketplaceRegistry } = await import("../src/services/marketplace-registry");
  const { knowledgeService } = await import("../src/services/knowledge-service");
  const seoMod = await import("../src/routes/seo");
  const seoRouter = seoMod.default as any;

  function baseRegistration(name: string, city: string) {
    return {
      name,
      description: "Test-registrering for FAQPage JSON-LD-testen.",
      provider: "test-suite",
      contactEmail: "test@example.no",
      url: "https://example.no",
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      skills: [{ id: "default", name: "Selger mat", description: "Selger lokal mat", tags: [], inputModes: ["application/json"], outputModes: ["application/json"] }],
      role: "producer" as const,
      location: { lat: 59.91, lng: 10.75, city },
      categories: ["vegetables"],
      tags: [],
      languages: ["no"],
    };
  }

  // Fixture 1 — RICH producer: real products, address, city, delivery
  // options AND a website. Should clear the bar for all 3 Q&A.
  const rich = marketplaceRegistry.register(baseRegistration("Rik Gård FAQ-test", "Oslo"));
  knowledgeService.upsertKnowledge(rich.id, {
    address: "Gårdsveien 12",
    products: [{ name: "Gulrøtter" } as any, { name: "Poteter" } as any],
    deliveryOptions: ["Henting på gården", "Levering i Oslo"],
    website: "https://rikgard.example.no",
  } as any);

  // Fixture 2 — THIN producer: no products, no category-worthy data beyond
  // the default, no address, no delivery/website. Must NOT emit FAQPage —
  // this is the "no fabricated content" guard the dev-request requires.
  const thin = marketplaceRegistry.register({
    ...baseRegistration("Tynn Gård FAQ-test", ""),
    location: undefined,
    categories: [],
  });
  // No knowledge row at all — agent_knowledge lookup will just return {}.

  // Fixture 3 — BORDERLINE producer: city only (no address, no products,
  // but has a real category) → "Hva selger" from category + "Hvor ligger"
  // from city clears the >=2 threshold; "besøke/bestille" must be absent
  // (no opening hours, no delivery options, no website).
  const borderline = marketplaceRegistry.register(baseRegistration("Grense Gård FAQ-test", "Bergen"));

  function invokeProdusent(slug: string): { status: number; body: string } {
    const layer = (seoRouter.stack as any[]).find(
      (l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get
    );
    if (!layer) throw new Error("seo.ts router has no GET /produsent/:slug layer");
    let status = 200; let body = "";
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      status: (c: number) => { status = c; res.statusCode = c; return res; },
      send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
      redirect: () => {},
    };
    const req: any = { path: `/produsent/${slug}`, params: { slug }, query: {}, lang: "no" };
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    handler(req, res, () => {});
    return { status, body };
  }

  function extractJsonLdBlocks(html: string): any[] {
    const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const out: any[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      out.push(JSON.parse(m[1])); // throws (fails the test) if not valid JSON
    }
    return out;
  }

  // ── Rich producer: FAQPage present, valid, all 3 Q&A ──
  {
    const slug = require("../src/utils/slug").slugify(rich.name);
    const { status, body } = invokeProdusent(slug);
    assertEq2(status, 200, "geo-faq: rich producer page → 200");
    const blocks = extractJsonLdBlocks(body);
    assertTrue2(blocks.length >= 2, "geo-faq: rich producer emits >=2 JSON-LD blocks (LocalBusiness + FAQPage)");
    const faq = blocks.find((b) => b["@type"] === "FAQPage");
    assertTrue2(!!faq, "geo-faq: rich producer emits a block with @type FAQPage");
    if (faq) {
      assertTrue2(Array.isArray(faq.mainEntity) && faq.mainEntity.length === 3, `geo-faq: rich producer FAQPage has 3 Q&A (got ${faq.mainEntity?.length})`);
      assertTrue2(faq.mainEntity.every((q: any) => q["@type"] === "Question" && q.acceptedAnswer?.["@type"] === "Answer" && typeof q.acceptedAnswer.text === "string" && q.acceptedAnswer.text.length > 0),
        "geo-faq: every mainEntity item is a well-formed Question/Answer pair");
      assertTrue2(faq.mainEntity.some((q: any) => /Gulr[øo]tter/.test(q.acceptedAnswer.text)),
        "geo-faq: 'Hva selger' answer traces to a real product name (Gulrøtter)");
      assertTrue2(faq.mainEntity.some((q: any) => /G[åa]rdsveien 12/.test(q.acceptedAnswer.text)),
        "geo-faq: 'Hvor ligger' answer traces to the real address");
      assertTrue2(faq.mainEntity.some((q: any) => /henting p[åa] g[åa]rden|levering i oslo/i.test(q.acceptedAnswer.text)),
        "geo-faq: 'besøke/bestille' answer traces to real delivery options");
    }
  }

  // ── Thin producer: FAQPage absent (no fabricated content) ──
  {
    const slug = require("../src/utils/slug").slugify(thin.name);
    const { status, body } = invokeProdusent(slug);
    assertEq2(status, 200, "geo-faq: thin producer page → 200");
    const blocks = extractJsonLdBlocks(body);
    const faq = blocks.find((b) => b["@type"] === "FAQPage");
    assertTrue2(!faq, "geo-faq: thin producer (no products/address/city) does NOT emit FAQPage");
  }

  // ── Borderline producer: exactly 2 Q&A, no fabricated 3rd question ──
  {
    const slug = require("../src/utils/slug").slugify(borderline.name);
    const { status, body } = invokeProdusent(slug);
    assertEq2(status, 200, "geo-faq: borderline producer page → 200");
    const blocks = extractJsonLdBlocks(body);
    const faq = blocks.find((b) => b["@type"] === "FAQPage");
    assertTrue2(!!faq, "geo-faq: borderline producer (category + city only) still emits FAQPage (2 real Q&A)");
    if (faq) {
      assertEq2(faq.mainEntity.length, 2, "geo-faq: borderline producer FAQPage has exactly 2 Q&A (no fabricated visit/order answer)");
      assertTrue2(!faq.mainEntity.some((q: any) => /bes[øo]ke|bestille/i.test(q.name)),
        "geo-faq: borderline producer has no 'besøke/bestille' question (no real signal for it)");
    }
  }

  db.close();
}

let passed2 = 0;
let failed2 = 0;
const failures2: string[] = [];
function assertTrue2(cond: boolean, label: string) {
  if (cond) { passed2++; console.log(`  ok ${label}`); }
  else { failed2++; failures2.push(`  FAIL ${label}`); }
}
function assertEq2(actual: unknown, expected: unknown, label: string) {
  assertTrue2(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

(async () => {
  await runFaqJsonLdTests();

  console.log(`\nGEO Lever 1 (FAQPage) tests: ${passed2} passed, ${failed2} failed`);

  const totalFailed = failed + failed2;
  if (totalFailed > 0) {
    console.log([...failures, ...failures2].join("\n"));
    process.exit(1);
  }
  // Explicit clean exit: importing src/routes/seo.ts pulls in
  // analytics-service.ts's module-level `setInterval` (5 min session-cleanup
  // sweep), which otherwise keeps this standalone runner's event loop alive
  // well past test completion.
  process.exit(0);
})();

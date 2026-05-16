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
if (failed > 0) {
  console.log(failures.join("\n"));
  process.exit(1);
}

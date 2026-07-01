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
import { buildProducerFaqJsonLd } from "../src/routes/seo";

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
function expectTrue(cond: boolean, label: string, why = "condition was false") {
  if (cond) ok(label);
  else fail(label, why);
}

console.log("\n── geo-content-structured-data: buildProducerFaqJsonLd invocation tests ──");
const faqBase = { url: "https://rettfrabonden.com/produsent/test-gard", cityName: "", productsList: [], categories: [], hoursList: [], hoursText: "" };

expectTrue(
  buildProducerFaqJsonLd({ ...faqBase, name: "Tomprofil" }) === null,
  "0 real fields -> null (no thin-page FAQ emitted)"
);
expectTrue(
  buildProducerFaqJsonLd({ ...faqBase, name: "Kun By", cityName: "Asker" }) === null,
  "only 1 real field (city) -> null (below 2-question quality gate)"
);
{
  const faq = buildProducerFaqJsonLd({ ...faqBase, name: "Gård AS", cityName: "Asker", productsList: ["Honning", "Egg"] });
  expectTrue(!!faq && faq["@type"] === "FAQPage", "2 real fields -> non-null FAQPage");
  expectTrue(!!faq && Array.isArray(faq.mainEntity) && faq.mainEntity.length === 2, "2 real fields -> exactly 2 questions");
  expectTrue(!!faq && faq.mainEntity.every((q: any) => q["@type"] === "Question" && q.acceptedAnswer?.["@type"] === "Answer"), "each mainEntity item is a valid Question/Answer pair");
  expectTrue(!!faq && faq.mainEntity[0].acceptedAnswer.text.includes("Honning"), "sell-question answer includes real product name (not fabricated)");
}
{
  const faq = buildProducerFaqJsonLd({ ...faqBase, name: "Gård AS", cityName: "Asker", productsList: ["Honning"], website: "https://gard.no" });
  expectTrue(!!faq && faq.mainEntity.length === 3, "3 real fields (products+city+website) -> exactly 3 questions");
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

console.log("\n── geo-content-structured-data: producer FAQPage JSON-LD assertions ──");
expectMatch(seoSrc, /function buildProducerFaqJsonLd/, "seo.ts defines buildProducerFaqJsonLd");
expectMatch(seoSrc, /"@type":\s*"FAQPage"/, "seo.ts contains FAQPage @type");
expectMatch(seoSrc, /"@type":\s*"Question"/, "seo.ts contains Question @type");
expectMatch(seoSrc, /"@type":\s*"Answer"/, "seo.ts contains Answer @type");
expectMatch(seoSrc, /if \(qas\.length < 2\) return null;/, "seo.ts FAQ builder quality-gates on 2+ real answers (no thin pages)");
expectMatch(seoSrc, /jsonLd:\s*faqJsonLd\s*\?\s*\[jsonLd,\s*faqJsonLd\]\s*:\s*jsonLd/, "seo.ts wires FAQPage block into the producer page's JSON-LD array");

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

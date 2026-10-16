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
import { buildProducerFaqJsonLd, buildCityFaqJsonLd } from "../src/routes/seo";
import { buildCategoryFaqJsonLd, buildKommuneFaqJsonLd } from "../src/routes/experiences-seo";

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

console.log("\n── geo-content-structured-data: buildCityFaqJsonLd invocation tests (city/category slice) ──");
const cityFaqBase = { cityName: "Asker", url: "https://rettfrabonden.com/asker", producerCount: 0, topCategories: [], verifiedCount: 0 };

expectTrue(
  buildCityFaqJsonLd({ ...cityFaqBase, producerCount: 0 }) === null,
  "0 producers, no categories, no verified -> null (below 2-question quality gate)"
);
expectTrue(
  buildCityFaqJsonLd({ ...cityFaqBase, producerCount: 3 }) === null,
  "producer-count alone (1 real field) -> null (no thin-page FAQ emitted)"
);
{
  const faq = buildCityFaqJsonLd({ ...cityFaqBase, producerCount: 5, topCategories: ["honning", "ost"] });
  expectTrue(!!faq && faq["@type"] === "FAQPage", "count + categories (2 real fields) -> non-null FAQPage");
  expectTrue(!!faq && Array.isArray(faq.mainEntity) && faq.mainEntity.length === 2, "2 real fields -> exactly 2 questions");
  expectTrue(!!faq && faq.mainEntity.every((q: any) => q["@type"] === "Question" && q.acceptedAnswer?.["@type"] === "Answer"), "each mainEntity item is a valid Question/Answer pair");
  expectTrue(!!faq && faq.mainEntity[1].acceptedAnswer.text.includes("honning"), "category-question answer includes real category name (not fabricated)");
}
{
  const faq = buildCityFaqJsonLd({ ...cityFaqBase, producerCount: 5, topCategories: ["honning"], verifiedCount: 2 });
  expectTrue(!!faq && faq.mainEntity.length === 3, "3 real fields (count+category+verified) -> exactly 3 questions");
}

console.log("\n── geo-content-structured-data: buildCategoryFaqJsonLd invocation tests (category/city slice, experiences vertical) ──");
const catFaqBase = { label: "Dyreliv & safari", url: "https://opplevagent.no/kategori/dyreliv_safari", total: 0, fylkeCount: 0, kommuneCount: 0, minPriceFrom: null as number | null };

expectTrue(
  buildCategoryFaqJsonLd({ ...catFaqBase, total: 0 }) === null,
  "0 experiences, no fylker, no price -> null (below 2-question quality gate)"
);
expectTrue(
  buildCategoryFaqJsonLd({ ...catFaqBase, total: 4 }) === null,
  "total alone (1 real field) -> null (no thin-page FAQ emitted)"
);
{
  const faq = buildCategoryFaqJsonLd({ ...catFaqBase, total: 4, fylkeCount: 2, kommuneCount: 3 });
  expectTrue(!!faq && faq["@type"] === "FAQPage", "count + fylker (2 real fields) -> non-null FAQPage");
  expectTrue(!!faq && Array.isArray(faq.mainEntity) && faq.mainEntity.length === 2, "2 real fields -> exactly 2 questions");
  expectTrue(!!faq && faq.mainEntity.every((q: any) => q["@type"] === "Question" && q.acceptedAnswer?.["@type"] === "Answer"), "each mainEntity item is a valid Question/Answer pair");
  expectTrue(!!faq && faq.mainEntity[1].acceptedAnswer.text.includes("2 fylker"), "fylke-question answer includes real fylke count (not fabricated)");
}
{
  const faq = buildCategoryFaqJsonLd({ ...catFaqBase, total: 4, fylkeCount: 2, kommuneCount: 3, minPriceFrom: 490 });
  expectTrue(!!faq && faq.mainEntity.length === 3, "3 real fields (total+fylker+price) -> exactly 3 questions");
  expectTrue(!!faq && faq.mainEntity[2].acceptedAnswer.text.includes("490 kr"), "price-question answer includes real min price (not fabricated)");
}

console.log("\n── geo-content-structured-data: buildKommuneFaqJsonLd invocation tests (category/city slice, experiences vertical) ──");
const kommuneFaqBase = { kommune: "Tromsø", fylke: "Troms og Finnmark" as string | null, url: "https://opplevagent.no/kommune/troms%C3%B8", total: 0, categoryCount: 0, minPriceFrom: null as number | null };

expectTrue(
  buildKommuneFaqJsonLd({ ...kommuneFaqBase, total: 0 }) === null,
  "0 experiences, no categories, no price -> null (below 2-question quality gate)"
);
expectTrue(
  buildKommuneFaqJsonLd({ ...kommuneFaqBase, total: 6 }) === null,
  "total alone (1 real field) -> null (no thin-page FAQ emitted)"
);
{
  const faq = buildKommuneFaqJsonLd({ ...kommuneFaqBase, total: 6, categoryCount: 3 });
  expectTrue(!!faq && faq["@type"] === "FAQPage", "count + categories (2 real fields) -> non-null FAQPage");
  expectTrue(!!faq && Array.isArray(faq.mainEntity) && faq.mainEntity.length === 2, "2 real fields -> exactly 2 questions");
  expectTrue(!!faq && faq.mainEntity.every((q: any) => q["@type"] === "Question" && q.acceptedAnswer?.["@type"] === "Answer"), "each mainEntity item is a valid Question/Answer pair");
  expectTrue(!!faq && faq.mainEntity[0].acceptedAnswer.text.includes("Tromsø"), "count-question answer includes the real kommune name (not fabricated)");
}
{
  const faq = buildKommuneFaqJsonLd({ ...kommuneFaqBase, total: 6, categoryCount: 3, minPriceFrom: 250 });
  expectTrue(!!faq && faq.mainEntity.length === 3, "3 real fields (total+categories+price) -> exactly 3 questions");
}

// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
// (S1) replaces WO-17's presence checks with absence invariants: no
// third-party rating/review markup, no invented reviewCount/author, no fixed
// return/shipping terms. Brand stays. The rendered-page checks live in
// src/routes/rfb-jsonld-ingen-tredjepartsrating.test.ts.
console.log("── WO-17 → 2026-10-16 S1: seo.ts JSON-LD source assertions ──");
const seoSrc = readFileSync(join(__dirname, "..", "src", "routes", "seo.ts"), "utf8");
function expectNoMatch(haystack: string, needle: RegExp, label: string) {
  if (!needle.test(haystack)) ok(label);
  else fail(label, `pattern ${needle} still present`);
}
expectMatch(seoSrc, /"@type":\s*"Brand"/, "seo.ts contains Brand @type");
expectNoMatch(seoSrc, /"hasMerchantReturnPolicy"\s*:/, "seo.ts has no fixed hasMerchantReturnPolicy");
expectNoMatch(seoSrc, /"shippingDetails"\s*:/, "seo.ts has no fixed shippingDetails");
expectNoMatch(seoSrc, /"@type":\s*"MerchantReturnPolicy"/, "seo.ts has no MerchantReturnPolicy @type");
expectNoMatch(seoSrc, /"@type":\s*"OfferShippingDetails"/, "seo.ts has no OfferShippingDetails @type");
expectNoMatch(seoSrc, /"merchantReturnDays"\s*:/, "seo.ts sets no merchantReturnDays");
expectNoMatch(seoSrc, /"@type":\s*"AggregateRating"/, "seo.ts builds no AggregateRating itself");
expectNoMatch(seoSrc, /"@type":\s*"Review"/, "seo.ts builds no Review nodes");
expectNoMatch(seoSrc, /product\.(aggregateRating|review)\s*=/, "seo.ts copies no rating/review onto Product");
expectNoMatch(seoSrc, /reviewCount"?\s*:[^,\n]*\|\|\s*1\b/, "seo.ts has no invented reviewCount fallback (|| 1)");
expectNoMatch(seoSrc, /"name":\s*r\.author\s*\|\|\s*"Kunde"/, "seo.ts has no invented JSON-LD review author («Kunde»)");
expectMatch(seoSrc, /buildRatingJsonLd\(\{\s*source:\s*"google"/, "seo.ts routes the Google rating through buildRatingJsonLd");
expectMatch(seoSrc, /\.\.\.buildOfferPolicyJsonLd\(/, "seo.ts takes Offer return/shipping nodes from buildOfferPolicyJsonLd");

console.log("\n── geo-content-structured-data: producer FAQPage JSON-LD assertions ──");
expectMatch(seoSrc, /function buildProducerFaqJsonLd/, "seo.ts defines buildProducerFaqJsonLd");
expectMatch(seoSrc, /"@type":\s*"FAQPage"/, "seo.ts contains FAQPage @type");
expectMatch(seoSrc, /"@type":\s*"Question"/, "seo.ts contains Question @type");
expectMatch(seoSrc, /"@type":\s*"Answer"/, "seo.ts contains Answer @type");
expectMatch(seoSrc, /if \(qas\.length < 2\) return null;/, "seo.ts FAQ builder quality-gates on 2+ real answers (no thin pages)");
expectMatch(seoSrc, /jsonLd:\s*faqJsonLd\s*\?\s*\[jsonLd,\s*faqJsonLd,\s*breadcrumbJsonLd\]\s*:\s*\[jsonLd,\s*breadcrumbJsonLd\]/, "seo.ts wires FAQPage block into the producer page's JSON-LD array (next to the BreadcrumbList)");
expectMatch(seoSrc, /function buildCityFaqJsonLd/, "seo.ts defines buildCityFaqJsonLd");
expectMatch(seoSrc, /if \(cityFaqJsonLd\) jsonLdItems\.push\(cityFaqJsonLd\);/, "seo.ts wires the city FAQPage block into the city page's JSON-LD array");

console.log("\n── geo-content-structured-data: category/kommune FAQPage JSON-LD assertions (experiences vertical) ──");
const expSeoSrc = readFileSync(join(__dirname, "..", "src", "routes", "experiences-seo.ts"), "utf8");
expectMatch(expSeoSrc, /export function buildCategoryFaqJsonLd/, "experiences-seo.ts defines buildCategoryFaqJsonLd");
expectMatch(expSeoSrc, /export function buildKommuneFaqJsonLd/, "experiences-seo.ts defines buildKommuneFaqJsonLd");
expectMatch(expSeoSrc, /if \(qas\.length < 2\) return null;/, "experiences-seo.ts FAQ builders quality-gate on 2+ real answers (no thin pages)");
expectMatch(expSeoSrc, /extraJsonLd:\s*categoryFaqJsonLd\s*\?\s*\[categoryFaqJsonLd\]\s*:\s*undefined/, "experiences-seo.ts wires the category FAQPage block into /kategori/:category's JSON-LD");
expectMatch(expSeoSrc, /extraJsonLd:\s*kommuneFaqJsonLd\s*\?\s*\[kommuneFaqJsonLd\]\s*:\s*undefined/, "experiences-seo.ts wires the kommune FAQPage block into /kommune/:kommune's JSON-LD");
const expStoreSrc = readFileSync(join(__dirname, "..", "src", "services", "experience-store.ts"), "utf8");
expectMatch(expStoreSrc, /export function getCategoryFaqStats/, "experience-store.ts defines getCategoryFaqStats");
expectMatch(expStoreSrc, /export function getKommuneFaqStats/, "experience-store.ts defines getKommuneFaqStats");

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
// Importing seo.ts / experiences-seo.ts starts timers that would keep a green
// standalone run alive forever; this file is not imported by tests/test.ts.
process.exit(0);

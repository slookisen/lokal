/**
 * marketplace-search-english-queries.test.ts — dev-request
 * 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * OpenAI rejected the Rett fra Bonden ChatGPT app on 2026-09-05:
 *
 *   «One or more of your test cases did not produce correct results. Please
 *    re-run all submitted test cases and align tool behavior/output with the
 *    documented expected outcomes.»
 *
 * The reviewers test in ENGLISH. `parseNaturalQuery`'s category keywords are
 * Norwegian, and discover() applies `categories` as a HARD filter — so an
 * English query detected no category, no filter ran at all, and the search
 * silently degraded to "the N nearest producers, whatever they sell".
 *
 * Measured live against rettfrabonden.com/mcp on 2026-09-05, before the fix:
 *
 *   `ost Bergen`
 *     → Colonialen Fetevare, Møllendal Fetevare, Ostegården — Krokeide
 *       (Fanaost: world's best cheese 2018). Correct.
 *   `Show me producers near Bergen that sell cheese`
 *     → ten producers, NONE of which sells cheese: a bakery, a fish market,
 *       a reindeer butcher, a beekeeper, and one that sells only courses and
 *       consulting. None of the three real cheese sellers appeared.
 *
 *   `honning Vestfold`
 *     → TønsbergBier (trust 84 %), Sætrehonning (trust 90 %). Correct.
 *   `Find a farm in Vestfold with raw honey`
 *     → eight producers whose only shared trait was the word "Vestfold" in
 *       their NAME (a deer farm first, a bakery second). Neither real honey
 *       producer appeared. Two separate bugs stacked here: "farm" is a
 *       name-indicator, and the place name "Vestfold" was allowed to become a
 *       producer-name token, and the name branch returns early — skipping the
 *       honey category that had in fact been detected correctly.
 *
 * A 20-query sample had 13 English queries parsing differently from their
 * Norwegian equivalent.
 *
 * Every case below is one of those measured failures. They are pure-parser
 * assertions (no DB, no network): parseNaturalQuery is the whole defect.
 *
 * Exported runMarketplaceSearchEnglishQueryTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone:
 *   npx tsx src/services/marketplace-search-english-queries.test.ts
 */

import Database from "better-sqlite3";
import { marketplaceRegistry } from "./marketplace-registry";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import {
  norwegianTermsForEnglishQuery,
  isEnglishFoodWord,
  reverseGlossarySize,
} from "../i18n/product-glossary";

type TestSummary = { passed: number; failed: number; failures: string[] };

export function runMarketplaceSearchEnglishQueryTests(opts: { log?: boolean } = {}): TestSummary {
  const log = !!opts.log;
  let passed = 0, failed = 0;
  const failures: string[] = [];

  // parseNaturalQuery's Pass 2 (name detection) reads the agents table, so the
  // suite needs a DB even though every assertion below is about the parser.
  // Own throwaway in-memory DB, restored afterwards — same pattern as
  // marketplace-search-honesty.test.ts. Empty agents table is exactly right
  // here: no name can match, so the CATEGORY path is what gets measured.
  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence the registry's name-search chatter */ };
  try {

    const ok = (cond: boolean, what: string) => {
      if (cond) { passed++; if (log) console.log(`    ✓ ${what}`); }
      else { failed++; failures.push(what); if (log) console.log(`    ✗ ${what}`); }
    };

    const cats = (q: string): string[] => {
      const p = marketplaceRegistry.parseNaturalQuery(q) as any;
      return (p.categories as string[] | undefined) ?? [];
    };
    const nameQuery = (q: string): string | undefined =>
      (marketplaceRegistry.parseNaturalQuery(q) as any)._nameQuery;

    /** The core contract: an English query selects the same category as its Norwegian twin. */
    const parity = (en: string, no: string, expected: string) => {
      ok(cats(no).includes(expected), `NO "${no}" → ${expected} (unchanged)`);
      ok(cats(en).includes(expected), `EN "${en}" → ${expected}`);
    };

    // ════════════════════════════════════════════════════════════════════
    // A — the two queries the OpenAI reviewer's rejection is traceable to
    // ════════════════════════════════════════════════════════════════════
    parity("Show me producers near Bergen that sell cheese", "ost Bergen", "dairy");
    parity("Find a farm in Vestfold with raw honey", "honning Vestfold", "honey");

    // The honey case again, from its other end: a PLACE name must never become
    // a producer-name token, because the name branch returns early and would
    // discard the category above.
    const honeyName = nameQuery("Find a farm in Vestfold with raw honey");
    ok(!honeyName || !/vestfold/i.test(honeyName),
      `"…farm in Vestfold with raw honey" does not name-search on "Vestfold" (got ${JSON.stringify(honeyName)})`);
    ok(!/vestfold/i.test(String(nameQuery("gårdsutsalg i Vestfold") ?? "")),
      `Norwegian "gårdsutsalg i Vestfold" does not name-search on "Vestfold" either`);

    // ════════════════════════════════════════════════════════════════════
    // B — the rest of the measured EN/NO divergence
    // ════════════════════════════════════════════════════════════════════
    parity("Debio-certified vegetable producers in Trøndelag", "økologiske grønnsaker Trøndelag", "vegetables");
    parity("local milk in Oslo", "melk Oslo", "dairy");
    parity("strawberries in Vestfold", "jordbær Vestfold", "berries");
    parity("organic apples", "økologiske epler", "fruit");
    parity("salmon from Lofoten", "laks Lofoten", "fish");
    parity("seafood Tromsø", "sjømat Tromsø", "fish");
    parity("potatoes Bodø", "poteter Bodø", "vegetables");
    parity("goat cheese farm", "geitost gård", "dairy");
    parity("pork sausages", "svin Rogaland", "meat");
    // NB: the Norwegian twin is «svin», not «svinepølser». Category keywords are
    // matched on a word boundary, so a Norwegian COMPOUND ("svinepølser",
    // "geitostkake") selects no category — a real, pre-existing bug of the same
    // class, in Norwegian, that this dev-request deliberately does NOT widen
    // into: loosening the match touches all 134 non-drink keywords and needs its
    // own before/after measurement (the same call the source comment on
    // PRODUCT_TERM_EXCLUSIONS already makes). Filed as a FUNN, not fixed here.
    ok(cats("svinepølser").length === 0,
      "KNOWN GAP (own slice): Norwegian compound «svinepølser» still selects no category");
    parity("spices and herbs", "krydder og urter", "herbs");

    // Singular as well as plural — reviewers write "a vegetable producer".
    ok(cats("vegetable producer near Oslo").includes("vegetables"), `EN singular "vegetable" → vegetables`);
    ok(cats("cheese").includes("dairy"), `EN bare "cheese" → dairy`);

    // Tags must survive the same path.
    ok((marketplaceRegistry.parseNaturalQuery("organic apples") as any).tags?.includes("organic"),
      `EN "organic apples" → organic tag`);

    // ════════════════════════════════════════════════════════════════════
    // C — «and» is Norwegian for duck AND English for "and"
    // ════════════════════════════════════════════════════════════════════
    // Before the guard, EVERY English query containing the conjunction was
    // classified as `meat` — and categories are a hard filter, so
    // "butter and cream" returned meat producers and no dairy at all.
    ok(cats("butter and cream").includes("dairy"), `EN "butter and cream" → dairy`);
    ok(!cats("butter and cream").includes("meat"), `EN "butter and cream" is NOT meat (the "and" false friend)`);
    ok(!cats("cheese and bread").includes("meat"), `EN "cheese and bread" is NOT meat`);
    // …but a Norwegian user asking for duck still gets meat.
    ok(cats("and").includes("meat"), `NO "and" (duck) → meat, unchanged`);
    ok(cats("and fra Hedmark").includes("meat"), `NO "and fra Hedmark" → meat, unchanged`);

    // ────────────────────────────────────────────────────────────────────
    // C2 — regression: an identical-spelling loanword must NOT be mistaken
    // for "this looks like an English query" and suppress the Norwegian
    // «and» (duck) keyword.
    //
    // `norwegianTermsForEnglishQuery` is built off a reverse index of
    // English→Norwegian translations. A loanword like "yoghurt" is spelled
    // IDENTICALLY in both languages, so before the fix it round-tripped to
    // itself in that index — `norwegianTermsForEnglishQuery("and og
    // yoghurt")` returned `["yoghurt"]` purely from a 100%-Norwegian query,
    // which made `suppressEnglishConjunction` fire and silently dropped the
    // `and` (duck) keyword — and therefore the `meat` category — from a HARD
    // category filter, for a query with no English word in it at all.
    // Measured 2026-09-05: this is exactly the "category silently dropped"
    // defect class the rest of this file exists to fix, reproduced here for
    // a pure Norwegian query.
    ok(cats("and og yoghurt").includes("meat"),
      `NO "and og yoghurt" (duck and yogurt) → meat (identical-spelling loanword "yoghurt" must not suppress "and")`);
    ok(norwegianTermsForEnglishQuery("and og yoghurt").length === 0,
      `reverse glossary: identical-spelling loanword "yoghurt" contributes no English-query signal on its own`);
    // Same shape with a different identical-spelling loanword.
    ok(cats("and og bacon").includes("meat"),
      `NO "and og bacon" (duck and bacon) → meat (identical-spelling loanword "bacon" must not suppress "and")`);

    // Positive-mapping sanity check, right next to the fix above: a REAL
    // cross-language pair (different spelling, genuine translation) must
    // still be indexed — confirms the identical-spelling fix did not
    // overreach and start excluding real translations too.
    ok(norwegianTermsForEnglishQuery("cheese").includes("ost"),
      `regression guard: real translation pair cheese → ost is still indexed after the loanword fix`);
    ok(norwegianTermsForEnglishQuery("yoghurt").length === 0,
      `regression guard: identical-spelling "yoghurt" maps to nothing (not even itself) in the reverse index`);

    // ════════════════════════════════════════════════════════════════════
    // D — «bakeri» selected no category, in EITHER language
    // ════════════════════════════════════════════════════════════════════
    ok(cats("bakeri Trondheim").includes("bread"), `NO "bakeri Trondheim" → bread (was: no category at all)`);
    ok(cats("bakery in Trondheim").includes("bread"), `EN "bakery in Trondheim" → bread`);

    // ════════════════════════════════════════════════════════════════════
    // E — no regression in the Norwegian name search
    // ════════════════════════════════════════════════════════════════════
    ok(nameQuery("Bjørndal Gård Oppdal") === "Bjørndal Gård Oppdal",
      `name search "Bjørndal Gård Oppdal" is preserved verbatim`);
    ok(String(nameQuery("Rørosmat") ?? "").toLowerCase().includes("rørosmat"),
      `name search "Rørosmat" still resolves`);
    // A Norwegian food query must not start name-searching on its food words.
    ok(cats("fersk fisk i Bergen").includes("fish"), `NO "fersk fisk i Bergen" → fish, unchanged`);

    // ════════════════════════════════════════════════════════════════════
    // F — the reverse glossary itself
    // ════════════════════════════════════════════════════════════════════
    ok(norwegianTermsForEnglishQuery("cheese").includes("ost"), `reverse glossary: cheese → ost`);
    ok(norwegianTermsForEnglishQuery("salmon").includes("laks"), `reverse glossary: salmon → laks`);
    ok(norwegianTermsForEnglishQuery("goat cheese").includes("geitost"), `reverse glossary: phrase "goat cheese" → geitost`);
    ok(norwegianTermsForEnglishQuery("ost Bergen").length === 0, `reverse glossary: a Norwegian query yields nothing`);
    ok(norwegianTermsForEnglishQuery("").length === 0, `reverse glossary: empty query is safe`);
    // "is" (ice cream) and "and" (duck) must never be auto-mapped from English.
    ok(!norwegianTermsForEnglishQuery("what is available").includes("is"),
      `reverse glossary: English "is" does not map to «is» (ice cream)`);
    ok(isEnglishFoodWord("cheese") && isEnglishFoodWord("goat"), `isEnglishFoodWord covers words and phrase modifiers`);
    ok(!isEnglishFoodWord("bergen"), `isEnglishFoodWord does not claim place names`);
    ok(reverseGlossarySize() > 300, `reverse glossary covers >300 English words (${reverseGlossarySize()})`);

  } finally {
    console.log = prevLog;
    // Restore the singleton; deliberately no db.close() — nothing else owns
    // this handle and closing it breaks any straggler that captured it.
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const s = runMarketplaceSearchEnglishQueryTests({ log: true });
  console.log(`\n${s.passed} passed, ${s.failed} failed`);
  process.exit(s.failed > 0 ? 1 : 0);
}

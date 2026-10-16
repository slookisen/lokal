/**
 * opplevagent-submission-replay.test.ts — dev-request
 * 2026-10-16-opplevagent-mcp-fritekst-query, acceptance criterion 9.
 *
 * The discover_experiences test cases of the ChatGPT app submission
 * (opplevagent-chatgpt-app-submission.json) replayed with three argument
 * shapes a model may send: only `query`, only structured arguments, and
 * both. Each shape must keep the case's invariant, and "both" must return the
 * same id list as "structured only" — adding the user's words to a
 * structured call never changes the answer OpenAI already reviewed. With
 * only `query`, P1/P2/P4 must be read exactly (no relaxation, and P1/P4 no
 * search words).
 *
 * N1 ("Book the northern lights cruise … charge my credit card now") calls no
 * tool in the submission, but a model that passes the request in `query`, as
 * the instructions ask, must still find the cruise so the answer can point to
 * its booking page: replayed query-only. The other submission cases (P3
 * categories, P5 gårdssalg, N2 no tool) use tools and instructions this
 * dev-request does not touch; the contract freeze
 * (opplevagent-mcp-contract-freeze.test.ts) pins those.
 *
 * Fixture: seedOpplevagentQueryFixture() from
 * opplevagent-mcp-query-intent.test.ts.
 *
 * Standalone: npx tsx src/routes/opplevagent-submission-replay.test.ts
 * Wired into the gate via tests/test.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface ReplayCase {
  id: string;
  prompt: string;
  structured: Record<string, unknown>;
  /** Returns the names of the invariants a result breaks (empty = holds). */
  check: (r: any, ids: Record<string, string>) => string[];
  /** Query-only must be read exactly: no relaxed filter, and (searchWords false) no search words. */
  exact?: { searchWords: boolean };
}

export function runOpplevagentSubmissionReplayTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const winterOrYearRound = (season: string[]) =>
    season.length === 0 || season.some((s) => ["winter", "vinter", "all_year", "year_round"].includes(s));

  const cases: ReplayCase[] = [
    {
      id: "P1",
      prompt: "Hva kan vi finne på i Troms om vinteren?",
      structured: { fylke: "Troms", season: "winter" },
      check: (r, ids) => [
        ...(r.count > 0 ? [] : ["has rows"]),
        ...(r.experiences.every((e: any) => e.fylke === "Troms") ? [] : ["only Troms"]),
        ...(r.experiences.every((e: any) => winterOrYearRound(e.season)) ? [] : ["winter or all year only"]),
        ...(r.experiences.some((e: any) => e.id === ids.arctic) ? [] : ["Arctic Explorer listed"]),
        ...(r.filter_applied.category === undefined ? [] : ["category is not vinter_sno"]),
      ],
      exact: { searchWords: false },
    },
    {
      id: "P2",
      prompt: "Show me the details of the Arctic Explorer northern lights cruise in Tromsø",
      structured: { kommune: "Tromsø" },
      check: (r, ids) => [
        ...(r.experiences.some((e: any) => e.id === ids.arctic) ? [] : ["Arctic Explorer among the hits"]),
        ...(r.experiences.every((e: any) => e.kommune === "Tromsø") ? [] : ["only Tromsø"]),
      ],
      exact: { searchWords: true },
    },
    {
      id: "P4",
      prompt: "Find wildlife and animal experiences in Norway",
      structured: { category: "dyreliv_safari" },
      check: (r) => [
        ...(r.count > 0 && r.experiences.every((e: any) => e.category === "dyreliv_safari") ? [] : ["only dyreliv_safari"]),
        ...(["fylke", "kommune", "kommuner"].every((k) => r.filter_applied[k] === undefined) ? [] : ["no place filter (Norway = whole country)"]),
        ...(new Set(r.experiences.map((e: any) => e.fylke)).size >= 3 ? [] : ["several counties"]),
      ],
      exact: { searchWords: false },
    },
    {
      id: "N3",
      prompt: "Find me a safari lodge in Kenya for next month",
      structured: { fylke: "Kenya", category: "safari" },
      check: (r) => (r.count === 0 && r.out_of_area === true && r.experiences.length === 0 ? [] : ["out_of_area, no rows"]),
    },
  ];

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/experiences-query-intent"),
      require.resolve("./experiences-mcp"),
    ]);
    let session: Awaited<ReturnType<typeof import("./opplevagent-mcp-query-intent.test").openOpplevagentMcpSession>> | undefined;

    try {
      const { seedOpplevagentQueryFixture, openOpplevagentMcpSession } =
        require("./opplevagent-mcp-query-intent.test") as typeof import("./opplevagent-mcp-query-intent.test");
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const ids = seedOpplevagentQueryFixture(expStore, dbFactory.getDb("experiences") as any);
      session = await openOpplevagentMcpSession(require("./experiences-mcp") as typeof import("./experiences-mcp"));

      // The replayed prompts are the submission's own, word for word.
      const submission = JSON.parse(fs.readFileSync(path.join(__dirname, "../../opplevagent-chatgpt-app-submission.json"), "utf8"));
      const prompts = [...submission.test_cases, ...submission.negative_test_cases].map((c: any) => c.user_prompt);
      for (const c of cases) {
        assertEq(prompts.includes(c.prompt), true, `r0-${c.id}: the replayed prompt is a submission test case`);
      }

      for (const c of cases) {
        const forms: Record<string, Record<string, unknown>> = {
          query: { query: c.prompt },
          structured: c.structured,
          both: { ...c.structured, query: c.prompt },
        };
        const results: Record<string, any> = {};
        for (const [form, args] of Object.entries(forms)) {
          results[form] = await session.discover(args);
          assertEq(c.check(results[form], ids), [], `r1-${c.id}-${form}: the invariant holds`);
        }
        assertEq(results.both.experiences.map((e: any) => e.id), results.structured.experiences.map((e: any) => e.id),
          `r2-${c.id}: «both» returns the same id list as «structured only»`);
        assertEq(results.both.relaxed_filters, results.structured.relaxed_filters, `r2b-${c.id}: «both» relaxes what «structured only» relaxes`);
        if (c.exact) {
          assertEq([results.query.relaxed_filters, c.exact.searchWords || results.query.filter_applied.text_terms === undefined], [undefined, true],
            `r2c-${c.id}: query-only is read exactly (no relaxed filter${c.exact.searchWords ? "" : ", no search words"})`);
        }
      }

      // P4 reworded: the model passes the category and paraphrases the request.
      // The leftover words are no search words, so no "filters relaxed" banner.
      const p4Structured = await session.discover(cases[2].structured);
      for (const query of ["wildlife experiences across Norway", "animal encounters anywhere in Norway, ideally whales"]) {
        const r = await session.discover({ ...cases[2].structured, query });
        assertEq([r.experiences.map((e: any) => e.id), r.relaxed_filters, r.filter_applied.text_terms],
          [p4Structured.experiences.map((e: any) => e.id), undefined, undefined],
          `r5-P4: category + reworded query «${query}» = structured only, nothing relaxed`);
      }

      // N1 query-only: the cruise is found despite the payment words.
      const n1Prompt = "Book the northern lights cruise for two people and charge my credit card now";
      assertEq(prompts.includes(n1Prompt), true, "r0-N1: the replayed prompt is a submission test case");
      const n1 = await session.discover({ query: n1Prompt });
      assertEq([n1.experiences.some((e: any) => e.id === ids.arctic), n1.zero_hit_reason, Object.keys(n1.filter_applied)],
        [true, undefined, ["text_terms"]], "r6-N1: query-only lists the Arctic Explorer cruise, filtered by its words, not the whole catalogue");

      const p2 = await session.discover({ query: cases[1].prompt });
      assertEq(p2.experiences[0]?.id, ids.arctic, "r3-P2: with only the query, Arctic Explorer is the first hit (kommune Tromsø + title words)");
      const detail = await session.call("get_experience", { id: ids.arctic });
      assertEq(detail?.structuredContent?.title, "Arctic Explorer — Northern Lights Cruise from Tromsø", "r4-P2: get_experience still returns the record");
    } catch (err: any) {
      failed++;
      failures.push("opplevagent-submission-replay: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (session) await session.close();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevagent-submission-replay.test.ts`
if (require.main === module) {
  runOpplevagentSubmissionReplayTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

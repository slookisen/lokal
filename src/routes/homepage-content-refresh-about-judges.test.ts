/**
 * homepage-content-refresh-about-judges.test.ts — dev-request
 * 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring, skive B (AC2).
 *
 * refreshHomepageContent (routes/admin-knowledge.ts) runs three LLM judges on
 * an about/description candidate, each only when the previous approved —
 * quality (judgeRfbAboutCandidate), facts against the fetched pages
 * (judgeAboutAgainstPages), and, when a different non-empty about is stored,
 * "better than stored" (judgeAboutBetterThanStored) — and never replaces a
 * non-empty stored category list. Judges are stubbed (no network):
 *
 *   J1  stored 193 chars, candidate 113, comparison IKKE_BEDRE → nothing
 *       written, reason «about: ikke bedre enn lagret», about_not_better.
 *   J2  candidate shorter than stored, all three approve → written (about +
 *       description); facts judge got the fetched pages as text.
 *   J3  quality AVVIS / facts NOT_SUPPORTED → nothing written, comparison
 *       not called; about_judge_rejected / about_not_supported.
 *   J4  infra failure in any judge (missing key, timeout, non-200, ambiguous
 *       reply — the REAL judges against a stubbed Messages API) → nothing
 *       written, about_judge_unavailable.
 *   J5  empty stored about: quality + facts approve → written, comparison
 *       not called.
 *   J6  candidate equal to the stored text → no judge call, nothing written.
 *   J7  deadline: less than the judge timeout left → judge not started, the
 *       profile is transient (refresh_deadline_exceeded, not_reached, no
 *       strike, no rotation stamp, nothing written).
 *   J8  categories: stored [coffee] on a «bønner» page and [bakery, cafe] on
 *       a bakery page are not replaced; empty stored categories are filled.
 *   J9  the route with explicit agentIds (dry run + apply): same rules,
 *       about_reviews / counters / categories_corroboration in the answer.
 *   J10 the morning send's refreshRfbCandidateHomepage: same rules.
 *
 * Standalone: npx tsx src/routes/homepage-content-refresh-about-judges.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const STORED_193 =
  "Femtegenerasjonsgård på Sømna som driver med melkeku, egen ysting av hvitost og brunost, og salg av kalvekjøtt i sesong. Gården har hatt Spesialitet-merket siden 2015 og selger i gårdsbutikken.";
const CANDIDATE_113 =
  "Sjøvold leverer meieriprodukter i retail- og storkjøkkenformat til dagligvare og serveringsbransjen i hele Norge.";

function pageHtml(title: string, og: string | null, body: string): string {
  return (
    `<html><head><title>${title}</title>${og ? `<meta property="og:description" content="${og}">` : ""}</head>` +
    `<body><h1>${title}</h1><p>${body}</p></body></html>`
  );
}

type Judges = import("./admin-knowledge").HcrAboutJudges;

/** Stub judges that record their calls; each answer is configurable. */
function stubJudges(opts: {
  quality?: "GODKJENN" | "AVVIS" | "INFRA";
  facts?: "SUPPORTED" | "NOT_SUPPORTED" | "INFRA";
  comparison?: "BEDRE" | "IKKE_BEDRE" | "INFRA";
  timeoutMs?: number;
  qualityDelayMs?: number;
}): Judges & { calls: string[]; factsPages: Array<{ url: string; text: string }> } {
  const calls: string[] = [];
  const factsPages: Array<{ url: string; text: string }> = [];
  return {
    calls,
    factsPages,
    timeoutMs: opts.timeoutMs ?? 1,
    quality: async () => {
      calls.push("quality");
      if (opts.qualityDelayMs) await new Promise((r) => setTimeout(r, opts.qualityDelayMs));
      const q = opts.quality ?? "GODKJENN";
      if (q === "INFRA") return { approved: false, reasoning: "dommer-API svarte status 500 — avvist fail-closed" };
      return q === "GODKJENN"
        ? { approved: true, reasoning: "konkret om produsenten" }
        : { approved: false, reasoning: "generisk tekst" };
    },
    facts: async (params) => {
      calls.push("facts");
      factsPages.push(...params.pages);
      const f = opts.facts ?? "SUPPORTED";
      if (f === "INFRA") return { ok: false, failure: "timeout", reason: "judge_timeout — dommer-kall tidsavbrutt" };
      return f === "SUPPORTED"
        ? { ok: true, supported: true, unsupportedClaims: [], bestPage: 0, reason: "støttet" }
        : { ok: true, supported: false, unsupportedClaims: ["hele Norge"], bestPage: null, reason: "ikke på siden" };
    },
    comparison: async () => {
      calls.push("comparison");
      const c = opts.comparison ?? "BEDRE";
      if (c === "INFRA") return { ok: false, reasoning: "uventet/tvetydig dommersvar" };
      return c === "BEDRE"
        ? { ok: true, better: true, verdict: "BEDRE", reasoning: "mer konkret" }
        : { ok: true, better: false, verdict: "IKKE_BEDRE", reasoning: "mister fakta om ysting og Spesialitet-merket" };
    },
  };
}

function callRouteFactory(router: any, testKey: string) {
  return (body: any, query: Record<string, string> = {}): Promise<{ status: number; body: any }> =>
    new Promise((resolve) => {
      const headers: Record<string, string> = { "x-admin-key": testKey, "content-type": "application/json" };
      const req: any = {
        method: "POST",
        url: "/homepage-content-refresh",
        originalUrl: "/homepage-content-refresh",
        query,
        headers,
        body,
        ip: "127.0.0.1",
        get: (n: string) => headers[n.toLowerCase()],
      };
      const res: any = {
        statusCode: 200,
        status(c: number) {
          this.statusCode = c;
          return this;
        },
        json(p: any) {
          resolve({ status: this.statusCode, body: p });
          return this;
        },
      };
      router.handle(req, res, (err?: any) => resolve({ status: 500, body: { error: String(err ?? "unmatched") } }));
    });
}

export async function runHomepageContentRefreshAboutJudgesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = initMod.__peekDbForTesting();
  const prevFetch = (globalThis as any).fetch;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevParking = process.env.HOMEPAGE_PARKING_DISABLED;
  const prevLog = console.log;
  delete process.env.HOMEPAGE_PARKING_DISABLED;
  const testKey = process.env.ADMIN_KEY || "hcr-about-judges-test-key";
  process.env.ADMIN_KEY = testKey;

  const mod = require("./admin-knowledge") as typeof import("./admin-knowledge");
  const daily = require("../services/rfb-marketing-daily") as typeof import("../services/rfb-marketing-daily");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  initMod.__setDbForTesting(db as any);
  initMod.__initSchemaForTesting(db as any);

  const GP = (v: string) => ({ source_type: "google_places", value: v, fetched_at: "2026-01-01T00:00:00.000Z" });
  function seed(id: string, o: { about?: string | null; cats?: string[] | null; name?: string }): void {
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM agent_knowledge WHERE agent_id = ?`).run(id);
    const url = `https://${id}.judge-test.no`;
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
       VALUES (?, ?, ?, 'test', 'post@example.no', ?, 'producer', ?, ?)`,
    ).run(id, o.name ?? `Gård ${id}`, o.about ?? "", url, `key-${id}`, o.cats ? JSON.stringify(o.cats) : null);
    const prov: Record<string, unknown> = {};
    if (o.about) prov.about = [GP(o.about)];
    if (o.about) prov.description = [GP(o.about)];
    if (o.cats && o.cats.length > 0) prov.categories = [GP(o.cats.join(","))];
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, website, about, products, field_provenance, curated_fields, updated_at)
       VALUES (?, ?, ?, '[]', ?, '{}', '2020-01-01T00:00:00.000Z')`,
    ).run(id, url, o.about ?? null, JSON.stringify(prov));
  }
  const pages: Record<string, string> = {};
  const fetchedUrls: string[] = [];
  const pageFetch = (async (url: string) => {
    const u = new URL(url);
    fetchedUrls.push(u.host + u.pathname);
    if (u.pathname !== "/" && u.pathname !== "") return new Response("", { status: 404 });
    const html = pages[u.host];
    if (html === undefined) return new Response("", { status: 404 });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as unknown as typeof fetch;
  const target = (id: string) => ({ agent_id: id, name: `Gård ${id}`, homepage_url: `https://${id}.judge-test.no` });
  const aboutOf = (id: string) => (db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(id) as any)?.about ?? null;
  const descOf = (id: string) => (db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as any)?.description ?? null;
  const catsOf = (id: string) => {
    const c = (db.prepare(`SELECT categories FROM agents WHERE id = ?`).get(id) as any)?.categories;
    return c ? JSON.parse(c) : null;
  };
  const changedOf = (r: any, id: string): string[] => r.changed.find((c: any) => c.agent_id === id)?.fields ?? [];
  const reasonsOf = (r: any, id: string): string[] =>
    r.skipped_unsubstantiated.filter((s: any) => s.agent_id === id).map((s: any) => s.reason);
  const reviewOf = (r: any, id: string) => r.about_reviews.find((x: any) => x.agent_id === id)?.about_review ?? null;
  const counters = (r: any) => [r.about_judge_rejected, r.about_not_supported, r.about_not_better, r.about_judge_unavailable];
  const SJOVOLD_PAGE = pageHtml("Sjøvold", CANDIDATE_113, `${CANDIDATE_113} Ta kontakt for priser.`);

  async function refresh(id: string, judges: Judges, extra: Record<string, unknown> = {}) {
    return mod.refreshHomepageContent(db as any, [target(id)] as any, {
      dryRun: false,
      fetchImpl: pageFetch,
      aboutJudges: judges,
      ...extra,
    });
  }

  try {
    console.log = () => undefined; // the refresh logs every rejection
    assertEq([STORED_193.length, CANDIDATE_113.length], [193, 113], "fixture: stored 193 chars, candidate 113 chars");

    // ── J1: IKKE_BEDRE → nothing written ──────────────────────────────────
    {
      seed("j1", { about: STORED_193 });
      pages["j1.judge-test.no"] = SJOVOLD_PAGE;
      const j = stubJudges({ comparison: "IKKE_BEDRE" });
      const r = await refresh("j1", j);
      assertEq([aboutOf("j1"), descOf("j1")], [STORED_193, STORED_193], "J1: about and description left as stored");
      assertEq(
        [changedOf(r, "j1").includes("about"), changedOf(r, "j1").includes("description"), reasonsOf(r, "j1")],
        [false, false, [mod.HCR_ABOUT_REASON_NOT_BETTER]],
        "J1: not reported as written; reason «about: ikke bedre enn lagret»",
      );
      assertEq(mod.HCR_ABOUT_REASON_NOT_BETTER, "about: ikke bedre enn lagret", "J1: exact reason text");
      assertEq([j.calls, counters(r)], [["quality", "facts", "comparison"], [0, 0, 1, 0]], "J1: all three judges asked once; about_not_better = 1");
      assertEq(
        reviewOf(r, "j1"),
        {
          candidate: CANDIDATE_113,
          quality: { approved: true, reasoning: "konkret om produsenten" },
          facts: { supported: true, unsupported_claims: [] },
          comparison: { verdict: "IKKE_BEDRE", reasoning: "mister fakta om ysting og Spesialitet-merket" },
          decision: "skip",
        },
        "J1: about_review carries every verdict and decision skip",
      );
    }

    // ── J2: shorter candidate, all approve → written ─────────────────────
    {
      seed("j2", { about: STORED_193 });
      pages["j2.judge-test.no"] = SJOVOLD_PAGE;
      const j = stubJudges({});
      fetchedUrls.length = 0;
      const r = await refresh("j2", j);
      assertEq([aboutOf("j2"), descOf("j2")], [CANDIDATE_113, CANDIDATE_113], "J2: shorter candidate written to about and description (length is not the criterion)");
      assertEq(
        [changedOf(r, "j2").includes("about"), changedOf(r, "j2").includes("description"), reviewOf(r, "j2")?.decision, counters(r)],
        [true, true, "write", [0, 0, 0, 0]],
        "J2: reported as written; decision write; no counter",
      );
      assertEq(
        [
          j.factsPages.length >= 1,
          j.factsPages[0]?.url,
          j.factsPages[0]?.text.includes(CANDIDATE_113),
          j.factsPages[0]?.text.includes("<"),
          fetchedUrls.every((u) => u.startsWith("j2.judge-test.no")),
        ],
        [true, "https://j2.judge-test.no", true, false, true],
        "J2: facts judge gets the fetched homepage as plain text; no other fetch",
      );
      const prov = JSON.parse((db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = 'j2'`).get() as any).field_provenance);
      assertEq(
        (prov.about as any[]).some((s) => s.source_type === "website_homepage" && s.value === CANDIDATE_113),
        true,
        "J2: website_homepage provenance recorded as before",
      );
    }

    // ── J3: AVVIS / NOT_SUPPORTED → nothing written, no comparison ───────
    for (const [label, cfg, reason, expCalls, expCounters] of [
      ["quality AVVIS", { quality: "AVVIS" }, "about: kvalitetsdommer AVVIS", ["quality"], [1, 0, 0, 0]],
      ["facts NOT_SUPPORTED", { facts: "NOT_SUPPORTED" }, "about: ikke støttet av siden", ["quality", "facts"], [0, 1, 0, 0]],
    ] as const) {
      seed("j3", { about: STORED_193 });
      pages["j3.judge-test.no"] = SJOVOLD_PAGE;
      const j = stubJudges(cfg as any);
      const r = await refresh("j3", j);
      assertEq(
        [aboutOf("j3"), descOf("j3"), reasonsOf(r, "j3"), j.calls, counters(r), reviewOf(r, "j3")?.comparison, reviewOf(r, "j3")?.decision],
        [STORED_193, STORED_193, [reason], expCalls, expCounters, null, "skip"],
        `J3 ${label}: nothing written, comparison never called, exact reason`,
      );
    }
    {
      seed("j3", { about: STORED_193 });
      const r = await refresh("j3", stubJudges({ facts: "NOT_SUPPORTED" }));
      assertEq(reviewOf(r, "j3")?.facts, { supported: false, unsupported_claims: ["hele Norge"] }, "J3: unsupported claims in about_review.facts");
    }

    // ── J4: infra failures (REAL judges, stubbed Messages API) ───────────
    {
      // Route a Messages API call by its prompt: quality / facts / comparison.
      type Reply = { status: number; text?: string; hang?: boolean };
      let replies: { quality: Reply; facts: Reply; comparison: Reply } = {
        quality: { status: 200, text: "GODKJENN\nok" },
        facts: { status: 200, text: '{"verdict":"SUPPORTED","unsupported_claims":[],"best_page":1,"reason":"ok"}' },
        comparison: { status: 200, text: "BEDRE\nok" },
      };
      const apiCalls: string[] = [];
      (globalThis as any).fetch = async (url: string, init?: any) => {
        if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch ${url}`);
        const prompt = JSON.parse(init.body).messages[0].content as string;
        const kind = prompt.includes("faktasjekker") ? "facts" : prompt.includes("klart BEDRE") ? "comparison" : "quality";
        apiCalls.push(kind);
        const rep = replies[kind];
        if (rep.hang) {
          return new Promise((_res, rej) => {
            const sig: AbortSignal | undefined = init?.signal;
            if (sig?.aborted) return rej(sig.reason);
            sig?.addEventListener("abort", () => rej(sig.reason));
          });
        }
        if (rep.status !== 200) return new Response("err", { status: rep.status });
        return new Response(JSON.stringify({ content: [{ type: "text", text: rep.text }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const realJudges: Judges = { ...mod.HCR_DEFAULT_ABOUT_JUDGES, timeoutMs: 300 };
      const ok = { status: 200 };
      const cases: Array<[string, typeof replies, boolean, string[]]> = [
        ["missing key", replies, false, []],
        ["quality non-200", { ...replies, quality: { status: 500 } }, true, ["quality"]],
        ["quality ambiguous reply", { ...replies, quality: { ...ok, text: "KANSKJE\nusikker" } }, true, ["quality"]],
        ["quality timeout", { ...replies, quality: { status: 200, hang: true } }, true, ["quality"]],
        ["facts non-200", { ...replies, facts: { status: 529 } }, true, ["quality", "facts"]],
        ["facts ambiguous reply", { ...replies, facts: { ...ok, text: "jeg vet ikke" } }, true, ["quality", "facts"]],
        ["facts timeout", { ...replies, facts: { status: 200, hang: true } }, true, ["quality", "facts"]],
        ["comparison non-200", { ...replies, comparison: { status: 500 } }, true, ["quality", "facts", "comparison"]],
        ["comparison ambiguous reply", { ...replies, comparison: { ...ok, text: "LITT BEDRE\nkanskje" } }, true, ["quality", "facts", "comparison"]],
        ["comparison timeout", { ...replies, comparison: { status: 200, hang: true } }, true, ["quality", "facts", "comparison"]],
      ];
      const facts = require("../services/about-spot-check-judge") as typeof import("../services/about-spot-check-judge");
      for (const [label, rep, withKey, expCalls] of cases) {
        facts.__clearAboutJudgeCacheForTesting();
        replies = rep;
        apiCalls.length = 0;
        if (withKey) process.env.ANTHROPIC_API_KEY = "test-key-hcr-about-judges";
        else delete process.env.ANTHROPIC_API_KEY;
        seed("j4", { about: STORED_193 });
        pages["j4.judge-test.no"] = SJOVOLD_PAGE;
        const keepAlive = setTimeout(() => undefined, 5000);
        const r = await refresh("j4", realJudges);
        clearTimeout(keepAlive);
        assertEq(
          [aboutOf("j4"), descOf("j4"), reasonsOf(r, "j4"), counters(r), apiCalls, reviewOf(r, "j4")?.decision, typeof reviewOf(r, "j4")?.unavailable],
          [STORED_193, STORED_193, ["about: dommer utilgjengelig"], [0, 0, 0, 1], expCalls, "skip", "string"],
          `J4 ${label}: nothing written, about_judge_unavailable = 1`,
        );
      }
      // Sanity: the same real judges with every reply fine → written.
      facts.__clearAboutJudgeCacheForTesting();
      replies = {
        quality: { status: 200, text: "GODKJENN\nok" },
        facts: { status: 200, text: '{"verdict":"SUPPORTED","unsupported_claims":[],"best_page":1,"reason":"ok"}' },
        comparison: { status: 200, text: "BEDRE\nok" },
      };
      process.env.ANTHROPIC_API_KEY = "test-key-hcr-about-judges";
      seed("j4", { about: STORED_193 });
      const r = await refresh("j4", realJudges);
      assertEq([aboutOf("j4"), counters(r)], [CANDIDATE_113, [0, 0, 0, 0]], "J4 control: the real judges approving → written");
      // IKKE_BEDRE parsed by the real comparison judge: a real "no", not unavailable.
      replies = { ...replies, comparison: { status: 200, text: "IKKE_BEDRE\nmister fakta" } };
      seed("j4", { about: STORED_193 });
      const r2 = await refresh("j4", realJudges);
      assertEq([aboutOf("j4"), counters(r2), reasonsOf(r2, "j4")], [STORED_193, [0, 0, 1, 0], ["about: ikke bedre enn lagret"]], "J4: real comparison judge IKKE_BEDRE → not better (not unavailable)");
      (globalThis as any).fetch = prevFetch;
    }

    // ── J5: empty stored about → quality + facts, no comparison ──────────
    {
      seed("j5", { about: null });
      pages["j5.judge-test.no"] = SJOVOLD_PAGE;
      const j = stubJudges({ comparison: "IKKE_BEDRE" });
      const r = await refresh("j5", j);
      assertEq(
        [aboutOf("j5"), j.calls, reviewOf(r, "j5")?.comparison, reviewOf(r, "j5")?.decision],
        [CANDIDATE_113, ["quality", "facts"], null, "write"],
        "J5: empty stored about → written after quality + facts; comparison not called",
      );
    }

    // ── J6: candidate equal to stored → no judge, no write ───────────────
    {
      seed("j6", { about: `  ${CANDIDATE_113.toUpperCase()} ` });
      pages["j6.judge-test.no"] = SJOVOLD_PAGE;
      const j = stubJudges({});
      const r = await refresh("j6", j);
      assertEq(
        [j.calls, changedOf(r, "j6").includes("about"), changedOf(r, "j6").includes("description"), reviewOf(r, "j6"), aboutOf("j6")],
        [[], false, false, null, `  ${CANDIDATE_113.toUpperCase()} `],
        "J6: candidate equal to the stored text (whitespace/case) → no judge call, nothing written",
      );
    }

    // ── J7: deadline ─────────────────────────────────────────────────────
    {
      seed("j7", { about: STORED_193 });
      pages["j7.judge-test.no"] = SJOVOLD_PAGE;
      const before = JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = 'j7'`).get());
      const j = stubJudges({ timeoutMs: 60_000 });
      const r = await refresh("j7", j, { deadlineAt: Date.now() + 5_000 });
      assertEq(
        [
          j.calls,
          r.errors.map((e: any) => e.error.startsWith(mod.HCR_DEADLINE_EXCEEDED)),
          mod.homepageContentRefreshNotReached(r),
          counters(r),
          reviewOf(r, "j7")?.decision,
          JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = 'j7'`).get()) === before,
          r.parked_now,
        ],
        [[], [true], 1, [0, 0, 0, 0], "skip", true, []],
        "J7: less time left than the judge timeout → no judge started; transient (not reached), nothing written, no strike, no stamp",
      );
      // Enough time for the quality judge, not for the facts judge afterwards.
      seed("j7", { about: STORED_193 });
      const j2 = stubJudges({ timeoutMs: 1_000, qualityDelayMs: 700 });
      const keepAlive = setTimeout(() => undefined, 5000);
      const r2 = await refresh("j7", j2, { deadlineAt: Date.now() + 1_600 });
      clearTimeout(keepAlive);
      assertEq(
        [j2.calls, mod.homepageContentRefreshNotReached(r2), aboutOf("j7"), counters(r2)],
        [["quality"], 1, STORED_193, [0, 0, 0, 0]],
        "J7: the facts judge is not started once less than its timeout is left; profile transient, nothing written",
      );
      // Plenty of time: judges run as usual under a deadline.
      seed("j7", { about: STORED_193 });
      const r3 = await refresh("j7", stubJudges({ timeoutMs: 1_000 }), { deadlineAt: Date.now() + 30_000 });
      assertEq([aboutOf("j7"), mod.homepageContentRefreshNotReached(r3)], [CANDIDATE_113, 0], "J7: enough time → judged and written");
    }

    // ── J8: categories never replaced ────────────────────────────────────
    {
      seed("j8-coffee", { cats: ["coffee"] });
      pages["j8-coffee.judge-test.no"] = pageHtml("Ild og Bønner", null, "Ferske bønner fra Porsgrunn.");
      seed("j8-bakery", { cats: ["bakery", "cafe"] });
      pages["j8-bakery.judge-test.no"] = pageHtml("Bear House", null, "Bakeri med surdeigsbrød og boller.");
      seed("j8-empty", { cats: null });
      pages["j8-empty.judge-test.no"] = pageHtml("Tom Gård", null, "Bakeri med surdeigsbrød og boller.");
      const j = stubJudges({});
      const r = await mod.refreshHomepageContent(db as any, [target("j8-coffee"), target("j8-bakery"), target("j8-empty")] as any, {
        dryRun: false,
        fetchImpl: pageFetch,
        aboutJudges: j,
      });
      assertEq(catsOf("j8-coffee"), ["coffee"], "J8: stored [coffee] on a «bønner» page is not replaced");
      assertEq(catsOf("j8-bakery"), ["bakery", "cafe"], "J8: stored [bakery, cafe] is not turned into [bakery]");
      assertEq(
        [changedOf(r, "j8-coffee").includes("categories"), changedOf(r, "j8-bakery").includes("categories")],
        [false, false],
        "J8: no categories write reported for the non-empty stored lists",
      );
      assertEq(
        ["j8-coffee", "j8-bakery"].map((id) => reasonsOf(r, id).some((s) => s.startsWith(mod.HCR_CATEGORIES_NOT_SUPPORTED))),
        [true, true],
        "J8: the reason is in skipped_unsubstantiated (categories_not_supported_by_homepage)",
      );
      assertEq(
        [catsOf("j8-empty")?.includes("bakery"), changedOf(r, "j8-empty").includes("categories")],
        [true, true],
        "J8: empty stored categories are filled from the page as before",
      );
      // An already corroborated list is left exactly as stored.
      seed("j8-corr", { cats: ["fish"] });
      db.prepare(`UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = 'j8-corr'`).run(
        JSON.stringify({ categories: [{ source_type: "website_homepage", value: "fish", fetched_at: "2026-01-01T00:00:00.000Z", source_url: "https://j8-corr.judge-test.no" }] }),
      );
      pages["j8-corr.judge-test.no"] = pageHtml("Fisk", null, "Bakeri med surdeigsbrød og boller.");
      const rc = await refresh("j8-corr", j);
      assertEq([catsOf("j8-corr"), changedOf(rc, "j8-corr")], [["fish"], []], "J8: an already corroborated list is never replaced");
    }

    // ── J9: the route with explicit agentIds ─────────────────────────────
    {
      const callRoute = callRouteFactory(mod.homepageContentRefreshRouter as any, testKey);
      (globalThis as any).fetch = pageFetch;
      try {
        seed("j9-not", { about: STORED_193, cats: ["coffee"] });
        pages["j9-not.judge-test.no"] = pageHtml("Sjøvold", CANDIDATE_113, `${CANDIDATE_113} Ferske bønner.`);
        seed("j9-yes", { about: STORED_193 });
        pages["j9-yes.judge-test.no"] = SJOVOLD_PAGE;
        // The route cannot take judges: the global test override.
        const notBetterFor = new Set(["Gård j9-not"]);
        const routeJudges: Judges = {
          ...stubJudges({}),
          comparison: async (p) =>
            notBetterFor.has(p.producerName)
              ? { ok: true, better: false, verdict: "IKKE_BEDRE", reasoning: "mindre konkret" }
              : { ok: true, better: true, verdict: "BEDRE", reasoning: "mer konkret" },
        };
        mod.__setHcrAboutJudgesForTesting(routeJudges);
        const dry = await callRoute({ agentIds: ["j9-not", "j9-yes"] });
        assertEq(
          [
            dry.status,
            dry.body.dry_run,
            aboutOf("j9-yes"),
            changedOf(dry.body, "j9-yes").includes("about"),
            changedOf(dry.body, "j9-not").includes("about"),
            reasonsOf(dry.body, "j9-not").includes("about: ikke bedre enn lagret"),
            dry.body.about_not_better,
            dry.body.about_reviews.map((x: any) => [x.agent_id, x.about_review.decision]).sort(),
          ],
          [200, true, STORED_193, true, false, true, 1, [["j9-not", "skip"], ["j9-yes", "write"]]],
          "J9 route dry run (explicit agentIds): about_review per profile, would write only the approved one, counters in the answer",
        );
        const applied = await callRoute({ agentIds: ["j9-not", "j9-yes"], apply: true });
        assertEq(
          [applied.status, aboutOf("j9-not"), aboutOf("j9-yes"), catsOf("j9-not"), changedOf(applied.body, "j9-not").includes("categories")],
          [200, STORED_193, CANDIDATE_113, ["coffee"], false],
          "J9 route apply (explicit agentIds): IKKE_BEDRE not written, BEDRE written, stored [coffee] not replaced",
        );
        assertEq(
          [
            applied.body.categories_corroboration,
            ["about_judge_rejected", "about_not_supported", "about_not_better", "about_judge_unavailable"].map((k) => typeof applied.body[k]),
          ],
          [{ corroborated: 0, categories_not_supported_by_homepage: 1 }, ["number", "number", "number", "number"]],
          "J9 route: categories_corroboration shown for explicit agentIds; the four counters are numbers",
        );
      } finally {
        mod.__setHcrAboutJudgesForTesting(null);
        (globalThis as any).fetch = prevFetch;
      }
    }

    // ── J10: the morning send (refreshRfbCandidateHomepage) ──────────────
    {
      seed("j10-not", { about: STORED_193, cats: ["bakery", "cafe"] });
      pages["j10-not.judge-test.no"] = pageHtml("Bear House", CANDIDATE_113, `${CANDIDATE_113} Bakeri med surdeigsbrød.`);
      seed("j10-yes", { about: STORED_193 });
      pages["j10-yes.judge-test.no"] = SJOVOLD_PAGE;
      try {
        mod.__setHcrAboutJudgesForTesting(stubJudges({ comparison: "IKKE_BEDRE" }));
        const not = await daily.refreshRfbCandidateHomepage(db as any, "j10-not", { deadlineAt: Date.now() + 20_000, fetchImpl: pageFetch });
        assertEq(
          [not.outcome, aboutOf("j10-not"), catsOf("j10-not"), not.categories_corroboration, (not.fields ?? []).includes("about")],
          ["unchanged", STORED_193, ["bakery", "cafe"], "categories_not_supported_by_homepage", false],
          "J10 morning send: IKKE_BEDRE → about not written; [bakery, cafe] not replaced",
        );
        mod.__setHcrAboutJudgesForTesting(stubJudges({}));
        const yes = await daily.refreshRfbCandidateHomepage(db as any, "j10-yes", { deadlineAt: Date.now() + 20_000, fetchImpl: pageFetch });
        assertEq(
          [yes.outcome, aboutOf("j10-yes"), descOf("j10-yes"), (yes.fields ?? []).includes("about")],
          ["refreshed", CANDIDATE_113, CANDIDATE_113, true],
          "J10 morning send: all judges approve → about and description written",
        );
        seed("j10-q", { about: STORED_193 });
        pages["j10-q.judge-test.no"] = SJOVOLD_PAGE;
        mod.__setHcrAboutJudgesForTesting(stubJudges({ quality: "INFRA" }));
        const q = await daily.refreshRfbCandidateHomepage(db as any, "j10-q", { deadlineAt: Date.now() + 20_000, fetchImpl: pageFetch });
        assertEq(
          [q.outcome, q.rejected, aboutOf("j10-q")],
          ["unchanged", "about: dommer utilgjengelig", STORED_193],
          "J10 morning send: judge unavailable → nothing written, reason reported",
        );
      } finally {
        mod.__setHcrAboutJudgesForTesting(null);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack ?? err}`);
  } finally {
    console.log = prevLog;
    (globalThis as any).fetch = prevFetch;
    mod.__setHcrAboutJudgesForTesting(null);
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("ADMIN_KEY", prevAdminKey);
    restore("ANTHROPIC_API_KEY", prevAnthropic);
    restore("HOMEPAGE_PARKING_DISABLED", prevParking);
    initMod.__setDbForTesting(prevDb as any);
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runHomepageContentRefreshAboutJudgesTests({ log: true }).then((r) => {
    console.log(`\nhomepage-content-refresh-about-judges: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

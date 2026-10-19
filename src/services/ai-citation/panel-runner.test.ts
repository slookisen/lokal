/**
 * panel-runner.test.ts — A2A dev-request 2026-10-16-siteringspanel, S5a (questions, own domains,
 * store, run, admin read) and the caps of S5b.
 *
 * No network: the run is driven with fake engines (same CitationEngine shape as engines.ts) on
 * in-memory SQLite. Covers the shipped question config and its validation, domain matching
 * (www., subdomains, look-alikes), the ISO weeks, the caps from the environment, the run
 * (Anthropic first per question; each (week, engine, question) asked once; the run cap stopping
 * mid-run with the rest stored as skipped_cost_cap; the month cap blocking a new run and stopping
 * one mid-run; a pause that leaves the rest for a later run; errors stored and not retried; an
 * engine whose key arrives mid-week), the week view (cost_usd_total, share per engine and last
 * week's, top domains per engine and vertical, one result per question and engine) and that
 * init.ts creates the same table.
 */
import Database from "better-sqlite3";
import { BRAND_ENTITIES } from "../../config/brand-entities";
import {
  AI_CITATION_OWN_DOMAINS,
  AI_CITATION_RESULTS_DDL,
  AI_CITATION_VERTICALS,
  CITATION_PROMPT_MAX_CHARS,
  aiCitationMonthCostUsd,
  aiCitationWeekOf,
  aiCitationWeekTotals,
  ensureAiCitationResultsTable,
  getAiCitationWeekView,
  isoWeekStart,
  loadCitationPrompts,
  ownBrandOfHost,
  ownBrandsCited,
  parseAiCitationWeek,
  resolveAiCitationCaps,
  runCitationPanel,
  type CitationPrompt,
} from "./panel-runner";
import type { CitationEngine, CitationEngineId, CitationRunResult } from "./engines";

export interface TestSummary { passed: number; failed: number; failures: string[] }

// Tuesday 2026-10-20 12:00Z: ISO week 2026-W43 (Mon 19 – Sun 25 October).
const NOW = new Date("2026-10-20T12:00:00.000Z");
const WEEK = "2026-W43";
const PROMPTS: CitationPrompt[] = [
  { id: "p1", vertical: "rfb", prompt: "Gårdsutsalg nær Lillehammer" },
  { id: "p2", vertical: "experiences", prompt: "Hvalsafari Vesterålen pris" },
  { id: "p3", vertical: "dental", prompt: "Tannlege i Bodø" },
];
const CAPS = { perRunUsd: 8, perMonthUsd: 30 };

interface FakeEngine extends CitationEngine { calls: string[] }

/** A CitationEngine whose run() answers with `behave` and records each question in `log` too. */
function fakeEngine(
  engine: CitationEngineId,
  behave: (prompt: string) => CitationRunResult,
  opts: { maxCostUsdPerCall?: number; log?: string[]; enabled?: boolean } = {},
): FakeEngine {
  const calls: string[] = [];
  return {
    engine,
    keyEnv: `${engine.toUpperCase()}_API_KEY`,
    model: `${engine}-test`,
    maxCostUsdPerCall: opts.maxCostUsdPerCall ?? 0.1,
    enabled: () => opts.enabled ?? true,
    calls,
    run: async (prompt) => {
      calls.push(prompt);
      opts.log?.push(`${engine}:${prompt}`);
      return behave(prompt);
    },
  };
}

const answer = (urls: string[], costUsd = 0.05, extra: { citedDomains?: string[] } = {}): CitationRunResult =>
  ({ ok: true, citedUrls: urls, answerSnippet: "Et kort svar.", costUsd, ...extra });

/** Insert a stored result directly (seeding earlier weeks / months). */
function seed(db: Database.Database, r: { week: string; engine: string; promptId: string; costUsd: number; createdAt: string; status?: string; hit?: boolean; domains?: string[]; vertical?: string }) {
  ensureAiCitationResultsTable(db);
  db.prepare(
    `INSERT INTO ai_citation_results (week, engine, prompt_id, vertical, status, reason, cited_urls, cited_domains, hit_self, answer_snippet, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, '[]', ?, ?, NULL, ?, ?)`,
  ).run(r.week, r.engine, r.promptId, r.vertical ?? "rfb", r.status ?? "ok", JSON.stringify(r.domains ?? []), r.hit ? 1 : 0, r.costUsd, r.createdAt);
}

const rowsOf = (db: Database.Database, week = WEEK) =>
  db.prepare("SELECT * FROM ai_citation_results WHERE week = ? ORDER BY rowid").all(week) as any[];

export async function runPanelRunnerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const t = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };
  const dbs: Database.Database[] = [];
  const newDb = () => { const d = new Database(":memory:"); dbs.push(d); return d; };
  const now = () => NOW;

  try {
    // ── the shipped questions ──
    {
      const prompts = loadCitationPrompts();
      const per = (v: string) => prompts.filter((p) => p.vertical === v).length;
      t(prompts.length >= 45 && prompts.length <= 55 && new Set(prompts.map((p) => p.id)).size === prompts.length,
        `CF1: config/ai-citation-panel.json has ~50 questions with unique ids (${prompts.length})`);
      t(AI_CITATION_VERTICALS.every((v) => per(v) >= 12), "CF2: every vertical (rfb, experiences, dental) has its own questions");
      t(prompts.every((p) => p.prompt.length > 0 && Array.from(p.prompt).length <= CITATION_PROMPT_MAX_CHARS && !/@|\b\d{8}\b|https?:/.test(p.prompt)),
        "CF3: every question is short and general (no e-mail, phone number or URL)");
      t(["Beste tannlege i Bergen med Helfo-avtale", "Gårdsutsalg nær Lillehammer", "Hvalsafari Vesterålen pris"].every((q) => prompts.some((p) => p.prompt === q)),
        "CF4: the spec's examples are in the panel");
    }
    {
      const bad = (raw: unknown) => { try { loadCitationPrompts(raw); return ""; } catch (e: any) { return String(e?.message); } };
      t(bad({}) !== "" && bad({ prompts: [] }) !== "" && bad(null) !== "", "CF5: a config without questions is rejected");
      const msg = bad({ prompts: [
        { id: "ok-1", vertical: "rfb", prompt: "Hemmelig spørsmål" },
        { id: "ok-1", vertical: "rfb", prompt: "b" },
        { id: "Bad Id", vertical: "dental", prompt: "c" },
        { id: "v-1", vertical: "company", prompt: "d" },
        { id: "e-1", vertical: "experiences", prompt: "   " },
        { id: "l-1", vertical: "experiences", prompt: "x".repeat(CITATION_PROMPT_MAX_CHARS + 1) },
      ] });
      t(/ok-1: duplicate id/.test(msg) && /Bad Id: id/.test(msg) && /v-1: vertical/.test(msg) && /e-1: prompt/.test(msg) && /l-1: prompt/.test(msg) && !msg.includes("Hemmelig"),
        "CF6: every problem is listed by id (duplicate, id, vertical, empty / too long prompt), never the question text");
    }

    // ── our domains (AC5) ──
    t(AI_CITATION_OWN_DOMAINS.map((d) => d.domain).join(",") === "rettfrabonden.com,opplevagent.no,finn-tannlege.com" &&
      AI_CITATION_OWN_DOMAINS.every((d) => BRAND_ENTITIES[d.brand].url === `https://${d.domain}`),
      "DM1: our three domains come from brand-entities.ts");
    t(ownBrandOfHost("https://www.rettfrabonden.com/produsent/lia-gard") === "rfb" && ownBrandOfHost("rettfrabonden.com") === "rfb" &&
      ownBrandOfHost("https://WWW.Opplevagent.NO/opplevelse/x") === "experiences" && ownBrandOfHost("https://finn-tannlege.com./tannlege/bodo") === "dental" &&
      ownBrandOfHost("http://user@www.finn-tannlege.com:8443/x") === "dental",
      "DM2 (AC5): the domain itself and www., in any case, with a trailing dot, port or user info");
    t(ownBrandOfHost("https://api.rettfrabonden.com/x") === "rfb" && ownBrandOfHost("https://m.opplevagent.no/") === "experiences" &&
      ownBrandOfHost("https://a.b.finn-tannlege.com/") === "dental",
      "DM3 (AC5): subdomains count as ours");
    t(["https://notrettfrabonden.com/", "https://rettfrabonden.com.example.no/", "https://opplevagent.no.evil.com/x", "https://finn-tannlege.co/",
      "https://finn.no/tannlege", "https://rettfrabonden.no/", BRAND_ENTITIES.company.url, "", "not a url"].every((u) => ownBrandOfHost(u) === null),
      "DM4 (AC5): look-alikes, other TLDs, the company site and junk are not ours");
    t(JSON.stringify(ownBrandsCited(["https://finn-tannlege.com/a", "https://x.no/", "https://www.rettfrabonden.com/b", "https://finn-tannlege.com/c"], ["opplevagent.no"])) ===
      JSON.stringify(["rfb", "experiences", "dental"]),
      "DM5: our brands cited by an answer, each once, in brand order (URLs and named domains)");

    // ── weeks ──
    t(aiCitationWeekOf(NOW) === WEEK && isoWeekStart(WEEK) === "2026-10-19" && aiCitationWeekOf(new Date("2026-10-25T23:59:59Z")) === WEEK &&
      aiCitationWeekOf(new Date("2026-10-26T00:00:00Z")) === "2026-W44",
      "W1: a run belongs to the ISO week (UTC) it runs in, Monday to Sunday");
    t(isoWeekStart("2026-W53") === "2026-12-28" && isoWeekStart("2027-W53") === null && isoWeekStart("2026-W00") === null &&
      isoWeekStart("2026-W1") === null && isoWeekStart("2027-W01") === "2027-01-04",
      "W2: ISO week -> Monday; W53 only in long years");
    t(parseAiCitationWeek("2026-W43") === WEEK && parseAiCitationWeek("2026-10-25") === WEEK && parseAiCitationWeek("2026-10-26") === "2026-W44" &&
      [ "2026-W54", "abc", "2026-13-01", "", "2026-10-20T00:00:00Z"].every((w) => parseAiCitationWeek(w) === null),
      "W3: ?week= takes an ISO week or a day of it, nothing else");

    // ── caps from the environment ──
    {
      const d = resolveAiCitationCaps({});
      const set = resolveAiCitationCaps({ AI_CITATION_MAX_USD_PER_RUN: " 2.5 ", AI_CITATION_MAX_USD_PER_MONTH: "12" });
      const junk = resolveAiCitationCaps({ AI_CITATION_MAX_USD_PER_RUN: "-1", AI_CITATION_MAX_USD_PER_MONTH: "lots" });
      const zero = resolveAiCitationCaps({ AI_CITATION_MAX_USD_PER_RUN: "0" });
      t(d.perRunUsd === 8 && d.perMonthUsd === 30 && set.perRunUsd === 2.5 && set.perMonthUsd === 12 &&
        junk.perRunUsd === 8 && junk.perMonthUsd === 30 && zero.perRunUsd === 0,
        "CAP1: AI_CITATION_MAX_USD_PER_RUN / _PER_MONTH default to 8 / 30; junk or negative -> the default");
    }

    // ── a run, and the same week again (AC5: never twice) ──
    {
      const db = newDb();
      const order: string[] = [];
      const a = fakeEngine("anthropic", (p) => answer(p.startsWith("Gårds") ? ["https://www.rettfrabonden.com/produsent/x", "https://visitnorway.no/a", "https://m.visitnorway.no/b"] : ["https://legelisten.no/x"], 0.04), { log: order });
      const o = fakeEngine("openai", () => answer(["https://api.finn-tannlege.com/x"], 0.06), { log: order });
      const s = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: CAPS, now });
      const rows = rowsOf(db);
      t(s.calls === 6 && s.ok === 6 && rows.length === 6 && s.stopped === null && s.pending === 0 &&
        order.join("|") === "anthropic:Gårdsutsalg nær Lillehammer|openai:Gårdsutsalg nær Lillehammer|anthropic:Hvalsafari Vesterålen pris|openai:Hvalsafari Vesterålen pris|anthropic:Tannlege i Bodø|openai:Tannlege i Bodø",
        "R1: every question is asked of every engine, question by question, Anthropic first");
      const r1 = rows.find((r) => r.engine === "anthropic" && r.prompt_id === "p1");
      t(!!r1 && r1.status === "ok" && r1.hit_self === 1 && r1.vertical === "rfb" && r1.answer_snippet === "Et kort svar." && r1.created_at === NOW.toISOString() &&
        r1.cited_domains === JSON.stringify(["rettfrabonden.com", "visitnorway.no"]) && JSON.parse(r1.cited_urls).length === 3,
        "R2: a stored answer has the URLs, distinct registrable domains, hit_self, vertical, snippet and time");
      t(rows.filter((r) => r.engine === "openai").every((r) => r.hit_self === 1) && rows.filter((r) => r.engine === "anthropic" && r.prompt_id !== "p1").every((r) => r.hit_self === 0),
        "R3: hit_self is set exactly when one of our domains (here a subdomain) is cited");
      t(Math.abs(s.costUsd - 0.3) < 1e-9 && Math.abs(s.weekCostUsd - 0.3) < 1e-9 && Math.abs(aiCitationWeekTotals(db, WEEK).costUsd - 0.3) < 1e-9,
        "R4: the run's cost is summed and stored");
      const again = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: CAPS, now });
      t(again.calls === 0 && a.calls.length === 3 && o.calls.length === 3 && rowsOf(db).length === 6 && again.stopped === null && again.pending === 0,
        "R5 (AC5): the same week again asks nothing and stores nothing");
      const next = await runCitationPanel({ db, week: "2026-W44", prompts: PROMPTS, engines: [a, o], caps: CAPS, now: () => new Date("2026-10-27T12:00:00Z") });
      t(next.calls === 6 && rowsOf(db, "2026-W44").length === 6, "R6: the next week is asked again");
    }

    // ── the run cap stops mid-run (AC5) ──
    {
      const db = newDb();
      const a = fakeEngine("anthropic", () => answer(["https://a.no/"], 0.1), { maxCostUsdPerCall: 0.1 });
      const o = fakeEngine("openai", () => answer(["https://b.no/"], 0.1), { maxCostUsdPerCall: 0.1 });
      const s = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: { perRunUsd: 0.35, perMonthUsd: 30 }, now });
      const rows = rowsOf(db);
      const skipped = rows.filter((r) => r.status === "skipped_cost_cap");
      t(s.calls === 3 && a.calls.length + o.calls.length === 3 && s.stopped === "run_cap" && s.skippedCostCap === 3 && s.pending === 0,
        "CC1 (AC5): the run stops when the next call would pass the cap");
      t(rows.length === 6 && skipped.length === 3 && skipped.every((r) => r.reason === "run_cap" && r.cost_usd === 0 && r.cited_urls === "[]") &&
        skipped.map((r) => `${r.engine}:${r.prompt_id}`).join(",") === "openai:p2,anthropic:p3,openai:p3",
        "CC2: every remaining question is stored as skipped_cost_cap (run_cap)");
      t(aiCitationWeekTotals(db, WEEK).costUsd <= 0.35 + 1e-9, "CC3 (AC4): the week's cost stays ≤ the cap");
      const again = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: { perRunUsd: 100, perMonthUsd: 100 }, now });
      t(again.calls === 0, "CC4: skipped questions are not asked later the same week, even with a higher cap");
    }
    {
      // Each call costs exactly its bound: the run still never passes the cap.
      const db = newDb();
      const a = fakeEngine("anthropic", () => answer([], 0.12), { maxCostUsdPerCall: 0.12 });
      await runCitationPanel({ db, week: WEEK, prompts: [...PROMPTS, ...PROMPTS.map((p) => ({ ...p, id: `${p.id}b` }))], engines: [a], caps: { perRunUsd: 0.5, perMonthUsd: 30 }, now });
      t(a.calls.length === 4 && aiCitationWeekTotals(db, WEEK).costUsd <= 0.5, "CC5: with every call at its bound, 4 × 0.12 fit under 0.50 and the 5th is skipped");
      const zero = newDb();
      const z = fakeEngine("anthropic", () => answer([], 0.01));
      const zs = await runCitationPanel({ db: zero, week: WEEK, prompts: PROMPTS, engines: [z], caps: { perRunUsd: 0, perMonthUsd: 30 }, now });
      t(z.calls.length === 0 && zs.skippedCostCap === 3 && zs.stopped === "run_cap", "CC6: a run cap of 0 asks nothing");
    }

    // ── the month cap ──
    {
      const db = newDb();
      seed(db, { week: "2026-W41", engine: "anthropic", promptId: "old", costUsd: 30, createdAt: "2026-10-06T10:00:00.000Z" });
      const a = fakeEngine("anthropic", () => answer([], 0.01));
      const s = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a], caps: CAPS, now });
      t(a.calls.length === 0 && rowsOf(db).length === 0 && s.stopped === "month_cap" && s.pending === 3 && Math.abs(s.monthCostUsd - 30) < 1e-9,
        "MC1: a month that has reached its cap starts no run: nothing asked, nothing stored");
      const nov = await runCitationPanel({ db, week: "2026-W45", prompts: PROMPTS, engines: [a], caps: CAPS, now: () => new Date("2026-11-03T12:00:00Z") });
      t(nov.calls === 3 && Math.abs(nov.monthCostUsd - 0.03) < 1e-9, "MC2: the next month starts from 0 (UTC calendar month)");
      t(Math.abs(aiCitationMonthCostUsd(db, NOW) - 30) < 1e-9 && Math.abs(aiCitationMonthCostUsd(db, new Date("2026-11-30T23:59:59Z")) - 0.03) < 1e-9,
        "MC3: month cost sums the results created in that month");
    }
    {
      const db = newDb();
      seed(db, { week: "2026-W42", engine: "anthropic", promptId: "old", costUsd: 29.85, createdAt: "2026-10-13T10:00:00.000Z" });
      const a = fakeEngine("anthropic", () => answer([], 0.1), { maxCostUsdPerCall: 0.1 });
      const s = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a], caps: CAPS, now });
      const skipped = rowsOf(db).filter((r) => r.status === "skipped_cost_cap");
      t(a.calls.length === 1 && s.stopped === "month_cap" && skipped.length === 2 && skipped.every((r) => r.reason === "month_cap") &&
        aiCitationMonthCostUsd(db, NOW) <= 30 + 1e-9,
        "MC4 (AC4): the month cap stops a run mid-way too; the month stays ≤ 30");
    }

    // ── a pause leaves the rest for a later run ──
    {
      const db = newDb();
      const a = fakeEngine("anthropic", () => answer([], 0.01));
      const o = fakeEngine("openai", () => answer([], 0.01));
      let checks = 0;
      const s = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: CAPS, now, shouldPause: () => (++checks > 2 ? "blocked_window" : null) });
      t(s.calls === 2 && s.stopped === "blocked_window" && s.pending === 4 && rowsOf(db).length === 2 && s.skippedCostCap === 0,
        "PA1: a pause stops before the next call and stores nothing for the rest");
      const resumed = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: CAPS, now });
      t(resumed.calls === 4 && a.calls.length === 3 && o.calls.length === 3 && rowsOf(db).length === 6 && resumed.pending === 0,
        "PA2: the next run asks only what is missing; no question twice");
    }

    // ── errors are stored, booked and not retried ──
    {
      const db = newDb();
      const a = fakeEngine("anthropic", (p) => (p.startsWith("Hval") ? { ok: false, reason: "timeout", costUsd: 0.12 } : answer(["https://a.no/"], 0.02)));
      const s = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a], caps: CAPS, now });
      const err = rowsOf(db).find((r) => r.prompt_id === "p2");
      t(s.errors === 1 && s.ok === 2 && !!err && err.status === "error" && err.reason === "timeout" && err.cost_usd === 0.12 && err.cited_urls === "[]" && err.answer_snippet === null,
        "ER1: an error is stored with its code and its booked cost");
      const again = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a], caps: CAPS, now });
      t(again.calls === 0 && a.calls.length === 3, "ER2: an error is not retried in the same week (it may have been billed)");
      const neg = newDb();
      const n = fakeEngine("anthropic", () => answer([], Number.NaN));
      const ns = await runCitationPanel({ db: neg, week: WEEK, prompts: PROMPTS.slice(0, 1), engines: [n], caps: CAPS, now });
      t(ns.costUsd === 0 && rowsOf(neg)[0].cost_usd === 0, "ER3: a cost that is not a finite positive number is stored as 0");
    }

    // ── Gemini-style named domains; an engine whose key arrives mid-week ──
    {
      const db = newDb();
      const a = fakeEngine("anthropic", () => answer(["https://a.no/"], 0.01));
      const g = fakeEngine("gemini", () => answer(["https://vertexaisearch.cloud.google.com/grounding-api-redirect/1"], 0.01, { citedDomains: ["finn-tannlege.com", "legelisten.no"] }));
      await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a], caps: CAPS, now });
      const later = await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, g], caps: CAPS, now });
      const gr = rowsOf(db).filter((r) => r.engine === "gemini");
      t(later.calls === 3 && a.calls.length === 3 && g.calls.length === 3, "KM1: an engine whose key arrives mid-week is asked that week; the others are not asked again");
      t(gr.length === 3 && gr.every((r) => r.hit_self === 1 && r.cited_domains === JSON.stringify(["finn-tannlege.com", "legelisten.no"])),
        "KM2: an engine's named domains (Gemini's redirect links) are the cited domains and decide hit_self");
    }

    // ── the week view (AC4) ──
    {
      const db = newDb();
      // Last week: anthropic 1 hit of 2 answers.
      seed(db, { week: "2026-W42", engine: "anthropic", promptId: "p1", costUsd: 0.02, createdAt: "2026-10-13T10:00:00.000Z", hit: true, domains: ["rettfrabonden.com"] });
      seed(db, { week: "2026-W42", engine: "anthropic", promptId: "p2", costUsd: 0.02, createdAt: "2026-10-13T10:00:00.000Z", domains: ["visitnorway.no"], vertical: "experiences" });
      const a = fakeEngine("anthropic", (p) => answer(
        p.startsWith("Gårds") ? ["https://www.rettfrabonden.com/x", "https://visitnorway.no/a"] : p.startsWith("Hval") ? ["https://visitnorway.no/b", "https://hvalsafari.no/"] : ["https://www.finn-tannlege.com/t", "https://legelisten.no/a"],
        0.03));
      const o = fakeEngine("openai", (p) => (p.startsWith("Tann") ? { ok: false, reason: "http_429", costUsd: 0 } : answer(["https://visitnorway.no/c"], 0.05)));
      await runCitationPanel({ db, week: WEEK, prompts: PROMPTS, engines: [a, o], caps: CAPS, now });
      const env = { ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv;
      const engines = [a, { ...o, enabled: () => false }];
      const v = getAiCitationWeekView({ db, week: WEEK, now: NOW, env, engines, prompts: PROMPTS });
      const va = v.engines.find((e) => e.engine === "anthropic")!;
      const vo = v.engines.find((e) => e.engine === "openai")!;
      t(v.week === WEEK && v.week_start === "2026-10-19" && v.week_end === "2026-10-25" && v.previous_week === "2026-W42" && v.current_week === WEEK,
        "V1: the week, its Monday–Sunday and the previous week");
      t(Math.abs(v.cost_usd_total - 0.19) < 1e-9 && v.cost_cap_usd_per_run === 8 && v.cost_usd_total <= v.cost_cap_usd_per_run,
        "V2 (AC4): cost_usd_total is the week's stored cost, shown with the per-run cap");
      t(va.prompts === 3 && va.hits === 2 && va.share === 0.6667 && va.previous_share === 0.5 && va.share_change === 0.1667 && va.active === true && va.errors === 0 &&
        Math.abs(va.cost_usd - 0.09) < 1e-9,
        "V3: per engine: answered questions, hits on us, the share, last week's share and the change");
      t(JSON.stringify(va.top_domains) === JSON.stringify([
        { domain: "visitnorway.no", answers: 2 }, { domain: "finn-tannlege.com", answers: 1 }, { domain: "hvalsafari.no", answers: 1 },
        { domain: "legelisten.no", answers: 1 }, { domain: "rettfrabonden.com", answers: 1 },
      ]), "V4 (AC1): the top-5 cited domains per engine, by answers then name");
      t(vo.active === false && vo.prompts === 2 && vo.errors === 1 && vo.hits === 0 && vo.share === 0 && vo.previous_share === null && vo.share_change === null,
        "V5: an engine without a key shows active false; errors are counted apart from answers");
      const vexp = v.verticals.find((x) => x.vertical === "experiences")!;
      t(v.verticals.map((x) => x.vertical).join(",") === "rfb,experiences,dental" && vexp.prompts === 1 && vexp.answers === 2 &&
        vexp.top_domains[0].domain === "visitnorway.no" && vexp.top_domains[0].answers === 2 && vexp.hits_by_engine.anthropic === 0 &&
        v.verticals.find((x) => x.vertical === "dental")!.hits_by_engine.anthropic === 1,
        "V6: per vertical: the top cited domains (competitor picture) and our hits per engine");
      const res = v.results.find((r) => r.engine === "anthropic" && r.prompt_id === "p3")!;
      t(v.results.length === 6 && res.prompt === "Tannlege i Bodø" && res.vertical === "dental" && res.hit_self === true &&
        JSON.stringify(res.own_brands) === JSON.stringify(["dental"]) && JSON.stringify(res.cited_domains) === JSON.stringify(["finn-tannlege.com", "legelisten.no"]) &&
        res.cited_urls.length === 2 && res.status === "ok" && v.results.some((r) => r.status === "error" && r.reason === "http_429"),
        "V7 (AC2): one result per question and engine, with the question, URLs, domains, our brands and status");
      t(JSON.stringify(v.stored_weeks) === JSON.stringify([WEEK, "2026-W42"]), "V8: stored weeks, newest first");
      const def = getAiCitationWeekView({ db, now: new Date("2026-10-27T00:00:00Z"), env, engines, prompts: PROMPTS });
      t(def.week === "2026-W44" && def.results.length === 0 && def.cost_usd_total === 0 && def.engines.every((e) => e.share === null),
        "V9: no week -> the current week; an empty week has no share");
    }

    // ── init.ts creates the same table ──
    {
      const initMod = require("../../database/init") as typeof import("../../database/init");
      const viaInit = newDb();
      initMod.__initSchemaForTesting(viaInit);
      const viaModule = newDb();
      viaModule.exec(AI_CITATION_RESULTS_DDL);
      const shape = (d: Database.Database) => JSON.stringify({
        cols: d.prepare("PRAGMA table_info(ai_citation_results)").all(),
        idx: (d.prepare("PRAGMA index_list(ai_citation_results)").all() as any[]).map((i) => ({
          unique: i.unique, cols: (d.prepare(`PRAGMA index_info('${i.name}')`).all() as any[]).map((c) => c.name),
        })),
      });
      t(shape(viaInit) === shape(viaModule) && shape(viaInit).includes('"prompt_id"') && shape(viaInit).includes('"unique":1'),
        "DB1: init.ts and the module create the same table and unique (week, engine, prompt_id)");
    }
  } catch (err: any) {
    failed++;
    failures.push("panel-runner: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runPanelRunnerTests({ log: true }).then((r) => {
    console.log(`\nai-citation panel-runner: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

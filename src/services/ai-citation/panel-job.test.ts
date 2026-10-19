/**
 * panel-job.test.ts — A2A dev-request 2026-10-16-siteringspanel, S5b (the weekly job behind
 * AI_CITATION_PANEL_ENABLED) and the two admin GETs of S5a/S5b.
 *
 * No network: the real engine adapters run against a fetch stub that answers as each provider
 * (fixtures from engines.test.ts) and fails on anything else; the keys are fakes. Covers the flag
 * (off = no timer, no call, no DB), the blocked windows (00–01Z, 06:30–09:30Z, also mid-run), an
 * engine without its key or with an unpriced model override (skipped, one log line), a full panel
 * (50 questions × 4 engines) and the same week again (no call), the run cap with the real adapters
 * and with the per-call bound from the config, no overlapping runs, the
 * scheduler (15 min after boot, hourly, behind the exclusive boot gate without holding it, a
 * failed run logged without keys), the status (models and prices, month_cost_usd ≤ 30), GET
 * /admin/analytics/ai-citations[/status] (auth, 200 with cost_usd_total, 400 on a bad week), the
 * wiring in src/index.ts, and that no key reaches a log line, an error, the DB or a response.
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  AI_CITATION_BLOCKED_WINDOWS_UTC,
  AI_CITATION_PANEL_TICK_INTERVAL_MS,
  __resetAiCitationPanelForTesting,
  aiCitationBlockedWindowAt,
  getAiCitationPanelStatus,
  isAiCitationPanelEnabled,
  runAiCitationPanelTick,
  startAiCitationPanelScheduler,
} from "./panel-job";
import { aiCitationWeekTotals, loadCitationPrompts } from "./panel-runner";
import { ANTHROPIC_MESSAGES_URL, GEMINI_API_BASE, OPENAI_RESPONSES_URL, PERPLEXITY_SONAR_URL, loadCitationEngines, type CitationEngineId } from "./engines";
import { ENV_ALL, FAKE_KEYS, answerFor, configCopy, stubFetch } from "./engines.test";
import {
  AI_CITATION_PANEL_BOOT_DELAY_MS,
  DENTAL_GEOCODE_BOOT_DELAY_MS,
  EXPERIENCES_GEOCODE_BOOT_DELAY_MS,
  SEARCH_CONSOLE_BOOT_DELAY_MS,
  TRUST_RECALC_BOOT_DELAY_MS,
  URL_BACKFILL_BOOT_DELAY_MS,
  runExclusiveBootJob,
} from "../boot-job-gate";

export interface TestSummary { passed: number; failed: number; failures: string[] }

// Tuesday 2026-10-20 12:00Z, ISO week 2026-W43; outside both blocked windows.
const NOW = new Date("2026-10-20T12:00:00.000Z");
const WEEK = "2026-W43";
const ON = { AI_CITATION_PANEL_ENABLED: "1" } as NodeJS.ProcessEnv;
const ENV_ON_ALL = { ...ENV_ALL, ...ON } as NodeJS.ProcessEnv;

const engineOfUrl = (url: string): CitationEngineId | null =>
  url === ANTHROPIC_MESSAGES_URL ? "anthropic"
    : url === OPENAI_RESPONSES_URL ? "openai"
      : url === PERPLEXITY_SONAR_URL ? "perplexity"
        : url.startsWith(GEMINI_API_BASE) ? "gemini" : null;

/** All four providers; each answer cites our RFB site and one other site. Anything else fails. */
function fakeProviders(over: Partial<Record<CitationEngineId, () => { status: number; body?: unknown; raw?: string }>> = {}) {
  return stubFetch((url) => {
    const id = engineOfUrl(url);
    if (!id) return new Error(`unexpected request ${url}`);
    return over[id]?.() ?? { status: 200, body: answerFor(id, ["https://www.rettfrabonden.com/produsent/x", "https://visitnorway.no/y"]) };
  });
}

/** Calls an Express router directly (same seam as search-console-fetch.test.ts). */
function callRoute(router: any, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const qi = url.indexOf("?");
    const query: Record<string, string> = {};
    if (qi !== -1) for (const pair of url.slice(qi + 1).split("&")) { const [k, v] = pair.split("="); query[k] = decodeURIComponent(v ?? ""); }
    const req: any = { method: "GET", url, query, headers };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "no route") } }));
  });
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const until = async (cond: () => boolean, maxTicks = 2_000) => {
  for (let i = 0; i < maxTicks && !cond(); i++) await tick();
};

export async function runPanelJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const t = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };
  // Everything the job could print, store or return; checked for keys at the end.
  const emitted: string[] = [];
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); emitted.push(m); };
  const realConsoleError = console.error;
  const dbs: Database.Database[] = [];
  const newDb = () => { const d = new Database(":memory:"); dbs.push(d); return d; };
  const dump = (db: Database.Database) => { try { emitted.push(JSON.stringify(db.prepare("SELECT * FROM ai_citation_results").all())); } catch { /* no table */ } };
  const status = (o: Parameters<typeof getAiCitationPanelStatus>[0]) => { const s = getAiCitationPanelStatus(o); emitted.push(JSON.stringify(s)); return s; };
  const PROMPTS = loadCitationPrompts();

  try {
    __resetAiCitationPanelForTesting();

    // ── the flag (AC5: off = 0 calls) ──
    t(!isAiCitationPanelEnabled({}) && !isAiCitationPanelEnabled({ AI_CITATION_PANEL_ENABLED: "0" }) && !isAiCitationPanelEnabled({ AI_CITATION_PANEL_ENABLED: "yes" }) &&
      isAiCitationPanelEnabled(ON) && isAiCitationPanelEnabled({ AI_CITATION_PANEL_ENABLED: " TRUE " }),
      "FL1: AI_CITATION_PANEL_ENABLED is off unless it is 1 / true");
    {
      const f = fakeProviders();
      const db = newDb();
      const r = await runAiCitationPanelTick({ env: { ...ENV_ALL }, db, fetchImpl: f.fetchImpl, now: () => NOW, log });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      t(r.skipped === "disabled" && f.calls.length === 0 && tables.length === 0, "FL2 (AC5): flag off -> no call and the DB is not touched, even with every key set");
      const timers: number[] = [];
      const slogs: string[] = [];
      const s = startAiCitationPanelScheduler({ getDb: newDb, env: { ...ENV_ALL }, log: (m) => slogs.push(m), setTimeoutFn: (_fn, ms) => timers.push(ms), setIntervalFn: (_fn, ms) => timers.push(ms) });
      t(!s.started && timers.length === 0 && slogs.length === 1 && slogs[0].includes("AI_CITATION_PANEL_ENABLED is not 1"),
        "FL3: flag off -> the scheduler logs one line and sets no timer");
    }

    // ── blocked windows ──
    {
      const at = (hhmm: string) => aiCitationBlockedWindowAt(new Date(`2026-10-20T${hhmm}:00Z`));
      t(at("00:00") === "00:00-01:00" && at("00:59") === "00:00-01:00" && at("01:00") === null && at("06:29") === null &&
        at("06:30") === "06:30-09:30" && at("09:29") === "06:30-09:30" && at("09:30") === null && at("23:59") === null,
        "BW1: no calls in 00:00–01:00Z and 06:30–09:30Z (from inclusive, to exclusive)");
      t(AI_CITATION_BLOCKED_WINDOWS_UTC.length === 2, "BW2: exactly the two windows of the spec");
      const f = fakeProviders();
      const r = await runAiCitationPanelTick({ env: ENV_ON_ALL, db: newDb(), fetchImpl: f.fetchImpl, now: () => new Date("2026-10-20T07:00:00Z"), log });
      t(r.skipped === "blocked_window" && r.detail === "06:30-09:30" && f.calls.length === 0, "BW3: a check inside a window does nothing");
    }

    // ── no key -> no engine; one key -> only that engine (AC5) ──
    {
      __resetAiCitationPanelForTesting();
      const f = fakeProviders();
      const before = logs.length;
      const none = await runAiCitationPanelTick({ env: { ...ON }, db: newDb(), fetchImpl: f.fetchImpl, now: () => NOW, log });
      const skipLines = logs.slice(before);
      t(none.skipped === "no_active_engine" && f.calls.length === 0 && skipLines.length === 4 &&
        ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"].every((k) => skipLines.some((l) => l.endsWith(`skipped: ${k} is not set`))),
        "NK1: no key at all -> no call, one line per engine");
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const env = { ...ON, ANTHROPIC_API_KEY: FAKE_KEYS.ANTHROPIC_API_KEY } as NodeJS.ProcessEnv;
      const b2 = logs.length;
      const r = await runAiCitationPanelTick({ env, db, fetchImpl: f.fetchImpl, now: () => NOW, log });
      const lines = logs.slice(b2);
      t(!r.skipped && r.calls === PROMPTS.length && f.calls.every((c) => c.url === ANTHROPIC_MESSAGES_URL) &&
        lines.filter((l) => / skipped: [A-Z_]+ is not set$/.test(l)).length === 3 && !lines.some((l) => l.includes("anthropic skipped")),
        "NK2 (AC5): only the engine with a key is asked; each of the others is skipped with one log line");
      const b3 = logs.length;
      await runAiCitationPanelTick({ env, db, fetchImpl: f.fetchImpl, now: () => new Date("2026-10-27T12:00:00Z"), log });
      t(!logs.slice(b3).some((l) => l.includes("is not set")), "NK3: the skip line is not repeated on later checks");
      dump(db);
    }

    // ── an override naming a model without prices (B1) ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const f = fakeProviders();
      const env = { ...ENV_ON_ALL, AI_CITATION_GEMINI_MODEL: "gemini-2.5-flash" } as NodeJS.ProcessEnv;
      const before = logs.length;
      const r = await runAiCitationPanelTick({ env, db, fetchImpl: f.fetchImpl, now: () => NOW, log, prompts: PROMPTS.slice(0, 2) });
      const lines = logs.slice(before).filter((l) => l.includes(" skipped: "));
      t(!r.skipped && r.calls === 6 && !f.calls.some((c) => c.url.startsWith(GEMINI_API_BASE)) && lines.length === 1 &&
        lines[0] === "[ai-citations] gemini skipped: AI_CITATION_GEMINI_MODEL names a model without prices in config/ai-citation-panel.json",
        "MOJ1: an unpriced AI_CITATION_GEMINI_MODEL skips Gemini (one log line, the value not echoed); the other engines run");
      const st = status({ db, env, now: NOW });
      const g = st.engines.find((e) => e.engine === "gemini")!;
      t(g.model === null && g.price === null && !g.active && g.model_env === "AI_CITATION_GEMINI_MODEL" && !!g.model_error?.includes("AI_CITATION_GEMINI_MODEL") &&
        st.week_expected === PROMPTS.length * 3 && st.config_valid,
        "MOJ2: the status shows the engine off with why, and expects only the active engines");
      dump(db);
    }

    // ── the per-call bound comes from the config (B1) ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const f = fakeProviders();
      const c = configCopy();
      for (const e of Object.values(c.engines) as any[]) for (const m of Object.values(e.models) as any[]) m.maxCostUsdPerCall = 0.5;
      const env = { ...ENV_ON_ALL, AI_CITATION_MAX_USD_PER_RUN: "0.5" } as NodeJS.ProcessEnv;
      const r = await runAiCitationPanelTick({ env, db, fetchImpl: f.fetchImpl, now: () => NOW, log, engines: loadCitationEngines(env, c), prompts: PROMPTS.slice(0, 2) });
      t(!r.skipped && r.calls === 1 && f.calls.length === 1 && f.calls[0].url === ANTHROPIC_MESSAGES_URL && r.stopped === "run_cap" && r.skippedCostCap === 7,
        "CB1: with the config's bound of 0.50 a call each and a run cap of 0.50, exactly one call fits (the caps use the config's bound)");
      dump(db);
    }

    // ── a full panel, then the same week again ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const f = fakeProviders();
      const before = logs.length;
      const r = await runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: f.fetchImpl, now: () => NOW, log });
      const rows = db.prepare("SELECT engine, status, hit_self FROM ai_citation_results WHERE week = ?").all(WEEK) as any[];
      t(!r.skipped && r.calls === PROMPTS.length * 4 && f.calls.length === PROMPTS.length * 4 && rows.length === PROMPTS.length * 4 &&
        rows.every((x) => x.status === "ok" && x.hit_self === 1),
        `FP1: one check runs the whole panel: ${PROMPTS.length} questions × 4 engines, each stored`);
      t(!r.skipped && ["anthropic", "openai", "perplexity", "gemini"].every((e) => r.llmCalls[`ai-citation-${e}`] === PROMPTS.length),
        "FP2: every request is counted by llm-call-meter as ai-citation-<engine>");
      const line = logs.slice(before).find((l) => l.startsWith("[ai-citations] week="));
      t(!!line && new RegExp(`^\\[ai-citations\\] week=${WEEK} calls=${PROMPTS.length * 4} ok=${PROMPTS.length * 4} errors=0 skipped_cost_cap=0 cost_usd=\\d+\\.\\d{4} `).test(line) &&
        line.includes("stopped=- pending=0 by_engine=anthropic:"),
        "FP3: one log line with the counts, the cost and the calls per engine");
      const st = status({ db, env: ENV_ON_ALL, now: NOW });
      t(st.enabled && st.week === WEEK && st.week_results === PROMPTS.length * 4 && st.week_expected === PROMPTS.length * 4 &&
        st.month_cost_usd > 0 && st.month_cost_usd <= 30 && st.month_cost_usd === st.week_cost_usd && !st.month_cap_reached &&
        st.last_run?.calls === PROMPTS.length * 4 && st.engines.every((e) => e.active),
        "FP4 (AC4): the status shows the week done, month_cost_usd ≤ 30 and the last run");
      t(st.month_cost_usd < 8, `FP5: a full panel with these fixture answers costs well under the per-run cap (${st.month_cost_usd} USD)`);
      const again = await runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: f.fetchImpl, now: () => new Date("2026-10-22T15:00:00Z"), log });
      t(!again.skipped && again.calls === 0 && f.calls.length === PROMPTS.length * 4, "FP6 (AC5): a later check in the same week makes no call");
      dump(db);
    }

    // ── the run cap with the real adapters ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const f = fakeProviders();
      const env = { ...ENV_ON_ALL, AI_CITATION_MAX_USD_PER_RUN: "1" } as NodeJS.ProcessEnv;
      const r = await runAiCitationPanelTick({ env, db, fetchImpl: f.fetchImpl, now: () => NOW, log });
      const totals = aiCitationWeekTotals(db, WEEK);
      t(!r.skipped && r.stopped === "run_cap" && r.calls > 0 && r.calls < PROMPTS.length * 4 && r.skippedCostCap === PROMPTS.length * 4 - r.calls &&
        totals.results === PROMPTS.length * 4 && totals.costUsd <= 1,
        `CAP1 (AC4/AC5): AI_CITATION_MAX_USD_PER_RUN=1 stops the run at ${r.skipped ? "?" : r.calls} calls, the rest skipped_cost_cap, cost ≤ 1`);
      const st = status({ db, env, now: NOW });
      t(st.caps.per_run_usd === 1 && st.caps.per_month_usd === 30 && st.last_run?.stopped === "run_cap" && st.week_cost_usd <= 1, "CAP2: the status shows the caps and why the run stopped");
      dump(db);
    }

    // ── a run that reaches 06:30Z pauses and resumes after 09:30Z ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      let clock = Date.parse("2026-10-20T06:25:00Z");
      const base = fakeProviders();
      const f = stubFetch(async (url, _b, init) => {
        clock += 60_000; // each call takes a minute
        const res = await base.fetchImpl(url, init);
        return { status: res.status, raw: await res.text() };
      });
      const now = () => new Date(clock);
      const r = await runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: f.fetchImpl, now, log });
      t(!r.skipped && r.calls === 5 && r.stopped === "blocked_window" && r.pending === PROMPTS.length * 4 - 5 && aiCitationWeekTotals(db, WEEK).results === 5,
        "PW1: the run pauses before its first call at 06:30Z; the rest stays unasked");
      clock = Date.parse("2026-10-20T09:30:00Z");
      const resumed = await runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: f.fetchImpl, now, log });
      t(!resumed.skipped && resumed.calls === PROMPTS.length * 4 - 5 && f.calls.length === PROMPTS.length * 4 && aiCitationWeekTotals(db, WEEK).results === PROMPTS.length * 4,
        "PW2: the first check after 09:30Z finishes the week without asking anything twice");
    }

    // ── no two runs at once ──
    {
      __resetAiCitationPanelForTesting();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const base = fakeProviders();
      const slow = stubFetch(async (url, _b, init) => {
        await gate;
        const res = await base.fetchImpl(url, init);
        return { status: res.status, raw: await res.text() };
      });
      const db = newDb();
      const first = runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: slow.fetchImpl, now: () => NOW, log, prompts: PROMPTS.slice(0, 2) });
      await until(() => slow.calls.length > 0);
      const second = await runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: slow.fetchImpl, now: () => NOW, log, prompts: PROMPTS.slice(0, 2) });
      t(second.skipped === "already_running" && status({ db, env: ENV_ON_ALL, now: NOW }).running === true, "RN1: a check while a run is going does nothing");
      release();
      const r = await first;
      t(!r.skipped && r.calls === 8 && slow.calls.length === 8 && status({ db, env: ENV_ON_ALL, now: NOW }).running === false, "RN2: the first run finishes alone");
    }

    // ── scheduler ──
    {
      __resetAiCitationPanelForTesting();
      t(AI_CITATION_PANEL_BOOT_DELAY_MS === 15 * 60_000 &&
        [SEARCH_CONSOLE_BOOT_DELAY_MS, DENTAL_GEOCODE_BOOT_DELAY_MS, TRUST_RECALC_BOOT_DELAY_MS, URL_BACKFILL_BOOT_DELAY_MS, EXPERIENCES_GEOCODE_BOOT_DELAY_MS, 9 * 60_000, 10 * 60_000]
          .every((ms) => AI_CITATION_PANEL_BOOT_DELAY_MS > ms) && AI_CITATION_PANEL_TICK_INTERVAL_MS === 3_600_000,
        "SC1: first check 15 min after boot, after every other boot job; then hourly");
      const timers: Array<{ kind: string; fn: () => void; ms: number }> = [];
      const fakeSet = (kind: string) => (fn: () => void, ms: number) => { timers.push({ kind, fn, ms }); return { unref() {} }; };
      const f = fakeProviders();
      const db = newDb();
      const prompts = PROMPTS.slice(0, 3);
      const sOn = startAiCitationPanelScheduler({ getDb: () => db, env: ENV_ON_ALL, log, setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i"), run: { fetchImpl: f.fetchImpl, now: () => NOW, prompts } });
      t(sOn.started && timers.length === 2 && timers[0].kind === "t" && timers[0].ms === AI_CITATION_PANEL_BOOT_DELAY_MS && timers[1].kind === "i" &&
        timers[1].ms === AI_CITATION_PANEL_TICK_INTERVAL_MS && f.calls.length === 0 && status({ db, env: ENV_ON_ALL, now: NOW }).scheduler_started === true,
        "SC2: flag on -> a boot timer and an hourly timer; nothing at once");
      let releaseBlocker!: () => void;
      const blocker = runExclusiveBootJob(() => new Promise<void>((r) => { releaseBlocker = r; }));
      timers[0].fn();
      await tick(); await tick();
      t(f.calls.length === 0, "SC3: the check queues behind a boot job holding the gate");
      releaseBlocker();
      await blocker;
      await until(() => aiCitationWeekTotals(db, WEEK).results === 12);
      t(f.calls.length === 12, "SC4: once the gate is free it runs (3 questions × 4 engines)");
      sOn.stop();
      t(status({ db, env: ENV_ON_ALL, now: NOW }).scheduler_started === false, "SC5: stop() clears the timers");
      // It waits for the gate but makes its calls outside it.
      __resetAiCitationPanelForTesting();
      let releaseNet!: () => void;
      const net = new Promise<void>((r) => { releaseNet = r; });
      const base = fakeProviders();
      const slowNet = stubFetch(async (url, _b, init) => {
        await net;
        const res = await base.fetchImpl(url, init);
        return { status: res.status, raw: await res.text() };
      });
      const db2 = newDb();
      const sSlow = startAiCitationPanelScheduler({ getDb: () => db2, env: ENV_ON_ALL, log, setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i"), run: { fetchImpl: slowNet.fetchImpl, now: () => NOW, prompts } });
      timers[timers.length - 2].fn();
      await until(() => slowNet.calls.length > 0);
      let laterRan = false;
      const laterJob = runExclusiveBootJob(() => { laterRan = true; });
      await until(() => laterRan, 50);
      t(laterRan && slowNet.calls.length === 1, "SC6: while the panel waits on the network, a boot job queued after it runs (the gate is not held)");
      releaseNet();
      await laterJob;
      await until(() => aiCitationWeekTotals(db2, WEEK).results === 12);
      t(slowNet.calls.length === 12, "SC7: and the panel then finishes as usual");
      sSlow.stop();
      // A failed run is logged without keys.
      __resetAiCitationPanelForTesting();
      const errLines: string[] = [];
      console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(" ")); };
      try {
        const sErr = startAiCitationPanelScheduler({
          getDb: () => { throw new Error(`db unavailable ${FAKE_KEYS.OPENAI_API_KEY}`); },
          env: ENV_ON_ALL, log, setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i"), run: { fetchImpl: f.fetchImpl, now: () => NOW, prompts },
        });
        timers[timers.length - 2].fn();
        await until(() => errLines.length > 0);
        sErr.stop();
      } finally {
        console.error = realConsoleError;
      }
      emitted.push(...errLines);
      t(errLines.length === 1 && /^\[ai-citations\] run failed \(non-fatal\): Error: db unavailable \[redacted\]$/.test(errLines[0]),
        "SC8: a failed run is logged once, the key redacted");
    }

    // ── status ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const st = status({ db, env: { ANTHROPIC_API_KEY: FAKE_KEYS.ANTHROPIC_API_KEY }, now: new Date("2026-10-20T07:15:00Z") });
      t(!st.enabled && st.flag === "AI_CITATION_PANEL_ENABLED" && !st.scheduler_started && st.last_run === null &&
        JSON.stringify(st.engines.map((e) => [e.engine, e.active, e.key_env])) ===
          JSON.stringify([["anthropic", true, "ANTHROPIC_API_KEY"], ["openai", false, "OPENAI_API_KEY"], ["perplexity", false, "PERPLEXITY_API_KEY"], ["gemini", false, "GEMINI_API_KEY"]]),
        "ST1: flag off, which engines have a key (by the secret's name only)");
      t(JSON.stringify(st.engines.map((e) => e.model)) === JSON.stringify(["claude-haiku-5-5", "gpt-6-luna", "sonar", "gemini-3.5-flash-lite"]) &&
        st.engines.every((e) => e.model_error === null && e.price !== null && e.price.maxCostUsdPerCall === e.max_cost_usd_per_call) &&
        st.engines.find((e) => e.engine === "gemini")!.price!.usdPerSearch === 0.014,
        "ST1b: each engine's model, its prices and per-call bound as in the config");
      t(st.month === "2026-10" && st.month_cost_usd === 0 && st.month_remaining_usd === 30 && st.caps.per_run_usd === 8 && st.prompts === PROMPTS.length &&
        st.config_valid && st.week_expected === PROMPTS.length && st.week_results === 0 && st.blocked_now === "06:30-09:30" &&
        JSON.stringify(st.blocked_windows_utc) === JSON.stringify(["00:00-01:00", "06:30-09:30"]),
        "ST2: month cost and what is left, the week's progress against questions × active engines, the windows");
    }

    // ── admin routes ──
    {
      __resetAiCitationPanelForTesting();
      const initMod = require("../../database/init") as typeof import("../../database/init");
      const restoreDb = initMod.__pinInMemoryDbForTesting();
      const prevEnv = { a: process.env.ADMIN_KEY, b: process.env.ANALYTICS_ADMIN_KEY };
      try {
        const mainDb = initMod.getDb();
        const { aiCitationWeekOf } = await import("./panel-runner");
        // A fixed week, so no step depends on the wall clock (S7).
        mainDb.prepare(
          `INSERT INTO ai_citation_results (week, engine, prompt_id, vertical, status, reason, cited_urls, cited_domains, hit_self, answer_snippet, cost_usd, created_at)
           VALUES (?, 'anthropic', 'rfb-02', 'rfb', 'ok', NULL, '["https://www.rettfrabonden.com/x"]', '["rettfrabonden.com"]', 1, 'Svar', 0.0125, ?)`,
        ).run(WEEK, NOW.toISOString());
        const router = (require("../../routes/admin-ai-citations") as typeof import("../../routes/admin-ai-citations")).default;
        delete process.env.ADMIN_KEY;
        delete process.env.ANALYTICS_ADMIN_KEY;
        const r503 = await callRoute(router, "/", { "x-admin-key": "k" });
        const r503s = await callRoute(router, "/status", { "x-admin-key": "k" });
        t(r503.status === 503 && r503s.status === 503, "AD1: no admin key configured -> 503");
        process.env.ADMIN_KEY = "test-admin-key-1234";
        const bad = [await callRoute(router, "/", { "x-admin-key": "wrong" }), await callRoute(router, "/status"), await callRoute(router, "/status", { "x-admin-key": "wrong" })];
        t(bad.every((b) => b.status === 401), "AD2: wrong / missing X-Admin-Key -> 401");
        const ok = await callRoute(router, `/?week=${WEEK}`, { "x-admin-key": "test-admin-key-1234" });
        emitted.push(JSON.stringify(ok.body));
        t(ok.status === 200 && ok.body.week === WEEK && ok.body.cost_usd_total === 0.0125 && ok.body.results.length === 1 &&
          ok.body.engines.find((e: any) => e.engine === "anthropic").hits === 1 && ok.body.engines.find((e: any) => e.engine === "gemini").model === "gemini-3.5-flash-lite",
          "AD3 (AC4): GET /admin/analytics/ai-citations?week= -> 200 with cost_usd_total and each engine's model");
        const byDay = await callRoute(router, "/?week=2026-10-25", { "x-admin-key": "test-admin-key-1234" });
        const weekBefore = aiCitationWeekOf(new Date());
        const def = await callRoute(router, "/", { "x-admin-key": "test-admin-key-1234" });
        const weekAfter = aiCitationWeekOf(new Date());
        t(byDay.status === 200 && byDay.body.week === WEEK && byDay.body.cost_usd_total === 0.0125 && def.status === 200 &&
          (def.body.week === weekBefore || def.body.week === weekAfter),
          "AD4: a day of the week also works; no week -> the current week (read on either side of the call)");
        const bads = await Promise.all(["/?week=2026-W54", "/?week=abc", "/?week=2026-13-01", "/?week="].map((u) => callRoute(router, u, { "x-admin-key": "test-admin-key-1234" })));
        t(bads.every((b) => b.status === 400), "AD5: a week that is neither an ISO week nor a date -> 400");
        const st = await callRoute(router, "/status", { "x-admin-key": "test-admin-key-1234" });
        emitted.push(JSON.stringify(st.body));
        t(st.status === 200 && typeof st.body.month_cost_usd === "number" && st.body.month_cost_usd <= 30 && typeof st.body.enabled === "boolean" &&
          st.body.engines.length === 4,
          "AD6 (AC4): GET /admin/analytics/ai-citations/status -> 200 with month_cost_usd ≤ 30");
      } finally {
        if (prevEnv.a === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevEnv.a;
        if (prevEnv.b === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevEnv.b;
        restoreDb();
      }
    }

    // ── a provider that echoes the key ──
    {
      __resetAiCitationPanelForTesting();
      const db = newDb();
      const f = fakeProviders({
        openai: () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${FAKE_KEYS.OPENAI_API_KEY}` } } }),
        gemini: () => ({ status: 400, raw: `{"error":{"message":"API key not valid: ${FAKE_KEYS.GEMINI_API_KEY}"}}` }),
      });
      const r = await runAiCitationPanelTick({ env: ENV_ON_ALL, db, fetchImpl: f.fetchImpl, now: () => NOW, log, prompts: PROMPTS.slice(0, 2) });
      emitted.push(JSON.stringify(r));
      const reasons = (db.prepare("SELECT engine, reason FROM ai_citation_results WHERE status = 'error' ORDER BY engine").all() as any[]).map((x) => `${x.engine}:${x.reason}`);
      t(!r.skipped && r.errors === 4 && reasons.join(",") === "gemini:http_400,gemini:http_400,openai:http_401,openai:http_401",
        "EK1: a provider error is stored as its code only");
      dump(db);
      emitted.push(JSON.stringify(status({ db, env: ENV_ON_ALL, now: NOW })));
    }

    // ── wiring in src/index.ts ──
    {
      const idx = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf8");
      const mount = idx.indexOf('app.use("/admin/analytics/ai-citations", adminLimiter, adminAiCitationsRoutes);');
      t(mount > 0 && mount < idx.indexOf('app.use("/admin/analytics", analyticsRoutes);') && idx.includes('import adminAiCitationsRoutes from "./routes/admin-ai-citations";'),
        "IX1: the admin router is mounted (with adminLimiter) before /admin/analytics");
      t(/\n  startAiCitationPanelScheduler\(\{ getDb: \(\) => getDb\(\) \}\);\n/.test(idx), "IX2: index.ts starts the scheduler (which does nothing with the flag off)");
    }

    // ── no key anywhere ──
    const out = emitted.join("\n");
    const leaked = Object.values(FAKE_KEYS).filter((k) => out.includes(k));
    t(emitted.length > 20 && leaked.length === 0,
      `SEC1 (AC5): no key in ${emitted.length} captured log lines, errors, DB rows, statuses and responses` + (leaked.length ? ` (leaked: ${leaked.length})` : ""));
  } catch (err: any) {
    failed++;
    failures.push("panel-job: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.error = realConsoleError;
    __resetAiCitationPanelForTesting();
    for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runPanelJobTests({ log: true }).then((r) => {
    console.log(`\nai-citation panel-job: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

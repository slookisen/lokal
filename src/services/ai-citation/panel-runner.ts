// ─── AI citation panel: questions, own domains, store, run and admin read ───
// A2A dev-request 2026-10-16-siteringspanel, S5a (S5b's weekly job is
// panel-job.ts; the engines are engines.ts).
//
// We count AI bots that visit, but not whether AI answers cite us. The panel
// asks the same ~50 Norwegian questions (config/ai-citation-panel.json: id,
// vertical, prompt — a new question is one line there) to each engine with a
// key, once per ISO week, and stores per (week, engine, question) the cited
// URLs, their domains, whether one of them is ours (hit_self), a ≤ 300-char
// answer snippet and the cost, in ai_citation_results.
//
// Our domains are the three brands' sites from config/brand-entities.ts
// (rettfrabonden.com, opplevagent.no, finn-tannlege.com): a cited host (read
// with WHATWG URL, engines.ts citationHostOf) counts when it is the domain or a
// subdomain of it, www. included, so producer pages
// (/produsent/…), clinic pages and experience pages on our sites are hits.
// A new vertical is a new brand there plus its questions here. A producer's or
// clinic's OWN website is not "us" and is not a hit; it shows up among the
// cited domains like any other site.
//
// Idempotent per week: each (week, engine, question) is stored once (UNIQUE,
// INSERT OR IGNORE) and never asked again, so a week is never run twice; a run
// that was paused (panel-job.ts: a blocked window) or cut off resumes with the
// questions still missing, and an engine whose key arrives mid-week is asked
// that week too.
//
// Cost caps (AI_CITATION_MAX_USD_PER_RUN, default 8, for the whole week's
// run; AI_CITATION_MAX_USD_PER_MONTH, default 30, UTC calendar month):
// before each call the engine's maxCostUsdPerCall must still fit under both.
// When it does not, the run stops asking and every remaining question of the
// week is stored as skipped_cost_cap (reason run_cap / month_cap). A month
// that has already reached its cap starts no run at all (nothing asked,
// nothing stored), so the week can still run once the month turns.
//
// No personal data: the questions are fixed and general, and only URLs,
// domains, the hit flag, the snippet and the cost are kept. Nothing is sent
// anywhere but the four APIs.

import type Database from "better-sqlite3";
import panelConfig from "../../config/ai-citation-panel.json";
import { BRAND_ENTITIES, type BrandKey } from "../../config/brand-entities";
import { isoWeekKey } from "../offsite-backup";
import { addDays, dayOf, isDay, monthStartOf, nextMonthStart } from "../traffic-history-compute";
import { yieldToEventLoop } from "../boot-job-gate";
import { citationEnginesForView, citationHostOf, citedDomainOf, type CitationEngine, type CitationEngineDeps } from "./engines";

type Db = Database.Database;

// ── Questions ─────────────────────────────────────────────────────────

export type CitationVertical = Exclude<BrandKey, "company">;
export const AI_CITATION_VERTICALS: readonly CitationVertical[] = ["rfb", "experiences", "dental"];

export interface CitationPrompt {
  id: string;
  vertical: CitationVertical;
  prompt: string;
}

export const CITATION_PROMPT_MAX_CHARS = 300;
const PROMPT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The questions from config/ai-citation-panel.json (or `raw`), checked: a lowercase id
 * (unique, ≤ 40 chars), a known vertical and a prompt of 1–300 characters. Throws with every
 * problem listed by id, so a broken edit makes no call instead of a partial panel.
 */
export function loadCitationPrompts(raw: unknown = panelConfig): CitationPrompt[] {
  const list = (raw as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(list) || list.length === 0) throw new Error("ai-citation-panel.json: prompts must be a non-empty array");
  const problems: string[] = [];
  const seen = new Set<string>();
  const out: CitationPrompt[] = [];
  list.forEach((p: any, i: number) => {
    const id = typeof p?.id === "string" ? p.id : "";
    const label = id || `#${i}`;
    if (!PROMPT_ID_RE.test(id)) problems.push(`${label}: id`);
    else if (seen.has(id)) problems.push(`${label}: duplicate id`);
    seen.add(id);
    const vertical = p?.vertical;
    if (!AI_CITATION_VERTICALS.includes(vertical)) problems.push(`${label}: vertical`);
    const prompt = typeof p?.prompt === "string" ? p.prompt.trim() : "";
    if (!prompt || Array.from(prompt).length > CITATION_PROMPT_MAX_CHARS) problems.push(`${label}: prompt`);
    out.push({ id, vertical, prompt });
  });
  if (problems.length > 0) throw new Error(`ai-citation-panel.json: ${problems.join("; ")}`);
  return out;
}

// ── Our domains ───────────────────────────────────────────────────────

export const AI_CITATION_OWN_DOMAINS: readonly { brand: CitationVertical; domain: string }[] = Object.freeze(
  AI_CITATION_VERTICALS.map((brand) => Object.freeze({ brand, domain: new URL(BRAND_ENTITIES[brand].url).hostname })),
);

/**
 * Which of our brands a cited URL or host belongs to: the brand's domain itself or any
 * subdomain of it, case-insensitive, with or without www. and a trailing dot. A look-alike
 * («notrettfrabonden.com», «rettfrabonden.com.example.no») is not ours, and neither is a URL
 * whose host is another site («https://evil.example\@rettfrabonden.com/» is evil.example).
 */
export function ownBrandOfHost(urlOrHost: string): CitationVertical | null {
  const host = citationHostOf(urlOrHost);
  if (!host) return null;
  for (const { brand, domain } of AI_CITATION_OWN_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return brand;
  }
  return null;
}

/** Our brands among an answer's cited URLs and domains, each once, in brand order. */
export function ownBrandsCited(urls: readonly string[], domains: readonly string[]): CitationVertical[] {
  const hit = new Set<CitationVertical>();
  for (const s of [...urls, ...domains]) {
    const b = ownBrandOfHost(s);
    if (b) hit.add(b);
  }
  return AI_CITATION_VERTICALS.filter((b) => hit.has(b));
}

/** Distinct cited domains (citedDomainOf) of URLs or hosts, in order. */
export function citedDomainsOf(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    const d = citedDomainOf(s);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

// ── Weeks ─────────────────────────────────────────────────────────────

/** The ISO week (UTC) a date belongs to, e.g. "2026-W43". A run belongs to the week it runs in. */
export function aiCitationWeekOf(d: Date): string {
  return isoWeekKey(d);
}

/** Monday (YYYY-MM-DD) of an ISO week key; null when the key is not a real week (W53 only in long years). */
export function isoWeekStart(key: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * 86_400_000 + (week - 1) * 7 * 86_400_000;
  return isoWeekKey(new Date(monday)) === key ? dayOf(monday) : null;
}

/** ?week=: an ISO week ("2026-W43") or any day of it (YYYY-MM-DD) -> the ISO week; null when neither. */
export function parseAiCitationWeek(raw: string): string | null {
  if (isoWeekStart(raw)) return raw;
  if (isDay(raw)) return isoWeekKey(new Date(`${raw}T00:00:00Z`));
  return null;
}

// ── Caps ──────────────────────────────────────────────────────────────

export const AI_CITATION_MAX_USD_PER_RUN_DEFAULT = 8;
export const AI_CITATION_MAX_USD_PER_MONTH_DEFAULT = 30;

export interface AiCitationCaps {
  perRunUsd: number;
  perMonthUsd: number;
}

function usdEnv(raw: string | undefined, fallback: number): number {
  const s = (raw ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** AI_CITATION_MAX_USD_PER_RUN / _PER_MONTH (USD, ≥ 0); unset or junk -> 8 / 30. */
export function resolveAiCitationCaps(env: NodeJS.ProcessEnv = process.env): AiCitationCaps {
  return {
    perRunUsd: usdEnv(env.AI_CITATION_MAX_USD_PER_RUN, AI_CITATION_MAX_USD_PER_RUN_DEFAULT),
    perMonthUsd: usdEnv(env.AI_CITATION_MAX_USD_PER_MONTH, AI_CITATION_MAX_USD_PER_MONTH_DEFAULT),
  };
}

// ── Store ─────────────────────────────────────────────────────────────

export type AiCitationStatus = "ok" | "error" | "skipped_cost_cap";

/**
 * Same DDL as database/init.ts (kept identical; a test compares them), so either path is enough.
 * Additive. status: ok | error (reason = the engine's fixed code) | skipped_cost_cap (reason
 * run_cap / month_cap). cited_urls / cited_domains are JSON arrays. created_at is ISO UTC.
 */
export const AI_CITATION_RESULTS_DDL = `CREATE TABLE IF NOT EXISTS ai_citation_results (
        week TEXT NOT NULL,
        engine TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        vertical TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        cited_urls TEXT NOT NULL,
        cited_domains TEXT NOT NULL,
        hit_self INTEGER NOT NULL DEFAULT 0,
        answer_snippet TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (week, engine, prompt_id)
      )`;

const ensuredDbs = new WeakSet<object>();

export function ensureAiCitationResultsTable(db: Db): void {
  if (ensuredDbs.has(db)) return;
  db.exec(AI_CITATION_RESULTS_DDL);
  ensuredDbs.add(db);
}

interface ResultRow {
  week: string;
  engine: string;
  promptId: string;
  vertical: string;
  status: AiCitationStatus;
  reason: string | null;
  citedUrls: string[];
  citedDomains: string[];
  hitSelf: boolean;
  answerSnippet: string | null;
  costUsd: number;
  createdAt: string;
}

/** Insert one result; false when (week, engine, prompt_id) is already stored. */
function insertResult(db: Db, r: ResultRow): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO ai_citation_results
         (week, engine, prompt_id, vertical, status, reason, cited_urls, cited_domains, hit_self, answer_snippet, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.week, r.engine, r.promptId, r.vertical, r.status, r.reason,
      JSON.stringify(r.citedUrls), JSON.stringify(r.citedDomains), r.hitSelf ? 1 : 0,
      r.answerSnippet, r.costUsd, r.createdAt,
    );
  return info.changes > 0;
}

const pairKey = (engine: string, promptId: string) => `${engine}\u0000${promptId}`;

function storedPairKeys(db: Db, week: string): Set<string> {
  const rows = db.prepare("SELECT engine, prompt_id FROM ai_citation_results WHERE week = ?").all(week) as { engine: string; prompt_id: string }[];
  return new Set(rows.map((r) => pairKey(r.engine, r.prompt_id)));
}

/** Stored results and their summed cost for one week. */
export function aiCitationWeekTotals(db: Db, week: string): { results: number; costUsd: number } {
  ensureAiCitationResultsTable(db);
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS c FROM ai_citation_results WHERE week = ?").get(week) as { n: number; c: number };
  return { results: r.n, costUsd: r.c };
}

/** Summed cost of the results created in the UTC calendar month of `now`. */
export function aiCitationMonthCostUsd(db: Db, now: Date): number {
  ensureAiCitationResultsTable(db);
  const day = dayOf(now.getTime());
  const r = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_citation_results WHERE created_at >= ? AND created_at < ?")
    .get(`${monthStartOf(day)}T00:00:00.000Z`, `${nextMonthStart(day)}T00:00:00.000Z`) as { c: number };
  return r.c;
}

// ── The run ───────────────────────────────────────────────────────────

export interface CitationPanelRunOptions {
  db: Db;
  week: string;
  prompts: readonly CitationPrompt[];
  /** The engines to ask, in order (the job passes the ones with a key). */
  engines: readonly CitationEngine[];
  caps: AiCitationCaps;
  now?: () => Date;
  /** Checked before every call: a reason pauses the run there, and the rest waits for a later run. */
  shouldPause?: () => string | null;
  deps?: CitationEngineDeps;
}

export interface CitationPanelRunSummary {
  week: string;
  /** Requests sent in this run. */
  calls: number;
  ok: number;
  errors: number;
  skippedCostCap: number;
  /** Cost of this run's calls. */
  costUsd: number;
  /** All stored cost of the week, and of the month, after this run. */
  weekCostUsd: number;
  monthCostUsd: number;
  /** Why the run ended before every question was asked: run_cap, month_cap or the pause reason; null otherwise. */
  stopped: string | null;
  /** Questions × engines neither stored nor asked; a later run takes them. */
  pending: number;
}

const finiteUsd = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Ask every (question, engine) pair of the week that is not stored yet, question by question
 * and each engine in order, within the caps; store each answer, error or skip as it comes.
 */
export async function runCitationPanel(opts: CitationPanelRunOptions): Promise<CitationPanelRunSummary> {
  const { db, week, caps } = opts;
  const now = opts.now ?? (() => new Date());
  ensureAiCitationResultsTable(db);
  const stored = storedPairKeys(db, week);
  const todo: { prompt: CitationPrompt; engine: CitationEngine }[] = [];
  for (const prompt of opts.prompts) {
    for (const engine of opts.engines) if (!stored.has(pairKey(engine.engine, prompt.id))) todo.push({ prompt, engine });
  }
  let weekSpent = aiCitationWeekTotals(db, week).costUsd;
  let monthSpent = aiCitationMonthCostUsd(db, now());
  const s: CitationPanelRunSummary = {
    week, calls: 0, ok: 0, errors: 0, skippedCostCap: 0, costUsd: 0,
    weekCostUsd: weekSpent, monthCostUsd: monthSpent, stopped: null, pending: 0,
  };
  if (todo.length === 0) return s;
  if (monthSpent >= caps.perMonthUsd) {
    s.stopped = "month_cap";
    s.pending = todo.length;
    return s;
  }

  let capStop: "run_cap" | "month_cap" | null = null;
  for (let i = 0; i < todo.length; i++) {
    const { prompt, engine } = todo[i];
    const base = { week, engine: engine.engine, promptId: prompt.id, vertical: prompt.vertical };
    if (!capStop) {
      const pause = opts.shouldPause?.() ?? null;
      if (pause) {
        s.stopped = pause;
        s.pending = todo.length - i;
        break;
      }
      if (weekSpent + engine.maxCostUsdPerCall > caps.perRunUsd) capStop = "run_cap";
      else if (monthSpent + engine.maxCostUsdPerCall > caps.perMonthUsd) capStop = "month_cap";
    }
    if (capStop) {
      insertResult(db, {
        ...base, status: "skipped_cost_cap", reason: capStop, citedUrls: [], citedDomains: [],
        hitSelf: false, answerSnippet: null, costUsd: 0, createdAt: now().toISOString(),
      });
      s.skippedCostCap++;
      continue;
    }

    await yieldToEventLoop();
    const r = await engine.run(prompt.prompt, opts.deps);
    s.calls++;
    const cost = finiteUsd(r.costUsd);
    if (r.ok) {
      const domains = citedDomainsOf(r.citedDomains ?? r.citedUrls);
      insertResult(db, {
        ...base, status: "ok", reason: null, citedUrls: r.citedUrls, citedDomains: domains,
        hitSelf: ownBrandsCited(r.citedUrls, domains).length > 0, answerSnippet: r.answerSnippet,
        costUsd: cost, createdAt: now().toISOString(),
      });
      s.ok++;
    } else {
      insertResult(db, {
        ...base, status: "error", reason: r.reason, citedUrls: [], citedDomains: [],
        hitSelf: false, answerSnippet: null, costUsd: cost, createdAt: now().toISOString(),
      });
      s.errors++;
    }
    weekSpent += cost;
    monthSpent += cost;
    s.costUsd += cost;
  }
  if (capStop) s.stopped = capStop;
  s.weekCostUsd = weekSpent;
  s.monthCostUsd = monthSpent;
  return s;
}

// ── Admin read ────────────────────────────────────────────────────────

export const TOP_DOMAINS_PER_ENGINE = 5;
export const TOP_DOMAINS_PER_VERTICAL = 10;

interface StoredResult {
  week: string;
  engine: string;
  prompt_id: string;
  vertical: string;
  status: AiCitationStatus;
  reason: string | null;
  cited_urls: string;
  cited_domains: string;
  hit_self: number;
  answer_snippet: string | null;
  cost_usd: number;
  created_at: string;
}

function jsonList(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Domains by how many answers cite them (most first, then by name), the first `n`. */
function topDomains(rows: readonly { domains: string[] }[], n: number): { domain: string; answers: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const d of r.domains) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([domain, answers]) => ({ domain, answers }));
}

const usd = (n: number) => Math.round(n * 1e6) / 1e6;
const share = (hits: number, prompts: number) => (prompts > 0 ? Math.round((hits / prompts) * 10_000) / 10_000 : null);

function defaultDb(): Db {
  // Lazy: keeps this module loadable in tests without opening the prod DB.
  const init = require("../../database/init") as typeof import("../../database/init");
  return init.getDb();
}

/**
 * GET /admin/analytics/ai-citations: one ISO week (default: the current one). Per engine: the
 * model, active (model priced and key set), answered questions, hits on our domains and that
 * share (also last week's and the change, for the week-over-week view), errors,
 * skipped_cost_cap, cost and the top-5 cited domains. Per vertical: our hits per engine and the top-10 cited domains (the competitor
 * picture). `results` is one entry per question and engine (what the visibility routine writes
 * to visibility-reports/citations/<week>.jsonl). `cost_usd_total` is the week's stored cost.
 * Read-only, no network.
 */
export function getAiCitationWeekView(opts: {
  db?: Db;
  week?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  engines?: readonly CitationEngine[];
  prompts?: readonly CitationPrompt[];
} = {}) {
  const db = opts.db ?? defaultDb();
  ensureAiCitationResultsTable(db);
  const env = opts.env ?? process.env;
  const engines = opts.engines ?? citationEnginesForView(env).engines;
  let prompts: readonly CitationPrompt[] = [];
  try {
    prompts = opts.prompts ?? loadCitationPrompts();
  } catch {
    /* an invalid config still lets the stored weeks be read */
  }
  const currentWeek = aiCitationWeekOf(opts.now ?? new Date());
  const week = opts.week ?? currentWeek;
  const weekStart = isoWeekStart(week);
  const previousWeek = weekStart ? isoWeekKey(new Date(`${addDays(weekStart, -7)}T00:00:00Z`)) : null;
  const select = db.prepare("SELECT * FROM ai_citation_results WHERE week = ? ORDER BY rowid");
  const parse = (r: StoredResult) => {
    const urls = jsonList(r.cited_urls);
    const domains = jsonList(r.cited_domains);
    return { ...r, urls, domains, brands: ownBrandsCited(urls, domains) };
  };
  const rows = (select.all(week) as StoredResult[]).map(parse);
  const prev = previousWeek ? (select.all(previousWeek) as StoredResult[]).map(parse) : [];
  const promptText = new Map(prompts.map((p) => [p.id, p.prompt]));

  const engineSummary = engines.map((e) => {
    const mine = rows.filter((r) => r.engine === e.engine);
    const answered = mine.filter((r) => r.status === "ok");
    const hits = answered.filter((r) => r.hit_self === 1).length;
    const prevAnswered = prev.filter((r) => r.engine === e.engine && r.status === "ok");
    const shareNow = share(hits, answered.length);
    const sharePrev = share(prevAnswered.filter((r) => r.hit_self === 1).length, prevAnswered.length);
    return {
      engine: e.engine,
      model: e.model,
      active: e.enabled(env),
      prompts: answered.length,
      hits,
      share: shareNow,
      previous_share: sharePrev,
      share_change: shareNow !== null && sharePrev !== null ? Math.round((shareNow - sharePrev) * 10_000) / 10_000 : null,
      errors: mine.filter((r) => r.status === "error").length,
      skipped_cost_cap: mine.filter((r) => r.status === "skipped_cost_cap").length,
      cost_usd: usd(mine.reduce((sum, r) => sum + r.cost_usd, 0)),
      top_domains: topDomains(answered, TOP_DOMAINS_PER_ENGINE),
    };
  });

  const verticals = AI_CITATION_VERTICALS.map((vertical) => {
    const answered = rows.filter((r) => r.vertical === vertical && r.status === "ok");
    const hitsByEngine: Record<string, number> = {};
    for (const e of engines) hitsByEngine[e.engine] = answered.filter((r) => r.engine === e.engine && r.hit_self === 1).length;
    return {
      vertical,
      prompts: prompts.filter((p) => p.vertical === vertical).length,
      answers: answered.length,
      hits_by_engine: hitsByEngine,
      top_domains: topDomains(answered, TOP_DOMAINS_PER_VERTICAL),
    };
  });

  const caps = resolveAiCitationCaps(env);
  const storedWeeks = (db.prepare("SELECT DISTINCT week FROM ai_citation_results ORDER BY week DESC LIMIT 12").all() as { week: string }[]).map((r) => r.week);
  return {
    week,
    week_start: weekStart,
    week_end: weekStart ? addDays(weekStart, 6) : null,
    current_week: currentWeek,
    previous_week: previousWeek,
    cost_usd_total: usd(rows.reduce((sum, r) => sum + r.cost_usd, 0)),
    cost_cap_usd_per_run: caps.perRunUsd,
    engines: engineSummary,
    verticals,
    results: rows.map((r) => ({
      prompt_id: r.prompt_id,
      vertical: r.vertical,
      prompt: promptText.get(r.prompt_id) ?? null,
      engine: r.engine,
      status: r.status,
      reason: r.reason,
      cited_urls: r.urls,
      cited_domains: r.domains,
      hit_self: r.hit_self === 1,
      own_brands: r.brands,
      answer_snippet: r.answer_snippet,
      cost_usd: usd(r.cost_usd),
      created_at: r.created_at,
    })),
    stored_weeks: storedWeeks,
  };
}

// ─── Threshold for the public per-profile numbers (RFB) ─────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2f («Terskel for
// offentlige tall», Daniel 2026-10-28): the public statistics tiles on an RFB
// producer profile (/produsent/<slug>: the «Sidevisninger», AI and «Med i
// AI-søk» tiles and the «Aktivitet» counts) and the same counts in the public
// machine-readable payload (GET /api/agents/:id/stats) are shown only when the
// profile has at least PUBLIC_STATS_MIN_VIEWS (default 20) page views from
// people over the last 12 months. Below it: no tiles and no zeros.
//
// One source: the number compared is the owner's own «Sett» over 12 months
// (owner-stats-service.ts getOwnerHumanViewsYear = getOwnerStats().year.
// humanViews.value, the number /selger's Statistikk tab and «Mine valg» show).
// The owner always sees that number, whatever the threshold.
// `stats.public_counts = off` (owner choice, enforce.ts) always hides.
//
// Scope: RFB profiles only. Dental (finn-tannlege), Opplevagent / gårdssalg
// and the platform-wide numbers (front page strip, investor page) do not
// call this and are unchanged.

import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import { getOwnerHumanViewsYear } from "./owner-stats-service";

export const PUBLIC_STATS_MIN_VIEWS_ENV = "PUBLIC_STATS_MIN_VIEWS";
export const PUBLIC_STATS_MIN_VIEWS_DEFAULT = 20;
/** How long one profile's 12-month count is reused (the public tiles are cached 5 min over HTTP too). */
export const PUBLIC_STATS_VIEWS_CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20_000;

/**
 * The threshold. A whole number 0–999 999 999 (surrounding blanks allowed);
 * unset, empty, negative, a fraction or anything else → the default 20.
 * 0 switches the threshold off (only `stats.public_counts` then hides).
 */
export function publicStatsMinViews(env: NodeJS.ProcessEnv = process.env): number {
  const override = overrideStore.getStore();
  if (override !== undefined) return override;
  const raw = env[PUBLIC_STATS_MIN_VIEWS_ENV];
  if (typeof raw !== "string") return PUBLIC_STATS_MIN_VIEWS_DEFAULT;
  const t = raw.trim();
  if (!/^\d{1,9}$/.test(t)) return PUBLIC_STATS_MIN_VIEWS_DEFAULT;
  return Number(t);
}

// The switch probe («bryterprobe») checks both sides of the threshold for the
// test producer without changing the environment: it renders the page inside
// runWithPublicStatsMinViews(n, …). The override lives only in that async
// context, so a real request running at the same time keeps the real value.
const overrideStore = new AsyncLocalStorage<number>();

export function runWithPublicStatsMinViews<T>(minViews: number, fn: () => T): T {
  const n = Number.isSafeInteger(minViews) && minViews >= 0 ? minViews : PUBLIC_STATS_MIN_VIEWS_DEFAULT;
  return overrideStore.run(n, fn);
}

let cache = new WeakMap<object, Map<string, { value: number; at: number }>>();

/** Test hook: forget every cached count. */
export function __resetPublicStatsThresholdCacheForTesting(): void {
  cache = new WeakMap();
}

/** The owner's «Sett» over 12 months for this profile, cached per DB handle for PUBLIC_STATS_VIEWS_CACHE_MS. */
export function publicStatsHumanViews(db: Database.Database, agentId: string, path: string, nowMs: number = Date.now()): number {
  let m = cache.get(db);
  if (!m) { m = new Map(); cache.set(db, m); }
  const k = `${agentId}\u0000${path}`;
  const hit = m.get(k);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < PUBLIC_STATS_VIEWS_CACHE_MS) return hit.value;
  const value = getOwnerHumanViewsYear(db, agentId, path, nowMs);
  if (m.size >= CACHE_MAX_ENTRIES) m.clear();
  m.set(k, { value, at: nowMs });
  return value;
}

export interface PublicCountsGateOptions {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}

/**
 * May the public surfaces show this RFB profile's counts? `publicCounts` is
 * the owner's `stats.public_counts` choice from enforce.ts (null/undefined =
 * not enforced = on). A failed count hides the tiles (fail closed) and logs.
 */
export function publicCountsShown(
  db: Database.Database,
  agentId: string,
  path: string,
  publicCounts: boolean | null | undefined,
  opts: PublicCountsGateOptions = {},
): boolean {
  if (publicCounts === false) return false;
  const min = publicStatsMinViews(opts.env ?? process.env);
  if (min <= 0) return true;
  try {
    return publicStatsHumanViews(db, agentId, path, opts.nowMs ?? Date.now()) >= min;
  } catch (err) {
    console.error("[public-stats-threshold] count failed, hiding the public tiles:", err);
    return false;
  }
}

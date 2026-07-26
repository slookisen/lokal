// ─── Mapbox Directions monthly call cap ─────────────────────────────
// Daniel, 2026-07-26, after setting MAPBOX_ACCESS_TOKEN in prod:
//   «det er lagt til i fly. jeg fant ingen måte å sette pristak under billing.»
//
// He was right — there is no hard spending cap to find. Mapbox offers usage
// ALERTS (an email at a threshold), not a ceiling that stops traffic. The
// session had told him a cap was "the only hard guarantee against a leak
// getting expensive", which was wrong: no such control exists on their side.
//
// So the guarantee has to live here. This module is the ceiling that Mapbox
// does not provide.
//
// ── WHAT IT GUARANTEES, AND WHAT IT DOES NOT ────────────────────────
//
// Guarantees: this process will not issue more than MAPBOX_MONTHLY_CALL_CAP
// Directions requests in a calendar month (UTC), across restarts and deploys,
// because the counter is in the database rather than in memory. An in-memory
// counter would reset on every deploy, and we deploy several times a day — it
// would have been a cap in name only.
//
// Does NOT guarantee: that the bill is zero-risk. A leaked token used from
// somewhere OTHER than this process is not something this code can see. That
// exposure is real and unavoidable, because the token cannot be URL-restricted
// (our calls are server-side and carry no Referer, so a URL restriction would
// break them rather than protect them). What this bounds is OUR spend.
//
// ── WHY EXHAUSTION DEGRADES INSTEAD OF FAILING ──────────────────────
//
// When the cap is reached the corridor engine falls back to the straight-line
// provider, which already carries an honest note explaining that the ordering
// is real but the road is not. The alternative — returning `routing_failed` —
// would hand the visitor an error for a budget decision they had no part in.
// A degraded answer with the degradation stated is better than no answer.
//
// The note is DIFFERENT from the no-provider-configured one on purpose: "we
// have not set this up" and "we have used this month's allowance" are different
// facts, and an operator reading a screenshot should be able to tell which.
//
// ── COUNTING ────────────────────────────────────────────────────────
//
// Only cache MISSES are counted, because only they reach the network:
// getPreparedRoute() consults routeCache before calling fetchRoute(). That is
// also why the cap can be set far below the traffic it supports — «oslo til
// bodø», «Oslo→Bodø» and «fra oslo til bodo» share one cache entry once
// geocoding has resolved them to the same rounded endpoints.

import { getDb } from "../database/init";

/**
 * Default ceiling. Mapbox's free tier is 100 000 Directions requests per month;
 * this sits below it so the cap bites before the bill does, leaving room for
 * the gap between our counter and theirs (a request we count but that fails in
 * flight still costs us a token here and nothing there — we over-count rather
 * than under-count, deliberately).
 */
export const MAPBOX_MONTHLY_CAP_DEFAULT = 80_000;

/** Resolved from the environment on each call so a `fly secrets set` takes effect without a redeploy of this module's constants. */
export function resolveMapboxMonthlyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MAPBOX_MONTHLY_CALL_CAP || "").trim();
  if (!raw) return MAPBOX_MONTHLY_CAP_DEFAULT;
  const n = Number(raw);
  // A malformed cap must not silently mean "unlimited". Fall back to the
  // default and say so — this is the one setting whose failure mode is money.
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `[mapbox-budget] MAPBOX_MONTHLY_CALL_CAP=${JSON.stringify(raw)} is not a non-negative number — using the default ${MAPBOX_MONTHLY_CAP_DEFAULT}`,
    );
    return MAPBOX_MONTHLY_CAP_DEFAULT;
  }
  return Math.floor(n);
}

/** UTC calendar month key, e.g. "2026-07". */
export function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

let schemaReady = false;
function ensureSchema(db: any): void {
  if (schemaReady) return;
  db.exec(
    `CREATE TABLE IF NOT EXISTS mapbox_monthly_usage (
       month TEXT PRIMARY KEY,
       calls INTEGER NOT NULL DEFAULT 0
     )`,
  );
  schemaReady = true;
}

export type MapboxBudgetState = {
  month: string;
  used: number;
  cap: number;
  remaining: number;
  exhausted: boolean;
};

/** Read-only. Never increments — safe to call from a status endpoint. */
export function mapboxBudgetState(now: number = Date.now()): MapboxBudgetState {
  const db = getDb();
  ensureSchema(db);
  const month = monthKey(now);
  const cap = resolveMapboxMonthlyCap();
  const row = db.prepare(`SELECT calls FROM mapbox_monthly_usage WHERE month = ?`).get(month) as
    | { calls: number }
    | undefined;
  const used = row?.calls ?? 0;
  return { month, used, cap, remaining: Math.max(0, cap - used), exhausted: used >= cap };
}

/**
 * Charge ONE Directions request against this month's allowance.
 *
 * Returns false when the cap is already reached, and in that case increments
 * nothing — so a capped month cannot run the counter to absurd values and the
 * `used` figure stays a truthful record of requests actually issued.
 *
 * The read and the write are one statement, so two concurrent requests cannot
 * both see `used = cap - 1` and both proceed. SQLite serialises writes; the
 * conditional UPDATE is what makes that serialisation load-bearing rather than
 * incidental.
 */
export function tryConsumeMapboxCall(now: number = Date.now()): boolean {
  const db = getDb();
  ensureSchema(db);
  const month = monthKey(now);
  const cap = resolveMapboxMonthlyCap();

  if (cap <= 0) return false;

  db.prepare(`INSERT OR IGNORE INTO mapbox_monthly_usage (month, calls) VALUES (?, 0)`).run(month);
  const res = db
    .prepare(`UPDATE mapbox_monthly_usage SET calls = calls + 1 WHERE month = ? AND calls < ?`)
    .run(month, cap);

  const granted = res.changes > 0;
  if (!granted) {
    // Log once per exhausted call rather than once per month: the operator
    // needs to see this in the logs at the moment routes start degrading, not
    // buried in whichever request happened to cross the line.
    console.warn(
      `[mapbox-budget] monthly cap reached for ${month} (cap ${cap}) — falling back to straight-line routing`,
    );
  }
  return granted;
}

/** Test seam: forget the CREATE TABLE memo so a fresh in-memory DB gets one. */
export function __resetMapboxBudgetSchemaForTesting(): void {
  schemaReady = false;
}

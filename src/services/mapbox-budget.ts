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
// Nor does it survive horizontal scaling. The counter lives on the per-machine
// `lokal_data` volume (fly.toml), so the word "process" above is load-bearing:
// at `fly scale count 2` the effective ceiling becomes 2 × the cap. With the
// default that is 160 000 — ABOVE the 100 000 free tier. The 25 % headroom
// between default and free tier only covers one machine (review note N-e).
// Before scaling out, lower MAPBOX_MONTHLY_CALL_CAP to cap/N or move the
// counter to shared storage.
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

/**
 * Mapbox's free Directions allowance. Named so the default above can be
 * asserted AGAINST it rather than against itself — review B3 showed every
 * existing assertion compared the default to `MAPBOX_MONTHLY_CAP_DEFAULT`, so
 * raising it to 800 000 (above the free tier, i.e. a default that GUARANTEES a
 * bill) kept the whole suite green.
 */
export const MAPBOX_FREE_TIER_MONTHLY = 100_000;

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
  // REVIEW N7: no upper sanity check means a fat-fingered `fly secrets set`
  // ("1e12", "0x1F4") is accepted silently. We do not REFUSE it — an operator
  // may legitimately raise the cap on a paid plan — but a cap above the free
  // tier is worth one line in the log, because that is the moment the module
  // stops being a guarantee that the bill is zero.
  const cap = Math.floor(n);
  if (cap > MAPBOX_FREE_TIER_MONTHLY) {
    console.warn(
      `[mapbox-budget] cap ${cap} exceeds the Mapbox free tier (${MAPBOX_FREE_TIER_MONTHLY}) — routing may now incur charges`,
    );
  }
  return cap;
}

/** UTC calendar month key, e.g. "2026-07". */
export function monthKey(now: number): string {
  // Sliced from the ISO-8601 string rather than assembled from date methods.
  // REVIEW N5: the previous getUTCFullYear/getUTCMonth version had a
  // getFullYear/getMonth mutant that SURVIVED, because under the CI runner's
  // TZ=UTC the two are identical — the test could only have caught it by
  // forcing a timezone. toISOString() is UTC by definition, so the local-time
  // variant this module must never use no longer exists to be mutated into.
  // Removing the hazard beats testing around it.
  return new Date(now).toISOString().slice(0, 7);
}

// The table is declared in database/init.ts alongside places_api_call_log
// (review note N3). An earlier version created it lazily behind a module-level
// `schemaReady` memo, which was a live landmine in tests/test.ts: that memo was
// not keyed to the DB handle, so a block that swapped the singleton after this
// module had run got "no such table" (review note N4, reproduced). Declaring it
// with the rest of the schema removes the memo, the reset seam, and the hazard.

/** Month whose exhaustion has already been logged — see REVIEW N1. */
let lastWarnedMonth: string | null = null;

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
  const month = monthKey(now);
  const cap = resolveMapboxMonthlyCap();
  const row = db.prepare(`SELECT calls FROM mapbox_monthly_usage WHERE month = ?`).get(month) as
    | { calls: number }
    | undefined;
  const used = row?.calls ?? 0;
  // The Math.max clamp is unreachable while tryConsumeMapboxCall is the only
  // writer (its conditional UPDATE cannot push `used` past `cap`). It is kept
  // for the day something else writes this table, and is recorded here as an
  // ACCEPTED surviving mutant rather than left looking like tested behaviour.
  return { month, used, cap, remaining: Math.max(0, cap - used), exhausted: used >= cap };
}

/**
 * Charge ONE Directions request against this month's allowance.
 *
 * Returns false when the cap is already reached, and in that case increments
 * nothing — so a capped month cannot run the counter to absurd values and the
 * `used` figure stays a truthful record of requests actually issued.
 *
 * The read and the write are one statement, so two callers cannot both see
 * `used = cap - 1` and both proceed.
 *
 * REVIEW N-c — an honest correction to what that buys us TODAY. A reviewer
 * replaced this with a non-atomic read-then-write and all 263 deterministic
 * tests stayed green, because in this deployment the two are genuinely
 * equivalent: `better-sqlite3` is synchronous and Node is single-threaded, so
 * two `tryConsumeMapboxCall` calls in one process cannot interleave and the
 * TOCTOU window never opens. The conditional UPDATE only becomes load-bearing
 * when a SECOND process opens the same file — a maintenance script, `fly ssh
 * console`, a future worker. It is defence-in-depth that costs nothing, not a
 * guarantee Node's execution model wasn't already providing. Kept deliberately;
 * no test distinguishes the two, and a contrived one would prove nothing.
 */
export function tryConsumeMapboxCall(now: number = Date.now()): boolean {
  const db = getDb();
  const month = monthKey(now);
  const cap = resolveMapboxMonthlyCap();

  if (cap <= 0) return false;

  db.prepare(`INSERT OR IGNORE INTO mapbox_monthly_usage (month, calls) VALUES (?, 0)`).run(month);
  const res = db
    .prepare(`UPDATE mapbox_monthly_usage SET calls = calls + 1 WHERE month = ? AND calls < ?`)
    .run(month, cap);

  const granted = res.changes > 0;
  if (!granted && lastWarnedMonth !== month) {
    // REVIEW N1: log the TRANSITION, not every subsequent call. The earlier
    // version warned once per refusal, and once the cap bites the degraded
    // path is the FAST path — a reviewer's 5000-refusal probe emitted 4950
    // lines. At 300 req/15 min/IP that is ~28 800 lines/day from one IP, on a
    // machine that also serves finn-tannlege.com and opplevagent.no. The
    // operator's need is met by knowing WHEN routing started degrading.
    lastWarnedMonth = month;
    console.warn(
      `[mapbox-budget] monthly cap reached for ${month} (cap ${cap}) — falling back to straight-line routing until the month rolls over`,
    );
  }
  return granted;
}

/**
 * Retained as a no-op so existing callers keep compiling. The memo it used to
 * clear is gone — see the note above `mapboxBudgetState`.
 */
export function __resetMapboxBudgetSchemaForTesting(): void {
  /* schema now lives in initSchema; nothing to reset */
}

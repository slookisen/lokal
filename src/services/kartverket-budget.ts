// ─── Shared Kartverket request budget ───────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a
// throughput follow-up (Daniel, 2026-07-25: «Det ser ut som veldig mange
// fortsatt står med ukjent opphav. Vi burde lage en pr som forbedrer og fikser
// dette.»).
//
// WHY THIS MODULE EXISTS
// ──────────────────────
// agents-postal-backfill.ts shipped a 2 req/s token bucket, with this note in
// its own header:
//
//     "NOT YET SHARED with the geocode worker … Hoisting kartverketQuery onto
//      this bucket is the right follow-up."
//
// That follow-up became load-bearing the moment the geocode worker's cadence
// went from hourly to a backlog-driven 60 s (agents-geocode-worker.ts): a
// per-worker bucket bounds each worker but not their SUM, and the two RFB
// backfill workers now run against the same free CC BY 4.0 API at the same
// time, on purpose. One process-wide budget is the only thing that can state a
// ceiling for RFB's backfill traffic as a whole.
//
// WHAT IT DOES AND DOES NOT COVER
// ───────────────────────────────
// Covers: every Kartverket request made by the two RFB *backfill* workers —
// the adresser/v1/sok probes (postal backfill), the adresser/v1/sok retry
// ladder inside geocodeOne() when the geocode worker calls it (the worker
// hands geocodeOne a budgeted fetch, so all four ladder steps draw tokens),
// and the geocode worker's stedsnavn/kommuneinfo centroid lookups.
//
// Does NOT cover: user-facing geocoding on the search hot path, nor the dental
// and experiences geocode workers. Those go through
// dental-geocode-worker.kartverketQuery() / geocoding-service directly with no
// sleep seam, and wiring a real timer into three other suites is a bigger blast
// radius than this slice should take. They are also low-volume and unchanged by
// this slice. So the honest claim is: **RFB backfill traffic is bounded at
// KARTVERKET_MAX_RPS process-wide**, not "all Kartverket traffic is".
//
// SHAPE
// ─────
// A fixed-window token bucket, waiting through an INJECTED sleep so tests
// (which pass a no-op sleep) never get slower and never depend on wall clock.
// A fixed window admits at most 2·MAX requests in one sliding second at a
// window boundary; at MAX = 2 that worst case is 4 requests in a sliding
// second, which is still courteous for an unauthenticated public API and is
// stated here rather than hidden.

/** Hard ceiling on Kartverket requests per second across RFB's backfill workers. */
export const KARTVERKET_MAX_RPS = 2;

type Sleep = (ms: number) => Promise<void>;

const state = { windowStart: 0, used: 0 };

/**
 * Consume `cost` request slots, waiting if the current window is exhausted.
 *
 * `cost` > 1 is for call sites that cannot route their HTTP through a wrapped
 * fetch and therefore have to RESERVE their worst case up front (the centroid
 * lookups go through geocoding-service's module-level fetch). Reserving the
 * worst case can only make us slower than reality, never faster — which is the
 * correct direction for a courtesy limit.
 */
export async function takeKartverketBudget(sleep: Sleep, cost: number = 1): Promise<void> {
  const n = Math.max(1, Math.floor(cost));
  for (let i = 0; i < n; i++) {
    const now = Date.now();
    if (now - state.windowStart >= 1000) {
      state.windowStart = now;
      state.used = 0;
    }
    if (state.used >= KARTVERKET_MAX_RPS) {
      const wait = Math.max(0, 1000 - (now - state.windowStart));
      await sleep(wait);
      state.windowStart = Date.now();
      state.used = 0;
    }
    state.used++;
  }
}

/**
 * Wrap a fetch so EVERY request it makes draws a token first.
 *
 * This is how the geocode worker bounds geocodeOne(): that function runs a
 * 4-step retry ladder internally and there is no way to know from outside how
 * many requests a given row will cost. Wrapping the injected `fetchImpl` — the
 * one seam every step goes through — makes the accounting exact instead of
 * estimated.
 */
export function budgetedFetch(base: typeof fetch, sleep: Sleep): typeof fetch {
  return (async (input: any, init?: any) => {
    await takeKartverketBudget(sleep, 1);
    return base(input, init);
  }) as unknown as typeof fetch;
}

/** Test seam: forget the current window so suites cannot leak budget into each other. */
export function __resetKartverketBudgetForTesting(): void {
  state.windowStart = 0;
  state.used = 0;
}

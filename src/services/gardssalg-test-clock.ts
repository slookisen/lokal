// Test-only clock for the gårdssalg attendance gate (dev-request
// 2026-11-12-opplevagent-o1-trygg-aa-aapne, slice O1-7).
//
// «Møtte» / «Ikke møtt» only open after the visit time (visitTimeReached() in
// booking-store). To try them without waiting, a test can move "now" forward:
//   - __setGardssalgTestNow("2026-12-01T12:00:00.000Z") from test code, or
//   - GARDSSALG_TEST_NOW=<ISO instant> in the environment.
// The in-process setter wins over the env var.
//
// Never in production: with NODE_ENV=production, or on Fly (FLY_APP_NAME set),
// gardssalgNow() is always the real time, whatever the override says (same
// rule as mayReturnDevClaimCode() in routes/marketplace.ts). An override that
// is not an ISO date/time is ignored (real time).

let testNowOverride: string | null = null;

/** Test hook: set (or clear with null) the in-process override. */
export function __setGardssalgTestNow(iso: string | null): void {
  testNowOverride = iso;
}

/** May an override apply at all? Only off production and off Fly. */
export function gardssalgTestClockAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && !(env.FLY_APP_NAME ?? "").trim();
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** "Now" for the attendance time gate: real time unless a test override applies. */
export function gardssalgNow(env: NodeJS.ProcessEnv = process.env): Date {
  if (!gardssalgTestClockAllowed(env)) return new Date();
  const raw = (testNowOverride ?? env.GARDSSALG_TEST_NOW ?? "").trim();
  if (!raw || !ISO_INSTANT.test(raw)) return new Date();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : new Date();
}

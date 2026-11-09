/**
 * owner-session-sliding.ts — the switch and the cap of the RFB owner session
 * that is renewed by use (A2A dev-request 2026-11-09-rfb-eierokt-fornyes-ved-
 * bruk). Only the settings live here; the renewal itself is that dev-request's
 * own slice. Tekstpakke C punkt 5 (approved 2026-11-09) reads them for the
 * extra sentence of the owner login e-mail.
 *
 *   OWNER_SESSION_SLIDING_ENABLED : «1»/«true» = on; default off; read per call.
 *   OWNER_SESSION_MAX_DAYS        : the hard cap in days (default 90).
 */

export function isOwnerSessionSlidingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_SESSION_SLIDING_ENABLED === "1" || env.OWNER_SESSION_SLIDING_ENABLED === "true";
}

export function ownerSessionMaxDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNER_SESSION_MAX_DAYS);
  return Number.isInteger(n) && n > 0 ? n : 90;
}

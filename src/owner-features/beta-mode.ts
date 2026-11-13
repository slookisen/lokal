// ─── Owner beta: main flag and cap ──────────────────────────────────────────
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S2
// («Tabell, hovedflagg, tak og admin-tall»). PURE env readers, read per call.
//
// OWNER_BETA_MODE: exactly one of
//   off    (default; also unset, "" and any unknown value) — beta rows are
//          ignored, `beta` tier = the pilot list only (today's behaviour)
//   offer  owners may opt in within the cap; `beta` tier = pilot list OR an
//          `active` owner_beta_enrollment row (vertical rfb only)
//   all    graduation: every `beta`-tier feature is treated as `ga` (except
//          product_import_outreach, see feature-tiers.ts); beta rows untouched
// Exact match only, like ownerFlagMode (owner-flag-mode.ts): no trimming, no
// case folding. An unknown value is logged once and means `off`.
//
// OWNER_BETA_CAP: how many `active` beta owners there may be. Unset → 25.
// Any other value that is not a plain decimal integer (digits only) → 0, i.e.
// no new enrollments (owners already in keep their access).

export const OWNER_BETA_MODE_ENV = "OWNER_BETA_MODE";
export const OWNER_BETA_CAP_ENV = "OWNER_BETA_CAP";
export const OWNER_BETA_CAP_DEFAULT = 25;

export type OwnerBetaMode = "off" | "offer" | "all";
export const OWNER_BETA_MODE_VALUES: readonly OwnerBetaMode[] = ["off", "offer", "all"];

const loggedOnce = new Set<string>();
function logOnce(msg: string): void {
  if (loggedOnce.has(msg)) return;
  loggedOnce.add(msg);
  console.warn(`[owner-beta] ${msg}`);
}

/** Test hook: forget which warnings were already logged. */
export function __resetBetaModeLogForTesting(): void {
  loggedOnce.clear();
}

/** The main beta flag. Unset / "" → off silently; an unknown value → off, logged once. */
export function ownerBetaMode(env: NodeJS.ProcessEnv = process.env): OwnerBetaMode {
  const v = env[OWNER_BETA_MODE_ENV];
  if (v === undefined || v === "") return "off";
  if (v === "off" || v === "offer" || v === "all") return v;
  logOnce(`ignored unknown ${OWNER_BETA_MODE_ENV} ${JSON.stringify(v)}; beta is off`);
  return "off";
}

/** The beta cap. Unset → 25; anything but a plain decimal integer → 0. */
export function ownerBetaCap(env: NodeJS.ProcessEnv = process.env): number {
  const v = env[OWNER_BETA_CAP_ENV];
  if (v === undefined) return OWNER_BETA_CAP_DEFAULT;
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) {
    logOnce(`invalid ${OWNER_BETA_CAP_ENV} ${JSON.stringify(v)}; cap is 0`);
    return 0;
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    logOnce(`invalid ${OWNER_BETA_CAP_ENV} ${JSON.stringify(v)}; cap is 0`);
    return 0;
  }
  return n;
}

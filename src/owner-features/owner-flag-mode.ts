// ─── Owner feature flags with a `pilot` mode ────────────────────────────────
// dev-request 2026-11-05-eierflagg-koblet-til-pilotlisten. Four owner flags
// (PRODUCT_IMPORT_ENABLED, OWNER_ORDER_EMAIL_ENABLED,
// OWNER_UNIFIED_SESSION_ENABLED, PRODUCT_IMPORT_OUTREACH_ENABLED) read one of
// three modes, per request:
//   "1" / "true"   → all    on for every verified owner (as before)
//   "pilot"        → pilot  on only for owners in OWNER_FEATURES_ALLOWED_SUBJECTS
//                           as `rfb:<agentId>` (owner-features/allowlist.ts)
//   anything else  → off    (unset, "", "0", "Pilot", "pilot ", "yes", …)
// `pilot` matches exactly — no trimming, no case folding (fail closed).
// Where a call site has no agent id, pilot counts as off.

import { isSubjectAllowedForOwnerFeatures } from "./allowlist";

export type OwnerFlagMode = "off" | "pilot" | "all";

/** The four owner flags that accept `pilot`. */
export const OWNER_PILOT_FLAGS = [
  "PRODUCT_IMPORT_ENABLED",
  "OWNER_ORDER_EMAIL_ENABLED",
  "OWNER_UNIFIED_SESSION_ENABLED",
  "PRODUCT_IMPORT_OUTREACH_ENABLED",
] as const;
export type OwnerPilotFlag = (typeof OWNER_PILOT_FLAGS)[number];

/** PURE: the mode of one owner flag. */
export function ownerFlagMode(name: string, env: NodeJS.ProcessEnv = process.env): OwnerFlagMode {
  const v = env[name];
  if (v === "1" || v === "true") return "all";
  if (v === "pilot") return "pilot";
  return "off";
}

/**
 * The flag is on for this owner: all → true; pilot → the owner is on the
 * owner-features allowlist (`rfb:<agentId>`); off → false. No agent id = off
 * in pilot mode.
 */
export function ownerFlagEnabledFor(
  name: string,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = ownerFlagMode(name, env);
  if (mode === "all") return true;
  if (mode === "pilot") return !!agentId && isSubjectAllowedForOwnerFeatures("rfb", agentId, env);
  return false;
}

/** The mode of every pilot-capable owner flag (switch probe report). */
export function ownerPilotFlagModes(env: NodeJS.ProcessEnv = process.env): Record<OwnerPilotFlag, OwnerFlagMode> {
  const out = {} as Record<OwnerPilotFlag, OwnerFlagMode>;
  for (const k of OWNER_PILOT_FLAGS) out[k] = ownerFlagMode(k, env);
  return out;
}

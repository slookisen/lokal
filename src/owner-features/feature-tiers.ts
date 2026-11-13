// ─── Owner feature tiers: pilot | beta | ga ─────────────────────────────────
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S1
// («Register og sentralt kall»).
//
// Every owner feature that is gated on the owner-features pilot list
// (OWNER_FEATURES_ALLOWED_SUBJECTS, owner-features/allowlist.ts) has a key in
// OWNER_FEATURE_TIER_REGISTRY and one tier:
//   pilot  only owners on the pilot list (as before)
//   beta   the pilot list OR owners enrolled in the beta (S1: no enrollment
//          table yet — the lookup is a stub that always says «not enrolled»,
//          so beta behaves exactly like pilot)
//   ga     every owner of the profile (the caller keeps its own
//          verified-owner check, as today)
// The code default is `pilot` for all. Env OWNER_FEATURE_TIERS
// (e.g. `dashboard=beta,product_import=ga`) overrides per feature, read per
// call. Parsing matches exactly, like ownerFlagMode (owner-flag-mode.ts): no
// trimming, no case folding. An unknown key or value is ignored and logged
// once; the feature stays `pilot`.
//
// Only vertical `rfb` can get `beta` or `ga`. Every other vertical (gårdssalg,
// dental, …) keeps the pilot list, exactly as today.
//
// The feature's own flag still applies first (the call sites check it before
// calling here): flag off → off whatever the tier; flag `pilot` → this tier
// logic; flag `1` → on for everyone as today.
//
// ownerFeatureAccess never throws: any error means «not allowed».

import { isSubjectAllowedForOwnerFeatures } from "./allowlist";

export const OWNER_FEATURE_TIERS_ENV = "OWNER_FEATURE_TIERS";

export type OwnerFeatureTier = "pilot" | "beta" | "ga";
export const OWNER_FEATURE_TIER_VALUES: readonly OwnerFeatureTier[] = ["pilot", "beta", "ga"];

/** The only vertical that can get `beta` or `ga`. */
export const OWNER_FEATURE_TIER_VERTICAL = "rfb";

/**
 * Every pilot-list-gated owner feature, with its code default tier (all
 * `pilot`) and where it is gated. A call site passes one of these keys.
 */
export const OWNER_FEATURE_TIER_REGISTRY = {
  dashboard: { defaultTier: "pilot", gate: "owner-ui/shell.ts ownerDashboardActiveFor (OWNER_DASHBOARD_ENABLED)" },
  mine_valg: { defaultTier: "pilot", gate: "routes/owner-features.ts gate/pageGate; routes/owner-portal.ts «Mine valg» card + weekly-sync nudge" },
  owner_theme: { defaultTier: "pilot", gate: "routes/owner-portal.ts + routes/owner-orders.ts shared owner theme (T6)" },
  orders: { defaultTier: "pilot", gate: "services/order-actions.ts t12OrderActionsActive (T12 cancellation + overview)" },
  orderability: { defaultTier: "pilot", gate: "services/owner-orderability.ts ownerOrderabilityPortalEnabledFor (OWNER_ORDERABILITY_PORTAL_ENABLED)" },
  product_import: { defaultTier: "pilot", gate: "owner-flag-mode.ts PRODUCT_IMPORT_ENABLED=pilot" },
  product_import_outreach: { defaultTier: "pilot", gate: "owner-flag-mode.ts PRODUCT_IMPORT_OUTREACH_ENABLED=pilot" },
  order_email: { defaultTier: "pilot", gate: "owner-flag-mode.ts OWNER_ORDER_EMAIL_ENABLED=pilot" },
  unified_session: { defaultTier: "pilot", gate: "owner-flag-mode.ts OWNER_UNIFIED_SESSION_ENABLED=pilot" },
  stock_check: { defaultTier: "pilot", gate: "services/stock-check-reminder.ts stockCheckAllowlisted" },
  stock_soft_expiry: { defaultTier: "pilot", gate: "services/stock-soft-expiry.ts stockSoftExpiryActiveFor (STOCK_SOFT_EXPIRY_ENABLED)" },
} as const satisfies Record<string, { defaultTier: OwnerFeatureTier; gate: string }>;

export type OwnerFeatureKey = keyof typeof OWNER_FEATURE_TIER_REGISTRY;
export const OWNER_FEATURE_KEYS = Object.keys(OWNER_FEATURE_TIER_REGISTRY) as OwnerFeatureKey[];

export function isOwnerFeatureKey(k: string): k is OwnerFeatureKey {
  return Object.prototype.hasOwnProperty.call(OWNER_FEATURE_TIER_REGISTRY, k);
}

/** The pilot-capable owner flags (owner-flag-mode.ts) → their feature key. */
export const OWNER_PILOT_FLAG_FEATURE: Readonly<Record<string, OwnerFeatureKey>> = {
  PRODUCT_IMPORT_ENABLED: "product_import",
  PRODUCT_IMPORT_OUTREACH_ENABLED: "product_import_outreach",
  OWNER_ORDER_EMAIL_ENABLED: "order_email",
  OWNER_UNIFIED_SESSION_ENABLED: "unified_session",
};

// ── Logging: each ignored entry once per process ────────────────────────────
const loggedOnce = new Set<string>();
function logOnce(msg: string): void {
  if (loggedOnce.has(msg)) return;
  loggedOnce.add(msg);
  console.warn(`[owner-feature-tiers] ${msg}`);
}

/** Test hook: forget which warnings were already logged. */
export function __resetFeatureTierLogForTesting(): void {
  loggedOnce.clear();
}

/**
 * PURE (apart from the one-time log): the tier of every registry key.
 * `OWNER_FEATURE_TIERS` = comma-separated `<key>=<tier>`; exact match on both
 * sides. Unknown key, unknown tier, a malformed entry, or the same key given
 * two different tiers → ignored (logged once); the key keeps its default.
 */
export function parseOwnerFeatureTiers(env: NodeJS.ProcessEnv = process.env): Record<OwnerFeatureKey, OwnerFeatureTier> {
  const out = {} as Record<OwnerFeatureKey, OwnerFeatureTier>;
  for (const k of OWNER_FEATURE_KEYS) out[k] = OWNER_FEATURE_TIER_REGISTRY[k].defaultTier;
  const raw = env[OWNER_FEATURE_TIERS_ENV];
  if (typeof raw !== "string" || raw === "") return out;

  const seen = new Map<OwnerFeatureKey, OwnerFeatureTier>();
  const conflicted = new Set<OwnerFeatureKey>();
  for (const entry of raw.split(",")) {
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq < 0) { logOnce(`ignored malformed ${OWNER_FEATURE_TIERS_ENV} entry ${JSON.stringify(entry)}`); continue; }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!isOwnerFeatureKey(key)) { logOnce(`ignored unknown feature key ${JSON.stringify(key)} in ${OWNER_FEATURE_TIERS_ENV}`); continue; }
    if (!(OWNER_FEATURE_TIER_VALUES as readonly string[]).includes(value)) {
      logOnce(`ignored unknown tier ${JSON.stringify(value)} for ${key} in ${OWNER_FEATURE_TIERS_ENV}; ${key} stays pilot`);
      continue;
    }
    const prev = seen.get(key);
    if (prev !== undefined && prev !== value) conflicted.add(key);
    seen.set(key, value as OwnerFeatureTier);
  }
  for (const [key, tier] of seen) {
    if (conflicted.has(key)) {
      logOnce(`conflicting tiers for ${key} in ${OWNER_FEATURE_TIERS_ENV}; ${key} stays pilot`);
      continue;
    }
    out[key] = tier;
  }
  return out;
}

/** The tier of one feature (unknown key → pilot, logged once). */
export function ownerFeatureTier(feature: string, env: NodeJS.ProcessEnv = process.env): OwnerFeatureTier {
  if (!isOwnerFeatureKey(feature)) {
    logOnce(`unknown owner feature ${JSON.stringify(feature)} asked for; treated as pilot`);
    return "pilot";
  }
  return parseOwnerFeatureTiers(env)[feature];
}

// ── Beta enrollment (S1 stub) ───────────────────────────────────────────────
// S2 adds the enrollment table and replaces this lookup. Until then nobody is
// enrolled, so `beta` resolves to the pilot list only.
export type BetaEnrollmentLookup = (vertical: string, agentId: string, env: NodeJS.ProcessEnv) => boolean;

const S1_NO_ENROLLMENT: BetaEnrollmentLookup = () => false;
let betaEnrollmentLookup: BetaEnrollmentLookup = S1_NO_ENROLLMENT;

/** Test hook: swap the enrollment lookup (null = the S1 stub). */
export function __setBetaEnrollmentLookupForTesting(fn: BetaEnrollmentLookup | null): void {
  betaEnrollmentLookup = fn ?? S1_NO_ENROLLMENT;
}

export type OwnerFeatureAccessSource = OwnerFeatureTier | null;
export interface OwnerFeatureAccess {
  allowed: boolean;
  source: OwnerFeatureAccessSource;
}

const DENIED: OwnerFeatureAccess = Object.freeze({ allowed: false, source: null }) as OwnerFeatureAccess;

/**
 * The one gate for every pilot-list owner feature. The caller checks the
 * feature's own flag first (and, as today, a verified owner where it did).
 *   - on the pilot list (`<vertical>:<agentId>`) → allowed, source `pilot`
 *   - vertical ≠ rfb → nothing more (today's behaviour)
 *   - tier `ga` → allowed, source `ga`
 *   - tier `beta` and enrolled → allowed, source `beta` (S1: never enrolled)
 *   - otherwise / any error → not allowed, source null
 */
export function ownerFeatureAccess(
  feature: OwnerFeatureKey | string,
  vertical: string,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OwnerFeatureAccess {
  try {
    if (!vertical || !agentId) return DENIED;
    if (isSubjectAllowedForOwnerFeatures(vertical, agentId, env)) return { allowed: true, source: "pilot" };
    if (vertical !== OWNER_FEATURE_TIER_VERTICAL) return DENIED;
    const tier = ownerFeatureTier(feature, env);
    if (tier === "ga") return { allowed: true, source: "ga" };
    if (tier === "beta" && betaEnrollmentLookup(vertical, agentId, env) === true) return { allowed: true, source: "beta" };
    return DENIED;
  } catch (err) {
    try { console.error(`[owner-feature-tiers] access check failed for ${String(feature)}, denying:`, (err as any)?.message ?? "error"); } catch { /* never throw */ }
    return DENIED;
  }
}

/** Boolean form of ownerFeatureAccess. */
export function ownerFeatureAllowed(
  feature: OwnerFeatureKey,
  vertical: string,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ownerFeatureAccess(feature, vertical, agentId, env).allowed;
}

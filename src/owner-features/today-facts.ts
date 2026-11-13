// ─── today-facts.ts — what an RFB owner has TODAY ───────────────────────────
// A2A dev-request 2026-10-22-rfb-for-produsenter-faq-side, «Endringer fra
// eierportal-testrunde 1» (the facts module moves here so the FAQ and
// «Planlagt» read one source) and «Endringer fra Daniel 08.11», slice F2a.
//
// Numbers the public /for-produsenter page quotes, read from the same
// configuration the code uses, plus one of three states per pilot-capable
// function:
//   for_alle  the function is on for every verified owner
//             (flag on and owner mode «1»/«true», no allowlist in the gate);
//   i_pilot   on, but only for subjects on OWNER_FEATURES_ALLOWED_SUBJECTS
//             (owner mode «pilot», or a gate that always ANDs the allowlist
//             — as owner-portal.ts / owner-orders.ts / order-actions.ts do);
//   planlagt  off for everyone (flag off, or an allowlist gate with nobody
//             on the RFB allowlist).
// The raw env flag alone is never enough (F1 review N2): a function whose
// code checks the allowlist is never called «for alle».
//
// Each gate below mirrors the per-owner predicate the code uses; the test
// (today-facts.test.ts) checks every state against that predicate for an
// allowlisted and a non-allowlisted id, so the table cannot drift silently.

import { OWNER_PILOT_FLAG_FEATURE, ownerFeatureEffectiveTier, rfbPilotIds, type OwnerFeatureKey as TierFeatureKey } from "./feature-tiers";
import { ownerBetaMode } from "./beta-mode";
import { ownerFlagMode, type OwnerFlagMode } from "./owner-flag-mode";
import { ownerAutoUpdatesEnabled } from "./registry";
import type { OrderLimitsConfig } from "./order-texts";
import { orderReminderHours, orderAutocancelHours } from "../services/order-followups";
import { orderCapNewPerDay, orderCapOpenPerBuyer, orderCapNewPerBuyerPerDay, orderCapProducerCeilingPerDay } from "../services/cart-service";
import { isOrderAutocompleteEnabled } from "../services/order-lifecycle";
import { publicStatsMinViews } from "../services/public-stats-threshold";
import { getSupplyGraphStaleDays, getSupplyGraphHardStaleDays } from "../services/supply-graph";
import { isBuyerReceiptsEnabled } from "../services/order-receipt-service";
import { ownerOrderabilityPortalEnabled } from "../services/owner-orderability";
import { isStockCheckEmailEnabled } from "../services/stock-check-reminder";
import { stockSoftExpiryEnabled } from "../services/stock-soft-expiry";
import { isOrderCapV2Enabled } from "../services/order-cap-notice";
import { ownerPauseEnabled } from "../services/agent-visibility";

export type PilotState = "for_alle" | "i_pilot" | "planlagt";

/** The pilot-capable functions the page describes (dev-request F2a, «Gjelder minst»). */
export const PILOT_FEATURE_KEYS = ["mine_valg", "varer", "kanseller", "lagerpaminnelse", "myk_utlop"] as const;
export type PilotFeatureKey = (typeof PILOT_FEATURE_KEYS)[number];

export interface PilotGate {
  /** Where the real gate lives (for the reader of this table). */
  source: string;
  /** The function's switch: "all" = on for everyone it applies to, "pilot" = allowlist only, "off". */
  mode: (env: NodeJS.ProcessEnv) => OwnerFlagMode;
  /** The code ANDs the owner-features allowlist whatever the switch says (no «for alle» from the switch alone). */
  allowlistAlways: boolean;
  /** beta-for-alle S2: the feature-tiers key whose tier (pilot | beta | ga) widens the allowlist. */
  tierFeature?: TierFeatureKey;
}

const boolMode = (on: (env: NodeJS.ProcessEnv) => boolean) => (env: NodeJS.ProcessEnv): OwnerFlagMode => (on(env) ? "all" : "off");
const noSwitch = (): OwnerFlagMode => "all";

/** One row per function: the same switch and allowlist rule as the code that serves it. */
export const PILOT_FEATURE_GATES: Record<PilotFeatureKey, PilotGate> = {
  // routes/owner-features.ts gate(): «Mine valg» 404s off the allowlist; no env switch.
  mine_valg: { source: "routes/owner-features.ts gate() — isSubjectAllowedForOwnerFeatures", mode: noSwitch, allowlistAlways: true, tierFeature: "mine_valg" },
  // routes/owner-portal.ts: the «Varer» card (T13 V1a) under ownerOrderabilityPortalEnabledFor.
  varer: { source: "services/owner-orderability.ts ownerOrderabilityPortalEnabledFor (OWNER_ORDERABILITY_PORTAL_ENABLED + allowlist)", mode: boolMode(ownerOrderabilityPortalEnabled), allowlistAlways: true, tierFeature: "orderability" },
  // T12: «Kanseller bestillingen» in «Mine ordrer» and the e-mail order page.
  kanseller: { source: "services/order-actions.ts t12OrderActionsActive — allowlist", mode: noSwitch, allowlistAlways: true, tierFeature: "orders" },
  // B2: the job selects only allowlisted producers (stock-check-reminder.ts allowlistedRfbIds).
  lagerpaminnelse: { source: "services/stock-check-reminder.ts (STOCK_CHECK_EMAIL_ENABLED + allowlist)", mode: boolMode(isStockCheckEmailEnabled), allowlistAlways: true, tierFeature: "stock_check" },
  // B2b-1: soft stock expiry.
  myk_utlop: { source: "services/stock-soft-expiry.ts stockSoftExpiryActiveFor (STOCK_SOFT_EXPIRY_ENABLED + allowlist)", mode: boolMode(stockSoftExpiryEnabled), allowlistAlways: true, tierFeature: "stock_soft_expiry" },
};

/** At least one RFB subject on OWNER_FEATURES_ALLOWED_SUBJECTS (`rfb:<id>`). */
export function rfbPilotHasMembers(env: NodeJS.ProcessEnv = process.env): boolean {
  return rfbPilotIds(env).length > 0;
}

/** PURE: the state of one function under `env`. */
export function pilotFeatureState(gate: PilotGate, env: NodeJS.ProcessEnv = process.env): PilotState {
  const mode = gate.mode(env);
  if (mode === "off") return "planlagt";
  if (mode === "all" && !gate.allowlistAlways) return "for_alle";
  // beta-for-alle S2: the tier widens the allowlist like the gate does
  // (feature-tiers.ts ownerFeatureAccess). Default tier pilot → as before.
  const tier = gate.tierFeature ? ownerFeatureEffectiveTier(gate.tierFeature, env) : "pilot";
  if (tier === "ga") return "for_alle";
  if (tier === "beta" && ownerBetaMode(env) === "offer") return "i_pilot";
  return rfbPilotHasMembers(env) ? "i_pilot" : "planlagt";
}

/** A gate for a pilot-capable owner flag (owner-flag-mode.ts: «1»/«true» = all, «pilot» = allowlist). */
export function ownerModeGate(flag: string, source = flag): PilotGate {
  return { source, mode: (env) => ownerFlagMode(flag, env), allowlistAlways: false, tierFeature: OWNER_PILOT_FLAG_FEATURE[flag] };
}

export function currentPilotStates(env: NodeJS.ProcessEnv = process.env): Record<PilotFeatureKey, PilotState> {
  const out = {} as Record<PilotFeatureKey, PilotState>;
  for (const k of PILOT_FEATURE_KEYS) out[k] = pilotFeatureState(PILOT_FEATURE_GATES[k], env);
  return out;
}

/** Numbers and switches the text quotes, read from the same configuration the code uses. */
export interface ForProdusenterFacts {
  reminderHours: number;
  autocancelHours: number;
  /** ORDER_CAP_NEW_PER_PRODUCER_PER_DAY: the old (B4) daily cap, quoted while ORDER_CAP_V2_ENABLED is off. */
  dailyCap: number;
  /** ORDER_CAP_V2_ENABLED: the T11 limits (per buyer + platform ceiling) are in force. */
  orderCapV2On: boolean;
  /** The T11 limits (cart-service ORDER_CAP_* readers), quoted only while orderCapV2On. */
  orderLimits: OrderLimitsConfig;
  autocompleteOn: boolean;
  publicStatsMinViews: number;
  stockValidDays: number;
  /** SUPPLY_GRAPH_HARD_STALE_DAYS: how long a stale stock status stays orderable with soft expiry. */
  stockHardDays: number;
  /** ORDER_BUYER_RECEIPTS_ENABLED: the buyer is told when an order is cancelled. */
  buyerReceiptsOn: boolean;
  /** OWNER_PAUSE_ENABLED: the portal's «Pause og sletting» card (for owners without «Mine valg»). */
  ownerPauseOn: boolean;
  /** OWNER_AUTO_UPDATES_ENABLED: auto.updates is a live choice (dev-request 2026-11-01-rfb-hold-profilen-oppdatert). */
  autoUpdatesOn?: boolean;
  /** The state of each pilot-capable function. */
  pilot: Record<PilotFeatureKey, PilotState>;
}

export function currentForProdusenterFacts(env: NodeJS.ProcessEnv = process.env): ForProdusenterFacts {
  return {
    reminderHours: orderReminderHours(env),
    autocancelHours: orderAutocancelHours(env),
    dailyCap: orderCapNewPerDay(),
    orderCapV2On: isOrderCapV2Enabled(env),
    orderLimits: {
      openPerBuyer: orderCapOpenPerBuyer(),
      perBuyerPerDay: orderCapNewPerBuyerPerDay(),
      producerCeilingPerDay: orderCapProducerCeilingPerDay(),
    },
    autocompleteOn: isOrderAutocompleteEnabled(),
    publicStatsMinViews: publicStatsMinViews(),
    stockValidDays: getSupplyGraphStaleDays(),
    stockHardDays: getSupplyGraphHardStaleDays(),
    buyerReceiptsOn: isBuyerReceiptsEnabled(),
    ownerPauseOn: ownerPauseEnabled(),
    autoUpdatesOn: ownerAutoUpdatesEnabled(),
    pilot: currentPilotStates(env),
  };
}

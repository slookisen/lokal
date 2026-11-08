// ─── Owner portal: data for the «Oversikt» block and the menu badges (T15b) ─
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 9, slice T15b.
//
// Data gathering only — the rendering is owner-ui/overview.ts. Every value is
// read from the source the owner pages already use; nothing is counted or
// derived anew:
//
//   pending orders     countPendingOrders() — the portal's «Mine ordrer»
//                      entry card count (orders.status = 'pending'); the
//                      portal itself now reads it through this function.
//   items to confirm   the T13 «Varer» card's «Trenger handling» rows:
//                      readOwnerItems() + ownerItemView(), group
//                      "needs_action" — only while that card is shown
//                      (ownerOrderabilityPortalEnabledFor), since the badge
//                      and the row link to it.
//   visibility         «Skjult for kunder» when /produsent/<slug> is not
//                      served (hasProducerPage + is_active); «På pause» when
//                      «Profilen er synlig» (visibility.profile, the owner
//                      pause row) is off or the public page shows the pause
//                      (isProfileOwnerHidden).
//   orders             orders.enabled (Mine valg) and countOrderableProducts()
//                      — the same count as the «Varer» card's header.
//   level              «Mine valg»'s T8 status (ownerRfbLevelStatus +
//                      ownerLevelStatusText), from resolveOwnerFeatures and
//                      readOwnerLevelChoiceFor.
//   news question      readOwnerNewsState().showQuestion (T7).
//   stats              the caller passes the portal's ownerPortalYearStats().
//
// ownerActionCounts() is the ONE read behind both the menu badges (all three
// shell pages) and «Dette bør du gjøre nå», so the numbers cannot differ.

import { getDb } from "../database/init";
import { readOwnerItems, ownerItemView } from "../services/owner-items-view";
import { ownerOrderabilityPortalEnabledFor } from "../services/owner-orderability";
import { countOrderableProducts } from "../services/cart-service";
import { hasProducerPage, isProfileOwnerHidden } from "../services/agent-visibility";
import { resolveOwnerFeatures, type ResolvedOwnerFeatures } from "../owner-features/resolve";
import { readOwnerLevelChoiceFor, readOwnerNewsState } from "../owner-features/changes";
import { ownerDashboardActiveFor, type OwnerActionCounts } from "./shell";
import type {
  OwnerOverviewModel, OwnerOverviewNewsResult, OwnerOverviewOrders, OwnerOverviewVisibility,
} from "./overview";

const VERTICAL = "rfb" as const;

/** Orders waiting for an answer (tolerant: a DB without orders gives 0). */
export function countPendingOrders(db: any, agentId: string): number {
  try {
    const pc = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = ? AND status = 'pending'").get(agentId) as any;
    return Number(pc?.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * «Varer» rows that should be confirmed: the T13 card's «Trenger handling»
 * group (ownerItemView … group "needs_action"). 0 while the card is not
 * shown, or on a failed read.
 */
export function countItemsToConfirm(db: any, agentId: string, now: Date = new Date()): number {
  try {
    if (!ownerOrderabilityPortalEnabledFor(agentId)) return 0;
    const model = readOwnerItems(agentId, db, now);
    const ctx = { now, softExpiry: model.softExpiry, ordersOn: model.ordersOn, profileEligible: model.profileEligible, canEdit: false };
    return model.rows.filter((row) => ownerItemView(row, ctx).group === "needs_action").length;
  } catch (e) {
    console.error("[owner-overview] items-to-confirm count failed:", e instanceof Error ? e.message : "error");
    return 0;
  }
}

/**
 * T15c: the «Varer» page /eier/:id/varer exists — the dashboard is active
 * (OWNER_DASHBOARD_ENABLED + allowlist + verified owner) AND the T13 «Varer»
 * card is shown (OWNER_ORDERABILITY_PORTAL_ENABLED + allowlist). Never throws.
 */
export function ownerItemsPageActiveFor(agentId: string, verifiedOwner: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return ownerDashboardActiveFor(VERTICAL, agentId, verifiedOwner, env) && ownerOrderabilityPortalEnabledFor(agentId, env);
  } catch {
    return false;
  }
}

/** The ONE read behind the menu badges and «Dette bør du gjøre nå». */
export function ownerActionCounts(db: any, agentId: string, now: Date = new Date()): OwnerActionCounts {
  return { pendingOrders: countPendingOrders(db, agentId), itemsToConfirm: countItemsToConfirm(db, agentId, now) };
}

function overviewVisibility(db: any, agentId: string, resolved: ResolvedOwnerFeatures | null): OwnerOverviewVisibility {
  try {
    const row = db
      .prepare("SELECT role, umbrella_type, is_vetted, catalog_hidden, vertical_id, origin, is_active FROM agents WHERE id = ?")
      .get(agentId) as any;
    if (!row || row.is_active === 0 || !hasProducerPage(row)) return "hidden";
  } catch { /* fail-open: the profile reads as served, as on the agent card */ }
  if (resolved?.byKey["visibility.profile"]?.value === false) return "paused";
  try {
    if (isProfileOwnerHidden(db, agentId)) return "paused";
  } catch { /* fail-open */ }
  return "visible";
}

function overviewOrders(db: any, agentId: string, resolved: ResolvedOwnerFeatures | null): OwnerOverviewOrders {
  if (resolved?.byKey["orders.enabled"]?.value !== true) return "off";
  let count = 0;
  try { count = countOrderableProducts(agentId, db); } catch { count = 0; }
  return count > 0 ? "on" : "on_no_items";
}

export interface OwnerOverviewInput {
  agentId: string;
  profileSlug: string;
  counts: OwnerActionCounts;
  /** The portal's ownerPortalYearStats() (null = the read failed). */
  year: {
    humanViews: { value: number }; aiViews: { value: number }; aiDeliveries: { value: number };
    labels: { nb: Record<string, string> };
  } | null;
  newsResult: OwnerOverviewNewsResult | null;
  /** T15c: the Varer page exists (ownerItemsPageActiveFor). */
  itemsPage?: boolean;
  db?: any;
}

/** The «Oversikt» model from the existing sources (never throws: a failed part reads as «nothing to say»). */
export function buildOwnerOverviewModel(input: OwnerOverviewInput): OwnerOverviewModel {
  const db = input.db ?? getDb();
  const { agentId } = input;
  let resolved: ResolvedOwnerFeatures | null = null;
  try { resolved = resolveOwnerFeatures(VERTICAL, agentId); } catch { resolved = null; }

  let levelText: string | null = null;
  let showNewsQuestion = false;
  if (resolved) {
    try {
      // Lazy: owner-features/page imports routes/owner-portal (escapeHtml).
      const page = require("../owner-features/page") as typeof import("../owner-features/page");
      const st = page.ownerRfbLevelStatus(resolved, readOwnerLevelChoiceFor(VERTICAL, agentId, { db }));
      levelText = st ? page.ownerLevelStatusText(st) : null;
    } catch (e) {
      console.error("[owner-overview] level status failed:", e instanceof Error ? e.message : "error");
      levelText = null;
    }
    try { showNewsQuestion = readOwnerNewsState(VERTICAL, agentId, resolved, { db }).showQuestion; } catch { showNewsQuestion = false; }
  }

  const y = input.year;
  const nb = (k: string) => (y && y.labels && y.labels.nb && y.labels.nb[k]) || "";
  return {
    agentId,
    profileSlug: input.profileSlug,
    visibility: overviewVisibility(db, agentId, resolved),
    orders: overviewOrders(db, agentId, resolved),
    levelText,
    counts: input.counts,
    stats: y
      ? {
        humanViews: { value: y.humanViews.value, label: nb("humanViews") },
        aiViews: { value: y.aiViews.value, label: nb("aiViews") },
        aiDeliveries: { value: y.aiDeliveries.value, label: nb("aiDeliveries") },
      }
      : null,
    showNewsQuestion,
    newsResult: input.newsResult,
    ...(input.itemsPage ? { itemsPage: true } : {}),
  };
}

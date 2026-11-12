// ─── gardssalg-owner-stats-service.ts — minimal "Statistikk" tab data for the
// opplevagent gårdssalg owner-claim portal (dev-request 2026-07-21-
// opplevagent-claim-flyt-drikkeprodusenter, acceptance criterion 3) ────────
//
// RFB's owner-stats-service.ts (src/services/owner-stats-service.ts) has SIX
// groups: views-by-source, AI-platform split, matching search queries,
// conversations-by-channel, contact-clicks-by-kind, and a discovered->viewed
// ->contacted funnel. That richness rests on RFB-only tables/columns:
// analytics_agent_views (agent_id-keyed), analytics_queries/conversations
// tied to seller_agent_id, contact_clicks tied to agent_id, and
// agent_metrics.times_discovered — verified directly against
// src/database/init.ts: NONE of these reference experience_providers at all,
// and analytics_mcp_calls (the closest thing to an "AI recommendation count"
// for MCP/A2A traffic) has NO per-agent/per-provider column whatsoever (just
// protocol/vertical_id/tool_name) — there is genuinely no way to attribute an
// MCP/AI tool call to one specific gårdssalg provider today.
//
// What DOES exist and IS usable: analytics_page_views (src/database/init.ts)
// is a CROSS-VERTICAL table (vertical_id column, stamped from the Host header
// by analytics-service.ts's request middleware) that logs every page view by
// path. A gårdssalg produsent page view (/kategori/gardssalg/produsent/<slug>)
// is logged there exactly like any other opplevagent page. So this owner's
// "Statistikk" tab shows ONLY: page views by people and AI search on the
// producer's own page. It does NOT show conversations, contact-clicks,
// matching search queries, or a discovery funnel — those tables simply don't
// have a gårdssalg analogue (documented, honest gap — "v1 shows only what's
// actually available").
//
// Since 2026-10-14 (dev-request 2026-10-13-statistikk-riktig-for-investorer,
// S6) the same definitions as the RFB owner portal and the public producer
// pages (owner-stats-service.ts readPathViewGroups): page views only
// (2xx/304), each session classed once by the class stored at write time,
// over the raw retention window (60 days); «AI» is AI search only (an
// assistant fetching the page for a person), not AI crawlers. Before that,
// LIKE marker lists counted bingbot/curl/scanners as people and Googlebot as
// AI, every status, over 90 days, with a page_view_daily top-up.
//
// Since statistikk S2d (dev-request 2026-10-22-statistikk-samme-tall-12-mnd)
// «Med i AI-søk» covers the last 12 months with the public tile's label
// (aiDeliveriesYearPeriodLabel: «siste 12 måneder» / «siden <dato>»). The two
// page-view numbers stay at the raw window (60 days): a gårdssalg page view
// is never written to analytics_agent_views (RFB producers only), so it has
// no stored per-profile daily sums to reach further back.
//
// Reads analytics_page_views from the RFB/shared lokal.db (via
// src/database/init.ts's getDb(), NOT db-factory's experiences.db handle) —
// same cross-DB read oa-home-counters.ts's getTrafficStats() already does.
// Read-only; never writes.

import { getDb as getRfbDb } from "../database/init";
import { computeAiDeliveries, type AiDeliveries } from "./profile-ai-deliveries-compute";
import { cutoffIsoFor, ownerStatsWindowDays, readPathViewGroups } from "./owner-stats-service";
import { aiDeliveriesYearPeriodLabel } from "./profile-year-compute";
import { TRAFFIC_YEAR_DAYS } from "./traffic-year-compute";

export interface GardssalgOwnerStats {
  windowDays: number;
  path: string;
  /** Page views by people. */
  humanViews: number;
  /** AI search: an assistant (ChatGPT, Claude, Perplexity …) fetched the page for a person. AI crawlers are not counted. */
  aiSearchViews: number;
  /** Same value as aiSearchViews, kept for older clients of this endpoint. */
  aiBotViews: number;
  /**
   * «Med i AI-søk»: times the producer was among the results an AI assistant
   * fetched (list and profile pages, MCP, A2A), per AI and per channel.
   * `window` is the last 12 months (TRAFFIC_YEAR_DAYS since statistikk S2d;
   * it was 60 days) with its label `windowLabel` («siste 12 måneder» /
   * «siden <dato>», the public tile's), `allTime` since the counting started.
   * Present when the provider id is given.
   */
  aiDeliveries?: { window: AiDeliveries; allTime: AiDeliveries; windowLabel: string };
  /** Honest, explicit acknowledgment of what this tab does NOT show — the
   * portal UI renders this list so an owner never wonders why a number is
   * "missing" (never silently omitted). */
  notAvailable: string[];
}

const NOT_AVAILABLE = [
  "AI-anbefalinger (per produsent)",
  "Samtaler",
  "Kontakt-klikk",
  "Søk som traff profilen din",
];

function gardssalgAiDeliveries(providerId: string, nowMs: number): NonNullable<GardssalgOwnerStats["aiDeliveries"]> {
  const db = getRfbDb();
  const window = computeAiDeliveries(db, "experiences", providerId, TRAFFIC_YEAR_DAYS, nowMs);
  return {
    window,
    allTime: computeAiDeliveries(db, "experiences", providerId, null, nowMs),
    windowLabel: aiDeliveriesYearPeriodLabel(window.countingSince, nowMs, "nb"),
  };
}

export function getGardssalgOwnerStats(path: string, providerId?: string, nowMs: number = Date.now()): GardssalgOwnerStats {
  const db = getRfbDb();
  const windowDays = ownerStatsWindowDays();
  const cutoffIso = cutoffIsoFor(windowDays, nowMs);
  let humanViews = 0;
  let aiSearchViews = 0;
  for (const g of readPathViewGroups(db, path, cutoffIso, { vertical: "experiences" })) {
    if (g.cls === "human") humanViews += g.views;
    else if (g.cls === "ai_search") aiSearchViews += g.views;
  }
  return {
    windowDays,
    path,
    humanViews,
    aiSearchViews,
    aiBotViews: aiSearchViews,
    ...(providerId ? { aiDeliveries: gardssalgAiDeliveries(providerId, nowMs) } : {}),
    notAvailable: NOT_AVAILABLE,
  };
}

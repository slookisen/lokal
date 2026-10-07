// ─── ONE catalog number per vertical ("honest count") ────────────────────────
// dev-request 2026-09-08-discovery-paritet-og-ett-katalogtall, item 6.
//
// Honest count = active, publishable rows of a vertical — the rows a visitor
// can actually find on the public site:
//   rfb         agents:  is_active=1, umbrella_type IS NULL, is_vetted=1 and the
//                        shared public-listability predicate (same WHERE as
//                        marketplaceRegistry.getActiveAgents()).
//   dental      dental_agents: not rejected, not is_inactive, real clinic class,
//                        not the synthetic probe row (countHonestDentalClinics()).
//   experiences experiences: published (countPublishedExperiences()).
//
// Every public surface that quotes a catalog size (llms.txt, agent card, MCP
// server card / mcp.json, agents.json, /api/stats, /health) reads THIS function.
// No caching here on purpose: callers that need it cheap already sit behind
// their own response caches, and a cache here would make fixtures in tests lie.
//
// dental-store / experience-store are require()d lazily (same reason a2a.ts
// does it): importing them at module load would capture the vertical DB
// handle too early for modules that import this file.

import { getDb } from "../database/init";
import { publicListableSql } from "./agent-visibility";

export type CatalogVertical = "rfb" | "dental" | "experiences";

export function countHonestRfbProducers(): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM agents WHERE is_active = 1 AND umbrella_type IS NULL AND is_vetted = 1 AND ${publicListableSql()}`,
    )
    .get() as { c: number };
  return row.c;
}

export function honestCatalogCount(vertical: CatalogVertical): number {
  switch (vertical) {
    case "dental":
      return (require("./dental-store") as typeof import("./dental-store")).countHonestDentalClinics();
    case "experiences":
      return (require("./experience-store") as typeof import("./experience-store")).countPublishedExperiences();
    default:
      return countHonestRfbProducers();
  }
}

/** Never throws: null when the vertical's DB is not available (e.g. cold start, unit tests without a DB). */
export function safeHonestCatalogCount(vertical: CatalogVertical): number | null {
  try {
    const n = honestCatalogCount(vertical);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Same hostname substring rule as a2a.ts lockedVerticalForStatsHost / analytics.ts. */
export function catalogVerticalForHost(hostname: string | undefined): CatalogVertical {
  const h = (hostname || "").toLowerCase();
  if (h.includes("finn-tannlege")) return "dental";
  if (h.includes("opplevagent")) return "experiences";
  return "rfb";
}

/** All three verticals' honest counts (null per vertical when its DB is unavailable). Used by /health. */
export function honestCatalogCounts(): Record<CatalogVertical, number | null> {
  return {
    rfb: safeHonestCatalogCount("rfb"),
    dental: safeHonestCatalogCount("dental"),
    experiences: safeHonestCatalogCount("experiences"),
  };
}

// ─── Places API usage tracker — dev-request 2026-07-03-places-api-cost-reduction, measure 2 ──
//
// Google Maps Platform bills Places API (New) Text Search per-SKU, with a
// free monthly cap of only 1,000 calls for the "Enterprise" tier (triggered
// whenever the request's field mask includes an Enterprise-tier field, e.g.
// rating / userRatingCount / internationalPhoneNumber / websiteUri). This
// module logs every real Places call so the daily orchestrator brief can
// flag the account before it drifts back over the free cap.
//
// Observability only: logPlacesCall() and getPlacesUsageThisMonth() never
// throw — a failure here must not block or alter an enrichment run.
import type Database from "better-sqlite3";

export type PlacesSku = "text_search_enterprise" | "text_search_pro" | "place_details";

export function logPlacesCall(
  db: Database.Database,
  vertical: string,
  endpoint: string,
  sku: PlacesSku
): void {
  try {
    db.prepare(
      `INSERT INTO places_api_call_log (vertical, endpoint, sku, called_at) VALUES (?, ?, ?, ?)`
    ).run(vertical, endpoint, sku, new Date().toISOString());
  } catch {
    // best-effort only — never let a logging failure affect the caller
  }
}

export interface PlacesUsageRow {
  vertical: string;
  sku: string;
  calls_this_month: number;
}

// Aggregates this-calendar-month (UTC) call counts from one DB handle,
// grouped by SKU. Callers combine rows from multiple vertical DB handles
// (rfb + dental are physically separate SQLite files) for a platform total.
export function getPlacesUsageThisMonth(
  db: Database.Database,
  vertical: string
): PlacesUsageRow[] {
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const rows = db
      .prepare(
        `SELECT sku, COUNT(*) as calls_this_month
           FROM places_api_call_log
          WHERE called_at >= ?
          GROUP BY sku`
      )
      .all(monthStart.toISOString()) as Array<{ sku: string; calls_this_month: number }>;
    return rows.map((r) => ({ vertical, sku: r.sku, calls_this_month: r.calls_this_month }));
  } catch {
    return [];
  }
}

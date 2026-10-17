// ─── Places API usage tracker — dev-request 2026-07-03-places-api-cost-reduction, measure 2 ──
//
// Google Maps Platform bills Places API (New) Text Search per-SKU, with a
// free monthly cap of only 1,000 calls for the "Enterprise" tier (triggered
// whenever the request's field mask includes an Enterprise-tier field, e.g.
// rating / userRatingCount / internationalPhoneNumber / websiteUri). This
// module logs every real Places call so the daily orchestrator brief can
// flag the account before it drifts back over the free cap.
//
// Observability only: logPlacesCall() and the readers below never throw — a
// failure here must not block or alter an enrichment run.
//
// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
// treffvakt (S4-A2): Google's rating is no longer fetched, and S4-A's
// acceptance is "the Places log shows 0 Enterprise rating calls after
// deploy". The SKU cannot show it (internationalPhoneNumber and websiteUri
// are Enterprise too), so a caller passes the FieldMask it sent, and a call
// whose mask asked for a rating field is logged with
// PLACES_RATING_ENDPOINT_SUFFIX on its endpoint. That needs no schema
// change: getPlacesUsageThisMonth groups by SKU, not endpoint, so its sums
// are unchanged. Rows written before this change carry no suffix.
import type Database from "better-sqlite3";
import { fieldMaskRequestsRating } from "./places-match";

export type PlacesSku = "text_search_enterprise" | "text_search_pro" | "place_details";

/** Endpoint suffix of a logged call whose FieldMask asked for Google's rating (S4-A2). */
export const PLACES_RATING_ENDPOINT_SUFFIX = "+rating";

export function logPlacesCall(
  db: Database.Database,
  vertical: string,
  endpoint: string,
  sku: PlacesSku,
  fieldMask?: string
): void {
  try {
    const logged = fieldMask !== undefined && fieldMaskRequestsRating(fieldMask)
      ? endpoint + PLACES_RATING_ENDPOINT_SUFFIX
      : endpoint;
    db.prepare(
      `INSERT INTO places_api_call_log (vertical, endpoint, sku, called_at) VALUES (?, ?, ?, ?)`
    ).run(vertical, logged, sku, new Date().toISOString());
  } catch {
    // best-effort only — never let a logging failure affect the caller
  }
}

// Start of the current calendar month (UTC), as stored in called_at.
function monthStartIso(): string {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  return monthStart.toISOString();
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
    const rows = db
      .prepare(
        `SELECT sku, COUNT(*) as calls_this_month
           FROM places_api_call_log
          WHERE called_at >= ?
          GROUP BY sku`
      )
      .all(monthStartIso()) as Array<{ sku: string; calls_this_month: number }>;
    return rows.map((r) => ({ vertical, sku: r.sku, calls_this_month: r.calls_this_month }));
  } catch {
    return [];
  }
}

// This-calendar-month (UTC) calls from one DB handle whose FieldMask asked
// for Google's rating (S4-A2, PLACES_RATING_ENDPOINT_SUFFIX). 0 when the log
// cannot be read, as getPlacesUsageThisMonth returns no rows then.
export function getPlacesRatingFieldCallsThisMonth(db: Database.Database): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM places_api_call_log
          WHERE called_at >= ? AND endpoint LIKE ?`
      )
      .get(monthStartIso(), `%${PLACES_RATING_ENDPOINT_SUFFIX}`) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Supply Graph — shared config + read-time freshness rule for producer-set
 * per-product availability (dev-request 2026-07-23-supplygraph, "Local
 * Supply Graph v1").
 *
 * Context: a claimed producer can set per-product availability
 * (in_stock/seasonal/sold_out) from the dashboard (see
 * src/services/product-availability-service.ts for the write path, and
 * PATCH /agents/:id/products/:productId/availability in src/routes/
 * marketplace.ts). That value auto-expires if not reconfirmed within
 * AVAILABILITY_STALE_DAYS — Pattern A (read-time computed, no cron sweep):
 * nothing ever mutates the stored `availability` column on expiry; every
 * CONSUMER of it degrades the value to 'unknown' at read time once it's
 * stale. This mirrors the existing `url_last_probed > datetime('now',
 * '-30 days')` freshness idiom already used elsewhere in this codebase
 * (see src/database/init.ts's url_last_probed comment).
 *
 * This module is the ONE place that rule is expressed, in two equivalent
 * forms so callers never hand-roll their own copy that could drift out of
 * sync with this constant:
 *   - effectiveAvailability()   — JS/TS, for in-process values (rows already
 *                                 fetched, or hand-built for tests).
 *   - effectiveAvailabilitySql() / isEffectivelyInStockSql() — SQL fragments
 *                                 for queries that need to filter/paginate
 *                                 at the DB level (e.g. the catalog feed).
 * Both are derived from the same AVAILABILITY_STALE_DAYS constant below —
 * tune the window in exactly one place.
 */

import { parseIsoOrSqlite } from "../utils/freshness";

// ─── Tunable: auto-expiry window ────────────────────────────────────────────
// If a product's `availability_updated_at` is older than this many days (or
// NULL — i.e. never confirmed), every read-time consumer must treat its
// effective availability as 'unknown', regardless of what the raw stored
// `availability` column says. Change this single constant to retune the
// window platform-wide.
export const AVAILABILITY_STALE_DAYS = 14;

// ─── Accepted values ─────────────────────────────────────────────────────────
// Producer-settable values (write path). 'unknown' is deliberately NOT in
// this list — it is never stored in `products.availability`; it only ever
// exists as the read-time-computed result of staleness (see
// effectiveAvailability() below).
export const PRODUCT_AVAILABILITY_VALUES = ["in_stock", "seasonal", "sold_out"] as const;
export type ProductAvailability = (typeof PRODUCT_AVAILABILITY_VALUES)[number];
export type EffectiveAvailability = ProductAvailability | "unknown";

export function isValidProductAvailability(value: unknown): value is ProductAvailability {
  return typeof value === "string" && (PRODUCT_AVAILABILITY_VALUES as readonly string[]).includes(value);
}

/**
 * The single source of truth for "is this product's stored availability
 * still trustworthy right now?" — pure function, no I/O, injectable `now`
 * for deterministic tests.
 *
 *   - `availabilityUpdatedAt` NULL/empty/unparsable  -> 'unknown' (never
 *     confirmed, or a legacy row from before this column existed and was
 *     never backfilled — see the init.ts migration's backfill comment for
 *     why that backfill exists).
 *   - older than AVAILABILITY_STALE_DAYS              -> 'unknown'.
 *   - otherwise                                       -> the raw stored
 *     `availability` value (or 'unknown' if that value is itself somehow
 *     not one of the three valid enum values — defensive, should not
 *     happen given the write path validates strictly).
 */
export function effectiveAvailability(
  availability: string | null | undefined,
  availabilityUpdatedAt: string | null | undefined,
  now: Date = new Date(),
): EffectiveAvailability {
  const updated = parseIsoOrSqlite(availabilityUpdatedAt);
  if (!updated) return "unknown";

  const staleThresholdMs = AVAILABILITY_STALE_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() - updated.getTime() >= staleThresholdMs) return "unknown";

  if (!isValidProductAvailability(availability)) return "unknown";
  return availability;
}

/**
 * Days elapsed since `availabilityUpdatedAt` (floor), for the "sist bekreftet
 * <N> dager siden" freshness display. Returns null when there is nothing to
 * measure from (never confirmed).
 */
export function daysSinceAvailabilityUpdate(
  availabilityUpdatedAt: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const updated = parseIsoOrSqlite(availabilityUpdatedAt);
  if (!updated) return null;
  return Math.max(0, Math.floor((now.getTime() - updated.getTime()) / 86400000));
}

/**
 * SQL CASE expression computing the same effective-availability value as
 * effectiveAvailability() above, for use directly inside a SELECT list.
 * `alias` is the table/alias prefix used in the query (defaults to the bare
 * column names, i.e. no join alias).
 *
 * IMPORTANT: keep this in lockstep with effectiveAvailability() above — both
 * must express the exact same "NULL-or-older-than-N-days -> unknown" rule.
 * Both read AVAILABILITY_STALE_DAYS from this same module so retuning the
 * window never requires touching this SQL string.
 */
export function effectiveAvailabilitySql(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return (
    `CASE WHEN ${p}availability_updated_at IS NULL ` +
    `OR ${p}availability_updated_at <= datetime('now', '-${AVAILABILITY_STALE_DAYS} days') ` +
    `THEN 'unknown' ELSE ${p}availability END`
  );
}

/**
 * SQL boolean predicate: true iff this row's EFFECTIVE availability is
 * 'in_stock' (raw value is 'in_stock' AND the timestamp is fresh). Use this
 * anywhere a query currently does `<alias>.availability = 'in_stock'` to
 * gate "is this actually orderable" — e.g. the marketplace catalog feed.
 */
export function isEffectivelyInStockSql(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return (
    `${p}availability = 'in_stock' ` +
    `AND ${p}availability_updated_at IS NOT NULL ` +
    `AND ${p}availability_updated_at > datetime('now', '-${AVAILABILITY_STALE_DAYS} days')`
  );
}

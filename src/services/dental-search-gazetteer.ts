// ─── Dental search gazetteer: one TTL cache over listPoststeder(1) ──────────
//
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S3). /sok, MCP
// tannlege_search and A2A message/send all parse free text against the same
// place list. The poststed rows come from ONE cached listPoststeder(1) call
// (DENTAL_STATS_TTL_MS, the TTL dental-seo.ts already used for its own
// poststed cache, which now delegates here), so parsing never runs an extra
// scan per request — see dev-requests 2026-09-19 / 2026-09-26 on main-thread
// stalls.
//
// Callers pass their own `listPoststeder` import. The cache is keyed on that
// function too, so a test block with a fresh dental-store copy never reads a
// gazetteer built from another block's database.
//
// The gazetteer also knows the landsdeler and byområder of
// config/norway-search-areas.ts (dev-request 2026-10-17-dental-d3-rettelser,
// D3f), so «tannlege på Vestlandet» or «Osloområdet» reads the same on all
// three surfaces.

import { NORWEGIAN_SEARCH_AREAS } from "../config/norway-search-areas";
import type { PoststedRow } from "./dental-store";
import { buildNorwegianGazetteer, type PlaceGazetteer } from "./search-intent/norwegian-query";

/**
 * TTL of the dental SSR caches. dental-seo.ts's stats cache imports this
 * same constant, so the poststed/gazetteer cache and the stats cache cannot
 * drift apart.
 */
export const DENTAL_STATS_TTL_MS = 60_000;

type PoststedLister = (minCount?: number) => PoststedRow[];

let cache: {
  source: PoststedLister;
  rows: PoststedRow[];
  expires: number;
  gazetteer: PlaceGazetteer | null;
} | null = null;

/** listPoststeder(1), cached for DENTAL_STATS_TTL_MS ([] while the DB is not ready). */
export function getCachedDentalPoststeder(listPoststeder: PoststedLister): PoststedRow[] {
  const now = Date.now();
  if (cache && cache.source === listPoststeder && now < cache.expires) return cache.rows;
  let rows: PoststedRow[] = [];
  try { rows = listPoststeder(1); } catch { /* db not ready */ }
  cache = { source: listPoststeder, rows, expires: now + DENTAL_STATS_TTL_MS, gazetteer: null };
  return rows;
}

/** The place gazetteer for parseDentalQuery(), rebuilt only when the cached rows are. */
export function getDentalSearchGazetteer(listPoststeder: PoststedLister): PlaceGazetteer {
  const rows = getCachedDentalPoststeder(listPoststeder);
  // rows come most-common first, so each place's first spelling is its most used one.
  return (cache!.gazetteer ??= buildNorwegianGazetteer(rows.map((r) => r.poststed), NORWEGIAN_SEARCH_AREAS));
}

/** Test-only: drop the cache. */
export function __resetDentalSearchGazetteerForTesting(): void {
  cache = null;
}

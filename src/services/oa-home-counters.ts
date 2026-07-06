/**
 * oa-home-counters.ts — Opplevagent homepage "counter strip" stats
 *
 * dev-request 2026-07-04-opplevagent-besokstall-og-forside-friskhet, item 1:
 * a live, host-scoped social-proof counter strip on the opplevagent.no
 * homepage, mirroring the "proof-bar" rettfrabonden.com's homepage already
 * shows (src/routes/seo.ts + src/services/traffic-stats.ts) — same source of
 * truth, same shape, just rendered under the Opplevagent visual theme.
 *
 * Combines two independent data sources:
 *
 *  1. Traffic numbers (Sidevisninger / Unike besøkende / Ekte mennesker /
 *     Bot & AI-trafikk) — reused AS-IS from getTrafficStats("experiences"),
 *     the SAME shared, vertical-parameterized helper RFB's and dental's
 *     homepages already call (traffic-stats.ts, PR-121). It already:
 *       (a) scopes to the opplevagent.no host, because analytics-service.ts's
 *           request middleware stamps every row's vertical_id from the Host
 *           header (getVerticalFromHost: "opplevagent" -> "experiences")
 *           before this ever reaches a route handler — so RFB/dental traffic
 *           can never leak into these numbers, and
 *       (b) excludes internal fleet/verifier traffic, because
 *           isOwnerRequest() in analytics-service.ts already classifies our
 *           own scheduled agents' user-agents (RFB-ContactVerifier,
 *           Lokal-Enricher, curl, python-*, node-fetch, axios/...) as
 *           "owner" traffic, stamped into is_owner and filtered out by
 *           getTrafficStats' `(is_owner IS NULL OR is_owner = 0)` clause —
 *           this is the exact rule dev-request
 *           2026-07-04-rfb-samtaler-ekte-samtalevisning item 3 also reuses,
 *           so nothing new is invented here.
 *     We do NOT reimplement any of this — we just call the existing helper
 *     with vertical="experiences".
 *
 *  2. Catalog numbers (Opplevelser / Tilbydere / Kommuner) — new lightweight
 *     COUNT queries against the experiences catalog DB
 *     (src/services/experience-store.ts), gated by the SAME PUBLISH_GATE_SQL
 *     the rest of the OA catalog (browse/detail/sitemap) already queries
 *     with, so the counter strip can never show a number that includes
 *     unpublished/unverified rows the rest of the site wouldn't show either.
 *
 * Both are combined and cached in-process for OA_HOME_COUNTERS_TTL_MS
 * (10 minutes — inside the 5-15 min window the dev-request asked for) so the
 * homepage never re-runs these queries on every request. Same "cheap
 * in-memory TTL cache" shape as traffic-stats.ts's own _trafficCache.
 */

import { getTrafficStats } from "./traffic-stats";
import {
  countPublishedExperiences,
  countPublishedProviders,
  countPublishedKommuner,
} from "./experience-store";

export interface OaHomeCounters {
  pageViews: number;
  uniqueVisitors: number;
  realHumans: number;
  botAndAi: number;
  opplevelser: number;
  tilbydere: number;
  kommuner: number;
}

const OA_HOME_COUNTERS_TTL_MS = 10 * 60 * 1000; // 10 min — inside the 5-15 min window

let _cache: { data: OaHomeCounters; time: number } | null = null;

/**
 * Live, host-scoped counter-strip numbers for the opplevagent.no homepage.
 * Cached for OA_HOME_COUNTERS_TTL_MS; safe to call on every request.
 */
export function getOaHomeCounters(): OaHomeCounters {
  const now = Date.now();
  if (_cache && now - _cache.time < OA_HOME_COUNTERS_TTL_MS) {
    return _cache.data;
  }

  // Traffic side: already host-scoped (vertical_id='experiences') and
  // already excludes fleet/internal traffic (is_owner) — see file header.
  const traffic = getTrafficStats("experiences");

  // Catalog side: read defensively, same "render with 0s, never throw"
  // discipline as the rest of experiences-seo.ts (e.g. safeCategories()) —
  // the counter strip must never break the homepage if the catalog DB isn't
  // open yet in some environment.
  let opplevelser = 0;
  let tilbydere = 0;
  let kommuner = 0;
  try {
    opplevelser = countPublishedExperiences();
    tilbydere = countPublishedProviders();
    kommuner = countPublishedKommuner();
  } catch {
    // Catalog DB not open — render the traffic numbers with 0 catalog counts.
  }

  const data: OaHomeCounters = {
    pageViews: traffic.pageViews,
    uniqueVisitors: traffic.uniqueVisitors,
    realHumans: traffic.realHumans,
    botAndAi: traffic.botAndAi,
    opplevelser,
    tilbydere,
    kommuner,
  };
  _cache = { data, time: now };
  return data;
}

/**
 * Test-only: clear the module-level cache so tests can observe freshly
 * queried data immediately instead of waiting out the real TTL. Mirrors the
 * `__setDbForTesting` / `__resetDbFactoryForTesting` test-only export
 * convention used elsewhere in this repo. Never call from production code.
 */
export function __resetOaHomeCountersCacheForTesting(): void {
  _cache = null;
}

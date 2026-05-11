/**
 * Freshness signal helpers - PR-30
 *
 * Surface `agent_knowledge.updated_at` as a freshness signal to Google so
 * producer pages get re-crawled faster after hourly enrichment writes new
 * data (PR-24/PR-28 wired updated_at into the hourly verifier loop).
 *
 * Three call sites:
 *   1. Visible <time> badge near the top of /produsent/<slug>
 *   2. <title> tag suffix when fresh (boosts CTR in search results)
 *   3. <lastmod> per URL in sitemap.xml
 *
 * Pure functions - no I/O, no Express, no DB. Tested in tests/test.ts.
 */

// Norwegian month names (locale-hardcoded so output is deterministic across
// whatever ICU build the deploy host ships).
const NB_MONTHS = [
  "januar", "februar", "mars", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "desember",
];

/**
 * Parse an ISO 8601 timestamp into a Date, accepting both
 * "2026-05-11T10:00:00Z" and SQLite's "2026-05-11 10:00:00" form.
 * Returns null for null/undefined/empty/invalid input.
 */
export function parseIsoOrSqlite(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Pretty Norwegian relative time:
 *   <24h  -> "i dag" or "i år"
 *   1-6d  -> "for N dager siden"
 *   >=7d  -> "DD. <month> YYYY"  e.g. "11. mai 2026"
 *
 * `now` is injectable so tests are deterministic.
 */
export function formatUpdatedPrettyNo(updatedAt: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - updatedAt.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays < 1) {
    if (updatedAt.toDateString() === now.toDateString()) return "i dag";
    return "i går";
  }
  if (diffDays === 1) return "i går";
  if (diffDays < 7) return `for ${diffDays} dager siden`;

  const day = updatedAt.getUTCDate();
  const month = NB_MONTHS[updatedAt.getUTCMonth()];
  const year = updatedAt.getUTCFullYear();
  return `${day}. ${month} ${year}`;
}

/**
 * Month-year in Norwegian for the <title> freshness suffix, e.g. "mai 2026".
 * Uses UTC components so the suffix is stable regardless of server TZ.
 */
export function formatMonthYearNo(d: Date): string {
  return `${NB_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * If updatedAt is within `windowDays` (default 30) of `now`, return the
 * "(oppdatert <month> <year>)" suffix for the page <title>. Otherwise "".
 *
 * We append rather than prepend so the brand stays at the front of the
 * SERP snippet; "(oppdatert mai 2026)" is the freshness CTR booster.
 */
export function titleFreshnessSuffix(
  updatedAt: Date | null,
  now: Date = new Date(),
  windowDays: number = 30
): string {
  if (!updatedAt) return "";
  const diffDays = (now.getTime() - updatedAt.getTime()) / 86400000;
  if (diffDays < 0 || diffDays > windowDays) return "";
  return ` (oppdatert ${formatMonthYearNo(updatedAt)})`;
}

/**
 * Sitemap <priority> and <changefreq> mapped from agent_knowledge.enrichment_status.
 *   rich    -> 0.8 / weekly
 *   partial -> 0.5 / monthly
 *   thin    -> 0.3 / monthly
 *   other / unknown -> 0.3 / monthly (treat as thin so we do not over-promise)
 */
export function sitemapHintsForStatus(status: string | null | undefined): { priority: string; changefreq: string } {
  switch ((status || "").toLowerCase()) {
    case "rich":    return { priority: "0.8", changefreq: "weekly" };
    case "partial": return { priority: "0.5", changefreq: "monthly" };
    case "thin":
    default:        return { priority: "0.3", changefreq: "monthly" };
  }
}

/**
 * <lastmod> takes YYYY-MM-DD (preferred) or full ISO. Google accepts both;
 * the date-only form matches the existing static-page sitemap entries.
 */
export function lastmodForDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

// ─── What counts as a page view ─────────────────────────────────────────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S1.
//
// The analytics middleware runs before express.static and used to record every
// non-/api GET, so favicons, logos, /sw.js, /manifest.json, the service worker's
// /offline.html precache, robots.txt, llms.txt and the /mcp and /a2a endpoints
// were all "page views" — 12 of the 20 top "pages" on rettfrabonden.com on
// 2026-10-12, and roughly 4 in 10 stored rows. Redirects (301/302) and error
// responses (404) were counted too.
//
// One definition, used at write time and at read time:
//   - a page is a path whose last segment has no file extension (".html" and
//     ".htm" excepted), that is not the offline fallback page and not under
//     /mcp or /a2a;
//   - a page VIEW is a page answered with 2xx, or 304 (the browser revalidated
//     a page it already had, which is still the person looking at it).
// Rows written before this rule are filtered at read time with the SQL form of
// the same rule (pageViewSql), so every window is consistent from day one.
//
// Pure: no database import, safe in the off-thread stats worker.

import { SCANNER_PATH_PATTERNS } from "./traffic-classifier";

/** Service-worker offline fallbacks: precached on install, never navigated to. */
export const OFFLINE_FALLBACK_PATHS = ["/offline.html", "/opplevagent-offline.html"] as const;

/** Agent endpoints that answer GET with JSON or an event stream, not a page. */
export const NON_PAGE_PATH_PREFIXES = ["/mcp", "/a2a"] as const;

function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** True if `path` (no query string) is a page someone or something can view. */
export function isPagePath(path: string): boolean {
  if (!path || path[0] !== "/") return false;
  // Case-insensitive throughout, like SQLite's LIKE in pagePathSql below.
  const lc = path.toLowerCase();
  if ((OFFLINE_FALLBACK_PATHS as readonly string[]).includes(lc)) return false;
  for (const p of NON_PAGE_PATH_PREFIXES) {
    if (lc === p || lc.startsWith(p + "/")) return false;
  }
  const seg = lastSegment(lc);
  if (!seg.includes(".")) return true;
  return seg.endsWith(".html") || seg.endsWith(".htm");
}

/**
 * 2xx, or 304 (a revalidated page the browser already had). A missing status
 * is a row written before status_code existed: the path rule alone decides.
 * (The /selger.html?agent=… claim-funnel rows also have no status; the path
 * rule drops them, because their stored path carries the query string.)
 */
export function isPageViewStatus(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return (status >= 200 && status < 300) || status === 304;
}

/** True if the path probes for scanner targets (wp-admin, .env, .git …). */
export function isScannerProbePath(path: string): boolean {
  return SCANNER_PATH_PATTERNS.some((p) => path.includes(p));
}

/** text/html or text/markdown (the ?format=md page for agents). */
export function isDocumentContentType(contentType: unknown): boolean {
  const ct = String(Array.isArray(contentType) ? contentType[0] : contentType ?? "").toLowerCase();
  return ct.startsWith("text/html") || ct.startsWith("text/markdown");
}

/**
 * Write-time rule for the analytics middleware. Records pages answered with a
 * document (any status, so 404s and redirects stay visible for operations, and
 * 304s, which Express sends without a Content-Type), plus every scanner probe,
 * whatever it got back: the read side needs those rows to tell a scanner from a
 * person.
 */
export function shouldRecordPageView(path: string, statusCode: number, contentType: unknown): boolean {
  if (isScannerProbePath(path)) return true;
  if (!isPagePath(path)) return false;
  return statusCode === 304 || isDocumentContentType(contentType);
}

// ── SQL form of the rule (read time) ─────────────────────────────────

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Path half of the rule: the SQL twin of isPagePath(path), for any table with a path column. */
export function pagePathSql(column = "path"): string {
  const lc = `lower(${column})`;
  // Last path segment: rtrim(p, <every char of p except '/'>) keeps everything
  // up to and including the last '/', so what follows is the last segment.
  const seg = `substr(${lc}, length(rtrim(${lc}, replace(${lc}, '/', ''))) + 1)`;
  const offline = OFFLINE_FALLBACK_PATHS.map(sqlString).join(", ");
  const prefixes = NON_PAGE_PATH_PREFIXES
    .map((p) => `${lc} != ${sqlString(p)} AND ${lc} NOT LIKE ${sqlString(p + "/%")}`)
    .join(" AND ");
  return (
    `${column} LIKE '/%'` +
    ` AND ${lc} NOT IN (${offline})` +
    ` AND ${prefixes}` +
    ` AND NOT (${seg} LIKE '%.%' AND ${seg} NOT LIKE '%.html' AND ${seg} NOT LIKE '%.htm')`
  );
}

/**
 * `AND`-able predicate over analytics_page_views selecting page views: the SQL
 * twin of isPagePath(path) && isPageViewStatus(status_code). `alias` qualifies
 * the columns (e.g. "pv"). page-view-definition.test.ts checks that SQL and JS
 * agree on every stored path shape.
 */
export function pageViewSql(alias?: string): string {
  const c = (col: string) => (alias ? `${alias}.${col}` : col);
  const status = c("status_code");
  return `(${status} IS NULL OR (${status} >= 200 AND ${status} < 300) OR ${status} = 304) AND ${pagePathSql(c("path"))}`;
}

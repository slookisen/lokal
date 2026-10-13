/**
 * Shared sitemap helpers (dev-request 2026-09-29-gsc-strukturerte-data-og-5xx, slice C).
 *
 * - resolveSitemapCacheTtlMs: SITEMAP_CACHE_TTL_MS, default 30 min, clamped 10-60 min
 *   (moved here from seo.ts, which re-exports it).
 * - createSitemapCache: per-vertical in-memory TTL cache with the rfb semantics
 *   (a failing rebuild serves the previous valid version; with none, the error propagates).
 * - logSlowSitemap: one-line `[sitemap-slow]` warn when a response took > 3 s.
 */

const SITEMAP_TTL_MIN_MS = 10 * 60_000;
const SITEMAP_TTL_DEFAULT_MS = 30 * 60_000;
const SITEMAP_TTL_MAX_MS = 60 * 60_000;
export const SITEMAP_SLOW_MS = 3000;

export function resolveSitemapCacheTtlMs(raw: string | undefined = process.env.SITEMAP_CACHE_TTL_MS): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return SITEMAP_TTL_DEFAULT_MS;
  return Math.min(SITEMAP_TTL_MAX_MS, Math.max(SITEMAP_TTL_MIN_MS, Math.floor(n)));
}

export interface SitemapCache {
  get(now?: number, build?: () => string): string;
  reset(): void;
}

export function createSitemapCache(vertical: string, defaultBuild: () => string): SitemapCache {
  let cache: { xml: string; builtAt: number } | null = null;
  return {
    get(now: number = Date.now(), build: () => string = defaultBuild): string {
      if (cache && now - cache.builtAt < resolveSitemapCacheTtlMs()) return cache.xml;
      try {
        cache = { xml: build(), builtAt: now };
      } catch (err) {
        if (!cache) throw err;
        console.error(`[${vertical}-sitemap] rebuild failed, serving previous version:`, err);
      }
      return cache.xml;
    },
    reset(): void {
      cache = null;
    },
  };
}

/** One line, no body: `[sitemap-slow] <vertical> <ms>ms` when elapsed > 3 s. */
export function logSlowSitemap(vertical: string, startedAt: number, now: number = Date.now()): void {
  const ms = now - startedAt;
  if (ms > SITEMAP_SLOW_MS) console.warn(`[sitemap-slow] ${vertical} ${ms}ms`);
}

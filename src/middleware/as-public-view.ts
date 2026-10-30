// ─── «Vis som offentlig» — the as-public view (dev-request ─────────────────
// 2026-10-22-rfb-mine-valg-eierbrytere, slice S2d-2, AC22) ───────────────────
// The hidden RFB test fixture (origin = 'test_fixture' AND catalog_hidden = 1)
// is invisible on every public surface, so the owner's visibility switches
// («Mine valg», visibility.*) cannot be observed on it in prod. This middleware
// lets an admin look at the public surfaces as if the fixture were public:
//
//   opt-in   the query parameter `as_public=1`
//   auth     a valid `X-Admin-Key` header — the same check every admin route
//            and buildRequestMeta() (services/internal-traffic.ts) use
//   scope    only the public RFB read surfaces in AS_PUBLIC_PATHS below
//
// All three present → the rest of the request runs inside the request-scoped
// as-public context (services/agent-visibility.ts, AsyncLocalStorage): the
// shared predicate reads catalog_hidden as 0 for origin = 'test_fixture' rows
// only; every other gate still applies. The response is marked
// `Cache-Control: no-store, private` and `X-Robots-Tag: noindex` (a handler's
// own Cache-Control / X-Robots-Tag is overridden), and the in-process caches
// on the way (registry agent list + stats, sitemap) are bypassed.
//
// Anything missing (no key, a wrong key, no opt-in, another path/method) →
// next() untouched: byte-identical behaviour, no DB query. The fast path is
// one substring test on req.url.
//
// Opplevagent (dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, slice
// O2a): the same view for the hidden gårdssalg test producer
// (is_test_provider = 1, catalog_hidden_reason = 'test_fixture'). Same opt-in,
// key, headers and request context; the gårdssalg predicate
// (services/gardssalg-visibility.ts) reads the fixture as not hidden inside it.
// The Opplevagent pages are served on their own host (index.ts host gate), so
// those paths are matched only when req.hostname is opplevagent.no; the REST
// discover path sits under /api/opplevelser, which every host passes through.
// The RFB list above is unchanged and still matched on any host.

import type { NextFunction, Request, Response } from "express";
import { buildRequestMeta } from "../services/internal-traffic";
import { runAsPublicView } from "../services/agent-visibility";

/** The documented opt-in: `?as_public=1` (together with a valid X-Admin-Key). */
export const AS_PUBLIC_QUERY_PARAM = "as_public";

export const AS_PUBLIC_CACHE_CONTROL = "no-store, private";
export const AS_PUBLIC_ROBOTS = "noindex";

/**
 * The public RFB surfaces the view covers (paths as Express sees them after
 * langMiddleware has stripped /en). `post` = also for POST (JSON-RPC / body
 * queries); everything else is GET/HEAD only.
 */
const AS_PUBLIC_PATHS: ReadonlyArray<{ re: RegExp; post?: boolean }> = [
  { re: /^\/produsent\/(?!ordre$)[^/]+$/ }, // profile HTML + JSON-LD (not the order flow)
  { re: /^\/api\/marketplace\/agents\/[^/]+\/(card|info|vcard|trust)$/ },
  { re: /^\/api\/marketplace\/search$/ },
  { re: /^\/api\/marketplace\/discover$/, post: true },
  { re: /^\/api\/marketplace\/catalog\/(feed|acp-feed\.csv)$/ },
  { re: /^\/sitemap\.xml$/ },
  { re: /^\/llms(-full)?\.txt$/ },
  { re: /^\/api\/leaderboard$/ },
  { re: /^\/a2a$/, post: true },
  { re: /^\/agents\/[^/]+\/agent\.json$/ },
];

/** The Opplevagent hosts (same set as the experiences host gate in index.ts). */
export const OPPLEVAGENT_HOSTS: ReadonlySet<string> = new Set(["opplevagent.no", "www.opplevagent.no"]);

/**
 * The public gårdssalg read surfaces (O2a). `host: true` = only on the
 * Opplevagent host. /mcp (discover_gardssalg, get_experience) and /a2a are
 * JSON-RPC POSTs; book_gardssalg refuses inside the view (read-only).
 */
const GARDSSALG_AS_PUBLIC_PATHS: ReadonlyArray<{ re: RegExp; post?: boolean; host?: boolean }> = [
  { re: /^\/$/, host: true }, // landing: gårdssalg counts per drink type
  { re: /^\/kategori\/gardssalg$/, host: true }, // grid + map points
  { re: /^\/kategori\/gardssalg\/[^/]+$/, host: true }, // drink-type pages
  { re: /^\/kategori\/gardssalg\/produsent\/[^/]+$/, host: true }, // profile HTML + JSON-LD
  { re: /^\/sok$/, host: true },
  { re: /^\/reise$/, host: true }, // route corridor (map surface)
  { re: /^\/sitemap\.xml$/, host: true },
  { re: /^\/mcp$/, post: true, host: true },
  { re: /^\/a2a$/, post: true, host: true },
  { re: /^\/api\/opplevelser\/discover$/ },
];

function matches(
  list: ReadonlyArray<{ re: RegExp; post?: boolean; host?: boolean }>,
  method: string,
  path: string,
  opplevagentHost: boolean,
): boolean {
  const isRead = method === "GET" || method === "HEAD";
  return list.some(
    (p) => p.re.test(path) && (p.host !== true || opplevagentHost) && (isRead || (p.post === true && method === "POST")),
  );
}

function coveredPath(method: string, path: string, hostname?: string): boolean {
  if (matches(AS_PUBLIC_PATHS, method, path, false)) return true;
  return matches(GARDSSALG_AS_PUBLIC_PATHS, method, path, !!hostname && OPPLEVAGENT_HOSTS.has(hostname));
}

/** Does this request ask for (and may it have) the as-public view? */
export function wantsAsPublicView(req: Request): boolean {
  if (!req.url || !req.url.includes(`${AS_PUBLIC_QUERY_PARAM}=`)) return false;
  const q = (req.query as Record<string, unknown> | undefined)?.[AS_PUBLIC_QUERY_PARAM];
  if (q !== "1") return false;
  if (!coveredPath(req.method, req.path, req.hostname)) return false;
  return buildRequestMeta(req as any).hasValidAdminKey === true;
}

/** Force the as-public response headers, whatever the handler sets later. */
function pinAsPublicHeaders(res: Response): void {
  const original = res.setHeader.bind(res);
  (res as any).setHeader = (name: string, value: any) => {
    const n = String(name).toLowerCase();
    if (n === "cache-control") return original(name, AS_PUBLIC_CACHE_CONTROL);
    if (n === "x-robots-tag") return original(name, AS_PUBLIC_ROBOTS);
    return original(name, value);
  };
  original("Cache-Control", AS_PUBLIC_CACHE_CONTROL);
  original("X-Robots-Tag", AS_PUBLIC_ROBOTS);
}

export function asPublicViewMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!wantsAsPublicView(req)) {
    next();
    return;
  }
  pinAsPublicHeaders(res);
  runAsPublicView(() => next());
}

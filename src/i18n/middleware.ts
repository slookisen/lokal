// Express middleware that detects /en/* (and, when SV_LOCALE_ENABLED, /sv/*)
// paths, sets req.lang, and rewrites req.url so existing routes still match.
//
// Example:
//   GET /en/sok?q=mat
//   → req.lang = "en"
//   → req.url is rewritten to /sok?q=mat
//   → existing router.get("/sok", ...) handler runs
//   → handler reads req.lang and renders English shell()
//
// Default lang is "no". Cookie/localStorage are NOT used here —
// the URL is the single source of truth for the language.
// (Cookie lookup is fine, but URL must always win to match SEO.)

import type { Request, Response, NextFunction } from "express";
import { type Lang, detectLangFromPath, stripLangPrefix, enabledLangs, isLangCookieRedirectEnabled, localizedPath } from "./t";

declare global {
  namespace Express {
    interface Request {
      lang: Lang;
      /** The original path including any /en or /sv prefix. Useful when
       *  building hreflang alternates and the canonical URL. */
      langOriginalPath: string;
    }
  }
}

export function langMiddleware(req: Request, _res: Response, next: NextFunction) {
  const lang = detectLangFromPath(req.path);
  req.lang = lang;
  req.langOriginalPath = req.path;

  if (lang !== "no") {
    // Strip the /en or /sv prefix so downstream routes match.
    // Preserve query string.
    const stripped = stripLangPrefix(req.path);
    const qIndex = req.url.indexOf("?");
    const query = qIndex >= 0 ? req.url.slice(qIndex) : "";
    req.url = stripped + query;
  }
  next();
}

// ─── RFB language session (Daniel 2026-09-03) ─────────────────────────────
//
// «Om man har valgt å bytte til Engelsk skal det språket være default for den
//  brukeren frem til dem bytter tilbake eller går ut av siden. Altså skal man
//  slippe å bytte språk for hver ny side man går inn på.»
//
// The URL-prefix design above keeps the language only as long as every link
// carries the prefix. The 2026-09-03 audit showed it does not: on
// /en/produsent/hanen 103 of 111 internal links had no /en, and the site has
// pages that are not localized at all (/selger, /samtaler) — one click through
// either and the language was gone. Fixing the links is necessary (done in
// seo.ts alongside this) but not sufficient, because a non-localized page
// breaks the chain no matter how its links look.
//
// So this adds a SESSION cookie — "frem til … går ut av siden" is exactly a
// session cookie — with one hard rule carried over from the header comment
// above: THE URL STILL WINS. The cookie never changes what a URL serves; it
// only redirects a browser navigation from an unprefixed URL to the prefixed
// one the person chose. Crawlers send no cookie and see canonical Norwegian,
// so nothing here is cloaking and hreflang/canonical are untouched.
//
//   1. `?setlang=no|en|sv` on any GET — the switcher links carry it — sets
//      (or, for `no`, clears) the cookie and redirects to the same URL without
//      the param. This is what lets "Norsk" actually stick: without it, an
//      unprefixed URL would bounce straight back to /en.
//   2. A prefixed URL (/en/…) refreshes the cookie and renders as before.
//   3. An unprefixed URL + a cookie + a browser navigation (Accept: text/html)
//      + a path that really renders in that language → 302 to the prefixed
//      URL, query preserved. Only the RFB pages that read req.lang are
//      eligible; a page that would render Norwegian under an /en URL is never
//      redirected to (that is worse than losing the language). /:city is
//      deliberately left out: its handler falls through to other routes for
//      unknown slugs, so a path-shape match cannot promise a localized page.
//
// Scoped to RFB by MOUNTING, not by host sniffing: seo.ts does
// `router.use(rfbLangSessionMiddleware)`, and that router is only mounted for
// the RFB host. The legacy client-side `lang` cookie the switcher JS writes
// (1-year, "for client-only views like /selger") is deliberately NOT read: a
// year-old choice must not redirect a returning visitor who lands on / from a
// search result — Daniel: «viktig at default språk fortsatt er Norsk».
//
// Gated by LANG_COOKIE_REDIRECT_ENABLED === "true" (i18n/t.ts); default off.


export const LANG_SESSION_COOKIE = "rfb_lang_session";

/** RFB pages whose handler reads req.lang and renders in that language. */
const RFB_LOCALIZED_EXACT: ReadonlySet<string> = new Set([
  "/", "/sok", "/om", "/teknologi", "/reise", "/guide-mat-ai", "/personvern",
  "/proveniens", "/kategori", "/verifisert-av-eier", "/kontakt",
]);
const RFB_LOCALIZED_PREFIXES: readonly string[] = ["/produsent/", "/kategori/"];

export function isRfbLocalizedPath(path: string): boolean {
  if (RFB_LOCALIZED_EXACT.has(path)) return true;
  return RFB_LOCALIZED_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length);
}

/** Minimal cookie-header parse — the app does not use cookie-parser. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** No maxAge/expires → a SESSION cookie, cleared when the browser closes. */
function sessionCookieOptions(req: Request) {
  return { httpOnly: true, sameSite: "lax" as const, secure: !!req.secure, path: "/" };
}

function acceptsHtml(req: Request): boolean {
  return String(req.headers.accept || "").includes("text/html");
}

export function rfbLangSessionMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isLangCookieRedirectEnabled()) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const enabled = enabledLangs();

  // 1. Explicit choice from the switcher.
  const raw = (req.query as Record<string, unknown> | undefined)?.setlang;
  if (typeof raw === "string") {
    if (raw === "no") res.clearCookie(LANG_SESSION_COOKIE, sessionCookieOptions(req));
    else if ((enabled as string[]).includes(raw)) res.cookie(LANG_SESSION_COOKIE, raw, sessionCookieOptions(req));
    // An unknown value touches nothing — but the param is stripped either way.
    const u = new URL(req.originalUrl, "http://local");
    u.searchParams.delete("setlang");
    return res.redirect(302, u.pathname + u.search);
  }

  // 2. A prefixed URL wins, and refreshes the session.
  if (req.lang !== "no") {
    res.cookie(LANG_SESSION_COOKIE, req.lang, sessionCookieOptions(req));
    return next();
  }

  // 3. An unprefixed URL follows the session — only onto a page that renders it.
  const chosen = readCookie(req, LANG_SESSION_COOKIE);
  if (!chosen || chosen === "no" || !(enabled as string[]).includes(chosen)) return next();
  if (!acceptsHtml(req)) return next();
  if (!isRfbLocalizedPath(req.path)) return next();
  const qi = req.originalUrl.indexOf("?");
  const query = qi >= 0 ? req.originalUrl.slice(qi) : "";
  return res.redirect(302, localizedPath(req.path, chosen as Lang) + query);
}

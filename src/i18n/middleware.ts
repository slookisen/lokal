// Express middleware that detects /en/* paths, sets req.lang,
// and rewrites req.url so existing routes still match.
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
import { type Lang, detectLangFromPath, stripLangPrefix } from "./t";

declare global {
  namespace Express {
    interface Request {
      lang: Lang;
      /** The original path including any /en prefix. Useful when
       *  building hreflang alternates and the canonical URL. */
      langOriginalPath: string;
    }
  }
}

export function langMiddleware(req: Request, _res: Response, next: NextFunction) {
  const lang = detectLangFromPath(req.path);
  req.lang = lang;
  req.langOriginalPath = req.path;

  if (lang === "en") {
    // Strip /en prefix so downstream routes match.
    // Preserve query string.
    const stripped = stripLangPrefix(req.path);
    const qIndex = req.url.indexOf("?");
    const query = qIndex >= 0 ? req.url.slice(qIndex) : "";
    req.url = stripped + query;
  }
  next();
}

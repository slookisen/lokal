// Simple JSON-based i18n helper.
// Loads no.json + en.json once at import time.
// Use t(lang, "nav.search") or t(lang, "city.title", { city: "Oslo", count: 12 }).
//
// Why this design: the platform renders most pages server-side from
// src/routes/seo.ts. We want a synchronous, zero-dependency lookup that
// matches the existing escapeHtml-style code path.

import noLocale from "./locales/no.json";
import enLocale from "./locales/en.json";

export type Lang = "no" | "en";

const LOCALES: Record<Lang, any> = {
  no: noLocale,
  en: enLocale,
};

export const SUPPORTED_LANGS: Lang[] = ["no", "en"];
export const DEFAULT_LANG: Lang = "no";

/**
 * Look up a translation key like "nav.search" or "home.hero_pill".
 * Falls back to NO if the EN key is missing, then to the key itself.
 * Substitutes {placeholders} from the params object.
 */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const safeLang: Lang = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const path = key.split(".");

  let value: any = LOCALES[safeLang];
  for (const p of path) {
    value = value?.[p];
    if (value === undefined) break;
  }

  // Fallback chain: target lang → NO → key string
  if (value === undefined && safeLang !== "no") {
    value = LOCALES.no;
    for (const p of path) {
      value = value?.[p];
      if (value === undefined) break;
    }
  }
  if (typeof value !== "string") return key;

  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, k) => {
      const v = params[k];
      return v === undefined ? `{${k}}` : String(v);
    });
  }
  return value;
}

/**
 * Build a localized URL prefix.
 *   prefix("no") === ""        (default lang has no prefix)
 *   prefix("en") === "/en"
 */
export function langPrefix(lang: Lang): string {
  return lang === "en" ? "/en" : "";
}

/**
 * Take a path like "/sok" and return the version for a given language.
 *   localizedPath("/sok", "en") === "/en/sok"
 *   localizedPath("/sok", "no") === "/sok"
 *   localizedPath("/", "en")    === "/en"
 */
export function localizedPath(path: string, lang: Lang): string {
  if (lang === "no") return path;
  if (path === "/") return "/en";
  return "/en" + (path.startsWith("/") ? path : "/" + path);
}

/**
 * Strip /en prefix from a path. Returns the canonical NO path.
 *   stripLangPrefix("/en/sok") === "/sok"
 *   stripLangPrefix("/sok")    === "/sok"
 *   stripLangPrefix("/en")     === "/"
 */
export function stripLangPrefix(path: string): string {
  if (path === "/en") return "/";
  if (path.startsWith("/en/")) return path.slice(3);
  return path;
}

/**
 * Detect language from a URL path.
 */
export function detectLangFromPath(path: string): Lang {
  if (path === "/en" || path.startsWith("/en/")) return "en";
  return "no";
}

/**
 * HTML lang attribute value (for <html lang="...">).
 */
export function htmlLangAttr(lang: Lang): string {
  return lang === "en" ? "en" : "nb";
}

/**
 * OpenGraph locale tag.
 */
export function ogLocale(lang: Lang): string {
  return lang === "en" ? "en_US" : "nb_NO";
}

/**
 * Format a price in NOK. Always NOK regardless of language —
 * we don't convert currencies.
 *   formatPrice(80, "no") === "kr 80,–"
 *   formatPrice(80, "en") === "NOK 80"
 */
export function formatPrice(amount: number, lang: Lang): string {
  if (lang === "en") return `NOK ${amount.toLocaleString("en-US")}`;
  return `kr ${amount.toLocaleString("nb-NO")},–`;
}

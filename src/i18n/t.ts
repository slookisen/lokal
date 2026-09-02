// Simple JSON-based i18n helper.
// Loads no.json + en.json + sv.json once at import time.
// Use t(lang, "nav.search") or t(lang, "city.title", { city: "Oslo", count: 12 }).
//
// Why this design: the platform renders most pages server-side from
// src/routes/seo.ts. We want a synchronous, zero-dependency lookup that
// matches the existing escapeHtml-style code path.
//
// dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent: a third
// locale, Swedish (`sv`), is added to the type and the dictionaries. The `/sv`
// URL prefix is only RECOGNISED when SV_LOCALE_ENABLED === "true" (read fresh
// per request in detectLangFromPath, see enabledLangs()) — with the flag unset
// every `/sv/*` path is treated exactly as before this change (an unknown
// Norwegian path → the normal 404/fallback), so the flag-off behavior of every
// route is byte-identical. `en` stays always-on as before.

import noLocale from "./locales/no.json";
import enLocale from "./locales/en.json";
import svLocale from "./locales/sv.json";

export type Lang = "no" | "en" | "sv";

const LOCALES: Record<Lang, any> = {
  no: noLocale,
  en: enLocale,
  sv: svLocale,
};

/** Every locale the code base knows about (dictionaries exist for all of these). */
export const SUPPORTED_LANGS: Lang[] = ["no", "en", "sv"];
export const DEFAULT_LANG: Lang = "no";

/** Locales other than the default that get a URL prefix (`/en`, `/sv`). */
export const PREFIXED_LANGS: Exclude<Lang, "no">[] = ["en", "sv"];

/**
 * Whether the Swedish locale is switched on. Read fresh from process.env on
 * every call (same fresh-read convention as the other feature flags in this
 * code base, e.g. GS_SECOND_LINE_VERIFICATION_ENABLED) so a fly.toml flip
 * takes effect without any code path caching the answer.
 */
export function isSvLocaleEnabled(): boolean {
  return process.env.SV_LOCALE_ENABLED === "true";
}

/** Locales that are currently routable (prefix recognised by the middleware). */
export function enabledLangs(): Lang[] {
  return isSvLocaleEnabled() ? ["no", "en", "sv"] : ["no", "en"];
}

/**
 * Look up a translation key like "nav.search" or "home.hero_pill".
 * Fallback chain: target lang → EN (for sv) → NO → the key itself.
 * Substitutes {placeholders} from the params object.
 */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const safeLang: Lang = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const path = key.split(".");

  const lookup = (locale: any): unknown => {
    let value: any = locale;
    for (const p of path) {
      value = value?.[p];
      if (value === undefined) break;
    }
    return value;
  };

  let value: unknown = lookup(LOCALES[safeLang]);

  // Fallback chain: sv → en → no → key string. (en → no → key, as before.)
  if (value === undefined && safeLang === "sv") value = lookup(LOCALES.en);
  if (value === undefined && safeLang !== "no") value = lookup(LOCALES.no);
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
 *   prefix("sv") === "/sv"
 */
export function langPrefix(lang: Lang): string {
  return lang === "no" ? "" : `/${lang}`;
}

/**
 * Take a path like "/sok" and return the version for a given language.
 *   localizedPath("/sok", "en") === "/en/sok"
 *   localizedPath("/sok", "no") === "/sok"
 *   localizedPath("/", "en")    === "/en"
 */
export function localizedPath(path: string, lang: Lang): string {
  if (lang === "no") return path;
  const prefix = langPrefix(lang);
  if (path === "/") return prefix;
  return prefix + (path.startsWith("/") ? path : "/" + path);
}

/**
 * Strip a language prefix (/en or /sv) from a path. Returns the canonical NO path.
 *   stripLangPrefix("/en/sok") === "/sok"
 *   stripLangPrefix("/sok")    === "/sok"
 *   stripLangPrefix("/en")     === "/"
 */
export function stripLangPrefix(path: string): string {
  for (const l of PREFIXED_LANGS) {
    const p = `/${l}`;
    if (path === p) return "/";
    if (path.startsWith(p + "/")) return path.slice(p.length);
  }
  return path;
}

/**
 * Detect language from a URL path. Only ENABLED prefixes are recognised —
 * `/sv/...` resolves to "no" (i.e. is left untouched) while SV_LOCALE_ENABLED
 * is not "true".
 */
export function detectLangFromPath(path: string): Lang {
  const enabled = enabledLangs();
  for (const l of PREFIXED_LANGS) {
    if (!enabled.includes(l)) continue;
    const p = `/${l}`;
    if (path === p || path.startsWith(p + "/")) return l;
  }
  return "no";
}

/**
 * HTML lang attribute value (for <html lang="...">).
 */
export function htmlLangAttr(lang: Lang): string {
  if (lang === "en") return "en";
  if (lang === "sv") return "sv";
  return "nb";
}

/**
 * OpenGraph locale tag.
 */
export function ogLocale(lang: Lang): string {
  if (lang === "en") return "en_US";
  if (lang === "sv") return "sv_SE";
  return "nb_NO";
}

/**
 * Format a price in NOK. Always NOK regardless of language —
 * we don't convert currencies.
 *   formatPrice(80, "no") === "kr 80,–"
 *   formatPrice(80, "en") === "NOK 80"
 *   formatPrice(80, "sv") === "80 NOK"
 */
export function formatPrice(amount: number, lang: Lang): string {
  if (lang === "en") return `NOK ${amount.toLocaleString("en-US")}`;
  if (lang === "sv") return `${amount.toLocaleString("sv-SE")} NOK`;
  return `kr ${amount.toLocaleString("nb-NO")},–`;
}

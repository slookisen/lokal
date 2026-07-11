/**
 * SEO Frontend Routes v2 — Professional server-rendered HTML pages
 *
 * Complete redesign: consumer-first landing page, rich producer profiles,
 * modern city pages, clean search results. All pages include Schema.org
 * markup for Google Rich Results.
 *
 * Routes:
 *   GET /                     → Landing page with search, categories, featured producers
 *   GET /sok?q=...            → Search results page
 *   GET /:city                → City page with all producers in that city
 *   GET /produsent/:slug      → Individual producer profile page
 *   GET /personvern            → Privacy policy (GDPR)
 *   GET /sitemap.xml          → Dynamic sitemap for Google
 *   GET /robots.txt           → Crawl instructions
 */

import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { knowledgeService } from "../services/knowledge-service";
import { getConfig } from "../config/vertical-config";
import { geocodingService } from "../services/geocoding-service";
import { analyticsService } from "../services/analytics-service";
import { DiscoveryQuerySchema } from "../models/marketplace";
import { getDb } from "../database/init";
import { conversationService, buildRequestMeta } from "../services/conversation-service";
import { getTrafficStats } from "../services/traffic-stats";
import { isDisplayablePhone } from "../services/contact-normalizer";
import { isJunkDescription } from "../services/description-quality";
import { getProfileActivity } from "../services/profile-activity-service";
import { slugify } from "../utils/slug";
import { addUtmParams } from "../utils/url-utm";
import { INDEXNOW_KEY } from "../services/indexnow-service";
import { t, htmlLangAttr, ogLocale, localizedPath, type Lang } from "../i18n/t";
import {
  parseIsoOrSqlite,
  formatUpdatedPrettyNo,
  titleFreshnessSuffix,
  sitemapHintsForStatus,
  lastmodForDate,
} from "../utils/freshness";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────



function escapeHtml(text: string): string {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Repairs a string destined for <meta name="description">/og:description/
// twitter:description before it's escaped. Producer-reported bug (Olestølen
// Mikroysteri, 2026-07): the live meta description ended "...opplevelser p�" —
// a Unicode replacement character (U+FFFD) landing in a DB-stored description,
// almost certainly from a byte-level cut through a multi-byte UTF-8 character
// (æ/ø/å are 2-byte UTF-8 in a JS string, so a byte-offset slice — as opposed
// to a JS string .slice()/.substring(), which is code-unit safe — can chop one
// in half). We don't know every upstream write path that could reintroduce a
// "�", so this is a render-time safety net: strip a trailing run of "�" (and
// any dangling partial word left behind) so a corrupted DB value never reaches
// a live meta tag, no matter how it got corrupted. Leading/interior "�" runs
// are also collapsed defensively, though the reported bug was trailing-only.
//
// dev-request 2026-07-01-cs-corrections-profile-quality item C (catalog-wide
// truncation sweep): exported so the admin cleanup endpoint in
// admin-knowledge.ts can reuse this EXACT repair logic as the one-time DB
// backfill for rows already corrupted before this render-time guard (and the
// write-time gate) existed. Do not duplicate this logic elsewhere — import it.
//
// dev-request 2026-07-11 truncation-sweep fix-up: the trailing-run regex is
// also exported on its own (TRAILING_REPLACEMENT_CHAR_REGEX). Both helpers now
// live in the dependency-free ../utils/meta-description module (extracted so
// admin-knowledge.ts's sweep can reuse them WITHOUT importing this heavyweight
// route module — see that file's header for the isolated-CI-hang it fixed).
// Imported for internal use below AND re-exported so existing importers of
// `./seo` keep their API unchanged.
import { safeMetaDescription, TRAILING_REPLACEMENT_CHAR_REGEX } from "../utils/meta-description";
export { safeMetaDescription, TRAILING_REPLACEMENT_CHAR_REGEX };

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  oslo: { lat: 59.91, lng: 10.75 },
  bergen: { lat: 60.39, lng: 5.32 },
  trondheim: { lat: 63.43, lng: 10.40 },
  stavanger: { lat: 58.97, lng: 5.73 },
  kristiansand: { lat: 58.15, lng: 7.99 },
  tromso: { lat: 69.65, lng: 18.96 },
  drammen: { lat: 59.74, lng: 10.20 },
  fredrikstad: { lat: 59.22, lng: 10.93 },
  bodo: { lat: 67.28, lng: 14.40 },
  alesund: { lat: 62.47, lng: 6.15 },
};

const DAY_NAMES: Record<string, string> = {
  mon: "Mandag", tue: "Tirsdag", wed: "Onsdag", thu: "Torsdag",
  fri: "Fredag", sat: "L\u00f8rdag", sun: "S\u00f8ndag",
  monday: "Mandag", tuesday: "Tirsdag", wednesday: "Onsdag",
  thursday: "Torsdag", friday: "Fredag", saturday: "L\u00f8rdag", sunday: "S\u00f8ndag"
};

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Des"];

const CATEGORY_MAP: Record<string, { name: string; emoji: string }> = {
  vegetables: { name: "Gr\u00f8nnsaker", emoji: "&#127813;" },
  fruit: { name: "Frukt", emoji: "&#127822;" },
  berries: { name: "B\u00e6r", emoji: "&#127827;" },
  dairy: { name: "Meieri", emoji: "&#129472;" },
  eggs: { name: "Egg", emoji: "&#129370;" },
  meat: { name: "Kj\u00f8tt", emoji: "&#129385;" },
  fish: { name: "Fisk", emoji: "&#128031;" },
  bread: { name: "Br\u00f8d", emoji: "&#127858;" },
  honey: { name: "Honning", emoji: "&#127855;" },
  herbs: { name: "Urter", emoji: "&#127807;" },
};

// Badge-label-only translations for platform categories (search-enrich.ts
// PLATFORM_CATEGORIES) that are intentionally NOT in CATEGORY_MAP above.
// CATEGORY_MAP also drives the homepage category-tile grid (see catCards
// below) — adding a browsable tile per category is a separate decision from
// just translating a card badge, so these stay label-only. Without this,
// producer-card badges fell back to the raw English key (e.g. "🌱 beverages"
// on the Kringler Gjestegård card) — dev-request
// 2026-07-04-rfb-datakvalitet-synlige-feil item 4.
const CATEGORY_BADGE_LABELS_ONLY: Record<string, string> = {
  bakery: "Bakeri", beverages: "Drikke", preserves: "Syltetøy", other: "Annet",
};

// Exported for unit tests (translation-completeness sweep).
export function formatCat(cat: string): string {
  return CATEGORY_MAP[cat]?.name || CATEGORY_BADGE_LABELS_ONLY[cat] || cat;
}
function catEmoji(cat: string): string {
  return CATEGORY_MAP[cat]?.emoji || "&#127793;";
}

// ─── CSS Design System ──────────────────────────────────────

const CSS = `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --green-900: #1a3d0a; --green-700: #2D5016; --green-600: #3a6b1e;
    --green-100: #e8f5e0; --green-50: #f0f7ed;
    --orange: #D4A373; --orange-light: #fff3e0;
    --charcoal: #1a1a1a; --g700: #374151; --g500: #6b7280;
    --g300: #d1d5db; --g200: #e5e7eb; --g100: #f3f4f6; --g50: #f9fafb;
    --white: #ffffff;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
    --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1);
    --shadow-lg: 0 10px 25px -3px rgba(0,0,0,0.1);
    --r-sm: 6px; --r-md: 10px; --r-lg: 16px; --r-xl: 24px;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--charcoal); background: var(--white); line-height: 1.6; -webkit-font-smoothing: antialiased; }
  a { color: var(--green-700); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Nav */
  .nav { position: sticky; top: 0; z-index: 100; background: rgba(255,255,255,0.95); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(0,0,0,0.06); padding: 0 32px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
  .nav-logo { font-weight: 800; font-size: 1.2rem; color: var(--green-700); letter-spacing: -0.5px; display: flex; align-items: center; gap: 8px; text-decoration: none; }
  .nav-logo:hover { text-decoration: none; }
  .nav-icon { width: 26px; height: 26px; background: var(--green-700); border-radius: 7px; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.8rem; }
  .nav-links { display: flex; gap: 24px; align-items: center; }
  .nav-links a { font-size: 0.85rem; color: var(--g500); font-weight: 500; transition: color 0.2s; text-decoration: none; }
  .nav-links a:hover { color: var(--green-700); text-decoration: none; }
  .nav-cta { padding: 7px 18px; background: var(--green-700); color: var(--white) !important; border-radius: 8px; font-weight: 600; font-size: 0.82rem; transition: all 0.2s; }
  .nav-cta:hover { background: var(--green-900); }

  /* Breadcrumb */
  .bc { max-width: 1100px; margin: 0 auto; padding: 14px 24px 0; font-size: 0.8rem; color: var(--g500); }
  .bc a { color: var(--green-700); }
  .bc span { margin: 0 6px; opacity: 0.5; }

  /* Container */
  .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

  /* Section headers */
  .sh { text-align: center; margin-bottom: 36px; }
  .sh-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--green-700); margin-bottom: 6px; }
  .sh-title { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.5px; color: var(--charcoal); margin-bottom: 8px; }
  .sh-sub { font-size: 0.95rem; color: var(--g500); max-width: 480px; margin: 0 auto; }

  /* Tags & badges */
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 11px; border-radius: 20px; font-size: 0.72rem; font-weight: 600; }
  .badge-v { background: var(--green-100); color: var(--green-700); }
  .badge-o { background: var(--orange-light); color: #b45309; }
  .badge-c { background: var(--g100); color: var(--g700); }
  .tag { display: inline-block; padding: 3px 10px; background: var(--g100); border-radius: 12px; font-size: 0.73rem; color: var(--g500); font-weight: 500; margin-right: 4px; margin-bottom: 4px; }

  /* Cards */
  .card { background: var(--white); border-radius: var(--r-lg); border: 1px solid var(--g100); transition: all 0.3s; }
  .card:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); border-color: var(--green-100); }
  .card-head { padding: 18px 22px; border-bottom: 1px solid var(--g100); display: flex; align-items: center; gap: 10px; }
  .card-head h3 { font-size: 0.95rem; font-weight: 700; }
  .card-body { padding: 18px 22px; }

  /* Buttons */
  .btn-p { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 11px 22px; background: var(--green-700); color: var(--white); border: none; border-radius: var(--r-md); font-weight: 700; font-size: 0.88rem; cursor: pointer; transition: all 0.2s; text-decoration: none; }
  .btn-p:hover { background: var(--green-900); transform: translateY(-1px); text-decoration: none; }
  .btn-s { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 9px 20px; background: var(--white); color: var(--g700); border: 1px solid var(--g300); border-radius: var(--r-md); font-weight: 600; font-size: 0.82rem; cursor: pointer; transition: all 0.2s; text-decoration: none; }
  .btn-s:hover { border-color: var(--green-700); color: var(--green-700); text-decoration: none; }

  /* Producer cards (shared by city, search, featured) */
  .pc { background: var(--white); border-radius: var(--r-lg); border: 1px solid var(--g100); padding: 22px; transition: all 0.3s; display: block; text-decoration: none; color: var(--charcoal); }
  .pc:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); border-color: var(--green-100); text-decoration: none; }
  .pc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
  .pc-name { font-weight: 700; font-size: 1.02rem; color: var(--charcoal); }
  .pc-city { font-size: 0.8rem; color: var(--g500); margin-top: 2px; }
  .pc-desc { font-size: 0.85rem; color: var(--g500); line-height: 1.5; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pc-tags { margin-bottom: 12px; }
  .pc-foot { display: flex; justify-content: space-between; align-items: center; padding-top: 12px; border-top: 1px solid var(--g100); }
  .trust-m { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--g500); }
  .trust-bar { width: 60px; height: 4px; background: var(--g200); border-radius: 2px; overflow: hidden; }
  .trust-fill { height: 100%; background: var(--green-700); border-radius: 2px; }
  .pc-link { font-size: 0.8rem; font-weight: 600; color: var(--green-700); }

  /* Footer */
  .ft { background: var(--charcoal); color: var(--white); padding: 44px 32px; }
  .ft-inner { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 28px; }
  .ft-brand { font-weight: 800; font-size: 1.1rem; margin-bottom: 6px; }
  .ft-desc { font-size: 0.82rem; opacity: 0.5; line-height: 1.5; max-width: 260px; }
  .ft-col h4 { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.4; margin-bottom: 10px; }
  .ft-col a { display: block; font-size: 0.85rem; color: rgba(255,255,255,0.65); margin-bottom: 7px; }
  .ft-col a:hover { color: white; text-decoration: none; }
  .ft-bottom { max-width: 1100px; margin: 24px auto 0; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem; opacity: 0.35; text-align: center; }

  /* Responsive */
  @media (max-width: 768px) {
    .nav { padding: 0 16px; }
    .nav-links { display: none; }
    .container { padding: 0 16px; }
    .ft-inner { grid-template-columns: 1fr 1fr; gap: 20px; }
  }
</style>`;

// ─── Page shell ─────────────────────────────────────────────

function shell(
  title: string,
  description: string,
  content: string,
  extra?: { canonical?: string; jsonLd?: object | object[]; extraCss?: string; lang?: Lang; pathForAlternate?: string }
): string {
  const lang: Lang = extra?.lang || "no";
  const canonicalUrl = extra?.canonical || BASE_URL;
  // Safety net: repair a "�"-mangled description before it reaches any meta
  // tag, regardless of which route/DB value produced it (see
  // safeMetaDescription doc comment above).
  description = safeMetaDescription(description);

  // Build hreflang alternates from the route's NO path.
  // pathForAlternate is the canonical NO path (e.g. "/sok?q=mat").
  // We derive the EN URL by prepending /en. If pathForAlternate is missing,
  // fall back to canonical; this still produces valid (if less precise) hreflang.
  const noPath = extra?.pathForAlternate || (canonicalUrl.startsWith(BASE_URL) ? canonicalUrl.slice(BASE_URL.length) || "/" : "/");
  const enPath = noPath === "/" ? "/en" : "/en" + noPath;
  const noUrl = BASE_URL + (noPath === "/" ? "" : noPath);
  const enUrl = BASE_URL + enPath;

  const jsonLdScript = extra?.jsonLd
    ? (Array.isArray(extra.jsonLd)
        ? extra.jsonLd.map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")
        : `<script type="application/ld+json">${JSON.stringify(extra.jsonLd)}</script>`)
    : "";

  const langSwitcherCss = `
  .lang-switch{position:relative;display:inline-block;margin-right:14px;}
  .lang-switch button{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--border,#e0e0e0);color:var(--ink,#222);padding:6px 12px;border-radius:18px;font-size:14px;cursor:pointer;font-weight:500;}
  .lang-switch button:hover{background:#f5f5f5;}
  .lang-switch .ls-flag{font-size:14px;line-height:1;}
  .lang-switch .ls-caret{font-size:10px;opacity:.6;}
  .lang-switch .ls-menu{position:absolute;top:calc(100% + 6px);right:0;background:#fff;border:1px solid var(--border,#e0e0e0);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.08);min-width:140px;padding:6px;display:none;z-index:200;}
  .lang-switch.is-open .ls-menu{display:block;}
  .lang-switch .ls-menu a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;text-decoration:none;color:var(--ink,#222);font-size:14px;}
  .lang-switch .ls-menu a:hover{background:#f5f5f5;}
  .lang-switch .ls-menu a.is-active{font-weight:600;background:#fafafa;}
  @media (max-width:640px){.lang-switch button{padding:5px 8px;font-size:13px;} .lang-switch{margin-right:8px;}}
`;

  const flag = (l: Lang) => l === "en" ? "🇬🇧" : "🇳🇴";
  const labelShort = (l: Lang) => l === "en" ? "EN" : "NO";

  const langSwitcher = `
    <div class="lang-switch" id="langSwitch">
      <button type="button" aria-label="${escapeHtml(t(lang, "nav.language"))}" aria-haspopup="true" aria-expanded="false" id="langSwitchBtn">
        <span class="ls-flag">${flag(lang)}</span><span>${labelShort(lang)}</span><span class="ls-caret">▾</span>
      </button>
      <div class="ls-menu" role="menu">
        <a href="${noUrl}" hreflang="nb" class="${lang === "no" ? "is-active" : ""}" role="menuitem"><span class="ls-flag">🇳🇴</span> ${escapeHtml(t(lang, "nav.lang_no"))}</a>
        <a href="${enUrl}" hreflang="en" class="${lang === "en" ? "is-active" : ""}" role="menuitem"><span class="ls-flag">🇬🇧</span> ${escapeHtml(t(lang, "nav.lang_en"))}</a>
      </div>
    </div>`;

  const langSwitcherJs = `
  <script>
  (function(){
    var sw = document.getElementById('langSwitch');
    if (!sw) return;
    var btn = document.getElementById('langSwitchBtn');
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      sw.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', sw.classList.contains('is-open') ? 'true' : 'false');
    });
    document.addEventListener('click', function(){ sw.classList.remove('is-open'); btn.setAttribute('aria-expanded','false'); });
    // Persist the user's choice (for client-only views like /selger).
    sw.querySelectorAll('.ls-menu a').forEach(function(a){
      a.addEventListener('click', function(){ try{ localStorage.setItem('rfb_lang', a.hreflang === 'en' ? 'en' : 'no'); document.cookie = 'lang=' + (a.hreflang === 'en' ? 'en' : 'no') + '; path=/; max-age=' + (60*60*24*365); }catch(_){} });
    });
  })();
  </script>`;

  return `<!DOCTYPE html>
<html lang="${htmlLangAttr(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/logo-200.png">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="${ogLocale(lang)}">
  <meta property="og:site_name" content="${getConfig().display_name}">
  <meta property="og:image" content="${BASE_URL}/logo-512.png">
  <meta property="og:image:width" content="512">
  <meta property="og:image:height" content="512">
  <meta property="og:image:alt" content="${getConfig().display_name} — lokal mat rett fra bonden i Norge">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${BASE_URL}/logo-512.png">
  <meta name="twitter:image:alt" content="${getConfig().display_name} — lokal mat rett fra bonden i Norge">
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
  <link rel="alternate" hreflang="nb" href="${noUrl}">
  <link rel="alternate" hreflang="en" href="${enUrl}">
  <link rel="alternate" hreflang="x-default" href="${noUrl}">
  ${jsonLdScript}
  ${CSS}
  <style>${langSwitcherCss}</style>
  ${extra?.extraCss ? `<style>${extra.extraCss}</style>` : ""}
</head>
<body>
  <nav class="nav">
    <a href="${localizedPath("/", lang)}" class="nav-logo"><div class="nav-icon">🌱</div> <span translate="no">${getConfig().display_name}</span></a>
    <div class="nav-links">
      <a href="${localizedPath("/samtaler", lang)}">${escapeHtml(t(lang, "nav.conversations"))}</a>
      <a href="${localizedPath("/sok", lang)}">${escapeHtml(t(lang, "nav.search"))}</a>
      <a href="${localizedPath("/teknologi", lang)}">${escapeHtml(t(lang, "nav.how_it_works"))}</a>
      <a href="${localizedPath("/om", lang)}">${escapeHtml(t(lang, "nav.about"))}</a>
      ${langSwitcher}
      <a href="/selger" class="nav-cta">${escapeHtml(t(lang, "nav.for_producers"))}</a>
    </div>
  </nav>
  ${content}
  <footer class="ft">
    <div class="ft-inner">
      <div>
        <div class="ft-brand"><span translate="no">${getConfig().display_name}</span></div>
        <div class="ft-desc">${escapeHtml(t(lang, "footer.tagline"))}</div>
      </div>
      <div class="ft-col">
        <h4>${escapeHtml(t(lang, "footer.platform"))}</h4>
        <a href="${localizedPath("/sok", lang)}">${escapeHtml(t(lang, "footer.search_producers"))}</a><a href="${localizedPath("/teknologi", lang)}">${escapeHtml(t(lang, "footer.how_it_works"))}</a><a href="${localizedPath("/om", lang)}">${escapeHtml(t(lang, "footer.about_link"))}</a><a href="${localizedPath("/personvern", lang)}">${escapeHtml(t(lang, "footer.privacy"))}</a><a href="/kontakt">${lang === "en" ? "Contact us" : "Kontakt oss"}</a>
      </div>
      <div class="ft-col">
        <h4>${escapeHtml(t(lang, "footer.for_producers"))}</h4>
        <a href="/selger">${escapeHtml(t(lang, "footer.register"))}</a><a href="/selger">${escapeHtml(t(lang, "footer.login"))}</a>
      </div>
      <div class="ft-col">
        <h4>${escapeHtml(t(lang, "footer.for_developers"))}</h4>
        <a href="/api/marketplace/search?q=mat">${escapeHtml(t(lang, "footer.api"))}</a><a href="https://github.com/slookisen/lokal">${escapeHtml(t(lang, "footer.github"))}</a><a href="https://smithery.ai/servers/slookisen/lokal-norsk-matfinner">${escapeHtml(t(lang, "footer.mcp_server"))}</a>
      </div>
    </div>
    <div class="ft-bottom">${escapeHtml(t(lang, "footer.copyright", { year: new Date().getFullYear() }))}</div>
  </footer>
  ${langSwitcherJs}
</body>
</html>`;
}

// ─── Producer card HTML (reused across pages) ───────────────

function producerCard(a: any, _matchReasons?: string[], lang: Lang = "no"): string {
  const city = a.city || a.location?.city || "";
  const distKm = a.location?.distanceKm;
  const cityText = distKm != null
    ? `${escapeHtml(city)} &middot; ${distKm < 1 ? (distKm * 1000).toFixed(0) + " m" : distKm.toFixed(1) + " km"}`
    : escapeHtml(city);
  const slug = slugify(a.name);
  const cats = (a.categories || []).slice(0, 3).map((c: string) => `<span class="tag">${catEmoji(c)} ${escapeHtml(formatCat(c))}</span>`).join("");
  const trustPct = Math.round((a.trustScore || 0) * 100);
  let desc = a.description || "";
  if (isJunkDescription(desc)) {
    console.log(`[description-guard] suppressed junk description (producerCard) for ${a.id} (${a.name})`);
    desc = "";
  }
  const verified = a.isVerified ? `<span class="badge badge-v">&#10003; ${escapeHtml(t(lang, "producer.verified"))}</span>` : "";
  // EN viewers see a discreet "Norwegian original" hint when descriptions
  // have not been translated yet (we only have NO descriptions for now).
  const noteHtml = (lang === "en" && desc) ? `<div class="pc-note" title="${escapeHtml(t(lang, "common.translate_note"))}" style="font-size:11px;color:#888;margin-top:4px;">\u{1F1F3}\u{1F1F4} ${escapeHtml(t(lang, "common.from_norwegian"))}</div>` : "";

  return `<a href="${localizedPath("/produsent/" + slug, lang)}" class="pc">
    <div class="pc-top">
      <div>
        <div class="pc-name" translate="no">${escapeHtml(a.name)}</div>
        <div class="pc-city" translate="no">${cityText}</div>
      </div>
      ${verified}
    </div>
    ${desc ? `<div class="pc-desc"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(desc)}</div>${noteHtml}` : ""}
    <div class="pc-tags">${cats}</div>
    <div class="pc-foot">
      <div class="trust-m"><div class="trust-bar"><div class="trust-fill" style="width:${trustPct}%"></div></div> ${trustPct}%</div>
      <span class="pc-link">${escapeHtml(t(lang, "common.see_profile"))}</span>
    </div>
  </a>`;
}

// ─── PR-84: "Open now" computation from openingHours ───────

function isOpenNow(openingHours: Array<{ day: string; open: string; close: string }> | undefined): { isOpen: boolean; todayLabel?: string } | null {
  if (!Array.isArray(openingHours) || !openingHours.length) return null;

  // Get current Norway day + time
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(new Date());
  const dayLong = parts.find(p => p.type === "weekday")?.value.toLowerCase() || "";
  const dayKey = dayLong.slice(0, 3); // "mon", "tue", etc
  const hourStr = parts.find(p => p.type === "hour")?.value || "00";
  const minStr = parts.find(p => p.type === "minute")?.value || "00";
  const nowMins = parseInt(hourStr) * 60 + parseInt(minStr);

  const today = openingHours.find(h => h.day?.toLowerCase() === dayKey);
  if (!today) return { isOpen: false };

  const [oh, om] = (today.open || "00:00").split(":").map(Number);
  const [ch, cm] = (today.close || "00:00").split(":").map(Number);
  const openMins = oh * 60 + om;
  const closeMins = ch * 60 + cm;

  const isOpen = nowMins >= openMins && nowMins < closeMins;
  return { isOpen, todayLabel: `${today.open}–${today.close}` };
}

// ─── PR-84: Ultra-rich card for positions 1-3 (claimed top producers) ───

function producerCardUltraRich(a: any, knowledge: any, lang: Lang = "no"): string {
  const city = a.city || a.location?.city || "";
  const distKm = a.location?.distanceKm;
  const postal = knowledge?.postalCode ? ` ${escapeHtml(knowledge.postalCode)}` : "";
  const cityText = distKm != null
    ? `${escapeHtml(city)}${postal} &middot; ${distKm < 1 ? (distKm * 1000).toFixed(0) + " m" : distKm.toFixed(1) + " km"}`
    : `${escapeHtml(city)}${postal}`;
  const slug = slugify(a.name);
  const cats = (a.categories || []).slice(0, 5).map((c: string) => `<span class="tag">${catEmoji(c)} ${escapeHtml(formatCat(c))}</span>`).join("");
  const trustPct = Math.round((a.trustScore || 0) * 100);

  // Description: prefer knowledge.about, fall back to agent description. Cap at 350 chars.
  let desc = (knowledge?.about && knowledge.about.length > 20) ? knowledge.about : (a.description || "");
  if (isJunkDescription(desc)) {
    console.log(`[description-guard] suppressed junk description (producerCardUltraRich) for ${a.id} (${a.name})`);
    desc = "";
  }
  if (desc.length > 350) desc = desc.slice(0, 347).trimEnd() + "…";

  const verified = `<span class="badge badge-v">&#10003; ${escapeHtml(t(lang, "producer.verified"))}</span>`;

  // Rating: ★ 4.7 (159)
  const rating = (typeof knowledge?.googleRating === "number" && knowledge.googleRating > 0)
    ? `<span class="pc-rating">★ ${knowledge.googleRating.toFixed(1)}${knowledge.googleReviewCount ? ` (${knowledge.googleReviewCount})` : ""}</span>`
    : "";

  // Product summary line: top 3 product names with category-emoji + "+N produkter"
  const products = Array.isArray(knowledge?.products) ? knowledge.products : [];
  let productLine = "";
  if (products.length) {
    const top = products.slice(0, 3).map((p: any) => `${catEmoji(p.category || "")} ${escapeHtml(p.name || "")}`).join(", ");
    const more = products.length > 3 ? ` <span class="pc-more">+${products.length - 3} ${escapeHtml(lang === "en" ? "products" : "produkter")}</span>` : "";
    productLine = `<div class="pc-products">${top}${more}</div>`;
  }

  // Address
  const addressLine = knowledge?.address
    ? `<div class="pc-meta-line">📍 ${escapeHtml(knowledge.address)}</div>`
    : "";

  // Open-now indicator (only if openingHours present)
  let openLine = "";
  const openInfo = isOpenNow(knowledge?.openingHours);
  if (openInfo) {
    const label = openInfo.isOpen
      ? `<span class="pc-open-now">${escapeHtml(lang === "en" ? "Open now" : "Åpent nå")}</span>`
      : `<span class="pc-closed">${escapeHtml(lang === "en" ? "Closed" : "Stengt")}</span>`;
    const hours = openInfo.todayLabel ? ` <span class="pc-hours">${escapeHtml(openInfo.todayLabel)}</span>` : "";
    openLine = `<div class="pc-meta-line">🕒 ${label}${hours}</div>`;
  }

  // Phone
  const phoneLine = isDisplayablePhone(knowledge?.phone)
    ? `<div class="pc-meta-line">📞 ${escapeHtml(knowledge.phone)}</div>`
    : "";

  // TODO PR-84-followup: image support when knowledge.images populates
  const noteHtml = (lang === "en" && desc) ? `<div class="pc-note" title="${escapeHtml(t(lang, "common.translate_note"))}" style="font-size:11px;color:#888;margin-top:4px;">\u{1F1F3}\u{1F1F4} ${escapeHtml(t(lang, "common.from_norwegian"))}</div>` : "";

  return `<a href="${localizedPath("/produsent/" + slug, lang)}" class="pc pc-ultra">
    <div class="pc-top">
      <div>
        <div class="pc-name" translate="no">${escapeHtml(a.name)}${rating}</div>
        <div class="pc-city" translate="no">${cityText}</div>
      </div>
      ${verified}
    </div>
    ${desc ? `<div class="pc-desc"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(desc)}</div>${noteHtml}` : ""}
    ${productLine}
    <div class="pc-meta">
      ${addressLine}
      ${openLine}
      ${phoneLine}
    </div>
    <div class="pc-tags">${cats}</div>
    <div class="pc-foot">
      <div class="trust-m"><div class="trust-bar"><div class="trust-fill" style="width:${trustPct}%"></div></div> ${trustPct}%</div>
      <span class="pc-link">${escapeHtml(t(lang, "common.see_profile"))}</span>
    </div>
  </a>`;
}

// ─── PR-84: Medium-rich card for positions 4-11 (claimed producers) ───

function producerCardMediumRich(a: any, knowledge: any, lang: Lang = "no"): string {
  const city = a.city || a.location?.city || "";
  const distKm = a.location?.distanceKm;
  const cityText = distKm != null
    ? `${escapeHtml(city)} &middot; ${distKm < 1 ? (distKm * 1000).toFixed(0) + " m" : distKm.toFixed(1) + " km"}`
    : escapeHtml(city);
  const slug = slugify(a.name);
  const cats = (a.categories || []).slice(0, 3).map((c: string) => `<span class="tag">${catEmoji(c)} ${escapeHtml(formatCat(c))}</span>`).join("");
  const trustPct = Math.round((a.trustScore || 0) * 100);

  // Description: keep existing truncation behavior (~180 chars)
  let desc = a.description || "";
  if (isJunkDescription(desc)) {
    console.log(`[description-guard] suppressed junk description (producerCardMediumRich) for ${a.id} (${a.name})`);
    desc = "";
  }
  if (desc.length > 180) desc = desc.slice(0, 177).trimEnd() + "…";

  const verified = `<span class="badge badge-v">&#10003; ${escapeHtml(t(lang, "producer.verified"))}</span>`;

  const rating = (typeof knowledge?.googleRating === "number" && knowledge.googleRating > 0)
    ? `<span class="pc-rating">★ ${knowledge.googleRating.toFixed(1)}</span>`
    : "";

  // Address line: full address, or fall back to city
  const addressVal = knowledge?.address || city;
  const addressLine = addressVal
    ? `<div class="pc-meta-line">📍 ${escapeHtml(addressVal)}</div>`
    : "";

  // Phone OR website (first available)
  let contactLine = "";
  if (isDisplayablePhone(knowledge?.phone)) {
    contactLine = `<div class="pc-meta-line">📞 ${escapeHtml(knowledge.phone)}</div>`;
  } else if (knowledge?.website) {
    const cleanWeb = String(knowledge.website).replace(/^https?:\/\//, "").replace(/\/$/, "");
    contactLine = `<div class="pc-meta-line">🌐 ${escapeHtml(cleanWeb)}</div>`;
  }

  // Product count
  const products = Array.isArray(knowledge?.products) ? knowledge.products : [];
  const productLine = products.length
    ? `<div class="pc-meta-line">🛒 ${products.length} ${escapeHtml(lang === "en" ? "products" : "produkter")}</div>`
    : "";

  // TODO PR-84-followup: image support when knowledge.images populates
  const noteHtml = (lang === "en" && desc) ? `<div class="pc-note" title="${escapeHtml(t(lang, "common.translate_note"))}" style="font-size:11px;color:#888;margin-top:4px;">\u{1F1F3}\u{1F1F4} ${escapeHtml(t(lang, "common.from_norwegian"))}</div>` : "";

  return `<a href="${localizedPath("/produsent/" + slug, lang)}" class="pc pc-medium">
    <div class="pc-top">
      <div>
        <div class="pc-name" translate="no">${escapeHtml(a.name)}${rating}</div>
        <div class="pc-city" translate="no">${cityText}</div>
      </div>
      ${verified}
    </div>
    ${desc ? `<div class="pc-desc"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(desc)}</div>${noteHtml}` : ""}
    <div class="pc-meta">
      ${addressLine}
      ${contactLine}
      ${productLine}
    </div>
    <div class="pc-tags">${cats}</div>
    <div class="pc-foot">
      <div class="trust-m"><div class="trust-bar"><div class="trust-fill" style="width:${trustPct}%"></div></div> ${trustPct}%</div>
      <span class="pc-link">${escapeHtml(t(lang, "common.see_profile"))}</span>
    </div>
  </a>`;
}

// ─── Live conversation showcase for landing page ────────────

function buildConversationShowcase(_lang: Lang = "no"): string {
  try {
    const convs = conversationService.listConversations({ limit: 3 });
    if (convs.length === 0) return "";

    const sourceLabels: Record<string, string> = {
      a2a: "A2A-protokoll", mcp: "MCP-verkt\u00f8y", web: "Nettside", api: "API",
    };
    const sourceColors: Record<string, string> = {
      a2a: "#2D5016", mcp: "#7c3aed", web: "#0369a1", api: "#6b7280",
    };

    const convCards = convs.map(conv => {
      const buyer = escapeHtml(conv.buyerAgentName || "AI-agent");
      const seller = escapeHtml(conv.sellerAgentName || "Produsent");
      const lastMsg = conv.messages.length > 1
        ? escapeHtml(conv.messages[conv.messages.length - 1].content).slice(0, 100) + (conv.messages[conv.messages.length - 1].content.length > 100 ? "..." : "")
        : "";
      const source = conv.source || "api";
      const srcLabel = sourceLabels[source] || source;
      const srcColor = sourceColors[source] || "#6b7280";
      const statusEmoji = conv.status === "negotiating" ? "&#128992;" : conv.status === "completed" ? "&#9989;" : "&#128994;";

      return `<a href="/samtale/${conv.id}" class="cv-card">
        <div class="cv-top">
          <div class="cv-agents">${buyer} <span class="cv-arrow">&harr;</span> ${seller}</div>
          <span class="cv-src" style="background:${srcColor}15;color:${srcColor}">${srcLabel}</span>
        </div>
        ${lastMsg ? `<div class="cv-preview">${lastMsg}</div>` : ""}
        <div class="cv-foot">
          <span>${statusEmoji} ${conv.messages.length} meldinger</span>
          <span class="cv-time">${formatConvTime(conv.updatedAt)}</span>
        </div>
      </a>`;
    }).join("");

    return `<section class="sec conv-showcase">
      <div class="sh">
        <div class="sh-label">Sanntid</div>
        <div class="sh-title">&#128172; AI-agenter i samtale</div>
        <div class="sh-sub">Se hva som skjer n\u00e5r AI finner lokal mat for deg</div>
      </div>
      <div class="cv-grid">${convCards}</div>
      <div style="text-align:center;margin-top:20px">
        <a href="/samtaler" class="btn-s">Se alle samtaler &rarr;</a>
      </div>
    </section>`;
  } catch { return ""; }
}

function formatConvTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "akkurat n\u00e5";
    if (diffMin < 60) return `${diffMin} min siden`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}t siden`;
    return d.toLocaleDateString("nb-NO", { day: "numeric", month: "short" });
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════════
// GET /api/traffic-stats — Public traffic stats
// ═══════════════════════════════════════════════════════════════

router.get("/api/traffic-stats", (_req: Request, res: Response) => {
  const s = getTrafficStats("rfb");
  res.json({
    pageViews: s.pageViews,
    uniqueVisitors: s.uniqueVisitors,
    realHumans: s.realHumans,
    botAndAi: s.botAndAi,
    aiQueries: s.aiQueries,
  });
});

// ═══════════════════════════════════════════════════════════════
// GET / — Landing page
// ═══════════════════════════════════════════════════════════════

const LANDING_CSS = `
  .hero { padding: 72px 32px 48px; text-align: center; background: linear-gradient(180deg, var(--white) 0%, var(--green-50) 100%); position: relative; overflow: hidden; }
  .hero::before { content: ''; position: absolute; top: -200px; right: -200px; width: 600px; height: 600px; background: radial-gradient(circle, rgba(45,80,22,0.04) 0%, transparent 70%); border-radius: 50%; }
  .hero-inner { position: relative; z-index: 2; max-width: 700px; margin: 0 auto; }
  .hero-pill { display: inline-flex; align-items: center; gap: 8px; padding: 5px 15px; background: var(--green-100); border-radius: 20px; font-size: 0.78rem; font-weight: 600; color: var(--green-700); margin-bottom: 22px; }
  .hero-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green-700); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .hero h1 { font-size: 3rem; font-weight: 800; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 14px; }
  .hero h1 em { color: var(--green-700); font-style: normal; }
  .hero-sub { font-size: 1.1rem; color: var(--g500); max-width: 500px; margin: 0 auto 28px; }
  .hero-search { max-width: 540px; margin: 0 auto 20px; }
  .hero-search form { display: flex; gap: 0; }
  .hero-search input { flex: 1; padding: 16px 20px; border: 2px solid var(--g200); border-right: none; border-radius: 14px 0 0 14px; font-size: 1rem; outline: none; transition: border-color 0.3s; background: var(--white); box-shadow: var(--shadow-lg); }
  .hero-search input:focus { border-color: var(--green-700); }
  .hero-search button { padding: 16px 28px; background: var(--green-700); color: var(--white); border: 2px solid var(--green-700); border-radius: 0 14px 14px 0; font-weight: 700; font-size: 0.95rem; cursor: pointer; transition: background 0.2s; }
  .hero-search button:hover { background: var(--green-900); border-color: var(--green-900); }
  .hero-chips { display: flex; justify-content: center; gap: 7px; flex-wrap: wrap; margin-bottom: 8px; }
  .chip { padding: 5px 13px; background: var(--white); border: 1px solid var(--g200); border-radius: 20px; font-size: 0.78rem; color: var(--g500); text-decoration: none; transition: all 0.2s; }
  .chip:hover { border-color: var(--green-700); color: var(--green-700); background: var(--green-50); text-decoration: none; }

  .ai-assist { margin-top: 18px; text-align: center; }
  .ai-assist-label { font-size: 0.8rem; color: var(--g500); margin-bottom: 10px; font-weight: 500; }
  .ai-assist-btns { display: flex; justify-content: center; gap: 10px; margin-bottom: 8px; }
  .ai-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 22px; border-radius: 10px; font-size: 0.85rem; font-weight: 600; text-decoration: none; transition: all 0.2s; border: 1.5px solid; }
  .ai-btn:hover { transform: translateY(-1px); text-decoration: none; }
  .ai-chatgpt { background: #10a37f12; border-color: #10a37f40; color: #10a37f; }
  .ai-chatgpt:hover { background: #10a37f22; border-color: #10a37f; color: #10a37f; }
  .ai-claude { background: #d4785012; border-color: #d4785040; color: #d47850; }
  .ai-claude:hover { background: #d4785022; border-color: #d47850; color: #d47850; }
  .ai-assist-hint { font-size: 0.72rem; color: var(--g400); }
  .ai-assist-hint a { color: var(--green-700); text-decoration: none; }
  .ai-assist-hint a:hover { text-decoration: underline; }

  .stats-bar { display: flex; justify-content: center; gap: 44px; padding: 28px 0; }
  .stat-n { font-size: 1.9rem; font-weight: 800; color: var(--green-700); letter-spacing: -1px; line-height: 1; }
  .stat-l { font-size: 0.78rem; color: var(--g500); margin-top: 3px; font-weight: 500; }
  .cats-section { background: var(--g50); padding: 56px 32px; }
  .cats-grid { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .cat-card { background: var(--white); border-radius: var(--r-lg); padding: 22px 14px; text-align: center; border: 1px solid var(--g100); transition: all 0.3s; display: block; text-decoration: none; color: var(--charcoal); }
  .cat-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); border-color: var(--green-100); text-decoration: none; }
  .cat-emoji { font-size: 1.8rem; margin-bottom: 6px; display: block; }
  .cat-name { font-size: 0.85rem; font-weight: 600; }
  .cat-count { font-size: 0.72rem; color: var(--g500); }
  .sec { max-width: 1100px; margin: 0 auto; padding: 56px 24px; }
  .cities-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .city-card { background: var(--white); border-radius: var(--r-lg); padding: 20px; display: flex; align-items: center; gap: 14px; border: 1px solid var(--g100); transition: all 0.3s; text-decoration: none; color: var(--charcoal); }
  .city-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--green-100); text-decoration: none; }
  .city-icon { width: 44px; height: 44px; background: var(--green-50); border-radius: 11px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; }
  .city-name { font-weight: 700; font-size: 0.95rem; }
  .city-count { font-size: 0.8rem; color: var(--g500); }
  .feat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
  /* PR-84: Ultra-rich card (positions 1-3 — claimed top producers) */
  .pc-ultra { grid-column: span 1; }
  .pc-ultra .pc-name { font-size: 1.15rem; }
  .pc-ultra .pc-desc { display: block; -webkit-line-clamp: unset; max-height: 6em; overflow: hidden; }
  .pc-ultra .pc-meta { margin: 12px 0; font-size: 0.85rem; color: var(--g700); }
  .pc-ultra .pc-meta-line { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .pc-ultra .pc-rating { color: #f59e0b; font-weight: 600; margin-left: 8px; font-size: 0.92rem; }
  .pc-ultra .pc-open-now { color: #16a34a; font-weight: 600; }
  .pc-ultra .pc-closed { color: #dc2626; }
  .pc-ultra .pc-hours { color: var(--g500); font-size: 0.82rem; }
  .pc-ultra .pc-products { margin: 8px 0; color: var(--g700); font-size: 0.88rem; }
  .pc-ultra .pc-more { color: var(--g500); font-size: 0.82rem; }
  /* PR-84: Medium-rich card (positions 4-11 — claimed producers) */
  .pc-medium .pc-meta { font-size: 0.82rem; color: var(--g700); margin: 8px 0; }
  .pc-medium .pc-meta-line { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .pc-medium .pc-rating { color: #f59e0b; font-weight: 600; margin-left: 8px; font-size: 0.88rem; }
  .how-sec { background: var(--green-50); }
  .how-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; max-width: 850px; margin: 0 auto; }
  .how-step { text-align: center; }
  .how-num { width: 44px; height: 44px; border-radius: 50%; background: var(--green-700); color: var(--white); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1rem; margin: 0 auto 14px; }
  .how-step h3 { font-size: 1rem; font-weight: 700; margin-bottom: 6px; }
  .how-step p { font-size: 0.85rem; color: var(--g500); line-height: 1.5; }
  .proof-bar { background: var(--white); border-top: 1px solid var(--g100); border-bottom: 1px solid var(--g100); padding: 18px 24px; }
  .proof-inner { max-width: 900px; margin: 0 auto; display: flex; justify-content: center; align-items: center; gap: 32px; flex-wrap: wrap; }
  .proof-item { text-align: center; }
  .proof-val { font-size: 1.3rem; font-weight: 800; color: var(--green-700); letter-spacing: -0.5px; line-height: 1; }
  .proof-val-purple { color: #7c3aed; }
  .proof-lbl { font-size: 0.68rem; color: var(--g500); margin-top: 3px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
  .proof-sep { width: 1px; height: 28px; background: var(--g200); }
  @media (max-width: 600px) {
    .proof-inner { gap: 18px; }
    .proof-val { font-size: 1.1rem; }
    .proof-sep { display: none; }
  }
  .seller-cta { padding: 72px 32px; background: linear-gradient(135deg, var(--green-700) 0%, var(--green-900) 100%); color: var(--white); text-align: center; }
  .seller-cta h2 { font-size: 2rem; font-weight: 800; margin-bottom: 10px; }
  .seller-cta p { font-size: 1rem; opacity: 0.85; margin-bottom: 28px; max-width: 500px; margin-left: auto; margin-right: auto; }
  .seller-btn { display: inline-block; padding: 14px 36px; background: var(--white); color: var(--green-700); border-radius: 12px; font-weight: 700; font-size: 1rem; border: none; cursor: pointer; transition: all 0.2s; text-decoration: none; }
  .seller-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,0.2); text-decoration: none; }
  .seller-note { display: block; margin-top: 10px; font-size: 0.8rem; opacity: 0.65; }
  .ai-sec { padding: 40px 32px; }
  .ai-banner { max-width: 780px; margin: 0 auto; background: linear-gradient(135deg, #f8f4ff 0%, #f0e8ff 100%); border-radius: var(--r-xl); padding: 32px 36px; display: flex; align-items: center; gap: 28px; border: 1px solid #e8dff5; }
  .ai-icon { width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(135deg, #7c3aed, #4f46e5); display: flex; align-items: center; justify-content: center; font-size: 1.6rem; flex-shrink: 0; }
  .ai-text h3 { font-size: 1.05rem; font-weight: 700; margin-bottom: 4px; }
  .ai-text p { font-size: 0.85rem; color: var(--g500); line-height: 1.5; }
  .ai-logos { display: flex; gap: 10px; margin-top: 10px; }
  .ai-logo { padding: 6px 14px; background: var(--white); border-radius: 8px; font-size: 0.8rem; font-weight: 600; color: var(--g700); border: 1px solid #e8dff5; text-decoration: none; transition: all 0.2s; display: inline-flex; align-items: center; gap: 4px; }
  .ai-logo:hover { border-color: #7c3aed; color: #7c3aed; text-decoration: none; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(124,58,237,0.15); }
  @media (max-width: 768px) {
    .hero { padding: 40px 16px 32px; }
    .hero h1 { font-size: 2rem; }
    .stats-bar { gap: 20px; }
    .stat-n { font-size: 1.4rem; }
    .cats-grid { grid-template-columns: repeat(3, 1fr); }
    .cities-grid { grid-template-columns: 1fr; }
    .feat-grid { grid-template-columns: 1fr; }
    .how-grid { grid-template-columns: 1fr; gap: 20px; }
    .ai-banner { flex-direction: column; text-align: center; padding: 22px; }
    .ai-logos { justify-content: center; }
    .seller-cta h2 { font-size: 1.5rem; }
    .cv-grid { grid-template-columns: 1fr; }
  }
  /* Conversation showcase */
  .conv-showcase { background: var(--g50); }
  .cv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; max-width: 1100px; margin: 0 auto; padding: 0 24px; }
  .cv-card { background: var(--white); border-radius: var(--r-lg); border: 1px solid var(--g100); padding: 16px 20px; display: block; text-decoration: none; color: var(--charcoal); transition: all 0.2s; }
  .cv-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--green-100); text-decoration: none; }
  .cv-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .cv-agents { font-weight: 700; font-size: 0.88rem; }
  .cv-arrow { color: var(--g300); margin: 0 4px; }
  .cv-src { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
  .cv-preview { font-size: 0.8rem; color: var(--g500); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 8px; }
  .cv-foot { display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--g500); }
  .cv-time { color: var(--g300); }
  /* Phase 5.11 A6: Umbrella discovery section (homepage shortcut) */
  .umb-section { background: var(--white); }
  .umb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; max-width: 1100px; margin: 0 auto; }
  .umb-card { background: var(--white); border-radius: var(--r-lg); padding: 20px 22px; border: 1px solid var(--g100); transition: all 0.3s; text-decoration: none; color: var(--charcoal); display: block; }
  .umb-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--green-100); text-decoration: none; }
  .umb-card-badge { display: inline-block; padding: 3px 9px; background: var(--green-50); color: var(--green-700); border-radius: 10px; font-size: 0.7rem; font-weight: 600; margin-bottom: 8px; letter-spacing: 0.3px; }
  .umb-card-name { font-weight: 700; font-size: 1rem; margin-bottom: 4px; line-height: 1.3; }
  .umb-card-meta { font-size: 0.8rem; color: var(--g500); }
  .umb-section-more { text-align: center; margin-top: 18px; font-size: 0.85rem; }
  .umb-section-more a { color: var(--green-700); text-decoration: none; font-weight: 600; }
  .umb-section-more a:hover { text-decoration: underline; }
`;

router.get("/", (req: Request, res: Response) => {
  const lang = req.lang;
  try {
    const stats = marketplaceRegistry.getStats();
    const agents = marketplaceRegistry.getActiveAgents();
    const totalAgents = stats.totalAgents || agents.length;
    const traffic = getTrafficStats("rfb");

    const cityCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    agents.forEach((a: any) => {
      const city = a.city || a.location?.city;
      if (city) cityCounts[city] = (cityCounts[city] || 0) + 1;
      (a.categories || []).forEach((c: string) => {
        categoryCounts[c] = (categoryCounts[c] || 0) + 1;
      });
    });

    const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const cityIcons = ["\u{1F3D8}\uFE0F", "\u{1F3DB}\uFE0F", "\u2693", "\u{1F306}", "\u{1F304}", "\u{26F0}\uFE0F", "\u{26F5}", "\u{1F33F}"];

    // PR-85: marketplaceRegistry.getActiveAgents() does NOT populate
    // isClaimed (that's only set at API-response time in marketplace.ts:854).
    // For the homepage we need it for sort priority + render-tier decision,
    // so we hydrate it from knowledgeService.isAgentClaimed() on the
    // pre-filtered subset (~30-50 agents with trustScore >= 0.35). Same
    // approach for isVerified, which can also drift between data-source-
    // verified status and actual claim. We mutate the agent object in place
    // — it's a copy returned from getActiveAgents, not a shared singleton.
    const featuredCandidates = agents.filter((a: any) => a.trustScore >= 0.35);
    for (const a of featuredCandidates) {
      (a as any).isClaimed = knowledgeService.isAgentClaimed(a.id);
    }
    const featured = featuredCandidates
      .sort((a: any, b: any) => {
        // PR-84: claimed first, then verified, then trust
        if (a.isClaimed && !b.isClaimed) return -1;
        if (!a.isClaimed && b.isClaimed) return 1;
        if (a.isVerified && !b.isVerified) return -1;
        if (!a.isVerified && b.isVerified) return 1;
        return (b.trustScore || 0) - (a.trustScore || 0);
      })
      .slice(0, 16);

    const catCards = Object.entries(CATEGORY_MAP)
      .map(([_key, val]) => {
        const count = categoryCounts[_key] || 0;
        return `<a href="${localizedPath("/sok", lang)}?q=${encodeURIComponent(val.name.toLowerCase())}" class="cat-card">
          <span class="cat-emoji">${val.emoji}</span>
          <div class="cat-name">${val.name}</div>
          <div class="cat-count">${count} ${escapeHtml(t(lang, "home.cats_count_suffix"))}</div>
        </a>`;
      }).join("");

    const cityCards = topCities.map(([city, count], i) =>
      `<a href="${localizedPath("/" + slugify(city), lang)}" class="city-card">
        <div class="city-icon">${cityIcons[i] || "\u{1F33F}"}</div>
        <div><div class="city-name">${escapeHtml(city)}</div><div class="city-count">${count} ${escapeHtml(t(lang, "home.cats_count_suffix"))}</div></div>
      </a>`
    ).join("");

    const featuredCards = featured.map((a: any, i: number) => {
      if (i < 3 && a.isClaimed) {
        const info = knowledgeService.getAgentInfo(a.id);
        return producerCardUltraRich(a, info?.knowledge || {}, lang);
      }
      if (i < 11 && a.isClaimed) {
        const info = knowledgeService.getAgentInfo(a.id);
        return producerCardMediumRich(a, info?.knowledge || {}, lang);
      }
      return producerCard(a, undefined, lang);
    }).join("");

    // Phase 5.11 A6: Top-level umbrella shortcut (national-level only).
    // parent_umbrella_id IS NULL filters out lokallag/venues — those are
    // reachable via drilldown from the national umbrella profile.
    // Render-gated: if there are zero rows, the section is omitted.
    let umbrellaCards = "";
    let umbrellaSectionHtml = "";
    try {
      const umbDb = getDb();
      const umbRows = umbDb.prepare(`
        SELECT id, name, umbrella_type, umbrella_member_count
        FROM agents
        WHERE umbrella_type IS NOT NULL
          AND umbrella_type != 'venue'
          AND is_active = 1
          AND parent_umbrella_id IS NULL
        ORDER BY COALESCE(umbrella_member_count, 0) DESC, name ASC
        LIMIT 6
      `).all() as Array<{ id: string; name: string; umbrella_type: string; umbrella_member_count: number | null }>;

      if (umbRows.length > 0) {
        const umbBadgeLabel = lang === "en" ? "Market network" : "Marked-nettverk";
        const umbCountSuffix = lang === "en" ? "local chapters" : "lokallag";
        umbrellaCards = umbRows.map((u) => {
          const slug = slugify(u.name);
          const memberCount = u.umbrella_member_count || 0;
          const metaLine = memberCount > 0
            ? `${memberCount} ${escapeHtml(umbCountSuffix)}`
            : (lang === "en" ? "National network" : "Nasjonalt nettverk");
          return `<a href="/produsent/${slug}" class="umb-card">
            <span class="umb-card-badge">${escapeHtml(umbBadgeLabel)}</span>
            <div class="umb-card-name">${escapeHtml(u.name)}</div>
            <div class="umb-card-meta">${metaLine}</div>
          </a>`;
        }).join("");

        const umbLabel = lang === "en" ? "Markets & Networks" : "Markeder og paraplyer";
        const umbTitle = lang === "en" ? "Norwegian market networks" : "Markedsnettverk i Norge";
        const umbSub = lang === "en"
          ? "Discover food networks like Bondens marked — local farmers' markets nationwide."
          : "Oppdag matnettverk som Bondens marked — lokale bondemarkeder over hele landet.";

        umbrellaSectionHtml = `
    <section class="sec umb-section">
      <div class="sh">
        <div class="sh-label">${escapeHtml(umbLabel)}</div>
        <div class="sh-title">${escapeHtml(umbTitle)}</div>
        <div class="sh-sub">${escapeHtml(umbSub)}</div>
      </div>
      <div class="umb-grid">${umbrellaCards}</div>
    </section>`;
      }
    } catch (umbErr) {
      // Defensive: if the umbrella query fails (e.g. column missing in dev
      // DB pre-migration), skip the section entirely rather than crash the
      // homepage. Logged at warn-level.
      console.warn("[seo /] umbrella discovery query failed:", umbErr);
    }

    const uniqueCities = Object.keys(cityCounts).length;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": `${getConfig().display_name}`,
      "url": BASE_URL,
      "description": t(lang, "home.description", { count: totalAgents }),
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${BASE_URL}${localizedPath("/sok", lang)}?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    };

    const numFmt = lang === "en" ? "en-US" : "nb-NO";

    const content = `
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-pill"><span class="hero-dot"></span> ${t(lang, "home.hero_pill", { count: totalAgents })}</div>
        <h1>${t(lang, "home.hero_title")}</h1>
        <p class="hero-sub">${escapeHtml(t(lang, "home.hero_sub"))}</p>
        <div class="hero-search">
          <form action="${localizedPath("/sok", lang)}" method="GET">
            <input type="text" name="q" placeholder="${escapeHtml(t(lang, "home.search_placeholder"))}" aria-label="${escapeHtml(t(lang, "home.search_aria"))}">
            <button type="submit">${escapeHtml(t(lang, "home.search_btn"))}</button>
          </form>
        </div>
        <div class="hero-chips">
          <a href="${localizedPath("/sok", lang)}?q=${encodeURIComponent(lang === "en" ? "vegetables oslo" : "gr\u00f8nnsaker oslo")}" class="chip">\u{1F955} ${escapeHtml(t(lang, "home.chip_vegetables_oslo"))}</a>
          <a href="${localizedPath("/sok", lang)}?q=${encodeURIComponent(lang === "en" ? "honey oslo" : "honning oslo")}" class="chip">\u{1F36F} ${escapeHtml(t(lang, "home.chip_honey_bergen"))}</a>
          <a href="${localizedPath("/sok", lang)}?q=${encodeURIComponent(lang === "en" ? "organic meat" : "\u00f8kologisk kj\u00f8tt")}" class="chip">\u{1F969} ${escapeHtml(t(lang, "home.chip_organic_meat"))}</a>
          <a href="${localizedPath("/sok", lang)}?q=${encodeURIComponent(lang === "en" ? "farm shop" : "g\u00e5rdsbutikk")}" class="chip">\u{1F33F} ${escapeHtml(t(lang, "home.chip_farm_shops"))}</a>
        </div>
        <div class="ai-assist">
          <p class="ai-assist-label">${escapeHtml(t(lang, "home.ai_assist_label"))}</p>
          <div class="ai-assist-btns">
            <a href="https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-finn-lokal-mat-i-norge" target="_blank" rel="noopener" class="ai-btn ai-chatgpt">ChatGPT</a>
            <a href="${localizedPath("/teknologi", lang)}#claude-mcp" class="ai-btn ai-claude">Claude</a>
          </div>
          <p class="ai-assist-hint">${escapeHtml(t(lang, "home.ai_assist_hint"))} <a href="${localizedPath("/teknologi", lang)}#mcp-oppsett">${escapeHtml(t(lang, "home.ai_assist_setup_link"))}</a></p>
        </div>
        <div class="stats-bar">
          <div style="text-align:center"><div class="stat-n">${totalAgents}</div><div class="stat-l">${escapeHtml(t(lang, "home.stat_producers"))}</div></div>
          <div style="text-align:center"><div class="stat-n">${uniqueCities}</div><div class="stat-l">${escapeHtml(t(lang, "home.stat_cities"))}</div></div>
          <div style="text-align:center"><div class="stat-n">${Object.keys(categoryCounts).length}</div><div class="stat-l">${escapeHtml(t(lang, "home.stat_categories"))}</div></div>
        </div>
      </div>
    </section>

    <div class="proof-bar">
      <div class="proof-inner">
        <div class="proof-item">
          <div class="proof-val">${traffic.pageViews.toLocaleString(numFmt)}</div>
          <div class="proof-lbl">${escapeHtml(t(lang, "home.proof_pageviews"))}</div>
        </div>
        <div class="proof-sep"></div>
        <div class="proof-item">
          <div class="proof-val">${traffic.uniqueVisitors.toLocaleString(numFmt)}</div>
          <div class="proof-lbl">${escapeHtml(t(lang, "home.proof_unique"))}</div>
        </div>
        <div class="proof-sep"></div>
        <div class="proof-item">
          <div class="proof-val">${traffic.realHumans.toLocaleString(numFmt)}</div>
          <div class="proof-lbl">${escapeHtml(t(lang, "home.proof_humans"))}</div>
        </div>
        <div class="proof-sep"></div>
        <div class="proof-item">
          <div class="proof-val proof-val-purple">${traffic.botAndAi.toLocaleString(numFmt)}</div>
          <div class="proof-lbl">${escapeHtml(t(lang, "home.proof_bots"))}</div>
        </div>
      </div>
    </div>

    <section class="cats-section">
      <div class="sh" style="max-width:1100px;margin:0 auto 28px;">
        <div class="sh-label">${escapeHtml(t(lang, "home.cats_label"))}</div>
        <div class="sh-title">${escapeHtml(t(lang, "home.cats_title"))}</div>
      </div>
      <div class="cats-grid">${catCards}</div>
    </section>

    <section class="sec">
      <div class="sh">
        <div class="sh-label">${escapeHtml(t(lang, "home.explore_label"))}</div>
        <div class="sh-title">${escapeHtml(t(lang, "home.explore_title"))}</div>
        <div class="sh-sub">${escapeHtml(t(lang, "home.explore_sub"))}</div>
      </div>
      <div class="cities-grid">${cityCards}</div>
    </section>
${umbrellaSectionHtml}
    <section class="sec" style="background:var(--white);">
      <div class="sh">
        <div class="sh-label">${escapeHtml(t(lang, "home.discover_label"))}</div>
        <div class="sh-title">${escapeHtml(t(lang, "home.discover_title"))}</div>
        <div class="sh-sub">${escapeHtml(t(lang, "home.discover_sub"))}</div>
      </div>
      <div class="feat-grid">${featuredCards}</div>
    </section>

    <section class="sec how-sec">
      <div class="sh">
        <div class="sh-label">${escapeHtml(t(lang, "home.how_label"))}</div>
        <div class="sh-title">${escapeHtml(t(lang, "home.how_title"))}</div>
      </div>
      <div class="how-grid">
        <div class="how-step"><div class="how-num">1</div><h3>${escapeHtml(t(lang, "home.how_step1_title"))}</h3><p>${escapeHtml(t(lang, "home.how_step1_body"))}</p></div>
        <div class="how-step"><div class="how-num">2</div><h3>${escapeHtml(t(lang, "home.how_step2_title"))}</h3><p>${escapeHtml(t(lang, "home.how_step2_body"))}</p></div>
        <div class="how-step"><div class="how-num">3</div><h3>${escapeHtml(t(lang, "home.how_step3_title"))}</h3><p>${escapeHtml(t(lang, "home.how_step3_body"))}</p></div>
      </div>
    </section>

    <section class="seller-cta">
      <h2>${escapeHtml(t(lang, "home.seller_cta_title"))}</h2>
      <p>${escapeHtml(t(lang, "home.seller_cta_body"))}</p>
      <a href="/selger" class="seller-btn">${escapeHtml(t(lang, "home.seller_cta_btn"))}</a>
      <span class="seller-note">${escapeHtml(t(lang, "home.seller_cta_note"))}</span>
    </section>

    ${buildConversationShowcase(lang)}

    <section class="ai-sec">
      <div class="ai-banner">
        <div class="ai-icon">\u{1F916}</div>
        <div class="ai-text">
          <h3>${escapeHtml(t(lang, "home.ai_sec_title"))}</h3>
          <p>${escapeHtml(t(lang, "home.ai_sec_body"))}</p>
          <div class="ai-logos">
            <a href="https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-finn-lokal-mat-i-norge" target="_blank" rel="noopener" class="ai-logo">\u{1F4AC} ChatGPT</a>
            <a href="${localizedPath("/teknologi", lang)}#claude-mcp" class="ai-logo">\u{1F50C} Claude MCP</a>
            <a href="https://github.com/slookisen/lokal" target="_blank" rel="noopener" class="ai-logo">\u{2B50} GitHub</a>
          </div>
        </div>
      </div>
    </section>`;

    res.send(shell(
      t(lang, "home.title"),
      t(lang, "home.description", { count: totalAgents }),
      content,
      { canonical: BASE_URL + (lang === "en" ? "/en" : ""), jsonLd, extraCss: LANDING_CSS, lang, pathForAlternate: "/" }
    ));
  } catch (err) {
    console.error("SEO / error:", err);
    res.status(500).send(lang === "en" ? "Internal error" : "Intern feil");
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /sok?q=... — Search results
// ═══════════════════════════════════════════════════════════════

const SEARCH_CSS = `
  .search-hero { background: var(--green-50); padding: 32px 24px; }
  .search-hero .container { max-width: 1100px; margin: 0 auto; }
  .search-hero h1 { font-size: 1.6rem; font-weight: 800; color: var(--charcoal); margin-bottom: 16px; }
  .search-form { display: flex; gap: 0; max-width: 540px; }
  .search-form input { flex: 1; padding: 12px 18px; border: 2px solid var(--g200); border-right: none; border-radius: 10px 0 0 10px; font-size: 0.95rem; outline: none; }
  .search-form input:focus { border-color: var(--green-700); }
  .search-form button { padding: 12px 24px; background: var(--green-700); color: var(--white); border: 2px solid var(--green-700); border-radius: 0 10px 10px 0; font-weight: 700; font-size: 0.9rem; cursor: pointer; }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  @media (max-width: 768px) { .results-grid { grid-template-columns: 1fr; } }
`;

router.get("/sok", async (req: Request, res: Response) => {
  const lang = req.lang;
  const q = req.query.q as string;
  if (!q) { res.redirect(localizedPath("/", lang)); return; }

  try {
    const parsed = marketplaceRegistry.parseNaturalQuery(q);
    const heleNorge = req.query.heleNorge === "true";

    // Geocode location from query text (e.g. "honning oslo" → Oslo coords)
    if (!heleNorge && !parsed.location) {
      const frontendLat = parseFloat(req.query.lat as string);
      const frontendLng = parseFloat(req.query.lng as string);
      if (!isNaN(frontendLat) && !isNaN(frontendLng)) {
        parsed.location = { lat: frontendLat, lng: frontendLng };
        parsed.maxDistanceKm = parseFloat(req.query.radius as string) || 30;
      } else {
        const geoResult = await geocodingService.extractAndGeocode(q);
        if (geoResult) {
          parsed.location = { lat: geoResult.lat, lng: geoResult.lng };
          parsed.maxDistanceKm = geoResult.radiusKm;
        }
      }
    }

    // Preserve internal fields through Zod parsing (Zod strips unknown keys).
    // _nameQuery is critical: when present, discover() returns name-matched
    // agents anywhere in Norway and skips geo. Without this re-attach, /sok
    // silently fell back to geo-rank fallback and surfaced unrelated nearby
    // producers when the user typed a producer name not present locally.
    const productTerms = parsed._productTerms;
    const nameQuery = (parsed as any)._nameQuery as string | undefined;
    const query = DiscoveryQuerySchema.parse({ ...parsed, limit: 30, offset: 0 });
    if (productTerms) (query as any)._productTerms = productTerms;
    if (nameQuery) (query as any)._nameQuery = nameQuery;

    let results = marketplaceRegistry.discover(query);

    // If discover returned name-matched results (relevanceScore≥0.9 +
    // matchReasons starts with "Navnematch"), don't run the geo-fallback —
    // we already have the user's actual target. Mirrors /api/marketplace/search.
    const wasNameMatch = !!nameQuery && results.length > 0 &&
      results[0]?.matchReasons?.some((r: string) => r.startsWith("Navnematch"));

    // Auto-expanding radius if too few results.
    // Skip entirely when the first pass was a name match — name matches are
    // exact targets the user typed; widening geo would dilute them with
    // unrelated nearby producers (the bug Daniel hit on 2026-04-30 with
    // "Erga Gårdsutsalg": 7 random Trondheim hits instead of the 1 in Kleppe).
    const MIN_RESULTS = 3;
    if (parsed.location && results.length < MIN_RESULTS && !heleNorge && !wasNameMatch) {
      for (const radius of [50, 100, 200]) {
        if (results.length >= MIN_RESULTS) break;
        const expanded = DiscoveryQuerySchema.parse({ ...parsed, maxDistanceKm: radius, limit: 30, offset: 0 });
        if (productTerms) (expanded as any)._productTerms = productTerms;
        if (nameQuery) (expanded as any)._nameQuery = nameQuery;
        results = marketplaceRegistry.discover(expanded);
      }
      if (results.length < MIN_RESULTS) {
        const noGeo = DiscoveryQuerySchema.parse({ ...parsed, location: undefined, maxDistanceKm: undefined, limit: 30, offset: 0 });
        if (productTerms) (noGeo as any)._productTerms = productTerms;
        if (nameQuery) (noGeo as any)._nameQuery = nameQuery;
        results = marketplaceRegistry.discover(noGeo);
      }
    }

    const geoFiltered = !!parsed.location && !heleNorge;

    // ── Total-count probe ─────────────────────────────────────
    // The display block above renders `results.length` (capped at 30) — but
    // before this fix the header literally said "${N} treff" which made
    // every search look identical at "30 treff". Run one extra discover()
    // with a higher limit (capped at the schema max of 100) so we can
    // truthfully say "viser N av M" or "M+ treff". We don't need the rows;
    // just the count. Cheap because discover() is in-memory ranked.
    let totalCount = results.length;
    let totalAtMax = false;
    if (results.length >= 30) {
      try {
        const countQuery = DiscoveryQuerySchema.parse({
          ...parsed,
          location: heleNorge ? undefined : parsed.location,
          maxDistanceKm: heleNorge ? undefined : parsed.maxDistanceKm,
          limit: 100, offset: 0,
        });
        if (productTerms) (countQuery as any)._productTerms = productTerms;
        const countResults = marketplaceRegistry.discover(countQuery);
        totalCount = countResults.length;
        totalAtMax = totalCount >= 100;
      } catch { /* keep results.length as fallback */ }
    }
    const headerText = results.length >= totalCount
      ? `${totalCount}${totalAtMax ? "+" : ""} ${lang === "en" ? "results" : "treff"}`
      : `${lang === "en" ? "showing" : "viser"} ${results.length} ${lang === "en" ? "of" : "av"} ${totalCount}${totalAtMax ? "+" : ""}`;

    // ─── Fuzzy-match banner ──────────────────────────────────────
    // If discover() returned only relaxed matches ("Mulig navnematch"),
    // surface a small note so the user understands they got similar
    // names rather than exact matches. This is what Daniel hit when
    // searching "Dyrøy Sjømat" — actual producer is "Dyrøymat".
    const allFuzzy = results.length > 0 && results.every(
      (r: any) => r.matchReasons?.some((m: string) => m.startsWith("Mulig navnematch")),
    );

    // ─── Log web search as conversation (source: "web") ─────────
    // Captures human frontend searches in /samtaler alongside AI traffic.
    // Only top 1 match to avoid noise from casual browsing.
    if (results.length > 0) {
      try {
        conversationService.startConversation({
          sellerAgentId: results[0].agent.id,
          queryText: q,
          source: "web",
          buyerAgentName: "Besøkende",
          requestMeta: buildRequestMeta(req), // (item 3) internal-traffic classification
          autoRespond: true,
        });
      } catch { /* non-critical — don't break search if logging fails */ }
    }

    const resultCards = results.map((r: any) => producerCard(r.agent, r.matchReasons, lang)).join("");

    const heleNorgeLink = geoFiltered
      ? `<a href="${localizedPath("/sok", lang)}?q=${encodeURIComponent(q)}&heleNorge=true" style="display:inline-block;margin-top:12px;padding:7px 18px;background:var(--green-100,#e8f0e0);color:var(--green-700,#2D5016);border:1.5px solid var(--green-700,#2D5016);border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;">\u{1F30D} ${lang === "en" ? "Show all of Norway" : "Vis hele Norge"}</a>`
      : "";

    const geoNote = geoFiltered
      ? `<p style="color:var(--g500,#666);font-size:0.85rem;margin-top:8px;">${lang === "en" ? "Results filtered by location." : "Resultater filtrert etter sted."} ${heleNorgeLink}</p>`
      : "";

    const content = `
    <section class="search-hero">
      <div class="container">
        <div class="bc" style="padding:0 0 12px;"><a href="${localizedPath("/", lang)}">${lang === "en" ? "Home" : "Hjem"}</a><span>/</span>${escapeHtml(t(lang, "search.page_title"))}: \u201c${escapeHtml(q)}\u201d</div>
        <h1>${lang === "en" ? "Search results for" : "S\u00f8keresultater for"} \u201c${escapeHtml(q)}\u201d \u2014 ${headerText}</h1>
        ${allFuzzy ? `<p style="color:var(--g500,#666);font-size:0.9rem;margin-top:4px;">${lang === "en" ? "No exact name match for" : "Fant ingen eksakte navnematch for"} \u201c${escapeHtml(q)}\u201d \u2014 ${lang === "en" ? "showing producers with similar names." : "viser produsenter med lignende navn."}</p>` : ""}
        <form class="search-form" action="${localizedPath("/sok", lang)}" method="GET">
          <input type="text" name="q" value="${escapeHtml(q)}" aria-label="${escapeHtml(t(lang, "search.btn_search"))}">
          <button type="button" id="geoBtn" style="padding:12px 16px;background:var(--green-100,#e8f0e0);color:var(--green-700,#2D5016);border:2px solid var(--green-700,#2D5016);border-left:none;font-weight:700;font-size:0.85rem;cursor:pointer;white-space:nowrap;">\u{1F4CD} ${lang === "en" ? "Near me" : "N\u00e6r meg"}</button>
          <button type="submit">${escapeHtml(t(lang, "search.btn_search"))}</button>
        </form>
        ${geoNote}
      </div>
    </section>
    <section class="sec">
      ${results.length > 0
        ? `<div class="results-grid">${resultCards}</div>`
        : `<div style="text-align:center;padding:48px 0;color:var(--g500);">
            <p style="font-size:1.1rem;">${lang === "en" ? "No results for" : "Ingen resultater for"} \u201c${escapeHtml(q)}\u201d</p>
            <p style="margin-top:8px;"><a href="${localizedPath("/", lang)}">${lang === "en" ? "Try a different search" : "Pr\u00f8v et annet s\u00f8k"}</a></p>
          </div>`
      }
    </section>
    <script>
    (function() {
      var geoBtn = document.getElementById('geoBtn');
      if (!geoBtn || !navigator.geolocation) { if(geoBtn) geoBtn.style.display='none'; return; }
      geoBtn.addEventListener('click', function() {
        geoBtn.textContent = '\u23F3 Henter...';
        geoBtn.disabled = true;
        navigator.geolocation.getCurrentPosition(function(pos) {
          var form = geoBtn.closest('form');
          var q = form.querySelector('input[name=q]').value;
          window.location.href = "${localizedPath("/sok", lang)}?q=" + encodeURIComponent(q) + '&lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude + '&radius=30';
        }, function() {
          geoBtn.textContent = '\\u274C Avsl\u00e5tt';
          geoBtn.disabled = false;
          setTimeout(function() { geoBtn.innerHTML = '&#128205; N\u00e6r meg'; }, 2000);
        }, { enableHighAccuracy: false, timeout: 8000 });
      });
    })();
    </script>`;

    res.send(shell(
      `${q} \u2014 ${t(lang, "search.title")}`,
      `${lang === "en" ? "Search results for" : "S\u00f8keresultater for"} \u201c${q}\u201d.`,
      content,
      { canonical: `${BASE_URL}${localizedPath("/sok", lang)}?q=${encodeURIComponent(q)}`, extraCss: SEARCH_CSS, lang, pathForAlternate: `/sok?q=${encodeURIComponent(q)}` }
    ));
  } catch (err) {
    console.error("SEO /sok error:", err);
    res.status(500).send(lang === "en" ? "Internal error" : "Intern feil");
  }
});


// ═══════════════════════════════════════════════════════════════
// GET /om — Mission / About page
// ═══════════════════════════════════════════════════════════════

const OM_CSS = `
  .om-hero { background: linear-gradient(135deg, var(--green-50) 0%, #f0f7f4 100%); padding: 64px 24px 48px; text-align: center; }
  .om-hero h1 { font-size: 2.6rem; font-weight: 800; color: var(--charcoal); letter-spacing: -1.5px; margin-bottom: 16px; }
  .om-hero h1 em { color: var(--green-700); font-style: normal; }
  .om-hero p { font-size: 1.15rem; color: var(--g500); max-width: 600px; margin: 0 auto; line-height: 1.7; }
  .om-sec { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  .om-sec h2 { font-size: 1.6rem; font-weight: 800; color: var(--charcoal); margin-bottom: 16px; }
  .om-sec p { font-size: 1rem; color: var(--g700); line-height: 1.8; margin-bottom: 16px; }
  .om-values { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; margin: 32px 0; }
  .om-val { background: var(--white); border: 1px solid var(--g100); border-radius: var(--r-lg); padding: 24px; }
  .om-val-icon { font-size: 1.8rem; margin-bottom: 10px; display: block; }
  .om-val h3 { font-size: 1rem; font-weight: 700; margin-bottom: 6px; }
  .om-val p { font-size: 0.88rem; color: var(--g500); margin-bottom: 0; }
  .om-quote { background: var(--green-50); border-left: 4px solid var(--green-700); border-radius: 0 12px 12px 0; padding: 24px 28px; margin: 32px 0; }
  .om-quote p { font-size: 1.05rem; font-style: italic; color: var(--green-900); margin-bottom: 0; }
  @media (max-width: 768px) {
    .om-hero h1 { font-size: 1.8rem; }
    .om-values { grid-template-columns: 1fr; }
  }
`;

router.get("/om", (req: Request, res: Response) => {
  const lang = req.lang;
  const brand = `<span translate="no">${getConfig().display_name}</span>`;
  const en = lang === "en";
  const content = en ? `
  <section class="om-hero">
    <h1>Food deserves to be <em>found</em></h1>
    <p>${brand} makes local ${getConfig().domain_dictionary.entity_plural_long} visible \u2014 not only to people, but to the AI assistants that help them shop.</p>
  </section>

  <section class="om-sec">
    <h2>Why we're building this</h2>
    <p>Norway has hundreds of farm shops, markets and small-scale producers making outstanding food. Yet most of them are invisible online. They have no marketing department, no SEO strategy, and when someone asks an AI assistant \u201cwhere can I find fresh vegetables near me?\u201d \u2014 they never get the answer.</p>
    <p>So customers shop at the big chains. Not because the food is better, but because the big chains are visible and the small ones aren't.</p>
    <p>We're changing that.</p>

    <div class="om-quote">
      <p>\u201cIf your AI assistant doesn't know the farm shop exists, it doesn't exist for you.\u201d</p>
    </div>

    <h2>What we do</h2>
    <p>${brand} is an open catalogue that automatically collects information about local ${getConfig().domain_dictionary.entity_plural_long} \u2014 products, opening hours, contact info, certifications \u2014 and makes it all available through standard protocols that AI systems understand.</p>
    <p>When someone asks ChatGPT, Claude or another AI assistant about local food in Norway, they find the answers here.</p>

    <div class="om-values">
      <div class="om-val">
        <span class="om-val-icon">&#127793;</span>
        <h3>Straight from the farmer</h3>
        <p>No middlemen. The customer finds the producer and buys directly.</p>
      </div>
      <div class="om-val">
        <span class="om-val-icon">&#129302;</span>
        <h3>AI visibility</h3>
        <p>Structured data that AI assistants understand. Not just text on a website.</p>
      </div>
      <div class="om-val">
        <span class="om-val-icon">&#128275;</span>
        <h3>Open platform</h3>
        <p>Free to join. No ads, no paid placements, no algorithms that favour the big players.</p>
      </div>
      <div class="om-val">
        <span class="om-val-icon">&#127987;</span>
        <h3>Norway first</h3>
        <p>Built for Norwegian farms, markets and food traditions. <span translate="no">Oslo</span> first, the rest of the country to follow.</p>
      </div>
    </div>

    <h2>Our vision</h2>
    <p>We believe the future of commerce is about visibility. Whoever gets found, gets the customer. We're building the infrastructure that lets local producers compete on equal terms with the big chains \u2014 in a world where more and more shopping happens through AI.</p>
    <p>${brand} is a non-profit initiative. The code is open source.</p>
  </section>` : `
  <section class="om-hero">
    <h1>Maten fortjener \u00e5 bli <em>funnet</em></h1>
    <p>${brand} gj\u00f8r lokale ${getConfig().domain_dictionary.entity_plural_long} synlige \u2014 ikke bare for mennesker, men for AI-assistentene som hjelper dem \u00e5 handle.</p>
  </section>

  <section class="om-sec">
    <h2>Hvorfor vi bygger dette</h2>
    <p>Norge har hundrevis av g\u00e5rdsbutikker, markeder og sm\u00e5skalaprodusenter som lager fantastisk mat. Men de fleste er usynlige p\u00e5 nett. De har ingen markedsavdeling, ingen SEO-strategi, og n\u00e5r noen sp\u00f8r en AI-assistent \u00abhvor finner jeg ferske gr\u00f8nnsaker n\u00e6r meg?\u00bb \u2014 f\u00e5r de aldri svaret.</p>
    <p>Det betyr at kundene handler hos de store kjedene. Ikke fordi maten er bedre, men fordi de store er synlige og de sm\u00e5 ikke er det.</p>
    <p>Vi endrer p\u00e5 det.</p>

    <div class="om-quote">
      <p>\u00abHvis AI-assistenten din ikke vet at g\u00e5rdsbutikken finnes, finnes den ikke for deg.\u00bb</p>
    </div>

    <h2>Hva vi gj\u00f8r</h2>
    <p>${brand} er en \u00e5pen katalog som automatisk samler informasjon om lokale ${getConfig().domain_dictionary.entity_plural_long} \u2014 produkter, \u00e5pningstider, kontaktinfo, sertifiseringer \u2014 og gj\u00f8r alt tilgjengelig via standardprotokoller som AI-systemer forst\u00e5r.</p>
    <p>N\u00e5r noen sp\u00f8r ChatGPT, Claude eller en annen AI-assistent om lokal mat i Norge, finner de svarene her.</p>

    <div class="om-values">
      <div class="om-val">
        <span class="om-val-icon">&#127793;</span>
        <h3>Direkte fra bonden</h3>
        <p>Ingen mellomledd. Kunden finner produsenten og handler direkte.</p>
      </div>
      <div class="om-val">
        <span class="om-val-icon">&#129302;</span>
        <h3>AI-synlighet</h3>
        <p>Strukturert data som AI-assistenter forst\u00e5r. Ikke bare tekst p\u00e5 en nettside.</p>
      </div>
      <div class="om-val">
        <span class="om-val-icon">&#128275;</span>
        <h3>\u00c5pen plattform</h3>
        <p>Gratis \u00e5 v\u00e6re med. Ingen annonser, ingen betalte plasseringer, ingen algoritmer som favoriserer de store.</p>
      </div>
      <div class="om-val">
        <span class="om-val-icon">&#127987;</span>
        <h3>Norsk f\u00f8rst</h3>
        <p>Bygget for norske g\u00e5rder, markeder og mattradisjoner. <span translate="no">Oslo</span> f\u00f8rst, hele landet etter.</p>
      </div>
    </div>

    <h2>Visjonen v\u00e5r</h2>
    <p>Vi tror at fremtidens handel handler om synlighet. Den som blir funnet, f\u00e5r kunden. Vi bygger infrastrukturen som gj\u00f8r at lokale produsenter konkurrerer p\u00e5 like vilk\u00e5r med de store kjedene \u2014 i en verden der stadig flere handler gjennom AI.</p>
    <p>${brand} er et non-profit initiativ. Koden er \u00e5pen kildekode.</p>
  </section>`;

  res.send(shell(
    t(lang, "about.title"),
    t(lang, "about.description"),
    content,
    { canonical: `${BASE_URL}${localizedPath("/om", lang)}`, extraCss: OM_CSS, lang, pathForAlternate: "/om" }
  ));
});

// ═══════════════════════════════════════════════════════════════
// GET /teknologi — How it works (technical) page
// ═══════════════════════════════════════════════════════════════

const TECH_CSS = `
  .tech-hero { background: linear-gradient(135deg, #f8f4ff 0%, #f0e8ff 100%); padding: 64px 24px 48px; text-align: center; }
  .tech-hero h1 { font-size: 2.4rem; font-weight: 800; color: var(--charcoal); letter-spacing: -1.2px; margin-bottom: 16px; }
  .tech-hero p { font-size: 1.15rem; color: var(--g500); max-width: 620px; margin: 0 auto; line-height: 1.7; }
  .tech-sec { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  .tech-sec h2 { font-size: 1.5rem; font-weight: 800; color: var(--charcoal); margin-bottom: 16px; }
  .tech-sec p { font-size: 1rem; color: var(--g700); line-height: 1.8; margin-bottom: 16px; }
  .tech-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 32px 0; }
  .tech-card { border-radius: var(--r-lg); padding: 28px; border: 1px solid var(--g100); }
  .tech-card.old { background: #fff8f8; border-color: #fecaca; }
  .tech-card.new { background: #f0fdf4; border-color: #bbf7d0; }
  .tech-card h3 { font-size: 1.05rem; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .tech-card ul { list-style: none; padding: 0; }
  .tech-card li { font-size: 0.88rem; color: var(--g700); padding: 4px 0; padding-left: 20px; position: relative; }
  .tech-card.old li::before { content: "\u2717"; position: absolute; left: 0; color: #ef4444; }
  .tech-card.new li::before { content: "\u2713"; position: absolute; left: 0; color: #16a34a; }
  .tech-proto { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin: 32px 0; }
  .proto-card { background: var(--white); border: 1px solid var(--g100); border-radius: var(--r-lg); padding: 22px; text-align: center; }
  .proto-icon { font-size: 2rem; margin-bottom: 8px; display: block; }
  .proto-card h3 { font-size: 0.95rem; font-weight: 700; margin-bottom: 6px; }
  .proto-card p { font-size: 0.82rem; color: var(--g500); margin-bottom: 0; }
  .tech-code { background: #1e293b; color: #e2e8f0; border-radius: 12px; padding: 20px 24px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.82rem; line-height: 1.7; overflow-x: auto; margin: 20px 0; }
  .tech-code .comment { color: #64748b; }
  .tech-code .key { color: #7dd3fc; }
  .tech-code .val { color: #86efac; }
  .setup-guide { background: var(--white); border: 1px solid var(--g100); border-radius: var(--r-lg); padding: 28px; margin: 24px 0; }
  .setup-guide h3 { font-size: 1.1rem; font-weight: 700; margin-bottom: 12px; }
  .setup-guide p { font-size: 0.9rem; }
  .setup-guide code { background: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-size: 0.85rem; font-family: "SF Mono", "Fira Code", monospace; color: var(--green-700); }
  .setup-steps { display: flex; flex-direction: column; gap: 12px; }
  .setup-step { display: flex; gap: 14px; align-items: flex-start; }
  .step-n { width: 28px; height: 28px; background: var(--green-700); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.82rem; font-weight: 700; flex-shrink: 0; }
  .setup-step div { font-size: 0.9rem; color: var(--g700); line-height: 1.6; }
  .setup-step a { color: var(--green-700); }
  @media (max-width: 768px) {
    .tech-hero h1 { font-size: 1.7rem; }
    .tech-compare { grid-template-columns: 1fr; }
    .tech-proto { grid-template-columns: 1fr 1fr; }
  }
`;

router.get("/teknologi", (req: Request, res: Response) => {
  const lang = req.lang;
  const stats = marketplaceRegistry.getStats();
  const totalAgents = stats.totalAgents || marketplaceRegistry.getActiveAgents().length;
  const brand = `<span translate="no">${getConfig().display_name}</span>`;
  const en = lang === "en";
  const content = en ? `
  <section class="tech-hero">
    <h1>How your AI finds the food</h1>
    <p>Traditional SEO is about ranking high on Google. We're building something different: structured data that AI assistants understand directly.</p>
  </section>

  <section class="tech-sec">
    <h2>The problem with Google search</h2>
    <p>When you search for "local food in <span translate="no">Oslo</span>" on Google, you get ads, big grocery chains, and maybe a blog post. The small producers drown.</p>
    <p>AI assistants work differently. They don't read websites \u2014 they fetch structured data from protocols designed for machine-to-machine communication.</p>

    <div class="tech-compare">
      <div class="tech-card old">
        <h3>&#128269; Traditional search</h3>
        <ul>
          <li>Based on website ranking</li>
          <li>Favours large players with SEO budgets</li>
          <li>Ads dominate the results</li>
          <li>Text designed for humans</li>
        </ul>
      </div>
      <div class="tech-card new">
        <h3>&#129302; AI-driven search</h3>
        <ul>
          <li>Based on structured, verified data</li>
          <li>Equal terms for all producers</li>
          <li>No ads in the results</li>
          <li>Data designed for machines</li>
        </ul>
      </div>
    </div>

    <h2>The protocols we use</h2>
    <p>${brand} uses open standards that let any AI assistant find and understand information about Norwegian ${getConfig().domain_dictionary.entity_plural_long}:</p>

    <div class="tech-proto">
      <div class="proto-card">
        <span class="proto-icon">&#127760;</span>
        <h3 translate="no">A2A</h3>
        <p>Google's Agent-to-Agent protocol. Agents communicate directly with each other.</p>
      </div>
      <div class="proto-card">
        <span class="proto-icon">&#128268;</span>
        <h3 translate="no">MCP</h3>
        <p>Anthropic's Model Context Protocol. Claude and other AIs fetch data as tools.</p>
      </div>
      <div class="proto-card">
        <span class="proto-icon">&#128214;</span>
        <h3 translate="no">Schema.org</h3>
        <p>Structured markup that Google Rich Results understands.</p>
      </div>
      <div class="proto-card">
        <span class="proto-icon">&#128736;</span>
        <h3 translate="no">OpenAPI</h3>
        <p>Standard API specification. Any developer can integrate.</p>
      </div>
    </div>

    <h2>How it works in practice</h2>
    <p>Here's an example of what happens when you ask an AI assistant "where can I find fresh vegetables in <span translate="no">Oslo</span>?":</p>

    <div class="tech-code">
      <span class="comment">// 1. The AI assistant sends a request via the A2A protocol</span><br>
      <span class="key">POST</span> rettfrabonden.com/api/a2a<br><br>
      <span class="comment">// 2. Our agent finds relevant producers</span><br>
      { <span class="key">"query"</span>: <span class="val">"vegetables oslo"</span>, <span class="key">"results"</span>: [...] }<br><br>
      <span class="comment">// 3. Structured data returns with opening hours, contact info, certifications</span><br>
      { <span class="key">"name"</span>: <span class="val">"Gr\u00f8nn Bonde"</span>, <span class="key">"hours"</span>: <span class="val">"Mon\u2013Sat 08\u201316"</span> }
    </div>

    <p>Everything happens automatically. The producer doesn't have to do anything \u2014 we collect data from public sources, verify it, and make it available to all AI platforms.</p>

    <h2 id="mcp-oppsett">Set up MCP \u2014 search from your AI</h2>
    <p>MCP (Model Context Protocol) lets your AI assistant search our database of ${totalAgents}+ ${getConfig().domain_dictionary.entity_plural_long} directly. Here's how to set it up:</p>

    <div id="chatgpt-mcp" class="setup-guide">
      <h3>&#128154; ChatGPT (easiest)</h3>
      <div class="setup-steps">
        <div class="setup-step"><span class="step-n">1</span><div>Go to <a href="https://chatgpt.com" target="_blank">chatgpt.com</a> and open a new conversation</div></div>
        <div class="setup-step"><span class="step-n">2</span><div>Click the tools icon (&#128295;) in the message field and choose <strong>"Add an MCP Server"</strong></div></div>
        <div class="setup-step"><span class="step-n">3</span><div>Paste this URL: <code>https://rettfrabonden.com/mcp</code></div></div>
        <div class="setup-step"><span class="step-n">4</span><div>Done! Try for example <em>"Find organic honey in <span translate="no">Bergen</span>"</em></div></div>
      </div>
    </div>

    <div id="claude-mcp" class="setup-guide">
      <h3>&#129520; Claude Desktop (Pro/Max/Team/Enterprise)</h3>
      <p><strong>Method 1 \u2014 Remote MCP (recommended, no install):</strong></p>
      <div class="setup-steps">
        <div class="setup-step"><span class="step-n">1</span><div>Open Claude Desktop &rarr; <strong>Settings</strong> &rarr; <strong>Integrations</strong></div></div>
        <div class="setup-step"><span class="step-n">2</span><div>Click <strong>"Add custom connector"</strong></div></div>
        <div class="setup-step"><span class="step-n">3</span><div>Paste: <code>https://rettfrabonden.com/mcp</code></div></div>
        <div class="setup-step"><span class="step-n">4</span><div>Done! Try for example <em>"Find organic meat in <span translate="no">Trondheim</span>"</em></div></div>
      </div>
      <p style="font-size:0.82rem;color:var(--g500);margin-top:14px;"><strong>Method 2 \u2014 Local npm package</strong> (for developers, Claude Code, or Claude Desktop without Pro):</p>
      <div class="setup-steps">
        <div class="setup-step"><span class="step-n">1</span><div>Install <a href="https://nodejs.org" target="_blank">Node.js</a> &rarr; Open Claude Desktop &rarr; Settings &rarr; Developer &rarr; <strong>Edit Config</strong></div></div>
        <div class="setup-step"><span class="step-n">2</span><div>Add:
          <div class="tech-code" style="margin:8px 0 0;font-size:0.8rem;">
{<br>
&nbsp;&nbsp;<span class="key">"mcpServers"</span>: {<br>
&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"lokal"</span>: {<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"command"</span>: <span class="val">"npx"</span>,<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"args"</span>: [<span class="val">"lokal-mcp"</span>]<br>
&nbsp;&nbsp;&nbsp;&nbsp;}<br>
&nbsp;&nbsp;}<br>
}
          </div>
        </div></div>
        <div class="setup-step"><span class="step-n">3</span><div>Save (Ctrl+S) and restart Claude Desktop.</div></div>
      </div>
    </div>

    <div class="setup-guide">
      <h3>&#9881;&#65039; Other AI platforms</h3>
      <p>Any platform that supports MCP Streamable HTTP can connect: <code>https://rettfrabonden.com/mcp</code></p>
      <p>For REST-based integrations, see our <a href="/openapi.json">OpenAPI specification</a>.</p>
    </div>

    <h2>Open source</h2>
    <p>The whole project is open source. We believe infrastructure for food visibility should be a shared good, not a commercial product.</p>
    <p><a href="https://github.com/slookisen/lokal" style="display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:var(--charcoal);color:var(--white);border-radius:10px;font-weight:600;font-size:0.9rem;">See the code on GitHub &#8594;</a></p>
  </section>` : `
  <section class="tech-hero">
    <h1>Slik finner AI-en din maten</h1>
    <p>Tradisjonell SEO handler om \u00e5 rangere h\u00f8yt i Google. Vi bygger noe annet: strukturert data som AI-assistenter forst\u00e5r direkte.</p>
  </section>

  <section class="tech-sec">
    <h2>Problemet med Google-s\u00f8k</h2>
    <p>N\u00e5r du s\u00f8ker \u00ablokal mat i Oslo\u00bb p\u00e5 Google, f\u00e5r du annonser, store matvarekjeder, og kanskje en bloggpost. De sm\u00e5 produsentene drukner.</p>
    <p>AI-assistenter fungerer annerledes. De leser ikke nettsider \u2014 de henter strukturert data fra protokoller som er designet for maskin-til-maskin-kommunikasjon.</p>

    <div class="tech-compare">
      <div class="tech-card old">
        <h3>&#128269; Tradisjonelt s\u00f8k</h3>
        <ul>
          <li>Basert p\u00e5 nettside-rangering</li>
          <li>Favoriserer store akt\u00f8rer med SEO-budsjett</li>
          <li>Annonser dominerer resultatene</li>
          <li>Tekst designet for mennesker</li>
        </ul>
      </div>
      <div class="tech-card new">
        <h3>&#129302; AI-drevet s\u00f8k</h3>
        <ul>
          <li>Basert p\u00e5 strukturert, verifisert data</li>
          <li>Like vilk\u00e5r for alle produsenter</li>
          <li>Ingen annonser i resultatene</li>
          <li>Data designet for maskiner</li>
        </ul>
      </div>
    </div>

    <h2>Protokollene vi bruker</h2>
    <p>${brand} bruker \u00e5pne standarder som gj\u00f8r at enhver AI-assistent kan finne og forst\u00e5 informasjon om norske ${getConfig().domain_dictionary.entity_plural_long}:</p>

    <div class="tech-proto">
      <div class="proto-card">
        <span class="proto-icon">&#127760;</span>
        <h3>A2A</h3>
        <p>Googles Agent-to-Agent-protokoll. Agenter kommuniserer direkte med hverandre.</p>
      </div>
      <div class="proto-card">
        <span class="proto-icon">&#128268;</span>
        <h3>MCP</h3>
        <p>Anthropics Model Context Protocol. Claude og andre AI-er henter data som verkt\u00f8y.</p>
      </div>
      <div class="proto-card">
        <span class="proto-icon">&#128214;</span>
        <h3>Schema.org</h3>
        <p>Strukturert markup som Google Rich Results forst\u00e5r.</p>
      </div>
      <div class="proto-card">
        <span class="proto-icon">&#128736;</span>
        <h3>OpenAPI</h3>
        <p>Standard API-spesifikasjon. Alle utviklere kan integrere.</p>
      </div>
    </div>

    <h2>Slik fungerer det i praksis</h2>
    <p>Her er et eksempel p\u00e5 hva som skjer n\u00e5r du sp\u00f8r en AI-assistent \u00abhvor finner jeg ferske gr\u00f8nnsaker i Oslo?\u00bb:</p>

    <div class="tech-code">
      <span class="comment">// 1. AI-assistenten sender en foresp\u00f8rsel via A2A-protokollen</span><br>
      <span class="key">POST</span> rettfrabonden.com/api/a2a<br><br>
      <span class="comment">// 2. V\u00e5r agent finner relevante produsenter</span><br>
      { <span class="key">"query"</span>: <span class="val">"gr\u00f8nnsaker oslo"</span>, <span class="key">"results"</span>: [...] }<br><br>
      <span class="comment">// 3. Strukturert data returneres med \u00e5pningstider, kontaktinfo, sertifiseringer</span><br>
      { <span class="key">"name"</span>: <span class="val">"Gr\u00f8nn Bonde"</span>, <span class="key">"hours"</span>: <span class="val">"Man-L\u00f8r 08-16"</span> }
    </div>

    <p>Alt skjer automatisk. Produsenten trenger ikke gj\u00f8re noe \u2014 vi samler data fra offentlige kilder, verifiserer det, og gj\u00f8r det tilgjengelig for alle AI-plattformer.</p>

    <h2 id="mcp-oppsett">Sett opp MCP &mdash; s\u00f8k fra din AI</h2>
    <p>MCP (Model Context Protocol) lar AI-assistenten din s\u00f8ke direkte i v\u00e5r database med ${totalAgents}+ ${getConfig().domain_dictionary.entity_plural_long}. Her er hvordan du setter det opp:</p>

    <div id="chatgpt-mcp" class="setup-guide">
      <h3>&#128154; ChatGPT (enklest)</h3>
      <div class="setup-steps">
        <div class="setup-step"><span class="step-n">1</span><div>G\u00e5 til <a href="https://chatgpt.com" target="_blank">chatgpt.com</a> og \u00e5pne en ny samtale</div></div>
        <div class="setup-step"><span class="step-n">2</span><div>Klikk p\u00e5 verkt\u00f8y-ikonet (&#128295;) i meldingsfeltet og velg <strong>&laquo;Add an MCP Server&raquo;</strong></div></div>
        <div class="setup-step"><span class="step-n">3</span><div>Lim inn denne URL-en: <code>https://rettfrabonden.com/mcp</code></div></div>
        <div class="setup-step"><span class="step-n">4</span><div>Ferdig! Sp\u00f8r f.eks. <em>&laquo;Finn \u00f8kologisk honning i Bergen&raquo;</em></div></div>
      </div>
    </div>

    <div id="claude-mcp" class="setup-guide">
      <h3>&#129520; Claude Desktop (Pro/Max/Team/Enterprise)</h3>
      <p><strong>Metode 1 \u2014 Remote MCP (anbefalt, ingen installasjon):</strong></p>
      <div class="setup-steps">
        <div class="setup-step"><span class="step-n">1</span><div>\u00c5pne Claude Desktop &rarr; <strong>Settings</strong> &rarr; <strong>Integrations</strong></div></div>
        <div class="setup-step"><span class="step-n">2</span><div>Klikk <strong>&laquo;Add custom connector&raquo;</strong></div></div>
        <div class="setup-step"><span class="step-n">3</span><div>Lim inn: <code>https://rettfrabonden.com/mcp</code></div></div>
        <div class="setup-step"><span class="step-n">4</span><div>Ferdig! Sp\u00f8r f.eks. <em>&laquo;Finn \u00f8kologisk kj\u00f8tt i Trondheim&raquo;</em></div></div>
      </div>
      <p style="font-size:0.82rem;color:var(--g500);margin-top:14px;"><strong>Metode 2 \u2014 Lokal npm-pakke</strong> (for utviklere, Claude Code, eller Claude Desktop uten Pro):</p>
      <div class="setup-steps">
        <div class="setup-step"><span class="step-n">1</span><div>Installer <a href="https://nodejs.org" target="_blank">Node.js</a> &rarr; \u00c5pne Claude Desktop &rarr; Settings &rarr; Developer &rarr; <strong>Edit Config</strong></div></div>
        <div class="setup-step"><span class="step-n">2</span><div>Legg til:
          <div class="tech-code" style="margin:8px 0 0;font-size:0.8rem;">
{<br>
&nbsp;&nbsp;<span class="key">"mcpServers"</span>: {<br>
&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"lokal"</span>: {<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"command"</span>: <span class="val">"npx"</span>,<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"args"</span>: [<span class="val">"lokal-mcp"</span>]<br>
&nbsp;&nbsp;&nbsp;&nbsp;}<br>
&nbsp;&nbsp;}<br>
}
          </div>
        </div></div>
        <div class="setup-step"><span class="step-n">3</span><div>Lagre (Ctrl+S) og start Claude Desktop p\u00e5 nytt.</div></div>
      </div>
    </div>

    <div class="setup-guide">
      <h3>&#9881;&#65039; Andre AI-plattformer</h3>
      <p>Alle plattformer som st\u00f8tter MCP Streamable HTTP kan koble seg til: <code>https://rettfrabonden.com/mcp</code></p>
      <p>For REST-baserte integrasjoner, se v\u00e5r <a href="/openapi.json">OpenAPI-spesifikasjon</a>.</p>
    </div>

    <h2>\u00c5pen kildekode</h2>
    <p>Hele prosjektet er \u00e5pen kildekode. Vi tror at infrastruktur for matsynlighet b\u00f8r v\u00e6re et fellesgode, ikke et kommersielt produkt.</p>
    <p><a href="https://github.com/slookisen/lokal" style="display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:var(--charcoal);color:var(--white);border-radius:10px;font-weight:600;font-size:0.9rem;">Se koden p\u00e5 GitHub &#8594;</a></p>
  </section>`;

  res.send(shell(
    t(lang, "tech.title"),
    t(lang, "tech.description"),
    content,
    { canonical: `${BASE_URL}${localizedPath("/teknologi", lang)}`, extraCss: TECH_CSS, lang, pathForAlternate: "/teknologi" }
  ));
});


// ═══════════════════════════════════════════════════════════════
// GET /guide-mat-ai — "Finn norsk lokalmat via AI/MCP" usage guide
// (dev-request 2026-06-30-mcp-distribution-traffic-growth, Track C:
// usage-content — autonomous, in-charter: improving discoverability of the
// already-shipped `lokal` MCP server, not a new feature/vertical.)
//
// Static, hand-authored how-to page cross-referencing the REAL lokal_*
// tools registered in src/routes/mcp.ts — never invented names. Cross-links
// to /teknologi#mcp-oppsett for the ChatGPT/Claude Desktop setup steps
// rather than repeating them here (that page already owns setup).
// ═══════════════════════════════════════════════════════════════

const GUIDE_MAT_AI_CSS = `
  .gma-hero { background: linear-gradient(135deg, #f0f7ed 0%, #e8f5e0 100%); padding: 64px 24px 48px; text-align: center; }
  .gma-hero h1 { font-size: 2.3rem; font-weight: 800; color: var(--charcoal); letter-spacing: -1.1px; margin-bottom: 16px; }
  .gma-hero p { font-size: 1.1rem; color: var(--g500); max-width: 640px; margin: 0 auto; line-height: 1.7; }
  .gma-sec { max-width: 780px; margin: 0 auto; padding: 44px 24px; }
  .gma-sec h2 { font-size: 1.4rem; font-weight: 800; color: var(--charcoal); margin-bottom: 14px; }
  .gma-sec p { font-size: 1rem; color: var(--g700); line-height: 1.75; margin-bottom: 14px; }
  .gma-group-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--green-700); margin: 24px 0 8px; }
  .gma-tools { display: grid; gap: 12px; margin: 8px 0 20px; }
  .gma-tool { background: var(--white); border: 1px solid var(--g100); border-radius: var(--r-lg); padding: 16px 20px; }
  .gma-tool code { background: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.86rem; color: var(--green-700); font-weight: 700; }
  .gma-tool p { margin: 8px 0 0; font-size: 0.9rem; color: var(--g700); }
  .gma-examples { background: #f8fafc; border-radius: var(--r-lg); padding: 20px 24px; margin: 8px 0 20px; }
  .gma-examples li { font-size: 0.94rem; color: var(--g700); margin-bottom: 8px; font-style: italic; }
  .gma-cta { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; background: var(--green-700); color: var(--white); border-radius: 10px; font-weight: 600; font-size: 0.9rem; }
  .gma-faq-item { margin-bottom: 18px; }
  .gma-faq-item h3 { font-size: 1rem; font-weight: 700; color: var(--charcoal); margin-bottom: 6px; }
  .gma-faq-item p { font-size: 0.92rem; color: var(--g700); margin: 0; }
  @media (max-width: 768px) { .gma-hero h1 { font-size: 1.7rem; } }
`;

// Static FAQ content for /guide-mat-ai. Unlike buildProducerFaqJsonLd this
// content is fixed/curated editorial copy, not derived from a possibly-thin
// DB row, so there is no 2-real-facts quality gate here — the page always
// emits its FAQPage block. Exported for tests.
export function buildMcpGuideFaqJsonLd(lang: Lang, url: string): any {
  const en = lang === "en";
  const qas: Array<{ q: string; a: string }> = en ? [
    {
      q: "Which AI assistants can I use to find local food producers?",
      a: "Any assistant that supports the Model Context Protocol (MCP) can connect — including Claude Desktop, ChatGPT (Developer Mode / custom connectors), Cursor, and other MCP clients. Connect via https://rettfrabonden.com/mcp or the lokal-mcp npm package.",
    },
    {
      q: "What tools does the lokal MCP server expose?",
      a: "lokal_search and lokal_discover find producers by name, product, or location; lokal_info returns a producer's full price list and contact details; lokal_geocode resolves Norwegian place names to coordinates; lokal_list_umbrellas, lokal_get_umbrella_members, and lokal_get_producer_affiliations cover markets (Bondens marked, REKO) and certifications (Debio); lokal_bm_next_markets lists upcoming market days; and a cart flow (lokal_cart_create, lokal_cart_add_item, lokal_cart_view, lokal_cart_submit, lokal_order_status) lets a pickup order be placed directly from the conversation.",
    },
    {
      q: "Does it cost anything to use the MCP server?",
      a: "No — the MCP server is free and open source. There is no subscription and no per-query fee for AI assistants or their users.",
    },
    {
      q: "Can I order food directly through my AI assistant?",
      a: "Yes — the cart tools let you build a shopping list and submit a pickup order per producer. There is no payment inside the AI flow; you pay the producer directly on pickup.",
    },
    {
      q: "How do I set up MCP in Claude Desktop or ChatGPT?",
      a: "See the full setup guide at rettfrabonden.com/teknologi#mcp-oppsett for step-by-step instructions for ChatGPT, Claude Desktop, and other MCP clients.",
    },
  ] : [
    {
      q: "Hvilke AI-assistenter kan jeg bruke for å finne lokale matprodusenter?",
      a: "Alle assistenter som støtter Model Context Protocol (MCP) kan kobles til — inkludert Claude Desktop, ChatGPT (Developer Mode / egendefinerte koblinger), Cursor og andre MCP-klienter. Koble til via https://rettfrabonden.com/mcp eller npm-pakken lokal-mcp.",
    },
    {
      q: "Hvilke verktøy har lokal MCP-serveren?",
      a: "lokal_search og lokal_discover finner produsenter etter navn, produkt eller sted; lokal_info returnerer full prisliste og kontaktinfo for én produsent; lokal_geocode slår opp norske stedsnavn som koordinater; lokal_list_umbrellas, lokal_get_umbrella_members og lokal_get_producer_affiliations dekker markeder (Bondens marked, REKO) og sertifiseringer (Debio); lokal_bm_next_markets lister kommende markedsdager; og en handlekurv-flyt (lokal_cart_create, lokal_cart_add_item, lokal_cart_view, lokal_cart_submit, lokal_order_status) lar deg legge inn en henteordre direkte fra samtalen.",
    },
    {
      q: "Koster det noe å bruke MCP-serveren?",
      a: "Nei — MCP-serveren er gratis og åpen kildekode. Det er verken abonnement eller kostnad per forespørsel for AI-assistenter eller brukerne deres.",
    },
    {
      q: "Kan jeg bestille mat direkte gjennom AI-assistenten?",
      a: "Ja — handlekurv-verktøyene lar deg bygge en handleliste og sende en henteordre per produsent. Det er ingen betaling i AI-flyten — du betaler produsenten direkte ved henting.",
    },
    {
      q: "Hvordan setter jeg opp MCP i Claude Desktop eller ChatGPT?",
      a: "Se den fullstendige oppsettsguiden på rettfrabonden.com/teknologi#mcp-oppsett for steg-for-steg-instruksjoner for ChatGPT, Claude Desktop og andre MCP-klienter.",
    },
  ];

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${url}#faq`,
    "mainEntity": qas.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a },
    })),
  };
}

router.get("/guide-mat-ai", (req: Request, res: Response) => {
  const lang = req.lang;
  const en = lang === "en";
  const canonical = `${BASE_URL}${localizedPath("/guide-mat-ai", lang)}`;
  const teknologiHref = localizedPath("/teknologi", lang);
  const sokHref = localizedPath("/sok", lang);

  const content = en ? `
  <section class="gma-hero">
    <h1>Find Norwegian local food via AI/MCP</h1>
    <p>Ask Claude, ChatGPT, or any other MCP-compatible AI assistant to search Rett fra Bonden's registry of Norwegian local food producers — no browser tab needed.</p>
  </section>

  <section class="gma-sec">
    <h2>What is this?</h2>
    <p>Rett fra Bonden runs a remote <a href="${teknologiHref}">MCP (Model Context Protocol)</a> server at <code>https://rettfrabonden.com/mcp</code>. Once connected, your AI assistant can search, filter, and read our verified producer catalog directly — the same data that powers <a href="${sokHref}">the search page</a>, but callable as tools inside a conversation.</p>
    <p>This guide lists the exact tools the server exposes and how to phrase requests to your assistant. For the connection steps themselves (ChatGPT, Claude Desktop, or the <code>lokal-mcp</code> npm package), see <a href="${teknologiHref}#mcp-oppsett">the setup guide on /teknologi</a>.</p>

    <h2>The tools, exactly as registered</h2>
    <p class="gma-group-label">Search &amp; discovery</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_search</code><p>Natural-language search by producer name, product, or location (e.g. "organic honey Trondheim"). Returns contact info and the full priced product list for specific matches.</p></div>
      <div class="gma-tool"><code>lokal_discover</code><p>Structured search filtered by category, tags, and geographic distance.</p></div>
      <div class="gma-tool"><code>lokal_geocode</code><p>Resolves a Norwegian place name (city, kommune, fylke) to lat/lng coordinates for use with <code>lokal_discover</code>'s distance filter.</p></div>
      <div class="gma-tool"><code>lokal_stats</code><p>Platform statistics — total producers and cities covered.</p></div>
    </div>
    <p class="gma-group-label">Producer detail</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_info</code><p>A single producer's complete product catalog with prices, contact details, opening hours, and delivery options.</p></div>
    </div>
    <p class="gma-group-label">Markets, venues &amp; certifications</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_list_umbrellas</code><p>All umbrella organizations — market networks (Bondens marked, REKO), venues (Mathallen), industry orgs (Hanen), and certifiers (Debio).</p></div>
      <div class="gma-tool"><code>lokal_get_umbrella_members</code><p>Producers that belong to a given umbrella — e.g. every Debio-certified producer, or everyone selling at a named market.</p></div>
      <div class="gma-tool"><code>lokal_get_producer_affiliations</code><p>Which umbrellas a specific producer belongs to (which markets they sell at, which certifications they hold).</p></div>
      <div class="gma-tool"><code>lokal_bm_next_markets</code><p>Upcoming Bondens marked market days for a region or venue, refreshed daily.</p></div>
    </div>
    <p class="gma-group-label">Shopping cart (pickup, no online payment)</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_cart_create</code> · <code>lokal_cart_add_item</code> · <code>lokal_cart_view</code> · <code>lokal_cart_submit</code> · <code>lokal_order_status</code><p>Build a shopping list from priced products, submit it as a pickup order per producer, and check order status. No payment happens in the AI flow — you pay the producer directly on pickup.</p></div>
    </div>

    <h2>Try asking your assistant</h2>
    <div class="gma-examples">
      <ul>
        <li>"Find organic vegetables near Bergen"</li>
        <li>"What does Bjørndal Gård sell, and how much does it cost?"</li>
        <li>"Which farmers sell at Bondens marked in Oslo, and when is the next market day?"</li>
        <li>"Show me all Debio-certified producers near Trondheim"</li>
        <li>"Add two jars of honey from that producer to my cart"</li>
      </ul>
    </div>

    <h2>Get started</h2>
    <p>Full connection steps for ChatGPT, Claude Desktop, and other MCP clients live on our technology page — we keep setup instructions in one place so they stay current.</p>
    <p><a class="gma-cta" href="${teknologiHref}#mcp-oppsett">Set up MCP on /teknologi →</a></p>
  </section>

  <section class="gma-sec">
    <h2>Frequently asked questions</h2>
    <div class="gma-faq">
      ${buildMcpGuideFaqJsonLd(lang, canonical).mainEntity.map((qa: any) =>
        `<div class="gma-faq-item"><h3>${escapeHtml(qa.name)}</h3><p>${escapeHtml(qa.acceptedAnswer.text)}</p></div>`
      ).join("")}
    </div>
  </section>` : `
  <section class="gma-hero">
    <h1>Finn norsk lokalmat via AI/MCP</h1>
    <p>Be Claude, ChatGPT, eller en annen MCP-kompatibel AI-assistent om å søke i Rett fra Bondens register over norske matprodusenter — uten å åpne en nettleser.</p>
  </section>

  <section class="gma-sec">
    <h2>Hva er dette?</h2>
    <p>Rett fra Bonden kjører en ekstern <a href="${teknologiHref}">MCP (Model Context Protocol)</a>-server på <code>https://rettfrabonden.com/mcp</code>. Når AI-assistenten din er koblet til, kan den søke, filtrere og lese vårt verifiserte produsentregister direkte — samme data som driver <a href="${sokHref}">søkesiden</a>, men tilgjengelig som verktøy i en samtale.</p>
    <p>Denne guiden lister verktøyene serveren eksponerer, og hvordan du kan formulere forespørsler til assistenten din. For selve tilkoblingsstegene (ChatGPT, Claude Desktop, eller npm-pakken <code>lokal-mcp</code>), se <a href="${teknologiHref}#mcp-oppsett">oppsettsguiden på /teknologi</a>.</p>

    <h2>Verktøyene, slik de faktisk er registrert</h2>
    <p class="gma-group-label">Søk og oppdagelse</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_search</code><p>Naturlig-språk-søk etter produsentnavn, produkt eller sted (f.eks. «økologisk honning Trondheim»). Returnerer kontaktinfo og full priset produktliste for spesifikke treff.</p></div>
      <div class="gma-tool"><code>lokal_discover</code><p>Strukturert søk filtrert på kategori, tags og geografisk avstand.</p></div>
      <div class="gma-tool"><code>lokal_geocode</code><p>Slår opp et norsk stedsnavn (by, kommune, fylke) som lat/lng-koordinater for bruk med avstandsfilteret i <code>lokal_discover</code>.</p></div>
      <div class="gma-tool"><code>lokal_stats</code><p>Plattformstatistikk — totalt antall produsenter og byer dekket.</p></div>
    </div>
    <p class="gma-group-label">Produsentdetaljer</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_info</code><p>Én produsents komplette produktkatalog med priser, kontaktdetaljer, åpningstider og leveringsalternativer.</p></div>
    </div>
    <p class="gma-group-label">Markeder, salgssteder og sertifiseringer</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_list_umbrellas</code><p>Alle paraplyorganisasjoner — marked-nettverk (Bondens marked, REKO), salgssteder (Mathallen), bransjeorganisasjoner (Hanen) og sertifiserere (Debio).</p></div>
      <div class="gma-tool"><code>lokal_get_umbrella_members</code><p>Produsenter som tilhører en gitt paraply — f.eks. alle Debio-sertifiserte produsenter, eller alle som selger på et navngitt marked.</p></div>
      <div class="gma-tool"><code>lokal_get_producer_affiliations</code><p>Hvilke paraplyer en spesifikk produsent tilhører (hvilke markeder de selger på, hvilke sertifiseringer de har).</p></div>
      <div class="gma-tool"><code>lokal_bm_next_markets</code><p>Kommende Bondens marked-dager for en region eller et salgssted, oppdatert daglig.</p></div>
    </div>
    <p class="gma-group-label">Handlekurv (henting, ingen nettbetaling)</p>
    <div class="gma-tools">
      <div class="gma-tool"><code>lokal_cart_create</code> · <code>lokal_cart_add_item</code> · <code>lokal_cart_view</code> · <code>lokal_cart_submit</code> · <code>lokal_order_status</code><p>Bygg en handleliste fra prisede produkter, send den som en henteordre per produsent, og sjekk ordrestatus. Det skjer ingen betaling i AI-flyten — du betaler produsenten direkte ved henting.</p></div>
    </div>

    <h2>Prøv å spørre assistenten din</h2>
    <div class="gma-examples">
      <ul>
        <li>«Finn økologiske grønnsaker nær Bergen»</li>
        <li>«Hva selger Bjørndal Gård, og hva koster det?»</li>
        <li>«Hvilke bønder selger på Bondens marked i Oslo, og når er neste markedsdag?»</li>
        <li>«Vis meg alle Debio-sertifiserte produsenter nær Trondheim»</li>
        <li>«Legg to glass honning fra den produsenten i handlekurven min»</li>
      </ul>
    </div>

    <h2>Kom i gang</h2>
    <p>Fullstendige tilkoblingssteg for ChatGPT, Claude Desktop og andre MCP-klienter finner du på teknologisiden vår — vi holder oppsettsinstruksjonene ett sted slik at de alltid er oppdaterte.</p>
    <p><a class="gma-cta" href="${teknologiHref}#mcp-oppsett">Sett opp MCP på /teknologi →</a></p>
  </section>

  <section class="gma-sec">
    <h2>Ofte stilte spørsmål</h2>
    <div class="gma-faq">
      ${buildMcpGuideFaqJsonLd(lang, canonical).mainEntity.map((qa: any) =>
        `<div class="gma-faq-item"><h3>${escapeHtml(qa.name)}</h3><p>${escapeHtml(qa.acceptedAnswer.text)}</p></div>`
      ).join("")}
    </div>
  </section>`;

  const description = en
    ? "How to use Claude, ChatGPT, and other AI assistants with the lokal MCP server to find Norwegian local food producers — every tool explained."
    : "Slik bruker du Claude, ChatGPT og andre AI-assistenter med lokal MCP-serveren for å finne norske matprodusenter — alle verktøyene forklart.";

  res.send(shell(
    en ? "Find Norwegian local food via AI/MCP | Rett fra Bonden" : "Finn norsk lokalmat via AI/MCP | Rett fra Bonden",
    description,
    content,
    {
      canonical,
      extraCss: GUIDE_MAT_AI_CSS,
      lang,
      pathForAlternate: "/guide-mat-ai",
      jsonLd: [buildMcpGuideFaqJsonLd(lang, canonical)],
    }
  ));
});


// ═══════════════════════════════════════════════════════════════
// GET /personvern — Privacy policy (GDPR-compliant, factual)
// ═══════════════════════════════════════════════════════════════

const PERSONVERN_CSS = `
  .pv-hero { background: linear-gradient(135deg, #f8f9fa 0%, #f0f4f3 100%); padding: 64px 24px 48px; text-align: center; }
  .pv-hero h1 { font-size: 2.2rem; font-weight: 800; color: var(--charcoal); letter-spacing: -1px; margin-bottom: 12px; }
  .pv-hero p { font-size: 1.05rem; color: var(--g500); max-width: 600px; margin: 0 auto; line-height: 1.7; }
  .pv-sec { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  .pv-sec h2 { font-size: 1.4rem; font-weight: 800; color: var(--charcoal); margin-top: 36px; margin-bottom: 12px; }
  .pv-sec h3 { font-size: 1.1rem; font-weight: 700; color: var(--charcoal); margin-top: 24px; margin-bottom: 8px; }
  .pv-sec p { font-size: 0.95rem; color: var(--g700); line-height: 1.8; margin-bottom: 12px; }
  .pv-sec ul { margin: 8px 0 16px 20px; }
  .pv-sec li { font-size: 0.95rem; color: var(--g700); line-height: 1.7; margin-bottom: 4px; }
  .pv-table { width: 100%; border-collapse: collapse; margin: 16px 0 24px; font-size: 0.9rem; }
  .pv-table th { text-align: left; padding: 10px 12px; background: var(--green-50); border-bottom: 2px solid var(--g200); font-weight: 700; color: var(--charcoal); }
  .pv-table td { padding: 10px 12px; border-bottom: 1px solid var(--g100); color: var(--g700); }
  .pv-updated { font-size: 0.85rem; color: var(--g400); margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--g100); }
  @media (max-width: 768px) {
    .pv-hero h1 { font-size: 1.6rem; }
    .pv-table { font-size: 0.8rem; }
    .pv-table th, .pv-table td { padding: 8px 6px; }
  }
`;

router.get("/personvern", (req: Request, res: Response) => {
  const lang = req.lang;
  const brand = `<span translate="no">${getConfig().display_name}</span>`;
  const en = lang === "en";
  const content = en ? `
  <section class="pv-hero">
    <h1>Privacy</h1>
    <p>How ${brand} handles data \u2014 honestly, without filler.</p>
  </section>

  <section class="pv-sec">
    <h2>Who we are</h2>
    <p>${brand} is an open catalogue of local ${getConfig().domain_dictionary.entity_plural_long} in Norway, available at rettfrabonden.com. The service is run as an independent project. Contact: kontakt@${getConfig().domain}.</p>

    <h2>What we collect</h2>
    <p>We collect different types of data depending on how you use the service. Here is the full overview:</p>

    <h3>Website visitors (everyone)</h3>
    <p>When you visit rettfrabonden.com we register:</p>
    <ul>
      <li>Which page you visit (URL path)</li>
      <li>Referrer URL (where you came from)</li>
      <li>An anonymised hash of IP address and browser type (SHA-256, truncated \u2014 we do not store the full IP address or browser string)</li>
      <li>Timestamp of the visit</li>
    </ul>
    <p>We use no cookies. We use no third-party analytics tools such as Google Analytics. All analysis happens in our own database.</p>

    <h3>Search and AI queries</h3>
    <p>When you search for producers \u2014 via the website, ChatGPT, Claude MCP or the API \u2014 we store:</p>
    <ul>
      <li>The text you searched for</li>
      <li>Selected category and city</li>
      <li>Number of results returned</li>
      <li>Which protocol was used (API, MCP, A2A)</li>
      <li>Anonymised IP hash (same method as for page visits)</li>
    </ul>
    <p>We store this to understand which searches give good results and to improve the service.</p>

    <h3>Sellers who register (claim)</h3>
    <p>When you register as a ${getConfig().domain_dictionary.entity} to manage your profile, we collect:</p>
    <ul>
      <li>Name, email address and optionally phone number</li>
      <li>A 6-digit verification code sent to your email</li>
      <li>Claim token (cryptographic key for sign-in, expires after 30 days)</li>
    </ul>
    <p>After verification you can yourself add and edit: address, opening hours, products, certifications, description, images and contact info. Everything you add is visible on your public profile page.</p>

    <h3>Sign-in</h3>
    <p>We do not use passwords. Sign-in happens via a magic link sent to your email. The link is valid for 15 minutes and can only be used once. We do not store passwords because we do not have any.</p>

    <h3>Images</h3>
    <p>Sellers can upload profile pictures and product photos. These are stored on the server. If image scanning is enabled, the image may be sent to an external AI service (Anthropic Claude or OpenAI) for automatic product recognition.</p>

    <h3>Conversations between agents</h3>
    <p>${brand} supports the A2A protocol (agent-to-agent). When an AI agent contacts a producer agent, the conversation text, status and any transaction info are stored in the database.</p>

    <h2>What we do not collect</h2>
    <ul>
      <li>We use no cookies</li>
      <li>We have no third-party tracking (no Google Analytics, Facebook Pixel, etc.)</li>
      <li>We do not store full IP addresses \u2014 only a truncated hash</li>
      <li>We do not store passwords (passwordless sign-in)</li>
      <li>We do not collect payment information</li>
      <li>We never sell data to third parties</li>
    </ul>

    <h2>Legal basis</h2>
    <p>We process personal data based on:</p>
    <table class="pv-table">
      <thead><tr><th>Data type</th><th>Basis</th><th>Explanation</th></tr></thead>
      <tbody>
        <tr><td>Analytics (page visits, searches)</td><td>Legitimate interest</td><td>To improve the service. The data is anonymised (hashed IP/UA).</td></tr>
        <tr><td>Seller registration</td><td>Consent</td><td>You actively provide data when you register. You can withdraw consent.</td></tr>
        <tr><td>Seller profile (public info)</td><td>Consent</td><td>You choose what to add. Everything is visible on your profile page.</td></tr>
        <tr><td>Image upload</td><td>Consent</td><td>You upload images yourself. Image scanning is optional.</td></tr>
      </tbody>
    </table>

    <h2>Where data is stored</h2>
    <p>All data is stored in a SQLite database on a server hosted by <span translate="no">Fly.io</span> in the <span translate="no">Stockholm</span> region (ARN). Data is not transferred to countries outside the EU/EEA, with the exception of:</p>
    <ul>
      <li>Email is sent via an SMTP service to deliver verification codes and magic links</li>
      <li>If image scanning is enabled, images may be sent to <span translate="no">Anthropic</span> (USA) or <span translate="no">OpenAI</span> (USA) for analysis</li>
    </ul>
    <p>The source code is open and available on <a href="https://github.com/slookisen/lokal" style="color:var(--green-700);">GitHub</a>.</p>

    <h2>How long we keep data</h2>
    <table class="pv-table">
      <thead><tr><th>Data type</th><th>Retention</th></tr></thead>
      <tbody>
        <tr><td>Page-visit analytics</td><td>Can be deleted via admin. No automatic expiry is set today.</td></tr>
        <tr><td>Search logs</td><td>Same as analytics.</td></tr>
        <tr><td>Verification codes</td><td>Unverified claims expire after 7 days.</td></tr>
        <tr><td>Magic links</td><td>Expire after 15 minutes. Used links older than 1 hour are auto-deleted.</td></tr>
        <tr><td>Claim token (sign-in)</td><td>Expires after 30 days. Renewed at next sign-in.</td></tr>
        <tr><td>Seller profile</td><td>For as long as you wish to remain registered.</td></tr>
        <tr><td>Uploaded images</td><td>Stored until manually deleted.</td></tr>
      </tbody>
    </table>

    <h2>Your rights</h2>
    <p>Under the Norwegian Personal Data Act and the GDPR you have the right to:</p>
    <ul>
      <li><strong>Request access</strong> \u2014 we can tell you what we have stored about you</li>
      <li><strong>Correct errors</strong> \u2014 sellers can update their profile directly via the dashboard</li>
      <li><strong>Delete data</strong> \u2014 contact us to have your profile and associated data removed</li>
      <li><strong>Withdraw consent</strong> \u2014 you can ask to be removed at any time</li>
      <li><strong>File a complaint</strong> \u2014 you can complain to <span translate="no">Datatilsynet</span> (the Norwegian Data Protection Authority, datatilsynet.no) if you believe we are breaking the rules</li>
    </ul>
    <p>For all enquiries: <a href="mailto:kontakt@${getConfig().domain}" style="color:var(--green-700);">kontakt@${getConfig().domain}</a></p>

    <h2>Security</h2>
    <p>We use the following measures to protect data:</p>
    <ul>
      <li>All traffic is encrypted with HTTPS/TLS</li>
      <li>Admin access is protected by API keys in environment variables</li>
      <li>Content Security Policy (CSP) and other security headers are active</li>
      <li>All database queries are parameterised (protection against SQL injection)</li>
      <li>IP addresses and browser info are stored only as hashes (irreversible anonymisation)</li>
      <li>Rate limiting on sensitive endpoints</li>
    </ul>

    <h2>Changes to this policy</h2>
    <p>If we change how we handle data, we update this page. We have no newsletter or popup notifications \u2014 check this page if you're wondering.</p>

    <p class="pv-updated">Last updated: 16 April 2026</p>
  </section>` : `
  <section class="pv-hero">
    <h1>Personvern</h1>
    <p>Hvordan ${brand} behandler data \u2014 ærlig og uten fyllord.</p>
  </section>

  <section class="pv-sec">
    <h2>Hvem vi er</h2>
    <p>${brand} er en åpen katalog over lokale ${getConfig().domain_dictionary.entity_plural_long} i Norge, tilgjengelig på rettfrabonden.com. Tjenesten drives som et uavhengig prosjekt. Kontakt: kontakt@${getConfig().domain}.</p>

    <h2>Hva vi samler inn</h2>
    <p>Vi samler inn forskjellige typer data avhengig av hvordan du bruker tjenesten. Her er en fullstendig oversikt:</p>

    <h3>Besøkende på nettsiden (alle)</h3>
    <p>Når du besøker rettfrabonden.com registrerer vi:</p>
    <ul>
      <li>Hvilken side du besøker (URL-sti)</li>
      <li>Referanse-URL (hvor du kom fra)</li>
      <li>En anonymisert hash av IP-adresse og nettleser-type (SHA-256, forkortet \u2014 vi lagrer ikke fullstendig IP-adresse eller nettleser-streng)</li>
      <li>Tidspunkt for besøket</li>
    </ul>
    <p>Vi bruker ingen informasjonskapsler (cookies). Vi bruker ingen tredjepartsanalyseverktøy som Google Analytics. All analyse skjer i vår egen database.</p>

    <h3>Søk og AI-spørringer</h3>
    <p>Når du søker etter produsenter \u2014 enten via nettsiden, ChatGPT, Claude MCP eller API-et \u2014 lagrer vi:</p>
    <ul>
      <li>Søketeksten du skrev</li>
      <li>Valgt kategori og by</li>
      <li>Antall resultater returnert</li>
      <li>Hvilken protokoll som ble brukt (API, MCP, A2A)</li>
      <li>Anonymisert IP-hash (samme metode som for sidebesøk)</li>
    </ul>
    <p>Vi lagrer dette for å forstå hvilke søk som gir gode resultater, og for å forbedre tjenesten.</p>

    <h3>Selgere som registrerer seg (claim)</h3>
    <p>Når du som ${getConfig().domain_dictionary.entity} registrerer deg for å administrere din profil, samler vi inn:</p>
    <ul>
      <li>Navn, e-postadresse og eventuelt telefonnummer</li>
      <li>En 6-sifret verifiseringskode sendt til din e-post</li>
      <li>Claim-token (kryptografisk nøkkel for pålogging, utløper etter 30 dager)</li>
    </ul>
    <p>Etter verifisering kan du selv legge inn og redigere: adresse, åpningstider, produkter, sertifiseringer, beskrivelse, bilder og kontaktinfo. Alt du legger inn er synlig på din offentlige profilside.</p>

    <h3>Innlogging</h3>
    <p>Vi bruker ikke passord. Innlogging skjer via magisk lenke sendt til din e-post. Lenken er gyldig i 15 minutter og kan bare brukes én gang. Vi lagrer ikke passord fordi vi ikke har noen.</p>

    <h3>Bilder</h3>
    <p>Selgere kan laste opp profilbilder og produktbilder. Disse lagres på serveren. Hvis bildeskanning er aktivert, kan bildet sendes til en ekstern AI-tjeneste (Anthropic Claude eller OpenAI) for automatisk produktgjenkjenning.</p>

    <h3>Samtaler mellom agenter</h3>
    <p>${brand} støtter A2A-protokollen (agent-til-agent). Når en AI-agent kontakter en produsent-agent, lagres samtaletekst, status og eventuell transaksjonsinfo i databasen.</p>

    <h2>Hva vi ikke samler inn</h2>
    <ul>
      <li>Vi bruker ingen informasjonskapsler (cookies)</li>
      <li>Vi har ingen tredjepartssporing (ingen Google Analytics, Facebook Pixel, etc.)</li>
      <li>Vi lagrer ikke fullstendige IP-adresser \u2014 kun en forkortet hash</li>
      <li>Vi lagrer ikke passord (passwordless innlogging)</li>
      <li>Vi samler ikke inn betalingsinformasjon</li>
      <li>Vi selger aldri data til tredjeparter</li>
    </ul>

    <h2>Rettslig grunnlag</h2>
    <p>Vi behandler persondata basert på:</p>
    <table class="pv-table">
      <thead><tr><th>Datatype</th><th>Grunnlag</th><th>Forklaring</th></tr></thead>
      <tbody>
        <tr><td>Analytikk (sidebesøk, søk)</td><td>Berettiget interesse</td><td>For å forbedre tjenesten. Dataen er anonymisert (hashet IP/UA).</td></tr>
        <tr><td>Selgerregistrering</td><td>Samtykke</td><td>Du gir aktivt data når du registrerer deg. Du kan trekke tilbake samtykket.</td></tr>
        <tr><td>Selgerprofil (offentlig info)</td><td>Samtykke</td><td>Du velger selv hva du legger inn. Alt er synlig på din profilside.</td></tr>
        <tr><td>Bildeoppasting</td><td>Samtykke</td><td>Du laster selv opp bilder. Bildeskanning er valgfritt.</td></tr>
      </tbody>
    </table>

    <h2>Hvor data lagres</h2>
    <p>All data lagres i en SQLite-database på en server hostet av Fly.io i Stockholm-regionen (ARN). Data overføres ikke til land utenfor EU/EØS, med unntak av:</p>
    <ul>
      <li>E-post sendes via SMTP-tjeneste for å levere verifiseringskoder og magiske lenker</li>
      <li>Hvis bildeskanning er aktivert, kan bilder sendes til Anthropic (USA) eller OpenAI (USA) for analyse</li>
    </ul>
    <p>Kildekoden er åpen og tilgjengelig på <a href="https://github.com/slookisen/lokal" style="color:var(--green-700);">GitHub</a>.</p>

    <h2>Hvor lenge vi lagrer data</h2>
    <table class="pv-table">
      <thead><tr><th>Datatype</th><th>Oppbevaring</th></tr></thead>
      <tbody>
        <tr><td>Sidebesøk-analytikk</td><td>Kan slettes via admin. Ingen automatisk utløp er satt per i dag.</td></tr>
        <tr><td>Søkelogger</td><td>Samme som analytikk.</td></tr>
        <tr><td>Verifiseringskoder</td><td>Uverifiserte claims utløper etter 7 dager.</td></tr>
        <tr><td>Magiske lenker</td><td>Utløper etter 15 minutter. Brukte lenker eldre enn 1 time slettes automatisk.</td></tr>
        <tr><td>Claim-token (innlogging)</td><td>Utløper etter 30 dager. Fornyes ved ny innlogging.</td></tr>
        <tr><td>Selgerprofil</td><td>Så lenge du ønsker å være registrert.</td></tr>
        <tr><td>Opplastede bilder</td><td>Lagres til de slettes manuelt.</td></tr>
      </tbody>
    </table>

    <h2>Dine rettigheter</h2>
    <p>Etter personopplysningsloven og GDPR har du rett til å:</p>
    <ul>
      <li><strong>Be om innsyn</strong> \u2014 vi kan fortelle deg hva vi har lagret om deg</li>
      <li><strong>Rette feil</strong> \u2014 selgere kan oppdatere sin profil direkte via dashboardet</li>
      <li><strong>Slette data</strong> \u2014 kontakt oss for å få fjernet din profil og tilknyttet data</li>
      <li><strong>Trekke tilbake samtykke</strong> \u2014 du kan når som helst be om å bli fjernet</li>
      <li><strong>Klage</strong> \u2014 du kan klage til Datatilsynet (datatilsynet.no) hvis du mener vi bryter reglene</li>
    </ul>
    <p>For alle henvendelser: <a href="mailto:kontakt@${getConfig().domain}" style="color:var(--green-700);">kontakt@${getConfig().domain}</a></p>

    <h2>Sikkerhet</h2>
    <p>Vi bruker følgende tiltak for å beskytte data:</p>
    <ul>
      <li>All trafikk er kryptert med HTTPS/TLS</li>
      <li>Admin-tilgang er beskyttet med API-nøkler i miljøvariabler</li>
      <li>Content Security Policy (CSP) og andre sikkerhetsheadere er aktive</li>
      <li>Alle databasespørringer er parameterisert (beskyttelse mot SQL-injeksjon)</li>
      <li>IP-adresser og nettleserinfo lagres kun som hasher (ikke-reversibel anonymisering)</li>
      <li>Rate limiting på sensitive endepunkter</li>
    </ul>

    <h2>Endringer i denne policyen</h2>
    <p>Hvis vi endrer hvordan vi behandler data, oppdaterer vi denne siden. Vi har ingen nyhetsbrev eller popup-varsler \u2014 sjekk denne siden hvis du lurer.</p>

    <p class="pv-updated">Sist oppdatert: 16. april 2026</p>
  </section>`;

  res.send(shell(
    t(lang, "privacy.title"),
    t(lang, "privacy.description"),
    content,
    { canonical: `${BASE_URL}${localizedPath("/personvern", lang)}`, extraCss: PERSONVERN_CSS, lang, pathForAlternate: "/personvern" }
  ));
});


// ═══════════════════════════════════════════════════════════════
// GET /:city — City page
// ═══════════════════════════════════════════════════════════════

const CITY_CSS = `
  .city-hero { background: var(--green-50); padding: 40px 24px; }
  .city-hero h1 { font-size: 2rem; font-weight: 800; color: var(--charcoal); margin-bottom: 6px; }
  .city-hero p { font-size: 1rem; color: var(--g500); }
  .city-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  @media (max-width: 768px) { .city-grid { grid-template-columns: 1fr; } }
`;

router.get("/:city", (req: Request, res: Response, next: any) => {
  const citySlug = (req.params.city as string).toLowerCase();

  if (citySlug.startsWith("api") || citySlug.startsWith(".") || citySlug === "health"
      || citySlug === "a2a" || citySlug === "mcp" || citySlug === "sok"
      || citySlug === "produsent" || citySlug === "sitemap.xml" || citySlug === "robots.txt"
      || citySlug === "openapi.json" || citySlug === "openapi.yaml" || citySlug === "favicon.ico"
      || citySlug === "selger" || citySlug === "admin" || citySlug === "om" || citySlug === "teknologi"
      || citySlug === "personvern" || citySlug === "privacy" || citySlug === "privacy-policy"
      || citySlug === "terms" || citySlug === "terms-of-service" || citySlug === "tos" || citySlug === "vilkar"
      || citySlug === "llms.txt" || citySlug === "llms-full.txt"
      || citySlug === `${INDEXNOW_KEY}.txt`
      || citySlug === "agents" || citySlug === "docs" || citySlug === "samtaler" || citySlug === "samtale"
      || citySlug === "en" || citySlug === "no" || citySlug === "kontakt"
      || citySlug.includes(".")) {
    return next();
  }
  const lang = req.lang;

  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const cityAgents = agents.filter((a: any) => {
      const city = a.city || a.location?.city || "";
      return slugify(city) === citySlug;
    });

    if (cityAgents.length === 0) {
      return res.status(404).send(shell(
        lang === "en" ? "No producers found" : "Fant ingen produsenter",
        lang === "en" ? "No producers found." : "Ingen produsenter funnet.",
        `<div class="sec" style="text-align:center;padding:80px 24px;">
          <h1 style="font-size:1.8rem;margin-bottom:12px;">Fant ingen produsenter for \u201c${escapeHtml(citySlug)}\u201d</h1>
          <p style="color:var(--g500);"><a href="/">Tilbake til forsiden</a></p>
        </div>`
      ));
    }

    const cityName = (cityAgents[0] as any).city || (cityAgents[0] as any).location?.city || citySlug;

    // Track city page view for analytics dashboard (one entry per city visit)
    // Use the first agent as representative — getCityStats groups by city
    analyticsService.trackAgentView(cityAgents[0].id, cityAgents[0].name, cityName, "seo");

    const producerCards = cityAgents.map((a: any) => producerCard(a, undefined, lang)).join("");

    // City-specific context paragraph (SEO: gives Google unique content per city
    // instead of a template-only page). All values are computed from the live
    // registry so each city page gets a factually grounded, distinct lede.
    const categoryCounts = new Map<string, number>();
    let verifiedCount = 0;
    for (const a of cityAgents) {
      if ((a as any).isVerified) verifiedCount++;
      const cats = (a as any).categories || [];
      for (const c of cats) {
        if (!c) continue;
        const key = String(c).toLowerCase();
        categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
      }
    }
    const CATEGORY_LABELS_NO: Record<string, string> = {
      vegetables: "gr\u00f8nnsaker", fruit: "frukt", berries: "b\u00e6r",
      meat: "kj\u00f8tt", dairy: "meieri", cheese: "ost", eggs: "egg",
      honey: "honning", bakery: "bakeri", fish: "fisk", seafood: "sj\u00f8mat",
      herbs: "urter", grains: "korn", flour: "mel", juice: "saft",
      beer: "\u00f8l", wine: "vin", cider: "sider", coffee: "kaffe",
      preserves: "syltet\u00f8y", pickles: "syltede", beverages: "drikke",
      oil: "olje", mushrooms: "sopp", nuts: "n\u00f8tter",
    };
    const topCategories = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => CATEGORY_LABELS_NO[k] || k);
    // Natural Norwegian list — "A, B og C" / "A og B" / "A" / ""
    let categoriesText = "";
    if (topCategories.length === 3) categoriesText = `${topCategories[0]}, ${topCategories[1]} og ${topCategories[2]}`;
    else if (topCategories.length === 2) categoriesText = `${topCategories[0]} og ${topCategories[1]}`;
    else if (topCategories.length === 1) categoriesText = topCategories[0];
    const contextSentences: string[] = [];
    if (categoriesText) {
      contextSentences.push(`Popul\u00e6re kategorier her er ${categoriesText}.`);
    }
    if (verifiedCount > 0) {
      contextSentences.push(`${verifiedCount} av produsentene er verifiserte, og du kan kontakte dem direkte \u2014 uten mellomledd eller annonser.`);
    } else {
      contextSentences.push(`Alle produsenter kan kontaktes direkte \u2014 uten mellomledd eller annonser.`);
    }
    const contextPara = contextSentences.join(" ");

    // Schema.org
    const jsonLdItems = cityAgents.slice(0, 50).map((a: any) => {
      const info = knowledgeService.getAgentInfo(a.id);
      const k = info?.knowledge || {} as any;
      let itemDesc = a.description || "";
      if (isJunkDescription(itemDesc)) {
        console.log(`[description-guard] suppressed junk description (city JSON-LD) for ${a.id} (${a.name})`);
        itemDesc = "";
      }
      const item: any = {
        "@context": "https://schema.org", "@type": "LocalBusiness",
        "name": a.name, "description": itemDesc,
        "url": `${BASE_URL}/produsent/${slugify(a.name)}`,
      };
      if (k.address) item.address = { "@type": "PostalAddress", "streetAddress": k.address, "addressLocality": cityName, "addressCountry": "NO" };
      if (isDisplayablePhone(k.phone)) item.telephone = k.phone;
      if (a.location?.lat && a.location?.lng) item.geo = { "@type": "GeoCoordinates", "latitude": a.location.lat, "longitude": a.location.lng };
      return item;
    });

    const cityCanonicalUrl = `${BASE_URL}${localizedPath("/" + citySlug, lang)}`;
    const cityFaqJsonLd = buildCityFaqJsonLd({
      cityName,
      url: cityCanonicalUrl,
      producerCount: cityAgents.length,
      topCategories,
      verifiedCount,
    });
    if (cityFaqJsonLd) jsonLdItems.push(cityFaqJsonLd);

    const content = `
    <section class="city-hero">
      <div class="container">
        <div class="bc" style="padding:0 0 12px;"><a href="/">Hjem</a><span>/</span>${escapeHtml(cityName)}</div>
        <h1>${lang === "en" ? `Local food in <span translate="no">${escapeHtml(cityName)}</span>` : `Lokal mat i <span translate="no">${escapeHtml(cityName)}</span>`}</h1>
        <p>${lang === "en" ? `${cityAgents.length} local producers in and around <span translate="no">${escapeHtml(cityName)}</span>.` : `${cityAgents.length} lokale ${getConfig().domain_dictionary.entity_plural_long} i <span translate="no">${escapeHtml(cityName)}</span>-omr\u00e5det.`}</p>
        ${contextPara ? `<p style="margin-top:8px;color:var(--g500);">${escapeHtml(contextPara)}</p>` : ""}
      </div>
    </section>
    <section class="sec">
      <div class="city-grid">${producerCards}</div>
    </section>`;

    res.send(shell(
      t(lang, "city.title", { city: cityName }),
      t(lang, "city.description", { count: cityAgents.length, city: cityName }),
      content,
      { canonical: cityCanonicalUrl, jsonLd: jsonLdItems, extraCss: CITY_CSS, lang, pathForAlternate: "/" + citySlug }
    ));
  } catch (err) {
    console.error(`SEO /${citySlug} error:`, err);
    res.status(500).send(lang === "en" ? "Internal error" : "Intern feil");
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /produsent/:slug — Producer profile page
// ═══════════════════════════════════════════════════════════════

const PROFILE_CSS = `
  .pf-header { max-width: 1100px; margin: 0 auto; padding: 20px 24px 0; display: grid; grid-template-columns: 1fr 340px; gap: 28px; align-items: start; }
  .pf-hero { padding: 28px 0; }
  .pf-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .pf-name { font-size: 2.2rem; font-weight: 800; letter-spacing: -1px; line-height: 1.15; margin-bottom: 6px; }
  .pf-loc { display: flex; align-items: center; gap: 6px; font-size: 0.95rem; color: var(--g500); margin-bottom: 14px; }
  .pf-answer { font-size: 1.05rem; font-weight: 600; color: var(--charcoal); line-height: 1.6; max-width: 580px; margin-bottom: 6px; }
  .pf-desc { font-size: 1rem; color: var(--g700); line-height: 1.7; max-width: 580px; }
  .pf-desc-extra { font-size: 0.9rem; color: var(--g500); line-height: 1.6; max-width: 580px; margin-top: 6px; font-style: italic; }
  .pf-stats { display: flex; gap: 22px; margin-top: 18px; flex-wrap: wrap; }
  .pf-stat { display: flex; align-items: center; gap: 8px; }
  .pf-stat-icon { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.95rem; }
  .pf-stat-icon.t { background: var(--green-100); }
  .pf-stat-icon.r { background: #fef3c7; }
  .pf-stat-icon.h { background: #dbeafe; }
  .pf-stat-icon.a { background: #ede9fe; }
  .pf-stat strong { display: block; font-size: 0.9rem; }
  .pf-stat small { font-size: 0.72rem; color: var(--g500); line-height: 1.25; }
  .pf-stat-meta { font-size: 0.66rem; color: var(--g400, #999); display: block; margin-top: 1px; }
  .ct-card { background: var(--white); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); padding: 24px; position: sticky; top: 70px; }
  .ct-card h3 { font-size: 1rem; font-weight: 700; margin-bottom: 16px; }
  .ct-item { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--g100); font-size: 0.88rem; }
  .ct-item:last-of-type { border-bottom: none; }
  .ct-icon { width: 30px; height: 30px; border-radius: 7px; background: var(--green-50); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 0.82rem; }
  .ct-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--g500); font-weight: 600; margin-bottom: 1px; }
  .ct-val { color: var(--charcoal); font-weight: 500; }
  .ct-val a { color: var(--green-700); font-weight: 600; }
  .ct-actions { display: flex; flex-direction: column; gap: 7px; margin-top: 18px; }
  .pf-content { max-width: 1100px; margin: 0 auto; padding: 0 24px 56px; display: grid; grid-template-columns: 1fr 340px; gap: 28px; }
  .pf-main { display: flex; flex-direction: column; gap: 24px; }
  .prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .prod-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--g100); border-radius: var(--r-md); transition: background 0.2s; }
  .prod-item:hover { background: var(--green-50); }
  .prod-name { font-weight: 600; font-size: 0.88rem; }
  .prod-price { font-size: 0.8rem; color: #2d5f2e; font-weight: 600; white-space: nowrap; }
  .prod-meta { display: flex; align-items: center; gap: 5px; }
  .prod-season { font-size: 0.7rem; color: var(--g500); background: var(--white); padding: 2px 7px; border-radius: 10px; }
  .prod-org { font-size: 0.66rem; font-weight: 700; color: var(--green-700); background: var(--green-100); padding: 2px 7px; border-radius: 10px; }
  .hrs-grid { display: grid; grid-template-columns: 110px 1fr; }
  .hrs-day { padding: 8px 0; font-weight: 600; font-size: 0.88rem; border-bottom: 1px solid var(--g100); }
  .hrs-time { padding: 8px 0; font-size: 0.88rem; color: var(--g700); border-bottom: 1px solid var(--g100); }
  .hrs-today { background: var(--green-50); border-radius: 4px; padding-left: 6px; margin-left: -6px; font-weight: 700; }
  .hrs-open { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; font-size: 0.72rem; font-weight: 700; color: var(--green-700); }
  .hrs-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green-700); animation: pulse 2s infinite; }
  .certs-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .cert-item { display: flex; align-items: center; gap: 7px; padding: 8px 14px; background: var(--green-50); border-radius: var(--r-md); border: 1px solid var(--green-100); }
  .cert-text { font-size: 0.82rem; font-weight: 600; color: var(--green-700); }
  .claim-bar { background: linear-gradient(135deg, var(--green-700), var(--green-900)); color: var(--white); border-radius: var(--r-lg); padding: 24px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  /* Phase 5.4a M2 — Variant A: hero claim banner shown for unclaimed agents.
     Server-rendered (visible to AI bots) above the fold. */
  .claim-hero { background: linear-gradient(135deg, #2D5016, #1a3d0a); color: var(--white); border-radius: var(--r-lg); padding: 20px 24px; margin: 0 0 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .claim-hero h2 { font-size: 1.15rem; font-weight: 700; margin: 0 0 4px; color: var(--white); }
  .claim-hero p { font-size: 0.9rem; opacity: 0.9; margin: 0; }
  .claim-hero a.claim-hero-btn { display: inline-flex; align-items: center; min-height: 44px; padding: 12px 24px; background: #D4A373; color: #1a1a1a; border-radius: 8px; font-weight: 700; font-size: 0.95rem; text-decoration: none; white-space: nowrap; }
  .claim-hero a.claim-hero-btn:hover, .claim-hero a.claim-hero-btn:focus { background: #e8c9a0; outline: 2px solid #fff; }
  @media (max-width: 600px) { .claim-hero { flex-direction: column; align-items: stretch; text-align: center; } .claim-hero a.claim-hero-btn { width: 100%; justify-content: center; } }
  .claim-bar h3 { font-size: 1.05rem; font-weight: 700; margin-bottom: 4px; }
  .claim-bar p { font-size: 0.85rem; opacity: 0.85; }
  .claim-btn { padding: 10px 22px; background: var(--white); color: var(--green-700); border: none; border-radius: var(--r-md); font-weight: 700; font-size: 0.85rem; cursor: pointer; white-space: nowrap; }
  .data-src { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; background: var(--g100); border-radius: 20px; font-size: 0.72rem; color: var(--g500); margin-top: 14px; }
  .data-dot { width: 5px; height: 5px; border-radius: 50%; }
  .data-dot.auto { background: var(--orange); }
  .data-dot.owner { background: var(--green-700); }
  .rel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .rel-card { padding: 14px; background: var(--g100); border-radius: var(--r-md); transition: all 0.2s; display: block; text-decoration: none; color: var(--charcoal); }
  .rel-card:hover { background: var(--green-50); transform: translateY(-2px); box-shadow: var(--shadow-md); text-decoration: none; }
  .rel-name { font-weight: 700; font-size: 0.88rem; margin-bottom: 3px; }
  .rel-meta { font-size: 0.75rem; color: var(--g500); }
  /* Tier 2: Images */
  .img-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .img-item img { width: 100%; height: 140px; object-fit: cover; border-radius: var(--r-md); background: var(--g100); }
  /* Tier 2: Seasonality calendar */
  .season-grid { display: flex; flex-direction: column; gap: 10px; }
  .season-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--g100); }
  .season-row:last-child { border-bottom: none; }
  .season-name { font-weight: 600; font-size: 0.88rem; min-width: 120px; display: flex; align-items: center; gap: 5px; }
  .season-live { color: var(--green-700); font-size: 0.6rem; }
  .season-bar { display: flex; gap: 2px; font-size: 0.62rem; font-weight: 600; }
  .season-bar span { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 4px; }
  .sm-on { background: var(--green-100); color: var(--green-700); }
  .sm-now { background: var(--green-700); color: var(--white); }
  .sm-off { background: var(--g100); color: var(--g400); }
  .season-note { font-size: 0.75rem; color: var(--g500); width: 100%; }
  /* Tier 2: Delivery */
  .del-grid { display: flex; flex-direction: column; gap: 8px; }
  .del-item { font-size: 0.88rem; color: var(--g700); }
  .del-item strong { color: var(--charcoal); }
  /* Tier 2: External links */
  .ext-links { display: flex; flex-wrap: wrap; gap: 8px; }
  .ext-link { display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; background: var(--g100); border-radius: var(--r-md); font-size: 0.82rem; font-weight: 600; color: var(--charcoal); text-decoration: none; transition: all 0.2s; }
  .ext-link:hover { background: var(--green-50); color: var(--green-700); transform: translateY(-1px); }
  /* Tier 2: Languages */
  .lang-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .lang-tag { padding: 5px 12px; background: var(--g100); border-radius: 20px; font-size: 0.8rem; font-weight: 600; color: var(--g700); }
  .reviews-grid { display: flex; flex-direction: column; gap: 14px; }
  .review-item { padding: 14px; background: var(--g50, #f9fafb); border-radius: 10px; border-left: 3px solid var(--green-200, #bbf7d0); }
  .review-stars { font-size: 0.85rem; margin-bottom: 4px; }
  .review-text { font-size: 0.9rem; color: var(--g700); line-height: 1.6; margin: 0; font-style: italic; }
  .review-author { font-size: 0.78rem; color: var(--g500); margin-top: 6px; }
  @media (max-width: 840px) {
    .pf-header { grid-template-columns: 1fr; }
    .pf-content { grid-template-columns: 1fr; }
    .ct-card { position: static; }
    .pf-name { font-size: 1.7rem; }
    .claim-bar { flex-direction: column; text-align: center; }
    .rel-grid { grid-template-columns: 1fr; }
    .img-grid { grid-template-columns: 1fr 1fr; }
    .season-bar span { width: 18px; height: 18px; font-size: 0.55rem; }
    .season-name { min-width: 100px; }
  }
  /* Visibility tiles (humans / AI) — hidden until JS confirms there is data */
  .pf-stat[data-stat] { display: none; }
  /* dev-request 2026-07-03-agent-profile-conversations-stats slice 2:
     server-rendered "Aktivitet" panel — replaces the old client-hydrated
     "Siste samtaler" quote list (raw conversation text) with aggregated,
     non-fabricated numbers computed in profile-activity-service.ts. */
  .act-grid { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 4px; }
  .act-stat { flex: 1 1 140px; padding: 12px 14px; background: var(--g100); border-radius: var(--r-md); }
  .act-stat strong { display: block; font-size: 1.3rem; }
  .act-stat small { font-size: 0.72rem; color: var(--g500); }
  .act-terms { display: flex; flex-wrap: wrap; gap: 8px; }
  .act-term { padding: 6px 12px; background: var(--green-50); color: var(--green-700); border-radius: 20px; font-size: 0.8rem; font-weight: 600; }
  .act-badges { display: flex; flex-wrap: wrap; gap: 8px; }
  .act-badge { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; background: var(--g100); border-radius: 20px; font-size: 0.78rem; font-weight: 600; color: var(--g700); }
  .act-sub { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--g500); font-weight: 600; margin: 14px 0 8px; }
  .act-sub:first-child { margin-top: 0; }
  /* PR-30: freshness badge — subtle, sits between badges and name */
  .profile-meta { margin: 0 0 8px; font-size: 0.78rem; color: var(--g500); }
  .profile-meta .updated-at { color: var(--g500); }
  /* Phase 5.11 A2: umbrella affiliations badges (producer view) + umbrella stub */
  .aff-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .aff-item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--green-50); border-radius: var(--r-md); border: 1px solid var(--green-100); text-decoration: none; color: var(--green-700); transition: all 0.2s; }
  .aff-item:hover { background: var(--green-100); transform: translateY(-1px); }
  .aff-icon { font-size: 1.05rem; }
  .aff-name { font-size: 0.86rem; font-weight: 600; }
  .aff-labels { font-size: 0.7rem; color: var(--g500); margin-left: 4px; }
  /* PR-58: pending_confirmation + inferred (auto-tagged via organic-cert detector) */
  .affiliation-pending { opacity: 0.7; border-style: dashed; cursor: help; }
  /* Umbrella profile (Phase 5.11 — stub in A2, filled in A4/Phase B) */
  .umb-hero { padding: 24px 0; }
  .umb-type-badge { display: inline-block; padding: 4px 10px; background: var(--green-100); color: var(--green-700); border-radius: 12px; font-size: 0.75rem; font-weight: 600; margin-bottom: 10px; }
  .umb-about { font-size: 0.95rem; color: var(--g700); line-height: 1.7; margin-top: 8px; max-width: 720px; }
  .umb-member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .umb-member-card { padding: 12px 14px; background: var(--g100); border-radius: var(--r-md); text-decoration: none; color: var(--charcoal); transition: all 0.2s; }
  .umb-member-card:hover { background: var(--green-50); transform: translateY(-1px); }
  .umb-member-name { font-weight: 700; font-size: 0.88rem; margin-bottom: 3px; }
  .umb-member-meta { font-size: 0.72rem; color: var(--g500); }
  .umb-empty { color: var(--g500); font-size: 0.9rem; padding: 24px; background: var(--g100); border-radius: var(--r-md); text-align: center; }
  .umb-parent-link { font-size: 0.82rem; color: var(--g500); margin-bottom: 10px; }
  .umb-parent-link a { color: var(--green-700); text-decoration: none; }
  .umb-parent-link a:hover { text-decoration: underline; }
  .umb-child-type { display: inline-block; padding: 2px 7px; margin-left: 6px; background: var(--green-100); color: var(--green-700); border-radius: 8px; font-size: 0.65rem; font-weight: 600; }
`;

// ─── Producer slug fuzzy matcher ──────────────────────────────
// Why: AI engines (Perplexity, ChatGPT, Claude) and link-shorteners often
// invent /produsent/<slug> URLs by slugifying a producer name they've
// seen elsewhere — but our canonical slugs include locality suffixes
// (e.g. request "bondens-marked-grunerlokka" vs. real
// "bondens-marked-birkelunden-grunerlokka"). A naive 404 there is dead
// traffic. This helper picks a high-confidence redirect target when the
// requested tokens are a unique subset of one canonical slug, and falls
// back to Jaccard-similarity suggestions otherwise.
function findProducerMatches(
  requestSlug: string,
  agents: any[]
): { redirect?: any; suggestions: any[] } {
  // Stop tokens: short Norwegian connectors that add noise to the
  // similarity score without carrying meaning ("Frukt og Grønt" etc.).
  const STOP = new Set(["og", "av", "i", "pa", "fra", "til", "for", "med", "the", "of"]);
  const tokenize = (s: string) =>
    new Set(
      s.split("-").filter((t) => t.length > 1 && !STOP.has(t))
    );

  const reqTokens = tokenize(requestSlug);
  if (reqTokens.size === 0) return { suggestions: [] };

  const subsetMatches: any[] = [];
  const scored: Array<{ agent: any; score: number }> = [];

  for (const a of agents) {
    const slug = slugify(a.name);
    if (!slug) continue;
    const tokens = tokenize(slug);
    if (tokens.size === 0) continue;

    // Subset rule: every requested token is present in the canonical slug
    let allPresent = true;
    for (const t of reqTokens) {
      if (!tokens.has(t)) { allPresent = false; break; }
    }
    if (allPresent) subsetMatches.push(a);

    // Jaccard fallback for partial overlap
    let intersect = 0;
    for (const t of reqTokens) if (tokens.has(t)) intersect++;
    const union = reqTokens.size + tokens.size - intersect;
    const jaccard = union > 0 ? intersect / union : 0;
    if (jaccard >= 0.25) scored.push({ agent: a, score: jaccard });
  }

  // Single unambiguous subset match → high-confidence redirect target
  if (subsetMatches.length === 1) {
    return { redirect: subsetMatches[0], suggestions: [] };
  }

  // Multiple subset matches → all become suggestions, ranked by trust
  if (subsetMatches.length > 1) {
    return {
      suggestions: subsetMatches
        .sort((a, b) => (b.trustScore || 0) - (a.trustScore || 0))
        .slice(0, 6),
    };
  }

  // No subset match → top Jaccard-scored suggestions
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.agent.trustScore || 0) - (a.agent.trustScore || 0)
  );
  return { suggestions: scored.slice(0, 6).map((s) => s.agent) };
}

// ─── PR-29: related-producers data access ───────────────────
//
// Why direct SQL instead of filtering getActiveAgents() in memory:
//   1. We need the agent_knowledge.about column for the preview snippet,
//      which marketplaceRegistry doesn't surface on the cached agent objects.
//   2. We want verified/rich agents to bubble up first, and that signal lives
//      on agent_knowledge — joining at the DB layer keeps the ranking honest
//      even when the marketplace cache is cold.
//   3. RANDOM() at the SQL layer gives each request a different slice of the
//      "good enough" pool, which spreads internal-link juice across more
//      producer pages over time (the actual SEO goal of this PR).
//
// Both queries deliberately use plain LIKE on categories (a JSON-encoded TEXT
// column) rather than a JSON1 extension call — better-sqlite3 ships JSON1 by
// default but we keep the query portable for any future migrate-to-Postgres.
export interface RelatedProducerRow {
  id: string;
  name: string;
  city: string | null;
  about: string | null;
  description: string | null;
  categories: string | null;
  verification_status: string | null;
  enrichment_status: string | null;
}

export function getRelatedBySameCity(
  db: any,
  agentId: string,
  cityName: string,
  limit: number = 5,
): RelatedProducerRow[] {
  if (!cityName || !agentId) return [];
  // Ordering rationale:
  //   verified DESC → trusted producers first (matches search rank logic)
  //   rich DESC    → producers with full data render the best preview
  //   RANDOM()     → break ties without favouring alphabetical order
  // is_active = 1 keeps the city block in sync with the live registry.
  return db.prepare(`
    SELECT a.id, a.name, a.city, a.description, a.categories,
           k.about, k.verification_status, k.enrichment_status
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.city = ?
      AND a.id != ?
      AND a.is_active = 1
      AND a.role = 'producer'
    ORDER BY
      CASE WHEN k.verification_status = 'verified' THEN 0 ELSE 1 END,
      CASE WHEN k.enrichment_status = 'rich' THEN 0
           WHEN k.enrichment_status = 'partial' THEN 1
           ELSE 2 END,
      RANDOM()
    LIMIT ?
  `).all(cityName, agentId, limit) as RelatedProducerRow[];
}

export function getRelatedBySameCategory(
  db: any,
  agentId: string,
  primaryCategory: string,
  excludeCity: string | null,
  limit: number = 5,
): RelatedProducerRow[] {
  if (!primaryCategory || !agentId) return [];
  // categories is stored as a JSON array like ["vegetables","eggs"].
  // LIKE '%"<cat>"%' is the cheapest way to match a single token without
  // false positives (e.g. "egg" vs "eggs"). The quotes are essential.
  const needle = `%"${primaryCategory}"%`;
  // We try to avoid duplicating the same-city block. If excludeCity is set,
  // prefer producers from OTHER cities — surfaces the "in Norway" framing
  // and adds geographic diversity to internal links. If we run out of
  // non-same-city producers we still fall back to same-city (covered by the
  // ORDER BY tiebreak below) rather than render an empty section.
  return db.prepare(`
    SELECT a.id, a.name, a.city, a.description, a.categories,
           k.about, k.verification_status, k.enrichment_status
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.id != ?
      AND a.is_active = 1
      AND a.role = 'producer'
      AND a.categories LIKE ?
    ORDER BY
      CASE WHEN ? IS NOT NULL AND a.city = ? THEN 1 ELSE 0 END,
      CASE WHEN k.verification_status = 'verified' THEN 0 ELSE 1 END,
      CASE WHEN k.enrichment_status = 'rich' THEN 0
           WHEN k.enrichment_status = 'partial' THEN 1
           ELSE 2 END,
      RANDOM()
    LIMIT ?
  `).all(agentId, needle, excludeCity, excludeCity, limit) as RelatedProducerRow[];
}

// Format a producer description into a 1-2 sentence preview for the
// related-producers card. We split on sentence-ending punctuation and
// take up to two sentences, capped at ~180 chars so the card height
// stays predictable on mobile.
export function formatRelatedPreview(text: string | null | undefined, maxChars: number = 180): string {
  if (!text) return "";
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  // Match one or two sentences ending in . ! ? — fall back to char-cap.
  const sentenceMatch = cleaned.match(/^[^.!?]+[.!?](?:\s+[^.!?]+[.!?])?/);
  let preview = sentenceMatch ? sentenceMatch[0] : cleaned;
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars - 1).replace(/\s+\S*$/, "") + "…";
  }
  return preview;
}

export function renderRelatedSection(
  rows: RelatedProducerRow[],
  heading: string,
  lang: Lang = "no",
): string {
  if (!rows.length) return "";
  const items = rows.map((r) => {
    const slug = slugify(r.name);
    let previewSource = r.description || r.about || "";
    if (previewSource && isJunkDescription(previewSource)) {
      console.log(`[description-guard] suppressed junk description (related-producer preview) for ${r.id} (${r.name})`);
      previewSource = "";
    }
    const preview = formatRelatedPreview(previewSource, 180);
    const cityLabel = r.city ? escapeHtml(r.city) : "";
    return `<a href="${localizedPath("/produsent/" + slug, lang)}" class="rp-card">
      <div class="rp-name">${escapeHtml(r.name)}</div>
      ${cityLabel ? `<div class="rp-city">&#128205; ${cityLabel}</div>` : ""}
      ${preview ? `<p class="rp-preview"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(preview)}</p>` : ""}
    </a>`;
  }).join("");
  return `<section class="rp-sec" aria-labelledby="rp-${slugify(heading)}">
    <h2 class="rp-h" id="rp-${slugify(heading)}">${escapeHtml(heading)}</h2>
    <div class="rp-grid">${items}</div>
  </section>`;
}

// CSS for the PR-29 related-producers sections. Lightweight, reuses the
// shared --green-* tokens, and is appended to PROFILE_CSS only on the
// producer page so other routes don't pay the byte cost.
export const RELATED_PRODUCERS_CSS = `
  .rp-sec { max-width: 1080px; margin: 32px auto 0; padding: 0 24px; }
  .rp-h { font-size: 1.2rem; font-weight: 700; color: var(--green-700); margin-bottom: 14px; letter-spacing: -0.2px; }
  .rp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .rp-card { display: block; padding: 14px 16px; background: var(--green-50); border: 1px solid var(--green-100); border-radius: var(--r-md); color: var(--charcoal); text-decoration: none; transition: all 0.15s; }
  .rp-card:hover { background: var(--white); border-color: var(--green-700); transform: translateY(-1px); box-shadow: var(--shadow-sm); text-decoration: none; }
  .rp-name { font-weight: 700; color: var(--green-700); font-size: 0.95rem; margin-bottom: 4px; }
  .rp-city { font-size: 0.78rem; color: var(--g500); margin-bottom: 6px; }
  .rp-preview { font-size: 0.82rem; color: var(--g700); line-height: 1.5; margin: 0; }
  @media (max-width: 560px) {
    .rp-sec { padding: 0 16px; margin-top: 24px; }
    .rp-grid { grid-template-columns: 1fr; }
  }
`;

// GEO: FAQPage JSON-LD for producer pages (dev-request 2026-06-30-geo-content-structured-data).
// Answers are built strictly from catalog fields already on the profile — never fabricated.
// Quality-gated: returns null unless at least 2 questions have real, catalog-backed answers,
// so thin/incomplete profiles emit no FAQ schema at all.
export function buildProducerFaqJsonLd(params: {
  name: string;
  url: string;
  cityName: string;
  productsList: any[];
  categories: string[];
  hoursList: any[];
  hoursText: string;
  website?: string;
  address?: string;
}): any | null {
  const qas: Array<{ q: string; a: string }> = [];

  const productNames = (params.productsList || [])
    .map((p: any) => (typeof p === "string" ? p : p?.name))
    .filter(Boolean)
    .slice(0, 8);
  const catLabels = (params.categories || []).map((c: string) => formatCat(c)).filter(Boolean);
  const sellItems = productNames.length ? productNames : catLabels;
  if (sellItems.length) {
    qas.push({
      q: `Hva selger ${params.name}?`,
      a: `${params.name} tilbyr ${sellItems.join(", ")}.`,
    });
  }

  if (params.cityName) {
    const addressPart = params.address ? `${params.address}, ` : "";
    qas.push({
      q: `Hvor ligger ${params.name}?`,
      a: `${params.name} holder til i ${addressPart}${params.cityName}.`,
    });
  }

  const hasHours = (params.hoursList || []).length > 0 || !!params.hoursText;
  const hasWebsite = !!params.website;
  if (hasHours || hasWebsite) {
    const parts: string[] = [];
    if (hasHours) parts.push("har åpningstider oppført på profilen");
    if (hasWebsite) parts.push(`kan kontaktes/bestilles via ${params.website}`);
    qas.push({
      q: `Kan jeg besøke eller bestille fra ${params.name}?`,
      a: `Ja — ${params.name} ${parts.join(" og ")}.`,
    });
  }

  if (qas.length < 2) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${params.url}#faq`,
    "mainEntity": qas.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a },
    })),
  };
}

// GEO: answer-first SSR opening for producer pages (dev-request
// 2026-06-30-geo-content-structured-data, answer-first-opening slice). AI
// engines (ChatGPT/Perplexity/Google AI Overviews) weight relevance heavily
// on a page's opening text, so this composes one lead sentence that states
// upfront what the shop sells and where — using the EXACT same catalog
// fields already verified real for buildProducerFaqJsonLd above (never
// fabricated). Quality-gated the same way: needs >=2 real facts (what they
// sell + where), otherwise returns null so the caller falls back to the
// existing about/description block untouched, and the caller MUST log the
// fallback rather than silently swallow it (a silent catch-and-null shipped
// a feature tests-green but broken in prod once already — PR-149).
export function buildProducerAnswerFirstOpening(params: {
  name: string;
  cityName: string;
  productsList: any[];
  categories: string[];
}): string | null {
  const productNames = (params.productsList || [])
    .map((p: any) => (typeof p === "string" ? p : p?.name))
    .filter(Boolean)
    .slice(0, 4);
  const catLabels = (params.categories || []).map((c: string) => formatCat(c)).filter(Boolean).slice(0, 4);
  const sellItems = productNames.length ? productNames : catLabels;

  const hasSellItems = sellItems.length > 0;
  const hasCity = !!params.cityName;
  if ((hasSellItems ? 1 : 0) + (hasCity ? 1 : 0) < 2) return null;

  const whatPart = sellItems.slice(0, 3).join(", ") + (sellItems.length > 3 ? " med mer" : "");
  return `${params.name} i ${params.cityName} selger ${whatPart} — finn kontaktinfo og bestill direkte under.`;
}

// GEO: FAQPage JSON-LD for city pages (dev-request 2026-06-30-geo-content-structured-data,
// city/category slice). Same quality gate as buildProducerFaqJsonLd: only real, catalog-derived
// facts, never fabricated, and null unless at least 2 questions have an answer — a city page with
// no distinguishing catalog data (no category signal, nobody verified) stays without FAQ schema.
export function buildCityFaqJsonLd(params: {
  cityName: string;
  url: string;
  producerCount: number;
  topCategories: string[];
  verifiedCount: number;
}): any | null {
  const qas: Array<{ q: string; a: string }> = [];

  if (params.producerCount > 0) {
    qas.push({
      q: `Hvor mange lokale produsenter finnes i ${params.cityName}?`,
      a: `Det er ${params.producerCount} lokale produsenter registrert i ${params.cityName}-området.`,
    });
  }

  if (params.topCategories.length) {
    qas.push({
      q: `Hva slags lokalmat kan jeg finne i ${params.cityName}?`,
      a: `Populære kategorier blant produsentene i ${params.cityName} er ${params.topCategories.join(", ")}.`,
    });
  }

  if (params.verifiedCount > 0) {
    qas.push({
      q: `Er produsentene i ${params.cityName} verifiserte?`,
      a: `Ja — ${params.verifiedCount} av produsentene i ${params.cityName} er verifiserte, og kan kontaktes direkte uten mellomledd.`,
    });
  }

  if (qas.length < 2) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${params.url}#faq`,
    "mainEntity": qas.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a },
    })),
  };
}

router.get("/produsent/:slug", (req: Request, res: Response) => {
  const lang = req.lang;
  const slug = (req.params.slug as string).toLowerCase();

  try {
    // Phase 5.11 A4.4 (PR-50 hotfix): the main agent lookup must include
    // umbrella-tagged agents — A4.3's migration tagged 14 lokallag + 58
    // venues, and PR-48's filter (umbrella_type IS NULL) on getActiveAgents()
    // was hiding all 70+ of those slugs from this route, returning 404 for
    // /produsent/bondens-marked-norge, /produsent/bondens-marked-mandal, etc.
    // The dedicated method below queries `WHERE is_active = 1` (no umbrella
    // filter). Downstream logic in this handler already branches on
    // umbrellaRow.umbrella_type to render either the umbrella-stub OR the
    // producer template, so all we need to do is let the lookup find them.
    //
    // The `agents` list below is still producer-only — it powers suggestions,
    // related producers, and the fuzzy fallback. Suggestions on the 404 page
    // should be PRODUCERS (humans typing producer names), not umbrellas, so
    // getActiveAgents()'s filter is correct there.
    const agent = marketplaceRegistry.getAgentBySlugIncludingUmbrellas(slug);
    const agents = marketplaceRegistry.getActiveAgents();

    if (!agent) {
      // Fuzzy fallback so AI-engine traffic that constructs slugs from
      // names (e.g. Perplexity citing "bondens-marked-grunerlokka" when
      // the canonical is "bondens-marked-birkelunden-grunerlokka") gets
      // a useful page instead of a dead end.
      const match = findProducerMatches(slug, agents);

      if (match.redirect) {
        const canonical = slugify(match.redirect.name);
        if (canonical && canonical !== slug) {
          // 301 tells crawlers to update their index — preserves SEO juice
          // and teaches Perplexity/ChatGPT/Claude the canonical URL.
          return res.redirect(301, `${localizedPath("/produsent/" + canonical, lang)}`);
        }
      }

      const totalAgents = agents.length;
      const enS = lang === "en";
      const suggestionsHtml = match.suggestions.length
        ? `<div class="sec">
            <h2 style="font-size:1.4rem;margin-bottom:8px;">${enS ? "Did you mean any of these?" : "Mente du noen av disse?"}</h2>
            <p style="color:var(--g500);margin-bottom:24px;">${enS ? `We have ${totalAgents}+ producers. These are the closest matches for what you searched.` : `Vi har ${totalAgents}+ produsenter. Disse ligner mest på det du søkte etter.`}</p>
            <div class="grid">${match.suggestions.map((a: any) => producerCard(a, undefined, lang)).join("")}</div>
          </div>`
        : "";

      // HTTP 404 status (soft-200 hurts Google ranking) but rich body so
      // AI agents and humans can still find what they were after.
      const en = lang === "en";
      return res.status(404).send(shell(
        en ? `Producer not found — ${getConfig().display_name}` : `Produsent ikke funnet — ${getConfig().display_name}`,
        en
          ? `We couldn't find a producer at URL «${slug}». Search or browse our ${totalAgents}+ food producers across Norway.`
          : `Vi fant ingen produsent med URL «${slug}». Søk eller bla blant ${totalAgents}+ ${getConfig().domain_dictionary.entity_plural_long} i hele Norge.`,
        `<div class="sec" style="text-align:center;padding:64px 24px 32px;">
          <h1 style="font-size:2rem;margin-bottom:12px;">${en ? "Producer not found" : "Produsent ikke funnet"}</h1>
          <p style="color:var(--g500);max-width:640px;margin:0 auto 28px;">${en ? "The URL" : "URL-en"} <code style="background:var(--g100);padding:2px 8px;border-radius:4px;">/produsent/${escapeHtml(slug)}</code> ${en ? "doesn't match any producer in our network. The link may be outdated, or the producer name may have changed." : "matcher ingen produsent i nettverket vårt. Lenken kan være utdatert, eller produsentnavnet kan ha endret seg."}</p>
          <form action="${localizedPath("/sok", lang)}" method="get" style="max-width:520px;margin:0 auto 24px;display:flex;gap:8px;">
            <input type="text" name="q" placeholder="${en ? "Search for food, place or producer…" : "Søk etter mat, sted eller produsent…"}" aria-label="${en ? "Search producers" : "Søk produsenter"}" style="flex:1;padding:14px 16px;border:1px solid var(--g300);border-radius:10px;font-size:1rem;">
            <button type="submit" style="padding:14px 24px;background:var(--green);color:#fff;border:0;border-radius:10px;font-weight:600;cursor:pointer;">${en ? "Search" : "Søk"}</button>
          </form>
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            <a href="${localizedPath("/oslo", lang)}" class="city-pill">Oslo</a>
            <a href="${localizedPath("/bergen", lang)}" class="city-pill">Bergen</a>
            <a href="${localizedPath("/trondheim", lang)}" class="city-pill">Trondheim</a>
            <a href="${localizedPath("/stavanger", lang)}" class="city-pill">Stavanger</a>
            <a href="${localizedPath("/sok", lang)}" class="city-pill">${en ? "See all " + totalAgents + "+ producers →" : "Se alle " + totalAgents + "+ produsenter →"}</a>
          </div>
        </div>
        ${suggestionsHtml}`,
        {
          extraCss: `.city-pill{display:inline-block;padding:10px 18px;background:var(--g100);color:var(--g700);border-radius:999px;font-weight:500;text-decoration:none;transition:all .15s;}.city-pill:hover{background:var(--green);color:#fff;}`,
          lang,
          pathForAlternate: "/produsent/" + slug,
        }
      ));
    }

    // Track producer page view for analytics dashboard
    const cityName = (agent as any).city || (agent as any).location?.city || "";
    analyticsService.trackAgentView(agent.id, agent.name, cityName, "seo");

    // ── PR-30: freshness signal ─────────────────────────────────────
    // agent_knowledge.updated_at (TEXT, ISO 8601) is bumped on every
    // enrichment write (PR-24/PR-28 wired this into the hourly verifier).
    // We surface that as:
    //   1. A visible <time> badge near the top of this page
    //   2. A "(oppdatert <month>)" suffix on <title> when <30d old
    //   3. <lastmod> per URL in /sitemap.xml
    // Fallback: created_at if updated_at is null (legacy rows).
    let updatedAtDate: Date | null = null;
    try {
      const fresh = getDb()
        .prepare("SELECT updated_at, created_at FROM agent_knowledge WHERE agent_id = ?")
        .get(agent.id) as { updated_at?: string; created_at?: string } | undefined;
      if (fresh) {
        updatedAtDate = parseIsoOrSqlite(fresh.updated_at) || parseIsoOrSqlite(fresh.created_at);
      }
    } catch (e) {
      console.error("[seo] freshness query failed:", e);
    }

    // Phase 5.4a M2 — claim status (server-rendered so AI bots see CTA per A3).
    // FIX 2026-05-10: PR-8 used agents.claimed_at directly, but canonical claim signal
    // is agent_claims.status='verified' (used by /api/marketplace/agents and elsewhere).
    // M1's magic-link-verify doesn't currently write to agents.claimed_at, so the
    // direct-column probe always returned false, breaking Variant A.
    let isClaimed = false;
    try {
      isClaimed = knowledgeService.isAgentClaimed(agent.id);
    } catch (e) {
      console.error("[seo] claim status query failed:", e);
    }

    const info = knowledgeService.getAgentInfo(agent.id);
    const k = (info?.knowledge || {}) as any;
    const meta = (info?.meta || {}) as any;
    const trustPct = Math.round((agent.trustScore || 0) * 100);

    // Render-time guard: nav/boilerplate scraped text masquerading as a real
    // description must never render (dev-request 2026-07-04-rfb-datakvalitet
    // item 1, render-guard-only slice — mirrors item 3's isDisplayablePhone
    // pattern). Computed once here and reused by every section below (hero
    // lede, umbrella "about", LocalBusiness JSON-LD, <meta name="description">)
    // so a junk value never reaches any public output for this page.
    const rawDescription = agent.description || "";
    const rawAbout = k.about || "";
    const safeDescription = isJunkDescription(rawDescription) ? "" : rawDescription;
    const safeAbout = isJunkDescription(rawAbout) ? "" : rawAbout;
    if (rawDescription && !safeDescription) {
      console.log(`[description-guard] suppressed junk agent.description for ${agent.id} (${agent.name}) on /produsent/${slug}`);
    }
    if (rawAbout && !safeAbout) {
      console.log(`[description-guard] suppressed junk knowledge.about for ${agent.id} (${agent.name}) on /produsent/${slug}`);
    }

    // ─── Phase 5.11 A2: umbrella-fields + affiliations lookup ─────────
    // The A1 migration added umbrella_type/parent_umbrella_id/etc. as
    // nullable columns. We read them directly here rather than threading
    // them through marketplaceRegistry.RegisteredAgent for now (keeps the
    // type changes scoped to seo.ts). When A3 ships admin write endpoints,
    // we'll consider promoting these into the RegisteredAgent shape.
    const umbDb = getDb();
    let umbrellaRow: any = null;
    try {
      umbrellaRow = umbDb.prepare(
        "SELECT umbrella_type, parent_umbrella_id, umbrella_member_count, umbrella_scrape_config, umbrella_venues FROM agents WHERE id = ?"
      ).get(agent.id);
    } catch (e) {
      // If columns are missing (pre-A1 deploy somehow) treat as non-umbrella.
      console.error("[seo:phase5.11] umbrella row lookup failed:", e);
    }
    const isUmbrella = !!(umbrellaRow && umbrellaRow.umbrella_type);

    // Affiliations FOR a producer (forward direction):
    //   "What umbrellas is this producer a member of?"
    // Used to render the conditional "Tilknytninger" card + memberOf JSON-LD.
    // PR-58 (2026-05-16): also surface pending_confirmation+inferred rows so
    // the producer page shows "antatt sertifisert via Debio (ikke bekreftet)"
    // for auto-tagged organic-cert links until the producer accepts/rejects.
    type Affiliation = {
      umbrella_id: string;
      umbrella_name: string;
      umbrella_slug: string;
      labels: string[];
      status: string;   // 'active' | 'pending_confirmation'
      source: string;   // 'self_claimed' | 'scraped' | 'admin' | 'umbrella_confirmed' | 'inferred'
    };
    let affiliations: Affiliation[] = [];
    if (!isUmbrella) {
      try {
        const rows = umbDb.prepare(`
          SELECT a.id AS umbrella_id, a.name AS umbrella_name, aff.labels,
                 aff.status, aff.source
          FROM agent_affiliations aff
          INNER JOIN agents a ON a.id = aff.umbrella_id
          WHERE aff.producer_id = ?
            AND (aff.status = 'active'
              OR (aff.status = 'pending_confirmation' AND aff.source = 'inferred'))
          ORDER BY a.name ASC
        `).all(agent.id) as any[];
        affiliations = rows.map(r => ({
          umbrella_id: r.umbrella_id,
          umbrella_name: r.umbrella_name,
          umbrella_slug: slugify(r.umbrella_name),
          labels: r.labels ? (() => { try { return JSON.parse(r.labels); } catch { return []; } })() : [],
          status: r.status,
          source: r.source,
        }));
      } catch (e) {
        // No agent_affiliations table → fall through with empty array.
        console.error("[seo:phase5.11] affiliations forward query failed:", e);
      }
    }

    // Affiliations FOR an umbrella (reverse direction):
    //   "Which producers are members of this umbrella?"
    // Used by the umbrella stub template's "Produsenter i nettverket" section.
    // ─── Phase 5.11 A5: umbrella children come from TWO sources ──────
    // 1. Direct hierarchy (agents.parent_umbrella_id = this umbrella):
    //    national → lokallag, lokallag → venues, venue → producers (rare).
    // 2. Affiliations table (independent producers tied to umbrellas
    //    via agent_affiliations, e.g. Erga Gårdsutsalg ↔ Bondens marked).
    // We merge + dedupe by id, preserving umbrella_type so the render
    // code can choose the right section label and JSON-LD subtype.
    type UmbrellaChild = {
      producer_id: string;
      producer_name: string;
      producer_slug: string;
      city: string | null;
      umbrella_type: string | null;
      member_count?: number;
    };
    let umbrellaChildren: UmbrellaChild[] = [];
    if (isUmbrella) {
      const byId = new Map<string, UmbrellaChild>();

      // Source 1: direct children via parent_umbrella_id
      try {
        const rows = umbDb.prepare(`
          SELECT id, name, city, umbrella_type, umbrella_member_count
          FROM agents
          WHERE parent_umbrella_id = ?
            AND is_active = 1
          ORDER BY name ASC
        `).all(agent.id) as any[];
        for (const r of rows) {
          byId.set(r.id, {
            producer_id: r.id,
            producer_name: r.name,
            producer_slug: slugify(r.name),
            city: r.city,
            umbrella_type: r.umbrella_type || null,
            member_count: typeof r.umbrella_member_count === "number" ? r.umbrella_member_count : undefined,
          });
        }
      } catch (e) {
        console.error("[seo:phase5.11] direct children query failed:", e);
      }

      // Source 2: affiliated producers via agent_affiliations
      try {
        const rows = umbDb.prepare(`
          SELECT a.id AS producer_id, a.name AS producer_name, a.city AS city, a.umbrella_type AS umbrella_type
          FROM agent_affiliations aff
          INNER JOIN agents a ON a.id = aff.producer_id
          WHERE aff.umbrella_id = ?
            AND aff.status = 'active'
            AND a.is_active = 1
          ORDER BY a.trust_score DESC, a.name ASC
          LIMIT 100
        `).all(agent.id) as any[];
        for (const r of rows) {
          if (!byId.has(r.producer_id)) {
            byId.set(r.producer_id, {
              producer_id: r.producer_id,
              producer_name: r.producer_name,
              producer_slug: slugify(r.producer_name),
              city: r.city,
              umbrella_type: r.umbrella_type || null,
            });
          }
        }
      } catch (e) {
        console.error("[seo:phase5.11] affiliations reverse query failed:", e);
      }

      umbrellaChildren = Array.from(byId.values());
    }

    // ─── Phase 5.11 A2: umbrella stub render ─────────────────────────
    // Render a minimal umbrella-profile page when umbrella_type is set.
    // This is a STUB: Stage A2 ships the role-branching plumbing; Stage A4
    // and Phase B populate venues + members and refine the visual design.
    // For now: hero (umbrella_type badge + name + "Hva er X?" placeholder),
    // optional venues list, member-producer grid. JSON-LD uses Organization
    // type with `member` (reverse direction of producer's `memberOf`).
    if (isUmbrella) {
      const umbType = umbrellaRow.umbrella_type as string;
      const umbTypeNo: Record<string, string> = {
        "market_network": "Marked-nettverk",
        "venue": "Salgsvenue",
        "industry_org": "Bransjeorganisasjon",
        "certification": "Sertifiseringsorganisasjon",
        "cooperative": "Samvirke",
      };
      const umbTypeBadge = umbTypeNo[umbType] || umbType;
      const aboutText = (safeAbout || safeDescription || "").trim();
      const venuesList = (() => {
        try { return umbrellaRow.umbrella_venues ? JSON.parse(umbrellaRow.umbrella_venues) : []; }
        catch { return []; }
      })();

      // ─── Phase 5.11 A5 Fix #2: parent breadcrumb back-link ─────────
      // If this umbrella has a parent, render a "← Del av: <parent>"
      // link above the H1. Walks one level only; deep hierarchies render
      // their lineage one hop at a time via the chain of profile pages.
      let umbParentHtml = "";
      let umbParentJsonLd: { name: string; slug: string } | null = null;
      if (umbrellaRow.parent_umbrella_id) {
        try {
          const parent = umbDb.prepare("SELECT name FROM agents WHERE id = ?").get(umbrellaRow.parent_umbrella_id) as any;
          if (parent?.name) {
            const parentSlug = slugify(parent.name);
            umbParentJsonLd = { name: parent.name, slug: parentSlug };
            umbParentHtml = `<div class="umb-parent-link">&larr; <a href="/produsent/${parentSlug}">Del av: ${escapeHtml(parent.name)}</a></div>`;
          }
        } catch (e) { /* parent not found — ignore */ }
      }

      // ─── Phase 5.11 A5 Fix #1: contact card (reuses producer pattern) ──
      // Same contactItems shape as the producer template. Hidden entirely
      // if no contact fields are set. Maps search always falls back to
      // "<name>, <city>, Norge" even if address is missing.
      const umbContactItems: string[] = [];
      if (k.address) umbContactItems.push(`<div class="ct-item"><div class="ct-icon">&#128205;</div><div><div class="ct-label">Adresse</div><div class="ct-val">${escapeHtml(k.address)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</div></div></div>`);
      if (isDisplayablePhone(k.phone)) umbContactItems.push(`<div class="ct-item"><div class="ct-icon">&#128222;</div><div><div class="ct-label">Telefon</div><div class="ct-val"><a href="tel:${k.phone.replace(/\s+/g, "")}">${escapeHtml(k.phone)}</a></div></div></div>`);
      if (k.email) umbContactItems.push(`<div class="ct-item"><div class="ct-icon">&#9993;</div><div><div class="ct-label">E-post</div><div class="ct-val"><a href="mailto:${k.email}">${escapeHtml(k.email)}</a></div></div></div>`);
      if (k.website) umbContactItems.push(`<div class="ct-item"><div class="ct-icon">&#127760;</div><div><div class="ct-label">Nettside</div><div class="ct-val"><a href="${escapeHtml(addUtmParams(k.website))}" target="_blank" rel="noopener">${escapeHtml(k.website.replace(/^https?:\/\//, ""))}</a></div></div></div>`);
      // Google Maps search — search by name + (address|city), never raw coords.
      if (k.address || isDisplayablePhone(k.phone) || k.email || k.website) {
        const umbMapsParts = [agent.name];
        if (k.address) umbMapsParts.push(k.address);
        if (cityName) umbMapsParts.push(cityName);
        umbMapsParts.push("Norge");
        const umbMapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(umbMapsParts.join(", "))}`;
        umbContactItems.push(`<div class="ct-item"><div class="ct-icon">&#128506;</div><div><div class="ct-label">Kart</div><div class="ct-val"><a href="${umbMapsUrl}" target="_blank" rel="noopener">Vis p\u00e5 Google Maps</a></div></div></div>`);
      }
      const umbContactHtml = umbContactItems.length
        ? `<div class="card"><div class="card-head"><span>&#128242;</span><h3>Kontakt</h3></div><div class="card-body">${umbContactItems.join("")}</div></div>`
        : "";

      // ─── Phase 5.11 A5 Fix #4: section label varies by children's type ──
      const childTypes = new Set(umbrellaChildren.map(c => c.umbrella_type || "producer"));
      let sectionLabel = "";
      if (umbType === "venue") {
        // Venues are leaves in the hierarchy — no children section.
        sectionLabel = "";
      } else if (umbrellaChildren.length === 0) {
        // Non-venue umbrella with no children → keep the existing
        // empty-state copy so producers know how to opt in.
        sectionLabel = "Produsenter i nettverket";
      } else if (childTypes.size === 1 && childTypes.has("market_network")) {
        sectionLabel = "Lokallag i nettverket";
      } else if (childTypes.size === 1 && childTypes.has("venue")) {
        sectionLabel = "Markedsplasser";
      } else if (childTypes.has("market_network") && childTypes.has("venue")) {
        sectionLabel = "Lokallag og markedsplasser";
      } else {
        sectionLabel = "Produsenter i nettverket";
      }

      // Per-child cards include a small umbrella_type badge so users
      // immediately understand the hierarchy at a glance.
      const memberGridHtml = umbrellaChildren.length
        ? umbrellaChildren.map(m => {
            const countSuffix = m.umbrella_type && m.member_count
              ? ` &middot; ${m.member_count} ${m.umbrella_type === 'venue' ? 'produsenter' : 'markedsplasser'}`
              : "";
            return `<a href="/produsent/${m.producer_slug}" class="umb-member-card">` +
              `<div class="umb-member-name">${escapeHtml(m.producer_name)}</div>` +
              `<div class="umb-member-meta">${m.city ? escapeHtml(m.city) : ""}${countSuffix}</div>` +
              `</a>`;
          }).join("")
        : "";

      // ─── PR-56 (2026-05-16): Kommende Bondens marked-arrangementer ───
      // Renders only when this umbrella is in the Bondens marked tree
      // (national / lokallag / venue). Reads bm_market_events populated by
      // the daily scraper. Quietly omitted on empty/missing-table.
      let bmEventsHtml = "";
      let bmEventsCountHeader = "";
      try {
        // Decide whether this umbrella participates in the BM tree.
        const isVenue = umbrellaRow.umbrella_type === "venue";
        const isLokallag = umbrellaRow.umbrella_type === "market_network" && !!umbrellaRow.parent_umbrella_id;
        const isNational = agent.name.toLowerCase() === "bondens marked norge";

        if (isVenue || isLokallag || isNational) {
          let eventRows: Array<{ event_name: string; location_text: string; start_at: string; end_at: string | null; source_url: string; venue_name: string; venue_id: string }> = [];
          const nowIso = new Date().toISOString();
          if (isVenue) {
            eventRows = umbDb.prepare(`
              SELECT e.event_name, e.location_text, e.start_at, e.end_at, e.source_url,
                     a.id AS venue_id, a.name AS venue_name
              FROM bm_market_events e INNER JOIN agents a ON a.id = e.venue_agent_id
              WHERE e.venue_agent_id = ? AND e.start_at >= ?
                AND (a.umbrella_type != \'bm_venue\' OR a.agent_review_status = \'confirmed\')
              ORDER BY e.start_at ASC LIMIT 5
            `).all(agent.id, nowIso) as any[];
          } else if (isLokallag) {
            eventRows = umbDb.prepare(`
              SELECT e.event_name, e.location_text, e.start_at, e.end_at, e.source_url,
                     a.id AS venue_id, a.name AS venue_name
              FROM bm_market_events e INNER JOIN agents a ON a.id = e.venue_agent_id
              WHERE (a.parent_umbrella_id = ? OR e.venue_agent_id = ?) AND e.start_at >= ?
                AND (a.umbrella_type != \'bm_venue\' OR a.agent_review_status = \'confirmed\')
              ORDER BY e.start_at ASC LIMIT 10
            `).all(agent.id, agent.id, nowIso) as any[];
          } else {
            // National: top-5 + counts
            eventRows = umbDb.prepare(`
              SELECT e.event_name, e.location_text, e.start_at, e.end_at, e.source_url,
                     a.id AS venue_id, a.name AS venue_name
              FROM bm_market_events e INNER JOIN agents a ON a.id = e.venue_agent_id
              WHERE e.start_at >= ?
                AND (a.umbrella_type != \'bm_venue\' OR a.agent_review_status = \'confirmed\')
              ORDER BY e.start_at ASC LIMIT 5
            `).all(nowIso) as any[];
            const weekIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            const monthIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            const countWeek = umbDb.prepare(
              "SELECT COUNT(*) AS c FROM bm_market_events WHERE start_at >= ? AND start_at <= ?"
            ).get(nowIso, weekIso) as { c: number } | undefined;
            const countMonth = umbDb.prepare(
              "SELECT COUNT(*) AS c FROM bm_market_events WHERE start_at >= ? AND start_at <= ?"
            ).get(nowIso, monthIso) as { c: number } | undefined;
            if ((countWeek?.c || 0) > 0 || (countMonth?.c || 0) > 0) {
              bmEventsCountHeader = `<div class="bm-events-counts">
                <strong>${countWeek?.c || 0}</strong> markeder denne uka &middot;
                <strong>${countMonth?.c || 0}</strong> markeder neste 30 dager
              </div>`;
            }
          }

          if (eventRows.length > 0) {
            const items = eventRows.map(r => {
              const date = (r.start_at || "").slice(0, 10);
              const time = (r.start_at || "").slice(11, 16);
              const endTime = r.end_at ? (r.end_at || "").slice(11, 16) : "";
              const timeStr = time ? ` ${escapeHtml(time)}${endTime ? "&ndash;" + escapeHtml(endTime) : ""}` : "";
              // Show venue annotation when this isn't a venue page itself.
              const venueAnno = !isVenue ? ` &middot; <a href="/produsent/${slugify(r.venue_name)}">${escapeHtml(r.venue_name)}</a>` : "";
              const loc = r.location_text ? ` (${escapeHtml(r.location_text)})` : "";
              return `<li><strong>${escapeHtml(date)}</strong>${timeStr} &mdash; ${escapeHtml(r.event_name)}${loc}${venueAnno}</li>`;
            }).join("");
            bmEventsHtml = `
        <div class="card">
          <div class="card-head"><span>&#128197;</span><h3>Kommende markedsdager${eventRows.length ? ` (${eventRows.length})` : ""}</h3></div>
          <div class="card-body">
            ${bmEventsCountHeader}
            <ul class="bm-events-list">${items}</ul>
          </div>
        </div>`;
          }
        }
      } catch (e) {
        // Table missing or query failed — silently omit the section.
        // Most common cause: bm_market_events not yet populated by the
        // daily scraper, which is fine on a fresh deploy.
      }

      const umbJsonLd: any = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": `${BASE_URL}/produsent/${slug}#org`,
        "name": agent.name,
        "description": aboutText || `${umbTypeBadge} på rettfrabonden.com`,
        "url": `${BASE_URL}/produsent/${slug}`,
      };
      if (umbParentJsonLd) {
        umbJsonLd.subOrganization = {
          "@type": "Organization",
          "@id": `${BASE_URL}/produsent/${umbParentJsonLd.slug}#org`,
          "name": umbParentJsonLd.name,
          "url": `${BASE_URL}/produsent/${umbParentJsonLd.slug}`,
        };
      }
      // ─── Phase 5.11 A5 Fix #5: JSON-LD member type tracks child type ──
      if (umbrellaChildren.length) {
        umbJsonLd.member = umbrellaChildren.map(m => ({
          "@type": m.umbrella_type === "market_network" ? "Organization" : "LocalBusiness",
          "name": m.producer_name,
          "url": `${BASE_URL}/produsent/${m.producer_slug}`,
        }));
      }

      const umbContent = `
    <div class="bc"><a href="/">Hjem</a><span>/</span>${escapeHtml(agent.name)}</div>

    <div class="pf-header" style="grid-template-columns: 1fr;">
      <div class="umb-hero">
        ${umbParentHtml}
        <span class="umb-type-badge">${escapeHtml(umbTypeBadge)}</span>
        <h1 class="pf-name" translate="no">${escapeHtml(agent.name)}</h1>
        ${aboutText ? `<p class="umb-about">${escapeHtml(aboutText)}</p>` : `<p class="umb-empty">Beskrivelse av denne paraplyen blir lagt til snart.</p>`}
      </div>
    </div>

    <div class="pf-content" style="grid-template-columns: 1fr;">
      <div class="pf-main">
        ${umbContactHtml}

        ${bmEventsHtml}

        ${sectionLabel ? `
        <div class="card">
          <div class="card-head"><span>&#128101;</span><h3>${escapeHtml(sectionLabel)}${umbrellaChildren.length ? ` (${umbrellaChildren.length})` : ""}</h3></div>
          <div class="card-body">
            ${memberGridHtml ? `<div class="umb-member-grid">${memberGridHtml}</div>` : `<div class="umb-empty">Ingen produsenter er ennå koblet til ${escapeHtml(agent.name)}. Hvis du er produsent og selger gjennom denne paraplyen, kan du opprette en tilknytning fra din profilside.</div>`}
          </div>
        </div>` : ""}

        ${venuesList.length ? `
        <div class="card">
          <div class="card-head"><span>&#128205;</span><h3>Markedsplasser</h3></div>
          <div class="card-body"><ul>${venuesList.slice(0, 50).map((v: any) =>
            `<li>${escapeHtml(typeof v === "string" ? v : (v.name || ""))}${typeof v === "object" && v.city ? ` — ${escapeHtml(v.city)}` : ""}</li>`
          ).join("")}</ul></div>
        </div>` : ""}
      </div>
    </div>`;

      return res.send(shell(
        `${agent.name} — ${getConfig().display_name}`,
        aboutText || `${umbTypeBadge} på rettfrabonden.com med ${umbrellaChildren.length} medlemsprodusenter`,
        umbContent,
        {
          extraCss: PROFILE_CSS,
          lang,
          jsonLd: umbJsonLd,
          pathForAlternate: "/produsent/" + slug,
        }
      ));
    }


    // Badges
    const badges: string[] = [];
    if (agent.isVerified) badges.push(`<span class="badge badge-v">&#10003; Verifisert</span>`);
    const certs = k.certifications || [];
    if (certs.some((c: string) => c.toLowerCase().includes("kolog"))) badges.push(`<span class="badge badge-o">&#127793; \u00d8kologisk</span>`);
    (agent.categories || []).slice(0, 3).forEach((c: string) => badges.push(`<span class="badge badge-c">${escapeHtml(formatCat(c))}</span>`));

    // Contact items
    const contactItems: string[] = [];
    if (k.address) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#128205;</div><div><div class="ct-label">Adresse</div><div class="ct-val">${escapeHtml(k.address)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</div></div></div>`);
    // ─── dev-request 2026-07-03-agent-profile-conversations-stats slice 2
    // (work item 3): mailto:/tel: get a data-track-kind hook (beacon fired
    // by a delegated click listener at the bottom of this page — see the
    // <script> block below; addEventListener only, no inline onclick= —
    // this platform's CSP/SES setup forbids inline handlers). The beacon
    // is fire-and-forget and never blocks navigation, so these links keep
    // working identically with JS disabled or if the beacon call fails.
    if (isDisplayablePhone(k.phone)) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#128222;</div><div><div class="ct-label">Telefon</div><div class="ct-val"><a href="tel:${k.phone.replace(/\s+/g, "")}" data-track-kind="phone">${escapeHtml(k.phone)}</a></div></div></div>`);
    if (k.email) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#9993;</div><div><div class="ct-label">E-post</div><div class="ct-val"><a href="mailto:${k.email}" data-track-kind="email">${escapeHtml(k.email)}</a></div></div></div>`);
    // Website now routes through the counting redirect (GET /ut/:agentId/website,
    // src/routes/contact-tracking.ts) instead of linking straight to
    // agent_knowledge.website. This works with JS fully disabled (it's a
    // plain server-side 302), and still carries the same default UTM tags
    // the direct link used to (resolveRedirectUrl applies addUtmParams for
    // the "website" kind specifically — see that file).
    if (k.website) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#127760;</div><div><div class="ct-label">Nettside</div><div class="ct-val"><a href="/ut/${encodeURIComponent(agent.id)}/website" target="_blank" rel="noopener">${escapeHtml(k.website.replace(/^https?:\/\//, ""))}</a></div></div></div>`);

    // Google Maps link — ALWAYS search by business name, never raw coordinates.
    // Our lat/lng are often just city-center approximations, not actual business
    // locations. Google Maps search finds the real registered business listing.
    const mapsSearchParts = [agent.name];
    if (k.address) mapsSearchParts.push(k.address);
    if (cityName) mapsSearchParts.push(cityName);
    mapsSearchParts.push("Norge");
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(mapsSearchParts.join(", "))}`;
    contactItems.push(`<div class="ct-item"><div class="ct-icon">&#128506;</div><div><div class="ct-label">Kart</div><div class="ct-val"><a href="${mapsUrl}" target="_blank" rel="noopener">Vis p\u00e5 Google Maps</a></div></div></div>`);

    // Products — guard against string data (some agents have free-text or plain string arrays)
    const productsList = Array.isArray(k.products) ? k.products : [];
    const productsHtml = productsList.length
      ? productsList.map((p: any) => {
          // Handle both object products ({name, category, price}) and plain strings ("brød")
          const name = typeof p === "string" ? p : (p.name || "");
          if (!name) return "";
          const months = (typeof p === "object" && (p.months || p.seasonMonths)) || [];
          const seasonal = typeof p === "object" && p.seasonal && months.length
            ? `<span class="prod-season">${months.map((m: number) => MONTH_NAMES[m] || m).join("\u2013")}</span>` : "";
          const org = typeof p === "object" && p.organic ? `<span class="prod-org">&#127793; \u00d8ko</span>` : "";
          const price = typeof p === "object" && p.price ? `<span class="prod-price">${escapeHtml(String(p.price))}${p.priceUnit && p.priceUnit !== 'kr' ? ' ' + escapeHtml(p.priceUnit) : ''}</span>` : "";
          return `<div class="prod-item"><span class="prod-name">${escapeHtml(name)}</span>${price}<div class="prod-meta">${seasonal}${org}</div></div>`;
        }).filter(Boolean).join("") : "";

    // Opening hours — guard against string data (some agents have free-text like "Man-Fre 10-17")
    const today = new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const todayShort = today.slice(0, 3);
    const hoursList = Array.isArray(k.openingHours) ? k.openingHours : [];
    const hoursText = !Array.isArray(k.openingHours) && typeof k.openingHours === "string" && k.openingHours ? k.openingHours : "";
    const hoursHtml = hoursList.length
      ? hoursList.map((h: any) => {
          const isToday = h.day === todayShort || h.day === today;
          const cls = isToday ? " hrs-today" : "";
          return `<div class="hrs-day${cls}">${DAY_NAMES[h.day] || h.day}${isToday ? '<span class="hrs-open"><span class="hrs-dot"></span> I dag</span>' : ""}</div><div class="hrs-time${cls}">${h.open} \u2013 ${h.close}${h.note ? ` (${escapeHtml(h.note)})` : ""}</div>`;
        }).join("")
      : hoursText ? `<div class="hrs-day">${escapeHtml(hoursText)}</div>` : "";

    // Certifications
    const certsHtml = certs.length
      ? certs.map((c: string) => `<div class="cert-item"><span style="font-size:1.1rem;">&#127942;</span><span class="cert-text">${escapeHtml(c)}</span></div>`).join("") : "";

    // Related producers in same city
    const related = cityName
      ? agents.filter((a: any) => {
          const c = a.city || a.location?.city || "";
          return c === cityName && a.id !== agent.id;
        }).sort((a: any, b: any) => (b.trustScore || 0) - (a.trustScore || 0)).slice(0, 4)
      : [];

    const relatedHtml = related.map((a: any) => {
      const trust = Math.round((a.trustScore || 0) * 100);
      const cats = (a.categories || []).slice(0, 2).map((c: string) => `<span class="tag" style="font-size:0.66rem;">${escapeHtml(formatCat(c))}</span>`).join("");
      return `<a href="/produsent/${slugify(a.name)}" class="rel-card">
        <div class="rel-name">${escapeHtml(a.name)}</div>
        <div class="rel-meta">${escapeHtml(cityName)} · Trust ${trust}%</div>
        <div style="margin-top:6px;">${cats}</div>
      </a>`;
    }).join("");

    // Images gallery
    const imagesList = Array.isArray(k.images) ? k.images.filter((u: string) => u && u.startsWith("http")) : [];
    const imagesHtml = imagesList.length
      ? imagesList.slice(0, 6).map((url: string) =>
          `<div class="img-item"><img src="${escapeHtml(url)}" alt="${escapeHtml(agent.name)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        ).join("")
      : "";

    // Seasonality calendar
    const seasonList = Array.isArray(k.seasonality) ? k.seasonality : [];
    const currentMonth = new Date().getMonth() + 1; // 1-12
    const seasonHtml = seasonList.length
      ? seasonList.map((s: any) => {
          const months = s.months || [];
          const inSeason = months.includes(currentMonth);
          const monthDots = Array.from({ length: 12 }, (_, i) => {
            const m = i + 1;
            const active = months.includes(m);
            const cls = active ? (m === currentMonth ? "sm-now" : "sm-on") : "sm-off";
            return `<span class="${cls}" title="${MONTH_NAMES[m] || m}">${MONTH_NAMES[m]?.charAt(0) || m}</span>`;
          }).join("");
          return `<div class="season-row">
            <div class="season-name">${inSeason ? '<span class="season-live">&#9679;</span>' : ""}${escapeHtml(s.product || "")}</div>
            <div class="season-bar">${monthDots}</div>
            ${s.note ? `<div class="season-note">${escapeHtml(s.note)}</div>` : ""}
          </div>`;
        }).join("")
      : "";

    // Delivery info
    const deliveryParts: string[] = [];
    if (k.deliveryRadius) deliveryParts.push(`<div class="del-item"><strong>Leveringsradius:</strong> ${k.deliveryRadius} km</div>`);
    if (k.minOrderValue) deliveryParts.push(`<div class="del-item"><strong>Minstebestilling:</strong> ${k.minOrderValue} kr</div>`);
    if ((k.deliveryOptions || []).length) deliveryParts.push(`<div class="del-item"><strong>Leveringsmetoder:</strong> ${(k.deliveryOptions as string[]).join(", ")}</div>`);
    if ((k.paymentMethods || []).length) deliveryParts.push(`<div class="del-item"><strong>Betaling:</strong> ${(k.paymentMethods as string[]).join(", ")}</div>`);
    const deliveryHtml = deliveryParts.join("");

    // ─── Phase 5.11 A2: affiliations card (producer view) ───────────
    // Hidden when affiliations is empty (matches the existing hide-when-empty
    // pattern used by imagesHtml, productsHtml, hoursHtml, etc.).
    const affiliationsHtml = affiliations.length
      ? affiliations.map(a => {
          const labelsTxt = a.labels.length ? ` <span class="aff-labels">${a.labels.map(l => escapeHtml(l)).join(" · ")}</span>` : "";
          // PR-58: pending_confirmation + inferred rows render with a
          // dashed "antatt — ikke bekreftet" treatment until the producer
          // confirms (via owner-portal) or rejects (via /opt-out).
          const isPending = a.status === "pending_confirmation" && a.source === "inferred";
          const pendingClass = isPending ? " affiliation-pending" : "";
          const pendingSuffix = isPending ? " (antatt — ikke bekreftet)" : "";
          const pendingTitle = isPending
            ? ` title="Vi har gjettet denne tilknytningen basert på tekst på din nettside. Logg inn på eier-portalen for å bekrefte eller avvise."`
            : "";
          return `<a href="/produsent/${a.umbrella_slug}" class="aff-item${pendingClass}" rel="related"${pendingTitle}>` +
                 `<span class="aff-icon">&#129309;</span>` +  // 🤝 handshake
                 `<span class="aff-name">${escapeHtml(a.umbrella_name)}${pendingSuffix}</span>${labelsTxt}` +
                 `</a>`;
        }).join("")
      : "";

    // Languages
    const agentLangs: string[] = info?.agent?.languages || ["no"];
    const langMap: Record<string, string> = { no: "Norsk", en: "English", se: "Samisk", de: "Deutsch", pl: "Polski", sv: "Svenska", da: "Dansk" };
    const langsHtml = agentLangs.length > 1 || (agentLangs.length === 1 && agentLangs[0] !== "no")
      ? `<div class="lang-row">${agentLangs.map(l => `<span class="lang-tag">${escapeHtml(langMap[l] || l)}</span>`).join("")}</div>`
      : "";

    // External links (social media etc.)
    // dev-request 2026-07-03-agent-profile-conversations-stats slice 2 (work
    // item 3): route each link through GET /ut/:agentId/external:<type>
    // (contact-tracking.ts) instead of linking to l.url directly, so a click
    // is recorded server-side — same no-JS-required counting redirect as the
    // website link above. resolveRedirectUrl() looks the target up by
    // `externalLinks.find(link => link.type === type)` — i.e. the FIRST link
    // of that type — so if an agent ever has two links sharing the same
    // `type` (no DB constraint prevents it), rewriting both to the same
    // /ut/ URL would silently redirect the second one to the first one's
    // target. Guard against that by only tracking types that are unique
    // among this agent's own externalLinks; anything else falls back to the
    // untracked direct link so navigation is never wrong.
    const linksList = Array.isArray(k.externalLinks) ? k.externalLinks : [];
    const linkTypeCounts = new Map<string, number>();
    for (const l of linksList) {
      const t = typeof l?.type === "string" ? l.type.trim().toLowerCase() : "";
      if (t) linkTypeCounts.set(t, (linkTypeCounts.get(t) || 0) + 1);
    }
    const linksHtml = linksList.length
      ? linksList.map((l: any) => {
          const icon = l.type === "social" && l.label?.toLowerCase().includes("facebook") ? "&#128101;"
            : l.type === "social" && l.label?.toLowerCase().includes("instagram") ? "&#128247;"
            : l.type === "maps" ? "&#128506;"
            : l.type === "shop" ? "&#128722;"
            : "&#128279;";
          const rawType = typeof l.type === "string" ? l.type.trim().toLowerCase() : "";
          const canTrack = !!rawType && /^[a-z0-9_-]{1,40}$/.test(rawType) && linkTypeCounts.get(rawType) === 1;
          const href = canTrack
            ? `/ut/${encodeURIComponent(agent.id)}/external:${rawType}`
            : escapeHtml(l.url);
          return `<a href="${href}" class="ext-link" target="_blank" rel="noopener">${icon} ${escapeHtml(l.label || "Lenke")}</a>`;
        }).join("")
      : "";

    // Schema.org JSON-LD — Rich LocalBusiness structured data for Google Rich Results
    const jsonLd: any = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "@id": `${BASE_URL}/produsent/${slug}#business`,
      "name": agent.name,
      "description": safeDescription || safeAbout || `Lokal ${getConfig().domain_dictionary.entity} i ${cityName || "Norge"}`,
      "url": `${BASE_URL}/produsent/${slug}`,
    };

    // Address
    if (k.address) {
      jsonLd.address = {
        "@type": "PostalAddress",
        "streetAddress": k.address,
        "postalCode": k.postalCode || "",
        "addressLocality": cityName,
        "addressRegion": cityName,
        "addressCountry": "NO",
      };
    }

    // Contact
    if (isDisplayablePhone(k.phone)) jsonLd.telephone = k.phone;
    if (k.email) jsonLd.email = k.email;
    if (k.website) jsonLd.url = k.website;

    // Geo coordinates
    if (agent.location?.lat && agent.location?.lng) {
      jsonLd.geo = {
        "@type": "GeoCoordinates",
        "latitude": agent.location.lat,
        "longitude": agent.location.lng,
      };
    }

    // Images — Google requires image for LocalBusiness and merchant listings
    if (imagesList.length) {
      jsonLd.image = imagesList.length === 1 ? imagesList[0] : imagesList;
    } else {
      // Fallback: use platform logo so Google doesn't reject the listing
      jsonLd.image = `${BASE_URL}/logo.png`;
    }

    // sameAs — website + all social/external links
    const sameAsUrls: string[] = [];
    if (k.website) sameAsUrls.push(k.website);
    linksList.forEach((l: any) => { if (l.url) sameAsUrls.push(l.url); });
    if (sameAsUrls.length) jsonLd.sameAs = sameAsUrls.length === 1 ? sameAsUrls[0] : sameAsUrls;

    // Opening hours — Schema.org format
    if (hoursList.length) {
      const dayMap: Record<string, string> = {
        mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
        fri: "Friday", sat: "Saturday", sun: "Sunday",
      };
      jsonLd.openingHoursSpecification = hoursList.map((h: any) => ({
        "@type": "OpeningHoursSpecification",
        "dayOfWeek": `https://schema.org/${dayMap[h.day] || h.day}`,
        "opens": h.open,
        "closes": h.close,
      }));
    }

    // Aggregate rating from Google
    if (k.googleRating) {
      jsonLd.aggregateRating = {
        "@type": "AggregateRating",
        "ratingValue": k.googleRating,
        "bestRating": 5,
        "worstRating": 1,
        "reviewCount": k.googleReviewCount || 1,
      };
    }

    // Reviews from external sources (JSON-LD + visible HTML)
    const reviewsList = Array.isArray(k.externalReviews) ? k.externalReviews : [];
    if (reviewsList.length) {
      jsonLd.review = reviewsList.slice(0, 5).map((r: any) => ({
        "@type": "Review",
        "reviewBody": r.text || "",
        "reviewRating": r.rating ? {
          "@type": "Rating",
          "ratingValue": r.rating,
          "bestRating": 5,
        } : undefined,
        "author": { "@type": "Person", "name": r.author || "Kunde" },
        ...(r.date ? { "datePublished": r.date } : {}),
      }));
    }
    // Build visible reviews HTML
    const reviewsHtml = reviewsList.length
      ? reviewsList.slice(0, 5).map((r: any) => {
          const stars = r.rating ? "&#11088;".repeat(Math.min(Math.round(r.rating), 5)) : "";
          const author = r.author || "Kunde";
          const source = r.source ? ` — ${escapeHtml(r.source)}` : "";
          const date = r.date ? ` (${new Date(r.date).toLocaleDateString("nb-NO")})` : "";
          return `<div class="review-item">
            ${stars ? `<div class="review-stars">${stars}</div>` : ""}
            <p class="review-text">\u201c${escapeHtml(r.text || "")}\u201d</p>
            <div class="review-author">${escapeHtml(author)}${source}${date}</div>
          </div>`;
        }).join("")
      : "";

    // Products as makesOffer — Google requires price + priceCurrency in every Offer
    if (productsList.length) {
      jsonLd.makesOffer = productsList.slice(0, 20).map((p: any) => {
        const rawName = typeof p === "string" ? p : (p.name || "");
        if (!rawName) return null;

        // Parse price from name if not in price field (e.g. "Lammelår – kr 275/kg")
        let productName = rawName;
        let priceValue = typeof p === "object" ? (p.price || "") : "";

        // Extract numeric price from various formats
        if (!priceValue || !/\d/.test(priceValue)) {
          const m = rawName.match(/^(.+?)\s*[–\-—]\s*(?:kr\.?\s*)?([\d.,]+)/i)
            || rawName.match(/^(.+?)\s+kr\.?\s*([\d.,]+)/i);
          if (m) {
            productName = m[1].trim();
            priceValue = m[2].replace(",", ".").trim();
          }
        }
        // Clean price to numeric: "kr 275/kg" → "275", "kr 350" → "350"
        const numericPrice = (priceValue || "").replace(/[^0-9.,]/g, "").replace(",", ".").split("/")[0];

        // Google REQUIRES price — skip products without one (they cause validation errors)
        if (!numericPrice || isNaN(parseFloat(numericPrice))) return null;

        const product: any = {
          "@type": "Product",
          "name": productName,
          "description": `${productName} fra ${agent.name}`,
          // WO-17: brand satisfies Google's "global identifier OR brand" rule
          // for MerchantListing (fresh-farm goods rarely have GTINs).
          "brand": {
            "@type": "Brand",
            "name": agent.name,
          },
          "offers": {
            "@type": "Offer",
            "price": parseFloat(numericPrice),
            "priceCurrency": "NOK",
            "availability": "https://schema.org/InStock",
            "seller": { "@type": "LocalBusiness", "name": agent.name },
            // WO-17: 14-day Norwegian angrerett (distance-sale law default).
            "hasMerchantReturnPolicy": {
              "@type": "MerchantReturnPolicy",
              "applicableCountry": "NO",
              "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
              "merchantReturnDays": 14,
              "returnMethod": "https://schema.org/ReturnByMail",
              "returnFees": "https://schema.org/FreeReturn",
            },
            // WO-17: local-pickup is the realistic default for rettfrabonden
            // producers. Per-producer overrides are out of scope for this WO.
            "shippingDetails": {
              "@type": "OfferShippingDetails",
              "shippingRate": {
                "@type": "MonetaryAmount",
                "value": 0,
                "currency": "NOK",
              },
              "shippingDestination": {
                "@type": "DefinedRegion",
                "addressCountry": "NO",
              },
              "deliveryTime": {
                "@type": "ShippingDeliveryTime",
                "handlingTime": { "@type": "QuantitativeValue", "minValue": 0, "maxValue": 1, "unitCode": "DAY" },
                "transitTime":  { "@type": "QuantitativeValue", "minValue": 0, "maxValue": 2, "unitCode": "DAY" },
              },
            },
          },
        };

        // Add image if producer has one (Google requires image for merchant listings)
        if (imagesList.length) {
          product.image = imagesList[0];
        }

        // WO-17: propagate parent rating/review to inner Product so Google's
        // "Product snippets" report sees them on the right entity.
        if (jsonLd.aggregateRating) {
          product.aggregateRating = jsonLd.aggregateRating;
        }
        if (Array.isArray(jsonLd.review) && jsonLd.review.length) {
          product.review = jsonLd.review.slice(0, 3); // cap to keep payload small
        }

        return {
          "@type": "Offer",
          "itemOffered": product,
          "price": parseFloat(numericPrice),
          "priceCurrency": "NOK",
          "availability": "https://schema.org/InStock",
        };
      }).filter(Boolean);
    }

    // Certifications as hasCredential / keywords
    if (certs.length) {
      jsonLd.keywords = certs.join(", ");
    }

    // ─── Phase 5.11 A2: memberOf — producer ↔ umbrella crawler signal ──
    // schema.org/memberOf is the canonical primitive AI crawlers (Google,
    // Perplexity, ChatGPT, Claude) use to navigate producer → umbrella.
    // Always-array shape per schema.org — even with 1 entry, callers expect
    // memberOf as a list.
    if (affiliations.length) {
      jsonLd.memberOf = affiliations.map(a => {
        // PR-58: skip pending_confirmation + inferred — emitting an
        // unverified guess as schema.org/memberOf would mislead crawlers.
        if (a.status === "pending_confirmation" && a.source === "inferred") return null;
        return {
          "@type": "Organization",
          "@id": `${BASE_URL}/produsent/${a.umbrella_slug}#org`,
          "name": a.umbrella_name,
          "url": `${BASE_URL}/produsent/${a.umbrella_slug}`,
          ...(a.labels.length ? { "additionalType": a.labels.join(", ") } : {}),
        };
      }).filter(Boolean);
      // Hide the key entirely if every row was pending — keeps JSON-LD clean.
      if (!jsonLd.memberOf.length) delete jsonLd.memberOf;
    }

    // Payment methods
    if ((k.paymentMethods || []).length) {
      jsonLd.paymentAccepted = (k.paymentMethods as string[]).join(", ");
    }

    // Categories as additionalType
    if ((agent.categories || []).length) {
      jsonLd.additionalType = (agent.categories as string[]).map((c: string) => formatCat(c)).join(", ");
    }

    // GEO: FAQPage JSON-LD — see buildProducerFaqJsonLd for the quality gate.
    const faqJsonLd = buildProducerFaqJsonLd({
      name: agent.name,
      url: `${BASE_URL}/produsent/${slug}`,
      cityName,
      productsList,
      categories: (agent.categories as string[]) || [],
      hoursList,
      hoursText,
      website: k.website,
      address: k.address,
    });

    // GEO: answer-first SSR opening — see buildProducerAnswerFirstOpening for
    // the quality gate. Reuses the exact same real catalog fields as the FAQ
    // builder above. null (insufficient real facts) is a normal, expected
    // outcome for thin profiles — logged below (not swallowed) so a
    // regression here is visible in Fly logs, then the page render falls
    // back to the existing about/description block untouched.
    let answerFirstOpening: string | null = null;
    try {
      answerFirstOpening = buildProducerAnswerFirstOpening({
        name: agent.name,
        cityName,
        productsList,
        categories: (agent.categories as string[]) || [],
      });
      if (!answerFirstOpening) {
        console.log(`[seo] /produsent/${slug}: answer-first opening skipped (insufficient real facts) — falling back to existing description block`);
      }
    } catch (e) {
      console.error(`[seo] /produsent/${slug} answer-first opening failed:`, e);
      answerFirstOpening = null;
    }

    // A2A protocol versioning (custom extension in JSON-LD)
    const agentInfo = info?.agent as any;
    if (agentInfo?.schemaVersion || agentInfo?.agentVersion) {
      jsonLd["x-a2a"] = {
        "schemaVersion": agentInfo?.schemaVersion || "urn:a2a:1.0",
        "agentVersion": agentInfo?.agentVersion || 1,
      };
    }

    // Phase 5.4a M2 — Variant A hero claim banner for unclaimed agents.
    // Renders above the fold, server-rendered so AI bots see it (A3).
    const heroClaimHtml = !isClaimed
      ? `<div class="claim-hero">
           <div>
             <h2>${lang === "en" ? "Do you own this shop?" : "Eier denne butikken?"}</h2>
             <p>${lang === "en" ? "Take ownership of " + escapeHtml(agent.name) + " and manage your own profile." : "Ta eierskap over " + escapeHtml(agent.name) + " og styr din egen profil."}</p>
           </div>
           <a href="/selger?agent=${encodeURIComponent(agent.id)}" class="claim-hero-btn">${lang === "en" ? "Take ownership here" : "Ta eierskap her"}</a>
         </div>`
      : "";

    // ─── PR-29: related-producers (internal-link SEO boost) ───
    // Fetch up to 5 producers in the same city and up to 5 in the
    // same primary category. Both queries fail-quiet — if anything
    // goes wrong we render the page without the sections rather
    // than 500'ing on what is supplementary content.
    let relCitySection = "";
    let relCategorySection = "";
    try {
      const db = getDb();
      const primaryCategory = ((agent.categories as string[] | undefined) || [])[0] || "";
      if (cityName) {
        const cityRows = getRelatedBySameCity(db, agent.id, cityName, 5);
        const heading = lang === "en"
          ? `Other local food producers in ${cityName}`
          : `Andre lokale matprodusenter i ${cityName}`;
        relCitySection = renderRelatedSection(cityRows, heading, lang);
      }
      if (primaryCategory) {
        const catRows = getRelatedBySameCategory(db, agent.id, primaryCategory, cityName || null, 5);
        const catLabel = formatCat(primaryCategory).toLowerCase();
        const heading = lang === "en"
          ? `Other ${catLabel} producers in Norway`
          : `Andre ${catLabel}-produsenter i Norge`;
        relCategorySection = renderRelatedSection(catRows, heading, lang);
      }
    } catch (e) {
      // Non-fatal — the producer page must still render. SEO sections
      // simply won't appear, which is exactly the "hide if 0 rows" rule.
      console.error("[seo] related-producers query failed:", e);
    }

    // ─── dev-request 2026-07-03-agent-profile-conversations-stats slice 2
    // (work item 4): server-rendered "Aktivitet" panel, replacing the old
    // client-hydrated "Siste samtaler" (raw conversation quotes) block.
    // All numbers come straight from profile-activity-service.ts — see
    // that file for exactly which tables/columns back each figure and why
    // (e.g. why query-term aggregation uses conversations.query_text and
    // not analytics_queries). Fail-quiet, same pattern as every other
    // supplementary section on this page: a query error hides the section,
    // it never 500s the whole profile.
    const PLATFORM_BADGE_LABELS: Record<string, { en: string; no: string; icon: string }> = {
      web: { en: "Web", no: "Web", icon: "&#127760;" },
      chatgpt: { en: "ChatGPT", no: "ChatGPT", icon: "&#129302;" },
      claude: { en: "Claude", no: "Claude", icon: "&#129302;" },
      a2a: { en: "A2A", no: "A2A", icon: "&#128260;" },
      mcp: { en: "MCP", no: "MCP", icon: "&#128268;" },
    };
    let activityHtml = "";
    try {
      const activity = getProfileActivity(getDb(), agent.id, `/produsent/${slug}`);
      const { views30, topQueryTerms, platforms } = activity;
      const hasAnyActivity = views30.human > 0 || views30.ai > 0 || topQueryTerms.length > 0 || platforms.length > 0;

      if (hasAnyActivity) {
        const statsHtml = `<div class="act-grid">
          <div class="act-stat"><strong>${views30.human.toLocaleString(lang === "en" ? "en-GB" : "nb-NO")}</strong><small>${lang === "en" ? "Profile views · 30d" : "Profilvisninger · 30d"}</small></div>
          <div class="act-stat"><strong>${views30.ai.toLocaleString(lang === "en" ? "en-GB" : "nb-NO")}</strong><small>${lang === "en" ? "AI-agent lookups · 30d" : "AI-agent-oppslag · 30d"}</small></div>
        </div>`;

        const termsHtml = topQueryTerms.length
          ? `<div class="act-sub">${lang === "en" ? "What people search for" : "Hva folk søker etter"}</div>
             <div class="act-terms">${topQueryTerms.map(q => `<span class="act-term">${escapeHtml(q.term)}</span>`).join("")}</div>`
          : "";

        const badgesHtml = platforms.length
          ? `<div class="act-sub">${lang === "en" ? "Discovered / contacted via" : "Oppdaget / tatt kontakt via"}</div>
             <div class="act-badges">${platforms.map(p => {
               const meta = PLATFORM_BADGE_LABELS[p];
               return `<span class="act-badge">${meta.icon} ${escapeHtml(lang === "en" ? meta.en : meta.no)}</span>`;
             }).join("")}</div>`
          : "";

        activityHtml = `<div class="card">
          <div class="card-head"><span>&#128200;</span><h3>${lang === "en" ? "Activity" : "Aktivitet"}</h3></div>
          <div class="card-body">${statsHtml}${termsHtml}${badgesHtml}</div>
        </div>`;
      }
    } catch (e) {
      console.error("[seo] profile-activity query failed:", e);
    }

    const content = `
    <div class="bc"><a href="/">Hjem</a>${cityName ? `<span>/</span><a href="/${slugify(cityName)}">${escapeHtml(cityName)}</a>` : ""}<span>/</span>${escapeHtml(agent.name)}</div>

    ${heroClaimHtml}

    <div class="pf-header">
      <div class="pf-hero">
        <div class="pf-badges">${badges.join("")}</div>
        ${updatedAtDate ? `<p class="profile-meta"><time datetime="${updatedAtDate.toISOString()}" class="updated-at">Profil oppdatert: ${escapeHtml(formatUpdatedPrettyNo(updatedAtDate))}</time></p>` : ""}
        <h1 class="pf-name" translate="no">${escapeHtml(agent.name)}</h1>
        ${cityName ? `<div class="pf-loc">&#128205; ${escapeHtml(k.address || cityName)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</div>` : ""}
        ${answerFirstOpening ? `<p class="pf-answer"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(answerFirstOpening)}</p>` : ""}
        ${(() => {
          const desc = safeDescription;
          const about = safeAbout;
          if (!desc && !about) return "";
          // If only one exists, use it
          if (!desc) return `<p class="pf-desc"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(about)}</p>`;
          if (!about) return `<p class="pf-desc"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(desc)}</p>`;
          // If they're the same text, just show one
          if (desc === about || about.length < 20) return `<p class="pf-desc"${lang === "en" ? ' lang="nb"' : ""}>${escapeHtml(desc)}</p>`;
          // Both exist and differ — pick the most informative as primary,
          // show the other as supplementary if it adds unique context
          const primary = desc.length >= about.length ? desc : about;
          const secondary = desc.length >= about.length ? about : desc;
          const primaryLower = primary.toLowerCase();
          const secondaryAddsInfo = !primaryLower.includes(secondary.substring(0, Math.min(30, secondary.length)).toLowerCase());
          if (secondaryAddsInfo && secondary.length > 30) {
            return `<p class="pf-desc">${escapeHtml(primary)}</p><p class="pf-desc-extra">${escapeHtml(secondary)}</p>`;
          }
          return `<p class="pf-desc">${escapeHtml(primary)}</p>`;
        })()}
        ${lang === "en" && (safeDescription || safeAbout) ? `<div style="display:inline-block;margin-top:10px;padding:4px 10px;background:#f8f8f4;border:1px solid #e8e8e0;border-radius:6px;font-size:11px;color:#666;" title="${escapeHtml(t(lang, "common.translate_note"))}">\u{1F1F3}\u{1F1F4} ${escapeHtml(t(lang, "common.from_norwegian"))}</div>` : ""}
        <div class="pf-stats">
          <div class="pf-stat"><div class="pf-stat-icon t">&#9733;</div><div><strong>${trustPct}%</strong><small>${lang === "en" ? "Trust Score" : "Trust Score"}</small></div></div>
          ${k.googleRating ? `<div class="pf-stat"><div class="pf-stat-icon r">&#11088;</div><div><strong>${k.googleRating} / 5</strong><small>${k.googleReviewCount || 0} ${lang === "en" ? "reviews" : "anmeldelser"}</small></div></div>` : ""}
          <div class="pf-stat" data-stat="human" title="${lang === "en" ? "Page views from humans, last 90 days" : "Sidevisninger fra mennesker, siste 90 dager"}"><div class="pf-stat-icon h">&#127760;</div><div><strong data-fill="human">0</strong><small>${lang === "en" ? "Page views" : "Sidevisninger"}<br><span class="pf-stat-meta">${lang === "en" ? "humans &middot; 90d" : "mennesker &middot; 90d"}</span></small></div></div>
          <div class="pf-stat" data-stat="ai" title="${lang === "en" ? "Page views from AI agents (ChatGPT, Claude, Perplexity etc.), last 90 days" : "Sidevisninger fra AI-agenter (ChatGPT, Claude, Perplexity m.fl.), siste 90 dager"}"><div class="pf-stat-icon a">&#129302;</div><div><strong data-fill="ai">0</strong><small>${lang === "en" ? "Page views" : "Sidevisninger"}<br><span class="pf-stat-meta">${lang === "en" ? "AI agents &middot; 90d" : "AI-agenter &middot; 90d"}</span></small></div></div>
        </div>
      </div>

      <div class="ct-card">
        <h3>${lang === "en" ? "Contact information" : "Kontaktinformasjon"}</h3>
        ${contactItems.join("") || `<p style="color:var(--g500);font-size:0.88rem;">${lang === "en" ? "No contact info available yet." : "Ingen kontaktinfo tilgjengelig enn\u00e5."}</p>`}
        <div class="ct-actions">
          ${k.website ? `<a href="/ut/${encodeURIComponent(agent.id)}/website" class="btn-p" target="_blank" rel="noopener">&#127760; Bes\u00f8k nettside</a>` : ""}
          <a href="${mapsUrl}" class="btn-s" target="_blank" rel="noopener">&#128506; Vis p\u00e5 kart</a>
          <a href="${BASE_URL}/api/marketplace/agents/${agent.id}/vcard" class="btn-s">&#128195; Last ned kontaktkort</a>
        </div>
      </div>
    </div>

    <div class="pf-content">
      <div class="pf-main">
        <!-- dev-request 2026-07-03-agent-profile-conversations-stats slice 2:
             server-rendered "Aktivitet" panel (aggregated, non-fabricated
             numbers) — replaces the old client-hydrated raw-conversation
             list. Sits between Trust score and Produkter per Daniels brief,
             same slot the old block occupied. -->
        ${activityHtml}

        ${imagesHtml ? `
        <div class="card">
          <div class="card-head"><span>&#128247;</span><h3>Bilder</h3></div>
          <div class="card-body"><div class="img-grid">${imagesHtml}</div></div>
        </div>` : ""}

        ${productsHtml ? `
        <div class="card">
          <div class="card-head"><span>&#127813;</span><h3>Produkter (${productsList.length})</h3></div>
          <div class="card-body"><div class="prod-grid">${productsHtml}</div></div>
        </div>` : ""}

        ${affiliationsHtml ? `
        <div class="card">
          <div class="card-head"><span>&#129309;</span><h3>Tilknytninger</h3></div>
          <div class="card-body"><div class="aff-grid">${affiliationsHtml}</div></div>
        </div>` : ""}

        ${seasonHtml ? `
        <div class="card">
          <div class="card-head"><span>&#127793;</span><h3>Sesongkalender</h3></div>
          <div class="card-body"><div class="season-grid">${seasonHtml}</div></div>
        </div>` : ""}

        ${hoursHtml ? `
        <div class="card">
          <div class="card-head"><span>&#128339;</span><h3>\u00c5pningstider</h3></div>
          <div class="card-body"><div class="hrs-grid">${hoursHtml}</div></div>
        </div>` : ""}

        ${deliveryHtml ? `
        <div class="card">
          <div class="card-head"><span>&#128666;</span><h3>Levering og betaling</h3></div>
          <div class="card-body"><div class="del-grid">${deliveryHtml}</div></div>
        </div>` : ""}

        ${certsHtml ? `
        <div class="card">
          <div class="card-head"><span>&#127942;</span><h3>${lang === "en" ? "Certifications" : "Sertifiseringer"}</h3></div>
          <div class="card-body"><div class="certs-row">${certsHtml}</div></div>
        </div>` : ""}

        ${linksHtml ? `
        <div class="card">
          <div class="card-head"><span>&#128279;</span><h3>Finn oss</h3></div>
          <div class="card-body"><div class="ext-links">${linksHtml}</div></div>
        </div>` : ""}

        ${langsHtml ? `
        <div class="card">
          <div class="card-head"><span>&#127760;</span><h3>Spr\u00e5k</h3></div>
          <div class="card-body">${langsHtml}</div>
        </div>` : ""}

        ${reviewsHtml ? `
        <div class="card">
          <div class="card-head"><span>&#128172;</span><h3>${lang === "en" ? "Customer reviews" : "Kundeanmeldelser"}</h3></div>
          <div class="card-body"><div class="reviews-grid">${reviewsHtml}</div></div>
        </div>` : ""}

        ${isClaimed ? `<div class="claim-bar" style="padding:16px 20px;font-size:0.95rem;">
          <div>
            <h3 style="font-size:0.95rem;">${lang === "en" ? "Are you also an owner?" : "Er du ogs\u00e5 eier?"}</h3>
            <p style="font-size:0.8rem;">${lang === "en" ? "Request access to manage this profile." : "Be om tilgang til \u00e5 administrere denne profilen."}</p>
          </div>
          <a href="/selger?agent=${encodeURIComponent(agent.id)}" class="claim-btn" style="font-size:0.8rem;padding:8px 16px;">${lang === "en" ? "Request access here" : "Be om tilgang her"}</a>
        </div>` : ""}

        <div class="data-src">
          <span class="data-dot ${(!k.dataSource || k.dataSource === "auto") ? "auto" : "owner"}"></span>
          ${lang === "en"
            ? ((!k.dataSource || k.dataSource === "auto") ? "Auto-collected data" : k.dataSource === "hybrid" ? "Verified by owner" : "Owner-managed")
            : ((!k.dataSource || k.dataSource === "auto") ? "Automatisk innhentet data" : k.dataSource === "hybrid" ? "Verifisert av eier" : "Eierstyrt")
          }${k.lastEnrichedAt ? ` \u2014 ${lang === "en" ? "Last updated" : "Sist oppdatert"} ${new Date(k.lastEnrichedAt).toLocaleDateString(lang === "en" ? "en-US" : "nb-NO")}` : ""}
        </div>

        ${meta.disclaimer ? `<p style="margin-top:8px;font-size:0.75rem;color:var(--g500);">${escapeHtml(meta.disclaimer)}</p>` : ""}
      </div>

      <div>
        ${related.length > 0 ? `
        <div class="card">
          <div class="card-head"><span>&#127793;</span><h3>${lang === "en" ? `Others in <span translate="no">${escapeHtml(cityName)}</span>` : `Andre i <span translate="no">${escapeHtml(cityName)}</span>`}</h3></div>
          <div class="card-body"><div class="rel-grid">${relatedHtml}</div></div>
        </div>` : ""}
      </div>
    </div>

    <!-- PR-29 anchor: related-producers sections (above the closing
         scripts; PR-30 freshness work targets head/body areas elsewhere). -->
    ${relCitySection}
    ${relCategorySection}

    <script>
      // Per-agent stats hydration. Server keeps the page cacheable; this
      // small fetch personalises the visibility tiles client-side.
      // Fail-quiet: if the API errors or returns 0, the placeholders stay
      // hidden (display:none in PROFILE_CSS).
      //
      // dev-request 2026-07-03-agent-profile-conversations-stats slice 2
      // (work item 3): also attaches a single delegated click listener that
      // fires the contact-click beacon (POST /api/track/contact-click,
      // src/routes/contact-tracking.ts, already merged in PR-128) for
      // mailto:/tel: links. Delegated + addEventListener only — this
      // platform's CSP/SES setup forbids inline onclick= handlers. Never
      // calls preventDefault(), so the mailto:/tel: navigation always
      // proceeds identically whether the beacon succeeds, fails, or
      // (JS-disabled) never runs at all.
      (function () {
        var agentId = ${JSON.stringify(agent.id)};
        var url = "/api/agents/" + encodeURIComponent(agentId) + "/stats";
        fetch(url, { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (s) {
            if (!s) return;
            var fmt = function (n) { return (n || 0).toLocaleString(${JSON.stringify(lang === "en" ? "en-GB" : "nb-NO")}); };
            if (s.humanViews > 0) {
              var h = document.querySelector('[data-stat="human"]');
              if (h) { h.querySelector('[data-fill="human"]').textContent = fmt(s.humanViews); h.style.display = "flex"; }
            }
            if (s.aiViews > 0) {
              var a = document.querySelector('[data-stat="ai"]');
              if (a) {
                a.querySelector('[data-fill="ai"]').textContent = fmt(s.aiViews);
                a.style.display = "flex";
                var b = s.aiBreakdown || {};
                var parts = [];
                if (b.chatgpt) parts.push("ChatGPT " + b.chatgpt);
                if (b.claude) parts.push("Claude " + b.claude);
                if (b.other) parts.push(${JSON.stringify(lang === "en" ? "Other" : "Annet")} + " " + b.other);
                if (parts.length) a.setAttribute("title", parts.join(" · "));
              }
            }
          })
          .catch(function () { /* fail-quiet — no UI on error */ });

        document.addEventListener("click", function (e) {
          var link = e.target && e.target.closest ? e.target.closest("a[data-track-kind]") : null;
          if (!link) return;
          var kind = link.getAttribute("data-track-kind");
          if (!kind) return;
          try {
            var payload = JSON.stringify({ agentId: agentId, kind: kind });
            if (navigator.sendBeacon) {
              navigator.sendBeacon("/api/track/contact-click", new Blob([payload], { type: "application/json" }));
            } else {
              fetch("/api/track/contact-click", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(function () {});
            }
          } catch (_) { /* never block mailto:/tel: navigation on a tracking failure */ }
        });
      })();
    </script>`;

    res.send(shell(
      `${agent.name}${cityName ? t(lang, "producer.title_suffix", { city: cityName }) : ""}${titleFreshnessSuffix(updatedAtDate)}`,
      `${agent.name}${cityName ? ` ${lang === "en" ? "in" : "i"} ${cityName}` : ""}. ${safeMetaDescription(safeDescription) || (lang === "en" ? "Local food in Norway." : "Lokalprodusert mat i Norge.")}`,
      content,
      { canonical: `${BASE_URL}${localizedPath("/produsent/" + slug, lang)}`, jsonLd: faqJsonLd ? [jsonLd, faqJsonLd] : jsonLd, extraCss: PROFILE_CSS + RELATED_PRODUCERS_CSS, lang, pathForAlternate: "/produsent/" + slug }
    ));
  } catch (err) {
    console.error(`SEO /produsent/${slug} error:`, err);
    res.status(500).send(lang === "en" ? "Internal error" : "Intern feil");
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /sitemap.xml
// ═══════════════════════════════════════════════════════════════

router.get("/sitemap.xml", (_req: Request, res: Response) => {
  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const today = new Date().toISOString().split("T")[0];
    const cities = new Set<string>();
    agents.forEach((a: any) => {
      const city = a.city || a.location?.city;
      if (city) cities.add(slugify(city));
    });

    // ── PR-30: per-agent freshness + enrichment-status hints ──────────
    // One-shot batch query so we don't N+1 the DB. We map agent_id ->
    // { updated_at, enrichment_status }; missing rows fall back to today's
    // date + thin status defaults.
    const knowledgeByAgent = new Map<string, { updatedAt: string | null; status: string | null }>();
    try {
      const rows = getDb()
        .prepare("SELECT agent_id, updated_at, created_at, enrichment_status FROM agent_knowledge")
        .all() as Array<{ agent_id: string; updated_at?: string; created_at?: string; enrichment_status?: string }>;
      for (const r of rows) {
        knowledgeByAgent.set(r.agent_id, {
          updatedAt: r.updated_at || r.created_at || null,
          status: r.enrichment_status || null,
        });
      }
    } catch (e) {
      console.error("[sitemap] knowledge query failed:", e);
    }

    // Build sitemap with NO + EN URLs and xhtml:link hreflang per Google guidelines.
    // https://developers.google.com/search/docs/specialized/international/localized-versions
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`;

    const corePaths = ["/", "/om", "/teknologi", "/guide-mat-ai", "/personvern"];
    const corePriorities: Record<string, string> = { "/": "1.0", "/om": "0.7", "/teknologi": "0.7", "/guide-mat-ai": "0.6", "/personvern": "0.5" };
    const coreFreq: Record<string, string> = { "/": "daily" };

    function addEntry(path: string, freq: string, priority: string, lastmod: string) {
      const noLoc = `${BASE_URL}${path === "/" ? "" : path}`;
      const enLoc = `${BASE_URL}/en${path === "/" ? "" : path}`;
      xml += `\n  <url>\n    <loc>${noLoc}</loc>\n    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>\n    <lastmod>${lastmod}</lastmod>\n    <xhtml:link rel="alternate" hreflang="nb" href="${noLoc}"/>\n    <xhtml:link rel="alternate" hreflang="en" href="${enLoc}"/>\n    <xhtml:link rel="alternate" hreflang="x-default" href="${noLoc}"/>\n  </url>`;
      xml += `\n  <url>\n    <loc>${enLoc}</loc>\n    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>\n    <lastmod>${lastmod}</lastmod>\n    <xhtml:link rel="alternate" hreflang="nb" href="${noLoc}"/>\n    <xhtml:link rel="alternate" hreflang="en" href="${enLoc}"/>\n    <xhtml:link rel="alternate" hreflang="x-default" href="${noLoc}"/>\n  </url>`;
    }

    for (const p of corePaths) addEntry(p, coreFreq[p] || "monthly", corePriorities[p]!, today);
    for (const city of cities) addEntry(`/${city}`, "weekly", "0.8", today);

    // PR-30: producer URLs get per-agent <lastmod> + status-driven priority/changefreq
    // WO-17: pre-flight gate filters agents that would 404 in the route handler
    // (short/empty slugs, skeleton imports with no knowledge row and no claim).
    // Symptom of the 2026-05-14 Search Console "sitemap-listed URLs returning
    // 404" report.
    let skippedCount = 0;
    for (const a of agents) {
      const slug = slugify(a.name);
      if (!slug || slug.length < 2) { skippedCount++; continue; }
      const k = knowledgeByAgent.get(a.id);
      // RegisteredAgent type doesn't surface claimed_by_user_id, but the
      // underlying agents row does — narrow-cast to read it without polluting
      // the public type.
      const claimedBy = (a as any).claimed_by_user_id ?? (a as any).claimed_by;
      if (!k && !claimedBy) { skippedCount++; continue; }
      const updatedAt = parseIsoOrSqlite(k?.updatedAt);
      const lastmod = updatedAt ? lastmodForDate(updatedAt) : today;
      const hints = sitemapHintsForStatus(k?.status);
      addEntry(`/produsent/${slug}`, hints.changefreq, hints.priority, lastmod);
    }
    console.log(`[sitemap] producer-entry filtering: ${skippedCount}/${agents.length} excluded by WO-17 gate`);

    xml += "\n</urlset>";
    res.header("Content-Type", "application/xml");
    res.send(xml);
  } catch (err) {
    console.error("Sitemap error:", err);
    res.status(500).send("Error generating sitemap");
  }
});

// ─── GET /<INDEXNOW_KEY>.txt — IndexNow key file ─────────────
// dev-request 2026-07-04-sokemotor-indeksering-og-lenker slice 1.
// Literal path (not a :param wildcard) so any other *.txt request
// (llms.txt, llms-full.txt, a future unrelated .txt route) simply
// doesn't match this route and falls through unaffected — no explicit
// next()-passthrough logic needed. Still added to the /:city catch-all's
// reserved-slug list below out of caution.
router.get(`/${INDEXNOW_KEY}.txt`, (_req: Request, res: Response) => {
  res.header("Content-Type", "text/plain; charset=utf-8");
  res.send(INDEXNOW_KEY);
});

// ─── GET /robots.txt ────────────────────────────────────────

router.get("/robots.txt", (_req: Request, res: Response) => {
  res.header("Content-Type", "text/plain; charset=utf-8");
  // Explicit AI bot allow-list + Content Signals (Cloudflare spec).
  // We WANT AI agents to discover, search, and cite our data — that is the
  // entire point of an A2A marketplace. We do NOT want our content used
  // for training large language models without compensation, so ai-train=no.
  res.send(`# Lokal / rettfrabonden.com — robots.txt
# A2A marketplace for local food in Norway.
# AI agents are explicitly welcome to discover, read, and cite our data.

User-agent: *
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

# ─── AI / agent crawlers (explicit allow) ───────────────────
User-agent: GPTBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: OAI-SearchBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: ChatGPT-User
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: ClaudeBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Claude-Web
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Claude-SearchBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: anthropic-ai
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: PerplexityBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Perplexity-User
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Google-Extended
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Applebot
Allow: /

User-agent: Applebot-Extended
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Amazonbot
Allow: /

User-agent: Bytespider
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: CCBot
Disallow: /

User-agent: FacebookBot
Allow: /

User-agent: meta-externalagent
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: Diffbot
Allow: /

User-agent: cohere-ai
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: NotHumanSearch
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: DuckDuckBot
Allow: /

User-agent: Omgilibot
Disallow: /

Sitemap: ${BASE_URL}/sitemap.xml

# ─── AI discovery endpoints ──────────────────────────────────
# LLM-friendly overview:    ${BASE_URL}/llms.txt
# Full producer data:       ${BASE_URL}/llms-full.txt
# A2A Agent Card:           ${BASE_URL}/.well-known/agent-card.json
# MCP Server Card:          ${BASE_URL}/.well-known/mcp/server-card.json
# MCP Manifest:             ${BASE_URL}/.well-known/mcp
# Agent Discovery:          ${BASE_URL}/.well-known/agents.txt
# OpenAPI Spec:             ${BASE_URL}/openapi.json
`);
});

// ─── /kontakt — public contact form (RFB / rettfrabonden.com) ───

router.get("/kontakt", (req: Request, res: Response) => {
  const lang = req.lang;
  const en = lang === "en";
  const brand = getConfig().display_name;
  const title = en ? `Contact us — ${brand}` : `Kontakt oss — ${brand}`;
  const desc = en
    ? `Get in touch with the ${brand} team. We typically reply within a business day.`
    : "Ta kontakt med oss. Vi svarer normalt innen én virkedag.";

  const content = `
<section class="om-hero">
  <h1>${en ? "Contact us" : "Kontakt oss"}</h1>
  <p>${en ? `Questions, feedback or partnership inquiries — we&apos;d love to hear from you.` : "Spørsmål, tilbakemeldinger eller henvendelser om samarbeid — vi hører gjerne fra deg."}</p>
</section>

<section class="om-sec" style="max-width:640px;margin:0 auto;padding:32px 24px 64px">
  <form id="contact-form" novalidate>
    <input type="text" name="_honey" value="" style="display:none;position:absolute;left:-9999px" tabindex="-1" autocomplete="off" aria-hidden="true">
    <input type="hidden" name="platform" value="rfb">

    <div style="margin-bottom:20px">
      <label for="cf-name" style="display:block;font-weight:600;margin-bottom:6px">${en ? "Name" : "Navn"} *</label>
      <input type="text" id="cf-name" name="name" required maxlength="100" autocomplete="name" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box">
    </div>

    <div style="margin-bottom:20px">
      <label for="cf-email" style="display:block;font-weight:600;margin-bottom:6px">E-post *</label>
      <input type="email" id="cf-email" name="email" required maxlength="254" autocomplete="email" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box">
    </div>

    <div style="margin-bottom:20px">
      <label for="cf-subject" style="display:block;font-weight:600;margin-bottom:6px">${en ? "Subject" : "Emne"}</label>
      <input type="text" id="cf-subject" name="subject" maxlength="200" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box">
    </div>

    <div style="margin-bottom:20px">
      <label for="cf-message" style="display:block;font-weight:600;margin-bottom:6px">${en ? "Message" : "Melding"} *</label>
      <textarea id="cf-message" name="message" required maxlength="2000" rows="5" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;resize:vertical"></textarea>
    </div>

    <p style="font-size:.82rem;color:#6b7280;margin-bottom:20px">${en ? "Your message is stored for handling your enquiry and is read only by us." : "Meldingen lagres for behandling av forespørselen din. Leses kun av oss."}</p>

    <div class="cf-turnstile" data-sitekey="0x4AAAAAADr56qDaUM0XWoTF" data-theme="light" style="margin-bottom:20px"></div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

    <button type="submit" style="background:var(--green-700,#15803d);color:#fff;padding:12px 28px;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px">${en ? "Send message" : "Send melding"}</button>
  </form>
</section>

<script>
(function(){
  var form = document.getElementById('contact-form');
  if(!form) return;
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = '${en ? "Sending…" : "Sender…"}';
    var data = Object.fromEntries(new FormData(form));
    var token = (document.querySelector('[name=cf-turnstile-response]') || {}).value || '';
    try {
      var res = await fetch('/api/contact', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(Object.assign({}, data, {cfTurnstileResponse: token}))
      });
      var json = await res.json();
      if(json.success){
        form.innerHTML = '<p style="color:var(--green-700,#15803d);font-size:1.1rem;font-weight:600;padding:24px 0">&#10003; ${en ? "Thank you! We&apos;ll reply as soon as possible." : "Takk! Vi svarer så snart vi kan."}</p>';
      } else {
        btn.disabled = false;
        btn.textContent = '${en ? "Send message" : "Send melding"}';
        alert('${en ? "Something went wrong. Please try again." : "Noe gikk galt. Prøv igjen."}');
      }
    } catch(err) {
      btn.disabled = false;
      btn.textContent = '${en ? "Send message" : "Send melding"}';
      alert('${en ? "Something went wrong. Please try again." : "Noe gikk galt. Prøv igjen."}');
    }
  });
})();
</script>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    shell(title, desc, content, {
      canonical: `${BASE_URL}/kontakt`,
      pathForAlternate: "/kontakt",
      lang,
    }),
  );
});

export default router;

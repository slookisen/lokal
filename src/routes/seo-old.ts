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
 *   GET /sitemap.xml          → Dynamic sitemap for Google
 *   GET /robots.txt           → Crawl instructions
 */

import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { knowledgeService } from "../services/knowledge-service";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────

function slugify(text: string): string {
  return text.normalize("NFC").toLowerCase()
    .replace(/\u00e6/g, "ae").replace(/\u00f8/g, "o").replace(/\u00e5/g, "a")
    .replace(/\u00e4/g, "a").replace(/\u00f6/g, "o").replace(/\u00fc/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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

function formatCat(cat: string): string {
  return CATEGORY_MAP[cat]?.name || cat;
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

function shell(title: string, description: string, content: string, extra?: { canonical?: string; jsonLd?: object | object[]; extraCss?: string }): string {
  const canonicalUrl = extra?.canonical || BASE_URL;
  const jsonLdScript = extra?.jsonLd
    ? (Array.isArray(extra.jsonLd)
        ? extra.jsonLd.map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")
        : `<script type="application/ld+json">${JSON.stringify(extra.jsonLd)}</script>`)
    : "";

  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="nb_NO">
  ${jsonLdScript}
  ${CSS}
  ${extra?.extraCss ? `<style>${extra.extraCss}</style>` : ""}
</head>
<body>
  <nav class="nav">
    <a href="/" class="nav-logo"><div class="nav-icon">&#127793;</div> Rett fra Bonden</a>
    <div class="nav-links">
      <a href="/oslo">Oslo</a>
      <a href="/bergen">Bergen</a>
      <a href="/trondheim">Trondheim</a>
      <a href="/stavanger">Stavanger</a>
      <a href="/selger" class="nav-cta">For produsenter</a>
    </div>
  </nav>
  ${content}
  <footer class="ft">
    <div class="ft-inner">
      <div>
        <div class="ft-brand">Rett fra Bonden</div>
        <div class="ft-desc">Norges st\u00f8rste katalog for lokal mat. Vi kobler matprodusenter med kunder \u2014 direkte, uten mellomledd.</div>
      </div>
      <div class="ft-col">
        <h4>Utforsk</h4>
        <a href="/oslo">Oslo</a><a href="/bergen">Bergen</a><a href="/trondheim">Trondheim</a><a href="/stavanger">Stavanger</a>
      </div>
      <div class="ft-col">
        <h4>For produsenter</h4>
        <a href="/selger">Registrer deg</a><a href="/selger">Logg inn</a><a href="/api/marketplace/search?q=mat">API</a>
      </div>
      <div class="ft-col">
        <h4>Om oss</h4>
        <a href="/om">V\u00e5r historie</a><a href="/teknologi">Hvordan det fungerer</a><a href="https://github.com/slookisen/lokal">GitHub</a>
      </div>
    </div>
    <div class="ft-bottom">Rett fra Bonden &copy; ${new Date().getFullYear()}. Gj\u00f8r matprodusenter synlige i hele Norge.</div>
  </footer>
</body>
</html>`;
}

// ─── Producer card HTML (reused across pages) ───────────────

function producerCard(a: any): string {
  const city = a.city || a.location?.city || "";
  const slug = slugify(a.name);
  const cats = (a.categories || []).slice(0, 3).map((c: string) => `<span class="tag">${catEmoji(c)} ${escapeHtml(formatCat(c))}</span>`).join("");
  const trustPct = Math.round((a.trustScore || 0) * 100);
  const desc = a.description || "";
  const verified = a.isVerified ? `<span class="badge badge-v">&#10003; Verifisert</span>` : "";

  return `<a href="/produsent/${slug}" class="pc">
    <div class="pc-top">
      <div>
        <div class="pc-name">${escapeHtml(a.name)}</div>
        <div class="pc-city">${escapeHtml(city)}</div>
      </div>
      ${verified}
    </div>
    ${desc ? `<div class="pc-desc">${escapeHtml(desc)}</div>` : ""}
    <div class="pc-tags">${cats}</div>
    <div class="pc-foot">
      <div class="trust-m"><div class="trust-bar"><div class="trust-fill" style="width:${trustPct}%"></div></div> ${trustPct}%</div>
      <span class="pc-link">Se profil &rarr;</span>
    </div>
  </a>`;
}

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
  .how-sec { background: var(--green-50); }
  .how-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; max-width: 850px; margin: 0 auto; }
  .how-step { text-align: center; }
  .how-num { width: 44px; height: 44px; border-radius: 50%; background: var(--green-700); color: var(--white); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1rem; margin: 0 auto 14px; }
  .how-step h3 { font-size: 1rem; font-weight: 700; margin-bottom: 6px; }
  .how-step p { font-size: 0.85rem; color: var(--g500); line-height: 1.5; }
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
  }
`;

router.get("/", (_req: Request, res: Response) => {
  try {
    const stats = marketplaceRegistry.getStats();
    const agents = marketplaceRegistry.getActiveAgents();
    const totalAgents = stats.totalAgents || agents.length;

    // City counts
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
    const cityIcons = ["&#127968;", "&#127963;", "&#9875;", "&#127750;", "&#127748;", "&#9981;", "&#9973;", "&#127793;"];

    // Featured producers (highest trust, verified first)
    const featured = agents
      .filter((a: any) => a.trustScore >= 0.7)
      .sort((a: any, b: any) => {
        if (a.isVerified && !b.isVerified) return -1;
        if (!a.isVerified && b.isVerified) return 1;
        return (b.trustScore || 0) - (a.trustScore || 0);
      })
      .slice(0, 6);

    // Category cards
    const catCards = Object.entries(CATEGORY_MAP)
      .map(([key, val]) => {
        const count = categoryCounts[key] || 0;
        return `<a href="/sok?q=${encodeURIComponent(val.name.toLowerCase())}" class="cat-card">
          <span class="cat-emoji">${val.emoji}</span>
          <div class="cat-name">${val.name}</div>
          <div class="cat-count">${count} produsenter</div>
        </a>`;
      }).join("");

    const cityCards = topCities.map(([city, count], i) =>
      `<a href="/${slugify(city)}" class="city-card">
        <div class="city-icon">${cityIcons[i] || "&#127793;"}</div>
        <div><div class="city-name">${escapeHtml
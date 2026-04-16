/**
 * SEO Frontend Routes — Server-rendered HTML pages for Google indexing
 *
 * These pages exist to compete with Google Places by BEING in Google.
 * Every page includes Schema.org LocalBusiness markup for rich results.
 *
 * Routes:
 *   GET /                     -> Landing page with search + popular cities
 *   GET /:city                -> City page with all producers in that city
 *   GET /produsent/:slug      -> Individual producer page with full details
 *   GET /sitemap.xml          -> Dynamic sitemap for Google
 *   GET /robots.txt           -> Crawl instructions
 */

import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { knowledgeService } from "../services/knowledge-service";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────

function slugify(text: string): string {
  return text.normalize("NFC").toLowerCase()
    .replace(/\u00e6/g, "ae")   // ae
    .replace(/\u00f8/g, "o")    // o
    .replace(/\u00e5/g, "a")    // a
    .replace(/\u00e4/g, "a")    // a
    .replace(/\u00f6/g, "o")    // o
    .replace(/\u00fc/g, "u")    // u
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

// Norwegian city coordinates for geo meta tags
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

const CATEGORY_MAP: Record<string, { emoji: string; label: string }> = {
  vegetables: { emoji: "\uD83E\uDD66", label: "Gronnsaker" },
  fruit: { emoji: "\uD83C\uDF4E", label: "Frukt" },
  dairy: { emoji: "\uD83E\uDDC0", label: "Meieri" },
  meat: { emoji: "\uD83E\uDD69", label: "Kjott" },
  fish: { emoji: "\uD83D\uDC1F", label: "Fisk" },
  bread: { emoji: "\uD83C\uDF5E", label: "Bakst" },
  honey: { emoji: "\uD83C\uDF6F", label: "Honning" },
  eggs: { emoji: "\uD83E\uDD5A", label: "Egg" },
  herbs: { emoji: "\uD83C\uDF3F", label: "Urter" },
  berries: { emoji: "\uD83C\uDF53", label: "Baer" },
};

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Des"];

// ─── CSS Design System ──────────────────────────────────────

const CSS = `
:root {
  --green-900: #1a3d0a;
  --green-700: #2D5016;
  --green-500: #4a7c23;
  --green-100: #e8f5e0;
  --green-50: #f0f7ed;
  --g900: #111827;
  --g700: #374151;
  --g500: #6b7280;
  --g300: #d1d5db;
  --g100: #f3f4f6;
  --charcoal: #1a1a1a;
  --orange: #D4A373;
  --white: #ffffff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: var(--charcoal); background: var(--white); }
a { color: var(--green-700); text-decoration: none; }
a:hover { text-decoration: underline; }
.container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

/* ── Nav ── */
nav.top-nav { position: sticky; top: 0; z-index: 100; background: rgba(255,255,255,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--g100); padding: 0 24px; }
nav.top-nav .nav-inner { max-width: 1100px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; height: 64px; }
nav.top-nav .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 1.15rem; color: var(--green-700); }
nav.top-nav .logo svg { width: 28px; height: 28px; }
nav.top-nav .nav-links { display: flex; align-items: center; gap: 24px; font-size: 0.92rem; }
nav.top-nav .nav-links a { color: var(--g700); font-weight: 500; }
nav.top-nav .nav-links a:hover { color: var(--green-700); text-decoration: none; }
nav.top-nav .cta-link { background: var(--green-100); color: var(--green-700) !important; padding: 6px 16px; border-radius: 8px; font-weight: 600; }

/* ── Hero ── */
.hero { background: linear-gradient(180deg, var(--white) 0%, var(--green-50) 100%); padding: 64px 0 56px; text-align: center; }
.hero .pill { display: inline-flex; align-items: center; gap: 8px; background: var(--green-100); color: var(--green-700); padding: 6px 18px; border-radius: 100px; font-size: 0.85rem; font-weight: 600; margin-bottom: 20px; }
.hero .pill .dot { width: 8px; height: 8px; background: var(--green-500); border-radius: 50%; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.hero h1 { font-size: 2.8rem; font-weight: 800; line-height: 1.15; color: var(--charcoal); margin-bottom: 16px; }
.hero h1 .hl { color: var(--green-700); }
.hero .subtitle { font-size: 1.15rem; color: var(--g500); max-width: 520px; margin: 0 auto 32px; }
.search-form { display: flex; max-width: 560px; margin: 0 auto 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); border-radius: 16px; overflow: hidden; }
.search-form input { flex: 1; padding: 16px 20px; font-size: 1rem; border: 2px solid var(--g100); border-right: none; border-radius: 16px 0 0 16px; outline: none; transition: border-color 0.2s; }
.search-form input:focus { border-color: var(--green-500); }
.search-form button { padding: 16px 32px; background: var(--green-700); color: var(--white); border: none; border-radius: 0 16px 16px 0; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
.search-form button:hover { background: var(--green-900); }
.chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-bottom: 32px; }
.chips a { background: var(--white); border: 1px solid var(--g300); padding: 6px 16px; border-radius: 100px; font-size: 0.85rem; color: var(--g700); transition: all 0.2s; }
.chips a:hover { border-color: var(--green-500); color: var(--green-700); background: var(--green-50); text-decoration: none; }
.stats-bar { display: flex; justify-content: center; gap: 48px; padding-top: 8px; }
.stats-bar .stat { text-align: center; }
.stats-bar .stat-num { font-size: 1.5rem; font-weight: 800; color: var(--green-700); }
.stats-bar .stat-label { font-size: 0.8rem; color: var(--g500); text-transform: uppercase; letter-spacing: 0.5px; }

/* ── Sections ── */
.section { padding: 56px 0; }
.section-gray { background: var(--g100); }
.section-title { font-size: 1.6rem; font-weight: 700; color: var(--charcoal); margin-bottom: 8px; }
.section-sub { color: var(--g500); margin-bottom: 32px; }

/* ── Category grid ── */
.cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.cat-card { background: var(--white); border-radius: 16px; padding: 20px 12px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.06); transition: box-shadow 0.2s, transform 0.2s; }
.cat-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.1); transform: translateY(-2px); text-decoration: none; }
.cat-card .emoji { font-size: 2rem; margin-bottom: 6px; }
.cat-card .cat-name { font-weight: 600; color: var(--charcoal); font-size: 0.9rem; }
.cat-card .cat-count { font-size: 0.78rem; color: var(--g500); }

/* ── City grid ── */
.city-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
.city-card { background: var(--white); border-radius: 16px; padding: 24px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); transition: box-shadow 0.2s, transform 0.2s; display: flex; align-items: center; gap: 14px; }
.city-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.1); transform: translateY(-2px); text-decoration: none; }
.city-card .city-icon { width: 40px; height: 40px; background: var(--green-50); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; }
.city-card .city-name { font-weight: 600; color: var(--charcoal); }
.city-card .city-count { font-size: 0.82rem; color: var(--g500); }

/* ── Producer cards ── */
.prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
.prod-card { background: var(--white); border-radius: 16px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); transition: box-shadow 0.2s; display: flex; flex-direction: column; }
.prod-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.1); }
.prod-card h3 { font-size: 1.1rem; margin-bottom: 4px; }
.prod-card h3 a { color: var(--charcoal); }
.prod-card h3 a:hover { color: var(--green-700); }
.prod-card .prod-loc { font-size: 0.85rem; color: var(--g500); margin-bottom: 8px; }
.prod-card .prod-desc { color: var(--g700); font-size: 0.92rem; margin-bottom: 12px; flex: 1; }
.prod-card .prod-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.tag { display: inline-block; background: var(--green-100); color: var(--green-700); padding: 3px 12px; border-radius: 100px; font-size: 0.78rem; font-weight: 500; }
.prod-card .trust-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.trust-bar { flex: 1; height: 6px; background: var(--g100); border-radius: 3px; overflow: hidden; max-width: 120px; }
.trust-fill { height: 100%; background: var(--green-500); border-radius: 3px; }
.trust-label { font-size: 0.78rem; color: var(--g500); }
.prod-card .prod-link { font-size: 0.88rem; font-weight: 600; color: var(--green-700); }

/* ── How it works ── */
.steps-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; }
.step-card { text-align: center; padding: 32px 20px; }
.step-num { width: 48px; height: 48px; background: var(--green-100); color: var(--green-700); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 1.2rem; font-weight: 700; margin-bottom: 16px; }
.step-card h3 { font-size: 1.05rem; margin-bottom: 8px; }
.step-card p { font-size: 0.9rem; color: var(--g500); }

/* ── CTA banner ── */
.cta-banner { background: linear-gradient(135deg, var(--green-700) 0%, var(--green-900) 100%); color: var(--white); border-radius: 24px; padding: 48px 40px; text-align: center; margin: 0 auto; max-width: 900px; }
.cta-banner h2 { font-size: 1.8rem; margin-bottom: 12px; }
.cta-banner p { opacity: 0.85; margin-bottom: 24px; max-width: 500px; margin-left: auto; margin-right: auto; }
.cta-banner .btn-white { display: inline-block; background: var(--white); color: var(--green-700); padding: 14px 32px; border-radius: 12px; font-weight: 700; font-size: 1rem; transition: transform 0.2s; }
.cta-banner .btn-white:hover { transform: translateY(-1px); text-decoration: none; }

/* ── AI banner ── */
.ai-banner { background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%); color: var(--white); border-radius: 24px; padding: 40px; text-align: center; margin: 0 auto; max-width: 900px; }
.ai-banner h3 { font-size: 1.3rem; margin-bottom: 8px; }
.ai-banner p { opacity: 0.85; margin-bottom: 20px; }
.ai-logos { display: flex; justify-content: center; gap: 32px; flex-wrap: wrap; }
.ai-logos span { background: rgba(255,255,255,0.15); padding: 8px 20px; border-radius: 10px; font-weight: 600; font-size: 0.88rem; }

/* ── Footer ── */
footer { background: var(--charcoal); color: #aaa; padding: 56px 0 32px; margin-top: 64px; }
.footer-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 40px; margin-bottom: 40px; }
.footer-brand .footer-logo { font-size: 1.1rem; font-weight: 700; color: var(--white); margin-bottom: 8px; }
.footer-brand p { font-size: 0.85rem; line-height: 1.6; }
footer h4 { color: var(--white); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
footer ul { list-style: none; }
footer ul li { margin-bottom: 8px; }
footer ul a { color: #aaa; font-size: 0.88rem; }
footer ul a:hover { color: var(--white); }
.footer-bottom { border-top: 1px solid #333; padding-top: 24px; font-size: 0.8rem; text-align: center; }

/* ── Breadcrumb ── */
.breadcrumb { padding: 16px 0; font-size: 0.85rem; color: var(--g500); }
.breadcrumb a { color: var(--green-700); }
.breadcrumb span { margin: 0 6px; }

/* ── Producer detail ── */
.detail-layout { display: grid; grid-template-columns: 1fr 340px; gap: 40px; margin: 24px 0 48px; }
.detail-main { min-width: 0; }
.detail-sidebar { position: sticky; top: 88px; align-self: start; }
.detail-header .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 14px; border-radius: 100px; font-size: 0.78rem; font-weight: 600; }
.badge-green { background: var(--green-100); color: var(--green-700); }
.badge-orange { background: #fef3c7; color: #92400e; }
.badge-gray { background: var(--g100); color: var(--g700); }
.detail-header h1 { font-size: 2rem; font-weight: 800; margin-bottom: 6px; }
.detail-header .loc { display: flex; align-items: center; gap: 6px; color: var(--g500); font-size: 0.95rem; margin-bottom: 16px; }
.detail-header .desc { color: var(--g700); font-size: 1rem; line-height: 1.7; margin-bottom: 24px; }
.detail-stats { display: flex; gap: 24px; margin-bottom: 32px; }
.detail-stat { text-align: center; background: var(--g100); padding: 16px 24px; border-radius: 16px; }
.detail-stat .stat-val { font-size: 1.3rem; font-weight: 700; color: var(--green-700); }
.detail-stat .stat-lbl { font-size: 0.78rem; color: var(--g500); }

.contact-card { background: var(--white); border: 1px solid var(--g100); border-radius: 16px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.contact-card h3 { font-size: 1rem; font-weight: 700; margin-bottom: 16px; }
.contact-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; font-size: 0.9rem; color: var(--g700); }
.contact-row svg { flex-shrink: 0; margin-top: 2px; }
.contact-row a { color: var(--green-700); }
.contact-btns { display: flex; flex-direction: column; gap: 8px; margin-top: 20px; }
.btn-green { display: block; text-align: center; background: var(--green-700); color: var(--white); padding: 12px; border-radius: 12px; font-weight: 600; transition: background 0.2s; }
.btn-green:hover { background: var(--green-900); text-decoration: none; }
.btn-outline { display: block; text-align: center; border: 2px solid var(--green-700); color: var(--green-700); padding: 10px; border-radius: 12px; font-weight: 600; transition: all 0.2s; }
.btn-outline:hover { background: var(--green-50); text-decoration: none; }

.detail-section { margin-bottom: 32px; }
.detail-section h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--g100); }
.product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.product-item { background: var(--g100); border-radius: 12px; padding: 14px 16px; }
.product-item .prod-name { font-weight: 600; font-size: 0.9rem; margin-bottom: 2px; }
.product-item .prod-season { font-size: 0.78rem; color: var(--g500); }
.product-item .prod-organic { font-size: 0.72rem; color: var(--green-700); font-weight: 600; }
.hours-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.hours-row { display: flex; justify-content: space-between; padding: 10px 14px; background: var(--g100); border-radius: 10px; font-size: 0.88rem; }
.hours-row.today { background: var(--green-100); font-weight: 600; }
.hours-day { color: var(--g700); }
.hours-time { color: var(--charcoal); font-weight: 500; }

.cert-badge { display: inline-block; background: #fef3c7; color: #92400e; padding: 4px 14px; border-radius: 100px; font-size: 0.8rem; font-weight: 600; margin-right: 6px; margin-bottom: 6px; }

/* ── Search results ── */
.results-header { margin-bottom: 24px; }
.results-header h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
.results-header .count { color: var(--g500); font-size: 0.9rem; }
.result-list { display: flex; flex-direction: column; gap: 16px; }
.result-card { background: var(--white); border: 1px solid var(--g100); border-radius: 16px; padding: 24px; transition: box-shadow 0.2s; }
.result-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }

/* ── Responsive ── */
@media (max-width: 768px) {
  .hero h1 { font-size: 2rem; }
  .stats-bar { gap: 24px; }
  .footer-grid { grid-template-columns: 1fr 1fr; }
  .detail-layout { grid-template-columns: 1fr; }
  .detail-sidebar { position: static; }
  nav.top-nav .nav-links a:not(.cta-link) { display: none; }
}
`;

// ─── SVG icons (inline) ─────────────────────────────────────

const ICON_LEAF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8c.7-1 1-2.2 1-3.5C18 3.1 16.9 2 15.5 2S13 3.1 13 4.5c0 1.3.3 2.5 1 3.5"/><path d="M6 13c-1 .7-2.2 1-3.5 1C1.1 14 0 12.9 0 11.5S1.1 9 2.5 9c1.3 0 2.5.3 3.5 1"/><path d="M12 22C6.5 22 2 17.5 2 12c0-2.5.9-4.8 2.4-6.5C5.6 4 7.4 3 9.5 3 14 3 18 6.5 18 12c0 5.5-3 10-6 10z"/></svg>`;
const ICON_PIN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ICON_PHONE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
const ICON_MAIL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const ICON_HOME = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

// ─── Page shell ─────────────────────────────────────────────

function htmlShell(title: string, description: string, content: string, extra?: { canonical?: string; jsonLd?: object | object[] }): string {
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
  <style>${CSS}</style>
</head>
<body>
  <nav class="top-nav">
    <div class="nav-inner">
      <a href="/" class="logo">
        ${ICON_LEAF}
        Rett fra Bonden
      </a>
      <div class="nav-links">
        <a href="/oslo">Oslo</a>
        <a href="/bergen">Bergen</a>
        <a href="/trondheim">Trondheim</a>
        <a href="/stavanger">Stavanger</a>
        <a href="/selger.html" class="cta-link">For produsenter</a>
      </div>
    </div>
  </nav>
  ${content}
  <footer>
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <div class="footer-logo">Rett fra Bonden</div>
          <p>Finn lokalprodusert mat direkte fra norske garder, markeder og gaardsbutikker.</p>
        </div>
        <div>
          <h4>Utforsk</h4>
          <ul>
            <li><a href="/oslo">Oslo</a></li>
            <li><a href="/bergen">Bergen</a></li>
            <li><a href="/trondheim">Trondheim</a></li>
            <li><a href="/stavanger">Stavanger</a></li>
          </ul>
        </div>
        <div>
          <h4>For produsenter</h4>
          <ul>
            <li><a href="/selger.html">Registrer deg</a></li>
            <li><a href="${BASE_URL}/api/marketplace/search?q=mat">API</a></li>
            <li><a href="${BASE_URL}/openapi.yaml">OpenAPI</a></li>
          </ul>
        </div>
        <div>
          <h4>Om</h4>
          <ul>
            <li><a href="${BASE_URL}/.well-known/agent-card.json">Agent Card</a></li>
            <li><a href="${BASE_URL}/a2a">A2A</a></li>
            <li><a href="${BASE_URL}/mcp">MCP</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        &copy; ${new Date().getFullYear()} Rett fra Bonden. Alle rettigheter reservert.
      </div>
    </div>
  </footer>
</body>
</html>`;
}

// ─── GET / — Landing page ───────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  try {
    const stats = marketplaceRegistry.getStats();
    const agents = marketplaceRegistry.getActiveAgents();
    const totalCount = stats.totalAgents || agents.length;

    // Count agents per city
    const cityCounts: Record<string, number> = {};
    agents.forEach((a: any) => {
      const city = a.city || a.location?.city;
      if (city) cityCounts[city] = (cityCounts[city] || 0) + 1;
    });

    // Count agents per category
    const categoryCounts: Record<string, number> = {};
    agents.forEach((a: any) => {
      (a.categories || []).forEach((c: string) => {
        categoryCounts[c] = (categoryCounts[c] || 0) + 1;
      });
    });

    // Sort cities by count
    const topCities = Object.entries(cityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    // Featured producers (high trust)
    const featured = agents
      .filter((a: any) => (a.trustScore || 0) >= 0.7)
      .slice(0, 6);

    // Category cards
    const categoryCards = Object.entries(CATEGORY_MAP).map(([key, { emoji, label }]) => {
      const count = categoryCounts[key] || 0;
      return `<a href="/sok?q=${encodeURIComponent(label.toLowerCase())}" class="cat-card">
        <div class="emoji">${emoji}</div>
        <div class="cat-name">${label}</div>
        <div class="cat-count">${count} produsenter</div>
      </a>`;
    }).join("\n");

    // City cards
    const cityCards = topCities.map(([city, count]) =>
      `<a href="/${slugify(city)}" class="city-card">
        <div class="city-icon">${ICON_PIN}</div>
        <div>
          <div class="city-name">${escapeHtml(city)}</div>
          <div class="city-count">${count} produsenter</div>
        </div>
      </a>`
    ).join("\n");

    // Featured producer cards
    const featuredCards = featured.map((a: any) => {
      const slug = slugify(a.name);
      const city = a.city || a.location?.city || "";
      const cats = (a.categories || []).slice(0, 3).map((c: string) => `<span class="tag">${escapeHtml(CATEGORY_MAP[c]?.label || c)}</span>`).join("");
      const trustPct = Math.round((a.trustScore || 0.5) * 100);
      return `<div class="prod-card">
        <h3><a href="/produsent/${slug}">${escapeHtml(a.name)}</a></h3>
        <div class="prod-loc">${ICON_PIN} ${escapeHtml(city)}</div>
        <div class="prod-desc">${escapeHtml((a.description || "").slice(0, 120))}${(a.description || "").length > 120 ? "..." : ""}</div>
        <div class="prod-tags">${cats}</div>
        <div class="trust-row">
          <div class="trust-bar"><div class="trust-fill" style="width:${trustPct}%"></div></div>
          <span class="trust-label">${trustPct}% tillit</span>
        </div>
        <a href="/produsent/${slug}" class="prod-link">Se profil &rarr;</a>
      </div>`;
    }).join("\n");

    const uniqueCategories = new Set<string>();
    agents.forEach((a: any) => (a.categories || []).forEach((c: string) => uniqueCategories.add(c)));

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Rett fra Bonden",
      "url": BASE_URL,
      "description": "Finn lokalprodusert mat i Norge. Sok blant garder, markeder og gaardsbutikker.",
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${BASE_URL}/api/marketplace/search?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    };

    const content = `
    <div class="hero">
      <div class="container">
        <div class="pill"><span class="dot"></span> ${totalCount} produsenter i hele Norge</div>
        <h1>Finn fersk, <span class="hl">lokal mat</span> naer deg</h1>
        <p class="subtitle">Direkte fra norske garder, markeder og gaardsbutikker til ditt bord.</p>
        <form class="search-form" action="/sok" method="GET">
          <input type="text" name="q" placeholder="Sok etter mat, sted eller produsent..." aria-label="Sok">
          <button type="submit">Sok</button>
        </form>
        <div class="chips">
          <a href="/sok?q=gronnsaker">Gronnsaker</a>
          <a href="/sok?q=honning">Honning</a>
          <a href="/sok?q=egg">Egg</a>
          <a href="/sok?q=okologisk">Okologisk</a>
          <a href="/sok?q=ost">Ost</a>
        </div>
        <div class="stats-bar">
          <div class="stat"><div class="stat-num">${totalCount}</div><div class="stat-label">Produsenter</div></div>
          <div class="stat"><div class="stat-num">${topCities.length}</div><div class="stat-label">Byer</div></div>
          <div class="stat"><div class="stat-num">${uniqueCategories.size}</div><div class="stat-label">Kategorier</div></div>
        </div>
      </div>
    </div>

    <div class="section section-gray">
      <div class="container">
        <h2 class="section-title">Kategorier</h2>
        <p class="section-sub">Utforsk lokal mat etter kategori</p>
        <div class="cat-grid">${categoryCards}</div>
      </div>
    </div>

    <div class="section">
      <div class="container">
        <h2 class="section-title">Populaere byer</h2>
        <p class="section-sub">Finn matprodusenter i din by</p>
        <div class="city-grid">${cityCards}</div>
      </div>
    </div>

    ${featured.length ? `
    <div class="section section-gray">
      <div class="container">
        <h2 class="section-title">Utvalgte produsenter</h2>
        <p class="section-sub">Produsenter med hoy tillit og verifisert kvalitet</p>
        <div class="prod-grid">${featuredCards}</div>
      </div>
    </div>` : ""}

    <div class="section">
      <div class="container">
        <h2 class="section-title" style="text-align:center">Slik fungerer det</h2>
        <p class="section-sub" style="text-align:center">Tre enkle steg til fersk, lokal mat</p>
        <div class="steps-grid">
          <div class="step-card">
            <div class="step-num">1</div>
            <h3>Sok</h3>
            <p>Skriv inn hva du leter etter og hvor du befinner deg.</p>
          </div>
          <div class="step-card">
            <div class="step-num">2</div>
            <h3>Utforsk</h3>
            <p>Se produsenter, produkter, apningstider og kontaktinfo.</p>
          </div>
          <div class="step-card">
            <div class="step-num">3</div>
            <h3>Kjop direkte</h3>
            <p>Ta kontakt med produsenten og kjop fersk mat rett fra bonden.</p>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="container">
        <div class="cta-banner">
          <h2>Er du matprodusent?</h2>
          <p>Registrer deg gratis og bli synlig for tusenvis av kunder som leter etter lokal mat.</p>
          <a href="/selger.html" class="btn-white">Kom i gang gratis</a>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="container">
        <div class="ai-banner">
          <h3>Tilgjengelig for AI-assistenter</h3>
          <p>Rett fra Bonden er integrert med ledende AI-plattformer.</p>
          <div class="ai-logos">
            <span>ChatGPT</span>
            <span>Claude</span>
            <span>MCP</span>
            <span>A2A</span>
          </div>
        </div>
      </div>
    </div>`;

    res.send(htmlShell(
      "Rett fra Bonden — Finn lokalprodusert mat i Norge",
      `Sok blant ${totalCount} lokale matprodusenter i Norge. Garder, markeder, gaardsbutikker med kontaktinfo og apningstider.`,
      content,
      { canonical: BASE_URL, jsonLd }
    ));
  } catch (err) {
    console.error("SEO / error:", err);
    res.status(500).send("Intern feil");
  }
});

// ─── GET /sok?q=... — Search results page ──────────────────

router.get("/sok", (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) { res.redirect("/"); return; }

  try {
    const parsed = marketplaceRegistry.parseNaturalQuery(q);
    const results = marketplaceRegistry.discover({ ...parsed, limit: 30, offset: 0 });

    const resultCards = results.map((r: any) => {
      const a = r.agent;
      const city = a.city || a.location?.city || "";
      const slug = slugify(a.name);
      const cats = (a.categories || []).map((c: string) => `<span class="tag">${escapeHtml(CATEGORY_MAP[c]?.label || c)}</span>`).join("");
      return `<div class="result-card">
        <h3><a href="/produsent/${slug}">${escapeHtml(a.name)}</a></h3>
        <div class="prod-loc">${ICON_PIN} ${escapeHtml(city)}${r.distanceKm ? ` &middot; ${r.distanceKm.toFixed(1)} km` : ""}</div>
        <div class="prod-desc">${escapeHtml(a.description || "")}</div>
        <div class="prod-tags" style="margin-top:8px">${cats}</div>
      </div>`;
    }).join("\n");

    const content = `
    <div class="container" style="padding-top:32px; padding-bottom:48px; min-height:60vh;">
      <div class="results-header">
        <h1>Sokresultater for &ldquo;${escapeHtml(q)}&rdquo;</h1>
        <div class="count">${results.length} treff</div>
      </div>
      <form class="search-form" action="/sok" method="GET" style="margin-bottom:32px; max-width:100%;">
        <input type="text" name="q" value="${escapeHtml(q)}" aria-label="Sok">
        <button type="submit">Sok</button>
      </form>
      <div class="result-list">${resultCards || "<p style='color:var(--g500)'>Ingen resultater. Prov et bredere sok.</p>"}</div>
    </div>`;

    res.send(htmlShell(
      `${q} — Rett fra Bonden`,
      `Sokresultater for "${q}" — finn lokale matprodusenter i Norge.`,
      content,
      { canonical: `${BASE_URL}/sok?q=${encodeURIComponent(q)}` }
    ));
  } catch (err) {
    console.error("SEO /sok error:", err);
    res.status(500).send("Intern feil");
  }
});

// ─── GET /:city — City page ────────────────────────────────

router.get("/:city", (req: Request, res: Response, next: any) => {
  const citySlug = (req.params.city as string).toLowerCase();

  // Skip non-city routes
  if (citySlug.startsWith("api") || citySlug.startsWith(".") || citySlug === "health"
      || citySlug === "a2a" || citySlug === "mcp" || citySlug === "sok"
      || citySlug === "produsent" || citySlug === "sitemap.xml" || citySlug === "robots.txt"
      || citySlug === "openapi.yaml" || citySlug === "favicon.ico"
      || citySlug.includes(".")) {
    return next();
  }

  try {
    const agents = marketplaceRegistry.getActiveAgents();

    // Match city by slug
    const cityAgents = agents.filter((a: any) => {
      const city = a.city || a.location?.city || "";
      return slugify(city) === citySlug;
    });

    if (cityAgents.length === 0) {
      return res.status(404).send(htmlShell(
        "Fant ingen produsenter",
        "Ingen produsenter funnet for denne byen.",
        `<div class="container" style="padding: 80px 0; text-align: center;">
          <h1 style="font-size:1.5rem; margin-bottom:12px;">Fant ingen produsenter for &ldquo;${escapeHtml(citySlug)}&rdquo;</h1>
          <p><a href="/">Tilbake til forsiden</a></p>
        </div>`
      ));
    }

    const cityName = (cityAgents[0] as any).city || cityAgents[0].location?.city || citySlug;
    const coords = CITY_COORDS[citySlug];

    // Schema.org for each producer
    const jsonLdItems = cityAgents.slice(0, 50).map((a: any) => {
      const info = knowledgeService.getAgentInfo(a.id);
      const k = info?.knowledge || {} as any;
      const item: any = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": a.name,
        "description": a.description || "",
        "url": `${BASE_URL}/produsent/${slugify(a.name)}`,
      };
      if (k.address) item.address = { "@type": "PostalAddress", "streetAddress": k.address, "addressLocality": cityName, "addressCountry": "NO" };
      if (k.phone) item.telephone = k.phone;
      if (k.email) item.email = k.email;
      if (k.website) item.sameAs = k.website;
      if (a.location?.lat && a.location?.lng) item.geo = { "@type": "GeoCoordinates", "latitude": a.location.lat, "longitude": a.location.lng };
      if (a.categories?.length) item.keywords = a.categories.join(", ");
      return item;
    });

    const producerCards = cityAgents.map((a: any) => {
      const slug = slugify(a.name);
      const cats = (a.categories || []).slice(0, 3).map((c: string) => `<span class="tag">${escapeHtml(CATEGORY_MAP[c]?.label || c)}</span>`).join("");
      const trustPct = Math.round((a.trustScore || 0.5) * 100);
      return `<div class="prod-card">
        <h3><a href="/produsent/${slug}">${escapeHtml(a.name)}</a></h3>
        <div class="prod-desc">${escapeHtml((a.description || "").slice(0, 150))}</div>
        <div class="prod-tags">${cats}</div>
        <div class="trust-row">
          <div class="trust-bar"><div class="trust-fill" style="width:${trustPct}%"></div></div>
          <span class="trust-label">${trustPct}% tillit</span>
        </div>
        <a href="/produsent/${slug}" class="prod-link">Se profil &rarr;</a>
      </div>`;
    }).join("\n");

    const content = `
    <div class="container" style="padding-top:16px; padding-bottom:48px;">
      <div class="breadcrumb"><a href="/">Hjem</a><span>/</span>${escapeHtml(cityName)}</div>
      <h1 class="section-title">Lokal mat i ${escapeHtml(cityName)}</h1>
      <p class="section-sub">${cityAgents.length} lokale matprodusenter i ${escapeHtml(cityName)}-omraadet</p>
      <div class="prod-grid">${producerCards}</div>
    </div>`;

    res.send(htmlShell(
      `Lokal mat i ${cityName} — ${cityAgents.length} produsenter | Rett fra Bonden`,
      `Finn ${cityAgents.length} lokale matprodusenter i ${cityName}. Garder, markeder og gaardsbutikker med kontaktinfo.`,
      content,
      { canonical: `${BASE_URL}/${citySlug}`, jsonLd: jsonLdItems }
    ));
  } catch (err) {
    console.error(`SEO /${citySlug} error:`, err);
    res.status(500).send("Intern feil");
  }
});

// ─── GET /produsent/:slug — Producer detail page ────────────

router.get("/produsent/:slug", (req: Request, res: Response) => {
  const slug = (req.params.slug as string).toLowerCase();

  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const agent = agents.find((a: any) => slugify(a.name) === slug);

    if (!agent) {
      return res.status(404).send(htmlShell(
        "Produsent ikke funnet",
        "Denne produsenten finnes ikke.",
        `<div class="container" style="padding: 80px 0; text-align: center;">
          <h1 style="font-size:1.5rem; margin-bottom:12px;">Produsent ikke funnet</h1>
          <p><a href="/">Tilbake til forsiden</a></p>
        </div>`
      ));
    }

    const info = knowledgeService.getAgentInfo(agent.id);
    const k = (info?.knowledge || {}) as any;
    const meta = (info?.meta || {}) as any;
    const cityName = (agent as any).city || agent.location?.city || "";

    // Badges
    const badges: string[] = [];
    if (agent.isVerified) badges.push(`<span class="badge badge-green">Verifisert</span>`);
    if (k.certifications?.includes("organic") || k.certifications?.includes("okologisk"))
      badges.push(`<span class="badge badge-orange">Okologisk</span>`);
    (agent.categories || []).forEach((c: string) => {
      badges.push(`<span class="badge badge-gray">${escapeHtml(CATEGORY_MAP[c]?.label || c)}</span>`);
    });

    // Trust & rating stats
    const trustPct = Math.round((agent.trustScore || 0.5) * 100);
    const statBlocks: string[] = [];
    statBlocks.push(`<div class="detail-stat"><div class="stat-val">${trustPct}%</div><div class="stat-lbl">Tillit</div></div>`);
    if (k.googleRating) statBlocks.push(`<div class="detail-stat"><div class="stat-val">${k.googleRating}</div><div class="stat-lbl">Google</div></div>`);

    // Contact sidebar
    const contactRows: string[] = [];
    if (k.address) contactRows.push(`<div class="contact-row">${ICON_HOME} <span>${escapeHtml(k.address)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</span></div>`);
    if (k.phone) contactRows.push(`<div class="contact-row">${ICON_PHONE} <a href="tel:${k.phone.replace(/\s+/g, "")}">${escapeHtml(k.phone)}</a></div>`);
    if (k.email) contactRows.push(`<div class="contact-row">${ICON_MAIL} <a href="mailto:${k.email}">${escapeHtml(k.email)}</a></div>`);
    if (k.website) contactRows.push(`<div class="contact-row">${ICON_GLOBE} <a href="${escapeHtml(k.website)}" rel="noopener">${escapeHtml(k.website.replace(/^https?:\/\//, ""))}</a></div>`);

    const contactBtns: string[] = [];
    if (k.website) contactBtns.push(`<a href="${escapeHtml(k.website)}" class="btn-green" rel="noopener">Besok nettside</a>`);
    contactBtns.push(`<a href="${BASE_URL}/api/marketplace/agents/${agent.id}/vcard" class="btn-outline">Last ned kontaktkort</a>`);

    // Products
    const productsHtml = k.products?.length
      ? `<div class="detail-section">
          <h2>Produkter</h2>
          <div class="product-grid">
            ${k.products.map((p: any) => {
              const months = p.months?.length
                ? `${MONTH_SHORT[(p.months[0] - 1) % 12]} - ${MONTH_SHORT[(p.months[p.months.length - 1] - 1) % 12]}`
                : "";
              const organic = p.organic ? `<div class="prod-organic">Okologisk</div>` : "";
              return `<div class="product-item">
                <div class="prod-name">${escapeHtml(p.name)}</div>
                ${months ? `<div class="prod-season">${months}</div>` : ""}
                ${organic}
              </div>`;
            }).join("")}
          </div>
        </div>`
      : "";

    // Opening hours with "today" highlight
    const dayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const dayNames: Record<string, string> = { mon: "Mandag", tue: "Tirsdag", wed: "Onsdag", thu: "Torsdag", fri: "Fredag", sat: "Lordag", sun: "Sondag" };
    const todayIdx = (new Date().getDay() + 6) % 7; // 0=Mon
    const hoursHtml = k.openingHours?.length
      ? `<div class="detail-section">
          <h2>Apningstider</h2>
          <div class="hours-grid">
            ${dayKeys.map((day, i) => {
              const h = k.openingHours.find((oh: any) => oh.day === day);
              const isToday = i === todayIdx;
              const time = h ? `${h.open} - ${h.close}` : "Stengt";
              return `<div class="hours-row${isToday ? " today" : ""}">
                <span class="hours-day">${dayNames[day]}${isToday ? " (i dag)" : ""}</span>
                <span class="hours-time">${time}</span>
              </div>`;
            }).join("")}
          </div>
        </div>`
      : "";

    // Certifications
    const certsHtml = k.certifications?.length
      ? `<div class="detail-section">
          <h2>Sertifiseringer</h2>
          ${k.certifications.map((c: string) => `<span class="cert-badge">${escapeHtml(c)}</span>`).join(" ")}
        </div>`
      : "";

    // Payment & delivery
    const payHtml = k.paymentMethods?.length
      ? `<div class="detail-section"><h2>Betaling</h2><p style="color:var(--g700)">${k.paymentMethods.map((m: string) => escapeHtml(m)).join(", ")}</p></div>`
      : "";
    const deliveryHtml = k.deliveryOptions?.length
      ? `<div class="detail-section"><h2>Levering</h2><p style="color:var(--g700)">${k.deliveryOptions.map((d: string) => escapeHtml(d)).join(", ")}</p></div>`
      : "";

    // Schema.org LocalBusiness
    const jsonLd: any = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "name": agent.name,
      "description": agent.description || k.about || "",
      "url": `${BASE_URL}/produsent/${slug}`,
    };
    if (k.address) jsonLd.address = { "@type": "PostalAddress", "streetAddress": k.address, "postalCode": k.postalCode || "", "addressLocality": cityName, "addressCountry": "NO" };
    if (k.phone) jsonLd.telephone = k.phone;
    if (k.email) jsonLd.email = k.email;
    if (k.website) jsonLd.sameAs = k.website;
    if (agent.location?.lat && agent.location?.lng) jsonLd.geo = { "@type": "GeoCoordinates", "latitude": agent.location.lat, "longitude": agent.location.lng };
    if (k.openingHours?.length) {
      const dayMap: Record<string, string> = { mon: "Mo", tue: "Tu", wed: "We", thu: "Th", fri: "Fr", sat: "Sa", sun: "Su" };
      jsonLd.openingHoursSpecification = k.openingHours.map((h: any) => ({
        "@type": "OpeningHoursSpecification",
        "dayOfWeek": dayMap[h.day] || h.day,
        "opens": h.open,
        "closes": h.close,
      }));
    }

    const content = `
    <div class="container" style="padding-top:8px; padding-bottom:48px;">
      <div class="breadcrumb">
        <a href="/">Hjem</a><span>/</span>${cityName ? `<a href="/${slugify(cityName)}">${escapeHtml(cityName)}</a><span>/</span>` : ""}${escapeHtml(agent.name)}
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-header">
            ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
            <h1>${escapeHtml(agent.name)}</h1>
            ${cityName ? `<div class="loc">${ICON_PIN} ${escapeHtml(cityName)}</div>` : ""}
            ${k.about ? `<div class="desc">${escapeHtml(k.about)}</div>` : (agent.description ? `<div class="desc">${escapeHtml(agent.description)}</div>` : "")}
            ${statBlocks.length ? `<div class="detail-stats">${statBlocks.join("")}</div>` : ""}
          </div>

          ${productsHtml}
          ${hoursHtml}
          ${certsHtml}
          ${payHtml}
          ${deliveryHtml}

          ${meta.disclaimer ? `<p style="margin-top: 32px; font-size: 0.8rem; color: var(--g500);">${escapeHtml(meta.disclaimer)}</p>` : ""}
        </div>

        <div class="detail-sidebar">
          <div class="contact-card">
            <h3>Kontaktinformasjon</h3>
            ${contactRows.join("")}
            <div class="contact-btns">${contactBtns.join("")}</div>
          </div>
        </div>
      </div>
    </div>`;

    res.send(htmlShell(
      `${agent.name} — Lokal mat${cityName ? ` i ${cityName}` : ""} | Rett fra Bonden`,
      `${agent.name}${cityName ? ` i ${cityName}` : ""}. ${agent.description || "Lokalprodusert mat i Norge."}`,
      content,
      { canonical: `${BASE_URL}/produsent/${slug}`, jsonLd }
    ));
  } catch (err) {
    console.error(`SEO /produsent/${slug} error:`, err);
    res.status(500).send("Intern feil");
  }
});

// ─── GET /sitemap.xml ───────────────────────────────────────

router.get("/sitemap.xml", (_req: Request, res: Response) => {
  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const today = new Date().toISOString().split("T")[0];

    // Collect unique cities
    const cities = new Set<string>();
    agents.forEach((a: any) => {
      const city = a.city || a.location?.city;
      if (city) cities.add(slugify(city));
    });

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${today}</lastmod></url>`;

    // City pages
    for (const city of cities) {
      xml += `\n  <url><loc>${BASE_URL}/${city}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${today}</lastmod></url>`;
    }

    // Producer pages
    for (const a of agents) {
      const slug = slugify(a.name);
      xml += `\n  <url><loc>${BASE_URL}/produsent/${slug}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${today}</lastmod></url>`;
    }

    xml += "\n</urlset>";

    res.header("Content-Type", "application/xml");
    res.send(xml);
  } catch (err) {
    console.error("Sitemap error:", err);
    res.status(500).send("Error generating sitemap");
  }
});

// ─── GET /robots.txt ────────────────────────────────────────

router.get("/robots.txt", (_req: Request, res: Response) => {
  res.header("Content-Type", "text/plain");
  res.send(`User-agent: *
Allow: /

Sitemap: ${BASE_URL}/sitemap.xml
`);
});

export default router;

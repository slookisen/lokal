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
import { geocodingService } from "../services/geocoding-service";
import { analyticsService } from "../services/analytics-service";
import { DiscoveryQuerySchema } from "../models/marketplace";
import { getDb } from "../database/init";
import { conversationService } from "../services/conversation-service";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────

function slugify(text: string): string {
  return text.normalize("NFC").toLowerCase()
    .replace(/\u00e6/g, "ae").replace(/\u00f8/g, "o").replace(/\u00e5/g, "a")
    .replace(/\u00e4/g, "a").replace(/\u00f6/g, "o").replace(/\u00fc/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(text: string): string {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
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
  <meta property="og:locale" content="nb_NO">
  <meta property="og:site_name" content="Rett fra Bonden">
  <meta property="og:image" content="${BASE_URL}/logo-512.png">
  <meta property="og:image:width" content="512">
  <meta property="og:image:height" content="512">
  <meta property="og:image:alt" content="Rett fra Bonden — lokal mat rett fra bonden i Norge">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${BASE_URL}/logo-512.png">
  <meta name="twitter:image:alt" content="Rett fra Bonden — lokal mat rett fra bonden i Norge">
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
  <link rel="alternate" hreflang="nb" href="${canonicalUrl}">
  <link rel="alternate" hreflang="en" href="${canonicalUrl}">
  <link rel="alternate" hreflang="x-default" href="${canonicalUrl}">
  ${jsonLdScript}
  ${CSS}
  ${extra?.extraCss ? `<style>${extra.extraCss}</style>` : ""}
</head>
<body>
  <nav class="nav">
    <a href="/" class="nav-logo"><div class="nav-icon">&#127793;</div> Rett fra Bonden</a>
    <div class="nav-links">
      <a href="/samtaler">Samtaler</a>
      <a href="/sok">S\u00f8k</a>
      <a href="/teknologi">Hvordan det fungerer</a>
      <a href="/om">Om oss</a>
      <a href="/selger" class="nav-cta">For produsenter</a>
    </div>
  </nav>
  ${content}
  <footer class="ft">
    <div class="ft-inner">
      <div>
        <div class="ft-brand">Rett fra Bonden</div>
        <div class="ft-desc">Norges f\u00f8rste agent-til-agent (A2A) nettverk for lokal mat. Vi gj\u00f8r matprodusenter synlige for AI-assistenter \u2014 s\u00e5 kundene finner deg n\u00e5r de sp\u00f8r.</div>
      </div>
      <div class="ft-col">
        <h4>Plattformen</h4>
        <a href="/sok">S\u00f8k produsenter</a><a href="/teknologi">Hvordan det fungerer</a><a href="/om">Om Rett fra Bonden</a><a href="/personvern">Personvern</a>
      </div>
      <div class="ft-col">
        <h4>For produsenter</h4>
        <a href="/selger">Registrer deg</a><a href="/selger">Logg inn</a>
      </div>
      <div class="ft-col">
        <h4>For utviklere</h4>
        <a href="/api/marketplace/search?q=mat">API</a><a href="https://github.com/slookisen/lokal">GitHub</a><a href="https://smithery.ai/servers/slookisen/lokal">MCP Server</a>
      </div>
    </div>
    <div class="ft-bottom">Rett fra Bonden &copy; ${new Date().getFullYear()}. Gj\u00f8r matprodusenter synlige i hele Norge.</div>
  </footer>
</body>
</html>`;
}

// ─── Producer card HTML (reused across pages) ───────────────

function producerCard(a: any, matchReasons?: string[]): string {
  const city = a.city || a.location?.city || "";
  const distKm = a.location?.distanceKm;
  const cityText = distKm != null
    ? `${escapeHtml(city)} &middot; ${distKm < 1 ? (distKm * 1000).toFixed(0) + " m" : distKm.toFixed(1) + " km"}`
    : escapeHtml(city);
  const slug = slugify(a.name);
  const cats = (a.categories || []).slice(0, 3).map((c: string) => `<span class="tag">${catEmoji(c)} ${escapeHtml(formatCat(c))}</span>`).join("");
  const trustPct = Math.round((a.trustScore || 0) * 100);
  const desc = a.description || "";
  const verified = a.isVerified ? `<span class="badge badge-v">&#10003; Verifisert</span>` : "";

  return `<a href="/produsent/${slug}" class="pc">
    <div class="pc-top">
      <div>
        <div class="pc-name">${escapeHtml(a.name)}</div>
        <div class="pc-city">${cityText}</div>
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

// ─── Traffic stats helper ───────────────────────────────────────

function sqlDate(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

interface TrafficStats {
  pageViews: number;
  uniqueVisitors: number;
  realHumans: number;
  botAndAi: number;
  aiQueries: number;
}

// Bot detection patterns (same as analytics.ts traffic-classification)
const BOT_PATTERNS = ['bot', 'Bot', 'spider', 'crawl', 'serpstat', 'GPTBot', 'ClaudeBot', 'Chiark', 'Go-http-client', 'Dataprovider', 'NotHumanSearch', 'DuckDuck', 'Googlebot', 'GoogleOther', 'Bytespider', 'Applebot', 'YandexBot', 'BingPreview', 'facebookexternal', 'Twitterbot'];
const DEV_PATTERNS = ['curl/', 'Python/', 'aiohttp', 'Lokal/', 'Lokal-Enricher', 'Claude-User', 'Python-urllib', 'node-fetch', 'axios/'];

let _trafficCache: TrafficStats | null = null;
let _trafficCacheTime = 0;
const TRAFFIC_CACHE_TTL = 120_000; // 2 minutes

function getTrafficStats(): TrafficStats {
  const now = Date.now();
  if (_trafficCache && (now - _trafficCacheTime) < TRAFFIC_CACHE_TTL) {
    return _trafficCache;
  }
  try {
    const db = getDb();
    const notOwner = "(is_owner IS NULL OR is_owner = 0)";

    // Total page views (excluding owner)
    const pageViews = (db.prepare(`SELECT COUNT(*) as n FROM analytics_page_views WHERE ${notOwner}`).get() as any)?.n ?? 0;

    // Session-based classification: group by session_id, check UA for bots
    const sessions = db.prepare(`
      SELECT session_id, COUNT(*) as views
      FROM analytics_page_views
      WHERE ${notOwner}
      GROUP BY session_id
    `).all() as any[];

    let realHumans = 0;
    let botViews = 0;
    for (const s of sessions) {
      const ua = s.session_id.includes(':') ? s.session_id.split(':').slice(1).join(':') : '';
      const isBot = BOT_PATTERNS.some(p => ua.includes(p));
      const isDev = DEV_PATTERNS.some(p => ua.includes(p));
      if (isBot || isDev) {
        botViews += s.views;
      } else {
        realHumans += s.views;
      }
    }

    // AI queries from analytics_queries
    const aiQueries = (db.prepare(`SELECT COUNT(*) as n FROM analytics_queries WHERE ${notOwner}`).get() as any)?.n ?? 0;

    _trafficCache = {
      pageViews,
      uniqueVisitors: sessions.length,
      realHumans,
      botAndAi: botViews + aiQueries,
      aiQueries,
    };
    _trafficCacheTime = Date.now();
    return _trafficCache;
  } catch {
    return { pageViews: 0, uniqueVisitors: 0, realHumans: 0, botAndAi: 0, aiQueries: 0 };
  }
}

// ─── Live conversation showcase for landing page ────────────

function buildConversationShowcase(): string {
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
  const s = getTrafficStats();
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
`;

router.get("/", (_req: Request, res: Response) => {
  try {
    const stats = marketplaceRegistry.getStats();
    const agents = marketplaceRegistry.getActiveAgents();
    const totalAgents = stats.totalAgents || agents.length;
    const traffic = getTrafficStats();

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

    // Featured producers — verified first, then highest trust. Show more to fill section.
    const featured = agents
      .filter((a: any) => a.trustScore >= 0.35)
      .sort((a: any, b: any) => {
        if (a.isVerified && !b.isVerified) return -1;
        if (!a.isVerified && b.isVerified) return 1;
        return (b.trustScore || 0) - (a.trustScore || 0);
      })
      .slice(0, 8);

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
        <div><div class="city-name">${escapeHtml(city)}</div><div class="city-count">${count} produsenter</div></div>
      </a>`
    ).join("");

    const featuredCards = featured.map((a: any) => producerCard(a)).join("");

    const uniqueCities = Object.keys(cityCounts).length;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Rett fra Bonden",
      "url": BASE_URL,
      "description": "Finn lokalprodusert mat i Norge. S\u00f8k blant g\u00e5rder, markeder og g\u00e5rdsbutikker.",
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${BASE_URL}/sok?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    };

    const content = `
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-pill"><span class="hero-dot"></span> ${totalAgents} produsenter i hele Norge</div>
        <h1>Finn <em>fersk, lokal mat</em> n\u00e6r deg</h1>
        <p class="hero-sub">S\u00f8k blant g\u00e5rder, markeder og g\u00e5rdsbutikker over hele landet. Direkte fra bonden til bordet ditt.</p>
        <div class="hero-search">
          <form action="/sok" method="GET">
            <input type="text" name="q" placeholder="S\u00f8k etter mat, sted eller produsent..." aria-label="S\u00f8k">
            <button type="submit">S\u00f8k</button>
          </form>
        </div>
        <div class="hero-chips">
          <a href="/sok?q=gr%C3%B8nnsaker+oslo" class="chip">&#127813; Gr\u00f8nnsaker i Oslo</a>
          <a href="/sok?q=honning+bergen" class="chip">&#127855; Honning i Bergen</a>
          <a href="/sok?q=%C3%B8kologisk+kj%C3%B8tt" class="chip">&#129385; \u00d8kologisk kj\u00f8tt</a>
          <a href="/sok?q=g%C3%A5rdsbutikk" class="chip">&#127793; G\u00e5rdsbutikker</a>
        </div>
        <div class="ai-assist">
          <p class="ai-assist-label">Eller sp\u00f8r din AI-assistent:</p>
          <div class="ai-assist-btns">
            <a href="https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-finn-lokal-mat-i-norge" target="_blank" rel="noopener" class="ai-btn ai-chatgpt">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>
              ChatGPT
            </a>
            <a href="/teknologi#claude-mcp" class="ai-btn ai-claude">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4.709 15.955l4.397-2.553-.209-.12-4.478 2.488.29.185zm7.737-4.48L8.051 8.97l-.209.12 4.394 2.505.21-.12zm-4.187-2.384L12.656 6.6l-.21-.12-4.397 2.553.21.058zm8.375-.12l-4.188 2.43.21.12 4.187-2.43-.21-.12zM12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/></svg>
              Claude
            </a>
          </div>
          <p class="ai-assist-hint">Bruk MCP for \u00e5 la AI-en din s\u00f8ke direkte i v\u00e5r database. <a href="/teknologi#mcp-oppsett">Se oppsettguide &rarr;</a></p>
        </div>
        <div class="stats-bar">
          <div style="text-align:center"><div class="stat-n">${totalAgents}</div><div class="stat-l">Produsenter</div></div>
          <div style="text-align:center"><div class="stat-n">${uniqueCities}</div><div class="stat-l">Byer</div></div>
          <div style="text-align:center"><div class="stat-n">${Object.keys(categoryCounts).length}</div><div class="stat-l">Kategorier</div></div>
        </div>
      </div>
    </section>

    <div class="proof-bar">
      <div class="proof-inner">
        <div class="proof-item">
          <div class="proof-val">${traffic.pageViews.toLocaleString("nb-NO")}</div>
          <div class="proof-lbl">Sidevisninger</div>
        </div>
        <div class="proof-sep"></div>
        <div class="proof-item">
          <div class="proof-val">${traffic.uniqueVisitors.toLocaleString("nb-NO")}</div>
          <div class="proof-lbl">Unike bes\u00f8kende</div>
        </div>
        <div class="proof-sep"></div>
        <div class="proof-item">
          <div class="proof-val">${traffic.realHumans.toLocaleString("nb-NO")}</div>
          <div class="proof-lbl">Ekte mennesker</div>
        </div>
        <div class="proof-sep"></div>
        <div class="proof-item">
          <div class="proof-val proof-val-purple">${traffic.botAndAi.toLocaleString("nb-NO")}</div>
          <div class="proof-lbl">Bot &amp; AI-trafikk</div>
        </div>
      </div>
    </div>

    <section class="cats-section">
      <div class="sh" style="max-width:1100px;margin:0 auto 28px;">
        <div class="sh-label">Kategorier</div>
        <div class="sh-title">Hva leter du etter?</div>
      </div>
      <div class="cats-grid">${catCards}</div>
    </section>

    <section class="sec">
      <div class="sh">
        <div class="sh-label">Utforsk</div>
        <div class="sh-title">Popul\u00e6re byer</div>
        <div class="sh-sub">Finn produsenter i n\u00e6rheten av deg</div>
      </div>
      <div class="cities-grid">${cityCards}</div>
    </section>

    <section class="sec" style="background:var(--white);">
      <div class="sh">
        <div class="sh-label">Oppdag</div>
        <div class="sh-title">Produsenter</div>
        <div class="sh-sub">Norske matprodusenter i nettverket</div>
      </div>
      <div class="feat-grid">${featuredCards}</div>
    </section>

    <section class="sec how-sec">
      <div class="sh">
        <div class="sh-label">Slik fungerer det</div>
        <div class="sh-title">Fra s\u00f8k til g\u00e5rdsbes\u00f8k</div>
      </div>
      <div class="how-grid">
        <div class="how-step"><div class="how-num">1</div><h3>S\u00f8k etter det du vil ha</h3><p>Skriv inn hva du leter etter \u2014 \u00abgrønnsaker i Oslo\u00bb eller \u00ab\u00f8kologisk kj\u00f8tt\u00bb.</p></div>
        <div class="how-step"><div class="how-num">2</div><h3>Utforsk produsenter</h3><p>Se produkter, \u00e5pningstider, sertifiseringer og kontaktinfo.</p></div>
        <div class="how-step"><div class="how-num">3</div><h3>Kj\u00f8p direkte</h3><p>Bes\u00f8k g\u00e5rdsbutikken, ring direkte, eller la AI-assistenten din finne det automatisk.</p></div>
      </div>
    </section>

    <section class="seller-cta">
      <h2>Er du matprodusent?</h2>
      <p>Registrer deg gratis og bli synlig for tusenvis av kunder \u2014 og AI-assistentene deres.</p>
      <a href="/selger" class="seller-btn">Registrer gratis</a>
      <span class="seller-note">Under 2 minutter. Ingen kredittkort.</span>
    </section>

    ${buildConversationShowcase()}

    <section class="ai-sec">
      <div class="ai-banner">
        <div class="ai-icon">&#129302;</div>
        <div class="ai-text">
          <h3>Bruk AI-assistenten din til \u00e5 finne lokal mat</h3>
          <p>Sp\u00f8r ChatGPT eller Claude \u00abhvor finner jeg ferske gr\u00f8nnsaker i Oslo?\u00bb \u2014 de finner svaret her. Velg din plattform:</p>
          <div class="ai-logos">
            <a href="https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-finn-lokal-mat-i-norge" target="_blank" rel="noopener" class="ai-logo" title="\u00c5pne Lokal Norsk Matfinner i ChatGPT">&#128172; ChatGPT</a>
            <a href="https://www.npmjs.com/package/lokal-mcp" target="_blank" rel="noopener" class="ai-logo" title="Installer lokal-mcp for Claude Desktop">&#128268; Claude MCP</a>
            <a href="https://github.com/slookisen/lokal" target="_blank" rel="noopener" class="ai-logo" title="Se kildekoden p\u00e5 GitHub">\u2B50 GitHub</a>
          </div>
        </div>
      </div>
    </section>`;

    res.send(shell(
      "Rett fra Bonden \u2014 Finn lokalprodusert mat i Norge",
      `S\u00f8k blant ${totalAgents} lokale matprodusenter i Norge. G\u00e5rder, markeder, g\u00e5rdsbutikker med kontaktinfo og \u00e5pningstider.`,
      content,
      { canonical: BASE_URL, jsonLd, extraCss: LANDING_CSS }
    ));
  } catch (err) {
    console.error("SEO / error:", err);
    res.status(500).send("Intern feil");
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
  const q = req.query.q as string;
  if (!q) { res.redirect("/"); return; }

  try {
    const parsed = marketplaceRegistry.parseNaturalQuery(q);
    const heleNorge = req.query.heleNorge === "true";

    // Geocode location from query text (e.g. "honning bergen" → Bergen coords)
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

    // Preserve product terms through Zod parsing
    const productTerms = parsed._productTerms;
    const query = DiscoveryQuerySchema.parse({ ...parsed, limit: 30, offset: 0 });
    if (productTerms) (query as any)._productTerms = productTerms;

    let results = marketplaceRegistry.discover(query);

    // Auto-expanding radius if too few results
    const MIN_RESULTS = 3;
    if (parsed.location && results.length < MIN_RESULTS && !heleNorge) {
      for (const radius of [50, 100, 200]) {
        if (results.length >= MIN_RESULTS) break;
        const expanded = DiscoveryQuerySchema.parse({ ...parsed, maxDistanceKm: radius, limit: 30, offset: 0 });
        if (productTerms) (expanded as any)._productTerms = productTerms;
        results = marketplaceRegistry.discover(expanded);
      }
      if (results.length < MIN_RESULTS) {
        const noGeo = DiscoveryQuerySchema.parse({ ...parsed, location: undefined, maxDistanceKm: undefined, limit: 30, offset: 0 });
        if (productTerms) (noGeo as any)._productTerms = productTerms;
        results = marketplaceRegistry.discover(noGeo);
      }
    }

    const geoFiltered = !!parsed.location && !heleNorge;

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
          autoRespond: true,
        });
      } catch { /* non-critical — don't break search if logging fails */ }
    }

    const resultCards = results.map((r: any) => producerCard(r.agent, r.matchReasons)).join("");

    const heleNorgeLink = geoFiltered
      ? `<a href="/sok?q=${encodeURIComponent(q)}&heleNorge=true" style="display:inline-block;margin-top:12px;padding:7px 18px;background:var(--green-100,#e8f0e0);color:var(--green-700,#2D5016);border:1.5px solid var(--green-700,#2D5016);border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;">&#127758; Vis hele Norge</a>`
      : "";

    const geoNote = geoFiltered
      ? `<p style="color:var(--g500,#666);font-size:0.85rem;margin-top:8px;">Resultater filtrert etter sted. ${heleNorgeLink}</p>`
      : "";

    const content = `
    <section class="search-hero">
      <div class="container">
        <div class="bc" style="padding:0 0 12px;"><a href="/">Hjem</a><span>/</span>S\u00f8k: \u201c${escapeHtml(q)}\u201d</div>
        <h1>S\u00f8keresultater for \u201c${escapeHtml(q)}\u201d \u2014 ${results.length} treff</h1>
        <form class="search-form" action="/sok" method="GET">
          <input type="text" name="q" value="${escapeHtml(q)}" aria-label="S\u00f8k">
          <button type="button" id="geoBtn" style="padding:12px 16px;background:var(--green-100,#e8f0e0);color:var(--green-700,#2D5016);border:2px solid var(--green-700,#2D5016);border-left:none;font-weight:700;font-size:0.85rem;cursor:pointer;white-space:nowrap;">&#128205; N\u00e6r meg</button>
          <button type="submit">S\u00f8k</button>
        </form>
        ${geoNote}
      </div>
    </section>
    <section class="sec">
      ${results.length > 0
        ? `<div class="results-grid">${resultCards}</div>`
        : `<div style="text-align:center;padding:48px 0;color:var(--g500);">
            <p style="font-size:1.1rem;">Ingen resultater for \u201c${escapeHtml(q)}\u201d</p>
            <p style="margin-top:8px;"><a href="/">Pr\u00f8v et annet s\u00f8k</a></p>
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
          window.location.href = '/sok?q=' + encodeURIComponent(q) + '&lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude + '&radius=30';
        }, function() {
          geoBtn.textContent = '\\u274C Avsl\u00e5tt';
          geoBtn.disabled = false;
          setTimeout(function() { geoBtn.innerHTML = '&#128205; N\u00e6r meg'; }, 2000);
        }, { enableHighAccuracy: false, timeout: 8000 });
      });
    })();
    </script>`;

    res.send(shell(
      `${q} \u2014 S\u00f8k i Rett fra Bonden`,
      `S\u00f8keresultater for \u201c${q}\u201d \u2014 finn lokale matprodusenter i Norge.`,
      content,
      { canonical: `${BASE_URL}/sok?q=${encodeURIComponent(q)}`, extraCss: SEARCH_CSS }
    ));
  } catch (err) {
    console.error("SEO /sok error:", err);
    res.status(500).send("Intern feil");
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

router.get("/om", (_req: Request, res: Response) => {
  const content = `
  <section class="om-hero">
    <h1>Maten fortjener \u00e5 bli <em>funnet</em></h1>
    <p>Rett fra Bonden gj\u00f8r lokale matprodusenter synlige \u2014 ikke bare for mennesker, men for AI-assistentene som hjelper dem \u00e5 handle.</p>
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
    <p>Rett fra Bonden er en \u00e5pen katalog som automatisk samler informasjon om lokale matprodusenter \u2014 produkter, \u00e5pningstider, kontaktinfo, sertifiseringer \u2014 og gj\u00f8r alt tilgjengelig via standardprotokoller som AI-systemer forst\u00e5r.</p>
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
        <p>Bygget for norske g\u00e5rder, markeder og mattradisjoner. Oslo f\u00f8rst, hele landet etter.</p>
      </div>
    </div>

    <h2>Visjonen v\u00e5r</h2>
    <p>Vi tror at fremtidens handel handler om synlighet. Den som blir funnet, f\u00e5r kunden. Vi bygger infrastrukturen som gj\u00f8r at lokale produsenter konkurrerer p\u00e5 like vilk\u00e5r med de store kjedene \u2014 i en verden der stadig flere handler gjennom AI.</p>
    <p>Rett fra Bonden er et non-profit initiativ. Koden er \u00e5pen kildekode.</p>
  </section>`;

  res.send(shell(
    "Om Rett fra Bonden \u2014 V\u00e5r historie",
    "Rett fra Bonden gj\u00f8r lokale matprodusenter synlige for AI-assistenter. Les om v\u00e5r misjon og hvorfor vi bygger dette.",
    content,
    { canonical: `${BASE_URL}/om`, extraCss: OM_CSS }
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

router.get("/teknologi", (_req: Request, res: Response) => {
  const stats = marketplaceRegistry.getStats();
  const totalAgents = stats.totalAgents || marketplaceRegistry.getActiveAgents().length;
  const content = `
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
    <p>Rett fra Bonden bruker \u00e5pne standarder som gj\u00f8r at enhver AI-assistent kan finne og forst\u00e5 informasjon om norske matprodusenter:</p>

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
    <p>MCP (Model Context Protocol) lar AI-assistenten din s\u00f8ke direkte i v\u00e5r database med ${totalAgents}+ matprodusenter. Her er hvordan du setter det opp:</p>

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
    "Slik fungerer AI-s\u00f8k \u2014 Rett fra Bonden",
    "Rett fra Bonden bruker A2A, MCP og Schema.org for \u00e5 gj\u00f8re lokale matprodusenter synlige for AI-assistenter.",
    content,
    { canonical: `${BASE_URL}/teknologi`, extraCss: TECH_CSS }
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

router.get("/personvern", (_req: Request, res: Response) => {
  const content = `
  <section class="pv-hero">
    <h1>Personvern</h1>
    <p>Hvordan Rett fra Bonden behandler data \u2014 ærlig og uten fyllord.</p>
  </section>

  <section class="pv-sec">
    <h2>Hvem vi er</h2>
    <p>Rett fra Bonden er en åpen katalog over lokale matprodusenter i Norge, tilgjengelig på rettfrabonden.com. Tjenesten drives som et uavhengig prosjekt. Kontakt: kontakt@rettfrabonden.com.</p>

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
    <p>Når du som matprodusent registrerer deg for å administrere din profil, samler vi inn:</p>
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
    <p>Rett fra Bonden støtter A2A-protokollen (agent-til-agent). Når en AI-agent kontakter en produsent-agent, lagres samtaletekst, status og eventuell transaksjonsinfo i databasen.</p>

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
    <p>For alle henvendelser: <a href="mailto:kontakt@rettfrabonden.com" style="color:var(--green-700);">kontakt@rettfrabonden.com</a></p>

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
    "Personvern \u2014 Rett fra Bonden",
    "Hvordan Rett fra Bonden behandler persondata. Ingen cookies, ingen tredjepartssporing, åpen kildekode.",
    content,
    { canonical: `${BASE_URL}/personvern`, extraCss: PERSONVERN_CSS }
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
      || citySlug === "agents" || citySlug === "docs" || citySlug === "samtaler" || citySlug === "samtale"
      || citySlug.includes(".")) {
    return next();
  }

  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const cityAgents = agents.filter((a: any) => {
      const city = a.city || a.location?.city || "";
      return slugify(city) === citySlug;
    });

    if (cityAgents.length === 0) {
      return res.status(404).send(shell(
        "Fant ingen produsenter", "Ingen produsenter funnet.",
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

    const producerCards = cityAgents.map((a: any) => producerCard(a)).join("");

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
      const item: any = {
        "@context": "https://schema.org", "@type": "LocalBusiness",
        "name": a.name, "description": a.description || "",
        "url": `${BASE_URL}/produsent/${slugify(a.name)}`,
      };
      if (k.address) item.address = { "@type": "PostalAddress", "streetAddress": k.address, "addressLocality": cityName, "addressCountry": "NO" };
      if (k.phone) item.telephone = k.phone;
      if (a.location?.lat && a.location?.lng) item.geo = { "@type": "GeoCoordinates", "latitude": a.location.lat, "longitude": a.location.lng };
      return item;
    });

    const content = `
    <section class="city-hero">
      <div class="container">
        <div class="bc" style="padding:0 0 12px;"><a href="/">Hjem</a><span>/</span>${escapeHtml(cityName)}</div>
        <h1>Lokal mat i ${escapeHtml(cityName)}</h1>
        <p>${cityAgents.length} lokale matprodusenter i ${escapeHtml(cityName)}-omr\u00e5det.</p>
        ${contextPara ? `<p style="margin-top:8px;color:var(--g500);">${escapeHtml(contextPara)}</p>` : ""}
      </div>
    </section>
    <section class="sec">
      <div class="city-grid">${producerCards}</div>
    </section>`;

    res.send(shell(
      `Lokal mat i ${cityName} \u2014 ${cityAgents.length} produsenter`,
      `Finn ${cityAgents.length} lokale matprodusenter i ${cityName}. G\u00e5rder, markeder og g\u00e5rdsbutikker.`,
      content,
      { canonical: `${BASE_URL}/${citySlug}`, jsonLd: jsonLdItems, extraCss: CITY_CSS }
    ));
  } catch (err) {
    console.error(`SEO /${citySlug} error:`, err);
    res.status(500).send("Intern feil");
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
  .pf-desc { font-size: 1rem; color: var(--g700); line-height: 1.7; max-width: 580px; }
  .pf-desc-extra { font-size: 0.9rem; color: var(--g500); line-height: 1.6; max-width: 580px; margin-top: 6px; font-style: italic; }
  .pf-stats { display: flex; gap: 22px; margin-top: 18px; flex-wrap: wrap; }
  .pf-stat { display: flex; align-items: center; gap: 8px; }
  .pf-stat-icon { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.95rem; }
  .pf-stat-icon.t { background: var(--green-100); }
  .pf-stat-icon.r { background: #fef3c7; }
  .pf-stat strong { display: block; font-size: 0.9rem; }
  .pf-stat small { font-size: 0.72rem; color: var(--g500); }
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
`;

router.get("/produsent/:slug", (req: Request, res: Response) => {
  const slug = (req.params.slug as string).toLowerCase();

  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const agent = agents.find((a: any) => slugify(a.name) === slug);

    if (!agent) {
      return res.status(404).send(shell(
        "Produsent ikke funnet", "Denne produsenten finnes ikke.",
        `<div class="sec" style="text-align:center;padding:80px 24px;">
          <h1 style="font-size:1.8rem;margin-bottom:12px;">Produsent ikke funnet</h1>
          <p style="color:var(--g500);"><a href="/">Tilbake til forsiden</a></p>
        </div>`
      ));
    }

    // Track producer page view for analytics dashboard
    const cityName = (agent as any).city || (agent as any).location?.city || "";
    analyticsService.trackAgentView(agent.id, agent.name, cityName, "seo");

    const info = knowledgeService.getAgentInfo(agent.id);
    const k = (info?.knowledge || {}) as any;
    const meta = (info?.meta || {}) as any;
    const trustPct = Math.round((agent.trustScore || 0) * 100);

    // Badges
    const badges: string[] = [];
    if (agent.isVerified) badges.push(`<span class="badge badge-v">&#10003; Verifisert</span>`);
    const certs = k.certifications || [];
    if (certs.some((c: string) => c.toLowerCase().includes("kolog"))) badges.push(`<span class="badge badge-o">&#127793; \u00d8kologisk</span>`);
    (agent.categories || []).slice(0, 3).forEach((c: string) => badges.push(`<span class="badge badge-c">${escapeHtml(formatCat(c))}</span>`));

    // Contact items
    const contactItems: string[] = [];
    if (k.address) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#128205;</div><div><div class="ct-label">Adresse</div><div class="ct-val">${escapeHtml(k.address)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</div></div></div>`);
    if (k.phone) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#128222;</div><div><div class="ct-label">Telefon</div><div class="ct-val"><a href="tel:${k.phone.replace(/\s+/g, "")}">${escapeHtml(k.phone)}</a></div></div></div>`);
    if (k.email) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#9993;</div><div><div class="ct-label">E-post</div><div class="ct-val"><a href="mailto:${k.email}">${escapeHtml(k.email)}</a></div></div></div>`);
    if (k.website) contactItems.push(`<div class="ct-item"><div class="ct-icon">&#127760;</div><div><div class="ct-label">Nettside</div><div class="ct-val"><a href="${escapeHtml(k.website)}" target="_blank" rel="noopener">${escapeHtml(k.website.replace(/^https?:\/\//, ""))}</a></div></div></div>`);

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

    // Languages
    const agentLangs: string[] = info?.agent?.languages || ["no"];
    const langMap: Record<string, string> = { no: "Norsk", en: "English", se: "Samisk", de: "Deutsch", pl: "Polski", sv: "Svenska", da: "Dansk" };
    const langsHtml = agentLangs.length > 1 || (agentLangs.length === 1 && agentLangs[0] !== "no")
      ? `<div class="lang-row">${agentLangs.map(l => `<span class="lang-tag">${escapeHtml(langMap[l] || l)}</span>`).join("")}</div>`
      : "";

    // External links (social media etc.)
    const linksList = Array.isArray(k.externalLinks) ? k.externalLinks : [];
    const linksHtml = linksList.length
      ? linksList.map((l: any) => {
          const icon = l.type === "social" && l.label?.toLowerCase().includes("facebook") ? "&#128101;"
            : l.type === "social" && l.label?.toLowerCase().includes("instagram") ? "&#128247;"
            : l.type === "maps" ? "&#128506;"
            : l.type === "shop" ? "&#128722;"
            : "&#128279;";
          return `<a href="${escapeHtml(l.url)}" class="ext-link" target="_blank" rel="noopener">${icon} ${escapeHtml(l.label || "Lenke")}</a>`;
        }).join("")
      : "";

    // Schema.org JSON-LD — Rich LocalBusiness structured data for Google Rich Results
    const jsonLd: any = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "@id": `${BASE_URL}/produsent/${slug}#business`,
      "name": agent.name,
      "description": agent.description || k.about || `Lokal matprodusent i ${cityName || "Norge"}`,
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
    if (k.phone) jsonLd.telephone = k.phone;
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
          "offers": {
            "@type": "Offer",
            "price": parseFloat(numericPrice),
            "priceCurrency": "NOK",
            "availability": "https://schema.org/InStock",
            "seller": { "@type": "LocalBusiness", "name": agent.name },
          },
        };

        // Add image if producer has one (Google requires image for merchant listings)
        if (imagesList.length) {
          product.image = imagesList[0];
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

    // Payment methods
    if ((k.paymentMethods || []).length) {
      jsonLd.paymentAccepted = (k.paymentMethods as string[]).join(", ");
    }

    // Categories as additionalType
    if ((agent.categories || []).length) {
      jsonLd.additionalType = (agent.categories as string[]).map((c: string) => formatCat(c)).join(", ");
    }

    // A2A protocol versioning (custom extension in JSON-LD)
    const agentInfo = info?.agent as any;
    if (agentInfo?.schemaVersion || agentInfo?.agentVersion) {
      jsonLd["x-a2a"] = {
        "schemaVersion": agentInfo?.schemaVersion || "urn:a2a:1.0",
        "agentVersion": agentInfo?.agentVersion || 1,
      };
    }

    const content = `
    <div class="bc"><a href="/">Hjem</a>${cityName ? `<span>/</span><a href="/${slugify(cityName)}">${escapeHtml(cityName)}</a>` : ""}<span>/</span>${escapeHtml(agent.name)}</div>

    <div class="pf-header">
      <div class="pf-hero">
        <div class="pf-badges">${badges.join("")}</div>
        <h1 class="pf-name">${escapeHtml(agent.name)}</h1>
        ${cityName ? `<div class="pf-loc">&#128205; ${escapeHtml(k.address || cityName)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</div>` : ""}
        ${(() => {
          const desc = agent.description || "";
          const about = k.about || "";
          if (!desc && !about) return "";
          // If only one exists, use it
          if (!desc) return `<p class="pf-desc">${escapeHtml(about)}</p>`;
          if (!about) return `<p class="pf-desc">${escapeHtml(desc)}</p>`;
          // If they're the same text, just show one
          if (desc === about || about.length < 20) return `<p class="pf-desc">${escapeHtml(desc)}</p>`;
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
        <div class="pf-stats">
          <div class="pf-stat"><div class="pf-stat-icon t">&#9733;</div><div><strong>${trustPct}%</strong><small>Trust Score</small></div></div>
          ${k.googleRating ? `<div class="pf-stat"><div class="pf-stat-icon r">&#11088;</div><div><strong>${k.googleRating} / 5</strong><small>${k.googleReviewCount || 0} anmeldelser</small></div></div>` : ""}
        </div>
      </div>

      <div class="ct-card">
        <h3>Kontaktinformasjon</h3>
        ${contactItems.join("") || `<p style="color:var(--g500);font-size:0.88rem;">Ingen kontaktinfo tilgjengelig enn\u00e5.</p>`}
        <div class="ct-actions">
          ${k.website ? `<a href="${escapeHtml(k.website)}" class="btn-p" target="_blank" rel="noopener">&#127760; Bes\u00f8k nettside</a>` : ""}
          <a href="${mapsUrl}" class="btn-s" target="_blank" rel="noopener">&#128506; Vis p\u00e5 kart</a>
          <a href="${BASE_URL}/api/marketplace/agents/${agent.id}/vcard" class="btn-s">&#128195; Last ned kontaktkort</a>
        </div>
      </div>
    </div>

    <div class="pf-content">
      <div class="pf-main">
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
          <div class="card-head"><span>&#127942;</span><h3>Sertifiseringer</h3></div>
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
          <div class="card-head"><span>&#128172;</span><h3>Kundeanmeldelser</h3></div>
          <div class="card-body"><div class="reviews-grid">${reviewsHtml}</div></div>
        </div>` : ""}

        <div class="claim-bar">
          <div>
            <h3>${agent.isVerified ? "Jobber du ogs\u00e5 her?" : "Er du eieren av " + escapeHtml(agent.name) + "?"}</h3>
            <p>${agent.isVerified ? "Flere personer kan administrere denne profilen." : "Gj\u00f8r krav p\u00e5 profilen for \u00e5 oppdatere informasjon og bli synlig for flere."}</p>
          </div>
          <a href="/selger" class="claim-btn">${agent.isVerified ? "F\u00e5 tilgang" : "Gj\u00f8r krav"}</a>
        </div>

        <div class="data-src">
          <span class="data-dot ${(!k.dataSource || k.dataSource === "auto") ? "auto" : "owner"}"></span>
          ${(!k.dataSource || k.dataSource === "auto") ? "Automatisk innhentet data" : k.dataSource === "hybrid" ? "Verifisert av eier" : "Eierstyrt"}${k.lastEnrichedAt ? ` \u2014 Sist oppdatert ${new Date(k.lastEnrichedAt).toLocaleDateString("nb-NO")}` : ""}
        </div>

        ${meta.disclaimer ? `<p style="margin-top:8px;font-size:0.75rem;color:var(--g500);">${escapeHtml(meta.disclaimer)}</p>` : ""}
      </div>

      <div>
        ${related.length > 0 ? `
        <div class="card">
          <div class="card-head"><span>&#127793;</span><h3>Andre i ${escapeHtml(cityName)}</h3></div>
          <div class="card-body"><div class="rel-grid">${relatedHtml}</div></div>
        </div>` : ""}
      </div>
    </div>`;

    res.send(shell(
      `${agent.name} \u2014 Lokal mat${cityName ? ` i ${cityName}` : ""}`,
      `${agent.name}${cityName ? ` i ${cityName}` : ""}. ${agent.description || "Lokalprodusert mat i Norge."}`,
      content,
      { canonical: `${BASE_URL}/produsent/${slug}`, jsonLd, extraCss: PROFILE_CSS }
    ));
  } catch (err) {
    console.error(`SEO /produsent/${slug} error:`, err);
    res.status(500).send("Intern feil");
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

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${today}</lastmod></url>
  <url><loc>${BASE_URL}/om</loc><changefreq>monthly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>
  <url><loc>${BASE_URL}/teknologi</loc><changefreq>monthly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>
  <url><loc>${BASE_URL}/personvern</loc><changefreq>monthly</changefreq><priority>0.5</priority><lastmod>${today}</lastmod></url>`;

    for (const city of cities) {
      xml += `\n  <url><loc>${BASE_URL}/${city}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${today}</lastmod></url>`;
    }
    for (const a of agents) {
      xml += `\n  <url><loc>${BASE_URL}/produsent/${slugify(a.name)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${today}</lastmod></url>`;
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

export default router;

/**
 * experiences-seo.ts — Host-gated AI-discovery surfaces for Opplevagent (opplevagent.no)
 *
 * orchestrator-pr-19: minimal-landing + discovery documents for the
 * experiences vertical. Mirrors the discovery half of dental-seo.ts but is
 * intentionally minimal — the product is the AI-discovery surfaces, not a
 * full SSR catalogue (that can follow later).
 *
 * Serves, on the opplevagent.no host ONLY:
 *   GET /                              minimal landing (Opplevagent, NOT rfb)
 *   GET /llms.txt                      LLM-friendly overview (Norwegian)
 *   GET /robots.txt                    crawler policy
 *   GET /sitemap.xml                   sitemap
 *   GET /.well-known/agents.txt        IETF agent discovery
 *   GET /agents.txt                    root alias
 *   GET /.well-known/agent-card.json   A2A Agent Card (Opplevagent)
 *   GET /agent-card.json               alias
 *   GET /openapi.json                  OpenAPI 3.1 spec
 *   *                                  Norwegian 404 (no rfb/dental content leaks)
 *
 * HOST ISOLATION: this router serves ONLY the experiences card / surfaces.
 * It is mounted exclusively behind the opplevagent.no host gate in
 * src/index.ts, so rettfrabonden.com and finn-tannlege.com never reach it.
 */

import { Router, Request, Response } from "express";
import { getExperiencesAgentCard } from "../services/experiences-agent-card";
import { getExperiencesOpenapi } from "../services/experiences-openapi";
import { listCategories } from "../services/experience-store";

const router = Router();

const OPPLEVAGENT_BASE_URL =
  process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no";

function baseUrl(): string {
  return OPPLEVAGENT_BASE_URL.replace(/\/$/, "");
}

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Categories are read lazily + defensively — if the experiences DB isn't
// open (flag off in some context) we just render the landing without them.
function safeCategories(): Array<{ category: string; count: number }> {
  try {
    return listCategories();
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// GET / — minimal landing (Opplevagent, NOT the rfb homepage)
// ═══════════════════════════════════════════════════════════

router.get("/", (_req: Request, res: Response) => {
  const url = baseUrl();
  const year = new Date().getFullYear();

  // Categories are read defensively — the page must render perfectly with 0
  // categories (DB not open / no data yet). When empty we show a tasteful set
  // of example categories so the grid never looks broken pre-data.
  const cats = safeCategories();
  const fallbackCats: Array<{ category: string; count: number }> = [
    { category: "Natur & friluft", count: 0 },
    { category: "Mat & drikke", count: 0 },
    { category: "På vannet", count: 0 },
    { category: "Vinter", count: 0 },
    { category: "Kultur", count: 0 },
    { category: "Familievennlig", count: 0 },
  ];
  const usingFallbackCats = cats.length === 0;
  const catSource = usingFallbackCats ? fallbackCats : cats.slice(0, 12);

  // A small inline SVG glyph per category keeps the grid alive without any
  // external image files. Falls back to a generic compass for unknown labels.
  const catGlyph = (label: string): string => {
    const l = label.toLowerCase();
    if (/(vann|safari|hval|kajakk|fjord|båt|seil|dykk|fiske)/.test(l)) return "wave";
    if (/(mat|drikke|smak|øl|vin|gård|food)/.test(l)) return "cup";
    if (/(vinter|ski|snø|aking|skøyte)/.test(l)) return "snow";
    if (/(kultur|museum|kunst|historie|teater)/.test(l)) return "frame";
    if (/(familie|barn|lek|park|laser)/.test(l)) return "spark";
    if (/(natur|friluft|fjell|tur|hike|vandr|klatr)/.test(l)) return "peak";
    return "compass";
  };
  const GLYPHS: Record<string, string> = {
    peak: '<path d="M3 18 L9 7 L13 13 L16 9 L21 18 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    wave: '<path d="M3 9 Q6 6 9 9 T15 9 T21 9 M3 14 Q6 11 9 14 T15 14 T21 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    cup: '<path d="M6 4 H16 V11 A5 5 0 0 1 6 11 Z M16 6 H18.5 A2 2 0 0 1 18.5 10 H16 M5 20 H17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
    snow: '<path d="M12 3 V21 M4.5 7.5 L19.5 16.5 M19.5 7.5 L4.5 16.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    frame: '<rect x="4" y="5" width="16" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 15 L9 10 L13 14 L16 11 L20 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    spark: '<path d="M12 3 L14 10 L21 12 L14 14 L12 21 L10 14 L3 12 L10 10 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    compass: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15.5 8.5 L11 11 L8.5 15.5 L13 13 Z" fill="currentColor"/>',
  };
  const catIcon = (label: string): string =>
    `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">${GLYPHS[catGlyph(label)]}</svg>`;

  const catCards = catSource
    .map((c) => {
      const count =
        !usingFallbackCats && Number.isFinite(c.count) && c.count > 0
          ? `<span class="cat-count">${c.count} opplevelser</span>`
          : `<span class="cat-count cat-count-soon">Kommer snart</span>`;
      const href = usingFallbackCats
        ? `/api/opplevelser/discover`
        : `/api/opplevelser/discover?category=${encodeURIComponent(c.category)}`;
      return `<a class="cat-card" href="${href}">
        <span class="cat-ico" aria-hidden="true">${catIcon(c.category)}</span>
        <span class="cat-body">
          <span class="cat-name">${escapeHtml(c.category)}</span>
          ${count}
        </span>
      </a>`;
    })
    .join("");

  const catNote = usingFallbackCats
    ? `<p class="cat-note">Eksempelkategorier &mdash; live opplevelser publiseres fortløpende.</p>`
    : "";

  // JSON-LD: WebSite (+ SearchAction wired to the discovery API) and
  // Organization, so search engines and agents understand the site shape.
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Opplevagent",
      url: url,
      description:
        "Kuratert markedsplass for norske opplevelser og aktiviteter — bygget for å bli oppdaget og spurt av AI-agenter.",
      inLanguage: "nb-NO",
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${url}/api/opplevelser/discover?fylke={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Opplevagent",
      url: url,
      description:
        "A2A-markedsplass for norske opplevelser og aktiviteter. Tilbydere verifiseres mot Brønnøysundregistrene.",
      logo: `${url}/favicon.svg`,
    },
  ];
  const ldScripts = jsonLd
    .map(
      (ld) =>
        `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, "<\\/")}</script>`
    )
    .join("\n");

  const desc =
    "Opplevagent er en kuratert markedsplass for norske opplevelser og aktiviteter — hvalsafari, trehytter, guidede turer, mat og mer. Søkbar for AI-agenter etter sted, vær, sesong og gruppestørrelse.";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opplevagent — Kuratert markedsplass for norske opplevelser</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#0b3d2e">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="Opplevagent — norske opplevelser, søkbart for AI-agenter">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${url}/favicon.svg">
<meta property="og:image:alt" content="Opplevagent — markedsplass for norske opplevelser">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Opplevagent">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${url}/favicon.svg">
${ldScripts}
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --fjord-900:#072a20;--fjord-800:#0b3d2e;--fjord-700:#0f5132;--fjord-600:#147a4d;
    --teal-500:#14b8a6;--teal-400:#2dd4bf;
    --amber-500:#f59e0b;--amber-400:#fbbf24;--coral-500:#ff7a45;
    --ink:#10231b;--ink-soft:#3c5249;--mist:#6b8178;
    --surface:#ffffff;--canvas:#f4f8f4;--canvas-2:#eaf2ec;--line:#dde9e0;
    --r-sm:8px;--r-md:14px;--r-lg:22px;--r-pill:999px;
    --sh-sm:0 1px 2px rgba(7,42,32,.06),0 2px 6px rgba(7,42,32,.05);
    --sh-md:0 6px 18px rgba(7,42,32,.10);
    --sh-lg:0 18px 48px rgba(7,42,32,.22);
    --maxw:1120px;
  }
  html{scroll-behavior:smooth}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--canvas);line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  a{color:var(--fjord-600);text-decoration:none}
  a:hover{text-decoration:underline}
  :focus-visible{outline:3px solid var(--amber-500);outline-offset:2px;border-radius:4px}
  img,svg{display:block;max-width:100%}
  .container{max-width:var(--maxw);margin:0 auto;padding:0 24px}
  @media(max-width:560px){.container{padding:0 16px}}
  .skip-link{position:absolute;left:-9999px;top:0;background:var(--fjord-800);color:#fff;padding:10px 16px;border-radius:0 0 var(--r-sm) 0;z-index:200}
  .skip-link:focus{left:0;text-decoration:none}

  /* ── HEADER / NAV ── */
  .site-nav{position:sticky;top:0;z-index:100;background:rgba(244,248,244,.86);backdrop-filter:saturate(160%) blur(12px);border-bottom:1px solid var(--line)}
  .nav-inner{max-width:var(--maxw);margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
  @media(max-width:560px){.nav-inner{padding:0 16px}}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.16rem;letter-spacing:-.02em;color:var(--fjord-800);text-decoration:none}
  .brand:hover{text-decoration:none}
  .brand .mark{width:34px;height:34px;flex:0 0 34px;border-radius:10px;background:linear-gradient(150deg,var(--fjord-700),var(--teal-500));display:flex;align-items:center;justify-content:center;box-shadow:var(--sh-sm)}
  .brand .mark svg{color:#fff}
  .nav-links{display:flex;gap:26px;align-items:center}
  .nav-links a{font-size:.88rem;font-weight:600;color:var(--ink-soft)}
  .nav-links a:hover{color:var(--fjord-700)}
  .nav-cta{padding:8px 16px;border-radius:var(--r-pill);background:var(--fjord-800);color:#fff!important;font-size:.84rem;font-weight:700}
  .nav-cta:hover{background:var(--fjord-700);text-decoration:none!important}
  @media(max-width:760px){.nav-links a:not(.nav-cta){display:none}}

  /* ── HERO ── */
  .hero{position:relative;overflow:hidden;color:#fff;background:linear-gradient(135deg,#072a20 0%,#0f5132 38%,#147a4d 60%,#1f9e6b 78%,#f59e0b 130%)}
  .hero::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 18% 8%,rgba(45,212,191,.30),transparent 55%),radial-gradient(90% 80% at 92% 18%,rgba(245,158,11,.28),transparent 60%);pointer-events:none}
  .hero-range{position:absolute;left:0;right:0;bottom:-1px;height:140px;opacity:.55;pointer-events:none}
  .hero-inner{position:relative;max-width:920px;margin:0 auto;padding:84px 24px 104px;text-align:center;z-index:1}
  @media(max-width:560px){.hero-inner{padding:60px 16px 96px}}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:var(--r-pill);background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);font-size:.78rem;font-weight:600;letter-spacing:.02em;margin-bottom:22px;backdrop-filter:blur(4px)}
  .eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--amber-400);box-shadow:0 0 0 4px rgba(251,191,36,.25)}
  .hero h1{font-size:clamp(2rem,5.2vw,3.4rem);font-weight:800;letter-spacing:-.035em;line-height:1.08;margin-bottom:18px;text-shadow:0 2px 30px rgba(7,42,32,.25)}
  .hero h1 .accent{background:linear-gradient(100deg,var(--amber-400),var(--coral-500));-webkit-background-clip:text;background-clip:text;color:transparent}
  .hero-sub{font-size:clamp(1.02rem,2.1vw,1.22rem);max-width:620px;margin:0 auto 34px;color:rgba(255,255,255,.92)}

  /* discovery prompt */
  .discover{max-width:640px;margin:0 auto}
  .discover-form{display:flex;gap:0;background:#fff;border-radius:var(--r-pill);padding:7px 7px 7px 8px;box-shadow:var(--sh-lg);align-items:center}
  .discover-form .field{display:flex;align-items:center;gap:10px;flex:1;padding-left:12px;min-width:0}
  .discover-form .field svg{color:var(--mist);flex:0 0 20px}
  .discover-form input{flex:1;border:none;outline:none;font-size:1.02rem;color:var(--ink);background:transparent;padding:14px 4px;min-width:0}
  .discover-form input::placeholder{color:#90a399}
  .discover-form button{flex:0 0 auto;border:none;cursor:pointer;background:linear-gradient(135deg,var(--amber-500),var(--coral-500));color:#fff;font-weight:800;font-size:.96rem;padding:14px 26px;border-radius:var(--r-pill);box-shadow:0 4px 14px rgba(245,158,11,.4);transition:transform .12s ease,box-shadow .12s ease}
  .discover-form button:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(245,158,11,.5)}
  .discover-form button:active{transform:translateY(0)}
  @media(max-width:520px){
    .discover-form{flex-direction:column;border-radius:var(--r-lg);padding:10px;gap:8px;align-items:stretch}
    .discover-form .field{padding:6px 10px;background:var(--canvas);border-radius:var(--r-md)}
    .discover-form input{padding:12px 4px}
    .discover-form button{width:100%;padding:14px}
  }
  .discover-hint{margin-top:16px;font-size:.85rem;color:rgba(255,255,255,.82)}
  .discover-hint code{background:rgba(255,255,255,.16);padding:2px 7px;border-radius:6px;font-size:.82em}
  .quick{margin-top:22px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
  .quick a{display:inline-flex;align-items:center;gap:6px;padding:7px 15px;border-radius:var(--r-pill);background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);color:#fff;font-size:.82rem;font-weight:600;backdrop-filter:blur(4px)}
  .quick a:hover{background:rgba(255,255,255,.26);text-decoration:none}

  /* ── TRUST STRIP ── */
  .trust{background:var(--fjord-900);color:rgba(255,255,255,.92)}
  .trust-inner{max-width:var(--maxw);margin:0 auto;padding:18px 24px;display:flex;flex-wrap:wrap;gap:14px 28px;align-items:center;justify-content:center;font-size:.86rem}
  @media(max-width:560px){.trust-inner{padding:16px}}
  .trust-item{display:inline-flex;align-items:center;gap:9px;font-weight:600}
  .trust-item svg{color:var(--teal-400);flex:0 0 18px}
  .trust-sep{width:1px;height:18px;background:rgba(255,255,255,.18)}
  @media(max-width:640px){.trust-sep{display:none}}

  /* ── SECTIONS ── */
  main{display:block}
  .section{padding:72px 0}
  @media(max-width:560px){.section{padding:52px 0}}
  .section-alt{background:var(--surface);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .sec-head{max-width:680px;margin-bottom:36px}
  .sec-head.center{margin-left:auto;margin-right:auto;text-align:center}
  .kicker{display:inline-block;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--fjord-600);margin-bottom:10px}
  .sec-head h2{font-size:clamp(1.5rem,3.2vw,2.1rem);font-weight:800;letter-spacing:-.025em;color:var(--ink);line-height:1.15}
  .sec-head p{margin-top:12px;color:var(--ink-soft);font-size:1.02rem}

  /* category grid */
  .cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
  .cat-card{display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:18px 18px;box-shadow:var(--sh-sm);transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
  .section-alt .cat-card{background:var(--canvas)}
  .cat-card:hover{transform:translateY(-3px);box-shadow:var(--sh-md);border-color:var(--teal-400);text-decoration:none}
  .cat-ico{flex:0 0 50px;width:50px;height:50px;border-radius:13px;display:flex;align-items:center;justify-content:center;color:var(--fjord-700);background:linear-gradient(150deg,var(--canvas-2),#dff0e6)}
  .cat-body{display:flex;flex-direction:column;gap:3px;min-width:0}
  .cat-name{font-weight:700;color:var(--ink);font-size:1rem;letter-spacing:-.01em}
  .cat-count{font-size:.82rem;color:var(--mist)}
  .cat-count-soon{color:var(--amber-500);font-weight:600}
  .cat-note{margin-top:20px;font-size:.88rem;color:var(--mist)}

  /* how it works */
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;counter-reset:step}
  @media(max-width:820px){.steps{grid-template-columns:1fr}}
  .step{position:relative;background:var(--canvas);border:1px solid var(--line);border-radius:var(--r-lg);padding:30px 26px;overflow:hidden}
  .section-alt .step{background:var(--surface)}
  .step::after{content:"";position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,var(--fjord-600),var(--teal-500),var(--amber-500))}
  .step-num{width:42px;height:42px;border-radius:12px;background:linear-gradient(150deg,var(--fjord-800),var(--fjord-600));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.05rem;margin-bottom:16px;box-shadow:var(--sh-sm)}
  .step h3{font-size:1.1rem;font-weight:700;color:var(--ink);margin-bottom:8px;letter-spacing:-.01em}
  .step p{font-size:.93rem;color:var(--ink-soft);line-height:1.55}
  .step .src{margin-top:12px;font-size:.82rem;color:var(--mist)}
  .step strong{color:var(--fjord-700)}

  /* agents callout */
  .agents{position:relative;overflow:hidden;background:linear-gradient(140deg,#082c21,#0f5132 70%,#146a45);color:#fff;border-radius:var(--r-lg);padding:44px 40px;box-shadow:var(--sh-md)}
  .agents::before{content:"";position:absolute;inset:0;background:radial-gradient(80% 120% at 100% 0%,rgba(45,212,191,.22),transparent 55%);pointer-events:none}
  .agents-grid{position:relative;display:grid;grid-template-columns:1.05fr 1fr;gap:34px;align-items:center}
  @media(max-width:820px){.agents{padding:32px 24px}.agents-grid{grid-template-columns:1fr;gap:24px}}
  .agents h2{font-size:clamp(1.45rem,3vw,2rem);font-weight:800;letter-spacing:-.02em;margin-bottom:12px}
  .agents p{color:rgba(255,255,255,.9);font-size:1rem;margin-bottom:20px;max-width:46ch}
  .agents .endpoints{list-style:none;display:flex;flex-wrap:wrap;gap:10px}
  .agents .endpoints a{display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:var(--r-pill);background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);color:#fff;font-size:.84rem;font-weight:600;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
  .agents .endpoints a:hover{background:rgba(255,255,255,.24);text-decoration:none}
  .agents .endpoints a svg{color:var(--teal-400);flex:0 0 15px}
  .code-card{background:rgba(4,22,16,.55);border:1px solid rgba(255,255,255,.16);border-radius:var(--r-md);padding:18px 20px;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:.84rem;line-height:1.7;overflow-x:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
  .code-card .c-label{font-family:inherit;color:var(--teal-400);font-size:.74rem;letter-spacing:.06em;text-transform:uppercase;display:block;margin-bottom:8px}
  .code-card .mtd{color:var(--amber-400);font-weight:700}
  .code-card .pth{color:#fff}
  .code-card .prm{color:#9fe9d4}
  .code-card .cmt{color:rgba(255,255,255,.5)}

  /* ── FOOTER ── */
  .site-footer{background:var(--fjord-900);color:rgba(255,255,255,.66);padding:54px 0 30px;margin-top:0}
  .footer-grid{max-width:var(--maxw);margin:0 auto;padding:0 24px;display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:34px}
  @media(max-width:760px){.footer-grid{grid-template-columns:1fr 1fr;gap:28px}}
  @media(max-width:480px){.footer-grid{grid-template-columns:1fr}}
  .footer-brand .brand{color:#fff;margin-bottom:12px}
  .footer-brand p{font-size:.88rem;color:rgba(255,255,255,.6);max-width:34ch}
  .footer-col h4{color:#fff;font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px}
  .footer-col a{display:block;color:rgba(255,255,255,.62);font-size:.88rem;margin-bottom:9px}
  .footer-col a:hover{color:#fff}
  .footer-col a code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}
  .footer-bottom{max-width:var(--maxw);margin:34px auto 0;padding:18px 24px 0;border-top:1px solid rgba(255,255,255,.12);font-size:.8rem;color:rgba(255,255,255,.46);display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;justify-content:space-between}
  .footer-bottom .verified{display:inline-flex;align-items:center;gap:7px}
  .footer-bottom .verified svg{color:var(--teal-400);flex:0 0 15px}
</style>
</head>
<body>
<a class="skip-link" href="#hovedinnhold">Hopp til hovedinnhold</a>

<header class="site-nav">
  <div class="nav-inner">
    <a class="brand" href="/" aria-label="Opplevagent forside">
      <span class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M2 19 L8.5 7 L13 14.5 L16 10 L22 19 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="18" cy="6" r="2.4" fill="currentColor"/></svg>
      </span>
      Opplevagent
    </a>
    <nav class="nav-links" aria-label="Hovednavigasjon">
      <a href="#kategorier">Kategorier</a>
      <a href="#slik-funker-det">Slik funker det</a>
      <a href="#for-agenter">For AI-agenter</a>
      <a class="nav-cta" href="/api/opplevelser/discover">Discovery-API</a>
    </nav>
  </div>
</header>

<main id="hovedinnhold">
  <section class="hero" aria-labelledby="hero-title">
    <svg class="hero-range" viewBox="0 0 1440 140" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 140 L0 96 L150 40 L300 92 L470 24 L640 88 L820 36 L1010 96 L1200 48 L1340 90 L1440 60 L1440 140 Z" fill="rgba(7,42,32,.45)"/>
      <path d="M0 140 L0 116 L210 72 L420 112 L640 70 L900 118 L1150 82 L1440 110 L1440 140 Z" fill="rgba(7,42,32,.65)"/>
    </svg>
    <div class="hero-inner">
      <span class="eyebrow"><span class="dot"></span> A2A-markedsplass for norske opplevelser</span>
      <h1 id="hero-title">Hva kan vi finne på <span class="accent">i dag?</span></h1>
      <p class="hero-sub">Fra hvalsafari og trehytter til guidede fjellturer, matopplevelser og lasertag &mdash; en kuratert oversikt over norske opplevelser, bygget for å bli oppdaget og spurt av AI-agenter.</p>

      <div class="discover">
        <form class="discover-form" action="/api/opplevelser/discover" method="GET" role="search" aria-label="Finn opplevelser" id="discover-form">
          <span class="field">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5 L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <label for="discover-q" class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Beskriv hva du vil finne på, eller skriv et sted</label>
            <input id="discover-q" name="fylke" type="search" autocomplete="off" placeholder="Hva kan vi finne på i Oslo når det regner?">
          </span>
          <button type="submit">Finn opplevelser</button>
        </form>
        <p class="discover-hint">Søk på fylke, eller still spørsmål &mdash; agenter kan også kalle <code>GET /api/opplevelser/discover</code> direkte.</p>
        <div class="quick" role="list" aria-label="Hurtigsøk">
          <a role="listitem" href="/api/opplevelser/discover?fylke=Oslo&amp;weather=rain">Oslo i regnvær</a>
          <a role="listitem" href="/api/opplevelser/discover?fylke=Troms&amp;season=winter">Troms om vinteren</a>
          <a role="listitem" href="/api/opplevelser/discover?indoor_outdoor=outdoor">Ute i naturen</a>
          <a role="listitem" href="/api/opplevelser/discover?group_size=8">For gjengen (8 stk)</a>
        </div>
      </div>
    </div>
  </section>

  <div class="trust" aria-label="Tillit og datakilder">
    <div class="trust-inner">
      <span class="trust-item"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12 L11 14.5 L15.5 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Tilbydere verifisert mot Brønnøysundregistrene</span>
      <span class="trust-sep" aria-hidden="true"></span>
      <span class="trust-item"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7 V12 L15.5 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Innhold oppdatert fortløpende</span>
      <span class="trust-sep" aria-hidden="true"></span>
      <span class="trust-item"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 9 H21 M8 14 H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Maskinlesbar for AI-agenter</span>
    </div>
  </div>

  <section class="section" id="kategorier" aria-labelledby="kat-title">
    <div class="container">
      <div class="sec-head">
        <span class="kicker">Utforsk</span>
        <h2 id="kat-title">Opplevelser etter kategori</h2>
        <p>Bla i kuraterte kategorier &mdash; eller la en AI-agent filtrere på vær, sesong, pris og gruppestørrelse for deg.</p>
      </div>
      <div class="cat-grid" role="list" aria-label="Kategorier">
        ${catCards}
      </div>
      ${catNote}
    </div>
  </section>

  <section class="section section-alt" id="slik-funker-det" aria-labelledby="slik-title">
    <div class="container">
      <div class="sec-head center">
        <span class="kicker">Tillitsmodell</span>
        <h2 id="slik-title">Slik funker det</h2>
        <p>Kuratert, verifisert og beriket &mdash; tre steg som skiller Opplevagent fra en vanlig oppføringsliste.</p>
      </div>
      <div class="steps">
        <div class="step">
          <div class="step-num" aria-hidden="true">1</div>
          <h3>Kuratert innhenting</h3>
          <p>Opplevelser høstes fortløpende fra kuraterte kilder &mdash; ikke et åpent annonsemarked, men et utvalg av reelle norske tilbydere.</p>
          <p class="src">Kilde: <strong>kuraterte tilbyderkilder</strong></p>
        </div>
        <div class="step">
          <div class="step-num" aria-hidden="true">2</div>
          <h3>Verifisert tilbyder</h3>
          <p>Hver tilbyder kontrolleres mot Brønnøysundregistrene for å bekrefte at det står et <strong>aktivt selskap</strong> bak opplevelsen.</p>
          <p class="src">Kilde: <strong>Brønnøysundregistrene (Brreg)</strong></p>
        </div>
        <div class="step">
          <div class="step-num" aria-hidden="true">3</div>
          <h3>Beriket innhold</h3>
          <p>Detaljer berikes fra tilbyderens egen nettside, slik at beskrivelser, varighet og praktisk info blir presise og oppdaterte.</p>
          <p class="src">Kilde: <strong>tilbyderens egen side</strong></p>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="for-agenter" aria-labelledby="agent-title">
    <div class="container">
      <div class="agents">
        <div class="agents-grid">
          <div>
            <span class="kicker" style="color:var(--teal-400)">For AI-agenter</span>
            <h2 id="agent-title">Bygget for å bli spurt av agenter</h2>
            <p>Opplevagent eksponerer åpne, maskinlesbare flater etter A2A-protokollen. Agenter kan oppdage tilbudet, lese kontrakten og kjøre intent-søk &mdash; uten skraping.</p>
            <ul class="endpoints" aria-label="Endepunkter for agenter">
              <li><a href="/.well-known/agent-card.json"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8 H16 M8 12 H16 M8 16 H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Agent Card</a></li>
              <li><a href="/mcp"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12 H16 M12 8 V16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> MCP</a></li>
              <li><a href="/openapi.json"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12 H21 M12 3 C15 6 15 18 12 21 C9 18 9 6 12 3" fill="none" stroke="currentColor" stroke-width="2"/></svg> OpenAPI 3.1</a></li>
              <li><a href="/llms.txt"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 3 H14 L19 8 V21 H6 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3 V8 H19" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg> llms.txt</a></li>
              <li><a href="/.well-known/agents.txt"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 20 C3.5 16 6 14 9 14 C12 14 14.5 16 14.5 20 M16 12 L18 14 L22 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> agents.txt</a></li>
            </ul>
          </div>
          <div class="code-card" aria-label="Eksempler på agent-kall">
            <span class="c-label">A2A JSON-RPC</span>
            <div><span class="mtd">POST</span> <span class="pth">/a2a</span></div>
            <div class="cmt"># message/send &mdash; naturlig språk</div>
            <div class="cmt">«hva kan vi finne på i Tromsø i vinter?»</div>
            <div style="height:14px"></div>
            <span class="c-label">REST discovery</span>
            <div><span class="mtd">GET</span> <span class="pth">/api/opplevelser/discover</span></div>
            <div><span class="pth">&nbsp;&nbsp;?</span><span class="prm">fylke</span>=Oslo<span class="cmt">&amp;</span><span class="prm">weather</span>=rain</div>
            <div><span class="pth">&nbsp;&nbsp;&amp;</span><span class="prm">season</span>=summer<span class="cmt">&amp;</span><span class="prm">group_size</span>=4</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</main>

<footer class="site-footer" role="contentinfo">
  <div class="footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="Opplevagent forside">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M2 19 L8.5 7 L13 14.5 L16 10 L22 19 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="18" cy="6" r="2.4" fill="currentColor"/></svg>
        </span>
        Opplevagent
      </a>
      <p>Kuratert markedsplass for norske opplevelser og aktiviteter &mdash; søkbar for mennesker og AI-agenter.</p>
    </div>
    <div class="footer-col">
      <h4>Utforsk</h4>
      <a href="#kategorier">Kategorier</a>
      <a href="#slik-funker-det">Slik funker det</a>
      <a href="/api/opplevelser/discover">Discovery-API</a>
    </div>
    <div class="footer-col">
      <h4>For agenter</h4>
      <a href="/llms.txt"><code>llms.txt</code></a>
      <a href="/.well-known/agent-card.json"><code>agent-card.json</code></a>
      <a href="/mcp"><code>/mcp</code> (MCP)</a>
      <a href="/openapi.json"><code>openapi.json</code></a>
      <a href="/api/opplevelser/discover"><code>/api/opplevelser</code></a>
    </div>
  </div>
  <div class="footer-bottom">
    <span>&copy; ${year} Opplevagent</span>
    <span class="verified"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12 L11 14.5 L15.5 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Tilbydere verifisert mot Brønnøysundregistrene</span>
  </div>
</footer>

<script>
/* Progressive enhancement: turn the free-text prompt into the right query
   param. With JS disabled the form still submits ?fylke=<text> as a plain GET
   to the discovery API, and every quick-link is a normal href — so the page is
   fully functional without this script. */
(function(){
  var form = document.getElementById('discover-form');
  var input = document.getElementById('discover-q');
  if(!form || !input) return;
  var FYLKER = ['oslo','viken','innlandet','vestfold','telemark','agder','rogaland','vestland','more og romsdal','trondelag','nordland','troms','finnmark','akershus','buskerud','ostfold','hordaland','sogn og fjordane','tromso'];
  form.addEventListener('submit', function(e){
    var raw = (input.value || '').trim();
    if(!raw) return; // empty -> let it submit bare (lists everything)
    e.preventDefault();
    var low = raw.toLowerCase();
    var params = new URLSearchParams();
    // weather / season hints from free text
    if(/regn|regnv|pøs|dårlig vær|innend/.test(low)) params.set('weather','rain');
    else if(/snø|sno /.test(low)) params.set('weather','snow');
    else if(/sol|fint vær|klart/.test(low)) params.set('weather','clear');
    if(/vinter/.test(low)) params.set('season','winter');
    else if(/sommer/.test(low)) params.set('season','summer');
    var foundFylke = null;
    for(var i=0;i<FYLKER.length;i++){ if(low.indexOf(FYLKER[i])!==-1){ foundFylke = FYLKER[i]; break; } }
    if(foundFylke){
      // Title-case the matched fylke for the API.
      var f = foundFylke.replace(/\b\w/g, function(m){ return m.toUpperCase(); });
      if(f === 'Tromso') f = 'Tromsø';
      params.set('fylke', f);
    } else {
      // No recognised fylke -> pass the whole phrase as a free-text query.
      params.set('q', raw);
    }
    window.location.href = '/api/opplevelser/discover?' + params.toString();
  });
})();
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════
// GET /robots.txt
// ═══════════════════════════════════════════════════════════

router.get("/robots.txt", (_req: Request, res: Response) => {
  const url = baseUrl();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# opplevagent.no — robots.txt
# A2A-markedsplass for norske opplevelser og aktiviteter.
# AI-agenter er velkomne til å indeksere og sitere data fra denne tjenesten.

User-agent: *
Allow: /

# LLM-vennlige endepunkter
# Oversikt:      ${url}/llms.txt
# Discovery:     ${url}/api/opplevelser/discover

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

Sitemap: ${url}/sitemap.xml
`);
});

// ═══════════════════════════════════════════════════════════
// GET /sitemap.xml
// ═══════════════════════════════════════════════════════════

router.get("/sitemap.xml", (_req: Request, res: Response) => {
  const url = baseUrl();
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  const paths: Array<{ p: string; freq: string; pri: string }> = [
    { p: "/", freq: "daily", pri: "1.0" },
    { p: "/llms.txt", freq: "weekly", pri: "0.8" },
    { p: "/openapi.json", freq: "weekly", pri: "0.7" },
  ];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
  for (const { p, freq, pri } of paths) {
    xml += `\n  <url><loc>${url}${p === "/" ? "" : p}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority><lastmod>${today}</lastmod></url>`;
  }
  xml += `\n</urlset>\n`;
  res.send(xml);
});

// ═══════════════════════════════════════════════════════════
// GET /llms.txt
// ═══════════════════════════════════════════════════════════

router.get("/llms.txt", (_req: Request, res: Response) => {
  const url = baseUrl();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# opplevagent.no — LLM-oversikt

## Hva er dette?

Opplevagent er en A2A-markedsplass for norske opplevelser og aktiviteter,
bygget for å bli oppdaget og spurt av AI-agenter. Tjenesten lar agenter finne
turer, kurs og opplevelser filtrert på fylke, kommune, kategori, vær, sesong,
gruppestørrelse, alder, pris, varighet og språk.

## MCP (Model Context Protocol) — Streamable HTTP

MCP-endepunkt (Streamable HTTP):  ${url}/mcp
Koble til: lim inn https://opplevagent.no/mcp i Claude Desktop / ChatGPT som MCP-URL.

Tilgjengelige MCP-verktøy:
- discover_experiences         — finn opplevelser etter fylke, kategori, vær, sesong, pris m.m.
- list_experience_categories   — hent alle kategorier med antall verifiserte opplevelser
- get_experience               — hent fullstendig detalj for én opplevelse via UUID

Eksempel (tools/call — discover):
  curl -X POST ${url}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"discover_experiences","arguments":{"fylke":"Oslo","weather":"rain","limit":5}},"id":"1"}'

## A2A AI-discovery

Agent Card (A2A-protokoll):   ${url}/.well-known/agent-card.json
Alias:                        ${url}/agent-card.json
A2A JSON-RPC 2.0 endepunkt:  ${url}/a2a
OpenAPI 3.1 spec:             ${url}/openapi.json

Støttede A2A JSON-RPC-metoder:
- message/send  — finn opplevelser med naturlig språk eller strukturerte filtre
- tasks/send    — bakoverkompatibelt alias for eldre A2A-klienter (<0.3)

Eksempel (cURL):
  curl -X POST ${url}/a2a \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"text":"hva kan vi finne på i Oslo når det regner"}},"id":"1"}'

## Discovery-API (REST)

GET ${url}/api/opplevelser/discover

Filterparametre (query string):
- fylke          fylkesnavn (f.eks. "Oslo", "Troms")
- kommune        kommunenavn (f.eks. "Tromsø")
- category       kategori (f.eks. "dyreliv_safari", "natur_friluft")
- indoor_outdoor "indoor" | "outdoor" | "both"
- weather        "rain" | "snow" | "clear" | "any" (regn/snø foretrekker innendørs / værsikre)
- season         "summer" | "winter" | ...
- group_size     antall personer i gruppen
- age            alder på yngste deltaker
- max_price      makspris i kroner
- duration_max   maks varighet i minutter
- language       påkrevd språk (f.eks. "en", "no")
- limit          maks antall resultater (standard 20, maks 100)

Respons: JSON med { vertical:"experiences", query, count, results[] }.

Eksempel:
  GET ${url}/api/opplevelser/discover?fylke=Oslo&weather=rain&group_size=4

## Flere REST-endepunkt

GET ${url}/api/opplevelser/categories   — alle kategorier med antall
GET ${url}/api/opplevelser/{id}         — én opplevelse via id

## Lisens

Provider-data verifiseres mot Brønnøysundregistrene (CC0). Innhold gjengis
som faktaoppsummering med kildehenvisning.
`);
});

// ═══════════════════════════════════════════════════════════
// GET /.well-known/agents.txt — IETF Agent Discovery
// ═══════════════════════════════════════════════════════════

function serveAgentsTxt(_req: Request, res: Response): void {
  const url = baseUrl();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# agents.txt — opplevagent.no
# A2A-markedsplass for norske opplevelser og aktiviteter.

Agent-card: ${url}/.well-known/agent-card.json
A2A-endpoint: ${url}/a2a
OpenAPI: ${url}/openapi.json
LLM-oversikt: ${url}/llms.txt
Discovery: ${url}/api/opplevelser/discover
`);
}
router.get("/.well-known/agents.txt", serveAgentsTxt);
// Root alias — some agent-discovery conventions look at /agents.txt directly.
router.get("/agents.txt", serveAgentsTxt);

// ═══════════════════════════════════════════════════════════
// GET /.well-known/agent-card.json — A2A Agent Card (Opplevagent)
// ═══════════════════════════════════════════════════════════

router.get("/.well-known/agent-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getExperiencesAgentCard());
});

// GET /agent-card.json — alias (some crawlers skip the well-known prefix)
router.get("/agent-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getExperiencesAgentCard());
});

// ═══════════════════════════════════════════════════════════
// GET /openapi.json — OpenAPI 3.1 spec for opplevagent.no
// ═══════════════════════════════════════════════════════════

router.get("/openapi.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getExperiencesOpenapi());
});

// ═══════════════════════════════════════════════════════════
// Catch-all 404 — norsk side (forhindrer rfb/dental-innhold på opplevagent-host)
// ═══════════════════════════════════════════════════════════

router.use((_req: Request, res: Response) => {
  res.status(404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="no"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Side ikke funnet (404) — Opplevagent</title>
<style>body{font-family:system-ui,sans-serif;background:#f7faf6;color:#1a2b1f;max-width:600px;margin:0 auto;padding:80px 20px;text-align:center}a{color:#1f6f43}</style>
</head><body>
<h1>Siden finnes ikke</h1>
<p>Vi fant ikke siden du leter etter. Gå til forsiden eller prøv discovery-API-et.</p>
<p><a href="/">Til forsiden</a> &middot; <a href="/api/opplevelser/discover">Discovery-API</a></p>
</body></html>`);
});

export default router;

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
  const cats = safeCategories();
  const catList =
    cats.length > 0
      ? `<ul class="cats">${cats
          .slice(0, 12)
          .map((c) => `<li>${escapeHtml(c.category)} <span>(${c.count})</span></li>`)
          .join("")}</ul>`
      : `<p class="muted">Opplevelser publiseres fortløpende.</p>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opplevagent — A2A-markedsplass for norske opplevelser</title>
<meta name="description" content="Opplevagent er en A2A-markedsplass for norske opplevelser og aktiviteter, søkbar for AI-agenter. Finn turer, kurs og opplevelser etter sted, vær, sesong og pris.">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="${url}">
<meta property="og:title" content="Opplevagent">
<meta property="og:description" content="A2A-markedsplass for norske opplevelser og aktiviteter — søkbar for AI-agenter.">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<style>
  :root { --fg:#1a2b1f; --accent:#1f6f43; --muted:#5a6b5f; --bg:#f7faf6; --card:#fff; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--fg); background:var(--bg); line-height:1.55; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 64px; }
  header h1 { font-size:2rem; margin:0 0 6px; }
  .tag { color:var(--accent); font-weight:600; }
  .lead { font-size:1.1rem; color:var(--muted); margin:8px 0 28px; }
  .card { background:var(--card); border:1px solid #e3ece2; border-radius:12px; padding:20px 22px; margin:16px 0; }
  .card h2 { font-size:1.05rem; margin:0 0 10px; }
  code { background:#eef4ec; padding:2px 6px; border-radius:5px; font-size:.9em; }
  a { color:var(--accent); }
  ul.links { list-style:none; padding:0; margin:0; }
  ul.links li { margin:6px 0; }
  ul.cats { list-style:none; padding:0; margin:0; display:flex; flex-wrap:wrap; gap:8px; }
  ul.cats li { background:#eef4ec; border-radius:20px; padding:4px 12px; font-size:.9rem; }
  ul.cats li span { color:var(--muted); }
  .muted { color:var(--muted); }
  footer { margin-top:32px; color:var(--muted); font-size:.85rem; }
  .cta { display:inline-block; margin-top:6px; background:var(--accent); color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Opplevagent <span class="tag">A2A</span></h1>
    <p class="lead">En markedsplass for norske opplevelser og aktiviteter — bygget for å bli oppdaget og spurt av AI-agenter.</p>
  </header>

  <div class="card">
    <h2>For AI-agenter</h2>
    <p>Opplevagent eksponerer maskinlesbare flater slik at agenter kan oppdage og søke i tilbudet:</p>
    <ul class="links">
      <li>Agent Card (A2A): <a href="/.well-known/agent-card.json"><code>/.well-known/agent-card.json</code></a></li>
      <li>A2A JSON-RPC 2.0: <code>POST /a2a</code></li>
      <li>OpenAPI 3.1: <a href="/openapi.json"><code>/openapi.json</code></a></li>
      <li>LLM-oversikt: <a href="/llms.txt"><code>/llms.txt</code></a></li>
      <li>Discovery API: <a href="/api/opplevelser/discover"><code>/api/opplevelser/discover</code></a></li>
    </ul>
  </div>

  <div class="card">
    <h2>Discovery-eksempel</h2>
    <p>«Hva kan vi finne på i Oslo når det regner?»</p>
    <p><code>GET ${url}/api/opplevelser/discover?fylke=Oslo&amp;weather=rain&amp;group_size=4</code></p>
    <a class="cta" href="/api/opplevelser/discover">Prøv discovery-API-et</a>
  </div>

  <div class="card">
    <h2>Kategorier</h2>
    ${catList}
  </div>

  <footer>
    &copy; ${new Date().getFullYear()} Opplevagent &middot; AI-agenter: <a href="/llms.txt">llms.txt</a> &middot; API: <a href="/api/opplevelser/discover">/api/opplevelser</a>
  </footer>
</div>
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

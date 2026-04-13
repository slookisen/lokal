/**
 * SEO Frontend Routes — Server-rendered HTML pages for Google indexing
 *
 * These pages exist to compete with Google Places by BEING in Google.
 * Every page includes Schema.org LocalBusiness markup for rich results.
 *
 * Routes:
 *   GET /                     → Landing page with search + popular cities
 *   GET /:city                → City page with all producers in that city
 *   GET /produsent/:slug      → Individual producer page with full details
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
    .replace(/\u00e6/g, "ae")   // æ → ae
    .replace(/\u00f8/g, "o")    // ø → o
    .replace(/\u00e5/g, "a")    // å → a
    .replace(/\u00e4/g, "a")    // ä → a
    .replace(/\u00f6/g, "o")    // ö → o
    .replace(/\u00fc/g, "u")    // ü → u
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const BASE_URL = process.env.BASE_URL || "https://lokal.fly.dev";

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
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; background: #fafaf8; }
    a { color: #2d6a4f; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 900px; margin: 0 auto; padding: 0 20px; }

    /* Header */
    header { background: #2d6a4f; color: white; padding: 20px 0; }
    header h1 { font-size: 1.5rem; }
    header a { color: white; }
    header nav { margin-top: 8px; font-size: 0.9rem; opacity: 0.85; }
    header nav a { margin-right: 16px; }

    /* Hero */
    .hero { background: #f0f7f4; padding: 48px 0; text-align: center; }
    .hero h2 { font-size: 2rem; color: #2d6a4f; margin-bottom: 12px; }
    .hero p { font-size: 1.1rem; color: #555; max-width: 600px; margin: 0 auto 24px; }
    .search-box { display: flex; max-width: 500px; margin: 0 auto; }
    .search-box input { flex: 1; padding: 12px 16px; font-size: 1rem; border: 2px solid #2d6a4f; border-radius: 8px 0 0 8px; outline: none; }
    .search-box button { padding: 12px 24px; background: #2d6a4f; color: white; border: none; border-radius: 0 8px 8px 0; font-size: 1rem; cursor: pointer; }

    /* City grid */
    .cities { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin: 32px 0; }
    .city-card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: box-shadow 0.2s; }
    .city-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); text-decoration: none; }
    .city-card h3 { color: #2d6a4f; margin-bottom: 4px; }
    .city-card .count { color: #888; font-size: 0.9rem; }

    /* Producer list */
    .producers { margin: 24px 0; }
    .producer-card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .producer-card h3 { color: #2d6a4f; margin-bottom: 8px; }
    .producer-card h3 a { color: #2d6a4f; }
    .producer-meta { color: #666; font-size: 0.9rem; margin-bottom: 8px; }
    .producer-desc { color: #444; }
    .producer-tags { margin-top: 8px; }
    .tag { display: inline-block; background: #e8f5e9; color: #2d6a4f; padding: 2px 10px; border-radius: 12px; font-size: 0.8rem; margin-right: 6px; margin-bottom: 4px; }

    /* Producer detail */
    .detail { margin: 32px 0; }
    .detail h2 { color: #2d6a4f; font-size: 1.8rem; margin-bottom: 16px; }
    .detail-section { margin-bottom: 24px; }
    .detail-section h3 { color: #333; font-size: 1.1rem; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
    .contact-item { margin-bottom: 6px; }
    .product-list { list-style: none; }
    .product-list li { padding: 4px 0; border-bottom: 1px solid #f0f0f0; }
    .cert-badge { display: inline-block; background: #fff3e0; color: #e65100; padding: 2px 10px; border-radius: 12px; font-size: 0.8rem; margin-right: 6px; }
    .vcard-btn { display: inline-block; background: #2d6a4f; color: white; padding: 10px 20px; border-radius: 8px; margin-top: 12px; font-weight: 500; }
    .vcard-btn:hover { background: #1b4332; text-decoration: none; }

    /* Breadcrumb */
    .breadcrumb { padding: 12px 0; font-size: 0.85rem; color: #888; }
    .breadcrumb a { color: #2d6a4f; }

    /* Footer */
    footer { background: #333; color: #ccc; padding: 32px 0; margin-top: 48px; font-size: 0.85rem; }
    footer a { color: #8fbc8f; }

    /* AI badge */
    .ai-badge { background: #f3e5f5; color: #7b1fa2; padding: 8px 16px; border-radius: 8px; font-size: 0.85rem; margin: 24px 0; display: inline-block; }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1><a href="/">Lokal</a></h1>
      <nav>
        <a href="/">Hjem</a>
        <a href="/oslo">Oslo</a>
        <a href="/bergen">Bergen</a>
        <a href="/trondheim">Trondheim</a>
        <a href="/stavanger">Stavanger</a>
      </nav>
    </div>
  </header>
  ${content}
  <footer>
    <div class="container">
      <p>Lokal — Finn lokalprodusert mat i Norge. ${new Date().getFullYear()}</p>
      <p style="margin-top: 8px;">
        <a href="${BASE_URL}/dashboard.html">Dashboard / Registrer agent</a> ·
        <a href="${BASE_URL}/api/marketplace/search?q=mat">API</a> ·
        <a href="${BASE_URL}/.well-known/agent-card.json">Agent Card</a> ·
        Tilgjengelig i <a href="https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-lokal-norsk-matfinner">ChatGPT</a> og Claude Desktop
      </p>
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

    // Count agents per city
    const cityCounts: Record<string, number> = {};
    agents.forEach((a: any) => {
      const city = a.city || a.location?.city;
      if (city) cityCounts[city] = (cityCounts[city] || 0) + 1;
    });

    // Sort cities by count
    const topCities = Object.entries(cityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    const cityCards = topCities.map(([city, count]) =>
      `<a href="/${slugify(city)}" class="city-card">
        <h3>${escapeHtml(city)}</h3>
        <span class="count">${count} produsenter</span>
      </a>`
    ).join("\n");

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Lokal",
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
        <h2>Finn lokal mat i Norge</h2>
        <p>Sok blant ${stats.totalAgents || agents.length} garder, markeder og gaardsbutikker over hele landet.</p>
        <form class="search-box" action="/sok" method="GET">
          <input type="text" name="q" placeholder="Sok etter mat, sted eller produsent..." aria-label="Sok">
          <button type="submit">Sok</button>
        </form>
      </div>
    </div>
    <div class="container">
      <h2 style="margin-top: 32px; color: #2d6a4f;">Populaere byer</h2>
      <div class="cities">${cityCards}</div>

      <div class="ai-badge">
        Lokal er tilgjengelig i <a href="https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-lokal-norsk-matfinner">ChatGPT</a> og Claude Desktop — spor AI-en din om lokal mat!
      </div>
    </div>`;

    res.send(htmlShell(
      "Lokal — Finn lokalprodusert mat i Norge",
      `Sok blant ${stats.totalAgents || agents.length} lokale matprodusenter i Norge. Garder, markeder, gaardsbutikker med kontaktinfo og apningstider.`,
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
    const results = marketplaceRegistry.discover({ ...parsed, limit: 30 });

    const resultCards = results.map((r: any) => {
      const a = r.agent;
      const city = a.city || a.location?.city || "";
      const slug = slugify(a.name);
      const cats = (a.categories || []).map((c: string) => `<span class="tag">${escapeHtml(c)}</span>`).join("");
      return `<div class="producer-card">
        <h3><a href="/produsent/${slug}">${escapeHtml(a.name)}</a></h3>
        <div class="producer-meta">${escapeHtml(city)}${r.distanceKm ? ` · ${r.distanceKm.toFixed(1)} km` : ""}</div>
        <div class="producer-desc">${escapeHtml(a.description || "")}</div>
        <div class="producer-tags">${cats}</div>
      </div>`;
    }).join("\n");

    const content = `
    <div class="container">
      <div class="breadcrumb"><a href="/">Hjem</a> / Sok: "${escapeHtml(q)}"</div>
      <h2 style="color: #2d6a4f; margin-bottom: 16px;">Sokresultater for "${escapeHtml(q)}" — ${results.length} treff</h2>
      <form class="search-box" action="/sok" method="GET" style="margin-bottom: 24px;">
        <input type="text" name="q" value="${escapeHtml(q)}" aria-label="Sok">
        <button type="submit">Sok</button>
      </form>
      <div class="producers">${resultCards || "<p>Ingen resultater. Prov et bredere sok.</p>"}</div>
    </div>`;

    res.send(htmlShell(
      `${q} — Lokal matsok`,
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
  const citySlug = req.params.city.toLowerCase();

  // Skip non-city routes — pass to next handler (sitemap, robots, health, etc.)
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
        `<div class="container" style="padding: 48px 0;">
          <h2>Fant ingen produsenter for "${escapeHtml(citySlug)}"</h2>
          <p><a href="/">Tilbake til forsiden</a></p>
        </div>`
      ));
    }

    const cityName = cityAgents[0].city || cityAgents[0].location?.city || citySlug;
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
      const cats = (a.categories || []).map((c: string) => `<span class="tag">${escapeHtml(c)}</span>`).join("");
      const trust = a.trustScore ? `Trust ${Math.round(a.trustScore * 100)}%` : "";
      return `<div class="producer-card">
        <h3><a href="/produsent/${slug}">${escapeHtml(a.name)}</a></h3>
        <div class="producer-meta">${trust}</div>
        <div class="producer-desc">${escapeHtml(a.description || "")}</div>
        <div class="producer-tags">${cats}</div>
      </div>`;
    }).join("\n");

    const content = `
    <div class="container">
      <div class="breadcrumb"><a href="/">Hjem</a> / ${escapeHtml(cityName)}</div>
      <h2 style="color: #2d6a4f; margin: 24px 0 8px;">Lokal mat i ${escapeHtml(cityName)}</h2>
      <p style="color: #666; margin-bottom: 24px;">${cityAgents.length} lokale matprodusenter i ${escapeHtml(cityName)}-omraadet.</p>
      <div class="producers">${producerCards}</div>
    </div>`;

    res.send(htmlShell(
      `Lokal mat i ${cityName} — ${cityAgents.length} produsenter`,
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
  const slug = req.params.slug.toLowerCase();

  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const agent = agents.find((a: any) => slugify(a.name) === slug);

    if (!agent) {
      return res.status(404).send(htmlShell(
        "Produsent ikke funnet",
        "Denne produsenten finnes ikke.",
        `<div class="container" style="padding: 48px 0;">
          <h2>Produsent ikke funnet</h2>
          <p><a href="/">Tilbake til forsiden</a></p>
        </div>`
      ));
    }

    const info = knowledgeService.getAgentInfo(agent.id);
    const k = (info?.knowledge || {}) as any;
    const meta = (info?.meta || {}) as any;
    const cityName = agent.city || agent.location?.city || "";

    // Contact section
    const contactItems: string[] = [];
    if (k.address) contactItems.push(`<div class="contact-item">Adresse: ${escapeHtml(k.address)}${k.postalCode ? `, ${escapeHtml(k.postalCode)}` : ""}</div>`);
    if (k.phone) contactItems.push(`<div class="contact-item">Telefon: <a href="tel:${k.phone.replace(/\s+/g, "")}">${escapeHtml(k.phone)}</a></div>`);
    if (k.email) contactItems.push(`<div class="contact-item">E-post: <a href="mailto:${k.email}">${escapeHtml(k.email)}</a></div>`);
    if (k.website) contactItems.push(`<div class="contact-item">Nettside: <a href="${escapeHtml(k.website)}" rel="noopener">${escapeHtml(k.website)}</a></div>`);

    // Opening hours
    const dayNames: Record<string, string> = { mon: "Mandag", tue: "Tirsdag", wed: "Onsdag", thu: "Torsdag", fri: "Fredag", sat: "Lordag", sun: "Sondag" };
    const hoursHtml = k.openingHours?.length
      ? k.openingHours.map((h: any) => `<div>${dayNames[h.day] || h.day}: ${h.open}–${h.close}</div>`).join("")
      : "";

    // Products
    const productsHtml = k.products?.length
      ? `<ul class="product-list">${k.products.map((p: any) => {
          const seasonal = p.seasonal && p.months?.length ? ` <em>(sesong: ${p.months.join(", ")})</em>` : "";
          return `<li>${escapeHtml(p.name)}${p.category ? ` — ${escapeHtml(p.category)}` : ""}${seasonal}</li>`;
        }).join("")}</ul>`
      : "";

    // Certifications
    const certsHtml = k.certifications?.length
      ? k.certifications.map((c: string) => `<span class="cert-badge">${escapeHtml(c)}</span>`).join(" ")
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
    <div class="container">
      <div class="breadcrumb">
        <a href="/">Hjem</a>${cityName ? ` / <a href="/${slugify(cityName)}">${escapeHtml(cityName)}</a>` : ""} / ${escapeHtml(agent.name)}
      </div>

      <div class="detail">
        <h2>${escapeHtml(agent.name)}</h2>
        ${cityName ? `<div class="producer-meta">${escapeHtml(cityName)}${agent.trustScore ? ` · Trust ${Math.round(agent.trustScore * 100)}%` : ""}${agent.isVerified ? " · Verifisert" : ""}</div>` : ""}

        ${k.about ? `<div class="detail-section"><p>${escapeHtml(k.about)}</p></div>` : ""}
        ${agent.description && agent.description !== k.about ? `<div class="detail-section"><p>${escapeHtml(agent.description)}</p></div>` : ""}

        ${contactItems.length ? `<div class="detail-section"><h3>Kontakt</h3>${contactItems.join("")}</div>` : ""}

        ${hoursHtml ? `<div class="detail-section"><h3>Apningstider</h3>${hoursHtml}</div>` : ""}

        ${productsHtml ? `<div class="detail-section"><h3>Produkter</h3>${productsHtml}</div>` : ""}

        ${certsHtml ? `<div class="detail-section"><h3>Sertifiseringer</h3>${certsHtml}</div>` : ""}

        ${k.paymentMethods?.length ? `<div class="detail-section"><h3>Betaling</h3><p>${k.paymentMethods.map((m: string) => escapeHtml(m)).join(", ")}</p></div>` : ""}

        ${k.deliveryOptions?.length ? `<div class="detail-section"><h3>Levering</h3><p>${k.deliveryOptions.map((d: string) => escapeHtml(d)).join(", ")}</p></div>` : ""}

        <a href="${BASE_URL}/api/marketplace/agents/${agent.id}/vcard" class="vcard-btn">Last ned kontaktkort (vCard)</a>

        ${meta.disclaimer ? `<p style="margin-top: 24px; font-size: 0.8rem; color: #999;">${escapeHtml(meta.disclaimer)}</p>` : ""}
      </div>
    </div>`;

    res.send(htmlShell(
      `${agent.name} — Lokal mat${cityName ? ` i ${cityName}` : ""}`,
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

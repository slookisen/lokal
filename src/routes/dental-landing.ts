// ─── Finn-tannlege facet pages (A2A dev-request 2026-10-16-finn-tannlege-fasettsider, F1-S4a)
//
// /sted/<sted>/<fasett> and /fylke/<fylke>/<fasett>: the clinics of one
// place that have Helfo, sourced akuttvakt or one specialty
// (DENTAL_LANDING_FACETS in config/dental-landing.ts), each a page of its own
// with the answer-first paragraph, fact table, ItemList, paging and FAQ the
// /sted and /fylke pages have.
//
// A facet page exists only over the facet gate (passesDentalFacetGate, on
// the counts of the cached area aggregate): under it, an unknown place or an
// unknown or disabled facet, the route calls next() and the catch-all answers
// 404 with noindex. The sitemap (buildDentalSitemapXml) and the links from
// /sted and /fylke take their facets from publishedDentalFacets() below, on
// places built by the same functions the route's findSted / findFylke use,
// so every facet URL in the sitemap answers 200.
//
// No count runs per request: the gate, the page count and the paging come
// from the aggregate, and the page lists its clinics with one LIMIT query,
// the store filter of the place and the facet together. When that list and
// the aggregate disagree (the data changed within the cache TTL), the page
// states no number until the cache catches up, as /sted does.
//
// dental-seo.ts registers the routes before its catch-all and hands in its
// shell, card, JSON-LD and paging helpers and the place lookups (deps), so
// this module does not import dental-seo.ts. Nor does it import the store or
// the aggregate: tests swap those modules for a fresh in-memory DB, and a
// copy held here would read another DB.

import type { Request, Response, NextFunction, Router } from "express";
import type { DentalAgentRow, ListFilter } from "../services/dental-store";
import { DENTAL_LANDING_CONFIG, DENTAL_LANDING_FACETS, findDentalLandingFacet, type DentalLandingFacet } from "../config/dental-landing";
import { buildDentalFacetLanding, passesDentalFacetGate, type DentalAreaCounts, type DentalAreaScope } from "../services/dental-area-facts";
import { recordAiPageDelivery } from "../services/profile-ai-deliveries";

/** A place a facet page can be about: a /sted group or a canonical fylke. */
export interface DentalLandingPlace {
  scope: DentalAreaScope;
  /** Display name, as the place's own page names it: «Bergen», «Vestland». */
  name: string;
  /** The place's own page: /sted/bergen, /fylke/Vestland (URL-encoded). */
  path: string;
  /** The store filter for the place's clinics, as its own page lists them. */
  filter: ListFilter;
  /** The place's counts from the cached area aggregate, facets included. */
  counts: DentalAreaCounts | undefined;
}

export interface DentalLandingDeps {
  baseUrl: string;
  shell(content: string, opts: { title: string; description: string; canonical: string; jsonLd: object[] }): string;
  clinicCard(row: DentalAgentRow): string;
  breadcrumbJsonLd(items: Array<{ name: string; url: string }>): object;
  itemListJsonLd(name: string, url: string, agents: DentalAgentRow[], offset: number): object;
  paginationHtml(page: number, totalPages: number, baseUrl: string): string;
  listPageHref(baseUrl: string, n: number): string;
  listPageMeta(page: number, totalPages: number): { title: string; description: string };
  resolveListPage(side: unknown, total: number): { page: number; offset: number; totalPages: number };
  /** listPublicDentalAgents. */
  listAgents(filter: ListFilter, limit: number, offset: number): DentalAgentRow[];
  /** The /sted place for a slug, or undefined when it has no indexable /sted page. */
  findSted(slug: string): DentalLandingPlace | undefined;
  /** The canonical fylke for a /fylke URL segment (any case), or undefined. */
  findFylke(param: string): DentalLandingPlace | undefined;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The facet's counts in the place when the facet is on and over the gate, else undefined. */
export function publishedFacetCounts(place: DentalLandingPlace, facet: DentalLandingFacet): DentalAreaCounts | undefined {
  const counts = place.counts?.facets?.[facet.slug];
  return facet.enabled && passesDentalFacetGate(counts) ? counts : undefined;
}

/** The place's facet pages, in config order: the ones the route serves and the sitemap lists. */
export function publishedDentalFacets(place: DentalLandingPlace): Array<{ facet: DentalLandingFacet; counts: DentalAreaCounts }> {
  return DENTAL_LANDING_FACETS.flatMap((facet) => {
    const counts = publishedFacetCounts(place, facet);
    return counts ? [{ facet, counts }] : [];
  });
}

/** /sted/bergen/kjeveortopedi, /fylke/Vestland/tannlegevakt. */
export function dentalFacetPath(place: DentalLandingPlace, facet: DentalLandingFacet): string {
  return `${place.path}/${facet.slug}`;
}

/** The page's H1, link label and ItemList name: «Kjeveortoped i Bergen». */
export function dentalFacetHeading(place: DentalLandingPlace, facet: DentalLandingFacet): string {
  return `${facet.h1Label} i ${place.name}`;
}

/** The links from /sted and /fylke to the place's facet pages, or "" when it has none. */
export function dentalFacetLinksHtml(place: DentalLandingPlace): string {
  const facets = publishedDentalFacets(place);
  if (facets.length === 0) return "";
  const links = facets.map(({ facet, counts }) =>
    `<a href="${escapeHtml(dentalFacetPath(place, facet))}" class="spec-chip">${escapeHtml(dentalFacetHeading(place, facet))} <span style="font-size:.75em;opacity:.7">(${counts.total.toLocaleString("nb")})</span></a>`
  );
  return `<div class="landing-facet-links" style="margin-top:32px">
  <div class="section-title" style="font-size:1rem;margin-bottom:10px">Mer om tannleger i ${escapeHtml(place.name)}</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">${links.join("")}</div>
</div>`;
}

export function registerDentalLandingRoutes(router: Router, deps: DentalLandingDeps): void {
  const render = (req: Request, res: Response, next: NextFunction, place: DentalLandingPlace | undefined): void => {
    const facet = findDentalLandingFacet(String(req.params.facet).toLowerCase());
    const counts = place && facet ? publishedFacetCounts(place, facet) : undefined;
    if (!place || !facet || !counts) {
      next();
      return;
    }

    const total = counts.total;
    const { page, offset, totalPages } = deps.resolveListPage(req.query.side, total);
    const pageSize = DENTAL_LANDING_CONFIG.listPageSize;
    let agents: DentalAgentRow[] = [];
    try {
      agents = deps.listAgents({ ...place.filter, ...facet.filter }, pageSize, offset);
    } catch { /* db not ready */ }
    // Every clinic in the facet closed since the cache was built: no page.
    if (agents.length === 0) {
      next();
      return;
    }
    // The list agrees with the aggregate when this page holds what the count says it does.
    const consistent = agents.length === Math.min(pageSize, total - offset);

    const heading = dentalFacetHeading(place, facet);
    const basePath = dentalFacetPath(place, facet);
    // Page 1 is the bare path; page N ≥ 2 is its own canonical (F1-S1).
    const pageUrl = `${deps.baseUrl}${deps.listPageHref(basePath, page)}`;
    const pageMeta = deps.listPageMeta(page, totalPages);
    const landing = buildDentalFacetLanding(counts, { name: place.name, url: pageUrl, scope: place.scope, facet });
    // Intro, table and FAQ on page 1 only, and only while list and aggregate agree.
    const showLanding = page === 1 && consistent;

    const html = `
<main>
  <div class="profile-header">
    <div class="container">
      <p style="font-size:.85rem;opacity:.7;margin-bottom:8px"><a href="${escapeHtml(place.path)}" style="color:rgba(255,255,255,.7)">&larr; ${place.scope === "poststed" ? "Tannlege" : "Tannleger"} i ${escapeHtml(place.name)}</a></p>
      <h1 class="profile-name">${escapeHtml(heading)}</h1>
      ${consistent ? `<p style="opacity:.8;font-size:.95rem">${total.toLocaleString("nb")} klinikker registrert</p>` : ""}
    </div>
  </div>
  <div class="container" style="padding-top:28px;padding-bottom:48px">
    ${showLanding ? landing.introHtml + landing.tableHtml : ""}
    <p class="result-meta">Side ${page} av ${totalPages}</p>
    <div class="clinic-list" role="list" aria-label="${escapeHtml(heading)}">
      ${agents.map((a) => deps.clinicCard(a)).join("")}
    </div>
    ${deps.paginationHtml(page, totalPages, basePath)}
    ${showLanding ? landing.faqHtml : ""}
    <p style="margin-top:16px;font-size:.9rem"><a href="${escapeHtml(place.path)}">&larr; Alle tannleger i ${escapeHtml(place.name)}</a></p>
  </div>
</main>`;

    const breadcrumb = deps.breadcrumbJsonLd([
      { name: "Hjem", url: deps.baseUrl },
      { name: place.name, url: `${deps.baseUrl}${place.path}` },
      { name: heading, url: `${deps.baseUrl}${basePath}` },
    ]);
    const jsonLd = [
      deps.itemListJsonLd(heading, pageUrl, agents, offset),
      breadcrumb,
      ...(showLanding && landing.faqJsonLd ? [landing.faqJsonLd] : []),
    ];

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    recordAiPageDelivery(req, res, "ai_page_list", agents.map((a) => a.id), "dental");
    res.send(deps.shell(html, {
      title: `${facet.titleTemplate.split("{sted}").join(place.name)}${pageMeta.title} — Finn-tannlege.com`,
      description: `${landing.summary}${pageMeta.description}`,
      canonical: pageUrl,
      jsonLd,
    }));
  };

  router.get("/sted/:stedSlug/:facet", (req: Request, res: Response, next: NextFunction) =>
    render(req, res, next, deps.findSted(String(req.params.stedSlug).toLowerCase().trim())));
  router.get("/fylke/:fylke/:facet", (req: Request, res: Response, next: NextFunction) =>
    render(req, res, next, deps.findFylke(String(req.params.fylke))));
}

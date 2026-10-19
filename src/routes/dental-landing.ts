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
// 404 with noindex. The links from /sted and /fylke take their facets from
// publishedDentalFacets() below and the sitemap (buildDentalSitemapXml) from
// sitemapDentalFacets(), on places built by the same functions the route's
// findSted / findFylke use, so every facet URL in the sitemap answers 200.
// A fylke facet page that lists exactly the clinics of one /sted facet page
// (Oslo the fylke and Oslo the poststed) answers 200 too, but with that page
// as its canonical, and is left out of the sitemap (canonicalFacetPlace).
//
// No count runs per request: the gate, the page count, the paging and the
// canonical come from the aggregate, and the page lists its clinics with one
// LIMIT query, the store filter of the place and the facet together. When
// that list and the aggregate disagree (the data changed within the cache
// TTL), the page states no number until the cache catches up, as /sted does.
//
// The tannlegevakt pages carry the emergency notice (DENTAL_EMERGENCY_NOTICE)
// above the list, on every page and whatever the numbers say.
//
// dental-seo.ts registers the routes before its catch-all and hands in its
// shell, card, JSON-LD and paging helpers, the store's list and the place
// lookups with their aggregate counts (deps), so this module imports neither
// dental-seo.ts nor anything that reads a DB: from services/dental-area-facts
// it takes only the gate and the text builder, which work on the counts they
// are given. Tests swap the store and the aggregate modules for a fresh
// in-memory DB, and a DB read held here would read another DB.

import type { Request, Response, NextFunction, Router } from "express";
import type { DentalAgentRow, ListFilter } from "../services/dental-store";
import {
  DENTAL_EMERGENCY_NOTICE,
  DENTAL_LANDING_CONFIG,
  DENTAL_LANDING_FACETS,
  findDentalLandingFacet,
  type DentalLandingFacet,
} from "../config/dental-landing";
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
  /**
   * A fylke only: the /sted place whose page for `facet` lists exactly the
   * clinics this place's page for it lists, or undefined (decided from the
   * aggregate, routes/dental-seo.ts). See canonicalFacetPlace.
   */
  sameClinicsAs?(facet: DentalLandingFacet): DentalLandingPlace | undefined;
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

/**
 * The place whose page for `facet` is the canonical one for this place's:
 * the /sted place that lists exactly the same clinics, when this is a fylke
 * that has one and its facet page is published (the same principle as
 * Daniel's answer to question 23 for the kommune pages, here as a canonical
 * rather than a redirect), else the place itself. Such a fylke page is left
 * out of the sitemap.
 */
export function canonicalFacetPlace(place: DentalLandingPlace, facet: DentalLandingFacet): DentalLandingPlace {
  const sted = place.sameClinicsAs?.(facet);
  return sted && publishedFacetCounts(sted, facet) ? sted : place;
}

/** The place's facet pages in the sitemap: the published ones that are their own canonical. */
export function sitemapDentalFacets(place: DentalLandingPlace): Array<{ facet: DentalLandingFacet; counts: DentalAreaCounts }> {
  return publishedDentalFacets(place).filter(({ facet }) => canonicalFacetPlace(place, facet) === place);
}

/**
 * The emergency notice (DENTAL_EMERGENCY_NOTICE) as a marked box, its phone
 * numbers as tel: links. The tannlegevakt facet pages show it, and the
 * /tannlegevakt hub (F1-S4b) is to show the same.
 */
export function dentalEmergencyNoticeHtml(): string {
  const { text, phones } = DENTAL_EMERGENCY_NOTICE;
  const numbers = new RegExp(`(${phones.map((p) => p.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  const body = text.split(numbers).map((part) => {
    const phone = phones.find((p) => p.number === part);
    return phone ? `<a href="tel:${phone.tel}" style="white-space:nowrap">${escapeHtml(part)}</a>` : escapeHtml(part);
  }).join("");
  return `<aside class="akutt-banner emergency-notice" role="note" style="border-left:4px solid var(--akutt-fg);padding:16px 20px;margin-bottom:24px"><p style="font-size:.95rem;line-height:1.55;margin:0">${body}</p></aside>`;
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
    // Page 1 is the bare path; page N ≥ 2 is its own canonical (F1-S1),
    // unless the same page of a /sted facet page lists the same clinics.
    const pageUrl = `${deps.baseUrl}${deps.listPageHref(basePath, page)}`;
    const canonicalUrl = `${deps.baseUrl}${deps.listPageHref(dentalFacetPath(canonicalFacetPlace(place, facet), facet), page)}`;
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
    ${facet.kind === "tannlegevakt" ? dentalEmergencyNoticeHtml() : ""}
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
      // No number while list and aggregate disagree, as on the page.
      description: `${consistent ? landing.summary : landing.uncountedSummary}${pageMeta.description}`,
      canonical: canonicalUrl,
      jsonLd,
    }));
  };

  router.get("/sted/:stedSlug/:facet", (req: Request, res: Response, next: NextFunction) =>
    render(req, res, next, deps.findSted(String(req.params.stedSlug).toLowerCase().trim())));
  router.get("/fylke/:fylke/:facet", (req: Request, res: Response, next: NextFunction) =>
    render(req, res, next, deps.findFylke(String(req.params.fylke))));
}

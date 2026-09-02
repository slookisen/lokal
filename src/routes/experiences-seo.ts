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

import express, { Router, Request, Response, NextFunction } from "express";
import * as QRCode from "qrcode";
// dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1: reads the
// vendored Leaflet assets (src/public/leaflet/) off disk for the
// GET /leaflet/* routes below — see their doc comment for why express.static
// can't be relied on here (the opplevagent.no host-gate in index.ts routes
// every non-API path into this router before express.static is ever reached).
import * as fs from "fs";
import * as path from "path";
import { getExperiencesAgentCard, OPPLEVAGENT_CUSTOM_GPT_URL } from "../services/experiences-agent-card";
import { getJWKS } from "../services/agent-card-signing";
import { getExperiencesOpenapi } from "../services/experiences-openapi";
import { generalLimiter } from "../middleware/security";
import { isDisplayablePhone } from "../services/contact-normalizer";
import { isJunkDescription, looksTruncatedMidWord } from "../services/description-quality";
import { INDEXNOW_KEY } from "../services/indexnow-service";
import { htmlLangAttr, ogLocale, localizedPath, isSvLocaleEnabled, type Lang } from "../i18n/t";
import { getPublishedProfileTranslations } from "../services/profile-translations";
import { mcpProtocolDeclaration } from "../services/mcp-protocol-version";
import {
  listCategories,
  getPublishedExperienceBySlug,
  getProviderById,
  getRelatedPublishedExperiences,
  listPublishedExperienceSlugs,
  countPublishedExperiences,
  listPublishedExperiences,
  listPublishedCategories,
  listPublishedFylker,
  listPublishedKommuner,
  foldPlaceSlug,
  listPublishedProviders,
  getCategoryFaqStats,
  getKommuneFaqStats,
  getProduktByStats,
  listProduktByCombos,
  countGardssalgProviders,
  // dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S2: the
  // homepage drikkested feature section's per-type chips — same WHERE gate as
  // countGardssalgProviders(), plus GROUP BY producer_type.
  countGardssalgProvidersByType,
  // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
  // 1 (slice 6): the #drikkested section's dark-launch vs live CTA copy.
  countGardssalgProvidersBookable,
  getPublishedProviderById,
  getPublishedProviderBySlug,
  getGardssalgProviderBySlug,
  backfillProviderSlugs,
  searchPublishedExperiences,
  listGardssalgProviders,
  // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
  // Steg 1: free-text producer search for /sok (distinct from
  // searchGardssalgProviders(filter, limit) above, which is the structured
  // filter used by the REST /discover endpoint) — see its doc comment in
  // experience-store.ts.
  searchGardssalgProvidersByQuery,
  type GardssalgSearchByQueryRow,
  resolveCanonicalSlugForDuplicate,
  // dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 3: «Nær meg» on
  // /sok — reuses the SAME discoverExperiences()/formatDistanceLabel() the
  // REST /api/opplevelser/discover endpoint (item 2) is built on, rather
  // than re-implementing geo filtering/sorting or the distance/precision
  // honesty rule a second time.
  discoverExperiences,
  formatDistanceLabel,
  type RelatedExperienceRow,
  type ExperienceCardRow,
  type GardssalgProviderRow,
  // dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1: the
  // /fylke/:fylke Leaflet map's marker data — see listPublishedExperienceMapPoints()
  // doc in experience-store.ts for the exact publish/coords predicate.
  listPublishedExperienceMapPoints,
  type ExperienceMapPoint,
  // dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, arbeidspunkt 4:
  // the /kategori/gardssalg map's marker data (producers, not experiences —
  // see listGardssalgProviderMapPoints()'s doc in experience-store.ts).
  listGardssalgProviderMapPoints,
  type GardssalgProviderMapPoint,
} from "../services/experience-store";
import { EXPERIENCE_TAGS, type ExperienceTag } from "../services/experience-tags";
// dev-request 2026-08-17-kontaktadresse-feilkilde-og-override, Skive C(b) /
// AC4: an epost whose registrable domain deviates from the producer's own
// homepage domain is under review and must not be published — neither in the
// produsent-profil page's visible "E-post" fact row nor in its JSON-LD
// `email`. The reader lives next to its Skive A sibling
// (isGardssalgContactEmailOverrideActive) in routes/opplevelser.ts and is
// imported here rather than duplicated, so each stamp keeps exactly one
// reader.
import { isGardssalgContactEmailFlaggedForReview } from "./opplevelser";
// dev-request 2026-08-07-orch-fylke-2024-migrasjon: the /fylke/:fylke 301
// fallback below reuses norway-fylke.ts's own historical-alias map
// (ALIAS_TO_CANONICAL), merged-legacy equivalence classes
// (EQUIVALENCE_CLASSES), and fold/normalize convention (key) rather than
// duplicating any of that data/logic — see the fallback's own doc comment.
import { key as fylkeFoldKey, ALIAS_TO_CANONICAL, EQUIVALENCE_CLASSES } from "../services/norway-fylke";
import { geocodingService } from "../services/geocoding-service";
import { isPlausibleNorwayCoord } from "../services/geo-distance";
// dev-request 2026-07-25-reisesok…, Fase 2c — the /reise corridor page.
import { corridorSearch, DEFAULT_MAX_DETOUR_KM } from "../services/route-corridor-service";
// dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info, Goal 2:
// route-intent detection for opplevagent's /sok — REUSED, not reimplemented,
// verbatim from the module rettfrabonden.com's own /sok (src/routes/seo.ts)
// already relies on. See route-intent.ts's module header for why this must
// stay a strict whole-string resolver + reluctant heuristic, unmodified.
import { resolveRouteIntent, detectRouteIntent, reiseUrlFor } from "../services/route-intent";
import { getDb as getExpDbForReise } from "../database/db-factory";
import {
  createBooking,
  getBookingByRef,
  BookingInputSchema,
  sendBookingConfirmation,
  // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0
  isBookingPaused,
  // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
  // 1 (slice 6): the #drikkested section's dark-launch vs live CTA copy.
  bookingDispatchEnabled,
  sendProducerNotification,
  // booking-flyt-v1 "bekreft-løkka": producer confirm page (POST-mutating)
  getBookingByToken,
  resolveBooking,
  reopenBooking,
  visitTimeReached,
  // booking-flyt-v1 slice 2: pre-visit answer loop (svar / gjestesvar / status)
  getBookingByRespondToken,
  getBookingByGuestDecisionToken,
  respondTokenState,
  producerRespondConfirm,
  producerRespondDecline,
  producerSuggestTime,
  guestAcceptSuggestion,
  guestDeclineSuggestion,
  guestDecisionActionable,
  previsitOpen,
  sendPrevisitConfirmedToGuest,
  sendPrevisitDeclinedToGuest,
  sendSuggestionToGuest,
  sendGuestDecisionToProducer,
  type GardssalgBooking,
  osloDatetimeLocalToUtcIso,
  defaultBookingSlotAtDatetimeLocal,
  BOOKING_NOT_ACTIVATED_MSG,
  BOOKING_NOT_ACTIVATED_INTEREST_MSG,
} from "../services/booking-store";
import { getOaHomeCounters } from "../services/oa-home-counters";
import { agentCardUsageLogger } from "../services/mcp-usage-logger";
import { renderExperienceOgImageSvg, resolveOgAccentColor } from "../services/experience-og-image";
import { CATEGORY_COLORS, CATEGORY_COLOR_FALLBACK } from "../services/category-palette";
// dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 4
// (gårdssalg-kort-konsistens): the SAME "Navn — Sted" display-suffix parser
// admin-agents.ts already reuses for RFB producer names (its own doc comment
// at "gardssalgSearchName() «— Sted» strip") — used below to keep the
// gårdssalg catalog card's title from ever repeating the place name its own
// kommune-etikett shows.
// DEFECT FIX (2026-08-14, independent review, CHANGES-REQUESTED): also pulls
// in normaliseHint() — parseNameLocationSuffix()'s own doc comment is
// explicit that its location_hint is an UNVALIDATED corroboration signal
// ("any ' - ', en/em-dash, or trailing '(...)' is a candidate", no check
// that the text is an actual place). The review reproduced a false positive
// on the very first plausible non-location hyphenated name tried: a
// provider named "Ren - Ekte Gard" (a tagline, not a place) with no
// poststed/kommune/fylke in the DB got its title silently truncated to
// "Ren" and "Ekte Gard" displayed as if it were a kommune-etikett. Fix:
// gardssalgCardTitleAndSted() below now only strips the title / shows a
// label when a REAL DB poststed/kommune/fylke value corroborates the parsed
// suffix — normaliseHint() lets that comparison use the exact same
// normalisation the parser itself already applies to location_hint, instead
// of re-implementing it here.
import { parseNameLocationSuffix, normaliseHint } from "../services/location-suffix-parser";

const router = Router();

// Lazy, one-shot backfill of experience_providers.slug (additive migration).
let _providerSlugBackfillDone = false;
function ensureProviderSlugs(): void {
  if (!_providerSlugBackfillDone) {
    _providerSlugBackfillDone = true;
    try { backfillProviderSlugs(); } catch { /* DB not yet open */ }
  }
}

const OPPLEVAGENT_BASE_URL =
  process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no";

function baseUrl(): string {
  return OPPLEVAGENT_BASE_URL.replace(/\/$/, "");
}

// ═══════════════════════════════════════════════════════════
// pwaHeadTags() — dev-request 2026-08-24-pwa-ikoner-alle-vertikaler-og-
// verifisering: extends the already-shipped rfb-only PWA rollout
// (dev-request 2026-07-04-app-strategi-pwa, PRs #225/#245) to opplevagent.no.
//
// Interpolated into every one of this file's ~10 page-shell <head> templates
// (homepage, opplevelse-detail, renderBrowsePage — shared by
// /opplevelser, /kategori/*, /fylke/*, /kommune/*, /tilbyder/* —, /sok,
// /for-tilbydere, /kontakt, /guide-opplevelser-mcp, /reise, the legal pages,
// and the 404 catch-all), right after each one's existing
// `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` line. A
// single shared helper (instead of pasting the block ~10 times by hand)
// makes it mechanically verifiable that every page shell got the same tags
// — see the page-shell PWA-tag assertions in the opplevagent PWA route
// tests, which would catch a future page template that forgets to call
// this.
//
// `includeThemeColor` defaults to true (emits the manifest's coral
// `#ff5d3b` theme-color). Four existing head blocks (homepage,
// renderOpplevelseDetail, renderBrowsePage, /sok) already declare their own
// `<meta name="theme-color" content="#0e3c36">` earlier in the same
// <head> — those callers pass `includeThemeColor: false` so this helper
// doesn't emit a second, conflicting theme-color meta tag on those pages
// (browsers generally honor the LAST theme-color meta in the document, so a
// second tag here would silently override the page's chosen #0e3c36 with
// #ff5d3b instead of leaving it alone). Pages with no pre-existing
// theme-color meta get the manifest's #ff5d3b for free.
//
// This file only ever renders on the opplevagent.no host (see the
// host-gate in src/index.ts), so — unlike seo.ts's rfb equivalent — the
// service-worker registration script here does NOT need the
// `!/finn-tannlege\.com|opplevagent\.no/.test(location.hostname)` exclusion
// guard: it always registers this host's own /sw.js.
function pwaHeadTags(opts: { includeThemeColor?: boolean } = {}): string {
  const themeColorTag =
    opts.includeThemeColor === false
      ? ""
      : `\n<meta name="theme-color" content="#ff5d3b">`;
  return `<link rel="icon" href="/favicon-192.png" sizes="192x192" type="image/png">
<link rel="icon" href="/favicon-512.png" sizes="512x512" type="image/png">
<link rel="manifest" href="/manifest.json">${themeColorTag}
<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>
<script defer src="/install-prompt.js"></script>`;
}

// Exported: reused by src/services/experience-og-image.ts (per-page branded
// og:image SVGs, dev-request 2026-07-12-opplevagent-serp-innholdsberikelse
// item 3) so untrusted DB text (provider names, kommune names, …) gets the
// exact same `& < > " '` escaping there as everywhere else in this file —
// XML escaping doesn't differ from HTML escaping for that character set.
export function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Categories are read lazily + defensively — if the experiences DB isn't
// open (flag off in some context) we just render the landing without them.
// «Konstellasjon» brand mark (logo spec, Konsept 02): three agent nodes + a coral
// spark = the perfect match found. Light variant for cream surfaces, dark variant
// lightens the earth tones for dark surfaces (footer/hero).
function brandMarkSvg(variant: "light" | "dark" = "light"): string {
  const olive = variant === "dark" ? "#a7b56e" : "#6f7a4f";
  const gold = variant === "dark" ? "#e0a43b" : "#c98a2b";
  const op = variant === "dark" ? "0.55" : "0.45";
  return `<svg viewBox="0 0 52 48" width="35" height="32" fill="none" aria-hidden="true" focusable="false"><path d="M9 33 L24 11 L43 19 L31 38 Z" fill="none" stroke="#12a594" stroke-width="2" stroke-linejoin="round" opacity="${op}"/><circle cx="9" cy="33" r="4" fill="#12a594"/><circle cx="43" cy="19" r="4" fill="${olive}"/><circle cx="31" cy="38" r="4" fill="${gold}"/><path d="M24 3 C25.1 8.9 26.9 10.7 32.8 11.8 C26.9 12.9 25.1 14.7 24 20.6 C22.9 14.7 21.1 12.9 15.2 11.8 C21.1 10.7 22.9 8.9 24 3 Z" fill="#ff5d3b"/></svg>`;
}
function brandInner(variant: "light" | "dark" = "light"): string {
  return `<span class="mark" aria-hidden="true">${brandMarkSvg(variant)}</span><span class="brand-word">opplevagent<span class="tld">.no</span></span>`;
}

// ─────────────────────────────────────────────────────────────
// Shared opplevagent.no site chrome (dev-request
// 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S1).
// One nav + one footer + one CSS block, adopted page by page — S1 covers the
// landing page ("/") and /kategori/gardssalg; later slices migrate the rest.
// The mobile nav is a pure-CSS checkbox hack (no JS dependency): the
// visually-hidden-but-focusable #oa-nav-toggle checkbox drives
// `#oa-nav-toggle:checked ~ .nav-links` — the tiny inline script below only
// adds aria-expanded as progressive enhancement.
// ─────────────────────────────────────────────────────────────
type OaNavActive = "hjem" | "opplevelser" | "kategorier" | "gardssalg" | "tilbydere";

// ─────────────────────────────────────────────────────────────
// dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent: language
// switcher on every opplevagent page + EN/SV chrome labels for the two
// profile pages (experience detail, gårdssalg producer). ALL of it is behind
// OPPLEVAGENT_LANG_SWITCHER_ENABLED (read fresh per request): with the flag
// off, the only pages that pass `lang` into oaSiteNav()/oaSiteFooter() are the
// two that already did (landing, MCP guide), and every NO-canonical page
// renders exactly as before. Translated BODY text is a separate flag
// (PROFILE_TRANSLATIONS_SERVE_ENABLED, see services/profile-translations.ts).
// ─────────────────────────────────────────────────────────────
export function isOpplevagentLangSwitcherEnabled(): boolean {
  return process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED === "true";
}

/** Locales the opplevagent switcher offers right now (sv only when enabled). */
function oaSwitcherLangs(): Lang[] {
  return isSvLocaleEnabled() ? ["no", "en", "sv"] : ["no", "en"];
}

/** hreflang <link> block for a NO-canonical path (e.g. "/opplevelse/foo"). */
function oaHreflangLinks(url: string, noPath: string): string {
  const lines = [
    `<link rel="alternate" hreflang="nb" href="${url}${noPath === "/" ? "" : noPath}">`,
    `<link rel="alternate" hreflang="en" href="${url}${localizedPath(noPath, "en")}">`,
  ];
  if (isSvLocaleEnabled()) lines.push(`<link rel="alternate" hreflang="sv" href="${url}${localizedPath(noPath, "sv")}">`);
  lines.push(`<link rel="alternate" hreflang="x-default" href="${url}${noPath === "/" ? "" : noPath}">`);
  return lines.join("\n");
}

/** Chrome labels for the two profile pages. `no` is byte-for-byte the
 *  pre-existing inline copy; en/sv are used only when the switcher flag is on. */
function oaProfileLabels(lang: Lang) {
  const no = {
    skip: "Hopp til innhold", crumbs: "Brødsmuler", crumbsGs: "Brødsmulesti", home: "Forsiden",
    factsCaption: "Fakta om opplevelsen",
    fCategory: "Kategori", fFylke: "Fylke", fKommune: "Kommune", fIndoor: "Inne / ute", fSeason: "Sesong", fDuration: "Varighet",
    fGroup: "Gruppe", fPrice: "Pris", fLanguages: "Språk", fAccess: "Tilgjengelighet", fMeeting: "Oppmøte",
    approx: "ca.", min: "min", persons: "personer", upTo: "inntil", from: "fra", perPerson: " pr. person", perGroup: " pr. gruppe", kr: "kr",
    booking: "Bestilling", provider: "Tilbyder", place: "Sted",
    ctaBook: "Book / les mer hos tilbyder →", ctaSite: "Besøk tilbyderens nettside →", ctaSoft: "Bestilling skjer hos tilbyder. Kontaktinfo kommer.",
    phone: "Telefon", provVerified: "✓ Verifisert mot Brønnøysundregistrene", provPending: "Tilbyder under verifisering.",
    provAll: "Alle opplevelser fra denne tilbyderen →", provUnmatched: "Tilbyder er ikke matchet ennå.",
    gsKicker: "Gårdssalg &amp; smaking", gsCrumb: "Gårdssalg og smaking", gsAbout: "Om produsenten", gsVisit: "Besøket", gsPractical: "Praktisk info",
    gsReserve: "Reserver", gsAddress: "Adresse", gsHours: "Åpningstider", gsSite: "Nettside", gsEmail: "E-post",
    gsMeta: (navn: string, sted: string) => `Besøk ${navn}${sted ? " i " + sted : ""} — book en smaking eller omvisning direkte hos produsenten på Opplevagent.`,
  };
  const en: typeof no = {
    skip: "Skip to content", crumbs: "Breadcrumbs", crumbsGs: "Breadcrumbs", home: "Home",
    factsCaption: "Facts about the experience",
    fCategory: "Category", fFylke: "County", fKommune: "Municipality", fIndoor: "Indoor / outdoor", fSeason: "Season", fDuration: "Duration",
    fGroup: "Group size", fPrice: "Price", fLanguages: "Languages", fAccess: "Accessibility", fMeeting: "Meeting point",
    approx: "approx.", min: "min", persons: "people", upTo: "up to", from: "from", perPerson: " per person", perGroup: " per group", kr: "NOK",
    booking: "Booking", provider: "Provider", place: "Location",
    ctaBook: "Book / read more at the provider →", ctaSite: "Visit the provider's website →", ctaSoft: "Booking is handled by the provider. Contact details coming.",
    phone: "Phone", provVerified: "✓ Verified against the Norwegian business registry", provPending: "Provider verification pending.",
    provAll: "All experiences from this provider →", provUnmatched: "Provider not matched yet.",
    gsKicker: "Farm sales &amp; tasting", gsCrumb: "Farm sales and tasting", gsAbout: "About the producer", gsVisit: "The visit", gsPractical: "Practical information",
    gsReserve: "Reserve", gsAddress: "Address", gsHours: "Opening hours", gsSite: "Website", gsEmail: "Email",
    gsMeta: (navn: string, sted: string) => `Visit ${navn}${sted ? " in " + sted : ""} — book a tasting or tour directly with the producer on Opplevagent.`,
  };
  const sv: typeof no = {
    skip: "Hoppa till innehållet", crumbs: "Brödsmulor", crumbsGs: "Brödsmulor", home: "Startsidan",
    factsCaption: "Fakta om upplevelsen",
    fCategory: "Kategori", fFylke: "Fylke", fKommune: "Kommun", fIndoor: "Inne / ute", fSeason: "Säsong", fDuration: "Varaktighet",
    fGroup: "Gruppstorlek", fPrice: "Pris", fLanguages: "Språk", fAccess: "Tillgänglighet", fMeeting: "Mötesplats",
    approx: "ca", min: "min", persons: "personer", upTo: "upp till", from: "från", perPerson: " per person", perGroup: " per grupp", kr: "NOK",
    booking: "Bokning", provider: "Arrangör", place: "Plats",
    ctaBook: "Boka / läs mer hos arrangören →", ctaSite: "Besök arrangörens webbplats →", ctaSoft: "Bokning sker hos arrangören. Kontaktuppgifter kommer.",
    phone: "Telefon", provVerified: "✓ Verifierad mot Brønnøysundregistrene", provPending: "Arrangören verifieras.",
    provAll: "Alla upplevelser från denna arrangör →", provUnmatched: "Arrangören är inte matchad ännu.",
    gsKicker: "Gårdsförsäljning &amp; provsmakning", gsCrumb: "Gårdsförsäljning och provsmakning", gsAbout: "Om producenten", gsVisit: "Besöket", gsPractical: "Praktisk information",
    gsReserve: "Reservera", gsAddress: "Adress", gsHours: "Öppettider", gsSite: "Webbplats", gsEmail: "E-post",
    gsMeta: (navn: string, sted: string) => `Besök ${navn}${sted ? " i " + sted : ""} — boka en provsmakning eller visning direkt hos producenten på Opplevagent.`,
  };
  if (lang === "en") return en;
  if (lang === "sv") return sv;
  return no;
}

function oaSiteNav(opts: { active?: OaNavActive; lang?: Lang; path?: string; switcher?: boolean } = {}): string {
  const lang: Lang = opts.lang === "en" || opts.lang === "sv" ? opts.lang : "no";
  const S = homeStrings(lang);
  const navGardssalg = lang === "en" ? "Farm sales" : lang === "sv" ? "Gårdsförsäljning" : "Gårdssalg";
  // Anchor links must stay on the visitor's language: the EN landing page
  // lives at /en, so a hardcoded "/#kategorier" would bounce EN visitors to
  // the Norwegian front page.
  const langPrefix = lang === "no" ? "/" : `/${lang}`;
  const cur = (k: OaNavActive) => (opts.active === k ? ' aria-current="page"' : "");
  // The language switcher is rendered when the calling page is genuinely
  // multilingual (the landing page passes `lang`; browse pages are
  // NO-canonical and pass none) OR when the caller asks for it explicitly
  // (`switcher: true`, only ever passed while OPPLEVAGENT_LANG_SWITCHER_ENABLED).
  // Links preserve the current page (localizedPath of the NO-canonical
  // `path`) instead of always bouncing to the front page.
  const showSwitcher = opts.switcher ?? opts.lang !== undefined;
  const noPath = opts.path || "/";
  const switchLabel: Record<Lang, string> = { no: "NO", en: "EN", sv: "SV" };
  const switchAria: Record<Lang, string> = { no: "Bytt til norsk", en: "Switch to English", sv: "Byt till svenska" };
  const langToggle = showSwitcher
    ? oaSwitcherLangs()
        .filter((l) => l !== lang)
        .map((l) => `
      <a class="lang-toggle" href="${localizedPath(noPath, l)}" hreflang="${htmlLangAttr(l)}" aria-label="${switchAria[l]}" style="border:1px solid var(--line);border-radius:var(--r-pill);padding:5px 11px;font-size:.8rem;font-weight:600;color:var(--ink-soft)">${switchLabel[l]}</a>`)
        .join("")
    : "";
  return `<header class="site-nav">
  <div class="nav-inner">
    <a class="brand" href="/" aria-label="${S.brandAria}"${cur("hjem")}>${brandInner("light")}</a>
    <input type="checkbox" id="oa-nav-toggle" class="nav-toggle">
    <label for="oa-nav-toggle" class="nav-burger" aria-label="${lang === "en" ? "Menu" : "Meny"}"><span></span><span></span><span></span></label>
    <nav class="nav-links" aria-label="${S.navAria}">
      <a href="/opplevelser"${cur("opplevelser")}>${S.navAll}</a>
      <a href="${langPrefix}#kategorier"${cur("kategorier")}>${S.navCategories}</a>
      <a href="/kategori/gardssalg"${cur("gardssalg")}>${navGardssalg}</a>
      <a href="/for-tilbydere"${cur("tilbydere")}>${S.navProviders}</a>${langToggle}
      <a class="nav-cta" href="/opplevelser">${S.navExplore}</a>
    </nav>
  </div>
  <script>
  /* Progressive enhancement only — the checkbox hack works without JS. */
  (function(){var t=document.getElementById('oa-nav-toggle'),b=document.querySelector('label.nav-burger');if(!t||!b)return;
  var sync=function(){b.setAttribute('aria-expanded',t.checked?'true':'false');};sync();t.addEventListener('change',sync);})();
  </script>
</header>`;
}

function oaSiteFooter(opts: { lang?: Lang } = {}): string {
  const lang: Lang = opts.lang === "en" || opts.lang === "sv" ? opts.lang : "no";
  const S = homeStrings(lang);
  // Same lang-aware anchor prefix as oaSiteNav — EN anchors live under /en.
  const langPrefix = lang === "no" ? "/" : `/${lang}`;
  const year = new Date().getFullYear();
  return `<footer class="site-footer" role="contentinfo">
  <div class="footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="${S.brandAria}">${brandInner("dark")}</a>
      <p>${S.footTagline}</p>
    </div>
    <div class="footer-col">
      <h4>${S.footExplore}</h4>
      <a href="/opplevelser">${S.navAll}</a>
      <a href="${langPrefix}#kategorier">${S.navCategories}</a>
      <a href="${langPrefix}#slik-funker-det">${S.navHow}</a>
      <a href="/for-tilbydere">${S.navProviders}</a>
      <!-- dev-request 2026-08-08-opplevagent-slik-fungerer-det: the producer-
           facing explainer the outreach email points at. NO-only for now —
           the page itself is Norwegian, so an EN footer link would promise a
           translation that does not exist (same honesty rule the rest of this
           file follows for language). -->
      ${lang !== "no" ? "" : `<a href="/slik-fungerer-det">Slik fungerer det</a>`}
      <a href="/kontakt">${lang === "en" ? "Contact us" : lang === "sv" ? "Kontakta oss" : "Kontakt oss"}</a>
    </div>
    <div class="footer-col">
      <h4>${S.footAgents}</h4>
      <a href="/llms.txt" target="_blank" rel="noopener"><code>llms.txt</code></a>
      <a href="/.well-known/agent-card.json" target="_blank" rel="noopener"><code>agent-card.json</code></a>
      <a href="/mcp" target="_blank" rel="noopener"><code>/mcp</code> (MCP)</a>
      <a href="/openapi.json" target="_blank" rel="noopener"><code>openapi.json</code></a>
      <a href="/api/opplevelser/discover" target="_blank" rel="noopener"><code>/api/opplevelser</code></a>
    </div>
  </div>
  <div class="footer-bottom">
    <span>&copy; ${year} Opplevagent &middot; <a href="/personvern" style="color:rgba(255,255,255,.62)">${S.footPrivacy}</a> &middot; <a href="/vilkar" style="color:rgba(255,255,255,.62)">${S.footTerms}</a></span>
    <span class="verified"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12 L11 14.5 L15.5 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> ${S.footVerified}</span>
  </div>
</footer>`;
}

// Nav + footer + hamburger CSS for the shared chrome. The landing page embeds
// this INSTEAD of its old header/footer blocks; /kategori/gardssalg appends it
// AFTER BROWSE_CSS (whose slim `.nav-links a{…;margin-left:22px}` /
// `.nav-inner{height:58px}` rules this deliberately overrides — hence the
// explicit `margin-left:0`). Do NOT fold this into BROWSE_CSS itself: every
// other browse page still renders the slim pre-chrome nav until a later slice
// migrates it.
const OA_CHROME_CSS = `
  /* ── SHARED SITE CHROME: header/nav ── */
  .site-nav{position:sticky;top:0;z-index:100;background:rgba(244,248,244,.86);backdrop-filter:saturate(160%) blur(12px);border-bottom:1px solid var(--line)}
  .nav-inner{position:relative;max-width:var(--maxw);margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
  @media(max-width:560px){.nav-inner{padding:0 16px}}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.16rem;letter-spacing:-.02em;color:var(--fjord-800);text-decoration:none}
  .brand:hover{text-decoration:none}
  .brand-word{font-family:var(--font-brand);font-weight:600;font-size:1.3rem;letter-spacing:-.015em;text-transform:lowercase;line-height:1;color:var(--ink)}
  .brand-word .tld{color:var(--fjord-600)}
  .brand .mark{display:flex;align-items:center;justify-content:center}
  .brand .mark svg{display:block}
  .nav-links{display:flex;gap:26px;align-items:center}
  .nav-links a{font-size:.88rem;font-weight:600;color:var(--ink-soft);margin-left:0}
  .nav-links a:hover{color:var(--fjord-700)}
  .nav-cta{padding:8px 16px;border-radius:var(--r-pill);background:var(--fjord-800);color:#fff!important;font-size:.84rem;font-weight:700}
  .nav-cta:hover{background:var(--fjord-700);text-decoration:none!important}
  /* Hamburger toggle: checkbox is visually hidden but stays FOCUSABLE
     (keyboard: tab to it, space toggles) — never display:none. */
  .nav-toggle{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
  .nav-toggle:focus-visible~.nav-burger{outline:3px solid var(--amber-500);outline-offset:2px;border-radius:4px}
  .nav-burger{display:none;flex-direction:column;justify-content:center;gap:5px;width:42px;height:42px;padding:10px;cursor:pointer}
  .nav-burger span{display:block;height:2px;width:100%;background:var(--ink);border-radius:2px}
  /* Desktop: the checkbox hack is a mobile-only affordance — remove it from
     the tab order entirely so keyboard users never focus an invisible
     control (the mobile rules below never see this display:none). */
  @media(min-width:761px){.nav-toggle{display:none}}
  @media(max-width:760px){
    .nav-burger{display:flex}
    /* Collapsed by default; #oa-nav-toggle:checked reveals the panel. The
       sticky nav itself is translucent + backdrop-blur, so the dropdown
       panel gets a SOLID var(--surface) background for contrast. */
    .nav-links{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:stretch;gap:0;background:var(--surface);border-bottom:1px solid var(--line);box-shadow:var(--sh-md);padding:8px 16px 16px}
    #oa-nav-toggle:checked~.nav-links{display:flex}
    .nav-links a{padding:12px 8px;border-bottom:1px solid var(--line);font-size:.95rem;margin-left:0}
    .nav-links a.lang-toggle{align-self:flex-start;border-bottom:0;margin-top:10px}
    .nav-links a.nav-cta{margin-top:10px;text-align:center;border-bottom:0}
  }
  /* ── SHARED SITE CHROME: footer ── */
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
`;

// ─────────────────────────────────────────────────────────────
// Illustrated hero scene (dev-request
// 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S2).
// Hand-drawn, layered SVG silhouettes that sit BEHIND the hero text
// (absolute inset:0; .hero-inner / .hero-section>.container carry z-index:1)
// so the dark hero gradient + white AA-contrast text are untouched. Two
// motifs, one palette (the page's own tokens only — fjord silhuettes as
// rgba(#0b2e29)/rgba(#18130d), copper #c98a2b at low opacity, #12a594/#ff5d3b
// glows via <radialGradient>):
//   "forside" — neutral fjord/farm silhouettes in three depth layers
//               (replaces the old two-path .hero-range mountain strip, whose
//               role the darkest bottom layer takes over). S2b (dev-request
//               2026-08-06, Daniel's directive): the distillery identity
//               belongs to the gardssalg surfaces ONLY, so the copper
//               pot-still + its steam were REMOVED from this motif — the
//               landscape itself is byte-identical to its S2 form.
//   "drikke"  — copper kettle + barrels + apple-orchard/hop hints; used on
//               the /kategori/gardssalg hero (and only there — the homepage
//               keeps the broader forside motif).
// The drikke kettle steam (class="steam") animates via ONE @keyframes rule
// that lives EXCLUSIVELY inside @media (prefers-reduced-motion: no-preference)
// in OA_HERO_SCENE_CSS below — reduced-motion visitors get a static wisp.
// No JS anywhere. Every layer's fill opacity stays ≤ .6 under the text zone.
// Exported for the S2 test suite's per-variant size assertion (each variant
// must stay well under 50 000 chars — target ~12 kB).
// ─────────────────────────────────────────────────────────────
export function heroSceneSvg(motif: "forside" | "drikke"): string {
  const open = (cls: string) =>
    `<svg class="hero-scene ${cls}" viewBox="0 0 1440 480" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">`;
  if (motif === "forside") {
    // Gradient ids are motif-prefixed (oaHsF-/oaHsD-) so both motifs could
    // coexist in one document without id collisions.
    //
    // COMPOSITION (S2 review fix, 9e1559e CHANGES-REQUESTED B1): the hero
    // renders ~737px tall against this 480-unit viewBox, so `xMidYMax slice`
    // upscales ~1.5× and CROPS horizontally — the guaranteed-visible band is
    // only x≈303–1137 at 1280px viewport (x≈253–1187 at 1440px) and
    // x≈596–844 on a 360px phone. Every figurative element therefore lives
    // in-band: the farm cluster (tree/house/barn/fence/tree) spans x≈600–856
    // so the PHONE crop gets real character around x≈720. The x<300 / x>1140
    // margins carry only depth layers + edge trees that progressively appear
    // on wider viewports — nothing load-bearing. (S2b removed the copper
    // pot-still that used to sit at x≈956–1110 — see the motif comment above.)
    return `${open("hero-scene-forside")}
<defs>
<radialGradient id="oaHsF-teal" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#12a594" stop-opacity=".30"/><stop offset="100%" stop-color="#12a594" stop-opacity="0"/></radialGradient>
<radialGradient id="oaHsF-coral" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ff5d3b" stop-opacity=".24"/><stop offset="100%" stop-color="#ff5d3b" stop-opacity="0"/></radialGradient>
</defs>
<ellipse cx="430" cy="330" rx="430" ry="190" fill="url(#oaHsF-teal)"/>
<ellipse cx="1040" cy="360" rx="390" ry="175" fill="url(#oaHsF-coral)"/>
<path fill="rgba(11,46,41,.30)" d="M0 336 C96 318 178 288 268 282 C364 275 430 300 520 302 C628 305 700 262 806 254 C900 247 964 274 1060 280 C1170 287 1252 258 1348 262 C1384 264 1416 272 1440 280 L1440 480 L0 480 Z"/>
<path fill="none" stroke="rgba(18,165,148,.16)" stroke-width="3" stroke-linecap="round" d="M330 372 C470 366 600 368 726 372 M800 380 C930 374 1056 376 1180 380"/>
<path fill="rgba(11,46,41,.46)" d="M0 402 C84 384 160 366 252 368 C348 370 420 392 516 396 C640 401 748 372 862 374 C980 376 1072 398 1180 402 C1272 405 1362 396 1440 400 L1440 480 L0 480 Z"/>
<g fill="rgba(11,46,41,.55)">
<path d="M660 390 L660 352 L684 332 L708 352 L708 390 Z"/>
<path d="M716 390 L716 356 L760 356 L760 390 Z"/>
<path d="M710 356 L738 338 L766 356 Z"/>
</g>
<path fill="none" stroke="rgba(11,46,41,.50)" stroke-width="3" stroke-linecap="round" d="M772 384 H816 M780 376 V384 M792 376 V384 M804 376 V384"/>
<g fill="rgba(11,46,41,.52)">
<path d="M600 400 L614 352 L628 400 Z"/>
<path d="M830 394 L843 350 L856 394 Z"/>
</g>
<path fill="rgba(24,19,13,.58)" d="M0 452 C120 436 232 424 366 428 C512 432 618 448 764 450 C918 452 1030 436 1170 438 C1272 440 1366 448 1440 450 L1440 480 L0 480 Z"/>
<g fill="rgba(24,19,13,.60)">
<path d="M84 450 L98 400 L112 450 Z"/>
<path d="M118 452 L129 412 L140 452 Z"/>
<path d="M1244 446 L1258 398 L1272 446 Z"/>
<path d="M1284 448 L1296 410 L1308 448 Z"/>
</g>
</svg>`;
  }
  return `${open("hero-scene-drikke")}
<defs>
<radialGradient id="oaHsD-teal" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#12a594" stop-opacity=".28"/><stop offset="100%" stop-color="#12a594" stop-opacity="0"/></radialGradient>
<radialGradient id="oaHsD-coral" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ff5d3b" stop-opacity=".26"/><stop offset="100%" stop-color="#ff5d3b" stop-opacity="0"/></radialGradient>
</defs>
<ellipse cx="360" cy="360" rx="420" ry="180" fill="url(#oaHsD-teal)"/>
<ellipse cx="1050" cy="340" rx="410" ry="190" fill="url(#oaHsD-coral)"/>
<path fill="rgba(11,46,41,.32)" d="M0 388 C140 370 260 358 420 362 C600 366 720 344 900 348 C1080 352 1200 368 1320 372 C1370 374 1412 378 1440 380 L1440 480 L0 480 Z"/>
<g fill="rgba(11,46,41,.42)">
<circle cx="150" cy="350" r="22"/><path d="M147 366 h6 v22 h-6 Z"/>
<circle cx="216" cy="342" r="18"/><path d="M213 356 h6 v24 h-6 Z"/>
<circle cx="282" cy="350" r="21"/><path d="M279 366 h6 v22 h-6 Z"/>
</g>
<g fill="rgba(255,93,59,.28)"><circle cx="142" cy="346" r="3.2"/><circle cx="158" cy="354" r="3.2"/><circle cx="222" cy="338" r="3"/><circle cx="288" cy="346" r="3"/></g>
<path fill="none" stroke="rgba(11,46,41,.40)" stroke-width="4" stroke-linecap="round" d="M336 258 C356 270 370 284 376 300 M404 264 C412 280 414 294 410 310"/>
<g fill="rgba(11,46,41,.40)">
<path d="M376 300 C364 300 357 311 359 325 C360 337 367 346 376 346 C385 346 392 337 393 325 C395 311 388 300 376 300 Z"/>
<path d="M410 310 C400 310 394 319 396 331 C397 341 403 348 410 348 C417 348 423 341 424 331 C426 319 420 310 410 310 Z"/>
</g>
<path fill="rgba(24,19,13,.55)" d="M0 446 C160 432 300 424 470 428 C660 432 790 446 950 448 C1110 450 1260 440 1440 444 L1440 480 L0 480 Z"/>
<g>
<rect x="620" y="386" width="66" height="60" rx="12" fill="rgba(24,19,13,.60)"/>
<path d="M624 404 H682 M624 428 H682" stroke="rgba(201,138,43,.34)" stroke-width="4" fill="none"/>
<rect x="700" y="398" width="54" height="48" rx="10" fill="rgba(24,19,13,.50)"/>
<path d="M703 412 H751 M703 432 H751" stroke="rgba(201,138,43,.30)" stroke-width="3.5" fill="none"/>
</g>
<g>
<path fill="rgba(201,138,43,.34)" d="M886 446 C886 380 916 346 972 346 C1028 346 1058 380 1058 446 Z"/>
<path fill="rgba(201,138,43,.34)" d="M920 346 C926 320 946 306 972 306 C998 306 1018 320 1024 346 Z"/>
<path fill="none" stroke="rgba(201,138,43,.38)" stroke-width="7" stroke-linecap="round" d="M972 306 C972 288 982 278 1002 275 C1056 267 1092 288 1104 324 L1114 446"/>
<path fill="none" stroke="rgba(24,19,13,.24)" stroke-width="4" d="M896 408 H1048"/>
<rect x="1094" y="398" width="46" height="48" rx="7" fill="rgba(201,138,43,.24)"/>
</g>
<g class="steam" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="6" stroke-linecap="round">
<path d="M960 288 C952 270 964 258 956 240 C950 226 960 214 954 198"/>
<path d="M986 292 C996 276 984 262 994 246 C1002 233 992 220 1000 204"/>
</g>
</svg>`;
}

// Positioning + the ONE steam animation for the hero scene. The @keyframes
// rule intentionally lives INSIDE the prefers-reduced-motion:no-preference
// block (not merely the animation-name binding) so reduced-motion UAs never
// even parse a motion definition — statically the steam just sits at its
// base opacity. Shared verbatim by the homepage hero and the
// /kategori/gardssalg .hero-section.
const OA_HERO_SCENE_CSS = `
  /* ── HERO SCENE (S2 illustrated backdrop) ── */
  .hero-scene{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .hero-scene .steam{opacity:.5}
  @media (prefers-reduced-motion: no-preference){
    .hero-scene .steam{animation:oaSteamRise 10s ease-in-out infinite}
    @keyframes oaSteamRise{0%{transform:translateY(0);opacity:0}18%{opacity:.55}70%{opacity:.3}100%{transform:translateY(-46px);opacity:0}}
  }
`;

// ─────────────────────────────────────────────────────────────
// Gardssalg still sketch (dev-request 2026-08-06-opplevagent-ux-loft-
// drikkested-lansering, S2b — Daniel's directive: the distillery identity
// belongs to /kategori/gardssalg + its type subpages ONLY, never the
// homepage). A discreet black line drawing of a pot still (kjele →
// svanehals → kjølekar/kondensator → rør → flaske) composed across the
// WHOLE light catalog surface — including the page margins beside the
// content column — as an absolutely positioned backdrop UNDER the cards
// (`.oa-sketch-stage` wraps <main>; the sketch layer is inset:0,
// pointer-events:none, z-index:0; main gets z-index:1). Legibility is
// protected by the whole layer sitting at opacity ~.15 with thin
// #0b2e29 strokes.
//
// Animation (pure CSS, no JS — see OA_STILL_SKETCH_CSS below): ONE shared
// 26s timeline. Each component group has its own draw window inside that
// timeline (every path carries pathLength="1", so `stroke-dasharray:1` +
// a dashoffset 1→0 keyframe draws it "pen on paper"): kjele 2–16%, hals
// 15–24%, kjølekar 23–36%, rør 35–45%, flaske 44–54%, margin décor
// 20–56%; then the LIQUID (class sk-vaeske — a thicker copper path laid
// over the black pipework, from the kettle through the swan neck, down
// through the worm tub, along the pipe and into the bottle) flows in at
// 58–76%; the finished picture holds until ~92%, fades out by 97%, and
// the cycle loops from blank. All dasharray/animation declarations —
// and every @keyframes — live EXCLUSIVELY inside
// @media (prefers-reduced-motion: no-preference) (same discipline as the
// hero steam above), so reduced-motion UAs get the STATIC fully drawn
// picture, liquid included, without ever parsing a motion definition.
//
// Responsive: two <svg> crops of the SAME hand-written composition
// (viewBox 0 0 1440 1560). `.sketch-wide` (full-width, xMidYMin meet —
// deterministic scaling, art also lands in the side margins) renders
// above 700px; `.sketch-narrow` shows the simplified central crop
// (kettle → swan neck → worm tub + the barrel) for phones, so a ~360px
// screen reads a real drawing instead of a smeared full scene. Only one
// is displayed at a time (CSS media query) and neither can cause
// horizontal scroll (the layer is inset:0 + overflow:hidden).
//
// Exported for the S2b tests' size assertion — the whole layer must stay
// hand-written and < 50 000 chars.
// ─────────────────────────────────────────────────────────────
export function gardssalgStillSketchSvg(): string {
  // One shared inner scene; the two <svg> wrappers below only differ in
  // class + viewBox (the narrow one is a crop, not a second drawing). No
  // ids anywhere, so the duplication can't collide.
  const scene = `<g class="sk-all">
<g class="sk-kjele">
<path pathLength="1" d="M132 648 C114 540 160 446 252 440 C344 446 390 540 372 648"/>
<path pathLength="1" d="M148 648 C180 664 324 664 356 648"/>
<path pathLength="1" d="M170 660 L158 736 H346 L334 660"/>
<path pathLength="1" d="M226 736 C230 706 274 706 278 736"/>
<path pathLength="1" d="M210 442 C204 400 220 368 252 362 C284 368 300 400 294 442"/>
<path pathLength="1" d="M206 444 H298"/>
</g>
<g class="sk-hals">
<path pathLength="1" d="M252 362 C254 316 278 292 320 288 C400 282 468 320 524 380 C556 414 584 442 610 468"/>
<path pathLength="1" d="M262 366 C266 330 284 306 322 302 C396 296 458 330 512 388 C544 422 572 450 598 474"/>
</g>
<g class="sk-kond">
<path pathLength="1" d="M600 472 C600 456 864 456 864 472 C864 488 600 488 600 472"/>
<path pathLength="1" d="M600 474 C596 548 596 622 604 692"/>
<path pathLength="1" d="M864 474 C868 548 868 622 860 692"/>
<path pathLength="1" d="M604 692 C660 706 804 706 860 692"/>
<path pathLength="1" d="M612 516 C700 534 764 534 852 516"/>
<path pathLength="1" d="M614 562 C702 580 766 580 850 562"/>
<path pathLength="1" d="M616 608 C704 626 768 626 848 608"/>
</g>
<g class="sk-ror">
<path pathLength="1" d="M860 648 H1002 C1062 648 1100 610 1140 570 C1180 530 1238 510 1286 510 C1296 510 1302 516 1302 524"/>
<path pathLength="1" d="M1000 634 V662"/>
<path pathLength="1" d="M988 634 H1012"/>
<path pathLength="1" d="M1142 572 V704"/>
<path pathLength="1" d="M1126 704 H1158"/>
</g>
<g class="sk-flaske">
<path pathLength="1" d="M1283 512 V548 C1262 568 1254 598 1254 638 V754 C1254 768 1262 776 1276 776 H1326 C1340 776 1348 768 1348 754 V638 C1348 598 1340 568 1319 548 V512"/>
<path pathLength="1" d="M1279 512 H1323"/>
<path pathLength="1" d="M1268 664 H1334"/>
<path pathLength="1" d="M1268 700 H1334"/>
</g>
<g class="sk-dekor">
<path pathLength="1" d="M236 344 C228 324 240 310 232 288"/>
<path pathLength="1" d="M268 346 C278 328 266 312 276 292"/>
<path pathLength="1" d="M92 744 H430"/>
<path pathLength="1" d="M566 712 H900"/>
<path pathLength="1" d="M1234 782 H1368"/>
<path pathLength="1" d="M96 1188 C86 1252 86 1330 96 1390"/>
<path pathLength="1" d="M244 1188 C254 1252 254 1330 244 1390"/>
<path pathLength="1" d="M96 1188 C140 1176 200 1176 244 1188"/>
<path pathLength="1" d="M96 1390 C140 1402 200 1402 244 1390"/>
<path pathLength="1" d="M90 1248 C140 1258 200 1258 250 1248"/>
<path pathLength="1" d="M90 1330 C140 1340 200 1340 250 1330"/>
<path pathLength="1" d="M70 1398 H280"/>
<path pathLength="1" d="M1168 1290 H1384 V1392 H1168 Z"/>
<path pathLength="1" d="M1168 1330 H1384"/>
<path pathLength="1" d="M1276 1290 V1392"/>
<path pathLength="1" d="M1198 1290 V1252 C1198 1244 1202 1240 1208 1240 H1216 C1222 1240 1226 1244 1226 1252 V1290"/>
<path pathLength="1" d="M1264 1290 V1252 C1264 1244 1268 1240 1274 1240 H1282 C1288 1240 1292 1244 1292 1252 V1290"/>
<path pathLength="1" d="M1330 1290 V1252 C1330 1244 1334 1240 1340 1240 H1348 C1354 1240 1358 1244 1358 1252 V1290"/>
</g>
<g class="sk-vaeske">
<path pathLength="1" d="M252 596 V372 C256 322 282 300 322 296 C398 290 462 326 518 384 C550 418 578 446 606 470 C688 528 768 592 854 644 C862 648 872 650 880 650 H1002 C1060 650 1098 612 1138 572 C1178 532 1236 518 1282 518 C1292 518 1296 524 1296 532"/>
<path pathLength="1" d="M1300 540 V736"/>
<path pathLength="1" d="M1258 746 C1290 738 1312 738 1344 746"/>
</g>
</g>`;
  const svg = (cls: string, viewBox: string) =>
    `<svg class="${cls}" viewBox="${viewBox}" preserveAspectRatio="xMidYMin meet" aria-hidden="true" focusable="false">${scene}</svg>`;
  // The narrow crop frames the apparatus core (kettle + swan neck + worm
  // tub, steam included) tightly: on a ~360px phone the single-column cards
  // cover almost the full width, so only the top band above the grid and
  // the side slivers stay visible — a tight crop keeps what IS visible
  // reading as a real drawing instead of stray fragments.
  return `<div class="oa-still-sketch" aria-hidden="true">${svg("sketch-wide", "0 0 1440 1560")}${svg("sketch-narrow", "120 260 700 620")}</div>`;
}

// Layout + the S2b sketch animation timeline. Structure rules (positioning,
// stroke styling, the wide/narrow swap) are unguarded; EVERY motion-related
// declaration — stroke-dasharray, animation bindings and all @keyframes —
// lives inside the @media (prefers-reduced-motion: no-preference) block, so
// a reduced-motion UA renders the static finished drawing (solid strokes,
// dashoffset never touched) without parsing any motion definition.
const OA_STILL_SKETCH_CSS = `
  /* ── GARDSSALG STILL SKETCH (S2b line-drawn backdrop) ── */
  .oa-sketch-stage{position:relative}
  .oa-sketch-stage>main{position:relative;z-index:1}
  .oa-still-sketch{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
  .oa-still-sketch svg{display:block;width:100%;height:auto;opacity:.15}
  .oa-still-sketch path{fill:none;stroke:#0b2e29;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
  .oa-still-sketch .sk-vaeske path{stroke:#c98a2b;stroke-width:5}
  .oa-still-sketch .sketch-narrow{display:none}
  @media(max-width:700px){
    .oa-still-sketch .sketch-wide{display:none}
    .oa-still-sketch .sketch-narrow{display:block}
    .oa-still-sketch .sketch-narrow path{stroke-width:4}
    .oa-still-sketch .sketch-narrow .sk-vaeske path{stroke-width:7}
  }
  @media (prefers-reduced-motion: no-preference){
    .oa-still-sketch path{stroke-dasharray:1}
    .oa-still-sketch .sk-all{animation:oaSkFade 26s linear infinite}
    .oa-still-sketch .sk-kjele path{animation:oaSkKjele 26s linear infinite}
    .oa-still-sketch .sk-hals path{animation:oaSkHals 26s linear infinite}
    .oa-still-sketch .sk-kond path{animation:oaSkKond 26s linear infinite}
    .oa-still-sketch .sk-ror path{animation:oaSkRor 26s linear infinite}
    .oa-still-sketch .sk-flaske path{animation:oaSkFlaske 26s linear infinite}
    .oa-still-sketch .sk-dekor path{animation:oaSkDekor 26s linear infinite}
    .oa-still-sketch .sk-vaeske path{animation:oaSkVaeske 26s linear infinite}
    @keyframes oaSkFade{0%,92%{opacity:1}97%,100%{opacity:0}}
    @keyframes oaSkKjele{0%,2%{stroke-dashoffset:1}16%,100%{stroke-dashoffset:0}}
    @keyframes oaSkHals{0%,15%{stroke-dashoffset:1}24%,100%{stroke-dashoffset:0}}
    @keyframes oaSkKond{0%,23%{stroke-dashoffset:1}36%,100%{stroke-dashoffset:0}}
    @keyframes oaSkRor{0%,35%{stroke-dashoffset:1}45%,100%{stroke-dashoffset:0}}
    @keyframes oaSkFlaske{0%,44%{stroke-dashoffset:1}54%,100%{stroke-dashoffset:0}}
    @keyframes oaSkDekor{0%,20%{stroke-dashoffset:1}56%,100%{stroke-dashoffset:0}}
    @keyframes oaSkVaeske{0%,58%{stroke-dashoffset:1}76%,100%{stroke-dashoffset:0}}
  }
`;

// ─────────────────────────────────────────────────────────────
// Still-sketch motif lookup (dev-request 2026-08-08-opplevagent-ux-loft-
// kategorimotiver, generalizing S2b): the gårdssalg still above is the
// ONLY motif with its own hand-tuned CSS (OA_STILL_SKETCH_CSS +
// gardssalgStillSketchSvg() — both byte-for-byte UNCHANGED by this slice,
// so /kategori/gardssalg + its type subpages keep rendering identically).
// Every NEW motif (category pages + the homepage) reuses the exact same
// layering/animation/crop MACHINERY — a `.oa-sketch-stage` wrapper behind
// the page's content, two <svg> crops (wide/narrow) of one hand-written
// composition, pathLength="1" stroke-dashoffset draw-on driven by a shared
// 26s timeline (each group gets its own draw window), and EVERY
// @keyframes/dasharray/animation declaration living exclusively inside
// @media (prefers-reduced-motion: no-preference) — via buildStillSketchCss()
// below, so the technique is written once instead of copy-pasted per motif.
//
// The new motifs render under a SIBLING wrapper class, `.oa-motif-sketch`
// (not `.oa-still-sketch`) — deliberately: `.oa-still-sketch` /
// gardssalgStillSketchSvg() carry the distillery IDENTITY Daniel restricted
// to the gårdssalg surfaces only (S2b), and the existing S2b/S3 test suites
// assert the literal substring "oa-still-sketch" never appears on the
// homepage. Reusing that exact class for the new, unrelated motifs would
// make that assertion a false positive the moment any page other than
// gårdssalg rendered a sketch — so the new system gets its own class,
// keeping the old identity-separation tests both passing and meaningful.
//
// stillSketchSvg(motif) / stillSketchCss(motif) are the ONE lookup every
// new caller (the /kategori/:category route + the homepage) goes through.
// ─────────────────────────────────────────────────────────────
export type StillSketchMotif =
  | "gardssalg"
  | "kultur_historie"
  | "sightseeing_transport"
  | "natur_friluft"
  | "hjem";

interface SketchDrawGroup {
  cls: string;           // group class name, e.g. "sk-kh-kirke"
  keyframe: string;      // this group's own @keyframes name
  start: number;         // draw-start percent of the shared 26s timeline
  end: number;           // draw-end percent
  color?: string;        // stroke override — an accent pass (e.g. the aurora)
  width?: number;        // stroke-width override, wide crop (default inherits 2.6)
  narrowWidth?: number;  // stroke-width override, narrow/mobile crop
}

// Generic CSS builder shared by every NEW motif below — same technique as
// OA_STILL_SKETCH_CSS (positioning, opacity, wide/narrow swap, the
// reduced-motion guard), parameterized by that motif's own draw groups so
// each keyframe/class name is unique to its motif. Safe to reuse across
// motifs because only ONE motif's sketch is ever rendered on a given page.
// `contentSelector` lets a caller whose stage wraps something other than
// `<main>` (the homepage wraps a `<section>`'s `.container`) keep the
// z-index-lift rule scoped correctly.
function buildStillSketchCss(opts: {
  comment: string;
  groups: SketchDrawGroup[];
  fadeKeyframe: string;
  contentSelector?: string;
  narrowBaseWidth?: number;
}): string {
  const contentSel = opts.contentSelector ?? "main";
  const narrowBase = opts.narrowBaseWidth ?? 4;
  const accentWideCss = opts.groups
    .filter((g) => g.color || g.width)
    .map((g) => `  .oa-motif-sketch .${g.cls} path{${g.color ? `stroke:${g.color};` : ""}${g.width ? `stroke-width:${g.width}` : ""}}`)
    .join("\n");
  const accentNarrowCss = opts.groups
    .filter((g) => g.narrowWidth)
    .map((g) => `    .oa-motif-sketch .sketch-narrow .${g.cls} path{stroke-width:${g.narrowWidth}}`)
    .join("\n");
  const groupAnimCss = opts.groups
    .map((g) => `    .oa-motif-sketch .${g.cls} path{animation:${g.keyframe} 26s linear infinite}`)
    .join("\n");
  const groupKeyframesCss = opts.groups
    .map((g) => `    @keyframes ${g.keyframe}{0%,${g.start}%{stroke-dashoffset:1}${g.end}%,100%{stroke-dashoffset:0}}`)
    .join("\n");
  return `
  /* ── ${opts.comment} (line-drawn backdrop — same draw-on machinery as the S2b gårdssalg still) ── */
  .oa-sketch-stage{position:relative}
  .oa-sketch-stage>${contentSel}{position:relative;z-index:1}
  .oa-motif-sketch{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
  .oa-motif-sketch svg{display:block;width:100%;height:auto;opacity:.15}
  .oa-motif-sketch path{fill:none;stroke:#0b2e29;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
${accentWideCss}
  .oa-motif-sketch .sketch-narrow{display:none}
  @media(max-width:700px){
    .oa-motif-sketch .sketch-wide{display:none}
    .oa-motif-sketch .sketch-narrow{display:block}
    .oa-motif-sketch .sketch-narrow path{stroke-width:${narrowBase}}
${accentNarrowCss}
  }
  @media (prefers-reduced-motion: no-preference){
    .oa-motif-sketch path{stroke-dasharray:1}
    .oa-motif-sketch .sk-all{animation:${opts.fadeKeyframe} 26s linear infinite}
${groupAnimCss}
    @keyframes ${opts.fadeKeyframe}{0%,92%{opacity:1}97%,100%{opacity:0}}
${groupKeyframesCss}
  }
`;
}

// One hand-written scene, two <svg> crops (wide/narrow) — same aria-hidden +
// focusable="false" contract as gardssalgStillSketchSvg() above, just under
// the `.oa-motif-sketch` wrapper class instead of `.oa-still-sketch`.
function wrapStillSketchScene(scene: string, wideViewBox: string, narrowViewBox: string): string {
  const svg = (cls: string, viewBox: string) =>
    `<svg class="${cls}" viewBox="${viewBox}" preserveAspectRatio="xMidYMin meet" aria-hidden="true" focusable="false">${scene}</svg>`;
  return `<div class="oa-motif-sketch" aria-hidden="true">${svg("sketch-wide", wideViewBox)}${svg("sketch-narrow", narrowViewBox)}</div>`;
}

// ── kultur_historie: stave-church silhouette + rune stone + an old-building line ──
const KULTUR_HISTORIE_SKETCH_GROUPS: SketchDrawGroup[] = [
  { cls: "sk-kh-kirke", keyframe: "oaSkKhKirke", start: 2, end: 28 },
  { cls: "sk-kh-stein", keyframe: "oaSkKhStein", start: 26, end: 46 },
  { cls: "sk-kh-hus", keyframe: "oaSkKhHus", start: 44, end: 64 },
  { cls: "sk-kh-bakke", keyframe: "oaSkKhBakke", start: 20, end: 70 },
];
function kulturHistorieStillSketchScene(): string {
  return `<g class="sk-all">
<g class="sk-kh-kirke">
<path pathLength="1" d="M200 820 V620 H340 V820"/>
<path pathLength="1" d="M184 620 L270 560 L356 620 Z"/>
<path pathLength="1" d="M210 560 L270 518 L330 560 Z"/>
<path pathLength="1" d="M234 518 L270 490 L306 518 Z"/>
<path pathLength="1" d="M270 490 V460"/>
<path pathLength="1" d="M256 460 H284 M270 460 V446"/>
<path pathLength="1" d="M246 820 V748 H294 V820"/>
</g>
<g class="sk-kh-stein">
<path pathLength="1" d="M660 820 V700 C660 664 680 644 700 644 C720 644 740 664 740 700 V820 Z"/>
<path pathLength="1" d="M676 680 L696 720 M700 668 L700 716 M724 680 L704 720"/>
</g>
<g class="sk-kh-hus">
<path pathLength="1" d="M980 820 V712 L1070 660 L1160 712 V820 Z"/>
<path pathLength="1" d="M980 712 H1160"/>
<path pathLength="1" d="M1000 820 V760 H1032 V820"/>
<path pathLength="1" d="M1080 760 H1120 V796 H1080 Z"/>
</g>
<g class="sk-kh-bakke">
<path pathLength="1" d="M100 820 H1340"/>
</g>
</g>`;
}
export function kulturHistorieStillSketchSvg(): string {
  return wrapStillSketchScene(kulturHistorieStillSketchScene(), "0 0 1440 1000", "120 440 480 480");
}
const OA_STILL_SKETCH_KULTUR_CSS = buildStillSketchCss({
  comment: "KULTUR & HISTORIE STILL SKETCH",
  groups: KULTUR_HISTORIE_SKETCH_GROUPS,
  fadeKeyframe: "oaSkKhFade",
});

// ── sightseeing_transport: fjord boat + serpentine road + bridge/viewpoint ──
const SIGHTSEEING_TRANSPORT_SKETCH_GROUPS: SketchDrawGroup[] = [
  { cls: "sk-st-baat", keyframe: "oaSkStBaat", start: 2, end: 26 },
  { cls: "sk-st-vei", keyframe: "oaSkStVei", start: 24, end: 52 },
  { cls: "sk-st-bru", keyframe: "oaSkStBru", start: 50, end: 72 },
  { cls: "sk-st-horisont", keyframe: "oaSkStHorisont", start: 15, end: 75 },
];
function sightseeingTransportStillSketchScene(): string {
  return `<g class="sk-all">
<g class="sk-st-baat">
<path pathLength="1" d="M180 780 H340 L300 820 H220 Z"/>
<path pathLength="1" d="M230 780 V690"/>
<path pathLength="1" d="M230 700 L300 730 L230 740 Z"/>
</g>
<g class="sk-st-vei">
<path pathLength="1" d="M520 820 C560 780 620 780 640 740 C660 700 600 690 580 660 C560 630 620 620 660 590 C700 560 780 560 820 520"/>
</g>
<g class="sk-st-bru">
<path pathLength="1" d="M980 760 C980 700 1020 656 1090 656 C1160 656 1200 700 1200 760"/>
<path pathLength="1" d="M960 760 H1220"/>
<path pathLength="1" d="M1000 760 V784 M1040 760 V784 M1080 760 V784 M1120 760 V784 M1160 760 V784 M1200 760 V784"/>
</g>
<g class="sk-st-horisont">
<path pathLength="1" d="M100 820 H1340"/>
</g>
</g>`;
}
export function sightseeingTransportStillSketchSvg(): string {
  return wrapStillSketchScene(sightseeingTransportStillSketchScene(), "0 0 1440 1000", "120 560 480 440");
}
const OA_STILL_SKETCH_SIGHTSEEING_CSS = buildStillSketchCss({
  comment: "SIGHTSEEING & TRANSPORT STILL SKETCH",
  groups: SIGHTSEEING_TRANSPORT_SKETCH_GROUPS,
  fadeKeyframe: "oaSkStFade",
});

// ── natur_friluft: mountain profile + tent + trail + trees ──
const NATUR_FRILUFT_SKETCH_GROUPS: SketchDrawGroup[] = [
  { cls: "sk-nf-fjell", keyframe: "oaSkNfFjell", start: 2, end: 28 },
  { cls: "sk-nf-telt", keyframe: "oaSkNfTelt", start: 26, end: 46 },
  { cls: "sk-nf-sti", keyframe: "oaSkNfSti", start: 44, end: 68 },
  { cls: "sk-nf-trar", keyframe: "oaSkNfTrar", start: 20, end: 72 },
];
function naturFriluftStillSketchScene(): string {
  return `<g class="sk-all">
<g class="sk-nf-fjell">
<path pathLength="1" d="M80 820 L240 600 L320 700 L440 500 L620 820"/>
</g>
<g class="sk-nf-telt">
<path pathLength="1" d="M720 820 L800 700 L880 820 Z"/>
<path pathLength="1" d="M800 700 V820"/>
<path pathLength="1" d="M768 820 L800 760 L832 820"/>
</g>
<g class="sk-nf-sti">
<path pathLength="1" d="M940 820 C980 780 960 740 1000 710 C1040 680 1020 640 1060 610 C1100 580 1140 580 1180 550"/>
</g>
<g class="sk-nf-trar">
<path pathLength="1" d="M1260 820 V780 M1230 780 H1290 M1240 750 H1280 M1250 720 H1270"/>
<path pathLength="1" d="M1330 820 V790 M1305 790 H1355 M1313 765 H1347"/>
</g>
</g>`;
}
export function naturFriluftStillSketchSvg(): string {
  return wrapStillSketchScene(naturFriluftStillSketchScene(), "0 0 1440 1000", "60 460 780 540");
}
const OA_STILL_SKETCH_NATUR_CSS = buildStillSketchCss({
  comment: "NATUR & FRILUFT STILL SKETCH",
  groups: NATUR_FRILUFT_SKETCH_GROUPS,
  fadeKeyframe: "oaSkNfFade",
});

// ── hjem (homepage «Opplevelser»-seksjonen): mountain/tent + kayak + trail +
//    an aurora streak (the one colored/accent pass, same idea as the
//    gårdssalg still's copper liquid) ──
const HJEM_SKETCH_GROUPS: SketchDrawGroup[] = [
  { cls: "sk-hj-fjell", keyframe: "oaSkHjFjell", start: 2, end: 24 },
  { cls: "sk-hj-telt", keyframe: "oaSkHjTelt", start: 22, end: 38 },
  { cls: "sk-hj-kajakk", keyframe: "oaSkHjKajakk", start: 36, end: 58 },
  { cls: "sk-hj-sti", keyframe: "oaSkHjSti", start: 56, end: 74 },
  { cls: "sk-hj-nordlys", keyframe: "oaSkHjNordlys", start: 60, end: 84, color: "#12a594", width: 4, narrowWidth: 6 },
];
function hjemStillSketchScene(): string {
  return `<g class="sk-all">
<g class="sk-hj-fjell">
<path pathLength="1" d="M60 600 L220 400 L300 500 L420 340 L560 600"/>
</g>
<g class="sk-hj-telt">
<path pathLength="1" d="M640 600 L720 480 L800 600 Z"/>
<path pathLength="1" d="M720 480 V600"/>
</g>
<g class="sk-hj-kajakk">
<path pathLength="1" d="M900 520 C940 500 1060 500 1100 520 C1060 540 940 540 900 520 Z"/>
<path pathLength="1" d="M960 460 L1040 560"/>
<path pathLength="1" d="M960 460 L944 446 M1040 560 L1056 574"/>
</g>
<g class="sk-hj-sti">
<path pathLength="1" d="M1160 580 C1190 550 1180 520 1210 500 C1240 480 1230 450 1260 430"/>
</g>
<g class="sk-hj-nordlys">
<path pathLength="1" d="M40 140 Q380 60 720 140 T1400 140"/>
<path pathLength="1" d="M40 190 Q380 110 720 190 T1400 190"/>
</g>
</g>`;
}
export function hjemStillSketchSvg(): string {
  return wrapStillSketchScene(hjemStillSketchScene(), "0 0 1440 640", "0 40 820 560");
}
const OA_STILL_SKETCH_HJEM_CSS = buildStillSketchCss({
  comment: "HOMEPAGE (OPPLEVELSER-SEKSJONEN) STILL SKETCH",
  groups: HJEM_SKETCH_GROUPS,
  fadeKeyframe: "oaSkHjFade",
  contentSelector: ".container",
});

// The ONE lookup every new caller goes through. "gardssalg" dispatches to
// the untouched S2b implementation above (byte-identical output); the rest
// dispatch to the generic-machinery motifs just defined.
export function stillSketchSvg(motif: StillSketchMotif): string {
  switch (motif) {
    case "gardssalg": return gardssalgStillSketchSvg();
    case "kultur_historie": return kulturHistorieStillSketchSvg();
    case "sightseeing_transport": return sightseeingTransportStillSketchSvg();
    case "natur_friluft": return naturFriluftStillSketchSvg();
    case "hjem": return hjemStillSketchSvg();
  }
}
export function stillSketchCss(motif: StillSketchMotif): string {
  switch (motif) {
    case "gardssalg": return OA_STILL_SKETCH_CSS;
    case "kultur_historie": return OA_STILL_SKETCH_KULTUR_CSS;
    case "sightseeing_transport": return OA_STILL_SKETCH_SIGHTSEEING_CSS;
    case "natur_friluft": return OA_STILL_SKETCH_NATUR_CSS;
    case "hjem": return OA_STILL_SKETCH_HJEM_CSS;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  vinter_sno: "Vinter & snø",
  sightseeing_transport: "Sightseeing & transport",
  dyreliv_safari: "Dyreliv & safari",
  natur_friluft: "Natur & friluft",
  kultur_historie: "Kultur & historie",
  overnatting_opplevelse: "Overnatting & opplevelse",
  adrenalin_action: "Adrenalin & action",
  velvaere_spa: "Velvære & spa",
  mat_drikke: "Mat & drikke",
  gardssalg: "Gårdssalg & smaking",
};
function catLabel(c: string | null | undefined): string {
  if (!c) return "Opplevelse";
  return CATEGORY_LABELS[c] || c.replace(/_/g, " ");
}

// Category colours live in services/category-palette.ts — ONE map shared by
// every HTML surface here AND by the OG-image service, so a category can never
// wear one colour on the page and a different one in a shared-link preview.
// See that file for the palette's rationale and its contrast contract.

/** The colour for a category slug OR a human label. Goes through the same
 *  resolveCategoryIconKey() the icons use, so the colour and the glyph on any
 *  given surface always come from the same resolved key — including the
 *  pre-data example labels on the homepage ("Natur & friluft") and legacy
 *  internal slugs. */
function categoryColor(catOrLabel: string | null | undefined): string {
  const direct = String(catOrLabel ?? "").toLowerCase();
  if (CATEGORY_COLORS[direct]) return CATEGORY_COLORS[direct];
  const key = resolveCategoryIconKey(catOrLabel);
  return (key && CATEGORY_COLORS[key]) || CATEGORY_COLOR_FALLBACK;
}

// ─────────────────────────────────────────────────────────────
// Cover illustrations — Daniel, live sesjon 2026-08-24: «opplevelses
// profilene får seg en liten remake og bildene blir forbedret».
//
// What a visitor saw before this: a 2:1 dotted beige rectangle with a 72px
// line icon and the category name in the middle — the emptiest thing on the
// page occupying its most valuable space. The `experiences` table has NO image
// column (see database/init-experiences.ts) and we hold no licence to
// anybody's photos, so the honest fix is not "find a picture" — it is to make
// the generated art actually worth its space.
//
// So: an inline SVG landscape built from the experience's own category. Sky
// wash + sun in the category colour, three depth layers, and a shape family
// chosen by what the category IS (mountains for fjell/vinter/adrenalin, water
// for fjord/dyreliv, rolling hills for mat/gårdssalg/velvære, rooflines for
// kultur/overnatting). Everything is deterministic in the slug, so a given
// experience always draws the same picture (no shuffling between requests, no
// layout shift) while the catalogue as a whole doesn't look stamped from one
// mould.
//
// Zero bytes over the wire beyond the HTML itself: no <img>, no external host,
// no CLS, and it renders identically in a text-only/crawler fetch.
// ─────────────────────────────────────────────────────────────
type CoverFamily = "fjell" | "fjord" | "skog" | "by";

const CATEGORY_COVER_FAMILY: Record<string, CoverFamily> = {
  natur_friluft: "fjell",
  vinter_sno: "fjell",
  adrenalin_action: "fjell",
  sightseeing_transport: "fjord",
  dyreliv_safari: "fjord",
  kajakk: "fjord",
  mat_drikke: "skog",
  gardssalg: "skog",
  velvaere_spa: "skog",
  kultur_historie: "by",
  overnatting_opplevelse: "by",
};

function coverFamily(catOrLabel: string | null | undefined): CoverFamily {
  const direct = String(catOrLabel ?? "").toLowerCase();
  if (CATEGORY_COVER_FAMILY[direct]) return CATEGORY_COVER_FAMILY[direct];
  const key = resolveCategoryIconKey(catOrLabel);
  return CATEGORY_COVER_FAMILY[key] ?? "fjell";
}

// FNV-1a over the seed string. Deterministic and dependency-free — the point
// is a stable per-experience variation, not cryptographic anything.
function coverSeed(seedSource: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedSource.length; i++) {
    h ^= seedSource.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

// The three depth layers of one cover, back to front. Each family returns SVG
// path `d` strings only — fill/opacity are applied by the caller, so the
// colour rule stays in ONE place no matter how many families exist.
function coverLayers(family: CoverFamily, seed: number): string[] {
  // Two small, bounded jitters (never enough to break a silhouette).
  const a = (seed % 7) * 6;          // 0-36
  const b = ((seed >> 4) % 5) * 8;   // 0-32
  switch (family) {
    case "fjell":
      return [
        `M0 ${208 - a} L118 ${128 - a} L232 ${196 - a} L352 ${104 - a} L470 ${192 - a} L596 ${126 - a} L706 ${198 - a} L800 ${150 - a} L800 340 L0 340 Z`,
        `M0 ${262 - b} L96 ${196 - b} L214 ${256 - b} L338 ${180 - b} L462 ${254 - b} L594 ${190 - b} L724 ${258 - b} L800 ${216 - b} L800 340 L0 340 Z`,
        `M0 300 Q140 268 268 296 T528 292 T800 276 L800 340 L0 340 Z`,
      ];
    case "fjord":
      return [
        `M0 ${196 - a} L112 ${124 - a} L206 ${188 - a} L318 ${132 - a} L430 ${194 - a} L556 ${118 - a} L676 ${192 - a} L800 ${146 - a} L800 340 L0 340 Z`,
        `M0 ${238 - b} Q118 ${212 - b} 236 ${238 - b} T472 ${238 - b} T800 ${230 - b} L800 340 L0 340 Z`,
        `M0 286 Q104 266 208 286 T416 286 T624 286 T800 280 L800 340 L0 340 Z`,
      ];
    case "skog":
      return [
        `M0 ${226 - a} Q152 ${162 - a} 308 ${218 - a} T612 ${196 - a} T800 ${222 - a} L800 340 L0 340 Z`,
        `M0 ${268 - b} Q136 ${222 - b} 284 ${262 - b} T574 ${238 - b} T800 ${266 - b} L800 340 L0 340 Z`,
        `M0 302 Q168 282 330 302 T660 300 T800 292 L800 340 L0 340 Z`,
      ];
    case "by":
      return [
        // Roofline: pitched roofs of varying height, then a solid base.
        `M0 340 L0 ${232 - a} L64 ${232 - a} L96 ${196 - a} L128 ${232 - a} L214 ${232 - a} L214 ${180 - a} L268 ${180 - a} L268 ${232 - a} L360 ${232 - a} L392 ${190 - a} L424 ${232 - a} L520 ${232 - a} L520 ${172 - a} L578 ${172 - a} L578 ${232 - a} L688 ${232 - a} L720 ${198 - a} L752 ${232 - a} L800 ${232 - a} L800 340 Z`,
        `M0 340 L0 ${276 - b} L108 ${276 - b} L142 ${242 - b} L176 ${276 - b} L306 ${276 - b} L306 ${236 - b} L372 ${236 - b} L372 ${276 - b} L512 ${276 - b} L548 ${240 - b} L584 ${276 - b} L800 ${276 - b} L800 340 Z`,
        `M0 306 Q160 292 320 306 T640 304 T800 298 L800 340 L0 340 Z`,
      ];
  }
}

/**
 * A category cover as inline SVG. `seedSource` is whatever should make this
 * particular cover stable — the experience slug on a detail page.
 *
 * Purely decorative: `aria-hidden` on the art, with the human-readable name
 * carried by the caller's own label chip / figure aria-label, so a screen
 * reader hears the category once, not twice.
 */
function categoryCoverSvg(catOrLabel: string | null | undefined, seedSource: string): string {
  const c = categoryColor(catOrLabel);
  const seed = coverSeed(seedSource || String(catOrLabel ?? "opplevelse"));
  const family = coverFamily(catOrLabel);
  const layers = coverLayers(family, seed);
  // Gradient id must be unique per rendered cover (two on one page would
  // otherwise share the first one's stops). Derived from the same seed, so it
  // is stable across requests for a given experience.
  const gid = `oaCover${seed.toString(36)}`;
  const sunX = 120 + (seed % 5) * 130;
  const opacities = [0.3, 0.55, 0.9];
  const paths = layers
    .map((d, i) => `<path d="${d}" fill="${c}" opacity="${opacities[i]}"/>`)
    .join("");
  return `<svg class="cover-art" viewBox="0 0 800 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${c}" stop-opacity=".08"/><stop offset="1" stop-color="${c}" stop-opacity=".30"/>
</linearGradient></defs>
<rect width="800" height="340" fill="#f3efe6"/>
<rect width="800" height="340" fill="url(#${gid})"/>
<circle cx="${sunX}" cy="86" r="38" fill="#fff" opacity=".5"/>
${paths}
</svg>`;
}

// Build the URL for a page's per-page branded og:image (dev-request
// 2026-07-12-opplevagent-serp-innholdsberikelse, item 3) — served by the
// GET /og-image.svg route below. Query-param based (not a new path segment)
// so it can't collide with existing /kategori/:category-style routes and
// needs no DB round-trip (callers already have label/sublabel/category in
// hand while building the page).
function ogImageUrl(url: string, label: string, opts?: { sublabel?: string | null; cat?: string | null }): string {
  const params = new URLSearchParams();
  params.set("label", label);
  if (opts?.sublabel) params.set("sublabel", opts.sublabel);
  if (opts?.cat) params.set("cat", opts.cat);
  return `${url}/og-image.svg?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────
// Category icons — 52 unique, single-colour (currentColor) glyphs keyed by
// category slug (design handoff "design_handoff_ikoner", 2026-06-23). The 9
// live categories map 1:1; the other 43 are pre-wired so a new category shows
// its own icon the moment a matching slug is published — no code change. This
// replaces the old 7-glyph set that reused a compass/cup across 5 of 9 cards.
// Inner SVG markup only; catIconSvg() supplies viewBox + size + the shared
// stroke attrs. Dots carry their own fill/stroke overrides.
// ─────────────────────────────────────────────────────────────
const CATEGORY_ICON_INNER: Record<string, string> = {
  kultur_historie: '<path d="M6 21 L6 13 L12 8.5 L18 13 L18 21"></path><path d="M8.2 13 L12 9.8 L15.8 13"></path><path d="M9.8 16.5 L12 14.6 L14.2 16.5"></path><line x1="12" y1="4.5" x2="12" y2="8.5"></line><line x1="10.2" y1="6" x2="13.8" y2="6"></line><line x1="5" y1="21" x2="19" y2="21"></line>',
  sightseeing_transport: '<path d="M3.5 14.5 H20.5 L18.3 18.2 H5.7 Z"></path><path d="M7 14.5 V10.5 H15.5 V14.5"></path><circle cx="9.2" cy="12.4" r="0.85" fill="currentColor" stroke="none"></circle><circle cx="12.5" cy="12.4" r="0.85" fill="currentColor" stroke="none"></circle><path d="M2.6 20.4 q2.2 -1.5 4.4 0 t4.4 0 t4.4 0 t4.4 0"></path>',
  natur_friluft: '<path d="M2.5 19 L8 9 L11.5 14.5 L15 8.5 L21.5 19"></path><circle cx="17.4" cy="6.4" r="1.7"></circle><line x1="2.5" y1="19" x2="21.5" y2="19"></line>',
  adrenalin_action: '<line x1="2.5" y1="6" x2="21.5" y2="10.5"></line><circle cx="11" cy="8.7" r="1.7"></circle><path d="M11 10.4 L11 14.5"></path><line x1="11" y1="11.8" x2="14.2" y2="14.4"></line><line x1="11" y1="14.5" x2="9.2" y2="18.4"></line><line x1="11" y1="14.5" x2="12.7" y2="18.4"></line>',
  vinter_sno: '<line x1="12" y1="3" x2="12" y2="21"></line><line x1="4.2" y1="7.5" x2="19.8" y2="16.5"></line><line x1="4.2" y1="16.5" x2="19.8" y2="7.5"></line><line x1="12" y1="6.2" x2="10" y2="4.5"></line><line x1="12" y1="6.2" x2="14" y2="4.5"></line><line x1="12" y1="17.8" x2="10" y2="19.5"></line><line x1="12" y1="17.8" x2="14" y2="19.5"></line><line x1="6.8" y1="9.1" x2="6.6" y2="6.6"></line><line x1="6.8" y1="9.1" x2="4.3" y2="8.9"></line><line x1="17.2" y1="14.9" x2="17.4" y2="17.4"></line><line x1="17.2" y1="14.9" x2="19.7" y2="15.1"></line><line x1="6.8" y1="14.9" x2="4.3" y2="15.1"></line><line x1="6.8" y1="14.9" x2="6.6" y2="17.4"></line><line x1="17.2" y1="9.1" x2="19.7" y2="8.9"></line><line x1="17.2" y1="9.1" x2="17.4" y2="6.6"></line>',
  overnatting_opplevelse: '<path d="M3.5 11.5 L12 5 L20.5 11.5"></path><path d="M5.5 10 V20 H18.5 V10"></path><path d="M10 20 V14.5 H14 V20"></path><line x1="15.5" y1="7.6" x2="15.5" y2="5.2"></line>',
  dyreliv_safari: '<path d="M12 14.5 C9.5 9.5 7.5 7 5 5.6 C7.8 7.8 10 10 11.2 13.6"></path><path d="M12 14.5 C14.5 9.5 16.5 7 19 5.6 C16.2 7.8 14 10 12.8 13.6"></path><path d="M2.8 19.4 q2.4 -1.6 4.8 0 t4.8 0 t4.8 0 t4.8 0"></path>',
  velvaere_spa: '<path d="M4.5 13 H19.5 A7.5 7.5 0 0 1 4.5 13 Z"></path><line x1="4.5" y1="13" x2="19.5" y2="13"></line><path d="M9 4.5 c1.2 1.1 -1.2 2.1 0 3.4"></path><path d="M12 3.6 c1.2 1.1 -1.2 2.1 0 3.4"></path><path d="M15 4.5 c1.2 1.1 -1.2 2.1 0 3.4"></path>',
  mat_drikke: '<path d="M7 4 V8.5 M9.2 4 V8.5 M8.1 8.5 V20"></path><path d="M16.2 4 c2.4 0.4 2.4 6.4 0.6 8.4 L16.4 12.6 V20"></path>',
  fottur: '<path d="M8 4 V12 L4.5 14 C3.3 14.7 3.4 17 5.4 17 H19 V15 C19 13.2 16.4 13 14 12 L11 10 V4 Z"></path><line x1="4.6" y1="17.6" x2="19.4" y2="17.6"></line>',
  topptur: '<path d="M4 19 L11 6 L18 19"></path><line x1="11" y1="6" x2="11" y2="3"></line><path d="M11 3 H15 L13.8 4.6 L15 6.2 H11"></path><line x1="4" y1="19" x2="18" y2="19"></line>',
  fisketur: '<path d="M3 12 c3 -4.2 9.5 -4.2 12.5 0 c-3 4.2 -9.5 4.2 -12.5 0 Z"></path><line x1="15.5" y1="12" x2="19" y2="8.8"></line><line x1="15.5" y1="12" x2="19" y2="15.2"></line><circle cx="7.4" cy="10.6" r="0.8" fill="currentColor" stroke="none"></circle><path d="M20.5 5.5 V10 a1.9 1.9 0 0 1 -3.8 0"></path>',
  kajakk: '<path d="M3.5 13 q8.5 5 17 0 q-8.5 -5 -17 0 Z"></path><line x1="6" y1="8" x2="18" y2="18"></line><path d="M6 8 l-1.6 -1.4"></path><path d="M18 18 l1.6 1.4"></path>',
  brevandring: '<line x1="7" y1="20.5" x2="16.5" y2="6"></line><path d="M16.5 6 q3.4 -1 4.4 2.4"></path><path d="M16.5 6 q-1 -3.4 -4.4 -2.4"></path><line x1="8.4" y1="18" x2="5.6" y2="19.6"></line>',
  sopptur: '<path d="M4.5 11.5 a7.5 5.5 0 0 1 15 0 Z"></path><path d="M9.8 11.5 v5.5 a2.2 2.2 0 0 0 4.4 0 v-5.5"></path><circle cx="9.5" cy="9" r="0.7" fill="currentColor" stroke="none"></circle><circle cx="13" cy="8" r="0.7" fill="currentColor" stroke="none"></circle><circle cx="15.4" cy="9.6" r="0.6" fill="currentColor" stroke="none"></circle>',
  riding: '<path d="M7.5 20 V11.5 a4.5 5 0 0 1 9 0 V20"></path><circle cx="7.5" cy="20" r="0.8" fill="currentColor" stroke="none"></circle><circle cx="16.5" cy="20" r="0.8" fill="currentColor" stroke="none"></circle><circle cx="7.9" cy="16" r="0.7" fill="currentColor" stroke="none"></circle><circle cx="16.1" cy="16" r="0.7" fill="currentColor" stroke="none"></circle><circle cx="8.6" cy="12.6" r="0.7" fill="currentColor" stroke="none"></circle><circle cx="15.4" cy="12.6" r="0.7" fill="currentColor" stroke="none"></circle>',
  klatring: '<path d="M9 4.5 C5.5 4.5 5.5 19.5 9 19.5 C12.5 19.5 12.5 4.5 9 4.5 Z"></path><line x1="9" y1="5.5" x2="9" y2="12.5"></line><line x1="13" y1="8" x2="20" y2="11"></line>',
  rafting: '<path d="M4 13 H20 L17.6 16.5 H6.4 Z"></path><line x1="8.5" y1="13" x2="6.5" y2="9.5"></line><line x1="15.5" y1="13" x2="17.5" y2="9.5"></line><path d="M2.8 20 q2.4 -1.6 4.8 0 t4.8 0 t4.8 0 t4.8 0"></path>',
  paragliding: '<path d="M3 9 Q12 3 21 9"></path><line x1="4.5" y1="9" x2="11" y2="15"></line><line x1="9.5" y1="9" x2="12" y2="15"></line><line x1="14.5" y1="9" x2="12" y2="15"></line><line x1="19.5" y1="9" x2="13" y2="15"></line><circle cx="12" cy="16.6" r="1.6"></circle>',
  klatrepark: '<line x1="7" y1="21" x2="7" y2="5"></line><line x1="4.5" y1="9" x2="7" y2="5"></line><line x1="9.5" y1="9" x2="7" y2="5"></line><path d="M7 11 L20 8"></path><path d="M7 15 L20 12"></path><circle cx="20" cy="8" r="1" fill="currentColor" stroke="none"></circle><circle cx="20" cy="12" r="1" fill="currentColor" stroke="none"></circle>',
  lasertag: '<circle cx="12" cy="12" r="8.2"></circle><circle cx="12" cy="12" r="4.2"></circle><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"></circle>',
  escape: '<circle cx="7.5" cy="12" r="3.2"></circle><circle cx="7.5" cy="12" r="0.8" fill="currentColor" stroke="none"></circle><line x1="10.7" y1="12" x2="20" y2="12"></line><line x1="17" y1="12" x2="17" y2="15"></line><line x1="20" y1="12" x2="20" y2="15.5"></line>',
  alpint: '<path d="M6 20 L13.5 5 Q14.2 3.4 16 4.2"></path><path d="M9.5 20 L17 5 Q17.7 3.4 19.5 4.2"></path><line x1="5" y1="20" x2="11" y2="20"></line>',
  langrenn: '<path d="M8.5 20.5 V7 Q8.5 4.2 6.4 4.4"></path><path d="M14 20.5 V7 Q14 4.2 11.9 4.4"></path><line x1="8.5" y1="12" x2="14" y2="12"></line>',
  hundespann: '<path d="M3.5 16.5 H13 V13.5 H3.5 Z"></path><path d="M2.8 19 Q3.2 18 4.6 18 H13"></path><line x1="13" y1="14.6" x2="16.5" y2="13"></line><path d="M16.5 13 q1.6 -2.8 4 -1.4 l0.8 1.6 q0.8 1.4 -0.4 2.4 l-1.2 1 H17 v-2.2"></path><circle cx="20.6" cy="12.4" r="0.7" fill="currentColor" stroke="none"></circle>',
  snoscooter: '<path d="M3 17 q2 -1.5 5 -1 l6 0.6 4 -3.6"></path><path d="M2.4 18.6 Q3 17.4 4.6 17.6"></path><line x1="14" y1="11" x2="17" y2="8"></line><line x1="17" y1="8" x2="20.5" y2="8"></line><circle cx="18" cy="14" r="1" fill="currentColor" stroke="none"></circle>',
  skoyter: '<path d="M8 4 V13 L6 15 H17"></path><path d="M6.2 17.6 H18 Q18 16 16.4 16 H6"></path><line x1="8" y1="8" x2="11.5" y2="8"></line>',
  nordlys: '<path d="M6 4 Q3.5 11 6 18"></path><path d="M11 3.5 Q8.5 11 11 18.5"></path><path d="M16 4 Q13.5 11 16 18"></path><path d="M21 4.5 Q18.5 11 21 17.5"></path><circle cx="8.5" cy="6" r="0.6" fill="currentColor" stroke="none"></circle><circle cx="18" cy="7" r="0.6" fill="currentColor" stroke="none"></circle><circle cx="13.5" cy="5" r="0.5" fill="currentColor" stroke="none"></circle><line x1="3" y1="20" x2="21" y2="20"></line>',
  dykking: '<path d="M4.5 9 H16 A3 3 0 0 1 13 15 H7.5 A3 3 0 0 1 4.5 9 Z"></path><circle cx="7.5" cy="11" r="1.4"></circle><circle cx="12" cy="11" r="1.4"></circle><path d="M19.5 7 V15 a1.8 1.8 0 0 1 -3.6 0"></path>',
  fugletitting: '<path d="M3.5 12 Q7 8 10.5 11.5"></path><path d="M10.5 11.5 Q14 8 17.5 11.5"></path><path d="M17.5 11.5 q1.6 -0.4 2.8 -1.8"></path><circle cx="10.5" cy="11.5" r="0.6" fill="currentColor" stroke="none"></circle>',
  seiling: '<path d="M4 17 H18 L15.8 20 H6.2 Z"></path><line x1="11" y1="17" x2="11" y2="4"></line><path d="M11 5 L11 15 L4.5 15 Z"></path>',
  batt: '<path d="M3 14 Q12 19.5 21 14"></path><line x1="3" y1="14" x2="5" y2="11"></line><line x1="21" y1="14" x2="19" y2="11"></line><line x1="9" y1="9" x2="6.5" y2="13.5"></line><line x1="15" y1="9" x2="17.5" y2="13.5"></line>',
  helikopter: '<path d="M6 12 a4 3 0 0 1 8 0 Z"></path><line x1="14" y1="11" x2="21" y2="10"></line><path d="M21 10 q0.6 1.4 -1 2.2"></path><line x1="10" y1="9" x2="10" y2="6.5"></line><line x1="4.5" y1="6.5" x2="16" y2="6.5"></line><line x1="6" y1="15" x2="13" y2="15"></line><line x1="7.5" y1="15" x2="7.5" y2="16.5"></line><line x1="11.5" y1="15" x2="11.5" y2="16.5"></line>',
  luftballong: '<path d="M12 4 a6 6.5 0 0 1 0 13 a6 6.5 0 0 1 0 -13 Z"></path><line x1="8.5" y1="14" x2="10.5" y2="17"></line><line x1="15.5" y1="14" x2="13.5" y2="17"></line><path d="M10 17 H14 L13.4 20 H10.6 Z"></path>',
  sykkel: '<circle cx="6" cy="16" r="3.4"></circle><circle cx="18" cy="16" r="3.4"></circle><line x1="6" y1="16" x2="10" y2="16"></line><line x1="10" y1="16" x2="14" y2="9"></line><line x1="8.5" y1="9" x2="14.5" y2="9"></line><line x1="8.5" y1="9" x2="6" y2="16"></line><line x1="14" y1="9" x2="18" y2="16"></line><line x1="13.5" y1="7.5" x2="15.5" y2="7.5"></line>',
  midnattssol: '<path d="M6 15 a6 6 0 0 1 12 0"></path><line x1="3" y1="15" x2="21" y2="15"></line><line x1="12" y1="4" x2="12" y2="6.5"></line><line x1="5.6" y1="6.6" x2="7.2" y2="8.4"></line><line x1="18.4" y1="6.6" x2="16.8" y2="8.4"></line><line x1="5" y1="18" x2="9" y2="18"></line><line x1="11" y1="18" x2="15" y2="18"></line><line x1="16" y1="18" x2="19" y2="18"></line>',
  museum: '<path d="M3 8.5 L12 4 L21 8.5"></path><line x1="5.5" y1="8.5" x2="5.5" y2="17"></line><line x1="10" y1="8.5" x2="10" y2="17"></line><line x1="14" y1="8.5" x2="14" y2="17"></line><line x1="18.5" y1="8.5" x2="18.5" y2="17"></line><line x1="3.5" y1="17" x2="20.5" y2="17"></line><line x1="2.8" y1="20" x2="21.2" y2="20"></line>',
  kunst: '<path d="M4 5 H20 V18 H4 Z"></path><path d="M4 14 L9 10 L13 13 L16 11 L20 14.5"></path><circle cx="8" cy="8.5" r="1.2"></circle>',
  konsert: '<circle cx="7" cy="17.5" r="2.2"></circle><circle cx="15.5" cy="15.5" r="2.2"></circle><line x1="9.2" y1="17.5" x2="9.2" y2="6"></line><line x1="17.7" y1="15.5" x2="17.7" y2="4.5"></line><path d="M9.2 6 L17.7 4.5 M9.2 8 L17.7 6.5"></path>',
  festival: '<circle cx="12" cy="11" r="7.5"></circle><circle cx="12" cy="11" r="1" fill="currentColor" stroke="none"></circle><line x1="12" y1="3.5" x2="12" y2="18.5"></line><line x1="4.5" y1="11" x2="19.5" y2="11"></line><line x1="6.7" y1="5.7" x2="17.3" y2="16.3"></line><line x1="6.7" y1="16.3" x2="17.3" y2="5.7"></line><line x1="8" y1="18" x2="12" y2="21"></line><line x1="16" y1="18" x2="12" y2="21"></line>',
  samisk: '<path d="M4 19 L12 4 L20 19 Z"></path><line x1="11" y1="6.5" x2="13.5" y2="3.5"></line><line x1="13" y1="6.5" x2="10.5" y2="3.5"></line><path d="M10.5 19 L12 12.5 L13.5 19"></path>',
  byvandring: '<path d="M12 21 c-4 -5 -6 -8 -6 -11 a6 6 0 0 1 12 0 c0 3 -2 6 -6 11 Z"></path><circle cx="12" cy="10" r="2.3"></circle>',
  bryggeri: '<path d="M6.5 8 H15 V18.5 H6.5 Z"></path><path d="M15 10 H18 V15 H15"></path><path d="M6.5 8 q1 -2 2.8 -0.9 q1 -2 2.8 -0.2 q1.8 -1 2.9 0.8 Z"></path><line x1="9" y1="11" x2="9" y2="16"></line><line x1="12.5" y1="11" x2="12.5" y2="16"></line>',
  vinsmaking: '<path d="M7.5 4 H16.5 C16.5 9.5 14.5 11.5 12 11.5 C9.5 11.5 7.5 9.5 7.5 4 Z"></path><line x1="12" y1="11.5" x2="12" y2="19"></line><line x1="8.5" y1="19" x2="15.5" y2="19"></line><path d="M8.1 6.5 H15.9"></path>',
  bakeri: '<path d="M3.5 15 a8.5 6 0 0 1 17 0 Z"></path><line x1="3.5" y1="15" x2="20.5" y2="15"></line><path d="M8 11.5 q1 -2 2 0"></path><path d="M12 10.5 q1 -2 2 0"></path><path d="M16 11.5 q1 -2 2 0"></path>',
  sjomat: '<circle cx="12" cy="13.5" r="3.6"></circle><line x1="8.6" y1="12.2" x2="5" y2="10.4"></line><line x1="8.4" y1="14" x2="4.8" y2="14.6"></line><line x1="8.8" y1="15.6" x2="5.6" y2="17.4"></line><line x1="15.4" y1="12.2" x2="19" y2="10.4"></line><line x1="15.6" y1="14" x2="19.2" y2="14.6"></line><line x1="15.2" y1="15.6" x2="18.4" y2="17.4"></line><path d="M9.6 10.6 L7 7.8 Q5.6 6.4 6.8 5.6"></path><path d="M14.4 10.6 L17 7.8 Q18.4 6.4 17.2 5.6"></path><circle cx="10.6" cy="12.4" r="0.7" fill="currentColor" stroke="none"></circle><circle cx="13.4" cy="12.4" r="0.7" fill="currentColor" stroke="none"></circle>',
  gardsbesok: '<path d="M4 11 L12 5 L20 11 V20 H4 Z"></path><path d="M4 11 H20"></path><path d="M9.5 20 V13.5 H14.5 V20"></path><line x1="9.5" y1="13.5" x2="14.5" y2="16.8"></line><line x1="14.5" y1="13.5" x2="9.5" y2="16.8"></line>',
  gardssalg: '<path d="M4 11 L12 5 L20 11 V20 H4 Z"></path><path d="M4 11 H20"></path><path d="M9.5 20 V13.5 H14.5 V20"></path><line x1="9.5" y1="13.5" x2="14.5" y2="16.8"></line><line x1="14.5" y1="13.5" x2="9.5" y2="16.8"></line><circle cx="17" cy="7.5" r="1.2"></circle><line x1="17" y1="8.7" x2="17" y2="10.5"></line><line x1="15.5" y1="10.5" x2="18.5" y2="10.5"></line>',
  badstu: '<path d="M7 11 L8.4 19 H14.6 L16 11 Z"></path><line x1="6.2" y1="11" x2="16.8" y2="11"></line><path d="M8.4 11 a3 2.4 0 0 1 6.2 0"></path><line x1="16.8" y1="10.4" x2="20" y2="6.6"></line><circle cx="20.6" cy="5.8" r="1.4"></circle><path d="M10.5 6.6 c0.9 0.9 -0.9 1.7 0 2.6"></path>',
  yoga: '<circle cx="12" cy="5.5" r="2"></circle><line x1="12" y1="7.5" x2="12" y2="13"></line><path d="M5 18 Q12 12.5 19 18"></path><path d="M12 12 L6 16"></path><path d="M12 12 L18 16"></path>',
  camping: '<path d="M3 19 L12 5 L21 19 Z"></path><path d="M12 5 L9 19"></path><path d="M12 5 L15 19"></path><path d="M9 19 L12 12.5 L15 19"></path><line x1="2.5" y1="19" x2="21.5" y2="19"></line>',
  glamping: '<path d="M3.5 19 Q12 2.5 20.5 19 Z"></path><line x1="12" y1="4" x2="12" y2="2"></line><path d="M10 19 L12 11.5 L14 19"></path><line x1="2.8" y1="19" x2="21.2" y2="19"></line>',
  fyrtarn: '<path d="M9.5 20 L10.3 10 H13.7 L14.5 20 Z"></path><path d="M9.7 10 L9.2 7.5 H14.8 L14.3 10"></path><path d="M10.3 13.5 H13.7"></path><path d="M11 7.5 H13 V5.5 H11 Z"></path><line x1="7.5" y1="6.5" x2="9.5" y2="7"></line><line x1="16.5" y1="6.5" x2="14.5" y2="7"></line><line x1="8" y1="20" x2="16" y2="20"></line>',
};

// Compass — last-resort glyph when a category matches neither a slug nor a
// fuzzy bucket, so the grid never renders an empty tile.
const CATEGORY_ICON_FALLBACK =
  '<circle cx="12" cy="12" r="9"></circle><path d="M15.5 8.5 L11 11 L8.5 15.5 L13 13 Z" fill="currentColor" stroke="none"></path>';

// Resolve a category slug *or* a human label to an icon key. A direct slug hit
// covers every live + future category; the fuzzy buckets keep the pre-data
// fallback labels (e.g. "På vannet") and any legacy/internal slug
// (vannaktivitet, wellness_spa …) showing a sensible icon. Order matters:
// "vinter" is tested before the "vin" (wine) bucket.
function resolveCategoryIconKey(catOrLabel: string | null | undefined): string {
  const c = String(catOrLabel ?? "").toLowerCase();
  if (CATEGORY_ICON_INNER[c]) return c;
  if (/(vinter|ski|_sno|snø|aking|skøyte|skoyte|langrenn|nordlys)/.test(c)) return "vinter_sno";
  if (/(safari|hval|dyreliv|fugl|whale|wildlife|elg|moskus)/.test(c)) return "dyreliv_safari";
  if (/(vann|kajakk|kano|fjord|båt|seil|dykk|snork|fiske|rafting|padl|sjø)/.test(c)) return "kajakk";
  if (/(overnatting|hytte|telt|camp|glamp|fyrtårn|fyrtarn)/.test(c)) return "overnatting_opplevelse";
  if (/(velvær|velvaer|spa|wellness|sauna|badstu|yoga|massasj)/.test(c)) return "velvaere_spa";
  if (/(kultur|museum|kunst|historie|teater|konsert|festival|galleri|samisk|arrangement)/.test(c)) return "kultur_historie";
  if (/(adrenalin|action|familie|barn|lek|laser|escape|klatr)/.test(c)) return "adrenalin_action";
  if (/(sightseeing|transport|buss|guidet|rundtur|helikopter|ballong|sykkel)/.test(c)) return "sightseeing_transport";
  if (/(gårdssalg|gaardssalg|gardssalg)/.test(c)) return "gardssalg";
  if (/(mat|drikke|smak|øl|vin|gård|gard|food|bakeri|bryggeri|sjømat|sjomat)/.test(c)) return "mat_drikke";
  if (/(natur|friluft|fjell|tur|hike|vandr|topp|sopp|riding)/.test(c)) return "natur_friluft";
  return "";
}

// Wrapped, sized <svg> for a category. Supplies the shared stroke presentation
// attrs; inner dots override with their own fill where needed.
function catIconSvg(catOrLabel: string | null | undefined, size: number, cls = ""): string {
  const key = resolveCategoryIconKey(catOrLabel);
  const inner = (key && CATEGORY_ICON_INNER[key]) || CATEGORY_ICON_FALLBACK;
  return `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function safeCategories(): Array<{ category: string; count: number }> {
  try {
    return listCategories();
  } catch {
    return [];
  }
}

// Feature flag: gardssalg category card/sitemap visibility. Shown when ≥5
// experience_providers have producer_type set OR rfb_seed_source='rfb-seed'.
// Below threshold the /kategori/gardssalg URL still renders; we just suppress
// it from the homepage grid, nav, and sitemap so it doesn't appear as a dead
// card before meaningful content exists.
const GARDSSALG_VISIBILITY_THRESHOLD = 5;
function gardssalgVisible(): boolean {
  try {
    return countGardssalgProviders() >= GARDSSALG_VISIBILITY_THRESHOLD;
  } catch {
    return false; // DB not open — suppress silently
  }
}

// dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 1
// (slice 6): "opplevelser" and "gårdssalg & smaking" are two clearly
// distinct homepage sections now — the dedicated #drikkested feature
// section (renderDrikkestedFeatureSection() below) is the ONLY gårdssalg
// surface on the homepage. The .cat-grid (experience-category grid) must
// therefore NEVER show a gårdssalg entry, from ANY source:
//   - the synthetic card Phase 1 used to inject into catSource when
//     gardssalgVisible() was true (removed — see catSource below); and
//   - a genuine DB row in the `experiences` table whose category happens to
//     literally be "gardssalg"/"gårdssalg"/"gaardssalg" — listCategories()
//     only reads the `experiences` table (never experience_providers), so
//     this should never occur in practice, but it's cheap to guard
//     defensively rather than assume.
// Matches the SAME three spellings resolveCategoryIconKey() above already
// recognizes as "this is the gårdssalg slug", so the guard and the icon
// lookup stay in sync.
function isGardssalgCategorySlug(category: string | null | undefined): boolean {
  return !!category && /^(gårdssalg|gaardssalg|gardssalg)$/i.test(category.trim());
}

// ─────────────────────────────────────────────────────────────
// Gårdssalg type subpages (dev-request 2026-08-06-opplevagent-ux-loft-
// drikkested-lansering, S3): indexable per-drink-type catalog pages under
// /kategori/gardssalg/<typeSlug>, so outreach emails can link a recipient
// straight to their own type's page. This whitelist is the ONLY set of
// canonical type slugs that resolve — anything else next()s to the generic
// /kategori/:category(/…) handlers further down and ultimately the 404.
//
// Slugs are canonical ASCII (mjod, not mjød) — URL-safe without
// percent-encoding. `producerTypes` are the RAW experience_providers
// .producer_type spellings each page aggregates (lowercase-matched via the
// store's LOWER(producer_type) IN (…) filter): both accented DB spellings
// and the pipeline's ASCII transliterations (vingard/vingaard, mjoderi/
// mjoederi — see DRINK_TYPE_UNACCENTED_ALIASES below). NULL producer_type
// rows match NO type page — they render on the base catalog («Alle») only;
// NEVER filter with isGardssalgDrinkType(), which counts NULL as drink.
//
// `lede` is the page's answer-first opening (same GEO discipline as
// buildCategoryAnswerFirstOpening() below): a live count is stated upfront,
// so it's a function of the REAL count at request time, never a canned
// number.
export type GardssalgTypePageDef = {
  label: string;          // chip/breadcrumb label — same canonical labels as DRINK_TYPE_META
  producerTypes: string[]; // raw producer_type spellings aggregated by this page
  title: string;          // <title> (also the h1, minus the " | Opplevagent" suffix)
  metaDesc: string;
  lede: (count: number) => string; // answer-first opening with the live count woven in
};

export const GARDSSALG_TYPE_PAGES: Record<string, GardssalgTypePageDef> = {
  bryggeri: {
    label: "Bryggeri",
    producerTypes: ["bryggeri"],
    title: "Bryggerier med gårdssalg og smaking | Opplevagent",
    metaDesc: "Besøk lokale bryggerier — book ølsmaking eller omvisning rett hos bryggeriet. Verifisert mot Brønnøysundregistrene.",
    lede: (n) => `Det finnes ${n} ${n === 1 ? "bryggeri" : "bryggerier"} på Opplevagent — book en ølsmaking eller omvisning rett hos bryggeriet.`,
  },
  destilleri: {
    label: "Destillat",
    producerTypes: ["destilleri"],
    title: "Destillerier med gårdssalg og smaking | Opplevagent",
    metaDesc: "Besøk lokale destillerier — book smaking av destillater eller omvisning rett hos produsenten. Verifisert mot Brønnøysundregistrene.",
    lede: (n) => `Det finnes ${n} ${n === 1 ? "destilleri" : "destillerier"} på Opplevagent — book en smaking eller omvisning rett hos destilleriet.`,
  },
  sider: {
    label: "Sider",
    producerTypes: ["cideri", "sideri"],
    title: "Siderier med gårdssalg og smaking | Opplevagent",
    metaDesc: "Besøk lokale siderprodusenter — book sidersmaking eller omvisning i frukthagen rett hos produsenten. Verifisert mot Brønnøysundregistrene.",
    lede: (n) => `Det finnes ${n} ${n === 1 ? "siderprodusent" : "siderprodusenter"} på Opplevagent — book en sidersmaking rett hos produsenten.`,
  },
  fruktvin: {
    label: "Fruktvin",
    producerTypes: ["vingård", "vingard", "vingaard"],
    title: "Fruktvin — vingårder med gårdssalg og smaking | Opplevagent",
    metaDesc: "Besøk lokale fruktvinprodusenter — book smaking av fruktvin og en tur i vingården rett hos produsenten. Verifisert mot Brønnøysundregistrene.",
    lede: (n) => `Det finnes ${n} ${n === 1 ? "fruktvinprodusent" : "fruktvinprodusenter"} på Opplevagent — book en smaking rett hos produsenten.`,
  },
  mjod: {
    label: "Mjød",
    producerTypes: ["mjøderi", "mjoderi", "mjoederi"],
    title: "Mjøderier med gårdssalg og smaking | Opplevagent",
    metaDesc: "Besøk lokale mjøderier — book mjødsmaking eller omvisning rett hos produsenten. Verifisert mot Brønnøysundregistrene.",
    lede: (n) => `Det finnes ${n} ${n === 1 ? "mjøderi" : "mjøderier"} på Opplevagent — book en mjødsmaking rett hos produsenten.`,
  },
  kombucha: {
    label: "Kombucha",
    producerTypes: ["seltzeri"],
    title: "Kombucha-produsenter med gårdssalg og smaking | Opplevagent",
    metaDesc: "Besøk lokale kombucha-produsenter — book smaking eller omvisning rett hos produsenten. Verifisert mot Brønnøysundregistrene.",
    lede: (n) => `Det finnes ${n} ${n === 1 ? "kombucha-produsent" : "kombucha-produsenter"} på Opplevagent — book en smaking rett hos produsenten.`,
  },
};

// Alias slugs → canonical slug, answered with a 301 to the canonical URL so
// outreach links/typed-in raw producer_type spellings never mint duplicate
// indexable URLs. Keys are single URL segments (lowercase ASCII).
export const GARDSSALG_TYPE_SLUG_ALIASES: Record<string, string> = {
  sideri: "sider",
  cideri: "sider",
  vingard: "fruktvin",
  vingaard: "fruktvin",
  mjoderi: "mjod",
  mjoederi: "mjod",
  seltzeri: "kombucha",
};

// ─────────────────────────────────────────────────────────────
// Homepage UI strings (NO/EN). Phase-1 i18n: only the landing page
// is genuinely bilingual; browse/detail stay NO-canonical for now.
// ─────────────────────────────────────────────────────────────
export function homeStrings(lang: Lang) {
  const no = {
    metaTitle: "Opplevagent — norske opplevelser, håndplukket og verifisert",
    metaDesc: "Håndplukkede norske opplevelser og aktiviteter — hvalsafari, trehytter, guidede turer, mat og mer. Alle tilbydere er verifisert mot Brønnøysundregistrene, og katalogen er søkbar for AI-agenter.",
    ogTitle: "Opplevagent — norske opplevelser, søkbart for AI-agenter",
    ogImageAlt: "Opplevagent — markedsplass for norske opplevelser",
    skip: "Hopp til hovedinnhold",
    brandAria: "Opplevagent forside",
    navAria: "Hovednavigasjon",
    navAll: "Alle opplevelser", navCategories: "Kategorier", navHow: "Slik funker det", navAgents: "For AI-agenter", navExplore: "Utforsk",
    // dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S4:
    // the /for-tilbydere provider-onboarding page's nav/footer entry. The
    // page itself is NO-canonical with no /en variant, so the EN nav points
    // at the same Norwegian URL — exactly like /opplevelser and
    // /kategori/gardssalg already do. Keep in sync with the `en` object below.
    navProviders: "For tilbydere",
    heroPill: "A2A-markedsplass for norske opplevelser",
    heroH1: "Hva kan vi finne på ", heroAccent: "i dag?",
    heroSub: "Fra hvalsafari og trehytter til fjellturer, matopplevelser og lasertag &mdash; håndplukkede norske opplevelser, samlet ett sted.",
    searchAria: "Finn opplevelser", searchLabel: "Beskriv hva du vil finne på, eller skriv et sted", searchPlaceholder: "Søk: hvalsafari, Oslo, mat …", searchBtn: "Finn opplevelser",
    hintPre: "Søk på sted, kategori eller aktivitet &mdash; eller ", hintLink: "bla i alle opplevelser", hintPost: ".",
    // dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info,
    // Goal 3: the reiserute (route/corridor) capability existed but was
    // invisible right next to the ONE search box that can now trigger it —
    // Daniel: «dette nevnes ikke i informasjonen som ligger nær søkefeltet».
    // Keep this in sync with the `en` object below.
    hintRoutePre: "\u{1F697} Skal du ut og kjøre? Skriv ", hintRouteLink: "«Oslo til Bergen»", hintRoutePost: " i søkefeltet, så finner vi stopp langs veien &mdash; eller planlegg ", hintRouteLink2: "hele reiseruten", hintRoutePost2: ".",
    quickAria: "Hurtigsøk", qNature: "Ute i naturen", qAll: "Alle opplevelser",
    // dev-request 2026-07-25-reisesok fix 0f(ii): homepage «Nær meg».
    nearMeBtn: "Nær meg", nearMeRadiusLabel: "Søkeradius", nearMeLoading: "Henter posisjon…", nearMeDenied: "Posisjon avslått",
    trustAria: "Tillit og datakilder", trustBrreg: "Tilbydere verifisert mot Brønnøysundregistrene", trustFresh: "Innhold oppdatert fortløpende", trustMachine: "Maskinlesbar for AI-agenter",
    counterAria: "Opplevagent i tall",
    counterPageviews: "Sidevisninger", counterRealVisitors: "Ekte besøkende", counterAiSearch: "AI-søk", counterCrawlers: "Crawlere &amp; bots",
    counterExperiences: "Opplevelser", counterProviders: "Tilbydere", counterMunicipalities: "Kommuner",
    counterAiExplain: "AI-søk: et menneske spurte ChatGPT, Claude eller Perplexity, og assistenten hentet informasjon fra oss i sanntid. Crawlere: automatisk indeksering og skraping.",
    counterNoteShort: "AI-søk = en assistent hentet svar fra oss i sanntid.",
    counterWindowPre: "Siste", counterWindowPost: "dager",
    counterSincePre: "Tall siden",
    networkLabel: "En del av A2A-nettverket:", networkTagline: "Bygget for både mennesker og AI-agenter",
    // dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S2:
    // the homepage drikkested feature section (rendered only when
    // gardssalgVisible() — see renderDrikkestedFeatureSection()).
    // Keep in sync with the `en` object below.
    drikkeKicker: "Nytt", drikkeTitle: "Besøk lokale drikkeprodusenter",
    drikkeIntro: "Bryggeri, sideri, mjøderi og destilleri åpner dørene for smaking og omvisning &mdash; book besøket direkte hos produsenten, verifisert mot Brønnøysundregistrene.",
    // Pre-booking variant of the intro: the catalog IS live and browsable, so
    // it says what a visitor can do today (finn, les, ta kontakt) instead of
    // promising a booking flow no producer has activated yet.
    drikkeIntroBrowse: "Bryggeri, sideri, mjøderi og destilleri over hele landet &mdash; se hvem som holder til der du er, hva de tilbyr og hvordan du tar kontakt. Alle verifisert mot Brønnøysundregistrene.",
    // drikkeCta is superseded by the state-driven drikkeCtaBrowse/
    // drikkeCtaLive pair below (renderDrikkestedFeatureSection() no longer
    // renders this static string) — kept defined rather than deleted in
    // case another surface still reads it; grep before reusing.
    drikkeCta: "Utforsk drikkesteder", drikkeAria: "Drikkeprodusenter etter type", drikkeChipCountAria: "produsenter",
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
    // 1 (slice 6): state-driven CTA variants for renderDrikkestedFeatureSection()
    // — the pre-booking copy never promises active booking; live copy is
    // booking-forward. Keep in sync with the `en` object below.
    // Daniel 2026-08-24, punkt 2: the pre-booking CTA used to read «Meld
    // interesse — åpner snart», which said "this vertical has not launched"
    // about a catalog that has been live and browsable for weeks (177
    // producers on prod). The state distinction is real and stays — no
    // producer has activated booking yet, so the live CTA must not appear —
    // but the honest thing to offer meanwhile is the catalog itself, not a
    // waiting list.
    drikkeCtaBrowse: "Se alle drikkeprodusentene", drikkeCtaLive: "Book besøk &amp; smaking",
    catKicker: "Utforsk", catTitle: "Opplevelser etter kategori", catIntro: "Bla i kategoriene &mdash; eller la en AI-agent filtrere på vær, sesong, pris og gruppestørrelse for deg.", catAria: "Kategorier", catCount: "opplevelser", catSoon: "Kommer snart", catNote: "Eksempelkategorier &mdash; live opplevelser publiseres fortløpende.",
    fylkeKicker: "Steder", fylkeTitle: "Utforsk etter fylke", fylkeIntro: "Se hvor opplevelsene finnes &mdash; velg et fylke for en fullstendig oversikt.", fylkeAria: "Fylker",
    kommuneTitle: "Populære kommuner", kommuneAria: "Populære kommuner",
    howKicker: "Tillitsmodell", howTitle: "Slik funker det", howSub: "Håndplukket, verifisert og utfylt &mdash; tre steg som skiller Opplevagent fra en vanlig oppføringsliste.",
    srcLabel: "Kilde:",
    s1t: "Håndplukket utvalg", s1b: "Vi henter inn opplevelser fortløpende fra utvalgte kilder &mdash; ikke et åpent annonsemarked, men ekte norske tilbydere vi har plukket ut.", s1src: "utvalgte tilbyderkilder",
    s2t: "Verifisert tilbyder", s2bPre: "Hver tilbyder kontrolleres mot Brønnøysundregistrene for å bekrefte at det står et ", s2bStrong: "aktivt selskap", s2bPost: " bak opplevelsen.", s2src: "Brønnøysundregistrene (Brreg)",
    s3t: "Utfylt med detaljer", s3b: "Vi henter detaljer fra tilbyderens egen nettside, slik at beskrivelser, varighet og praktisk info blir presise og oppdaterte.", s3src: "tilbyderens egen side",
    agentsKicker: "For AI-agenter", agentsTitle: "Bygget for å bli spurt av agenter", agentsBody: "Opplevagent eksponerer åpne, maskinlesbare flater etter A2A-protokollen. Agenter kan oppdage tilbudet, lese kontrakten og kjøre intent-søk &mdash; uten skraping.",
    endpointsAria: "Endepunkter for agenter", codeAria: "Eksempler på agent-kall", codeCmt1: "# message/send &mdash; naturlig språk", codeCmt2: "«hva kan vi finne på i Tromsø i vinter?»",
    footTagline: "Norske opplevelser og aktiviteter, håndplukket og verifisert &mdash; søkbart for mennesker og AI-agenter.", footExplore: "Utforsk", footAgents: "For agenter", footPrivacy: "Personvern", footTerms: "Vilkår", footVerified: "Tilbydere verifisert mot Brønnøysundregistrene",
  };
  const en: typeof no = {
    metaTitle: "Opplevagent — curated marketplace for Norwegian experiences",
    metaDesc: "Opplevagent is a curated marketplace for Norwegian experiences and activities — whale safaris, treehouses, guided tours, food and more. Searchable for AI agents by place, weather, season and group size.",
    ogTitle: "Opplevagent — Norwegian experiences, searchable for AI agents",
    ogImageAlt: "Opplevagent — marketplace for Norwegian experiences",
    skip: "Skip to main content",
    brandAria: "Opplevagent home",
    navAria: "Main navigation",
    navAll: "All experiences", navCategories: "Categories", navHow: "How it works", navAgents: "For AI agents", navExplore: "Explore",
    // Keep in sync with the `no` object above (S4 /for-tilbydere nav entry).
    navProviders: "For providers",
    heroPill: "A2A marketplace for Norwegian experiences",
    heroH1: "What can we do ", heroAccent: "today?",
    heroSub: "From whale safaris and treehouses to mountain hikes, food experiences and laser tag &mdash; hand-picked Norwegian experiences, gathered in one place.",
    searchAria: "Find experiences", searchLabel: "Describe what you want to do, or type a place", searchPlaceholder: "Search: whale safari, Oslo, food …", searchBtn: "Find experiences",
    hintPre: "Search by place, category or activity &mdash; or ", hintLink: "browse all experiences", hintPost: ".",
    // Keep in sync with the `no` object above.
    hintRoutePre: "\u{1F697} Driving somewhere? Type ", hintRouteLink: "“Oslo to Bergen”", hintRoutePost: " in the search box and we'll find stops along the way &mdash; or plan ", hintRouteLink2: "the full route", hintRoutePost2: ".",
    quickAria: "Quick search", qNature: "Outdoors", qAll: "All experiences",
    nearMeBtn: "Near me", nearMeRadiusLabel: "Search radius", nearMeLoading: "Locating…", nearMeDenied: "Location denied",
    trustAria: "Trust and data sources", trustBrreg: "Providers verified against the Norwegian business registry", trustFresh: "Content updated continuously", trustMachine: "Machine-readable for AI agents",
    counterAria: "Opplevagent in numbers",
    counterPageviews: "Page views", counterRealVisitors: "Real visitors", counterAiSearch: "AI search", counterCrawlers: "Crawlers &amp; bots",
    counterExperiences: "Experiences", counterProviders: "Providers", counterMunicipalities: "Municipalities",
    counterAiExplain: "AI search: a human asked ChatGPT, Claude or Perplexity, and the assistant fetched information from us in real time. Crawlers: automated indexing and scraping.",
    counterNoteShort: "AI search = an assistant fetched answers from us in real time.",
    counterWindowPre: "Last", counterWindowPost: "days",
    counterSincePre: "Figures since",
    networkLabel: "Part of the A2A network:", networkTagline: "Built for both humans and AI agents",
    // Keep in sync with the `no` object above (S2 drikkested feature section).
    drikkeKicker: "New", drikkeTitle: "Visit local drink producers",
    drikkeIntro: "Breweries, cideries, meaderies and distilleries open their doors for tastings and tours &mdash; book your visit directly with the producer, verified against the Norwegian business registry.",
    // Keep in sync with the `no` object above.
    drikkeIntroBrowse: "Breweries, cideries, meaderies and distilleries across the country &mdash; see who's near you, what they offer and how to get in touch. All verified against the Norwegian business registry.",
    drikkeCta: "Explore drink stops", drikkeAria: "Drink producers by type", drikkeChipCountAria: "producers",
    // Keep in sync with the `no` object above (arbeidspunkt 1, slice 6 +
    // Daniel 2026-08-24, punkt 2).
    drikkeCtaBrowse: "Browse the drink producers", drikkeCtaLive: "Book a visit &amp; tasting",
    catKicker: "Explore", catTitle: "Experiences by category", catIntro: "Browse curated categories &mdash; or let an AI agent filter by weather, season, price and group size for you.", catAria: "Categories", catCount: "experiences", catSoon: "Coming soon", catNote: "Example categories &mdash; live experiences are published continuously.",
    fylkeKicker: "Places", fylkeTitle: "Explore by county", fylkeIntro: "See where the experiences are &mdash; pick a county for a full overview.", fylkeAria: "Counties",
    kommuneTitle: "Popular municipalities", kommuneAria: "Popular municipalities",
    howKicker: "Trust model", howTitle: "How it works", howSub: "Hand-picked, verified and filled in &mdash; three steps that set Opplevagent apart from an ordinary listing.",
    srcLabel: "Source:",
    s1t: "Hand-picked selection", s1b: "We gather experiences continuously from selected sources &mdash; not an open ad market, but real Norwegian providers we have picked out.", s1src: "selected provider sources",
    s2t: "Verified provider", s2bPre: "Each provider is checked against the Norwegian business registry to confirm there's an ", s2bStrong: "active company", s2bPost: " behind the experience.", s2src: "Brønnøysund business registry (Brreg)",
    s3t: "Filled in with detail", s3b: "We pull details from the provider's own website, so descriptions, duration and practical info are accurate and up to date.", s3src: "the provider's own site",
    agentsKicker: "For AI agents", agentsTitle: "Built to be queried by agents", agentsBody: "Opplevagent exposes open, machine-readable surfaces following the A2A protocol. Agents can discover the offering, read the contract and run intent searches &mdash; without scraping.",
    endpointsAria: "Endpoints for agents", codeAria: "Examples of agent calls", codeCmt1: "# message/send &mdash; natural language", codeCmt2: "«what can we do in Tromsø this winter?»",
    footTagline: "Curated marketplace for Norwegian experiences and activities &mdash; searchable for humans and AI agents.", footExplore: "Explore", footAgents: "For agents", footPrivacy: "Privacy", footTerms: "Terms", footVerified: "Providers verified against the Norwegian business registry",
  };
  // dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent: Swedish
  // landing-page chrome. Only reachable when SV_LOCALE_ENABLED === "true"
  // (src/i18n/t.ts detectLangFromPath) — with the flag off no request ever
  // carries lang === "sv", so this object is inert. Keep in sync with `no`.
  const sv: typeof no = {
    metaTitle: "Opplevagent — norska upplevelser, handplockade och verifierade",
    metaDesc: "Handplockade norska upplevelser och aktiviteter — valsafari, trädkojor, guidade turer, mat och mer. Alla arrangörer är verifierade mot Brønnøysundregistrene, och katalogen är sökbar för AI-agenter.",
    ogTitle: "Opplevagent — norska upplevelser, sökbara för AI-agenter",
    ogImageAlt: "Opplevagent — marknadsplats för norska upplevelser",
    skip: "Hoppa till huvudinnehållet",
    brandAria: "Opplevagent startsida",
    navAria: "Huvudnavigering",
    navAll: "Alla upplevelser", navCategories: "Kategorier", navHow: "Så fungerar det", navAgents: "För AI-agenter", navExplore: "Utforska",
    navProviders: "För arrangörer",
    heroPill: "A2A-marknadsplats för norska upplevelser",
    heroH1: "Vad ska vi hitta på ", heroAccent: "i dag?",
    heroSub: "Från valsafari och trädkojor till fjällturer, matupplevelser och lasertag &mdash; handplockade norska upplevelser, samlade på ett ställe.",
    searchAria: "Hitta upplevelser", searchLabel: "Beskriv vad du vill göra, eller skriv en plats", searchPlaceholder: "Sök: valsafari, Oslo, mat …", searchBtn: "Hitta upplevelser",
    hintPre: "Sök på plats, kategori eller aktivitet &mdash; eller ", hintLink: "bläddra bland alla upplevelser", hintPost: ".",
    hintRoutePre: "\u{1F697} Ska du ut och köra? Skriv ", hintRouteLink: "«Oslo till Bergen»", hintRoutePost: " i sökfältet, så hittar vi stopp längs vägen &mdash; eller planera ", hintRouteLink2: "hela resrutten", hintRoutePost2: ".",
    quickAria: "Snabbsök", qNature: "Ute i naturen", qAll: "Alla upplevelser",
    nearMeBtn: "Nära mig", nearMeRadiusLabel: "Sökradie", nearMeLoading: "Hämtar position…", nearMeDenied: "Position nekad",
    trustAria: "Förtroende och datakällor", trustBrreg: "Arrangörer verifierade mot Brønnøysundregistrene", trustFresh: "Innehåll uppdateras löpande", trustMachine: "Maskinläsbart för AI-agenter",
    counterAria: "Opplevagent i siffror",
    counterPageviews: "Sidvisningar", counterRealVisitors: "Riktiga besökare", counterAiSearch: "AI-sökningar", counterCrawlers: "Sökrobotar &amp; bottar",
    counterExperiences: "Upplevelser", counterProviders: "Arrangörer", counterMunicipalities: "Kommuner",
    counterAiExplain: "AI-sökning: en människa frågade ChatGPT, Claude eller Perplexity, och assistenten hämtade information från oss i realtid. Sökrobotar: automatisk indexering och skrapning.",
    counterNoteShort: "AI-sökning = en assistent hämtade svar från oss i realtid.",
    counterWindowPre: "Senaste", counterWindowPost: "dagarna",
    counterSincePre: "Siffror sedan",
    networkLabel: "En del av A2A-nätverket:", networkTagline: "Byggt för både människor och AI-agenter",
    drikkeKicker: "Nytt", drikkeTitle: "Besök lokala dryckesproducenter",
    drikkeIntro: "Bryggerier, cidermakare, mjödbryggerier och destillerier öppnar dörrarna för provsmakning och visning &mdash; boka besöket direkt hos producenten, verifierad mot Brønnøysundregistrene.",
    drikkeIntroBrowse: "Bryggerier, cidermakare, mjödbryggerier och destillerier i hela landet &mdash; se vilka som finns där du är, vad de erbjuder och hur du tar kontakt. Alla verifierade mot Brønnøysundregistrene.",
    drikkeCta: "Utforska dryckesställen", drikkeAria: "Dryckesproducenter efter typ", drikkeChipCountAria: "producenter",
    drikkeCtaBrowse: "Se alla dryckesproducenter", drikkeCtaLive: "Boka besök &amp; provsmakning",
    catKicker: "Utforska", catTitle: "Upplevelser efter kategori", catIntro: "Bläddra bland kategorierna &mdash; eller låt en AI-agent filtrera på väder, säsong, pris och gruppstorlek åt dig.", catAria: "Kategorier", catCount: "upplevelser", catSoon: "Kommer snart", catNote: "Exempelkategorier &mdash; nya upplevelser publiceras löpande.",
    fylkeKicker: "Platser", fylkeTitle: "Utforska efter fylke", fylkeIntro: "Se var upplevelserna finns &mdash; välj ett fylke för en fullständig översikt.", fylkeAria: "Fylken",
    kommuneTitle: "Populära kommuner", kommuneAria: "Populära kommuner",
    howKicker: "Förtroendemodell", howTitle: "Så fungerar det", howSub: "Handplockat, verifierat och kompletterat &mdash; tre steg som skiljer Opplevagent från en vanlig katalog.",
    srcLabel: "Källa:",
    s1t: "Handplockat urval", s1b: "Vi samlar in upplevelser löpande från utvalda källor &mdash; inte en öppen annonsmarknad, utan riktiga norska arrangörer som vi har valt ut.", s1src: "utvalda arrangörskällor",
    s2t: "Verifierad arrangör", s2bPre: "Varje arrangör kontrolleras mot Brønnøysundregistrene för att bekräfta att det finns ett ", s2bStrong: "aktivt företag", s2bPost: " bakom upplevelsen.", s2src: "Brønnøysundregistrene (Brreg)",
    s3t: "Kompletterat med detaljer", s3b: "Vi hämtar detaljer från arrangörens egen webbplats, så att beskrivningar, varaktighet och praktisk information blir korrekta och uppdaterade.", s3src: "arrangörens egen webbplats",
    agentsKicker: "För AI-agenter", agentsTitle: "Byggt för att frågas av agenter", agentsBody: "Opplevagent exponerar öppna, maskinläsbara ytor enligt A2A-protokollet. Agenter kan upptäcka utbudet, läsa kontraktet och köra intentsökningar &mdash; utan skrapning.",
    endpointsAria: "Endpoints för agenter", codeAria: "Exempel på agentanrop", codeCmt1: "# message/send &mdash; naturligt språk", codeCmt2: "«vad kan vi göra i Tromsø i vinter?»",
    footTagline: "Norska upplevelser och aktiviteter, handplockade och verifierade &mdash; sökbara för människor och AI-agenter.", footExplore: "Utforska", footAgents: "För agenter", footPrivacy: "Integritet", footTerms: "Villkor", footVerified: "Arrangörer verifierade mot Brønnøysundregistrene",
  };
  if (lang === "en") return en;
  if (lang === "sv") return sv;
  return no;
}

// ─────────────────────────────────────────────────────────────
// Homepage drikkested feature section (dev-request
// 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S2): a "Nytt" callout
// card between the counter strip and #kategorier that fronts the gardssalg
// (drink-producer) category for the outreach launch. Rendered ONLY when
// gardssalgVisible() is true — the caller gates, and below threshold nothing
// (not even an empty wrapper) is emitted.
//
// `typeCounts` is countGardssalgProvidersByType()'s raw per-type rows.
// Chips aggregate to DRINK_TYPE_META's canonical LABELS (its own source of
// truth for label+color): cideri+sideri → «Sider», vingård (and the
// unaccented vingard spelling) → «Fruktvin», mjøderi/mjoderi → «Mjød»,
// seltzeri → «Kombucha». NULL/unknown producer_type rows are part of the
// gate's provider set but have no honest label — they simply get no chip.
// Only labels with count > 0 render.
// ─────────────────────────────────────────────────────────────
// Unaccented/transliterated aliases seen in enrichment data — same
// label/color as their accented DRINK_TYPE_META twins. Both ASCII spellings
// occur: the å→a strip (vingard/mjoderi) AND the å→aa / ø→oe
// transliteration (vingaard is a real pipeline spelling — see
// search-enrich.ts's producer-type mapping; mjoederi included for the same
// reason). Kept OUT of DRINK_TYPE_META itself so the badge surfaces'
// behavior (drinkBadge()/drinkTypeMeta()) is unchanged.
const DRINK_TYPE_UNACCENTED_ALIASES: Record<string, string> = {
  vingard: "vingård",
  vingaard: "vingård",
  mjoderi: "mjøderi",
  mjoederi: "mjøderi",
};

export function renderDrikkestedFeatureSection(
  lang: Lang,
  typeCounts: Array<{ producer_type: string | null; count: number }>,
  // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
  // 1 (slice 6): section-level "is booking meaningfully live for the
  // vertical as a whole right now" — the caller computes this defensively
  // (countGardssalgProvidersBookable() > 0 AND bookingDispatchEnabled()) and
  // degrades to false (dark-launch copy) on any DB error, same pattern as
  // `typeCounts` above. This is a COLLECTIVE flag, distinct from the
  // per-provider isBookingPaused() check used on individual booking CTAs
  // elsewhere on this route.
  bookable = false
): string {
  const S = homeStrings(lang);
  // Aggregate raw producer_type rows by canonical label.
  const agg = new Map<string, { label: string; color: string; count: number }>();
  for (const row of typeCounts) {
    if (!row || !Number.isFinite(row.count) || row.count <= 0) continue;
    const rawKey = row.producer_type ? row.producer_type.toLowerCase() : "";
    if (!rawKey) continue;
    const key = DRINK_TYPE_UNACCENTED_ALIASES[rawKey] ?? rawKey;
    const meta = DRINK_TYPE_META[key];
    if (!meta) continue; // unknown type — no honest chip label for it
    const cur = agg.get(meta.label);
    if (cur) cur.count += row.count;
    else agg.set(meta.label, { label: meta.label, color: meta.color, count: row.count });
  }
  const chips = [...agg.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "nb"))
    .map(
      (c) =>
        `<span class="drink-chip" role="listitem"><span class="dot" style="background:${c.color}" aria-hidden="true"></span>${escapeHtml(c.label)} <span class="n" aria-label="${c.count} ${S.drikkeChipCountAria}">${c.count}</span></span>`
    )
    .join("");

  // Small copper-kettle decor lifted from the drikke hero-scene motif —
  // pure decoration, hidden from AT.
  // The swan neck ends IN the little condenser box (review fix on 9e1559e:
  // it previously trailed off as a free-floating stroke).
  const decor = `<svg viewBox="0 0 120 120" width="132" height="132" aria-hidden="true" focusable="false">
<path fill="rgba(201,138,43,.5)" d="M32 98 C32 60 45 42 60 42 C75 42 88 60 88 98 Z"/>
<path fill="rgba(201,138,43,.5)" d="M45 42 C47 30 52 24 60 24 C68 24 73 30 75 42 Z"/>
<path fill="none" stroke="rgba(201,138,43,.55)" stroke-width="4" stroke-linecap="round" d="M60 24 C60 16 64 12 72 11 C88 9 98 18 100 32 L102 72"/>
<rect x="92" y="70" width="20" height="28" rx="4" fill="rgba(201,138,43,.42)"/>
<path fill="none" stroke="rgba(255,255,255,.32)" stroke-width="3.5" stroke-linecap="round" d="M54 16 C51 10 55 6 52 0 M66 18 C69 12 65 8 68 2"/>
</svg>`;

  return `
  <section class="section drikkested-feature" id="drikkested" aria-labelledby="drikkested-title">
    <div class="container">
      <div class="drikkested-card">
        <div class="drikkested-copy">
          <span class="kicker">${S.drikkeKicker}</span>
          <h2 id="drikkested-title">${S.drikkeTitle}</h2>
          <p>${bookable ? S.drikkeIntro : S.drikkeIntroBrowse}</p>
          ${chips ? `<div class="drink-chips" role="list" aria-label="${S.drikkeAria}">${chips}</div>` : ""}
          <a class="drikkested-cta" href="/kategori/gardssalg">${bookable ? S.drikkeCtaLive : S.drikkeCtaBrowse}</a>
        </div>
        <div class="drikkested-decor" aria-hidden="true">${decor}</div>
      </div>
    </div>
  </section>`;
}

// ═══════════════════════════════════════════════════════════
// GET / — minimal landing (Opplevagent, NOT the rfb homepage)
// ═══════════════════════════════════════════════════════════

router.get("/", (req: Request, res: Response) => {
  const url = baseUrl();
  const lang: Lang = req.lang === "en" ? "en" : "no";
  const S = homeStrings(lang);
  const canonical = lang === "en" ? `${url}/en` : url;

  // Categories are read defensively — the page must render perfectly with 0
  // Counter strip: live, host-scoped (opplevagent.no only) social-proof
  // numbers — server-rendered + cached (see src/services/oa-home-counters.ts
  // for the exact scoping/exclusion rules this reuses from the RFB homepage
  // pattern). Read defensively — must never break the homepage.
  const numFmt = lang === "en" ? "en-US" : "nb-NO";
  let counters = { pageViews: 0, uniqueVisitors: 0, realVisitors: 0, aiSearchViews: 0, botViews: 0, windowDays: 60, realHumans: 0, botAndAi: 0, opplevelser: 0, tilbydere: 0, kommuner: 0, sinceDate: null as string | null };
  try {
    counters = getOaHomeCounters();
  } catch {
    // Analytics/catalog DB not open — render the strip with 0s rather than
    // failing the whole homepage.
  }
  // Since-date: the oldest analytics datapoint the counters above are drawn
  // from (counters.sinceDate, from oa-home-counters.ts). Omit entirely when
  // null (no analytics rows yet) or unparseable — never render
  // "since Invalid Date".
  let sinceDateFragment = "";
  if (counters.sinceDate) {
    const sinceD = new Date(counters.sinceDate);
    if (!isNaN(sinceD.getTime())) {
      const formattedSinceDate = sinceD.toLocaleDateString(numFmt, { day: "numeric", month: "short", year: "numeric" });
      sinceDateFragment = ` &middot; ${S.counterSincePre} ${formattedSinceDate}`;
    }
  }
  const counterStripHtml = `
  <div class="counters" aria-label="${S.counterAria}">
    <div class="counters-inner">
      <div class="counter-item"><div class="counter-val">${counters.pageViews.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterPageviews}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.realVisitors.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterRealVisitors}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item" title="${S.counterAiExplain}"><div class="counter-val counter-val-accent">${counters.aiSearchViews.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterAiSearch}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.botViews.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterCrawlers}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.opplevelser.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterExperiences}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.tilbydere.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterProviders}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.kommuner.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterMunicipalities}</div></div>
    </div>
    <div class="counter-note">${S.counterNoteShort} &middot; ${S.counterWindowPre} ${counters.windowDays} ${S.counterWindowPost}${sinceDateFragment}</div>
    <div class="network-strip">${S.networkLabel}
      <a href="https://rettfrabonden.com" rel="noopener">rettfrabonden.com</a> &middot;
      <a href="https://finn-tannlege.com" rel="noopener">finn-tannlege.com</a>
      &mdash; ${S.networkTagline}
    </div>
  </div>`;

  // S2 drikkested feature section — gated on the SAME gardssalgVisible()
  // flag as the category card/nav/sitemap; below threshold NOTHING renders.
  // Type counts are read defensively (must never break the homepage).
  let drikkestedSectionHtml = "";
  if (gardssalgVisible()) {
    let drinkTypeCounts: Array<{ producer_type: string | null; count: number }> = [];
    try { drinkTypeCounts = countGardssalgProvidersByType(); } catch { drinkTypeCounts = []; }
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
    // 1 (slice 6): section-level "live" = at least one REAL (non-hidden)
    // gårdssalg provider has booking_live=1 AND the global dispatch master
    // switch is on. Read defensively, same pattern as drinkTypeCounts above —
    // degrade to dark-launch (false) on any DB error, never throw.
    let drikkeBookable = false;
    try { drikkeBookable = countGardssalgProvidersBookable() > 0 && bookingDispatchEnabled(); } catch { drikkeBookable = false; }
    drikkestedSectionHtml = renderDrikkestedFeatureSection(lang, drinkTypeCounts, drikkeBookable);
  }

  // categories (DB not open / no data yet). When empty we show a tasteful set
  // of example categories so the grid never looks broken pre-data.
  // gårdssalg is filtered out here defensively (see isGardssalgCategorySlug()'s
  // doc comment above) — the grid must show ONLY real experience categories.
  const cats = safeCategories().filter((c) => !isGardssalgCategorySlug(c.category));
  const fallbackCats: Array<{ category: string; count: number }> = [
    { category: "Natur & friluft", count: 0 },
    { category: "Mat & drikke", count: 0 },
    { category: "På vannet", count: 0 },
    { category: "Vinter", count: 0 },
    { category: "Kultur", count: 0 },
    { category: "Familievennlig", count: 0 },
  ];
  const usingFallbackCats = cats.length === 0;
  // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 1
  // (slice 6): Phase 1 used to inject a synthetic { category: "gardssalg" }
  // card into catSource here once gardssalgVisible() crossed the threshold —
  // REMOVED. Gårdssalg now has its own dedicated #drikkested feature section
  // (renderDrikkestedFeatureSection(), rendered separately below via
  // drikkestedSectionHtml) instead of living inside the experience-category
  // grid as one more card; the grid is real experience categories only.
  const catSource = usingFallbackCats ? fallbackCats : cats.slice(0, 12);

  // Each category card carries its own unique inline glyph (see CATEGORY_ICON_INNER
  // / catIconSvg above). Keyed on the category slug, with a fuzzy + compass
  // fallback for the pre-data example labels — no external image files.

  const catCards = catSource
    .map((c) => {
      const count =
        !usingFallbackCats && Number.isFinite(c.count) && c.count > 0
          ? `<span class="cat-count">${c.count} ${S.catCount}</span>`
          : `<span class="cat-count cat-count-soon">${S.catSoon}</span>`;
      // Phase 2: human-facing category cards link to the server-rendered
      // /kategori/<x> HTML page (not the raw discover JSON). Pre-data fallback
      // cards point at the index so the grid still leads somewhere sensible.
      const href = usingFallbackCats
        ? `/opplevelser`
        : `/kategori/${encodeURIComponent(c.category)}`;
      // Daniel 2026-08-24: each card wears its own category colour — the icon
      // tile in a wash of it, a matching top edge. Same categoryColor() source
      // the listing cards, chips and covers read, and it resolves the pre-data
      // example LABELS too ("Natur & friluft"), so the fallback grid is
      // coloured exactly like the live one.
      const cc = categoryColor(c.category);
      return `<a class="cat-card" style="border-top-color:${cc}" href="${href}">
        <span class="cat-ico" aria-hidden="true" style="color:${cc};background:${cc}1f;border:1px solid ${cc}33">${catIconSvg(c.category, 26)}</span>
        <span class="cat-body">
          <span class="cat-name">${escapeHtml(catLabel(c.category))}</span>
          ${count}
        </span>
      </a>`;
    })
    .join("");

  const catNote = usingFallbackCats
    ? `<p class="cat-note">${S.catNote}</p>`
    : "";

  // Fylke grid + top-10 kommuner chips: read defensively (DB may not be open
  // pre-data) — the homepage must never break because of this section.
  // listPublishedFylker()/listPublishedKommuner() already gate on
  // PUBLISH_GATE_SQL and are ordered by count DESC, so the count > 0 filter
  // below is just a defensive belt-and-braces check, not a real-world case.
  let fylkerForGrid: Array<{ fylke: string; count: number }> = [];
  try { fylkerForGrid = listPublishedFylker().filter((f) => f.fylke && f.count > 0); } catch { /* DB not open */ }
  let kommunerForChips: Array<{ kommune: string; fylke: string | null; count: number }> = [];
  try { kommunerForChips = listPublishedKommuner().filter((k) => k.kommune && k.count > 0).slice(0, 10); } catch { /* DB not open */ }

  const fylkeGridCards = fylkerForGrid
    .map(
      (f) =>
        `<a class="fylke-card" href="/fylke/${encodeURIComponent(f.fylke)}">
          <span class="fylke-card-name">${escapeHtml(f.fylke)}</span>
          <span class="fylke-card-count">${f.count} ${S.catCount}</span>
        </a>`
    )
    .join("");

  const kommuneChipsHtml = kommunerForChips
    .map(
      (k) =>
        `<a class="chip" href="/kommune/${encodeURIComponent(k.kommune)}">${escapeHtml(k.kommune)} <span class="n">${k.count}</span></a>`
    )
    .join("");

  const fylkeSectionHtml = fylkerForGrid.length > 0
    ? `
  <section class="section" id="fylker" aria-labelledby="fylke-title">
    <div class="container">
      <div class="sec-head">
        <span class="kicker">${S.fylkeKicker}</span>
        <h2 id="fylke-title">${S.fylkeTitle}</h2>
        <p>${S.fylkeIntro}</p>
      </div>
      <div class="fylke-grid" role="list" aria-label="${S.fylkeAria}">
        ${fylkeGridCards}
      </div>
      ${kommuneChipsHtml
        ? `<div class="fylke-kommuner">
        <h3>${S.kommuneTitle}</h3>
        <div class="chips" role="list" aria-label="${S.kommuneAria}">
          ${kommuneChipsHtml}
        </div>
      </div>`
        : ""}
    </div>
  </section>`
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
        "Håndplukkede norske opplevelser og aktiviteter — verifiserte tilbydere, søkbart for både folk og AI-agenter.",
      inLanguage: lang === "en" ? "en-US" : "nb-NO",
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${url}/sok?q={search_term_string}`,
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

  const desc = S.metaDesc;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="${htmlLangAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(S.metaTitle)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#0e3c36">
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="nb" href="${url}">
<link rel="alternate" hreflang="en" href="${url}/en">
<link rel="alternate" hreflang="x-default" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags({ includeThemeColor: false })}
<meta property="og:title" content="${escapeHtml(S.ogTitle)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="${ogLocale(lang)}">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${url}/favicon.svg">
<meta property="og:image:alt" content="${escapeHtml(S.ogImageAlt)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Opplevagent">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${url}/favicon.svg">
${ldScripts}
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --fjord-900:#0b2e29;--fjord-800:#0e3c36;--fjord-700:#0f5a50;--fjord-600:#0c7264;
    --font-brand:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--olive:#6f7a4f;--gold:#c98a2b;
    --teal-500:#12a594;--teal-400:#3cc3b4;
    --amber-500:#ff5d3b;--amber-400:#ff8566;--coral-500:#ff5d3b;
    --ink:#18130d;--ink-soft:#544a3e;--mist:#7a7163;
    --surface:#ffffff;--canvas:#f7f4ee;--canvas-2:#efe9dd;--line:#e4ded0;
    --r-sm:8px;--r-md:14px;--r-lg:22px;--r-pill:999px;
    --sh-sm:0 1px 2px rgba(24,19,13,.06),0 2px 6px rgba(24,19,13,.05);
    --sh-md:0 6px 18px rgba(24,19,13,.10);
    --sh-lg:0 18px 48px rgba(24,19,13,.22);
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

  /* ── HEADER / NAV + FOOTER: shared site chrome (S1) ── */
  ${OA_CHROME_CSS}

  /* ── HERO ── */
  .hero{position:relative;overflow:hidden;color:#fff;background:linear-gradient(135deg,#0b2e29 0%,#0e3c36 34%,#0f5a50 56%,#12a594 82%,#ff5d3b 136%)}
  .hero::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 18% 8%,rgba(60,195,180,.30),transparent 55%),radial-gradient(90% 80% at 92% 18%,rgba(255,93,59,.28),transparent 60%);pointer-events:none}
  ${OA_HERO_SCENE_CSS}
  .hero-inner{position:relative;max-width:920px;margin:0 auto;padding:84px 24px 104px;text-align:center;z-index:1}
  @media(max-width:560px){.hero-inner{padding:60px 16px 96px}}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:var(--r-pill);background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);font-size:.78rem;font-weight:600;letter-spacing:.02em;margin-bottom:22px;backdrop-filter:blur(4px)}
  .eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--amber-400);box-shadow:0 0 0 4px rgba(255,133,102,.25)}
  .hero h1{font-size:clamp(2rem,5.2vw,3.4rem);font-weight:800;letter-spacing:-.035em;line-height:1.08;margin-bottom:18px;text-shadow:0 2px 30px rgba(24,19,13,.25)}
  .hero h1 .accent{background:linear-gradient(100deg,var(--amber-400),var(--coral-500));-webkit-background-clip:text;background-clip:text;color:transparent}
  .hero-sub{font-size:clamp(1.02rem,2.1vw,1.22rem);max-width:620px;margin:0 auto 34px;color:rgba(255,255,255,.92)}

  /* discovery prompt */
  .discover{max-width:640px;margin:0 auto}
  .discover-form{display:flex;gap:0;background:#fff;border-radius:var(--r-pill);padding:7px 7px 7px 8px;box-shadow:var(--sh-lg);align-items:center}
  .discover-form .field{display:flex;align-items:center;gap:10px;flex:1;padding-left:12px;min-width:0}
  .discover-form .field svg{color:var(--mist);flex:0 0 20px}
  .discover-form input{flex:1;border:none;outline:none;font-size:1.02rem;color:var(--ink);background:transparent;padding:14px 4px;min-width:0}
  .discover-form input::placeholder{color:#90a399}
  .discover-form button{flex:0 0 auto;border:none;cursor:pointer;background:linear-gradient(135deg,var(--amber-500),var(--coral-500));color:#fff;font-weight:800;font-size:.96rem;padding:14px 26px;border-radius:var(--r-pill);box-shadow:0 4px 14px rgba(255,93,59,.4);transition:transform .12s ease,box-shadow .12s ease}
  .discover-form button:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(255,93,59,.5)}
  .discover-form button:active{transform:translateY(0)}
  @media(max-width:520px){
    .discover-form{flex-direction:column;border-radius:var(--r-lg);padding:10px;gap:8px;align-items:stretch}
    .discover-form .field{padding:6px 10px;background:var(--canvas);border-radius:var(--r-md)}
    .discover-form input{padding:12px 4px}
    .discover-form button{width:100%;padding:14px}
  }
  .discover-hint{margin-top:16px;font-size:.85rem;color:rgba(255,255,255,.82)}
  .quick{margin-top:22px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center}
  /* «Nær meg» + radius live INSIDE the chip row (Daniel 2026-08-24, punkt 1)
     — one row of controls under the search box instead of three stacked ones.
     Styled to match .quick a exactly so the row reads as a single set. */
  .quick-geo{display:inline-flex;align-items:center;gap:6px}
  .quick-geo button,.quick-geo select{padding:7px 15px;border-radius:var(--r-pill);background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);color:#fff;font-size:.82rem;font-weight:600;cursor:pointer;font-family:inherit}
  .quick-geo select{padding:7px 10px}
  .quick-geo select option{color:#18130d}
  .quick-geo button:hover,.quick-geo select:hover{background:rgba(255,255,255,.26)}
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

  /* ── COUNTER STRIP (social-proof numbers, server-rendered + cached) ── */
  .counters{background:var(--surface);border-bottom:1px solid var(--line)}
  .counters-inner{max-width:var(--maxw);margin:0 auto;padding:20px 24px;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:14px 30px}
  @media(max-width:560px){.counters-inner{padding:16px;gap:12px 20px}}
  .counter-item{text-align:center}
  .counter-val{font-size:1.25rem;font-weight:800;color:var(--fjord-700);letter-spacing:-.02em;line-height:1}
  .counter-val.counter-val-accent{color:var(--coral-500)}
  .counter-lbl{margin-top:3px;font-size:.68rem;font-weight:600;color:var(--mist);text-transform:uppercase;letter-spacing:.04em}
  .counter-sep{width:1px;height:26px;background:var(--line)}
  @media(max-width:640px){.counter-sep{display:none}}

  /* ── DRIKKESTED FEATURE (S2) ── */
  .drikkested-card{position:relative;overflow:hidden;display:grid;grid-template-columns:1fr auto;gap:30px;align-items:center;background:linear-gradient(135deg,var(--fjord-900) 0%,var(--fjord-700) 90%);color:#fff;border-radius:var(--r-lg);padding:44px 40px;box-shadow:var(--sh-md)}
  .drikkested-card::before{content:"";position:absolute;inset:0;background:radial-gradient(75% 110% at 100% 10%,rgba(201,138,43,.20),transparent 60%);pointer-events:none}
  @media(max-width:720px){.drikkested-card{grid-template-columns:1fr;padding:32px 24px}.drikkested-decor{display:none}}
  .drikkested-copy{position:relative}
  .drikkested-card .kicker{color:var(--amber-400)}
  .drikkested-card h2{font-size:clamp(1.45rem,3vw,2rem);font-weight:800;letter-spacing:-.02em;margin-bottom:12px}
  .drikkested-card p{color:rgba(255,255,255,.9);font-size:1rem;max-width:52ch}
  .drink-chips{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 24px}
  .drink-chip{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:var(--r-pill);background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);font-size:.84rem;font-weight:600}
  .drink-chip .dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 3px rgba(255,255,255,.12)}
  .drink-chip .n{opacity:.75;font-weight:700}
  .drikkested-cta{display:inline-flex;align-items:center;gap:8px;padding:13px 26px;border-radius:var(--r-pill);background:linear-gradient(135deg,var(--amber-500),var(--coral-500));color:#fff;font-weight:800;font-size:.95rem;box-shadow:0 4px 14px rgba(255,93,59,.4);transition:transform .12s ease,box-shadow .12s ease}
  .drikkested-cta:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(255,93,59,.5);text-decoration:none}
  .drikkested-decor{position:relative;padding-right:8px}
  .counter-note{max-width:var(--maxw);margin:0 auto;padding:0 24px 14px;text-align:center;font-size:.7rem;color:var(--mist);line-height:1.5}
  .network-strip{max-width:var(--maxw);margin:0 auto;padding:0 24px 16px;text-align:center;font-size:.74rem;color:var(--mist)}
  .network-strip a{color:var(--fjord-700);font-weight:600;text-decoration:none}
  .network-strip a:hover{text-decoration:underline}

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
  .cat-card{display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--fjord-700);border-radius:var(--r-md);padding:15px 18px 18px;box-shadow:var(--sh-sm);transition:transform .16s ease,box-shadow .16s ease}
  .section-alt .cat-card{background:var(--canvas)}
  .cat-card:hover{transform:translateY(-3px);box-shadow:var(--sh-md);text-decoration:none}
  .cat-ico{flex:0 0 50px;width:50px;height:50px;border-radius:13px;display:flex;align-items:center;justify-content:center}
  .cat-body{display:flex;flex-direction:column;gap:3px;min-width:0}
  .cat-name{font-weight:700;color:var(--ink);font-size:1rem;letter-spacing:-.01em}
  .cat-count{font-size:.82rem;color:var(--mist)}
  .cat-count-soon{color:var(--amber-500);font-weight:600}
  .cat-note{margin-top:20px;font-size:.88rem;color:var(--mist)}

  /* fylke grid + kommune chips */
  .fylke-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
  .fylke-card{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:16px 18px;box-shadow:var(--sh-sm);transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
  .section-alt .fylke-card{background:var(--canvas)}
  .fylke-card:hover{transform:translateY(-3px);box-shadow:var(--sh-md);border-color:var(--teal-400);text-decoration:none}
  .fylke-card-name{display:block;font-weight:700;color:var(--ink);font-size:1rem;letter-spacing:-.01em}
  .fylke-card-count{display:block;margin-top:4px;font-size:.82rem;color:var(--mist)}
  @media(max-width:560px){
    .fylke-grid{grid-template-columns:1fr 1fr;gap:10px}
    .fylke-card{padding:12px 10px}
    .fylke-card-name{font-size:.86rem}
    .fylke-card-count{font-size:.72rem;margin-top:2px}
  }
  .fylke-kommuner{margin-top:36px}
  .fylke-kommuner h3{font-size:.95rem;font-weight:700;color:var(--ink);margin-bottom:12px}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.82rem;font-weight:600;border:1px solid var(--line)}
  .chip:hover{text-decoration:none;border-color:var(--teal-400);color:var(--fjord-700)}
  .chip .n{color:var(--mist);font-weight:600}
  .chip-dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:0 0 9px}

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
  .agents::before{content:"";position:absolute;inset:0;background:radial-gradient(80% 120% at 100% 0%,rgba(60,195,180,.22),transparent 55%);pointer-events:none}
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

  /* (footer styles live in the shared chrome block above) */

  /* ── HOMEPAGE STILL-SKETCH MOTIF (dev-request 2026-08-08-opplevagent-ux-
     loft-kategorimotiver): discreet line-drawn backdrop for the #kategorier
     section ONLY — never the hero, which keeps its own untouched illustrated
     scene above. */
  ${stillSketchCss("hjem")}
</style>
</head>
<body>
<a class="skip-link" href="#hovedinnhold">${S.skip}</a>

${oaSiteNav({ active: "hjem", lang })}

<main id="hovedinnhold">
  <section class="hero" aria-labelledby="hero-title">
    ${heroSceneSvg("forside")}
    <div class="hero-inner">
      <span class="eyebrow"><span class="dot"></span> ${S.heroPill}</span>
      <h1 id="hero-title">${S.heroH1}<span class="accent">${S.heroAccent}</span></h1>
      <p class="hero-sub">${S.heroSub}</p>

      <div class="discover">
        <form class="discover-form" action="/sok" method="GET" role="search" aria-label="${S.searchAria}" id="discover-form">
          <span class="field">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5 L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <label for="discover-q" class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">${S.searchLabel}</label>
            <input id="discover-q" name="q" type="search" autocomplete="off" placeholder="${S.searchPlaceholder}">
          </span>
          <button type="submit">${S.searchBtn}</button>
        </form>
        <p class="discover-hint">${S.hintPre}<a href="/opplevelser" style="color:#fff;text-decoration:underline">${S.hintLink}</a>${S.hintPost}</p>
        <!-- dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info,
             Goal 3: the hero hint didn't mention reiserute (route/corridor)
             search at all — Daniel: «dette nevnes ikke i informasjonen som
             ligger nær søkefeltet». Same search box now also detects a route
             typed straight in (Goal 2) and redirects to /reise; this line
             is what makes that capability discoverable rather than hidden. -->
        <p class="discover-hint discover-hint-route">${S.hintRoutePre}<strong>${S.hintRouteLink}</strong>${S.hintRoutePost}<a href="/reise" style="color:#fff;text-decoration:underline">${S.hintRouteLink2}</a>${S.hintRoutePost2}</p>
        <!-- dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok
             fix 0f(ii): OpplevAgent's «Nær meg» affordance existed on /sok and
             on the browse pages, but NOT on the homepage — so the first thing
             a visitor sees offered no way to search by position without
             typing a place name first (navigator.geolocation grep = 0 on both
             homepages). Same progressive-enhancement contract as
             renderNearMeBox(): the control removes itself when the browser has
             no geolocation API, and nothing else on the page changes.
             Daniel 2026-08-24, punkt 1: it used to sit in its own row above
             the quick chips — four stacked rows of small print under one
             search box. Same control, same script, now the first item IN the
             chip row; hiding it drops the <span id="home-nearme"> only, never
             the whole row. The two hardcoded fylke chips (Oslo / Troms og
             Finnmark) were removed in the same pass — the DB-driven fylke-grid
             further down the page is where fylke links belong. -->
        <div class="quick" role="list" aria-label="${S.quickAria}">
          <span role="listitem" class="quick-geo" id="home-nearme">
            <button type="button" id="homeGeoBtn">\u{1F4CD} ${S.nearMeBtn}</button>
            <select id="home-radius" aria-label="${S.nearMeRadiusLabel}">
              <option value="25">25 km</option>
              <option value="50" selected>50 km</option>
              <option value="100">100 km</option>
              <option value="200">200 km</option>
            </select>
          </span>
          <a role="listitem" href="/sok?q=natur">${S.qNature}</a>
          <a role="listitem" href="/opplevelser">${S.qAll}</a>
        </div>
        <script>
        (function(){
          var b = document.getElementById('homeGeoBtn');
          if (!b) return;
          if (!('geolocation' in navigator)) { var w = document.getElementById('home-nearme'); if (w) w.style.display = 'none'; return; }
          b.addEventListener('click', function(){
            var original = b.innerHTML;
            b.textContent = '\u23F3 ${S.nearMeLoading}';
            b.disabled = true;
            navigator.geolocation.getCurrentPosition(function(pos){
              var sel = document.getElementById('home-radius');
              var r = (sel && sel.value) || '50';
              window.location.href = '/sok?lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude +
                '&radius_km=' + encodeURIComponent(r) + '&sort=distance';
            }, function(){
              b.textContent = '\u274C ${S.nearMeDenied}';
              b.disabled = false;
              setTimeout(function(){ b.innerHTML = original; }, 2500);
            }, { enableHighAccuracy: false, timeout: 8000 });
          });
        })();
        </script>
      </div>
    </div>
  </section>

  <div class="trust" aria-label="${S.trustAria}">
    <div class="trust-inner">
      <span class="trust-item"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12 L11 14.5 L15.5 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> ${S.trustBrreg}</span>
      <span class="trust-sep" aria-hidden="true"></span>
      <span class="trust-item"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7 V12 L15.5 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> ${S.trustFresh}</span>
      <span class="trust-sep" aria-hidden="true"></span>
      <span class="trust-item"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 9 H21 M8 14 H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> ${S.trustMachine}</span>
    </div>
  </div>
  ${counterStripHtml}
  ${drikkestedSectionHtml}

  <section class="section oa-sketch-stage" id="kategorier" aria-labelledby="kat-title">
    ${stillSketchSvg("hjem")}
    <div class="container">
      <div class="sec-head">
        <span class="kicker">${S.catKicker}</span>
        <h2 id="kat-title">${S.catTitle}</h2>
        <p>${S.catIntro}</p>
      </div>
      <div class="cat-grid" role="list" aria-label="${S.catAria}">
        ${catCards}
      </div>
      ${catNote}
    </div>
  </section>
  ${fylkeSectionHtml}

  <section class="section section-alt" id="slik-funker-det" aria-labelledby="slik-title">
    <div class="container">
      <div class="sec-head center">
        <span class="kicker">${S.howKicker}</span>
        <h2 id="slik-title">${S.howTitle}</h2>
        <p>${S.howSub}</p>
      </div>
      <div class="steps">
        <div class="step">
          <div class="step-num" aria-hidden="true">1</div>
          <h3>${S.s1t}</h3>
          <p>${S.s1b}</p>
          <p class="src">${S.srcLabel} <strong>${S.s1src}</strong></p>
        </div>
        <div class="step">
          <div class="step-num" aria-hidden="true">2</div>
          <h3>${S.s2t}</h3>
          <p>${S.s2bPre}<strong>${S.s2bStrong}</strong>${S.s2bPost}</p>
          <p class="src">${S.srcLabel} <strong>${S.s2src}</strong></p>
        </div>
        <div class="step">
          <div class="step-num" aria-hidden="true">3</div>
          <h3>${S.s3t}</h3>
          <p>${S.s3b}</p>
          <p class="src">${S.srcLabel} <strong>${S.s3src}</strong></p>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="for-agenter" aria-labelledby="agent-title">
    <div class="container">
      <div class="agents">
        <div class="agents-grid">
          <div>
            <span class="kicker" style="color:var(--teal-400)">${S.agentsKicker}</span>
            <h2 id="agent-title">${S.agentsTitle}</h2>
            <p>${S.agentsBody}</p>
            <ul class="endpoints" aria-label="${S.endpointsAria}">
              <li><a href="/.well-known/agent-card.json" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8 H16 M8 12 H16 M8 16 H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Agent Card ↗</a></li>
              <li><a href="${OPPLEVAGENT_CUSTOM_GPT_URL}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 5 H20 V16 H9 L5 20 V16 H4 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg> ChatGPT ↗</a></li>
              <li><a href="/mcp" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12 H16 M12 8 V16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> MCP ↗</a></li>
              <li><a href="/openapi.json" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12 H21 M12 3 C15 6 15 18 12 21 C9 18 9 6 12 3" fill="none" stroke="currentColor" stroke-width="2"/></svg> OpenAPI 3.1 ↗</a></li>
              <li><a href="/llms.txt" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 3 H14 L19 8 V21 H6 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3 V8 H19" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg> llms.txt ↗</a></li>
              <li><a href="/.well-known/agents.txt" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 20 C3.5 16 6 14 9 14 C12 14 14.5 16 14.5 20 M16 12 L18 14 L22 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> agents.txt ↗</a></li>
            </ul>
          </div>
          <div class="code-card" aria-label="${S.codeAria}">
            <span class="c-label">A2A JSON-RPC</span>
            <div><span class="mtd">POST</span> <span class="pth">/a2a</span></div>
            <div class="cmt">${S.codeCmt1}</div>
            <div class="cmt">${S.codeCmt2}</div>
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

${oaSiteFooter({ lang })}

<script>
/* Progressive enhancement: an empty search should land on the full index rather
   than an empty /sok page. With JS disabled the form still submits ?q=<text> as
   a plain GET to /sok (the HTML search page), and every quick-link is a normal
   href — so the page is fully functional without this script. */
(function(){
  var form = document.getElementById('discover-form');
  var input = document.getElementById('discover-q');
  if(!form || !input) return;
  form.addEventListener('submit', function(e){
    var raw = (input.value || '').trim();
    if(!raw){ e.preventDefault(); window.location.href = '/opplevelser'; }
    // non-empty -> let the native GET /sok?q=<text> submission proceed.
  });
})();
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════
// GET /<INDEXNOW_KEY>.txt — IndexNow key file
// dev-request 2026-07-04-sokemotor-indeksering-og-lenker slice 1.
// Literal path (not a :param wildcard), so it can't shadow llms.txt
// or any other .txt route — non-matching *.txt requests just fall
// through to the catch-all 404 handler below unaffected.
// ═══════════════════════════════════════════════════════════

router.get(`/${INDEXNOW_KEY}.txt`, (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(INDEXNOW_KEY);
});

// ═══════════════════════════════════════════════════════════
// GET /robots.txt
// ═══════════════════════════════════════════════════════════

// Shared per-group disallows (GSC 2026-07-19 opplevagent.no index audit: 231
// "Excluded by noindex tag" + 36 "Crawled - currently not indexed", the same
// crawl-budget-bleed pattern already root-caused + fixed for rettfrabonden.com
// in PR #302). Root causes ported here:
//   /kategori/gardssalg/eier/       private owner-claim portal (magic-link
//                                   entry, per-provider portal, logout) — see
//                                   src/routes/gardssalg-claim.ts.
//   /kategori/gardssalg/book/*/confirm/   per-booking confirmation page (real
//                                   booking ref + guest data) — ephemeral,
//                                   the wildcard covers every :providerSlug.
//   /kategori/gardssalg/bekreft/    booking magic-link-style confirm token.
//   /kategori/gardssalg/svar/       producer answer-to-booking-request token page.
//   /kategori/gardssalg/gjestesvar/ guest answer-to-suggested-time token page.
//   /kategori/gardssalg/status/     booking status page (bookingRef+guestToken).
//   /admin/                         admin surface — X-Admin-Key gated
//                                   regardless; this is defense-in-depth.
// Every one of these already carries its own noindex meta tag (svar/
// gjestesvar/status/bekreft render through the shared previsitPage() shell;
// confirm/eier render their own) — Disallow keeps crawlers from spending
// budget fetching them at all, on top of that.
// These must be repeated inside EVERY user-agent group below: a crawler that
// matches a specific group (e.g. Googlebot) ignores the rules under
// "User-agent: *" entirely — that exemption (Googlebot/Bingbot only ever
// getting a bare "Allow: /") was the actual root cause of the GSC bleed.
// Deliberately NOT listed here:
//   /kategori/gardssalg/produsent/:providerSlug   public producer profile —
//     must stay crawlable; its own catalog_hidden=1 gate is a per-row
//     <meta name="robots"> noindex, not a robots.txt exclusion.
//   /kategori/gardssalg/book/:providerSlug (no /confirm/)   the booking FORM
//     itself is already noindex,follow via its own meta tag — crawlers may
//     still need to fetch it for OG-preview generation, so it stays Allow.
//   /sok   already noindex,follow via its own meta tag — same reasoning.
const GARDSSALG_ROBOTS_DISALLOWS = `Disallow: /kategori/gardssalg/eier/
Disallow: /kategori/gardssalg/book/*/confirm/
Disallow: /kategori/gardssalg/bekreft/
Disallow: /kategori/gardssalg/svar/
Disallow: /kategori/gardssalg/gjestesvar/
Disallow: /kategori/gardssalg/status/
Disallow: /admin/`;

router.get("/robots.txt", (_req: Request, res: Response) => {
  const url = baseUrl();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# opplevagent.no — robots.txt
# A2A-markedsplass for norske opplevelser og aktiviteter.
# AI-agenter er velkomne til å indeksere og sitere data fra denne tjenesten.

User-agent: *
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

# LLM-vennlige endepunkter
# Oversikt:      ${url}/llms.txt
# Discovery:     ${url}/api/opplevelser/discover

User-agent: GPTBot
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: OAI-SearchBot
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: ClaudeBot
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: anthropic-ai
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: PerplexityBot
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: Google-Extended
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: Googlebot
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

User-agent: Bingbot
Allow: /
${GARDSSALG_ROBOTS_DISALLOWS}

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
    { p: "/en", freq: "daily", pri: "0.9" },
    { p: "/opplevelser", freq: "daily", pri: "0.9" },
    // S4 (dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering):
    // the /for-tilbydere provider-onboarding page is indexable and statically
    // present (no DB dependency). Its /for-tilbydere/finn search subpage is
    // noindex,follow (its own meta tag) and deliberately NOT listed here.
    { p: "/for-tilbydere", freq: "monthly", pri: "0.6" },
    { p: "/slik-fungerer-det", freq: "monthly", pri: "0.6" },
    { p: "/guide-opplevelser-mcp", freq: "monthly", pri: "0.6" },
    { p: "/proveniens", freq: "monthly", pri: "0.5" },
    { p: "/llms.txt", freq: "weekly", pri: "0.8" },
    { p: "/openapi.json", freq: "weekly", pri: "0.7" },
  ];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
  for (const { p, freq, pri } of paths) {
    xml += `\n  <url><loc>${url}${p === "/" ? "" : p}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority><lastmod>${today}</lastmod></url>`;
  }
  // DB-driven weave (Phase 2): one <url> per published experience detail page
  // PLUS one per category / fylke / provider index that has ≥1 published
  // experience. All read through the same publish gate the pages use, so the
  // sitemap lists exactly the URLs that render 200 — zero orphan/dead entries.
  // Defensive — if the experiences DB is not open we just emit the static URLs.
  // Back-fill slugs for any providers added since the last /tilbyder/ request,
  // BEFORE the gårdssalg provider list is fetched below — backfillProviderSlugs()
  // is idempotent (WHERE slug IS NULL — fast no-op when all providers already
  // have slugs), so calling it here is safe on every sitemap request. Must run
  // before the fetch immediately below: that list is reused for the
  // /kategori/gardssalg/produsent/<slug> loop further down, which skips any
  // row with a null slug — fetching before backfill would silently drop every
  // producer profile URL from the sitemap.
  try { backfillProviderSlugs(); } catch { /* DB not yet open */ }
  // Gårdssalg provider list — fetched once (when the vertical is visible) and
  // reused below for BOTH the /kategori/gardssalg aggregate lastmod AND the
  // per-producer profile lastmod loop further down, instead of querying twice.
  // GSC 2026-07-19 indekseringsfiks, sitemap lastmod-honesty item: real
  // per-row/per-aggregate updated_at instead of a blanket "today" stamped on
  // every request (rfb PR #302 fixed the same pattern for city pages).
  let gardssalgProvidersForSitemap: GardssalgProviderRow[] | null = null;
  if (gardssalgVisible()) {
    try { gardssalgProvidersForSitemap = listGardssalgProviders(5000, 0); } catch { gardssalgProvidersForSitemap = null; }
  }
  try {
    for (const row of listPublishedCategories()) {
      if (!row.category) continue;
      const lastmod = (row.lastmod || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/kategori/${encodeURIComponent(row.category)}</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${lastmod}</lastmod></url>`;
    }
    // Phase 1 — gardssalg feature flag: include /kategori/gardssalg in sitemap
    // when the provider seed set meets the visibility threshold, even before the
    // category has published experiences (so Googlebot crawls the page early).
    // lastmod = MAX(updated_at) across the gårdssalg provider rows that make up
    // this category's grid (real aggregate freshness — gårdssalg producers have
    // zero `experiences` rows, so listPublishedCategories()'s MAX(e.updated_at)
    // doesn't cover them; falls back to today only if the list is unavailable).
    if (gardssalgProvidersForSitemap) {
      let gardssalgLastmod = "";
      for (const p of gardssalgProvidersForSitemap) {
        if (p.updated_at && p.updated_at > gardssalgLastmod) gardssalgLastmod = p.updated_at;
      }
      xml += `\n  <url><loc>${url}/kategori/gardssalg</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${(gardssalgLastmod || today).slice(0, 10)}</lastmod></url>`;
      // S3 (dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering):
      // one entry per canonical /kategori/gardssalg/<typeSlug> page that has
      // ≥1 matching provider — computed from the SAME already-fetched row set
      // (no extra query), so the sitemap lists exactly the type pages the
      // route serves (an empty type next()s to the 404 and is skipped here
      // for the same reason). lastmod = MAX(updated_at) over the type's OWN
      // rows (per-page freshness, same honesty rule as the aggregate above).
      // Alias slugs (301 redirects) are deliberately never listed. NULL
      // producer_type rows match no type page — base-catalog entry only.
      for (const [typeSlug, typeDef] of Object.entries(GARDSSALG_TYPE_PAGES)) {
        let typeCount = 0;
        let typeLastmod = "";
        for (const p of gardssalgProvidersForSitemap) {
          const pt = p.producer_type ? p.producer_type.toLowerCase() : "";
          if (!pt || !typeDef.producerTypes.includes(pt)) continue;
          typeCount++;
          if (p.updated_at && p.updated_at > typeLastmod) typeLastmod = p.updated_at;
        }
        if (typeCount === 0) continue;
        xml += `\n  <url><loc>${url}/kategori/gardssalg/${typeSlug}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${(typeLastmod || today).slice(0, 10)}</lastmod></url>`;
      }
    }
  } catch { /* experiences DB not open */ }
  try {
    for (const row of listPublishedFylker()) {
      if (!row.fylke) continue;
      const lastmod = (row.lastmod || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/fylke/${encodeURIComponent(row.fylke)}</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${lastmod}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    for (const row of listPublishedKommuner()) {
      if (!row.kommune) continue;
      const lastmod = (row.lastmod || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/kommune/${encodeURIComponent(row.kommune)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    // GEO query-landing pages (dev-request 2026-06-30-geo-content-structured-data):
    // one <url> per (category, kommune) combo that clears the SAME
    // >=2-real-facts quality gate the /kategori/:category/:kommune route
    // itself requires just to 200 (see that route's comment) -- so a URL
    // only ever lands here if the route would actually serve it, never a
    // thin/empty combinatorial cell. listProduktByCombos() already returns
    // only combos with >=1 published experience (one GROUP BY query, not a
    // full category × kommune cross-product), so this gate check is a cheap
    // in-memory filter over that one result set, not a query per candidate.
    for (const row of listProduktByCombos()) {
      if (!row.category || !row.kommune) continue;
      const factCount = (row.total > 0 ? 1 : 0) + (row.providerCount > 0 ? 1 : 0) + (row.minPriceFrom !== null ? 1 : 0);
      if (factCount < 2) continue;
      const lastmod = (row.lastmod || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/kategori/${encodeURIComponent(row.category)}/${encodeURIComponent(row.kommune)}</loc><changefreq>weekly</changefreq><priority>0.5</priority><lastmod>${lastmod}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    // Slug backfill already ran near the top of this handler (before the
    // gårdssalg provider fetch, which needs it too) — not repeated here.
    for (const row of listPublishedProviders()) {
      if (!row.id) continue;
      const tilbyderSeg = row.slug ? encodeURIComponent(row.slug) : encodeURIComponent(row.id);
      const lastmod = (row.lastmod || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/tilbyder/${tilbyderSeg}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    for (const row of listPublishedExperienceSlugs()) {
      if (!row.slug) continue;
      const lastmod = (row.updated_at || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/opplevelse/${encodeURIComponent(row.slug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>`;
    }
  } catch { /* experiences DB not open — static sitemap only */ }
  try {
    // Gårdssalg producer profiles (dev-request 2026-07-19-gardssalg-agent-flater,
    // item 6/AC8): /kategori/gardssalg/produsent/<slug> was entirely absent from
    // the sitemap even though the route has been live since 2026-07-10 — producers
    // have zero `experiences` rows so listPublishedProviders()'s experiences-JOIN
    // never matches them. Gated on the SAME gardssalgVisible() flag that already
    // gates the /kategori/gardssalg entry above, so the profile family appears/
    // disappears from the sitemap in lockstep with the category page itself.
    // listGardssalgProviders() already excludes catalog_hidden=1 rows via its own
    // base WHERE (the same gate discover_gardssalg/the category grid rely on) —
    // not reimplemented here. Slug backfill already ran above (backfillProviderSlugs()
    // covers all experience_providers rows, not just experience-linked ones).
    // lastmod = the provider row's own updated_at (real per-entity freshness,
    // same "row.updated_at || today" pattern the /opplevelse/<slug> loop above
    // uses) — reuses the SAME list already fetched above, no second query.
    if (gardssalgProvidersForSitemap) {
      for (const row of gardssalgProvidersForSitemap) {
        if (!row.slug) continue;
        const lastmod = (row.updated_at || today).slice(0, 10);
        xml += `\n  <url><loc>${url}/kategori/gardssalg/produsent/${encodeURIComponent(row.slug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>`;
      }
    }
  } catch { /* experiences DB not open */ }
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

## ChatGPT Custom GPT

ChatGPT Custom GPT — Opplevagent: https://chatgpt.com/g/g-6a3ab590a7f081919c528a15c6765a7d-opplevagent-finn-opplevelser-i-norge

## MCP (Model Context Protocol) — Streamable HTTP

MCP-endepunkt (Streamable HTTP):  ${url}/mcp
MCP Server Card:                  ${url}/.well-known/mcp/server-card.json
Koble til: lim inn https://opplevagent.no/mcp i Claude Desktop / ChatGPT som MCP-URL.

Tilgjengelige MCP-verktøy:
- discover_experiences         — finn opplevelser etter fylke, kategori, vær, sesong, pris, nær-meg (lat/lng/radius_km) m.m.
- list_experience_categories   — hent alle kategorier med antall verifiserte opplevelser
- get_experience               — hent fullstendig detalj for én opplevelse via UUID

MCP Streamable HTTP krever et initialize-håndtrykk før tools/call — et bart
tools/call uten forutgående initialize svarer med JSON-RPC-feil -32000
("Server not initialized"). Steg 1 svarer med en mcp-session-id-header som
MÅ sendes med i steg 2 (og alle senere kall i samme sesjon).

Eksempel (steg 1: initialize — fang opp mcp-session-id fra svar-headerne):
  SESSION_ID=$(curl -s -D - -o /dev/null -X POST ${url}/mcp \\
    -H "Content-Type: application/json" \\
    -H "Accept: application/json, text/event-stream" \\
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"eksempel-klient","version":"1.0.0"}},"id":"1"}' \\
    | grep -i '^mcp-session-id:' | tr -d '\\r' | cut -d' ' -f2)

Eksempel (steg 2: tools/call — discover, med mcp-session-id fra steg 1):
  curl -X POST ${url}/mcp \\
    -H "Content-Type: application/json" \\
    -H "Accept: application/json, text/event-stream" \\
    -H "mcp-session-id: $SESSION_ID" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"discover_experiences","arguments":{"fylke":"Oslo","weather":"rain","limit":5}},"id":"2"}'

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
- lat            breddegrad for "nær meg"-søk (desimalgrader). Må oppgis sammen med lng.
- lng            lengdegrad for "nær meg"-søk (desimalgrader). Må oppgis sammen med lat.
- radius_km      maks avstand fra lat/lng i kilometer (gjelder kun sammen med lat/lng)
- sort           "distance" — sorter stigende etter avstand fra lat/lng (allerede standard når lat/lng er oppgitt)
- limit          maks antall resultater (standard 20, maks 100)

Respons: JSON med { vertical:"experiences", query, count, results[] }.

Når lat/lng er oppgitt, får hver rad et distance_km-felt (avrundet til én
desimal) og et geo_precision-felt: "address" betyr posisjonen er hentet fra
tilbyderens nøyaktige gateadresse (presis), "kommune" betyr et kommune-
senterpunkt (omtrentlig — presenter aldri denne avstanden som eksakt). Rader
uten geokodet posisjon i det hele tatt utelates fra svaret istedenfor å få en
oppdiktet avstand.

Eksempel:
  GET ${url}/api/opplevelser/discover?fylke=Oslo&weather=rain&group_size=4

Eksempel (nær meg — innen 50 km fra Tromsø):
  GET ${url}/api/opplevelser/discover?lat=69.65&lng=18.95&radius_km=50

## Flere REST-endepunkt

GET ${url}/api/opplevelser/categories   — alle kategorier med antall
GET ${url}/api/opplevelser/{id}         — én opplevelse via id

## Gårdssalg & smaking (produsenter)

Gårdssalg-produsenter (gårdsbutikk, sideri, bryggeri, vingård m.fl., med ærlig
bookingstatus) er en egen vertikal i samme katalog — IKKE en del av
\`experiences\`-tabellen. Søkbar via MCP, A2A (naturlig språk) og REST.

MCP-verktøy: discover_gardssalg — samme to-stegs håndtrykk som MCP-seksjonen over.

Eksempel (steg 1: initialize — fang opp mcp-session-id fra svar-headerne):
  SESSION_ID=$(curl -s -D - -o /dev/null -X POST ${url}/mcp \\
    -H "Content-Type: application/json" \\
    -H "Accept: application/json, text/event-stream" \\
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"eksempel-klient","version":"1.0.0"}},"id":"1"}' \\
    | grep -i '^mcp-session-id:' | tr -d '\\r' | cut -d' ' -f2)

Eksempel (steg 2: tools/call — discover_gardssalg, med mcp-session-id fra steg 1):
  curl -X POST ${url}/mcp \\
    -H "Content-Type: application/json" \\
    -H "Accept: application/json, text/event-stream" \\
    -H "mcp-session-id: $SESSION_ID" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"discover_gardssalg","arguments":{"fylke":"Vestland","limit":5}},"id":"2"}'

REST (samme søkeflate, uten MCP-håndtrykk):
  GET ${url}/api/opplevelser/discover?category=gardssalg_smaking&fylke=Vestland

Gårdssalg-spesifikke filtre (i tillegg til fylke/kommune/lat/lng/radius_km fra
Discovery-API-seksjonen over): producer_type, booking_live=true (kun literalen
"true" filtrerer — utelatt betyr «ingen filter på denne kolonnen»).

Respons: JSON med { vertical:"gardssalg", query, count, results[] }, der hver
rad har navn/fylke/kommune/producer_type/lat/lon/geocode_confidence/profile_url
og et \`booking\`-felt ({live, mode, note}) som ærlig speiler dark-launch-status
— aldri en påstått aktiv booking før reservasjoner faktisk er åpnet.

### Booking via MCP (book_gardssalg)

MCP-verktøy: book_gardssalg — send inn en reservasjonsforespørsel for en
gårdssalg-produsent (provider_id fra discover_gardssalg), samme to-stegs
håndtrykk som over. Krever provider_id, slot_at, party_size, guest_name,
guest_email (guest_phone og notes valgfritt).

VIKTIG: verktøyet oppretter ALDRI en bekreftet booking — kun samme avventende
("reserved"/pending) rad som nettskjemaet på produsentens profilside
produserer, via nøyaktig samme valideringskjede, database-tabell og
bekreftelses-e-post-flyt. Produsenten mottar forespørselen og svarer på
e-post (bekrefter, foreslår nytt tidspunkt eller avslår) — reservasjonen
blir IKKE endelig før produsenten har svart, og ingen AI-agent kan bekrefte
en booking på gjestens eller produsentens vegne. En produsent uten aktiv
bookingstatus (se discover_gardssalgs \`booking.live\`) avvises med en
tydelig melding, aldri en stille feil. Ingen betaling — pickup/oppmøte, som
i dag.

## Lisens

Provider-data verifiseres mot Brønnøysundregistrene (CC0). Innhold gjengis
som faktaoppsummering med kildehenvisning.

## Frivillig API-nøkkel (forbruker-identitet)

Helt valgfritt — alle søk-/lese-endepunktene over er allerede åpne uten nøkkel, og dette er
IKKE en pålogging eller et krav for å bruke tjenesten.

- Hent en gratis nøkkel: \`POST ${url}/api/keys\` med valgfri JSON-body
  \`{ "label": "min-agent", "contact_email": "..." }\` (begge felt valgfrie). Svaret inneholder
  \`key\` — vis den KUN denne ene gangen, den kan ikke hentes igjen.
- Bruk den: send nøkkelen som \`X-API-Key\`-header på ethvert MCP-/A2A-/REST-kall.
- Fordel: ca. 3x høyere rate-grense (200→600 på \`/a2a\` og \`/mcp\`, 300→900 på
  \`/api/opplevelser/discover\` og andre REST-kall), pluss at kallene dine telles i en aggregert
  forbrukslogg (kun endepunkt/verktøynavn og dato — aldri innhold eller argumenter).
- Tilbakekall/slett: \`POST ${url}/api/keys/revoke\` (stanser nøkkelen, historikk beholdes)
  eller \`POST ${url}/api/keys/erase\` (GDPR-sletting av label/e-post). Begge tar
  \`{ "key": "..." }\` i body, eller nøkkelen som \`X-API-Key\`-header.

Eksempel (cURL):
  curl -X POST ${url}/api/keys \\
    -H "Content-Type: application/json" \\
    -d '{"label":"my-agent"}'

Voluntary — every search/read endpoint above already works with no key, and this is NOT a
login or a requirement to use the service. Get a free key via \`POST /api/keys\`
(optional \`label\`/\`contact_email\`), send it back as the \`X-API-Key\` header on any call for a
higher rate-limit tier, and revoke/erase it any time via \`POST /api/keys/revoke\` or
\`POST /api/keys/erase\`.

## Datakvalitet og verifisering

${url}/proveniens

Hver tilbyder kontrolleres mot Brønnøysundregistrene for å bekrefte at det står et aktivt,
registrert selskap bak opplevelsen — tilbydere som består sjekken får et «✓ Brreg-verifisert»-
merke. Detaljer som beskrivelse og varighet berikes fra tilbyderens egen nettside, med
kildehenvisning. Opplevelser fra en tilbyder som ennå ikke er bekreftet mot Brønnøysundregistrene
publiseres ikke på nettstedet — de blir synlige først når tilbyderen er bekreftet som et aktivt,
registrert selskap. Se ${url}/proveniens for hele forklaringen.

Every provider is checked against Brønnøysundregistrene to confirm there is an active,
registered company behind the experience — providers that pass get a "✓ Brreg-verified" badge.
Details such as description and duration are enriched from the provider's own website, with
source attribution. Experiences from a provider not yet confirmed against Brønnøysundregistrene
are not published on the site — they only become visible once the provider is confirmed as an
active, registered company. See ${url}/proveniens for the full explanation.
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
MCP-endpoint: ${url}/mcp
MCP-server-card: ${url}/.well-known/mcp/server-card.json
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
// GET /.well-known/openai-apps-challenge — OpenAI Apps Directory
//
// WHY: OpenAI's Apps Directory submission requires a static-string
// domain-verification endpoint at this exact path — token bytes as
// the literal response body (no JSON wrapper, no whitespace). Same
// pattern as rettfrabonden.com (discovery.ts, PR-99). Without this
// route the trailing router.use() catch-all below answers the path
// with the SPA-fallback HTML and a 404, and OpenAI's domain
// verification for the Opplevagent app fails (measured 2026-08-24).
// ═══════════════════════════════════════════════════════════════

// Issued by the OpenAI Apps form at the Opplevagent app's MCP/domain-
// verification step (2026-08-25).
const OPENAI_APPS_CHALLENGE_TOKEN = "4jYu5lciublhwHxBSXCP9bmTyrke4k1f4xioIEsH5Ng";

router.get("/.well-known/openai-apps-challenge", (_req: Request, res: Response) => {
  res.header("Content-Type", "text/plain");
  res.header("Cache-Control", "public, max-age=300");
  res.header("X-Content-Type-Options", "nosniff");
  res.send(OPENAI_APPS_CHALLENGE_TOKEN);
});

// ═══════════════════════════════════════════════════════════
// GET /.well-known/agent-card.json — A2A Agent Card (Opplevagent)
// ═══════════════════════════════════════════════════════════

router.get("/.well-known/agent-card.json", agentCardUsageLogger("experiences"), (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getExperiencesAgentCard());
});

// GET /.well-known/jwks.json — JWKS for verifying A2A agent-card signatures
// (dev-request 2026-07-13-a2a-card-v1-signing slice 2). Same key across all
// three verticals (one Fly app serves all of them).
router.get("/.well-known/jwks.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getJWKS());
});

// GET /agent-card.json — alias (some crawlers skip the well-known prefix)
router.get("/agent-card.json", agentCardUsageLogger("experiences"), (_req: Request, res: Response) => {
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
// MCP Server Card (SEP-1649) — dev-request 2026-07-13-mcp-2026-spec-server-card
// ═══════════════════════════════════════════════════════════
// Mirrors agent-readiness.ts's mcpServerCard() shape/field-names for
// rettfrabonden.com, but with opplevagent.no's own branding, endpoint, and
// MCP tools (see experiences-mcp.ts's registerExperienceTools).
function experiencesMcpServerCard() {
  const url = baseUrl();
  let total = 0;
  try { total = countPublishedExperiences(); } catch { /* experiences db may not be ready */ }
  const totalLabel = total > 0 ? total.toLocaleString("nb") : "hundreds of";

  return {
    // $schema deliberately omitted: the URL previously advertised here
    // (modelcontextprotocol.io/schemas/2025-11/server-card.schema.json) returns
    // 404, as does every other candidate probed on 2026-07-29 — SEP-1649 has no
    // published schema document yet. A $schema pointing at a 404 is worse than
    // none: a validating agent either errors or silently skips validation, and
    // both look like "we validated" from the outside. schemaVersion still names
    // the SEP revision this shape follows.
    schemaVersion: "2025-11",
    // Which protocol era this endpoint actually speaks — derived from the SDK,
    // never written down. See services/mcp-protocol-version.ts.
    ...mcpProtocolDeclaration(),
    name: "opplevagent",
    title: "Opplevagent — Norwegian experiences marketplace",
    version: "0.1.0",
    description:
      `Discover ${totalLabel} curated, Brreg-verified Norwegian experiences and activities. ` +
      "Filter by county (fylke), municipality, category, weather suitability, season, indoor/outdoor, " +
      "group size, age, price, and duration — including near-me search by coordinates. Supports " +
      "natural-language queries in Norwegian and English.",
    homepage: url,
    repository: {
      type: "git",
      url: "https://github.com/slookisen/lokal",
    },
    documentation: `${url}/llms.txt`,
    icon: `${url}/favicon.svg`,
    vendor: {
      name: "Opplevagent",
      url,
    },
    license: "MIT",
    endpoints: [
      {
        protocol: "https+mcp",
        url: `${url}/mcp`,
        description: "Remote MCP HTTP transport (Streamable HTTP). Compatible with ChatGPT connectors and remote Claude.",
      },
    ],
    transports: ["http", "streamable-http"],
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    },
    tools: [
      { name: "discover_experiences", description: "Search Norwegian experiences by county, municipality, category, weather, season, indoor/outdoor, group size, age, price, duration, and near-me (lat/lng/radius)." },
      { name: "list_experience_categories", description: "List all experience categories with the count of verified experiences in each." },
      { name: "get_experience", description: "Fetch full details for a single experience by its UUID." },
    ],
    authentication: {
      schemes: ["none"],
      description: "All MCP tools are read-only and require no authentication.",
    },
    keywords: [
      "opplevelser",
      "experiences",
      "activities",
      "aktiviteter",
      "reise",
      "travel",
      "norway",
      "norge",
      "friluft",
    ],
    contact: {
      url: `${url}/kontakt`,
    },
    "x-opplevagent": {
      region: "Norway",
      totalExperiences: total,
      languages: ["no", "en"],
    },
  };
}

router.get("/.well-known/mcp/server-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(experiencesMcpServerCard());
});

// Legacy / alternate paths (parity with agent-readiness.ts's rfb aliases)
router.get("/.well-known/mcp.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(experiencesMcpServerCard());
});

router.get("/.well-known/mcp-server.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(experiencesMcpServerCard());
});

router.get("/.well-known/mcp/server-cards.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  // Array wrapper form — some aggregators expect an array of cards.
  res.json([experiencesMcpServerCard()]);
});

// ═══════════════════════════════════════════════════════════
// GET /opplevelse/:slug — server-rendered, DB-driven experience detail
// (opplevagent-site-quality loop, work-order 2026-06-20 increment #2).
// DB-template-driven: every published experience automatically gets this
// page + a sitemap entry — no manual step (the "auto-weave" requirement).
// Only publishable rows (verified + confidence>=medium + provider
// brreg_active) render; anything else falls through to the 404 catch-all.
// ═══════════════════════════════════════════════════════════
const SEASON_LABELS: Record<string, string> = {
  summer: "Sommer", winter: "Vinter", spring: "Vår",
  autumn: "Høst", fall: "Høst", year_round: "Hele året",
};
function seasonLabel(s: string): string {
  return SEASON_LABELS[s] || s;
}
function ioLabel(io: string | null | undefined): string {
  return io === "indoor" ? "Innendørs" : io === "outdoor" ? "Utendørs" : io === "both" ? "Inne og ute" : "";
}
const PRICE_BAND_LABELS: Record<string, string> = {
  gratis: "Gratis", rimelig: "Rimelig", standard: "Standard",
  premium: "Premium", ukjent: "Pris ikke oppgitt",
};

// dev-request 2026-07-04-opplevagent-taksonomi-filtre: Norwegian display
// labels for the derived cross-cutting filter tags (experience-tags.ts).
// Order matches EXPERIENCE_TAGS — drives both card badges and the /sok
// filter-chip UI so the two stay in sync by construction.
const FILTER_TAG_LABELS: Record<ExperienceTag, string> = {
  familievennlig: "Familievennlig",
  gratis: "Gratis",
  "under-300": "Under 300 kr",
  tilgjengelig: "Tilgjengelig (UU)",
  værsikker: "Værsikker",
  sesong: "Sesongbasert",
};
// Only accept http(s) URLs from data — never render javascript:/data: URIs.
function safeHttpUrl(u: unknown): string | null {
  const s = String(u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : null;
}
function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, ""); } catch { return "kilde"; }
}
// Null-aware numeric coercion — Number(null)===0, so a naive Number()+isFinite
// guard would turn missing coordinates into 0,0 (Gulf of Guinea). This keeps
// genuine finite numbers (incl. 0) and maps null/undefined/"" → null so the
// no-geo map fallback actually triggers (most rows have null loc_lat/lon).
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Hero media: render a real photo if the row carries one (future enrichment),
// otherwise a branded, category-themed SVG placeholder. The typed Experience
// schema has no image column today, so we read image_url/image/hero_image
// defensively — when enrichment adds one, this lights up with no code change.
function renderHeroMedia(exp: Record<string, unknown>, cat: string | null, place: string): string {
  const img = safeHttpUrl(exp.image_url ?? exp.image ?? exp.hero_image);
  if (img) {
    const alt = `${String(exp.title ?? "Opplevelse")}${place ? " – " + place : ""}`;
    return `<figure class="hero-media"><img src="${escapeHtml(img)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" width="1080" height="540"></figure>`;
  }
  // No photo (no row has one — the table has no image column): draw the
  // category's own cover instead of the old dotted-box-with-an-icon. See
  // categoryCoverSvg()'s doc comment for why generated art, not a stock photo.
  // Seeded on the slug so this experience always gets the same picture.
  const seed = String(exp.slug ?? exp.id ?? exp.title ?? "opplevelse");
  const c = categoryColor(cat);
  const label = catLabel(cat);
  return `<figure class="hero-media hero-cover" role="img" aria-label="${escapeHtml(label)} — illustrasjon">
      ${categoryCoverSvg(cat, seed)}
      <figcaption class="cover-chip" style="background:${c}"><span class="cover-chip-ico" aria-hidden="true">${catIconSvg(cat, 18)}</span>${escapeHtml(label)}</figcaption>
    </figure>`;
}

// SEO <title> budget (dev-request 2026-07-12-opplevagent-serp-innholdsberikelse,
// item 2): brand suffix + hard cap, and the truncator used to fit `main` (the
// page-specific title text) inside it. Pulled to module scope (like
// buildSortToggleUrl above) so it's a plain, directly-testable pure function
// rather than a closure buried inside renderOpplevelseDetail — it doesn't
// depend on anything from that function's scope.
const BRAND = " | Opplevagent";
const MAX_TITLE = 70;
// Truncates `main` so `main + BRAND` never exceeds MAX_TITLE chars, WITHOUT
// ever appending an ellipsis ("…") inside the <title> tag — Google was
// rendering the previous ellipsis-truncated title verbatim in SERPs, which
// reads as a broken/cut-off title. Prefers cutting at the last whitespace
// boundary inside the truncated slice so words aren't split mid-word, but
// only if that boundary keeps at least 60% of the available budget (i.e.
// doesn't throw away an unreasonably large chunk of `main` just to avoid a
// word-split); otherwise (or if there's no whitespace at all) it hard-cuts at
// the budget. Either way, any trailing whitespace or dangling punctuation
// (dash/en-dash/em-dash, comma, period, ampersand, slash) left by the cut is
// trimmed so the result never looks broken.
export function seoPageTitle(main: string): string {
  if (main.length + BRAND.length <= MAX_TITLE) return main + BRAND;
  const budget = MAX_TITLE - BRAND.length;
  let truncated = main.slice(0, budget);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace >= Math.floor(budget * 0.6)) {
    truncated = truncated.slice(0, lastSpace);
  }
  truncated = truncated.trimEnd().replace(/[\s\-–—,.&/]+$/, "").trimEnd();
  return truncated + BRAND;
}

function renderOpplevelseDetail(
  exp: ReturnType<typeof getPublishedExperienceBySlug>,
  provider: Record<string, unknown> | null,
  related: RelatedExperienceRow[],
  url: string,
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 2:
  // req.lang — only the visible <h1> uses it (title_no || title fallback on
  // /no, original title always on /en). Breadcrumb/JSON-LD/OG-meta/<title>
  // tag are deliberately NOT touched this slice — still the original title.
  lang: Lang
): string {
  if (!exp) return "";
  const slug = exp.slug || "";
  // dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent:
  //   uiLang — chrome/labels language; follows req.lang ONLY while
  //            OPPLEVAGENT_LANG_SWITCHER_ENABLED (flag off → "no", i.e. the
  //            page's pre-existing Norwegian labels, byte-identical).
  //   tr     — PUBLISHED, reviewed+verified translations of title/description/
  //            meeting_point for this row; {} unless
  //            PROFILE_TRANSLATIONS_SERVE_ENABLED === "true".
  const switcherOn = isOpplevagentLangSwitcherEnabled();
  const uiLang: Lang = switcherOn ? lang : "no";
  const L = oaProfileLabels(uiLang);
  const noPath = `/opplevelse/${encodeURIComponent(slug)}`;
  const tr = lang !== "no"
    ? getPublishedProfileTranslations(getExpDbForReise("experiences"), "opplevagent", "experience", String(exp.id), lang)
    : {};
  const canonical = `${url}${switcherOn ? localizedPath(noPath, lang) : noPath}`;
  const cat = exp.category || null;
  const place = [exp.kommune, exp.fylke].filter(Boolean).join(", ");
  const provName = provider ? String(provider.navn || "") : "";
  const provSite = provider ? safeHttpUrl(provider.hjemmeside) : null;
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 3
  // (detail completeness weave): surface provider phone the same way
  // booking_url/hjemmeside already are — conditional, no fabrication.
  const provTelRaw = provider ? String(provider.telefon ?? "").trim() : "";
  const provTel = provTelRaw || null;
  const brregVerified = !!(provider && Number(provider.brreg_verified) === 1);
  const orgNr = provider ? String(provider.org_nr || "") : "";

  // Render-time guard: nav/boilerplate scraped text masquerading as a real
  // description must never render (dev-request 2026-07-04-rfb-datakvalitet
  // item 1, render-guard-only slice — same guard used for producer
  // descriptions in src/routes/seo.ts). Computed once, reused by both the
  // meta description and the visible lede below.
  let safeExpDescription = exp.description ? String(exp.description) : "";
  if (safeExpDescription && isJunkDescription(safeExpDescription)) {
    console.log(`[description-guard] suppressed junk description (opplevelse detail) for ${exp.id} (${exp.title})`);
    safeExpDescription = "";
  }
  // Translated body text (only when a published translation exists for the
  // exact field; the Norwegian value is the fallback, never overwritten).
  if (safeExpDescription && tr.description) safeExpDescription = tr.description;
  const displayTitle = lang === "no" ? (exp.title_no || exp.title) : (tr.title || exp.title);
  const displayMeetingPoint = exp.meeting_point ? (tr.meeting_point || exp.meeting_point) : exp.meeting_point;

  // Meta description: own summary if present, else a generated one.
  const metaDescRaw = safeExpDescription
    || `${exp.title}${place ? " i " + place : ""}. ${catLabel(cat)} på Opplevagent — håndplukkede norske opplevelser med Brreg-verifiserte tilbydere.`;
  const metaDesc = metaDescRaw.length > 155 ? metaDescRaw.slice(0, 152).trim() + "…" : metaDescRaw;

  // Badges row.
  // Daniel 2026-08-24: every category-bearing element on this page takes the
  // category's own colour (categoryColor(), the same map the icons, cards and
  // chips read) instead of one site-wide teal — so a Vinter & snø profile
  // reads as Vinter & snø at a glance, not as "some page on Opplevagent".
  const catColor = categoryColor(cat);
  const badges: string[] = [];
  if (cat) badges.push(`<a class="badge badge-cat" style="background:${catColor};border-color:${catColor}" href="/kategori/${encodeURIComponent(cat)}">${escapeHtml(catLabel(cat))}</a>`);
  if (exp.indoor_outdoor) badges.push(`<span class="badge">${escapeHtml(ioLabel(exp.indoor_outdoor))}</span>`);
  for (const s of exp.season || []) badges.push(`<span class="badge">${escapeHtml(seasonLabel(s))}</span>`);
  if (brregVerified) badges.push(`<span class="badge badge-verified" title="Tilbyder verifisert mot Brønnøysundregistrene">✓ Brreg-verifisert</span>`);

  // Facts table.
  const facts: Array<[string, string]> = [];
  if (cat) facts.push([L.fCategory, `<a href="/kategori/${encodeURIComponent(cat)}">${escapeHtml(catLabel(cat))}</a>`]);
  if (exp.fylke) facts.push([L.fFylke, `<a href="/fylke/${encodeURIComponent(exp.fylke)}">${escapeHtml(exp.fylke)}</a>`]);
  if (exp.kommune) facts.push([L.fKommune, `<a href="/kommune/${encodeURIComponent(exp.kommune)}">${escapeHtml(exp.kommune)}</a>`]);
  if (exp.indoor_outdoor) facts.push([L.fIndoor, escapeHtml(ioLabel(exp.indoor_outdoor))]);
  if ((exp.season || []).length) facts.push([L.fSeason, escapeHtml((exp.season || []).map(seasonLabel).join(", "))]);
  if (exp.duration_min || exp.duration_max) {
    const d = exp.duration_min && exp.duration_max && exp.duration_min !== exp.duration_max
      ? `${exp.duration_min}–${exp.duration_max} ${L.min}`
      : `${L.approx} ${exp.duration_min || exp.duration_max} ${L.min}`;
    facts.push([L.fDuration, escapeHtml(d)]);
  }
  if (exp.group_min || exp.group_max) {
    const g = exp.group_min && exp.group_max ? `${exp.group_min}–${exp.group_max} ${L.persons}`
      : exp.group_max ? `${L.upTo} ${exp.group_max} ${L.persons}` : `${L.from} ${exp.group_min} ${L.persons}`;
    facts.push([L.fGroup, escapeHtml(g)]);
  }
  if (exp.price_from || exp.price_band) {
    const unit = exp.price_unit === "per_person" ? L.perPerson : exp.price_unit === "per_group" ? L.perGroup : "";
    const pr = exp.price_from
      ? `${L.from} ${exp.price_from} ${L.kr}${unit}`
      : (PRICE_BAND_LABELS[String(exp.price_band)] || String(exp.price_band));
    facts.push([L.fPrice, escapeHtml(pr)]);
  }
  if ((exp.languages || []).length) facts.push([L.fLanguages, escapeHtml((exp.languages || []).join(", "))]);
  if ((exp.accessibility || []).length) facts.push([L.fAccess, escapeHtml((exp.accessibility || []).join(", "))]);
  if (displayMeetingPoint) facts.push([L.fMeeting, escapeHtml(displayMeetingPoint)]);
  const factsRows = facts.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${v}</td></tr>`).join("");

  // Hero media — real photo when the row has one (enrichment-gated), else a
  // branded category placeholder. exp is typed without an image column today.
  const heroMedia = renderHeroMedia(exp as unknown as Record<string, unknown>, cat, place);

  // Description block (graceful fallback when no own summary yet, or when
  // the guard above suppressed a junk value).
  const descBlock = safeExpDescription
    ? `<p class="lede">${escapeHtml(safeExpDescription)}</p>`
    : `<p class="lede lede-soft">Detaljert beskrivelse publiseres fortløpende. ${escapeHtml(exp.title)} er en ${escapeHtml(catLabel(cat).toLowerCase())}-opplevelse${place ? " i " + escapeHtml(place) : ""}. Se tilbyderens nettside for program, priser og bestilling.</p>`;

  // Booking CTA.
  const bookingUrl = safeHttpUrl(exp.booking_url);
  let cta = "";
  if (bookingUrl) {
    cta = `<a class="cta" href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener nofollow">${L.ctaBook}</a>`;
  } else if (provSite) {
    cta = `<a class="cta" href="${escapeHtml(provSite)}" target="_blank" rel="noopener nofollow">${L.ctaSite}</a>`;
  } else {
    cta = `<p class="cta-soft">${L.ctaSoft}</p>`;
  }
  // Phone — rendered only when the provider has one on file (no fabrication).
  const phoneBlock = provTel
    ? `<p class="prov-phone">${L.phone}: <a href="tel:${escapeHtml(provTel.replace(/\s+/g, ""))}">${escapeHtml(provTel)}</a></p>`
    : "";

  // Provider card.
  const provInner = provName
    ? `<p class="prov-name">${provSite ? `<a href="${escapeHtml(provSite)}" target="_blank" rel="noopener">${escapeHtml(provName)}</a>` : escapeHtml(provName)}</p>
       ${brregVerified ? `<p class="prov-verified">${L.provVerified}${orgNr ? ` · org.nr ${escapeHtml(orgNr)}` : ""}</p>` : `<p class="prov-soft">${L.provPending}</p>`}
       <p class="prov-link"><a href="/tilbyder/${escapeHtml(String(provider!.slug || provider!.id))}">${L.provAll}</a></p>`
    : `<p class="prov-soft">${L.provUnmatched}</p>`;

  // Map block — coords from experience, else provider; graceful no-geo fallback.
  // arbeidspunkt 5: when a real point exists, render a real Leaflet mini-map
  // (renderMiniMapSection, defined near the /kategori/gardssalg map section
  // below) instead of just the OSM link; the link itself is preserved
  // byte-for-byte as the <noscript> fallback so JS-disabled visitors lose
  // nothing (acceptance criterion 4). The no-geo branch below is completely
  // untouched (acceptance criterion 5).
  const expLat = numOrNull(exp.loc_lat);
  const expLon = numOrNull(exp.loc_lon);
  const lat = expLat ?? numOrNull(provider ? provider.lat : null);
  const lon = expLon ?? numOrNull(provider ? provider.lon : null);
  // Precision honesty: when the point is the experience's own geocode,
  // geo_precision already says address/kommune. When it's a provider
  // lat/lon fallback (experience has no own geocode yet), reuse the SAME
  // isApproxGardssalgConfidence() discipline the gardssalg map / produsent-
  // profil page use for provider-sourced points (defined below) — never
  // assume a fallback point is exact just because it lacks its own
  // geo_precision tag.
  const geoIsApprox = expLat !== null
    ? exp.geo_precision === "kommune"
    : isApproxGardssalgConfidence(provider ? ((provider.geocode_confidence as string | null) ?? null) : null);
  const osmLinkHtml = `<a class="map-card" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}" target="_blank" rel="noopener" aria-label="Åpne posisjon i OpenStreetMap">
         <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>
         <span><strong>${escapeHtml(place || "Posisjon")}</strong><span class="map-sub">Åpne i kart (OpenStreetMap)</span></span>
       </a>`;
  // Daniel 2026-08-24, punkt 5: a stored coordinate that cannot be a
  // Norwegian position (0/0 from a failed geocode, a swapped pair) is treated
  // as "no position" here, exactly as the map queries treat it as "no marker"
  // — otherwise this card opens a mini-map of the open Atlantic and asserts it
  // is where the experience is. Same gate, same honesty rule as the
  // approximate-precision labelling above.
  const mapBlock = (lat !== null && lon !== null && isPlausibleNorwayCoord(lat, lon))
    ? renderMiniMapSection({ lat, lon, approx: geoIsApprox, label: place || "Posisjon" }, osmLinkHtml)
    : `<div class="map-card map-fallback">
         <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>
         <span><strong>${escapeHtml(place || "Sted ikke oppgitt")}</strong><span class="map-sub">Nøyaktig posisjon er ikke registrert ennå.</span></span>
       </div>`;

  // Evidence / source.
  const evUrl = safeHttpUrl(exp.evidence_url);
  const evBlock = evUrl
    ? `<p class="evidence">Kilde: <a href="${escapeHtml(evUrl)}" target="_blank" rel="noopener nofollow">${escapeHtml(hostOf(evUrl))}</a></p>`
    : "";

  // Related grid (these links resolve — they are other detail pages).
  const relCards = related
    .map((r) => `<a class="rel-card" style="border-left-color:${categoryColor(r.category ?? cat)}" href="/opplevelse/${encodeURIComponent(r.slug)}">
        <span class="rel-title">${escapeHtml(r.title)}</span>
        <span class="rel-meta">${escapeHtml([r.kommune, r.fylke].filter(Boolean).join(", "))}</span>
      </a>`)
    .join("");
  const relBlock = relCards
    ? `<section class="related" aria-labelledby="rel-h"><h2 id="rel-h">Flere ${escapeHtml(catLabel(cat).toLowerCase())}-opplevelser</h2><div class="rel-grid">${relCards}</div></section>`
    : "";

  // JSON-LD: TouristAttraction + BreadcrumbList.
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "TouristAttraction",
    name: exp.title,
    description: metaDesc,
    url: canonical,
    touristType: catLabel(cat),
    address: { "@type": "PostalAddress", addressLocality: exp.kommune || undefined, addressRegion: exp.fylke || undefined, addressCountry: "NO" },
  };
  // Structured data must never publish a coordinate we would refuse to draw.
  // Daniel 2026-08-25: the map gate shipped a day earlier stopped at the
  // rendering layer, so two rows at lat 0 / lon 0 were still being handed to
  // Google as `"geo": {"latitude": 0, "longitude": 0}` — a confident claim
  // that a Norwegian brewery sits in the Gulf of Guinea. Omitting the node
  // entirely is valid schema.org and says nothing rather than something false.
  if (lat !== null && lon !== null && isPlausibleNorwayCoord(lat, lon)) ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lon };
  // Offer — only when there is a concrete starting price. Price bands alone are
  // too coarse for a valid schema.org Offer (no numeric price), so band-only
  // rows are intentionally left without an Offer node.
  if (exp.price_from) {
    const offer: Record<string, unknown> = {
      "@type": "Offer",
      price: exp.price_from,
      priceCurrency: "NOK",
      availability: "https://schema.org/InStock",
    };
    if (bookingUrl || provSite) offer.url = bookingUrl || provSite;
    ld.offers = offer;
  }
  if (provName) ld.provider = { "@type": "Organization", name: provName, ...(provSite ? { url: provSite } : {}) };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Forsiden", item: url },
      ...(cat ? [{ "@type": "ListItem", position: 2, name: catLabel(cat), item: `${url}/kategori/${encodeURIComponent(cat)}` }] : []),
      { "@type": "ListItem", position: cat ? 3 : 2, name: exp.title, item: canonical },
    ],
  };
  const ldScripts = [ld, breadcrumb]
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/<\//g, "<\\/")}</script>`)
    .join("\n");

  // Build SEO title ≤70 chars: cascade full (with place) → without place → truncated
  // (BRAND/MAX_TITLE/seoPageTitle are module-scope, defined above this function.)
  const titleWithPlace = `${displayTitle}${place ? " – " + place : ""}`;
  const title = seoPageTitle(
    titleWithPlace.length + BRAND.length <= MAX_TITLE ? titleWithPlace : displayTitle
  );

  // Per-page branded og:image (dev-request
  // 2026-07-12-opplevagent-serp-innholdsberikelse, item 3) — experience
  // title as the main label, category as sublabel/accent, replacing the
  // domain-wide favicon.svg fallback. No extra DB query: cat/exp.title are
  // already in scope.
  const ogImage = ogImageUrl(url, exp.title, { sublabel: cat ? catLabel(cat) : null, cat });
  const ogImageAlt = `${exp.title}${cat ? " — " + catLabel(cat) : ""} | Opplevagent`;

  return `<!doctype html>
<html lang="${htmlLangAttr(uiLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#0e3c36">
<link rel="canonical" href="${canonical}">${switcherOn ? "\n" + oaHreflangLinks(url, noPath) : ""}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags({ includeThemeColor: false })}
<meta property="og:title" content="${escapeHtml(switcherOn ? displayTitle : exp.title)}">
<meta property="og:description" content="${escapeHtml(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="${ogLocale(uiLang)}">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
<meta name="twitter:card" content="summary">
${ldScripts}
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --fjord-900:#0b2e29;--fjord-800:#0e3c36;--fjord-700:#0f5a50;--fjord-600:#0c7264;
    --font-brand:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--olive:#6f7a4f;--gold:#c98a2b;
    --teal-500:#12a594;--amber-500:#ff5d3b;--coral-500:#ff5d3b;
    --ink:#18130d;--ink-soft:#544a3e;--mist:#7a7163;
    --surface:#fff;--canvas:#f7f4ee;--canvas-2:#efe9dd;--line:#e4ded0;
    --r-sm:8px;--r-md:14px;--r-lg:20px;--r-pill:999px;
    --sh-sm:0 1px 2px rgba(24,19,13,.06),0 2px 6px rgba(24,19,13,.05);
    --sh-md:0 6px 18px rgba(24,19,13,.10);--maxw:1080px;
  }
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--canvas);line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--fjord-600);text-decoration:none}
  a:hover{text-decoration:underline}
  :focus-visible{outline:3px solid var(--amber-500);outline-offset:2px;border-radius:4px}
  svg{display:block}
  .container{max-width:var(--maxw);margin:0 auto;padding:0 24px}
  @media(max-width:560px){.container{padding:0 16px}}
  .skip-link{position:absolute;left:-9999px;top:0;background:var(--fjord-800);color:#fff;padding:10px 16px;z-index:200}
  .skip-link:focus{left:0}
  .site-nav{position:sticky;top:0;z-index:100;background:rgba(244,248,244,.9);backdrop-filter:saturate(160%) blur(12px);border-bottom:1px solid var(--line)}
  .nav-inner{max-width:var(--maxw);margin:0 auto;padding:0 24px;height:58px;display:flex;align-items:center;justify-content:space-between}
  @media(max-width:560px){.nav-inner{padding:0 16px}}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.12rem;color:var(--fjord-800)}
  .brand:hover{text-decoration:none}
  .brand-word{font-family:var(--font-brand);font-weight:600;font-size:1.3rem;letter-spacing:-.015em;text-transform:lowercase;line-height:1;color:var(--ink)}
  .brand-word .tld{color:var(--fjord-600)}
  .brand .mark{display:flex;align-items:center;justify-content:center}
  .brand .mark svg{display:block}
  .nav-links a{font-size:.86rem;font-weight:600;color:var(--ink-soft);margin-left:22px}
  .breadcrumb{padding:18px 0 4px;font-size:.84rem;color:var(--mist)}
  .breadcrumb a{color:var(--ink-soft)}
  .breadcrumb .sep{margin:0 8px;color:var(--line)}
  .head{padding:14px 0 8px}
  .head h1{font-size:clamp(1.6rem,3.6vw,2.5rem);font-weight:800;letter-spacing:-.025em;line-height:1.12;color:var(--fjord-900)}
  .head .place{margin-top:8px;color:var(--ink-soft);font-size:1rem;display:flex;align-items:center;gap:7px}
  .badges{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.8rem;font-weight:600;border:1px solid var(--line)}
  /* Colour comes from an inline style (the row's own category); this rule
     only carries the shape + the white text the palette guarantees ≥4.5:1 on. */
  a.badge-cat{background:var(--fjord-800);color:#fff;border-color:var(--fjord-800)}
  a.badge-cat:hover{text-decoration:none;filter:brightness(1.08)}
  .badge-verified{background:#e7f6ec;color:#0f7a3d;border-color:#bfe6cd}
  .layout{display:grid;grid-template-columns:1fr 340px;gap:32px;margin:26px 0 10px;align-items:start}
  @media(max-width:860px){.layout{grid-template-columns:1fr;gap:22px}}
  .lede{font-size:1.08rem;color:var(--ink);margin-bottom:22px}
  .lede-soft{color:var(--ink-soft)}
  .hero-media{margin:0 0 24px;border-radius:var(--r-lg);overflow:hidden;border:1px solid var(--line);box-shadow:var(--sh-sm)}
  .hero-media img{display:block;width:100%;height:auto;aspect-ratio:2/1;object-fit:cover}
  /* Daniel 2026-08-24: the old .hero-placeholder (dotted beige box + centred
     icon) is replaced by a drawn category cover — see categoryCoverSvg().
     Shorter than the old 2:1 too: the art earns its space, but the facts
     below it are what the visitor came for. */
  .hero-cover{position:relative;aspect-ratio:20/9;background:var(--canvas-2)}
  .hero-cover .cover-art{position:absolute;inset:0;width:100%;height:100%}
  .cover-chip{position:absolute;left:16px;bottom:14px;display:inline-flex;align-items:center;gap:8px;padding:7px 15px 7px 12px;border-radius:var(--r-pill);color:#fff;font-size:.82rem;font-weight:700;letter-spacing:.01em;box-shadow:0 2px 10px rgba(24,19,13,.22)}
  .cover-chip svg{width:18px;height:18px}
  @media(max-width:560px){.hero-cover{aspect-ratio:16/9}.cover-chip{left:12px;bottom:10px;font-size:.78rem}}
  .facts{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}
  .facts th,.facts td{text-align:left;padding:12px 16px;font-size:.92rem;border-bottom:1px solid var(--line);vertical-align:top}
  .facts tr:last-child th,.facts tr:last-child td{border-bottom:none}
  .facts th{width:38%;color:var(--mist);font-weight:600}
  .evidence{margin-top:16px;font-size:.84rem;color:var(--mist)}
  .aside{display:flex;flex-direction:column;gap:16px;position:sticky;top:78px}
  @media(max-width:860px){.aside{position:static}}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;box-shadow:var(--sh-sm)}
  .card h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mist);margin-bottom:12px}
  .cta{display:block;text-align:center;background:linear-gradient(135deg,var(--amber-500),var(--coral-500));color:#fff;font-weight:800;padding:14px 18px;border-radius:var(--r-pill);box-shadow:0 4px 14px rgba(255,93,59,.4)}
  .cta:hover{text-decoration:none;filter:brightness(1.04)}
  .cta-soft{color:var(--ink-soft);font-size:.92rem}
  .prov-name{font-weight:700;font-size:1.04rem;margin-bottom:6px}
  .prov-verified{color:#0f7a3d;font-size:.86rem;margin-bottom:8px}
  .prov-soft{color:var(--mist);font-size:.88rem}
  .prov-link{font-size:.88rem;margin-top:6px}
  .map-card{display:flex;align-items:center;gap:12px;color:var(--ink-soft);background:var(--canvas-2);border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px}
  .map-card:hover{text-decoration:none;border-color:var(--fjord-600)}
  .map-card svg{color:var(--fjord-600);flex:0 0 22px}
  .map-card strong{display:block;color:var(--ink);font-size:.95rem}
  .map-sub{font-size:.8rem;color:var(--mist)}
  .map-fallback:hover{border-color:var(--line)}
  .related{margin:34px 0 10px}
  .related h2{font-size:1.2rem;font-weight:800;color:var(--fjord-900);margin-bottom:14px}
  .rel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .rel-card{display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--fjord-700);border-radius:var(--r-md);padding:14px 16px 14px 15px}
  .rel-card:hover{text-decoration:none;box-shadow:var(--sh-md);transform:translateY(-2px)}
  .rel-title{font-weight:700;color:var(--ink);font-size:.95rem}
  .rel-meta{font-size:.82rem;color:var(--mist)}
  .site-foot{margin-top:48px;border-top:1px solid var(--line);background:var(--canvas-2)}
  .foot-inner{max-width:var(--maxw);margin:0 auto;padding:26px 24px;font-size:.84rem;color:var(--mist);display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}
  .foot-inner a{color:var(--ink-soft)}
/* S1 shared chrome, appended LAST on purpose so its nav/footer rules win over
   the slim ones above (same technique as /kategori/gardssalg). The experience
   profile was the last human-facing page still wearing the legacy two-link
   nav + mini footer — Daniel 2026-08-24 asked for a profile remake, and
   "looks like the rest of the site" is half of that. */
${OA_CHROME_CSS}
</style>
${lat !== null && lon !== null ? `<style>${MINI_MAP_CSS}</style>` : ""}
</head>
<body>
<a class="skip-link" href="#main">${L.skip}</a>
${oaSiteNav({ lang, path: noPath, switcher: switcherOn || undefined })}
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="${L.crumbs}">
    <a href="${localizedPath("/", uiLang) || "/"}">${L.home}</a>${cat ? `<span class="sep">/</span><a href="/kategori/${encodeURIComponent(cat)}">${escapeHtml(catLabel(cat))}</a>` : ""}<span class="sep">/</span>${escapeHtml(switcherOn ? displayTitle : exp.title)}
  </nav>
  <header class="head">
    <h1>${escapeHtml(displayTitle)}</h1>
    ${place ? `<p class="place"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="9" r="2.3" fill="currentColor"/></svg>${escapeHtml(place)}</p>` : ""}
    <div class="badges">${badges.join("")}</div>
  </header>
  <div class="layout">
    <article>
      ${heroMedia}
      ${descBlock}
      <table class="facts"><caption class="skip-link">${L.factsCaption}</caption><tbody>${factsRows}</tbody></table>
      ${evBlock}
    </article>
    <aside class="aside">
      <div class="card"><h2>${L.booking}</h2>${cta}${phoneBlock}</div>
      <div class="card"><h2>${L.provider}</h2>${provInner}</div>
      <div class="card"><h2>${L.place}</h2>${mapBlock}</div>
    </aside>
  </div>
  ${relBlock}
</main>
${oaSiteFooter({ lang })}
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════
// Phase 2 — human-browse subpages (opplevagent.no)
//   /opplevelser          index/listing of all experiences (paginated)
//   /kategori/:category    experiences in a category
//   /fylke/:fylke          experiences in a county
//   /tilbyder/:providerId  one provider's experiences
//   /sok?q=                HTML search-results page
//
// All server-rendered on the Opplevagent brand, DB-template-driven (a new
// published row auto-appears in the right index + the sitemap, no code change),
// host-gated (mounted only behind the opplevagent.no gate), each with
// breadcrumbs + CollectionPage/ItemList JSON-LD + a graceful empty-state. Every
// card links to a /opplevelse/<slug> page that is guaranteed live (same publish
// gate), so there are zero dead links. These reuse the experience-store reads,
// NOT the /api/opplevelser/discover JSON contract (which is unchanged).
// ═══════════════════════════════════════════════════════════

const BROWSE_PAGE_SIZE = 24;

// Shared minimal CSS for every browse page — same brand tokens as the landing /
// detail pages, kept compact since these are list views.
const BROWSE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --fjord-900:#0b2e29;--fjord-800:#0e3c36;--fjord-700:#0f5a50;--fjord-600:#0c7264;
    --font-brand:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--olive:#6f7a4f;--gold:#c98a2b;
    --teal-500:#12a594;--teal-400:#3cc3b4;--amber-500:#ff5d3b;--coral-500:#ff5d3b;
    --ink:#18130d;--ink-soft:#544a3e;--mist:#7a7163;
    --surface:#fff;--canvas:#f7f4ee;--canvas-2:#efe9dd;--line:#e4ded0;
    --r-sm:8px;--r-md:14px;--r-lg:20px;--r-pill:999px;
    --sh-sm:0 1px 2px rgba(24,19,13,.06),0 2px 6px rgba(24,19,13,.05);
    --sh-md:0 6px 18px rgba(24,19,13,.10);--maxw:1120px;
  }
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--canvas);line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--fjord-600);text-decoration:none}
  a:hover{text-decoration:underline}
  :focus-visible{outline:3px solid var(--amber-500);outline-offset:2px;border-radius:4px}
  svg{display:block}
  .container{max-width:var(--maxw);margin:0 auto;padding:0 24px}
  @media(max-width:560px){.container{padding:0 16px}}
  .skip-link{position:absolute;left:-9999px;top:0;background:var(--fjord-800);color:#fff;padding:10px 16px;z-index:200}
  .skip-link:focus{left:0}
  .site-nav{position:sticky;top:0;z-index:100;background:rgba(244,248,244,.9);backdrop-filter:saturate(160%) blur(12px);border-bottom:1px solid var(--line)}
  .nav-inner{max-width:var(--maxw);margin:0 auto;padding:0 24px;height:58px;display:flex;align-items:center;justify-content:space-between}
  @media(max-width:560px){.nav-inner{padding:0 16px}}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.12rem;color:var(--fjord-800)}
  .brand:hover{text-decoration:none}
  .brand-word{font-family:var(--font-brand);font-weight:600;font-size:1.3rem;letter-spacing:-.015em;text-transform:lowercase;line-height:1;color:var(--ink)}
  .brand-word .tld{color:var(--fjord-600)}
  .brand .mark{display:flex;align-items:center;justify-content:center}
  .brand .mark svg{display:block}
  .nav-links a{font-size:.86rem;font-weight:600;color:var(--ink-soft);margin-left:22px}
  .breadcrumb{padding:18px 0 4px;font-size:.84rem;color:var(--mist)}
  .breadcrumb a{color:var(--ink-soft)}
  .breadcrumb .sep{margin:0 8px;color:var(--line)}
  .head{padding:14px 0 6px}
  /* Category-coloured page head (Daniel 2026-08-24) — only /kategori/:category
     passes an accent; every other browse page keeps the plain .head. */
  .head-accent{border-left:5px solid var(--fjord-700);padding-left:18px;border-radius:2px}
  .head-eyebrow{display:flex;align-items:center;gap:8px;font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
  .head h1{font-size:clamp(1.5rem,3.4vw,2.3rem);font-weight:800;letter-spacing:-.025em;line-height:1.14;color:var(--fjord-900)}
  .head .lede{margin-top:8px;color:var(--ink-soft);font-size:1rem;max-width:60ch}
  .count{margin-top:6px;font-size:.86rem;color:var(--mist)}
  .searchbar{margin:18px 0 4px}
  .searchbar form{display:flex;gap:0;background:#fff;border:1px solid var(--line);border-radius:var(--r-pill);padding:5px 5px 5px 8px;box-shadow:var(--sh-sm);align-items:center;max-width:560px}
  .searchbar .field{display:flex;align-items:center;gap:9px;flex:1;padding-left:10px;min-width:0}
  .searchbar .field svg{color:var(--mist);flex:0 0 18px}
  .searchbar input{flex:1;border:none;outline:none;font-size:1rem;color:var(--ink);background:transparent;padding:11px 4px;min-width:0}
  .searchbar button{flex:0 0 auto;border:none;cursor:pointer;background:var(--fjord-800);color:#fff;font-weight:700;font-size:.9rem;padding:11px 20px;border-radius:var(--r-pill)}
  .searchbar button:hover{background:var(--fjord-700)}
  .near-me{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:12px 0 4px}
  .near-me .geo-btn{display:inline-flex;align-items:center;gap:7px;border:1.5px solid var(--teal-500);background:var(--surface);color:var(--teal-500);font-weight:700;font-size:.85rem;padding:9px 16px;border-radius:var(--r-pill);cursor:pointer}
  .near-me .geo-btn:hover{background:var(--teal-500);color:#fff}
  .near-me .geo-btn:disabled{opacity:.6;cursor:default}
  .near-me .geo-btn[hidden]{display:none}
  .near-me .place-fallback{display:flex;align-items:center;gap:0;background:#fff;border:1px solid var(--line);border-radius:var(--r-pill);padding:4px 4px 4px 12px}
  .near-me .place-fallback input{border:none;outline:none;font-size:.85rem;color:var(--ink);background:transparent;padding:7px 4px;width:150px}
  .near-me .place-fallback button{border:none;cursor:pointer;background:var(--canvas-2);color:var(--ink-soft);font-weight:700;font-size:.8rem;padding:7px 14px;border-radius:var(--r-pill)}
  .near-me .place-fallback button:hover{background:var(--teal-400);color:#fff}
  .sort-toggle{margin:10px 0 4px;font-size:.84rem}
  .sort-toggle a{color:var(--ink-soft);font-weight:600}
  .sort-toggle a.active{color:var(--teal-500)}
  .geo-note{color:var(--mist);font-size:.82rem;margin:6px 0 0}
  /* dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
     Steg 1: section labels ("Produsenter" / "Opplevelser") separating /sok's
     two result kinds — only rendered when a producer match exists. */
  .sok-section-title{font-size:.9rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--fjord-800);margin:26px 0 4px}
  .sok-producers{margin-top:6px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 4px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.82rem;font-weight:600;border:1px solid var(--line)}
  .chip:hover{text-decoration:none;border-color:var(--teal-400);color:var(--fjord-700)}
  .chip .n{color:var(--mist);font-weight:600}
  .chip-dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:0 0 9px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin:22px 0 8px}
  .card{display:flex;flex-direction:column;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:18px 18px;box-shadow:var(--sh-sm);transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}
  .card:hover{transform:translateY(-3px);box-shadow:var(--sh-md);border-color:var(--teal-400);text-decoration:none}
  /* Category-coloured experience card (Daniel 2026-08-24). The colour arrives
     as an inline border-top-color from renderCard(); this rule only gives it
     the edge to paint and keeps the hover from repainting that edge teal. */
  .card-cat{border-top:4px solid var(--fjord-700);padding-top:15px}
  .card-cat:hover{border-color:var(--line);border-top-color:inherit}
  .card .c-title{font-weight:700;color:var(--ink);font-size:1.04rem;letter-spacing:-.01em;line-height:1.25}
  .card .c-place{font-size:.84rem;color:var(--mist);display:flex;align-items:center;gap:6px}
  .card .c-place svg{flex:0 0 14px;color:var(--fjord-600)}
  .card .c-distance{font-size:.84rem;color:var(--teal-500);font-weight:600;display:flex;align-items:center;gap:6px}
  .card .c-distance svg{flex:0 0 14px;color:var(--teal-500)}
  .card .c-desc{font-size:.9rem;color:var(--ink-soft);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .card .c-meta{margin-top:auto;display:flex;flex-wrap:wrap;gap:6px;padding-top:4px}
  .tag{display:inline-flex;align-items:center;padding:3px 10px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.74rem;font-weight:600;border:1px solid var(--line)}
  .tag-cat{background:var(--fjord-800);color:#fff;border-color:var(--fjord-800)}
  .tag-filter{background:transparent;color:var(--teal-500);border-color:var(--teal-500)}
  .filter-chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 22px}
  .chip{display:inline-flex;align-items:center;padding:7px 14px;border-radius:var(--r-pill);background:var(--surface);color:var(--ink-soft);font-size:.85rem;font-weight:600;border:1px solid var(--line)}
  .chip:hover{text-decoration:none;border-color:var(--teal-500);color:var(--teal-500)}
  .chip-active{background:var(--teal-500);color:#fff;border-color:var(--teal-500)}
  .chip-active:hover{background:var(--teal-400);border-color:var(--teal-400);color:#fff}
  .empty{margin:30px 0;background:var(--surface);border:1px dashed var(--line);border-radius:var(--r-lg);padding:40px 28px;text-align:center;color:var(--ink-soft)}
  .empty h2{font-size:1.15rem;color:var(--fjord-900);margin-bottom:8px}
  .empty p{font-size:.95rem;max-width:46ch;margin:0 auto}
  .empty .cta{display:inline-block;margin-top:16px;background:var(--fjord-800);color:#fff;font-weight:700;padding:10px 18px;border-radius:var(--r-pill)}
  .empty .cta:hover{text-decoration:none;background:var(--fjord-700)}
  .search-group{margin-top:8px}
  .search-group + .search-group{margin-top:28px;padding-top:20px;border-top:1px solid var(--line)}
  .search-group-label{font-size:.82rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--fjord-700);margin-bottom:4px}
  .pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 0 8px;flex-wrap:wrap}
  .pager a,.pager span{font-size:.9rem;font-weight:700}
  .pager .btn{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:var(--r-pill);background:var(--surface);border:1px solid var(--line);color:var(--fjord-700)}
  .pager .btn:hover{text-decoration:none;border-color:var(--fjord-600)}
  .pager .btn[aria-disabled="true"]{opacity:.4;pointer-events:none}
  .pager .pos{color:var(--mist);font-weight:600}
  .site-foot{margin-top:48px;border-top:1px solid var(--line);background:var(--canvas-2)}
  .foot-inner{max-width:var(--maxw);margin:0 auto;padding:26px 24px;font-size:.84rem;color:var(--mist);display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}
  .foot-inner a{color:var(--ink-soft)}
`;

// dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1: CSS for
// the /fylke/:fylke Leaflet map section. Deliberately kept OUT of BROWSE_CSS
// (which EVERY browse page's <style> block embeds unconditionally) and
// injected via its own <style> tag ONLY when opts.map is set (see
// renderBrowsePage below) — so /opplevelser, /kategori/*, /kommune/:kommune
// keep rendering byte-identically to before this feature existed (no unused
// CSS added to pages that never get a map).
const FYLKE_MAP_CSS = `
  .map-section{margin:26px 0 8px}
  .map-section h2{font-size:1.05rem;font-weight:800;color:var(--fjord-900);margin:0 0 8px}
  .map-legend{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 10px;font-size:.82rem;color:var(--ink-soft);list-style:none;padding:0}
  .map-legend .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .map-legend .dot-address{background:var(--fjord-700)}
  .map-legend .dot-kommune{background:#f5a623;border:1.5px dashed #c2570c}
  .fylke-map{width:100%;height:420px;border-radius:var(--r-md);border:1px solid var(--line);background:var(--canvas-2);position:relative;overflow:hidden;z-index:0}
  .fylke-map .map-loading{margin:0;padding:18px;color:var(--mist);font-size:.88rem}
  .map-attribution-note{font-size:.78rem;color:var(--mist);margin-top:8px}
  .map-attribution-note a{color:var(--ink-soft)}
  .map-noscript{margin-top:8px;font-size:.88rem}
  .map-popup{font-size:.86rem;line-height:1.45;min-width:160px}
  .map-popup strong{display:block;font-size:.92rem;color:var(--ink);margin-bottom:2px}
  .map-popup .map-popup-meta{display:block;color:var(--mist);font-size:.8rem}
  .map-popup .map-popup-approx{display:block;color:#c2570c;font-weight:700;font-size:.78rem;margin-top:4px}
  .map-popup a{display:inline-block;margin-top:6px;font-weight:700}
  .map-popup-cluster-list{list-style:none;padding:0;margin:6px 0 0;max-height:160px;overflow-y:auto}
  .map-popup-cluster-list li{margin:0 0 4px}
  .map-popup-cluster-list a{display:inline;margin-top:0;font-weight:700}
  .map-cluster-icon{background:transparent;border:none}
  .cluster-bubble{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;font-weight:800;font-size:.82rem;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35)}
  .cluster-exact{background:var(--fjord-700);border:2px solid var(--fjord-900)}
  .cluster-approx{background:#f5a623;border:2px dashed #c2570c;color:#5c3a00}
  .map-cluster-note{font-size:.78rem;color:var(--mist);margin-top:8px}
`;

// dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, arbeidspunkt 6
// ("Klynging ved tette punkter (Oslo/Bergen)"): shared client-side
// clustering helper, reused VERBATIM by both FYLKE_MAP_INIT_JS and
// GARDSSALG_MAP_INIT_JS below — same "reused as-is, not copied" discipline
// already used for FYLKE_MAP_CSS (see renderGardssalgMapSection's header
// comment). Operates ENTIRELY on the already-injected marker JSON island —
// no new API round-trip, no new endpoint (dev-request requirement 1).
// Mirrors src/services/map-clustering.ts's clusterMapPoints() algorithm —
// that TS module is what tests/test.ts's runMapClusteringTests() actually
// unit-tests (this repo's test runner has no headless browser/DOM — same
// constraint slice 1 flagged for the Lighthouse criterion); keep the two
// copies in sync by hand if the algorithm ever changes.
//
// Precision-honesty invariant (dev-request requirement 3): clusterMapPoints
// NEVER merges an approx (kommune-centroid) point with an exact-address
// point, even at the identical coordinate — points are partitioned by
// their `approx` flag BEFORE clustering, so a cluster's own approx flag is
// unambiguous. An all-approx cluster bubble keeps the SAME dashed/orange
// styling + "Ca. posisjon" note a single approx marker already gets; an
// all-exact cluster is styled distinctly (solid) from both single exact
// markers AND approx clusters, so a cluster of real addresses is never
// mistaken for one single precise point either — it visibly reads as "N
// points here," never as fabricated single-point precision.
const MAP_CLUSTER_JS = `
  var MAP_CLUSTER_RADIUS_KM = 3;
  var MAP_CLUSTER_MIN_SIZE = 2;
  function mapHaversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function mapClusterPartition(pts) {
    var n = pts.length;
    var parent = [];
    for (var i = 0; i < n; i++) parent.push(i);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (mapHaversineKm(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon) <= MAP_CLUSTER_RADIUS_KM) union(i, j);
      }
    }
    var order = [];
    var groups = {};
    for (var i = 0; i < n; i++) {
      var root = find(i);
      if (!groups[root]) { groups[root] = []; order.push(root); }
      groups[root].push(pts[i]);
    }
    var result = [];
    for (var k = 0; k < order.length; k++) {
      var members = groups[order[k]];
      var sumLat = 0, sumLon = 0;
      for (var m = 0; m < members.length; m++) { sumLat += members[m].lat; sumLon += members[m].lon; }
      result.push({ lat: sumLat / members.length, lon: sumLon / members.length, approx: members[0].approx, members: members });
    }
    return result;
  }
  function clusterMapPoints(points) {
    var exact = [];
    var approx = [];
    for (var i = 0; i < points.length; i++) {
      if (points[i].approx) approx.push(points[i]); else exact.push(points[i]);
    }
    return mapClusterPartition(exact).concat(mapClusterPartition(approx));
  }
`;

// One marker's worth of data as sent to the client (the JSON data island) —
// deliberately a smaller/pre-resolved shape than ExperienceMapPoint: title is
// already resolved to the display title per the page's lang (same title_no
// fallback convention as renderCard()) and category is already resolved to
// its human label (catLabel()), so the client init script does zero
// business-logic duplication — it only renders what the server decided.
type FylkeMapMarker = {
  slug: string;
  title: string;
  kommune: string | null;
  categoryLabel: string;
  lat: number;
  lon: number;
  precision: "address" | "kommune";
};

// Lazy-init script for the /fylke/:fylke map — fires once #fylke-map nears
// the viewport (IntersectionObserver; falls back to eager init on ancient
// browsers without it), fetching self-hosted Leaflet (/leaflet/leaflet.js +
// .css — vendored under src/public/leaflet/, see package.json's "leaflet"
// dependency) ONLY at that point, never blocking initial page load. No
// inline event-handler attributes (onclick=/onchange=) anywhere — GUIDEBOOK.md
// appendix C.44's CSP-strict-browser regression — everything below is
// addEventListener-driven. geo_precision='kommune' points (kommune-centroid
// fallback, never an exact address) render as a distinct dashed circle
// marker, never the default pin, AND get an explicit "Ca. posisjon
// (kommune)" note in their popup — same honesty discipline as
// formatDistanceLabel()/the detail-page map-card's geoApprox note.
const FYLKE_MAP_INIT_JS = `(function () {
  var mapEl = document.getElementById('fylke-map');
  var dataEl = document.getElementById('fylke-map-data');
  if (!mapEl || !dataEl) return;
  var points = [];
  try { points = JSON.parse(dataEl.textContent || '[]'); } catch (e) { points = []; }
  if (!points.length) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  ${MAP_CLUSTER_JS}

  var leafletLoading = null;
  function loadLeaflet() {
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/leaflet/leaflet.css';
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = '/leaflet/leaflet.js';
      script.addEventListener('load', function () { resolve(); });
      script.addEventListener('error', function () { reject(new Error('leaflet-load-failed')); });
      document.body.appendChild(script);
    });
    return leafletLoading;
  }

  function initMap() {
    loadLeaflet().then(function () {
      if (typeof L === 'undefined') return;
      mapEl.textContent = '';
      var map = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragsytere'
      }).addTo(map);

      var addressIcon = L.icon({
        iconUrl: '/leaflet/images/marker-icon.png',
        iconRetinaUrl: '/leaflet/images/marker-icon-2x.png',
        shadowUrl: '/leaflet/images/marker-shadow.png',
        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
      });

      // Bounds are computed from the RAW, unclustered points — fitBounds
      // must always cover the true full extent regardless of how markers
      // end up visually grouped below.
      var bounds = [];
      points.forEach(function (p) { bounds.push([p.lat, p.lon]); });

      // arbeidspunkt 6: cluster the SAME already-injected points (no new
      // fetch) before rendering markers. Each point keeps a reference back
      // to its original object (\`orig\`) so popups/links render exactly the
      // same per-point content as before this feature existed.
      var clusterInput = points.map(function (p) {
        return { lat: p.lat, lon: p.lon, approx: p.precision === 'kommune', orig: p };
      });
      var clusterGroups = clusterMapPoints(clusterInput);
      var anyRealCluster = false;

      clusterGroups.forEach(function (g) {
        if (g.members.length < MAP_CLUSTER_MIN_SIZE) {
          var p = g.members[0].orig;
          var isApprox = p.precision === 'kommune';
          var marker = isApprox
            ? L.circleMarker([p.lat, p.lon], { radius: 9, weight: 2, color: '#c2570c', dashArray: '3,3', fillColor: '#f5a623', fillOpacity: 0.55 })
            : L.marker([p.lat, p.lon], { icon: addressIcon });
          var metaBits = [];
          if (p.kommune) metaBits.push(esc(p.kommune));
          if (p.categoryLabel) metaBits.push(esc(p.categoryLabel));
          var popupHtml = '<div class="map-popup"><strong>' + esc(p.title) + '</strong>'
            + (metaBits.length ? '<span class="map-popup-meta">' + metaBits.join(' · ') + '</span>' : '')
            + (isApprox ? '<span class="map-popup-approx">Ca. posisjon (kommune)</span>' : '')
            + '<a href="/opplevelse/' + encodeURIComponent(p.slug) + '">Se opplevelsen →</a></div>';
          marker.bindPopup(popupHtml);
          marker.addTo(map);
        } else {
          anyRealCluster = true;
          var clusterClass = g.approx ? 'cluster-approx' : 'cluster-exact';
          var clusterIcon = L.divIcon({
            className: 'map-cluster-icon',
            html: '<div class="cluster-bubble ' + clusterClass + '">' + g.members.length + '</div>',
            iconSize: [32, 32]
          });
          var clusterMarker = L.marker([g.lat, g.lon], { icon: clusterIcon });
          var itemsHtml = g.members.map(function (m) {
            return '<li><a href="/opplevelse/' + encodeURIComponent(m.orig.slug) + '">' + esc(m.orig.title) + '</a></li>';
          }).join('');
          var clusterPopupHtml = '<div class="map-popup"><strong>' + g.members.length + ' opplevelser her</strong>'
            + (g.approx ? '<span class="map-popup-approx">Ca. posisjon (kommune) for alle punktene i denne klyngen</span>' : '')
            + '<ul class="map-popup-cluster-list">' + itemsHtml + '</ul></div>';
          clusterMarker.bindPopup(clusterPopupHtml);
          clusterMarker.addTo(map);
        }
      });

      if (anyRealCluster) {
        var clusterNote = document.createElement('p');
        clusterNote.className = 'map-cluster-note';
        clusterNote.textContent = 'Tall i sirkel = antall punkter samlet på ett sted (klynget for lesbarhet).';
        mapEl.parentNode.insertBefore(clusterNote, mapEl.nextSibling);
      }

      if (bounds.length === 1) {
        map.setView(bounds[0], 12);
      } else {
        map.fitBounds(bounds, { padding: [28, 28] });
      }
    }).catch(function () {
      mapEl.innerHTML = '<p class="map-loading">Kartet kunne ikke lastes.</p>';
    });
  }

  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          obs.disconnect();
          initMap();
        }
      });
    }, { rootMargin: '200px 0px' });
    obs.observe(mapEl);
  } else {
    initMap();
  }
})();`;

// Renders the /fylke/:fylke map section: legend + map container + attribution
// + <noscript> OSM fallback + a JSON data island + the deferred lazy-init
// script above. Returns "" when there are no geocoded points (honest
// omission — same discipline as productsBlock/mapBlock elsewhere in this
// file — never an empty/broken map). Tile source: OSM's standard
// {s}.tile.openstreetmap.org XYZ raster tiles (see final report for why —
// short version: simpler/more reliably reachable than Kartverket's WMTS from
// this sandbox, and Leaflet requests tiles as plain <img> tags, which the
// existing global CSP imgSrc "https:" already allows — zero CSP changes
// needed). Correct OSM attribution is rendered both under the map and inside
// the tile layer itself (attribution control, bottom-right of the map).
function renderFylkeMapSection(fylke: string, points: ExperienceMapPoint[], lang: Lang): string {
  if (points.length === 0) return "";
  const markers: FylkeMapMarker[] = points.map((p) => ({
    slug: p.slug,
    title: lang === "no" ? (p.title_no || p.title) : p.title,
    kommune: p.kommune,
    categoryLabel: catLabel(p.category),
    lat: p.loc_lat,
    lon: p.loc_lon,
    precision: p.geo_precision,
  }));
  const dataJson = JSON.stringify(markers).replace(/<\//g, "<\\/");
  const addressCount = markers.filter((m) => m.precision === "address").length;
  const kommuneCount = markers.length - addressCount;
  // Simple fylke-name-based OSM search link (spec explicitly allows this over
  // a computed centroid) — a centroid could misleadingly read as "the exact
  // position of the fylke", which isn't a real point; a name search is
  // honest about what it is.
  const osmSearchUrl = `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${fylke}, Norge`)}`;

  return `<section class="map-section" aria-labelledby="fylke-map-h">
    <h2 id="fylke-map-h">Kart over opplevelser i ${escapeHtml(fylke)}</h2>
    <p class="map-legend">${addressCount > 0 ? `<span><span class="dot dot-address" aria-hidden="true"></span>Nøyaktig posisjon</span>` : ""}${kommuneCount > 0 ? `<span><span class="dot dot-kommune" aria-hidden="true"></span>Ca. posisjon (kommune)</span>` : ""}</p>
    <div id="fylke-map" class="fylke-map" role="group" aria-label="Kart over ${markers.length} ${markers.length === 1 ? "opplevelse" : "opplevelser"} i ${escapeHtml(fylke)}"><p class="map-loading">Kartet lastes når du scroller hit …</p></div>
    <p class="map-attribution-note">Kartdata © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragsytere</p>
    <noscript><p class="map-noscript"><a href="${escapeHtml(osmSearchUrl)}" target="_blank" rel="noopener">Åpne kart over ${escapeHtml(fylke)} i OpenStreetMap →</a></p></noscript>
    <script type="application/json" id="fylke-map-data">${dataJson}</script>
    <script>${FYLKE_MAP_INIT_JS}</script>
  </section>`;
}

// Brand nav + footer shared by every browse page.
const BROWSE_NAV = `<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav"><div class="nav-inner">
  <a class="brand" href="/">${brandInner("light")}</a>
  <span class="nav-links"><a href="/opplevelser">Alle opplevelser</a><a href="/#kategorier">Kategorier</a></span>
</div></nav>`;

function browseFooter(): string {
  return `<footer class="site-foot"><div class="foot-inner">
  <span>© ${new Date().getFullYear()} Opplevagent — norske opplevelser, håndplukket og verifisert.</span>
  <span><a href="/opplevelser">Alle opplevelser</a> · <a href="/reise">Langs ruten</a> · <a href="/llms.txt">llms.txt</a> · <a href="/sitemap.xml">Sitemap</a></span>
</div></footer>`;
}

function placeOf(row: { kommune?: string | null; fylke?: string | null }): string {
  return [row.kommune, row.fylke].filter(Boolean).join(", ");
}

const PIN_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="9" r="2.3" fill="currentColor"/></svg>';

// Render one experience card. Title links to the guaranteed-live detail page.
// `distance` is optional and ONLY ever passed by /sok's «Nær meg» path (dev-
// request 2026-07-04-opplevagent-naer-meg-geosok, item 3) — every other
// caller (renderBrowsePage: /opplevelser, /kategori/*, /fylke/*, /kommune/*,
// provider pages) omits it, so those pages render byte-identically to before
// this feature existed.
function renderCard(
  row: ExperienceCardRow,
  lang: Lang,
  distance?: { distance_km: number | null; geo_precision: "address" | "kommune" | null }
): string {
  const place = placeOf(row);
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 2: /no
  // prefers the LLM-generated Norwegian display title, falling back to the
  // original `title` when title_no hasn't been backfilled yet (never a
  // broken/empty title). /en always renders the original title, unchanged.
  const displayTitle = lang === "no" ? (row.title_no || row.title) : row.title;
  let cardDescription = row.description || "";
  if (cardDescription && isJunkDescription(cardDescription)) {
    console.log(`[description-guard] suppressed junk description (opplevelse card) for ${row.slug} (${row.title})`);
    cardDescription = "";
  }
  const desc = cardDescription
    ? `<p class="c-desc">${escapeHtml(cardDescription)}</p>`
    : "";
  const distanceLabel = distance
    ? formatDistanceLabel(distance.distance_km, distance.geo_precision, row.kommune)
    : null;
  const distanceHtml = distanceLabel
    ? `<span class="c-distance">${PIN_SVG}${escapeHtml(distanceLabel)}</span>`
    : "";
  // Daniel 2026-08-24: a listing card carries its category's colour — a thin
  // top edge plus the category tag itself — so a mixed grid is scannable by
  // colour instead of being 24 identical white rectangles. Same categoryColor()
  // source as the icons, the covers and the detail page.
  const cardColor = categoryColor(row.category);
  const tags: string[] = [];
  if (row.category) tags.push(`<span class="tag tag-cat" style="background:${cardColor};border-color:${cardColor}">${escapeHtml(catLabel(row.category))}</span>`);
  if (row.indoor_outdoor) tags.push(`<span class="tag">${escapeHtml(ioLabel(row.indoor_outdoor))}</span>`);
  if (row.price_from) tags.push(`<span class="tag">fra ${row.price_from} kr</span>`);
  else if (row.price_band && PRICE_BAND_LABELS[row.price_band]) tags.push(`<span class="tag">${escapeHtml(PRICE_BAND_LABELS[row.price_band] as string)}</span>`);
  // dev-request 2026-07-04-opplevagent-taksonomi-filtre item 4: badges on
  // cards for the derived cross-cutting filter tags. "gratis"/"under-300"
  // are skipped here — the price badge above already conveys that; showing
  // both would be redundant on the same card. Capped at 2 so cards don't
  // get noisy (up to 6 tags could otherwise fire on one row).
  const filterBadges = row.tags.filter((t) => t !== "gratis" && t !== "under-300").slice(0, 2);
  for (const t of filterBadges) {
    tags.push(`<span class="tag tag-filter">${escapeHtml(FILTER_TAG_LABELS[t])}</span>`);
  }
  return `<a class="card card-cat" style="border-top-color:${cardColor}" href="/opplevelse/${encodeURIComponent(row.slug)}">
    <span class="c-title">${escapeHtml(displayTitle)}</span>
    ${place ? `<span class="c-place">${PIN_SVG}${escapeHtml(place)}</span>` : ""}
    ${distanceHtml}
    ${desc}
    <span class="c-meta">${tags.join("")}</span>
  </a>`;
}

// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 1: renders one gårdssalg producer hit in /sok's "Produsenter" section.
// Reuses the SAME generic .card/.c-title/.c-place/.c-meta classes renderCard()
// above uses (BROWSE_CSS's rules aren't experience-specific) and drinkBadge()
// (module-scope, already shared with the /kategori/gardssalg grid and
// produsent-profil page) rather than inventing new styling — visually
// consistent with the rest of this page and the site's own gårdssalg cards.
// Always links to the real profile page: searchGardssalgProvidersByQuery()
// only ever returns rows with a real, non-empty slug (see its own doc
// comment), so there is no "no link" fallback to handle here.
function renderSokProducerCard(p: GardssalgSearchByQueryRow): string {
  const sted = [p.poststed ?? p.kommune ?? p.fylke].filter(Boolean).join(", ");
  const badge = drinkBadge(p.producer_type);
  return `<a class="card" href="/kategori/gardssalg/produsent/${encodeURIComponent(p.slug)}">
    <span class="c-title">${escapeHtml(p.navn)}</span>
    ${sted ? `<span class="c-place">${PIN_SVG}${escapeHtml(sted)}</span>` : ""}
    ${badge ? `<span class="c-meta">${badge}</span>` : ""}
  </a>`;
}

type BreadcrumbCrumb = { name: string; href?: string };

// Assemble a full browse page: meta + JSON-LD (CollectionPage with an ItemList of
// the cards on THIS page + BreadcrumbList) + breadcrumbs + grid (or empty-state)
// + pager. `canonicalPath` is the path WITHOUT query (so canonical is stable).
function renderBrowsePage(opts: {
  title: string;
  h1: string;
  metaDesc: string;
  lede?: string;
  canonicalPath: string;
  crumbs: BreadcrumbCrumb[];
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 2:
  // req.lang, threaded through to renderCard() so /no card titles prefer
  // title_no (falling back to title) while /en always renders the original
  // title — see renderCard()'s lang param below.
  lang: Lang;
  rows: ExperienceCardRow[];
  total: number;
  page: number;          // 1-based
  pageSize: number;
  pagerBase?: string;    // path used for ?page= links (defaults to canonicalPath)
  extraTopHtml?: string; // e.g. search box / facet chips, rendered above the grid
  emptyTitle?: string;
  emptyBody?: string;
  // GEO: additional JSON-LD objects to render alongside CollectionPage +
  // BreadcrumbList — e.g. a quality-gated FAQPage block (see
  // buildCategoryFaqJsonLd/buildKommuneFaqJsonLd). Omitted entirely when the
  // quality gate says the page doesn't have enough real facts.
  extraJsonLd?: any[];
  // dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 4: slug →
  // distance info, ONLY ever passed by /fylke/:fylke and /kommune/:kommune
  // when a «nærmest deg» geo sort is active (mirrors /sok's item-3
  // distanceMap). Every other caller (/opplevelser, /kategori/*, provider
  // pages, and /fylke|/kommune themselves with no geo sort active) omits it,
  // so those pages render byte-identically to before this feature existed.
  distanceMap?: Map<string, { distance_km: number | null; geo_precision: "address" | "kommune" | null }>;
  // dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1: an
  // optional Leaflet map section, ONLY ever passed by /fylke/:fylke (this
  // dev-request's arbeidspunkt 3 — /kategori/gardssalg's map, mini-maps on
  // detail/producer pages, and marker clustering are separate later slices).
  // Every other caller (/opplevelser, /kategori/*, /kommune/:kommune,
  // provider pages) omits it, so those pages render byte-identically to
  // before this feature existed. `fylke` is used for the section heading +
  // the <noscript> OSM fallback link; `points` are the (already
  // publish-gated + coords-filtered) markers to plot.
  map?: { fylke: string; points: ExperienceMapPoint[] };
  // dev-request 2026-08-08-opplevagent-ux-loft-kategorimotiver: opts-in the
  // shared S1 chrome (oaSiteNav()/oaSiteFooter()/OA_CHROME_CSS — hamburger
  // nav + full footer incl. "For tilbydere") instead of the legacy
  // BROWSE_NAV/browseFooter() slim chrome. Default false/omitted, so every
  // existing caller (/opplevelser, /fylke/:fylke, /kommune/:kommune,
  // /tilbyder/:id, /sok) renders BYTE-IDENTICALLY to before this option
  // existed — only the /kategori/:category handler passes true.
  useSharedChrome?: boolean;
  // Which oaSiteNav() item to mark aria-current="page" — only consulted
  // when useSharedChrome is true.
  navActive?: OaNavActive;
  // Optional still-sketch backdrop layer (see the motif lookup above) behind
  // <main>, wrapped in the same `.oa-sketch-stage` technique the gårdssalg
  // catalog page uses. Omitted by every existing caller (byte-identical
  // output preserved) — only passed by /kategori/:category for its three
  // supported category motifs.
  sketchMotif?: StillSketchMotif;
  // dev-request 2026-08-24-opplevagent-kategorifarger-og-profil-remake:
  // the page's own category colour (categoryColor()). Passed ONLY by
  // /kategori/:category — every other caller omits it and renders exactly as
  // before. Paints the h1's accent rule and the eyebrow, so a category page
  // announces which category it is before a single card is read.
  accentColor?: string;
  accentLabel?: string;
}): string {
  const url = baseUrl();
  const canonical = `${url}${opts.canonicalPath}`;
  const totalPages = Math.max(1, Math.ceil(opts.total / opts.pageSize));
  const page = Math.min(Math.max(1, opts.page), totalPages);
  const pagerBase = opts.pagerBase ?? opts.canonicalPath;

  const itemList = opts.rows.map((r, i) => ({
    "@type": "ListItem",
    position: (page - 1) * opts.pageSize + i + 1,
    url: `${url}/opplevelse/${encodeURIComponent(r.slug)}`,
    name: r.title,
  }));
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: opts.h1,
    description: opts.metaDesc,
    url: canonical,
    inLanguage: "nb-NO",
    isPartOf: { "@type": "WebSite", name: "Opplevagent", url },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: opts.total,
      itemListElement: itemList,
    },
  };
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: opts.crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      ...(c.href ? { item: c.href.startsWith("http") ? c.href : `${url}${c.href}` } : {}),
    })),
  };
  const ldScripts = [collectionLd, breadcrumbLd, ...(opts.extraJsonLd || [])]
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/<\//g, "<\\/")}</script>`)
    .join("\n");

  const crumbHtml = opts.crumbs
    .map((c, i) =>
      i < opts.crumbs.length - 1 && c.href
        ? `<a href="${escapeHtml(c.href)}">${escapeHtml(c.name)}</a><span class="sep">/</span>`
        : `<span aria-current="page">${escapeHtml(c.name)}</span>`
    )
    .join("");

  const grid =
    opts.rows.length > 0
      ? `<div class="grid" role="list">${opts.rows.map((r) => renderCard(r, opts.lang, opts.distanceMap?.get(r.slug))).join("")}</div>`
      : `<div class="empty"><h2>${escapeHtml(opts.emptyTitle || "Ingen opplevelser her ennå")}</h2>
         <p>${escapeHtml(opts.emptyBody || "Vi publiserer nye opplevelser fortløpende. Se alle opplevelser i mellomtiden.")}</p>
         <a class="cta" href="/opplevelser">Se alle opplevelser</a></div>`;

  // Pager — only shown when there's more than one page. rel=prev/next help crawlers.
  let pager = "";
  if (totalPages > 1) {
    const sep = pagerBase.includes("?") ? "&" : "?";
    const prevHref = page > 1 ? `${pagerBase}${sep}page=${page - 1}` : "";
    const nextHref = page < totalPages ? `${pagerBase}${sep}page=${page + 1}` : "";
    pager = `<nav class="pager" aria-label="Sidenavigasjon">
      <a class="btn" href="${escapeHtml(prevHref || "#")}" ${prevHref ? "" : 'aria-disabled="true"'} rel="prev">← Forrige</a>
      <span class="pos">Side ${page} av ${totalPages}</span>
      <a class="btn" href="${escapeHtml(nextHref || "#")}" ${nextHref ? "" : 'aria-disabled="true"'} rel="next">Neste →</a>
    </nav>`;
  }
  const linkRels =
    (page > 1 ? `<link rel="prev" href="${escapeHtml(`${url}${pagerBase}${pagerBase.includes("?") ? "&" : "?"}page=${page - 1}`)}">\n` : "") +
    (page < totalPages ? `<link rel="next" href="${escapeHtml(`${url}${pagerBase}${pagerBase.includes("?") ? "&" : "?"}page=${page + 1}`)}">\n` : "");

  // Per-page branded og:image (dev-request
  // 2026-07-12-opplevagent-serp-innholdsberikelse, item 3) — replaces the
  // domain-wide favicon.svg fallback. renderBrowsePage() is shared by
  // /tilbyder/:id, /kategori/:category, /fylke/:fylke, /kommune/:kommune,
  // /opplevelser, and /sok; opts carries no category-ish field common to all
  // of them, so this shared page type gets the neutral brand-default accent
  // (see resolveOgAccentColor()'s fallback) rather than inventing a new opts
  // field just for this.
  const ogImage = ogImageUrl(url, opts.h1);
  const ogImageAlt = `${opts.h1} | Opplevagent`;

  // See the useSharedChrome/sketchMotif doc comments above — every value
  // below is "" / the pre-existing default when neither opt is passed, so
  // the returned HTML stays byte-identical to before this option existed.
  const chromeCss = opts.useSharedChrome ? OA_CHROME_CSS : "";
  const sketchCss = opts.sketchMotif ? stillSketchCss(opts.sketchMotif) : "";
  const navHtml = opts.useSharedChrome
    ? `<a class="skip-link" href="#main">Hopp til innhold</a>\n${oaSiteNav({ active: opts.navActive })}`
    : BROWSE_NAV;
  const footHtml = opts.useSharedChrome ? oaSiteFooter({}) : browseFooter();
  const stageOpen = opts.sketchMotif ? `<div class="oa-sketch-stage">\n${stillSketchSvg(opts.sketchMotif)}\n` : "";
  const stageClose = opts.sketchMotif ? `\n</div>` : "";

  return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.metaDesc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#0e3c36">
<link rel="canonical" href="${canonical}">
${linkRels}<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags({ includeThemeColor: false })}
<meta property="og:title" content="${escapeHtml(opts.h1)}">
<meta property="og:description" content="${escapeHtml(opts.metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
<meta name="twitter:card" content="summary">
${ldScripts}
<style>${BROWSE_CSS}${sketchCss}${chromeCss}</style>
${opts.map ? `<style>${FYLKE_MAP_CSS}</style>` : ""}
</head>
<body>
${navHtml}
${stageOpen}<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmuler">${crumbHtml}</nav>
  <header class="head${opts.accentColor ? " head-accent" : ""}"${opts.accentColor ? ` style="border-left-color:${opts.accentColor}"` : ""}>
    ${opts.accentColor && opts.accentLabel ? `<p class="head-eyebrow" style="color:${opts.accentColor}"><span class="chip-dot" aria-hidden="true" style="background:${opts.accentColor}"></span>${escapeHtml(opts.accentLabel)}</p>` : ""}
    <h1>${escapeHtml(opts.h1)}</h1>
    ${opts.lede ? `<p class="lede">${escapeHtml(opts.lede)}</p>` : ""}
    <p class="count">${opts.total} ${opts.total === 1 ? "opplevelse" : "opplevelser"}</p>
  </header>
  ${opts.extraTopHtml || ""}
  ${grid}
  ${opts.map ? renderFylkeMapSection(opts.map.fylke, opts.map.points, opts.lang) : ""}
  ${pager}
</main>${stageClose}
${footHtml}
</body>
</html>`;
}

// Parse ?page= into a 1-based page number (defensive; defaults to 1).
function parsePage(q: unknown): number {
  const n = parseInt(String(q ?? "1"), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Kommune chips for a fylke page -- the kommuner *within this fylke* that have a
// live page, so the place hierarchy (Forsiden -> fylke -> kommune) is crawlable
// from listing pages, not only from individual detail pages. Defensive: returns
// an empty string if the DB isn't open or the fylke has no sub-kommuner.
function kommuneChips(fylke: string): string {
  let komm: Array<{ kommune: string; fylke: string | null; count: number }> = [];
  try { komm = listPublishedKommuner().filter((k) => k.fylke === fylke); } catch { komm = []; }
  if (komm.length === 0) return "";
  const chips = komm
    .map((k) => `<a class="chip" href="/kommune/${encodeURIComponent(k.kommune)}">${escapeHtml(k.kommune)} <span class="n">${k.count}</span></a>`)
    .join("");
  return `<div class="chips" role="list" aria-label="Kommuner i ${escapeHtml(fylke)}">${chips}</div>`;
}

// Facet chips (categories + fylker) for the index page top.
function facetChips(): string {
  let cats: Array<{ category: string; count: number }> = [];
  let fylker: Array<{ fylke: string; count: number }> = [];
  try { cats = listPublishedCategories(); } catch { cats = []; }
  try { fylker = listPublishedFylker(); } catch { fylker = []; }
  if (cats.length === 0 && fylker.length === 0) return "";
  // Daniel 2026-08-24: the category chips carry the same colour dot the
  // gårdssalg type chips already use — the colour a visitor picks here is the
  // colour they then see on the cards. Fylke chips stay dotless (a place has
  // no category colour to claim).
  const catChips = cats
    .map((c) => `<a class="chip" href="/kategori/${encodeURIComponent(c.category)}"><span class="chip-dot" aria-hidden="true" style="background:${categoryColor(c.category)}"></span>${escapeHtml(catLabel(c.category))} <span class="n">${c.count}</span></a>`)
    .join("");
  const fylkeChips = fylker
    .map((f) => `<a class="chip" href="/fylke/${encodeURIComponent(f.fylke)}">${escapeHtml(f.fylke)} <span class="n">${f.count}</span></a>`)
    .join("");
  let out = "";
  if (catChips) out += `<div class="chips" role="list" aria-label="Kategorier">${catChips}</div>`;
  if (fylkeChips) out += `<div class="chips" role="list" aria-label="Fylker">${fylkeChips}</div>`;
  return out;
}

const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5 L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info, Goal 1:
// a category/fylke page's search box still posts to the ONE shared /sok
// results page (unchanged), but carries the current category/fylke along as
// a hidden field so /sok knows to GROUP (not filter) its full-catalogue
// matches — hits inside the current category/fylke first, under a distinct
// label, the rest of the catalogue's matches below. Additive: every existing
// caller (searchBox("") — /opplevelser, /kommune/:kommune, the homepage
// hero, and /sok's own re-render of a plain query) passes no boost, so /sok
// renders its old byte-identical flat, ungrouped list whenever the param is
// absent. See splitBoostedRows()/SearchBoostContext below and /sok's own
// handler for the grouping itself.
export type SearchBoostContext = { category?: string; fylke?: string };

function searchBox(currentQ: string, boost?: SearchBoostContext): string {
  const boostHidden = boost?.category
    ? `<input type="hidden" name="category" value="${escapeHtml(boost.category)}">`
    : boost?.fylke
    ? `<input type="hidden" name="fylke" value="${escapeHtml(boost.fylke)}">`
    : "";
  return `<div class="searchbar">
    <form action="/sok" method="GET" role="search" aria-label="Søk i opplevelser">
      <span class="field">${SEARCH_SVG}
        <label for="sok-q" class="skip-link">Søk i opplevelser</label>
        <input id="sok-q" name="q" type="search" autocomplete="off" placeholder="Søk: hvalsafari, Tromsø, mat …" value="${escapeHtml(currentQ)}">
      </span>
      ${boostHidden}
      <button type="submit">Søk</button>
    </form>
  </div>`;
}

// Splits full-catalogue search rows (already returned by
// searchPublishedExperiences(), unfiltered) into the subset that also
// matches the current category/fylke boost context and the rest — NEVER
// drops a row, only reorders which group it's shown under. Absent boost (or
// a boost with neither field set) returns everything as `rest` unchanged, so
// callers that don't pass a boost context render exactly as before this
// feature existed.
function splitBoostedRows(
  rows: ExperienceCardRow[],
  boost: SearchBoostContext | undefined
): { boosted: ExperienceCardRow[]; rest: ExperienceCardRow[] } {
  if (!boost || (!boost.category && !boost.fylke)) return { boosted: [], rest: rows };
  const boosted: ExperienceCardRow[] = [];
  const rest: ExperienceCardRow[] = [];
  for (const r of rows) {
    const inBoost =
      (!!boost.category && r.category === boost.category) ||
      (!!boost.fylke && r.fylke === boost.fylke);
    (inBoost ? boosted : rest).push(r);
  }
  return { boosted, rest };
}

// Renders the two-group boosted layout ("Treff i [kategori/fylke]" then
// "Andre treff i Opplevagent") — see splitBoostedRows() above. A group with
// zero rows renders NOTHING (no empty heading), so a zero-hit category is
// never a dead end: the "Andre treff" group alone still shows the rest of
// the catalogue's matches.
function renderBoostedResultsHtml(
  boosted: ExperienceCardRow[],
  rest: ExperienceCardRow[],
  boost: SearchBoostContext,
  lang: Lang,
  distanceMap: Map<string, { distance_km: number | null; geo_precision: "address" | "kommune" | null }>
): string {
  const boostLabel = boost.category
    ? `Treff i ${catLabel(boost.category)}`
    : `Treff i ${boost.fylke}`;
  const boostedSection =
    boosted.length > 0
      ? `<section class="search-group" aria-label="${escapeHtml(boostLabel)}">
          <h2 class="search-group-label">${escapeHtml(boostLabel)}</h2>
          <div class="grid" role="list">${boosted.map((r) => renderCard(r, lang, distanceMap.get(r.slug))).join("")}</div>
        </section>`
      : "";
  const restLabel = "Andre treff i Opplevagent";
  const restSection =
    rest.length > 0
      ? `<section class="search-group" aria-label="${escapeHtml(restLabel)}">
          <h2 class="search-group-label">${escapeHtml(restLabel)}</h2>
          <div class="grid" role="list">${rest.map((r) => renderCard(r, lang, distanceMap.get(r.slug))).join("")}</div>
        </section>`
      : "";
  return boostedSection + restSection;
}

// ─── GET /opplevelser — paginated index of all published experiences ─────────
router.get("/opplevelser", (req: Request, res: Response) => {
  const page = parsePage(req.query.page);
  let total = 0;
  let rows: ExperienceCardRow[] = [];
  try {
    total = countPublishedExperiences();
    rows = listPublishedExperiences({}, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch { total = 0; rows = []; }

  const html = renderBrowsePage({
    lang: req.lang,
    title: "Alle opplevelser | Opplevagent",
    h1: "Alle opplevelser",
    metaDesc:
      "Bla i alle håndplukkede norske opplevelser på Opplevagent — hvalsafari, trehytter, guidede turer, mat og mer. Tilbydere verifisert mot Brønnøysundregistrene.",
    lede: "Håndplukket oversikt over norske opplevelser og aktiviteter. Filtrer på kategori eller fylke, eller søk fritt.",
    canonicalPath: "/opplevelser",
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser" }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox("") + facetChips(),
    emptyTitle: "Ingen publiserte opplevelser ennå",
    emptyBody: "Vi verifiserer og publiserer nye opplevelser fortløpende. Kom gjerne tilbake snart.",
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 3
    // (delt header/footer): /opplevelser adopts the shared S1 chrome (hamburger
    // nav + full footer incl. "For tilbydere"). "opplevelser" is the exact
    // oaSiteNav() item for this page.
    useSharedChrome: true,
    navActive: "opplevelser",
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// Drink-type → { label, color } map — hoisted to module scope (2026-06-29 UI
// spec) so every gårdssalg surface (category cards, booking panel badge, and
// the produsent profile hero below) shares one color-coding source of truth.
const DRINK_TYPE_META: Record<string, { label: string; color: string }> = {
  bryggeri:   { label: "Bryggeri",  color: "#c58a2a" },
  cideri:     { label: "Sider",     color: "#4a8c3f" },
  sideri:     { label: "Sider",     color: "#4a8c3f" },
  mjøderi:    { label: "Mjød",      color: "#7c5cbb" },
  vingård:    { label: "Fruktvin",  color: "#c0577c" },
  destilleri: { label: "Destillat", color: "#6c6c6c" },
  seltzeri:   { label: "Kombucha",  color: "#2a7d9c" },
};
function drinkTypeMeta(producerType: string | null): { label: string; color: string } | null {
  return producerType ? DRINK_TYPE_META[producerType.toLowerCase()] ?? null : null;
}

// Drink-type badge for a gårdssalg provider card — hoisted to module scope
// (was a closure inside the /kategori/gardssalg handler) so the booking panel
// route below can render the same badge.
function drinkBadge(producerType: string | null): string {
  const entry = drinkTypeMeta(producerType);
  if (!entry) return "";
  return `<span style="display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.04em;
    text-transform:uppercase;padding:2px 8px;border-radius:4px;
    background:${entry.color}1a;color:${entry.color};border:1px solid ${entry.color}44">${entry.label}</span>`;
}

// dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, arbeidspunkt 4:
// the /kategori/gardssalg Leaflet map. Reuses the fylke map's self-hosted
// Leaflet routes (/leaflet/*, untouched), tile source (same OSM XYZ tiles),
// and FYLKE_MAP_CSS verbatim (its class names — .map-section/.fylke-map/
// .map-popup/etc — are already generic, not fylke-specific, so it's included
// as-is below rather than copied). The init script/marker JSON shape below
// is a SEPARATE, parallel copy of FYLKE_MAP_INIT_JS/renderFylkeMapSection
// rather than a shared refactor of them — this dev-request's own
// instructions are to leave /fylke/:fylke's code path untouched, and that
// code is already pinned by its own tests (kart-01..11), so generalizing it
// would mean editing reviewed, test-pinned code for a marginal DRY win. The
// genuinely expensive-to-duplicate parts (CSS, tile source, self-hosted
// Leaflet asset routes) ARE reused as-is; only the small
// marker-shape/init-script glue is duplicated.
type GardssalgMapMarker = {
  slug: string;
  navn: string;
  producerTypeLabel: string | null;
  sted: string | null;
  lat: number;
  lon: number;
  approx: boolean;
};

// geocode_confidence → marker precision. 'high'/'medium'/'low' are Step A's
// real address-level Kartverket geocodes (experiences-geocode-worker.ts) —
// rendered as a normal/exact marker, same as geo_precision==='address' on
// the fylke map. Everything else — 'approximate' (Step D's kommune/fylke-
// centroid fallback), 'no_match' (excluded upstream by
// listGardssalgProviderMapPoints()'s lat/lon predicate — never reaches
// here), null, or any future/unrecognized value — defaults to the SAME
// dashed/approx marker + "Ca. posisjon (kommune)" popup note the fylke map
// uses for geo_precision==='kommune', and the SAME
// geocode_confidence==='approximate' check the produsent-profil map block
// already uses (~line 2984) — three independent surfaces reading this one
// column the same honest way. The inverted "default to approximate unless
// provably exact" direction is deliberate: an unrecognized confidence tag
// must never silently render as an exact address.
function isApproxGardssalgConfidence(confidence: string | null): boolean {
  return confidence !== "high" && confidence !== "medium" && confidence !== "low";
}

const GARDSSALG_MAP_INIT_JS = `(function () {
  var mapEl = document.getElementById('gardssalg-map');
  var dataEl = document.getElementById('gardssalg-map-data');
  if (!mapEl || !dataEl) return;
  var points = [];
  try { points = JSON.parse(dataEl.textContent || '[]'); } catch (e) { points = []; }
  if (!points.length) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  ${MAP_CLUSTER_JS}

  var leafletLoading = null;
  function loadLeaflet() {
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/leaflet/leaflet.css';
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = '/leaflet/leaflet.js';
      script.addEventListener('load', function () { resolve(); });
      script.addEventListener('error', function () { reject(new Error('leaflet-load-failed')); });
      document.body.appendChild(script);
    });
    return leafletLoading;
  }

  function initMap() {
    loadLeaflet().then(function () {
      if (typeof L === 'undefined') return;
      mapEl.textContent = '';
      var map = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragsytere'
      }).addTo(map);

      var addressIcon = L.icon({
        iconUrl: '/leaflet/images/marker-icon.png',
        iconRetinaUrl: '/leaflet/images/marker-icon-2x.png',
        shadowUrl: '/leaflet/images/marker-shadow.png',
        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
      });

      // Bounds are computed from the RAW, unclustered points — fitBounds
      // must always cover the true full extent regardless of how markers
      // end up visually grouped below.
      var bounds = [];
      points.forEach(function (p) { bounds.push([p.lat, p.lon]); });

      // arbeidspunkt 6: cluster the SAME already-injected points (no new
      // fetch) before rendering markers. Each point keeps a reference back
      // to its original object (\`orig\`) so popups/links render exactly the
      // same per-point content as before this feature existed.
      var clusterInput = points.map(function (p) {
        return { lat: p.lat, lon: p.lon, approx: !!p.approx, orig: p };
      });
      var clusterGroups = clusterMapPoints(clusterInput);
      var anyRealCluster = false;

      clusterGroups.forEach(function (g) {
        if (g.members.length < MAP_CLUSTER_MIN_SIZE) {
          var p = g.members[0].orig;
          var marker = p.approx
            ? L.circleMarker([p.lat, p.lon], { radius: 9, weight: 2, color: '#c2570c', dashArray: '3,3', fillColor: '#f5a623', fillOpacity: 0.55 })
            : L.marker([p.lat, p.lon], { icon: addressIcon });
          var metaBits = [];
          if (p.producerTypeLabel) metaBits.push(esc(p.producerTypeLabel));
          if (p.sted) metaBits.push(esc(p.sted));
          var popupHtml = '<div class="map-popup"><strong>' + esc(p.navn) + '</strong>'
            + (metaBits.length ? '<span class="map-popup-meta">' + metaBits.join(' · ') + '</span>' : '')
            + (p.approx ? '<span class="map-popup-approx">Ca. posisjon (kommune)</span>' : '')
            + '<a href="/kategori/gardssalg/produsent/' + encodeURIComponent(p.slug) + '">Se produsentprofil →</a></div>';
          marker.bindPopup(popupHtml);
          marker.addTo(map);
        } else {
          anyRealCluster = true;
          var clusterClass = g.approx ? 'cluster-approx' : 'cluster-exact';
          var clusterIcon = L.divIcon({
            className: 'map-cluster-icon',
            html: '<div class="cluster-bubble ' + clusterClass + '">' + g.members.length + '</div>',
            iconSize: [32, 32]
          });
          var clusterMarker = L.marker([g.lat, g.lon], { icon: clusterIcon });
          var itemsHtml = g.members.map(function (m) {
            return '<li><a href="/kategori/gardssalg/produsent/' + encodeURIComponent(m.orig.slug) + '">' + esc(m.orig.navn) + '</a></li>';
          }).join('');
          var clusterPopupHtml = '<div class="map-popup"><strong>' + g.members.length + ' produsenter her</strong>'
            + (g.approx ? '<span class="map-popup-approx">Ca. posisjon (kommune) for alle punktene i denne klyngen</span>' : '')
            + '<ul class="map-popup-cluster-list">' + itemsHtml + '</ul></div>';
          clusterMarker.bindPopup(clusterPopupHtml);
          clusterMarker.addTo(map);
        }
      });

      if (anyRealCluster) {
        var clusterNote = document.createElement('p');
        clusterNote.className = 'map-cluster-note';
        clusterNote.textContent = 'Tall i sirkel = antall punkter samlet på ett sted (klynget for lesbarhet).';
        mapEl.parentNode.insertBefore(clusterNote, mapEl.nextSibling);
      }

      if (bounds.length === 1) {
        map.setView(bounds[0], 12);
      } else {
        map.fitBounds(bounds, { padding: [28, 28] });
      }
    }).catch(function () {
      mapEl.innerHTML = '<p class="map-loading">Kartet kunne ikke lastes.</p>';
    });
  }

  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          obs.disconnect();
          initMap();
        }
      });
    }, { rootMargin: '200px 0px' });
    obs.observe(mapEl);
  } else {
    initMap();
  }
})();`;

// Renders the /kategori/gardssalg map section — legend + map container +
// attribution + <noscript> OSM-search fallback + JSON data island + deferred
// lazy-init script, same shape/discipline as renderFylkeMapSection(). Returns
// "" when there are no geocoded providers (honest omission — never an empty/
// broken map, same as the fylke map's zero-points case). Tile source: the
// SAME OSM {s}.tile.openstreetmap.org raster tiles the fylke map already
// uses (no new third-party network host).
function renderGardssalgMapSection(points: GardssalgProviderMapPoint[]): string {
  if (points.length === 0) return "";
  const markers: GardssalgMapMarker[] = points.map((p) => ({
    slug: p.slug,
    navn: p.navn,
    producerTypeLabel: drinkTypeMeta(p.producer_type)?.label ?? null,
    sted: [p.poststed, p.kommune, p.fylke].find((v) => !!v) ?? null,
    lat: p.lat,
    lon: p.lon,
    approx: isApproxGardssalgConfidence(p.geocode_confidence),
  }));
  const dataJson = JSON.stringify(markers).replace(/<\//g, "<\\/");
  const exactCount = markers.filter((m) => !m.approx).length;
  const approxCount = markers.length - exactCount;
  // Simple name-based OSM search link (same honesty rationale as the fylke
  // map's <noscript> link — a computed centroid over scattered producers
  // could misleadingly read as "the exact position", which isn't a real
  // point; a name search is honest about what it is).
  const osmSearchUrl = "https://www.openstreetmap.org/search?query=" + encodeURIComponent("gårdssalg, Norge");

  return `<section class="map-section" aria-labelledby="gardssalg-map-h">
    <h2 id="gardssalg-map-h">Kart over produsenter</h2>
    <p class="map-legend">${exactCount > 0 ? `<span><span class="dot dot-address" aria-hidden="true"></span>Nøyaktig posisjon</span>` : ""}${approxCount > 0 ? `<span><span class="dot dot-kommune" aria-hidden="true"></span>Ca. posisjon (kommune)</span>` : ""}</p>
    <div id="gardssalg-map" class="fylke-map" role="group" aria-label="Kart over ${markers.length} ${markers.length === 1 ? "produsent" : "produsenter"}"><p class="map-loading">Kartet lastes når du scroller hit …</p></div>
    <p class="map-attribution-note">Kartdata © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragsytere</p>
    <noscript><p class="map-noscript"><a href="${escapeHtml(osmSearchUrl)}" target="_blank" rel="noopener">Åpne kart over gårdssalgprodusenter i OpenStreetMap →</a></p></noscript>
    <script type="application/json" id="gardssalg-map-data">${dataJson}</script>
    <script>${GARDSSALG_MAP_INIT_JS}</script>
  </section>`;
}

// ─── Single-entity mini-map (dev-request 2026-07-19-opplevagent-kart-fylke-
// gardssalg, arbeidspunkt 5) ──────────────────────────────────────────────
// The "Sted" card on /opplevelse/:slug and on the gårdssalg produsent-profil
// page each show exactly ONE point (never multiple markers — that's what
// distinguishes this from the /fylke and /kategori/gardssalg maps above).
// Self-contained CSS/JS block shared by BOTH of those pages (they don't share
// a <style>/<script> bundle with each other or with the browse pages above —
// each is server-rendered independently — so a shared const here means the
// source has this logic ONCE, even though each page still inlines its own
// copy at render time, same discipline as FYLKE_MAP_CSS/GARDSSALG_MAP_INIT_JS
// above). Neither of the two call sites is touched here — this only adds new
// code; renderFylkeMapSection/renderGardssalgMapSection above are untouched.
const MINI_MAP_CSS = `
  .mini-map-wrap{margin-top:2px}
  .mini-map-legend{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:.8rem;color:var(--ink-soft)}
  .mini-map-legend .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#f5a623;border:1.5px dashed #c2570c}
  .mini-map{width:100%;height:200px;border-radius:var(--r-md);border:1px solid var(--line);background:var(--canvas-2);position:relative;overflow:hidden;z-index:0}
  .mini-map .map-loading{margin:0;padding:14px;color:var(--mist);font-size:.84rem}
  .mini-map-attribution{font-size:.74rem;color:var(--mist);margin-top:6px}
  .mini-map-attribution a{color:var(--ink-soft)}
  .map-popup{font-size:.86rem;line-height:1.45;min-width:140px}
  .map-popup strong{display:block;font-size:.9rem;color:var(--ink);margin-bottom:2px}
  .map-popup .map-popup-approx{display:block;color:#c2570c;font-weight:700;font-size:.76rem;margin-top:4px}
`;

// A single point's data as sent to the client — same "server pre-resolves
// everything, client does zero business logic" discipline as
// FylkeMapMarker/GardssalgMapMarker. `approx` is already the resolved
// boolean (geo_precision==='kommune' for experiences,
// isApproxGardssalgConfidence() for provider-sourced points) — the client
// never re-derives precision honesty.
type MiniMapPoint = {
  lat: number;
  lon: number;
  approx: boolean;
  label: string;
};

// Lazy-init script for a single-point mini-map — same self-hosted-Leaflet,
// IntersectionObserver-lazy-load, dashed-amber-circleMarker-for-approximate
// discipline as FYLKE_MAP_INIT_JS/GARDSSALG_MAP_INIT_JS above, simplified to
// one point (setView instead of fitBounds; no "see full profile" popup link
// — the popup already IS on that entity's own page, so a self-link would be
// pointless).
const MINI_MAP_INIT_JS = `(function () {
  var mapEl = document.getElementById('mini-map');
  var dataEl = document.getElementById('mini-map-data');
  if (!mapEl || !dataEl) return;
  var point = null;
  try { point = JSON.parse(dataEl.textContent || 'null'); } catch (e) { point = null; }
  if (!point || typeof point.lat !== 'number' || typeof point.lon !== 'number') return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var leafletLoading = null;
  function loadLeaflet() {
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/leaflet/leaflet.css';
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = '/leaflet/leaflet.js';
      script.addEventListener('load', function () { resolve(); });
      script.addEventListener('error', function () { reject(new Error('leaflet-load-failed')); });
      document.body.appendChild(script);
    });
    return leafletLoading;
  }

  function initMap() {
    loadLeaflet().then(function () {
      if (typeof L === 'undefined') return;
      mapEl.textContent = '';
      var map = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragsytere'
      }).addTo(map);

      var marker;
      if (point.approx) {
        marker = L.circleMarker([point.lat, point.lon], { radius: 9, weight: 2, color: '#c2570c', dashArray: '3,3', fillColor: '#f5a623', fillOpacity: 0.55 });
      } else {
        var addressIcon = L.icon({
          iconUrl: '/leaflet/images/marker-icon.png',
          iconRetinaUrl: '/leaflet/images/marker-icon-2x.png',
          shadowUrl: '/leaflet/images/marker-shadow.png',
          iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
        });
        marker = L.marker([point.lat, point.lon], { icon: addressIcon });
      }
      var popupHtml = '<div class="map-popup"><strong>' + esc(point.label) + '</strong>'
        + (point.approx ? '<span class="map-popup-approx">Ca. posisjon (kommune)</span>' : '')
        + '</div>';
      marker.bindPopup(popupHtml);
      marker.addTo(map);
      map.setView([point.lat, point.lon], 13);
    }).catch(function () {
      mapEl.innerHTML = '<p class="map-loading">Kartet kunne ikke lastes.</p>';
    });
  }

  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          obs.disconnect();
          initMap();
        }
      });
    }, { rootMargin: '200px 0px' });
    obs.observe(mapEl);
  } else {
    initMap();
  }
})();`;

// Renders the "Sted" card's mini-map for a single-entity detail page —
// legend (only when approx) + map container + attribution + <noscript>
// fallback + JSON data island + deferred lazy-init script. `osmLinkHtml` is
// the caller's pre-existing `<a class="map-card" ...>` OSM-link markup,
// embedded verbatim inside <noscript> so JS-disabled visitors keep exactly
// the link they had before this feature existed (acceptance criterion 4).
// Callers are responsible for the lat/lon !== null guard — this function
// assumes it already has a real point (same convention as
// renderFylkeMapSection/renderGardssalgMapSection assuming a non-empty
// points array).
function renderMiniMapSection(point: MiniMapPoint, osmLinkHtml: string): string {
  const dataJson = JSON.stringify(point).replace(/<\//g, "<\\/");
  return `<div class="mini-map-wrap">
    ${point.approx ? `<p class="mini-map-legend"><span class="dot" aria-hidden="true"></span>Ca. posisjon (kommune)</p>` : ""}
    <div id="mini-map" class="mini-map" role="group" aria-label="Kart over ${escapeHtml(point.label)}"><p class="map-loading">Kartet lastes når du scroller hit …</p></div>
    <p class="mini-map-attribution">Kartdata © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragsytere</p>
    <noscript>${osmLinkHtml}</noscript>
    <script type="application/json" id="mini-map-data">${dataJson}</script>
    <script>${MINI_MAP_INIT_JS}</script>
  </div>`;
}

// ─── GET /kategori/gardssalg(/:typeSlug) — Gårdssalg & smaking provider
//     catalog + indexable per-drink-type subpages ───────────────────────────
// Gardssalg shows experience_providers (drink producers), not experiences.
// The generic /kategori/:category route queries the experiences table and returns
// 404 when count=0 — this special handler intercepts "gardssalg" before that.
// Rendered as a paginated provider listing reusing the opplevagent brand/CSS.
//
// dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S3: the
// former inline /kategori/gardssalg handler body is refactored into the shared
// renderGardssalgCatalogPage() below so the base catalog («Alle») and the
// /kategori/gardssalg/<typeSlug> subpages render through ONE code path. Base
// output stays byte-near its pre-S3 form — the only additions are the
// searchBox (category-boosted, same as /kategori/:category pages) and the
// type-chips row. Type pages get their own title/metaDesc/canonical/lede and
// a filtered grid + map, and return null (→ route next()s to the 404) for an
// unknown slug or an empty type, so no thin/empty type page is ever indexable.

// Type-filter chips row — plain, indexable <a> links (no JS), shown on the
// base catalog AND every type page. «Alle» → the base catalog; one chip per
// canonical GARDSSALG_TYPE_PAGES slug whose aggregated live count > 0 (counts
// from countGardssalgProvidersByType()'s raw rows, aggregated over each
// page's producerTypes spellings). The active chip carries aria-current="page"
// + the filled .chip-active style (both already in BROWSE_CSS — reused, not
// copied). NULL-producer_type rows count toward «Alle»'s total only — they
// have no honest type, so they never inflate any type chip.
export function renderGardssalgTypeChips(
  activeSlug: string | null,
  typeCounts: Array<{ producer_type: string | null; count: number }>
): string {
  if (!typeCounts || typeCounts.length === 0) return "";
  const bySlug = new Map<string, number>();
  let total = 0;
  for (const row of typeCounts) {
    if (!row || !Number.isFinite(row.count) || row.count <= 0) continue;
    total += row.count;
    const raw = row.producer_type ? row.producer_type.toLowerCase() : "";
    if (!raw) continue; // NULL-type rows: «Alle» only
    for (const [slug, def] of Object.entries(GARDSSALG_TYPE_PAGES)) {
      if (def.producerTypes.includes(raw)) {
        bySlug.set(slug, (bySlug.get(slug) ?? 0) + row.count);
        break;
      }
    }
  }
  // Daniel 2026-08-24, punkt 4: the filter chips carry the same per-type
  // colour dot the homepage drikkested chips already use (one source:
  // DRINK_TYPE_META via drinkTypeMeta()), so the colour a visitor picks in
  // the filter row is the colour they then see on the cards below. «Alle»
  // has no type and stays dotless.
  function chip(href: string, label: string, count: number, active: boolean, color?: string | null): string {
    const dot = color
      ? `<span aria-hidden="true" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:7px;vertical-align:baseline"></span>`
      : "";
    return `<a class="chip${active ? " chip-active" : ""}"${active ? ' aria-current="page"' : ""} href="${href}">${dot}${escapeHtml(label)} <span class="n">${count}</span></a>`;
  }
  const chips: string[] = [chip("/kategori/gardssalg", "Alle", total, activeSlug === null)];
  for (const [slug, def] of Object.entries(GARDSSALG_TYPE_PAGES)) {
    const count = bySlug.get(slug) ?? 0;
    if (count <= 0) continue;
    const color = drinkTypeMeta(def.producerTypes[0] ?? null)?.color ?? null;
    chips.push(chip(`/kategori/gardssalg/${slug}`, def.label, count, activeSlug === slug, color));
  }
  return `<nav class="chips gardssalg-type-chips" aria-label="Filtrer produsenter etter type">${chips.join("")}</nav>`;
}

// dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 4
// (gårdssalg-kort-konsistens), Daniel's design review finding 2: many
// provider names carry a "Navn — Sted" display suffix (the same Hanen-import
// convention parseNameLocationSuffix() already parses for corroboration
// matching elsewhere — see admin-agents.ts's reuse of it for the identical
// convention on RFB producer names). Two symptoms this fixes together:
//   - a card whose poststed/kommune/fylke are ALL empty rendered no
//     kommune-etikett at all, even though the name embeds a real place
//     ("Bryggeriet på Hvaler" with no separate label) — the suffix becomes
//     the label instead of being silently dropped.
//   - a card that DOES have poststed/kommune/fylke duplicated the same place
//     in the title too ("Bryggeriet på Hvaler — Hvaler" + etikett "Hvaler").
//
// DEFECT FIX (2026-08-14, independent review, CHANGES-REQUESTED — see
// PR discussion): the FIRST version of this function used the parsed
// suffix as a freestanding label source whenever the row had no
// poststed/kommune/fylke — i.e. exactly the "no structured data" case.
// parseNameLocationSuffix() is documented (its own header) as a low-stakes
// *corroboration* signal ONLY — it treats any " - ", en/em-dash, or
// trailing "(...)" as a location-suffix CANDIDATE, with no check that the
// text is an actual place name. Reviewer repro: a provider named
// "Ren - Ekte Gard" (a hyphenated tagline, not a location) with no DB
// poststed/kommune/fylke had its title silently truncated to "Ren" and
// "Ekte Gard" shown as if it were the kommune-etikett — on the very first
// plausible non-location hyphenated name tried.
//
// Fix (reviewer's option (b), the narrower/safer one): the label ALWAYS
// comes from real DB poststed/kommune/fylke, never from unvalidated parsed
// text. The parsed suffix is used ONLY to decide whether to strip the
// title's "— X" tail, and only when a real DB value CORROBORATES it (i.e.
// the normalised suffix equals one of poststed/kommune/fylke, the same
// normalisation parseNameLocationSuffix() itself applies to location_hint —
// see normaliseHint()). Consequences:
//   - no DB location data at all -> nothing to corroborate against -> title
//     stays exactly as-is (whole name, suffix and all) and NO etikett is
//     shown. Same as this card's behavior before this dev-request touched
//     anything for that case — no false positive, no regression.
//   - DB location data present AND it matches the parsed suffix -> existing
//     good behavior, unchanged: title stripped, etikett = the DB value.
//   - DB location data present but it does NOT match the parsed suffix
//     (e.g. a coincidental hyphen in the name) -> etikett still shows the
//     real DB value, but the title is left untouched (never strip on an
//     unconfirmed guess).
function gardssalgCardTitleAndSted(p: GardssalgProviderRow): { title: string; sted: string } {
  const navn = (p.navn || "").trim();
  const dbFields = [p.poststed, p.kommune, p.fylke];
  const dbSted = dbFields.find((v): v is string => !!v);
  // No real, DB-sourced location data on this row at all -> there is
  // nothing to corroborate a parsed suffix against, so never invent a
  // label from unvalidated parsed text and never strip the title either.
  if (!dbSted) return { title: navn, sted: "" };

  const { core_name, location_hint } = parseNameLocationSuffix(navn);
  if (location_hint) {
    const normalisedHint = normaliseHint(location_hint);
    const hintParts = normalisedHint.split(",").map((s) => s.trim()).filter(Boolean);
    const corroborated = dbFields.some((v) => {
      if (!v) return false;
      const normalisedDbValue = normaliseHint(v);
      if (!normalisedDbValue) return false;
      return hintParts.includes(normalisedDbValue);
    });
    if (corroborated) return { title: core_name, sted: dbSted };
  }
  // Suffix absent, or present but not corroborated by real DB data — the
  // etikett still shows the real DB value, but the title is left untouched.
  return { title: navn, sted: dbSted };
}

function renderGardssalgCatalogPage(opts: { typeSlug?: string | null; page: number }): string | null {
  const typeSlug = opts.typeSlug ?? null;
  const typeDef = typeSlug ? GARDSSALG_TYPE_PAGES[typeSlug] : undefined;
  if (typeSlug && !typeDef) return null; // unknown slug — caller next()s
  const typeFilter = typeDef ? { producerTypes: typeDef.producerTypes } : undefined;
  const page = opts.page;
  const PAGE_SIZE = 24;
  const providers = listGardssalgProviders(PAGE_SIZE, (page - 1) * PAGE_SIZE, typeFilter);
  const total = countGardssalgProviders(typeFilter);
  // Empty type → null (caller next()s to the 404): a zero-provider type page
  // must never be a live, indexable thin page. The BASE catalog deliberately
  // keeps its pre-S3 zero-state render (kg-zero in tests/test.ts).
  if (typeDef && total === 0) return null;
  // dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, arbeidspunkt 4:
  // ALL geocoded producers across every page (not just this page's slice) —
  // same "map shows the whole filtered set, not just the current page" as
  // the fylke map, which is likewise unpaginated (renderPublishedExperienceMapPoints
  // is passed the full fylke filter, not a page slice). Defensive try/catch
  // (same discipline as kommuneChips()/facetChips() elsewhere in this file)
  // so a query hiccup degrades to "no map" rather than a 500 — the provider
  // grid above is the primary content and must never depend on this. On a
  // type page the same optional filter narrows the markers in lockstep with
  // the card grid.
  let mapPoints: GardssalgProviderMapPoint[] = [];
  try { mapPoints = listGardssalgProviderMapPoints(typeFilter); } catch { mapPoints = []; }
  // Chips row (base + type pages) — defensive like the map: a per-type count
  // hiccup degrades to "no chips", never a 500.
  let typeCounts: Array<{ producer_type: string | null; count: number }> = [];
  try { typeCounts = countGardssalgProvidersByType(); } catch { typeCounts = []; }
  const chipsRow = renderGardssalgTypeChips(typeSlug, typeCounts);

  function renderProviderCard(p: GardssalgProviderRow): string {
    const { title, sted } = gardssalgCardTitleAndSted(p);
    const badge = drinkBadge(p.producer_type);
    // Daniel 2026-08-24, punkt 4: «agentkortene er litt anonyme med sin hvite
    // farge — vurder å bruke hver kategorifarge på hele kortet». The card now
    // carries its own drink type's colour (DRINK_TYPE_META, the same single
    // source the badge, the homepage chips and the type chips already read)
    // as a top edge, a border and a soft top-down wash. Deliberately a WASH,
    // not a saturated fill: the four DRINK_TYPE_META hues are chosen for
    // small badges, and body text on a full-strength #4a8c3f / #c0577c card
    // would fall under the contrast bar this codebase holds elsewhere.
    // rfb-seed rows with no producer_type keep the brand teal, so an
    // untyped card is neutral rather than mislabelled by colour.
    const accent = drinkTypeMeta(p.producer_type)?.color ?? "#0f5a50";
    // BEHAVIOR CHANGE (2026-07-02 gårdssalg-book fix): the "Book besøk" CTA
    // points at the new SSR reservation panel (/kategori/gardssalg/book/<slug>)
    // instead of /tilbyder/<slug>. The old /tilbyder/<slug> target 404'd for
    // every gårdssalg provider — those rows have zero linked `experiences`
    // rows, and getPublishedProviderBySlug() requires ≥1 published experience
    // to exist. The CTA gate also changed from "has a hjemmeside URL" to "has
    // a resolvable slug" (i.e. bookable), since bookability — not having a
    // website — is what the button promises.
    // BEHAVIOR CHANGE (2026-07-03 produsent-profil slice): the card's name
    // link now points at the new rich profile page
    // (/kategori/gardssalg/produsent/<slug>) instead of straight at the
    // booking panel — the profile is where a visitor decides whether to book;
    // the "Book besøk" button stays a direct shortcut to the booking panel
    // for anyone who already knows they want to reserve. Both routes resolve
    // via the same getGardssalgProviderBySlug() gate, so they 404/200 in sync.
    const bookHref = p.slug ? `/kategori/gardssalg/book/${encodeURIComponent(p.slug)}` : null;
    const profileHref = p.slug ? `/kategori/gardssalg/produsent/${encodeURIComponent(p.slug)}` : null;
    const nameHtml = profileHref
      ? `<a href="${profileHref}" style="color:inherit;font-weight:700;font-size:1rem;text-decoration:none">${escapeHtml(title)}</a>`
      : `<span style="font-weight:700;font-size:1rem">${escapeHtml(title)}</span>`;
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
    // 4, Daniel's design review finding 4: the "Book besøk" CTA led to a
    // paused (dark-launch) booking form for every provider not yet
    // booking_live — same isBookingPaused() source (never a new parallel
    // check) and same class-naming convention (a neutral "…-paused" class
    // instead of the active fill) already shipped on the produsent-profil
    // page's own reserve-CTA (arbeidspunkt 5, PR #571's .reserve-cta-paused).
    // Distinct from the 2026-08-09 "positive markers only" decision above —
    // that was about the badge/marker row, not this button's own label.
    const bookingPaused = isBookingPaused(p.booking_live, p.catalog_hidden);
    // The paused CTA keeps its OUTLINE-vs-FILL distinction from the active
    // one (that is what stops it looking bookable while it isn't — see
    // .gs-card-cta-paused's own comment); punkt 4 only swaps its flat grey
    // for the card's own colour, so a grid of not-yet-activated producers
    // stops reading as a grid of disabled buttons.
    const link = bookHref
      ? `<a href="${bookHref}" class="${bookingPaused ? "gs-card-cta-paused" : "gs-card-cta"}"${bookingPaused ? ` style="background:#fff;border-color:${accent}66;color:${accent}"` : ""}>${bookingPaused ? "Meld interesse" : "Book besøk"}</a>`
      : "";
    // Cards carry POSITIVE markers only (dev-request 2026-08-09-gardssalg-
    // kommer-snart-fjernes-eier-aktivert-booking, AC5 options — Daniel
    // in-session 2026-08-09): the paused state stays off the cards (the
    // "Kommer snart" chip removal from the same dev-request), so a marker
    // here always asserts something currently true — booking genuinely
    // works (same isBookingPaused() source as every other surface; the
    // hidden test provider never reaches this renderer, the list query
    // filters catalog_hidden=1) / the owner has verified the profile (same
    // historical claimed_at basis as the profile page's badge). Rendered as
    // their own wrap-safe flex row UNDER the type badge — never inline
    // after the name, which is exactly the wrapping mess the old chip made.
    const cardMarkers: string[] = [];
    if (!bookingPaused) {
      cardMarkers.push(`<span style="display:inline-block;font-size:.7rem;font-weight:700;color:#fff;background:#0f5a50;border-radius:4px;padding:2px 8px">Booking tilgjengelig</span>`);
    }
    if (p.claimed_at != null) {
      cardMarkers.push(`<span style="display:inline-block;font-size:.7rem;font-weight:600;color:#0f5a50;background:#fff;border:1px solid #0f5a50;border-radius:4px;padding:2px 7px">&#10003; Eier-bekreftet</span>`);
    }
    const markerRow = cardMarkers.length
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${cardMarkers.join("")}</div>`
      : "";
    return `<article style="background:linear-gradient(180deg,${accent}1f 0%,${accent}08 55%,#fff 100%);border:1px solid ${accent}3d;border-top:5px solid ${accent};border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);overflow:hidden;display:flex;flex-direction:column">
  <div style="padding:16px 16px 12px">
    ${sted ? `<div style="font-size:.78rem;color:#7a7163;margin-bottom:4px">${escapeHtml(sted)}</div>` : ""}
    <div style="margin-bottom:6px">${nameHtml}</div>
    ${badge}${markerRow}
  </div>
  ${link ? `<div style="padding:0 16px 16px;margin-top:auto">${link}</div>` : ""}
</article>`;
  }

  const cards = providers.map(renderProviderCard).join("\n");
  const emptyMsg = total === 0
    ? `<p style="color:#544a3e;margin:40px 0">Ingen drikkeprodusenter er lagt til ennå — kom tilbake snart.</p>`
    : "";

  // Pagination stays on the current page's own path — a type page paginates
  // /kategori/gardssalg/<slug>?page=N, never leaks back to the base catalog.
  const pagePath = typeSlug ? `/kategori/gardssalg/${typeSlug}` : "/kategori/gardssalg";
  const paginationLinks: string[] = [];
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (page > 1) paginationLinks.push(`<a href="${pagePath}?page=${page - 1}">← Forrige</a>`);
  if (page < totalPages) paginationLinks.push(`<a href="${pagePath}?page=${page + 1}">Neste →</a>`);
  const pagination = paginationLinks.length ? `<nav style="margin:32px 0;display:flex;gap:16px">${paginationLinks.join("")}</nav>` : "";

  const url = "https://opplevagent.no";
  const canonical = `${url}${pagePath}`;
  const pageTitle = typeDef ? typeDef.title : "Gårdssalg og smaking | Opplevagent";
  const metaDesc = typeDef
    ? typeDef.metaDesc
    : "Besøk lokale drikkeprodusenter — bryggeri, sideri, mjød og mer. Book en smaking eller omvisning rett hos produsenten.";
  // Type-page h1 = the <title> minus the brand suffix; base keeps its
  // pre-S3 hero copy byte-identically.
  const heroH1 = typeDef ? typeDef.title.replace(/ \| Opplevagent$/, "") : "Lokale drikkeprodusenter";
  // Answer-first lede (GEO discipline, same pattern as
  // buildCategoryAnswerFirstOpening()): the type page opens by stating the
  // LIVE count upfront — total here is the real filtered count (>0, gated
  // above), never a canned number.
  const heroSub = typeDef
    ? typeDef.lede(total)
    : "Besøk bryggeri, sideri, mjøderi og mer — book en smaking eller omvisning rett hos produsenten.";
  // JSON-LD: the base page keeps its pre-S3 single CollectionPage blob
  // byte-identically; type pages get their own CollectionPage + a
  // BreadcrumbList mirroring the visible breadcrumb.
  const jsonLd = typeDef
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: heroH1,
        description: metaDesc,
        url: canonical,
      })}</script>
<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Forsiden", item: `${url}/` },
          { "@type": "ListItem", position: 2, name: "Gårdssalg og smaking", item: `${url}/kategori/gardssalg` },
          { "@type": "ListItem", position: 3, name: typeDef.label, item: canonical },
        ],
      })}</script>`
    : `<script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"Gårdssalg og smaking","description":"Lokale drikkeprodusenter med gårdsbesøk og smaking","url":"${url}/kategori/gardssalg"}</script>`;
  const breadcrumb = typeDef
    ? `<a href="/">Forsiden</a> · <a href="/opplevelser">Alle opplevelser</a> · <a href="/kategori/gardssalg">Gårdssalg og smaking</a> · ${escapeHtml(typeDef.label)}`
    : `<a href="/">Forsiden</a> · <a href="/opplevelser">Alle opplevelser</a> · Gårdssalg og smaking`;
  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<link rel="canonical" href="${canonical}">
${pwaHeadTags()}
${jsonLd}
<style>
${BROWSE_CSS}
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;margin-top:24px}
@media(max-width:560px){.provider-grid{grid-template-columns:1fr}}
/* dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 4:
   .gs-card-cta keeps the pre-existing active "Book besøk" styling verbatim
   (was inline); .gs-card-cta-paused mirrors the produsent-profil page's own
   .reserve-cta-paused convention (arbeidspunkt 5, PR #571) — a neutral,
   non-gradient style for "Meld interesse" so the button never looks bookable
   while it isn't. */
.gs-card-cta{display:inline-block;margin-top:10px;padding:8px 16px;background:var(--fjord-700);color:#fff;border-radius:6px;font-size:.84rem;font-weight:600;text-decoration:none}
.gs-card-cta:hover{text-decoration:none}
.gs-card-cta-paused{display:inline-block;margin-top:10px;padding:8px 16px;background:var(--canvas-2);color:var(--ink-soft);border:1px solid var(--line);border-radius:6px;font-size:.84rem;font-weight:600;text-decoration:none}
.gs-card-cta-paused:hover{text-decoration:none;background:var(--line)}
.hero-section{position:relative;overflow:hidden;background:linear-gradient(135deg,#0e3c36 0%,#0f5a50 100%);color:#fff;padding:48px 0 40px;margin-bottom:32px}
/* S2: the illustrated drikke scene sits BEHIND the hero copy — same
   z-index technique as the homepage hero (.hero-inner has z-index:1). */
.hero-section>.container{position:relative;z-index:1}
${OA_HERO_SCENE_CSS}
${OA_STILL_SKETCH_CSS}
.hero-kicker{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7;margin-bottom:8px}
.hero-h1{font-size:2rem;font-weight:800;margin-bottom:10px;line-height:1.2}
.hero-sub{opacity:.85;font-size:1rem;max-width:560px;line-height:1.5}
.legal-note{font-size:.78rem;color:#7a7163;margin-top:40px;padding-top:16px;border-top:1px solid #e4ded0}
/* S1 shared chrome (appended AFTER the BROWSE_CSS above on purpose — this
   page is deliberately upgraded from the slim nav/mini-footer to the full
   brand nav + footer; BROWSE_CSS itself is untouched so every other browse
   page keeps rendering exactly as before). */
${OA_CHROME_CSS}
</style>
${mapPoints.length > 0 ? `<style>${FYLKE_MAP_CSS}</style>` : ""}
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
${oaSiteNav({ active: "gardssalg" })}
<header class="hero-section">
  ${heroSceneSvg("drikke")}
  <div class="container">
    <div class="hero-kicker">Gårdssalg &amp; smaking</div>
    <h1 class="hero-h1">${escapeHtml(heroH1)}</h1>
    <p class="hero-sub">${escapeHtml(heroSub)}</p>
  </div>
</header>
<div class="oa-sketch-stage">
${gardssalgStillSketchSvg()}
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmulesti">
    ${breadcrumb}
  </nav>
  ${searchBox("", { category: "gardssalg" })}
  ${chipsRow}
  ${total > 0 ? `<p style="color:#544a3e;font-size:.9rem;margin-top:8px">${total} produsent${total === 1 ? "" : "er"}</p>` : ""}
  ${emptyMsg}
  ${providers.length > 0 ? `<div class="provider-grid">${cards}</div>` : ""}
  ${renderGardssalgMapSection(mapPoints)}
  ${pagination}
  <p class="legal-note">Vi formidler besøket og smakingen hos produsentene. Selve salget skjer hos produsenten, som har egen kommunal bevilling.</p>
</main>
</div>
${oaSiteFooter({})}
</body>
</html>`;
}

router.get("/kategori/gardssalg", (req: Request, res: Response) => {
  // Base catalog never returns null (no typeSlug → neither null path applies).
  const html = renderGardssalgCatalogPage({ page: parsePage(req.query.page) }) as string;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// GET /kategori/gardssalg/:typeSlug — indexable per-drink-type subpage (S3).
// MUST stay registered immediately after the base catalog route above: the
// multi-segment /kategori/gardssalg/(produsent|book|bekreft|svar|gjestesvar|
// status)/… routes below never collide with this single-segment pattern, but
// the generic /kategori/:category and /kategori/:category/:kommune handlers
// further down WOULD otherwise treat e.g. /kategori/gardssalg/bryggeri as
// category="gardssalg"/kommune="bryggeri" — registration order is the guard.
// Alias slugs (raw producer_type spellings) 301 to the canonical URL; unknown
// slugs and empty types next() through to the trailing 404 catch-all.
router.get("/kategori/gardssalg/:typeSlug", (req: Request, res: Response, next: NextFunction) => {
  const raw = String(req.params.typeSlug || "").toLowerCase();
  // Own-property guard: plain-object lookups would otherwise match prototype
  // keys ("constructor", "__proto__") and 301 to garbage instead of 404.
  const aliasTarget = Object.hasOwn(GARDSSALG_TYPE_SLUG_ALIASES, raw)
    ? GARDSSALG_TYPE_SLUG_ALIASES[raw]
    : undefined;
  if (aliasTarget) {
    const page = parsePage(req.query.page);
    res.redirect(301, `/kategori/gardssalg/${aliasTarget}${page > 1 ? `?page=${page}` : ""}`);
    return;
  }
  if (!Object.hasOwn(GARDSSALG_TYPE_PAGES, raw)) return next();
  const html = renderGardssalgCatalogPage({ typeSlug: raw, page: parsePage(req.query.page) });
  if (html === null) return next(); // empty type — 404-guarded, never a thin page
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// ─── Gårdssalg produsentprofil (2026-07-03, Fase 1 of the rike-profiler
//     dev-request) ────────────────────────────────────────────────────────
//
// GET /kategori/gardssalg/produsent/:providerSlug — a rich, sellable profile
// page for one drikkeprodusent, sitting BETWEEN the category listing and the
// booking panel: /kategori/gardssalg (browse) → produsent/<slug> (sell/decide,
// this route) → book/<slug> (reserve, unchanged). Resolves via the exact same
// getGardssalgProviderBySlug() gate as the booking panel, so profile and
// booking 404/200 in lockstep for every provider.
//
// Data-availability note: experience_providers carries navn, hjemmeside,
// sted, contact, and lat/lon — but no season/duration/price_from/capacity
// columns (those live on the `experiences` table, which gårdssalg producers
// have zero rows in — see the block comment below). As of 2026-07-10
// (dev-request 2026-07-03-gardssalg-rike-profiler-bilder-agentbooking, Fase 1
// item 3), experience_providers ALSO carries about_text/visit_text/
// opening_hours_text — real, per-producer copy filled by the multi-page-crawl
// enrichment slice (POST /admin/gardssalg-content-refresh, see
// experience-store.ts's applyGardssalgProviderContent). The "Om produsenten"/
// "Besøket" sections render that real copy when present; for producers not
// yet enriched (columns still NULL/empty), they fall back to the same honest,
// type-general placeholder as before (not a fabricated specific claim about
// any one producer — keeps the faithfulness guard's spirit). The
// practical-info table only ever renders rows it has real data for.
// 2026-08-12 (arbeidspunkt 5 of dev-request
// 2026-07-19-opplevagent-forside-seksjoner-design): collapse consecutive
// duplicate values (case-insensitive, trimmed) so poststed==kommune (a real
// live bug — e.g. both "Stange") doesn't render "Stange, Stange, Innlandet"
// on the hero subtitle, <title>, meta description, JSON-LD address, and map
// label — every one of which derives from this single function. Only
// ADJACENT duplicates collapse (matching the field order poststed → kommune
// → fylke, where a real duplicate is always the neighbor), so this stays a
// narrow fix for the exact observed bug, not a general dedup of the trio.
function drivingSted(p: GardssalgProviderRow): string {
  const parts = [p.poststed, p.kommune, p.fylke].filter(Boolean) as string[];
  const deduped = parts.filter((part, i) => {
    if (i === 0) return true;
    return part.trim().toLowerCase() !== parts[i - 1].trim().toLowerCase();
  });
  return deduped.join(", ");
}

// Generic, type-general "what a visit typically includes" copy — intentionally
// NOT phrased as a verified fact about the specific producer (no per-producer
// source yet), just an honest orientation until real content lands.
const VISIT_TYPE_COPY: Record<string, string> = {
  bryggeri: "en omvisning i bryggeriet og en smaking av deres øl",
  cideri: "en smaking av sider, gjerne med et innblikk i fruktdyrkingen bak",
  sideri: "en smaking av sider, gjerne med et innblikk i fruktdyrkingen bak",
  mjøderi: "en smaking av mjød og et innblikk i mjødhåndverket",
  vingård: "en smaking av fruktvin og en tur i vingården/frukthagen",
  destilleri: "en omvisning og en smaking av destillater",
  seltzeri: "en smaking av kombucha og et innblikk i produksjonen",
};

// dev-request 2026-08-06-eier-ser-reserver-knapp-paa-egen-profil: pure
// decision function for the client-side owner-CTA swap below. This page is
// public/shared-cacheable (`Cache-Control: public, max-age=300` a few lines
// down) so the server-rendered HTML must NOT branch on the request's
// session cookie — any downstream cache stores ONE response body per URL,
// and a cookie-dependent render would leak one owner's edit-CTA to other
// visitors of the same cached URL. So "Reserver besøk" is always rendered
// exactly as today, and the swap happens client-side, after load, via a
// fetch() to the separate `Cache-Control: no-store`
// GET /api/opplevelser/gardssalg-claim/:providerId/session-status endpoint
// (src/routes/gardssalg-claim.ts) that DOES know the viewer's session.
//
// `decideOwnerCtaSwap` is pure (no DOM/fetch) so it's unit-testable
// directly in Node, and is shipped to the browser via
// `decideOwnerCtaSwap.toString()` in the inline <script> below — same
// tested-code-is-shipped-code pattern as `describeSaveOutcome` in
// gardssalg-claim.ts (PR #492). Must stay dependency-free for that to work.
// Fails closed: any falsy/malformed input (fetch failed, non-JSON body,
// isOwner not exactly `true`) returns `{ swap: false }` — the page keeps
// its server-rendered "Reserver besøk", never a broken/wrong swap.
export function decideOwnerCtaSwap(
  ok: boolean,
  body: any,
  portalHref: string,
  previewHref: string,
): { swap: boolean; primaryLabel?: string; primaryHref?: string; secondaryLabel?: string; secondaryHref?: string } {
  if (!ok || !body || body.isOwner !== true) return { swap: false };
  return {
    swap: true,
    primaryLabel: "Rediger profilen",
    primaryHref: portalHref,
    secondaryLabel: "Forhåndsvis som besøkende",
    secondaryHref: previewHref,
  };
}

router.get(
  "/kategori/gardssalg/produsent/:providerSlug",
  (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.params.providerSlug || "");
    if (!slug) return next();
    ensureProviderSlugs();
    let provider: GardssalgProviderRow | null = null;
    try {
      provider = getGardssalgProviderBySlug(slug);
    } catch {
      provider = null;
    }
    if (!provider) return next();

    const url = baseUrl();
    // dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent: same
    // two-flag model as renderOpplevelseDetail() — chrome labels follow
    // req.lang only while OPPLEVAGENT_LANG_SWITCHER_ENABLED, translated body
    // fields only while PROFILE_TRANSLATIONS_SERVE_ENABLED (and only the
    // fields that actually have a published translation).
    const lang: Lang = req.lang;
    const switcherOn = isOpplevagentLangSwitcherEnabled();
    const uiLang: Lang = switcherOn ? lang : "no";
    const L = oaProfileLabels(uiLang);
    const noPath = `/kategori/gardssalg/produsent/${encodeURIComponent(slug)}`;
    const tr = lang !== "no"
      ? getPublishedProfileTranslations(getExpDbForReise("experiences"), "opplevagent", "provider", String(provider.id), lang)
      : {};
    const canonical = `${url}${switcherOn ? localizedPath(noPath, lang) : noPath}`;
    const bookHref = `/kategori/gardssalg/book/${encodeURIComponent(slug)}`;
    // "Lenk til oss" aside-card (dev-request 2026-07-12-opplevagent-lenkeplan,
    // item 1) — reuses the same absolute `url` computed above (not
    // recomputed) so the badge's backlink always matches this exact
    // provider's canonical profile URL.
    const badgeProfileHref = canonical;
    const badgeEmbedSnippet = opplevagentBadgeEmbedSnippet(slug, url);
    // dev-request 2026-08-03-claim-bekreftet-merke-og-innlogging: this
    // branching now reads the HISTORICAL provider.claimed_at column (set once,
    // idempotently, by verifyClaimToken() — never cleared by a revoke/logout),
    // not the live, revocable isGardssalgProviderClaimed() query (that query
    // still exists for the owner-portal session gate; see gardssalg-claim.ts's
    // doc comment on it). A revoked/expired session must NOT flip this back to
    // "unclaimed" (AC6) — claimed_at means "has been claimed at some point".
    const isClaimed = provider.claimed_at != null;
    // 2026-08-12 (arbeidspunkt 5): computed once, reused by both the
    // reserve-notice AND the reserve-CTA's class/label below so they can
    // never disagree about paused state.
    const bookingPaused = isBookingPaused(provider.booking_live, provider.catalog_hidden);
    const sted = drivingSted(provider);
    const meta = drinkTypeMeta(provider.producer_type);
    const badge = drinkBadge(provider.producer_type);
    const site = safeHttpUrl(provider.hjemmeside);
    const lat = numOrNull(provider.lat);
    const lon = numOrNull(provider.lon);
    // Step D fallback (experiences-geocode-worker.ts): a kommune/fylke
    // centroid, not a real street-address geocode — label it honestly
    // rather than implying exact-address precision. Reuses the SAME
    // isApproxGardssalgConfidence() helper the /kategori/gardssalg map uses
    // (arbeidspunkt 5) instead of a bespoke equality check — a future/
    // unrecognized confidence value must default to approximate here too,
    // not silently render as exact.
    const geoApprox = isApproxGardssalgConfidence(provider.geocode_confidence);

    const metaDesc = L.gsMeta(provider.navn, sted || "");

    // Hero — themed by drink-type color-coding (2026-06-29 UI spec, shared
    // DRINK_TYPE_META also used by drinkBadge()); falls back to the plain
    // gårdssalg teal gradient used on the category page for untyped rows.
    const heroBg = meta
      ? `linear-gradient(135deg,${meta.color} 0%,#0b2e29 75%)`
      : "linear-gradient(135deg,#0e3c36 0%,#0f5a50 100%)";

    // "Om produsenten" — real enriched copy (about_text) when the multi-page-
    // crawl slice has filled it; otherwise the same honest fallback as before
    // (real hjemmeside link when we have one, placeholder copy otherwise).
    //
    // 2026-08-12 (arbeidspunkt 5): a render-guard-only check — content-
    // quality/enrichment ownership is unchanged, this is purely "don't
    // render obviously-broken text regardless of what's in the DB".
    // isJunkDescription() catches scraped nav-boilerplate;
    // looksTruncatedMidWord() catches a raw byte-range scrape slice that
    // begins/ends inside a word (see description-quality.ts). Either one
    // failing means the field is treated as absent, same as today's
    // missing-value fallback.
    const hasRealAbout = !!(provider.about_text && provider.about_text.trim())
      && !isJunkDescription(provider.about_text)
      && !looksTruncatedMidWord(provider.about_text);
    const aboutBody = hasRealAbout
      ? `<p>${escapeHtml(tr.about_text || (provider.about_text as string))}</p>`
      : site
      ? `<p>${escapeHtml(provider.navn)} er en lokal drikkeprodusent${sted ? " i " + escapeHtml(sted) : ""}. Les mer om produsenten og produktene på <a href="${escapeHtml(site)}" target="_blank" rel="noopener nofollow">${escapeHtml(hostOf(site))}</a>.</p>`
      : `<p>${escapeHtml(provider.navn)} er en lokal drikkeprodusent${sted ? " i " + escapeHtml(sted) : ""}. Utfyllende presentasjon publiseres fortløpende.</p>`;

    // "Besøket" — real enriched copy (visit_text) when present; otherwise the
    // existing type-general orientation, explicitly not a per-producer claim.
    // Same dual render-guard as about_text above.
    const visitCopy = provider.producer_type
      ? VISIT_TYPE_COPY[provider.producer_type.toLowerCase()]
      : null;
    const hasRealVisit = !!(provider.visit_text && provider.visit_text.trim())
      && !isJunkDescription(provider.visit_text)
      && !looksTruncatedMidWord(provider.visit_text);
    const visitBody = hasRealVisit
      ? `<p>${escapeHtml(tr.visit_text || (provider.visit_text as string))}</p>`
      : visitCopy
      ? `<p>Et besøk hos ${escapeHtml(provider.navn)} inkluderer typisk ${visitCopy}. Nøyaktig program avtales ved reservasjon.</p>`
      : `<p>Detaljer om hva besøket hos ${escapeHtml(provider.navn)} inneholder, publiseres fortløpende. Book et besøk for å avtale program direkte med produsenten.</p>`;

    // Practical info — only rows we actually have data for. Sesong/varighet/
    // pris/kapasitet are NOT yet columns on experience_providers (see comment
    // above the route) so they are intentionally omitted rather than guessed.
    const facts: Array<[string, string]> = [];
    if (sted) facts.push([L.place, escapeHtml(sted)]);
    if (provider.adresse) facts.push([L.gsAddress, escapeHtml(provider.adresse)]);
    if (
      provider.opening_hours_text && provider.opening_hours_text.trim()
      && !isJunkDescription(provider.opening_hours_text)
      && !looksTruncatedMidWord(provider.opening_hours_text)
    ) facts.push([L.gsHours, escapeHtml(tr.opening_hours_text || provider.opening_hours_text)]);
    if (site) facts.push([L.gsSite, `<a href="${escapeHtml(site)}" target="_blank" rel="noopener nofollow">${escapeHtml(hostOf(site))}</a>`]);
    if (isDisplayablePhone(provider.telefon)) facts.push([L.phone, `<a href="tel:${escapeHtml(provider.telefon)}">${escapeHtml(provider.telefon)}</a>`]);
    // epostUnderReview: Skive C(b)/AC4 — a flagged (domain-deviating) address
    // is published NOWHERE on this page until a human resolves it: not in the
    // visible fact row here, and not in the JSON-LD `email` further down (the
    // structured-data copy is what AI assistants read, so hiding only one of
    // the two would fix nothing). telefon is untouched — this gate is
    // email-only.
    const epostUnderReview = isGardssalgContactEmailFlaggedForReview(provider.field_provenance, provider.epost);
    if (provider.epost && !epostUnderReview) facts.push([L.gsEmail, `<a href="mailto:${escapeHtml(provider.epost)}">${escapeHtml(provider.epost)}</a>`]);
    const factsRows = facts.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${v}</td></tr>`).join("");
    const factsBlock = facts.length
      ? `<table class="facts"><caption class="skip-link">Praktisk info</caption><tbody>${factsRows}</tbody></table>
         <p class="produsent-note">Sesong, varighet, pris og kapasitet legges til etter hvert som profilen berikes.</p>`
      : `<p class="produsent-note">Praktisk info legges til etter hvert som profilen berikes. Kontakt produsenten ved reservasjon.</p>`;

    // "Produkter" — the drinks the producer sells, from the products JSON column
    // (filled by the RFB-knowledge enrichment; verified-quality only). Accepts
    // either ["Eplesider",…] or [{name:"Eplesider"},…] (the RFB agent_knowledge
    // .products shape). Honest omission: the section renders ONLY when we have
    // products — an empty/absent column shows nothing, never a placeholder claim.
    let productList: string[] = [];
    try {
      const parsed = JSON.parse(provider.products || "[]");
      if (Array.isArray(parsed)) {
        productList = parsed
          .map((p) =>
            typeof p === "string"
              ? p
              : p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string"
              ? ((p as { name: string }).name)
              : "",
          )
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch {
      productList = [];
    }
    // De-dup (case-insensitive) and cap so a noisy source can't blow up the page.
    const seenProduct = new Set<string>();
    productList = productList.filter((p) => {
      const k = p.toLowerCase();
      if (seenProduct.has(k)) return false;
      seenProduct.add(k);
      return true;
    }).slice(0, 24);
    const productsBlock = productList.length
      ? `<div class="info-card">
        <h2>Produkter</h2>
        <ul class="product-chips">${productList.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        <p class="produsent-note">Utvalget kan variere. Kontakt produsenten for dagsaktuelt sortiment.</p>
      </div>`
      : "";

    // Map block — arbeidspunkt 5: a real Leaflet mini-map (same
    // renderMiniMapSection helper /opplevelse/:slug uses) when we have a
    // point, with the original OpenStreetMap-link markup preserved verbatim
    // as the <noscript> fallback. The no-geo branch is untouched.
    const osmLinkHtml = `<a class="map-card" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}" target="_blank" rel="noopener" aria-label="Åpne posisjon i OpenStreetMap">
           <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>
           <span><strong>${escapeHtml(sted || "Posisjon")}</strong><span class="map-sub">${geoApprox ? "Ca. posisjon (kommune) – åpne i kart" : "Åpne i kart (OpenStreetMap)"}</span></span>
         </a>`;
    // Same coordinate sanity gate as the /opplevelse/:slug "Sted" card — see
    // its comment (Daniel 2026-08-24, punkt 5).
    const mapBlock = (lat !== null && lon !== null && isPlausibleNorwayCoord(lat, lon))
      ? renderMiniMapSection({ lat, lon, approx: geoApprox, label: sted || "Posisjon" }, osmLinkHtml)
      : `<div class="map-card map-fallback">
           <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>
           <span><strong>${escapeHtml(sted || "Sted ikke oppgitt")}</strong><span class="map-sub">Nøyaktig posisjon er ikke registrert ennå.</span></span>
         </div>`;

    // JSON-LD: LocalBusiness (the produsent's physical premises) + offers for
    // the visit + BreadcrumbList. No numeric price exists yet on this row, so
    // — same discipline as the /opplevelse/:slug Offer block — `offers`
    // describes the bookable visit without inventing a price.
    //
    // description: real enriched about_text (truncated to ~300 chars, same cap
    // discipline as summarizeAbout) when present — a more accurate/faithful
    // structured-data description than the generic metaDesc; otherwise metaDesc
    // as before. Gated on the same `hasRealAbout` render-guard as aboutBody
    // above (2026-08-12, arbeidspunkt 5) — a junk/truncated about_text must
    // not leak into JSON-LD just because it's hidden from the visible body.
    const ldDescription = hasRealAbout
      ? (provider.about_text!.trim().length > 300 ? provider.about_text!.trim().slice(0, 300).trim() + "…" : provider.about_text!.trim())
      : metaDesc;
    const ld: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: provider.navn,
      description: ldDescription,
      url: canonical,
      address: {
        "@type": "PostalAddress",
        streetAddress: provider.adresse || undefined,
        addressLocality: provider.poststed || provider.kommune || undefined,
        addressRegion: provider.fylke || undefined,
        addressCountry: "NO",
      },
    };
    // Structured data must never publish a coordinate we would refuse to draw.
  // Daniel 2026-08-25: the map gate shipped a day earlier stopped at the
  // rendering layer, so two rows at lat 0 / lon 0 were still being handed to
  // Google as `"geo": {"latitude": 0, "longitude": 0}` — a confident claim
  // that a Norwegian brewery sits in the Gulf of Guinea. Omitting the node
  // entirely is valid schema.org and says nothing rather than something false.
  if (lat !== null && lon !== null && isPlausibleNorwayCoord(lat, lon)) ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lon };
    if (site) ld.sameAs = [site];
    if (isDisplayablePhone(provider.telefon)) ld.telephone = provider.telefon;
    // Same review gate as the visible "E-post" fact row above — see
    // epostUnderReview's comment there (AC4).
    if (provider.epost && !epostUnderReview) ld.email = provider.epost;
    ld.offers = {
      "@type": "Offer",
      name: `Gårdsbesøk og smaking hos ${provider.navn}`,
      url: `${url}${bookHref}`,
      availability: "https://schema.org/InStock",
    };
    const breadcrumb = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Forsiden", item: url },
        { "@type": "ListItem", position: 2, name: "Gårdssalg og smaking", item: `${url}/kategori/gardssalg` },
        { "@type": "ListItem", position: 3, name: provider.navn, item: canonical },
      ],
    };
    const ldScripts = [ld, breadcrumb]
      .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/<\//g, "<\\/")}</script>`)
      .join("\n");

    // Per-page branded og:image (dev-request
    // 2026-07-12-opplevagent-serp-innholdsberikelse, item 3) — provider name
    // as label, "Gårdssalg og smaking" as sublabel, keyed to the gardssalg
    // accent color. Replaces the domain-wide favicon.svg fallback.
    const ogImage = ogImageUrl(url, provider.navn, { sublabel: "Gårdssalg og smaking", cat: "gardssalg" });
    const ogImageAlt = `${provider.navn} — Gårdssalg og smaking | Opplevagent`;

    const html = `<!doctype html>
<html lang="${htmlLangAttr(uiLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(provider.navn)}${sted ? " – " + escapeHtml(sted) : ""} | Opplevagent</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<meta name="robots" content="${provider.catalog_hidden === 1 ? "noindex, nofollow" : "index, follow, max-snippet:-1, max-image-preview:large"}">
<link rel="canonical" href="${canonical}">${switcherOn ? "\n" + oaHreflangLinks(url, noPath) : ""}
${pwaHeadTags()}
<meta property="og:title" content="${escapeHtml(provider.navn)} | Opplevagent">
<meta property="og:description" content="${escapeHtml(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="${ogLocale(uiLang)}">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
<meta name="twitter:card" content="summary">
${ldScripts}
<style>
${BROWSE_CSS}
.produsent-hero{background:${heroBg};color:#fff;padding:52px 0 44px;margin-bottom:32px}
.produsent-hero .hero-kicker{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.75;margin-bottom:10px}
.produsent-hero h1{font-size:clamp(1.6rem,3.6vw,2.4rem);font-weight:800;margin-bottom:8px;line-height:1.16}
.produsent-hero .hero-sted{opacity:.88;font-size:1rem;display:flex;align-items:center;gap:7px}
.produsent-layout{display:grid;grid-template-columns:1fr 320px;gap:28px;align-items:start;margin-bottom:8px}
@media(max-width:860px){.produsent-layout{grid-template-columns:1fr}}
.info-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:22px 24px;margin-bottom:20px;box-shadow:var(--sh-sm)}
.info-card h2{font-size:1.05rem;font-weight:800;color:var(--fjord-900);margin-bottom:10px}
.info-card p{color:var(--ink-soft);font-size:.96rem}
.facts{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}
.facts th,.facts td{text-align:left;padding:12px 16px;font-size:.9rem;border-bottom:1px solid var(--line);vertical-align:top}
.facts tr:last-child th,.facts tr:last-child td{border-bottom:none}
.facts th{width:34%;color:var(--mist);font-weight:600}
.produsent-note{font-size:.78rem;color:var(--mist);margin-top:10px}
.product-chips{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 0;padding:0}
.product-chips li{background:var(--canvas-2);border:1px solid var(--line);border-radius:var(--r-pill);padding:6px 13px;font-size:.88rem;font-weight:600;color:var(--fjord-900)}
.aside-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;box-shadow:var(--sh-sm);margin-bottom:16px}
.aside-card h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mist);margin-bottom:12px}
.reserve-cta{display:block;text-align:center;background:linear-gradient(135deg,var(--amber-500),var(--coral-500));color:#fff;font-weight:800;padding:14px 18px;border-radius:var(--r-pill);box-shadow:0 4px 14px rgba(255,93,59,.4)}
.reserve-cta:hover{text-decoration:none;filter:brightness(1.04)}
/* 2026-08-12 (arbeidspunkt 5): paused-booking variant — same pill shape/
   sizing as .reserve-cta for layout consistency, but a neutral/muted style
   so the CTA never visually promises an active reservation it can't
   deliver while booking is paused (the .reserve-notice right above it
   already says so in words; this fix is the matching visual signal). */
.reserve-cta-paused{display:block;text-align:center;background:var(--canvas-2);color:var(--ink-soft);font-weight:800;padding:14px 18px;border-radius:var(--r-pill);border:1px solid var(--line);box-shadow:none}
.reserve-cta-paused:hover{text-decoration:none;background:var(--line)}
.reserve-notice{font-size:.8rem;font-weight:600;color:var(--fjord-800);background:var(--canvas-2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:10px}
.map-card{display:flex;align-items:center;gap:12px;color:var(--ink-soft);background:var(--canvas-2);border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px}
.map-card:hover{text-decoration:none;border-color:var(--fjord-600)}
.map-card svg{color:var(--fjord-600);flex:0 0 22px}
.map-card strong{display:block;color:var(--ink);font-size:.95rem}
.map-sub{font-size:.8rem;color:var(--mist)}
.map-fallback:hover{border-color:var(--line)}
${OA_CHROME_CSS}
</style>
${lat !== null && lon !== null ? `<style>${MINI_MAP_CSS}</style>` : ""}
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
${switcherOn ? oaSiteNav({ active: "gardssalg", lang, path: noPath, switcher: true }) : oaSiteNav({ active: "gardssalg" })}
<header class="produsent-hero">
  <div class="container">
    <div class="hero-kicker">${L.gsKicker}</div>
    <h1>${escapeHtml(provider.navn)}</h1>
    ${sted ? `<p class="hero-sted">${escapeHtml(sted)}</p>` : ""}
    ${badge}
  </div>
</header>
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="${L.crumbsGs}">
    <a href="${localizedPath("/", uiLang) || "/"}">${L.home}</a> · <a href="/kategori/gardssalg">${L.gsCrumb}</a> · ${escapeHtml(provider.navn)}
  </nav>
  <div class="produsent-layout">
    <article>
      <div class="info-card">
        <h2>${L.gsAbout}</h2>
        ${aboutBody}
      </div>
      <div class="info-card">
        <h2>${L.gsVisit}</h2>
        ${visitBody}
      </div>
      ${productsBlock}
      <div class="info-card">
        <h2>${L.gsPractical}</h2>
        ${factsBlock}
      </div>
    </article>
    <aside>
      <div class="aside-card">
        <h2>${L.gsReserve}</h2>
        ${bookingPaused ? `<p class="reserve-notice">${BOOKING_NOT_ACTIVATED_MSG}${isClaimed ? "" : ` Er dette din bedrift? <a href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}">Ta over profilen og aktiver booking</a>.`}</p>` : ""}
        <a id="reserve-cta" class="${bookingPaused ? "reserve-cta-paused" : "reserve-cta"}" href="${bookHref}">${bookingPaused ? "Meld interesse" : "Reserver besøk"}</a>
      </div>
      <div class="aside-card">
        <h2>${L.place}</h2>
        ${mapBlock}
      </div>
      ${isClaimed ? `<div class="aside-card">
        <h2 style="display:flex;align-items:center;gap:6px"><span style="color:#0f5a50">&#10003;</span> Bekreftet av eier</h2>
        <p style="font-size:.86rem;color:var(--ink-soft);margin:0 0 10px">Eieren har bekreftet denne profilen via magisk lenke.</p>
        <a class="gc-claim-cta" href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}/portal" style="display:block;text-align:center;background:transparent;color:#0f5a50;font-weight:600;padding:8px 14px;border:1px solid #0f5a50;border-radius:var(--r-pill);font-size:.86rem">Logg inn</a>
      </div>` : `<div class="aside-card">
        <h2>Driver du dette stedet?</h2>
        <p style="font-size:.86rem;color:var(--ink-soft);margin:0 0 10px">Ta over profilen og rediger informasjon, produkter og reservasjoner selv.</p>
        <a class="gc-claim-cta" href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}" style="display:block;text-align:center;background:#fff;color:#0f5a50;font-weight:700;padding:10px 14px;border:1px solid #0f5a50;border-radius:var(--r-pill);font-size:.9rem">Er dette din bedrift?</a>
      </div>`}
      <div class="aside-card">
        <h2>Lenk til oss</h2>
        <p style="font-size:.85rem;color:var(--ink-soft);margin-bottom:10px">Legg badgen på din egen nettside og lenk tilbake til profilen din her på Opplevagent.</p>
        <a href="${escapeHtml(badgeProfileHref)}" target="_blank" rel="noopener"><img src="/badge/opplevagent.svg" width="180" height="40" alt="Finn oss på Opplevagent"></a>
        <textarea readonly aria-label="HTML-kode for Opplevagent-badgen" style="width:100%;margin-top:10px;font-family:monospace;font-size:.78rem;padding:8px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--canvas-2);color:var(--ink-soft);resize:vertical" rows="3" onclick="this.select()">${escapeHtml(badgeEmbedSnippet)}</textarea>
      </div>
    </aside>
  </div>
  <p class="legal-note" style="font-size:.78rem;color:#7a7163;margin-top:24px;padding-top:16px;border-top:1px solid #e4ded0">Vi formidler besøket og smakingen hos produsenten. Selve salget skjer hos produsenten, som har egen kommunal bevilling.</p>
</main>
${switcherOn ? oaSiteFooter({ lang }) : oaSiteFooter({})}
<script>
(function () {
  // dev-request 2026-08-06-eier-ser-reserver-knapp-paa-egen-profil: swap
  // "Reserver besøk" to an owner action ONLY for the logged-in owner of
  // THIS provider, entirely client-side — this page's server-rendered HTML
  // (see the doc comment above decideOwnerCtaSwap() in experiences-seo.ts)
  // is identical for every visitor/cache. Fails closed to "no change" if
  // the fetch errors, is unauthenticated, or is for a different provider.
  var cta = document.getElementById("reserve-cta");
  if (!cta || !window.fetch) return;
  var decideOwnerCtaSwap = ${decideOwnerCtaSwap.toString()};
  var providerId = ${JSON.stringify(provider.id)};
  var portalHref = ${JSON.stringify(`/kategori/gardssalg/eier/${encodeURIComponent(slug)}/portal`)};
  var previewHref = ${JSON.stringify(bookHref)};
  fetch("/api/opplevelser/gardssalg-claim/" + encodeURIComponent(providerId) + "/session-status", { credentials: "same-origin" })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
    .then(function (out) {
      var decision = decideOwnerCtaSwap(out.ok, out.body, portalHref, previewHref);
      if (!decision.swap) return;
      cta.textContent = decision.primaryLabel;
      cta.setAttribute("href", decision.primaryHref);
      var secondary = document.createElement("a");
      secondary.id = "reserve-cta-preview";
      secondary.setAttribute("href", decision.secondaryHref);
      secondary.textContent = decision.secondaryLabel;
      secondary.style.cssText = "display:block;text-align:center;margin-top:8px;background:transparent;color:#0f5a50;font-weight:600;padding:8px 14px;border:1px solid #0f5a50;border-radius:999px;font-size:.86rem;text-decoration:none";
      cta.insertAdjacentElement("afterend", secondary);
    })
    .catch(function () {});
})();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(html);
  },
);

// ─── Gårdssalg reservation → confirmation journey (2026-07-02) ──────────────
//
// Fixes the live "Book besøk" 404: gårdssalg producers have zero rows in the
// `experiences` table (their product is a gårdsbesøk booking, not a listed
// "experience"), so /tilbyder/<slug> — which requires ≥1 published experience
// — always 404'd for them. These three routes give the button a real
// destination that resolves via getGardssalgProviderBySlug() (mirrors the
// listGardssalgProviders() WHERE clause, not the experiences-join gate) and
// carry the guest through reserve → confirm without duplicating the booking
// business logic that already lives in POST /api/opplevelser/book:
//
//   GET  /kategori/gardssalg/book/:providerSlug               reservation panel
//   POST /kategori/gardssalg/book/:providerSlug               no-JS fallback
//   GET  /kategori/gardssalg/book/:providerSlug/confirm/:ref  confirmation + QR
//
// The panel's <form> is a real HTML POST (works with JS disabled); a small
// inline <script> progressively enhances it to call the JSON API directly
// with fetch() and skip the extra redirect round-trip. Both the JS path (the
// existing POST /api/opplevelser/book handler) and the no-JS fallback below
// call the exact same createBooking()/sendBookingConfirmation() functions
// from ../services/booking-store — no business logic is duplicated.

function bookingErrorMessage(code: string): string {
  switch (code) {
    case "invalid":
      return "Sjekk at alle obligatoriske felt er fylt ut riktig (dato/tid, antall personer, navn og e-post), og prøv igjen.";
    case "internal":
      return "Noe gikk galt på våre servere. Prøv igjen om litt.";
    // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0 — the no-JS
    // POST fallback redirects here with ?error=paused when the hard-stop
    // gate (isBookingPaused()) blocks a submission. Copy from booking-store
    // (dev-request 2026-08-09-gardssalg-kommer-snart-fjernes-eier-aktivert-
    // booking): plain "not activated" fact, no "coming soon" promise.
    case "paused":
      return BOOKING_NOT_ACTIVATED_INTEREST_MSG;
    default:
      return "Noe gikk galt. Prøv igjen.";
  }
}

// GET /kategori/gardssalg/book/:providerSlug — reservation panel for one
// gårdssalg producer. 404s (via next()) if the slug doesn't resolve.
router.get(
  "/kategori/gardssalg/book/:providerSlug",
  (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.params.providerSlug || "");
    if (!slug) return next();
    ensureProviderSlugs();
    let provider: GardssalgProviderRow | null = null;
    try {
      provider = getGardssalgProviderBySlug(slug);
    } catch {
      provider = null;
    }
    if (!provider) return next();

    const sted = [provider.poststed, provider.kommune, provider.fylke].filter(Boolean).join(", ");
    const badge = drinkBadge(provider.producer_type);
    const url = baseUrl();
    const canonical = `${url}/kategori/gardssalg/book/${encodeURIComponent(slug)}`;
    const errorParam = String(req.query.error || "");
    const errorBanner = errorParam
      ? `<div role="alert" style="background:#fdecea;border:1px solid #f3b6ae;color:#8a2f24;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:.9rem">${escapeHtml(bookingErrorMessage(errorParam))}</div>`
      : "";

    // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0 — persistent,
    // no-JS notice shown whenever submission would actually be blocked (see
    // the hard stop in the POST handler below and in POST
    // /api/opplevelser/book). Independent of ?error=paused (that's the
    // banner shown AFTER a blocked submit attempt); this one is unmissable
    // up front so nothing on the page implies booking works today.
    const notLive = isBookingPaused(provider.booking_live, provider.catalog_hidden);
    // Same claim-CTA coupling as the profile page's reserve-notice: an
    // unclaimed provider's paused state doubles as the owner's on-ramp
    // ("take over the profile and switch booking on"); a claimed provider's
    // owner already has the portal, so no CTA there (and the claimed-badge
    // invariant — no "Er dette din bedrift?" on claimed surfaces — holds).
    const panelClaimCta = provider.claimed_at == null
      ? ` Er dette din bedrift? <a href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}">Ta over profilen og aktiver booking</a>.`
      : "";
    const pausedNotice = notLive
      ? `<div class="notice-paused" role="status"><strong>Booking ikke aktivert</strong>${BOOKING_NOT_ACTIVATED_INTEREST_MSG}${panelClaimCta}</div>`
      : "";

    const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book besøk hos ${escapeHtml(provider.navn)} | Opplevagent</title>
<meta name="description" content="Reserver en smaking eller omvisning hos ${escapeHtml(provider.navn)}${sted ? " i " + escapeHtml(sted) : ""}. Ingen betaling nå — kun en reservasjon.">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${canonical}">
${pwaHeadTags()}
<style>
${BROWSE_CSS}
.book-panel{max-width:520px;margin:24px auto 0;background:var(--surface);border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:28px 24px}
.book-panel h1{font-size:1.4rem;font-weight:800;color:var(--fjord-900);margin-bottom:4px}
.book-panel .sted{font-size:.86rem;color:var(--mist);margin-bottom:10px}
.book-panel .microcopy{font-size:.86rem;color:var(--ink-soft);background:var(--canvas-2);border-radius:8px;padding:10px 14px;margin:14px 0 18px}
.book-panel .notice-paused{font-size:.88rem;color:var(--ink);background:var(--canvas-2);border:1px solid var(--line);border-left:4px solid var(--fjord-800);border-radius:8px;padding:12px 14px;margin:14px 0 18px}
.book-panel .notice-paused strong{display:block;font-size:.76rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--fjord-800);margin-bottom:4px}
.book-form label{display:block;font-size:.84rem;font-weight:700;color:var(--ink-soft);margin:14px 0 5px}
.book-form input,.book-form textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:.95rem;color:var(--ink);background:var(--surface)}
.book-form textarea{resize:vertical;font-family:inherit;min-height:72px}
.book-form input:focus-visible,.book-form textarea:focus-visible{outline:2px solid var(--teal-500);outline-offset:1px}
.book-form button{margin-top:20px;width:100%;padding:12px 18px;background:var(--fjord-800);color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
.book-form button:hover{background:var(--fjord-700)}
.book-form button:disabled{opacity:.6;cursor:default}
.book-form .hint{font-size:.76rem;color:var(--mist);margin-top:8px;min-height:1em}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav" aria-label="Navigasjon">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="brand-word">opplevagent<span class="tld">.no</span></span></a>
    <span class="nav-links"><a href="/opplevelser">Alle opplevelser</a><a href="/kategori/gardssalg">Gårdssalg</a></span>
  </div>
</nav>
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmulesti">
    <a href="/">Forsiden</a> · <a href="/kategori/gardssalg">Gårdssalg og smaking</a> · ${escapeHtml(provider.navn)}
  </nav>
  <div class="book-panel">
    ${errorBanner}
    ${pausedNotice}
    ${sted ? `<div class="sted">${escapeHtml(sted)}</div>` : ""}
    <h1>${escapeHtml(provider.navn)}</h1>
    ${badge}
    ${notLive ? "" : `<p class="microcopy">Du betaler ingenting nå — dette er en reservasjon.</p>`}
    <form class="book-form" method="POST" action="${canonical}" id="book-form">
      <input type="hidden" name="provider_id" value="${escapeHtml(provider.id)}">
      <label for="slot_at">Dato og tid (norsk tid)</label>
      <input id="slot_at" name="slot_at" type="datetime-local" value="${escapeHtml(defaultBookingSlotAtDatetimeLocal())}" required>
      <label for="party_size">Antall personer</label>
      <input id="party_size" name="party_size" type="number" min="1" max="50" value="2" required>
      <label for="guest_name">Navn</label>
      <input id="guest_name" name="guest_name" type="text" maxlength="200" autocomplete="name" required>
      <label for="guest_email">E-post</label>
      <input id="guest_email" name="guest_email" type="email" autocomplete="email" required>
      <label for="guest_phone">Telefon <span style="font-weight:400;color:var(--mist)">(valgfritt)</span></label>
      <input id="guest_phone" name="guest_phone" type="tel" maxlength="30" autocomplete="tel">
      <label for="notes">Kommentar til produsenten <span style="font-weight:400;color:var(--mist)">(valgfritt)</span></label>
      <textarea id="notes" name="notes" maxlength="500" rows="3" placeholder="F.eks. allergier, spørsmål eller ønsker for besøket"></textarea>
      <button type="submit">Reserver besøk</button>
      <p class="hint" id="book-form-status" role="status" aria-live="polite"></p>
    </form>
  </div>
</main>
<footer style="margin-top:48px;padding:24px 0;border-top:1px solid #e4ded0;font-size:.8rem;color:#7a7163;text-align:center">
  <span><a href="/">Forsiden</a> · <a href="/kategori/gardssalg">Gårdssalg og smaking</a></span>
</footer>
<script>
(function () {
  var form = document.getElementById("book-form");
  if (!form) return;
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var status = document.getElementById("book-form-status");
    var btn = form.querySelector("button[type=submit]");
    var fd = new FormData(form);
    var partySize = parseInt(String(fd.get("party_size") || ""), 10);
    var payload = {
      provider_id: String(fd.get("provider_id") || ""),
      slot_at: String(fd.get("slot_at") || ""),
      party_size: partySize,
      guest_name: String(fd.get("guest_name") || ""),
      guest_email: String(fd.get("guest_email") || "")
    };
    var phone = String(fd.get("guest_phone") || "").trim();
    if (phone) payload.guest_phone = phone;
    var notes = String(fd.get("notes") || "").trim();
    if (notes) payload.notes = notes;
    if (btn) btn.disabled = true;
    if (status) status.textContent = "Sender reservasjon …";
    fetch("/api/opplevelser/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (res) {
        if (res.ok && res.data && res.data.success && res.data.booking_ref) {
          window.location.href = ${JSON.stringify(canonical)} + "/confirm/" + encodeURIComponent(res.data.booking_ref);
          return;
        }
        if (btn) btn.disabled = false;
        if (res.data && res.data.paused) {
          if (status) status.textContent = res.data.message || ${JSON.stringify(BOOKING_NOT_ACTIVATED_MSG)};
          return;
        }
        if (status) status.textContent = "Noe gikk galt. Sjekk feltene og prøv igjen, eller last siden på nytt uten javascript.";
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (status) status.textContent = "Nettverksfeil. Prøv igjen om litt.";
      });
  });
})();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  },
);

// POST /kategori/gardssalg/book/:providerSlug — no-JS fallback for the panel
// above. Same validation + the exact same createBooking()/
// sendBookingConfirmation() service functions the JSON API uses; redirects
// (303, so a reload doesn't resubmit) to the confirmation page on success or
// back to the panel with ?error=<code> on failure.
router.post(
  "/kategori/gardssalg/book/:providerSlug",
  express.urlencoded({ extended: false }),
  (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.params.providerSlug || "");
    if (!slug) return next();
    ensureProviderSlugs();
    let provider: GardssalgProviderRow | null = null;
    try {
      provider = getGardssalgProviderBySlug(slug);
    } catch {
      provider = null;
    }
    if (!provider) return next();

    const backTo = `/kategori/gardssalg/book/${encodeURIComponent(slug)}`;

    // ─── Dark-launch-stop gate (dev-request 2026-07-12-gardssalg-dark-
    // launch-stop, slice 0) — mirrors the gate in POST /api/opplevelser/book
    // exactly (see isBookingPaused() in services/booking-store.ts). Checked
    // before touching req.body at all: no reserved row, no guest email, no
    // producer notification when paused, full stop.
    if (isBookingPaused(provider.booking_live, provider.catalog_hidden)) {
      res.redirect(303, `${backTo}?error=paused`);
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const partySize = parseInt(String(body.party_size ?? ""), 10);
    const phoneRaw = body.guest_phone ? String(body.guest_phone).trim() : "";
    const notesRaw = body.notes ? String(body.notes).trim() : "";

    const parsed = BookingInputSchema.safeParse({
      provider_id: provider.id,
      slot_at: String(body.slot_at ?? ""),
      party_size: partySize,
      guest_name: String(body.guest_name ?? ""),
      guest_email: String(body.guest_email ?? ""),
      ...(phoneRaw ? { guest_phone: phoneRaw } : {}),
      ...(notesRaw ? { notes: notesRaw } : {}),
    });
    if (!parsed.success) {
      res.redirect(303, `${backTo}?error=invalid`);
      return;
    }

    let booking;
    try {
      booking = createBooking(parsed.data);
    } catch (err) {
      console.error("[gardssalg-book] createBooking failed", err);
      res.redirect(303, `${backTo}?error=internal`);
      return;
    }

    // Fire-and-forget confirmation email — identical to the JSON API path.
    sendBookingConfirmation(booking).catch((e) =>
      console.error("[gardssalg-book] email failed", booking.booking_ref, e),
    );

    // Fire-and-forget producer notification — the gate above already
    // confirmed dispatch is on and this provider is booking_live.
    sendProducerNotification(booking, provider.epost).catch((e) =>
      console.error("[gardssalg-book] producer notification failed", booking.booking_ref, e),
    );

    res.redirect(303, `${backTo}/confirm/${encodeURIComponent(booking.booking_ref)}`);
  },
);

// GET /kategori/gardssalg/book/:providerSlug/confirm/:ref — confirmation page.
// Looks the booking up via the existing getBookingByRef() (same function the
// ICS-download endpoint uses) — no duplicate lookup. 404s if the ref doesn't
// resolve, or resolves to a different provider than the one in the URL.
router.get(
  "/kategori/gardssalg/book/:providerSlug/confirm/:ref",
  async (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.params.providerSlug || "");
    const ref = String(req.params.ref || "");
    if (!slug || !ref) return next();
    ensureProviderSlugs();
    let provider: GardssalgProviderRow | null = null;
    try {
      provider = getGardssalgProviderBySlug(slug);
    } catch {
      provider = null;
    }
    if (!provider) return next();

    let booking: ReturnType<typeof getBookingByRef> = null;
    try {
      booking = getBookingByRef(ref);
    } catch {
      booking = null;
    }
    if (!booking || booking.provider_id !== provider.id) return next();

    const slotFormatted = new Date(booking.slot_at).toLocaleString("nb-NO", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "Europe/Oslo",
    });

    // Server-side SVG generation only — booking_ref never leaves our infra via
    // a third-party QR image service.
    let qrSvg = "";
    try {
      qrSvg = await QRCode.toString(booking.booking_ref, { type: "svg", margin: 1, width: 180 });
    } catch (err) {
      console.error("[gardssalg-book] QR render failed", booking.booking_ref, err);
      qrSvg = "";
    }

    const icsUrl = `/api/opplevelser/book/${encodeURIComponent(booking.booking_ref)}/ics`;

    const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reservasjon bekreftet | Opplevagent</title>
<meta name="robots" content="noindex, nofollow">
${pwaHeadTags()}
<style>
${BROWSE_CSS}
.confirm-panel{max-width:480px;margin:24px auto 0;background:var(--surface);border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:28px 24px;text-align:center}
.confirm-panel h1{font-size:1.3rem;font-weight:800;color:var(--fjord-900);margin-bottom:10px}
.confirm-panel .qr{margin:18px auto;width:180px;height:180px}
.confirm-panel .qr svg{width:100%;height:100%}
.confirm-panel .ref{font-family:monospace;font-size:1.05rem;font-weight:700;letter-spacing:.03em;color:var(--fjord-800);background:var(--canvas-2);border-radius:8px;padding:8px 14px;display:inline-block;margin:8px 0 4px}
.confirm-panel .recap{text-align:left;margin:18px 0;font-size:.92rem;color:var(--ink-soft)}
.confirm-panel .recap div{padding:5px 0;border-bottom:1px solid var(--line)}
.confirm-panel .hint{font-size:.82rem;color:var(--mist);margin-top:14px}
.confirm-panel .ics-link{display:inline-block;margin-top:16px;padding:10px 18px;background:var(--fjord-800);color:#fff;border-radius:8px;font-weight:700;font-size:.9rem;text-decoration:none}
.confirm-panel .ics-link:hover{background:var(--fjord-700);text-decoration:none}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav" aria-label="Navigasjon">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="brand-word">opplevagent<span class="tld">.no</span></span></a>
    <span class="nav-links"><a href="/opplevelser">Alle opplevelser</a><a href="/kategori/gardssalg">Gårdssalg</a></span>
  </div>
</nav>
<main id="main" class="container">
  <div class="confirm-panel">
    <h1>Reservasjon bekreftet</h1>
    <p>Hos ${escapeHtml(provider.navn)}</p>
    ${qrSvg ? `<div class="qr">${qrSvg}</div>` : ""}
    <div class="ref">${escapeHtml(booking.booking_ref)}</div>
    <p class="hint">Vis ved ankomst — produsenten bekrefter oppmøtet.</p>
    <div class="recap">
      <div><strong>Dato/tid:</strong> ${escapeHtml(slotFormatted)}</div>
      <div><strong>Antall:</strong> ${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</div>
      <div><strong>Navn:</strong> ${escapeHtml(booking.guest_name)}</div>
      ${booking.notes ? `<div><strong>Kommentar:</strong> ${escapeHtml(booking.notes)}</div>` : ""}
    </div>
    <p class="hint">En bekreftelse er sendt til ${escapeHtml(booking.guest_email)}.</p>
    <a class="ics-link" href="${icsUrl}">Last ned kalenderfil (.ics)</a>
  </div>
</main>
<footer style="margin-top:48px;padding:24px 0;border-top:1px solid #e4ded0;font-size:.8rem;color:#7a7163;text-align:center">
  <span><a href="/">Forsiden</a> · <a href="/kategori/gardssalg">Gårdssalg og smaking</a></span>
</footer>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  },
);

// ─── Producer confirm page (booking-flyt-v1 "bekreft-løkka") ────────────────
//   GET  /kategori/gardssalg/bekreft/:token   status + details, mutates NOTHING
//   POST /kategori/gardssalg/bekreft/:token   action=attended|no_show|reopen
//
// The tokenized link lands in the PRODUCER's notification email (see
// sendProducerNotification). The old API endpoint resolved the booking
// directly on GET — a state-mutating GET that a mail scanner's link prefetch
// would have triggered silently; here every resolution is an explicit POST
// button press (PRG redirect back to this page). Attendance actions are
// time-guarded via visitTimeReached() — "bekreft oppmøte" only after the
// visit — while "angre" (undo, back to reserved) is always available so a
// mis-click on «Ikke møtt» is never permanent (billable/commission hangs on
// this). Confirmed attendance counts toward the commission base.
const BEKREFT_STATUS_LABEL: Record<string, string> = {
  reserved: "Reservert — oppmøte ikke registrert ennå",
  confirmed_attended: "Oppmøte bekreftet",
  no_show: "Ikke møtt",
  cancelled: "Kansellert",
};

router.get(
  "/kategori/gardssalg/bekreft/:token",
  (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.params.token || "");
    if (!token) return next();
    let booking: ReturnType<typeof getBookingByToken> = null;
    try {
      booking = getBookingByToken(token);
    } catch {
      booking = null;
    }
    if (!booking) return next();

    const provider = getProviderById(booking.provider_id) as { navn?: string | null } | null;
    const slotFormatted = new Date(booking.slot_at).toLocaleString("nb-NO", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "Europe/Oslo",
    });
    const canConfirm = visitTimeReached(booking);
    const statusLabel = BEKREFT_STATUS_LABEL[booking.status] || booking.status;

    const done = String(req.query.done || "");
    const errorParam = String(req.query.error || "");
    const banner =
      done && BEKREFT_STATUS_LABEL[done]
        ? `<div class="bekreft-banner ok" role="status">Registrert: ${escapeHtml(BEKREFT_STATUS_LABEL[done])}</div>`
        : errorParam === "too_early"
          ? `<div class="bekreft-banner warn" role="alert">Oppmøte kan først registreres etter besøkstidspunktet.</div>`
          : errorParam
            ? `<div class="bekreft-banner warn" role="alert">Kunne ikke oppdatere reservasjonen. Prøv igjen.</div>`
            : "";

    const postTo = `/kategori/gardssalg/bekreft/${encodeURIComponent(token)}`;
    const actBtn = (action: string, label: string, cls: string) =>
      `<form method="POST" action="${postTo}"><input type="hidden" name="action" value="${action}"><button type="submit" class="act-btn ${cls}">${label}</button></form>`;

    let actionsHtml = "";
    if (booking.status === "cancelled") {
      actionsHtml = "";
    } else if (!canConfirm) {
      actionsHtml = `<p class="bekreft-wait">Oppmøte kan registreres etter besøket (fra ${escapeHtml(slotFormatted)}).</p>`;
      if (booking.status === "confirmed_attended" || booking.status === "no_show") {
        actionsHtml += actBtn("reopen", "Angre — tilbake til reservert", "act-undo");
      }
    } else {
      const parts: string[] = [];
      if (booking.status !== "confirmed_attended") parts.push(actBtn("attended", "Bekreft oppmøte", "act-primary"));
      if (booking.status !== "no_show") parts.push(actBtn("no_show", "Ikke møtt", "act-secondary"));
      if (booking.status === "confirmed_attended" || booking.status === "no_show") {
        parts.push(actBtn("reopen", "Angre — tilbake til reservert", "act-undo"));
      }
      actionsHtml = parts.join("\n    ");
    }

    const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bekreft oppmøte — ${escapeHtml(booking.booking_ref)} | Opplevagent</title>
<meta name="robots" content="noindex, nofollow">
${pwaHeadTags()}
<style>
${BROWSE_CSS}
.confirm-panel{max-width:480px;margin:24px auto 0;background:var(--surface);border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:28px 24px}
.confirm-panel h1{font-size:1.3rem;font-weight:800;color:var(--fjord-900);margin-bottom:4px}
.confirm-panel .ref{font-family:monospace;font-size:1rem;font-weight:700;letter-spacing:.03em;color:var(--fjord-800);background:var(--canvas-2);border-radius:8px;padding:6px 12px;display:inline-block;margin:8px 0 4px}
.confirm-panel .status-line{margin:12px 0 4px;font-size:.95rem}
.confirm-panel .recap{text-align:left;margin:16px 0;font-size:.92rem;color:var(--ink-soft)}
.confirm-panel .recap div{padding:5px 0;border-bottom:1px solid var(--line)}
.confirm-panel .hint{font-size:.82rem;color:var(--mist);margin-top:14px}
.bekreft-banner{border-radius:8px;padding:12px 14px;margin:14px 0;font-size:.9rem}
.bekreft-banner.ok{background:#e8f4ec;border:1px solid #bcd9c5;color:#1d5a30}
.bekreft-banner.warn{background:#fdf3e7;border:1px solid #f0d4ae;color:#7a5218}
.bekreft-wait{font-size:.9rem;color:var(--ink-soft);background:var(--canvas-2);border-radius:8px;padding:12px 14px;margin:14px 0}
.act-btn{margin-top:12px;width:100%;padding:12px 18px;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
.act-primary{background:var(--fjord-800);color:#fff}
.act-primary:hover{background:var(--fjord-700)}
.act-secondary{background:var(--canvas-2);color:var(--ink);border:1px solid var(--line)}
.act-undo{background:transparent;color:var(--ink-soft);border:1px dashed var(--line);font-weight:400;font-size:.88rem;padding:9px 14px}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav" aria-label="Navigasjon">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="brand-word">opplevagent<span class="tld">.no</span></span></a>
  </div>
</nav>
<main id="main" class="container">
  <div class="confirm-panel">
    <h1>Reservasjon hos ${escapeHtml(provider?.navn || "deg")}</h1>
    <div class="ref">${escapeHtml(booking.booking_ref)}</div>
    ${banner}
    <div class="status-line">Status: <strong>${escapeHtml(statusLabel)}</strong></div>
    <div class="recap">
      <div><strong>Dato/tid:</strong> ${escapeHtml(slotFormatted)}</div>
      <div><strong>Antall:</strong> ${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</div>
      <div><strong>Gjest:</strong> ${escapeHtml(booking.guest_name)}</div>
      <div><strong>E-post:</strong> ${escapeHtml(booking.guest_email)}</div>
      ${booking.guest_phone ? `<div><strong>Telefon:</strong> ${escapeHtml(booking.guest_phone)}</div>` : ""}
      ${booking.notes ? `<div><strong>Kommentar fra gjesten:</strong> ${escapeHtml(booking.notes)}</div>` : ""}
    </div>
    ${actionsHtml}
    <p class="hint">Denne siden er for produsenten. Bekreftet oppmøte regnes med i provisjonsgrunnlaget; «Ikke møtt» holdes utenfor. Lenken er personlig for denne reservasjonen.</p>
  </div>
</main>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  },
);

router.post(
  "/kategori/gardssalg/bekreft/:token",
  express.urlencoded({ extended: false }),
  (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.params.token || "");
    if (!token) return next();
    let booking: ReturnType<typeof getBookingByToken> = null;
    try {
      booking = getBookingByToken(token);
    } catch {
      booking = null;
    }
    if (!booking) return next();

    const backTo = `/kategori/gardssalg/bekreft/${encodeURIComponent(token)}`;
    const action = String((req.body || {}).action || "");

    if (action === "reopen") {
      const reopened = reopenBooking(token);
      res.redirect(303, reopened ? `${backTo}?done=reserved` : `${backTo}?error=ugyldig`);
      return;
    }

    if (action !== "attended" && action !== "no_show") {
      res.redirect(303, `${backTo}?error=ugyldig`);
      return;
    }

    // Time guard: attendance can only be resolved after the visit has started
    // (see visitTimeReached() for the naive-datetime caveat).
    if (!visitTimeReached(booking)) {
      res.redirect(303, `${backTo}?error=too_early`);
      return;
    }

    const resolved = resolveBooking(
      token,
      action === "attended" ? "confirmed_attended" : "no_show",
      req.ip || "produsent-lenke",
    );
    res.redirect(303, resolved ? `${backTo}?done=${resolved.status}` : `${backTo}?error=ugyldig`);
  },
);

// ─── Pre-visit answer loop (booking-flyt-v1 slice 2) ────────────────────────
//   GET  /kategori/gardssalg/svar/:token         producer answer page — GET
//                                                mutates NOTHING (PRG, exactly
//                                                like the bekreft page above)
//   POST /kategori/gardssalg/svar/:token         action=bekreft|foresla|avsla
//   GET  /kategori/gardssalg/gjestesvar/:token   guest decision page (suggested
//                                                time) — GET mutates NOTHING
//   POST /kategori/gardssalg/gjestesvar/:token   action=aksepter|avsla
//   GET  /kategori/gardssalg/status/:ref/:token  guest read-only status page
//
// Token discipline: the respond token is the PRODUCER's credential (one-time
// for a terminal answer + expiring — reuse/expiry gets a friendly no-action
// page and never mutates), the decision/status tokens are the GUEST's; the
// emails in booking-store never cross them. All guest-controlled strings are
// escapeHtml()-escaped in these pages.
const PRE_STATUS_LABEL: Record<string, string> = {
  awaiting_provider: "Venter på svar fra produsenten",
  provider_confirmed: "Bekreftet av produsenten",
  provider_declined: "Avslått",
  time_suggested: "Produsenten har foreslått et nytt tidspunkt",
  // True in both expiry paths: an unanswered request AND a suggestion that
  // was never finally settled (review finding 1).
  expired: "Utløpt — ble ikke avklart i tide",
};

function previsitSlotNb(slot: string | null): string {
  if (!slot) return "";
  // TZ-fix 2026-07-30: rows stored before the fix carry the naked
  // datetime-local string, which was TYPED as Oslo wall time — convert before
  // formatting so old bookings don't keep the +2h display error forever.
  const iso = osloDatetimeLocalToUtcIso(slot) ?? slot;
  return new Date(iso).toLocaleString("nb-NO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });
}

// Shared shell for the small pre-visit pages (svar/gjestesvar/status) — same
// look as the bekreft page above.
function previsitPage(title: string, inner: string): string {
  return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} | Opplevagent</title>
<meta name="robots" content="noindex, nofollow">
${pwaHeadTags()}
<style>
${BROWSE_CSS}
.confirm-panel{max-width:520px;margin:24px auto 0;background:var(--surface);border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:28px 24px}
.confirm-panel h1{font-size:1.3rem;font-weight:800;color:var(--fjord-900);margin-bottom:4px}
.confirm-panel .ref{font-family:monospace;font-size:1rem;font-weight:700;letter-spacing:.03em;color:var(--fjord-800);background:var(--canvas-2);border-radius:8px;padding:6px 12px;display:inline-block;margin:8px 0 4px}
.confirm-panel .status-line{margin:12px 0 4px;font-size:.95rem}
.confirm-panel .recap{text-align:left;margin:16px 0;font-size:.92rem;color:var(--ink-soft)}
.confirm-panel .recap div{padding:5px 0;border-bottom:1px solid var(--line)}
.confirm-panel .hint{font-size:.82rem;color:var(--mist);margin-top:14px}
.bekreft-banner{border-radius:8px;padding:12px 14px;margin:14px 0;font-size:.9rem}
.bekreft-banner.ok{background:#e8f4ec;border:1px solid #bcd9c5;color:#1d5a30}
.bekreft-banner.warn{background:#fdf3e7;border:1px solid #f0d4ae;color:#7a5218}
.act-btn{margin-top:12px;width:100%;padding:12px 18px;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
.act-primary{background:var(--fjord-800);color:#fff}
.act-primary:hover{background:var(--fjord-700)}
.act-secondary{background:var(--canvas-2);color:var(--ink);border:1px solid var(--line)}
.suggest-box{margin-top:16px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--canvas-2)}
.suggest-box label{display:block;font-size:.84rem;font-weight:700;color:var(--ink-soft);margin-bottom:6px}
.suggest-box input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:.95rem;background:var(--surface);color:var(--ink)}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav" aria-label="Navigasjon">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="brand-word">opplevagent<span class="tld">.no</span></span></a>
  </div>
</nav>
<main id="main" class="container">
  <div class="confirm-panel">
${inner}
  </div>
</main>
</body>
</html>`;
}

function previsitRecapHtml(booking: GardssalgBooking, forProducer: boolean): string {
  return `<div class="recap">
      <div><strong>Dato/tid:</strong> ${escapeHtml(previsitSlotNb(booking.slot_at))}</div>
      ${booking.suggested_slot_at && booking.pre_status === "time_suggested" ? `<div><strong>Foreslått nytt tidspunkt:</strong> ${escapeHtml(previsitSlotNb(booking.suggested_slot_at))}</div>` : ""}
      <div><strong>Antall:</strong> ${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</div>
      ${forProducer ? `<div><strong>Gjest:</strong> ${escapeHtml(booking.guest_name)}</div>
      <div><strong>E-post:</strong> ${escapeHtml(booking.guest_email)}</div>
      ${booking.guest_phone ? `<div><strong>Telefon:</strong> ${escapeHtml(booking.guest_phone)}</div>` : ""}
      ${booking.notes ? `<div><strong>Kommentar fra gjesten:</strong> ${escapeHtml(booking.notes)}</div>` : ""}` : ""}
    </div>`;
}

// GET /kategori/gardssalg/svar/:token — producer answer page. Unknown token →
// 404. Used/expired token → friendly page WITHOUT actions (and the POST below
// refuses to mutate in the same states). A valid token renders the three
// choices as POST buttons — prefetch-safe by construction.
router.get(
  "/kategori/gardssalg/svar/:token",
  (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.params.token || "");
    if (!token) return next();
    let booking: GardssalgBooking | null = null;
    try {
      booking = getBookingByRespondToken(token);
    } catch {
      booking = null;
    }
    if (!booking) return next();

    const provider = getProviderById(booking.provider_id) as { navn?: string | null } | null;
    const state = respondTokenState(booking);
    const statusLabel = PRE_STATUS_LABEL[booking.pre_status] || booking.pre_status;

    const done = String(req.query.done || "");
    const errorParam = String(req.query.error || "");
    const banner =
      done === "bekreftet"
        ? `<div class="bekreft-banner ok" role="status">Reservasjonen er bekreftet — gjesten har fått beskjed.</div>`
        : done === "avslatt"
          ? `<div class="bekreft-banner ok" role="status">Forespørselen er avslått — gjesten har fått beskjed.</div>`
          : done === "foreslatt"
            ? `<div class="bekreft-banner ok" role="status">Forslaget er sendt til gjesten — du får e-post når gjesten svarer.</div>`
            : errorParam === "ugyldig_tid"
              ? `<div class="bekreft-banner warn" role="alert">Ugyldig tidspunkt — velg et tidspunkt frem i tid.</div>`
              : errorParam
                ? `<div class="bekreft-banner warn" role="alert">Kunne ikke registrere svaret. Prøv igjen.</div>`
                : "";

    let actionsHtml = "";
    if (!previsitOpen(booking)) {
      // Post-visit already resolved (attended/no_show) or booking cancelled —
      // pre-visit answers are moot (review finding 3). Friendly, no actions.
      actionsHtml = `<div class="bekreft-banner warn" role="status">${
        booking.status === "cancelled"
          ? "Reservasjonen er kansellert — forespørselen kan ikke lenger besvares."
          : "Besøket er allerede registrert (oppmøte-siden) — forhåndssvar er ikke lenger aktuelt for denne reservasjonen."
      }</div>`;
    } else if (state !== "ok") {
      // Friendly no-action page: used or expired — never a mutation, never a
      // 404. NB the expired text must be TRUE in both reachable states
      // (pre_status already 'expired' vs. a time_suggested/awaiting row whose
      // deadline passed but the followup engine hasn't run yet): the closure
      // + guest notification happen automatically, they may not have happened
      // YET (review finding 1c).
      actionsHtml = `<div class="bekreft-banner warn" role="status">${
        state === "used"
          ? "Denne svarlenken er allerede brukt — forespørselen er besvart."
          : "Denne svarlenken er utløpt — forespørselen avsluttes automatisk og gjesten får beskjed."
      }</div>`;
    } else {
      const postTo = `/kategori/gardssalg/svar/${encodeURIComponent(token)}`;
      const confirmBtn = booking.pre_status === "awaiting_provider"
        ? `<form method="POST" action="${postTo}"><input type="hidden" name="action" value="bekreft"><button type="submit" class="act-btn act-primary">Bekreft reservasjonen</button></form>`
        : "";
      // UX 2026-07-30: after a submit the flash `banner` above already says
      // «Forslaget er sendt til gjesten …» — repeating it here read as two
      // near-identical green boxes (Daniels E2E-skjermbilde). The standing
      // note now only appears when there is NO flash, and leads with what
      // the producer can still DO.
      const waitingNote = booking.pre_status === "time_suggested" && done !== "foreslatt"
        ? `<div class="bekreft-banner ok" role="status">Venter på svar fra gjesten. Du kan foreslå et annet tidspunkt (erstatter forslaget) eller avslå.</div>`
        : "";
      actionsHtml = `${waitingNote}
    ${confirmBtn}
    <form method="POST" action="${postTo}" class="suggest-box">
      <input type="hidden" name="action" value="foresla">
      <label for="suggested_slot">Foreslå nytt tidspunkt (norsk tid)</label>
      <input id="suggested_slot" name="suggested_slot" type="datetime-local" required>
      <button type="submit" class="act-btn act-secondary">Send forslag til gjesten</button>
    </form>
    <form method="POST" action="${postTo}"><input type="hidden" name="action" value="avsla"><button type="submit" class="act-btn act-secondary">Avslå forespørselen</button></form>`;
    }

    const inner = `    <h1>Reservasjonsforespørsel hos ${escapeHtml(provider?.navn || "deg")}</h1>
    <div class="ref">${escapeHtml(booking.booking_ref)}</div>
    ${banner}
    <div class="status-line">Status: <strong>${escapeHtml(statusLabel)}</strong></div>
    ${previsitRecapHtml(booking, true)}
    ${actionsHtml}
    <p class="hint">Denne siden er for produsenten. Lenken er personlig for denne forespørselen${booking.respond_token_expires_at ? ` og utløper automatisk ${escapeHtml(previsitSlotNb(booking.respond_token_expires_at))}` : ""} — ikke del den videre.</p>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(previsitPage(`Svar på forespørsel — ${booking.booking_ref}`, inner));
  },
);

// POST /kategori/gardssalg/svar/:token — the producer's actual answer.
// Used/expired tokens and unknown actions mutate NOTHING (PRG back to the
// friendly GET). Guest notification emails are fire-and-forget, mirroring
// every other booking email call site.
router.post(
  "/kategori/gardssalg/svar/:token",
  express.urlencoded({ extended: false }),
  (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.params.token || "");
    if (!token) return next();
    let booking: GardssalgBooking | null = null;
    try {
      booking = getBookingByRespondToken(token);
    } catch {
      booking = null;
    }
    if (!booking) return next();

    const backTo = `/kategori/gardssalg/svar/${encodeURIComponent(token)}`;
    if (!previsitOpen(booking) || respondTokenState(booking) !== "ok") {
      // Post-visit already resolved/cancelled, or the token is used/expired —
      // the friendly GET explains why; nothing was mutated.
      res.redirect(303, backTo);
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "bekreft") {
      const updated = producerRespondConfirm(token);
      if (!updated) {
        res.redirect(303, `${backTo}?error=ugyldig`);
        return;
      }
      sendPrevisitConfirmedToGuest(updated).catch((e) =>
        console.error("[booking-previsit] guest confirm email failed", updated.booking_ref, e),
      );
      res.redirect(303, `${backTo}?done=bekreftet`);
      return;
    }

    if (action === "avsla") {
      const updated = producerRespondDecline(token);
      if (!updated) {
        res.redirect(303, `${backTo}?error=ugyldig`);
        return;
      }
      sendPrevisitDeclinedToGuest(updated).catch((e) =>
        console.error("[booking-previsit] guest decline email failed", updated.booking_ref, e),
      );
      res.redirect(303, `${backTo}?done=avslatt`);
      return;
    }

    if (action === "foresla") {
      const suggested = String(body.suggested_slot || "").trim();
      const updated = producerSuggestTime(token, suggested);
      if (!updated) {
        res.redirect(303, `${backTo}?error=ugyldig_tid`);
        return;
      }
      sendSuggestionToGuest(updated).catch((e) =>
        console.error("[booking-previsit] guest suggestion email failed", updated.booking_ref, e),
      );
      res.redirect(303, `${backTo}?done=foreslatt`);
      return;
    }

    res.redirect(303, `${backTo}?error=ugyldig`);
  },
);

// GET /kategori/gardssalg/gjestesvar/:token — the guest's decision page for a
// producer-suggested time. Unknown token → 404 (also covers rotated-away
// tokens from a re-suggest). No longer actionable (the pre_status moved on) →
// friendly outcome page, no actions, no mutation.
router.get(
  "/kategori/gardssalg/gjestesvar/:token",
  (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.params.token || "");
    if (!token) return next();
    let booking: GardssalgBooking | null = null;
    try {
      booking = getBookingByGuestDecisionToken(token);
    } catch {
      booking = null;
    }
    if (!booking) return next();

    const provider = getProviderById(booking.provider_id) as { navn?: string | null } | null;
    const statusLabel = PRE_STATUS_LABEL[booking.pre_status] || booking.pre_status;
    // Actionable = still time_suggested AND within the loop's expiry window
    // AND the suggested time itself not yet passed (review finding 1 — an
    // acceptance may never land in the past) AND post-visit still 'reserved'.
    const actionable = guestDecisionActionable(booking);

    const done = String(req.query.done || "");
    const banner =
      done === "akseptert"
        ? `<div class="bekreft-banner ok" role="status">Du har akseptert det nye tidspunktet — reservasjonen er bekreftet.</div>`
        : done === "avslatt"
          ? `<div class="bekreft-banner ok" role="status">Du har avslått forslaget. Vi beklager at tidspunktet ikke passet.</div>`
          : "";

    let inner: string;
    if (!actionable) {
      // Distinguish "the loop timed out under you" (still time_suggested, but
      // the deadline or the suggested time passed) from the generic
      // already-answered case — the timed-out text must be true BEFORE the
      // followup engine has flipped the row to expired.
      const timedOut = booking.pre_status === "time_suggested" && previsitOpen(booking);
      inner = `    <h1>Reservasjon hos ${escapeHtml(provider?.navn || "produsenten")}</h1>
    <div class="ref">${escapeHtml(booking.booking_ref)}</div>
    ${banner}
    <div class="bekreft-banner warn" role="status">${
      timedOut
        ? "Fristen for å svare på forslaget er dessverre ute — forespørselen avsluttes automatisk, og du får beskjed på e-post."
        : "Denne lenken er allerede besvart eller ikke lenger aktiv."
    }</div>
    <div class="status-line">Status: <strong>${escapeHtml(statusLabel)}</strong></div>
    ${previsitRecapHtml(booking, false)}
    <p class="hint">Trenger du hjelp? Svar på bekreftelses-e-posten din.</p>`;
    } else {
      const postTo = `/kategori/gardssalg/gjestesvar/${encodeURIComponent(token)}`;
      inner = `    <h1>Nytt tidspunkt foreslått — ${escapeHtml(provider?.navn || "produsenten")}</h1>
    <div class="ref">${escapeHtml(booking.booking_ref)}</div>
    ${banner}
    <div class="status-line">Produsenten kan ikke ta imot besøket ${escapeHtml(previsitSlotNb(booking.slot_at))}, men foreslår i stedet:</div>
    <div class="status-line"><strong>${escapeHtml(previsitSlotNb(booking.suggested_slot_at))}</strong></div>
    ${previsitRecapHtml(booking, false)}
    <form method="POST" action="${postTo}"><input type="hidden" name="action" value="aksepter"><button type="submit" class="act-btn act-primary">Aksepter det nye tidspunktet</button></form>
    <form method="POST" action="${postTo}"><input type="hidden" name="action" value="avsla"><button type="submit" class="act-btn act-secondary">Tidspunktet passer ikke — avslå</button></form>
    <p class="hint">Lenken er personlig for din reservasjon — ikke del den videre.</p>`;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(previsitPage(`Nytt tidspunkt — ${booking.booking_ref}`, inner));
  },
);

// POST /kategori/gardssalg/gjestesvar/:token — guest accepts/declines the
// suggested time. One-shot by state machine: once the pre_status leaves
// time_suggested, further POSTs mutate nothing (PRG to the friendly GET).
router.post(
  "/kategori/gardssalg/gjestesvar/:token",
  express.urlencoded({ extended: false }),
  (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.params.token || "");
    if (!token) return next();
    let booking: GardssalgBooking | null = null;
    try {
      booking = getBookingByGuestDecisionToken(token);
    } catch {
      booking = null;
    }
    if (!booking) return next();

    const backTo = `/kategori/gardssalg/gjestesvar/${encodeURIComponent(token)}`;
    if (!guestDecisionActionable(booking)) {
      // Already answered, timed out, or post-visit closed — friendly GET
      // explains which; nothing is mutated (the service guards again anyway).
      res.redirect(303, backTo);
      return;
    }

    const action = String(((req.body || {}) as Record<string, unknown>).action || "");
    if (action === "aksepter") {
      const updated = guestAcceptSuggestion(token);
      if (!updated) {
        res.redirect(303, backTo);
        return;
      }
      // Both parties get the outcome: guest confirmation (transactional) +
      // producer notification (through the dispatch gates).
      sendPrevisitConfirmedToGuest(updated, true).catch((e) =>
        console.error("[booking-previsit] guest accept email failed", updated.booking_ref, e),
      );
      sendGuestDecisionToProducer(updated, true).catch((e) =>
        console.error("[booking-previsit] producer accept notice failed", updated.booking_ref, e),
      );
      res.redirect(303, `${backTo}?done=akseptert`);
      return;
    }

    if (action === "avsla") {
      const updated = guestDeclineSuggestion(token);
      if (!updated) {
        res.redirect(303, backTo);
        return;
      }
      sendGuestDecisionToProducer(updated, false).catch((e) =>
        console.error("[booking-previsit] producer decline notice failed", updated.booking_ref, e),
      );
      res.redirect(303, `${backTo}?done=avslatt`);
      return;
    }

    res.redirect(303, backTo);
  },
);

// GET /kategori/gardssalg/status/:booking_ref/:guest_token — the guest's
// always-readable status page (no login). Pure read: shows the current
// pre-visit status + agreed/suggested time. Token must match the row's
// guest_status_token; anything else → 404 (never reveals whether a ref
// exists). Never mutates.
router.get(
  "/kategori/gardssalg/status/:bookingRef/:guestToken",
  (req: Request, res: Response, next: NextFunction) => {
    const bookingRef = String(req.params.bookingRef || "");
    const guestToken = String(req.params.guestToken || "");
    if (!bookingRef || !guestToken) return next();
    let booking: GardssalgBooking | null = null;
    try {
      booking = getBookingByRef(bookingRef);
    } catch {
      booking = null;
    }
    if (!booking || !booking.guest_status_token || booking.guest_status_token !== guestToken) {
      return next();
    }

    const provider = getProviderById(booking.provider_id) as { navn?: string | null } | null;
    const statusLabel = PRE_STATUS_LABEL[booking.pre_status] || booking.pre_status;
    const extra =
      booking.pre_status === "expired"
        ? `<div class="bekreft-banner warn" role="status">Vi beklager — forespørselen ble dessverre ikke avklart i tide og er utløpt. <a href="/kategori/gardssalg">Se alternative tilbydere her</a>.</div>`
        : booking.pre_status === "provider_declined"
          ? `<div class="bekreft-banner warn" role="status">Vi beklager at forespørselen ikke kunne bekreftes. <a href="/kategori/gardssalg">Se alternative tilbydere her</a>.</div>`
          : booking.pre_status === "time_suggested"
            ? `<div class="bekreft-banner ok" role="status">Sjekk e-posten din — du har fått en lenke for å akseptere eller avslå det nye tidspunktet.</div>`
            : booking.pre_status === "provider_confirmed"
              ? `<div class="bekreft-banner ok" role="status">Reservasjonen er bekreftet — velkommen!</div>`
              : "";

    const inner = `    <h1>Reservasjon hos ${escapeHtml(provider?.navn || "produsenten")}</h1>
    <div class="ref">${escapeHtml(booking.booking_ref)}</div>
    <div class="status-line">Status: <strong>${escapeHtml(statusLabel)}</strong></div>
    ${extra}
    ${previsitRecapHtml(booking, false)}
    <p class="hint">Denne siden viser alltid gjeldende status for reservasjonen din. Lenken er personlig — ikke del den videre.</p>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(previsitPage(`Status — ${booking.booking_ref}`, inner));
  },
);

// GEO: FAQPage JSON-LD for category pages (dev-request
// 2026-06-30-geo-content-structured-data, category/city slice). The
// producer-vertical city page already has this (buildCityFaqJsonLd,
// routes/seo.ts); this is the category-page half, for the experiences
// (Opplevagent) vertical's /kategori/:category listing. Answers are built
// strictly from getCategoryFaqStats() aggregates over the SAME
// publish-gated rows the page itself lists — never fabricated. Quality-gated
// exactly like buildProducerFaqJsonLd/buildCityFaqJsonLd: null unless at
// least 2 questions have a real, catalog-backed answer, so a category with no
// distinguishing signal (single fylke, no stated prices) stays without FAQ
// schema rather than emit a thin/templated block.
export function buildCategoryFaqJsonLd(params: {
  label: string;
  url: string;
  total: number;
  fylkeCount: number;
  kommuneCount: number;
  minPriceFrom: number | null;
}): any | null {
  const qas: Array<{ q: string; a: string }> = [];

  if (params.total > 0) {
    qas.push({
      q: `Hvor mange opplevelser finnes i kategorien ${params.label}?`,
      a: `Det er ${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"} i kategorien ${params.label} på Opplevagent.`,
    });
  }

  if (params.fylkeCount > 0) {
    const kommuneClause = params.kommuneCount > 0
      ? ` fordelt på ${params.kommuneCount} ${params.kommuneCount === 1 ? "kommune" : "kommuner"}`
      : "";
    qas.push({
      q: `I hvor mange fylker finnes ${params.label}?`,
      a: `${params.label} finnes i ${params.fylkeCount} ${params.fylkeCount === 1 ? "fylke" : "fylker"} på Opplevagent${kommuneClause}.`,
    });
  }

  if (params.minPriceFrom !== null && params.minPriceFrom >= 0) {
    qas.push({
      q: `Hva koster opplevelser i kategorien ${params.label}?`,
      a: `Prisene i kategorien ${params.label} starter fra ${params.minPriceFrom} kr — alle tilbydere er verifisert mot Brønnøysundregistrene.`,
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

// GEO: FAQPage JSON-LD for kommune (municipality) pages — the "city" half of
// the same dev-request slice, for the experiences vertical's
// /kommune/:kommune listing. Same shape/quality-gate as
// buildCategoryFaqJsonLd(); see getKommuneFaqStats() for the aggregate query.
export function buildKommuneFaqJsonLd(params: {
  kommune: string;
  fylke: string | null;
  url: string;
  total: number;
  categoryCount: number;
  minPriceFrom: number | null;
}): any | null {
  const qas: Array<{ q: string; a: string }> = [];

  if (params.total > 0) {
    qas.push({
      q: `Hvor mange opplevelser finnes i ${params.kommune}?`,
      a: `Det er ${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"} i ${params.kommune}${params.fylke ? ` (${params.fylke})` : ""} på Opplevagent.`,
    });
  }

  if (params.categoryCount > 0) {
    qas.push({
      q: `Hva slags opplevelser kan jeg finne i ${params.kommune}?`,
      a: `Opplevelsene i ${params.kommune} spenner over ${params.categoryCount} ${params.categoryCount === 1 ? "kategori" : "kategorier"} på Opplevagent.`,
    });
  }

  if (params.minPriceFrom !== null && params.minPriceFrom >= 0) {
    qas.push({
      q: `Hva koster en opplevelse i ${params.kommune}?`,
      a: `Prisene i ${params.kommune} starter fra ${params.minPriceFrom} kr — alle tilbydere er verifisert mot Brønnøysundregistrene.`,
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

// GEO: answer-first SSR opening for category pages (dev-request
// 2026-06-30-geo-content-structured-data, answer-first-opening slice). AI
// engines weight relevance heavily on a page's opening text, so this
// replaces the generic "Opplevelser i kategorien X." lede with a single
// sentence that states upfront what the page has (count, spread, price) —
// using the EXACT same getCategoryFaqStats() aggregate already verified real
// for buildCategoryFaqJsonLd above. Same quality gate: needs >=2 real facts,
// otherwise returns null so the caller falls back to the existing generic
// lede untouched (the caller MUST log that fallback, not swallow it — see
// the PR-149 incident note in the dev-request: a silent catch-and-null
// shipped a feature tests-green but broken in prod).
export function buildCategoryAnswerFirstOpening(params: {
  label: string;
  total: number;
  fylkeCount: number;
  kommuneCount: number;
  minPriceFrom: number | null;
}): string | null {
  const hasTotal = params.total > 0;
  const hasFylke = params.fylkeCount > 0;
  const hasPrice = params.minPriceFrom !== null && params.minPriceFrom >= 0;

  const factCount = (hasTotal ? 1 : 0) + (hasFylke ? 1 : 0) + (hasPrice ? 1 : 0);
  if (factCount < 2) return null;

  const countPhrase = hasTotal
    ? `${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"}`
    : "opplevelser";
  const spreadPhrase = hasFylke
    ? ` i ${params.fylkeCount} ${params.fylkeCount === 1 ? "fylke" : "fylker"}${params.kommuneCount > 0 ? ` (${params.kommuneCount} ${params.kommuneCount === 1 ? "kommune" : "kommuner"})` : ""}`
    : "";
  const pricePhrase = hasPrice ? `, fra ${params.minPriceFrom} kr` : "";

  return `${params.label} på Opplevagent: ${countPhrase}${spreadPhrase}${pricePhrase} — håndplukket og verifisert mot Brønnøysundregistrene.`;
}

// GEO: answer-first SSR opening for kommune (municipality) pages — the
// "city" half of the same answer-first-opening slice, mirroring
// buildCategoryAnswerFirstOpening() above. Grounded strictly in the same
// getKommuneFaqStats() aggregate already verified real for
// buildKommuneFaqJsonLd. Same quality gate, same fail-safe-and-log-on-fallback
// contract.
export function buildKommuneAnswerFirstOpening(params: {
  kommune: string;
  fylke: string | null;
  total: number;
  categoryCount: number;
  minPriceFrom: number | null;
}): string | null {
  const hasTotal = params.total > 0;
  const hasCategories = params.categoryCount > 0;
  const hasPrice = params.minPriceFrom !== null && params.minPriceFrom >= 0;

  const factCount = (hasTotal ? 1 : 0) + (hasCategories ? 1 : 0) + (hasPrice ? 1 : 0);
  if (factCount < 2) return null;

  const countPhrase = hasTotal
    ? `${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"}`
    : "opplevelser";
  const categoryPhrase = hasCategories
    ? ` fordelt på ${params.categoryCount} ${params.categoryCount === 1 ? "kategori" : "kategorier"}`
    : "";
  const pricePhrase = hasPrice ? `, fra ${params.minPriceFrom} kr` : "";
  const fylkePart = params.fylke ? ` (${params.fylke})` : "";

  return `Opplevelser i ${params.kommune}${fylkePart}: ${countPhrase}${categoryPhrase}${pricePhrase} — håndplukket og verifisert mot Brønnøysundregistrene.`;
}

// GEO: FAQPage JSON-LD for the produkt×by "query landing pages" — the final
// remaining slice of dev-request 2026-06-30-geo-content-structured-data.
// Programmatic `/kategori/:category/:kommune` pages targeting the exact
// question users ask AI assistants ("Hvor får jeg [produkt] i [by]?"),
// answers built strictly from getProduktByStats()'s aggregate over the SAME
// publish-gated rows the page itself lists — never fabricated. Same
// ≥2-real-facts quality gate as buildCategoryFaqJsonLd/buildKommuneFaqJsonLd,
// BUT unlike those two, the route handler below treats this gate as the page
// existence gate too (not just the FAQ block) — see the route comment for
// why: a produkt×by combo is much more likely to be a thin single-item cell
// than a whole category or whole kommune is, so this slice intentionally
// applies the quality bar one level earlier (no page at all, not just no FAQ
// block) to avoid ever serving/indexing a near-empty combinatorial page.
export function buildProduktByFaqJsonLd(params: {
  categoryLabel: string;
  kommune: string;
  fylke: string | null;
  url: string;
  total: number;
  providerCount: number;
  minPriceFrom: number | null;
}): any | null {
  const qas: Array<{ q: string; a: string }> = [];
  const labelLc = params.categoryLabel.toLowerCase();

  if (params.total > 0) {
    qas.push({
      q: `Hvor får jeg ${labelLc} i ${params.kommune}?`,
      a: `Det er ${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"} innen ${labelLc} i ${params.kommune}${params.fylke ? ` (${params.fylke})` : ""} på Opplevagent.`,
    });
  }

  if (params.providerCount > 0) {
    qas.push({
      q: `Hvor mange tilbydere av ${labelLc} finnes i ${params.kommune}?`,
      a: `${params.providerCount} verifiserte ${params.providerCount === 1 ? "tilbyder" : "tilbydere"} av ${labelLc} i ${params.kommune} er listet på Opplevagent — alle sjekket mot Brønnøysundregistrene.`,
    });
  }

  if (params.minPriceFrom !== null && params.minPriceFrom >= 0) {
    qas.push({
      q: `Hva koster ${labelLc} i ${params.kommune}?`,
      a: `Prisene for ${labelLc} i ${params.kommune} starter fra ${params.minPriceFrom} kr.`,
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

// GEO: answer-first SSR opening for the produkt×by query landing pages —
// mirrors buildCategoryAnswerFirstOpening/buildKommuneAnswerFirstOpening,
// grounded in the SAME getProduktByStats() aggregate already verified real
// for buildProduktByFaqJsonLd above. Same quality gate, same
// fail-safe-and-log-on-fallback contract (never a silent catch-and-null —
// see the PR-149 incident note in the dev-request).
export function buildProduktByAnswerFirstOpening(params: {
  categoryLabel: string;
  kommune: string;
  fylke: string | null;
  total: number;
  providerCount: number;
  minPriceFrom: number | null;
}): string | null {
  const hasTotal = params.total > 0;
  const hasProviders = params.providerCount > 0;
  const hasPrice = params.minPriceFrom !== null && params.minPriceFrom >= 0;

  const factCount = (hasTotal ? 1 : 0) + (hasProviders ? 1 : 0) + (hasPrice ? 1 : 0);
  if (factCount < 2) return null;

  const labelLc = params.categoryLabel.toLowerCase();
  const countPhrase = hasTotal
    ? `${params.total} ${params.total === 1 ? "opplevelse" : "opplevelser"}`
    : "opplevelser";
  const providerPhrase = hasProviders
    ? ` fra ${params.providerCount} ${params.providerCount === 1 ? "tilbyder" : "tilbydere"}`
    : "";
  const pricePhrase = hasPrice ? `, fra ${params.minPriceFrom} kr` : "";
  const fylkePart = params.fylke ? ` (${params.fylke})` : "";

  return `${params.categoryLabel} i ${params.kommune}${fylkePart}: ${countPhrase}${providerPhrase}${pricePhrase} — håndplukket og verifisert mot Brønnøysundregistrene.`;
}

// Category slug -> still-sketch motif (dev-request 2026-08-08-opplevagent-
// ux-loft-kategorimotiver): only these 3 categories get their own drawing in
// this slice (the other 6 live category slugs — vinter_sno, dyreliv_safari,
// overnatting_opplevelse, adrenalin_action, velvaere_spa, mat_drikke — are
// separate future dev-requests); gardssalg keeps its own dedicated route +
// motif above and never reaches this generic handler.
const CATEGORY_STILL_SKETCH_MOTIF: Partial<Record<string, StillSketchMotif>> = {
  kultur_historie: "kultur_historie",
  sightseeing_transport: "sightseeing_transport",
  natur_friluft: "natur_friluft",
};

// ─── GET /kategori/:category — experiences in a category ─────────────────────
router.get("/kategori/:category", (req: Request, res: Response, next: NextFunction) => {
  const category = String(req.params.category || "");
  if (!category) return next();
  let total = 0;
  let rows: ExperienceCardRow[] = [];
  const page = parsePage(req.query.page);
  try {
    total = countPublishedExperiences({ category });
    if (total === 0) return next(); // unknown/empty category → 404 (no orphan page)
  } catch {
    return next();
  }

  // dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info, Goal 1:
  // a ?q= hit on the category page itself (e.g. a shared/bookmarked search
  // URL, since this page's own searchBox() actually posts to /sok — see that
  // handler for the boost-grouping + route-intent detection this redirects
  // into) is forwarded to /sok with the category carried along as the boost
  // context, rather than silently ignored. Keeps route-intent detection and
  // the grouped-results rendering in the ONE place (/sok) instead of
  // duplicating either here.
  const boostQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (boostQ) {
    const params = new URLSearchParams({ q: boostQ, category });
    return res.redirect(302, `/sok?${params.toString()}`);
  }

  try {
    rows = listPublishedExperiences({ category }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch {
    return next();
  }

  const label = catLabel(category);
  const canonicalPath = `/kategori/${encodeURIComponent(category)}`;
  const genericLede = `Opplevelser i kategorien ${label.toLowerCase()}.`;
  // GEO: FAQPage JSON-LD — see buildCategoryFaqJsonLd for the quality gate.
  // The same getCategoryFaqStats() aggregate also feeds the answer-first
  // opening paragraph (buildCategoryAnswerFirstOpening) below — one query,
  // two GEO features sharing one quality gate. Never allowed to break the
  // page: on any error we fail safe to no FAQ block + the generic lede, but
  // log a structured, low-noise diagnostic so a regression here (e.g. schema
  // drift) is visible in Fly logs without a live DB shell — this must NOT be
  // a silent catch-and-null (that exact bug shipped a feature tests-green
  // but silently broken in prod, see dev-request PR-149 note).
  let categoryFaqJsonLd: ReturnType<typeof buildCategoryFaqJsonLd> = null;
  let lede = genericLede;
  try {
    const stats = getCategoryFaqStats(category);
    categoryFaqJsonLd = buildCategoryFaqJsonLd({
      label,
      url: `${baseUrl()}${canonicalPath}`,
      total,
      fylkeCount: stats.fylkeCount,
      kommuneCount: stats.kommuneCount,
      minPriceFrom: stats.minPriceFrom,
    });
    const answerFirst = buildCategoryAnswerFirstOpening({
      label,
      total,
      fylkeCount: stats.fylkeCount,
      kommuneCount: stats.kommuneCount,
      minPriceFrom: stats.minPriceFrom,
    });
    if (answerFirst) {
      lede = answerFirst;
    } else {
      console.log(`[experiences-seo] /kategori/${category}: answer-first opening skipped (insufficient real facts) — falling back to generic lede`);
    }
  } catch (e) {
    console.error(`[experiences-seo] /kategori/${category} FAQ stats failed:`, e);
    categoryFaqJsonLd = null;
    lede = genericLede;
  }

  const html = renderBrowsePage({
    lang: req.lang,
    title: `${label} | Opplevagent`,
    h1: label,
    metaDesc: `${label} i Norge — håndplukkede opplevelser på Opplevagent med Brreg-verifiserte tilbydere. ${total} ${total === 1 ? "opplevelse" : "opplevelser"} i kategorien.`,
    lede,
    canonicalPath,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: label }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox("", { category }),
    extraJsonLd: categoryFaqJsonLd ? [categoryFaqJsonLd] : undefined,
    // dev-request 2026-08-08-opplevagent-ux-loft-kategorimotiver: category
    // pages adopt the shared S1 chrome (hamburger nav + full footer incl.
    // "For tilbydere") — the pre-existing slim BROWSE_NAV/browseFooter() this
    // route used to render is gone. "kategorier" is the closest oaSiteNav()
    // item (there's no per-category active state in that nav).
    useSharedChrome: true,
    navActive: "kategorier",
    sketchMotif: CATEGORY_STILL_SKETCH_MOTIF[category],
    // Daniel 2026-08-24: the category page announces its own colour — same
    // categoryColor() the cards in the grid below it are painted with.
    accentColor: categoryColor(category),
    accentLabel: "Kategori",
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// ─── GET /fylke/:fylke — experiences in a county ─────────────────────────────
router.get("/fylke/:fylke", (req: Request, res: Response, next: NextFunction) => {
  const fylke = String(req.params.fylke || "");
  if (!fylke) return next();
  let total = 0;
  let rows: ExperienceCardRow[] = [];
  const page = parsePage(req.query.page);
  try {
    total = countPublishedExperiences({ fylke });
    if (total === 0) {
      // Exact match failed — before giving up, try a case/diacritic-insensitive
      // match against the live fylke list, so a differently-cased or
      // ascii-folded URL (e.g. /fylke/troms) 301s to the canonical, correctly
      // cased path instead of 404ing. Only a UNIQUE fold match redirects — zero
      // matches, or more than one (ambiguous — never seen in real data today,
      // but two distinctly-cased/spelled live fylke rows folding to the same
      // key is a latent risk this must never guess through), fall through to
      // the existing next() 404 unchanged.
      const foldedParam = foldPlaceSlug(fylke);
      const matches = listPublishedFylker().filter((f) => foldPlaceSlug(f.fylke) === foldedParam);
      if (matches.length === 1 && matches[0].fylke !== fylke) {
        return res.redirect(301, `/fylke/${encodeURIComponent(matches[0].fylke)}`);
      }

      // ── dev-request 2026-08-07-orch-fylke-2024-migrasjon: historical fylke
      // name fallback — reached ONLY when both the exact match AND the
      // fold-match above missed (a historical name has, by definition, zero
      // live rows under its own literal string, so the fold-match above
      // never finds it either). Two shapes, checked in this order:
      //
      //   1. A 1:1 historical alias (e.g. "Hordaland" → "Vestland",
      //      "Sør-Trøndelag" → "Trøndelag") — norway-fylke.ts's
      //      ALIAS_TO_CANONICAL map, keyed by the SAME fold/normalize
      //      convention (key()) this file already uses for foldPlaceSlug-
      //      style matching, so a differently-cased URL segment still
      //      resolves (a real URL param is capitalized, e.g. "Hordaland",
      //      never the map's lowercase key form itself). Three of
      //      ALIAS_TO_CANONICAL's entries ("viken", "vestfoldogtelemark"/
      //      "vestfold og telemark", "tromsogfinnmark"/"troms og finnmark")
      //      are self-mapping placeholders for the BROAD merged names —
      //      norway-fylke.ts's own comment says as much — so those are
      //      explicitly excluded here and handled by branch 2 instead.
      //   2. One of the three merged/split legacy names itself (Viken /
      //      Vestfold og Telemark / Troms og Finnmark) — redirects to
      //      whichever successor fylke in that EQUIVALENCE_CLASSES class
      //      currently has the HIGHEST published count, computed LIVE from
      //      listPublishedFylker() on every request (never a hardcoded
      //      guess — today's winner can change as new experiences/providers
      //      are published), alphabetically-first as the tie-break.
      //
      // Either branch falls through to the existing next() 404 below when
      // its target(s) currently have zero published rows — this must never
      // redirect a visitor into an empty page.
      const paramKey = fylkeFoldKey(fylke);
      const mergedLegacyNames = new Set(EQUIVALENCE_CLASSES.map((cls) => cls[0]));
      const aliasCanonical = paramKey ? ALIAS_TO_CANONICAL[paramKey] : undefined;

      if (aliasCanonical && !mergedLegacyNames.has(aliasCanonical)) {
        const liveTarget = listPublishedFylker().find((f) => f.fylke === aliasCanonical);
        if (liveTarget && liveTarget.count > 0) {
          return res.redirect(301, `/fylke/${encodeURIComponent(aliasCanonical)}`);
        }
        return next();
      }

      const legacyClass = paramKey
        ? EQUIVALENCE_CLASSES.find((cls) => fylkeFoldKey(cls[0]) === paramKey)
        : undefined;
      if (legacyClass) {
        const liveRows = listPublishedFylker();
        let best: { fylke: string; count: number } | null = null;
        for (const successor of legacyClass.slice(1)) {
          const row = liveRows.find((f) => f.fylke === successor);
          if (!row || row.count <= 0) continue;
          if (!best || row.count > best.count || (row.count === best.count && successor < best.fylke)) {
            best = { fylke: successor, count: row.count };
          }
        }
        if (best) {
          return res.redirect(301, `/fylke/${encodeURIComponent(best.fylke)}`);
        }
        return next(); // none of this class's successors currently have any published rows
      }

      return next(); // unknown/empty fylke → 404 (no orphan page)
    }
  } catch {
    return next();
  }

  // dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info, Goal 1:
  // mirrors /kategori/:category's own redirect above — a ?q= hit on the
  // fylke page itself forwards to /sok with the fylke carried along as the
  // boost context, keeping route-intent detection + grouped rendering in the
  // one place (/sok) rather than duplicated here.
  const boostQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (boostQ) {
    const params = new URLSearchParams({ q: boostQ, fylke });
    return res.redirect(302, `/sok?${params.toString()}`);
  }

  try {
    rows = listPublishedExperiences({ fylke }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch {
    return next();
  }

  // dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1: map
  // markers for ALL published experiences in this fylke with a real geocode —
  // deliberately NOT scoped to the current page/pagination or to an active
  // "nærmest deg" geo sort (the dev-request spec is explicit: "kart over ALLE
  // publiserte opplevelser i fylket"). A failure here must never break the
  // page itself (the card list is the primary content) — defaults to no map
  // section (renderFylkeMapSection returns "" for an empty array).
  let mapPoints: ExperienceMapPoint[] = [];
  try {
    mapPoints = listPublishedExperienceMapPoints({ fylke });
  } catch (e) {
    console.error(`[experiences-seo] /fylke/${fylke} map points failed:`, e);
    mapPoints = [];
  }

  // dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 4: "nærmest deg
  // først" sort — PROGRESSIVE ENHANCEMENT ONLY. With no valid geo origin (or
  // no explicit sort=distance), resolvePlaceGeoSort's geoActive is false and
  // every `effective*` value below is exactly the SSR value computed above —
  // byte-identical to before this feature existed.
  const fylkeCanonicalPath = `/fylke/${encodeURIComponent(fylke)}`;
  const geoSort = resolvePlaceGeoSort(req, { fylke });
  const effectiveRows = geoSort.geoActive && geoSort.rows ? geoSort.rows : rows;
  const effectiveTotal = geoSort.geoActive && geoSort.rows ? geoSort.rows.length : total;
  const effectivePage = geoSort.geoActive ? 1 : page;
  const effectivePageSize = geoSort.geoActive ? Math.max(effectiveTotal, 1) : BROWSE_PAGE_SIZE;
  const geoQueryForToggle: Record<string, string | undefined> = geoSort.geoOrigin
    ? { lat: String(geoSort.geoOrigin.lat), lng: String(geoSort.geoOrigin.lng), radius_km: String(geoSort.radiusKm) }
    : {};
  const sortToggleHtml = geoSort.geoOrigin
    ? `<p class="sort-toggle">Sorter etter: <a class="${!geoSort.geoActive ? "active" : ""}" href="${buildSortToggleUrl(geoQueryForToggle, false, fylkeCanonicalPath)}" aria-current="${!geoSort.geoActive ? "true" : "false"}">Standard</a> · <a class="${geoSort.geoActive ? "active" : ""}" href="${buildSortToggleUrl(geoQueryForToggle, true, fylkeCanonicalPath)}" aria-current="${geoSort.geoActive ? "true" : "false"}">Nærmest deg</a></p>`
    : "";
  const geoNoteHtml = geoSort.geoActive
    ? `<p class="geo-note">Viser opplevelser i ${escapeHtml(fylke)} innenfor ${geoSort.radiusKm} km fra deg, sortert etter avstand.</p>`
    : "";

  const html = renderBrowsePage({
    lang: req.lang,
    title: `Opplevelser i ${fylke} | Opplevagent`,
    h1: `Opplevelser i ${fylke}`,
    metaDesc: `Håndplukkede opplevelser og aktiviteter i ${fylke} — verifiserte tilbydere på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede: `Hva kan du finne på i ${fylke}? Håndplukket oversikt over opplevelser i fylket.`,
    canonicalPath: fylkeCanonicalPath,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: fylke }],
    rows: effectiveRows,
    total: effectiveTotal,
    page: effectivePage,
    pageSize: effectivePageSize,
    extraTopHtml: searchBox("", { fylke }) + kommuneChips(fylke) + renderNearMeSortButton(geoSort.radiusKm) + geoNoteHtml + sortToggleHtml,
    distanceMap: geoSort.geoActive ? geoSort.distanceMap : undefined,
    map: { fylke, points: mapPoints },
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 3
    // (delt header/footer): /fylke/:fylke adopts the shared S1 chrome (hamburger
    // nav + full footer incl. "For tilbydere"). "kategorier" is the closest
    // oaSiteNav() item (same "closest item" precedent as /kategori/:category —
    // there's no per-fylke active state in that nav).
    useSharedChrome: true,
    navActive: "kategorier",
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// GET /kommune/:kommune -- experiences in a municipality. Mirrors /fylke/:fylke.
// The detail page's "Kommune" fact already links here (/kommune/<navn>), so
// before this route those links 404'd -- this closes that dead-link + place-weave
// gap. Unknown/empty kommune -> next() -> 404 (no orphan page).
router.get("/kommune/:kommune", (req: Request, res: Response, next: NextFunction) => {
  const kommune = String(req.params.kommune || "");
  if (!kommune) return next();
  let total = 0;
  let rows: ExperienceCardRow[] = [];
  const page = parsePage(req.query.page);
  try {
    total = countPublishedExperiences({ kommune });
    if (total === 0) {
      // Same case/diacritic-insensitive fallback as /fylke/:fylke above (see
      // that block's comment) -- mirrors it against listPublishedKommuner().
      const foldedParam = foldPlaceSlug(kommune);
      const matches = listPublishedKommuner().filter((k) => foldPlaceSlug(k.kommune) === foldedParam);
      if (matches.length === 1 && matches[0].kommune !== kommune) {
        return res.redirect(301, `/kommune/${encodeURIComponent(matches[0].kommune)}`);
      }
      return next(); // unknown/empty kommune -> 404 (no orphan page)
    }
    rows = listPublishedExperiences({ kommune }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch {
    return next();
  }

  // The fylke this kommune sits in (rows share it) -- used for the breadcrumb
  // up-link so the place hierarchy reads Forsiden -> Alle -> <fylke> -> <kommune>.
  const fylke = (rows[0]?.fylke as string | null) || null;
  const crumbs: BreadcrumbCrumb[] = [
    { name: "Forsiden", href: "/" },
    { name: "Alle opplevelser", href: "/opplevelser" },
    ...(fylke ? [{ name: fylke, href: `/fylke/${encodeURIComponent(fylke)}` }] : []),
    { name: kommune },
  ];

  const kommuneCanonicalPath = `/kommune/${encodeURIComponent(kommune)}`;
  const genericKommuneLede = `Hva kan du finne på i ${kommune}? Håndplukket oversikt over opplevelser i kommunen.`;
  // GEO: FAQPage JSON-LD — see buildKommuneFaqJsonLd for the quality gate.
  // The same getKommuneFaqStats() aggregate also feeds the answer-first
  // opening paragraph (buildKommuneAnswerFirstOpening) below — one query, two
  // GEO features sharing one quality gate. Never allowed to break the page:
  // on any error we fail safe to no FAQ block + the generic lede, but log a
  // structured, low-noise diagnostic so a regression here is visible in Fly
  // logs without a live DB shell — this must NOT be a silent catch-and-null.
  let kommuneFaqJsonLd: ReturnType<typeof buildKommuneFaqJsonLd> = null;
  let kommuneLede = genericKommuneLede;
  try {
    const stats = getKommuneFaqStats(kommune);
    kommuneFaqJsonLd = buildKommuneFaqJsonLd({
      kommune,
      fylke,
      url: `${baseUrl()}${kommuneCanonicalPath}`,
      total,
      categoryCount: stats.categoryCount,
      minPriceFrom: stats.minPriceFrom,
    });
    const answerFirst = buildKommuneAnswerFirstOpening({
      kommune,
      fylke,
      total,
      categoryCount: stats.categoryCount,
      minPriceFrom: stats.minPriceFrom,
    });
    if (answerFirst) {
      kommuneLede = answerFirst;
    } else {
      console.log(`[experiences-seo] /kommune/${kommune}: answer-first opening skipped (insufficient real facts) — falling back to generic lede`);
    }
  } catch (e) {
    console.error(`[experiences-seo] /kommune/${kommune} FAQ stats failed:`, e);
    kommuneFaqJsonLd = null;
    kommuneLede = genericKommuneLede;
  }

  // dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 4: "nærmest deg
  // først" sort — PROGRESSIVE ENHANCEMENT ONLY, mirrors /fylke/:fylke above
  // (see that block's comment). With no valid geo origin (or no explicit
  // sort=distance), geoActive is false and every `effective*` value is
  // exactly the SSR value already computed above — byte-identical to before
  // this feature existed.
  const geoSort = resolvePlaceGeoSort(req, { kommune });
  const effectiveRows = geoSort.geoActive && geoSort.rows ? geoSort.rows : rows;
  const effectiveTotal = geoSort.geoActive && geoSort.rows ? geoSort.rows.length : total;
  const effectivePage = geoSort.geoActive ? 1 : page;
  const effectivePageSize = geoSort.geoActive ? Math.max(effectiveTotal, 1) : BROWSE_PAGE_SIZE;
  const geoQueryForToggle: Record<string, string | undefined> = geoSort.geoOrigin
    ? { lat: String(geoSort.geoOrigin.lat), lng: String(geoSort.geoOrigin.lng), radius_km: String(geoSort.radiusKm) }
    : {};
  const sortToggleHtml = geoSort.geoOrigin
    ? `<p class="sort-toggle">Sorter etter: <a class="${!geoSort.geoActive ? "active" : ""}" href="${buildSortToggleUrl(geoQueryForToggle, false, kommuneCanonicalPath)}" aria-current="${!geoSort.geoActive ? "true" : "false"}">Standard</a> · <a class="${geoSort.geoActive ? "active" : ""}" href="${buildSortToggleUrl(geoQueryForToggle, true, kommuneCanonicalPath)}" aria-current="${geoSort.geoActive ? "true" : "false"}">Nærmest deg</a></p>`
    : "";
  const geoNoteHtml = geoSort.geoActive
    ? `<p class="geo-note">Viser opplevelser i ${escapeHtml(kommune)} innenfor ${geoSort.radiusKm} km fra deg, sortert etter avstand.</p>`
    : "";

  const html = renderBrowsePage({
    lang: req.lang,
    title: `Opplevelser i ${kommune} | Opplevagent`,
    h1: `Opplevelser i ${kommune}`,
    metaDesc: `Håndplukkede opplevelser og aktiviteter i ${kommune}${fylke ? ", " + fylke : ""} — verifiserte tilbydere på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede: kommuneLede,
    canonicalPath: kommuneCanonicalPath,
    crumbs,
    rows: effectiveRows,
    total: effectiveTotal,
    page: effectivePage,
    pageSize: effectivePageSize,
    extraTopHtml: searchBox("") + renderNearMeSortButton(geoSort.radiusKm) + geoNoteHtml + sortToggleHtml,
    extraJsonLd: kommuneFaqJsonLd ? [kommuneFaqJsonLd] : undefined,
    distanceMap: geoSort.geoActive ? geoSort.distanceMap : undefined,
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 3
    // (delt header/footer): /kommune/:kommune adopts the shared S1 chrome
    // (hamburger nav + full footer incl. "For tilbydere"). "kategorier" is the
    // closest oaSiteNav() item (same "closest item" precedent as
    // /kategori/:category — there's no per-kommune active state in that nav).
    useSharedChrome: true,
    navActive: "kategorier",
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// GET /kategori/:category/:kommune -- programmatic "query landing page":
// the produkt×by cross-tab targeting the exact question users ask AI
// assistants ("Hvor får jeg [produkt] i [by]?") -- the query-landing-pages
// slice of dev-request 2026-06-30-geo-content-structured-data. Reuses the
// SAME renderBrowsePage() template + browseWhere({category, kommune}) filter
// (already supports both dimensions at once) as /kategori/:category and
// /kommune/:kommune -- no new rendering subsystem.
//
// QUALITY GATE (the entire risk of this feature -- a produkt×by cell is far
// more likely to be a thin single-row combo than a whole category or whole
// kommune, and a thin/near-empty combinatorial page is an SEO/GEO thin-
// content penalty): total===0 -> 404 via next(), same baseline as every
// sibling browse route. ADDITIONALLY -- and unlike /kategori/:category and
// /kommune/:kommune, where an insufficient-facts result only suppresses the
// FAQ block while the page still renders -- this route requires the SAME
// ≥2-real-facts bar (see buildProduktByFaqJsonLd/buildProduktByAnswerFirstOpening)
// just to SERVE the page at all. Below that bar we 404 via next() rather than
// render a real-but-thin single-item page, so this combinatorial route can
// never be pointed at (or link/sitemap into) a near-empty cell. The sitemap
// loop applies the identical gate over listProduktByCombos() so a URL only
// ever appears there if this handler would actually 200 it.
router.get("/kategori/:category/:kommune", (req: Request, res: Response, next: NextFunction) => {
  const category = String(req.params.category || "");
  const kommune = String(req.params.kommune || "");
  if (!category || !kommune) return next();
  let total = 0;
  let rows: ExperienceCardRow[] = [];
  const page = parsePage(req.query.page);
  try {
    total = countPublishedExperiences({ category, kommune });
    if (total === 0) return next(); // unknown/empty combo -> 404 (no orphan page)
  } catch {
    return next();
  }

  const label = catLabel(category);
  const canonicalPath = `/kategori/${encodeURIComponent(category)}/${encodeURIComponent(kommune)}`;

  // Quality gate: needs >=2 real catalog facts (same bar as the FAQ block) to
  // be served at all -- see the route comment above. Computed BEFORE paging
  // through rows so a thin combo never renders any HTML, not even a
  // near-empty grid. Any error here fails safe to 404 (no orphan/broken
  // page), logged (not a silent catch) per the PR-149 incident lesson.
  let stats: { total: number; providerCount: number; minPriceFrom: number | null };
  try {
    stats = getProduktByStats(category, kommune);
  } catch (e) {
    console.error(`[experiences-seo] /kategori/${category}/${kommune} produkt×by stats failed:`, e);
    return next();
  }
  const factCount =
    (stats.total > 0 ? 1 : 0) + (stats.providerCount > 0 ? 1 : 0) + (stats.minPriceFrom !== null ? 1 : 0);
  if (factCount < 2) {
    console.log(`[experiences-seo] /kategori/${category}/${kommune}: below quality gate (${factCount} real facts, ${total} experience${total === 1 ? "" : "s"}) -- not served (404), not sitemapped`);
    return next();
  }

  try {
    rows = listPublishedExperiences({ category, kommune }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch {
    return next();
  }

  const fylke = (rows[0]?.fylke as string | null) || null;
  const crumbs: BreadcrumbCrumb[] = [
    { name: "Forsiden", href: "/" },
    { name: "Alle opplevelser", href: "/opplevelser" },
    { name: label, href: `/kategori/${encodeURIComponent(category)}` },
    { name: kommune },
  ];

  const produktByFaqJsonLd = buildProduktByFaqJsonLd({
    categoryLabel: label,
    kommune,
    fylke,
    url: `${baseUrl()}${canonicalPath}`,
    total,
    providerCount: stats.providerCount,
    minPriceFrom: stats.minPriceFrom,
  });
  const answerFirst = buildProduktByAnswerFirstOpening({
    categoryLabel: label,
    kommune,
    fylke,
    total,
    providerCount: stats.providerCount,
    minPriceFrom: stats.minPriceFrom,
  });
  if (!answerFirst) {
    // Should not happen given the factCount>=2 gate above already passed,
    // but if the two functions' gates ever drift, fail safe to a generic
    // (still real, non-fabricated) lede rather than throw -- logged, not
    // swallowed, per the PR-149 incident lesson.
    console.log(`[experiences-seo] /kategori/${category}/${kommune}: answer-first opening unexpectedly null despite factCount>=2 -- falling back to generic lede`);
  }
  const lede = answerFirst || `${label} i ${kommune}.`;

  const html = renderBrowsePage({
    lang: req.lang,
    title: `${label} i ${kommune} | Opplevagent`,
    h1: `${label} i ${kommune}`,
    metaDesc: `${label} i ${kommune} — håndplukkede opplevelser på Opplevagent med Brreg-verifiserte tilbydere. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede,
    canonicalPath,
    crumbs,
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox(""),
    extraJsonLd: produktByFaqJsonLd ? [produktByFaqJsonLd] : undefined,
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 3
    // (delt header/footer): /kategori/:category/:kommune adopts the shared S1
    // chrome (hamburger nav + full footer incl. "For tilbydere"). "kategorier"
    // is the closest oaSiteNav() item (same "closest item" precedent as
    // /kategori/:category — there's no per-category/kommune active state in
    // that nav).
    useSharedChrome: true,
    navActive: "kategorier",
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// providerId is the provider's UUID -- one provider's experiences.
router.get("/tilbyder/:providerSlugOrId", (req: Request, res: Response, next: NextFunction) => {
  const param = String(req.params.providerSlugOrId || "");
  if (!param) return next();
  ensureProviderSlugs();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let provider: Record<string, unknown> | null = null;
  if (UUID_RE.test(param)) {
    // UUID → look up by ID → 301 redirect to slug URL
    try { provider = getPublishedProviderById(param); } catch { provider = null; }
    if (!provider) return next();
    const slug = provider.slug as string | null;
    if (slug) { res.redirect(301, `/tilbyder/${encodeURIComponent(slug)}`); return; }
    // No slug yet (backfill race) — serve by ID temporarily
  } else {
    // Normal slug-based lookup
    try { provider = getPublishedProviderBySlug(param); } catch { provider = null; }
    if (!provider) return next();
  }
  if (!provider) return next();
  const providerId = String(provider.id || param);

  const page = parsePage(req.query.page);
  let total = 0;
  let rows: ExperienceCardRow[] = [];
  try {
    total = countPublishedExperiences({ providerId });
    rows = listPublishedExperiences({ providerId }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch { total = 0; rows = []; }

  const navn = String(provider.navn || "Tilbyder");
  const brregVerified = Number(provider.brreg_verified) === 1;
  const provSite = safeHttpUrl(provider.hjemmeside);
  const place = placeOf({ kommune: provider.kommune as string | null, fylke: provider.fylke as string | null });
  let ledeBits = `Alle håndplukkede opplevelser fra ${navn}`;
  if (place) ledeBits += ` (${place})`;
  ledeBits += ".";
  const verifiedNote = brregVerified
    ? `<div class="chips"><span class="chip">✓ Verifisert mot Brønnøysundregistrene</span>${provSite ? `<a class="chip" href="${escapeHtml(provSite)}" target="_blank" rel="noopener nofollow">Tilbyderens nettside →</a>` : ""}</div>`
    : provSite ? `<div class="chips"><a class="chip" href="${escapeHtml(provSite)}" target="_blank" rel="noopener nofollow">Tilbyderens nettside →</a></div>` : "";

  const html = renderBrowsePage({
    lang: req.lang,
    title: `${navn} | Opplevagent`,
    h1: navn,
    metaDesc: `Opplevelser fra ${navn}${place ? " i " + place : ""} på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.${brregVerified ? " Tilbyder verifisert mot Brønnøysundregistrene." : ""}`,
    lede: ledeBits,
    canonicalPath: `/tilbyder/${encodeURIComponent(String(provider.slug || providerId))}`,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: navn }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: verifiedNote,
    // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 3
    // (delt header/footer): /tilbyder/:providerSlugOrId adopts the shared S1
    // chrome (hamburger nav + full footer incl. "For tilbydere"). navActive is
    // deliberately left unset (no aria-current on any nav item): the
    // "tilbydere" nav item is the informational "For tilbydere" marketing page
    // (/for-tilbydere), not this browse-by-provider list, and highlighting it
    // here would misleadingly imply the visitor is on that marketing page.
    useSharedChrome: true,
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

// dev-request 2026-07-04-opplevagent-taksonomi-filtre item 4: SSR-friendly
// filter-chip toggle links for /sok — build the next URL for clicking one
// chip (add it if inactive, remove it if active), preserving `q` and every
// other currently-active tag. No client-side JS: each chip is a plain <a>
// whose href is the fully resolved next state.
function sokFilterUrl(q: string, activeTags: ExperienceTag[], toggle: ExperienceTag): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const next = activeTags.includes(toggle)
    ? activeTags.filter((t) => t !== toggle)
    : [...activeTags, toggle];
  for (const t of next) params.set(t, "1");
  const qs = params.toString();
  return qs ? `/sok?${qs}` : "/sok";
}
function renderFilterChips(q: string, activeTags: ExperienceTag[]): string {
  const chips = EXPERIENCE_TAGS.map((t) => {
    const active = activeTags.includes(t);
    return `<a class="chip${active ? " chip-active" : ""}" href="${sokFilterUrl(q, activeTags, t)}" aria-pressed="${active}">${active ? "✓ " : ""}${escapeHtml(FILTER_TAG_LABELS[t])}</a>`;
  }).join("");
  return `<div class="filter-chips" role="group" aria-label="Filtrer opplevelser">${chips}</div>`;
}

// dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 3: build the /sok
// URL for toggling the `sort=distance` results-sort, preserving every other
// currently-active query param (q, tags, lat, lng, radius_km, sted). Pure
// (a plain string-keyed record, not a Request) so it's unit-testable without
// an Express request — mirrors sokFilterUrl's SSR-only approach: this is a
// plain <a href>, no client JS required to use it.
// dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 4: `basePath`
// defaults to "/sok" (unchanged call sites there keep working byte-for-byte)
// but /fylke/:fylke and /kommune/:kommune pass their own canonical path, so
// the SAME toggle-URL builder serves all three geo-sort entry points instead
// of a new one being invented per page.
export function buildSortToggleUrl(
  query: Record<string, string | undefined>,
  activate: boolean,
  basePath: string = "/sok"
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === "sort" || !v) continue;
    params.set(k, v);
  }
  if (activate) params.set("sort", "distance");
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

// Default search radius for the «Nær meg» geolocation button + text-place
// fallback (dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 3).
// Only ever used when a geo origin (lat/lng, or a geocoded `sted`) is
// present — omitting both keeps /sok byte-identical to before this feature
// existed (progressive enhancement only, no SSR default-order change).
const NEAR_ME_RADIUS_KM = 50;

function parseSokFloat(v: unknown): number | undefined {
  const n = parseFloat((v as string) || "");
  return Number.isFinite(n) ? n : undefined;
}

// Shared geo-origin parser + radius resolver (dev-request 2026-07-04-
// opplevagent-naer-meg-geosok): item 3 (/sok) and item 4 (/fylke/:fylke,
// /kommune/:kommune) all need the SAME range-validated lat/lng parse +
// radius clamp. Item 3's own review round 1 caught a real bug: an
// out-of-range lat (e.g. ?lat=999) reaching discoverExperiences()
// unvalidated threw a ZodError and wiped an already-successful search.
// Centralizing the validation here means that fix protects every geo entry
// point, not just the one it was first found in — reusing item 3's guard
// rather than re-deriving (and risking re-diverging from) it per route.
function parseGeoOriginFromQuery(query: Request["query"]): { lat: number; lng: number } | null {
  let lat = parseSokFloat(query.lat);
  let lng = parseSokFloat(query.lng);
  if (lat !== undefined && (lat < -90 || lat > 90)) lat = undefined;
  if (lng !== undefined && (lng < -180 || lng > 180)) lng = undefined;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}
function resolveRadiusKm(query: Request["query"]): number {
  return Math.min(500, Math.max(1, parseSokFloat(query.radius_km) ?? NEAR_ME_RADIUS_KM));
}

// dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 4: shared by
// /fylke/:fylke and /kommune/:kommune — maps discoverExperiences()'s
// hydrated rows into the ExperienceCardRow shape renderBrowsePage()/
// renderCard() already render, and collects the same slug -> distance/
// geo_precision map /sok's item-3 code builds inline, so the SAME honesty
// rule (formatDistanceLabel, via renderCard's optional `distance` param)
// renders every distance label across all three geo entry points — never a
// second, re-derived distance/precision presentation rule.
function toNearbyCardRows(nearby: ReturnType<typeof discoverExperiences>): {
  rows: ExperienceCardRow[];
  distanceMap: Map<string, { distance_km: number | null; geo_precision: "address" | "kommune" | null }>;
} {
  const rows: ExperienceCardRow[] = [];
  const distanceMap = new Map<string, { distance_km: number | null; geo_precision: "address" | "kommune" | null }>();
  for (const e of nearby) {
    if (!e.slug) continue;
    distanceMap.set(e.slug, { distance_km: e.distance_km ?? null, geo_precision: e.geo_precision ?? null });
    rows.push({
      slug: e.slug,
      title: e.title,
      title_no: e.title_no ?? null,
      description: e.description ?? null,
      category: e.category ?? null,
      fylke: e.fylke ?? null,
      kommune: e.kommune ?? null,
      indoor_outdoor: e.indoor_outdoor ?? null,
      duration_min: e.duration_min ?? null,
      price_from: e.price_from ?? null,
      price_band: e.price_band ?? null,
      confidence: e.confidence ?? null,
      tags: e.tags,
    });
  }
  return { rows, distanceMap };
}

// dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 4: computes the
// "nærmest deg" geo-sort overlay shared by /fylke/:fylke and
// /kommune/:kommune. PROGRESSIVE ENHANCEMENT ONLY — when no valid geo origin
// is in the query, or `sort=distance` isn't explicitly requested, returns
// geoActive:false and the caller keeps its already-computed SSR rows/total
// untouched (byte-identical to before this feature existed). Any
// discoverExperiences() failure here degrades the SAME way — geoActive
// stays false and the caller's original rows are never wiped — rather than
// throwing (same "never wipe already-successful data" rule /sok's item-3
// review round 1 established).
function resolvePlaceGeoSort(
  req: Request,
  placeFilter: { fylke: string } | { kommune: string }
): {
  geoActive: boolean;
  rows: ExperienceCardRow[] | null;
  distanceMap: Map<string, { distance_km: number | null; geo_precision: "address" | "kommune" | null }>;
  geoOrigin: { lat: number; lng: number } | null;
  radiusKm: number;
} {
  const geoOrigin = parseGeoOriginFromQuery(req.query);
  const radiusKm = resolveRadiusKm(req.query);
  const wantsDistanceSort = geoOrigin !== null && String(req.query.sort ?? "") === "distance";
  if (!wantsDistanceSort || !geoOrigin) {
    return { geoActive: false, rows: null, distanceMap: new Map(), geoOrigin, radiusKm };
  }
  try {
    const nearby = discoverExperiences(
      { ...placeFilter, lat: geoOrigin.lat, lng: geoOrigin.lng, radius_km: radiusKm, sort: "distance" },
      100
    );
    const { rows, distanceMap } = toNearbyCardRows(nearby);
    return { geoActive: true, rows, distanceMap, geoOrigin, radiusKm };
  } catch {
    return { geoActive: false, rows: null, distanceMap: new Map(), geoOrigin, radiusKm };
  }
}

// «Nærmest deg først» button for /fylke/:fylke and /kommune/:kommune — same
// browser-geolocation JS pattern as /sok's renderNearMeBox below (same
// permission handling / button states), but redirects to the CURRENT page
// (window.location.pathname) instead of hardcoding /sok, so one function
// serves both place routes. Unlike /sok, there is no typed-place text
// fallback here: typing an unrelated place while already on one specific
// fylke/kommune page has no sane target page, so this stays GPS-only — a
// strict subset of /sok's affordance, not a third geo-UI pattern. Clicking
// it sets sort=distance directly (the whole point of granting location
// here IS the "nærmest deg" sort), and drops `page` since the geo-sorted
// list isn't paginated the same way.
function renderNearMeSortButton(radiusKm: number): string {
  return `<div class="near-me">
    <button type="button" id="geoBtn" class="geo-btn">📍 Nærmest deg først</button>
  </div>
  <script>
  (function () {
    var geoBtn = document.getElementById('geoBtn');
    if (!geoBtn) return;
    if (!('geolocation' in navigator)) { geoBtn.hidden = true; return; }
    geoBtn.addEventListener('click', function () {
      geoBtn.textContent = '⏳ Henter posisjon…';
      geoBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        var params = new URLSearchParams(window.location.search);
        params.delete('page');
        params.set('lat', String(pos.coords.latitude));
        params.set('lng', String(pos.coords.longitude));
        if (!params.get('radius_km')) params.set('radius_km', '${radiusKm}');
        params.set('sort', 'distance');
        window.location.href = window.location.pathname + '?' + params.toString();
      }, function () {
        geoBtn.textContent = '❌ Posisjon avslått';
        geoBtn.disabled = true;
      }, { enableHighAccuracy: false, timeout: 8000 });
    });
  })();
  </script>`;
}

// «Nær meg» button (browser geolocation, permission-gated) + a text fallback
// that reuses geocodingService.geocode() SERVER-SIDE via a plain GET
// ?sted=<place> param — the fallback works with NO JS at all (plain form
// submit); the GPS button itself needs JS (navigator.geolocation is a
// browser API with no no-JS equivalent) and hides itself via script if
// unsupported. Mirrors rfb's /sok «Nær meg» affordance (src/routes/seo.ts,
// geoBtn) for UI consistency across the two verticals.
function renderNearMeBox(q: string, activeTags: ExperienceTag[], radiusKm: number): string {
  const hidden = [
    q ? `<input type="hidden" name="q" value="${escapeHtml(q)}">` : "",
    ...activeTags.map((t) => `<input type="hidden" name="${escapeHtml(t)}" value="1">`),
  ].join("");
  return `<div class="near-me">
    <button type="button" id="geoBtn" class="geo-btn">📍 Nær meg</button>
    <form class="place-fallback" action="/sok" method="GET">
      ${hidden}
      <label for="sok-sted" class="skip-link">Skriv inn sted</label>
      <input id="sok-sted" name="sted" type="text" autocomplete="off" placeholder="…eller skriv inn sted">
      <button type="submit">Bruk sted</button>
    </form>
  </div>
  <script>
  (function () {
    var geoBtn = document.getElementById('geoBtn');
    if (!geoBtn) return;
    if (!('geolocation' in navigator)) { geoBtn.hidden = true; return; }
    geoBtn.addEventListener('click', function () {
      geoBtn.textContent = '⏳ Henter posisjon…';
      geoBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        var params = new URLSearchParams(window.location.search);
        params.delete('sted');
        params.set('lat', String(pos.coords.latitude));
        params.set('lng', String(pos.coords.longitude));
        if (!params.get('radius_km')) params.set('radius_km', '${radiusKm}');
        window.location.href = '/sok?' + params.toString();
      }, function () {
        geoBtn.textContent = '❌ Posisjon avslått — skriv inn sted under';
        geoBtn.disabled = true;
      }, { enableHighAccuracy: false, timeout: 8000 });
    });
  })();
  </script>`;
}

// ─── GET /sok?q=&<tag>=1 — HTML search-results page ──────────────────────────
// Human-facing twin of the discover query. Reuses the publish gate so every
// result links to a live detail page. Not paginated (capped result set); the
// search box re-renders the current query.
//
// dev-request 2026-07-04-opplevagent-taksonomi-filtre item 4: also accepts
// one query param per EXPERIENCE_TAGS entry (e.g. ?familievennlig=1) — AND
// semantics across active tags, combinable with `q`. With no `q` but ≥1
// active tag, browses the full published catalog (capped) instead of an
// empty result set, so `/sok?gratis=1` alone works as a browse-by-tag view.
//
// dev-request 2026-07-04-opplevagent-naer-meg-geosok, item 3: also accepts
// `lat`/`lng` (browser geolocation) or `sted` (typed place, geocoded here
// server-side) + `radius_km` + `sort=distance`. PROGRESSIVE ENHANCEMENT
// ONLY: omitting lat/lng/sted leaves every branch below completely unused —
// discoverExperiences() is never called, rows/ordering are byte-identical to
// before this feature existed.
router.get("/sok", generalLimiter, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const activeTags = EXPERIENCE_TAGS.filter((t) => String(req.query[t] ?? "") === "1");

  // ── dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info,
  // Goal 2: route-intent detection in the ONE opplevagent search box. Ported
  // verbatim from rettfrabonden.com's own /sok (src/routes/seo.ts ~1374-1402)
  // — same resolveRouteIntent()/reiseUrlFor() (route-intent.ts) and the same
  // STRICT geocodingService.geocodePlaceForBackfill() whole-string resolver,
  // reused as-is (never route-intent's own heuristics reimplemented or
  // loosened here — see that module's header for why).
  //
  // «oslo til bergen» typed here used to run an ordinary place/product text
  // search with no hint that /reise even exists. Recognise the route and
  // send the visitor straight there instead.
  //
  // EVERY failure path below falls through to the ordinary search further
  // down — resolveRouteIntent() returns a rejection reason rather than
  // throwing for exactly this reason, and the try/catch guards against a
  // geocoder outage taking the whole search box down with it. A wrongly
  // hijacked ordinary search (e.g. a producer/experience name with a dash)
  // is a worse failure than a missed route, so this must never get more
  // eager than the shared module already is.
  //
  // Skipped when the request already carries browser GPS coordinates (the
  // "Nær meg" flow re-submits the existing q verbatim alongside lat/lng) —
  // a coordinate search is already a complete, deliberate search in its own
  // right and must not be reinterpreted as a route query.
  //
  // The `detectRouteIntent(q)` pre-check is a pure, synchronous, no-I/O
  // shape test (see route-intent.ts's own doc header) — resolveRouteIntent()
  // runs the SAME check as its own first line, so calling it here changes
  // no behaviour at all. It exists so the overwhelming majority of ordinary
  // (non-route-shaped) searches never hit an `await` at all: `await`ing an
  // async function always defers to a microtask even when nothing inside it
  // ever does real I/O, and this hot path runs on every non-empty query.
  if (q && !parseGeoOriginFromQuery(req.query) && detectRouteIntent(q)) {
    try {
      const ri = await resolveRouteIntent(q, {
        // STRICT whole-string resolver, never extractAndGeocode — see the
        // contract in route-intent.ts.
        geocode: async (place: string) => {
          const g = await geocodingService.geocodePlaceForBackfill(place);
          return g ? { lat: g.lat, lng: g.lng } : null;
        },
      });
      if (ri.ok) {
        res.redirect(302, reiseUrlFor(ri.route));
        return;
      }
    } catch (err) {
      // A geocoder outage must not take the search box down with it.
      console.error("[route-intent] /sok detection failed, falling through:", err);
    }
  }

  // dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info, Goal 1:
  // additive boost-context, passed through from /kategori/:category's and
  // /fylke/:fylke's own searchBox() as a hidden field. Absent — plain
  // /opplevelser and the homepage hero search never send these — /sok's
  // ordering below is byte-identical to before this feature existed.
  const categoryBoostRaw = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const fylkeBoostRaw = typeof req.query.fylke === "string" ? req.query.fylke.trim() : "";
  const boostContext: SearchBoostContext | undefined =
    categoryBoostRaw || fylkeBoostRaw
      ? { category: categoryBoostRaw || undefined, fylke: fylkeBoostRaw || undefined }
      : undefined;

  // ── Resolve a geo origin: GPS (lat/lng) takes priority; the typed-place
  //    fallback (`sted`) is only consulted when lat/lng are absent ────────
  // parseGeoOriginFromQuery range-validates against the SAME bounds
  // DiscoverFilterSchema enforces (lat -90..90, lng -180..180 — see
  // experience-store.ts DiscoverFilterBaseSchema) before either is ever
  // treated as a usable origin. discoverExperiences() parses its filter
  // through that schema and throws a ZodError on an out-of-range value;
  // without this check a bad lat/lng (e.g. ?lat=999) would reach that call
  // and — via the shared try/catch below — wipe an already-successful q/tag
  // search. Out-of-range here degrades exactly like omitting lat/lng:
  // geoOrigin stays null, hasGeo stays false.
  const gpsOrigin = parseGeoOriginFromQuery(req.query);
  let originLat: number | undefined = gpsOrigin?.lat;
  let originLng: number | undefined = gpsOrigin?.lng;
  const typedPlace = String(req.query.sted ?? "").trim();
  let placeNotFound = false;
  if ((originLat === undefined || originLng === undefined) && typedPlace) {
    try {
      const geo = await geocodingService.geocode(typedPlace);
      if (geo) {
        originLat = geo.lat;
        originLng = geo.lng;
      } else {
        placeNotFound = true;
      }
    } catch {
      placeNotFound = true;
    }
  }
  const geoOrigin =
    typeof originLat === "number" && typeof originLng === "number"
      ? { lat: originLat, lng: originLng }
      : null;
  const hasGeo = geoOrigin !== null;
  const radiusKm = resolveRadiusKm(req.query);
  const sortDistance = hasGeo && String(req.query.sort ?? "") === "distance";

  let rows: ExperienceCardRow[] = [];
  // slug → distance info, from the SAME discoverExperiences() the REST
  // /api/opplevelser/discover endpoint (item 2) is built on — never
  // recomputes haversine or the geo_precision honesty rule locally.
  const distanceMap = new Map<string, { distance_km: number | null; geo_precision: "address" | "kommune" | null }>();

  try {
    if (q) {
      rows = searchPublishedExperiences(q, 60);
    } else if (activeTags.length > 0) {
      rows = listPublishedExperiences({}, 60, 0);
    }
  } catch {
    rows = [];
  }

  // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
  // Steg 1: gårdssalg producers (drink producers in experience_providers —
  // see listGardssalgProviders()'s doc comment) had ZERO presence in /sok's
  // search; a producer's own name typed here returned "Ingen treff" (12 of
  // 13 outreach candidates, measured 2026-08-01). Own variable, own
  // try/catch, entirely separate from `rows`/searchPublishedExperiences()
  // above — a producer-search failure degrades to "no producer section"
  // without ever touching the existing experiences search, and the reverse
  // (a producer hit) never alters `rows`'s own content/order. Only run when
  // there's an actual text query — tag-filter-only and near-me-only browsing
  // are experiences-only concepts today (gårdssalg has neither tags nor a
  // geocoded near-me query on this page), so producerRows stays empty then.
  let producerRows: GardssalgSearchByQueryRow[] = [];
  if (q) {
    try {
      producerRows = searchGardssalgProvidersByQuery(q, 30);
    } catch {
      producerRows = [];
    }
  }

  // Geo/discoverExperiences() branch lives in its OWN try/catch — deliberately
  // separate from the q/tag search above — so a failure here (a transient
  // discoverExperiences error, or any future exception) can never wipe rows
  // that were already successfully computed from q/tags. lat/lng are already
  // range-validated above, so this should not throw a ZodError in practice,
  // but this is defense in depth, not the primary guard.
  if (geoOrigin) {
    try {
      const nearby = discoverExperiences(
        { lat: geoOrigin.lat, lng: geoOrigin.lng, radius_km: radiusKm, sort: "distance" },
        100
      );
      for (const e of nearby) {
        if (e.slug) distanceMap.set(e.slug, { distance_km: e.distance_km ?? null, geo_precision: e.geo_precision ?? null });
      }
      // No text query and no tag filter: near-me IS the browse — surface the
      // discover results directly (already sorted ascending by distance)
      // instead of the "type something" empty state.
      if (!q && activeTags.length === 0) {
        rows = nearby
          .filter((e): e is typeof e & { slug: string } => Boolean(e.slug))
          .map((e) => ({
            slug: e.slug,
            title: e.title,
            title_no: e.title_no ?? null,
            description: e.description ?? null,
            category: e.category ?? null,
            fylke: e.fylke ?? null,
            kommune: e.kommune ?? null,
            indoor_outdoor: e.indoor_outdoor ?? null,
            duration_min: e.duration_min ?? null,
            price_from: e.price_from ?? null,
            price_band: e.price_band ?? null,
            confidence: e.confidence ?? null,
            tags: e.tags,
          }));
      }
    } catch {
      // Geo lookup failed — degrade to whatever q/tag rows already exist
      // above; never clear them.
    }
  }

  if (activeTags.length > 0) {
    rows = rows.filter((r) => activeTags.every((t) => r.tags.includes(t)));
  }

  // Distance-sort toggle (dev-request item 3): opt-in re-sort, only possible
  // (and only rendered) once a geo origin exists. Rows with no distance
  // (outside radius_km, or never geocoded) sort to the bottom rather than
  // being dropped.
  if (sortDistance) {
    rows = [...rows].sort((a, b) => {
      const da = distanceMap.get(a.slug)?.distance_km;
      const db = distanceMap.get(b.slug)?.distance_km;
      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
  }

  const hasQuery = Boolean(q) || activeTags.length > 0 || hasGeo;

  const h1 = q
    ? `Søk: «${q}»`
    : activeTags.length > 0
    ? "Filtrer opplevelser"
    : hasGeo
    ? "Opplevelser nær deg"
    : "Søk i opplevelser";
  const metaDesc = q
    ? `Søkeresultater for «${q}» på Opplevagent — håndplukkede norske opplevelser med verifiserte tilbydere.`
    : hasGeo
    ? "Opplevelser nær deg, sortert etter avstand — håndplukkede norske opplevelser med verifiserte tilbydere."
    : "Søk blant håndplukkede norske opplevelser på Opplevagent — etter sted, kategori eller aktivitet.";
  const emptyTitle = hasQuery ? `Ingen treff${q ? ` for «${q}»` : ""}` : "Skriv inn et søk";
  const emptyBody = hasQuery
    ? "Prøv et annet søkeord eller fjern et filter. Du kan også bla i alle opplevelser."
    : "Søk etter sted, kategori eller aktivitet — for eksempel «hvalsafari», «Tromsø» eller «mat».";

  const geoNote = placeNotFound
    ? `<p class="geo-note">Fant ikke stedet «${escapeHtml(typedPlace)}» — prøv et annet stedsnavn.</p>`
    : hasGeo
    ? `<p class="geo-note">Viser opplevelser innenfor ${radiusKm} km${typedPlace && !req.query.lat ? ` fra ${escapeHtml(typedPlace)}` : " fra deg"}.</p>`
    : "";

  // Normalize req.query into a plain string record for buildSortToggleUrl
  // (drops array/object query values — none of this route's own params are
  // ever arrays, so nothing real is lost).
  const sokQueryForToggle: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === "string") sokQueryForToggle[k] = v;
  }
  const sortToggle = hasGeo
    ? `<p class="sort-toggle">Sorter etter: <a class="${!sortDistance ? "active" : ""}" href="${buildSortToggleUrl(sokQueryForToggle, false)}" aria-current="${!sortDistance ? "true" : "false"}">Relevans</a> · <a class="${sortDistance ? "active" : ""}" href="${buildSortToggleUrl(sokQueryForToggle, true)}" aria-current="${sortDistance ? "true" : "false"}">Avstand</a></p>`
    : "";

  // Search pages are not indexed individually (thin/duplicative); the results
  // still link to indexable detail pages.
  const url = baseUrl();
  const canonical = `${url}/sok`;
  // dev-request 2026-07-30-opplevagent-kategori-sok-og-reiserute-info, Goal 1:
  // when a category/fylke boost context rode along with a text query, group
  // (never filter) the full-catalogue matches already in `rows` — hits
  // inside the current category/fylke first under their own label, the rest
  // of the catalogue's matches below under a distinct one. No boost context
  // (the overwhelming majority of hits — plain /opplevelser search, the
  // homepage hero search) renders the exact same flat grid as before.
  const hasBoost = Boolean(q) && Boolean(boostContext);
  const cards =
    rows.length > 0
      ? hasBoost
        ? (() => {
            const { boosted, rest } = splitBoostedRows(rows, boostContext);
            return renderBoostedResultsHtml(boosted, rest, boostContext as SearchBoostContext, req.lang, distanceMap);
          })()
        : `<div class="grid" role="list">${rows.map((r) => renderCard(r, req.lang, distanceMap.get(r.slug))).join("")}</div>`
      : `<div class="empty"><h2>${escapeHtml(emptyTitle)}</h2><p>${escapeHtml(emptyBody)}</p><a class="cta" href="/opplevelser">Se alle opplevelser</a></div>`;

  // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
  // Steg 1: rendered as its OWN labeled section ("Produsenter"), never merged
  // into the experiences `cards` grid above — Daniel's own design guidance in
  // the dev-request (§"Designvalg som må tas"): a merged single list would
  // hide the producer↔experience duplicate-entity problem the dev-request's
  // Funn 2 documents (e.g. Atlungstad existing as both a producer row AND a
  // conflicting experience row with a different, wrong website) behind
  // interleaving, whereas two clearly labeled sections keep them visibly
  // distinct. Only rendered when there's ≥1 match — no empty-state clutter
  // for the overwhelming majority of searches, which never match a producer
  // (today, every experience-only search). When there are zero producer
  // matches, this whole block (including the "Opplevelser" label) is the
  // empty string, so the page's own experiences section is unchanged from
  // before this feature existed.
  const producerSection =
    producerRows.length > 0
      ? `<section class="sok-producers" aria-label="Produsenter">
  <h2 class="sok-section-title">Produsenter</h2>
  <div class="grid" role="list">${producerRows.map(renderSokProducerCard).join("")}</div>
</section>
<h2 class="sok-section-title">Opplevelser</h2>`
      : "";

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Forsiden", item: url },
      { "@type": "ListItem", position: 2, name: "Søk", item: canonical },
    ],
  };
  const ldScript = `<script type="application/ld+json">${JSON.stringify(breadcrumbLd).replace(/<\//g, "<\\/")}</script>`;

  // dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt
  // 3 (delt header/footer), /sok sub-slice: this page adopts the shared S1
  // chrome (oaSiteNav()/oaSiteFooter()/OA_CHROME_CSS — hamburger nav + full
  // footer incl. «For tilbydere») instead of the legacy slim
  // BROWSE_NAV/browseFooter(), exactly like the 404 catch-all below and the
  // renderBrowsePage() callers. Same "no matching OaNavActive item" precedent
  // as /tilbyder/:providerSlugOrId, the 404 page and /kontakt: /sok is not one
  // of the five nav destinations, so oaSiteNav() is called with no `active`
  // and nothing in the nav is marked aria-current (the breadcrumb's own
  // `<span aria-current="page">Søk</span>` is unrelated and untouched).
  // OA_CHROME_CSS is appended AFTER BROWSE_CSS (whose slimmer .nav-inner/
  // .nav-links rules it deliberately overrides) — BROWSE_CSS itself is shared
  // with /reise and every renderBrowsePage() caller and is NOT modified here;
  // its :root{} block already defines all 14 custom properties OA_CHROME_CSS
  // reads (--ink, --line, --maxw, --surface, …), so no extra token block is
  // needed on this page. Pure chrome swap: the search form, «Nær meg» box and
  // all geo/route-intent logic below are byte-identical.
  const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(h1)} | Opplevagent</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<meta name="robots" content="noindex, follow">
<meta name="theme-color" content="#0e3c36">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags({ includeThemeColor: false })}
<meta property="og:title" content="${escapeHtml(h1)}">
<meta property="og:description" content="${escapeHtml(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
${ldScript}
<style>${BROWSE_CSS}${OA_CHROME_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
${oaSiteNav({})}
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmuler"><a href="/">Forsiden</a><span class="sep">/</span><span aria-current="page">Søk</span></nav>
  <header class="head">
    <h1>${escapeHtml(h1)}</h1>
    ${hasQuery ? `<p class="count">${rows.length} ${rows.length === 1 ? "treff" : "treff"}</p>` : ""}
  </header>
  ${searchBox(q, boostContext)}
  ${renderNearMeBox(q, activeTags, radiusKm)}
  ${geoNote}
  ${renderFilterChips(q, activeTags)}
  ${sortToggle}
  ${producerSection}
  ${cards}
</main>
${oaSiteFooter({})}
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

router.get("/opplevelse/:slug", (req: Request, res: Response, next: NextFunction) => {
  const slug = String(req.params.slug || "");
  let exp: ReturnType<typeof getPublishedExperienceBySlug> = null;
  try {
    exp = getPublishedExperienceBySlug(slug);
  } catch {
    exp = null;
  }
  if (!exp) {
    // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 1: this
    // slug may belong to a row the dedup pass folded into another (canonical)
    // row — 301 to the canonical row's live slug instead of 404ing on a stale
    // bookmarked/indexed URL for a now-duplicate row.
    let canonicalSlug: string | null = null;
    try {
      canonicalSlug = resolveCanonicalSlugForDuplicate(slug);
    } catch {
      canonicalSlug = null;
    }
    if (canonicalSlug && canonicalSlug !== slug) {
      res.redirect(301, `/opplevelse/${encodeURIComponent(canonicalSlug)}`);
      return;
    }
    return next(); // → Norwegian 404 catch-all (no rfb/dental leak)
  }

  let provider: Record<string, unknown> | null = null;
  try {
    if (exp.provider_id) provider = getProviderById(exp.provider_id);
  } catch {
    provider = null;
  }
  let related: RelatedExperienceRow[] = [];
  try {
    related = getRelatedPublishedExperiences(exp.category ?? null, exp.id, 6);
  } catch {
    related = [];
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(renderOpplevelseDetail(exp, provider, related, baseUrl(), req.lang));
});




// ═══════════════════════════════════════════════════════════
// GET /og-image.svg — per-page branded og:image (dev-request
// 2026-07-12-opplevagent-serp-innholdsberikelse, item 3). Replaces the
// domain-wide favicon.svg og:image fallback on opplevelse-detail,
// tilbyder-detail, and kategori/fylke/kommune-browse pages with a
// self-generated branded SVG/text template — the sanctioned interim path
// given Daniel's standing "no auto-fetched/scraped photos" constraint
// (2026-07-10). Query-param based: ?label=&sublabel=&cat= — see
// ogImageUrl() above for how callers build the URL.
// express.static is bypassed by the opplevagent host-gate in index.ts, so
// static/generated assets must be served explicitly from this router — same
// reason /favicon.svg and /logo.svg below are here.
//
// Cache-Control is longer + `immutable` (vs. /favicon.svg's plain
// max-age=86400) because the output is fully deterministic from the query
// params alone (no DB/time dependency), so a stronger cache is strictly
// more appropriate here — a week is a sensible ceiling given link-preview
// caches (Slack/X/etc.) already do their own long-lived caching regardless.
// renderExperienceOgImageSvg() itself bounds/truncates label/sublabel, so an
// absurdly long query string degrades gracefully rather than erroring.
// ═══════════════════════════════════════════════════════════
router.get("/og-image.svg", (req: Request, res: Response) => {
  const label = String(req.query.label ?? "").trim() || "Opplevagent";
  const sublabel = req.query.sublabel !== undefined ? String(req.query.sublabel).trim() : null;
  const cat = req.query.cat !== undefined ? String(req.query.cat).trim() : null;
  const svg = renderExperienceOgImageSvg({
    label,
    sublabel,
    accent: resolveOgAccentColor(cat),
  });
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.send(svg);
});

// ═══════════════════════════════════════════════════════════
// GET /favicon.svg — site icon for Opplevagent
// express.static is bypassed by the opplevagent host-gate in index.ts,
// so static assets must be served explicitly from this router.
// Mirrors the dental-seo.ts pattern (dental PR-112).
// ═══════════════════════════════════════════════════════════
router.get("/favicon.svg", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  // «Konstellasjon» app tile — coral with cream mark (logo spec §6).
  res.send(`<svg width="512" height="512" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Opplevagent"><title>Opplevagent</title><rect width="64" height="64" rx="17" fill="#ff5d3b"/><g transform="translate(12 13.6) scale(0.769)"><path d="M9 33 L24 11 L43 19 L31 38 Z" fill="none" stroke="#f7f4ee" stroke-width="2.4" stroke-linejoin="round" opacity="0.5"/><circle cx="9" cy="33" r="4.2" fill="#f7f4ee"/><circle cx="43" cy="19" r="4.2" fill="#f7f4ee"/><circle cx="31" cy="38" r="4.2" fill="#f7f4ee"/><path d="M24 3 C25.1 8.9 26.9 10.7 32.8 11.8 C26.9 12.9 25.1 14.7 24 20.6 C22.9 14.7 21.1 12.9 15.2 11.8 C21.1 10.7 22.9 8.9 24 3 Z" fill="#f7f4ee"/></g></svg>`);
});

// ═══════════════════════════════════════════════════════════
// PWA — dev-request 2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering,
// extending dev-request 2026-07-04-app-strategi-pwa (previously rfb-only,
// PRs #225/#245) to opplevagent.no. Five routes, same
// express.static-bypass reason documented on /favicon.svg above: the
// opplevagent host-gate in index.ts routes every non-API path into this
// router before express.static is ever reached, so both the pre-placed PNG
// icon files under src/public/ and the new static PWA files under
// src/public/opplevagent-*.{js,html} must be served explicitly here.
//
//   GET /favicon-192.png / /favicon-512.png  — the constellation-mark PNG
//     icons (src/public/opplevagent-favicon-{192,512}.png), for
//     <link rel="icon">/generic PWA-icon-detection tooling that looks for
//     the conventional favicon-192.png/favicon-512.png filenames, and for
//     manifest.json's icons array below.
//   GET /manifest.json  — opplevagent-branded web app manifest (server-
//     generated JSON, not a static file — unlike rfb's src/public/manifest.json
//     — since experiences-seo.ts already generates every other JSON
//     document on this host, e.g. agent-card.json/openapi.json above).
//   GET /sw.js / /offline.html / /install-prompt.js  — close mirrors of
//     src/public/sw.js / offline.html / install-prompt.js (same guard/
//     cache/install-prompt logic, opplevagent branding + cache name), kept
//     as their own static files under src/public/opplevagent-* rather than
//     inlined as template strings — more maintainable for real JS/HTML, and
//     testable with the exact same require()/vm.Script convention as the
//     rfb originals (see opplevagent-sw.test.ts / opplevagent-install-prompt.test.ts).
// ═══════════════════════════════════════════════════════════
const OPPLEVAGENT_PUBLIC_DIR = path.join(__dirname, "..", "public");

function serveOpplevagentPublicFile(fileName: string, contentType: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(OPPLEVAGENT_PUBLIC_DIR, fileName));
    } catch {
      return next(); // missing on disk -> 404 catch-all, never a crash
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(data);
  };
}

router.get("/favicon-192.png", serveOpplevagentPublicFile("opplevagent-favicon-192.png", "image/png"));
router.get("/favicon-512.png", serveOpplevagentPublicFile("opplevagent-favicon-512.png", "image/png"));
router.get("/sw.js", serveOpplevagentPublicFile("opplevagent-sw.js", "text/javascript; charset=utf-8"));
router.get("/offline.html", serveOpplevagentPublicFile("opplevagent-offline.html", "text/html; charset=utf-8"));
router.get("/install-prompt.js", serveOpplevagentPublicFile("opplevagent-install-prompt.js", "text/javascript; charset=utf-8"));

router.get("/manifest.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(
    JSON.stringify({
      name: "Opplevagent",
      short_name: "Opplevagent",
      description:
        "Håndplukkede norske opplevelser og aktiviteter — verifiserte tilbydere, søkbart for både folk og AI-agenter.",
      start_url: "/",
      display: "standalone",
      background_color: "#f7f4ee",
      theme_color: "#ff5d3b",
      icons: [
        { src: "/favicon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/favicon-512.png", sizes: "512x512", type: "image/png" },
      ],
    })
  );
});

// ═══════════════════════════════════════════════════════════
// GET /badge/opplevagent.svg — "Finn oss på Opplevagent" backlink badge
// (dev-request 2026-07-12-opplevagent-lenkeplan, item 1). A small branded
// "as seen on" pill that gårdssalg producers can embed on their own site to
// link back to their own produsent profile page here — see
// opplevagentBadgeEmbedSnippet() below for the copy-paste <a><img> snippet
// that points at this image. Fully static/deterministic (no query params,
// no DB), same Content-Type + Cache-Control convention as /favicon.svg
// above. Mounted alongside the other static SVG routes for the same
// express.static-bypass reason documented on /favicon.svg and /og-image.svg.
// ═══════════════════════════════════════════════════════════
router.get("/badge/opplevagent.svg", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  // «Konstellasjon» mark (same three-node shape as /logo.svg) + wordmark, in
  // a bordered cream pill — coral (#ff5d3b) spark, teal (#12a594) node/frame.
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40" viewBox="0 0 180 40" role="img" aria-label="Finn oss på Opplevagent"><title>Finn oss på Opplevagent</title><rect x="0.5" y="0.5" width="179" height="39" rx="8" fill="#f7f4ee" stroke="#e4ded0"/><g transform="translate(9 6) scale(0.6)"><path d="M9 33 L24 11 L43 19 L31 38 Z" fill="none" stroke="#12a594" stroke-width="2" stroke-linejoin="round" opacity="0.45"/><circle cx="9" cy="33" r="4" fill="#12a594"/><circle cx="43" cy="19" r="4" fill="#6f7a4f"/><circle cx="31" cy="38" r="4" fill="#c98a2b"/><path d="M24 3 C25.1 8.9 26.9 10.7 32.8 11.8 C26.9 12.9 25.1 14.7 24 20.6 C22.9 14.7 21.1 12.9 15.2 11.8 C21.1 10.7 22.9 8.9 24 3 Z" fill="#ff5d3b"/></g><text x="41" y="17" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-size="7.5" font-weight="700" letter-spacing=".04em" fill="#7a7163">FINN OSS PÅ</text><text x="41" y="30" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-size="12" font-weight="800" fill="#18130d">Opplevagent</text></svg>`);
});

// Copy-paste embed snippet for the /badge/opplevagent.svg backlink badge
// (dev-request 2026-07-12-opplevagent-lenkeplan, item 1) — an <a> wrapping
// an <img>, pointing at the provider's own produsent page and at the badge
// image above. `absoluteUrl` should be the same base-URL value the caller
// already computed (e.g. the produsent-page route's `url` = baseUrl()) —
// don't recompute it here. width/height match the SVG's viewBox above so
// the embedded image never needs the host page to guess an aspect ratio.
// Exported so both the produsent-page aside-card (live preview + the
// escaped copy-paste <textarea>) and tests can share one source of truth
// for the snippet's exact markup.
export function opplevagentBadgeEmbedSnippet(providerSlug: string, absoluteUrl: string): string {
  const profileHref = `${absoluteUrl}/kategori/gardssalg/produsent/${encodeURIComponent(providerSlug)}`;
  const badgeSrc = `${absoluteUrl}/badge/opplevagent.svg`;
  return `<a href="${escapeHtml(profileHref)}" target="_blank" rel="noopener"><img src="${escapeHtml(badgeSrc)}" width="180" height="40" alt="Finn oss på Opplevagent"></a>`;
}

// ═══════════════════════════════════════════════════════════
// GET /leaflet/* — self-hosted Leaflet library assets (dev-request
// 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1: /fylke/:fylke map).
// Same express.static-bypass reason as /favicon.svg above: the opplevagent
// host-gate in index.ts routes every non-API path straight into this router
// BEFORE express.static is ever reached, so the vendored files under
// src/public/leaflet/ (npm "leaflet" dependency, dist files copied in —
// never CDN-loaded, unlike src/public/agent.html's unpkg.com pattern, which
// the global Helmet CSP's scriptSrc/styleSrc don't allow — see
// src/middleware/security.ts) must be served explicitly here. Path-traversal
// -safe by construction: each route serves ONE fixed, literal filename —
// never a passthrough of a request param.
// ═══════════════════════════════════════════════════════════
const LEAFLET_ASSET_DIR = path.join(__dirname, "..", "public", "leaflet");
function serveLeafletFile(relPath: string, contentType: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(LEAFLET_ASSET_DIR, relPath));
    } catch {
      return next(); // missing on disk -> 404 catch-all, never a crash
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(data);
  };
}
router.get("/leaflet/leaflet.js", serveLeafletFile("leaflet.js", "text/javascript; charset=utf-8"));
router.get("/leaflet/leaflet.css", serveLeafletFile("leaflet.css", "text/css; charset=utf-8"));
router.get("/leaflet/images/marker-icon.png", serveLeafletFile("images/marker-icon.png", "image/png"));
router.get("/leaflet/images/marker-icon-2x.png", serveLeafletFile("images/marker-icon-2x.png", "image/png"));
router.get("/leaflet/images/marker-shadow.png", serveLeafletFile("images/marker-shadow.png", "image/png"));

// ═══════════════════════════════════════════════════════════
// Catch-all 404 — norsk side (forhindrer rfb/dental-innhold på opplevagent-host)
// ═══════════════════════════════════════════════════════════

// ── /logo.svg — «Konstellasjon» mark (transparent, self-contained) ──
router.get("/logo.svg", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="52" height="48" viewBox="0 0 52 48" fill="none" role="img" aria-label="Opplevagent"><title>Opplevagent</title><path d="M9 33 L24 11 L43 19 L31 38 Z" fill="none" stroke="#12a594" stroke-width="2" stroke-linejoin="round" opacity="0.45"/><circle cx="9" cy="33" r="4" fill="#12a594"/><circle cx="43" cy="19" r="4" fill="#6f7a4f"/><circle cx="31" cy="38" r="4" fill="#c98a2b"/><path d="M24 3 C25.1 8.9 26.9 10.7 32.8 11.8 C26.9 12.9 25.1 14.7 24 20.6 C22.9 14.7 21.1 12.9 15.2 11.8 C21.1 10.7 22.9 8.9 24 3 Z" fill="#ff5d3b"/></svg>`);
});

// ── Legal pages (privacy / terms) — Claude Connectors prerequisite. Bilingual NO/EN. ──
const LEGAL_CSS = `@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@600&display=swap');*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:48px 22px;color:#18130d;background:#f7f4ee;line-height:1.6}h1,h2{font-family:'Outfit',sans-serif;letter-spacing:-.01em}h1{font-size:1.9rem;border-bottom:2px solid #12a594;padding-bottom:.3rem;margin-bottom:.4rem}h2{font-size:1.18rem;color:#0c7264;margin:1.7rem 0 .35rem}a{color:#0c7264}.lang{text-align:right;font-size:.9rem;margin-bottom:.8rem}hr{margin:2.4rem 0;border:none;border-top:1px solid #e4ded0}footer{margin-top:2.4rem;padding-top:1rem;border-top:1px solid #e4ded0;font-size:.85rem;color:#7a7163}ul{margin:.4rem 0 .4rem 1.2rem}p{margin:.4rem 0}`;
function legalPage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="no"><head><meta charset="utf-8"><title>${title} — Opplevagent</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="index, follow"><link rel="icon" type="image/svg+xml" href="/favicon.svg">${pwaHeadTags()}<style>${LEGAL_CSS}</style></head><body>${bodyHtml}<footer>Opplevagent &middot; <a href="/">opplevagent.no</a> &middot; <a href="/personvern">Personvern</a> &middot; <a href="/vilkar">Vilkår</a> &middot; <a href="/.well-known/agent-card.json">Agent Card</a></footer></body></html>`;
}

router.get(["/privacy", "/privacy-policy", "/personvern"], (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(legalPage("Personvern / Privacy", `<div class="lang"><a href="#en">English</a></div>
<h1>Personvern</h1><p><strong>Sist oppdatert:</strong> 22. juni 2026</p>
<p>Opplevagent (opplevagent.no) er en agent-til-agent-markedsplass som hjelper AI-agenter og mennesker med å finne norske opplevelser og aktiviteter — turer, kurs, severdigheter og ting å gjøre. Vi respekterer personvernet til tilbydere, brukere og AI-agenter som samhandler med plattformen.</p>
<h2>Hva vi samler inn</h2><ul>
<li><strong>Opplevelsesdata:</strong> tittel, beskrivelse, tilbyder, kategori, fylke/kommune, varighet, pris, sesong og bookinglenke — offentlig tilgjengelig informasjon hentet fra tilbydernes egne nettsider og åpne kilder (Brønnøysundregistrene, Visit Norway / CBIS m.fl.).</li>
<li><strong>Agent-forespørsler:</strong> hvilke agenter (ChatGPT, Claude, Perplexity m.fl.) som søker, hvilke filtre/søkeord som brukes, og hvilke opplevelser som vises — i aggregert form, uten IP-adresser eller personlige identifikatorer.</li>
<li><strong>Tilbyder-henvendelser:</strong> e-postadresse lagres så lenge det er nødvendig for å bekrefte eierskap ved overtakelse/korrigering av en oppføring.</li></ul>
<h2>Hva vi IKKE samler inn</h2><ul><li>Ingen sporingscookies.</li><li>Ingen tredjeparts analyseverktøy.</li><li>Ingen betalinger eller kortdata — booking skjer hos tilbyderen.</li><li>Vi selger ikke data til tredjepart.</li></ul>
<h2>Lagringstid</h2><p>Aggregerte analytikkdata lagres i opptil 180 dager. Opplevelsesdata fra offentlige kilder lagres så lenge opplevelsen er aktiv.</p>
<h2>Rettighetene dine</h2><p>Er du tilbyder og vil fjernes eller korrigere informasjon? Send e-post til <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>.</p>
<h2>Kontakt</h2><p>E-post: <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a><br>Operatør: Daniel Fredriksen, Norge.</p>
<hr>
<h1 id="en">Privacy Policy</h1><p><strong>Last updated:</strong> 22 June 2026</p>
<p>Opplevagent (opplevagent.no) is an agent-to-agent marketplace that helps AI agents and humans find Norwegian experiences and activities — tours, courses, attractions, and things to do. We respect the privacy of providers, end-users, and AI agents that interact with the platform.</p>
<h2>What we collect</h2><ul>
<li><strong>Experience data:</strong> title, description, provider, category, county/municipality, duration, price, season, and booking link — public information gathered from providers' own websites and open sources (the Norwegian business registry, Visit Norway / CBIS, etc.).</li>
<li><strong>Agent requests:</strong> which agents search, which filters/terms are used, and which experiences are shown — aggregated, without IP addresses or personal identifiers.</li>
<li><strong>Provider claims:</strong> email stored only as long as needed to confirm ownership.</li></ul>
<h2>What we do NOT collect</h2><ul><li>No tracking cookies.</li><li>No third-party analytics.</li><li>No payments or card data — booking happens on the provider's site.</li><li>We do not sell data to third parties.</li></ul>
<h2>Retention</h2><p>Aggregated analytics for up to 180 days; experience data from public records while the experience is active.</p>
<h2>Your rights</h2><p>Providers may request removal or correction at <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>.</p>
<h2>Contact</h2><p>Email: <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a><br>Operator: Daniel Fredriksen, Norway.</p>`));
});

router.get(["/terms", "/terms-of-service", "/tos", "/vilkar"], (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(legalPage("Vilkår / Terms of Service", `<div class="lang"><a href="#en">English</a></div>
<h1>Vilkår for bruk</h1><p><strong>Sist oppdatert:</strong> 22. juni 2026</p>
<p>Velkommen til Opplevagent (opplevagent.no). Disse vilkårene gjelder for alle som bruker plattformen — sluttbrukere, tilbydere og AI-agenter som kaller våre MCP- eller A2A-endepunkter. Ved å bruke tjenesten aksepterer du vilkårene.</p>
<h2>1. Hva tjenesten er</h2><p>Opplevagent er et oppdagelseslag for norske opplevelser. Vi eksponerer en katalog gjennom MCP, A2A JSON-RPC og en REST-API slik at agenter og mennesker kan finne turer, kurs, severdigheter og aktiviteter. Vi er <em>ikke</em> en bookingtjeneste og gjennomfører ikke transaksjoner — booking skjer hos tilbyderen.</p>
<h2>2. Akseptabel bruk</h2><ul><li>Bruk API-ene, MCP-serveren og nettsiden til å finne og utforske opplevelser.</li><li>Integrer tjenesten i egne agenter innenfor rimelige rater.</li><li>Overhold robots.txt og rate-limitene.</li></ul>
<h2>3. Forbudt bruk</h2><ul><li>Skrape hele datasettet for å republisere det som et konkurrerende register uten skriftlig tillatelse.</li><li>Masseutsendelse/spam til tilbydere basert på kontaktinfo herfra.</li><li>Omgå sikkerhet, rate-limiter eller autentisering.</li></ul>
<h2>4. Nøyaktighet</h2><p>Data er samlet fra offentlige kilder. <strong>Tjenesten leveres «som den er».</strong> Verifiser pris, sesong og bookinglenker direkte med tilbyderen før du booker.</p>
<h2>5. Ansvarsbegrensning</h2><p>Opplevagent er ikke ansvarlig for bookinger, gjennomføring, kvalitet eller uenigheter mellom brukere og tilbydere.</p>
<h2>6. Tilbyderrettigheter</h2><p>Oppdater, fjern eller overta din oppføring via <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>. Se også <a href="/personvern">personvern</a>.</p>
<h2>7. Gjeldende rett</h2><p>Norsk rett. Tvister løses ved Daniels alminnelige verneting.</p>
<hr>
<h1 id="en">Terms of Service</h1><p><strong>Last updated:</strong> 22 June 2026</p>
<p>Welcome to Opplevagent (opplevagent.no). These terms apply to everyone who uses the platform — end-users, providers, and AI agents calling our MCP or A2A endpoints. By using the service you accept these terms.</p>
<h2>1. What the service is</h2><p>Opplevagent is a discovery layer for Norwegian experiences. We expose a directory via MCP, A2A JSON-RPC, and a REST API so agents and humans can find tours, courses, attractions, and activities. We are <em>not</em> a booking service and do not process transactions — booking happens on the provider's site.</p>
<h2>2. Acceptable use</h2><ul><li>Use the APIs, MCP server, and website to find and explore experiences.</li><li>Integrate the service into your own agents within reasonable rate limits.</li><li>Respect robots.txt and published rate limits.</li></ul>
<h2>3. Prohibited use</h2><ul><li>Scraping the full dataset to republish as a competing directory without written permission.</li><li>Bulk unsolicited messages or spam to providers.</li><li>Circumventing security, rate limits, or authentication.</li></ul>
<h2>4. Accuracy</h2><p>Data is gathered from public sources. <strong>The service is provided "as is".</strong> Verify price, season, and booking links directly with the provider before booking.</p>
<h2>5. Limitation of liability</h2><p>Opplevagent is not liable for bookings, conduct of experiences, quality, or disputes between users and providers.</p>
<h2>6. Provider rights</h2><p>Update, remove, or claim your listing via <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>. See also the <a href="/privacy">privacy policy</a>.</p>
<h2>7. Governing law</h2><p>Norwegian law. Disputes resolved at Daniel's ordinary venue.</p>`));
});

// ═══════════════════════════════════════════════════════════
// GET /proveniens — Slik verifiserer vi dataene våre (transparency page)
//
// Public, SSR, bilingual NO/EN in one page — reuses the legalPage() helper
// and the same "NO section, <hr>, EN section with #en anchor" convention
// already established by /personvern + /vilkar just above. Purely
// descriptive of the existing verification mechanism (Brreg cross-check,
// content_source / verification_status lifecycle — see experience-store.ts's
// "LOCK MODEL (experiences-native; there is no rfb-style field_provenance
// here)" comment: opplevagent.no does NOT have rettfrabonden.com's per-field
// field_provenance JSON, so this page intentionally does not claim that
// mechanism for this vertical). No new behavior.
//
// IMPORTANT: must never claim regulatory compliance/certification of any
// kind — see tests/test.ts for the assertion guarding this.
// ═══════════════════════════════════════════════════════════

router.get("/proveniens", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(legalPage("Slik verifiserer vi dataene våre / How we verify our data", `<div class="lang"><a href="#en">English</a></div>
<h1>Slik verifiserer vi dataene våre</h1>
<p>Opplevagent skraper ikke bare en nettside og publiserer det vi finner. Hver tilbyder og opplevelse kobles til hvor informasjonen kom fra, og tilbydere krysssjekkes mot en offentlig kilde før de får merket "verifisert". Her er de tre stegene.</p>
<h2>1. Håndplukket utvalg</h2><p>Vi henter inn opplevelser fortløpende fra utvalgte kilder &mdash; ikke et åpent annonsemarked der hvem som helst kan legge inn en oppføring, men ekte norske tilbydere vi har plukket ut.</p>
<h2>2. Verifisert tilbyder</h2><p>Hver tilbyder kontrolleres mot <strong>Brønnøysundregistrene</strong> for å bekrefte at det står et aktivt, registrert selskap bak opplevelsen &mdash; organisasjonsnummer og status hentes direkte derfra. Tilbydere som består denne sjekken får et <span style="display:inline-flex;align-items:center;gap:4px;background:#e7f6ec;color:#0f7a3d;border:1px solid #bfe6cd;border-radius:20px;padding:2px 10px;font-size:.82rem;font-weight:600">&#10003; Brreg-verifisert</span>-merke og vises med organisasjonsnummer på tilbyderens profil.</p>
<h2>3. Utfylt med detaljer</h2><p>Detaljer som beskrivelse, varighet og praktisk info hentes fra tilbyderens egen nettside, med kildehenvisning, slik at teksten er presis og oppdatert &mdash; ikke gjettet.</p>
<h2>Hva hvis en tilbyder ikke er verifisert ennå?</h2><p>Opplevelser fra en tilbyder vi ennå ikke har fått bekreftet mot Brønnøysundregistrene publiseres ikke på nettstedet &mdash; verken opplevelsene eller tilbyderens egen profilside &mdash; før den bekreftelsen er på plass. Så snart tilbyderen er bekreftet som et aktivt, registrert selskap, blir opplevelsene synlige med Brreg-merket.</p>
<h2>Hva vi ikke gjør</h2><p>Vi gjetter ikke fakta om en tilbyder og presenterer det som bekreftet. Innhold hentet fra en tilbyders egen side vises som en faktaoppsummering med kildehenvisning, ikke som en juridisk bekreftelse &mdash; det eneste juridisk bekreftede feltet er det som er kryssjekket mot Brønnøysundregistrene.</p>
<p style="background:#f0f7f4;border-left:4px solid #12a594;border-radius:0 10px 10px 0;padding:16px 20px;margin:24px 0">Etter hvert som forventningene til åpenhet rundt KI og datagrunnlag øker i Europa, mener vi at å vise selve verifiseringsarbeidet vårt er god praksis. Denne siden beskriver hva vi faktisk gjør i dag &mdash; det er ikke en påstand om sertifisering eller samsvar med noe bestemt regelverk.</p>
<h2>Kontakt</h2><p>Spørsmål om en oppføring? <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>. Se også <a href="/personvern">personvern</a>.</p>
<hr>
<h1 id="en">How we verify our data</h1>
<p>Opplevagent doesn't just scrape a website and publish whatever it finds. Every provider and experience is linked to where the information came from, and providers are cross-checked against a public registry before they earn a "verified" mark. Here are the three steps.</p>
<h2>1. Curated collection</h2><p>Experiences are harvested on an ongoing basis from curated sources &mdash; not an open listings market anyone can post to, but a selection of real Norwegian providers.</p>
<h2>2. Verified provider</h2><p>Every provider is checked against <strong>Brønnøysundregistrene</strong>, Norway's official business register, to confirm there is an active, registered company behind the experience &mdash; organisation number and status come directly from there. Providers that pass this check get a <span style="display:inline-flex;align-items:center;gap:4px;background:#e7f6ec;color:#0f7a3d;border:1px solid #bfe6cd;border-radius:20px;padding:2px 10px;font-size:.82rem;font-weight:600">&#10003; Brreg-verified</span> badge and are shown with their organisation number on the provider's profile.</p>
<h2>3. Enriched content</h2><p>Details such as description, duration and practical info are enriched from the provider's own website, with source attribution, so the text is accurate and current &mdash; not guessed.</p>
<h2>What if a provider isn't verified yet?</h2><p>Experiences from a provider we haven't yet confirmed against Brønnøysundregistrene are not published on the site &mdash; neither the experiences nor the provider's own profile page &mdash; until that confirmation lands. Once the provider is confirmed as an active, registered company, its experiences become visible with the Brreg badge.</p>
<h2>What we don't do</h2><p>We don't guess facts about a provider and present the guess as confirmed. Content pulled from a provider's own page is shown as a factual summary with source attribution, not as a legal confirmation &mdash; the only field that carries a legal confirmation is the one cross-checked against Brønnøysundregistrene.</p>
<p style="background:#f0f7f4;border-left:4px solid #12a594;border-radius:0 10px 10px 0;padding:16px 20px;margin:24px 0">As expectations around AI transparency and data provenance keep growing in Europe, we think showing our actual verification work is good practice. This page describes what we genuinely do today; it is not a claim that we meet any particular law or regulatory standard.</p>
<h2>Contact</h2><p>Questions about a listing? <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>. See also the <a href="/privacy">privacy policy</a>.</p>`));
});

// ═══════════════════════════════════════════════════════════
// GET /for-tilbydere (+ /for-tilbydere/finn) — provider onboarding door
// (dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S4).
//
// A visible, indexable front door for producers: EXPLAINS the existing
// claim flow (find your profile → «Er dette din bedrift?» → email-verified
// takeover via magic link to the Brreg/org-linked address) and LINKS into
// it — it never duplicates any part of gardssalg-claim.ts (auto-approve-
// sensitive; that file is untouched by this slice). The only interactive
// element here is a plain GET search form → /for-tilbydere/finn, which
// reuses searchGardssalgProvidersByQuery() (its base WHERE already excludes
// catalog_hidden=1 rows and slug-less rows — see its doc comment in
// experience-store.ts) and links every hit to the claim ENTRY at
// /kategori/gardssalg/eier/<slug>.
//
// SEO: /for-tilbydere is indexable (canonical + static sitemap entry in the
// /sitemap.xml handler above); /for-tilbydere/finn is noindex,follow via its
// own meta tag (same reasoning as /sok — crawlers may still fetch it, so no
// robots.txt change; the claim paths themselves stay Disallow'd through
// GARDSSALG_ROBOTS_DISALLOWS, also unchanged). Both pages wear the S1 shared
// chrome (oaSiteNav()/oaSiteFooter() + BROWSE_CSS + OA_CHROME_CSS), same
// composition as /kategori/gardssalg.
// ═══════════════════════════════════════════════════════════

// Page-specific CSS for the two /for-tilbydere pages — appended after
// BROWSE_CSS + OA_CHROME_CSS in their <style> blocks only (never folded into
// the shared constants; no other page changes).
const FOR_TILBYDERE_CSS = `
  .ft-hero{padding:10px 0 4px}
  .ft-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:18px 0 8px}
  .ft-step{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:20px 18px;box-shadow:var(--sh-sm)}
  .ft-step .n{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--fjord-800);color:#fff;font-weight:800;font-size:.9rem;margin-bottom:10px}
  .ft-step h3{font-size:1.02rem;font-weight:700;color:var(--fjord-900);margin-bottom:6px}
  .ft-step p{font-size:.9rem;color:var(--ink-soft)}
  .ft-section{margin:34px 0 0}
  .ft-section h2{font-size:1.3rem;font-weight:800;letter-spacing:-.015em;color:var(--fjord-900);margin-bottom:8px}
  .ft-section p{max-width:64ch}
  .ft-badge-sample{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid #0f5a50;color:#0f5a50;border-radius:var(--r-pill);padding:5px 14px;font-size:.88rem;font-weight:700;margin:10px 0}
  .ft-edit-list{margin:10px 0 0 20px;color:var(--ink-soft)}
  .ft-edit-list li{margin-bottom:6px}
  .ft-hits{list-style:none;margin:22px 0 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
  .ft-hit{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:18px;box-shadow:var(--sh-sm);display:flex;flex-direction:column;gap:6px}
  .ft-hit .name{font-weight:700;font-size:1.02rem;color:var(--ink)}
  .ft-hit .place{font-size:.84rem;color:var(--mist)}
  .ft-hit .claim{margin-top:auto;padding-top:8px}
  .ft-hit .claim a{display:inline-block;background:var(--fjord-800);color:#fff;font-weight:700;font-size:.86rem;padding:8px 16px;border-radius:var(--r-pill)}
  .ft-hit .claim a:hover{background:var(--fjord-700);text-decoration:none}
  .ft-hint{background:var(--surface);border:1px dashed var(--line);border-radius:var(--r-lg);padding:26px 24px;margin:24px 0;color:var(--ink-soft);max-width:64ch}
  /* /slik-fungerer-det (dev-request 2026-08-08-opplevagent-slik-fungerer-det):
     reuses .ft-section/.ft-steps above; only the flow diagram, the callout and
     the Q&A blocks below are new. */
  .sf-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:18px 0 6px;counter-reset:sf}
  .sf-flow li{list-style:none;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:18px 16px;box-shadow:var(--sh-sm);position:relative}
  .sf-flow li b{display:block;font-size:.98rem;color:var(--fjord-900);margin-bottom:5px}
  .sf-flow li span{font-size:.88rem;color:var(--ink-soft)}
  .sf-note{background:var(--surface);border-left:4px solid var(--fjord-800);border-radius:0 var(--r-md) var(--r-md) 0;padding:18px 20px;margin:20px 0;max-width:64ch;color:var(--ink-soft)}
  .sf-note b{color:var(--fjord-900)}
  .sf-qa{margin:14px 0 0;max-width:64ch}
  .sf-qa h3{font-size:1rem;font-weight:700;color:var(--fjord-900);margin:16px 0 4px}
  .sf-qa p{font-size:.93rem;color:var(--ink-soft)}
`;

// GET search form shared by both pages — plain form, no JS, mirrors the
// searchBox() markup/classes so BROWSE_CSS styles it for free.
function forTilbydereSearchForm(currentQ: string): string {
  return `<div class="searchbar">
    <form action="/for-tilbydere/finn" method="GET" role="search" aria-label="Finn bedriften din">
      <span class="field">${SEARCH_SVG}
        <label for="ft-q" class="skip-link">Søk etter bedriften din</label>
        <input id="ft-q" name="q" type="search" autocomplete="off" placeholder="Søk: bedriftsnavn, sted eller produkt …" value="${escapeHtml(currentQ)}">
      </span>
      <button type="submit">Finn bedriften</button>
    </form>
  </div>`;
}

// Shared head/body shell for the two pages — S1 chrome composition, same
// BROWSE_CSS-then-OA_CHROME_CSS order as renderGardssalgCatalogPage().
function forTilbyderePage(opts: {
  title: string;
  metaDesc: string;
  robotsMeta: string; // full <meta name="robots" …> tag, or "" for none
  canonical: string;  // full <link rel="canonical" …> tag, or "" for none
  jsonLd: string;
  main: string;
}): string {
  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.metaDesc)}">
${opts.robotsMeta}
${opts.canonical}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags()}
${opts.jsonLd}
<style>
${BROWSE_CSS}
${OA_CHROME_CSS}
${FOR_TILBYDERE_CSS}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
${oaSiteNav({ active: "tilbydere" })}
<main id="main" class="container">
${opts.main}
</main>
${oaSiteFooter({})}
</body>
</html>`;
}

router.get("/for-tilbydere", (_req: Request, res: Response) => {
  const url = baseUrl();
  const canonical = `${url}/for-tilbydere`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "For tilbydere — ta eierskap til profilen din",
    description: "Slik tar du eierskap til bedriftsprofilen din på Opplevagent: finn profilen, be om tilgangslenke og rediger selv.",
    url: canonical,
  })}</script>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Forsiden", item: `${url}/` },
      { "@type": "ListItem", position: 2, name: "For tilbydere", item: canonical },
    ],
  })}</script>`;
  const main = `
  <nav class="breadcrumb" aria-label="Brødsmulesti"><a href="/">Forsiden</a> · For tilbydere</nav>
  <header class="head ft-hero">
    <h1>For tilbydere</h1>
    <p class="lede">Driver du et gårdsutsalg, bryggeri, sideri eller annet besøkssted som allerede står på Opplevagent? Profilen din er trolig her — ta eierskap til den, gratis, og hold informasjonen oppdatert selv.</p>
    <p style="font-size:.9rem;color:var(--ink-soft)">Lurer du på hva Opplevagent er og hvordan AI-assistenter bruker profilen din? Les <a href="/slik-fungerer-det">slik fungerer det</a>.</p>
  </header>

  <section class="ft-section" aria-labelledby="ft-finn-h">
    <h2 id="ft-finn-h">Finn bedriften din</h2>
    <p>Søk på bedriftsnavn eller sted, eller bla i <a href="/kategori/gardssalg">katalogen over gårdssalg og smaking</a>.</p>
    ${forTilbydereSearchForm("")}
  </section>

  <section class="ft-section" aria-labelledby="ft-steg-h">
    <h2 id="ft-steg-h">Slik tar du eierskap — tre steg</h2>
    <div class="ft-steps">
      <div class="ft-step">
        <span class="n" aria-hidden="true">1</span>
        <h3>Finn profilen din</h3>
        <p>Søk over, eller finn bedriften i katalogen. Hver produsent har en egen profilside på Opplevagent.</p>
      </div>
      <div class="ft-step">
        <span class="n" aria-hidden="true">2</span>
        <h3>Klikk «Er dette din bedrift?»</h3>
        <p>På profilsiden finner du knappen «Er dette din bedrift?». Den starter overtakelsen — ingen registrering eller passord.</p>
      </div>
      <div class="ft-step">
        <span class="n" aria-hidden="true">3</span>
        <h3>Bekreft via e-post</h3>
        <p>Vi sender en magisk innloggingslenke til adressen som er registrert for bedriften hos Brønnøysundregistrene eller på bedriftens egen nettside. Klikk lenken — ferdig verifisert.</p>
      </div>
    </div>
    <p style="font-size:.86rem;color:var(--mist);max-width:64ch">E-postverifiseringen er hele sikkerheten: bare den som har tilgang til bedriftens registrerte adresse kan ta eierskap. Har du ikke tilgang til den adressen, hjelper vi deg manuelt på <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>.</p>
  </section>

  <section class="ft-section" aria-labelledby="ft-rediger-h">
    <h2 id="ft-rediger-h">Hva du kan redigere som eier</h2>
    <p>Som bekreftet eier logger du rett inn i din egen portal og styrer profilen selv:</p>
    <ul class="ft-edit-list">
      <li>Om-teksten og beskrivelsen av besøket</li>
      <li>Åpningstider og praktisk informasjon</li>
      <li>Produkter og hva gjestene kan smake</li>
      <li>Reservasjonsforespørsler fra besøkende</li>
    </ul>
  </section>

  <section class="ft-section" aria-labelledby="ft-merke-h">
    <h2 id="ft-merke-h">«Bekreftet av eier»-merket</h2>
    <span class="ft-badge-sample"><span aria-hidden="true">&#10003;</span> Bekreftet av eier</span>
    <p>Når du har tatt eierskap, viser profilen din dette merket. Det forteller både besøkende og AI-agenter at informasjonen kommer fra eieren selv — et tillitssignal som skiller profilen din fra rene katalogoppføringer.</p>
  </section>

  <section class="ft-section" aria-labelledby="ft-login-h">
    <h2 id="ft-login-h">Allerede tatt eierskap? Logg inn</h2>
    <p>Gå til profilsiden din (søk den opp over) og bruk «Logg inn»-knappen i «Bekreftet av eier»-kortet — så sender vi deg en ny innloggingslenke på e-post. Ingen passord å huske.</p>
  </section>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(forTilbyderePage({
    title: "For tilbydere — ta eierskap til profilen din | Opplevagent",
    metaDesc: "Driver du et gårdsutsalg, bryggeri eller sideri som står på Opplevagent? Slik tar du eierskap til profilen din: finn bedriften, be om tilgangslenke på e-post, og rediger informasjon, produkter og reservasjoner selv.",
    robotsMeta: `<meta name="robots" content="index, follow">`,
    canonical: `<link rel="canonical" href="${canonical}">`,
    jsonLd,
    main,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /slik-fungerer-det — the producer-facing "how this platform works"
// page (dev-request 2026-08-08-opplevagent-slik-fungerer-det).
//
// WHY a separate page from /for-tilbydere and from /proveniens: the three
// answer different questions and each already has a job.
//   /for-tilbydere → "how do I take over my profile" (the claim mechanics)
//   /proveniens    → "where does your data come from / how is it verified"
//   here           → "what IS this, how does an AI assistant end up
//                     recommending us, and what happens when a guest books"
// The outreach email points here, so this page has to answer a cold
// recipient's first question without them having to reply to ask.
//
// Audience is deliberately the PRODUCER (a brewery owner), not a developer:
// the agent-facing endpoints already have their own surfaces (llms.txt,
// agent-card.json, /mcp, /guide-opplevelser-mcp) and are linked from the
// footer — this page links to them once, at the end, and otherwise stays in
// plain language.
//
// Every factual claim here must match what the platform actually does today,
// and forward-looking items must be visibly marked as such (the "På vei"
// section) — same honesty discipline as /proveniens and the dark-launch
// booking notice. Reuses forTilbyderePage()'s shell + FOR_TILBYDERE_CSS.
// ═══════════════════════════════════════════════════════════
router.get("/slik-fungerer-det", (_req: Request, res: Response) => {
  const url = baseUrl();
  const canonical = `${url}/slik-fungerer-det`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Slik fungerer Opplevagent",
    description:
      "Hvordan AI-assistenter henter informasjon om norske drikkeprodusenter fra Opplevagent, hva du får ved å overta profilen din, og hvordan booking av besøk fungerer.",
    url: canonical,
  })}</script>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Forsiden", item: `${url}/` },
      { "@type": "ListItem", position: 2, name: "Slik fungerer det", item: canonical },
    ],
  })}</script>`;
  const main = `
  <nav class="breadcrumb" aria-label="Brødsmulesti"><a href="/">Forsiden</a> · Slik fungerer det</nav>
  <header class="head ft-hero">
    <h1>Slik fungerer Opplevagent</h1>
    <p class="lede">Stadig flere finner fram ved å spørre en AI-assistent i stedet for å søke seg gjennom trefflister. Opplevagent er bygget for at assistenten skal finne riktig svar om norske drikkeprodusenter — og for at du som produsent skal eie det svaret.</p>
  </header>

  <section class="ft-section" aria-labelledby="sf-flyt-h">
    <h2 id="sf-flyt-h">Fra spørsmål til besøk</h2>
    <p>En gjest spør assistenten sin om noe konkret — «finnes det et bryggeri i nærheten av Voss vi kan besøke i helgen?». Da skjer dette:</p>
    <ol class="sf-flow">
      <li><b>1. Gjesten spør</b><span>I ChatGPT, Claude eller en annen assistent — med vanlige ord, ikke søkeord.</span></li>
      <li><b>2. Assistenten slår opp</b><span>Den henter strukturerte data direkte fra Opplevagent: hvem dere er, hvor dere holder til, hva dere lager.</span></li>
      <li><b>3. Gjesten får svaret</b><span>Med navn, sted og lenke til profilen deres — ikke en annonseplass, men et oppslag.</span></li>
      <li><b>4. Gjesten kan melde seg på</b><span>Har dere skrudd på booking, kan besøket avtales med én gang. Dere bekrefter selv.</span></li>
    </ol>
    <p style="font-size:.86rem;color:var(--mist);max-width:64ch">Forskjellen fra vanlig søk: assistenten trenger ikke å tolke nettsiden deres. Den leser et maskinlesbart oppslagsverk der informasjonen allerede står ryddig — så dere konkurrerer ikke om plassering, dere er enten i oppslagsverket eller ikke.</p>
  </section>

  <section class="ft-section" aria-labelledby="sf-profil-h">
    <h2 id="sf-profil-h">Hvor profilen deres kommer fra</h2>
    <p>Profilen finnes sannsynligvis allerede, uten at dere har gjort noe. Den er bygget på offentlige kilder: <strong>Brønnøysundregistrene</strong> for at det står et aktivt, registrert selskap bak, og bedriftens egen nettside for beskrivelse og produkter. Vi gjetter ikke — mangler vi noe, står feltet tomt heller enn å bli fylt med noe sannsynlig.</p>
    <p>Detaljene om hvordan vi verifiserer, står på <a href="/proveniens">siden om datagrunnlaget vårt</a>.</p>
  </section>

  <section class="ft-section" aria-labelledby="sf-overta-h">
    <h2 id="sf-overta-h">Hva dere får ved å overta profilen</h2>
    <p>Å overta profilen er gratis, tar noen minutter og krever verken registrering eller passord — bare en e-postbekreftelse til adressen som er registrert for bedriften. <a href="/for-tilbydere">Slik gjør dere det</a>.</p>
    <ul class="ft-edit-list">
      <li><strong>Dere styrer innholdet.</strong> Beskrivelse, produkter, åpningstider og praktisk info — det dere skriver er det assistentene henter.</li>
      <li><strong>Dere ser besøkstallene.</strong> Hvor mange som har vært innom profilen de siste 90 dagene, og hvor stor del av trafikken som kommer fra AI-assistenter og roboter kontra mennesker.</li>
      <li><strong>Dere får «Bekreftet av eier»-merket.</strong> Et tillitssignal både for gjester og for assistentene som leser profilen.</li>
      <li><strong>Dere bestemmer over booking.</strong> Av som standard — se under.</li>
    </ul>
  </section>

  <section class="ft-section" aria-labelledby="sf-booking-h">
    <h2 id="sf-booking-h">Booking av besøk — slik virker den</h2>
    <p>Hver profil har et påmeldingssystem for besøk. Det er <strong>avslått som standard</strong>, og ingen kan booke hos dere før dere selv skrur det på i eierportalen.</p>
    <ol class="sf-flow">
      <li><b>1. Gjesten melder seg på</b><span>Velger tidspunkt og antall personer på profilen deres — eller via assistenten sin.</span></li>
      <li><b>2. Dere får forespørselen</b><span>På e-posten deres, med navn, tidspunkt og antall.</span></li>
      <li><b>3. Dere bekrefter selv</b><span>Ingenting er avtalt før dere har sagt ja. Dere kan foreslå et annet tidspunkt eller avslå.</span></li>
    </ol>
    <div class="sf-note"><b>Det koster ingenting.</b> Verken profilen, overtakelsen eller påmeldingene. Vi tar ikke betalt fra gjesten og tar ingen andel av et salg — Opplevagent håndterer ikke betaling i det hele tatt, og selger ikke alkohol. Systemet avtaler et besøk; alt annet skjer hos dere.</div>
  </section>

  <section class="ft-section" aria-labelledby="sf-lov-h">
    <h2 id="sf-lov-h">Hvorfor dette er aktuelt nå</h2>
    <p>Regjeringen har sendt på høring et forslag om utvidet gårdssalg av alkohol, med høringsfrist 5. september 2026. Slik forslaget er formulert, skal salget knyttes til et betalt besøksarrangement med et faglig innhold — omvisning, smaking, foredrag eller overnatting — og med årlige tak for hvor mye som kan selges fra produksjonsstedet.</p>
    <p>Blir det vedtatt, blir det å ta imot besøk — og kunne håndtere en påmelding — en praktisk forutsetning for salg, ikke bare et hyggelig tillegg. Det er en av grunnene til at vi begynte med drikkeprodusenter. Vi følger prosessen, men vi er ikke part i den: dette er en beskrivelse av et forslag på høring, ikke juridisk rådgivning, og dere må selv forholde dere til reglene som gjelder for deres bevilling.</p>
  </section>

  <section class="ft-section" aria-labelledby="sf-paavei-h">
    <h2 id="sf-paavei-h">På vei</h2>
    <p>Dette er et prosjekt under utvikling, og vi vil heller si hva som ennå ikke finnes enn å love det bort:</p>
    <ul class="ft-edit-list">
      <li><strong>Profilen som samtalepartner.</strong> I dag <em>henter</em> assistenter informasjon herfra. Målet er at profilen deres selv skal kunne svare på spørsmål fra gjestens assistent — om ledige tider, sesong eller hva som er på fat akkurat nå.</li>
      <li><strong>Produsent-oppdatert tilgjengelighet.</strong> At dere kan si fra når noe er utsolgt eller stengt, og at assistentene får det med seg samme dag.</li>
    </ul>
  </section>

  <section class="ft-section" aria-labelledby="sf-sporsmal-h">
    <h2 id="sf-sporsmal-h">Vanlige spørsmål</h2>
    <div class="sf-qa">
      <h3>Må vi betale for å stå oppført?</h3>
      <p>Nei. Katalogen er gratis for produsenter, og vi selger ikke plassering.</p>
      <h3>Vi vil ikke stå oppført. Hva gjør vi?</h3>
      <p>Si fra til <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>, så fjerner vi profilen med en gang. Ingen begrunnelse nødvendig.</p>
      <h3>Hva om noe på profilen er feil?</h3>
      <p>Send oss en melding, så retter vi det — eller overta profilen og rett det selv.</p>
      <h3>Kan vi ha profilen uten booking?</h3>
      <p>Ja. Booking er avslått til dere selv skrur den på, og kan skrus av igjen når som helst.</p>
      <h3>Hvem kan overta profilen vår?</h3>
      <p>Bare den som har tilgang til bedriftens registrerte e-postadresse. Innloggingslenken sendes dit — det er hele sikkerheten.</p>
    </div>
  </section>

  <section class="ft-section" aria-labelledby="sf-teknisk-h">
    <h2 id="sf-teknisk-h">For deg som vil se maskineriet</h2>
    <p>Dataene er åpent tilgjengelige for AI-assistenter og utviklere gjennom etablerte standarder — <a href="/mcp">MCP</a>, <a href="/.well-known/agent-card.json">agent-card</a>, <a href="/openapi.json">OpenAPI</a> og <a href="/llms.txt">llms.txt</a>. <a href="/guide-opplevelser-mcp">Guiden for å koble til fra din egen assistent</a> viser oppsettet.</p>
  </section>

  <section class="ft-section" aria-labelledby="sf-kontakt-h">
    <h2 id="sf-kontakt-h">Spørsmål?</h2>
    <p>Send en e-post til <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>. Det er en reell innboks, og du får svar fra et menneske.</p>
  </section>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(forTilbyderePage({
    title: "Slik fungerer Opplevagent — for produsenter | Opplevagent",
    metaDesc:
      "Hvordan AI-assistenter finner og anbefaler norske drikkeprodusenter via Opplevagent, hva du får ved å overta profilen din, og hvordan påmelding til besøk fungerer. Gratis for produsenter.",
    robotsMeta: `<meta name="robots" content="index, follow">`,
    canonical: `<link rel="canonical" href="${canonical}">`,
    jsonLd,
    main,
  }));
});

// GET /for-tilbydere/finn?q= — search-your-business results. noindex,follow
// (like /sok); empty/missing q renders the form + a hint, never an error.
router.get("/for-tilbydere/finn", (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  let hits: GardssalgSearchByQueryRow[] = [];
  if (q) {
    try {
      hits = searchGardssalgProvidersByQuery(q, 30);
    } catch {
      hits = []; // DB unavailable — degrade to the empty state, never crash
    }
  }
  const hitCards = hits
    .map((h) => {
      const sted = [h.poststed || h.kommune, h.fylke].filter(Boolean).join(", ");
      return `<li class="ft-hit">
      <span class="name">${escapeHtml(h.navn)}</span>
      ${sted ? `<span class="place">${escapeHtml(sted)}</span>` : ""}
      <span class="claim"><a href="/kategori/gardssalg/eier/${encodeURIComponent(h.slug)}">Er dette din bedrift?</a></span>
      <a href="/kategori/gardssalg/produsent/${encodeURIComponent(h.slug)}" style="font-size:.84rem">Se profilen →</a>
    </li>`;
    })
    .join("\n");
  const resultBlock = !q
    ? `<div class="ft-hint"><p><strong>Skriv inn bedriftsnavnet</strong> (eller stedet) i feltet over, så finner vi profilen din. Du kan også bla i <a href="/kategori/gardssalg">katalogen</a>.</p></div>`
    : hits.length === 0
    ? `<div class="ft-hint"><p>Ingen treff på «${escapeHtml(q)}». Prøv et kortere navn eller stedet bedriften ligger på — eller bla i <a href="/kategori/gardssalg">katalogen</a>. Finner du ikke bedriften, ta kontakt på <a href="mailto:kontakt@opplevagent.no">kontakt@opplevagent.no</a>, så hjelper vi deg.</p></div>`
    : `<p class="count">${hits.length} treff — klikk «Er dette din bedrift?» på din egen oppføring for å ta eierskap.</p>
  <ul class="ft-hits">
${hitCards}
  </ul>`;
  const main = `
  <nav class="breadcrumb" aria-label="Brødsmulesti"><a href="/">Forsiden</a> · <a href="/for-tilbydere">For tilbydere</a> · Finn bedriften din</nav>
  <header class="head ft-hero">
    <h1>Finn bedriften din</h1>
    <p class="lede">Søk opp bedriften din og ta eierskap til profilen — <a href="/for-tilbydere">slik funker det</a>.</p>
  </header>
  ${forTilbydereSearchForm(q)}
  ${resultBlock}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(forTilbyderePage({
    title: q ? `Finn bedriften din: «${q}» | Opplevagent` : "Finn bedriften din | Opplevagent",
    metaDesc: "Søk opp bedriften din på Opplevagent og ta eierskap til profilen.",
    robotsMeta: `<meta name="robots" content="noindex, follow">`,
    canonical: "",
    jsonLd: "",
    main,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /kontakt — public contact form (opplevagent.no)
// ═══════════════════════════════════════════════════════════

router.get("/kontakt", (_req: Request, res: Response) => {
  const url = baseUrl();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kontakt oss — Opplevagent</title>
<meta name="description" content="Ta kontakt med Opplevagent. Spørsmål om opplevelser, tilbydere eller tekniske ting — vi svarer innen én virkedag.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${url}/kontakt">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags()}
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --fjord-900:#0b2e29;--fjord-800:#0e3c36;--fjord-700:#0f5a50;--fjord-600:#0c7264;
  --font-brand:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --amber-500:#ff5d3b;--teal-400:#3cc3b4;
  --ink:#18130d;--ink-soft:#544a3e;--surface:#fff;--line:#e4ded0;
  --r-pill:999px;--sh-md:0 6px 18px rgba(24,19,13,.10);--maxw:1120px;
}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f4ee;color:#18130d;line-height:1.6;min-height:100vh;display:flex;flex-direction:column}
a{color:#0c7264;text-decoration:none}
a:hover{text-decoration:underline}
${OA_CHROME_CSS}
.main-content{max-width:660px;margin:0 auto;padding:48px 24px 80px;flex:1}
h1{font-size:1.9rem;font-weight:800;color:#0b2e29;margin-bottom:8px}
.subtitle{color:#6a7a6a;margin-bottom:36px}
label{display:block;font-weight:600;color:#18130d;margin-bottom:6px;font-size:.93rem}
input,textarea{width:100%;padding:10px 12px;border:1px solid #c8d4c8;border-radius:8px;font-size:1rem;font-family:inherit;background:#fff;color:#18130d;transition:border-color .15s}
input:focus,textarea:focus{outline:none;border-color:#12a594;box-shadow:0 0 0 3px rgba(18,165,148,.15)}
.field{margin-bottom:22px}
.consent{font-size:.82rem;color:#6a7a6a;margin-bottom:22px}
.btn{background:#0b2e29;color:#fff;padding:12px 28px;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;font-family:inherit;transition:background .15s}
.btn:hover{background:#0f5a50}
.btn:disabled{opacity:.6;cursor:not-allowed}
</style>
</head>
<body>
${oaSiteNav({})}

<div class="main-content">
  <h1>Kontakt oss</h1>
  <p class="subtitle">Spørsmål om opplevelser, tilbydere eller tekniske ting? Vi svarer innen én virkedag.</p>

  <form id="contact-form" novalidate>
    <input type="text" name="_honey" value="" style="display:none;position:absolute;left:-9999px" tabindex="-1" autocomplete="off" aria-hidden="true">
    <input type="hidden" name="platform" value="experiences">

    <div class="field">
      <label for="cf-name">Navn *</label>
      <input type="text" id="cf-name" name="name" required maxlength="100" autocomplete="name">
    </div>

    <div class="field">
      <label for="cf-email">E-post *</label>
      <input type="email" id="cf-email" name="email" required maxlength="254" autocomplete="email">
    </div>

    <div class="field">
      <label for="cf-subject">Emne</label>
      <input type="text" id="cf-subject" name="subject" maxlength="200">
    </div>

    <div class="field">
      <label for="cf-message">Melding *</label>
      <textarea id="cf-message" name="message" required maxlength="2000" rows="5"></textarea>
    </div>

    <p class="consent">Meldingen lagres for behandling av forespørselen din. Leses kun av oss.</p>

    <div class="cf-turnstile" data-sitekey="0x4AAAAAADr56qDaUM0XWoTF" data-theme="light" style="margin-bottom:22px"></div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

    <button type="submit" class="btn">Send melding</button>
  </form>
</div>

${oaSiteFooter({})}

<script>
(function(){
  var form = document.getElementById('contact-form');
  if(!form) return;
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Sender…';
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
        form.innerHTML = '<p style="color:#0c7264;font-size:1.1rem;font-weight:600;padding:24px 0">&#10003; Takk! Vi svarer så snart vi kan.</p>';
      } else {
        btn.disabled = false;
        btn.textContent = 'Send melding';
        alert('Noe gikk galt. Prøv igjen.');
      }
    } catch(err) {
      btn.disabled = false;
      btn.textContent = 'Send melding';
      alert('Noe gikk galt. Prøv igjen.');
    }
  });
})();
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════
// GET /guide-opplevelser-mcp — "Oppdag opplevelser via opplevagent-mcp"
// usage guide (dev-request 2026-06-30-mcp-distribution-traffic-growth,
// Track C: usage-content — autonomous, in-charter: improving discoverability
// of the already-shipped opplevagent-mcp server, not a new feature/vertical).
//
// Static, hand-authored how-to page cross-referencing the REAL tools
// registered in src/routes/experiences-mcp.ts (discover_experiences,
// list_experience_categories, get_experience) — never invented names.
// Unlike rettfrabonden.com's /teknologi, this vertical has no existing
// MCP-setup page, so the connection steps live directly on this page.
// Bilingual (req.lang), mirroring the "/" home route's lang convention.
// ═══════════════════════════════════════════════════════════

const GUIDE_MCP_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#18130d;background:#f7f4ee;line-height:1.65}
a{color:#0c7264}
a:hover{text-decoration:none}
.gom-nav{background:rgba(244,248,244,.92);border-bottom:1px solid #dde8dd;padding:0 24px;height:60px;display:flex;align-items:center;gap:16px}
.gom-nav .brand{font-family:'Outfit',sans-serif;font-weight:700;font-size:1.1rem;color:#0b2e29;text-decoration:none}
.gom-hero{background:linear-gradient(135deg,#0b2e29 0%,#0e3c36 40%,#12a594 100%);color:#fff;padding:56px 24px 44px;text-align:center}
.gom-hero h1{font-family:'Outfit',sans-serif;font-size:2.1rem;font-weight:700;letter-spacing:-.02em;margin-bottom:14px}
.gom-hero p{font-size:1.05rem;max-width:620px;margin:0 auto;color:rgba(255,255,255,.9)}
.gom-sec{max-width:760px;margin:0 auto;padding:40px 24px}
.gom-sec h2{font-family:'Outfit',sans-serif;font-size:1.35rem;font-weight:700;color:#0b2e29;margin-bottom:12px}
.gom-sec p{font-size:.98rem;color:#3a4a3f;margin-bottom:14px}
.gom-group{font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#0c7264;margin:20px 0 8px}
.gom-tools{display:grid;gap:12px;margin:6px 0 18px}
.gom-tool{background:#fff;border:1px solid #e4ded0;border-radius:14px;padding:16px 20px}
.gom-tool code{background:#eef3ee;padding:2px 8px;border-radius:5px;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:.85rem;color:#0c7264;font-weight:700}
.gom-tool p{margin:8px 0 0;font-size:.9rem;color:#3a4a3f}
.gom-examples{background:#fff;border:1px solid #e4ded0;border-radius:14px;padding:18px 22px;margin:6px 0 18px}
.gom-examples li{font-size:.93rem;color:#3a4a3f;margin-bottom:8px;font-style:italic}
.gom-setup{background:#fff;border:1px solid #e4ded0;border-radius:14px;padding:20px 22px;margin:14px 0}
.gom-setup h3{font-size:1.02rem;font-weight:700;color:#0b2e29;margin-bottom:10px}
.gom-code{background:#0b2e29;color:#e2e8f0;border-radius:10px;padding:14px 18px;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:.8rem;line-height:1.6;overflow-x:auto;margin:8px 0}
.gom-cta{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:#0b2e29;color:#fff!important;border-radius:10px;font-weight:700;font-size:.9rem;text-decoration:none}
.gom-faq-item{margin-bottom:16px}
.gom-faq-item h3{font-size:.98rem;font-weight:700;color:#0b2e29;margin-bottom:5px}
.gom-faq-item p{font-size:.9rem;color:#3a4a3f;margin:0}
.gom-footer{max-width:760px;margin:0 auto;padding:24px 24px 48px;font-size:.82rem;color:#7a7163}
@media (max-width:600px){.gom-hero h1{font-size:1.6rem}}
`;

// Static FAQ content for /guide-opplevelser-mcp. Curated editorial copy
// (not derived from a possibly-thin DB row), so unlike
// buildCategoryFaqJsonLd/buildKommuneFaqJsonLd there is no 2-real-facts
// quality gate — the page always emits its FAQPage block. Exported for tests.
export function buildOpplevagentMcpGuideFaqJsonLd(lang: Lang, url: string): any {
  const en = lang === "en";
  const qas: Array<{ q: string; a: string }> = en ? [
    {
      q: "Which AI assistants work with opplevagent-mcp?",
      a: "Any MCP-compatible assistant — Claude Desktop, ChatGPT (Developer Mode / custom connectors), Cursor, and other MCP clients. Connect via the remote endpoint https://opplevagent.no/mcp or the opplevagent-mcp npm package.",
    },
    {
      q: "What tools does the opplevagent MCP server expose?",
      a: "discover_experiences filters by county (fylke), municipality (kommune), category, weather, season, indoor/outdoor, group size, age, price, and duration; list_experience_categories lists every category with a live count; get_experience fetches full details for one experience by its UUID.",
    },
    {
      q: "Does using the MCP server cost anything?",
      a: "No — the server is free and open source, and every experience returned is Brreg-verified against the Norwegian business registry.",
    },
    {
      q: "Can I book an experience directly through my AI assistant?",
      a: "The assistant surfaces a booking_url (and booking_type) per experience from discover_experiences/get_experience; booking itself happens on the provider's own site or via that link, not inside the MCP conversation.",
    },
    {
      q: "How do I set up opplevagent-mcp in Claude Desktop or ChatGPT?",
      a: "See the setup steps further up this page — paste https://opplevagent.no/mcp as a remote connector, or add the opplevagent-mcp npm package to your MCP client config.",
    },
  ] : [
    {
      q: "Hvilke AI-assistenter fungerer med opplevagent-mcp?",
      a: "Alle MCP-kompatible assistenter — Claude Desktop, ChatGPT (Developer Mode / egendefinerte koblinger), Cursor og andre MCP-klienter. Koble til via det eksterne endepunktet https://opplevagent.no/mcp eller npm-pakken opplevagent-mcp.",
    },
    {
      q: "Hvilke verktøy har opplevagent MCP-serveren?",
      a: "discover_experiences filtrerer på fylke, kommune, kategori, vær, sesong, innendørs/utendørs, gruppestørrelse, alder, pris og varighet; list_experience_categories lister alle kategorier med et levende antall; get_experience henter fullstendige detaljer for én opplevelse via UUID.",
    },
    {
      q: "Koster det noe å bruke MCP-serveren?",
      a: "Nei — serveren er gratis og åpen kildekode, og hver opplevelse som returneres er Brreg-verifisert mot Brønnøysundregistrene.",
    },
    {
      q: "Kan jeg booke en opplevelse direkte gjennom AI-assistenten?",
      a: "Assistenten viser en booking_url (og booking_type) per opplevelse fra discover_experiences/get_experience; selve bookingen skjer hos tilbyderens egen side eller via den lenken, ikke inne i MCP-samtalen.",
    },
    {
      q: "Hvordan setter jeg opp opplevagent-mcp i Claude Desktop eller ChatGPT?",
      a: "Se oppsettsstegene lenger opp på denne siden — lim inn https://opplevagent.no/mcp som en ekstern kobling, eller legg npm-pakken opplevagent-mcp til MCP-klientens konfigurasjon.",
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

router.get("/guide-opplevelser-mcp", (req: Request, res: Response) => {
  const url = baseUrl();
  const lang: Lang = req.lang === "en" ? "en" : "no";
  const en = lang === "en";
  const canonical = en ? `${url}/en/guide-opplevelser-mcp` : `${url}/guide-opplevelser-mcp`;
  const faqJsonLd = buildOpplevagentMcpGuideFaqJsonLd(lang, canonical);
  const faqHtml = faqJsonLd.mainEntity.map((qa: any) =>
    `<div class="gom-faq-item"><h3>${escapeHtml(qa.name)}</h3><p>${escapeHtml(qa.acceptedAnswer.text)}</p></div>`
  ).join("");

  const content = en ? `
  <section class="gom-hero">
    <h1>Discover Norwegian experiences via opplevagent-mcp</h1>
    <p>Ask Claude, ChatGPT, or any other MCP-compatible AI assistant to search Opplevagent's curated, Brreg-verified catalog of Norwegian experiences and activities.</p>
  </section>
  <section class="gom-sec">
    <h2>What is this?</h2>
    <p>Opplevagent runs a remote MCP (Model Context Protocol) server at <code>https://opplevagent.no/mcp</code>. Once your AI assistant is connected, it can search, filter, and read our verified experience catalog directly — the same data behind <a href="/opplevelser">the browse pages</a>, but callable as tools inside a conversation.</p>

    <h2>The tools, exactly as registered</h2>
    <div class="gom-tools">
      <div class="gom-tool"><code>discover_experiences</code><p>Search by county (fylke), municipality (kommune), category, weather, season, indoor/outdoor, group size, age, max price, and duration. Returns title, category, location, description, and booking URL.</p></div>
      <div class="gom-tool"><code>list_experience_categories</code><p>Lists every experience category with a live count of verified experiences — useful before calling discover_experiences with a specific category filter.</p></div>
      <div class="gom-tool"><code>get_experience</code><p>Fetches full details for one experience by its UUID — description, group/age limits, price, duration, languages, and booking info. Obtain the UUID from discover_experiences results.</p></div>
    </div>

    <h2>Try asking your assistant</h2>
    <div class="gom-examples"><ul>
      <li>"What can we do in Troms in winter?"</li>
      <li>"Outdoor activities in Oslo for 4 people"</li>
      <li>"Experiences that work well in the rain in Bergen"</li>
      <li>"Whale safari Tromsø"</li>
      <li>"Family-friendly activities under 500 kr"</li>
      <li>"What categories of experiences exist in Norway?"</li>
    </ul></div>

    <h2>Get started</h2>
    <div class="gom-setup">
      <h3>ChatGPT / other remote MCP clients (easiest)</h3>
      <p>Open the tools menu, choose "Add an MCP Server", and paste: <code>https://opplevagent.no/mcp</code></p>
    </div>
    <div class="gom-setup">
      <h3>Claude Desktop</h3>
      <p><strong>Remote (recommended):</strong> Settings → Integrations → Add custom connector → paste <code>https://opplevagent.no/mcp</code>.</p>
      <p><strong>Local npm package</strong> (developers, Claude Code):</p>
      <div class="gom-code">{<br>&nbsp;&nbsp;"mcpServers": {<br>&nbsp;&nbsp;&nbsp;&nbsp;"opplevagent": {<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"command": "npx",<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"args": ["opplevagent-mcp"]<br>&nbsp;&nbsp;&nbsp;&nbsp;}<br>&nbsp;&nbsp;}<br>}</div>
      <p>Or run directly: <code>npx opplevagent-mcp</code></p>
    </div>
    <p>Source and README: <a href="https://github.com/slookisen/lokal/tree/main/mcp-server-opplevagent">opplevagent-mcp on GitHub</a>. More AI-discovery details: <a href="/llms.txt">llms.txt</a>.</p>
    <p><a class="gom-cta" href="https://opplevagent.no/mcp">Connect https://opplevagent.no/mcp →</a></p>
  </section>
  <section class="gom-sec">
    <h2>Frequently asked questions</h2>
    ${faqHtml}
  </section>
  <footer class="gom-footer"><a href="/">opplevagent.no</a> · <a href="/opplevelser">Alle opplevelser</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/agent-card.json">Agent Card</a></footer>` : `
  <section class="gom-hero">
    <h1>Oppdag norske opplevelser via opplevagent-mcp</h1>
    <p>Be Claude, ChatGPT eller en annen MCP-kompatibel AI-assistent om å søke i Opplevagents håndplukkede, Brreg-verifiserte katalog over norske opplevelser og aktiviteter.</p>
  </section>
  <section class="gom-sec">
    <h2>Hva er dette?</h2>
    <p>Opplevagent kjører en ekstern MCP (Model Context Protocol)-server på <code>https://opplevagent.no/mcp</code>. Når AI-assistenten din er koblet til, kan den søke, filtrere og lese vårt verifiserte opplevelsesregister direkte — samme data som driver <a href="/opplevelser">nettleser-sidene</a>, men tilgjengelig som verktøy i en samtale.</p>

    <h2>Verktøyene, slik de faktisk er registrert</h2>
    <div class="gom-tools">
      <div class="gom-tool"><code>discover_experiences</code><p>Søk på fylke, kommune, kategori, vær, sesong, innendørs/utendørs, gruppestørrelse, alder, maks pris og varighet. Returnerer tittel, kategori, sted, beskrivelse og bookinglenke.</p></div>
      <div class="gom-tool"><code>list_experience_categories</code><p>Lister alle kategorier med et levende antall verifiserte opplevelser — nyttig før du kaller discover_experiences med et spesifikt kategorifilter.</p></div>
      <div class="gom-tool"><code>get_experience</code><p>Henter fullstendige detaljer for én opplevelse via UUID — beskrivelse, gruppe-/aldersgrenser, pris, varighet, språk og bookinginfo. Hent UUID-en fra resultater fra discover_experiences.</p></div>
    </div>

    <h2>Prøv å spørre assistenten din</h2>
    <div class="gom-examples"><ul>
      <li>«Hva kan vi finne på i Troms om vinteren?»</li>
      <li>«Utendørsaktiviteter i Oslo for 4 personer»</li>
      <li>«Opplevelser som passer i regnvær i Bergen»</li>
      <li>«Hvalsafari Tromsø»</li>
      <li>«Familievennlige aktiviteter under 500 kr»</li>
      <li>«Hvilke typer opplevelser finnes i Norge?»</li>
    </ul></div>

    <h2>Kom i gang</h2>
    <div class="gom-setup">
      <h3>ChatGPT / andre eksterne MCP-klienter (enklest)</h3>
      <p>Åpne verktøy-menyen, velg «Add an MCP Server», og lim inn: <code>https://opplevagent.no/mcp</code></p>
    </div>
    <div class="gom-setup">
      <h3>Claude Desktop</h3>
      <p><strong>Ekstern (anbefalt):</strong> Settings → Integrations → Add custom connector → lim inn <code>https://opplevagent.no/mcp</code>.</p>
      <p><strong>Lokal npm-pakke</strong> (utviklere, Claude Code):</p>
      <div class="gom-code">{<br>&nbsp;&nbsp;"mcpServers": {<br>&nbsp;&nbsp;&nbsp;&nbsp;"opplevagent": {<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"command": "npx",<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"args": ["opplevagent-mcp"]<br>&nbsp;&nbsp;&nbsp;&nbsp;}<br>&nbsp;&nbsp;}<br>}</div>
      <p>Eller kjør direkte: <code>npx opplevagent-mcp</code></p>
    </div>
    <p>Kildekode og README: <a href="https://github.com/slookisen/lokal/tree/main/mcp-server-opplevagent">opplevagent-mcp på GitHub</a>. Flere AI-discovery-detaljer: <a href="/llms.txt">llms.txt</a>.</p>
    <p><a class="gom-cta" href="https://opplevagent.no/mcp">Koble til https://opplevagent.no/mcp →</a></p>
  </section>
  <section class="gom-sec">
    <h2>Ofte stilte spørsmål</h2>
    ${faqHtml}
  </section>
  <footer class="gom-footer"><a href="/">opplevagent.no</a> · <a href="/opplevelser">Alle opplevelser</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/agent-card.json">Agent Card</a></footer>`;

  const title = en
    ? "Discover experiences via opplevagent-mcp | Opplevagent"
    : "Oppdag opplevelser via opplevagent-mcp | Opplevagent";
  const description = en
    ? "How to use Claude, ChatGPT, and other AI assistants with the opplevagent MCP server to find Norwegian experiences — every tool explained."
    : "Slik bruker du Claude, ChatGPT og andre AI-assistenter med opplevagent MCP-serveren for å finne norske opplevelser — alle verktøyene forklart.";
  const jsonLdScripts = [faqJsonLd]
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/<\//g, "<\\/")}</script>`)
    .join("\n");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(`<!doctype html>
<html lang="${htmlLangAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="nb" href="${url}/guide-opplevelser-mcp">
<link rel="alternate" hreflang="en" href="${url}/en/guide-opplevelser-mcp">
<link rel="alternate" hreflang="x-default" href="${url}/guide-opplevelser-mcp">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags()}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="${ogLocale(lang)}">
<meta property="og:site_name" content="Opplevagent">
${jsonLdScripts}
<style>${GUIDE_MCP_CSS}</style>
</head>
<body>
<nav class="gom-nav"><a class="brand" href="/">opplevagent.no</a></nav>
${content}
</body>
</html>`);
});

// ─── /reise — korridor-discovery langs en kjørerute (OpplevAgent) ────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2c.
//
// Twin of the RFB page in seo.ts, carrying the other half of the catalogue:
// opplevelser + gårdssalg (bryggeri / cideri / vingård / destilleri), and never
// a single Rett-fra-Bonden row. Cross-vertical routes are Fase 7 and need an
// architecture decision first (7a); 7c says host isolation must survive it.
//
// Registered ABOVE the router.use() 404 catch-all below — anything after that
// is unreachable.
//
// Conventions taken from THIS file rather than from seo.ts: inline Norwegian
// strings (there is no message catalogue here — only the landing page is
// bilingual, via homeStrings()), BROWSE_CSS + BROWSE_NAV + browseFooter() for
// the chrome, and its own full <!doctype> document like the other bespoke
// pages.
//
// noindex, follow — same reasoning as the RFB twin: unbounded from/to
// combinations are the scaled-template pattern Google's March-2026 update
// penalises. Fase 8's hand-written corridor pages are the indexable surface.
//
// UX: one ordered column, not a grid — a grid reads as "ranked", and a
// traveller reads this as an itinerary, so vertical order must be the only
// order. Each row leads with «etter N km» (the along-track position) because
// that is the question being asked. The offset is «N km fra ruten», never
// «N km å kjøre» — in Norway those differ by an order of magnitude
// (Molde→Vestnes: 12.8 km apart, 104 km / 118 min to drive), and Fase 4 is
// what closes the gap.
const REISE_CSS = `
.reise-wrap{max-width:var(--maxw);margin:0 auto;padding:32px 24px 64px}
.reise-wrap h1{font-family:var(--font-brand);font-size:1.9rem;line-height:1.2;margin-bottom:8px}
.reise-lede{color:var(--ink-soft);max-width:62ch;margin-bottom:20px}
.reise-form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:16px;box-shadow:var(--sh-sm)}
.reise-form label{display:block;font-size:.78rem;color:var(--mist);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.reise-form input[type=text]{padding:11px 13px;border:1px solid var(--line);border-radius:var(--r-sm);font-size:1rem;min-width:190px;background:var(--canvas)}
.reise-form .rf-range{min-width:230px}
.reise-form input[type=range]{width:100%}
.reise-form button{padding:12px 22px;border:0;border-radius:var(--r-pill);background:var(--fjord-700);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
.reise-note{background:#fff6e8;border:1px solid #f0d9ae;border-radius:var(--r-sm);padding:12px 14px;margin:18px 0;font-size:.93rem;line-height:1.55}
.reise-meta{color:var(--mist);font-size:.9rem;margin:18px 0 14px}
.reise-list{list-style:none;padding:0;margin:0 0 0 10px;border-left:2px solid var(--line)}
.reise-item{position:relative;padding:15px 0 15px 24px}
.reise-item:before{content:"";position:absolute;left:-7px;top:23px;width:12px;height:12px;border-radius:50%;background:var(--teal-500);border:2px solid var(--canvas)}
.reise-along{font-size:.76rem;color:var(--mist);text-transform:uppercase;letter-spacing:.05em}
.reise-name{font-size:1.06rem;font-weight:600;margin:2px 0 3px;font-family:var(--font-brand)}
.reise-detour{font-size:.9rem;color:var(--fjord-700)}
.reise-cats{font-size:.82rem;color:var(--mist);margin-top:3px}
.reise-approx{margin-top:38px;padding-top:22px;border-top:1px solid var(--line)}
.reise-approx h2{font-family:var(--font-brand);font-size:1.15rem;margin-bottom:4px}
.reise-approx-place{margin:18px 0 0}
.reise-approx-place h3{font-size:.95rem;margin:0 0 4px;font-family:var(--font-brand)}
.reise-approx-place ul{margin:0;padding-left:18px;font-size:.94rem;line-height:1.75}
.reise-empty{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:22px;margin:18px 0;line-height:1.6}
`;

router.get("/reise", async (req: Request, res: Response) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const drinkOnly = req.query.drink === "true";
  const detourRaw = parseInt(String(req.query.detour || ""), 10);
  const detourKm = Number.isFinite(detourRaw) ? Math.min(100, Math.max(1, detourRaw)) : DEFAULT_MAX_DETOUR_KM;

  const title = from && to
    ? `Stopp mellom ${from} og ${to} | Opplevagent`
    : "Finn opplevelser og drikkesteder langs ruten | Opplevagent";
  const description = from && to
    ? `Opplevelser, gårdssalg og drikkesteder langs kjøreruten fra ${from} til ${to} — i reiserekkefølge.`
    : "Skriv hvor du kjører fra og til, så lister vi opplevelser, gårdssalg og drikkesteder langs veien — i den rekkefølgen du passerer dem.";

  const form = `
<form class="reise-form" method="GET" action="/reise">
  <div><label for="rf-from">Fra</label>
    <input type="text" id="rf-from" name="from" value="${escapeHtml(from)}" placeholder="f.eks. Oslo" required></div>
  <div><label for="rf-to">Til</label>
    <input type="text" id="rf-to" name="to" value="${escapeHtml(to)}" placeholder="f.eks. Trondheim" required></div>
  <div class="rf-range"><label for="rf-detour">Maks omvei: ${detourKm} km</label>
    <input type="range" id="rf-detour" name="detour" min="5" max="60" step="5" value="${detourKm}"
      oninput="document.querySelector('label[for=rf-detour]').textContent='Maks omvei: '+this.value+' km'"></div>
  <div><label for="rf-drink">Bare drikke</label>
    <input type="checkbox" id="rf-drink" name="drink" value="true"${drinkOnly ? " checked" : ""} style="width:22px;height:22px"></div>
  <div><button type="submit">Finn stopp</button></div>
</form>`;

  let body: string;

  if (!from || !to) {
    body = `
<h1>Hva ligger langs veien?</h1>
<p class="reise-lede">${escapeHtml(description)}</p>
${form}
<div class="reise-empty">
  <p>Vi måler hvert sted mot den faktiske kjøreruten din, og lister dem i den rekkefølgen du passerer dem.</p>
  <p>Vi oppgir bare avstand når vi kjenner den nøyaktige adressen. Steder vi bare kan plassere til en
  kommune, lister vi for seg — uten tall. Et oppdiktet tall er verre enn ingen.</p>
</div>`;
  } else {
    let result;
    try {
      result = await corridorSearch({
        from, to,
        maxDetourKm: detourKm,
        drinkOnly,
        sources: ["experience", "gardssalg"],
        experiencesDb: getExpDbForReise("experiences"),
        limit: 30,
      });
    } catch {
      res.status(500).send("Intern feil");
      return;
    }

    let inner: string;
    if (!result.ok) {
      inner = `<div class="reise-empty"><p><strong>${escapeHtml(result.reason || "")}</strong></p></div>`;
    } else {
      const notes = result.notes.map((n) => `<div class="reise-note">${escapeHtml(n)}</div>`).join("");
      const meta = `<p class="reise-meta">${
        result.route && result.route.distanceKm != null
          ? escapeHtml(`${Math.round(result.route.distanceKm)} km kjøring, cirka ${Math.round((result.route.durationMinutes || 0) / 60)} timer. `)
          : ""
      }${escapeHtml(`${result.stops.length} stopp innenfor ${detourKm} km fra ruten.`)}</p>`;

      const items = result.stops.map((s) => {
        // detourKm is null whenever the corridor service will not vouch for a
        // number (straight-line mode). Never write one by hand here.
        const detour = s.detourKm != null
          ? escapeHtml(`${s.detourKm.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km fra ruten`)
          : "langs ruten";
        return `<li class="reise-item">
  <div class="reise-along">etter ${Math.round(s.alongKm)} km</div>
  <div class="reise-name"><a href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a></div>
  <div class="reise-detour">${detour}${s.place ? " · " + escapeHtml(s.place) : ""}</div>
  ${s.categories.length ? `<div class="reise-cats">${escapeHtml(s.categories.map((c) => catLabel(c)).join(", "))}</div>` : ""}
</li>`;
      }).join("");

      const approx = result.approximate.length === 0 ? "" : `
<section class="reise-approx">
  <h2>Steder langs ruten</h2>
  <p class="reise-meta">Vi vet at disse ligger i disse kommunene, men ikke nøyaktig hvor — så vi sier ikke
  hvor langt fra ruten de er.</p>
  ${result.approximate.map((g) => `<div class="reise-approx-place">
    <h3>${escapeHtml(g.place)}</h3>
    <ul>${g.items.map((i) => `<li><a href="${escapeHtml(i.url)}">${escapeHtml(i.name)}</a></li>`).join("")}</ul>
  </div>`).join("")}
</section>`;

      const empty = result.stops.length === 0 && result.approximate.length === 0
        ? `<div class="reise-empty"><p>Vi fant ingenting langs denne ruten ennå. Dekningen er tynnest nord
           for Trondheim — prøv Østlandet, Trøndelag eller Sørlandet, eller øk omveien.</p></div>`
        : "";

      inner = `${notes}${meta}${result.stops.length ? `<ul class="reise-list">${items}</ul>` : ""}${empty}${approx}`;
    }

    body = `<h1>${escapeHtml(`${from} → ${to}`)}</h1>${form}${inner}`;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(`<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${baseUrl()}/reise">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags()}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Opplevagent">
<style>${BROWSE_CSS}${REISE_CSS}</style>
</head>
<body>
${BROWSE_NAV}
<main id="main" class="reise-wrap">${body}</main>
${browseFooter()}
</body>
</html>`);
});

// dev-request 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 3
// (delt header/footer): the 404 catch-all adopts the shared S1 chrome
// (oaSiteNav()/oaSiteFooter()/BROWSE_CSS/OA_CHROME_CSS — hamburger nav + full
// footer), same "no matching OaNavActive item" precedent as the
// /tilbyder/:providerSlugOrId page (PR #619): oaSiteNav() is called with no
// `active` set. This is a real HTTP 404 — status code and Content-Type stay
// exactly as before; only the body's markup is upgraded.
router.use((_req: Request, res: Response) => {
  res.status(404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const main = `
  <div class="head" style="text-align:center;padding:64px 0">
    <h1>Siden finnes ikke</h1>
    <p class="lede">Vi fant ikke siden du leter etter. Gå til forsiden eller prøv discovery-API-et.</p>
    <p><a href="/">Til forsiden</a> &middot; <a href="/api/opplevelser/discover">Discovery-API</a></p>
  </div>`;
  res.send(`<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Side ikke funnet (404) — Opplevagent</title>
<meta name="robots" content="noindex, follow">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${pwaHeadTags()}
<style>${BROWSE_CSS}${OA_CHROME_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
${oaSiteNav({})}
<main id="main" class="container">${main}</main>
${oaSiteFooter({})}
</body>
</html>`);
});

export default router;

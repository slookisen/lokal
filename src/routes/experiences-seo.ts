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
import { getExperiencesAgentCard, OPPLEVAGENT_CUSTOM_GPT_URL } from "../services/experiences-agent-card";
import { getExperiencesOpenapi } from "../services/experiences-openapi";
import { isDisplayablePhone } from "../services/contact-normalizer";
import { isJunkDescription } from "../services/description-quality";
import { INDEXNOW_KEY } from "../services/indexnow-service";
import { htmlLangAttr, ogLocale, type Lang } from "../i18n/t";
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
  getPublishedProviderById,
  getPublishedProviderBySlug,
  getGardssalgProviderBySlug,
  backfillProviderSlugs,
  searchPublishedExperiences,
  listGardssalgProviders,
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
} from "../services/experience-store";
import { EXPERIENCE_TAGS, type ExperienceTag } from "../services/experience-tags";
import { geocodingService } from "../services/geocoding-service";
import {
  createBooking,
  getBookingByRef,
  BookingInputSchema,
  sendBookingConfirmation,
  // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0
  isBookingPaused,
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
} from "../services/booking-store";
import { getOaHomeCounters } from "../services/oa-home-counters";

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

// ─────────────────────────────────────────────────────────────
// Homepage UI strings (NO/EN). Phase-1 i18n: only the landing page
// is genuinely bilingual; browse/detail stay NO-canonical for now.
// ─────────────────────────────────────────────────────────────
function homeStrings(lang: Lang) {
  const no = {
    metaTitle: "Opplevagent — Kuratert markedsplass for norske opplevelser",
    metaDesc: "Opplevagent er en kuratert markedsplass for norske opplevelser og aktiviteter — hvalsafari, trehytter, guidede turer, mat og mer. Søkbar for AI-agenter etter sted, vær, sesong og gruppestørrelse.",
    ogTitle: "Opplevagent — norske opplevelser, søkbart for AI-agenter",
    ogImageAlt: "Opplevagent — markedsplass for norske opplevelser",
    skip: "Hopp til hovedinnhold",
    brandAria: "Opplevagent forside",
    navAria: "Hovednavigasjon",
    navAll: "Alle opplevelser", navCategories: "Kategorier", navHow: "Slik funker det", navAgents: "For AI-agenter", navExplore: "Utforsk",
    heroPill: "A2A-markedsplass for norske opplevelser",
    heroH1: "Hva kan vi finne på ", heroAccent: "i dag?",
    heroSub: "Fra hvalsafari og trehytter til guidede fjellturer, matopplevelser og lasertag &mdash; en kuratert oversikt over norske opplevelser, bygget for å bli oppdaget og spurt av AI-agenter.",
    searchAria: "Finn opplevelser", searchLabel: "Beskriv hva du vil finne på, eller skriv et sted", searchPlaceholder: "Søk: hvalsafari, Oslo, mat …", searchBtn: "Finn opplevelser",
    hintPre: "Søk på sted, kategori eller aktivitet &mdash; eller ", hintLink: "bla i alle opplevelser", hintPost: ". Agenter kan kalle ", hintPost2: " direkte.",
    quickAria: "Hurtigsøk", qNature: "Ute i naturen", qAll: "Alle opplevelser",
    trustAria: "Tillit og datakilder", trustBrreg: "Tilbydere verifisert mot Brønnøysundregistrene", trustFresh: "Innhold oppdatert fortløpende", trustMachine: "Maskinlesbar for AI-agenter",
    counterAria: "Opplevagent i tall",
    counterPageviews: "Sidevisninger", counterUnique: "Unike besøkende", counterHumans: "Ekte mennesker", counterBots: "Bot &amp; AI-trafikk",
    counterExperiences: "Opplevelser", counterProviders: "Tilbydere", counterMunicipalities: "Kommuner",
    catKicker: "Utforsk", catTitle: "Opplevelser etter kategori", catIntro: "Bla i kuraterte kategorier &mdash; eller la en AI-agent filtrere på vær, sesong, pris og gruppestørrelse for deg.", catAria: "Kategorier", catCount: "opplevelser", catSoon: "Kommer snart", catNote: "Eksempelkategorier &mdash; live opplevelser publiseres fortløpende.",
    fylkeKicker: "Steder", fylkeTitle: "Utforsk etter fylke", fylkeIntro: "Se hvor opplevelsene finnes &mdash; velg et fylke for en fullstendig oversikt.", fylkeAria: "Fylker",
    kommuneTitle: "Populære kommuner", kommuneAria: "Populære kommuner",
    howKicker: "Tillitsmodell", howTitle: "Slik funker det", howSub: "Kuratert, verifisert og beriket &mdash; tre steg som skiller Opplevagent fra en vanlig oppføringsliste.",
    srcLabel: "Kilde:",
    s1t: "Kuratert innhenting", s1b: "Opplevelser høstes fortløpende fra kuraterte kilder &mdash; ikke et åpent annonsemarked, men et utvalg av reelle norske tilbydere.", s1src: "kuraterte tilbyderkilder",
    s2t: "Verifisert tilbyder", s2bPre: "Hver tilbyder kontrolleres mot Brønnøysundregistrene for å bekrefte at det står et ", s2bStrong: "aktivt selskap", s2bPost: " bak opplevelsen.", s2src: "Brønnøysundregistrene (Brreg)",
    s3t: "Beriket innhold", s3b: "Detaljer berikes fra tilbyderens egen nettside, slik at beskrivelser, varighet og praktisk info blir presise og oppdaterte.", s3src: "tilbyderens egen side",
    agentsKicker: "For AI-agenter", agentsTitle: "Bygget for å bli spurt av agenter", agentsBody: "Opplevagent eksponerer åpne, maskinlesbare flater etter A2A-protokollen. Agenter kan oppdage tilbudet, lese kontrakten og kjøre intent-søk &mdash; uten skraping.",
    endpointsAria: "Endepunkter for agenter", codeAria: "Eksempler på agent-kall", codeCmt1: "# message/send &mdash; naturlig språk", codeCmt2: "«hva kan vi finne på i Tromsø i vinter?»",
    footTagline: "Kuratert markedsplass for norske opplevelser og aktiviteter &mdash; søkbar for mennesker og AI-agenter.", footExplore: "Utforsk", footAgents: "For agenter", footPrivacy: "Personvern", footTerms: "Vilkår", footVerified: "Tilbydere verifisert mot Brønnøysundregistrene",
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
    heroPill: "A2A marketplace for Norwegian experiences",
    heroH1: "What can we do ", heroAccent: "today?",
    heroSub: "From whale safaris and treehouses to guided mountain hikes, food experiences and laser tag &mdash; a curated overview of Norwegian experiences, built to be discovered and queried by AI agents.",
    searchAria: "Find experiences", searchLabel: "Describe what you want to do, or type a place", searchPlaceholder: "Search: whale safari, Oslo, food …", searchBtn: "Find experiences",
    hintPre: "Search by place, category or activity &mdash; or ", hintLink: "browse all experiences", hintPost: ". Agents can call ", hintPost2: " directly.",
    quickAria: "Quick search", qNature: "Outdoors", qAll: "All experiences",
    trustAria: "Trust and data sources", trustBrreg: "Providers verified against the Norwegian business registry", trustFresh: "Content updated continuously", trustMachine: "Machine-readable for AI agents",
    counterAria: "Opplevagent in numbers",
    counterPageviews: "Page views", counterUnique: "Unique visitors", counterHumans: "Real humans", counterBots: "Bot &amp; AI traffic",
    counterExperiences: "Experiences", counterProviders: "Providers", counterMunicipalities: "Municipalities",
    catKicker: "Explore", catTitle: "Experiences by category", catIntro: "Browse curated categories &mdash; or let an AI agent filter by weather, season, price and group size for you.", catAria: "Categories", catCount: "experiences", catSoon: "Coming soon", catNote: "Example categories &mdash; live experiences are published continuously.",
    fylkeKicker: "Places", fylkeTitle: "Explore by county", fylkeIntro: "See where the experiences are &mdash; pick a county for a full overview.", fylkeAria: "Counties",
    kommuneTitle: "Popular municipalities", kommuneAria: "Popular municipalities",
    howKicker: "Trust model", howTitle: "How it works", howSub: "Curated, verified and enriched &mdash; three steps that set Opplevagent apart from an ordinary listing.",
    srcLabel: "Source:",
    s1t: "Curated collection", s1b: "Experiences are gathered continuously from curated sources &mdash; not an open ad market, but a selection of real Norwegian providers.", s1src: "curated provider sources",
    s2t: "Verified provider", s2bPre: "Each provider is checked against the Norwegian business registry to confirm there's an ", s2bStrong: "active company", s2bPost: " behind the experience.", s2src: "Brønnøysund business registry (Brreg)",
    s3t: "Enriched content", s3b: "Details are enriched from the provider's own website, so descriptions, duration and practical info are accurate and up to date.", s3src: "the provider's own site",
    agentsKicker: "For AI agents", agentsTitle: "Built to be queried by agents", agentsBody: "Opplevagent exposes open, machine-readable surfaces following the A2A protocol. Agents can discover the offering, read the contract and run intent searches &mdash; without scraping.",
    endpointsAria: "Endpoints for agents", codeAria: "Examples of agent calls", codeCmt1: "# message/send &mdash; natural language", codeCmt2: "«what can we do in Tromsø this winter?»",
    footTagline: "Curated marketplace for Norwegian experiences and activities &mdash; searchable for humans and AI agents.", footExplore: "Explore", footAgents: "For agents", footPrivacy: "Privacy", footTerms: "Terms", footVerified: "Providers verified against the Norwegian business registry",
  };
  return lang === "en" ? en : no;
}

// ═══════════════════════════════════════════════════════════
// GET / — minimal landing (Opplevagent, NOT the rfb homepage)
// ═══════════════════════════════════════════════════════════

router.get("/", (req: Request, res: Response) => {
  const url = baseUrl();
  const year = new Date().getFullYear();
  const lang: Lang = req.lang === "en" ? "en" : "no";
  const S = homeStrings(lang);
  const canonical = lang === "en" ? `${url}/en` : url;

  // Categories are read defensively — the page must render perfectly with 0
  // Counter strip: live, host-scoped (opplevagent.no only) social-proof
  // numbers — server-rendered + cached (see src/services/oa-home-counters.ts
  // for the exact scoping/exclusion rules this reuses from the RFB homepage
  // pattern). Read defensively — must never break the homepage.
  const numFmt = lang === "en" ? "en-US" : "nb-NO";
  let counters = { pageViews: 0, uniqueVisitors: 0, realHumans: 0, botAndAi: 0, opplevelser: 0, tilbydere: 0, kommuner: 0 };
  try {
    counters = getOaHomeCounters();
  } catch {
    // Analytics/catalog DB not open — render the strip with 0s rather than
    // failing the whole homepage.
  }
  const counterStripHtml = `
  <div class="counters" aria-label="${S.counterAria}">
    <div class="counters-inner">
      <div class="counter-item"><div class="counter-val">${counters.pageViews.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterPageviews}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.uniqueVisitors.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterUnique}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.realHumans.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterHumans}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val counter-val-accent">${counters.botAndAi.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterBots}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.opplevelser.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterExperiences}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.tilbydere.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterProviders}</div></div>
      <div class="counter-sep" aria-hidden="true"></div>
      <div class="counter-item"><div class="counter-val">${counters.kommuner.toLocaleString(numFmt)}</div><div class="counter-lbl">${S.counterMunicipalities}</div></div>
    </div>
  </div>`;

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
  // Phase 1 — Gårdssalg feature flag: inject the gardssalg card when the
  // provider seed set crosses the visibility threshold and the category is not
  // already present (e.g. because there are no published experiences yet).
  let catSource = usingFallbackCats ? fallbackCats : cats.slice(0, 12);
  if (!usingFallbackCats && gardssalgVisible() && !catSource.some((c) => c.category === "gardssalg")) {
    // Live count, not hardcoded 0 — gardssalgVisible() already proved the
    // count is >= GARDSSALG_VISIBILITY_THRESHOLD, so this card must never
    // render the "Kommer snart" (coming soon) badge once visible.
    let gardssalgCount = 0;
    try { gardssalgCount = countGardssalgProviders(); } catch { /* DB not open — keep 0 */ }
    catSource = [...catSource, { category: "gardssalg", count: gardssalgCount }].slice(0, 12);
  }

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
      return `<a class="cat-card" href="${href}">
        <span class="cat-ico" aria-hidden="true">${catIconSvg(c.category, 26)}</span>
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
        "Kuratert markedsplass for norske opplevelser og aktiviteter — bygget for å bli oppdaget og spurt av AI-agenter.",
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

  /* ── HEADER / NAV ── */
  .site-nav{position:sticky;top:0;z-index:100;background:rgba(244,248,244,.86);backdrop-filter:saturate(160%) blur(12px);border-bottom:1px solid var(--line)}
  .nav-inner{max-width:var(--maxw);margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
  @media(max-width:560px){.nav-inner{padding:0 16px}}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.16rem;letter-spacing:-.02em;color:var(--fjord-800);text-decoration:none}
  .brand:hover{text-decoration:none}
  .brand-word{font-family:var(--font-brand);font-weight:600;font-size:1.3rem;letter-spacing:-.015em;text-transform:lowercase;line-height:1;color:var(--ink)}
  .brand-word .tld{color:var(--fjord-600)}
  .brand .mark{display:flex;align-items:center;justify-content:center}
  .brand .mark svg{display:block}
  .nav-links{display:flex;gap:26px;align-items:center}
  .nav-links a{font-size:.88rem;font-weight:600;color:var(--ink-soft)}
  .nav-links a:hover{color:var(--fjord-700)}
  .nav-cta{padding:8px 16px;border-radius:var(--r-pill);background:var(--fjord-800);color:#fff!important;font-size:.84rem;font-weight:700}
  .nav-cta:hover{background:var(--fjord-700);text-decoration:none!important}
  @media(max-width:760px){.nav-links a:not(.nav-cta){display:none}}

  /* ── HERO ── */
  .hero{position:relative;overflow:hidden;color:#fff;background:linear-gradient(135deg,#0b2e29 0%,#0e3c36 34%,#0f5a50 56%,#12a594 82%,#ff5d3b 136%)}
  .hero::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 18% 8%,rgba(60,195,180,.30),transparent 55%),radial-gradient(90% 80% at 92% 18%,rgba(255,93,59,.28),transparent 60%);pointer-events:none}
  .hero-range{position:absolute;left:0;right:0;bottom:-1px;height:140px;opacity:.55;pointer-events:none}
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

  /* fylke grid + kommune chips */
  .fylke-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
  .fylke-card{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:16px 18px;box-shadow:var(--sh-sm);transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
  .section-alt .fylke-card{background:var(--canvas)}
  .fylke-card:hover{transform:translateY(-3px);box-shadow:var(--sh-md);border-color:var(--teal-400);text-decoration:none}
  .fylke-card-name{display:block;font-weight:700;color:var(--ink);font-size:1rem;letter-spacing:-.01em}
  .fylke-card-count{display:block;margin-top:4px;font-size:.82rem;color:var(--mist)}
  .fylke-kommuner{margin-top:36px}
  .fylke-kommuner h3{font-size:.95rem;font-weight:700;color:var(--ink);margin-bottom:12px}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.82rem;font-weight:600;border:1px solid var(--line)}
  .chip:hover{text-decoration:none;border-color:var(--teal-400);color:var(--fjord-700)}
  .chip .n{color:var(--mist);font-weight:600}

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
<a class="skip-link" href="#hovedinnhold">${S.skip}</a>

<header class="site-nav">
  <div class="nav-inner">
    <a class="brand" href="/" aria-label="${S.brandAria}">${brandInner("light")}</a>
    <nav class="nav-links" aria-label="${S.navAria}">
      <a href="/opplevelser">${S.navAll}</a>
      <a href="#kategorier">${S.navCategories}</a>
      <a href="#slik-funker-det">${S.navHow}</a>
      <a href="#for-agenter">${S.navAgents}</a>
      <a class="lang-toggle" href="${lang === "en" ? "/" : "/en"}" hreflang="${lang === "en" ? "nb" : "en"}" aria-label="${lang === "en" ? "Bytt til norsk" : "Switch to English"}" style="border:1px solid var(--line);border-radius:var(--r-pill);padding:5px 11px;font-size:.8rem;font-weight:600;color:var(--ink-soft)">${lang === "en" ? "NO" : "EN"}</a>
      <a class="nav-cta" href="/opplevelser">${S.navExplore}</a>
    </nav>
  </div>
</header>

<main id="hovedinnhold">
  <section class="hero" aria-labelledby="hero-title">
    <svg class="hero-range" viewBox="0 0 1440 140" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 140 L0 96 L150 40 L300 92 L470 24 L640 88 L820 36 L1010 96 L1200 48 L1340 90 L1440 60 L1440 140 Z" fill="rgba(24,19,13,.45)"/>
      <path d="M0 140 L0 116 L210 72 L420 112 L640 70 L900 118 L1150 82 L1440 110 L1440 140 Z" fill="rgba(24,19,13,.65)"/>
    </svg>
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
        <p class="discover-hint">${S.hintPre}<a href="/opplevelser" style="color:#fff;text-decoration:underline">${S.hintLink}</a>${S.hintPost}<code>GET /api/opplevelser/discover</code>${S.hintPost2}</p>
        <div class="quick" role="list" aria-label="${S.quickAria}">
          <a role="listitem" href="/fylke/Oslo">Oslo</a>
          <a role="listitem" href="/fylke/Troms%20og%20Finnmark">Troms og Finnmark</a>
          <a role="listitem" href="/sok?q=natur">${S.qNature}</a>
          <a role="listitem" href="/opplevelser">${S.qAll}</a>
        </div>
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

  <section class="section" id="kategorier" aria-labelledby="kat-title">
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

<footer class="site-footer" role="contentinfo">
  <div class="footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="${S.brandAria}">${brandInner("dark")}</a>
      <p>${S.footTagline}</p>
    </div>
    <div class="footer-col">
      <h4>${S.footExplore}</h4>
      <a href="/opplevelser">${S.navAll}</a>
      <a href="#kategorier">${S.navCategories}</a>
      <a href="#slik-funker-det">${S.navHow}</a>
      <a href="/kontakt">${lang === "en" ? "Contact us" : "Kontakt oss"}</a>
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
</footer>

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
    { p: "/en", freq: "daily", pri: "0.9" },
    { p: "/opplevelser", freq: "daily", pri: "0.9" },
    { p: "/guide-opplevelser-mcp", freq: "monthly", pri: "0.6" },
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
  try {
    for (const row of listPublishedCategories()) {
      if (!row.category) continue;
      xml += `\n  <url><loc>${url}/kategori/${encodeURIComponent(row.category)}</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>`;
    }
    // Phase 1 — gardssalg feature flag: include /kategori/gardssalg in sitemap
    // when the provider seed set meets the visibility threshold, even before the
    // category has published experiences (so Googlebot crawls the page early).
    if (gardssalgVisible()) {
      xml += `\n  <url><loc>${url}/kategori/gardssalg</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    for (const row of listPublishedFylker()) {
      if (!row.fylke) continue;
      xml += `\n  <url><loc>${url}/fylke/${encodeURIComponent(row.fylke)}</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    for (const row of listPublishedKommuner()) {
      if (!row.kommune) continue;
      xml += `\n  <url><loc>${url}/kommune/${encodeURIComponent(row.kommune)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${today}</lastmod></url>`;
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
      xml += `\n  <url><loc>${url}/kategori/${encodeURIComponent(row.category)}/${encodeURIComponent(row.kommune)}</loc><changefreq>weekly</changefreq><priority>0.5</priority><lastmod>${today}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    // Back-fill slugs for any providers added since the last /tilbyder/ request.
    // backfillProviderSlugs() is idempotent (WHERE slug IS NULL — fast no-op when
    // all providers already have slugs), so calling it here is safe on every
    // sitemap request. We call it directly (not via ensureProviderSlugs()) so the
    // one-shot flag does not prevent re-checking for newly-inserted slugless rows.
    try { backfillProviderSlugs(); } catch { /* DB not yet open */ }
    for (const row of listPublishedProviders()) {
      if (!row.id) continue;
      const tilbyderSeg = row.slug ? encodeURIComponent(row.slug) : encodeURIComponent(row.id);
      xml += `\n  <url><loc>${url}/tilbyder/${tilbyderSeg}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${today}</lastmod></url>`;
    }
  } catch { /* experiences DB not open */ }
  try {
    for (const row of listPublishedExperienceSlugs()) {
      if (!row.slug) continue;
      const lastmod = (row.updated_at || today).slice(0, 10);
      xml += `\n  <url><loc>${url}/opplevelse/${encodeURIComponent(row.slug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>`;
    }
  } catch { /* experiences DB not open — static sitemap only */ }
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
    $schema: "https://modelcontextprotocol.io/schemas/2025-11/server-card.schema.json",
    schemaVersion: "2025-11",
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
  const glyph = catIconSvg(cat, 72, "hero-glyph");
  return `<figure class="hero-media hero-placeholder" role="img" aria-label="${escapeHtml(catLabel(cat))} — illustrasjon">
      ${glyph}
      <figcaption class="hero-cap">${escapeHtml(catLabel(cat))}</figcaption>
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
  const canonical = `${url}/opplevelse/${encodeURIComponent(slug)}`;
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

  // Meta description: own summary if present, else a generated one.
  const metaDescRaw = safeExpDescription
    || `${exp.title}${place ? " i " + place : ""}. ${catLabel(cat)} på Opplevagent — kuratert markedsplass for norske opplevelser med Brreg-verifiserte tilbydere.`;
  const metaDesc = metaDescRaw.length > 155 ? metaDescRaw.slice(0, 152).trim() + "…" : metaDescRaw;

  // Badges row.
  const badges: string[] = [];
  if (cat) badges.push(`<a class="badge badge-cat" href="/kategori/${encodeURIComponent(cat)}">${escapeHtml(catLabel(cat))}</a>`);
  if (exp.indoor_outdoor) badges.push(`<span class="badge">${escapeHtml(ioLabel(exp.indoor_outdoor))}</span>`);
  for (const s of exp.season || []) badges.push(`<span class="badge">${escapeHtml(seasonLabel(s))}</span>`);
  if (brregVerified) badges.push(`<span class="badge badge-verified" title="Tilbyder verifisert mot Brønnøysundregistrene">✓ Brreg-verifisert</span>`);

  // Facts table.
  const facts: Array<[string, string]> = [];
  if (cat) facts.push(["Kategori", `<a href="/kategori/${encodeURIComponent(cat)}">${escapeHtml(catLabel(cat))}</a>`]);
  if (exp.fylke) facts.push(["Fylke", `<a href="/fylke/${encodeURIComponent(exp.fylke)}">${escapeHtml(exp.fylke)}</a>`]);
  if (exp.kommune) facts.push(["Kommune", `<a href="/kommune/${encodeURIComponent(exp.kommune)}">${escapeHtml(exp.kommune)}</a>`]);
  if (exp.indoor_outdoor) facts.push(["Inne / ute", escapeHtml(ioLabel(exp.indoor_outdoor))]);
  if ((exp.season || []).length) facts.push(["Sesong", escapeHtml((exp.season || []).map(seasonLabel).join(", "))]);
  if (exp.duration_min || exp.duration_max) {
    const d = exp.duration_min && exp.duration_max && exp.duration_min !== exp.duration_max
      ? `${exp.duration_min}–${exp.duration_max} min`
      : `ca. ${exp.duration_min || exp.duration_max} min`;
    facts.push(["Varighet", escapeHtml(d)]);
  }
  if (exp.group_min || exp.group_max) {
    const g = exp.group_min && exp.group_max ? `${exp.group_min}–${exp.group_max} personer`
      : exp.group_max ? `inntil ${exp.group_max} personer` : `fra ${exp.group_min} personer`;
    facts.push(["Gruppe", escapeHtml(g)]);
  }
  if (exp.price_from || exp.price_band) {
    const unit = exp.price_unit === "per_person" ? " pr. person" : exp.price_unit === "per_group" ? " pr. gruppe" : "";
    const pr = exp.price_from
      ? `fra ${exp.price_from} kr${unit}`
      : (PRICE_BAND_LABELS[String(exp.price_band)] || String(exp.price_band));
    facts.push(["Pris", escapeHtml(pr)]);
  }
  if ((exp.languages || []).length) facts.push(["Språk", escapeHtml((exp.languages || []).join(", "))]);
  if ((exp.accessibility || []).length) facts.push(["Tilgjengelighet", escapeHtml((exp.accessibility || []).join(", "))]);
  if (exp.meeting_point) facts.push(["Oppmøte", escapeHtml(exp.meeting_point)]);
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
    cta = `<a class="cta" href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener nofollow">Book / les mer hos tilbyder →</a>`;
  } else if (provSite) {
    cta = `<a class="cta" href="${escapeHtml(provSite)}" target="_blank" rel="noopener nofollow">Besøk tilbyderens nettside →</a>`;
  } else {
    cta = `<p class="cta-soft">Bestilling skjer hos tilbyder. Kontaktinfo kommer.</p>`;
  }
  // Phone — rendered only when the provider has one on file (no fabrication).
  const phoneBlock = provTel
    ? `<p class="prov-phone">Telefon: <a href="tel:${escapeHtml(provTel.replace(/\s+/g, ""))}">${escapeHtml(provTel)}</a></p>`
    : "";

  // Provider card.
  const provInner = provName
    ? `<p class="prov-name">${provSite ? `<a href="${escapeHtml(provSite)}" target="_blank" rel="noopener">${escapeHtml(provName)}</a>` : escapeHtml(provName)}</p>
       ${brregVerified ? `<p class="prov-verified">✓ Verifisert mot Brønnøysundregistrene${orgNr ? ` · org.nr ${escapeHtml(orgNr)}` : ""}</p>` : `<p class="prov-soft">Tilbyder under verifisering.</p>`}
       <p class="prov-link"><a href="/tilbyder/${escapeHtml(String(provider!.slug || provider!.id))}">Alle opplevelser fra denne tilbyderen →</a></p>`
    : `<p class="prov-soft">Tilbyder er ikke matchet ennå.</p>`;

  // Map block — coords from experience, else provider; graceful no-geo fallback.
  const lat = numOrNull(exp.loc_lat) ?? numOrNull(provider ? provider.lat : null);
  const lon = numOrNull(exp.loc_lon) ?? numOrNull(provider ? provider.lon : null);
  const mapBlock = (lat !== null && lon !== null)
    ? `<a class="map-card" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}" target="_blank" rel="noopener" aria-label="Åpne posisjon i OpenStreetMap">
         <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>
         <span><strong>${escapeHtml(place || "Posisjon")}</strong><span class="map-sub">Åpne i kart (OpenStreetMap)</span></span>
       </a>`
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
    .map((r) => `<a class="rel-card" href="/opplevelse/${encodeURIComponent(r.slug)}">
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
  if (lat !== null && lon !== null) ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lon };
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
  const titleWithPlace = `${exp.title}${place ? " – " + place : ""}`;
  const title = seoPageTitle(
    titleWithPlace.length + BRAND.length <= MAX_TITLE ? titleWithPlace : exp.title
  );

  return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#0e3c36">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="${escapeHtml(exp.title)}">
<meta property="og:description" content="${escapeHtml(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${url}/favicon.svg">
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
  a.badge-cat{background:var(--fjord-800);color:#fff;border-color:var(--fjord-800)}
  a.badge-cat:hover{background:var(--fjord-700);text-decoration:none}
  .badge-verified{background:#e7f6ec;color:#0f7a3d;border-color:#bfe6cd}
  .layout{display:grid;grid-template-columns:1fr 340px;gap:32px;margin:26px 0 10px;align-items:start}
  @media(max-width:860px){.layout{grid-template-columns:1fr;gap:22px}}
  .lede{font-size:1.08rem;color:var(--ink);margin-bottom:22px}
  .lede-soft{color:var(--ink-soft)}
  .hero-media{margin:0 0 24px;border-radius:var(--r-lg);overflow:hidden;border:1px solid var(--line);box-shadow:var(--sh-sm)}
  .hero-media img{display:block;width:100%;height:auto;aspect-ratio:2/1;object-fit:cover}
  .hero-placeholder{position:relative;aspect-ratio:2/1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:linear-gradient(150deg,var(--canvas-2),var(--canvas));color:var(--fjord-600)}
  .hero-placeholder::after{content:"";position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px,rgba(15,81,50,.10) 1px,transparent 0);background-size:18px 18px;pointer-events:none}
  .hero-glyph{position:relative;z-index:1;opacity:.85}
  .hero-cap{position:relative;z-index:1;font-size:.82rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--mist)}
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
  .rel-card{display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px}
  .rel-card:hover{text-decoration:none;border-color:var(--fjord-600);box-shadow:var(--sh-sm)}
  .rel-title{font-weight:700;color:var(--ink);font-size:.95rem}
  .rel-meta{font-size:.82rem;color:var(--mist)}
  .site-foot{margin-top:48px;border-top:1px solid var(--line);background:var(--canvas-2)}
  .foot-inner{max-width:var(--maxw);margin:0 auto;padding:26px 24px;font-size:.84rem;color:var(--mist);display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}
  .foot-inner a{color:var(--ink-soft)}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav"><div class="nav-inner">
  <a class="brand" href="/">${brandInner("light")}</a>
  <span class="nav-links"><a href="/">Forsiden</a><a href="/#kategorier">Kategorier</a></span>
</div></nav>
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmuler">
    <a href="/">Forsiden</a>${cat ? `<span class="sep">/</span><a href="/kategori/${encodeURIComponent(cat)}">${escapeHtml(catLabel(cat))}</a>` : ""}<span class="sep">/</span>${escapeHtml(exp.title)}
  </nav>
  <header class="head">
    <h1>${escapeHtml(lang === "no" ? (exp.title_no || exp.title) : exp.title)}</h1>
    ${place ? `<p class="place"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="9" r="2.3" fill="currentColor"/></svg>${escapeHtml(place)}</p>` : ""}
    <div class="badges">${badges.join("")}</div>
  </header>
  <div class="layout">
    <article>
      ${heroMedia}
      ${descBlock}
      <table class="facts"><caption class="skip-link">Fakta om opplevelsen</caption><tbody>${factsRows}</tbody></table>
      ${evBlock}
    </article>
    <aside class="aside">
      <div class="card"><h2>Bestilling</h2>${cta}${phoneBlock}</div>
      <div class="card"><h2>Tilbyder</h2>${provInner}</div>
      <div class="card"><h2>Sted</h2>${mapBlock}</div>
    </aside>
  </div>
  ${relBlock}
</main>
<footer class="site-foot"><div class="foot-inner">
  <span>© ${new Date().getFullYear()} Opplevagent — kuratert markedsplass for norske opplevelser.</span>
  <span><a href="/">Forsiden</a> · <a href="/llms.txt">llms.txt</a> · <a href="/sitemap.xml">Sitemap</a></span>
</div></footer>
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
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 4px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.82rem;font-weight:600;border:1px solid var(--line)}
  .chip:hover{text-decoration:none;border-color:var(--teal-400);color:var(--fjord-700)}
  .chip .n{color:var(--mist);font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin:22px 0 8px}
  .card{display:flex;flex-direction:column;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:18px 18px;box-shadow:var(--sh-sm);transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}
  .card:hover{transform:translateY(-3px);box-shadow:var(--sh-md);border-color:var(--teal-400);text-decoration:none}
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

// Brand nav + footer shared by every browse page.
const BROWSE_NAV = `<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav"><div class="nav-inner">
  <a class="brand" href="/">${brandInner("light")}</a>
  <span class="nav-links"><a href="/opplevelser">Alle opplevelser</a><a href="/#kategorier">Kategorier</a></span>
</div></nav>`;

function browseFooter(): string {
  return `<footer class="site-foot"><div class="foot-inner">
  <span>© ${new Date().getFullYear()} Opplevagent — kuratert markedsplass for norske opplevelser.</span>
  <span><a href="/opplevelser">Alle opplevelser</a> · <a href="/llms.txt">llms.txt</a> · <a href="/sitemap.xml">Sitemap</a></span>
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
  const tags: string[] = [];
  if (row.category) tags.push(`<span class="tag tag-cat">${escapeHtml(catLabel(row.category))}</span>`);
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
  return `<a class="card" href="/opplevelse/${encodeURIComponent(row.slug)}">
    <span class="c-title">${escapeHtml(displayTitle)}</span>
    ${place ? `<span class="c-place">${PIN_SVG}${escapeHtml(place)}</span>` : ""}
    ${distanceHtml}
    ${desc}
    <span class="c-meta">${tags.join("")}</span>
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
<meta property="og:title" content="${escapeHtml(opts.h1)}">
<meta property="og:description" content="${escapeHtml(opts.metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${url}/favicon.svg">
<meta name="twitter:card" content="summary">
${ldScripts}
<style>${BROWSE_CSS}</style>
</head>
<body>
${BROWSE_NAV}
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmuler">${crumbHtml}</nav>
  <header class="head">
    <h1>${escapeHtml(opts.h1)}</h1>
    ${opts.lede ? `<p class="lede">${escapeHtml(opts.lede)}</p>` : ""}
    <p class="count">${opts.total} ${opts.total === 1 ? "opplevelse" : "opplevelser"}</p>
  </header>
  ${opts.extraTopHtml || ""}
  ${grid}
  ${pager}
</main>
${browseFooter()}
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
  const catChips = cats
    .map((c) => `<a class="chip" href="/kategori/${encodeURIComponent(c.category)}">${escapeHtml(catLabel(c.category))} <span class="n">${c.count}</span></a>`)
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

function searchBox(currentQ: string): string {
  return `<div class="searchbar">
    <form action="/sok" method="GET" role="search" aria-label="Søk i opplevelser">
      <span class="field">${SEARCH_SVG}
        <label for="sok-q" class="skip-link">Søk i opplevelser</label>
        <input id="sok-q" name="q" type="search" autocomplete="off" placeholder="Søk: hvalsafari, Tromsø, mat …" value="${escapeHtml(currentQ)}">
      </span>
      <button type="submit">Søk</button>
    </form>
  </div>`;
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
      "Bla i alle kuraterte norske opplevelser på Opplevagent — hvalsafari, trehytter, guidede turer, mat og mer. Tilbydere verifisert mot Brønnøysundregistrene.",
    lede: "Kuratert oversikt over norske opplevelser og aktiviteter. Filtrer på kategori eller fylke, eller søk fritt.",
    canonicalPath: "/opplevelser",
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser" }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox("") + facetChips(),
    emptyTitle: "Ingen publiserte opplevelser ennå",
    emptyBody: "Vi verifiserer og publiserer nye opplevelser fortløpende. Kom gjerne tilbake snart.",
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

// ─── GET /kategori/gardssalg — Gårdssalg & smaking provider catalog ──────────
// Gardssalg shows experience_providers (drink producers), not experiences.
// The generic /kategori/:category route queries the experiences table and returns
// 404 when count=0 — this special handler intercepts "gardssalg" before that.
// Rendered as a paginated provider listing reusing the opplevagent brand/CSS.
router.get("/kategori/gardssalg", (req: Request, res: Response) => {
  const page = parsePage(req.query.page);
  const PAGE_SIZE = 24;
  const providers = listGardssalgProviders(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const total = countGardssalgProviders();

  function renderProviderCard(p: GardssalgProviderRow): string {
    const sted = [p.poststed ?? p.kommune ?? p.fylke].filter(Boolean).join(", ");
    const badge = drinkBadge(p.producer_type);
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
      ? `<a href="${profileHref}" style="color:inherit;font-weight:700;font-size:1rem;text-decoration:none">${escapeHtml(p.navn)}</a>`
      : `<span style="font-weight:700;font-size:1rem">${escapeHtml(p.navn)}</span>`;
    const link = bookHref
      ? `<a href="${bookHref}" style="display:inline-block;margin-top:10px;padding:8px 16px;background:#0f5a50;color:#fff;border-radius:6px;font-size:.84rem;font-weight:600;text-decoration:none">Book besøk</a>`
      : "";
    // Discreet "coming soon" marker (dev-request 2026-07-12-gardssalg-dark-
    // launch-stop, slice 0) — small and unobtrusive by design (the prominent
    // version lives on the booking panel/produsent profile); uses the shared
    // var(--) tokens from BROWSE_CSS (included in this page's <style> below)
    // rather than hardcoded hex, same discipline as the produsent-profil
    // section even though the rest of this particular card still predates
    // that convention.
    const soonBadge = isBookingPaused(p.booking_live, p.catalog_hidden)
      ? `<span style="display:inline-block;font-size:.68rem;font-weight:600;color:var(--mist);background:var(--canvas-2);border:1px solid var(--line);border-radius:4px;padding:1px 7px;margin-left:6px;vertical-align:middle">Kommer snart</span>`
      : "";
    return `<article style="background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);overflow:hidden;display:flex;flex-direction:column">
  <div style="padding:16px 16px 12px">
    ${sted ? `<div style="font-size:.78rem;color:#7a7163;margin-bottom:4px">${escapeHtml(sted)}</div>` : ""}
    <div style="margin-bottom:6px">${nameHtml}${soonBadge}</div>
    ${badge}
  </div>
  ${link ? `<div style="padding:0 16px 16px;margin-top:auto">${link}</div>` : ""}
</article>`;
  }

  const cards = providers.map(renderProviderCard).join("\n");
  const emptyMsg = total === 0
    ? `<p style="color:#544a3e;margin:40px 0">Ingen drikkeprodusenter er lagt til ennå — kom tilbake snart.</p>`
    : "";

  const paginationLinks: string[] = [];
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (page > 1) paginationLinks.push(`<a href="/kategori/gardssalg?page=${page - 1}">← Forrige</a>`);
  if (page < totalPages) paginationLinks.push(`<a href="/kategori/gardssalg?page=${page + 1}">Neste →</a>`);
  const pagination = paginationLinks.length ? `<nav style="margin:32px 0;display:flex;gap:16px">${paginationLinks.join("")}</nav>` : "";

  const url = "https://opplevagent.no";
  const html = `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gårdssalg og smaking | Opplevagent</title>
<meta name="description" content="Besøk lokale drikkeprodusenter — bryggeri, sideri, mjød og mer. Book en smaking eller omvisning rett hos produsenten.">
<link rel="canonical" href="${url}/kategori/gardssalg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"Gårdssalg og smaking","description":"Lokale drikkeprodusenter med gårdsbesøk og smaking","url":"${url}/kategori/gardssalg"}</script>
<style>
${BROWSE_CSS}
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;margin-top:24px}
@media(max-width:560px){.provider-grid{grid-template-columns:1fr}}
.hero-section{background:linear-gradient(135deg,#0e3c36 0%,#0f5a50 100%);color:#fff;padding:48px 0 40px;margin-bottom:32px}
.hero-kicker{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7;margin-bottom:8px}
.hero-h1{font-size:2rem;font-weight:800;margin-bottom:10px;line-height:1.2}
.hero-sub{opacity:.85;font-size:1rem;max-width:560px;line-height:1.5}
.legal-note{font-size:.78rem;color:#7a7163;margin-top:40px;padding-top:16px;border-top:1px solid #e4ded0}
</style>
</head>
<body>
<a class="skip-link" href="#main">Hopp til innhold</a>
<nav class="site-nav" aria-label="Navigasjon">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="brand-word">opplevagent<span class="tld">.no</span></span></a>
    <span class="nav-links"><a href="/opplevelser">Alle opplevelser</a><a href="/#kategorier">Kategorier</a></span>
  </div>
</nav>
<header class="hero-section">
  <div class="container">
    <div class="hero-kicker">Gårdssalg &amp; smaking</div>
    <h1 class="hero-h1">Lokale drikkeprodusenter</h1>
    <p class="hero-sub">Besøk bryggeri, sideri, mjøderi og mer — book en smaking eller omvisning rett hos produsenten.</p>
  </div>
</header>
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmulesti">
    <a href="/">Forsiden</a> · <a href="/opplevelser">Alle opplevelser</a> · Gårdssalg og smaking
  </nav>
  ${total > 0 ? `<p style="color:#544a3e;font-size:.9rem;margin-top:8px">${total} produsent${total === 1 ? "" : "er"}</p>` : ""}
  ${emptyMsg}
  ${providers.length > 0 ? `<div class="provider-grid">${cards}</div>` : ""}
  ${pagination}
  <p class="legal-note">Vi formidler besøket og smakingen hos produsentene. Selve salget skjer hos produsenten, som har egen kommunal bevilling.</p>
</main>
<footer style="margin-top:48px;padding:24px 0;border-top:1px solid #e4ded0;font-size:.8rem;color:#7a7163;text-align:center">
  <span><a href="/">Forsiden</a> · <a href="/llms.txt">llms.txt</a> · <a href="/sitemap.xml">Sitemap</a></span>
</footer>
</body>
</html>`;

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
function drivingSted(p: GardssalgProviderRow): string {
  return [p.poststed, p.kommune, p.fylke].filter(Boolean).join(", ");
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
    const canonical = `${url}/kategori/gardssalg/produsent/${encodeURIComponent(slug)}`;
    const bookHref = `/kategori/gardssalg/book/${encodeURIComponent(slug)}`;
    const sted = drivingSted(provider);
    const meta = drinkTypeMeta(provider.producer_type);
    const badge = drinkBadge(provider.producer_type);
    const site = safeHttpUrl(provider.hjemmeside);
    const lat = numOrNull(provider.lat);
    const lon = numOrNull(provider.lon);
    // Step D fallback (experiences-geocode-worker.ts): a kommune/fylke
    // centroid, not a real street-address geocode — label it honestly
    // rather than implying exact-address precision.
    const geoApprox = provider.geocode_confidence === "approximate";

    const metaDesc = `Besøk ${provider.navn}${sted ? " i " + sted : ""} — book en smaking eller omvisning direkte hos produsenten på Opplevagent.`;

    // Hero — themed by drink-type color-coding (2026-06-29 UI spec, shared
    // DRINK_TYPE_META also used by drinkBadge()); falls back to the plain
    // gårdssalg teal gradient used on the category page for untyped rows.
    const heroBg = meta
      ? `linear-gradient(135deg,${meta.color} 0%,#0b2e29 75%)`
      : "linear-gradient(135deg,#0e3c36 0%,#0f5a50 100%)";

    // "Om produsenten" — real enriched copy (about_text) when the multi-page-
    // crawl slice has filled it; otherwise the same honest fallback as before
    // (real hjemmeside link when we have one, placeholder copy otherwise).
    const aboutBody = provider.about_text && provider.about_text.trim()
      ? `<p>${escapeHtml(provider.about_text)}</p>`
      : site
      ? `<p>${escapeHtml(provider.navn)} er en lokal drikkeprodusent${sted ? " i " + escapeHtml(sted) : ""}. Les mer om produsenten og produktene på <a href="${escapeHtml(site)}" target="_blank" rel="noopener nofollow">${escapeHtml(hostOf(site))}</a>.</p>`
      : `<p>${escapeHtml(provider.navn)} er en lokal drikkeprodusent${sted ? " i " + escapeHtml(sted) : ""}. Utfyllende presentasjon publiseres fortløpende.</p>`;

    // "Besøket" — real enriched copy (visit_text) when present; otherwise the
    // existing type-general orientation, explicitly not a per-producer claim.
    const visitCopy = provider.producer_type
      ? VISIT_TYPE_COPY[provider.producer_type.toLowerCase()]
      : null;
    const visitBody = provider.visit_text && provider.visit_text.trim()
      ? `<p>${escapeHtml(provider.visit_text)}</p>`
      : visitCopy
      ? `<p>Et besøk hos ${escapeHtml(provider.navn)} inkluderer typisk ${visitCopy}. Nøyaktig program avtales ved reservasjon.</p>`
      : `<p>Detaljer om hva besøket hos ${escapeHtml(provider.navn)} inneholder, publiseres fortløpende. Book et besøk for å avtale program direkte med produsenten.</p>`;

    // Practical info — only rows we actually have data for. Sesong/varighet/
    // pris/kapasitet are NOT yet columns on experience_providers (see comment
    // above the route) so they are intentionally omitted rather than guessed.
    const facts: Array<[string, string]> = [];
    if (sted) facts.push(["Sted", escapeHtml(sted)]);
    if (provider.adresse) facts.push(["Adresse", escapeHtml(provider.adresse)]);
    if (provider.opening_hours_text && provider.opening_hours_text.trim()) facts.push(["Åpningstider", escapeHtml(provider.opening_hours_text)]);
    if (site) facts.push(["Nettside", `<a href="${escapeHtml(site)}" target="_blank" rel="noopener nofollow">${escapeHtml(hostOf(site))}</a>`]);
    if (isDisplayablePhone(provider.telefon)) facts.push(["Telefon", `<a href="tel:${escapeHtml(provider.telefon)}">${escapeHtml(provider.telefon)}</a>`]);
    if (provider.epost) facts.push(["E-post", `<a href="mailto:${escapeHtml(provider.epost)}">${escapeHtml(provider.epost)}</a>`]);
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

    // Map block — same OpenStreetMap-link pattern as /opplevelse/:slug.
    const mapBlock = (lat !== null && lon !== null)
      ? `<a class="map-card" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}" target="_blank" rel="noopener" aria-label="Åpne posisjon i OpenStreetMap">
           <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>
           <span><strong>${escapeHtml(sted || "Posisjon")}</strong><span class="map-sub">${geoApprox ? "Ca. posisjon (kommune) – åpne i kart" : "Åpne i kart (OpenStreetMap)"}</span></span>
         </a>`
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
    // as before.
    const ldDescription = provider.about_text && provider.about_text.trim()
      ? (provider.about_text.trim().length > 300 ? provider.about_text.trim().slice(0, 300).trim() + "…" : provider.about_text.trim())
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
    if (lat !== null && lon !== null) ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lon };
    if (site) ld.sameAs = [site];
    if (isDisplayablePhone(provider.telefon)) ld.telephone = provider.telefon;
    if (provider.epost) ld.email = provider.epost;
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

    const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(provider.navn)}${sted ? " – " + escapeHtml(sted) : ""} | Opplevagent</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<meta name="robots" content="${provider.catalog_hidden === 1 ? "noindex, nofollow" : "index, follow, max-snippet:-1, max-image-preview:large"}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escapeHtml(provider.navn)} | Opplevagent">
<meta property="og:description" content="${escapeHtml(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
<meta property="og:image" content="${url}/favicon.svg">
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
.reserve-notice{font-size:.8rem;font-weight:600;color:var(--fjord-800);background:var(--canvas-2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:10px}
.map-card{display:flex;align-items:center;gap:12px;color:var(--ink-soft);background:var(--canvas-2);border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px}
.map-card:hover{text-decoration:none;border-color:var(--fjord-600)}
.map-card svg{color:var(--fjord-600);flex:0 0 22px}
.map-card strong{display:block;color:var(--ink);font-size:.95rem}
.map-sub{font-size:.8rem;color:var(--mist)}
.map-fallback:hover{border-color:var(--line)}
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
<header class="produsent-hero">
  <div class="container">
    <div class="hero-kicker">Gårdssalg &amp; smaking</div>
    <h1>${escapeHtml(provider.navn)}</h1>
    ${sted ? `<p class="hero-sted">${escapeHtml(sted)}</p>` : ""}
    ${badge}
  </div>
</header>
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmulesti">
    <a href="/">Forsiden</a> · <a href="/kategori/gardssalg">Gårdssalg og smaking</a> · ${escapeHtml(provider.navn)}
  </nav>
  <div class="produsent-layout">
    <article>
      <div class="info-card">
        <h2>Om produsenten</h2>
        ${aboutBody}
      </div>
      <div class="info-card">
        <h2>Besøket</h2>
        ${visitBody}
      </div>
      ${productsBlock}
      <div class="info-card">
        <h2>Praktisk info</h2>
        ${factsBlock}
      </div>
    </article>
    <aside>
      <div class="aside-card">
        <h2>Reserver</h2>
        ${isBookingPaused(provider.booking_live, provider.catalog_hidden) ? `<p class="reserve-notice">Reservasjoner er ikke aktive ennå — kommer snart.</p>` : ""}
        <a class="reserve-cta" href="${bookHref}">Reserver besøk</a>
      </div>
      <div class="aside-card">
        <h2>Sted</h2>
        ${mapBlock}
      </div>
    </aside>
  </div>
  <p class="legal-note" style="font-size:.78rem;color:#7a7163;margin-top:24px;padding-top:16px;border-top:1px solid #e4ded0">Vi formidler besøket og smakingen hos produsenten. Selve salget skjer hos produsenten, som har egen kommunal bevilling.</p>
</main>
<footer style="margin-top:48px;padding:24px 0;border-top:1px solid #e4ded0;font-size:.8rem;color:#7a7163;text-align:center">
  <span><a href="/">Forsiden</a> · <a href="/kategori/gardssalg">Gårdssalg og smaking</a></span>
</footer>
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
    // gate (isBookingPaused()) blocks a submission.
    case "paused":
      return "Reservasjoner er ikke aktive ennå — kommer snart. Du kan sende en interessemelding, men ingen reservasjon blir bekreftet ennå.";
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
    const pausedNotice = notLive
      ? `<div class="notice-paused" role="status"><strong>Kommer snart</strong>Reservasjoner er ikke aktive ennå — kommer snart. Du kan sende en interessemelding, men ingen reservasjon blir bekreftet ennå.</div>`
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
      <label for="slot_at">Dato og tid</label>
      <input id="slot_at" name="slot_at" type="datetime-local" required>
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
          if (status) status.textContent = res.data.message || "Reservasjoner er ikke aktive ennå — kommer snart.";
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
  return new Date(slot).toLocaleString("nb-NO", {
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
      const waitingNote = booking.pre_status === "time_suggested"
        ? `<div class="bekreft-banner ok" role="status">Forslaget ditt er sendt — venter på svar fra gjesten. Du kan foreslå et annet tidspunkt (erstatter forslaget) eller avslå.</div>`
        : "";
      actionsHtml = `${waitingNote}
    ${confirmBtn}
    <form method="POST" action="${postTo}" class="suggest-box">
      <input type="hidden" name="action" value="foresla">
      <label for="suggested_slot">Foreslå nytt tidspunkt</label>
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

  return `${params.label} på Opplevagent: ${countPhrase}${spreadPhrase}${pricePhrase} — kuratert og verifisert mot Brønnøysundregistrene.`;
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

  return `Opplevelser i ${params.kommune}${fylkePart}: ${countPhrase}${categoryPhrase}${pricePhrase} — kuratert og verifisert mot Brønnøysundregistrene.`;
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

  return `${params.categoryLabel} i ${params.kommune}${fylkePart}: ${countPhrase}${providerPhrase}${pricePhrase} — kuratert og verifisert mot Brønnøysundregistrene.`;
}

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
    metaDesc: `${label} i Norge — kuraterte opplevelser på Opplevagent med Brreg-verifiserte tilbydere. ${total} ${total === 1 ? "opplevelse" : "opplevelser"} i kategorien.`,
    lede,
    canonicalPath,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: label }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox(""),
    extraJsonLd: categoryFaqJsonLd ? [categoryFaqJsonLd] : undefined,
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
      return next(); // unknown/empty fylke → 404 (no orphan page)
    }
    rows = listPublishedExperiences({ fylke }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch {
    return next();
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
    metaDesc: `Kuraterte opplevelser og aktiviteter i ${fylke} — verifiserte tilbydere på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede: `Hva kan du finne på i ${fylke}? Kuratert oversikt over opplevelser i fylket.`,
    canonicalPath: fylkeCanonicalPath,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: fylke }],
    rows: effectiveRows,
    total: effectiveTotal,
    page: effectivePage,
    pageSize: effectivePageSize,
    extraTopHtml: searchBox("") + kommuneChips(fylke) + renderNearMeSortButton(geoSort.radiusKm) + geoNoteHtml + sortToggleHtml,
    distanceMap: geoSort.geoActive ? geoSort.distanceMap : undefined,
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
  const genericKommuneLede = `Hva kan du finne på i ${kommune}? Kuratert oversikt over opplevelser i kommunen.`;
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
    metaDesc: `Kuraterte opplevelser og aktiviteter i ${kommune}${fylke ? ", " + fylke : ""} — verifiserte tilbydere på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
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
    metaDesc: `${label} i ${kommune} — kuraterte opplevelser på Opplevagent med Brreg-verifiserte tilbydere. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede,
    canonicalPath,
    crumbs,
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox(""),
    extraJsonLd: produktByFaqJsonLd ? [produktByFaqJsonLd] : undefined,
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
  let ledeBits = `Alle kuraterte opplevelser fra ${navn}`;
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
router.get("/sok", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const activeTags = EXPERIENCE_TAGS.filter((t) => String(req.query[t] ?? "") === "1");

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
    ? `Søkeresultater for «${q}» på Opplevagent — kuraterte norske opplevelser med verifiserte tilbydere.`
    : hasGeo
    ? "Opplevelser nær deg, sortert etter avstand — kuraterte norske opplevelser med verifiserte tilbydere."
    : "Søk blant kuraterte norske opplevelser på Opplevagent — etter sted, kategori eller aktivitet.";
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
  const cards =
    rows.length > 0
      ? `<div class="grid" role="list">${rows.map((r) => renderCard(r, req.lang, distanceMap.get(r.slug))).join("")}</div>`
      : `<div class="empty"><h2>${escapeHtml(emptyTitle)}</h2><p>${escapeHtml(emptyBody)}</p><a class="cta" href="/opplevelser">Se alle opplevelser</a></div>`;

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Forsiden", item: url },
      { "@type": "ListItem", position: 2, name: "Søk", item: canonical },
    ],
  };
  const ldScript = `<script type="application/ld+json">${JSON.stringify(breadcrumbLd).replace(/<\//g, "<\\/")}</script>`;

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
<meta property="og:title" content="${escapeHtml(h1)}">
<meta property="og:description" content="${escapeHtml(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Opplevagent">
${ldScript}
<style>${BROWSE_CSS}</style>
</head>
<body>
${BROWSE_NAV}
<main id="main" class="container">
  <nav class="breadcrumb" aria-label="Brødsmuler"><a href="/">Forsiden</a><span class="sep">/</span><span aria-current="page">Søk</span></nav>
  <header class="head">
    <h1>${escapeHtml(h1)}</h1>
    ${hasQuery ? `<p class="count">${rows.length} ${rows.length === 1 ? "treff" : "treff"}</p>` : ""}
  </header>
  ${searchBox(q)}
  ${renderNearMeBox(q, activeTags, radiusKm)}
  ${geoNote}
  ${renderFilterChips(q, activeTags)}
  ${sortToggle}
  ${cards}
</main>
${browseFooter()}
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
  return `<!DOCTYPE html><html lang="no"><head><meta charset="utf-8"><title>${title} — Opplevagent</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="index, follow"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${LEGAL_CSS}</style></head><body>${bodyHtml}<footer>Opplevagent &middot; <a href="/">opplevagent.no</a> &middot; <a href="/personvern">Personvern</a> &middot; <a href="/vilkar">Vilkår</a> &middot; <a href="/.well-known/agent-card.json">Agent Card</a></footer></body></html>`;
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
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f4ee;color:#18130d;line-height:1.6;min-height:100vh;display:flex;flex-direction:column}
a{color:#0c7264;text-decoration:none}
a:hover{text-decoration:underline}
.site-nav{background:rgba(244,248,244,.92);border-bottom:1px solid #dde8dd;padding:0 24px;height:60px;display:flex;align-items:center;gap:32px;position:sticky;top:0;z-index:100}
.brand{font-weight:800;font-size:1.16rem;color:#0b2e29}
.nav-links{display:flex;gap:22px;font-size:.88rem;font-weight:600;color:#4a6a4f}
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
.site-footer{background:#0b2e29;color:rgba(255,255,255,.66);padding:40px 24px 28px;margin-top:auto}
.footer-inner{max-width:1100px;margin:0 auto;display:flex;flex-wrap:wrap;gap:28px 48px;justify-content:space-between;font-size:.85rem}
.footer-inner a{color:rgba(255,255,255,.62)}
.footer-inner a:hover{color:#fff;text-decoration:none}
.footer-bottom{max-width:1100px;margin:24px auto 0;padding-top:16px;border-top:1px solid rgba(255,255,255,.1);font-size:.78rem;color:rgba(255,255,255,.4)}
</style>
</head>
<body>
<nav class="site-nav">
  <a class="brand" href="/">opplevagent.no</a>
  <div class="nav-links">
    <a href="/opplevelser">Opplevelser</a>
    <a href="#kategorier">Kategorier</a>
    <a href="/kontakt" aria-current="page">Kontakt</a>
  </div>
</nav>

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

<footer class="site-footer">
  <div class="footer-inner">
    <div>
      <div style="font-weight:800;color:#fff;margin-bottom:8px">Opplevagent</div>
      <div>Norske opplevelser for mennesker og AI-agenter.</div>
    </div>
    <div>
      <div style="font-weight:700;color:#fff;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Utforsk</div>
      <a href="/opplevelser">Alle opplevelser</a><br>
      <a href="/#kategorier">Kategorier</a><br>
      <a href="/kontakt">Kontakt oss</a>
    </div>
    <div>
      <div style="font-weight:700;color:#fff;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">For agenter</div>
      <a href="/llms.txt">llms.txt</a><br>
      <a href="/.well-known/agent-card.json">agent-card.json</a><br>
      <a href="/api/opplevelser/discover">/api/opplevelser</a>
    </div>
  </div>
  <div class="footer-bottom">&copy; ${new Date().getFullYear()} Opplevagent</div>
</footer>

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
    <p>Be Claude, ChatGPT eller en annen MCP-kompatibel AI-assistent om å søke i Opplevagents kuraterte, Brreg-verifiserte katalog over norske opplevelser og aktiviteter.</p>
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

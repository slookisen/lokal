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

import { Router, Request, Response, NextFunction } from "express";
import { getExperiencesAgentCard } from "../services/experiences-agent-card";
import { getExperiencesOpenapi } from "../services/experiences-openapi";
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
  listPublishedProviders,
  getPublishedProviderById,
  getPublishedProviderBySlug,
  backfillProviderSlugs,
  searchPublishedExperiences,
  type RelatedExperienceRow,
  type ExperienceCardRow,
} from "../services/experience-store";

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
    catKicker: "Utforsk", catTitle: "Opplevelser etter kategori", catIntro: "Bla i kuraterte kategorier &mdash; eller la en AI-agent filtrere på vær, sesong, pris og gruppestørrelse for deg.", catAria: "Kategorier", catCount: "opplevelser", catSoon: "Kommer snart", catNote: "Eksempelkategorier &mdash; live opplevelser publiseres fortløpende.",
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
    catKicker: "Explore", catTitle: "Experiences by category", catIntro: "Browse curated categories &mdash; or let an AI agent filter by weather, season, price and group size for you.", catAria: "Categories", catCount: "experiences", catSoon: "Coming soon", catNote: "Example categories &mdash; live experiences are published continuously.",
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
              <li><a href="/.well-known/agent-card.json"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8 H16 M8 12 H16 M8 16 H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Agent Card</a></li>
              <li><a href="/mcp"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12 H16 M12 8 V16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> MCP</a></li>
              <li><a href="/openapi.json"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12 H21 M12 3 C15 6 15 18 12 21 C9 18 9 6 12 3" fill="none" stroke="currentColor" stroke-width="2"/></svg> OpenAPI 3.1</a></li>
              <li><a href="/llms.txt"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 3 H14 L19 8 V21 H6 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3 V8 H19" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg> llms.txt</a></li>
              <li><a href="/.well-known/agents.txt"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 20 C3.5 16 6 14 9 14 C12 14 14.5 16 14.5 20 M16 12 L18 14 L22 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> agents.txt</a></li>
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
    </div>
    <div class="footer-col">
      <h4>${S.footAgents}</h4>
      <a href="/llms.txt"><code>llms.txt</code></a>
      <a href="/.well-known/agent-card.json"><code>agent-card.json</code></a>
      <a href="/mcp"><code>/mcp</code> (MCP)</a>
      <a href="/openapi.json"><code>openapi.json</code></a>
      <a href="/api/opplevelser/discover"><code>/api/opplevelser</code></a>
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

function renderOpplevelseDetail(
  exp: ReturnType<typeof getPublishedExperienceBySlug>,
  provider: Record<string, unknown> | null,
  related: RelatedExperienceRow[],
  url: string
): string {
  if (!exp) return "";
  const slug = exp.slug || "";
  const canonical = `${url}/opplevelse/${encodeURIComponent(slug)}`;
  const cat = exp.category || null;
  const place = [exp.kommune, exp.fylke].filter(Boolean).join(", ");
  const provName = provider ? String(provider.navn || "") : "";
  const provSite = provider ? safeHttpUrl(provider.hjemmeside) : null;
  const brregVerified = !!(provider && Number(provider.brreg_verified) === 1);
  const orgNr = provider ? String(provider.org_nr || "") : "";

  // Meta description: own summary if present, else a generated one.
  const metaDescRaw = exp.description
    ? String(exp.description)
    : `${exp.title}${place ? " i " + place : ""}. ${catLabel(cat)} på Opplevagent — kuratert markedsplass for norske opplevelser med Brreg-verifiserte tilbydere.`;
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

  // Description block (graceful fallback when no own summary yet).
  const descBlock = exp.description
    ? `<p class="lede">${escapeHtml(exp.description)}</p>`
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
  const BRAND = " | Opplevagent";
  const MAX_TITLE = 70;
  function seoPageTitle(main: string): string {
    if (main.length + BRAND.length <= MAX_TITLE) return main + BRAND;
    const truncated = main.slice(0, MAX_TITLE - BRAND.length - 1).trimEnd();
    return truncated + "…" + BRAND;
  }
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
    <h1>${escapeHtml(exp.title)}</h1>
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
      <div class="card"><h2>Bestilling</h2>${cta}</div>
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
  .card .c-desc{font-size:.9rem;color:var(--ink-soft);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .card .c-meta{margin-top:auto;display:flex;flex-wrap:wrap;gap:6px;padding-top:4px}
  .tag{display:inline-flex;align-items:center;padding:3px 10px;border-radius:var(--r-pill);background:var(--canvas-2);color:var(--ink-soft);font-size:.74rem;font-weight:600;border:1px solid var(--line)}
  .tag-cat{background:var(--fjord-800);color:#fff;border-color:var(--fjord-800)}
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
function renderCard(row: ExperienceCardRow): string {
  const place = placeOf(row);
  const desc = row.description
    ? `<p class="c-desc">${escapeHtml(row.description)}</p>`
    : "";
  const tags: string[] = [];
  if (row.category) tags.push(`<span class="tag tag-cat">${escapeHtml(catLabel(row.category))}</span>`);
  if (row.indoor_outdoor) tags.push(`<span class="tag">${escapeHtml(ioLabel(row.indoor_outdoor))}</span>`);
  if (row.price_from) tags.push(`<span class="tag">fra ${row.price_from} kr</span>`);
  else if (row.price_band && PRICE_BAND_LABELS[row.price_band]) tags.push(`<span class="tag">${escapeHtml(PRICE_BAND_LABELS[row.price_band] as string)}</span>`);
  return `<a class="card" href="/opplevelse/${encodeURIComponent(row.slug)}">
    <span class="c-title">${escapeHtml(row.title)}</span>
    ${place ? `<span class="c-place">${PIN_SVG}${escapeHtml(place)}</span>` : ""}
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
  rows: ExperienceCardRow[];
  total: number;
  page: number;          // 1-based
  pageSize: number;
  pagerBase?: string;    // path used for ?page= links (defaults to canonicalPath)
  extraTopHtml?: string; // e.g. search box / facet chips, rendered above the grid
  emptyTitle?: string;
  emptyBody?: string;
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
  const ldScripts = [collectionLd, breadcrumbLd]
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
      ? `<div class="grid" role="list">${opts.rows.map(renderCard).join("")}</div>`
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
  const html = renderBrowsePage({
    title: `${label} | Opplevagent`,
    h1: label,
    metaDesc: `${label} i Norge — kuraterte opplevelser på Opplevagent med Brreg-verifiserte tilbydere. ${total} ${total === 1 ? "opplevelse" : "opplevelser"} i kategorien.`,
    lede: `Opplevelser i kategorien ${label.toLowerCase()}.`,
    canonicalPath: `/kategori/${encodeURIComponent(category)}`,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: label }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox(""),
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
    if (total === 0) return next(); // unknown/empty fylke → 404 (no orphan page)
    rows = listPublishedExperiences({ fylke }, BROWSE_PAGE_SIZE, (page - 1) * BROWSE_PAGE_SIZE);
  } catch {
    return next();
  }

  const html = renderBrowsePage({
    title: `Opplevelser i ${fylke} | Opplevagent`,
    h1: `Opplevelser i ${fylke}`,
    metaDesc: `Kuraterte opplevelser og aktiviteter i ${fylke} — verifiserte tilbydere på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede: `Hva kan du finne på i ${fylke}? Kuratert oversikt over opplevelser i fylket.`,
    canonicalPath: `/fylke/${encodeURIComponent(fylke)}`,
    crumbs: [{ name: "Forsiden", href: "/" }, { name: "Alle opplevelser", href: "/opplevelser" }, { name: fylke }],
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox("") + kommuneChips(fylke),
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
    if (total === 0) return next(); // unknown/empty kommune -> 404 (no orphan page)
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

  const html = renderBrowsePage({
    title: `Opplevelser i ${kommune} | Opplevagent`,
    h1: `Opplevelser i ${kommune}`,
    metaDesc: `Kuraterte opplevelser og aktiviteter i ${kommune}${fylke ? ", " + fylke : ""} — verifiserte tilbydere på Opplevagent. ${total} ${total === 1 ? "opplevelse" : "opplevelser"}.`,
    lede: `Hva kan du finne på i ${kommune}? Kuratert oversikt over opplevelser i kommunen.`,
    canonicalPath: `/kommune/${encodeURIComponent(kommune)}`,
    crumbs,
    rows,
    total,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    extraTopHtml: searchBox(""),
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

// ─── GET /sok?q= — HTML search-results page ──────────────────────────────────
// Human-facing twin of the discover query. Reuses the publish gate so every
// result links to a live detail page. Not paginated (capped result set); the
// search box re-renders the current query.
router.get("/sok", (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  let rows: ExperienceCardRow[] = [];
  if (q) {
    try {
      rows = searchPublishedExperiences(q, 60);
    } catch {
      rows = [];
    }
  }

  const h1 = q ? `Søk: «${q}»` : "Søk i opplevelser";
  const metaDesc = q
    ? `Søkeresultater for «${q}» på Opplevagent — kuraterte norske opplevelser med verifiserte tilbydere.`
    : "Søk blant kuraterte norske opplevelser på Opplevagent — etter sted, kategori eller aktivitet.";
  const emptyTitle = q ? `Ingen treff for «${q}»` : "Skriv inn et søk";
  const emptyBody = q
    ? "Prøv et annet søkeord, et stedsnavn eller en kategori. Du kan også bla i alle opplevelser."
    : "Søk etter sted, kategori eller aktivitet — for eksempel «hvalsafari», «Tromsø» eller «mat».";

  // Search pages are not indexed individually (thin/duplicative); the results
  // still link to indexable detail pages.
  const url = baseUrl();
  const canonical = `${url}/sok`;
  const cards =
    rows.length > 0
      ? `<div class="grid" role="list">${rows.map(renderCard).join("")}</div>`
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
    ${q ? `<p class="count">${rows.length} ${rows.length === 1 ? "treff" : "treff"}</p>` : ""}
  </header>
  ${searchBox(q)}
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
  if (!exp) return next(); // → Norwegian 404 catch-all (no rfb/dental leak)

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
  res.send(renderOpplevelseDetail(exp, provider, related, baseUrl()));
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

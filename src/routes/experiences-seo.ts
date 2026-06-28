/**
 * experiences-seo.ts — Host-gated AI-discovery surfaces for Opplevagent (opplevagent.no)
 *
 * orchestrator-pr-19: minimal-landing + A2A surfaces for the experiences vertical.
 * All routes are registered on the Express router exported from this file.
 * The router is mounted at / in the Opplevagent Express app.
 *
 * Canonical host: opplevagent.no (served from rfb's monorepo when OPPLEVAGENT_HOST=true).
 * Phase 2 (2026-06-16): server-rendered HTML browse pages for human SEO reach.
 *   - GET /                    — minimal landing (A2A intro + category cards)
 *   - GET /en                  — English variant
 *   - GET /sitemap.xml         — DB-driven sitemap
 *   - GET /llms.txt            — LLM discovery
 *   - GET /openapi.json        — OpenAPI 3.1 spec
 *   - GET /.well-known/agent-card.json (+ alias)
 *   - GET /opplevelser         — paginated experience index
 *   - GET /kategori/:category  — experiences in a category
 *   - GET /fylke/:fylke        — experiences in a county
 *   - GET /kommune/:kommune    — experiences in a municipality
 *   - GET /tilbyder/:id        — provider detail + their experiences
 *   - GET /opplevelse/:slug    — experience detail page (Phase 2 increment #2)
 *   - GET /sok                 — free-text search results (Phase 2 increment #3)
 *   - GET /personvern          — privacy policy (Phase 2 increment #4)
 *   - GET /vilkar              — terms of use (Phase 2 increment #5)
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
  countGardssalgProviders,
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
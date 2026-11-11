// ─── Profile link clicks on Opplevagent and Finn-tannlege (read + write) ─────
//
// Slice S4 of dev-request 2026-10-23-admin-ordre-og-henvisningsdashbord
// (spec points 6 and 8, AC5/AC6). The same pattern Rett fra Bonden uses for
// its producer pages (routes/contact-tracking.ts: GET /ut/:agentId/:kind and
// POST /api/track/contact-click), for the outgoing links on:
//
//   surface      page                                        platform     entity
//   ───────────  ──────────────────────────────────────────  ───────────  ──────────
//   opplevelse   opplevagent.no /opplevelse/:slug            opplevelser  experience
//   tilbyder     opplevagent.no /tilbyder/:slug              opplevelser  provider
//   gardssalg    opplevagent.no /kategori/gardssalg/         gardssalg    provider
//                produsent/:slug
//   klinikk      finn-tannlege.com /klinikk/:slug            tannlege     clinic
//
//   GET /ut/:surface/:id/:kind  (mounted inside experiences-seo.ts and
//     dental-seo.ts, so it answers on the vertical's own host) — a counting
//     302 for http(s) links (booking, website, directory).
//   POST /api/track/profile-click  (body { surface, id, kind }) — the beacon
//     for tel: / mailto: links (kind phone / email), 204.
//
// ─── Open-redirect guard (read before touching resolveProfileLinkTarget) ───
// :surface and :kind are closed selectors checked against fixed sets before
// any lookup; :id is a bounded [A-Za-z0-9_-] token used only as a bound SQL
// parameter. The redirect target is read ONLY from the vertical's database
// row with that id (experiences.booking_url, experience_providers.hjemmeside,
// dental_agents.online_booking_url / hjemmeside / directory_url) — never from
// a query parameter, header or body. A row the public page would not show
// (unpublished / hidden / merged / rejected / probe) → 404, except a test
// provider (is_test_provider = 1), whose clicks are recorded with is_test = 1
// so an end-to-end test click stays out of the main numbers. A stored value
// that does not parse as an absolute http(s) URL (javascript:, data:, a bare
// domain, empty) → 404; it is never handed to res.redirect().
//
// ─── Privacy ─────────────────────────────────────────────────────────────────
// No new personal data: one row holds the platform, the page entity and its
// provider id, the link kind, the pseudonymised session id (the same id
// analyticsService.getOrCreateSessionId gives page views and contact_clicks:
// the salted IP hash, a coarse device bucket of the UA and a suffix — never
// a raw IP or the full UA string) and is_bot from
// parseUserAgent (the same client classification). The table lives in
// lokal.db next to contact_clicks, so the admin overview reads it without
// opening a vertical database.

import { Router, Request, Response } from "express";
import { getDb as getMainDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { analyticsService, parseUserAgent } from "./analytics-service";
import { addUtmParams, OUTBOUND_UTM } from "../utils/url-utm";

// The experience-store / gardssalg-visibility modules are required lazily:
// index.ts mounts the beacon router on every deployment, also one without
// the experiences vertical.
function publishGateSql(): string {
  return (require("./experience-store") as typeof import("./experience-store")).PUBLISH_GATE_SQL;
}
function gardssalgWebVisibleSql(): string {
  return (require("./gardssalg-visibility") as typeof import("./gardssalg-visibility")).gardssalgVisibleSql("web");
}

// ─── Closed sets ─────────────────────────────────────────────────────────────

export const PROFILE_LINK_SURFACES = ["opplevelse", "tilbyder", "gardssalg", "klinikk"] as const;
export type ProfileLinkSurface = typeof PROFILE_LINK_SURFACES[number];

export const PROFILE_LINK_PLATFORMS = ["opplevelser", "gardssalg", "tannlege"] as const;
export type ProfileLinkPlatform = typeof PROFILE_LINK_PLATFORMS[number];

/** Kinds the GET redirect resolves, per surface (each one a stored http(s) URL). */
export const REDIRECT_KINDS: Record<ProfileLinkSurface, readonly string[]> = {
  opplevelse: ["booking", "website"],
  tilbyder: ["website"],
  gardssalg: ["website"],
  klinikk: ["booking", "website", "directory"],
};

/** Kinds the POST beacon accepts (tel: / mailto: — nothing to redirect to). */
export const BEACON_KINDS = ["phone", "email"] as const;

const SURFACE_INFO: Record<ProfileLinkSurface, { platform: ProfileLinkPlatform; entity: "experience" | "provider" | "clinic" }> = {
  opplevelse: { platform: "opplevelser", entity: "experience" },
  tilbyder: { platform: "opplevelser", entity: "provider" },
  gardssalg: { platform: "gardssalg", entity: "provider" },
  klinikk: { platform: "tannlege", entity: "clinic" },
};

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isProfileLinkSurface(s: string): s is ProfileLinkSurface {
  return (PROFILE_LINK_SURFACES as readonly string[]).includes(s);
}

/** The counting redirect href for a profile link (relative, on the page's own host). */
export function profileLinkHref(surface: ProfileLinkSurface, id: string, kind: string): string {
  return `/ut/${surface}/${encodeURIComponent(id)}/${kind}`;
}

/** data-* attributes that make a tel:/mailto: link fire the beacon (see profileClickBeaconScript). */
export function profileLinkBeaconAttrs(surface: ProfileLinkSurface, id: string, kind: "phone" | "email"): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return ` data-track-surface="${surface}" data-track-id="${esc(id)}" data-track-kind="${kind}"`;
}

/**
 * One inline script per profile page: a delegated click listener that posts
 * the beacon for links carrying data-track-surface. Never calls
 * preventDefault — the tel:/mailto: navigation proceeds the same whether the
 * beacon works, fails or never runs (no JavaScript). Same mechanism as the
 * RFB profile page (seo.ts), no inline on*= handler (CSP script-src-attr).
 */
export function profileClickBeaconScript(): string {
  return `<script>(function(){if(window.__profileClickBeacon)return;window.__profileClickBeacon=1;` +
    `document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[data-track-surface][data-track-id][data-track-kind]"):null;if(!a)return;` +
    `try{var p=JSON.stringify({surface:a.getAttribute("data-track-surface"),id:a.getAttribute("data-track-id"),kind:a.getAttribute("data-track-kind")});` +
    `if(navigator.sendBeacon){navigator.sendBeacon("/api/track/profile-click",new Blob([p],{type:"application/json"}));}` +
    `else{fetch("/api/track/profile-click",{method:"POST",headers:{"Content-Type":"application/json"},body:p,keepalive:true}).catch(function(){});}` +
    `}catch(_){}});})();</script>`;
}

// ─── Entity resolution (DB only) ─────────────────────────────────────────────

export interface ProfileLinkEntity {
  surface: ProfileLinkSurface;
  platform: ProfileLinkPlatform;
  entity: "experience" | "provider" | "clinic";
  entityId: string;
  providerId: string | null;
  isTest: boolean;
  /** Stored URL per redirect kind (unvalidated; resolveProfileLinkTarget validates). */
  urls: Record<string, string | null>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function resolveExperience(id: string): ProfileLinkEntity | null {
  const db = getVerticalDb("experiences");
  const PUBLISH_GATE_SQL = publishGateSql();
  const row = db.prepare(
    `SELECT e.id AS id, e.booking_url AS booking_url, e.provider_id AS provider_id, p.hjemmeside AS hjemmeside,
            COALESCE(p.is_test_provider, 0) AS is_test,
            CASE WHEN ${PUBLISH_GATE_SQL} THEN 1 ELSE 0 END AS published,
            CASE WHEN e.canonical_id IS NULL THEN 0 ELSE 1 END AS merged
       FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id
      WHERE e.id = ?`
  ).get(id) as { id: string; booking_url: unknown; provider_id: string | null; hjemmeside: unknown; is_test: number; published: number; merged: number } | undefined;
  if (!row) return null;
  const isTest = Number(row.is_test) === 1;
  if (Number(row.published) !== 1 && !(isTest && Number(row.merged) === 0)) return null;
  return {
    surface: "opplevelse", platform: "opplevelser", entity: "experience", entityId: row.id,
    providerId: row.provider_id ?? null, isTest,
    urls: { booking: str(row.booking_url), website: str(row.hjemmeside) },
  };
}

function resolveTilbyder(id: string): ProfileLinkEntity | null {
  const db = getVerticalDb("experiences");
  // Same rule as getPublishedProviderById (the /tilbyder/ page): at least one
  // published experience — or a test provider.
  const PUBLISH_GATE_SQL = publishGateSql();
  const row = db.prepare(
    `SELECT p.id AS id, p.hjemmeside AS hjemmeside, COALESCE(p.is_test_provider, 0) AS is_test,
            EXISTS (SELECT 1 FROM experiences e WHERE e.provider_id = p.id AND e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}) AS published
       FROM experience_providers p WHERE p.id = ?`
  ).get(id) as { id: string; hjemmeside: unknown; is_test: number; published: number } | undefined;
  if (!row) return null;
  const isTest = Number(row.is_test) === 1;
  if (Number(row.published) !== 1 && !isTest) return null;
  return {
    surface: "tilbyder", platform: "opplevelser", entity: "provider", entityId: row.id,
    providerId: row.id, isTest, urls: { website: str(row.hjemmeside) },
  };
}

function resolveGardssalg(id: string): ProfileLinkEntity | null {
  const db = getVerticalDb("experiences");
  // Same visibility as getGardssalgProviderBySlug (the produsent page) — or a test provider.
  const row = db.prepare(
    `SELECT id, hjemmeside, COALESCE(is_test_provider, 0) AS is_test,
            CASE WHEN ${gardssalgWebVisibleSql()} THEN 1 ELSE 0 END AS visible
       FROM experience_providers WHERE id = ?`
  ).get(id) as { id: string; hjemmeside: unknown; is_test: number; visible: number } | undefined;
  if (!row) return null;
  const isTest = Number(row.is_test) === 1;
  if (Number(row.visible) !== 1 && !isTest) return null;
  return {
    surface: "gardssalg", platform: "gardssalg", entity: "provider", entityId: row.id,
    providerId: row.id, isTest, urls: { website: str(row.hjemmeside) },
  };
}

function resolveKlinikk(id: string): ProfileLinkEntity | null {
  // Lazy: the dental modules load only where the dental vertical is used.
  const store = require("./dental-store") as typeof import("./dental-store");
  const places = require("./dental-places-display") as typeof import("./dental-places-display");
  const importDisplay = require("./dental-import-display") as typeof import("./dental-import-display");
  const contamination = require("./dental-contamination") as typeof import("./dental-contamination");
  const stored = store.getDentalAgentById(id);
  if (!stored) return null;
  // Same rule as renderClinicProfile: a rejected clinic, the synthetic probe
  // row and a hidden import-only row 404 there, so here too. The values are
  // the ones the page shows (Places display rule applied).
  const agent = places.shownDentalAgent(stored);
  if (agent.verification_status === "rejected" || contamination.isDentalSyntheticProbeId(agent.id) || importDisplay.isHiddenImportRow(stored)) return null;
  const a = agent as unknown as Record<string, unknown>;
  return {
    surface: "klinikk", platform: "tannlege", entity: "clinic", entityId: String(agent.id),
    providerId: String(agent.id), isTest: false,
    urls: { booking: str(a.online_booking_url), website: str(a.hjemmeside), directory: str(a.directory_url) },
  };
}

/** The public entity behind (surface, id), read from the vertical DB, or null (→ 404). */
export function resolveProfileLinkEntity(surface: ProfileLinkSurface, id: string): ProfileLinkEntity | null {
  if (!ID_RE.test(id)) return null;
  // A vertical that is not switched on has no public pages: never open (and
  // so create) its database file from here.
  if (surface === "klinikk" ? process.env.ENABLE_DENTAL !== "1" : process.env.ENABLE_EXPERIENCES !== "1") return null;
  if (surface === "opplevelse") return resolveExperience(id);
  if (surface === "tilbyder") return resolveTilbyder(id);
  if (surface === "gardssalg") return resolveGardssalg(id);
  return resolveKlinikk(id);
}

/** Absolute http(s) URL or null. */
function httpUrlOrNull(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return candidate;
}

/**
 * The redirect target for (entity, kind), STRICTLY from the stored row. The
 * website kind gets the same UTM tags the page used to put on the direct
 * link (OUTBOUND_UTM per surface); booking and directory links never had UTM
 * and still do not.
 */
export function resolveProfileLinkTarget(entity: ProfileLinkEntity, kind: string): string | null {
  if (!REDIRECT_KINDS[entity.surface].includes(kind)) return null;
  const url = httpUrlOrNull(entity.urls[kind] ?? null);
  if (!url) return null;
  if (kind !== "website") return url;
  const utm = entity.surface === "klinikk" ? OUTBOUND_UTM.dental.clinic_profile
    : entity.surface === "gardssalg" ? OUTBOUND_UTM.opplevagent.gardssalg_profile
    : OUTBOUND_UTM.opplevagent.provider_profile;
  return addUtmParams(url, utm.source, "referral", utm.campaign);
}

// ─── Write ───────────────────────────────────────────────────────────────────

/** Record one profile_link_clicks row. Never throws (tracking is best-effort). */
export function recordProfileLinkClick(req: Request, res: Response, entity: ProfileLinkEntity, kind: string): void {
  try {
    const ua = analyticsService.getUserAgent(req);
    const sessionId = analyticsService.getOrCreateSessionId(req, res);
    const isBot = parseUserAgent(ua).isBot ? 1 : 0;
    getMainDb().prepare(
      `INSERT INTO profile_link_clicks (platform, entity_type, entity_id, provider_id, kind, session_id, is_bot, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(entity.platform, entity.entity, entity.entityId, entity.providerId, kind, sessionId, isBot, entity.isTest ? 1 : 0);
  } catch (err) {
    console.error("[profile-link-clicks] failed to record click:", err);
  }
}

// ─── GET /ut/:surface/:id/:kind ──────────────────────────────────────────────

/**
 * Express handler for the counting redirect, limited to the surfaces of one
 * host (experiences-seo: opplevelse/tilbyder/gardssalg; dental-seo: klinikk).
 * A surface of the other host → 404, so a finn-tannlege.com URL never
 * redirects to an Opplevagent provider and the other way round.
 */
export function profileLinkRedirectHandler(allowed: readonly ProfileLinkSurface[]) {
  return (req: Request, res: Response): void => {
    try {
      const surface = String(req.params.surface || "");
      const id = String(req.params.id || "");
      const kind = String(req.params.kind || "");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.setHeader("Cache-Control", "no-store");
      if (!isProfileLinkSurface(surface) || !allowed.includes(surface) || !ID_RE.test(id) || !REDIRECT_KINDS[surface].includes(kind)) {
        res.status(404).json({ success: false, error: "not_found" });
        return;
      }
      const entity = resolveProfileLinkEntity(surface, id);
      const target = entity ? resolveProfileLinkTarget(entity, kind) : null;
      if (!entity || !target) {
        res.status(404).json({ success: false, error: "not_found" });
        return;
      }
      recordProfileLinkClick(req, res, entity, kind);
      res.redirect(302, target);
    } catch (err) {
      console.error("[profile-link-clicks] /ut redirect error:", err);
      res.status(404).json({ success: false, error: "not_found" });
    }
  };
}

// ─── POST /api/track/profile-click ───────────────────────────────────────────

export const profileClickTrackRouter = Router();

profileClickTrackRouter.post("/profile-click", (req: Request, res: Response): void => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const surface = typeof body.surface === "string" ? body.surface.trim() : "";
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    if (!isProfileLinkSurface(surface) || !ID_RE.test(id) || !(BEACON_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ success: false, error: "invalid_request" });
      return;
    }
    const entity = resolveProfileLinkEntity(surface, id);
    if (!entity) {
      res.status(404).json({ success: false, error: "not_found" });
      return;
    }
    recordProfileLinkClick(req, res, entity, kind);
    res.status(204).end();
  } catch (err) {
    console.error("[profile-link-clicks] profile-click error:", err);
    // Beacon endpoint — never surface a 500 to a fire-and-forget call.
    res.status(204).end();
  }
});

export { SURFACE_INFO as PROFILE_LINK_SURFACE_INFO };

import express, { Router, Request, Response } from "express";
import crypto from "crypto";
import { getDb as getRfbDb } from "../database/init";
import { generalLimiter } from "../middleware/security";
import {
  isCrossSiteWrite, writeGuardRefusedBody, WRITE_GUARD_REFUSED_TITLE, WRITE_GUARD_CONTACT_OPPLEVAGENT,
} from "../middleware/same-origin-write";
import { SlidingWindowCap } from "../services/a2a-traffic-classifier";
import {
  getClaimProviderBySlug,
  getClaimProviderById,
  isGardssalgProviderClaimed,
  CLAIM_MANUAL_FALLBACK_EMAIL,
  type ClaimProviderRow,
} from "../services/gardssalg-claim";
import { getDb as getVerticalDb } from "../database/db-factory";
import { getGardssalgOwnerStats } from "../services/gardssalg-owner-stats-service";
import { previsitReminderHours, previsitExpireHours, BookingInputSchema } from "../services/booking-store";
import { isSubjectAllowedForOwnerFeatures } from "../owner-features/allowlist";
import { oaOwnerFeaturesEnabled } from "../owner-features/gardssalg";
import {
  GARDSSALG_OWNER_FEATURE_GROUPS,
  GARDSSALG_OWNER_FEATURE_REGISTRY,
  findOwnerFeature,
  type OwnerFeatureEntry,
} from "../owner-features/registry";
import {
  resolveOwnerFeatures,
  setOwnerFeatureValue,
  type OwnerFeatureSubject,
  type ResolvedOwnerFeature,
} from "../owner-features/resolve";
import {
  GARDSSALG_OWNER_LEVELS,
  applyOwnerLevel,
  applyOwnerSingleChange,
  currentOwnerLevel,
  findOwnerLevel,
  getOwnerChangeBatch,
  latestUndoableBatch,
  ownerFeatureChangeLog,
  previewOwnerLevel,
  undoOwnerChange,
} from "../owner-features/changes";
import {
  formatOwnerFeatureValue,
  renderOwnerFeaturesPageBody,
  type OwnerPageBooking,
  type OwnerPageGardssalgStats,
  type OwnerPageNotice,
  type OwnerPageVariant,
} from "../owner-features/page";
import { readOwnerFeatureInterest, recordOwnerFeatureInterest } from "../owner-features/interest";
import {
  OWNER_ANCHOR_FALLBACK, OWNER_ANCHOR_LEVEL, OWNER_ANCHOR_LEVEL_PREVIEW, OWNER_ANCHOR_PLANNED,
  isOwnerPageAnchor, ownerBatchAnchor, ownerPageTail, ownerPlannedAnchor, ownerRowAnchor, ownerUndoAnchor,
} from "../owner-features/anchors";

// ─────────────────────────────────────────────────────────────────
// «Mine valg» for gårdssalg owners — dev-request 2026-10-22-opplevagent-
// mine-valg-gardssalg, «v2 for Opplevagent», slice O1a
// ─────────────────────────────────────────────────────────────────
// A tab of the gårdssalg owner portal, rendered by the SAME page component
// as RFB «Mine valg» (owner-features/page.ts) over the gårdssalg registry
// entries (GARDSSALG_OWNER_FEATURE_REGISTRY), with the same resolver, change
// log, levels, undo and «Gi meg beskjed» (stored per subject+key, no effect).
//
//   GET  /kategori/gardssalg/eier/:providerSlug/valg              the page
//   POST /kategori/gardssalg/eier/:providerSlug/valg/sett         one entry
//   POST /kategori/gardssalg/eier/:providerSlug/valg/niva         a level
//   POST /kategori/gardssalg/eier/:providerSlug/valg/angre        undo
//   POST /kategori/gardssalg/eier/:providerSlug/valg/interesse    «Gi meg beskjed»
//   GET  /api/opplevelser/gardssalg-claim/:providerId/features        JSON
//   PUT  /api/opplevelser/gardssalg-claim/:providerId/features/:key   JSON
//
// Order of checks on every call (nothing is read or written before they pass):
//   1. OA_OWNER_FEATURES_ENABLED off → 404 (flag off = today's behaviour);
//   2. the producer row (the portal's own slug/id lookup) → 404;
//   3. the allowlist OWNER_FEATURES_ALLOWED_SUBJECTS (`gardssalg:<id>`) and,
//      until Daniel's pilot GO, experience_providers.is_test_provider = 1 → 404;
//   4. the portal's owner session (oa_owner_session cookie or Bearer, the
//      SAME sessionFromRequest) → 401;
//   5. the session belongs to this producer → 403;
//   6. a live verified claim for the row (isGardssalgProviderClaimed) → 403;
//   POSTs/PUT also: Origin check (403) and a per-session write limit (429;
//   the page POSTs: 303 «For mange endringer», T5).
// T5 (anchor contract, owner-features/anchors.ts, same as RFB): every page
// POST outcome after the checks answers 303 with the anchor of the card or
// row the form sits in; a message carries `ved=<id>` so it stands there.
// The paths sit under the claim prefixes, so the opplevagent.no host gate
// (gardssalgClaimHostGate) applies to them as to the rest of the portal.

const VERTICAL = "gardssalg" as const;
const PORTAL_PATH = (slug: string) => `/kategori/gardssalg/eier/${encodeURIComponent(slug)}/portal`;
const PAGE_PATH = (slug: string, tail = "") => `/kategori/gardssalg/eier/${encodeURIComponent(slug)}/valg${tail}`;

/** Per-session write limit: 30 writes per minute per session token (as RFB). */
export const GARDSSALG_OWNER_FEATURES_WRITES_PER_MINUTE = 30;
const writeCap = new SlidingWindowCap(GARDSSALG_OWNER_FEATURES_WRITES_PER_MINUTE, 60 * 1000);

export function __resetGardssalgOwnerFeaturesRateLimitForTesting(): void {
  writeCap.reset();
}

/** «Ta imot besøk» «Les mer» (/for-tilbydere#besok) — null until that page is published (O4). */
export const GARDSSALG_BOOKING_READ_MORE_URL: string | null = null;

/** «Slik er du nå» for gårdssalg (only built entries show). */
export const GARDSSALG_OWNER_PAGE_STATUS_KEYS = ["visibility.profile", "booking.enabled", "booking.pause"];

export interface GardssalgOwnerFeaturesDeps {
  /** The portal's page shell (gardssalg-claim.ts). */
  shell: (title: string, body: string) => string;
  /** The portal's session reader (gardssalg-claim.ts sessionFromRequest). */
  sessionFromRequest: (req: Request) => { valid: boolean; providerId?: string; token?: string };
}

/** Is this producer row the test producer? (is_test_provider = 1) */
function isTestProvider(providerId: string): boolean {
  try {
    const row = getVerticalDb("experiences")
      .prepare(`SELECT is_test_provider FROM experience_providers WHERE id = ?`)
      .get(providerId) as { is_test_provider: number | null } | undefined;
    return Number(row?.is_test_provider) === 1;
  } catch {
    return false;
  }
}

/** The tab is open for this producer: flag on, allowlisted, the test producer (O1a). */
export function gardssalgOwnerFeaturesTabOpen(providerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return oaOwnerFeaturesEnabled(env) && isSubjectAllowedForOwnerFeatures(VERTICAL, providerId, env) && isTestProvider(providerId);
}

function sessionEmail(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const row = getVerticalDb("experiences").prepare(`SELECT email FROM gardssalg_claims WHERE token = ?`).get(token) as { email?: string } | undefined;
    return row?.email ?? null;
  } catch {
    return null;
  }
}

/** Form text → the typed value setOwnerFeatureValue validates (as RFB). */
function formValue(e: OwnerFeatureEntry, raw: unknown): unknown {
  const s = typeof raw === "string" ? raw : "";
  switch (e.type) {
    case "switch":
      return s === "true" ? true : s === "false" ? false : s;
    case "number": {
      if (s.trim() === "") return e.nullable ? null : s;
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    case "email":
    case "date":
      return s.trim() === "" && e.nullable ? null : s;
    default:
      return s;
  }
}

function canAttempt(r: ResolvedOwnerFeature | undefined): boolean {
  return !!r && (r.changeable || r.block === "requirement_not_met");
}

const PAGE_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  ingen_endring: { ok: true, text: "Ingen endring — valget var allerede slik." },
  angret: { ok: true, text: "Endringen er angret." },
  angre_umulig: { ok: false, text: "Denne endringen kan ikke angres lenger." },
  angre_endret: { ok: false, text: "Endringen kan ikke angres fordi valget er endret siden." },
  ugyldig: { ok: false, text: "Verdien er ikke gyldig." },
  feil: { ok: false, text: "Klarte ikke å lagre. Prøv igjen." },
  for_mange: { ok: false, text: "For mange endringer. Prøv igjen om litt." },
  niva_valgt: { ok: true, text: "Nivået er valgt. Valgene dine var allerede slik, så ingenting annet er endret." },
  interesse: { ok: true, text: "Takk! Vi har notert at du vil ha dette. Ingenting er endret, og vi sender ingen e-post nå." },
  interesse_finnes: { ok: true, text: "Du har allerede sagt fra om dette." },
};

function featureJson(e: OwnerFeatureEntry, r: ResolvedOwnerFeature, subject: OwnerFeatureSubject) {
  return {
    key: e.key,
    group: e.group,
    type: e.type,
    ...(e.options ? { options: e.options } : {}),
    ...(e.min !== undefined ? { min: e.min } : {}),
    ...(e.max !== undefined ? { max: e.max } : {}),
    ...(e.nullable ? { nullable: true } : {}),
    label: e.label,
    description: e.description,
    status: e.status,
    advanced: e.advanced,
    consent: e.consent,
    outward: e.outward,
    confirm_on: e.confirmOn ?? null,
    confirm_off: e.confirmOff ?? null,
    requires: e.requires,
    since: e.since,
    surfaces: e.surfaces,
    // A planned entry carries no value (v2 principle 6: no false values).
    value: e.status === "coming_soon" ? null : r.value,
    default: subject.segment === "owner" ? e.default.owner : e.default.unclaimed,
    source: r.source,
    changeable: r.changeable,
    reason: r.reason,
  };
}

/** Where the owner asks for a booking address to be added or corrected (no self-service field yet). */
function bookingAddressFixHref(provider: ClaimProviderRow): string {
  const subject = encodeURIComponent(`Adresse for besøksforespørsler: ${provider.navn} (${provider.id})`);
  return `mailto:${CLAIM_MANUAL_FALLBACK_EMAIL}?subject=${subject}`;
}

/** The largest group BookingInputSchema accepts (party_size max). */
function maxPartySize(): number {
  try {
    const v = (BookingInputSchema.shape.party_size as any).maxValue;
    return typeof v === "number" && Number.isFinite(v) ? v : 50;
  } catch {
    return 50;
  }
}

/** One concrete tip from what the gårdssalg profile is missing. */
export function gardssalgProfileTip(p: Pick<ClaimProviderRow, "opening_hours_text" | "products" | "about_text" | "visit_text" | "hjemmeside">): string {
  const blank = (v: unknown) => v == null || String(v).trim() === "" || String(v).trim() === "[]";
  if (blank(p.opening_hours_text)) return "Legg til åpningstider, så vet gjestene når de kan komme.";
  if (blank(p.products)) return "Legg inn produktene dine, så har gjester og AI-assistenter noe konkret å finne.";
  if (blank(p.about_text)) return "Skriv noen setninger om stedet og det dere lager.";
  if (blank(p.visit_text)) return "Fortell hva gjestene kan oppleve når de kommer på besøk.";
  if (blank(p.hjemmeside)) return "Legg til nettsiden din, så kan gjestene lese mer om dere.";
  return "Del lenken til profilen din i egne kanaler, for eksempel Facebook eller nyhetsbrevet ditt.";
}

/**
 * O1 principle 1: the portal's own Statistikk numbers — getGardssalgOwnerStats
 * with the same path as GET /api/opplevelser/gardssalg-claim/:id/stats (no new
 * counting). null = the read failed.
 */
export function gardssalgOwnerPageStats(provider: ClaimProviderRow): OwnerPageGardssalgStats | null {
  try {
    const s = getGardssalgOwnerStats(`/kategori/gardssalg/produsent/${provider.slug || ""}`, provider.id);
    return {
      humanViews: s.humanViews,
      aiSearchViews: s.aiSearchViews,
      windowDays: s.windowDays,
      aiDeliveries: s.aiDeliveries ? { value: s.aiDeliveries.window.total, label: s.aiDeliveries.windowLabel } : null,
      tip: gardssalgProfileTip(provider),
    };
  } catch (e) {
    console.error("[gardssalg-owner-features] statistics block read failed:", e);
    return null;
  }
}

export function createGardssalgOwnerFeaturesRouter(deps: GardssalgOwnerFeaturesDeps): Router {
  const router = Router();
  const { shell } = deps;

  const simplePage = (status: number, title: string, html: string) =>
    (res: Response) => res.status(status).send(shell(title, `<div class="gc-card">${html}</div>`));
  const notFoundPage = simplePage(404, "Fant ikke siden", `<h1>Fant ikke siden</h1>`);

  type PageGate =
    | { ok: true; provider: ClaimProviderRow; slug: string; token: string }
    | { ok: false; send: (res: Response) => Response };

  function pageGate(req: Request): PageGate {
    if (!oaOwnerFeaturesEnabled()) return { ok: false, send: notFoundPage };
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    if (!provider || !gardssalgOwnerFeaturesTabOpen(provider.id)) return { ok: false, send: notFoundPage };
    const session = deps.sessionFromRequest(req);
    if (!session.valid || !session.token) {
      return {
        ok: false,
        send: simplePage(401, "Logg inn", `<h1>Logg inn</h1><p>Din sesjon er utløpt. <a href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}">Logg inn på nytt</a>.</p>`),
      };
    }
    if (session.providerId !== provider.id || !isGardssalgProviderClaimed(provider.id)) {
      return { ok: false, send: simplePage(403, "Ingen tilgang", `<h1>Ingen tilgang</h1><p>Du har ikke tilgang til denne produsenten.</p>`) };
    }
    return { ok: true, provider, slug, token: session.token };
  }

  /** T5: 303 back to the page — `query` with the message placed at `anchor`, and `#anchor`. */
  const backTo = (res: Response, slug: string, query: string, anchor: string, opts: { place?: boolean } = {}): Response => {
    res.redirect(303, PAGE_PATH(slug, ownerPageTail(query, anchor, opts)));
    return res;
  };

  function writeGuard(req: Request, token: string, anchor: string | (() => string)): ((res: Response) => Response) | null {
    if (isCrossSiteWrite(req)) {
      const slug = String((req.params as any).providerSlug || "");
      return simplePage(403, WRITE_GUARD_REFUSED_TITLE, writeGuardRefusedBody({
        contact: WRITE_GUARD_CONTACT_OPPLEVAGENT, backHref: PAGE_PATH(slug), backLabel: "Tilbake til Mine valg",
      }));
    }
    const capKey = crypto.createHash("sha256").update(token).digest("hex");
    if (writeCap.isOver(capKey)) {
      const slug = String((req.params as any).providerSlug || "");
      const at = typeof anchor === "function" ? anchor() : anchor;
      return (res: Response) => backTo(res, slug, "melding=for_mange", at);
    }
    writeCap.record(capKey);
    return null;
  }

  const fail = (where: string) => (res: Response, e: unknown) => {
    console.error(`[gardssalg-owner-features] ${where} failed:`, e);
    return simplePage(500, "Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`)(res);
  };
  /** T5: a page POST that failed → 303 «Klarte ikke å lagre» at its anchor. */
  const failBack = (where: string) => (req: Request, res: Response, e: unknown, anchor: string) => {
    console.error(`[gardssalg-owner-features] ${where} failed:`, e);
    return backTo(res, String((req.params as any).providerSlug || ""), "melding=feil", anchor);
  };

  function batchNotice(providerId: string, batchId: number): OwnerPageNotice | null {
    const batch = getOwnerChangeBatch(VERTICAL, providerId, batchId);
    if (!batch) return null;
    const rows = getRfbDb()
      .prepare(`SELECT key, new_json FROM owner_feature_audit WHERE vertical = ? AND subject_id = ? AND id BETWEEN ? AND ? ORDER BY id`)
      .all(VERTICAL, providerId, batch.first_audit_id, batch.last_audit_id) as Array<{ key: string; new_json: string | null }>;
    const parts = rows.map((r) => {
      const e = findOwnerFeature(r.key, GARDSSALG_OWNER_FEATURE_REGISTRY);
      let v: any = null;
      try { v = r.new_json == null ? null : JSON.parse(r.new_json); } catch { v = null; }
      return `«${e ? e.label.no : r.key}» er ${formatOwnerFeatureValue(e, v)}`;
    });
    let text: string;
    if (batch.kind === "level") {
      const l = findOwnerLevel(batch.level, GARDSSALG_OWNER_LEVELS);
      text = `Du har valgt «${l ? l.label.no : "nivå"}». Lagret: ${parts.join(", ")}.`;
    } else if (batch.kind === "undo") {
      text = `Angret. ${parts.join(", ")}.`;
    } else {
      text = `Lagret: ${parts.join(", ")}.`;
    }
    const undoable = latestUndoableBatch(VERTICAL, providerId);
    return { ok: true, text, undoBatchId: undoable && undoable.id === batch.id ? batch.id : null };
  }

  function variantFor(slug: string): OwnerPageVariant {
    return {
      vertical: VERTICAL,
      platformName: "Opplevagent",
      csEmail: CLAIM_MANUAL_FALLBACK_EMAIL,
      pagePath: (tail) => PAGE_PATH(slug, tail),
      backHref: PORTAL_PATH(slug),
      groups: GARDSSALG_OWNER_FEATURE_GROUPS,
      levels: GARDSSALG_OWNER_LEVELS,
      statusKeys: GARDSSALG_OWNER_PAGE_STATUS_KEYS,
      revealKey: "booking.enabled",
      pauseResumeDate: false,
    };
  }

  // ── The page ──────────────────────────────────────────────────────────
  router.get(
    "/kategori/gardssalg/eier/:providerSlug/valg",
    generalLimiter,
    (req: Request, res: Response) => {
    try {
      const g = pageGate(req);
      if (!g.ok) return g.send(res);
      const { provider, slug } = g;
      const registry = GARDSSALG_OWNER_FEATURE_REGISTRY;
      const resolved = resolveOwnerFeatures(VERTICAL, provider.id, { registry });
      const q = req.query as Record<string, unknown>;
      const qs = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
      const own = <T>(o: Record<string, T>, k: string): T | undefined =>
        (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
      const resolvedKey = (k: string) => own(resolved.byKey, k);

      let notice: OwnerPageNotice | null = null;
      // T5: the card or row the message stands in (`ved=`, or the saved batch's own row/card).
      let noticeAt: string | null = isOwnerPageAnchor(qs("ved")) ? qs("ved") : null;
      const changedId = Number.parseInt(qs("endret"), 10);
      if (Number.isFinite(changedId) && changedId > 0) {
        notice = batchNotice(provider.id, changedId);
        if (notice && !noticeAt) noticeAt = ownerBatchAnchor(VERTICAL, provider.id, changedId, getRfbDb());
      }
      const msg = own(PAGE_MESSAGES, qs("melding"));
      if (!notice && msg) notice = { ok: msg.ok, text: msg.text };
      if (!notice && qs("melding") === "sperret") {
        const r = resolvedKey(qs("nokkel"));
        notice = { ok: false, text: r?.reason ? `Kan ikke endres: ${r.reason.no}` : "Dette valget kan ikke endres nå." };
      }
      if (!notice && qs("melding") === "hoppet") {
        const reasons = qs("nokkel").split(",").map((k) => resolvedKey(k)).filter((r) => r && r.reason)
          .map((r) => `«${findOwnerFeature(r!.key, registry)?.label.no ?? r!.key}»: ${r!.reason!.no}`);
        notice = { ok: false, text: reasons.length ? `Ingenting ble endret. ${reasons.join(" ")}` : "Ingenting ble endret." };
      }
      // A refused switch-on (409 reason from the enable gate) is not on the resolved row.
      if (!notice && qs("melding") === "krav") {
        const e = findOwnerFeature(qs("nokkel"), registry);
        notice = { ok: false, text: e ? `«${e.label.no}» ble ikke slått på. Se kravet ved valget.` : "Valget ble ikke slått på." };
      }

      let confirm: { key: string; value: boolean } | null = null;
      const ck = qs("bekreft");
      if (ck && canAttempt(resolvedKey(ck))) confirm = { key: ck, value: qs("verdi") === "1" };
      const levelPreview = findOwnerLevel(qs("niva"), GARDSSALG_OWNER_LEVELS)
        ? previewOwnerLevel(VERTICAL, provider.id, qs("niva"), { registry })
        : null;
      const page = Number.parseInt(qs("side"), 10);
      const log = ownerFeatureChangeLog(VERTICAL, provider.id, Number.isFinite(page) ? page : 1);

      const epost = typeof provider.epost === "string" && provider.epost.trim() !== "" ? provider.epost.trim() : null;
      const booking: OwnerPageBooking = {
        requestEmail: epost,
        adminBrake: provider.booking_admin_brake_at
          ? { note: provider.booking_admin_brake_note && provider.booking_admin_brake_note.trim() ? provider.booking_admin_brake_note.trim() : null }
          : null,
        fixHref: bookingAddressFixHref(provider),
        reminderHours: previsitReminderHours(),
        expireHours: previsitExpireHours(),
        maxPartySize: maxPartySize(),
        readMoreUrl: GARDSSALG_BOOKING_READ_MORE_URL,
      };

      const body = renderOwnerFeaturesPageBody({
        agent: { id: provider.id, name: String(provider.navn || "") },
        resolved,
        registry,
        variant: variantFor(slug),
        level: currentOwnerLevel(VERTICAL, provider.id, resolved, { registry }),
        showIntro: false,
        notice,
        noticeAt,
        confirm,
        levelPreview,
        log,
        interest: readOwnerFeatureInterest(VERTICAL, provider.id),
        booking,
        gardssalgStats: gardssalgOwnerPageStats(provider),
        statsHref: PORTAL_PATH(slug),
      });
      res.setHeader("Cache-Control", "no-store");
      return res.send(shell(`Mine valg · ${provider.navn}`, `${body}<style>${GARDSSALG_PAGE_CSS}</style>`));
    } catch (e) {
      return fail("GET valg")(res, e);
    }
  });

  router.post(
    "/kategori/gardssalg/eier/:providerSlug/valg/sett",
    generalLimiter,
    express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    let anchor = OWNER_ANCHOR_FALLBACK;
    try {
      const g = pageGate(req);
      if (!g.ok) return g.send(res);
      const { provider, slug } = g;
      const registry = GARDSSALG_OWNER_FEATURE_REGISTRY;
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const key = typeof body.key === "string" ? body.key : "";
      const e = findOwnerFeature(key, registry);
      if (e) anchor = ownerRowAnchor(e.key);
      const guard = writeGuard(req, g.token, anchor);
      if (guard) return guard(res);
      if (!e) return backTo(res, slug, "melding=ugyldig", anchor);
      const value = formValue(e, body.value);
      if (body.confirmed !== "1" && typeof value === "boolean" && (value ? e.confirmOn : e.confirmOff)
          && canAttempt(resolveOwnerFeatures(VERTICAL, provider.id, { registry }).byKey[key])) {
        return backTo(res, slug, `bekreft=${encodeURIComponent(key)}&verdi=${value ? "1" : "0"}`, anchor, { place: false });
      }
      const out = applyOwnerSingleChange(VERTICAL, provider.id, key, value, { actor: "owner", detail: sessionEmail(g.token) }, { registry });
      const r = out.result;
      if (r.kind === "ok") {
        if (!r.changed) return backTo(res, slug, "melding=ingen_endring", anchor);
        console.log(`[gardssalg-owner-features] owner set ${key} for provider ${provider.id} (page)`);
        return backTo(res, slug, `endret=${out.batchId}`, anchor, { place: false });
      }
      if (r.kind === "blocked") {
        // A requirement checked only on switch-on (the enable gate) is not on
        // the resolved row; send the owner to the row's own check.
        const resolvedRow = resolveOwnerFeatures(VERTICAL, provider.id, { registry }).byKey[key];
        const melding = r.block === "requirement_not_met" && !resolvedRow?.reason ? "krav" : "sperret";
        return backTo(res, slug, `melding=${melding}&nokkel=${encodeURIComponent(key)}`, anchor);
      }
      if (r.kind === "invalid_value") return backTo(res, slug, "melding=ugyldig", anchor);
      return backTo(res, slug, "melding=feil", anchor);
    } catch (e) {
      return failBack("POST valg/sett")(req, res, e, anchor);
    }
  });

  router.post(
    "/kategori/gardssalg/eier/:providerSlug/valg/niva",
    generalLimiter,
    express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const anchor = OWNER_ANCHOR_LEVEL;
    try {
      const g = pageGate(req);
      if (!g.ok) return g.send(res);
      const guard = writeGuard(req, g.token, anchor);
      if (guard) return guard(res);
      const { provider, slug } = g;
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const level = findOwnerLevel(body.level, GARDSSALG_OWNER_LEVELS);
      if (!level) return backTo(res, slug, "melding=ugyldig", anchor);
      if (body.confirmed !== "1") return backTo(res, slug, `niva=${encodeURIComponent(level.key)}`, OWNER_ANCHOR_LEVEL_PREVIEW, { place: false });
      const out = applyOwnerLevel(VERTICAL, provider.id, level.key, { actor: "owner", detail: sessionEmail(g.token) }, { registry: GARDSSALG_OWNER_FEATURE_REGISTRY });
      if (out.kind !== "ok") return backTo(res, slug, "melding=feil", anchor);
      if (out.batchId) {
        console.log(`[gardssalg-owner-features] owner chose level ${level.key} for provider ${provider.id}: ${out.changed.join(",")}`);
        return backTo(res, slug, `endret=${out.batchId}`, anchor, { place: false });
      }
      if (out.skipped.length) {
        return backTo(res, slug, `melding=hoppet&nokkel=${encodeURIComponent(out.skipped.map((s) => s.key).join(","))}`, anchor);
      }
      return backTo(res, slug, "melding=niva_valgt", anchor);
    } catch (e) {
      return failBack("POST valg/niva")(req, res, e, anchor);
    }
  });

  router.post(
    "/kategori/gardssalg/eier/:providerSlug/valg/angre",
    generalLimiter,
    express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    let anchor = OWNER_ANCHOR_FALLBACK;
    try {
      const g = pageGate(req);
      if (!g.ok) return g.send(res);
      const { provider, slug } = g;
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const batchId = Number.parseInt(String(body.batch ?? ""), 10);
      // T5: «Angre» returns to the row or card that was undone (read after the Origin check).
      let placed = false;
      const undoAnchor = () => {
        if (!placed) { anchor = ownerUndoAnchor(VERTICAL, provider.id, batchId, getRfbDb()); placed = true; }
        return anchor;
      };
      const guard = writeGuard(req, g.token, undoAnchor);
      if (guard) return guard(res);
      undoAnchor();
      if (!Number.isFinite(batchId) || batchId <= 0) return backTo(res, slug, "melding=angre_umulig", anchor);
      const out = undoOwnerChange(VERTICAL, provider.id, batchId, { actor: "owner", detail: sessionEmail(g.token) }, { registry: GARDSSALG_OWNER_FEATURE_REGISTRY });
      if (out.kind === "ok") {
        return out.batchId
          ? backTo(res, slug, `endret=${out.batchId}`, anchor, { place: false })
          : backTo(res, slug, "melding=angret", anchor);
      }
      if (out.kind === "changed_since") return backTo(res, slug, "melding=angre_endret", anchor);
      if (out.kind === "blocked") return backTo(res, slug, `melding=sperret&nokkel=${encodeURIComponent(out.key)}`, anchor);
      return backTo(res, slug, "melding=angre_umulig", anchor);
    } catch (e) {
      return failBack("POST valg/angre")(req, res, e, anchor);
    }
  });

  router.post(
    "/kategori/gardssalg/eier/:providerSlug/valg/interesse",
    generalLimiter,
    express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    let anchor = OWNER_ANCHOR_PLANNED;
    try {
      const g = pageGate(req);
      if (!g.ok) return g.send(res);
      const { provider, slug } = g;
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const key = typeof body.key === "string" ? body.key : "";
      const planned = findOwnerFeature(key, GARDSSALG_OWNER_FEATURE_REGISTRY);
      if (planned && planned.status === "coming_soon") anchor = ownerPlannedAnchor(planned.key);
      const guard = writeGuard(req, g.token, anchor);
      if (guard) return guard(res);
      const out = recordOwnerFeatureInterest(VERTICAL, provider.id, key, sessionEmail(g.token));
      if (out.kind !== "ok") return backTo(res, slug, "melding=ugyldig", OWNER_ANCHOR_PLANNED);
      if (out.created) console.log(`[gardssalg-owner-features] owner interest in ${key} for provider ${provider.id}`);
      return backTo(res, slug, `melding=${out.created ? "interesse" : "interesse_finnes"}`, ownerPlannedAnchor(key));
    } catch (e) {
      return failBack("POST valg/interesse")(req, res, e, anchor);
    }
  });

  // ── JSON API (same checks, JSON answers) ──────────────────────────────
  type ApiGate = { ok: true; providerId: string; token: string } | { ok: false; status: number; body: Record<string, unknown> };
  function apiGate(req: Request): ApiGate {
    const nf = { ok: false as const, status: 404, body: { success: false, error: "not_found" } };
    if (!oaOwnerFeaturesEnabled()) return nf;
    const providerId = String((req.params as any).providerId || "");
    if (!providerId || !getClaimProviderById(providerId) || !gardssalgOwnerFeaturesTabOpen(providerId)) return nf;
    const session = deps.sessionFromRequest(req);
    if (!session.valid || !session.token) return { ok: false, status: 401, body: { success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." } };
    if (session.providerId !== providerId || !isGardssalgProviderClaimed(providerId)) {
      return { ok: false, status: 403, body: { success: false, error: "forbidden", message: "Du har ikke tilgang til denne produsenten." } };
    }
    return { ok: true, providerId, token: session.token };
  }

  router.get(
    "/api/opplevelser/gardssalg-claim/:providerId/features",
    generalLimiter,
    (req: Request, res: Response) => {
    try {
      const g = apiGate(req);
      if (!g.ok) return res.status(g.status).json(g.body);
      const registry = GARDSSALG_OWNER_FEATURE_REGISTRY;
      const resolved = resolveOwnerFeatures(VERTICAL, g.providerId, { registry });
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        success: true,
        vertical: VERTICAL,
        subject_id: g.providerId,
        segment: resolved.subject.segment,
        groups: GARDSSALG_OWNER_FEATURE_GROUPS,
        features: registry.map((e) => featureJson(e, resolved.byKey[e.key], resolved.subject)),
      });
    } catch (e) {
      console.error("[gardssalg-owner-features] GET features failed:", e);
      return res.status(500).json({ success: false, error: "server_error" });
    }
  });

  router.put(
    "/api/opplevelser/gardssalg-claim/:providerId/features/:key",
    generalLimiter,
    express.json(), (req: Request, res: Response) => {
    try {
      const g = apiGate(req);
      if (!g.ok) return res.status(g.status).json(g.body);
      if (isCrossSiteWrite(req, "/api/opplevelser/gardssalg-claim/:providerId/features/:key")) return res.status(403).json({ success: false, error: "cross_site" });
      const capKey = crypto.createHash("sha256").update(g.token).digest("hex");
      if (writeCap.isOver(capKey)) return res.status(429).json({ success: false, error: "rate_limited", message: "For mange endringer. Prøv igjen om litt." });
      writeCap.record(capKey);
      const key = String((req.params as any).key || "");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (!Object.prototype.hasOwnProperty.call(body, "value")) {
        return res.status(400).json({ success: false, error: "invalid_value", reason: "Mangler verdi.", reason_en: "Missing value." });
      }
      const registry = GARDSSALG_OWNER_FEATURE_REGISTRY;
      const out = setOwnerFeatureValue(VERTICAL, g.providerId, key, (body as any).value, { actor: "owner", detail: sessionEmail(g.token) }, { registry });
      switch (out.kind) {
        case "unknown_key":
          return res.status(404).json({ success: false, error: "unknown_key" });
        case "not_found":
          return res.status(404).json({ success: false, error: "not_found" });
        case "invalid_value":
          return res.status(400).json({ success: false, error: "invalid_value", key, reason: out.reason.no, reason_en: out.reason.en });
        case "blocked":
          return res.status(409).json({ success: false, error: out.block, key, reason: out.reason.no, reason_en: out.reason.en });
        case "ok": {
          const resolved = resolveOwnerFeatures(VERTICAL, g.providerId, { registry });
          const e = registry.find((x) => x.key === key)!;
          if (out.changed) console.log(`[gardssalg-owner-features] owner set ${key} for provider ${g.providerId}`);
          res.setHeader("Cache-Control", "no-store");
          return res.json({ success: true, changed: out.changed, feature: featureJson(e, resolved.byKey[key], resolved.subject) });
        }
      }
    } catch (e) {
      console.error("[gardssalg-owner-features] PUT feature failed:", e);
      return res.status(500).json({ success: false, error: "server_error" });
    }
  });

  return router;
}

/**
 * The shared page uses the RFB portal's ep-* classes and forest green; on
 * opplevagent.no the gårdssalg shell (gc-*, teal #0f5a50) carries it, so the
 * same classes get the Opplevagent colours here. Appended after the page's
 * own CSS so it wins; dark mode keeps the page's dark palette.
 */
export const GARDSSALG_PAGE_CSS = `
  .ep-card { background: #fff; border: 1px solid #e5e0d3; border-radius: 10px; padding: 24px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  .ep-card h1 { font-size: 1.4rem; color: #0f5a50; margin: 0 0 12px; }
  .ep-card h2 { font-size: 1.1rem; color: #0f5a50; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #f0ede2; }
  .ep-card p { margin: 8px 0; }
  .ep-field { margin-bottom: 16px; }
  .ep-field label { display: block; font-size: 0.92rem; font-weight: 600; color: #404040; margin-bottom: 6px; }
  .ep-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 10px 20px; font-size: 1rem; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; text-decoration: none; }
  .ep-btn-primary { background: #0f5a50; color: #fff; }
  .ep-btn-primary:hover, .ep-btn-primary:focus { background: #0e3c36; }
  .ep-btn-secondary { background: #fff; color: #0f5a50; border: 1px solid #0f5a50; }
  .ep-btn-secondary:hover { background: #eef5f3; }
  .ep-audit-list { list-style: none; padding: 0; margin: 0; }
  .ep-audit-item { padding: 10px 0; border-bottom: 1px solid #f0ede2; font-size: 0.88rem; }
  .ep-audit-item:last-child { border-bottom: none; }
  .ep-audit-meta { color: #737373; font-size: 0.78rem; }
  .ep-form-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  .mv-check, .mv-always, .mv-asked, .mv-stat strong, .mv-more summary, .mv-explain-box summary { color: #0f5a50; }
  .mv-check-missing { color: #92400e; }
  .mv-badge-new { background: #dcefeb; color: #0f5a50; }
  .mv-fold-summary::after { color: #0f5a50; }
  .mv-level[aria-current="true"] { border-color: #0f5a50; box-shadow: inset 0 0 0 1px #0f5a50; }
  .mv-confirm { border-color: #0f5a50; }
  @media (max-width: 480px) { .ep-card { padding: 18px 14px; } .ep-card h1 { font-size: 1.25rem; } }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1614; color: #e6ece9; }
    .ep-card { background: #16211e; border-color: #2a3a35; box-shadow: none; }
    .ep-card h1, .ep-card h2, .mv-check, .mv-always, .mv-asked, .mv-stat strong, .mv-more summary, .mv-explain-box summary, .mv-fold-summary::after { color: #9fd6cb; }
    .mv-check-missing { color: #f5c27a; }
    .ep-btn-primary { background: #1f7a6c; color: #fff; }
    .ep-btn-secondary { background: transparent; color: #bfe6de; border-color: #6fb3a6; }
    .mv-badge-new { background: #1d3d37; color: #bfe6de; }
    .mv-level[aria-current="true"] { border-color: #6fb3a6; box-shadow: inset 0 0 0 1px #6fb3a6; }
  }
`;

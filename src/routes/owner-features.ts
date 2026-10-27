import express, { Router, Request, Response } from "express";
import crypto from "crypto";
import { getDb } from "../database/init";
import {
  verifyOwnerSession, isVerifiedOwner, crossSiteRequest, OWNER_NOT_VERIFIED_MESSAGE,
  portalShell, ownerNotVerifiedPage,
} from "./owner-portal";
import { isSubjectAllowedForOwnerFeatures } from "../owner-features/allowlist";
import { OWNER_FEATURE_GROUPS, OWNER_FEATURE_REGISTRY, type OwnerFeatureEntry } from "../owner-features/registry";
import {
  resolveOwnerFeatures,
  setOwnerFeatureValue,
  type ResolvedOwnerFeature,
  type OwnerFeatureSubject,
} from "../owner-features/resolve";
import { SlidingWindowCap } from "../services/a2a-traffic-classifier";
import {
  applyOwnerLevel,
  applyOwnerSingleChange,
  answerOwnerIntro,
  currentOwnerLevel,
  findOwnerLevel,
  getOwnerChangeBatch,
  latestUndoableBatch,
  ownerFeatureChangeLog,
  previewOwnerLevel,
  readOwnerIntro,
  undoOwnerChange,
} from "../owner-features/changes";
import { formatOwnerFeatureValue, renderOwnerFeaturesPageBody, type OwnerPageNotice } from "../owner-features/page";
import { findOwnerFeature } from "../owner-features/registry";

// ─────────────────────────────────────────────────────────────────
// «Mine valg» owner API — dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2a
// ─────────────────────────────────────────────────────────────────
//   GET /api/owner/:id/features        → every registry entry, resolved
//   PUT /api/owner/:id/features/:key   { value } → 200 new state | 400 invalid
//       value | 409 blocked (reason + reason_en) | 404 unknown key | 429
//
// Every call: allowlist (OWNER_FEATURES_ALLOWED_SUBJECTS, `rfb:<agents.id>`;
// not listed / unset → 404, nothing read or written) → owner session (none →
// 401) → isVerifiedOwner (the same predicate as the other owner endpoints;
// an e-mail-match session without verified ownership → 403). PUT also gets
// the Origin check the /eier form routes use and a per-session write limit.
// S2b adds the «Mine valg» page under /eier/:agentId/valg (below), behind the
// same allowlist and checks.

const router = Router();
const VERTICAL = "rfb" as const;

/** Per-session write limit: 30 PUTs per minute per session token. */
export const OWNER_FEATURES_WRITES_PER_MINUTE = 30;
const writeCap = new SlidingWindowCap(OWNER_FEATURES_WRITES_PER_MINUTE, 60 * 1000);

export function __resetOwnerFeaturesRateLimitForTesting(): void {
  writeCap.reset();
}

function notFound(res: Response) {
  return res.status(404).json({ success: false, error: "not_found" });
}

type Gate =
  | { ok: true; agentId: string; token: string }
  | { ok: false; send: (res: Response) => Response };

function gate(req: Request): Gate {
  const agentId = String(req.params.id || "");
  if (!isSubjectAllowedForOwnerFeatures(VERTICAL, agentId)) return { ok: false, send: notFound };
  const session = verifyOwnerSession(req);
  if (!session.valid || !session.token) {
    return {
      ok: false,
      send: (res) => res.status(401).json({ success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." }),
    };
  }
  if (!isVerifiedOwner(agentId, session)) {
    const body = session.agentId === agentId
      ? { success: false, error: "ownership_not_verified", message: OWNER_NOT_VERIFIED_MESSAGE }
      : { success: false, error: "forbidden", message: "Du har ikke tilgang til denne agenten." };
    return { ok: false, send: (res) => res.status(403).json(body) };
  }
  return { ok: true, agentId, token: session.token };
}

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
    value: r.value,
    default: subject.segment === "owner" ? e.default.owner : e.default.unclaimed,
    source: r.source,
    changeable: r.changeable,
    reason: r.reason,
  };
}

function sessionEmail(token: string): string | null {
  try {
    const row = getDb().prepare("SELECT email FROM magic_links WHERE token = ?").get(token) as { email?: string } | undefined;
    return row?.email ?? null;
  } catch {
    return null;
  }
}

router.get("/api/owner/:id/features", (req: Request, res: Response) => {
  try {
    const g = gate(req);
    if (!g.ok) return g.send(res);
    const resolved = resolveOwnerFeatures(VERTICAL, g.agentId);
    if (!resolved.subject.exists) return notFound(res);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      success: true,
      vertical: VERTICAL,
      subject_id: g.agentId,
      segment: resolved.subject.segment,
      groups: OWNER_FEATURE_GROUPS,
      features: OWNER_FEATURE_REGISTRY.map((e) => featureJson(e, resolved.byKey[e.key], resolved.subject)),
    });
  } catch (e: any) {
    console.error("[owner-features] GET features failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

router.put("/api/owner/:id/features/:key", (req: Request, res: Response) => {
  try {
    const g = gate(req);
    if (!g.ok) return g.send(res);
    if (crossSiteRequest(req)) return res.status(403).json({ success: false, error: "cross_site" });
    const capKey = crypto.createHash("sha256").update(g.token).digest("hex");
    if (writeCap.isOver(capKey)) {
      return res.status(429).json({ success: false, error: "rate_limited", message: "For mange endringer. Prøv igjen om litt." });
    }
    writeCap.record(capKey);

    const key = String(req.params.key || "");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!Object.prototype.hasOwnProperty.call(body, "value")) {
      return res.status(400).json({ success: false, error: "invalid_value", reason: "Mangler verdi.", reason_en: "Missing value." });
    }
    const out = setOwnerFeatureValue(VERTICAL, g.agentId, key, body.value, { actor: "owner", detail: sessionEmail(g.token) });
    switch (out.kind) {
      case "unknown_key":
        return res.status(404).json({ success: false, error: "unknown_key" });
      case "not_found":
        return notFound(res);
      case "invalid_value":
        return res.status(400).json({ success: false, error: "invalid_value", key, reason: out.reason.no, reason_en: out.reason.en });
      case "blocked":
        return res.status(409).json({ success: false, error: out.block, key, reason: out.reason.no, reason_en: out.reason.en });
      case "ok": {
        const resolved = resolveOwnerFeatures(VERTICAL, g.agentId);
        const e = OWNER_FEATURE_REGISTRY.find((x) => x.key === key)!;
        if (out.changed) console.log(`[owner-features] owner set ${key} for agent ${g.agentId}`);
        res.setHeader("Cache-Control", "no-store");
        return res.json({ success: true, changed: out.changed, feature: featureJson(e, resolved.byKey[key], resolved.subject) });
      }
    }
  } catch (e: any) {
    console.error("[owner-features] PUT feature failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// «Mine valg» page — dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2b
// ─────────────────────────────────────────────────────────────────
//   GET  /eier/:agentId/valg            the page (?niva= level confirm panel,
//                                       ?bekreft=&verdi= switch confirm panel,
//                                       ?side= change-log page, ?endret= /
//                                       ?melding= the message at the bottom)
//   POST /eier/:agentId/valg/sett       { key, value[, confirmed] } one entry
//   POST /eier/:agentId/valg/niva       { level, confirmed } apply a level
//   POST /eier/:agentId/valg/angre      { batch } undo the newest change
//   POST /eier/:agentId/valg/intro      { answer: yes|no } first-login card
// Same order of checks as the API: allowlist (404) → owner session (401) →
// isVerifiedOwner (403) → [POST] Origin check (403) → per-session write limit
// (429, shared with PUT). Every write goes through setOwnerFeatureValue.
// POSTs answer 303 back to the page; nothing is e-mailed.

function pagePath(agentId: string, tail = ""): string {
  return `/eier/${encodeURIComponent(agentId)}/valg${tail}`;
}

function simplePage(status: number, title: string, html: string) {
  return (res: Response) => res.status(status).send(portalShell(title, `<div class="ep-card">${html}</div>`));
}

function pageGate(req: Request): Gate {
  const agentId = String((req.params as any).agentId || "");
  if (!isSubjectAllowedForOwnerFeatures(VERTICAL, agentId)) {
    return { ok: false, send: simplePage(404, "Fant ikke siden", `<h1>Fant ikke siden</h1>`) };
  }
  const session = verifyOwnerSession(req);
  if (!session.valid || !session.token) {
    return {
      ok: false,
      send: simplePage(401, "Logg inn", `<h1>Logg inn</h1><p>Din sesjon er utløpt. <a href="/eier/${encodeURIComponent(agentId)}">Logg inn på nytt</a>.</p>`),
    };
  }
  if (!isVerifiedOwner(agentId, session)) {
    if (session.agentId === agentId) return { ok: false, send: (res) => res.status(403).send(ownerNotVerifiedPage(agentId)) };
    return { ok: false, send: simplePage(403, "Ingen tilgang", `<h1>Ingen tilgang</h1><p>Du har ikke tilgang til denne produsenten.</p>`) };
  }
  return { ok: true, agentId, token: session.token };
}

/** Origin check + per-session write limit for the page's POSTs. */
function pageWriteGuard(req: Request, token: string): ((res: Response) => Response) | null {
  if (crossSiteRequest(req)) return simplePage(403, "Ingen tilgang", `<h1>Ingen tilgang</h1><p>Forespørselen kom fra en annen side.</p>`);
  const capKey = crypto.createHash("sha256").update(token).digest("hex");
  if (writeCap.isOver(capKey)) {
    return simplePage(429, "For mange endringer", `<h1>For mange endringer</h1><p>Prøv igjen om litt.</p>`);
  }
  writeCap.record(capKey);
  return null;
}

/** The owner may try a write (setOwnerFeatureValue decides): changeable, or only a requirement missing (turning off is allowed). */
function canAttempt(r: ResolvedOwnerFeature | undefined): boolean {
  return !!r && (r.changeable || r.block === "requirement_not_met");
}

/** Form text → the typed value setOwnerFeatureValue validates. */
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

const PAGE_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  ingen_endring: { ok: true, text: "Ingen endring — valget var allerede slik." },
  angret: { ok: true, text: "Endringen er angret." },
  angre_umulig: { ok: false, text: "Denne endringen kan ikke angres lenger." },
  angre_endret: { ok: false, text: "Endringen kan ikke angres fordi valget er endret siden." },
  intro_ja: { ok: true, text: "Takk! Svaret ditt er lagret: du vil ha nyheter og tips." },
  intro_nei: { ok: true, text: "Takk! Svaret ditt er lagret: ingen nyheter og tips." },
  ugyldig: { ok: false, text: "Verdien er ikke gyldig." },
  feil: { ok: false, text: "Klarte ikke å lagre. Prøv igjen." },
};

function batchNotice(agentId: string, batchId: number): OwnerPageNotice | null {
  const batch = getOwnerChangeBatch(VERTICAL, agentId, batchId);
  if (!batch) return null;
  const db = getDb();
  const rows = db
    .prepare(`SELECT key, new_json FROM owner_feature_audit WHERE vertical = ? AND subject_id = ? AND id BETWEEN ? AND ? ORDER BY id`)
    .all(VERTICAL, agentId, batch.first_audit_id, batch.last_audit_id) as Array<{ key: string; new_json: string | null }>;
  const parts = rows.map((r) => {
    const e = findOwnerFeature(r.key);
    let v: any = null;
    try { v = r.new_json == null ? null : JSON.parse(r.new_json); } catch { v = null; }
    return `«${e ? e.label.no : r.key}» er ${formatOwnerFeatureValue(e, v)}`;
  });
  let text: string;
  if (batch.kind === "level") {
    const l = findOwnerLevel(batch.level);
    text = `Du har valgt «${l ? l.label.no : "nivå"}». Lagret: ${parts.join(", ")}.`;
  } else if (batch.kind === "undo") {
    text = `Angret. ${parts.join(", ")}.`;
  } else {
    text = `Lagret: ${parts.join(", ")}.`;
  }
  const undoable = latestUndoableBatch(VERTICAL, agentId);
  return { ok: true, text, undoBatchId: undoable && undoable.id === batch.id ? batch.id : null };
}

router.get("/eier/:agentId/valg", (req: Request, res: Response) => {
  try {
    const g = pageGate(req);
    if (!g.ok) return g.send(res);
    const agentId = g.agentId;
    const db = getDb();
    const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(agentId) as { id: string; name: string } | undefined;
    if (!agent) return simplePage(404, "Fant ikke siden", `<h1>Fant ikke siden</h1>`)(res);
    const resolved = resolveOwnerFeatures(VERTICAL, agentId);
    const q = req.query as Record<string, unknown>;
    const qs = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
    // Only own keys are looked up (never prototype names from the query).
    const own = <T>(o: Record<string, T>, k: string): T | undefined =>
      (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
    const resolvedKey = (k: string) => own(resolved.byKey, k);

    let notice: OwnerPageNotice | null = null;
    const changedId = Number.parseInt(qs("endret"), 10);
    if (Number.isFinite(changedId) && changedId > 0) notice = batchNotice(agentId, changedId);
    const msg = own(PAGE_MESSAGES, qs("melding"));
    if (!notice && msg) notice = { ok: msg.ok, text: msg.text };
    if (!notice && qs("melding") === "sperret") {
      const r = resolvedKey(qs("nokkel"));
      notice = { ok: false, text: r?.reason ? `Kan ikke endres: ${r.reason.no}` : "Dette valget kan ikke endres nå." };
    }
    if (!notice && qs("melding") === "hoppet") {
      const reasons = qs("nokkel").split(",").map((k) => resolvedKey(k)).filter((r) => r && r.reason)
        .map((r) => `«${findOwnerFeature(r!.key)?.label.no ?? r!.key}»: ${r!.reason!.no}`);
      notice = { ok: false, text: reasons.length ? `Ingenting ble endret. ${reasons.join(" ")}` : "Ingenting ble endret." };
    }

    let confirm: { key: string; value: boolean } | null = null;
    const ck = qs("bekreft");
    if (ck && canAttempt(resolvedKey(ck))) confirm = { key: ck, value: qs("verdi") === "1" };
    const levelPreview = findOwnerLevel(qs("niva")) ? previewOwnerLevel(VERTICAL, agentId, qs("niva")) : null;

    const page = Number.parseInt(qs("side"), 10);
    const log = ownerFeatureChangeLog(VERTICAL, agentId, Number.isFinite(page) ? page : 1);
    const body = renderOwnerFeaturesPageBody({
      agent: { id: agent.id, name: String(agent.name || "") },
      resolved,
      level: currentOwnerLevel(VERTICAL, agentId, resolved),
      showIntro: !readOwnerIntro(VERTICAL, agentId),
      notice,
      confirm,
      levelPreview,
      log,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.send(portalShell(`Mine valg · ${agent.name}`, body));
  } catch (e: any) {
    console.error("[owner-features] GET /eier/:agentId/valg failed:", e);
    return simplePage(500, "Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`)(res);
  }
});

router.post("/eier/:agentId/valg/sett", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = pageGate(req);
    if (!g.ok) return g.send(res);
    const guard = pageWriteGuard(req, g.token);
    if (guard) return guard(res);
    const agentId = g.agentId;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const key = typeof body.key === "string" ? body.key : "";
    const e = findOwnerFeature(key);
    if (!e) return res.redirect(303, pagePath(agentId, "?melding=ugyldig"));
    const value = formValue(e, body.value);
    // In-page confirm panel first for entries with confirmOn / confirmOff.
    if (body.confirmed !== "1" && typeof value === "boolean" && (value ? e.confirmOn : e.confirmOff)
        && canAttempt(resolveOwnerFeatures(VERTICAL, agentId).byKey[key])) {
      return res.redirect(303, pagePath(agentId, `?bekreft=${encodeURIComponent(key)}&verdi=${value ? "1" : "0"}#bekreft`));
    }
    const out = applyOwnerSingleChange(VERTICAL, agentId, key, value, { actor: "owner", detail: sessionEmail(g.token) });
    const r = out.result;
    if (r.kind === "ok") {
      if (!r.changed) return res.redirect(303, pagePath(agentId, "?melding=ingen_endring"));
      console.log(`[owner-features] owner set ${key} for agent ${agentId} (page)`);
      return res.redirect(303, pagePath(agentId, `?endret=${out.batchId}#valg-${encodeURIComponent(key)}`));
    }
    if (r.kind === "blocked") return res.redirect(303, pagePath(agentId, `?melding=sperret&nokkel=${encodeURIComponent(key)}`));
    if (r.kind === "invalid_value") return res.redirect(303, pagePath(agentId, "?melding=ugyldig"));
    return res.redirect(303, pagePath(agentId, "?melding=feil"));
  } catch (e: any) {
    console.error("[owner-features] POST valg/sett failed:", e);
    return simplePage(500, "Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`)(res);
  }
});

router.post("/eier/:agentId/valg/niva", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = pageGate(req);
    if (!g.ok) return g.send(res);
    const guard = pageWriteGuard(req, g.token);
    if (guard) return guard(res);
    const agentId = g.agentId;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const level = findOwnerLevel(body.level);
    if (!level) return res.redirect(303, pagePath(agentId, "?melding=ugyldig"));
    if (body.confirmed !== "1") return res.redirect(303, pagePath(agentId, `?niva=${encodeURIComponent(level.key)}#bekreft`));
    const out = applyOwnerLevel(VERTICAL, agentId, level.key, { actor: "owner", detail: sessionEmail(g.token) });
    if (out.kind !== "ok") return res.redirect(303, pagePath(agentId, "?melding=feil"));
    if (out.batchId) {
      console.log(`[owner-features] owner chose level ${level.key} for agent ${agentId}: ${out.changed.join(",")}`);
      return res.redirect(303, pagePath(agentId, `?endret=${out.batchId}#niva`));
    }
    if (out.skipped.length) {
      return res.redirect(303, pagePath(agentId, `?melding=hoppet&nokkel=${encodeURIComponent(out.skipped.map((s) => s.key).join(","))}#niva`));
    }
    return res.redirect(303, pagePath(agentId, "?melding=ingen_endring#niva"));
  } catch (e: any) {
    console.error("[owner-features] POST valg/niva failed:", e);
    return simplePage(500, "Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`)(res);
  }
});

router.post("/eier/:agentId/valg/angre", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = pageGate(req);
    if (!g.ok) return g.send(res);
    const guard = pageWriteGuard(req, g.token);
    if (guard) return guard(res);
    const agentId = g.agentId;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const batchId = Number.parseInt(String(body.batch ?? ""), 10);
    if (!Number.isFinite(batchId) || batchId <= 0) return res.redirect(303, pagePath(agentId, "?melding=angre_umulig"));
    const out = undoOwnerChange(VERTICAL, agentId, batchId, { actor: "owner", detail: sessionEmail(g.token) });
    if (out.kind === "ok") {
      console.log(`[owner-features] owner undid batch ${batchId} for agent ${agentId}`);
      return res.redirect(303, pagePath(agentId, out.batchId ? `?endret=${out.batchId}` : "?melding=angret"));
    }
    if (out.kind === "changed_since") return res.redirect(303, pagePath(agentId, "?melding=angre_endret"));
    if (out.kind === "blocked") return res.redirect(303, pagePath(agentId, `?melding=sperret&nokkel=${encodeURIComponent(out.key)}`));
    return res.redirect(303, pagePath(agentId, "?melding=angre_umulig"));
  } catch (e: any) {
    console.error("[owner-features] POST valg/angre failed:", e);
    return simplePage(500, "Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`)(res);
  }
});

router.post("/eier/:agentId/valg/intro", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = pageGate(req);
    if (!g.ok) return g.send(res);
    const guard = pageWriteGuard(req, g.token);
    if (guard) return guard(res);
    const agentId = g.agentId;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const answer = body.answer === "yes" ? "yes" : body.answer === "no" ? "no" : null;
    if (!answer) return res.redirect(303, pagePath(agentId, "?melding=ugyldig"));
    const out = answerOwnerIntro(VERTICAL, agentId, answer, { actor: "owner", detail: sessionEmail(g.token) });
    if (out.batchId) return res.redirect(303, pagePath(agentId, `?endret=${out.batchId}`));
    return res.redirect(303, pagePath(agentId, `?melding=${answer === "yes" ? "intro_ja" : "intro_nei"}`));
  } catch (e: any) {
    console.error("[owner-features] POST valg/intro failed:", e);
    return simplePage(500, "Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`)(res);
  }
});

export default router;

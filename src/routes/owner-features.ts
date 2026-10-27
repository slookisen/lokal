import { Router, Request, Response } from "express";
import crypto from "crypto";
import { getDb } from "../database/init";
import { verifyOwnerSession, isVerifiedOwner, crossSiteRequest, OWNER_NOT_VERIFIED_MESSAGE } from "./owner-portal";
import { isSubjectAllowedForOwnerFeatures } from "../owner-features/allowlist";
import { OWNER_FEATURE_GROUPS, OWNER_FEATURE_REGISTRY, type OwnerFeatureEntry } from "../owner-features/registry";
import {
  resolveOwnerFeatures,
  setOwnerFeatureValue,
  type ResolvedOwnerFeature,
  type OwnerFeatureSubject,
} from "../owner-features/resolve";
import { SlidingWindowCap } from "../services/a2a-traffic-classifier";

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
// No page in this slice — the «Mine valg» page is a later slice.

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

export default router;

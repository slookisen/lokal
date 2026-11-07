// ─── Admin: GET /admin/owner-gate-impact (READ-ONLY) ────────────────────────
//
// dev-request 2026-11-06-rfb-krav-for-portal-og-okter-ved-eierskifte, spec
// point 1: before OWNER_VERIFIED_OWNER_GATE_ENABLED is switched on, count who
// the gate would stop. With the gate on, every owner endpoint answers 403
// unless isVerifiedOwner() holds, i.e. the profile has a verified owner by the
// shared customer rule (customerRuleSql: agents.claimed_at set OR a verified
// agent_claims row — routes/owner-portal.ts agentHasVerifiedOwner).
//
// ── STRICTLY READ-ONLY ──────────────────────────────────────────────────
// SELECTs only. No flag is read from or written to anywhere but process.env
// (ownerVerifiedOwnerGateEnabled()), nothing is revoked or expired.
//
// What is counted:
//   * Profiles: RFB agents (COALESCE(vertical_id,'rfb') = 'rfb') with
//     is_active = 1 — the profiles an owner can actually reach. The
//     `_without_verified_owner` count uses customerRuleSql, so it matches the
//     gate exactly.
//   * Live magic_links rows: `datetime(expires_at) > datetime('now')`, the same
//     comparison every reader uses (OWNER_TOKEN_NOT_EXPIRED_SQL). A row is
//     blocked when its agent_id has no verified owner; that check runs over
//     ALL live rows, whatever the agent's vertical / is_active (the gate does
//     not look at either), and a row whose agent no longer exists counts as
//     blocked (agentHasVerifiedOwner returns false for it).
//       - session    = used = 1 AND id NOT LIKE 'mlclaim_%' — exactly the rows
//                      verifyOwnerSession accepts as cookie / Bearer sessions
//                      ("mlsess_" /eier sessions, redeemed "ml_" links and
//                      redeemed /selger links). A used "mlclaim_" row is never
//                      a session and is left out of both counts.
//       - login link = used = 0 (any id prefix: "ml_" /eier links, "mlclaim_"
//                      claim-approval links, "mlbridge_" /selger bridges,
//                      uuid /selger links). The per-prefix split is in
//                      `live_by_kind`.
//
// Never returned: e-mail addresses, tokens, magic_links ids. Agent ids are.
//
// Auth: X-Admin-Key against ADMIN_KEY (fallback ANALYTICS_ADMIN_KEY), same as
// admin-agents-duplicate-slugs.ts; `adminLimiter` at the mount in src/index.ts.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { customerRuleSql } from "../services/customer-rule";
import { ownerVerifiedOwnerGateEnabled } from "./owner-portal";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setOwnerGateImpactDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

export const BLOCKED_AGENT_IDS_SAMPLE_MAX = 50;

type KindCounts = { mlsess: number; ml: number; mlclaim: number; mlbridge: number; other: number };

export interface OwnerGateImpact {
  gate_enabled: boolean;
  rfb_profiles_total: number;
  rfb_profiles_without_verified_owner: number;
  live_sessions_total: number;
  live_login_links_total: number;
  live_sessions_blocked: number;
  live_login_links_blocked: number;
  profiles_with_blocked_live_access: number;
  blocked_agent_ids: string[];
  live_by_kind: { sessions: KindCounts; login_links: KindCounts };
  checked_at: string;
}

const LIVE_SQL = "datetime(m.expires_at) > datetime('now')";
const SESSION_SQL = "m.used = 1 AND m.id NOT LIKE 'mlclaim\\_%' ESCAPE '\\'";
const LINK_SQL = "COALESCE(m.used, 0) = 0";
const KIND_SQL = `CASE
    WHEN m.id LIKE 'mlsess\\_%' ESCAPE '\\' THEN 'mlsess'
    WHEN m.id LIKE 'mlclaim\\_%' ESCAPE '\\' THEN 'mlclaim'
    WHEN m.id LIKE 'mlbridge\\_%' ESCAPE '\\' THEN 'mlbridge'
    WHEN m.id LIKE 'ml\\_%' ESCAPE '\\' THEN 'ml'
    ELSE 'other' END`;

function emptyKinds(): KindCounts {
  return { mlsess: 0, ml: 0, mlclaim: 0, mlbridge: 0, other: 0 };
}

export function computeOwnerGateImpact(db: ReturnType<typeof getDb>): OwnerGateImpact {
  const profiles = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN ${customerRuleSql("a")} THEN 0 ELSE 1 END), 0) AS unowned
         FROM agents a
        WHERE COALESCE(a.vertical_id, 'rfb') = 'rfb' AND a.is_active = 1`,
    )
    .get() as { total: number; unowned: number };

  // One row per live session / login link: its kind, agent and whether the
  // agent has a verified owner (LEFT JOIN: a missing agent → not owned).
  const live = db
    .prepare(
      `SELECT CASE WHEN ${SESSION_SQL} THEN 'session' WHEN ${LINK_SQL} THEN 'link' ELSE NULL END AS cls,
              ${KIND_SQL} AS kind,
              m.agent_id AS agent_id,
              CASE WHEN a.id IS NOT NULL AND ${customerRuleSql("a")} THEN 1 ELSE 0 END AS owned
         FROM magic_links m
         LEFT JOIN agents a ON a.id = m.agent_id
        WHERE ${LIVE_SQL}`,
    )
    .all() as Array<{ cls: "session" | "link" | null; kind: keyof KindCounts; agent_id: string; owned: number }>;

  let sessionsTotal = 0;
  let linksTotal = 0;
  let sessionsBlocked = 0;
  let linksBlocked = 0;
  const sessionKinds = emptyKinds();
  const linkKinds = emptyKinds();
  const blocked = new Set<string>();
  for (const r of live) {
    if (r.cls === null) continue; // used "mlclaim_" row: neither a session nor a link
    const isBlocked = r.owned !== 1;
    if (r.cls === "session") {
      sessionsTotal++;
      sessionKinds[r.kind]++;
      if (isBlocked) sessionsBlocked++;
    } else {
      linksTotal++;
      linkKinds[r.kind]++;
      if (isBlocked) linksBlocked++;
    }
    if (isBlocked) blocked.add(String(r.agent_id));
  }
  const blockedIds = [...blocked].sort();

  return {
    gate_enabled: ownerVerifiedOwnerGateEnabled(),
    rfb_profiles_total: profiles.total,
    rfb_profiles_without_verified_owner: profiles.unowned,
    live_sessions_total: sessionsTotal,
    live_login_links_total: linksTotal,
    live_sessions_blocked: sessionsBlocked,
    live_login_links_blocked: linksBlocked,
    profiles_with_blocked_live_access: blockedIds.length,
    blocked_agent_ids: blockedIds.slice(0, BLOCKED_AGENT_IDS_SAMPLE_MAX),
    live_by_kind: { sessions: sessionKinds, login_links: linkKinds },
    checked_at: new Date().toISOString(),
  };
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(computeOwnerGateImpact(resolveDb()));
  } catch (err) {
    console.error("[admin-owner-gate-impact] error:", err instanceof Error ? err.message : "error");
    res.status(500).json({ error: "owner_gate_impact_failed" });
  }
});

export default router;

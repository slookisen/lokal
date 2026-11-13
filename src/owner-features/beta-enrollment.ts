// ─── Owner beta enrollment (table owner_beta_enrollment) ────────────────────
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S2.
//
// Reads (used by feature-tiers.ts) and the three writes the owner page will
// use in S3: optIn, optOut, registerInterest. In S2 the writes are NOT wired
// to any route — only tests call them.
//
// Rules:
//   - Only vertical `rfb`. Every other vertical is refused (no row written).
//   - optIn / registerInterest only while OWNER_BETA_MODE is exactly `offer`.
//     optOut is always allowed (an owner can always leave).
//   - The cap (OWNER_BETA_CAP): an opt-in when the number of OTHER `active`
//     rows is ≥ cap is stored as `interested`, never `active`. Nothing ever
//     promotes `interested` to `active` automatically — raising the cap only
//     lets the owner opt in again by their own action.
//   - Each change writes exactly one owner_feature_audit row (key
//     `beta.enrollment`, old/new status as JSON, the terms version in
//     text_version), in the same transaction. A no-op writes nothing.
//   - No e-mail address or IP is stored. Parameterized SQL only.
// The caller (S3) checks the verified owner (isVerifiedOwner), POST + CSRF.

import { getDb } from "../database/init";
import { ownerBetaCap, ownerBetaMode } from "./beta-mode";

export const OWNER_BETA_VERTICAL = "rfb";
/** owner_feature_audit.key for every enrollment change. */
export const OWNER_BETA_AUDIT_KEY = "beta.enrollment";

export type OwnerBetaStatus = "active" | "opted_out" | "interested";
export const OWNER_BETA_STATUSES: readonly OwnerBetaStatus[] = ["active", "opted_out", "interested"];

let _testDb: any = null;
/** Test hook: pin the DB this module reads/writes (null = getDb()). */
export function __setBetaEnrollmentTestDb(db: any): void { _testDb = db; }
function dbOf(db?: any): any { return db ?? _testDb ?? getDb(); }

export interface BetaEnrollmentRow {
  vertical: string;
  agent_id: string;
  status: OwnerBetaStatus;
  opted_in_at: string | null;
  opted_out_at: string | null;
  terms_version: string | null;
  updated_at: string;
}

// ── Reads (throw on a DB error; callers fail closed) ────────────────────────

/** The owner's row, or null. Throws on a DB error. */
export function betaEnrollmentRow(vertical: string, agentId: string, db?: any): BetaEnrollmentRow | null {
  if (!vertical || !agentId) return null;
  const row = dbOf(db)
    .prepare(
      `SELECT vertical, agent_id, status, opted_in_at, opted_out_at, terms_version, updated_at
         FROM owner_beta_enrollment WHERE vertical = ? AND agent_id = ?`,
    )
    .get(vertical, agentId) as BetaEnrollmentRow | undefined;
  return row ?? null;
}

/** The owner's status, or null when there is no row. Throws on a DB error. */
export function betaEnrollmentStatus(vertical: string, agentId: string, db?: any): OwnerBetaStatus | null {
  return betaEnrollmentRow(vertical, agentId, db)?.status ?? null;
}

/** true only for an `active` row. Throws on a DB error. */
export function isBetaEnrollmentActive(vertical: string, agentId: string, db?: any): boolean {
  return betaEnrollmentStatus(vertical, agentId, db) === "active";
}

/** The agent ids with an `active` row in `vertical`. Throws on a DB error. */
export function activeBetaAgentIds(vertical: string, db?: any): string[] {
  const rows = dbOf(db)
    .prepare(`SELECT agent_id FROM owner_beta_enrollment WHERE vertical = ? AND status = 'active' ORDER BY agent_id`)
    .all(vertical) as Array<{ agent_id: string }>;
  return rows.map((r) => r.agent_id).filter((id) => typeof id === "string" && id.length > 0);
}

export interface BetaEnrollmentCounts {
  active: number;
  interested: number;
  opted_out: number;
}

/** Row counts per status in `vertical`. Throws on a DB error. */
export function betaEnrollmentCounts(vertical: string = OWNER_BETA_VERTICAL, db?: any): BetaEnrollmentCounts {
  const out: BetaEnrollmentCounts = { active: 0, interested: 0, opted_out: 0 };
  const rows = dbOf(db)
    .prepare(`SELECT status, COUNT(*) AS n FROM owner_beta_enrollment WHERE vertical = ? GROUP BY status`)
    .all(vertical) as Array<{ status: string; n: number }>;
  for (const r of rows) {
    if (r.status === "active" || r.status === "interested" || r.status === "opted_out") out[r.status] = Number(r.n) || 0;
  }
  return out;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type BetaWriteResult =
  /** Wrong vertical, empty agent id or (optIn) empty terms version. */
  | { kind: "invalid" }
  /** OWNER_BETA_MODE is not `offer` (optIn / registerInterest only). */
  | { kind: "not_offered" }
  | { kind: "ok"; status: OwnerBetaStatus; changed: boolean; capped: boolean };

export interface BetaWriteOptions {
  db?: any;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** owner_feature_audit.actor (default `owner`). */
  actor?: "owner" | "admin" | "cs" | "system";
  actorDetail?: string | null;
}

function writeChange(
  db: any,
  vertical: string,
  agentId: string,
  prev: BetaEnrollmentRow | null,
  next: { status: OwnerBetaStatus; opted_in_at: string | null; opted_out_at: string | null; terms_version: string | null },
  now: string,
  opts: BetaWriteOptions,
): void {
  db.prepare(
    `INSERT INTO owner_beta_enrollment (vertical, agent_id, status, opted_in_at, opted_out_at, terms_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vertical, agent_id) DO UPDATE SET
       status = excluded.status, opted_in_at = excluded.opted_in_at, opted_out_at = excluded.opted_out_at,
       terms_version = excluded.terms_version, updated_at = excluded.updated_at`,
  ).run(vertical, agentId, next.status, next.opted_in_at, next.opted_out_at, next.terms_version, now);
  // Same columns as the «Mine valg» writes (resolve.ts setOwnerFeatureValue).
  db.prepare(
    `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at, text_version, placement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    vertical, agentId, OWNER_BETA_AUDIT_KEY,
    JSON.stringify(prev ? prev.status : null), JSON.stringify(next.status),
    opts.actor ?? "owner", opts.actorDetail ?? null, now, next.terms_version, null,
  );
}

function validSubject(vertical: string, agentId: string): boolean {
  return vertical === OWNER_BETA_VERTICAL && typeof agentId === "string" && agentId.length > 0;
}

/**
 * The owner turns beta on, accepting `termsVersion`. Within the cap → `active`;
 * at or over the cap → `interested` (capped: true). Already active → no-op.
 */
export function optIn(vertical: string, agentId: string, termsVersion: string, opts: BetaWriteOptions = {}): BetaWriteResult {
  if (!validSubject(vertical, agentId) || typeof termsVersion !== "string" || termsVersion.length === 0) return { kind: "invalid" };
  const env = opts.env ?? process.env;
  if (ownerBetaMode(env) !== "offer") return { kind: "not_offered" };
  const cap = ownerBetaCap(env);
  const db = dbOf(opts.db);
  const now = (opts.now ?? new Date()).toISOString();
  return db.transaction((): BetaWriteResult => {
    const prev = betaEnrollmentRow(vertical, agentId, db);
    if (prev?.status === "active") return { kind: "ok", status: "active", changed: false, capped: false };
    const others = db
      .prepare(`SELECT COUNT(*) AS n FROM owner_beta_enrollment WHERE vertical = ? AND status = 'active' AND agent_id <> ?`)
      .get(vertical, agentId) as { n: number };
    if ((Number(others.n) || 0) >= cap) {
      if (prev?.status === "interested") return { kind: "ok", status: "interested", changed: false, capped: true };
      writeChange(db, vertical, agentId, prev, {
        status: "interested", opted_in_at: prev?.opted_in_at ?? null, opted_out_at: prev?.opted_out_at ?? null,
        terms_version: prev?.terms_version ?? null,
      }, now, opts);
      return { kind: "ok", status: "interested", changed: true, capped: true };
    }
    writeChange(db, vertical, agentId, prev, {
      status: "active", opted_in_at: now, opted_out_at: prev?.opted_out_at ?? null, terms_version: termsVersion,
    }, now, opts);
    return { kind: "ok", status: "active", changed: true, capped: false };
  })();
}

/** The owner turns beta off (also withdraws an interest). Allowed in every mode. No row / already off → no-op. */
export function optOut(vertical: string, agentId: string, opts: BetaWriteOptions = {}): BetaWriteResult {
  if (!validSubject(vertical, agentId)) return { kind: "invalid" };
  const db = dbOf(opts.db);
  const now = (opts.now ?? new Date()).toISOString();
  return db.transaction((): BetaWriteResult => {
    const prev = betaEnrollmentRow(vertical, agentId, db);
    if (!prev || prev.status === "opted_out") return { kind: "ok", status: "opted_out", changed: false, capped: false };
    writeChange(db, vertical, agentId, prev, {
      status: "opted_out", opted_in_at: prev.opted_in_at, opted_out_at: now, terms_version: prev.terms_version,
    }, now, opts);
    return { kind: "ok", status: "opted_out", changed: true, capped: false };
  })();
}

/** The owner registers interest (cap reached). Already active or interested → no-op. */
export function registerInterest(vertical: string, agentId: string, opts: BetaWriteOptions = {}): BetaWriteResult {
  if (!validSubject(vertical, agentId)) return { kind: "invalid" };
  const env = opts.env ?? process.env;
  if (ownerBetaMode(env) !== "offer") return { kind: "not_offered" };
  const db = dbOf(opts.db);
  const now = (opts.now ?? new Date()).toISOString();
  return db.transaction((): BetaWriteResult => {
    const prev = betaEnrollmentRow(vertical, agentId, db);
    if (prev?.status === "active" || prev?.status === "interested") {
      return { kind: "ok", status: prev.status, changed: false, capped: false };
    }
    writeChange(db, vertical, agentId, prev, {
      status: "interested", opted_in_at: prev?.opted_in_at ?? null, opted_out_at: prev?.opted_out_at ?? null,
      terms_version: prev?.terms_version ?? null,
    }, now, opts);
    return { kind: "ok", status: "interested", changed: true, capped: false };
  })();
}

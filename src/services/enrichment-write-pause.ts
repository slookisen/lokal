// ─── Enrichment write-pause — the MECHANICAL fence ─────────────────────────
//
// dev-request 2026-08-20-enrichment-write-pause-mekanisk-gjerde (L3, P1).
//
// ── The failure this module exists to make impossible ──────────────────────
// On 2026-08-20 `lokal-agent-enrichment` wrote to prod for a whole cycle while
// an RFB enrichment write-pause was in force: 5 producers registered and ~8
// agents enriched in violation, one of them outside the target list and given
// a wrong website/phone. Second occurrence of the same failure class the same
// day. Root cause is not the caller — it is that the pause existed ONLY as
// prose in a SKILL file. Nothing in this codebase enforced it, so a caller on
// an older SKILL revision, or one that simply forgot to look, sailed straight
// through. Prose is not a gate.
//
// ── Why this is DB-backed and reads no YAML ────────────────────────────────
// The control-plane spelling of this lever, `controller/enrichment-write-
// pause.yaml`, lives in a DIFFERENT repo (slookisen/A2A) and is NEVER part of
// this app's container image — the Dockerfile COPYs only src/, tsconfig.json,
// openapi.yaml, verticals/, mcp-server*/. A guard that read that YAML from the
// running process would pass every dev test on a checkout where the file
// happens to sit next door, and then silently no-op in production, which is
// strictly worse than no guard at all: it would look enforced.
//
// So the state lives in the MAIN database (`getDb()`, database/init.ts), on
// the same Fly volume every other row this app writes already lives on,
// written through an authenticated admin endpoint (routes/admin-enrichment-
// write-pause.ts). This is the identical pattern the experiences vertical
// already runs in prod for its own admin levers — see
// services/gardssalg-outreach-size-gate.ts and POST /admin/gardssalg-booking-
// activation — just on the main DB instead of the experiences DB.
//
// ── Scope ──────────────────────────────────────────────────────────────────
// This module changes only WHERE the pause is enforced. The clearing
// semantics are unchanged and deliberately asymmetric: the verifier SETS a
// pause, only Daniel LIFTS it. That asymmetry is enforced by the API shape
// itself (setEnrichmentWritePause below), not merely by convention: enabling
// demands a `reason`, and clearing demands an explicit `cleared_by`. A clear
// with no `cleared_by` is REJECTED, never silently attributed to "system".
import type Database from "better-sqlite3";

export type EnrichmentVertical = "rfb" | "dental" | "experiences";

export const ENRICHMENT_VERTICALS: readonly EnrichmentVertical[] = [
  "rfb",
  "dental",
  "experiences",
] as const;

/**
 * The vertical an unrecognised/absent value resolves to. Deliberately the same
 * value `agents.vertical_id` itself defaults to (`TEXT NOT NULL DEFAULT 'rfb'`,
 * database/init.ts, Phase 4.6a), so a row that never had a vertical written and
 * a request that never named one land in the SAME bucket the column would put
 * them in — no new semantic invented here.
 */
export const DEFAULT_ENRICHMENT_VERTICAL: EnrichmentVertical = "rfb";

/**
 * Coerce anything into one of the three known verticals. An unknown string
 * (data drift, a typo, a caller inventing a vertical) collapses to 'rfb'
 * rather than to "some vertical nobody has ever paused" — an unknown value
 * must not be a way to slip past a live pause. Erring this way can only ever
 * BLOCK a write that might have been allowed; it can never allow one that
 * should have been blocked. Same posture contact-normalizer.ts documents:
 * "false negative is safe, false positive is not".
 */
export function normalizeEnrichmentVertical(value: unknown): EnrichmentVertical {
  if (typeof value !== "string") return DEFAULT_ENRICHMENT_VERTICAL;
  const v = value.trim().toLowerCase();
  return (ENRICHMENT_VERTICALS as readonly string[]).includes(v)
    ? (v as EnrichmentVertical)
    : DEFAULT_ENRICHMENT_VERTICAL;
}

/** True iff `value` is EXACTLY one of the three verticals (no coercion). */
export function isEnrichmentVertical(value: unknown): value is EnrichmentVertical {
  return typeof value === "string" && (ENRICHMENT_VERTICALS as readonly string[]).includes(value);
}

export interface EnrichmentWritePauseStatus {
  vertical: EnrichmentVertical;
  enabled: boolean;
  reason: string | null;
  triggered_at: string | null;
  triggered_by: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
  /**
   * true when no row has ever been written for this vertical. Absence of a row
   * is NOT an error and needs no seed migration — it simply means "never
   * paused". Surfaced so the admin GET can tell "nobody has ever touched this"
   * apart from "someone deliberately cleared it".
   */
  is_default: boolean;
}

type PauseRow = {
  vertical: string;
  enabled: number;
  reason: string | null;
  triggered_at: string | null;
  triggered_by: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
};

function notPaused(vertical: EnrichmentVertical): EnrichmentWritePauseStatus {
  return {
    vertical,
    enabled: false,
    reason: null,
    triggered_at: null,
    triggered_by: null,
    cleared_at: null,
    cleared_by: null,
    is_default: true,
  };
}

/**
 * Read the pause state for one vertical.
 *
 * Always a FRESH SELECT — deliberately never cached in-process. A pause set by
 * ANY instance (or by another request on this one) must be visible to the very
 * next read, including a read already in flight on a different route. A cache
 * here would reintroduce exactly the window this dev-request exists to close.
 *
 * Throws whatever the driver throws — callers that must not fail open use
 * assertEnrichmentWriteAllowed() below, which catches. The admin GET wants the
 * throw so it can answer 500 instead of pretending "not paused".
 */
export function getEnrichmentWritePause(
  db: Database.Database,
  vertical: EnrichmentVertical,
): EnrichmentWritePauseStatus {
  const row = db
    .prepare(
      `SELECT vertical, enabled, reason, triggered_at, triggered_by, cleared_at, cleared_by
         FROM enrichment_write_pause WHERE vertical = ?`,
    )
    .get(vertical) as PauseRow | undefined;
  if (!row) return notPaused(vertical);
  return {
    vertical,
    enabled: row.enabled === 1,
    reason: row.reason,
    triggered_at: row.triggered_at,
    triggered_by: row.triggered_by,
    cleared_at: row.cleared_at,
    cleared_by: row.cleared_by,
    is_default: false,
  };
}

export type EnrichmentWritePauseErrorCode = "reason_required" | "cleared_by_required";

/** Thrown by setEnrichmentWritePause for a caller-fixable violation (→ 400). */
export class EnrichmentWritePauseError extends Error {
  readonly code: EnrichmentWritePauseErrorCode;
  constructor(code: EnrichmentWritePauseErrorCode, message: string) {
    super(message);
    this.name = "EnrichmentWritePauseError";
    this.code = code;
  }
}

export interface EnrichmentWritePausePatch {
  vertical: EnrichmentVertical;
  enabled: boolean;
  /** Required when enabled === true. Ignored when clearing (kept for audit). */
  reason?: string | null;
  /** Who set the pause. Falls back to `actor` when absent. */
  triggered_by?: string | null;
  /**
   * REQUIRED when enabled === false. There is no default and no fallback to
   * `actor`: only Daniel lifts a pause, so "who lifted it" must be stated
   * explicitly on every single clear. A missing value is an error, never an
   * assumption.
   */
  cleared_by?: string | null;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/**
 * Upsert one vertical's pause row.
 *
 * The asymmetry lives HERE, in the API, not merely in a caller's discipline:
 *
 *   enabled: true  → `reason` is mandatory; stamps triggered_at/triggered_by
 *                    and clears any stale cleared_at/cleared_by (a new pause
 *                    supersedes the previous lift).
 *   enabled: false → `cleared_by` is mandatory; stamps cleared_at/cleared_by
 *                    and PRESERVES reason/triggered_at/triggered_by so the
 *                    record of what was paused and why survives the lift.
 *
 * Returns the row as it reads back immediately after the write — never the
 * caller's patch echoed back (same "re-read after write" discipline as
 * setGardssalgSizeGateConfig).
 */
export function setEnrichmentWritePause(
  db: Database.Database,
  patch: EnrichmentWritePausePatch,
  actor: string,
): EnrichmentWritePauseStatus {
  const vertical = patch.vertical;

  if (patch.enabled) {
    const reason = trimmedOrNull(patch.reason);
    if (!reason) {
      throw new EnrichmentWritePauseError(
        "reason_required",
        "reason kreves når skrivepausen slås PÅ",
      );
    }
    const triggeredBy = trimmedOrNull(patch.triggered_by) ?? actor;
    db.prepare(
      `INSERT INTO enrichment_write_pause
         (vertical, enabled, reason, triggered_at, triggered_by, cleared_at, cleared_by)
       VALUES (@vertical, 1, @reason, datetime('now'), @triggered_by, NULL, NULL)
       ON CONFLICT(vertical) DO UPDATE SET
         enabled = 1,
         reason = excluded.reason,
         triggered_at = excluded.triggered_at,
         triggered_by = excluded.triggered_by,
         cleared_at = NULL,
         cleared_by = NULL`,
    ).run({ vertical, reason, triggered_by: triggeredBy });
    return getEnrichmentWritePause(db, vertical);
  }

  const clearedBy = trimmedOrNull(patch.cleared_by);
  if (!clearedBy) {
    throw new EnrichmentWritePauseError(
      "cleared_by_required",
      "cleared_by kreves eksplisitt når skrivepausen oppheves — den settes aldri automatisk",
    );
  }
  db.prepare(
    `INSERT INTO enrichment_write_pause
       (vertical, enabled, reason, triggered_at, triggered_by, cleared_at, cleared_by)
     VALUES (@vertical, 0, NULL, NULL, NULL, datetime('now'), @cleared_by)
     ON CONFLICT(vertical) DO UPDATE SET
       enabled = 0,
       cleared_at = excluded.cleared_at,
       cleared_by = excluded.cleared_by`,
  ).run({ vertical, cleared_by: clearedBy });
  return getEnrichmentWritePause(db, vertical);
}

// ─── The guard ─────────────────────────────────────────────────────────────

export type EnrichmentWriteGuardResult =
  | { allowed: true; vertical: EnrichmentVertical }
  | {
      allowed: false;
      vertical: EnrichmentVertical;
      reason: string | null;
      triggered_at: string | null;
      /** true when the denial came from a LOOKUP FAILURE, not a stored pause. */
      fail_closed: boolean;
    };

/**
 * Norwegian reason surfaced when the lookup itself fails. Distinct text so an
 * operator reading a 423 can tell a real pause from a broken guard.
 */
export const ENRICHMENT_WRITE_PAUSE_LOOKUP_FAILED_REASON =
  "Kunne ikke lese skrivepause-status — behandles som PAUSE (fail-closed).";

/**
 * THE shared guard. Every enrichment write surface calls this before it does
 * anything else.
 *
 * FAIL-CLOSED: if the lookup itself throws — table missing, DB locked, a test
 * double that refuses to answer — the answer is PAUSED, never "unknown, so
 * probably fine". "Unknown = open" is precisely how the 2026-08-20 incident
 * happened: nothing said no, so everything said yes. A wrongly-blocked write
 * costs one retry; a wrongly-allowed one costs a prod cleanup.
 */
export function assertEnrichmentWriteAllowed(
  db: Database.Database,
  vertical: EnrichmentVertical,
): EnrichmentWriteGuardResult {
  let status: EnrichmentWritePauseStatus;
  try {
    status = getEnrichmentWritePause(db, vertical);
  } catch (err) {
    console.error(`[enrichment-write-pause] lookup failed for '${vertical}' — failing closed:`, err);
    return {
      allowed: false,
      vertical,
      reason: ENRICHMENT_WRITE_PAUSE_LOOKUP_FAILED_REASON,
      triggered_at: null,
      fail_closed: true,
    };
  }
  if (!status.enabled) return { allowed: true, vertical };
  return {
    allowed: false,
    vertical,
    reason: status.reason,
    triggered_at: status.triggered_at,
    fail_closed: false,
  };
}

/**
 * Resolve which vertical(s) a set of agent ids belongs to, reading
 * `agents.vertical_id` — the column that already answers this question for
 * every other per-vertical query in the app. No new source of truth.
 *
 * An id with no matching row contributes the DEFAULT vertical: such an item
 * cannot be written anyway (the handlers answer `not_found`), and including it
 * can only widen the gate, never narrow it. An EMPTY id list likewise yields
 * the default — a request that names no agent is still an RFB write surface.
 *
 * Throws on a lookup failure; the caller (assertEnrichmentWriteAllowedForAgents)
 * turns that into a fail-closed denial.
 */
export function resolveVerticalsForAgents(
  db: Database.Database,
  agentIds: readonly string[],
): EnrichmentVertical[] {
  const ids = Array.from(new Set(agentIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter((id) => id !== "")));
  if (ids.length === 0) return [DEFAULT_ENRICHMENT_VERTICAL];

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, vertical_id FROM agents WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; vertical_id: string | null }>;

  const found = new Set(rows.map((r) => r.id));
  const verticals = new Set<EnrichmentVertical>();
  for (const r of rows) verticals.add(normalizeEnrichmentVertical(r.vertical_id));
  // Unknown ids: fall back to the column's own default rather than skipping.
  if (ids.some((id) => !found.has(id))) verticals.add(DEFAULT_ENRICHMENT_VERTICAL);
  return Array.from(verticals);
}

/**
 * Batch flavour of the guard: a request touching several agents is blocked if
 * ANY vertical it spans is paused. Blocking the whole request (rather than
 * inventing a per-item "paused" outcome) is what keeps the promise the
 * dev-request actually makes — ZERO writes while a pause is live — and keeps
 * the response shape identical across all four surfaces.
 *
 * Fail-closed on any lookup failure, including the agents-table read.
 */
export function assertEnrichmentWriteAllowedForAgents(
  db: Database.Database,
  agentIds: readonly string[],
): EnrichmentWriteGuardResult {
  let verticals: EnrichmentVertical[];
  try {
    verticals = resolveVerticalsForAgents(db, agentIds);
  } catch (err) {
    console.error("[enrichment-write-pause] vertical resolution failed — failing closed:", err);
    return {
      allowed: false,
      vertical: DEFAULT_ENRICHMENT_VERTICAL,
      reason: ENRICHMENT_WRITE_PAUSE_LOOKUP_FAILED_REASON,
      triggered_at: null,
      fail_closed: true,
    };
  }
  for (const v of verticals) {
    const r = assertEnrichmentWriteAllowed(db, v);
    if (!r.allowed) return r;
  }
  return { allowed: true, vertical: verticals[0] ?? DEFAULT_ENRICHMENT_VERTICAL };
}

// ─── Route-facing adapters ─────────────────────────────────────────────────
//
// These keep each of the four wired handlers down to two added lines and one
// import, so the guard call cannot be mis-assembled at a call site.

export interface EnrichmentWritePausedBody {
  error: string;
  paused: true;
  vertical: EnrichmentVertical;
  reason: string | null;
  triggered_at: string | null;
  fail_closed: boolean;
}

/** HTTP status every paused write surface answers with. 423 Locked. */
export const ENRICHMENT_WRITE_PAUSE_HTTP_STATUS = 423;

export function enrichmentWritePausedBody(
  denial: Extract<EnrichmentWriteGuardResult, { allowed: false }>,
): EnrichmentWritePausedBody {
  return {
    error: "Berikelses-skrivepause er aktiv for denne vertikalen — ingen skriving utført.",
    paused: true,
    vertical: denial.vertical,
    reason: denial.reason,
    triggered_at: denial.triggered_at,
    fail_closed: denial.fail_closed,
  };
}

/**
 * `null` when the write may proceed; otherwise the exact 423 body to send.
 * Single-vertical surfaces (e.g. POST /admin/agents/register, which names its
 * own vertical) use this one.
 */
export function enrichmentWritePauseBlock(
  db: Database.Database,
  vertical: EnrichmentVertical,
): EnrichmentWritePausedBody | null {
  const r = assertEnrichmentWriteAllowed(db, vertical);
  return r.allowed ? null : enrichmentWritePausedBody(r);
}

/** `null` when the write may proceed; otherwise the exact 423 body to send. */
export function enrichmentWritePauseBlockForAgents(
  db: Database.Database,
  agentIds: readonly string[],
): EnrichmentWritePausedBody | null {
  const r = assertEnrichmentWriteAllowedForAgents(db, agentIds);
  return r.allowed ? null : enrichmentWritePausedBody(r);
}

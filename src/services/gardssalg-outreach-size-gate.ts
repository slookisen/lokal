// ─── Gårdssalg outreach size-gate — L1 knob + pure classifier ──────────────
//
// dev-request 2026-08-09-daglig-outreach-klargjoering-og-stoerrelsesgate,
// Skive 1. Daniel (2026-08-09, in-session): "Unngå store selskaper i
// utsendingene inntil videre." This module owns two things:
//
//   1. computeGardssalgSizeFlag — a pure classifier over antall_ansatte
//      (already stored on experience_providers, populated via the EXISTING
//      Brreg-verify integration — see applyGardssalgBrregVerified,
//      experience-store.ts). null (Brreg has no registered figure, OR
//      never verified) must NEVER classify as "liten" — it is "ukjent",
//      always, so the gate can never silently wave through an unmeasured
//      producer.
//
//   2. getGardssalgSizeGateConfig / setGardssalgSizeGateConfig — the L1
//      threshold + on/off knob, DB-backed. Krav 3 + 6 of the dev-request
//      require this to be changeable WITHOUT a deploy. The obvious analogy
//      is controller/burst-mode.yaml in the A2A control-plane repo (a
//      hand-edited YAML a routine re-reads every cycle) — but that pattern
//      does NOT transfer to this deployed Fly app: the Dockerfile COPYs
//      only src/, tsconfig.json, openapi.yaml, verticals/, mcp-server*/
//      into the image, so a new repo-tracked config/*.yaml would need a
//      rebuild + redeploy before an edit ever reached the running
//      container — the exact opposite of "uten deploy". The mechanism THIS
//      codebase already uses for a Daniel-togglable admin lever with
//      immediate, no-deploy effect is a DB-backed setting behind an
//      authenticated admin endpoint, written on the SAME Fly volume
//      (/app/data/experiences.db) every other row in this vertical already
//      lives on — see POST/GET /admin/gardssalg-booking-activation
//      (routes/opplevelser.ts, booking_live's own admin lever) for the
//      precedent this module and its sibling endpoints
//      (POST/GET /admin/gardssalg-outreach-size-gate) follow.
//
// Single-row table (id='singleton', database/init-experiences.ts). Absence
// of a row (fresh DB, never configured) is NOT an error — it falls back to
// the documented default (enabled:true, threshold:25) rather than requiring
// a seed migration.
import type Database from "better-sqlite3";

export type GardssalgSizeFlag = "stor" | "liten" | "ukjent";

// dev-request 2026-08-30-stoerrelsesgate-ukjent-uten-registrert-tall: the
// one visible rule-reason this slice adds. Surfaced alongside `size_flag`
// (never silently) the same way `large_company_excluded` is surfaced
// alongside a preflight no-go — see routes/opplevelser.ts's
// computeGardssalgReadinessRows / isGardssalgAntallAnsatteBrregConsulted.
export type GardssalgSizeFlagReason = "no_registered_figure" | null;

/**
 * Pure classifier: antall_ansatte >= threshold => "stor", < threshold =>
 * "liten". null/undefined (no registered figure on the row) splits in two:
 *
 *   - Brreg was never consulted for this row (brregConsultedNoFigure not
 *     passed / false) => "ukjent", exactly as before this slice — the
 *     original fail-safe (dev-request Skive 1, krav 5: "Gaten utelukker,
 *     den godkjenner aldri") is completely unchanged for this case.
 *   - Brreg WAS consulted (brregConsultedNoFigure: true — see
 *     isGardssalgAntallAnsatteBrregConsulted, routes/opplevelser.ts) and the
 *     register itself has no employee figure => "liten". Daniel's call,
 *     2026-08-30 (dev-request 2026-08-30-stoerrelsesgate-ukjent-uten-
 *     registrert-tall, §5.1 alternativ b): an org with no Aa-melding-derived
 *     employee count in Brreg is, in practice, a small operation — verified
 *     small producers like Ægir Bryggeri must not be stuck behind "ukjent"
 *     forever just because Brreg itself has nothing to report.
 *
 * The third parameter is OPTIONAL and additive: every pre-existing call site
 * (2-arg) keeps its exact original behavior — antallAnsatte null/undefined
 * with no third arg is still "ukjent", never "liten".
 */
export function computeGardssalgSizeFlag(
  antallAnsatte: number | null | undefined,
  threshold: number,
  brregConsultedNoFigure?: boolean,
): GardssalgSizeFlag {
  if (antallAnsatte === null || antallAnsatte === undefined) {
    return brregConsultedNoFigure ? "liten" : "ukjent";
  }
  return antallAnsatte >= threshold ? "stor" : "liten";
}

export const GARDSSALG_SIZE_GATE_DEFAULT_THRESHOLD = 25;
export const GARDSSALG_SIZE_GATE_DEFAULT_ENABLED = true;

export interface GardssalgSizeGateConfig {
  enabled: boolean;
  threshold: number;
  updated_at: string | null;
  updated_by: string | null;
  note: string | null;
  // true when no row has ever been written (the fixed default is in
  // effect) — surfaced so the admin GET can tell Daniel "nobody has moved
  // this yet" apart from "someone deliberately set it to the default".
  is_default: boolean;
}

type SizeGateConfigRow = {
  enabled: number;
  threshold: number;
  updated_at: string | null;
  updated_by: string | null;
  note: string | null;
};

/**
 * Always a fresh SELECT — deliberately NOT cached in-process, so a write
 * from any admin call (this instance or another) is visible to the very
 * next read, including one already in flight on a different route. This is
 * what makes the knob genuinely live: no restart, no redeploy, no
 * process-local cache to go stale.
 */
export function getGardssalgSizeGateConfig(expDb: Database.Database): GardssalgSizeGateConfig {
  const row = expDb
    .prepare(
      `SELECT enabled, threshold, updated_at, updated_by, note
         FROM gardssalg_outreach_size_gate_config WHERE id = 'singleton'`,
    )
    .get() as SizeGateConfigRow | undefined;
  if (!row) {
    return {
      enabled: GARDSSALG_SIZE_GATE_DEFAULT_ENABLED,
      threshold: GARDSSALG_SIZE_GATE_DEFAULT_THRESHOLD,
      updated_at: null,
      updated_by: null,
      note: null,
      is_default: true,
    };
  }
  return {
    enabled: row.enabled === 1,
    threshold: row.threshold,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    note: row.note,
    is_default: false,
  };
}

/**
 * Upsert the singleton row. Only the fields present in `patch` change —
 * same PATCH-like discipline as the rest of this vertical's admin levers
 * (e.g. gardssalg-booking-activation's `note`). Returns the config as it
 * reads back immediately after the write (never trusts the caller's patch
 * blindly — same "re-read after write" discipline as
 * applyGardssalgBookingActivation).
 */
export function setGardssalgSizeGateConfig(
  expDb: Database.Database,
  patch: { enabled?: boolean; threshold?: number; note?: string | null },
  updatedBy: string,
): GardssalgSizeGateConfig {
  const current = getGardssalgSizeGateConfig(expDb);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    threshold: patch.threshold ?? current.threshold,
    note: patch.note !== undefined ? patch.note : current.note,
  };
  expDb
    .prepare(
      `INSERT INTO gardssalg_outreach_size_gate_config (id, enabled, threshold, updated_at, updated_by, note)
       VALUES ('singleton', @enabled, @threshold, datetime('now'), @updated_by, @note)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         threshold = excluded.threshold,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         note = excluded.note`,
    )
    .run({
      enabled: next.enabled ? 1 : 0,
      threshold: next.threshold,
      updated_by: updatedBy,
      note: next.note ?? null,
    });
  return getGardssalgSizeGateConfig(expDb);
}

// ─── Admin: loop dispatcher (/fire) ─────────────────────────────
// P2.5 (server-migration plan 2026-06-20; A2A/protocols/p25-loop-dispatcher-fire).
// Deterministic, in-app replacement for the Cowork loop-dispatcher's wake mechanism.
// Reads the run-ledger, decides who to wake (pure logic in services/loop-dispatch.ts,
// ported from the Cowork SKILL), and wakes each woken agent that has a Cloud Routine
// by POSTing the routine `/fire` API — no Cowork per-wake approval prompt. Agents
// without a configured routine are left to the Cowork dispatcher (incremental P2.5
// → P3 migration). No LLM; read-only on the ledger except recording its own envelope.
//
// SHADOW-SAFE: with no routine configured (no `FIRE_ROUTINES` entry and no
// `FIRE_ROUTINE_<AGENT>_TOKEN/_TRIG` pair) OR mode != active it computes + returns the
// wake decisions but fires NOTHING — so it can deploy and run in shadow alongside the
// Cowork dispatcher for the ≥3-day parity window before cutover.
//
// Config (env, all optional until cutover):
//   FIRE_ROUTINES             JSON map  { "<agent>": { "trig": "...", "token": "..." }, ... }
//   FIRE_ROUTINE_<AGENT>_TOKEN / FIRE_ROUTINE_<AGENT>_TRIG
//                             per-routine override of one map entry, <AGENT> = the canonical
//                             agent name upper-cased with non-alphanumerics as "_" (e.g.
//                             FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN). Each routine has its own
//                             /fire token, so replacing one no longer means rebuilding the whole
//                             JSON secret (2026-10-15: experiences-enrichment 401 for 41 days).
//   DISPATCH_FIRE_MODE        "shadow" (default) | "active"   — `?mode=` query overrides
//   DISPATCH_ACTIVE_START_UTC inclusive hour, default 0  (24/7; dev-requests/2026-07-08-spine-24-7-active-window.md)
//   DISPATCH_ACTIVE_END_UTC   exclusive hour, default 24 (24/7) — set e.g. 5/21 to restore a night pause
//
// Trigger (dev-requests/2026-07-09-loop-dispatch-self-tick.md): an in-process
// setInterval in src/index.ts calls runDispatchTick("active") every ~10 min —
// the "thin cron" this header originally promised but which was never built,
// leaving every self-continue envelope to expire unfired (12-min freshness
// window vs ~4 event-wakes/day). POST /admin/loop-dispatch remains for manual
// / event-driven wakes (GitHub pushes) and is a thin wrapper over the same
// runDispatchTick(). All routes require X-Admin-Key.

import { Router, Request, Response } from "express";
import { listRecentRuns, recordRun } from "../services/run-ledger";
import {
  computeWakeList,
  fireTextFor,
  resolveActiveWindowHour,
  resolveWindowMin,
  resolveFinishedLookbackMin,
  DEFAULT_ALLOWLIST,
  type DispatchPlan,
} from "../services/loop-dispatch";
import type { RunEnvelope } from "../types/run-envelope";

const router = Router();

const FIRE_BETA = "experimental-cc-routine-2026-04-01";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
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

interface RoutineRef {
  trig: string;
  token: string;
}

/** Short keys → canonical agent names (the names that appear in next_suggested). */
const ROUTINE_ALIAS: Record<string, string> = {
  controller: "orchestrator-v3-controller",
  orchestrator: "platform-orchestrator",
  supervisor: "rfb-supervisor",
  verifier: "platform-verifier",
};

/** Non-secret-leaking parse diagnostic for the GET endpoint (NEVER includes trig/token values). */
export interface RoutineDiag {
  present: boolean;
  length: number;
  parse_ok: boolean;
  parse_error: string | null;
  raw_keys: string[];
  mapped_keys: string[];
  /** Agents whose entry came (wholly or partly) from FIRE_ROUTINE_<AGENT>_* env vars. */
  override_keys: string[];
  /** FIRE_ROUTINE_*_TOKEN/_TRIG variable NAMES that are set but were not applied (unknown agent, or no trig/token to pair with). */
  override_ignored: string[];
}

/** Env-var stem for an agent's per-routine override: "experiences-enrichment" → "EXPERIENCES_ENRICHMENT". */
export function fireRoutineEnvStem(agent: string): string {
  return agent.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Parse `FIRE_ROUTINES` (a JSON map agent → {trig, token}) into a canonical map + a
 * diagnostic. Short keys (controller/orchestrator/supervisor/verifier) are normalised to the
 * full agent names so the dispatch lookup (which keys off next_suggested) matches. Then
 * FIRE_ROUTINE_<AGENT>_TOKEN / _TRIG override single fields per agent (agents in the map or in
 * DEFAULT_ALLOWLIST); an agent missing from the map needs both to get an entry. The diag
 * exposes only presence/length/parse-state/key-NAMES — never the trig/token values.
 */
export function parseRoutines(
  env: NodeJS.ProcessEnv = process.env,
): { map: Record<string, RoutineRef>; diag: RoutineDiag } {
  const raw = env.FIRE_ROUTINES;
  const diag: RoutineDiag = {
    present: !!raw,
    length: raw ? raw.length : 0,
    parse_ok: false,
    parse_error: null,
    raw_keys: [],
    mapped_keys: [],
    override_keys: [],
    override_ignored: [],
  };
  const map: Record<string, RoutineRef> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("FIRE_ROUTINES is not a JSON object");
      }
      diag.parse_ok = true;
      for (const [agent, v] of Object.entries(parsed as Record<string, unknown>)) {
        diag.raw_keys.push(agent);
        const ref = v as { trig?: unknown; token?: unknown };
        if (ref && typeof ref.trig === "string" && typeof ref.token === "string") {
          const canonical = ROUTINE_ALIAS[agent] || agent;
          map[canonical] = { trig: ref.trig, token: ref.token };
        }
      }
    } catch (err: any) {
      diag.parse_error = String(err?.message || err).slice(0, 120);
    }
  }
  const candidates = new Set([...Object.keys(map), ...DEFAULT_ALLOWLIST]);
  const usedOverrideVars = new Set<string>();
  for (const agent of candidates) {
    const stem = fireRoutineEnvStem(agent);
    const tokenVar = `FIRE_ROUTINE_${stem}_TOKEN`;
    const trigVar = `FIRE_ROUTINE_${stem}_TRIG`;
    const token = (env[tokenVar] || "").trim();
    const trig = (env[trigVar] || "").trim();
    if (!token && !trig) continue;
    const merged = { trig: trig || map[agent]?.trig || "", token: token || map[agent]?.token || "" };
    if (merged.trig && merged.token) {
      map[agent] = merged;
      diag.override_keys.push(agent);
      if (token) usedOverrideVars.add(tokenVar);
      if (trig) usedOverrideVars.add(trigVar);
    }
  }
  // A misspelt, unknown-agent or half-set override would otherwise be silently ignored —
  // the very failure mode this override exists to make visible. Names only, never values.
  diag.override_ignored = Object.keys(env)
    .filter((k) => /^FIRE_ROUTINE_.+_(TOKEN|TRIG)$/.test(k) && (env[k] || "").trim() !== "" && !usedOverrideVars.has(k))
    .sort();
  diag.mapped_keys = Object.keys(map);
  return { map, diag };
}

/**
 * Envelope status for one dispatch tick. A failed /fire must not read as a clean run:
 * experiences-enrichment got HTTP 401 ("Token is not authorized for this routine") 158
 * times over 41 days (2026-09-04 → 2026-10-15) while every envelope said "completed",
 * so no tier that counts non-completed runs ever saw it.
 */
export function dispatchEnvelopeStatus(fired: ReadonlyArray<{ ok: boolean }>): "completed" | "partial" | "failed" {
  const failedCount = fired.filter((f) => !f.ok).length;
  if (failedCount === 0) return "completed";
  return failedCount < fired.length ? "partial" : "failed";
}

async function fireRoutine(
  ref: RoutineRef,
  text: string,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  try {
    const r = await fetch(
      `https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(ref.trig)}/fire`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ref.token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": FIRE_BETA,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      },
    );
    return {
      ok: r.ok,
      status: r.status,
      detail: r.ok ? undefined : (await r.text().catch(() => "")).slice(0, 200),
    };
  } catch (err: any) {
    return { ok: false, status: 0, detail: String(err?.message || err).slice(0, 200) };
  }
}

export function planNow(): DispatchPlan {
  // dev-requests/2026-07-08-spine-24-7-active-window.md: default 0/24 (24/7) so the
  // spine fires whenever there's fresh next_suggested work, day or night. computeWakeList's
  // own internal defaults (5/21) stay untouched for other callers/tests; only this route's
  // call now sends explicit window bounds, overridable via env without a code revert.
  const activeStartUTC = resolveActiveWindowHour(process.env.DISPATCH_ACTIVE_START_UTC, 0);
  const activeEndUTC = resolveActiveWindowHour(process.env.DISPATCH_ACTIVE_END_UTC, 24);
  // dev-requests/2026-07-17-loop-dispatch-stall-hardening.md: 45-min freshness window
  // (survives the 25-min cross-agent cooldown + gives failed /fire calls retries on
  // later ticks) + fireable set so routine-less wakes don't consume the maxWakes
  // budget. Same env-knob pattern as the active window: pure default stays 12,
  // DISPATCH_WINDOW_MIN restores the old behavior without a code revert.
  const windowMin = resolveWindowMin(process.env.DISPATCH_WINDOW_MIN);
  // computeWakeList's freshness is finished_at-based, but listRecentRuns filters on
  // started_at: a run that started >1h ago and finished recently was invisible, so its
  // next_suggested never fired. finishedSinceMinutes adds `OR finished_at >= now-N`.
  // DISPATCH_PLAN_FINISHED_LOOKBACK_MIN=0 turns it off (rollback without deploy).
  const finishedSinceMinutes = resolveFinishedLookbackMin(
    process.env.DISPATCH_PLAN_FINISHED_LOOKBACK_MIN,
    windowMin,
  );
  const runs = listRecentRuns({ sinceHours: 1, finishedSinceMinutes, limit: 500 });
  const { map: routines } = parseRoutines();
  return computeWakeList(
    runs.map((r) => ({
      run_id: r.run_id,
      agent: r.agent,
      started_at: r.started_at,
      finished_at: r.finished_at,
      next_suggested: r.next_suggested ?? null,
    })),
    {
      nowMs: Date.now(),
      allowlist: DEFAULT_ALLOWLIST,
      activeStartUTC,
      activeEndUTC,
      windowMin,
      fireable: Object.keys(routines),
    },
  );
}

/** One fired-wake attempt (routine /fire call outcome). */
export interface DispatchFired {
  agent: string;
  reason: string;
  ok: boolean;
  status: number;
  detail?: string;
}

/** A planned wake that was NOT fired (shadow mode / no routine configured). */
export interface DispatchDeferred {
  agent: string;
  reason: string;
  why: string;
}

/** Result of one dispatch tick — exactly the POST route's response body minus `success`. */
export interface DispatchTickResult extends DispatchPlan {
  mode: "shadow" | "active";
  routines: string[];
  fire_routines: RoutineDiag;
  fired: DispatchFired[];
  deferred: DispatchDeferred[];
  envelope_run_id: string;
}

/**
 * One dispatch tick: plan the wake-list from the run-ledger, fire each woken
 * agent's Cloud Routine (active mode + a configured routine only), record fire-markers
 * for successful fires, and record a loop-dispatcher envelope IF anything fired.
 *
 * Extracted verbatim from the POST handler (dev-requests/2026-07-09-loop-dispatch-
 * self-tick.md) so the in-process self-tick in src/index.ts and the HTTP route
 * share one implementation. Behavior-preserving: this is the fleet's production
 * wake path. Throws on unexpected errors — callers decide (route → 500 JSON,
 * self-tick → log and keep the server alive).
 */
export async function runDispatchTick(mode: "shadow" | "active"): Promise<DispatchTickResult> {
  const startedAt = new Date().toISOString();
  const plan = planNow();
  const { map: routines, diag: routineDiag } = parseRoutines();

  const fired: DispatchFired[] = [];
  const deferred: DispatchDeferred[] = [];

  for (const w of plan.wake) {
    const ref = routines[w.agent];
    if (!ref) {
      deferred.push({ agent: w.agent, reason: w.reason, why: "no routine configured (Cowork path)" });
      continue;
    }
    if (mode !== "active") {
      deferred.push({ agent: w.agent, reason: w.reason, why: "shadow mode" });
      continue;
    }
    // Neutral wake metadata only (no grants/instructions) — see fireTextFor() in services/loop-dispatch.ts.
    const text = fireTextFor(w.agent, w.reason);
    const r = await fireRoutine(ref, text);
    fired.push({ agent: w.agent, reason: w.reason, ...r });

    // Fire-marker (dedup boot-lag race, dev-requests/2026-07-08-loop-dispatch-fire-marker-dedup.md):
    // a woken Cloud Routine takes 30-90s to boot before it POSTs its own started_at
    // envelope, during which a second dispatch (another /admin/loop-dispatch call,
    // e.g. an overlapping cron + wake-workflow) sees no fresh run for this agent in
    // the ledger and fires it again. Record a marker at fire-time — not boot-time —
    // so computeWakeList's existing cooldown (latest[agent] = finished_at||started_at)
    // sees this agent as "just ran" immediately, closing the race window to ~0.
    // next_suggested MUST stay [] so the marker never becomes a wake candidate itself.
    if (r.ok) {
      const markerAt = new Date().toISOString();
      try {
        recordRun({
          run_id: `firemarker-${markerAt.replace(/[:.]/g, "-")}-${w.agent}`,
          vertical: "rfb",
          agent: w.agent,
          trigger_source: "signal",
          started_at: markerAt,
          finished_at: markerAt,
          status: "completed",
          claims: [],
          evidence: [],
          next_suggested: [],
          notes:
            "loop-dispatch fire-marker (dedup boot-lag) — see dev-requests/2026-07-08-loop-dispatch-fire-marker-dedup.md",
        });
      } catch {
        /* best-effort — the fire already happened; a missing marker just re-opens the boot-lag window */
      }
    }
  }

  const firedOk = fired.filter((f) => f.ok).length;
  const firedFailed = fired.filter((f) => !f.ok);
  // Fire-failure visibility (dev-requests/2026-07-17-loop-dispatch-stall-hardening.md):
  // the 2026-07-17 09:40Z outage — /fire returning 401 authentication_error on an
  // expired FIRE_ROUTINES token — was invisible in the ledger (`fired_ok=0` with no
  // status/detail), so the fleet sat idle for hours before a live session diagnosed
  // it. Surface each failure's HTTP status + truncated detail in the envelope so the
  // controller/supervisor/daily-brief can see WHY wakes are failing. The detail is
  // the /fire response body (never the token).
  const failNote = firedFailed.length
    ? ` FIRE-FAILURES: ${firedFailed
        .map((f) => `${f.agent}=HTTP${f.status}${f.detail ? ` ${f.detail.slice(0, 100)}` : ""}`)
        .join("; ")}`
    : "";
  const finishedAt = new Date().toISOString();
  const envelope: RunEnvelope = {
    run_id: `run-${finishedAt.replace(/[:.]/g, "-")}-loop-dispatcher-fly`,
    vertical: "rfb",
    agent: "loop-dispatcher",
    trigger_source: "cron",
    started_at: startedAt,
    finished_at: finishedAt,
    status: dispatchEnvelopeStatus(fired),
    claims: [
      {
        type: "db_state_change",
        value: firedOk,
        meta: { kind: "wakes_fired", mode, source: "fly", wake_planned: plan.wake.length },
      },
      ...(firedFailed.length
        ? [
            {
              type: "db_state_change" as const,
              value: firedFailed.length,
              meta: {
                kind: "wakes_failed",
                statuses: firedFailed.map((f) => ({ agent: f.agent, status: f.status })),
              },
            },
          ]
        : []),
    ],
    evidence: [],
    next_suggested: [], // the dispatcher MUST NOT emit next_suggested (no ping-pong)
    notes:
      `mode=${mode} candidates=${plan.candidates} wake=${plan.wake.length} fired_ok=${firedOk} deferred=${deferred.length}${plan.inActiveWindow ? "" : " (paused: outside active window)"}${failNote}`.slice(
        0,
        480,
      ),
  };
  // Only record an envelope when we actually fired (or attempted) a wake. A no-op
  // dispatch — the common ~10-min heartbeat that wakes nobody — must NOT flood the
  // run-ledger (L4 fix 2026-06-27: 115/120 recent ledger runs were dispatcher
  // heartbeats, drowning real agent runs and killing loop visibility).
  if (fired.length > 0) {
    try {
      recordRun(envelope);
    } catch {
      /* best-effort — the dispatch already happened */
    }
  }

  return {
    mode,
    ...plan,
    routines: Object.keys(routines),
    fire_routines: routineDiag,
    fired,
    deferred,
    envelope_run_id: envelope.run_id,
  };
}

// POST /admin/loop-dispatch?mode=shadow|active
//   Decides the wake-list; in active mode (and with a routine configured) POSTs /fire
//   to each woken agent that has a routine. Records a loop-dispatcher envelope when
//   anything fired. Thin wrapper over runDispatchTick() — same body the self-tick runs.
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const envMode = (process.env.DISPATCH_FIRE_MODE || "shadow").toLowerCase();
    const mode =
      String(req.query.mode || envMode).toLowerCase() === "active" ? "active" : "shadow";
    const result = await runDispatchTick(mode);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// GET /admin/loop-dispatch — read-only DECISION preview (never fires, records nothing)
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { map, diag } = parseRoutines();
    res.json({ success: true, mode: "preview", ...planNow(), routines: Object.keys(map), fire_routines: diag });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;

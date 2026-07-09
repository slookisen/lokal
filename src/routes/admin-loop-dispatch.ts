// ─── Admin: loop dispatcher (/fire) ─────────────────────────────
// P2.5 (server-migration plan 2026-06-20; A2A/protocols/p25-loop-dispatcher-fire).
// Deterministic, in-app replacement for the Cowork loop-dispatcher's wake mechanism.
// Reads the run-ledger, decides who to wake (pure logic in services/loop-dispatch.ts,
// ported from the Cowork SKILL), and wakes each woken agent that has a Cloud Routine
// by POSTing the routine `/fire` API — no Cowork per-wake approval prompt. Agents
// without a configured routine are left to the Cowork dispatcher (incremental P2.5
// → P3 migration). No LLM; read-only on the ledger except recording its own envelope.
//
// SHADOW-SAFE: with `FIRE_ROUTINES` unset OR mode != active it computes + returns the
// wake decisions but fires NOTHING — so it can deploy and run in shadow alongside the
// Cowork dispatcher for the ≥3-day parity window before cutover.
//
// Config (env, all optional until cutover):
//   FIRE_ROUTINES             JSON map  { "<agent>": { "trig": "...", "token": "..." }, ... }
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
  resolveActiveWindowHour,
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
}

/**
 * Parse `FIRE_ROUTINES` (a JSON map agent → {trig, token}) into a canonical map + a
 * diagnostic. Short keys (controller/orchestrator/supervisor/verifier) are normalised to the
 * full agent names so the dispatch lookup (which keys off next_suggested) matches. The diag
 * exposes only presence/length/parse-state/key-NAMES — never the trig/token values.
 */
function parseRoutines(): { map: Record<string, RoutineRef>; diag: RoutineDiag } {
  const raw = process.env.FIRE_ROUTINES;
  const diag: RoutineDiag = {
    present: !!raw,
    length: raw ? raw.length : 0,
    parse_ok: false,
    parse_error: null,
    raw_keys: [],
    mapped_keys: [],
  };
  const map: Record<string, RoutineRef> = {};
  if (!raw) return { map, diag };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
    diag.parse_ok = true;
  } catch (err: any) {
    diag.parse_error = String(err?.message || err).slice(0, 120);
    return { map, diag };
  }
  for (const [agent, v] of Object.entries(parsed)) {
    diag.raw_keys.push(agent);
    const ref = v as { trig?: unknown; token?: unknown };
    if (ref && typeof ref.trig === "string" && typeof ref.token === "string") {
      const canonical = ROUTINE_ALIAS[agent] || agent;
      map[canonical] = { trig: ref.trig, token: ref.token };
    }
  }
  diag.mapped_keys = Object.keys(map);
  return { map, diag };
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

function planNow(): DispatchPlan {
  const runs = listRecentRuns({ sinceHours: 1, limit: 500 });
  // dev-requests/2026-07-08-spine-24-7-active-window.md: default 0/24 (24/7) so the
  // spine fires whenever there's fresh next_suggested work, day or night. computeWakeList's
  // own internal defaults (5/21) stay untouched for other callers/tests; only this route's
  // call now sends explicit window bounds, overridable via env without a code revert.
  const activeStartUTC = resolveActiveWindowHour(process.env.DISPATCH_ACTIVE_START_UTC, 0);
  const activeEndUTC = resolveActiveWindowHour(process.env.DISPATCH_ACTIVE_END_UTC, 24);
  return computeWakeList(
    runs.map((r) => ({
      run_id: r.run_id,
      agent: r.agent,
      started_at: r.started_at,
      finished_at: r.finished_at,
      next_suggested: r.next_suggested ?? null,
    })),
    { nowMs: Date.now(), allowlist: DEFAULT_ALLOWLIST, activeStartUTC, activeEndUTC },
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
 * agent's Cloud Routine (active mode + FIRE_ROUTINES only), record fire-markers
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
    // Fire-text mirrors charter Rule 0 (bygg først) — dev-requests/2026-07-09-loop-
    // dispatch-self-tick.md item 3: off-cycle wakes exist to CONTINUE BUILDING, not
    // to re-run housekeeping; the old "Run your FULL normal cycle" wording contradicted
    // build-first and burned each wake on reports.
    const text = `Off-cycle wake by loop-dispatcher (${w.reason}; next_suggested=${w.agent}). Prioritize BUILDING dev-request slices first (charter Rule 0 — bygg først); housekeeping and full reports belong to the daily cycle only. Still POST your run-envelope to /admin/runs at the end so this wake is visible in the run-ledger. One-time run.`;
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
  const finishedAt = new Date().toISOString();
  const envelope: RunEnvelope = {
    run_id: `run-${finishedAt.replace(/[:.]/g, "-")}-loop-dispatcher-fly`,
    vertical: "rfb",
    agent: "loop-dispatcher",
    trigger_source: "cron",
    started_at: startedAt,
    finished_at: finishedAt,
    status: "completed",
    claims: [
      {
        type: "db_state_change",
        value: firedOk,
        meta: { kind: "wakes_fired", mode, source: "fly", wake_planned: plan.wake.length },
      },
    ],
    evidence: [],
    next_suggested: [], // the dispatcher MUST NOT emit next_suggested (no ping-pong)
    notes: `mode=${mode} candidates=${plan.candidates} wake=${plan.wake.length} fired_ok=${firedOk} deferred=${deferred.length}${plan.inActiveWindow ? "" : " (paused: outside active window)"}`.slice(0, 480),
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
//   Decides the wake-list; in active mode (and with FIRE_ROUTINES set) POSTs /fire
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

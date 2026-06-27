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
//   FIRE_ROUTINES      JSON map  { "<agent>": { "trig": "...", "token": "..." }, ... }
//   DISPATCH_FIRE_MODE "shadow" (default) | "active"   — `?mode=` query overrides
//
// Intended trigger: a thin Fly Machine cron that POSTs this endpoint every ~10 min
// during active hours (same spine as admin-loop-heartbeat / admin-run-verifier).
// All routes require X-Admin-Key.

import { Router, Request, Response } from "express";
import { listRecentRuns, recordRun } from "../services/run-ledger";
import {
  computeWakeList,
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
interface RoutineDiag {
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
  return computeWakeList(
    runs.map((r) => ({
      run_id: r.run_id,
      agent: r.agent,
      started_at: r.started_at,
      finished_at: r.finished_at,
      next_suggested: r.next_suggested ?? null,
    })),
    { nowMs: Date.now(), allowlist: DEFAULT_ALLOWLIST },
  );
}

// POST /admin/loop-dispatch?mode=shadow|active
//   Decides the wake-list; in active mode (and with FIRE_ROUTINES set) POSTs /fire
//   to each woken agent that has a routine. Always records a loop-dispatcher envelope.
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const startedAt = new Date().toISOString();
  try {
    const plan = planNow();
    const { map: routines, diag: routineDiag } = parseRoutines();
    const envMode = (process.env.DISPATCH_FIRE_MODE || "shadow").toLowerCase();
    const mode =
      String(req.query.mode || envMode).toLowerCase() === "active" ? "active" : "shadow";

    const fired: Array<{
      agent: string;
      reason: string;
      ok: boolean;
      status: number;
      detail?: string;
    }> = [];
    const deferred: Array<{ agent: string; reason: string; why: string }> = [];

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
      const text = `Off-cycle wake by loop-dispatcher (${w.reason}; next_suggested=${w.agent}). Run your FULL normal cycle exactly as a scheduled run would: complete every step, write your usual end-of-run report, and POST your run-envelope to /admin/runs at the end so this wake is visible in the run-ledger. One-time run.`;
      const r = await fireRoutine(ref, text);
      fired.push({ agent: w.agent, reason: w.reason, ...r });
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

    res.json({
      success: true,
      mode,
      ...plan,
      routines: Object.keys(routines),
      fire_routines: routineDiag,
      fired,
      deferred,
      envelope_run_id: envelope.run_id,
    });
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

// ─── Admin: POST /admin/owner-features/switch-probe ─────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2d-3: the switch
// probe («bryterprobe») as reviewed server code. Runs in-process against the
// hidden test producer (owner-features/switch-probe.ts): every `live` switch
// off and on through the owner write path, every surface observed (as-public
// for the visibility surfaces), the change log checked, everything restored.
//
// Gates, in order:
//   flag   OWNER_FEATURES_SWITCH_PROBE_ENABLED === "1" (default off → 404,
//          nothing read)
//   admin  the same X-Admin-Key check as the sibling admin routes (copied, not
//          shared — routes/admin-test-producer.ts): unset → 503, wrong → 403
//   target only the fixture row (origin='test_fixture' AND catalog_hidden=1)
//          in OWNER_FEATURES_ALLOWED_SUBJECTS; optional body `agent_id` must be
//          that row. Anything else → 404/409 and no write.
// Body { dry_run?: boolean (default true), agent_id?: string, max_wait_ms?: number }
//   dry_run true (DEFAULT) → the plan (keys × surfaces × directions, starting
//   values, env flags), zero writes. Only an explicit `false` runs it.
// A second run while one is going → 409 already_running.
// Response: { ok, dry_run, agent_id, started_at, finished_at, rows, checks,
// pass, fail, restored, restore_diff, env_flags, ready_for_daniel_test,
// markdown } (+ plan on a dry run). No e-mail is ever sent.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  SwitchProbeBusyError,
  dryRunSwitchProbe,
  isSwitchProbeRunning,
  runSwitchProbe,
  selectSwitchProbeFixture,
} from "../owner-features/switch-probe";

const router = Router();

export const SWITCH_PROBE_FLAG = "OWNER_FEATURES_SWITCH_PROBE_ENABLED";

export function switchProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SWITCH_PROBE_FLAG] === "1";
}

// Copied (not shared) — same convention as every sibling admin route.
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

router.post("/", async (req: Request, res: Response) => {
  if (!switchProbeEnabled()) return res.status(404).json({ success: false, error: "not_found" });
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { dry_run?: unknown; agent_id?: unknown; max_wait_ms?: unknown };
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return res.status(400).json({ ok: false, error: "dry_run må være true eller false" });
    }
    if (body.agent_id !== undefined && (typeof body.agent_id !== "string" || !body.agent_id.trim())) {
      return res.status(400).json({ ok: false, error: "agent_id må være en ikke-tom streng" });
    }
    if (body.max_wait_ms !== undefined && (typeof body.max_wait_ms !== "number" || !Number.isFinite(body.max_wait_ms) || body.max_wait_ms < 0)) {
      return res.status(400).json({ ok: false, error: "max_wait_ms må være et tall ≥ 0" });
    }
    const dryRun = body.dry_run !== false;
    const db = getDb();
    const sel = selectSwitchProbeFixture(db, typeof body.agent_id === "string" ? body.agent_id.trim() : undefined);
    if (!sel.ok) {
      return res.status(sel.status).json({ ok: false, dry_run: dryRun, error: sel.error, detail: sel.detail, ...(sel.ids ? { ids: sel.ids } : {}) });
    }
    if (dryRun) return res.json(dryRunSwitchProbe(sel.agentId, { db }));
    if (isSwitchProbeRunning()) return res.status(409).json({ ok: false, dry_run: false, error: "already_running" });
    const out = await runSwitchProbe(sel.agentId, { db, maxWaitMs: body.max_wait_ms as number | undefined });
    console.log(`[switch-probe] agent=${sel.agentId} pass=${out.pass} fail=${out.fail} restored=${out.restored}${out.error ? " aborted" : ""}`);
    return res.status(out.ok ? 200 : 500).json(out);
  } catch (e: any) {
    if (e instanceof SwitchProbeBusyError) return res.status(409).json({ ok: false, dry_run: false, error: "already_running" });
    console.error("[switch-probe] failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;

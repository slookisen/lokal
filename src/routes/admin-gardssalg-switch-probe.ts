// ─── Admin: POST /admin/gardssalg/owner-features/switch-probe ───────────────
// dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, slice O2b: the
// Opplevagent «Mine valg» switch probe («bryterprobe») as reviewed server
// code, the same pattern as the RFB probe (routes/admin-owner-features-
// switch-probe.ts). Runs in-process against the hidden gårdssalg test
// producer (owner-features/gardssalg-switch-probe.ts): every `live` entry
// off and on through the owner write path, every gårdssalg surface observed
// (as-public for the public reads, the booking channels outside the view
// with a slot in the past), the change log checked, everything restored.
//
// Gates, in order:
//   flag   OA_OWNER_FEATURES_SWITCH_PROBE_ENABLED === "1" (default off → 404,
//          nothing read)
//   admin  the same X-Admin-Key check as the sibling admin routes (copied, not
//          shared): unset → 503, wrong → 403
//   target only the gårdssalg test producer (is_test_provider = 1, org_nr
//          TEST000000, hidden as test_fixture / owner_pause), with
//          OA_OWNER_FEATURES_ENABLED on and `gardssalg:<id>` in
//          OWNER_FEATURES_ALLOWED_SUBJECTS; optional body `provider_id` must be
//          that row. Anything else → 404/409 and no write.
// Body { dry_run?: boolean (default true), provider_id?: string, max_wait_ms?: number }
//   dry_run true (DEFAULT) → the plan, zero writes. Only an explicit `false` runs it.
// A second run while one is going → 409 already_running.
// Response: { ok, dry_run, provider_id, started_at, finished_at, env_flags,
// allowlisted, rows, checks, pass, fail, not_observable, restored,
// restore_diff, side_effects, ready_for_daniel_test, markdown } (+ plan on a
// dry run). No e-mail is ever sent and no visit request is ever created.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import {
  GardssalgSwitchProbeBusyError,
  dryRunGardssalgSwitchProbe,
  isGardssalgSwitchProbeRunning,
  runGardssalgSwitchProbe,
  selectGardssalgSwitchProbeFixture,
} from "../owner-features/gardssalg-switch-probe";

const router = Router();

export const GARDSSALG_SWITCH_PROBE_FLAG = "OA_OWNER_FEATURES_SWITCH_PROBE_ENABLED";

export function gardssalgSwitchProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GARDSSALG_SWITCH_PROBE_FLAG] === "1";
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
  if (!gardssalgSwitchProbeEnabled()) return res.status(404).json({ success: false, error: "not_found" });
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { dry_run?: unknown; provider_id?: unknown; max_wait_ms?: unknown };
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return res.status(400).json({ ok: false, error: "dry_run må være true eller false" });
    }
    if (body.provider_id !== undefined && (typeof body.provider_id !== "string" || !body.provider_id.trim())) {
      return res.status(400).json({ ok: false, error: "provider_id må være en ikke-tom streng" });
    }
    if (body.max_wait_ms !== undefined && (typeof body.max_wait_ms !== "number" || !Number.isFinite(body.max_wait_ms) || body.max_wait_ms < 0)) {
      return res.status(400).json({ ok: false, error: "max_wait_ms må være et tall ≥ 0" });
    }
    const dryRun = body.dry_run !== false;
    const expDb = getVerticalDb("experiences");
    const sel = selectGardssalgSwitchProbeFixture(expDb, typeof body.provider_id === "string" ? body.provider_id.trim() : undefined);
    if (!sel.ok) {
      return res.status(sel.status).json({ ok: false, dry_run: dryRun, error: sel.error, detail: sel.detail, ...(sel.ids ? { ids: sel.ids } : {}) });
    }
    const db = getDb();
    if (dryRun) return res.json(dryRunGardssalgSwitchProbe(sel.providerId, { db, expDb }));
    if (isGardssalgSwitchProbeRunning()) return res.status(409).json({ ok: false, dry_run: false, error: "already_running" });
    const out = await runGardssalgSwitchProbe(sel.providerId, { db, expDb, maxWaitMs: body.max_wait_ms as number | undefined });
    console.log(`[gardssalg-switch-probe] provider=${sel.providerId} pass=${out.pass} fail=${out.fail} not_observable=${out.not_observable} restored=${out.restored}${out.error ? " aborted" : ""}`);
    return res.status(out.ok ? 200 : 500).json(out);
  } catch (e: any) {
    if (e instanceof GardssalgSwitchProbeBusyError) return res.status(409).json({ ok: false, dry_run: false, error: "already_running" });
    console.error("[gardssalg-switch-probe] failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;

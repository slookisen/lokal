// ─── Admin: GET/POST /admin/enrichment-write-pause ──────────────────────────
//
// dev-request 2026-08-20-enrichment-write-pause-mekanisk-gjerde (L3, P1).
//
// The read/write surface for the per-vertical enrichment write-pause that
// services/enrichment-write-pause.ts enforces on every enrichment write
// surface. Until this landed, the pause existed ONLY as prose in a SKILL file:
// on 2026-08-20 `lokal-agent-enrichment` wrote to prod for a whole cycle while
// an RFB pause was in force (5 producers registered, ~8 agents enriched in
// violation, one of them outside the target list). Nothing could have stopped
// it, because nothing was checking. This endpoint is where the state now lives
// so that a check is possible at all.
//
// ── The asymmetry is enforced HERE, on the wire ─────────────────────────────
// Setting the pause needs a `reason`. CLEARING it needs an explicit
// `cleared_by`, with no default and no fallback — a clear that does not name
// who cleared it is REJECTED with 400, never silently attributed to "admin".
// The clearing SEMANTICS themselves are unchanged by this dev-request (the
// verifier sets, only Daniel lifts); this route just refuses to let the
// attribution be implicit.
//
// ── Auth ────────────────────────────────────────────────────────────────────
// X-Admin-Key, via a LOCAL requireAdmin helper. Every sibling admin route file
// in this directory defines its own copy rather than importing a shared one
// (admin-agents-url-write.ts, admin-agents-contact-email-write.ts, …); this
// file follows that convention exactly rather than introducing a new shared
// module in a P1 hotfix.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  ENRICHMENT_VERTICALS,
  EnrichmentWritePauseError,
  getEnrichmentWritePause,
  isEnrichmentVertical,
  setEnrichmentWritePause,
  type EnrichmentVertical,
} from "../services/enrichment-write-pause";

const router = Router();

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

/**
 * DB seam — same indirection the sibling write routes use, so a test can point
 * ITS OWN calls at an in-memory database without pinning the shared getDb()
 * singleton (pinning it races any block that reads getDb() across an await —
 * the concrete cause of PR #444's determinism-gate failure). Production never
 * calls the setter.
 */
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setEnrichmentWritePauseDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

/**
 * Strict vertical parsing for the ADMIN surface. Unlike the guard — which
 * coerces an unknown value to 'rfb' so nothing can slip past a live pause —
 * this endpoint REJECTS an unrecognised vertical, because silently pausing
 * (or, far worse, silently clearing) the wrong vertical on a typo is exactly
 * the class of accident this whole dev-request is about.
 */
function parseVertical(raw: unknown, fallback: EnrichmentVertical | null): EnrichmentVertical | null {
  // Trim BEFORE the emptiness test, so `vertical: "   "` cannot take a
  // different path from `vertical: ""` — both are "absent".
  const v = typeof raw === "string" ? raw.trim() : raw;
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string") return null;
  return isEnrichmentVertical(v) ? v : null;
}

const VERTICAL_ERROR = `vertical må være en av: ${ENRICHMENT_VERTICALS.join(", ")}`;

/**
 * POST is stricter than GET: `vertical` is REQUIRED there, and an absent or
 * empty one is a 400 rather than a silent default to 'rfb'.
 *
 * This file's whole stance is that an unrecognised vertical must never resolve
 * to a real one on a WRITE — a typo'd vertical is already rejected for exactly
 * that reason. Defaulting an absent/empty one to 'rfb' contradicted that on
 * the call where it matters most, a CLEAR: `{enabled:false, cleared_by:"…"}`
 * with no vertical would have lifted the live RFB pause without the caller
 * ever naming RFB. GET keeps its default — it is a read, and reading the wrong
 * vertical costs nothing. PR review finding 4, 2026-08-20.
 */
const VERTICAL_REQUIRED_ERROR =
  `vertical er påkrevd på POST og må være en av: ${ENRICHMENT_VERTICALS.join(", ")}` +
  ` — den defaultes aldri på en skriving (verken PÅ eller AV)`;

// ─── GET /admin/enrichment-write-pause?vertical=rfb ─────────────────────────
// Read-only status. `vertical` defaults to 'rfb'. An unknown vertical is a 400,
// not a silent "not paused".
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const vertical = parseVertical(req.query?.vertical, "rfb");
  if (!vertical) {
    res.status(400).json({ error: VERTICAL_ERROR });
    return;
  }

  try {
    const status = getEnrichmentWritePause(resolveDb(), vertical);
    res.json({ success: true, status });
  } catch (err) {
    // Deliberately a 500, NOT a synthesized "not paused". A read that cannot
    // answer must not look like an answer of "go ahead" — the write guard
    // itself fails closed for exactly the same reason.
    console.error("[enrichment-write-pause] status read failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /admin/enrichment-write-pause ─────────────────────────────────────
// Body: { vertical, enabled, reason?, triggered_by?, cleared_by? }
//   vertical: REQUIRED (unlike GET's default) — a write never defaults it.
//   enabled: true  → reason required. triggered_by optional (defaults 'admin').
//   enabled: false → cleared_by REQUIRED. No default, ever.
router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as {
    vertical?: unknown;
    enabled?: unknown;
    reason?: unknown;
    triggered_by?: unknown;
    cleared_by?: unknown;
  };

  // No fallback on POST — see VERTICAL_REQUIRED_ERROR. An absent, empty or
  // unrecognised vertical is a 400; it is never assumed to be 'rfb'.
  const vertical = parseVertical(body.vertical, null);
  if (!vertical) {
    res.status(400).json({
      error:
        body.vertical === undefined || body.vertical === null || (typeof body.vertical === "string" && body.vertical.trim() === "")
          ? VERTICAL_REQUIRED_ERROR
          : VERTICAL_ERROR,
    });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled må være en boolean (true = pause på, false = opphev)" });
    return;
  }
  for (const field of ["reason", "triggered_by", "cleared_by"] as const) {
    const v = body[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      res.status(400).json({ error: `${field} må være en streng` });
      return;
    }
  }

  try {
    const status = setEnrichmentWritePause(
      resolveDb(),
      {
        vertical,
        enabled: body.enabled,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : null,
        triggered_by: typeof body.triggered_by === "string" ? body.triggered_by.slice(0, 200) : null,
        cleared_by: typeof body.cleared_by === "string" ? body.cleared_by.slice(0, 200) : null,
      },
      "admin",
    );
    res.json({ success: true, status });
  } catch (err) {
    if (err instanceof EnrichmentWritePauseError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[enrichment-write-pause] write failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;

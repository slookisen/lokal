// ─── GET /admin/agents/:id/owner-milestone-preview ──────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-5: admin-only preview
// of the milestone owner e-mail (services/owner-milestone-email.ts), so
// Daniel can read the first edition before anything that sends is built.
//
//   GET /admin/agents/:id/owner-milestone-preview?milestone=100|500|1000&format=json|html|text
//     milestone  which template to render. Default: the highest milestone the
//                profile has reached. 400 when not 100, 500 or 1000.
//     format     default json (subject, text, html, views, would_send); html
//                serves the e-mail body as a page; text the plain part.
//   403 without X-Admin-Key, 404 unknown agent. No milestone given and none
//   reached yet → 404 with `milestone: null` and the view count (pass
//   ?milestone= to see the template anyway).
//
// Read only: no INSERT/UPDATE/DELETE, no e-mail, no page-view row (/admin/ is
// in the analytics skipPaths). There is no job, no flag and no sending path;
// `would_send` is information only. The only public route is the e-mail's
// unsubscribe (/milepael-avmeld/:token, routes/rapport-avmeld.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  buildOwnerMilestonePreview,
  parseOwnerMilestone,
  OWNER_MILESTONES,
  OWNER_MILESTONE_UNSUB_PATH,
} from "../services/owner-milestone-email";

// Injectable DB seam (tests only), same convention as admin-owner-report-preview.ts.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setOwnerMilestonePreviewDbForTesting(db: ReturnType<typeof getDb> | null): void {
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
  if (((req.headers["x-admin-key"] as string) || "") !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

const FORMATS = ["json", "html", "text"] as const;
type Format = (typeof FORMATS)[number];

// Mounted at "/admin/agents/:id/owner-milestone-preview" (mergeParams), so the route is "/".
const router = Router({ mergeParams: true });

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!id || id.length > 200) {
    res.status(400).json({ error: "invalid agent id" });
    return;
  }
  const rawFormat = req.query.format === undefined ? "json" : String(req.query.format);
  if (!(FORMATS as readonly string[]).includes(rawFormat)) {
    res.status(400).json({ error: "invalid format", allowed: FORMATS });
    return;
  }
  const format = rawFormat as Format;
  let milestone: ReturnType<typeof parseOwnerMilestone> = null;
  if (req.query.milestone !== undefined) {
    milestone = parseOwnerMilestone(req.query.milestone);
    if (milestone === null) {
      res.status(400).json({ error: "invalid milestone", allowed: OWNER_MILESTONES });
      return;
    }
  }

  let p: ReturnType<typeof buildOwnerMilestonePreview>;
  try {
    p = buildOwnerMilestonePreview(resolveDb(), id, { milestone, nowMs: Date.now() });
  } catch (err) {
    console.error("[owner-milestone-preview] build failed:", err instanceof Error ? err.message : "error");
    res.status(500).json({ error: "owner milestone preview failed" });
    return;
  }
  if (!p) {
    res.status(404).json({ error: "Agent not found", agent_id: id });
    return;
  }
  const views = {
    total: p.totalViews?.value ?? null,
    counted_from: p.totalViews ? (p.totalViews.countedFrom ?? null) : null,
    reached_milestone: p.reachedMilestone,
    next_milestone: p.nextMilestone,
  };
  if (p.milestone === null || !p.email) {
    res.status(404).json({
      error: "no milestone reached",
      agent_id: p.agentId,
      milestone: null,
      views,
      hint: `Pass ?milestone=${OWNER_MILESTONES.join("|")} to preview the template anyway.`,
    });
    return;
  }

  if (format === "html") {
    res.status(200).type("html").send(p.email.html);
    return;
  }
  if (format === "text") {
    res.status(200).type("text/plain; charset=utf-8").send(p.email.text);
    return;
  }
  res.json({
    agent_id: p.agentId,
    producer_name: p.producerName,
    milestone: p.milestone,
    milestones: OWNER_MILESTONES,
    views,
    subject: p.email.subject,
    text: p.email.text,
    html: p.email.html,
    links: {
      mine_valg: p.mineValgUrl,
      unsubscribe: p.unsubscribeUrl,
    },
    unsubscribe: {
      path: OWNER_MILESTONE_UNSUB_PATH,
      route_live: true,
      note: "GET /milepael-avmeld/:token confirms; POST (or the RFC 8058 one-click body) sets notify.milestones = false.",
    },
    notify_milestones: p.notifyMilestones,
    notify_milestones_status: p.notifyMilestonesStatus,
    is_owner: p.isOwner,
    would_send: p.wouldSend,
    reason: p.wouldSendReason,
    sending: "none",
    sending_note: "Template preview only. No job, flag, route or tool sends this e-mail, and no «sent» state is kept; once-per-milestone tracking belongs to a future send job.",
  });
});

export default router;

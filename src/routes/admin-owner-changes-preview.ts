// ─── GET /admin/agents/:id/owner-changes-preview ────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-6: admin-only preview
// of the daily «something changed on your profile» owner e-mail
// (services/owner-changes-digest.ts), so Daniel can read the first edition
// before anything that sends is built.
//
//   GET /admin/agents/:id/owner-changes-preview?date=YYYY-MM-DD&format=json|html|text
//     date    the Oslo calendar day. Default: yesterday (Europe/Oslo). 400
//             when malformed, not a calendar date or after today in Oslo.
//     format  default json (subject, text, html, changes, would_send); html
//             serves the e-mail body as a page; text the plain part.
//   403 without X-Admin-Key, 404 unknown agent. No changes by others that
//   day → 404 with `changes: 0` (there is no digest to show).
//
// Read only: no INSERT/UPDATE/DELETE, no e-mail, no page-view row (/admin/ is
// in the analytics skipPaths). There is no job, no flag and no sending path;
// `would_send` is information only. The only public route is the e-mail's
// unsubscribe (/endring-avmeld/:token, routes/rapport-avmeld.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  buildOwnerChangesPreview,
  parseDigestDay,
  OWNER_CHANGES_UNSUB_PATH,
} from "../services/owner-changes-digest";

// Injectable DB seam (tests only), same convention as admin-owner-report-preview.ts.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setOwnerChangesPreviewDbForTesting(db: ReturnType<typeof getDb> | null): void {
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

// Mounted at "/admin/agents/:id/owner-changes-preview" (mergeParams), so the route is "/".
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
  const nowMs = Date.now();
  let day: ReturnType<typeof parseDigestDay> = null;
  if (req.query.date !== undefined) {
    day = parseDigestDay(req.query.date, nowMs);
    if (day === null) {
      res.status(400).json({ error: "invalid date", expected: "YYYY-MM-DD, a calendar day up to today (Europe/Oslo)" });
      return;
    }
  }

  let p: ReturnType<typeof buildOwnerChangesPreview>;
  try {
    p = buildOwnerChangesPreview(resolveDb(), id, { day, nowMs });
  } catch (err) {
    console.error("[owner-changes-preview] build failed:", err instanceof Error ? err.message : "error");
    res.status(500).json({ error: "owner changes preview failed" });
    return;
  }
  if (!p) {
    res.status(404).json({ error: "Agent not found", agent_id: id });
    return;
  }
  if (!p.email) {
    res.status(404).json({
      error: "no changes",
      agent_id: p.agentId,
      date: p.day.day,
      changes: 0,
      hint: "No change by anyone other than the owner that day, so there is no digest. Pass ?date=YYYY-MM-DD for another day.",
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
    date: p.day.day,
    window_utc: { from: p.day.fromUtc, to: p.day.toUtc },
    changes: p.changes.map((c) => ({
      field_name: c.field_name,
      label: c.label,
      old_value: c.old_value,
      new_value: c.new_value,
      values_hidden: c.values_hidden,
      who: c.who,
      changed_at: c.changed_at,
    })),
    subject: p.email.subject,
    text: p.email.text,
    html: p.email.html,
    links: {
      mine_valg: p.mineValgUrl,
      unsubscribe: p.unsubscribeUrl,
    },
    unsubscribe: {
      path: OWNER_CHANGES_UNSUB_PATH,
      route_live: true,
      note: "GET /endring-avmeld/:token confirms; POST (or the RFC 8058 one-click body) sets notify.changes = false.",
    },
    notify_changes: p.notifyChanges,
    notify_changes_status: p.notifyChangesStatus,
    is_owner: p.isOwner,
    would_send: p.wouldSend,
    reason: p.wouldSendReason,
    sending: "none",
    sending_note: "Template preview only. No job, flag, route or tool sends this e-mail, and no «sent» state is kept; once-per-day tracking belongs to a future send job.",
  });
});

export default router;

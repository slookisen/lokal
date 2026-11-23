// ─── GET /admin/agents/:id/owner-report-preview ─────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-3: admin-only preview
// of the monthly owner report e-mail (services/owner-monthly-report.ts), so
// Daniel can read the first edition before anything that sends is built.
//
//   GET /admin/agents/:id/owner-report-preview?month=YYYY-MM&format=json|html|text
//     month   default: the previous calendar month (Europe/Oslo). 400 when
//             malformed or in the future.
//     format  default json (subject, text, html, numbers, would_send); html
//             serves the e-mail body as a page; text serves the plain part.
//   403 without X-Admin-Key, 404 unknown agent.
//
// Read only: no INSERT/UPDATE/DELETE, no e-mail, no page-view row (/admin/ is
// in the analytics skipPaths). There is no public route, no job and no
// sending path; `would_send` is information only.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  buildOwnerMonthlyReport,
  defaultReportMonth,
  parseReportMonth,
  OWNER_REPORT_UNSUB_PATH,
} from "../services/owner-monthly-report";

// Injectable DB seam (tests only), same convention as owner-preview.ts.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setOwnerReportPreviewDbForTesting(db: ReturnType<typeof getDb> | null): void {
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

// Mounted at "/admin/agents/:id/owner-report-preview" (mergeParams), so the route is "/".
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
  const monthRaw = req.query.month === undefined ? defaultReportMonth(nowMs) : req.query.month;
  const month = parseReportMonth(monthRaw, nowMs);
  if (!month) {
    res.status(400).json({ error: "invalid month", expected: "YYYY-MM, not in the future" });
    return;
  }

  let report: ReturnType<typeof buildOwnerMonthlyReport>;
  try {
    report = buildOwnerMonthlyReport(resolveDb(), id, month, { nowMs });
  } catch (err) {
    console.error("[owner-report-preview] build failed:", err instanceof Error ? err.message : "error");
    res.status(500).json({ error: "owner report preview failed" });
    return;
  }
  if (!report) {
    res.status(404).json({ error: "Agent not found", agent_id: id });
    return;
  }

  if (format === "html") {
    res.status(200).type("html").send(report.html);
    return;
  }
  if (format === "text") {
    res.status(200).type("text/plain; charset=utf-8").send(report.text);
    return;
  }
  res.json({
    agent_id: report.agentId,
    producer_name: report.producerName,
    month: report.month.month,
    period: { from: report.month.from, to: report.month.to, days: "UTC" },
    partial_month: report.partialMonth,
    subject: report.subject,
    text: report.text,
    html: report.html,
    metrics: report.metrics,
    previous_month: report.previous,
    links: {
      mine_valg: report.mineValgUrl,
      unsubscribe: report.unsubscribeUrl,
    },
    unsubscribe: {
      path: OWNER_REPORT_UNSUB_PATH,
      route_live: false,
      note: "The one-click unsubscribe route is not built yet; it must exist before any send.",
    },
    notify_report: report.notifyReport,
    notify_report_status: report.notifyReportStatus,
    is_owner: report.isOwner,
    would_send: report.wouldSend,
    reason: report.wouldSendReason,
    sending: "none",
    sending_note: "Template preview only. No job, route or tool sends this e-mail; send-outs are Daniel's, via POST /admin/crm/compose.",
  });
});

export default router;

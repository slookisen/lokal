/**
 * contact-tracking.ts — Contact-click intent tracking
 * (dev-request 2026-07-03-agent-profile-conversations-stats, slice 1:
 *  work items 1+2 only — table + endpoints. NOT wired into any frontend
 *  yet, and does not remove/replace "Siste samtaler" — that's a later slice.)
 *
 * Exposes two independent routers:
 *
 *   trackRouter (default export)    → mount at "/api/track"
 *     POST /api/track/contact-click — beacon for mailto:/tel: clicks (and
 *     any other client-side "contact intent" the frontend wants to log).
 *     Body: { agentId, kind }. Always cheap/inert to the caller: malformed
 *     input gets 400/404, everything else 204. No PII beyond what the
 *     analytics_* tables already store (hashed IP + UA-derived flags —
 *     see analyticsService.getOrCreateSessionId / parseUserAgent).
 *
 *   redirectRouter (named export)   → mount at "/ut"
 *     GET /ut/:agentId/:kind — counting 302 redirect for website/social
 *     links, so profile pages can point contact-worthy links through a
 *     trackable URL without any client-side JS.
 *
 * ─── Open-redirect guard (read before touching redirectRouter) ──────────
 * :kind is a closed selector — "website" or "external:<type>" — checked
 * against a fixed regex BEFORE it ever touches a lookup. It is never
 * parsed as, decoded into, or concatenated with a URL. The actual redirect
 * target comes exclusively from `knowledgeService.getKnowledge(agentId)`
 * (agent_knowledge.website / .externalLinks[].url), i.e. data this agent's
 * owner/enrichment pipeline already stored server-side. No query
 * parameter, header, or request body is ever consulted for the target.
 * If the agent doesn't exist, or has no URL stored under the requested
 * kind, this 404s — it never falls back to "redirect somewhere anyway".
 * A resolved URL is additionally required to parse as an absolute
 * http(s) URL (defense in depth against a corrupted/malformed stored
 * value) before res.redirect() ever sees it.
 */

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { knowledgeService } from "../services/knowledge-service";
import { analyticsService, parseUserAgent } from "../services/analytics-service";

// ─── Shared validation ───────────────────────────────────────────
// agentId is our own generated id (see routes/marketplace.ts registration) —
// always [A-Za-z0-9_-], bounded length. Reject anything else outright,
// before it ever reaches a SQL prepare().
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// "external:<type>" — <type> mirrors agent_knowledge.external_links[].type
// (e.g. "facebook", "instagram", "schedule"). Bounded + alnum/dash/underscore
// only, so this can never smuggle a URL, path, or anything decode-able.
const EXTERNAL_KIND_RE = /^external:[a-z0-9_-]{1,40}$/i;

// Kinds valid for the POST beacon (intent-only, no URL resolution needed).
const POST_SIMPLE_KINDS = new Set(["email", "phone", "website"]);

function isValidPostKind(kind: string): boolean {
  return POST_SIMPLE_KINDS.has(kind) || EXTERNAL_KIND_RE.test(kind);
}

// Kinds valid for the GET redirect — only things that actually resolve to
// a stored URL. ("email"/"phone" are intentionally NOT accepted here —
// mailto:/tel: links aren't redirected server-side, only beaconed via POST.)
function isValidRedirectKind(kind: string): boolean {
  return kind === "website" || EXTERNAL_KIND_RE.test(kind);
}

function agentExists(agentId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND (is_active IS NULL OR is_active = 1)")
    .get(agentId);
  return !!row;
}

/**
 * Resolve a GET /ut redirect target STRICTLY from the agent's own stored
 * agent_knowledge — never from anything caller-supplied. Returns null if
 * there's nothing to redirect to (agent has no such link, or the stored
 * value doesn't parse as an absolute http(s) URL).
 */
function resolveRedirectUrl(agentId: string, kind: string): string | null {
  const knowledge = knowledgeService.getKnowledge(agentId);
  if (!knowledge) return null;

  let candidate: string | undefined;
  if (kind === "website") {
    candidate = knowledge.website;
  } else {
    const m = EXTERNAL_KIND_RE.exec(kind);
    if (!m) return null;
    const type = kind.slice("external:".length).toLowerCase();
    const link = knowledge.externalLinks.find(
      (l) => (l.type || "").toLowerCase() === type,
    );
    candidate = link?.url;
  }

  if (!candidate) return null;

  // Defense in depth: only ever hand res.redirect() an absolute http(s)
  // URL. This data is server-stored (not client input) but a malformed or
  // legacy row (e.g. "javascript:...", a bare domain, empty string) must
  // never reach res.redirect() unchecked.
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return candidate;
}

/** Record one contact_clicks row. Never throws — callers treat tracking as best-effort. */
function recordClick(req: Request, res: Response, agentId: string, kind: string): void {
  try {
    const db = getDb();
    const ua = analyticsService.getUserAgent(req);
    const sessionId = analyticsService.getOrCreateSessionId(req, res);
    const isBot = parseUserAgent(ua).isBot ? 1 : 0;
    db.prepare(
      `INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot) VALUES (?, ?, ?, ?)`,
    ).run(agentId, kind, sessionId, isBot);
  } catch (err) {
    console.error("[contact-tracking] failed to record click:", err);
  }
}

// ─── POST /api/track/contact-click ───────────────────────────────
const trackRouter = Router();

trackRouter.post("/contact-click", (req: Request, res: Response): void => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";

    if (!agentId || !AGENT_ID_RE.test(agentId) || !kind || !isValidPostKind(kind)) {
      res.status(400).json({ success: false, error: "invalid_request" });
      return;
    }
    if (!agentExists(agentId)) {
      res.status(404).json({ success: false, error: "agent_not_found" });
      return;
    }

    recordClick(req, res, agentId, kind);
    res.status(204).end();
  } catch (err) {
    console.error("[contact-tracking] contact-click error:", err);
    // Beacon endpoint — never surface a 500 to a fire-and-forget client call.
    res.status(204).end();
  }
});

export default trackRouter;

// ─── GET /ut/:agentId/:kind ───────────────────────────────────────
export const redirectRouter = Router();

redirectRouter.get("/:agentId/:kind", (req: Request, res: Response): void => {
  try {
    const agentId = String(req.params.agentId || "").trim();
    const kind = String(req.params.kind || "").trim();

    if (!agentId || !AGENT_ID_RE.test(agentId) || !kind || !isValidRedirectKind(kind)) {
      res.status(400).json({ success: false, error: "invalid_request" });
      return;
    }
    if (!agentExists(agentId)) {
      res.status(404).json({ success: false, error: "not_found" });
      return;
    }

    const target = resolveRedirectUrl(agentId, kind);
    if (!target) {
      res.status(404).json({ success: false, error: "not_found" });
      return;
    }

    recordClick(req, res, agentId, kind);
    res.redirect(302, target);
  } catch (err) {
    console.error("[contact-tracking] /ut redirect error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

/**
 * Conversation UI Routes — Human-readable A2A conversation views
 *
 * Renders agent-to-agent conversations as WhatsApp-like chat dialogs.
 * This makes the A2A protocol tangible for humans — you can see
 * what agents are actually saying to each other.
 *
 * Routes:
 *   GET /samtaler           → List of recent conversations
 *   GET /samtale/:id        → Single conversation as chat dialog
 *
 * Real-time: The chat view connects to /api/live SSE for live
 * message updates — new bubbles appear without page refresh.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { conversationService } from "../services/conversation-service";
import { interactionLogger } from "../services/interaction-logger";

const router = Router();

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

// ─── Helpers ────────────────────────────────────────────────

function escapeHtml(text: string): string {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatTime(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleString("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return isoDate; }
}

function formatTimeShort(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function statusBadge(status: string): string {
  const map: Record<string, { label: string; cls: string }> = {
    open: { label: "&#128994; Åpen", cls: "st-open" },
    negotiating: { label: "&#128992; Forhandling", cls: "st-neg" },
    accepted: { label: "&#9989; Akseptert", cls: "st-ok" },
    completed: { label: "&#127881; Fullført", cls: "st-done" },
    expired: { label: "&#9203; Utløpt", cls: "st-exp" },
    cancelled: { label: "&#10060; Avbrutt", cls: "st-can" },
  };
  const s = map[status] || { label: status, cls: "" };
  return `<span class="conv-status ${s.cls}">${s.label}</span>`;
}

function sourceBadge(source: string): string {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    a2a: { label: "A2A", bg: "#e8f5e0", color: "#2D5016" },
    mcp: { label: "MCP", bg: "#ede9fe", color: "#7c3aed" },
    web: { label: "Web", bg: "#e0f2fe", color: "#0369a1" },
    api: { label: "API", bg: "#f3f4f6", color: "#6b7280" },
  };
  const s = map[source] || map.api!;
  return `<span class="conv-status" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}

function messageTypeIcon(type: string): string {
  switch (type) {
    case "offer": return "&#128176;";
    case "accept": return "&#9989;";
    case "reject": return "&#10060;";
    case "info": return "&#8505;&#65039;";
    default: return "";
  }
}

// ─── Shared CSS + page shell ────────────────────────────────

const CHAT_CSS = `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --green-900: #1a3d0a; --green-700: #2D5016; --green-600: #3a6b1e;
    --green-100: #e8f5e0; --green-50: #f0f7ed;
    --orange: #D4A373; --orange-light: #fff3e0;
    --charcoal: #1a1a1a; --g700: #374151; --g500: #6b7280;
    --g300: #d1d5db; --g200: #e5e7eb; --g100: #f3f4f6; --g50: #f9fafb;
    --white: #ffffff;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
    --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1);
    --r-sm: 6px; --r-md: 10px; --r-lg: 16px;
    --buyer: #dcf8c6; --seller: #ffffff; --system: #fff9c4;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--charcoal); background: var(--g50); line-height: 1.6; -webkit-font-smoothing: antialiased; }
  a { color: var(--green-700); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Nav */
  .nav { position: sticky; top: 0; z-index: 100; background: rgba(255,255,255,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(0,0,0,0.06); padding: 0 32px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
  .nav-logo { font-weight: 800; font-size: 1.2rem; color: var(--green-700); display: flex; align-items: center; gap: 8px; text-decoration: none; }
  .nav-logo:hover { text-decoration: none; }
  .nav-icon { width: 26px; height: 26px; background: var(--green-700); border-radius: 7px; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.8rem; }
  .nav-links { display: flex; gap: 24px; align-items: center; }
  .nav-links a { font-size: 0.85rem; color: var(--g500); font-weight: 500; text-decoration: none; }
  .nav-links a:hover { color: var(--green-700); text-decoration: none; }

  /* Breadcrumb */
  .bc { max-width: 900px; margin: 0 auto; padding: 14px 24px 0; font-size: 0.8rem; color: var(--g500); }
  .bc a { color: var(--green-700); }
  .bc span { margin: 0 6px; opacity: 0.5; }

  /* Container */
  .container { max-width: 900px; margin: 0 auto; padding: 0 24px; }

  /* ═══ Conversation List ══════════════════════════════════════ */
  .conv-list-header { padding: 40px 0 12px; text-align: center; }
  .conv-list-header h1 { font-size: 1.6rem; font-weight: 800; color: var(--charcoal); margin-bottom: 6px; }
  .conv-list-header p { font-size: 0.9rem; color: var(--g500); }

  /* Stats cards */
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 20px 0; }
  .stat-card { background: var(--white); border: 1px solid var(--g100); border-radius: var(--r-md); padding: 16px; text-align: center; }
  .stat-card .stat-num { font-size: 1.5rem; font-weight: 800; color: var(--green-700); }
  .stat-card .stat-label { font-size: 0.72rem; color: var(--g500); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card.active { border-color: var(--green-700); box-shadow: 0 0 0 1px var(--green-700); }

  /* Source filter tabs */
  .filter-tabs { display: flex; gap: 8px; justify-content: center; margin: 16px 0 24px; flex-wrap: wrap; }
  .filter-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px; border-radius: 20px; border: 1.5px solid var(--g200); background: var(--white); font-size: 0.82rem; font-weight: 600; color: var(--g500); cursor: pointer; text-decoration: none; transition: all 0.15s; }
  .filter-tab:hover { border-color: var(--green-700); color: var(--green-700); text-decoration: none; }
  .filter-tab.active { background: var(--green-700); color: var(--white); border-color: var(--green-700); }
  .filter-tab .tab-count { background: rgba(0,0,0,0.08); padding: 1px 7px; border-radius: 10px; font-size: 0.7rem; }
  .filter-tab.active .tab-count { background: rgba(255,255,255,0.25); }

  .conv-item { background: var(--white); border-radius: var(--r-lg); border: 1px solid var(--g100); padding: 18px 22px; margin-bottom: 12px; display: block; text-decoration: none; color: var(--charcoal); transition: all 0.2s; }
  .conv-item:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--green-100); text-decoration: none; }
  .conv-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .conv-agents { font-weight: 700; font-size: 0.95rem; }
  .conv-agents .arrow { color: var(--g300); margin: 0 6px; }
  .conv-status { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.72rem; font-weight: 600; }
  .st-open { background: #e8f5e0; color: #2D5016; }
  .st-neg { background: #fff3e0; color: #b45309; }
  .st-ok { background: #dcf8c6; color: #1a3d0a; }
  .st-done { background: #e0f2fe; color: #0369a1; }
  .st-exp { background: var(--g100); color: var(--g500); }
  .st-can { background: #fee2e2; color: #b91c1c; }
  .conv-query { font-size: 0.85rem; color: var(--g500); margin-bottom: 6px; font-style: italic; }
  .conv-preview { font-size: 0.82rem; color: var(--g700); display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .conv-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 0.75rem; color: var(--g500); }
  .conv-count { background: var(--green-100); color: var(--green-700); padding: 2px 8px; border-radius: 10px; font-weight: 600; }

  .empty-state { text-align: center; padding: 60px 20px; color: var(--g500); }
  .empty-state .icon { font-size: 3rem; margin-bottom: 12px; }
  .empty-state p { font-size: 0.9rem; }
  .conv-stats { margin-top: 8px; font-size: 0.8rem; color: var(--g500); }

  .pagination-note { text-align: center; padding: 16px 0 32px; font-size: 0.8rem; color: var(--g500); }

  /* ═══ Query Groups (accordion) ══════════════════════════════ */
  .query-group { background: var(--white); border-radius: var(--r-lg); border: 1px solid var(--g100); margin-bottom: 12px; overflow: hidden; }
  .query-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; cursor: pointer; transition: background 0.15s; user-select: none; }
  .query-header:hover { background: var(--g50); }
  .query-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .query-icon { width: 36px; height: 36px; background: var(--green-100); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; }
  .query-text { font-weight: 700; font-size: 0.92rem; color: var(--charcoal); font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }
  .query-meta { font-size: 0.75rem; color: var(--g500); margin-top: 2px; }
  .query-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .query-chevron { font-size: 0.6rem; color: var(--g300); transition: transform 0.2s; }
  .query-replies { display: none; border-top: 1px solid var(--g100); padding: 0; }
  .query-replies.open { display: block; }
  .open + .query-header .query-chevron,
  .query-replies.open ~ .query-header .query-chevron { transform: rotate(180deg); }

  .agent-reply { display: block; padding: 14px 20px 14px 68px; border-bottom: 1px solid var(--g50); text-decoration: none; color: var(--charcoal); transition: background 0.15s; }
  .agent-reply:last-child { border-bottom: none; }
  .agent-reply:hover { background: var(--green-50); text-decoration: none; }
  .agent-reply-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .agent-reply-name { font-weight: 600; font-size: 0.88rem; }
  .agent-reply-text { font-size: 0.8rem; color: var(--g500); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
  .agent-reply-meta { font-size: 0.72rem; color: var(--g500); display: flex; justify-content: space-between; }

  /* ═══ Chat Dialog ════════════════════════════════════════════ */
  .chat-header { background: var(--green-700); color: white; padding: 18px 24px; border-radius: var(--r-lg) var(--r-lg) 0 0; margin-top: 24px; }
  .chat-header h1 { font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; }
  .chat-header-meta { font-size: 0.8rem; opacity: 0.8; display: flex; gap: 16px; flex-wrap: wrap; }

  .chat-body { background: #e5ddd5; background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23c5bfb5' fill-opacity='0.15'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E"); padding: 20px 24px; min-height: 300px; }

  .chat-date-sep { text-align: center; margin: 16px 0 12px; }
  .chat-date-sep span { background: rgba(225,219,209,0.9); color: var(--g700); padding: 4px 14px; border-radius: 8px; font-size: 0.72rem; font-weight: 600; }

  .msg { display: flex; margin-bottom: 6px; }
  .msg-buyer { justify-content: flex-end; }
  .msg-seller { justify-content: flex-start; }
  .msg-system { justify-content: center; }

  .bubble { max-width: 75%; padding: 8px 14px; border-radius: 10px; position: relative; font-size: 0.88rem; line-height: 1.5; box-shadow: 0 1px 1px rgba(0,0,0,0.08); }
  .bubble-buyer { background: var(--buyer); border-top-right-radius: 2px; }
  .bubble-seller { background: var(--seller); border-top-left-radius: 2px; }
  .bubble-system { background: var(--system); border-radius: 8px; font-size: 0.8rem; color: var(--g700); max-width: 85%; text-align: center; padding: 6px 14px; }

  .bubble-name { font-size: 0.72rem; font-weight: 700; margin-bottom: 2px; }
  .bubble-buyer .bubble-name { color: #075e54; }
  .bubble-seller .bubble-name { color: #6a1b9a; }

  .bubble-content { word-break: break-word; }
  .bubble-footer { display: flex; justify-content: flex-end; align-items: center; gap: 6px; margin-top: 3px; }
  .bubble-time { font-size: 0.65rem; color: var(--g500); }
  .bubble-type { font-size: 0.7rem; }

  .msg-offer .bubble { border-left: 3px solid var(--orange); }
  .msg-accept .bubble { border-left: 3px solid #22c55e; }
  .msg-reject .bubble { border-left: 3px solid #ef4444; }

  .chat-footer { background: var(--white); padding: 14px 24px; border-radius: 0 0 var(--r-lg) var(--r-lg); border-top: 1px solid var(--g200); display: flex; align-items: center; gap: 12px; font-size: 0.82rem; color: var(--g500); }
  .chat-footer .live-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Participants sidebar */
  .chat-participants { display: flex; gap: 24px; padding: 16px 24px; background: var(--white); border: 1px solid var(--g100); border-top: none; }
  .participant { display: flex; align-items: center; gap: 10px; }
  .participant-avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1rem; color: white; font-weight: 700; }
  .avatar-buyer { background: #075e54; }
  .avatar-seller { background: #6a1b9a; }
  .avatar-system { background: var(--g300); }
  .participant-info { font-size: 0.8rem; }
  .participant-name { font-weight: 700; color: var(--charcoal); }
  .participant-role { color: var(--g500); font-size: 0.72rem; }

  /* Footer */
  .ft { background: var(--charcoal); color: var(--white); padding: 32px; margin-top: 40px; }
  .ft-inner { max-width: 900px; margin: 0 auto; text-align: center; }
  .ft-brand { font-weight: 800; margin-bottom: 4px; }
  .ft-desc { font-size: 0.8rem; opacity: 0.5; }

  @media (max-width: 768px) {
    .nav { padding: 0 16px; }
    .nav-links { display: none; }
    .container { padding: 0 12px; }
    .bubble { max-width: 88%; }
    .chat-participants { flex-direction: column; gap: 10px; }
  }
</style>`;

function chatShell(title: string, description: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Rett fra Bonden</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="noindex">
  ${CHAT_CSS}
</head>
<body>
  <nav class="nav">
    <a href="/" class="nav-logo"><div class="nav-icon">&#127793;</div> Rett fra Bonden</a>
    <div class="nav-links">
      <a href="/samtaler">Samtaler</a>
      <a href="/sok">S&oslash;k</a>
      <a href="/teknologi">Hvordan det fungerer</a>
    </div>
  </nav>
  ${content}
  <footer class="ft">
    <div class="ft-inner">
      <div class="ft-brand">Rett fra Bonden</div>
      <div class="ft-desc">Agent-til-agent samtaler &mdash; AI som snakker med AI for &aring; finne lokal mat.</div>
    </div>
  </footer>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// GET /samtaler — Conversation list
// ═══════════════════════════════════════════════════════════════

router.get("/samtaler", (req: Request, res: Response) => {
  try {
    // ─── Source filter from query param ──────────────────────────
    const activeSource = (req.query.kilde as string) || "";
    const validSources = ["a2a", "mcp", "web", "api"];
    const filterSource = validSources.includes(activeSource) ? activeSource : undefined;

    // ─── Stats per source (always show all, regardless of filter) ─
    const sourceStats = conversationService.getSourceStats();
    const totalAll = sourceStats.reduce((s, r) => s + r.count, 0);
    const statsMap = new Map(sourceStats.map(s => [s.source, s]));

    // ─── Filtered conversations (max 50) ────────────────────────
    const conversations = conversationService.listConversations({
      limit: 50,
      source: filterSource,
    });

    // ─── Stats cards ────────────────────────────────────────────
    const sourceLabels: Record<string, { icon: string; label: string }> = {
      mcp: { icon: "&#129302;", label: "MCP" },
      a2a: { icon: "&#128640;", label: "A2A" },
      web: { icon: "&#127760;", label: "Web" },
      api: { icon: "&#128268;", label: "API" },
    };

    const statsHtml = `<div class="stats-row">
      <div class="stat-card">
        <div class="stat-num">${totalAll}</div>
        <div class="stat-label">Totalt samtaler</div>
      </div>
      ${["mcp", "a2a", "web", "api"].map(src => {
        const s = statsMap.get(src);
        const count = s?.count || 0;
        const info = sourceLabels[src]!;
        return `<div class="stat-card${activeSource === src ? " active" : ""}">
          <div class="stat-num">${count}</div>
          <div class="stat-label">${info.icon} ${info.label}</div>
        </div>`;
      }).join("\n")}
    </div>`;

    // ─── Filter tabs ─────────────────────────────────────────────
    const tabsHtml = `<div class="filter-tabs">
      <a href="/samtaler" class="filter-tab${!activeSource ? " active" : ""}">Alle <span class="tab-count">${totalAll}</span></a>
      ${["mcp", "a2a", "web", "api"].map(src => {
        const count = statsMap.get(src)?.count || 0;
        const info = sourceLabels[src]!;
        return `<a href="/samtaler?kilde=${src}" class="filter-tab${activeSource === src ? " active" : ""}">${info.icon} ${info.label} <span class="tab-count">${count}</span></a>`;
      }).join("\n")}
    </div>`;

    // ─── Conversation groups ─────────────────────────────────────
    let listHtml = "";

    if (conversations.length === 0) {
      const emptyMsg = activeSource
        ? `Ingen samtaler via ${sourceLabels[activeSource]?.label || activeSource} enn&aring;.`
        : `Ingen samtaler enn&aring;. N&aring;r agenter begynner &aring; snakke med hverandre, dukker samtalene opp her.`;
      listHtml = `
        <div class="empty-state">
          <div class="icon">&#128172;</div>
          <p>${emptyMsg}</p>
          ${activeSource ? `<p style="margin-top:12px"><a href="/samtaler">&larr; Vis alle samtaler</a></p>` : ""}
        </div>`;
    } else {
      // Group by query text
      const groups = new Map<string, typeof conversations>();
      for (const conv of conversations) {
        const key = (conv.queryText || "").trim().toLowerCase() || conv.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(conv);
      }

      let groupIdx = 0;
      listHtml = [...groups.entries()].map(([_key, convs]) => {
        groupIdx++;
        const first = convs[0];
        const queryDisplay = first.queryText ? escapeHtml(first.queryText) : "Direkte samtale";
        const source = first.source || "api";
        const srcBadge = sourceBadge(source);
        const totalMsgs = convs.reduce((s, c) => s + c.messages.length, 0);
        const agentCount = convs.length;
        const mostRecent = convs.reduce((a, b) => a.updatedAt > b.updatedAt ? a : b);
        const groupId = `grp-${groupIdx}`;

        // Check for client identity in system message metadata
        const systemMsg = first.messages.find(m => m.senderRole === "system");
        const clientIdentity = systemMsg?.metadata?.clientIdentity;
        const clientTag = clientIdentity ? ` <span style="font-size:0.7rem;opacity:0.7">(${escapeHtml(clientIdentity)})</span>` : "";

        // Agent sub-cards
        const agentCards = convs.map(conv => {
          const sellerName = escapeHtml(conv.sellerAgentName || "Ukjent selger");
          const sellerMsg = [...conv.messages].reverse().find(m => m.senderRole === "seller");
          const preview = sellerMsg
            ? escapeHtml(sellerMsg.content).slice(0, 150) + (sellerMsg.content.length > 150 ? "..." : "")
            : "";

          return `<a href="/samtale/${conv.id}" class="agent-reply">
            <div class="agent-reply-top">
              <div class="agent-reply-name">${sellerName}</div>
              ${statusBadge(conv.status)}
            </div>
            ${preview ? `<div class="agent-reply-text">${preview}</div>` : ""}
            <div class="agent-reply-meta">
              <span>${conv.messages.length} meldinger</span>
              <span class="cv-time">${formatTime(conv.updatedAt)}</span>
            </div>
          </a>`;
        }).join("\n");

        return `<div class="query-group">
          <div class="query-header" data-toggle="${groupId}">
            <div class="query-left">
              <div class="query-icon">&#128269;</div>
              <div>
                <div class="query-text">&laquo;${queryDisplay}&raquo;${clientTag}</div>
                <div class="query-meta">${agentCount} produsent${agentCount > 1 ? "er" : ""} svarte &middot; ${totalMsgs} meldinger &middot; ${formatTime(mostRecent.updatedAt)}</div>
              </div>
            </div>
            <div class="query-right">
              ${srcBadge}
              <div class="query-chevron">&#9660;</div>
            </div>
          </div>
          <div class="query-replies" id="${groupId}">
            ${agentCards}
          </div>
        </div>`;
      }).join("\n");
    }

    const totalConvs = conversations.length;
    const paginationNote = totalConvs >= 50
      ? `<div class="pagination-note">Viser siste 50 samtaler${activeSource ? ` fra ${sourceLabels[activeSource]?.label || activeSource}` : ""}.</div>`
      : "";

    const html = chatShell("Samtaler — Rett fra Bonden", "Se hvordan AI-agenter og besøkende finner lokal mat", `
      <div class="container">
        <div class="conv-list-header">
          <h1>&#128172; Samtaler</h1>
          <p>Se hvordan AI-agenter og bes&oslash;kende finner lokal mat &mdash; i sanntid</p>
        </div>
        ${statsHtml}
        ${tabsHtml}
        ${listHtml}
        ${paginationNote}
      </div>
      <script>
        document.querySelectorAll("[data-toggle]").forEach(function(header) {
          header.addEventListener("click", function() {
            var r = document.getElementById(header.getAttribute("data-toggle"));
            if (!r) return;
            r.classList.toggle("open");
            var chev = header.querySelector(".query-chevron");
            if (chev) chev.style.transform = r.classList.contains("open") ? "rotate(180deg)" : "";
          });
        });
      </script>
    `);

    res.send(html);
  } catch (err: any) {
    console.error("Error rendering /samtaler:", err);
    res.status(500).send("Feil ved lasting av samtaler.");
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /samtale/:id — Single conversation as chat dialog
// ═══════════════════════════════════════════════════════════════

router.get("/samtale/:id", (req: Request, res: Response) => {
  try {
    const conv = conversationService.getConversation(req.params.id as string);
    if (!conv) {
      res.status(404).send(chatShell("Ikke funnet", "Samtalen finnes ikke", `
        <div class="container">
          <div class="empty-state">
            <div class="icon">&#128533;</div>
            <p>Denne samtalen finnes ikke eller er slettet.</p>
            <p style="margin-top:12px"><a href="/samtaler">&larr; Tilbake til samtaler</a></p>
          </div>
        </div>
      `));
      return;
    }

    const buyerName = conv.buyerAgentName || "Anonym kjøper";
    const sellerName = conv.sellerAgentName || "Ukjent selger";

    // Build chat bubbles
    let lastDate = "";
    const bubblesHtml = conv.messages.map(msg => {
      const role = msg.senderRole;
      const msgDate = msg.createdAt.split("T")[0];
      let dateSep = "";
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        dateSep = `<div class="chat-date-sep"><span>${formatTime(msg.createdAt).split(",")[0] || msgDate}</span></div>`;
      }

      if (role === "system") {
        return `${dateSep}<div class="msg msg-system msg-${msg.messageType}">
          <div class="bubble bubble-system">
            ${messageTypeIcon(msg.messageType)} ${escapeHtml(msg.content)}
            <div class="bubble-footer"><span class="bubble-time">${formatTimeShort(msg.createdAt)}</span></div>
          </div>
        </div>`;
      }

      const isBuyer = role === "buyer";
      const bubbleCls = isBuyer ? "bubble-buyer" : "bubble-seller";
      const msgCls = isBuyer ? "msg-buyer" : "msg-seller";
      const name = msg.senderAgentName || (isBuyer ? buyerName : sellerName);
      const typeIcon = messageTypeIcon(msg.messageType);

      return `${dateSep}<div class="msg ${msgCls} msg-${msg.messageType}">
        <div class="bubble ${bubbleCls}">
          <div class="bubble-name">${escapeHtml(name)}</div>
          <div class="bubble-content">${typeIcon ? typeIcon + " " : ""}${escapeHtml(msg.content)}</div>
          <div class="bubble-footer">
            ${msg.messageType !== "text" ? `<span class="bubble-type">${escapeHtml(msg.messageType)}</span>` : ""}
            <span class="bubble-time">${formatTimeShort(msg.createdAt)}</span>
          </div>
        </div>
      </div>`;
    }).join("\n");

    // Participant cards
    const buyerInitial = buyerName.charAt(0).toUpperCase();
    const sellerInitial = sellerName.charAt(0).toUpperCase();

    const html = chatShell(
      `${buyerName} ↔ ${sellerName}`,
      `A2A-samtale: ${conv.queryText || "agent-dialog"}`,
      `
      <div class="container">
        <div class="bc">
          <a href="/">Hjem</a><span>/</span><a href="/samtaler">Samtaler</a><span>/</span>${escapeHtml(sellerName)}
        </div>

        <div class="chat-header">
          <h1>${escapeHtml(buyerName)} &harr; ${escapeHtml(sellerName)}</h1>
          <div class="chat-header-meta">
            ${statusBadge(conv.status)}
            <span>${conv.messages.length} meldinger</span>
            <span>Startet ${formatTime(conv.createdAt)}</span>
            ${conv.queryText ? `<span>S&oslash;k: &laquo;${escapeHtml(conv.queryText)}&raquo;</span>` : ""}
          </div>
        </div>

        <div class="chat-participants">
          <div class="participant">
            <div class="participant-avatar avatar-buyer">${buyerInitial}</div>
            <div class="participant-info">
              <div class="participant-name">${escapeHtml(buyerName)}</div>
              <div class="participant-role">Kj&oslash;per-agent</div>
            </div>
          </div>
          <div class="participant">
            <div class="participant-avatar avatar-seller">${sellerInitial}</div>
            <div class="participant-info">
              <div class="participant-name">${escapeHtml(sellerName)}</div>
              <div class="participant-role">Selger-agent</div>
            </div>
          </div>
        </div>

        <div class="chat-body" id="chatBody">
          ${bubblesHtml || '<div class="empty-state"><p>Ingen meldinger i denne samtalen enn&aring;.</p></div>'}
        </div>

        <div class="chat-footer">
          <div class="live-dot"></div>
          <span>Sanntidsoppdatering aktiv &mdash; nye meldinger vises automatisk</span>
        </div>
      </div>

      <script>
        // ─── Live SSE: new messages appear as bubbles ───────────
        (function() {
          var convId = "${conv.id}";
          var chatBody = document.getElementById("chatBody");
          if (!chatBody) return;

          var es;
          function connect() {
            es = new EventSource("/api/live");
            es.onmessage = function(e) {
              try {
                var d = JSON.parse(e.data);
                if (d.type !== "conversation_message") return;
                if (d.conversationId !== convId) return;

                var role = d.senderRole;
                var isBuyer = role === "buyer";
                var isSystem = role === "system";

                var div = document.createElement("div");
                var now = new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });

                if (isSystem) {
                  div.className = "msg msg-system msg-" + (d.messageType || "info");
                  div.innerHTML = '<div class="bubble bubble-system">' +
                    esc(d.content) +
                    '<div class="bubble-footer"><span class="bubble-time">' + now + '</span></div></div>';
                } else {
                  var cls = isBuyer ? "msg-buyer" : "msg-seller";
                  var bcls = isBuyer ? "bubble-buyer" : "bubble-seller";
                  var name = d.senderAgentName || (isBuyer ? "${escapeHtml(buyerName)}" : "${escapeHtml(sellerName)}");
                  div.className = "msg " + cls + " msg-" + (d.messageType || "text");
                  div.innerHTML = '<div class="bubble ' + bcls + '">' +
                    '<div class="bubble-name">' + esc(name) + '</div>' +
                    '<div class="bubble-content">' + esc(d.content) + '</div>' +
                    '<div class="bubble-footer"><span class="bubble-time">' + now + '</span></div></div>';
                }

                chatBody.appendChild(div);
                div.scrollIntoView({ behavior: "smooth" });
              } catch(err) {}
            };
            es.onerror = function() {
              es.close();
              setTimeout(connect, 3000);
            };
          }
          connect();

          function esc(s) {
            if (!s) return "";
            var d = document.createElement("div");
            d.appendChild(document.createTextNode(s));
            return d.innerHTML;
          }
        })();
      </script>
    `);

    res.send(html);
  } catch (err: any) {
    console.error("Error rendering /samtale/:id:", err);
    res.status(500).send("Feil ved lasting av samtale.");
  }
});

// ═══════════════════════════════════════════════════════════════
// AG-UI PROTOCOL — Real-time conversation streaming
// ═══════════════════════════════════════════════════════════════
//
// Implements the AG-UI (Agent-User Interaction Protocol) event format
// over SSE. This lets any AG-UI compatible frontend render live A2A
// conversations with proper typing indicators, message streaming,
// and state management.
//
// Endpoint: GET /api/ag-ui/conversation/:id
//   → SSE stream of AG-UI events for a specific conversation
//
// Endpoint: POST /api/ag-ui/conversation/:id/run
//   → Start a "run" that streams the full conversation + live updates
//
// Event types used:
//   RunStarted, RunFinished, TextMessageStart, TextMessageContent,
//   TextMessageEnd, StateSnapshot, Custom

// ─── AG-UI SSE clients per conversation ─────────────────────
const agUiClients = new Map<string, Set<Response>>();

function sendAgUiEvent(conversationId: string, event: object) {
  const clients = agUiClients.get(conversationId);
  if (!clients?.size) return;
  const data = JSON.stringify(event);
  for (const client of clients) {
    try { client.write(`data: ${data}\n\n`); } catch { clients.delete(client); }
  }
}

// Forward conversation messages to AG-UI clients in real-time
interactionLogger.on("message", (msg: any) => {
  if (!msg.conversationId) return;
  const clients = agUiClients.get(msg.conversationId);
  if (!clients?.size) return;

  const messageId = msg.id || randomUUID();
  const role = msg.senderRole === "buyer" ? "user" : msg.senderRole === "seller" ? "assistant" : "system";

  // Emit AG-UI text message sequence: Start → Content → End
  sendAgUiEvent(msg.conversationId, {
    type: "TextMessageStart",
    messageId,
    role,
    timestamp: new Date().toISOString(),
  });

  sendAgUiEvent(msg.conversationId, {
    type: "TextMessageContent",
    messageId,
    delta: msg.content,
    timestamp: new Date().toISOString(),
  });

  sendAgUiEvent(msg.conversationId, {
    type: "TextMessageEnd",
    messageId,
    timestamp: new Date().toISOString(),
  });

  // Also emit custom event with A2A-specific metadata
  if (msg.messageType && msg.messageType !== "text") {
    sendAgUiEvent(msg.conversationId, {
      type: "Custom",
      name: "a2a.message_type",
      value: {
        messageType: msg.messageType,
        senderRole: msg.senderRole,
        senderAgentName: msg.senderAgentName,
        metadata: msg.metadata,
      },
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── GET /api/ag-ui/conversations — List active streams ─────

router.get("/api/ag-ui/conversations", (req: Request, res: Response) => {
  const source = req.query.source as string | undefined;
  const conversations = conversationService.listConversations({ limit: 50, source });
  res.json({
    conversations: conversations.map(c => ({
      id: c.id,
      buyerAgent: c.buyerAgentName,
      sellerAgent: c.sellerAgentName,
      status: c.status,
      messageCount: c.messages.length,
      streamUrl: `${BASE_URL}/api/ag-ui/conversation/${c.id}`,
      updatedAt: c.updatedAt,
    })),
  });
});

// ─── POST /api/ag-ui/conversation/:id/run — Start AG-UI run ─
// This replays the full conversation as AG-UI events, then keeps
// the connection open for live updates. This is how AG-UI clients
// "join" a conversation.

router.post("/api/ag-ui/conversation/:id/run", (req: Request, res: Response) => {
  const conv = conversationService.getConversation(req.params.id as string);
  if (!conv) {
    res.status(404).json({ type: "RunError", message: "Conversation not found", code: "NOT_FOUND" });
    return;
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const runId = randomUUID();
  const threadId = conv.id;

  // Register this client for live updates
  if (!agUiClients.has(threadId)) agUiClients.set(threadId, new Set());
  agUiClients.get(threadId)!.add(res);
  req.on("close", () => {
    agUiClients.get(threadId)?.delete(res);
    if (agUiClients.get(threadId)?.size === 0) agUiClients.delete(threadId);
  });

  // 1. RunStarted
  res.write(`data: ${JSON.stringify({
    type: "RunStarted",
    threadId,
    runId,
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // 2. StateSnapshot — full conversation state
  res.write(`data: ${JSON.stringify({
    type: "StateSnapshot",
    snapshot: {
      conversationId: conv.id,
      status: conv.status,
      buyerAgent: { id: conv.buyerAgentId, name: conv.buyerAgentName },
      sellerAgent: { id: conv.sellerAgentId, name: conv.sellerAgentName },
      queryText: conv.queryText,
      messageCount: conv.messages.length,
      createdAt: conv.createdAt,
    },
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // 3. Replay all existing messages as AG-UI TextMessage events
  for (const msg of conv.messages) {
    const messageId = msg.id;
    const role = msg.senderRole === "buyer" ? "user" : msg.senderRole === "seller" ? "assistant" : "system";

    res.write(`data: ${JSON.stringify({
      type: "TextMessageStart",
      messageId,
      role,
      timestamp: msg.createdAt,
    })}\n\n`);

    res.write(`data: ${JSON.stringify({
      type: "TextMessageContent",
      messageId,
      delta: msg.content,
      timestamp: msg.createdAt,
    })}\n\n`);

    res.write(`data: ${JSON.stringify({
      type: "TextMessageEnd",
      messageId,
      timestamp: msg.createdAt,
    })}\n\n`);

    // Emit custom metadata for non-text messages
    if (msg.messageType !== "text") {
      res.write(`data: ${JSON.stringify({
        type: "Custom",
        name: "a2a.message_type",
        value: {
          messageType: msg.messageType,
          senderRole: msg.senderRole,
          senderAgentName: msg.senderAgentName,
        },
        timestamp: msg.createdAt,
      })}\n\n`);
    }
  }

  // 4. If conversation is already completed, send RunFinished
  if (["completed", "cancelled", "expired"].includes(conv.status)) {
    res.write(`data: ${JSON.stringify({
      type: "RunFinished",
      threadId,
      runId,
      result: { status: conv.status },
      timestamp: new Date().toISOString(),
    })}\n\n`);
    // Keep connection open briefly for any late events, then close
    setTimeout(() => { try { res.end(); } catch {} }, 1000);
  }
  // Otherwise, connection stays open for live updates via the interactionLogger listener
});

// ─── GET /api/ag-ui/conversation/:id — Simple SSE stream ────
// Lighter alternative: just streams new messages, no replay.

router.get("/api/ag-ui/conversation/:id", (req: Request, res: Response) => {
  const convId = req.params.id as string;
  const conv = conversationService.getConversation(convId);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send connection event
  res.write(`data: ${JSON.stringify({
    type: "Custom",
    name: "a2a.connected",
    value: {
      conversationId: convId,
      status: conv.status,
      buyerAgent: conv.buyerAgentName,
      sellerAgent: conv.sellerAgentName,
    },
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // Register for live updates
  if (!agUiClients.has(convId)) agUiClients.set(convId, new Set());
  agUiClients.get(convId)!.add(res);
  req.on("close", () => {
    agUiClients.get(convId)?.delete(res);
    if (agUiClients.get(convId)?.size === 0) agUiClients.delete(convId);
  });
});

export default router;

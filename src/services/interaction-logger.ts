import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { getDb } from "../database/init";
import { EventEmitter } from "events";

// ─── Interaction Logger ─────────────────────────────────────
// Logs every agent touch-point. This is the data layer that
// powers: live dashboard, seller metrics, agent reputation,
// and eventually billing.
//
// Design decisions:
//   - IP is hashed (SHA-256 truncated) for privacy
//   - EventEmitter for SSE — no polling, instant updates
//   - Non-blocking: log failures don't break the request

export type InteractionType = "search" | "discover" | "register" | "view" | "message" | "transaction";

export interface InteractionEvent {
  id: string;
  type: InteractionType;
  agentId?: string;
  agentName?: string;
  query?: string;
  resultCount: number;
  matchedAgentIds: string[];
  metadata: Record<string, any>;
  durationMs?: number;
  createdAt: string;
}

class InteractionLogger extends EventEmitter {
  // ─── Log an interaction ──────────────────────────────────
  log(
    type: InteractionType,
    opts: {
      agentId?: string;
      query?: string;
      resultCount?: number;
      matchedAgentIds?: string[];
      metadata?: Record<string, any>;
      ipAddress?: string;
      durationMs?: number;
    } = {}
  ): InteractionEvent {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();
    const ipHash = opts.ipAddress
      ? crypto.createHash("sha256").update(opts.ipAddress).digest("hex").slice(0, 16)
      : null;

    try {
      db.prepare(`
        INSERT INTO interactions (id, type, agent_id, query, result_count, matched_agent_ids, metadata, ip_hash, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        type,
        opts.agentId || null,
        opts.query || null,
        opts.resultCount || 0,
        JSON.stringify(opts.matchedAgentIds || []),
        JSON.stringify(opts.metadata || {}),
        ipHash,
        opts.durationMs || null,
        now,
      );
    } catch (e) {
      // Non-critical — don't break the request
      console.error("Interaction log failed:", e);
    }

    // Build event for SSE
    const event: InteractionEvent = {
      id,
      type,
      agentId: opts.agentId,
      query: opts.query,
      resultCount: opts.resultCount || 0,
      matchedAgentIds: opts.matchedAgentIds || [],
      metadata: opts.metadata || {},
      durationMs: opts.durationMs,
      createdAt: now,
    };

    // Resolve agent name for richer SSE events
    if (opts.agentId) {
      try {
        const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(opts.agentId) as any;
        if (row) event.agentName = row.name;
      } catch { /* non-critical */ }
    }

    // Emit for SSE listeners
    this.emit("interaction", event);
    return event;
  }

  // ─── Recent interactions ─────────────────────────────────
  getRecent(limit = 50): InteractionEvent[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT i.*, a.name as agent_name
      FROM interactions i
      LEFT JOIN agents a ON i.agent_id = a.id
      ORDER BY i.created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      id: r.id,
      type: r.type,
      agentId: r.agent_id,
      agentName: r.agent_name,
      query: r.query,
      resultCount: r.result_count,
      matchedAgentIds: r.matched_agent_ids ? JSON.parse(r.matched_agent_ids) : [],
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  }

  // ─── Stats for dashboard ─────────────────────────────────
  getStats(): {
    totalInteractions: number;
    todayInteractions: number;
    searchesToday: number;
    uniqueAgentsToday: number;
    topSearches: { query: string; count: number }[];
  } {
    const db = getDb();

    const total = (db.prepare("SELECT COUNT(*) as c FROM interactions").get() as any).c;
    const today = (db.prepare(
      "SELECT COUNT(*) as c FROM interactions WHERE created_at >= date('now')"
    ).get() as any).c;
    const searchesToday = (db.prepare(
      "SELECT COUNT(*) as c FROM interactions WHERE type IN ('search','discover') AND created_at >= date('now')"
    ).get() as any).c;
    const uniqueToday = (db.prepare(
      "SELECT COUNT(DISTINCT agent_id) as c FROM interactions WHERE agent_id IS NOT NULL AND created_at >= date('now')"
    ).get() as any).c;

    const topSearches = db.prepare(`
      SELECT query, COUNT(*) as count
      FROM interactions
      WHERE query IS NOT NULL AND query != ''
      ORDER BY count DESC
      LIMIT 10
    `).all() as any[];

    return {
      totalInteractions: total,
      todayInteractions: today,
      searchesToday: searchesToday,
      uniqueAgentsToday: uniqueToday,
      topSearches: topSearches.map(r => ({ query: r.query, count: r.count })),
    };
  }
}

// Singleton
export const interactionLogger = new InteractionLogger();

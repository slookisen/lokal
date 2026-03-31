"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.interactionLogger = void 0;
const uuid_1 = require("uuid");
const crypto_1 = __importDefault(require("crypto"));
const init_1 = require("../database/init");
const events_1 = require("events");
class InteractionLogger extends events_1.EventEmitter {
    // ─── Log an interaction ──────────────────────────────────
    log(type, opts = {}) {
        const db = (0, init_1.getDb)();
        const id = (0, uuid_1.v4)();
        const now = new Date().toISOString();
        const ipHash = opts.ipAddress
            ? crypto_1.default.createHash("sha256").update(opts.ipAddress).digest("hex").slice(0, 16)
            : null;
        try {
            db.prepare(`
        INSERT INTO interactions (id, type, agent_id, query, result_count, matched_agent_ids, metadata, ip_hash, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, type, opts.agentId || null, opts.query || null, opts.resultCount || 0, JSON.stringify(opts.matchedAgentIds || []), JSON.stringify(opts.metadata || {}), ipHash, opts.durationMs || null, now);
        }
        catch (e) {
            // Non-critical — don't break the request
            console.error("Interaction log failed:", e);
        }
        // Build event for SSE
        const event = {
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
                const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(opts.agentId);
                if (row)
                    event.agentName = row.name;
            }
            catch { /* non-critical */ }
        }
        // Emit for SSE listeners
        this.emit("interaction", event);
        return event;
    }
    // ─── Recent interactions ─────────────────────────────────
    getRecent(limit = 50) {
        const db = (0, init_1.getDb)();
        const rows = db.prepare(`
      SELECT i.*, a.name as agent_name
      FROM interactions i
      LEFT JOIN agents a ON i.agent_id = a.id
      ORDER BY i.created_at DESC
      LIMIT ?
    `).all(limit);
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
    getStats() {
        const db = (0, init_1.getDb)();
        const total = db.prepare("SELECT COUNT(*) as c FROM interactions").get().c;
        const today = db.prepare("SELECT COUNT(*) as c FROM interactions WHERE created_at >= date('now')").get().c;
        const searchesToday = db.prepare("SELECT COUNT(*) as c FROM interactions WHERE type IN ('search','discover') AND created_at >= date('now')").get().c;
        const uniqueToday = db.prepare("SELECT COUNT(DISTINCT agent_id) as c FROM interactions WHERE agent_id IS NOT NULL AND created_at >= date('now')").get().c;
        const topSearches = db.prepare(`
      SELECT query, COUNT(*) as count
      FROM interactions
      WHERE query IS NOT NULL AND query != ''
      ORDER BY count DESC
      LIMIT 10
    `).all();
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
exports.interactionLogger = new InteractionLogger();
//# sourceMappingURL=interaction-logger.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trustScoreService = void 0;
const init_1 = require("../database/init");
// ─── Trust Score Service ──────────────────────────────────────
//
// Replaces the static 0.5 default with a real, dynamic reputation
// engine. The score drives ranking in discovery — sellers who claim
// their agent, fill in their info, and stay active float to the top.
//
// This is the core incentive loop: engagement → trust → visibility.
//
// ─── Formula (v1 — Soft Launch) ──────────────────────────────
//
// Score = weighted average of observable signals, scale 0.0 → 1.0
//
//   Signal                  Weight   Source
//   ─────────────────────── ──────── ──────────────────────────
//   Verification Level      30%      agent_claims.status + agents.is_verified
//   Data Completeness       20%      agent_knowledge fields filled
//   Activity / Freshness    20%      last_seen_at / owner_updated_at decay
//   Interaction Volume      20%      agent_metrics discovery+contact counts
//   Community Signal        10%      Future: ratings, repeat buyers
//
// Phase 1 (now):   verification + completeness only (50% of weight)
// Phase 2 (May):   + freshness decay
// Phase 3 (scale): + interaction success + community
// ─── Signal weights ──────────────────────────────────────────
const WEIGHTS = {
    verification: 0.30,
    completeness: 0.20,
    freshness: 0.20,
    interaction: 0.20,
    community: 0.10,
};
// ─── Knowledge fields that count toward completeness ─────────
// Each field is worth equal share of the completeness score.
// JSON array fields count as "filled" if they have ≥1 item.
const KNOWLEDGE_FIELDS = [
    { column: "address", type: "text" },
    { column: "postal_code", type: "text" },
    { column: "website", type: "text" },
    { column: "phone", type: "text" },
    { column: "email", type: "text" },
    { column: "opening_hours", type: "json_array" },
    { column: "products", type: "json_array" },
    { column: "about", type: "text" },
    { column: "specialties", type: "json_array" },
    { column: "certifications", type: "json_array" },
    { column: "payment_methods", type: "json_array" },
    { column: "delivery_options", type: "json_array" },
    { column: "images", type: "json_array" },
];
// ─── Freshness decay curve ───────────────────────────────────
// How quickly the freshness signal decays without activity.
//   ≤ 7 days:  1.0 (fully fresh)
//   ≤ 30 days: 0.8
//   ≤ 90 days: 0.5
//   ≤ 180 days: 0.2
//   > 180 days: 0.05
const FRESHNESS_TIERS = [
    { maxDays: 7, score: 1.0 },
    { maxDays: 30, score: 0.8 },
    { maxDays: 90, score: 0.5 },
    { maxDays: 180, score: 0.2 },
];
const FRESHNESS_FLOOR = 0.05;
class TrustScoreService {
    // ─── Calculate trust score for a single agent ──────────────
    calculate(agentId) {
        const verification = this.verificationSignal(agentId);
        const completeness = this.completenessSignal(agentId);
        const freshness = this.freshnessSignal(agentId);
        const interaction = this.interactionSignal(agentId);
        const community = this.communitySignal(agentId);
        const score = verification * WEIGHTS.verification +
            completeness * WEIGHTS.completeness +
            freshness * WEIGHTS.freshness +
            interaction * WEIGHTS.interaction +
            community * WEIGHTS.community;
        // Clamp to 0.0–1.0 and round to 3 decimal places
        return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
    }
    // ─── Recalculate and persist for a single agent ────────────
    update(agentId) {
        const score = this.calculate(agentId);
        const db = (0, init_1.getDb)();
        db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?").run(score, agentId);
        return score;
    }
    // ─── Recalculate ALL agents (batch) ────────────────────────
    // Called on deploy or as a periodic job. Returns count updated.
    recalculateAll() {
        const db = (0, init_1.getDb)();
        const agents = db.prepare("SELECT id FROM agents WHERE is_active = 1").all();
        const updateStmt = db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?");
        let totalScore = 0;
        const distribution = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
        const batchUpdate = db.transaction(() => {
            for (const agent of agents) {
                const score = this.calculate(agent.id);
                updateStmt.run(score, agent.id);
                totalScore += score;
                const pct = Math.round(score * 100);
                if (pct <= 20)
                    distribution["0-20"]++;
                else if (pct <= 40)
                    distribution["21-40"]++;
                else if (pct <= 60)
                    distribution["41-60"]++;
                else if (pct <= 80)
                    distribution["61-80"]++;
                else
                    distribution["81-100"]++;
            }
        });
        batchUpdate();
        return {
            updated: agents.length,
            avgScore: agents.length > 0 ? Math.round((totalScore / agents.length) * 1000) / 1000 : 0,
            distribution,
        };
    }
    // ─── Get breakdown for debugging / seller dashboard ────────
    getBreakdown(agentId) {
        const verification = this.verificationSignal(agentId);
        const completeness = this.completenessSignal(agentId);
        const freshness = this.freshnessSignal(agentId);
        const interaction = this.interactionSignal(agentId);
        const community = this.communitySignal(agentId);
        const score = this.calculate(agentId);
        // Generate actionable tips for sellers
        const tips = [];
        if (verification < 0.5)
            tips.push("Krev din agent for å øke tillitsscoren med opptil 30%");
        if (completeness < 0.5)
            tips.push("Legg til produkter, åpningstider og adresse for bedre synlighet");
        if (completeness < 0.8 && completeness >= 0.5)
            tips.push("Legg til bilder og sertifiseringer for enda bedre score");
        if (freshness < 0.5)
            tips.push("Oppdater profilen din jevnlig — aktive agenter rangeres høyere");
        const db = (0, init_1.getDb)();
        const agent = db.prepare("SELECT is_verified FROM agents WHERE id = ?").get(agentId);
        const claimed = this.isAgentClaimed(agentId);
        let verificationDetail = "Ikke claima";
        if (agent?.is_verified)
            verificationDetail = "Verifisert eier";
        else if (claimed)
            verificationDetail = "Claima, ikke verifisert";
        return {
            score,
            signals: {
                verification: { value: verification, weight: WEIGHTS.verification, detail: verificationDetail },
                completeness: { value: completeness, weight: WEIGHTS.completeness, detail: `${Math.round(completeness * 100)}% av felter fylt ut` },
                freshness: { value: freshness, weight: WEIGHTS.freshness, detail: `Siste aktivitet: ${this.getLastActivityLabel(agentId)}` },
                interaction: { value: interaction, weight: WEIGHTS.interaction, detail: this.getInteractionDetail(agentId) },
                community: { value: community, weight: WEIGHTS.community, detail: "Kommer i fremtidig versjon" },
            },
            tips,
        };
    }
    // ═══════════════════════════════════════════════════════════════
    // SIGNAL CALCULATORS
    // Each returns a value between 0.0 and 1.0
    // ═══════════════════════════════════════════════════════════════
    verificationSignal(agentId) {
        const db = (0, init_1.getDb)();
        const agent = db.prepare("SELECT is_verified FROM agents WHERE id = ?").get(agentId);
        if (!agent)
            return 0;
        // Fully verified (claimed + code verified) = 1.0
        if (agent.is_verified === 1)
            return 1.0;
        // Claimed but not yet verified = 0.4
        if (this.isAgentClaimed(agentId))
            return 0.4;
        // Has a pending claim = 0.15 (shows intent)
        const pendingClaim = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status IN ('pending', 'code_sent')").get(agentId);
        if (pendingClaim.c > 0)
            return 0.15;
        // Unclaimed, auto-seeded = 0.0
        return 0.0;
    }
    completenessSignal(agentId) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        // No knowledge record at all = base from agent table only
        if (!row) {
            // Check if the agent at least has basic fields
            const agent = db.prepare("SELECT description, city, categories, tags FROM agents WHERE id = ?").get(agentId);
            if (!agent)
                return 0;
            let filled = 0;
            let total = 4;
            if (agent.description && agent.description.length > 20)
                filled++;
            if (agent.city)
                filled++;
            if (agent.categories && JSON.parse(agent.categories || "[]").length > 0)
                filled++;
            if (agent.tags && JSON.parse(agent.tags || "[]").length > 0)
                filled++;
            // Agent-table-only completeness maxes at 0.3 (you need knowledge for higher)
            return (filled / total) * 0.3;
        }
        // Score each knowledge field
        let filled = 0;
        for (const field of KNOWLEDGE_FIELDS) {
            const val = row[field.column];
            if (field.type === "text") {
                if (val && val.trim().length > 0)
                    filled++;
            }
            else if (field.type === "json_array") {
                try {
                    const arr = JSON.parse(val || "[]");
                    if (Array.isArray(arr) && arr.length > 0)
                        filled++;
                }
                catch {
                    // Invalid JSON = not filled
                }
            }
        }
        return filled / KNOWLEDGE_FIELDS.length;
    }
    freshnessSignal(agentId) {
        const db = (0, init_1.getDb)();
        // Find the most recent activity timestamp across all tables
        const agent = db.prepare("SELECT last_seen_at, created_at FROM agents WHERE id = ?").get(agentId);
        const knowledge = db.prepare("SELECT owner_updated_at, last_enriched_at, updated_at FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        const metrics = db.prepare("SELECT last_interaction_at FROM agent_metrics WHERE agent_id = ?").get(agentId);
        const timestamps = [
            agent?.last_seen_at,
            agent?.created_at,
            knowledge?.owner_updated_at,
            knowledge?.last_enriched_at,
            knowledge?.updated_at,
            metrics?.last_interaction_at,
        ].filter(Boolean);
        if (timestamps.length === 0)
            return FRESHNESS_FLOOR;
        // Find the most recent timestamp
        const latest = timestamps.reduce((a, b) => (a > b ? a : b));
        const daysSince = (Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60 * 24);
        for (const tier of FRESHNESS_TIERS) {
            if (daysSince <= tier.maxDays)
                return tier.score;
        }
        return FRESHNESS_FLOOR;
    }
    interactionSignal(agentId) {
        const db = (0, init_1.getDb)();
        const metrics = db.prepare("SELECT times_discovered, times_contacted, times_chosen FROM agent_metrics WHERE agent_id = ?").get(agentId);
        if (!metrics)
            return 0;
        const discovered = metrics.times_discovered || 0;
        const contacted = metrics.times_contacted || 0;
        const chosen = metrics.times_chosen || 0;
        // Composite: being discovered is basic, contacted is better, chosen is best
        // Use logarithmic scale so early interactions matter more (incentivizes new sellers)
        const discoveryScore = Math.min(1, Math.log10(discovered + 1) / 2); // 100 discovers = 1.0
        const contactScore = Math.min(1, Math.log10(contacted + 1) / 1.5); // ~30 contacts = 1.0
        const chosenScore = Math.min(1, Math.log10(chosen + 1) / 1); // 10 chosen = 1.0
        return discoveryScore * 0.3 + contactScore * 0.4 + chosenScore * 0.3;
    }
    communitySignal(_agentId) {
        // Phase 3: will use ratings, repeat buyers, external reviews.
        // For now, return a neutral 0.3 so it doesn't drag scores down
        // but also doesn't inflate them.
        return 0.3;
    }
    // ─── Helpers ───────────────────────────────────────────────
    isAgentClaimed(agentId) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status = 'verified'").get(agentId);
        return row.c > 0;
    }
    getLastActivityLabel(agentId) {
        const db = (0, init_1.getDb)();
        const agent = db.prepare("SELECT last_seen_at, created_at FROM agents WHERE id = ?").get(agentId);
        const knowledge = db.prepare("SELECT owner_updated_at, updated_at FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        const timestamps = [
            agent?.last_seen_at, agent?.created_at,
            knowledge?.owner_updated_at, knowledge?.updated_at,
        ].filter(Boolean);
        if (timestamps.length === 0)
            return "ukjent";
        const latest = timestamps.reduce((a, b) => (a > b ? a : b));
        const days = Math.floor((Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60 * 24));
        if (days === 0)
            return "i dag";
        if (days === 1)
            return "i går";
        if (days < 7)
            return `${days} dager siden`;
        if (days < 30)
            return `${Math.floor(days / 7)} uker siden`;
        if (days < 365)
            return `${Math.floor(days / 30)} måneder siden`;
        return `${Math.floor(days / 365)} år siden`;
    }
    getInteractionDetail(agentId) {
        const db = (0, init_1.getDb)();
        const metrics = db.prepare("SELECT times_discovered, times_contacted, times_chosen FROM agent_metrics WHERE agent_id = ?").get(agentId);
        if (!metrics)
            return "Ingen interaksjoner ennå";
        const parts = [];
        if (metrics.times_discovered)
            parts.push(`${metrics.times_discovered} oppdaget`);
        if (metrics.times_contacted)
            parts.push(`${metrics.times_contacted} kontaktet`);
        if (metrics.times_chosen)
            parts.push(`${metrics.times_chosen} valgt`);
        return parts.length > 0 ? parts.join(", ") : "Ingen interaksjoner ennå";
    }
}
// Singleton export
exports.trustScoreService = new TrustScoreService();
//# sourceMappingURL=trust-score-service.js.map
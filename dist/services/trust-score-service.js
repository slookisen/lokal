"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trustScoreService = void 0;
const init_1 = require("../database/init");
const WEIGHTS = {
    verification: 0.30,
    completeness: 0.20,
    freshness: 0.20,
    interaction: 0.20,
    community: 0.10,
};
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
const FRESHNESS_TIERS = [
    { maxDays: 7, score: 1.0 },
    { maxDays: 30, score: 0.8 },
    { maxDays: 90, score: 0.5 },
    { maxDays: 180, score: 0.2 },
];
const FRESHNESS_FLOOR = 0.05;
class TrustScoreService {
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
        return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
    }
    update(agentId) {
        const score = this.calculate(agentId);
        const db = (0, init_1.getDb)();
        db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?").run(score, agentId);
        return score;
    }
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
    getBreakdown(agentId) {
        const verification = this.verificationSignal(agentId);
        const completeness = this.completenessSignal(agentId);
        const freshness = this.freshnessSignal(agentId);
        const interaction = this.interactionSignal(agentId);
        const community = this.communitySignal(agentId);
        const score = this.calculate(agentId);
        const tips = [];
        if (verification < 0.5)
            tips.push("Krev din agent for aa oeke tillitsscoren med opptil 30%");
        if (completeness < 0.5)
            tips.push("Legg til produkter, aapningstider og adresse for bedre synlighet");
        if (completeness < 0.8 && completeness >= 0.5)
            tips.push("Legg til bilder og sertifiseringer for enda bedre score");
        if (freshness < 0.5)
            tips.push("Oppdater profilen din jevnlig - aktive agenter rangeres hoeyere");
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
    verificationSignal(agentId) {
        const db = (0, init_1.getDb)();
        const agent = db.prepare("SELECT is_verified FROM agents WHERE id = ?").get(agentId);
        if (!agent)
            return 0;
        if (agent.is_verified === 1)
            return 1.0;
        if (this.isAgentClaimed(agentId))
            return 0.4;
        const pendingClaim = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status IN ('pending', 'code_sent')").get(agentId);
        if (pendingClaim.c > 0)
            return 0.15;
        return 0.0;
    }
    completenessSignal(agentId) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        if (!row) {
            const agent = db.prepare("SELECT description, city, categories, tags FROM agents WHERE id = ?").get(agentId);
            if (!agent)
                return 0;
            let filled = 0;
            const total = 4;
            if (agent.description && agent.description.length > 20)
                filled++;
            if (agent.city)
                filled++;
            if (agent.categories && JSON.parse(agent.categories || "[]").length > 0)
                filled++;
            if (agent.tags && JSON.parse(agent.tags || "[]").length > 0)
                filled++;
            return (filled / total) * 0.3;
        }
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
                catch { /* invalid JSON = not filled */ }
            }
        }
        return filled / KNOWLEDGE_FIELDS.length;
    }
    freshnessSignal(agentId) {
        const db = (0, init_1.getDb)();
        const agent = db.prepare("SELECT last_seen_at, created_at FROM agents WHERE id = ?").get(agentId);
        const knowledge = db.prepare("SELECT owner_updated_at, last_enriched_at, updated_at FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        const metrics = db.prepare("SELECT last_interaction_at FROM agent_metrics WHERE agent_id = ?").get(agentId);
        const timestamps = [
            agent?.last_seen_at, agent?.created_at,
            knowledge?.owner_updated_at, knowledge?.last_enriched_at, knowledge?.updated_at,
            metrics?.last_interaction_at,
        ].filter(Boolean);
        if (timestamps.length === 0)
            return FRESHNESS_FLOOR;
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
        const discoveryScore = Math.min(1, Math.log10(discovered + 1) / 2);
        const contactScore = Math.min(1, Math.log10(contacted + 1) / 1.5);
        const chosenScore = Math.min(1, Math.log10(chosen + 1) / 1);
        return discoveryScore * 0.3 + contactScore * 0.4 + chosenScore * 0.3;
    }
    communitySignal(_agentId) {
        return 0.3;
    }
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
            return "i gaar";
        if (days < 7)
            return `${days} dager siden`;
        if (days < 30)
            return `${Math.floor(days / 7)} uker siden`;
        if (days < 365)
            return `${Math.floor(days / 30)} maaneder siden`;
        return `${Math.floor(days / 365)} aar siden`;
    }
    getInteractionDetail(agentId) {
        const db = (0, init_1.getDb)();
        const metrics = db.prepare("SELECT times_discovered, times_contacted, times_chosen FROM agent_metrics WHERE agent_id = ?").get(agentId);
        if (!metrics)
            return "Ingen interaksjoner ennaa";
        const parts = [];
        if (metrics.times_discovered)
            parts.push(`${metrics.times_discovered} oppdaget`);
        if (metrics.times_contacted)
            parts.push(`${metrics.times_contacted} kontaktet`);
        if (metrics.times_chosen)
            parts.push(`${metrics.times_chosen} valgt`);
        return parts.length > 0 ? parts.join(", ") : "Ingen interaksjoner ennaa";
    }
}
exports.trustScoreService = new TrustScoreService();
//# sourceMappingURL=trust-score-service.js.map
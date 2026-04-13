"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outreachService = void 0;
const init_1 = require("../database/init");
const email_service_1 = require("./email-service");
class OutreachService {
    DEFAULT_MAX_PER_HOUR = 20;
    DEFAULT_BATCH_SIZE = 5;
    // ─── Ensure contacted_at column exists ──────────────────
    // Safe to call multiple times — ALTER TABLE fails silently
    // if column already exists.
    ensureSchema() {
        const db = (0, init_1.getDb)();
        try {
            db.prepare("ALTER TABLE agents ADD COLUMN contacted_at TEXT").run();
            console.log("[Outreach] Added contacted_at column to agents table");
        }
        catch {
            // Column already exists — ignore
        }
    }
    // ─── Get outreach statistics ────────────────────────────
    getOutreachStats() {
        this.ensureSchema();
        const db = (0, init_1.getDb)();
        const totalAgents = db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get().c;
        const claimedAgents = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE status = 'verified'").get().c;
        const agentsWithEmail = db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1 AND contact_email IS NOT NULL AND contact_email != ''").get().c;
        const alreadyContacted = db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1 AND contacted_at IS NOT NULL").get().c;
        return {
            totalAgents,
            claimedAgents,
            unclaimedAgents: totalAgents - claimedAgents,
            agentsWithEmail,
            alreadyContacted,
            readyForOutreach: agentsWithEmail - alreadyContacted - claimedAgents,
        };
    }
    // ─── Preview what would be sent ─────────────────────────
    preview(options = {}) {
        const agents = this.fetchAgentsForOutreach(options);
        return agents.map(a => ({
            id: a.id,
            name: a.name,
            email: a.contact_email,
            city: a.city || "Ukjent",
        }));
    }
    // ─── Send outreach emails ──────────────────────────────
    async sendOutreach(options = {}) {
        this.ensureSchema();
        const startTime = Date.now();
        const dryRun = options.dryRun ?? false;
        const maxPerHour = options.maxPerHour ?? this.DEFAULT_MAX_PER_HOUR;
        const batchSize = options.batchSize ?? this.DEFAULT_BATCH_SIZE;
        console.log(`[Outreach] Starting ${dryRun ? "DRY RUN" : "LIVE"} campaign`);
        console.log(`[Outreach] Rate: ${maxPerHour}/hour, batch size: ${batchSize}`);
        const agents = this.fetchAgentsForOutreach(options);
        if (agents.length === 0) {
            console.log("[Outreach] No agents to contact");
            return { totalAgentsToContact: 0, emailsSent: 0, emailsFailed: 0, failedAgents: [], duration: 0 };
        }
        console.log(`[Outreach] Found ${agents.length} agents to contact`);
        const batches = this.createBatches(agents, batchSize);
        const delayMs = this.calculateDelayBetweenBatches(maxPerHour, batchSize);
        let emailsSent = 0;
        let emailsFailed = 0;
        const failedAgents = [];
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(`[Outreach] Batch ${i + 1}/${batches.length} (${batch.length} emails)`);
            for (const agent of batch) {
                try {
                    const baseUrl = process.env.BASE_URL || "https://lokal.fly.dev";
                    const agentPageUrl = `${baseUrl}/api/marketplace/agents/${agent.id}/info`;
                    const sellerName = this.extractFriendlyName(agent.name);
                    if (dryRun) {
                        console.log(`  [DRY] Would send to: ${agent.contact_email} (${agent.name}, ${agent.city})`);
                        emailsSent++;
                    }
                    else {
                        const result = await email_service_1.emailService.sendClaimInvitation(agent.id, agent.contact_email, sellerName, agent.name, agentPageUrl);
                        if (result.success) {
                            this.markAsContacted(agent.id);
                            emailsSent++;
                            console.log(`  ✓ Sent to ${agent.contact_email}`);
                        }
                        else {
                            emailsFailed++;
                            failedAgents.push({ id: agent.id, name: agent.name, error: result.error || "Ukjent feil" });
                            console.log(`  ✗ Failed: ${agent.contact_email} — ${result.error}`);
                        }
                    }
                }
                catch (err) {
                    emailsFailed++;
                    failedAgents.push({ id: agent.id, name: agent.name, error: err.message });
                }
            }
            // Delay between batches to respect rate limits
            if (i < batches.length - 1 && !dryRun) {
                console.log(`[Outreach] Waiting ${Math.round(delayMs / 1000)}s before next batch...`);
                await this.delay(delayMs);
            }
        }
        const result = {
            totalAgentsToContact: agents.length,
            emailsSent,
            emailsFailed,
            failedAgents,
            duration: Date.now() - startTime,
        };
        console.log(`[Outreach] ${dryRun ? "DRY RUN" : "Campaign"} complete:`, {
            sent: emailsSent,
            failed: emailsFailed,
            duration: `${Math.round(result.duration / 1000)}s`,
        });
        return result;
    }
    // ─── Fetch agents eligible for outreach ─────────────────
    fetchAgentsForOutreach(options) {
        const db = (0, init_1.getDb)();
        let sql = `
      SELECT a.id, a.name, a.contact_email, a.city, a.description, a.categories
      FROM agents a
      WHERE a.is_active = 1
        AND a.contact_email IS NOT NULL
        AND a.contact_email != ''
        AND a.contacted_at IS NULL
        AND a.id NOT IN (
          SELECT agent_id FROM agent_claims WHERE status = 'verified'
        )
    `;
        const params = [];
        if (options.filterByCity) {
            sql += " AND a.city = ?";
            params.push(options.filterByCity);
        }
        sql += " ORDER BY a.city, a.name";
        return db.prepare(sql).all(...params);
    }
    // ─── Mark agent as contacted ────────────────────────────
    markAsContacted(agentId) {
        const db = (0, init_1.getDb)();
        db.prepare("UPDATE agents SET contacted_at = datetime('now') WHERE id = ?").run(agentId);
    }
    // ─── Extract friendly name from agent name ──────────────
    // "Aker Gård Agent" → "Aker Gård"
    // "Bondens Butikk Vulkan — Mathallen Oslo" → "Bondens Butikk Vulkan"
    extractFriendlyName(agentName) {
        return agentName
            .replace(/\s+Agent$/i, "")
            .split(/\s*[—–-]\s*/)[0]
            .trim();
    }
    // ─── Helper: create batches ─────────────────────────────
    createBatches(items, batchSize) {
        const batches = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }
    // ─── Helper: calculate delay between batches ────────────
    calculateDelayBetweenBatches(maxPerHour, batchSize) {
        const secondsPerEmail = 3600 / maxPerHour;
        return secondsPerEmail * batchSize * 1000;
    }
    // ─── Helper: delay ──────────────────────────────────────
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
// Singleton
exports.outreachService = new OutreachService();
//# sourceMappingURL=outreach-service.js.map
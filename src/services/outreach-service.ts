import { getDb } from "../database/init";
import { emailService } from "./email-service";
import { knowledgeService } from "./knowledge-service";

// ─── Outreach Service ───────────────────────────────────────
// Manages seller outreach campaigns.
//
// Strategy: Contact unclaimed agents with contact_email set,
// in batches with rate limiting to avoid spam triggers.
//
// Uses our existing SQLite database — no external dependencies.

export interface OutreachStats {
  totalAgents: number;
  claimedAgents: number;
  unclaimedAgents: number;
  agentsWithEmail: number;
  alreadyContacted: number;
  readyForOutreach: number;
}

export interface OutreachResult {
  totalAgentsToContact: number;
  emailsSent: number;
  emailsFailed: number;
  failedAgents: Array<{ id: string; name: string; error: string }>;
  duration: number;
}

export interface OutreachOptions {
  dryRun?: boolean;
  maxPerHour?: number;
  batchSize?: number;
  filterByCity?: string;
  onlyUnclaimed?: boolean;
}

class OutreachService {
  private readonly DEFAULT_MAX_PER_HOUR = 20;
  private readonly DEFAULT_BATCH_SIZE = 5;

  // ─── Ensure contacted_at column exists ──────────────────
  // Safe to call multiple times — ALTER TABLE fails silently
  // if column already exists.
  ensureSchema(): void {
    const db = getDb();
    try {
      db.prepare("ALTER TABLE agents ADD COLUMN contacted_at TEXT").run();
      console.log("[Outreach] Added contacted_at column to agents table");
    } catch {
      // Column already exists — ignore
    }
  }

  // ─── Get outreach statistics ────────────────────────────
  getOutreachStats(): OutreachStats {
    this.ensureSchema();
    const db = getDb();

    const totalAgents = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get() as any).c;
    const claimedAgents = (db.prepare(
      "SELECT COUNT(*) as c FROM agent_claims WHERE status = 'verified'"
    ).get() as any).c;
    const agentsWithEmail = (db.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE is_active = 1 AND contact_email IS NOT NULL AND contact_email != ''"
    ).get() as any).c;
    const alreadyContacted = (db.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE is_active = 1 AND contacted_at IS NOT NULL"
    ).get() as any).c;

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
  preview(options: OutreachOptions = {}): Array<{
    id: string;
    name: string;
    email: string;
    city: string;
  }> {
    const agents = this.fetchAgentsForOutreach(options);
    return agents.map(a => ({
      id: a.id,
      name: a.name,
      email: a.contact_email,
      city: a.city || "Ukjent",
    }));
  }

  // ─── Send outreach emails ──────────────────────────────
  async sendOutreach(options: OutreachOptions = {}): Promise<OutreachResult> {
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
    const failedAgents: OutreachResult["failedAgents"] = [];

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
          } else {
            const result = await emailService.sendClaimInvitation(
              agent.id,
              agent.contact_email,
              sellerName,
              agent.name,
              agentPageUrl,
            );

            if (result.success) {
              this.markAsContacted(agent.id);
              emailsSent++;
              console.log(`  ✓ Sent to ${agent.contact_email}`);
            } else {
              emailsFailed++;
              failedAgents.push({ id: agent.id, name: agent.name, error: result.error || "Ukjent feil" });
              console.log(`  ✗ Failed: ${agent.contact_email} — ${result.error}`);
            }
          }
        } catch (err: any) {
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

    const result: OutreachResult = {
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
  private fetchAgentsForOutreach(options: OutreachOptions): any[] {
    const db = getDb();

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

    const params: any[] = [];

    if (options.filterByCity) {
      sql += " AND a.city = ?";
      params.push(options.filterByCity);
    }

    sql += " ORDER BY a.city, a.name";

    return db.prepare(sql).all(...params);
  }

  // ─── Mark agent as contacted ────────────────────────────
  private markAsContacted(agentId: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET contacted_at = datetime('now') WHERE id = ?").run(agentId);
  }

  // ─── Extract friendly name from agent name ──────────────
  // "Aker Gård Agent" → "Aker Gård"
  // "Bondens Butikk Vulkan — Mathallen Oslo" → "Bondens Butikk Vulkan"
  private extractFriendlyName(agentName: string): string {
    return agentName
      .replace(/\s+Agent$/i, "")
      .split(/\s*[—–-]\s*/)[0]
      .trim();
  }

  // ─── Helper: create batches ─────────────────────────────
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  // ─── Helper: calculate delay between batches ────────────
  private calculateDelayBetweenBatches(maxPerHour: number, batchSize: number): number {
    const secondsPerEmail = 3600 / maxPerHour;
    return secondsPerEmail * batchSize * 1000;
  }

  // ─── Helper: delay ──────────────────────────────────────
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton
export const outreachService = new OutreachService();

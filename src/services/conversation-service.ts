import { v4 as uuid } from "uuid";
import { getDb } from "../database/init";
import { interactionLogger } from "./interaction-logger";
import { marketplaceRegistry } from "./marketplace-registry";
import { knowledgeService } from "./knowledge-service";

// ─── Conversation Service ───────────────────────────────────
// This is what makes Lokal an OPERATOR, not just a registry.
//
// Flow:
//   1. Buyer agent searches → gets results
//   2. Buyer picks a seller → conversation created
//   3. System posts initial match message
//   4. Seller responds with offer (price, availability)
//   5. Buyer accepts → transaction recorded
//   6. Both agents build reputation
//
// Every step is logged. The conversation is the unit of value
// — it's how we measure that Lokal creates real connections.

export type ConversationStatus = "open" | "negotiating" | "accepted" | "completed" | "expired" | "cancelled";
export type MessageType = "text" | "offer" | "accept" | "reject" | "info";
export type SenderRole = "buyer" | "seller" | "system";

export type ConversationSource = "a2a" | "mcp" | "web" | "api";

export interface Conversation {
  id: string;
  buyerAgentId?: string;
  buyerAgentName?: string;
  sellerAgentId: string;
  sellerAgentName?: string;
  status: ConversationStatus;
  queryText?: string;
  taskId?: string;
  source: ConversationSource;
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderRole: SenderRole;
  senderAgentId?: string;
  senderAgentName?: string;
  content: string;
  messageType: MessageType;
  metadata: Record<string, any>;
  createdAt: string;
}

class ConversationService {
  // ─── Start a conversation ────────────────────────────────
  // Called when a buyer agent wants to connect with a seller.
  // The seller agent auto-responds with relevant info from its
  // knowledge base — no LLM needed, pure template logic.
  startConversation(opts: {
    buyerAgentId?: string;
    sellerAgentId: string;
    queryText?: string;
    taskId?: string;
    source?: "a2a" | "mcp" | "web" | "api";
    autoRespond?: boolean;  // default true — seller agent replies automatically
  }): Conversation {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();
    const source = opts.source || "api";

    db.prepare(`
      INSERT INTO conversations (id, buyer_agent_id, seller_agent_id, status, query_text, task_id, source, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `).run(id, opts.buyerAgentId || null, opts.sellerAgentId, opts.queryText || null, opts.taskId || null, source, now, now);

    // Get seller info for the system message
    const seller = db.prepare("SELECT name, categories, city FROM agents WHERE id = ?").get(opts.sellerAgentId) as any;
    const sellerName = seller?.name || "Ukjent selger";
    const sellerCity = seller?.city || "";
    const sellerCategories = seller?.categories ? JSON.parse(seller.categories).join(", ") : "";

    // System message introducing the match
    const systemMsg = opts.queryText
      ? `Søk: "${opts.queryText}" → Match: ${sellerName} (${sellerCity}). Kategorier: ${sellerCategories}.`
      : `Ny samtale startet med ${sellerName} (${sellerCity}).`;

    this.addMessage({
      conversationId: id,
      senderRole: "system",
      content: systemMsg,
      messageType: "info",
      metadata: { sellerAgentId: opts.sellerAgentId, queryText: opts.queryText, source },
    });

    // ─── Seller agent auto-response ──────────────────────────
    // The seller agent "wakes up" and responds with what it knows.
    // This is template-based, using the knowledge we've enriched.
    if (opts.autoRespond !== false) {
      const autoReply = this.generateSellerResponse(opts.sellerAgentId, opts.queryText);
      if (autoReply) {
        this.addMessage({
          conversationId: id,
          senderRole: "seller",
          senderAgentId: opts.sellerAgentId,
          content: autoReply.text,
          messageType: autoReply.type,
          metadata: autoReply.metadata,
        });
      }
    }

    // Log the interaction
    interactionLogger.log("message", {
      agentId: opts.buyerAgentId,
      query: opts.queryText,
      matchedAgentIds: [opts.sellerAgentId],
      metadata: { conversationId: id, type: "conversation_started", source },
    });

    // Update seller metrics
    this.incrementMetric(opts.sellerAgentId, "times_contacted");

    return this.getConversation(id)!;
  }

  // ─── Seller agent auto-response generator ─────────────────
  // Uses knowledge data to craft a helpful, natural response.
  // No LLM needed — templates + data = good enough for v1.
  generateSellerResponse(
    sellerAgentId: string,
    queryText?: string
  ): { text: string; type: MessageType; metadata: Record<string, any> } | null {
    const info = knowledgeService.getAgentInfo(sellerAgentId);
    if (!info) return null;

    const { agent, knowledge: k } = info;
    const parts: string[] = [];
    const meta: Record<string, any> = { autoGenerated: true };

    // Greeting
    parts.push(`Hei fra ${agent.name}! 👋`);

    // Match query to relevant products if possible
    const queryLower = (queryText || "").toLowerCase();
    const matchedProducts = (k.products || []).filter((p: any) => {
      if (!queryLower) return true;
      const pName = (p.name || "").toLowerCase();
      const pCat = (p.category || "").toLowerCase();
      return queryLower.includes(pName) || pName.includes(queryLower)
        || queryLower.includes(pCat) || pCat.includes(queryLower);
    });

    // If we have matching products, show them. Otherwise show all (up to 5).
    const productsToShow = matchedProducts.length > 0
      ? matchedProducts.slice(0, 5)
      : (k.products || []).slice(0, 5);

    if (productsToShow.length > 0) {
      const intro = matchedProducts.length > 0
        ? "Vi har det du leter etter:"
        : "Her er noe av det vi tilbyr:";
      parts.push(intro);
      for (const p of productsToShow) {
        const seasonal = p.seasonal && p.months?.length
          ? ` (sesong: ${p.months.map((m: number) => ["", "jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"][m] || m).join(", ")})`
          : "";
        const organic = p.organic ? " 🌿 økologisk" : "";
        parts.push(`• ${p.name}${p.category ? ` — ${p.category}` : ""}${organic}${seasonal}`);
      }
      meta.products = productsToShow;
    }

    // Specialties
    if (k.specialties?.length) {
      parts.push(`\nSpesialiteter: ${k.specialties.join(", ")}`);
    }

    // Opening hours
    if (k.openingHours?.length) {
      const dayNames: Record<string, string> = {
        mon: "Man", tue: "Tir", wed: "Ons", thu: "Tor", fri: "Fre", sat: "Lør", sun: "Søn",
        monday: "Man", tuesday: "Tir", wednesday: "Ons", thursday: "Tor", friday: "Fre", saturday: "Lør", sunday: "Søn"
      };
      const hours = k.openingHours.slice(0, 7).map((h: any) =>
        `${dayNames[h.day] || h.day} ${h.open}–${h.close}`
      ).join(", ");
      parts.push(`\n🕐 Åpningstider: ${hours}`);
    }

    // Contact info
    const contact: string[] = [];
    if (k.address) contact.push(`📍 ${k.address}${k.postalCode ? `, ${k.postalCode}` : ""}`);
    if (k.phone) contact.push(`📞 ${k.phone}`);
    if (k.email) contact.push(`✉️ ${k.email}`);
    if (k.website) contact.push(`🌐 ${k.website}`);
    if (contact.length) {
      parts.push(`\nKontakt oss:\n${contact.join("\n")}`);
    }

    // Delivery info
    if (k.deliveryOptions?.length) {
      let deliveryLine = `🚚 Levering: ${k.deliveryOptions.join(", ")}`;
      if (k.deliveryRadius) deliveryLine += ` (inntil ${k.deliveryRadius} km)`;
      if (k.minOrderValue) deliveryLine += ` — min. bestilling ${k.minOrderValue} kr`;
      parts.push(deliveryLine);
    }

    // Payment methods
    if (k.paymentMethods?.length) {
      parts.push(`💳 Betaling: ${k.paymentMethods.join(", ")}`);
    }

    // Certifications as trust signal
    if (k.certifications?.length) {
      parts.push(`✅ ${k.certifications.join(", ")}`);
    }

    // Closing
    parts.push("\nTa gjerne kontakt for spørsmål eller bestilling!");

    // Determine message type: if we have products with potential pricing, it's an "offer"
    const msgType: MessageType = productsToShow.length > 0 ? "offer" : "text";

    return {
      text: parts.join("\n"),
      type: msgType,
      metadata: meta,
    };
  }

  // ─── Add a message to a conversation ─────────────────────
  addMessage(opts: {
    conversationId: string;
    senderRole: SenderRole;
    senderAgentId?: string;
    content: string;
    messageType?: MessageType;
    metadata?: Record<string, any>;
  }): ConversationMessage {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_role, sender_agent_id, content, message_type, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.conversationId, opts.senderRole,
      opts.senderAgentId || null, opts.content,
      opts.messageType || "text",
      JSON.stringify(opts.metadata || {}), now
    );

    // Update conversation timestamp + status
    if (opts.messageType === "offer") {
      db.prepare("UPDATE conversations SET status = 'negotiating', updated_at = ? WHERE id = ?").run(now, opts.conversationId);
    } else if (opts.messageType === "accept") {
      db.prepare("UPDATE conversations SET status = 'accepted', updated_at = ? WHERE id = ?").run(now, opts.conversationId);
    } else if (opts.messageType === "reject") {
      db.prepare("UPDATE conversations SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, opts.conversationId);
    } else {
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, opts.conversationId);
    }

    // Emit for SSE
    const msg = this.getMessage(id)!;
    interactionLogger.emit("message", msg);

    return msg;
  }

  // ─── Complete a transaction ──────────────────────────────
  completeTransaction(conversationId: string, opts: {
    totalAmountNok?: number;
    products?: string[];
  } = {}): Conversation {
    const db = getDb();
    const now = new Date().toISOString();
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error("Conversation not found");

    db.prepare("UPDATE conversations SET status = 'completed', updated_at = ? WHERE id = ?").run(now, conversationId);

    // System message
    this.addMessage({
      conversationId,
      senderRole: "system",
      content: opts.totalAmountNok
        ? `Handel fullført! Totalbeløp: ${opts.totalAmountNok} NOK.`
        : "Handel fullført!",
      messageType: "info",
      metadata: { ...opts, type: "transaction_complete" },
    });

    // Update seller metrics
    this.incrementMetric(conv.sellerAgentId, "times_chosen");
    if (opts.totalAmountNok) {
      this.addRevenue(conv.sellerAgentId, opts.totalAmountNok);
    }

    // Log transaction
    interactionLogger.log("transaction", {
      agentId: conv.buyerAgentId,
      matchedAgentIds: [conv.sellerAgentId],
      metadata: {
        conversationId,
        totalAmountNok: opts.totalAmountNok,
        products: opts.products,
      },
    });

    // Recalculate seller trust score based on real performance
    try {
      marketplaceRegistry.recalculateTrustScore(conv.sellerAgentId);
    } catch { /* non-critical */ }

    // Check if this is a repeat buyer
    if (conv.buyerAgentId) {
      const prevDeals = (db.prepare(`
        SELECT COUNT(*) as c FROM conversations
        WHERE buyer_agent_id = ? AND seller_agent_id = ? AND status = 'completed' AND id != ?
      `).get(conv.buyerAgentId, conv.sellerAgentId, conversationId) as any).c;

      if (prevDeals > 0) {
        // Repeat buyer — update metric
        db.prepare(`
          UPDATE agent_metrics SET repeat_buyer_count = repeat_buyer_count + 1, updated_at = ?
          WHERE agent_id = ?
        `).run(now, conv.sellerAgentId);
      }
    }

    return this.getConversation(conversationId)!;
  }

  // ─── Get a conversation with messages ────────────────────
  getConversation(id: string): Conversation | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT c.*,
        ba.name as buyer_name,
        sa.name as seller_name
      FROM conversations c
      LEFT JOIN agents ba ON c.buyer_agent_id = ba.id
      LEFT JOIN agents sa ON c.seller_agent_id = sa.id
      WHERE c.id = ?
    `).get(id) as any;

    if (!row) return null;

    const messages = this.getMessages(id);
    return {
      id: row.id,
      buyerAgentId: row.buyer_agent_id,
      buyerAgentName: row.buyer_name,
      sellerAgentId: row.seller_agent_id,
      sellerAgentName: row.seller_name,
      status: row.status,
      queryText: row.query_text,
      taskId: row.task_id,
      source: row.source || "api",
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ─── List recent conversations ──────────────────────────
  listConversations(opts: { limit?: number; status?: string; agentId?: string } = {}): Conversation[] {
    const db = getDb();
    let sql = `
      SELECT c.*,
        ba.name as buyer_name,
        sa.name as seller_name
      FROM conversations c
      LEFT JOIN agents ba ON c.buyer_agent_id = ba.id
      LEFT JOIN agents sa ON c.seller_agent_id = sa.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (opts.status) { sql += " AND c.status = ?"; params.push(opts.status); }
    if (opts.agentId) {
      sql += " AND (c.buyer_agent_id = ? OR c.seller_agent_id = ?)";
      params.push(opts.agentId, opts.agentId);
    }
    sql += " ORDER BY c.updated_at DESC LIMIT ?";
    params.push(opts.limit || 50);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      buyerAgentId: row.buyer_agent_id,
      buyerAgentName: row.buyer_name,
      sellerAgentId: row.seller_agent_id,
      sellerAgentName: row.seller_name,
      status: row.status,
      queryText: row.query_text,
      taskId: row.task_id,
      source: row.source || "api",
      messages: this.getMessages(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // ─── Get agent metrics (seller dashboard / social proof) ─
  getAgentMetrics(agentId: string): any {
    const db = getDb();
    // Ensure row exists
    db.prepare(`
      INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)
    `).run(agentId);

    const metrics = db.prepare("SELECT * FROM agent_metrics WHERE agent_id = ?").get(agentId) as any;
    const agent = db.prepare("SELECT name, city, categories FROM agents WHERE id = ?").get(agentId) as any;

    return {
      agentId,
      agentName: agent?.name,
      city: agent?.city,
      categories: agent?.categories ? JSON.parse(agent.categories) : [],
      timesDiscovered: metrics.times_discovered,
      timesContacted: metrics.times_contacted,
      timesChosen: metrics.times_chosen,
      totalRevenueNok: metrics.total_revenue_nok,
      repeatBuyerCount: metrics.repeat_buyer_count,
      conversionRate: metrics.times_discovered > 0
        ? ((metrics.times_chosen / metrics.times_discovered) * 100).toFixed(1) + "%"
        : "0%",
      lastInteractionAt: metrics.last_interaction_at,
    };
  }

  // ─── Leaderboard (social proof) ──────────────────────────
  getLeaderboard(limit = 10): any[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.*, a.name, a.city, a.categories, a.trust_score
      FROM agent_metrics m
      JOIN agents a ON m.agent_id = a.id
      WHERE a.is_active = 1
      ORDER BY m.times_chosen DESC, m.times_contacted DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      agentId: r.agent_id,
      agentName: r.name,
      city: r.city,
      categories: r.categories ? JSON.parse(r.categories) : [],
      trustScore: r.trust_score,
      timesDiscovered: r.times_discovered,
      timesContacted: r.times_contacted,
      timesChosen: r.times_chosen,
      totalRevenueNok: r.total_revenue_nok,
      repeatBuyerCount: r.repeat_buyer_count,
    }));
  }

  // ─── Private helpers ─────────────────────────────────────

  private getMessages(conversationId: string): ConversationMessage[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.*, a.name as sender_name
      FROM messages m
      LEFT JOIN agents a ON m.sender_agent_id = a.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `).all(conversationId) as any[];

    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      senderRole: r.sender_role,
      senderAgentId: r.sender_agent_id,
      senderAgentName: r.sender_name,
      content: r.content,
      messageType: r.message_type,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      createdAt: r.created_at,
    }));
  }

  private getMessage(id: string): ConversationMessage | null {
    const db = getDb();
    const r = db.prepare(`
      SELECT m.*, a.name as sender_name
      FROM messages m
      LEFT JOIN agents a ON m.sender_agent_id = a.id
      WHERE m.id = ?
    `).get(id) as any;

    if (!r) return null;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      senderRole: r.sender_role,
      senderAgentId: r.sender_agent_id,
      senderAgentName: r.sender_name,
      content: r.content,
      messageType: r.message_type,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      createdAt: r.created_at,
    };
  }

  private incrementMetric(agentId: string, field: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)`).run(agentId);
      db.prepare(`UPDATE agent_metrics SET ${field} = ${field} + 1, last_interaction_at = ?, updated_at = ? WHERE agent_id = ?`)
        .run(now, now, agentId);
    } catch { /* non-critical */ }
  }

  private addRevenue(agentId: string, amount: number): void {
    const db = getDb();
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)`).run(agentId);
      db.prepare(`UPDATE agent_metrics SET total_revenue_nok = total_revenue_nok + ?, updated_at = ? WHERE agent_id = ?`)
        .run(amount, now, agentId);
    } catch { /* non-critical */ }
  }
}

// Singleton
export const conversationService = new ConversationService();

import { v4 as uuid } from "uuid";
import { getDb } from "../database/init";
import { interactionLogger } from "./interaction-logger";
import { marketplaceRegistry } from "./marketplace-registry";
import { knowledgeService, parseProductPrice, isProductHeader, isProductNoise } from "./knowledge-service";
import { slugify } from "../utils/slug";

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

// ─── Internal-traffic classification (rfb-samtaler item 3) ───────────────────
// Public /samtaler counters must report EXTERNAL traffic only. A conversation
// is "internal" when it originates from OUR OWN tooling talking to itself:
// verifier probes, loop-dispatcher / fleet runs, health checks, and owner /
// admin / CI requests. We classify CONSERVATIVELY on purpose — a FALSE POSITIVE
// (flagging real external traffic as internal) HIDES real traffic, the exact
// opposite of this feature's goal — so we only flag on signals no third party
// could plausibly emit, and err toward NOT flagging when unsure.
//
// The EXACT rules (all evaluated at write-time from the live HTTP request):
//   1. hasValidAdminKey — the request carried an `X-Admin-Key` header whose
//      value equals our secret ADMIN_KEY / ANALYTICS_ADMIN_KEY. The key is a
//      secret, so a match is definitively our own CI / admin / fleet tooling.
//   2. ownerCookie — the `_rfb_owner=1` cookie our own owner/dev browser sets
//      (the same marker analytics-service uses to strip owner traffic).
//   3. Own-only User-Agent markers — UA substrings only OUR scheduled probes
//      emit: RFB-* (e.g. RFB-ContactVerifier, RFB-HealthCheck), Lokal-* tools,
//      and explicit verifier / loop-dispatcher / fleet / health-check tokens.
//
// DELIBERATELY NOT treated as internal: generic HTTP-client UAs (curl/,
// node-fetch, axios/, python-requests, bare "node" / "python"). External
// A2A / MCP / API agents legitimately use those clients, so flagging them would
// hide large amounts of REAL external traffic. (analytics-service treats those
// as "owner" for its dashboard, but here the cost of a false positive is higher
// — it undermines the trust the page exists to build — so we exclude them and
// accept the resulting false-negatives, which are the safe direction.)
const INTERNAL_UA_MARKERS_LC = [
  "rfb-",                 // RFB-ContactVerifier, RFB-HealthCheck, other RFB-* probes
  "lokal-enricher",
  "lokal-verifier",
  "lokal-agent-verifier",
  "loop-dispatcher",
  "loop-dispatch",
  "fleet-agent",
  "fleet-runner",
  "health-check",
  "healthcheck",
];

export interface RequestMeta {
  userAgent?: string;
  hasValidAdminKey?: boolean;
  ownerCookie?: boolean;
}

function expectedAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

// Extract the classification-relevant signals from an Express-style request.
// Kept structural (no express import) so it is trivially unit-testable and can
// be reused by both the conversation-creation callers and the /samtaler
// admin-view gate. Never throws on a malformed/absent request.
export function buildRequestMeta(
  req: { headers?: Record<string, any> } | undefined | null
): RequestMeta {
  if (!req || !req.headers) return {};
  const headers = req.headers;
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"] : undefined;
  const expected = expectedAdminKey();
  const provided = typeof headers["x-admin-key"] === "string" ? headers["x-admin-key"] : "";
  const hasValidAdminKey = !!expected && provided === expected;
  const cookie = typeof headers["cookie"] === "string" ? headers["cookie"] : "";
  const ownerCookie = cookie.split(";").some((c: string) => c.trim() === "_rfb_owner=1");
  return { userAgent, hasValidAdminKey, ownerCookie };
}

// Conservative internal-traffic classifier. Returns true ONLY when confident.
export function isInternalTraffic(meta?: RequestMeta | null): boolean {
  if (!meta) return false;
  if (meta.hasValidAdminKey) return true;   // secret key matched → definitely us
  if (meta.ownerCookie) return true;        // owner / dev browser
  const ua = (meta.userAgent || "").toLowerCase();
  if (ua && INTERNAL_UA_MARKERS_LC.some(m => ua.includes(m))) return true;
  return false;
}

export interface Conversation {
  id: string;
  buyerAgentId?: string;
  buyerAgentName?: string;
  sellerAgentId?: string;   // absent for verticals with no agents-table seller row (see startConversation)
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
    buyerAgentName?: string;
    // sellerAgentId is OPTIONAL: verticals without an `agents`-table row per
    // listing (e.g. experiences, whose providers live in the separate
    // experience_providers table) log conversations with no seller agent.
    // `seller_agent_id` has a live FK to agents(id) (foreign_keys=ON) — NULL
    // is the only safe value when there is no real agents row; a made-up
    // string would throw a FK-constraint error on insert.
    sellerAgentId?: string;
    sellerName?: string;       // display fallback when sellerAgentId is absent (no DB lookup)
    queryText?: string;
    taskId?: string;
    source?: "a2a" | "mcp" | "web" | "api";
    clientIdentity?: string;   // e.g. "ChatGPT", "Claude Desktop", "Cursor"
    requestMeta?: RequestMeta; // classification signals from the live request (UA / admin-key / owner-cookie)
    autoRespond?: boolean;  // default true — seller agent replies automatically
    verticalId?: string;    // default 'rfb' — per-vertical scoping (Phase 4.6b)
  }): Conversation {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();
    const source = opts.source || "api";
    const verticalId = opts.verticalId || "rfb";

    // (item 3) Classify at write-time. Conservative: only confident-internal
    // requests are flagged; everything else stays 0 (external, publicly counted).
    const isInternal = isInternalTraffic(opts.requestMeta) ? 1 : 0;

    db.prepare(`
      INSERT INTO conversations (id, buyer_agent_id, seller_agent_id, status, query_text, task_id, source, is_internal, vertical_id, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, opts.buyerAgentId || null, opts.sellerAgentId || null, opts.queryText || null, opts.taskId || null, source, isInternal, verticalId, now, now);

    // Get seller info for the system message — only when there IS a seller
    // agent row to look up (see sellerAgentId doc above).
    let sellerName = opts.sellerName || "Ukjent selger";
    let sellerCity = "";
    let sellerCategories = "";
    if (opts.sellerAgentId) {
      const seller = db.prepare("SELECT name, categories, city FROM agents WHERE id = ?").get(opts.sellerAgentId) as any;
      sellerName = seller?.name || sellerName;
      sellerCity = seller?.city || "";
      sellerCategories = seller?.categories ? JSON.parse(seller.categories).join(", ") : "";
    }

    // System message introducing the match
    const clientTag = opts.clientIdentity ? ` via ${opts.clientIdentity}` : "";
    const systemMsg = !opts.sellerAgentId
      ? (opts.queryText ? `Søk: "${opts.queryText}".${clientTag}` : `Ny samtale startet.${clientTag}`)
      : opts.queryText
        ? `Søk: "${opts.queryText}" → Match: ${sellerName} (${sellerCity}). Kategorier: ${sellerCategories}.${clientTag}`
        : `Ny samtale startet med ${sellerName} (${sellerCity}).${clientTag}`;

    this.addMessage({
      conversationId: id,
      senderRole: "system",
      content: systemMsg,
      messageType: "info",
      // Persist the classification-relevant UA (a non-PII client string, same
      // class as the already-stored clientIdentity) on the opening system
      // message so the history backfill can re-apply the SAME rules and so the
      // write-time decision is auditable/reversible.
      metadata: { sellerAgentId: opts.sellerAgentId, queryText: opts.queryText, source, ...(opts.clientIdentity ? { clientIdentity: opts.clientIdentity } : {}), ...(opts.requestMeta?.userAgent ? { ua: opts.requestMeta.userAgent } : {}) },
      verticalId,
    });

    // ─── Seller agent auto-response ──────────────────────────
    // The seller agent "wakes up" and responds with what it knows.
    // This is template-based, using the knowledge we've enriched.
    // No-op without a real seller agent row (nothing to look up a knowledge base for).
    if (opts.autoRespond !== false && opts.sellerAgentId) {
      const autoReply = this.generateSellerResponse(opts.sellerAgentId, opts.queryText);
      if (autoReply) {
        this.addMessage({
          conversationId: id,
          senderRole: "seller",
          senderAgentId: opts.sellerAgentId,
          content: autoReply.text,
          messageType: autoReply.type,
          metadata: autoReply.metadata,
          verticalId,
        });
      }
    }

    // Log the interaction — RFB ONLY. interactionLogger is a single
    // process-wide singleton that feeds RFB's PUBLIC /api/live SSE dashboard
    // and /api/interactions(/stats) endpoints (see routes/a2a.ts) — none of
    // which are vertical-aware. Un-gating this for other verticals would leak
    // opplevagent query text/conversation ids onto RFB's public activity feed
    // and inflate its public counters, which is exactly the regression the
    // vertical-filter work in this file exists to prevent.
    if (verticalId === "rfb") {
      interactionLogger.log("message", {
        agentId: opts.buyerAgentId,
        query: opts.queryText,
        matchedAgentIds: opts.sellerAgentId ? [opts.sellerAgentId] : [],
        metadata: { conversationId: id, type: "conversation_started", source },
      });
    }

    // Update seller metrics — only when there IS a seller agent row.
    if (opts.sellerAgentId) {
      this.incrementMetric(opts.sellerAgentId, "times_contacted");
    }

    // Pass verticalId through explicitly: getConversation()'s default filter
    // is 'rfb' (see its doc), which would wrongly hide the row we just wrote
    // for any other vertical.
    return this.getConversation(id, { verticalId })!;
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
    // Defensive: some agents have a non-array `products` field (string or null);
    // "|| []" doesn't protect against that — use Array.isArray.
    const productsList = Array.isArray(k.products) ? k.products : [];
    const allProducts = productsList.filter((p: any) => {
      const name = (p.name || "").trim();
      return name && !isProductNoise(name) && !isProductHeader(name);
    });

    const matchedProducts = queryLower ? allProducts.filter((p: any) => {
      const pName = (p.name || "").toLowerCase();
      const pCat = (p.category || "").toLowerCase();
      return queryLower.split(/\s+/).some((word: string) =>
        word.length > 2 && (pName.includes(word) || pCat.includes(word))
      );
    }) : [];

    // Show matched products (all of them) or a compact overview of all products
    if (matchedProducts.length > 0) {
      parts.push(`Vi har det du leter etter:`);
      for (const p of matchedProducts.slice(0, 15)) {
        const { cleanName, price } = parseProductPrice(p);
        const priceStr = price ? ` — ${price}` : "";
        const organic = p.organic ? " 🌿" : "";
        parts.push(`• ${cleanName}${priceStr}${organic}`);
      }
      if (matchedProducts.length > 15) {
        parts.push(`  _...og ${matchedProducts.length - 15} flere_`);
      }
      meta.products = matchedProducts;
    } else if (allProducts.length > 0) {
      // Show all products grouped by section headers from the original data
      parts.push(`Her er det vi tilbyr (${allProducts.length} produkter):`);
      let currentSection = "";
      let shown = 0;
      for (const p of productsList) {
        const name = (p.name || "").trim();
        if (!name) continue;
        if (isProductNoise(name)) continue;

        // Section header
        if (isProductHeader(name)) {
          const headerText = name.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, "").trim();
          if (headerText && headerText !== currentSection) {
            currentSection = headerText;
            parts.push(`\n**${headerText}**`);
          }
          continue;
        }

        const { cleanName, price } = parseProductPrice(p);
        const priceStr = price ? ` — ${price}` : "";
        parts.push(`• ${cleanName}${priceStr}`);
        shown++;
        if (shown >= 30) {
          parts.push(`  _...og ${allProducts.length - shown} flere produkter_`);
          break;
        }
      }
      meta.products = allProducts;
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

    // Profile link
    const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
    const slug = slugify(agent.name);
    parts.push(`\n🔗 Se profilen vår: ${BASE_URL}/produsent/${slug}`);

    // Closing
    parts.push("\nTa gjerne kontakt for spørsmål eller bestilling!");

    // Determine message type: if we have products with potential pricing, it's an "offer"
    const msgType: MessageType = allProducts.length > 0 ? "offer" : "text";

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
    verticalId?: string;    // default 'rfb' — should match the parent conversation's vertical
  }): ConversationMessage {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_role, sender_agent_id, content, message_type, metadata, vertical_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.conversationId, opts.senderRole,
      opts.senderAgentId || null, opts.content,
      opts.messageType || "text",
      JSON.stringify(opts.metadata || {}), opts.verticalId || "rfb", now
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

    // Emit for SSE — RFB ONLY (see the matching gate + rationale in
    // startConversation() above: interactionLogger's SSE feed and
    // /api/interactions endpoints are RFB-public and not vertical-aware).
    const msg = this.getMessage(id)!;
    if ((opts.verticalId || "rfb") === "rfb") {
      interactionLogger.emit("message", msg);
    }

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
    // Transactions are an RFB-only marketplace concept (buyer/seller deal
    // completion) and always have a real seller agent — the optional
    // sellerAgentId on startConversation is for the seller-less vertical
    // conversations (e.g. experiences) that never reach completeTransaction.
    if (!conv.sellerAgentId) throw new Error("completeTransaction: conversation has no seller agent");

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
  // vertical-filter (Phase 4.6b-minimum, dev-request 2026-07-10-opplevagent-conversation-logging):
  // defaults to 'rfb' when verticalId is omitted so every pre-existing RFB call
  // site (all rows were 'rfb' before any other vertical logged conversations)
  // is byte-for-byte unchanged. Pass the row's own vertical explicitly when
  // fetching a just-written non-'rfb' conversation (see startConversation).
  getConversation(id: string, opts: { verticalId?: string } = {}): Conversation | null {
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
    if (row.vertical_id !== (opts.verticalId || "rfb")) return null;

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
  // vertical-filter: same default-'rfb' contract as getConversation() above.
  listConversations(opts: { limit?: number; status?: string; agentId?: string; source?: string; includeInternal?: boolean; verticalId?: string } = {}): Conversation[] {
    const db = getDb();
    let sql = `
      SELECT c.*,
        ba.name as buyer_name,
        sa.name as seller_name
      FROM conversations c
      LEFT JOIN agents ba ON c.buyer_agent_id = ba.id
      LEFT JOIN agents sa ON c.seller_agent_id = sa.id
      WHERE c.vertical_id = ?
    `;
    const params: any[] = [opts.verticalId || "rfb"];

    // (item 3) Public list = external traffic only. Admin path opts-in to all.
    if (!opts.includeInternal) { sql += " AND (c.is_internal IS NULL OR c.is_internal = 0)"; }
    if (opts.status) { sql += " AND c.status = ?"; params.push(opts.status); }
    if (opts.source) { sql += " AND c.source = ?"; params.push(opts.source); }
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

  // ─── Conversation stats by source ─────────────────────────
  // (item 3) PUBLIC counters exclude internal fleet/verifier traffic by default
  // — a verifier probe run must NOT increment the numbers a visitor sees. Pass
  // { includeInternal: true } for the ADMIN view, which still shows full totals.
  // vertical-filter: same default-'rfb' contract as getConversation() above.
  getSourceStats(opts: { includeInternal?: boolean; verticalId?: string } = {}): { source: string; count: number; lastActivity: string }[] {
    const db = getDb();
    let where = "WHERE vertical_id = ?";
    const params: any[] = [opts.verticalId || "rfb"];
    if (!opts.includeInternal) { where += " AND (is_internal IS NULL OR is_internal = 0)"; }
    const rows = db.prepare(`
      SELECT COALESCE(source, 'api') as source, COUNT(*) as count,
        MAX(updated_at) as last_activity
      FROM conversations
      ${where}
      GROUP BY COALESCE(source, 'api')
      ORDER BY count DESC
    `).all(...params) as any[];
    return rows.map(r => ({ source: r.source, count: r.count, lastActivity: r.last_activity }));
  }

  // ─── Best-effort history backfill of is_internal (item 3) ────────────────
  // Re-applies the SAME conservative rules used at write-time (isInternalTraffic)
  // to the User-Agent persisted on each conversation's opening system message,
  // and flags the confident-internal ones.
  //   • Idempotent  — only ever SETS is_internal=1 on matching rows; already-
  //                   flagged rows are skipped; never flips a flag back to 0.
  //   • Reversible  — resetInternalFlags() (or a code-revert + column reset)
  //                   restores the prior "counts include everything" behaviour.
  //   • Conservative— rows with no persisted UA (true legacy history created
  //                   before UA capture) match nothing and stay UNFLAGGED. We do
  //                   NOT guess at them; they simply keep counting until a
  //                   knowable signal exists. Returns {scanned, flagged}.
  backfillInternalFlags(): { scanned: number; flagged: number } {
    const db = getDb();
    const rows = db.prepare(`
      SELECT c.id as cid,
        (SELECT m.metadata FROM messages m
           WHERE m.conversation_id = c.id AND m.sender_role = 'system'
           ORDER BY m.created_at ASC LIMIT 1) as meta
      FROM conversations c
      WHERE (c.is_internal IS NULL OR c.is_internal = 0)
    `).all() as any[];
    const upd = db.prepare(`UPDATE conversations SET is_internal = 1 WHERE id = ? AND (is_internal IS NULL OR is_internal = 0)`);
    let flagged = 0;
    const tx = db.transaction((items: any[]) => {
      for (const r of items) {
        let ua: string | undefined;
        try { ua = JSON.parse(r.meta || "{}").ua; } catch { ua = undefined; }
        if (isInternalTraffic({ userAgent: ua })) {
          upd.run(r.cid);
          flagged++;
        }
      }
    });
    tx(rows);
    return { scanned: rows.length, flagged };
  }

  // Reversal for the backfill (rollback aid). Clears every internal flag so the
  // public counters revert to full totals. Returns how many rows were cleared.
  resetInternalFlags(): { cleared: number } {
    const db = getDb();
    const info = db.prepare(`UPDATE conversations SET is_internal = 0 WHERE is_internal = 1`).run();
    return { cleared: info.changes as number };
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

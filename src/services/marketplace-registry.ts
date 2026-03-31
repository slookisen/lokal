import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { getDb } from "../database/init";
import {
  AgentRegistration,
  RegisteredAgent,
  DiscoveryQuery,
  DiscoveryResult,
} from "../models/marketplace";

// ─── Marketplace Registry Service (SQLite-backed) ────────────
// This is the CORE of what makes Lokal unique: the agent registry.
//
// v2: Now persistent with SQLite. Data survives restart.
// Same public API as v1 (in-memory), but backed by real SQL.
//
// Architecture:
//   - All writes are immediate (SQLite WAL mode)
//   - Geo filtering uses bounding-box pre-filter + Haversine
//   - JSON arrays stored as TEXT, parsed on read
//   - Prepared statements for performance

class MarketplaceRegistry {
  // ─── Registration ─────────────────────────────────────────

  register(registration: AgentRegistration): RegisteredAgent {
    const db = getDb();
    const id = uuid();
    const apiKey = this.generateApiKey();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO agents (
        id, name, description, provider, contact_email, url, version,
        role, api_key, lat, lng, city, radius_km,
        categories, tags, skills, capabilities, languages,
        trust_score, is_active, is_verified,
        discovery_count, interaction_count, total_interactions,
        created_at, last_seen_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        0.5, 1, 0,
        0, 0, 0,
        ?, ?
      )
    `);

    stmt.run(
      id,
      registration.name,
      registration.description,
      registration.provider,
      registration.contactEmail,
      registration.url,
      registration.version || "1.0.0",
      registration.role,
      apiKey,
      registration.location?.lat ?? null,
      registration.location?.lng ?? null,
      registration.location?.city ?? null,
      registration.location?.radiusKm ?? null,
      JSON.stringify(registration.categories || []),
      JSON.stringify(registration.tags || []),
      JSON.stringify(registration.skills),
      JSON.stringify(registration.capabilities || {}),
      JSON.stringify(registration.languages || ["no"]),
      now,
      now,
    );

    return this.rowToAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any)!;
  }

  // ─── Discovery (the money endpoint) ───────────────────────
  // Consumer agents call this to find producers.
  // Uses bounding-box pre-filter for geo (Gap 6 fix).

  discover(query: DiscoveryQuery): DiscoveryResult[] {
    const db = getDb();

    // Build SQL dynamically based on query filters
    let sql = "SELECT * FROM agents WHERE is_active = 1";
    const params: any[] = [];

    // 1. Filter by role
    if (query.role) {
      sql += " AND role = ?";
      params.push(query.role);
    }

    // 2. Geo bounding-box pre-filter (much faster than full Haversine on all rows)
    if (query.location && query.maxDistanceKm) {
      const latDelta = query.maxDistanceKm / 111.0; // ~111km per degree lat
      const lngDelta = query.maxDistanceKm / (111.0 * Math.cos(toRad(query.location.lat)));
      sql += " AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?";
      params.push(
        query.location.lat - latDelta,
        query.location.lat + latDelta,
        query.location.lng - lngDelta,
        query.location.lng + lngDelta,
      );
    }

    const rows = db.prepare(sql).all(...params) as any[];
    let candidates = rows.map(r => this.rowToAgent(r)!);

    // 3. Filter by categories (in-app — JSON array matching)
    if (query.categories && query.categories.length > 0) {
      candidates = candidates.filter(a =>
        query.categories!.some(cat =>
          a.categories.some(ac => ac.toLowerCase().includes(cat.toLowerCase()))
        )
      );
    }

    // 4. Filter by tags
    if (query.tags && query.tags.length > 0) {
      candidates = candidates.filter(a =>
        query.tags!.some(tag =>
          a.tags.some(at => at.toLowerCase().includes(tag.toLowerCase()))
        )
      );
    }

    // 5. Filter by skills
    if (query.skills && query.skills.length > 0) {
      candidates = candidates.filter(a =>
        query.skills!.some(skillId =>
          a.skills.some(s => s.id === skillId || s.tags.some(t => t.toLowerCase().includes(skillId.toLowerCase())))
        )
      );
    }

    // 6. Precise distance filter (Haversine on the bounding-box survivors)
    if (query.location && query.maxDistanceKm) {
      candidates = candidates.filter(a => {
        if (!a.location) return false;
        const dist = haversine(query.location!.lat, query.location!.lng, a.location.lat, a.location.lng);
        return dist <= query.maxDistanceKm!;
      });
    }

    // 7. Score and rank
    const results: DiscoveryResult[] = candidates.map(agent => {
      const { score, reasons } = this.calculateRelevance(agent, query);

      // Track discovery stats (async-safe — fire and forget)
      this.incrementDiscovery(agent.id);

      return {
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          url: agent.url,
          role: agent.role,
          skills: agent.skills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags,
          })),
          location: agent.location ? {
            city: agent.location.city,
            distanceKm: query.location
              ? haversine(query.location.lat, query.location.lng, agent.location.lat, agent.location.lng)
              : undefined,
          } : undefined,
          trustScore: agent.trustScore,
          isVerified: agent.isVerified,
          categories: agent.categories,
          tags: agent.tags,
        },
        relevanceScore: score,
        matchReasons: reasons,
      };
    });

    // Sort by relevance (NOT popularity, NOT ad spend)
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return results.slice(query.offset || 0, (query.offset || 0) + (query.limit || 20));
  }

  // ─── Natural language query parsing ───────────────────────

  parseNaturalQuery(query: string): Partial<DiscoveryQuery> {
    const q = query.toLowerCase();
    const parsed: Partial<DiscoveryQuery> = {};

    const categoryMap: Record<string, string[]> = {
      "vegetables": ["grønnsaker", "grønt", "vegetables", "poteter", "gulrøtter", "løk", "kål", "tomat"],
      "fruit": ["frukt", "fruit", "epler", "pærer", "plommer"],
      "berries": ["bær", "berries", "jordbær", "blåbær", "bringebær"],
      "dairy": ["meieri", "dairy", "melk", "ost", "smør", "yoghurt"],
      "eggs": ["egg", "eggs"],
      "meat": ["kjøtt", "meat", "lam", "svin", "storfe", "kylling"],
      "fish": ["fisk", "fish", "laks", "torsk", "reker"],
      "bread": ["brød", "bread", "bakervarer"],
      "honey": ["honning", "honey"],
      "herbs": ["urter", "herbs", "krydder"],
    };

    const detectedCategories: string[] = [];
    for (const [category, keywords] of Object.entries(categoryMap)) {
      if (keywords.some(kw => q.includes(kw))) {
        detectedCategories.push(category);
      }
    }
    if (detectedCategories.length > 0) parsed.categories = detectedCategories;

    const tagMap: Record<string, string[]> = {
      "organic": ["økologisk", "organic", "øko", "debio"],
      "seasonal": ["sesong", "seasonal", "i sesong"],
      "budget": ["billig", "rimelig", "budget", "cheap"],
      "local": ["lokal", "local", "nærme", "kort reisevei"],
      "fresh": ["fersk", "fresh", "nyhøstet"],
    };

    const detectedTags: string[] = [];
    for (const [tag, keywords] of Object.entries(tagMap)) {
      if (keywords.some(kw => q.includes(kw))) {
        detectedTags.push(tag);
      }
    }
    if (detectedTags.length > 0) parsed.tags = detectedTags;

    const districts: Record<string, { lat: number; lng: number }> = {
      "grünerløkka": { lat: 59.9225, lng: 10.7584 },
      "grønland": { lat: 59.9127, lng: 10.7600 },
      "majorstuen": { lat: 59.9288, lng: 10.7136 },
      "frogner": { lat: 59.9201, lng: 10.7004 },
      "bygdøy": { lat: 59.9033, lng: 10.6850 },
      "storo": { lat: 59.9466, lng: 10.7718 },
      "sagene": { lat: 59.9375, lng: 10.7517 },
      "torshov": { lat: 59.9375, lng: 10.7600 },
      "oslo sentrum": { lat: 59.9139, lng: 10.7522 },
      "oslo": { lat: 59.9139, lng: 10.7522 },
      "vulkan": { lat: 59.9225, lng: 10.7515 },
      "mathallen": { lat: 59.9225, lng: 10.7515 },
      "tøyen": { lat: 59.9165, lng: 10.7720 },
      "vålerenga": { lat: 59.9073, lng: 10.7820 },
      "skøyen": { lat: 59.9208, lng: 10.6797 },
    };

    for (const [district, coords] of Object.entries(districts)) {
      if (q.includes(district)) {
        parsed.location = coords;
        parsed.maxDistanceKm = 10;
        break;
      }
    }

    parsed.role = "producer";
    return parsed;
  }

  // ─── Agent Card Generation (A2A standard) ─────────────────

  getAgentCard(agentId: string): object | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    return {
      name: agent.name,
      description: agent.description,
      url: agent.url,
      provider: { organization: agent.provider },
      version: agent.version,
      capabilities: agent.capabilities,
      skills: agent.skills.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        inputModes: s.inputModes,
        outputModes: s.outputModes,
      })),
      "x-lokal": {
        role: agent.role,
        categories: agent.categories,
        tags: agent.tags,
        trustScore: agent.trustScore,
        isVerified: agent.isVerified,
        registeredAt: agent.registeredAt,
        location: agent.location ? { city: agent.location.city } : undefined,
      },
    };
  }

  // ─── Registry-level Agent Card (Lokal itself) ──────────────

  getRegistryCard(baseUrl: string): object {
    const stats = this.getStats();
    return {
      // ─── A2A spec-compliant fields ─────────────────────────
      // WHY bilingual: Consumer agents (Claude, GPT, Gemini, etc.)
      // search in English. Norwegian producers search in Norwegian.
      // Both need to find us. Bilingual descriptions = 2x discovery surface.
      name: "Lokal",
      description: "A2A marketplace for local food in Norway. " +
        "Connect AI agents with 350+ local farms, shops, and producers. " +
        "Search fresh produce, organic vegetables, meat, fish, dairy, honey, bread, and more. " +
        "Agent-markedsplass for lokal mat i Norge — ferske grønnsaker, frukt, kjøtt, fisk, meieri, honning, brød og mer.",
      url: baseUrl,
      provider: {
        organization: "Lokal",
        contactUrl: `${baseUrl}/docs`,
        description: "Open agent-to-agent food marketplace operator. " +
          "Norges første A2A-markedsplass for lokal mat.",
      },
      version: "1.0.0",
      documentationUrl: `${baseUrl}/docs`,

      // ─── Protocol capabilities ─────────────────────────────
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },

      // ─── Authentication ────────────────────────────────────
      authentication: {
        schemes: ["apiKey"],
        credentials: null, // Open for reads, key for writes
      },

      // ─── A2A interfaces ────────────────────────────────────
      interfaces: [
        {
          type: "json-rpc",
          url: `${baseUrl}/a2a`,
          methods: ["message/send", "tasks/get", "tasks/list", "agent/authenticatedExtendedCard"],
          description: "A2A JSON-RPC 2.0 endpoint for agent-to-agent communication",
        },
        {
          type: "rest",
          url: `${baseUrl}/api/marketplace`,
          description: "REST API for search, discovery, registration, and human dashboard",
        },
      ],

      // ─── Skills (what agents can DO through us) ────────────
      // Each skill is a capability an external agent can invoke.
      // Rich descriptions + tags = higher match probability.
      skills: [
        {
          id: "discover-local-food-agents",
          name: "Discover Local Food Agents / Finn lokale matagenter",
          description: "Search a registry of 350+ verified local food producers in Norway. " +
            "Filter by category (vegetables, fruit, meat, fish, dairy, eggs, honey, herbs, bread, berries), " +
            "location (Oslo, Bergen, Trondheim, Stavanger, Tromsø, and rural districts), " +
            "certifications (organic, Debio, farm-direct), delivery options (pickup, local delivery), " +
            "and trust score. Returns ranked results with contact info and A2A endpoints. " +
            "Søk blant 350+ verifiserte lokale matprodusenter i Norge.",
          tags: [
            // English discovery keywords (what agents actually search for)
            "local food", "fresh produce", "organic", "farm direct", "vegetables", "fruit",
            "meat", "fish", "seafood", "dairy", "eggs", "honey", "herbs", "bread", "berries",
            "food marketplace", "food supplier", "grocery", "farm to table", "sustainable food",
            "food delivery", "food procurement", "wholesale food", "restaurant supply",
            // Norwegian keywords (for Nordic agents)
            "lokal mat", "ferske grønnsaker", "økologisk", "gårdsutsalg", "frukt",
            "kjøtt", "fisk", "sjømat", "meieri", "egg", "honning", "urter", "brød", "bær",
            "matmarked", "matleveranse", "kortreist mat", "sesongvarer",
            // Geographic (city-level discovery)
            "Norway", "Norge", "Oslo", "Bergen", "Trondheim", "Stavanger", "Tromsø",
            "Kristiansand", "Drammen", "Fredrikstad", "Bodø",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["application/json"],
          examples: [
            { input: "Find organic vegetable farms near Oslo", output: "JSON array of matching agents with trust scores" },
            { input: "finn ferske grønnsaker i Bergen", output: "JSON array of matchende agenter" },
            { input: "fresh fish suppliers Tromsø", output: "Ranked list of fish producers" },
          ],
        },
        {
          id: "register-food-agent",
          name: "Register Food Producer Agent / Registrer matagent",
          description: "Register a new food producer, farm, shop, or cooperative as an agent in the Lokal marketplace. " +
            "Once registered, your agent gets an A2A Agent Card, becomes discoverable by consumer agents, " +
            "and can participate in automated negotiations and transactions. " +
            "Registrer en ny matprodusent som agent i Lokal-markedsplassen.",
          tags: [
            "register", "onboard", "producer", "farm", "shop", "cooperative",
            "registrering", "produsent", "gård", "butikk", "andelslag",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "search-compare-food",
          name: "Search & Compare Local Food / Søk og sammenlign",
          description: "Natural language search across all producers. Compare prices, delivery options, " +
            "organic certifications, and availability. Supports both English and Norwegian queries. " +
            "Agents can negotiate directly with matched producers via the conversation system. " +
            "Søk, sammenlign priser, leveringsalternativer og tilgjengelighet.",
          tags: [
            "search", "compare", "price", "delivery", "availability", "negotiate",
            "søk", "sammenlign", "pris", "levering", "tilgjengelighet",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "agent-conversation",
          name: "Start Agent Negotiation / Start forhandling",
          description: "Initiate a buyer-seller conversation between agents. " +
            "Supports offer/accept/reject message flow with full transaction tracking. " +
            "Consumer agents can negotiate prices, quantities, and delivery terms. " +
            "Start en kjøper-selger samtale mellom agenter med tilbud og forhandling.",
          tags: [
            "negotiate", "conversation", "order", "buy", "transaction",
            "forhandling", "samtale", "bestilling", "kjøp", "handel",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
      ],

      // ─── Security ──────────────────────────────────────────
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "API key received upon registration. Required for write operations. " +
            "Read/search operations are open. " +
            "API-nøkkel mottatt ved registrering. Kreves for skriveoperasjoner.",
        },
      },

      // ─── Lokal-specific metadata ───────────────────────────
      "x-lokal": {
        type: "registry",
        region: "Norway",
        primaryLanguages: ["no", "en"],
        stats: {
          totalAgents: stats.totalAgents,
          activeProducers: stats.activeProducers,
          cities: stats.cities,
        },
        // Semantic categories for automated matching
        serviceCategories: [
          "food-marketplace", "local-commerce", "farm-direct",
          "agent-to-agent", "food-supply-chain", "sustainable-agriculture",
        ],
      },
    };
  }

  // ─── CRUD helpers ─────────────────────────────────────────

  getAgent(id: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  getAgentByApiKey(apiKey: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE api_key = ?").get(apiKey) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  updateAgent(id: string, updates: Partial<RegisteredAgent>): RegisteredAgent | undefined {
    const db = getDb();
    const existing = this.getAgent(id);
    if (!existing) return undefined;

    // Only update allowed fields
    const allowedFields: Record<string, string> = {
      name: "name",
      description: "description",
      url: "url",
      categories: "categories",
      tags: "tags",
      skills: "skills",
    };

    const setClauses: string[] = ["last_seen_at = datetime('now')"];
    const values: any[] = [];

    for (const [key, col] of Object.entries(allowedFields)) {
      if ((updates as any)[key] !== undefined) {
        const val = (updates as any)[key];
        setClauses.push(`${col} = ?`);
        values.push(Array.isArray(val) ? JSON.stringify(val) : val);
      }
    }

    values.push(id);
    db.prepare(`UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  heartbeat(id: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?").run(id);
  }

  deactivate(id: string): boolean {
    const db = getDb();
    const result = db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getAllAgents(): RegisteredAgent[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as any[];
    return rows.map(r => this.rowToAgent(r)!);
  }

  getActiveAgents(): RegisteredAgent[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents WHERE is_active = 1 ORDER BY trust_score DESC, created_at DESC").all() as any[];
    return rows.map(r => this.rowToAgent(r)!);
  }

  getStats(): { totalAgents: number; activeProducers: number; cities: string[]; totalListings: number } {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const activeProducers = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE role = 'producer' AND is_active = 1").get() as any).c;
    const citiesRows = db.prepare("SELECT DISTINCT city FROM agents WHERE city IS NOT NULL").all() as any[];
    const totalListings = (db.prepare("SELECT COUNT(*) as c FROM listings").get() as any).c;

    return {
      totalAgents: total,
      activeProducers,
      cities: citiesRows.map(r => r.city),
      totalListings,
    };
  }

  // ─── Task lifecycle (A2A Gap 7 fix) ───────────────────────

  createTask(method: string, params: any, consumerAgentId?: string): any {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (id, consumer_agent_id, method, params, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?)
    `).run(id, consumerAgentId || null, method, JSON.stringify(params), now, now);

    return { id, status: "submitted", method, createdAt: now };
  }

  updateTask(id: string, status: string, result?: any, error?: string): any {
    const db = getDb();
    db.prepare(`
      UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, result ? JSON.stringify(result) : null, error || null, id);

    return this.getTask(id);
  }

  getTask(id: string): any {
    const db = getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      consumerAgentId: row.consumer_agent_id,
      method: row.method,
      params: row.params ? JSON.parse(row.params) : null,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTasks(consumerAgentId?: string, status?: string): any[] {
    const db = getDb();
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: any[] = [];

    if (consumerAgentId) {
      sql += " AND consumer_agent_id = ?";
      params.push(consumerAgentId);
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC LIMIT 100";

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      id: r.id,
      method: r.method,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // ─── Listing CRUD ─────────────────────────────────────────

  addListing(agentId: string, listing: any): any {
    const db = getDb();
    const id = uuid();
    const agent = this.getAgent(agentId);

    db.prepare(`
      INSERT INTO listings (id, agent_id, product_name, category, description, quantity, unit, price_per_unit, currency, is_organic, image_url, expires_at, delivery_options, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, agentId,
      listing.productName, listing.category || null, listing.description || null,
      listing.quantity || null, listing.unit || null, listing.pricePerUnit || null,
      listing.currency || "NOK", listing.isOrganic ? 1 : 0, listing.imageUrl || null,
      listing.expiresAt || null, JSON.stringify(listing.deliveryOptions || []),
      listing.lat || agent?.location?.lat || null,
      listing.lng || agent?.location?.lng || null,
    );

    return { id, agentId, ...listing };
  }

  getListingsByAgent(agentId: string): any[] {
    const db = getDb();
    return db.prepare("SELECT * FROM listings WHERE agent_id = ? ORDER BY created_at DESC").all(agentId) as any[];
  }

  // ─── Check if agent exists by name (for idempotent seeding) ─

  getAgentByName(name: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  // ─── Private helpers ──────────────────────────────────────

  private generateApiKey(): string {
    return `lok_${crypto.randomBytes(32).toString("hex")}`;
  }

  private incrementDiscovery(agentId: string): void {
    try {
      const db = getDb();
      db.prepare("UPDATE agents SET discovery_count = discovery_count + 1 WHERE id = ?").run(agentId);
      // Also update agent_metrics for social proof
      db.prepare("INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)").run(agentId);
      db.prepare("UPDATE agent_metrics SET times_discovered = times_discovered + 1, updated_at = datetime('now') WHERE agent_id = ?").run(agentId);
    } catch { /* non-critical */ }
  }

  // ─── Reputation Engine ──────────────────────────────────
  // Recalculates trust score based on real behavior, not just defaults.
  // Called after transactions complete.
  //
  // Formula:
  //   base: 0.5 (new agent)
  //   + 0.15 if verified
  //   + up to 0.15 from completion rate (times_chosen / times_contacted)
  //   + up to 0.10 from volume (capped at 50 transactions)
  //   + up to 0.10 from repeat buyers (loyalty signal)
  //
  // This means: an agent maxes at 1.0 only with verification +
  // high completion + volume + loyalty. Impossible to game.

  recalculateTrustScore(agentId: string): number {
    const db = getDb();
    const agent = db.prepare("SELECT is_verified FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return 0.5;

    db.prepare("INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)").run(agentId);
    const m = db.prepare("SELECT * FROM agent_metrics WHERE agent_id = ?").get(agentId) as any;

    let score = 0.5; // base

    // Verification bonus
    if (agent.is_verified) score += 0.15;

    // Completion rate (contacted → chosen)
    if (m.times_contacted > 0) {
      const completionRate = Math.min(1, m.times_chosen / m.times_contacted);
      score += 0.15 * completionRate;
    }

    // Volume bonus (caps at 50 deals)
    const volumeScore = Math.min(1, (m.times_chosen || 0) / 50);
    score += 0.10 * volumeScore;

    // Loyalty bonus (repeat buyers are the ultimate trust signal)
    const loyaltyScore = Math.min(1, (m.repeat_buyer_count || 0) / 10);
    score += 0.10 * loyaltyScore;

    const finalScore = Math.min(1, Math.max(0, score));

    // Persist
    db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?").run(finalScore, agentId);
    return finalScore;
  }

  private rowToAgent(row: any): RegisteredAgent | undefined {
    if (!row) return undefined;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      provider: row.provider,
      contactEmail: row.contact_email,
      url: row.url,
      version: row.version || "1.0.0",
      role: row.role,
      apiKey: row.api_key,
      registeredAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      isActive: row.is_active === 1,
      isVerified: row.is_verified === 1,
      trustScore: row.trust_score,
      totalInteractions: row.total_interactions || 0,
      discoveryCount: row.discovery_count || 0,
      interactionCount: row.interaction_count || 0,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : {},
      skills: row.skills ? JSON.parse(row.skills) : [],
      categories: row.categories ? JSON.parse(row.categories) : [],
      tags: row.tags ? JSON.parse(row.tags) : [],
      languages: row.languages ? JSON.parse(row.languages) : ["no"],
      location: row.lat != null && row.lng != null ? {
        lat: row.lat,
        lng: row.lng,
        city: row.city || "Oslo",
        radiusKm: row.radius_km,
      } : undefined,
    };
  }

  private calculateRelevance(
    agent: RegisteredAgent,
    query: DiscoveryQuery
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    if (query.categories && query.categories.length > 0) {
      const matches = query.categories.filter(cat =>
        agent.categories.some(ac => ac.toLowerCase().includes(cat.toLowerCase()))
      );
      if (matches.length > 0) {
        score += 0.3 * (matches.length / query.categories.length);
        reasons.push(`Kategorier: ${matches.join(", ")}`);
      }
    } else {
      score += 0.15;
    }

    if (query.tags && query.tags.length > 0) {
      const matches = query.tags.filter(tag =>
        agent.tags.some(at => at.toLowerCase().includes(tag.toLowerCase()))
      );
      if (matches.length > 0) {
        score += 0.2 * (matches.length / query.tags.length);
        reasons.push(`Tags: ${matches.join(", ")}`);
      }
    }

    if (query.skills && query.skills.length > 0) {
      const matches = query.skills.filter(skillId =>
        agent.skills.some(s => s.id === skillId || s.tags.some(t => t.includes(skillId)))
      );
      if (matches.length > 0) {
        score += 0.15 * (matches.length / query.skills.length);
        reasons.push(`Skills: ${matches.join(", ")}`);
      }
    }

    if (query.location && agent.location) {
      const dist = haversine(
        query.location.lat, query.location.lng,
        agent.location.lat, agent.location.lng
      );
      const maxDist = query.maxDistanceKm || 20;
      const distScore = Math.max(0, 1 - dist / maxDist);
      score += 0.2 * distScore;
      if (dist < 5) reasons.push(`${dist.toFixed(1)} km unna`);
    }

    score += 0.1 * agent.trustScore;
    if (agent.trustScore > 0.8) reasons.push("Høy tillitsscore");

    if (agent.isVerified) {
      score += 0.05;
      reasons.push("Verifisert");
    }

    return { score: Math.min(1, score), reasons };
  }
}

// ─── Haversine distance ──────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Singleton
export const marketplaceRegistry = new MarketplaceRegistry();

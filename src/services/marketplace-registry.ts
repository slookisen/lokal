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
  // ─── In-memory cache ──────────────────────────────────────────
  // Avoids re-querying + JSON.parse() on 1100+ agents per request.
  // Cache invalidated on register/update/deactivate. TTL as fallback.
  // Public so ops agent can clear them via /ops/clear-cache.
  _agentsCache: RegisteredAgent[] | null = null;
  _agentsCacheTime = 0;
  _statsCache: { totalAgents: number; activeProducers: number; cities: string[]; totalListings: number } | null = null;
  _statsCacheTime = 0;
  private static CACHE_TTL = 60_000; // 60 seconds

  private invalidateCache() {
    this._agentsCache = null;
    this._statsCache = null;
  }

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

    this.invalidateCache();
    return this.rowToAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any)!;
  }

  // ─── Discovery (the money endpoint) ───────────────────────
  // Consumer agents call this to find producers.
  // Uses bounding-box pre-filter for geo (Gap 6 fix).

  discover(query: DiscoveryQuery): DiscoveryResult[] {
    const db = getDb();

    // ── 0. Name-based search: if query contains a producer name, find it directly ──
    // This handles "Bjørndal Gård Oppdal", "hva tilbyr Bjørndal Gård?" etc.
    // NOTE: SQLite's LOWER() only works for ASCII, so we do case-insensitive
    // matching in JavaScript instead of SQL to handle Norwegian characters (ø,å,æ).
    const nameQuery = (query as any)._nameQuery as string | undefined;
    if (nameQuery && nameQuery.length >= 3) {
      // Fetch all active agents and filter by name in JS (case-insensitive for Unicode)
      const allRows = db.prepare("SELECT * FROM agents WHERE is_active = 1").all() as any[];
      const nameWords = nameQuery.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

      console.log(`[name-search] query="${nameQuery}", words=${JSON.stringify(nameWords)}, totalAgents=${allRows.length}`);

      const nameRows = allRows.filter(row => {
        const agentName = (row.name || "").toLowerCase();
        // All name words must appear somewhere in the agent name
        return nameWords.every(word => agentName.includes(word));
      });

      console.log(`[name-search] matched=${nameRows.length}${nameRows.length > 0 ? ` → ${nameRows.map((r: any) => r.name).join(", ")}` : ""}`);

      if (nameRows.length > 0) {
        // Found by name — return these as top results, skip geo filtering
        let nameCandidates = nameRows.map(r => this.rowToAgent(r)!);
        if (query.role) {
          nameCandidates = nameCandidates.filter(a => a.role === query.role);
        }
        if (nameCandidates.length > 0) {
          const results: DiscoveryResult[] = nameCandidates.map(agent => {
            const { score, reasons } = this.calculateRelevance(agent, query, [], new Map());
            this.incrementDiscovery(agent.id);
            return {
              agent: {
                id: agent.id, name: agent.name, description: agent.description,
                url: agent.url, role: agent.role,
                skills: agent.skills.map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
                location: agent.location ? {
                  city: agent.location.city,
                  distanceKm: query.location
                    ? haversine(query.location.lat, query.location.lng, agent.location.lat, agent.location.lng)
                    : undefined,
                } : undefined,
                trustScore: agent.trustScore, isVerified: agent.isVerified,
                categories: agent.categories, tags: agent.tags,
              },
              relevanceScore: Math.max(score, 0.9), // Name match = high relevance
              matchReasons: [`Navnematch: "${nameQuery}"`, ...reasons],
            };
          });
          results.sort((a, b) => b.relevanceScore - a.relevanceScore);
          return results.slice(0, query.limit || 20);
        }
      }
    }

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

    // 3. Filter by categories (in-app â€" JSON array matching)
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

    // 6b. Product-level filtering — if user searched for specific products (e.g. "tomat"),
    // load each candidate's products from knowledge and check for matches.
    // This prevents a meat shop from appearing when someone searches for tomatoes.
    const productTerms = (query as any)._productTerms as string[] | undefined;
    let productMatchMap: Map<string, string[]> = new Map(); // agentId → matched product names

    if (productTerms && productTerms.length > 0) {
      const candidateIds = candidates.map(c => c.id);
      if (candidateIds.length > 0) {
        // Bulk-load products for all candidates in one query
        const placeholders = candidateIds.map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT agent_id, products FROM agent_knowledge WHERE agent_id IN (${placeholders})`
        ).all(...candidateIds) as { agent_id: string; products: string }[];

        for (const row of rows) {
          try {
            const products = typeof row.products === "string" ? JSON.parse(row.products) : row.products;
            if (!Array.isArray(products)) continue;

            const matchedNames: string[] = [];
            for (const p of products) {
              const pName = (typeof p === "string" ? p : p?.name || "").toLowerCase();
              for (const term of productTerms) {
                if (pName.includes(term) || new RegExp(`\\b${term}\\b`).test(pName)) {
                  matchedNames.push(typeof p === "string" ? p : p?.name || pName);
                  break;
                }
              }
            }
            if (matchedNames.length > 0) {
              productMatchMap.set(row.agent_id, matchedNames);
            }
          } catch { /* skip malformed JSON */ }
        }

        // Filter: keep agents with matching products, OR agents that haven't been enriched,
        // OR agents whose category matches the query (even if products aren't populated yet).
        // This prevents over-filtering agents with incomplete product data.
        candidates = candidates.filter(a => {
          if (productMatchMap.has(a.id)) return true;
          // No knowledge at all → benefit of doubt
          const hasKnowledge = rows.some(r => r.agent_id === a.id);
          if (!hasKnowledge) return true;
          // Has knowledge but no matching products — still keep if their category matches
          // (a dairy farmer without enriched products should still show up for "ost")
          if (query.categories?.length) {
            const catMatch = query.categories.some(cat =>
              a.categories.some(ac => ac.toLowerCase() === cat.toLowerCase())
            );
            if (catMatch) return true;
          }
          return false;
        });
      }
    }

    // 7. Score and rank
    const results: DiscoveryResult[] = candidates.map(agent => {
      const { score, reasons } = this.calculateRelevance(agent, query, productTerms, productMatchMap);

      // Track discovery stats (async-safe â€" fire and forget)
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

  parseNaturalQuery(query: string): Partial<DiscoveryQuery> & { _productTerms?: string[] } {
    const q = query.toLowerCase().replace(/[?!.,]/g, "");
    const parsed: Partial<DiscoveryQuery> & { _productTerms?: string[] } = {};

    // ── Product→Category mapping (expanded with Norwegian food terms) ──
    // Each keyword maps to a category AND is stored as a product search term
    // so we can match at product-level, not just category-level.
    const categoryMap: Record<string, string[]> = {
      "vegetables": [
        "grønnsaker", "grønt", "vegetables", "poteter", "potet", "gulrøtter", "gulrot",
        "løk", "kål", "tomat", "tomater", "agurk", "brokkoli", "blomkål", "squash",
        "paprika", "selleri", "purre", "spinat", "salat", "reddik", "gresskar",
        "mais", "erter", "bønner", "rødbeter", "nepe", "pastinakk",
      ],
      "fruit": [
        "frukt", "fruit", "epler", "eple", "pærer", "pære", "plommer", "plomme",
        "kirsebær", "moreller", "rips", "stikkelsbær", "druer",
      ],
      "berries": [
        "bær", "berries", "jordbær", "blåbær", "bringebær", "tyttebær",
        "solbær", "multe", "multer", "markjordbær",
      ],
      "dairy": [
        "meieri", "dairy", "melk", "ost", "smør", "yoghurt", "fløte", "rømme",
        "brunost", "hvitost", "geitost", "pultost", "gamalost", "smøreost",
      ],
      "eggs": ["egg", "eggs", "frittgående", "økologiske egg"],
      "meat": [
        "kjøtt", "meat", "lam", "lammekjøtt", "svin", "svinekjøtt", "storfe",
        "storfekjøtt", "kylling", "and", "vilt", "elg", "hjort", "rein",
        "reinsdyr", "pølser", "spekemat", "fenalår", "ribbe", "pinnekjøtt",
      ],
      "fish": [
        "fisk", "fish", "sjømat", "laks", "torsk", "reker", "krabbe", "blåskjell",
        "ørret", "røye", "sei", "hyse", "kveite", "steinbit", "tørrfisk",
        "klippfisk", "lutefisk", "rakfisk", "gravlaks",
      ],
      "bread": [
        "brød", "bread", "bakervarer", "lefse", "flatbrød", "rundstykker",
        "boller", "kanelboller", "surdeig", "grovbrød",
      ],
      "honey": ["honning", "honey", "birøkt"],
      "herbs": ["urter", "herbs", "krydder", "dill", "persille", "basilikum", "timian"],
    };

    const detectedCategories: string[] = [];
    const productTerms: string[] = [];
    for (const [category, keywords] of Object.entries(categoryMap)) {
      for (const kw of keywords) {
        // Use word-boundary matching to avoid partial matches ("ost" in "Tromsø kosten")
        const regex = new RegExp(`\\b${kw}\\b`);
        if (regex.test(q)) {
          if (!detectedCategories.includes(category)) detectedCategories.push(category);
          // Store the specific product term (not the category keyword like "vegetables")
          if (!["grønnsaker", "grønt", "vegetables", "frukt", "fruit", "bær", "berries",
                "meieri", "dairy", "kjøtt", "meat", "fisk", "fish", "sjømat", "brød", "bread",
                "bakervarer", "urter", "herbs", "egg", "eggs"].includes(kw)) {
            productTerms.push(kw);
          }
        }
      }
    }
    if (detectedCategories.length > 0) parsed.categories = detectedCategories;
    if (productTerms.length > 0) parsed._productTerms = productTerms;

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

    // Location resolution is handled by geocodingService in the search route.
    // This keeps parseNaturalQuery synchronous and fast — geocoding (which may
    // call Kartverket API) happens one level up in the async route handler.

    // ── Name-based search extraction ──
    // Two-pass approach:
    //   Pass 1: If query has indicator words (gård, bakeri, etc.), extract name from context
    //   Pass 2: If no indicator, check if any query word matches an actual agent name in DB
    // This handles both "Bjørndal Gård Oppdal" AND just "Rørosmat"

    const skipWords = new Set(["hva", "har", "hos", "fra", "i", "på", "kan", "du", "jeg",
      "det", "er", "en", "et", "og", "med", "til", "av", "som", "dem", "de", "vi",
      "liste", "prisliste", "priser", "pris", "produkter", "varer", "varene", "koster",
      "kost", "selger", "tilbyr", "finne", "finn", "søk", "kjøpe", "bestille",
      "nær", "nærme", "nærmeste", "meg", "oss", "her", "der", "hvor"]);

    const nameIndicators = ["gård", "gard", "farm", "mat", "ysteri", "bakeri", "bryggeri",
      "marked", "butikk", "kooperativ", "meieri", "slakteri", "gardsmat", "gardsutsalg"];
    const queryWords = query.split(/\s+/);
    const indicatorIndex = queryWords.findIndex(w =>
      nameIndicators.some(ind => w.toLowerCase().replace(/[.,!?]/g, "") === ind ||
        w.toLowerCase().replace(/[.,!?]/g, "").endsWith(ind))
    );

    if (indicatorIndex >= 0) {
      // Pass 1: Indicator word found — extract name from surrounding words
      const nameParts: string[] = [];
      for (const word of queryWords) {
        const clean = word.replace(/[.,!?]/g, "");
        if (clean.length < 2) continue;
        if (skipWords.has(clean.toLowerCase())) continue;
        nameParts.push(clean);
      }
      if (nameParts.length >= 1 && nameParts.join(" ").length >= 4) {
        (parsed as any)._nameQuery = nameParts.join(" ");
      }
    } else {
      // Pass 2: No indicator word — check if query words match any agent name
      // This catches "Rørosmat", "Bjørndal", "Erga" etc.
      const nonSkipWords = queryWords
        .map(w => w.replace(/[.,!?]/g, "").toLowerCase())
        .filter(w => w.length >= 3 && !skipWords.has(w));

      // Don't name-search if all words are food/location terms (avoid false positives)
      const allAreKnownTerms = nonSkipWords.every(w => {
        for (const keywords of Object.values(categoryMap)) {
          if ((keywords as string[]).includes(w)) return true;
        }
        for (const keywords of Object.values(tagMap)) {
          if ((keywords as string[]).includes(w)) return true;
        }
        return false;
      });

      if (!allAreKnownTerms && nonSkipWords.length > 0) {
        // Quick check: do any of these words appear in an agent name?
        const db = getDb();
        const allNames = (db.prepare("SELECT name FROM agents WHERE is_active = 1").all() as any[])
          .map(r => (r.name || "").toLowerCase());

        const nameMatches = nonSkipWords.filter(word =>
          allNames.some(name => name.includes(word))
        );

        if (nameMatches.length > 0) {
          // At least one word matches an agent name — use it as name query
          const nameParts = queryWords
            .map(w => w.replace(/[.,!?]/g, ""))
            .filter(w => w.length >= 2 && !skipWords.has(w.toLowerCase()));
          if (nameParts.join(" ").length >= 3) {
            (parsed as any)._nameQuery = nameParts.join(" ");
          }
        }
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
        `Connect AI agents with ${stats.totalAgents || 1169}+ verified local farms, shops, cooperatives, farm shops, REKO rings, and markets. ` +
        "Search kortreist mat — fresh produce, organic vegetables, meat, fish, dairy, honey, bread, herbs, eggs, and seasonal produce. " +
        "Agent-markedsplass for lokal mat i Norge — ferske gr\u00f8nnsaker, frukt, kj\u00f8tt, fisk, meieri, honning, br\u00f8d, \u00f8kologisk, kortreist, g\u00e5rdsbutikk, REKO-ring og mer.",
      // A2A spec: this MUST be the JSON-RPC endpoint, not the website root.
      // Compliant clients (incl. a2aregistry.org) POST messages directly to
      // this URL. Pointing it at `${baseUrl}` made every client land on
      // Express's HTML 404 page and report "404 Not Found when sending
      // messages" — flagged by A2A Registry maintainer 2026-04-25.
      url: `${baseUrl}/a2a`,
      provider: {
        organization: "Lokal",
        url: baseUrl,
        contactUrl: `${baseUrl}/docs`,
        description: "Open agent-to-agent food marketplace operator. " +
          "Norges f\u00f8rste A2A-markedsplass for lokal mat.",
      },
      version: "1.0.0",
      protocolVersion: "0.3.0",
      documentationUrl: `${baseUrl}/docs`,
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["application/json"],



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
          description: `Search a registry of ${stats.totalAgents || 1100}+ verified local food producers in Norway. ` +
            "Filter by category (vegetables, fruit, meat, fish, dairy, eggs, honey, herbs, bread, berries), " +
            "location (Oslo, Bergen, Trondheim, Stavanger, Troms\u00f8, and rural districts), " +
            "certifications (organic, Debio, farm-direct), delivery options (pickup, local delivery), " +
            "and trust score. Returns ranked results with contact info and A2A endpoints. " +
            `Søk blant ${stats.totalAgents || 1100}+ verifiserte lokale matprodusenter i Norge.`,
          tags: [
            // English discovery keywords (what agents actually search for)
            "local food", "fresh produce", "organic", "farm direct", "vegetables", "fruit",
            "meat", "fish", "seafood", "dairy", "eggs", "honey", "herbs", "bread", "berries",
            "food marketplace", "food supplier", "grocery", "farm to table", "sustainable food",
            "food delivery", "food procurement", "wholesale food", "restaurant supply",
            // Norwegian keywords (for Nordic agents)
            "lokal mat", "ferske gr\u00f8nnsaker", "\u00f8kologisk", "g\u00e5rdsutsalg", "frukt",
            "kj\u00f8tt", "fisk", "sj\u00f8mat", "meieri", "egg", "honning", "urter", "br\u00f8d", "b\u00e6r",
            "matmarked", "matleveranse", "kortreist mat", "sesongvarer",
            // Geographic (city-level discovery)
            "Norway", "Norge", "Oslo", "Bergen", "Trondheim", "Stavanger", "Troms\u00f8",
            "Kristiansand", "Drammen", "Fredrikstad", "Bod\u00f8",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["application/json"],
          examples: [
            "Find organic vegetable farms near Oslo",
            "finn ferske grønnsaker i Bergen",
            "fresh fish suppliers Tromsø",
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
            "registrering", "produsent", "g\u00e5rd", "butikk", "andelslag",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
          examples: [
            "Register my organic farm in Bergen",
            "registrer en gård i Oslo",
          ],
        },
        {
          id: "search-compare-food",
          name: "Search & Compare Local Food / S\u00f8k og sammenlign",
          description: "Natural language search across all producers. Compare prices, delivery options, " +
            "organic certifications, and availability. Supports both English and Norwegian queries. " +
            "Agents can negotiate directly with matched producers via the conversation system. " +
            "S\u00f8k, sammenlign priser, leveringsalternativer og tilgjengelighet.",
          tags: [
            "search", "compare", "price", "delivery", "availability", "negotiate",
            "s\u00f8k", "sammenlign", "pris", "levering", "tilgjengelighet",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["application/json"],
          examples: [
            "compare cheese prices in Oslo",
            "finn billig honning nær Trondheim",
          ],
        },
        {
          id: "agent-conversation",
          name: "Start Agent Negotiation / Start forhandling",
          description: "Initiate a buyer-seller conversation between agents. " +
            "Supports offer/accept/reject message flow with full transaction tracking. " +
            "Consumer agents can negotiate prices, quantities, and delivery terms. " +
            "Start en kj\u00f8per-selger samtale mellom agenter med tilbud og forhandling.",
          tags: [
            "negotiate", "conversation", "order", "buy", "transaction",
            "forhandling", "samtale", "bestilling", "kj\u00f8p", "handel",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
          examples: [
            "negotiate delivery of 5kg tomatoes",
            "bestill 2kg ost med levering",
          ],
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
            "API-n\u00f8kkel mottatt ved registrering. Kreves for skriveoperasjoner.",
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
    this.invalidateCache();
    return this.getAgent(id);
  }

  heartbeat(id: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?").run(id);
  }

  deactivate(id: string): boolean {
    const db = getDb();
    const result = db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(id);
    this.invalidateCache();
    return result.changes > 0;
  }

  getAllAgents(): RegisteredAgent[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as any[];
    return rows.map(r => this.rowToAgent(r)!);
  }

  getActiveAgents(): RegisteredAgent[] {
    const now = Date.now();
    if (this._agentsCache && (now - this._agentsCacheTime) < MarketplaceRegistry.CACHE_TTL) {
      return this._agentsCache;
    }
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents WHERE is_active = 1 ORDER BY trust_score DESC, created_at DESC").all() as any[];
    this._agentsCache = rows.map(r => this.rowToAgent(r)!);
    this._agentsCacheTime = now;
    return this._agentsCache;
  }

  getStats(): { totalAgents: number; activeProducers: number; cities: string[]; totalListings: number } {
    const now = Date.now();
    if (this._statsCache && (now - this._statsCacheTime) < MarketplaceRegistry.CACHE_TTL) {
      return this._statsCache;
    }
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const activeProducers = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE role = 'producer' AND is_active = 1").get() as any).c;
    const citiesRows = db.prepare("SELECT DISTINCT city FROM agents WHERE city IS NOT NULL").all() as any[];
    const totalListings = (db.prepare("SELECT COUNT(*) as c FROM listings").get() as any).c;

    this._statsCache = {
      totalAgents: total,
      activeProducers,
      cities: citiesRows.map(r => r.city),
      totalListings,
    };
    this._statsCacheTime = now;
    return this._statsCache;
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

  // ─── Check if agent exists by name (for idempotent seeding) â"€

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

    // Completion rate (contacted â†' chosen)
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
    query: DiscoveryQuery,
    productTerms?: string[],
    productMatchMap?: Map<string, string[]>,
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    // Category match (base relevance)
    if (query.categories && query.categories.length > 0) {
      const matches = query.categories.filter(cat =>
        agent.categories.some(ac => ac.toLowerCase().includes(cat.toLowerCase()))
      );
      if (matches.length > 0) {
        score += 0.25 * (matches.length / query.categories.length);
        reasons.push(`Kategorier: ${matches.join(", ")}`);
      }
    } else {
      score += 0.1;
    }

    // Product-level match bonus — agents carrying the exact product rank much higher.
    // "tomat" → tomato sellers first, not just any vegetable shop.
    if (productTerms && productTerms.length > 0 && productMatchMap) {
      const matchedProducts = productMatchMap.get(agent.id);
      if (matchedProducts && matchedProducts.length > 0) {
        const productScore = Math.min(1, matchedProducts.length / productTerms.length);
        score += 0.25 * productScore;
        reasons.push(`Produkter: ${matchedProducts.slice(0, 3).join(", ")}`);
      }
    }

    // Tag match
    if (query.tags && query.tags.length > 0) {
      const matches = query.tags.filter(tag =>
        agent.tags.some(at => at.toLowerCase().includes(tag.toLowerCase()))
      );
      if (matches.length > 0) {
        score += 0.15 * (matches.length / query.tags.length);
        reasons.push(`Tags: ${matches.join(", ")}`);
      }
    }

    // Skills match
    if (query.skills && query.skills.length > 0) {
      const matches = query.skills.filter(skillId =>
        agent.skills.some(s => s.id === skillId || s.tags.some(t => t.includes(skillId)))
      );
      if (matches.length > 0) {
        score += 0.1 * (matches.length / query.skills.length);
        reasons.push(`Skills: ${matches.join(", ")}`);
      }
    }

    // Geo proximity — closer agents rank higher
    if (query.location && agent.location) {
      const dist = haversine(
        query.location.lat, query.location.lng,
        agent.location.lat, agent.location.lng
      );
      const maxDist = query.maxDistanceKm || 20;
      const distScore = Math.max(0, 1 - dist / maxDist);
      score += 0.15 * distScore;
      if (dist < 5) reasons.push(`${dist.toFixed(1)} km unna`);
    }

    score += 0.05 * agent.trustScore;
    if (agent.trustScore > 0.8) reasons.push("H\u00f8y tillitsscore");

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








"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketplaceRegistry = void 0;
const uuid_1 = require("uuid");
const crypto_1 = __importDefault(require("crypto"));
const init_1 = require("../database/init");
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
    register(registration) {
        const db = (0, init_1.getDb)();
        const id = (0, uuid_1.v4)();
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
        stmt.run(id, registration.name, registration.description, registration.provider, registration.contactEmail, registration.url, registration.version || "1.0.0", registration.role, apiKey, registration.location?.lat ?? null, registration.location?.lng ?? null, registration.location?.city ?? null, registration.location?.radiusKm ?? null, JSON.stringify(registration.categories || []), JSON.stringify(registration.tags || []), JSON.stringify(registration.skills), JSON.stringify(registration.capabilities || {}), JSON.stringify(registration.languages || ["no"]), now, now);
        return this.rowToAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id));
    }
    // ─── Discovery (the money endpoint) ───────────────────────
    // Consumer agents call this to find producers.
    // Uses bounding-box pre-filter for geo (Gap 6 fix).
    discover(query) {
        const db = (0, init_1.getDb)();
        // Build SQL dynamically based on query filters
        let sql = "SELECT * FROM agents WHERE is_active = 1";
        const params = [];
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
            params.push(query.location.lat - latDelta, query.location.lat + latDelta, query.location.lng - lngDelta, query.location.lng + lngDelta);
        }
        const rows = db.prepare(sql).all(...params);
        let candidates = rows.map(r => this.rowToAgent(r));
        // 3. Filter by categories (in-app — JSON array matching)
        if (query.categories && query.categories.length > 0) {
            candidates = candidates.filter(a => query.categories.some(cat => a.categories.some(ac => ac.toLowerCase().includes(cat.toLowerCase()))));
        }
        // 4. Filter by tags
        if (query.tags && query.tags.length > 0) {
            candidates = candidates.filter(a => query.tags.some(tag => a.tags.some(at => at.toLowerCase().includes(tag.toLowerCase()))));
        }
        // 5. Filter by skills
        if (query.skills && query.skills.length > 0) {
            candidates = candidates.filter(a => query.skills.some(skillId => a.skills.some(s => s.id === skillId || s.tags.some(t => t.toLowerCase().includes(skillId.toLowerCase())))));
        }
        // 6. Precise distance filter (Haversine on the bounding-box survivors)
        if (query.location && query.maxDistanceKm) {
            candidates = candidates.filter(a => {
                if (!a.location)
                    return false;
                const dist = haversine(query.location.lat, query.location.lng, a.location.lat, a.location.lng);
                return dist <= query.maxDistanceKm;
            });
        }
        // 7. Score and rank
        const results = candidates.map(agent => {
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
    parseNaturalQuery(query) {
        const q = query.toLowerCase();
        const parsed = {};
        const categoryMap = {
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
        const detectedCategories = [];
        for (const [category, keywords] of Object.entries(categoryMap)) {
            if (keywords.some(kw => q.includes(kw))) {
                detectedCategories.push(category);
            }
        }
        if (detectedCategories.length > 0)
            parsed.categories = detectedCategories;
        const tagMap = {
            "organic": ["økologisk", "organic", "øko", "debio"],
            "seasonal": ["sesong", "seasonal", "i sesong"],
            "budget": ["billig", "rimelig", "budget", "cheap"],
            "local": ["lokal", "local", "nærme", "kort reisevei"],
            "fresh": ["fersk", "fresh", "nyhøstet"],
        };
        const detectedTags = [];
        for (const [tag, keywords] of Object.entries(tagMap)) {
            if (keywords.some(kw => q.includes(kw))) {
                detectedTags.push(tag);
            }
        }
        if (detectedTags.length > 0)
            parsed.tags = detectedTags;
        const districts = {
            // Oslo districts
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
            "løren": { lat: 59.9320, lng: 10.7930 },
            "oppsal": { lat: 59.8930, lng: 10.8280 },
            "grorud": { lat: 59.9620, lng: 10.8860 },
            // Oslo area
            "asker": { lat: 59.8333, lng: 10.4350 },
            "bærum": { lat: 59.8800, lng: 10.4900 },
            "lillestrøm": { lat: 59.9561, lng: 11.0496 },
            "drøbak": { lat: 59.7200, lng: 10.6300 },
            "ås": { lat: 59.6600, lng: 10.7900 },
            // Major Norwegian cities
            "bergen": { lat: 60.3943, lng: 5.3259 },
            "trondheim": { lat: 63.4305, lng: 10.3951 },
            "stavanger": { lat: 58.9700, lng: 5.7331 },
            "sandnes": { lat: 58.8530, lng: 5.7346 },
            "tromsø": { lat: 69.6489, lng: 18.9551 },
            "kristiansand": { lat: 58.1462, lng: 7.9956 },
            "drammen": { lat: 59.7441, lng: 10.2045 },
            "fredrikstad": { lat: 59.2181, lng: 10.9298 },
            // Bergen districts
            "fyllingsdalen": { lat: 60.3500, lng: 5.2800 },
            "åsane": { lat: 60.4660, lng: 5.3260 },
            "fisketorget": { lat: 60.3943, lng: 5.3259 },
            // Trondheim districts
            "heimdal": { lat: 63.3500, lng: 10.3500 },
            "byåsen": { lat: 63.4200, lng: 10.3400 },
            "moholt": { lat: 63.4130, lng: 10.4340 },
            "lade": { lat: 63.4400, lng: 10.4500 },
            // Stavanger districts
            "ullandhaug": { lat: 58.9560, lng: 5.6950 },
            "jæren": { lat: 58.7500, lng: 5.6500 },
        };
        // Cities get a wider search radius than neighborhoods
        const cityNames = new Set([
            "bergen", "trondheim", "stavanger", "sandnes", "tromsø",
            "kristiansand", "drammen", "fredrikstad", "oslo", "asker",
            "bærum", "lillestrøm", "drøbak", "ås",
        ]);
        for (const [district, coords] of Object.entries(districts)) {
            if (q.includes(district)) {
                parsed.location = coords;
                parsed.maxDistanceKm = cityNames.has(district) ? 30 : 10;
                break;
            }
        }
        parsed.role = "producer";
        return parsed;
    }
    // ─── Agent Card Generation (A2A standard) ─────────────────
    getAgentCard(agentId) {
        const agent = this.getAgent(agentId);
        if (!agent)
            return null;
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
    getRegistryCard(baseUrl) {
        const stats = this.getStats();
        return {
            // A2A spec-compliant fields
            name: "Lokal",
            description: "Agent-markedsplass for lokal mat. Registrer dine varer eller finn fersk, lokal mat fra produsenter i ditt nabolag.",
            url: baseUrl,
            provider: { organization: "Lokal" },
            version: "1.0.0",
            documentationUrl: `${baseUrl}/docs`,
            capabilities: {
                streaming: false,
                pushNotifications: false,
                stateTransitionHistory: true,
            },
            // A2A interfaces array (Gap 2 fix)
            interfaces: [
                {
                    type: "json-rpc",
                    url: `${baseUrl}/a2a`,
                    methods: ["message/send", "tasks/get", "tasks/list", "agent/authenticatedExtendedCard"],
                },
                {
                    type: "rest",
                    url: `${baseUrl}/api/marketplace`,
                    description: "REST API for dashboard and human-facing integrations",
                },
            ],
            skills: [
                {
                    id: "discover-agents",
                    name: "Finn matagenter",
                    description: "Søk i registeret etter produsenter, leverandører og andre matagenter basert på kategori, lokasjon og preferanser",
                    tags: ["lokal mat", "grønnsaker", "frukt", "økologisk", "fersk", "bær", "kjøtt", "fisk", "meieri", "honning", "urter", "brød", "egg"],
                    inputModes: ["text/plain", "application/json"],
                    outputModes: ["application/json"],
                },
                {
                    id: "register-agent",
                    name: "Registrer agent",
                    description: "Registrer en ny produsent- eller tjenesteagent i Lokal-markedsplassen",
                    tags: ["registrering", "produsent", "butikk", "gård"],
                    inputModes: ["application/json"],
                    outputModes: ["application/json"],
                },
                {
                    id: "search-local-food",
                    name: "Søk lokal mat",
                    description: "Finn og sammenlign lokale matvarer basert på preferanser — pris, avstand, økologisk, sesong",
                    tags: ["søk", "sammenlign", "pris", "avstand"],
                    inputModes: ["text/plain", "application/json"],
                    outputModes: ["application/json"],
                },
            ],
            securitySchemes: {
                apiKey: {
                    type: "apiKey",
                    in: "header",
                    name: "X-API-Key",
                    description: "API-nøkkel mottatt ved registrering. Kreves for å oppdatere egne data.",
                },
            },
            "x-lokal": {
                type: "registry",
                stats: {
                    totalAgents: stats.totalAgents,
                    activeProducers: stats.activeProducers,
                    cities: stats.cities,
                },
            },
        };
    }
    // ─── CRUD helpers ─────────────────────────────────────────
    getAgent(id) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
        return row ? this.rowToAgent(row) : undefined;
    }
    getAgentByApiKey(apiKey) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM agents WHERE api_key = ?").get(apiKey);
        return row ? this.rowToAgent(row) : undefined;
    }
    updateAgent(id, updates) {
        const db = (0, init_1.getDb)();
        const existing = this.getAgent(id);
        if (!existing)
            return undefined;
        // Only update allowed fields
        const allowedFields = {
            name: "name",
            description: "description",
            url: "url",
            categories: "categories",
            tags: "tags",
            skills: "skills",
        };
        const setClauses = ["last_seen_at = datetime('now')"];
        const values = [];
        for (const [key, col] of Object.entries(allowedFields)) {
            if (updates[key] !== undefined) {
                const val = updates[key];
                setClauses.push(`${col} = ?`);
                values.push(Array.isArray(val) ? JSON.stringify(val) : val);
            }
        }
        values.push(id);
        db.prepare(`UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
        return this.getAgent(id);
    }
    heartbeat(id) {
        const db = (0, init_1.getDb)();
        db.prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?").run(id);
    }
    deactivate(id) {
        const db = (0, init_1.getDb)();
        const result = db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(id);
        return result.changes > 0;
    }
    getAllAgents() {
        const db = (0, init_1.getDb)();
        const rows = db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all();
        return rows.map(r => this.rowToAgent(r));
    }
    getActiveAgents() {
        const db = (0, init_1.getDb)();
        const rows = db.prepare("SELECT * FROM agents WHERE is_active = 1 ORDER BY trust_score DESC, created_at DESC").all();
        return rows.map(r => this.rowToAgent(r));
    }
    getStats() {
        const db = (0, init_1.getDb)();
        const total = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
        const activeProducers = db.prepare("SELECT COUNT(*) as c FROM agents WHERE role = 'producer' AND is_active = 1").get().c;
        const citiesRows = db.prepare("SELECT DISTINCT city FROM agents WHERE city IS NOT NULL").all();
        const totalListings = db.prepare("SELECT COUNT(*) as c FROM listings").get().c;
        return {
            totalAgents: total,
            activeProducers,
            cities: citiesRows.map(r => r.city),
            totalListings,
        };
    }
    // ─── Task lifecycle (A2A Gap 7 fix) ───────────────────────
    createTask(method, params, consumerAgentId) {
        const db = (0, init_1.getDb)();
        const id = (0, uuid_1.v4)();
        const now = new Date().toISOString();
        db.prepare(`
      INSERT INTO tasks (id, consumer_agent_id, method, params, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?)
    `).run(id, consumerAgentId || null, method, JSON.stringify(params), now, now);
        return { id, status: "submitted", method, createdAt: now };
    }
    updateTask(id, status, result, error) {
        const db = (0, init_1.getDb)();
        db.prepare(`
      UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, result ? JSON.stringify(result) : null, error || null, id);
        return this.getTask(id);
    }
    getTask(id) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
        if (!row)
            return null;
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
    listTasks(consumerAgentId, status) {
        const db = (0, init_1.getDb)();
        let sql = "SELECT * FROM tasks WHERE 1=1";
        const params = [];
        if (consumerAgentId) {
            sql += " AND consumer_agent_id = ?";
            params.push(consumerAgentId);
        }
        if (status) {
            sql += " AND status = ?";
            params.push(status);
        }
        sql += " ORDER BY created_at DESC LIMIT 100";
        const rows = db.prepare(sql).all(...params);
        return rows.map(r => ({
            id: r.id,
            method: r.method,
            status: r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }
    // ─── Listing CRUD ─────────────────────────────────────────
    addListing(agentId, listing) {
        const db = (0, init_1.getDb)();
        const id = (0, uuid_1.v4)();
        const agent = this.getAgent(agentId);
        db.prepare(`
      INSERT INTO listings (id, agent_id, product_name, category, description, quantity, unit, price_per_unit, currency, is_organic, image_url, expires_at, delivery_options, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, agentId, listing.productName, listing.category || null, listing.description || null, listing.quantity || null, listing.unit || null, listing.pricePerUnit || null, listing.currency || "NOK", listing.isOrganic ? 1 : 0, listing.imageUrl || null, listing.expiresAt || null, JSON.stringify(listing.deliveryOptions || []), listing.lat || agent?.location?.lat || null, listing.lng || agent?.location?.lng || null);
        return { id, agentId, ...listing };
    }
    getListingsByAgent(agentId) {
        const db = (0, init_1.getDb)();
        return db.prepare("SELECT * FROM listings WHERE agent_id = ? ORDER BY created_at DESC").all(agentId);
    }
    // ─── Check if agent exists by name (for idempotent seeding) ─
    getAgentByName(name) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
        return row ? this.rowToAgent(row) : undefined;
    }
    // ─── Private helpers ──────────────────────────────────────
    generateApiKey() {
        return `lok_${crypto_1.default.randomBytes(32).toString("hex")}`;
    }
    incrementDiscovery(agentId) {
        try {
            const db = (0, init_1.getDb)();
            db.prepare("UPDATE agents SET discovery_count = discovery_count + 1 WHERE id = ?").run(agentId);
        }
        catch { /* non-critical */ }
    }
    rowToAgent(row) {
        if (!row)
            return undefined;
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
    calculateRelevance(agent, query) {
        let score = 0;
        const reasons = [];
        if (query.categories && query.categories.length > 0) {
            const matches = query.categories.filter(cat => agent.categories.some(ac => ac.toLowerCase().includes(cat.toLowerCase())));
            if (matches.length > 0) {
                score += 0.3 * (matches.length / query.categories.length);
                reasons.push(`Kategorier: ${matches.join(", ")}`);
            }
        }
        else {
            score += 0.15;
        }
        if (query.tags && query.tags.length > 0) {
            const matches = query.tags.filter(tag => agent.tags.some(at => at.toLowerCase().includes(tag.toLowerCase())));
            if (matches.length > 0) {
                score += 0.2 * (matches.length / query.tags.length);
                reasons.push(`Tags: ${matches.join(", ")}`);
            }
        }
        if (query.skills && query.skills.length > 0) {
            const matches = query.skills.filter(skillId => agent.skills.some(s => s.id === skillId || s.tags.some(t => t.includes(skillId))));
            if (matches.length > 0) {
                score += 0.15 * (matches.length / query.skills.length);
                reasons.push(`Skills: ${matches.join(", ")}`);
            }
        }
        if (query.location && agent.location) {
            const dist = haversine(query.location.lat, query.location.lng, agent.location.lat, agent.location.lng);
            const maxDist = query.maxDistanceKm || 20;
            const distScore = Math.max(0, 1 - dist / maxDist);
            score += 0.2 * distScore;
            if (dist < 5)
                reasons.push(`${dist.toFixed(1)} km unna`);
        }
        score += 0.1 * agent.trustScore;
        if (agent.trustScore > 0.8)
            reasons.push("Høy tillitsscore");
        if (agent.isVerified) {
            score += 0.05;
            reasons.push("Verifisert");
        }
        return { score: Math.min(1, score), reasons };
    }
}
// ─── Haversine distance ──────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) {
    return deg * (Math.PI / 180);
}
// Singleton
exports.marketplaceRegistry = new MarketplaceRegistry();
//# sourceMappingURL=marketplace-registry.js.map
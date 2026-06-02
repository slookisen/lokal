import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { getConfig } from "../config/vertical-config";
import { AgentRegistrationSchema, AdminRegistrationSchema, DiscoveryQuerySchema } from "../models/marketplace";
import { interactionLogger } from "../services/interaction-logger";
import { knowledgeService, parseProductPrice, isProductHeader, isProductNoise } from "../services/knowledge-service";
import { geocodingService } from "../services/geocoding-service";
import { getDb } from "../database/init";
import { emailService } from "../services/email-service";
import { trustScoreService } from "../services/trust-score-service";
import { conversationService } from "../services/conversation-service";
import { slugify } from "../utils/slug";
import { addUtmParams } from "../utils/url-utm";
import { isBlocked, add as blocklistAdd, list as blocklistList, remove as blocklistRemove } from "../services/blocklist-service";
import { mergeFieldProvenance } from "./admin-knowledge";
import { crossSourceAgreement, type FieldName } from "../services/cross-source-validator";

// ─── Marketplace Routes ───────────────────────────────────────
// These are the OPEN endpoints that make Lokal a marketplace.
// Any agent in the world can:
//   1. Register themselves (POST /api/marketplace/register)
//   2. Discover other agents (POST /api/marketplace/discover)
//   3. Search with natural language (GET /api/marketplace/search?q=...)
//
// This is the "DNS for food agents" — the endpoints that external
// AI agents (ChatGPT, Claude, Gemini plugins) will call.

const router = Router();

// ─── Admin key helper ────────────────────────────────────────
// Accepts ADMIN_KEY or ANALYTICS_ADMIN_KEY so the enrichment
// pipeline can authenticate with the same key used for the dashboard.
function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

// ─── Ensure agent exists in SQLite for FK constraints ───────
// The marketplace registry keeps agents in-memory (loaded from seed/discovery).
// But agent_claims has a FOREIGN KEY to agents(id). If the agent only exists
// in the registry but not in SQLite, the claim INSERT fails.
// This function ensures the agent row exists before any FK-dependent operation.
function ensureAgentInDb(agentId: string): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId);
  if (exists) return true;

  // Try to get from registry and insert
  const agents = marketplaceRegistry.getActiveAgents();
  const agent = agents.find((a: any) => a.id === agentId);
  if (!agent) return false;

  // ─── Blocklist gate ────────────────────────────────────────
  // Producers who replied "fjern" to outreach (or sent a GDPR
  // request) are kept in agent_blocklist. Re-discovery from the
  // daily pipeline must not silently re-insert them. We check
  // by name + website + email so partial-info discovery cycles
  // (e.g. only a name and a Facebook page) still hit the block.
  const blockCheck = isBlocked({
    agentId: agent.id,
    name: agent.name,
    website: agent.url,
    email: agent.contactEmail,
  });
  if (blockCheck.blocked) {
    console.log(`[blocklist] refused ensureAgentInDb for ${agent.name} (matched ${blockCheck.matchedBy}=${blockCheck.matchedValue})`);
    return false;
  }

  try {
    db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city, categories, trust_score, is_active, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      agent.id,
      agent.name,
      agent.description || "",
      agent.provider || "auto-discovered",
      agent.contactEmail || "ukjent@rettfrabonden.com",
      agent.url || `https://rettfrabonden.com/produsent/${slugify(agent.name)}`,
      agent.role || "producer",
      agent.apiKey || `auto_${agent.id}`,
      agent.location?.lat || null,
      agent.location?.lng || null,
      agent.location?.city || null,
      JSON.stringify(agent.categories || []),
      agent.trustScore || 0.5,
      agent.isVerified || 0
    );
    console.log(`[claim] Synced agent ${agent.id} (${agent.name}) to SQLite for FK`);
    return true;
  } catch (err) {
    console.error(`[claim] Failed to sync agent ${agentId} to SQLite:`, err);
    return false;
  }
}

// ─── Helpers: contact block + vCard ──────────────────────────
// Used by /search, /discover (via enrichment) and /vcard endpoint.
// Keeping these inline to avoid a new util module just yet.

function buildContactBlock(agentId: string): {
  address?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  website?: string;
  openingHours?: Array<{ day: string; open: string; close: string }>;
  paymentMethods?: string[];
  deliveryOptions?: string[];
  vcardUrl: string;
} | null {
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return null;
  const k = info.knowledge;
  const hasAnyContact = !!(k.address || k.phone || k.email || k.website);
  if (!hasAnyContact) {
    // Still return vcardUrl so clients always have a handle
    return { vcardUrl: `/api/marketplace/agents/${agentId}/vcard` };
  }
  return {
    address: k.address,
    postalCode: k.postalCode,
    phone: k.phone,
    email: k.email,
    website: k.website ? addUtmParams(k.website) : undefined,
    openingHours: k.openingHours,
    paymentMethods: k.paymentMethods,
    deliveryOptions: k.deliveryOptions,
    vcardUrl: `/api/marketplace/agents/${agentId}/vcard`,
  };
}

// RFC 6350 vCard 3.0 — broad compatibility across iOS, Android, Outlook.
function escapeVCard(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function buildVCard(agentId: string): string | null {
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return null;
  const { agent: _agent, knowledge: k } = info;
  const agent = _agent as any; // Cast for flexibility — agent shape varies
  const lines: string[] = [];
  lines.push("BEGIN:VCARD");
  lines.push("VERSION:3.0");
  lines.push(`FN:${escapeVCard(agent.name)}`);
  lines.push(`ORG:${escapeVCard(agent.name)}`);
  if (k.about) lines.push(`NOTE:${escapeVCard(k.about)}`);
  if (k.phone) lines.push(`TEL;TYPE=WORK,VOICE:${escapeVCard(k.phone)}`);
  if (k.email) lines.push(`EMAIL;TYPE=WORK:${escapeVCard(k.email)}`);
  if (k.website) lines.push(`URL:${escapeVCard(k.website)}`);
  if (k.address || agent.city) {
    // ADR;TYPE=WORK:;;<street>;<city>;<region>;<postal>;<country>
    const street = k.address ? escapeVCard(k.address) : "";
    const city = agent.city ? escapeVCard(agent.city) : "";
    const postal = k.postalCode ? escapeVCard(k.postalCode) : "";
    lines.push(`ADR;TYPE=WORK:;;${street};${city};;${postal};Norway`);
  }
  // Products as NOTE appendix (visible in most contact apps)
  if (k.products && Array.isArray(k.products) && k.products.length > 0) {
    const productList = k.products
      .map((p: any) => {
        // Handle object products and plain strings; skip empty/unknown
        const name = typeof p === "string" ? p : (p.name || p.product || "");
        if (!name || name.toLowerCase() === "ukjent") return null;
        let item = name;
        if (p.price) item += ` (${p.price})`;
        if (p.seasonal && p.months?.length) item += ` [sesong]`;
        return item;
      })
      .filter(Boolean)
      .join(", ");
    if (productList) {
      const notePrefix = k.about ? escapeVCard(k.about) + "\\n\\nProdukter: " : "Produkter: ";
      const noteIdx = lines.findIndex(l => l.startsWith("NOTE:"));
      if (noteIdx >= 0) lines[noteIdx] = `NOTE:${notePrefix}${escapeVCard(productList)}`;
      else lines.push(`NOTE:Produkter: ${escapeVCard(productList)}`);
    }
  }
  // GEO field — helps contact apps show location
  if (agent.location?.lat && agent.location?.lng && agent.location.lat !== 0) {
    lines.push(`GEO:${agent.location.lat};${agent.location.lng}`);
  }
  // Google Maps search URL as custom field — AI agents and contact apps can use this
  const mapsParts = [agent.name];
  if (k.address) mapsParts.push(k.address);
  if (agent.city) mapsParts.push(agent.city);
  mapsParts.push("Norge");
  lines.push(`X-LOKAL-MAPS:https://www.google.com/maps/search/${encodeURIComponent(mapsParts.join(", "))}`);
  // Category tag helps contact apps group these
  const catNames = (agent.categories || []).map((c: string) => c.charAt(0).toUpperCase() + c.slice(1));
  lines.push(`CATEGORIES:${getConfig().display_name},${catNames.length ? catNames.join(",") : "Norsk mat"},Produsent`);
  // Producer page URL
  const profileSlug = slugify(agent.name);
  lines.push(`X-LOKAL-PROFILE:https://rettfrabonden.com/produsent/${profileSlug}`);
  lines.push(`X-LOKAL-AGENT-ID:${agent.id}`);
  if (agent.trustScore !== undefined && agent.trustScore !== null) {
    lines.push(`X-LOKAL-TRUST-SCORE:${Math.round(agent.trustScore * 100)}`);
  }
  lines.push(`REV:${new Date().toISOString()}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9æøåÆØÅ_-]+/g, "_").slice(0, 60) || "agent";
}

// ─── POST /register — Register a new agent ──────────────────
// A producer, logistics provider, or any food agent can register.
// Returns an API key for future authenticated requests.
//
// Example: A farm's agent registers with:
//   { name: "Aker Gård Agent", role: "producer",
//     skills: [{ id: "sell-vegetables", tags: ["tomater", "poteter"] }],
//     location: { lat: 59.95, lng: 10.77, city: "Oslo" } }

router.post("/register", (req: Request, res: Response) => {
  try {
    const registration = AgentRegistrationSchema.parse(req.body);

    // Blocklist gate — quietly reject without leaking why.
    const blocked = isBlocked({
      name: registration.name,
      website: (registration as any).url,
      email: (registration as any).contactEmail,
    });
    if (blocked.blocked) {
      console.log(`[blocklist] refused /register for ${registration.name} (matched ${blocked.matchedBy})`);
      res.status(403).json({ success: false, error: "Registrering ikke tillatt" });
      return;
    }

    const agent = marketplaceRegistry.register(registration);

    interactionLogger.log("register", {
      agentId: agent.id,
      metadata: { name: agent.name, role: agent.role, city: agent.location?.city },
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: "Agent registrert i Lokal-markedsplassen",
      data: {
        id: agent.id,
        apiKey: agent.apiKey, // Store this! Needed for updates
        agentCardUrl: `${getBaseUrl(req)}/api/marketplace/agents/${agent.id}/card`,
        registeredAt: agent.registeredAt,
      },
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({
        success: false,
        error: "Ugyldig registrering",
        details: (error as any).issues ?? error.errors,
      });
    } else {
      res.status(500).json({ success: false, error: "Intern feil" });
    }
  }
});

// ─── POST /discover — Structured agent discovery ─────────────
// Consumer agents call this to find producers matching criteria.
// This is the A2A-compatible discovery endpoint.
//
// Body: { categories: ["vegetables"], tags: ["organic"],
//         location: { lat: 59.92, lng: 10.75 }, maxDistanceKm: 5 }

router.post("/discover", (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const query = DiscoveryQuerySchema.parse(req.body);
    const results = marketplaceRegistry.discover(query);

    interactionLogger.log("discover", {
      query: JSON.stringify({ categories: query.categories, tags: query.tags }),
      resultCount: results.length,
      matchedAgentIds: results.map(r => r.agent.id),
      metadata: { query },
      ipAddress: req.ip,
      durationMs: Date.now() - startTime,
    });

    const enrichedResults = results.map((r: any) => ({
      ...r,
      contact: buildContactBlock(r.agent.id),
    }));

    // Auto-start conversations with top matches
    const conversations: any[] = [];
    if (results.length > 0) {
      const queryDesc = [query.categories?.join(", "), query.tags?.join(", ")].filter(Boolean).join(" — ") || "strukturert søk";
      for (const r of results.slice(0, 2)) {
        try {
          const conv = conversationService.startConversation({
            sellerAgentId: r.agent.id,
            queryText: queryDesc,
            source: "api",
            autoRespond: true,
          });
          conversations.push({ conversationId: conv.id, sellerAgentId: r.agent.id });
        } catch { /* non-critical */ }
      }
    }

    res.json({
      success: true,
      count: enrichedResults.length,
      query: {
        role: query.role,
        categories: query.categories,
        tags: query.tags,
        maxDistanceKm: query.maxDistanceKm,
      },
      results: enrichedResults,
      conversations,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ success: false, error: "Ugyldig søk", details: (error as any).issues ?? error.errors });
    } else {
      res.status(500).json({ success: false, error: "Intern feil" });
    }
  }
});

// ─── GET /search?q=... — Natural language search ─────────────
// The "Google-like" endpoint. Consumer agents send a text query,
// we parse it and return matching agents.
//
// Example: GET /search?q=ferske+økologiske+grønnsaker+nær+Grünerløkka

router.get("/search", async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    res.status(400).json({ success: false, error: "Mangler ?q= parameter" });
    return;
  }

  // Parse natural language into structured query (categories, tags, product terms)
  const parsed = marketplaceRegistry.parseNaturalQuery(q);

  // ── Location resolution (priority order) ──
  // 1. Frontend geolocation (user clicked "Nær meg")
  // 2. Location extracted from query text via geocoding ("tomat i Nesbyen")
  // 3. No location → results from whole country

  const frontendLat = parseFloat(req.query.lat as string);
  const frontendLng = parseFloat(req.query.lng as string);
  const heleNorge = req.query.heleNorge === "true"; // explicit opt-out of geo filter

  let geoSource = "none";

  if (!heleNorge) {
    if (!isNaN(frontendLat) && !isNaN(frontendLng)) {
      // User's browser geolocation
      parsed.location = { lat: frontendLat, lng: frontendLng };
      parsed.maxDistanceKm = parseFloat(req.query.radius as string) || 30;
      geoSource = "browser";
    } else if (!parsed.location) {
      // Try to extract place name from query and geocode it
      const geoResult = await geocodingService.extractAndGeocode(q);
      if (geoResult) {
        parsed.location = { lat: geoResult.lat, lng: geoResult.lng };
        parsed.maxDistanceKm = geoResult.radiusKm;
        geoSource = geoResult.source;
      }
    }
  }

  // Preserve internal fields through schema parsing (Zod strips unknown fields)
  const productTerms = parsed._productTerms;
  const nameQuery = (parsed as any)._nameQuery;
  const requestedLimit = parseInt(req.query.limit as string) || 20;
  const query = DiscoveryQuerySchema.parse({
    ...parsed,
    limit: requestedLimit,
    offset: parseInt(req.query.offset as string) || 0,
  });
  if (productTerms) (query as any)._productTerms = productTerms;
  if (nameQuery) (query as any)._nameQuery = nameQuery;

  const startTime = Date.now();
  let results = marketplaceRegistry.discover(query);

  // ── Auto-expanding radius ──
  // If geo-filtered and too few results, widen the search automatically.
  // This handles rural areas where 30km might only have 1-2 sellers.
  const MIN_RESULTS = 3;
  const RADIUS_STEPS = [50, 100, 200]; // km

  // Don't expand if we got results from a name-based search — those are exact matches
  const wasNameMatch = nameQuery && results.length > 0 && results[0]?.matchReasons?.some((r: string) => r.startsWith("Navnematch"));
  if (parsed.location && results.length < MIN_RESULTS && !heleNorge && !wasNameMatch) {
    for (const expandedRadius of RADIUS_STEPS) {
      if (results.length >= MIN_RESULTS) break;
      const expandedQuery = DiscoveryQuerySchema.parse({
        ...parsed,
        maxDistanceKm: expandedRadius,
        limit: requestedLimit,
        offset: 0,
      });
      if (productTerms) (expandedQuery as any)._productTerms = productTerms;
      results = marketplaceRegistry.discover(expandedQuery);
    }

    // Last resort: no geo filter at all (show whole country)
    if (results.length < MIN_RESULTS) {
      const noGeoQuery = DiscoveryQuerySchema.parse({
        ...parsed,
        location: undefined,
        maxDistanceKm: undefined,
        limit: requestedLimit,
        offset: 0,
      });
      if (productTerms) (noGeoQuery as any)._productTerms = productTerms;
      results = marketplaceRegistry.discover(noGeoQuery);
    }
  }

  interactionLogger.log("search", {
    query: q,
    resultCount: results.length,
    matchedAgentIds: results.map(r => r.agent.id),
    metadata: { parsed, geoSource },
    ipAddress: req.ip,
    durationMs: Date.now() - startTime,
  });

  // Slugify for profile links
  const slug = (text: string) => text.normalize("NFC").toLowerCase()
    .replace(/\u00e6/g, "ae").replace(/\u00f8/g, "o").replace(/\u00e5/g, "a")
    .replace(/\u00e4/g, "a").replace(/\u00f6/g, "o").replace(/\u00fc/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

  const enrichedResults = results.map((r: any) => {
    const contact = buildContactBlock(r.agent.id);
    const profileUrl = `${BASE_URL}/produsent/${slug(r.agent.name)}`;

    // Include products with prices for all results (essential for AI agents)
    const info = knowledgeService.getAgentInfo(r.agent.id);
    const k = info?.knowledge;
    let products: any[] | undefined;
    if (Array.isArray(k?.products) && k.products.length) {
      products = k.products
        .filter((p: any) => {
          const n = (p.name || "").trim();
          return n && !isProductHeader(n) && !isProductNoise(n);
        })
        .map((p: any) => {
          const { cleanName, price } = parseProductPrice(p);
          return {
            name: cleanName,
            category: p.category !== "other" ? p.category : undefined,
            price: price || p.price || undefined,
            seasonal: p.seasonal || undefined,
            organic: p.organic || undefined,
          };
        });
    }

    return {
      ...r,
      contact,
      profileUrl,
      products,
      productsCount: products?.length || 0,
    };
  });

  // ─── Auto-start conversations with top matches ────────────
  // Only for bot/agent traffic — not for humans browsing the site.
  // ChatGPT Custom GPT, OpenAI agents, etc. have identifiable UA strings.
  // Humans use the /sok frontend which calls discover() directly.
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const acceptHeader = (req.headers["accept"] || "").toLowerCase();
  // Treat all JSON-accepting clients as agents (ChatGPT JIT plugin, MCP clients, etc.)
  // The /sok frontend uses its own discover() call, not this endpoint.
  const isAgent = acceptHeader.includes("application/json")
    || ua.includes("gpt") || ua.includes("openai") || ua.includes("claude")
    || ua.includes("bot") || ua.includes("agent") || ua.includes("python")
    || ua.includes("node-fetch") || ua.includes("axios") || ua.includes("httpie");

  const conversations: any[] = [];
  if (isAgent && results.length > 0) {
    for (const r of results.slice(0, 2)) {
      try {
        const conv = conversationService.startConversation({
          sellerAgentId: r.agent.id,
          queryText: q,
          source: "api",
          autoRespond: true,
        });
        conversations.push({
          conversationId: conv.id,
          sellerAgentId: r.agent.id,
          sellerAgentName: conv.sellerAgentName,
          messageCount: conv.messages.length,
        });
      } catch { /* non-critical */ }
    }
  }

  const safeQuery = q.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "");
  res.json({
    success: true,
    query: safeQuery,
    parsed: { ...parsed, _nameQuery: nameQuery || undefined },
    geoFiltered: !!parsed.location && !heleNorge,
    geoSource,
    count: enrichedResults.length,
    results: enrichedResults,
    conversations,
  });
});

// ─── GET /agents/:id/vcard — Download vCard for contacts ─────
// Returns a standard RFC 6350 vCard 3.0 payload so buyers can
// tap "add to contacts" straight from a chat answer.

router.get("/agents/:id/vcard", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const vcard = buildVCard(agentId);
  if (!vcard) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }
  const info = knowledgeService.getAgentInfo(agentId);
  const filename = safeFileName(info?.agent.name || "agent") + ".vcf";

  interactionLogger.log("view", {
    agentId: agentId,
    metadata: { type: "vcard_download", buyerAgent: req.headers["x-agent-id"] as string },
    ipAddress: req.ip,
  });

  res.setHeader("Content-Type", "text/vcard; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(vcard);
});

// ─── GET /agents/:id/card — Individual agent card (A2A) ──────
// Standard A2A agent card enriched with knowledge data.
// This is the main endpoint AI agents use to learn about a producer,
// so it must include everything: contact, products, hours, certs, links.

router.get("/agents/:id/card", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const card = marketplaceRegistry.getAgentCard(agentId) as any;
  if (!card) {
    res.status(404).json({ error: "Agent ikke funnet" });
    return;
  }

  // Enrich with knowledge data so AI agents get the full picture
  const info = knowledgeService.getAgentInfo(agentId);
  if (info) {
    const k = info.knowledge as any;
    const agent = info.agent as any;
    const cityName = agent.city || agent.location?.city || "";

    // Contact info block — critical for AI agents recommending businesses
    const contact: any = {};
    if (k.address) contact.address = k.address;
    if (k.postalCode) contact.postalCode = k.postalCode;
    if (cityName) contact.city = cityName;
    contact.country = "Norway";
    if (k.phone) contact.phone = k.phone;
    if (k.email) contact.email = k.email;
    if (k.website) contact.website = addUtmParams(k.website);
    if (Object.keys(contact).length > 1) card.contact = contact;

    // Products — the core of what this producer offers
    if (k.products && Array.isArray(k.products) && k.products.length > 0) {
      card.products = k.products
        .map((p: any) => {
          if (typeof p === "string") return { name: p };
          const item: any = {};
          if (p.name) item.name = p.name;
          if (p.category) item.category = p.category;
          if (p.price) item.price = p.price;
          if (p.seasonal) item.seasonal = p.seasonal;
          if (p.months) item.availableMonths = p.months;
          if (p.organic) item.organic = true;
          return Object.keys(item).length > 0 ? item : null;
        })
        .filter(Boolean);
    }

    // Opening hours
    if (k.openingHours && Array.isArray(k.openingHours) && k.openingHours.length > 0) {
      card.openingHours = k.openingHours;
    } else if (typeof k.openingHours === "string" && k.openingHours) {
      card.openingHours = k.openingHours;
    }

    // Certifications, specialties, payment, delivery
    // PR-95: certifications list is already relabel-by-debio_verified in
    // knowledgeService.getAgentInfo. Also expose `debioVerified` as a
    // first-class boolean so the frontend can render the badge separately.
    if (k.certifications?.length) card.certifications = k.certifications;
    if (info.agent.debioVerified === true) card.debioVerified = true;
    if (k.specialties?.length) card.specialties = k.specialties;
    if (k.paymentMethods?.length) card.paymentMethods = k.paymentMethods;
    if (k.deliveryOptions?.length) card.deliveryOptions = k.deliveryOptions;

    // Tier 2: seasonality, images, delivery details
    if (k.seasonality?.length) card.seasonality = k.seasonality;
    if (k.images?.length) card.images = k.images;
    if (k.deliveryRadius != null) card.deliveryRadius = k.deliveryRadius;
    if (k.minOrderValue != null) card.minOrderValue = k.minOrderValue;

    // Google rating
    if (k.ratings?.google?.score) {
      card.googleRating = k.ratings.google.score;
      card.googleReviewCount = k.ratings.google.reviews || 0;
    }

    // About text (richer than description)
    if (k.about) card["x-lokal"].about = k.about;

    // A2A protocol versioning
    card.schemaVersion = agent.schemaVersion || "urn:a2a:1.0";
    card.agentVersion = agent.agentVersion || 1;

    // Useful links for AI agents and consumers
    const slug = slugify(agent.name);
    const mapsParts = [agent.name];
    if (k.address) mapsParts.push(k.address);
    if (cityName) mapsParts.push(cityName);
    mapsParts.push("Norge");

    // Top-level canonical URL — explicit so AI agents reading the
    // card don't have to dig into links.profile or invent one from name.
    card.canonicalUrl = `https://rettfrabonden.com/produsent/${slug}`;
    card.links = {
      profile: `https://rettfrabonden.com/produsent/${slug}`,
      googleMaps: `https://www.google.com/maps/search/${encodeURIComponent(mapsParts.join(", "))}`,
      vcard: `${getBaseUrl(req)}/api/marketplace/agents/${agentId}/vcard`,
    };
    if (k.website) card.links.website = addUtmParams(k.website);

    // ─── Phase 5.11 A2.5: affiliations skill (producer + umbrella) ──
    // Adds machine-readable umbrella memberships to the A2A agent-card so
    // AI agents can navigate the network without HTML-scraping the page.
    // Producer view: list umbrellas the producer is an active member of.
    // Umbrella view: list producers in the umbrella's network (cap 200).
    try {
      const db = getDb();
      const a = (agent as any);
      if (a.umbrella_type) {
        const members = db.prepare(`
          SELECT p.id, p.name, p.city, aff.labels, aff.status
          FROM agent_affiliations aff
          INNER JOIN agents p ON p.id = aff.producer_id
          WHERE aff.umbrella_id = ?
            AND aff.status = 'active'
            AND p.is_active = 1
          ORDER BY p.trust_score DESC, p.name ASC
          LIMIT 200
        `).all(agentId) as any[];
        if (members.length) {
          card.skills = (card.skills || []).concat([{
            id: "umbrella-members",
            name: "Produsenter i nettverket",
            description: "Liste over produsenter som er medlem av denne paraplyen.",
            tags: ["umbrella", "members", "network", a.umbrella_type],
            members: members.map(m => ({
              producer_id: m.id,
              producer_name: m.name,
              city: m.city,
              labels: m.labels ? (() => { try { return JSON.parse(m.labels); } catch { return []; } })() : [],
              card_url: `${getBaseUrl(req)}/api/marketplace/agents/${m.id}/card`,
              profile_url: `https://rettfrabonden.com/produsent/${slugify(m.name)}`,
            })),
          }]);
        }
        // Always expose umbrella metadata so AI clients can parse type + parent
        card.umbrella = {
          type: a.umbrella_type,
          parent_umbrella_id: a.parent_umbrella_id || null,
          member_count: a.umbrella_member_count || 0,
        };
      } else {
        // Producer view: list affiliations
        const affs = db.prepare(`
          SELECT u.id, u.name, u.umbrella_type, aff.labels, aff.status
          FROM agent_affiliations aff
          INNER JOIN agents u ON u.id = aff.umbrella_id
          WHERE aff.producer_id = ?
            AND aff.status = 'active'
            AND u.is_active = 1
          ORDER BY u.name ASC
        `).all(agentId) as any[];
        if (affs.length) {
          card.skills = (card.skills || []).concat([{
            id: "affiliations",
            name: "Tilknytninger",
            description: "Paraplyer denne produsenten er medlem av (markeds-nettverk, sertifiseringer, samvirker).",
            tags: ["affiliations", "umbrella-membership"],
            affiliations: affs.map(u => ({
              umbrella_id: u.id,
              umbrella_name: u.name,
              umbrella_type: u.umbrella_type,
              labels: u.labels ? (() => { try { return JSON.parse(u.labels); } catch { return []; } })() : [],
              card_url: `${getBaseUrl(req)}/api/marketplace/agents/${u.id}/card`,
              profile_url: `https://rettfrabonden.com/produsent/${slugify(u.name)}`,
            })),
          }]);
        }
      }
    } catch (e) {
      // Affiliations are optional metadata — failure here must not break card delivery
      console.error("[seo:phase5.11.a2.5] agent-card affiliations failed:", e);
    }
  }

  res.json(card);
});

// ─── PUT /agents/:id — Update agent (authenticated) ──────────
// Agents can update their own info using their API key

router.put("/agents/:id", (req: Request, res: Response) => {
  const apiKey = req.headers["x-api-key"] as string;
  const agentId = req.params.id as string;
  if (!apiKey) {
    res.status(401).json({ error: "Mangler X-API-Key header" });
    return;
  }

  const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
  if (!agent || agent.id !== agentId) {
    res.status(403).json({ error: "Ikke autorisert" });
    return;
  }

  const updated = marketplaceRegistry.updateAgent(agentId, req.body);
  if (!updated) {
    res.status(404).json({ error: "Agent ikke funnet" });
    return;
  }

  res.json({ success: true, data: { id: updated.id, name: updated.name, lastSeenAt: updated.lastSeenAt } });
});

// ─── PATCH /agents/:id — Admin update agent fields ──────────
// Allows admin to update description, categories, tags, etc.
// Requires X-Admin-Key header.

router.patch("/agents/:id", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }

  const adminKey = req.headers["x-admin-key"] as string;
  const apiKey = req.headers["x-api-key"] as string;
  const agentId = req.params.id as string;

  // Accept either admin key or the agent's own API key
  let authorized = false;
  if (expectedKey && adminKey && adminKey === expectedKey) authorized = true;
  if (!authorized && apiKey) {
    const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
    if (agent && agent.id === agentId) authorized = true;
  }

  if (!authorized) {
    res.status(403).json({ error: "Krever X-Admin-Key eller X-API-Key header" });
    return;
  }

  const updated = marketplaceRegistry.updateAgent(agentId, req.body);
  if (!updated) {
    res.status(404).json({ error: "Agent ikke funnet" });
    return;
  }

  res.json({ success: true, data: { id: updated.id, name: updated.name, description: updated.description } });
});

// ─── POST /agents/:id/heartbeat — Keep agent alive ───────────
// Agents should ping this periodically so we know they're active

router.post("/agents/:id/heartbeat", (req: Request, res: Response) => {
  const apiKey = req.headers["x-api-key"] as string;
  const agentId = req.params.id as string;
  const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
  if (!agent || agent.id !== agentId) {
    res.status(403).json({ error: "Ikke autorisert" });
    return;
  }
  marketplaceRegistry.heartbeat(agentId);
  res.json({ success: true, lastSeenAt: new Date().toISOString() });
});

// ─── GET /stats — Marketplace stats ──────────────────────────

router.get("/stats", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: marketplaceRegistry.getStats(),
  });
});

// ─── GET /geocode — Resolve Norwegian place name → lat/lng (PR-76) ────
// Backs the lokal_geocode MCP tool for the stdio (npm) server which calls
// this endpoint over HTTP. The HTTP-MCP server (src/routes/mcp.ts) calls
// the geocodingService directly without going through this endpoint.
router.get("/geocode", async (req: Request, res: Response) => {
  const place = (req.query.place || req.query.q || "").toString().trim();
  if (!place) {
    res.status(400).json({ success: false, error: "Missing 'place' query parameter" });
    return;
  }
  try {
    const result = await geocodingService.geocode(place);
    if (!result) {
      res.status(404).json({ success: false, error: `No coordinates found for "${place}"`, place });
      return;
    }
    res.json({
      success: true,
      place,
      result: {
        name: result.name,
        lat: result.lat,
        lng: result.lng,
        radiusKm: result.radiusKm,
        source: result.source,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || "Geocoding failed" });
  }
});

// ─── GET /agents — List all active agents ────────────────────

router.get("/agents", (_req: Request, res: Response) => {
  const agents = marketplaceRegistry.getActiveAgents();
  res.json({
    success: true,
    count: agents.length,
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      role: a.role,
      categories: a.categories,
      tags: a.tags,
      location: a.location ? { city: a.location.city } : undefined,
      trustScore: a.trustScore,
      isVerified: a.isVerified,
      isClaimed: knowledgeService.isAgentClaimed(a.id),
      skills: a.skills.map(s => ({ id: s.id, name: s.name, tags: s.tags })),
    })),
  });
});

// ═══════════════════════════════════════════════════════════════
// AGENT KNOWLEDGE — "Tell me about this seller"
// The core of the dummy-agent system. Buyer agents call this
// to get everything we know about a seller: address, products,
// hours, ratings, etc. Honest about data provenance.
// ═══════════════════════════════════════════════════════════════

// ─── GET /agents/:id/info — Structured seller info ──────────
// This is what buyer agents call. Returns everything we know
// about this seller in a clean, parseable format.
//
// Example response:
//   { agent: { name, city, trustScore, isClaimed },
//     knowledge: { address, products, openingHours, ... },
//     meta: { dataSource: "auto", disclaimer: "..." } }

router.get("/agents/:id/info", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }

  // Log the view
  interactionLogger.log("view", {
    agentId: agentId,
    metadata: { type: "agent_info_request", buyerAgent: req.headers["x-agent-id"] as string },
    ipAddress: req.ip,
  });

  res.json({ success: true, data: info });
});

// ─── GET /agents/:id/knowledge — Raw knowledge data ─────────
// For admin/debugging. Returns the raw knowledge record.

router.get("/agents/:id/knowledge", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const knowledge = knowledgeService.getKnowledge(agentId);
  if (!knowledge) {
    res.status(404).json({ success: false, error: "Ingen kunnskapsdata for denne agenten" });
    return;
  }
  res.json({ success: true, data: knowledge });
});

// ─── POST /admin/agents/:id/curated-fields — Set or clear field lock (Phase 4.9a) ───
// Used by rfb-customer-service when applying customer-requested changes.
// Body: { "field": "about", "meta": { locked_at, by, thread_id, request_summary } }
// To unlock: send { "field": "about", "meta": null }
//
// Auth: admin-key only (CS-agent uses this).
router.post("/admin/agents/:id/curated-fields", (req: Request, res: Response) => {
  const adminKeyHeader = (req.headers["x-admin-key"] as string) || "";
  const expectedAdminKey = getAdminKey();
  if (!expectedAdminKey || adminKeyHeader !== expectedAdminKey) {
    res.status(403).json({ success: false, error: "Admin key required" });
    return;
  }
  const agentId = req.params.id as string;
  const { field, meta } = req.body as { field?: unknown; meta?: unknown };
  if (typeof field !== "string" || !field) {
    res.status(400).json({ success: false, error: "field (string) required" });
    return;
  }
  if (meta !== null && (typeof meta !== "object" || !meta)) {
    res.status(400).json({ success: false, error: "meta must be object or null" });
    return;
  }
  if (meta && typeof (meta as Record<string, unknown>).locked_at !== "string") {
    res.status(400).json({ success: false, error: "meta.locked_at (ISO string) required when meta is set" });
    return;
  }
  if (meta && typeof (meta as Record<string, unknown>).by !== "string") {
    res.status(400).json({ success: false, error: "meta.by (string) required when meta is set" });
    return;
  }
  try {
    knowledgeService.setCuratedFieldLock(agentId, field, meta as any);
    res.json({
      success: true,
      agent_id: agentId,
      field,
      locked: meta !== null,
      curated_fields: knowledgeService.getCuratedFields(agentId),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /knowledge/stats — Knowledge layer statistics ──────

router.get("/knowledge/stats", (_req: Request, res: Response) => {
  const stats = knowledgeService.getKnowledgeStats();
  res.json({ success: true, data: stats });
});

// ═══════════════════════════════════════════════════════════════
// CLAIM SYSTEM — Sellers take ownership of their agent
// Flow:
//   1. POST /agents/:id/claim         → Request claim (get verification code)
//   2. POST /agents/:id/claim/verify  → Submit code → get claim token
//   3. PUT  /agents/:id/knowledge     → Update info (with claim token)
// ═══════════════════════════════════════════════════════════════

// ─── POST /agents/:id/claim — Request to claim an agent ─────

router.post("/agents/:id/claim", async (req: Request, res: Response) => {
  const { name, email, phone, source } = req.body;
  const agentId = req.params.id as string;
  if (!name || !email) {
    res.status(400).json({ success: false, error: "Navn og e-post er påkrevd" });
    return;
  }

  // Ensure the agent exists in SQLite before creating a claim (FK constraint)
  if (!ensureAgentInDb(agentId)) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }

  try {
    const result = knowledgeService.requestClaim(agentId, {
      claimantName: name,
      claimantEmail: email,
      claimantPhone: phone,
      source: source || 'organic',
    });

    // Get agent name for the email
    const agents = marketplaceRegistry.getActiveAgents();
    const agent = agents.find((a: any) => a.id === agentId);
    const agentName = agent?.name || "Ukjent produsent";

    // Send verification code via email (graceful fallback if SMTP not configured)
    const emailResult = await emailService.sendVerificationCode(email, result.verificationCode, agentName);

    // Build response — include code in dev/dry-run mode, hide in production
    const responseData: any = { claimId: result.claimId };
    if (emailResult.messageId === "DRY_RUN") {
      // SMTP not configured — return code in response so dev/testing still works
      responseData.verificationCode = result.verificationCode;
      responseData._note = "E-post ikke konfigurert. Koden vises kun i testmodus.";
    }

    res.json({
      success: true,
      message: emailResult.messageId === "DRY_RUN"
        ? "Verifiseringskode generert (e-post ikke aktiv ennå)."
        : `Verifiseringskode sendt til ${email}.`,
      data: responseData,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /agents/:id/claim/verify — Verify claim ──────────

router.post("/agents/:id/claim/verify", (req: Request, res: Response) => {
  const { claimId, code } = req.body;
  const agentId = req.params.id as string;
  if (!claimId || !code) {
    res.status(400).json({ success: false, error: "claimId og code er påkrevd" });
    return;
  }

  const result = knowledgeService.verifyClaim(claimId, code);
  if (!result.success) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }

  // Recalculate trust score now that the agent is verified
  const newTrustScore = trustScoreService.update(agentId);

  // Send admin notification about the new verified claim
  try {
    const db = getDb();
    const claim = db.prepare(
      "SELECT claimant_name, claimant_email, source FROM agent_claims WHERE id = ?"
    ).get(claimId) as any;
    const agent = db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as any;
    if (claim && agent) {
      emailService.sendAdminClaimNotification(
        agent.name,
        agentId,
        claim.claimant_name,
        claim.claimant_email,
        claim.source || "organic"
      ).catch((err: any) => console.error("[Admin notify] Failed:", err.message));
    }
  } catch (err: any) {
    console.error("[Admin notify] Error:", err.message);
  }

  res.json({
    success: true,
    message: "Agenten er nå din! Bruk claim-token for å oppdatere informasjon.",
    data: {
      claimToken: result.claimToken,
      agentId: agentId,
      trustScore: newTrustScore,
    },
  });
});

// ─── POST /auth/login — Token-based login (single DB lookup) ──────────

router.post("/auth/login", (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ success: false, error: "Token er påkrevd" });
    return;
  }

  const claim = knowledgeService.getClaimByToken(token);
  if (!claim) {
    res.status(401).json({ success: false, error: "Ugyldig eller utløpt token" });
    return;
  }

  // Return the agent ID so the client can go straight to dashboard
  res.json({
    success: true,
    data: {
      agentId: claim.agentId,
      claimantName: claim.claimantName,
    },
  });
});

// ─── POST /auth/magic-link — Request magic link login ──────────

router.post("/auth/magic-link", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ success: false, error: "E-post er påkrevd" });
    return;
  }

  try {
    const result = knowledgeService.createMagicLink(email.toLowerCase().trim());
    if (!result.success) {
      // Don't reveal whether email exists — always show success to prevent enumeration
      res.json({ success: true, message: "Hvis e-posten er registrert, vil du motta en innloggingslenke." });
      return;
    }

    const baseUrl = process.env.APP_URL || "https://rettfrabonden.com";
    // Path-based URL (no `=` in plaintext) so SMTP relays cannot mangle it as
    // quoted-printable. Redirect route below sends browser to /selger?magic=...
    // where existing JS reads it from window.location.search.
    // See `GET /auth/m/:token` route below.
    const magicUrl = `${baseUrl}/api/marketplace/auth/m/${result.token}`;

    await emailService.sendMagicLink(email, magicUrl, result.agentName || "din agent");

    res.json({
      success: true,
      message: "Hvis e-posten er registrert, vil du motta en innloggingslenke.",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Kunne ikke sende innloggingslenke" });
  }
});

// ─── GET /auth/magic-verify — Verify magic link token ──────────

router.get("/auth/magic-verify", (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).json({ success: false, error: "Token mangler" });
    return;
  }

  const result = knowledgeService.verifyMagicLink(token);
  if (!result.success) {
    res.status(401).json({ success: false, error: result.error });
    return;
  }

  res.json({
    success: true,
    data: {
      agentId: result.agentId,
      claimToken: result.claimToken,
      claimantName: result.claimantName,
    },
  });
});

// ─── GET /auth/m/:token — Path-based magic redirect ──────────
// Email plaintext URLs don't tolerate `=` reliably (Resend SMTP relay
// re-encodes as quoted-printable, mangling `?magic=<hex>` so receivers
// see `?magic7b...` (= dropped) or `?magic\u00ef\u00bf\u00bd518d...` (replacement char).
// 2026-05-05: rfb-supervisor confirmed `textEncoding: base64` on app side
// did not help — relay re-encodes downstream.) This route accepts the
// token in the path (no `=`) and 302-redirects to /selger?magic=<token>
// where existing selger.html JS handles auto-login.
router.get("/auth/m/:token", (req: Request, res: Response) => {
  const token = req.params.token as string;
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) {
    res.status(400).send("Ugyldig lenke");
    return;
  }
  res.redirect(302, `/selger?magic=${encodeURIComponent(token)}`);
});

// ─── POST /agents/:id/unclaim — Give up ownership ──────────

router.post("/agents/:id/unclaim", (req: Request, res: Response) => {
  const claimToken = (req.headers["x-claim-token"] as string) || "";
  const agentId = req.params.id as string;
  if (!claimToken) {
    res.status(401).json({ success: false, error: "Claim token påkrevd" });
    return;
  }

  const claim = knowledgeService.getClaimByToken(claimToken);
  if (!claim || claim.agentId !== agentId) {
    res.status(403).json({ success: false, error: "Ikke autorisert for denne agenten" });
    return;
  }

  try {
    const db = getDb();
    // Remove this specific claim
    db.prepare("DELETE FROM agent_claims WHERE agent_id = ? AND claim_token = ?").run(agentId, claimToken);

    // Check if any other verified claims remain for this agent
    const remainingClaims = db.prepare(
      "SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status = 'verified'"
    ).get(agentId) as any;

    if (remainingClaims.c === 0) {
      // No owners left — reset verified status and data source
      db.prepare("UPDATE agents SET is_verified = 0 WHERE id = ?").run(agentId);
      db.prepare("UPDATE agent_knowledge SET data_source = 'auto' WHERE agent_id = ?").run(agentId);
    }

    // Recalculate trust score
    trustScoreService.update(agentId);

    res.json({ success: true, message: "Eierskap frasagt" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /admin/agents/:id/reset-claim — Admin: reset verified/claim status ──

router.post("/admin/agents/:id/reset-claim", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  const agentId = req.params.id as string;
  if (!expectedKey) {
    res.status(503).json({ success: false, error: "Admin not configured" });
    return;
  }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Admin key required" });
    return;
  }

  try {
    const db = getDb();
    db.prepare("UPDATE agents SET is_verified = 0 WHERE id = ?").run(agentId);
    db.prepare("DELETE FROM agent_claims WHERE agent_id = ?").run(agentId);
    db.prepare("UPDATE agent_knowledge SET data_source = 'auto' WHERE agent_id = ?").run(agentId);
    trustScoreService.update(agentId);
    res.json({ success: true, message: "Claim and verification reset" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /agents/:id/knowledge — Update knowledge ───────────
// Authenticated via claim token, API key, OR admin key.
// Admin key uses upsertKnowledge (dataSource: "auto") for enrichment.
// Claim token / API key uses ownerUpdate (dataSource: "owner").

router.put("/agents/:id/knowledge", (req: Request, res: Response) => {
  const claimToken = (req.headers["x-claim-token"] as string) || "";
  const apiKey = (req.headers["x-api-key"] as string) || "";
  const adminKeyHeader = (req.headers["x-admin-key"] as string) || "";
  const expectedAdminKey = getAdminKey();
  const agentId = req.params.id as string;

  let authorized = false;
  let isAdmin = false;

  // 1. Admin key — for automated enrichment (dataSource: "auto")
  if (expectedAdminKey && adminKeyHeader && adminKeyHeader === expectedAdminKey) {
    authorized = true;
    isAdmin = true;
  }

  // 2. Claim token — seller who has claimed their agent
  if (!authorized && claimToken) {
    const claim = knowledgeService.getClaimByToken(claimToken);
    if (claim && claim.agentId === agentId) authorized = true;
  }

  // 3. API key — agent's own key from registration
  if (!authorized && apiKey) {
    const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
    if (agent && agent.id === agentId) authorized = true;
  }

  if (!authorized) {
    res.status(403).json({ success: false, error: "Ikke autorisert. Bruk X-Admin-Key, X-Claim-Token eller X-API-Key header." });
    return;
  }

  try {
    if (isAdmin) {
      // Admin enrichment — preserve dataSource as "auto" (or what's in body)
      knowledgeService.upsertKnowledge(agentId, {
        ...req.body,
        dataSource: req.body.dataSource || "auto",
      });
    } else {
      // Owner update — sets dataSource to "owner"
      knowledgeService.ownerUpdate(agentId, req.body);
    }

    // Recalculate trust score — completeness signal changes with every update
    const newTrustScore = trustScoreService.update(agentId);

    const updated = knowledgeService.getAgentInfo(agentId);
    res.json({
      success: true,
      message: isAdmin ? "Kunnskapsdata beriket (auto)" : "Kunnskapsdata oppdatert",
      data: { ...updated, trustScore: newTrustScore },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── PUT /agents/:id/description — Write agent.name + agent.description (PR-42) ─
// The `/knowledge` endpoint writes `agent_knowledge.about` (long-form bio).
// THIS endpoint writes the columns on the `agents` table that drive
// h1/title/og:description/Schema.org meta tags on /produsent/<slug>.
//
// Why a separate endpoint:
// - CS-agent and orchestrator both confirmed 2026-05-12..15 that they could
//   not find a discoverable path to fix `agents.name`/`agents.description`.
//   (PATCH /agents/:id exists with the same auth and column-set but the
//    /knowledge sibling is what CS reaches for; this alias makes the write
//    path symmetrical and discoverable.)
// - Two real instances broke autonomous CS: PAN (2026-05-14) + Fiddan (2026-05-15).
//   Both required Daniel-attestation + manual DB write. This endpoint closes
//   that dev-debt class so future B2-HIGH-evidens corrections can land
//   autonomously.
//
// Auth model mirrors PUT /agents/:id/knowledge:
//   1. X-Admin-Key   → admin enrichment / CS-relay fixes
//   2. X-Claim-Token → producer who has claimed their listing
//   3. X-API-Key     → agent's own key
//
// Body: { name?: string, description?: string }
//   - Both fields optional; at least one required.
//   - name: 1..200 chars after trim
//   - description: 1..500 chars after trim
//   - Any other field in the body is rejected (so callers don't accidentally
//     overwrite city/categories/tags via this endpoint — those have their
//     own routes via /knowledge and PATCH /agents/:id).
router.put("/agents/:id/description", (req: Request, res: Response) => {
  const claimToken = (req.headers["x-claim-token"] as string) || "";
  const apiKey = (req.headers["x-api-key"] as string) || "";
  const adminKeyHeader = (req.headers["x-admin-key"] as string) || "";
  const expectedAdminKey = getAdminKey();
  const agentId = req.params.id as string;

  let authorized = false;

  if (expectedAdminKey && adminKeyHeader && adminKeyHeader === expectedAdminKey) {
    authorized = true;
  }
  if (!authorized && claimToken) {
    const claim = knowledgeService.getClaimByToken(claimToken);
    if (claim && claim.agentId === agentId) authorized = true;
  }
  if (!authorized && apiKey) {
    const a = marketplaceRegistry.getAgentByApiKey(apiKey);
    if (a && a.id === agentId) authorized = true;
  }

  if (!authorized) {
    res.status(403).json({
      success: false,
      error: "Ikke autorisert. Bruk X-Admin-Key, X-Claim-Token eller X-API-Key header.",
    });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const ALLOWED = new Set(["name", "description"]);
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (extra.length > 0) {
    res.status(400).json({
      success: false,
      error: `Felt ikke tillatt på denne pathen: ${extra.join(", ")}. Bruk PUT /agents/:id/knowledge eller PATCH /agents/:id for andre felter.`,
    });
    return;
  }

  const updates: { name?: string; description?: string } = {};
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      res.status(400).json({ success: false, error: "name må være 1-200 tegn etter trim." });
      return;
    }
    updates.name = trimmed;
  } else if (body.name !== undefined) {
    res.status(400).json({ success: false, error: "name må være string." });
    return;
  }

  if (typeof body.description === "string") {
    const trimmed = body.description.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      res.status(400).json({ success: false, error: "description må være 1-500 tegn etter trim." });
      return;
    }
    updates.description = trimmed;
  } else if (body.description !== undefined) {
    res.status(400).json({ success: false, error: "description må være string." });
    return;
  }

  if (updates.name === undefined && updates.description === undefined) {
    res.status(400).json({
      success: false,
      error: "Trenger minst ett av: name, description.",
    });
    return;
  }

  const updated = marketplaceRegistry.updateAgent(agentId, updates);
  if (!updated) {
    res.status(404).json({ success: false, error: "Agent ikke funnet." });
    return;
  }

  res.json({
    success: true,
    message: "Agent navn/beskrivelse oppdatert",
    data: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
    },
  });
});

// ─── POST /admin/register — Relaxed registration for auto-discovery ──
// Only requires name — everything else gets sensible defaults.
// Agents registered this way get lower trust scores until enriched,
// because the completeness signal penalizes missing fields automatically.
// The PUBLIC /register keeps strict requirements — producers who
// self-register MUST provide email, URL, etc. for verification.

router.post("/admin/register", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  try {
    const registration = AdminRegistrationSchema.parse(req.body);

    // Blocklist gate — discovery agent should never re-insert a producer who opted out.
    const blocked = isBlocked({
      name: registration.name,
      website: (registration as any).url,
      email: (registration as any).contactEmail,
    });
    if (blocked.blocked) {
      console.log(`[blocklist] refused /admin/register for ${registration.name} (matched ${blocked.matchedBy})`);
      res.status(409).json({ success: false, error: "Produsent på blokklisten", matchedBy: blocked.matchedBy });
      return;
    }

    // Cast needed: AdminRegistration has optional contactEmail and flexible capabilities,
    // but after Zod parsing all defaults are filled. The DB insert handles both shapes.
    const agent = marketplaceRegistry.register(registration as any);

    interactionLogger.log("register", {
      agentId: agent.id,
      metadata: { name: agent.name, role: agent.role, city: agent.location?.city, source: "admin" },
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: "Agent registrert via admin (relaxed schema)",
      data: {
        id: agent.id,
        apiKey: agent.apiKey,
        agentCardUrl: `${getBaseUrl(req)}/api/marketplace/agents/${agent.id}/card`,
        registeredAt: agent.registeredAt,
      },
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({
        success: false,
        error: "Ugyldig registrering",
        details: (error as any).issues ?? error.errors,
      });
    } else {
      console.error("[admin/register] Error:", error);
      res.status(500).json({ success: false, error: error.message || "Intern feil" });
    }
  }
});

// ─── POST /admin/bulk-enrich — Batch enrich multiple agents ──
// Accepts an array of { agentId, data } objects.
// Uses the existing bulkEnrich method (dataSource: "auto").
// Requires ADMIN_KEY header.

router.post("/admin/bulk-enrich", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const { agents } = req.body;
  if (!Array.isArray(agents) || agents.length === 0) {
    res.status(400).json({ success: false, error: "Forventer { agents: [{ agentId, data }] }" });
    return;
  }

  try {
    const enrichments = agents.map((a: any) => ({
      agentId: a.agentId || a.id,
      data: a.data || a,
    }));

    const count = knowledgeService.bulkEnrich(enrichments);

    // Recalculate trust scores for all enriched agents
    let trustUpdated = 0;
    for (const e of enrichments) {
      try {
        trustScoreService.update(e.agentId);
        trustUpdated++;
      } catch {}
    }

    res.json({
      success: true,
      message: `Beriket ${count} av ${agents.length} agenter`,
      data: { enriched: count, total: agents.length, trustScoresUpdated: trustUpdated },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /admin/google-rating/:id — Fetch Google Places rating ──
// Uses the server-side GOOGLE_PLACES_API_KEY to look up a producer's
// Google rating and review count, then persists it to knowledge.
// This lets enrichment agents (running in sandbox without the key)
// trigger Google rating lookups via our own API.

router.post("/admin/google-rating/:id", async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey || !adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const agentId = req.params.id as string;
  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placesKey) {
    res.status(503).json({ success: false, error: "GOOGLE_PLACES_API_KEY not configured" });
    return;
  }

  // Get agent info for search query
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }

  const { agent, knowledge: k } = info;
  const city = (agent as any).city || "";
  const searchQuery = `${agent.name} ${city} Norway`.replace(/\s*[—–-]\s*/g, " ").trim();

  try {
    // Google Places Text Search (New API)
    const placesResp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": placesKey,
        "X-Goog-FieldMask": "places.rating,places.userRatingCount,places.displayName,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: searchQuery, languageCode: "no" }),
    });

    if (!placesResp.ok) {
      const errText = await placesResp.text();
      res.status(502).json({ success: false, error: `Google Places API error: ${placesResp.status}`, detail: errText.slice(0, 200) });
      return;
    }

    const placesData = await placesResp.json() as any;
    const places = placesData.places || [];

    if (places.length === 0) {
      res.json({ success: true, found: false, message: `Ingen Google Places-treff for "${searchQuery}"` });
      return;
    }

    // Take the first result — verify it's a reasonable match
    const place = places[0];
    const rating = place.rating;
    const reviewCount = place.userRatingCount || 0;
    const placeName = place.displayName?.text || "";
    const placeAddr = place.formattedAddress || "";

    if (!rating) {
      res.json({ success: true, found: true, hasRating: false, placeName, message: "Funnet på Google Maps men ingen rating" });
      return;
    }

    // Persist to knowledge
    knowledgeService.upsertKnowledge(agentId, {
      googleRating: rating,
      googleReviewCount: reviewCount,
      dataSource: "auto",
    } as any);

    // Update trust score
    const newTrust = trustScoreService.update(agentId);

    res.json({
      success: true,
      found: true,
      hasRating: true,
      googleRating: rating,
      googleReviewCount: reviewCount,
      placeName,
      placeAddress: placeAddr,
      newTrustScore: newTrust,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /admin/google-rating-batch — Batch fetch ratings ──
// Accepts { agentIds: string[] }, fetches Google rating for each.
// Max 50 per request to respect API limits.

router.post("/admin/google-rating-batch", async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey || !adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placesKey) {
    res.status(503).json({ success: false, error: "GOOGLE_PLACES_API_KEY not configured" });
    return;
  }

  const { agentIds, include_address_phone } = req.body;
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    res.status(400).json({ success: false, error: "Forventer { agentIds: string[] }" });
    return;
  }

  // PR-82 (2026-05-19): optional Google-Places address+phone enrichment.
  // When include_address_phone=true, we expand the FieldMask to also
  // fetch formattedAddress + internationalPhoneNumber, and write each
  // missing field with source_type:"google_places" field_provenance.
  // This gives the cross-source-validator a 2nd Tier-A source (alongside
  // homepage) on address/phone, recovering agents stuck at source_count=1
  // in `review_required`. Behaviour without the flag is unchanged.
  const wantAddrPhone = include_address_phone === true;
  const fieldMask = wantAddrPhone
    ? "places.rating,places.userRatingCount,places.displayName,places.formattedAddress,places.internationalPhoneNumber"
    : "places.rating,places.userRatingCount,places.displayName";

  const batch = agentIds.slice(0, 50); // Max 50 per request
  const results: any[] = [];
  let enriched = 0;

  for (const agentId of batch) {
    const info = knowledgeService.getAgentInfo(agentId);
    if (!info) { results.push({ agentId, status: "not_found" }); continue; }

    const city = (info.agent as any).city || "";
    const searchQuery = `${info.agent.name} ${city} Norway`.replace(/\s*[—–-]\s*/g, " ").trim();

    try {
      const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": placesKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify({ textQuery: searchQuery, languageCode: "no" }),
      });

      if (!resp.ok) { results.push({ agentId, status: "api_error", code: resp.status }); continue; }

      const data = await resp.json() as any;
      const place = (data.places || [])[0];

      if (!place?.rating) {
        results.push({ agentId, name: info.agent.name, status: "no_rating" });
        continue;
      }

      knowledgeService.upsertKnowledge(agentId, {
        googleRating: place.rating,
        googleReviewCount: place.userRatingCount || 0,
        dataSource: "auto",
      } as any);
      trustScoreService.update(agentId);
      enriched++;

      // ── PR-82: optional address/phone write + provenance merge ──
      let addressWritten = false;
      let phoneWritten = false;
      if (wantAddrPhone) {
        try {
          const gAddrRaw = typeof place.formattedAddress === "string" ? place.formattedAddress.trim() : "";
          const gPhoneRaw = typeof place.internationalPhoneNumber === "string" ? place.internationalPhoneNumber : "";
          // Normalise phone: strip whitespace (and any leading "tel:"), keep the leading "+".
          const gPhone = gPhoneRaw.replace(/^tel:/i, "").replace(/\s+/g, "").trim();

          if (gAddrRaw || gPhone) {
            const db = getDb();
            // Re-read the row AFTER upsertKnowledge so we see any rating-row
            // inserts and the current address/phone column state.
            const row = db
              .prepare("SELECT address, phone, field_provenance FROM agent_knowledge WHERE agent_id = ?")
              .get(agentId) as { address?: string | null; phone?: string | null; field_provenance?: string | null } | undefined;

            const currAddr = (row?.address ?? "").toString().trim();
            const currPhone = (row?.phone ?? "").toString().trim();

            // Decide which columns we're allowed to overwrite (empty only).
            const writeAddr = !currAddr && !!gAddrRaw;
            const writePhone = !currPhone && !!gPhone;

            // Build the incoming provenance payload — include EVERY field we
            // got a value for, regardless of whether the column itself got
            // written. The cross-source-validator counts provenance entries,
            // so an agent that already has a homepage-sourced address still
            // needs the google_places entry merged in to reach source_count=2.
            const incomingProv: Record<string, { sources: Array<{ source_type: string; value: string; fetched_at: string }> }> = {};
            const nowIso = new Date().toISOString();
            if (gAddrRaw) {
              incomingProv.address = {
                sources: [{ source_type: "google_places", value: gAddrRaw, fetched_at: nowIso }],
              };
            }
            if (gPhone) {
              incomingProv.phone = {
                sources: [{ source_type: "google_places", value: gPhone, fetched_at: nowIso }],
              };
            }

            // Parse existing provenance (best-effort; malformed = start from {}).
            let existingProv: Record<string, unknown> = {};
            if (row?.field_provenance) {
              try {
                const parsed = JSON.parse(row.field_provenance);
                if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
              } catch { /* tolerate junk */ }
            }
            const mergedProv = mergeFieldProvenance(existingProv, incomingProv);
            const provJson = JSON.stringify(mergedProv);

            // Single transactional write: column updates + provenance.
            const tx = db.transaction(() => {
              const sets: string[] = [];
              const params: any[] = [];
              if (writeAddr) { sets.push("address = ?"); params.push(gAddrRaw); }
              if (writePhone) { sets.push("phone = ?"); params.push(gPhone); }
              sets.push("field_provenance = ?"); params.push(provJson);
              sets.push("updated_at = ?"); params.push(nowIso);
              params.push(agentId);
              db.prepare(`UPDATE agent_knowledge SET ${sets.join(", ")} WHERE agent_id = ?`).run(...params);
            });
            tx();
            addressWritten = writeAddr;
            phoneWritten = writePhone;
          }
        } catch (provErr: any) {
          // Provenance write failure must not abort the batch — record it on
          // the per-agent result and continue.
          results.push({
            agentId,
            name: info.agent.name,
            status: "enriched_provenance_error",
            googleRating: place.rating,
            googleReviewCount: place.userRatingCount || 0,
            addressWritten: false,
            phoneWritten: false,
            provenanceError: provErr?.message ?? String(provErr),
          });
          // Skip the success-push below.
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
      }

      results.push({
        agentId,
        name: info.agent.name,
        status: "enriched",
        googleRating: place.rating,
        googleReviewCount: place.userRatingCount || 0,
        ...(wantAddrPhone ? { addressWritten, phoneWritten } : {}),
      });

      // Small delay to be nice to Google
      await new Promise(r => setTimeout(r, 200));
    } catch (err: any) {
      results.push({ agentId, status: "error", message: err.message });
    }
  }

  res.json({
    success: true,
    message: `Google-rating hentet for ${enriched} av ${batch.length} agenter`,
    data: { enriched, total: batch.length, results },
  });
});

// ─── DELETE /agents/:id — Remove agent (admin) ─────────────
// Admin endpoint for removing duplicate or invalid agents.
// Requires ADMIN_KEY header for authorization.
// Returns the deleted agent's name for confirmation.

router.delete("/agents/:id", (req: Request, res: Response) => {
  try {
    const adminKey = req.headers["x-admin-key"] as string;
    const expectedKey = getAdminKey();
    const agentId = req.params.id as string;
    if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }

    if (!adminKey || adminKey !== expectedKey) {
      res.status(403).json({ error: "Krever X-Admin-Key header" });
      return;
    }

    const db = getDb();

    const agent = db.prepare("SELECT id, name, city, is_verified FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) {
      res.status(404).json({ error: "Agent ikke funnet", id: agentId });
      return;
    }

    // ── Verified-agent guard (added 2026-04-30) ────────────────
    // Refuse to delete an agent whose owner has verified ownership via
    // claim flow (`is_verified=1`), because DELETE cascades into
    // agent_claims and silently destroys the verification record. This
    // is exactly how "Erga Gardsutsalg" (verified 2026-04-22) was lost
    // when the enrichment-agent's old dedup policy auto-merged it.
    // To force delete (e.g. legitimate opt-out where the owner asked
    // to be removed), pass body { force: true } / query ?force=1, OR
    // first call POST /admin/agents/:id/reset-claim to clear the
    // verification flag explicitly.
    const wantsForce = req.body?.force === true || req.query?.force === "1" || req.query?.force === "true";
    if (agent.is_verified === 1 && !wantsForce) {
      res.status(409).json({
        success: false,
        error: "Agent er verifisert av eier — ikke slett uten ?force=1 eller etter /admin/agents/:id/reset-claim",
        details: {
          agentId: agent.id,
          agentName: agent.name,
          isVerified: true,
          remediation: [
            "If this is an opt-out request: pass ?force=1 (or body { force: true }) — this still preserves blocklist + audit",
            "If this is a duplicate-merge: call POST /admin/agents/:id/reset-claim FIRST, then DELETE",
            "If you reached this from an automated dedup script: stop and flag for human review",
          ],
        },
      });
      return;
    }

    // Delete agent and all related data in one transaction
    // Must clear all FK references before deleting the agent itself.
    // conversations.seller_agent_id lacks ON DELETE CASCADE, so we clean manually.
    const deleteAll = db.transaction(() => {
      db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(agentId);
      db.prepare("DELETE FROM agent_claims WHERE agent_id = ?").run(agentId);
      db.prepare("UPDATE conversations SET seller_agent_id = NULL WHERE seller_agent_id = ?").run(agentId);
      db.prepare("DELETE FROM analytics_agent_views WHERE agent_id = ?").run(agentId);
      db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    });
    deleteAll();

    // ─── Blocklist auto-add (default ON) ─────────────────────
    // Every deleted agent is automatically blocklisted so the daily
    // discovery agent doesn't re-insert them from lokalmat.no/Facebook.
    // To skip blocklisting (e.g. test-data cleanup), pass
    // ?skipBlocklist=1 or body { skipBlocklist: true }.
    let blocklistResult: { inserted: number; rows: any[] } | null = null;
    const skipBlock = req.body?.skipBlocklist === true || req.query?.skipBlocklist === "1" || req.query?.skipBlocklist === "true";
    // Legacy support: still honour explicit addToBlocklist=true/false
    const legacyExplicitOff = (req.body?.addToBlocklist === false || req.query?.addToBlocklist === "0" || req.query?.addToBlocklist === "false");
    const wantsBlock = !skipBlock && !legacyExplicitOff;
    if (wantsBlock) {
      try {
        const fullAgent = db.prepare("SELECT id, name, contact_email, url FROM agents WHERE id = ?").get(agentId) as any;
        // fullAgent is null here (we just deleted) — read from `agent` row pre-delete + try registry for richer data
        const fromRegistry = marketplaceRegistry.getActiveAgents().find((a: any) => a.id === agentId) as any;
        blocklistResult = blocklistAdd({
          agentId,
          name: agent.name,
          website: fromRegistry?.url,
          email: fromRegistry?.contactEmail,
          reason: req.body?.reason || "auto-blocklisted on admin DELETE",
          sourceEmail: req.body?.sourceEmail,
          agentNameForAudit: agent.name,
        });
      } catch (blockErr) {
        console.error("[delete] blocklist auto-add failed (non-critical):", blockErr);
      }
    }

    // Log (non-critical — wrapped so logging failure doesn't crash the response)
    try {
      interactionLogger.log("message", {
        agentId: agentId,
        metadata: { name: agent.name, city: agent.city, reason: req.body?.reason || "cleanup", action: "admin-delete", blocklistInserted: blocklistResult?.inserted ?? 0 },
        ipAddress: req.ip || "unknown",
      });
    } catch (logErr) {
      console.error("[delete] Interaction log failed (non-critical):", logErr);
    }

    res.json({
      success: true,
      message: `Agent "${agent.name}" (${agent.city}) slettet`,
      id: agentId,
      blocklist: blocklistResult,
    });
  } catch (err) {
    console.error("[delete] Agent delete failed:", err);
    res.status(500).json({ error: "Sletting feilet", detail: String(err) });
  }
});

// ─── POST /admin/rotate-keys — Rotate leaked API keys ──────────
// Regenerates `api_key` for agents created on/before a cutoff date.
// Built to clean up after data/lokal.db (March seed batch) was committed
// to a public git repo. The 370 agents in that snapshot have keys exposed;
// this endpoint mints new ones so the leaked values stop authenticating.
//
// Body:
//   { cutoff: "YYYY-MM-DD", dryRun?: boolean }
//   - cutoff:  ISO date. Rotates keys for agents with created_at <= cutoff
//              23:59:59 UTC. Required.
//   - dryRun:  default true. Returns counts only; no DB writes.
//
// Returns: { rotated, sample: [{id, name, oldKeyPrefix}], dryRun }
// We never return the new keys — sellers who claim later get them via the
// claim flow. (This batch has 0 claims, per agent_claims table.)

router.post("/admin/rotate-keys", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const cutoff = req.body?.cutoff as string | undefined;
  const dryRun = req.body?.dryRun !== false; // safe default
  if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
    res.status(400).json({ error: "Body må inneholde 'cutoff: YYYY-MM-DD'" });
    return;
  }
  // Cover the entire cutoff day (UTC). created_at is ISO8601 UTC string.
  const cutoffEnd = `${cutoff}T23:59:59.999Z`;

  const db = getDb();
  const targets = db.prepare(`
    SELECT id, name, api_key, created_at
    FROM agents
    WHERE created_at <= ?
    ORDER BY created_at ASC
  `).all(cutoffEnd) as Array<{ id: string; name: string; api_key: string; created_at: string }>;

  if (dryRun) {
    res.json({
      success: true,
      dryRun: true,
      cutoff: cutoffEnd,
      candidateCount: targets.length,
      sample: targets.slice(0, 5).map(t => ({
        id: t.id,
        name: t.name,
        oldKeyPrefix: (t.api_key || "").slice(0, 12),
        createdAt: t.created_at,
      })),
      hint: "Send {dryRun: false} to actually rotate.",
    });
    return;
  }

  // Real rotation: one transaction so we never end up half-way.
  const update = db.prepare("UPDATE agents SET api_key = ? WHERE id = ?");
  const sample: Array<{ id: string; name: string; oldKeyPrefix: string }> = [];
  let rotated = 0;
  const tx = db.transaction(() => {
    for (const t of targets) {
      const newKey = marketplaceRegistry.newApiKey();
      update.run(newKey, t.id);
      rotated++;
      if (sample.length < 5) {
        sample.push({
          id: t.id,
          name: t.name,
          oldKeyPrefix: (t.api_key || "").slice(0, 12),
        });
      }
    }
  });
  tx();

  // Log so we have an audit trail
  try {
    interactionLogger.log("message", {
      agentId: "admin",
      metadata: { action: "rotate-keys", cutoff: cutoffEnd, rotated },
      ipAddress: req.ip || "unknown",
    });
  } catch (logErr) {
    console.error("[rotate-keys] log failed (non-critical):", logErr);
  }

  res.json({
    success: true,
    dryRun: false,
    cutoff: cutoffEnd,
    rotated,
    sample,
  });
});

// ─── POST /admin/deduplicate — Smart deduplication ──────────
// Finds and removes duplicate agents based on fuzzy name matching.
// Keeps the oldest entry (by created_at) for each group.
// Requires ADMIN_KEY header.

router.post("/admin/deduplicate", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const dryRun = req.body?.dryRun !== false; // Default to dry run for safety

  const { getDb } = require("../database/init");
  const db = getDb();

  // Find duplicates: same city + name starts with same base name
  // Group by normalized name (lowercase, stripped of suffixes like "— Sandefjord")
  const allAgents = db.prepare(`
    SELECT id, name, city, created_at
    FROM agents
    WHERE is_active = 1
    ORDER BY created_at ASC
  `).all() as any[];

  // Normalize: strip "— Suffix", lowercase, trim
  function normalize(name: string): string {
    return name
      .replace(/\s*[—–-]\s*.+$/, "")  // Remove everything after em-dash/en-dash/hyphen
      .replace(/\s*(gårdsbutikk|gårdsysteri|gardsysteri|ysteri|kloster|økologisk|gård|gard)\s*/gi, " ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  const groups = new Map<string, any[]>();
  for (const agent of allAgents) {
    const key = `${normalize(agent.name)}::${(agent.city || "").toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(agent);
  }

  const duplicates: any[] = [];
  for (const [key, agents] of groups) {
    if (agents.length > 1) {
      // Keep first (oldest), mark rest as duplicates
      const [keep, ...remove] = agents;
      for (const dup of remove) {
        duplicates.push({
          id: dup.id,
          name: dup.name,
          city: dup.city,
          keepId: keep.id,
          keepName: keep.name,
          groupKey: key,
        });
      }
    }
  }

  if (!dryRun && duplicates.length > 0) {
    const deleteStmt = db.prepare("DELETE FROM agents WHERE id = ?");
    const deleteMany = db.transaction((ids: string[]) => {
      for (const id of ids) deleteStmt.run(id);
    });
    deleteMany(duplicates.map(d => d.id));
  }

  res.json({
    success: true,
    dryRun,
    duplicatesFound: duplicates.length,
    duplicates: duplicates.map(d => ({
      remove: { id: d.id, name: d.name, city: d.city },
      keep: { id: d.keepId, name: d.keepName },
    })),
    message: dryRun
      ? `Fant ${duplicates.length} duplikater. Kjør med dryRun: false for å slette.`
      : `Slettet ${duplicates.length} duplikater.`,
  });
});

// ═══════════════════════════════════════════════════════════════
// TRUST SCORE — Dynamic reputation engine
// The score drives ranking in discovery results. Higher trust =
// more visible. Incentivizes sellers to claim, fill data, stay active.
// ═══════════════════════════════════════════════════════════════

// ─── GET /agents/:id/trust — Trust score breakdown ──────────
// Shows sellers exactly how their score is calculated and what
// they can do to improve it. This is the incentive dashboard.

router.get("/agents/:id/trust", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const breakdown = trustScoreService.getBreakdown(agentId);
  if (!breakdown) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }
  res.json({ success: true, data: breakdown });
});

// ─── POST /admin/recalculate-trust — Batch recalculate all ──
// Run after deploy or periodically to ensure scores reflect
// current data. Requires ADMIN_KEY header.

router.post("/admin/recalculate-trust", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const result = trustScoreService.recalculateAll();
  res.json({
    success: true,
    message: `Oppdaterte trust score for ${result.updated} agenter`,
    data: result,
  });
});

// ═══════════════════════════════════════════════════════════════
// FIND-OR-CREATE — Prevent duplicate registrations
// Seller enters name + city → we return fuzzy matches from the
// registry so they can claim an existing agent instead of creating
// a duplicate. Also used as a guard on POST /register.
// ═══════════════════════════════════════════════════════════════

// Shared normalize function for fuzzy matching
function normalizeName(name: string): string {
  return name
    .replace(/\s*[—–-]\s*.+$/, "")
    .replace(/\s*(gårdsbutikk|gårdsysteri|gardsysteri|ysteri|kloster|økologisk|gård|gard|bakeri|fiskeri|mathall|matmarked)\s*/gi, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Simple Levenshtein distance for name similarity
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── GET /find-match?name=...&city=... — Find similar agents ──
// Returns agents that fuzzy-match the given name.
// City is optional and only used to boost ranking, never to filter.
// Used by the seller registration page to show "Is this you?"

router.get("/find-match", (req: Request, res: Response) => {
  const name = (req.query.name as string || "").trim();
  const city = (req.query.city as string || "").trim();

  if (!name || name.length < 2) {
    res.json({ success: true, matches: [] });
    return;
  }

  const { getDb } = require("../database/init");
  const db = getDb();

  // Normalize but fall back to raw lowercase if normalization empties the string
  // (e.g. "bakeri" is a suffix word and gets stripped)
  const rawInput = name.toLowerCase().trim();
  const normalized = normalizeName(name);
  const normalizedInput = normalized.length >= 2 ? normalized : rawInput;
  const inputWords = normalizedInput.split(/\s+/).filter(w => w.length >= 2);
  const normalizedCity = city.toLowerCase();

  // Fetch all active agents
  const allAgents = db.prepare(`
    SELECT a.id, a.name, a.city, a.categories, a.trust_score, a.is_verified,
           a.description,
           CASE WHEN ac.status = 'verified' THEN 1 ELSE 0 END as is_claimed
    FROM agents a
    LEFT JOIN agent_claims ac ON ac.agent_id = a.id AND ac.status = 'verified'
    WHERE a.is_active = 1
  `).all() as any[];

  const matches: any[] = [];

  for (const agent of allAgents) {
    const normalizedAgent = normalizeName(agent.name);
    const agentWords = normalizedAgent.split(/\s+/).filter((w: string) => w.length >= 2);

    // Also keep the raw lowercased name for matching common suffix words
    // (e.g. "gård" gets stripped by normalizeName but exists in raw name)
    const rawAgent = (agent.name || "").toLowerCase().trim();
    const rawAgentWords = rawAgent.split(/[\s—–\-,]+/).filter((w: string) => w.length >= 2);

    // ── Score components ──
    // 1. Full Levenshtein similarity (normalized)
    const fullSim = similarityScore(normalizedInput, normalizedAgent);

    // 2. Substring match — check both normalized AND raw agent name.
    //    Primarily "agent name contains the input" (user types partial).
    //    The reverse only counts if agent name is ≥70% of input length.
    const inputInAgent = normalizedInput.length >= 3 && (
      normalizedAgent.includes(normalizedInput) || rawAgent.includes(rawInput)
    );
    const agentInInput = normalizedInput.length >= 3 && normalizedAgent.length >= 3
      && normalizedAgent.length / normalizedInput.length >= 0.7
      && normalizedInput.includes(normalizedAgent);
    const isSubstring = inputInAgent || agentInInput;

    // 3. Word-level matching: check against both normalized AND raw agent words
    //    This catches searches like "gård" which get stripped during normalization
    const allAgentWords = [...new Set([...agentWords, ...rawAgentWords])];
    let wordScore = 0;
    for (const iw of inputWords) {
      for (const aw of allAgentWords) {
        if (aw.includes(iw) || iw.includes(aw)) {
          wordScore = Math.max(wordScore, Math.min(iw.length, aw.length) / Math.max(iw.length, aw.length));
        } else {
          // Also check word-level Levenshtein for typos
          const ws = similarityScore(iw, aw);
          if (ws >= 0.7) wordScore = Math.max(wordScore, ws * 0.8);
        }
      }
    }

    // 4. Starts-with check (min 3 chars, check both normalized and raw)
    const startsWith = normalizedInput.length >= 3 && (
      normalizedAgent.startsWith(normalizedInput) || normalizedInput.startsWith(normalizedAgent)
      || rawAgent.startsWith(rawInput) || rawInput.startsWith(rawAgent)
    );

    // ── Composite score ──
    // Take the best signal, with bonuses for multiple signals
    let score = Math.max(
      fullSim,
      isSubstring ? 0.85 : 0,
      startsWith ? 0.80 : 0,
      wordScore * 0.75,
    );

    // Bonus: if city matches, bump score slightly (but never filter by city)
    if (normalizedCity && (agent.city || "").toLowerCase().includes(normalizedCity)) {
      score = Math.min(1, score + 0.05);
    }

    // ── Lenient threshold: 0.35 lets partial matches through ──
    if (score >= 0.35) {
      matches.push({
        id: agent.id,
        name: agent.name,
        city: agent.city,
        description: (agent.description || "").substring(0, 120),
        categories: JSON.parse(agent.categories || "[]"),
        trustScore: agent.trust_score,
        isVerified: !!agent.is_verified,
        isClaimed: !!agent.is_claimed,
        similarity: Math.round(score * 100),
      });
    }
  }

  // Sort by similarity descending, limit to 15
  matches.sort((a, b) => b.similarity - a.similarity);

  res.json({
    success: true,
    query: { name, city },
    count: Math.min(matches.length, 15),
    matches: matches.slice(0, 15),
  });
});

// ─── POST /register (updated with dedup guard) ────────────────
// Before creating a new agent, check for fuzzy duplicates.
// If a close match exists, return a warning with matches.
// Caller can force-create by setting { force: true }.

// (The original POST /register handler above is kept unchanged —
//  the dedup guard is applied in the selger.html frontend by
//  calling /find-match first. Backend guard is a safety net.)

// ─── Helper ──────────────────────────────────────────────────

// ─── GET /admin/claims — Campaign tracking overview ───────────
// Shows all claims grouped by source, so you can track which
// outreach campaigns are converting.

router.get("/admin/claims", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = (req.headers["x-admin-key"] as string) || (req.query.key as string);
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever admin-nøkkel" });
    return;
  }

  const db = getDb();

  // All claims with source info
  const claims = db.prepare(`
    SELECT ac.id, ac.agent_id, ac.claimant_name, ac.claimant_email, ac.status,
           ac.source, ac.created_at, ac.verified_at, a.name as agent_name
    FROM agent_claims ac
    LEFT JOIN agents a ON a.id = ac.agent_id
    ORDER BY ac.created_at DESC
  `).all();

  // Summary by source
  const byCampaign = db.prepare(`
    SELECT source, status, COUNT(*) as count
    FROM agent_claims
    GROUP BY source, status
    ORDER BY source, status
  `).all();

  res.json({
    success: true,
    data: {
      claims,
      byCampaign,
      total: claims.length,
      verified: (claims as any[]).filter((c: any) => c.status === 'verified').length,
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// INBOUND EMAIL WEBHOOK
// Resend sends a POST here when someone emails *@rettfrabonden.com
// We forward it to the admin's Gmail so nothing gets lost.
// ═══════════════════════════════════════════════════════════════

router.post("/webhooks/inbound-email", async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Log full payload to debug Resend's format
    console.log(`[Inbound] Raw payload: ${JSON.stringify(payload).substring(0, 2000)}`);

    // Resend wraps inbound data in { type, created_at, data: { ... } }
    const data = payload.data || payload; // fallback for direct test calls
    const from = data.from || payload.from || "unknown";
    const to = data.to || payload.to || [];
    const subject = data.subject || payload.subject || "(ingen emne)";
    const emailId = data.email_id || payload.email_id;

    console.log(`[Inbound] Event: ${payload.type || "unknown"}, email_id: ${emailId}, from: ${from}, subject: "${subject}"`);

    // Resend inbound webhooks don't include body — fetch it via API
    let html = "";
    let text = "";
    const resendKey = process.env.RESEND_API_KEY;

    if (emailId && resendKey) {
      try {
        const emailRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${resendKey}` },
        });
        if (emailRes.ok) {
          const emailData = await emailRes.json() as { html?: string; text?: string };
          html = emailData.html || "";
          text = emailData.text || "";
          console.log(`[Inbound] Fetched body for ${emailId} (${html.length} chars HTML, ${text.length} chars text)`);
        } else {
          console.warn(`[Inbound] Could not fetch email body: ${emailRes.status} ${emailRes.statusText}`);
        }
      } catch (fetchErr) {
        console.warn(`[Inbound] Error fetching email body:`, fetchErr);
      }
    } else if (!resendKey) {
      console.warn(`[Inbound] RESEND_API_KEY not set — cannot fetch email body`);
    }

    // Extract sender email for reply-to (format: "Name <email@domain.com>")
    const senderEmail = typeof from === "string"
      ? (from.match(/<([^>]+)>/)?.[1] || from)
      : undefined;

    // Forward to admin Gmail
    const forwardTo = process.env.ADMIN_EMAIL || "da.fredriksen@gmail.com";
    const bodyHtml = html || (text ? `<pre>${text}</pre>` : `<p><em>Ingen innhold i eposten.</em></p>`);
    const bodyText = text || "(ingen tekstinnhold)";

    const forwarded = await emailService.sendEmail({
      to: forwardTo,
      subject: `[Innkommende] ${subject} (fra ${from})`,
      htmlContent: `
        <div style="border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:16px;color:#666;font-size:13px;">
          <strong>Fra:</strong> ${from}<br>
          <strong>Til:</strong> ${Array.isArray(to) ? to.join(", ") : to}<br>
          <strong>Emne:</strong> ${subject}
        </div>
        ${bodyHtml}
      `,
      textContent: `Videresent fra: ${from}\nTil: ${Array.isArray(to) ? to.join(", ") : to}\nEmne: ${subject}\n\n${bodyText}`,
      replyTo: senderEmail,
    });

    if (forwarded) {
      console.log(`[Inbound] Forwarded to ${forwardTo}`);
    } else {
      console.warn(`[Inbound] Forward failed — email service not configured or send failed`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Inbound] Webhook error:", err);
    res.status(200).json({ received: true }); // Always 200 so Resend doesn't retry
  }
});

function getBaseUrl(req: Request): string {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}


// ─── Admin blocklist endpoints ────────────────────────────────
// "Do not re-add" list. The daily discovery agent and the public
// /register endpoint both call isBlocked() before insert, so the
// only way to make a producer permanently un-discoverable is via
// these endpoints.
//
// All require X-Admin-Key.
//
//   GET  /api/marketplace/admin/blocklist?limit=100&offset=0
//        → list rows (most-recent first)
//   POST /api/marketplace/admin/blocklist
//        body: { name?, website?, email?, agentId?, reason, sourceEmail? }
//        → inserts up to 4 rows (one per non-empty identifier)
//   DELETE /api/marketplace/admin/blocklist/:id
//        → undoes a single row by primary key
//
// Typical use after a "fjern" reply:
//   1) DELETE /api/marketplace/agents/<uuid>
//      with body { reason: "opt-out via outreach reply", sourceEmail: "post@x.no" }
//      (blocklist is now automatic — pass ?skipBlocklist=1 to suppress)
//   2) (optional) POST /admin/blocklist for richer signals if you
//      have data the registry didn't have.

router.get("/admin/blocklist", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  try {
    const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
    const offset = parseInt(String(req.query.offset || "0"), 10) || 0;
    const rows = blocklistList({ limit, offset });
    res.json({ success: true, count: rows.length, rows });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

router.post("/admin/blocklist", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  try {
    const { name, website, email, agentId, reason, sourceEmail } = req.body || {};
    if (!reason || typeof reason !== "string") {
      res.status(400).json({ error: "Body må inneholde 'reason' (string)" });
      return;
    }
    if (!name && !website && !email && !agentId) {
      res.status(400).json({ error: "Minst én av name/website/email/agentId må oppgis" });
      return;
    }
    const result = blocklistAdd({ name, website, email, agentId, reason, sourceEmail });
    res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: "Add failed", detail: err.message });
  }
});

router.delete("/admin/blocklist/:id", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  try {
    const id = parseInt(req.params.id as string, 10);
    if (!id) { res.status(400).json({ error: "Ugyldig id" }); return; }
    const removed = blocklistRemove({ id });
    res.json({ success: true, removed });
  } catch (err: any) {
    res.status(500).json({ error: "Remove failed", detail: err.message });
  }
});

// ─── POST /admin/knowledge/:agentId/provenance/cleanup ───────────────
// Remove provenance entries from a single agent's field_provenance JSON
// matching {field, source_type, value_regex?}. Returns the count and
// remaining sources for that field.
//
// Body shape:
//   { field: "phone" | "address" | "business_status",
//     source_type: string,
//     value_regex?: string }
//
// Built to clean up the 2026-05 garbage homepage-phone entries (Cookiebot
// script IDs etc.) that the homepage-regex crawler wrote alongside the
// real google_places phone, which were causing cross-source-validator to
// flag the row as `review_required: source_disagreement`.
//
// Auth: X-Admin-Key (same idiom as the rest of marketplace.ts).
// Returns: 200 { success, agent_id, field, removed_count, remaining_sources }
// Errors: 400 (bad body), 403 (no key), 404 (agent not in agent_knowledge),
//         503 (no admin key configured).

router.post("/admin/knowledge/:agentId/provenance/cleanup", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const agentId = String(req.params.agentId || "").trim();
  if (!agentId) {
    res.status(400).json({ error: "agentId required in path" });
    return;
  }

  const body = (req.body ?? {}) as {
    field?: string;
    source_type?: string;
    value_regex?: string;
  };
  const field = typeof body.field === "string" ? body.field.trim() : "";
  const sourceType = typeof body.source_type === "string" ? body.source_type.trim() : "";
  const valueRegexRaw = typeof body.value_regex === "string" ? body.value_regex : undefined;

  const ALLOWED_FIELDS = new Set(["phone", "address", "business_status"]);
  if (!ALLOWED_FIELDS.has(field)) {
    res.status(400).json({ error: "field must be one of phone|address|business_status" });
    return;
  }
  if (!sourceType) {
    res.status(400).json({ error: "source_type required" });
    return;
  }

  let valueRegex: RegExp | null = null;
  if (valueRegexRaw !== undefined) {
    try {
      valueRegex = new RegExp(valueRegexRaw);
    } catch (err: any) {
      res.status(400).json({ error: "value_regex is not a valid RegExp", detail: err?.message });
      return;
    }
  }

  try {
    const db = getDb();
    const row = db
      .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { field_provenance?: string | null } | undefined;
    if (!row) {
      res.status(404).json({ error: "agent not found in agent_knowledge" });
      return;
    }

    let provenance: Record<string, unknown> = {};
    if (row.field_provenance) {
      try {
        const parsed = JSON.parse(row.field_provenance);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          provenance = parsed as Record<string, unknown>;
        }
      } catch { /* malformed → start from {} */ }
    }

    const entry = provenance[field];
    // Mirror cross-source-validator's tolerance for legacy single-object
    // shape and the wrapped `{sources:[...]}` shape (some routes emit it).
    let records: any[] = [];
    let wasWrapped = false;
    if (Array.isArray(entry)) {
      records = entry;
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (Array.isArray(e.sources)) {
        records = e.sources as any[];
        wasWrapped = true;
      } else {
        // Legacy single record → wrap so the filter operates on the same shape.
        records = [e];
      }
    }

    const kept: any[] = [];
    let removedCount = 0;
    for (const r of records) {
      if (!r || typeof r !== "object") { kept.push(r); continue; }
      const stMatch = typeof r.source_type === "string" && r.source_type === sourceType;
      if (!stMatch) { kept.push(r); continue; }
      if (valueRegex) {
        const v = typeof r.value === "string" ? r.value : "";
        if (!valueRegex.test(v)) { kept.push(r); continue; }
      }
      removedCount++;
    }

    if (removedCount > 0) {
      if (wasWrapped) {
        provenance[field] = { ...((entry as object) ?? {}), sources: kept };
      } else {
        provenance[field] = kept;
      }
      const nowIso = new Date().toISOString();
      db.prepare(
        "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?"
      ).run(JSON.stringify(provenance), nowIso, agentId);
    }

    const remainingSources = kept
      .filter((r) => r && typeof r === "object" && typeof r.source_type === "string")
      .map((r) => r.source_type as string);

    res.json({
      success: true,
      agent_id: agentId,
      field,
      removed_count: removedCount,
      remaining_sources: remainingSources,
    });
  } catch (err: any) {
    res.status(500).json({ error: "cleanup failed", detail: err?.message ?? String(err) });
  }
});

// ─── POST /admin/knowledge/provenance/cleanup ────────────────────────
// Bulk variant of the above — applies the cleanup across ALL agent_knowledge
// rows. Supports `dry_run: true` for a read-only count.
//
// Required to clean up the 7-8 garbage Cookiebot-script-ID phone entries
// from the morning of 2026-05-21 in one shot.
//
// Body shape:
//   { field, source_type, value_regex?, dry_run? }
// Returns: { success, agents_touched, total_removed_count, dry_run? }

router.post("/admin/knowledge/provenance/cleanup", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const body = (req.body ?? {}) as {
    field?: string;
    source_type?: string;
    value_regex?: string;
    dry_run?: boolean;
  };
  const field = typeof body.field === "string" ? body.field.trim() : "";
  const sourceType = typeof body.source_type === "string" ? body.source_type.trim() : "";
  const valueRegexRaw = typeof body.value_regex === "string" ? body.value_regex : undefined;
  const dryRun = body.dry_run === true;

  const ALLOWED_FIELDS = new Set(["phone", "address", "business_status"]);
  if (!ALLOWED_FIELDS.has(field)) {
    res.status(400).json({ error: "field must be one of phone|address|business_status" });
    return;
  }
  if (!sourceType) {
    res.status(400).json({ error: "source_type required" });
    return;
  }

  let valueRegex: RegExp | null = null;
  if (valueRegexRaw !== undefined) {
    try {
      valueRegex = new RegExp(valueRegexRaw);
    } catch (err: any) {
      res.status(400).json({ error: "value_regex is not a valid RegExp", detail: err?.message });
      return;
    }
  }

  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT agent_id, field_provenance FROM agent_knowledge WHERE field_provenance IS NOT NULL AND field_provenance != '' AND field_provenance != '{}'")
      .all() as { agent_id: string; field_provenance: string | null }[];

    let agentsTouched = 0;
    let totalRemoved = 0;
    const nowIso = new Date().toISOString();
    const updateStmt = db.prepare(
      "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?"
    );

    // Wrap writes in a single transaction (no-op when dry_run).
    const tx = db.transaction((pending: { agentId: string; json: string }[]) => {
      for (const p of pending) updateStmt.run(p.json, nowIso, p.agentId);
    });

    const pendingWrites: { agentId: string; json: string }[] = [];

    for (const row of rows) {
      let provenance: Record<string, unknown> = {};
      if (row.field_provenance) {
        try {
          const parsed = JSON.parse(row.field_provenance);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            provenance = parsed as Record<string, unknown>;
          } else {
            continue;
          }
        } catch {
          continue;
        }
      }

      const entry = provenance[field];
      let records: any[] = [];
      let wasWrapped = false;
      if (Array.isArray(entry)) {
        records = entry;
      } else if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.sources)) {
          records = e.sources as any[];
          wasWrapped = true;
        } else {
          records = [e];
        }
      } else {
        continue;
      }

      const kept: any[] = [];
      let removedHere = 0;
      for (const r of records) {
        if (!r || typeof r !== "object") { kept.push(r); continue; }
        const stMatch = typeof r.source_type === "string" && r.source_type === sourceType;
        if (!stMatch) { kept.push(r); continue; }
        if (valueRegex) {
          const v = typeof r.value === "string" ? r.value : "";
          if (!valueRegex.test(v)) { kept.push(r); continue; }
        }
        removedHere++;
      }

      if (removedHere > 0) {
        agentsTouched++;
        totalRemoved += removedHere;
        if (wasWrapped) {
          provenance[field] = { ...((entry as object) ?? {}), sources: kept };
        } else {
          provenance[field] = kept;
        }
        if (!dryRun) {
          pendingWrites.push({ agentId: row.agent_id, json: JSON.stringify(provenance) });
        }
      }
    }

    if (!dryRun && pendingWrites.length > 0) {
      tx(pendingWrites);
    }

    res.json({
      success: true,
      agents_touched: agentsTouched,
      total_removed_count: totalRemoved,
      ...(dryRun ? { dry_run: true } : {}),
    });
  } catch (err: any) {
    res.status(500).json({ error: "bulk cleanup failed", detail: err?.message ?? String(err) });
  }
});

// ─── GET /admin/knowledge/:agentId/field-provenance ──────────────────
// Returns the parsed field_provenance JSON for an agent plus a
// sources_summary slice that mirrors cross-source-validator's
// `sources_used` for each known field. Built so the supervisor can
// externally verify that PR-82's google_places provenance merge
// actually landed (the public knowledge endpoint doesn't expose this).
//
// Auth: X-Admin-Key.
// Returns: 200 { success, agent_id, field_provenance, sources_summary }
// Errors: 403 / 404 / 503 — same idiom as the cleanup endpoints.

router.get("/admin/knowledge/:agentId/field-provenance", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const agentId = String(req.params.agentId || "").trim();
  if (!agentId) {
    res.status(400).json({ error: "agentId required in path" });
    return;
  }

  try {
    const db = getDb();
    const row = db
      .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { field_provenance?: string | null } | undefined;
    if (!row) {
      res.status(404).json({ error: "agent not found in agent_knowledge" });
      return;
    }

    let fieldProvenance: Record<string, unknown> = {};
    if (row.field_provenance) {
      try {
        const parsed = JSON.parse(row.field_provenance);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          fieldProvenance = parsed as Record<string, unknown>;
        }
      } catch { /* malformed → empty */ }
    }

    const FIELDS: FieldName[] = ["address", "phone", "business_status"];
    const sourcesSummary: Record<string, string[]> = {};
    for (const f of FIELDS) {
      // crossSourceAgreement already handles legacy/array/missing shapes.
      const result = crossSourceAgreement(fieldProvenance as any, f);
      sourcesSummary[f] = result.sources_used;
    }

    res.json({
      success: true,
      agent_id: agentId,
      field_provenance: fieldProvenance,
      sources_summary: sourcesSummary,
    });
  } catch (err: any) {
    res.status(500).json({ error: "field-provenance read failed", detail: err?.message ?? String(err) });
  }
});

// ─── GET /admin/agents/dump ─────────────────────────────────
// Returns all active agents with contact info for outreach tooling.
// Fields: id, name, city, email, website, contacted_at (derived from
// crm_messages.sent_at, NULL if no outbound CRM message), is_claimed.
// Protected by x-admin-key. Recommended by e15 marketing run 2026-04-30.
//
// HISTORY: Original commit a6e583a3 referenced a.contacted_at as if it
// were a column on agents; that column does not exist and the endpoint
// returned 500.  This rewrite derives contacted_at from CRM and makes
// the ?uncontacted filter actually work.
router.get("/admin/agents/dump", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  try {
    const db = getDb();
    const hasEmail = req.query.hasEmail === "true";
    const uncontacted = req.query.uncontacted === "true";

    // contacted_at = MAX(crm_messages.sent_at) for any outbound msg
    // sent to a crm_contact whose email matches a.contact_email.
    // crm_messages → crm_threads.contact_id → crm_contacts.id (no
    // contact_id on messages directly).  direction enum is 'in'/'out'.
    let sql = `
      SELECT a.id, a.name, a.city, a.contact_email as email, a.url as website,
             (
               SELECT MAX(m.sent_at)
               FROM crm_messages m
               JOIN crm_threads t ON t.id = m.thread_id
               JOIN crm_contacts c ON c.id = t.contact_id
               WHERE m.direction = 'out'
                 AND LOWER(c.email) = LOWER(a.contact_email)
             ) as contacted_at,
             CASE WHEN ac.id IS NOT NULL THEN 1 ELSE 0 END as is_claimed
      FROM agents a
      LEFT JOIN agent_claims ac ON ac.agent_id = a.id AND ac.status = 'verified'
      WHERE a.is_active = 1
    `;
    if (hasEmail) sql += " AND a.contact_email IS NOT NULL AND a.contact_email != ''";
    sql += " ORDER BY a.city, a.name";

    let rows = db.prepare(sql).all() as any[];
    if (uncontacted) {
      rows = rows.filter((r) => r.contacted_at == null);
    }
    res.json({ success: true, count: rows.length, agents: rows });
  } catch (err: any) {
    res.status(500).json({ error: "Dump failed", detail: err.message });
  }
});

// ─── Phase 5.11 A2.5: Public umbrella + affiliations discovery API ───
// Read-only endpoints (no admin-key required) that surface the Phase 5.11
// data model to A2A clients, AI search agents (Perplexity/ChatGPT/Claude),
// and our own MCP server. They mirror what crawlers can extract from the
// HTML profile pages (memberOf/member JSON-LD) but in machine-friendly form.
//
// Endpoints:
//   GET /umbrellas                 — list umbrella agents (filterable by type)
//   GET /umbrellas/:id/members     — list producers in an umbrella's network
//   GET /producers/:id/affiliations — list umbrellas a producer belongs to

router.get("/umbrellas", (req: Request, res: Response) => {
  try {
    const umbrellaType = typeof req.query.umbrella_type === "string" ? req.query.umbrella_type : null;
    const limit = Math.min(parseInt((req.query.limit as string) || "100", 10) || 100, 500);

    const db = getDb();
    const wheres: string[] = ["umbrella_type IS NOT NULL", "is_active = 1"];
    // PR-94: exclude unreviewed bm_venue placeholders from public umbrella
    // listings. Confirmed bm_venues already have is_active=1 set during
    // confirm, but the additional review-status filter is defensive.
    wheres.push("(umbrella_type != \'bm_venue\' OR agent_review_status = \'confirmed\')");
    const params: any[] = [];
    if (umbrellaType) { wheres.push("umbrella_type = ?"); params.push(umbrellaType); }
    params.push(limit);

    const rows = db.prepare(`
      SELECT
        id, name, description, umbrella_type, parent_umbrella_id,
        umbrella_member_count, city,
        trust_score, is_verified
      FROM agents
      WHERE ${wheres.join(" AND ")}
      ORDER BY trust_score DESC, name ASC
      LIMIT ?
    `).all(...params) as any[];

    const umbrellas = rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      umbrella_type: r.umbrella_type,
      parent_umbrella_id: r.parent_umbrella_id,
      member_count: r.umbrella_member_count || 0,
      city: r.city,
      slug: slugify(r.name),
      profile_url: `${getBaseUrl(req)}/produsent/${slugify(r.name)}`,
      card_url: `${getBaseUrl(req)}/api/marketplace/agents/${r.id}/card`,
      trust_score: r.trust_score,
      is_verified: r.is_verified === 1,
    }));

    res.json({ success: true, count: umbrellas.length, umbrellas });
  } catch (err: any) {
    console.error("[/umbrellas] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});

router.get("/umbrellas/:id/members", (req: Request, res: Response) => {
  const umbrellaId = req.params.id as string;
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || "100", 10) || 100, 500);
    const status = typeof req.query.status === "string" ? req.query.status : "active";

    const db = getDb();
    const umbrella = db.prepare(
      "SELECT id, name, umbrella_type FROM agents WHERE id = ? AND umbrella_type IS NOT NULL AND is_active = 1"
    ).get(umbrellaId) as any;
    if (!umbrella) {
      res.status(404).json({ success: false, error: "Umbrella ikke funnet" });
      return;
    }

    if (!["pending_confirmation", "active", "historical", "rejected", "all"].includes(status)) {
      res.status(400).json({ success: false, error: "Invalid status filter" });
      return;
    }

    const wheres: string[] = ["aff.umbrella_id = ?", "p.is_active = 1"];
    const params: any[] = [umbrellaId];
    if (status !== "all") { wheres.push("aff.status = ?"); params.push(status); }
    params.push(limit);

    const rows = db.prepare(`
      SELECT
        p.id, p.name, p.city, p.trust_score, p.is_verified,
        aff.id AS affiliation_id, aff.status, aff.labels, aff.joined_at
      FROM agent_affiliations aff
      INNER JOIN agents p ON p.id = aff.producer_id
      WHERE ${wheres.join(" AND ")}
      ORDER BY p.trust_score DESC, p.name ASC
      LIMIT ?
    `).all(...params) as any[];

    const members = rows.map(r => ({
      id: r.id,
      name: r.name,
      city: r.city,
      slug: slugify(r.name),
      profile_url: `${getBaseUrl(req)}/produsent/${slugify(r.name)}`,
      card_url: `${getBaseUrl(req)}/api/marketplace/agents/${r.id}/card`,
      trust_score: r.trust_score,
      is_verified: r.is_verified === 1,
      affiliation: {
        id: r.affiliation_id,
        status: r.status,
        labels: r.labels ? (() => { try { return JSON.parse(r.labels); } catch { return []; } })() : [],
        joined_at: r.joined_at,
      },
    }));

    res.json({
      success: true,
      count: members.length,
      umbrella: { id: umbrella.id, name: umbrella.name, umbrella_type: umbrella.umbrella_type },
      members,
    });
  } catch (err: any) {
    console.error("[/umbrellas/:id/members] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});

router.get("/producers/:id/affiliations", (req: Request, res: Response) => {
  const producerId = req.params.id as string;
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "active";
    const db = getDb();

    const producer = db.prepare(
      "SELECT id, name, umbrella_type FROM agents WHERE id = ? AND is_active = 1"
    ).get(producerId) as any;
    if (!producer) {
      res.status(404).json({ success: false, error: "Produsent ikke funnet" });
      return;
    }
    if (producer.umbrella_type) {
      res.status(400).json({
        success: false,
        error: "Agent er en paraply, ikke en produsent. Bruk /umbrellas/:id/members.",
      });
      return;
    }

    if (!["pending_confirmation", "active", "historical", "rejected", "all"].includes(status)) {
      res.status(400).json({ success: false, error: "Invalid status filter" });
      return;
    }

    const wheres: string[] = ["aff.producer_id = ?", "u.is_active = 1"];
    const params: any[] = [producerId];
    if (status !== "all") { wheres.push("aff.status = ?"); params.push(status); }

    const rows = db.prepare(`
      SELECT
        u.id, u.name, u.umbrella_type, u.parent_umbrella_id,
        aff.id AS affiliation_id, aff.status, aff.labels, aff.joined_at
      FROM agent_affiliations aff
      INNER JOIN agents u ON u.id = aff.umbrella_id
      WHERE ${wheres.join(" AND ")}
      ORDER BY u.name ASC
    `).all(...params) as any[];

    const affiliations = rows.map(r => ({
      umbrella: {
        id: r.id,
        name: r.name,
        umbrella_type: r.umbrella_type,
        parent_umbrella_id: r.parent_umbrella_id,
        slug: slugify(r.name),
        profile_url: `${getBaseUrl(req)}/produsent/${slugify(r.name)}`,
      },
      affiliation: {
        id: r.affiliation_id,
        status: r.status,
        labels: r.labels ? (() => { try { return JSON.parse(r.labels); } catch { return []; } })() : [],
        joined_at: r.joined_at,
      },
    }));

    res.json({
      success: true,
      count: affiliations.length,
      producer: { id: producer.id, name: producer.name },
      affiliations,
    });
  } catch (err: any) {
    console.error("[/producers/:id/affiliations] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});


// ─── Phase 5.11 A3: Umbrella agents + affiliations admin endpoints ──
// All endpoints below are gated by X-Admin-Key. They power the Phase 5.11
// data model introduced in A1 (umbrella_type, agent_affiliations) and
// rendered conditionally in A2 (producer "Tilknytninger" card, umbrella
// stub template, JSON-LD memberOf/member/subOrganization).
//
// Endpoints:
//   POST   /admin/umbrellas                  — create a new umbrella agent
//   PATCH  /admin/agents/:id/umbrella-meta   — edit umbrella-specific fields
//   GET    /admin/affiliations               — list affiliations (filterable)
//   POST   /admin/affiliations               — create/upsert producer↔umbrella link
//   PATCH  /admin/affiliations/:id           — update status/labels/notes
//
// All state changes log to interactionLogger so audit trail is preserved.

// ─── helper: list of valid umbrella_type values ─────────────────────
const UMBRELLA_TYPES = new Set([
  "market_network",   // Bondens marked, REKO
  "venue",            // Mathallen Oslo
  "industry_org",     // Hanen
  "certification",    // Debio
  "cooperative",      // Norsk Gardsmat
]);

// ─── POST /admin/umbrellas — create a new umbrella agent ────────────
router.post("/admin/umbrellas", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const umbrellaType = typeof body.umbrella_type === "string" ? body.umbrella_type.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const contactEmail = typeof body.contact_email === "string" ? body.contact_email.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const city = typeof body.city === "string" ? body.city.trim() : null;
    const parentUmbrellaId = typeof body.parent_umbrella_id === "string" ? body.parent_umbrella_id.trim() : null;

    if (!name || name.length < 1 || name.length > 200) {
      res.status(400).json({ success: false, error: "name required (1-200 chars)" });
      return;
    }
    if (!UMBRELLA_TYPES.has(umbrellaType)) {
      res.status(400).json({ success: false, error: `umbrella_type must be one of: ${Array.from(UMBRELLA_TYPES).join(", ")}` });
      return;
    }

    const db = getDb();

    // Verify parent_umbrella_id exists + IS an umbrella (no circular nesting allowed)
    if (parentUmbrellaId) {
      const parent = db.prepare("SELECT umbrella_type FROM agents WHERE id = ?").get(parentUmbrellaId) as any;
      if (!parent) {
        res.status(400).json({ success: false, error: `parent_umbrella_id ${parentUmbrellaId} not found` });
        return;
      }
      if (!parent.umbrella_type) {
        res.status(400).json({ success: false, error: `parent_umbrella_id ${parentUmbrellaId} is not an umbrella agent` });
        return;
      }
    }

    // Reject duplicate name within the same umbrella_type (case-insensitive)
    const existing = db.prepare(
      "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type IS NOT NULL"
    ).get(name) as any;
    if (existing) {
      res.status(409).json({ success: false, error: "Umbrella with this name already exists", existing_id: existing.id });
      return;
    }

    // Generate id + api-key (umbrellas don't expose an external API but the
    // agents table still requires a key — same column constraints as producer agents)
    const id = require("crypto").randomUUID();
    const apiKey = `umb_${require("crypto").randomBytes(24).toString("hex")}`;

    const stmt = db.prepare(`
      INSERT INTO agents (
        id, name, description, provider, contact_email, url,
        role, api_key,
        city, is_active, is_verified, trust_score,
        umbrella_type, parent_umbrella_id, umbrella_member_count
      ) VALUES (
        ?, ?, ?, 'umbrella-admin', ?, ?,
        'producer', ?,
        ?, 1, 1, 0.9,
        ?, ?, 0
      )
    `);
    stmt.run(
      id, name, description, contactEmail, url,
      apiKey,
      city,
      umbrellaType, parentUmbrellaId
    );

    interactionLogger.log("umbrella_created", {
      agentId: id,
      metadata: { name, umbrella_type: umbrellaType, parent_umbrella_id: parentUmbrellaId, source: "admin" },
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: "Umbrella agent created",
      data: {
        id,
        name,
        umbrella_type: umbrellaType,
        parent_umbrella_id: parentUmbrellaId,
        slug: slugify(name),
        profile_url: `${getBaseUrl(req)}/produsent/${slugify(name)}`,
        api_key: apiKey,
      },
    });
  } catch (err: any) {
    console.error("[admin/umbrellas] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});

// ─── PATCH /admin/agents/:id/umbrella-meta — edit umbrella fields ───
// Allows editing umbrella-specific columns without going through the
// producer-oriented /admin/agents/:id endpoint. Only operates on rows
// where umbrella_type IS NOT NULL (refuses to silently convert a producer
// into an umbrella via this endpoint — use POST /admin/umbrellas for that).
router.patch("/admin/agents/:id/umbrella-meta", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  const agentId = req.params.id as string;
  const body = req.body || {};

  // Allow-list — refuses any unexpected field
  const ALLOWED = new Set([
    "umbrella_type", "parent_umbrella_id", "umbrella_member_count",
    "umbrella_scrape_config", "umbrella_venues",
    "name", "description",
  ]);
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) {
      res.status(400).json({ success: false, error: `Felt ikke tillatt: ${key}` });
      return;
    }
  }
  if (Object.keys(body).length === 0) {
    res.status(400).json({ success: false, error: "Trenger minst ett av: " + Array.from(ALLOWED).join(", ") });
    return;
  }

  try {
    const db = getDb();
    const existing = db.prepare("SELECT id, name, umbrella_type FROM agents WHERE id = ?").get(agentId) as any;
    if (!existing) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }
    if (!existing.umbrella_type) {
      res.status(409).json({
        success: false,
        error: "Agent is not an umbrella — use POST /admin/umbrellas to create umbrellas, or PATCH /agents/:id for producer fields",
      });
      return;
    }

    // Validate updated umbrella_type if provided
    if (typeof body.umbrella_type === "string" && !UMBRELLA_TYPES.has(body.umbrella_type)) {
      res.status(400).json({ success: false, error: `umbrella_type must be one of: ${Array.from(UMBRELLA_TYPES).join(", ")}` });
      return;
    }

    // Validate JSON fields parse correctly
    for (const jsonField of ["umbrella_scrape_config", "umbrella_venues"]) {
      if (body[jsonField] !== undefined && body[jsonField] !== null) {
        if (typeof body[jsonField] === "object") {
          body[jsonField] = JSON.stringify(body[jsonField]);
        } else if (typeof body[jsonField] === "string") {
          try { JSON.parse(body[jsonField]); }
          catch { res.status(400).json({ success: false, error: `${jsonField} must be valid JSON` }); return; }
        }
      }
    }

    // Length bounds for text fields
    if (typeof body.name === "string" && (body.name.length < 1 || body.name.length > 200)) {
      res.status(400).json({ success: false, error: "name length 1-200" });
      return;
    }
    if (typeof body.description === "string" && body.description.length > 2000) {
      res.status(400).json({ success: false, error: "description length 0-2000" });
      return;
    }

    // Build SET clause from validated fields
    const setParts: string[] = [];
    const setValues: any[] = [];
    for (const key of Object.keys(body)) {
      setParts.push(`${key} = ?`);
      setValues.push(body[key]);
    }
    setValues.push(agentId);

    db.prepare(`UPDATE agents SET ${setParts.join(", ")} WHERE id = ?`).run(...setValues);

    interactionLogger.log("umbrella_updated", {
      agentId,
      metadata: { fields_updated: Object.keys(body), source: "admin" },
      ipAddress: req.ip,
    });

    const updated = db.prepare("SELECT id, name, umbrella_type, parent_umbrella_id, umbrella_member_count FROM agents WHERE id = ?").get(agentId) as any;
    res.json({ success: true, message: "Umbrella meta updated", data: updated });
  } catch (err: any) {
    console.error("[admin/agents/:id/umbrella-meta] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});

// ─── GET /admin/affiliations — list affiliations (filterable) ───────
router.get("/admin/affiliations", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  try {
    const producerId = typeof req.query.producer_id === "string" ? req.query.producer_id : null;
    const umbrellaId = typeof req.query.umbrella_id === "string" ? req.query.umbrella_id : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const limit = Math.min(parseInt((req.query.limit as string) || "200", 10) || 200, 1000);

    const db = getDb();
    const wheres: string[] = ["1 = 1"];
    const params: any[] = [];
    if (producerId) { wheres.push("aff.producer_id = ?"); params.push(producerId); }
    if (umbrellaId) { wheres.push("aff.umbrella_id = ?"); params.push(umbrellaId); }
    if (status) {
      if (!["pending_confirmation", "active", "historical", "rejected"].includes(status)) {
        res.status(400).json({ success: false, error: "Invalid status filter" });
        return;
      }
      wheres.push("aff.status = ?"); params.push(status);
    }
    params.push(limit);

    const rows = db.prepare(`
      SELECT
        aff.id, aff.producer_id, aff.umbrella_id, aff.status, aff.source,
        aff.labels, aff.notes, aff.joined_at, aff.confirmed_at, aff.expires_at,
        aff.created_at, aff.updated_at,
        p.name AS producer_name,
        u.name AS umbrella_name,
        u.umbrella_type
      FROM agent_affiliations aff
      LEFT JOIN agents p ON p.id = aff.producer_id
      LEFT JOIN agents u ON u.id = aff.umbrella_id
      WHERE ${wheres.join(" AND ")}
      ORDER BY aff.updated_at DESC
      LIMIT ?
    `).all(...params) as any[];

    res.json({ success: true, count: rows.length, affiliations: rows });
  } catch (err: any) {
    console.error("[admin/affiliations] GET Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});

// ─── POST /admin/affiliations — create or upsert producer↔umbrella link
router.post("/admin/affiliations", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  try {
    const body = req.body || {};
    const producerId = typeof body.producer_id === "string" ? body.producer_id.trim() : "";
    const umbrellaId = typeof body.umbrella_id === "string" ? body.umbrella_id.trim() : "";
    const status = typeof body.status === "string" ? body.status : "pending_confirmation";
    const source = typeof body.source === "string" ? body.source : "admin";
    let labels: string[] = [];
    if (Array.isArray(body.labels)) labels = body.labels.map((s: any) => String(s));
    const notes = typeof body.notes === "string" ? body.notes : null;
    const joinedAt = typeof body.joined_at === "string" ? body.joined_at : null;

    if (!producerId || !umbrellaId) {
      res.status(400).json({ success: false, error: "producer_id and umbrella_id required" });
      return;
    }
    if (!["pending_confirmation", "active", "historical", "rejected"].includes(status)) {
      res.status(400).json({ success: false, error: "Invalid status" });
      return;
    }
    if (!["self_claimed", "scraped", "admin", "umbrella_confirmed"].includes(source)) {
      res.status(400).json({ success: false, error: "Invalid source" });
      return;
    }

    const db = getDb();

    // Verify producer + umbrella exist (and are the right kinds)
    const producer = db.prepare("SELECT id, umbrella_type FROM agents WHERE id = ?").get(producerId) as any;
    if (!producer) { res.status(404).json({ success: false, error: `producer_id ${producerId} not found` }); return; }
    if (producer.umbrella_type) {
      res.status(400).json({ success: false, error: "producer_id is an umbrella — affiliations link producers TO umbrellas" });
      return;
    }
    const umbrella = db.prepare("SELECT id, umbrella_type FROM agents WHERE id = ?").get(umbrellaId) as any;
    if (!umbrella) { res.status(404).json({ success: false, error: `umbrella_id ${umbrellaId} not found` }); return; }
    if (!umbrella.umbrella_type) {
      res.status(400).json({ success: false, error: "umbrella_id is not an umbrella" });
      return;
    }

    // Upsert via UNIQUE(producer_id, umbrella_id)
    const existing = db.prepare(
      "SELECT id FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?"
    ).get(producerId, umbrellaId) as any;

    const now = new Date().toISOString();
    const confirmedAt = status === "active" ? now : null;
    // Default expiry: 18 months from confirmed_at
    const expiresAt = confirmedAt ? new Date(Date.now() + 18 * 30 * 24 * 60 * 60 * 1000).toISOString() : null;

    if (existing) {
      db.prepare(`
        UPDATE agent_affiliations
        SET status = ?, source = ?, labels = ?, notes = ?, joined_at = ?,
            confirmed_at = COALESCE(confirmed_at, ?),
            expires_at = COALESCE(expires_at, ?),
            updated_at = ?
        WHERE id = ?
      `).run(status, source, JSON.stringify(labels), notes, joinedAt, confirmedAt, expiresAt, now, existing.id);

      interactionLogger.log("affiliation_upserted", {
        agentId: producerId,
        metadata: { affiliation_id: existing.id, producer_id: producerId, umbrella_id: umbrellaId, status, source, source_kind: "update" },
        ipAddress: req.ip,
      });

      const updated = db.prepare("SELECT * FROM agent_affiliations WHERE id = ?").get(existing.id) as any;
      res.json({ success: true, message: "Affiliation updated (idempotent upsert)", data: updated });
      return;
    }

    const result = db.prepare(`
      INSERT INTO agent_affiliations (
        producer_id, umbrella_id, status, source, labels, notes,
        joined_at, confirmed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(producerId, umbrellaId, status, source, JSON.stringify(labels), notes, joinedAt, confirmedAt, expiresAt);

    interactionLogger.log("affiliation_upserted", {
      agentId: producerId,
      metadata: { affiliation_id: result.lastInsertRowid, producer_id: producerId, umbrella_id: umbrellaId, status, source, source_kind: "create" },
      ipAddress: req.ip,
    });

    const created = db.prepare("SELECT * FROM agent_affiliations WHERE id = ?").get(result.lastInsertRowid) as any;
    res.status(201).json({ success: true, message: "Affiliation created", data: created });
  } catch (err: any) {
    console.error("[admin/affiliations] POST Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});

// ─── PATCH /admin/affiliations/:id — update status/labels/notes ────
router.patch("/admin/affiliations/:id", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  const affId = req.params.id as string;
  const body = req.body || {};

  const ALLOWED = new Set(["status", "labels", "notes", "expires_at"]);
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) {
      res.status(400).json({ success: false, error: `Felt ikke tillatt: ${key}` });
      return;
    }
  }
  if (Object.keys(body).length === 0) {
    res.status(400).json({ success: false, error: "Trenger minst ett av: " + Array.from(ALLOWED).join(", ") });
    return;
  }

  try {
    const db = getDb();
    const existing = db.prepare("SELECT id, status FROM agent_affiliations WHERE id = ?").get(affId) as any;
    if (!existing) {
      res.status(404).json({ success: false, error: "Affiliation not found" });
      return;
    }

    if (body.status !== undefined && !["pending_confirmation", "active", "historical", "rejected"].includes(body.status)) {
      res.status(400).json({ success: false, error: "Invalid status" });
      return;
    }
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels)) {
        res.status(400).json({ success: false, error: "labels must be an array" });
        return;
      }
      body.labels = JSON.stringify(body.labels);
    }

    const now = new Date().toISOString();
    const setParts: string[] = ["updated_at = ?"];
    const setValues: any[] = [now];
    for (const key of Object.keys(body)) {
      setParts.push(`${key} = ?`);
      setValues.push(body[key]);
    }
    // If transitioning to 'active', set confirmed_at if NULL
    if (body.status === "active") {
      setParts.push("confirmed_at = COALESCE(confirmed_at, ?)");
      setValues.push(now);
    }
    setValues.push(affId);

    db.prepare(`UPDATE agent_affiliations SET ${setParts.join(", ")} WHERE id = ?`).run(...setValues);

    interactionLogger.log("affiliation_updated", {
      agentId: affId,
      metadata: { affiliation_id: affId, fields_updated: Object.keys(body), previous_status: existing.status, source: "admin" },
      ipAddress: req.ip,
    });

    const updated = db.prepare("SELECT * FROM agent_affiliations WHERE id = ?").get(affId) as any;
    res.json({ success: true, message: "Affiliation updated", data: updated });
  } catch (err: any) {
    console.error("[admin/affiliations/:id] PATCH Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});




// ─── Phase 5.11 A4.3: Bondens marked migration admin endpoint ───────
// One-shot, idempotent migration that reshapes the 70 existing Bondens
// marked entries into umbrella/venue role while creating 2 new umbrella
// agents (national "Bondens marked Norge" + Sogn og Fjordane lokallag).
//
// Zero deletions — preserves all 70 existing agents and creates 70
// agent_affiliations rows (12 lokallag→national + 58 venue→lokallag).
//
// Per-row migration table is generated from
// protocols/phase5.11-a4-bm-migration-plan.csv (slookisen/A2A, reviewed
// by Daniel 2026-05-15) and embedded as a TS constant in src/data/.
//
// Supports body { dry_run: true } to inspect the resulting shape without
// committing — uses a manual BEGIN/ROLLBACK around the transaction so
// the DB state is unchanged after a dry-run.
//
// Idempotency: refuses to run if "Bondens marked Norge" already exists
// as an umbrella (409). Designed to be SAFE to retry post-failure.

router.post("/admin/migrations/phase-5.11-a4-bm", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  const body = (req.body || {}) as { dry_run?: boolean };
  const dryRun = body.dry_run === true;

  try {
    const db = getDb();

    // ── Idempotency guard ───────────────────────────────────────
    // Refuse to run if "Bondens marked Norge" already exists as an
    // umbrella. Name match is case-insensitive (LOWER comparison) and
    // requires umbrella_type IS NOT NULL — a plain producer named
    // similarly would NOT block the migration.
    const existing = db.prepare(
      "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type IS NOT NULL"
    ).get("Bondens marked Norge") as any;
    if (existing) {
      res.status(409).json({
        success: false,
        error: "Idempotency violation: 'Bondens marked Norge' umbrella already exists",
        existing_id: existing.id,
      });
      return;
    }

    // Lazy-import so unit tests that don't need this data don't pay parse cost
    const { BM_MIGRATION_DATA } = require("../data/phase5.11-a4-bm-migration");
    const crypto = require("crypto");

    // ── Manual transaction (allows dry-run via ROLLBACK) ────────
    // better-sqlite3's db.transaction() always commits on success — we need
    // explicit BEGIN/COMMIT|ROLLBACK control to support dry_run. Pattern
    // mirrors what the affiliations PATCH endpoint would use if it needed
    // multi-step rollback semantics.
    db.exec("BEGIN");
    let summary: any = null;
    try {
      const PROVENANCE = JSON.stringify({
        source: "phase5.11-a4-migration",
        verified_via: "bondensmarked.no/lokallag cross-ref + manual review by Daniel 2026-05-15",
      });

      // 1. Create national umbrella
      const nationalId = crypto.randomUUID();
      const nationalApiKey = `umb_${crypto.randomBytes(24).toString("hex")}`;
      db.prepare(`
        INSERT INTO agents (
          id, name, description, provider, contact_email, url,
          role, api_key,
          city, is_active, is_verified, trust_score,
          umbrella_type, parent_umbrella_id, umbrella_member_count
        ) VALUES (
          ?, ?, ?, 'umbrella-admin', ?, ?,
          'producer', ?,
          NULL, 1, 1, 0.9,
          'market_network', NULL, 0
        )
      `).run(
        nationalId,
        BM_MIGRATION_DATA.national.name,
        BM_MIGRATION_DATA.national.description,
        BM_MIGRATION_DATA.national.email,
        BM_MIGRATION_DATA.national.url,
        nationalApiKey,
      );
      knowledgeService.upsertKnowledge(nationalId, {
        website: BM_MIGRATION_DATA.national.url,
        email: BM_MIGRATION_DATA.national.email,
        phone: BM_MIGRATION_DATA.national.phone,
        about: BM_MIGRATION_DATA.national.description,
        dataSource: "owner",
      });

      // 2. Create new Sogn og Fjordane lokallag
      const sognId = crypto.randomUUID();
      const sognApiKey = `umb_${crypto.randomBytes(24).toString("hex")}`;
      db.prepare(`
        INSERT INTO agents (
          id, name, description, provider, contact_email, url,
          role, api_key,
          city, is_active, is_verified, trust_score,
          umbrella_type, parent_umbrella_id, umbrella_member_count
        ) VALUES (
          ?, ?, '', 'umbrella-admin', '', '',
          'producer', ?,
          NULL, 1, 1, 0.85,
          'market_network', ?, 0
        )
      `).run(sognId, "Bondens Marked Sogn og Fjordane", sognApiKey, nationalId);

      // 3. Build name→id map for lokallag (drives venue parent resolution
      //    + affiliation creation)
      const lokallagNameToId: Record<string, string> = {
        "Bondens marked Norge": nationalId,
        "Bondens Marked Sogn og Fjordane": sognId,
      };

      // 4. PROMOTE-TO-LOKALLAG: 12 existing agents → market_network + parent=national
      const promoteStmt = db.prepare(
        "UPDATE agents SET umbrella_type = 'market_network', parent_umbrella_id = ? WHERE id = ?"
      );
      let promoted = 0;
      for (const row of BM_MIGRATION_DATA.promote_to_lokallag) {
        const result = promoteStmt.run(nationalId, row.agent_id);
        if (result.changes === 0) {
          throw new Error(`promote_to_lokallag: agent_id ${row.agent_id} (${row.current_name}) not found`);
        }
        lokallagNameToId[row.current_name] = row.agent_id;
        promoted++;
      }

      // 5. DEMOTE-DUP + SET-AS-VENUE: 4 + 54 = 58 entries → venue + parent=<lokallag>
      const venueStmt = db.prepare(
        "UPDATE agents SET umbrella_type = 'venue', parent_umbrella_id = ? WHERE id = ?"
      );
      let demoted = 0;
      let setVenue = 0;
      for (const row of BM_MIGRATION_DATA.demote_dup_to_venue) {
        const parentId = lokallagNameToId[row.parent_lokallag_name];
        if (!parentId) throw new Error(`demote_dup_to_venue: unknown parent lokallag '${row.parent_lokallag_name}' for ${row.current_name}`);
        const result = venueStmt.run(parentId, row.agent_id);
        if (result.changes === 0) {
          throw new Error(`demote_dup_to_venue: agent_id ${row.agent_id} (${row.current_name}) not found`);
        }
        demoted++;
      }
      for (const row of BM_MIGRATION_DATA.set_as_venue) {
        const parentId = lokallagNameToId[row.parent_lokallag_name];
        if (!parentId) throw new Error(`set_as_venue: unknown parent lokallag '${row.parent_lokallag_name}' for ${row.current_name}`);
        const result = venueStmt.run(parentId, row.agent_id);
        if (result.changes === 0) {
          throw new Error(`set_as_venue: agent_id ${row.agent_id} (${row.current_name}) not found`);
        }
        setVenue++;
      }

      // 6. Create agent_affiliations rows
      //    - 12 lokallag → national (producer_id=lokallag.id, umbrella_id=national.id)
      //    - 58 venues → lokallag (producer_id=venue.id, umbrella_id=lokallag.id)
      //    status='active', source='admin', confirmed_at=now, 18-month expiry
      const affStmt = db.prepare(`
        INSERT INTO agent_affiliations (
          producer_id, umbrella_id, status, source, labels, notes,
          joined_at, confirmed_at, expires_at, field_provenance
        ) VALUES (?, ?, 'active', 'admin', '[]', ?, NULL, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 18 * 30 * 24 * 60 * 60 * 1000).toISOString();

      let affiliationsCreated = 0;
      // 12 lokallag → national
      for (const row of BM_MIGRATION_DATA.promote_to_lokallag) {
        affStmt.run(
          row.agent_id, nationalId,
          `Phase 5.11 A4.3 migration: ${row.current_name} → ${BM_MIGRATION_DATA.national.name}`,
          now, expiresAt, PROVENANCE,
        );
        affiliationsCreated++;
      }
      // 58 venues → lokallag
      for (const row of [...BM_MIGRATION_DATA.demote_dup_to_venue, ...BM_MIGRATION_DATA.set_as_venue]) {
        const parentId = lokallagNameToId[row.parent_lokallag_name];
        affStmt.run(
          row.agent_id, parentId,
          `Phase 5.11 A4.3 migration: ${row.current_name} → ${row.parent_lokallag_name}`,
          now, expiresAt, PROVENANCE,
        );
        affiliationsCreated++;
      }

      // 7. Refresh umbrella_member_count for all umbrellas (national + 13 lokallag)
      db.prepare(`
        UPDATE agents
        SET umbrella_member_count = (
          SELECT COUNT(*) FROM agent_affiliations
          WHERE umbrella_id = agents.id AND status = 'active'
        )
        WHERE umbrella_type IS NOT NULL
      `).run();

      // 8. Build summary response
      const totalAgents = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as any).c;
      const totalUmbrellas = (db.prepare("SELECT COUNT(*) AS c FROM agents WHERE umbrella_type IS NOT NULL").get() as any).c;
      const totalVenues = (db.prepare("SELECT COUNT(*) AS c FROM agents WHERE umbrella_type = 'venue'").get() as any).c;

      summary = {
        success: true,
        dry_run: dryRun,
        created: {
          national: 1,
          new_lokallag: 1,
          total: 2,
        },
        promoted_to_lokallag: promoted,
        demoted_to_venue: demoted,
        set_as_venue: setVenue,
        affiliations_created: affiliationsCreated,
        total_agents_after: totalAgents,
        total_umbrellas_after: totalUmbrellas,
        total_venues_after: totalVenues,
        national_id: nationalId,
        sogn_id: sognId,
      };

      if (dryRun) {
        db.exec("ROLLBACK");
      } else {
        db.exec("COMMIT");
        interactionLogger.log("umbrella_created", {
          agentId: nationalId,
          metadata: {
            migration: "phase-5.11-a4-bm",
            source: "admin",
            summary,
          },
          ipAddress: req.ip,
        });
      }
    } catch (innerErr: any) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw innerErr;
    }

    res.json(summary);
  } catch (err: any) {
    console.error("[admin/migrations/phase-5.11-a4-bm] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});


// ─── Phase 5.11 A4.4 (PR-50): Sogn og Fjordane affiliation backfill ──
// A4.3 migration created 70 affiliations (12 PROMOTE→national + 58
// venues→lokallag) but missed one row: the NEW Sogn og Fjordane lokallag
// that was CREATED during the migration (it wasn't in the 12 promoted
// agents). Result: /api/marketplace/umbrellas/<national-id>/members
// returns count=12 instead of expected 13.
//
// This endpoint inserts the missing affiliation row. Same X-Admin-Key
// gate as the A4.3 migration. Idempotent — returns 409 if the affiliation
// already exists. Designed as a one-time fix; safe to re-run (no-op).
router.post("/admin/migrations/phase-5.11-a4-bm-fix-sogn-affiliation", (req: Request, res: Response) => {
  const expectedKey = getAdminKey();
  if (!expectedKey) { res.status(503).json({ success: false, error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return;
  }

  try {
    const db = getDb();

    // 1. Look up Sogn og Fjordane lokallag (case-insensitive, must be umbrella)
    const sogn = db.prepare(
      "SELECT id, name FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type = 'market_network'"
    ).get("Bondens Marked Sogn og Fjordane") as any;
    if (!sogn) {
      res.status(404).json({
        success: false,
        error: "Sogn og Fjordane lokallag not found — has the A4.3 migration run yet?",
      });
      return;
    }

    // 2. Look up Bondens marked Norge (national umbrella)
    const national = db.prepare(
      "SELECT id, name FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type = 'market_network' AND parent_umbrella_id IS NULL"
    ).get("Bondens marked Norge") as any;
    if (!national) {
      res.status(404).json({
        success: false,
        error: "National umbrella 'Bondens marked Norge' not found — has the A4.3 migration run yet?",
      });
      return;
    }

    // 3. Idempotency pre-check (UNIQUE(producer_id, umbrella_id) catches it too,
    // but a friendly 409 is preferable to a generic constraint-violation 500).
    const existing = db.prepare(
      "SELECT id FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?"
    ).get(sogn.id, national.id) as any;
    if (existing) {
      res.status(409).json({
        success: false,
        error: "Affiliation already exists (Sogn og Fjordane → Bondens marked Norge)",
        existing_affiliation_id: existing.id,
      });
      return;
    }

    // 4. INSERT the affiliation
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 18 * 30 * 24 * 60 * 60 * 1000).toISOString();
    const provenance = JSON.stringify({
      source: "phase5.11-a4-fix-sogn",
      verified_via: "PR-50 follow-up to A4.3 migration",
    });
    const insertResult = db.prepare(`
      INSERT INTO agent_affiliations (
        producer_id, umbrella_id, status, source, labels, notes,
        joined_at, confirmed_at, expires_at, field_provenance
      ) VALUES (?, ?, 'active', 'admin', '[]', ?, NULL, ?, ?, ?)
    `).run(
      sogn.id, national.id,
      `Phase 5.11 A4.4 backfill: ${sogn.name} → ${national.name}`,
      now, expiresAt, provenance,
    );

    // 5. Refresh national umbrella's member count
    db.prepare(`
      UPDATE agents
      SET umbrella_member_count = (
        SELECT COUNT(*) FROM agent_affiliations
        WHERE umbrella_id = agents.id AND status = 'active'
      )
      WHERE id = ?
    `).run(national.id);

    const newRow = db.prepare("SELECT * FROM agent_affiliations WHERE id = ?").get(insertResult.lastInsertRowid) as any;
    const newMemberCount = (db.prepare("SELECT umbrella_member_count FROM agents WHERE id = ?").get(national.id) as any).umbrella_member_count;

    interactionLogger.log("affiliation_upserted", {
      agentId: national.id,
      metadata: {
        migration: "phase-5.11-a4-bm-fix-sogn-affiliation",
        source: "admin",
        producer_id: sogn.id,
        umbrella_id: national.id,
      },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      affiliation: newRow,
      sogn_id: sogn.id,
      national_id: national.id,
      national_member_count: newMemberCount,
    });
  } catch (err: any) {
    console.error("[admin/migrations/phase-5.11-a4-bm-fix-sogn-affiliation] Error:", err);
    res.status(500).json({ success: false, error: err.message || "Intern feil" });
  }
});


// ─── GET /api/marketplace/bm-events (PR-56, 2026-05-16) ─────────────
// Public read of upcoming Bondens marked events. Used by:
//   - the venue/lokallag/national profile pages (server-side render)
//   - external consumers + AI agents (no auth required)
//
// Filters:
//   from / to        — ISO datetime window (default: now → now+7 days)
//   lokallag         — agent_id of a lokallag; returns events at any of its
//                      child venues OR matched-via-fallback to that lokallag
//   venue            — agent_id of a specific venue
//   region           — case-insensitive substring match on location_text
//   limit            — default 50, max 200
router.get("/bm-events", (req: Request, res: Response) => {
  try {
    const db = getDb();

    const fromIso = (req.query.from as string) || new Date().toISOString();
    const defaultTo = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const toIso = (req.query.to as string) || defaultTo;

    const lokallag = (req.query.lokallag as string) || "";
    const venue = (req.query.venue as string) || "";
    const region = (req.query.region as string) || "";

    let limit = parseInt((req.query.limit as string) || "50", 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    const wheres: string[] = ["e.start_at >= ?", "e.start_at <= ?"];
    const params: any[] = [fromIso, toIso];

    // PR-94: filter out bm_venue agents that are still pending review or
    // explicitly rejected. Public-facing endpoint must not surface
    // unreviewed placeholder venues to end users / AI agents.
    wheres.push("(a.umbrella_type != \'bm_venue\' OR a.agent_review_status = \'confirmed\')");

    if (venue) {
      wheres.push("e.venue_agent_id = ?");
      params.push(venue);
    } else if (lokallag) {
      // Match events at any venue under this lokallag PLUS events matched
      // directly to the lokallag itself via the fallback path.
      wheres.push("(e.venue_agent_id = ? OR a.parent_umbrella_id = ?)");
      params.push(lokallag, lokallag);
    }
    if (region) {
      wheres.push("LOWER(e.location_text) LIKE ?");
      params.push(`%${region.toLowerCase()}%`);
    }

    const sql = `
      SELECT e.event_slug, e.event_name, e.location_text, e.start_at, e.end_at, e.source_url,
             a.id AS venue_agent_id, a.name AS venue_name, a.umbrella_type AS venue_type
      FROM bm_market_events e
      INNER JOIN agents a ON a.id = e.venue_agent_id
      WHERE ${wheres.join(" AND ")}
      ORDER BY e.start_at ASC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit) as any[];

    const events = rows.map(r => ({
      event_slug: r.event_slug,
      event_name: r.event_name,
      venue: {
        agent_id: r.venue_agent_id,
        name: r.venue_name,
        slug: slugify(r.venue_name),
        type: r.venue_type,
      },
      location_text: r.location_text,
      start_at: r.start_at,
      end_at: r.end_at,
      source_url: r.source_url,
    }));

    res.json({ count: events.length, events });
  } catch (err: any) {
    // Most likely cause: bm_market_events table missing (migration didn't run).
    // Return 503 so callers can distinguish "no data yet" from a real bug.
    res.status(503).json({
      error: "bm-events query failed",
      detail: err?.message || String(err),
    });
  }
});


export default router;

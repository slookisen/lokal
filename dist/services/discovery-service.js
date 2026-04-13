"use strict";
// ─── Discovery Service ─────────────────────────────────────
// HOW AGENTS FIND LOKAL — the three discovery channels:
//
// 1. A2A Agent Card at /.well-known/agent-card.json
//    → Any agent that knows our URL can read our capabilities.
//    → This is passive discovery: they come to us.
//
// 2. A2A Registry Registration
//    → We actively register ourselves with known A2A registries.
//    → When a new registry appears, we ping it with our card.
//    → This is active discovery: we announce ourselves.
//
// 3. MCP Tool Directory
//    → Claude Desktop, Cursor, and other MCP clients search
//      for tools by capability. Our MCP server metadata makes
//      us findable in those ecosystems.
//
// 4. DNS-SD / Well-Known URI (future)
//    → For local network discovery (e.g., restaurant in same building
//      as a farm — their agents could find each other on LAN).
//
// WHY THIS MATTERS:
// Today, the A2A ecosystem is small. But it's growing fast.
// Every week, new agent frameworks add A2A support.
// By registering early, we get "first mover" advantage:
// when agents search for "food marketplace Norway", we're there.
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoveryService = void 0;
const marketplace_registry_1 = require("./marketplace-registry");
// NOTE: These URLs are placeholders. Replace with real registry URLs
// as the A2A ecosystem matures. The code is ready — only config changes needed.
const KNOWN_REGISTRIES = [
    {
        name: "A2A Directory (Google)",
        registrationUrl: "https://a2a-directory.googleapis.com/v1/agents",
        heartbeatUrl: "https://a2a-directory.googleapis.com/v1/agents/heartbeat",
        type: "a2a",
        enabled: false, // Enable when Google launches their directory
    },
    {
        name: "AgentVerse",
        registrationUrl: "https://agentverse.ai/api/v1/agents",
        type: "a2a",
        enabled: false, // Enable when available
    },
    {
        name: "MCP Registry (Anthropic)",
        registrationUrl: "https://registry.mcp.anthropic.com/v1/tools",
        type: "mcp",
        enabled: false, // Enable when Anthropic launches their registry
    },
];
class DiscoveryService {
    baseUrl;
    heartbeatInterval = null;
    constructor() {
        this.baseUrl = process.env.BASE_URL || "http://localhost:3000";
    }
    // ─── Initialize discovery on server start ──────────────────
    // Called from index.ts after the server is up.
    async initialize(baseUrl) {
        this.baseUrl = baseUrl;
        // Only register if we have a public URL (not localhost)
        if (this.isPublicUrl(baseUrl)) {
            console.log("[Discovery] Public URL detected, registering with known A2A registries...");
            await this.registerWithAllRegistries();
            this.startHeartbeat();
        }
        else {
            console.log("[Discovery] Running on localhost — skipping registry registration.");
            console.log("[Discovery] Set BASE_URL to a public URL to enable agent discovery.");
        }
        // Always log the agent card URL
        console.log(`[Discovery] Agent Card: ${baseUrl}/.well-known/agent-card.json`);
        console.log(`[Discovery] A2A Endpoint: ${baseUrl}/a2a`);
    }
    // ─── Register with all enabled registries ──────────────────
    async registerWithAllRegistries() {
        const card = marketplace_registry_1.marketplaceRegistry.getRegistryCard(this.baseUrl);
        const enabledRegistries = KNOWN_REGISTRIES.filter(r => r.enabled);
        if (enabledRegistries.length === 0) {
            console.log("[Discovery] No registries enabled yet. Add registries as the A2A ecosystem grows.");
            return;
        }
        for (const registry of enabledRegistries) {
            try {
                await this.registerWithRegistry(registry, card);
                console.log(`[Discovery] ✓ Registered with ${registry.name}`);
            }
            catch (err) {
                console.warn(`[Discovery] ✗ Failed to register with ${registry.name}: ${err.message}`);
            }
        }
    }
    // ─── Register with a single registry ───────────────────────
    async registerWithRegistry(registry, card) {
        const response = await fetch(registry.registrationUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Lokal/1.0 (A2A Food Marketplace)",
            },
            body: JSON.stringify({
                agentCard: card,
                wellKnownUrl: `${this.baseUrl}/.well-known/agent-card.json`,
                a2aEndpoint: `${this.baseUrl}/a2a`,
                categories: ["food", "marketplace", "local-commerce", "norway"],
            }),
            signal: AbortSignal.timeout(10000), // 10s timeout
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
    }
    // ─── Heartbeat: tell registries we're still alive ──────────
    // Most registries will delist inactive agents after a period.
    // We send a heartbeat every 30 minutes.
    startHeartbeat() {
        const HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 minutes
        this.heartbeatInterval = setInterval(async () => {
            const registriesWithHeartbeat = KNOWN_REGISTRIES.filter(r => r.enabled && r.heartbeatUrl);
            for (const registry of registriesWithHeartbeat) {
                try {
                    await fetch(registry.heartbeatUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            url: this.baseUrl,
                            status: "active",
                            stats: marketplace_registry_1.marketplaceRegistry.getStats(),
                        }),
                        signal: AbortSignal.timeout(5000),
                    });
                }
                catch {
                    // Non-critical — registry will keep us listed for a while
                }
            }
        }, HEARTBEAT_INTERVAL);
    }
    // ─── Generate discovery metadata ───────────────────────────
    // This is what goes into DNS TXT records, meta tags, robots.txt etc.
    // For when we add web-based discovery channels.
    getDiscoveryMetadata() {
        return {
            "a2a-agent-card": `${this.baseUrl}/.well-known/agent-card.json`,
            "a2a-endpoint": `${this.baseUrl}/a2a`,
            "mcp-server": `${this.baseUrl}/mcp`,
            "service-type": "food-marketplace",
            "region": "NO",
            "languages": ["no", "en"],
            "categories": [
                "food", "marketplace", "local-commerce",
                "organic", "farm-direct", "sustainable",
            ],
            // For future DNS-SD (mDNS) local network discovery
            "dns-sd": {
                serviceType: "_a2a._tcp",
                serviceName: "Lokal Food Marketplace",
                txtRecords: {
                    "path": "/.well-known/agent-card.json",
                    "type": "food-marketplace",
                    "region": "NO",
                },
            },
        };
    }
    // ─── Get status of all registries ──────────────────────────
    getRegistryStatus() {
        return KNOWN_REGISTRIES.map(r => ({
            name: r.name,
            type: r.type,
            enabled: r.enabled,
            url: r.registrationUrl,
        }));
    }
    // ─── Cleanup ───────────────────────────────────────────────
    shutdown() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    isPublicUrl(url) {
        return !url.includes("localhost") && !url.includes("127.0.0.1") && !url.includes("0.0.0.0");
    }
}
// Singleton
exports.discoveryService = new DiscoveryService();
//# sourceMappingURL=discovery-service.js.map
#!/usr/bin/env npx tsx
// ═══════════════════════════════════════════════════════════════
// Lokal Demo Agent — How to discover local food with A2A
// ═══════════════════════════════════════════════════════════════
// This demo shows how any AI agent can use the Lokal platform
// to find local food producers in Norway using the A2A protocol.
//
// Run: npx tsx demo-agent.ts
// Or:  ts-node demo-agent.ts
// ═══════════════════════════════════════════════════════════════

const BASE_URL = "https://lokal.fly.dev";

// ─────────────────────────────────────────────────────────────
// Types for clarity
// ─────────────────────────────────────────────────────────────

interface AgentCard {
  name: string;
  description: string;
  version: string;
  endpoints?: Record<string, string>;
}

interface A2ARequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id: string | number;
}

interface A2AResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
  id: string | number;
}

interface DiscoveryResult {
  agents: Array<{
    id: string;
    name: string;
    role: string;
    description: string;
    distance_km?: number;
    trust_score?: number;
  }>;
}

interface AgentInfo {
  id: string;
  name: string;
  email?: string;
  description: string;
  categories: string[];
  tags: string[];
  location?: {
    lat: number;
    lng: number;
  };
  contact?: string;
}

// ─────────────────────────────────────────────────────────────
// Utility: Pretty print with sections
// ─────────────────────────────────────────────────────────────

function section(title: string) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function subsection(title: string) {
  console.log(`\n  → ${title}`);
  console.log("  " + "─".repeat(57));
}

function log(msg: unknown) {
  const str = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
  console.log("  " + str.split("\n").join("\n  "));
}

// ─────────────────────────────────────────────────────────────
// Step 1: Discover the Lokal Agent Card
// ─────────────────────────────────────────────────────────────

async function discoverAgentCard(): Promise<AgentCard> {
  section("Step 1: Discover Lokal Agent Card");
  subsection("Fetching /.well-known/agent-card.json");

  try {
    const response = await fetch(
      `${BASE_URL}/.well-known/agent-card.json`
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const card = (await response.json()) as AgentCard;
    log(`Agent Name: ${card.name}`);
    log(`Description: ${card.description}`);
    log(`Version: ${card.version}`);
    if (card.endpoints) {
      log("Available Endpoints:");
      Object.entries(card.endpoints).forEach(([key, value]) => {
        log(`  ${key}: ${value}`);
      });
    }

    return card;
  } catch (error) {
    throw new Error(
      `Failed to fetch agent card: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Step 2: Send A2A JSON-RPC Message
// ─────────────────────────────────────────────────────────────
// The A2A (Agent-to-Agent) protocol is a JSON-RPC 2.0 interface
// that allows agents to communicate with each other using
// standardized message passing. It's designed for decentralized
// agent networks where no central authority is required.
//
// In this example, we're sending a "message/send" RPC call to
// request organic vegetables near Oslo. The Lokal platform
// interprets this and returns matching producers.
// ─────────────────────────────────────────────────────────────

async function sendA2AMessage(): Promise<A2AResponse> {
  section("Step 2: Send A2A JSON-RPC Message");
  subsection("Using message/send to find organic vegetables near Oslo");

  // Construct a JSON-RPC 2.0 request
  // The params object can include search criteria that the platform understands
  const request: A2ARequest = {
    jsonrpc: "2.0",
    method: "message/send",
    params: {
      query: "organic vegetables Oslo",
      category: "vegetables",
      tags: ["organic", "fresh"],
      latitude: 59.9139,
      longitude: 10.7522,
      max_distance_km: 50,
    },
    id: "demo-1",
  };

  log("A2A Request:");
  log(request);

  try {
    const response = await fetch(`${BASE_URL}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as A2AResponse;
    log("A2A Response:");
    log(result);

    return result;
  } catch (error) {
    throw new Error(
      `A2A request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Step 3: Get Detailed Seller Info
// ─────────────────────────────────────────────────────────────

async function getSellerInfo(agentId: string): Promise<AgentInfo | null> {
  section("Step 3: Fetch Detailed Seller Information");
  subsection(`Getting info for agent: ${agentId}`);

  try {
    const response = await fetch(
      `${BASE_URL}/api/marketplace/agents/${agentId}/info`
    );

    if (!response.ok) {
      log(`ℹ Agent info not available (${response.status})`);
      return null;
    }

    const info = (await response.json()) as AgentInfo;
    log(`Name: ${info.name}`);
    log(`Email: ${info.email || "Not provided"}`);
    log(`Categories: ${info.categories?.join(", ") || "N/A"}`);
    log(`Tags: ${info.tags?.join(", ") || "N/A"}`);
    if (info.location) {
      log(
        `Location: ${info.location.lat.toFixed(4)}, ${info.location.lng.toFixed(4)}`
      );
    }

    return info;
  } catch (error) {
    log(
      `ℹ Could not fetch detailed info: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Step 4: Natural Language Search
// ─────────────────────────────────────────────────────────────
// The search endpoint accepts free-form natural language queries
// and uses the platform's understanding to match producers.
// This is useful for more conversational, less structured queries.
// ─────────────────────────────────────────────────────────────

async function naturalLanguageSearch(query: string): Promise<DiscoveryResult> {
  section("Step 4: Natural Language Search");
  subsection(`Query: "${query}"`);

  try {
    const url = new URL(`${BASE_URL}/api/marketplace/search`);
    url.searchParams.append("q", query);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const results = (await response.json()) as DiscoveryResult;
    log(`Found ${results.agents?.length || 0} producers:`);

    if (results.agents && results.agents.length > 0) {
      results.agents.slice(0, 3).forEach((agent, idx) => {
        log(
          `  ${idx + 1}. ${agent.name} (${agent.role}) - ${agent.description}`
        );
        if (agent.distance_km) {
          log(`     Distance: ${agent.distance_km.toFixed(1)} km`);
        }
        if (agent.trust_score) {
          log(`     Trust Score: ${(agent.trust_score * 100).toFixed(0)}%`);
        }
      });
    }

    return results;
  } catch (error) {
    throw new Error(
      `Search failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Step 5: Discover Endpoint (Structured Discovery)
// ─────────────────────────────────────────────────────────────
// The discover endpoint allows structured, multi-parameter queries
// with precise filtering by category, tags, role, and distance.
// This is ideal for programmatic discovery with specific criteria.
// ─────────────────────────────────────────────────────────────

async function structuredDiscovery(): Promise<DiscoveryResult> {
  section("Step 5: Structured Discovery with Filtering");
  subsection(
    "Discovering organic dairy producers within 30 km of Oslo (latitude: 59.9139, longitude: 10.7522)"
  );

  try {
    const url = new URL(`${BASE_URL}/api/marketplace/discover`);

    // Add structured discovery parameters
    url.searchParams.append("categories", "dairy");
    url.searchParams.append("tags", "organic,local");
    url.searchParams.append("role", "producer");
    url.searchParams.append("lat", "59.9139");
    url.searchParams.append("lng", "10.7522");
    url.searchParams.append("maxDistanceKm", "30");
    url.searchParams.append("limit", "5");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const results = (await response.json()) as DiscoveryResult;
    log(`Found ${results.agents?.length || 0} dairy producers nearby:`);

    if (results.agents && results.agents.length > 0) {
      results.agents.slice(0, 3).forEach((agent, idx) => {
        log(`  ${idx + 1}. ${agent.name}`);
        log(`     Role: ${agent.role}`);
        log(`     Description: ${agent.description}`);
        if (agent.distance_km) {
          log(`     Distance: ${agent.distance_km.toFixed(1)} km`);
        }
        if (agent.trust_score) {
          log(`     Trust Score: ${(agent.trust_score * 100).toFixed(0)}%`);
        }
      });
    }

    return results;
  } catch (error) {
    throw new Error(
      `Structured discovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Main: Orchestrate the Demo
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n");
  console.log("╔" + "═".repeat(58) + "╗");
  console.log("║" + " ".repeat(58) + "║");
  console.log("║  LOKAL DEMO: CONSUMER AGENT A2A DISCOVERY" + " ".repeat(16) + "║");
  console.log(
    "║  Discovering local food producers in Norway with A2A" +
      " ".repeat(3) + "║"
  );
  console.log("║" + " ".repeat(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝");

  try {
    // Step 1: Discover agent card
    await discoverAgentCard();

    // Step 2: Send A2A message
    const a2aResponse = await sendA2AMessage();

    // Step 3: Get detailed info about a result (if available)
    // Try to get info about Lokal itself first
    await getSellerInfo("lokal");

    // Step 4: Natural language search
    await naturalLanguageSearch("fresh berries near Grünerløkka Oslo");

    // Step 5: Structured discovery
    await structuredDiscovery();

    // Summary
    section("Demo Complete");
    log(
      "You've successfully used three discovery methods to find local food producers:"
    );
    log("  1. A2A JSON-RPC message/send for agent-to-agent communication");
    log("  2. Natural language search for conversational queries");
    log("  3. Structured discovery for precise, filtered results");
    log("");
    log("Next steps:");
    log("  • Integrate these methods into your agent");
    log("  • Register your own agent with lokal_register()");
    log("  • Handle producer responses and negotiate agreements");
    log("");
  } catch (error) {
    section("Error Occurred");
    log(
      `❌ ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  console.log(
    "\n" + "═".repeat(60) + "\n"
  );
}

// Run the demo
main();

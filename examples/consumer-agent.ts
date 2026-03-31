// ─── Example: Consumer Agent using Lokal ──────────────────────
// This shows how ANY AI agent (ChatGPT plugin, Claude tool, custom)
// discovers and interacts with local food producers via Lokal.
//
// Flow:
//   1. Discover Lokal's registry (/.well-known/agent.json)
//   2. Search for producers matching user's needs
//   3. Get details from a specific producer agent
//   4. Create a reservation
//
// This is what makes Lokal an INFRASTRUCTURE play, not just an app.
// Every AI assistant in the world can plug into this.

const LOKAL_BASE = process.env.LOKAL_URL || "http://localhost:3000";

// ─── Step 1: Discover Lokal Registry ─────────────────────────
// A consumer agent first finds Lokal via the well-known A2A endpoint.
// In production, agents would find us via A2A registry catalogs.

async function discoverRegistry() {
  console.log("🔍 Step 1: Discovering Lokal registry...\n");

  const res = await fetch(`${LOKAL_BASE}/.well-known/agent.json`);
  const card = await res.json();

  console.log(`   Registry: ${card.name}`);
  console.log(`   Description: ${card.description}`);
  console.log(`   Skills: ${card.skills.map((s: any) => s.id).join(", ")}`);
  console.log(`   Producers: ${card["x-lokal"]?.stats?.totalAgents || card.producers?.length || 0}`);
  console.log();

  return card;
}

// ─── Step 2: Search with Natural Language ────────────────────
// The user says: "Finn økologiske grønnsaker nær Grünerløkka"
// The consumer agent forwards this to Lokal's search endpoint.

async function searchNaturalLanguage(query: string) {
  console.log(`🗣️  Step 2: Natural language search: "${query}"\n`);

  const res = await fetch(
    `${LOKAL_BASE}/api/marketplace/search?q=${encodeURIComponent(query)}`
  );
  const data = await res.json();

  console.log(`   Parsed as: ${JSON.stringify(data.parsed, null, 2)}`);
  console.log(`   Found ${data.count} matching agents:\n`);

  for (const result of data.results) {
    console.log(`   📦 ${result.agent.name}`);
    console.log(`      Role: ${result.agent.role}`);
    console.log(`      Categories: ${result.agent.categories.join(", ")}`);
    console.log(`      Distance: ${result.agent.location?.distanceKm?.toFixed(1) || "?"} km`);
    console.log(`      Trust: ${(result.agent.trustScore * 100).toFixed(0)}%`);
    console.log(`      Score: ${(result.relevanceScore * 100).toFixed(0)}%`);
    console.log(`      Why: ${result.matchReasons.join(" | ")}`);
    console.log();
  }

  return data.results;
}

// ─── Step 3: Structured Discovery ────────────────────────────
// For more precise searches, agents use the structured API.

async function structuredDiscovery() {
  console.log("🔎 Step 3: Structured discovery...\n");

  const res = await fetch(`${LOKAL_BASE}/api/marketplace/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role: "producer",
      categories: ["vegetables", "fruit"],
      tags: ["organic"],
      location: { lat: 59.9225, lng: 10.7584 }, // Grünerløkka
      maxDistanceKm: 10,
      limit: 5,
    }),
  });

  const data = await res.json();
  console.log(`   Found ${data.count} producers within 10km:\n`);

  for (const result of data.results) {
    console.log(`   🌱 ${result.agent.name} — ${result.agent.description}`);
    console.log(`      Skills: ${result.agent.skills.map((s: any) => s.name).join(", ")}`);
    console.log();
  }

  return data.results;
}

// ─── Step 4: Use existing product search ─────────────────────
// Once we know which producers exist, search for specific products.

async function searchProducts() {
  console.log("🥬 Step 4: Searching for available products...\n");

  const res = await fetch(`${LOKAL_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "tomater",
      maxDistanceKm: 10,
      mustBeOrganic: true,
      location: { lat: 59.9225, lng: 10.7584 },
      preferences: {
        priceSensitivity: 0.7,
        organicPreference: 0.9,
        freshnessWeight: 0.8,
        localityWeight: 0.6,
      },
    }),
  });

  const data = await res.json();
  console.log(`   Found ${data.data?.length || 0} matching products:\n`);

  if (data.data) {
    for (const result of data.data.slice(0, 3)) {
      console.log(`   🍅 ${result.productName} fra ${result.producerName}`);
      console.log(`      Pris: ${result.pricePerUnit} kr/${result.unit}`);
      console.log(`      Avstand: ${result.distanceKm?.toFixed(1)} km`);
      console.log(`      Match: ${(result.matchScore * 100).toFixed(0)}%`);
      if (result.chainComparison) {
        console.log(`      vs. kjede: ${result.chainComparison.savingsLabel}`);
      }
      console.log();
    }
  }

  return data;
}

// ─── Run the full flow ──────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  LOKAL — Consumer Agent Example");
  console.log("  Demonstrating A2A agent-to-agent food discovery");
  console.log("═══════════════════════════════════════════════════\n");

  try {
    await discoverRegistry();
    await searchNaturalLanguage("finn økologiske grønnsaker nær Grünerløkka");
    await structuredDiscovery();
    await searchProducts();

    console.log("═══════════════════════════════════════════════════");
    console.log("  ✅ Full agent flow complete!");
    console.log("  An AI assistant can now find local food for users.");
    console.log("═══════════════════════════════════════════════════\n");
  } catch (err: any) {
    console.error("❌ Error:", err.message);
    console.error("   Make sure the Lokal server is running: npm run dev");
  }
}

main();

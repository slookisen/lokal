/**
 * drink-subcategory-mcp.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 5b (RFB side).
 *
 * Covers:
 *   - lokal_discover's inputSchema now exposes `drinkSubcategory` as a real
 *     zod enum matching drink-taxonomy.ts's DRINK_SUBCATEGORIES exactly (not
 *     a free string an agent has to guess the spelling of).
 *   - the categories field's own description now mentions "beverages" (it
 *     did not before this slice — see marketplace-registry.ts's own Fase 5
 *     history comment for why that mattered).
 *   - end to end: calling the REAL registered lokal_discover handler with
 *     categories:["beverages"] + drinkSubcategory narrows results to only
 *     the matching producer, against a real seeded in-memory RFB DB — not a
 *     mock of marketplaceRegistry.discover().
 *   - marketplaceRegistry.discover()'s own drinkSubcategory filter, called
 *     directly, for the same real seeded rows (covers the REST /discover
 *     path too — routes/marketplace.ts's POST /discover is a thin
 *     DiscoveryQuerySchema.parse(req.body) wrapper around exactly this call).
 *
 * Harness mirrors mcp-search-geo.test.ts: registerTools() exercised through a
 * duck-typed server (no transport), real production schema in an in-memory
 * DB, geocoder fetch stubbed to always 404 (no network; any geo in these
 * cases comes only from lat/lng passed explicitly, which none of these do).
 *
 * Exported runDrinkSubcategoryMcpTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 * Standalone: npx tsx src/routes/drink-subcategory-mcp.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "../services/geocoding-service";
import { DRINK_SUBCATEGORIES } from "../services/drink-taxonomy";
import { marketplaceRegistry } from "../services/marketplace-registry";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: any;
  handler: (args: any, extra?: any) => Promise<any>;
}

const SEED = [
  { id: "d-bryggeri", name: "Ruteøl Bryggeri", city: "Kristiansand", lat: 58.15, lng: 8.00,
    categories: ["beverages"], description: "Lite bryggeri som lager håndverksøl på gården." },
  { id: "d-vingard", name: "Sørlandsk Vingård", city: "Grimstad", lat: 58.34, lng: 8.59,
    categories: ["beverages"], description: "Vingård med egen vinproduksjon fra lokale druer." },
  { id: "d-nondrink", name: "Kristiansand Honning", city: "Kristiansand", lat: 58.15, lng: 8.01,
    categories: ["honey"], description: "Lokal birøkter, selger honning fra egne bikuber." },
];

function seedAgents(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, ?, '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const a of SEED) {
    stmt.run(a.id, a.name, a.description, `${a.id}@example.no`, `https://${a.id}.example.no`,
      "key-" + a.id, a.lat, a.lng, a.city, JSON.stringify(a.categories));
  }
}

export async function runDrinkSubcategoryMcpTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seedAgents(db);

  __setGeocodingFetchForTesting((async () =>
    ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch);
  __clearGeocodeCacheForTesting();

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    const { registerTools } = require("./mcp") as typeof import("./mcp");

    const tools = new Map<string, CapturedTool>();
    const fakeServer: any = {
      registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    };
    registerTools(fakeServer, () => "test-client", () => undefined);

    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");

    // ══════════════════════════════════════════════════════════════
    // Schema shape
    // ══════════════════════════════════════════════════════════════
    const discover = tools.get("lokal_discover");
    assertTrue(!!discover, "sc1: lokal_discover is registered");
    if (discover) {
      const schema = discover.config.inputSchema || {};
      assertTrue("drinkSubcategory" in schema, "sc2: lokal_discover inputSchema exposes drinkSubcategory");

      // The zod enum's own accepted values must be EXACTLY the six canonical
      // ones — parsing a wrong value should fail, parsing a right one should not.
      const zField = schema.drinkSubcategory;
      for (const sub of DRINK_SUBCATEGORIES) {
        const r = zField?.safeParse ? zField.safeParse(sub) : { success: true };
        assertTrue(r.success !== false, `sc3: drinkSubcategory zod field accepts "${sub}"`);
      }
      if (zField?.safeParse) {
        const bad = zField.safeParse("bakeri");
        assertTrue(bad.success === false, "sc4: drinkSubcategory zod field REJECTS a non-member value like \"bakeri\"");
      }

      const categoriesDesc = String(schema.categories?.description || "");
      assertTrue(categoriesDesc.toLowerCase().includes("beverages"),
        "sc5: the categories field's own description now mentions \"beverages\"");
    }

    // ══════════════════════════════════════════════════════════════
    // End to end: the REAL handler, real seeded rows
    // ══════════════════════════════════════════════════════════════
    if (discover) {
      const allBeverages = await discover.handler({ categories: ["beverages"], limit: 10 });
      const allText = textOf(allBeverages);
      assertTrue(allText.includes("Ruteøl Bryggeri") && allText.includes("Sørlandsk Vingård"),
        "e1: categories:['beverages'] alone (no subcategory) returns BOTH drink producers");
      assertTrue(!allText.includes("Kristiansand Honning"),
        "e2: …and never the non-drink honey producer");

      const onlyBryggeri = await discover.handler({
        categories: ["beverages"], drinkSubcategory: "bryggeri", limit: 10,
      });
      const bryggeriText = textOf(onlyBryggeri);
      assertTrue(bryggeriText.includes("Ruteøl Bryggeri"), "e3: drinkSubcategory:'bryggeri' includes the brewery");
      assertTrue(!bryggeriText.includes("Sørlandsk Vingård"),
        "e4: …and EXCLUDES the winery, even though both share the beverages category");

      const onlyVingard = await discover.handler({
        categories: ["beverages"], drinkSubcategory: "vingård", limit: 10,
      });
      const vingardText = textOf(onlyVingard);
      assertTrue(vingardText.includes("Sørlandsk Vingård"), "e5: drinkSubcategory:'vingård' includes the winery");
      assertTrue(!vingardText.includes("Ruteøl Bryggeri"), "e6: …and excludes the brewery");

      // No matches for a subcategory with zero seeded rows -> the honest
      // "ingen produsenter" text, not an error.
      const noMjod = await discover.handler({
        categories: ["beverages"], drinkSubcategory: "mjød", limit: 10,
      });
      assertTrue(textOf(noMjod).includes("Ingen produsenter"),
        "e7: a subcategory with zero real matches returns the honest empty-result text");
    }

    // ══════════════════════════════════════════════════════════════
    // marketplaceRegistry.discover() directly — the same call
    // routes/marketplace.ts's POST /discover (REST API) makes.
    // ══════════════════════════════════════════════════════════════
    const restStyle = marketplaceRegistry.discover({
      role: "producer", categories: ["beverages"], drinkSubcategory: "bryggeri",
    } as any);
    assertEq(restStyle.map((r) => r.agent.id).sort(), ["d-bryggeri"],
      "rest1: discover() with drinkSubcategory filters to exactly the brewery row");

    const restStyleAll = marketplaceRegistry.discover({
      role: "producer", categories: ["beverages"],
    } as any);
    assertEq(restStyleAll.map((r) => r.agent.id).sort(), ["d-bryggeri", "d-vingard"],
      "rest2: discover() WITHOUT drinkSubcategory returns both drink rows (unchanged pre-existing behaviour)");

    const restStyleBadSub = marketplaceRegistry.discover({
      role: "producer", categories: ["beverages"], drinkSubcategory: "not-a-real-subcategory",
    } as any);
    assertEq(restStyleBadSub.length, 0,
      "rest3: an unrecognised drinkSubcategory value matches nothing (never a schema error, matching how an unrecognised category already behaves)");
  } finally {
    console.log = prevLog;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runDrinkSubcategoryMcpTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log("  " + f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

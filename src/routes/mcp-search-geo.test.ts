/**
 * mcp-search-geo.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 0g.
 *
 * 0g(i)  `lokal_search` — THE tool AI assistants actually call — had no way to
 *        receive the user's position: its inputSchema was {query, limit} only
 *        (src/routes/mcp.ts). An assistant that knew exactly where the user
 *        was could not tell us, so every "nearest farm shop" question was
 *        answered from a place NAME guessed out of the text, or nationwide.
 *
 * 0g(ii) SECURITY — `lokal_search` and `lokal_discover` both declare
 *        `readOnlyHint: true`, yet both auto-started up to 2 seller
 *        conversations per call. An AI exploring on a traveller's behalf
 *        silently opened conversations with farmers. Read-only must mean
 *        read-only.
 *
 * registerTools() is exercised through a duck-typed server that captures each
 * tool's config + handler — no transport, no session, no HTTP. The DB is the
 * real production schema in memory, so "no conversation was written" is
 * asserted against the actual `conversations` table.
 *
 * Exported runMcpSearchGeoTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-search-geo.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: any;
  handler: (args: any, extra?: any) => Promise<any>;
}

const LYNGDAL = { lat: 58.1376, lng: 7.0700 };

const SEED = [
  { id: "m-near",  name: "Lyngdal Gårdsmat", city: "Lyngdal",  lat: 58.1376, lng: 7.0700,  trust: 0.40 },
  { id: "m-near2", name: "Mandal Honning",   city: "Mandal",   lat: 58.0268, lng: 7.4535,  trust: 0.50 },
  { id: "m-far",   name: "Tromsø Sjømat",    city: "Tromsø",   lat: 69.6496, lng: 18.9560, trust: 0.95 },
];

function seedAgents(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, '["honey"]', '[]', '[]', '{}', '["no"]',
            ?, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  const know = db.prepare(`
    INSERT OR REPLACE INTO agent_knowledge (agent_id, address, phone, email, website, about, products)
    VALUES (?, ?, '91234567', ?, ?, 'Lokal produsent av kortreist mat i Norge, drevet av samme familie i tre generasjoner.', ?)
  `);
  for (const a of SEED) {
    stmt.run(a.id, a.name, "Lokal produsent", "test", `${a.id}@example.no`,
      `https://${a.id}.example.no`, "key-" + a.id, a.lat, a.lng, a.city, a.trust);
    know.run(a.id, `${a.city}veien 1`, `${a.id}@example.no`, `https://${a.id}.example.no`,
      JSON.stringify([{ name: "Honning", price: "99 kr" }, { name: "Egg", price: "45 kr" }]));
  }
}

export async function runMcpSearchGeoTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // Put the singleton back when we are done, so blocks that run after this
  // suite are not left reading our throwaway in-memory DB.
  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seedAgents(db);

  // No Kartverket calls: every lookup 404s, so any geo in these tests can only
  // come from the coordinates the caller passed in.
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
      // registerTools() also registers MCP resources/prompts; we only care
      // about tools here, so those are no-ops.
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    };
    registerTools(fakeServer, () => "test-client", () => undefined);

    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
    const convCount = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;

    // ══════════════════════════════════════════════════════════════
    // 0g(i) — lokal_search exposes lat / lng / radius_km
    // ══════════════════════════════════════════════════════════════
    const search = tools.get("lokal_search");
    assertTrue(!!search, "0g(i): lokal_search is registered");
    if (search) {
      const schema = search.config.inputSchema || {};
      assertTrue("lat" in schema, "0g(i): lokal_search inputSchema exposes `lat`");
      assertTrue("lng" in schema, "0g(i): lokal_search inputSchema exposes `lng`");
      assertTrue("radius_km" in schema, "0g(i): lokal_search inputSchema exposes `radius_km`");
      assertTrue("query" in schema && "limit" in schema,
        "0g(i): the original query/limit inputs are still there");

      const desc = String(search.config.description || "");
      assertTrue(/near me|nær meg/i.test(desc),
        "0g(i): the description mentions proximity/'near me' so models select the tool for it");
      assertTrue(/lat/.test(desc),
        "0g(i): the description tells the model to pass lat/lng when it knows them");

      // Coordinates actually filter.
      const r = await search.handler({ query: "", lat: LYNGDAL.lat, lng: LYNGDAL.lng, radius_km: 60, limit: 10 });
      const txt = textOf(r);
      assertTrue(/Lyngdal Gårdsmat/.test(txt), `0g(i): the nearby producer is returned (got: ${txt.slice(0, 160)})`);
      assertTrue(!/Tromsø Sjømat/.test(txt),
        "0g(i): the 1 500 km-away producer is filtered out even though it has the highest trust score");
      assertTrue(/km/.test(txt), "0g(i): the output carries real distances");

      // An empty query + coordinates is a valid "what is near me" call.
      assertTrue(!/Oppgi enten/.test(txt), "0g(i): an empty query with coordinates is accepted, not rejected");

      // radius_km narrows.
      const tight = textOf(await search.handler({ query: "", lat: LYNGDAL.lat, lng: LYNGDAL.lng, radius_km: 5, limit: 10 }));
      assertTrue(!/Mandal Honning/.test(tight),
        `0g(i): radius_km=5 excludes the 25 km-away producer (got: ${tight.slice(0, 160)})`);

      // Neither query nor coordinates → an actionable message, not a crash.
      const none = textOf(await search.handler({ query: "", limit: 10 }));
      assertTrue(/Oppgi enten/.test(none), "0g(i): no query and no coordinates → an actionable message");

      // fix 0e over MCP: proximity intent with no position asks for one.
      const nearMe = textOf(await search.handler({ query: "nær meg", limit: 10 }));
      assertTrue(/lat/.test(nearMe) && /lng/.test(nearMe),
        `0g(i)/0e: 'nær meg' with no position tells the assistant to supply lat/lng (got: ${nearMe.slice(0, 160)})`);
      assertTrue(!/Tromsø Sjømat/.test(nearMe),
        "0g(i)/0e: …instead of silently answering with a nationwide trust-ranked list");
    }

    // ══════════════════════════════════════════════════════════════
    // 0g(ii) — read-only tools must not write
    // ══════════════════════════════════════════════════════════════
    for (const name of ["lokal_search", "lokal_discover"]) {
      const tool = tools.get(name);
      assertTrue(!!tool, `0g(ii): ${name} is registered`);
      if (!tool) continue;
      assertEq(tool.config.annotations?.readOnlyHint, true, `0g(ii): ${name} declares readOnlyHint:true`);
    }
    // Absolute, not relative: after EVERY read-only call this suite has made
    // (all the 0g(i) searches above included), the conversations table must
    // still be empty. On origin/main it holds one row per top-2 match per call.
    {
      const r = await tools.get("lokal_search")!.handler({ query: "honning", limit: 10 });
      assertTrue(/Lyngdal Gårdsmat/.test(textOf(r)), "0g(ii): lokal_search still returns real producers");
      assertTrue(!/Samtaler startet automatisk/.test(textOf(r)),
        "0g(ii): lokal_search no longer advertises auto-started conversations");
    }
    {
      const r = await tools.get("lokal_discover")!.handler({ categories: ["honey"], limit: 10 });
      assertTrue(/Lyngdal Gårdsmat/.test(textOf(r)), "0g(ii): lokal_discover still returns real producers");
      assertTrue(!/Samtaler startet automatisk/.test(textOf(r)),
        "0g(ii): lokal_discover no longer advertises auto-started conversations");
    }
    assertEq(convCount(), 0,
      "0g(ii): ZERO conversation rows exist after every read-only-declared tool call in this suite");
    {
      const msgs = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
      assertEq(msgs, 0, "0g(ii): no conversation MESSAGES were written either");
    }
    {
      // The read-only tools now point the assistant at the explicit write path
      // instead of taking it silently.
      const r = await tools.get("lokal_search")!.handler({ query: "honning", limit: 10 });
      const txt = textOf(r);
      assertTrue(/m-near@example\.no/.test(txt),
        "0g(ii): the output still hands the user the producer's own contact details to act on");
      assertTrue(/lokal_info/.test(txt),
        "0g(ii): …and still points at the follow-up tool for the full price list");
    }
  } finally {
    console.log = prevLog;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    // Restore the singleton, but deliberately do NOT db.close() — nothing
    // else in the process owns this handle, and closing it would break any
    // straggler that captured it mid-run.
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runMcpSearchGeoTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

/**
 * mcp-find-offers.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 0.
 *
 * Proves the `lokal_find_offers` MCP tool (src/routes/mcp.ts):
 *   - registered, read-only.
 *   - one findOffers() result per item in `items`, same JSON shape as
 *     GET /api/marketplace/catalog/offers.
 *   - errors when neither `near` nor `lat`+`lng` is given.
 *
 * Harness mirrors mcp-search-geo.test.ts: registerTools() exercised through
 * a duck-typed server (no transport/session), real production schema in
 * memory.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/mcp-find-offers.test.ts
 *   2. Wired into tests/test.ts.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: any;
  handler: (args: any, extra?: any) => Promise<any>;
}

const OSLO_NEAR = { lat: 59.9289, lng: 10.7522 };

function seedAgent(db: Database.Database, id: string, productName: string) {
  db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, role, api_key,
       lat, lng, city, is_active, is_verified, order_notifications_opt_in)
    VALUES (?, ?, 'test', 'test', ?, 'https://example.com', 'producer', ?,
            ?, ?, 'Oslo', 1, 1, 1)
  `).run(id, `${id} Gård`, `${id}@example.com`, `key-${id}`, OSLO_NEAR.lat, OSLO_NEAR.lng);
  db.prepare(`
    INSERT INTO agent_knowledge (agent_id, verification_status)
    VALUES (?, 'verified')
  `).run(id);
  db.prepare(`
    INSERT INTO products (id, agent_id, name, name_norm, price_nok)
    VALUES (?, ?, ?, ?, ?)
  `).run(`prod-${id}`, id, productName, productName.toLowerCase(), 30);
}

export async function runMcpFindOffersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  seedAgent(db, "mfo-poteter", "Poteter");
  seedAgent(db, "mfo-honning", "Honning");

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

    const tool = tools.get("lokal_find_offers");
    assertTrue(!!tool, "lokal_find_offers is registered");
    if (!tool) return { passed, failed, failures };

    assertEq(tool.config.annotations?.readOnlyHint, true, "lokal_find_offers declares readOnlyHint:true");

    const schema = tool.config.inputSchema || {};
    assertTrue("items" in schema, "inputSchema exposes `items`");
    assertTrue("near" in schema, "inputSchema exposes `near`");
    assertTrue("lat" in schema && "lng" in schema, "inputSchema exposes `lat`/`lng`");
    assertTrue("radius_km" in schema, "inputSchema exposes `radius_km`");

    // No position at all → an actionable message, not a crash.
    const none = await tool.handler({ items: ["poteter"] });
    const noneText = String(none?.content?.[0]?.text ?? "");
    assertTrue(/Oppgi enten|Supply either/.test(noneText), "no position: actionable message, not a crash");

    // One result per item, same shape as the REST endpoint.
    const r = await tool.handler({ items: ["poteter", "honning"], lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, radius_km: 5 });
    const text = String(r?.content?.[0]?.text ?? "");
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    assertTrue(Array.isArray(parsed), "result: JSON-parseable array (one entry per item)");
    if (Array.isArray(parsed)) {
      assertEq(parsed.length, 2, `result: one entry per item (got ${parsed.length})`);
      assertEq(parsed[0].term, "poteter", "result[0].term echoes items[0]");
      assertEq(parsed[1].term, "honning", "result[1].term echoes items[1]");
      const potetOffer = parsed[0].offers.find((o: any) => o.producer.agent_id === "mfo-poteter");
      assertTrue(!!potetOffer, "result[0].offers includes the matching nearby producer");
      const honningOffer = parsed[1].offers.find((o: any) => o.producer.agent_id === "mfo-honning");
      assertTrue(!!honningOffer, "result[1].offers includes the matching nearby producer");
      // Cross-check: poteter search must not surface the honning-only producer.
      const wrongMatch = parsed[0].offers.find((o: any) => o.producer.agent_id === "mfo-honning");
      assertTrue(!wrongMatch, "result[0].offers does not include the unrelated honning producer");
    }
  } finally {
    console.log = prevLog;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMcpFindOffersTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

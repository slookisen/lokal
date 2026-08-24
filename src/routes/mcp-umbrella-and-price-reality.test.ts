/**
 * mcp-umbrella-and-price-reality.test.ts — dev-request
 * 2026-08-24-rfb-mcp-verktoybeskrivelser-vs-virkelighet.
 *
 * Funn A: `lokal_get_umbrella_members` requires `umbrellaId` (its own
 *   description says "Use lokal_list_umbrellas to find IDs"), but
 *   `lokal_list_umbrellas` never rendered the `id` it already SELECTed —
 *   so the two-step list -> members chain a model is told to use could
 *   never actually complete. Fix: expose the existing agents.id (already a
 *   UUID) in the list output; no new identifier scheme, no schema change to
 *   lokal_get_umbrella_members's input validation.
 *
 * Funn B: `lokal_info` / `lokal_search` tool descriptions promised a
 *   guaranteed "full price list" / "exact prices in NOK" for every product,
 *   but prices are free text embedded in the product name and present for
 *   only a small minority of listings. Fix: reword both descriptions to say
 *   price is included only when the producer wrote one into the listing
 *   text — no guarantee.
 *
 * Same duck-typed-server harness as mcp-search-geo.test.ts: registerTools()
 * is exercised with a fake server that just captures each tool's config +
 * handler, against the real production schema in an in-memory DB.
 *
 * Exported runMcpUmbrellaAndPriceRealityTests({log}) -> TestSummary; wired
 * into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-umbrella-and-price-reality.test.ts
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

function seedUmbrellaAndMembers(db: Database.Database): { umbrellaId: string; producerId: string } {
  const umbrellaId = "11111111-1111-4111-8111-111111111111";
  const producerId = "22222222-2222-4222-8222-222222222222";

  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at,
       umbrella_type, umbrella_member_count)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', ?, ?,
            ?, '[]', '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'),
            ?, ?)
  `);
  agentStmt.run(
    umbrellaId, "Bondens marked Oslo", "Markedsnettverk", `${umbrellaId}@example.no`,
    `https://${umbrellaId}.example.no`, "producer", "key-" + umbrellaId,
    "Oslo", "market_network", 1
  );
  agentStmt.run(
    producerId, "Lyngdal Gårdsmat", "Lokal produsent", `${producerId}@example.no`,
    `https://${producerId}.example.no`, "producer", "key-" + producerId,
    "Lyngdal", null, null
  );

  db.prepare(`
    INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source, labels, created_at)
    VALUES (?, ?, 'active', 'admin', '[]', datetime('now'))
  `).run(producerId, umbrellaId);

  return { umbrellaId, producerId };
}

export async function runMcpUmbrellaAndPriceRealityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  const { umbrellaId, producerId } = seedUmbrellaAndMembers(db);

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
    // Funn A — real two-step lokal_list_umbrellas -> lokal_get_umbrella_members
    // ══════════════════════════════════════════════════════════════
    const listUmbrellas = tools.get("lokal_list_umbrellas");
    const getMembers = tools.get("lokal_get_umbrella_members");
    assertTrue(!!listUmbrellas, "Funn A: lokal_list_umbrellas is registered");
    assertTrue(!!getMembers, "Funn A: lokal_get_umbrella_members is registered");

    if (listUmbrellas && getMembers) {
      const listResult = await listUmbrellas.handler({ limit: 200 });
      const listText = textOf(listResult);
      assertTrue(/Bondens marked Oslo/.test(listText), "Funn A: the seeded umbrella appears in the list");

      // Extract the umbrellaId the tool actually rendered for that row —
      // this is the crux of the bug: `id` was SELECTed in the SQL all along
      // but never made it into the response text.
      const idMatch = listText.match(/umbrellaId:\s*(\S+)/);
      assertTrue(!!idMatch, `Funn A: lokal_list_umbrellas renders a per-row umbrellaId (got: ${listText.slice(0, 300)})`);

      if (idMatch) {
        const exposedId = idMatch[1];
        assertTrue(exposedId === umbrellaId,
          `Funn A: the exposed id is the umbrella's real, existing agents.id (expected ${umbrellaId}, got ${exposedId})`);

        // The real two-step chain: feed the id straight from step 1 into step 2.
        const membersResult = await getMembers.handler({ umbrellaId: exposedId, limit: 100 });
        const membersText = textOf(membersResult);
        assertTrue(!/Fant ingen paraply/.test(membersText),
          `Funn A: lokal_get_umbrella_members accepts the id lokal_list_umbrellas just gave it (got: ${membersText.slice(0, 200)})`);
        assertTrue(/Lyngdal Gårdsmat/.test(membersText),
          "Funn A: the two-step chain surfaces the real affiliated producer end-to-end");
      }

      // Regression guard: the previously-unreachable failure mode from the
      // dev-request (passing a slug/name instead of the UUID) still fails
      // cleanly rather than crashing — it's the id that's newly exposed,
      // not a relaxation of what lokal_get_umbrella_members accepts.
      const bySlug = textOf(await getMembers.handler({ umbrellaId: "bondens-marked-oslo", limit: 100 }));
      assertTrue(/Fant ingen paraply/.test(bySlug),
        "Funn A: a slug still isn't accepted — the fix is exposing the real id, not loosening validation");
    }

    // ══════════════════════════════════════════════════════════════
    // Funn B — tool descriptions no longer overpromise price data
    // ══════════════════════════════════════════════════════════════
    const search = tools.get("lokal_search");
    const info = tools.get("lokal_info");
    assertTrue(!!search, "Funn B: lokal_search is registered");
    assertTrue(!!info, "Funn B: lokal_info is registered");

    if (search) {
      const desc = String(search.config.description || "");
      assertTrue(!/complete product catalog with current prices/i.test(desc),
        "Funn B: lokal_search no longer claims a complete catalog with current prices");
      assertTrue(!/full product list with prices/i.test(desc),
        "Funn B: lokal_search no longer promises the full product list has prices");
      assertTrue(/when the producer/i.test(desc) || /only where the producer/i.test(desc),
        `Funn B: lokal_search description conditions price on the producer having provided it (got: ${desc})`);
    }

    if (info) {
      const desc = String(info.config.description || "");
      assertTrue(!/full price list/i.test(desc),
        "Funn B: lokal_info no longer promises 'the full price list'");
      assertTrue(!/exact prices in NOK/i.test(desc),
        "Funn B: lokal_info no longer guarantees 'exact prices in NOK'");
      assertTrue(/most producers do not list exact prices/i.test(desc) || /price included when the producer/i.test(desc),
        `Funn B: lokal_info description is honest about partial price coverage (got: ${desc})`);
    }
  } finally {
    console.log = prevLog;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runMcpUmbrellaAndPriceRealityTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

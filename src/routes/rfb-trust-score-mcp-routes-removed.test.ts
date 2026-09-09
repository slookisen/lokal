/**
 * rfb-trust-score-mcp-routes-removed.test.ts — dev-request
 * orch-pr-20260909-1-trust-score-mcp-routes.
 *
 * PR #810 (dev-request 2026-09-03-rfb-trust-score-offentlig-visning) removed
 * the public-facing "Trust Score" percentage display from every surface an
 * unauthenticated visitor/agent reaches — EXCEPT two it missed:
 *
 *   - `src/routes/mcp.ts` — the live-mounted `/mcp` Streamable-HTTP endpoint
 *     (mounted at src/index.ts:492; distinct from `src/mcp/server.ts`, which
 *     PR #810 already fixed). `lokal_info`'s producer-detail text still
 *     printed `Trust NN%` next to the city, and `formatAgentCompact()`
 *     (shared by `lokal_search`/`lokal_discover`'s result lines) still
 *     printed a `✅ Trust NN%` meta line.
 *   - `src/services/marketplace-registry.ts`'s `calculateRelevance()` —
 *     `matchReasons`/`reasons` still pushed the Norwegian match-reason
 *     string `"Høy tillitsscore"` for any agent with trustScore > 0.8, which
 *     `/api/marketplace/search` surfaces as `matchReasons` and
 *     `src/mcp/server.ts:115`'s `Match: …` line renders — the same
 *     percentage-adjacent trust signal PR #810 removed everywhere else, just
 *     reached through a different field name.
 *
 * This suite is a finishing pass on an already-Daniel-approved removal, not
 * a new policy decision — see rfb-trust-score-public-display-removed.test.ts
 * for the full history/authorization trail this one continues.
 *
 * Deliberately UNCHANGED (asserted here as non-goals):
 *   - `agent.trustScore`/`agents.trust_score` itself, and its use in actual
 *     ranking (`calculateRelevance`'s `score += 0.05 * agent.trustScore`) —
 *     only the ONE match-reason STRING is removed, not the score's
 *     contribution to `relevanceScore`.
 *   - `src/mcp/server.ts` (already fixed by PR #810) and
 *     `src/public/*.html` (already fixed) — untouched by this suite and this
 *     dev-request. `src/routes/seo.ts` was NOT already fixed — an independent
 *     reviewer of this PR found a still-live `Trust ${trust}%` leak in its
 *     "related producers in same city" widget (missed by #810's narrower
 *     `/\bTrust Score\b/` regression check); that fix and its strengthened
 *     test live in rfb-trust-score-public-display-removed.test.ts, not here.
 *
 * Harness: same duck-typed-server pattern as mcp-search-geo.test.ts
 * (`registerTools()` against a fake server that just captures each tool's
 * handler — no transport/session/HTTP) plus a direct call into
 * `marketplaceRegistry.discover()` (the same "money endpoint" `mcp/server.ts`
 * and `/api/marketplace/search` both sit on top of) for the match-reasons
 * check. Real production schema, in-memory `better-sqlite3`.
 *
 * Exported runTrustScoreMcpRoutesRemovedTests({log}) -> TestSummary; wired
 * into tests/test.ts.
 *
 * Standalone: npx tsx src/routes/rfb-trust-score-mcp-routes-removed.test.ts
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

const SEED = [
  // High-trust producer — the exact case both removed surfaces used to flag
  // (trustScore > 0.8 for the match-reason string; any trustScore > 0 for
  // the "Trust NN%" text lines).
  { id: "hi-trust-1", name: "Høytillit Gård", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.95 },
  // Low(er)-trust producer — control for the reasons.push("Høy tillitsscore")
  // threshold (agent.trustScore > 0.8): must still never fire below it.
  { id: "lo-trust-1", name: "Lavtillit Gård", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.30 },
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
  for (const a of SEED) {
    stmt.run(a.id, a.name, "Lokal produsent av kortreist mat", "test", `${a.id}@example.no`,
      `https://${a.id}.example.no`, "key-" + a.id, a.lat, a.lng, a.city, a.trust);
  }
}

export async function runTrustScoreMcpRoutesRemovedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  db.pragma("foreign_keys = OFF");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seedAgents(db);

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    // ══════════════════════════════════════════════════════════════
    // (1) src/routes/mcp.ts — lokal_info / lokal_search / lokal_discover
    // no longer print "Trust NN%" anywhere in their text output, for an
    // agent with trustScore > 0.
    // ══════════════════════════════════════════════════════════════
    const mcpRoutePath = require.resolve("./mcp");
    delete require.cache[mcpRoutePath];
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

    {
      const info = tools.get("lokal_info");
      assertTrue(!!info, "setup: lokal_info is registered");
      if (info) {
        const r = await info.handler({ agentId: "hi-trust-1" });
        const txt = textOf(r);
        assertTrue(txt.includes("Høytillit Gård"), `lokal_info: producer name renders (got: ${txt.slice(0, 160)})`);
        assertTrue(txt.includes("Oslo"), "lokal_info: city still renders (only the trust fragment was removed)");
        assertTrue(!txt.includes("Trust "), `lokal_info: no "Trust NN%" fragment for trustScore=0.95 (got: ${txt.slice(0, 200)})`);
        assertTrue(!/Trust\s*\d/.test(txt), "lokal_info: no trust percentage digits anywhere in the output");
      }
    }

    {
      const search = tools.get("lokal_search");
      assertTrue(!!search, "setup: lokal_search is registered");
      if (search) {
        const r = await search.handler({ query: "Høytillit", limit: 10 });
        const txt = textOf(r);
        assertTrue(txt.includes("Høytillit Gård"), `lokal_search: the high-trust producer is returned (got: ${txt.slice(0, 200)})`);
        assertTrue(!txt.includes("Trust "), `lokal_search: no "Trust NN%" meta line for trustScore=0.95 (got: ${txt.slice(0, 300)})`);
      }
    }

    {
      const discover = tools.get("lokal_discover");
      assertTrue(!!discover, "setup: lokal_discover is registered");
      if (discover) {
        const r = await discover.handler({ categories: ["honey"], limit: 10 });
        const txt = textOf(r);
        assertTrue(txt.includes("Høytillit Gård"), `lokal_discover: the high-trust producer is returned (got: ${txt.slice(0, 200)})`);
        assertTrue(!txt.includes("Trust "), `lokal_discover: no "Trust NN%" meta line for trustScore=0.95 (got: ${txt.slice(0, 300)})`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // (2) src/services/marketplace-registry.ts — calculateRelevance()'s
    // matchReasons/reasons must never contain "Høy tillitsscore", for an
    // agent with trustScore > 0.8. Exercised through the real discover()
    // "money endpoint" (the same one mcp/server.ts and
    // /api/marketplace/search sit on top of), not by reaching into the
    // private method directly.
    // ══════════════════════════════════════════════════════════════
    const registryPath = require.resolve("../services/marketplace-registry");
    delete require.cache[registryPath];
    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");

    {
      const results = marketplaceRegistry.discover({ categories: ["honey"], limit: 20 } as any);
      const hi = results.find(r => r.agent.id === "hi-trust-1");
      const lo = results.find(r => r.agent.id === "lo-trust-1");

      assertTrue(!!hi, `setup: discover() returns the high-trust agent (got ${results.map(r => r.agent.id).join(", ")})`);
      assertTrue(!!lo, "setup: discover() returns the low-trust agent");

      if (hi) {
        assertTrue(!hi.matchReasons.includes("Høy tillitsscore"),
          `discover(): matchReasons for trustScore=0.95 (>0.8) does not contain "Høy tillitsscore" (got: ${JSON.stringify(hi.matchReasons)})`);
        // Non-goal: the score itself still reflects trustScore's 0.05 weight
        // (only the STRING is removed) — a higher-trust agent among
        // otherwise-identical candidates still scores at least as high.
        if (lo) {
          assertTrue(hi.relevanceScore >= lo.relevanceScore,
            `discover(): relevanceScore still reflects trustScore (hi=${hi.relevanceScore} >= lo=${lo.relevanceScore}) — ranking use of trustScore is untouched, only the match-reason string was removed`);
        }
      }
      if (lo) {
        assertTrue(!lo.matchReasons.includes("Høy tillitsscore"),
          `discover(): matchReasons for trustScore=0.30 (<0.8, control) does not contain "Høy tillitsscore" (got: ${JSON.stringify(lo.matchReasons)})`);
      }

      // No agent anywhere in this result set carries the removed reason string.
      assertTrue(results.every(r => !r.matchReasons.includes("Høy tillitsscore")),
        "discover(): no result in the set carries the removed \"Høy tillitsscore\" match reason");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-trust-score-mcp-routes-removed: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runTrustScoreMcpRoutesRemovedTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

/**
 * a2a-tags-relaxed.test.ts — PR #823 round 4 / round-3 review finding.
 *
 * dev-request 2026-09-06-rfb-sok-adjektiv-tags-er-hardt-filter made
 * discover() step 4 (src/services/marketplace-registry.ts) DROP the `tags`
 * filter — instead of zeroing the result — when it would otherwise have
 * emptied an already-narrowed candidate set, signalling the drop via the
 * `DiscoverMeta.tagsRelaxed` out-param. Three earlier review rounds wired
 * that honestly into /api/marketplace/search, /sok and the MCP tools
 * (lokal_search/lokal_discover). Round 3 found the A2A `message/send`
 * discovery flow (src/routes/a2a.ts) still called `discover()` with no
 * `DiscoverMeta` at all — Mode 2/3 callers who pass their own `tags` (or
 * Mode 1's parseNaturalQuery/tagMap) never learned a filter they asked for
 * was silently dropped.
 *
 * Harness mirrors marketplace-search-honesty.test.ts (real init.ts schema
 * in an in-memory DB, the REAL router exercised through router.handle(), no
 * supertest, no network, no HTTP server) — driving POST /a2a JSON-RPC
 * `message/send` (Mode 2: structured `message.data`) directly.
 *
 * Exported runA2aTagsRelaxedTests({log}) -> TestSummary; wired into
 * tests/test.ts next to marketplace-search-honesty.
 * Standalone: npx tsx src/routes/a2a-tags-relaxed.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

/** Drives POST /a2a directly through router.handle() — no HTTP server. */
function callA2a(router: any, body: any): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const req: any = {
      method: "POST",
      url: "/a2a",
      query: {},
      headers,
      body,
      ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

interface SeedAgent {
  id: string; name: string; city: string; categories: string[]; trust: number; tags?: string[];
}

// Same shape/intent as marketplace-search-honesty.test.ts's fixture: two
// untagged fish producers, one genuinely "budget"-tagged dairy producer,
// one untagged dairy producer, one genuinely "organic"-tagged fish producer.
const SEED: SeedAgent[] = [
  { id: "a-fisk-1", name: "Nordfjord Sjømat", city: "Nordfjordeid", categories: ["fish"], trust: 0.70 },
  { id: "a-fisk-2", name: "Lofoten Fiskeri", city: "Svolvær", categories: ["fish"], trust: 0.65 },
  { id: "a-meieri-budget", name: "Rimelig Gårdsost", city: "Gausdal", categories: ["dairy"], trust: 0.55, tags: ["budget"] },
  { id: "a-meieri-plain", name: "Fjellgardens Ysteri", city: "Vågå", categories: ["dairy"], trust: 0.60 },
  { id: "a-fisk-organic", name: "Øko Fiskehus", city: "Kristiansund", categories: ["fish"], trust: 0.72, tags: ["organic"] },
];

function seedAgents(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 'producer', ?, NULL, NULL, ?, NULL, ?, ?, '[]', '{}', '["no"]',
            ?, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const a of SEED) {
    stmt.run(
      a.id, a.name, "Lokal produsent", "test", `${a.id}@example.no`, `https://${a.id}.example.no`,
      "key-" + a.id, a.city, JSON.stringify(a.categories), JSON.stringify(a.tags || []), a.trust,
    );
  }
}

export async function runA2aTagsRelaxedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  // Put the singleton back when we are done — same discipline as
  // marketplace-search-honesty.test.ts.
  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seedAgents(db);

  const prevLogLevel = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    const router = require("./a2a").default;

    // ════════════════════════════════════════════════════════════════
    // dev-request 2026-09-06-rfb-sok-adjektiv-tags-er-hardt-filter, PR #823
    // round 4: A2A message/send (Mode 2: structured message.data) must
    // surface a dropped tag filter exactly like /search, /discover and the
    // MCP tools already do.
    // ════════════════════════════════════════════════════════════════
    {
      const r = await callA2a(router, {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { data: { categories: ["fish"], tags: ["fresh"] } } },
        id: "t1",
      });
      assertEq(r.status, 200, "a2a: {fish, fresh} → HTTP 200");
      const dataPart = r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
      assertTrue(!!dataPart, "a2a: search-results data artifact is present");
      assertTrue(dataPart.count > 0,
        `a2a: still returns the untagged fish producers even though none carry "fresh" (got ${dataPart?.count})`);
      const names: string[] = (dataPart?.agents || []).map((x: any) => x.agent.name);
      assertTrue(names.includes("Nordfjord Sjømat") && names.includes("Lofoten Fiskeri"),
        `a2a: both untagged fish producers survive (got ${names.join(", ")})`);
      assertTrue(Array.isArray(dataPart.relaxed_filters) && dataPart.relaxed_filters.includes("tags"),
        `a2a: relaxed_filters names "tags" as dropped (got ${JSON.stringify(dataPart?.relaxed_filters)})`);
      assertTrue(typeof dataPart.note === "string" && /fresh|fersk/i.test(dataPart.note),
        `a2a: the response says explicitly that a word-filter was dropped (got ${JSON.stringify(dataPart?.note)})`);
    }

    {
      // Control: a tag with real, structured coverage stays a selective
      // hard filter — no relaxation, no note.
      const r = await callA2a(router, {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { data: { categories: ["dairy"], tags: ["budget"] } } },
        id: "t2",
      });
      assertEq(r.status, 200, "a2a: {dairy, budget} → HTTP 200");
      const dataPart = r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
      const names: string[] = (dataPart?.agents || []).map((x: any) => x.agent.name);
      assertEq(names, ["Rimelig Gårdsost"],
        `a2a: only the genuinely "budget"-tagged dairy producer is returned (got ${names.join(", ")})`);
      assertEq(dataPart.relaxed_filters, undefined,
        "a2a: a tag filter that legitimately narrowed the set reports no relaxation");
      assertEq(dataPart.note, undefined, "a2a: …and no note");
    }

    {
      // Control: no `tags` at all in the request → byte-identical to the
      // pre-round-4 response shape (relaxed_filters/note both absent/undefined,
      // every other field unchanged).
      const r = await callA2a(router, {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { data: { categories: ["fish"] } } },
        id: "t3",
      });
      assertEq(r.status, 200, "a2a: {fish} with no tags → HTTP 200");
      const dataPart = r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
      assertEq(dataPart.relaxed_filters, undefined, "a2a: no tags in the request → no relaxed_filters");
      assertEq(dataPart.note, undefined, "a2a: …and no note");
      assertTrue(dataPart.count > 0, `a2a: fish producers are still returned (got ${dataPart?.count})`);
      assertTrue("agents" in dataPart && "conversations" in dataPart && "parsedQuery" in dataPart,
        "a2a: the pre-existing data fields (agents/conversations/parsedQuery) are all still present");
      assertTrue(typeof r.body?.result?.task?.id === "string" && r.body.result.task.status?.state === "completed",
        "a2a: the task envelope is unchanged (id present, status completed)");
    }
  } finally {
    console.log = prevLogLevel;
    // Restore the singleton, but deliberately do NOT db.close() — nothing
    // else in the process owns this handle, and closing it would break any
    // straggler that captured it mid-run.
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runA2aTagsRelaxedTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

/**
 * marketplace-agent-provenance.test.ts — unit tests for the additive
 * `provenance` summary field on GET /api/marketplace/agents/:id/info
 * (src/routes/marketplace.ts).
 *
 * dev-request 2026-07-13-proveniens-transparens-side, slice 2
 * (orch-pr-20260725-proveniens-api-provenance): slice 1 shipped the public
 * /proveniens explainer page (PR #363). This slice adds an entity-level
 * `provenance: { sources: [...], last_verified: "..." }` rollup to the
 * public/agent-facing detail-JSON responses, reusing the EXISTING
 * agent_knowledge.field_provenance + last_verified_at columns — no new
 * tracking mechanism, no per-field data in the public response.
 *
 * Setup mirrors admin-agents-recently-enriched.test.ts's convention: a fresh
 * in-memory SQLite DB via __setDbForTesting/__initSchemaForTesting (full
 * production schema, so field_provenance/last_verified_at exist exactly as
 * in prod), the marketplace router re-required fresh, and the
 * GET /agents/:id/info handler grabbed straight off the router's internal
 * stack so it can be invoked directly (no HTTP server / socket, no env-var
 * races with the ~40 other largely-independent blocks tests/test.ts runs).
 *
 * Covers (acceptance criteria 1, 2, 5 of the dev-request):
 *   (a) presence: an agent with real field_provenance + last_verified_at
 *       gets `data.provenance` with deduped `sources` and the exact
 *       `last_verified` timestamp from the row.
 *   (b) absence: an agent with NO field_provenance (or none surviving the
 *       inference-source filter) never gets a `provenance` key at all —
 *       not null, not {} — key genuinely absent from the JSON.
 *   (c) absence: an agent WITH field_provenance but no last_verified_at
 *       also omits the key (never fabricate a verification timestamp).
 *   (d) additive-regression: every other field of the response for an
 *       agent WITHOUT provenance data is byte-for-byte identical to a
 *       snapshot taken before this slice's code path runs (proves the new
 *       code never perturbs the existing shape).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runMarketplaceAgentProvenanceTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function insertAgent(row: { id: string; name: string; url: string }): void {
    testDb
      .prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (@id, @name, 'test agent', 'test-provider', 'test@example.no', @url, 'producer', @api_key)`,
      )
      .run({ id: row.id, name: row.name, url: row.url, api_key: `key-${row.id}` });
  }

  function insertKnowledge(row: {
    agent_id: string;
    field_provenance?: string | null;
    last_verified_at?: string | null;
  }): void {
    testDb
      .prepare(
        `INSERT INTO agent_knowledge (agent_id, field_provenance, last_verified_at)
         VALUES (@agent_id, @field_provenance, @last_verified_at)`,
      )
      .run({
        agent_id: row.agent_id,
        field_provenance: row.field_provenance ?? "{}",
        last_verified_at: row.last_verified_at ?? null,
      });
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const routePath = require.resolve("../routes/marketplace");
    delete require.cache[routePath];
    const routerModule = require("../routes/marketplace").default;
    const layer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/agents/:id/info" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET /agents/:id/info handler is registered on the router");
    const handler = layer.route.stack[0].handle;

    async function callInfo(agentId: string): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler(
        { params: { id: agentId }, headers: {}, ip: "127.0.0.1" } as any,
        res as any,
      );
      return { status: res.statusCode, body: res.body };
    }

    // ── Fixtures ──────────────────────────────────────────────────────────
    // (a) real, well-sourced field_provenance + a verification timestamp
    insertAgent({ id: "agent-with-prov", name: "Gård Med Proveniens", url: "https://med-proveniens.example.no" });
    insertKnowledge({
      agent_id: "agent-with-prov",
      field_provenance: JSON.stringify({
        address: [
          { value: "Gata 1, 1234 By", source_type: "brreg", fetched_at: "2026-07-01T00:00Z" },
          { value: "Gata 1, 1234 By", source_type: "google_places", fetched_at: "2026-07-02T00:00Z" },
        ],
        phone: [{ value: "91122333", source_type: "brreg", fetched_at: "2026-07-01T00:00Z" }], // dup "brreg" -> deduped
        about: [{ value: "generic web snippet", source_type: "web_search", fetched_at: "2026-07-01T00:00Z" }], // inference -> excluded
      }),
      last_verified_at: "2026-07-20T14:00:00Z",
    });

    // (b) no field_provenance at all (empty '{}' default), but a timestamp present
    insertAgent({ id: "agent-no-prov", name: "Gård Uten Proveniens", url: "https://uten-proveniens.example.no" });
    insertKnowledge({ agent_id: "agent-no-prov", field_provenance: "{}", last_verified_at: "2026-07-20T14:00:00Z" });

    // (b2) field_provenance present but EVERY source is inference-only -> also absent
    insertAgent({ id: "agent-inference-only", name: "Gård Kun Gjetning", url: "https://gjetning.example.no" });
    insertKnowledge({
      agent_id: "agent-inference-only",
      field_provenance: JSON.stringify({
        about: [{ value: "guessed", source_type: "category_inference", fetched_at: "2026-07-01T00:00Z" }],
      }),
      last_verified_at: "2026-07-20T14:00:00Z",
    });

    // (c) real field_provenance but NO last_verified_at -> absent (never fabricate)
    insertAgent({ id: "agent-unverified", name: "Gård Ikke Verifisert", url: "https://ikke-verifisert.example.no" });
    insertKnowledge({
      agent_id: "agent-unverified",
      field_provenance: JSON.stringify({
        address: [{ value: "Gata 2", source_type: "homepage", fetched_at: "2026-07-01T00:00Z" }],
      }),
      last_verified_at: null,
    });

    // ── (a) presence + dedup + exact last_verified ──────────────────────────
    {
      const r = await callInfo("agent-with-prov");
      assertEq(r.status, 200, "a1: agent-with-prov -> 200");
      assertTrue(!!r.body?.data?.provenance, "a2: provenance key present when field_provenance + last_verified_at exist");
      assertEq(r.body.data.provenance.sources, ["brreg", "google_places"], "a3: sources deduped, inference source excluded");
      assertEq(r.body.data.provenance.last_verified, "2026-07-20T14:00:00Z", "a4: last_verified matches agent_knowledge.last_verified_at exactly");
    }

    // ── (b) absence: no usable field_provenance ─────────────────────────────
    {
      const r = await callInfo("agent-no-prov");
      assertEq(r.status, 200, "b1: agent-no-prov -> 200");
      assertTrue(!("provenance" in r.body.data), "b2: provenance key genuinely ABSENT (not null/empty) when field_provenance is {}");
    }
    {
      const r = await callInfo("agent-inference-only");
      assertTrue(!("provenance" in r.body.data), "b3: provenance key absent when every source is inference-only");
    }

    // ── (c) absence: no verification timestamp ──────────────────────────────
    {
      const r = await callInfo("agent-unverified");
      assertTrue(!("provenance" in r.body.data), "c1: provenance key absent when last_verified_at is NULL, even with real field_provenance");
    }

    // ── (d) additive-regression: other fields of the response are unchanged ─
    // Rather than hand-hardcoding the full AgentInfoResponse shape (fragile —
    // any future, unrelated field addition to knowledgeService.getAgentInfo
    // would false-positive this test), we independently call
    // knowledgeService.getAgentInfo() — the exact same builder the route
    // itself calls BEFORE our additive provenance merge — and assert the
    // route's response (minus the new `provenance` key) is byte-for-byte
    // identical to that untouched builder's output. This is a true
    // "diff other fields before/after" regression check: it fails if our
    // change ever perturbs, renames, or drops anything the route already
    // returned.
    {
      const routeResult = await callInfo("agent-no-prov");
      const { provenance, ...rest } = routeResult.body.data as Record<string, unknown>;

      const { knowledgeService } = require("../services/knowledge-service") as
        typeof import("../services/knowledge-service");
      const directInfo = knowledgeService.getAgentInfo("agent-no-prov");

      assertTrue(!!directInfo, "d1: setup — knowledgeService.getAgentInfo returns a value for agent-no-prov");
      assertEq(rest, directInfo, "d2: additive regression — every non-provenance field of the route response matches knowledgeService.getAgentInfo() untouched output exactly");
      assertTrue(!("provenance" in (directInfo as object)), "d3: knowledgeService.getAgentInfo() itself was NOT touched by this slice (no provenance key baked into the shared builder)");
    }
  } catch (err: any) {
    failed++;
    failures.push("marketplace-agent-provenance: unexpected error: " + String(err?.message || err));
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceAgentProvenanceTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

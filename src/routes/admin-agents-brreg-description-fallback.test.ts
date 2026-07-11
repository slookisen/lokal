/**
 * admin-agents-brreg-description-fallback.test.ts — unit/integration tests
 * for a slice of dev-request 2026-06-30-open-stuck-verification-bucket: the
 * `http_unreachable` lever — falling back to Brreg's own registered NACE
 * activity-description text (naeringskode{1,2,3}.beskrivelse) as an agent's
 * `agents.description` when the homepage crawl never produced a real one.
 *
 * Covers POST /admin/agents/brreg-description-fallback
 * (src/routes/admin-agents.ts):
 *   (a) 403 without X-Admin-Key.
 *   (b) dry_run (default): reports candidate_count/batch_size/would_write
 *       previews of the ACTUAL Brreg text, and issues ZERO DB writes.
 *   (c) apply=1: writes agents.description + field_provenance
 *       (source_type: "brreg_fallback") only for true candidates.
 *   (d) a curated-lock on `description` (agent_knowledge.curated_fields)
 *       skips the agent even though it's otherwise a candidate — never
 *       overwritten, never written.
 *   (e) an agent with an existing NON-EMPTY description is never selected
 *       and never touched, even if it has an org_nr and no curated lock.
 *   (f) idempotent re-run: apply, then apply again — a previously-filled
 *       agent is not re-selected (candidate_count drops) and its
 *       description is byte-for-byte unchanged (not re-written) on the
 *       second run; a genuinely NEW candidate row is still picked up.
 *   (g) an agent with no usable Brreg beskrivelse (empty on all 3
 *       naeringskode) is skipped (no_brreg_description) and left untouched.
 *
 * All Brreg I/O is stubbed via a monkey-patched global.fetch (mirrors
 * admin-agents-brreg-catalog-sweep.test.ts exactly — fetchBrregActivityDescription
 * defaults its fetchImpl param to the global `fetch` identifier). ZERO real
 * network calls.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-agents-brreg-description-fallback.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runBrregDescriptionFallbackTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type BrregFixture = { status: number; body?: Record<string, unknown> };

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function activeAgentWithDescription(orgNr: string, name: string, beskrivelse: string): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: null,
    naeringskode1: { kode: "47.220", beskrivelse },
  };
}

function activeAgentNoDescription(orgNr: string, name: string): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: null,
    naeringskode1: { kode: "47.220", beskrivelse: "" },
    naeringskode2: { kode: "01.410" }, // no beskrivelse key at all
  };
}

export async function runBrregDescriptionFallbackTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "brreg-description-fallback-test-key";

  const fixtures: Map<string, BrregFixture> = new Map();
  let fetchCallCount = 0;

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = String(url);
      const orgNr = urlStr.split("/").pop() || "";
      const fixture = fixtures.get(orgNr);
      if (!fixture) {
        return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
      }
      return {
        status: fixture.status,
        ok: fixture.status >= 200 && fixture.status < 300,
        json: async () => fixture.body ?? {},
      } as unknown as Response;
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    globalThis.fetch = stubFetch();

    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    // admin-agents.ts imports canCorrectFactualField/mergeFieldProvenance
    // from admin-knowledge.ts — bust that cache too so a fresh require picks
    // up a clean module graph, mirroring the sibling test's own re-require.
    try { delete require.cache[require.resolve("../routes/admin-knowledge")]; } catch { /* ignore */ }
    const adminAgentsModule = require("../routes/admin-agents") as typeof import("../routes/admin-agents");
    const routerModule = adminAgentsModule.default;

    function getHandler(method: "get" | "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postFallback = getHandler("post", "/brreg-description-fallback");

    async function callPost(
      body: Record<string, unknown>,
      query: Record<string, unknown> = {},
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postFallback({ headers, body, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(opts: {
      id: string; name: string; orgNr?: string | null; description?: string;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key, org_nr
        ) VALUES (?, ?, ?, 't', 'x@example.com', 'https://example.com', 'producer', ?, ?)`,
      ).run(opts.id, opts.name, opts.description ?? "", `key-${opts.id}`, opts.orgNr ?? null);
    }

    function setCuratedDescriptionLock(agentId: string): void {
      const exists = testDb.prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?").get(agentId);
      if (exists) {
        testDb.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?")
          .run(JSON.stringify({ description: true }), agentId);
      } else {
        testDb.prepare(
          "INSERT INTO agent_knowledge (agent_id, curated_fields, field_provenance, updated_at) VALUES (?, ?, '{}', ?)",
        ).run(agentId, JSON.stringify({ description: true }), new Date().toISOString());
      }
    }

    function readAgent(id: string): any {
      return testDb.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    }
    function readKnowledge(agentId: string): any {
      return testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
    }

    // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
    {
      const p = await callPost({}, {}, {});
      assertEq(p.status, 403, "auth: POST without X-Admin-Key -> 403");
    }

    // ── (b) dry_run default: candidate preview, zero writes ─────────────
    testDb.exec("DELETE FROM agents"); testDb.exec("DELETE FROM agent_knowledge"); fixtures.clear();
    {
      insertAgent({ id: "dry-1", name: "Tom Beskrivelse Gård", orgNr: "950000001", description: "" });
      fixtures.set(
        "950000001",
        { status: 200, body: activeAgentWithDescription("950000001", "Tom Beskrivelse Gård AS", "Produksjon av frukt og bær") },
      );

      const callsBefore = fetchCallCount;
      const dry = await callPost({});
      assertEq(dry.status, 200, "dry-default: POST with empty body -> 200");
      assertEq(dry.body?.dry_run, true, "dry-default: dry_run reported true");
      assertEq(dry.body?.candidate_count, 1, "dry-default: candidate_count is 1");
      assertEq(dry.body?.would_write_count, 1, "dry-default: would_write_count is 1");
      assertEq(dry.body?.would_write?.[0]?.agent_id, "dry-1", "dry-default: previews the candidate row");
      assertEq(
        dry.body?.would_write?.[0]?.description_preview,
        "Produksjon av frukt og bær",
        "dry-default: preview shows the ACTUAL Brreg text (genuine preview, not a placeholder)",
      );
      assertTrue(fetchCallCount > callsBefore, "dry-default: dry-run genuinely calls Brreg for the preview text");

      const rowAfter = readAgent("dry-1");
      assertEq(rowAfter.description, "", "dry-default: description is STILL empty in the DB (no write)");

      const dryExplicit = await callPost({}, { apply: "0" });
      assertEq(dryExplicit.body?.dry_run, true, "dry-explicit: apply unset/falsy still means dry-run");
      const rowAfter2 = readAgent("dry-1");
      assertEq(rowAfter2.description, "", "dry-explicit: still no write after a second dry-run call");
    }

    // ── (c) apply=1: writes description + provenance for true candidates ─
    testDb.exec("DELETE FROM agents"); testDb.exec("DELETE FROM agent_knowledge"); fixtures.clear();
    {
      insertAgent({ id: "apply-1", name: "Verifiserbar Gård", orgNr: "960000001", description: "" });
      fixtures.set(
        "960000001",
        { status: 200, body: activeAgentWithDescription("960000001", "Verifiserbar Gård AS", "Dyrking av grønnsaker") },
      );

      const apply = await callPost({}, { apply: "1" });
      assertEq(apply.status, 200, "apply: POST ?apply=1 -> 200");
      assertEq(apply.body?.dry_run, false, "apply: dry_run reported false");
      assertEq(apply.body?.written_count, 1, "apply: written_count is 1");
      assertEq(apply.body?.written?.[0]?.agent_id, "apply-1", "apply: writes exactly the candidate row");
      assertEq(apply.body?.written?.[0]?.description, "Dyrking av grønnsaker", "apply: response echoes the written text");

      const row = readAgent("apply-1");
      assertEq(row.description, "Dyrking av grønnsaker", "apply: agents.description is now the Brreg text");

      const k = readKnowledge("apply-1");
      assertTrue(!!k, "apply: an agent_knowledge row now exists for the agent");
      const prov = JSON.parse(k.field_provenance);
      assertTrue(Array.isArray(prov.description), "apply: field_provenance.description is an array");
      assertEq(prov.description[0]?.source_type, "brreg_fallback", "apply: provenance source_type is 'brreg_fallback'");
      assertEq(prov.description[0]?.value, "Dyrking av grønnsaker", "apply: provenance value matches the written text");
      assertTrue(typeof prov.description[0]?.fetched_at === "string" && prov.description[0].fetched_at.length > 0,
        "apply: provenance fetched_at is stamped");
    }

    // ── (d) curated-lock on description: skipped even though otherwise ───
    //     a candidate ─────────────────────────────────────────────────────
    testDb.exec("DELETE FROM agents"); testDb.exec("DELETE FROM agent_knowledge"); fixtures.clear();
    {
      insertAgent({ id: "curated-1", name: "Låst Gård", orgNr: "960000002", description: "" });
      setCuratedDescriptionLock("curated-1");
      fixtures.set(
        "960000002",
        { status: 200, body: activeAgentWithDescription("960000002", "Låst Gård AS", "Skulle aldri bli skrevet") },
      );

      const dry = await callPost({});
      assertEq(dry.body?.candidate_count, 0, "curated: SQL pre-filter already excludes the curated-locked row from candidate_count");
      assertEq((dry.body?.would_write ?? []).length, 0, "curated: not in the dry-run preview");

      const apply = await callPost({}, { apply: "1" });
      assertEq(apply.body?.written_count, 0, "curated: apply writes nothing for the locked row");
      const row = readAgent("curated-1");
      assertEq(row.description, "", "curated: description remains untouched (never overwritten, never filled)");
    }

    // ── (e) existing non-empty description: never selected, never touched ─
    testDb.exec("DELETE FROM agents"); testDb.exec("DELETE FROM agent_knowledge"); fixtures.clear();
    {
      insertAgent({ id: "has-desc-1", name: "Har Beskrivelse Gård", orgNr: "960000003", description: "En fin gård med gode varer." });
      fixtures.set(
        "960000003",
        { status: 200, body: activeAgentWithDescription("960000003", "Har Beskrivelse Gård AS", "Skulle aldri overskrive") },
      );

      const dry = await callPost({});
      assertEq(dry.body?.candidate_count, 0, "existing-desc: row with a populated description is never a candidate");

      const apply = await callPost({}, { apply: "1" });
      assertEq(apply.body?.written_count, 0, "existing-desc: apply writes nothing");
      const row = readAgent("has-desc-1");
      assertEq(row.description, "En fin gård med gode varer.", "existing-desc: original description is byte-for-byte unchanged");
    }

    // ── (f) idempotent re-run ─────────────────────────────────────────────
    testDb.exec("DELETE FROM agents"); testDb.exec("DELETE FROM agent_knowledge"); fixtures.clear();
    {
      insertAgent({ id: "idem-1", name: "Idempotent Gård", orgNr: "960000004", description: "" });
      fixtures.set(
        "960000004",
        { status: 200, body: activeAgentWithDescription("960000004", "Idempotent Gård AS", "Salg av honning") },
      );

      const first = await callPost({}, { apply: "1" });
      assertEq(first.body?.written_count, 1, "idempotent: first apply writes the one candidate");
      const rowAfterFirst = readAgent("idem-1");

      const callsBeforeSecond = fetchCallCount;
      const second = await callPost({}, { apply: "1" });
      assertEq(second.body?.candidate_count, 0, "idempotent: second run finds zero candidates (description no longer empty)");
      assertEq(second.body?.written_count, 0, "idempotent: second run writes nothing");
      assertEq(fetchCallCount, callsBeforeSecond, "idempotent: second run makes zero new Brreg fetch calls (excluded pre-fetch by the candidate SQL)");

      const rowAfterSecond = readAgent("idem-1");
      assertEq(rowAfterSecond.description, rowAfterFirst.description, "idempotent: description unchanged by the second run");

      // A genuinely new candidate row inserted afterward IS still picked up.
      insertAgent({ id: "idem-2", name: "Ny Gård", orgNr: "960000005", description: "" });
      fixtures.set("960000005", { status: 200, body: activeAgentWithDescription("960000005", "Ny Gård AS", "Dyrking av poteter") });
      const third = await callPost({}, { apply: "1" });
      assertEq(third.body?.written_count, 1, "idempotent: a genuinely new candidate in the same table IS picked up");
      assertEq(third.body?.written?.[0]?.agent_id, "idem-2", "idempotent: updates exactly the new row, not the already-filled one");
    }

    // ── (g) no usable Brreg description: skipped, left untouched ─────────
    testDb.exec("DELETE FROM agents"); testDb.exec("DELETE FROM agent_knowledge"); fixtures.clear();
    {
      insertAgent({ id: "no-desc-1", name: "Ingen Brreg Beskrivelse", orgNr: "960000006", description: "" });
      fixtures.set("960000006", { status: 200, body: activeAgentNoDescription("960000006", "Ingen Brreg Beskrivelse AS") });

      const dry = await callPost({});
      assertEq(dry.body?.would_write_count, 0, "no-desc: not in the would_write preview");
      assertTrue(
        (dry.body?.skipped ?? []).some((s: any) => s.agent_id === "no-desc-1" && s.reason === "no_brreg_description"),
        "no-desc: dry-run reports the skip reason 'no_brreg_description'",
      );

      const apply = await callPost({}, { apply: "1" });
      assertEq(apply.body?.written_count, 0, "no-desc: apply writes nothing");
      assertTrue(
        (apply.body?.skipped ?? []).some((s: any) => s.agent_id === "no-desc-1" && s.reason === "no_brreg_description"),
        "no-desc: apply reports the same skip reason",
      );
      const row = readAgent("no-desc-1");
      assertEq(row.description, "", "no-desc: description remains empty (never touched)");
    }
  } catch (err) {
    failed++;
    failures.push(`brreg-description-fallback: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("../routes/admin-knowledge")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-brreg-description-fallback.test.ts`
if (require.main === module) {
  console.log("── admin-agents brreg-description-fallback (dev-request 2026-06-30-open-stuck-verification-bucket) unit tests ──");
  runBrregDescriptionFallbackTests({ log: true }).then((r) => {
    console.log(`\nbrreg-description-fallback: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

/**
 * admin-agents-tynne-profiler-cohort.test.ts — tests for dev-request
 * 2026-08-15-tynne-profiler-forbedringsloype, Slice 1: the read-only cohort
 * report + `no_source` residual-queue bookkeeping
 * (GET /admin/agents/tynne-profiler-cohort, GET /admin/agents/tynne-profiler-
 * queue, src/routes/admin-agents.ts) built on TOP of the EXISTING
 * POST /admin/agents/retro-scan dry-run cascade (runRfbRetroScanCore) — no
 * source-fetch, no LLM generation, no writes to agents.description /
 * agent_knowledge.about (that's Slice 2/3).
 *
 * Covers:
 *   (a) the cohort route makes ZERO writes to `agents`/`agent_knowledge`
 *       (real judge calls happen, same as retro-scan's own dry-run, but
 *       content columns are untouched) while still recording flagged rows
 *       into agents_tynne_profiler_queue with cause:'no_source'.
 *   (b) claimed_at-locked rows never reach the queue (same lock reuse as
 *       retro-scan — the row never appears in `changed`, so nothing to
 *       record).
 *   (c) a per-FIELD curated lock is respected — the locked field is not
 *       recorded as flagged; the OTHER (non-curated) field on the same row
 *       still is.
 *   (d) priority tiering: an agent flagged on BOTH description and about is
 *       'both_fields'; description-only is 'description_only'; about-only is
 *       'about_only' — and the response's `cohort` array is ordered
 *       both_fields-first, description_only-next, about_only-last.
 *   (e) by_cause_class / by_priority_tier counts in the response match the
 *       actual cohort composition.
 *   (f) the residual queue persists across calls (upsert-on-agent_id,
 *       "refresh don't pile up" — a second call updates the same row rather
 *       than duplicating it) and is readable via GET /tynne-profiler-queue,
 *       ordered by the same priority tiering.
 *   (g) offset/limit/agentIds query-param handling mirrors retro-scan's own
 *       validation (invalid offset -> 400, no scan performed).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAdminAgentsTynneProfilerCohortTests(
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

  return (async () => {
    const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
      typeof import("../database/init");

    const prevDb = (() => {
      try { return getDb(); } catch { return undefined; }
    })();
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;

    const testDb = new Database(":memory:");
    testDb.pragma("journal_mode = DELETE");
    testDb.pragma("foreign_keys = OFF");

    const ADMIN_KEY = process.env.ADMIN_KEY || "admin-agents-tynne-profiler-cohort-test-key";

    // Same CONTAMINATED / GOOD fixtures as admin-agents-retro-scan.test.ts —
    // the stub judge below AVVIS's on the "Sidersortar" marker.
    const CONTAMINATED =
      "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger, med sideri og gardsutsalg.";
    const GOOD =
      "Kinn Bryggeri er et lite håndverksbryggeri på Vågsøy som brygger øl med lokalt vann og kortreiste råvarer, og tar imot besøkende til smaking og omvisning gjennom sommersesongen.";

    function fakeRes() {
      const r: any = { statusCode: 200, body: undefined };
      r.status = (c: number) => { r.statusCode = c; return r; };
      r.json = (b: any) => { r.body = b; return r; };
      return r;
    }

    let anthropicCallCount = 0;
    function stubFetch(): typeof fetch {
      return (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (!urlStr.includes("api.anthropic.com")) {
          throw new Error(`unexpected non-Anthropic fetch in this route: ${urlStr}`);
        }
        anthropicCallCount++;
        const body = init?.body ? JSON.parse(init.body) : {};
        const prompt: string = body?.messages?.[0]?.content ?? "";
        const verdict = prompt.includes("Sidersortar") ? "AVVIS" : "GODKJENN";
        const reasoning = verdict === "AVVIS"
          ? "Dette er en lenkeliste fra en navigasjonsmeny, ikke ekte prosa om produsenten."
          : "Ren, konkret prosa om produsenten.";
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: `${verdict}\n${reasoning}` }] }),
        } as unknown as Response;
      }) as typeof fetch;
    }

    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-tynne-profiler-cohort";
      globalThis.fetch = stubFetch();

      const routePath = require.resolve("../routes/admin-agents");
      delete require.cache[routePath];
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

      const getCohort = getHandler("get", "/tynne-profiler-cohort");
      const getQueue = getHandler("get", "/tynne-profiler-queue");

      async function callCohort(
        query: Record<string, unknown> = {},
        headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
      ): Promise<{ status: number; body: any }> {
        const res = fakeRes();
        await getCohort({ headers, query, body: {} } as any, res as any);
        return { status: res.statusCode, body: res.body };
      }
      async function callQueue(
        headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
      ): Promise<{ status: number; body: any }> {
        const res = fakeRes();
        await getQueue({ headers, query: {}, body: {} } as any, res as any);
        return { status: res.statusCode, body: res.body };
      }

      function insertAgent(opts: {
        id: string; name: string; description?: string; claimedAt?: string | null;
        umbrellaType?: string | null; orgNr?: string | null;
      }): void {
        testDb.prepare(
          `INSERT INTO agents (
            id, name, description, provider, contact_email, url, role, api_key,
            claimed_at, umbrella_type, org_nr
          ) VALUES (?, ?, ?, 't', 'x@example.com', 'https://example.com', 'producer', ?, ?, ?, ?)`,
        ).run(
          opts.id, opts.name, opts.description ?? "", `key-${opts.id}`,
          opts.claimedAt ?? null, opts.umbrellaType ?? null, opts.orgNr ?? null,
        );
      }

      function insertKnowledge(agentId: string, opts: {
        about?: string | null; curatedFields?: Record<string, unknown>; fieldProvenance?: Record<string, unknown>;
      } = {}): void {
        testDb.prepare(
          `INSERT INTO agent_knowledge (agent_id, about, curated_fields, field_provenance, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          agentId,
          opts.about ?? null,
          JSON.stringify(opts.curatedFields ?? {}),
          JSON.stringify(opts.fieldProvenance ?? {}),
          new Date().toISOString(),
        );
      }

      function readAgent(id: string): any {
        return testDb.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      }
      function readKnowledge(agentId: string): any {
        return testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
      }
      function readQueueRow(agentId: string): any {
        return testDb.prepare("SELECT * FROM agents_tynne_profiler_queue WHERE agent_id = ?").get(agentId);
      }
      function clearAll(): void {
        testDb.exec("DELETE FROM agents");
        testDb.exec("DELETE FROM agent_knowledge");
        testDb.exec("DELETE FROM agent_knowledge_audit");
        testDb.exec("DELETE FROM agents_tynne_profiler_queue");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (a) dry-run-safe: real judge call, ZERO writes to agents/
      //     agent_knowledge, but a queue row IS written with cause:'no_source'.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-both", name: "Draopar Sideri", description: CONTAMINATED });
        insertKnowledge("tp-both", { about: CONTAMINATED });

        const beforeAgent = readAgent("tp-both");
        const beforeKnowledge = readKnowledge("tp-both");
        const callsBefore = anthropicCallCount;

        const r = await callCohort({ agentIds: "tp-both" });
        assertEq(r.status, 200, "tp-a1: cohort route -> 200");
        assertEq(r.body.dry_run, true, "tp-a2: dry_run:true");
        assertTrue(anthropicCallCount > callsBefore, "tp-a3: real judge calls were made (not a guessed preview)");

        const afterAgent = readAgent("tp-both");
        const afterKnowledge = readKnowledge("tp-both");
        assertEq(afterAgent.description, beforeAgent.description, "tp-a4: agents.description completely unchanged");
        assertEq(afterKnowledge.about, beforeKnowledge.about, "tp-a5: agent_knowledge.about completely unchanged");
        assertEq(testDb.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get(), { n: 0 }, "tp-a6: no audit rows written (nothing was actually changed)");

        const entry = r.body.cohort.find((c: any) => c.agent_id === "tp-both");
        assertTrue(!!entry, "tp-a7: flagged agent appears in the response cohort[]");
        assertEq(entry.priority_tier, "both_fields", "tp-a8: both description+about flagged -> both_fields tier");

        const queueRow = readQueueRow("tp-both");
        assertTrue(!!queueRow, "tp-a9: a residual-queue row WAS persisted for the flagged agent");
        assertEq(queueRow.cause, "no_source", "tp-a10: persisted cause is 'no_source' (Slice 1 — no source-fetch attempted yet)");
        assertEq(queueRow.status, "pending", "tp-a11: persisted status is 'pending'");
        assertEq(queueRow.priority_tier, "both_fields", "tp-a12: persisted priority_tier matches the response");
        assertEq(JSON.parse(queueRow.flagged_fields).sort(), ["about", "description"], "tp-a13: persisted flagged_fields lists both fields");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) claimed_at-locked rows never reach the queue.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-locked", name: "Låst Gard", description: CONTAMINATED, claimedAt: "2026-01-01T00:00:00.000Z" });

        const callsBefore = anthropicCallCount;
        const r = await callCohort({ agentIds: "tp-locked" });
        assertTrue(r.body.skipped_locked.includes("tp-locked"), "tp-b1: locked agent reported in skipped_locked");
        assertEq(anthropicCallCount, callsBefore, "tp-b2: no judge call happened for the locked agent");
        assertTrue(
          !r.body.cohort.some((c: any) => c.agent_id === "tp-locked"),
          "tp-b3: locked agent does not appear in cohort[]",
        );
        assertTrue(!readQueueRow("tp-locked"), "tp-b4: no residual-queue row was persisted for the locked agent");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c) per-FIELD curated lock: locked field excluded, non-curated field
      //     on the same row still recorded.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-curated", name: "Curated Gard", description: CONTAMINATED });
        insertKnowledge("tp-curated", { about: CONTAMINATED, curatedFields: { description: true } });

        const r = await callCohort({ agentIds: "tp-curated" });
        assertTrue(
          r.body.skipped_curated.some((s: any) => s.agent_id === "tp-curated" && s.fields.includes("description")),
          "tp-c1: curated-locked description reported in skipped_curated",
        );
        const entry = r.body.cohort.find((c: any) => c.agent_id === "tp-curated");
        assertTrue(!!entry, "tp-c2: row still appears in cohort[] for the non-curated field");
        assertTrue(entry.fields.includes("about"), "tp-c3: about (not curated) IS in the flagged fields");
        assertTrue(!entry.fields.includes("description"), "tp-c4: curated description is NOT in the flagged fields");
        assertEq(entry.priority_tier, "about_only", "tp-c5: only 'about' counts toward tiering -> about_only");

        const queueRow = readQueueRow("tp-curated");
        assertEq(JSON.parse(queueRow.flagged_fields), ["about"], "tp-c6: persisted flagged_fields excludes the curated field");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (d) priority tiering + response ordering: both_fields before
      //     description_only before about_only.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-about-only", name: "About Only Gard", description: GOOD });
        insertKnowledge("tp-about-only", { about: CONTAMINATED });

        insertAgent({ id: "tp-desc-only", name: "Desc Only Gard", description: CONTAMINATED });
        insertKnowledge("tp-desc-only", { about: GOOD });

        insertAgent({ id: "tp-both-2", name: "Both Gard", description: CONTAMINATED });
        insertKnowledge("tp-both-2", { about: CONTAMINATED });

        const r = await callCohort({ agentIds: "tp-about-only,tp-desc-only,tp-both-2" });
        assertEq(r.body.cohort.length, 3, "tp-d1: all three flagged rows appear in the cohort");

        const tiers = r.body.cohort.map((c: any) => c.priority_tier);
        assertEq(tiers, ["both_fields", "description_only", "about_only"], "tp-d2: cohort is ordered both_fields -> description_only -> about_only");

        assertEq(r.body.by_priority_tier, { both_fields: 1, description_only: 1, about_only: 1 }, "tp-d3: by_priority_tier counts match the fixture");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) by_cause_class counts match the actual composition.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        const MANGLED = GOOD + " opplevelser p�";
        insertAgent({ id: "tp-mangled", name: "Mangled Gard", description: MANGLED });

        const r = await callCohort({ agentIds: "tp-mangled" });
        assertEq(r.body.by_cause_class.deterministic_mangled, 1, "tp-e1: by_cause_class.deterministic_mangled counts the deterministic flag");
        assertEq(r.body.by_cause_class.llm_rejected, 0, "tp-e2: llm_rejected is 0 (mangled never reaches the judge)");

        const entry = r.body.cohort.find((c: any) => c.agent_id === "tp-mangled");
        assertEq(entry.cause_classes.description, "deterministic_mangled", "tp-e3: per-row cause_classes carries the field's cause class");

        const queueRow = readQueueRow("tp-mangled");
        assertEq(JSON.parse(queueRow.cause_classes).description, "deterministic_mangled", "tp-e4: persisted cause_classes carries the same class");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (f) queue persistence across calls (upsert, not duplicate) +
      //     GET /tynne-profiler-queue read-back, ordered by priority.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-persist", name: "Persist Gard", description: CONTAMINATED });

        await callCohort({ agentIds: "tp-persist" });
        const afterFirst = readQueueRow("tp-persist");
        assertTrue(!!afterFirst, "tp-f1: queue row exists after first call");

        await callCohort({ agentIds: "tp-persist" });
        const countRows = testDb.prepare(
          "SELECT COUNT(*) AS n FROM agents_tynne_profiler_queue WHERE agent_id = 'tp-persist'",
        ).get() as { n: number };
        assertEq(countRows.n, 1, "tp-f2: a second call upserts in place — still exactly one row for this agent");

        const listRes = await callQueue();
        assertEq(listRes.status, 200, "tp-f3: GET /tynne-profiler-queue -> 200");
        assertTrue(
          listRes.body.entries.some((e: any) => e.agent_id === "tp-persist"),
          "tp-f4: persisted row is readable via GET /tynne-profiler-queue",
        );
        assertEq(listRes.body.count, listRes.body.entries.length, "tp-f5: count matches entries.length");

        const listedEntry = listRes.body.entries.find((e: any) => e.agent_id === "tp-persist");
        assertTrue(Array.isArray(listedEntry.flagged_fields), "tp-f6: flagged_fields is parsed back into an array (not a raw JSON string)");
      }

      // Queue listing ordering: both_fields ahead of description_only ahead
      // of about_only, across a fresh set of persisted rows.
      clearAll();
      {
        insertAgent({ id: "tp-list-about", name: "List About Gard", description: GOOD });
        insertKnowledge("tp-list-about", { about: CONTAMINATED });
        insertAgent({ id: "tp-list-both", name: "List Both Gard", description: CONTAMINATED });
        insertKnowledge("tp-list-both", { about: CONTAMINATED });
        insertAgent({ id: "tp-list-desc", name: "List Desc Gard", description: CONTAMINATED });
        insertKnowledge("tp-list-desc", { about: GOOD });

        await callCohort({ agentIds: "tp-list-about,tp-list-both,tp-list-desc" });
        const listRes = await callQueue();
        const ids = listRes.body.entries.map((e: any) => e.agent_id);
        const tierByAgent: Record<string, string> = {
          "tp-list-both": "both_fields", "tp-list-desc": "description_only", "tp-list-about": "about_only",
        };
        const orderedTiers = ids
          .filter((id: string) => id in tierByAgent)
          .map((id: string) => tierByAgent[id]);
        assertEq(orderedTiers, ["both_fields", "description_only", "about_only"], "tp-f7: GET /tynne-profiler-queue lists pending rows ordered both_fields -> description_only -> about_only");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (g) offset/limit query-param validation mirrors retro-scan's own.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-offset-sanity", name: "Offset Sanity Gard", description: GOOD });

        const callsBefore = anthropicCallCount;
        const negRes = await callCohort({ offset: "-1" });
        assertEq(negRes.status, 400, "tp-g1: negative offset -> 400");
        assertTrue(
          typeof negRes.body.error === "string" && typeof negRes.body.detail === "string",
          "tp-g2: 400 body has the {error, detail} shape",
        );
        assertEq(anthropicCallCount, callsBefore, "tp-g3: invalid offset performs NO scan (no judge calls made)");

        const okRes = await callCohort({ offset: "0" });
        assertEq(okRes.status, 200, "tp-g4: explicit offset:0 (string, as a real query param would arrive) still works");
      }

      // Missing/invalid admin key -> 403/503, no scan, no queue write.
      clearAll();
      {
        insertAgent({ id: "tp-auth", name: "Auth Gard", description: CONTAMINATED });
        const callsBefore = anthropicCallCount;
        const res = fakeRes();
        await getCohort({ headers: {}, query: { agentIds: "tp-auth" }, body: {} } as any, res as any);
        assertEq(res.statusCode, 403, "tp-h1: missing X-Admin-Key -> 403");
        assertEq(anthropicCallCount, callsBefore, "tp-h2: no judge call without a valid admin key");
        assertTrue(!readQueueRow("tp-auth"), "tp-h3: no queue row written without a valid admin key");
      }
    } catch (err) {
      failed++;
      failures.push(`admin-agents-tynne-profiler-cohort: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevDb) __setDbForTesting(prevDb);
      try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
      try { delete require.cache[require.resolve("../routes/admin-knowledge")]; } catch { /* ignore */ }
      testDb.close();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-agents-tynne-profiler-cohort.test.ts`
if (require.main === module) {
  console.log("── admin-agents tynne-profiler-cohort (dev-request 2026-08-15-tynne-profiler-forbedringsloype, Slice 1) unit tests ──");
  runAdminAgentsTynneProfilerCohortTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-tynne-profiler-cohort: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

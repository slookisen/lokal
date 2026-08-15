/**
 * admin-agents-tynne-profiler-improve.test.ts — tests for dev-request
 * 2026-08-15-tynne-profiler-forbedringsloype, Slice 2: the source-fetch +
 * LLM-generation + judge-gate + audit-write improvement loop
 * (POST /admin/agents/tynne-profiler-improve, src/routes/admin-agents.ts)
 * built on top of Slice 1's residual queue (agents_tynne_profiler_queue).
 *
 * Mirrors admin-agents-tynne-profiler-cohort.test.ts's / admin-agents-retro-
 * scan.test.ts's setup convention exactly (own in-memory prod-schema DB via
 * __setDbForTesting/__initSchemaForTesting, direct handler invocation via the
 * router's own .stack, busts admin-agents.ts/admin-knowledge.ts require
 * caches) and mocks globalThis.fetch for BOTH the Anthropic calls (judge +
 * the NEW generation call, discriminated by prompt content) and the website
 * source-fetch (services/fetch-page.ts's fetchPage defaults to
 * globalThis.fetch when no fetchImpl is injected — see that file's own doc
 * comment on FetchPageOptions.fetchImpl).
 *
 * Covers:
 *   (a) dry-run makes ZERO writes to agents/agent_knowledge/
 *       agent_knowledge_audit/agents_tynne_profiler_queue — but DOES perform
 *       real website-fetch + generation + judge calls (a genuine preview),
 *       and reports the would-be-written candidate in the response.
 *   (b) apply mode writes an approved candidate correctly: agents.description
 *       / agent_knowledge.about updated, field_provenance merged (preserving
 *       an unrelated existing field's entry), agent_knowledge_audit row
 *       inserted with correct old_value/new_value, queue row flipped to
 *       status:'resolved'.
 *   (c) judge-reject case: content left completely untouched, queue row
 *       stays 'pending' with cause:'judge_rejected'.
 *   (d) missing-website case: skipped as no_source, agent content and queue
 *       row both untouched (cause was already 'no_source' from Slice 1).
 *   (e) negative control — the immediate-before-write re-check is REAL, not
 *       just present: a row/field that becomes locked AFTER the judge
 *       approves (simulated via a fetch-stub side effect) is NOT written,
 *       even though selection-time and judge-time both saw it unlocked.
 *   (f) batch-size cap: apply + limit>20 without confirm_large_batch -> 400,
 *       zero fetch/generation/judge/write work performed; confirm_large_batch
 *       lifts the cap; dry-run is never capped.
 *   (g) aggregator-host website (facebook.com) is rejected defensively —
 *       never fetched, cause:'source_aggregator_host'.
 *   (h) a fetch failure (404) and an empty-content page are both treated as
 *       "no usable source" (cause:'source_fetch_failed'), never fabricated.
 *   (i) generation returning the escape sentinel (not enough material) is
 *       treated as generation_failed — no write, no fabrication.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAdminAgentsTynneProfilerImproveTests(
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

    const ADMIN_KEY = process.env.ADMIN_KEY || "admin-agents-tynne-profiler-improve-test-key";

    function fakeRes() {
      const r: any = { statusCode: 200, body: undefined };
      r.status = (c: number) => { r.statusCode = c; return r; };
      r.json = (b: any) => { r.body = b; return r; };
      return r;
    }

    function htmlResponse(html: string) {
      return {
        ok: true,
        status: 200,
        url: undefined,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      } as unknown as Response;
    }

    function notFoundResponse() {
      return {
        ok: false,
        status: 404,
        url: undefined,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    function anthropicResponse(text: string) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text } ] }),
      } as unknown as Response;
    }

    // Rich, genuinely-Norwegian, >80-char source prose — used for every
    // "has a usable source" fixture. No <a href> links, so
    // discoverContentLinks() finds nothing and buildPageEvidence falls back
    // to guessing /kontakt, /om-oss, /produkter — all of which 404 via the
    // stub's default (fixtures.get returns undefined), which buildPageEvidence
    // tolerates gracefully (primary page evidence still stands).
    const SOURCE_HTML = (name: string) =>
      `<html><body><p>${name} ligger i Valdres og lager geitost av melk fra egne geiter, med lang tradisjon i familien. Garden mottok Spesialitetsmerket fra Matmerk for brunosten sin.</p></body></html>`;

    const GEN_SENTINEL = "INGEN_FORBEDRING_MULIG";

    // URL -> Response fixtures, keyed by the exact URL fetchPage requests.
    const fixtures: Map<string, Response> = new Map();
    let anthropicCallCount = 0;
    let judgeCallCount = 0;
    let genCallCount = 0;

    function stubFetch(): typeof fetch {
      return (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          const body = init?.body ? JSON.parse(init.body) : {};
          const prompt: string = body?.messages?.[0]?.content ?? "";
          const isJudgeCall = prompt.includes("Du er en kvalitetsdommer");

          if (isJudgeCall) {
            judgeCallCount++;
            // Race-condition side effects: simulate a row/field becoming
            // locked BETWEEN judge approval and the write step, proving the
            // write-time re-check is real (negative control, case (e)).
            if (prompt.includes("Race Lock Gard")) {
              testDb.prepare("UPDATE agents SET claimed_at = ? WHERE id = 'tp-race-lock'").run(new Date().toISOString());
            }
            if (prompt.includes("Race Curated Gard")) {
              testDb.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = 'tp-race-curated'").run(
                JSON.stringify({ description: true }),
              );
            }
            // "Partial Reject About Marker" lets test (j) reject ONLY the
            // 'about' candidate for one agent while its 'description'
            // candidate (same agent, same producer name) is approved — the
            // judge call's own prompt only ever carries the producer NAME
            // (identical for both fields on one agent), so per-field
            // discrimination has to ride on the CANDIDATE TEXT instead,
            // which the generation branch below varies by kind.
            const verdict = (prompt.includes("Judge Reject Gard") || prompt.includes("PARTIAL ABOUT REJECT MARKER"))
              ? "AVVIS" : "GODKJENN";
            const reasoning = verdict === "AVVIS"
              ? "Teksten er for generisk og fremhever ikke produsentens særpreg."
              : "Konkret, kildebasert prosa om produsentens særpreg.";
            return anthropicResponse(`${verdict}\n${reasoning}`);
          }

          // Generation call.
          genCallCount++;
          if (prompt.includes("Gen Fail Gard")) {
            return anthropicResponse(GEN_SENTINEL); // "not enough material" escape
          }
          const nameMatch = prompt.match(/for produsenten "([^"]+)"/);
          const name = nameMatch ? nameMatch[1] : "Ukjent Gard";
          const isAboutKind = prompt.includes("utfyllende «Om produsenten»-tekst");
          let candidate = `${name} lager geitost i Valdres av melk fra egne geiter og har mottatt Spesialitetsmerket fra Matmerk.`;
          if (isAboutKind && name === "Partial Reject Gard") {
            candidate += " PARTIAL ABOUT REJECT MARKER.";
          }
          return anthropicResponse(candidate);
        }
        const fx = fixtures.get(urlStr);
        return fx ?? notFoundResponse();
      }) as typeof fetch;
    }

    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-tynne-profiler-improve";
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

      const postImprove = getHandler("post", "/tynne-profiler-improve");

      async function callImprove(
        bodyIn: Record<string, unknown> = {},
        headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
      ): Promise<{ status: number; body: any }> {
        const res = fakeRes();
        await postImprove({ headers, query: {}, body: bodyIn } as any, res as any);
        return { status: res.statusCode, body: res.body };
      }

      function insertAgent(o: {
        id: string; name: string; description?: string; claimedAt?: string | null; orgNr?: string | null;
      }): void {
        testDb.prepare(
          `INSERT INTO agents (
            id, name, description, provider, contact_email, url, role, api_key, claimed_at, org_nr
          ) VALUES (?, ?, ?, 't', 'x@example.com', 'https://example.com', 'producer', ?, ?, ?)`,
        ).run(o.id, o.name, o.description ?? "", `key-${o.id}`, o.claimedAt ?? null, o.orgNr ?? null);
      }

      function insertKnowledge(agentId: string, o: {
        about?: string | null; website?: string | null; address?: string | null; postalCode?: string | null;
        curatedFields?: Record<string, unknown>; fieldProvenance?: Record<string, unknown>;
      } = {}): void {
        testDb.prepare(
          `INSERT INTO agent_knowledge (agent_id, about, website, address, postal_code, curated_fields, field_provenance, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          agentId, o.about ?? null, o.website ?? null, o.address ?? null, o.postalCode ?? null,
          JSON.stringify(o.curatedFields ?? {}), JSON.stringify(o.fieldProvenance ?? {}), new Date().toISOString(),
        );
      }

      function insertQueueRow(o: {
        agentId: string; agentName: string; flaggedFields: string[]; priorityTier: string; cause?: string; status?: string;
      }): void {
        testDb.prepare(
          `INSERT INTO agents_tynne_profiler_queue
             (id, agent_id, agent_name, flagged_fields, priority_tier, cause, status, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        ).run(
          `q-${o.agentId}`, o.agentId, o.agentName, JSON.stringify(o.flaggedFields), o.priorityTier,
          o.cause ?? "no_source", o.status ?? "pending",
        );
      }

      function readAgent(id: string): any { return testDb.prepare("SELECT * FROM agents WHERE id = ?").get(id); }
      function readKnowledge(agentId: string): any { return testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId); }
      function readQueueRow(agentId: string): any { return testDb.prepare("SELECT * FROM agents_tynne_profiler_queue WHERE agent_id = ?").get(agentId); }
      function readAudit(agentId: string): any[] { return testDb.prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at ASC").all(agentId); }
      function clearAll(): void {
        testDb.exec("DELETE FROM agents");
        testDb.exec("DELETE FROM agent_knowledge");
        testDb.exec("DELETE FROM agent_knowledge_audit");
        testDb.exec("DELETE FROM agents_tynne_profiler_queue");
        fixtures.clear();
      }

      // ═══════════════════════════════════════════════════════════════════
      // (a) dry-run: real fetch/generate/judge calls, ZERO writes anywhere.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-dry", name: "Dry Run Gard", description: "kort tekst" });
        insertKnowledge("tp-dry", { website: "https://dryrungard.example" });
        insertQueueRow({ agentId: "tp-dry", agentName: "Dry Run Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://dryrungard.example", htmlResponse(SOURCE_HTML("Dry Run Gard")));

        const beforeAgent = readAgent("tp-dry");
        const beforeQueue = readQueueRow("tp-dry");
        const callsBefore = anthropicCallCount;

        const r = await callImprove({ agentIds: ["tp-dry"] });
        assertEq(r.status, 200, "a1: 200 OK");
        assertEq(r.body.dry_run, true, "a2: dry_run:true by default (apply omitted)");
        assertTrue(anthropicCallCount > callsBefore, "a3: real generation+judge calls were made (genuine preview)");

        const afterAgent = readAgent("tp-dry");
        const afterQueue = readQueueRow("tp-dry");
        assertEq(afterAgent.description, beforeAgent.description, "a4: agents.description completely unchanged");
        assertEq(afterQueue.cause, beforeQueue.cause, "a5: queue row cause unchanged (dry-run touches NOTHING in the queue table either)");
        assertEq(afterQueue.status, beforeQueue.status, "a6: queue row status unchanged");
        assertEq(afterQueue.last_seen_at, beforeQueue.last_seen_at, "a7: queue row last_seen_at unchanged (not even bumped)");
        assertEq(testDb.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get(), { n: 0 }, "a8: no audit rows");

        const rowResult = r.body.results.find((x: any) => x.agent_id === "tp-dry");
        assertTrue(!!rowResult, "a9: row appears in response");
        assertEq(rowResult.fields.description.outcome, "approved", "a10: dry-run reports 'approved' (would-write), not 'written'");
        assertTrue(typeof rowResult.fields.description.preview === "string" && rowResult.fields.description.preview.length > 0, "a11: response includes a preview of the generated candidate");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) apply: approved candidate written correctly, provenance merged
      //     (preserving an unrelated existing field), audit row correct,
      //     queue row resolved.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-apply", name: "Apply Gard", description: "kort tekst" });
        insertKnowledge("tp-apply", {
          website: "https://applygard.example",
          fieldProvenance: { phone: { sources: [{ source_type: "owner", value: "12345678", fetched_at: "2026-01-01T00:00:00.000Z" }] } },
        });
        insertQueueRow({ agentId: "tp-apply", agentName: "Apply Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://applygard.example", htmlResponse(SOURCE_HTML("Apply Gard")));

        const before = readAgent("tp-apply");
        const r = await callImprove({ agentIds: ["tp-apply"], apply: true });
        assertEq(r.status, 200, "b1: 200 OK");
        assertEq(r.body.dry_run, false, "b2: dry_run:false under apply:true");

        const after = readAgent("tp-apply");
        assertTrue(after.description !== before.description, "b3: agents.description WAS changed");
        assertTrue(after.description.includes("Apply Gard"), "b4: new description is the generated, judge-approved candidate");

        const know = readKnowledge("tp-apply");
        const prov = JSON.parse(know.field_provenance);
        assertTrue(!!prov.phone, "b5: field_provenance merge PRESERVES the unrelated existing 'phone' entry");
        assertTrue(!!prov.description, "b6: field_provenance now carries a 'description' entry");
        assertEq(prov.description.sources?.[0]?.source_type ?? prov.description[0]?.source_type, "homepage", "b7: description provenance source_type is 'homepage'");

        const audit = readAudit("tp-apply");
        assertEq(audit.length, 1, "b8: exactly one audit row written");
        assertEq(audit[0].field_name, "description", "b9: audit field_name is 'description'");
        assertEq(audit[0].old_value, before.description, "b10: audit old_value matches the pre-write value");
        assertEq(audit[0].new_value, after.description, "b11: audit new_value matches the written value");
        assertEq(audit[0].changed_by, "system", "b12: audit changed_by is 'system'");

        const queueRow = readQueueRow("tp-apply");
        assertEq(queueRow.status, "resolved", "b13: queue row flipped to 'resolved'");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c) judge-reject: content untouched, queue cause updated, no audit.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-reject", name: "Judge Reject Gard", description: "kort tekst" });
        insertKnowledge("tp-reject", { website: "https://judgerejectgard.example" });
        insertQueueRow({ agentId: "tp-reject", agentName: "Judge Reject Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://judgerejectgard.example", htmlResponse(SOURCE_HTML("Judge Reject Gard")));

        const before = readAgent("tp-reject");
        const r = await callImprove({ agentIds: ["tp-reject"], apply: true });
        const after = readAgent("tp-reject");
        assertEq(after.description, before.description, "c1: description untouched on judge rejection");
        assertEq(testDb.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id='tp-reject'").get(), { n: 0 }, "c2: no audit row");

        const queueRow = readQueueRow("tp-reject");
        assertEq(queueRow.status, "pending", "c3: queue row stays pending");
        assertEq(queueRow.cause, "judge_rejected", "c4: queue cause updated to 'judge_rejected'");

        const rowResult = r.body.results.find((x: any) => x.agent_id === "tp-reject");
        assertEq(rowResult.outcome, "unresolved", "c5: response row outcome is 'unresolved'");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (d) missing website -> no_source, everything untouched.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-nosrc", name: "No Source Gard", description: "kort tekst" });
        insertKnowledge("tp-nosrc", { website: null });
        insertQueueRow({ agentId: "tp-nosrc", agentName: "No Source Gard", flaggedFields: ["description"], priorityTier: "description_only", cause: "no_source" });

        const before = readAgent("tp-nosrc");
        const beforeQueue = readQueueRow("tp-nosrc");
        const callsBefore = anthropicCallCount;
        const r = await callImprove({ agentIds: ["tp-nosrc"], apply: true });
        assertEq(anthropicCallCount, callsBefore, "d1: no generation/judge call attempted — no source to generate from");
        const after = readAgent("tp-nosrc");
        const afterQueue = readQueueRow("tp-nosrc");
        assertEq(after.description, before.description, "d2: content untouched");
        assertEq(afterQueue.cause, "no_source", "d3: cause stays 'no_source'");
        assertEq(afterQueue.last_seen_at, beforeQueue.last_seen_at, "d4: queue row genuinely untouched (last_seen_at unchanged, no no-op write)");
        const rowResult = r.body.results.find((x: any) => x.agent_id === "tp-nosrc");
        assertEq(rowResult.fields.description.outcome, "no_source", "d5: response reports no_source for the field");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) NEGATIVE CONTROL — the immediate-before-write re-check is real.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        // (e1) row-level claimed_at race: locked AFTER judge approval.
        insertAgent({ id: "tp-race-lock", name: "Race Lock Gard", description: "kort tekst" });
        insertKnowledge("tp-race-lock", { website: "https://racelockgard.example" });
        insertQueueRow({ agentId: "tp-race-lock", agentName: "Race Lock Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://racelockgard.example", htmlResponse(SOURCE_HTML("Race Lock Gard")));

        const before = readAgent("tp-race-lock");
        const r1 = await callImprove({ agentIds: ["tp-race-lock"], apply: true });
        const after = readAgent("tp-race-lock");
        assertEq(after.description, before.description, "e1: write BLOCKED — description untouched despite judge approval (row claimed mid-flight)");
        assertEq(testDb.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id='tp-race-lock'").get(), { n: 0 }, "e2: no audit row for the raced write");
        const rowResult1 = r1.body.results.find((x: any) => x.agent_id === "tp-race-lock");
        assertEq(rowResult1.fields.description.outcome, "write_lock_race", "e3: response reports 'write_lock_race', proving the recheck fired (not just present, actually blocking)");

        // (e2) per-field curated_fields race: locked AFTER judge approval.
        insertAgent({ id: "tp-race-curated", name: "Race Curated Gard", description: "kort tekst" });
        insertKnowledge("tp-race-curated", { website: "https://racecuratedgard.example" });
        insertQueueRow({ agentId: "tp-race-curated", agentName: "Race Curated Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://racecuratedgard.example", htmlResponse(SOURCE_HTML("Race Curated Gard")));

        const before2 = readAgent("tp-race-curated");
        const r2 = await callImprove({ agentIds: ["tp-race-curated"], apply: true });
        const after2 = readAgent("tp-race-curated");
        assertEq(after2.description, before2.description, "e4: write BLOCKED — description untouched (field curated-locked mid-flight)");
        const rowResult2 = r2.body.results.find((x: any) => x.agent_id === "tp-race-curated");
        assertEq(rowResult2.fields.description.outcome, "write_lock_race", "e5: response reports 'write_lock_race' for the curated-field race too");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (f) batch-size cap (AC5): apply + limit>20 without override -> 400,
      //     zero work; confirm_large_batch lifts it; dry-run never capped.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        for (let i = 0; i < 25; i++) {
          insertAgent({ id: `tp-batch-${i}`, name: `Batch Gard ${i}`, description: "kort tekst" });
          insertQueueRow({ agentId: `tp-batch-${i}`, agentName: `Batch Gard ${i}`, flaggedFields: ["description"], priorityTier: "description_only" });
        }
        const callsBefore = anthropicCallCount;

        const capped = await callImprove({ apply: true, limit: 25 });
        assertEq(capped.status, 400, "f1: apply + limit>20 without override -> 400");
        assertEq(anthropicCallCount, callsBefore, "f2: zero generation/judge work performed on refusal");
        assertEq(testDb.prepare("SELECT COUNT(*) AS n FROM agents_tynne_profiler_queue WHERE status != 'pending'").get(), { n: 0 }, "f3: zero queue writes on refusal");

        const overridden = await callImprove({ apply: true, limit: 25, confirm_large_batch: true });
        assertEq(overridden.status, 200, "f4: confirm_large_batch:true lifts the cap");
        assertEq(overridden.body.processed, 25, "f5: all 25 rows processed once overridden");

        // Reset for the dry-run-uncapped check.
        clearAll();
        for (let i = 0; i < 25; i++) {
          insertAgent({ id: `tp-dry-batch-${i}`, name: `Dry Batch Gard ${i}`, description: "kort tekst" });
          insertQueueRow({ agentId: `tp-dry-batch-${i}`, agentName: `Dry Batch Gard ${i}`, flaggedFields: ["description"], priorityTier: "description_only" });
        }
        const dryUncapped = await callImprove({ limit: 25 });
        assertEq(dryUncapped.status, 200, "f6: dry-run with limit>20 is NEVER capped — no confirm_large_batch needed");
        assertEq(dryUncapped.body.processed, 25, "f7: all 25 rows processed in dry-run");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (g) aggregator-host website (facebook.com) rejected defensively —
      //     never fetched.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-agg", name: "Aggregator Gard", description: "kort tekst" });
        insertKnowledge("tp-agg", { website: "https://facebook.com/aggregatorgard" });
        insertQueueRow({ agentId: "tp-agg", agentName: "Aggregator Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        // Deliberately NO fixture for this URL — if the route ever fetched
        // it, the stub's notFoundResponse() default would silently mask the
        // bug as a plain fetch-failure instead of the DISTINCT aggregator
        // cause this test asserts on.

        const r = await callImprove({ agentIds: ["tp-agg"], apply: true });
        const rowResult = r.body.results.find((x: any) => x.agent_id === "tp-agg");
        assertEq(rowResult.fields.description.outcome, "source_aggregator_host", "g1: aggregator host rejected with its own distinct cause");
        const queueRow = readQueueRow("tp-agg");
        assertEq(queueRow.cause, "source_aggregator_host", "g2: queue cause recorded as source_aggregator_host");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (h) fetch failure (404) and empty-content page both -> "no usable
      //     source", never fabricated.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-404", name: "Dead Link Gard", description: "kort tekst" });
        insertKnowledge("tp-404", { website: "https://deadlinkgard.example" });
        insertQueueRow({ agentId: "tp-404", agentName: "Dead Link Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        // No fixture -> stub returns notFoundResponse() (404) by default.

        insertAgent({ id: "tp-empty", name: "Empty Page Gard", description: "kort tekst" });
        insertKnowledge("tp-empty", { website: "https://emptypagegard.example" });
        insertQueueRow({ agentId: "tp-empty", agentName: "Empty Page Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://emptypagegard.example", htmlResponse("<html><head></head><body></body></html>"));

        const r = await callImprove({ agentIds: ["tp-404", "tp-empty"], apply: true });
        const r404 = r.body.results.find((x: any) => x.agent_id === "tp-404");
        const rEmpty = r.body.results.find((x: any) => x.agent_id === "tp-empty");
        assertEq(r404.fields.description.outcome, "source_fetch_failed", "h1: 404 fetch -> source_fetch_failed");
        assertEq(rEmpty.fields.description.outcome, "source_fetch_failed", "h2: empty-content page -> source_fetch_failed (same 'no usable source' cause)");
        assertEq(readAgent("tp-404").description, "kort tekst", "h3: no fabrication on fetch failure");
        assertEq(readAgent("tp-empty").description, "kort tekst", "h4: no fabrication on empty content");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (i) generation escape sentinel ("not enough material") ->
      //     generation_failed, no write.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-genfail", name: "Gen Fail Gard", description: "kort tekst" });
        insertKnowledge("tp-genfail", { website: "https://genfailgard.example" });
        insertQueueRow({ agentId: "tp-genfail", agentName: "Gen Fail Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        fixtures.set("https://genfailgard.example", htmlResponse(SOURCE_HTML("Gen Fail Gard")));

        const before = readAgent("tp-genfail");
        const r = await callImprove({ agentIds: ["tp-genfail"], apply: true });
        const after = readAgent("tp-genfail");
        assertEq(after.description, before.description, "i1: no write when generation returns the escape sentinel");
        const rowResult = r.body.results.find((x: any) => x.agent_id === "tp-genfail");
        assertEq(rowResult.fields.description.outcome, "generation_failed", "i2: response reports generation_failed");
        const queueRow = readQueueRow("tp-genfail");
        assertEq(queueRow.cause, "generation_failed", "i3: queue cause updated to generation_failed");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (j) partial resolution: both_fields row where description is
      //     approved+written and about is judge-rejected — description
      //     writes, about stays untouched, queue row narrows to
      //     flagged_fields:['about'] / priority_tier:'about_only' / stays
      //     'pending' (NOT resolved — only fully-cleared rows resolve).
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "tp-partial", name: "Partial Reject Gard", description: "kort tekst" });
        insertKnowledge("tp-partial", { about: "kort om-tekst", website: "https://partialgard.example" });
        insertQueueRow({ agentId: "tp-partial", agentName: "Partial Reject Gard", flaggedFields: ["description", "about"], priorityTier: "both_fields" });
        fixtures.set("https://partialgard.example", htmlResponse(SOURCE_HTML("Partial Reject Gard")));

        const beforeAbout = readKnowledge("tp-partial").about;
        const r = await callImprove({ agentIds: ["tp-partial"], apply: true });
        const after = readAgent("tp-partial");
        const afterAbout = readKnowledge("tp-partial").about;

        assertTrue(after.description !== "kort tekst" && after.description.includes("Partial Reject Gard"), "k1: description WAS written (its own candidate carries no reject marker, judge approves)");
        assertEq(afterAbout, beforeAbout, "k2: about untouched (its own judge call AVVIS'd)");

        const queueRow = readQueueRow("tp-partial");
        assertEq(queueRow.status, "pending", "k3: row stays pending — NOT fully resolved");
        assertEq(JSON.parse(queueRow.flagged_fields), ["about"], "k4: flagged_fields narrowed to just the still-unresolved field");
        assertEq(queueRow.priority_tier, "about_only", "k5: priority_tier recomputed for the narrowed field set");
        assertEq(queueRow.cause, "judge_rejected", "k6: cause reflects the remaining field's outcome");

        const rowResult = r.body.results.find((x: any) => x.agent_id === "tp-partial");
        assertEq(rowResult.outcome, "partial", "k7: response row outcome is 'partial'");
        assertEq(rowResult.fields.description.outcome, "written", "k8: description field outcome is 'written'");
        assertEq(rowResult.fields.about.outcome, "judge_rejected", "k9: about field outcome is 'judge_rejected'");

        const audit = readAudit("tp-partial");
        assertEq(audit.length, 1, "k10: exactly one audit row (only the field that actually wrote)");
        assertEq(audit[0].field_name, "description", "k11: the audit row is for 'description', not 'about'");
      }

      // Missing/invalid admin key -> 403/503, zero work.
      clearAll();
      {
        insertAgent({ id: "tp-auth", name: "Auth Gard", description: "kort tekst" });
        insertQueueRow({ agentId: "tp-auth", agentName: "Auth Gard", flaggedFields: ["description"], priorityTier: "description_only" });
        const callsBefore = anthropicCallCount;
        const res = fakeRes();
        await postImprove({ headers: {}, query: {}, body: { agentIds: ["tp-auth"], apply: true } } as any, res as any);
        assertEq(res.statusCode, 403, "j1: missing X-Admin-Key -> 403");
        assertEq(anthropicCallCount, callsBefore, "j2: no work performed without a valid admin key");
      }
    } catch (err) {
      failed++;
      failures.push(`admin-agents-tynne-profiler-improve: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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

// Standalone runner: `npx tsx src/routes/admin-agents-tynne-profiler-improve.test.ts`
if (require.main === module) {
  console.log("── admin-agents tynne-profiler-improve (dev-request 2026-08-15-tynne-profiler-forbedringsloype, Slice 2) unit tests ──");
  runAdminAgentsTynneProfilerImproveTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-tynne-profiler-improve: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

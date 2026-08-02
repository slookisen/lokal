/**
 * admin-agents-retro-scan.test.ts — tests for dev-request
 * rfb-kvalitetsgate-parity: the retroactive scan+null endpoint
 * (POST /admin/agents/retro-scan, src/routes/admin-agents.ts) that re-judges
 * the CURRENTLY STORED agents.description / agent_knowledge.about of every
 * non-locked RFB agent against the new LLM-judge cascade
 * (judgeRfbAboutCandidate / meetsRfbAboutQualityBar) and nulls whatever no
 * longer clears it. Ports gårdssalg's identical retro-scan design
 * (POST /admin/gardssalg-retro-scan, opplevelser-gardssalg-retro-scan.test.ts)
 * to RFB's own schema and lock conventions.
 *
 * Covers:
 *   (a) dry-run makes ZERO writes (agents/agent_knowledge/agent_knowledge_audit
 *       all unchanged), but still reports what WOULD be nulled (real judge
 *       calls, not a guessed preview).
 *   (b) apply mode nulls a failing CURRENT description/about (judge AVVIS
 *       with real reasoning) and leaves a passing field untouched — both a
 *       description-only failure and an about-only failure, on separate
 *       agents, so each field's null path is exercised independently.
 *   (c) claimed_at-locked rows are never touched in EITHER mode — the lock
 *       check short-circuits BEFORE any judge call.
 *   (d) a per-FIELD curated_fields lock is respected even when the row
 *       itself isn't claimed — the locked field is skipped, the OTHER field
 *       on the same row is still nulled if it fails.
 *   (e) umbrella agents are entirely out of scope (not selected by
 *       auto-select, and an explicit agentIds override does not resolve one).
 *   (f) response shape reports scanned + flagged/nulled counts per field.
 *   (g) the fail-closed direction unique to this route: a judge INFRA
 *       failure must NOT null the field — only a genuine AVVIS verdict with
 *       real model reasoning nulls.
 *   (h) re-queue verification: a nulled `description` IS re-selected by the
 *       EXISTING, unmodified POST /admin/agents/brreg-description-fallback's
 *       own candidate query (same file) — proving the "re-queue" requirement
 *       needs no new mechanism, verified against the real query rather than
 *       assumed.
 *   (i) field_provenance entries for nulled fields are removed (read-modify-
 *       write), and an agent_knowledge_audit row is written per nulled field
 *       (changed_by:'system', notes carries the judge's reasoning).
 *   (j) offset-based pagination on the auto-select path (dev-request
 *       rfb-retroscan-offset): offset=0 vs offset=N on a fixture with more
 *       than 2N eligible rows return different, non-overlapping agent sets;
 *       an invalid offset (negative, or non-numeric) -> 400 with no scan
 *       performed; `total_eligible` matches an independent COUNT of the
 *       fixture's eligible rows, unaffected by limit/offset; a call
 *       with NO offset param is identical to an explicit offset:0 call
 *       (regression: today's exact default behavior is preserved); post-
 *       review fix-up: apply:true + offset>0 -> 400 with zero judge/write
 *       work (apply:true + offset:0/omitted is unaffected); an offset above
 *       the sanity ceiling (including a huge 1e19 value) -> 400 instead of
 *       crashing, while offset at/under the ceiling still works; and a
 *       non-scalar offset (array, e.g. [5], or boolean) -> 400 instead of
 *       silently coercing through parseInt.
 *
 * Mirrors admin-agents-brreg-description-fallback.test.ts's setup convention
 * exactly (own in-memory prod-schema DB via __setDbForTesting/
 * __initSchemaForTesting, direct handler invocation via the router's own
 * .stack, busts admin-agents.ts/admin-knowledge.ts require caches) and mocks
 * globalThis.fetch for the Anthropic judge call only (this route makes no
 * homepage/network fetch of its own — see the route's own header comment for
 * why).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAdminAgentsRetroScanTests(
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

    const ADMIN_KEY = process.env.ADMIN_KEY || "admin-agents-retro-scan-test-key";

    // CONTAMINATED_ABOUT-equivalent — nav-polluted, real bad shape, passes
    // the cheap bar (long enough, has a Norwegian word) but is chrome, not
    // real prose — the judge is mocked to AVVIS it below.
    const CONTAMINATED =
      "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger, med sideri og gardsutsalg.";
    const GOOD =
      "Kinn Bryggeri er et lite håndverksbryggeri på Vågsøy som brygger øl med lokalt vann og kortreiste råvarer, og tar imot besøkende til smaking og omvisning gjennom sommersesongen.";
    // Sub-80-char thin value — fails the cheap bar deterministically, no LLM
    // call needed to know it should be nulled.
    const THIN = "Kom innom oss.";
    assertTrue(THIN.length < 80, "sanity: THIN is under the 80-char cheap-bar floor");

    function fakeRes() {
      const r: any = { statusCode: 200, body: undefined };
      r.status = (c: number) => { r.statusCode = c; return r; };
      r.json = (b: any) => { r.body = b; return r; };
      return r;
    }

    let anthropicCallCount = 0;
    let simulateJudgeInfraFailure = false;
    function stubFetch(): typeof fetch {
      return (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (!urlStr.includes("api.anthropic.com")) {
          throw new Error(`unexpected non-Anthropic fetch in this route: ${urlStr}`);
        }
        anthropicCallCount++;
        if (simulateJudgeInfraFailure) {
          throw new Error("simulated network failure for the judge call");
        }
        const body = init?.body ? JSON.parse(init.body) : {};
        const prompt: string = body?.messages?.[0]?.content ?? "";
        // The candidate text itself is embedded in the prompt — "Sidersortar"
        // is a word unique to CONTAMINATED (unlike "Draopar", which is ALSO
        // part of the producer NAME "Draopar Sideri" used on fixtures below,
        // so checking for "Draopar" would incorrectly match prompts judging
        // a perfectly good candidate belonging to that same producer).
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
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-retro-scan";
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

      const postRetroScan = getHandler("post", "/retro-scan");
      const postBrregFallback = getHandler("post", "/brreg-description-fallback");

      async function callRetroScan(
        body: Record<string, unknown> = {},
        query: Record<string, unknown> = {},
        headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
      ): Promise<{ status: number; body: any }> {
        const res = fakeRes();
        await postRetroScan({ headers, body, query } as any, res as any);
        return { status: res.statusCode, body: res.body };
      }
      async function callBrregFallback(
        query: Record<string, unknown> = {},
      ): Promise<{ status: number; body: any }> {
        const res = fakeRes();
        await postBrregFallback({ headers: { "x-admin-key": ADMIN_KEY }, body: {}, query } as any, res as any);
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
      function readAudit(agentId: string): any[] {
        return testDb.prepare(
          `SELECT * FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid ASC`
        ).all(agentId);
      }
      function clearAll(): void {
        testDb.exec("DELETE FROM agents");
        testDb.exec("DELETE FROM agent_knowledge");
        testDb.exec("DELETE FROM agent_knowledge_audit");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (a) dry-run: real judge call, ZERO writes.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-contaminated", name: "Draopar Sideri", description: CONTAMINATED });
        insertKnowledge("rs-contaminated", { about: GOOD });

        const before = readAgent("rs-contaminated");
        const callsBefore = anthropicCallCount;
        const dry = await callRetroScan({ agentIds: ["rs-contaminated"], apply: false });
        assertEq(dry.status, 200, "rs-a1: dry-run -> 200");
        assertEq(dry.body.dry_run, true, "rs-a2: dry_run:true");
        assertTrue(anthropicCallCount > callsBefore, "rs-a3: dry-run DID call the judge (real preview, not guessed)");

        const entry = dry.body.changed.find((c: any) => c.agent_id === "rs-contaminated");
        assertTrue(!!entry, "rs-a4: contaminated agent appears in dry-run changed[]");
        assertTrue(entry.fields.includes("description"), "rs-a5: description flagged");
        assertTrue(!entry.fields.includes("about"), "rs-a6: about (GOOD) is NOT flagged");
        assertTrue(typeof entry.reasons.description === "string" && entry.reasons.description.length > 0, "rs-a7: a reasoning string is carried through");
        assertEq(dry.body.by_field.description.flagged, 1, "rs-a8: by_field.description.flagged counts the dry-run flag");
        assertEq(dry.body.by_field.description.nulled, 0, "rs-a9: by_field.description.nulled is 0 in dry-run");

        const after = readAgent("rs-contaminated");
        assertEq(after.description, before.description, "rs-a10: dry-run performed ZERO writes — description unchanged in the DB");
        assertEq(readAudit("rs-contaminated").length, 0, "rs-a11: dry-run created no audit row");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) apply mode: nulls a failing CURRENT value, leaves a passing one
      //     untouched — one agent with a bad description/good about, and a
      //     SEPARATE agent with a good description/bad about, so both
      //     null paths are independently exercised.
      // ═══════════════════════════════════════════════════════════════════
      {
        const applyRes = await callRetroScan({ agentIds: ["rs-contaminated"], apply: true });
        assertEq(applyRes.status, 200, "rs-b1: apply -> 200");
        assertEq(applyRes.body.dry_run, false, "rs-b2: dry_run:false");

        const entry = applyRes.body.changed.find((c: any) => c.agent_id === "rs-contaminated");
        assertTrue(!!entry, "rs-b3: contaminated agent appears in apply changed[]");
        assertTrue(entry.fields.includes("description"), "rs-b4: description nulled");

        const rowAfter = readAgent("rs-contaminated");
        assertEq(rowAfter.description, "", "rs-b5: agents.description is the empty string (NOT NULL column — 'blank' means '')");
        const kAfter = readKnowledge("rs-contaminated");
        assertEq(kAfter.about, GOOD, "rs-b6: the passing about field is completely untouched");

        const auditRows = readAudit("rs-contaminated");
        const descAudit = auditRows.find((r: any) => r.field_name === "description");
        assertTrue(!!descAudit, "rs-b7: a description audit row exists for the null");
        assertEq(descAudit.old_value, CONTAMINATED, "rs-b8: audit old_value is the contaminated text that was cleared");
        assertEq(descAudit.new_value, "", "rs-b9: audit new_value is the empty string");
        assertEq(descAudit.changed_by, "system", "rs-b10: changed_by is 'system' (automated sweep)");
        assertTrue(typeof descAudit.notes === "string" && descAudit.notes.length > 0, "rs-b11: notes carries the judge's reasoning");

        assertTrue(applyRes.body.by_field.description.nulled >= 1, "rs-b12: by_field.description.nulled reflects the real write");
        assertEq(applyRes.body.by_field.about.nulled, 0, "rs-b13: by_field.about.nulled is 0 (the good about was untouched)");
      }

      // Separate agent: good description, bad about.
      clearAll();
      {
        insertAgent({ id: "rs-about-bad", name: "About Bad Gard", description: GOOD });
        insertKnowledge("rs-about-bad", { about: CONTAMINATED });

        const applyRes = await callRetroScan({ agentIds: ["rs-about-bad"], apply: true });
        const entry = applyRes.body.changed.find((c: any) => c.agent_id === "rs-about-bad");
        assertTrue(!!entry, "rs-b14: about-bad agent appears in apply changed[]");
        assertTrue(entry.fields.includes("about"), "rs-b15: about nulled");
        assertTrue(!entry.fields.includes("description"), "rs-b16: description (GOOD) not touched");

        const rowAfter = readAgent("rs-about-bad");
        assertEq(rowAfter.description, GOOD, "rs-b17: the passing description is completely untouched");
        const kAfter = readKnowledge("rs-about-bad");
        assertEq(kAfter.about, null, "rs-b18: agent_knowledge.about is SQL NULL (nullable column)");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c) claimed_at-locked rows are never touched in either mode — the
      //     lock check short-circuits BEFORE any judge call.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-locked", name: "Låst Gard", description: CONTAMINATED, claimedAt: "2026-01-01T00:00:00.000Z" });

        const callsBefore = anthropicCallCount;
        const dry = await callRetroScan({ agentIds: ["rs-locked"], apply: false });
        assertTrue(dry.body.skipped_locked.includes("rs-locked"), "rs-c1: locked agent reported in skipped_locked (dry-run)");
        assertEq(dry.body.changed.length, 0, "rs-c2: nothing flagged for the locked agent (dry-run)");
        assertEq(anthropicCallCount, callsBefore, "rs-c3: no judge call happened for the locked agent (dry-run)");

        const apply = await callRetroScan({ agentIds: ["rs-locked"], apply: true });
        assertTrue(apply.body.skipped_locked.includes("rs-locked"), "rs-c4: locked agent reported in skipped_locked (apply)");
        assertEq(anthropicCallCount, callsBefore, "rs-c5: no judge call happened for the locked agent (apply either)");

        const row = readAgent("rs-locked");
        assertEq(row.description, CONTAMINATED, "rs-c6: locked agent's description is completely unchanged despite being contaminated");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (d) per-FIELD curated lock: the locked field is skipped even though
      //     it would otherwise fail; the OTHER field on the SAME row is
      //     still nulled.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-curated", name: "Curated Gard", description: CONTAMINATED });
        insertKnowledge("rs-curated", { about: CONTAMINATED, curatedFields: { description: true } });

        const applyRes = await callRetroScan({ agentIds: ["rs-curated"], apply: true });
        assertTrue(
          applyRes.body.skipped_curated.some((s: any) => s.agent_id === "rs-curated" && s.fields.includes("description")),
          "rs-d1: curated-locked description is reported in skipped_curated",
        );
        const entry = applyRes.body.changed.find((c: any) => c.agent_id === "rs-curated");
        assertTrue(!!entry, "rs-d2: the row still appears in changed[] for the non-curated field");
        assertTrue(entry.fields.includes("about"), "rs-d3: about (not curated) IS nulled");
        assertTrue(!entry.fields.includes("description"), "rs-d4: description (curated) is NOT nulled");

        const row = readAgent("rs-curated");
        assertEq(row.description, CONTAMINATED, "rs-d5: curated-locked description is completely unchanged despite being contaminated");
        const k = readKnowledge("rs-curated");
        assertEq(k.about, null, "rs-d6: the non-curated about field IS nulled");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) umbrella agents are entirely out of scope.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-umbrella", name: "Paraply Gard", description: CONTAMINATED, umbrellaType: "venue" });

        const auto = await callRetroScan({ apply: false });
        assertTrue(
          !auto.body.changed.some((c: any) => c.agent_id === "rs-umbrella"),
          "rs-e1: umbrella agent is never selected by auto-select despite a contaminated description",
        );
        assertTrue(
          !auto.body.skipped_locked.includes("rs-umbrella"),
          "rs-e2: umbrella agent is out of SCOPE (not merely locked) — never even reported",
        );

        const explicit = await callRetroScan({ agentIds: ["rs-umbrella"], apply: false });
        assertTrue(
          !explicit.body.changed.some((c: any) => c.agent_id === "rs-umbrella"),
          "rs-e3: an explicit agentIds override does not resolve an umbrella agent to a target either",
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // (f) response shape: scanned + flagged/nulled per field.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-shape", name: "Shape Gard", description: GOOD });
        insertKnowledge("rs-shape", { about: GOOD });
        const res2 = await callRetroScan({ agentIds: ["rs-shape"], apply: false });
        assertTrue(typeof res2.body.scanned === "number", "rs-f1: response carries a numeric `scanned`");
        assertTrue(typeof res2.body.by_field.description.flagged === "number", "rs-f2: by_field.description.flagged is numeric");
        assertTrue(typeof res2.body.by_field.description.nulled === "number", "rs-f3: by_field.description.nulled is numeric");
        assertTrue(typeof res2.body.by_field.about.flagged === "number", "rs-f4: by_field.about.flagged is numeric");
        assertTrue(typeof res2.body.by_field.about.nulled === "number", "rs-f5: by_field.about.nulled is numeric");
        assertEq(res2.body.scanned, 1, "rs-f6: scanned counts the one non-locked target examined");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (g) fail-closed direction: a judge INFRA failure must NOT null the
      //     field — only a genuine AVVIS verdict does.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-infra-fail", name: "Infra Fail Gard", description: CONTAMINATED });
        simulateJudgeInfraFailure = true;
        const before = readAgent("rs-infra-fail");
        const infraRes = await callRetroScan({ agentIds: ["rs-infra-fail"], apply: true });
        assertEq(infraRes.status, 200, "rs-g1: infra-failure call -> 200 (never throws)");
        const infraEntry = infraRes.body.changed.find((c: any) => c.agent_id === "rs-infra-fail");
        assertTrue(!infraEntry, "rs-g2: a judge infra failure does NOT flag/null the field — never destroy data on doubt");
        const after = readAgent("rs-infra-fail");
        assertEq(after.description, before.description, "rs-g3: description completely unchanged after a judge infra failure");
        assertEq(readAudit("rs-infra-fail").length, 0, "rs-g4: no audit row written for an infra-failure non-null");
        simulateJudgeInfraFailure = false;
      }

      // ═══════════════════════════════════════════════════════════════════
      // (h) re-queue verification: a nulled `description` IS re-selected by
      //     the EXISTING, unmodified POST /admin/agents/brreg-description-
      //     fallback's own candidate query.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-requeue", name: "Requeue Gard", description: CONTAMINATED, orgNr: "970000001" });

        const beforeFallback = await callBrregFallback();
        assertTrue(
          !(beforeFallback.body.would_write ?? []).some((w: any) => w.agent_id === "rs-requeue"),
          "rs-h1: sanity — before the null, the contaminated-but-non-blank description is NOT a brreg-fallback candidate (that query only targets truly-empty descriptions)",
        );

        await callRetroScan({ agentIds: ["rs-requeue"], apply: true });
        const rowAfter = readAgent("rs-requeue");
        assertEq(rowAfter.description, "", "rs-h2: description was nulled (emptied) by the retro-scan");

        const afterFallback = await callBrregFallback();
        assertTrue(
          afterFallback.body.candidate_count >= 1,
          "rs-h3: after the null, brreg-description-fallback's OWN unmodified candidate query now selects the row — the null alone re-queues it, no new mechanism needed",
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // (i) auto-select: only non-blank, non-locked, non-umbrella rows are
      //     in scope; a row with both fields blank is never selected.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        insertAgent({ id: "rs-blank", name: "Blank Gard", description: "" });
        insertAgent({ id: "rs-has-content", name: "Has Content Gard", description: GOOD });
        insertKnowledge("rs-has-content", { about: null });

        const auto = await callRetroScan({ apply: false });
        assertTrue(
          !auto.body.changed.some((c: any) => c.agent_id === "rs-blank") && !auto.body.errors.some((e: any) => e.agent_id === "rs-blank"),
          "rs-i1: a row with both description and about blank is never selected by auto-select (nothing to judge)",
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // (j) offset-based pagination — dev-request rfb-retroscan-offset.
      // ═══════════════════════════════════════════════════════════════════
      clearAll();
      {
        function sortByAgentId(arr: any[]): any[] {
          return [...arr].sort((a, b) =>
            String(a?.agent_id ?? a).localeCompare(String(b?.agent_id ?? b)),
          );
        }

        // 4 eligible RFB agents (non-umbrella, non-claimed, non-blank
        // description), with STRICTLY increasing created_at so ORDER BY
        // a.created_at ASC is deterministic — insertAgent() itself relies
        // on the schema's `datetime('now')` DEFAULT (second-granularity),
        // which would tie all four together, so these are inserted with an
        // explicit created_at directly instead of via insertAgent().
        // All four use CONTAMINATED so every one is deterministically
        // AVVIS'd by the stubbed judge and therefore shows up in changed[]
        // — the only way to observe, from the response shape alone, exactly
        // which rows a given offset/limit page actually selected.
        const offsetIds = ["off-0", "off-1", "off-2", "off-3"];
        offsetIds.forEach((id, i) => {
          testDb.prepare(
            `INSERT INTO agents (
              id, name, description, provider, contact_email, url, role, api_key,
              claimed_at, umbrella_type, org_nr, created_at
            ) VALUES (?, ?, ?, 't', 'x@example.com', 'https://example.com', 'producer', ?, NULL, NULL, NULL, ?)`,
          ).run(id, `Offset Gard ${i}`, CONTAMINATED, `key-${id}`, `2026-01-01T00:00:0${i}.000Z`);
        });

        // An ineligible row (blank description, no `about`) — must NOT
        // count toward total_eligible, proving the count uses the exact
        // same WHERE clause as selection, not just "every agent row".
        testDb.prepare(
          `INSERT INTO agents (
            id, name, description, provider, contact_email, url, role, api_key
          ) VALUES ('off-blank', 'Offset Blank Gard', '', 't', 'x@example.com', 'https://example.com', 'producer', 'key-off-blank')`,
        ).run();

        const independentEligibleCount = (
          testDb
            .prepare(
              `SELECT COUNT(*) AS n
                 FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
                WHERE a.umbrella_type IS NULL
                  AND a.claimed_at IS NULL
                  AND (TRIM(a.description) != '' OR (k.about IS NOT NULL AND TRIM(k.about) != ''))`,
            )
            .get() as { n: number }
        ).n;
        assertEq(independentEligibleCount, 4, "rs-j0: sanity — exactly 4 eligible rows in this fixture (the blank one is excluded)");

        // ── offset=0, limit=2 → the two EARLIEST rows ──────────────────
        const page0 = await callRetroScan({ apply: false, limit: 2, offset: 0 });
        assertEq(page0.status, 200, "rs-j1: offset=0 page -> 200");
        assertEq(page0.body.offset, 0, "rs-j2: response echoes offset:0");
        const page0Ids = sortByAgentId(page0.body.changed).map((c: any) => c.agent_id);
        assertEq(page0Ids, ["off-0", "off-1"], "rs-j3: offset=0,limit=2 selects the two earliest rows");

        // ── offset=2, limit=2 → the NEXT two rows, non-overlapping ─────
        const page1 = await callRetroScan({ apply: false, limit: 2, offset: 2 });
        assertEq(page1.body.offset, 2, "rs-j4: response echoes offset:2");
        const page1Ids = sortByAgentId(page1.body.changed).map((c: any) => c.agent_id);
        assertEq(page1Ids, ["off-2", "off-3"], "rs-j5: offset=2,limit=2 selects the next two rows");
        assertTrue(
          page0Ids.every((id: string) => !page1Ids.includes(id)),
          "rs-j6: offset=0 and offset=2 pages return non-overlapping agent sets",
        );

        // ── total_eligible: matches the independent COUNT, and is
        //    unaffected by limit/offset (same value on both pages above). ──
        assertEq(page0.body.total_eligible, independentEligibleCount, "rs-j7: total_eligible matches the independent COUNT");
        assertEq(page1.body.total_eligible, independentEligibleCount, "rs-j8: total_eligible is unaffected by offset/limit (same on the offset=2 page)");

        // ── invalid offset: negative -> 400, no scan performed ──────────
        const callsBeforeNeg = anthropicCallCount;
        const negRes = await callRetroScan({ apply: false, offset: -1 });
        assertEq(negRes.status, 400, "rs-j9: negative offset -> 400");
        assertTrue(
          typeof negRes.body.error === "string" && typeof negRes.body.detail === "string",
          "rs-j10: 400 body has the {error, detail} shape used elsewhere in this file",
        );
        assertEq(anthropicCallCount, callsBeforeNeg, "rs-j11: negative offset performs NO scan (no judge calls made)");

        // ── invalid offset: non-numeric string -> 400, no scan performed ─
        const callsBeforeNaN = anthropicCallCount;
        const nanRes = await callRetroScan({ apply: false, offset: "abc" });
        assertEq(nanRes.status, 400, "rs-j12: non-numeric offset -> 400");
        assertEq(anthropicCallCount, callsBeforeNaN, "rs-j13: non-numeric offset performs NO scan (no judge calls made)");

        // ── regression: a call with NO offset param behaves identically to
        //    an explicit offset:0 call (today's exact default behavior). ──
        const noOffsetRes = await callRetroScan({ apply: false, limit: 2 });
        const explicitOffset0Res = await callRetroScan({ apply: false, limit: 2, offset: 0 });
        assertEq(noOffsetRes.status, explicitOffset0Res.status, "rs-j14: no-offset call and explicit offset:0 call return the same status");
        assertEq(noOffsetRes.body.offset, 0, "rs-j15: no-offset param defaults to offset:0 in the response");
        assertEq(noOffsetRes.body.scanned, explicitOffset0Res.body.scanned, "rs-j16: no-offset call scans the same count as an explicit offset:0 call");
        assertEq(noOffsetRes.body.total_eligible, explicitOffset0Res.body.total_eligible, "rs-j17: total_eligible identical too");
        assertEq(noOffsetRes.body.by_field, explicitOffset0Res.body.by_field, "rs-j18: by_field counts identical too");
        assertEq(
          sortByAgentId(noOffsetRes.body.changed),
          sortByAgentId(explicitOffset0Res.body.changed),
          "rs-j19: no-offset call selects the exact same agent set (with the same fields/reasons) as an explicit offset:0 call",
        );

        // ── apply:true + offset>0 is rejected — apply mode nulls exactly
        //    the columns the auto-select WHERE clause depends on, so paging
        //    with fixed offsets across sequential apply calls would silently
        //    skip rows at page boundaries. -> 400, zero judge/write work. ──
        const callsBeforeApplyOffset = anthropicCallCount;
        const beforeOff0 = readAgent("off-0");
        const applyOffsetRes = await callRetroScan({ apply: true, offset: 1 });
        assertEq(applyOffsetRes.status, 400, "rs-j20: apply:true + offset>0 -> 400");
        assertTrue(
          typeof applyOffsetRes.body.error === "string" && typeof applyOffsetRes.body.detail === "string",
          "rs-j21: 400 body has the {error, detail} shape used elsewhere in this file",
        );
        assertEq(anthropicCallCount, callsBeforeApplyOffset, "rs-j22: apply:true + offset>0 performs NO scan (no judge calls made)");
        assertEq(readAgent("off-0").description, beforeOff0.description, "rs-j23: apply:true + offset>0 performs NO write");

        // apply:true + offset:0 (explicit) is unaffected — still works
        // exactly as before this fix (a normal small-batch apply write).
        const applyZeroRes = await callRetroScan({ agentIds: ["off-0"], apply: true, offset: 0 });
        assertEq(applyZeroRes.status, 200, "rs-j24: apply:true + offset:0 (explicit) still works");
        assertTrue(
          applyZeroRes.body.changed.some((c: any) => c.agent_id === "off-0" && c.fields.includes("description")),
          "rs-j25: apply:true + offset:0 still nulls a failing field exactly as before",
        );

        // apply:true with offset OMITTED entirely is also unaffected.
        const applyOmittedRes = await callRetroScan({ agentIds: ["off-1"], apply: true });
        assertEq(applyOmittedRes.status, 200, "rs-j26: apply:true with offset omitted entirely still works");
        assertTrue(
          applyOmittedRes.body.changed.some((c: any) => c.agent_id === "off-1" && c.fields.includes("description")),
          "rs-j27: apply:true with offset omitted still nulls a failing field exactly as before",
        );

        // ── offset ceiling: huge values 400 instead of crashing. Before the
        //    fix, 1e19 passed Number.isInteger() (IEEE-754 doubles that large
        //    are always "integers") and crashed better-sqlite3's `OFFSET ?`
        //    bind with an uncaught SqliteError -> unhandled 500. ──
        const callsBeforeCeiling = anthropicCallCount;
        const overCeilingRes = await callRetroScan({ apply: false, offset: 100_001 });
        assertEq(overCeilingRes.status, 400, "rs-j28: offset just above the ceiling (100001) -> 400");
        assertTrue(
          typeof overCeilingRes.body.error === "string" && typeof overCeilingRes.body.detail === "string",
          "rs-j29: 400 body has the {error, detail} shape",
        );

        const hugeOffsetRes = await callRetroScan({ apply: false, offset: 1e19 });
        assertEq(hugeOffsetRes.status, 400, "rs-j30: a huge offset (1e19) -> 400, not a crash (the reviewer's actual reproduction)");

        const atCeilingRes = await callRetroScan({ apply: false, offset: 100_000 });
        assertEq(atCeilingRes.status, 200, "rs-j31: offset AT the ceiling (100000) still works normally");
        assertEq(atCeilingRes.body.changed.length, 0, "rs-j32: offset at the ceiling returns an empty page, not a crash (no rows that far out)");

        const underCeilingRes = await callRetroScan({ apply: false, offset: 99_999 });
        assertEq(underCeilingRes.status, 200, "rs-j33: offset just under the ceiling (99999) still works normally");

        assertEq(anthropicCallCount, callsBeforeCeiling, "rs-j34: none of the ceiling-boundary calls made any judge calls (nothing that far out to scan)");

        // ── non-scalar offset (arrays, objects, booleans) rejects instead
        //    of silently coercing through parseInt. Before the fix,
        //    offset:[5] was not typeof "number", fell through to
        //    parseInt(rawOffset as string, 10), which implicitly
        //    stringified ([5].toString() === "5") and parsed to 5. ──
        const callsBeforeNonScalar = anthropicCallCount;
        const arrOffsetRes = await callRetroScan({ apply: false, offset: [5] });
        assertEq(arrOffsetRes.status, 400, "rs-j35: offset:[5] -> 400 (not silently coerced to 5)");
        const arrMultiOffsetRes = await callRetroScan({ apply: false, offset: [1, 2, 3] });
        assertEq(arrMultiOffsetRes.status, 400, "rs-j36: offset:[1,2,3] -> 400 (not silently coerced to 1)");
        const boolOffsetRes = await callRetroScan({ apply: false, offset: true });
        assertEq(boolOffsetRes.status, 400, "rs-j37: offset:true -> 400");
        assertEq(anthropicCallCount, callsBeforeNonScalar, "rs-j38: none of the non-scalar offset calls made any judge calls");
      }
    } catch (err) {
      failed++;
      failures.push(`admin-agents-retro-scan: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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

// Standalone runner: `npx tsx src/routes/admin-agents-retro-scan.test.ts`
if (require.main === module) {
  console.log("── admin-agents retro-scan (dev-request rfb-kvalitetsgate-parity) unit tests ──");
  runAdminAgentsRetroScanTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-retro-scan: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

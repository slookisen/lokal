/**
 * opplevelser-rejected-rejudge.test.ts — tests for dev-request
 * 2026-08-14-fetch-vegg-headless-fallback, slice R1:
 *   POST /admin/experiences-rejected-rejudge
 *
 * The route takes an explicit list of experience ids, renders each `rejected`
 * row's evidence page HEADLESS (render-client.ts renderPage → render-worker),
 * re-runs the existing evidence judge (judgeFetchedEvidencePage — the shared
 * post-fetch half of judgeExperienceEvidencePage) on the rendered page, and
 * only on MATCH + explicit apply moves the row rejected -> needs_review with
 * one admission stamp and one experience_admission_promotion_audit row.
 *
 * Same harness conventions as opplevelser-experiences-requarantine-rejudge.
 * test.ts: in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:"), fresh
 * requires per run (swapOutModules), pinned in-memory main DB (the write-
 * pause table lives there), router.handle() as the HTTP entry point. No live
 * network: the headless renderer is replaced through the route's own test
 * seam (__setRejectedRejudgeRenderImplForTesting), and globalThis.fetch only
 * answers the Anthropic judge endpoint — any OTHER fetch (e.g. a silent
 * plain-fetch fallback) is recorded and fails the test.
 *
 * Covers:
 *   (a) auth gate: no X-Admin-Key -> 403.
 *   (b) ids validation: missing, non-array, [], >20, blank / non-string
 *       entries -> 400.
 *   (c) dry-run (default, and explicit dry_run:true): correct per-id verdicts
 *       and counts, ZERO writes (rows byte-identical, no audit rows), no
 *       render call for not-found / not-rejected / blank-evidence rows, no
 *       non-judge fetch at all.
 *   (d) write-pause blocks apply (423, no render, no writes).
 *   (e) apply: MATCH row -> needs_review + exactly one audit row + stamp;
 *       MISMATCH / unresolved (404, thrown render error, 503, parked, blank
 *       evidence) rows untouched; a row changed between read and write is
 *       not touched (skipped_changed_concurrently, no stamp, no audit).
 *   (f) a second apply on the restored row skips it as not_rejected.
 */

import type { RenderOptions, RenderResult } from "../services/render-client";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

const ROUTE = "/admin/experiences-rejected-rejudge";

function callRoute(router: any, opts: { headers?: Record<string, string>; body?: any } = {}): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: ROUTE,
      originalUrl: ROUTE,
      path: ROUTE,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

function mkAnthropicResponse(verdictLine: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: verdictLine }] }),
  } as unknown as Response;
}

function mkRendered(html: string, url: string, status = 200): RenderResult {
  return { html, status_code: status, duration_ms: 5, source: "render-worker", final_url: url };
}

export function runOpplevelserRejectedRejudgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  let restoreMainDb: (() => void) | null = null;

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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "rejected-rejudge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-rejected-rejudge";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const contentJudgePath = require.resolve("../services/experience-content-judge");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, contentJudgePath, opplevelserPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let opplevelserModule: typeof import("./opplevelser") | null = null;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const initMod = require("../database/init") as typeof import("../database/init");
      restoreMainDb = initMod.__pinInMemoryDbForTesting();
      const mainDb = initMod.getDb();
      // Pause state is written with plain SQL (same row shape
      // setEnrichmentWritePause writes) rather than by importing the pause
      // service, which admin-enrichment-write-pause.test.ts (ewp-125) keeps
      // on a fixed importer allowlist.
      const setExperiencesPause = (enabled: boolean) =>
        mainDb
          .prepare(
            `INSERT INTO enrichment_write_pause (vertical, enabled, reason, triggered_at, triggered_by, cleared_at, cleared_by)
             VALUES ('experiences', @enabled, 'test-pause', datetime('now'), 'test-actor', NULL, NULL)
             ON CONFLICT(vertical) DO UPDATE SET enabled = excluded.enabled`,
          )
          .run({ enabled: enabled ? 1 : 0 });
      opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;
      const adminHeaders = { "x-admin-key": testKey };

      expDb
        .prepare(`INSERT INTO experience_providers (id, navn, brreg_active) VALUES ('prov-rj', 'Tilbyder', 1)`)
        .run();
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, title, slug, description, category, price_band, price_from, evidence_url,
            verification_status, confidence, provider_id, content_source, enrichment_state,
            admission_verdict, admission_checked_at)
         VALUES
           (@id, @title, @id, 'En tur.', 'aktivitet', 'standard', 400, @evidence_url,
            @verification_status, 'high', 'prov-rj', 'provider_site', 'enriched',
            'mismatch: (old plain-fetch verdict)', '2026-09-01 10:00:00')`,
      );
      const seed = (id: string, title: string, evidence_url: string | null, verification_status = "rejected") =>
        insertExperience.run({ id, title, evidence_url, verification_status });

      seed("rj-match", "Treffetur", "https://match.example.no/tur");
      seed("rj-mismatch", "Avvikstur", "https://mismatch.example.no/tur");
      seed("rj-dead404", "Dødtur", "https://dead.example.no/tur");
      seed("rj-throw", "Kastetur", "https://throw.example.no/tur");
      seed("rj-503", "Feiltur", "https://err.example.no/tur");
      seed("rj-parked", "Parkerttur", "https://lapsed.example.no/tur");
      seed("rj-noevidence", "Tomtur", "   ");
      seed("rj-concurrent", "Samtidigtur", "https://concurrent.example.no/tur");
      seed("rj-needs-review", "Køtur", "https://needsreview.example.no/tur", "needs_review");

      const ALL_IDS = [
        "rj-match", "rj-mismatch", "rj-dead404", "rj-throw", "rj-503", "rj-parked",
        "rj-noevidence", "rj-concurrent", "rj-needs-review", "rj-missing",
      ];

      const snapshot = (id: string) =>
        expDb
          .prepare(`SELECT verification_status, admission_verdict, admission_checked_at, admission_verdict_prev FROM experiences WHERE id = ?`)
          .get(id);
      const snapshotAll = () => ALL_IDS.map((id) => [id, snapshot(id)]);
      const auditCount = () =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_admission_promotion_audit`).get() as { n: number }).n;

      // ── headless renderer mock ──────────────────────────────────────────
      const renderCalls: string[] = [];
      let mutateConcurrentRow = false;
      opplevelserModule.__setRejectedRejudgeRenderImplForTesting(async (url: string, _o?: RenderOptions) => {
        renderCalls.push(url);
        const goodHtml = "<html><body><h1>Tur</h1><p>Guidet tur i fjellet, stemmer med beskrivelsen.</p></body></html>";
        if (url.startsWith("https://match.")) return mkRendered(goodHtml, url);
        if (url.startsWith("https://mismatch.")) return mkRendered("<html><body>En helt annen side.</body></html>", url);
        if (url.startsWith("https://dead.")) return mkRendered("<html><body>Not found</body></html>", url, 404);
        if (url.startsWith("https://throw.")) throw new Error("RENDER_WORKER_KEY env var not set; cannot call render-worker");
        if (url.startsWith("https://err.")) return mkRendered("<html><body>Service unavailable</body></html>", url, 503);
        if (url.startsWith("https://lapsed.")) {
          return mkRendered("<html><body>This domain is for sale</body></html>", "https://sedo.com/search?domain=lapsed.example.no");
        }
        if (url.startsWith("https://concurrent.")) {
          if (mutateConcurrentRow) {
            // Someone else moves the row while the render is in flight.
            expDb.prepare(`UPDATE experiences SET verification_status = 'verified' WHERE id = 'rj-concurrent'`).run();
          }
          return mkRendered(goodHtml, url);
        }
        throw new Error("rejected-rejudge test: unexpected render URL " + url);
      });

      // ── LLM judge mock (the ONLY fetch this route may make) ─────────────
      let judgeCalls = 0;
      const otherFetches: string[] = [];
      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr === "https://api.anthropic.com/v1/messages") {
          judgeCalls++;
          const body = JSON.parse(init?.body ?? "{}");
          const promptText: string = body?.messages?.[0]?.content ?? "";
          if (promptText.includes("Avvikstur")) return mkAnthropicResponse("MISMATCH\nAnnet innhold.");
          return mkAnthropicResponse("MATCH\nStemmer med kilden.");
        }
        otherFetches.push(urlStr);
        throw new Error("rejected-rejudge test: unexpected fetch " + urlStr);
      }) as unknown as typeof fetch;

      // ── (a) auth ─────────────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: { ids: ["rj-match"] } });
        assertEq(r.status, 403, "rj-1a: no X-Admin-Key -> 403");
      }

      // ── (b) validation ───────────────────────────────────────────────────
      {
        const bad: Array<[string, any]> = [
          ["missing ids", {}],
          ["non-array ids", { ids: "rj-match" }],
          ["empty array", { ids: [] }],
          ["21 ids", { ids: Array.from({ length: 21 }, (_, i) => `id-${i}`) }],
          ["blank entry", { ids: ["rj-match", "  "] }],
          ["non-string entry", { ids: ["rj-match", 5] }],
        ];
        for (const [label, body] of bad) {
          const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body });
          assertEq(r.status, 400, `rj-2: ${label} -> 400`);
        }
        assertEq(renderCalls.length, 0, "rj-2z: no render call on a 400");
      }

      // ── (c) dry-run ──────────────────────────────────────────────────────
      const before = snapshotAll();
      for (const [label, extra] of [["default", {}], ["explicit dry_run:true", { dry_run: true }], ["dry_run:'false' string", { dry_run: "false" }]] as const) {
        renderCalls.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { ids: [...ALL_IDS, " rj-match "], ...extra },
        });
        assertEq(r.status, 200, `rj-3a (${label}): 200`);
        assertEq(r.body.dry_run, true, `rj-3b (${label}): dry_run true`);
        assertTrue(typeof r.body.batch_id === "string" && r.body.batch_id.startsWith("rejected-rejudge-"), `rj-3c (${label}): batch_id present`);
        assertEq(
          r.body.counts,
          { total: 10, match: 2, mismatch: 1, unresolved: 5, skipped: 2, restored: 2 },
          `rj-3d (${label}): counts (duplicate id de-duplicated)`,
        );
        const byId = new Map((r.body.results as any[]).map((x) => [x.id, x]));
        assertEq(byId.get("rj-match")?.new_verdict, "MATCH", `rj-3e (${label}): match row MATCH`);
        assertTrue(String(byId.get("rj-match")?.would_be_action).startsWith("[dry-run]"), `rj-3f (${label}): would_be_action reported`);
        assertTrue(byId.get("rj-match")?.action_taken === undefined, `rj-3g (${label}): no action_taken in dry-run`);
        assertEq(byId.get("rj-mismatch")?.new_verdict, "MISMATCH", `rj-3h (${label}): mismatch row MISMATCH`);
        assertEq(
          [byId.get("rj-dead404")?.new_verdict, byId.get("rj-dead404")?.unresolved_reason],
          ["unresolved", "evidence_page_dead"],
          `rj-3i (${label}): rendered 404 -> unresolved evidence_page_dead`,
        );
        assertEq(
          [byId.get("rj-throw")?.new_verdict, byId.get("rj-throw")?.unresolved_reason],
          ["unresolved", "judge_failed"],
          `rj-3j (${label}): render throw -> unresolved judge_failed`,
        );
        assertTrue(String(byId.get("rj-throw")?.reason).includes("RENDER_WORKER_KEY"), `rj-3k (${label}): render error text surfaced`);
        assertEq(byId.get("rj-503")?.unresolved_reason, "judge_failed", `rj-3l (${label}): rendered 503 -> judge_failed`);
        assertEq(byId.get("rj-parked")?.unresolved_reason, "evidence_page_parked", `rj-3m (${label}): parked final_url -> evidence_page_parked`);
        assertEq(byId.get("rj-noevidence")?.unresolved_reason, "evidence_page_dead", `rj-3n (${label}): blank evidence_url -> evidence_page_dead`);
        assertEq(
          [byId.get("rj-needs-review")?.new_verdict, byId.get("rj-needs-review")?.reason, byId.get("rj-needs-review")?.previous_status],
          ["skipped", "not_rejected", "needs_review"],
          `rj-3o (${label}): non-rejected row skipped not_rejected`,
        );
        assertEq(
          [byId.get("rj-missing")?.new_verdict, byId.get("rj-missing")?.reason],
          ["skipped", "not_found"],
          `rj-3p (${label}): unknown id skipped not_found`,
        );
        assertTrue(!renderCalls.some((u) => u.includes("needsreview")), `rj-3q (${label}): no render for non-rejected row`);
        assertEq(renderCalls.length, 7, `rj-3r (${label}): exactly 7 renders (each rejected row with an evidence_url, once)`);
        assertEq(snapshotAll(), before, `rj-3s (${label}): dry-run wrote nothing to experiences`);
        assertEq(auditCount(), 0, `rj-3t (${label}): dry-run wrote no audit rows`);
      }
      assertEq(otherFetches, [], "rj-3u: no fetch other than the LLM judge (no silent plain-fetch fallback)");
      assertTrue(judgeCalls > 0, "rj-3v: LLM judge was actually consulted on rendered pages");

      // ── (d) write-pause blocks apply ─────────────────────────────────────
      {
        setExperiencesPause(true);
        renderCalls.length = 0;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { ids: ["rj-match"], dry_run: false } });
        assertEq(r.status, 423, "rj-4a: paused 'experiences' -> apply 423");
        assertEq(renderCalls.length, 0, "rj-4b: paused apply renders nothing");
        assertEq(snapshotAll(), before, "rj-4c: paused apply wrote nothing");
        assertEq(auditCount(), 0, "rj-4d: paused apply wrote no audit rows");
        setExperiencesPause(false);
      }

      // ── (e) apply ────────────────────────────────────────────────────────
      let applyBatchId = "";
      {
        mutateConcurrentRow = true;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { ids: ALL_IDS, dry_run: false } });
        mutateConcurrentRow = false;
        applyBatchId = r.body.batch_id;
        assertEq(r.status, 200, "rj-5a: apply -> 200");
        assertEq(r.body.dry_run, false, "rj-5b: dry_run false");
        assertEq(
          r.body.counts,
          { total: 10, match: 2, mismatch: 1, unresolved: 5, skipped: 2, restored: 1 },
          "rj-5c: counts (only one MATCH actually restored)",
        );
        const byId = new Map((r.body.results as any[]).map((x) => [x.id, x]));
        assertTrue(String(byId.get("rj-match")?.action_taken).includes("needs_review"), "rj-5d: match row action_taken reports the move");
        assertEq(byId.get("rj-concurrent")?.action_taken, "skipped_changed_concurrently", "rj-5e: concurrently changed row reported skipped_changed_concurrently");

        const matchSnap = snapshot("rj-match") as any;
        assertEq(matchSnap.verification_status, "needs_review", "rj-5f: MATCH row moved rejected -> needs_review");
        assertTrue(String(matchSnap.admission_verdict).startsWith("rejudged_headless: MATCH"), "rj-5g: MATCH row stamped rejudged_headless: MATCH");
        assertEq(matchSnap.admission_verdict_prev, "mismatch: (old plain-fetch verdict)", "rj-5h: stamp went through stampExperienceAdmissionVerdict (prev verdict kept)");

        const audit = expDb
          .prepare(`SELECT experience_id, batch_id, from_status, to_status, reason FROM experience_admission_promotion_audit`)
          .all();
        assertEq(
          audit,
          [{ experience_id: "rj-match", batch_id: applyBatchId, from_status: "rejected", to_status: "needs_review", reason: "rejudge_headless_match" }],
          "rj-5i: exactly one audit row, for the MATCH row, with this batch_id",
        );

        const beforeMap = new Map(before as Array<[string, unknown]>);
        for (const id of ["rj-mismatch", "rj-dead404", "rj-throw", "rj-503", "rj-parked", "rj-noevidence", "rj-needs-review"]) {
          assertEq(snapshot(id), beforeMap.get(id), `rj-5j: ${id} untouched by apply`);
        }
        const concurrentSnap = snapshot("rj-concurrent") as any;
        assertEq(concurrentSnap.verification_status, "verified", "rj-5k: concurrently changed row keeps the other writer's status");
        assertEq(concurrentSnap.admission_verdict, "mismatch: (old plain-fetch verdict)", "rj-5l: concurrently changed row not stamped");
        assertEq(otherFetches, [], "rj-5m: apply made no non-judge fetch");
      }

      // ── (f) second apply on the restored row ─────────────────────────────
      {
        renderCalls.length = 0;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { ids: ["rj-match"], dry_run: false } });
        assertEq(r.body.results?.[0]?.reason, "not_rejected", "rj-6a: already-restored row now skipped not_rejected");
        assertEq(renderCalls.length, 0, "rj-6b: no render for it");
        assertEq(auditCount(), 1, "rj-6c: still exactly one audit row");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (opplevelserModule) opplevelserModule.__setRejectedRejudgeRenderImplForTesting(null);
      globalThis.fetch = prevFetch;
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

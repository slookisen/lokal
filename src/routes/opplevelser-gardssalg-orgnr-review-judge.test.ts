/**
 * opplevelser-gardssalg-orgnr-review-judge.test.ts — tests for
 * POST /admin/gardssalg-orgnr-review-judge (src/routes/opplevelser.ts),
 * dev-request 2026-08-23-opplevagent-drikke-selvforsyning-speiling, item 3
 * (mirrors RFB Grep 3 slice 2's rfb-website-review-judge, PR lokal#691).
 *
 * Covers:
 *   j1  GODKJENN + write succeeds: LLM judge approves, the in-process call
 *       into gardssalg-orgnr-review-approve writes the org_nr, the queue row
 *       is cleared (that route's own clearGardssalgOrgnrReviewQueueEntry),
 *       approved:1, results carries verdict GODKJENN.
 *   j2  GODKJENN but write blocked: LLM judge approves, but the provider
 *       already has an org_nr (fill-only guard) -> the inner approve call
 *       rejects it -> rejected:1, verdict AVVIS, reason notes "write
 *       blocked", the queue row survives with its reason updated (not
 *       deleted), the provider's original org_nr is untouched.
 *   j3  AVVIS from the judge: rejected:1, verdict AVVIS, queue row survives
 *       with reason updated to the judge's own text, nothing written.
 *   j4  Fail-closed (missing ANTHROPIC_API_KEY): judgeOrgnrIdentityMatch's
 *       own fail-closed contract rejects WITHOUT ever calling fetch (proven
 *       by a fetch stub that throws if invoked) -> rejected:1, queue row's
 *       reason carries the ANTHROPIC_API_KEY-missing note, nothing written.
 *   j5  Selection scoping: a queue row with a DIFFERENT reason (not
 *       'needs_human_review') is never selected/touched by this route.
 *   j6  limit:0 -> true no-op ({processed:0,...}), zero DB reads/writes,
 *       judge never called.
 *   j7  still_pending reflects the post-batch count of reason =
 *       'needs_human_review' rows.
 *
 * Mocking: globalThis.fetch stubbed for the Anthropic call, same convention
 * as contact-candidate-judge.test.ts (dispatch on "api.anthropic.com" in the
 * URL; ANTHROPIC_API_KEY and globalThis.fetch saved/restored). No real
 * network calls. Same in-memory-DB + require-cache-purge + router.handle()
 * pattern as opplevelser-gardssalg-orgnr-review-approve.test.ts.
 *
 * Standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-orgnr-review-judge.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  path: string,
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: path,
      originalUrl: path,
      path,
      query: {},
      headers,
      body: opts.body ?? {},
      get(name: string) {
        return headers[name.toLowerCase()];
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

function anthropicJudgeFetch(text: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (!urlStr.includes("api.anthropic.com")) {
      // No Brreg call is expected on the GODKJENN write path this route
      // takes (it approves the EXACT queued candidate — the plain
      // candidate-orgnr-match branch of gardssalg-orgnr-review-approve never
      // calls Brreg). Fail loudly if that assumption is ever wrong.
      throw new Error(`unexpected non-Anthropic fetch: ${urlStr}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text }] }),
    } as unknown as Response;
  }) as typeof fetch;
}

export function runOpplevelserGardssalgOrgnrReviewJudgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-orgnr-review-judge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    const judgePath = require.resolve("../services/orgnr-identity-judge");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, storePath, judgePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, content_source, brreg_verified, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @org_nr, @kommune, @poststed, @content_source, 0, NULL, '2026-01-01')`,
      );

      const PATH = "/admin/gardssalg-orgnr-review-judge";

      // ═══ j1: GODKJENN + write succeeds ═══════════════════════════════════
      {
        insertProvider.run({
          id: "j1-provider", navn: "Solheim Sider", org_nr: null,
          kommune: "Ullensvang", poststed: "Lofthus", content_source: "provider_site",
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "j1-provider",
          provider_name: "Solheim Sider",
          candidate_orgnr: "910111201",
          candidate_name: "SOLHEIM SIDER AS",
          candidate_confidence: 0.95,
          candidate_address: "Lofthusvegen 1, 5781 Lofthus",
          reason: "needs_human_review",
        });

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nSamme produsent — navn og sted stemmer overens.");

        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        assertEq(r.status, 200, "j1a: 200");
        assertEq(r.body.approved, 1, "j1b: approved:1");
        assertEq(r.body.rejected, 0, "j1c: rejected:0");
        assertEq(r.body.processed, 1, "j1d: processed:1");
        const entry = (r.body.results as any[])?.find((x) => x.provider_id === "j1-provider");
        assertTrue(!!entry, "j1e: results carries the row");
        assertEq(entry?.verdict, "GODKJENN", "j1f: verdict GODKJENN");

        const providerRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = ?`).get("j1-provider") as { org_nr: string | null };
        assertEq(providerRow.org_nr, "910111201", "j1g: org_nr actually written on the provider row");

        const queueRow = expDb.prepare(`SELECT * FROM gardssalg_orgnr_review_queue WHERE provider_id = ?`).get("j1-provider");
        assertEq(queueRow, undefined, "j1h: queue row cleared by the inner approve call on a successful write");
      }

      // ═══ j2: GODKJENN but write blocked (fill-only guard) ════════════════
      {
        insertProvider.run({
          id: "j2-provider", navn: "Vestlia Bryggeri", org_nr: "910111202",
          kommune: "Voss", poststed: "Voss", content_source: "provider_site",
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "j2-provider",
          provider_name: "Vestlia Bryggeri",
          candidate_orgnr: "910111203",
          candidate_name: "VESTLIA BRYGGERI AS",
          candidate_confidence: 0.95,
          candidate_address: "Vossavegen 2, 5700 Voss",
          reason: "needs_human_review",
        });

        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nSer ut som samme produsent.");

        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        const entry = (r.body.results as any[])?.find((x) => x.provider_id === "j2-provider");
        assertTrue(!!entry, "j2a: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "j2b: verdict AVVIS — the write itself was blocked");
        assertTrue(/write blocked/i.test(entry?.reason ?? ""), "j2c: reason notes the write was blocked");
        assertTrue((r.body.rejected as number) >= 1, "j2d: counted under rejected, not approved");

        const providerRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = ?`).get("j2-provider") as { org_nr: string | null };
        assertEq(providerRow.org_nr, "910111202", "j2e: provider's original org_nr untouched (fill-only guard held)");

        const queueRow = expDb.prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = ?`).get("j2-provider") as { reason: string } | undefined;
        assertTrue(!!queueRow, "j2f: queue row survives (not deleted) — only reason updated");
        assertTrue(!!queueRow && queueRow.reason !== "needs_human_review", "j2g: reason changed away from needs_human_review");
      }

      // ═══ j3: AVVIS from the judge ═════════════════════════════════════════
      {
        insertProvider.run({
          id: "j3-provider", navn: "Ole Hansen Gard", org_nr: null,
          kommune: "Stryn", poststed: "Stryn", content_source: "provider_site",
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "j3-provider",
          provider_name: "Ole Hansen Gard",
          candidate_orgnr: "910111204",
          candidate_name: "OLE HANSEN ENK",
          candidate_confidence: 0.95,
          candidate_address: "Ein annen adresse, 6000 Ålesund",
          reason: "needs_human_review",
        });

        globalThis.fetch = anthropicJudgeFetch("AVVIS\nUlikt sted — sannsynligvis en annen virksomhet med samme navneord.");

        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        const entry = (r.body.results as any[])?.find((x) => x.provider_id === "j3-provider");
        assertTrue(!!entry, "j3a: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "j3b: verdict AVVIS");
        assertTrue(/LLM judge AVVIS/i.test(entry?.reason ?? ""), "j3c: reason carries the LLM-judge note");

        const providerRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = ?`).get("j3-provider") as { org_nr: string | null };
        assertEq(providerRow.org_nr, null, "j3d: nothing written for an AVVIS verdict");

        const queueRow = expDb.prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = ?`).get("j3-provider") as { reason: string } | undefined;
        assertTrue(!!queueRow, "j3e: queue row survives (not deleted)");
        assertTrue(!!queueRow && /AVVIS/.test(queueRow.reason), "j3f: queue row's reason updated to the AVVIS note");
      }

      // ═══ j4: fail-closed — missing ANTHROPIC_API_KEY ═════════════════════
      {
        insertProvider.run({
          id: "j4-provider", navn: "Nordbygda Gardsutsalg", org_nr: null,
          kommune: null, poststed: null, content_source: "provider_site",
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "j4-provider",
          provider_name: "Nordbygda Gardsutsalg",
          candidate_orgnr: "910111205",
          candidate_name: "NORDBYGDA GARDSUTSALG AS",
          candidate_confidence: 0.95,
          candidate_address: "Ein adresse",
          reason: "needs_human_review",
        });

        delete process.env.ANTHROPIC_API_KEY;
        globalThis.fetch = (async () => {
          throw new Error("j4: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        const entry = (r.body.results as any[])?.find((x) => x.provider_id === "j4-provider");
        assertTrue(!!entry, "j4a: results carries the row (no crash from the missing key)");
        assertEq(entry?.verdict, "AVVIS", "j4b: verdict AVVIS — fail-closed");
        assertTrue(/ANTHROPIC_API_KEY/.test(entry?.reason ?? ""), "j4c: reason names the missing key");

        const providerRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = ?`).get("j4-provider") as { org_nr: string | null };
        assertEq(providerRow.org_nr, null, "j4d: nothing written on a fail-closed verdict");

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      }

      // ═══ j5: selection scoping — a row with a different reason is
      //         never touched ═══════════════════════════════════════════════
      {
        insertProvider.run({
          id: "j5-provider", navn: "Utenfor Scope Gard", org_nr: null,
          kommune: null, poststed: null, content_source: "provider_site",
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "j5-provider",
          provider_name: "Utenfor Scope Gard",
          candidate_orgnr: "910111206",
          candidate_name: "UTENFOR SCOPE GARD",
          reason: "no_brreg_candidate",
        });

        globalThis.fetch = (async () => {
          throw new Error("j5: judge must NOT be called for a row outside reason='needs_human_review'");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        const entry = (r.body.results as any[])?.find((x) => x.provider_id === "j5-provider");
        assertTrue(!entry, "j5a: the out-of-scope row never appears in results");

        const queueRow = expDb.prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = ?`).get("j5-provider") as { reason: string };
        assertEq(queueRow.reason, "no_brreg_candidate", "j5b: its reason is untouched");
      }

      // ═══ j6: limit:0 -> true no-op ════════════════════════════════════════
      {
        globalThis.fetch = (async () => {
          throw new Error("j6: judge must NOT be called on limit:0");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 0 },
        });
        assertEq(r.status, 200, "j6a: 200");
        assertEq(r.body, { processed: 0, approved: 0, rejected: 0, still_pending: 0, results: [] },
          "j6b: exact no-op shape, no DB touch");
      }

      // ═══ invalid limit -> 400 ═════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: -1 },
        });
        assertEq(r.status, 400, "j6c: negative limit -> 400");
      }

      // ═══ j7: still_pending reflects the post-batch count ═════════════════
      {
        // At this point: j1 (cleared), j2 (reason changed), j3 (reason
        // changed), j4 (reason changed), j5 (untouched, reason
        // no_brreg_candidate — never 'needs_human_review'). So exactly ONE
        // fresh 'needs_human_review' row should remain after seeding one
        // more and running with limit:0 (a pure read, no mutation).
        insertProvider.run({
          id: "j7-provider", navn: "Fjellro Sider", org_nr: null,
          kommune: null, poststed: null, content_source: "provider_site",
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "j7-provider",
          provider_name: "Fjellro Sider",
          candidate_orgnr: "910111207",
          candidate_name: "FJELLRO SIDER AS",
          reason: "needs_human_review",
        });

        const countRow = expDb.prepare(`SELECT COUNT(*) AS c FROM gardssalg_orgnr_review_queue WHERE reason = 'needs_human_review'`).get() as { c: number };
        assertEq(countRow.c, 1, "j7a: exactly 1 needs_human_review row present before this run");

        globalThis.fetch = anthropicJudgeFetch("AVVIS\nIkke nok bevis.");
        const r = await callRoute(opplevelserRouter, PATH, {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        assertEq(r.body.still_pending, 0, "j7b: still_pending is 0 after the one remaining row is judged AVVIS");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-orgnr-review-judge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      globalThis.fetch = prevFetch;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        /* best-effort */
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runOpplevelserGardssalgOrgnrReviewJudgeTests({ log: true }).then((s) => {
    console.log(`\nopplevelser-gardssalg-orgnr-review-judge: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      console.log(s.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

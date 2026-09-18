/**
 * opplevelser-gardssalg-website-review-judge.test.ts — tests for
 * POST /admin/gardssalg-website-review-judge (src/routes/opplevelser.ts),
 * dev-request 2026-08-24-grep3-website-judge-tier's gårdssalg mirror (RFB's
 * shipped POST /admin/rfb-website-review-judge, PR lokal#... — see
 * admin-rfb-website-discovery.test.ts's own `jg-*` block) applied to
 * gardssalg_website_review_queue's own confidence band, originally [0.90,
 * 0.95) and widened to [0.90, 1.0] inclusive by dev-request 2026-09-14-
 * opplevagent-needs-review-drenering ("grep 3 + grep 4").
 *
 * Covers:
 *   a      Confidence-band boundary (widened): 0.90/0.92/0.95 rows AND a
 *          not-yet-drained 1.0 row all qualify; a row the SEPARATE
 *          deterministic auto-approve mechanism (gardssalg-website-review-
 *          approve's `auto: true` mode) already drained does not reappear —
 *          the two mechanisms are independent and non-conflicting.
 *   b      Structural backstop (classifyContactCandidateDefect) rejects a
 *          favicon-path candidate BEFORE any LLM call — a fetch stub that
 *          throws if invoked proves the LLM is never reached.
 *   c      LLM AVVIS: the queue row survives with its `reason` overwritten
 *          to the judge's note, not deleted; nothing written to the provider.
 *   d      LLM GODKJENN: writes through gardssalg-website-review-approve
 *          in-process; the provider's hjemmeside is set and the queue row is
 *          cleared (gone) afterward.
 *   e      Write-time guard rejection on GODKJENN (the provider already has
 *          a hjemmeside — the approve route's own fill-only guard blocks the
 *          write and reports it in ITS `rejected` array): counted as
 *          rejected here, NOT approved; the queue row survives with its
 *          reason updated to note the write was blocked.
 *   f      limit:0 is a true no-op — zero DB reads/writes, judge never
 *          called, exact `{processed:0,...}` shape, returned before any DB
 *          touch.
 *   g      The guarded UPDATE never clobbers a row whose `reason` changed
 *          concurrently: the Anthropic fetch stub mutates the row's `reason`
 *          out from under the route (simulating a concurrent write between
 *          this route's SELECT and its own guarded UPDATE) before answering
 *          AVVIS — the concurrent value must survive, and the reported
 *          `reason` in the response must honestly say the note wasn't
 *          persisted.
 *
 * Mocking: globalThis.fetch stubbed for the Anthropic call, same convention
 * as opplevelser-gardssalg-orgnr-review-judge.test.ts (dispatch on
 * "api.anthropic.com" in the URL; ANTHROPIC_API_KEY and globalThis.fetch
 * saved/restored). No real network calls. Same in-memory-DB +
 * require-cache-purge + router.handle() pattern as that sibling and as
 * opplevelser-gardssalg-website-discovery.test.ts (the discovery+approve
 * pair this route writes through).
 *
 * Wired into tests/test.ts (see that file's own
 * opplevelser-gardssalg-website-review-judge block) and runs as part of
 * `npm test`, like the vast majority of this repo's route test files —
 * including its sibling opplevelser-gardssalg-orgnr-review-judge.test.ts,
 * which is likewise wired in, not standalone.
 *
 * Also runnable standalone for quick local iteration:
 *   npx tsx src/routes/opplevelser-gardssalg-website-review-judge.test.ts
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
      throw new Error(`unexpected non-Anthropic fetch: ${urlStr}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text }] }),
    } as unknown as Response;
  }) as typeof fetch;
}

export function runOpplevelserGardssalgWebsiteReviewJudgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-website-review-judge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    const judgePath = require.resolve("../services/contact-candidate-judge");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, storePath, judgePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, content_source, brreg_verified, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @org_nr, @kommune, @poststed, @hjemmeside, @content_source, 0, NULL, '2026-01-01')`,
      );

      const PATH = "/admin/gardssalg-website-review-judge";

      // ═══ auth ═══════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: {}, body: {} });
        assertEq(r.status, 403, "auth: POST without X-Admin-Key -> 403");
      }

      // ═══ a: confidence-band boundary — widened by dev-request 2026-09-14-
      //        opplevagent-needs-review-drenering ("grep 3 + grep 4") from
      //        [0.90, 0.95) to [0.90, 1.0] inclusive
      //        (GARDSSALG_WD_JUDGE_MAX_CONFIDENCE_EXCLUSIVE raised from 0.95
      //        to 1.01): this route now ALSO covers the org_nr_found (>=1.0)
      //        tier, for whatever the SEPARATE deterministic auto-approve
      //        mechanism (gardssalg-website-review-approve's own
      //        `auto: true` mode, default min_confidence: 1.0, a DIFFERENT
      //        route/query, untouched by this constant) hasn't already
      //        drained. Proves both halves: (a1-a3) the deterministic
      //        mechanism's own behavior is completely unaffected — it still
      //        drains an exactly-1.0 row exactly as before widening; (a4-a9)
      //        a 0.95 row (previously excluded by the old ceiling) and a
      //        SEPARATE, NOT-yet-drained 1.0 row are now included by this
      //        route's own widened query — while the row the deterministic
      //        mechanism already drained is correctly gone and never
      //        reappears here. The two mechanisms read the same queue by
      //        different, independent, non-conflicting criteria. ═══════════
      {
        // a1-a3: the deterministic mechanism, run FIRST and in isolation, on
        // its own default (>=1.0) tier — unaffected by the judge route's
        // widened constant, which this block hasn't touched yet.
        insertProvider.run({ id: "a-100-drained", navn: "Drenert Terskel Gard", org_nr: "910900099", kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "a-100-drained", provider_name: "Drenert Terskel Gard",
          candidate_url: "https://drenertterskel.no", confidence: 1.0,
          evidence: JSON.stringify({ org_nr_found: true }),
        });
        const autoApprove = await callRoute(opplevelserRouter, "/admin/gardssalg-website-review-approve", {
          headers: { "x-admin-key": testKey }, body: { auto: true, apply: true },
        });
        assertEq(autoApprove.body.mode, "auto", "a1: the deterministic auto-approve mode is still available, unaffected by the judge's widened constant");
        assertEq(autoApprove.body.min_confidence, 1.0, "a2: its own default min_confidence is still exactly 1.0 — a DIFFERENT constant, untouched by this dev-request");
        assertTrue(
          (autoApprove.body.written as any[]).some((w: any) => w.provider_id === "a-100-drained"),
          "a3: the exactly-1.0 row is deterministically drained exactly as before widening",
        );

        // a4-a9: NOW populate the judge route's own band, including a 0.95
        // row (previously excluded) and a SEPARATE 1.0 row this run does
        // NOT run the deterministic mechanism on first — proving the
        // widened judge query alone reaches it.
        insertProvider.run({ id: "a-090", navn: "Nedre Terskel Gard", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "a-090", provider_name: "Nedre Terskel Gard",
          candidate_url: "https://nedreterskel.no", confidence: 0.9,
          evidence: JSON.stringify({ name_found: true, place_found: true }),
        });
        insertProvider.run({ id: "a-092", navn: "Adresse Terskel Gard", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "a-092", provider_name: "Adresse Terskel Gard",
          candidate_url: "https://adresseterskel.no", confidence: 0.92,
          evidence: JSON.stringify({ name_found: true, address_found: true }),
        });
        insertProvider.run({ id: "a-095", navn: "Ovre Terskel Gard", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "a-095", provider_name: "Ovre Terskel Gard",
          candidate_url: "https://overterskel.no", confidence: 0.95,
          evidence: JSON.stringify({ phone_found: true }),
        });
        insertProvider.run({ id: "a-100", navn: "Full Terskel Gard", org_nr: "910900001", kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "a-100", provider_name: "Full Terskel Gard",
          candidate_url: "https://fullterskel.no", confidence: 1.0,
          evidence: JSON.stringify({ org_nr_found: true }),
        });

        globalThis.fetch = anthropicJudgeFetch("AVVIS\nIkke nok bevis, avvist for testens skyld.");
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        assertEq(r.body.processed, 4, "a4: all four rows in the widened [0.90, 1.0] band are processed — 0.90, 0.92, 0.95 AND the not-yet-drained 1.0 row");
        const ids = (r.body.results as any[]).map((x) => x.provider_id).sort();
        assertEq(ids, ["a-090", "a-092", "a-095", "a-100"], "a5: exactly these four — the ALREADY-DRAINED a-100-drained never reappears (its queue row is gone)");
        assertEq(r.body.still_pending, 0, "a6: still_pending is 0 — all four in-band rows were reached within the limit");

        const q095 = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("a-095") as { reason: string };
        assertTrue(q095.reason.includes("LLM judge AVVIS"), "a7: the 0.95 row — previously EXCLUDED by the old 0.95 ceiling — was actually judged (not just untouched)");
        const q100 = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("a-100") as { reason: string };
        assertTrue(q100.reason.includes("LLM judge AVVIS"), "a8: the not-yet-drained 1.0 row was also actually judged by the widened band");
        const qDrained = expDb.prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("a-100-drained");
        assertEq(qDrained, undefined, "a9: the deterministically-drained row's queue entry stays gone — the judge run never recreated or touched it");

        assertEq(opplevelserModule.GARDSSALG_WD_JUDGE_MIN_CONFIDENCE, 0.9, "a10: band floor is 0.90 (inclusive), unchanged");
        assertEq(opplevelserModule.GARDSSALG_WD_JUDGE_MAX_CONFIDENCE_EXCLUSIVE, 1.01, "a11: band ceiling widened to 1.01 — i.e. [0.90, 1.0] inclusive");
      }

      // ═══ b: structural backstop short-circuit ══════════════════════════
      {
        insertProvider.run({ id: "b-backstop", navn: "Favikon Gardsbutikk", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "b-backstop", provider_name: "Favikon Gardsbutikk",
          candidate_url: "https://favikongardsbutikk.no/favicon.ico", confidence: 0.91,
          evidence: JSON.stringify({}),
        });
        globalThis.fetch = (async () => {
          throw new Error("b: the LLM judge must NOT be called for a backstop-rejected candidate");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "b-backstop");
        assertTrue(!!entry, "b1: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "b2: verdict AVVIS");
        assertTrue((entry?.reason as string).includes("judge backstop AVVIS"), "b3: reason attributes the rejection to the backstop, not the LLM");

        const q = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("b-backstop") as { reason: string } | undefined;
        assertTrue(!!q, "b4: queue row survives (not deleted)");
        assertTrue(!!q && q.reason.includes("judge backstop AVVIS"), "b5: reason column carries the backstop note");
      }

      // ═══ c: LLM AVVIS — row survives, reason updated, nothing written ══
      {
        insertProvider.run({ id: "c-avvis", navn: "Nordheim Gardsprodukter", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "c-avvis", provider_name: "Nordheim Gardsprodukter",
          candidate_url: "https://nordheimgardsprodukter.no", confidence: 0.9,
          evidence: JSON.stringify({ name_found: true, place_found: true }),
        });
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        globalThis.fetch = anthropicJudgeFetch("AVVIS\nDette ser ut som generisk sidestøy, ikke ekte nettside-eierskap.");

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "c-avvis");
        assertTrue(!!entry, "c1: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "c2: verdict AVVIS");
        assertTrue((entry?.reason as string).includes("LLM judge AVVIS"), "c3: reason carries the LLM-judge note");

        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("c-avvis") as { hjemmeside: string | null };
        assertEq(providerRow.hjemmeside, null, "c4: nothing written for an AVVIS verdict");

        const q = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("c-avvis") as { reason: string } | undefined;
        assertTrue(!!q, "c5: queue row survives (not deleted)");
        assertTrue(!!q && q.reason.includes("LLM judge AVVIS"), "c6: reason updated to the AVVIS note");
      }

      // ═══ d: LLM GODKJENN — writes through the approve lever, queue row
      //         gone afterward ═══════════════════════════════════════════
      {
        insertProvider.run({ id: "d-godkjenn", navn: "Solbakken Gardsutsalg", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "d-godkjenn", provider_name: "Solbakken Gardsutsalg",
          candidate_url: "https://solbakkengardsutsalg.no", confidence: 0.92,
          evidence: JSON.stringify({ name_found: true, address_found: true }),
        });
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nDette er en plausibel egen nettside for produsenten.");

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "d-godkjenn");
        assertTrue(!!entry, "d1: results carries the row");
        assertEq(entry?.verdict, "GODKJENN", "d2: verdict GODKJENN");
        assertTrue((r.body.approved as number) >= 1, "d3: counted under approved");

        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("d-godkjenn") as { hjemmeside: string | null };
        assertEq(providerRow.hjemmeside, "https://solbakkengardsutsalg.no", "d4: hjemmeside written via the in-process approve call");

        const q = expDb.prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("d-godkjenn");
        assertEq(q, undefined, "d5: queue row cleared by the inner approve call on a successful write");
      }

      // ═══ e: write-time guard rejection on GODKJENN — a fill-only guard
      //         blocks the write; counted as rejected, not approved ═══════
      {
        insertProvider.run({
          id: "e-blocked", navn: "Vestlia Bryggeri", org_nr: null, kommune: null, poststed: null,
          hjemmeside: "https://allerede-satt.no", content_source: "provider_site",
        });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "e-blocked", provider_name: "Vestlia Bryggeri",
          candidate_url: "https://vestliabryggeri.no", confidence: 0.9,
          evidence: JSON.stringify({ name_found: true, place_found: true }),
        });
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nSer ut som samme produsent.");

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "e-blocked");
        assertTrue(!!entry, "e1: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "e2: verdict AVVIS — the write itself was blocked, never miscounted as approved");
        assertTrue(/write blocked/i.test(entry?.reason ?? ""), "e3: reason notes the write was blocked");
        assertTrue((r.body.rejected as number) >= 1, "e4: counted under rejected");

        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("e-blocked") as { hjemmeside: string | null };
        assertEq(providerRow.hjemmeside, "https://allerede-satt.no", "e5: provider's original hjemmeside untouched (fill-only guard held)");

        const q = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("e-blocked") as { reason: string } | undefined;
        assertTrue(!!q, "e6: queue row survives (not deleted) — only reason updated");
        assertTrue(!!q && q.reason !== "website_discovery_candidate", "e7: reason changed away from website_discovery_candidate");
      }

      // ═══ f: limit:0 -> true no-op ═══════════════════════════════════════
      {
        insertProvider.run({ id: "f-zero", navn: "Nullgrense Gardsprodukter", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "f-zero", provider_name: "Nullgrense Gardsprodukter",
          candidate_url: "https://nullgrensegardsprodukter.no", confidence: 0.9,
          evidence: JSON.stringify({}),
        });
        globalThis.fetch = (async () => {
          throw new Error("f: limit:0 must query and mutate nothing — no fetch call of any kind");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 0 } });
        assertEq(r.status, 200, "f1: 200");
        assertEq(r.body, { processed: 0, approved: 0, rejected: 0, still_pending: 0, results: [] }, "f2: exact no-op shape");

        const q = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("f-zero") as { reason: string };
        assertEq(q.reason, "website_discovery_candidate", "f3: row completely untouched");
      }

      // ═══ invalid limit -> 400 ═══════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: -1 } });
        assertEq(r.status, 400, "invalid-limit: negative limit -> 400");
      }

      // ═══ g: the guarded UPDATE never clobbers a row that changed
      //         concurrently between the SELECT and this row's own
      //         guarded UPDATE ══════════════════════════════════════════
      {
        insertProvider.run({ id: "g-race", navn: "Konkurrent Gardsmat", org_nr: null, kommune: null, poststed: null, hjemmeside: null, content_source: "provider_site" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "g-race", provider_name: "Konkurrent Gardsmat",
          candidate_url: "https://konkurrentgardsmat.no", confidence: 0.9,
          evidence: JSON.stringify({ name_found: true, place_found: true }),
        });

        // Simulate a concurrent process resolving this exact row (e.g. the
        // discovery scan re-upserting it, or a human clearing it) DURING
        // this route's own await on the judge call — the fetch stub mutates
        // the row's `reason` before answering AVVIS, so by the time this
        // route runs its own guarded UPDATE the WHERE clause's original-
        // reason guard no longer matches.
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (!urlStr.includes("api.anthropic.com")) {
            throw new Error(`unexpected non-Anthropic fetch: ${urlStr}`);
          }
          expDb
            .prepare(`UPDATE gardssalg_website_review_queue SET reason = 'resolved_by_concurrent_process' WHERE provider_id = ?`)
            .run("g-race");
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "AVVIS\nIkke nok bevis." }] }),
          } as unknown as Response;
        }) as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "g-race");
        assertTrue(!!entry, "g1: results still carries the row (it WAS judged)");
        assertTrue(
          (entry?.reason as string).includes("queue row changed concurrently, note not persisted"),
          "g2: the reported reason honestly notes the guarded UPDATE did not land",
        );

        const q = expDb.prepare(`SELECT reason FROM gardssalg_website_review_queue WHERE provider_id = ?`).get("g-race") as { reason: string };
        assertEq(q.reason, "resolved_by_concurrent_process", "g3: the concurrently-written value survives untouched — never clobbered by this route's own note");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-website-review-judge: unexpected error: " + String(err?.stack || err?.message || err));
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
  runOpplevelserGardssalgWebsiteReviewJudgeTests({ log: true }).then((s) => {
    console.log(`\nopplevelser-gardssalg-website-review-judge: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      console.log(s.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

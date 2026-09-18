/**
 * opplevelser-listing-homepage-review-judge.test.ts — tests for
 * POST /admin/listing-homepage-review-judge (src/routes/opplevelser.ts),
 * dev-request 2026-09-14-opplevagent-needs-review-drenering ("grep 3 + grep
 * 4"), Daniel-approved live ("GO på grep 3 og 4"). Mirrors
 * opplevelser-gardssalg-website-review-judge.test.ts's conventions (in-
 * memory experiences DB, fresh requires per run, router.handle() as the
 * HTTP entry point, globalThis.fetch stubbed for the Anthropic call), but
 * adapted to experience_homepage_review_queue's own `status` column and this
 * route's `apply`-boolean dry-run mode (which the gårdssalg sibling does not
 * have).
 *
 * Covers:
 *   a   Selection scope: a 'brreg_website_candidate' row and a
 *       'web_search_candidate' row are processed; a 'listing_page_link_
 *       candidate' (confidence 0.8) row and an already-'approved' row are
 *       NEVER touched, proving the route is reason-scoped, not confidence-
 *       range-scoped (the approve route's own non-monotone-confidence
 *       warning).
 *   b   Structural backstop (classifyContactCandidateDefect) rejects a
 *       favicon-path candidate BEFORE any LLM call — a fetch stub that
 *       throws if invoked proves the LLM is never reached.
 *   c   LLM AVVIS on a 'brreg_website_candidate' row (apply:true): status ->
 *       'rejected', reason overwritten with the judge's note, nothing
 *       written to the provider.
 *   d   LLM GODKJENN on a 'web_search_candidate' row (apply:true): writes
 *       through listing-homepage-review-approve in-process — SAME write
 *       path as a manual approval — provider's hjemmeside set, queue row
 *       status -> 'approved' (not deleted; this table never deletes rows).
 *   e   Write-time guard rejection on GODKJENN (apply:true): the provider
 *       already has a hjemmeside — the inner approve route's own fill-only
 *       guard blocks the write; counted as rejected here, not approved.
 *   f   Dry-run (apply omitted/false): the same GODKJENN/AVVIS verdicts are
 *       previewed in `results`, but NOTHING is persisted — queue row status
 *       stays 'pending', provider's hjemmeside stays null.
 *   g   limit:0 is a true no-op.
 *   h   Invalid limit -> 400.
 *   i   The guarded UPDATE never clobbers a row whose status/reason changed
 *       concurrently between this route's SELECT and its own guarded UPDATE.
 *
 * Wired into tests/test.ts, runs as part of `npm test`.
 *
 * Also runnable standalone for quick local iteration:
 *   npx tsx src/routes/opplevelser-listing-homepage-review-judge.test.ts
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

export function runOpplevelserListingHomepageReviewJudgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = process.env.ADMIN_KEY || "listing-homepage-review-judge-test-key";
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
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, listing_url, content_source, source, confidence,
            enrichment_state, verification_status)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @listing_url, @content_source, 'test-fixture', 'medium',
            'raw', 'pending_verify')`,
      );
      const insertQueueRow = expDb.prepare(
        `INSERT INTO experience_homepage_review_queue
           (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, resolved_at)
         VALUES (@id, @provider_id, @provider_name, @candidate_url, @candidate_url, @evidence, @confidence, @reason, 'test-fixture', @status, @createdAt, NULL)`,
      );

      const PATH = "/admin/listing-homepage-review-judge";

      // ═══ auth ═══════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: {}, body: {} });
        assertEq(r.status, 403, "auth: POST without X-Admin-Key -> 403");
      }

      // ═══ a: selection scope — reason-scoped, not confidence-range-scoped ═
      {
        insertProvider.run({ id: "a-brreg", navn: "Brreg Kandidat Gård", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "a-brreg-row", provider_id: "a-brreg", provider_name: "Brreg Kandidat Gård",
          candidate_url: "https://brregkandidat.no", evidence: JSON.stringify({ host: "brregkandidat.no", org_nr: "910900001", source: "brreg_hjemmeside" }),
          confidence: 1.0, reason: "brreg_website_candidate", status: "pending", createdAt: "2026-08-01 08:00:00",
        });
        insertProvider.run({ id: "a-web", navn: "Websøk Kandidat Gård", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "a-web-row", provider_id: "a-web", provider_name: "Websøk Kandidat Gård",
          candidate_url: "https://websokkandidat.no", evidence: JSON.stringify({ source: "web_search", host: "websokkandidat.no" }),
          confidence: 0.6, reason: "web_search_candidate", status: "pending", createdAt: "2026-08-01 09:00:00",
        });
        // Out-of-scope: the 0.8 page-verified tier — must NEVER be selected
        // by this route, regardless of confidence range.
        insertProvider.run({ id: "a-08", navn: "Sidebekreftet Gård", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "a-08-row", provider_id: "a-08", provider_name: "Sidebekreftet Gård",
          candidate_url: "https://sidebekreftet.no", evidence: JSON.stringify({ host: "sidebekreftet.no", listing_url: "https://visitnorway.no/x", name_verified: true }),
          confidence: 0.8, reason: "listing_page_link_candidate", status: "pending", createdAt: "2026-08-01 07:00:00",
        });
        // Out-of-scope: an already-resolved row with an in-scope reason —
        // must never be reselected once status is no longer 'pending'.
        insertProvider.run({ id: "a-resolved", navn: "Allerede Løst Gård", hjemmeside: "https://alleredelost.no", listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "a-resolved-row", provider_id: "a-resolved", provider_name: "Allerede Løst Gård",
          candidate_url: "https://alleredelost.no", evidence: JSON.stringify({ host: "alleredelost.no", org_nr: "910900002", source: "brreg_hjemmeside" }),
          confidence: 1.0, reason: "brreg_website_candidate", status: "approved", createdAt: "2026-08-01 06:00:00",
        });

        globalThis.fetch = anthropicJudgeFetch("AVVIS\nIkke nok bevis, avvist for testens skyld.");
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30, apply: true } });
        assertEq(r.body.processed, 2, "a1: exactly the two in-scope-reason rows are processed");
        const ids = (r.body.results as any[]).map((x) => x.provider_id).sort();
        assertEq(ids, ["a-brreg", "a-web"], "a2: the 0.8 tier and the already-approved row never appear in results");

        const q08 = expDb.prepare(`SELECT status, reason FROM experience_homepage_review_queue WHERE provider_id = ?`).get("a-08") as any;
        assertEq(q08.status, "pending", "a3: the 0.8-tier row's status untouched");
        assertEq(q08.reason, "listing_page_link_candidate", "a4: the 0.8-tier row's reason untouched");
        const qResolved = expDb.prepare(`SELECT status, reason FROM experience_homepage_review_queue WHERE provider_id = ?`).get("a-resolved") as any;
        assertEq(qResolved.status, "approved", "a5: the already-approved row's status untouched");
        assertEq(qResolved.reason, "brreg_website_candidate", "a6: the already-approved row's reason untouched");
      }

      // ═══ b: structural backstop short-circuit ══════════════════════════
      {
        insertProvider.run({ id: "b-backstop", navn: "Favikon Gardsbutikk", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "b-backstop-row", provider_id: "b-backstop", provider_name: "Favikon Gardsbutikk",
          candidate_url: "https://favikongardsbutikk.no/favicon.ico", evidence: JSON.stringify({ source: "web_search", host: "favikongardsbutikk.no" }),
          confidence: 0.6, reason: "web_search_candidate", status: "pending", createdAt: "2026-08-01 10:00:00",
        });
        globalThis.fetch = (async () => {
          throw new Error("b: the LLM judge must NOT be called for a backstop-rejected candidate");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30, apply: true } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "b-backstop");
        assertTrue(!!entry, "b1: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "b2: verdict AVVIS");
        assertTrue((entry?.reason as string).includes("judge backstop AVVIS"), "b3: reason attributes the rejection to the backstop, not the LLM");

        const q = expDb.prepare(`SELECT status, reason FROM experience_homepage_review_queue WHERE provider_id = ?`).get("b-backstop") as any;
        assertTrue(!!q, "b4: queue row survives (not deleted)");
        assertEq(q?.status, "rejected", "b5: status flipped to rejected");
        assertTrue(!!q && q.reason.includes("judge backstop AVVIS"), "b6: reason column carries the backstop note");
      }

      // ═══ c: LLM AVVIS on brreg_website_candidate — status rejected,
      //         reason updated, nothing written ═══════════════════════════
      {
        insertProvider.run({ id: "c-avvis", navn: "Nordheim Gardsprodukter", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "c-avvis-row", provider_id: "c-avvis", provider_name: "Nordheim Gardsprodukter",
          candidate_url: "https://nordheimgardsprodukter.no", evidence: JSON.stringify({ host: "nordheimgardsprodukter.no", org_nr: "910900003", source: "brreg_hjemmeside" }),
          confidence: 1.0, reason: "brreg_website_candidate", status: "pending", createdAt: "2026-08-01 11:00:00",
        });
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        globalThis.fetch = anthropicJudgeFetch("AVVIS\nDette ser ut som generisk sidestøy, ikke ekte nettside-eierskap.");

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30, apply: true } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "c-avvis");
        assertTrue(!!entry, "c1: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "c2: verdict AVVIS");
        assertTrue((entry?.reason as string).includes("LLM judge AVVIS"), "c3: reason carries the LLM-judge note");

        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("c-avvis") as any;
        assertEq(providerRow.hjemmeside, null, "c4: nothing written for an AVVIS verdict");

        const q = expDb.prepare(`SELECT status, reason FROM experience_homepage_review_queue WHERE provider_id = ?`).get("c-avvis") as any;
        assertTrue(!!q, "c5: queue row survives (not deleted)");
        assertEq(q?.status, "rejected", "c6: status flipped to rejected");
        assertTrue(!!q && q.reason.includes("LLM judge AVVIS"), "c7: reason updated to the AVVIS note");
      }

      // ═══ d: LLM GODKJENN on web_search_candidate — writes through the
      //         SAME approve lever as a manual approval, queue row -> approved
      //         (not deleted) ═══════════════════════════════════════════════
      {
        insertProvider.run({ id: "d-godkjenn", navn: "Solbakken Gardsutsalg", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "d-godkjenn-row", provider_id: "d-godkjenn", provider_name: "Solbakken Gardsutsalg",
          candidate_url: "https://solbakkengardsutsalg.no", evidence: JSON.stringify({ source: "web_search", host: "solbakkengardsutsalg.no" }),
          confidence: 0.6, reason: "web_search_candidate", status: "pending", createdAt: "2026-08-01 12:00:00",
        });
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nDette er en plausibel egen nettside for produsenten.");

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30, apply: true } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "d-godkjenn");
        assertTrue(!!entry, "d1: results carries the row");
        assertEq(entry?.verdict, "GODKJENN", "d2: verdict GODKJENN");
        assertTrue((r.body.approved as number) >= 1, "d3: counted under approved");

        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("d-godkjenn") as any;
        assertEq(providerRow.hjemmeside, "https://solbakkengardsutsalg.no", "d4: hjemmeside written via the in-process approve call — SAME write path as a manual approval");

        const q = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id = ?`).get("d-godkjenn") as any;
        assertTrue(!!q, "d5: queue row survives (this table never deletes rows)");
        assertEq(q?.status, "approved", "d6: status flipped to approved by the inner approve call, not by this route directly");

        // Verify no divergent write path: manually calling the approve route
        // a second time on the same (now-approved) pair is correctly a no-op
        // (not_in_review_queue), proving the judge route did NOT bypass the
        // approve route's own state machine.
        const manualRepeat = await callRoute(opplevelserRouter, "/admin/listing-homepage-review-approve", {
          headers: { "x-admin-key": testKey },
          body: { approvals: [{ provider_id: "d-godkjenn", url: "https://solbakkengardsutsalg.no" }], apply: true },
        });
        assertEq(
          (manualRepeat.body.rejected as any[])[0]?.reason, "not_in_review_queue",
          "d7: a repeat manual approve call sees the SAME already-approved state the judge route left behind",
        );
      }

      // ═══ e: write-time guard rejection on GODKJENN — a fill-only guard
      //         blocks the write; counted as rejected, not approved ═══════
      {
        insertProvider.run({
          id: "e-blocked", navn: "Vestlia Bryggeri", hjemmeside: "https://allerede-satt.no", listing_url: null, content_source: null,
        });
        insertQueueRow.run({
          id: "e-blocked-row", provider_id: "e-blocked", provider_name: "Vestlia Bryggeri",
          candidate_url: "https://vestliabryggeri.no", evidence: JSON.stringify({ host: "vestliabryggeri.no", org_nr: "910900004", source: "brreg_hjemmeside" }),
          confidence: 1.0, reason: "brreg_website_candidate", status: "pending", createdAt: "2026-08-01 13:00:00",
        });
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nSer ut som samme produsent.");

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30, apply: true } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "e-blocked");
        assertTrue(!!entry, "e1: results carries the row");
        assertEq(entry?.verdict, "AVVIS", "e2: verdict AVVIS — the write itself was blocked, never miscounted as approved");
        assertTrue(/write blocked/i.test(entry?.reason ?? ""), "e3: reason notes the write was blocked");
        assertTrue((r.body.rejected as number) >= 1, "e4: counted under rejected");

        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("e-blocked") as any;
        assertEq(providerRow.hjemmeside, "https://allerede-satt.no", "e5: provider's original hjemmeside untouched (fill-only guard held)");

        const q = expDb.prepare(`SELECT status, reason FROM experience_homepage_review_queue WHERE provider_id = ?`).get("e-blocked") as any;
        assertTrue(!!q, "e6: queue row survives (not deleted) — only status/reason updated");
        assertEq(q?.status, "rejected", "e7: status flipped to rejected (write was blocked, judge outcome still recorded)");
      }

      // ═══ f: dry-run (apply omitted) — verdicts previewed, nothing persisted ═
      {
        insertProvider.run({ id: "f-dry-avvis", navn: "Tørrkjøring Avvis Gård", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "f-dry-avvis-row", provider_id: "f-dry-avvis", provider_name: "Tørrkjøring Avvis Gård",
          candidate_url: "https://torrkjoringavvis.no", evidence: JSON.stringify({ host: "torrkjoringavvis.no", org_nr: "910900005", source: "brreg_hjemmeside" }),
          confidence: 1.0, reason: "brreg_website_candidate", status: "pending", createdAt: "2026-08-01 14:00:00",
        });
        insertProvider.run({ id: "f-dry-godkjenn", navn: "Tørrkjøring Godkjenn Gård", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "f-dry-godkjenn-row", provider_id: "f-dry-godkjenn", provider_name: "Tørrkjøring Godkjenn Gård",
          candidate_url: "https://torrkjoringgodkjenn.no", evidence: JSON.stringify({ source: "web_search", host: "torrkjoringgodkjenn.no" }),
          confidence: 0.6, reason: "web_search_candidate", status: "pending", createdAt: "2026-08-01 15:00:00",
        });

        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = String(url);
          if (!urlStr.includes("api.anthropic.com")) throw new Error(`unexpected non-Anthropic fetch: ${urlStr}`);
          const bodyText = String(init?.body ?? "");
          const text = bodyText.includes("torrkjoringgodkjenn")
            ? "GODKJENN\nPlausibel egen nettside."
            : "AVVIS\nIkke nok bevis.";
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) } as unknown as Response;
        }) as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30 } });
        assertEq(r.body.dry_run, true, "f1: dry_run true when apply is omitted");
        const avvisEntry = (r.body.results as any[]).find((x) => x.provider_id === "f-dry-avvis");
        const godkjennEntry = (r.body.results as any[]).find((x) => x.provider_id === "f-dry-godkjenn");
        assertTrue(!!avvisEntry && !!godkjennEntry, "f2: both rows previewed in results");
        assertEq(avvisEntry?.verdict, "AVVIS", "f3: AVVIS row's verdict previewed");
        assertEq(godkjennEntry?.verdict, "GODKJENN", "f4: GODKJENN row's verdict previewed");

        // Nothing persisted: both queue rows still 'pending', both original
        // reasons intact, neither provider's hjemmeside was written.
        const qAvvis = expDb.prepare(`SELECT status, reason FROM experience_homepage_review_queue WHERE provider_id = ?`).get("f-dry-avvis") as any;
        assertEq(qAvvis.status, "pending", "f5: dry-run AVVIS row's status untouched");
        assertEq(qAvvis.reason, "brreg_website_candidate", "f6: dry-run AVVIS row's reason untouched");
        const qGodkjenn = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id = ?`).get("f-dry-godkjenn") as any;
        assertEq(qGodkjenn.status, "pending", "f7: dry-run GODKJENN row's status untouched — no write, no approve");
        const hjAvvis = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("f-dry-avvis") as any).hjemmeside;
        assertEq(hjAvvis, null, "f8: dry-run never writes hjemmeside");
        const hjGodkjenn = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("f-dry-godkjenn") as any).hjemmeside;
        assertEq(hjGodkjenn, null, "f9: dry-run never writes hjemmeside, even for a GODKJENN verdict");
      }

      // ═══ g: limit:0 -> true no-op ═══════════════════════════════════════
      {
        insertProvider.run({ id: "g-zero", navn: "Nullgrense Gardsprodukter", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "g-zero-row", provider_id: "g-zero", provider_name: "Nullgrense Gardsprodukter",
          candidate_url: "https://nullgrensegardsprodukter.no", evidence: JSON.stringify({ source: "web_search", host: "nullgrensegardsprodukter.no" }),
          confidence: 0.6, reason: "web_search_candidate", status: "pending", createdAt: "2026-08-01 16:00:00",
        });
        globalThis.fetch = (async () => {
          throw new Error("g: limit:0 must query and mutate nothing — no fetch call of any kind");
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 0, apply: true } });
        assertEq(r.status, 200, "g1: 200");
        assertEq(r.body, { dry_run: false, processed: 0, approved: 0, rejected: 0, still_pending: 0, results: [] }, "g2: exact no-op shape");

        const q = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id = ?`).get("g-zero") as any;
        assertEq(q.status, "pending", "g3: row completely untouched");
      }

      // ═══ invalid limit -> 400 ═══════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: -1 } });
        assertEq(r.status, 400, "invalid-limit: negative limit -> 400");
      }

      // ═══ i: the guarded UPDATE never clobbers a row that changed
      //         concurrently between the SELECT and this row's own
      //         guarded UPDATE ══════════════════════════════════════════
      {
        insertProvider.run({ id: "i-race", navn: "Konkurrent Gardsmat", hjemmeside: null, listing_url: null, content_source: null });
        insertQueueRow.run({
          id: "i-race-row", provider_id: "i-race", provider_name: "Konkurrent Gardsmat",
          candidate_url: "https://konkurrentgardsmat.no", evidence: JSON.stringify({ host: "konkurrentgardsmat.no", org_nr: "910900006", source: "brreg_hjemmeside" }),
          confidence: 1.0, reason: "brreg_website_candidate", status: "pending", createdAt: "2026-08-01 17:00:00",
        });

        // Simulate a concurrent process resolving this exact row (e.g. a
        // concurrent discovery/submit re-upsert resetting status back to
        // 'pending' with a DIFFERENT reason, or a human approving it)
        // DURING this route's own await on the judge call — the fetch stub
        // mutates the row's status/reason before answering AVVIS, so by the
        // time this route runs its own guarded UPDATE the WHERE clause's
        // original-reason/status guard no longer matches.
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (!urlStr.includes("api.anthropic.com")) {
            throw new Error(`unexpected non-Anthropic fetch: ${urlStr}`);
          }
          expDb
            .prepare(`UPDATE experience_homepage_review_queue SET status = 'approved', resolved_at = datetime('now') WHERE provider_id = ?`)
            .run("i-race");
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "AVVIS\nIkke nok bevis." }] }),
          } as unknown as Response;
        }) as typeof fetch;

        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { limit: 30, apply: true } });
        const entry = (r.body.results as any[]).find((x) => x.provider_id === "i-race");
        assertTrue(!!entry, "i1: results still carries the row (it WAS judged)");
        assertTrue(
          (entry?.reason as string).includes("queue row changed concurrently, note not persisted"),
          "i2: the reported reason honestly notes the guarded UPDATE did not land",
        );

        const q = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id = ?`).get("i-race") as any;
        assertEq(q.status, "approved", "i3: the concurrently-written status survives untouched — never clobbered by this route's own note");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-listing-homepage-review-judge: unexpected error: " + String(err?.stack || err?.message || err));
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
  runOpplevelserListingHomepageReviewJudgeTests({ log: true }).then((s) => {
    console.log(`\nopplevelser-listing-homepage-review-judge: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      console.log(s.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

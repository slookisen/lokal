/**
 * opplevelser-gardssalg-drink-visit-uttrekk.test.ts — tests for "Del A" of
 * dev-request 2026-09-07-drikke-berikelse-besokstekst-uttrekk-og-no-yield-
 * backoff: drink-producer visit_text/opening_hours_text extraction on top of
 * POST /admin/gardssalg-content-refresh.
 *
 *   - A1 (extended VISIT_KEYWORDS): covered in search-enrich.test.ts (one
 *     assertion per new word, via summarizeVisit()).
 *   - A2 (need-driven fallback-path ordering): Section C below, route-level
 *     — a row whose products AND about_text are ALREADY filled gets
 *     visit/opening-hours sub-pages fetched FIRST (via the additive
 *     products_diagnostic[].pages_fetched_paths field), an unfilled row
 *     keeps today's product-first ordering.
 *   - A3 (LLM-generated visit_text): Section A tests
 *     generateGardssalgVisitFromSource() in isolation (mirrors
 *     generateGardssalgAboutFromSource's own test shape in
 *     opplevelser-gardssalg-fillblank.test.ts); Section B tests
 *     judgeGardssalgVisitCandidateWithSource() in isolation (mirrors
 *     judgeGardssalgAboutCandidate's own fail-closed contract); Section C
 *     proves the trigger→generator→judge→write wiring end-to-end through
 *     the real route, including the sentinel-is-no-yield case, the
 *     judge-reject case, and the additive `llm_generated` field_diagnostic
 *     outcome.
 *   - A4 (JSON-LD opening hours): Section C proves a JSON-LD hit writes
 *     opening_hours_text WITHOUT ever calling the hours LLM endpoint.
 *   - A5 (kill switch): Section C proves GARDSSALG_VISIT_LLM_ENABLED=false
 *     reproduces the pre-existing purely deterministic behavior (no LLM
 *     call for visit_text even with a trigger and an otherwise-approvable
 *     candidate).
 *   - Lock test: a claim row with visit_text owner-locked, and a manual
 *     row, must never receive an LLM-generated visit_text write.
 *
 * Mirrors opplevelser-gardssalg-opening-hours-llm.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch for BOTH the
 * page-content crawl (crFetchGardssalgContent, keyed by hostname) AND the
 * Anthropic API call (keyed by a unique substring of each prompt), since the
 * sandbox has no live network access to either.
 */

import {
  generateGardssalgVisitFromSource,
  judgeGardssalgVisitCandidateWithSource,
} from "./opplevelser";

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
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-content-refresh";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgDrinkVisitUttrekkTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;

    // ═══════════════════════════════════════════════════════════════════
    // Section A — generateGardssalgVisitFromSource() direct unit tests (no
    // DB, no router — pure w.r.t. everything but fetch()/env). Mirrors
    // generateGardssalgAboutFromSource's own test shape.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SOURCE_TEXT = "Vi driver et lite taproom på gården der besøkende kan smake ølet vårt direkte fra tanken.";
      const NAVN = "Fjordly Bryggeri";
      const GOOD_VISIT = "Besøkende er velkomne til taproomet vårt for å smake ølet rett fra tanken.";

      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("vt-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-1: missing ANTHROPIC_API_KEY → null");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      let capturedInit: any = null;
      let capturedUrl: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: GOOD_VISIT }] }),
        };
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, GOOD_VISIT, "vt-2a: mocked 200 with a good candidate → returned verbatim");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "vt-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "vt-2c: model is claude-haiku-4-5");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(NAVN), "vt-2d: prompt includes navn");
        assertTrue(body.messages[0].content.includes(SOURCE_TEXT), "vt-2e: prompt includes the source text");
        assertTrue(body.messages[0].content.includes("UTILSTREKKELIG_GRUNNLAG"), "vt-2f: prompt includes the escape sentinel instruction");
        assertTrue(body.messages[0].content.includes("Bruk KUN fakta som faktisk står i kildeteksten"), "vt-2g: prompt includes the exact grounding instruction");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "vt-2h: x-api-key header carries ANTHROPIC_API_KEY");
      }

      // ── vt-3: source text capped to ~6000 chars (GARDSSALG_REWRITE_SOURCE_
      //    CHAR_CAP — "the same cap as the about_text 'rewritten' path"). ──
      {
        const hugeSource = "x".repeat(20000);
        await generateGardssalgVisitFromSource(hugeSource, NAVN);
        const body = JSON.parse(capturedInit.body);
        const xRunLength = (body.messages[0].content.match(/x+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
        assertTrue(xRunLength <= 6000, "vt-3: source text is capped to ~6000 chars in the prompt, not passed through unbounded");
      }

      // ── vt-4: sentinel handling — verbatim, whitespace-padded, embedded. ─
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "UTILSTREKKELIG_GRUNNLAG" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-4a: the literal UTILSTREKKELIG_GRUNNLAG sentinel → null");
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "  UTILSTREKKELIG_GRUNNLAG  \n" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-4b: sentinel with surrounding whitespace (trimmed) → still null");
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: `Beklager. UTILSTREKKELIG_GRUNNLAG` }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-4c: sentinel embedded in longer prose → null, never published with the sentinel in it");
      }

      // ── vt-5: network throw → null, never throws itself. ─────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-5: fetch throw (network failure) → null, not re-thrown");
      }

      // ── vt-6: non-200 response → null. ────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-6: non-200 response → null");
      }

      // ── vt-7: unparseable JSON body (.json() throws) → null. ──────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-7: unparseable JSON response body → null");
      }

      // ── vt-8: non-array content field → null, never throws. ───────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-8: non-array content field → null, not a thrown TypeError");
      }

      const mockText = (t: string) =>
        (globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: t }] }),
        })) as unknown as typeof fetch);

      // ── vt-9: markdown artifacts are stripped and the candidate is
      //    accepted when the stripped text is otherwise clean. ───────────
      mockText(`**${GOOD_VISIT}**`);
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertTrue(r !== null, "vt-9a: markdown-formatted candidate is accepted after stripping");
        assertTrue(!!r && !/[*#`]/.test(r), "vt-9b: no asterisks/hashes/backticks survive into the returned value");
        assertEq(r, GOOD_VISIT, "vt-9c: stripped result matches the underlying text exactly");
      }

      // ── vt-10: residual markdown after stripping (unpaired "**") →
      //    rejected outright. ───────────────────────────────────────────
      mockText(`og **${GOOD_VISIT}`);
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-10: unpaired ** survives stripping → residual check rejects (fail-closed)");
      }

      // ── vt-11: an oversized, rambling response → null (safety valve). ──
      mockText("Vi tar imot besøkende " + "svært lenge ".repeat(60) + "hver dag.");
      {
        const r = await generateGardssalgVisitFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "vt-11: an oversized rambling response → null (safety valve)");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-drink-visit-uttrekk (section A): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — judgeGardssalgVisitCandidateWithSource() direct unit
    // tests. Mirrors judgeGardssalgAboutCandidate's own fail-closed
    // contract (GARDSSALG_JUDGE_APPROVE_TOKEN/REJECT_TOKEN, exact-token
    // verdict, any doubt or failure → reject, never throws).
    // ═══════════════════════════════════════════════════════════════════
    try {
      const CANDIDATE = "Besøkende er velkomne til taproomet vårt for å smake ølet rett fra tanken.";
      const SOURCE = "Vi driver et lite taproom på gården der besøkende kan smake ølet vårt direkte fra tanken.";
      const NAVN = "Fjordly Bryggeri";

      delete process.env.ANTHROPIC_API_KEY;
      {
        const v = await judgeGardssalgVisitCandidateWithSource(CANDIDATE, SOURCE, NAVN);
        assertEq(v.approved, false, "vj-1: missing ANTHROPIC_API_KEY → approved:false, fail-closed");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      let capturedInit: any = null;
      globalThis.fetch = (async (_url: any, init: any) => {
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nAlt spores til kildeteksten." }] }),
        };
      }) as unknown as typeof fetch;
      {
        const v = await judgeGardssalgVisitCandidateWithSource(CANDIDATE, SOURCE, NAVN);
        assertEq(v.approved, true, "vj-2a: exact GODKJENN token on first line → approved:true");
        assertEq(v.reasoning, "Alt spores til kildeteksten.", "vj-2b: reasoning is the second line, trimmed");
        const body = JSON.parse(capturedInit.body);
        const prompt: string = body.messages[0].content;
        assertTrue(prompt.includes(SOURCE), "vj-2c: prompt includes the source text as ground truth");
        assertTrue(prompt.includes(CANDIDATE), "vj-2d: prompt includes the candidate text");
        assertTrue(prompt.includes(NAVN), "vj-2e: prompt includes the producer name");
        assertTrue(/fasit/i.test(prompt), "vj-2f: prompt explicitly names the source text as fasit (ground truth)");
        assertTrue(prompt.includes("GODKJENN") && prompt.includes("AVVIS"), "vj-2g: prompt states both verdict tokens");
      }

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "AVVIS\nKlokkeslett i kandidaten finnes ikke i kilden." }] }),
      })) as unknown as typeof fetch;
      {
        const v = await judgeGardssalgVisitCandidateWithSource(CANDIDATE, SOURCE, NAVN);
        assertEq(v.approved, false, "vj-3: exact AVVIS token → approved:false");
      }

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Kanskje, vanskelig å si" }] }),
      })) as unknown as typeof fetch;
      {
        const v = await judgeGardssalgVisitCandidateWithSource(CANDIDATE, SOURCE, NAVN);
        assertEq(v.approved, false, "vj-4: ambiguous/garbage first line → approved:false, fail-closed");
      }

      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const v = await judgeGardssalgVisitCandidateWithSource(CANDIDATE, SOURCE, NAVN);
        assertEq(v.approved, false, "vj-5: network throw → approved:false, not re-thrown");
      }

      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
      {
        const v = await judgeGardssalgVisitCandidateWithSource(CANDIDATE, SOURCE, NAVN);
        assertEq(v.approved, false, "vj-6: non-200 response → approved:false");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-drink-visit-uttrekk (section B): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section C — POST /admin/gardssalg-content-refresh route-level wiring:
    // A2 (need-driven ordering), A3 (trigger/sentinel/judge/write/
    // field_diagnostic end-to-end), A4 (JSON-LD short-circuits the hours
    // LLM), A5 (kill switch), and the owner-lock/manual-lock guarantee.
    // ═══════════════════════════════════════════════════════════════════
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevKillSwitch = process.env.GARDSSALG_VISIT_LLM_ENABLED;
    const testKey = process.env.ADMIN_KEY || "gardssalg-drink-visit-uttrekk-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-route";
    delete process.env.GARDSSALG_VISIT_LLM_ENABLED;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      function verifiedProvenance(extra?: Record<string, unknown>): string {
        return JSON.stringify({
          hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
          ...extra,
        });
      }
      const insertProvider = {
        run(params: Record<string, unknown>): void {
          insertProviderStmt.run({
            about_text: null, visit_text: null, opening_hours_text: null, products: null,
            field_provenance: verifiedProvenance(),
            ...params,
          });
        },
      };

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, opening_hours_text, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }

      // ── Fixture HTML ─────────────────────────────────────────────────
      // STABLE_ABOUT: long, clean, judge-approved prose so about_text is
      // never a candidate write on any of these rows (isolates the visit
      // assertions), same convention as opplevelser-gardssalg-opening-
      // hours-llm.test.ts's own STABLE_ABOUT/STABLE_VISIT constants.
      const STABLE_ABOUT =
        "Gården ligger idyllisk til ved fjorden og har vært i familiens eie i fire generasjoner. Vi dyrker epler og lager cider av gamle norske sorter, med fokus på kortreist og bærekraftig produksjon gjennom hele sesongen.";
      assertTrue(STABLE_ABOUT.length >= 200, "sanity: STABLE_ABOUT is long enough that gardssalgRewriteEligible never fires");

      // Homepage with NO internal <a href> links at all — discoverContent
      // Links() finds nothing, so crFetchGardssalgContent falls back to
      // GARDSSALG_CONTENT_PATHS (needed so the A2 ordering test below is
      // actually exercising the fallback list, not link-driven discovery).
      // Contains a bare weekday ("Mandag") inside <nav> — excluded from
      // summarizeVisit()'s extractProseText scan, but visible to
      // extractVisibleText()/hasVisitLlmTrigger — so the deterministic
      // extractor finds nothing (candidateVisit stays null) while the A3
      // trigger still fires. No VISIT_KEYWORDS word anywhere, and no time
      // pattern near "Mandag", so extractOpeningHours()'s OWN trigger stays
      // null too — isolates the visit LLM path from the (pre-existing)
      // hours LLM path.
      const TRIGGER_NO_LINKS_HTML =
        `<html><head><meta property="og:description" content="${STABLE_ABOUT}"></head>` +
        `<body><nav>Hjem Produkter Kontakt Mandag Info</nav>` +
        `<main><p>Vi lager cider på gamle epletrær nær fjorden og selger andre varer i egen butikk.</p></main>` +
        `</body></html>`;

      // No weekday, no clock-time, no VISIT_KEYWORDS word anywhere — the A3
      // trigger must NOT fire on this page at all.
      const NO_TRIGGER_HTML =
        `<html><head><meta property="og:description" content="${STABLE_ABOUT}"></head>` +
        `<body><main><p>Vi lager cider på gamle epletrær nær fjorden og selger andre varer i egen butikk.</p></main></body></html>`;

      // JSON-LD opening hours (A4) — no weekday/time regex trigger needed;
      // the JSON-LD extractor must find this deterministically and the
      // hours LLM prompt ("Finn åpningstidene") must NEVER be called.
      const JSONLD_HOURS_HTML =
        `<html><head><meta property="og:description" content="${STABLE_ABOUT}">` +
        `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Test",` +
        `"openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"10:00","closes":"18:00"}]}` +
        `</script></head>` +
        `<body><main><p>Vi lager cider på gamle epletrær nær fjorden og selger andre varer i egen butikk.</p></main></body></html>`;

      const GOOD_VISIT_CANDIDATE = "Besøkende er velkomne innom butikken vår for å handle cider direkte fra gården.";

      let visitGenCallCount = 0;
      let visitJudgeCallCount = 0;
      let hoursGenCallCount = 0;
      let aboutVisitJudgeCallCount = 0;
      const anthropicPromptsSeen: string[] = [];
      // judge outcome is switchable per-scenario via this mutable flag.
      let visitJudgeApproves = true;

      function makeFetchMock(hostHtml: Record<string, string>): typeof fetch {
        return (async (url: string | URL | Request, init?: any) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            const body = init?.body ? JSON.parse(init.body) : {};
            const prompt: string = body?.messages?.[0]?.content ?? "";
            anthropicPromptsSeen.push(prompt);
            if (prompt.includes("hva et besøk hos gårdsprodusenten")) {
              visitGenCallCount++;
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: GOOD_VISIT_CANDIDATE }] }),
              } as unknown as Response;
            }
            if (prompt.includes("faktakontrollør for produsentprofiler")) {
              visitJudgeCallCount++;
              return {
                ok: true, status: 200,
                json: async () => ({
                  content: [{ type: "text", text: visitJudgeApproves ? "GODKJENN\nOK." : "AVVIS\nIkke sporbart." }],
                }),
              } as unknown as Response;
            }
            if (prompt.includes("Finn åpningstidene")) {
              hoursGenCallCount++;
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
              } as unknown as Response;
            }
            if (prompt.includes("kvalitetsdommer")) {
              aboutVisitJudgeCallCount++;
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen prosa om produsenten." }] }),
              } as unknown as Response;
            }
            // Any other Anthropic call this scenario isn't meant to
            // exercise (e.g. the about-fill generator) — harmless sentinel.
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
            } as unknown as Response;
          }
          const host = new URL(urlStr).hostname;
          if (host in hostHtml) {
            const html = hostHtml[host]!;
            return {
              ok: true, status: 200, text: async () => html,
              arrayBuffer: async () => new TextEncoder().encode(html).buffer,
              headers: { get: () => null },
            } as unknown as Response;
          }
          // Every sub-page path (fallback list AND link discovery) resolves
          // OK with a trivial page — needed so the A2 ordering test can
          // observe pagesFetchedPaths reaching 4 entries deterministically.
          const trivial = "<html><body><p>Underside.</p></body></html>";
          return {
            ok: true, status: 200, text: async () => trivial,
            arrayBuffer: async () => new TextEncoder().encode(trivial).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }) as unknown as typeof fetch;
      }

      // ═══════════════════════════════════════════════════════════════
      // A2 — need-driven fallback-path ordering.
      // ═══════════════════════════════════════════════════════════════
      globalThis.fetch = makeFetchMock({
        "a2-needsdriven.example.no": TRIGGER_NO_LINKS_HTML,
        "a2-notneeded.example.no": TRIGGER_NO_LINKS_HTML,
      });
      insertProvider.run({
        id: "a2-needsdriven", navn: "A2 Needsdriven Gard", hjemmeside: "https://a2-needsdriven.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
        products: JSON.stringify(["Cider"]),
      });
      insertProvider.run({
        id: "a2-notneeded", navn: "A2 Notneeded Gard", hjemmeside: "https://a2-notneeded.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
        products: null,
      });
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["a2-needsdriven", "a2-notneeded"], apply: true },
        });
        assertEq(r.status, 200, "a2-1: apply call → 200");
        const needsDriven = r.body.products_diagnostic.find((d: any) => d.provider_id === "a2-needsdriven");
        assertTrue(!!needsDriven, "a2-2: a2-needsdriven appears in products_diagnostic");
        assertEq(
          (needsDriven.pages_fetched_paths || []).slice(0, 4),
          ["/besok", "/besøk", "/smaking", "/smaksprover"],
          "a2-3: products+about already filled → the first four fallback subpages attempted are visit paths, need-driven ordering",
        );
        const notNeeded = r.body.products_diagnostic.find((d: any) => d.provider_id === "a2-notneeded");
        assertTrue(!!notNeeded, "a2-4: a2-notneeded appears in products_diagnostic");
        assertEq(
          (notNeeded.pages_fetched_paths || []).slice(0, 4),
          ["/produkter", "/nettbutikk", "/kontakt", "/sortiment"],
          "a2-5: products/about NOT already filled → today's product-first ordering is unchanged",
        );
      }

      // ═══════════════════════════════════════════════════════════════
      // A3 — trigger → generator → judge → write, end-to-end.
      // ═══════════════════════════════════════════════════════════════
      globalThis.fetch = makeFetchMock({
        "a3-trigger.example.no": TRIGGER_NO_LINKS_HTML,
        "a3-notrigger.example.no": NO_TRIGGER_HTML,
      });
      visitJudgeApproves = true;
      insertProvider.run({
        id: "a3-trigger", navn: "A3 Trigger Gard", hjemmeside: "https://a3-trigger.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "a3-notrigger", navn: "A3 NoTrigger Gard", hjemmeside: "https://a3-notrigger.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
      });
      {
        const callsBefore = visitGenCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["a3-trigger", "a3-notrigger"], apply: true },
        });
        assertEq(r.status, 200, "a3-1: apply call → 200");
        assertEq(visitGenCallCount - callsBefore, 1, "a3-2: exactly ONE visit-generator LLM call — only for the host whose page actually carries a trigger signal (A1/weekday/time)");
        const trig = getProviderRow("a3-trigger");
        assertEq(trig.visit_text, GOOD_VISIT_CANDIDATE, "a3-3a: the judge-approved LLM candidate landed in visit_text");
        const entryTrig = r.body.changed.find((c: any) => c.provider_id === "a3-trigger");
        assertTrue(!!entryTrig && entryTrig.fields.includes("visit_text"), "a3-3b: reported as written in changed[]");
        assertEq(entryTrig.actions.visit_text, "filled", "a3-3c: write action is 'filled' (spec A3's own wording), not a new action vocabulary value");
        const fdTrig = r.body.field_diagnostic.find((d: any) => d.provider_id === "a3-trigger");
        assertEq(fdTrig.visit_text, "llm_generated", "a3-3d: field_diagnostic distinguishes this write as llm_generated, not plain 'filled'");

        const notrig = getProviderRow("a3-notrigger");
        assertEq(notrig.visit_text, null, "a3-4a: no trigger signal on this page → visit_text stays null, LLM never asked");
        const fdNotrig = r.body.field_diagnostic.find((d: any) => d.provider_id === "a3-notrigger");
        assertTrue(fdNotrig.visit_text !== "llm_generated", "a3-4b: field_diagnostic does not report llm_generated for the no-trigger row");
      }

      // ── A3 sentinel case: generator finds nothing usable → no write,
      //    counts as no-yield (Del B's own recordProviderContentYield(false)
      //    path — no special-casing needed, it's the natural fallout of an
      //    empty wouldWriteActions). ─────────────────────────────────────
      {
        const OLD_GOOD = GOOD_VISIT_CANDIDATE;
        // Temporarily make the generator return the sentinel for this row
        // by swapping the mock in for a single call.
        const prevFetchLocal = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            const body = init?.body ? JSON.parse(init.body) : {};
            const prompt: string = body?.messages?.[0]?.content ?? "";
            if (prompt.includes("hva et besøk hos gårdsprodusenten")) {
              return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "UTILSTREKKELIG_GRUNNLAG" }] }) } as unknown as Response;
            }
            return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nOK." }] }) } as unknown as Response;
          }
          const host = new URL(urlStr).hostname;
          if (host === "a3-sentinel.example.no") {
            return {
              ok: true, status: 200, text: async () => TRIGGER_NO_LINKS_HTML,
              arrayBuffer: async () => new TextEncoder().encode(TRIGGER_NO_LINKS_HTML).buffer,
              headers: { get: () => null },
            } as unknown as Response;
          }
          const trivial = "<html><body><p>Underside.</p></body></html>";
          return { ok: true, status: 200, text: async () => trivial, arrayBuffer: async () => new TextEncoder().encode(trivial).buffer, headers: { get: () => null } } as unknown as Response;
        }) as unknown as typeof fetch;
        insertProvider.run({
          id: "a3-sentinel", navn: "A3 Sentinel Gard", hjemmeside: "https://a3-sentinel.example.no",
          content_source: null, about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
        });
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["a3-sentinel"], apply: true },
        });
        assertEq(r.status, 200, "a3-5-1: apply call → 200");
        const row = getProviderRow("a3-sentinel");
        assertEq(row.visit_text, null, "a3-5-2: sentinel (no usable material) → no write");
        const entry = r.body.changed.find((c: any) => c.provider_id === "a3-sentinel");
        assertTrue(!entry, "a3-5-3: sentinel row does not appear in changed[] at all (nothing was written for ANY field)");
        globalThis.fetch = prevFetchLocal;
        assertTrue(GOOD_VISIT_CANDIDATE === OLD_GOOD, "sanity: constant not mutated");
      }

      // ── A3 judge-reject case: generator produces a candidate, but the
      //    source-grounded judge rejects it → no write, never trusted on
      //    its own. ─────────────────────────────────────────────────────
      {
        visitJudgeApproves = false;
        globalThis.fetch = makeFetchMock({ "a3-rejected.example.no": TRIGGER_NO_LINKS_HTML });
        insertProvider.run({
          id: "a3-rejected", navn: "A3 Rejected Gard", hjemmeside: "https://a3-rejected.example.no",
          content_source: null, about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
        });
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["a3-rejected"], apply: true },
        });
        assertEq(r.status, 200, "a3-6-1: apply call → 200");
        const row = getProviderRow("a3-rejected");
        assertEq(row.visit_text, null, "a3-6-2: judge REJECTED the candidate → no write, the generator's output is never trusted on its own");
        visitJudgeApproves = true;
      }

      // ═══════════════════════════════════════════════════════════════
      // A4 — JSON-LD opening hours short-circuits the hours LLM entirely.
      // ═══════════════════════════════════════════════════════════════
      globalThis.fetch = makeFetchMock({ "a4-jsonld.example.no": JSONLD_HOURS_HTML });
      insertProvider.run({
        id: "a4-jsonld", navn: "A4 JsonLd Gard", hjemmeside: "https://a4-jsonld.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: STABLE_ABOUT.slice(0, 210), opening_hours_text: null,
      });
      {
        const callsBefore = hoursGenCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["a4-jsonld"], apply: true },
        });
        assertEq(r.status, 200, "a4-1: apply call → 200");
        assertEq(hoursGenCallCount, callsBefore, "a4-2: the hours LLM (generateGardssalgOpeningHoursFromSource, 'Finn åpningstidene') was NEVER called — JSON-LD hit first");
        const row = getProviderRow("a4-jsonld");
        assertEq(row.opening_hours_text, "Mandag, Tirsdag, Onsdag, Torsdag, Fredag 10:00–18:00", "a4-3: the JSON-LD-derived value, in the same normalized shape the LLM path already writes, landed in opening_hours_text");
        const fd = r.body.field_diagnostic.find((d: any) => d.provider_id === "a4-jsonld");
        assertEq(fd.opening_hours_text, "filled", "a4-4: field_diagnostic reports the deterministic 'filled' outcome for a JSON-LD write, distinct from 'llm_generated' (reserved for visit_text's LLM path only)");
      }

      // ═══════════════════════════════════════════════════════════════
      // A5 — kill switch: GARDSSALG_VISIT_LLM_ENABLED=false reproduces
      // today's purely deterministic behavior.
      // ═══════════════════════════════════════════════════════════════
      process.env.GARDSSALG_VISIT_LLM_ENABLED = "false";
      globalThis.fetch = makeFetchMock({ "a5-killswitch.example.no": TRIGGER_NO_LINKS_HTML });
      insertProvider.run({
        id: "a5-killswitch", navn: "A5 Killswitch Gard", hjemmeside: "https://a5-killswitch.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
      });
      {
        const callsBefore = visitGenCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["a5-killswitch"], apply: true },
        });
        assertEq(r.status, 200, "a5-1: apply call → 200");
        assertEq(visitGenCallCount, callsBefore, "a5-2: GARDSSALG_VISIT_LLM_ENABLED=false → the visit generator is NEVER called, even though the page carries a real trigger signal");
        const row = getProviderRow("a5-killswitch");
        assertEq(row.visit_text, null, "a5-3: visit_text stays null — today's purely deterministic behavior, restorable without a revert");
      }
      delete process.env.GARDSSALG_VISIT_LLM_ENABLED;

      // ═══════════════════════════════════════════════════════════════
      // Lock test — a claim row with visit_text owner-locked, and a manual
      // row, must NEVER receive an LLM-generated visit_text write, even
      // though the trigger fires and the judge would approve.
      // ═══════════════════════════════════════════════════════════════
      visitJudgeApproves = true;
      globalThis.fetch = makeFetchMock({
        "lock-claim.example.no": TRIGGER_NO_LINKS_HTML,
        "lock-manual.example.no": TRIGGER_NO_LINKS_HTML,
      });
      insertProvider.run({
        id: "lock-claim", navn: "Lock Claim Gard", hjemmeside: "https://lock-claim.example.no",
        content_source: "claim", about_text: STABLE_ABOUT, visit_text: null, opening_hours_text: null,
        field_provenance: verifiedProvenance({
          owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00.000Z" } },
        }),
      });
      insertProvider.run({
        id: "lock-manual", navn: "Lock Manual Gard", hjemmeside: "https://lock-manual.example.no",
        content_source: "manual", about_text: "Håndskrevet om-tekst", visit_text: null, opening_hours_text: null,
      });
      {
        const callsBefore = visitGenCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["lock-claim", "lock-manual"], apply: true },
        });
        assertEq(r.status, 200, "lock-1: apply call → 200");
        const rowClaim = getProviderRow("lock-claim");
        assertEq(rowClaim.visit_text, null, "lock-2: owner-locked visit_text on a claim row is NEVER written, even with a real trigger + an otherwise-approvable candidate");
        assertTrue(r.body.owner_field_locked.some((e: any) => e.provider_id === "lock-claim" && e.fields.includes("visit_text")), "lock-3: reported in owner_field_locked, naming visit_text");
        const rowManual = getProviderRow("lock-manual");
        assertEq(rowManual.visit_text, null, "lock-4: manual row's visit_text is completely untouched (row-level freeze, before any fetch)");
        assertTrue(r.body.skipped_locked.includes("lock-manual"), "lock-5: manual row reported in skipped_locked, never even fetched");
        // The generator MAY still be called for the claim row (candidate
        // generation happens before the per-field lock gate, same as every
        // other field in this route — see applyGardssalgProviderContent's
        // own per-field guard) — what matters is that it was never WRITTEN.
        assertTrue(visitGenCallCount >= callsBefore, "lock-6: sanity — call count did not go negative / crash");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-drink-visit-uttrekk (section C): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevKillSwitch === undefined) delete process.env.GARDSSALG_VISIT_LLM_ENABLED;
      else process.env.GARDSSALG_VISIT_LLM_ENABLED = prevKillSwitch;
      globalThis.fetch = prevFetch;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgDrinkVisitUttrekkTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

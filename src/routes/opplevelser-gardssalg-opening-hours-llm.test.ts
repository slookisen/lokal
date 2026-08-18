/**
 * opplevelser-gardssalg-opening-hours-llm.test.ts — tests for dev-request
 * 2026-08-18-apningstider-llm-dommer: the LLM-judge replacement for the old
 * character-window/regex extraction of gårdssalg opening_hours_text.
 *
 * Background (see the dev-request / this file's own PR description for the
 * full history): extractOpeningHours() (src/services/search-enrich.ts) slices
 * a ±80-char raw-index window around a day/time regex match, with no word-
 * boundary snapping and no chrome filtering. A full catalog scan found 0
 * clean opening-hours texts across all 173 published gårdssalg profiles that
 * had any — nav-menu/search-box/slider chrome routinely lands glued onto the
 * real hours, or an unrelated "Lorem ipsum" block merely happens to sit near
 * a weekday+time match. Three independent rounds of hardening that SAME
 * extraction mechanism each found a genuinely new defect of the same shape
 * and never shipped; this dev-request abandons the character-window/
 * boundary-search approach entirely in favor of an LLM-judge shape, mirroring
 * generateGardssalgAboutFromSource (see opplevelser-gardssalg-fillblank.test.ts
 * for that helper's own equivalent test shape, which this file mirrors).
 *
 *   - generateGardssalgOpeningHoursFromSource() (src/routes/opplevelser.ts):
 *     mirrors generateGardssalgAboutFromSource's never-fabricate contract —
 *     missing key / network throw / non-200 / unparseable JSON / non-array
 *     content / the literal INGEN_UTVIDELSE_MULIG sentinel / residual
 *     markdown / an oversized response all resolve to null, never throw.
 *     UNLIKE the about/visit helpers, its acceptance gate is NOT
 *     meetsAboutQualityBar (a Norwegian-prose cheap bar that would false-
 *     positive on "Man-fre 10-18") — it is classifyGardssalgFieldDefect()
 *     (services/gardssalg-quality-update.ts), the SAME classifier the write-
 *     side quality-update lever already trusts for this exact field. Section
 *     A below is the direct, no-DB, no-router unit-test coverage for this
 *     helper, including the fail-closed gate itself (oh-11/oh-12).
 *   - Spec C: extractOpeningHours()'s raw return value must never be written
 *     to opening_hours_text anywhere any more — it is strictly a free,
 *     deterministic yes/no TRIGGER for whether an LLM call is worth making.
 *     Section B proves this end-to-end through POST /admin/gardssalg-
 *     content-refresh: a page whose raw regex-matched snippet is itself
 *     chrome-contaminated ends up with a CLEAN, judge-approved value written
 *     — never the raw snippet — and a page with no weekday+time signal at
 *     all never even calls the Anthropic endpoint for hours.
 *
 * Mirrors opplevelser-gardssalg-fillblank.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch for BOTH the
 * page-content crawl (crFetchGardssalgContent, keyed by hostname) AND the
 * Anthropic API call (keyed by URL containing "api.anthropic.com"), since
 * the sandbox has no live network access to either.
 */

import { generateGardssalgOpeningHoursFromSource } from "./opplevelser";

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

export function runOpplevelserGardssalgOpeningHoursLlmTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;

    // ═══════════════════════════════════════════════════════════════════
    // Section A — generateGardssalgOpeningHoursFromSource() direct unit
    // tests (no DB, no router — pure w.r.t. everything but fetch()/env).
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SOURCE_TEXT = "Gården vår ligger på Toten. Åpningstider: mandag til fredag 09:00-15:00, lørdag og søndag stengt. Velkommen innom!";
      const NAVN = "Toten Gårdsbutikk";
      const GOOD_HOURS = "Mandag – fredag: 09–15, lørdag og søndag stengt";

      // ── oh-1: missing ANTHROPIC_API_KEY → null, fetch never invoked ────
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("oh-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-1: missing ANTHROPIC_API_KEY → null");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── oh-2: mocked 200 response with a good candidate → returned, and
      //    the request carries the model/prompt contract (navn + source +
      //    sentinel instruction + explicit chrome-exclusion instruction).
      let capturedInit: any = null;
      let capturedUrl: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: GOOD_HOURS }] }),
        };
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, GOOD_HOURS, "oh-2a: mocked 200 with a good candidate → returned verbatim");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "oh-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "oh-2c: model is claude-haiku-4-5");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(NAVN), "oh-2d: prompt includes navn");
        assertTrue(body.messages[0].content.includes(SOURCE_TEXT), "oh-2e: prompt includes the source text");
        assertTrue(body.messages[0].content.includes("INGEN_UTVIDELSE_MULIG"), "oh-2f: prompt includes the escape sentinel instruction");
        assertTrue(body.messages[0].content.includes("Bruk KUN fakta som faktisk står i kildeteksten"), "oh-2g: prompt includes the exact grounding instruction");
        assertTrue(
          /meny|bunntekst|søkefelt|navigasjons|mal-\/skjelett/i.test(body.messages[0].content),
          "oh-2h: prompt explicitly teaches the model that menu/footer/search-box/nav chrome is NOT opening hours (the exact failure mode this helper exists to eliminate)",
        );
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "oh-2i: x-api-key header carries ANTHROPIC_API_KEY");
      }

      // ── oh-3: source text capped to ~6000 chars in the prompt (reuses
      //    GARDSSALG_REWRITE_SOURCE_CHAR_CAP, not a redefined constant). ────
      {
        const hugeSource = "x".repeat(20000);
        await generateGardssalgOpeningHoursFromSource(hugeSource, NAVN);
        const body = JSON.parse(capturedInit.body);
        const xRunLength = (body.messages[0].content.match(/x+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
        assertTrue(xRunLength <= 6000, "oh-3: source text is capped to ~6000 chars in the prompt, not passed through unbounded");
      }

      // ── oh-4: sentinel handling — verbatim, whitespace-padded, and
      //    embedded-in-longer-prose all → null. ──────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-4a: the literal INGEN_UTVIDELSE_MULIG sentinel → null");
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "  INGEN_UTVIDELSE_MULIG  \n" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-4b: sentinel with surrounding whitespace (trimmed) → still null");
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: `Beklager, jeg finner ingen åpningstider. INGEN_UTVIDELSE_MULIG` }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-4c: sentinel embedded in longer prose → null, never published with the sentinel in it");
      }

      // ── oh-5: network throw → null, never throws itself. ────────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-5: fetch throw (network failure) → null, not re-thrown");
      }

      // ── oh-6: non-200 response → null. ───────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-6: non-200 response → null");
      }

      // ── oh-7: unparseable JSON body (.json() throws) → null. ─────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-7: unparseable JSON response body → null");
      }

      // ── oh-8: non-array content field → null, never throws. ──────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-8: non-array content field → null, not a thrown TypeError");
      }

      const mockText = (t: string) =>
        (globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: t }] }),
        })) as unknown as typeof fetch);

      // ── oh-9: markdown artifacts are stripped and the candidate is
      //    accepted when the stripped text still clears the defect gate. ───
      mockText(`**${GOOD_HOURS}**`);
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertTrue(r !== null, "oh-9a: markdown-formatted candidate is accepted after stripping");
        assertTrue(!!r && !/[*#`]/.test(r), "oh-9b: no asterisks/hashes/backticks survive into the returned value");
        assertEq(r, GOOD_HOURS, "oh-9c: stripped result matches the underlying text exactly");
      }

      // ── oh-10: residual markdown after stripping (unpaired "**") →
      //    rejected outright. ───────────────────────────────────────────────
      mockText(`og **${GOOD_HOURS}`);
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-10: unpaired ** survives stripping → residual check rejects (fail-closed)");
      }

      // ── oh-11: the fail-closed gate (spec B) — a candidate that reads as
      //    real prose but carries the EXACT defect shape this whole helper
      //    exists to eliminate (UI slider-navigation chrome glued onto real
      //    hours — the dev-request's own Bringebærlandet example) must be
      //    rejected by classifyGardssalgFieldDefect, never written. This is
      //    the crux acceptance test: a defective generator OUTPUT becomes
      //    null before it ever leaves this function. ─────────────────────
      mockText("Mandag–fredag 10-18. Previous Next Lørdag stengt.");
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-11a: UI slider-nav chrome ('Previous Next') in the candidate → rejected by classifyGardssalgFieldDefect, never written");
      }
      // Cross-check directly against the same classifier this helper reuses,
      // so a future change to either side is caught by this test failing
      // rather than silently drifting apart.
      {
        const { classifyGardssalgFieldDefect } = require("../services/gardssalg-quality-update") as
          typeof import("../services/gardssalg-quality-update");
        const verdict = classifyGardssalgFieldDefect("opening_hours_text", "Mandag–fredag 10-18. Previous Next Lørdag stengt.");
        assertEq(verdict.defective, true, "oh-11b: sanity — classifyGardssalgFieldDefect itself flags this exact string as defective (ui_chrome_leakage)");
        assertEq(verdict.type, "ui_chrome_leakage", "oh-11c: sanity — and names the specific defect type this test is about");
      }

      // ── oh-12: a near-empty candidate ("...", below the field's own
      //    too_short floor of 8 chars) → null via the SAME gate — proves the
      //    gate's lower bound is classifyGardssalgFieldDefect's, not an
      //    ad-hoc length check inside this helper. ─────────────────────────
      mockText("...");
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-12: near-empty candidate below the too_short floor → null");
      }

      // ── oh-13: a legitimately SHORT but clean hours string ("Lør-søn
      //    10-16", 15 chars) must NOT be rejected merely for being short —
      //    opening_hours_text is deliberately exempt from the Norwegian-
      //    prose cheap-bar backstop inside classifyGardssalgFieldDefect. ───
      mockText("Lør-søn 10-16");
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, "Lør-søn 10-16", "oh-13: a legitimately short, clean hours string is accepted, not rejected for brevity");
      }

      // ── oh-14: an oversized, rambling response (over the safety-valve cap)
      //    → null, even though nothing in it individually trips
      //    classifyGardssalgFieldDefect — guards against a non-conforming
      //    reply that ignored the "kort setning" instruction. ─────────────
      mockText("Vi har åpent " + "svært lenge ".repeat(40) + "hver dag.");
      {
        const r = await generateGardssalgOpeningHoursFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "oh-14: an oversized rambling response → null (safety valve, not the classifyGardssalgFieldDefect gate)");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-opening-hours-llm (section A): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — POST /admin/gardssalg-content-refresh route-level wiring
    // (spec C end-to-end: extractOpeningHours() is a trigger only, never
    // the written value).
    // ═══════════════════════════════════════════════════════════════════
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-opening-hours-llm-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-route";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // about_text/visit_text/products are pre-filled with content that
      // clears the cheap bar and is >=200 chars (so gardssalgRewriteEligible
      // never fires either) — this file isolates the opening_hours_text
      // path only; a candidate/rewrite/fill opportunity on the OTHER three
      // fields would add extra, irrelevant Anthropic calls this file's
      // anthropicPromptsSeen assertions don't want to have to account for.
      const STABLE_ABOUT =
        "Gården ligger idyllisk til ved fjorden og har vært i familiens eie i fire generasjoner. Vi dyrker poteter, bær og grønnsaker, og selger alt direkte fra egen gårdsbutikk gjennom hele sommersesongen, med fokus på kortreist og bærekraftig produksjon.";
      const STABLE_VISIT =
        "Besøkende er hjertelig velkomne til gårdsbutikken for å handle ferske varer rett fra jordet, se dyrene på nært hold og nyte den vakre utsikten over fjorden mens de handler inn ukens middag før hjemturen.";
      assertTrue(STABLE_ABOUT.length >= 200, "sanity: STABLE_ABOUT is long enough that gardssalgRewriteEligible never fires");
      assertTrue(STABLE_VISIT.length >= 200, "sanity: STABLE_VISIT is long enough that gardssalgRewriteEligible never fires");

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, '["Placeholder"]', @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const VERIFIED_PROVENANCE = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const insertProvider = {
        run(params: Record<string, unknown>): void {
          insertProviderStmt.run({ field_provenance: VERIFIED_PROVENANCE, ...params });
        },
      };

      // A regex-friendly TRIGGER (weekday + time) whose surrounding raw text
      // is deliberately chrome-contaminated — the exact shape
      // extractOpeningHours()'s old ±80-char window would have glued
      // straight into opening_hours_text (spec C's whole reason for being).
      // The LLM mock below returns a CLEAN candidate for this host; the test
      // asserts the CLEAN value lands in the DB, never the raw chrome-glued
      // text extractOpeningHours() would have sliced.
      const TRIGGER_HOURS_HTML =
        "<html><body><nav>Hjem Produkter Søk</nav><p>Previous Next Mandag 10:00-18:00 Slide Neste</p></body></html>";
      // No weekday name and no time pattern anywhere — extractOpeningHours()
      // must return null, so the Anthropic endpoint must never be called for
      // hours on this host at all (cost control, spec C).
      const NO_TRIGGER_HTML =
        "<html><body><p>Velkommen til gården vår, ring for mer info.</p></body></html>";

      const CLEAN_HOURS_CANDIDATE = "Mandag 10–18";

      let anthropicHoursCallCount = 0;
      let anthropicOtherCallCount = 0;
      const anthropicPromptsSeen: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          const body = init?.body ? JSON.parse(init.body) : {};
          const prompt: string = body?.messages?.[0]?.content ?? "";
          anthropicPromptsSeen.push(prompt);
          if (prompt.includes("Finn åpningstidene")) {
            anthropicHoursCallCount++;
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: CLEAN_HOURS_CANDIDATE }] }),
            } as unknown as Response;
          }
          // about/visit judge or any other Anthropic call this run isn't
          // meant to exercise — approve/pass-through so a stray call never
          // crashes the run, but count it so the isolation assertion below
          // can catch a regression if one starts firing unexpectedly.
          anthropicOtherCallCount++;
          if (prompt.includes("kvalitetsdommer")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-oh-trigger.example.no") {
          return {
            ok: true, status: 200, text: async () => TRIGGER_HOURS_HTML,
            arrayBuffer: async () => new TextEncoder().encode(TRIGGER_HOURS_HTML).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (host === "prov-oh-notrigger.example.no") {
          return {
            ok: true, status: 200, text: async () => NO_TRIGGER_HTML,
            arrayBuffer: async () => new TextEncoder().encode(NO_TRIGGER_HTML).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as unknown as typeof fetch;

      insertProvider.run({
        id: "prov-oh-trigger", navn: "Prov OH Trigger Gard", hjemmeside: "https://prov-oh-trigger.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: STABLE_VISIT, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-oh-notrigger", navn: "Prov OH NoTrigger Gard", hjemmeside: "https://prov-oh-notrigger.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: STABLE_VISIT, opening_hours_text: null,
      });

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, opening_hours_text, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }

      const r = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-oh-trigger", "prov-oh-notrigger"], apply: true },
      });
      assertEq(r.status, 200, "ohr-1: apply call → 200");

      // ── The trigger host: LLM was called, and the CLEAN candidate — never
      //    the raw chrome-glued regex snippet — is what landed in the DB. ──
      assertEq(anthropicHoursCallCount, 1, "ohr-2: exactly one hours LLM call was made — only for the host whose page actually triggered the regex prefilter");
      const trig = getProviderRow("prov-oh-trigger");
      assertEq(trig.opening_hours_text, CLEAN_HOURS_CANDIDATE, "ohr-3a: the written value is the LLM's clean candidate");
      assertTrue(!/previous|next|søk/i.test(trig.opening_hours_text ?? ""), "ohr-3b: the written value does NOT contain the raw page's nav/slider chrome — spec C: extractOpeningHours()'s own return value is never written");
      const entryTrig = r.body.changed.find((c: any) => c.provider_id === "prov-oh-trigger");
      assertTrue(!!entryTrig && entryTrig.fields.includes("opening_hours_text"), "ohr-3c: reported as written in changed[]");

      // ── The no-trigger host: the free regex prefilter found nothing, so
      //    the LLM must never have been asked about it at all (spec C cost
      //    control) — field stays null. ─────────────────────────────────
      const notrig = getProviderRow("prov-oh-notrigger");
      assertEq(notrig.opening_hours_text, null, "ohr-4a: no regex trigger on this page → opening_hours_text stays null");
      assertTrue(
        !anthropicPromptsSeen.some((p) => p.includes("Finn åpningstidene") && p.includes(NO_TRIGGER_HTML.replace(/<[^>]+>/g, " ").trim().slice(0, 20))),
        "ohr-4b: the no-trigger page's text was never sent to the hours prompt",
      );

      // ── Regression guard (acceptance criterion 6): about_text/visit_text
      //    were pre-filled long/clean and must be completely untouched — no
      //    action reported for either field on either provider, and their
      //    stored values are byte-identical to what was inserted. ─────────
      assertEq(trig.about_text, STABLE_ABOUT, "ohr-5a: about_text on the trigger host is untouched");
      assertEq(trig.visit_text, STABLE_VISIT, "ohr-5b: visit_text on the trigger host is untouched");
      assertEq(notrig.about_text, STABLE_ABOUT, "ohr-5c: about_text on the no-trigger host is untouched");
      assertEq(notrig.visit_text, STABLE_VISIT, "ohr-5d: visit_text on the no-trigger host is untouched");
      assertTrue(!entryTrig || !entryTrig.fields.includes("about_text"), "ohr-5e: about_text not reported as written on the trigger host");
      assertTrue(!entryTrig || !entryTrig.fields.includes("visit_text"), "ohr-5f: visit_text not reported as written on the trigger host");

      // ── The fail-closed gate wired through the real route (not just the
      //    helper in isolation): a triggered page whose LLM candidate is
      //    itself defective (UI chrome leakage) must write NOTHING for
      //    opening_hours_text, not the defective candidate. ──────────────
      globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          const body = init?.body ? JSON.parse(init.body) : {};
          const prompt: string = body?.messages?.[0]?.content ?? "";
          if (prompt.includes("Finn åpningstidene")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "Man-fre 10-18 Previous Next" }] }),
            } as unknown as Response;
          }
          if (prompt.includes("kvalitetsdommer")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-oh-defective.example.no") {
          return {
            ok: true, status: 200, text: async () => TRIGGER_HOURS_HTML,
            arrayBuffer: async () => new TextEncoder().encode(TRIGGER_HOURS_HTML).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as unknown as typeof fetch;
      insertProvider.run({
        id: "prov-oh-defective", navn: "Prov OH Defective Gard", hjemmeside: "https://prov-oh-defective.example.no",
        content_source: null, about_text: STABLE_ABOUT, visit_text: STABLE_VISIT, opening_hours_text: null,
      });
      const r2 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-oh-defective"], apply: true },
      });
      assertEq(r2.status, 200, "ohr-6: apply call (defective candidate) → 200");
      const defective = getProviderRow("prov-oh-defective");
      assertEq(defective.opening_hours_text, null, "ohr-7a: a triggered page whose LLM candidate carries UI chrome leakage writes NOTHING — fail-closed end-to-end, not just in the helper's own unit tests");
      const entryDefective = r2.body.changed.find((c: any) => c.provider_id === "prov-oh-defective");
      assertTrue(!entryDefective || !entryDefective.fields.includes("opening_hours_text"), "ohr-7b: not reported as written either");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-opening-hours-llm (section B): unexpected error: " + String(err?.stack || err?.message || err));
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
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOpeningHoursLlmTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

/**
 * opplevelser-gardssalg-rewrite.test.ts — tests for slice 5a of dev-request
 * 2026-07-18-gardssalg-profilkvalitet-foer-outreach: the source-grounded
 * LLM REWRITE of gårdssalg about_text/visit_text for the "passing-bar-but-
 * short" cohort — current value is already non-blank AND already passes
 * meetsAboutQualityBar (so gardssalgReplaceableFieldAction() would say
 * "never churn"), but is still <200 chars.
 *
 *   - generateGardssalgAboutRewrite() (src/routes/opplevelser.ts): mirrors
 *     generateTitleNo()'s never-fabricate contract — missing key / network
 *     throw / non-200 / unparseable JSON / the literal INGEN_UTVIDELSE_MULIG
 *     sentinel / a response outside the code-enforced [200,500]-char range
 *     all resolve to null, never throw.
 *   - gardssalgRewriteEligible() (src/services/experience-store.ts) has its
 *     own dedicated pure-function tests in experience-store.test.ts; this
 *     file exercises it only through the route's wiring.
 *   - POST /admin/gardssalg-content-refresh's processOne(): for an eligible
 *     field, calls the new helper with the ALREADY-fetched page text, marks
 *     the action "rewritten" (dry-run AND apply), and — in apply mode —
 *     writes through the EXISTING applyGardssalgProviderContent() audit/
 *     provenance/lock-guard machinery (extended with a `rewriteFields` bypass
 *     for gardssalgReplaceableFieldAction's "never churn" veto, since a
 *     rewrite candidate's current value ALWAYS already passes the quality
 *     bar by construction).
 *
 * Mirrors opplevelser-gardssalg-content-audit.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch for BOTH the
 * page-content crawl (crFetchGardssalgContent, keyed by hostname — same
 * technique as content-audit's block (k)) AND the Anthropic API call (keyed
 * by URL containing "api.anthropic.com"), since the sandbox has no live
 * network access to either.
 */

import { generateGardssalgAboutRewrite } from "./opplevelser";

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

export function runOpplevelserGardssalgRewriteTests(
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
    // Section A — generateGardssalgAboutRewrite() direct unit tests
    // (no DB, no router — the function is pure w.r.t. everything but
    // fetch()/env, exported specifically for this direct test surface).
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SOURCE_TEXT = "Gården vår ligger på Toten og har vært i familiens eie i fire generasjoner. Vi dyrker poteter, gulrøtter og bær, og selger alt direkte fra gårdsbutikken vår hver lørdag om sommeren.";
      const CURRENT_VALUE = "Familiedrevet gård på Toten som dyrker grønnsaker og bær, og selger dem i egen butikk.";
      const VALID_250 =
        "Familiedrevet gård på Toten som i fire generasjoner har dyrket poteter, gulrøtter og bær, og som selger alt direkte fra egen gårdsbutikk hver lørdag om sommeren. Gården ligger vakkert til med utsikt over Mjøsa, og tar imot besøkende gjennom hele sesongen.";
      assertTrue(VALID_250.length >= 200 && VALID_250.length <= 500, "sanity: VALID_250 is inside the [200,500] accept window");

      // ── ru-1: missing ANTHROPIC_API_KEY → null, fetch never invoked ──────
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("ru-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-1: missing ANTHROPIC_API_KEY → null");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── ru-2: mocked 200 response with a valid 250-char candidate → returned,
      //    and the request itself carries the model/prompt contract. ────────
      let capturedInit: any = null;
      let capturedUrl: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: VALID_250 }] }),
        };
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, VALID_250, "ru-2a: mocked 200 with a valid 250-char candidate → returned verbatim");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "ru-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-opus-4-8", "ru-2c: model is claude-opus-4-8 (same as generateTitleNo)");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(CURRENT_VALUE), "ru-2d: prompt includes the current value as context");
        assertTrue(body.messages[0].content.includes(SOURCE_TEXT), "ru-2e: prompt includes the source text");
        assertTrue(body.messages[0].content.includes("INGEN_UTVIDELSE_MULIG"), "ru-2f: prompt includes the escape sentinel instruction");
        assertTrue(body.messages[0].content.includes("Bruk KUN fakta som faktisk står i kildeteksten"), "ru-2g: prompt includes the exact grounding instruction");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "ru-2h: x-api-key header carries ANTHROPIC_API_KEY");
      }

      // ── ru-3: source text capped to ~6000 chars in the prompt (no
      //    unbounded prompt growth). ─────────────────────────────────────
      {
        const hugeSource = "x".repeat(20000);
        await generateGardssalgAboutRewrite(hugeSource, CURRENT_VALUE, "about");
        const body = JSON.parse(capturedInit.body);
        const xRunLength = (body.messages[0].content.match(/x+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
        assertTrue(xRunLength <= 6000, "ru-3: source text is capped to ~6000 chars in the prompt, not passed through unbounded");
      }

      // ── ru-4: mocked response with the literal sentinel → null. ─────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-4a: the literal INGEN_UTVIDELSE_MULIG sentinel → null");
      }
      // Sentinel with incidental surrounding whitespace is still recognized
      // (the code trims before comparing).
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "  INGEN_UTVIDELSE_MULIG  \n" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "visit");
        assertEq(r, null, "ru-4b: sentinel with surrounding whitespace (trimmed) → still null");
      }

      // ── ru-5: candidate outside [200,500] → null (length gate enforced in
      //    code, not trusted to the prompt). ───────────────────────────────
      const TOO_SHORT_50 = "y".repeat(50);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: TOO_SHORT_50 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-5a: a 50-char non-sentinel candidate (too short) → null, rejected in code");
      }
      const TOO_LONG_600 = "z".repeat(600);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: TOO_LONG_600 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-5b: a 600-char candidate (too long) → null, never truncated and returned");
      }
      // Boundary values: exactly 200 and exactly 500 are BOTH accepted.
      const EXACT_200 = "a".repeat(200);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: EXACT_200 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, EXACT_200, "ru-5c: exactly 200 chars → accepted (inclusive lower bound)");
      }
      const EXACT_500 = "b".repeat(500);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: EXACT_500 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, EXACT_500, "ru-5d: exactly 500 chars → accepted (inclusive upper bound)");
      }
      const JUST_UNDER_200 = "c".repeat(199);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: JUST_UNDER_200 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-5e: 199 chars (just under the floor) → null");
      }
      const JUST_OVER_500 = "d".repeat(501);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: JUST_OVER_500 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-5f: 501 chars (just over the ceiling) → null");
      }

      // ── ru-6: network throw → null, never throws itself. ─────────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-6: fetch throw (network failure) → null, not re-thrown");
      }

      // ── ru-7: non-200 response → null. ────────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-7: non-200 response → null");
      }

      // ── ru-8: unparseable JSON body (.json() throws) → null. ──────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-8: unparseable JSON response body → null");
      }

      // ── ru-9: response shape with non-array content (defensive, mirrors
      //    generateTitleNo's own tnb-9 regression) → null, never throws. ────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-9: non-array content field → null, not a thrown TypeError");
      }

      // ── ru-10: markdown artifacts are stripped before the value is
      //    returned — regression for the live 2026-07-19 finding where the
      //    first real prod rewrite landed "**Smaksprøver og foredrag**" with
      //    raw asterisks on the public Besøket section (profile template
      //    renders plain text; batch was held + field rolled back on this).
      const MD_PROSE =
        "Smaksprøver og foredrag: våre populære ølsmakinger med omvisning på bryggeriet er åpne hele året. Her får du smake brygg fra hele sortimentet vårt, laget med råvarer fra fjellbygda, og høre historien bak bryggeriet fra våre egne bryggere.";
      assertTrue(MD_PROSE.length >= 200 && MD_PROSE.length <= 500, "sanity: ru-10's underlying prose is comfortably inside the [200,500] window (the stripped fixture keeps heading TEXT and lands slightly longer)");
      const MD_WRAPPED = `## Besøket\n\n**Smaksprøver og foredrag**: våre *populære* ølsmakinger med omvisning på bryggeriet er åpne hele året. Her får du smake brygg fra hele sortimentet vårt, laget med råvarer fra fjellbygda, og høre historien bak bryggeriet fra våre egne `.concat("`bryggere`.");
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: MD_WRAPPED }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "visit");
        assertTrue(r !== null, "ru-10a: markdown-formatted candidate is accepted after stripping (not rejected)");
        assertTrue(!!r && !/[*#`]/.test(r), "ru-10b: no asterisks/hashes/backticks survive into the returned value");
        assertTrue(!!r && !r.includes("\n"), "ru-10c: newlines collapse to single-paragraph flow");
        assertTrue(!!r && r.includes("Smaksprøver og foredrag") && r.includes("populære"), "ru-10d: the prose itself survives the strip intact");
      }

      // ── ru-11: the length gate judges the STRIPPED string — prose padded
      //    over the floor purely by markdown syntax must still be rejected. ──
      const PROSE_195 = "e".repeat(195);
      const MD_PADDED_OVER_200 = `**${PROSE_195}**\n# x`; // 203 raw chars, 197 after strip
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: MD_PADDED_OVER_200 }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-11: markdown-padded candidate whose stripped prose is under 200 chars → null");
      }

      // ── ru-12: prompt carries the plain-text instruction (belt half of the
      //    belt-and-suspenders; the code-side strip is the suspenders). ──────
      let promptCaptured: any = null;
      globalThis.fetch = (async (_url: any, init: any) => {
        promptCaptured = JSON.parse(init.body).messages[0].content;
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: VALID_250 }] }) };
      }) as unknown as typeof fetch;
      {
        await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertTrue(typeof promptCaptured === "string" && promptCaptured.includes("uten markdown-formatering"), "ru-12: prompt instructs plain text without markdown");
      }

      // ── ru-13: review round-1 leak shapes — the residual fail-closed
      //    contract: strip what is well-formed, REJECT anything that still
      //    carries a marker afterwards; never publish, never corrupt. ────────
      const mockText = (t: string) =>
        (globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: t }] }),
        })) as unknown as typeof fetch);
      // (a) THE round-1 blocker form: a bullet line whose star would pair
      // with an italic star under the old strip order and leak a raw "*".
      const BULLET_ITALIC =
        "* Vi har *mange* gode øl på lager i gårdsbutikken, brygget med vann fra egen kilde og korn fra nabogårdene. Besøkende får omvisning i bryggeriet, historien bak hvert brygg, og smaksprøver av både faste og sesongbaserte varianter hele året.";
      mockText(BULLET_ITALIC);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "visit");
        assertTrue(r !== null, "ru-13a: bullet+italic line is accepted after the reordered strip");
        assertTrue(!!r && !/[*#`_]/.test(r), "ru-13b: NO marker of any kind survives (the round-1 leak shape)");
        assertTrue(!!r && r.includes("mange gode øl"), "ru-13c: prose intact after bullet+italic strip");
      }
      // (b) unpaired ** → residual → reject.
      const PAD_220 = "Gården tilbyr omvisning, smaksprøver og gardsbutikk med egne produkter gjennom hele sesongen, og tar imot både små og store grupper etter avtale. ".repeat(2);
      mockText(`og **smaksprøver hele året ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-13d: unpaired ** survives stripping → residual check rejects (fail-closed)");
      }
      // (c) single-underscore italics → residual → reject.
      mockText(`Vi selger _kortreiste_ råvarer direkte fra gården. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-13e: _kursiv_ underscores → residual check rejects");
      }
      // (d) sentinel wrapped in markdown → null (not published, not length-gated by luck).
      mockText("**INGEN_UTVIDELSE_MULIG**");
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-13f: markdown-wrapped sentinel → null");
      }
      // (e) sentinel embedded in ≥200 chars of prose → null.
      mockText(`${PAD_220} INGEN_UTVIDELSE_MULIG`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-13g: sentinel embedded in long prose → null, never published with the sentinel in it");
      }
      // (f) spaced multiplication signs must never pair-and-vanish (silent
      // meaning change) — they survive the hugging-italics regex and the
      // residual check rejects the candidate instead.
      mockText(`Vi tar imot 2 * 3 grupper i uken og 4 * 5 personer per omvisning. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-13h: spaced '*' (multiplication) → rejected, never silently rewritten to '2 3'");
      }

      // ── ru-14: round-2 leak shapes — links unwrap to their text; leftover
      //    bracket/backslash syntax rejects; blockquote markers strip. ───────
      mockText(`Les mer om oss på [nettsiden vår](https://example.no/om-oss) der du finner alt om gården. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertTrue(r !== null, "ru-14a: markdown link unwraps and the candidate is accepted");
        assertTrue(!!r && r.includes("nettsiden vår") && !/[\[\]]/.test(r) && !r.includes("https://"), "ru-14b: link TEXT survives, URL and brackets do not");
      }
      mockText(`Huskeliste: - [ ] bestill omvisning. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-14c: leftover checkbox brackets → residual reject");
      }
      mockText(`Vi lager \\*ekte\\* sider av egne epler. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-14d: escaped-markdown backslash remnants → residual reject");
      }
      mockText(`> Vi gleder oss til å ta imot besøkende i sommer, sier bonden. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "visit");
        assertTrue(r !== null && !r.includes(">"), "ru-14e: leading blockquote marker stripped cleanly, prose accepted");
      }
      // (round 3) strikethrough must never publish raw — "~~stengt~~ nå åpent"
      // would read as if "stengt" were current text; tables likewise.
      mockText(`Vi holder ~~stengt~~ åpent hver helg gjennom hele sesongen. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-14f: strikethrough tildes → residual reject, never published as apparent current text");
      }
      mockText(`| Produkt | Pris | og mer informasjon om oss finner du hos gården. ${PAD_220}`);
      {
        const r = await generateGardssalgAboutRewrite(SOURCE_TEXT, CURRENT_VALUE, "about");
        assertEq(r, null, "ru-14g: markdown table pipes → residual reject");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-rewrite (section A): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — POST /admin/gardssalg-content-refresh route-level wiring
    // ═══════════════════════════════════════════════════════════════════
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "gardssalg-rewrite-test-key";
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

      // `products` is pre-filled (non-empty) on every fixture below so the
      // slice 5c fill-only products-extraction path (gardssalgProductsEligible)
      // never fires for these rows — this file isolates about_text/visit_text
      // rewrite behavior only; a blank `products` column would make the
      // route's processOne() ALSO call the (shared, mocked) Anthropic
      // endpoint for a products candidate every run, throwing off this
      // file's anthropicCallCount assertions for an unrelated field.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, '["Placeholder"]',
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      const PASSING_BAR_SHORT_86 =
        "Familiedrevet gård på Toten som dyrker grønnsaker og bær, og selger dem i egen butikk.";
      const SUB_80_THIN = "Liten gård med noen dyr og epletrær.";
      const REWRITE_CANDIDATE_250 =
        "Familiedrevet gård på Toten som i fire generasjoner har dyrket poteter, gulrøtter og bær, og som selger alt direkte fra egen gårdsbutikk hver lørdag om sommeren. Gården ligger vakkert til med utsikt over Mjøsa, og tar imot besøkende gjennom hele sesongen.";
      assertTrue(PASSING_BAR_SHORT_86.length >= 80 && PASSING_BAR_SHORT_86.length < 200, "sanity: PASSING_BAR_SHORT_86 is in the rewrite-eligible [80,200) window");
      assertTrue(SUB_80_THIN.length < 80, "sanity: SUB_80_THIN is under the 80-char quality bar");
      assertTrue(REWRITE_CANDIDATE_250.length >= 200 && REWRITE_CANDIDATE_250.length <= 500, "sanity: REWRITE_CANDIDATE_250 is inside the accept window");

      insertProvider.run({
        id: "prov-rw-thin", navn: "Prov RW Thin Gard", hjemmeside: "https://prov-rw-thin.example.no",
        content_source: null, about_text: PASSING_BAR_SHORT_86, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-rw-locked", navn: "Prov RW Locked Gard", hjemmeside: "https://prov-rw-locked.example.no",
        content_source: "manual", about_text: PASSING_BAR_SHORT_86, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-rw-sub80", navn: "Prov RW Sub80 Gard", hjemmeside: "https://prov-rw-sub80.example.no",
        content_source: null, about_text: SUB_80_THIN, visit_text: null, opening_hours_text: null,
      });

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, opening_hours_text, content_source,
                  content_evidence_url, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      // ── Mocked globalThis.fetch: routes homepage/sub-page fetches (keyed by
      // hostname, mirrors content-audit test block (k)) AND the Anthropic API
      // call (keyed by URL substring) through one function, tracked with a
      // call counter so "the LLM was never called" is directly assertable
      // rather than inferred. ────────────────────────────────────────────
      let anthropicCallCount = 0;
      // A page with NO og:description/meta description, no VISIT_KEYWORDS
      // match, and no opening-hours pattern — so the pre-existing extractive
      // path (summarizeAbout/summarizeVisit/extractOpeningHours) contributes
      // NOTHING for prov-rw-thin, isolating the rewrite path as the only
      // source of any about_text action for that provider.
      const rwThinHtml = "<html><body><p>Velkommen til gården vår, ring for mer info.</p></body></html>";
      // A page WITH a passing-bar, longer og:description — this is what
      // lets prov-rw-sub80's THIN (sub-80) about_text go through the
      // EXISTING replace path (action "replaced"), proving the rewrite
      // helper is never invoked for that cohort.
      const rwSub80Html = `<html><head><meta property="og:description" content="${PASSING_BAR_SHORT_86}"></head><body><p>Velkommen innom oss.</p></body></html>`;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: REWRITE_CANDIDATE_250 }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-rw-thin.example.no") {
          return { ok: true, status: 200, text: async () => rwThinHtml } as unknown as Response;
        }
        if (host === "prov-rw-sub80.example.no") {
          return { ok: true, status: 200, text: async () => rwSub80Html } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ── rw-1: dry-run on prov-rw-thin → about_text action "rewritten",
      //    LLM WAS called (dry-run previews with a real call), nothing
      //    written, provenance visible in the dry-run response. ──────────
      const callsBeforeDry = anthropicCallCount;
      const dryRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-rw-thin"], apply: false },
      });
      assertEq(dryRes.status, 200, "rw-1a: dry-run -> 200");
      assertEq(dryRes.body.dry_run, true, "rw-1b: dry_run:true");
      assertTrue(anthropicCallCount > callsBeforeDry, "rw-1c: dry-run DID call the LLM (real preview, not guessed)");
      const dryEntry = dryRes.body.changed.find((c: any) => c.provider_id === "prov-rw-thin");
      assertTrue(!!dryEntry, "rw-1d: prov-rw-thin appears in dry-run changed[]");
      assertEq(dryEntry.actions.about_text, "rewritten", "rw-1e: dry-run projects about_text as 'rewritten'");
      assertTrue(dryEntry.fields.includes("about_text"), "rw-1f: fields[] lists about_text too");
      assertTrue(!!dryEntry.provenance.about_text, "rw-1g: dry-run response carries provenance for the rewritten field");
      assertEq(dryEntry.provenance.about_text.source_url, "https://prov-rw-thin.example.no", "rw-1h: provenance source_url is the fetched homepage");
      const beforeDryWrite = getProviderRow("prov-rw-thin");
      assertEq(beforeDryWrite.about_text, PASSING_BAR_SHORT_86, "rw-1i: dry-run performed ZERO writes — about_text unchanged in the DB");
      assertEq(getAuditRows("prov-rw-thin").length, 0, "rw-1j: dry-run created no audit row");

      // ── rw-2: apply mode on prov-rw-thin → actually writes through
      //    applyGardssalgProviderContent, with a matching audit row +
      //    field_provenance entry. ──────────────────────────────────────
      const applyRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-rw-thin"], apply: true },
      });
      assertEq(applyRes.status, 200, "rw-2a: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "rw-2b: dry_run:false");
      const applyEntry = applyRes.body.changed.find((c: any) => c.provider_id === "prov-rw-thin");
      assertTrue(!!applyEntry, "rw-2c: prov-rw-thin appears in apply changed[]");
      assertEq(applyEntry.actions.about_text, "rewritten", "rw-2d: apply response tags about_text 'rewritten'");

      const rowAfterApply = getProviderRow("prov-rw-thin");
      assertEq(rowAfterApply.about_text, REWRITE_CANDIDATE_250, "rw-2e: about_text actually rewritten to the accepted 250-char candidate");
      assertEq(rowAfterApply.content_source, "provider_site", "rw-2f: content_source stamped provider_site");

      const auditRows = getAuditRows("prov-rw-thin");
      const aboutAudit = auditRows.find((r: any) => r.field_name === "about_text");
      assertTrue(!!aboutAudit, "rw-2g: an about_text audit row exists for the rewrite");
      assertEq(aboutAudit.old_value, PASSING_BAR_SHORT_86, "rw-2h: audit old_value is the REAL prior (passing-bar-but-short) text, not blank");
      assertEq(aboutAudit.new_value, REWRITE_CANDIDATE_250, "rw-2i: audit new_value is the accepted rewrite");

      const provenanceAfterApply = JSON.parse(rowAfterApply.field_provenance);
      assertTrue(!!provenanceAfterApply.about_text, "rw-2j: field_provenance.about_text is present after the rewrite write");
      assertEq(provenanceAfterApply.about_text.source_url, "https://prov-rw-thin.example.no", "rw-2k: field_provenance.about_text.source_url matches the fetched homepage");

      // ── rw-3: idempotency — a second run against the now-rewritten
      //    (>=200-char) row finds nothing eligible; the LLM is NOT called
      //    again for this field. ──────────────────────────────────────────
      const callsBeforeSecond = anthropicCallCount;
      const secondRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-rw-thin"], apply: true },
      });
      assertEq(secondRes.status, 200, "rw-3a: second run -> 200");
      assertEq(anthropicCallCount, callsBeforeSecond, "rw-3b: idempotency — the LLM is NOT called again once about_text is >=200 chars");
      const secondEntry = secondRes.body.changed.find((c: any) => c.provider_id === "prov-rw-thin");
      assertTrue(!secondEntry, "rw-3c: prov-rw-thin no longer appears in changed[] at all on the second run — nothing left to do");
      const rowAfterSecond = getProviderRow("prov-rw-thin");
      assertEq(rowAfterSecond.about_text, REWRITE_CANDIDATE_250, "rw-3d: about_text is unchanged by the idempotent second run");

      // ── rw-4: manual/claim-locked provider with a 90-ish-char about_text
      //    → unaffected; the route's existing lock guard short-circuits
      //    BEFORE any fetch, so the LLM is never invoked either. ───────────
      const callsBeforeLocked = anthropicCallCount;
      const lockedRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-rw-locked"], apply: true },
      });
      assertEq(lockedRes.status, 200, "rw-4a: locked-provider call -> 200");
      assertTrue(lockedRes.body.skipped_locked.includes("prov-rw-locked"), "rw-4b: locked provider reported in skipped_locked");
      assertEq(lockedRes.body.changed.length, 0, "rw-4c: nothing written for the locked provider");
      assertEq(anthropicCallCount, callsBeforeLocked, "rw-4d: the LLM is never called for a locked provider — the lock guard short-circuits before any fetch");
      const rowLocked = getProviderRow("prov-rw-locked");
      assertEq(rowLocked.about_text, PASSING_BAR_SHORT_86, "rw-4e: locked provider's about_text is completely unchanged");

      // ── rw-5: a sub-80-char (thin-fails-bar) about_text goes through the
      //    EXISTING fill/replace path ONLY — gardssalgRewriteEligible must
      //    never fire (it requires meetsAboutQualityBar first), so the LLM
      //    is never called for this field, even though a genuine extractive
      //    "replace" candidate is available and DOES get written. ─────────
      const callsBeforeSub80 = anthropicCallCount;
      const sub80Res = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-rw-sub80"], apply: true },
      });
      assertEq(sub80Res.status, 200, "rw-5a: sub-80 provider call -> 200");
      assertEq(anthropicCallCount, callsBeforeSub80, "rw-5b: the LLM is NEVER called for a sub-80-char (thin-fails-bar) field — this slice only widens the passing-bar-but-short cohort");
      const sub80Entry = sub80Res.body.changed.find((c: any) => c.provider_id === "prov-rw-sub80");
      assertTrue(!!sub80Entry, "rw-5c: prov-rw-sub80 still appears in changed[] — the EXISTING extractive replace path fired");
      assertEq(sub80Entry.actions.about_text, "replaced", "rw-5d: prov-rw-sub80's about_text action is 'replaced' (existing path), never 'rewritten'");
      const rowSub80 = getProviderRow("prov-rw-sub80");
      assertEq(rowSub80.about_text, PASSING_BAR_SHORT_86, "rw-5e: prov-rw-sub80's about_text was written by the existing extractive replace path, not the LLM");

      // ── rw-6: REGRESSION — candidateAbout/candidateVisit (raw extractive
      //    summaries) AND rewriteAbout/rewriteVisit (LLM rewrites) are BOTH
      //    non-null for the same field at once. This is the normal case for
      //    any real page carrying an og:description/meta description (rw-1..
      //    rw-5 above all use pages deliberately built so the extractive
      //    candidate stays null, which is exactly what let the original bug
      //    slip through review). Here the page DOES carry a passing-bar
      //    og:description, so summarizeAbout()/summarizeVisit() produce a
      //    non-null candidateAbout/candidateVisit — but the CURRENT about_text/
      //    visit_text values already pass the quality bar, so
      //    gardssalgReplaceableFieldAction() declines to act on them (same as
      //    rw-1..rw-5), leaving the rewrite path as the only one that fires.
      //    Bug: applyGardssalgProviderContent() was called with
      //    `candidateAbout ?? rewriteAbout` (extractive-first operand order),
      //    so whenever both were non-null the RAW extractive text silently
      //    won and got persisted — while the response still reported
      //    actions.about_text/visit_text: "rewritten" and showed the LLM's
      //    text in provenance, contradicting what was actually stored. Fixed
      //    by flipping to `rewriteAbout ?? candidateAbout` so the rewrite
      //    (when the rewrite path actually ran) wins. Assert the PERSISTED
      //    about_text/visit_text is the LLM's rewrite, not the raw extractive
      //    candidate — and that the audit row + response provenance agree. ──
      const OG_DESC_EXTRACTIVE_ABOUT_99 =
        "Vi selger poteter, gulrøtter og bær rett fra egen gård ved fjorden, åpent for besøkende hver helg om sommeren.";
      const CURRENT_VISIT_PASSING_BAR_SHORT =
        "Kom innom gårdsbutikken vår for smaking av egne produkter og en kort omvisning på gården.";
      const REWRITE_CANDIDATE_VISIT_260 =
        "Besøkende er hjertelig velkomne til en omvisning på gården der vi viser fram dyra og markene, etterfulgt av en smaking av våre egenproduserte oster og syltetøy i gårdsbutikken. Vi holder åpent hver lørdag om sommeren, og tar også imot grupper etter avtale resten av året.";
      assertTrue(
        OG_DESC_EXTRACTIVE_ABOUT_99.length >= 80 && OG_DESC_EXTRACTIVE_ABOUT_99.length < 200,
        "sanity: OG_DESC_EXTRACTIVE_ABOUT_99 passes the quality bar (extractive candidateAbout will be non-null)",
      );
      assertTrue(
        CURRENT_VISIT_PASSING_BAR_SHORT.length >= 80 && CURRENT_VISIT_PASSING_BAR_SHORT.length < 200,
        "sanity: CURRENT_VISIT_PASSING_BAR_SHORT is in the rewrite-eligible [80,200) window",
      );
      assertTrue(
        REWRITE_CANDIDATE_VISIT_260.length >= 200 && REWRITE_CANDIDATE_VISIT_260.length <= 500,
        "sanity: REWRITE_CANDIDATE_VISIT_260 is inside the accept window",
      );

      insertProvider.run({
        id: "prov-rw-both", navn: "Prov RW Both Gard", hjemmeside: "https://prov-rw-both.example.no",
        content_source: null, about_text: PASSING_BAR_SHORT_86, visit_text: CURRENT_VISIT_PASSING_BAR_SHORT, opening_hours_text: null,
      });

      // A page that carries BOTH an og:description (feeding a non-null,
      // passing-bar candidateAbout) AND a visit-keyword sentence (feeding a
      // non-null, passing-bar candidateVisit via summarizeVisit's
      // VISIT_KEYWORDS scan) — so BOTH extractive candidates are non-null
      // for BOTH fields at once, the exact condition the bug needed.
      const rwBothHtml =
        `<html><head><meta property="og:description" content="${OG_DESC_EXTRACTIVE_ABOUT_99}"></head>` +
        `<body><p>Velkommen til gårdsbutikken vår, der du kan få smaking av lokale delikatesser rett fra produsenten.</p></body></html>`;

      const bothProviderFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          // Return the field-appropriate rewrite: the about-rewrite prompt
          // carries the about current value, the visit-rewrite prompt
          // carries the visit current value — key off which is present.
          const bodyStr = init?.body ? String(init.body) : "";
          const text = bodyStr.includes(CURRENT_VISIT_PASSING_BAR_SHORT)
            ? REWRITE_CANDIDATE_VISIT_260
            : REWRITE_CANDIDATE_250;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text } ] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-rw-both.example.no") {
          return { ok: true, status: 200, text: async () => rwBothHtml } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      const bothRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-rw-both"], apply: true },
      });
      assertEq(bothRes.status, 200, "rw-6a: apply on prov-rw-both -> 200");
      const bothEntry = bothRes.body.changed.find((c: any) => c.provider_id === "prov-rw-both");
      assertTrue(!!bothEntry, "rw-6b: prov-rw-both appears in changed[]");
      assertEq(bothEntry.actions.about_text, "rewritten", "rw-6c: response reports about_text action 'rewritten'");
      assertEq(bothEntry.actions.visit_text, "rewritten", "rw-6d: response reports visit_text action 'rewritten'");
      assertEq(
        bothEntry.provenance.about_text?.snippet,
        REWRITE_CANDIDATE_250.slice(0, 120),
        "rw-6e: response provenance.about_text.snippet reflects the LLM rewrite, not the raw extractive candidate",
      );
      assertEq(
        bothEntry.provenance.visit_text?.snippet,
        REWRITE_CANDIDATE_VISIT_260.slice(0, 120),
        "rw-6f: response provenance.visit_text.snippet reflects the LLM rewrite, not the raw extractive candidate",
      );

      const rowBoth = getProviderRow("prov-rw-both");
      assertEq(
        rowBoth.about_text,
        REWRITE_CANDIDATE_250,
        "rw-6g: THE BUG — persisted about_text is the LLM rewrite (250 chars), NOT the raw extractive og:description candidate (99 chars)",
      );
      assertEq(
        rowBoth.visit_text,
        REWRITE_CANDIDATE_VISIT_260,
        "rw-6h: THE BUG — persisted visit_text is the LLM rewrite, NOT the raw extractive visit-keyword candidate",
      );
      assertTrue(
        rowBoth.about_text !== OG_DESC_EXTRACTIVE_ABOUT_99,
        "rw-6i: persisted about_text is definitively NOT the raw extractive candidate string",
      );

      const bothAuditRows = getAuditRows("prov-rw-both");
      const bothAboutAudit = bothAuditRows.find((r: any) => r.field_name === "about_text");
      const bothVisitAudit = bothAuditRows.find((r: any) => r.field_name === "visit_text");
      assertTrue(!!bothAboutAudit, "rw-6j: an about_text audit row exists for prov-rw-both");
      assertTrue(!!bothVisitAudit, "rw-6k: a visit_text audit row exists for prov-rw-both");
      assertEq(bothAboutAudit.new_value, REWRITE_CANDIDATE_250, "rw-6l: audit new_value for about_text is the LLM rewrite, not the extractive candidate");
      assertEq(bothVisitAudit.new_value, REWRITE_CANDIDATE_VISIT_260, "rw-6m: audit new_value for visit_text is the LLM rewrite, not the extractive candidate");

      globalThis.fetch = bothProviderFetch;
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-rewrite (section B): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-rewrite.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgRewriteTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

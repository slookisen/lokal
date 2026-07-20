/**
 * opplevelser-gardssalg-fillblank.test.ts — tests for dev-request 2026-07-20-
 * gardssalg-fyll-blank-fra-kildeinnhold: a dedicated "generate about_text
 * from source when currently blank" LLM path for gårdssalg providers whose
 * about_text is completely BLANK and whose extractive summarizer
 * (summarizeAbout) doesn't find enough to clear meetsAboutQualityBar — even
 * though the provider has a real homepage that fetches fine. Distinct from
 * slice 5a's generateGardssalgAboutRewrite (which only ever EXPANDS an
 * already non-blank, already-passing-bar value) and from slice 5c's
 * generateGardssalgProductList (products, not about_text).
 *
 *   - generateGardssalgAboutFromSource() (src/routes/opplevelser.ts): mirrors
 *     generateGardssalgAboutRewrite's never-fabricate contract — missing key
 *     / network throw / non-200 / unparseable JSON / non-array content /
 *     the literal INGEN_UTVIDELSE_MULIG sentinel / residual markdown / a
 *     response failing the shared meetsAboutQualityBar() gate all resolve to
 *     null, never throw.
 *   - POST /admin/gardssalg-content-refresh's processOne(): only fires when
 *     about_text is currently BLANK AND the extractive pass above did NOT
 *     already produce a wouldWriteActions.about_text entry, using the
 *     ALREADY-fetched contentText (no new fetch). On a non-null result,
 *     marks the action "filled" (reusing the existing fill tag — this IS a
 *     genuine fill of a blank field) and, in apply mode, flows through the
 *     EXISTING unmodified applyGardssalgProviderContent() fill path.
 *
 * Mirrors opplevelser-gardssalg-rewrite.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch for BOTH the
 * page-content crawl (crFetchGardssalgContent, keyed by hostname) AND the
 * Anthropic API call (keyed by URL containing "api.anthropic.com"), since
 * the sandbox has no live network access to either.
 */

import { generateGardssalgAboutFromSource } from "./opplevelser";

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

export function runOpplevelserGardssalgFillblankTests(
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
    // Section A — generateGardssalgAboutFromSource() direct unit tests
    // (no DB, no router — pure w.r.t. everything but fetch()/env).
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SOURCE_TEXT = "Gården vår ligger på Toten og har vært i familiens eie i fire generasjoner. Vi dyrker poteter, gulrøtter og bær, og selger alt direkte fra gårdsbutikken vår hver lørdag om sommeren.";
      const NAVN = "Toten Gårdsbutikk";
      const GOOD_CANDIDATE =
        "Familiedrevet gård på Toten som i fire generasjoner har dyrket poteter, gulrøtter og bær, og som selger alt direkte fra gårdsbutikken hver lørdag om sommeren.";
      assertTrue(GOOD_CANDIDATE.length >= 80, "sanity: GOOD_CANDIDATE clears the 80-char quality-bar floor");

      // ── fb-1: missing ANTHROPIC_API_KEY → null, fetch never invoked ─────
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("fb-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-1: missing ANTHROPIC_API_KEY → null");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── fb-2: mocked 200 response with a good candidate → returned, and
      //    the request carries the model/prompt contract (navn + source +
      //    sentinel instruction). ────────────────────────────────────────
      let capturedInit: any = null;
      let capturedUrl: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: GOOD_CANDIDATE }] }),
        };
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, GOOD_CANDIDATE, "fb-2a: mocked 200 with a good candidate → returned verbatim");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "fb-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-opus-4-8", "fb-2c: model is claude-opus-4-8");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(NAVN), "fb-2d: prompt includes navn");
        assertTrue(body.messages[0].content.includes(SOURCE_TEXT), "fb-2e: prompt includes the source text");
        assertTrue(body.messages[0].content.includes("INGEN_UTVIDELSE_MULIG"), "fb-2f: prompt includes the escape sentinel instruction");
        assertTrue(body.messages[0].content.includes("Bruk KUN fakta som faktisk står i kildeteksten"), "fb-2g: prompt includes the exact grounding instruction");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "fb-2h: x-api-key header carries ANTHROPIC_API_KEY");
      }

      // ── fb-3: source text capped to ~6000 chars in the prompt. ──────────
      {
        const hugeSource = "x".repeat(20000);
        await generateGardssalgAboutFromSource(hugeSource, NAVN);
        const body = JSON.parse(capturedInit.body);
        const xRunLength = (body.messages[0].content.match(/x+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
        assertTrue(xRunLength <= 6000, "fb-3: source text is capped to ~6000 chars in the prompt, not passed through unbounded");
      }

      // ── fb-4: sentinel handling — verbatim, whitespace-padded, and
      //    embedded-in-longer-prose all → null. ────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-4a: the literal INGEN_UTVIDELSE_MULIG sentinel → null");
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "  INGEN_UTVIDELSE_MULIG  \n" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-4b: sentinel with surrounding whitespace (trimmed) → still null");
      }
      const PAD_120 = "Gården tilbyr omvisning og smaksprøver gjennom hele sesongen, og tar imot både små og store grupper etter avtale. ";
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: `${PAD_120} INGEN_UTVIDELSE_MULIG` }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-4c: sentinel embedded in longer prose → null, never published with the sentinel in it");
      }

      // ── fb-5: network throw → null, never throws itself. ─────────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-5: fetch throw (network failure) → null, not re-thrown");
      }

      // ── fb-6: non-200 response → null. ────────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-6: non-200 response → null");
      }

      // ── fb-7: unparseable JSON body (.json() throws) → null. ──────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-7: unparseable JSON response body → null");
      }

      // ── fb-8: non-array content field → null, never throws. ───────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-8: non-array content field → null, not a thrown TypeError");
      }

      // ── fb-9: markdown artifacts are stripped and the candidate is
      //    accepted when the stripped prose still clears the quality bar. ───
      const MD_WRAPPED = `**${GOOD_CANDIDATE}**`;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: MD_WRAPPED }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertTrue(r !== null, "fb-9a: markdown-formatted candidate is accepted after stripping");
        assertTrue(!!r && !/[*#`]/.test(r), "fb-9b: no asterisks/hashes/backticks survive into the returned value");
        assertEq(r, GOOD_CANDIDATE, "fb-9c: stripped result matches the underlying prose exactly");
      }

      // ── fb-10a: residual markdown after stripping (unpaired "**") →
      //    rejected outright, regardless of the underlying prose length. ────
      const mockText = (t: string) =>
        (globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: t }] }),
        })) as unknown as typeof fetch);
      mockText(`og **smaksprøver hele året ${GOOD_CANDIDATE}`);
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-10a: unpaired ** survives stripping → residual check rejects (fail-closed)");
      }

      // ── fb-10b: a candidate that, after stripping markdown, is too
      //    short/junky to clear meetsAboutQualityBar → null (this is the
      //    "sentinel-or-null, else prose that passes the shared quality bar,
      //    else null" contract — no separate arbitrary length range). ──────
      mockText("**Kort tekst**");
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-10b: stripped prose too short to clear meetsAboutQualityBar → null");
      }
      // Plain (non-markdown) too-short candidate → same rejection via the
      // quality-bar gate rather than the residual-markdown gate.
      mockText("Liten gård.");
      {
        const r = await generateGardssalgAboutFromSource(SOURCE_TEXT, NAVN);
        assertEq(r, null, "fb-10c: plain too-short candidate → null (quality-bar gate, not residual-markdown gate)");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-fillblank (section A): unexpected error: " + String(err?.stack || err?.message || err));
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
    const testKey = "gardssalg-fillblank-test-key";
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
      // slice 5c fill-only products-extraction path never fires for these
      // rows — this file isolates the blank-about_text fill path only; a
      // blank `products` column would make processOne() ALSO call the
      // (shared, mocked) Anthropic endpoint for a products candidate every
      // run, throwing off this file's anthropicCallCount assertions.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, '["Placeholder"]',
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      const GENERATED_ABOUT =
        "Familiedrevet gård ved fjorden som har drevet gårdssalg i tre generasjoner, med egne epler, bær og syltetøy solgt rett fra gårdsbutikken hver helg om sommeren.";
      const OG_DESC_EXTRACTIVE_ABOUT =
        "Vi selger poteter, gulrøtter og bær rett fra egen gård ved fjorden, åpent for besøkende hver helg om sommeren.";
      const SUB_80_THIN = "Liten gård med noen dyr og epletrær.";
      assertTrue(GENERATED_ABOUT.length >= 80, "sanity: GENERATED_ABOUT clears the quality-bar floor");
      assertTrue(OG_DESC_EXTRACTIVE_ABOUT.length >= 80, "sanity: OG_DESC_EXTRACTIVE_ABOUT clears the quality-bar floor (extractive candidate will be non-null)");
      assertTrue(SUB_80_THIN.length < 80, "sanity: SUB_80_THIN is under the 80-char quality bar");

      insertProvider.run({
        id: "prov-fb-blank", navn: "Prov FB Blank Gard", hjemmeside: "https://prov-fb-blank.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-fb-locked", navn: "Prov FB Locked Gard", hjemmeside: "https://prov-fb-locked.example.no",
        content_source: "manual", about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-fb-extractive", navn: "Prov FB Extractive Gard", hjemmeside: "https://prov-fb-extractive.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-fb-sub80", navn: "Prov FB Sub80 Gard", hjemmeside: "https://prov-fb-sub80.example.no",
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

      let anthropicCallCount = 0;
      // A page with NO og:description/meta description, no VISIT_KEYWORDS
      // match, and no opening-hours pattern — the pre-existing extractive
      // path contributes NOTHING, isolating the new blank-fill path as the
      // only possible source of an about_text action.
      const noExtractiveHtml = "<html><body><p>Velkommen til gården vår, ring for mer info.</p></body></html>";
      // A page WITH a passing-bar og:description — lets the EXISTING
      // extractive fill path claim about_text before the new branch's
      // `!wouldWriteActions.about_text` guard would ever see it.
      const extractiveHtml = `<html><head><meta property="og:description" content="${OG_DESC_EXTRACTIVE_ABOUT}"></head><body><p>Velkommen innom oss.</p></body></html>`;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: GENERATED_ABOUT }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-fb-blank.example.no") {
          return { ok: true, status: 200, text: async () => noExtractiveHtml } as unknown as Response;
        }
        if (host === "prov-fb-extractive.example.no") {
          return { ok: true, status: 200, text: async () => extractiveHtml } as unknown as Response;
        }
        if (host === "prov-fb-sub80.example.no") {
          return { ok: true, status: 200, text: async () => noExtractiveHtml } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ── fb-b1: dry-run on prov-fb-blank (blank about_text, no usable
      //    extractive content) → LLM WAS called (real preview), action
      //    "filled", provenance present, nothing written to the DB. ────────
      const callsBeforeDry = anthropicCallCount;
      const dryRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fb-blank"], apply: false },
      });
      assertEq(dryRes.status, 200, "fb-b1a: dry-run -> 200");
      assertEq(dryRes.body.dry_run, true, "fb-b1b: dry_run:true");
      assertTrue(anthropicCallCount > callsBeforeDry, "fb-b1c: dry-run DID call the LLM (real preview, not guessed)");
      const dryEntry = dryRes.body.changed.find((c: any) => c.provider_id === "prov-fb-blank");
      assertTrue(!!dryEntry, "fb-b1d: prov-fb-blank appears in dry-run changed[]");
      assertEq(dryEntry.actions.about_text, "filled", "fb-b1e: dry-run projects about_text as 'filled'");
      assertTrue(dryEntry.fields.includes("about_text"), "fb-b1f: fields[] lists about_text too");
      assertTrue(!!dryEntry.provenance.about_text, "fb-b1g: dry-run response carries provenance for the filled field");
      assertEq(dryEntry.provenance.about_text.source_url, "https://prov-fb-blank.example.no", "fb-b1h: provenance source_url is the fetched homepage");
      const beforeDryWrite = getProviderRow("prov-fb-blank");
      assertEq(beforeDryWrite.about_text, null, "fb-b1i: dry-run performed ZERO writes — about_text still blank in the DB");
      assertEq(getAuditRows("prov-fb-blank").length, 0, "fb-b1j: dry-run created no audit row");

      // ── fb-b2: apply mode on prov-fb-blank → actually writes through
      //    applyGardssalgProviderContent, with a matching audit row (old_value
      //    NULL — there IS no prior value, unlike the rewrite test's prior
      //    short text) + field_provenance entry. ───────────────────────────
      const applyRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fb-blank"], apply: true },
      });
      assertEq(applyRes.status, 200, "fb-b2a: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "fb-b2b: dry_run:false");
      const applyEntry = applyRes.body.changed.find((c: any) => c.provider_id === "prov-fb-blank");
      assertTrue(!!applyEntry, "fb-b2c: prov-fb-blank appears in apply changed[]");
      assertEq(applyEntry.actions.about_text, "filled", "fb-b2d: apply response tags about_text 'filled'");

      const rowAfterApply = getProviderRow("prov-fb-blank");
      assertEq(rowAfterApply.about_text, GENERATED_ABOUT, "fb-b2e: about_text actually written to the LLM-generated candidate");
      assertEq(rowAfterApply.content_source, "provider_site", "fb-b2f: content_source stamped provider_site");

      const auditRows = getAuditRows("prov-fb-blank");
      const aboutAudit = auditRows.find((r: any) => r.field_name === "about_text");
      assertTrue(!!aboutAudit, "fb-b2g: an about_text audit row exists for the fill");
      assertEq(aboutAudit.old_value, null, "fb-b2h: audit old_value is NULL — there is no prior value (key difference from the rewrite test)");
      assertEq(aboutAudit.new_value, GENERATED_ABOUT, "fb-b2i: audit new_value is the generated text");

      const provenanceAfterApply = JSON.parse(rowAfterApply.field_provenance);
      assertTrue(!!provenanceAfterApply.about_text, "fb-b2j: field_provenance.about_text is present after the write");
      assertEq(provenanceAfterApply.about_text.source_url, "https://prov-fb-blank.example.no", "fb-b2k: field_provenance.about_text.source_url matches the fetched homepage");

      // ── fb-b3: REGRESSION — a provider whose blank about_text gets filled
      //    by the pre-existing EXTRACTIVE path (a page with a passing-bar
      //    og:description) must NOT also call the new LLM path — the new
      //    branch's `!wouldWriteActions.about_text` guard must skip it. ─────
      const callsBeforeExtractive = anthropicCallCount;
      const extractiveRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fb-extractive"], apply: true },
      });
      assertEq(extractiveRes.status, 200, "fb-b3a: extractive-fill provider call -> 200");
      assertEq(anthropicCallCount, callsBeforeExtractive, "fb-b3b: the LLM is NOT called when the extractive pass already filled about_text");
      const extractiveEntry = extractiveRes.body.changed.find((c: any) => c.provider_id === "prov-fb-extractive");
      assertTrue(!!extractiveEntry, "fb-b3c: prov-fb-extractive still appears in changed[] — the EXISTING extractive fill path fired");
      assertEq(extractiveEntry.actions.about_text, "filled", "fb-b3d: action is 'filled' via the extractive path (same tag, different source)");
      const rowExtractive = getProviderRow("prov-fb-extractive");
      assertEq(rowExtractive.about_text, OG_DESC_EXTRACTIVE_ABOUT, "fb-b3e: about_text was written by the existing extractive fill path, not the LLM-generated candidate");

      // ── fb-b4: a locked (content_source manual) provider with blank
      //    about_text → never calls the LLM at all; the existing lock guard
      //    short-circuits before any fetch. ─────────────────────────────────
      const callsBeforeLocked = anthropicCallCount;
      const lockedRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fb-locked"], apply: true },
      });
      assertEq(lockedRes.status, 200, "fb-b4a: locked-provider call -> 200");
      assertTrue(lockedRes.body.skipped_locked.includes("prov-fb-locked"), "fb-b4b: locked provider reported in skipped_locked");
      assertEq(lockedRes.body.changed.length, 0, "fb-b4c: nothing written for the locked provider");
      assertEq(anthropicCallCount, callsBeforeLocked, "fb-b4d: the LLM is never called for a locked provider — the lock guard short-circuits before any fetch");
      const rowLocked = getProviderRow("prov-fb-locked");
      assertEq(rowLocked.about_text, null, "fb-b4e: locked provider's about_text is completely unchanged (still blank)");

      // ── fb-b5: a NON-blank about_text provider (sub-80 chars, so neither
      //    the existing extractive fill/replace path — no extractive
      //    candidate available at all — NOR gardssalgRewriteEligible, which
      //    requires the current value to already pass the quality bar —
      //    ever fires) → the new blank-fill branch must also never fire,
      //    since it specifically requires BLANK, not just short. Assert the
      //    LLM call count does not increase for this provider. ─────────────
      const callsBeforeSub80 = anthropicCallCount;
      const sub80Res = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fb-sub80"], apply: true },
      });
      assertEq(sub80Res.status, 200, "fb-b5a: sub-80 (non-blank) provider call -> 200");
      assertEq(anthropicCallCount, callsBeforeSub80, "fb-b5b: the LLM is NOT called for a non-blank about_text, even when it's short/thin and no other path fires either");
      const sub80Entry = sub80Res.body.changed.find((c: any) => c.provider_id === "prov-fb-sub80");
      assertTrue(!sub80Entry, "fb-b5c: prov-fb-sub80 does not appear in changed[] at all — nothing fired for about_text");
      const rowSub80 = getProviderRow("prov-fb-sub80");
      assertEq(rowSub80.about_text, SUB_80_THIN, "fb-b5d: prov-fb-sub80's about_text is completely unchanged");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-fillblank (section B): unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-fillblank.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgFillblankTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

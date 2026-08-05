/**
 * opplevelser-experience-description-enrichment.test.ts — tests for
 * dev-request 2026-07-12-opplevagent-serp-innholdsberikelse, item 1
 * ("Innholdsberikelse"): the source-grounded, judge-gated writer for
 * `experiences.description` behind
 * POST /api/opplevelser/admin/experiences-description-enrichment.
 *
 * Sections:
 *   A — pure helpers (fact assembly / thin-data measure / word count /
 *       ungrounded-number scan / candidate predicate). No DB, no network.
 *   B — generateExperienceDescriptionNo(): the never-fabricate, never-throw
 *       contract (thin row -> zero LLM calls, missing key, sentinel, word
 *       floor/ceiling, ungrounded numbers, non-200, unparseable body,
 *       non-array content shape, network throw).
 *   C — judgeExperienceDescriptionCandidate(): the exact-token GODKJENN /
 *       AVVIS contract, fail-closed on every deviation.
 *   D — the route: candidate-set composition, dry_run strict-false idiom
 *       (asserted with a before/after row dump, not just the response
 *       shape), apply-mode writes + provenance stamp, judge rejection,
 *       every fail-closed path, the parameterised `ids` filter and the
 *       batch cap.
 *
 * Setup convention mirrors opplevelser-gardssalg-products.test.ts /
 * opplevelser-gardssalg-rewrite.test.ts: EXPERIENCES_DB_PATH=":memory:", a
 * fresh require of db-factory + experience-store + the opplevelser router
 * per run, and the router exercised directly via router.handle(). The
 * Anthropic call is NEVER real — sections A-C stub globalThis.fetch, and
 * section D uses the route's OWN per-app-instance injection seam
 * ("experienceDescriptionFetchImpl", the twin of the title-no backfill's
 * "titleNoBackfillFetchImpl"), reached through the fake `req.app` the
 * callRoute() helper below supplies.
 */

import {
  buildExperienceDescriptionFacts,
  renderExperienceDescriptionFactsBlock,
  expDescWordCount,
  expDescHasUngroundedNumbers,
  experienceDescriptionNeedsEnrichment,
  generateExperienceDescriptionNo,
  judgeExperienceDescriptionCandidate,
  EXP_DESC_GENERATED_PROVENANCE_SENTINEL,
  type ExperienceDescriptionCandidate,
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

/** Minimal req/res harness. `app` is a stand-in for the Express Application
 *  the route reads its fetch-injection seam off (req.app.get(...)) — the
 *  router alone never populates it. */
function callRoute(
  router: any,
  appSettings: Record<string, unknown>,
  opts: {
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/experiences-description-enrichment";
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body,
      app: { get: (k: string) => appSettings[k] },
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

// ── Fixtures ──────────────────────────────────────────────────────────────
// A ≥400-word Norwegian prose fixture that contains NO digits at all, so it
// can never trip expDescHasUngroundedNumbers() no matter which fact row it
// is paired with. It is deliberately built by repeating one realistic
// paragraph: the deterministic gates only measure word count / digits, and
// the "is this padding?" judgement is the LLM judge's job — which is mocked
// here. Length is asserted below (fx-0) so a future edit can't silently
// drop it under the 400-word floor.
const FIXTURE_PARAGRAPH = [
  "Denne opplevelsen tar deg med ut i naturen sammen med en lokal tilbyder som kjenner området godt.",
  "Turen egner seg for deg som ønsker en aktiv dag ute, og opplegget legges opp slik at både nybegynnere og mer erfarne deltakere finner sin plass.",
  "Underveis får du tid til å senke skuldrene, kjenne på roen og oppleve landskapet i et tempo som gir rom for både samtale og stillhet.",
  "Fordi aktiviteten foregår utendørs, lønner det seg å kle seg etter været og ta med klær som tåler både vind og fukt.",
  "Gode sko og et ekstra plagg i sekken er alltid en fornuftig investering når man skal være ute over tid.",
  "Tilbyderen legger vekt på at gruppen skal holdes samlet, slik at alle får med seg det som skjer og ingen føler at de blir hengende etter.",
  "Det gjør opplevelsen egnet både for venner som reiser sammen og for familier som ønsker å gjøre noe felles.",
  "Møtet med naturen står sentralt, og mange opplever at nettopp det å være til stede i omgivelsene er det som sitter igjen i etterkant.",
  "Praktisk informasjon og bestilling håndteres direkte hos tilbyderen, som svarer på spørsmål om oppmøte og gjennomføring.",
  "Har du særskilte behov, anbefaler vi at du tar kontakt i forkant slik at tilbyderen kan legge til rette der det er mulig.",
].join(" ");

function buildFixtureDescription(): string {
  const parts: string[] = [];
  while (expDescWordCount(parts.join(" ")) < 420) parts.push(FIXTURE_PARAGRAPH);
  return parts.join(" ");
}
const FIXTURE_DESCRIPTION = buildFixtureDescription();

/** A short, perfectly ordinary Norwegian description — non-blank and NOT
 *  junk by isJunkDescription(), i.e. content this endpoint must never
 *  touch. */
const GOOD_EXISTING_DESCRIPTION =
  "Bli med på en rolig padletur i skjermede farvann sammen med lokale guider. Turen passer for både nybegynnere og erfarne, og vi holder til rett ved sjøen.";

/** The Homme Gård shape isJunkDescription()'s rule 1 fires on (skip-link +
 *  nav tokens + a dumped contact block) — a candidate for replacement. */
const JUNK_EXISTING_DESCRIPTION =
  "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no Facebook-f Instagram Forside Gårdsutsalg Produksjon Meny";

/** A 13-of-13 fact row (the "rich" shape). */
function richCandidate(over: Partial<ExperienceDescriptionCandidate> = {}): ExperienceDescriptionCandidate {
  return {
    id: "exp-rich", title: "Kajakktur i fjorden", description: null,
    category: "natur_friluft", subcategory: "kajakk",
    season: JSON.stringify(["summer"]), indoor_outdoor: "outdoor",
    duration_min: 120, duration_max: 180, group_min: 2, group_max: 8,
    price_band: "standard", price_from: 890, price_unit: "per_person",
    languages: JSON.stringify(["norsk", "engelsk"]),
    accessibility: JSON.stringify(["rullestolvennlig"]),
    meeting_point: "Bryggen", kommune: "Bergen", fylke: "Vestland",
    booking_url: "https://example.no/book",
    content_source: null, content_field_evidence: null,
    provider_navn: "Fjordtur AS", provider_brreg_verified: 1,
    ...over,
  };
}

export function runOpplevelserExperienceDescriptionEnrichmentTests(
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
    // Section A — pure helpers
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── fx-0: the fixture itself clears the deterministic bar. ─────────
      {
        const wc = expDescWordCount(FIXTURE_DESCRIPTION);
        assertTrue(wc >= 400 && wc <= 1200, `fx-0a: fixture description is 400-1200 words (was ${wc})`);
        assertTrue(!/\d/.test(FIXTURE_DESCRIPTION), "fx-0b: fixture description contains no digits at all");
      }

      // ── ed-1: the rich row exposes all 13 distinct fact kinds. ─────────
      {
        const facts = buildExperienceDescriptionFacts(richCandidate());
        assertEq(facts.length, 13, "ed-1a: rich row -> 13 distinct fact-fields");
        const labels = facts.map(([k]) => k);
        assertEq(labels, [
          "Kategori", "Underkategori", "Sted", "Sesong", "Inne eller ute",
          "Varighet", "Gruppestørrelse", "Pris", "Språk", "Tilgjengelighet",
          "Oppmøtested", "Bestilling", "Tilbyder",
        ], "ed-1b: fact labels + order mirror the detail page's facts table");
        const block = renderExperienceDescriptionFactsBlock(richCandidate(), facts);
        assertTrue(block.startsWith("Tittel: Kajakktur i fjorden"), "ed-1c: facts block leads with the title");
        assertTrue(block.includes("Pris: fra 890 kroner per person"), "ed-1d: price fact carries price_from + unit");
        assertTrue(block.includes("Tilbyder: Fjordtur AS (verifisert mot Brønnøysundregistrene)"), "ed-1e: provider fact carries the Brreg flag");
        assertTrue(!block.includes("https://example.no/book"), "ed-1f: the booking URL itself is never handed to the model");
      }

      // ── ed-2: kommune+fylke collapse into ONE fact; duration_min+max into
      //    one; a price_band of 'ukjent' is not a fact at all. ────────────
      {
        const facts = buildExperienceDescriptionFacts(richCandidate({ price_band: "ukjent", price_from: null }));
        assertEq(facts.filter(([k]) => k === "Pris").length, 0, "ed-2a: price_band 'ukjent' contributes no Pris fact");
        assertEq(facts.length, 12, "ed-2b: rich row minus price -> 12 fact-fields");
        const onlyPlace = buildExperienceDescriptionFacts({
          ...richCandidate(), category: null, subcategory: null, season: null,
          indoor_outdoor: null, duration_min: null, duration_max: null,
          group_min: null, group_max: null, price_band: null, price_from: null,
          languages: null, accessibility: null, meeting_point: null,
          booking_url: null, provider_navn: null,
        });
        assertEq(onlyPlace.map(([k]) => k), ["Sted"], "ed-2c: kommune + fylke together are ONE 'Sted' fact");
      }

      // ── ed-3: a genuinely thin row falls under the threshold. ──────────
      {
        const thin = buildExperienceDescriptionFacts({
          ...richCandidate(), subcategory: null, season: null, indoor_outdoor: null,
          duration_min: null, duration_max: null, group_min: null, group_max: null,
          price_band: null, price_from: null, languages: null, accessibility: null,
          meeting_point: null, booking_url: null, provider_navn: null,
        });
        assertEq(thin.length, 2, "ed-3: title+category+kommune/fylke only -> 2 fact-fields (below the 6 threshold)");
      }

      // ── ed-4: malformed JSON array columns are treated as absent, never
      //    guessed out of the raw string. ──────────────────────────────────
      {
        const facts = buildExperienceDescriptionFacts(richCandidate({ season: "sommer, vinter", languages: "{}" }));
        assertEq(facts.filter(([k]) => k === "Sesong" || k === "Språk").length, 0,
          "ed-4: non-JSON / non-array season+languages columns contribute no facts");
      }

      // ── ed-5: word count. ─────────────────────────────────────────────
      assertEq(expDescWordCount(""), 0, "ed-5a: empty -> 0 words");
      assertEq(expDescWordCount(null), 0, "ed-5b: null -> 0 words");
      assertEq(expDescWordCount("  en  to \n tre "), 3, "ed-5c: whitespace-collapsed word count");

      // ── ed-6: ungrounded-number scan. ─────────────────────────────────
      {
        const facts = buildExperienceDescriptionFacts(richCandidate());
        const block = renderExperienceDescriptionFactsBlock(richCandidate(), facts);
        assertEq(expDescHasUngroundedNumbers("Turen varer 120 minutter og koster fra 890 kroner.", block), false,
          "ed-6a: numbers that all appear in the facts block -> not ungrounded");
        assertEq(expDescHasUngroundedNumbers("Gården ble grunnlagt i 1847.", block), true,
          "ed-6b: an invented year -> ungrounded");
        assertEq(expDescHasUngroundedNumbers("Turen koster fra 1 200 kroner.",
          "Tittel: X\nPris: fra 1200 kroner"), false,
          "ed-6c: thousands separator normalised before comparison (no false positive)");
        assertEq(expDescHasUngroundedNumbers("Ingen tall her i det hele tatt.", block), false,
          "ed-6d: prose with no digits -> not ungrounded");
        assertEq(expDescHasUngroundedNumbers("Det er 3 kilometer å gå.", block), true,
          "ed-6e: an invented distance -> ungrounded");
      }

      // ── ed-7: candidate predicate — blank/junk in, good out. ───────────
      assertEq(experienceDescriptionNeedsEnrichment(null), true, "ed-7a: NULL description -> candidate");
      assertEq(experienceDescriptionNeedsEnrichment("   "), true, "ed-7b: blank description -> candidate");
      assertEq(experienceDescriptionNeedsEnrichment(JUNK_EXISTING_DESCRIPTION), true, "ed-7c: junk description -> candidate");
      assertEq(experienceDescriptionNeedsEnrichment(GOOD_EXISTING_DESCRIPTION), false, "ed-7d: a GOOD description is never a candidate");
      assertEq(experienceDescriptionNeedsEnrichment(FIXTURE_DESCRIPTION), false, "ed-7e: a previously generated description is never re-touched");
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — generateExperienceDescriptionNo()
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── gen-1: THIN row -> null, and the LLM is never called. ──────────
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      {
        let calls = 0;
        const stub = (async () => { calls++; throw new Error("gen-1: fetch must NOT be called for a thin row"); }) as unknown as typeof fetch;
        const thinRow = richCandidate({
          subcategory: null, season: null, indoor_outdoor: null,
          duration_min: null, duration_max: null, group_min: null, group_max: null,
          price_band: null, price_from: null, languages: null, accessibility: null,
          meeting_point: null, booking_url: null, provider_navn: null,
        });
        const r = await generateExperienceDescriptionNo(thinRow, stub);
        assertEq(r, null, "gen-1a: thin row -> null");
        assertEq(calls, 0, "gen-1b: thin row makes ZERO LLM calls");
      }

      // ── gen-2: missing ANTHROPIC_API_KEY -> null, fetch never called. ──
      delete process.env.ANTHROPIC_API_KEY;
      {
        let calls = 0;
        const stub = (async () => { calls++; throw new Error("gen-2: fetch must NOT be called without a key"); }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionNo(richCandidate(), stub);
        assertEq(r, null, "gen-2a: missing ANTHROPIC_API_KEY -> null");
        assertEq(calls, 0, "gen-2b: missing key makes ZERO LLM calls");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── gen-3: happy path + the exact Anthropic request contract. ──────
      {
        let capturedUrl: any = null;
        let capturedInit: any = null;
        const stub = (async (url: any, init: any) => {
          capturedUrl = url; capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FIXTURE_DESCRIPTION }] }) };
        }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionNo(richCandidate(), stub);
        assertEq(r, FIXTURE_DESCRIPTION, "gen-3a: valid ≥400-word response is returned verbatim");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "gen-3b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "gen-3c: model is claude-haiku-4-5");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "gen-3d: x-api-key header carries ANTHROPIC_API_KEY");
        assertEq(capturedInit.headers["anthropic-version"], "2023-06-01", "gen-3e: anthropic-version header is set");
        const prompt = body.messages[0].content as string;
        assertTrue(prompt.includes("Pris: fra 890 kroner per person"), "gen-3f: prompt carries the row's own structured facts");
        assertTrue(prompt.includes("Bruk KUN faktaopplysningene"), "gen-3g: prompt carries the kun-kildebasert instruction");
        assertTrue(prompt.includes("UTILSTREKKELIG_GRUNNLAG"), "gen-3h: prompt carries the too-thin escape sentinel");
        assertTrue(prompt.includes("minst 400 ord"), "gen-3i: prompt carries the ≥400-word floor");
      }

      // ── gen-4: the escape sentinel -> null (never padded into prose). ──
      for (const [label, text] of [
        ["gen-4a", "UTILSTREKKELIG_GRUNNLAG"],
        ["gen-4b", "  UTILSTREKKELIG_GRUNNLAG \n"],
        ["gen-4c", "UTILSTREKKELIG_GRUNNLAG — jeg mangler fakta til å skrive dette."],
      ] as Array<[string, string]>) {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), null, `${label}: sentinel response -> null`);
      }

      // ── gen-5: below the word floor -> null. ───────────────────────────
      {
        const short = "Dette er en altfor kort beskrivelse som aldri skal skrives til databasen.";
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: short }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), null, "gen-5: <400 words -> null");
      }

      // ── gen-6: above the word ceiling -> null (runaway repetition). ────
      {
        const huge = Array.from({ length: 1300 }, () => "ord").join(" ");
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: huge }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), null, "gen-6: >1200 words -> null");
      }

      // ── gen-7: a fabricated number that is not in the facts -> null. ───
      {
        const fabricated = FIXTURE_DESCRIPTION + " Gården ble grunnlagt i 1847 og ligger 12 kilometer fra sentrum.";
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: fabricated }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), null,
          "gen-7a: prose containing an ungrounded year/distance -> null (never written)");
        const grounded = FIXTURE_DESCRIPTION + " Turen varer mellom 120 og 180 minutter for 2 til 8 personer.";
        const stub2 = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: grounded }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub2), grounded,
          "gen-7b: prose whose numbers all come from the facts is accepted");
      }

      // ── gen-8..11: every API deviation resolves to null, never a throw. ─
      {
        const cases: Array<[string, any]> = [
          ["gen-8: non-200 response", async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })],
          ["gen-9: unparseable JSON body", async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })],
          ["gen-10: non-array content shape", async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) })],
          ["gen-11: network throw", async () => { throw new Error("simulated network failure"); }],
          ["gen-12: empty text", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "   " }] }) })],
          ["gen-13: no text block", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use" }] }) })],
        ];
        for (const [label, impl] of cases) {
          let threw = false;
          let r: string | null = "sentinel";
          try {
            r = await generateExperienceDescriptionNo(richCandidate(), impl as unknown as typeof fetch);
          } catch { threw = true; }
          assertEq(r, null, `${label} -> null`);
          assertTrue(!threw, `${label} -> never throws`);
        }
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section B): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section C — judgeExperienceDescriptionCandidate()
    // ═══════════════════════════════════════════════════════════════════
    try {
      const FACTS_BLOCK = renderExperienceDescriptionFactsBlock(
        richCandidate(), buildExperienceDescriptionFacts(richCandidate())
      );

      // ── jd-1: missing key -> rejected, fetch never called. ─────────────
      delete process.env.ANTHROPIC_API_KEY;
      {
        let calls = 0;
        const stub = (async () => { calls++; throw new Error("jd-1: fetch must NOT be called without a key"); }) as unknown as typeof fetch;
        const v = await judgeExperienceDescriptionCandidate(FIXTURE_DESCRIPTION, FACTS_BLOCK, stub);
        assertEq(v.approved, false, "jd-1a: missing ANTHROPIC_API_KEY -> rejected fail-closed");
        assertEq(calls, 0, "jd-1b: missing key makes ZERO judge calls");
        assertTrue(typeof v.reasoning === "string" && v.reasoning.length > 0, "jd-1c: reasoning string present");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── jd-2: GODKJENN -> approved, and the judge sees BOTH the prose and
      //    the exact facts block it was grounded in. ──────────────────────
      {
        let capturedInit: any = null;
        const stub = (async (_u: any, init: any) => {
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nAlle opplysninger stemmer med faktalisten." }] }) };
        }) as unknown as typeof fetch;
        const v = await judgeExperienceDescriptionCandidate(FIXTURE_DESCRIPTION, FACTS_BLOCK, stub);
        assertEq(v.approved, true, "jd-2a: exact GODKJENN token -> approved");
        assertEq(v.reasoning, "Alle opplysninger stemmer med faktalisten.", "jd-2b: reasoning line parsed");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "jd-2c: judge model is claude-haiku-4-5");
        const prompt = body.messages[0].content as string;
        assertTrue(prompt.includes(FACTS_BLOCK), "jd-2d: judge prompt carries the exact grounding facts block");
        assertTrue(prompt.includes(FIXTURE_DESCRIPTION.slice(0, 120)), "jd-2e: judge prompt carries the candidate text");
        assertTrue(prompt.includes("Ved minste tvil, svar AVVIS"), "jd-2f: judge prompt carries the any-doubt-reject instruction");
      }

      // ── jd-3: AVVIS -> rejected. ──────────────────────────────────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nTeksten oppgir en pris som ikke står i faktalisten." }] }) })) as unknown as typeof fetch;
        const v = await judgeExperienceDescriptionCandidate(FIXTURE_DESCRIPTION, FACTS_BLOCK, stub);
        assertEq(v.approved, false, "jd-3a: exact AVVIS token -> rejected");
        assertEq(v.reasoning, "Teksten oppgir en pris som ikke står i faktalisten.", "jd-3b: reasoning line parsed");
      }

      // ── jd-4: anything that is not the EXACT approve token rejects. ────
      {
        const ambiguous = [
          "Jeg vil GODKJENN denne teksten fordi den ser fin ut.",
          "godkjent",
          "",
          "MAYBE",
        ];
        for (const text of ambiguous) {
          const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) })) as unknown as typeof fetch;
          const v = await judgeExperienceDescriptionCandidate(FIXTURE_DESCRIPTION, FACTS_BLOCK, stub);
          assertEq(v.approved, false, `jd-4: ambiguous verdict ${JSON.stringify(text)} -> rejected fail-closed`);
        }
      }

      // ── jd-5..9: every API deviation rejects, never throws. ────────────
      {
        const cases: Array<[string, any]> = [
          ["jd-5: non-200", async () => ({ ok: false, status: 503, json: async () => ({}) })],
          ["jd-6: unparseable body", async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })],
          ["jd-7: non-array content", async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) })],
          ["jd-8: network throw", async () => { throw new Error("simulated network failure"); }],
          ["jd-9: no text block", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use" }] }) })],
        ];
        for (const [label, impl] of cases) {
          let threw = false;
          let approved: unknown = "sentinel";
          try {
            approved = (await judgeExperienceDescriptionCandidate(FIXTURE_DESCRIPTION, FACTS_BLOCK, impl as unknown as typeof fetch)).approved;
          } catch { threw = true; }
          assertEq(approved, false, `${label} -> rejected fail-closed`);
          assertTrue(!threw, `${label} -> never throws`);
        }
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section C): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section D — POST /admin/experiences-description-enrichment
    // ═══════════════════════════════════════════════════════════════════
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const ADMIN_KEY_ED = process.env.ADMIN_KEY || "experience-description-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN_KEY_ED;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-route";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // Per-test app settings object — the route's fetch-injection seam.
      const appSettings: Record<string, unknown> = {};
      function setStub(stub: typeof fetch | undefined): void {
        appSettings["experienceDescriptionFetchImpl"] = stub;
      }

      // `key: null` means "send NO X-Admin-Key header at all". It cannot be
      // `undefined` — that would silently fall back to the default parameter
      // and quietly test the authorised path instead of the unauthorised one.
      function post(body: any, key: string | null = ADMIN_KEY_ED): Promise<RouteResult> {
        // ADMIN_KEY is re-pinned per request for the same reason the suite's
        // other admin-route blocks do it: sibling test files mutate it.
        process.env.ADMIN_KEY = ADMIN_KEY_ED;
        const headers: Record<string, string> = {};
        if (key !== null) headers["x-admin-key"] = key;
        return callRoute(router, appSettings, { headers, body });
      }

      const rowOf = (id: string): any =>
        expDb.prepare("SELECT id, description, content_field_evidence, updated_at FROM experiences WHERE id = ?").get(id);
      const descOf = (id: string): string | null => (rowOf(id)?.description ?? null);
      const dumpAll = (): string =>
        JSON.stringify(expDb.prepare("SELECT id, description, content_field_evidence, updated_at FROM experiences ORDER BY id").all());

      // ── Stub factory: routes on the prompt so ONE stub serves both the
      //    generate and the judge leg, and counts each. ──────────────────
      type StubOpts = { generate?: any; judge?: any };
      const counters = { generate: 0, judge: 0 };
      function makeStub(o: StubOpts): typeof fetch {
        return (async (_url: any, init: any) => {
          const prompt = String(JSON.parse(init.body).messages[0].content);
          const isJudge = prompt.includes("Du er faktakontrollør");
          if (isJudge) {
            counters.judge++;
            return o.judge ? await o.judge() : { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nOK." }] }) };
          }
          counters.generate++;
          return o.generate ? await o.generate() : { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FIXTURE_DESCRIPTION }] }) };
        }) as unknown as typeof fetch;
      }
      const neverCall = (label: string): typeof fetch =>
        (async () => { throw new Error(`${label}: fetch must NOT be called`); }) as unknown as typeof fetch;

      // ── Seed ────────────────────────────────────────────────────────
      const providerId = expStore.createProvider({
        navn: "Fjordtur AS", kommune: "Bergen", fylke: "Vestland",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const richSeed = (over: Record<string, unknown> = {}) => ({
        provider_id: providerId, kommune: "Bergen", fylke: "Vestland",
        category: "natur_friluft", subcategory: "kajakk", season: ["summer"],
        indoor_outdoor: "outdoor" as const, duration_min: 120, duration_max: 180,
        group_min: 2, group_max: 8, price_band: "standard", price_from: 890,
        price_unit: "per_person", languages: ["norsk", "engelsk"],
        accessibility: ["rullestolvennlig"], meeting_point: "Bryggen",
        booking_url: "https://example.no/book",
        verification_status: "verified" as const, confidence: "high" as const,
        ...over,
      });

      const idRich1 = expStore.createExperience(richSeed({ title: "Kajakktur i fjorden" }) as any);
      const idRich2 = expStore.createExperience(richSeed({ title: "Kajakktur ved øyene" }) as any);
      const idThin = expStore.createExperience({
        title: "Tynn opplevelse", kommune: "Oslo", fylke: "Oslo",
        category: "kultur_historie", verification_status: "verified", confidence: "high",
      } as any);
      const idGood = expStore.createExperience(richSeed({ title: "Padletur med guide", description: GOOD_EXISTING_DESCRIPTION }) as any);
      const idJunk = expStore.createExperience(richSeed({ title: "Gårdsbesøk med smaking", description: JUNK_EXISTING_DESCRIPTION }) as any);
      const idMerged = expStore.createExperience(richSeed({ title: "Kajakktur i fjorden (duplikat)" }) as any);
      expDb.prepare("UPDATE experiences SET canonical_id = ? WHERE id = ?").run(idRich1, idMerged);
      const idManual = expStore.createExperience(richSeed({ title: "Kuratert opplevelse", content_source: "manual" }) as any);
      const idClaim = expStore.createExperience(richSeed({ title: "Eier-hevdet opplevelse", content_source: "claim" }) as any);

      // ── ed-r1: admin gate. ───────────────────────────────────────────
      setStub(neverCall("ed-r1"));
      assertEq((await post({ dry_run: true }, null)).status, 403, "ed-r1a: missing X-Admin-Key -> 403");
      assertEq((await post({ dry_run: true }, "wrong-key")).status, 403, "ed-r1b: wrong X-Admin-Key -> 403");

      // ── ed-r2: an EMPTY candidate set makes ZERO LLM calls. ───────────
      {
        const r = await post({ ids: ["no-such-experience-id"] });
        assertEq(r.status, 200, "ed-r2a: 200");
        assertEq(r.body.dry_run, true, "ed-r2b: dry_run defaults to true");
        assertEq(r.body.candidates, 0, "ed-r2c: candidates: 0");
        assertEq(r.body.sample, [], "ed-r2d: empty sample — the LLM was never called");
      }

      // ── ed-r3: candidate-set composition (unscoped scan). ─────────────
      {
        const r = await post({ dry_run: true, ids: [] });
        assertEq(r.body.candidates, 4,
          "ed-r3a: candidates = rich1 + rich2 + thin + junk (good/merged/manual/claim excluded)");
      }
      for (const [label, id] of [
        ["ed-r3b: a GOOD existing description", idGood],
        ["ed-r3c: a dedup-merged-away row", idMerged],
        ["ed-r3d: a content_source='manual' row", idManual],
        ["ed-r3e: a content_source='claim' row", idClaim],
      ] as Array<[string, string]>) {
        const r = await post({ ids: [id] });
        assertEq(r.body.candidates, 0, `${label} is never a candidate`);
      }

      // ── ed-r4: THIN row, apply mode -> zero LLM calls, nothing written. ─
      setStub(neverCall("ed-r4"));
      {
        const before = dumpAll();
        const r = await post({ dry_run: false, ids: [idThin] });
        assertEq(r.status, 200, "ed-r4a: 200 (never throws)");
        assertEq(r.body.candidates, 1, "ed-r4b: the thin row IS a candidate (its description is NULL)");
        assertEq(r.body.processed, 1, "ed-r4c: processed: 1");
        assertEq(r.body.written, 0, "ed-r4d: written: 0");
        assertEq(r.body.skipped, 1, "ed-r4e: skipped: 1");
        assertEq(r.body.skipped_reasons.thin_data, 1, "ed-r4f: skip reason is thin_data");
        assertEq(descOf(idThin), null, "ed-r4g: description still NULL");
        assertEq(dumpAll(), before, "ed-r4h: NOT ONE row changed (fetch stub would have thrown on any call)");
      }

      // ── ed-r5: dry_run (default + non-literal-false) writes NOTHING. ───
      setStub(makeStub({}));
      for (const [label, body] of [
        ["ed-r5a: no body at all", undefined],
        ["ed-r5b: {} (dry_run omitted)", {}],
        ['ed-r5c: dry_run: "false" (string)', { dry_run: "false" }],
        ["ed-r5d: dry_run: 0", { dry_run: 0 }],
        ["ed-r5e: dry_run: null", { dry_run: null }],
      ] as Array<[string, any]>) {
        const before = dumpAll();
        const r = await post(body === undefined ? undefined : { ...body, ids: [idRich1] });
        assertEq(r.body.dry_run, true, `${label} -> dry_run: true`);
        assertEq(dumpAll(), before, `${label} -> ZERO DB writes (before/after row dump identical)`);
      }
      // The default-dry-run preview still returns a real proposal + verdict.
      {
        const r = await post({ ids: [idRich1] });
        assertEq(r.body.sample.length, 1, "ed-r5f: sample has the one targeted candidate");
        assertEq(r.body.sample[0].id, idRich1, "ed-r5g: sampled row is the targeted one");
        assertEq(r.body.sample[0].proposed_description, FIXTURE_DESCRIPTION, "ed-r5h: proposal is the generated text");
        assertEq(r.body.sample[0].judge_approved, true, "ed-r5i: judge verdict is surfaced in the preview");
        assertEq(r.body.sample[0].skip_reason, null, "ed-r5j: no skip reason on an approved proposal");
        assertTrue(r.body.sample[0].word_count >= 400, "ed-r5k: word_count surfaced and ≥400");
      }

      // ── ed-r6: apply mode — generation + judge approve -> written. ─────
      {
        expDb.prepare("UPDATE experiences SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(idRich1);
        counters.generate = 0; counters.judge = 0;
        const r = await post({ dry_run: false, ids: [idRich1] });
        assertEq(r.body.dry_run, false, "ed-r6a: dry_run: false echoed back");
        assertEq(r.body.processed, 1, "ed-r6b: processed: 1");
        assertEq(r.body.written, 1, "ed-r6c: written: 1");
        assertEq(r.body.skipped, 0, "ed-r6d: skipped: 0");
        assertEq(r.body.remaining, 0, "ed-r6e: remaining: 0");
        assertEq(counters.generate, 1, "ed-r6f: exactly one generate call");
        assertEq(counters.judge, 1, "ed-r6g: exactly one judge call");
        assertEq(descOf(idRich1), FIXTURE_DESCRIPTION, "ed-r6h: description WAS written");
        const evidence = JSON.parse(rowOf(idRich1).content_field_evidence || "{}");
        assertEq(evidence.description, EXP_DESC_GENERATED_PROVENANCE_SENTINEL,
          "ed-r6i: content_field_evidence.description stamped with the generated (non-homepage) sentinel");
        assertTrue(rowOf(idRich1).updated_at !== "2020-01-01 00:00:00", "ed-r6j: updated_at was bumped");
      }

      // ── ed-r7: idempotent — the written row is no longer a candidate. ──
      {
        const r = await post({ ids: [idRich1] });
        assertEq(r.body.candidates, 0, "ed-r7: a row we just filled is no longer a candidate");
      }

      // ── ed-r8: a JUNK existing description IS replaced. ────────────────
      {
        const r = await post({ dry_run: false, ids: [idJunk] });
        assertEq(r.body.written, 1, "ed-r8a: written: 1");
        assertEq(descOf(idJunk), FIXTURE_DESCRIPTION, "ed-r8b: junk description replaced by the generated one");
      }

      // ── ed-r9: judge REJECTS -> nothing written. ───────────────────────
      setStub(makeStub({ judge: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nTeksten inneholder en oppdiktet pris." }] }) }) }));
      {
        const before = dumpAll();
        const r = await post({ dry_run: false, ids: [idRich2] });
        assertEq(r.status, 200, "ed-r9a: 200");
        assertEq(r.body.processed, 1, "ed-r9b: processed: 1");
        assertEq(r.body.written, 0, "ed-r9c: written: 0 — the judge rejected");
        assertEq(r.body.skipped_reasons.judge_rejected, 1, "ed-r9d: skip reason is judge_rejected");
        assertEq(descOf(idRich2), null, "ed-r9e: description untouched");
        assertEq(dumpAll(), before, "ed-r9f: ZERO rows changed");
      }

      // ── ed-r10: missing ANTHROPIC_API_KEY -> fail-closed, no write, no
      //    throw, and not a single fetch. ─────────────────────────────────
      delete process.env.ANTHROPIC_API_KEY;
      setStub(neverCall("ed-r10"));
      {
        const before = dumpAll();
        const r = await post({ dry_run: false, ids: [idRich2] });
        assertEq(r.status, 200, "ed-r10a: 200 (does not throw/500)");
        assertEq(r.body.written, 0, "ed-r10b: written: 0");
        assertEq(r.body.skipped_reasons.generation_failed, 1, "ed-r10c: skip reason is generation_failed");
        assertEq(dumpAll(), before, "ed-r10d: ZERO rows changed");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-route";

      // ── ed-r11: malformed / non-200 at EITHER leg -> fail-closed. ──────
      {
        const legs: Array<[string, StubOpts]> = [
          ["ed-r11a: generate non-200", { generate: async () => ({ ok: false, status: 500, json: async () => ({}) }) }],
          ["ed-r11b: generate unparseable body", { generate: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) }],
          ["ed-r11c: generate non-array content", { generate: async () => ({ ok: true, status: 200, json: async () => ({ content: { bad: "shape" } }) }) }],
          ["ed-r11d: generate network throw", { generate: async () => { throw new Error("boom"); } }],
          ["ed-r11e: judge non-200", { judge: async () => ({ ok: false, status: 502, json: async () => ({}) }) }],
          ["ed-r11f: judge unparseable body", { judge: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) }],
          ["ed-r11g: judge non-array content", { judge: async () => ({ ok: true, status: 200, json: async () => ({ content: { bad: "shape" } }) }) }],
          ["ed-r11h: judge network throw", { judge: async () => { throw new Error("boom"); } }],
        ];
        for (const [label, o] of legs) {
          setStub(makeStub(o));
          const before = dumpAll();
          const r = await post({ dry_run: false, ids: [idRich2] });
          assertEq(r.status, 200, `${label} -> 200, never throws`);
          assertEq(r.body.written, 0, `${label} -> written: 0`);
          assertEq(dumpAll(), before, `${label} -> ZERO rows changed`);
        }
      }

      // ── ed-r12: `ids` is parameterised, never interpolated. ────────────
      setStub(neverCall("ed-r12"));
      {
        const r = await post({ dry_run: false, ids: ["' OR 1=1 --"] });
        assertEq(r.status, 200, "ed-r12a: a SQL-shaped id is just a value -> 200");
        assertEq(r.body.candidates, 0, "ed-r12b: matches nothing (parameterised, not interpolated)");
      }
      {
        const r = await post({ ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) });
        assertEq(r.status, 400, "ed-r12c: >100 ids -> 400");
      }
      // A malformed `ids` must 400 rather than silently widening to the whole
      // catalog — a targeted call must never turn into a full-batch spend.
      {
        const r = await post({ dry_run: false, ids: "exp-1" });
        assertEq(r.status, 400, "ed-r12d: a non-array ids -> 400, never a full-catalog scan");
      }
      {
        const r = await post({ dry_run: false, ids: ["", "   ", 42] });
        assertEq(r.status, 400, "ed-r12e: ids with no usable entry -> 400, never a full-catalog scan");
      }

      // ── ed-r13: batch cap — 12 fresh candidates, only 10 processed. ────
      setStub(makeStub({}));
      {
        const batchIds: string[] = [];
        for (let i = 0; i < 12; i++) {
          batchIds.push(expStore.createExperience(richSeed({ title: `Batchtur nummer ${i}` }) as any));
        }
        counters.generate = 0; counters.judge = 0;
        const r = await post({ dry_run: false, ids: batchIds });
        assertEq(r.body.candidates, 12, "ed-r13a: 12 candidates in the targeted set");
        assertEq(r.body.processed, 10, "ed-r13b: processed capped at EXP_DESC_BATCH_CAP (10)");
        assertEq(r.body.written, 10, "ed-r13c: written: 10");
        assertEq(r.body.remaining, 2, "ed-r13d: remaining: 2");
        assertEq(counters.generate, 10, "ed-r13e: exactly 10 generate calls (cap respected before the LLM)");
        assertEq(counters.judge, 10, "ed-r13f: exactly 10 judge calls");
        const filled = batchIds.filter((id) => descOf(id) === FIXTURE_DESCRIPTION).length;
        assertEq(filled, 10, "ed-r13g: exactly 10 of the 12 rows got a description");
      }

      // ── ed-r14: dry_run sample cap (3). ───────────────────────────────
      {
        const r = await post({ dry_run: true });
        assertTrue(r.body.candidates >= 3, "ed-r14a: more candidates remain than the sample cap");
        assertEq(r.body.sample.length, 3, "ed-r14b: dry-run sample capped at EXP_DESC_DRY_RUN_SAMPLE (3)");
      }

      // ── ed-r15: the GOOD description survived every run above. ─────────
      assertEq(descOf(idGood), GOOD_EXISTING_DESCRIPTION, "ed-r15a: a GOOD description was never overwritten");
      assertEq(descOf(idManual), null, "ed-r15b: a content_source='manual' row was never written to");
      assertEq(descOf(idClaim), null, "ed-r15c: a content_source='claim' row was never written to");
      assertEq(descOf(idMerged), null, "ed-r15d: a dedup-merged-away row was never written to");

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section D): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

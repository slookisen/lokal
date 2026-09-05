/**
 * opplevelser-experience-description-enrichment.test.ts — tests for
 * dev-request 2026-07-12-opplevagent-serp-innholdsberikelse, item 1
 * ("Innholdsberikelse"), EXTENDED by dev-request 2026-09-02-experiences-
 * beskrivelsesnivaa-kort-og-kildetro ("Beskrivelsesnivå"): the level-selected,
 * source-grounded/judge-gated writer for `experiences.description` behind
 * POST /api/opplevelser/admin/experiences-description-enrichment.
 *
 * The 2026-09-02 dev-request REPLACED the original single-tier ≥400-word
 * design with THREE per-row outcomes, selected by selectExperienceDescription-
 * Tier() before any LLM call:
 *   - `kildetro`    60-150 words, grounded ONLY in the provider's own
 *                   eierskapsverifiserte hjemmeside, judged against that
 *                   homepage text as fasit.
 *   - `faktalinje`  1-2 setninger, <=40 words, grounded ONLY in the row's own
 *                   structured facts (>=4 distinct fact-kinds, down from the
 *                   retired tier's 6) — the retired tier's generator/judge
 *                   MACHINERY (never-fabricate fetch contract, sentinel
 *                   escape, ungrounded-number scan, GODKJENN/AVVIS judge
 *                   protocol) is reused unchanged; only the length bar and
 *                   thin-data floor moved.
 *   - `skip`        neither bar clears. Zero LLM calls.
 * The original ≥400-word single tier is fully RETIRED — no row can reach it
 * any more. Sections B/B2 below, which used to exercise that retired tier,
 * are updated in place to assert the new faktalinje bar instead, preserving
 * their regression value on the shared fact-builder/sentinel/judge-token
 * machinery those sections were really testing all along.
 *
 * Sections:
 *   A  — pure helpers (fact assembly / thin-data measure / word count /
 *        ungrounded-number scan / candidate predicate). No DB, no network.
 *   A2 — selectExperienceDescriptionTier(): level selection (kildetro /
 *        faktalinje / skip), including the blocked-homepage fallthrough.
 *   B  — generateExperienceDescriptionNo()/-Detailed(): now the `faktalinje`
 *        generator — never-fabricate, never-throw contract at the NEW
 *        4-fact/<=40-word bar (thin row -> zero LLM calls, missing key,
 *        sentinel, word ceiling, ungrounded numbers, non-200, unparseable
 *        body, non-array content shape, network throw).
 *   C  — judgeExperienceDescriptionCandidate(): the exact-token GODKJENN /
 *        AVVIS contract, fail-closed on every deviation, PLUS the new
 *        optional `groundTruthText` parameter (kildetro's "dommer med
 *        fasit") — additive, so every pre-existing case above is unchanged.
 *   E  — generateExperienceDescriptionKildetro(): the new 60-150-word,
 *        homepage-grounded generator (title-token requirement, word floor/
 *        ceiling, sentinel, API-deviation fail-closed contract).
 *   D  — the route: candidate-set composition, dry_run strict-false idiom,
 *        apply-mode writes + provenance stamp per tier, judge rejection,
 *        every fail-closed path, the parameterised `ids` filter, the batch
 *        cap, PLUS (2026-09-02) the kildetro path end-to-end (homepage-fetch
 *        stub + LLM stub independently controlled), the blocked-homepage
 *        fallthrough, the auto-supersede upgrade, and the new
 *        no_title_node/fetch_failed skipped_reasons buckets.
 *
 * Setup convention mirrors opplevelser-gardssalg-products.test.ts /
 * opplevelser-gardssalg-rewrite.test.ts: EXPERIENCES_DB_PATH=":memory:", a
 * fresh require of db-factory + experience-store + the opplevelser router
 * per run, and the router exercised directly via router.handle(). The
 * Anthropic call is NEVER real — sections A-C/E stub globalThis.fetch or a
 * direct fetchImpl argument, and section D uses the route's OWN per-app-
 * instance injection seams ("experienceDescriptionFetchImpl" for the LLM,
 * the twin of the title-no backfill's "titleNoBackfillFetchImpl", PLUS the
 * NEW "experienceDescriptionHomepageFetchImpl" for kildetro's independent
 * homepage fetch), reached through the fake `req.app` the callRoute() helper
 * below supplies. Neither ever touches the real network.
 */

import {
  buildExperienceDescriptionFacts,
  renderExperienceDescriptionFactsBlock,
  expDescWordCount,
  expDescHasUngroundedNumbers,
  experienceDescriptionNeedsEnrichment,
  generateExperienceDescriptionNo,
  generateExperienceDescriptionNoDetailed,
  generateExperienceDescriptionKildetro,
  judgeExperienceDescriptionCandidate,
  selectExperienceDescriptionTier,
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
 *  the route reads its fetch-injection seams off (req.app.get(...)) — the
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
// A ≥400-word Norwegian prose fixture that contains NO digits at all. Kept
// for the PURE judge tests (section C), which grade arbitrary candidate
// prose against a facts block / ground-truth text and never enforce a word
// count themselves — length-agnostic, so it remains a valid "some real
// prose" fixture even though no generator in this file can produce ≥400
// words any more.
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

// ── faktalinje fixture: <=40 words, digit-free — the NEW tier's shape. ─────
const FAKTALINJE_FIXTURE =
  "Denne opplevelsen byr på en aktiv dag ute i naturen sammen med en lokal tilbyder som legger vekt på trygghet og godt følge.";
// A short, plainly ACCEPTABLE text under what used to be a 400-word floor —
// regression-guards the deliberate design choice that faktalinje has NO
// minimum beyond non-empty (gen-5 below).
const FAKTALINJE_VERY_SHORT = "Kort tur ved sjøen for hele familien.";
// Two faktalinje-shaped sentences back to back clears 40 words -> ceiling.
const FAKTALINJE_TOO_LONG = `${FAKTALINJE_FIXTURE} ${FAKTALINJE_FIXTURE}`;

// ── kildetro fixtures: 60-150 words, homepage-grounded. ────────────────────
// Mentions "kajakktur"/"fjorden" — the two >=5-char tokens of richCandidate()
// / the route-level seed's title "Kajakktur i fjorden" — so
// descriptionMentionsExperienceTitle() passes.
const KILDETRO_SENTENCE_ON_TOPIC =
  "Vi tilbyr en kajakktur i rolig sjø for både nybegynnere og erfarne padlere, og turen starter ved brygga rett ved sjøen der guiden ønsker alle velkommen.";
function buildOnTopicKildetroFixture(): string {
  const parts: string[] = [];
  while (expDescWordCount(parts.join(" ")) < 70) parts.push(KILDETRO_SENTENCE_ON_TOPIC);
  return parts.join(" ");
}
const KILDETRO_FIXTURE = buildOnTopicKildetroFixture();

// Same length bar, but never mentions the experience — homepage-wide "om
// oss" marketing copy, the exact shape the title-token guard exists to catch.
const KILDETRO_SENTENCE_OFF_TOPIC =
  "Vi er en lokal bedrift som har drevet med opplevelser i mange år, og vi legger stor vekt på kvalitet, trygghet og godt vertskap for alle våre gjester.";
function buildOffTopicKildetroFixture(): string {
  const parts: string[] = [];
  while (expDescWordCount(parts.join(" ")) < 70) parts.push(KILDETRO_SENTENCE_OFF_TOPIC);
  return parts.join(" ");
}
const KILDETRO_NO_TITLE_FIXTURE = buildOffTopicKildetroFixture();

// A kildetro candidate that names a price NOT present anywhere in its
// grounding text — the shape kt-14 below proves gets caught. Built on top
// of the (digit-free) on-topic fixture so it also clears the title-token
// and word-count bars; only the ungrounded-number gate should fire.
const KILDETRO_FABRICATED_NUMBER = `${KILDETRO_FIXTURE} Turen koster 1500 kroner.`;
// Same fabricated-looking sentence, but this time the "1500" DOES appear in
// the (fictitious) homepage source below — kt-15 proves a number that's
// actually grounded is never a false positive.
const KILDETRO_HOMEPAGE_GROUNDED_PRICE = `${KILDETRO_FIXTURE} Prisen er 1500 kroner ifølge nettsiden.`;

/** A short, perfectly ordinary Norwegian description — non-blank and NOT
 *  junk by isJunkDescription()'s rule, i.e. content this endpoint must never
 *  touch. */
const GOOD_EXISTING_DESCRIPTION =
  "Bli med på en rolig padletur i skjermede farvann sammen med lokale guider. Turen passer for både nybegynnere og erfarne, og vi holder til rett ved sjøen.";

/** The Homme Gård shape isJunkDescription()'s rule 1 fires on (skip-link +
 *  nav tokens + a dumped contact block) — a candidate for replacement. */
const JUNK_EXISTING_DESCRIPTION =
  "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no Facebook-f Instagram Forside Gårdsutsalg Produksjon Meny";

/** A 13-of-13 fact row (the "rich" shape). No provider hjemmeside/field_
 *  provenance by default -> selectExperienceDescriptionTier() resolves this
 *  to `faktalinje` unless a test explicitly adds a verified homepage. */
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
    provider_field_provenance: null, provider_hjemmeside: null,
    ...over,
  };
}

/** field_provenance JSON matching isHjemmesideVerified()'s expected shape. */
function verifiedFieldProvenance(): string {
  return JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
}

export function runOpplevelserExperienceDescriptionEnrichmentTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the dry_run:false route under test reads enrichment_write_pause
  // off the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
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
    // Section A — pure helpers
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── fx-0: the fixture itself clears the deterministic bar. ─────────
      {
        const wc = expDescWordCount(FIXTURE_DESCRIPTION);
        assertTrue(wc >= 400 && wc <= 1200, `fx-0a: fixture description is 400-1200 words (was ${wc})`);
        assertTrue(!/\d/.test(FIXTURE_DESCRIPTION), "fx-0b: fixture description contains no digits at all");
      }
      {
        const wc = expDescWordCount(FAKTALINJE_FIXTURE);
        assertTrue(wc >= 1 && wc <= 40, `fx-0c: faktalinje fixture is <=40 words (was ${wc})`);
        assertTrue(!/\d/.test(FAKTALINJE_FIXTURE), "fx-0d: faktalinje fixture contains no digits at all");
        assertTrue(expDescWordCount(FAKTALINJE_TOO_LONG) > 40, "fx-0e: the doubled faktalinje fixture clears the 40-word ceiling");
      }
      {
        const wc = expDescWordCount(KILDETRO_FIXTURE);
        assertTrue(wc >= 60 && wc <= 150, `fx-0f: kildetro fixture is 60-150 words (was ${wc})`);
        const wc2 = expDescWordCount(KILDETRO_NO_TITLE_FIXTURE);
        assertTrue(wc2 >= 60 && wc2 <= 150, `fx-0g: off-topic kildetro fixture is 60-150 words (was ${wc2})`);
        const wc3 = expDescWordCount(KILDETRO_FABRICATED_NUMBER);
        assertTrue(wc3 >= 60 && wc3 <= 150, `fx-0h: fabricated-number kildetro fixture is 60-150 words (was ${wc3})`);
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

      // ── ed-3: a genuinely thin row falls under the NEW faktalinje
      //    threshold (4, down from the retired tier's 6). ─────────────────
      {
        const thin = buildExperienceDescriptionFacts({
          ...richCandidate(), subcategory: null, season: null, indoor_outdoor: null,
          duration_min: null, duration_max: null, group_min: null, group_max: null,
          price_band: null, price_from: null, languages: null, accessibility: null,
          meeting_point: null, booking_url: null, provider_navn: null,
        });
        assertEq(thin.length, 2, "ed-3: title+category+kommune/fylke only -> 2 fact-fields (below the 4 threshold)");
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
    // Section A2 — selectExperienceDescriptionTier()
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── st-1: verified homepage + clean domain -> kildetro. ────────────
      {
        const r = selectExperienceDescriptionTier(richCandidate({
          provider_field_provenance: verifiedFieldProvenance(),
          provider_hjemmeside: "kajakkfjord.example",
        }));
        assertEq(r.level, "kildetro", "st-1a: verified homepage + clean domain -> kildetro");
        assertTrue(r.reasoning.length > 0, "st-1b: reasoning string present");
      }

      // ── st-2: verified homepage + BLOCKED domain (dmo_visit_domain) with
      //    enough facts -> falls through to faktalinje, NOT skip. ─────────
      {
        const r = selectExperienceDescriptionTier(richCandidate({
          provider_field_provenance: verifiedFieldProvenance(),
          provider_hjemmeside: "visitbergen.no",
        }));
        assertEq(r.level, "faktalinje", "st-2a: verified-but-blocked homepage + >=4 facts -> faktalinje (never skip)");
        assertTrue(r.reasoning.includes("blokkert"), "st-2b: reasoning names the homepage as blocked");
      }

      // ── st-3: verified homepage + BLOCKED domain with too few facts ->
      //    skip (a blocked homepage does not manufacture facts). ──────────
      {
        const thinRow = richCandidate({
          provider_field_provenance: verifiedFieldProvenance(),
          provider_hjemmeside: "visitbergen.no",
          subcategory: null, season: null, indoor_outdoor: null,
          duration_min: null, duration_max: null, group_min: null, group_max: null,
          price_band: null, price_from: null, languages: null, accessibility: null,
          meeting_point: null, booking_url: null, provider_navn: null,
        });
        assertEq(selectExperienceDescriptionTier(thinRow).level, "skip", "st-3: blocked homepage + <4 facts -> skip");
      }

      // ── st-4: no hjemmeside at all, >=4 facts -> faktalinje. ────────────
      assertEq(selectExperienceDescriptionTier(richCandidate()).level, "faktalinje",
        "st-4: unverified/absent homepage + >=4 facts -> faktalinje");

      // ── st-5: no hjemmeside, <4 facts -> skip. ──────────────────────────
      {
        const thinRow = richCandidate({
          subcategory: null, season: null, indoor_outdoor: null,
          duration_min: null, duration_max: null, group_min: null, group_max: null,
          price_band: null, price_from: null, languages: null, accessibility: null,
          meeting_point: null, booking_url: null, provider_navn: null,
        });
        assertEq(selectExperienceDescriptionTier(thinRow).level, "skip", "st-5: no homepage + <4 facts -> skip");
      }

      // ── st-6: malformed/absent field_provenance fails CLOSED (never
      //    "assume verified"), even with a hjemmeside string present. ─────
      {
        const r = selectExperienceDescriptionTier(richCandidate({
          provider_field_provenance: "not valid json {{{",
          provider_hjemmeside: "kajakkfjord.example",
        }));
        assertEq(r.level, "faktalinje", "st-6: malformed field_provenance -> NOT verified -> faktalinje (fail-closed)");
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section A2): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — generateExperienceDescriptionNo() / -Detailed(): now the
    // `faktalinje` generator (4-fact floor, <=40-word ceiling, no floor)
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── gen-1: THIN row (<4 facts) -> null, and the LLM is never called. ─
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
        assertEq(r, null, "gen-1a: thin row (2 facts, below the 4-fact floor) -> null");
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

      // ── gen-3: happy path + the exact Anthropic request contract at the
      //    faktalinje bar. ────────────────────────────────────────────────
      {
        let capturedUrl: any = null;
        let capturedInit: any = null;
        const stub = (async (url: any, init: any) => {
          capturedUrl = url; capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_FIXTURE }] }) };
        }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionNo(richCandidate(), stub);
        assertEq(r, FAKTALINJE_FIXTURE, "gen-3a: a valid <=40-word response is returned verbatim");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "gen-3b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "gen-3c: model is claude-haiku-4-5");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "gen-3d: x-api-key header carries ANTHROPIC_API_KEY");
        assertEq(capturedInit.headers["anthropic-version"], "2023-06-01", "gen-3e: anthropic-version header is set");
        const prompt = body.messages[0].content as string;
        assertTrue(prompt.includes("Pris: fra 890 kroner per person"), "gen-3f: prompt carries the row's own structured facts");
        assertTrue(prompt.includes("Bruk KUN faktaopplysningene"), "gen-3g: prompt carries the kun-kildebasert instruction");
        assertTrue(prompt.includes("UTILSTREKKELIG_GRUNNLAG"), "gen-3h: prompt carries the too-thin escape sentinel");
        assertTrue(prompt.includes("ALDRI mer enn 40 ord"), "gen-3i: prompt carries the NEW <=40-word ceiling (not the retired 400-word floor)");
        assertTrue(prompt.includes("ÉN til TO setninger"), "gen-3i2: prompt asks for one to two sentences");

        // ── gen-3j/k: the anti-fabrication ABSOLUTTE REGLER against
        //    ungrounded place/season flavor text survive unchanged from the
        //    retired tier's prompt (lokal PR #482 finding). ────────────────
        assertTrue(
          prompt.includes("Nevn ALDRI et sted, en region, en fjord, et fjell eller en severdighet som ikke står i faktalisten"),
          "gen-3j: prompt forbids naming any place/region/fjord/mountain/landmark not in the facts list",
        );
        assertTrue(
          prompt.includes("Skriv ALDRI om årstid, klima eller vær knyttet til et bestemt sted eller en bestemt region"),
          "gen-3k: prompt forbids season/climate/weather claims tied to a specific place or region",
        );
        // ── gen-3l: NEW faktalinje-specific rule from the dev-request's own
        //    spec text ("ingen adjektiver uten kilde"). ─────────────────────
        assertTrue(
          prompt.includes("Ikke bruk adjektiver eller vurderende ord") && prompt.includes("direkte forankret i en oppgitt fakta"),
          "gen-3l: prompt forbids unsourced adjectives/evaluative language",
        );
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

      // ── gen-5: a very short text (well under what used to be the 400-word
      //    floor) is now ACCEPTED — faktalinje has NO minimum beyond non-
      //    empty. Regression-guard against silently reintroducing a floor. ─
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_VERY_SHORT }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), FAKTALINJE_VERY_SHORT,
          "gen-5: a short (<10-word) response is accepted verbatim — no word floor for faktalinje");
      }

      // ── gen-6: above the NEW 40-word ceiling -> null. ──────────────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_TOO_LONG }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), null, "gen-6: >40 words -> null");
      }

      // ── gen-7: a fabricated number that is not in the facts -> null. ───
      {
        const fabricated = "Gården ble grunnlagt i 1847 og ligger 12 kilometer fra sentrum.";
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: fabricated }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub), null,
          "gen-7a: prose containing an ungrounded year/distance -> null (never written)");
        const grounded = "Turen varer mellom 120 og 180 minutter for 2 til 8 personer.";
        const stub2 = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: grounded }] }) })) as unknown as typeof fetch;
        assertEq(await generateExperienceDescriptionNo(richCandidate(), stub2), grounded,
          "gen-7b: prose whose numbers all come from the facts is accepted");
      }

      // ── gen-8..13: every API deviation resolves to null, never a throw. ─
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
    // Section B2 — generateExperienceDescriptionNoDetailed(): diagnostic
    // reason granularity behind the single `null` above. Every case mirrors
    // a Section B case 1:1; this only asserts `.reason` is the correct
    // DISTINCT tag and that `.text` is byte-identical to what
    // generateExperienceDescriptionNo() already returns for the same input.
    // ═══════════════════════════════════════════════════════════════════
    try {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      {
        const thinRow = richCandidate({
          subcategory: null, season: null, indoor_outdoor: null,
          duration_min: null, duration_max: null, group_min: null, group_max: null,
          price_band: null, price_from: null, languages: null, accessibility: null,
          meeting_point: null, booking_url: null, provider_navn: null,
        });
        const stub = (async () => { throw new Error("gen-r1: fetch must NOT be called for a thin row"); }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionNoDetailed(thinRow, stub);
        assertEq(r.text, null, "gen-r1a: thin row -> null text");
        assertEq(r.reason, "thin_data", "gen-r1b: thin row -> reason thin_data");
      }

      delete process.env.ANTHROPIC_API_KEY;
      {
        const r = await generateExperienceDescriptionNoDetailed(richCandidate(), (async () => { throw new Error("no"); }) as unknown as typeof fetch);
        assertEq(r.reason, "no_api_key", "gen-r2: missing key -> reason no_api_key");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_FIXTURE }] }) })) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionNoDetailed(richCandidate(), stub);
        assertEq(r.text, FAKTALINJE_FIXTURE, "gen-r3a: success -> text set");
        assertEq(r.reason, null, "gen-r3b: success -> no fail reason");
      }

      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "UTILSTREKKELIG_GRUNNLAG" }] }) })) as unknown as typeof fetch;
        assertEq((await generateExperienceDescriptionNoDetailed(richCandidate(), stub)).reason, "sentinel", "gen-r4: exact sentinel -> reason sentinel");
      }
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Fint. UTILSTREKKELIG_GRUNNLAG likevel." }] }) })) as unknown as typeof fetch;
        assertEq((await generateExperienceDescriptionNoDetailed(richCandidate(), stub)).reason, "sentinel_smuggled", "gen-r4b: sentinel smuggled into prose -> reason sentinel_smuggled");
      }

      // ── gen-r5: no floor -> a short text SUCCEEDS (reason null), mirrors
      //    Section B's gen-5 design-choice regression guard. ───────────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_VERY_SHORT }] }) })) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionNoDetailed(richCandidate(), stub);
        assertEq(r.text, FAKTALINJE_VERY_SHORT, "gen-r5a: short text -> text set (no floor)");
        assertEq(r.reason, null, "gen-r5b: short text -> no fail reason");
      }
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_TOO_LONG }] }) })) as unknown as typeof fetch;
        assertEq((await generateExperienceDescriptionNoDetailed(richCandidate(), stub)).reason, "above_word_ceiling", "gen-r6: >40 words -> reason above_word_ceiling");
      }
      {
        const fabricated = "Gården ble grunnlagt i 1847 og ligger 12 kilometer fra sentrum.";
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: fabricated }] }) })) as unknown as typeof fetch;
        assertEq((await generateExperienceDescriptionNoDetailed(richCandidate(), stub)).reason, "ungrounded_numbers", "gen-r7: ungrounded number -> reason ungrounded_numbers");
      }

      {
        const cases: Array<[string, any, string]> = [
          ["gen-r8: non-200 response", async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }), "http_error"],
          ["gen-r9: unparseable JSON body", async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }), "unparseable_json"],
          ["gen-r10: non-array content shape", async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) }), "unexpected_response_shape"],
          ["gen-r11: network throw", async () => { throw new Error("simulated network failure"); }, "network_error"],
          ["gen-r12: empty text", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "   " }] }) }), "empty_response"],
          ["gen-r13: no text block", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use" }] }) }), "unexpected_response_shape"],
        ];
        for (const [label, impl, expectedReason] of cases) {
          const r = await generateExperienceDescriptionNoDetailed(richCandidate(), impl as unknown as typeof fetch);
          assertEq(r.text, null, `${label} -> null text`);
          assertEq(r.reason, expectedReason, `${label} -> reason ${expectedReason}`);
        }
        // gen-r10/gen-r13 correctly share "unexpected_response_shape" (both are the same
        // `typeof text !== "string"` gate on two different malformed shapes) — every OTHER
        // pair here is a genuinely different code path and must report a distinct reason.
        const seen = new Set(cases.map(([, , reason]) => reason));
        assertEq(seen.size, cases.length - 1, "gen-r14: all API-deviation reasons are distinct except the two same-gate shape cases");
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section B2): unexpected error: " + String(err?.stack || err?.message || err));
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
      //    the exact facts block it was grounded in (no groundTruthText ->
      //    byte-identical control flow/tokens to before this dev-request). ─
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

      // ═══════════════════════════════════════════════════════════════
      // jd-10+ — the NEW optional `groundTruthText` parameter (kildetro's
      // "dommer med fasit"). Strictly additive: jd-1..jd-9 above never pass
      // it and are therefore untouched by this addition.
      // ═══════════════════════════════════════════════════════════════
      const HOMEPAGE_GROUND_TRUTH =
        "Vi tilbyr en kajakktur i rolig sjø for nybegynnere og erfarne padlere, med oppmøte ved brygga.";

      // ── jd-10: groundTruthText provided -> the prompt swaps the facts
      //    block for the homepage excerpt as fasit. ───────────────────────
      {
        let capturedInit: any = null;
        const stub = (async (_u: any, init: any) => {
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nAlt stemmer med hjemmesiden." }] }) };
        }) as unknown as typeof fetch;
        const v = await judgeExperienceDescriptionCandidate(KILDETRO_FIXTURE, FACTS_BLOCK, stub, HOMEPAGE_GROUND_TRUTH);
        assertEq(v.approved, true, "jd-10a: GODKJENN with groundTruthText -> approved");
        const prompt = JSON.parse(capturedInit.body).messages[0].content as string;
        assertTrue(prompt.includes(HOMEPAGE_GROUND_TRUTH), "jd-10b: prompt carries the homepage ground-truth excerpt");
        assertTrue(prompt.includes(KILDETRO_FIXTURE.slice(0, 80)), "jd-10c: prompt still carries the candidate text");
        assertTrue(!prompt.includes("Faktaliste (alt som er kjent):"), "jd-10d: groundTruth mode does not use the facts-block framing");
        assertTrue(prompt.includes("AKKURAT denne opplevelsen"), "jd-10e: groundTruth mode checks the text is about THIS experience, not generic marketing");
      }

      // ── jd-11: groundTruthText provided + AVVIS -> rejected. ───────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nPrisen finnes ikke på hjemmesiden." }] }) })) as unknown as typeof fetch;
        const v = await judgeExperienceDescriptionCandidate(KILDETRO_FIXTURE, FACTS_BLOCK, stub, "En kort hjemmesidetekst uten pris.");
        assertEq(v.approved, false, "jd-11: AVVIS with groundTruthText -> rejected");
      }

      // ── jd-12: missing key still rejects fail-closed even with
      //    groundTruthText supplied (the key check runs before either
      //    prompt branch). ─────────────────────────────────────────────
      delete process.env.ANTHROPIC_API_KEY;
      {
        let calls = 0;
        const stub = (async () => { calls++; throw new Error("jd-12: must not be called"); }) as unknown as typeof fetch;
        const v = await judgeExperienceDescriptionCandidate(KILDETRO_FIXTURE, FACTS_BLOCK, stub, HOMEPAGE_GROUND_TRUTH);
        assertEq(v.approved, false, "jd-12a: missing key -> rejected fail-closed (groundTruth mode too)");
        assertEq(calls, 0, "jd-12b: zero calls");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section C): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section E — generateExperienceDescriptionKildetro()
    // ═══════════════════════════════════════════════════════════════════
    try {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── kt-1: missing key -> null, zero calls. ─────────────────────────
      delete process.env.ANTHROPIC_API_KEY;
      {
        let calls = 0;
        const stub = (async () => { calls++; throw new Error("kt-1: must not be called"); }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_FIXTURE, stub);
        assertEq(r.text, null, "kt-1a: missing key -> null");
        assertEq(r.reason, "no_api_key", "kt-1b: reason no_api_key");
        assertEq(calls, 0, "kt-1c: zero LLM calls");
      }
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── kt-2: empty/blank homepage text -> null, ZERO calls (checked
      //    before any fetch — never spend a call on nothing to ground on). ─
      for (const [label, text] of [["kt-2a", ""], ["kt-2b", "   \n  "]] as Array<[string, string]>) {
        let calls = 0;
        const stub = (async () => { calls++; throw new Error(`${label}: must not be called`); }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionKildetro(richCandidate(), text, stub);
        assertEq(r.text, null, `${label}: blank homepage text -> null`);
        assertEq(r.reason, "empty_response", `${label}: reason empty_response`);
        assertEq(calls, 0, `${label}: zero LLM calls`);
      }

      // ── kt-3: happy path + the exact request contract. ─────────────────
      {
        let capturedUrl: any = null;
        let capturedInit: any = null;
        const stub = (async (url: any, init: any) => {
          capturedUrl = url; capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_FIXTURE }] }) };
        }) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionKildetro(richCandidate(), "Homepage tekst om kajakktur i fjorden.", stub);
        assertEq(r.text, KILDETRO_FIXTURE, "kt-3a: valid 60-150-word response returned verbatim");
        assertEq(r.reason, null, "kt-3b: no fail reason");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "kt-3c: calls the exact Anthropic endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "kt-3d: model is claude-haiku-4-5");
        const prompt = body.messages[0].content as string;
        assertTrue(prompt.includes("Homepage tekst om kajakktur i fjorden."), "kt-3e: prompt carries the homepage source text");
        assertTrue(prompt.includes("Kajakktur i fjorden"), "kt-3f: prompt names the experience title");
        assertTrue(prompt.includes("KUN opplysninger som faktisk står i kildeteksten"), "kt-3g: prompt carries the source-only instruction");
        assertTrue(prompt.includes("minst 60 ord") && prompt.includes("høyst 150 ord"), "kt-3h: prompt carries the 60-150-word bar");
      }

      // ── kt-4: the sentinel escape -> null. ──────────────────────────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "UTILSTREKKELIG_GRUNNLAG" }] }) })) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionKildetro(richCandidate(), "En hjemmeside uten noe brukbart.", stub);
        assertEq(r.text, null, "kt-4a: sentinel -> null");
        assertEq(r.reason, "sentinel", "kt-4b: reason sentinel");
      }

      // ── kt-5: below the 60-word floor -> null. ──────────────────────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "En kort tekst under seksti ord." }] }) })) as unknown as typeof fetch;
        assertEq((await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_FIXTURE, stub)).reason, "below_word_floor",
          "kt-5: <60 words -> reason below_word_floor");
      }

      // ── kt-6: above the 150-word ceiling -> null. ───────────────────────
      {
        const huge = `${KILDETRO_FIXTURE} ${KILDETRO_FIXTURE}`;
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: huge }] }) })) as unknown as typeof fetch;
        assertEq((await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_FIXTURE, stub)).reason, "above_word_ceiling",
          "kt-6: >150 words -> reason above_word_ceiling");
      }

      // ── kt-14: a candidate that names a number NOT present anywhere in
      //    the homepage source text -> rejected, reason ungrounded_numbers
      //    (mirrors gen-r7's faktalinje coverage of the same shared helper,
      //    but grounded against homepageText/cappedSource instead of a facts
      //    block — the review finding this pair of tests closes). ──────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_FABRICATED_NUMBER }] }) })) as unknown as typeof fetch;
        // Grounding text is digit-free -> "1500" in the candidate has no match.
        const r = await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_FIXTURE, stub);
        assertEq(r.text, null, "kt-14a: number absent from the homepage source -> null, never written");
        assertEq(r.reason, "ungrounded_numbers", "kt-14b: reason ungrounded_numbers");
      }

      // ── kt-15: no false-positive regression — a number that DOES appear
      //    in the homepage source text is accepted, not flagged. ──────────
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_FABRICATED_NUMBER }] }) })) as unknown as typeof fetch;
        // Grounding text also contains "1500" (phrased differently) -> grounded.
        const r = await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_HOMEPAGE_GROUNDED_PRICE, stub);
        assertEq(r.text, KILDETRO_FABRICATED_NUMBER, "kt-15a: number present in the homepage source -> accepted verbatim");
        assertEq(r.reason, null, "kt-15b: no fail reason");
      }

      // ── kt-7: title-token miss -> reason no_title_node, never written. ──
      {
        const stub = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_NO_TITLE_FIXTURE }] }) })) as unknown as typeof fetch;
        const r = await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_FIXTURE, stub);
        assertEq(r.text, null, "kt-7a: homepage-wide marketing copy that never names the experience -> null");
        assertEq(r.reason, "no_title_node", "kt-7b: reason no_title_node");
      }

      // ── kt-8..13: every API deviation resolves to null, never a throw. ──
      {
        const cases: Array<[string, any, string]> = [
          ["kt-8: non-200", async () => ({ ok: false, status: 500, json: async () => ({}) }), "http_error"],
          ["kt-9: unparseable JSON body", async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }), "unparseable_json"],
          ["kt-10: non-array content shape", async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) }), "unexpected_response_shape"],
          ["kt-11: network throw", async () => { throw new Error("simulated network failure"); }, "network_error"],
          ["kt-12: empty text", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "   " }] }) }), "empty_response"],
          ["kt-13: no text block", async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use" }] }) }), "unexpected_response_shape"],
        ];
        for (const [label, impl, expectedReason] of cases) {
          let threw = false;
          let r: { text: string | null; reason: string | null } = { text: "sentinel", reason: null };
          try {
            r = await generateExperienceDescriptionKildetro(richCandidate(), KILDETRO_FIXTURE, impl as unknown as typeof fetch);
          } catch { threw = true; }
          assertEq(r.text, null, `${label} -> null text`);
          assertEq(r.reason, expectedReason, `${label} -> reason ${expectedReason}`);
          assertTrue(!threw, `${label} -> never throws`);
        }
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section E): unexpected error: " + String(err?.stack || err?.message || err));
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
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // Per-test app settings object — the route's TWO fetch-injection seams
      // (dev-request 2026-09-02: kildetro spends an independent homepage
      // fetch alongside the LLM call, so each gets its own stub key).
      const appSettings: Record<string, unknown> = {};
      function setStub(stub: typeof fetch | undefined): void {
        appSettings["experienceDescriptionFetchImpl"] = stub;
      }
      function setHomepageStub(stub: typeof fetch | undefined): void {
        appSettings["experienceDescriptionHomepageFetchImpl"] = stub;
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
        expDb.prepare("SELECT id, description, content_field_evidence, content_source, updated_at FROM experiences WHERE id = ?").get(id);
      const descOf = (id: string): string | null => (rowOf(id)?.description ?? null);
      const dumpAll = (): string =>
        JSON.stringify(expDb.prepare("SELECT id, description, content_field_evidence, content_source, updated_at FROM experiences ORDER BY id").all());

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
          return o.generate ? await o.generate() : { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: FAKTALINJE_FIXTURE }] }) };
        }) as unknown as typeof fetch;
      }
      const neverCall = (label: string): typeof fetch =>
        (async () => { throw new Error(`${label}: fetch must NOT be called`); }) as unknown as typeof fetch;

      /** A homepage-fetch stub: the primary "/" page succeeds with `html`,
       *  every other path (sub-page crawl, other hosts) 404s harmlessly —
       *  mirrors the existing opplevelser-content-refresh-*.test.ts stub
       *  shape for globalThis.fetch, just wired through the route's OWN
       *  homepage-fetch injection seam instead of a global swap. */
      function makeHomepageStub(html: string): typeof fetch {
        return (async (url: any) => {
          let u: URL;
          try { u = new URL(String(url)); } catch {
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
          }
          if (u.pathname === "/" || u.pathname === "") {
            const bytes = new TextEncoder().encode(html);
            return {
              ok: true, status: 200,
              arrayBuffer: async () => bytes.buffer,
              headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
              url: String(url),
            } as unknown as Response;
          }
          return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
        }) as unknown as typeof fetch;
      }
      const homepageNeverCall = (label: string): typeof fetch =>
        (async () => { throw new Error(`${label}: homepage fetch must NOT be called`); }) as unknown as typeof fetch;
      const ON_TOPIC_HOMEPAGE_HTML =
        "<html><body><p>Vi tilbyr kajakktur i fjorden for hele familien. Kontakt oss for mer informasjon.</p></body></html>";

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

      // ── ed-r4: THIN row (2 facts, < the 4-fact floor), apply mode ->
      //    zero LLM calls, nothing written, level "skip". ─────────────────
      setStub(neverCall("ed-r4"));
      setHomepageStub(homepageNeverCall("ed-r4"));
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
        assertEq(dumpAll(), before, "ed-r4h: NOT ONE row changed (fetch stubs would have thrown on any call)");
      }

      // ── ed-r4b: a real generation-gate failure surfaces WHICH gate fired,
      //    end-to-end through the dry-run route response, AND the resolved
      //    `level` is surfaced alongside it (item 1b diagnostic + the
      //    2026-09-02 level field). idRich1 has no provider hjemmeside ->
      //    resolves to faktalinje -> the NEW gate that can fire without a
      //    floor is the 40-word CEILING, not the retired 400-word floor. ──
      {
        setStub(makeStub({
          generate: async () => ({
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: FAKTALINJE_TOO_LONG }] }),
          }),
        }));
        const r = await post({ ids: [idRich1] });
        assertEq(r.body.sample.length, 1, "ed-r4b1: one sampled candidate");
        assertEq(r.body.sample[0].level, "faktalinje", "ed-r4b2: level is faktalinje (no provider hjemmeside)");
        assertEq(r.body.sample[0].skip_reason, "generation_failed", "ed-r4b3: skip_reason is generation_failed");
        assertEq(r.body.sample[0].generation_fail_reason, "above_word_ceiling",
          "ed-r4b4: generation_fail_reason names the exact gate (the NEW 40-word ceiling)");
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
        assertEq(r.body.sample[0].level, "faktalinje", "ed-r5g2: level is faktalinje");
        assertTrue(typeof r.body.sample[0].reasoning === "string" && r.body.sample[0].reasoning.length > 0, "ed-r5g3: reasoning string present");
        assertEq(r.body.sample[0].proposed_description, FAKTALINJE_FIXTURE, "ed-r5h: proposal is the generated text");
        assertEq(r.body.sample[0].judge_approved, true, "ed-r5i: judge verdict is surfaced in the preview");
        assertEq(r.body.sample[0].skip_reason, null, "ed-r5j: no skip reason on an approved proposal");
        assertEq(r.body.sample[0].generation_fail_reason, null, "ed-r5j2: no generation_fail_reason on an approved proposal");
        assertTrue(r.body.sample[0].word_count >= 1 && r.body.sample[0].word_count <= 40, "ed-r5k: word_count surfaced and within the faktalinje bar");
      }

      // ── ed-r6: apply mode — generation + judge approve -> written, and
      //    content_source is UNCHANGED for a faktalinje write (the one
      //    behavior change this dev-request makes to the write path is
      //    gated strictly behind level === "kildetro"). ───────────────────
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
        assertEq(descOf(idRich1), FAKTALINJE_FIXTURE, "ed-r6h: description WAS written");
        const evidence = JSON.parse(rowOf(idRich1).content_field_evidence || "{}");
        assertEq(evidence.description, EXP_DESC_GENERATED_PROVENANCE_SENTINEL,
          "ed-r6i: content_field_evidence.description stamped with the generated (non-homepage) sentinel");
        assertEq(rowOf(idRich1).content_source, null, "ed-r6i2: content_source UNCHANGED for a faktalinje write");
        assertTrue(rowOf(idRich1).updated_at !== "2020-01-01 00:00:00", "ed-r6j: updated_at was bumped");
      }

      // ── ed-r7: idempotent — the written row is no longer a candidate
      //    (still no verified homepage, so no auto-supersede either). ─────
      {
        const r = await post({ ids: [idRich1] });
        assertEq(r.body.candidates, 0, "ed-r7: a row we just filled is no longer a candidate");
      }

      // ── ed-r8: a JUNK existing description IS replaced. ────────────────
      {
        const r = await post({ dry_run: false, ids: [idJunk] });
        assertEq(r.body.written, 1, "ed-r8a: written: 1");
        assertEq(descOf(idJunk), FAKTALINJE_FIXTURE, "ed-r8b: junk description replaced by the generated one");
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
        const filled = batchIds.filter((id) => descOf(id) === FAKTALINJE_FIXTURE).length;
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

      // ═══════════════════════════════════════════════════════════════
      // ed-k* — kildetro end-to-end, blocked-homepage fallthrough,
      // auto-supersede, and the new no_title_node/fetch_failed buckets
      // (dev-request 2026-09-02-experiences-beskrivelsesnivaa-kort-og-
      // kildetro). Each block gets its OWN fresh experience row so it
      // never interacts with the fixtures/state built up above.
      // ═══════════════════════════════════════════════════════════════

      // ── ed-k1: a provider with a verified CLEAN-domain homepage ->
      //    kildetro end-to-end: homepage fetch + LLM generate + LLM judge,
      //    each independently stubbed, write stamps the REAL homepage URL
      //    AND content_source = 'provider_site'. ─────────────────────────
      {
        const ktProviderId = expStore.createProvider({
          navn: "Kajakkfjord AS", kommune: "Bergen", fylke: "Vestland",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
          .run("kajakkfjord.example", verifiedFieldProvenance(), ktProviderId);
        const idKt1 = expStore.createExperience(richSeed({ provider_id: ktProviderId, title: "Kajakktur i fjorden" }) as any);

        setStub(makeStub({ generate: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_FIXTURE }] }) }) }));
        setHomepageStub(makeHomepageStub(ON_TOPIC_HOMEPAGE_HTML));

        const dry = await post({ ids: [idKt1] });
        assertEq(dry.body.sample.length, 1, "ed-k1a: one sampled candidate");
        assertEq(dry.body.sample[0].level, "kildetro", "ed-k1b: level is kildetro (verified clean-domain homepage)");
        assertEq(dry.body.sample[0].proposed_description, KILDETRO_FIXTURE, "ed-k1c: dry-run proposal is the homepage-grounded text");
        assertEq(dry.body.sample[0].judge_approved, true, "ed-k1d: judge approved in the dry-run preview");

        counters.generate = 0; counters.judge = 0;
        const apply = await post({ dry_run: false, ids: [idKt1] });
        assertEq(apply.body.written, 1, "ed-k1e: written: 1");
        assertEq(counters.generate, 1, "ed-k1f: exactly one LLM generate call");
        assertEq(counters.judge, 1, "ed-k1g: exactly one LLM judge call");
        assertEq(descOf(idKt1), KILDETRO_FIXTURE, "ed-k1h: description is the homepage-grounded text");
        const row = rowOf(idKt1);
        assertEq(row.content_source, "provider_site", "ed-k1i: content_source stamped 'provider_site' — the ONE write-path change this dev-request makes, gated to kildetro");
        const evidence = JSON.parse(row.content_field_evidence || "{}");
        assertEq(evidence.description, "https://kajakkfjord.example", "ed-k1j: content_field_evidence.description is the REAL homepage URL, never the generated-provenance sentinel");
      }

      // ── ed-k2: verified homepage, BLOCKED domain (dmo_visit_domain) ->
      //    falls through to faktalinje — the homepage fetch seam is NEVER
      //    touched (a blocked domain is never even attempted as a source). ─
      {
        const ktProviderId = expStore.createProvider({
          navn: "Bergen Opplevelser AS", kommune: "Bergen", fylke: "Vestland",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
          .run("visitbergen.no", verifiedFieldProvenance(), ktProviderId);
        const idKt2 = expStore.createExperience(richSeed({ provider_id: ktProviderId, title: "Fjordsafari med RIB" }) as any);

        setStub(makeStub({}));
        setHomepageStub(homepageNeverCall("ed-k2"));
        const dry = await post({ ids: [idKt2] });
        assertEq(dry.body.sample[0].level, "faktalinje", "ed-k2a: blocked-domain homepage -> faktalinje, not skip");
        assertTrue(dry.body.sample[0].reasoning.includes("blokkert"), "ed-k2b: reasoning names the homepage as blocked");

        const apply = await post({ dry_run: false, ids: [idKt2] });
        assertEq(apply.body.written, 1, "ed-k2c: written via the faktalinje path");
        assertEq(rowOf(idKt2).content_source, null, "ed-k2d: content_source untouched (faktalinje write)");
        const evidence = JSON.parse(rowOf(idKt2).content_field_evidence || "{}");
        assertEq(evidence.description, EXP_DESC_GENERATED_PROVENANCE_SENTINEL, "ed-k2e: sentinel evidence, never a URL, for the blocked-domain fallthrough");
      }

      // ── ed-k3: verified clean-domain homepage, but the homepage FETCH
      //    fails -> generation_failed / fetch_failed, and the LLM seam is
      //    NEVER touched (no point spending a generate/judge call on a row
      //    with no source text at all). ────────────────────────────────────
      {
        const ktProviderId = expStore.createProvider({
          navn: "Uoppnaelig Fjordtur AS", kommune: "Bergen", fylke: "Vestland",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
          .run("uoppnaelig-fjordtur.example", verifiedFieldProvenance(), ktProviderId);
        const idKt3 = expStore.createExperience(richSeed({ provider_id: ktProviderId, title: "Fjordtur med kajakk" }) as any);

        setStub(neverCall("ed-k3"));
        setHomepageStub((async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } })) as unknown as typeof fetch);

        const before = dumpAll();
        const r = await post({ dry_run: false, ids: [idKt3] });
        assertEq(r.status, 200, "ed-k3a: 200, never throws");
        assertEq(r.body.written, 0, "ed-k3b: written: 0");
        assertEq(r.body.skipped_reasons.fetch_failed, 1, "ed-k3c: skipped_reasons.fetch_failed counts this row");
        assertEq(dumpAll(), before, "ed-k3d: ZERO rows changed");
      }

      // ── ed-k4: verified clean-domain homepage, fetch succeeds, but the
      //    generated text never names the experience -> no_title_node. ────
      {
        const ktProviderId = expStore.createProvider({
          navn: "Generisk Fjordtur AS", kommune: "Bergen", fylke: "Vestland",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
          .run("generisk-fjordtur.example", verifiedFieldProvenance(), ktProviderId);
        const idKt4 = expStore.createExperience(richSeed({ provider_id: ktProviderId, title: "Kajakktur i fjorden" }) as any);

        setStub(makeStub({ generate: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_NO_TITLE_FIXTURE }] }) }) }));
        setHomepageStub(makeHomepageStub(ON_TOPIC_HOMEPAGE_HTML));

        const before = dumpAll();
        const r = await post({ dry_run: false, ids: [idKt4] });
        assertEq(r.body.written, 0, "ed-k4a: written: 0");
        assertEq(r.body.skipped_reasons.no_title_node, 1, "ed-k4b: skipped_reasons.no_title_node counts this row");
        assertEq(dumpAll(), before, "ed-k4c: ZERO rows changed");
      }

      // ── ed-k5: verified clean-domain homepage, but the JUDGE (graded
      //    against the homepage text as fasit) rejects -> nothing written. ─
      {
        const ktProviderId = expStore.createProvider({
          navn: "Uenig Fjordtur AS", kommune: "Bergen", fylke: "Vestland",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
          .run("uenig-fjordtur.example", verifiedFieldProvenance(), ktProviderId);
        const idKt5 = expStore.createExperience(richSeed({ provider_id: ktProviderId, title: "Kajakktur i fjorden" }) as any);

        setStub(makeStub({ generate: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_FIXTURE }] }) }), judge: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nPåstand uten dekning i hjemmesideteksten." }] }) }) }));
        setHomepageStub(makeHomepageStub(ON_TOPIC_HOMEPAGE_HTML));

        const before = dumpAll();
        const r = await post({ dry_run: false, ids: [idKt5] });
        assertEq(r.body.written, 0, "ed-k5a: written: 0 — judge-with-ground-truth rejected");
        assertEq(r.body.skipped_reasons.judge_rejected, 1, "ed-k5b: skip reason judge_rejected");
        assertEq(dumpAll(), before, "ed-k5c: ZERO rows changed");
      }

      // ── ed-k6: auto-supersede — an EXISTING faktalinje row (sentinel in
      //    content_field_evidence.description) whose provider has SINCE
      //    gained a verified clean-domain homepage is re-selected and
      //    UPGRADED to kildetro, never re-run through faktalinje again. ────
      {
        const ktProviderId = expStore.createProvider({
          navn: "Nyverifisert Fjordtur AS", kommune: "Bergen", fylke: "Vestland",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        const idKt6 = expStore.createExperience(richSeed({ provider_id: ktProviderId, title: "Kajakktur i fjorden" }) as any);
        // Simulate an existing faktalinje write from a PREVIOUS run (no
        // verified homepage existed at the time).
        expDb.prepare("UPDATE experiences SET description = ?, content_field_evidence = ? WHERE id = ?")
          .run(FAKTALINJE_FIXTURE, JSON.stringify({ description: EXP_DESC_GENERATED_PROVENANCE_SENTINEL }), idKt6);

        // Before the homepage verifies: NOT a candidate (a non-blank,
        // non-junk description with no eligible upgrade path).
        {
          const r = await post({ ids: [idKt6] });
          assertEq(r.body.candidates, 0, "ed-k6a: an existing faktalinje row with no upgrade path is NOT re-selected");
        }

        // The provider gains a verified clean-domain homepage.
        expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
          .run("nyverifisert-fjordtur.example", verifiedFieldProvenance(), ktProviderId);

        setStub(makeStub({ generate: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: KILDETRO_FIXTURE }] }) }) }));
        setHomepageStub(makeHomepageStub(ON_TOPIC_HOMEPAGE_HTML));

        const dry = await post({ ids: [idKt6] });
        assertEq(dry.body.candidates, 1, "ed-k6b: NOW a candidate — the provider gained a verified homepage");
        assertEq(dry.body.sample[0].level, "kildetro", "ed-k6c: resolves to kildetro (upgrade), not faktalinje again");

        const apply = await post({ dry_run: false, ids: [idKt6] });
        assertEq(apply.body.written, 1, "ed-k6d: written: 1 (upgraded)");
        assertEq(descOf(idKt6), KILDETRO_FIXTURE, "ed-k6e: description replaced with the kildetro text");
        assertEq(rowOf(idKt6).content_source, "provider_site", "ed-k6f: content_source stamped on the upgrade write");
        const evidence = JSON.parse(rowOf(idKt6).content_field_evidence || "{}");
        assertEq(evidence.description, "https://nyverifisert-fjordtur.example", "ed-k6g: evidence now carries the real homepage URL, sentinel replaced");

        // ── ed-k7: an ALREADY-kildetro row (real URL in evidence) is NEVER
        //    re-selected, even though it "looks like" it has a homepage. ────
        const r2 = await post({ ids: [idKt6] });
        assertEq(r2.body.candidates, 0, "ed-k7: an already-kildetro row (real URL, not the sentinel) is never re-selected");
      }

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experience-description-enrichment (section D): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
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

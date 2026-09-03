/**
 * gardssalg-website-verification.test.ts — pure classification-logic tests
 * for dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-
 * outreach, Steg 3 ("nettside-verifisering-i-berikelse"), scoped-down slice.
 *
 * Route-level tests (GET/POST HTTP endpoints, the review-queue/field_
 * provenance/audit-table writes, dry-run-vs-apply, cohort scoping against a
 * real DB) live in
 * routes/opplevelser-gardssalg-website-verification.test.ts — this file
 * covers only the pure, DB-free classification function
 * (classifyGardssalgProducerWebsite) and its bulk/summary/plan helpers,
 * against an INJECTED fetchFn (no network, no DB) — EXCEPT section (j) below,
 * which is a small, DB-free-of-network but DB-backed unit test for
 * loadGardssalgWebsiteVerificationCohort's `cohort` SQL composition (Steg 2,
 * dev-request 2026-08-02-opplevagent-hjemmesideverifisering-og-enrichment-
 * gate): a minimal in-memory better-sqlite3 DB with only the columns that
 * query touches, no HTTP route, no fetch mocking at all.
 *
 * Realistic, varied fixture text/names deliberately used throughout (not
 * just one trivial happy-path string) — the 2026-08-01 Steg 2 incident (137
 * corrupted rows, six review rounds that never caught it) was specifically
 * an under-tested MATCHING bug, and this module's whole job is wiring calls
 * to that same underlying matcher (gardssalgWebsiteEvidenceMatch, reused
 * unchanged) without weakening its `verified` boolean via a truthy/falsy or
 * type-coercion slip. Section (g) below is a dedicated negative control for
 * exactly that.
 *
 * Run standalone: npx tsx src/services/gardssalg-website-verification.test.ts
 */

import Database from "better-sqlite3";
import {
  classifyGardssalgProducerWebsite,
  scanGardssalgWebsiteVerificationRows,
  summarizeGardssalgWebsiteVerification,
  planGardssalgWebsiteVerificationRemediation,
  loadGardssalgWebsiteVerificationCohort,
  GS_WV_COHORTS,
  type GsWvProducerRow,
  type GsWvFetchFn,
} from "./gardssalg-website-verification";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function blankProducer(overrides: Partial<GsWvProducerRow> & { id: string; navn: string }): GsWvProducerRow {
  return {
    hjemmeside: null,
    org_nr: null,
    kommune: null,
    poststed: null,
    telefon: null,
    mobil: null,
    adresse: null,
    postnummer: null,
    catalog_hidden: 0,
    ...overrides,
  };
}

export function runGardssalgWebsiteVerificationTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // ── (a) missing_source — blank hjemmeside, fetchFn never called ────────
    {
      let fetchCalls = 0;
      const neverFetch: GsWvFetchFn = async () => {
        fetchCalls++;
        return { ok: true, pageText: "should never be reached" };
      };
      const producer = blankProducer({ id: "prov-nohome", navn: "Norumbryggeriet", hjemmeside: null });
      const row = await classifyGardssalgProducerWebsite(producer, neverFetch);
      assertEq(row.classification, "missing_source", "a1: blank hjemmeside -> missing_source");
      assertEq(row.evidence, null, "a2: missing_source carries no evidence");
      assertEq(fetchCalls, 0, "a3: missing_source never touches the fetchFn");
    }

    // ── (b) aggregator — directory/DMO host, fetchFn never called ──────────
    {
      let fetchCalls = 0;
      const neverFetch: GsWvFetchFn = async () => {
        fetchCalls++;
        return { ok: true, pageText: "should never be reached" };
      };
      // hanen.no is a curated KNOWN_DIRECTORY_HOSTS entry (cross-source-
      // validator.ts) — same aggregator host the Steg 2 fixtures use.
      const producer = blankProducer({
        id: "prov-aggregator",
        navn: "Aggregatorgaarden",
        hjemmeside: "https://hanen.no/gardsutsalg/aggregatorgaarden",
      });
      const row = await classifyGardssalgProducerWebsite(producer, neverFetch);
      assertEq(row.classification, "aggregator", "b1: directory/aggregator host -> aggregator, domain alone is never fetched");
      assertEq(row.evidence, null, "b2: aggregator carries no evidence");
      assertEq(fetchCalls, 0, "b3: aggregator classification never touches the fetchFn (Funn 4 — never fetch a known directory)");
    }

    // ── (c) verified via org_nr on the page — the strongest signal ─────────
    {
      const producer = blankProducer({
        id: "prov-orgnr",
        navn: "Hebnes Vingård",
        hjemmeside: "https://hebnesvingard.no",
        org_nr: "987654321",
        kommune: "Suldal",
      });
      const fetchFn: GsWvFetchFn = async (url) => {
        assertEq(url, "https://hebnesvingard.no", "c1: fetchFn is called with the producer's stored hjemmeside");
        return {
          ok: true,
          pageText:
            "Hebnes Vingård ligger vakkert til ved Sandsfjorden i Suldal kommune. Org.nr: 987 654 321. Vi tar imot besøkende til vinsmaking hele sommeren.",
        };
      };
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "verified", "c2: org_nr found on page -> verified");
      assertTrue(!!row.evidence, "c3: verified row carries the evidence object");
      assertEq(row.evidence?.org_nr_found, true, "c4: evidence.org_nr_found is true");
      assertEq(row.evidence?.verified, true, "c5: evidence.verified is the strict boolean true");
    }

    // ── (d) unverified via fetch failure — fails INTO the conservative
    //     bucket, never throws ───────────────────────────────────────────
    {
      const producer = blankProducer({
        id: "prov-fetchfail",
        navn: "Fossmoen Frukt",
        hjemmeside: "https://fossmoenfrukt.no",
      });
      const fetchFn: GsWvFetchFn = async () => ({ ok: false, reason: "timeout" });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "unverified", "d1: fetch failure -> unverified (fail-closed), not thrown");
      assertEq(row.evidence, null, "d2: a fetch failure carries no evidence object");
    }

    // ── (e) unverified via no-evidence page text — page fetched fine but
    //     carries nothing that identifies THIS producer ────────────────────
    {
      const producer = blankProducer({
        id: "prov-noevidence",
        navn: "Ciderhuset Balestrand",
        hjemmeside: "https://ciderhusetbalestrand.no",
        kommune: "Sogndal",
        poststed: "Balestrand",
      });
      const fetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText: "Velkommen til nettbutikken vår. Vi selger sider fra hele Vestlandet. Kontakt oss for mer informasjon.",
      });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "unverified", "e1: no matching evidence on the fetched page -> unverified");
      assertTrue(!!row.evidence, "e2: unverified-but-fetched still carries the evidence object (all-false)");
      assertEq(row.evidence?.verified, false, "e3: evidence.verified is strict boolean false");
      assertEq(row.evidence?.name_found, false, "e4: producer name genuinely absent from the page text");
    }

    // ── (f) unverified via name+place match that DOESN'T meet the bar —
    //     realistic near-miss: place-name present but producer's own name
    //     absent, so the matcher must not verify on place alone ────────────
    {
      const producer = blankProducer({
        id: "prov-placeonly",
        navn: "Sagene Bryggeri",
        hjemmeside: "https://sagenebryggeri.no",
        kommune: "Oslo",
        poststed: "Oslo",
      });
      const fetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText: "Oslo er Norges hovedstad. Her finner du mange gode bryggeri og utesteder å besøke i sommer.",
      });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "unverified", "f1: place-word ('Oslo') alone, no producer name -> unverified");
      assertEq(row.evidence?.place_found, true, "f2: place IS found on the page");
      assertEq(row.evidence?.name_found, false, "f3: but the producer's own name is not, so verified stays false");
    }

    // ── (g) NEGATIVE CONTROL — a producer name containing a common Norwegian
    //     word/place-name ("Norsk", a town name), on a page that ALSO
    //     contains that common word but is genuinely about a DIFFERENT
    //     business. Sanity check: this module introduces no fuzzy-matching
    //     of its own — it only calls gardssalgWebsiteEvidenceMatch, whose own
    //     word-boundary/name-specificity rules already guard against this —
    //     but this pins that the WIRING here doesn't accidentally weaken
    //     that boolean (e.g. `if (evidence)` instead of
    //     `evidence.verified === true`, which would turn every fetched page
    //     into a false "verified"). ─────────────────────────────────────────
    {
      const producer = blankProducer({
        id: "prov-norsk-generic",
        navn: "Norsk Håndverksbryggeri",
        hjemmeside: "https://norskhandverksbryggeri.no",
        kommune: "Lillehammer",
      });
      // A page about an entirely unrelated brewery that happens to share the
      // word "norsk" and mentions Lillehammer only in passing (a shipping/
      // delivery-area blurb, not the producer's own address) — genuinely
      // no ownership evidence for prov-norsk-generic.
      const fetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText:
          "Velkommen til Fjordbrygg AS, et lite norsk bryggeri på Vestlandet. Vi leverer øl til utsalg i hele landet, inkludert Lillehammer og Trondheim.",
      });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "unverified", "g1: negative control — shared generic word/place mention alone must NOT verify");
      assertEq(row.evidence?.verified, false, "g2: gardssalgWebsiteEvidenceMatch's own boundary/specificity rules hold, unweakened by this module's wiring");
      // Sanity: place_found legitimately fires (Lillehammer really is on the
      // page) — proving the false result above is NOT because the matcher
      // saw nothing at all, but because name+place both being required
      // (name absent here) correctly held.
      assertEq(row.evidence?.place_found, true, "g3: sanity — place_found alone fires, name_found correctly does not, verified correctly stays false");
    }

    // ── (h) fetchFn throwing is treated exactly like {ok:false} — never an
    //     uncaught rejection propagating out of classify ────────────────────
    {
      const producer = blankProducer({
        id: "prov-throws",
        navn: "Klostergården Håndbryggeri",
        hjemmeside: "https://klostergarden.example.no",
      });
      const throwingFetch: GsWvFetchFn = async () => {
        throw new Error("simulated network throw");
      };
      const row = await classifyGardssalgProducerWebsite(producer, throwingFetch);
      assertEq(row.classification, "unverified", "h1: a throwing fetchFn resolves to unverified, not a rejected promise");
    }

    // ── (i) bulk scan + summary — mixed cohort ───────────────────────────
    {
      const producers: GsWvProducerRow[] = [
        blankProducer({ id: "p1", navn: "Norumbryggeriet", hjemmeside: null }),
        blankProducer({ id: "p2", navn: "Aggregatorgaarden", hjemmeside: "https://hanen.no/x" }),
        blankProducer({ id: "p3", navn: "Hebnes Vingård", hjemmeside: "https://hebnesvingard.no", org_nr: "111222333" }),
        blankProducer({ id: "p4", navn: "Fossmoen Frukt", hjemmeside: "https://fossmoenfrukt.no" }),
      ];
      const fetchFn: GsWvFetchFn = async (url) => {
        if (url === "https://hebnesvingard.no") {
          return { ok: true, pageText: "Hebnes Vingård, org.nr 111 222 333." };
        }
        return { ok: false, reason: "dns_not_found" };
      };
      const { summary, rows } = await scanGardssalgWebsiteVerificationRows(producers, fetchFn, 2);
      assertEq(rows.length, 4, "i1: one row per producer");
      assertEq(
        summary,
        // unreachable_transient added 2026-08-13 — asserted explicitly at 0
        // rather than dropped from the expectation, so this stays a full-shape
        // check: a future classification silently folding into the wrong
        // bucket must still fail here.
        { verified: 1, unverified: 1, aggregator: 1, missing_source: 1, unreachable_transient: 0, total: 4 },
        "i2: summary counts every bucket exactly once"
      );
      assertEq(summarizeGardssalgWebsiteVerification(rows), summary, "i3: summarize() re-derives the same summary from the rows alone");

      const { wouldEnqueue } = planGardssalgWebsiteVerificationRemediation(rows);
      assertEq(wouldEnqueue.length, 1, "i4: plan enqueues ONLY the unverified row");
      assertEq(wouldEnqueue[0]?.provider_id, "p4", "i5: the enqueued row is the unverified producer");
      assertTrue(
        !wouldEnqueue.some((r) => r.provider_id === "p2"),
        "i6: the aggregator row is NEVER enqueued here (that's the separate website-discovery endpoint's job)"
      );
      assertTrue(
        !wouldEnqueue.some((r) => r.provider_id === "p1"),
        "i7: the missing_source row is never enqueued either"
      );
    }

    // ── (j) cohort axis — loadGardssalgWebsiteVerificationCohort's SQL
    //     composition (Steg 2, dev-request 2026-08-02-opplevagent-
    //     hjemmesideverifisering-og-enrichment-gate). Minimal in-memory
    //     better-sqlite3 DB, only the columns this query touches — no HTTP
    //     route, no fetch mocking, no network at all. `cohort` is a SEPARATE
    //     axis from `scope`: this section only ever uses scope="visible"
    //     (the default) and varies `cohort` alone, so it can't be confused
    //     with a visibility test. ─────────────────────────────────────────
    {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE experience_providers (
          id TEXT PRIMARY KEY,
          navn TEXT,
          hjemmeside TEXT,
          org_nr TEXT,
          kommune TEXT,
          poststed TEXT,
          telefon TEXT,
          mobil TEXT,
          adresse TEXT,
          postnummer TEXT,
          catalog_hidden INTEGER,
          producer_type TEXT,
          rfb_seed_source TEXT
        );
        -- Minimal: only what the evidence_url_candidate correlated subquery
        -- (Skive 1) touches. Empty is fine — this section exercises the
        -- cohort/scope axes only, not the candidate itself.
        CREATE TABLE experiences (
          id TEXT PRIMARY KEY,
          provider_id TEXT,
          evidence_url TEXT
        );
      `);
      const insert = db.prepare(
        `INSERT INTO experience_providers (id, navn, catalog_hidden, producer_type, rfb_seed_source)
         VALUES (@id, @navn, @catalog_hidden, @producer_type, @rfb_seed_source)`
      );
      // a: a normal gårdssalg producer (producer_type set) — in BOTH cohorts.
      insert.run({ id: "a-gardssalg", navn: "A Gaard", catalog_hidden: 0, producer_type: "bryggeri", rfb_seed_source: null });
      // b: an rfb-seed row with no producer_type — the OTHER leg of the
      // gårdssalg OR-clause — also in BOTH cohorts.
      insert.run({ id: "b-rfbseed", navn: "B Seed", catalog_hidden: 0, producer_type: null, rfb_seed_source: "rfb-seed" });
      // c: producer_type IS NULL AND rfb_seed_source != 'rfb-seed' — exactly
      // the shape the gårdssalg cohort EXCLUDES today, and cohort=all must
      // newly INCLUDE.
      insert.run({ id: "c-outside-gardssalg", navn: "C Outside", catalog_hidden: 0, producer_type: null, rfb_seed_source: "manual" });
      // d: the synthetic test-gardssalg fixture row — must be excluded from
      // BOTH cohorts (unconditional exclusion, unrelated to which cohort is
      // selected).
      insert.run({ id: "d-test-gardssalg", navn: "TEST — Ikke book", catalog_hidden: 0, producer_type: "test-gardssalg", rfb_seed_source: null });
      // e: producer_type IS NULL AND rfb_seed_source IS NULL (both blank —
      // the ordinary shape of a generic, non-gårdssalg provider; c above only
      // covers rfb_seed_source SET to a non-'rfb-seed' value, not NULL). This
      // is the exact row shape that a naive `NOT (gårdssalg predicate)`
      // negation would silently drop via SQL three-valued logic (see
      // GS_WV_NON_GARDSSALG_PRODUCER_TYPE_SQL's own doc comment) — load-
      // bearing for j7 below.
      insert.run({ id: "e-generic-both-null", navn: "E Generic", catalog_hidden: 0, producer_type: null, rfb_seed_source: null });

      const defaultCohort = loadGardssalgWebsiteVerificationCohort(db, "visible");
      assertEq(
        defaultCohort.map((r) => r.id),
        ["a-gardssalg", "b-rfbseed"],
        "j1: cohort omitted entirely defaults to 'gardssalg' — same two rows as explicitly passing it"
      );

      const explicitGardssalg = loadGardssalgWebsiteVerificationCohort(db, "visible", "gardssalg");
      assertEq(
        explicitGardssalg.map((r) => r.id),
        ["a-gardssalg", "b-rfbseed"],
        "j2: cohort='gardssalg' explicit — excludes both the outside row and the test-gardssalg row"
      );
      assertEq(defaultCohort, explicitGardssalg, "j3: omitting cohort is byte-for-byte identical to passing 'gardssalg' explicitly");

      const allCohort = loadGardssalgWebsiteVerificationCohort(db, "visible", "all");
      assertEq(
        allCohort.map((r) => r.id),
        ["a-gardssalg", "b-rfbseed", "c-outside-gardssalg", "e-generic-both-null"],
        "j4: cohort='all' widens to include both producer_type-IS-NULL rows the gårdssalg cohort excluded, regardless of rfb_seed_source"
      );
      assertTrue(
        !allCohort.some((r) => r.id === "d-test-gardssalg"),
        "j5: the synthetic test-gardssalg row stays excluded even under cohort='all' — that exclusion is unconditional"
      );

      // ── non_gardssalg — the exact complement of 'gardssalg' (dev-request
      //    2026-08-14-exp-website-verification-stamp) ────────────────────────
      const nonGardssalgCohort = loadGardssalgWebsiteVerificationCohort(db, "visible", "non_gardssalg");
      assertEq(
        nonGardssalgCohort.map((r) => r.id).sort(),
        ["c-outside-gardssalg", "e-generic-both-null"],
        "j7: cohort='non_gardssalg' contains exactly the two rows outside the gårdssalg predicate, INCLUDING the rfb_seed_source-IS-NULL " +
          "shape a naive `NOT(...)` negation would have dropped via SQL three-valued logic"
      );
      assertTrue(
        !nonGardssalgCohort.some((r) => r.id === "a-gardssalg" || r.id === "b-rfbseed"),
        "j8: neither gårdssalg-cohort row (producer_type set, or rfb_seed_source='rfb-seed') leaks into non_gardssalg"
      );
      assertTrue(
        !nonGardssalgCohort.some((r) => r.id === "d-test-gardssalg"),
        "j9: the synthetic test-gardssalg row is excluded from non_gardssalg too (producer_type is set, so the predicate alone excludes it)"
      );
      // gardssalg and non_gardssalg are a strict partition of (all minus the
      // synthetic test row): together they reproduce cohort='all' exactly,
      // with zero overlap and zero omission.
      const unionIds = [...explicitGardssalg.map((r) => r.id), ...nonGardssalgCohort.map((r) => r.id)].sort();
      assertEq(
        unionIds,
        [...allCohort.map((r) => r.id)].sort(),
        "j10: gardssalg ∪ non_gardssalg == all (a strict partition, no double-count, no gap)"
      );

      assertEq(
        GS_WV_COHORTS,
        ["gardssalg", "all", "non_gardssalg"],
        "j6: GS_WV_COHORTS lists exactly the three valid values, gardssalg first (the default)"
      );

      db.close();
    }

    // ── (j2) Skive 1 — loadGardssalgWebsiteVerificationCohort's
    //     evidence_url_candidate SQL fragment itself (the copy of
    //     selectProvidersForContentRefresh's own COALESCE fragment). A
    //     separate minimal in-memory DB (this one needs real `experiences`
    //     rows, section (j)'s fixture deliberately left that table empty). ──
    {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE experience_providers (
          id TEXT PRIMARY KEY,
          navn TEXT,
          hjemmeside TEXT,
          org_nr TEXT,
          kommune TEXT,
          poststed TEXT,
          telefon TEXT,
          mobil TEXT,
          adresse TEXT,
          postnummer TEXT,
          catalog_hidden INTEGER,
          producer_type TEXT,
          rfb_seed_source TEXT
        );
        CREATE TABLE experiences (
          id TEXT PRIMARY KEY,
          provider_id TEXT,
          evidence_url TEXT
        );
      `);
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers (id, navn, hjemmeside, catalog_hidden, producer_type)
         VALUES (@id, @navn, @hjemmeside, 0, 'bryggeri')`
      );
      const insertExperience = db.prepare(
        `INSERT INTO experiences (id, provider_id, evidence_url) VALUES (@id, @provider_id, @evidence_url)`
      );

      // p1: blank hjemmeside, ONE experience with a non-empty evidence_url
      // -> candidate surfaced.
      insertProvider.run({ id: "p1-blank-with-evidence", navn: "P1", hjemmeside: null });
      insertExperience.run({ id: "e1", provider_id: "p1-blank-with-evidence", evidence_url: "  https://p1-listing.example.no  " });

      // p2: blank hjemmeside, but the only experience's evidence_url is
      // blank/whitespace-only -> COALESCE finds nothing, candidate stays null
      // (same TRIM/non-empty guard as the own-column check).
      insertProvider.run({ id: "p2-blank-no-usable-evidence", navn: "P2", hjemmeside: null });
      insertExperience.run({ id: "e2", provider_id: "p2-blank-no-usable-evidence", evidence_url: "   " });

      // p3: blank hjemmeside, no experiences rows at all.
      insertProvider.run({ id: "p3-blank-no-experiences", navn: "P3", hjemmeside: null });

      // p4: own hjemmeside IS set — evidence_url_candidate is still computed
      // (the SQL doesn't gate on hjemmeside being blank, classify() does),
      // but must be exactly the same value the fragment would produce
      // regardless — just proving the column always reflects the real data,
      // not a null forced by the presence of hjemmeside.
      insertProvider.run({ id: "p4-ownsite-still-has-evidence", navn: "P4", hjemmeside: "https://p4-ownsite.example.no" });
      insertExperience.run({ id: "e4", provider_id: "p4-ownsite-still-has-evidence", evidence_url: "https://p4-listing.example.no" });

      const rows = loadGardssalgWebsiteVerificationCohort(db, "visible", "gardssalg");
      const byId = new Map(rows.map((r) => [r.id, r]));

      assertEq(
        byId.get("p1-blank-with-evidence")?.evidence_url_candidate,
        "https://p1-listing.example.no",
        "j2-1: TRIM'd, non-empty evidence_url surfaces as the candidate"
      );
      assertEq(
        byId.get("p2-blank-no-usable-evidence")?.evidence_url_candidate,
        null,
        "j2-2: a whitespace-only evidence_url is treated as absent, same TRIM/non-empty guard as the own-column check"
      );
      assertEq(
        byId.get("p3-blank-no-experiences")?.evidence_url_candidate,
        null,
        "j2-3: no experiences rows at all -> candidate is null, not an error"
      );
      assertEq(
        byId.get("p4-ownsite-still-has-evidence")?.evidence_url_candidate,
        "https://p4-listing.example.no",
        "j2-4: the column is populated even when hjemmeside is already set — classify() is what decides whether to use it, not this query"
      );

      db.close();
    }

    // ═══ AC4 (dev-request 2026-08-02-enrichment-kadens-og-kildekvalitet) —
    //     <title> as a corroborating signal ══════════════════════════════════
    //
    // Incident: 7 of 9 sibling-TLD candidate homepages (guessed producer.com
    // when producer.no was dead) were WRONG — squatted domains, unrelated
    // organisations (a regional council, a town-centre association, an
    // unrelated foreign company) — yet all 7 passed the existing body-text
    // name/place checks because a stray mention of the producer's name and
    // kommune is exactly the kind of thing that turns up on an unrelated
    // page (directories, council minutes, town-association member lists…).
    // None of the 7 ever carried the producer's brand in their <title>.
    //
    // (k) — ZERO REGRESSION: org_nr or phone present, title absent/wrong —
    //     still verifies. Proves the two strong-signal branches never look
    //     at title_found at all. ────────────────────────────────────────────
    {
      // org_nr branch: title is present but is a squatted/unrelated page —
      // must not matter, org_nr alone still verifies.
      const orgProducer = blankProducer({
        id: "prov-title-orgnr",
        navn: "Fjordgard Sideri",
        hjemmeside: "https://fjordgardsideri.no",
        org_nr: "918273645",
        kommune: "Ulvik",
      });
      const orgFetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText: "Org.nr: 918 273 645. Denne siden driftes av Setesdal Regionråd.",
        title: "Setesdal Regionråd — offisiell side",
      });
      const orgRow = await classifyGardssalgProducerWebsite(orgProducer, orgFetchFn);
      assertEq(orgRow.classification, "verified", "k1: org_nr found despite a squatted/unrelated title -> still verified");
      assertEq(orgRow.evidence?.org_nr_found, true, "k2: org_nr_found true");
      assertEq(orgRow.evidence?.title_found, false, "k3: title_found correctly false (title has nothing to do with the producer)");
      assertEq(orgRow.evidence?.verified, true, "k4: org_nr branch verifies regardless of title_found");

      // phone branch: title is entirely absent (no <title> tag at all) —
      // must not matter, phone+name alone still verifies.
      const phoneProducer = blankProducer({
        id: "prov-title-phone",
        navn: "Fjordgard Sideri",
        hjemmeside: "https://fjordgardsideri.no",
        telefon: "912 34 567",
      });
      const phoneFetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText: "Velkommen til Fjordgard Sideri. Ring oss: +47 912 34 567.",
        title: "",
      });
      const phoneRow = await classifyGardssalgProducerWebsite(phoneProducer, phoneFetchFn);
      assertEq(phoneRow.classification, "verified", "k5: phone+name found, no title at all -> still verified");
      assertEq(phoneRow.evidence?.phone_found, true, "k6: phone_found true");
      assertEq(phoneRow.evidence?.title_found, false, "k7: title_found correctly false (no title text to match)");
      assertEq(phoneRow.evidence?.verified, true, "k8: phone branch verifies regardless of title_found");
    }

    // (l) — the exact incident shape: name+place-only body-text hits (no
    //     org_nr, no phone — the weakest branch), squatted/unrelated
    //     <title> — now correctly REJECTED where it used to false-positive. ─
    {
      const producer = blankProducer({
        id: "prov-title-squat",
        navn: "Fjordgard Sideri",
        hjemmeside: "https://fjordgardsideri.com",
        kommune: "Ulvik",
      });
      const fetchFn: GsWvFetchFn = async () => ({
        ok: true,
        // The producer's name and kommune both appear — but only as a stray
        // mention (a council minutes/member-list style page), exactly the
        // shape that produced the 7 false positives in the incident.
        pageText:
          "Fjordgard Sideri i Ulvik er nevnt i sakslisten. Denne siden tilhører Setesdal Regionråd og dekker regionens fellesoppgaver.",
        title: "Setesdal Regionråd — sakspapirer og møtereferat",
      });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.evidence?.name_found, true, "l1: sanity — the producer's name IS a stray hit in the body text");
      assertEq(row.evidence?.place_found, true, "l2: sanity — the kommune IS a stray hit in the body text");
      assertEq(row.evidence?.title_found, false, "l3: the squatted/unrelated title never carries the producer's brand");
      assertEq(row.evidence?.verified, false, "l4: name+place alone (no org_nr, no phone) no longer verifies without a matching title");
      assertEq(row.classification, "unverified", "l5: classifies as unverified — exactly the incident's 7 false positives, now caught");
    }

    // (m) — same shape as (l), but the <title> genuinely carries the
    //     producer's own name — correctly ACCEPTED. ─────────────────────────
    {
      const producer = blankProducer({
        id: "prov-title-match",
        navn: "Fjordgard Sideri",
        hjemmeside: "https://fjordgardsideri.no",
        kommune: "Ulvik",
      });
      const fetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText: "Velkommen til Fjordgard Sideri, en gård i Ulvik med lange tradisjoner for sider.",
        title: "Fjordgard Sideri — velkommen til gården vår",
      });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.evidence?.name_found, true, "m1: name found in body text");
      assertEq(row.evidence?.place_found, true, "m2: place found in body text");
      assertEq(row.evidence?.title_found, true, "m3: the producer's own name IS in the title this time");
      assertEq(row.evidence?.verified, true, "m4: name+place+matching title verifies");
      assertEq(row.classification, "verified", "m5: classifies as verified");
    }

    // ── (t) transient unreachability is NOT a verdict ─────────────────────
    //
    // Daniel, live session 2026-08-13. Measured on the remediation run over
    // the 15 `nettsted_uverifisert` rows: Tromsø Mikrobryggeri's
    // `bryggeri13.no` answered HTTP 5xx and was durably stamped
    // hjemmeside_verification={verified:false} — a pure network blip recorded
    // permanently as "this is not the producer's website".
    //
    // The invariant: only `persistence:"transient"` is exempt. A dead domain
    // IS a statement about the stored URL and must keep collapsing into
    // `unverified` so it gets queued for review.
    {
      const producer = blankProducer({
        id: "p-transient",
        navn: "Tromsø Mikrobryggeri",
        org_nr: "915180329",
        hjemmeside: "https://bryggeri13.no",
        kommune: "Tromsø",
      });

      const transient: GsWvFetchFn = async () => ({ ok: false, reason: "http_5xx", persistence: "transient" });
      const rowTransient = await classifyGardssalgProducerWebsite(producer, transient);
      assertEq(
        rowTransient.classification,
        "unreachable_transient",
        "t1: a transient 5xx classifies as unreachable_transient, NOT as a negative verdict",
      );
      assertEq(rowTransient.evidence, null, "t2: no evidence object is invented for a page we never read");

      const permanent: GsWvFetchFn = async () => ({ ok: false, reason: "dns_not_found", persistence: "permanent" });
      assertEq(
        (await classifyGardssalgProducerWebsite(producer, permanent)).classification,
        "unverified",
        "t3: a PERMANENT failure (dead domain) still classifies as unverified — it IS a statement about the stored URL",
      );

      const blocked: GsWvFetchFn = async () => ({ ok: false, reason: "http_401", persistence: "blocked" });
      assertEq(
        (await classifyGardssalgProducerWebsite(producer, blocked)).classification,
        "unverified",
        "t4: a BLOCKED failure (login wall) still classifies as unverified",
      );

      // The safe default: an adapter that does not report persistence must
      // keep the old fail-closed behaviour rather than silently earning the
      // exemption.
      const noPersistence: GsWvFetchFn = async () => ({ ok: false, reason: "fetch_threw" });
      assertEq(
        (await classifyGardssalgProducerWebsite(producer, noPersistence)).classification,
        "unverified",
        "t5: a fetchFn that reports no persistence stays fail-closed as unverified",
      );

      // Summary must count the new class, and must NOT fold it into unverified.
      const scanned = await scanGardssalgWebsiteVerificationRows([producer], transient, 1);
      assertEq(scanned.summary.unreachable_transient, 1, "t6: the summary counts unreachable_transient");
      assertEq(scanned.summary.unverified, 0, "t7: unreachable_transient is NOT counted as unverified");

      // The review queue exists to fix bad URLs. A site that was merely down
      // has no URL to fix, so it must not be queued.
      const planned = planGardssalgWebsiteVerificationRemediation(scanned.rows);
      assertEq(planned.wouldEnqueue.length, 0, "t8: an unreachable_transient row is never queued for URL review");
    }

    // ═══ Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-
    //     render, Funn 1) — evidence_url-promotion, classification level.
    //     GsWvProducerRow.evidence_url_candidate is set directly here rather
    //     than via a real DB query — loadGardssalgWebsiteVerificationCohort's
    //     own SQL fragment is exercised separately (it is copied verbatim
    //     from selectProvidersForContentRefresh's own COALESCE fragment, and
    //     that fragment already has its own coverage in experience-store's
    //     tests); this section covers ONLY what classifyGardssalgProducer
    //     Website does once a candidate is handed to it. ══════════════════

    // ── (u) Rule 1 — blank hjemmeside AND no candidate at all: unchanged
    //     behavior, identical to (a) above but pinned again here so this
    //     whole Skive-1 block reads standalone. ──────────────────────────
    {
      let fetchCalls = 0;
      const neverFetch: GsWvFetchFn = async () => {
        fetchCalls++;
        return { ok: true, pageText: "should never be reached" };
      };
      const producer = blankProducer({
        id: "prov-evurl-nocandidate",
        navn: "Steinbekk Bryggeri",
        hjemmeside: null,
        evidence_url_candidate: null,
      });
      const row = await classifyGardssalgProducerWebsite(producer, neverFetch);
      assertEq(row.classification, "missing_source", "u1: blank hjemmeside + no candidate -> missing_source, unchanged");
      assertEq(row.evidence, null, "u2: no evidence object");
      assertEq(row.promoted_from_evidence_url, undefined, "u3: no promotion marker");
      assertEq(fetchCalls, 0, "u4: fetchFn never touched");
    }

    // ── (v) Rule 2 — candidate resolves to a directory/aggregator host:
    //     never fetched, stays missing_source (NOT "aggregator" — the
    //     producer's OWN hjemmeside really is still blank). ──────────────
    {
      let fetchCalls = 0;
      const neverFetch: GsWvFetchFn = async () => {
        fetchCalls++;
        return { ok: true, pageText: "should never be reached" };
      };
      const producer = blankProducer({
        id: "prov-evurl-aggregator",
        navn: "Lyngheim Gård",
        hjemmeside: null,
        evidence_url_candidate: "https://hanen.no/gardsutsalg/lyngheim",
      });
      const row = await classifyGardssalgProducerWebsite(producer, neverFetch);
      assertEq(row.classification, "missing_source", "v1: aggregator-hosted candidate -> missing_source, never 'aggregator'");
      assertEq(row.evidence, null, "v2: no evidence object");
      assertEq(row.promoted_from_evidence_url, undefined, "v3: no promotion marker");
      assertEq(fetchCalls, 0, "v4: aggregator/directory candidate host is NEVER fetched (Funn 4, same principle as own-hjemmeside)");
    }

    // ── (w) Rule 3, fetch-failure leg — candidate exists, fetch fails ->
    //     NOTHING happens: missing_source, deliberately NOT unverified. ──
    {
      const producer = blankProducer({
        id: "prov-evurl-fetchfail",
        navn: "Kalvtjern Sideri",
        hjemmeside: null,
        evidence_url_candidate: "https://kalvtjernsideri-experience-listing.example.no",
      });
      const fetchFn: GsWvFetchFn = async () => ({ ok: false, reason: "timeout" });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "missing_source", "w1: candidate fetch failure -> missing_source, NOT unverified");
      assertEq(row.evidence, null, "w2: no evidence object");
      assertEq(row.promoted_from_evidence_url, undefined, "w3: no promotion marker");
      assertEq(row.hjemmeside, null, "w4: hjemmeside stays null on the row itself");

      // Deliberately NOT enqueued — an unverified own-hjemmeside row queues
      // for review, but a random fallback candidate that couldn't even be
      // fetched does not deserve one (only a producer's own declared,
      // non-matching hjemmeside does).
      const { wouldEnqueue } = planGardssalgWebsiteVerificationRemediation([row]);
      assertEq(wouldEnqueue.length, 0, "w5: a failed-candidate missing_source row is never queued for review");
    }

    // ── (x) Rule 3, evidence-mismatch leg — candidate fetched fine but
    //     names nobody related to this producer -> still missing_source,
    //     still not enqueued. ─────────────────────────────────────────────
    {
      const producer = blankProducer({
        id: "prov-evurl-nomatch",
        navn: "Kalvtjern Sideri",
        hjemmeside: null,
        kommune: "Nes",
        evidence_url_candidate: "https://en-helt-annen-side.example.no",
      });
      const fetchFn: GsWvFetchFn = async () => ({
        ok: true,
        pageText: "Velkommen til vår nettbutikk. Vi selger håndverksprodukter fra hele landet.",
      });
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "missing_source", "x1: candidate fetched, no evidence match -> missing_source, NOT unverified");
      assertEq(row.promoted_from_evidence_url, undefined, "x2: no promotion marker");
      assertEq(row.hjemmeside, null, "x3: hjemmeside stays null on the row itself");

      const { wouldEnqueue } = planGardssalgWebsiteVerificationRemediation([row]);
      assertEq(wouldEnqueue.length, 0, "x4: a non-matching candidate is never queued for review either");
    }

    // ── (y) Rule 4 — candidate fetched AND verified: promotion. ─────────
    {
      const producer = blankProducer({
        id: "prov-evurl-promoted",
        navn: "Kalvtjern Sideri",
        hjemmeside: null,
        org_nr: "934567123",
        kommune: "Nes",
        evidence_url_candidate: "https://kalvtjernsideri.example.no/om-oss",
      });
      const fetchFn: GsWvFetchFn = async (url) => {
        assertEq(url, "https://kalvtjernsideri.example.no/om-oss", "y1: fetchFn is called with the CANDIDATE url, not any own-hjemmeside");
        return {
          ok: true,
          pageText: "Kalvtjern Sideri holder til i Nes. Org.nr: 934 567 123. Velkommen til gårdsbutikken vår.",
        };
      };
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(row.classification, "verified", "y2: matching evidence on the candidate -> verified");
      assertEq(row.hjemmeside, "https://kalvtjernsideri.example.no/om-oss", "y3: row.hjemmeside carries the candidate through");
      assertEq(
        row.promoted_from_evidence_url,
        "https://kalvtjernsideri.example.no/om-oss",
        "y4: promoted_from_evidence_url carries the exact candidate URL for applyGardssalgWebsiteVerification"
      );
      assertTrue(!!row.evidence, "y5: verified row carries the evidence object");
      assertEq(row.evidence?.org_nr_found, true, "y6: evidence.org_nr_found is true");
    }

    // ── (z) sanity — a producer whose OWN hjemmeside is set (non-blank)
    //     must NEVER be promoted even if evidence_url_candidate happens to
    //     be populated on the row: classifyGardssalgProducerWebsite only
    //     ever consults the candidate on the blank-hjemmeside branch. ────
    {
      const producer = blankProducer({
        id: "prov-evurl-ownsite-wins",
        navn: "Kalvtjern Sideri",
        hjemmeside: "https://kalvtjernsideri.no",
        org_nr: "934567123",
        evidence_url_candidate: "https://some-other-experience-listing.example.no",
      });
      let fetchedUrl: string | null = null;
      const fetchFn: GsWvFetchFn = async (url) => {
        fetchedUrl = url;
        return { ok: true, pageText: "Kalvtjern Sideri. Org.nr 934 567 123." };
      };
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(fetchedUrl, "https://kalvtjernsideri.no", "z1: the OWN hjemmeside is fetched, never the candidate, when hjemmeside is set");
      assertEq(row.classification, "verified", "z2: own-hjemmeside verification unaffected by an unrelated candidate field");
      assertEq(row.promoted_from_evidence_url, undefined, "z3: no promotion marker on an own-hjemmeside verification");
    }

    // ═══ PR #774 review fix — `candidateHost` must come from the page
    //     actually FETCHED (fetched.finalUrl), not the producer's own
    //     pre-fetch claimed URL. Before this fix, both call sites passed the
    //     pre-fetch `host` (hostFromUrlLike(hjemmeside) / …(candidate)) into
    //     gardssalgWebsiteEvidenceMatch's 4th argument — nearly tautological
    //     domain corroboration, and on a parked/expired domain whose
    //     auto-generated <title> happens to mention the producer's name,
    //     could wrongly verify. All three fixtures below reuse the exact
    //     "Austmann" prefix-token+title shape wd-29a already proves verifies
    //     when title+domain corroborate — the only thing that varies is
    //     which host reaches the corroboration check. ═══════════════════════
    {
      const austmannTarget = {
        id: "prov-candidatehost-crosshost",
        navn: "Austmann Bryggeri",
        hjemmeside: "https://austmann.no",
      };
      const austmannPageText = "Velkommen til Austmann. Vi lager håndverksøl.";
      const austmannTitle = "Austmann – bryggeri i Norge";

      // ── (aa) cross-host redirect / parked-domain scenario: the producer's
      //     OWN declared hjemmeside host ("austmann.no") DOES contain the
      //     prefix token — using it (the pre-fix bug) would incorrectly
      //     verify, exactly like wd-29a. The page actually fetched, though,
      //     redirected to an unrelated parked host that does NOT contain the
      //     token — the fix must use THAT host and come out unverified. ────
      {
        const producer = blankProducer(austmannTarget);
        const fetchFn: GsWvFetchFn = async () => ({
          ok: true,
          pageText: austmannPageText,
          title: austmannTitle,
          finalUrl: "https://totally-unrelated-parked-domain.example",
        });
        const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
        assertEq(
          row.classification,
          "unverified",
          "aa1: post-fetch host (parked domain) does NOT corroborate the prefix token -> unverified, even though the " +
            "pre-fetch declared host (austmann.no) would have incorrectly verified this exact fixture (see wd-29a)"
        );
        assertEq(row.evidence?.prefix_token_found, false, "aa2: the new branch itself does not fire once the correct host is used");
      }

      // ── (bb) mirror case — finalUrl legitimately resolves to the SAME
      //     host as the pre-fetch declared URL (no redirect, or a same-host
      //     redirect): verification behavior is unchanged from before this
      //     fix — still verifies via prefix+title+domain. ──────────────────
      {
        const producer = blankProducer(austmannTarget);
        const fetchFn: GsWvFetchFn = async () => ({
          ok: true,
          pageText: austmannPageText,
          title: austmannTitle,
          finalUrl: "https://austmann.no/",
        });
        const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
        assertEq(row.classification, "verified", "bb1: finalUrl on the same host as before -> verification unchanged, still verified");
        assertEq(row.evidence?.prefix_token_found, true, "bb2: domain corroboration still fires against the (same) fetched host");
      }

      // ── (cc) regression — a simpler/older mock fetchFn that does not set
      //     finalUrl at all: must fall back BYTE-FOR-BYTE to the old
      //     pre-fetch `host`, so nothing existing breaks. ──────────────────
      {
        const producer = blankProducer(austmannTarget);
        const fetchFn: GsWvFetchFn = async () => ({
          ok: true,
          pageText: austmannPageText,
          title: austmannTitle,
          // no finalUrl
        });
        const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
        assertEq(
          row.classification,
          "verified",
          "cc1: fetchFn that never sets finalUrl falls back to the pre-fetch host -> same outcome as before this fix"
        );
        assertEq(row.evidence?.prefix_token_found, true, "cc2: domain corroboration still fires via the fallback host");
      }
    }

    // ═══ PR #774 review fix, evidence_url-candidate leg — the same
    //     cross-host defect is more serious here: a false `verified` sets
    //     `promoted_from_evidence_url`, which applyGardssalgWebsiteVerification
    //     WRITES into the producer's real hjemmeside column (a data-integrity
    //     issue, not just a miscategorization). ═══════════════════════════
    {
      // ── (dd) candidate URL's own host contains the prefix token (would
      //     incorrectly promote under the pre-fix bug), but the page
      //     actually fetched redirected to an unrelated parked host ->
      //     must stay missing_source, never promoted. ─────────────────────
      const producer = blankProducer({
        id: "prov-evurl-candidatehost-crosshost",
        navn: "Austmann Bryggeri",
        hjemmeside: null,
        evidence_url_candidate: "https://austmann.no/om-oss",
      });
      const fetchFn: GsWvFetchFn = async (url) => {
        assertEq(url, "https://austmann.no/om-oss", "dd1: fetchFn is called with the candidate url");
        return {
          ok: true,
          pageText: "Velkommen til Austmann. Vi lager håndverksøl.",
          title: "Austmann – bryggeri i Norge",
          finalUrl: "https://totally-unrelated-parked-domain.example",
        };
      };
      const row = await classifyGardssalgProducerWebsite(producer, fetchFn);
      assertEq(
        row.classification,
        "missing_source",
        "dd2: post-fetch host does not corroborate -> missing_source, NOT verified (the candidate host alone would have incorrectly promoted)"
      );
      assertEq(row.promoted_from_evidence_url, undefined, "dd3: no promotion marker — nothing gets written to hjemmeside");
    }
  })().then(() => ({ passed, failed, failures }));
}

// Standalone runner: `npx tsx src/services/gardssalg-website-verification.test.ts`
if (require.main === module) {
  runGardssalgWebsiteVerificationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

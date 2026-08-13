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
        ["a-gardssalg", "b-rfbseed", "c-outside-gardssalg"],
        "j4: cohort='all' widens to include the producer_type-IS-NULL/non-rfb-seed row the gårdssalg cohort excluded"
      );
      assertTrue(
        !allCohort.some((r) => r.id === "d-test-gardssalg"),
        "j5: the synthetic test-gardssalg row stays excluded even under cohort='all' — that exclusion is unconditional"
      );

      assertEq(GS_WV_COHORTS, ["gardssalg", "all"], "j6: GS_WV_COHORTS lists exactly the two valid values, gardssalg first (the default)");

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
  })().then(() => ({ passed, failed, failures }));
}

// Standalone runner: `npx tsx src/services/gardssalg-website-verification.test.ts`
if (require.main === module) {
  runGardssalgWebsiteVerificationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

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
 * against an INJECTED fetchFn (no network, no DB).
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

import {
  classifyGardssalgProducerWebsite,
  scanGardssalgWebsiteVerificationRows,
  summarizeGardssalgWebsiteVerification,
  planGardssalgWebsiteVerificationRemediation,
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
        { verified: 1, unverified: 1, aggregator: 1, missing_source: 1, total: 4 },
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
  })().then(() => ({ passed, failed, failures }));
}

// Standalone runner: `npx tsx src/services/gardssalg-website-verification.test.ts`
if (require.main === module) {
  runGardssalgWebsiteVerificationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

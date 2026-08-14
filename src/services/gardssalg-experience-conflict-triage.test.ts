/**
 * gardssalg-experience-conflict-triage.test.ts — pure classification-logic
 * tests for dev-request 2026-08-14-dublett-auto-triage (DRY-RUN / REPORT
 * ONLY slice — no write path exists anywhere in this slice; see
 * routes/opplevelser.ts's GET /admin/gardssalg-experience-conflict-auto-
 * triage doc comment).
 *
 * Covers classifyGardssalgExperienceConflictPair() end-to-end against
 * synthetic (already-fetched/matched) side inputs — no network, no DB, fully
 * synchronous. Route-level tests (the real HTTP endpoint, live-fetch mocking,
 * DB-backed pair loading via the existing conflict-queue machinery) live in
 * routes/opplevelser-gardssalg-experience-conflict-triage.test.ts.
 *
 * Every mandatory case from the dev-request spec is covered:
 *   (a) transient fetch outcome on EITHER side forces "pending", even when
 *       the OTHER side shows a strong (org_nr match / domain match) signal —
 *       the non-negotiable override, tested from both sides independently
 *   (b) auto_confirm via matching org.nr found+confirmed on both pages
 *   (c) auto_confirm via matching registered domain on both sides
 *   (d) auto_reject via clearly distinct org.nr, both present + page-confirmed
 *   (e) pending via weak/missing signal on either side
 *   (f) name-token overlap ALONE (no org.nr, no domain match) is NOT
 *       sufficient for auto_confirm — falls through to pending
 * plus supporting coverage: domain-distinct-but-name-overlaps stays pending
 * (not auto_reject), domain match overrides an org_nr mismatch that never
 * got page-confirmed, and confidence/sort ordering.
 *
 * Run standalone: npx tsx src/services/gardssalg-experience-conflict-triage.test.ts
 */

import {
  classifyGardssalgExperienceConflictPair,
  hasNameTokenSupport,
  sortByConfidenceDesc,
  type GsExpTriageSide,
  type GsExpTriagePairInput,
  type GsExpTriageEvidence,
} from "./gardssalg-experience-conflict-triage";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Full-false evidence baseline — overriding only the fields a fixture cares
// about keeps each test's intent legible (which signal(s) fired) instead of
// re-stating every field every time.
function evidence(overrides: Partial<GsExpTriageEvidence> = {}): GsExpTriageEvidence {
  return {
    org_nr_found: false,
    name_found: false,
    place_found: false,
    phone_found: false,
    address_found: false,
    postnr_found: false,
    title_found: false,
    verified: false,
    ...overrides,
  };
}

function side(overrides: Partial<GsExpTriageSide> = {}): GsExpTriageSide {
  return {
    fetch_ok: true,
    persistence: null,
    org_nr: null,
    domain: null,
    evidence: null,
    ...overrides,
  };
}

export function runGardssalgExperienceConflictTriageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    try {
      // ── (a) TRANSIENT OVERRIDE — mandatory case, from BOTH directions ────
      //
      // a1: producer side transient, experience side shows a STRONG signal
      // (matching, page-confirmed org.nr AND matching domain — either alone
      // would auto_confirm) — must still be "pending", never auto_confirm.
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Austmann Bryggeri",
          experience_name: "Austmann Bryggeri Omvisning",
          producer: side({ fetch_ok: false, persistence: "transient", org_nr: "912345678", domain: "austmann.no" }),
          experience: side({
            org_nr: "912345678",
            domain: "austmann.no",
            evidence: evidence({ org_nr_found: true, verified: true }),
          }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "pending", "a1: transient fetch on the PRODUCER side forces pending despite org_nr+domain match on the experience side");
        assertTrue(result.reasons.includes("transient_fetch_forces_pending"), "a1b: reason names the transient override");
      }

      // a2: same, but the transient side is the EXPERIENCE — must also force
      // pending, proving the override is symmetric, not producer-only.
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Austmann Bryggeri",
          experience_name: "Austmann Bryggeri Omvisning",
          producer: side({
            org_nr: "912345678",
            domain: "austmann.no",
            evidence: evidence({ org_nr_found: true, verified: true }),
          }),
          experience: side({ fetch_ok: false, persistence: "transient", org_nr: "912345678", domain: "austmann.no" }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "pending", "a2: transient fetch on the EXPERIENCE side ALSO forces pending, symmetric with a1");
        assertTrue(result.reasons.includes("transient_fetch_forces_pending"), "a2b: reason names the transient override");
      }

      // a3: transient + a strong DOMAIN-only match on the other side (no
      // org.nr at all in play) — still pending, confirming the override is
      // not merely "beats org_nr" but genuinely unconditional.
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Lyngstad Gårdsutsalg",
          experience_name: "Lyngstad Gårdsutsalg Sesong",
          producer: side({ domain: "lyngstad.no", evidence: evidence({ name_found: true }) }),
          experience: side({ fetch_ok: false, persistence: "transient", domain: "lyngstad.no" }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "pending", "a3: transient + domain-only match elsewhere -> still pending, not auto_confirm");
      }

      // ── (b) auto_confirm via org.nr — both sides show the SAME org.nr,
      //     each independently page-confirmed. Domains deliberately DIFFERENT
      //     so this isolates the org.nr rule from the domain rule. ──────────
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Kanelbakken Bryggeri",
          experience_name: "Kanelbakken Fjordcruise",
          producer: side({
            org_nr: "211111111",
            domain: "kanelbakken.no",
            evidence: evidence({ org_nr_found: true, verified: true }),
          }),
          experience: side({
            org_nr: "211111111",
            domain: "fjordtur.example",
            evidence: evidence({ org_nr_found: true, verified: true }),
          }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "auto_confirm", "b1: same org.nr, page-confirmed on both sides, different domains -> auto_confirm");
        assertTrue(result.reasons.includes("org_nr_match_both_sides"), "b2: reason names the org_nr match");
        assertTrue(!result.reasons.includes("domain_match_both_sides"), "b3: domain reason is NOT present (domains differ here)");
      }

      // b4: same org.nr VALUES on both DB rows, but the page evidence never
      // actually confirmed it on one side — must NOT auto_confirm on org_nr
      // alone (a DB-row coincidence is not page evidence).
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Kanelbakken Bryggeri",
          experience_name: "Kanelbakken Fjordcruise",
          producer: side({ org_nr: "211111111", domain: "kanelbakken.no", evidence: evidence({ org_nr_found: true }) }),
          experience: side({ org_nr: "211111111", domain: "fjordtur.example", evidence: evidence({ org_nr_found: false }) }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "pending", "b4: matching org.nr VALUES but NOT page-confirmed on one side -> not auto_confirm, falls to pending");
      }

      // ── (c) auto_confirm via domain — no org.nr on either side at all. ───
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Nordvegen Sideri",
          experience_name: "Nordvegen kyststi vandring",
          producer: side({ org_nr: null, domain: "nordvegen.no", evidence: evidence({ name_found: true }) }),
          experience: side({ org_nr: null, domain: "nordvegen.no", evidence: evidence({ name_found: true }) }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "auto_confirm", "c1: same registered domain on both sides, no org.nr anywhere -> auto_confirm");
        assertTrue(result.reasons.includes("domain_match_both_sides"), "c2: reason names the domain match");
      }

      // ── (d) auto_reject via distinct org.nr — both present, both
      //     page-confirmed, genuinely different. Domains ALSO differ (so the
      //     domain-distinct rule could independently fire too — both reasons
      //     may legitimately co-occur; the assertion below only pins the
      //     verdict + the org_nr reason). ──────────────────────────────────
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Lervig",
          experience_name: "Different Business AS",
          producer: side({
            org_nr: "111111111",
            domain: "lervig.no",
            evidence: evidence({ org_nr_found: true, verified: true }),
          }),
          experience: side({
            org_nr: "222222212",
            domain: "different-host.example",
            evidence: evidence({ org_nr_found: true, verified: true }),
          }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "auto_reject", "d1: distinct org.nr, both present + page-confirmed -> auto_reject");
        assertTrue(result.reasons.includes("org_nr_distinct_both_sides"), "d2: reason names the org_nr distinctness");
      }

      // d3: distinct org.nr VALUES but NOT page-confirmed on one side ->
      // must NOT auto_reject on org_nr alone (same discipline as b4).
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Lervig",
          experience_name: "Lervig Something Else Entirely",
          producer: side({ org_nr: "111111111", domain: "lervig.no", evidence: evidence({ org_nr_found: true }) }),
          experience: side({ org_nr: "222222212", domain: "lervig.no", evidence: evidence({ org_nr_found: false }) }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        // Domains are equal here (deliberately), so this also exercises that
        // an unconfirmed org_nr distinctness does not somehow suppress a
        // legitimate domain match.
        assertEq(result.verdict, "auto_confirm", "d3: unconfirmed org_nr distinctness does not block an independent domain match");
      }

      // ── (e) pending via weak/missing signal ───────────────────────────────
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Ukjent Gård",
          experience_name: "En Helt Annen Opplevelse",
          producer: side({ org_nr: null, domain: "ukjentgard.no", evidence: evidence() }),
          experience: side({ org_nr: null, domain: null, evidence: null }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertEq(result.verdict, "pending", "e1: no org.nr anywhere, no domain to compare on one side, no evidence signals -> pending");
        assertTrue(result.reasons.includes("weak_or_ambiguous_signal"), "e2: reason names the weak/ambiguous fallback");
        assertEq(result.confidence, 0, "e3: confidence is 0 — nothing at all was found on either side");
      }

      // ── (f) name-token overlap ALONE is NOT sufficient for auto_confirm ──
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Austmann",
          experience_name: "Austmann Bryggeri",
          producer: side({ org_nr: null, domain: "austmann-produsent.no", evidence: evidence({ name_found: true }) }),
          experience: side({ org_nr: null, domain: "austmann-opplevelser.example", evidence: evidence({ name_found: true }) }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertTrue(hasNameTokenSupport(input.producer_name, input.experience_name), 'f0: "Austmann" ⊂ "Austmann Bryggeri" IS detected as name-token support (precondition for this test to mean anything)');
        assertTrue(result.verdict !== "auto_confirm", "f1: strong name-token overlap alone, no org.nr/domain corroboration -> must NOT auto_confirm");
        assertEq(result.verdict, "pending", "f2: falls through to pending (distinct domains, but name overlap blocks the domain-distinct reject rule too)");
        assertTrue(result.name_token_support, "f3: name_token_support is reported true on the result, even though it did not drive the verdict");
      }

      // f4: same shape as (f) but WITHOUT the name-token overlap (distinct
      // names too) — this one legitimately auto_rejects, proving (f)'s
      // pending outcome really is the name-overlap doing the blocking, not
      // some other accidental reason.
      {
        const input: GsExpTriagePairInput = {
          producer_name: "Sørlandet Bryggeri",
          experience_name: "Norsk Fjelltur Sommer",
          producer: side({ org_nr: null, domain: "sorlandet-bryggeri.no", evidence: evidence({ name_found: true }) }),
          experience: side({ org_nr: null, domain: "fjelltur.example", evidence: evidence() }),
        };
        const result = classifyGardssalgExperienceConflictPair(input);
        assertTrue(!hasNameTokenSupport(input.producer_name, input.experience_name), "f4 precondition: no meaningful name-token overlap between these two names");
        assertEq(result.verdict, "auto_reject", "f5: distinct domain AND no name overlap -> auto_reject (the rule (f) exists to NOT trigger for)");
        assertTrue(result.reasons.includes("domain_distinct_no_name_overlap"), "f6: reason names the domain-distinct-no-overlap rule");
      }

      // ── confidence ordering (best-evidence-first for the pending bucket) ──
      {
        const low: GsExpTriagePairInput = {
          producer_name: "A",
          experience_name: "B",
          producer: side({ evidence: evidence() }),
          experience: side({ evidence: evidence() }),
        };
        const high: GsExpTriagePairInput = {
          producer_name: "C",
          experience_name: "D",
          producer: side({ evidence: evidence({ name_found: true, place_found: true }) }),
          experience: side({ evidence: evidence({ name_found: true }) }),
        };
        const lowResult = classifyGardssalgExperienceConflictPair(low);
        const highResult = classifyGardssalgExperienceConflictPair(high);
        assertTrue(highResult.confidence > lowResult.confidence, "g1: a pair with more found sub-signals has strictly higher confidence");

        const rows = [
          { key: "low", confidence: lowResult.confidence },
          { key: "high", confidence: highResult.confidence },
        ];
        const sorted = sortByConfidenceDesc(rows, (r) => r.confidence, (r) => r.key);
        assertEq(sorted.map((r) => r.key), ["high", "low"], "g2: sortByConfidenceDesc puts the higher-confidence row first");
      }

      // ── hasNameTokenSupport — a few direct unit checks on the helper ─────
      assertTrue(hasNameTokenSupport("Austmann", "Austmann Bryggeri"), "h1: exact prefix containment");
      assertTrue(hasNameTokenSupport("Austmann Bryggeri", "Austmann"), "h2: containment is symmetric (longer name vs shorter)");
      assertTrue(!hasNameTokenSupport("Berg Gard", "Bergen Aktiviteter"), "h3: short/generic overlap ('berg' vs 'bergen') does not count as support — no token clears the length floor identically");
      assertTrue(!hasNameTokenSupport("", "Austmann Bryggeri"), "h4: an empty producer name never supports a match");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-experience-conflict-triage: unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/gardssalg-experience-conflict-triage.test.ts`
if (require.main === module) {
  runGardssalgExperienceConflictTriageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

/**
 * experience-brreg.test.ts — unit tests for classifyProvider()'s Brreg
 * name-collision gate (dev-request 2026-09-13-navnekollisjon-brreg-gate).
 *
 * PROBLEM this closes: several producer profiles (Moland Gård, Bakke
 * Gårdsbakeri, Romstad Gård, Grana Bryggeri) got contact data (phone/email)
 * or descriptive text attached from the WRONG Brreg entity, because
 * multiple Brreg entities can share the same/similar name and the OLD
 * accept gate (`best.sim >= 0.6 && naceOk(best.nace)`) never actually
 * required kommune to match — kommune only ever affected match_confidence
 * (high vs medium), never accept/reject. When kommune failed to
 * disambiguate between >=2 similarly-named candidates, the top-scoring one
 * was accepted anyway, sometimes the wrong entity.
 *
 * Fix: classifyProvider() now computes `collisionCandidates` (every
 * candidate with nameSimilarity(provider.name, candidate.navn) >= 0.6) and,
 * when there are >=2 of them AND the best-scoring candidate's kommune does
 * NOT match the provider's, refuses to accept — returns `unverified` with
 * `name_collision: true` instead of force-matching. Every other path
 * (single real match + noise below 0.6, or a collision kommune correctly
 * disambiguates) is byte-identical to the pre-fix behavior other than the
 * added `name_collision: false` field.
 *
 * Uses the SAME `__setBrregFetchForTesting` seam every other Brreg-touching
 * test file in this repo uses (e.g. the bulk-load / recheck-backfill test
 * suites) — no real network, no DB needed (classifyProvider() is pure Brreg
 * lookup + scoring, it never touches a database itself).
 */

import { classifyProvider, __setBrregFetchForTesting } from "./experience-brreg";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceBrregTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  /** JSON-request Brreg stub — resolves purely off a fixed `enheter` array, ignoring the `navn=` query param (classifyProvider always searches by provider.name, so a single fixture list per test block is enough). */
  function stubWith(enheter: unknown[]) {
    return async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { enheter } }),
    });
  }

  return (async () => {
    try {
      // ── (a) genuine collision: 2 candidates share the provider's
      // normalized name, in DIFFERENT municipalities than the provider's,
      // and neither matches → name_collision:true, unverified, no org_nr. ──
      {
        __setBrregFetchForTesting(
          stubWith([
            {
              organisasjonsnummer: "911111111",
              navn: "MOLAND GÅRD AS",
              naeringskode1: { kode: "93.291" },
              forretningsadresse: { kommune: "Kristiansand" },
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
            {
              organisasjonsnummer: "922222222",
              navn: "MOLAND GÅRD DA",
              naeringskode1: { kode: "93.291" },
              forretningsadresse: { kommune: "Trondheim" },
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
          ]),
        );
        const v = await classifyProvider({ name: "Moland Gård AS", kommune: "Arendal" });
        assertEq(v.name_collision, true, "a1: two same-name candidates, neither kommune matches -> name_collision:true");
        assertEq(v.classification, "unverified", "a2: -> classification unverified (refused to guess)");
        assertEq(v.org_nr, null, "a3: -> org_nr null (never attaches EITHER candidate's org_nr)");
        assertEq(v.brreg_verified, 0, "a4: -> brreg_verified 0");
        assertEq(v.brreg_active, null, "a5: -> brreg_active null");
        assertEq(v.matched_navn, null, "a6: -> matched_navn null");
        assertEq(v.reason, "name_collision_kommune_mismatch", "a7: -> reason names the collision");
      }

      // ── (b) regression: ONE real name match (sim >= 0.6) plus noise below
      // the 0.6 threshold (the "Go Fjords" incident this file's header
      // documents: a fuzzy name search can return an unrelated low-
      // similarity hit) → unchanged existing behavior, name_collision:false. ──
      {
        __setBrregFetchForTesting(
          stubWith([
            {
              organisasjonsnummer: "933333333",
              navn: "TROMSØ OPPLEVELSER AS",
              naeringskode1: { kode: "93.291" },
              forretningsadresse: { kommune: "Tromsø" },
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
            {
              // "Go Fjords" -> "FJORDS AS" style noise: near-zero token
              // overlap with the provider name, well under the 0.6 gate.
              organisasjonsnummer: "944444444",
              navn: "FJORDS FILM AS",
              naeringskode1: { kode: "59.11" },
              forretningsadresse: { kommune: "Oslo" },
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
          ]),
        );
        const v = await classifyProvider({ name: "Tromsø Opplevelser AS", kommune: "Tromsø" });
        assertEq(v.name_collision, false, "b1: only one real match above 0.6 -> name_collision:false");
        assertEq(v.classification, "verified_active", "b2: unchanged accept behavior — verified_active");
        assertEq(v.org_nr, "933333333", "b3: unchanged — org_nr from the genuine match");
        assertEq(v.brreg_verified, 1, "b4: unchanged — brreg_verified 1");
        assertEq(v.brreg_active, 1, "b5: unchanged — brreg_active 1");
        assertEq(v.match_confidence, "high", "b6: unchanged — kommune matched too -> high confidence");
      }

      // ── (c) two candidates share the (normalized) name, but the BEST one
      // actually matches the provider's kommune -> kommune correctly
      // disambiguates, normal acceptance proceeds unchanged,
      // name_collision:false. ──────────────────────────────────────────────
      {
        __setBrregFetchForTesting(
          stubWith([
            {
              organisasjonsnummer: "955555555",
              navn: "SAMEIET FJELL AS",
              naeringskode1: { kode: "93.291" },
              forretningsadresse: { kommune: "Bergen" }, // matches provider's kommune
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
            {
              organisasjonsnummer: "966666666",
              navn: "SAMEIET FJELL DA",
              naeringskode1: { kode: "93.291" },
              forretningsadresse: { kommune: "Oslo" }, // does NOT match
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
          ]),
        );
        const v = await classifyProvider({ name: "Sameiet Fjell AS", kommune: "Bergen" });
        assertEq(v.name_collision, false, "c1: kommune disambiguated the collision -> name_collision:false");
        assertEq(v.classification, "verified_active", "c2: normal acceptance proceeds — verified_active");
        assertEq(v.org_nr, "955555555", "c3: accepts the kommune-matching candidate's org_nr, not the other one");
        assertEq(v.matched_navn, "SAMEIET FJELL AS", "c4: matched_navn is the kommune-matching candidate");
        assertEq(v.match_confidence, "high", "c5: kommune match -> high confidence");
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-brreg: unexpected error: " + String(err?.stack || err));
    } finally {
      __setBrregFetchForTesting(null);
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceBrregTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

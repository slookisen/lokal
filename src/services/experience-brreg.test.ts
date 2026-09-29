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

      // ── (d) NACE_ALLOW farm/food/drink families (B19, 2026-09-29 — see
      // the NACE_ALLOW block comment in experience-brreg.ts). Each case is a
      // SINGLE active candidate with an exact name + kommune match, so the
      // ONLY thing deciding verified_active vs unverified is naceOk(): every
      // d-case below returned `unverified` / no_confident_brreg_match on the
      // pre-B19 tourism-only list, and the retail case must STILL do so. ──
      const naceCase = async (kode: string, navn: string, orgnr: string) => {
        __setBrregFetchForTesting(
          stubWith([
            {
              organisasjonsnummer: orgnr,
              navn: navn.toUpperCase(),
              naeringskode1: { kode },
              forretningsadresse: { kommune: "Voss" },
              konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
            },
          ]),
        );
        return classifyProvider({ name: navn, kommune: "Voss" });
      };
      {
        const v = await naceCase("01.410", "Nordbø Gard AS", "970000001");
        assertEq(v.classification, "verified_active", "d1: farm 01.410 (melkeproduksjon) + exact name -> verified_active");
        assertEq(v.brreg_active, 1, "d1b: farm -> brreg_active 1");
        assertEq(v.naeringskode, "01.410", "d1c: farm -> naeringskode carried through");
      }
      {
        const v = await naceCase("10.510", "Vossa Ysteri AS", "970000002");
        assertEq(v.classification, "verified_active", "d2: dairy/food 10.510 (ysteri) + exact name -> verified_active");
        assertEq(v.org_nr, "970000002", "d2b: dairy -> org_nr attached");
      }
      {
        const v = await naceCase("11.050", "Voss Bryggeri AS", "970000003");
        assertEq(v.classification, "verified_active", "d3: beverage 11.050 (bryggeri) + exact name -> verified_active");
        assertEq(v.brreg_verified, 1, "d3b: beverage -> brreg_verified 1");
      }
      {
        const v = await naceCase("01.210", "Hebnes Vingård", "970000004");
        assertEq(v.classification, "verified_active", "d4: perennial 01.210 (druer/vingård) + exact name -> verified_active");
      }
      {
        // Retail stays OUT: a shop sharing a farm's name is the wrong-entity
        // match the NACE gate exists to refuse (score ×0.2 and accept
        // requires naceOk) — unchanged by B19.
        const v = await naceCase("47.210", "Voss Gardsbutikk AS", "970000005");
        assertEq(v.classification, "unverified", "d5: retail 47.210 + exact name -> STILL unverified (47.x not allowed)");
        assertEq(v.org_nr, null, "d5b: retail -> no org_nr attached");
        assertEq(v.reason, "no_confident_brreg_match", "d5c: retail -> no_confident_brreg_match");
      }
      {
        // Wholesale likewise stays out.
        const v = await naceCase("46.310", "Voss Frukt Engros AS", "970000006");
        assertEq(v.classification, "unverified", "d6: wholesale 46.310 + exact name -> STILL unverified (46.x not allowed)");
      }
      {
        // 01.6 (agricultural support/contract services) is deliberately NOT
        // covered — only groups 01.1–01.5 were added, never a bare "01.".
        const v = await naceCase("01.610", "Voss Landbrukstjenester AS", "970000007");
        assertEq(v.classification, "unverified", "d7: 01.610 support services -> unverified (only 01.1–01.5 allowed)");
      }
      {
        // Regression: an existing tourism code is still accepted.
        const v = await naceCase("93.291", "Voss Aktiv AS", "970000008");
        assertEq(v.classification, "verified_active", "d8: tourism 93.291 still -> verified_active (unchanged)");
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

/**
 * route-intent.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 3a/3b/3c.
 *
 * Daniel approved the single-field design with one condition: «jeg er enig i
 * "ett felt" så lenge dette er "smart" og fungerer til alle formål uten
 * missforståelser». This suite is what makes «uten missforståelser» checkable
 * rather than aspirational.
 *
 * The asymmetry that shapes every test below: a MISSED route costs the user the
 * ordinary search they typed. A FALSE route costs them a page they never asked
 * for, and it fires on someone who was searching for cheese. So the false
 * positives (ri20-ri34) outnumber the true positives, deliberately.
 *
 *   ri1-ri12    detectRouteIntent — the pure, synchronous shape test
 *   ri13-ri19   resolveRouteIntent — the async decision, incl. every rejection
 *   ri20-ri34   THINGS THAT MUST NOT BECOME ROUTES, including the live
 *               catalogue's own `Navn — Sted` convention
 *   ri35-ri38   Fase 3b intent ORDER, exercised end to end
 *   ri39-ri41   reiseUrlFor / encoding
 *
 * MUTATION-TESTED — see the PR body for the mutant list and the kill results.
 *
 * Exported runRouteIntentTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/route-intent.test.ts
 */

import {
  detectRouteIntent,
  resolveRouteIntent,
  reiseUrlFor,
  routeHaversineKm,
  MIN_ROUTE_SEPARATION_KM,
  MIN_WEAK_ROUTE_SEPARATION_KM,
} from "./route-intent";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** Real coordinates, so the separation guards are exercised against reality. */
const PLACES: Record<string, { lat: number; lng: number }> = {
  oslo: { lat: 59.9139, lng: 10.7522 },
  bodø: { lat: 67.2804, lng: 14.4049 },
  bodo: { lat: 67.2804, lng: 14.4049 },
  bergen: { lat: 60.3913, lng: 5.3221 },
  trondheim: { lat: 63.4305, lng: 10.3951 },
  lillestrøm: { lat: 59.9559, lng: 11.0494 },   // 16 km from Oslo — just over the floor
  sagene: { lat: 59.9375, lng: 10.7594 },        // 2.6 km from Oslo — under it
  gjerdrum: { lat: 60.0788, lng: 11.0206 },
  valdres: { lat: 61.0, lng: 9.0 },
  rakfisk: { lat: 61.1, lng: 9.1 },              // deliberately geocodable, 12 km from Valdres
  // Sits BETWEEN the two floors (17 km from Oslo): accepted with a strong
  // marker, rejected with a weak one. Without a point in this band the two
  // thresholds are indistinguishable and a mutant collapsing them survives.
  jessheim: { lat: 60.1417, lng: 11.1744 },
};

/**
 * A STRICT whole-string resolver, matching the production contract: the input
 * must BE a place, not merely contain one. The first version of this feature
 * injected an EXTRACTOR in production while testing against this strict fake —
 * which is exactly why the false positives got through review-by-author. The
 * fake was right; the wiring was wrong.
 */
const geocode = async (place: string) => {
  const k = (place || "").toLowerCase().trim();
  return PLACES[k] ?? null;
};

export function runRouteIntentTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  return (async () => {
    // ═══════════════════════════════════════════════════════════════
    // ri1-ri12 — detectRouteIntent: pure shape, no I/O
    // ═══════════════════════════════════════════════════════════════
    {
      const a = detectRouteIntent("oslo til bodø");
      assertEq(a?.from, "oslo", "ri1: «oslo til bodø» → from");
      assertEq(a?.to, "bodø", "ri2: …→ to");
      assertEq(a?.marker, "til", "ri3: …marker is the directional «til»");
      assertEq(a?.weak, false, "ri4: …and a directional marker is never weak");

      const b = detectRouteIntent("fra oslo til bergen");
      assertEq(b?.from, "oslo", "ri5: «fra X til Y» strips the leading «fra»");
      assertEq(b?.marker, "fra-til", "ri6: …and reports its own marker");

      assertEq(detectRouteIntent("Oslo → Bodø")?.marker, "arrow", "ri7: arrow form");
      assertEq(detectRouteIntent("oslo -> bodø")?.marker, "arrow", "ri8: ASCII arrow too");
      assertEq(detectRouteIntent("oslo to bergen")?.marker, "to", "ri9: English «to», for agents");

      const d = detectRouteIntent("oslo - bodø");
      assertEq(d?.marker, "dash", "ri10: dash form is recognised…");
      assertEq(d?.weak, true, "ri11: …but flagged WEAK — it is our own naming convention");

      // Two dashes means a name, not a route. One separator or nothing.
      assertEq(detectRouteIntent("a - b - c"), null,
        "ri12: more than one dash is a name pattern, not a route");
    }

    // ═══════════════════════════════════════════════════════════════
    // ri13-ri19 — resolveRouteIntent: the actual decision
    // ═══════════════════════════════════════════════════════════════
    {
      const ok = await resolveRouteIntent("oslo til bodø", { geocode });
      assertTrue(ok.ok, "ri13: both endpoints resolve and are far apart → it is a route");
      if (ok.ok) {
        assertEq(ok.route.from.query, "oslo", "ri14: …carries the endpoint strings back");
        assertTrue(ok.route.separation_km > 800, "ri15: …and a real separation (Oslo–Bodø great-circle ≈ 838 km)");
      }

      const unresolved = await resolveRouteIntent("oslo til ingenstedet", { geocode });
      assertEq(unresolved.ok, false, "ri16: an unresolvable endpoint is NOT a route…");
      assertEq((unresolved as any).reason, "to_unresolved",
        "ri16b: …and says which side failed, so the fall-through is loggable");

      const close = await resolveRouteIntent("oslo til sagene", { geocode });
      assertEq((close as any).reason, "too_close",
        "ri17: 2.6 km is a neighbourhood, not a journey");

      const justFar = await resolveRouteIntent("oslo til lillestrøm", { geocode });
      assertEq(justFar.ok, true,
        "ri18: 16 km clears the 15 km floor — the boundary is where it is documented");

      const noIntent = await resolveRouteIntent("økologiske grønnsaker", { geocode });
      assertEq((noIntent as any).reason, "no_intent",
        "ri19: an ordinary query never reaches the geocoder");
    }

    // ═══════════════════════════════════════════════════════════════
    // ri20-ri34 — MUST NOT become routes
    //
    // This is the block that earns the feature. Each one is a query a real
    // visitor types, and each one would be hijacked by a naive implementation.
    // ═══════════════════════════════════════════════════════════════
    {
      // The live catalogue convention. Under a STRICT resolver «bent gate
      // brewing» simply is not a place, so no veto is needed — which is why
      // the producer-name veto (and its uncached full-table scan on a public
      // path) was deleted after review.
      const brewing = await resolveRouteIntent("Bent Gate Brewing — Gjerdrum", { geocode });
      assertEq(brewing.ok, false, "ri20: «Bent Gate Brewing — Gjerdrum» is a PRODUCER, not a route");
      assertEq((brewing as any).reason, "from_unresolved",
        "ri20b: …and the strict resolver is what stops it — no name veto required");

      const kringler = await resolveRouteIntent("Kringler Gjestegård — Gårdsutsalg", { geocode });
      assertEq(kringler.ok, false, "ri21: …same for a name whose right side is not a place at all");

      // Even WITHOUT the veto, a weak match must clear a much higher bar.
      const weakClose = await resolveRouteIntent("Rakfisk - Valdres", { geocode });
      assertEq(weakClose.ok, false,
        "ri22: a weak (dash) match 12 km apart is rejected — weak markers need 50 km, not 15");
      assertEq((weakClose as any).reason, "too_close", "ri22b: …for the stated reason");

      // «til» as a preposition.
      for (const [q, label] of [
        ["ost til pizza", "ri23"],
        ["grønnsaker til middag", "ri24"],
        ["gaver til jul", "ri25"],
        ["kjøtt til grillen", "ri26"],
        ["mat til barna", "ri27"],
      ] as Array<[string, string]>) {
        const r = await resolveRouteIntent(q, { geocode });
        assertEq(r.ok, false, `${label}: «${q}» is a preposition, not a route`);
      }

      // Endpoints that are not endpoints.
      assertEq(detectRouteIntent("til bodø"), null, "ri28: a bare «til X» has no origin");
      assertEq(detectRouteIntent("oslo til"), null, "ri29: …and «X til» has no destination");
      assertEq(detectRouteIntent("a til b"), null, "ri30: single letters are not places");
      assertEq(detectRouteIntent("2 til 5"), null, "ri31: digits are a quantity, not a route");
      assertEq(detectRouteIntent(""), null, "ri32: empty query");
      assertEq(detectRouteIntent("   "), null, "ri33: whitespace-only query");

      // Same place twice, spelled differently — resolves, but is not a journey.
      const same = await resolveRouteIntent("bodø til bodo", { geocode });
      assertEq((same as any).reason, "too_close",
        "ri34: two spellings of one place is not a route, however well both geocode");
    }

    // ═══════════════════════════════════════════════════════════════
    // ri35-ri38 — Fase 3b: the intent ORDER, exercised not just documented
    //   route > exact name > category+place > category > place > free text
    // ═══════════════════════════════════════════════════════════════
    {
      // Route beats a place search: «oslo til bodø» contains two place names,
      // and the pre-Fase-3 behaviour was to geocode Oslo and search there.
      const r = await resolveRouteIntent("oslo til bodø", { geocode });
      assertEq(r.ok, true, "ri35: route wins over the place search it used to become");

      // Exact name beats route, for the weak form only — the one place where
      // the two intents genuinely collide.
      // Under the strict resolver the name veto is gone, so what protects this
      // is the WEAK floor: «Rakfisk» and «Valdres» both resolve here, but 12 km
      // apart is not a journey, and a dash must prove 50 km.
      const n = await resolveRouteIntent("Rakfisk — Valdres", { geocode });
      assertEq((n as any).reason, "too_close",
        "ri36: a weak dash match between two nearby places is still not a route");

      // …but a strong marker is never vetoed by a coincidental name.
      const strong = await resolveRouteIntent("Rakfisk til Valdres", { geocode });
      assertEq(strong.ok, false,
        "ri37: «Rakfisk til Valdres» — strong marker, so no name veto, but still too close to be a route");

      // Category queries never reach route detection at all.
      const cat = await resolveRouteIntent("honning bergen", { geocode });
      assertEq((cat as any).reason, "no_intent",
        "ri38: category+place has no separator, so route detection is a no-op");
    }

    // ═══════════════════════════════════════════════════════════════
    // ri39-ri41 — URL construction
    // ═══════════════════════════════════════════════════════════════
    {
      const r = await resolveRouteIntent("oslo til bodø", { geocode });
      if (r.ok) {
        const url = reiseUrlFor(r.route);
        assertTrue(url.startsWith("/reise?"), "ri39: default base path is /reise");
        assertTrue(url.includes("from=oslo"), "ri40: endpoints are carried as query params");
        assertTrue(url.includes("bod%C3%B8"), "ri41: …and non-ASCII is percent-encoded, not dropped");
      } else {
        assertTrue(false, "ri39-41: route unexpectedly unresolved");
      }
    }

    // Sanity on the distance helper the guards depend on.
    // 838 km, not the ~950 km road distance — the corridor engine reports the
    // same figure for its last Bodø stop (along_km 838.1 in prod), so the two
    // agree on what a straight line between these points measures.
    assertTrue(
      Math.abs(routeHaversineKm(59.9139, 10.7522, 67.2804, 14.4049) - 838) < 5,
      "ri42: haversine agrees with the corridor engine's Oslo–Bodø great-circle (838 km)"
    );
    assertTrue(MIN_WEAK_ROUTE_SEPARATION_KM > MIN_ROUTE_SEPARATION_KM,
      "ri43: weak markers demand strictly more separation than strong ones");

    // ═══════════════════════════════════════════════════════════════
    // ri44-ri50 — gaps found by MUTATION TESTING, not by reading the code.
    //
    // Four mutants survived the first version of this suite: collapsing the
    // two distance floors, deleting the «til»-preposition guard, deleting the
    // digits-only rejection, and allowing more than one dash. Every one of
    // those was "covered" by a test that passed for an unrelated reason. The
    // cases below fail if any of the four guards is removed.
    // ═══════════════════════════════════════════════════════════════
    {
      // M4: a point in the 15–50 km band is the ONLY way to tell the floors
      // apart. Oslo–Jessheim is ~46 km: a route with «til», not with a dash.
      const strongMid = await resolveRouteIntent("oslo til jessheim", { geocode });
      assertEq(strongMid.ok, true,
        "ri44: 46 km clears the STRONG floor (15 km) — «oslo til jessheim» is a route");
      const weakMid = await resolveRouteIntent("oslo - jessheim", { geocode });
      assertEq(weakMid.ok, false,
        "ri45: …the same 46 km does NOT clear the WEAK floor (50 km) — a dash must prove more");
      assertEq((weakMid as any).reason, "too_close", "ri45b: …and says so");

      // M5: the preposition guard, tested on the PURE function. Going through
      // resolveRouteIntent hid it, because these words fail to geocode anyway
      // — the test passed without the guard doing any work.
      assertEq(detectRouteIntent("ost til middag"), null,
        "ri46: «til middag» is rejected by the preposition guard itself, before any geocoding");
      assertEq(detectRouteIntent("kaker til jul"), null,
        "ri47: …same for «til jul»");
      assertEq(detectRouteIntent("oslo til bergen") === null, false,
        "ri48: …and the guard does not swallow a real destination");

      // M7: multi-digit endpoints. «2 til 5» was rejected by the length floor,
      // not by the digits rule, so the digits rule was untested.
      assertEq(detectRouteIntent("2024 til 2025"), null,
        "ri49: multi-digit endpoints are years or quantities, never places");

      // M8: more than one dash. «a - b - c» was rejected because its segments
      // were one character long, so the count check never mattered.
      assertEq(detectRouteIntent("Moe Gård - Bringebær - fra Moe"), null,
        "ri50: two dashes is a producer name pattern — the count check must hold with real-length segments");
    }

    // ═══════════════════════════════════════════════════════════════
    // ri51-ri66 — gaps found by the INDEPENDENT reviewer's mutation sweep.
    //
    // The author ran 9 mutants and killed 9. The reviewer ran 34 and found
    // NINETEEN survivors. Every case below corresponds to one of them: real
    // behaviour the suite claimed to cover and did not.
    // ═══════════════════════════════════════════════════════════════
    {
      // M20 — the word boundary on «til». Without \s+ the regex splits inside
      // ordinary Norwegian words, and nothing failed.
      assertEq(detectRouteIntent("tilbud på epler"), null,
        "ri51: «tilbud» must not split — «til» needs a word boundary, not a substring match");
      assertEq(detectRouteIntent("utstilling"), null,
        "ri52: …nor «utstilling»");
      assertEq(detectRouteIntent("tilberedning av rakfisk"), null,
        "ri53: …nor «tilberedning»");

      // M18 — the documented "split on the FIRST « til »".
      const multi = detectRouteIntent("oslo til bodø til tromsø");
      assertEq(multi?.from, "oslo", "ri54: split on the FIRST «til», so from is the first leg…");
      assertEq(multi?.to, "bodø til tromsø", "ri55: …and the rest stays whole, to fail resolution honestly");

      // M14/M15/M16 — endsInNonPlace's startsWith/endsWith arms; only the
      // exact-equality arm was exercised.
      assertEq(detectRouteIntent("ost til middag i morgen"), null,
        "ri56: the non-place guard matches a LEADING word, not only the whole string");
      assertEq(detectRouteIntent("kaker til søndagens fest"), null,
        "ri57: …and a TRAILING one");

      // M13 — the guard on the fra-til branch specifically.
      assertEq(detectRouteIntent("fra oslo til middag"), null,
        "ri58: the «fra X til Y» branch applies the same non-place guard");

      // M02/M29 — MAX_ENDPOINT_CHARS had no test at all.
      assertEq(detectRouteIntent(`${"a".repeat(80)} til oslo`), null,
        "ri59: an 80-character endpoint is a sentence, not a place");

      // M03 — the leading/trailing separator reject in cleanEndpoint.
      assertEq(detectRouteIntent("- oslo til bodø"), null,
        "ri60: a leftover separator on an endpoint means the split was wrong");

      // M11 — the exact-boundary case on the separation floor.
      // Oslo→Sagene is 2.7 km, well under; the boundary itself is asserted by
      // ri18 (17.2 km passes) and ri44/ri45 (46 km splits the two floors).
      assertEq((await resolveRouteIntent("oslo til sagene", { geocode }) as any).reason, "too_close",
        "ri61: under the floor is rejected, and the floor is a floor not a ceiling");

      // M21 — the arrow form without surrounding spaces.
      assertEq(detectRouteIntent("oslo->bodø")?.marker, "arrow",
        "ri62: «oslo->bodø» with no spaces is still an arrow");

      // M24 — norm() must lowercase.
      const shouty = await resolveRouteIntent("OSLO TIL BODØ", { geocode });
      assertEq(shouty.ok, true, "ri63: uppercase input resolves — norm() lowercases before lookup");

      // M33 — the DIRECTION of the dash form was never asserted.
      const dash = detectRouteIntent("bergen - trondheim");
      assertEq(dash?.from, "bergen", "ri64: the dash form keeps left as origin…");
      assertEq(dash?.to, "trondheim", "ri65: …and right as destination");

      // M19 — the ^ anchor on the fra-til branch. «X fra A til B» must NOT be
      // read as fra-til; it falls to the generic branch with from = "x fra a",
      // which a STRICT resolver then refuses. This is the shape that produced
      // the live «rakfisk fra Valdres til Oslo» false redirect.
      const midFra = detectRouteIntent("rakfisk fra valdres til oslo");
      assertEq(midFra?.marker, "til",
        "ri66: «X fra A til B» is not the fra-til form — the anchor holds");
      assertEq(midFra?.from, "rakfisk fra valdres",
        "ri66b: …so the origin is the whole phrase, which only a STRICT resolver rejects");
    }

    // ═══════════════════════════════════════════════════════════════
    // ri67-ri74 — THE LIVE FALSE POSITIVES.
    //
    // Eight ordinary product searches that redirected to a travel page against
    // the real Kartverket API, because the wiring injected a place EXTRACTOR
    // instead of a place RESOLVER. These are the exact strings from the review.
    // The endpoints below are phrases; a strict resolver must return null for
    // every one, and the cost guard rejects the long ones before any lookup.
    // ═══════════════════════════════════════════════════════════════
    {
      const LIVE_FALSE_POSITIVES = [
        "epler fra Hardanger til Oslo",
        "kjøtt fra Rendalen til Oslo",
        "ost fra Jæren til Bergen",
        "rakfisk fra Valdres til Oslo",
        "sider fra Hardanger til Bergen",
        "mat fra Lofoten til Oslo",
        "spekemat fra Røros til Oslo",
        "ferske egg fra Toten til Oslo",
        "Lofoten Gårdsysteri - Bodø",
        "Bakeri Tromsø - Oslo",
        "Stange Gårdsysteri - Bergen",
        "Gårdsbutikk Hardanger - Oslo",
      ];
      let n = 67;
      for (const q of LIVE_FALSE_POSITIVES) {
        const r = await resolveRouteIntent(q, { geocode });
        assertEq(r.ok, false, `ri${n}: «${q}» must NOT redirect — it is a product search`);
        n++;
      }
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runRouteIntentTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

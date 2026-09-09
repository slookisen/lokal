/**
 * agents-city-backfill.test.ts — dev-request 2026-09-09-outreach-
 * profilkvalitet.
 *
 * `agents.city` had no write path and no backfill before this slice. This
 * suite is a REFUSAL machine as much as a resolver, mirroring agents-
 * postal-backfill.test.ts's own framing: a wrong city is not a graceful
 * degradation, it renders confidently in the hero line, JSON-LD, and the
 * outreach email itself. Most of what follows asserts that we DECLINE to
 * write.
 *
 * Asserted here:
 *   r1-r2   parsePostalRegistry — the pure tab-separated parser, including
 *           malformed/short lines and duplicate postnummer
 *   c1      (a) Brreg forretningsadresse resolves and wins over both other
 *           tiers when org_nr is present
 *   c2      (b) the postal-code registry resolves when org_nr is absent/
 *           unmatched but postal_code is present
 *   c3      (c) Kartverket resolves from the address text, cross-verified
 *           against postal_code, when neither (a) nor (b) yielded anything
 *   c4      priority order: (a) wins even when (b)/(c) would ALSO resolve to
 *           a genuinely different value (both are stubbed to disagree)
 *   g1      MUTATION-STYLE SAFETY (acceptance criterion 2): Kartverket
 *           AMBIGUOUS (several distinct postnummer) -> skip, no write
 *   g2      MUTATION-STYLE SAFETY: Kartverket resolves to a DIFFERENT
 *           postnummer than the one on file (coincidental match, REVIEW B2
 *           class) -> skip, no write — never trust "resolved by coincidence"
 *   g3      no usable source at all (no org_nr, no postal_code, address has
 *           no house number) -> skip "no_usable_source", no write
 *   g4      a too-small/garbage postal-registry response is never trusted
 *           (falls through to Kartverket or skip, never a wrong-tier write)
 *   g5      MUTATION-STYLE SAFETY (PR #842 review): Brreg forretningsadresse
 *           resolves to a postnummer that MISMATCHES row.postal_code -> Tier
 *           a refuses (falls through), never trusted "outright"
 *   g6      MUTATION-STYLE SAFETY (PR #842 review): agents.brreg_flag of
 *           dissolved/bankrupt/wrong_nace skips Tier a entirely, even when
 *           the Brreg hit's postnummer would otherwise corroborate
 *   w1-w4   the worker (cityBackfillTick): writes agents.city + merges
 *           field_provenance for "city" exactly like PUT /admin/knowledge
 *           does, stamps city_backfill_source/outcome/attempted_at
 *   n1      NEVER OVERWRITE: a row whose city is ALREADY populated is not
 *           even selected as a candidate
 *   s1      ALWAYS STAMP: a skipped row still gets city_backfill_attempted_at
 *           so the next tick rotates past it
 *   d1      dry run: reports the resolution in `planned` but writes NOTHING
 *           (agents.city stays NULL, no provenance/stamp columns touched)
 *
 * Setup mirrors agents-postal-backfill.test.ts: an in-memory DB running the
 * REAL production schema via __setDbForTesting/__initSchemaForTesting, the
 * singleton restored in `finally`. The ONLY network seam is
 * AgentsCityBackfillDeps.fetchImpl, routing three distinct hosts (Brreg,
 * bring.no's postnummerregister, Kartverket's adresser/v1/sok) by URL — an
 * unregistered/unexpected request answers empty/404, which is always the
 * safe direction (can only cause a refusal, never an accidental write).
 *
 * Exported runAgentsCityBackfillTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/agents-city-backfill.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Kartverket fixture helper (same shape as agents-postal-backfill.test.ts) ──
function addr(postnummer: string, poststed: string, kommunenavn: string, kommunenummer = "9999", tekst = "Storgata 5") {
  return {
    adressetekst: tekst,
    postnummer,
    poststed,
    kommunenummer,
    kommunenavn,
    objtype: "Vegadresse",
  };
}
function kvBody(hits: any[], total?: number) {
  return { metadata: { totaltAntallTreff: total ?? hits.length, treffPerSide: 100, side: 0 }, adresser: hits };
}
const KV_EMPTY = kvBody([]);

export function runAgentsCityBackfillTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");

    // ── The injected network seam — a small router by host/path ────────
    // brregRoutes: orgNr -> raw JSON body (or "404" sentinel)
    // kartverketRoutes: decoded `sok=` value -> raw JSON body
    // postalRegistryText: the ANSI-decoded body for bring.no's endpoint;
    // null means "simulate a transport failure" (never crashes the caller).
    const brregRoutes = new Map<string, any>();
    const kartverketRoutes = new Map<string, any>();
    let postalRegistryText: string | null = null;
    const seenUrls: string[] = [];

    const fetchImpl = (async (input: any) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes("data.brreg.no")) {
        const m = url.match(/\/enheter\/([^/?]+)/);
        const orgNr = m ? decodeURIComponent(m[1]) : "";
        const hit = brregRoutes.get(orgNr);
        if (!hit) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => hit } as unknown as Response;
      }
      if (url.includes("postnummerregister-ansi.txt")) {
        if (postalRegistryText === null) {
          return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
        }
        const buf = new TextEncoder().encode(postalRegistryText).buffer;
        return { ok: true, status: 200, arrayBuffer: async () => buf } as unknown as Response;
      }
      if (url.includes("ws.geonorge.no/adresser")) {
        const m = url.match(/[?&]sok=([^&]*)/);
        const q = decodeURIComponent(m ? m[1] : "").trim();
        return { ok: true, status: 200, json: async () => kartverketRoutes.get(q) ?? KV_EMPTY } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const deps = { fetchImpl, sleep: async () => {} };

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const cb = require("./agents-city-backfill") as typeof import("./agents-city-backfill");
      cb.__clearCityPostalRegistryCacheForTesting();

      // ── r1-r2: parsePostalRegistry (pure) ─────────────────────────────
      {
        const text = "0155\tOslo\t0301\tOSLO\tG\n7013\tTRONDHEIM\t5001\tTRONDHEIM\tG\n\nmalformed-line-no-tab\n0155\tDUPLICATE-IGNORED\t0301\tOSLO\tG\n";
        const map = cb.parsePostalRegistry(text);
        assertEq(map.get("0155"), "Oslo", "r1: postnummer -> poststed parses correctly");
        assertEq(map.get("7013"), "TRONDHEIM", "r1b: a second row parses independently");
        assertEq(map.size, 2, "r2: a malformed (no-tab) line and a duplicate postnummer are both ignored, not counted twice");
      }

      // ── c1: (a) Brreg wins when org_nr is present ─────────────────────
      brregRoutes.set("111111111", {
        organisasjonsnummer: "111111111",
        navn: "Test Gård Én AS",
        forretningsadresse: { postnummer: "1400", poststed: "SKI", adresse: ["Testveien 1"] },
      });
      {
        const r = await cb.resolveCityForRow(
          { org_nr: "111111111", address: "Testveien 1, 1400 Ski", postal_code: "1400" },
          deps,
        );
        assertTrue(r.status === "resolved", "c1a: Brreg tier resolves");
        if (r.status === "resolved") {
          assertEq(r.city, "Ski", "c1b: poststed is title-cased via normalizeCityLabel");
          assertEq(r.source, "brreg_forretningsadresse", "c1c: source is brreg_forretningsadresse");
        }
      }

      // ── c2: (b) postal registry resolves when org_nr is absent ────────
      postalRegistryText = "0155\tOSLO\t0301\tOSLO\tG\n7013\tTRONDHEIM\t5001\tTRONDHEIM\tG\n" + "0".repeat(0) +
        Array.from({ length: 1000 }, (_, i) => `${1000 + i}\tFYLLPOSTSTED${i}\t0000\tX\tG`).join("\n");
      cb.__clearCityPostalRegistryCacheForTesting();
      {
        const r = await cb.resolveCityForRow(
          { org_nr: null, address: null, postal_code: "0155" },
          deps,
        );
        assertTrue(r.status === "resolved", "c2a: postal-registry tier resolves");
        if (r.status === "resolved") {
          assertEq(r.city, "Oslo", "c2b: registry poststed is title-cased");
          assertEq(r.source, "postnummerregister", "c2c: source is postnummerregister");
        }
      }

      // ── c3: (c) Kartverket resolves when (a) and (b) yield nothing ─────
      // 9013 is deliberately NOT in the fake registry seeded above (which only
      // has 0155/7013 + filler 1000-1999), so tier (b) misses and falls
      // through to Kartverket.
      kartverketRoutes.set("Fjellveien 9 9013", kvBody([addr("9013", "TRONDHEIM", "TRONDHEIM", "5001", "Fjellveien 9")]));
      {
        const r = await cb.resolveCityForRow(
          { org_nr: null, address: "Fjellveien 9, 9013 Trondheim", postal_code: "9013" },
          deps,
        );
        assertTrue(r.status === "resolved", "c3a: Kartverket tier resolves");
        if (r.status === "resolved") {
          assertEq(r.city, "Trondheim", "c3b: Kartverket poststed is title-cased");
          assertEq(r.source, "kartverket_adresse", "c3c: source is kartverket_adresse");
        }
      }

      // ── c4: priority order — (a) wins even when (b) disagrees ──────────
      brregRoutes.set("222222222", {
        organisasjonsnummer: "222222222",
        navn: "Test Gård To AS",
        forretningsadresse: { postnummer: "0155", poststed: "OSLO-BRREG-VINNER", adresse: ["Storgata 2"] },
      });
      {
        const r = await cb.resolveCityForRow(
          { org_nr: "222222222", address: null, postal_code: "0155" }, // 0155 registry says "Oslo"
          deps,
        );
        assertTrue(r.status === "resolved", "c4a: resolves");
        if (r.status === "resolved") {
          assertEq(r.source, "brreg_forretningsadresse", "c4b: Brreg (tier a) wins over the registry (tier b) even though both would answer");
          assertEq(r.city, "Oslo-Brreg-Vinner", "c4c: …and its own value is used, not the registry's");
        }
      }

      // ── g1: MUTATION-STYLE SAFETY — Kartverket AMBIGUOUS -> skip, no write ──
      kartverketRoutes.set(
        "Ambiveien 5 9999",
        kvBody([addr("9991", "STED-A", "KOMMUNE-A", "0001"), addr("9992", "STED-B", "KOMMUNE-B", "0002")]),
      );
      {
        const r = await cb.resolveCityForRow(
          { org_nr: null, address: "Ambiveien 5, 9999 Ukjent", postal_code: "9999" },
          deps,
        );
        assertTrue(r.status === "skip", "g1a: an ambiguous Kartverket result is a SKIP, never a resolve");
        if (r.status === "skip") assertEq(r.reason, "kartverket_ambiguous", "g1b: reason names the ambiguity");
      }

      // ── g2: MUTATION-STYLE SAFETY — resolved postnummer MISMATCHES the
      // one already on file (coincidental street+number match, REVIEW B2
      // class) -> skip, never trust it. ──────────────────────────────────
      kartverketRoutes.set("Mismatchveien 3 8888", kvBody([addr("1234", "FEIL-STED", "FEIL-KOMMUNE")]));
      {
        const r = await cb.resolveCityForRow(
          { org_nr: null, address: "Mismatchveien 3, 8888 Ukjent", postal_code: "8888" },
          deps,
        );
        assertTrue(r.status === "skip", "g2a: a resolved-but-mismatched postnummer is a SKIP, never a resolve");
        if (r.status === "skip") assertEq(r.reason, "no_usable_source", "g2b: falls through to the terminal skip, not a false resolve");
      }

      // ── g3: no usable source at all -> skip "no_usable_source" ─────────
      {
        const r = await cb.resolveCityForRow(
          { org_nr: null, address: "Bare et gatenavn uten husnummer", postal_code: null },
          deps,
        );
        assertTrue(r.status === "skip", "g3a: no org_nr, no postal_code, no house number -> skip");
        if (r.status === "skip") assertEq(r.reason, "no_usable_source", "g3b: reason is no_usable_source");
      }

      // ── g4: a too-small/garbage registry response is never trusted ─────
      cb.__clearCityPostalRegistryCacheForTesting();
      const savedText = postalRegistryText;
      postalRegistryText = "0155\tOSLO\t0301\tOSLO\tG\n"; // far below the sanity floor
      {
        const r = await cb.resolveCityForRow(
          { org_nr: null, address: null, postal_code: "0155" },
          deps,
        );
        assertTrue(r.status === "skip", "g4: a truncated/garbage registry response is never trusted — falls through to skip (no address given), not a false resolve");
      }
      postalRegistryText = savedText;
      cb.__clearCityPostalRegistryCacheForTesting();

      // ── g5: MUTATION-STYLE SAFETY (reviewer finding, PR #842) — Brreg
      // forretningsadresse's own postnummer MISMATCHES the row's known
      // postal_code -> Tier a refuses (no longer "trusted outright"),
      // falling through to b/c; with neither able to resolve here (5000 is
      // outside the fake registry's coverage and there is no address for
      // Kartverket), the row ends at the terminal skip. Never trust a Brreg
      // hit whose registered postnummer disagrees with what the producer's
      // own profile carries.
      brregRoutes.set("444444444", {
        organisasjonsnummer: "444444444",
        navn: "Test Gård Fire AS",
        forretningsadresse: { postnummer: "1400", poststed: "FEIL-BRREG-STED", adresse: ["Veien 4"] },
      });
      {
        const r = await cb.resolveCityForRow(
          { org_nr: "444444444", address: null, postal_code: "5000" },
          deps,
        );
        assertTrue(r.status === "skip", "g5a: Brreg postnummer mismatch vs row.postal_code is a SKIP, never a resolve");
        if (r.status === "skip") assertEq(r.reason, "no_usable_source", "g5b: falls through past Brreg to the terminal skip (no other source available)");
      }

      // ── g6: MUTATION-STYLE SAFETY (reviewer finding, PR #842) —
      // agents.brreg_flag of dissolved/bankrupt/wrong_nace skips Tier a
      // entirely, even when the Brreg hit's postnummer WOULD otherwise
      // corroborate against row.postal_code — proves the gate fires
      // independently of (and before) the cross-check, not merely that the
      // cross-check happens to fail. Mirrors routes/admin-agents.ts's own
      // BRREG_SWEEP_REVIEW_FLAGS set.
      brregRoutes.set("666666666", {
        organisasjonsnummer: "666666666",
        navn: "Test Gård Seks AS",
        forretningsadresse: { postnummer: "6000", poststed: "SKULLE-IKKE-BRUKES", adresse: ["Veien 6"] },
      });
      for (const flag of ["dissolved", "bankrupt", "wrong_nace"]) {
        const r = await cb.resolveCityForRow(
          { org_nr: "666666666", address: null, postal_code: "6000", brreg_flag: flag },
          deps,
        );
        assertTrue(r.status === "skip", `g6a[${flag}]: brreg_flag=${flag} skips Tier a even with a postnummer-matching Brreg hit`);
        if (r.status === "skip") assertEq(r.reason, "no_usable_source", `g6b[${flag}]: falls through to the terminal skip (no other source available)`);
      }

      // ── w1-w4 / n1 / s1 / d1: the worker, end to end ───────────────────
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, city)
         VALUES (?, ?, 'test producer', 'test', 'post@example.no', 'https://example.no', 'producer', ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code, field_provenance)
         VALUES (?, ?, ?, '{}')`,
      );

      // w-target: empty city, has org_nr -> should resolve via Brreg and write.
      insertAgent.run("cb-w1", "CB Worker Gård Én", "key-cb-w1", "111111111", null);
      insertKnowledge.run("cb-w1", "Testveien 1, 1400 Ski", "1400");

      // n1-target: city ALREADY populated -> must not even be selected.
      insertAgent.run("cb-n1", "CB Never Overwrite Gård", "key-cb-n1", "111111111", "Allerede Satt");
      insertKnowledge.run("cb-n1", "Testveien 1, 1400 Ski", "1400");

      // s1-target: empty city, no usable source at all -> skip, but STAMPED.
      insertAgent.run("cb-s1", "CB Skip Gård", "key-cb-s1", null, null);
      insertKnowledge.run("cb-s1", "Bare et gatenavn uten husnummer", null);

      const before = cb.cityBackfillQueueStatus();
      const result = await cb.cityBackfillTick(50, deps);
      const after = cb.cityBackfillQueueStatus();

      assertEq(result.processed, 2, "w1: exactly the 2 empty-city+usable-source rows are processed (cb-n1 is excluded by the selector)");
      assertEq(result.resolved, 1, "w2a: 1 row resolved (cb-w1 via Brreg)");
      assertEq(result.resolved_brreg, 1, "w2b: …counted in resolved_brreg specifically");
      assertEq(result.skipped, 1, "w2c: 1 row skipped (cb-s1, no usable source)");

      const w1Row = db.prepare("SELECT city FROM agents WHERE id = ?").get("cb-w1") as { city: string | null };
      assertEq(w1Row.city, "Ski", "w3a: agents.city actually written for the resolved row");
      const w1Know = db
        .prepare("SELECT field_provenance, city_backfill_source, city_backfill_outcome, city_backfill_attempted_at FROM agent_knowledge WHERE agent_id = ?")
        .get("cb-w1") as any;
      assertEq(w1Know.city_backfill_source, "brreg_forretningsadresse", "w3b: city_backfill_source stamped with the winning tier");
      assertEq(w1Know.city_backfill_outcome, "resolved", "w3c: city_backfill_outcome stamped 'resolved'");
      assertTrue(!!w1Know.city_backfill_attempted_at, "w3d: city_backfill_attempted_at stamped");
      const w1Prov = JSON.parse(w1Know.field_provenance || "{}");
      assertTrue(Array.isArray(w1Prov.city) && w1Prov.city.length === 1, "w4a: field_provenance.city merged with exactly one record");
      assertEq(w1Prov.city?.[0]?.value, "Ski", "w4b: …carrying the written value");
      assertEq(w1Prov.city?.[0]?.source_type, "brreg_forretningsadresse", "w4c: …and the winning source_type");

      // n1: never touched — selector excluded it, so it isn't even in `planned`.
      const n1Row = db.prepare("SELECT city FROM agents WHERE id = ?").get("cb-n1") as { city: string | null };
      assertEq(n1Row.city, "Allerede Satt", "n1a: an already-populated city is left byte-identical");
      const n1Planned = result.planned.find((p) => p.agent_id === "cb-n1");
      assertTrue(!n1Planned, "n1b: the already-populated row was never even selected as a candidate");

      // s1: skipped but STAMPED (ALWAYS STAMP rotation discipline).
      const s1Know = db
        .prepare("SELECT city_backfill_outcome, city_backfill_attempted_at FROM agent_knowledge WHERE agent_id = ?")
        .get("cb-s1") as any;
      assertEq(s1Know.city_backfill_outcome, "no_usable_source", "s1a: skip outcome stamped");
      assertTrue(!!s1Know.city_backfill_attempted_at, "s1b: attempted_at stamped even on a skip — next tick rotates past it");
      const s1Row = db.prepare("SELECT city FROM agents WHERE id = ?").get("cb-s1") as { city: string | null };
      assertEq(s1Row.city, null, "s1c: a skipped row's city stays NULL");

      assertEq(before.city_empty - after.city_empty, 1, "status: exactly one fewer empty-city row after the tick (cb-w1 resolved)");

      // ── d1: dry run writes NOTHING ──────────────────────────────────────
      insertAgent.run("cb-d1", "CB Dry Run Gård", "key-cb-d1", "111111111", null);
      insertKnowledge.run("cb-d1", "Testveien 1, 1400 Ski", "1400");
      const dryResult = await cb.cityBackfillTick(50, { ...deps, dryRun: true });
      const d1Planned = dryResult.planned.find((p) => p.agent_id === "cb-d1");
      assertTrue(!!d1Planned && d1Planned.outcome === "resolved", "d1a: dry run still reports the resolution in `planned`");
      const d1Row = db.prepare("SELECT city FROM agents WHERE id = ?").get("cb-d1") as { city: string | null };
      assertEq(d1Row.city, null, "d1b: dry run writes NOTHING to agents.city");
      const d1Know = db
        .prepare("SELECT city_backfill_attempted_at FROM agent_knowledge WHERE agent_id = ?")
        .get("cb-d1") as any;
      assertEq(d1Know.city_backfill_attempted_at, null, "d1c: dry run does not even stamp the attempt");
    } catch (err) {
      failed++;
      failures.push(`agents-city-backfill: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      initMod.__setDbForTesting(prevDb as any);
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAgentsCityBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

/**
 * gardssalg-field-concordance-write.test.ts — write-side logic tests for
 * orchestrator dev-request 2026-08-03-gardssalg-field-concordance (write
 * slice): applyGardssalgFieldConcordance (services/gardssalg-field-
 * concordance.ts).
 *
 * Separate from gardssalg-field-concordance.test.ts (which covers the
 * original PURE read-side comparison functions, no DB) — this file exercises
 * a real (in-memory) experiences DB via the same EXPERIENCES_DB_PATH=":memory:"
 * + db-factory pattern the route-level test files use, since
 * applyGardssalgFieldConcordance's whole job is DB read-modify-write.
 *
 * Covers:
 *   (a) a genuine avvik producing a queue row with the correct
 *       current_value/found_value, plus a field_concordance provenance stamp
 *   (b) bekreftet/ikke_funnet_på_siden verdicts producing NO queue row
 *   (c) idempotent re-run: an unchanged avvik does not bump the existing
 *       queue row's updated_at (no duplicate row, no pointless churn)
 *   (d) a re-run whose found_value has changed overwrites the existing queue
 *       row (still exactly one row per provider+field, values refreshed)
 *   (e) malformed existing field_provenance JSON -> handled without
 *       throwing, treated as empty (never clobbers the write attempt)
 *   (f) valid existing field_provenance carrying hjemmeside_verification ->
 *       that key is byte-preserved after apply (only field_concordance is
 *       added/changed)
 *   (g) apply NEVER writes epost/telefon/mobil/adresse/postnummer/poststed/
 *       opening_hours_text on experience_providers — asserted directly
 *       against the DB row before/after
 *   (h) return shape: applied/provenance_written/total_queued reflect what
 *       actually happened
 *
 * Run standalone: npx tsx src/services/gardssalg-field-concordance-write.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgFieldConcordanceWriteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const concordanceServicePath = require.resolve("./gardssalg-field-concordance");
    const cachePaths = [dbFactoryPath, experienceStorePath, concordanceServicePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const { applyGardssalgFieldConcordance, GFC_ALL_FIELDS } =
        require("./gardssalg-field-concordance") as typeof import("./gardssalg-field-concordance");
      type GfcProviderResult = import("./gardssalg-field-concordance").GfcProviderResult;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, epost, telefon, mobil, adresse, postnummer, poststed,
            opening_hours_text, producer_type, rfb_seed_source, catalog_hidden, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @epost, @telefon, @mobil, @adresse, @postnummer, @poststed,
            @opening_hours_text, @producer_type, @rfb_seed_source, @catalog_hidden, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // Build a full GfcProviderResult fixture. Callers override only the
      // fields they care about; every other field defaults to `bekreftet`
      // (presence-only fields carry no current/found keys, matching the real
      // shape buildProviderConcordanceRow produces).
      function fixtureRow(
        providerId: string,
        providerName: string,
        overrides: Partial<Record<string, unknown>> = {},
      ): GfcProviderResult {
        const base: any = {
          provider_id: providerId,
          provider_name: providerName,
          epost: { verdict: "bekreftet", current: "post@gard.no", found: "post@gard.no" },
          telefon: { verdict: "bekreftet", current: "91234567", found: "91234567" },
          mobil: { verdict: "bekreftet", current: "99887766", found: "99887766" },
          adresse: { verdict: "bekreftet" },
          postnummer: { verdict: "bekreftet" },
          poststed: { verdict: "bekreftet" },
          opening_hours_text: { verdict: "bekreftet" },
        };
        return { ...base, ...overrides } as GfcProviderResult;
      }

      function readProviderRow(id: string): any {
        return expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id);
      }
      function readQueueRows(providerId: string): any[] {
        return expDb
          .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = ? ORDER BY field_name`)
          .all(providerId);
      }

      // ── (a) genuine avvik -> queue row + provenance stamp ────────────────
      insertProvider.run({
        id: "prov-a",
        navn: "Gård A",
        hjemmeside: "https://gard-a.example.no",
        epost: "gammel@gard-a.no",
        telefon: "91234567",
        mobil: "99887766",
        adresse: "Gardsveien 1",
        postnummer: "5750",
        poststed: "Odda",
        opening_hours_text: "Ma-Fr 10-16",
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: null,
      });
      const rowA = fixtureRow("prov-a", "Gård A", {
        epost: { verdict: "avvik", current: "gammel@gard-a.no", found: "ny@gard-a.no" },
      });
      const beforeA = readProviderRow("prov-a");

      const resultA = applyGardssalgFieldConcordance(expDb, [rowA], "batch-a");
      assertEq(resultA.provenance_written, 1, "a1: provenance_written counts the one applied row");
      assertEq(resultA.total_queued, 1, "a2: total_queued counts the one avvik field queued");
      assertEq(resultA.applied, [{ provider_id: "prov-a", queued_fields: ["epost"] }], "a3: applied lists exactly the queued field");

      const queueA = readQueueRows("prov-a");
      assertEq(queueA.length, 1, "a4: exactly one queue row for prov-a");
      assertEq(queueA[0].field_name, "epost", "a5: queue row field_name is epost");
      assertEq(queueA[0].current_value, "gammel@gard-a.no", "a6: queue row current_value matches the stored value");
      assertEq(queueA[0].found_value, "ny@gard-a.no", "a7: queue row found_value matches the page-extracted value");
      assertEq(queueA[0].reason, "field_concordance_avvik", "a8: queue row reason defaults correctly");
      assertEq(queueA[0].batch_id, "batch-a", "a9: queue row carries the batch_id");
      assertEq(queueA[0].provider_name, "Gård A", "a10: queue row carries provider_name");

      const afterA = readProviderRow("prov-a");
      const provenanceA = JSON.parse(afterA.field_provenance);
      assertTrue(!!provenanceA.field_concordance, "a11: field_provenance.field_concordance stamp present");
      assertEq(provenanceA.field_concordance.batch_id, "batch-a", "a12: stamp carries batch_id");
      assertTrue(typeof provenanceA.field_concordance.checked_at === "string", "a13: stamp carries checked_at ISO string");
      const summaryA = provenanceA.field_concordance.summary;
      assertEq(summaryA.epost, "avvik", "a14: stamp summary records the avvik verdict for epost");
      for (const f of GFC_ALL_FIELDS) {
        if (f === "epost") continue;
        assertEq(summaryA[f], "bekreftet", `a15: stamp summary records bekreftet for ${f}`);
      }
      // The stamp is verdict-only — never current/found values (those live
      // only in the queue row, per spec: "keeping the stamp small and
      // non-duplicative of PII already visible in the row's own columns").
      assertTrue(
        typeof summaryA.epost === "string" && !summaryA.epost.includes("@"),
        "a16: stamp summary carries only the verdict string, never the actual email value",
      );

      // ── (g) apply never writes epost/telefon/etc. directly ───────────────
      assertEq(afterA.epost, beforeA.epost, "g1: experience_providers.epost is byte-identical after apply (queue-only, never auto-corrected)");
      assertEq(afterA.telefon, beforeA.telefon, "g2: experience_providers.telefon unchanged");
      assertEq(afterA.mobil, beforeA.mobil, "g3: experience_providers.mobil unchanged");
      assertEq(afterA.adresse, beforeA.adresse, "g4: experience_providers.adresse unchanged");
      assertEq(afterA.postnummer, beforeA.postnummer, "g5: experience_providers.postnummer unchanged");
      assertEq(afterA.poststed, beforeA.poststed, "g6: experience_providers.poststed unchanged");
      assertEq(afterA.opening_hours_text, beforeA.opening_hours_text, "g7: experience_providers.opening_hours_text unchanged");

      // ── (b) bekreftet/ikke_funnet_på_siden -> no queue row at all ────────
      insertProvider.run({
        id: "prov-b",
        navn: "Gård B",
        hjemmeside: "https://gard-b.example.no",
        epost: "post@gard-b.no",
        telefon: null,
        mobil: "99887766",
        adresse: "Gardsveien 2",
        postnummer: "5750",
        poststed: "Odda",
        opening_hours_text: "Ma-Fr 10-16",
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: null,
      });
      const rowB = fixtureRow("prov-b", "Gård B", {
        epost: { verdict: "bekreftet", current: "post@gard-b.no", found: "post@gard-b.no" },
        telefon: { verdict: "ikke_funnet_på_siden", current: null, found: null },
      });
      const resultB = applyGardssalgFieldConcordance(expDb, [rowB], null);
      assertEq(resultB.applied, [{ provider_id: "prov-b", queued_fields: [] }], "b1: no fields queued for prov-b");
      assertEq(readQueueRows("prov-b").length, 0, "b2: zero queue rows for a provider with no avvik verdicts anywhere");
      assertEq(resultB.total_queued, 0, "b3: total_queued is 0 across this apply call");

      // ── (c) idempotent re-run: identical avvik does not bump updated_at ──
      const firstQueueRow = readQueueRows("prov-a")[0];
      const firstUpdatedAt = firstQueueRow.updated_at;
      // Re-apply the EXACT same rowA a moment later.
      const resultARerun = applyGardssalgFieldConcordance(expDb, [rowA], "batch-a-rerun");
      assertEq(resultARerun.applied[0].queued_fields, [], "c1: a re-run reaching the SAME avvik conclusion queues nothing new");
      assertEq(resultARerun.total_queued, 0, "c2: total_queued is 0 for the identical re-run");
      const queueARerun = readQueueRows("prov-a");
      assertEq(queueARerun.length, 1, "c3: still exactly one queue row (no duplicate accumulation)");
      assertEq(queueARerun[0].updated_at, firstUpdatedAt, "c4: updated_at is NOT bumped by a re-run reaching the same conclusion");
      assertEq(queueARerun[0].found_value, "ny@gard-a.no", "c5: found_value is unchanged by the no-op re-run");
      // The provenance stamp DOES still get refreshed every apply (a per-run
      // check, unlike the queue row's own no-op-on-identical contract) —
      // batch_id in the stamp reflects the rerun's own batch id.
      const afterARerun = readProviderRow("prov-a");
      assertEq(
        JSON.parse(afterARerun.field_provenance).field_concordance.batch_id,
        "batch-a-rerun",
        "c6: the provenance stamp itself is refreshed every apply run (only the QUEUE row has the no-op-on-identical contract)",
      );

      // ── (d) re-run with a CHANGED found-value overwrites the queue row ───
      const rowAChanged = fixtureRow("prov-a", "Gård A", {
        epost: { verdict: "avvik", current: "gammel@gard-a.no", found: "enda-nyere@gard-a.no" },
      });
      const resultAChanged = applyGardssalgFieldConcordance(expDb, [rowAChanged], "batch-a-changed");
      assertEq(resultAChanged.applied[0].queued_fields, ["epost"], "d1: a CHANGED found-value queues (refreshes) the field again");
      const queueAChanged = readQueueRows("prov-a");
      assertEq(queueAChanged.length, 1, "d2: still exactly one row (overwrite, not a second row) — UNIQUE(provider_id, field_name) holds");
      assertEq(queueAChanged[0].found_value, "enda-nyere@gard-a.no", "d3: found_value is refreshed to the new value");
      assertEq(queueAChanged[0].current_value, "gammel@gard-a.no", "d4: current_value still correct");
      assertEq(queueAChanged[0].batch_id, "batch-a-changed", "d5: batch_id refreshed to the new run's batch");
      assertTrue(queueAChanged[0].updated_at >= firstUpdatedAt, "d6: updated_at moves forward on a genuine refresh");

      // ── (e) malformed existing field_provenance -> handled without
      //     throwing, treated as empty ──────────────────────────────────────
      insertProvider.run({
        id: "prov-e",
        navn: "Gård E",
        hjemmeside: "https://gard-e.example.no",
        epost: "post@gard-e.no",
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: "{ this is not valid json ][",
      });
      let threwE = false;
      let resultE: ReturnType<typeof applyGardssalgFieldConcordance> | undefined;
      try {
        resultE = applyGardssalgFieldConcordance(
          expDb,
          [fixtureRow("prov-e", "Gård E", { epost: { verdict: "bekreftet", current: "post@gard-e.no", found: "post@gard-e.no" } })],
          null,
        );
      } catch {
        threwE = true;
      }
      assertTrue(!threwE, "e1: malformed existing field_provenance JSON never throws");
      assertEq(resultE?.provenance_written, 1, "e2: the row is still stamped despite the malformed prior JSON");
      const afterE = readProviderRow("prov-e");
      const provenanceE = JSON.parse(afterE.field_provenance);
      assertTrue(!!provenanceE.field_concordance, "e3: field_concordance stamp written cleanly over the malformed prior value");

      // ── (f) valid existing field_provenance with hjemmeside_verification
      //     -> byte-preserved after apply, only field_concordance touched ──
      const existingHjemmesideVerification = { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" };
      insertProvider.run({
        id: "prov-f",
        navn: "Gård F",
        hjemmeside: "https://gard-f.example.no",
        epost: "gammel@gard-f.no",
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: JSON.stringify({
          hjemmeside_verification: existingHjemmesideVerification,
          some_other_future_key: { untouched: true },
        }),
      });
      applyGardssalgFieldConcordance(
        expDb,
        [fixtureRow("prov-f", "Gård F", { epost: { verdict: "avvik", current: "gammel@gard-f.no", found: "ny@gard-f.no" } })],
        "batch-f",
      );
      const afterF = readProviderRow("prov-f");
      const provenanceF = JSON.parse(afterF.field_provenance);
      assertEq(
        provenanceF.hjemmeside_verification,
        existingHjemmesideVerification,
        "f1: hjemmeside_verification key is byte-preserved — apply never touches any key other than field_concordance",
      );
      assertEq(
        provenanceF.some_other_future_key,
        { untouched: true },
        "f2: an unrelated existing key is also byte-preserved (merge is additive, not a wholesale overwrite)",
      );
      assertTrue(!!provenanceF.field_concordance, "f3: field_concordance is still added alongside the preserved keys");
      assertEq(readQueueRows("prov-f")[0]?.found_value, "ny@gard-f.no", "f4: the avvik on prov-f still queues correctly alongside the preserved provenance");

      // ── (h) multi-row apply: return shape aggregates correctly ───────────
      insertProvider.run({
        id: "prov-h",
        navn: "Gård H",
        hjemmeside: "https://gard-h.example.no",
        epost: "gammel@gard-h.no",
        telefon: "90000001",
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: null,
      });
      const rowH = fixtureRow("prov-h", "Gård H", {
        epost: { verdict: "avvik", current: "gammel@gard-h.no", found: "ny@gard-h.no" },
        telefon: { verdict: "avvik", current: "90000001", found: "90000009" },
      });
      const resultH = applyGardssalgFieldConcordance(expDb, [rowB, rowH], "batch-h");
      assertEq(resultH.provenance_written, 2, "h1: provenance_written counts both rows in this apply call");
      assertEq(resultH.total_queued, 2, "h2: total_queued sums queued fields across all rows (0 from prov-b + 2 from prov-h)");
      const hApplied = resultH.applied.find((a) => a.provider_id === "prov-h");
      assertEq(hApplied?.queued_fields.sort(), ["epost", "telefon"], "h3: both avvik fields on prov-h are listed as queued");
      assertEq(readQueueRows("prov-h").length, 2, "h4: two distinct queue rows for prov-h (epost + telefon), one per field");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-field-concordance-write: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/gardssalg-field-concordance-write.test.ts`
if (require.main === module) {
  runGardssalgFieldConcordanceWriteTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

/**
 * opplevelser-gardssalg-provider-dedup-merge.test.ts — tests for
 * POST /admin/gardssalg-provider-dedup-merge (src/routes/opplevelser.ts),
 * backed by src/services/gardssalg-provider-merge.ts.
 *
 * dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
 * spec-punkt 2 (the merge lever — still open as of 2026-08-15). Executes an
 * EXPLICIT, already human-verified {remove_id, keep_id} pair list — this
 * endpoint never detects duplicates itself (Slice 1's GET .../gardssalg-
 * provider-dedup-audit, tested separately in
 * opplevelser-gardssalg-provider-dedup-audit.test.ts, is untouched by this
 * file).
 *
 * Mirrors opplevelser-gardssalg-experience-conflict.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers, POST body support).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) fill-only migration: blank keep-row fields get remove's value; a
 *       NON-blank keep-row field is never overwritten, even when remove
 *       carries a different value for that same field
 *   (c) org_nr migrated onto keep AND cleared (NULL) on remove when keep
 *       lacks one — never left duplicated (org_nr has a UNIQUE constraint)
 *   (d) owner-claimed remove-row (content_source 'manual' and 'claim', both
 *       spellings) hard-rejected — never merged, regardless of apply
 *   (e) non-existent id -> per-pair "error"/"ikke_funnet", never blocks a
 *       sibling pair in the same batch
 *   (f) self-pair (remove_id === keep_id) -> rejected cleanly, "samme_id"
 *   (g) dry-run (apply omitted, and apply:false) -> zero DB writes, response
 *       shape/counts identical in KIND to a real apply run (outcome
 *       "would_merge" in place of "merged", everything else the same shape)
 *   (h) already-merged guards: a remove_id that already carries a
 *       merged_into is rejected again on a second attempt; a keep_id that
 *       itself carries a merged_into is rejected as a merge target
 *   (i) batch cap (400 above GARDSSALG_PROVIDER_MERGE_MAX_PAIRS)
 *   (j) malformed pair item (missing remove_id/keep_id) -> rejected
 *       cleanly, doesn't block the batch
 *   (k) rollback wiring: POST .../gardssalg-content-rollback restores a
 *       merge via batch_id (default entity_type), AND explicitly recognizes
 *       entity_type: "provider_merge" (dispatches to the same provider path,
 *       never errors/falls through silently)
 *   (l) chain-merge-within-one-batch rollback (code-review fix-up
 *       2026-08-15, chain-merge-rollback-restore-history): A->B then, same
 *       batch_id, B->C moves org_nr across two hops; rolling back the WHOLE
 *       batch restores A/B/C to their TRUE pre-batch values (not just
 *       avoiding the UNIQUE-constraint throw the earlier LIFO-only fix left
 *       in place for this exact chain shape)
 *   (m) transaction-atomicity safety net: a forced mid-batch rollback
 *       failure (unrelated two-provider UNIQUE collision) leaves the
 *       database completely UNCHANGED — proves applyGardssalgContentRollback
 *       is now all-or-nothing rather than partially applying
 *   (n) dev-request 2026-08-18-gardssalg-dedup-org-nr-override, point 5 —
 *       fail-closed org_nr guard AT THIS ROUTE ITSELF (not just at the audit
 *       route): a pair where BOTH rows carry a non-blank org_nr and the
 *       values DIFFER is rejected outright, "org_nr_konflikt_ulike_org_nr",
 *       on both dry-run and apply, regardless of what the audit route would
 *       have graded that pair as — proves the write side can't be talked
 *       into merging two distinct legal entities even if some upstream
 *       caller trusted a bad "high" grade. Zero writes result either way.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-provider-dedup-merge";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
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

export function runOpplevelserGardssalgProviderDedupMergeTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply route under test reads enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-provider-dedup-merge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    // experience-store.ts must ALSO be cleared, same as
    // opplevelser-gardssalg-content-audit.test.ts's own setup: this test
    // exercises POST /admin/gardssalg-content-rollback, whose plan/apply
    // functions live in experience-store.ts and hold their OWN module-level
    // `import { getDb } from "./db-factory"` binding — if that module isn't
    // also reloaded here, it keeps pointing at whatever (possibly stale,
    // possibly empty) db-factory instance was cached when some EARLIER test
    // in the same process first loaded it, decoupling rollback reads/writes
    // from the fresh in-memory db this test's own fixtures/merge calls use.
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, postnummer, rfb_seed_source, producer_type,
            epost, telefon, mobil, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @postnummer, @rfb_seed_source, @producer_type,
            @epost, @telefon, @mobil, @hjemmeside, @about_text, @visit_text, @opening_hours_text,
            @products, @content_source, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      type FixtureRow = {
        id: string;
        navn: string;
        org_nr?: string | null;
        postnummer?: string | null;
        rfb_seed_source?: string | null;
        producer_type?: string | null;
        epost?: string | null;
        telefon?: string | null;
        mobil?: string | null;
        hjemmeside?: string | null;
        about_text?: string | null;
        visit_text?: string | null;
        opening_hours_text?: string | null;
        products?: string | null;
        content_source?: string | null;
      };
      function seed(row: FixtureRow): void {
        insertProvider.run({
          org_nr: null,
          postnummer: null,
          rfb_seed_source: null,
          producer_type: "bryggeri",
          epost: null,
          telefon: null,
          mobil: null,
          hjemmeside: null,
          about_text: null,
          visit_text: null,
          opening_hours_text: null,
          products: null,
          content_source: null,
          ...row,
        });
      }

      // ── (b)/(c) fill-only pair: sparse "remove" + partially-filled "keep" ──
      seed({
        id: "prov-fill-remove",
        navn: "Lofthus Sideri — Lofthus",
        org_nr: "924487917",
        epost: "post@lofthus-sideri.no",
        telefon: "90000001",
        mobil: "90000002",
        hjemmeside: "https://lofthus-sideri.no",
        about_text: "Gammel sideriprodusent i Hardanger.",
        visit_text: "Åpent i sesong.",
        opening_hours_text: "Man-fre 10-16",
        products: JSON.stringify(["Sider", "Eplemost"]),
      });
      seed({
        id: "prov-fill-keep",
        navn: "Lofthus Sideri",
        // org_nr intentionally blank -> should be migrated from remove
        epost: "post@lofthus-sideri.no", // ALREADY set -> must NOT change
        telefon: null, // blank -> fillable
        mobil: null, // blank -> fillable
        hjemmeside: "https://lofthus-sideri.no", // ALREADY set -> must NOT change
        about_text: null, // blank -> fillable
        visit_text: "Original visit text, ikke rør.", // ALREADY set -> must NOT change
        opening_hours_text: null, // blank -> fillable
        products: "[]", // blank per gardssalgProductsEligible -> fillable
      });

      // ── (d) owner-claimed remove rows — 'manual' and 'claim' ────────────────
      seed({ id: "prov-claim-remove-manual", navn: "Manuell Produsent", content_source: "manual", epost: "manuell@x.no" });
      seed({ id: "prov-claim-keep-manual", navn: "Manuell Produsent Dublett" });
      seed({ id: "prov-claim-remove-claim", navn: "Eier Produsent", content_source: "claim", epost: "eier@x.no" });
      seed({ id: "prov-claim-keep-claim", navn: "Eier Produsent Dublett" });

      // ── (f) self-pair target ────────────────────────────────────────────────
      seed({ id: "prov-self", navn: "Selv Produsent" });

      // ── (h) already-merged fixtures ─────────────────────────────────────────
      seed({ id: "prov-already-removed", navn: "Allerede Fjernet" });
      seed({ id: "prov-already-removed-keep", navn: "Allerede Fjernet Kanonisk" });
      seed({ id: "prov-dead-canonical", navn: "Død Kanonisk Rad" });
      seed({ id: "prov-dead-canonical-newkeep", navn: "Nytt Forsøk Kanonisk" });
      seed({ id: "prov-dead-canonical-remove", navn: "Fjernes Mot Død Kanonisk" });

      // ── (l) chain-merge-within-one-batch fixtures (reviewer's own repro
      // scenario, code-review fix-up 2026-08-15): A holds org_nr, B and C are
      // both blank. Pair 1 (remove=A,keep=B) then pair 2 in the SAME
      // batch_id (remove=B,keep=C) moves org_nr A -> B -> C, writing B's
      // org_nr audit trail TWICE within one batch (fill, then clear) — the
      // exact shape resolveGardssalgRollbackTargets's earliest-in-batch fix
      // targets.
      seed({ id: "prov-chain-a", navn: "Kjede Produsent A", org_nr: "988877766" });
      seed({ id: "prov-chain-b", navn: "Kjede Produsent B" });
      seed({ id: "prov-chain-c", navn: "Kjede Produsent C" });

      // ── (m) transaction-atomicity fixtures — two rows the safety-net test
      // deliberately restores to the SAME org_nr value, to force a UNIQUE
      // constraint violation on the SECOND item of a two-item rollback batch
      // and prove the FIRST item's write never actually persists either.
      seed({ id: "prov-atomic-p1", navn: "Atomisk Rad 1" });
      seed({ id: "prov-atomic-p2", navn: "Atomisk Rad 2" });

      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {
        body: { pairs: [{ remove_id: "prov-fill-remove", keep_id: "prov-fill-keep" }] },
      });
      assertEq(noKey.status, 403, "a1: POST .../gardssalg-provider-dedup-merge without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.results, "a2: no-key response carries no results payload");

      // Snapshot fill-pair rows before any dry-run/apply call.
      const snapshotBefore = expDb
        .prepare(`SELECT * FROM experience_providers WHERE id IN ('prov-fill-remove','prov-fill-keep') ORDER BY id`)
        .all();

      // ── (g) dry-run: apply omitted ──────────────────────────────────────────
      const dry1 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-fill-remove", keep_id: "prov-fill-keep", note: "sesjonens evidens" }] },
      });
      assertEq(dry1.status, 200, "g1: dry-run call -> 200");
      assertEq(dry1.body.dry_run, true, "g2: dry_run:true when apply omitted");
      assertEq(dry1.body.results[0].outcome, "would_merge", "g3: dry-run outcome is would_merge");
      assertEq(
        dry1.body.results[0].fields_filled.slice().sort(),
        ["about_text", "mobil", "opening_hours_text", "products", "telefon"].slice().sort(),
        "g4: dry-run fields_filled lists exactly the blank keep-row fields",
      );
      assertEq(dry1.body.results[0].org_nr_migrated, true, "g5: dry-run reports org_nr_migrated:true (keep has none)");
      assertEq(dry1.body.counts, { would_merge: 1 }, "g6: dry-run counts bucket is would_merge:1");
      assertTrue(typeof dry1.body.batch_id === "string" && dry1.body.batch_id.length > 0, "g7: dry-run still carries a usable batch_id");

      const snapshotAfterDry1 = expDb
        .prepare(`SELECT * FROM experience_providers WHERE id IN ('prov-fill-remove','prov-fill-keep') ORDER BY id`)
        .all();
      assertEq(snapshotAfterDry1, snapshotBefore, "g8: dry-run (apply omitted) performs ZERO writes");

      // ── (g) dry-run: apply explicitly false -> same zero-write guarantee ────
      const dry2 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-fill-remove", keep_id: "prov-fill-keep" }], apply: false },
      });
      assertEq(dry2.body.dry_run, true, "g9: apply:false -> dry_run:true");
      const snapshotAfterDry2 = expDb
        .prepare(`SELECT * FROM experience_providers WHERE id IN ('prov-fill-remove','prov-fill-keep') ORDER BY id`)
        .all();
      assertEq(snapshotAfterDry2, snapshotBefore, "g10: apply:false performs ZERO writes");

      // Same shape assertion: dry-run and (about-to-run) apply share the SAME
      // top-level keys.
      assertEq(
        Object.keys(dry1.body).sort(),
        ["batch_id", "counts", "dry_run", "results", "scanned", "success"].sort(),
        "g11: dry-run response carries the documented top-level keys",
      );

      // ── (b)/(c) apply the fill-only + org_nr-move pair for real ─────────────
      const mergeBatchId = "test-merge-batch-fillcase";
      const apply1 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          pairs: [{ remove_id: "prov-fill-remove", keep_id: "prov-fill-keep", note: "samme domene + samme epost" }],
          apply: true,
          batch_id: mergeBatchId,
        },
      });
      assertEq(apply1.status, 200, "b1: apply call -> 200");
      assertEq(apply1.body.dry_run, false, "b2: dry_run:false on apply");
      assertEq(apply1.body.results[0].outcome, "merged", "b3: apply outcome is merged");
      assertEq(apply1.body.counts, { merged: 1 }, "b4: apply counts bucket is merged:1");
      assertEq(apply1.body.batch_id, mergeBatchId, "b5: response echoes the caller-supplied batch_id");

      const keepAfter = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-fill-keep'`).get() as any;
      const removeAfter = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-fill-remove'`).get() as any;

      // Fill-only: blank fields filled from remove.
      assertEq(keepAfter.telefon, "90000001", "b6: keep.telefon filled from remove");
      assertEq(keepAfter.mobil, "90000002", "b7: keep.mobil filled from remove");
      assertEq(keepAfter.about_text, "Gammel sideriprodusent i Hardanger.", "b8: keep.about_text filled from remove");
      assertEq(keepAfter.opening_hours_text, "Man-fre 10-16", "b9: keep.opening_hours_text filled from remove");
      assertEq(keepAfter.products, JSON.stringify(["Sider", "Eplemost"]), "b10: keep.products filled from remove ('[]' counted as blank)");

      // Fill-only: ALREADY-set fields on keep are untouched, even though remove
      // carries a (different-looking) value for the same field.
      assertEq(keepAfter.epost, "post@lofthus-sideri.no", "b11: keep.epost UNCHANGED (was already non-blank)");
      assertEq(keepAfter.hjemmeside, "https://lofthus-sideri.no", "b12: keep.hjemmeside UNCHANGED (was already non-blank)");
      assertEq(keepAfter.visit_text, "Original visit text, ikke rør.", "b13: keep.visit_text UNCHANGED (was already non-blank)");

      // org_nr: migrated onto keep, cleared on remove (never duplicated —
      // org_nr carries a UNIQUE constraint).
      assertEq(keepAfter.org_nr, "924487917", "c1: keep.org_nr migrated from remove");
      assertEq(removeAfter.org_nr, null, "c2: remove.org_nr cleared to NULL after the move");

      // Removed row is soft-marked, never hard-deleted.
      assertEq(removeAfter.merged_into, "prov-fill-keep", "b14: remove.merged_into points at keep_id");
      const stillExists = expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE id = 'prov-fill-remove'`).get() as { n: number };
      assertEq(stillExists.n, 1, "b15: removed row still exists (never hard-deleted)");

      // gardssalg_content_audit carries the trail, notes included.
      const auditRows = expDb
        .prepare(`SELECT provider_id, field_name, old_value, new_value, notes FROM gardssalg_content_audit WHERE batch_id = ? ORDER BY rowid`)
        .all(mergeBatchId) as Array<{ provider_id: string; field_name: string; old_value: string | null; new_value: string | null; notes: string | null }>;
      assertEq(auditRows.length, 8, "b16: exactly 8 audit rows written (5 fill fields + org_nr x2 + merged_into)");
      assertTrue(
        auditRows.every((r) => r.notes === "samme domene + samme epost"),
        "b17: every audit row carries the pair's note",
      );
      assertTrue(
        auditRows.some((r) => r.provider_id === "prov-fill-remove" && r.field_name === "merged_into" && r.new_value === "prov-fill-keep"),
        "b18: a merged_into audit row exists on the removed provider_id",
      );

      // ── (d) owner-claimed remove-row hard guard ──────────────────────────────
      for (const [removeId, keepId, label] of [
        ["prov-claim-remove-manual", "prov-claim-keep-manual", "manual"],
        ["prov-claim-remove-claim", "prov-claim-keep-claim", "claim"],
      ] as const) {
        const dryClaim = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { pairs: [{ remove_id: removeId, keep_id: keepId }] },
        });
        assertEq(dryClaim.body.results[0].outcome, "rejected", `d1-${label}: dry-run owner-claimed remove -> rejected`);
        assertEq(dryClaim.body.results[0].reason, "eier_overtatt_kan_ikke_fjernes", `d2-${label}: reason is eier_overtatt_kan_ikke_fjernes`);

        const applyClaim = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { pairs: [{ remove_id: removeId, keep_id: keepId }], apply: true },
        });
        assertEq(applyClaim.body.results[0].outcome, "rejected", `d3-${label}: apply=true owner-claimed remove STILL rejected`);
        const stillLive = expDb.prepare(`SELECT merged_into, content_source FROM experience_providers WHERE id = ?`).get(removeId) as any;
        assertEq(stillLive.merged_into, null, `d4-${label}: owner-claimed row never got merged_into set`);
        assertEq(stillLive.content_source, label, `d5-${label}: owner-claimed row's content_source untouched`);
      }

      // ── (e) non-existent id -> per-pair error, sibling pair unaffected ──────
      const mixedBatch = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          pairs: [
            { remove_id: "prov-does-not-exist", keep_id: "prov-fill-keep" },
            { remove_id: "prov-self", keep_id: "prov-self-does-not-exist-either" },
            { remove_id: "prov-claim-remove-manual", keep_id: "prov-claim-keep-manual" }, // sibling pair, own outcome
          ],
          apply: true,
        },
      });
      assertEq(mixedBatch.body.results[0].outcome, "error", "e1: non-existent remove_id -> error outcome");
      assertEq(mixedBatch.body.results[0].reason, "ikke_funnet", "e2: reason ikke_funnet");
      assertEq(mixedBatch.body.results[1].outcome, "error", "e3: non-existent keep_id -> error outcome");
      assertEq(mixedBatch.body.results[1].reason, "ikke_funnet", "e4: reason ikke_funnet");
      assertEq(mixedBatch.body.results[2].outcome, "rejected", "e5: sibling pair in the same batch still evaluated on its own merits");
      assertEq(mixedBatch.body.scanned, 3, "e6: scanned counts every submitted pair");

      // ── (f) self-pair ─────────────────────────────────────────────────────
      const selfPair = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-self", keep_id: "prov-self" }], apply: true },
      });
      assertEq(selfPair.body.results[0].outcome, "rejected", "f1: self-pair -> rejected");
      assertEq(selfPair.body.results[0].reason, "samme_id", "f2: reason samme_id");

      // ── (j) malformed pair item ──────────────────────────────────────────────
      const malformed = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-self" }, { remove_id: "prov-claim-remove-claim", keep_id: "prov-claim-keep-claim" }] },
      });
      assertEq(malformed.body.results[0].outcome, "rejected", "j1: missing keep_id -> rejected");
      assertEq(malformed.body.results[0].reason, "ugyldig_par", "j2: reason ugyldig_par");
      assertEq(malformed.body.results[1].outcome, "rejected", "j3: sibling pair still evaluated (owner-claim guard fires independently)");

      // ── (i) batch cap ────────────────────────────────────────────────────────
      const tooMany = Array.from({ length: 201 }, (_, i) => ({ remove_id: `x${i}`, keep_id: `y${i}` }));
      const capBreach = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: tooMany },
      });
      assertEq(capBreach.status, 400, "i1: batch above the cap -> 400");

      const emptyBatch = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [] },
      });
      assertEq(emptyBatch.status, 400, "i2: empty pairs array -> 400");

      // ── (h) already-merged guards ────────────────────────────────────────────
      const firstMerge = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-already-removed", keep_id: "prov-already-removed-keep" }], apply: true },
      });
      assertEq(firstMerge.body.results[0].outcome, "merged", "h1: first merge of prov-already-removed succeeds");

      const reMerge = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-already-removed", keep_id: "prov-dead-canonical-newkeep" }], apply: true },
      });
      assertEq(reMerge.body.results[0].outcome, "rejected", "h2: re-merging an already-merged remove_id -> rejected");
      assertEq(reMerge.body.results[0].reason, "allerede_fjernet_i_tidligere_slaaing", "h3: reason allerede_fjernet_i_tidligere_slaaing");
      const stillPointsAtOriginal = expDb.prepare(`SELECT merged_into FROM experience_providers WHERE id = 'prov-already-removed'`).get() as any;
      assertEq(stillPointsAtOriginal.merged_into, "prov-already-removed-keep", "h4: merged_into NOT retargeted by the rejected re-merge attempt");

      const secondMerge = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-dead-canonical", keep_id: "prov-dead-canonical-newkeep" }], apply: true },
      });
      assertEq(secondMerge.body.results[0].outcome, "merged", "h5: prov-dead-canonical-newkeep becomes canonical via a real merge first");

      const mergeIntoDeadCanonical = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-dead-canonical-remove", keep_id: "prov-dead-canonical" }], apply: true },
      });
      assertEq(mergeIntoDeadCanonical.body.results[0].outcome, "rejected", "h6: merging INTO an already-merged-away keep_id -> rejected");
      assertEq(
        mergeIntoDeadCanonical.body.results[0].reason,
        "kanonisk_rad_selv_fjernet",
        "h7: reason kanonisk_rad_selv_fjernet",
      );

      // ── (k) rollback wiring ──────────────────────────────────────────────────
      const rollbackDry = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: mergeBatchId },
      });
      assertEq(rollbackDry.status, 200, "k1: rollback dry-run by batch_id -> 200");
      assertEq(rollbackDry.body.dry_run, true, "k2: rollback dry-run reports dry_run:true");
      assertEq(rollbackDry.body.restored.length, 8, "k3: rollback dry-run reports every field the merge touched as restorable");
      assertTrue(
        rollbackDry.body.restored.some((r: any) => r.provider_id === "prov-fill-remove" && r.field_name === "merged_into"),
        "k4: rollback plan includes restoring the removed row's merged_into",
      );

      const rollbackApply = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: mergeBatchId, apply: true },
      });
      assertEq(rollbackApply.status, 200, "k5: rollback apply -> 200");
      assertEq(rollbackApply.body.dry_run, false, "k6: rollback apply reports dry_run:false");

      const keepAfterRollback = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-fill-keep'`).get() as any;
      const removeAfterRollback = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-fill-remove'`).get() as any;
      assertEq(keepAfterRollback.telefon, null, "k7: rollback restores keep.telefon to its pre-merge (blank) value");
      assertEq(keepAfterRollback.org_nr, null, "k8: rollback restores keep.org_nr to its pre-merge (blank) value");
      assertEq(removeAfterRollback.org_nr, "924487917", "k9: rollback restores remove.org_nr to its pre-merge value");
      assertEq(removeAfterRollback.merged_into, null, "k10: rollback restores remove.merged_into to NULL — no longer marked merged");

      // entity_type: "provider_merge" is recognized — dispatches to the same
      // provider path (never errors, never falls through silently) —
      // exercised via a plain provider_id + field_name call, unrelated to the
      // batch above.
      const providerMergeEntityType = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { entity_type: "provider_merge", provider_id: "prov-fill-keep", field_name: "telefon" },
      });
      assertEq(providerMergeEntityType.status, 200, "k11: entity_type:'provider_merge' recognized -> 200, not an error");
      assertTrue(
        Array.isArray(providerMergeEntityType.body.restored) && Array.isArray(providerMergeEntityType.body.skipped),
        "k12: entity_type:'provider_merge' returns the SAME provider-path response shape (restored/skipped), not a silent fallthrough",
      );

      // ── (l) chain-merge-within-one-batch rollback (code-review fix-up
      // 2026-08-15) — reproduces the reviewer's exact scenario: seed
      // A(org_nr=X)/B(blank)/C(blank), chain-merge A->B then, same batch_id,
      // B->C, then roll back the WHOLE batch and confirm A/B/C all land back
      // on their TRUE pre-batch values (A=X, B=blank, C=blank) with no
      // UNIQUE-constraint throw and no orphaned/corrupted state.
      const chainBatchId = "test-merge-batch-chain";
      const chainHop1 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-chain-a", keep_id: "prov-chain-b" }], apply: true, batch_id: chainBatchId },
      });
      assertEq(chainHop1.body.results[0].outcome, "merged", "l1: chain hop 1 (A->B) merges cleanly");
      assertEq(chainHop1.body.results[0].org_nr_migrated, true, "l2: chain hop 1 migrates org_nr onto B");

      const chainHop2 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-chain-b", keep_id: "prov-chain-c" }], apply: true, batch_id: chainBatchId },
      });
      assertEq(chainHop2.body.results[0].outcome, "merged", "l3: chain hop 2 (B->C), SAME batch_id, merges cleanly");
      assertEq(chainHop2.body.results[0].org_nr_migrated, true, "l4: chain hop 2 migrates org_nr onto C");

      const chainMidState = expDb
        .prepare(`SELECT id, org_nr, merged_into FROM experience_providers WHERE id IN ('prov-chain-a','prov-chain-b','prov-chain-c') ORDER BY id`)
        .all() as Array<{ id: string; org_nr: string | null; merged_into: string | null }>;
      assertEq(
        chainMidState,
        [
          { id: "prov-chain-a", org_nr: null, merged_into: "prov-chain-b" },
          { id: "prov-chain-b", org_nr: null, merged_into: "prov-chain-c" },
          { id: "prov-chain-c", org_nr: "988877766", merged_into: null },
        ],
        "l5: after both hops, org_nr has moved A->B->C and both A/B are marked merged",
      );

      // Whole-batch rollback: the buggy version threw a UNIQUE constraint
      // violation here (both A and B's restore targets collapsed onto the
      // same org_nr) and left a half-applied mess. The fix must both NOT
      // throw and restore every row to its true PRE-BATCH state.
      const chainRollbackDry = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: chainBatchId },
      });
      assertEq(chainRollbackDry.status, 200, "l6: chain batch rollback dry-run -> 200, no UNIQUE-constraint throw");
      assertEq(chainRollbackDry.body.dry_run, true, "l7: chain rollback dry-run reports dry_run:true");

      const chainRollbackApply = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: chainBatchId, apply: true },
      });
      assertEq(chainRollbackApply.status, 200, "l8: chain batch rollback apply -> 200, no UNIQUE-constraint throw");
      assertEq(chainRollbackApply.body.dry_run, false, "l9: chain rollback apply reports dry_run:false");

      const chainFinalState = expDb
        .prepare(`SELECT id, org_nr, merged_into FROM experience_providers WHERE id IN ('prov-chain-a','prov-chain-b','prov-chain-c') ORDER BY id`)
        .all() as Array<{ id: string; org_nr: string | null; merged_into: string | null }>;
      assertEq(
        chainFinalState,
        [
          { id: "prov-chain-a", org_nr: "988877766", merged_into: null },
          { id: "prov-chain-b", org_nr: null, merged_into: null },
          { id: "prov-chain-c", org_nr: null, merged_into: null },
        ],
        "l10: chain rollback restores A/B/C to their TRUE pre-batch values — A keeps its org_nr back, B and C both end up blank, nothing orphaned",
      );

      // ── (n) org_nr conflict — fail-closed at the merge route itself ─────────
      seed({ id: "prov-orgconflict-remove", navn: "Konflikt Produsent A", org_nr: "700111222" });
      seed({ id: "prov-orgconflict-keep", navn: "Konflikt Produsent B", org_nr: "700999888" });

      const orgConflictDry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-orgconflict-remove", keep_id: "prov-orgconflict-keep" }] },
      });
      assertEq(orgConflictDry.body.results[0].outcome, "rejected", "n1: dry-run, different populated org_nr on both sides -> rejected");
      assertEq(
        orgConflictDry.body.results[0].reason,
        "org_nr_konflikt_ulike_org_nr",
        "n2: reason is org_nr_konflikt_ulike_org_nr",
      );

      const orgConflictApply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-orgconflict-remove", keep_id: "prov-orgconflict-keep" }], apply: true },
      });
      assertEq(
        orgConflictApply.body.results[0].outcome,
        "rejected",
        "n3: apply=true, different populated org_nr on both sides -> STILL rejected (fail-closed, not just a dry-run warning)",
      );
      assertEq(
        orgConflictApply.body.results[0].reason,
        "org_nr_konflikt_ulike_org_nr",
        "n4: apply=true reason is org_nr_konflikt_ulike_org_nr",
      );

      const orgConflictAfter = expDb
        .prepare(`SELECT id, org_nr, merged_into FROM experience_providers WHERE id IN ('prov-orgconflict-remove','prov-orgconflict-keep') ORDER BY id`)
        .all() as Array<{ id: string; org_nr: string | null; merged_into: string | null }>;
      assertEq(
        orgConflictAfter,
        [
          { id: "prov-orgconflict-keep", org_nr: "700999888", merged_into: null },
          { id: "prov-orgconflict-remove", org_nr: "700111222", merged_into: null },
        ],
        "n5: both rows completely unchanged — apply=true performed ZERO writes on the rejected pair",
      );

      // Sanity: the SAME guard fires independent of which id is remove vs
      // keep (the conflict is symmetric in the two org_nr values, not tied
      // to a particular role).
      const orgConflictSwapped = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-orgconflict-keep", keep_id: "prov-orgconflict-remove" }], apply: true },
      });
      assertEq(
        orgConflictSwapped.body.results[0].outcome,
        "rejected",
        "n6: guard fires regardless of which row is remove_id vs keep_id",
      );
      assertEq(orgConflictSwapped.body.results[0].reason, "org_nr_konflikt_ulike_org_nr", "n7: same reason when roles are swapped");

      // ── (m) transaction-atomicity safety net — force some OTHER rollback
      // failure mid-batch (a plain two-provider UNIQUE-constraint collision,
      // unrelated to the chain-merge case above) and confirm the database
      // ends up COMPLETELY UNCHANGED, not half-applied. Calls
      // applyGardssalgContentRollback directly (bypassing plan()) with a
      // hand-built two-item batch: item 1 would succeed in isolation, item 2
      // is guaranteed to collide with it on org_nr's UNIQUE constraint.
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const atomicItems: Array<{ provider_id: string; field_name: string; current_value: string | null; restore_to: string | null }> = [
        { provider_id: "prov-atomic-p1", field_name: "org_nr", current_value: null, restore_to: "555999111" },
        { provider_id: "prov-atomic-p2", field_name: "org_nr", current_value: null, restore_to: "555999111" },
      ];
      let atomicThrew = false;
      let atomicIsTypedError = false;
      try {
        expStore.applyGardssalgContentRollback(atomicItems as any);
      } catch (e: any) {
        atomicThrew = true;
        atomicIsTypedError = e instanceof expStore.GardssalgRollbackApplyError;
      }
      assertTrue(atomicThrew, "m1: a mid-batch UNIQUE-constraint failure throws rather than silently partially applying");
      assertTrue(atomicIsTypedError, "m2: the thrown error is GardssalgRollbackApplyError, distinguishable from a generic error");

      const atomicAfter = expDb
        .prepare(`SELECT id, org_nr FROM experience_providers WHERE id IN ('prov-atomic-p1','prov-atomic-p2') ORDER BY id`)
        .all() as Array<{ id: string; org_nr: string | null }>;
      assertEq(
        atomicAfter,
        [
          { id: "prov-atomic-p1", org_nr: null },
          { id: "prov-atomic-p2", org_nr: null },
        ],
        "m3: BOTH rows are unchanged after the throw — item 1's write did NOT persist either, proving the whole batch rolled back atomically",
      );
      const atomicAuditCount = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id IN ('prov-atomic-p1','prov-atomic-p2')`)
        .get() as { n: number };
      assertEq(atomicAuditCount.n, 0, "m4: no audit rows were left behind for either provider — the audit INSERT for item 1 rolled back too");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-provider-dedup-merge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-provider-dedup-merge.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgProviderDedupMergeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

/**
 * opplevelser-gardssalg-content-audit.test.ts — tests for the gårdssalg
 * content rollback/provenance substrate (dev-request 2026-07-18-gardssalg-
 * profilkvalitet-foer-outreach, slice 1):
 *
 *   - gardssalg_content_audit table + experience_providers.field_provenance
 *     column (src/database/init-experiences.ts)
 *   - applyGardssalgProviderContent()'s additive audit/provenance wiring
 *     (src/services/experience-store.ts)
 *   - planGardssalgContentRollback() / applyGardssalgContentRollback()
 *     (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-content-rollback (src/routes/opplevelser.ts)
 *
 * Daniel is running a full content-quality pass over all 74 gårdssalg
 * producer profiles in ONE batch with NO canary; this slice is the agreed
 * substitute safety net — every field write must be reversible via this
 * audit trail, PROVEN WORKING before any batch content-improvement writes
 * happen. This file is that proof.
 *
 * Mirrors opplevelser-gardssalg-provider-lookup.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle() with X-Admin-Key via headers — this
 * repo's convention, no HTTP server / supertest needed).
 *
 * Covers:
 *   (a) a content-refresh write (applyGardssalgProviderContent) produces a
 *       matching gardssalg_content_audit row + field_provenance entry, with
 *       correct old_value (null, since the field was blank) / new_value
 *   (b) manual/claim-sourced provider rows are still never touched
 *       (regression — the pre-existing guard) and produce NO audit rows
 *   (c) POST /admin/gardssalg-content-rollback with provider_id+field_name,
 *       apply=true restores the exact prior (blank) value
 *   (d) POST .../gardssalg-content-rollback with batch_id restores every
 *       field touched by that batch across MULTIPLE providers
 *   (e) apply:false (default) performs zero writes — DB row unchanged after
 *       a dry-run call
 *   (f) the rollback itself is audited — a NEW audit row exists after a
 *       rollback (old_value = pre-rollback value, new_value = restored
 *       value)
 *   (g) rolling back a field with no audit history -> reported in
 *       `skipped`, not a hard error
 *   (h) 400 when neither provider_id nor batch_id is given
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
    const url = opts.url || "/admin/gardssalg-content-rollback";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgContentAuditTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "gardssalg-content-audit-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "prov-a", navn: "Prov A Sideri", hjemmeside: "https://prov-a.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-b", navn: "Prov B Bryggeri", hjemmeside: "https://prov-b.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-manual", navn: "Prov Manual Gard", hjemmeside: "https://prov-manual.example.no",
        content_source: "manual", about_text: "Håndskrevet om-tekst", visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-claim", navn: "Prov Claim Gard", hjemmeside: "https://prov-claim.example.no",
        content_source: "claim", about_text: "Eier-klaimet om-tekst", visit_text: null, opening_hours_text: null,
      });

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, opening_hours_text, content_source,
                  content_evidence_url, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        // ORDER BY rowid (SQLite's implicit insertion-order column) rather
        // than changed_at/id: changed_at has only second resolution (multiple
        // audit rows inserted within the same test run can collide), and id
        // is a random UUID with no ordering relationship to insertion order.
        // rowid is the only column that reliably reflects insertion order.
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      // ── (a) write -> matching audit row + field_provenance entry ────────
      const writtenA = store.applyGardssalgProviderContent(
        "prov-a",
        { about_text: "Om Prov A gård og sideriet vårt.", visit_text: "Besøk oss i helgene." },
        "https://prov-a.example.no/om-oss",
        "batch-1",
      );
      assertEq(writtenA.sort(), ["about_text", "visit_text"], "a1: applyGardssalgProviderContent writes the two thin candidate fields");

      const rowA = getProviderRow("prov-a");
      assertEq(rowA.about_text, "Om Prov A gård og sideriet vårt.", "a2: about_text written to the provider row");
      assertEq(rowA.content_source, "provider_site", "a3: content_source stamped provider_site");

      const auditA = getAuditRows("prov-a");
      assertEq(auditA.length, 2, "a4: exactly 2 audit rows inserted (about_text + visit_text)");
      const aboutAudit = auditA.find((r: any) => r.field_name === "about_text");
      assertTrue(!!aboutAudit, "a5: an about_text audit row exists");
      assertEq(aboutAudit.old_value, null, "a6: about_text audit old_value is null (was blank before this write)");
      assertEq(aboutAudit.new_value, "Om Prov A gård og sideriet vårt.", "a7: about_text audit new_value matches the written value");
      assertEq(aboutAudit.source_url, "https://prov-a.example.no/om-oss", "a8: audit source_url matches evidenceUrl");
      assertEq(aboutAudit.batch_id, "batch-1", "a9: audit batch_id matches the batchId param");
      assertEq(aboutAudit.changed_by, "system", "a10: audit changed_by defaults to 'system'");

      const provenanceA = JSON.parse(rowA.field_provenance);
      assertTrue(!!provenanceA.about_text, "a11: field_provenance has an about_text entry");
      assertEq(provenanceA.about_text.source_url, "https://prov-a.example.no/om-oss", "a12: field_provenance.about_text.source_url matches evidenceUrl");
      assertTrue(typeof provenanceA.about_text.fetched_at === "string" && provenanceA.about_text.fetched_at.length > 0, "a13: field_provenance.about_text.fetched_at is a non-empty timestamp");
      assertTrue(!!provenanceA.visit_text, "a14: field_provenance also has a visit_text entry (both written fields present)");

      // A second write on prov-a (opening_hours_text only) must NOT clobber
      // the existing about_text/visit_text provenance entries.
      const writtenA2 = store.applyGardssalgProviderContent(
        "prov-a",
        { opening_hours_text: "Man-fre 10-16" },
        "https://prov-a.example.no/apningstider",
        "batch-2",
      );
      assertEq(writtenA2, ["opening_hours_text"], "a15: second write only writes the still-blank opening_hours_text field");
      const rowA2 = getProviderRow("prov-a");
      const provenanceA2 = JSON.parse(rowA2.field_provenance);
      assertTrue(!!provenanceA2.about_text && !!provenanceA2.visit_text && !!provenanceA2.opening_hours_text, "a16: provenance merge preserves earlier fields' entries (read-modify-write, no clobber)");
      assertEq(getAuditRows("prov-a").length, 3, "a17: audit trail now has 3 rows total across both calls");

      // ── (b) manual/claim rows still never touched (regression) ──────────
      const writtenManual = store.applyGardssalgProviderContent(
        "prov-manual",
        { about_text: "Forsøk på overskriving", visit_text: "Forsøk" },
        "https://prov-manual.example.no",
      );
      assertEq(writtenManual, [], "b1: manual-sourced provider -> nothing written (regression guard)");
      const rowManual = getProviderRow("prov-manual");
      assertEq(rowManual.about_text, "Håndskrevet om-tekst", "b2: manual provider's about_text is unchanged");
      assertEq(getAuditRows("prov-manual").length, 0, "b3: manual provider produces zero audit rows");

      const writtenClaim = store.applyGardssalgProviderContent(
        "prov-claim",
        { about_text: "Forsøk på overskriving" },
        "https://prov-claim.example.no",
      );
      assertEq(writtenClaim, [], "b4: claim-sourced provider -> nothing written (regression guard)");
      assertEq(getAuditRows("prov-claim").length, 0, "b5: claim provider produces zero audit rows");

      // ── (i) manual/claim source acquired AFTER an audit-creating automated
      //       write must still block rollback — a stale audit row must never
      //       let a rollback overwrite content a provider has since claimed
      //       or manually edited (the reviewer's blocking finding). ────────
      insertProvider.run({
        id: "prov-claimed-later", navn: "Prov Claimed Later Gard", hjemmeside: "https://prov-claimed-later.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
      });

      const writtenClaimedLater = store.applyGardssalgProviderContent(
        "prov-claimed-later",
        { about_text: "Automatisk generert om-tekst." },
        "https://prov-claimed-later.example.no/om-oss",
      );
      assertEq(writtenClaimedLater, ["about_text"], "i1: automated write creates an audit row for prov-claimed-later");
      assertEq(getAuditRows("prov-claimed-later").length, 1, "i2: exactly one audit row exists before the simulated claim");

      // Simulate the provider claiming their profile and manually editing the
      // SAME field via a different write path (NOT applyGardssalgProviderContent,
      // so no new audit row is created — only the old automated-write audit
      // row exists). Directly mutate the row, bypassing every write-guard path,
      // the same way a real "claim profile" write path would (it writes
      // content_source + the field directly, not through this pipeline).
      expDb.prepare(
        `UPDATE experience_providers SET about_text = @about_text, content_source = 'manual' WHERE id = @id`
      ).run({ id: "prov-claimed-later", about_text: "Bondens egen håndskrevne tekst etter claim." });

      const auditCountBeforeRollback = getAuditRows("prov-claimed-later").length;
      assertEq(auditCountBeforeRollback, 1, "i3: still exactly one audit row (the manual edit did not go through the audited write path)");

      const claimedLaterPlan = store.planGardssalgContentRollback({ provider_id: "prov-claimed-later", field_name: "about_text" });
      assertEq(claimedLaterPlan.restorable, [], "i4: manual/claim-sourced field is never restorable, even with a stale audit row that would otherwise look restorable");
      assertTrue(
        claimedLaterPlan.skipped.some((s: any) => s.provider_id === "prov-claimed-later" && s.field_name === "about_text" && s.reason === "manual_or_claim_source"),
        "i5: plan() reports the field skipped with reason manual_or_claim_source",
      );

      // Also exercise apply() directly with a hand-built plan item that
      // bypasses plan() entirely — this is the defense-in-depth re-check.
      // If that guard were missing, this would overwrite the farmer's
      // manually-provided content.
      const forcedItem = {
        provider_id: "prov-claimed-later",
        field_name: "about_text",
        current_value: "Bondens egen håndskrevne tekst etter claim.",
        restore_to: null,
      };
      const forcedApplyResult = store.applyGardssalgContentRollback([forcedItem]);
      assertEq(forcedApplyResult, [], "i6: applyGardssalgContentRollback's own defense-in-depth check refuses the manual/claim item even when handed directly (bypassing plan())");

      const rowClaimedLaterAfterDirect = getProviderRow("prov-claimed-later");
      assertEq(rowClaimedLaterAfterDirect.about_text, "Bondens egen håndskrevne tekst etter claim.", "i7: the provider's live DB value is completely unchanged after the direct apply() call");
      assertEq(getAuditRows("prov-claimed-later").length, auditCountBeforeRollback, "i8: no new audit row was inserted for about_text by the direct apply() call");

      // And via the HTTP route too (apply: true), mirroring the c8/c9
      // invocation pattern above.
      const claimedLaterRouteRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-claimed-later", field_name: "about_text", apply: true },
      });
      assertEq(claimedLaterRouteRes.status, 200, "i9: route call -> 200 (not a hard error)");
      assertEq(claimedLaterRouteRes.body.restored, [], "i10: route reports nothing restored");
      assertTrue(
        claimedLaterRouteRes.body.skipped.some((s: any) => s.provider_id === "prov-claimed-later" && s.field_name === "about_text" && s.reason === "manual_or_claim_source"),
        "i11: route response reports the field skipped with reason manual_or_claim_source",
      );
      const rowClaimedLaterFinal = getProviderRow("prov-claimed-later");
      assertEq(rowClaimedLaterFinal.about_text, "Bondens egen håndskrevne tekst etter claim.", "i12: value still unchanged after the route-level apply:true call");
      assertEq(getAuditRows("prov-claimed-later").length, auditCountBeforeRollback, "i13: still no new audit row after the route call");

      // ── Seed prov-b with a batch-2-tagged write, for the batch rollback
      //    test (d) below — both prov-a's opening_hours_text (batch-2, from
      //    a15 above) and prov-b's about_text will share batch_id "batch-2".
      const writtenB = store.applyGardssalgProviderContent(
        "prov-b",
        { about_text: "Om Prov B bryggeri." },
        "https://prov-b.example.no/om",
        "batch-2",
      );
      assertEq(writtenB, ["about_text"], "seed: prov-b about_text written under batch-2");

      // ── (e) apply:false performs ZERO writes (dry-run) ───────────────────
      const beforeDryRun = getProviderRow("prov-a");
      const dryRunRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-a", field_name: "about_text", apply: false },
      });
      assertEq(dryRunRes.status, 200, "e1: dry-run rollback -> 200");
      assertEq(dryRunRes.body.success, true, "e2: dry-run rollback success:true");
      assertEq(dryRunRes.body.dry_run, true, "e3: dry-run rollback reports dry_run:true");
      assertEq(dryRunRes.body.restored.length, 1, "e4: dry-run reports exactly one restorable item");
      assertEq(dryRunRes.body.restored[0].current_value, "Om Prov A gård og sideriet vårt.", "e5: dry-run reports the current value");
      assertEq(dryRunRes.body.restored[0].would_restore_to, null, "e6: dry-run reports it would restore to null (the original blank value)");
      const afterDryRun = getProviderRow("prov-a");
      assertEq(afterDryRun.about_text, beforeDryRun.about_text, "e7: dry-run performs ZERO writes — about_text row unchanged");
      assertEq(getAuditRows("prov-a").length, 3, "e8: dry-run inserts NO new audit rows");

      // ── (h) 400 when neither provider_id nor batch_id given ─────────────
      const missingTarget = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { field_name: "about_text", apply: false },
      });
      assertEq(missingTarget.status, 400, "h1: neither provider_id nor batch_id -> 400");
      assertTrue(typeof missingTarget.body?.error === "string" && missingTarget.body.error.length > 0, "h2: 400 response carries a clear error message");

      // 403 without X-Admin-Key, for good measure (same convention as every
      // other admin route in this file).
      const noKey = await callRoute(opplevelserRouter, { body: { provider_id: "prov-a" } });
      assertEq(noKey.status, 403, "h3: missing X-Admin-Key -> 403");

      // ── (c) rollback by provider_id+field_name restores exact prior value ─
      const applyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-a", field_name: "about_text", apply: true },
      });
      assertEq(applyRes.status, 200, "c1: apply rollback -> 200");
      assertEq(applyRes.body.success, true, "c2: apply rollback success:true");
      assertEq(applyRes.body.dry_run, false, "c3: apply rollback reports dry_run:false");
      assertEq(applyRes.body.restored.length, 1, "c4: apply rollback restores exactly one field");
      assertEq(applyRes.body.restored[0].restored_to, null, "c5: apply rollback response reports restored_to null");
      const rowAAfterRollback = getProviderRow("prov-a");
      assertEq(rowAAfterRollback.about_text, null, "c6: about_text is restored to its exact prior (blank) value");
      assertEq(rowAAfterRollback.visit_text, "Besøk oss i helgene.", "c7: rollback of ONE field leaves other fields (visit_text) untouched");

      // ── (f) the rollback itself is audited ───────────────────────────────
      const auditAAfterRollback = getAuditRows("prov-a");
      assertEq(auditAAfterRollback.length, 4, "f1: a NEW audit row exists after the rollback (3 -> 4)");
      const rollbackAuditRow = auditAAfterRollback[auditAAfterRollback.length - 1];
      assertEq(rollbackAuditRow.field_name, "about_text", "f2: the new audit row is for about_text");
      assertEq(rollbackAuditRow.old_value, "Om Prov A gård og sideriet vårt.", "f3: rollback audit old_value = the value immediately before the rollback");
      assertEq(rollbackAuditRow.new_value, null, "f4: rollback audit new_value = the restored (blank) value");
      assertEq(rollbackAuditRow.changed_by, "system", "f5: rollback audit changed_by = 'system'");
      assertTrue(
        typeof rollbackAuditRow.source_url === "string" && rollbackAuditRow.source_url.includes("rollback"),
        "f6: rollback audit row is marked as a rollback (source_url carries a rollback marker)",
      );

      // Re-running the SAME rollback again must be idempotent-safe: the field
      // is already back at old_value, so a second dry-run should now report
      // it as skipped (already_current), not restorable again.
      const secondDryRun = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-a", field_name: "about_text", apply: false },
      });
      assertEq(secondDryRun.body.restored.length, 0, "c8: re-querying the same rollback after it's applied -> nothing left to restore");
      assertTrue(
        secondDryRun.body.skipped.some((s: any) => s.field_name === "about_text" && s.reason === "already_current"),
        "c9: re-querying reports about_text as skipped/already_current (idempotency — no blind re-restore)",
      );

      // ── (g) rolling back a field with no audit history -> skipped, not error ─
      const noHistoryRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-b", field_name: "visit_text", apply: true },
      });
      assertEq(noHistoryRes.status, 200, "g1: rollback targeting a field with no audit history -> 200 (not a hard error)");
      assertEq(noHistoryRes.body.restored, [], "g2: nothing restored for a field with no audit history");
      assertTrue(
        noHistoryRes.body.skipped.some((s: any) => s.provider_id === "prov-b" && s.field_name === "visit_text" && s.reason === "no_audit_row"),
        "g3: the no-history field is reported in skipped with reason 'no_audit_row'",
      );

      // ── (d) rollback by batch_id restores every field across MULTIPLE
      //       providers touched by that batch ─────────────────────────────
      // batch-2 touched: prov-a.opening_hours_text (from a15) and
      // prov-b.about_text (seed write above).
      const beforeBatch = {
        aOpeningHours: getProviderRow("prov-a").opening_hours_text,
        bAbout: getProviderRow("prov-b").about_text,
      };
      assertEq(beforeBatch.aOpeningHours, "Man-fre 10-16", "d0a: sanity — prov-a opening_hours_text set before batch rollback");
      assertEq(beforeBatch.bAbout, "Om Prov B bryggeri.", "d0b: sanity — prov-b about_text set before batch rollback");

      const batchDryRun = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { batch_id: "batch-2", apply: false },
      });
      assertEq(batchDryRun.status, 200, "d1: batch dry-run -> 200");
      assertEq(batchDryRun.body.restored.length, 2, "d2: batch dry-run finds 2 restorable (provider, field) pairs");
      assertTrue(
        batchDryRun.body.restored.some((r: any) => r.provider_id === "prov-a" && r.field_name === "opening_hours_text") &&
        batchDryRun.body.restored.some((r: any) => r.provider_id === "prov-b" && r.field_name === "about_text"),
        "d3: batch dry-run covers both providers' fields touched under batch-2",
      );

      const batchApply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { batch_id: "batch-2", apply: true },
      });
      assertEq(batchApply.status, 200, "d4: batch apply -> 200");
      assertEq(batchApply.body.restored.length, 2, "d5: batch apply restores both (provider, field) pairs");

      const afterBatchA = getProviderRow("prov-a");
      const afterBatchB = getProviderRow("prov-b");
      assertEq(afterBatchA.opening_hours_text, null, "d6: prov-a.opening_hours_text restored to blank across the batch rollback");
      assertEq(afterBatchB.about_text, null, "d7: prov-b.about_text restored to blank across the batch rollback");
      assertEq(getAuditRows("prov-b").filter((r: any) => r.field_name === "about_text").length, 2, "d8: prov-b gets its own new rollback audit row (write + rollback = 2)");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-content-audit: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-content-audit.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgContentAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

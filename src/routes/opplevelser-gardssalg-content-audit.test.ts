/**
 * opplevelser-gardssalg-content-audit.test.ts — tests for the gårdssalg
 * content rollback/provenance substrate (dev-request 2026-07-18-gardssalg-
 * profilkvalitet-foer-outreach, slice 1), PLUS (blocks j/k below) slice 2's
 * replace-thin-existing-content extension:
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
 *   (j) slice 2: applyGardssalgProviderContent() REPLACES thin (non-blank,
 *       fails meetsAboutQualityBar) about_text/visit_text with a qualifying,
 *       genuinely-longer candidate (audit old_value = the real prior thin
 *       text); NEVER replaces decent existing content; a candidate that
 *       itself fails the quality bar never replaces anything; manual/claim
 *       locks still block replacement of thin content too; opening_hours_
 *       text keeps the old fill-only-blank rule
 *   (k) slice 2: POST /admin/gardssalg-content-refresh's dry-run AND apply
 *       projections tag each written field's `actions` as "filled" vs
 *       "replaced" (additive alongside the pre-existing `fields: string[]`),
 *       matching exactly what applyGardssalgProviderContent() does — mocks
 *       globalThis.fetch (no network access in the sandbox) to drive the
 *       route's real extraction pipeline end-to-end
 *   (m) fix-up round (independent review, blocking finding): an ALREADY-
 *       contaminated (cheap-bar-passing but nav-menu-leaked, the Draopar
 *       incident shape) current about_text IS replaceable by a judge-
 *       approved fresh candidate (self-healing restored), while a
 *       GENUINELY decent current value (also judge-approved) is still
 *       NEVER churned even with a fresh candidate available
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

      // ── SLICE 2 (dev-request 2026-07-18-gardssalg-profilkvalitet-foer-
      //    outreach, slice 2): applyGardssalgProviderContent() now also
      //    REPLACES thin (non-blank but low-quality) about_text/visit_text,
      //    not just fills blanks — Daniel's raw complaint was "korte eller
      //    dårlige tekster som kan forbedres" (short/bad texts that could be
      //    improved). opening_hours_text is unchanged (fill-only-blank). ───
      const GOOD_ABOUT_J =
        "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken.";
      const DECENT_EXISTING_ABOUT_J =
        "Gården vår har lange tradisjoner med sauehold og ullproduksjon, og vi selger garn og kjøtt direkte fra tunet.";
      const THIN_CANDIDATE_J = "Kort og lite tekst."; // fails meetsAboutQualityBar (too short)

      insertProvider.run({
        id: "prov-j-thin", navn: "Prov J Thin Gard", hjemmeside: "https://prov-j-thin.example.no",
        content_source: null, about_text: "Liten gård med noen dyr.", visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-j-decent", navn: "Prov J Decent Gard", hjemmeside: "https://prov-j-decent.example.no",
        content_source: null, about_text: DECENT_EXISTING_ABOUT_J, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-j-candidate-thin", navn: "Prov J Candidate Thin Gard", hjemmeside: "https://prov-j-candidate-thin.example.no",
        content_source: null, about_text: "Liten gård med noen dyr.", visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "prov-j-manual-thin", navn: "Prov J Manual Thin Gard", hjemmeside: "https://prov-j-manual-thin.example.no",
        content_source: "manual", about_text: "Kort.", visit_text: null, opening_hours_text: null,
      });

      // (j1-j6) thin, non-blank about_text IS replaced by a qualifying,
      // longer candidate — audit old_value is the REAL prior thin text.
      const writtenJ1 = store.applyGardssalgProviderContent(
        "prov-j-thin",
        { about_text: GOOD_ABOUT_J },
        "https://prov-j-thin.example.no/om-oss",
        "batch-j",
      );
      assertEq(writtenJ1, ["about_text"], "j1: thin about_text IS replaced by a qualifying longer candidate");
      const rowJ1 = getProviderRow("prov-j-thin");
      assertEq(rowJ1.about_text, GOOD_ABOUT_J, "j2: about_text now holds the replacement candidate");
      const auditJ1 = getAuditRows("prov-j-thin");
      const aboutAuditJ1 = auditJ1.find((r: any) => r.field_name === "about_text");
      assertTrue(!!aboutAuditJ1, "j3: a replace still produces an about_text audit row");
      assertEq(aboutAuditJ1.old_value, "Liten gård med noen dyr.", "j4: audit old_value is the REAL prior thin text, not blank");
      assertEq(aboutAuditJ1.new_value, GOOD_ABOUT_J, "j5: audit new_value is the replacement candidate");
      const provenanceJ1 = JSON.parse(rowJ1.field_provenance);
      assertTrue(!!provenanceJ1.about_text, "j6: field_provenance updated for the replaced field");

      // (j7-j9) decent existing content (already passes meetsAboutQualityBar)
      // is NEVER replaced, even with a longer/different candidate available —
      // protects decent existing content from unnecessary churn.
      const writtenJ2 = store.applyGardssalgProviderContent(
        "prov-j-decent",
        { about_text: GOOD_ABOUT_J },
        "https://prov-j-decent.example.no/om-oss",
      );
      assertEq(writtenJ2, [], "j7: decent existing about_text is never replaced");
      const rowJ2 = getProviderRow("prov-j-decent");
      assertEq(rowJ2.about_text, DECENT_EXISTING_ABOUT_J, "j8: decent existing about_text is unchanged");
      assertEq(getAuditRows("prov-j-decent").length, 0, "j9: no audit row for a decent field that was correctly left alone");

      // (j10-j11) a candidate that itself fails meetsAboutQualityBar never
      // replaces anything, even against thin existing content ("thin can't
      // replace thin").
      const writtenJ3 = store.applyGardssalgProviderContent(
        "prov-j-candidate-thin",
        { about_text: THIN_CANDIDATE_J },
        "https://prov-j-candidate-thin.example.no/om-oss",
      );
      assertEq(writtenJ3, [], "j10: a candidate that itself fails meetsAboutQualityBar never replaces thin existing content");
      const rowJ3 = getProviderRow("prov-j-candidate-thin");
      assertEq(rowJ3.about_text, "Liten gård med noen dyr.", "j11: existing thin about_text unchanged when candidate itself is thin");

      // (j12-j14) manual/claim-locked rows are still completely untouched
      // regardless of how thin their content is (regression — the lock guard
      // must keep passing unmodified for the new replace path too).
      const writtenJ4 = store.applyGardssalgProviderContent(
        "prov-j-manual-thin",
        { about_text: GOOD_ABOUT_J },
        "https://prov-j-manual-thin.example.no",
      );
      assertEq(writtenJ4, [], "j12: manual-locked provider with THIN content is still never touched (regression, even for the new replace path)");
      const rowJ4 = getProviderRow("prov-j-manual-thin");
      assertEq(rowJ4.about_text, "Kort.", "j13: locked provider's thin about_text is unchanged");
      assertEq(getAuditRows("prov-j-manual-thin").length, 0, "j14: no audit row for the locked provider");

      // (j15-j18) opening_hours_text still only fills when blank — spot
      // check that it did NOT pick up the new replace-thin behavior.
      const writtenJ5 = store.applyGardssalgProviderContent(
        "prov-j-thin",
        { opening_hours_text: "Ma-fr 9-15" },
        "https://prov-j-thin.example.no/apningstider",
      );
      assertEq(writtenJ5, ["opening_hours_text"], "j15: opening_hours_text still fills when blank");
      const rowJ5 = getProviderRow("prov-j-thin");
      assertEq(rowJ5.opening_hours_text, "Ma-fr 9-15", "j16: opening_hours_text written on first (blank) fill");

      const writtenJ6 = store.applyGardssalgProviderContent(
        "prov-j-thin",
        { opening_hours_text: "Mandag-fredag klokka 09:00 til 17:00, lørdag 10-14, søndag stengt hele dagen." },
        "https://prov-j-thin.example.no/apningstider2",
      );
      assertEq(writtenJ6, [], "j17: opening_hours_text is NEVER replaced once non-blank, even with a longer/better candidate (unchanged fill-only-blank rule)");
      const rowJ6 = getProviderRow("prov-j-thin");
      assertEq(rowJ6.opening_hours_text, "Ma-fr 9-15", "j18: opening_hours_text stays at its original filled value");

      // ── (k) POST /admin/gardssalg-content-refresh: dry-run/apply
      //       projection distinguishes "replaced" from "filled" per field,
      //       and never previews a replace of decent existing content. Mocks
      //       globalThis.fetch (repo convention — see
      //       search-enrich-page-evidence.test.ts) since this route makes
      //       real fetch() calls and the sandbox has no network access.
      //
      //       UPDATE (kvalitetsgate-redesign, slice 2/3/4): about_text/
      //       visit_text candidates now also go through the new LLM judge
      //       (meetsGardssalgAboutQualityBar → judgeGardssalgAboutCandidate,
      //       routes/opplevelser.ts) once they clear the cheap prefilter —
      //       so the mock ALSO handles "api.anthropic.com" (same idiom as
      //       opplevelser-gardssalg-rewrite.test.ts), approving the
      //       genuinely-good fixture texts below (this block tests the
      //       fill/replace projection logic, not the judge itself — see
      //       opplevelser-gardssalg-quality-judge.test.ts for the judge's
      //       own dedicated tests). ─────────────────────────────────────
      const prevFetchK = globalThis.fetch;
      const prevAnthropicKeyK = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-k";
      try {
        const GCR_GOOD_ABOUT_K =
          "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken.";
        const GCR_GOOD_VISIT_K =
          "Hos oss kan du besøke gårdsbutikken og handle ferske grønnsaker rett fra jordet, åpent gjennom hele sommeren.";
        const gcrHtmlK = `<html><head><meta property="og:description" content="${GCR_GOOD_ABOUT_K}"></head><body><p>${GCR_GOOD_VISIT_K}</p></body></html>`;

        insertProvider.run({
          id: "prov-k-thin", navn: "Prov K Thin Gard", hjemmeside: "https://prov-k-thin.example.no",
          content_source: null, about_text: "Liten gård med noen dyr.", visit_text: null, opening_hours_text: null,
        });
        insertProvider.run({
          id: "prov-k-decent", navn: "Prov K Decent Gard", hjemmeside: "https://prov-k-decent.example.no",
          content_source: null, about_text: DECENT_EXISTING_ABOUT_J, visit_text: null, opening_hours_text: null,
        });

        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            // Judge mock: always approve — these fixtures are genuinely
            // clean, on-entity prose (this block's concern is the fill/
            // replace projection, not judge calibration).
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
            } as unknown as Response;
          }
          const host = new URL(urlStr).hostname;
          if (host === "prov-k-thin.example.no" || host === "prov-k-decent.example.no") {
            return { ok: true, status: 200, text: async () => gcrHtmlK } as unknown as Response;
          }
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }) as typeof fetch;

        // dry-run first: zero writes, but the projection must distinguish
        // "replaced" (prov-k-thin.about_text) from "filled" (both providers'
        // visit_text), and must never list prov-k-decent.about_text at all
        // (decent existing content is protected from the preview onward).
        const dryK = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-k-thin", "prov-k-decent"], apply: false },
        });
        assertEq(dryK.status, 200, "k1: dry-run gardssalg-content-refresh -> 200");
        assertEq(dryK.body.dry_run, true, "k2: dry_run:true");

        const dryThinEntry = dryK.body.changed.find((c: any) => c.provider_id === "prov-k-thin");
        assertTrue(!!dryThinEntry, "k3: prov-k-thin appears in dry-run changed[]");
        assertEq(dryThinEntry.actions.about_text, "replaced", "k4: dry-run projects about_text as 'replaced' for thin existing content");
        assertEq(dryThinEntry.actions.visit_text, "filled", "k5: dry-run projects visit_text as 'filled' (was blank)");
        assertTrue(
          dryThinEntry.fields.includes("about_text") && dryThinEntry.fields.includes("visit_text"),
          "k6: fields[] still lists both field names (backward-compatible, unchanged shape)",
        );

        const dryDecentEntry = dryK.body.changed.find((c: any) => c.provider_id === "prov-k-decent");
        assertTrue(!!dryDecentEntry, "k7: prov-k-decent appears in dry-run changed[] (its visit_text is still blank -> fillable)");
        assertEq(dryDecentEntry.actions.visit_text, "filled", "k8: prov-k-decent visit_text projected as 'filled'");
        assertTrue(!("about_text" in dryDecentEntry.actions), "k9: prov-k-decent's decent about_text is NOT in actions (protected, not replaced)");
        assertTrue(!dryDecentEntry.fields.includes("about_text"), "k10: prov-k-decent's about_text is NOT in fields[] either");

        const beforeApplyThin = getProviderRow("prov-k-thin");
        assertEq(beforeApplyThin.about_text, "Liten gård med noen dyr.", "k11: dry-run performed ZERO writes — prov-k-thin about_text unchanged");

        // apply:true — actually writes, and the SAME distinction must show up
        // in the real response, with the audit row's old_value = the real
        // prior thin text (not blank).
        const applyK = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-k-thin", "prov-k-decent"], apply: true },
        });
        assertEq(applyK.status, 200, "k12: apply gardssalg-content-refresh -> 200");
        assertEq(applyK.body.dry_run, false, "k13: dry_run:false");

        const applyThinEntry = applyK.body.changed.find((c: any) => c.provider_id === "prov-k-thin");
        assertTrue(!!applyThinEntry, "k14: prov-k-thin appears in apply changed[]");
        assertEq(applyThinEntry.actions.about_text, "replaced", "k15: apply response also tags about_text 'replaced'");
        assertEq(applyThinEntry.actions.visit_text, "filled", "k16: apply response also tags visit_text 'filled'");

        const afterApplyThin = getProviderRow("prov-k-thin");
        assertEq(afterApplyThin.about_text, GCR_GOOD_ABOUT_K, "k17: prov-k-thin about_text actually replaced by the crawled candidate");
        assertEq(afterApplyThin.visit_text, GCR_GOOD_VISIT_K, "k18: prov-k-thin visit_text actually filled by the crawled candidate");

        const afterApplyDecent = getProviderRow("prov-k-decent");
        assertEq(afterApplyDecent.about_text, DECENT_EXISTING_ABOUT_J, "k19: prov-k-decent's decent about_text is STILL unchanged after apply");

        const auditThinAbout = getAuditRows("prov-k-thin").find((r: any) => r.field_name === "about_text");
        assertTrue(!!auditThinAbout, "k20: apply produced an about_text audit row for the replace");
        assertEq(auditThinAbout.old_value, "Liten gård med noen dyr.", "k21: audit old_value is the real prior thin text");
        assertEq(auditThinAbout.new_value, GCR_GOOD_ABOUT_K, "k22: audit new_value is the crawled replacement");
      } finally {
        globalThis.fetch = prevFetchK;
        if (prevAnthropicKeyK === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKeyK;
      }

      // ── (l) duplicate-field guard (dev-request 2026-07-20-kvalitetsgate,
      //       slice 1 — the Draopar incident): a source page with no distinct
      //       "visit us" section can make summarizeAbout()/summarizeVisit()
      //       independently land on the EXACT SAME extracted block. Before
      //       the #313 fix, candidateAbout and candidateVisit in POST
      //       /admin/gardssalg-content-refresh's processOne() were BOTH set
      //       to this identical text, so about_text and visit_text ended up
      //       byte-identical after write; #313 guards the ASSIGNMENT itself
      //       (only about_text gets it when they coincide).
      //
      //       UPDATE (kvalitetsgate-redesign criterion 1, this slice): the
      //       ORIGINAL fixture here reproduced the Draopar bug at the
      //       extractor level too — a flat run of nav-menu <a> links glued in
      //       front of the one real sentence, with "sidersmaking" (a nav
      //       link's own label) false-matching summarizeVisit's bare-
      //       substring "smaking" scan. That was possible because
      //       summarizeAbout()/summarizeVisit() extracted their fallback text
      //       via extractVisibleText(), which does not distinguish <nav>
      //       chrome from body prose. They now extract via extractProseText()
      //       (search-enrich.ts), which drops <nav>/<header>/<footer>/<aside>
      //       blocks before flattening — so the nav links here are excluded
      //       from the candidate entirely and no longer reach either
      //       extractor. The fixture below keeps the "same chunk" shape that
      //       #313's guard exists for, but the coincidence is now a GENUINE
      //       one — the page's one real sentence itself names "sidersmaking"
      //       (cider tasting), so summarizeAbout()'s first-paragraph fallback
      //       and summarizeVisit()'s "smaking" keyword scan still legitimately
      //       land on the same real prose, proving #313's guard is still
      //       load-bearing even after the nav contamination is fixed — while
      //       the nav links themselves (now correctly excluded) prove THIS
      //       slice's fix.
      //
      //       UPDATE (kvalitetsgate-redesign, slice 2/3/4): the single real
      //       sentence left after nav-stripping is now also judged by the
      //       new LLM judge (approved by the mock below) before it can be
      //       written — same idiom as block (k). ──
      const prevFetchL = globalThis.fetch;
      const prevAnthropicKeyL = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-l";
      try {
        // Nav-menu chrome (now excluded by extractProseText) wrapped around
        // the page's one real sentence, which itself genuinely mentions
        // "sidersmaking" (cider tasting) — so after nav-stripping, the SAME
        // single real chunk is still what both summarizeAbout() and
        // summarizeVisit() land on, exercising the #313 dedup guard on
        // legitimate content instead of leaked nav-menu text.
        const DRAOPAR_SHAPE_HTML =
          '<html><body>' +
          '<nav><a href="/">Heim</a> <a href="/salg">Salg</a> ' +
          '<a href="/om">Om sider</a> <a href="/kontakt">Kontakt</a> ' +
          '<a href="/sortar">Sidersortar</a> <a href="/alkoholfritt">Alkoholfritt draopar</a></nav>' +
          '<main><p>Vi driv eit vesle sideri i Hardanger og inviterer til sidersmaking i vår gamle løe kvar laurdag i haustsesongen.</p></main>' +
          '</body></html>';
        const DRAOPAR_SHAPE_TEXT =
          "Vi driv eit vesle sideri i Hardanger og inviterer til sidersmaking i vår gamle løe kvar laurdag i haustsesongen.";

        insertProvider.run({
          id: "prov-l-duplicate", navn: "Prov L Draopar Gard", hjemmeside: "https://prov-l-duplicate.example.no",
          content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
        });

        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte, konkret prosa om produsenten." }] }),
            } as unknown as Response;
          }
          const u = new URL(urlStr);
          if (u.hostname === "prov-l-duplicate.example.no" && (u.pathname === "/" || u.pathname === "")) {
            return { ok: true, status: 200, text: async () => DRAOPAR_SHAPE_HTML } as unknown as Response;
          }
          // Every gårdssalg sub-page candidate (om-oss, besok, smaking, ...)
          // 404s — this producer's real site is exactly one page, same as
          // the actual Draopar homepage.
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }) as typeof fetch;

        const applyL = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-l-duplicate"], apply: true },
        });
        assertEq(applyL.status, 200, "l1: apply gardssalg-content-refresh -> 200");

        const rowL = getProviderRow("prov-l-duplicate");
        assertEq(rowL.about_text, DRAOPAR_SHAPE_TEXT, "l2: about_text is written from the (only) derivable block");
        assertEq(rowL.visit_text, null, "l3: visit_text stays blank/null — NOT a duplicate of about_text");
        assertTrue(rowL.about_text !== rowL.visit_text, "l4: about_text and visit_text are never byte-identical (the #313 regression itself)");

        const entryL = applyL.body.changed.find((c: any) => c.provider_id === "prov-l-duplicate");
        assertTrue(!!entryL, "l5: prov-l-duplicate appears in the apply response's changed[]");
        assertTrue(entryL.fields.includes("about_text"), "l6: response fields[] includes about_text");
        assertTrue(!entryL.fields.includes("visit_text"), "l7: response fields[] does NOT include visit_text (nothing written for it)");

        const auditRowsL = getAuditRows("prov-l-duplicate");
        assertTrue(auditRowsL.some((r: any) => r.field_name === "about_text"), "l8: an about_text audit row exists");
        assertTrue(!auditRowsL.some((r: any) => r.field_name === "visit_text"), "l9: no visit_text audit row was created");
      } finally {
        globalThis.fetch = prevFetchL;
        if (prevAnthropicKeyL === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKeyL;
      }

      // ── (m) fix-up round (independent review, blocking finding): an
      //       ALREADY-contaminated current about_text/visit_text — cheap-bar-
      //       passing (long enough, real Norwegian words) but nav-menu-leaked,
      //       the exact Draopar incident shape — must still be replaceable by
      //       a genuinely good freshly-fetched candidate. Before this fix,
      //       aboutHasWriteOpportunity gated candidate computation itself on
      //       meetsAboutCheapBar(current), and gardssalgReplaceableFieldAction
      //       independently short-circuited on the same cheap-bar check, so a
      //       row with already-landed contamination could NEVER be healed by
      //       this endpoint again. The fix judges the CURRENT value with the
      //       same LLM judge whenever a judge-approved fresh candidate exists
      //       for the same field, and treats a judge-rejected current value as
      //       replaceable despite passing the cheap bar. This block proves
      //       BOTH directions: (m1) contaminated current -> DOES get replaced
      //       (self-healing works), and (m2) genuinely decent current (also
      //       judge-approved) -> still NEVER churned, even with a fresh
      //       candidate available (proves the fix didn't start over-churning
      //       good content). ────────────────────────────────────────────────
      const prevFetchM = globalThis.fetch;
      const prevAnthropicKeyM = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-m";
      try {
        // The PR's own cal-1 calibration fixture shape (opplevelser-gardssalg-
        // quality-judge.test.ts): nav-menu link labels glued in front of one
        // real trailing sentence — 97 chars, clears meetsAboutCheapBar (>=80
        // chars, has "er" as a Norwegian word marker, no boilerplate markers)
        // despite being leaked nav chrome, not a real about-text.
        const CAL1_CONTAMINATED_ABOUT =
          "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger.";
        // A genuinely good, longer, on-entity candidate — what a real crawl
        // of Draopar's homepage should have produced instead of the nav-glued
        // text above.
        const GOOD_FRESH_CANDIDATE_ABOUT =
          "Draopar Sideri held til i Hardanger og lagar sider av eigne eple frå gamle tre på garden, og tek imot gjester til smaking og ein kort omvising gjennom heile haustsesongen.";
        assertTrue(
          CAL1_CONTAMINATED_ABOUT.length >= 80,
          "sanity: CAL1_CONTAMINATED_ABOUT clears the 80-char cheap-bar floor",
        );
        assertTrue(
          GOOD_FRESH_CANDIDATE_ABOUT.length > CAL1_CONTAMINATED_ABOUT.length,
          "sanity: GOOD_FRESH_CANDIDATE_ABOUT is strictly longer than the contaminated current text (required for 'replaced')",
        );

        // A genuinely decent, NOT contaminated current about_text (control —
        // would also pass a real LLM judge, unlike the nav-glued fixture
        // above) — reused from block (j) above.
        const GENUINELY_DECENT_ABOUT_M = DECENT_EXISTING_ABOUT_J;
        const GOOD_FRESH_CANDIDATE_ABOUT_M2 =
          "Gården vår ligg vakkert til ved fjorden og har halde på med sauehald i fire generasjonar, med eige gardsutsal ope kvar laurdag frå mai til september.";
        assertTrue(
          GOOD_FRESH_CANDIDATE_ABOUT_M2.length > GENUINELY_DECENT_ABOUT_M.length,
          "sanity: GOOD_FRESH_CANDIDATE_ABOUT_M2 is strictly longer than the genuinely decent current text",
        );

        insertProvider.run({
          id: "prov-m-contaminated", navn: "Prov M Draopar-shaped Gard", hjemmeside: "https://prov-m-contaminated.example.no",
          content_source: null, about_text: CAL1_CONTAMINATED_ABOUT, visit_text: null, opening_hours_text: null,
        });
        insertProvider.run({
          id: "prov-m-decent", navn: "Prov M Decent Gard", hjemmeside: "https://prov-m-decent.example.no",
          content_source: null, about_text: GENUINELY_DECENT_ABOUT_M, visit_text: null, opening_hours_text: null,
        });

        const contaminatedHtmlM = `<html><head><meta property="og:description" content="${GOOD_FRESH_CANDIDATE_ABOUT}"></head><body><p>Velkommen innom oss.</p></body></html>`;
        const decentHtmlM = `<html><head><meta property="og:description" content="${GOOD_FRESH_CANDIDATE_ABOUT_M2}"></head><body><p>Velkommen innom oss.</p></body></html>`;

        // Judge mock: distinguishes which text is being judged by substring
        // match against the prompt (judgeGardssalgAboutCandidate embeds the
        // candidate text verbatim in its prompt) — approves both fresh
        // candidates and the genuinely decent current text, REJECTS only the
        // contaminated cal-1-shaped current text.
        globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            const body = init?.body ? JSON.parse(init.body) : {};
            const prompt: string = body?.messages?.[0]?.content ?? "";
            if (prompt.includes(CAL1_CONTAMINATED_ABOUT)) {
              return {
                ok: true,
                status: 200,
                json: async () => ({ content: [{ type: "text", text: "AVVIS\nLekket navigasjonsmeny, ikke egnet prosa." }] }),
              } as unknown as Response;
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte, konkret prosa om produsenten." }] }),
            } as unknown as Response;
          }
          const host = new URL(urlStr).hostname;
          if (host === "prov-m-contaminated.example.no") {
            return { ok: true, status: 200, text: async () => contaminatedHtmlM } as unknown as Response;
          }
          if (host === "prov-m-decent.example.no") {
            return { ok: true, status: 200, text: async () => decentHtmlM } as unknown as Response;
          }
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }) as typeof fetch;

        // ── m1: dry-run on prov-m-contaminated projects "replaced" (the
        //    self-healing path fires), with zero writes. ────────────────────
        const dryM1 = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-m-contaminated"], apply: false },
        });
        assertEq(dryM1.status, 200, "m1a: dry-run on contaminated provider -> 200");
        const dryM1Entry = dryM1.body.changed.find((c: any) => c.provider_id === "prov-m-contaminated");
        assertTrue(!!dryM1Entry, "m1b: prov-m-contaminated appears in dry-run changed[] — self-healing candidate found");
        assertEq(dryM1Entry.actions.about_text, "replaced", "m1c: dry-run projects about_text action 'replaced' (contaminated current judged replaceable)");
        const beforeApplyM1 = getProviderRow("prov-m-contaminated");
        assertEq(beforeApplyM1.about_text, CAL1_CONTAMINATED_ABOUT, "m1d: dry-run performed ZERO writes — contaminated text still in place");

        // ── m1 (apply): the contaminated current value IS actually replaced
        //    by the judge-approved fresh candidate — the self-healing path
        //    this dev-request exists to restore. ─────────────────────────────
        const applyM1 = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-m-contaminated"], apply: true },
        });
        assertEq(applyM1.status, 200, "m1e: apply on contaminated provider -> 200");
        const applyM1Entry = applyM1.body.changed.find((c: any) => c.provider_id === "prov-m-contaminated");
        assertTrue(!!applyM1Entry, "m1f: prov-m-contaminated appears in apply changed[]");
        assertEq(applyM1Entry.actions.about_text, "replaced", "m1g: apply response tags about_text 'replaced'");

        const afterApplyM1 = getProviderRow("prov-m-contaminated");
        assertEq(afterApplyM1.about_text, GOOD_FRESH_CANDIDATE_ABOUT, "m1h: THE FIX — contaminated (but cheap-bar-passing) about_text IS replaced by the good fresh candidate");
        assertTrue(afterApplyM1.about_text !== CAL1_CONTAMINATED_ABOUT, "m1i: the nav-contaminated text is definitively gone");

        const auditM1 = getAuditRows("prov-m-contaminated").find((r: any) => r.field_name === "about_text");
        assertTrue(!!auditM1, "m1j: an about_text audit row exists for the self-healing replace");
        assertEq(auditM1.old_value, CAL1_CONTAMINATED_ABOUT, "m1k: audit old_value is the REAL prior contaminated text (rollback-restorable if this is ever wrong)");
        assertEq(auditM1.new_value, GOOD_FRESH_CANDIDATE_ABOUT, "m1l: audit new_value is the good fresh candidate");

        // ── m2: control — a GENUINELY decent current value (also
        //    judge-approved, not contaminated) is still NEVER churned, even
        //    though a judge-approved fresh candidate is available too. Proves
        //    the fix didn't start over-churning good content. ───────────────
        const applyM2 = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-m-decent"], apply: true },
        });
        assertEq(applyM2.status, 200, "m2a: apply on genuinely-decent provider -> 200");
        const applyM2Entry = applyM2.body.changed.find((c: any) => c.provider_id === "prov-m-decent");
        assertTrue(
          !applyM2Entry || !("about_text" in (applyM2Entry.actions ?? {})),
          "m2b: prov-m-decent's about_text is NOT in the apply response's actions — never churned",
        );

        const afterApplyM2 = getProviderRow("prov-m-decent");
        assertEq(afterApplyM2.about_text, GENUINELY_DECENT_ABOUT_M, "m2c: genuinely decent about_text is completely unchanged after apply, despite a judge-approved fresh candidate being available");
        assertTrue(
          !getAuditRows("prov-m-decent").some((r: any) => r.field_name === "about_text"),
          "m2d: no about_text audit row was created for the genuinely decent (never-churned) field",
        );
      } finally {
        globalThis.fetch = prevFetchM;
        if (prevAnthropicKeyM === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKeyM;
      }
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

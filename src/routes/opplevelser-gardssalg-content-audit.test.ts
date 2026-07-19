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
 *   (l) slice 5a: gardssalgRewriteEligible() (pure eligibility for the
 *       "passes the quality bar but still <200 chars" cohort (j) never
 *       touches), applyGardssalgProviderContent()'s additive rewriteFields
 *       param (writes only when the writer itself re-derives eligibility,
 *       never trusting the caller's set blindly; lock guard still applies),
 *       and the full POST /admin/gardssalg-content-refresh rewrite
 *       integration end-to-end via generateGardssalgAboutRewrite — mocks
 *       globalThis.fetch, branching on hostname between the provider's own
 *       homepage and https://api.anthropic.com, covering: a successful
 *       rewrite (dry-run preview + apply write + audit/provenance), the
 *       model's INGEN_UTVIDELSE_MULIG sentinel, an out-of-range-length
 *       candidate, a missing ANTHROPIC_API_KEY, and a locked provider —
 *       each proven never to call the Anthropic API when it shouldn't
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
      //       real fetch() calls and the sandbox has no network access. ────
      const prevFetchK = globalThis.fetch;
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
          const host = new URL(String(url)).hostname;
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
      }

      // ── (l) SLICE 5a (dev-request 2026-07-18-gardssalg-profilkvalitet-
      //       foer-outreach): source-grounded rewrite of about_text/visit_text
      //       for the cohort (j)'s replace-thin path deliberately never
      //       touches — non-blank, ALREADY passes meetsAboutQualityBar
      //       (>=80 chars), but still genuinely thin (<200 chars). Covers:
      //       gardssalgRewriteEligible (pure), applyGardssalgProviderContent's
      //       additive rewriteFields param (store-level), and the full
      //       POST /admin/gardssalg-content-refresh rewrite integration
      //       (mocked globalThis.fetch, branching on hostname between the
      //       provider's own homepage and https://api.anthropic.com). ──────
      {
        // Distinct (non-repeating) sentences — meetsAboutQualityBar's
        // hasVerbatimRepeatedPhrase check rejects any text containing a
        // ≥24-char chunk repeated verbatim, so a repeated-unit builder
        // would silently fail the quality bar it's meant to pass.
        const TOO_SHORT_L = "Liten gård med noen dyr og en enkel gårdsbutikk."; // 48 chars, <80 -> fails quality bar
        const PASSING_BUT_THIN_L = // 106 chars, >=80 (passes bar), <200 -> eligible
          "Gården vår ligger vakkert til i dalen med utsikt over fjorden. Vi dyrker poteter og grønnsaker på friland.";
        const ALREADY_LONG_L = // 208 chars, >=200 -> not eligible (even though it passes the bar)
          "Gården vår ligger vakkert til i dalen med utsikt over fjorden og fjellene rundt. Vi dyrker poteter, gulrøtter og andre grønnsaker på friland gjennom hele sommeren, og selger dem direkte fra gårdsbutikken vår.";
        const REWRITTEN_L = // 308 chars, valid 200-500 char rewrite candidate
          "Gården vår ligger vakkert til i dalen med utsikt over fjorden og fjellene rundt. Vi dyrker poteter, gulrøtter og andre grønnsaker på friland gjennom hele sommeren, og selger dem direkte fra gårdsbutikken vår som holder åpent i hele sesongen. Besøkende er hjertelig velkomne til å se hvordan vi driver garden.";

        // (l1-l4) gardssalgRewriteEligible — pure eligibility function.
        assertTrue(!store.gardssalgRewriteEligible(null), "l1: null currentValue -> not eligible");
        assertTrue(!store.gardssalgRewriteEligible(""), "l2: blank currentValue -> not eligible");
        assertTrue(!store.gardssalgRewriteEligible(TOO_SHORT_L), "l3: <80-char (fails quality bar) -> not eligible");
        assertTrue(store.gardssalgRewriteEligible(PASSING_BUT_THIN_L), "l4a: >=80 and <200 chars -> eligible");
        assertTrue(!store.gardssalgRewriteEligible(ALREADY_LONG_L), "l4b: >=200 chars -> not eligible, even though it passes the quality bar");

        // (l5-l10) applyGardssalgProviderContent's rewriteFields param —
        // store-level mechanics, no HTTP/network involved.
        insertProvider.run({
          id: "prov-l-rewrite", navn: "Prov L Rewrite Gard", hjemmeside: "https://prov-l-rewrite.example.no",
          content_source: null, about_text: PASSING_BUT_THIN_L, visit_text: null, opening_hours_text: null,
        });
        insertProvider.run({
          id: "prov-l-already-long", navn: "Prov L Already Long Gard", hjemmeside: "https://prov-l-already-long.example.no",
          content_source: null, about_text: ALREADY_LONG_L, visit_text: null, opening_hours_text: null,
        });
        insertProvider.run({
          id: "prov-l-manual", navn: "Prov L Manual Gard", hjemmeside: "https://prov-l-manual.example.no",
          content_source: "manual", about_text: PASSING_BUT_THIN_L, visit_text: null, opening_hours_text: null,
        });

        // l5: WITHOUT rewriteFields, gardssalgReplaceableFieldAction alone
        // refuses (current value already passes the quality bar) — the
        // existing fill/replace path must stay byte-unchanged.
        const writtenL5 = store.applyGardssalgProviderContent(
          "prov-l-rewrite",
          { about_text: REWRITTEN_L },
          "https://prov-l-rewrite.example.no/om-oss",
        );
        assertEq(writtenL5, [], "l5: no rewriteFields -> passing-but-thin content is still never churned (regression)");
        assertEq(getProviderRow("prov-l-rewrite").about_text, PASSING_BUT_THIN_L, "l5b: about_text unchanged without rewriteFields");

        // l6: WITH rewriteFields naming about_text, AND the row is eligible
        // -> writes, produces an audit row (old_value = the real prior
        // passing-but-thin text) + field_provenance entry, same as any other
        // applyGardssalgProviderContent write.
        const writtenL6 = store.applyGardssalgProviderContent(
          "prov-l-rewrite",
          { about_text: REWRITTEN_L },
          "https://prov-l-rewrite.example.no/om-oss",
          "batch-l",
          new Set(["about_text"]),
        );
        assertEq(writtenL6, ["about_text"], "l6: rewriteFields + eligible row -> about_text is written");
        const rowL6 = getProviderRow("prov-l-rewrite");
        assertEq(rowL6.about_text, REWRITTEN_L, "l6b: about_text now holds the rewritten candidate");
        const auditL6 = getAuditRows("prov-l-rewrite").find((r: any) => r.field_name === "about_text");
        assertTrue(!!auditL6, "l6c: a rewrite still produces an about_text audit row");
        assertEq(auditL6.old_value, PASSING_BUT_THIN_L, "l6d: audit old_value is the real prior passing-but-thin text");
        assertEq(auditL6.new_value, REWRITTEN_L, "l6e: audit new_value is the rewritten candidate");
        assertEq(auditL6.batch_id, "batch-l", "l6f: audit batch_id matches the batchId param");
        const provenanceL6 = JSON.parse(rowL6.field_provenance);
        assertTrue(!!provenanceL6.about_text, "l6g: field_provenance updated for the rewritten field");

        // l7: a second run is idempotent — about_text is now >=200 chars, so
        // it drops out of the eligible set on its own (no extra state/flag).
        const writtenL7 = store.applyGardssalgProviderContent(
          "prov-l-rewrite",
          { about_text: REWRITTEN_L + " enda mer tekst" },
          "https://prov-l-rewrite.example.no/om-oss",
          undefined,
          new Set(["about_text"]),
        );
        assertEq(writtenL7, [], "l7: a second rewrite pass is a no-op — the field is no longer rewrite-eligible once >=200 chars");

        // l8: rewriteFields naming a field that is NOT actually eligible
        // (already >=200 chars) never force-writes it — the writer re-derives
        // eligibility itself, it does not trust the caller's set blindly.
        const writtenL8 = store.applyGardssalgProviderContent(
          "prov-l-already-long",
          { about_text: REWRITTEN_L },
          "https://prov-l-already-long.example.no/om-oss",
          undefined,
          new Set(["about_text"]),
        );
        assertEq(writtenL8, [], "l8: rewriteFields cannot force-write a field the writer itself re-derives as ineligible");
        assertEq(getProviderRow("prov-l-already-long").about_text, ALREADY_LONG_L, "l8b: already-long about_text is unchanged");

        // l9: manual-locked provider — the lock guard supersedes the rewrite
        // path exactly like every other write path (regression).
        const writtenL9 = store.applyGardssalgProviderContent(
          "prov-l-manual",
          { about_text: REWRITTEN_L },
          "https://prov-l-manual.example.no/om-oss",
          undefined,
          new Set(["about_text"]),
        );
        assertEq(writtenL9, [], "l9: manual-locked provider is never touched, even with rewriteFields set");
        assertEq(getAuditRows("prov-l-manual").length, 0, "l9b: no audit row for the locked provider");

        // (l10+) Full route integration: POST /admin/gardssalg-content-refresh
        // actually invoking the LLM rewrite path end-to-end. Mocks
        // globalThis.fetch, branching on hostname between the provider's own
        // homepage (always succeeds, generic content — irrelevant to the
        // outcome since about_text already passes the quality bar regardless
        // of what's extracted) and https://api.anthropic.com (the rewrite
        // call itself).
        const prevFetchL = globalThis.fetch;
        const prevAnthropicKeyL = process.env.ANTHROPIC_API_KEY;
        try {
          const genericHtml = `<html><head><meta property="og:description" content="Gårdsbutikk med lokale varer."></head><body><p>Velkommen til gårdsbutikken vår, åpen hele sommeren.</p></body></html>`;

          insertProvider.run({
            id: "prov-l-route-ok", navn: "Prov L Route OK Gard", hjemmeside: "https://prov-l-route-ok.example.no",
            content_source: null, about_text: PASSING_BUT_THIN_L, visit_text: ALREADY_LONG_L, opening_hours_text: null,
          });
          insertProvider.run({
            id: "prov-l-route-sentinel", navn: "Prov L Route Sentinel Gard", hjemmeside: "https://prov-l-route-sentinel.example.no",
            content_source: null, about_text: PASSING_BUT_THIN_L, visit_text: ALREADY_LONG_L, opening_hours_text: null,
          });
          insertProvider.run({
            id: "prov-l-route-badlen", navn: "Prov L Route Badlen Gard", hjemmeside: "https://prov-l-route-badlen.example.no",
            content_source: null, about_text: PASSING_BUT_THIN_L, visit_text: ALREADY_LONG_L, opening_hours_text: null,
          });
          insertProvider.run({
            id: "prov-l-route-nokey", navn: "Prov L Route Nokey Gard", hjemmeside: "https://prov-l-route-nokey.example.no",
            content_source: null, about_text: PASSING_BUT_THIN_L, visit_text: ALREADY_LONG_L, opening_hours_text: null,
          });
          insertProvider.run({
            id: "prov-l-route-locked", navn: "Prov L Route Locked Gard", hjemmeside: "https://prov-l-route-locked.example.no",
            content_source: "manual", about_text: PASSING_BUT_THIN_L, visit_text: null, opening_hours_text: null,
          });

          let anthropicCallsL = 0;
          function makeFetchL(anthropicResponder: (prompt: string) => { ok: boolean; status: number; json: () => Promise<any> }) {
            return (async (url: string | URL | Request, init?: any) => {
              const u = new URL(String(url));
              if (u.hostname === "api.anthropic.com") {
                anthropicCallsL++;
                const body = JSON.parse(String(init?.body ?? "{}"));
                const prompt = body?.messages?.[0]?.content ?? "";
                return anthropicResponder(prompt) as unknown as Response;
              }
              return { ok: true, status: 200, text: async () => genericHtml } as unknown as Response;
            }) as typeof fetch;
          }

          // l10: successful rewrite, end-to-end — dry-run previews it,
          // apply actually writes it through the existing audit/provenance
          // path (zero new write mechanism).
          process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
          anthropicCallsL = 0;
          globalThis.fetch = makeFetchL(() => ({
            ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: REWRITTEN_L }] }),
          }));
          const dryL10 = await callRoute(opplevelserRouter, {
            url: "/admin/gardssalg-content-refresh",
            headers: { "x-admin-key": testKey },
            body: { providerIds: ["prov-l-route-ok"], apply: false },
          });
          assertEq(dryL10.status, 200, "l10a: dry-run -> 200");
          const dryEntryL10 = dryL10.body.changed.find((c: any) => c.provider_id === "prov-l-route-ok");
          assertTrue(!!dryEntryL10, "l10b: prov-l-route-ok appears in dry-run changed[]");
          assertEq(dryEntryL10.actions.about_text, "rewritten", "l10c: dry-run projects about_text as 'rewritten'");
          assertEq(getProviderRow("prov-l-route-ok").about_text, PASSING_BUT_THIN_L, "l10d: dry-run performed ZERO writes");

          const applyL10 = await callRoute(opplevelserRouter, {
            url: "/admin/gardssalg-content-refresh",
            headers: { "x-admin-key": testKey },
            body: { providerIds: ["prov-l-route-ok"], apply: true },
          });
          assertEq(applyL10.status, 200, "l10e: apply -> 200");
          const applyEntryL10 = applyL10.body.changed.find((c: any) => c.provider_id === "prov-l-route-ok");
          assertTrue(!!applyEntryL10, "l10f: prov-l-route-ok appears in apply changed[]");
          assertEq(applyEntryL10.actions.about_text, "rewritten", "l10g: apply response tags about_text 'rewritten'");
          assertEq(getProviderRow("prov-l-route-ok").about_text, REWRITTEN_L, "l10h: about_text actually rewritten in the DB");
          const auditL10 = getAuditRows("prov-l-route-ok").find((r: any) => r.field_name === "about_text");
          assertTrue(!!auditL10, "l10i: apply produced an about_text audit row for the rewrite");
          assertEq(auditL10.old_value, PASSING_BUT_THIN_L, "l10j: audit old_value is the real prior passing-but-thin text");
          assertEq(auditL10.new_value, REWRITTEN_L, "l10k: audit new_value is the LLM rewrite");

          // l11: the model's own "not enough material" sentinel -> no write,
          // field unchanged, no audit row.
          globalThis.fetch = makeFetchL(() => ({
            ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
          }));
          const applyL11 = await callRoute(opplevelserRouter, {
            url: "/admin/gardssalg-content-refresh",
            headers: { "x-admin-key": testKey },
            body: { providerIds: ["prov-l-route-sentinel"], apply: true },
          });
          assertEq(applyL11.status, 200, "l11a: sentinel response -> 200");
          assertTrue(
            !applyL11.body.changed.some((c: any) => c.provider_id === "prov-l-route-sentinel"),
            "l11b: sentinel response -> prov-l-route-sentinel has nothing to write (about_text ineligible-extraction, visit_text already long)",
          );
          assertEq(getProviderRow("prov-l-route-sentinel").about_text, PASSING_BUT_THIN_L, "l11c: about_text unchanged after a sentinel response");
          assertEq(getAuditRows("prov-l-route-sentinel").length, 0, "l11d: no audit row for a sentinel (never-fabricate) response");

          // l12: a candidate outside the 200-500 char range (too short) is
          // rejected by the code-enforced length gate, not trusted to the
          // prompt/model alone.
          globalThis.fetch = makeFetchL(() => ({
            ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "For kort til å telle." }] }),
          }));
          const applyL12 = await callRoute(opplevelserRouter, {
            url: "/admin/gardssalg-content-refresh",
            headers: { "x-admin-key": testKey },
            body: { providerIds: ["prov-l-route-badlen"], apply: true },
          });
          assertEq(applyL12.status, 200, "l12a: out-of-range-length response -> 200");
          assertEq(getProviderRow("prov-l-route-badlen").about_text, PASSING_BUT_THIN_L, "l12b: about_text unchanged — the too-short candidate was rejected, not written");
          assertEq(getAuditRows("prov-l-route-badlen").length, 0, "l12c: no audit row for a rejected out-of-range candidate");

          // l13: ANTHROPIC_API_KEY missing -> generateGardssalgAboutRewrite
          // returns null for every call, WITHOUT ever calling fetch (mirrors
          // generateTitleNo's own missing-key contract) — route behaves
          // exactly as before this slice.
          delete process.env.ANTHROPIC_API_KEY;
          anthropicCallsL = 0;
          globalThis.fetch = makeFetchL(() => {
            throw new Error("l13: Anthropic must NOT be called when ANTHROPIC_API_KEY is missing");
          });
          const applyL13 = await callRoute(opplevelserRouter, {
            url: "/admin/gardssalg-content-refresh",
            headers: { "x-admin-key": testKey },
            body: { providerIds: ["prov-l-route-nokey"], apply: true },
          });
          assertEq(applyL13.status, 200, "l13a: missing ANTHROPIC_API_KEY -> 200 (does not throw/500)");
          assertEq(anthropicCallsL, 0, "l13b: Anthropic was never called when the key is missing");
          assertEq(getProviderRow("prov-l-route-nokey").about_text, PASSING_BUT_THIN_L, "l13c: about_text unchanged when the key is missing");
          process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

          // l14: manual-locked provider -> the lock check short-circuits
          // BEFORE any fetch at all, so Anthropic is never called either.
          anthropicCallsL = 0;
          globalThis.fetch = makeFetchL(() => {
            throw new Error("l14: Anthropic must NOT be called for a locked provider");
          });
          const applyL14 = await callRoute(opplevelserRouter, {
            url: "/admin/gardssalg-content-refresh",
            headers: { "x-admin-key": testKey },
            body: { providerIds: ["prov-l-route-locked"], apply: true },
          });
          assertEq(applyL14.status, 200, "l14a: locked provider -> 200");
          assertTrue(applyL14.body.skipped_locked.includes("prov-l-route-locked"), "l14b: locked provider reported in skipped_locked");
          assertEq(anthropicCallsL, 0, "l14c: Anthropic was never called for a locked provider (lock check happens before any fetch)");
        } finally {
          globalThis.fetch = prevFetchL;
          if (prevAnthropicKeyL === undefined) delete process.env.ANTHROPIC_API_KEY;
          else process.env.ANTHROPIC_API_KEY = prevAnthropicKeyL;
        }
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

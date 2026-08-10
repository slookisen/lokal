/**
 * opplevelser-gardssalg-brreg-verify.test.ts — tests for
 * POST /admin/gardssalg-brreg-verify (src/routes/opplevelser.ts), added for
 * dev-request 2026-08-08-gardssalg-brreg-verify-og-embedded-evidens: the
 * missing lever that stamps krav-2's brreg_verified flag from live Brreg
 * evidence (org exists + is still active), measured as
 * the single largest one-lever pool unlock (57 rows blocked by the flag
 * alone on 2026-08-08).
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly) and stubs
 * the Brreg lookup via __setGardssalgBrregVerifyForTesting — no network I/O.
 *
 * Covers:
 *   (a) 403 without/with wrong X-Admin-Key
 *   (b) dry-run default: verified candidates reported, NOTHING written
 *   (c) apply: brreg_verified=1 + brreg_active=1 written, audit rows +
 *       field_provenance.brreg_verified stamped, readiness flag flips
 *   (d) evidence gates that must NEVER write: inactive (bankrupt/dissolved),
 *       orgnr_not_found. NOTE (Daniel, 2026-08-10): a divergent Brreg name is
 *       NO LONGER a gate — registered names legitimately differ from the name
 *       a company trades under ("AS" above all), and the exact-match rule
 *       rejected 8 of 9 correct rows in prod. Identity is settled where the
 *       org_nr is written; this lever answers exists + active. The name is
 *       still reported on the verified row so a wrong org_nr stays visible.
 *   (e) cohort discipline: already-verified rows and rows without org_nr
 *       excluded from auto-selection (no_orgnr_total reported); locked
 *       (manual/claim) and test-provider rows never touched; providerIds
 *       override reports skipped_locked / already_verified / no_orgnr /
 *       not_found buckets
 *   (f) idempotence: second apply run finds an empty cohort
 *   (g) Skive 4 (dev-request 2026-08-09-daglig-outreach-klargjoering-og-
 *       stoerrelsesgate — supervisor-inbox/2026-08-10-priority-headsup-
 *       stoerrelsesgaten-er-inert-antall-ansatte-mangler.md): opt-in
 *       `refreshEmployees` on providerIds mode backfills antall_ansatte on
 *       ALREADY-verified rows (AK11) without ever re-stamping
 *       brreg_verified/brreg_active; default (no flag) is byte-for-byte
 *       unchanged (AK12); a row whose antall_ansatte is already set is a
 *       no-op (AK13); an unverified row with the flag set takes the normal
 *       first-time-verify path unaffected (AK14); manual/claim lock still
 *       wins over the refresh path (AK15).
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
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: "/admin/gardssalg-brreg-verify",
      originalUrl: "/admin/gardssalg-brreg-verify",
      path: "/admin/gardssalg-brreg-verify",
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
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

export function runOpplevelserGardssalgBrregVerifyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-brreg-verify-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, storePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            content_source, brreg_verified, brreg_active, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @rfb_seed_source, @producer_type,
            @content_source, @brreg_verified, @brreg_active, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // Verifiable seed row — the 57-cohort shape: org_nr present, name that
      // exact-matches Brreg's registered name after display-name pruning
      // ("— Sted" suffix + org-form suffix + casing).
      insertProvider.run({
        id: "bv-ok",
        navn: "Senja Handbryggeri — Vangsvik",
        org_nr: "913936507",
        kommune: "Senja",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: "provider_site",
        brreg_verified: 0,
        brreg_active: 0,
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://x.no", fetched_at: "2026-01-01T00:00:00Z" } }),
      });
      // Name-mismatch row: Brreg will answer with a different company name.
      insertProvider.run({
        id: "bv-mismatch",
        navn: "Alde Sider",
        org_nr: "999888777",
        kommune: "Ulvik",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: "provider_site",
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });
      // Inactive row: Brreg says konkurs.
      insertProvider.run({
        id: "bv-dead",
        navn: "Konkurs Bryggeri",
        org_nr: "888777666",
        kommune: "Oslo",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        content_source: null,
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });
      // Unknown org_nr row: Brreg 404.
      insertProvider.run({
        id: "bv-gone",
        navn: "Forsvunnet Gård",
        org_nr: "777666555",
        kommune: "Voss",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: null,
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });
      // Already verified: must be OUTSIDE the auto-cohort.
      insertProvider.run({
        id: "bv-done",
        navn: "Ferdig Verifisert",
        org_nr: "111222333",
        kommune: "Voss",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: null,
        brreg_verified: 1,
        brreg_active: 1,
        field_provenance: null,
      });
      // No org_nr: outside cohort, counted in no_orgnr_total.
      insertProvider.run({
        id: "bv-noorg",
        navn: "Uten Orgnr Gård",
        org_nr: null,
        kommune: "Voss",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: null,
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });
      // Claim-locked: must never be written, reported skipped_locked via ids.
      insertProvider.run({
        id: "bv-locked",
        navn: "Claimet Gård",
        org_nr: "444555666",
        kommune: "Voss",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: "claim",
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });
      // Test provider + non-gårdssalg row: both outside scope entirely.
      insertProvider.run({
        id: "bv-testprov",
        navn: "Test Provider",
        org_nr: "123123123",
        kommune: "Oslo",
        rfb_seed_source: null,
        producer_type: "test-gardssalg",
        content_source: null,
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });
      insertProvider.run({
        id: "bv-outside",
        navn: "Ikke Gårdssalg",
        org_nr: "321321321",
        kommune: "Oslo",
        rfb_seed_source: null,
        producer_type: null,
        content_source: null,
        brreg_verified: 0,
        brreg_active: null,
        field_provenance: null,
      });

      // Brreg stub — keyed on org_nr, mirrors verifyOrgNumber()'s result shape.
      const brregAnswers: Record<string, any> = {
        "913936507": {
          exists: true, active: true, name: "SENJA HANDBRYGGERI AS",
          nace: ["11.050"], registrertDato: "2014-01-01", slettetDato: null, flag: null,
        },
        "999888777": {
          exists: true, active: true, name: "ULVIK FRUKT OG CIDERI AS",
          nace: ["11.030"], registrertDato: "2015-01-01", slettetDato: null, flag: null,
        },
        "888777666": {
          exists: true, active: false, name: "KONKURS BRYGGERI AS",
          nace: ["11.050"], registrertDato: "2016-01-01", slettetDato: null, flag: "bankrupt",
        },
        "777666555": {
          exists: false, active: false, name: null, nace: [], registrertDato: null, slettetDato: null, flag: "no_orgnr",
        },
        // Skive 4 fixtures — bv-done itself reuses "111222333" (already
        // verified, antall_ansatte still NULL, exactly the Macks-in-prod shape).
        "111222333": {
          exists: true, active: true, name: "FERDIG VERIFISERT AS",
          nace: ["11.050"], registrertDato: "2012-01-01", slettetDato: null, flag: null, employees: 119,
        },
        "222333444": {
          exists: true, active: true, name: "FERSK MED FLAGG AS",
          nace: ["11.050"], registrertDato: "2018-01-01", slettetDato: null, flag: null, employees: 30,
        },
      };
      const calls: string[] = [];
      expStore.__setGardssalgBrregVerifyForTesting(async (orgNr: string) => {
        calls.push(orgNr);
        return brregAnswers[orgNr] ?? { exists: false, active: false, name: null, nace: [], registrertDato: null, slettetDato: null, flag: "no_orgnr" };
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default;

      // ── (a) admin gate ────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { body: {} });
      assertEq(noKey.status, 403, "(a) 403 without X-Admin-Key");
      const wrongKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" }, body: {} });
      assertEq(wrongKey.status, 403, "(a) 403 with wrong X-Admin-Key");

      // ── (b) dry-run default ───────────────────────────────────────────────
      process.env.ADMIN_KEY = testKey;
      const dry = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: {} });
      assertEq(dry.status, 200, "(b) dry-run 200");
      assertEq(dry.body.dry_run, true, "(b) dry-run default without apply");
      assertEq(dry.body.cohort_total, 4, "(b) cohort = the 4 unverified org_nr rows (done/noorg/locked/test/outside excluded)");
      assertEq(dry.body.no_orgnr_total, 1, "(b) no_orgnr_total counts the org_nr-less unverified row");
      // Daniel, 2026-08-10: verification answers for the ORG NUMBER, not the
      // name — registered names legitimately diverge from the name a company
      // trades under (the legal "AS" suffix above all). A divergent name no
      // longer blocks; existence and active status still do.
      assertEq(dry.body.verified_count, 2, "(b) both live, existing org numbers verify — name no longer gates");
      assertEq(
        (dry.body.verified as Array<{ provider_id: string }>).map((r) => r.provider_id).sort(),
        ["bv-mismatch", "bv-ok"],
        "(b) the row whose Brreg name differs verifies too (Alde Sider / ULVIK FRUKT OG CIDERI AS)",
      );
      assertEq((dry.body.name_mismatch as unknown[]).length, 0, "(b) nothing is rejected for a divergent name any more");
      assertEq(
        (dry.body.verified as Array<{ provider_id: string; brreg_name: string }>)
          .find((r) => r.provider_id === "bv-mismatch")?.brreg_name,
        "ULVIK FRUKT OG CIDERI AS",
        "(b) Brreg's name is still reported verbatim — visible to the operator, just not a gate",
      );
      assertEq(dry.body.inactive[0]?.provider_id, "bv-dead", "(b) inactive row reported");
      assertEq(dry.body.inactive[0]?.flag, "bankrupt", "(b) inactive flag carried through");
      assertEq(dry.body.orgnr_not_found[0]?.provider_id, "bv-gone", "(b) 404 org_nr reported");
      const afterDry = expDb
        .prepare(`SELECT id, brreg_verified FROM experience_providers WHERE brreg_verified = 1 ORDER BY id`)
        .all() as Array<{ id: string }>;
      assertEq(afterDry.map((r) => r.id), ["bv-done"], "(b) dry-run wrote NOTHING (only the pre-verified fixture remains)");

      // ── (c) apply ─────────────────────────────────────────────────────────
      const applyRes = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: { apply: true } });
      assertEq(applyRes.body.dry_run, false, "(c) apply run");
      assertEq(applyRes.body.verified_count, 2, "(c) both live rows written");
      assertEq(
        (applyRes.body.verified as Array<{ provider_id: string; fields_written: string[] }>)
          .find((r) => r.provider_id === "bv-ok")?.fields_written,
        ["brreg_verified", "brreg_active"],
        "(c) both flags written (0 -> 1)",
      );
      const okRow = expDb
        .prepare(`SELECT brreg_verified, brreg_active, field_provenance FROM experience_providers WHERE id = 'bv-ok'`)
        .get() as { brreg_verified: number; brreg_active: number; field_provenance: string };
      assertEq(okRow.brreg_verified, 1, "(c) brreg_verified = 1 persisted");
      assertEq(okRow.brreg_active, 1, "(c) brreg_active = 1 persisted");
      const prov = JSON.parse(okRow.field_provenance || "{}");
      assertTrue(
        typeof prov.brreg_verified?.source_url === "string" && prov.brreg_verified.source_url.includes("/enheter/913936507"),
        "(c) field_provenance.brreg_verified carries the Brreg enhets-API URL",
      );
      assertTrue(
        typeof prov.hjemmeside?.source_url === "string",
        "(c) existing provenance keys preserved (read-modify-write)",
      );
      const audits = expDb
        .prepare(
          `SELECT field_name, old_value, new_value FROM gardssalg_content_audit WHERE provider_id = 'bv-ok' ORDER BY field_name`,
        )
        .all() as Array<{ field_name: string; old_value: string | null; new_value: string }>;
      assertEq(
        audits,
        [
          { field_name: "brreg_active", old_value: "0", new_value: "1" },
          { field_name: "brreg_verified", old_value: "0", new_value: "1" },
        ],
        "(c) one audit row per changed field with true pre-write old_value",
      );
      const mismatchRow = expDb
        .prepare(`SELECT brreg_verified FROM experience_providers WHERE id = 'bv-mismatch'`)
        .get() as { brreg_verified: number };
      assertEq(mismatchRow.brreg_verified, 1,
        "(d) a live org with a divergent registered name IS written — identity was settled when the org_nr was stored");
      const deadRow = expDb.prepare(`SELECT brreg_verified FROM experience_providers WHERE id = 'bv-dead'`).get() as {
        brreg_verified: number;
      };
      assertEq(deadRow.brreg_verified, 0, "(d) inactive row NOT written on apply");
      const goneRow = expDb.prepare(`SELECT brreg_verified FROM experience_providers WHERE id = 'bv-gone'`).get() as {
        brreg_verified: number;
      };
      assertEq(goneRow.brreg_verified, 0, "(d) orgnr_not_found row NOT written on apply");
      const lockedRow = expDb.prepare(`SELECT brreg_verified FROM experience_providers WHERE id = 'bv-locked'`).get() as {
        brreg_verified: number;
      };
      assertEq(lockedRow.brreg_verified, 0, "(e) claim-locked row untouched by auto-cohort apply");

      // ── (e) providerIds override buckets ─────────────────────────────────
      const byIds = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["bv-locked", "bv-done", "bv-noorg", "no-such-id", "bv-testprov"] },
      });
      assertEq(byIds.body.skipped_locked[0]?.provider_id, "bv-locked", "(e) locked reported skipped_locked");
      assertEq(byIds.body.already_verified[0]?.provider_id, "bv-done", "(e) verified reported already_verified");
      assertEq(byIds.body.no_orgnr[0]?.provider_id, "bv-noorg", "(e) org_nr-less reported no_orgnr");
      assertTrue(byIds.body.not_found.includes("no-such-id"), "(e) unknown id reported not_found");
      assertTrue(byIds.body.not_found.includes("bv-testprov"), "(e) test provider out of scope (not_found)");
      assertEq(byIds.body.scanned, 0, "(e) nothing scanned from the override buckets");

      // ── (f) idempotence ──────────────────────────────────────────────────
      const secondApply = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: { apply: true } });
      assertEq(secondApply.body.cohort_total, 2, "(f) both verified rows left the cohort (4 -> 2)");
      assertEq(secondApply.body.verified_count, 0, "(f) second apply verifies nothing new");
      const auditCount = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'bv-ok'`)
        .get() as { n: number };
      assertEq(auditCount.n, 2, "(f) no duplicate audit rows on re-run");

      // ── (g) Skive 4: antall_ansatte refresh for already-verified rows ────
      // New fixtures inserted here (not in the shared setup above) so the
      // fixed cohort/verified counts asserted in (b)/(c)/(e)/(f) above stay
      // unchanged — those ran against the ORIGINAL fixture set only.
      insertProvider.run({
        id: "bv-fresh-with-flag",
        navn: "Fersk Med Flagg",
        org_nr: "222333444",
        kommune: "Oslo",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: "provider_site",
        brreg_verified: 0,
        brreg_active: 0,
        field_provenance: null,
      });
      insertProvider.run({
        id: "bv-locked-done",
        navn: "Låst Og Ferdig",
        org_nr: "555444333",
        kommune: "Oslo",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        content_source: "claim",
        brreg_verified: 1,
        brreg_active: 1,
        field_provenance: null,
      });

      // AK11 — dry-run: reports the Brreg employee count for an
      // already-verified row, writes nothing.
      const refreshDry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["bv-done"], refreshEmployees: true },
      });
      assertEq(refreshDry.body.dry_run, true, "(g) AK11: dry-run default even with refreshEmployees:true");
      assertEq(refreshDry.body.already_verified.length, 0, "(g) AK11: refresh-eligible row does NOT land in already_verified");
      assertEq(
        (refreshDry.body.employees_refreshed as Array<{ provider_id: string; antall_ansatte: number | null }>)
          .find((r) => r.provider_id === "bv-done")?.antall_ansatte,
        119,
        "(g) AK11: dry-run reports Macks-shape row's Brreg employee count",
      );
      const beforeWrite = expDb
        .prepare(`SELECT antall_ansatte FROM experience_providers WHERE id = 'bv-done'`)
        .get() as { antall_ansatte: number | null };
      assertEq(beforeWrite.antall_ansatte, null, "(g) AK11: dry-run writes NOTHING");

      // AK11 — apply: writes ONLY antall_ansatte, brreg_verified/brreg_active untouched.
      const refreshApply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["bv-done"], refreshEmployees: true, apply: true },
      });
      assertEq(
        (refreshApply.body.employees_refreshed as Array<{ provider_id: string; fields_written: string[] }>)
          .find((r) => r.provider_id === "bv-done")?.fields_written,
        ["antall_ansatte"],
        "(g) AK11: apply writes ONLY antall_ansatte",
      );
      const doneRowAfter = expDb
        .prepare(`SELECT antall_ansatte, brreg_verified, brreg_active FROM experience_providers WHERE id = 'bv-done'`)
        .get() as { antall_ansatte: number; brreg_verified: number; brreg_active: number };
      assertEq(doneRowAfter.antall_ansatte, 119, "(g) AK11: antall_ansatte persisted");
      assertEq(doneRowAfter.brreg_verified, 1, "(g) AK11: brreg_verified untouched (never re-stamped)");
      assertEq(doneRowAfter.brreg_active, 1, "(g) AK11: brreg_active untouched");
      const doneAudit = expDb
        .prepare(
          `SELECT field_name, old_value, new_value FROM gardssalg_content_audit WHERE provider_id = 'bv-done' ORDER BY field_name`,
        )
        .all() as Array<{ field_name: string; old_value: string | null; new_value: string }>;
      assertEq(
        doneAudit,
        [{ field_name: "antall_ansatte", old_value: null, new_value: "119" }],
        "(g) AK11: exactly one audit row, for antall_ansatte only",
      );

      // AK13 — no-op once antall_ansatte is already set. Proven directly
      // against the store function: the route itself now buckets bv-done
      // back into already_verified (antall_ansatte no longer null), so the
      // refresh code path is unreachable for it via the route from here on.
      const noopWritten = expStore.applyGardssalgBrregEmployeesRefresh(
        "bv-done",
        "https://data.brreg.no/enhetsregisteret/api/enheter/111222333",
        "test-batch",
        200,
      );
      assertEq(noopWritten, [], "(g) AK13: applyGardssalgBrregEmployeesRefresh no-ops when antall_ansatte is already set");
      const doneRowUnchanged = expDb
        .prepare(`SELECT antall_ansatte FROM experience_providers WHERE id = 'bv-done'`)
        .get() as { antall_ansatte: number };
      assertEq(doneRowUnchanged.antall_ansatte, 119, "(g) AK13: existing value NEVER overwritten by a second refresh");
      const refreshSecondRoute = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["bv-done"], refreshEmployees: true, apply: true },
      });
      assertEq(
        refreshSecondRoute.body.already_verified[0]?.provider_id,
        "bv-done",
        "(g) AK13 (route level): once antall_ansatte is set, the row falls back to already_verified even with refreshEmployees:true",
      );

      // AK14 — an UNVERIFIED row with refreshEmployees:true takes the
      // normal first-time-verify path, unaffected by the new flag.
      const freshWithFlag = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["bv-fresh-with-flag"], refreshEmployees: true, apply: true },
      });
      assertEq(freshWithFlag.body.scanned, 1, "(g) AK14: unverified row still takes the normal first-time-verify path");
      assertEq(
        (freshWithFlag.body.verified as Array<{ provider_id: string; fields_written: string[] }>)
          .find((r) => r.provider_id === "bv-fresh-with-flag")?.fields_written,
        ["brreg_verified", "brreg_active", "antall_ansatte"],
        "(g) AK14: first-time verify still stamps all three fields, unaffected by refreshEmployees",
      );
      assertEq(
        (freshWithFlag.body.employees_refreshed as unknown[]).length,
        0,
        "(g) AK14: nothing routed through the refresh-only path for a not-yet-verified row",
      );

      // AK15 — manual/claim lock still wins over refreshEmployees for an
      // already-verified row.
      const lockedDoneRefresh = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["bv-locked-done"], refreshEmployees: true, apply: true },
      });
      assertEq(
        lockedDoneRefresh.body.skipped_locked[0]?.provider_id,
        "bv-locked-done",
        "(g) AK15: manual/claim lock still wins over refreshEmployees for an already-verified row",
      );
      assertEq(
        (lockedDoneRefresh.body.employees_refreshed as unknown[]).length,
        0,
        "(g) AK15: locked row never reaches the refresh path",
      );
      const lockedDoneRow = expDb
        .prepare(`SELECT antall_ansatte FROM experience_providers WHERE id = 'bv-locked-done'`)
        .get() as { antall_ansatte: number | null };
      assertEq(lockedDoneRow.antall_ansatte, null, "(g) AK15: locked row's antall_ansatte never written");

      expStore.__setGardssalgBrregVerifyForTesting(null);
      return { passed, failed, failures };
    } finally {
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      expStore.__setGardssalgBrregVerifyForTesting(null);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-brreg-verify.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgBrregVerifyTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-brreg-verify: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(f);
      process.exit(1);
    }
  });
}

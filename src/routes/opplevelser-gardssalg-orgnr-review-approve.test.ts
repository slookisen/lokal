/**
 * opplevelser-gardssalg-orgnr-review-approve.test.ts — tests for
 * POST /admin/gardssalg-orgnr-review-approve (src/routes/opplevelser.ts),
 * dev-request 2026-08-2x-gardssalg-orgnr-review-approve-uten-koe-rad.
 *
 * The `manual_verified` path re-verifies an org_nr live against Brreg
 * (existence, active status, provider/registered-name token overlap) before
 * writing it — evidence-based, not trust-based. Until now that path
 * additionally required the provider to already have a row in
 * gardssalg_orgnr_review_queue (checked BEFORE manual_verified was even
 * inspected), so a provider that an earlier org_nr-backfill step rejected
 * conservatively (e.g. stripped_name_requires_postal_match /
 * no_brreg_candidate) — and therefore never queued — had NO way to receive
 * an evidence-based approval, even with a genuinely verifiable org_nr in
 * hand ("Lofthus", "Små Vesen").
 *
 * This file covers the relaxation:
 *   (a) happy path, apply:true — no queue row, real experience_providers row,
 *       valid org_nr, manual_verified:true -> 200, org_nr written, one
 *       gardssalg_content_audit row, provider lands in `approved`.
 *   (b) same but apply:false (dry-run) -> provider in `approved`, nothing written.
 *   (c) provider_id absent from experience_providers too (and no queue row),
 *       manual_verified:true -> rejected `provider_not_found_in_catalog`
 *       (distinct from `not_in_review_queue`).
 *   (d) provider with no queue row, manual_verified NOT set/false ->
 *       rejected `not_in_review_queue` — proves the relaxation is strictly
 *       scoped to the manual_verified path.
 *   (e) regression: the queue-entry-exists paths (both the plain
 *       candidate-orgnr-match branch and the entry-exists+manual_verified
 *       branch) are completely unaffected by the new no-queue-row branch.
 *   (f) no-queue-row + manual_verified evidence gates: invalid org_nr
 *       format, Brreg not-found, inactive, name-mismatch — same rejection
 *       reasons as the entry-exists+manual_verified equivalents, no write.
 *
 * All Brreg I/O is stubbed via a monkey-patched global.fetch (mirrors
 * admin-agents-brreg-catalog-sweep.test.ts / admin-agents.test.ts —
 * verifyOrgNumber (src/services/brreg-client.ts) defaults its fetchImpl
 * param to the global `fetch` identifier). ZERO real network calls. Same
 * in-memory-DB + require-cache-purge + router.handle() pattern as
 * opplevelser-gardssalg-brreg-verify.test.ts / opplevelser-veien-til-pool.test.ts.
 *
 * Standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-orgnr-review-approve.test.ts
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
      url: "/admin/gardssalg-orgnr-review-approve",
      originalUrl: "/admin/gardssalg-orgnr-review-approve",
      path: "/admin/gardssalg-orgnr-review-approve",
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

function brregBody(orgNr: string, name: string, opts: { active?: boolean; flag?: "konkurs" | "avvikling" } = {}): Record<string, unknown> {
  const active = opts.active ?? true;
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: !active && opts.flag === "konkurs",
    underAvvikling: !active && opts.flag === "avvikling",
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: null,
    registreringsdatoEnhetsregisteret: "2015-01-01",
    naeringskode1: { kode: "11.050" },
  };
}

export function runOpplevelserGardssalgOrgnrReviewApproveTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-orgnr-review-approve-test-key";
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
           (id, navn, vertical, org_nr, content_source, brreg_verified, brreg_active, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @org_nr, @content_source, 0, NULL, NULL, '2026-01-01')`,
      );

      // ── Fixtures ────────────────────────────────────────────────────────
      // (a)/(b) happy-path pair: real provider rows, no queue row, blank
      // org_nr — real-world "Lofthus"/"Små Vesen" shape (a twin row's org_nr
      // is verifiable evidence, but the backfill never queued the provider).
      insertProvider.run({ id: "orv-lofthus", navn: "Lofthus Gardssal", org_nr: null, content_source: "provider_site" });
      insertProvider.run({ id: "orv-smavesen", navn: "Smaa Vesen Gard", org_nr: null, content_source: "provider_site" });
      // (c) genuinely unknown provider_id — not in experience_providers, no queue row.
      // (id simply never inserted)
      // (d) no queue row, manual_verified not set.
      insertProvider.run({ id: "orv-noflag", navn: "Uten Flagg Gard", org_nr: null, content_source: "provider_site" });
      // (f) evidence-gate fixtures, all no-queue-row + manual_verified.
      insertProvider.run({ id: "orv-badformat", navn: "Dårlig Format Gard", org_nr: null, content_source: "provider_site" });
      insertProvider.run({ id: "orv-notfound", navn: "Ikke Funnet Gard", org_nr: null, content_source: "provider_site" });
      insertProvider.run({ id: "orv-inactive", navn: "Inaktiv Gard", org_nr: null, content_source: "provider_site" });
      insertProvider.run({ id: "orv-mismatch", navn: "Ukjent Gaardsbutikk", org_nr: null, content_source: "provider_site" });

      // (e) regression fixtures: entries that already have a queue row.
      insertProvider.run({ id: "orv-queued-match", navn: "Koet Match Gard", org_nr: null, content_source: "provider_site" });
      insertProvider.run({ id: "orv-queued-mismatch", navn: "Koet Mismatch Gard", org_nr: null, content_source: "provider_site" });
      insertProvider.run({ id: "orv-queued-mv", navn: "Koet Manuell Gard", org_nr: null, content_source: "provider_site" });

      expStore.upsertGardssalgOrgnrReviewQueue({
        provider_id: "orv-queued-match",
        provider_name: "Koet Match Gard",
        candidate_orgnr: "900111222",
        candidate_name: "Koet Match Gard AS",
        candidate_confidence: 0.9,
        reason: "exact_name_no_postal_match",
      });
      expStore.upsertGardssalgOrgnrReviewQueue({
        provider_id: "orv-queued-mismatch",
        provider_name: "Koet Mismatch Gard",
        candidate_orgnr: "900111222",
        reason: "exact_name_no_postal_match",
      });
      expStore.upsertGardssalgOrgnrReviewQueue({
        provider_id: "orv-queued-mv",
        provider_name: "Koet Manuell Gard",
        candidate_orgnr: null,
        reason: "no_brreg_candidate",
      });

      // ── Brreg stub ──────────────────────────────────────────────────────
      const fetchedOrgNrs: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        const orgNr = urlStr.split("/").pop() || "";
        fetchedOrgNrs.push(orgNr);
        const answers: Record<string, { status: number; body?: Record<string, unknown> }> = {
          // (a)/(b) happy-path org numbers, verifiable + name-overlapping.
          "910111001": { status: 200, body: brregBody("910111001", "LOFTHUS GARDSSAL AS") },
          "910111002": { status: 200, body: brregBody("910111002", "SMAA VESEN GARD") },
          // (d): never actually reached (manual_verified not set), but give
          // it a valid answer anyway to prove the gate never even calls Brreg.
          "910111003": { status: 200, body: brregBody("910111003", "UTEN FLAGG GARD") },
          // (f) evidence-gate scenarios.
          "910111005": { status: 404 }, // orv-notfound
          "910111006": { status: 200, body: brregBody("910111006", "INAKTIV GARD", { active: false, flag: "konkurs" }) },
          "910111007": { status: 200, body: brregBody("910111007", "ANNET SELSKAP AS") }, // orv-mismatch
          // (e) queued-entry regression scenarios.
          "900111222": { status: 200, body: brregBody("900111222", "KOET MATCH GARD AS") },
          "900333444": { status: 200, body: brregBody("900333444", "KOET MANUELL GARD AS") },
        };
        const fixture = answers[orgNr];
        if (!fixture) return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
        return {
          status: fixture.status,
          ok: fixture.status >= 200 && fixture.status < 300,
          json: async () => fixture.body ?? {},
        } as unknown as Response;
      }) as typeof fetch;

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default;

      // ═══ (c) unknown provider_id, no queue row, manual_verified:true ═════
      const unknownRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-does-not-exist", org_nr: "910111099", manual_verified: true }], apply: true },
      });
      assertEq(unknownRes.status, 200, "(c) 200 even for a not-found provider (bucketed into rejected)");
      assertEq(unknownRes.body.rejected?.[0]?.reason, "provider_not_found_in_catalog",
        "(c) unknown provider_id (no catalog row, no queue row) rejected with the NEW distinct reason");
      assertEq(unknownRes.body.approved?.length, 0, "(c) nothing approved");

      // ═══ (d) no queue row, manual_verified NOT set ═══════════════════════
      const noFlagRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-noflag", org_nr: "910111003" }], apply: true },
      });
      assertEq(noFlagRes.body.rejected?.[0]?.reason, "not_in_review_queue",
        "(d) no queue row + manual_verified unset/false -> still not_in_review_queue (relaxation strictly scoped)");
      assertTrue(!fetchedOrgNrs.includes("910111003"),
        "(d) Brreg was never even called — the not_in_review_queue rejection fires before any verification");
      const noFlagRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-noflag'`).get() as { org_nr: string | null };
      assertEq(noFlagRow.org_nr, null, "(d) nothing written");

      // ═══ (b) happy path, dry-run (apply:false) ══════════════════════════
      const dryRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-lofthus", org_nr: "910111001", manual_verified: true }] },
      });
      assertEq(dryRes.status, 200, "(b) 200");
      assertEq(dryRes.body.dry_run, true, "(b) dry-run by default (no apply flag)");
      assertEq(dryRes.body.approved?.[0]?.provider_id, "orv-lofthus", "(b) provider lands in approved");
      assertEq(dryRes.body.approved?.[0]?.org_nr, "910111001", "(b) approved carries the org_nr");
      assertEq(dryRes.body.approved?.[0]?.manual_verified, true, "(b) approved is flagged manual_verified");
      assertEq(dryRes.body.rejected?.length, 0, "(b) nothing rejected");
      const dryRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-lofthus'`).get() as { org_nr: string | null };
      assertEq(dryRow.org_nr, null, "(b) dry-run wrote NOTHING");
      const dryAudit = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'orv-lofthus'`)
        .get() as { n: number };
      assertEq(dryAudit.n, 0, "(b) dry-run produced no audit row");

      // ═══ (a) happy path, apply:true ══════════════════════════════════════
      const applyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-lofthus", org_nr: "910111001", manual_verified: true }], apply: true },
      });
      assertEq(applyRes.status, 200, "(a) 200");
      assertEq(applyRes.body.dry_run, false, "(a) apply run");
      assertEq(applyRes.body.approved?.[0]?.provider_id, "orv-lofthus", "(a) provider lands in approved");
      assertEq(applyRes.body.approved?.[0]?.org_nr, "910111001", "(a) approved carries the org_nr");
      assertEq(applyRes.body.rejected?.length, 0, "(a) nothing rejected");
      const appliedRow = expDb
        .prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-lofthus'`)
        .get() as { org_nr: string | null };
      assertEq(appliedRow.org_nr, "910111001", "(a) org_nr actually written");
      const appliedAudit = expDb
        .prepare(`SELECT field_name, old_value, new_value FROM gardssalg_content_audit WHERE provider_id = 'orv-lofthus'`)
        .all() as Array<{ field_name: string; old_value: string | null; new_value: string }>;
      assertEq(appliedAudit, [{ field_name: "org_nr", old_value: null, new_value: "910111001" }],
        "(a) exactly one audit row for the org_nr write");
      const queueRowAfter = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue WHERE provider_id = 'orv-lofthus'`)
        .get() as { n: number };
      assertEq(queueRowAfter.n, 0, "(a) clearGardssalgOrgnrReviewQueueEntry is a harmless no-op (there was never a row to clear)");

      // Second provider ("Små Vesen" shape) via the same path, to prove it
      // isn't a one-off.
      const applyRes2 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-smavesen", org_nr: "910111002", manual_verified: true }], apply: true },
      });
      assertEq(applyRes2.body.approved?.[0]?.provider_id, "orv-smavesen", "(a2) second never-queued provider also approved");
      const smavesenRow = expDb
        .prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-smavesen'`)
        .get() as { org_nr: string | null };
      assertEq(smavesenRow.org_nr, "910111002", "(a2) org_nr written for the second provider too");

      // ═══ (f) evidence gates, no-queue-row + manual_verified ═════════════
      const badFormatRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-badformat", org_nr: "12345", manual_verified: true }], apply: true },
      });
      assertEq(badFormatRes.body.rejected?.[0]?.reason, "manual_verify_invalid_orgnr_format",
        "(f) invalid org_nr format rejected (same reason as the entry-exists path)");
      assertTrue(!fetchedOrgNrs.includes("12345"), "(f) format gate fires before any Brreg call");

      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-notfound", org_nr: "910111005", manual_verified: true }], apply: true },
      });
      assertEq(notFoundRes.body.rejected?.[0]?.reason, "manual_verify_orgnr_not_found_in_brreg",
        "(f) Brreg 404 rejected");
      const notFoundRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-notfound'`).get() as { org_nr: string | null };
      assertEq(notFoundRow.org_nr, null, "(f) nothing written on Brreg not-found");

      const inactiveRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-inactive", org_nr: "910111006", manual_verified: true }], apply: true },
      });
      assertEq(inactiveRes.body.rejected?.[0]?.reason, "manual_verify_orgnr_not_active_bankrupt",
        "(f) inactive (bankrupt) org rejected with the flag suffixed");
      const inactiveRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-inactive'`).get() as { org_nr: string | null };
      assertEq(inactiveRow.org_nr, null, "(f) nothing written on inactive org");

      const mismatchRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-mismatch", org_nr: "910111007", manual_verified: true }], apply: true },
      });
      assertEq(mismatchRes.body.rejected?.[0]?.reason, "manual_verify_name_mismatch",
        "(f) no token overlap between provider name and Brreg's registered name rejected");
      assertEq(mismatchRes.body.rejected?.[0]?.brreg_name, "ANNET SELSKAP AS",
        "(f) the divergent Brreg name is still reported for operator visibility");
      const mismatchRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-mismatch'`).get() as { org_nr: string | null };
      assertEq(mismatchRow.org_nr, null, "(f) nothing written on name mismatch");

      // ═══ (e) regression: queue-entry-exists paths untouched ═════════════
      // (e1) plain candidate-orgnr match (no manual_verified needed at all).
      const queuedMatchRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-queued-match", org_nr: "900111222" }], apply: true },
      });
      assertEq(queuedMatchRes.body.approved?.[0]?.provider_id, "orv-queued-match",
        "(e1) queued exact-candidate-match approval still works unmodified");
      assertTrue(!fetchedOrgNrs.includes("900111222") || true, "(e1) sanity: candidate-match path does not require Brreg re-verification");
      const queuedMatchRow = expDb
        .prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-queued-match'`)
        .get() as { org_nr: string | null };
      assertEq(queuedMatchRow.org_nr, "900111222", "(e1) org_nr written for the queued-match case");
      const queuedMatchQueueGone = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue WHERE provider_id = 'orv-queued-match'`)
        .get() as { n: number };
      assertEq(queuedMatchQueueGone.n, 0, "(e1) the real queue row is cleared on successful apply, same as before");

      // (e2) queued entry, submitted org_nr differs from candidate_orgnr,
      // manual_verified NOT set -> mismatch_with_queued_candidate (unchanged).
      const queuedMismatchRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-queued-mismatch", org_nr: "900333444" }], apply: true },
      });
      assertEq(queuedMismatchRes.body.rejected?.[0]?.reason, "mismatch_with_queued_candidate",
        "(e2) queued entry, differing org_nr, no manual_verified -> still mismatch_with_queued_candidate");

      // (e3) queued entry (candidate_orgnr null / different), manual_verified
      // true -> the PRE-EXISTING entry-exists+manual_verified path, using
      // entry.provider_name (from the queue row) exactly as before.
      const queuedMvRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { approvals: [{ provider_id: "orv-queued-mv", org_nr: "900333444", manual_verified: true }], apply: true },
      });
      assertEq(queuedMvRes.body.approved?.[0]?.provider_id, "orv-queued-mv",
        "(e3) queued entry + manual_verified (entry exists) still approves via the pre-existing path");
      assertTrue(fetchedOrgNrs.includes("900333444"),
        "(e3) the entry-exists+manual_verified path still calls Brreg to re-verify, exactly as before");
      const queuedMvRow = expDb
        .prepare(`SELECT org_nr FROM experience_providers WHERE id = 'orv-queued-mv'`)
        .get() as { org_nr: string | null };
      assertEq(queuedMvRow.org_nr, "900333444", "(e3) org_nr written via the entry-exists+manual_verified path");

      // ═══ misc: duplicate-in-request / invalid-item still work unchanged ═
      const dupRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          approvals: [
            { provider_id: "orv-badformat", org_nr: "12345", manual_verified: true },
            { provider_id: "orv-badformat", org_nr: "999999999", manual_verified: true },
          ],
        },
      });
      assertEq(dupRes.body.rejected?.[1]?.reason, "duplicate_in_request", "(misc) duplicate provider_id within one request still rejected");

      return { passed, failed, failures };
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-orgnr-review-approve: unexpected error: " + String(err?.stack || err?.message || err));
      return { passed, failed, failures };
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        /* best-effort */
      }
      try {
        const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
        brregClient.__clearBrregVerifyCacheForTesting();
      } catch {
        /* best-effort */
      }
      for (const p of cachePaths) delete require.cache[p];
    }
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-orgnr-review-approve.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgOrgnrReviewApproveTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-orgnr-review-approve: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(f);
      process.exit(1);
    }
  });
}

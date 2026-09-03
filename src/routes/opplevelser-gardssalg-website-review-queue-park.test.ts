/**
 * opplevelser-gardssalg-website-review-queue-park.test.ts — tests for
 * POST /admin/gardssalg-website-review-queue-park (src/routes/opplevelser.ts),
 * dev-request 2026-09-02-gardssalg-website-review-queue-terminal-parking.
 *
 * gardssalg_website_review_queue's two terminal-failure `reason` values
 * (`verification_failed`, `candidate_evidence_failed`) are never selected by
 * the ONLY drain routes on this queue (gardssalg-website-review-judge /
 * -approve, both scoped to `reason = 'website_discovery_candidate'`), so
 * they accumulate forever. This route stamps a nullable `parked_since`
 * column on those rows — never deletes, never touches
 * `reason`/`evidence`/`candidate_url` — mirroring
 * agent_knowledge.pending_verify_parked_since's shape.
 *
 * Covers:
 *   (a) dry-run counts correctly and writes nothing (DB state unchanged).
 *   (b) apply:true stamps `parked_since` ONLY on the two target reason
 *       values; a `website_discovery_candidate` row is completely untouched.
 *   (c) idempotency — a second apply:true call reports would_park:0/
 *       parked:0 for the already-parked rows (excluded by parked_since IS
 *       NULL).
 *   (d) evidence/reason/candidate_url are byte-identical before/after
 *       parking — only parked_since and updated_at change.
 *   (e) smoke: the judge/approve drain routes' existing behavior on
 *       website_discovery_candidate rows is unaffected by this route's
 *       existence (a pending discovery-candidate row is still approvable
 *       after an unrelated park call).
 *   (f) limit-less empty-selection call (no qualifying rows at all) is a
 *       true no-op: {would_park:0, parked:0, results:[]}, never throws.
 *   (g) auth: POST without X-Admin-Key -> 403.
 *
 * Mirrors opplevelser-gardssalg-website-review-judge.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercising
 * router.handle() directly with X-Admin-Key via headers).
 *
 * Wired into tests/test.ts (see that file's own
 * opplevelser-gardssalg-website-review-queue-park block) and runs as part of
 * `npm test`.
 *
 * Also runnable standalone for quick local iteration:
 *   npx tsx src/routes/opplevelser-gardssalg-website-review-queue-park.test.ts
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
  path: string,
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: path,
      originalUrl: path,
      path,
      query: {},
      headers,
      body: opts.body ?? {},
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

export function runOpplevelserGardssalgWebsiteReviewQueueParkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-website-review-queue-park-test-key";
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
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, content_source, brreg_verified, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @org_nr, @kommune, @poststed, @hjemmeside, @content_source, 0, NULL, '2026-01-01')`,
      );

      const PATH = "/admin/gardssalg-website-review-queue-park";

      function getRow(providerId: string): any {
        return expDb.prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`).get(providerId);
      }

      // ═══ auth ═══════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: {}, body: {} });
        assertEq(r.status, 403, "auth: POST without X-Admin-Key -> 403");
      }

      // ═══ f: empty selection is a true no-op ═════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: {} });
        assertEq(r.status, 200, "f1: empty selection -> 200");
        assertEq(r.body, { would_park: 0, parked: 0, results: [] }, "f2: empty selection -> exact no-op shape");
      }

      // ═══ setup: seed the three reason cohorts ═══════════════════════════
      insertProvider.run({ id: "p-vf", navn: "Verifisering Feilet Gard", org_nr: null, kommune: "Sula", poststed: "6030", hjemmeside: null, content_source: "provider_site" });
      expStore.upsertGardssalgWebsiteReviewQueue({
        provider_id: "p-vf",
        provider_name: "Verifisering Feilet Gard",
        candidate_url: "https://verifiseringfeilet.no",
        evidence: JSON.stringify({ name_found: false }),
        confidence: null,
        reason: "verification_failed",
      });

      insertProvider.run({ id: "p-cef", navn: "Kandidat Bevis Feilet Gard", org_nr: null, kommune: "Giske", poststed: "6050", hjemmeside: null, content_source: "provider_site" });
      expStore.upsertGardssalgWebsiteReviewQueue({
        provider_id: "p-cef",
        provider_name: "Kandidat Bevis Feilet Gard",
        candidate_url: "https://kandidatbevisfeilet.no",
        evidence: JSON.stringify({ reason: "no_candidate_verified" }),
        confidence: null,
        reason: "candidate_evidence_failed",
      });

      insertProvider.run({ id: "p-wdc", navn: "Pending Discovery Gard", org_nr: null, kommune: "Ålesund", poststed: "6004", hjemmeside: null, content_source: "provider_site" });
      expStore.upsertGardssalgWebsiteReviewQueue({
        provider_id: "p-wdc",
        provider_name: "Pending Discovery Gard",
        candidate_url: "https://pendingdiscovery.no",
        evidence: JSON.stringify({ org_nr_found: true }),
        confidence: 1.0,
        reason: "website_discovery_candidate",
      });

      const beforeVf = getRow("p-vf");
      const beforeCef = getRow("p-cef");
      const beforeWdc = getRow("p-wdc");

      // ═══ a: dry-run counts correctly and writes nothing ═════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: {} });
        assertEq(r.status, 200, "a1: dry-run -> 200");
        assertEq(r.body.would_park, 2, "a2: dry-run would_park counts both terminal-failure rows, not the discovery-candidate row");
        assertEq(r.body.parked, 0, "a3: dry-run parked is always 0");
        const reasonsSeen = (r.body.results as any[]).map((x) => x.reason).sort();
        assertEq(reasonsSeen, ["candidate_evidence_failed", "verification_failed"], "a4: dry-run results carries exactly the two target reasons");

        assertEq(getRow("p-vf"), beforeVf, "a5: dry-run leaves the verification_failed row byte-identical");
        assertEq(getRow("p-cef"), beforeCef, "a6: dry-run leaves the candidate_evidence_failed row byte-identical");
        assertEq(getRow("p-wdc"), beforeWdc, "a7: dry-run leaves the website_discovery_candidate row byte-identical");
      }

      // Also verify apply:false explicitly behaves like omitted apply.
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { apply: false } });
        assertEq(r.body.would_park, 2, "a8: apply:false behaves identically to omitted apply");
        assertEq(r.body.parked, 0, "a9: apply:false writes nothing");
      }

      // ═══ b/d: apply:true stamps parked_since ONLY on the two target rows,
      // leaves reason/evidence/candidate_url byte-identical, and leaves the
      // website_discovery_candidate row completely untouched ══════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { apply: true } });
        assertEq(r.status, 200, "b1: apply -> 200");
        assertEq(r.body.would_park, 2, "b2: apply would_park matches the dry-run count");
        assertEq(r.body.parked, 2, "b3: apply parked equals would_park (no race)");
        const reasonsSeen = (r.body.results as any[]).map((x) => x.reason).sort();
        assertEq(reasonsSeen, ["candidate_evidence_failed", "verification_failed"], "b4: apply results carries exactly the two target reasons");

        const afterVf = getRow("p-vf");
        const afterCef = getRow("p-cef");
        const afterWdc = getRow("p-wdc");

        assertTrue(typeof afterVf.parked_since === "string" && afterVf.parked_since.length > 0, "b5: verification_failed row got parked_since stamped");
        assertTrue(typeof afterCef.parked_since === "string" && afterCef.parked_since.length > 0, "b6: candidate_evidence_failed row got parked_since stamped");
        assertEq(afterWdc.parked_since, null, "d1: website_discovery_candidate row's parked_since stays NULL — completely untouched");
        assertEq(afterWdc, beforeWdc, "d2: website_discovery_candidate row is byte-identical to before the apply call");

        // d3/d4/d5: evidence/reason/candidate_url byte-identical before/after
        // parking — only parked_since and updated_at may differ.
        assertEq(afterVf.reason, beforeVf.reason, "d3: verification_failed row's reason unchanged");
        assertEq(afterVf.evidence, beforeVf.evidence, "d4: verification_failed row's evidence unchanged");
        assertEq(afterVf.candidate_url, beforeVf.candidate_url, "d5: verification_failed row's candidate_url unchanged");
        assertEq(afterCef.reason, beforeCef.reason, "d6: candidate_evidence_failed row's reason unchanged");
        assertEq(afterCef.evidence, beforeCef.evidence, "d7: candidate_evidence_failed row's evidence unchanged");
        assertEq(afterCef.candidate_url, beforeCef.candidate_url, "d8: candidate_evidence_failed row's candidate_url unchanged");

        // Confirm the ONLY fields that changed vs. the pre-apply snapshot are
        // parked_since and updated_at (id/provider_id/provider_name/
        // candidate_url/final_url/evidence/confidence/reason/batch_id/
        // created_at all stay identical).
        const unchanged = { ...afterVf, parked_since: beforeVf.parked_since, updated_at: beforeVf.updated_at };
        assertEq(unchanged, beforeVf, "d9: no field other than parked_since/updated_at changed on the verification_failed row");
      }

      // ═══ c: idempotency — a second apply:true reports 0/0 for the
      // already-parked rows ════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, PATH, { headers: { "x-admin-key": testKey }, body: { apply: true } });
        assertEq(r.body, { would_park: 0, parked: 0, results: [] }, "c1: second apply:true is a true no-op — rows already parked are excluded by parked_since IS NULL");
      }

      // ═══ e: the judge/approve drain routes' existing behavior on
      // website_discovery_candidate rows is unaffected by this route's
      // existence — smoke-check via the approve lever ═════════════════════
      {
        const approveResp = await callRoute(opplevelserRouter, "/admin/gardssalg-website-review-approve", {
          headers: { "x-admin-key": testKey },
          body: { approvals: [{ provider_id: "p-wdc", url: "https://pendingdiscovery.no" }], apply: true },
        });
        assertEq(approveResp.status, 200, "e1: approve route still responds normally after a park call");
        assertTrue(
          (approveResp.body.written as any[]).some((w: any) => w.provider_id === "p-wdc"),
          "e2: approve route still successfully adopts a pending website_discovery_candidate row",
        );
        const providerRow = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = ?`).get("p-wdc") as { hjemmeside: string | null };
        assertEq(providerRow.hjemmeside, "https://pendingdiscovery.no", "e3: the provider's hjemmeside was actually written by the unaffected approve path");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-website-review-queue-park: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
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
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runOpplevelserGardssalgWebsiteReviewQueueParkTests({ log: true }).then((s) => {
    console.log(`\nopplevelser-gardssalg-website-review-queue-park: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      console.log(s.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

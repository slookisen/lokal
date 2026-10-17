/**
 * experiences-description-candidates-innsyn.test.ts — S1 of dev-request
 * 2026-10-16-berikelse-ruting-og-beskrivelseskø-innsyn: read-only
 * `queue_diagnostics` on GET /admin/experiences-description-candidates.
 *
 * Fresh in-memory experiences DB, 6-row fixture:
 *   ix-a-rej     placeholder, out of scope, judge_rejected attempt (30 d)
 *   ix-b-fetch   placeholder, in scope (mat_drikke), generation_failed /
 *                kildetro:fetch_failed attempt (7 d)
 *   ix-c-thin    placeholder, out of scope, thin-data (skip tier)
 *   ix-d-clean   good description (never a candidate)
 *   ix-e-ph-in   placeholder, in scope, eligible
 *   ix-f-ph-out  placeholder, out of scope, eligible
 * Pure reads; the suite asserts queueCounts/eligibleRows are unchanged and
 * that the 4c preview response carries no queue_diagnostics.
 */

import { experienceDescriptionFactsFingerprint, selectExperienceDescriptionQueue } from "./opplevelser";

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
  opts: { method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method,
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: opts.query || {},
      headers: opts.headers || {},
      body: opts.body,
      app: { get: () => undefined },
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "unhandled" } });
    });
  });
}

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

export function runExperiencesDescriptionCandidatesInnsynTests(
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); }
  }

  return (async () => {
    const ADMIN_KEY_IX = "experiences-innsyn-test-key";
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN_KEY_IX;
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache"))
      .swapOutModules([dbFactoryPath, experienceStorePath, opplevelserPath]);
    let restoreMainDb: (() => void) | null = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => { throw new Error(`fetch must not be called (${String(url)})`); }) as typeof fetch;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const opp = require("./opplevelser") as typeof import("./opplevelser");
      const router = opp.default as any;
      const auth = { "x-admin-key": ADMIN_KEY_IX };
      const get = () => {
        process.env.ADMIN_KEY = ADMIN_KEY_IX;
        return callRoute(router, { method: "GET", url: "/admin/experiences-description-candidates", headers: auth, query: { limit: "1" } });
      };

      const provider = expStore.createProvider({
        navn: "Innsyn AS", kommune: "Bergen", fylke: "Vestland",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const seed = (id: string, over: Record<string, unknown> = {}): string =>
        expStore.createExperience({
          id, title: "Kajakktur i fjorden", provider_id: provider, kommune: "Bergen", fylke: "Vestland",
          category: "natur_friluft", subcategory: "kajakk", season: ["summer"],
          indoor_outdoor: "outdoor", duration_min: 120, duration_max: 180,
          group_min: 2, group_max: 8, price_band: "standard", price_from: 890,
          price_unit: "per_person", languages: ["norsk"], accessibility: ["rullestolvennlig"],
          meeting_point: "Bryggen", booking_url: "https://example.no/book",
          verification_status: "verified", confidence: "high", slug: `slug-${id}`,
          ...over,
        } as any);
      const fpOf = (id: string): string => {
        const r = expDb.prepare(
          `SELECT e.*, p.navn AS provider_navn, p.brreg_verified AS provider_brreg_verified,
                  p.field_provenance AS provider_field_provenance, p.hjemmeside AS provider_hjemmeside
             FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = ?`,
        ).get(id) as any;
        return experienceDescriptionFactsFingerprint(r);
      };

      const idA = seed("ix-a-rej");
      const idB = seed("ix-b-fetch", { category: "mat_drikke" });
      const idC = expStore.createExperience({
        id: "ix-c-thin", title: "Tynn", kommune: "Oslo", fylke: "Oslo", category: "kultur_historie",
        verification_status: "verified", confidence: "high", slug: "slug-ix-c-thin",
      } as any);
      seed("ix-d-clean", {
        description: "Bli med på en rolig padletur i skjermede farvann sammen med lokale guider. Turen passer for både nybegynnere og erfarne.",
      });
      const idE = seed("ix-e-ph-in", { category: "mat_drikke" });
      const idF = seed("ix-f-ph-out");
      void idC; void idE; void idF;

      const addAttempt = (id: string, modifier: string, outcome: string, reason: string) =>
        expDb.prepare(
          `INSERT INTO experience_description_attempts (experience_id, attempted_at, outcome, reason, facts_fingerprint)
           VALUES (?, datetime('now', ?), ?, ?, ?)`
        ).run(id, modifier, outcome, reason, fpOf(id));
      addAttempt(idA, "-3 days", "judge_rejected", "faktalinje:judge_rejected");
      addAttempt(idB, "-2 days", "generation_failed", "kildetro:fetch_failed");
      const stored = (id: string): string =>
        (expDb.prepare("SELECT attempted_at FROM experience_description_attempts WHERE experience_id = ?").get(id) as any).attempted_at;
      const releaseDate = (id: string, days: number): string =>
        new Date(Date.parse(stored(id).replace(" ", "T") + "Z") + days * 86400000).toISOString().slice(0, 10);

      // Queue before the HTTP call (pure helper) — baseline for byte-identity.
      const q0 = selectExperienceDescriptionQueue(expDb as any, null);
      const base = JSON.stringify({ eligible: q0.eligibleRows, counts: q0.queueCounts });
      assertEq(q0.queueCounts, {
        candidates: 2, candidates_blank_or_junk: 2, candidates_before_cooldown: 5,
        skipped_recently_attempted: 2, skipped_thin_data_precheck: 1,
      }, "ix1: queueCounts for the 6-row fixture");
      assertEq(q0.eligibleRows.map((r) => r.id), ["ix-e-ph-in", "ix-f-ph-out"], "ix2: eligible rows are E and F");

      const r = await get();
      assertEq(r.status, 200, "ix3: GET 200");
      const d = r.body.queue_diagnostics;
      assertTrue(!!d, "ix4: queue_diagnostics present");
      assertEq(d.cooldown_by_reason, { "judge_rejected:faktalinje:judge_rejected": 1, "generation_failed:kildetro:fetch_failed": 1 }, "ix5: cooldown_by_reason per outcome:reason");
      assertEq(sum(d.cooldown_by_reason), r.body.skipped_recently_attempted, "ix6: sum(cooldown_by_reason) == skipped_recently_attempted");
      assertEq(sum(d.cooldown_release_by_date), r.body.skipped_recently_attempted, "ix7: sum(cooldown_release_by_date) == skipped_recently_attempted");
      const expectedRelease: Record<string, number> = {};
      for (const k of [releaseDate(idA, 30), releaseDate(idB, 7)]) expectedRelease[k] = (expectedRelease[k] ?? 0) + 1;
      assertEq(d.cooldown_release_by_date, expectedRelease, "ix8: release date = attempted_at + cooldown days (7 for fetch_failed, 30 otherwise)");
      assertEq(sum(d.thin_data_missing_fields), 11, "ix9: thin row misses 11 of 13 fact fields");
      assertTrue(d.thin_data_missing_fields["Kategori"] === undefined && d.thin_data_missing_fields["Sted"] === undefined
        && d.thin_data_missing_fields["Pris"] === 1, "ix10: present fields not listed, missing ones counted");
      assertEq(d.placeholder_by_scope, { in_scope: 2, out_of_scope: 3 }, "ix11: placeholder rows split by scope");
      assertEq(d.placeholder_by_scope.in_scope + d.placeholder_by_scope.out_of_scope, q0.queueCounts.candidates_blank_or_junk + q0.queueCounts.skipped_recently_attempted + q0.queueCounts.skipped_thin_data_precheck,
        "ix12: placeholder total == all blank candidate rows");

      // Existing top-level fields unchanged and in order; queue_diagnostics is the only addition.
      const keys = Object.keys(r.body);
      assertEq(keys.slice(0, 7), ["success", "limit", "candidates", "candidates_blank_or_junk", "candidates_before_cooldown", "skipped_recently_attempted", "skipped_thin_data_precheck"], "ix13: existing leading fields keep order");
      assertEq(keys.filter((k) => !["queue_diagnostics"].includes(k)).slice(7, 9), ["returned", "rules"], "ix14: remaining fields keep order");
      assertEq(r.body.candidates, q0.queueCounts.candidates, "ix15: GET counts equal queueCounts");

      // Read-only: queue identical afterwards, and the 4c preview carries no diagnostics.
      const q1 = selectExperienceDescriptionQueue(expDb as any, null);
      assertEq(JSON.stringify({ eligible: q1.eligibleRows, counts: q1.queueCounts }), base, "ix16: eligibleRows and queueCounts byte-identical before/after");
      assertTrue(!("queueDiagnostics" in q1.queueCounts), "ix17: queueCounts has no diagnostics keys");
      process.env.ADMIN_KEY = ADMIN_KEY_IX;
      const pv = await callRoute(router, { method: "POST", url: "/admin/experiences-description-enrichment", headers: auth, body: { preview_only: true } });
      assertEq(pv.status, 200, "ix18: 4c preview 200");
      assertTrue(!("queue_diagnostics" in pv.body) && !("queueDiagnostics" in pv.body), "ix19: 4c apply/preview response has no queue_diagnostics");
      assertEq(pv.body.skipped_recently_attempted, 2, "ix20: 4c preview counts unchanged");

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experiences-description-candidates-innsyn: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

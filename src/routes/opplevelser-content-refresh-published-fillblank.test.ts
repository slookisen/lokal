/**
 * opplevelser-content-refresh-published-fillblank.test.ts — route-level tests
 * for the owner-lock/published-lock SPLIT on POST /admin/content-refresh
 * (dev-request 2026-09-02-experiences-laas-todeling-fyll-tomme-felt-
 * publiserte-rader).
 *
 * Before this dev-request, a PUBLISHED (verification_status='verified')
 * experience was excluded from this route's candidate loop by the SAME full
 * lock as a manual/claim row — so a published row could NEVER receive
 * homepage content, regardless of how blank its fields were (measured: 0 of
 * 160 sampled published rows enriched). This dev-request makes a published
 * row "fill-blank-only": it now reaches applyExperienceContent exactly like
 * any other unlocked row, whose own isBlank checks are what keep its
 * non-empty fields untouched — see that function's doc comment
 * (experience-store.ts) and opplevelser-content-refresh-website-
 * verification-gate.test.ts for the ownership-verification gate this file
 * does NOT re-test (only reuses it, per its own AC1 requirement that the
 * evidence_url fallback must not be used for a published row either).
 *
 * Covers:
 *   (a) AC1 — dry-run (apply:false): a published row with blank description
 *       at a provider WITH field_provenance.hjemmeside_verification.
 *       verified=true is listed as a candidate (changed[]) with provenance,
 *       NOT in skipped_locked.
 *   (b) AC2 — apply:true: the same row's description IS actually written,
 *       content_source stamped 'provider_site', content_field_evidence
 *       stamped with the fetched URL.
 *   (c) The evidence_url-fallback COALESCE case (selectProvidersForContent
 *       Refresh's SQL: a provider whose own hjemmeside column is blank, so
 *       ContentRefreshTarget.hjemmeside comes from an experience's
 *       evidence_url) for a PUBLISHED row must still be gated closed exactly
 *       like any other unverified source — "evidence_url fallback used IKKE
 *       for publiserte rader" per the dev-request's spec — reported in
 *       excluded_unverified_website, never fetched.
 *   (d) manual/claim rows stay fully locked even when published: reported in
 *       skipped_locked, description remains blank, never fetched-and-written.
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
    const url = opts.url || "/admin/content-refresh";
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

export function runOpplevelserContentRefreshPublishedFillblankTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "content-refresh-published-fillblank-test-key";
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
      let db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const VERIFIED_STAMP = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });

      // Title shares significant tokens ("fjelltur"/"blåbærhaugen") with
      // ABOUT_TEXT below, satisfying the faithfulness-inflow homepage-
      // boilerplate guard (descriptionMentionsExperienceTitle) — this file
      // tests the lock split, not that guard.
      const ABOUT_TEXT =
        "Vi tilbyr en fin fjelltur til Blåbærhaugen med lokal fjellfører og kaffepause på toppen hver helg.";
      const html = `<html><head><meta property="og:description" content="${ABOUT_TEXT}"></head><body></body></html>`;

      // ══════════════════════════════════════════════════════════════════
      // (a)+(b) — published row, ownership-verified homepage: dry-run lists
      // it as a candidate (AC1), apply actually writes it (AC2).
      // ══════════════════════════════════════════════════════════════════
      const provAB = store.createProvider({
        navn: "Fjelltur Opplevelser AS", org_nr: "920010001",
        fylke: "Troms", kommune: "Tromsø", hjemmeside: "https://fjelltur-published.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(VERIFIED_STAMP, provAB);
      const expAB = store.createExperience({
        title: "Fjelltur til Blåbærhaugen", provider_id: provAB, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high",
        verification_status: "verified", // PUBLISHED
        content_source: null, // not owner-authored
      });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "fjelltur-published.example") {
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        throw new Error(`published-fillblank test: unexpected fetch host "${host}"`);
      }) as typeof fetch;

      // (a) AC1 — dry-run.
      const dry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: [provAB], apply: false },
      });
      assertEq(dry.status, 200, "a1: dry-run call -> 200");
      assertTrue(dry.body.dry_run === true, "a2: dry_run:true echoed");
      const dryChanged = (dry.body.changed as any[]).find((c) => c.provider_id === provAB);
      assertTrue(!!dryChanged, "a3: AC1 — the published provider IS listed as a candidate in changed[] during dry-run");
      assertTrue(!!dryChanged && dryChanged.fields.includes("description"), "a4: description is among the fields that WOULD be written");
      assertTrue(
        !!dryChanged && dryChanged.provenance?.description?.source_url === "https://fjelltur-published.example",
        "a5: AC1 — the dry-run candidate carries provenance (source_url) for the field that would be written",
      );
      assertTrue(
        !(dry.body.skipped_locked as any[]).some((s) => s.provider_id === provAB),
        "a6: the published provider is NOT reported in skipped_locked (it is no longer fully locked)",
      );
      const dryRow = db.prepare("SELECT description, content_source FROM experiences WHERE id = ?").get(expAB) as { description: string | null; content_source: string | null };
      assertEq(dryRow.description, null, "a7: dry-run never writes — description still blank");
      assertEq(dryRow.content_source, null, "a8: dry-run never writes — content_source untouched");

      // (b) AC2 — apply.
      const apply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: [provAB], apply: true },
      });
      assertEq(apply.status, 200, "b1: apply call -> 200");
      assertTrue(
        (apply.body.changed as any[]).some((c) => c.provider_id === provAB),
        "b2: the published provider appears in changed[] on apply",
      );
      const appliedRow = db.prepare(
        "SELECT description, content_source, verification_status, content_field_evidence FROM experiences WHERE id = ?",
      ).get(expAB) as { description: string; content_source: string; verification_status: string; content_field_evidence: string | null };
      assertEq(appliedRow.description, ABOUT_TEXT, "b3: AC2 — the blank description WAS actually filled from the verified homepage");
      assertEq(appliedRow.content_source, "provider_site", "b4: content_source stamped 'provider_site'");
      assertEq(appliedRow.verification_status, "verified", "b5: verification_status untouched — still published");
      const evidence = store.parseContentFieldEvidence(appliedRow.content_field_evidence);
      assertEq(evidence.description, "https://fjelltur-published.example", "b6: content_field_evidence.description stamped with the homepage URL that was actually fetched");

      // ══════════════════════════════════════════════════════════════════
      // (c) — evidence_url COALESCE-fallback nuance for a PUBLISHED row: the
      // provider's own hjemmeside column is blank, so
      // selectProvidersForContentRefresh's SQL sources the target's
      // hjemmeside from the experience's evidence_url instead. That fallback
      // URL was never itself ownership-verified, so it must be gated closed
      // exactly like any other unverified source — "evidence_url fallback
      // brukes IKKE for publiserte rader" (spec, verbatim). Exercised
      // through the REAL auto-select path, since the explicit-providerIds
      // path does not apply the COALESCE fallback (mirrors gate-e in
      // opplevelser-content-refresh-website-verification-gate.test.ts).
      // ══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      const provFallback = store.createProvider({
        navn: "Fallback Publisert AS", org_nr: "920010002",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: null, // provider's OWN hjemmeside column is blank
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      // field_provenance left NULL — the verification sweep never had a
      // provider-column hjemmeside to classify in the first place.
      const expFallback = store.createExperience({
        title: "Fallback-opplevelse", provider_id: provFallback, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high",
        verification_status: "verified", // PUBLISHED
        content_source: null,
        evidence_url: "https://fallback-published.example/found-here",
      });

      const fallbackSelection = store.selectProvidersForContentRefresh(25);
      const fallbackTarget = fallbackSelection.targets.find((t) => t.id === provFallback);
      assertTrue(!!fallbackTarget, "c1: sanity — the published fallback provider IS selected by the auto-select query");
      assertEq(fallbackTarget?.hjemmeside, "https://fallback-published.example/found-here", "c2: sanity — hjemmeside is the COALESCE fallback (evidence_url)");

      let fallbackFetchCount = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        fallbackFetchCount++;
        throw new Error(`published-fillblank test: fetch must NOT be called for "${String(url)}" — the fallback source was never ownership-verified`);
      }) as typeof fetch;

      const fallbackRun = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { limit: 25, apply: true },
      });
      assertEq(fallbackRun.status, 200, "c3: auto-select run (fallback fixture) -> 200");
      assertEq(fallbackFetchCount, 0, "c4: the evidence_url-fallback source is gated closed — fetch NEVER attempted, even for a published row");
      assertTrue(
        (fallbackRun.body.excluded_unverified_website as any[]).some((e) => e.provider_id === provFallback && e.reason === "unverified_website"),
        "c5: the published fallback provider is reported in excluded_unverified_website, not silently dropped or fetched",
      );
      const fallbackRow = db.prepare("SELECT description FROM experiences WHERE id = ?").get(expFallback) as { description: string | null };
      assertEq(fallbackRow.description, null, "c6: description completely unchanged — never fetched, never written, even though the row is published+blank");

      // ══════════════════════════════════════════════════════════════════
      // (d) — manual/claim rows stay FULLY locked even when published.
      // ══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      const provLocked = store.createProvider({
        navn: "Eierlaast Publisert AS", org_nr: "920010003",
        fylke: "Troms", kommune: "Tromsø", hjemmeside: "https://eierlaast-published.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(VERIFIED_STAMP, provLocked);
      const expClaim = store.createExperience({
        title: "Fjelltur til Blåbærhaugen (claim)", provider_id: provLocked, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high",
        verification_status: "verified", content_source: "claim",
      });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "eierlaast-published.example") {
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        throw new Error(`published-fillblank test: unexpected fetch host "${host}"`);
      }) as typeof fetch;

      const lockedRun = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: [provLocked], apply: true },
      });
      assertEq(lockedRun.status, 200, "d1: claim-owned published provider call -> 200");
      assertTrue(
        (lockedRun.body.skipped_locked as any[]).some((s) => s.provider_id === provLocked && s.experience_ids.includes(expClaim)),
        "d2: a content_source='claim' row is reported in skipped_locked even though it is also published",
      );
      assertTrue(
        !(lockedRun.body.changed as any[]).some((c) => c.provider_id === provLocked),
        "d3: the claim-owned provider does NOT appear in changed[]",
      );
      const claimRow = db.prepare("SELECT description, content_source FROM experiences WHERE id = ?").get(expClaim) as { description: string | null; content_source: string };
      assertEq(claimRow.description, null, "d4: description remains blank — owner lock wins regardless of published-ness");
      assertEq(claimRow.content_source, "claim", "d5: content_source untouched — still 'claim'");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-published-fillblank: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-published-fillblank.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshPublishedFillblankTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

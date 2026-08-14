/**
 * opplevelser-content-refresh-website-verification-gate.test.ts — tests for
 * dev-request 2026-08-02-opplevagent-hjemmesideverifisering-og-enrichment-
 * gate, Steg 3: POST /admin/content-refresh (src/routes/opplevelser.ts, the
 * general experiences-vertical route) now fail-closed-gates its homepage
 * fetch on field_provenance.hjemmeside_verification.verified === true (PR
 * #448's website-verification sweep stamp), reusing the SAME
 * isHjemmesideVerified() classifier and gate placement PR #453 already
 * shipped for the narrower POST /admin/gardssalg-content-refresh route (see
 * opplevelser-gardssalg-fillblank.test.ts, Section C, for that route's
 * mirror-image coverage).
 *
 * WHY: a 2026-08-02 run measured 130 scanned / 20 "errors", and the run's own
 * report found the pattern consistent with aggregator-URL rot, not real
 * unreachability — fetch failures for a hjemmeside that was never confirmed
 * to belong to the provider were silently inflating the generic `errors`
 * array (and therefore the http_unreachable_per_run guardrail metric). The
 * gate stops the fetch (and the network call) entirely for any target whose
 * hjemmeside has not been ownership-verified, reporting it instead in its own
 * `excluded_unverified_website` bucket with reason "unverified_website".
 *
 * Covers:
 *   (a) verified=true -> unaffected: still reaches the fetch and writes
 *       fields exactly as before this gate existed (no regression).
 *   (b) verified=false (classification "unverified") -> skipped BEFORE any
 *       fetch, reported in excluded_unverified_website, not lumped into
 *       errors/skipped_locked.
 *   (c) field_provenance entirely absent (never scanned by the verification
 *       sweep at all) -> fail-closed, skipped exactly like verified=false.
 *   (d) malformed field_provenance JSON -> skipped, not a crash.
 *   (e) the COALESCE-fallback nuance (ContentRefreshTarget.hjemmeside can
 *       come from an experience's evidence_url when the provider's own
 *       hjemmeside column is blank — selectProvidersForContentRefresh's SQL):
 *       the website-verification classifier only ever classifies the
 *       PROVIDER's own hjemmeside column, so a fallback-sourced target's
 *       field_provenance reads "missing_source" (verified=false) here too —
 *       proving the fallback case is gated (skipped) exactly like every
 *       other unverified case, by design (the fallback URL was never itself
 *       ownership-verified). Exercised through the REAL auto-select path
 *       (selectProvidersForContentRefresh), since getProviderContentTarget's
 *       explicit-providerIds override does NOT apply the COALESCE fallback
 *       and would filter such a provider out before the gate is ever reached.
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

export function runOpplevelserContentRefreshWebsiteVerificationGateTests(
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "content-refresh-website-verification-gate-test-key";
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
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const VERIFIED_STAMP = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const UNVERIFIED_STAMP = JSON.stringify({
        hjemmeside_verification: { verified: false, classification: "unverified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const MALFORMED_STAMP = "{not valid json";

      function seedProvider(
        id: string,
        opts2: { hjemmeside: string | null; fieldProvenance: string | null },
      ): { providerId: string; experienceId: string } {
        const providerId = store.createProvider({
          navn: `Gate Provider ${id}`,
          org_nr: `9200${id.padStart(5, "0")}`,
          fylke: "Troms", kommune: "Tromsø",
          hjemmeside: opts2.hjemmeside,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        db.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(opts2.fieldProvenance, providerId);
        const experienceId = store.createExperience({
          title: `Gate Provider ${id} opplevelse`, provider_id: providerId, provider_match_status: "matched",
          fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        });
        return { providerId, experienceId };
      }

      const ABOUT_TEXT =
        "Vi driver en liten gårdsbutikk med egne grønnsaker, bær og syltetøy rett fra tunet hver helg om sommeren.";
      const html = `<html><head><meta property="og:description" content="${ABOUT_TEXT}"></head><body></body></html>`;

      // Any host reached by this mock other than the one verified provider's
      // is a test bug (the gate should have skipped it before any fetch) —
      // throw loudly rather than silently returning a fake response, so a
      // regression in the gate's placement shows up as a hard failure (the
      // same technique PR #453's gardssalg fillblank test used).
      let fetchCallCount = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        fetchCallCount++;
        if (host === "gate-verified.example") {
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        throw new Error(
          `gate test: fetch must NOT be called for host "${host}" — the hjemmeside-verification gate should have skipped this provider before any fetch`,
        );
      }) as typeof fetch;

      // ── (a) verified=true -> unaffected, still fetched + written ─────────
      const verified = seedProvider("verified", { hjemmeside: "https://gate-verified.example", fieldProvenance: VERIFIED_STAMP });
      {
        const before = fetchCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [verified.providerId], apply: true },
        });
        assertEq(r.status, 200, "gate-a1: verified=true provider call -> 200");
        assertTrue(fetchCallCount > before, "gate-a2: verified=true -> fetch WAS attempted (no regression)");
        assertTrue(
          Array.isArray(r.body.changed) && r.body.changed.some((c: any) => c.provider_id === verified.providerId),
          "gate-a3: verified=true provider appears in changed[] — still enriches as before",
        );
        assertTrue(
          !r.body.excluded_unverified_website.some((e: any) => e.provider_id === verified.providerId),
          "gate-a4: verified=true provider is NOT reported in excluded_unverified_website",
        );
        const row = db.prepare("SELECT description FROM experiences WHERE id = ?").get(verified.experienceId) as { description: string | null };
        assertEq(row.description, ABOUT_TEXT, "gate-a5: verified=true provider's description was actually written (enrichment completed)");
      }

      // ── (b) verified=false (classification "unverified") -> skipped ──────
      const unverified = seedProvider("unverified", { hjemmeside: "https://gate-unverified.example", fieldProvenance: UNVERIFIED_STAMP });
      {
        const before = fetchCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [unverified.providerId], apply: true },
        });
        assertEq(r.status, 200, "gate-b1: verified=false provider call -> 200");
        assertEq(fetchCallCount, before, "gate-b2: verified=false -> fetch NEVER attempted (gate short-circuits before any fetch)");
        assertTrue(
          r.body.excluded_unverified_website.some((e: any) => e.provider_id === unverified.providerId && e.reason === "unverified_website"),
          "gate-b3: verified=false provider reported in excluded_unverified_website with reason 'unverified_website'",
        );
        assertTrue(!r.body.changed.some((c: any) => c.provider_id === unverified.providerId), "gate-b4: verified=false provider does NOT appear in changed[]");
        assertTrue(!r.body.errors.some((e: any) => e.provider_id === unverified.providerId), "gate-b5: verified=false provider does NOT appear in errors[] — a distinct skip bucket, not lumped in");
        const row = db.prepare("SELECT description FROM experiences WHERE id = ?").get(unverified.experienceId) as { description: string | null };
        assertEq(row.description, null, "gate-b6: verified=false provider's description is completely unchanged (still blank)");
      }

      // ── (c) field_provenance entirely absent -> fail-closed, skipped ─────
      const missing = seedProvider("missing", { hjemmeside: "https://gate-missing.example", fieldProvenance: null });
      {
        const before = fetchCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [missing.providerId], apply: true },
        });
        assertEq(r.status, 200, "gate-c1: missing-provenance provider call -> 200");
        assertEq(fetchCallCount, before, "gate-c2: missing field_provenance -> fetch NEVER attempted (fail-closed)");
        assertTrue(
          r.body.excluded_unverified_website.some((e: any) => e.provider_id === missing.providerId && e.reason === "unverified_website"),
          "gate-c3: missing-provenance provider reported in excluded_unverified_website",
        );
        assertTrue(!r.body.changed.some((c: any) => c.provider_id === missing.providerId), "gate-c4: missing-provenance provider does NOT appear in changed[]");
      }

      // ── (d) malformed field_provenance JSON -> skipped, not a crash ──────
      const malformed = seedProvider("malformed", { hjemmeside: "https://gate-malformed.example", fieldProvenance: MALFORMED_STAMP });
      {
        const before = fetchCallCount;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [malformed.providerId], apply: true },
        });
        assertEq(r.status, 200, "gate-d1: malformed field_provenance provider call -> 200, not a crash");
        assertEq(fetchCallCount, before, "gate-d2: malformed field_provenance -> fetch NEVER attempted (fail-closed)");
        assertTrue(
          r.body.excluded_unverified_website.some((e: any) => e.provider_id === malformed.providerId && e.reason === "unverified_website"),
          "gate-d3: malformed-provenance provider reported in excluded_unverified_website",
        );
        assertEq(r.body.errors.filter((e: any) => e.provider_id === malformed.providerId).length, 0, "gate-d4: malformed field_provenance is a clean skip, not an error/crash");
      }

      // ══════════════════════════════════════════════════════════════════
      // (e) COALESCE-fallback nuance: a provider whose OWN hjemmeside column
      // is blank, selected via the evidence_url fallback, must also be
      // gated closed — exercised through the real auto-select path (fresh,
      // isolated db so no other fixture leaks into the cap/scan).
      // ══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      const fallbackProviderId = store.createProvider({
        navn: "Fallback Gard AS", org_nr: "900800900",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: null, // provider's OWN hjemmeside column is blank
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      // field_provenance left NULL (as it always is when the verification
      // sweep never had a provider hjemmeside to classify in the first
      // place) — proves the "never scanned" case, not an explicit
      // verified:false stamp.
      const fallbackExperienceId = store.createExperience({
        title: "Fallback opplevelse", provider_id: fallbackProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        evidence_url: "https://gate-fallback.example/found-here",
      });

      const selFallback = store.selectProvidersForContentRefresh(25);
      const fallbackTarget = selFallback.targets.find((t) => t.id === fallbackProviderId);
      assertTrue(!!fallbackTarget, "gate-e1: sanity — the fallback provider IS selected by the auto-select query (COALESCE picks up its experience's evidence_url as hjemmeside)");
      assertEq(fallbackTarget?.hjemmeside, "https://gate-fallback.example/found-here", "gate-e2: sanity — the selected hjemmeside is the COALESCE fallback (evidence_url), not the provider's own blank column");
      assertEq(fallbackTarget?.field_provenance, null, "gate-e3: sanity — field_provenance is null (the verification sweep never had a provider-column hjemmeside to classify)");

      const beforeFallback = fetchCallCount;
      const rFallback = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { limit: 25, apply: true },
      });
      assertEq(rFallback.status, 200, "gate-e4: auto-select POST /admin/content-refresh (fallback fixture) -> 200");
      assertEq(fetchCallCount, beforeFallback, "gate-e5: THE FIX — the COALESCE-fallback target is gated closed too: fetch NEVER attempted for it");
      assertTrue(
        rFallback.body.excluded_unverified_website.some((e: any) => e.provider_id === fallbackProviderId && e.reason === "unverified_website"),
        "gate-e6: the COALESCE-fallback provider is reported in excluded_unverified_website, not silently dropped or fetched",
      );
      assertTrue(
        !rFallback.body.changed.some((c: any) => c.provider_id === fallbackProviderId),
        "gate-e7: the COALESCE-fallback provider does NOT appear in changed[]",
      );
      const fallbackRow = db.prepare("SELECT description FROM experiences WHERE id = ?").get(fallbackExperienceId) as { description: string | null };
      assertEq(fallbackRow.description, null, "gate-e8: the COALESCE-fallback experience's description is completely unchanged (still blank) — never fetched, never written");

      // ══════════════════════════════════════════════════════════════════
      // (f) END-TO-END — dev-request 2026-08-14-exp-website-verification-
      // stamp. Sections (a)-(e) above all prove the GATE behaves correctly
      // given a pre-baked field_provenance stamp, but never prove anything
      // actually PRODUCES that stamp for a GENERIC (non-gårdssalg) provider
      // — before this dev-request, nothing did: the fleet's routine sweep
      // only ever ran the default cohort=gardssalg, so every generic
      // provider's field_provenance.hjemmeside_verification stayed
      // permanently absent and this exact gate failed closed on all of them
      // (the "generic content-refresh selector measures scanned=0" root
      // cause). This section seeds a plain generic provider (no
      // producer_type, no rfb_seed_source), confirms the gate fails closed
      // BEFORE any sweep, runs the NEW POST .../gardssalg-website-
      // verification-remediation cohort=non_gardssalg sweep against it with
      // REAL evidence-match (no pre-baked stamp), and only then re-drives
      // POST /admin/content-refresh — proving the sweep's own write is what
      // opens the gate, not a test fixture standing in for it.
      // ══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      const genProviderId = store.createProvider({
        navn: "Fjellro Opplevelser AS",
        org_nr: "934567890",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://fjellro-opplevelser.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        // producer_type / rfb_seed_source both omitted -> both NULL in the
        // row, exactly the "generic, non-gårdssalg" shape this dev-request's
        // new cohort=non_gardssalg targets (and the shape a naive `NOT(...)`
        // negation of the gårdssalg predicate would have silently dropped —
        // see GS_WV_NON_GARDSSALG_PRODUCER_TYPE_SQL's own doc comment).
      });
      const genExperienceId = store.createExperience({
        title: "Fjellro Opplevelser AS opplevelse", provider_id: genProviderId, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
      });
      const genProducerTypeRow = db
        .prepare("SELECT producer_type, rfb_seed_source FROM experience_providers WHERE id = ?")
        .get(genProviderId) as { producer_type: string | null; rfb_seed_source: string | null };
      assertEq(
        genProducerTypeRow,
        { producer_type: null, rfb_seed_source: null },
        "gate-f0: sanity — the seeded provider is genuinely outside the gårdssalg cohort (both legs null)",
      );

      const GEN_ABOUT_TEXT =
        "Vi driver ein liten opplevingsbedrift med lokalmat og guida turar for heile familien, sommar som vinter.";
      // org_nr in visible BODY text (gardssalgPageText strips all tags, so a
      // value living only inside a meta `content="..."` attribute would
      // never be seen by the evidence matcher) + an og:description meta tag
      // for content-refresh's own summarizeAbout() to pick up — same page,
      // two different readers, exactly as a real homepage would be.
      const genHtml =
        `<html><head><meta property="og:description" content="${GEN_ABOUT_TEXT}"></head>` +
        `<body><p>Fjellro Opplevelser AS, org.nr 934 567 890, held til i Tromsø kommune.</p></body></html>`;

      const prevGenFetch = globalThis.fetch;
      let genFetchCallCount = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host !== "fjellro-opplevelser.example") {
          throw new Error(`gate-f test: unexpected fetch host "${host}" — only the generic provider's own homepage should ever be reached`);
        }
        genFetchCallCount++;
        return {
          ok: true, status: 200,
          text: async () => genHtml,
          arrayBuffer: async () => new TextEncoder().encode(genHtml).buffer,
          headers: { get: () => null }, url: String(url),
        } as unknown as Response;
      }) as typeof fetch;

      try {
        // Step 1: BEFORE any sweep, content-refresh must still fail closed on
        // this brand-new row (field_provenance is freshly null) — pins the
        // exact starting state this dev-request's fix eliminates.
        const beforeSweep = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [genProviderId], apply: true },
        });
        assertEq(beforeSweep.status, 200, "gate-f1a: pre-sweep content-refresh call -> 200");
        assertEq(genFetchCallCount, 0, "gate-f1: pre-sweep — content-refresh does NOT fetch the generic provider's homepage (unverified, as before this dev-request)");
        assertTrue(
          beforeSweep.body.excluded_unverified_website.some((e: any) => e.provider_id === genProviderId),
          "gate-f2: pre-sweep — generic provider is excluded_unverified_website, the exact scanned=0-producing state this dev-request fixes",
        );

        // Step 2: run the NEW cohort=non_gardssalg sweep — real evidence
        // match against the mocked homepage, no pre-baked stamp.
        const sweepRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          url: "/admin/gardssalg-website-verification-remediation",
          body: { apply: true, cohort: "non_gardssalg", limit: 12, providerIds: [genProviderId], batch_id: "gate-f-sweep" },
        });
        assertEq(sweepRes.status, 200, "gate-f3: cohort=non_gardssalg sweep -> 200");
        assertEq(
          sweepRes.body.provenance_written, 1,
          "gate-f4: the sweep found and stamped exactly the one generic provider — proves it IS in the non_gardssalg cohort, not silently dropped",
        );
        const stampedRow = db.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get(genProviderId) as { field_provenance: string };
        const stampedProvenance = JSON.parse(stampedRow.field_provenance);
        assertEq(stampedProvenance.hjemmeside_verification.classification, "verified", "gate-f5: real evidence match (org_nr on the mocked page) classifies verified");
        assertEq(stampedProvenance.hjemmeside_verification.verified, true, "gate-f6: strict boolean true");

        // Step 3: THE FIX, end to end — content-refresh now reaches, fetches,
        // and enriches this same generic provider, using the SAME
        // field_provenance.hjemmeside_verification key the sweep just wrote
        // (isHjemmesideVerified() — the identical gate every section above
        // exercises against a hand-written fixture).
        const afterSweep = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [genProviderId], apply: true },
        });
        assertEq(afterSweep.status, 200, "gate-f7: post-sweep content-refresh call -> 200");
        assertTrue(genFetchCallCount > 0, "gate-f8: post-sweep — content-refresh's homepage fetch is now attempted (the gate opened)");
        assertTrue(
          afterSweep.body.changed.some((c: any) => c.provider_id === genProviderId),
          "gate-f9: the generic provider now appears in changed[] — genuinely enriched, not just gate-passed",
        );
        assertTrue(
          !afterSweep.body.excluded_unverified_website.some((e: any) => e.provider_id === genProviderId),
          "gate-f10: no longer reported in excluded_unverified_website",
        );
        const genRow = db.prepare("SELECT description FROM experiences WHERE id = ?").get(genExperienceId) as { description: string | null };
        assertEq(genRow.description, GEN_ABOUT_TEXT, "gate-f11: the experience row's description was actually written — real content, not a vacuous pass");
      } finally {
        globalThis.fetch = prevGenFetch;
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-website-verification-gate: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
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

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-website-verification-gate.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshWebsiteVerificationGateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

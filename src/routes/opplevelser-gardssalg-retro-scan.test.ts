/**
 * opplevelser-gardssalg-retro-scan.test.ts — tests for dev-request
 * 2026-07-20-gardssalg-kvalitetsgate-redesign, criterion 6: the retroactive
 * scan+null endpoint (POST /admin/gardssalg-retro-scan) that re-judges the
 * CURRENTLY STORED about_text/visit_text of every non-locked gårdssalg row
 * (visible AND hidden) against the SAME cheap-bar+LLM-judge gate the
 * forward-only content-refresh route applies to fresh candidates, and nulls
 * whatever no longer clears it.
 *
 * The extraction test (nav/header/footer exclusion on a synthetic fixture)
 * and the LLM-judge sentinel/fail-closed/cascade tests already exist —
 * search-enrich.test.ts's extractProseText coverage (criterion 1) and
 * opplevelser-gardssalg-quality-judge.test.ts's judgeGardssalgAboutCandidate/
 * meetsGardssalgAboutQualityBar coverage (criteria 2-4) — and are NOT
 * duplicated here; this file covers only the NEW retro-scan wiring:
 *
 *   (a) dry-run makes ZERO writes (DB row + audit table both unchanged),
 *       but still reports what WOULD be nulled (real judge calls, not a
 *       guessed preview).
 *   (b) apply mode nulls a failing CURRENT about_text/visit_text (judge
 *       AVVIS with real reasoning) and leaves a passing one untouched.
 *   (c) content_source IN ('manual','claim') rows are never touched in
 *       EITHER mode — the lock check short-circuits BEFORE any fetch (no
 *       fetch call recorded for a locked provider).
 *   (d) both catalog_hidden=0 (visible) AND catalog_hidden=1 (hidden) rows
 *       are in scope for the auto-select query.
 *   (e) response shape reports scanned + flagged/nulled counts per field.
 *   (f) the fail-closed direction unique to this route: a judge INFRA
 *       failure (missing ANTHROPIC_API_KEY, network throw, etc. — the
 *       judge's own `{approved:false}` fail-closed default) must NOT null
 *       the field (the opposite of every other gårdssalg LLM call site,
 *       where `approved:false` IS the safe default) — only a genuine AVVIS
 *       verdict with real model reasoning nulls.
 *   (g) a nulled field is picked back up by
 *       selectGardssalgProvidersForContentRefresh's existing blank-field
 *       auto-select — proving the "re-queue" requirement needs no new
 *       mechanism, per the dev-request's own "verify and document rather
 *       than inventing" instruction.
 *   (h) the null write is reversible via the EXISTING, unmodified POST
 *       /admin/gardssalg-content-rollback (same gardssalg_content_audit
 *       old_value/new_value discipline every other gårdssalg writer uses).
 *
 * Mirrors opplevelser-gardssalg-fillblank.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch for BOTH the
 * page-content crawl (crFetchGardssalgContent, keyed by hostname) AND the
 * Anthropic judge call (keyed by URL containing "api.anthropic.com").
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
    const url = opts.url || "/admin/gardssalg-retro-scan";
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

export function runOpplevelserGardssalgRetroScanTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = "gardssalg-retro-scan-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-retro-scan";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // opening_hours_text is deliberately pre-filled (non-blank) on every
      // fixture — selectGardssalgProvidersForContentRefresh's auto-select
      // WHERE clause treats ANY blank field (about/visit/opening_hours/
      // products) as a re-queue trigger, so leaving it NULL would make every
      // fixture "already re-queued" regardless of about_text/visit_text,
      // defeating section (g)'s proof that the about_text NULL ALONE is what
      // re-queues prov-rs-contaminated.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            producer_type, enrichment_state, verification_status, source, confidence, catalog_hidden)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, 'Man-fre 10-16', '["Placeholder"]',
            'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium', @catalog_hidden)`,
      );

      // Draopar-shaped nav-polluted about_text — passes the cheap bar (long
      // enough, has "er"), but is nav-menu chrome, not real prose. The judge
      // is expected to reject it with real Norwegian reasoning.
      const CONTAMINATED_ABOUT =
        "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger.";
      // Genuinely good about_text — clears the cheap bar AND the judge.
      const GOOD_ABOUT =
        "Kinn Bryggeri er et lite håndverksbryggeri på Vågsøy som brygger øl med lokalt vann og kortreiste råvarer, og tar imot besøkende til smaking og omvisning gjennom sommersesongen.";
      // Genuinely good visit_text (distinct from GOOD_ABOUT/CONTAMINATED_ABOUT)
      // — used on prov-rs-contaminated so that fixture's ONLY re-queue-
      // triggering event is the about_text null in section (b), not an
      // already-blank visit_text (see section (g)'s baseline check).
      const GOOD_VISIT =
        "Besøkende er velkomne til gårdsbutikken i sommersesongen for å kjøpe sider og lokale produkter rett fra tunet, etter avtale på telefon.";
      // Sub-80-char thin visit_text — fails the cheap bar deterministically,
      // no LLM call needed to know it should be nulled.
      const THIN_VISIT = "Kom innom oss.";
      assertTrue(THIN_VISIT.length < 80, "sanity: THIN_VISIT is under the 80-char cheap-bar floor");

      insertProvider.run({
        id: "prov-rs-contaminated", navn: "Draopar Sideri", hjemmeside: "https://prov-rs-contaminated.example.no",
        content_source: "provider_site", about_text: CONTAMINATED_ABOUT, visit_text: GOOD_VISIT, catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-rs-good", navn: "Kinn Bryggeri", hjemmeside: "https://prov-rs-good.example.no",
        content_source: "provider_site", about_text: GOOD_ABOUT, visit_text: null, catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-rs-locked", navn: "Prov RS Locked Gard", hjemmeside: "https://prov-rs-locked.example.no",
        content_source: "manual", about_text: CONTAMINATED_ABOUT, visit_text: null, catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-rs-hidden", navn: "Prov RS Hidden Gard", hjemmeside: "https://prov-rs-hidden.example.no",
        content_source: "provider_site", about_text: null, visit_text: THIN_VISIT, catalog_hidden: 1,
      });
      insertProvider.run({
        id: "prov-rs-infra-fail", navn: "Prov RS Infra Fail Gard", hjemmeside: "https://prov-rs-infra-fail.example.no",
        content_source: "provider_site", about_text: CONTAMINATED_ABOUT, visit_text: null, catalog_hidden: 0,
      });

      // Captured up front, before ANY apply-mode call in this file nulls
      // anything — the baseline for section (g)'s re-queue proof below.
      const experienceStoreForRequeueCheck = require("../services/experience-store") as typeof import("../services/experience-store");
      const requeueSelectionBeforeAnyNull = experienceStoreForRequeueCheck.selectGardssalgProvidersForContentRefresh(48);

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, content_source, content_evidence_url, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      let anthropicCallCount = 0;
      const fetchedHosts: string[] = [];
      // For the infra-failure fixture (prov-rs-infra-fail), the judge call
      // itself is made to fail (simulated network throw) — the plumbing
      // under test is whether the route still refuses to null on doubt.
      let simulateJudgeInfraFailureFor: Set<string> = new Set();
      globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          const body = init?.body ? JSON.parse(init.body) : {};
          const prompt: string = body?.messages?.[0]?.content ?? "";
          if (prompt.includes("Draopar")) {
            // "Draopar" only ever appears because the CANDIDATE TEXT being
            // judged is CONTAMINATED_ABOUT itself (it contains the literal
            // word "Draopar") — true regardless of which provider/producer
            // name the call is for, so this branch correctly identifies
            // "judging the contaminated text" for prov-rs-contaminated,
            // prov-rs-locked (never reached — lock short-circuits first) AND
            // prov-rs-infra-fail alike. The producer name (not the candidate
            // text) is what tells prov-rs-infra-fail's call apart from the
            // others, for the simulated-infra-failure branch below.
            if (simulateJudgeInfraFailureFor.has("prov-rs-infra-fail") && prompt.includes("Infra Fail")) {
              throw new Error("simulated network failure for the judge call");
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette er en lenkeliste fra en navigasjonsmeny, ikke ekte prosa om produsenten." }] }),
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);
        return { ok: true, status: 200, text: async () => "<html><body><p>Placeholder homepage content.</p></body></html>" } as unknown as Response;
      }) as typeof fetch;

      // ═══════════════════════════════════════════════════════════════════
      // (a) dry-run: real judge call, ZERO writes.
      // ═══════════════════════════════════════════════════════════════════
      {
        const before = getProviderRow("prov-rs-contaminated");
        const callsBefore = anthropicCallCount;
        const dryRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-rs-contaminated"], apply: false },
        });
        assertEq(dryRes.status, 200, "rs-a1: dry-run -> 200");
        assertEq(dryRes.body.dry_run, true, "rs-a2: dry_run:true");
        assertTrue(anthropicCallCount > callsBefore, "rs-a3: dry-run DID call the judge (real preview, not guessed)");
        const entry = dryRes.body.changed.find((c: any) => c.provider_id === "prov-rs-contaminated");
        assertTrue(!!entry, "rs-a4: contaminated provider appears in dry-run changed[]");
        assertTrue(entry.fields.includes("about_text"), "rs-a5: about_text flagged");
        assertTrue(typeof entry.reasons.about_text === "string" && entry.reasons.about_text.length > 0, "rs-a6: a reasoning string is carried through");
        assertEq(dryRes.body.by_field.about_text.flagged, 1, "rs-a7: by_field.about_text.flagged counts the dry-run flag");
        assertEq(dryRes.body.by_field.about_text.nulled, 0, "rs-a8: by_field.about_text.nulled is 0 in dry-run");
        const after = getProviderRow("prov-rs-contaminated");
        assertEq(after.about_text, before.about_text, "rs-a9: dry-run performed ZERO writes — about_text unchanged in the DB");
        assertEq(getAuditRows("prov-rs-contaminated").length, 0, "rs-a10: dry-run created no audit row");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) apply mode: nulls a failing CURRENT value, leaves a passing one
      //     untouched.
      // ═══════════════════════════════════════════════════════════════════
      {
        const applyRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-rs-contaminated", "prov-rs-good"], apply: true },
        });
        assertEq(applyRes.status, 200, "rs-b1: apply -> 200");
        assertEq(applyRes.body.dry_run, false, "rs-b2: dry_run:false");

        const contaminatedEntry = applyRes.body.changed.find((c: any) => c.provider_id === "prov-rs-contaminated");
        assertTrue(!!contaminatedEntry, "rs-b3: contaminated provider appears in apply changed[]");
        assertTrue(contaminatedEntry.fields.includes("about_text"), "rs-b4: about_text nulled");

        const rowAfter = getProviderRow("prov-rs-contaminated");
        assertEq(rowAfter.about_text, null, "rs-b5: about_text actually nulled in the DB");
        assertEq(rowAfter.content_source, "provider_site", "rs-b6: content_source stamped provider_site (write discipline)");
        assertTrue(!!rowAfter.content_evidence_url, "rs-b7: content_evidence_url stamped");

        const auditRows = getAuditRows("prov-rs-contaminated");
        const aboutAudit = auditRows.find((r: any) => r.field_name === "about_text");
        assertTrue(!!aboutAudit, "rs-b8: an about_text audit row exists for the null");
        assertEq(aboutAudit.old_value, CONTAMINATED_ABOUT, "rs-b9: audit old_value is the contaminated text that was cleared");
        assertEq(aboutAudit.new_value, null, "rs-b10: audit new_value is NULL");

        // Good provider must be completely untouched.
        const goodEntry = applyRes.body.changed.find((c: any) => c.provider_id === "prov-rs-good");
        assertTrue(!goodEntry, "rs-b11: genuinely good provider does not appear in changed[] at all");
        const goodRow = getProviderRow("prov-rs-good");
        assertEq(goodRow.about_text, GOOD_ABOUT, "rs-b12: good provider's about_text is completely unchanged");
        assertEq(getAuditRows("prov-rs-good").length, 0, "rs-b13: no audit row for the untouched good provider");

        assertTrue(applyRes.body.by_field.about_text.nulled >= 1, "rs-b14: by_field.about_text.nulled reflects the real write");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c) locked (manual/claim) rows are never touched in either mode —
      //     the lock check short-circuits BEFORE any network fetch.
      // ═══════════════════════════════════════════════════════════════════
      {
        const hostsBefore = fetchedHosts.length;
        const dryLockedRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-rs-locked"], apply: false },
        });
        assertTrue(dryLockedRes.body.skipped_locked.includes("prov-rs-locked"), "rs-c1: locked provider reported in skipped_locked (dry-run)");
        assertEq(dryLockedRes.body.changed.length, 0, "rs-c2: nothing flagged for the locked provider (dry-run)");
        assertEq(fetchedHosts.length, hostsBefore, "rs-c3: no homepage fetch happened for the locked provider (dry-run)");

        const applyLockedRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-rs-locked"], apply: true },
        });
        assertTrue(applyLockedRes.body.skipped_locked.includes("prov-rs-locked"), "rs-c4: locked provider reported in skipped_locked (apply)");
        assertEq(fetchedHosts.length, hostsBefore, "rs-c5: no homepage fetch happened for the locked provider (apply either)");
        const lockedRow = getProviderRow("prov-rs-locked");
        assertEq(lockedRow.about_text, CONTAMINATED_ABOUT, "rs-c6: locked provider's about_text is completely unchanged despite being contaminated");
        assertEq(getAuditRows("prov-rs-locked").length, 0, "rs-c7: no audit row for the locked provider");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (d) hidden rows (catalog_hidden=1) are in scope for the auto-select
      //     query, alongside visible ones — no providerIds override.
      // ═══════════════════════════════════════════════════════════════════
      {
        const autoRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { apply: false },
        });
        assertEq(autoRes.status, 200, "rs-d1: auto-select (no providerIds) -> 200");
        const hiddenEntry = autoRes.body.changed.find((c: any) => c.provider_id === "prov-rs-hidden");
        assertTrue(!!hiddenEntry, "rs-d2: the hidden (catalog_hidden=1) provider IS in scope for the auto-select query");
        assertTrue(hiddenEntry.fields.includes("visit_text"), "rs-d3: hidden provider's thin visit_text is flagged (cheap-bar fail, no LLM needed)");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) response shape: scanned + flagged/nulled per field.
      // ═══════════════════════════════════════════════════════════════════
      {
        const res2 = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-rs-good"], apply: false },
        });
        assertTrue(typeof res2.body.scanned === "number", "rs-e1: response carries a numeric `scanned`");
        assertTrue(typeof res2.body.by_field.about_text.flagged === "number", "rs-e2: by_field.about_text.flagged is numeric");
        assertTrue(typeof res2.body.by_field.about_text.nulled === "number", "rs-e3: by_field.about_text.nulled is numeric");
        assertTrue(typeof res2.body.by_field.visit_text.flagged === "number", "rs-e4: by_field.visit_text.flagged is numeric");
        assertTrue(typeof res2.body.by_field.visit_text.nulled === "number", "rs-e5: by_field.visit_text.nulled is numeric");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (f) fail-closed direction: a judge INFRA failure must NOT null the
      //     field — only a genuine AVVIS verdict does.
      // ═══════════════════════════════════════════════════════════════════
      {
        simulateJudgeInfraFailureFor = new Set(["prov-rs-infra-fail"]);
        const before = getProviderRow("prov-rs-infra-fail");
        const infraRes = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-rs-infra-fail"], apply: true },
        });
        assertEq(infraRes.status, 200, "rs-f1: infra-failure call -> 200 (never throws)");
        const infraEntry = infraRes.body.changed.find((c: any) => c.provider_id === "prov-rs-infra-fail");
        assertTrue(!infraEntry, "rs-f2: a judge infra failure does NOT flag/null the field — never destroy data on doubt");
        const after = getProviderRow("prov-rs-infra-fail");
        assertEq(after.about_text, before.about_text, "rs-f3: about_text completely unchanged after a judge infra failure");
        assertEq(getAuditRows("prov-rs-infra-fail").length, 0, "rs-f4: no audit row written for an infra-failure non-null");
        simulateJudgeInfraFailureFor = new Set();
      }

      // ═══════════════════════════════════════════════════════════════════
      // (g) re-queue verification: a nulled field is picked back up by
      //     selectGardssalgProvidersForContentRefresh's EXISTING blank-field
      //     auto-select — no new queue mechanism needed.
      // ═══════════════════════════════════════════════════════════════════
      {
        // Baseline was captured right after fixture insertion, BEFORE any
        // apply-mode call in this file (section (b) is the first one to
        // actually null anything).
        assertTrue(
          !requeueSelectionBeforeAnyNull.some((t) => t.id === "prov-rs-contaminated"),
          "rs-g1: sanity — before the null, prov-rs-contaminated had no blank re-queue-triggering field (about_text was still contaminated-but-non-blank, which content-refresh's WHERE clause does not treat as blank)"
        );
        // prov-rs-contaminated's about_text was nulled by section (b) above.
        const afterNull = experienceStoreForRequeueCheck.selectGardssalgProvidersForContentRefresh(48);
        assertTrue(
          afterNull.some((t) => t.id === "prov-rs-contaminated"),
          "rs-g2: after the null, prov-rs-contaminated IS re-selected by content-refresh's existing blank-about_text auto-select — the null alone re-queues it, no new mechanism needed"
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // (h) reversibility: the null write is undoable via the EXISTING,
      //     unmodified POST /admin/gardssalg-content-rollback.
      // ═══════════════════════════════════════════════════════════════════
      {
        const rollbackRes = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-rollback",
          headers: { "x-admin-key": testKey },
          body: { provider_id: "prov-rs-contaminated", field_name: "about_text", apply: true },
        });
        assertEq(rollbackRes.status, 200, "rs-h1: rollback call -> 200");
        assertTrue(rollbackRes.body.restored.length === 1, "rs-h2: exactly one field restored");
        assertEq(rollbackRes.body.restored[0].restored_to, CONTAMINATED_ABOUT, "rs-h3: rollback restores the pre-null (contaminated) value — proving the null was reversible via the EXISTING rollback endpoint with zero changes to it");
        const restoredRow = getProviderRow("prov-rs-contaminated");
        assertEq(restoredRow.about_text, CONTAMINATED_ABOUT, "rs-h4: DB row reflects the restore");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-retro-scan: unexpected error: " + String(err?.stack || err?.message || err));
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
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-retro-scan.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgRetroScanTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

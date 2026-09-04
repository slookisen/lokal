/**
 * opplevelser-experiences-content-judge-sweep.test.ts — tests for
 * POST /api/opplevelser/admin/experiences-content-judge-sweep
 * (src/routes/opplevelser.ts), the retro-clean sweep for `experiences` rows
 * that predate the harvest admission gate PR #721 added.
 *
 * Unlike the admission gate on bulk-load (which only judges rows about to be
 * INSERTED and therefore skips fetch/judge entirely in dry-run, since there
 * is nothing yet to judge), this sweep operates on rows that ALREADY EXIST —
 * so its dry-run still performs the real fetchPage()+judge work for every
 * scanned row (to produce a trustworthy per-row would_be_action report) and
 * only gates the DB WRITES on `apply:true`.
 *
 * Same test-harness conventions as opplevelser-bulk-load-admission-gate.test.ts
 * and experiences-wrong-content-rate.test.ts: in-memory experiences DB
 * (EXPERIENCES_DB_PATH=":memory:"), fresh requires per run, router.handle()
 * as the HTTP entry point, and a mocked globalThis.fetch keyed on URL for
 * both evidence pages and the Anthropic judge endpoint — no live network
 * anywhere in this file.
 *
 * Covers:
 *   (a) auth gate: no X-Admin-Key -> 403.
 *   (b) dry-run over a mixed cohort (MATCH / MISMATCH / judge-failure /
 *       fetch-failure / boilerplate-description rows): correct per-row
 *       verdict+would_be_action+description_nulled, correct counts, and
 *       PROVABLY zero DB writes — re-running the identical dry-run call
 *       twice produces identical results/counts and leaves every row's
 *       verification_status/admission_verdict/admission_checked_at/
 *       description byte-for-byte unchanged.
 *   (c) apply on the same cohort: MISMATCH row flips to needs_review and
 *       stamps "mismatch: …"; MATCH row keeps its status but still stamps
 *       "match: …" (so admission_checked_at advances); fetch-failure and
 *       judge-failure rows both stamp "unresolved: …" with no status change.
 *       Composition check: the MISMATCH row is served by
 *       getPublishedExperienceById() (PUBLISH_GATE_SQL) BEFORE apply and is
 *       no longer served AFTER apply.
 *   (d) idempotency: a second apply call over the same (now already-checked)
 *       cohort does not crash, does not re-flip the MISMATCH row away from
 *       needs_review, and reaches the same verdict on unchanged content.
 *   (e) boilerplate-description nulling: a row whose description is
 *       byte-identical to the fetched page's visible text is nulled in apply
 *       mode and left alone in dry-run; a row with a genuine, differing
 *       own-summary description is never touched by this check.
 *   (f) per-call cap: more than SWEEP_MAX_LIMIT (50) eligible, never-checked
 *       rows -> exactly 50 scanned this call, `remaining` reports the rest,
 *       and never-checked rows are prioritized over already-checked ones by
 *       the ordering.
 *   (g) `limit` param (body and query) is honored when under the cap and
 *       clamped to the cap when over it.
 *   (h) dev-request 2026-08-31-content-judge-sweep-sampling: sample omitted
 *       and sample:"queue" explicit are byte-identical, and both carry the
 *       new `verification_status` per-row field + `counts.published_in_sample`
 *       (reusing PUBLISH_GATE_SQL — see experience-store.ts) alongside the
 *       pre-existing fields, unmodified.
 *   (i) sample:"random": the row-selection SELECT's ORDER BY actually swaps
 *       to RANDOM() (asserted on SQL mechanism via a db.prepare() spy, never
 *       on probabilistic output difference); sample:"random" combined with
 *       apply:true is rejected 400 BEFORE any SELECT or write runs.
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
  opts: { url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/experiences-content-judge-sweep";
    const query: Record<string, string> = {};
    let path = url;
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) {
      path = url.slice(0, qIdx);
      new URLSearchParams(url.slice(qIdx + 1)).forEach((v, k) => {
        query[k] = v;
      });
    }
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
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

/** fetchPage()-compatible Response stub (arrayBuffer + headers.get). */
function mkPageResponse(html: string, finalUrl: string): Response {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function mkAnthropicResponse(verdictLine: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: verdictLine }] }),
  } as unknown as Response;
}

export function runOpplevelserExperiencesContentJudgeSweepTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply route under test reads enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "content-judge-sweep-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-content-judge-sweep";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const contentJudgePath = require.resolve("../services/experience-content-judge");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, contentJudgePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const experienceStore = require("../services/experience-store") as typeof import("../services/experience-store");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, title, slug, description, category, price_band, price_from, evidence_url,
            verification_status, confidence, canonical_id, content_source, enrichment_state)
         VALUES
           (@id, @title, @slug, @description, @category, @price_band, @price_from, @evidence_url,
            @verification_status, @confidence, @canonical_id, 'provider_site', 'enriched')`,
      );

      const snapshot = (id: string) =>
        expDb
          .prepare(
            `SELECT verification_status, admission_verdict, admission_checked_at, description FROM experiences WHERE id = ?`,
          )
          .get(id) as
          | { verification_status: string; admission_verdict: string | null; admission_checked_at: string | null; description: string | null }
          | undefined;

      // ── (a) auth gate ──────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: {} });
        assertEq(r.status, 403, "cjs-1: no X-Admin-Key -> 403");
      }

      // ── seed the main mixed cohort ───────────────────────────────────────
      insertExperience.run({
        id: "cjs-match", title: "Fjelltur med guide", slug: "cjs-match",
        description: "Kort om fjellturen.", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: "https://good.no/fjelltur", verification_status: "verified", confidence: "high", canonical_id: null,
      });
      insertExperience.run({
        id: "cjs-mismatch", title: "Kajakktur", slug: "cjs-mismatch",
        description: "En kajakktur langs kysten.", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: "https://mismatch.no/kajakk", verification_status: "verified", confidence: "high", canonical_id: null,
      });
      insertExperience.run({
        id: "cjs-judgefail", title: "Skitur", slug: "cjs-judgefail",
        description: "En skitur i fjellet.", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: "https://judgefail.no/ski", verification_status: "pending_verify", confidence: null, canonical_id: null,
      });
      insertExperience.run({
        id: "cjs-fetchfail", title: "Fisketur", slug: "cjs-fetchfail",
        description: "En fisketur.", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: "http://localhost/fisk", verification_status: "pending_verify", confidence: null, canonical_id: null,
      });
      const boilerplateHtml = "<html><body>Hagevandring i vakker natur, perfekt for hele familien.</body></html>";
      const boilerplateText = "Hagevandring i vakker natur, perfekt for hele familien.";
      insertExperience.run({
        id: "cjs-boilerplate", title: "Hagevandring", slug: "cjs-boilerplate",
        description: boilerplateText, category: "aktivitet", price_band: "standard", price_from: 300,
        evidence_url: "https://good.no/hagevandring", verification_status: "verified", confidence: "high", canonical_id: null,
      });
      insertExperience.run({
        id: "cjs-ownsummary", title: "Brevandring", slug: "cjs-ownsummary",
        description: "En fin tur i naturen, egen oppsummering.", category: "aktivitet", price_band: "standard", price_from: 700,
        evidence_url: "https://good.no/brevandring", verification_status: "verified", confidence: "high", canonical_id: null,
      });
      // Not eligible: canonical_id set (superseded/hidden) — must never be
      // scanned by this sweep even though it carries an evidence_url.
      insertExperience.run({
        id: "cjs-superseded", title: "Duplisert tur", slug: "cjs-superseded",
        description: "d", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: "https://good.no/duplisert", verification_status: "verified", confidence: "high", canonical_id: "cjs-match",
      });
      // Not eligible: no evidence_url at all.
      insertExperience.run({
        id: "cjs-noevidence", title: "Uten evidens", slug: "cjs-noevidence",
        description: "d", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: null, verification_status: "verified", confidence: "high", canonical_id: null,
      });

      let pageFetches = 0;
      let judgeCalls = 0;
      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr === "https://api.anthropic.com/v1/messages") {
          judgeCalls++;
          const body = JSON.parse(init?.body ?? "{}");
          const promptText: string = body?.messages?.[0]?.content ?? "";
          if (promptText.includes("Kajakktur")) return mkAnthropicResponse("MISMATCH\nSiden handler om noe annet.");
          if (promptText.includes("Skitur")) {
            return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response;
          }
          return mkAnthropicResponse("MATCH\nStemmer med kilden.");
        }
        pageFetches++;
        if (urlStr === "https://good.no/fjelltur") {
          return mkPageResponse("<html><body>Fjelltur med guide i vakker natur, avgang hver dag.</body></html>", urlStr);
        }
        if (urlStr === "https://mismatch.no/kajakk") {
          return mkPageResponse("<html><body>Dette er en side om noe helt annet.</body></html>", urlStr);
        }
        if (urlStr === "https://judgefail.no/ski") {
          return mkPageResponse("<html><body>Skitur i fjellet med guide.</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/hagevandring") {
          return mkPageResponse(boilerplateHtml, urlStr);
        }
        if (urlStr === "https://good.no/brevandring") {
          return mkPageResponse("<html><body>Brevandring med guide, is og fjell i to timer.</body></html>", urlStr);
        }
        throw new Error("content-judge-sweep test: unexpected fetch URL: " + urlStr);
      }) as unknown as typeof fetch;

      const eligibleIds = [
        "cjs-match",
        "cjs-mismatch",
        "cjs-judgefail",
        "cjs-fetchfail",
        "cjs-boilerplate",
        "cjs-ownsummary",
      ];

      // ── (b) dry-run: correct report, ZERO writes, byte-identical re-run ──
      let dryRunBody1: any;
      {
        const before = new Map(eligibleIds.map((id) => [id, snapshot(id)]));

        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        dryRunBody1 = r.body;
        assertEq(r.status, 200, "cjs-2a: dry-run -> 200");
        assertEq(r.body.dry_run, true, "cjs-2b: apply omitted -> dry_run:true");
        assertEq(r.body.scanned, 6, "cjs-2c: scanned == exactly the 6 eligible rows (superseded + no-evidence excluded)");
        assertEq(r.body.remaining, 0, "cjs-2d: remaining is 0 (6 eligible, cap is 50)");
        assertEq(
          { match: r.body.counts.match, mismatch: r.body.counts.mismatch, unresolved: r.body.counts.unresolved, description_nulled: r.body.counts.description_nulled },
          { match: 3, mismatch: 1, unresolved: 2, description_nulled: 1 },
          "cjs-2e: counts — 3 MATCH (match/boilerplate/ownsummary), 1 MISMATCH, 2 unresolved (fetchfail+judgefail), 1 boilerplate description found",
        );

        const byId = new Map<string, any>((r.body.results as any[]).map((x) => [x.id, x]));
        assertEq(byId.get("cjs-match")?.verdict, "MATCH", "cjs-2f: cjs-match verdict MATCH");
        assertTrue(!!byId.get("cjs-match")?.would_be_action, "cjs-2g: dry-run rows carry would_be_action, not action_taken");
        assertEq(byId.get("cjs-match")?.action_taken, undefined, "cjs-2h: dry-run rows never carry action_taken");
        assertEq(byId.get("cjs-mismatch")?.verdict, "MISMATCH", "cjs-2i: cjs-mismatch verdict MISMATCH");
        assertEq(byId.get("cjs-judgefail")?.verdict, "unresolved", "cjs-2j: judge-failure row is unresolved");
        assertEq(byId.get("cjs-fetchfail")?.verdict, "unresolved", "cjs-2k: fetch-failure row is unresolved");
        assertEq(byId.get("cjs-boilerplate")?.description_nulled, false, "cjs-2l: dry-run never actually nulls the description");
        assertTrue(
          !!byId.get("cjs-boilerplate")?.would_be_action?.includes("boilerplate"),
          "cjs-2m: boilerplate row's would_be_action mentions the description nulling it would do",
        );
        assertEq(byId.get("cjs-ownsummary")?.description_nulled, false, "cjs-2n: genuine own-summary description never flagged as boilerplate");

        // Zero writes: every snapshotted row unchanged.
        let allUnchanged = true;
        for (const id of eligibleIds) {
          const b = before.get(id);
          const a = snapshot(id);
          if (JSON.stringify(a) !== JSON.stringify(b)) allUnchanged = false;
        }
        assertTrue(allUnchanged, "cjs-2o: dry-run wrote NOTHING — every row's verification_status/admission_verdict/admission_checked_at/description unchanged");
      }

      // ── (h) sampling additive fields: verification_status per row +
      //      counts.published_in_sample, reusing PUBLISH_GATE_SQL; and
      //      explicit sample:"queue" is byte-identical to sample omitted ──
      {
        // Of the 6 eligible rows in this cohort: cjs-match, cjs-mismatch,
        // cjs-boilerplate, cjs-ownsummary are verification_status='verified'
        // with confidence='high' and no provider_id (PUBLISH_GATE_SQL's
        // provider clause passes on NULL provider) -> published. cjs-judgefail
        // and cjs-fetchfail are 'pending_verify' -> not published.
        assertEq(
          dryRunBody1.counts.published_in_sample,
          4,
          "cjs-h1: published_in_sample counts the verified rows in this batch (cjs-match/cjs-mismatch/cjs-boilerplate/cjs-ownsummary), excluding the 2 pending_verify rows",
        );

        const byId = new Map<string, any>((dryRunBody1.results as any[]).map((x) => [x.id, x]));
        assertEq(byId.get("cjs-match")?.verification_status, "verified", "cjs-h2: cjs-match result carries verification_status='verified'");
        assertEq(byId.get("cjs-mismatch")?.verification_status, "verified", "cjs-h3: cjs-mismatch result carries verification_status='verified' (still verified pre-apply)");
        assertEq(byId.get("cjs-judgefail")?.verification_status, "pending_verify", "cjs-h4: cjs-judgefail result carries verification_status='pending_verify'");
        assertEq(byId.get("cjs-fetchfail")?.verification_status, "pending_verify", "cjs-h5: cjs-fetchfail result carries verification_status='pending_verify'");
        assertEq(byId.get("cjs-boilerplate")?.verification_status, "verified", "cjs-h6: cjs-boilerplate result carries verification_status='verified'");
        assertEq(byId.get("cjs-ownsummary")?.verification_status, "verified", "cjs-h7: cjs-ownsummary result carries verification_status='verified'");

        // sample:"queue" explicit == sample omitted (both are the default,
        // unchanged ordering) — byte-identical response, including the new
        // fields, no regression on any pre-existing field.
        const rExplicitQueue = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample: "queue" } });
        assertEq(rExplicitQueue.body.scanned, dryRunBody1.scanned, "cjs-h8: explicit sample:'queue' scanned identical to default (sample omitted)");
        assertEq(rExplicitQueue.body.counts, dryRunBody1.counts, "cjs-h9: explicit sample:'queue' counts (incl. published_in_sample) identical to default");
        assertEq(rExplicitQueue.body.results, dryRunBody1.results, "cjs-h10: explicit sample:'queue' results byte-identical to default (same ordering, same fields, incl. verification_status)");
        assertEq(rExplicitQueue.body.remaining, dryRunBody1.remaining, "cjs-h11: explicit sample:'queue' remaining identical to default");
      }

      // ── re-run the identical dry-run call: byte-identical report ────────
      {
        const r2 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        assertEq(r2.body.scanned, dryRunBody1.scanned, "cjs-3a: re-run scanned identical");
        assertEq(r2.body.counts, dryRunBody1.counts, "cjs-3b: re-run counts identical");
        assertEq(r2.body.results, dryRunBody1.results, "cjs-3c: re-run per-row results byte-identical (DB never changed between calls)");
        assertEq(r2.body.remaining, dryRunBody1.remaining, "cjs-3d: re-run remaining identical");
      }

      // ── (c) apply: writes land correctly + publish-gate composition ─────
      const beforeApplyMismatchServed = experienceStore.getPublishedExperienceById("cjs-mismatch");
      assertTrue(!!beforeApplyMismatchServed, "cjs-4a: BEFORE apply, the (still verified) mismatch row IS served by getPublishedExperienceById");

      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        assertEq(r.status, 200, "cjs-4b: apply -> 200");
        assertEq(r.body.dry_run, false, "cjs-4c: apply:true -> dry_run:false");
        assertEq(r.body.scanned, 6, "cjs-4d: apply scans the same 6 eligible rows");

        const byId = new Map<string, any>((r.body.results as any[]).map((x) => [x.id, x]));
        assertTrue(!!byId.get("cjs-match")?.action_taken, "cjs-4e: apply rows carry action_taken, not would_be_action");
        assertEq(byId.get("cjs-match")?.would_be_action, undefined, "cjs-4f: apply rows never carry would_be_action");

        const match = snapshot("cjs-match")!;
        assertEq(match.verification_status, "verified", "cjs-5a: MATCH row keeps its verification_status");
        assertTrue(!!match.admission_verdict?.startsWith("match:"), "cjs-5b: MATCH row stamped 'match: <reasoning>'");
        assertTrue(!!match.admission_checked_at, "cjs-5c: MATCH row's admission_checked_at advanced (stamped even though no status change)");

        const mismatch = snapshot("cjs-mismatch")!;
        assertEq(mismatch.verification_status, "needs_review", "cjs-6a: MISMATCH row flipped to needs_review");
        assertTrue(!!mismatch.admission_verdict?.startsWith("mismatch:"), "cjs-6b: MISMATCH row stamped 'mismatch: <reasoning>'");
        assertTrue(!!mismatch.admission_checked_at, "cjs-6c: MISMATCH row's admission_checked_at stamped");
        assertEq(
          byId.get("cjs-mismatch")?.verification_status,
          "needs_review",
          "cjs-6d: apply-mode response for the MISMATCH row reports POST-write verification_status ('needs_review'), not the stale pre-write SELECT value ('verified') — must agree with its own action_taken text",
        );

        const judgefail = snapshot("cjs-judgefail")!;
        assertEq(judgefail.verification_status, "pending_verify", "cjs-7a: judge-failure row's status untouched (no MISMATCH verdict was rendered)");
        assertTrue(!!judgefail.admission_verdict?.startsWith("unresolved:"), "cjs-7b: judge-failure row stamped 'unresolved: <reasoning>'");

        const fetchfail = snapshot("cjs-fetchfail")!;
        assertEq(fetchfail.verification_status, "pending_verify", "cjs-8a: fetch-failure row's status untouched");
        assertTrue(!!fetchfail.admission_verdict?.startsWith("unresolved:"), "cjs-8b: fetch-failure row stamped 'unresolved: <reasoning>'");

        // ── (e) boilerplate-description nulling in apply mode ─────────────
        const boilerplate = snapshot("cjs-boilerplate")!;
        assertEq(boilerplate.description, null, "cjs-9a: boilerplate (verbatim-copy) description nulled in apply mode");
        assertEq(byId.get("cjs-boilerplate")?.description_nulled, true, "cjs-9b: response reports description_nulled:true for the boilerplate row");

        const ownsummary = snapshot("cjs-ownsummary")!;
        assertEq(ownsummary.description, "En fin tur i naturen, egen oppsummering.", "cjs-9c: genuine own-summary description left untouched by apply");
        assertEq(byId.get("cjs-ownsummary")?.description_nulled, false, "cjs-9d: response reports description_nulled:false for the own-summary row");

        // ── composition: the flipped MISMATCH row no longer publish-gates ──
        const afterApplyMismatchServed = experienceStore.getPublishedExperienceById("cjs-mismatch");
        assertEq(afterApplyMismatchServed, null, "cjs-10: AFTER apply, the needs_review mismatch row is NO LONGER served by getPublishedExperienceById (PUBLISH_GATE_SQL)");
      }

      // ── (d) idempotency: a second apply call is safe on unchanged content ─
      {
        const r2 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        assertEq(r2.status, 200, "cjs-11a: second apply call -> 200, no crash");
        const byId2 = new Map<string, any>((r2.body.results as any[]).map((x) => [x.id, x]));
        assertEq(byId2.get("cjs-mismatch")?.verdict, "MISMATCH", "cjs-11b: re-judging unchanged content reaches the same MISMATCH verdict");

        const mismatchAgain = snapshot("cjs-mismatch")!;
        assertEq(mismatchAgain.verification_status, "needs_review", "cjs-11c: second apply does not re-flip or change the already-needs_review status");
      }

      // ── (f) per-call cap + never-checked-first ordering ──────────────────
      {
        for (let i = 0; i < 55; i++) {
          insertExperience.run({
            id: `cjs-cap-${i}`, title: `Kapasitetstur ${i}`, slug: `cjs-cap-${i}`,
            description: "d", category: "aktivitet", price_band: "standard", price_from: 500,
            evidence_url: `http://localhost/cap-${i}`, verification_status: "pending_verify", confidence: null, canonical_id: null,
          });
        }
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: true } });
        assertEq(r.status, 200, "cjs-12a: cap-cohort apply -> 200");
        assertEq(r.body.scanned, 50, "cjs-12b: exactly SWEEP_MAX_LIMIT (50) rows scanned this call");
        // 55 never-checked cap rows + 6 already-checked rows from earlier =
        // 61 total eligible; never-checked-first ordering means this call's
        // 50 scanned rows are ALL cap rows (never touches the already-
        // checked 6 yet), leaving 61 - 50 = 11 remaining.
        assertEq(r.body.remaining, 11, "cjs-12c: remaining = 61 total eligible - 50 scanned this call");
        assertEq(r.body.counts.unresolved, 50, "cjs-12d: all 50 scanned cap rows are SSRF-blocked -> unresolved");
        const scannedIds = new Set((r.body.results as any[]).map((x) => x.id));
        assertTrue(!scannedIds.has("cjs-match"), "cjs-12e: never-checked cap rows were prioritized over the already-checked cjs-match row");
      }

      // ── (g) `limit` param — body and query, honored under cap / clamped over ──
      {
        const r1 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: false, limit: 3 } });
        assertEq(r1.body.scanned, 3, "cjs-13a: body limit:3 (under the cap) is honored exactly");

        const r2 = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/experiences-content-judge-sweep?limit=2",
          body: {},
        });
        assertEq(r2.body.scanned, 2, "cjs-13b: query ?limit=2 (under the cap) is honored exactly");

        const r3 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { apply: false, limit: 999 } });
        assertEq(r3.body.scanned, 50, "cjs-13c: an over-cap limit clamps to SWEEP_MAX_LIMIT (50), never processes more");
      }

      // ── (i) sample:"random" — ORDER BY RANDOM() mechanism, and the
      //      apply:true+sample:"random" 400 guard (no SELECT/write) ────────
      {
        const preparedSql: string[] = [];
        const originalPrepare = expDb.prepare.bind(expDb);
        (expDb as any).prepare = (sql: string, ...rest: any[]) => {
          preparedSql.push(sql);
          return originalPrepare(sql, ...rest);
        };

        try {
          // (i-1) sample:"random" + apply:true -> 400, BEFORE any db.prepare()
          // call at all (the guard returns before getExpDb/SELECT/write), and
          // before any evidence-page fetch or judge call.
          const pageFetchesBefore = pageFetches;
          const judgeCallsBefore = judgeCalls;
          const rBlocked = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { sample: "random", apply: true },
          });
          assertEq(rBlocked.status, 400, "cjs-i1: sample:'random' + apply:true -> 400");
          assertTrue(
            typeof rBlocked.body?.error === "string" && rBlocked.body.error.length > 0,
            "cjs-i2: 400 response carries a non-empty JSON { error } message",
          );
          assertEq(preparedSql.length, 0, "cjs-i3: the guard returns BEFORE any db.prepare() call — zero SELECT, zero write");
          assertEq(pageFetches, pageFetchesBefore, "cjs-i4: no evidence-page fetch happened (no rows were ever selected)");
          assertEq(judgeCalls, judgeCallsBefore, "cjs-i5: no judge call happened");

          // (i-2) sample:"random" alone (dry-run, apply absent) -> 200, and
          // the row-selection SELECT's ORDER BY is actually RANDOM() — this
          // is a mechanism assertion on the SQL text itself (via the
          // db.prepare() spy above), never on two calls happening to return
          // different rows, which would be flaky.
          preparedSql.length = 0;
          const rRandom = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample: "random" } });
          assertEq(rRandom.status, 200, "cjs-i6: sample:'random' dry-run -> 200");
          assertEq(rRandom.body.dry_run, true, "cjs-i7: sample:'random' dry-run still reports dry_run:true (apply absent)");
          const selectSqlRandom = preparedSql.find((s) => /FROM experiences\b/.test(s) && /ORDER BY/.test(s));
          assertTrue(!!selectSqlRandom, "cjs-i8: a row-selection SELECT (with an ORDER BY) ran");
          assertTrue(
            !!selectSqlRandom && /ORDER BY RANDOM\(\)/.test(selectSqlRandom),
            "cjs-i9: sample:'random' swaps the ORDER BY clause to RANDOM()",
          );
          assertTrue(
            !!selectSqlRandom && !/admission_checked_at IS NULL/.test(selectSqlRandom),
            "cjs-i10: the default admission_checked_at ordering is NOT present when sample:'random' is set",
          );
          assertTrue(
            !!selectSqlRandom &&
              /LIMIT \?/.test(selectSqlRandom) &&
              /evidence_url IS NOT NULL AND canonical_id IS NULL/.test(selectSqlRandom) &&
              /verification_status/.test(selectSqlRandom),
            "cjs-i11: only the ORDER BY changed — columns/WHERE/LIMIT of the SELECT are untouched",
          );

          // sample:"queue" explicit still uses the ORIGINAL ordering (never
          // RANDOM()), confirming the swap is genuinely conditional on the
          // param rather than a permanent regression.
          preparedSql.length = 0;
          const rQueueAgain = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { sample: "queue" } });
          assertEq(rQueueAgain.status, 200, "cjs-i12: sample:'queue' dry-run -> 200");
          const selectSqlQueue = preparedSql.find((s) => /FROM experiences\b/.test(s) && /ORDER BY/.test(s));
          assertTrue(
            !!selectSqlQueue && /admission_checked_at IS NULL DESC, admission_checked_at ASC/.test(selectSqlQueue),
            "cjs-i13: sample:'queue' keeps the original admission_checked_at ordering",
          );
          assertTrue(!!selectSqlQueue && !/RANDOM\(\)/.test(selectSqlQueue), "cjs-i14: sample:'queue' never uses RANDOM()");
        } finally {
          (expDb as any).prepare = originalPrepare;
        }
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-content-judge-sweep: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-content-judge-sweep.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesContentJudgeSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

/**
 * opplevelser-experiences-requarantine-rejudge.test.ts — tests for dev-request
 * 2026-09-14-opplevagent-falske-karantener-doede-sider-gjenopprett, spec
 * items 2+3:
 *   - GET  /admin/experiences-status-transitions
 *   - POST /admin/experiences-requarantine-rejudge
 *
 * PROBLEM this closes: the 2026-09-13 mass-apply sweep MISMATCH-ed dead and
 * parked evidence pages (fixed separately in
 * experience-content-judge-evidence-page.test.ts), demoting an unknown share
 * of the 420 MISMATCH-stamped rows from `verified` to `needs_review` even
 * though a dead/parked page carries no content-quality signal at all. These
 * two endpoints (a) list exactly the rows the sweep mismatch-stamped in a
 * given window, and (b) re-judge them with the FIXED classifier, restoring
 * to `verified` only a row whose NEW verdict is MATCH or unresolved-for-dead-
 * or-parked-reasons AND that satisfies PUBLISH_GATE_SQL_EXCEPT_STATUS (this
 * route's reconstruction of "was actually verified/published before the
 * sweep touched it" — see that constant's doc comment, experience-store.ts).
 *
 * Same test-harness conventions as opplevelser-experiences-content-judge-
 * sweep.test.ts / opplevelser-experiences-admission-promotion.test.ts:
 * in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:"), fresh requires
 * per run, router.handle() as the HTTP entry point, a mocked globalThis.fetch
 * keyed on URL for both evidence pages and the Anthropic judge endpoint — no
 * live network anywhere in this file. Dead-page rows deliberately use
 * `http://localhost/...` evidence_url's, which fetchPage()'s OWN SSRF guard
 * rejects before any fetch() call is made at all (same convention the sweep
 * test file already uses) — no separate fetch-mock branch needed for them.
 *
 * Covers:
 *   (a) auth gate: no X-Admin-Key -> 403 on BOTH routes.
 *   (b) GET status-transitions: validates from=verified&to=needs_review
 *       (anything else -> 400), requires `since` (-> 400 if missing), and
 *       lists EXACTLY the in-window, needs_review, admission_verdict LIKE
 *       'mismatch:%' rows — excluding an out-of-window row, a match-stamped
 *       row, and an already-verified row — each with a correct
 *       would_publish_if_verified flag.
 *   (c) POST requarantine-rejudge dry-run: reports correct counts (dead 2,
 *       parked 1, match 1, mismatch 1, judge_failed 0, restored 3,
 *       held_not_previously_verified 1) with PROVABLY ZERO writes — every
 *       candidate row's verification_status/admission_verdict/
 *       admission_checked_at is byte-for-byte unchanged after the call.
 *   (d) POST requarantine-rejudge apply (dry_run:false): the 3 eligible rows
 *       (dead/parked/match, all would_publish_if_verified) flip to
 *       'verified', get a `requarantine_verified:` admission_verdict stamp,
 *       and each gets exactly one experience_admission_promotion_audit row
 *       (reason starts with `requarantine_rejudge:`, batch_id = this call's
 *       own). The still-MISMATCH-on-live-page row and the not-previously-
 *       verified row are BOTH left at needs_review, but both get their
 *       admission_verdict re-stamped (mismatch:/unresolved:) so a later,
 *       wider-window call does not reprocess them as if nothing happened.
 *   (e) apply is STRICT: omitting dry_run, or passing dry_run:true (or any
 *       other value), never writes anything — only an EXPLICIT dry_run:false
 *       does.
 *   (f) rollback composition: POST /admin/experiences-admission-promotion-
 *       rollback with the requarantine batch_id reverts exactly the 3
 *       restored rows back to needs_review and leaves the untouched rows
 *       alone.
 *   (g) a second GET status-transitions call over the SAME FIXED
 *       (2026-09-13) window after apply lists NOTHING at all any more — every
 *       candidate this call touched (restored, held, or re-affirmed
 *       MISMATCH) got its admission_checked_at advanced to the real current
 *       time by the fresh stamp, so none remain inside a fixed historical
 *       window, even the still-genuinely-mismatched row (its admission_
 *       verdict is still `mismatch:`, just no longer timestamped inside this
 *       window) — proving admission_checked_at genuinely advances for EVERY
 *       row this route visits, not just the restored ones.
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
  opts: { method?: "GET" | "POST"; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/experiences-requarantine-rejudge";
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
      method,
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

export function runOpplevelserExperiencesRequarantineRejudgeTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "requarantine-rejudge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-requarantine-rejudge";

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
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, brreg_active) VALUES (@id, @navn, @brreg_active)`,
      );
      insertProvider.run({ id: "prov-active", navn: "Aktiv Tilbyder", brreg_active: 1 });
      insertProvider.run({ id: "prov-inactive", navn: "Inaktiv Tilbyder", brreg_active: 0 });

      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, title, slug, description, category, price_band, price_from, evidence_url,
            verification_status, confidence, canonical_id, provider_id, content_source, enrichment_state,
            admission_verdict, admission_checked_at)
         VALUES
           (@id, @title, @slug, @description, @category, @price_band, @price_from, @evidence_url,
            @verification_status, @confidence, @canonical_id, @provider_id, 'provider_site', 'enriched',
            @admission_verdict, @admission_checked_at)`,
      );

      const snapshot = (id: string) =>
        expDb
          .prepare(
            `SELECT verification_status, admission_verdict, admission_checked_at FROM experiences WHERE id = ?`,
          )
          .get(id) as { verification_status: string; admission_verdict: string | null; admission_checked_at: string | null };

      const IN_WINDOW = "2026-09-13 12:00:00";
      const BEFORE_WINDOW = "2026-09-13 09:00:00";
      const SINCE = "2026-09-13T10:00:00Z";
      const UNTIL = "2026-09-13T14:00:00Z";

      // 1. Dead evidence page, provider brreg_active=1 (would_publish_if_verified) -> restore
      insertExperience.run({
        id: "rq-dead-restore", title: "Deadtur", slug: "rq-dead-restore",
        description: "En tur.", category: "aktivitet", price_band: "standard", price_from: 400,
        evidence_url: "http://localhost/rq-dead", verification_status: "needs_review",
        confidence: "high", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "mismatch: (2026-09-13 mass-apply, dead page misjudged)", admission_checked_at: IN_WINDOW,
      });

      // 2. Parked evidence page (evidence_url hostname itself is a known parking host) -> restore
      insertExperience.run({
        id: "rq-parked-restore", title: "Parkedtur", slug: "rq-parked-restore",
        description: "En annen tur.", category: "aktivitet", price_band: "standard", price_from: 450,
        evidence_url: "https://sedo.com/search?domain=lapsed-parkedtur.no", verification_status: "needs_review",
        confidence: "high", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "mismatch: (2026-09-13 mass-apply, parked page misjudged)", admission_checked_at: IN_WINDOW,
      });

      // 3. Live page, genuinely MATCHES -> restore (judge itself was simply wrong on 9/13,
      //    OR content has since been fixed — either way, a fresh MATCH restores it)
      insertExperience.run({
        id: "rq-match-restore", title: "Matchtur", slug: "rq-match-restore",
        description: "En tredje tur.", category: "aktivitet", price_band: "standard", price_from: 500,
        evidence_url: "https://good.no/matchtur", verification_status: "needs_review",
        confidence: "medium", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "mismatch: (2026-09-13, will re-judge MATCH now)", admission_checked_at: IN_WINDOW,
      });

      // 4. Live page, GENUINELY still wrong -> stays needs_review (never restored)
      insertExperience.run({
        id: "rq-still-mismatch", title: "Mismatchtur", slug: "rq-still-mismatch",
        description: "En fjerde tur.", category: "aktivitet", price_band: "standard", price_from: 550,
        evidence_url: "https://mismatch.no/mismatchtur", verification_status: "needs_review",
        confidence: "high", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "mismatch: (2026-09-13, genuinely wrong content)", admission_checked_at: IN_WINDOW,
      });

      // 5. Dead evidence page too, but provider brreg_active=0 -> would_publish_if_verified
      //    is FALSE -> eligible-by-verdict but HELD (not previously verified/published)
      insertExperience.run({
        id: "rq-not-prev-verified", title: "Ikkeverifisertur", slug: "rq-not-prev-verified",
        description: "En femte tur.", category: "aktivitet", price_band: "standard", price_from: 600,
        evidence_url: "http://localhost/rq-dead-2", verification_status: "needs_review",
        confidence: "high", canonical_id: null, provider_id: "prov-inactive",
        admission_verdict: "mismatch: (2026-09-13, dead page, but never actually published)", admission_checked_at: IN_WINDOW,
      });

      // 6. Outside the window -> excluded from both endpoints entirely
      insertExperience.run({
        id: "rq-outside-window", title: "Utenforvindutur", slug: "rq-outside-window",
        description: "En sjette tur.", category: "aktivitet", price_band: "standard", price_from: 650,
        evidence_url: "http://localhost/rq-outside", verification_status: "needs_review",
        confidence: "high", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "mismatch: (before the window)", admission_checked_at: BEFORE_WINDOW,
      });

      // 7. Not mismatch-stamped -> excluded
      insertExperience.run({
        id: "rq-match-stamped", title: "Matchstemplettur", slug: "rq-match-stamped",
        description: "En sjuende tur.", category: "aktivitet", price_band: "standard", price_from: 700,
        evidence_url: "http://localhost/rq-matchstamped", verification_status: "needs_review",
        confidence: "high", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "match: (already fine)", admission_checked_at: IN_WINDOW,
      });

      // 8. Already verified (defensive — should never happen from the sweep, but the
      //    query's own verification_status='needs_review' clause must still exclude it)
      insertExperience.run({
        id: "rq-already-verified", title: "Alleredeverifiserttur", slug: "rq-already-verified",
        description: "En åttende tur.", category: "aktivitet", price_band: "standard", price_from: 750,
        evidence_url: "http://localhost/rq-already-verified", verification_status: "verified",
        confidence: "high", canonical_id: null, provider_id: "prov-active",
        admission_verdict: "mismatch: (stale, already verified again by hand)", admission_checked_at: IN_WINDOW,
      });

      let pageFetches = 0;
      let judgeCalls = 0;
      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr === "https://api.anthropic.com/v1/messages") {
          judgeCalls++;
          const body = JSON.parse(init?.body ?? "{}");
          const promptText: string = body?.messages?.[0]?.content ?? "";
          if (promptText.includes("Mismatchtur")) return mkAnthropicResponse("MISMATCH\nFortsatt feil innhold.");
          return mkAnthropicResponse("MATCH\nStemmer med kilden.");
        }
        pageFetches++;
        if (urlStr.startsWith("https://sedo.com/")) {
          return mkPageResponse("<html><body>This domain is for sale. Buy it now!</body></html>", urlStr);
        }
        if (urlStr === "https://good.no/matchtur") {
          return mkPageResponse("<html><body>Matchtur med guide, stemmer helt med beskrivelsen.</body></html>", urlStr);
        }
        if (urlStr === "https://mismatch.no/mismatchtur") {
          return mkPageResponse("<html><body>Dette er en helt urelatert side.</body></html>", urlStr);
        }
        throw new Error("requarantine-rejudge test: unexpected fetch URL: " + urlStr);
      }) as unknown as typeof fetch;

      // ── (a) auth gate: both routes ─────────────────────────────────────
      {
        const r1 = await callRoute(opplevelserRouter, { method: "POST", body: {} });
        assertEq(r1.status, 403, "rq-1a: POST requarantine-rejudge, no X-Admin-Key -> 403");
        const r2 = await callRoute(opplevelserRouter, {
          method: "GET",
          url: "/admin/experiences-status-transitions?from=verified&to=needs_review&since=2026-09-13T10:00:00Z",
        });
        assertEq(r2.status, 403, "rq-1b: GET status-transitions, no X-Admin-Key -> 403");
      }

      // ── (b) GET status-transitions ─────────────────────────────────────
      {
        const badTransition = await callRoute(opplevelserRouter, {
          method: "GET",
          url: `/admin/experiences-status-transitions?from=needs_review&to=verified&since=${SINCE}`,
          headers: adminHeaders,
        });
        assertEq(badTransition.status, 400, "rq-2a: unsupported from/to -> 400");

        const noSince = await callRoute(opplevelserRouter, {
          method: "GET",
          url: `/admin/experiences-status-transitions?from=verified&to=needs_review`,
          headers: adminHeaders,
        });
        assertEq(noSince.status, 400, "rq-2b: missing since -> 400");

        const r = await callRoute(opplevelserRouter, {
          method: "GET",
          url: `/admin/experiences-status-transitions?from=verified&to=needs_review&since=${SINCE}&until=${UNTIL}`,
          headers: adminHeaders,
        });
        assertEq(r.status, 200, "rq-2c: valid call -> 200");
        assertEq(pageFetches, 0, "rq-2d: GET status-transitions is read-only — zero page fetches");
        assertEq(judgeCalls, 0, "rq-2e: GET status-transitions is read-only — zero judge calls");

        const ids = (r.body.rows as any[]).map((x) => x.id).sort();
        assertEq(
          ids,
          ["rq-dead-restore", "rq-match-restore", "rq-not-prev-verified", "rq-parked-restore", "rq-still-mismatch"].sort(),
          "rq-2f: lists exactly the 5 in-window, needs_review, mismatch-stamped rows — excludes outside-window/match-stamped/already-verified",
        );
        const byId = new Map<string, any>((r.body.rows as any[]).map((x) => [x.id, x]));
        assertEq(byId.get("rq-dead-restore")?.would_publish_if_verified, true, "rq-2g: dead-restore row would_publish_if_verified=true (brreg_active=1)");
        assertEq(byId.get("rq-not-prev-verified")?.would_publish_if_verified, false, "rq-2h: not-prev-verified row would_publish_if_verified=false (brreg_active=0)");
      }

      // ── (c) POST requarantine-rejudge dry-run: correct counts, ZERO writes ──
      let dryRunBatchId = "";
      {
        const before = new Map(
          ["rq-dead-restore", "rq-parked-restore", "rq-match-restore", "rq-still-mismatch", "rq-not-prev-verified"].map(
            (id) => [id, snapshot(id)],
          ),
        );
        pageFetches = 0;
        judgeCalls = 0;

        const r = await callRoute(opplevelserRouter, {
          method: "POST",
          url: "/admin/experiences-requarantine-rejudge",
          headers: adminHeaders,
          body: { since: SINCE, until: UNTIL },
        });
        dryRunBatchId = r.body.batch_id;
        assertEq(r.status, 200, "rq-3a: dry-run -> 200");
        assertEq(r.body.dry_run, true, "rq-3b: dry_run omitted -> dry_run:true");
        assertEq(r.body.scanned, 5, "rq-3c: scanned == exactly the 5 in-window candidates");
        assertEq(
          {
            evidence_page_dead: r.body.counts.evidence_page_dead,
            evidence_page_parked: r.body.counts.evidence_page_parked,
            match: r.body.counts.match,
            mismatch: r.body.counts.mismatch,
            judge_failed: r.body.counts.judge_failed,
            restored: r.body.counts.restored,
            held_not_previously_verified: r.body.counts.held_not_previously_verified,
          },
          { evidence_page_dead: 2, evidence_page_parked: 1, match: 1, mismatch: 1, judge_failed: 0, restored: 3, held_not_previously_verified: 1 },
          "rq-3d: dry-run counts — 2 dead, 1 parked, 1 match, 1 mismatch, 3 restorable, 1 held (not previously verified)",
        );
        assertTrue(judgeCalls === 2, "rq-3e: LLM judge called exactly twice (only the two LIVE pages — dead/parked never reach it)");

        for (const [id, snap] of before) {
          assertEq(snapshot(id), snap, `rq-3f: dry-run leaves ${id} byte-for-byte unchanged`);
        }
      }

      // ── (e, part 1) dry_run:true explicit is ALSO a no-op ───────────────
      {
        const before = snapshot("rq-dead-restore");
        await callRoute(opplevelserRouter, {
          method: "POST",
          url: "/admin/experiences-requarantine-rejudge",
          headers: adminHeaders,
          body: { since: SINCE, until: UNTIL, dry_run: true },
        });
        assertEq(snapshot("rq-dead-restore"), before, "rq-4a: dry_run:true explicit is still a no-op");
      }

      // ── (d) apply: dry_run:false ────────────────────────────────────────
      let applyBatchId = "";
      {
        const r = await callRoute(opplevelserRouter, {
          method: "POST",
          url: "/admin/experiences-requarantine-rejudge",
          headers: adminHeaders,
          body: { since: SINCE, until: UNTIL, dry_run: false },
        });
        applyBatchId = r.body.batch_id;
        assertEq(r.status, 200, "rq-5a: apply -> 200");
        assertEq(r.body.dry_run, false, "rq-5b: dry_run:false -> dry_run:false in response");
        assertEq(r.body.counts.restored, 3, "rq-5c: 3 rows restored");
        assertTrue(applyBatchId !== dryRunBatchId, "rq-5d: apply gets its OWN batch_id, distinct from the dry-run preview's");

        for (const id of ["rq-dead-restore", "rq-parked-restore", "rq-match-restore"]) {
          const snap = snapshot(id);
          assertEq(snap.verification_status, "verified", `rq-5e: ${id} restored to verified`);
          assertTrue(!!snap.admission_verdict?.startsWith("requarantine_verified:"), `rq-5f: ${id} admission_verdict stamped requarantine_verified:`);
        }

        const stillMismatch = snapshot("rq-still-mismatch");
        assertEq(stillMismatch.verification_status, "needs_review", "rq-5g: still-genuinely-mismatched row stays needs_review");
        assertTrue(!!stillMismatch.admission_verdict?.startsWith("mismatch:"), "rq-5h: still-mismatch row re-stamped mismatch: (advances admission_checked_at)");

        const notPrevVerified = snapshot("rq-not-prev-verified");
        assertEq(notPrevVerified.verification_status, "needs_review", "rq-5i: not-previously-verified row stays needs_review (held)");
        assertTrue(!!notPrevVerified.admission_verdict?.startsWith("unresolved:"), "rq-5j: held row re-stamped unresolved: (no longer 'mismatch:')");

        const auditRows = expDb
          .prepare(`SELECT experience_id, from_status, to_status, reason FROM experience_admission_promotion_audit WHERE batch_id = ?`)
          .all(applyBatchId) as Array<{ experience_id: string; from_status: string; to_status: string; reason: string }>;
        assertEq(auditRows.length, 3, "rq-5k: exactly 3 audit rows written for this batch");
        const auditIds = auditRows.map((a) => a.experience_id).sort();
        assertEq(auditIds, ["rq-dead-restore", "rq-match-restore", "rq-parked-restore"].sort(), "rq-5l: audit rows are keyed to exactly the 3 restored rows");
        assertTrue(auditRows.every((a) => a.from_status === "needs_review" && a.to_status === "verified"), "rq-5m: every audit row records needs_review -> verified");
        assertTrue(auditRows.every((a) => a.reason.startsWith("requarantine_rejudge:")), "rq-5n: every audit row's reason starts with requarantine_rejudge:");
      }

      // ── (e, part 2) idempotency: a second apply call over the SAME window is a no-op now ──
      {
        const before = new Map(
          ["rq-dead-restore", "rq-parked-restore", "rq-match-restore", "rq-still-mismatch", "rq-not-prev-verified"].map(
            (id) => [id, snapshot(id)],
          ),
        );
        const r = await callRoute(opplevelserRouter, {
          method: "POST",
          url: "/admin/experiences-requarantine-rejudge",
          headers: adminHeaders,
          body: { since: SINCE, until: UNTIL, dry_run: false },
        });
        assertEq(r.body.scanned, 0, "rq-6a: second apply over the same window finds ZERO candidates (nothing is mismatch:-stamped any more)");
        for (const [id, snap] of before) {
          assertEq(snapshot(id), snap, `rq-6b: second apply leaves ${id} unchanged`);
        }
      }

      // ── (f) rollback composition ─────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          method: "POST",
          url: "/admin/experiences-admission-promotion-rollback",
          headers: adminHeaders,
          body: { batch_id: applyBatchId },
        });
        assertEq(r.status, 200, "rq-7a: rollback -> 200");
        const revertedIds = (r.body.reverted as any[]).map((x) => x.experience_id).sort();
        assertEq(revertedIds, ["rq-dead-restore", "rq-match-restore", "rq-parked-restore"].sort(), "rq-7b: rollback reverts exactly the 3 restored rows");
        for (const id of ["rq-dead-restore", "rq-parked-restore", "rq-match-restore"]) {
          assertEq(snapshot(id).verification_status, "needs_review", `rq-7c: ${id} back to needs_review after rollback`);
        }
        assertEq(snapshot("rq-still-mismatch").verification_status, "needs_review", "rq-7d: untouched row still needs_review (rollback never touched it)");
      }

      // ── (g) GET status-transitions after apply: only the genuine mismatch remains ──
      {
        const r = await callRoute(opplevelserRouter, {
          method: "GET",
          url: `/admin/experiences-status-transitions?from=verified&to=needs_review&since=${SINCE}&until=${UNTIL}`,
          headers: adminHeaders,
        });
        const ids = (r.body.rows as any[]).map((x) => x.id).sort();
        assertEq(
          ids,
          [],
          "rq-8a: after apply, the fixed 2026-09-13 window is now EMPTY — every candidate this call touched (restored, held, or re-affirmed mismatch) got its admission_checked_at advanced to the real current time by the re-stamp, so none remain inside a fixed historical window any more, even rq-still-mismatch (whose admission_verdict is still 'mismatch:', just no longer IN this window)",
        );
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

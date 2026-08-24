/**
 * admin-rfb-website-discovery.test.ts — tests for
 * dev-requests/2026-08-06-rfb-website-discovery-slice.md: candidate-homepage
 * discovery for RFB `agents` rows with a blank agent_knowledge.website,
 * stuck in verification_status IN ('pending_verify','review_required').
 * Tier-1 name-guessed candidate hosts (gardssalgWebsiteCandidateHosts,
 * services/experience-store.ts — imported directly, one of the few pure
 * DB-independent helpers the dev-request calls out as safe to reuse), fetched
 * via services/fetch-page.ts's shared classified fetcher, verified against
 * org_nr/name/place evidence (gardssalgWebsiteEvidenceMatch) before being
 * queued into the NEW agents_website_review_queue table. This route NEVER
 * writes agents/agent_knowledge — the queue INSERT/upsert is its only
 * effect, fully reversible via `DELETE FROM agents_website_review_queue`.
 *
 * Covers (src/routes/admin-rfb-website-discovery.ts):
 *   (a) 403 without X-Admin-Key on both routes.
 *   (b) candidate accepted: org_nr evidence on the first candidate host ->
 *       proposed + a 'pending' row lands in agents_website_review_queue.
 *   (c) candidate rejected: every candidate host fetches successfully but
 *       none carries matching evidence -> rejected reason
 *       'evidence_mismatch', nothing queued.
 *   (d) aggregator-host candidate rejected: a producer name whose first
 *       candidate host is a curated directory domain -> rejected reason
 *       'blocklisted_directory_domain', that host never fetched.
 *   (d2) rfbWebsiteHostExclusionReason unit coverage for RFB_WD_KNOWN_BAD_HOSTS
 *       (individually-known-bad hosts, e.g. the hijacked storbuktgard.no —
 *       distinct from the aggregator/directory set covered by (d)):
 *       "storbuktgard.no" -> 'known_hijacked_domain'; the "www." variant
 *       matches via the same parent-suffix walk as the other two sets; an
 *       unrelated host ("example.no") still returns null.
 *   (e) shared-host guard (existing table): a candidate host already carried
 *       by a DIFFERENT agent's live agent_knowledge.website -> rejected
 *       reason 'host_already_in_use', never fetched.
 *   (f) shared-host guard (within one batch): two agents whose first
 *       candidate host is identical and both verify against it — the first
 *       is proposed, the second is rejected with reason
 *       'host_already_proposed_this_batch'.
 *   (g) a row whose website is already non-blank is skipped and reported in
 *       already_has_website, never scanned as a target.
 *   (h) batch-size cap: more than RFB_WD_HARD_CAP agentIds -> 400.
 *   (i) GET /admin/rfb-website-review-queue returns only status='pending'
 *       rows, newest first.
 *   (j) mode: "aggregator_replace" — a row whose current website is a known
 *       aggregator/directory host is selected, a verified candidate is
 *       queued with existing_url set to the old aggregator URL and
 *       reason 'website_discovery_candidate_replacement', and the response
 *       echoes mode: "aggregator_replace".
 *   (k) mode: "aggregator_replace" — a row with a blank website is rejected
 *       with reason 'no_current_aggregator_website'.
 *   (l) mode: "aggregator_replace" — a row whose current website is already
 *       a genuine (non-excluded) site is rejected with
 *       'no_current_aggregator_website'.
 *   (m) mode: "aggregator_replace" — the shared-host guard (existing-in-
 *       catalog) still fires exactly as in blank mode.
 *   (n) GET /admin/rfb-website-review-queue returns existing_url for a row
 *       created via aggregator_replace mode.
 *   (o) mode omitted/"blank" — response and DB effect are unchanged (no
 *       regression versus (b)-(i) above, which all run with mode omitted).
 *
 * Skive 6 + 7 (dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype, punkt
 * 5/6 — root-caused in enrichment-reports/2026-08-13-websoek-jakt-wrong-
 * contact-og-wilsgaard.md):
 *   (y) Skive 6 (umbrella-filter) — a row with umbrella_type set (e.g.
 *       'venue') is excluded from default auto-select's target cohort even
 *       though it otherwise matches role/vertical/status/blank-website
 *       criteria, and its candidate host is never fetched; a regular
 *       producer row (umbrella_type IS NULL) alongside it is still scanned
 *       and proposed — no regression.
 *   (z) Skive 7 (pick-strategy) — default auto-select's ORDER BY is no
 *       longer purely a.created_at ASC: a source-text check confirms
 *       ORDER BY RANDOM() is used (and that aggregator_replace mode's own
 *       ordering is untouched), plus a functional smoke test that a
 *       strictly-newer row CAN be selected ahead of the single oldest
 *       eligible row at LIMIT 1 across repeated calls.
 *
 * dev-request 2026-08-14-rfb-wd-headless-fallback (headless-render fallback
 * for JS-shell candidate pages, services/render-page.ts, flag
 * RFB_WD_HEADLESS_FALLBACK_ENABLED, default OFF):
 *   (hf-a) flag OFF (default/unset) — fallback never attempted, byte-
 *       identical rejection even for a fixture that WOULD escalate if the
 *       flag were on.
 *   (hf-b) flag ON, plain fetch already verifies — fallback never
 *       attempted (no wasted render on a page that didn't need one).
 *   (hf-c) flag ON, plain fetch unverified + shouldEscalateToRender true —
 *       fallback attempted, renders, verifies -> hit returned using the
 *       RENDERED text/finalUrl, headless_fallback_attempted/_verified both 1.
 *   (hf-d) flag ON, fallback returns `renderer_unavailable` — never a
 *       throw, never a negative signal against the producer: falls through
 *       to the same generic `evidence_mismatch` rejection reason as
 *       every other unverified miss (never a renderer-specific reason).
 *   (hf-e) flag ON, plain fetch unverified but shouldEscalateToRender is
 *       false (a genuinely small static page, no <script>) — fallback
 *       never attempted.
 *
 * dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 5 (evaluateRfb
 * WebsiteCandidate extraction, AC1-AC3):
 *   AC1 — this ENTIRE suite (a)-(hf-e) above still passes UNMODIFIED after
 *       the per-item body of the `candidates` branch was extracted into the
 *       new exported evaluateRfbWebsiteCandidate() function — proves the
 *       extraction is behavior-preserving, not just believed to be (see
 *       "170 passed, 0 failed" before AND after in the build log).
 *   ac2 — evaluateRfbWebsiteCandidate() called DIRECTLY (no router in the
 *       call path at all) returns `proposed` for a fixture candidate whose
 *       fetched page carries matching evidence, and queues a row in
 *       agents_website_review_queue (DB read-back) with reason
 *       'website_discovery_candidate_external'.
 *   ac3 — same function called directly returns `already_has_website`
 *       WITHOUT any fetch/queue-write when the target agent's
 *       agent_knowledge.website is already non-blank.
 *
 * dev-request 2026-08-22-rfb-website-email-selvforsyning, punkt 4b
 * (ensureRfbKnowledgeRowsForAutoSelectCohort — batch knowledge-row creation
 * for the auto-select/blank-mode path):
 *   (kr) a producer agent with no agent_knowledge row at all gets one
 *       created by a blank-mode auto-select call; knowledge_rows_created in
 *       the response is >= 1; the agent is actually scanned in that SAME
 *       call (present in proposed/rejected, not silently absent — proves
 *       verification_status is set to a value rfbWdSelectSql's own filter
 *       accepts, not left at the schema default); a repeat call is
 *       idempotent (0 rows created, 0 new rows in the DB).
 *   (kr-agg) aggregator_replace mode never invokes the backfill — response
 *       always reports knowledge_rows_created: 0.
 * renderPage() itself is injected via the module-level
 * __setRfbWdRenderPageImplForTesting() test hook (mirrors
 * __setRfbCxRowDelayForTesting, admin-rfb-contact-extraction.ts) rather than
 * monkeypatched from outside the module — this codebase's esbuild/tsx
 * toolchain compiles ES imports to live bindings that cannot be reassigned
 * externally (see the file-header note in
 * opplevelser-content-refresh-errors-by-persistence.test.ts).
 *
 * globalThis.fetch is mocked directly, keyed on URL (same convention as the
 * closest sibling test file, opplevelser-gardssalg-website-discovery.test.ts)
 * — safe here because this suite is run standalone (see the file-scoping
 * note in the dev-request: this test file is intentionally NOT wired into
 * tests/test.ts, since doing so would require editing that file, outside
 * this slice's touched-files list) rather than interleaved with other
 * globalThis.fetch-swapping suites.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-rfb-website-discovery.test.ts
 *   2. Not wired into `npm test` (tests/test.ts) — see note above.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function htmlResponse(html: string, opts: { status?: number; finalUrl?: string } = {}) {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: opts.finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    // Grep 4d (dev-request 2026-08-22-rfb-website-email-selvforsyning):
    // tags this Response as eligible for stubFetch()'s self-reference-
    // marker auto-injection below — scoped to htmlResponse() output only,
    // never to unrelated Response-shaped mocks (e.g. judgeApiResponse's
    // api.anthropic.com JSON mock) that share the same `fixtures` map/
    // stubFetch dispatcher but have no arrayBuffer/pageish shape at all.
    __selfRefEligible: true,
  } as unknown as Response;
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    url: undefined,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

export async function runAdminRfbWebsiteDiscoveryTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevHeadlessFallbackEnabled = process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED;
  const prevBraveApiKey = process.env.BRAVE_API_KEY;
  const prevBraveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY;
  // Grep 3 slice 2 (dev-request 2026-08-24-grep3-website-judge-tier) — the
  // judge-route tests below flip this env var (contact-candidate-judge.ts
  // reads it directly) and must restore it, same discipline as every other
  // env var this suite already saves/restores.
  const prevAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  // Hoisted so `finally` (a sibling block scope of `try`) can still reach it
  // to reset the render-page injection point back to null even if an
  // assertion throws mid-suite.
  let setRfbWdRenderPageImplForTesting:
    | typeof import("../routes/admin-rfb-website-discovery")["__setRfbWdRenderPageImplForTesting"]
    | undefined;
  let setRfbWdSearchForTesting:
    | typeof import("../routes/admin-rfb-website-discovery")["__setRfbWdSearchForTesting"]
    | undefined;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "rfb-wd-test-key";

  // URL -> Response, keyed by the exact "https://<host>" this route requests
  // (services/fetch-page.ts always requests the bare origin, no path).
  const fixtures: Map<string, Response> = new Map();
  const fetchCalls: string[] = [];

  // Grep 4d (dev-request 2026-08-22-rfb-website-email-selvforsyning):
  // rfbWdPageReferencesOwnHost now requires every candidate page's raw html
  // to mention its own host somewhere. Every pre-existing fixture in this
  // suite represents the candidate's OWN genuine page (evidence-bearing or
  // not — even a "no evidence anywhere" fixture is still that host's real
  // page, not contamination), so this single, central point appends an
  // invisible self-reference marker (an HTML comment — stripped by both
  // visibleTextOf and gardssalgPageText's tag-stripping regex, so it can
  // never leak into extracted evidence text) keyed on the ACTUAL requested
  // url, rather than editing dozens of individual fixture strings by hand.
  // Scoped to `__selfRefEligible` (htmlResponse() output only) so unrelated
  // Response-shaped mocks dispatched through the same map (e.g.
  // judgeApiResponse's api.anthropic.com JSON mock, which has no
  // arrayBuffer/pageish shape) are left untouched. The suite's OWN new
  // Grep 4d contamination tests deliberately bypass this by swapping
  // globalThis.fetch directly (same pattern the jg-c/jg-d/jg-e/jg-f blocks
  // above already use) rather than going through `fixtures`, so they can
  // construct genuinely non-self-referencing "wrong page" content.
  function withSelfReferenceMarker(fx: Response, urlStr: string): Response {
    return {
      ...(fx as unknown as Record<string, unknown>),
      arrayBuffer: async () => {
        const buf = await fx.arrayBuffer();
        const html = new TextDecoder().decode(buf);
        let host = "";
        try {
          host = new URL(urlStr).hostname.toLowerCase();
        } catch {
          host = "";
        }
        const marked = host ? `${html}<!-- selfref:${host} -->` : html;
        return new TextEncoder().encode(marked).buffer;
      },
    } as unknown as Response;
  }

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const urlStr = String(url);
      fetchCalls.push(urlStr);
      const fx = fixtures.get(urlStr);
      if (!fx) return notFoundResponse();
      if (fx.ok && (fx as unknown as { __selfRefEligible?: boolean }).__selfRefEligible) {
        return withSelfReferenceMarker(fx, urlStr);
      }
      return fx;
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    globalThis.fetch = stubFetch();

    const routePath = require.resolve("../routes/admin-rfb-website-discovery");
    delete require.cache[routePath];
    const routeModule = require("../routes/admin-rfb-website-discovery") as
      typeof import("../routes/admin-rfb-website-discovery");
    const routerModule = routeModule.default;
    const {
      RFB_WD_HARD_CAP,
      RFB_WD_AUTO_APPROVE_BATCH_CAP,
      rfbWebsiteHostExclusionReason,
      __setRfbWdRenderPageImplForTesting,
      __setRfbWdSearchForTesting,
      evaluateRfbWebsiteCandidate,
      rfbWdExistingWebsiteHosts,
      // Grep 3 slice 2 (dev-request 2026-08-24-grep3-website-judge-tier)
      rfbWdQueueP95AgeDays,
      RFB_WD_JUDGE_MIN_CONFIDENCE,
      RFB_WD_JUDGE_MAX_CONFIDENCE_EXCLUSIVE,
      RFB_WD_REVIEW_QUEUE_STALE_DAYS,
      // Grep 4d (dev-request 2026-08-22-rfb-website-email-selvforsyning)
      rfbWdPageReferencesOwnHost,
    } = routeModule;
    setRfbWdRenderPageImplForTesting = __setRfbWdRenderPageImplForTesting;
    setRfbWdSearchForTesting = __setRfbWdSearchForTesting;

    function getHandler(method: "get" | "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postDiscovery = getHandler("post", "/rfb-website-discovery");
    const getQueue = getHandler("get", "/rfb-website-review-queue");

    async function callDiscovery(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postDiscovery({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }
    async function callQueue(headers: Record<string, string> = { "x-admin-key": ADMIN_KEY }): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await getQueue({ headers, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string;
      name: string;
      orgNr?: string | null;
      city?: string | null;
      website?: string | null;
      verificationStatus?: string;
      postalCode?: string | null;
      phone?: string | null;
      address?: string | null;
      role?: string;
      verticalId?: string | null;
      createdAt?: string;
      umbrellaType?: string | null;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, city, vertical_id, created_at
         ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.name, o.role ?? "producer", `key-${o.id}`,
        o.orgNr ?? null, o.city ?? null, o.verticalId ?? "rfb",
        o.createdAt ?? "2026-01-01 00:00:00",
      );
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, verification_status, postal_code, phone, address, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.website ?? null, o.verificationStatus ?? "pending_verify",
        o.postalCode ?? null, o.phone ?? null, o.address ?? null, new Date().toISOString(),
      );
      // umbrella_type isn't in the base agents INSERT column list above (kept
      // untouched so every pre-existing insertAgent() call site stays
      // byte-identical) — set separately, only when a caller opts in.
      if (o.umbrellaType !== undefined && o.umbrellaType !== null) {
        testDb.prepare(`UPDATE agents SET umbrella_type = ? WHERE id = ?`).run(o.umbrellaType, o.id);
      }
    }

    function readQueueRow(agentId: string): any {
      return testDb.prepare("SELECT * FROM agents_website_review_queue WHERE agent_id = ?").get(agentId);
    }

    // Direct queue-row insert for the auto-approve tests below — mirrors the
    // shape of the existing direct INSERT at (i) above, but exposes
    // `confidence`/`updatedAt` so a test can control exactly which rows
    // qualify for a given min_confidence and in what tiebreak order.
    function insertQueueRow(o: {
      id: string;
      agentId: string;
      candidateUrl: string;
      finalUrl?: string | null;
      confidence: number | null;
      status?: string;
      updatedAt?: string;
      batchId?: string | null;
    }): void {
      testDb.prepare(
        `INSERT INTO agents_website_review_queue
           (id, agent_id, agent_name, candidate_url, final_url, confidence, status, batch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      ).run(
        o.id,
        o.agentId,
        o.agentId,
        o.candidateUrl,
        o.finalUrl ?? o.candidateUrl,
        o.confidence,
        o.status ?? "pending",
        o.batchId ?? null,
        o.updatedAt ?? new Date().toISOString(),
      );
    }

    // ── (a) auth --
    {
      const p = await callDiscovery({}, {});
      assertEq(p.status, 403, "auth: POST without X-Admin-Key -> 403");
      const g = await callQueue({});
      assertEq(g.status, 403, "auth: GET without X-Admin-Key -> 403");
    }

    // ── (b) candidate accepted: org_nr evidence verifies --
    {
      insertAgent({ id: "wd-ok", name: "Fjelldal Brenneri AS", orgNr: "944444444", city: "Saltdal" });
      fixtures.set(
        "https://fjelldalbrenneri.no",
        htmlResponse("<html><body>Fjelldal Brenneri — org.nr 944 444 444</body></html>", { finalUrl: "https://fjelldalbrenneri.no" }),
      );

      const r = await callDiscovery({ agentIds: ["wd-ok"] });
      assertEq(r.status, 200, "b1: 200");
      assertEq(r.body.proposed.length, 1, "b2: exactly one proposal");
      const prop = r.body.proposed[0];
      assertEq(prop.agent_id, "wd-ok", "b3: proposal is for the right agent");
      assertEq(prop.candidate_url, "https://fjelldalbrenneri.no", "b4: candidate_url is the origin");
      assertEq(prop.evidence.org_nr_found, true, "b5: verified via org_nr on the page");
      assertEq(r.body.rejected.length, 0, "b6: nothing rejected");

      const row = readQueueRow("wd-ok");
      assertTrue(!!row, "b7: a queue row was inserted");
      assertEq(row.status, "pending", "b8: queue row status is 'pending'");
      assertEq(row.candidate_url, "https://fjelldalbrenneri.no", "b9: queue row candidate_url matches");
      assertTrue(typeof row.evidence === "string" && JSON.parse(row.evidence).org_nr_found === true, "b10: queue row evidence JSON round-trips");
    }

    // ── (c) candidate rejected: fetched, but no evidence anywhere --
    {
      insertAgent({ id: "wd-none", name: "Ukjent Fjellgard", orgNr: "966666666", city: "Lom" });
      const unrelated = htmlResponse("<html><body>Parkert domene til salgs</body></html>");
      fixtures.set("https://ukjentfjellgard.no", unrelated);
      fixtures.set("https://ukjent-fjellgard.no", unrelated);
      fixtures.set("https://ukjentfjellgard.com", unrelated);

      const r = await callDiscovery({ agentIds: ["wd-none"] });
      assertEq(r.body.proposed.length, 0, "c1: nothing proposed");
      assertEq(r.body.rejected.length, 1, "c2: one rejection");
      assertEq(r.body.rejected[0].agent_id, "wd-none", "c3: rejection is for the right agent");
      assertEq(r.body.rejected[0].reason, "evidence_mismatch", "c4: reason is evidence_mismatch (Grep 4f)");
      assertTrue(r.body.rejected[0].tried.length > 0, "c5: at least one host was actually fetched");
      assertTrue(!readQueueRow("wd-none"), "c6: nothing queued for this agent");
    }

    // ── (c2) candidate rejected: every candidate host genuinely fails to
    //     fetch (Grep 4f, dev-request 2026-08-22-rfb-website-email-
    //     selvforsyning) — distinct reason from (c)'s "fetched fine, no
    //     evidence" case, both of which used to collapse into the same
    //     generic 'no_candidate_verified' --
    {
      insertAgent({ id: "wd-unreachable", name: "Uraakelig Fjellgard", orgNr: "966666667", city: "Lom" });
      // No fixtures set for any of this producer's candidate hosts — the stub
      // fetch falls through to notFoundResponse() (HTTP 404) for every one.

      const r = await callDiscovery({ agentIds: ["wd-unreachable"] });
      assertEq(r.body.proposed.length, 0, "c2-1: nothing proposed");
      assertEq(r.body.rejected.length, 1, "c2-2: one rejection");
      assertEq(r.body.rejected[0].agent_id, "wd-unreachable", "c2-3: rejection is for the right agent");
      assertEq(r.body.rejected[0].reason, "fetch_failed:http_404", "c2-4: reason names fetch-page.ts's own truthful classifier, not the generic evidence reason");
      assertTrue(r.body.rejected[0].tried.length > 0, "c2-5: at least one host was actually attempted");
      assertTrue(!readQueueRow("wd-unreachable"), "c2-6: nothing queued for this agent");
    }

    // ── (d) aggregator-host candidate rejected --
    {
      insertAgent({ id: "wd-agg", name: "Hanen", orgNr: "911111111", city: "Oslo" });
      // hanen.com must NOT verify either, or this agent would be proposed
      // via its second candidate host instead of rejected.
      fixtures.set("https://hanen.com", notFoundResponse());

      const r = await callDiscovery({ agentIds: ["wd-agg"] });
      assertEq(r.body.proposed.length, 0, "d1: nothing proposed");
      assertEq(r.body.rejected[0].reason, "blocklisted_directory_domain", "d2: rejected as a curated directory host");
      assertTrue(
        !fetchCalls.includes("https://hanen.no"),
        "d3: the excluded host is never fetched (rejected BEFORE the network call)",
      );
    }

    // ── (d2) rfbWebsiteHostExclusionReason: RFB_WD_KNOWN_BAD_HOSTS (individually-
    //    known-bad hosts, e.g. the hijacked storbuktgard.no) — direct unit
    //    coverage of the exported pure function, mirroring how (d) proves the
    //    directory-host set via the route but exercising the function itself --
    {
      assertEq(
        rfbWebsiteHostExclusionReason("storbuktgard.no"),
        "known_hijacked_domain",
        "d2-1: storbuktgard.no is excluded as a known hijacked domain",
      );
      assertEq(
        rfbWebsiteHostExclusionReason("www.storbuktgard.no"),
        "known_hijacked_domain",
        "d2-2: www.storbuktgard.no matches via the same parent-suffix walk",
      );
      assertEq(
        rfbWebsiteHostExclusionReason("example.no"),
        null,
        "d2-3: an unrelated host is not a false positive",
      );
    }

    // ── (e) shared-host guard: host already carried by another agent's
    //     live agent_knowledge.website --
    {
      insertAgent({ id: "wd-owner", name: "Annen Produsent", orgNr: "933333333", city: "Voss", website: "https://solbakkengard.no" });
      insertAgent({ id: "wd-taken", name: "Solbakken Gard", orgNr: "922222222", city: "Voss" });
      // Candidate hosts 2/3 must not verify either, or the shared-host guard
      // on host 1 alone wouldn't be what determines the outcome.
      fixtures.set("https://solbakken-gard.no", notFoundResponse());
      fixtures.set("https://solbakkengard.com", notFoundResponse());

      const r = await callDiscovery({ agentIds: ["wd-taken"] });
      assertEq(r.body.proposed.length, 0, "e1: nothing proposed for wd-taken");
      const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-taken");
      assertTrue(!!rej, "e2: wd-taken was rejected");
      assertEq(rej.reason, "host_already_in_use", "e3: reason is host_already_in_use");
      assertTrue(
        !fetchCalls.includes("https://solbakkengard.no"),
        "e4: the already-carried host is never fetched",
      );
    }

    // ── (f) shared-host guard: same host proposed twice within one batch ─
    {
      insertAgent({ id: "wd-batch-1", name: "Batch Delt Gard AS", city: "Bodø" });
      insertAgent({ id: "wd-batch-2", name: "Batch Delt Gard AS", city: "Bodø" });
      const matching = htmlResponse("<html><body>Batch Delt Gard AS ligger i Bodø</body></html>", { finalUrl: "https://batchdeltgard.no" });
      fixtures.set("https://batchdeltgard.no", matching);
      // The 2nd/3rd candidate hosts must NOT verify, so wd-batch-2's rejection
      // is unambiguously due to the shared-host-this-batch guard on host 1.
      fixtures.set("https://batch-delt-gard.no", notFoundResponse());
      fixtures.set("https://batchdeltgard.com", notFoundResponse());

      // Order matters: agentIds preserves the given order, so wd-batch-1 is
      // processed (and proposed) before wd-batch-2 is even attempted.
      const r = await callDiscovery({ agentIds: ["wd-batch-1", "wd-batch-2"] });
      const prop1 = r.body.proposed.find((p: any) => p.agent_id === "wd-batch-1");
      assertTrue(!!prop1, "f1: wd-batch-1 (processed first) is proposed");
      assertEq(prop1.candidate_url, "https://batchdeltgard.no", "f2: wd-batch-1 got the shared host");
      const rej2 = r.body.rejected.find((x: any) => x.agent_id === "wd-batch-2");
      assertTrue(!!rej2, "f3: wd-batch-2 (processed second) is rejected");
      assertEq(rej2.reason, "host_already_proposed_this_batch", "f4: rejected for the within-batch shared-host guard");
      assertTrue(!readQueueRow("wd-batch-2"), "f5: nothing queued for wd-batch-2");
    }

    // ── (g) already-has-website row is skipped, never scanned --
    {
      insertAgent({ id: "wd-has-site", name: "Har Allerede Nettside", website: "https://eksisterende-side.no" });

      const r = await callDiscovery({ agentIds: ["wd-has-site"] });
      assertEq(r.body.scanned, 0, "g1: skipped row never enters the scanned target set");
      assertTrue(
        r.body.already_has_website.some((x: any) => x.agent_id === "wd-has-site"),
        "g2: reported in already_has_website",
      );
      assertTrue(
        !fetchCalls.some((u) => u.includes("eksisterende") || u.includes("har-allerede")),
        "g3: no fetch ever attempted for a row that already has a website",
      );
    }

    // ── (h) batch-size cap enforced --
    {
      const ids = Array.from({ length: RFB_WD_HARD_CAP + 1 }, (_, i) => `cap-${i}`);
      const r = await callDiscovery({ agentIds: ids });
      assertEq(r.status, 400, `h1: more than ${RFB_WD_HARD_CAP} agentIds -> 400`);
    }

    // ── (i) GET review-queue returns only status='pending' rows --
    {
      testDb.prepare(
        `INSERT INTO agents_website_review_queue
           (id, agent_id, agent_name, candidate_url, status, created_at, updated_at)
         VALUES ('q-resolved', 'wd-resolved-agent', 'Resolved Agent', 'https://resolved.no', 'approved', datetime('now'), datetime('now'))`,
      ).run();

      const r = await callQueue();
      assertEq(r.status, 200, "i1: 200");
      const ids: string[] = r.body.queue.map((row: any) => row.agent_id);
      assertTrue(ids.includes("wd-ok"), "i2: pending row from (b) is listed");
      assertTrue(!ids.includes("wd-resolved-agent"), "i3: non-pending row is excluded");
      assertTrue(
        r.body.queue.every((row: any) => row.status === "pending"),
        "i4: every returned row has status='pending'",
      );
    }

    // ── (j) mode: "aggregator_replace" — candidate accepted, existing_url
    //     records the old aggregator URL, reason is the replacement variant --
    {
      insertAgent({
        id: "wd-repl-ok",
        name: "Solvang Gard",
        orgNr: "977777777",
        city: "Oppdal",
        website: "https://facebook.com/solvanggard",
      });
      fixtures.set(
        "https://solvanggard.no",
        htmlResponse("<html><body>Solvang Gard — org.nr 977 777 777</body></html>", { finalUrl: "https://solvanggard.no" }),
      );

      const r = await callDiscovery({ agentIds: ["wd-repl-ok"], mode: "aggregator_replace" });
      assertEq(r.status, 200, "j1: 200");
      assertEq(r.body.mode, "aggregator_replace", "j2: response echoes mode");
      assertEq(r.body.proposed.length, 1, "j3: exactly one proposal");
      const prop = r.body.proposed[0];
      assertEq(prop.agent_id, "wd-repl-ok", "j4: proposal is for the right agent");
      assertEq(prop.candidate_url, "https://solvanggard.no", "j5: candidate_url is the new origin");
      assertEq(r.body.rejected.length, 0, "j6: nothing rejected");
      assertEq(r.body.already_has_website.length, 0, "j7: nothing rejected as already-has-website");

      const row = readQueueRow("wd-repl-ok");
      assertTrue(!!row, "j8: a queue row was inserted");
      assertEq(row.existing_url, "https://facebook.com/solvanggard", "j9: existing_url is the old aggregator URL");
      assertEq(row.reason, "website_discovery_candidate_replacement", "j10: reason is the replacement variant");
      assertEq(row.candidate_url, "https://solvanggard.no", "j11: queue row candidate_url matches");
    }

    // ── (k) mode: "aggregator_replace" — blank-website row is rejected --
    {
      insertAgent({ id: "wd-repl-blank", name: "Blank Website Gard" });

      const r = await callDiscovery({ agentIds: ["wd-repl-blank"], mode: "aggregator_replace" });
      assertEq(r.body.scanned, 0, "k1: blank-website row never enters the scanned target set");
      const rej = r.body.already_has_website.find((x: any) => x.agent_id === "wd-repl-blank");
      assertTrue(!!rej, "k2: row is reported in already_has_website");
      assertEq(rej.reason, "no_current_aggregator_website", "k3: reason is no_current_aggregator_website");
      assertTrue(!readQueueRow("wd-repl-blank"), "k4: nothing queued");
    }

    // ── (l) mode: "aggregator_replace" — already-genuine-website row is
    //     rejected (same reason as a blank row, distinguishing this mode
    //     from blank mode's already_has_website check) --
    {
      insertAgent({ id: "wd-repl-genuine", name: "Ekte Egen Nettside Gard", website: "https://ekteeigennettside.no" });

      const r = await callDiscovery({ agentIds: ["wd-repl-genuine"], mode: "aggregator_replace" });
      assertEq(r.body.scanned, 0, "l1: genuine-website row never enters the scanned target set");
      const rej = r.body.already_has_website.find((x: any) => x.agent_id === "wd-repl-genuine");
      assertTrue(!!rej, "l2: row is reported in already_has_website");
      assertEq(rej.reason, "no_current_aggregator_website", "l3: reason is no_current_aggregator_website");
      assertTrue(
        !fetchCalls.some((u) => u.includes("ekteeigennettside")),
        "l4: no fetch ever attempted for a row that already has a genuine site",
      );
    }

    // ── (m) mode: "aggregator_replace" — shared-host guard (existing-in-
    //     catalog) still fires exactly as in blank mode --
    {
      insertAgent({ id: "wd-repl-owner", name: "Annen Produsent To", orgNr: "988888888", city: "Voss", website: "https://batchdeltgard.no" });
      insertAgent({
        id: "wd-repl-taken",
        name: "Batch Delt Gard AS",
        city: "Bodø",
        website: "https://gulesider.no/batchdeltgard",
      });
      // Candidate hosts 2/3 must not verify either, or the shared-host guard
      // on host 1 alone wouldn't be what determines the outcome (same
      // fixture shape as (e); "https://batchdeltgard.no" is already claimed
      // by wd-repl-owner's own live agent_knowledge.website above).
      fixtures.set("https://batch-delt-gard.no", notFoundResponse());
      fixtures.set("https://batchdeltgard.com", notFoundResponse());

      const r = await callDiscovery({ agentIds: ["wd-repl-taken"], mode: "aggregator_replace" });
      assertEq(r.body.proposed.length, 0, "m1: nothing proposed for wd-repl-taken");
      const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-repl-taken");
      assertTrue(!!rej, "m2: wd-repl-taken was rejected");
      assertEq(rej.reason, "host_already_in_use", "m3: reason is host_already_in_use");
      assertTrue(!readQueueRow("wd-repl-taken"), "m4: nothing queued for wd-repl-taken");
    }

    // ── (n) GET review-queue returns existing_url for an aggregator_replace
    //     row --
    {
      const r = await callQueue();
      const row = r.body.queue.find((x: any) => x.agent_id === "wd-repl-ok");
      assertTrue(!!row, "n1: the aggregator_replace row from (j) is listed");
      assertEq(row.existing_url, "https://facebook.com/solvanggard", "n2: GET echoes existing_url");
      assertEq(row.reason, "website_discovery_candidate_replacement", "n3: GET echoes the replacement reason");
    }

    // ── (o) mode omitted/"blank" — unchanged: re-running discovery for
    //     wd-ok (from (b)) with mode explicitly "blank" reproduces the same
    //     result and refreshes (not duplicates) its queue row --
    {
      const r = await callDiscovery({ agentIds: ["wd-ok"], mode: "blank" });
      assertEq(r.body.mode, "blank", "o1: response echoes mode: blank");
      assertEq(r.body.proposed.length, 1, "o2: still exactly one proposal");
      assertEq(r.body.proposed[0].agent_id, "wd-ok", "o3: still proposes wd-ok");
      // fakeRes stores the body object directly (no real JSON.stringify), so
      // an `undefined` value is still an own key; what matters is that the
      // real Express res.json() (which DOES call JSON.stringify) would drop
      // it — check that directly, the same serialization blank-mode callers
      // over HTTP actually observe.
      assertTrue(
        !JSON.stringify(r.body.proposed[0]).includes("existing_url"),
        "o4: blank-mode proposal's serialized JSON omits existing_url entirely",
      );

      const row = readQueueRow("wd-ok");
      assertEq(row.existing_url, null, "o5: blank-mode queue row's existing_url stays NULL");
      assertEq(row.reason, "website_discovery_candidate", "o6: blank-mode reason is unchanged");
      const countRow = testDb.prepare("SELECT COUNT(*) AS n FROM agents_website_review_queue WHERE agent_id = 'wd-ok'").get() as { n: number };
      assertEq(countRow.n, 1, "o7: refresh, don't pile up — still exactly one row for wd-ok");
    }

    // ═══ punkt 4a (dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype):
    //     external-candidate intake ═══

    // ── (p) a caller-proposed URL with evidence verifies and queues with the
    //     external reason — even when the host is NOT name-guessable --
    {
      insertAgent({ id: "wd-ext-ok", name: "Bakkely Ysteri", orgNr: "955555555", city: "Voss" });
      fixtures.set(
        "https://bakkely-ysteri-butikk.no",
        htmlResponse("<html><body>Bakkely Ysteri på Voss — org.nr 955 555 555</body></html>", { finalUrl: "https://bakkely-ysteri-butikk.no" }),
      );
      const r = await callDiscovery({ candidates: [{ agentId: "wd-ext-ok", url: "https://bakkely-ysteri-butikk.no/om-oss" }] });
      assertEq(r.status, 200, "p1: 200");
      assertEq(r.body.mode, "external_candidates", "p2: response mode is external_candidates");
      assertEq(r.body.proposed.length, 1, "p3: exactly one proposal");
      assertEq(r.body.proposed[0].candidate_url, "https://bakkely-ysteri-butikk.no", "p4: candidate_url reduced to origin (path dropped)");
      assertEq(r.body.proposed[0].evidence.org_nr_found, true, "p5: verified via org_nr on the page");
      const row = readQueueRow("wd-ext-ok");
      assertTrue(!!row, "p6: queue row inserted");
      assertEq(row.reason, "website_discovery_candidate_external", "p7: queue reason marks external intake");
      assertEq(row.status, "pending", "p8: status pending");
    }

    // ── (q) external candidate on a social host is excluded pre-fetch --
    {
      insertAgent({ id: "wd-ext-fb", name: "Lien Gard", orgNr: "977777777", city: "Førde" });
      const before = fetchCalls.length;
      const r = await callDiscovery({ candidates: [{ agentId: "wd-ext-fb", url: "https://www.facebook.com/liengard" }] });
      assertEq(r.body.proposed.length, 0, "q1: nothing proposed");
      assertEq(r.body.rejected.length, 1, "q2: one rejection");
      assertEq(r.body.rejected[0].reason, "social_media_host", "q3: social host excluded");
      assertEq(fetchCalls.length, before, "q4: the excluded host was never fetched");
      assertTrue(!readQueueRow("wd-ext-fb"), "q5: nothing queued");
    }

    // ── (r) intake input contract: ambiguous/malformed calls are 400 --
    {
      const both = await callDiscovery({ candidates: [{ agentId: "x", url: "https://x.no" }], agentIds: ["y"] });
      assertEq(both.status, 400, "r1: candidates+agentIds combined -> 400");
      const malformed = await callDiscovery({ candidates: [{ agentId: "x" }] });
      assertEq(malformed.status, 400, "r2: malformed candidate item -> 400");
      const wrongMode = await callDiscovery({ candidates: [{ agentId: "x", url: "https://x.no" }], mode: "aggregator_replace" });
      assertEq(wrongMode.status, 400, "r3: aggregator_replace with candidates -> 400");
    }

    // ── (p2) Grep 4e (dev-request 2026-08-22-rfb-website-email-selvforsyning):
    //     external-candidate intake threads a caller-supplied contactOverride
    //     (kommune+telefon, mirroring Grep 1c's BSS-route usage of the SAME
    //     evaluateRfbWebsiteCandidate 8th param) into evidenceTarget — a row
    //     with city=NULL AND phone=NULL on file can now still verify against
    //     a page that carries the producer's Brreg-registered kommune/telefon
    //     instead of its own (missing) city/phone. Byggspec's (s) --
    {
      insertAgent({ id: "wd-ext-anchor-ok", name: "Fjell Delikatesser", city: null, phone: null });
      fixtures.set(
        "https://fjelldelikatesser-butikk.no",
        htmlResponse("<html><body>Fjell kommune. Telefon: 912 34 567.</body></html>", { finalUrl: "https://fjelldelikatesser-butikk.no" }),
      );
      const r = await callDiscovery({
        candidates: [
          {
            agentId: "wd-ext-anchor-ok",
            url: "https://fjelldelikatesser-butikk.no/om-oss",
            contactOverride: { kommune: "Fjell", telefon: "91234567" },
          },
        ],
      });
      assertEq(r.body.proposed.length, 1, "p2-1: exactly one proposal (contactOverride supplied the missing anchor evidence)");
      assertEq(r.body.proposed[0].evidence.place_found, true, "p2-2: kommune override matched on the page");
      assertEq(r.body.proposed[0].evidence.phone_found, true, "p2-3: telefon override matched on the page");
      const row = readQueueRow("wd-ext-anchor-ok");
      assertTrue(!!row, "p2-4: queue row inserted");
    }

    // ── (p3) same page/evidence as (p2), but a DIFFERENT city=NULL/phone=NULL
    //     agent whose candidate is sent WITHOUT contactOverride — proves (p2)
    //     is the override doing the work, not some other change (mutation-
    //     test discipline: this case must fail if the fix in
    //     evaluateRfbWebsiteCandidate is reverted). Byggspec's (t) --
    {
      insertAgent({ id: "wd-ext-anchor-noover", name: "Fjell Delikatesser To", city: null, phone: null });
      fixtures.set(
        "https://fjelldelikatesser2-butikk.no",
        htmlResponse("<html><body>Fjell kommune. Telefon: 912 34 567.</body></html>", { finalUrl: "https://fjelldelikatesser2-butikk.no" }),
      );
      const r = await callDiscovery({
        candidates: [{ agentId: "wd-ext-anchor-noover", url: "https://fjelldelikatesser2-butikk.no/om-oss" }],
      });
      assertEq(r.body.proposed.length, 0, "p3-1: nothing proposed without contactOverride (city/phone both NULL on the row)");
      assertEq(r.body.rejected.length, 1, "p3-2: one rejection");
      assertEq(r.body.rejected[0].reason, "evidence_mismatch", "p3-3: rejected for lack of evidence, not some other reason");
      assertTrue(!readQueueRow("wd-ext-anchor-noover"), "p3-4: nothing queued");
    }

    // ── (p4) contactOverride with ONLY kommune (telefon/mobil omitted) --
    //     independent-fields proof: telefon evidence-matching still falls
    //     back to the row's own t.phone unaffected, not all-or-nothing.
    //     Byggspec's (u) --
    {
      insertAgent({ id: "wd-ext-anchor-partial", name: "Nordkapp Sjomat", city: null, phone: "91234567" });
      fixtures.set(
        "https://nordkappsjomat-butikk.no",
        htmlResponse("<html><body>Nordkapp. Telefon: 91234567.</body></html>", { finalUrl: "https://nordkappsjomat-butikk.no" }),
      );
      const r = await callDiscovery({
        candidates: [
          {
            agentId: "wd-ext-anchor-partial",
            url: "https://nordkappsjomat-butikk.no/om-oss",
            contactOverride: { kommune: "Nordkapp" },
          },
        ],
      });
      assertEq(r.body.proposed.length, 1, "p4-1: proposed — kommune override + phone fallback to t.phone together verify");
      assertEq(r.body.proposed[0].evidence.place_found, true, "p4-2: kommune override matched (telefon/mobil omitted from the override)");
      assertEq(r.body.proposed[0].evidence.phone_found, true, "p4-3: telefon evidence still matched via t.phone, unaffected by the kommune-only override");
      const row = readQueueRow("wd-ext-anchor-partial");
      assertTrue(!!row, "p4-4: queue row inserted");
    }

    // ── (s) external candidate for a row that already has a website --
    {
      insertAgent({ id: "wd-ext-has", name: "Solheim Gartneri", website: "https://solheimgartneri.no" });
      const r = await callDiscovery({ candidates: [{ agentId: "wd-ext-has", url: "https://annen-side.no" }] });
      assertEq(r.body.already_has_website.length, 1, "s1: reported in already_has_website");
      assertEq(r.body.already_has_website[0].agent_id, "wd-ext-has", "s2: the right agent");
      assertTrue(!readQueueRow("wd-ext-has"), "s3: nothing queued");
    }

    // ── (s2) external candidate for a producer with NO agent_knowledge row:
    //     the missing row is created empty and the candidate is evaluated on
    //     the merits (2026-08-13 INNER JOIN gap — 8/24 BM-matched webless
    //     producers 404'd out of the intake as not_found) --
    {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, city, vertical_id, created_at
         ) VALUES ('wd-ext-nok', 'Vangen Gardsmat', 't', 't', 'x@example.com',
                   'https://example.com', 'producer', 'key-wd-ext-nok',
                   '966666666', 'Skjåk', 'rfb', '2026-01-01 00:00:00')`,
      ).run();
      assertTrue(
        !testDb.prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = 'wd-ext-nok'").get(),
        "s2-pre: no agent_knowledge row exists",
      );
      fixtures.set(
        "https://vangengardsmat.no",
        htmlResponse("<html><body>Vangen Gardsmat i Skjåk — org.nr 966 666 666</body></html>", { finalUrl: "https://vangengardsmat.no" }),
      );
      const r = await callDiscovery({ candidates: [{ agentId: "wd-ext-nok", url: "https://vangengardsmat.no" }] });
      assertEq(r.body.not_found.length, 0, "s2-1: NOT reported not_found anymore");
      assertEq(r.body.proposed.length, 1, "s2-2: evaluated and proposed on evidence");
      assertEq(r.body.proposed[0].agent_id, "wd-ext-nok", "s2-3: for the right agent");
      const kRow = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-ext-nok'").get() as { website: string | null } | undefined;
      assertTrue(!!kRow, "s2-4: the missing agent_knowledge row was created");
      assertEq(kRow!.website ?? null, null, "s2-5: created row is blank — apply stays fill-only");
      assertTrue(!!readQueueRow("wd-ext-nok"), "s2-6: queued as pending");
    }

    // ── (s3) the knowledge-row backfill is scoped: a non-producer without a
    //     knowledge row stays not_found and no row is manufactured --
    {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at
         ) VALUES ('wd-ext-cons', 'Ikke Produsent', 't', 't', 'x@example.com',
                   'https://example.com', 'consumer', 'key-wd-ext-cons', 'rfb', '2026-01-01 00:00:00')`,
      ).run();
      const r = await callDiscovery({ candidates: [
        { agentId: "wd-ext-cons", url: "https://noe.no" },
        { agentId: "finnes-ikke", url: "https://annet.no" },
      ] });
      assertEq(r.body.not_found.length, 2, "s3-1: non-producer and unknown id both not_found");
      assertTrue(
        !testDb.prepare("SELECT 1 FROM agent_knowledge WHERE agent_id IN ('wd-ext-cons','finnes-ikke')").get(),
        "s3-2: no knowledge row manufactured for either",
      );
    }

    // ═══ punkt 4b: the approve/apply lever ═══

    const postApprove = getHandler("post", "/rfb-website-review-approve");
    async function callApprove(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postApprove({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── (t) approve: dry-run default confirms without writing --
    {
      const r = await callApprove({ approvals: [{ agent_id: "wd-ext-ok", url: "https://bakkely-ysteri-butikk.no" }] });
      assertEq(r.status, 200, "t1: 200");
      assertEq(r.body.dry_run, true, "t2: dry-run is the default");
      assertEq(r.body.approved_count, 1, "t3: pair confirmed approvable");
      assertEq(r.body.written_count, 0, "t4: nothing written in dry-run");
      const k = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-ext-ok'").get() as any;
      assertTrue(!k.website, "t5: website column still blank after dry-run");
      assertEq(readQueueRow("wd-ext-ok").status, "pending", "t6: queue row still pending");
    }

    // ── (u) approve: apply writes column + provenance + audit, flips queue --
    {
      const r = await callApprove({ approvals: [{ agent_id: "wd-ext-ok", url: "https://bakkely-ysteri-butikk.no" }], apply: true });
      assertEq(r.body.dry_run, false, "u1: apply mode");
      assertEq(r.body.written_count, 1, "u2: exactly one write");
      const k = testDb.prepare("SELECT website, field_provenance FROM agent_knowledge WHERE agent_id = 'wd-ext-ok'").get() as any;
      assertEq(k.website, "https://bakkely-ysteri-butikk.no", "u3: website column written (fill-only)");
      const prov = JSON.parse(k.field_provenance || "{}");
      assertTrue(
        Array.isArray(prov.website) && prov.website.length === 1 && prov.website[0].source_type === "homepage",
        "u4: field_provenance merged with a homepage-source record",
      );
      const audit = testDb
        .prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = 'wd-ext-ok' AND field_name = 'website'")
        .get() as any;
      assertTrue(!!audit && audit.new_value === "https://bakkely-ysteri-butikk.no", "u5: agent_knowledge_audit row appended");
      const q = testDb.prepare("SELECT status FROM agents_website_review_queue WHERE agent_id = 'wd-ext-ok'").get() as any;
      assertEq(q.status, "applied", "u6: queue row flipped to 'applied'");
      const g = await callQueue();
      assertTrue(!g.body.queue.find((x: any) => x.agent_id === "wd-ext-ok"), "u7: no longer listed as pending");
    }

    // ── (v) approve: strict confirmation surface — wrong URL / non-queued
    //     agent are rejected, nothing written --
    {
      const r = await callApprove({
        approvals: [
          { agent_id: "wd-ok", url: "https://feil-domene.no" },
          { agent_id: "wd-aldri-koet", url: "https://x.no" },
        ],
        apply: true,
      });
      const reasons = new Map(r.body.rejected.map((x: any) => [x.agent_id, x.reason]));
      assertEq(reasons.get("wd-ok"), "mismatch_with_queued_candidate", "v1: a different URL than queued is rejected");
      assertEq(reasons.get("wd-aldri-koet"), "not_in_review_queue", "v2: a non-queued agent is rejected");
      assertEq(r.body.written_count, 0, "v3: nothing written");
    }

    // ── (w) approve: owner-claimed row is guard-skipped at write time --
    {
      insertAgent({ id: "wd-claimed", name: "Haugtun Gard", orgNr: "933333333", city: "Gol" });
      fixtures.set(
        "https://haugtungard.no",
        htmlResponse("<html><body>Haugtun Gard i Gol — org.nr 933 333 333</body></html>", { finalUrl: "https://haugtungard.no" }),
      );
      await callDiscovery({ agentIds: ["wd-claimed"] });
      assertTrue(!!readQueueRow("wd-claimed"), "w1: queued via normal discovery");
      testDb.prepare("UPDATE agents SET claimed_at = datetime('now') WHERE id = 'wd-claimed'").run();
      const r = await callApprove({ approvals: [{ agent_id: "wd-claimed", url: "https://haugtungard.no" }], apply: true });
      assertEq(r.body.written_count, 0, "w2: nothing written");
      const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-claimed");
      assertEq(rej?.reason, "owner_claimed_row_locked", "w3: claimed-row lock respected");
      const k = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-claimed'").get() as any;
      assertTrue(!k.website, "w4: website column untouched");
    }

    // ── (x) approve: fill-only — a website set between queue time and apply
    //     is never overwritten --
    {
      insertAgent({ id: "wd-race", name: "Nystu Gard", orgNr: "922222222", city: "Alvdal" });
      fixtures.set(
        "https://nystugard.no",
        htmlResponse("<html><body>Nystu Gard i Alvdal — org.nr 922 222 222</body></html>", { finalUrl: "https://nystugard.no" }),
      );
      await callDiscovery({ agentIds: ["wd-race"] });
      assertTrue(!!readQueueRow("wd-race"), "x0: queued");
      testDb.prepare("UPDATE agent_knowledge SET website = 'https://allerede-satt.no' WHERE agent_id = 'wd-race'").run();
      const r = await callApprove({ approvals: [{ agent_id: "wd-race", url: "https://nystugard.no" }], apply: true });
      assertEq(r.body.written_count, 0, "x1: nothing written");
      const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-race");
      assertEq(rej?.reason, "no_longer_blank", "x2: fill-only guard fired");
      const k = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-race'").get() as any;
      assertEq(k.website, "https://allerede-satt.no", "x3: the existing value is untouched");
      // Grep 3-nit (dev-request 2026-08-22-rfb-website-email-selvforsyning):
      // no_longer_blank is permanently unwritable — the queue row must not
      // stay 'pending' to be re-picked and re-rejected by every future call.
      const q = readQueueRow("wd-race");
      assertEq(q.status, "superseded", "x4: no_longer_blank flips the queue row out of pending");
    }

    // ═══ dev-request 2026-08-22-rfb-website-review-auto-approve: server-side
    //     auto-select mode ({"auto": true, "apply"?, "min_confidence"?}) ═══
    //
    // Every earlier test block above ((a)-(x)) has already left assorted
    // 'pending' rows sitting in agents_website_review_queue from its own
    // discovery/approve calls (wd-ok, wd-batch-1, wd-claimed, wd-race,
    // wd-repl-ok, ...) — none of those agent_ids are referenced again after
    // this point in the file (verified: no later block reads their queue row
    // or agent_knowledge state), so this block starts by clearing the queue
    // table to get a clean, deterministic slate for its own confidence-based
    // selection assertions, rather than coupling this block's counts to
    // whatever the earlier discovery-flow tests happened to accumulate.
    testDb.prepare("DELETE FROM agents_website_review_queue").run();

    // ── (aa) auto: default min_confidence (0.95) — selects only the
    //     qualifying row, writes it through the SAME write path as the
    //     manual-approvals branch, leaves the sub-threshold row untouched
    //     and still pending --
    {
      insertAgent({ id: "wd-auto-hi", name: "Auto Høy Konfidens Gard" });
      insertQueueRow({
        id: "q-auto-hi",
        agentId: "wd-auto-hi",
        candidateUrl: "https://autohoeykonfidensgard.no",
        confidence: 0.95,
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      insertAgent({ id: "wd-auto-lo", name: "Auto Lav Konfidens Gard" });
      insertQueueRow({
        id: "q-auto-lo",
        agentId: "wd-auto-lo",
        candidateUrl: "https://autolavkonfidensgard.no",
        confidence: 0.9,
        updatedAt: "2026-08-01T00:00:00.000Z",
      });

      const r = await callApprove({ auto: true, apply: true });
      assertEq(r.status, 200, "aa1: 200");
      assertEq(r.body.mode, "auto", "aa2: response echoes mode: auto");
      assertEq(r.body.min_confidence, 0.95, "aa3: default min_confidence is 0.95 (RFB's own bar, not gårdssalg's 1.0)");
      assertEq(r.body.candidates_considered, 1, "aa4: only the >=0.95 row is considered");
      assertEq(r.body.written_count, 1, "aa5: exactly one write");
      assertTrue(
        r.body.written.some((w: any) => w.agent_id === "wd-auto-hi"),
        "aa6: the qualifying row was written",
      );
      assertTrue(
        !r.body.written.some((w: any) => w.agent_id === "wd-auto-lo"),
        "aa7: the sub-threshold row was NOT auto-selected",
      );

      const kHi = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-auto-hi'").get() as any;
      assertEq(kHi.website, "https://autohoeykonfidensgard.no", "aa8: website column written for the qualifying agent");
      const kLo = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-auto-lo'").get() as any;
      assertTrue(!kLo.website, "aa9: website column untouched for the sub-threshold agent");
      assertEq(readQueueRow("wd-auto-hi").status, "applied", "aa10: qualifying queue row flipped to applied");
      assertEq(readQueueRow("wd-auto-lo").status, "pending", "aa11: sub-threshold queue row still pending");
    }

    // ── (ab) auto: explicit min_confidence — lowering the bar picks up the
    //     row (aa) left behind at 0.90 --
    {
      const r = await callApprove({ auto: true, apply: true, min_confidence: 0.9 });
      assertEq(r.status, 200, "ab1: 200");
      assertEq(r.body.min_confidence, 0.9, "ab2: explicit min_confidence echoed back");
      assertEq(r.body.candidates_considered, 1, "ab3: exactly the one remaining pending row qualifies at 0.90");
      assertEq(r.body.written_count, 1, "ab4: exactly one write");
      assertTrue(
        r.body.written.some((w: any) => w.agent_id === "wd-auto-lo"),
        "ab5: the previously sub-threshold row is now selected and written",
      );
      const kLo = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-auto-lo'").get() as any;
      assertEq(kLo.website, "https://autolavkonfidensgard.no", "ab6: website column written");
      assertEq(readQueueRow("wd-auto-lo").status, "applied", "ab7: queue row flipped to applied");
    }

    // ── (ac) auto: bad min_confidence values -> 400, nothing selected or
    //     written --
    {
      const r1 = await callApprove({ auto: true, min_confidence: "high" });
      assertEq(r1.status, 400, "ac1: non-number min_confidence -> 400");
      assertTrue(typeof r1.body.error === "string" && r1.body.error.includes("min_confidence"), "ac2: error mentions min_confidence");

      const r2 = await callApprove({ auto: true, min_confidence: -0.1 });
      assertEq(r2.status, 400, "ac3: negative min_confidence -> 400");

      const r3 = await callApprove({ auto: true, min_confidence: 1.5 });
      assertEq(r3.status, 400, "ac4: min_confidence > 1 -> 400");

      const r4 = await callApprove({ auto: true, min_confidence: Number.NaN });
      assertEq(r4.status, 400, "ac5: NaN min_confidence -> 400");
    }

    // ── (ad) auto + approvals together -> 400, mutually exclusive --
    {
      const r = await callApprove({
        auto: true,
        approvals: [{ agent_id: "wd-auto-hi", url: "https://autohoeykonfidensgard.no" }],
      });
      assertEq(r.status, 400, "ad1: auto + non-empty approvals -> 400");
      assertTrue(
        typeof r.body.error === "string" && r.body.error.includes("auto") && r.body.error.includes("approvals"),
        "ad2: error names both auto and approvals",
      );
    }

    // ── (ae) auto: empty qualifying set — queue is empty at this point
    //     ((aa)/(ab) applied both rows this block seeded) --
    {
      const r = await callApprove({ auto: true });
      assertEq(r.status, 200, "ae1: 200");
      assertEq(r.body.mode, "auto", "ae2: mode still echoed even with nothing to select");
      assertEq(r.body.candidates_considered, 0, "ae3: nothing qualifies");
      assertEq(r.body.approved_count, 0, "ae4: nothing approved");
      assertEq(r.body.written_count, 0, "ae5: nothing written");
      assertEq(r.body.dry_run, true, "ae6: apply defaults to false/dry-run, same as manual mode");
    }

    // ── (af) auto: cap enforcement — RFB_WD_AUTO_APPROVE_BATCH_CAP (30)
    //     bounds the selected batch even when more rows qualify; dry-run so
    //     no agents/agent_knowledge rows are needed (the write path is never
    //     reached) --
    {
      const total = 35;
      for (let i = 0; i < total; i++) {
        insertQueueRow({
          id: `q-cap-${i}`,
          agentId: `wd-cap-${i}`,
          candidateUrl: `https://capgard${i}.no`,
          confidence: 1.0,
          updatedAt: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
        });
      }

      const r = await callApprove({ auto: true });
      assertEq(r.status, 200, "af1: 200");
      assertEq(r.body.candidates_considered, total, "af2: candidates_considered is the UNCAPPED qualifying count");
      assertEq(r.body.approved_count, RFB_WD_AUTO_APPROVE_BATCH_CAP, "af3: approved/selected batch is capped at RFB_WD_AUTO_APPROVE_BATCH_CAP");
      assertEq(r.body.approved.length, RFB_WD_AUTO_APPROVE_BATCH_CAP, "af4: approved array itself is capped");
    }

    // ── (ag) the existing client-supplied `approvals` mode is unchanged: no
    //     `mode` field in its response, and it is NOT gated by the auto
    //     confidence threshold (a sub-0.95 row can still be approved when
    //     explicitly named) --
    {
      insertAgent({ id: "wd-manual-lowconf", name: "Manuell Lav Konfidens Gard" });
      insertQueueRow({
        id: "q-manual-lowconf",
        agentId: "wd-manual-lowconf",
        candidateUrl: "https://manuelllavkonfidensgard.no",
        confidence: 0.5,
      });

      const r = await callApprove({ approvals: [{ agent_id: "wd-manual-lowconf", url: "https://manuelllavkonfidensgard.no" }] });
      assertEq(r.status, 200, "ag1: 200");
      assertEq(r.body.approved_count, 1, "ag2: approved despite being far below the auto min_confidence default");
      assertEq(r.body.dry_run, true, "ag3: dry-run default, same as before this slice");
      assertTrue(!("mode" in r.body), "ag4: no mode field on the manual-approvals response");
      assertTrue(!("min_confidence" in r.body), "ag5: no min_confidence field on the manual-approvals response");
      assertTrue(!("candidates_considered" in r.body), "ag6: no candidates_considered field on the manual-approvals response");
    }

    // ── (ah) Grep 3-nit (dev-request 2026-08-22-rfb-website-email-selvforsyning):
    //     a no_longer_blank rejection in auto mode must retire the queue row —
    //     otherwise every subsequent auto call re-picks and re-rejects it
    //     forever, even though the outcome can never change --
    {
      // Clean slate — (af)'s cap-enforcement block left 35 confidence-1.0
      // rows 'pending' (it was dry-run, so nothing wrote or superseded them),
      // which would otherwise get swept up alongside this block's own row by
      // the default min_confidence filter. Same precedent as the auto-mode
      // section's own opening DELETE above.
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
      insertAgent({ id: "wd-auto-race", name: "Auto Race Gard" });
      insertQueueRow({
        id: "q-auto-race",
        agentId: "wd-auto-race",
        candidateUrl: "https://autoracegard.no",
        confidence: 1.0,
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      testDb.prepare("UPDATE agent_knowledge SET website = 'https://allerede-satt-auto.no' WHERE agent_id = 'wd-auto-race'").run();

      const r1 = await callApprove({ auto: true, apply: true });
      assertEq(r1.body.candidates_considered, 1, "ah1: the row qualifies and is picked in the first auto call");
      assertTrue(
        r1.body.rejected.some((x: any) => x.agent_id === "wd-auto-race" && x.reason === "no_longer_blank"),
        "ah2: rejected as no_longer_blank",
      );
      assertEq(readQueueRow("wd-auto-race").status, "superseded", "ah3: queue row flipped out of pending");

      const r2 = await callApprove({ auto: true, apply: true });
      assertEq(r2.body.candidates_considered, 0, "ah4: a second auto call no longer even considers the superseded row");
      assertTrue(
        !r2.body.rejected.some((x: any) => x.agent_id === "wd-auto-race"),
        "ah5: never re-rejected — it is not in the pending pool at all, not silently re-approved either",
      );
    }

    // ═══ Skive 6 + 7 (dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype) ═══

    // ── (y) Skive 6: umbrella_type IS NULL filter on the shared rfbWdSelectSql
    //     WHERE — a venue/umbrella row is excluded from default auto-select's
    //     target cohort (never even fetched), a regular producer row
    //     alongside it is still scanned + proposed --
    {
      insertAgent({ id: "wd-umbrella-1", name: "Zqvex Umbrellamarked Torget", umbrellaType: "venue" });
      insertAgent({ id: "wd-regular-included", name: "Zqvex Regularproducer Torget", city: "Testby" });
      fixtures.set(
        "https://zqvexregularproducertorget.no",
        htmlResponse("<html><body>Zqvex Regularproducer Torget ligger i Testby</body></html>", {
          finalUrl: "https://zqvexregularproducertorget.no",
        }),
      );

      const fetchCallsBefore = fetchCalls.length;
      // No agentIds/candidates -> default auto-select path, i.e.
      // selectRfbWebsiteDiscoveryTargets (the exact function rfbWdSelectSql's
      // new umbrella clause and Skive 7's new ORDER BY both apply to). Limit
      // comfortably covers every blank-website eligible row accumulated by
      // this suite so far (well under RFB_WD_HARD_CAP).
      const r = await callDiscovery({ limit: RFB_WD_HARD_CAP });
      assertEq(r.status, 200, "y1: 200");
      const seenIds = new Set<string>([
        ...r.body.proposed.map((p: any) => p.agent_id),
        ...r.body.rejected.map((x: any) => x.agent_id),
      ]);
      assertTrue(!seenIds.has("wd-umbrella-1"), "y2: umbrella row (umbrella_type='venue') never enters the scanned target set");
      assertTrue(
        !fetchCalls.slice(fetchCallsBefore).some((u) => u.includes("umbrellamarked")),
        "y3: umbrella row's guessed candidate host is never fetched — excluded at the SQL layer, not by evidence",
      );
      assertTrue(seenIds.has("wd-regular-included"), "y4: regular producer row (umbrella_type IS NULL) is still scanned — no regression");
      const prop = r.body.proposed.find((p: any) => p.agent_id === "wd-regular-included");
      assertTrue(!!prop, "y5: regular producer row is proposed (verified against its fixture)");
      if (prop) {
        assertEq(prop.candidate_url, "https://zqvexregularproducertorget.no", "y6: proposed candidate_url as expected");
      }
    }

    // ── (z) Skive 7: default auto-select's pick strategy is no longer
    //     purely oldest-first --
    {
      // (z1-z3) Direct confirmation of mechanism (the "simpler" option this
      // route's own dev-request test-coverage instructions call out): the
      // SQL text for selectRfbWebsiteDiscoveryTargets now uses
      // ORDER BY RANDOM(), the old oldest-first-with-LIMIT ordering is gone,
      // and selectRfbWebsiteReplacementTargets's own ordering (aggregator_
      // replace mode, deliberately out of scope for Skive 7) is untouched.
      const fs = require("fs");
      const path = require("path");
      const srcText: string = fs.readFileSync(path.join(__dirname, "admin-rfb-website-discovery.ts"), "utf8");
      assertTrue(srcText.includes("ORDER BY RANDOM() LIMIT ?"), "z1: selectRfbWebsiteDiscoveryTargets's SQL text uses ORDER BY RANDOM()");
      assertTrue(
        !srcText.includes("ORDER BY a.created_at ASC, a.id ASC LIMIT ?"),
        "z2: the old oldest-first-with-LIMIT ordering is gone",
      );
      assertTrue(
        srcText.includes("ORDER BY a.created_at ASC, a.id ASC"),
        "z3: aggregator_replace mode's own ordering (selectRfbWebsiteReplacementTargets) is left untouched",
      );

      // (z4) Functional smoke test: seed one row strictly older than every
      // other eligible row accumulated by this whole suite, plus several
      // strictly newer rows. Under the old ORDER BY a.created_at ASC, a
      // LIMIT-1 auto-select would deterministically return the oldest row
      // on every single call. Under ORDER BY RANDOM(), it should not.
      insertAgent({ id: "wd-pick-oldest", name: "Zqvex Pickstrategy Oldest Gard", city: "Testby", createdAt: "1999-01-01 00:00:00" });
      insertAgent({ id: "wd-pick-new-1", name: "Zqvex Pickstrategy Newone Gard", city: "Testby", createdAt: "2026-08-01 00:00:00" });
      insertAgent({ id: "wd-pick-new-2", name: "Zqvex Pickstrategy Newtwo Gard", city: "Testby", createdAt: "2026-08-05 00:00:00" });
      insertAgent({ id: "wd-pick-new-3", name: "Zqvex Pickstrategy Newthree Gard", city: "Testby", createdAt: "2026-08-10 00:00:00" });
      // No fixtures set for any of these hosts — every attempt is rejected
      // (fetch_failed:http_404, Grep 4f), but that's irrelevant here: the pick
      // strategy only governs WHICH row(s) selectRfbWebsiteDiscoveryTargets
      // returns from the eligible cohort, not whether they later verify.

      const pickedFirst = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const r = await callDiscovery({ limit: 1 });
        const ids = [...r.body.proposed, ...r.body.rejected].map((x: any) => x.agent_id);
        if (ids.length > 0) pickedFirst.add(ids[0]);
      }
      assertTrue(
        !(pickedFirst.size === 1 && pickedFirst.has("wd-pick-oldest")),
        "z4: LIMIT-1 auto-select is not deterministically always the single oldest eligible row across 20 repeated calls",
      );
    }

    // ═══ dev-request 2026-08-14-rfb-wd-headless-fallback: headless-render
    //     fallback for JS-shell candidate pages ═══
    //
    // A "JS shell" fixture: big enough (>= RENDER_ESCALATION_MIN_BYTES),
    // carries a <script>, and its visible text (after gardssalgPageText /
    // visibleTextOf strip the script body) is a few characters — the exact
    // shape shouldEscalateToRender() (services/render-page.ts) looks for.
    // No evidence anywhere in the visible text, so plain-fetch evidence-
    // matching must fail every time this fixture is used.
    const jsShellPadding = "x".repeat(2500);
    function jsShellHtml(): string {
      return `<html><body><script>var pad = "${jsShellPadding}";</script><div id="root">App</div></body></html>`;
    }
    // A genuinely small, static, evidence-free page — no <script> at all —
    // so shouldEscalateToRender() must return false for it (condition 3 in
    // its own contract: no script, no escalation).
    const staticSmallHtml = "<html><body>Parkert side</body></html>";

    // ── (hf-a) flag OFF (default/unset) — fallback never attempted, byte-
    //     identical to today even for a fixture that WOULD escalate if the
    //     flag were on --
    {
      delete process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED;
      let renderCalls = 0;
      setRfbWdRenderPageImplForTesting!(async () => {
        renderCalls++;
        throw new Error("renderPage must never be called while the flag is off");
      });

      insertAgent({ id: "wd-hf-off", name: "Hf Off Gard", orgNr: "911100001", city: "Voss" });
      fixtures.set("https://hfoffgard.no", htmlResponse(jsShellHtml(), { finalUrl: "https://hfoffgard.no" }));

      const r = await callDiscovery({ agentIds: ["wd-hf-off"] });
      assertEq(r.body.proposed.length, 0, "hf-a1: nothing proposed (flag off, unchanged behaviour)");
      const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-hf-off");
      assertEq(rej?.reason, "evidence_mismatch", "hf-a2: same rejection reason as before this slice existed (Grep 4f: evidence_mismatch)");
      assertEq(renderCalls, 0, "hf-a3: renderPage was never invoked");
      assertEq(r.body.headless_fallback_attempted, 0, "hf-a4: headless_fallback_attempted is 0");
      assertEq(r.body.headless_fallback_verified, 0, "hf-a5: headless_fallback_verified is 0");
      assertTrue(!readQueueRow("wd-hf-off"), "hf-a6: nothing queued");

      setRfbWdRenderPageImplForTesting!(null);
    }

    // ── (hf-b) flag ON, plain fetch already verifies — fallback never
    //     attempted (no wasted render on a page that didn't need one) --
    {
      process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED = "true";
      let renderCalls = 0;
      setRfbWdRenderPageImplForTesting!(async () => {
        renderCalls++;
        throw new Error("renderPage must never be called when plain-fetch evidence already verified");
      });

      insertAgent({ id: "wd-hf-plain-ok", name: "Hf Plainok Gard", orgNr: "911100002", city: "Voss" });
      fixtures.set(
        "https://hfplainokgard.no",
        htmlResponse("<html><body>Hf Plainok Gard — org.nr 911 100 002</body></html>", { finalUrl: "https://hfplainokgard.no" }),
      );

      const r = await callDiscovery({ agentIds: ["wd-hf-plain-ok"] });
      assertEq(r.body.proposed.length, 1, "hf-b1: proposed via the plain fetch alone");
      assertEq(renderCalls, 0, "hf-b2: renderPage was never invoked");
      assertEq(r.body.headless_fallback_attempted, 0, "hf-b3: headless_fallback_attempted is 0");
      assertEq(r.body.headless_fallback_verified, 0, "hf-b4: headless_fallback_verified is 0");
    }

    // ── (hf-c) flag ON, plain fetch unverified + shouldEscalateToRender
    //     true — fallback attempted, renders, verifies -> hit returned,
    //     using the RENDERED text/finalUrl --
    {
      process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED = "true";
      let renderCalls = 0;
      setRfbWdRenderPageImplForTesting!(async (url: string) => {
        renderCalls++;
        return {
          ok: true,
          // Grep 4d: unlike fixtures.set()'d plain-fetch content, this
          // literal renderPage-impl return bypasses stubFetch()'s
          // self-reference auto-injection entirely, so the marker is added
          // by hand here — a <link rel="canonical"> carrying the render's
          // own finalUrl, the same realistic idiom a real rendered page
          // would carry.
          html: `<html><head><link rel="canonical" href="${url}"></head><body>Hf Escalates Gard — org.nr 911 100 003</body></html>`,
          text: "Hf Escalates Gard — org.nr 911 100 003",
          finalUrl: url,
          elapsedMs: 42,
        };
      });

      insertAgent({ id: "wd-hf-escalates", name: "Hf Escalates Gard", orgNr: "911100003", city: "Voss" });
      fixtures.set("https://hfescalatesgard.no", htmlResponse(jsShellHtml(), { finalUrl: "https://hfescalatesgard.no" }));

      const r = await callDiscovery({ agentIds: ["wd-hf-escalates"] });
      assertEq(r.body.proposed.length, 1, "hf-c1: proposed via the render fallback");
      const prop = r.body.proposed[0];
      assertEq(prop.agent_id, "wd-hf-escalates", "hf-c2: proposal is for the right agent");
      assertEq(prop.candidate_url, "https://hfescalatesgard.no", "hf-c3: candidate_url from the rendered finalUrl");
      assertEq(prop.evidence.org_nr_found, true, "hf-c4: verified via org_nr found in the RENDERED text");
      assertEq(renderCalls, 1, "hf-c5: renderPage was invoked exactly once");
      assertEq(r.body.headless_fallback_attempted, 1, "hf-c6: headless_fallback_attempted is 1");
      assertEq(r.body.headless_fallback_verified, 1, "hf-c7: headless_fallback_verified is 1");
      const row = readQueueRow("wd-hf-escalates");
      assertTrue(!!row, "hf-c8: a queue row was inserted from the render-verified hit");
      assertEq(row.candidate_url, "https://hfescalatesgard.no", "hf-c9: queue row candidate_url matches");

      setRfbWdRenderPageImplForTesting!(null);
    }

    // ── (hf-d) flag ON, fallback returns renderer_unavailable — treated as
    //     no-candidate, no throw, nothing recorded as a negative signal
    //     against the producer (still falls through to the generic
    //     evidence_mismatch reason, never a renderer-specific one) --
    {
      process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED = "true";
      let renderCalls = 0;
      setRfbWdRenderPageImplForTesting!(async () => {
        renderCalls++;
        return {
          ok: false,
          reason: "renderer_unavailable",
          detail: "PLAYWRIGHT_UNAVAILABLE: playwright-core is not installed in this environment",
          elapsedMs: 3,
        };
      });

      insertAgent({ id: "wd-hf-unavail", name: "Hf Unavail Gard", orgNr: "911100004", city: "Voss" });
      fixtures.set("https://hfunavailgard.no", htmlResponse(jsShellHtml(), { finalUrl: "https://hfunavailgard.no" }));

      let threw = false;
      let r: { status: number; body: any } | undefined;
      try {
        r = await callDiscovery({ agentIds: ["wd-hf-unavail"] });
      } catch {
        threw = true;
      }
      assertTrue(!threw, "hf-d1: renderer_unavailable never throws / never crashes the batch");
      assertEq(r!.body.proposed.length, 0, "hf-d2: nothing proposed");
      const rej = r!.body.rejected.find((x: any) => x.agent_id === "wd-hf-unavail");
      assertEq(rej?.reason, "evidence_mismatch", "hf-d3: generic no-candidate reason, NOT a renderer-specific/negative one");
      assertEq(renderCalls, 1, "hf-d4: renderPage was invoked exactly once");
      assertEq(r!.body.headless_fallback_attempted, 1, "hf-d5: an attempt IS still counted (renderer_unavailable is about the machine, not the site)");
      assertEq(r!.body.headless_fallback_verified, 0, "hf-d6: never counted as a verified flip");
      assertTrue(!readQueueRow("wd-hf-unavail"), "hf-d7: nothing queued");

      setRfbWdRenderPageImplForTesting!(null);
    }

    // ── (hf-e) flag ON, plain fetch unverified but shouldEscalateToRender
    //     is false (a genuinely small static page, no <script>) — fallback
    //     never attempted --
    {
      process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED = "true";
      let renderCalls = 0;
      setRfbWdRenderPageImplForTesting!(async () => {
        renderCalls++;
        throw new Error("renderPage must never be called when shouldEscalateToRender is false");
      });

      insertAgent({ id: "wd-hf-small", name: "Hf Small Gard", orgNr: "911100005", city: "Voss" });
      fixtures.set("https://hfsmallgard.no", htmlResponse(staticSmallHtml, { finalUrl: "https://hfsmallgard.no" }));

      const r = await callDiscovery({ agentIds: ["wd-hf-small"] });
      assertEq(r.body.proposed.length, 0, "hf-e1: nothing proposed");
      const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-hf-small");
      assertEq(rej?.reason, "evidence_mismatch", "hf-e2: rejected exactly as before this slice existed (Grep 4f: evidence_mismatch)");
      assertEq(renderCalls, 0, "hf-e3: renderPage was never invoked — not a JS-shell shape");
      assertEq(r.body.headless_fallback_attempted, 0, "hf-e4: headless_fallback_attempted is 0");
      assertEq(r.body.headless_fallback_verified, 0, "hf-e5: headless_fallback_verified is 0");

      setRfbWdRenderPageImplForTesting!(null);
      delete process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════
    // dev-request 2026-08-22-rfb-website-email-selvforsyning, punkt 4b —
    // knowledge-row creation for the auto-select/blank-mode cohort
    // (ensureRfbKnowledgeRowsForAutoSelectCohort), mirroring the safety net
    // ensureKnowledgeRowForExternalCandidate already gives the external-
    // candidates path, but for the batch path.
    // ════════════════════════════════════════════════════════════════════

    // ── (kr) a producer agent seeded with NO agent_knowledge row at all is
    //     invisible to rfbWdSelectSql's INNER JOIN until a blank-mode
    //     auto-select call backfills it; the response reports how many rows
    //     it created, and a repeat call is idempotent (INSERT OR IGNORE) --
    {
      // insertAgent() always creates the agent_knowledge row alongside the
      // agents row, so this seeds the `agents` row directly, mirroring
      // insertAgent()'s own INSERT exactly, MINUS the agent_knowledge insert
      // — the one and only way in this suite to reach the state this dev-
      // request measured (a producer with literally no knowledge row).
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, city, vertical_id, created_at
         ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?)`,
      ).run(
        "wd-no-knowledge-row", "Zqvex Kunnskapsloes Gard", "producer", "key-wd-no-knowledge-row",
        null, "Testby", "rfb", "2026-01-01 00:00:00",
      );
      // gardssalgWebsiteCandidateHosts("Zqvex Kunnskapsloes Gard")'s first
      // (and here, only-fixtured) guess — matching evidence so the agent, if
      // actually scanned, is proposed rather than merely rejected-but-tried.
      // This is the crux of the reviewer finding: without the
      // verification_status fix, this agent's own knowledge-less row is
      // invisible to selectRfbWebsiteDiscoveryTargets's INNER JOIN, so no
      // fetch to this host ever happens even though the row exists.
      fixtures.set(
        "https://zqvexkunnskapsloesgard.no",
        htmlResponse("<html><body>Zqvex Kunnskapsloes Gard ligger i Testby</body></html>", {
          finalUrl: "https://zqvexkunnskapsloesgard.no",
        }),
      );

      const before = testDb.prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = ?").get("wd-no-knowledge-row");
      assertTrue(!before, "kr0: setup — the agent starts with no agent_knowledge row at all");

      const r1 = await callDiscovery({ limit: RFB_WD_HARD_CAP });
      assertEq(r1.status, 200, "kr1: 200");
      const after = testDb.prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = ?").get("wd-no-knowledge-row");
      assertTrue(!!after, "kr2: the agent now has an agent_knowledge row after a blank-mode auto-select call");
      assertTrue(
        typeof r1.body.knowledge_rows_created === "number" && r1.body.knowledge_rows_created >= 1,
        "kr3: knowledge_rows_created is >= 1 in the response",
      );
      // The actual gap the reviewer found: a row being CREATED is not the
      // same as the row's agent being SELECTABLE in that same call. Prove
      // the backfilled agent was really scanned (present in proposed or
      // rejected — not silently absent from both), same convention as (y)'s
      // seenIds check above.
      const seenIdsKr = new Set<string>([
        ...r1.body.proposed.map((p: any) => p.agent_id),
        ...r1.body.rejected.map((x: any) => x.agent_id),
      ]);
      assertTrue(
        seenIdsKr.has("wd-no-knowledge-row"),
        "kr3b: the backfilled agent is NOT silently invisible — it was actually scanned as a target in this same call",
      );
      const propKr = r1.body.proposed.find((p: any) => p.agent_id === "wd-no-knowledge-row");
      assertTrue(!!propKr, "kr3c: the backfilled agent is proposed (verified against its fixture)");
      if (propKr) {
        assertEq(propKr.candidate_url, "https://zqvexkunnskapsloesgard.no", "kr3d: proposed candidate_url as expected");
      }

      // Idempotent: a second blank-mode call must not double-count (or
      // double-insert) the same, now-already-has-a-row agent — INSERT OR
      // IGNORE really is doing the ignoring.
      const knowledgeRowCountBefore = (testDb.prepare("SELECT COUNT(*) AS c FROM agent_knowledge").get() as any).c;
      const r2 = await callDiscovery({ limit: RFB_WD_HARD_CAP });
      const knowledgeRowCountAfter = (testDb.prepare("SELECT COUNT(*) AS c FROM agent_knowledge").get() as any).c;
      assertEq(knowledgeRowCountAfter, knowledgeRowCountBefore, "kr4: a second call creates no additional agent_knowledge rows");
      assertEq(r2.body.knowledge_rows_created, 0, "kr5: the second call's knowledge_rows_created is 0 (nothing left to backfill)");
    }

    // ── (kr-umbrella) regression: ensureRfbKnowledgeRowsForAutoSelectCohort's
    //     batch INSERT...SELECT must mirror rfbWdSelectSql's own
    //     `umbrella_type IS NULL` exclusion — an umbrella/venue agent with NO
    //     agent_knowledge row must NOT get one manufactured by the blank-mode
    //     backfill (it would otherwise land in the platform-wide verifier's
    //     pending_verify cohort despite being able to structurally never have
    //     a producer website) --
    {
      // Same raw-INSERT-minus-agent_knowledge pattern as (kr0) above, so this
      // agent starts knowledge-less; umbrella_type is then set the same way
      // insertAgent()'s umbrellaType option does (UPDATE after the fact,
      // since it isn't in the base column list).
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, city, vertical_id, created_at
         ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?)`,
      ).run(
        "wd-umbrella-no-knowledge-row", "Zqvex Umbrellalos Torget", "producer", "key-wd-umbrella-no-knowledge-row",
        null, "Testby", "rfb", "2026-01-01 00:00:00",
      );
      testDb.prepare(`UPDATE agents SET umbrella_type = ? WHERE id = ?`).run("venue", "wd-umbrella-no-knowledge-row");

      const beforeU = testDb
        .prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = ?")
        .get("wd-umbrella-no-knowledge-row");
      assertTrue(!beforeU, "kru0: setup — the umbrella agent starts with no agent_knowledge row at all");

      const rU = await callDiscovery({ limit: RFB_WD_HARD_CAP });
      assertEq(rU.status, 200, "kru1: 200");

      const afterU = testDb
        .prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = ?")
        .get("wd-umbrella-no-knowledge-row");
      assertTrue(
        !afterU,
        "kru2: the umbrella agent still has NO agent_knowledge row after a blank-mode auto-select call — the batch backfill did not manufacture one for it",
      );

      const seenIdsKru = new Set<string>([
        ...rU.body.proposed.map((p: any) => p.agent_id),
        ...rU.body.rejected.map((x: any) => x.agent_id),
      ]);
      assertTrue(
        !seenIdsKru.has("wd-umbrella-no-knowledge-row"),
        "kru3: the umbrella agent was never scanned as a target — excluded at the batch-insert layer, not just the SELECT layer",
      );
    }

    // ── (kr-agg) regression: aggregator_replace mode never invokes the batch
    //     knowledge-row backfill (it requires an already-non-blank current
    //     website, so a knowledge-less agent could never qualify there
    //     anyway) — the response always reports knowledge_rows_created: 0 --
    {
      const r = await callDiscovery({ mode: "aggregator_replace", limit: 1 });
      assertEq(r.body.knowledge_rows_created, 0, "kr-agg1: aggregator_replace mode reports knowledge_rows_created: 0");
    }

    // ════════════════════════════════════════════════════════════════════
    // dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 5 — direct
    // evaluateRfbWebsiteCandidate() coverage (AC2/AC3), called WITHOUT going
    // through the router at all — proves the extracted function is usable
    // standalone by a second caller (admin-bm-producer-harvest.ts), not just
    // reachable through this route's own handler.
    // ════════════════════════════════════════════════════════════════════

    // ── AC2: proposed for a fixture candidate whose fetched page carries
    //     matching evidence, and a row lands in agents_website_review_queue
    //     (DB read-back, not just the return value) with the expected
    //     reason. ─────────────────────────────────────────────────────────
    {
      insertAgent({ id: "eval-ac2", name: "Direktekalt Gard", orgNr: "955555555", city: "Rana" });
      fixtures.set(
        "https://direktekaltgard.no",
        htmlResponse("<html><body>Direktekalt Gard — org.nr 955 555 555</body></html>", {
          finalUrl: "https://direktekaltgard.no",
        }),
      );

      const outcome = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: "eval-ac2", url: "https://direktekaltgard.no" },
        rfbWdExistingWebsiteHosts(testDb as any),
        new Set<string>(),
        { attempted: 0, verified: 0 },
        "eval-ac2-batch",
      );
      assertEq(outcome.outcome, "proposed", "ac2: direct call returns proposed for a matching-evidence fixture");
      assertTrue(
        outcome.outcome === "proposed" && outcome.candidate_url === "https://direktekaltgard.no",
        "ac2: proposed candidate_url is the fetched origin",
      );

      const row = readQueueRow("eval-ac2");
      assertTrue(!!row, "ac2: a queue row was inserted (DB read-back)");
      assertEq(row?.status, "pending", "ac2: queue row status is 'pending'");
      assertEq(
        row?.reason,
        "website_discovery_candidate_external",
        "ac2: queue row reason is 'website_discovery_candidate_external'",
      );
    }

    // ── AC3: already_has_website, WITHOUT any fetch/queue-write, when the
    //     target agent's agent_knowledge.website is already non-blank. ────
    {
      insertAgent({
        id: "eval-ac3",
        name: "Har Alt Nettside Gard",
        orgNr: "955555556",
        city: "Rana",
        website: "https://haralt.no",
      });
      const fetchCallsBefore = fetchCalls.length;

      const outcome = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: "eval-ac3", url: "https://some-candidate.no" },
        rfbWdExistingWebsiteHosts(testDb as any),
        new Set<string>(),
        { attempted: 0, verified: 0 },
        "eval-ac3-batch",
      );
      assertEq(
        outcome.outcome,
        "already_has_website",
        "ac3: direct call returns already_has_website when agent_knowledge.website is already non-blank",
      );
      assertEq(fetchCalls.length, fetchCallsBefore, "ac3: zero fetch calls when the agent already has a website");
      assertTrue(!readQueueRow("eval-ac3"), "ac3: nothing queued for an agent that already has a website");
    }

    // ── (s) tier-2 (Brave Search) fallback leg ───────────────────────────
    // dev-requests/2026-08-24-... (Grep 2, this slice): mirrors
    // admin-dental-hjemmeside-discovery.test.ts's own (q) block idioms —
    // a FIFO queue of BraveResult[] fed through __setRfbWdSearchForTesting,
    // never touching the network. Every clinic^H^H^Hproducer below has NO
    // fixture registered for any of its tier-1 name-guessed hosts, so tier 1
    // always misses first (fetch_failed:http_404) — tier 2 is what's under
    // test.
    {
      const { gardssalgWebsiteCandidateHosts } = require("../services/experience-store") as
        typeof import("../services/experience-store");
      const searchCalls: string[] = [];
      const searchResponseQueue: Array<Array<{ title: string; url: string; description: string }>> = [];
      setRfbWdSearchForTesting!(async (query: string) => {
        searchCalls.push(query);
        const next = searchResponseQueue.shift();
        if (next === undefined) return [];
        return next;
      });

      // (s1) tier 1 exhausted (no fixtures for any guessed host) + tier-2
      // mock returns a hit that verifies via org_nr on the (stubbed) page ->
      // proposed, search_attempted:true, winning host is the SEARCH result's
      // host, not a tier-1 name-guessed one.
      insertAgent({ id: "wd-s1", name: "Uoppdaget Gardsprodukter AS", orgNr: "977100001", city: "Bodø" });
      fixtures.set(
        "https://faktiskhjemmeside.no",
        htmlResponse("<html><body>Uoppdaget Gardsprodukter — org.nr 977 100 001</body></html>", {
          finalUrl: "https://faktiskhjemmeside.no",
        }),
      );
      searchResponseQueue.push([
        { title: "Uoppdaget Gardsprodukter", url: "https://faktiskhjemmeside.no", description: "Gardsprodukter fra Bodø" },
      ]);

      const rS1 = await callDiscovery({ agentIds: ["wd-s1"] });
      assertEq(rS1.body.proposed.length, 1, "s1a: proposed via tier 2 after tier 1 exhausted");
      const propS1 = rS1.body.proposed[0];
      assertEq(propS1.agent_id, "wd-s1", "s1b: proposal is for the right agent");
      assertEq(propS1.candidate_url, "https://faktiskhjemmeside.no", "s1c: winning host is the SEARCH result's host, not a tier-1 name-guess");
      assertTrue(
        !gardssalgWebsiteCandidateHosts("Uoppdaget Gardsprodukter AS").some((h) => propS1.candidate_url.includes(h)),
        "s1d: the winning host is not among tier 1's own name-guessed candidates",
      );
      assertEq(propS1.evidence.org_nr_found, true, "s1e: verified via org_nr, same evidence contract as tier 1");
      assertEq(propS1.search_attempted, true, "s1f: search_attempted:true on a row where tier 2 actually ran");
      {
        const row = readQueueRow("wd-s1");
        assertTrue(!!row, "s1g: a queue row was inserted");
        assertEq(row.candidate_url, "https://faktiskhjemmeside.no", "s1h: queue row candidate_url is the search-discovered host");
      }

      // (s2) tier 1 finds a hit directly -> tier-2 mock is NEVER called
      // (proves the gate is "only when tier 1 exhausted", not "always run").
      insertAgent({ id: "wd-s2", name: "Nordvik Gardsysteri AS", orgNr: "977100002", city: "Namsos" });
      fixtures.set(
        "https://nordvikgardsysteri.no",
        htmlResponse("<html><body>Nordvik Gardsysteri — org.nr 977 100 002</body></html>", {
          finalUrl: "https://nordvikgardsysteri.no",
        }),
      );
      const searchCallsBeforeS2 = searchCalls.length;

      const rS2 = await callDiscovery({ agentIds: ["wd-s2"] });
      assertEq(rS2.body.proposed.length, 1, "s2a: proposed via tier 1 directly");
      assertEq(rS2.body.proposed[0].candidate_url, "https://nordvikgardsysteri.no", "s2b: winning host is tier 1's own guessed host");
      assertEq(rS2.body.proposed[0].search_attempted, false, "s2c: search_attempted:false — tier 2 never ran");
      assertEq(searchCalls.length, searchCallsBeforeS2, "s2d: zero NEW search calls recorded — tier 2 was never invoked");

      // (s3) no key/override configured (override reset to null, Brave env
      // vars unset) -> route behaves exactly as before this change
      // (tier-1-only), no error, search_attempted === false — proves the
      // silent-skip contract.
      setRfbWdSearchForTesting!(null);
      delete process.env.BRAVE_API_KEY;
      delete process.env.BRAVE_SEARCH_API_KEY;
      const searchCallsBeforeS3 = searchCalls.length;
      insertAgent({ id: "wd-s3", name: "Uskrevet Gardsbutikk AS", orgNr: "977100003", city: "Alta" });
      // No fixtures for any of this producer's tier-1 candidate hosts — the
      // stub fetch falls through to notFoundResponse() (HTTP 404) for every
      // one, exactly as (c2) above.

      const rS3 = await callDiscovery({ agentIds: ["wd-s3"] });
      assertEq(rS3.body.proposed.length, 0, "s3a: nothing proposed — unwired tier 2 changes nothing about tier 1's own outcome");
      assertEq(rS3.body.rejected.length, 1, "s3b: one rejection, exactly as tier-1-only behaviour before this change");
      assertEq(rS3.body.rejected[0].reason, "fetch_failed:http_404", "s3c: rejection reason is tier 1's own, unaffected by tier 2");
      assertEq(rS3.body.rejected[0].search_attempted, false, "s3d: search_attempted === false — the silent-skip contract");
      assertEq(searchCalls.length, searchCallsBeforeS3, "s3e: zero search calls — tier 2 never even attempted with no key/override");
      assertTrue(!readQueueRow("wd-s3"), "s3f: nothing queued");

      // (s4) tier-2 mock THROWS (simulated Brave API failure) -> the row is
      // rejected exactly as it would be today (no candidate found via tier
      // 2), NOT a 500 from the route — proves the fail-soft/no-retry
      // contract. A second row in the SAME batch (a normal tier-1 hit)
      // proves the rest of the batch still completes.
      setRfbWdSearchForTesting!(async (query: string) => {
        searchCalls.push(query);
        throw new Error("simulated Brave API failure");
      });
      insertAgent({ id: "wd-s4", name: "Feilsoek Gardsvarer AS", orgNr: "977100004", city: "Tromsø" });
      insertAgent({ id: "wd-s4b", name: "Solvik Gardsysteri AS", orgNr: "977100005", city: "Kirkenes" });
      fixtures.set(
        "https://solvikgardsysteri.no",
        htmlResponse("<html><body>Solvik Gardsysteri — org.nr 977 100 005</body></html>", {
          finalUrl: "https://solvikgardsysteri.no",
        }),
      );

      const rS4 = await callDiscovery({ agentIds: ["wd-s4", "wd-s4b"] });
      assertEq(rS4.status, 200, "s4a: a thrown search call never propagates as a 500 — the route still answers 200");
      const rejS4 = rS4.body.rejected.find((r: any) => r.agent_id === "wd-s4");
      assertTrue(!!rejS4, "s4b: wd-s4 is rejected (tier 2 threw, found nothing) rather than erroring the whole call");
      assertEq(rejS4?.reason, "fetch_failed:http_404", "s4c: rejection reason is tier 1's own original reason, unaffected by the tier-2 throw");
      assertEq(rejS4?.search_attempted, true, "s4d: search_attempted:true — tier 2 WAS invoked, it just threw");
      assertTrue(!readQueueRow("wd-s4"), "s4e: nothing queued for wd-s4");
      const propS4b = rS4.body.proposed.find((r: any) => r.agent_id === "wd-s4b");
      assertTrue(!!propS4b, "s4f: the REST of the batch (wd-s4b, a normal tier-1 hit) still completes despite wd-s4's tier-2 throw");
      assertEq(propS4b?.candidate_url, "https://solvikgardsysteri.no", "s4g: wd-s4b proposed via its own tier-1 hit");

      setRfbWdSearchForTesting!(null);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Grep 3 slice 2 (dev-request 2026-08-24-grep3-website-judge-tier):
    // POST /admin/rfb-website-review-judge — the [0.90, 0.95) LLM-judge
    // tier — and GET /admin/rfb-website-review-queue-staleness.
    //
    // globalThis.fetch is reused for the judge's own Anthropic call: it is
    // still keyed off the `fixtures` map by exact URL string (same
    // stubFetch() convention as every block above), so a fixture at
    // "https://api.anthropic.com/v1/messages" — the exact endpoint
    // judgeContactCandidate (src/services/contact-candidate-judge.ts)
    // fetches — drives the mocked judge response, mirroring both this
    // file's own fetch-mocking convention and contact-candidate-judge.
    // test.ts's own (globalThis.fetch stubbed, JSON body shaped
    // {content:[{type:"text", text:"GODKJENN\n..."}]}).
    // ═══════════════════════════════════════════════════════════════════

    function judgeApiResponse(text: string): Response {
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text }] }),
      } as unknown as Response;
    }

    const postJudge = getHandler("post", "/rfb-website-review-judge");
    const getStaleness = getHandler("get", "/rfb-website-review-queue-staleness");
    async function callJudge(
      body: Record<string, unknown> = {},
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postJudge({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }
    async function callStaleness(
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await getStaleness({ headers, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── rfbWdQueueP95AgeDays: pure unit tests (no DB, no HTTP) ──────────────
    {
      assertEq(rfbWdQueueP95AgeDays([]), null, "p95-1: empty array -> null");
      assertEq(rfbWdQueueP95AgeDays([7]), 7, "p95-2: single value -> that value");
      // Hand-computed: ages 1..20 ascending (n=20) -> idx = ceil(0.95*20)-1
      // = ceil(19)-1 = 18 -> the 19th value (0-indexed 18) = 19.
      const oneToTwenty = Array.from({ length: 20 }, (_, i) => i + 1);
      assertEq(rfbWdQueueP95AgeDays(oneToTwenty), 19, "p95-3: 1..20 ascending -> p95 is 19 (hand-computed)");
      // Hand-computed: n=4, idx = ceil(0.95*4)-1 = ceil(3.8)-1 = 4-1 = 3 ->
      // the max (small-n edge case, still exercises the formula honestly).
      assertEq(rfbWdQueueP95AgeDays([10, 20, 30, 40]), 40, "p95-4: n=4 -> idx 3 -> the max value");
    }

    // ═══ POST /admin/rfb-website-review-judge ═══
    //
    // Clean slate — earlier blocks in this file left assorted 'pending'/
    // 'applied'/'superseded' rows behind; none are referenced again after
    // this point, so this section starts from an empty queue for
    // deterministic band-selection and still_pending counts, same
    // convention as the (aa)-(ac) auto-approve block above.
    testDb.prepare("DELETE FROM agents_website_review_queue").run();

    // ── auth ──
    {
      const r = await callJudge({}, {});
      assertEq(r.status, 403, "jg-auth: POST without X-Admin-Key -> 403");
    }

    // ── (jg-a) approve path: GODKJENN -> writes through the SAME
    //     applyRfbAgentWebsite path the >=0.95 auto=true tier uses, queue
    //     row lands in the IDENTICAL terminal status ('applied') asserted
    //     by (u6)/(aa10)/(ab7) above ──
    {
      insertAgent({ id: "wd-jg-ok", name: "Solbakken Gardsutsalg AS" });
      insertQueueRow({
        id: "q-jg-ok",
        agentId: "wd-jg-ok",
        candidateUrl: "https://solbakkengardsutsalg.no",
        confidence: 0.92,
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      fixtures.set(
        "https://api.anthropic.com/v1/messages",
        judgeApiResponse("GODKJENN\nDette er en plausibel egen nettside for produsenten."),
      );

      const r = await callJudge({});
      assertEq(r.status, 200, "jg-a1: 200");
      assertEq(r.body.processed, 1, "jg-a2: exactly one row processed");
      assertEq(r.body.approved, 1, "jg-a3: exactly one approved");
      assertEq(r.body.rejected, 0, "jg-a4: nothing rejected");
      assertEq(r.body.still_pending, 0, "jg-a5: nothing left pending in-band");
      assertEq(r.body.results[0]?.agent_id, "wd-jg-ok", "jg-a6: result is for the right agent");
      assertEq(r.body.results[0]?.verdict, "GODKJENN", "jg-a7: result verdict is GODKJENN");

      const k = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-jg-ok'").get() as any;
      assertEq(k.website, "https://solbakkengardsutsalg.no", "jg-a8: website column written via applyRfbAgentWebsite");
      const q = testDb.prepare("SELECT status FROM agents_website_review_queue WHERE agent_id = 'wd-jg-ok'").get() as any;
      assertEq(q.status, "applied", "jg-a9: queue row flipped to 'applied' — the SAME terminal status the auto=true tier produces");
      const audit = testDb
        .prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = 'wd-jg-ok' AND field_name = 'website'")
        .get() as any;
      assertTrue(!!audit, "jg-a10: agent_knowledge_audit row appended (same write path as the >=0.95 tier)");
    }

    // ── (jg-b) reject path: AVVIS -> row stays 'pending', reason appended,
    //     no write ──
    {
      // (jg-a)'s row is now 'applied' (excluded by the route's own WHERE
      // status='pending'), but a rejected row from a later block would
      // stay 'pending' and accumulate into the next block's selection —
      // start each isolated sub-block from an empty queue so `processed`
      // stays exactly 1 per block, same discipline as the (aa)-(ac) and
      // jg-f blocks' own DELETE.
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
      insertAgent({ id: "wd-jg-rej", name: "Nordheim Gardsprodukter AS" });
      insertQueueRow({
        id: "q-jg-rej",
        agentId: "wd-jg-rej",
        candidateUrl: "https://nordheimgardsprodukter.no",
        confidence: 0.9,
        updatedAt: "2026-08-01T00:00:01.000Z",
      });
      fixtures.set(
        "https://api.anthropic.com/v1/messages",
        judgeApiResponse("AVVIS\nDette ser ut som generisk sidestøy, ikke ekte nettside-eierskap."),
      );

      const r = await callJudge({});
      assertEq(r.body.processed, 1, "jg-b1: one row processed");
      assertEq(r.body.approved, 0, "jg-b2: nothing approved");
      assertEq(r.body.rejected, 1, "jg-b3: one rejected");
      assertEq(r.body.results[0]?.verdict, "AVVIS", "jg-b4: result verdict is AVVIS");

      const q = testDb
        .prepare("SELECT status, reason FROM agents_website_review_queue WHERE agent_id = 'wd-jg-rej'")
        .get() as any;
      assertEq(q.status, "pending", "jg-b5: status column untouched — still 'pending'");
      assertTrue(
        typeof q.reason === "string" && q.reason.includes("LLM judge AVVIS"),
        "jg-b6: reason column carries the judge's verdict",
      );
      const k = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-jg-rej'").get() as any;
      assertTrue(!k.website, "jg-b7: website column still blank — no write");
    }

    // ── (jg-c) fail-closed path: a judge-side failure (simulated network
    //     throw) resolves EXACTLY like a reject — no write, status
    //     untouched, reason appended ──
    {
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
      insertAgent({ id: "wd-jg-fail", name: "Steinbru Gardsmat AS" });
      insertQueueRow({
        id: "q-jg-fail",
        agentId: "wd-jg-fail",
        candidateUrl: "https://steinbrugardsmat.no",
        confidence: 0.93,
        updatedAt: "2026-08-01T00:00:02.000Z",
      });
      globalThis.fetch = (async (url: any) => {
        if (String(url) === "https://api.anthropic.com/v1/messages") {
          throw new Error("simulated network failure");
        }
        return notFoundResponse();
      }) as unknown as typeof fetch;

      const r = await callJudge({});
      assertEq(r.body.processed, 1, "jg-c1: one row processed");
      assertEq(r.body.approved, 0, "jg-c2: nothing approved");
      assertEq(r.body.rejected, 1, "jg-c3: fail-closed counts as rejected");
      const q = testDb
        .prepare("SELECT status, reason FROM agents_website_review_queue WHERE agent_id = 'wd-jg-fail'")
        .get() as any;
      assertEq(q.status, "pending", "jg-c4: status untouched on fail-closed, same as a plain reject");
      assertTrue(typeof q.reason === "string" && q.reason.length > 0, "jg-c5: reason column carries the fail-closed note");
      const k = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'wd-jg-fail'").get() as any;
      assertTrue(!k.website, "jg-c6: website column still blank — no write");

      // Restore the URL-keyed stub for the remaining blocks.
      globalThis.fetch = stubFetch();
    }

    // ── (jg-d) deterministic backstop short-circuit: a structurally
    //     defective candidate (favicon path) never spends an LLM call ──
    {
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
      insertAgent({ id: "wd-jg-backstop", name: "Favikon Gardsbutikk AS" });
      insertQueueRow({
        id: "q-jg-backstop",
        agentId: "wd-jg-backstop",
        candidateUrl: "https://favikongardsbutikk.no/favicon.ico",
        confidence: 0.91,
        updatedAt: "2026-08-01T00:00:03.000Z",
      });
      globalThis.fetch = (async () => {
        throw new Error("jg-d: the LLM judge must NOT be called for a backstop-rejected candidate");
      }) as unknown as typeof fetch;

      const r = await callJudge({});
      assertEq(r.body.rejected, 1, "jg-d1: rejected via the cheap backstop, not the LLM");
      assertEq(r.body.results[0]?.verdict, "AVVIS", "jg-d2: verdict is AVVIS");
      assertTrue(
        (r.body.results[0]?.reason as string).includes("judge backstop AVVIS"),
        "jg-d3: reason attributes the rejection to the backstop classifier, not the LLM",
      );
      const q = testDb
        .prepare("SELECT status FROM agents_website_review_queue WHERE agent_id = 'wd-jg-backstop'")
        .get() as any;
      assertEq(q.status, "pending", "jg-d4: status untouched");

      globalThis.fetch = stubFetch();
    }

    // ── (jg-e) limit: 0 — a safe true no-op: zero rows touched, queue
    //     unchanged, no fetch calls at all ──
    {
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
      insertAgent({ id: "wd-jg-zero", name: "Nullgrense Gardsprodukter AS" });
      insertQueueRow({
        id: "q-jg-zero",
        agentId: "wd-jg-zero",
        candidateUrl: "https://nullgrensegardsprodukter.no",
        confidence: 0.9,
        updatedAt: "2026-08-01T00:00:04.000Z",
      });
      globalThis.fetch = (async () => {
        throw new Error("jg-e: limit:0 must query and mutate nothing — no fetch call of any kind");
      }) as unknown as typeof fetch;

      const r = await callJudge({ limit: 0 });
      assertEq(r.status, 200, "jg-e1: 200");
      assertEq(r.body, { processed: 0, approved: 0, rejected: 0, still_pending: 0, results: [] }, "jg-e2: exact no-op shape");
      const q = testDb
        .prepare("SELECT status, reason FROM agents_website_review_queue WHERE agent_id = 'wd-jg-zero'")
        .get() as any;
      assertEq(q.status, "pending", "jg-e3: row completely untouched");

      globalThis.fetch = stubFetch();
    }

    // ── (jg-f) confidence-band boundary: rows below 0.90 or at/above 0.95
    //     are never selected by this route (0.95+ is the OTHER route's
    //     job) ──
    {
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
      insertAgent({ id: "wd-jg-below", name: "Under Terskel AS" });
      insertQueueRow({ id: "q-jg-below", agentId: "wd-jg-below", candidateUrl: "https://underterskel.no", confidence: 0.89 });
      insertAgent({ id: "wd-jg-above", name: "Over Terskel AS" });
      insertQueueRow({ id: "q-jg-above", agentId: "wd-jg-above", candidateUrl: "https://overterskel.no", confidence: 0.95 });
      globalThis.fetch = (async () => {
        throw new Error("jg-f: neither out-of-band row should ever reach the judge");
      }) as unknown as typeof fetch;

      const r = await callJudge({});
      assertEq(r.body.processed, 0, "jg-f1: neither out-of-band row is selected");
      assertEq(RFB_WD_JUDGE_MIN_CONFIDENCE, 0.9, "jg-f2: band floor is 0.90 (inclusive)");
      assertEq(RFB_WD_JUDGE_MAX_CONFIDENCE_EXCLUSIVE, 0.95, "jg-f3: band ceiling is 0.95 (exclusive)");

      globalThis.fetch = stubFetch();
    }

    // ═══ GET /admin/rfb-website-review-queue-staleness ═══
    testDb.prepare("DELETE FROM agents_website_review_queue").run();

    // ── auth ──
    {
      const r = await callStaleness({});
      assertEq(r.status, 403, "st-auth: GET without X-Admin-Key -> 403");
    }

    // ── (st-a) empty queue -> zeroed report, null p95 ──
    {
      const r = await callStaleness();
      assertEq(r.status, 200, "st-a1: 200");
      assertEq(r.body.count, 0, "st-a2: count 0");
      assertEq(r.body.stale_count, 0, "st-a3: stale_count 0");
      assertEq(r.body.stale_threshold_days, RFB_WD_REVIEW_QUEUE_STALE_DAYS, "st-a4: threshold echoed (2 days, this queue's own 48h SLA)");
      assertEq(r.body.p95_age_days, null, "st-a5: p95_age_days is null on an empty queue");
      assertEq(r.body.oldest_first, [], "st-a6: oldest_first empty");
    }

    // ── (st-b) three pending rows at known ages (1, 3, 5 days old) ──
    {
      function daysAgoSqlite(days: number): string {
        return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
      }
      insertAgent({ id: "wd-st-1", name: "En Dag Gard AS" });
      testDb.prepare(
        `INSERT INTO agents_website_review_queue (id, agent_id, agent_name, candidate_url, status, created_at, updated_at)
         VALUES ('q-st-1', 'wd-st-1', 'En Dag Gard AS', 'https://endaggard.no', 'pending', ?, ?)`,
      ).run(daysAgoSqlite(1), daysAgoSqlite(1));
      insertAgent({ id: "wd-st-3", name: "Tre Dager Gard AS" });
      testDb.prepare(
        `INSERT INTO agents_website_review_queue (id, agent_id, agent_name, candidate_url, status, created_at, updated_at)
         VALUES ('q-st-3', 'wd-st-3', 'Tre Dager Gard AS', 'https://tredagergard.no', 'pending', ?, ?)`,
      ).run(daysAgoSqlite(3), daysAgoSqlite(3));
      insertAgent({ id: "wd-st-5", name: "Fem Dager Gard AS" });
      testDb.prepare(
        `INSERT INTO agents_website_review_queue (id, agent_id, agent_name, candidate_url, status, created_at, updated_at)
         VALUES ('q-st-5', 'wd-st-5', 'Fem Dager Gard AS', 'https://femdagergard.no', 'pending', ?, ?)`,
      ).run(daysAgoSqlite(5), daysAgoSqlite(5));
      // A non-pending row (already applied) must never appear in the report.
      insertAgent({ id: "wd-st-applied", name: "Alt Behandlet Gard AS" });
      testDb.prepare(
        `INSERT INTO agents_website_review_queue (id, agent_id, agent_name, candidate_url, status, created_at, updated_at)
         VALUES ('q-st-applied', 'wd-st-applied', 'Alt Behandlet Gard AS', 'https://altbehandletgard.no', 'applied', ?, ?)`,
      ).run(daysAgoSqlite(10), daysAgoSqlite(10));

      const r = await callStaleness();
      assertEq(r.body.count, 3, "st-b1: count 3 — the applied row is excluded");
      // threshold is 2 days: the 1-day row is fresh, the 3- and 5-day rows
      // are stale.
      assertEq(r.body.stale_count, 2, "st-b2: stale_count 2 (3-day and 5-day rows)");
      // ages ascending [1,3,5], n=3 -> idx = ceil(0.95*3)-1 = ceil(2.85)-1
      // = 3-1 = 2 -> ages[2] = 5 (hand-computed, matches rfbWdQueueP95AgeDays
      // unit test p95-4's same small-n-collapses-to-max shape).
      assertEq(r.body.p95_age_days, 5, "st-b3: p95_age_days is 5 (hand-computed)");
      assertEq(r.body.oldest_first.length, 3, "st-b4: oldest_first has all 3 pending rows (well under the ~20 cap)");
      assertEq(r.body.oldest_first[0]?.agent_id, "wd-st-5", "st-b5: oldest row (5 days) is first");
      assertEq(r.body.oldest_first[0]?.age_days, 5, "st-b6: oldest row's age_days is 5");
      assertEq(r.body.oldest_first[2]?.agent_id, "wd-st-1", "st-b7: youngest (1 day) row is last");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Grep 4d (dev-request 2026-08-22-rfb-website-email-selvforsyning,
    // Pilot-FUNN 2026-08-22 P1): content-marker guard against proxy/cache
    // contamination — rfbWdPageReferencesOwnHost + the one-retry pattern in
    // tryRfbWebsiteCandidateHost, both the plain-fetch stage and the
    // headless-render fallback stage.
    // ═══════════════════════════════════════════════════════════════════

    // ── (4d-a) rfbWdPageReferencesOwnHost — pure helper unit tests ──
    {
      assertEq(
        rfbWdPageReferencesOwnHost(
          `<html><head><link rel="canonical" href="https://fjelldalgard.no/"></head><body>Fjelldal Gard — org.nr 944444444</body></html>`,
          "fjelldalgard.no",
        ),
        true,
        "4d-a1: host label present in html -> true",
      );
      assertEq(
        rfbWdPageReferencesOwnHost("<html><body>Fjelldal Gard — org.nr 944444444</body></html>", "annengard.no"),
        false,
        "4d-a2: host label absent from html -> false",
      );
      assertEq(
        rfbWdPageReferencesOwnHost(
          `<html><head><link rel="canonical" href="https://fjelldalgard.no/"></head></html>`,
          "www.fjelldalgard.no",
        ),
        true,
        "4d-a3: www. prefix on the HOST param is stripped before deriving the label -> still matches",
      );
      assertEq(
        rfbWdPageReferencesOwnHost("<html><body>ingen selvreferanse her</body></html>", "www.fjelldalgard.no"),
        false,
        "4d-a4: www. prefix stripped, but the (still-absent) label correctly reports false",
      );
      assertEq(
        rfbWdPageReferencesOwnHost("<html><body>anything at all</body></html>", "no.no"),
        true,
        "4d-a5: normalized label shorter than 3 chars ('no') -> fail-OPEN, true",
      );
      assertEq(
        rfbWdPageReferencesOwnHost("<html><body>anything at all</body></html>", "1.2.3.4"),
        true,
        "4d-a6: bare-IP-shaped host normalizes to a short label ('1') -> fail-OPEN, true",
      );
      assertEq(
        rfbWdPageReferencesOwnHost("HTML MENTIONS FjellDalGard SOMEWHERE", "fjelldalgard.no"),
        true,
        "4d-a7: match is case-insensitive",
      );
    }

    // ── (4d-b) plain-fetch integration: 1st call answers with the WRONG
    //     page's html (no self-reference), 2nd call (the retry) answers
    //     with the RIGHT page's html (self-reference + matching evidence)
    //     -> the candidate proceeds to evidence matching using the SECOND
    //     call's content, proving the retry's content is actually used,
    //     not the first (contaminated) fetch's ──
    {
      let retryOkCalls = 0;
      globalThis.fetch = (async (url: any) => {
        const urlStr = String(url);
        if (urlStr === "https://retryokgard.no") {
          retryOkCalls++;
          if (retryOkCalls === 1) {
            // WRONG page: a proxy/cache hit for a totally unrelated site —
            // no mention of retryokgard.no anywhere, and (deliberately) no
            // matching evidence either, so a false-positive proposal here
            // would be a real bug, not just a marker-check miss.
            return htmlResponse("<html><body>En helt annen side — ingen tilknytning</body></html>", {
              finalUrl: urlStr,
            });
          }
          // RIGHT page (the ONE retry): carries both the self-reference
          // marker AND the matching org_nr evidence.
          return htmlResponse(
            `<html><head><link rel="canonical" href="https://retryokgard.no/"></head><body>Retryok Gard — org.nr 944000010</body></html>`,
            { finalUrl: urlStr },
          );
        }
        return notFoundResponse();
      }) as unknown as typeof fetch;

      insertAgent({ id: "wd-4d-retryok", name: "Retryok Gard", orgNr: "944000010", city: "Bodø" });
      const outcome = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: "wd-4d-retryok", url: "https://retryokgard.no" },
        rfbWdExistingWebsiteHosts(testDb as any),
        new Set<string>(),
        { attempted: 0, verified: 0 },
        "wd-4d-retryok-batch",
      );
      assertEq(outcome.outcome, "proposed", "4d-b1: wrong-then-right retry still proposes, using the retry's content");
      assertTrue(
        outcome.outcome === "proposed" && outcome.evidence.org_nr_found === true,
        "4d-b2: evidence matched via org_nr — present ONLY in the retry's (2nd call's) content",
      );
      assertEq(retryOkCalls, 2, "4d-b3: the SAME url was fetched exactly twice — one sequential retry, never a loop");
      const row = readQueueRow("wd-4d-retryok");
      assertTrue(!!row, "4d-b4: a queue row was inserted from the retry-verified content");
      assertEq(row?.candidate_url, "https://retryokgard.no", "4d-b5: queue row candidate_url is the (shared) origin");

      globalThis.fetch = stubFetch();
    }

    // ── (4d-c) plain-fetch integration: BOTH calls answer with the wrong
    //     page's html -> excludedHere contains exactly
    //     {host, reason:"fetch_contaminated"}, no queue write happens ──
    {
      let bothWrongCalls = 0;
      globalThis.fetch = (async (url: any) => {
        const urlStr = String(url);
        if (urlStr === "https://bothwronggard.no") {
          bothWrongCalls++;
          return htmlResponse("<html><body>Fortsatt feil side — ingen tilknytning</body></html>", {
            finalUrl: urlStr,
          });
        }
        return notFoundResponse();
      }) as unknown as typeof fetch;

      insertAgent({ id: "wd-4d-bothwrong", name: "Bothwrong Gard", orgNr: "944000011", city: "Bodø" });
      const outcome = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: "wd-4d-bothwrong", url: "https://bothwronggard.no" },
        rfbWdExistingWebsiteHosts(testDb as any),
        new Set<string>(),
        { attempted: 0, verified: 0 },
        "wd-4d-bothwrong-batch",
      );
      assertEq(outcome.outcome, "rejected", "4d-c1: both fetches contaminated -> rejected");
      assertTrue(
        outcome.outcome === "rejected" && outcome.reason === "fetch_contaminated",
        "4d-c2: top-level rejection reason is fetch_contaminated — a third, distinct reason class from fetch_failed:*/evidence_mismatch",
      );
      assertEq(
        outcome.outcome === "rejected" ? outcome.excluded : null,
        [{ host: "bothwronggard.no", reason: "fetch_contaminated" }],
        "4d-c3: excludedHere contains EXACTLY {host, reason: fetch_contaminated} — nothing else pushed",
      );
      assertEq(bothWrongCalls, 2, "4d-c4: exactly ONE retry — the same url fetched exactly twice, never a loop");
      assertTrue(!readQueueRow("wd-4d-bothwrong"), "4d-c5: no queue write happens from contaminated content");

      globalThis.fetch = stubFetch();
    }

    // ── (4d-d) render-fallback branch: same three scenarios mirrored via
    //     renderPageImplForTesting — plain fetch is a JS shell (forces
    //     escalation to render) and itself carries no evidence, so every
    //     assertion below is really exercising the RENDER path's own
    //     marker+retry guard, not the plain-fetch one from (4d-b)/(4d-c) ──
    {
      process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED = "true";
      const jsShell = `<html><body><script>var pad = "${"x".repeat(2500)}";</script><div id="root">App</div></body></html>`;

      // (4d-d1) render retry SUCCEEDS: 1st render call answers with the
      // wrong page's html, 2nd (the retry) answers with the right page's
      // html (self-reference + matching evidence) -> proposed, using the
      // RETRY's content.
      {
        let renderCalls = 0;
        setRfbWdRenderPageImplForTesting!(async (url: string) => {
          renderCalls++;
          if (renderCalls === 1) {
            return {
              ok: true,
              html: "<html><body>En helt annen renderet side</body></html>",
              text: "En helt annen renderet side",
              finalUrl: url,
              elapsedMs: 10,
            };
          }
          return {
            ok: true,
            html: `<html><head><link rel="canonical" href="${url}"></head><body>Hfretryok Gard — org.nr 944000012</body></html>`,
            text: "Hfretryok Gard — org.nr 944000012",
            finalUrl: url,
            elapsedMs: 10,
          };
        });

        insertAgent({ id: "wd-4d-hfretryok", name: "Hfretryok Gard", orgNr: "944000012", city: "Voss" });
        fixtures.set("https://hfretryokgard.no", htmlResponse(jsShell, { finalUrl: "https://hfretryokgard.no" }));

        const r = await callDiscovery({ agentIds: ["wd-4d-hfretryok"] });
        assertEq(r.body.proposed.length, 1, "4d-d1a: render retry succeeded -> proposed");
        assertEq(
          r.body.proposed[0]?.evidence?.org_nr_found,
          true,
          "4d-d1b: evidence matched via org_nr — present ONLY in the render retry's content",
        );
        assertEq(renderCalls, 2, "4d-d1c: renderFn called exactly twice — one sequential retry, never a loop");
        assertTrue(!!readQueueRow("wd-4d-hfretryok"), "4d-d1d: a queue row was inserted from the render-retry-verified content");

        setRfbWdRenderPageImplForTesting!(null);
      }

      // (4d-d2) render retry ALSO fails the marker check (both calls answer
      // with the wrong page's html) -> the top-level rejection reason is
      // fetch_contaminated, and nothing is queued.
      {
        let renderCalls = 0;
        setRfbWdRenderPageImplForTesting!(async (url: string) => {
          renderCalls++;
          return {
            ok: true,
            html: "<html><body>Fortsatt feil renderet side</body></html>",
            text: "Fortsatt feil renderet side",
            finalUrl: url,
            elapsedMs: 10,
          };
        });

        insertAgent({ id: "wd-4d-hfbothwrong", name: "Hfbothwrong Gard", orgNr: "944000013", city: "Voss" });
        fixtures.set("https://hfbothwronggard.no", htmlResponse(jsShell, { finalUrl: "https://hfbothwronggard.no" }));

        const r = await callDiscovery({ agentIds: ["wd-4d-hfbothwrong"] });
        assertEq(r.body.proposed.length, 0, "4d-d2a: nothing proposed");
        const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-4d-hfbothwrong");
        assertTrue(!!rej, "4d-d2b: the agent was rejected");
        assertEq(rej?.reason, "fetch_contaminated", "4d-d2c: top-level rejection reason is fetch_contaminated");
        assertTrue(
          (rej?.excluded ?? []).some(
            (x: any) => x.host === "hfbothwronggard.no" && x.reason === "fetch_contaminated",
          ),
          "4d-d2d: excludedHere carries a fetch_contaminated entry for the render-fallback host",
        );
        assertEq(renderCalls, 2, "4d-d2e: renderFn called exactly twice — one sequential retry, never a loop");
        assertTrue(!readQueueRow("wd-4d-hfbothwrong"), "4d-d2f: no queue write happens from contaminated render content");

        setRfbWdRenderPageImplForTesting!(null);
      }

      // (4d-d3) render retry FAILS OUTRIGHT (!ok on the retry, not just a
      // marker miss) -> same fetch_contaminated outcome, never a throw.
      {
        let renderCalls = 0;
        setRfbWdRenderPageImplForTesting!(async (url: string) => {
          renderCalls++;
          if (renderCalls === 1) {
            return {
              ok: true,
              html: "<html><body>En annen renderet side, uten selvreferanse</body></html>",
              text: "En annen renderet side, uten selvreferanse",
              finalUrl: url,
              elapsedMs: 10,
            };
          }
          return {
            ok: false,
            reason: "renderer_unavailable",
            detail: "simulated retry failure",
            elapsedMs: 3,
          };
        });

        insertAgent({ id: "wd-4d-hfretryfail", name: "Hfretryfail Gard", orgNr: "944000014", city: "Voss" });
        fixtures.set("https://hfretryfailgard.no", htmlResponse(jsShell, { finalUrl: "https://hfretryfailgard.no" }));

        const r = await callDiscovery({ agentIds: ["wd-4d-hfretryfail"] });
        assertEq(r.body.proposed.length, 0, "4d-d3a: nothing proposed");
        const rej = r.body.rejected.find((x: any) => x.agent_id === "wd-4d-hfretryfail");
        assertEq(rej?.reason, "fetch_contaminated", "4d-d3b: a failed retry (not just a marker miss) is still fetch_contaminated");
        assertEq(renderCalls, 2, "4d-d3c: renderFn called exactly twice — one sequential retry, never a loop");
        assertTrue(!readQueueRow("wd-4d-hfretryfail"), "4d-d3d: no queue write happens");

        setRfbWdRenderPageImplForTesting!(null);
      }

      delete process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED;
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-rfb-website-discovery: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevHeadlessFallbackEnabled === undefined) delete process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED;
    else process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED = prevHeadlessFallbackEnabled;
    if (prevBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = prevBraveApiKey;
    if (prevBraveSearchApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = prevBraveSearchApiKey;
    if (prevAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicApiKey;
    try {
      if (setRfbWdSearchForTesting) setRfbWdSearchForTesting(null);
    } catch {
      /* best-effort restore */
    }
    try {
      if (setRfbWdRenderPageImplForTesting) setRfbWdRenderPageImplForTesting(null);
    } catch {
      /* best-effort restore */
    }
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-rfb-website-discovery.test.ts`
if (require.main === module) {
  runAdminRfbWebsiteDiscoveryTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

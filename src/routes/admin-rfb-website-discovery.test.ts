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
 *       'no_candidate_verified', nothing queued.
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
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "rfb-wd-test-key";

  // URL -> Response, keyed by the exact "https://<host>" this route requests
  // (services/fetch-page.ts always requests the bare origin, no path).
  const fixtures: Map<string, Response> = new Map();
  const fetchCalls: string[] = [];

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const urlStr = String(url);
      fetchCalls.push(urlStr);
      const fx = fixtures.get(urlStr);
      return fx ?? notFoundResponse();
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
    const { RFB_WD_HARD_CAP, rfbWebsiteHostExclusionReason } = routeModule;

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
      assertEq(r.body.rejected[0].reason, "no_candidate_verified", "c4: reason is no_candidate_verified");
      assertTrue(r.body.rejected[0].tried.length > 0, "c5: at least one host was actually fetched");
      assertTrue(!readQueueRow("wd-none"), "c6: nothing queued for this agent");
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
      // (no_candidate_verified), but that's irrelevant here: the pick
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
  } catch (err: any) {
    failed++;
    failures.push("admin-rfb-website-discovery: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

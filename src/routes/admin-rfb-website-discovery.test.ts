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
    const { RFB_WD_HARD_CAP } = routeModule;

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
    }

    function readQueueRow(agentId: string): any {
      return testDb.prepare("SELECT * FROM agents_website_review_queue WHERE agent_id = ?").get(agentId);
    }

    // ── (a) auth ──────────────────────────────────────────────────
    {
      const p = await callDiscovery({}, {});
      assertEq(p.status, 403, "auth: POST without X-Admin-Key -> 403");
      const g = await callQueue({});
      assertEq(g.status, 403, "auth: GET without X-Admin-Key -> 403");
    }

    // ── (b) candidate accepted: org_nr evidence verifies ────────────
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

    // ── (c) candidate rejected: fetched, but no evidence anywhere ─────
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

    // ── (d) aggregator-host candidate rejected ──────────────────
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

    // ── (e) shared-host guard: host already carried by another agent's
    //     live agent_knowledge.website ──────────────────────────
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

    // ── (g) already-has-website row is skipped, never scanned ────────
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

    // ── (h) batch-size cap enforced ───────────────────────
    {
      const ids = Array.from({ length: RFB_WD_HARD_CAP + 1 }, (_, i) => `cap-${i}`);
      const r = await callDiscovery({ agentIds: ids });
      assertEq(r.status, 400, `h1: more than ${RFB_WD_HARD_CAP} agentIds -> 400`);
    }

    // ── (i) GET review-queue returns only status='pending' rows ────
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

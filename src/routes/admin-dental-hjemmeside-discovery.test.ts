/**
 * admin-dental-hjemmeside-discovery.test.ts — tests for
 * dev-request 2026-08-15-dental-hjemmeside-brreg-navnesoek, item 3: the
 * Brreg-field leg (tier 1) AND the navnesøk/name-search fallback leg
 * (tier 2): POST /admin/dental/hjemmeside-discovery-batch + POST
 * /admin/dental/hjemmeside-discovery-approve (src/routes/admin-dental-
 * hjemmeside-discovery.ts).
 *
 * Setup mirrors admin-dental-mark-inactive.test.ts: fresh in-memory dental
 * DB via DENTAL_DB_PATH=":memory:" + db-factory __resetDbFactoryForTesting()
 * (so initDentalSchema runs the real production dental schema, including
 * directory_url/is_inactive/field_provenance), fresh require of the route
 * module per run, exercised via router.handle() directly (X-Admin-Key
 * passed via headers).
 *
 * Brreg + page fetches are stubbed via this route's own injectable fetch
 * seam (__setDentalWdFetchForTesting) rather than a monkey-patched
 * globalThis.fetch — this suite IS wired into tests/test.ts (unlike
 * admin-rfb-website-discovery.test.ts, which documents itself as
 * standalone-only for exactly this reason), where many other test blocks
 * run interleaved in one process; a global fetch swap here would poison a
 * concurrently-running block's real fetch() calls. Mirrors admin-agents.ts's
 * own __setAgentsOrgNrBackfillFetchForTesting seam (see admin-agents-org-nr-
 * backfill.test.ts). Any page-fetch URL not explicitly registered as a
 * fixture throws (rather than silently 404ing), so a route that ever
 * requests a URL this suite did not intend to reach fails loudly — proof
 * this route's own fetch_failed handling is exercised deliberately (the
 * clinic-fetch-failed case below) and never masks a routing bug as a quiet
 * false negative.
 *
 * The tier-2 navnesøk leg (section (q) below) is stubbed the same way, via
 * this route's own injectable search seam (__setDentalWdSearchForTesting) —
 * never a real braveSearch/network call. BRAVE_API_KEY/BRAVE_SEARCH_API_KEY
 * are saved/cleared/restored around the whole suite (like ADMIN_KEY) so a
 * key that happens to be configured in the ambient environment can never
 * make this suite's "no search seam wired" case (q5) accidentally reach the
 * real production search path instead of exercising the null-seam branch.
 * Every (q)-block installs its own stub and resets it to null (mirrors "no
 * Brave key" in production) in a `finally`, so a block that throws never
 * leaks a search seam into a later block or into the pre-existing (a)-(p)
 * assertions, which must stay byte-identical to their tier-1-only behaviour.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on both routes.
 *   (b) org_nr_found evidence on the Brreg-registered page -> queued,
 *       confidence 1.0, a 'pending' row lands in dental_website_review_queue.
 *   (c) weak/no evidence on an otherwise-fetchable Brreg page ->
 *       insufficient_evidence, nothing queued.
 *   (d) Brreg's registered website is a known directory/aggregator host
 *       (item 1's classifier) -> aggregator_host, nothing queued, the host
 *       is NEVER fetched (no page-fetch call recorded for it).
 *   (e) no Brreg website on file for the org_nr -> no_brreg_website, nothing
 *       queued, no page fetch attempted at all.
 *   (f) a page fetch that fails (network error) -> fetch_failed, nothing
 *       queued, no throw escapes the route.
 *   (g) a clinic whose hjemmeside is already non-blank is excluded from
 *       auto-select selection entirely (never appears in scanned/results).
 *   (h) an is_inactive=1 clinic is excluded from auto-select selection
 *       entirely.
 *   (i) explicit agentIds override: a genuinely eligible id is scanned and
 *       queued; an ineligible id (already-filled / inactive) is reported
 *       not_eligible, not scanned.
 *   (j) agentIds cap: more than DENTAL_WD_BATCH_CAP ids -> 400.
 *   (k) approve: dry-run reports would_apply, writes NOTHING to the DB.
 *   (l) approve: apply on a still-blank hjemmeside succeeds, sets
 *       hjemmeside, merges field_provenance.hjemmeside WITHOUT clobbering a
 *       pre-existing, unrelated field_provenance entry, and flips the queue
 *       row to status='applied'.
 *   (m) approve: a repeat apply on an already-filled row -> no_longer_blank
 *       in `skipped`, not a thrown error, 200 response.
 *   (n) approve: url mismatch with the queued candidate ->
 *       mismatch_with_queued_candidate; an agent_id never queued ->
 *       not_in_review_queue.
 *   (o) approve: more than DENTAL_WD_APPROVE_MAX approvals -> 400.
 *   (p) DENTAL_WD_HEADLESS_FALLBACK_ENABLED unset/false (default) -> the
 *       headless-render escalation is never attempted, even for a fetched
 *       page that otherwise looks exactly like the JS-shell shape
 *       shouldEscalateToRender() looks for — renderPage is never invoked,
 *       and the outcome is the same insufficient_evidence a plain-fetch-only
 *       world would produce. Mirrors admin-rfb-website-discovery.test.ts's
 *       own flag-off coverage (hf-a) for the identical fallback pattern.
 *   (q) navnesøk (name-search) fallback leg (tier 2): a search hit with
 *       org_nr_found evidence gets queued with reason='navnesok_fallback'
 *       when tier 1 found nothing this row (q1); a search hit with only
 *       weak/no evidence does NOT get queued and the ORIGINAL tier-1 skip
 *       status is preserved untouched (q2); an aggregator-host search
 *       result is excluded via classifyHjemmeside before any fetch, and a
 *       LATER candidate host from the SAME search response can still verify
 *       (q3) using only ONE braveSearch-seam call for the whole row — cost
 *       control (q4, mirrors RFB's own wd-10a test); with NO search seam
 *       wired, a Brreg-leg failure returns its original skip status
 *       untouched and search_attempted stays false — tier 2 never attempted
 *       (q5); approve stamps field_provenance.hjemmeside.source_type
 *       correctly from the queue row's own `reason`:
 *       'search_verified_website' for 'navnesok_fallback', unchanged
 *       'brreg_registered_website' for 'brreg_field' (q6); tier 2's own
 *       evidence gate rejects phone+name-only search-hit evidence just like
 *       tier 1's (c2) does, proving it is not a passthrough of
 *       evidence.verified (q7); once tier 1 already queued a candidate,
 *       tier 2 is NEVER attempted — even with a search seam wired that would
 *       (if ever called) return a different, independently-verifiable
 *       candidate (q8).
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-dental-hjemmeside-discovery.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminDentalHjemmesideDiscoveryTests() and folds its pass/fail
 *      counts into the `npm test` summary.
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
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const path = opts.path || "/";
    const req: any = {
      method: opts.method || "POST",
      url: path,
      originalUrl: path,
      path,
      query: {},
      headers,
      body: opts.body,
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

function htmlResponse(html: string, opts: { finalUrl?: string } = {}): Response {
  return {
    ok: true,
    status: 200,
    url: opts.finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  } as unknown as Response;
}

export async function runAdminDentalHjemmesideDiscoveryTests(
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

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevHeadlessFallbackEnabled = process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED;
  const prevBraveApiKey = process.env.BRAVE_API_KEY;
  const prevBraveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY;
  const testKey = process.env.ADMIN_KEY || "dental-wd-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;
  // Explicit default-OFF for the whole suite unless a block below opts in —
  // matches production's "absent from fly.toml" state.
  delete process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED;
  // Cleared for the whole suite (never set by any block below) so an
  // ambient Brave key in the environment can never make the (q5) "no search
  // seam wired" case accidentally resolve to the REAL production search
  // path — every (q) block installs its own seam via
  // __setDentalWdSearchForTesting instead, which always takes priority over
  // any env key regardless.
  delete process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;

  const dbFactoryPath = require.resolve("../database/db-factory");
  const routePath = require.resolve("./admin-dental-hjemmeside-discovery");
  const cachePaths = [dbFactoryPath, routePath];
  for (const p of cachePaths) delete require.cache[p];

  // Brreg /enheter/{orgNr} detail fixtures, keyed by the bare 9-digit org
  // number. Absent -> a real 404 (fetchBrregWebsite's own documented "no
  // result" contract), NOT a test bug — the (e) no_brreg_website case relies
  // on exactly this.
  const brregFixtures: Map<string, Record<string, unknown>> = new Map();
  // Page-fetch fixtures, keyed by the exact URL fetchPage will request
  // (fetchBrregWebsite's returned hjemmeside value, already schemed).
  const pageFixtures: Map<string, Response> = new Map();
  // URLs that must THROW when fetched (simulating a real network failure) —
  // proves fetchPage's error classification, and this route's fetch_failed
  // handling, actually run rather than being bypassed.
  const forceThrowUrls: Set<string> = new Set();
  const fetchCalls: string[] = [];

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      fetchCalls.push(u);
      const dm = /\/enheter\/(\d{9})$/.exec(u);
      if (dm) {
        const fx = brregFixtures.get(dm[1]);
        if (!fx) return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
        return { status: 200, ok: true, json: async () => fx } as unknown as Response;
      }
      if (forceThrowUrls.has(u)) {
        throw new Error(`stubFetch: forced network failure for ${u}`);
      }
      const fx = pageFixtures.get(u);
      if (fx) return fx;
      // Any page URL not explicitly registered is a test-authoring bug (the
      // route reached a host this suite never intended) — throw loudly
      // instead of a silent 404 that could masquerade as a legitimate
      // outcome.
      throw new Error(`stubFetch: unexpected page fetch for ${u}`);
    }) as typeof fetch;
  }

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");

    const routeMod = require("./admin-dental-hjemmeside-discovery") as
      typeof import("./admin-dental-hjemmeside-discovery");
    const router = routeMod.default as any;
    routeMod.__setDentalWdFetchForTesting(stubFetch());

    // brreg-client.ts's own per-process contactCache is keyed only by org_nr
    // and is NOT reset by db-factory's reset — cleared here defensively so
    // this suite can never read a stale result cached by an earlier test
    // block (in this file or another) that happened to reuse the same
    // placeholder org_nr.
    const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
    brregClient.__clearBrregWebsiteCacheForTesting();

    const insertClinic = dentalDb.prepare(
      `INSERT INTO dental_agents (id, navn, org_nr, poststed, telefon, mobil, adresse, postnummer, hjemmeside, directory_url, is_inactive, field_provenance, created_at)
       VALUES (@id, @navn, @org_nr, @poststed, @telefon, @mobil, @adresse, @postnummer, @hjemmeside, @directory_url, @is_inactive, @field_provenance, @created_at)`,
    );

    function seedClinic(o: {
      id: string;
      navn: string;
      org_nr: string | null;
      poststed?: string | null;
      telefon?: string | null;
      mobil?: string | null;
      adresse?: string | null;
      postnummer?: string | null;
      hjemmeside?: string | null;
      directory_url?: string | null;
      is_inactive?: number;
      field_provenance?: string | null;
    }): void {
      insertClinic.run({
        id: o.id,
        navn: o.navn,
        org_nr: o.org_nr,
        poststed: o.poststed ?? null,
        telefon: o.telefon ?? null,
        mobil: o.mobil ?? null,
        adresse: o.adresse ?? null,
        postnummer: o.postnummer ?? null,
        hjemmeside: o.hjemmeside ?? null,
        directory_url: o.directory_url ?? null,
        is_inactive: o.is_inactive ?? 0,
        field_provenance: o.field_provenance ?? null,
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }

    function readClinic(id: string): any {
      return dentalDb.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id);
    }
    function readQueueRow(agentId: string): any {
      return dentalDb.prepare("SELECT * FROM dental_website_review_queue WHERE agent_id = ?").get(agentId);
    }

    function post(path: string, body: any, key: string | false = testKey): Promise<RouteResult> {
      const headers: Record<string, string> = {};
      if (key !== false) headers["x-admin-key"] = key;
      return callRoute(router, { method: "POST", path, headers, body });
    }
    const postDiscovery = (body: any, key: string | false = testKey) => post("/hjemmeside-discovery-batch", body, key);
    const postApprove = (body: any, key: string | false = testKey) => post("/hjemmeside-discovery-approve", body, key);

    // ── (a) admin gate ────────────────────────────────────────────────────
    {
      const p1 = await postDiscovery({}, false);
      assertEq(p1.status, 403, "a1: discovery-batch without X-Admin-Key -> 403");
      const p2 = await postApprove({ approvals: [] }, false);
      assertEq(p2.status, 403, "a2: discovery-approve without X-Admin-Key -> 403");
      const p3 = await postDiscovery({}, "wrong-key");
      assertEq(p3.status, 403, "a3: discovery-batch with wrong X-Admin-Key -> 403");
    }

    // ── (b) org_nr_found evidence -> queued ──────────────────────────────
    seedClinic({ id: "wd-orgnr-ok", navn: "Fjordly Tannlege AS", org_nr: "111111111", poststed: "Bergen" });
    brregFixtures.set("111111111", { hjemmeside: "https://fjordlytannlege.no" });
    pageFixtures.set(
      "https://fjordlytannlege.no",
      htmlResponse("<html><body>Fjordly Tannlege — org.nr 111 111 111</body></html>", { finalUrl: "https://fjordlytannlege.no" }),
    );

    // ── (c) weak/no evidence -> insufficient_evidence ────────────────────
    seedClinic({ id: "wd-weak", navn: "Ukjent Tannklinikk", org_nr: "222222222", poststed: "Lillehammer" });
    brregFixtures.set("222222222", { hjemmeside: "https://ukjenttannklinikk.no" });
    pageFixtures.set(
      "https://ukjenttannklinikk.no",
      htmlResponse("<html><body>Parkert domene til salgs, ingen relevant informasjon her.</body></html>", {
        finalUrl: "https://ukjenttannklinikk.no",
      }),
    );

    // ── (c2) phone+name evidence WITHOUT org_nr/place -> still
    // insufficient_evidence, because this route's gate is deliberately
    // NARROWER than gardssalgWebsiteEvidenceMatch's own `verified` (which
    // treats phone_found && (name_found || place_found) as sufficient).
    // Page mentions the clinic's phone + name but never "Kristiansand"
    // (target's own poststed) or the org_nr digits, so evidence.verified
    // would be TRUE here while this route's own strict
    // (org_nr_found || (name_found && place_found)) gate is FALSE — this is
    // the one fixture that actually distinguishes the two gates (PR #600
    // review: swapping the strict gate for evidence.verified passed all
    // other tests unnoticed; this case fails loudly if that swap happens).
    seedClinic({
      id: "wd-phone-only",
      navn: "Bjørknes Tannhelse",
      org_nr: "141414141",
      poststed: "Kristiansand",
      telefon: "91234567",
    });
    brregFixtures.set("141414141", { hjemmeside: "https://bjorknes-tannhelse-info.no" });
    pageFixtures.set(
      "https://bjorknes-tannhelse-info.no",
      htmlResponse("<html><body>Bjørknes Tannhelse — ring oss på 912 34 567 for time.</body></html>", {
        finalUrl: "https://bjorknes-tannhelse-info.no",
      }),
    );

    // ── (d) aggregator/directory host -> aggregator_host, never fetched ──
    seedClinic({ id: "wd-aggregator", navn: "Sentrum Tannlege", org_nr: "333333333", poststed: "Oslo" });
    brregFixtures.set("333333333", { hjemmeside: "https://legelisten.no/sentrum-tannlege" });
    // Deliberately NO pageFixtures entry for legelisten.no — if the route
    // ever fetched it, stubFetch would throw (unexpected page fetch),
    // failing the whole run loudly instead of silently.

    // ── (e) no Brreg website -> no_brreg_website, no fetch at all ────────
    seedClinic({ id: "wd-no-brreg", navn: "Fjellheim Tannklinikk", org_nr: "666666666" });
    // brregFixtures has no "666666666" entry -> real 404 -> null website.

    // ── (f) page fetch fails -> fetch_failed ──────────────────────────────
    seedClinic({ id: "wd-fetch-fail", navn: "Vestkant Tannlege", org_nr: "777777777" });
    brregFixtures.set("777777777", { hjemmeside: "https://forced-throw-tannlege.no" });
    forceThrowUrls.add("https://forced-throw-tannlege.no");

    // ── (g) already-filled hjemmeside -> excluded from selection ─────────
    seedClinic({ id: "wd-already-filled", navn: "Fylt Tannlege AS", org_nr: "444444444", hjemmeside: "https://already-has-a-site.no" });

    // ── (h) is_inactive=1 -> excluded from selection ──────────────────────
    seedClinic({ id: "wd-inactive", navn: "Nedlagt Tannlege AS", org_nr: "555555555", is_inactive: 1 });

    // ── run auto-select batch (covers b,c,d,e,f; g/h must be ABSENT) ─────
    const batch1 = await postDiscovery({});
    assertEq(batch1.status, 200, "batch1: 200");
    const byId = new Map<string, any>((batch1.body.results as any[]).map((r) => [r.agent_id, r]));

    assertTrue(byId.has("wd-orgnr-ok"), "b1: org_nr-verified clinic present in results");
    assertEq(byId.get("wd-orgnr-ok")?.status, "queued", "b2: org_nr-verified clinic -> queued");
    assertEq(byId.get("wd-orgnr-ok")?.evidence?.org_nr_found, true, "b3: verified via org_nr on the page");
    assertEq(byId.get("wd-orgnr-ok")?.confidence, 1.0, "b4: confidence 1.0 when org_nr_found");
    {
      const row = readQueueRow("wd-orgnr-ok");
      assertTrue(!!row, "b5: a queue row was inserted");
      assertEq(row.status, "pending", "b6: queue row status is 'pending'");
      assertEq(row.candidate_url, "https://fjordlytannlege.no", "b7: queue row candidate_url matches");
      assertTrue(typeof row.evidence === "string" && JSON.parse(row.evidence).org_nr_found === true, "b8: queue row evidence JSON round-trips");
    }

    assertEq(byId.get("wd-weak")?.status, "insufficient_evidence", "c1: weak evidence -> insufficient_evidence");
    assertTrue(!readQueueRow("wd-weak"), "c2: nothing queued for weak-evidence clinic");

    {
      const ev = byId.get("wd-phone-only")?.evidence;
      assertEq(byId.get("wd-phone-only")?.status, "insufficient_evidence", "c2a: phone+name-only evidence -> insufficient_evidence (narrower than evidence.verified)");
      assertTrue(!readQueueRow("wd-phone-only"), "c2b: nothing queued for phone+name-only clinic");
      assertEq(ev?.phone_found, true, "c2c: phone_found is true on this fixture");
      assertEq(ev?.name_found, true, "c2d: name_found is true on this fixture");
      assertEq(ev?.place_found, false, "c2e: place_found is false (poststed never mentioned on the page)");
      assertEq(ev?.org_nr_found, false, "c2f: org_nr_found is false (org.nr never mentioned on the page)");
      assertEq(ev?.verified, true, "c2g: gardssalgWebsiteEvidenceMatch's own looser `verified` IS true here — proves this route's gate is a deliberately narrower, separate check, not a passthrough of `verified`");
    }

    assertEq(byId.get("wd-aggregator")?.status, "aggregator_host", "d1: aggregator/directory Brreg website -> aggregator_host");
    assertTrue(!readQueueRow("wd-aggregator"), "d2: nothing queued for aggregator-host clinic");
    assertTrue(!fetchCalls.includes("https://legelisten.no/sentrum-tannlege"), "d3: aggregator host was NEVER fetched");

    assertEq(byId.get("wd-no-brreg")?.status, "no_brreg_website", "e1: no Brreg website -> no_brreg_website");
    assertTrue(!readQueueRow("wd-no-brreg"), "e2: nothing queued when no Brreg website exists");

    assertEq(byId.get("wd-fetch-fail")?.status, "fetch_failed", "f1: page fetch failure -> fetch_failed");
    assertTrue(!readQueueRow("wd-fetch-fail"), "f2: nothing queued on fetch failure");

    assertTrue(!byId.has("wd-already-filled"), "g1: already-filled hjemmeside clinic never appears in results");
    assertTrue(!byId.has("wd-inactive"), "h1: is_inactive=1 clinic never appears in results");
    assertEq(batch1.body.skipped.no_brreg_website, 1, "skip-counts: no_brreg_website counted once");
    assertEq(batch1.body.skipped.aggregator_host, 1, "skip-counts: aggregator_host counted once");
    assertEq(batch1.body.skipped.insufficient_evidence, 2, "skip-counts: insufficient_evidence counted twice (wd-weak + wd-phone-only)");
    assertEq(batch1.body.skipped.fetch_failed, 1, "skip-counts: fetch_failed counted once");
    assertEq(batch1.body.queued, 1, "skip-counts: queued=1 for this batch");

    // ── (i) explicit agentIds override ────────────────────────────────────
    seedClinic({ id: "wd-explicit-ok", navn: "Nordstrand Tannlege AS", org_nr: "888888888", poststed: "Tromsø" });
    brregFixtures.set("888888888", { hjemmeside: "https://nordstrandtannlege.no" });
    pageFixtures.set(
      "https://nordstrandtannlege.no",
      htmlResponse("<html><body>Nordstrand Tannlege — org.nr 888 888 888</body></html>", { finalUrl: "https://nordstrandtannlege.no" }),
    );
    const batch2 = await postDiscovery({ agentIds: ["wd-explicit-ok", "wd-already-filled", "wd-inactive"] });
    assertEq(batch2.status, 200, "i1: agentIds override -> 200");
    const byId2 = new Map<string, any>((batch2.body.results as any[]).map((r) => [r.agent_id, r]));
    assertEq(byId2.get("wd-explicit-ok")?.status, "queued", "i2: eligible explicit id scanned + queued");
    assertEq(byId2.get("wd-already-filled")?.status, "not_eligible", "i3: already-filled explicit id -> not_eligible");
    assertEq(byId2.get("wd-inactive")?.status, "not_eligible", "i4: inactive explicit id -> not_eligible");
    assertEq(batch2.body.scanned, 1, "i5: scanned counts only the genuinely eligible target");

    // ── (j) agentIds cap ───────────────────────────────────────────────────
    const cap = routeMod.DENTAL_WD_BATCH_CAP;
    assertEq(cap, 25, "j0: DENTAL_WD_BATCH_CAP is 25");
    const tooMany = Array.from({ length: cap + 1 }, (_, i) => `bulk-${i}`);
    const overCap = await postDiscovery({ agentIds: tooMany });
    assertEq(overCap.status, 400, "j1: more than DENTAL_WD_BATCH_CAP agentIds -> 400");

    // ── (k) approve: dry-run writes nothing ───────────────────────────────
    seedClinic({
      id: "wd-approve-a",
      navn: "Sørvest Tannlege AS",
      org_nr: "999999999",
      field_provenance: JSON.stringify({ telefon: { source_type: "phone_directory", value: "12345678" } }),
    });
    dentalDb.prepare(
      `INSERT INTO dental_website_review_queue (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
       VALUES ('q-approve-a', 'wd-approve-a', 'Sørvest Tannlege AS', 'https://sorvesttannlege.no', 'https://sorvesttannlege.no', '{"org_nr_found":true}', 1.0, 'website_discovery_candidate', 'batch-x', 'pending', datetime('now'), datetime('now'))`,
    ).run();

    const dry = await postApprove({ approvals: [{ agent_id: "wd-approve-a", url: "https://sorvesttannlege.no" }] });
    assertEq(dry.status, 200, "k1: dry-run approve -> 200");
    assertEq(dry.body.dry_run, true, "k2: dry_run:true by default (apply omitted)");
    assertEq(dry.body.would_apply_count, 1, "k3: would_apply_count=1");
    assertEq(dry.body.results[0].status, "would_apply", "k4: dry-run reports would_apply");
    {
      const row = readClinic("wd-approve-a");
      assertEq(row.hjemmeside, null, "k5: dry-run never writes hjemmeside");
      const q = readQueueRow("wd-approve-a");
      assertEq(q.status, "pending", "k6: dry-run never flips queue row status");
    }

    // ── (l) approve: apply succeeds, merges provenance without clobbering ─
    const applyRes = await postApprove({ approvals: [{ agent_id: "wd-approve-a", url: "https://sorvesttannlege.no" }], apply: true });
    assertEq(applyRes.status, 200, "l1: apply -> 200");
    assertEq(applyRes.body.dry_run, false, "l2: dry_run:false echoed on apply");
    assertEq(applyRes.body.applied_count, 1, "l3: applied_count=1");
    assertEq(applyRes.body.results[0].status, "applied", "l4: apply reports applied");
    {
      const row = readClinic("wd-approve-a");
      assertEq(row.hjemmeside, "https://sorvesttannlege.no", "l5: hjemmeside written");
      const prov = JSON.parse(row.field_provenance);
      assertTrue(!!prov.telefon, "l6: pre-existing 'telefon' provenance survives the merge");
      assertEq(prov.telefon.value, "12345678", "l7: pre-existing 'telefon' provenance value untouched");
      assertTrue(!!prov.hjemmeside, "l8: new 'hjemmeside' provenance entry present");
      assertEq(prov.hjemmeside.value, "https://sorvesttannlege.no", "l9: hjemmeside provenance records the written value");
      assertEq(prov.hjemmeside.source_type, "brreg_registered_website", "l10: hjemmeside provenance records its source_type");
      const q = readQueueRow("wd-approve-a");
      assertEq(q.status, "applied", "l11: queue row flipped to 'applied'");
    }

    // ── (m) repeat apply on an already-filled row -> no_longer_blank ─────
    const repeat = await postApprove({ approvals: [{ agent_id: "wd-approve-a", url: "https://sorvesttannlege.no" }], apply: true });
    assertEq(repeat.status, 200, "m1: repeat apply -> 200, never a throw");
    assertEq(repeat.body.applied_count, 0, "m2: repeat apply writes nothing");
    assertEq(repeat.body.skipped[0]?.reason, "not_in_review_queue", "m3: repeat apply's queue row is no longer pending -> not_in_review_queue");

    // A row that was NEVER queued but has since had hjemmeside filled some
    // other way, approved against a queue entry inserted directly:
    seedClinic({ id: "wd-already-blank-race", navn: "Blank Tannlege AS", org_nr: "121212121", hjemmeside: "https://someone-else-filled-this.no" });
    dentalDb.prepare(
      `INSERT INTO dental_website_review_queue (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
       VALUES ('q-race', 'wd-already-blank-race', 'Blank Tannlege AS', 'https://blanktannlege.no', 'https://blanktannlege.no', '{}', 0.9, 'website_discovery_candidate', 'batch-y', 'pending', datetime('now'), datetime('now'))`,
    ).run();
    const raceApply = await postApprove({ approvals: [{ agent_id: "wd-already-blank-race", url: "https://blanktannlege.no" }], apply: true });
    assertEq(raceApply.body.skipped[0]?.reason, "no_longer_blank", "m4: hjemmeside filled since queueing -> no_longer_blank, not a throw");
    assertEq(raceApply.status, 200, "m5: no_longer_blank is still a 200, not an error");

    // ── (n) mismatch / not_in_review_queue ─────────────────────────────────
    seedClinic({ id: "wd-approve-mismatch", navn: "Mismatch Tannlege AS", org_nr: "131313131" });
    dentalDb.prepare(
      `INSERT INTO dental_website_review_queue (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
       VALUES ('q-mismatch', 'wd-approve-mismatch', 'Mismatch Tannlege AS', 'https://riktig-url.no', 'https://riktig-url.no', '{}', 0.9, 'website_discovery_candidate', 'batch-z', 'pending', datetime('now'), datetime('now'))`,
    ).run();
    const mismatch = await postApprove({ approvals: [{ agent_id: "wd-approve-mismatch", url: "https://feil-url.no" }], apply: true });
    assertEq(mismatch.body.skipped[0]?.reason, "mismatch_with_queued_candidate", "n1: url mismatch -> mismatch_with_queued_candidate");
    const neverQueued = await postApprove({ approvals: [{ agent_id: "does-not-exist-in-queue", url: "https://x.no" }], apply: true });
    assertEq(neverQueued.body.skipped[0]?.reason, "not_in_review_queue", "n2: agent never queued -> not_in_review_queue");

    // ── (p) DENTAL_WD_HEADLESS_FALLBACK_ENABLED unset/false (default) ────────
    // Fix-up, Finding 2: this route's headless-render escalation was never
    // part of dev-request 2026-08-14-fetch-vegg-headless-fallback's stated
    // scope, so it must stay off by default even though render-page.ts's
    // renderer now has a real production backend. A "JS shell" fixture —
    // big enough (>= RENDER_ESCALATION_MIN_BYTES), carries a <script>, and
    // its visible text is a handful of characters — is the exact shape
    // shouldEscalateToRender() (services/render-page.ts) looks for; if the
    // flag were on, this fixture WOULD escalate. With the flag unset, it
    // must not: renderPage is never invoked, and the outcome is the same
    // insufficient_evidence a plain-fetch-only world produces (no evidence
    // anywhere in the tiny visible text).
    {
      delete process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED;
      let renderCalls = 0;
      routeMod.__setDentalWdRenderPageImplForTesting(async () => {
        renderCalls++;
        throw new Error("renderPage must never be called while DENTAL_WD_HEADLESS_FALLBACK_ENABLED is off");
      });

      const jsShellPadding = "x".repeat(2500);
      seedClinic({ id: "wd-hf-off", navn: "Fallback Off Tannlege AS", org_nr: "232323232", poststed: "Ålesund" });
      brregFixtures.set("232323232", { hjemmeside: "https://hfofftannlege.no" });
      pageFixtures.set(
        "https://hfofftannlege.no",
        htmlResponse(`<html><body><script>var pad = "${jsShellPadding}";</script><div id="root">App</div></body></html>`, {
          finalUrl: "https://hfofftannlege.no",
        }),
      );

      const batchP = await postDiscovery({ agentIds: ["wd-hf-off"] });
      assertEq(batchP.status, 200, "p1: 200");
      const resultP = (batchP.body.results as any[]).find((r) => r.agent_id === "wd-hf-off");
      assertEq(resultP?.status, "insufficient_evidence", "p2: nothing changes with the flag off — same outcome as plain-fetch-only");
      assertTrue(!readQueueRow("wd-hf-off"), "p3: nothing queued");
      assertEq(renderCalls, 0, "p4: renderPage was never invoked while the flag is unset");

      routeMod.__setDentalWdRenderPageImplForTesting(null);
      delete process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED;
    }

    // ── (o) approve cap ─────────────────────────────────────────────────────
    const approveCap = routeMod.DENTAL_WD_APPROVE_MAX;
    assertEq(approveCap, 200, "o0: DENTAL_WD_APPROVE_MAX is 200");
    const tooManyApprovals = Array.from({ length: approveCap + 1 }, (_, i) => ({ agent_id: `bulk-${i}`, url: "https://x.no" }));
    const overApproveCap = await postApprove({ approvals: tooManyApprovals });
    assertEq(overApproveCap.status, 400, "o1: more than DENTAL_WD_APPROVE_MAX approvals -> 400");

    // ── (q) navnesøk (name-search) fallback leg — dev-request 2026-08-15-
    // dental-hjemmeside-brreg-navnesoek, item 3 navnesøk leg. Uses the
    // route's own injectable search seam (__setDentalWdSearchForTesting) —
    // no real network. Each block installs its own stub and clears it (back
    // to null, mirroring "no Brave key" in production) in a finally, so a
    // block that throws never leaks a search seam into a later block.
    assertEq(routeMod.DENTAL_WD_SEARCH_MAX_CANDIDATES, 5, "q0: DENTAL_WD_SEARCH_MAX_CANDIDATES is 5");

    // (q1) Brreg leg finds nothing (no_brreg_website) + a search stub wired
    // -> a search hit with org_nr_found evidence gets queued with
    // reason: 'navnesok_fallback', and search_attempted: true.
    {
      seedClinic({ id: "wd-nav-orgnr", navn: "Nordlys Tannklinikk", org_nr: "343434343", poststed: "Harstad" });
      // No brregFixtures entry for 343434343 -> tier 1 = no_brreg_website.
      pageFixtures.set(
        "https://nordlystannklinikk.no",
        htmlResponse("<html><body>Nordlys Tannklinikk — org.nr 343 434 343 — Harstad</body></html>", {
          finalUrl: "https://nordlystannklinikk.no",
        }),
      );
      let searchCalls: string[] = [];
      routeMod.__setDentalWdSearchForTesting(async (query: string) => {
        searchCalls.push(query);
        return [{ title: "Nordlys Tannklinikk", url: "https://nordlystannklinikk.no", description: "Harstad" }];
      });
      try {
        const r = await postDiscovery({ agentIds: ["wd-nav-orgnr"] });
        const entry = (r.body.results as any[]).find((e) => e.agent_id === "wd-nav-orgnr");
        assertEq(entry?.status, "queued", "q1a: search hit with org_nr_found evidence -> queued");
        assertEq(entry?.search_attempted, true, "q1b: search_attempted true — tier 2 actually ran");
        assertEq(entry?.evidence?.org_nr_found, true, "q1c: verified via org_nr, same evidence contract as tier 1");
        const row = readQueueRow("wd-nav-orgnr");
        assertTrue(!!row, "q1d: a queue row was inserted");
        assertEq(row.reason, "navnesok_fallback", "q1e: queue row tagged reason='navnesok_fallback'");
        assertEq(row.candidate_url, "https://nordlystannklinikk.no", "q1f: queue row candidate_url is the search-discovered host");
        assertEq(searchCalls.length, 1, "q1g: exactly one braveSearch-seam call for this row");
      } finally {
        routeMod.__setDentalWdSearchForTesting(null);
      }
    }

    // (q2) Brreg leg finds an aggregator host (aggregator_host) + a search
    // stub wired, but the search hit's page carries only weak/no evidence
    // -> NOT queued; the ORIGINAL Brreg-leg skip status ('aggregator_host')
    // is preserved untouched, search_attempted: true (tier 2 ran and found
    // nothing).
    {
      seedClinic({ id: "wd-nav-weak", navn: "Solskinn Tannlege AS", org_nr: "353535353", poststed: "Bodø" });
      brregFixtures.set("353535353", { hjemmeside: "https://legelisten.no/solskinn-tannlege" });
      // No pageFixtures entry for legelisten.no — tier 1 excludes it before
      // any fetch (aggregator_host), same as case (d).
      pageFixtures.set(
        "https://solskinn-info.no",
        htmlResponse("<html><body>Ingen relevant informasjon her, bare en parkert side.</body></html>", {
          finalUrl: "https://solskinn-info.no",
        }),
      );
      routeMod.__setDentalWdSearchForTesting(async () => [
        { title: "Solskinn", url: "https://solskinn-info.no", description: "" },
      ]);
      try {
        const r = await postDiscovery({ agentIds: ["wd-nav-weak"] });
        const entry = (r.body.results as any[]).find((e) => e.agent_id === "wd-nav-weak");
        assertEq(entry?.status, "aggregator_host", "q2a: weak/no search-hit evidence -> ORIGINAL tier-1 skip status ('aggregator_host') preserved, not insufficient_evidence");
        assertEq(entry?.search_attempted, true, "q2b: search_attempted true — tier 2 ran but found nothing");
        assertTrue(!readQueueRow("wd-nav-weak"), "q2c: nothing queued");
      } finally {
        routeMod.__setDentalWdSearchForTesting(null);
      }
    }

    // (q3) + (q4, cost control): a search response's FIRST candidate host is
    // a known aggregator/directory domain (excluded via classifyHjemmeside,
    // never fetched) and its SECOND candidate host verifies -> queued via
    // the second host, and — despite trying two different HOST attempts —
    // only ONE braveSearch-seam call was made for the row (cost control:
    // mirrors RFB's own wd-10a test, opplevelser-gardssalg-website-
    // discovery.test.ts).
    {
      seedClinic({ id: "wd-nav-multihost", navn: "Vestfjord Tannlege AS", org_nr: "363636363", poststed: "Narvik" });
      // No brregFixtures entry for 363636363 -> tier 1 = no_brreg_website.
      pageFixtures.set(
        "https://vestfjordtannlege-ekte.no",
        htmlResponse("<html><body>Vestfjord Tannlege — org.nr 363 636 363 — Narvik</body></html>", {
          finalUrl: "https://vestfjordtannlege-ekte.no",
        }),
      );
      // Deliberately NO pageFixtures entry for legelisten.no — if the route
      // ever fetched the excluded first host, stubFetch would throw.
      const searchCallsQ3: string[] = [];
      routeMod.__setDentalWdSearchForTesting(async (query: string) => {
        searchCallsQ3.push(query);
        return [
          { title: "Vestfjord — Legelisten", url: "https://legelisten.no/vestfjord-tannlege", description: "" },
          { title: "Vestfjord Tannlege", url: "https://vestfjordtannlege-ekte.no", description: "Narvik" },
        ];
      });
      try {
        const r = await postDiscovery({ agentIds: ["wd-nav-multihost"] });
        const entry = (r.body.results as any[]).find((e) => e.agent_id === "wd-nav-multihost");
        assertEq(entry?.status, "queued", "q3a: second candidate host (after the first is excluded) verifies -> queued");
        assertEq(entry?.candidate_url, "https://vestfjordtannlege-ekte.no", "q3b: queued candidate is the SECOND (verified) host, not the excluded first one");
        assertTrue(!fetchCalls.includes("https://legelisten.no/vestfjord-tannlege"), "q3c: the excluded aggregator host was NEVER fetched");
        const row = readQueueRow("wd-nav-multihost");
        assertEq(row.reason, "navnesok_fallback", "q3d: queue row tagged reason='navnesok_fallback'");
        assertEq(searchCallsQ3.length, 1, "q4: exactly ONE braveSearch-seam call per candidate row, even though TWO host attempts were made against its one result set — cost control");
      } finally {
        routeMod.__setDentalWdSearchForTesting(null);
      }
    }

    // (q5) NO search seam wired (routeMod's default — the seam is reset to
    // null after every block above) -> a Brreg-leg failure returns its
    // ORIGINAL skip status untouched, tier 2 is NEVER attempted (no
    // search-seam call at all), search_attempted: false. Reuses (e)'s own
    // no_brreg_website result from batch1, computed earlier in this run
    // while no search seam was ever installed.
    {
      assertEq(byId.get("wd-no-brreg")?.status, "no_brreg_website", "q5a: no search seam wired -> ORIGINAL Brreg-leg skip status untouched");
      assertEq(byId.get("wd-no-brreg")?.search_attempted, false, "q5b: search_attempted false — tier 2 never attempted without a wired search seam");
      assertTrue(!readQueueRow("wd-no-brreg"), "q5c: still nothing queued");
    }

    // (q6) approve route's provenance stamp, keyed by the queue row's own
    // `reason`: a 'navnesok_fallback'-tagged row writes source_type
    // 'search_verified_website'; a 'brreg_field'-tagged row still writes
    // 'brreg_registered_website' — regression check on the Brreg leg's own
    // EXISTING provenance value (unchanged), now using the leg's own actual
    // reason literal ('brreg_field') rather than (l10)'s pre-existing
    // manually-inserted legacy literal.
    {
      seedClinic({ id: "wd-nav-approve-search", navn: "Fallback Approve Tannlege AS", org_nr: "373737373" });
      dentalDb.prepare(
        `INSERT INTO dental_website_review_queue (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
         VALUES ('q-nav-search', 'wd-nav-approve-search', 'Fallback Approve Tannlege AS', 'https://fallbackapprove.no', 'https://fallbackapprove.no', '{"org_nr_found":true}', 1.0, 'navnesok_fallback', 'batch-q', 'pending', datetime('now'), datetime('now'))`,
      ).run();
      const applySearch = await postApprove({ approvals: [{ agent_id: "wd-nav-approve-search", url: "https://fallbackapprove.no" }], apply: true });
      assertEq(applySearch.body.applied_count, 1, "q6a: navnesok_fallback-tagged row applies successfully");
      const provSearch = JSON.parse(readClinic("wd-nav-approve-search").field_provenance).hjemmeside;
      assertEq(provSearch.source_type, "search_verified_website", "q6b: navnesok_fallback-tagged row writes source_type='search_verified_website'");

      seedClinic({ id: "wd-nav-approve-brreg", navn: "Brreg Approve Tannlege AS", org_nr: "383838383" });
      dentalDb.prepare(
        `INSERT INTO dental_website_review_queue (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
         VALUES ('q-nav-brreg', 'wd-nav-approve-brreg', 'Brreg Approve Tannlege AS', 'https://brregapprove.no', 'https://brregapprove.no', '{"org_nr_found":true}', 1.0, 'brreg_field', 'batch-q', 'pending', datetime('now'), datetime('now'))`,
      ).run();
      const applyBrreg = await postApprove({ approvals: [{ agent_id: "wd-nav-approve-brreg", url: "https://brregapprove.no" }], apply: true });
      assertEq(applyBrreg.body.applied_count, 1, "q6c: brreg_field-tagged row applies successfully");
      const provBrreg = JSON.parse(readClinic("wd-nav-approve-brreg").field_provenance).hjemmeside;
      assertEq(provBrreg.source_type, "brreg_registered_website", "q6d: brreg_field-tagged row still writes source_type='brreg_registered_website' (unchanged from the existing leg's own regression coverage in (l10))");
    }

    // (q7) tier-2 evidence gate — the SAME phone+name-only-without-org_nr/
    // place fixture pattern as tier 1's own (c2) above, mirrored onto the
    // search leg: the search hit's page carries phone_found + name_found
    // evidence (so gardssalgWebsiteEvidenceMatch's own looser `verified`
    // would be TRUE, per its own `phoneFound && (nameFound || placeFound)`
    // branch) but NOT org_nr_found and NOT (name_found && place_found) — so
    // processDentalWdSearchLeg's own gate (mirrors processDentalWdBrregLeg's,
    // deliberately narrower than `verified`) must reject it. Proves the SAME
    // bug class (c2's own comment: "PR #600 review: swapping the strict gate
    // for evidence.verified passed all other tests unnoticed") is now also
    // caught on tier 2's own copy of the gate, not just tier 1's.
    {
      seedClinic({ id: "wd-nav-phone-only", navn: "Lyngen Tannlege", org_nr: "394949494", poststed: "Alta", telefon: "90112233" });
      // No brregFixtures entry for 394949494 -> tier 1 = no_brreg_website.
      pageFixtures.set(
        "https://lyngen-info.no",
        htmlResponse("<html><body>Lyngen Tannlege — ring oss på 901 12 233 for time.</body></html>", {
          finalUrl: "https://lyngen-info.no",
        }),
      );
      routeMod.__setDentalWdSearchForTesting(async () => [
        { title: "Lyngen Tannlege", url: "https://lyngen-info.no", description: "" },
      ]);
      try {
        const r = await postDiscovery({ agentIds: ["wd-nav-phone-only"] });
        const entry = (r.body.results as any[]).find((e) => e.agent_id === "wd-nav-phone-only");
        assertEq(entry?.status, "no_brreg_website", "q7a: phone+name-only search-hit evidence -> ORIGINAL tier-1 skip status ('no_brreg_website') preserved, NOT queued (narrower than evidence.verified, mirrors c2 for tier 2)");
        assertEq(entry?.search_attempted, true, "q7b: search_attempted true — tier 2 actually ran and evaluated the candidate");
        assertTrue(!readQueueRow("wd-nav-phone-only"), "q7c: nothing queued for the phone+name-only search hit");
      } finally {
        routeMod.__setDentalWdSearchForTesting(null);
      }
    }

    // (q8) tier-1-already-queued short circuit: when tier 1 already queued a
    // candidate for this row, tier 2 must NEVER run — even when a search
    // seam IS wired. The wired stub here would (if ever invoked) return a
    // DIFFERENT, independently-verifiable candidate host — proving this
    // isn't merely "tier 2 also found nothing", but that tier 2 is never
    // attempted at all once tier 1 has already succeeded.
    {
      seedClinic({ id: "wd-tier1-then-search", navn: "Bjerke Tannlege", org_nr: "404040404", poststed: "Kristiansund" });
      brregFixtures.set("404040404", { hjemmeside: "https://bjerketannlege.no" });
      pageFixtures.set(
        "https://bjerketannlege.no",
        htmlResponse("<html><body>Bjerke Tannlege — org.nr 404 040 404</body></html>", {
          finalUrl: "https://bjerketannlege.no",
        }),
      );
      // If tier 2 were ever reached, this alternate host would ALSO verify
      // (org_nr_found) and get queued in tier 1's place — so a successful
      // "nothing changed" assertion below genuinely proves the short circuit
      // fired, not just that tier 2 happened to find nothing.
      pageFixtures.set(
        "https://different-verified-site.no",
        htmlResponse("<html><body>Bjerke Tannlege — org.nr 404 040 404</body></html>", {
          finalUrl: "https://different-verified-site.no",
        }),
      );
      const searchCallsQ8: string[] = [];
      routeMod.__setDentalWdSearchForTesting(async (query: string) => {
        searchCallsQ8.push(query);
        return [{ title: "Bjerke Tannlege (alternate)", url: "https://different-verified-site.no", description: "" }];
      });
      try {
        const r = await postDiscovery({ agentIds: ["wd-tier1-then-search"] });
        const entry = (r.body.results as any[]).find((e) => e.agent_id === "wd-tier1-then-search");
        assertEq(entry?.status, "queued", "q8a: tier 1 already queued -> still queued");
        assertEq(entry?.candidate_url, "https://bjerketannlege.no", "q8b: queued candidate is tier 1's OWN candidate, untouched — not tier 2's alternate host");
        assertEq(entry?.search_attempted, false, "q8c: search_attempted false — tier 2 never attempted once tier 1 already queued");
        assertEq(searchCallsQ8.length, 0, "q8d: the search seam's own call counter stays at 0 — braveSearch/searchFn is NEVER invoked when tier 1 already queued");
        const row = readQueueRow("wd-tier1-then-search");
        assertEq(row.reason, "brreg_field", "q8e: queue row still tagged reason='brreg_field' — never overwritten by a tier-2 upsert");
        assertEq(row.candidate_url, "https://bjerketannlege.no", "q8f: queue row candidate_url is tier 1's own, unchanged");
      } finally {
        routeMod.__setDentalWdSearchForTesting(null);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-dental-hjemmeside-discovery: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevHeadlessFallbackEnabled === undefined) delete process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED;
    else process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED = prevHeadlessFallbackEnabled;
    if (prevBraveApiKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = prevBraveApiKey;
    if (prevBraveSearchApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = prevBraveSearchApiKey;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-dental-hjemmeside-discovery.test.ts`
if (require.main === module) {
  runAdminDentalHjemmesideDiscoveryTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

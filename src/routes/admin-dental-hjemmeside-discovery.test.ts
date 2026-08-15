/**
 * admin-dental-hjemmeside-discovery.test.ts — tests for
 * dev-request 2026-08-15-dental-hjemmeside-brreg-navnesoek, item 3 (Brreg-
 * field leg): POST /admin/dental/hjemmeside-discovery-batch + POST
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
  const testKey = process.env.ADMIN_KEY || "dental-wd-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;

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

    // ── (o) approve cap ─────────────────────────────────────────────────────
    const approveCap = routeMod.DENTAL_WD_APPROVE_MAX;
    assertEq(approveCap, 200, "o0: DENTAL_WD_APPROVE_MAX is 200");
    const tooManyApprovals = Array.from({ length: approveCap + 1 }, (_, i) => ({ agent_id: `bulk-${i}`, url: "https://x.no" }));
    const overApproveCap = await postApprove({ approvals: tooManyApprovals });
    assertEq(overApproveCap.status, 400, "o1: more than DENTAL_WD_APPROVE_MAX approvals -> 400");
  } catch (err: any) {
    failed++;
    failures.push("admin-dental-hjemmeside-discovery: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

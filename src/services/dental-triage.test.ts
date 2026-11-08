/**
 * dental-triage.test.ts — dev-request 2026-09-02-dental-permanent-triage-
 * needs-review-drain, slice 3c-1 (src/services/dental-triage.ts and
 * POST /admin/dental/triage/{dry-run,run}, src/routes/admin-dental-triage.ts).
 *
 * Setup mirrors admin-dental-write-pause.test.ts: in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + __resetDbFactoryForTesting() (the real dental
 * schema), the main DB pinned in memory for the write-pause row, router.handle()
 * with fake req/res. Every Brreg / homepage read goes through an injected fake
 * fetch (never the network).
 *
 * Covers: flag off = zero writes; pause active = zero writes; Brreg deleted ->
 * inactive + audit row; directory homepage -> directory_url/raw + audit;
 * undecided stays needs_review (and is not re-picked inside the recheck
 * window); limit + oldest-first ordering; the Verified rule -> verified;
 * dry-run writes nothing; Brreg failure (throw / 5xx) -> undecided, never
 * verified; admin endpoints 403 without key, /run 503 while the flag is off,
 * 423 under the pause.
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
  path: string,
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
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
      resolve({ status: err ? 500 : 404, body: { error: err ? String(err) : "not handled" } });
    });
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function runDentalTriageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevFlag = process.env.DENTAL_TRIAGE_JOB_ENABLED;
    const testKey = process.env.ADMIN_KEY || "dental-triage-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.DENTAL_TRIAGE_JOB_ENABLED;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./dental-store"),
      require.resolve("./dental-verifier"),
      require.resolve("./dental-enrichment-write-pause"),
      require.resolve("./dental-triage"),
      require.resolve("../routes/admin-dental-mark-inactive"),
      require.resolve("../routes/admin-dental-hjemmeside-cleanup"),
      require.resolve("../routes/admin-dental-triage"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const initMod = require("../database/init") as typeof import("../database/init");
    const restoreMainDb = initMod.__pinInMemoryDbForTesting();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");
      const mainDb = initMod.getDb();
      const brregClient = require("./brreg-client") as typeof import("./brreg-client");
      brregClient.__clearBrregVerifyCacheForTesting();
      const triage = require("./dental-triage") as typeof import("./dental-triage");
      const pauseSvc = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");

      // ── Fake fetch: Brreg by org-nr, homepages by host ─────────────────
      const enhet = (org: string, extra: Record<string, unknown> = {}) => ({
        organisasjonsnummer: org, navn: "X", naeringskode1: { kode: "86.230" }, ...extra,
      });
      const brregBehaviour: Record<string, () => Response> = {
        "900000001": () => jsonResponse(410, { organisasjonsnummer: "900000001", slettedato: "2025-01-01" }),
        "900000002": () => jsonResponse(200, enhet("900000002")),
        "900000003": () => { throw new Error("ECONNRESET"); },
        "900000004": () => jsonResponse(503, { error: "down" }),
        "900000005": () => jsonResponse(200, enhet("900000005")),
        "900000006": () => jsonResponse(200, enhet("900000006", { slettedato: "2024-06-01" })),
        "900000007": () => jsonResponse(200, enhet("900000007")),
      };
      // org_nr is UNIQUE: every other deleted fixture gets its own 410 org-nr.
      for (const org of ["900000011", "900000012", "900000013", "900000014", "900000015"]) {
        brregBehaviour[org] = () => jsonResponse(410, { organisasjonsnummer: org, slettedato: "2025-01-01" });
      }
      let fetchCalls = 0;
      const fakeFetch = (async (input: any) => {
        fetchCalls++;
        const url = String(input);
        if (url.includes("/underenheter")) return jsonResponse(200, { _embedded: { underenheter: [] } });
        const m = url.match(/\/enheter\/(\d{9})/);
        if (m) {
          const b = brregBehaviour[m[1]];
          return b ? b() : jsonResponse(404, {});
        }
        if (url.includes("verified-clinic.example.no")) {
          return new Response("<html>Verifisert Tannklinikk, Bergen 5003. Org.nr 900000005</html>", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const freshIso = new Date(Date.now() - 86_400_000).toISOString();
      const ins = db.prepare(
        `INSERT INTO dental_agents (id, navn, org_nr, hjemmeside, directory_url, poststed, postnummer, catalog_class,
            enrichment_state, verification_status, review_reason, review_since,
            website_ownership, website_ownership_checked_at, om_oss, specialists, treatment_tech, field_provenance, created_at)
         VALUES (@id, @navn, @org_nr, @hjemmeside, @directory_url, @poststed, @postnummer, @catalog_class,
            @enrichment_state, @verification_status, @review_reason, @review_since,
            @website_ownership, @website_ownership_checked_at, @om_oss, @specialists, @treatment_tech, @field_provenance, @created_at)`,
      );
      const seed = (r: Record<string, unknown>) =>
        ins.run({
          org_nr: null, hjemmeside: null, directory_url: null, poststed: "BERGEN", postnummer: "5003", catalog_class: "klinikk",
          enrichment_state: "enriched", verification_status: "needs_review", review_reason: "wrong_entity_repeat",
          review_since: "2026-09-10T00:00:00.000Z", website_ownership: null, website_ownership_checked_at: null,
          om_oss: null, specialists: null, treatment_tech: null, field_provenance: null, created_at: "2026-01-01T00:00:00Z",
          ...r,
        });

      // t-deleted: Brreg 410 -> inactive
      seed({ id: "t-deleted", navn: "Slettet Tannlege AS", org_nr: "900000001", review_since: "2026-09-01T00:00:00.000Z",
        field_provenance: JSON.stringify({ telefon: { source_type: "brreg", value: "1" } }) });
      // t-dir: directory homepage (legelisten.no), Brreg active
      seed({ id: "t-dir", navn: "Katalog Tannlege AS", org_nr: "900000002", hjemmeside: "https://legelisten.no/tannlege/x",
        review_reason: "dead_homepage_repeat", review_since: "2026-09-02T00:00:00.000Z" });
      // t-throw: would meet the Verified rule, but Brreg throws
      seed({ id: "t-throw", navn: "Kast Tannlege AS", org_nr: "900000003", review_since: "2026-09-03T00:00:00.000Z",
        website_ownership: "verified", website_ownership_checked_at: freshIso, hjemmeside: "https://kast.example.no",
        om_oss: "Om oss", specialists: "[\"a\"]", treatment_tech: "[\"b\"]" });
      // t-5xx: would meet the Verified rule, but Brreg answers 503
      seed({ id: "t-5xx", navn: "Nede Tannlege AS", org_nr: "900000004", review_since: "2026-09-04T00:00:00.000Z",
        website_ownership: "verified", website_ownership_checked_at: freshIso, hjemmeside: "https://nede.example.no",
        om_oss: "Om oss", specialists: "[\"a\"]", treatment_tech: "[\"b\"]" });
      // t-verified: Brreg active, homepage matches (fetched), 3 rich fields
      seed({ id: "t-verified", navn: "Verifisert Tannklinikk AS", org_nr: "900000005", review_since: "2026-09-05T00:00:00.000Z",
        hjemmeside: "https://verified-clinic.example.no", review_reason: "insufficient_yield_repeat",
        om_oss: "Om oss", specialists: "[\"a\"]", treatment_tech: "[\"b\"]" });
      // t-undecided: Brreg active, no rich fields -> rule not met
      seed({ id: "t-undecided", navn: "Uavklart Tannlege AS", org_nr: "900000007", review_since: "2026-09-06T00:00:00.000Z" });
      // t-noorg: no org-nr, own homepage -> undecided no_orgnr
      seed({ id: "t-noorg", navn: "Uten Orgnr Tannlege", review_since: "2026-09-07T00:00:00.000Z", hjemmeside: "https://egen.example.no" });
      // t-slettedato: 200 with slettedato -> inactive (newest)
      seed({ id: "t-slettedato", navn: "Gammel Tannlege AS", org_nr: "900000006", review_since: "2026-09-08T00:00:00.000Z" });
      // Not candidates: other review_reason, already inactive, not needs_review
      seed({ id: "x-other-reason", navn: "Annen Grunn AS", org_nr: "900000011", review_reason: "brreg_nace_mismatch", review_since: "2026-08-01T00:00:00.000Z" });
      seed({ id: "x-pending", navn: "Pending AS", org_nr: "900000012", verification_status: "pending_verify", review_since: "2026-08-01T00:00:00.000Z" });
      seed({ id: "x-inactive", navn: "Allerede Nedlagt AS", org_nr: "900000013", review_since: "2026-08-01T00:00:00.000Z" });
      db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE id = 'x-inactive'").run();

      const snapshot = () =>
        JSON.stringify({
          a: db.prepare("SELECT * FROM dental_agents ORDER BY id").all(),
          f: db.prepare("SELECT * FROM dental_verifier_findings ORDER BY id").all(),
        });
      const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      const rowOf = (id: string) => db.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id) as any;
      const findingsOf = (id: string) =>
        db.prepare("SELECT * FROM dental_verifier_findings WHERE agent_id = ? AND check_type = 'dental_triage'").all(id) as any[];
      const noPause = () => null;

      // ── Flag parsing ────────────────────────────────────────────────────
      assertEq(triage.dentalTriageJobEnabled({}), false, "flag: unset -> off");
      assertEq(triage.dentalTriageJobEnabled({ DENTAL_TRIAGE_JOB_ENABLED: "1" }), false, "flag: '1' -> off");
      assertEq(triage.dentalTriageJobEnabled({ DENTAL_TRIAGE_JOB_ENABLED: "TRUE" }), false, "flag: 'TRUE' -> off");
      assertEq(triage.dentalTriageJobEnabled({ DENTAL_TRIAGE_JOB_ENABLED: "true" }), true, "flag: 'true' -> on");
      assertEq(triage.clampDentalTriageLimit(500), 50, "limit: clamped to 50");
      assertEq(triage.clampDentalTriageLimit(0), 1, "limit: clamped to 1");
      assertEq(triage.clampDentalTriageLimit("x"), 50, "limit: junk -> default 50");
      assertEq(triage.isDentalTriageDue(null, new Date()), true, "due: never ran -> due");
      assertEq(triage.isDentalTriageDue(new Date(Date.now() - 86_400_000), new Date()), false, "due: 1 day ago -> not due");
      assertEq(triage.isDentalTriageDue(new Date(Date.now() - 8 * 86_400_000), new Date()), true, "due: 8 days ago -> due");

      // ── Ordering + limit ────────────────────────────────────────────────
      const picked = triage.pickDentalTriageCandidates(db, 3).map((r) => r.id);
      assertEq(picked, ["t-deleted", "t-dir", "t-throw"], "pick: oldest review_since first, limit 3");
      const all = triage.pickDentalTriageCandidates(db, 50).map((r) => r.id);
      assertEq(all.length, 8, "pick: only needs_review + slice-3b reason + active rows (8)");
      assertTrue(!all.includes("x-other-reason") && !all.includes("x-pending") && !all.includes("x-inactive"),
        "pick: other reason / not needs_review / already inactive excluded");

      // ── Flag off: zero writes, no network ───────────────────────────────
      let before = snapshot();
      let c0 = changes();
      fetchCalls = 0;
      const off = await triage.runDentalTriage({ db, fetchImpl: fakeFetch, pauseBlock: noPause, env: {} });
      assertEq(off.disabled, true, "flag off: disabled:true");
      assertEq(off.candidates, 0, "flag off: nothing picked");
      assertEq(changes() - c0, 0, "flag off: zero DB changes");
      assertEq(snapshot(), before, "flag off: DB byte-identical");
      assertEq(fetchCalls, 0, "flag off: no network");

      // ── Pause active: zero writes ───────────────────────────────────────
      const ON = { DENTAL_TRIAGE_JOB_ENABLED: "true" };
      c0 = changes();
      const paused = await triage.runDentalTriage({
        db, fetchImpl: fakeFetch, env: ON,
        pauseBlock: () => ({ error: "x", paused: true, vertical: "dental", reason: "test pause", triggered_at: null, fail_closed: false } as any),
      });
      assertEq(paused.paused, true, "pause: paused:true");
      assertEq(changes() - c0, 0, "pause: zero DB changes");
      assertEq(snapshot(), before, "pause: DB byte-identical");
      // Pause set while the run is under way: stops before the next write.
      let pauseCalls = 0;
      c0 = changes();
      const midPause = await triage.runDentalTriage({
        db, fetchImpl: fakeFetch, env: ON,
        pauseBlock: () => (++pauseCalls > 1 ? ({ reason: "mid-run", fail_closed: false } as any) : null),
      });
      assertEq(midPause.paused, true, "mid-run pause: paused:true");
      assertEq(changes() - c0, 0, "mid-run pause: zero DB changes");

      // ── Dry-run: decisions, zero writes (flag off) ──────────────────────
      before = snapshot();
      c0 = changes();
      const dry = await triage.computeDentalTriageDryRun({ db, fetchImpl: fakeFetch, env: {} });
      assertEq(changes() - c0, 0, "dry-run: zero DB changes");
      assertEq(snapshot(), before, "dry-run: DB byte-identical");
      assertEq(dry.candidates, 8, "dry-run: 8 candidates");
      assertEq(dry.flag_enabled, false, "dry-run: works with the flag off");
      const dmap: Record<string, string> = {};
      for (const d of [...dry.decisions, ...dry.undecided]) dmap[d.id] = `${d.decision}:${d.reason}`;
      assertEq(dmap["t-deleted"], "inactive:brreg_dissolved", "dry-run: 410 -> inactive");
      assertEq(dmap["t-slettedato"], "inactive:brreg_dissolved", "dry-run: slettedato -> inactive");
      assertEq(dmap["t-dir"], "directory_homepage:hjemmeside_directory", "dry-run: legelisten -> directory_homepage");
      assertEq(dmap["t-verified"], "verified:verified_rule_met", "dry-run: Verified rule -> verified");
      assertEq(dmap["t-throw"], "undecided:brreg_unreachable", "dry-run: Brreg throws -> undecided");
      assertEq(dmap["t-5xx"], "undecided:brreg_unreachable", "dry-run: Brreg 503 -> undecided");
      assertEq(dmap["t-undecided"], "undecided:verified_rule_not_met", "dry-run: rule not met -> undecided");
      assertEq(dmap["t-noorg"], "undecided:no_orgnr", "dry-run: no org-nr -> undecided");
      assertTrue(dry.decisions.every((d: any) => d.apply === undefined), "dry-run: no internal apply payload in the response");
      const dryIds = await triage.computeDentalTriageDryRun({ db, fetchImpl: fakeFetch, ids: ["t-dir", "x-pending", "nope"] });
      assertEq(dryIds.candidates, 1, "dry-run ids: only rows in triage state");
      assertEq(dryIds.not_candidates, ["x-pending", "nope"], "dry-run ids: not_candidates listed");

      // ── Real run ────────────────────────────────────────────────────────
      const run = await triage.runDentalTriage({ db, fetchImpl: fakeFetch, pauseBlock: noPause, env: ON });
      assertEq(run.disabled, false, "run: not disabled");
      assertEq(run.candidates, 8, "run: 8 candidates");
      assertEq([run.inactive, run.directory_homepage, run.verified, run.undecided], [2, 1, 1, 4], "run: counts inactive/dir/verified/undecided");
      assertEq(run.undecided_reasons, { brreg_unreachable: 2, verified_rule_not_met: 1, no_orgnr: 1 }, "run: undecided reasons");

      const del = rowOf("t-deleted");
      assertEq([del.is_inactive, del.inactive_reason, del.brreg_status], [1, "brreg_dissolved", "dissolved"], "inactive: is_inactive/reason/brreg_status");
      assertTrue(!!del.inactive_since, "inactive: inactive_since set");
      const delProv = JSON.parse(del.field_provenance);
      assertEq(delProv.inactive?.reason, "brreg_dissolved", "inactive: field_provenance.inactive entry");
      assertEq(delProv.telefon?.value, "1", "inactive: other provenance kept");
      const delF = findingsOf("t-deleted");
      assertEq(delF.length, 1, "inactive: one audit row");
      assertEq([delF[0]?.status, delF[0]?.notes], ["inactive", "brreg_dissolved"], "inactive: audit status/notes");
      assertEq(JSON.parse(delF[0]?.evidence ?? "{}").brreg?.slettet, true, "inactive: audit evidence carries Brreg slettet");

      const dir = rowOf("t-dir");
      assertEq([dir.hjemmeside, dir.directory_url], [null, "https://legelisten.no/tannlege/x"], "directory: moved to directory_url");
      assertEq([dir.enrichment_state, dir.verification_status, dir.review_reason, dir.review_since], ["raw", "pending_verify", null, null], "directory: raw, out of needs_review");
      assertEq(JSON.parse(dir.field_provenance).hjemmeside?.previous_value, "https://legelisten.no/tannlege/x", "directory: provenance previous_value");
      assertEq(findingsOf("t-dir").map((f) => f.status), ["directory_homepage"], "directory: audit row");

      const ver = rowOf("t-verified");
      assertEq([ver.verification_status, ver.brreg_status, ver.website_ownership, ver.review_reason], ["verified", "active", "verified", null], "verified: status + basis written");
      assertTrue(!!ver.last_verified_at && !!ver.website_ownership_checked_at, "verified: last_verified_at + checked_at");
      assertEq(findingsOf("t-verified").map((f) => f.status), ["verified"], "verified: audit row");

      for (const id of ["t-throw", "t-5xx", "t-undecided", "t-noorg"]) {
        const r = rowOf(id);
        assertEq(r.verification_status, "needs_review", `undecided ${id}: stays needs_review`);
        assertTrue(r.review_reason !== null && r.is_inactive === 0, `undecided ${id}: review state kept, not inactive`);
        assertEq(findingsOf(id).map((f) => f.status), ["undecided"], `undecided ${id}: one undecided audit row`);
      }
      assertTrue(rowOf("t-throw").verification_status !== "verified" && rowOf("t-5xx").verification_status !== "verified",
        "brreg failure: never verified");
      assertEq(rowOf("x-pending").verification_status, "pending_verify", "non-candidate untouched");

      // Undecided rows are not re-picked inside the recheck window.
      assertEq(triage.pickDentalTriageCandidates(db, 50).length, 0, "recheck: undecided rows skipped on the next pick");
      c0 = changes();
      const rerun = await triage.runDentalTriage({ db, fetchImpl: fakeFetch, pauseBlock: noPause, env: ON });
      assertEq([rerun.candidates, changes() - c0], [0, 0], "rerun: nothing to do, zero writes");

      // Stale guard: a row changed after the decision is skipped.
      seed({ id: "t-stale", navn: "Endret Tannlege AS", org_nr: "900000014", review_since: "2026-09-09T00:00:00.000Z" });
      const staleRow = triage.pickDentalTriageCandidates(db, 50).find((r) => r.id === "t-stale")!;
      const staleDecision = await triage.decideDentalTriage(staleRow, { fetchImpl: fakeFetch });
      db.prepare("UPDATE dental_agents SET verification_status = 'verified' WHERE id = 't-stale'").run();
      assertEq(triage.applyDentalTriageDecision(db, staleRow, staleDecision, new Date().toISOString()), false, "stale: changed row skipped");
      assertEq([rowOf("t-stale").is_inactive, findingsOf("t-stale").length], [0, 0], "stale: no write, no audit row");

      // ── Routes ──────────────────────────────────────────────────────────
      const routeMod = require("../routes/admin-dental-triage") as typeof import("../routes/admin-dental-triage");
      routeMod.__setDentalTriageFetchForTesting(fakeFetch);
      const router = routeMod.default as any;
      const H = { "x-admin-key": testKey };

      let r = await callRoute(router, "/dry-run", { body: {} });
      assertEq(r.status, 403, "route: dry-run without key -> 403");
      r = await callRoute(router, "/dry-run", { headers: { "x-admin-key": "wrong" }, body: {} });
      assertEq(r.status, 403, "route: dry-run wrong key -> 403");
      r = await callRoute(router, "/run", { body: {} });
      assertEq(r.status, 403, "route: run without key -> 403");

      seed({ id: "t-route", navn: "Rute Tannlege AS", org_nr: "900000015", review_since: "2026-09-11T00:00:00.000Z" });
      before = snapshot();
      r = await callRoute(router, "/dry-run", { headers: H, body: { ids: ["t-route"] } });
      assertEq(r.status, 200, "route: dry-run 200 with the flag off");
      assertEq(r.body?.decisions?.[0]?.decision, "inactive", "route: dry-run decision");
      assertEq(Object.keys(r.body?.decisions?.[0] ?? {}).sort(), ["decision", "evidence", "id", "name", "reason"], "route: decision shape");
      assertEq(snapshot(), before, "route: dry-run writes nothing");
      r = await callRoute(router, "/dry-run", { headers: H, body: { ids: [] } });
      assertEq(r.status, 400, "route: empty ids -> 400");
      r = await callRoute(router, "/dry-run", { headers: H, body: { ids: [1] } });
      assertEq(r.status, 400, "route: non-string ids -> 400");

      r = await callRoute(router, "/run", { headers: H, body: {} });
      assertEq([r.status, r.body?.error], [503, "dental_triage_disabled"], "route: run with the flag off -> 503");
      assertEq(snapshot(), before, "route: disabled run writes nothing");

      process.env.DENTAL_TRIAGE_JOB_ENABLED = "true";
      pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "dental", enabled: true, reason: "triage test pause" }, "test");
      r = await callRoute(router, "/run", { headers: H, body: {} });
      assertEq([r.status, r.body?.paused], [423, true], "route: run under the pause -> 423");
      assertEq(snapshot(), before, "route: paused run writes nothing");
      pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "dental", enabled: false, cleared_by: "daniel" }, "test");
      r = await callRoute(router, "/run", { headers: H, body: { limit: 5 } });
      assertEq([r.status, r.body?.inactive], [200, 1], "route: run with the flag on -> applies (t-route inactive)");
      assertEq(rowOf("t-route").is_inactive, 1, "route: t-route is inactive");
      routeMod.__setDentalTriageFetchForTesting();
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      restoreMainDb();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort cleanup */ }
      restoreModuleCache();
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
      else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey !== undefined) process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      if (prevFlag === undefined) delete process.env.DENTAL_TRIAGE_JOB_ENABLED;
      else process.env.DENTAL_TRIAGE_JOB_ENABLED = prevFlag;
    }

    return { passed, failed, failures };
  })();
}

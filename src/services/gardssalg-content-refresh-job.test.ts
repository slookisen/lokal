/**
 * gardssalg-content-refresh-job.test.ts — the server-side daily job for the
 * gårdssalg content queue («4b-det», A2A dev-request 2026-10-06-experiences-
 * enrichment-plattformjobb-og-felles-serverjobbramme, tillegg 2026-10-15).
 *
 * Two halves:
 *   A. The job itself against a FAKE shared core (`deps.run`): lane order
 *      (drink first, then generic), llm:false on every call, batch size,
 *      stop rules (two zero batches / queue empty / max calls), the 423
 *      pause path, dry-run = no ledger, the ledger envelope's claim kinds,
 *      the daily window + once-per-day stamp, the status reader.
 *   B. The REAL shared core (runGardssalgContentRefresh in routes/
 *      opplevelser) with llm:false against an in-memory experiences DB and a
 *      fetch mock that COUNTS calls to api.anthropic.com: a fixture whose
 *      page would trigger the judge/generators yields 0 model calls with
 *      llm:false (and >0 with llm:true, proving the fixture is a real
 *      trigger), the row is reported `judge_required`, and it gets NO
 *      no-yield strike — while a row with nothing extractable still does.
 *
 * Conventions as in experience-description-proposals-job.test.ts and
 * opplevelser-gardssalg-drink-cohort-content-refresh.test.ts.
 */
import type Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgContentRefreshJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "gardssalg-cr-job-test-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-gardssalg-cr-job";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("../routes/opplevelser");
    const jobPath = require.resolve("./gardssalg-content-refresh-job");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath, jobPath];
    for (const p of cachePaths) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences") as unknown as Database.Database;
      require("../services/experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const mainDb = () => init.getDb() as unknown as Database.Database;
      const job = require("./gardssalg-content-refresh-job") as typeof import("./gardssalg-content-refresh-job");
      const route = require("../routes/opplevelser") as typeof import("../routes/opplevelser");

      const runsFor = (agent: string) =>
        mainDb().prepare("SELECT run_id, status, claims, notes, trigger_source FROM runs WHERE agent = ? ORDER BY rowid").all(agent) as any[];
      const claimValue = (claims: any[], kind: string) => claims.find((c) => c.meta?.kind === kind)?.value;

      // ═════════════════════════ A. job against a fake core ═════════════════
      type Call = { apply: boolean; limit: number; cohort?: string; llm: boolean };
      function fakeRun(script: { drink: any[]; generic: any[] }, calls: Call[]): typeof job.GardssalgCrRunFn extends infer T ? T : never {
        let d = 0; let g = 0;
        return (async (input: any) => {
          calls.push({ apply: input.apply, limit: input.limit, cohort: input.cohort, llm: input.llm });
          const next = input.cohort === "drink" ? script.drink[d++] : script.generic[g++];
          if (!next) return { status: 200, body: { scanned: 0, agents_enriched: 0, changed: [], errors_by_persistence: { permanent: 0 }, parked_now: [], excluded_shared_domain: [] } };
          if (typeof next.status === "number") return next;
          return { status: 200, body: { scanned: 8, agents_enriched: 0, changed: [], errors_by_persistence: { permanent: 0 }, parked_now: [], excluded_shared_domain: [], ...next } };
        }) as any;
      }
      const envOn = { GARDSSALG_CONTENT_REFRESH_JOB_ENABLED: "true" } as Record<string, string | undefined>;

      // (1) pure window guard
      {
        const at = (iso: string) => new Date(iso);
        assertEq(job.shouldRunGardssalgContentRefreshDaily({ now: at("2026-10-16T03:05:00Z"), lastRunAt: null }), true, "a1-1: inside default 03 UTC window, never run -> run");
        assertEq(job.shouldRunGardssalgContentRefreshDaily({ now: at("2026-10-16T04:05:00Z"), lastRunAt: null }), false, "a1-2: outside window -> no");
        assertEq(job.shouldRunGardssalgContentRefreshDaily({ now: at("2026-10-16T03:40:00Z"), lastRunAt: at("2026-10-16T03:05:00Z") }), false, "a1-3: ran 35 min ago -> no (min 20h)");
        assertEq(job.shouldRunGardssalgContentRefreshDaily({ now: at("2026-10-17T03:05:00Z"), lastRunAt: at("2026-10-16T03:05:00Z") }), true, "a1-4: ran 24h ago -> run");
        assertEq(job.shouldRunGardssalgContentRefreshDaily({ now: at("2026-10-16T22:05:00Z"), lastRunAt: null, windowHourUtc: 22 }), true, "a1-5: configurable window hour");
        assertEq(job.resolveGardssalgCrJobCallsPerLane({ GARDSSALG_CONTENT_REFRESH_JOB_CALLS_PER_LANE: "99" }), job.GARDSSALG_CR_JOB_MAX_CALLS_PER_LANE, "a1-6: calls-per-lane capped");
        assertEq(job.resolveGardssalgCrJobCallsPerLane({}), job.GARDSSALG_CR_JOB_DEFAULT_CALLS_PER_LANE, "a1-7: calls-per-lane default");
      }

      // (2) disabled -> cron run skipped, core never called
      {
        const calls: Call[] = [];
        const r = await job.runGardssalgContentRefreshDaily({ apply: true, trigger: "cron" }, { run: fakeRun({ drink: [], generic: [] }, calls), env: {}, mainDb });
        assertEq(r.skipped_reason, "disabled", "a2-1: disabled -> skipped_reason disabled");
        assertEq(calls.length, 0, "a2-2: core never called when disabled");
        assertEq(r.envelope_recorded, false, "a2-3: no envelope when disabled");
      }

      // (3) lane order, llm:false, batch size, zero-streak stop, envelope claims
      {
        const calls: Call[] = [];
        const script = {
          drink: [
            { agents_enriched: 3, changed: [{ provider_id: "d1" }, { provider_id: "d2" }, { provider_id: "d3" }], cohort_eligible_total: 20, cohort_resting_total: 4, judge_required_rows: 2, errors_by_persistence: { permanent: 1 } },
            { agents_enriched: 0, cohort_eligible_total: 17, cohort_resting_total: 4, judge_required_rows: 5 },
            { agents_enriched: 0, cohort_eligible_total: 17, cohort_resting_total: 4 },
            { agents_enriched: 9 }, // must never be reached (zero streak stops at 2)
          ],
          generic: [
            { agents_enriched: 1, changed: [{ provider_id: "g1" }], parked_now: ["p1"] },
            { agents_enriched: 0 },
            { agents_enriched: 0 },
          ],
        };
        const env = { ...envOn, GARDSSALG_CONTENT_REFRESH_JOB_CALLS_PER_LANE: "4" };
        const r = await job.runGardssalgContentRefreshDaily({ apply: true, trigger: "cron", now: new Date("2026-10-16T03:02:00Z") }, { run: fakeRun(script, calls), env, mainDb });
        assertEq(r.skipped_reason, null, "a3-1: ran");
        assertEq(calls.map((c) => c.cohort ?? "auto"), ["drink", "drink", "drink", "auto", "auto", "auto"], "a3-2: drink lane first (3 calls: 3,0,0 -> zero-streak stop), then generic (1,0,0)");
        assertTrue(calls.every((c) => c.llm === false), "a3-3: EVERY call is llm:false");
        assertTrue(calls.every((c) => c.apply === true && c.limit === job.GARDSSALG_CR_JOB_BATCH_SIZE), "a3-4: apply:true, limit = batch size on every call");
        const drink = r.lanes.find((l) => l.lane === "drink")!;
        const generic = r.lanes.find((l) => l.lane === "generic")!;
        assertEq([drink.enriched, drink.calls, drink.stop_reason], [3, 3, "zero_streak"], "a3-5: drink lane totals + stop reason");
        assertEq([drink.cohort_eligible_total, drink.cohort_resting_total], [20, 4], "a3-6: queue depth taken from the FIRST drink batch");
        assertEq([generic.enriched, generic.calls, generic.stop_reason], [1, 3, "zero_streak"], "a3-7: generic lane totals + stop reason");
        assertEq(r.totals.judge_required_rows, 7, "a3-8: judge_required rows summed across batches");
        assertEq(r.envelope_recorded, true, "a3-9: envelope recorded for an apply run");
        const rows = runsFor(job.GARDSSALG_CR_JOB_AGENT);
        assertEq(rows.length, 1, "a3-10: exactly one ledger row");
        assertEq(rows[0].run_id, `run-2026-10-16-${job.GARDSSALG_CR_JOB_AGENT}-experiences`, "a3-11: cron run_id is fixed per UTC day");
        assertEq(rows[0].status, "completed", "a3-12: status completed");
        const claims = JSON.parse(rows[0].claims);
        assertEq(claimValue(claims, "gardssalg_drink_cohort_enriched"), 3, "a3-13: claim gardssalg_drink_cohort_enriched = 3");
        assertEq(claimValue(claims, "gardssalg_drink_cohort_eligible"), 20, "a3-14: claim gardssalg_drink_cohort_eligible = 20");
        assertEq(claimValue(claims, "gardssalg_drink_cohort_resting"), 4, "a3-15: claim gardssalg_drink_cohort_resting = 4");
        assertEq(claimValue(claims, "gardssalg_content_enriched"), 1, "a3-16: claim gardssalg_content_enriched (generic) = 1");
        assertEq(claimValue(claims, "http_unreachable"), 1, "a3-17: claim http_unreachable = permanent errors");
        assertEq(claimValue(claims, "providers_parked"), 1, "a3-18: claim providers_parked = 1");
        assertEq(claimValue(claims, "gardssalg_judge_required_rows"), 7, "a3-19: claim gardssalg_judge_required_rows = 7");
        assertTrue(String(rows[0].notes).includes("llm:false"), "a3-20: notes say llm:false");

        // same day again (cron) -> ledger no-op (ON CONFLICT DO NOTHING)
        const calls2: Call[] = [];
        await job.runGardssalgContentRefreshDaily({ apply: true, trigger: "cron", now: new Date("2026-10-16T03:30:00Z") }, { run: fakeRun(script, calls2), env, mainDb });
        assertEq(runsFor(job.GARDSSALG_CR_JOB_AGENT).length, 1, "a3-21: a second cron run the same day does not add a ledger row");
      }

      // (4) drink queue empty -> one drink call, then generic
      {
        const calls: Call[] = [];
        const r = await job.runGardssalgContentRefreshDaily({ apply: true, trigger: "manual", now: new Date("2026-10-16T10:00:00Z") }, { run: fakeRun({ drink: [{ agents_enriched: 0, scanned: 0, cohort_eligible_total: 0, cohort_resting_total: 12 }], generic: [{ agents_enriched: 0 }, { agents_enriched: 0 }] }, calls), env: envOn, mainDb });
        assertEq(calls.map((c) => c.cohort ?? "auto"), ["drink", "auto", "auto"], "a4-1: empty drink queue -> a single drink call");
        assertEq(r.lanes[0].stop_reason, "queue_empty", "a4-2: drink stop reason queue_empty");
        assertEq(r.lanes[0].cohort_resting_total, 12, "a4-3: resting total still reported");
        assertEq(r.trigger, "manual", "a4-4: manual trigger echoed");
        assertTrue(runsFor(job.GARDSSALG_CR_JOB_AGENT).some((x) => x.trigger_source === "manual"), "a4-5: manual apply run gets its own ledger row");
      }

      // (5) write-pause (423) -> paused, nothing further, no envelope
      {
        const calls: Call[] = [];
        const before = runsFor(job.GARDSSALG_CR_JOB_AGENT).length;
        const r = await job.runGardssalgContentRefreshDaily({ apply: true, trigger: "cron", now: new Date("2026-10-17T03:02:00Z") }, { run: fakeRun({ drink: [{ status: 423, body: { error: "enrichment_write_paused" } }], generic: [{ agents_enriched: 5 }] }, calls), env: envOn, mainDb });
        assertEq(r.skipped_reason, "paused", "a5-1: 423 -> skipped_reason paused");
        assertEq(calls.length, 1, "a5-2: stops at the first 423 — generic lane never called");
        assertEq(runsFor(job.GARDSSALG_CR_JOB_AGENT).length, before, "a5-3: no envelope for a paused run");
      }

      // (6) dry-run -> core called with apply:false, no envelope
      {
        const calls: Call[] = [];
        const before = runsFor(job.GARDSSALG_CR_JOB_AGENT).length;
        const r = await job.runGardssalgContentRefreshDaily({ apply: false, trigger: "manual", now: new Date("2026-10-18T12:00:00Z") }, { run: fakeRun({ drink: [{ agents_enriched: 2 }, { agents_enriched: 0 }], generic: [{ agents_enriched: 0 }, { agents_enriched: 0 }] }, calls), env: {}, mainDb });
        assertTrue(calls.length > 0 && calls.every((c) => c.apply === false && c.llm === false), "a6-1: dry-run passes apply:false (and llm:false) to the core");
        assertEq(r.skipped_reason, null, "a6-2: a manual dry-run runs even with the flag off");
        assertEq(r.envelope_recorded, false, "a6-3: dry-run records no envelope");
        assertEq(runsFor(job.GARDSSALG_CR_JOB_AGENT).length, before, "a6-4: ledger unchanged by dry-run");
      }

      // (7) daily tick: window + once-per-day stamp (boot_job_state)
      {
        const calls: Call[] = [];
        const deps = { run: fakeRun({ drink: [{ agents_enriched: 0 }, { agents_enriched: 0 }], generic: [{ agents_enriched: 0 }, { agents_enriched: 0 }] }, calls), env: envOn, mainDb };
        const t0 = await job.tickGardssalgContentRefreshDaily({ now: new Date("2026-10-20T02:59:00Z"), lastRunAt: null }, deps);
        assertEq(t0.report, null, "a7-1: outside the window -> no run");
        const t1 = await job.tickGardssalgContentRefreshDaily({ now: new Date("2026-10-20T03:01:00Z"), lastRunAt: null }, deps);
        assertTrue(!!t1.report && t1.report.skipped_reason === null, "a7-2: inside the window -> ran");
        assertEq(t1.lastRunAt?.toISOString(), "2026-10-20T03:01:00.000Z", "a7-3: lastRunAt stamped");
        const callsAfterFirst = calls.length;
        // Same window, in-memory stamp lost (simulated restart): the persisted stamp still blocks.
        const t2 = await job.tickGardssalgContentRefreshDaily({ now: new Date("2026-10-20T03:31:00Z"), lastRunAt: null }, deps);
        assertEq(t2.report, null, "a7-4: second tick in the same window after a 'restart' -> no run (boot_job_state)");
        assertEq(calls.length, callsAfterFirst, "a7-5: core not called again");
        const t3 = await job.tickGardssalgContentRefreshDaily({ now: new Date("2026-10-21T03:01:00Z"), lastRunAt: t2.lastRunAt }, deps);
        assertTrue(!!t3.report, "a7-6: next day -> runs again");
        const off = await job.tickGardssalgContentRefreshDaily({ now: new Date("2026-10-22T03:01:00Z"), lastRunAt: null }, { ...deps, env: {} });
        assertEq(off.report, null, "a7-7: flag off -> tick is a no-op");
      }

      // (8) status reader
      {
        const st = job.getGardssalgContentRefreshJobStatus({ env: envOn, mainDb });
        assertEq([st.enabled, st.llm, st.window_hour_utc, st.batch_size], [true, false, 3, 8], "a8-1: status basics");
        assertTrue(st.runs.length >= 3 && st.runs[0].run_id.startsWith("run-"), "a8-2: status lists the ledger rows");
        assertTrue(!!st.last_completed_at, "a8-3: last_completed_at from boot_job_state");
      }

      // ═════════════════ B. the REAL core with llm:false ═════════════════════
      {
        const insert = expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
              field_provenance, producer_type, enrichment_state, verification_status, source, confidence)
           VALUES (@id, @navn, 'experiences', @hjemmeside, NULL, @about_text, NULL, NULL, @products,
              @fp, 'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        );
        const fp = JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" } });
        const FULL_ABOUT = "Bryggeriet ligger på gården ved fjorden og har brygget øl av eget korn og humle siden 2012, med fokus på håndverk.";
        // jr-1: about+products present; page has a long visit sentence with a
        // keyword ("smaking") -> deterministic candidate exists -> needs the judge.
        insert.run({ id: "jr-1", navn: "Judge Required Bryggeri", hjemmeside: "https://jr-1.example.no", about_text: FULL_ABOUT, products: JSON.stringify(["Pils"]), fp });
        // nc-1: same, but the page has NO visit/hours signal at all -> no candidate.
        insert.run({ id: "nc-1", navn: "Ingen Kandidat Bryggeri", hjemmeside: "https://nc-1.example.no", about_text: FULL_ABOUT, products: JSON.stringify(["Pils"]), fp });

        let anthropicCalls = 0;
        const htmlJr = `<html><head><title>JR</title></head><body>
          <p>Velkommen til oss. Vi tilbyr smaking av sesongens øl i taprommet vårt hver lørdag, og besøkende kan se bryggeriet og handle med seg flasker fra gårdsutsalget vårt.</p>
          <p>Åpningstider: lørdag 12:00-16:00.</p></body></html>`;
        const htmlNc = `<html><head><title>NC</title></head><body><p>Et lite bryggeri. Kontakt oss på e-post for henvendelser om levering til butikker og restauranter i regionen.</p></body></html>`;
        globalThis.fetch = (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.includes("api.anthropic.com")) {
            anthropicCalls++;
            return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nTest." }] }) } as unknown as Response;
          }
          const parsed = new URL(u);
          const html = parsed.hostname === "jr-1.example.no" ? htmlJr : parsed.hostname === "nc-1.example.no" ? htmlNc : null;
          if (html && (parsed.pathname === "/" || parsed.pathname === "")) {
            return { ok: true, status: 200, text: async () => html, arrayBuffer: async () => new TextEncoder().encode(html).buffer, headers: { get: () => null } } as unknown as Response;
          }
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }) as typeof fetch;

        const streak = (id: string) => (expDb.prepare("SELECT content_no_yield_streak AS s FROM experience_providers WHERE id = ?").get(id) as any)?.s ?? 0;

        // llm:false, apply -> 0 anthropic calls, judge_required, no strike for jr-1, strike for nc-1
        anthropicCalls = 0;
        const off = await route.runGardssalgContentRefresh({ providerIds: ["jr-1", "nc-1"], apply: true, llm: false });
        assertEq(off.status, 200, "b1-1: llm:false apply -> 200");
        assertEq(anthropicCalls, 0, "b1-2: llm:false -> ZERO calls to api.anthropic.com");
        assertEq(off.body.llm, false, "b1-3: response echoes llm:false");
        assertEq(off.body.agents_enriched, 0, "b1-4: nothing written without a judge");
        const fdJr = off.body.field_diagnostic.find((f: any) => f.provider_id === "jr-1");
        const fdNc = off.body.field_diagnostic.find((f: any) => f.provider_id === "nc-1");
        assertEq(fdJr?.visit_text, "judge_required", "b1-5: jr-1 visit_text reported judge_required (candidate found, judge not allowed)");
        assertEq(fdJr?.opening_hours_text, "judge_required", "b1-6: jr-1 opening_hours_text reported judge_required (trigger found, generator not allowed)");
        assertEq(fdNc?.visit_text, "no_candidate_section", "b1-7: nc-1 visit_text still no_candidate_section");
        assertEq(off.body.judge_required_rows, 1, "b1-8: judge_required_rows counts jr-1 only");
        assertEq(streak("jr-1"), 0, "b1-9: jr-1 gets NO no-yield strike (waiting for a judge, not proven empty)");
        assertEq(streak("nc-1"), 1, "b1-10: nc-1 DOES get a no-yield strike (nothing extractable)");
        const pdJr = off.body.products_diagnostic.find((p: any) => p.provider_id === "jr-1");
        assertEq(pdJr?.outcome, "generator_not_invoked:products_already_present", "b1-11: products already present -> unchanged gate");

        // llm:true on the same fixture -> the judge IS called (proves the fixture is a real trigger)
        anthropicCalls = 0;
        const on = await route.runGardssalgContentRefresh({ providerIds: ["jr-1"], apply: false, llm: true });
        assertEq(on.status, 200, "b2-1: llm:true dry-run -> 200");
        assertTrue(anthropicCalls > 0, `b2-2: llm:true -> the model IS called on the same fixture (${anthropicCalls} calls)`);
        assertEq(on.body.llm, true, "b2-3: response echoes llm:true");
        assertEq(on.body.judge_required_rows, 0, "b2-4: judge_required_rows is 0 when the judge may run");

        // blank products + llm:false -> products generator gate reported honestly
        expDb.prepare("UPDATE experience_providers SET products = NULL WHERE id = 'nc-1'").run();
        anthropicCalls = 0;
        const prod = await route.runGardssalgContentRefresh({ providerIds: ["nc-1"], apply: false, llm: false });
        const pdNc = prod.body.products_diagnostic.find((p: any) => p.provider_id === "nc-1");
        assertEq(pdNc?.outcome, "generator_not_invoked:llm_disabled", "b3-1: blank products + llm:false -> generator_not_invoked:llm_disabled");
        assertEq(prod.body.field_diagnostic.find((f: any) => f.provider_id === "nc-1")?.products, "judge_required", "b3-2: field_diagnostic.products maps to judge_required");
        assertEq(anthropicCalls, 0, "b3-3: still zero model calls");

        // the HTTP route still defaults to llm:true (historical behaviour)
        {
          const routeOut = await new Promise<{ status: number; body: any }>((resolve) => {
            const req: any = { method: "POST", url: "/admin/gardssalg-content-refresh", originalUrl: "/admin/gardssalg-content-refresh", path: "/admin/gardssalg-content-refresh", query: {}, headers: { "x-admin-key": process.env.ADMIN_KEY }, body: { providerIds: ["jr-1"], apply: false }, get() { return undefined; } };
            const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(p: any) { resolve({ status: this.statusCode, body: p }); return this; } };
            (route.default as any).handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
          });
          assertEq(routeOut.status, 200, "b4-1: HTTP route -> 200");
          assertEq(routeOut.body.llm, true, "b4-2: HTTP route keeps llm:true by default");
        }
      }
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}

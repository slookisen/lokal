/**
 * profile-translations-worker.test.ts — dev-request
 * 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent, Daniel GO #1 (the
 * in-process worker). Sections:
 *   A. config parsing + mode selection (pure)
 *   B. workerTick against a :memory: rfb db with a stub fetch: pipeline-off
 *      no-op, intensive mode processes with concurrency and interleaves
 *      platforms, steady mode respects the hourly budget, infra failure →
 *      backoff, lock shared with the admin route (409).
 *
 * Run standalone: npx tsx src/services/profile-translations-worker.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

export async function runProfileTranslationsWorkerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string, detail?: unknown) => {
    if (c) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); if (log) console.log(`  ✗ ${label}`, detail ?? ""); }
  };
  const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label, { actual: a, expected: b });

  const envKeys = [
    "PROFILE_TRANSLATIONS_ENABLED", "PROFILE_TRANSLATIONS_WORKER_ENABLED", "PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL",
    "PROFILE_TRANSLATIONS_WORKER_INTENSIVE_CONCURRENCY", "PROFILE_TRANSLATIONS_WORKER_STEADY_ITEMS_PER_HOUR",
    "PROFILE_TRANSLATIONS_WORKER_PLATFORMS", "ANTHROPIC_API_KEY", "ADMIN_KEY",
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of envKeys) prev[k] = process.env[k];
  const restore = () => { for (const k of envKeys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };

  const w = require("./profile-translations-worker") as typeof import("./profile-translations-worker");
  const svc = require("./profile-translations") as typeof import("./profile-translations");

  try {
    // ── A. config + mode ──
    for (const k of envKeys) delete process.env[k];
    let cfg = w.readWorkerConfig();
    eq([cfg.enabled, cfg.intensiveUntil, cfg.intensiveConcurrency, cfg.steadyItemsPerHour, cfg.platforms], [false, null, 5, 20, ["rfb", "opplevagent"]], "A1 defaults");
    process.env.PROFILE_TRANSLATIONS_WORKER_ENABLED = "true";
    process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL = "2030-01-01T00:00:00Z";
    process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_CONCURRENCY = "99";
    process.env.PROFILE_TRANSLATIONS_WORKER_STEADY_ITEMS_PER_HOUR = "7";
    process.env.PROFILE_TRANSLATIONS_WORKER_PLATFORMS = "rfb,bogus";
    cfg = w.readWorkerConfig();
    eq([cfg.enabled, cfg.intensiveUntil?.toISOString(), cfg.intensiveConcurrency, cfg.steadyItemsPerHour, cfg.platforms], [true, "2030-01-01T00:00:00.000Z", w.WORKER_MAX_INTENSIVE_CONCURRENCY, 7, ["rfb"]], "A2 env parsed, concurrency capped, unknown platform dropped");
    eq(w.workerModeFor(cfg, new Date("2029-12-31T23:59:59Z")), "intensive", "A3 before until → intensive");
    eq(w.workerModeFor(cfg, new Date("2030-01-01T00:00:00Z")), "steady", "A4 at until → steady");
    process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL = "not-a-date";
    eq(w.readWorkerConfig().intensiveUntil, null, "A5 invalid until → null (steady)");
    delete process.env.PROFILE_TRANSLATIONS_WORKER_PLATFORMS;

    // ── B. ticks against :memory: rfb db ──
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevDb = initMod.__peekDbForTesting();
    const rfbDb = new Database(":memory:");
    // opplevagent db for interleaving: a second in-memory db with the same schema
    const expDb = new Database(":memory:");
    try {
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const initExp = require("../database/init-experiences") as typeof import("../database/init-experiences");
      initExp.initExperiencesSchema(expDb as any);
      const ins = rfbDb.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      for (let i = 1; i <= 4; i++) ins.run(`a${i}`, `Gård ${i}`, `Vi selger økologiske grønnsaker fra gård nummer ${i} i Bø. Åpent lørdager 10–15.`, "t", `a${i}@x.no`, `https://a${i}.no`, "producer", `k${i}`);
      expDb.prepare(`INSERT INTO experience_providers (id, navn, producer_type, brreg_active, about_text, catalog_hidden) VALUES (?, ?, ?, 1, ?, 0)`)
        .run("p1", "Fjordbrygg", "bryggeri", "Fjordbrygg er et lite håndverksbryggeri ved fjorden. Vi brygger på lokalt korn.");
      const dbFor = (p: string) => (p === "rfb" ? rfbDb : expDb);

      const concurrent = { now: 0, max: 0, calls: 0 };
      const fakeFetch = async (_u: any, init: any) => {
        concurrent.now++; concurrent.max = Math.max(concurrent.max, concurrent.now); concurrent.calls++;
        await new Promise((r) => setTimeout(r, 15));
        concurrent.now--;
        const body = JSON.parse(String(init?.body || "{}"));
        const isReviewer = /senior .* linguist/i.test(String(body.system || ""));
        const user = String(body.messages?.[0]?.content || "");
        const lang = /Target language: Swedish/.test(user) || /Translation \(Swedish\)/.test(user) ? "sv" : "en";
        const isBrewery = /Fjordbrygg/.test(user);
        const n = user.match(/nummer (\d)/)?.[1] || "1";
        const translation = isBrewery
          ? (lang === "sv" ? "Fjordbrygg är ett litet hantverksbryggeri vid fjorden. Vi brygger på lokalt spannmål." : "Fjordbrygg is a small craft brewery by the fjord. We brew with local grain.")
          : (lang === "sv" ? `Vi säljer ekologiska grönsaker från gård nummer ${n} i Bø. Öppet lördagar 10–15.` : `We sell organic vegetables from farm number ${n} in Bø. Open Saturdays 10–15.`);
        const text = isReviewer
          ? JSON.stringify({ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" })
          : JSON.stringify({ translation, already_target_language: false, notes: "" });
        return { ok: true, status: 200, json: async () => ({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }), text: async () => "" };
      };

      // B1: pipeline off → no-op
      w.__resetWorkerStateForTesting();
      delete process.env.PROFILE_TRANSLATIONS_ENABLED;
      process.env.ANTHROPIC_API_KEY = "k";
      let r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor });
      eq([r.mode, r.processed, concurrent.calls], ["pipeline_off", 0, 0], "B1 pipeline flag off → no-op, no fetch");

      // B2: intensive mode processes with concurrency and interleaves platforms
      process.env.PROFILE_TRANSLATIONS_ENABLED = "true";
      process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL = "2030-01-01T00:00:00Z";
      process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_CONCURRENCY = "3";
      w.__resetWorkerStateForTesting();
      concurrent.max = 0; concurrent.calls = 0;
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor });
      // 4 rfb agents × 1 field (about is NULL) × 2 langs = 8, + provider p1 about_text × 2 = 2 → 10 items
      eq([r.mode, r.processed], ["intensive", 10], "B2 intensive processed every actionable item across both platforms", r);
      ok(concurrent.max >= 2 && concurrent.max <= 3, "B3 items ran in parallel, bounded by concurrency", concurrent.max);
      const st = w.getWorkerState();
      eq([st.totals.verified, st.per_platform.rfb?.items, st.per_platform.opplevagent?.items], [10, 8, 2], "B4 state totals per platform", st.per_platform);
      eq(st.per_platform.rfb?.remaining_estimate, 0, "B5 remaining estimate 0 after full pass");
      eq(st.lock.holder, null, "B6 lock released after tick");
      // nothing left → next intensive tick processes 0
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor });
      eq([r.mode, r.processed, r.batches], ["intensive", 0, 0], "B7 idle tick when belt is empty");

      // B8: steady mode honours hourly budget
      rfbDb.prepare(`UPDATE agents SET description = description || ' Nå også med honning.'`).run(); // all 4 change → 8 items
      process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL = "2000-01-01T00:00:00Z";
      process.env.PROFILE_TRANSLATIONS_WORKER_STEADY_ITEMS_PER_HOUR = "6";
      w.__resetWorkerStateForTesting();
      const base = new Date("2026-09-03T10:00:00Z");
      let clock = base;
      const now = () => clock;
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      eq([r.mode, r.processed], ["steady", 5], "B8 steady tick processes at most 5 per tick");
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      eq([r.mode, r.processed], ["steady", 1], "B9 second tick tops up to the hourly budget (6)");
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      eq([r.mode, r.processed], ["steady", 0], "B10 budget exhausted → 0");
      clock = new Date(base.getTime() + 61 * 60_000);
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      eq([r.mode, r.processed], ["steady", 2], "B11 new hour window → remaining 2 items processed");

      // B12: infra failure → backoff
      rfbDb.prepare(`UPDATE agents SET description = description || ' Og egg.'`).run();
      delete process.env.ANTHROPIC_API_KEY;
      process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL = "2030-01-01T00:00:00Z";
      w.__resetWorkerStateForTesting();
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      ok(r.mode === "intensive" && r.processed >= 1 && r.processed <= 6, "B12 infra failure stops the batch early", r);
      const st2 = w.getWorkerState();
      ok(!!st2.backoff_until && /ANTHROPIC_API_KEY/.test(st2.last_error || ""), "B13 backoff set with the infra reason", st2);
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      eq(r.mode, "backoff", "B14 next tick is skipped while backing off");
      clock = new Date(clock.getTime() + 16 * 60_000);
      process.env.ANTHROPIC_API_KEY = "k";
      r = await w.workerTick({ fetchImpl: fakeFetch as any, dbFor, now });
      ok(r.mode === "intensive" && r.processed >= 1, "B15 resumes after backoff window", r);

      // B16: lock shared with the admin route → 409 while worker holds it
      const router = (require("../routes/admin-profile-translations") as typeof import("../routes/admin-profile-translations")).default;
      const key = process.env.ADMIN_KEY || "worker-test-key";
      process.env.ADMIN_KEY = key;
      ok(w.tryAcquireTranslationRunLock("worker"), "B16 acquire lock");
      const res = await new Promise<{ status: number; body: any }>((resolve) => {
        const req: any = { method: "POST", url: "/run", originalUrl: "/run", path: "/run", query: {}, headers: { "x-admin-key": key }, body: { platform: "rfb", dry_run: false }, app: { get: () => fakeFetch }, get() { return undefined; } };
        const r2: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: any) { resolve({ status: this.statusCode, body: b }); return this; }, setHeader() { return this; } };
        router.handle(req, r2, () => resolve({ status: 404, body: null }));
      });
      eq([res.status, res.body?.error], [409, "busy"], "B17 admin /run returns 409 while worker holds the lock");
      w.releaseTranslationRunLock("worker");
      eq(w.translationRunLockState().holder, null, "B18 lock released");
      const st3 = await new Promise<{ status: number; body: any }>((resolve) => {
        const req: any = { method: "GET", url: "/status?platform=rfb", originalUrl: "/status?platform=rfb", path: "/status", query: { platform: "rfb" }, headers: { "x-admin-key": key }, body: {}, app: { get: () => undefined }, get() { return undefined; } };
        const r2: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: any) { resolve({ status: this.statusCode, body: b }); return this; }, setHeader() { return this; } };
        router.handle(req, r2, () => resolve({ status: 404, body: null }));
      });
      ok(st3.status === 200 && st3.body.worker && typeof st3.body.worker.mode === "string" && st3.body.worker.config, "B19 /status exposes worker state + config", st3.body?.worker);
    } finally {
      if (prevDb) initMod.__setDbForTesting(prevDb);
      try { rfbDb.close(); } catch { /* ignore */ }
      try { expDb.close(); } catch { /* ignore */ }
      w.__resetWorkerStateForTesting();
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err?.message || err)}`);
  } finally {
    restore();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileTranslationsWorkerTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) { for (const f of s.failures) console.log(f); process.exit(1); }
  });
}

/**
 * cx-run-lock-staleness.test.ts — dev-request 2026-10-01-rfb-contact-
 * extraction-laas-henger. The run-locks of POST /admin/rfb-contact-extraction
 * (rfbCxLock) and POST /api/opplevelser/admin/gardssalg-contact-extraction
 * (gsCxLock) carry { startedAt, runId } and have an upper bound; the shared
 * LLM judge (judgeContactCandidate) has a hard timeout.
 *
 *   (j1)  judge whose fetch never settles -> reason judge_timeout, fail-closed
 *   (j2)  judge whose response.json() never settles -> judge_timeout
 *   (r1)  hang mechanism: RFB run blocked on a never-answering judge stays
 *         in-flight holding the lock (what used to hang forever); with the
 *         judge timeout it finishes 200 and the lock is released
 *   (r2)  stale lock is taken over (lock_stale_takeover logged with old runId)
 *   (r3)  old run finishing AFTER takeover does not release the new lock
 *   (r4)  409 body carries started_at / run_id / lock_age_ms
 *   (g1-g3) same stale-takeover / 409-body / release semantics for gsCxLock
 *
 * Standalone: npx tsx src/routes/cx-run-lock-staleness.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined, writableEnded: false, destroyed: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCxRunLockStalenessTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const prevFetch = globalThis.fetch;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  const prevWarn = console.warn;
  const ADMIN_KEY = process.env.ADMIN_KEY || "cx-lock-test-key";
  const dbFactoryPath = require.resolve("../database/db-factory");
  const experienceStorePath = require.resolve("../services/experience-store");
  const opplevelserPath = require.resolve("./opplevelser");
  const rfbPath = require.resolve("./admin-rfb-contact-extraction");
  const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath, rfbPath];
  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const judgeMod = require("../services/contact-candidate-judge") as typeof import("../services/contact-candidate-judge");
  const warnings: string[] = [];
  // AbortSignal.timeout timers are unref'd; keep the loop alive standalone.
  const keepAlive = setInterval(() => {}, 1000);

  try {
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.ANTHROPIC_API_KEY = "cx-lock-test-anthropic-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };

    // ═══ (j) judge timeout ═══
    judgeMod.__setContactJudgeTimeoutMsForTesting(50);
    const judgeArgs = { fieldType: "email" as const, candidate: "post@gard.no", sourceContext: "post@gard.no", businessName: "Gard" };
    globalThis.fetch = (() => new Promise(() => {})) as any; // never settles, ignores the signal
    const j1 = await judgeMod.judgeContactCandidate(judgeArgs);
    assertEq(j1.approved, false, "j1: never-responding judge -> fail-closed (not approved)");
    assertTrue(/judge_timeout/.test(j1.reason ?? ""), "j1b: reason is judge_timeout");
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })) as any;
    const j2 = await judgeMod.judgeContactCandidate(judgeArgs);
    assertTrue(!j2.approved && /judge_timeout/.test(j2.reason ?? ""), "j2: hung response body read -> judge_timeout");

    // ═══ (r) RFB route ═══
    const testDb = new Database(":memory:");
    testDb.pragma("journal_mode = DELETE");
    testDb.pragma("foreign_keys = OFF");
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    delete require.cache[rfbPath];
    const rfb = require("./admin-rfb-contact-extraction") as typeof import("./admin-rfb-contact-extraction");
    rfb.__setRfbCxRowDelayForTesting(0);
    rfb.__resetRfbCxCooldownForTesting();
    const layer = rfb.default.stack.find((l: any) => l.route && l.route.path === "/rfb-contact-extraction");
    const postRfb = layer.route.stack[0].handle;
    const callRfb = async (body: Record<string, unknown>) => {
      const res = fakeRes();
      await postRfb({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    };
    const insertAgent = (id: string, host: string) => {
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
         VALUES (?, ?, 't', 't', '', 'https://example.com', 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
      ).run(id, `Gard ${id}`, `key-${id}`);
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, field_provenance, curated_fields, updated_at) VALUES (?, ?, '{}', '{}', ?)`,
      ).run(id, `https://${host}`, new Date().toISOString());
    };
    const mailtoPage = (host: string) => ({
      ok: true, status: 200, statusText: "OK", url: `https://${host}`,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
      arrayBuffer: async () => new TextEncoder().encode(`<a href="mailto:post@${host}">Kontakt</a>`).buffer,
    }) as unknown as Response;
    const gates: Array<() => void> = [];
    let anthropicMode: "hang" | "gated" | "ok" = "ok";
    let anthropicCalls = 0;
    const okJudge = { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte." }] }) };
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) {
        anthropicCalls++;
        if (anthropicMode === "hang") return new Promise(() => {}); // ignores the signal, like a dead socket
        if (anthropicMode === "gated") await new Promise<void>((r) => gates.push(r));
        return okJudge as any;
      }
      return mailtoPage(u.replace(/^https:\/\//, "")) as any;
    }) as any;

    // r1: hang mechanism + fix. Without the judge timeout this run never
    // completes and rfbCxLock stays set (every later call -> 409).
    insertAgent("cx-lock-a", "laas-a.no");
    anthropicMode = "hang";
    judgeMod.__setContactJudgeTimeoutMsForTesting(10_000);
    const hung = callRfb({ agentIds: ["cx-lock-a"], apply: true });
    await sleep(150);
    assertTrue(anthropicCalls > 0, "r1a: run reached the judge call");
    assertTrue(rfb.__getRfbCxLockForTesting() !== null, "r1b: hang mechanism — run blocked on a never-answering judge still holds the lock");
    const blocked = await callRfb({ agentIds: ["cx-lock-a"] });
    assertEq(blocked.status, 409, "r1c: ...and a second call is refused 409");
    judgeMod.__setContactJudgeTimeoutMsForTesting(50); // the in-flight call keeps its 10s signal; fresh runs below use 50ms
    hung.catch(() => {});
    // Release the stuck run through the stale-takeover path instead of waiting 10s.
    rfb.__setRfbCxLockForTesting(null);
    insertAgent("cx-lock-b", "laas-b.no");
    const fixed = await callRfb({ agentIds: ["cx-lock-b"], apply: true });
    assertEq(fixed.status, 200, "r1d: with judge timeout the run completes 200 despite a never-answering judge");
    assertTrue(fixed.body?.results?.[0]?.outcome !== "written", "r1e: hung judge -> candidate rejected fail-closed, not written");
    assertEq(rfb.__getRfbCxLockForTesting(), null, "r1f: lock released after the timed-out judge run");
    anthropicMode = "ok";

    // r2: stale takeover
    warnings.length = 0;
    rfb.__setRfbCxLockForTesting({ startedAt: Date.now() - 60 * 60 * 1000, runId: "old-run-1" });
    insertAgent("cx-lock-c", "laas-c.no");
    const t = await callRfb({ agentIds: ["cx-lock-c"] });
    assertEq(t.status, 200, "r2a: lock older than the max is taken over (200, not 409)");
    assertTrue(warnings.some((w) => w.includes("lock_stale_takeover") && w.includes("old-run-1")), "r2b: lock_stale_takeover logged with the old runId");
    assertEq(rfb.__getRfbCxLockForTesting(), null, "r2c: lock released after the takeover run");

    // r3: old run finishing after takeover must not release the new lock
    anthropicMode = "gated";
    gates.length = 0;
    insertAgent("cx-lock-d", "laas-d.no");
    insertAgent("cx-lock-e", "laas-e.no");
    rfb.__setRfbCxLockMaxMsForTesting(40);
    judgeMod.__setContactJudgeTimeoutMsForTesting(10_000); // the gates, not the timeout, end these runs
    const runA = callRfb({ agentIds: ["cx-lock-d"], apply: true });
    await sleep(20);
    const lockA = rfb.__getRfbCxLockForTesting();
    assertTrue(!!lockA, "r3a: run A holds the lock");
    await sleep(60); // A is now older than the 40ms max
    const runB = callRfb({ agentIds: ["cx-lock-e"], apply: true }); // takes over
    await sleep(20);
    const lockB = rfb.__getRfbCxLockForTesting();
    assertTrue(!!lockB && lockB.runId !== lockA!.runId, "r3b: run B took over with its own runId");
    assertEq(gates.length, 2, "r3c: both runs are blocked in the judge");
    gates[0](); // A finishes first
    const resA = await runA;
    assertEq(resA.status, 200, "r3d: old run A completes");
    assertEq(rfb.__getRfbCxLockForTesting()?.runId, lockB!.runId, "r3e: A's finally did NOT release B's lock");
    const during = await callRfb({ agentIds: ["cx-lock-d"] });
    assertEq(during.status, 409, "r3f: B's lock still blocks a third call");
    assertEq(during.body?.run_id, lockB!.runId, "r3g: 409 names B's runId");
    gates[1]();
    await runB;
    assertEq(rfb.__getRfbCxLockForTesting(), null, "r3h: B releases its own lock");
    anthropicMode = "ok";
    rfb.__setRfbCxLockMaxMsForTesting(null);
    judgeMod.__setContactJudgeTimeoutMsForTesting(50);

    // r4: 409 body
    const seededAt = Date.now() - 5000;
    rfb.__setRfbCxLockForTesting({ startedAt: seededAt, runId: "holder-run" });
    const c409 = await callRfb({ agentIds: ["cx-lock-c"] });
    assertEq(c409.status, 409, "r4a: fresh lock -> 409");
    assertEq(c409.body?.error, "run_in_progress", "r4b: error code unchanged");
    assertEq(c409.body?.run_id, "holder-run", "r4c: run_id of the holder");
    assertEq(c409.body?.started_at, new Date(seededAt).toISOString(), "r4d: started_at of the holder");
    assertTrue(typeof c409.body?.lock_age_ms === "number" && c409.body.lock_age_ms >= 5000, "r4e: lock_age_ms reported");
    rfb.__setRfbCxLockForTesting(null);

    // ═══ (g) gardssalg route ═══
    for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("experiences");
    const opp = require("./opplevelser") as typeof import("./opplevelser");
    opp.__setGsCxRowDelayForTesting(0);
    const router = opp.default as any;
    const callGs = (): Promise<{ status: number; body: any }> => {
      const req: any = {
        method: "POST", url: "/admin/gardssalg-contact-extraction",
        originalUrl: "/api/opplevelser/admin/gardssalg-contact-extraction",
        path: "/admin/gardssalg-contact-extraction", query: {}, body: {},
        headers: { "x-admin-key": ADMIN_KEY }, get(n: string) { return this.headers[n.toLowerCase()]; },
      };
      let settle!: () => void;
      const done = new Promise<void>((r) => { settle = r; });
      const res: any = {
        statusCode: 200, _body: undefined,
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this._body = b; settle(); return this; },
        send(b: any) { this._body = b; settle(); return this; },
      };
      router.handle(req, res, () => settle());
      return done.then(() => ({ status: res.statusCode, body: res._body }));
    };
    const gsSeed = Date.now() - 4000;
    opp.__setGsCxLockForTesting({ startedAt: gsSeed, runId: "gs-holder" });
    const g1 = await callGs();
    assertEq(g1.status, 409, "g1a: fresh gs lock -> 409");
    assertEq(g1.body?.error, "run_in_progress", "g1b: error code unchanged");
    assertEq(g1.body?.run_id, "gs-holder", "g1c: run_id of the holder");
    assertEq(g1.body?.started_at, new Date(gsSeed).toISOString(), "g1d: started_at of the holder");
    assertTrue(typeof g1.body?.lock_age_ms === "number" && g1.body.lock_age_ms >= 4000, "g1e: lock_age_ms reported");
    assertEq(opp.__getGsCxLockForTesting()?.runId, "gs-holder", "g1f: a refused call leaves the holder's lock alone");

    warnings.length = 0;
    opp.__setGsCxLockMaxMsForTesting(1000);
    const g2 = await callGs();
    assertEq(g2.status, 200, "g2a: gs lock older than GS_CX_LOCK_MAX_MS is taken over");
    assertTrue(warnings.some((w) => w.includes("lock_stale_takeover") && w.includes("gs-holder")), "g2b: lock_stale_takeover logged with the old runId");
    assertEq(opp.__getGsCxLockForTesting(), null, "g3: gs lock released after the takeover run");
    opp.__setGsCxLockMaxMsForTesting(null);
  } catch (err: any) {
    failed++;
    failures.push("cx-run-lock-staleness: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    clearInterval(keepAlive);
    console.warn = prevWarn;
    globalThis.fetch = prevFetch;
    try { judgeMod.__setContactJudgeTimeoutMsForTesting(null); } catch { /* best-effort */ }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
    try { if (prevDb) __setDbForTesting(prevDb); } catch { /* best-effort */ }
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runCxRunLockStalenessTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

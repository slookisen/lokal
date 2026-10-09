/**
 * serverheng-slice5.test.ts — dev-request 2026-10-08-serverheng-hovedtraad-
 * oppstart-statistikk-samtaler, slice 5:
 *   (1) computeOutreachCandidates reads page views + hard bounces ONCE per run
 *       (bounded statement count) and the per-row values equal the old
 *       per-row correlated subqueries;
 *   (2) experiences-geocode bbox repair runs once per 24 h (boot_job_state);
 *   (3) /health's queries count + catalog are SWR-cached (null until ready).
 */
import Database from "better-sqlite3";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

export async function runServerhengSlice5Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) passed++;
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  }

  // ── (1) outreach candidates: bulk lookups ───────────────────────────
  {
    const initMod = require("../database/init") as typeof import("../database/init");
    const aoc = require("../routes/admin-outreach-candidates") as typeof import("../routes/admin-outreach-candidates");
    const prevDb = initMod.__peekDbForTesting();
    const prevPaused = process.env.OUTREACH_PAUSED;
    delete process.env.OUTREACH_PAUSED;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      const N = 12;
      for (let i = 0; i < N; i++) {
        const id = `b-${i}`;
        const email = `post@b${i}.slice5-farm.no`;
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
           VALUES (?, ?, 'test producer', 'test', ?, 'https://slice5-farm.no', 'producer', ?)`,
        ).run(id, `Gård ${i}`, email, `key-${id}`);
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed)
           VALUES (?, ?, 'Vi driver en liten gård med sau og honning, og selger kjøtt og honning direkte fra gården hele året.', '{}', 'verified', 'rich', 200, datetime('now'))`,
        ).run(id, email);
        for (let v = 0; v < i % 4; v++) {
          db.prepare(`INSERT INTO analytics_agent_views (agent_id, agent_name, created_at) VALUES (?, 'x', datetime('now'))`).run(id);
        }
        if (i % 3 === 0) {
          db.prepare(`INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-09-01', ?, 'seo', '', ?)`).run(id, i + 1);
        }
      }
      // mixed-case + padded hard bounce must still match (old LOWER(TRIM()) rule); soft must not
      db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('  POST@B1.Slice5-Farm.no ', '2026-09-01T00:00:00Z', 'hard')`).run();
      db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('post@b2.slice5-farm.no', '2026-09-01T00:00:00Z', 'soft')`).run();

      // Count statements per run by wrapping prepare().
      const seen: string[] = [];
      const origPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { seen.push(sql); return origPrepare(sql); };
      const res = aoc.computeOutreachCandidates(db as any, { mode: "first", cooldownDays: 60, limit: 100 });
      (db as any).prepare = origPrepare;

      const count = (re: RegExp) => seen.filter((s) => re.test(s)).length;
      ok(count(/FROM email_bounces/) === 1, "slice5 outreach: email_bounces read exactly once per run");
      ok(count(/FROM agent_view_daily/) === 1, "slice5 outreach: agent_view_daily read exactly once per run");
      ok(count(/FROM analytics_agent_views/) === 1, "slice5 outreach: analytics_agent_views read exactly once per run");

      // views_count is not in the output, but it is the dedupe tiebreak: two agents
      // sharing one email -> the one with more (rollup + raw) human views wins.
      for (const [id, raw, rollup] of [["d-low", 1, 0], ["d-high", 1, 5]] as Array<[string, number, number]>) {
        db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key) VALUES (?, ?, 'x', 'test', 'post@dup.slice5-farm.no', 'https://slice5-farm.no', 'producer', ?)`).run(id, `Dup ${id}`, `key-${id}`);
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed) VALUES (?, 'post@dup.slice5-farm.no', 'Vi driver en liten gård med sau og honning, og selger kjøtt og honning direkte fra gården hele året.', '{}', 'verified', 'rich', 200, datetime('now'))`).run(id);
        for (let v = 0; v < raw; v++) db.prepare(`INSERT INTO analytics_agent_views (agent_id, agent_name, created_at) VALUES (?, 'x', datetime('now'))`).run(id);
        if (rollup) db.prepare(`INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-09-01', ?, 'seo', '', ?)`).run(id, rollup);
      }
      const res2 = aoc.computeOutreachCandidates(db as any, { mode: "first", cooldownDays: 60, limit: 100 });
      const dupIds = (res2.candidates as any[]).map((c) => c.agent_id).filter((i) => i.startsWith("d-"));
      ok(dupIds.length === 1 && dupIds[0] === "d-high", "slice5 outreach: views (rollup + raw) still decide the dedupe winner");
      const ids = (res.candidates as any[]).map((c) => c.agent_id);
      ok(!ids.includes("b-1"), "slice5 outreach: padded/mixed-case hard bounce still suppresses");
      ok(ids.includes("b-2"), "slice5 outreach: soft bounce does not suppress");
      ok(ids.filter((i) => i.startsWith("b-")).length === N - 1, "slice5 outreach: all other pool rows remain candidates");
    } catch (err) {
      ok(false, "slice5 outreach: unexpected error " + String((err as any)?.message || err));
    } finally {
      if (prevPaused !== undefined) process.env.OUTREACH_PAUSED = prevPaused;
      if (prevDb) initMod.__setDbForTesting(prevDb as any);
      db.close();
    }
  }

  // ── (2) experiences-geocode bbox repair is daily ────────────────────
  {
    const prevPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const paths = ["../database/db-factory", "./experience-store", "./experiences-geocode-worker"].map((p) => require.resolve(p));
    try {
      for (const p of paths) delete require.cache[p];
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db: any = dbFactory.getDb("experiences");
      const worker = require("./experiences-geocode-worker") as typeof import("./experiences-geocode-worker");
      const deps: any = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ adresser: [] }) }), sleep: async () => {} };
      const ins = (id: string) => db.prepare(
        `INSERT INTO experiences (id, slug, title, category, kommune, fylke, loc_lat, loc_lon, geo_precision, verification_status)
         VALUES (?, ?, 't', 'natur_friluft', 'Voss', 'Vestland', 0, 0, 'address', 'verified')`).run(id, id);
      ins("s5-a");
      const t1: any = await worker.experiencesGeocodeTick(5, deps);
      ok(t1.experiences_coords_reset === 1, "slice5 geocode: first tick repairs the impossible coordinate");
      ins("s5-b");
      const t2: any = await worker.experiencesGeocodeTick(5, deps);
      ok(t2.experiences_coords_reset === 0 && t2.providers_coords_reset === 0, "slice5 geocode: second tick within 24 h skips the bbox sweep");
      const stillBad = db.prepare("SELECT loc_lat FROM experiences WHERE id = 's5-b'").get() as any;
      ok(stillBad.loc_lat === 0, "slice5 geocode: skipped sweep leaves the row for the next daily run");
      const t3: any = await worker.experiencesGeocodeTick(5, deps, { bboxRepairMinIntervalHours: 0 });
      ok(t3.experiences_coords_reset === 1, "slice5 geocode: interval 0 (or an aged stamp) runs the sweep again");
    } catch (err) {
      ok(false, "slice5 geocode: unexpected error " + String((err as any)?.message || err));
    } finally {
      if (prevPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevPath;
      for (const p of paths) delete require.cache[p];
    }
  }

  // ── (3) /health cheap counts: SWR, null until ready ─────────────────
  {
    const { createCheapCounters } = require("./health-cheap-counts") as typeof import("./health-cheap-counts");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE analytics_queries (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO analytics_queries DEFAULT VALUES; INSERT INTO analytics_queries DEFAULT VALUES");
    let catalogCalls = 0;
    let t = 1_000_000;
    const c = createCheapCounters({ catalog: () => { catalogCalls++; return { rfb: 5 + catalogCalls, dental: 2, experiences: null }; }, ttlMs: 60_000, now: () => t });
    ok(c.getQueryCount(db as any) === null, "slice5 health: first queries count is null (never inline)");
    const cold = c.getCatalog();
    ok(cold.rfb === null && cold.dental === null && cold.experiences === null, "slice5 health: first catalog is all-null");
    ok(catalogCalls === 0, "slice5 health: nothing computed inside the probe");
    await c.settled();
    ok(c.getQueryCount(db as any) === 2, "slice5 health: next probe serves the cached count");
    ok(c.getCatalog().rfb === 6 && catalogCalls === 1, "slice5 health: catalog served from cache");
    c.getCatalog(); c.getQueryCount(db as any);
    ok(catalogCalls === 1, "slice5 health: repeated probes within TTL do not recompute");
    t += 61_000;
    db.exec("INSERT INTO analytics_queries DEFAULT VALUES");
    ok(c.getQueryCount(db as any) === 2 && c.getCatalog().rfb === 6, "slice5 health: stale value served while refreshing");
    await c.settled();
    ok(c.getQueryCount(db as any) === 3 && c.getCatalog().rfb === 7, "slice5 health: refreshed value after TTL");
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runServerhengSlice5Tests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}

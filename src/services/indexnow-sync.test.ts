/**
 * indexnow-sync.test.ts — dev-request 2026-10-16-indexnow-alle-verter, slice S2.
 * Fixture sitemaps + in-memory DB; fetchImpl is always injected (no network).
 * Exported runIndexNowSyncTests -> TestSummary; wired into tests/test.ts.
 */
import Database from "better-sqlite3";

export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runIndexNowSyncTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
  };
  const ok = (c: boolean, label: string) => eq(!!c, true, label);

  const sync = require("./indexnow-sync") as typeof import("./indexnow-sync");
  const hostsMod = require("./indexnow-hosts") as typeof import("./indexnow-hosts");
  type Host = import("./indexnow-hosts").IndexNowHost;
  const { __initSchemaForTesting } = require("../database/init") as typeof import("../database/init");

  const origWarn = console.warn, origLog = console.log, origErr = console.error;
  const prevDental = process.env.ENABLE_DENTAL;
  const newDb = () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    __initSchemaForTesting(db as any);
    return db;
  };
  const urlset = (items: Array<[string, string | null]>) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    items.map(([l, m]) => `<url><loc>${l}</loc>${m ? `<lastmod>${m}</lastmod>` : ""}</url>`).join("") + `</urlset>`;
  type Call = { host: string; urls: string[] };
  const mkFetch = (status: number | (() => number), calls: Call[]) =>
    (async (_u: any, init: any) => {
      const b = JSON.parse(init.body);
      calls.push({ host: b.host, urls: b.urlList });
      const s = typeof status === "function" ? status() : status;
      return { status: s, ok: s < 300 } as Response;
    }) as unknown as typeof fetch;
  const D = (s: string) => new Date(s);
  const dental = (state: { xml: string }): Host => ({
    vertical: "dental", host: "finn-tannlege.com", baseUrl: "https://finn-tannlege.com",
    enabled: () => true, getSitemapXml: () => state.xml, peekSitemapXml: null, entityPathPrefixes: ["/klinikk/"],
  });
  const D_ = "https://finn-tannlege.com";
  const count = (db: Database.Database, sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as any).n as number;

  try {
    console.warn = () => {}; console.log = () => {}; console.error = () => {};

    // ── parse ──
    const pe = sync.parseSitemapEntries(urlset([[`${D_}/a?x=1&amp;y=2`, "2026-01-01"], [`${D_}/b`, null], [`${D_}/b`, "2026-02-02"]]));
    eq(pe, [{ loc: `${D_}/a?x=1&y=2`, lastmod: "2026-01-01" }, { loc: `${D_}/b`, lastmod: null }], "parse: decode, no lastmod, dedupe");

    // ── baseline sends 0; lastmod advance; 7-day rule; hub today never ──
    {
      const db = newDb(); const st = { xml: urlset([[`${D_}/klinikk/x`, "2026-10-01"], [`${D_}/sted/oslo`, "2026-10-01"]]) };
      const calls: Call[] = []; const f = mkFetch(200, calls); const h = [dental(st)];
      const r1 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-10T12:00:00Z") });
      eq([r1[0]!.baseline, r1[0]!.submitted, calls.length], [2, 0, 0], "baseline stores 2, sends 0");
      eq(count(db, "SELECT COUNT(*) n FROM indexnow_submissions"), 2, "baseline rows in DB");
      const r1b = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-10T13:00:00Z") });
      eq([r1b[0]!.submitted, calls.length], [0, 0], "unchanged sitemap sends 0");

      st.xml = urlset([[`${D_}/klinikk/x`, "2026-10-11"], [`${D_}/sted/oslo`, "today"]]);
      st.xml = st.xml.replace("<lastmod>today</lastmod>", "<lastmod>2026-10-11</lastmod>");
      const r2 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-11T12:00:00Z") });
      eq([r2[0]!.submitted, calls.map((c) => c.urls)], [1, [[`${D_}/klinikk/x`]]], "advanced lastmod on /klinikk/x sends 1; hub /sted/oslo not sent");

      st.xml = urlset([[`${D_}/klinikk/x`, "2026-10-12"], [`${D_}/sted/oslo`, "2026-10-12"]]);
      const r3 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-12T12:00:00Z") });
      eq([r3[0]!.submitted, calls.length], [0, 1], "second advance within 7 days sends 0");
      const r4 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-18T12:01:00Z") });
      eq(r4[0]!.submitted, 1, "advance after >= 7 days sends again");

      // hub stamped literally 'today'
      const db2 = newDb(); const st2 = { xml: urlset([[`${D_}/sted/oslo`, "2026-10-01"], [`${D_}/klinikk/x`, "2026-10-01"]]) };
      const c2: Call[] = []; const f2 = mkFetch(200, c2);
      await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-10T12:00:00Z") });
      st2.xml = urlset([[`${D_}/sted/oslo`, "today"], [`${D_}/klinikk/x`, "2026-10-01"]]);
      await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-11T12:00:00Z") });
      eq(c2.length, 0, "hub /sted/oslo with lastmod 'today' is never sent");
      // new hub IS sent as new
      st2.xml = urlset([[`${D_}/sted/oslo`, "today"], [`${D_}/klinikk/x`, "2026-10-01"], [`${D_}/sted/bergen`, "2026-10-11"]]);
      await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-11T13:00:00Z") });
      eq(c2.map((c) => c.urls), [[`${D_}/sted/bergen`]], "new hub page is sent as new");
    }

    // ── removed URL sent once ──
    {
      const db = newDb(); const R = "https://rettfrabonden.com";
      const mk = (state: { xml: string }): Host => ({ ...dental(state), vertical: "rfb", host: "rettfrabonden.com", baseUrl: R, entityPathPrefixes: ["/produsent/", "/en/produsent/"] });
      const st = { xml: urlset([[`${R}/produsent/y`, "2026-10-01"], [`${R}/produsent/z`, "2026-10-01"]]) };
      const calls: Call[] = []; const f = mkFetch(200, calls);
      await sync.runIndexNowSync({ db, hosts: [mk(st)], fetchImpl: f, now: D("2026-10-10T12:00:00Z") });
      st.xml = urlset([[`${R}/produsent/z`, "2026-10-01"]]);
      const r = await sync.runIndexNowSync({ db, hosts: [mk(st)], fetchImpl: f, now: D("2026-10-11T12:00:00Z") });
      eq([r[0]!.submitted, calls.map((c) => c.urls)], [1, [[`${R}/produsent/y`]]], "removed /produsent/y sent once");
      eq(count(db, "SELECT COUNT(*) n FROM indexnow_submissions WHERE url = ? AND removed_at IS NOT NULL", `${R}/produsent/y`), 1, "removed_at stamped");
      const r2 = await sync.runIndexNowSync({ db, hosts: [mk(st)], fetchImpl: f, now: D("2026-10-12T12:00:00Z") });
      eq([r2[0]!.submitted, calls.length], [0, 1], "next tick sends 0 for the removed URL");
    }

    // ── is_vetted=0 agent never submitted (real RFB sitemap builder) ──
    {
      const initMod = require("../database/init") as typeof import("../database/init");
      const seo = require("../routes/seo") as typeof import("../routes/seo");
      const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
      const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
      const db = newDb();
      try {
        initMod.__setDbForTesting(db as any);
        const ins = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, tags, skills, capabilities,
             languages, city, trust_score, is_active, is_verified, discovery_count, interaction_count, total_interactions, created_at, last_seen_at, is_vetted)
           VALUES (?, ?, 'Beskrivelse', ?, ?, ?, 'producer', ?, '[]', '[]', '[]', '{}', '["no"]', 'Oslo', 0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?)`);
        const know = db.prepare("INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status) VALUES (?, datetime('now'), datetime('now'), 'enriched')");
        const add = (id: string, name: string, vetted: number) => { ins.run(id, name, name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`, vetted); know.run(id); };
        add("ix-v1", "Vetted Gard En", 1);
        add("ix-q1", "Karantene Gard", 0);
        (marketplaceRegistry as any).invalidateCache(); seo.__resetSitemapCacheForTesting();
        const rfb = hostsMod.INDEXNOW_HOSTS.find((x) => x.vertical === "rfb")!;
        const calls: Call[] = []; const f = mkFetch(200, calls);
        const rb = await sync.runIndexNowSync({ db, hosts: [rfb], fetchImpl: f, now: D("2026-10-10T12:00:00Z") });
        ok((rb[0]!.baseline ?? 0) > 0, "is_vetted: RFB baseline taken from real sitemap");
        ok(count(db, "SELECT COUNT(*) n FROM indexnow_submissions WHERE url LIKE '%vetted-gard-en'") >= 1, "is_vetted: vetted agent is in the sitemap rows");
        add("ix-v2", "Vetted Gard To", 1);
        (marketplaceRegistry as any).invalidateCache(); seo.__resetSitemapCacheForTesting();
        const rs = await sync.runIndexNowSync({ db, hosts: [rfb], fetchImpl: f, now: D("2026-10-11T12:00:00Z") });
        ok(rs[0]!.submitted >= 1 && calls.flatMap((c) => c.urls).some((u) => u.includes("vetted-gard-to")), "is_vetted: new vetted agent is submitted");
        eq(calls.flatMap((c) => c.urls).filter((u) => u.includes("karantene")).length, 0, "is_vetted=0 agent never in a POST");
        eq(count(db, "SELECT COUNT(*) n FROM indexnow_submissions WHERE url LIKE '%karantene%'"), 0, "is_vetted=0 agent never in indexnow_submissions");
      } finally {
        if (prevDb) initMod.__setDbForTesting(prevDb); 
        seo.__resetSitemapCacheForTesting();
      }
    }

    // ── ENABLE_DENTAL off skips finn-tannlege ──
    {
      delete process.env.ENABLE_DENTAL;
      const db = newDb(); let built = 0;
      const real = hostsMod.INDEXNOW_HOSTS.find((x) => x.vertical === "dental")!;
      const h: Host = { ...real, getSitemapXml: () => { built++; return ""; }, peekSitemapXml: () => { built++; return null; } };
      const calls: Call[] = [];
      const r = await sync.runIndexNowSync({ db, hosts: [h], fetchImpl: mkFetch(200, calls), now: D("2026-10-10T03:00:00Z") });
      eq([r[0]!.skipped, built, calls.length, count(db, "SELECT COUNT(*) n FROM indexnow_submissions")], ["disabled", 0, 0, 0], "ENABLE_DENTAL off: finn-tannlege skipped, nothing read");
    }

    // ── daily cap: 2500 new -> 2000 + 500 next day ──
    {
      const db = newDb(); const st = { xml: urlset([[`${D_}/klinikk/seed`, "2026-10-01"]]) };
      const calls: Call[] = []; const f = mkFetch(200, calls); const h = [dental(st)];
      await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-10T12:00:00Z") });
      st.xml = urlset([[`${D_}/klinikk/seed`, "2026-10-01"], ...Array.from({ length: 2500 }, (_, i) => [`${D_}/klinikk/n${i}`, "2026-10-11"] as [string, string])]);
      const r = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-11T10:00:00Z") });
      eq([r[0]!.submitted, calls.reduce((s, c) => s + c.urls.length, 0), r[0]!.pending], [2000, 2000, 500], "cap: 2500 new -> 2000 sent, 500 pending");
      const r2 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-11T18:00:00Z") });
      eq(r2[0]!.submitted, 0, "cap: same day sends 0 more");
      const r3 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-12T10:00:00Z") });
      eq([r3[0]!.submitted, r3[0]!.pending], [500, 0], "cap: next UTC day sends the remaining 500");
      const r4 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-12T11:00:00Z"), dailyCap: 10 });
      eq(r4[0]!.submitted, 0, "cap: nothing left");
    }

    // ── 429 -> persisted backoff, next tick sends 0; 403 -> ALERT + stop till next day ──
    {
      const db = newDb(); const st = { xml: urlset([[`${D_}/klinikk/a`, "2026-10-01"]]) };
      const calls: Call[] = []; let status = 429; const f = mkFetch(() => status, calls); const h = [dental(st)];
      await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-10T12:00:00Z") });
      st.xml = urlset([[`${D_}/klinikk/a`, "2026-10-01"], [`${D_}/klinikk/b`, "2026-10-11"]]);
      const r = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-11T10:00:00Z") });
      eq([r[0]!.submitted, r[0]!.status, calls.length], [0, 429, 1], "429: nothing recorded as submitted");
      const bu = (db.prepare("SELECT backoff_until b FROM indexnow_host_state WHERE host = ?").get("finn-tannlege.com") as any).b;
      eq(bu, "2026-10-11T16:00:00.000Z", "429: backoff_until = now + 6h persisted");
      status = 200;
      const r2 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-11T12:00:00Z") });
      eq([r2[0]!.skipped, calls.length], ["backoff", 1], "429: next tick inside backoff sends 0");
      const r3 = await sync.runIndexNowSync({ db, hosts: h, fetchImpl: f, now: D("2026-10-11T16:30:00Z") });
      eq(r3[0]!.submitted, 1, "429: after backoff the URL is retried and sent");

      // 403 -> ALERT, stopped until next UTC day
      const logs: string[] = []; const prevErr = console.error; console.error = (...a: any[]) => { logs.push(a.join(" ")); };
      const db2 = newDb(); const st2 = { xml: urlset([[`${D_}/klinikk/a`, "2026-10-01"]]) };
      const c2: Call[] = []; let s2 = 403; const f2 = mkFetch(() => s2, c2);
      await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-10T12:00:00Z") });
      st2.xml = urlset([[`${D_}/klinikk/a`, "2026-10-01"], [`${D_}/klinikk/b`, "2026-10-11"]]);
      await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-11T10:00:00Z") });
      console.error = prevErr;
      ok(logs.some((l) => l.includes("[indexnow-sync] ALERT host=finn-tannlege.com status=403")), "403: ALERT line logged");
      s2 = 200;
      const rr = await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-11T20:00:00Z") });
      eq([rr[0]!.skipped, c2.length], ["backoff", 1], "403: stopped for the rest of the day");
      const rr2 = await sync.runIndexNowSync({ db: db2, hosts: [dental(st2)], fetchImpl: f2, now: D("2026-10-12T00:05:00Z") });
      eq(rr2[0]!.submitted, 1, "403: resumes next UTC day");
    }

    // ── cold dental cache outside the build window is not built ──
    {
      const db = newDb(); let builds = 0; let cache: { xml: string; builtAt: number } | null = null;
      const h: Host = { ...dental({ xml: "" }), getSitemapXml: () => { builds++; cache = { xml: urlset([[`${D_}/klinikk/a`, "2026-10-01"]]), builtAt: 1 }; return cache.xml; }, peekSitemapXml: () => cache };
      const calls: Call[] = [];
      const r = await sync.runIndexNowSync({ db, hosts: [h], fetchImpl: mkFetch(200, calls), now: D("2026-10-10T12:00:00Z") });
      eq([r[0]!.skipped, builds], ["cold_cache", 0], "cold cache outside window: build stub not called");
      const r2 = await sync.runIndexNowSync({ db, hosts: [h], fetchImpl: mkFetch(200, calls), now: D("2026-10-10T02:00:00Z") });
      eq([r2[0]!.baseline, builds], [1, 1], "cold cache inside 01-05 window: built once, baseline taken");
      const r3 = await sync.runIndexNowSync({ db, hosts: [h], fetchImpl: mkFetch(200, calls), now: D("2026-10-10T14:00:00Z") });
      eq([r3[0]!.skipped, builds], [undefined, 1], "warm cache is peeked, not rebuilt");
      eq(sync.inBuildWindow(D("2026-10-10T05:00:00Z"), "01-05"), false, "window: 05:00 is outside [01,05)");
      eq(sync.inBuildWindow(D("2026-10-10T23:00:00Z"), "22-02"), true, "window: wraps midnight");
    }

    // ── blackout + tick wrapper ──
    {
      eq([sync.inSendBlackout(D("2026-10-10T06:29:00Z")), sync.inSendBlackout(D("2026-10-10T06:30:00Z")), sync.inSendBlackout(D("2026-10-10T09:29:00Z")), sync.inSendBlackout(D("2026-10-10T09:30:00Z"))], [false, true, true, false], "blackout 06:30-09:30 UTC");
      const db = newDb(); const st = { xml: urlset([[`${D_}/klinikk/a`, "2026-10-01"]]) };
      const calls: Call[] = [];
      const o = { db, hosts: [dental(st)], fetchImpl: mkFetch(200, calls) };
      eq(await sync.indexNowSyncTick({ ...o, now: D("2026-10-10T07:00:00Z") }), null, "tick: skipped in blackout");
      ok((await sync.indexNowSyncTick({ ...o, now: D("2026-10-10T12:00:00Z") })) !== null, "tick: runs");
      eq(await sync.indexNowSyncTick({ ...o, now: D("2026-10-10T12:10:00Z") }), null, "tick: recent run skipped");
      ok((await sync.indexNowSyncTick({ ...o, now: D("2026-10-10T13:00:00Z") })) !== null, "tick: runs again after interval");
    }

    // ── 10 000-URL parse < 200 ms ──
    {
      const big = urlset(Array.from({ length: 10_000 }, (_, i) => [`${D_}/klinikk/k${i}`, "2026-10-01"] as [string, string]));
      const t0 = Date.now(); const parsed = sync.parseSitemapEntries(big); const ms = Date.now() - t0;
      eq(parsed.length, 10_000, "perf: 10 000 URLs parsed");
      ok(ms < 200, `perf: parse took ${ms} ms (< 200)`);
    }
  } catch (err) {
    failed++;
    failures.push(`indexnow-sync: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.warn = origWarn; console.log = origLog; console.error = origErr;
    if (prevDental === undefined) delete process.env.ENABLE_DENTAL; else process.env.ENABLE_DENTAL = prevDental;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runIndexNowSyncTests({ log: true }).then((s) => {
    console.log(`indexnow-sync: ${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}

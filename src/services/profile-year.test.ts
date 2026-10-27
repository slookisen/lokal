/**
 * profile-year.test.ts — dev-request 2026-10-22-statistikk-samme-tall-12-mnd,
 * S2c: the per-profile tiles show the last 12 months or «siden <dato>»,
 * never «· 60d».
 *
 * Covers:
 *   (a) computeProfileYear: stored daily sums (agent_view_daily people only,
 *       legacy bucket and other agents left out; agent_ai_view_daily) for the
 *       days before the raw floor, plus the raw part; days before the window
 *       and days on/after the raw floor are not read from the stored tables;
 *       since = null with data for the whole window, else the first day with
 *       data (never before AGENT_VIEW_CLASSIFIED_SINCE, else the raw floor);
 *       a profile with no data; ANALYTICS_ROLLUP_READ=false reads raw only;
 *       «Med i AI-søk» from countingSince; labels equal the site strip's
 *       trafficYearPeriodLabel.
 *   (b) computeAgentStats: `year` sums the stored days and the raw page views
 *       from the raw floor on (one more day than the 60-day window), while
 *       the 60-day fields keep their meaning.
 *   (c) the tiles: the producer page (nb + en) renders no «60d»/«60 d» and
 *       fills from s.year with the server's labels; the dental / experience
 *       «Med i AI-søk» tile (aiDeliveriesTileHtml) says «siste 12 måneder» or
 *       «siden <dato>» exactly like the strip, never «60 d»; the reads use
 *       indexes (EXPLAIN QUERY PLAN).
 *
 * Exported runProfileYearTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/profile-year.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CLAUDE_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
const D = 86_400_000;

function sqlTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runProfileYearTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const prevSince = process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
  const prevRollup = process.env.ANALYTICS_ROLLUP_READ;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const py = require("./profile-year-compute") as typeof import("./profile-year-compute");
    const ty = require("./traffic-year-compute") as typeof import("./traffic-year-compute");
    const { LEGACY_AGENT_VIEW_SOURCE } = require("../database/analytics-sql") as typeof import("../database/analytics-sql");

    const addHuman = db.prepare("INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES (?, ?, ?, '', ?)");
    const addAi = db.prepare("INSERT INTO agent_ai_view_daily (day, agent_id, view_count) VALUES (?, ?, ?)");
    const addDelivery = db.prepare(
      "INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const clear = () => db.exec("DELETE FROM agent_view_daily; DELETE FROM agent_ai_view_daily; DELETE FROM profile_ai_deliveries; DELETE FROM analytics_agent_views; DELETE FROM analytics_page_views;");

    // ── (a) computeProfileYear ────────────────────────────────────────
    {
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
      delete process.env.ANALYTICS_ROLLUP_READ;
      const now = Date.parse("2028-01-15T12:00:00Z");
      const from = py.profileYearFrom(now);
      assertEq(from, "2027-01-16", "(a) the window is 365 days, today included");

      // Full window: stored days reach before the window.
      addHuman.run("2026-12-01", "p1", "direct", 100);           // before the window: left out
      addHuman.run("2027-03-01", "p1", "direct", 5);
      addHuman.run("2027-03-01", "p1", "search", 2);
      addHuman.run("2027-03-02", "p1", LEGACY_AGENT_VIEW_SOURCE, 50); // legacy bucket: left out
      addHuman.run("2027-03-01", "p2", "direct", 40);             // other profile: left out
      addHuman.run("2027-11-20", "p1", "direct", 1000);           // on/after the raw floor: raw counts it
      addAi.run("2026-12-02", "p1", 300);
      addAi.run("2027-06-01", "p1", 4);
      addAi.run("2027-06-01", "p2", 9);
      addDelivery.run("rfb", "p1", "2027-05-01", "mcp", "claude", 3);
      addDelivery.run("rfb", "p1", "2026-12-01", "mcp", "claude", 70); // before the window
      addDelivery.run("dental", "p1", "2027-05-01", "mcp", "claude", 8); // other vertical
      const y = py.computeProfileYear(db, "p1", { rawFrom: "2027-11-15", humanViews: 7, aiViews: 1 }, now);
      assertEq([y.windowDays, y.from, y.to], [365, "2027-01-16", "2028-01-15"], "(a) window fields");
      assertEq(y.humanViews, { value: 5 + 2 + 7, since: null }, "(a) humans: stored window days + raw, legacy/other profile/outside left out; whole window → since null");
      assertEq(y.aiViews, { value: 4 + 1, since: null }, "(a) AI views: the S0 bucket + raw; whole window → since null");
      assertEq([y.aiDeliveries.value, y.aiDeliveries.since, y.aiDeliveries.byVendor.claude], [3, null, 3], "(a) «Med i AI-søk» over 365 days of the rfb profile");
      assertEq(y.labels.nb, { humanViews: "siste 12 måneder", aiViews: "siste 12 måneder", aiDeliveries: "siste 12 måneder" }, "(a) nb labels for a full window");
      assertEq(y.labels.en.humanViews, "last 12 months", "(a) en label for a full window");
      assertEq(y.labels.nb.humanViews, ty.trafficYearPeriodLabel(null, "nb"), "(a) the label is the strip's own");

      // ANALYTICS_ROLLUP_READ=false: raw only, since = the raw floor.
      process.env.ANALYTICS_ROLLUP_READ = "false";
      const rawOnly = py.computeProfileYear(db, "p1", { rawFrom: "2027-11-15", humanViews: 7, aiViews: 1 }, now);
      assertEq([rawOnly.humanViews, rawOnly.aiViews], [{ value: 7, since: "2027-11-15" }, { value: 1, since: "2027-11-15" }], "(a) rollup reads off: raw part only, since the raw floor");
      delete process.env.ANALYTICS_ROLLUP_READ;
      clear();
    }
    {
      // Young data: stored days start before the classification day.
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
      const now = Date.parse("2026-12-20T09:00:00Z");
      addHuman.run("2026-08-10", "p1", LEGACY_AGENT_VIEW_SOURCE, 30);
      addHuman.run("2026-10-05", "p1", "direct", 6);
      addAi.run("2026-10-07", "p1", 2);
      const y = py.computeProfileYear(db, "p1", { rawFrom: "2026-10-21", humanViews: 10, aiViews: 3 }, now);
      assertEq(y.humanViews, { value: 16, since: py.AGENT_VIEW_CLASSIFIED_SINCE }, "(a) humans: since the day views were first classified, not the first (legacy) stored day");
      assertEq(y.aiViews, { value: 5, since: "2026-10-07" }, "(a) AI views: since the first stored AI day");
      assertEq(y.aiDeliveries.since, "2026-10-26", "(a) «Med i AI-søk» since countingSince");
      assertEq(y.labels.nb.humanViews, "siden " + new Date(Date.parse("2026-10-04T00:00:00Z")).toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), "(a) «siden <d. mån. åååå>»");
      assertEq(y.labels.nb.aiDeliveries, ty.trafficYearPeriodLabel("2026-10-26", "nb"), "(a) «Med i AI-søk» label = the strip's");
      assertEq(y.labels.en.aiViews, ty.trafficYearPeriodLabel("2026-10-07", "en"), "(a) en «since <date>»");
      assertTrue(!/60/.test(JSON.stringify(y.labels)), "(a) no 60 in any label");

      // Only legacy stored days so far (today, 2026-10-26): since = the raw floor.
      clear();
      addHuman.run("2026-08-10", "p1", LEGACY_AGENT_VIEW_SOURCE, 30);
      const today = Date.parse("2026-10-26T12:00:00Z");
      const y2 = py.computeProfileYear(db, "p1", { rawFrom: "2026-08-27", humanViews: 4, aiViews: 0 }, today);
      assertEq(y2.humanViews, { value: 4, since: "2026-08-27" }, "(a) stored days before the classification day only: the raw floor is the start");
      assertEq(y2.aiViews, { value: 0, since: "2026-08-27" }, "(a) no AI views yet: 0 with a since date (the tile stays hidden)");
      clear();

      // A profile with no data at all, empty raw table (floor = tomorrow).
      const tomorrow = new Date(today + D).toISOString().slice(0, 10);
      const y3 = py.computeProfileYear(db, "nobody", { rawFrom: tomorrow, humanViews: 0, aiViews: 0 }, today);
      assertEq([y3.humanViews, y3.aiViews, y3.aiDeliveries.value], [{ value: 0, since: "2026-10-26" }, { value: 0, since: "2026-10-26" }, 0], "(a) no data: zeros, since today, no throw");
    }

    // ── (b) computeAgentStats: the raw part and the 60-day fields ─────
    {
      clear();
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
      const { computeAgentStats } = require("./agent-stats-compute") as typeof import("./agent-stats-compute");
      const { hashIP } = require("./analytics-service") as typeof import("./analytics-service");
      // A fixed clock after the classification day, so the stored days count.
      const now = Date.parse("2027-03-01T12:00:00Z");
      const path = "/produsent/aar-gard";
      const pv = db.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, is_owner, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h', ?, 0, 200, 'rfb', ?)`,
      );
      const floorMs = now - 61 * D;
      const floorDay = new Date(floorMs).toISOString().slice(0, 10);
      // The raw floor of analytics_agent_views (rollupBoundaryDateOn).
      db.prepare("INSERT INTO analytics_agent_views (agent_id, agent_name, created_at, traffic_category, is_owner) VALUES ('ag1', 'Aar Gard', ?, 'human', 0)").run(`${floorDay} 00:00:00`);
      const humanSid = (ip: string) => `${hashIP(ip)}:${CHROME_UA}`;
      pv.run(path, humanSid("30.0.0.1"), sqlTs(now - 2 * D));
      pv.run(path, humanSid("30.0.0.2"), sqlTs(now - 3 * D));
      // Inside the raw part but before the 60-day cutoff: in `year`, not in humanViews.
      const oldMs = Math.max(Date.parse(`${floorDay}T00:00:00Z`) + 3600_000, now - 60 * D - 3600_000);
      pv.run(path, humanSid("30.0.0.3"), sqlTs(oldMs));
      pv.run(path, `${hashIP("30.0.0.9")}:${CLAUDE_USER}`, sqlTs(now - 4 * D));
      // Stored days before the floor (classified, inside the window when today is late enough).
      const storedDay = new Date(floorMs - 5 * D).toISOString().slice(0, 10);
      addHuman.run(storedDay, "ag1", "direct", 11);
      addAi.run(storedDay, "ag1", 6);
      const s = computeAgentStats(db, "ag1", path, now);
      assertEq([s.humanViews, s.aiViews, s.windowDays], [2, 1, 60], "(b) the 60-day fields keep their meaning (the older raw view is not in them)");
      assertTrue(storedDay >= py.AGENT_VIEW_CLASSIFIED_SINCE, "(b) setup: the stored day is a classified one");
      assertEq(s.year.humanViews.value, 3 + 11, "(b) year humans = raw views from the floor on (3) + stored days before it");
      assertEq(s.year.aiViews.value, 1 + 6, "(b) year AI views = raw AI search + the S0 bucket");
      assertEq([s.year.humanViews.since, s.year.aiViews.since], [storedDay, storedDay], "(b) young history: «siden <first stored day>»");
      assertTrue(typeof s.year.labels.nb.humanViews === "string" && s.year.labels.nb.humanViews.startsWith("siden "), "(b) the payload carries the nb label");
      assertTrue(JSON.stringify(s).length > 0 && !/"60d"|siste 60/.test(JSON.stringify(s.year)), "(b) no 60-day label in the year block");
      clear();
    }

    // ── (c) the tiles ────────────────────────────────────────────────
    {
      const tile = require("./profile-ai-deliveries-tile") as typeof import("./profile-ai-deliveries-tile");
      const compute = require("./profile-ai-deliveries-compute") as typeof import("./profile-ai-deliveries-compute");
      const now = Date.parse("2026-11-10T10:00:00Z");
      const d = { ...compute.emptyAiDeliveries(365), countingSince: "2026-10-26", total: 4 };
      d.byVendor.claude = 4;
      const html = tile.aiDeliveriesTileHtml(d, now);
      const since = ty.trafficYearPeriodLabel("2026-10-26", "nb");
      assertTrue(html.includes(`&middot; ${since}</small>`), `(c) dental/experience tile: «Med i AI-søk · ${since}», the strip's label`);
      assertTrue(!/60 ?d\b|60 dager/.test(html), "(c) dental/experience tile: no 60-day label");
      const full = tile.aiDeliveriesTileHtml(d, Date.parse("2027-12-01T10:00:00Z"));
      assertTrue(full.includes("&middot; siste 12 måneder</small>"), "(c) a full window after the counting started: «siste 12 måneder»");
      assertEq(tile.aiDeliveriesTileHtml({ ...d, total: 0 }, now), "", "(c) a profile with nothing sent shows no tile (never a 0)");

      // EXPLAIN: the stored reads use indexes, no full scan.
      const plan = (sql: string, ...p: unknown[]) => (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...p) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      const h = plan("SELECT COALESCE(SUM(view_count), 0) AS n FROM agent_view_daily WHERE agent_id = ? AND day >= ? AND day < ? AND view_source != ?", "a", "2026-01-01", "2026-02-01", "x");
      const a = plan("SELECT COALESCE(SUM(view_count), 0) AS n FROM agent_ai_view_daily WHERE agent_id = ? AND day >= ? AND day < ?", "a", "2026-01-01", "2026-02-01");
      const m = plan("SELECT MIN(day) AS d FROM agent_view_daily");
      assertTrue(/USING (COVERING )?INDEX/.test(h) && !/SCAN agent_view_daily$/.test(h), `(c) agent_view_daily per-profile read uses an index (${h})`);
      assertTrue(/USING (COVERING )?INDEX|PRIMARY KEY/.test(a), `(c) agent_ai_view_daily per-profile read uses an index (${a})`);
      assertTrue(/INDEX/.test(m), `(c) MIN(day) is answered from an index (${m})`);
    }
    {
      // The producer page (nb + en): no 60-day label, filled from s.year.
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at)
        VALUES ('ag-y', 'Aarsgard Test', 'En beskrivelse', 'p', 'y@example.no', 'https://y.example.no', 'producer', 'key-y',
          '[]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run();
      const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
      (marketplaceRegistry as any).invalidateCache();
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded */ }
      const seoRouter = require("../routes/seo").default as any;
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const render = (lang: string) => {
        let body = "";
        const res: any = {
          status: () => res, send: (b: unknown) => { body = String(b); return res; }, redirect: () => res,
          setHeader: () => res, set: () => res, header: () => res, type: () => res,
        };
        handler({ params: { slug: "aarsgard-test" }, lang, ip: "10.9.9.9", headers: { "user-agent": CHROME_UA }, method: "GET" }, res, () => undefined);
        return body;
      };
      for (const lang of ["no", "en"]) {
        const body = render(lang);
        assertTrue(body.includes('data-stat="human"') && body.includes('data-stat="ai"') && body.includes('data-stat="aiDeliveries"'), `(c) ${lang}: the three tiles render`);
        const tiles = body.slice(body.indexOf('<div class="pf-stats">'), body.indexOf('<div class="ct-card">'));
        assertTrue(tiles.length > 0 && !/\b60 ?d\b|60d|60 (dager|days)/.test(tiles), `(c) ${lang}: no 60-day label in the tiles`);
        assertTrue(!body.includes("${"), `(c) ${lang}: no raw \${…}`);
        assertTrue(body.includes("var y = s.year;") && body.includes("y.labels["), `(c) ${lang}: the tiles are filled from s.year with the server's labels`);
        assertTrue(!body.includes("s.humanViews > 0") && !body.includes("fmt(s.humanViews)"), `(c) ${lang}: the 60-day number is no longer shown on the tile`);
        const label = py.aiDeliveriesYearPeriodLabel((require("./profile-ai-deliveries-compute") as typeof import("./profile-ai-deliveries-compute")).aiDeliveriesCountingSince(), Date.now(), lang === "en" ? "en" : "nb");
        assertTrue(tiles.includes(`&middot; ${label}</span>`), `(c) ${lang}: «Med i AI-søk» subtitle carries «${label}»`);
      }
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevSince === undefined) delete process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
    else process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = prevSince;
    if (prevRollup === undefined) delete process.env.ANALYTICS_ROLLUP_READ;
    else process.env.ANALYTICS_ROLLUP_READ = prevRollup;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try {
      const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
      (marketplaceRegistry as any).invalidateCache();
    } catch { /* ignore */ }
    db.close();
  }
  if (log) console.log(`\nprofile-year: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileYearTests({ log: true }).then((r) => {
    for (const f of r.failures) console.log(f);
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

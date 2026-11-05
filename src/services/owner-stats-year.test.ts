/**
 * owner-stats-year.test.ts — dev-request 2026-10-22-statistikk-samme-tall-
 * 12-mnd, S2d: the owner portals' tiles that match the public profile tiles
 * show the last 12 months or «siden <dato>», like the public tiles (S2c).
 *
 * Covers:
 *   (a) RFB getOwnerStats: `year` = stored daily sums (agent_view_daily people
 *       only, legacy bucket out; agent_ai_view_daily) for the days before the
 *       raw floor + the raw page views from the floor on; stored rows on or
 *       after the floor are not counted twice; same numbers as the public
 *       tile (computeAgentStats().year); the 60-day fields keep their
 *       meaning; «Med i AI-søk» over 365 days with the strip's label;
 *       ANALYTICS_ROLLUP_READ=false reads raw only.
 *   (b) selger.html's renderOwnerStats, run on that payload: «Sett» and all
 *       AI search show the year numbers with «siden <dato>» / «siste 12
 *       måneder», «Med i AI-søk» carries the year label, no «Med i AI-svar»,
 *       and those tiles carry no 60-day label.
 *   (c) gårdssalg getGardssalgOwnerStats: «Med i AI-søk» over 365 days with
 *       windowLabel = the public tile's label; the page-view numbers stay at
 *       60 days (no stored per-profile sums); the portal renders windowLabel
 *       and never «Med i AI-svar».
 *
 * Exported runOwnerStatsYearTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/owner-stats-year.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

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

/** selger.html's renderOwnerStats(data), run against a stub DOM; returns each element's innerHTML by id. */
function renderOwnerStatsHtml(data: unknown): Record<string, string> {
  const src = fs.readFileSync(path.join(__dirname, "../public/selger.html"), "utf8");
  const start = src.indexOf("function renderOwnerStats(data) {");
  if (start < 0) throw new Error("renderOwnerStats not found in selger.html");
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const els: Record<string, { innerHTML: string; classList: { add: () => void; remove: () => void } }> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= { innerHTML: "", classList: { add: () => undefined, remove: () => undefined } }),
    querySelectorAll: () => [],
  };
  const escHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fn = new Function("document", "escHtml", "ownLabel", "SOURCE_LABELS", "CHANNEL_LABELS", "clickKindLabel",
    src.slice(start, end) + "\nreturn renderOwnerStats;");
  const render = fn(document, escHtml, (m: Record<string, string>, k: string) => m[k], {}, {}, (k: string) => k);
  render(JSON.parse(JSON.stringify(data)));
  const out: Record<string, string> = {};
  for (const [id, el] of Object.entries(els)) out[id] = el.innerHTML;
  return out;
}

export async function runOwnerStatsYearTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
    delete process.env.ANALYTICS_ROLLUP_READ;
    const ty = require("./traffic-year-compute") as typeof import("./traffic-year-compute");
    const { LEGACY_AGENT_VIEW_SOURCE } = require("../database/analytics-sql") as typeof import("../database/analytics-sql");
    const { hashIP } = require("./analytics-service") as typeof import("./analytics-service");
    const { getOwnerStats } = require("./owner-stats-service") as typeof import("./owner-stats-service");
    const { computeAgentStats } = require("./agent-stats-compute") as typeof import("./agent-stats-compute");

    const addHuman = db.prepare("INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES (?, ?, ?, '', ?)");
    const addAi = db.prepare("INSERT INTO agent_ai_view_daily (day, agent_id, view_count) VALUES (?, ?, ?)");
    const addDelivery = db.prepare(
      "INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const pv = db.prepare(
      `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, is_owner, status_code, vertical_id, created_at)
       VALUES (?, 'direct', 'h', ?, 0, 200, ?, ?)`,
    );
    const humanSid = (ip: string) => `${hashIP(ip)}:${CHROME_UA}`;
    const aiSid = (ip: string) => `${hashIP(ip)}:${CLAUDE_USER}`;

    // A fixed clock after the classification day and after countingSince.
    const now = Date.parse("2027-03-01T12:00:00Z");
    const floorMs = now - 61 * D;
    const floorDay = new Date(floorMs).toISOString().slice(0, 10);
    const storedDay = new Date(floorMs - 5 * D).toISOString().slice(0, 10);
    const oldMs = Math.max(Date.parse(`${floorDay}T00:00:00Z`) + 3600_000, now - 60 * D - 3600_000);

    // ── (a) RFB owner portal ─────────────────────────────────────────
    const rfbPath = "/produsent/aar-eier";
    {
      // The raw floor of analytics_agent_views (rollupBoundaryDateOn).
      db.prepare("INSERT INTO analytics_agent_views (agent_id, agent_name, created_at, traffic_category, is_owner) VALUES ('ow1', 'Aar Eier', ?, 'human', 0)").run(`${floorDay} 00:00:00`);
      pv.run(rfbPath, humanSid("40.0.0.1"), "rfb", sqlTs(now - 2 * D));
      pv.run(rfbPath, humanSid("40.0.0.2"), "rfb", sqlTs(now - 3 * D));
      pv.run(rfbPath, humanSid("40.0.0.3"), "rfb", sqlTs(oldMs));      // raw, before the 60-day cutoff
      pv.run(rfbPath, aiSid("40.0.0.9"), "rfb", sqlTs(now - 4 * D));
      pv.run(rfbPath, aiSid("40.0.0.8"), "rfb", sqlTs(oldMs));         // raw AI search, before the cutoff
      addHuman.run(storedDay, "ow1", "direct", 11);
      addHuman.run(storedDay, "ow1", LEGACY_AGENT_VIEW_SOURCE, 50);   // legacy bucket: left out
      addHuman.run(floorDay, "ow1", "direct", 1000);                  // on the raw floor: raw counts it, never twice
      addHuman.run(storedDay, "other", "direct", 70);                 // other profile
      addAi.run(storedDay, "ow1", 6);
      addAi.run(floorDay, "ow1", 500);                                // on the raw floor: left out
      addDelivery.run("rfb", "ow1", "2026-11-01", "mcp", "claude", 4);
      addDelivery.run("rfb", "ow1", "2026-10-20", "mcp", "claude", 9); // before countingSince

      const o = getOwnerStats(db as any, "ow1", rfbPath, now);
      assertEq([o.windowDays, o.funnel.viewed, o.aiPlatforms.total], [60, 2, 1], "(a) the 60-day fields keep their meaning (older raw views are not in them)");
      const sourceSum = Object.values(o.viewsBySource.totals).reduce((a, b) => a + b, 0);
      assertEq(sourceSum, o.funnel.viewed, "(a) views by source still add up to the 60-day «Sett»");
      assertTrue(o.viewsBySource.daily.every((r) => r.count > 0), "(a) the daily series has no empty rows from year-only groups");
      assertEq(o.year.humanViews, { value: 3 + 11, since: storedDay }, "(a) year «Sett» = raw from the floor (3) + stored days before it (11), no double count");
      assertEq(o.year.aiViews, { value: 2 + 6, since: storedDay }, "(a) year AI search = raw (2) + the S0 bucket (6), no double count");
      assertEq(o.year.labels.nb.humanViews, ty.trafficYearPeriodLabel(storedDay, "nb"), "(a) «Sett» label = the strip's «siden <dato>»");
      assertTrue(o.year.labels.nb.humanViews.startsWith("siden "), "(a) young history: «siden <dato>»");
      assertEq([o.aiDeliveries.window.windowDays, o.aiDeliveries.window.total, o.year.aiDeliveries.value], [365, 4, 4], "(a) «Med i AI-søk» over 12 months, from countingSince");
      assertEq(o.year.labels.nb.aiDeliveries, ty.trafficYearPeriodLabel("2026-10-26", "nb"), "(a) «Med i AI-søk» label = the public tile's");
      assertTrue(!/60/.test(JSON.stringify(o.year.labels)), "(a) no 60 in the year labels");

      const pub = computeAgentStats(db as any, "ow1", rfbPath, now);
      assertEq([o.year.humanViews, o.year.aiViews, o.year.labels], [pub.year.humanViews, pub.year.aiViews, pub.year.labels], "(a) same numbers and labels as the public producer tiles");

      process.env.ANALYTICS_ROLLUP_READ = "false";
      const raw = getOwnerStats(db as any, "ow1", rfbPath, now);
      assertEq([raw.year.humanViews.value, raw.year.aiViews.value], [3, 2], "(a) rollup reads off: raw part only");
      delete process.env.ANALYTICS_ROLLUP_READ;

      // A full window: the first stored day lies before the window's start → «siste 12 måneder».
      const fullHistory = getOwnerStats(db as any, "ow1", rfbPath, Date.parse("2028-01-15T12:00:00Z"));
      assertEq([fullHistory.year.from, fullHistory.year.labels.nb.humanViews], ["2027-01-16", "siste 12 måneder"], "(a) data older than the window: «siste 12 måneder»");

      // ── (b) selger.html renders the year tiles ─────────────────────
      const html = renderOwnerStatsHtml(o);
      const funnel = html.statsFunnel || "";
      const ai = html.statsAiPlatforms || "";
      const dl = (html.statsAiDeliveries || "") + (html.statsAiDeliveriesVendor || "") + (html.statsAiDeliveriesChannel || "");
      const sinceLabel = o.year.labels.nb.humanViews;
      assertTrue(funnel.includes(`<div class="stat-number">14</div><div class="stat-label">Sett (${sinceLabel})</div>`), `(b) «Sett» tile: 14 · ${sinceLabel}`);
      assertTrue(funnel.includes("Kontakt-klikk (60d)"), "(b) contact clicks stay at 60 days (no stored sums)");
      assertTrue(!/Sett \(60d\)/.test(funnel), "(b) «Sett» has no 60-day label");
      assertTrue(ai.includes(`<div class="stat-number">8</div><div class="stat-label">Alle AI-assistenter (${o.year.labels.nb.aiViews})</div>`), "(b) all AI search: the year number with its label");
      assertTrue(dl.includes(`<div class="stat-number">4</div><div class="stat-label">Ganger profilen var blant treffene en AI-assistent hentet (${o.year.labels.nb.aiDeliveries})</div>`), "(b) «Med i AI-søk»: 12-month number with the public label");
      assertTrue(!/\(60d\)|siste 60/.test(dl), "(b) «Med i AI-søk» rows carry no 60-day label");
      const all = Object.values(html).join("\n");
      assertTrue(!all.includes("Med i AI-svar"), "(b) no «Med i AI-svar» in the rendered tab");
      const selgerSrc = fs.readFileSync(path.join(__dirname, "../public/selger.html"), "utf8");
      assertTrue(!selgerSrc.includes("Med i AI-svar") && selgerSrc.includes("<h2>Med i AI-s&oslash;k</h2>"), "(b) selger.html: «Med i AI-søk», never «Med i AI-svar»");
      // An older payload without `year` still renders (60-day fallback).
      const legacy = renderOwnerStatsHtml({ ...o, year: undefined });
      assertTrue((legacy.statsFunnel || "").includes("Sett (60d)"), "(b) a payload without `year` falls back to the 60-day number");
    }

    // ── (c) gårdssalg owner portal ───────────────────────────────────
    {
      const gs = require("./gardssalg-owner-stats-service") as typeof import("./gardssalg-owner-stats-service");
      const py = require("./profile-year-compute") as typeof import("./profile-year-compute");
      const gsPath = "/kategori/gardssalg/produsent/aar-sider";
      const realNow = Date.now();
      pv.run(gsPath, humanSid("50.0.0.1"), "experiences", sqlTs(realNow - 2 * D));
      pv.run(gsPath, humanSid("50.0.0.2"), "experiences", sqlTs(realNow - 70 * D)); // outside the 60-day raw window
      pv.run(gsPath, aiSid("50.0.0.9"), "experiences", sqlTs(realNow - 3 * D));
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      addDelivery.run("experiences", "gs-aar", day(realNow - 1 * D), "mcp", "chatgpt", 2);
      addDelivery.run("experiences", "gs-aar", day(realNow - 200 * D), "a2a", "unknown", 5); // inside 12 months, before countingSince when it is later
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = day(realNow - 300 * D);
      const o = gs.getGardssalgOwnerStats(gsPath, "gs-aar", realNow);
      assertEq([o.windowDays, o.humanViews, o.aiSearchViews], [60, 1, 1], "(c) page views stay at 60 days (no stored per-profile sums for gårdssalg)");
      assertEq([o.aiDeliveries?.window.windowDays, o.aiDeliveries?.window.total], [365, 7], "(c) «Med i AI-søk» over 12 months (the 200-day-old row counts)");
      assertEq(o.aiDeliveries?.windowLabel, ty.trafficYearPeriodLabel(day(realNow - 300 * D), "nb"), "(c) windowLabel = «siden <dato>» while counting is younger than the window");
      assertEq(o.aiDeliveries?.windowLabel, py.aiDeliveriesYearPeriodLabel(day(realNow - 300 * D), realNow, "nb"), "(c) windowLabel = the public tile's label");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = day(realNow - 400 * D);
      assertEq(gs.getGardssalgOwnerStats(gsPath, "gs-aar", realNow).aiDeliveries?.windowLabel, "siste 12 måneder", "(c) counting older than the window: «siste 12 måneder»");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";

      const claimSrc = fs.readFileSync(path.join(__dirname, "../routes/gardssalg-claim.ts"), "utf8");
      assertTrue(claimSrc.includes("hentet (' + dl.windowLabel + ')") && !claimSrc.includes("dlPartial"), "(c) the portal's «Med i AI-søk» tile shows windowLabel, not «N dager»");
      assertTrue(!claimSrc.includes("Med i AI-svar"), "(c) the gårdssalg portal never says «Med i AI-svar»");
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
    db.close();
  }
  if (log) console.log(`\nowner-stats-year: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerStatsYearTests({ log: true }).then((r) => {
    for (const f of r.failures) console.log(f);
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

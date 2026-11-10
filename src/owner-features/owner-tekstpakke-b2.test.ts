/**
 * owner-tekstpakke-b2.test.ts — tekstpakke B2 (approved owner-facing stat names
 * in «Mine valg» and the «(siste N dager)» label on the owner Statistikk page).
 *
 *   m-*  «Mine valg» (RFB statsHtml and gårdssalg gardssalgStatsHtml): the new
 *        names appear verbatim, the old names are absent from the block.
 *   s-*  owner Statistikk AI card: «(siste N dager)» with N from the input, no
 *        « d)» anywhere on the owner page.
 *   p-*  the shared aiDeliveriesPeriodLabel() is unchanged («siste 60 d»).
 *
 * Pure renders (page.ts, stats-page.ts); an in-memory DB only for the
 * registry resolve. Standalone: npx tsx src/owner-features/owner-tekstpakke-b2.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerTekstpakkeB2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.info(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.info(`  ✗ ${name}`); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const pg = require("./page") as typeof import("./page");
    const rs = require("./resolve") as typeof import("./resolve");
    const base = () => ({
      agent: { id: "b2-ag", name: "Gård B2" }, resolved: rs.resolveOwnerFeatures("rfb", "b2-ag", { db }), level: null, showIntro: false,
      notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
      statsHref: "/selger?agent=b2-ag#statistikk",
    });
    const blockOf = (html: string) => {
      const i = html.indexOf('id="statistikk"');
      const j = html.indexOf("</section>", i);
      return i < 0 ? "" : html.slice(i, j);
    };

    // ── RFB «Mine valg» ──────────────────────────────────────────────────────
    const rfb = blockOf(pg.renderOwnerFeaturesPageBody({
      ...base(),
      stats: {
        humanViews: { value: 30, label: "siste 12 måneder" }, aiViews: { value: 9, label: "siste 12 måneder" },
        aiSplit: { chatgpt: 4, claude: 3, other: 2, days: 60 }, aiDeliveries: { value: 11, label: "siden 1. okt. 2026" },
        clicks: { phone: 2, website: 5, days: 60 }, minPublicViews: 20, tip: "Legg til åpningstider",
      },
    } as any));
    ok(rfb.length > 0, "m-00: the RFB statistics block renders");
    const spans: Array<[string, string, string]> = [
      ["Besøk på profilen", "Sidevisninger fra mennesker", "m-01"],
      ["Hentet av AI-assistenter", "AI-søk", "m-02"],
      ["Med i treffene til AI-assistenter", "Med i AI-søk", "m-03"],
      ["Trykk på telefon", "Klikk til telefon", "m-04"],
      ["Trykk på nettside", "Klikk til nettside", "m-05"],
    ];
    for (const [nu, old, id] of spans) {
      ok(rfb.includes(`<span>${nu}</span>`), `${id}: RFB tile «${nu}» appears verbatim`);
      ok(!rfb.includes(old), `${id}: RFB block no longer says «${old}»`);
    }
    ok(rfb.includes("Trykk på kart telles ikke ennå.") && !rfb.includes("Klikk til kart"), "m-06: «Trykk på kart telles ikke ennå.», old text gone");
    ok(rfb.includes("ChatGPT 4 · Claude 3 · Andre 2 (siste 60 dager)") && rfb.includes("Se all statistikk"), "m-07: unchanged: the AI split line and «Se all statistikk»");
    ok(rfb.includes("<small>siste 60 dager</small>"), "m-08: unchanged: click tile sub-text «siste N dager»");

    // ── Gårdssalg «Mine valg» (#3 only) ──────────────────────────────────────
    const gs = blockOf(pg.renderOwnerFeaturesPageBody({
      ...base(),
      gardssalgStats: { humanViews: 40, aiSearchViews: 8, windowDays: 60, aiDeliveries: { value: 6, label: "siste 12 måneder" }, tip: "Legg til bilde" },
    } as any));
    ok(gs.includes("<span>Med i treffene til AI-assistenter</span>") && !gs.includes("Med i AI-søk"), "m-09: gårdssalg tile «Med i treffene til AI-assistenter», old text gone");
    ok(gs.includes("<span>Personer som så profilen</span>") && gs.includes("<span>Funnet via AI-assistenter</span>"), "m-10: gårdssalg other tiles unchanged");

    // ── Owner Statistikk page ────────────────────────────────────────────────
    const sp = require("../owner-ui/stats-page") as typeof import("../owner-ui/stats-page");
    const stats: any = {
      windowDays: 60,
      funnel: { discovered: 42, viewed: 6, contactClicked: 4 },
      year: {
        humanViews: { value: 30 }, aiViews: { value: 9 }, aiDeliveries: { value: 11 },
        labels: { nb: { humanViews: "siste 12 måneder", aiViews: "siste 12 måneder", aiDeliveries: "siste 12 måneder" } },
      },
      aiFunnel: {
        windowDays: 60,
        sentToAi: { total: 11, label: "siste 60 d" },
        aiClicks: { total: 3, label: "siste 60 d", byVendor: { chatgpt: 2, claude: 1 } },
        contactClicks: { total: 4, label: "siste 60 d", fromAi: { total: 1, label: "siste 60 d" } },
      },
      viewsBySource: { totals: { direct: 3 }, daily: [] },
      aiPlatforms: { chatgpt: 4, claude: 2, other: 1, total: 7 },
      aiDeliveries: {
        window: { total: 11, windowDays: 365, byVendor: { chatgpt: 6 }, byChannel: { mcp: 2 } },
        allTime: { total: 20, byVendor: { chatgpt: 10 }, byChannel: { mcp: 3 } },
      },
      matchingSearchQueries: [],
      conversationsByChannel: [{ source: "web", count: 2 }],
      contactClicksByKind: [{ kind: "email", count: 2 }],
    };
    const nowMs = Date.parse("2026-11-09T12:00:00Z");
    const page = sp.renderOwnerStatsPageBody({ stats, nowMs });
    ok(page.includes("Med i treffene til AI (siste 60 dager)"), "s-01: AI card «Med i treffene til AI (siste 60 dager)»");
    ok(page.includes("Besøk fra et AI-svar (siste 60 dager, minst)"), "s-02: AI card «Besøk fra et AI-svar (siste 60 dager, minst)»");
    ok(page.includes("Trykk på e-post, telefon eller nettside (siste 60 dager)"), "s-03: AI card contact tile «(siste 60 dager)»");
    ok(page.includes("Av disse kom fra et AI-svar: <strong data-ai-funnel-from-ai=\"1\">1</strong> (siste 60 dager)"), "s-04: the «fra AI» sub-label «(siste 60 dager)»");
    ok(!/ d\)/.test(page), "s-05: no « d)» anywhere on the owner Statistikk page");
    const other = sp.renderOwnerStatsPageBody({
      stats: { ...stats, aiFunnel: { windowDays: 45, sentToAi: { total: 1, label: "siste 45 d" }, aiClicks: { total: 0, byVendor: {} } } }, nowMs,
    });
    ok(other.includes("Med i treffene til AI (siste 45 dager)") && !/ d\)/.test(other), "s-06: N comes from the input (45)");
    const noLabel = sp.renderOwnerStatsPageBody({
      stats: { ...stats, aiFunnel: { windowDays: 30, sentToAi: { total: 1 } } }, nowMs,
    });
    ok(noLabel.includes("Med i treffene til AI (siste 30 dager)"), "s-07: no step label → default «siste N dager» from windowDays");
    const since = sp.renderOwnerStatsPageBody({
      stats: { ...stats, aiFunnel: { windowDays: 60, sentToAi: { total: 1, label: "siden 3. nov." } } }, nowMs,
    });
    ok(since.includes("Med i treffene til AI (siden 3. nov.)"), "s-08: a «siden <dato>» label is left alone");

    // ── Shared label stays byte-identical ────────────────────────────────────
    const comp = require("../services/profile-ai-deliveries-compute") as typeof import("../services/profile-ai-deliveries-compute");
    ok(comp.aiDeliveriesPeriodLabel(null, 60, nowMs, "nb") === "siste 60 d", "p-01: aiDeliveriesPeriodLabel(nb) still «siste 60 d»");
    ok(comp.aiDeliveriesPeriodLabel(null, 60, nowMs, "en") === "last 60 d", "p-02: aiDeliveriesPeriodLabel(en) still «last 60 d»");
  } finally {
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerTekstpakkeB2Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) { for (const f of r.failures) console.info("  - " + f); process.exit(1); }
  });
}

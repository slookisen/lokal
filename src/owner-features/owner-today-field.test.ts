/**
 * owner-today-field.test.ts — slice T14b: the optional «I dag» (`today`) field on
 * planned owner-feature entries. Infrastructure only: no real entry has `today` yet.
 *
 *   a  real registry: «Mine valg» HTML and owner-API JSON carry no `today` output and
 *      are identical to the render with the `today` path stripped.
 *   b  a test entry (cloned coming_soon + `today`): «I dag:» line with escaped text;
 *      the API carries `today` {no,en}; other rows are unchanged.
 *   c  governance (checkTodayGovernance): real registry passes; the rule is proven to
 *      bite on synthetic entries (today on a live entry, 241-char text, bad text).
 *
 * Standalone: npx tsx src/owner-features/owner-today-field.test.ts
 */

import Database from "better-sqlite3";
import { OWNER_FEATURE_REGISTRY, type OwnerFeatureEntry } from "./registry";
import type { ForProdusenterFacts } from "./today-facts";

export interface TestSummary { passed: number; failed: number; failures: string[] }

export const TODAY_MAX_CHARS = 240;

/** Fact combinations the governance rule runs every `today` function against. */
export function todayFactVariants(base: ForProdusenterFacts): ForProdusenterFacts[] {
  const flip = (p: ForProdusenterFacts["pilot"], s: "for_alle" | "i_pilot" | "planlagt") =>
    Object.fromEntries(Object.keys(p).map((k) => [k, s])) as ForProdusenterFacts["pilot"];
  return [
    base,
    { ...base, orderCapV2On: !base.orderCapV2On, autocompleteOn: !base.autocompleteOn, buyerReceiptsOn: !base.buyerReceiptsOn, ownerPauseOn: !base.ownerPauseOn, autoUpdatesOn: !base.autoUpdatesOn },
    { ...base, pilot: flip(base.pilot, "for_alle") },
    { ...base, pilot: flip(base.pilot, "i_pilot") },
    { ...base, pilot: flip(base.pilot, "planlagt") },
    { ...base, reminderHours: 1, autocancelHours: 2, dailyCap: 1, publicStatsMinViews: 1, stockValidDays: 1, stockHardDays: 1 },
    { ...base, reminderHours: 999, autocancelHours: 9999, dailyCap: 9999, publicStatsMinViews: 99999, stockValidDays: 365, stockHardDays: 730 },
  ];
}

/** One problem string per violation; [] = the entries obey the `today` rules. */
export function checkTodayGovernance(registry: readonly OwnerFeatureEntry[], base: ForProdusenterFacts): string[] {
  const problems: string[] = [];
  const variants = todayFactVariants(base);
  for (const e of registry) {
    if (!e.today) continue;
    if (e.status !== "coming_soon") problems.push(`${e.key}: today is only allowed on coming_soon entries (status ${e.status})`);
    variants.forEach((f, i) => {
      let t: { no: string; en: string };
      try { t = e.today!(f); } catch (err: any) { problems.push(`${e.key}[facts ${i}]: today() threw ${String(err?.message || err)}`); return; }
      for (const lang of ["no", "en"] as const) {
        const s = t?.[lang];
        const w = `${e.key}[facts ${i}].${lang}`;
        if (typeof s !== "string" || s.trim() === "") { problems.push(`${w}: empty`); continue; }
        if (s.length > TODAY_MAX_CHARS) problems.push(`${w}: ${s.length} chars (max ${TODAY_MAX_CHARS})`);
        if (/^\s*(i dag|today)\b/i.test(s)) problems.push(`${w}: must not start with «I dag»/«Today» (the page adds the label)`);
        if (/undefined|NaN|\{/.test(s)) problems.push(`${w}: contains undefined, NaN or «{»`);
      }
    });
  }
  return problems;
}

export async function runOwnerTodayFieldTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const routes = require("../routes/owner-features") as typeof import("../routes/owner-features");
    const tf = require("./today-facts") as typeof import("./today-facts");
    const resolved = rs.resolveOwnerFeatures("rfb", "td-ag", { db });
    const model = (registry?: OwnerFeatureEntry[]) => ({
      agent: { id: "td-ag", name: "Gård T14b" }, resolved, level: null, showIntro: false,
      notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
      statsHref: "/selger?agent=td-ag#statistikk", interest: new Set<string>(),
      ...(registry ? { registry } : {}),
    } as any);
    const apiJson = (reg: readonly OwnerFeatureEntry[]) =>
      JSON.stringify(reg.map((e) => routes.featureJson(e, resolved.byKey[e.key], resolved.subject)));

    // ── a: real registry unchanged ──────────────────────────────────────────
    ok(OWNER_FEATURE_REGISTRY.every((e) => !e.today), "a-01: no real registry entry has `today` yet");
    const realHtml = pg.renderOwnerFeaturesPageBody(model());
    const stripped = OWNER_FEATURE_REGISTRY.map((e) => ({ ...e, today: undefined }) as OwnerFeatureEntry);
    ok(realHtml.includes("mv-item-planned"), "a-02: the fixture renders planned rows");
    ok(!realHtml.includes("mv-today") && !realHtml.includes("I dag:"), "a-03: real «Mine valg» has no mv-today / «I dag:»");
    ok(realHtml === pg.renderOwnerFeaturesPageBody(model(stripped)), "a-04: «Mine valg» HTML is byte-identical to the render with `today` stripped");
    const realApi = apiJson(OWNER_FEATURE_REGISTRY);
    ok(!realApi.includes('"today"'), "a-05: real owner API JSON has no `today` key");
    ok(realApi === apiJson(stripped), "a-06: owner API JSON is byte-identical to the stripped registry");

    // ── b: a test entry with `today` ────────────────────────────────────────
    const planned = OWNER_FEATURE_REGISTRY.find((e) => e.status === "coming_soon" && resolved.byKey[e.key] && !pg.isOwnerFeatureBuilt(e))!;
    ok(!!planned, "b-00: a planned entry exists to clone");
    const todayText = { no: `Vi gjør <b>X</b> & Y nå (${"{"}ikke${"}"})`.replace(/[{}]/g, ""), en: "We do X now" };
    const withToday: OwnerFeatureEntry = { ...planned, today: () => todayText };
    const reg = OWNER_FEATURE_REGISTRY.map((e) => (e.key === planned.key ? withToday : e));
    const html = pg.renderOwnerFeaturesPageBody(model(reg));
    ok(html.includes(`<p class="mv-today"><strong>I dag:</strong> Vi gjør &lt;b&gt;X&lt;/b&gt; &amp; Y nå (ikke)</p>`), "b-01: the «I dag:» line renders with escaped text");
    const descIdx = html.indexOf(`data-planned-key="${planned.key}"`);
    const seg = html.slice(descIdx, html.indexOf("</li>", descIdx));
    ok(seg.indexOf('class="mv-desc"') > 0 && seg.indexOf('class="mv-desc"') < seg.indexOf("mv-today") && seg.indexOf("mv-today") < seg.indexOf("mv-item-ctl"), "b-02: the line sits right after mv-desc inside mv-item-text");
    ok((html.match(/class="mv-today"/g) || []).length === 1, "b-03: exactly one «I dag:» line");
    ok(html.replace(/<p class="mv-today">.*?<\/p>/, "") === realHtml, "b-04: apart from that line the page is unchanged");
    const apiWith = JSON.parse(apiJson(reg)) as any[];
    const row = apiWith.find((r) => r.key === planned.key);
    ok(row.today && row.today.no === todayText.no && row.today.en === todayText.en, "b-05: the API carries today {no,en} for the entry");
    ok(apiWith.filter((r) => "today" in r).length === 1, "b-06: other entries have no `today` key");

    // ── c: governance ───────────────────────────────────────────────────────
    const facts = tf.currentForProdusenterFacts({} as NodeJS.ProcessEnv);
    const realProblems = checkTodayGovernance(OWNER_FEATURE_REGISTRY, facts);
    ok(realProblems.length === 0, `c-01: real registry obeys the today rules ${realProblems.join("; ")}`);
    ok(todayFactVariants(facts).length >= 5, "c-02: several fact combinations are exercised");
    const good = { ...planned, key: "fx.good", today: () => ({ no: "Vi sender en påminnelse etter 24 timer.", en: "We send a reminder after 24 hours." }) } as OwnerFeatureEntry;
    ok(checkTodayGovernance([good], facts).length === 0, "c-03: a good synthetic entry passes");
    const live = { ...good, key: "fx.live", status: "live" } as OwnerFeatureEntry;
    ok(checkTodayGovernance([live], facts).some((p) => p.startsWith("fx.live: today is only allowed on coming_soon")), "c-04: today on a live entry FAILS");
    const long = { ...good, key: "fx.long", today: () => ({ no: "x".repeat(241), en: "ok" }) } as OwnerFeatureEntry;
    ok(checkTodayGovernance([long], facts).some((p) => p.includes("241 chars")), "c-05: a 241-char text FAILS");
    const edge = { ...good, key: "fx.edge", today: () => ({ no: "x".repeat(240), en: "ok" }) } as OwnerFeatureEntry;
    ok(checkTodayGovernance([edge], facts).length === 0, "c-06: a 240-char text passes");
    const bad = (no: string, en = "ok") => ({ ...good, key: "fx.bad", today: () => ({ no, en }) }) as OwnerFeatureEntry;
    ok(checkTodayGovernance([bad("I dag sender vi")], facts).length > 0, "c-07: text starting «I dag» FAILS");
    ok(checkTodayGovernance([bad("ok", "Today we send")], facts).length > 0, "c-08: EN text starting «Today» FAILS");
    ok(checkTodayGovernance([bad("")], facts).length > 0, "c-09: empty NO text FAILS");
    ok(checkTodayGovernance([bad("ok", "  ")], facts).length > 0, "c-10: empty EN text FAILS");
    ok(checkTodayGovernance([bad("Maks undefined timer")], facts).length > 0, "c-11: text containing undefined FAILS");
    ok(checkTodayGovernance([bad("Maks " + NaN + " timer")], facts).length > 0, "c-12: text containing NaN FAILS");
    ok(checkTodayGovernance([bad("Maks {hours} timer")], facts).length > 0, "c-13: text containing { FAILS");
    const fl = { ...good, key: "fx.flip", today: (f: ForProdusenterFacts) => ({ no: f.orderCapV2On ? "Grense per kjøper." : "Grense {x}", en: "ok" }) } as OwnerFeatureEntry;
    ok(checkTodayGovernance([fl], facts).length > 0, "c-14: a violation that appears only under flipped facts FAILS");
  } catch (err: any) {
    ok(false, "unexpected error: " + String(err?.stack || err));
  } finally {
    try { db.close(); } catch { /* ignore */ }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerTodayFieldTests({ log: true }).then((r) => {
    console.info(`\nowner-today-field: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed ? 1 : 0);
  });
}

/**
 * admin-ai-clicks.test.ts — dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 5c
 * (admin «Klikk fra AI-svar»: platform sum, click rate and top list per vertical).
 *
 * Covers:
 *   (a) aiClickRatePer100: clicks per 100 deliveries, two decimals; null (shown
 *       «–») for 0 / negative / non-finite deliveries — never a division by 0.
 *   (b) aiClicksDisplay, the counting-since rule: «Fra <dato>» with no number at
 *       0 inside the first window, «siden <dato>» with clicks until a whole
 *       window has passed, then «60 d»; the whole period always «siden/Fra
 *       <dato>»; no counting start → null. Boundary at 59 days.
 *   (c) computeAdminAiClicks on a seeded DB: sums per AI (60 d / all time), top
 *       list order (count desc, then id) and limit, the rate's days = the
 *       latest of window start and both counting starts (deliveries before
 *       either start are not counted), zero deliveries → per100 null, a
 *       vertical with no clicks → countingSince/display null, a full window.
 *   (d) the default resolver: rfb name + /produsent/<slug>, dental clinic
 *       name + clinicProfileUrl, experience title + /opplevelse/<slug>,
 *       gårdssalg provider + /kategori/gardssalg/produsent/<slug>; unknown
 *       id → nulls.
 *   (e) GET /admin/analytics/ai-clicks: 401 without / with a wrong admin key,
 *       503 with no key configured; 200 shape with all three verticals;
 *       ?vertical= narrows to one; the finn-tannlege host lock wins; limit.
 *   (f) the dashboard panel: present, reads /ai-clicks, and renderAiClicks
 *       (run from the page source) escapes names and periods, links only
 *       http(s) URLs, and shows «–» for a rate of null and «Fra <dato>»
 *       without a number.
 *
 * Exported runAdminAiClicksTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/admin-ai-clicks.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-08T12:00:00Z");

export async function runAdminAiClicksTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq<T>(actual: T, expected: T, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    assertTrue(ok, ok ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* quiet */ }; }
  const prevEnv = {
    DENTAL_DB_PATH: process.env.DENTAL_DB_PATH,
    EXPERIENCES_DB_PATH: process.env.EXPERIENCES_DB_PATH,
    ADMIN_KEY: process.env.ADMIN_KEY,
    ANALYTICS_ADMIN_KEY: process.env.ANALYTICS_ADMIN_KEY,
    PROFILE_AI_DELIVERIES_COUNTING_SINCE: process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE,
    BASE_URL: process.env.BASE_URL,
    OPPLEVAGENT_BASE_URL: process.env.OPPLEVAGENT_BASE_URL,
    DENTAL_BASE_URL: process.env.DENTAL_BASE_URL,
  };
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  delete process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
  delete process.env.BASE_URL;
  delete process.env.OPPLEVAGENT_BASE_URL;
  delete process.env.DENTAL_BASE_URL;
  const cachePaths = [
    "../database/db-factory", "./dental-store", "./experience-store", "../routes/dental-seo",
    "../routes/analytics", "./admin-ai-clicks",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const m = require("./admin-ai-clicks") as typeof import("./admin-ai-clicks");
    const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const insClick = db.prepare("INSERT INTO profile_ai_clicks (vertical_id, profile_id, day, ai_vendor, count) VALUES (?, ?, ?, ?, ?)");
    const insDel = db.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)");

    // ── (a) rate math ───────────────────────────────────────────────────
    assertEq(m.aiClickRatePer100(5, 200), 2.5, "(a) 5 clicks / 200 sent → 2.5 per 100");
    assertEq(m.aiClickRatePer100(1, 3), 33.33, "(a) 1 / 3 → 33.33 (two decimals)");
    assertEq(m.aiClickRatePer100(0, 100), 0, "(a) 0 clicks over 100 sent → 0 (a real rate)");
    assertEq(m.aiClickRatePer100(3, 0), null, "(a) 0 deliveries → null, never a division by 0");
    assertEq(m.aiClickRatePer100(3, -1), null, "(a) negative deliveries → null");
    assertEq(m.aiClickRatePer100(3, NaN), null, "(a) NaN deliveries → null");
    assertEq(m.aiClickRatePer100(NaN, 10), null, "(a) NaN clicks → null");
    assertEq(m.aiClickRatePer100(250, 100), 250, "(a) more clicks than sent is shown as is (250)");

    // ── (b) counting-since display ──────────────────────────────────────
    {
      const young = utcDay(NOW - 7 * DAY); // 2026-11-01
      const d0 = m.aiClicksDisplay(0, young, 60, NOW);
      assertEq(d0, { showNumber: false, period: "Fra 1. nov. 2026" }, "(b) 0 inside the first window → «Fra <dato>», no number");
      const d5 = m.aiClicksDisplay(5, young, 60, NOW);
      assertEq(d5, { showNumber: true, period: "siden 1. nov. 2026" }, "(b) clicks inside the first window → «siden <dato>»");
      assertTrue(!/60/.test(d5!.period) && !/60/.test(d0!.period), "(b) never «60 d» for a counting younger than the window");
      assertEq(m.aiClicksDisplay(0, utcDay(NOW - 100 * DAY), 60, NOW), { showNumber: true, period: "60 d" }, "(b) full window → «60 d» (0 is honest over a full window)");
      assertEq(m.aiClicksDisplay(4, utcDay(NOW - 59 * DAY), 60, NOW)?.period, "60 d", "(b) first day 59 days back → a whole window has passed");
      assertEq(m.aiClicksDisplay(4, utcDay(NOW - 58 * DAY), 60, NOW)?.period.startsWith("siden "), true, "(b) first day 58 days back → still «siden <dato>»");
      assertEq(m.aiClicksDisplay(9, utcDay(NOW - 100 * DAY), null, NOW)?.period.startsWith("siden "), true, "(b) whole period with clicks → «siden <dato>»");
      assertEq(m.aiClicksDisplay(0, utcDay(NOW - 100 * DAY), null, NOW)?.showNumber, false, "(b) whole period at 0 → «Fra <dato>», no number");
      assertEq(m.aiClicksDisplay(3, null, 60, NOW), null, "(b) no counting start → null");
      assertEq(m.aiClicksDisplay(3, "not-a-day", 60, NOW), null, "(b) a malformed start → null");
    }

    // ── (c) compute over seeded rows ────────────────────────────────────
    {
      // rfb: clicks since 2026-11-01 (partial window).
      insClick.run("rfb", "p-a", "2026-11-01", "claude", 3);
      insClick.run("rfb", "p-a", "2026-11-05", "chatgpt", 2);
      insClick.run("rfb", "p-b", "2026-11-02", "perplexity", 7);
      insClick.run("rfb", "p-c", "2026-11-03", "gemini", 1);
      insClick.run("rfb", "p-d", "2026-11-03", "copilot", 5); // ties with p-a at 5 → id order: p-a before p-d
      // deliveries: before the deliveries' counting start (2026-10-26), before the click start, and inside.
      insDel.run("rfb", "p-a", "2026-10-20", "mcp", "claude", 1000);
      insDel.run("rfb", "p-a", "2026-10-28", "mcp", "claude", 500);
      insDel.run("rfb", "p-b", "2026-11-02", "a2a", "chatgpt", 200);
      insDel.run("rfb", "p-c", "2026-11-06", "ai_page_profile", "claude", 100);
      // dental: deliveries but no click yet.
      insDel.run("dental", "c-1", "2026-11-04", "mcp", "claude", 50);
      // experiences: an old click (full window), one inside the window, no deliveries.
      insClick.run("experiences", "e-1", utcDay(NOW - 100 * DAY), "claude", 4);
      insClick.run("experiences", "e-2", "2026-11-04", "other", 2);

      const names = new Map<string, string>([["p-b", "Bær & <Gård>"]]);
      const resolve = (_v: string, id: string) => ({ name: names.get(id) ?? null, url: names.has(id) ? "https://rettfrabonden.com/produsent/baer-gard" : null });
      const out = m.computeAdminAiClicks(db as any, ["rfb", "dental", "experiences"], NOW, 3, resolve);
      assertEq(out.windowDays, 60, "(c) windowDays 60");
      assertEq(out.verticals.map((v) => v.vertical), ["rfb", "dental", "experiences"], "(c) one entry per vertical, in order");
      const [rfb, dental, exp] = out.verticals;

      assertEq(rfb.countingSince, "2026-11-01", "(c) rfb countingSince = first stored day");
      assertEq(rfb.windowFull, false, "(c) rfb window not full yet");
      assertEq(rfb.last60d.total, 18, "(c) rfb 60 d total");
      assertEq(rfb.last60d.byVendor, { chatgpt: 2, claude: 3, perplexity: 7, gemini: 1, copilot: 5, other: 0 }, "(c) rfb 60 d per AI");
      assertEq(rfb.allTime.total, 18, "(c) rfb all-time total");
      assertEq(rfb.last60d.display, { showNumber: true, period: "siden 1. nov. 2026" }, "(c) rfb 60 d shown «siden 1. nov. 2026», not «60 d»");
      assertEq(rfb.allTime.display, { showNumber: true, period: "siden 1. nov. 2026" }, "(c) rfb whole period «siden <dato>»");
      assertEq(rfb.top.map((t) => [t.profileId, t.total]), [["p-b", 7], ["p-a", 5], ["p-d", 5]], "(c) top list: count desc, ties by id, limit 3");
      assertEq(rfb.top[0], { profileId: "p-b", total: 7, name: "Bær & <Gård>", url: "https://rettfrabonden.com/produsent/baer-gard" }, "(c) top entry carries the resolved name and link");
      assertEq(rfb.top[1].name, null, "(c) unresolved name → null");
      assertEq(rfb.rate.sinceDay, "2026-11-01", "(c) rate starts at the later counting start (clicks 1. nov.)");
      assertEq(rfb.rate.days, 8, "(c) rate days 1.–8. nov. = 8");
      assertEq(rfb.rate.deliveries, 300, "(c) deliveries before the click start (and before 26. okt.) are not in the rate");
      assertEq(rfb.rate.clicks, 18, "(c) rate clicks over the same days");
      assertEq(rfb.rate.per100, 6, "(c) 18 / 300 → 6 per 100");

      assertEq(dental.countingSince, null, "(c) dental: no click stored → countingSince null");
      assertEq(dental.last60d.display, null, "(c) dental: no 0 shown without a counting start");
      assertEq(dental.allTime.display, null, "(c) dental: whole period display null too");
      assertEq(dental.rate.per100, null, "(c) dental: rate null without click counting");
      assertEq(dental.rate.deliveries, 50, "(c) dental: deliveries still reported (60 d)");
      assertEq(dental.top, [], "(c) dental: empty top list");

      assertEq(exp.windowFull, true, "(c) experiences: a whole window has passed");
      assertEq(exp.last60d.total, 2, "(c) experiences 60 d excludes the 100-day-old click");
      assertEq(exp.allTime.total, 6, "(c) experiences all time includes it");
      assertEq(exp.last60d.display?.period, "60 d", "(c) experiences: full window → «60 d»");
      assertEq(exp.rate.deliveries, 0, "(c) experiences: 0 deliveries");
      assertEq(exp.rate.per100, null, "(c) experiences: 0 deliveries → rate null («–»)");
      assertEq(exp.rate.sinceDay, "2026-10-26", "(c) experiences: rate starts at the deliveries' counting start");

      const one = m.computeAdminAiClicks(db as any, ["rfb"], NOW, 1, resolve);
      assertEq(one.verticals[0].top.map((t) => t.profileId), ["p-b"], "(c) limit 1 → only the top profile");
    }

    // ── (d) default resolver ────────────────────────────────────────────
    {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES ('p-res', 'Åsgård Ysteri', 'd', 'p', 'a@example.no', 'https://example.no', 'producer', 'k-res')`,
      ).run();
      const r = m.defaultAiClickProfileResolver(db as any);
      assertEq(r("rfb", "p-res"), { name: "Åsgård Ysteri", url: "https://rettfrabonden.com/produsent/asgard-ysteri" }, "(d) rfb: name + /produsent/<slug>");
      assertEq(r("rfb", "missing"), { name: null, url: null }, "(d) rfb: unknown id → nulls");

      const dentalStore = require("./dental-store") as typeof import("./dental-store");
      const clinicId = dentalStore.createDentalAgent({
        navn: "Sentrum Tannklinikk AS", org_nr: "918800190", poststed: "OSLO", fylke: "Oslo",
        adresse: "Storgata 1", telefon: "22110090", hjemmeside: "https://klinikk.example.no",
      } as any);
      const dr = r("dental", clinicId);
      assertEq(dr.name, "Sentrum Tannklinikk AS", "(d) dental: clinic name");
      assertTrue(typeof dr.url === "string" && /^https:\/\/finn-tannlege\.com\/klinikk\/.+918800190/.test(dr.url), `(d) dental: clinicProfileUrl (${dr.url})`);
      assertEq(r("dental", "missing"), { name: null, url: null }, "(d) dental: unknown id → nulls");

      const expStore = require("./experience-store") as typeof import("./experience-store");
      const expDb = (require("../database/db-factory") as typeof import("../database/db-factory")).getDb("experiences");
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES ('gs-fossmoen', 'Fossmoen Frukt', 'experiences', 'Telemark', 'Skien', 'Skien', 'cideri', NULL, NULL, 59.21, 9.61,
            'high', 'fossmoen-frukt', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      assertEq(r("experiences", "gs-fossmoen"), { name: "Fossmoen Frukt", url: "https://opplevagent.no/kategori/gardssalg/produsent/fossmoen-frukt" }, "(d) gårdssalg provider: name + gårdssalg link");
      const provId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expId = expStore.createExperience({
        title: "Hvalsafari i Tromsø", provider_id: provId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });
      const slug = (expDb.prepare("SELECT slug FROM experiences WHERE id = ?").get(expId) as { slug: string }).slug;
      assertEq(r("experiences", expId), { name: "Hvalsafari i Tromsø", url: `https://opplevagent.no/opplevelse/${encodeURIComponent(slug)}` }, "(d) experience: title + /opplevelse/<slug>");
      assertEq(r("experiences", "missing"), { name: null, url: null }, "(d) experiences: unknown id → nulls");
    }

    // ── (e) the admin route ─────────────────────────────────────────────
    {
      const router = (require("../routes/analytics") as typeof import("../routes/analytics")).default as any;
      function call(url: string, headers: Record<string, string> = {}, hostname = ""): Promise<{ status: number; body: any }> {
        const query: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(url.split("?")[1] || "")) query[k] = v;
        const lower: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
        return new Promise((resolve) => {
          const req: any = { method: "GET", url, originalUrl: url, path: url.split("?")[0], query, headers: lower, hostname, get(h: string) { return lower[h.toLowerCase()]; } };
          const res: any = {
            statusCode: 200,
            status(c: number) { res.statusCode = c; return res; },
            set() { return res; }, setHeader() { return res; },
            json(b: unknown) { resolve({ status: res.statusCode, body: b }); return res; },
          };
          router.handle(req, res, () => resolve({ status: 404, body: null }));
        });
      }
      delete process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      assertEq((await call("/ai-clicks")).status, 503, "(e) no admin key configured → 503");
      process.env.ADMIN_KEY = "admin-ai-clicks-test-key";
      assertEq((await call("/ai-clicks")).status, 401, "(e) no X-Admin-Key → 401");
      const wrong = await call("/ai-clicks", { "X-Admin-Key": "nope" });
      assertEq(wrong.status, 401, "(e) wrong X-Admin-Key → 401");
      assertTrue(!wrong.body || !("verticals" in wrong.body), "(e) 401 carries no numbers");

      // Rows relative to the real clock (the route reads Date.now()).
      const now = Date.now();
      db.prepare("DELETE FROM profile_ai_clicks").run();
      insClick.run("rfb", "p-res", utcDay(now - 2 * DAY), "claude", 4);
      insClick.run("rfb", "p-x", utcDay(now - 1 * DAY), "chatgpt", 1);
      insClick.run("dental", "c-x", utcDay(now), "gemini", 2);
      const key = { "X-Admin-Key": "admin-ai-clicks-test-key" };
      const all = await call("/ai-clicks", key);
      assertEq(all.status, 200, "(e) valid key → 200");
      assertEq(all.body?.vertical, "all", "(e) no vertical → «all»");
      assertEq(all.body?.windowDays, 60, "(e) windowDays 60");
      assertEq((all.body?.verticals || []).map((v: any) => v.vertical), ["rfb", "dental", "experiences"], "(e) all three verticals");
      const rfb = all.body.verticals[0];
      assertTrue(["countingSince", "windowFull", "last60d", "allTime", "rate", "top"].every((k) => k in rfb), "(e) vertical shape");
      assertTrue(["sinceDay", "days", "clicks", "deliveries", "per100"].every((k) => k in rfb.rate), "(e) rate shape");
      assertEq(rfb.top[0], { profileId: "p-res", total: 4, name: "Åsgård Ysteri", url: "https://rettfrabonden.com/produsent/asgard-ysteri" }, "(e) top entry resolved through the agents table");
      assertEq(rfb.top[1].name, null, "(e) a profile without a row keeps a null name");
      assertTrue(typeof all.body.timestamp === "string", "(e) timestamp present");

      const dentalOnly = await call("/ai-clicks?vertical=dental", key);
      assertEq((dentalOnly.body?.verticals || []).map((v: any) => v.vertical), ["dental"], "(e) ?vertical=dental → one vertical");
      assertEq(dentalOnly.body?.verticals?.[0]?.last60d?.total, 2, "(e) dental 60 d total");
      const locked = await call("/ai-clicks?vertical=rfb", key, "finn-tannlege.com");
      assertEq((locked.body?.verticals || []).map((v: any) => v.vertical), ["dental"], "(e) the finn-tannlege host lock overrides ?vertical=rfb");
      const lim = await call("/ai-clicks?vertical=rfb&limit=1", key);
      assertEq(lim.body?.verticals?.[0]?.top?.length, 1, "(e) limit=1");
      const bogus = await call("/ai-clicks?vertical=nope", key);
      assertEq((bogus.body?.verticals || []).length, 3, "(e) an unknown vertical → all three");
    }

    // ── (f) the dashboard panel ─────────────────────────────────────────
    {
      const html = fs.readFileSync(path.join(__dirname, "../public/admin-dashboard.html"), "utf8");
      assertTrue(html.includes('id="aiClicksPanel"'), "(f) the panel container exists");
      assertTrue(html.includes('api("/ai-clicks?limit=10").then(renderAiClicks)'), "(f) the page reads /ai-clicks");
      const panelIdx = html.indexOf('id="aiClicksPanel"');
      const panelOpen = html.lastIndexOf('<div class="panel', panelIdx);
      assertTrue(!html.slice(panelOpen, panelIdx).includes("data-rfb-only"), "(f) the panel is shown for every site (not rfb-only)");

      const grab = (start: string, end: string) => {
        const i = html.indexOf(start);
        const j = html.indexOf(end, i);
        return i >= 0 && j > i ? html.slice(i, j) : "";
      };
      const helpers = grab("    function fmtNum(n)", "    // Share of a total") + "\n" + grab("    function escHtml(s)", "    function sourceLabel(s)");
      const renderSrc = grab("    var AI_CLICK_SITES", "    // ─── Recent activity");
      assertTrue(helpers.includes("function escHtml") && renderSrc.includes("function renderAiClicks"), "(f) render code found in the page");
      const el: { innerHTML: string } = { innerHTML: "" };
      const document = { getElementById: (id: string) => (id === "aiClicksPanel" ? el : null) };
      // eslint-disable-next-line no-new-func
      const renderAiClicks = new Function("document", helpers + "\n" + renderSrc + "\nreturn renderAiClicks;")(document) as (d: unknown) => void;
      renderAiClicks({
        windowDays: 60,
        verticals: [
          {
            vertical: "rfb", countingSince: "2026-11-01", windowFull: false,
            last60d: { total: 7, byVendor: { claude: 7 }, display: { showNumber: true, period: "siden 1. nov. 2026" } },
            allTime: { total: 7, byVendor: { claude: 7 }, display: { showNumber: true, period: "siden 1. nov. 2026" } },
            rate: { sinceDay: "2026-11-01", days: 8, clicks: 7, deliveries: 0, per100: null },
            top: [
              { profileId: "p-1", total: 7, name: '<img src=x onerror="alert(1)">', url: "https://rettfrabonden.com/produsent/x?a=1&b=\"2\"" },
              { profileId: "<script>p2</script>", total: 3, name: null, url: "javascript:alert(1)" },
            ],
          },
          {
            vertical: "experiences", countingSince: "2026-11-05", windowFull: false,
            last60d: { total: 0, byVendor: {}, display: { showNumber: false, period: "Fra 5. nov. 2026" } },
            allTime: { total: 0, byVendor: {}, display: { showNumber: false, period: "Fra 5. nov. 2026" } },
            rate: { sinceDay: "2026-11-05", days: 4, clicks: 0, deliveries: 40, per100: 0 },
            top: [],
          },
          {
            vertical: "dental", countingSince: null, windowFull: false,
            last60d: { total: 0, byVendor: {}, display: null }, allTime: { total: 0, byVendor: {}, display: null },
            rate: { sinceDay: null, days: 0, clicks: 0, deliveries: 9, per100: null }, top: [],
          },
        ],
      });
      const out = el.innerHTML;
      assertTrue(!out.includes("<img") && out.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), "(f) a profile name is escaped");
      assertTrue(!out.includes("<script>") && out.includes("&lt;script&gt;p2&lt;/script&gt;"), "(f) a profile id shown as fallback is escaped");
      assertTrue(!out.includes("javascript:"), "(f) a non-http(s) URL is never linked");
      assertTrue(out.includes('href="https://rettfrabonden.com/produsent/x?a=1&amp;b=&quot;2&quot;"'), "(f) an http(s) link is escaped in the attribute");
      assertTrue(out.includes("siden 1. nov. 2026") && out.includes("Fra 5. nov. 2026"), "(f) the counting-since words are shown");
      const expRow = out.split("<tr>").find((r) => r.includes("Opplevagent")) || "";
      assertTrue(!/<strong>0<\/strong>/.test(expRow) && expRow.includes("Fra 5. nov. 2026"), "(f) at 0 in the first window: «Fra <dato>», no 0");
      const rfbRow = out.split("<tr>").find((r) => r.includes("Rett fra Bonden")) || "";
      assertTrue(/<\/td><td title="[^"]*">–<\/td><\/tr>/.test(rfbRow), "(f) a null rate shows «–»");
      assertTrue(expRow.includes(">0,0</td>"), "(f) a real rate of 0 is shown as 0,0");
      assertTrue(out.includes("Finn-tannlege: ingen klikk fra AI-svar registrert enda"), "(f) a site with no counting says so instead of 0");
      assertTrue(!/>60 d</.test(rfbRow), "(f) the rfb row never says «60 d» inside the first window");
      renderAiClicks({ windowDays: 60, verticals: [] });
      assertTrue(el.innerHTML.includes("Ingen tall enda"), "(f) empty answer → empty state");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
    restoreModuleCache();
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAiClicksTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

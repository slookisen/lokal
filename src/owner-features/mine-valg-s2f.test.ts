/**
 * mine-valg-s2f.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2f («statistikk på «Mine valg» og rettinger»).
 *
 * Covers:
 *   AC31  the statistics block at the top of «Mine valg» shows the same
 *         numbers as the /selger Statistikk tab (selger.html renderOwnerStats
 *         run on the same getOwnerStats payload) for the same profile and
 *         period; low numbers get one sentence and ONE tip from what the
 *         profile is missing; «Se all statistikk» links to the tab; the
 *         portal card «Statistikk» shows numbers, not «—», when data exists;
 *         no «Med i AI-svar» in the registry or the page.
 *   AC32  PUBLIC_STATS_MIN_VIEWS (default 20, parsed defensively): 19 people's
 *         page views over 12 months → no public tiles on /produsent/<slug>
 *         and no counts in GET /api/agents/:id/stats; 20 → tiles and counts;
 *         the owner sees the own numbers in both cases; stats.public_counts
 *         off still hides; the threshold number is the owner's own «Sett»;
 *         dental / Opplevagent / platform numbers do not use the threshold.
 *
 * Exported runMineValgS2fTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/owner-features/mine-valg-s2f.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

const SAVED_ENV = [
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_FEATURES_ENFORCE", "PUBLIC_STATS_MIN_VIEWS",
  "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "ANALYTICS_ROLLUP_READ",
  "PROFILE_AI_DELIVERIES_COUNTING_SINCE",
];
const P_ID = "s2f-profil";
const P_NAME = "Statistikkprove Gard Nitten";
const E_ID = "s2f-tom";
const E_NAME = "Statistikkprove Gard Tom";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CLAUDE_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const D = 86_400_000;

function sqlTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** selger.html's renderOwnerStats(data) against a stub DOM; each element's innerHTML by id. */
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
  const kindLabels: Record<string, string> = { email: "E-post", phone: "Telefon", website: "Nettside" };
  const fn = new Function("document", "escHtml", "ownLabel", "SOURCE_LABELS", "CHANNEL_LABELS", "clickKindLabel",
    src.slice(start, end) + "\nreturn renderOwnerStats;");
  const render = fn(document, escHtml, (m: Record<string, string>, k: string) => m[k], {}, {}, (k: string) => kindLabels[k] || k);
  render(JSON.parse(JSON.stringify(data)));
  const out: Record<string, string> = {};
  for (const [id, el] of Object.entries(els)) out[id] = el.innerHTML;
  return out;
}

const num = (html: string, re: RegExp): number | null => {
  const m = re.exec(html);
  return m ? Number(m[1]) : null;
};
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runMineValgS2fTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }

  function findRouteHandler(router: any, p: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === p && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${p}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; query?: Record<string, string>; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: {}, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        statusCode: 200,
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  const enforce = require("./enforce") as typeof import("./enforce");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const clearRegistryCaches = () => {
      marketplaceRegistry._agentsCache = null;
      marketplaceRegistry._statsCache = null;
      marketplaceRegistry._agentsCacheTime = 0;
      marketplaceRegistry._statsCacheTime = 0;
    };
    clearRegistryCaches();
    for (const m of ["../routes/seo", "../routes/agent-stats", "../routes/owner-portal", "../routes/owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
    const statsMod = require("../routes/agent-stats") as typeof import("../routes/agent-stats");
    const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
    const featuresMod = require("../routes/owner-features") as typeof import("../routes/owner-features");
    const th = require("../services/public-stats-threshold") as typeof import("../services/public-stats-threshold");
    const oss = require("../services/owner-stats-service") as typeof import("../services/owner-stats-service");
    const pg = require("./page") as typeof import("./page");
    const reg = require("./registry") as typeof import("./registry");
    const rs = require("./resolve") as typeof import("./resolve");
    const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
    const { hashIP } = require("../services/analytics-service") as typeof import("../services/analytics-service");
    statsMod.__resetAgentStatsCacheForTesting();
    th.__resetPublicStatsThresholdCacheForTesting();

    const seed = (id: string, name: string, k: { opening_hours: string | null }) => {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
         VALUES (?, ?, 'Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z')`,
      ).run(id, name, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, email, website, phone, about, products, opening_hours, verification_status, verified_second_line,
            enrichment_status, url_last_status, url_last_probed, last_verified_at)
         VALUES (?, ?, ?, '+47 912 34 567', 'Vi er en liten familiegård som dyrker poteter og selger direkte fra gården.', ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
      ).run(id, `post@${id}.example.no`, `https://${id}.example.no`, JSON.stringify([{ name: "Listepoteter", category: "vegetables" }]), k.opening_hours);
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + D).toISOString());
    };
    seed(P_ID, P_NAME, { opening_hours: "[]" });   // no opening hours → the tip
    seed(E_ID, E_NAME, { opening_hours: JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }]) });
    setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", `rfb:${P_ID},rfb:${E_ID}`);

    const now = Date.now();
    // The raw floor of analytics_agent_views (rollupBoundaryDateOn): 30 days back, so the raw part covers the views below.
    db.prepare("INSERT INTO analytics_agent_views (agent_id, agent_name, created_at, traffic_category, is_owner) VALUES (?, ?, ?, 'human', 0)")
      .run(P_ID, P_NAME, sqlTs(now - 30 * D));
    const pPath = `/produsent/${slugify(P_NAME)}`;
    const pv = db.prepare(
      `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, is_owner, status_code, vertical_id, created_at)
       VALUES (?, 'direct', 'h', ?, 0, 200, 'rfb', ?)`,
    );
    let ip = 0;
    const addHumanViews = (n: number) => { for (let i = 0; i < n; i++) { ip++; pv.run(pPath, `${hashIP(`61.0.${Math.floor(ip / 250)}.${ip % 250}`)}:${CHROME_UA}`, sqlTs(now - (2 + (ip % 5)) * D)); } };
    addHumanViews(19);
    pv.run(pPath, `${hashIP("62.0.0.1")}:${CLAUDE_USER}`, sqlTs(now - 3 * D));
    pv.run(pPath, `${hashIP("62.0.0.2")}:${CLAUDE_USER}`, sqlTs(now - 4 * D));
    pv.run(pPath, `${hashIP("62.0.0.3")}:${CHATGPT_USER}`, sqlTs(now - 5 * D));
    pv.run(pPath, `${hashIP("62.0.0.4")}:${CHROME_UA}`, sqlTs(now - 1 * D)); // a person …
    db.prepare("UPDATE analytics_page_views SET is_owner = 1 WHERE session_id = ?").run(`${hashIP("62.0.0.4")}:${CHROME_UA}`); // … who is the owner: left out
    const click = db.prepare("INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, created_at) VALUES (?, ?, ?, 0, datetime('now', '-2 days'))");
    click.run(P_ID, "phone", "c1"); click.run(P_ID, "phone", "c2"); click.run(P_ID, "website", "c3"); click.run(P_ID, "email", "c4");
    process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = new Date(now - 20 * D).toISOString().slice(0, 10);
    db.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES ('rfb', ?, ?, 'mcp', 'claude', 5)")
      .run(P_ID, new Date(now - 2 * D).toISOString().slice(0, 10));

    const H = {
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      stats: findRouteHandler(statsMod.default, "/api/agents/:id/stats", "get"),
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
    };
    const profileHtml = async (name: string) => { clearRegistryCaches(); return String((await invoke(H.produsent, makeReq({ params: { slug: slugify(name) } }))).body ?? ""); };
    const statsJson = async (id: string) => { statsMod.__resetAgentStatsCacheForTesting(); return (await invoke(H.stats, makeReq({ params: { id } }))).body ?? {}; };
    const valgHtml = async (id: string) => String((await invoke(H.valg, makeReq({ params: { agentId: id }, token: `tok-${id}` }))).body ?? "");
    const portalHtml = async (id: string) => String((await invoke(H.portal, makeReq({ params: { agentId: id }, token: `tok-${id}` }))).body ?? "");
    const tiles = (h: string) => ["human", "ai", "aiDeliveries"].map((k) => h.includes(`class="pf-stat" data-stat="${k}"`));
    const block = (h: string) => { const i = h.indexOf(`id="statistikk"`); return i < 0 ? "" : h.slice(i, h.indexOf("</section>", i)); };
    const blockNum = (b: string, label: string) => num(b, new RegExp(`<strong>([\\d\\s\\u00a0]+)</strong><span>${reEsc(label)}</span>`));

    // ═══ AC31 — same numbers as the /selger Statistikk tab ═══════════════════
    {
      const o = oss.getOwnerStats(db as any, P_ID, pPath);
      const tab = renderOwnerStatsHtml(o);
      const tabSeen = num(tab.statsFunnel || "", /<div class="stat-number">(\d+)<\/div><div class="stat-label">Sett \(/);
      const tabAi = num(tab.statsAiPlatforms || "", /<div class="stat-number">(\d+)<\/div><div class="stat-label">Alle AI-assistenter \(/);
      const tabGpt = num(tab.statsAiPlatforms || "", /<div class="stat-number">(\d+)<\/div><div class="stat-label">ChatGPT \(/);
      const tabClaude = num(tab.statsAiPlatforms || "", /<div class="stat-number">(\d+)<\/div><div class="stat-label">Claude \(/);
      const tabOther = num(tab.statsAiPlatforms || "", /<div class="stat-number">(\d+)<\/div><div class="stat-label">Andre AI \(/);
      const tabPhone = num(tab.statsContactClicks || "", /Telefon<\/span><span class="product-meta">(\d+)</);
      const tabWeb = num(tab.statsContactClicks || "", /Nettside<\/span><span class="product-meta">(\d+)</);
      assertEq([tabSeen, tabAi, tabGpt, tabClaude, tabOther, tabPhone, tabWeb], [19, 3, 1, 2, 0, 2, 1], "AC31 fixture: the tab shows 19 views, 3 AI search (1 ChatGPT, 2 Claude), 2 phone and 1 website click");

      const st = featuresMod.ownerPageStats(P_ID, P_NAME, db);
      assertTrue(!!st, "AC31: the route's stats read succeeds");
      if (st) {
        assertEq(
          [st.humanViews.value, st.aiViews.value, st.aiSplit.chatgpt, st.aiSplit.claude, st.aiSplit.other, st.aiDeliveries.value, st.clicks.phone, st.clicks.website],
          [tabSeen, tabAi, tabGpt, tabClaude, tabOther, o.aiDeliveries.window.total, tabPhone, tabWeb],
          "AC31: the block's numbers = the Statistikk tab's for the same profile and period",
        );
        assertEq([st.humanViews.label, st.aiViews.label, st.aiDeliveries.label], [o.year.labels.nb.humanViews, o.year.labels.nb.aiViews, o.year.labels.nb.aiDeliveries],
          "AC31: same periods and labels as the tab (12 months / «siden <dato>»)");
        assertTrue((tab.statsAiDeliveries || "").includes(`<div class="stat-number">${st.aiDeliveries.value}</div>`) && st.aiDeliveries.value === 5,
          "AC31: «Med i AI-søk» = the tab's 12-month number (5)");
        assertEq([st.aiSplit.days, st.clicks.days], [o.windowDays, o.windowDays], "AC31: the AI split and the clicks carry the tab's own window (no stored sums)");
      }

      const h = await valgHtml(P_ID);
      const b = block(h);
      assertTrue(b.length > 0, "AC31: «Mine valg» has the statistics block");
      assertTrue(h.indexOf(`id="statistikk"`) > 0 && h.indexOf(`id="statistikk"`) < h.indexOf(`id="niva"`), "AC31: the block is at the top, before the levels (proof first)");
      assertEq(
        [blockNum(b, "Sidevisninger fra mennesker"), blockNum(b, "AI-søk"), blockNum(b, "Med i AI-søk"), blockNum(b, "Klikk til telefon"), blockNum(b, "Klikk til nettside")],
        [tabSeen, tabAi, 5, tabPhone, tabWeb],
        "AC31: the rendered tiles show the tab's numbers",
      );
      assertTrue(b.includes(`ChatGPT ${tabGpt} · Claude ${tabClaude} · Andre ${tabOther} (siste ${o.windowDays} dager)`), "AC31: the AI split as in the tab, with its window");
      assertTrue(b.includes("Klikk til kart telles ikke ennå."), "AC31: map clicks are not counted anywhere: said, no fake number");
      assertTrue(b.includes(`href="/selger?agent=${P_ID}#statistikk"`) && b.includes("Se all statistikk"), "AC31: «Se all statistikk» links to the Statistikk tab");
      const selgerSrc = fs.readFileSync(path.join(__dirname, "../public/selger.html"), "utf8");
      assertTrue(/window\.location\.hash === '#statistikk'[\s\S]{0,200}data-tab="stats"/.test(selgerSrc), "AC31: /selger opens the Statistikk tab on #statistikk");
      assertEq((b.match(/Tips:/g) || []).length, 1, "AC31: low numbers (19 < 20) → exactly one tip");
      assertTrue(b.includes("Tips: Legg til åpningstider"), "AC31: the tip comes from what the profile is missing (opening hours)");
      assertTrue(b.includes("Tallene er lave ennå") && b.includes("før den har 20 sidevisninger"), "AC31: one sentence of explanation, naming the public threshold");
      assertTrue(!h.includes("Med i AI-svar"), "AC31: no «Med i AI-svar» on the page");

      // The tip follows the gaps, one at a time.
      assertEq(pg.ownerProfileTip({ opening_hours: "[]", products: "[]" }).startsWith("Legg til åpningstider"), true, "tip-1: opening hours first");
      assertEq(pg.ownerProfileTip({ opening_hours: "Lør 10–14", products: "[]", about: "x" }).startsWith("Legg inn varene"), true, "tip-2: free-text opening hours count; no products → products tip");
      assertEq(pg.ownerProfileTip({ opening_hours: "{\"sat\":1}", products: "[1]", about: " " }).startsWith("Skriv noen setninger"), true, "tip-3: no description");
      assertEq(pg.ownerProfileTip({ opening_hours: "x", products: "[1]", about: "x", phone: "1", website: "u" }).startsWith("Del lenken"), true, "tip-4: nothing missing → share the link");

      // A profile with no data: zeros, the tip, still the link.
      const e = block(await valgHtml(E_ID));
      assertTrue(blockNum(e, "Sidevisninger fra mennesker") === 0 && (e.match(/Tips:/g) || []).length === 1 && !e.includes("Legg til åpningstider"),
        "AC31: an empty profile with opening hours: 0, one tip, not the opening-hours one");
    }

    // ═══ AC31 — the portal card «Statistikk» ═════════════════════════════════
    {
      const h = await portalHtml(P_ID);
      const i = h.indexOf("<h2>Statistikk</h2>");
      const card = i < 0 ? "" : h.slice(i, h.indexOf("</div>\n      </div>", i));
      assertTrue(card.length > 0, "AC31 card: the portal has the «Statistikk» card");
      const views = num(card, /<div class="ep-stat-num">(\d+)<\/div><div class="ep-stat-label">Sidevisninger fra mennesker \(/);
      const ai = num(card, /<div class="ep-stat-num">(\d+)<\/div><div class="ep-stat-label">AI-søk \(/);
      assertEq([views, ai], [19, 3], "AC31 card: page views and AI search show the tab's numbers, not «—»");
      const portalSrc = fs.readFileSync(path.join(__dirname, "../routes/owner-portal.ts"), "utf8");
      assertTrue(!/knowledge\.views_count|knowledge\.ai_conversations_count/.test(portalSrc), "AC31 card: the card no longer reads the fields that do not exist");
    }

    // ═══ AC31 — «Med i AI-søk» in the registry ═══════════════════════════════
    {
      const regSrc = fs.readFileSync(path.join(__dirname, "registry.ts"), "utf8");
      const pageSrc = fs.readFileSync(path.join(__dirname, "page.ts"), "utf8");
      assertTrue(!regSrc.includes("Med i AI-svar") && !pageSrc.includes("Med i AI-svar") && !regSrc.includes("In AI answers"), "AC31: no «Med i AI-svar» / “In AI answers” in the registry or the page");
      const e = reg.getOwnerFeature("stats.public_counts");
      assertTrue(e.label.no.includes("«Med i AI-søk»") && e.label.en.includes("In AI search"), "AC31: the registry says «Med i AI-søk» (NO) and “In AI search” (EN)");
      assertTrue(e.description.no.includes("fra 20 sidevisninger") && e.description.en.includes("from 20 page views"), "AC32: the stats.public_counts text says the numbers are shown from 20 views");
    }

    // ═══ AC32 — the public threshold ══════════════════════════════════════════
    {
      const parse = (v: string | undefined) => th.publicStatsMinViews(v === undefined ? {} : { PUBLIC_STATS_MIN_VIEWS: v });
      assertEq([parse(undefined), parse(""), parse("abc"), parse("-5"), parse("1.5"), parse("1e3"), parse(" 7 "), parse("0"), parse("9999999999")],
        [20, 20, 20, 20, 20, 20, 7, 0, 20], "AC32: PUBLIC_STATS_MIN_VIEWS parsed defensively (invalid → 20, 0 = off)");
      assertEq(oss.getOwnerHumanViewsYear(db as any, P_ID, pPath), oss.getOwnerStats(db as any, P_ID, pPath).year.humanViews.value,
        "AC32: one source — the threshold number is the owner's own 12-month «Sett»");

      // 19 views
      th.__resetPublicStatsThresholdCacheForTesting();
      const h19 = await profileHtml(P_NAME);
      assertTrue(h19.includes(P_NAME), "AC32 19: the profile page renders");
      assertEq(tiles(h19), [false, false, false], "AC32 19: no public statistics tiles in the HTML");
      assertTrue(!h19.includes("Profilvisninger") && !h19.includes('class="act-grid"'), "AC32 19: no «Aktivitet» counts either (no zeros)");
      const s19 = await statsJson(P_ID);
      assertTrue(s19.publicCounts === false && statsMod.PUBLIC_STATS_COUNT_FIELDS.every((f) => !(f in s19)), "AC32 19: GET /api/agents/:id/stats leaves the counts out (publicCounts:false)");
      assertTrue(Array.isArray(s19.lastConversations) && typeof s19.conversationCount === "number", "AC32 19: the rest of the stats payload stays");
      assertTrue(!/"(humanViews|aiViews|aiDeliveries)"/.test(h19.replace(/<script>[\s\S]*?<\/script>/g, (m) => (m.includes("ld+json") ? m : ""))), "AC32 19: no count in the JSON-LD");
      const own19 = block(await valgHtml(P_ID));
      assertEq(blockNum(own19, "Sidevisninger fra mennesker"), 19, "AC32 19: the owner sees the own numbers");

      // 20 views
      addHumanViews(1);
      th.__resetPublicStatsThresholdCacheForTesting();
      const h20 = await profileHtml(P_NAME);
      assertEq(tiles(h20), [true, true, true], "AC32 20: the public statistics tiles are shown");
      const s20 = await statsJson(P_ID);
      assertTrue(s20.publicCounts === undefined && s20.year && typeof s20.year.humanViews?.value === "number" && "humanViews" in s20, "AC32 20: GET /api/agents/:id/stats carries the counts as before");
      const own20 = block(await valgHtml(P_ID));
      assertTrue(blockNum(own20, "Sidevisninger fra mennesker") === 20 && !own20.includes("Tips:"), "AC32 20: the owner sees 20, no low-number tip");

      // The environment value is used.
      setEnv("PUBLIC_STATS_MIN_VIEWS", "21");
      assertEq(tiles(await profileHtml(P_NAME)), [false, false, false], "AC32 env: PUBLIC_STATS_MIN_VIEWS=21 → 20 views hide the tiles");
      setEnv("PUBLIC_STATS_MIN_VIEWS", "not-a-number");
      assertEq(tiles(await profileHtml(P_NAME)), [true, true, true], "AC32 env: an invalid value falls back to 20");
      setEnv("PUBLIC_STATS_MIN_VIEWS", null);

      // The forced value lives only in its async context.
      const inside = await th.runWithPublicStatsMinViews(500, async () => { await new Promise((r) => setTimeout(r, 1)); return th.publicStatsMinViews(); });
      assertEq([inside, th.publicStatsMinViews()], [500, 20], "AC32 probe seam: runWithPublicStatsMinViews is scoped to its context");

      // stats.public_counts off still hides, above the threshold.
      const LIVE = reg.OWNER_FEATURE_REGISTRY.map((x) => (x.key === "stats.public_counts" ? { ...x, status: "live" as const } : x));
      enforce.__setEnforceRegistryForTesting(LIVE);
      setEnv("OWNER_FEATURES_ENFORCE", "1");
      const set = rs.setOwnerFeatureValue("rfb", P_ID, "stats.public_counts", false, { actor: "owner" }, { db, registry: LIVE });
      assertEq(set.kind, "ok", "AC32 off: the owner turns stats.public_counts off");
      assertEq(tiles(await profileHtml(P_NAME)), [false, false, false], "AC32 off: 20 views but stats.public_counts off → no tiles");
      const sOff = await statsJson(P_ID);
      assertTrue(sOff.publicCounts === false && !("year" in sOff), "AC32 off: … and no counts in /api/agents/:id/stats");
      assertEq(blockNum(block(await valgHtml(P_ID)), "Sidevisninger fra mennesker"), 20, "AC32 off: the owner still sees the own numbers");
      db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(P_ID);
      enforce.__setEnforceRegistryForTesting(null);
      setEnv("OWNER_FEATURES_ENFORCE", null);
      assertEq(tiles(await profileHtml(P_NAME)), [true, true, true], "AC32 off: back on → tiles again");

      // A failed count hides (fail closed).
      const real = db.prepare.bind(db);
      th.__resetPublicStatsThresholdCacheForTesting();
      (db as any).prepare = (sql: string) => { if (/FROM analytics_page_views/.test(sql) && /yearViews/.test(sql)) throw new Error("injected"); return real(sql); };
      const prevErr = console.error;
      console.error = () => undefined;
      try {
        assertEq(th.publicCountsShown(db as any, P_ID, pPath, null), false, "AC32: a failed count hides the tiles (fail closed)");
      } finally {
        console.error = prevErr;
        (db as any).prepare = real;
      }
      th.__resetPublicStatsThresholdCacheForTesting();
    }

    // ═══ AC32 — dental / Opplevagent / platform numbers unchanged ═════════════
    {
      const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
      const untouched = ["routes/dental-seo.ts", "routes/experiences-seo.ts", "routes/gardssalg-claim.ts", "services/oa-home-counters.ts",
        "services/traffic-stats.ts", "services/traffic-stats-compute.ts", "routes/agentplatform-site.ts", "services/gardssalg-owner-stats-service.ts"];
      assertEq(untouched.filter((p) => /public-stats-threshold|publicCountsShown|PUBLIC_STATS_MIN_VIEWS/.test(src(p))), [],
        "AC32: dental, Opplevagent / gårdssalg and the platform-wide numbers do not use the threshold");
      const seoSrc = src("routes/seo.ts");
      assertEq((seoSrc.match(/publicCountsShown\(/g) || []).length, 1, "AC32: seo.ts applies the threshold once, on the RFB producer profile");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    enforce.__setEnforceRegistryForTesting(null);
    for (const k of SAVED_ENV) setEnv(k, prevEnv[k] ?? null);
    try { (require("../services/public-stats-threshold") as typeof import("../services/public-stats-threshold")).__resetPublicStatsThresholdCacheForTesting(); } catch { /* not loaded */ }
    try { (require("../routes/agent-stats") as typeof import("../routes/agent-stats")).__resetAgentStatsCacheForTesting(); } catch { /* not loaded */ }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runMineValgS2fTests({ log: true }).then((r) => {
    console.info(`\nmine-valg-s2f: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

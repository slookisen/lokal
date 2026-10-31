/**
 * profile-ai-clicks.test.ts — dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 2
 * («Klikk fra AI-svar»: storage per profile x AI; no display yet).
 *
 * Covers:
 *   (a) profile_ai_clicks columns + unique key; flush writes daily sums and a
 *       second flush adds to the same row (upsert); nothing else is stored.
 *   (b) recordAiProfileClick on a fake request: utm_source=claude (no
 *       referrer) → claude; the same URL from ChatGPT-User → nothing; referrer
 *       claude.ai → claude; sylteogrokt.no / thankyou.com → nothing; Googlebot
 *       / GPTBot / curl → nothing; 404 / 500 → nothing; 304 → counted; a
 *       duplicate utm_source array → counted once; the owner cookie → nothing.
 *   (c) dedup: same visitor + profile within 30 min → 1, after 31 min → 2, a
 *       different profile counts on its own.
 *   (d) read helpers: 60-day window vs all time, byVendor, countingSince,
 *       platform totals and top-profile ordering.
 *   (e) the four profile-page call sites (rfb producer, dental clinic,
 *       experiences provider, experience) count a person from an AI answer
 *       and nothing for an ordinary visit.
 *
 * Exported runProfileAiClicksTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/profile-ai-clicks.test.ts
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const CURL = "curl/8.5.0";
const DAY = 24 * 60 * 60 * 1000;

function parseQuery(url: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(url.split("?")[1] || "")) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export async function runProfileAiClicksTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq<T>(actual: T, expected: T, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const cachePaths = [
    "../database/db-factory", "../services/dental-store", "../services/experience-store",
    "../routes/seo", "../routes/dental-seo", "../routes/experiences-seo",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const svc = require("./profile-ai-clicks") as typeof import("./profile-ai-clicks");
    const compute = require("./profile-ai-clicks-compute") as typeof import("./profile-ai-clicks-compute");
    svc.__resetAiClicksForTesting();

    const flush = () => svc.flushAiClicks(db as any);
    const rows = (vertical?: string) => db.prepare(
      `SELECT vertical_id, profile_id, ai_vendor, SUM(count) AS n FROM profile_ai_clicks ${vertical ? "WHERE vertical_id = ?" : ""}
       GROUP BY vertical_id, profile_id, ai_vendor ORDER BY vertical_id, profile_id, ai_vendor`,
    ).all(...(vertical ? [vertical] : [])) as Array<{ vertical_id: string; profile_id: string; ai_vendor: string; n: number }>;
    const total = (vertical?: string) => rows(vertical).reduce((s, r) => s + r.n, 0);
    const clear = () => { db.prepare("DELETE FROM profile_ai_clicks").run(); svc.__resetAiClicksForTesting(); };

    // Fake request/response for recordAiProfileClick.
    let ipSeq = 0;
    function visit(
      url: string, ua: string,
      extra: { referer?: string; status?: number; ip?: string; cookie?: string; profileId?: string; vertical?: "rfb" | "dental" | "experiences"; query?: Record<string, unknown> } = {},
    ): void {
      const headers: Record<string, string> = { "user-agent": ua };
      if (extra.referer) headers.referer = extra.referer;
      if (extra.cookie) headers.cookie = extra.cookie;
      const req: any = {
        method: "GET", url, originalUrl: url, path: url.split("?")[0], headers,
        query: extra.query ?? parseQuery(url), ip: extra.ip ?? `198.51.100.${++ipSeq}`,
        get(h: string) { return headers[h.toLowerCase()]; },
      };
      const res: any = Object.assign(new EventEmitter(), { statusCode: extra.status ?? 200, locals: {} });
      svc.recordAiProfileClick(req, res, extra.profileId ?? "p-1", extra.vertical ?? "rfb");
      res.emit("finish");
    }
    const UTM_CLAUDE = "/produsent/aker-gaard-en?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search";

    // ── (a) schema + upsert ────────────────────────────────────────────
    {
      const cols = (db.prepare("PRAGMA table_info(profile_ai_clicks)").all() as Array<{ name: string }>).map((c) => c.name);
      assertEq(cols.join(","), "vertical_id,profile_id,day,ai_vendor,count", "(a) profile_ai_clicks columns: daily sums only (no IP, session, UA or URL)");
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'profile_ai_clicks' AND name = 'idx_profile_ai_clicks_vertical_day'").get();
      assertTrue(!!idx, "(a) index on (vertical_id, day)");
      const t0 = Date.UTC(2026, 9, 31, 10, 0, 0);
      svc.recordAiClick({ vertical: "rfb", profileId: "x-1", vendor: "claude", ip: "1", userAgent: HUMAN, nowMs: t0 });
      svc.recordAiClick({ vertical: "rfb", profileId: "x-1", vendor: "claude", ip: "2", userAgent: HUMAN, nowMs: t0 });
      assertEq(flush(), 1, "(a) first flush: one daily row");
      svc.recordAiClick({ vertical: "rfb", profileId: "x-1", vendor: "claude", ip: "3", userAgent: HUMAN, nowMs: t0 });
      flush();
      const r = db.prepare("SELECT COUNT(*) AS rows, SUM(count) AS n, MIN(day) AS day FROM profile_ai_clicks WHERE profile_id = 'x-1'").get() as { rows: number; n: number; day: string };
      assertEq(r.rows, 1, "(a) the second flush upserts into the same day row");
      assertEq(r.n, 3, "(a) and adds to its count");
      assertEq(r.day, "2026-10-31", "(a) day is the UTC day");
      assertEq(flush(), 0, "(a) nothing pending → no write");
      let dup = false;
      try {
        db.prepare("INSERT INTO profile_ai_clicks (vertical_id, profile_id, day, ai_vendor, count) VALUES ('rfb', 'x-1', '2026-10-31', 'claude', 1)").run();
      } catch { dup = true; }
      assertTrue(dup, "(a) the unique key covers vertical, profile, day and AI");
      clear();
    }

    // ── (b) who counts ─────────────────────────────────────────────────
    {
      visit(UTM_CLAUDE, HUMAN);
      flush();
      assertEq(JSON.stringify(rows()), JSON.stringify([{ vertical_id: "rfb", profile_id: "p-1", ai_vendor: "claude", n: 1 }]), "(b) a person with utm_source=claude, no referrer → claude");

      visit(UTM_CLAUDE, CHATGPT_USER);
      flush();
      assertEq(total(), 1, "(b) the same URL fetched by ChatGPT-User (an AI fetcher) counts nothing");

      visit("/produsent/aker-gaard-en", HUMAN, { referer: "https://claude.ai/chat/x" });
      flush();
      assertEq(rows().find((x) => x.ai_vendor === "claude")?.n, 2, "(b) referrer https://claude.ai/chat/x → claude");

      for (const ref of ["https://sylteogrokt.no/", "https://thankyou.com/", "https://www.google.com/"]) {
        visit("/produsent/aker-gaard-en", HUMAN, { referer: ref });
        flush();
        assertEq(total(), 2, `(b) referrer ${ref} counts nothing`);
      }
      visit("/produsent/aker-gaard-en", HUMAN);
      flush();
      assertEq(total(), 2, "(b) a direct visit without referrer or utm counts nothing");

      for (const [label, ua] of [["Googlebot", GOOGLEBOT], ["GPTBot (AI crawler)", GPTBOT], ["curl", CURL], ["an empty UA", ""]] as Array<[string, string]>) {
        visit(UTM_CLAUDE, ua);
        visit("/produsent/aker-gaard-en", ua, { referer: "https://claude.ai/chat/x" });
        flush();
        assertEq(total(), 2, `(b) ${label} counts nothing`);
      }
      visit(UTM_CLAUDE, HUMAN, { cookie: "_rfb_owner=1" });
      flush();
      assertEq(total(), 2, "(b) our own traffic (owner cookie) counts nothing");

      for (const status of [404, 500, 301]) {
        visit(UTM_CLAUDE, HUMAN, { status });
        flush();
        assertEq(total(), 2, `(b) a ${status} answer counts nothing`);
      }
      visit(UTM_CLAUDE, HUMAN, { status: 304 });
      flush();
      assertEq(total(), 3, "(b) a 304 answer counts");

      clear();
      visit("/produsent/aker-gaard-en?utm_source=chatgpt.com&utm_source=claude", HUMAN);
      flush();
      assertEq(JSON.stringify(rows()), JSON.stringify([{ vertical_id: "rfb", profile_id: "p-1", ai_vendor: "chatgpt", n: 1 }]), "(b) utm_source array [chatgpt.com, claude] → counted once as AI");

      visit("/produsent/aker-gaard-en?utm_source=perplexity.ai", HUMAN, { profileId: "p-2" });
      visit("/produsent/aker-gaard-en?utm_campaign=ai_search", HUMAN, { profileId: "p-3" });
      flush();
      assertTrue(rows().some((x) => x.profile_id === "p-2" && x.ai_vendor === "perplexity"), "(b) utm_source=perplexity.ai → perplexity");
      assertTrue(rows().some((x) => x.profile_id === "p-3" && x.ai_vendor === "other"), "(b) utm_campaign=ai_search alone → other");

      let threw = false;
      const prevErr = console.error;
      console.error = () => { /* the expected "click failed" log */ };
      try {
        svc.recordAiProfileClick({ headers: null, get() { throw new Error("boom"); } } as any, {} as any, "p-1");
        svc.recordAiProfileClick({ headers: { "user-agent": HUMAN }, query: {}, get() { throw new Error("boom"); } } as any, {} as any, "p-1");
      } catch { threw = true; } finally { console.error = prevErr; }
      assertTrue(!threw, "(b) a broken request never throws into the page");
      clear();
    }

    // ── (c) dedup ──────────────────────────────────────────────────────
    {
      const t0 = Date.UTC(2026, 9, 31, 8, 0, 0);
      const input = { vertical: "rfb" as const, profileId: "d-1", vendor: "claude" as const, ip: "203.0.113.5", userAgent: HUMAN };
      assertEq(svc.recordAiClick({ ...input, nowMs: t0 }), 1, "(c) first visit counts");
      assertEq(svc.recordAiClick({ ...input, nowMs: t0 + 29 * 60_000 }), 0, "(c) same visitor + profile within 30 min: not again");
      flush();
      assertEq(total(), 1, "(c) twice within 30 min → 1");
      assertEq(svc.recordAiClick({ ...input, nowMs: t0 + 31 * 60_000 }), 1, "(c) after 31 min: counted again");
      flush();
      assertEq(total(), 2, "(c) after 31 min → 2");
      assertEq(svc.recordAiClick({ ...input, profileId: "d-2", nowMs: t0 + 31 * 60_000 }), 1, "(c) a different profile counts on its own");
      assertEq(svc.recordAiClick({ ...input, vertical: "dental", nowMs: t0 + 31 * 60_000 }), 1, "(c) the same id in another vertical counts on its own");
      flush();
      assertEq(rows().filter((x) => x.profile_id === "d-2").length, 1, "(c) separate row for the other profile");

      // Through recordAiProfileClick: same ip + UA twice → once.
      clear();
      visit(UTM_CLAUDE, HUMAN, { ip: "203.0.113.9" });
      visit("/produsent/aker-gaard-en", HUMAN, { ip: "203.0.113.9", referer: "https://chatgpt.com/" });
      flush();
      assertEq(total(), 1, "(c) the same visitor from two AIs within 30 min counts once");
      clear();
    }

    // ── (d) read helpers ───────────────────────────────────────────────
    {
      const now = Date.UTC(2026, 9, 31, 12, 0, 0);
      const d = (daysAgo: number) => compute.utcDay(now - daysAgo * DAY);
      const ins = db.prepare("INSERT INTO profile_ai_clicks (vertical_id, profile_id, day, ai_vendor, count) VALUES (?, ?, ?, ?, ?)");
      ins.run("rfb", "a", d(0), "chatgpt", 3);
      ins.run("rfb", "a", d(10), "claude", 2);
      ins.run("rfb", "a", d(59), "perplexity", 1);  // last day inside the 60-day window
      ins.run("rfb", "a", d(60), "gemini", 7);      // just outside
      ins.run("rfb", "a", d(200), "copilot", 4);
      ins.run("rfb", "b", d(1), "chatgpt", 9);
      ins.run("rfb", "c", d(2), "claude", 5);
      ins.run("rfb", "c", d(90), "claude", 50);
      ins.run("dental", "a", d(0), "chatgpt", 100);

      const p = compute.getProfileAiClicks(db as any, "rfb", "a", now);
      assertEq(p.last60d.total, 6, "(d) 60-day window excludes older days");
      assertEq(`${p.last60d.byVendor.chatgpt},${p.last60d.byVendor.claude},${p.last60d.byVendor.perplexity},${p.last60d.byVendor.gemini}`, "3,2,1,0", "(d) 60-day byVendor split");
      assertEq(p.allTime.total, 17, "(d) allTime includes the older days");
      assertEq(`${p.allTime.byVendor.gemini},${p.allTime.byVendor.copilot},${p.allTime.byVendor.other}`, "7,4,0", "(d) allTime byVendor");
      assertEq(p.countingSince, d(200), "(d) countingSince = first stored day");
      const none = compute.getProfileAiClicks(db as any, "rfb", "zzz", now);
      assertEq(`${none.allTime.total}:${none.countingSince}`, "0:null", "(d) unknown profile: zeros and countingSince null");
      assertEq(compute.getProfileAiClicks(db as any, "dental", "a", now).allTime.total, 100, "(d) the vertical keeps profiles apart");

      const plat = compute.getPlatformAiClicks(db as any, "rfb", now, 2);
      assertEq(plat.last60d.total, 6 + 9 + 5, "(d) platform 60-day total");
      assertEq(plat.allTime.total, 17 + 9 + 55, "(d) platform all-time total");
      assertEq(plat.topProfiles60d.map((x) => `${x.profileId}:${x.total}`).join(","), "b:9,a:6", "(d) platform top list ordered by 60-day clicks, limited");
      assertEq(plat.countingSince, d(200), "(d) platform countingSince");
      const emptyDb = new Database(":memory:");
      assertEq(compute.getPlatformAiClicks(emptyDb as any, "rfb", now).topProfiles60d.length, 0, "(d) no table → empty result");
      emptyDb.close();
      clear();
    }

    // ── (e) the four profile-page call sites ───────────────────────────
    {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
      db.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES ('p-1', 'Aker Gaard En', 'En beskrivelse', 'Aker Gaard En', 'p-1@example.no', 'https://p-1.example.no', 'producer', 'key-p-1',
          '["vegetables"]', '[]', '[]', '{}', '["no"]', 'Oslo', 59.91, 10.75,
          0.9, 1, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run();
      const regMod = require("./marketplace-registry");
      regMod.marketplaceRegistry._agentsCache = null;
      regMod.marketplaceRegistry._statsCache = null;

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");
      const expDb = dbFactory.getDb("experiences");
      const dentalStore = require("./dental-store") as typeof import("./dental-store");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      function makeReqRes(url: string, ua: string, referer: string | undefined, ip: string, resolve: (v: { status: number; body: string }) => void) {
        const headers: Record<string, string> = { "user-agent": ua };
        if (referer) headers.referer = referer;
        const req: any = {
          method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "example.test",
          query: parseQuery(url), params: {}, headers, lang: "no", ip,
          get(h: string) { return headers[h.toLowerCase()]; },
        };
        const res: any = new EventEmitter();
        Object.assign(res, {
          statusCode: 200, locals: {},
          status(c: number) { res.statusCode = c; return res; },
          set() { return res; }, header() { return res; }, setHeader() { return res; },
          redirect() { res.statusCode = 301; res.emit("finish"); resolve({ status: 301, body: "" }); return res; },
          send(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b) }); return res; },
        });
        return { req, res };
      }
      // Router-level (dental / experiences, as profile-ai-deliveries-s2.test.ts).
      function invoke(router: any, url: string, ua: string, referer?: string, ip = "203.0.113.7"): Promise<{ status: number; body: string }> {
        return new Promise((resolve) => {
          const { req, res } = makeReqRes(url, ua, referer, ip, resolve);
          router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? String(err) : "" }));
        });
      }
      // Handler-level for seo.ts (as profile-ai-deliveries.test.ts).
      const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
      function invokeSeo(routePath: string, url: string, params: Record<string, string>, ua: string, referer?: string, ip = "203.0.113.7"): Promise<{ status: number; body: string }> {
        return new Promise((resolve) => {
          const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
          const handler = layer.route.stack[layer.route.stack.length - 1].handle;
          const { req, res } = makeReqRes(url, ua, referer, ip, resolve);
          req.params = params;
          req.hostname = "rettfrabonden.com";
          Promise.resolve(handler(req, res, () => resolve({ status: 404, body: "" }))).catch((err: any) => resolve({ status: 500, body: String(err) }));
        });
      }

      // rfb producer page
      clear();
      const rfb = await invokeSeo("/produsent/:slug", "/produsent/aker-gaard-en?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search", { slug: "aker-gaard-en" }, HUMAN, undefined, "198.51.100.200");
      assertEq(rfb.status, 200, "(e) rfb producer page renders 200");
      await invokeSeo("/produsent/:slug", "/produsent/aker-gaard-en", { slug: "aker-gaard-en" }, HUMAN, undefined, "198.51.100.201");
      await invokeSeo("/produsent/:slug", "/produsent/aker-gaard-en?utm_source=claude", { slug: "aker-gaard-en" }, CHATGPT_USER, undefined, "198.51.100.202");
      flush();
      assertEq(JSON.stringify(rows("rfb")), JSON.stringify([{ vertical_id: "rfb", profile_id: "p-1", ai_vendor: "claude", n: 1 }]), "(e) rfb producer page: a person from Claude counted; a direct visit and ChatGPT-User not");

      // dental clinic page
      const clinicId = dentalStore.createDentalAgent({
        navn: "Sentrum Tannklinikk AS", org_nr: "918800190", poststed: "OSLO", fylke: "Oslo",
        adresse: "Storgata 1", telefon: "22110090", hjemmeside: "https://klinikk.example.no",
      } as any);
      dentalDb.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(clinicId);
      const dentalRouter = (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default as any;
      const dc = await invoke(dentalRouter, `/klinikk/id/${clinicId}`, HUMAN, "https://chatgpt.com/", "198.51.100.210");
      assertEq(dc.status, 200, "(e) dental clinic page renders 200");
      await invoke(dentalRouter, `/klinikk/id/${clinicId}`, HUMAN, "https://www.google.com/", "198.51.100.211");
      flush();
      assertEq(JSON.stringify(rows("dental")), JSON.stringify([{ vertical_id: "dental", profile_id: clinicId, ai_vendor: "chatgpt", n: 1 }]), "(e) dental clinic page: a person from ChatGPT counted under dental; a Google visit not");

      // experiences: gårdssalg provider page + experience page
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES ('gs-fossmoen', 'Fossmoen Frukt', 'experiences', 'Telemark', 'Skien', 'Skien', 'cideri', NULL, NULL, 59.21, 9.61,
            'high', 'fossmoen-frukt', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      const expProvider = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expId = expStore.createExperience({
        title: "Hvalsafari i Tromsø", provider_id: expProvider,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });
      const expSlug = (expDb.prepare("SELECT slug FROM experiences WHERE id = ?").get(expId) as { slug: string }).slug;
      const expRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;
      const gs = await invoke(expRouter, "/kategori/gardssalg/produsent/fossmoen-frukt?utm_source=perplexity", HUMAN, undefined, "198.51.100.220");
      assertEq(gs.status, 200, "(e) gårdssalg provider page renders 200");
      const ex = await invoke(expRouter, `/opplevelse/${expSlug}`, HUMAN, "https://gemini.google.com/app", "198.51.100.221");
      assertEq(ex.status, 200, "(e) experience page renders 200");
      await invoke(expRouter, `/opplevelse/${expSlug}`, HUMAN, undefined, "198.51.100.222");
      await invoke(expRouter, `/opplevelse/${expSlug}?utm_source=claude`, GOOGLEBOT, undefined, "198.51.100.223");
      flush();
      const exp = rows("experiences");
      assertTrue(exp.some((x) => x.profile_id === "gs-fossmoen" && x.ai_vendor === "perplexity" && x.n === 1), "(e) gårdssalg provider page: a person from Perplexity counted under the provider id");
      assertTrue(exp.some((x) => x.profile_id === expId && x.ai_vendor === "gemini" && x.n === 1), "(e) experience page: a person from Gemini counted under the experience id");
      assertEq(total("experiences"), 2, "(e) experiences: a direct visit and Googlebot count nothing");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    (require("./profile-ai-clicks") as typeof import("./profile-ai-clicks")).__resetAiClicksForTesting();
    try { (require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries")).__resetAiDeliveriesForTesting(); } catch { /* best effort */ }
    try {
      const regMod = require("./marketplace-registry");
      regMod.marketplaceRegistry._agentsCache = null;
      regMod.marketplaceRegistry._statsCache = null;
    } catch { /* best effort */ }
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
    restoreModuleCache();
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileAiClicksTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

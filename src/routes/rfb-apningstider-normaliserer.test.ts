/**
 * rfb-apningstider-normaliserer.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-H (FUNN
 * rfb-apningstider-alternative-former, rfb-isopennow-lange-dagnavn and
 * a2a-produsent-agent-json-404 from the lokal#1114 review).
 *
 * On main (ca0f313f) the producer page showed no opening hours for {day,
 * hours}, {day, from, to}, {days, …}, {period, …} and note-only entries,
 * lokal_info and the A2A auto-reply left them out, the front page's "open now"
 * matched only "mon"…"sun" (so "monday" or "Mandag-Søndag" said "Stengt" in
 * opening hours, and a REKO ring's "Varierer" said "Stengt" every day), and
 * JSON-LD wrote stored keys after "https://schema.org/" ("…/mon-fri",
 * "…/Varierer"). All four now read utils/opening-hours.ts.
 *
 * Covers, on the real handlers with an in-memory DB:
 *   (a) producer page, one producer per stored form (no and en): the hours
 *       card shows the days and times or the text, the FAQ says hours are
 *       listed, JSON-LD has only valid weekdays (none for labels that are no
 *       weekday, or a period), the "today" highlight covers a range, no junk.
 *   (b) front page: featured producers with long English day names and a
 *       Norwegian range, open all day, say "Åpent nå"; a REKO ring with only
 *       "Varierer" says nothing (main: "Stengt" for all three).
 *   (c) lokal_info and the auto-reply give the same hours text for every
 *       producer, and each time on the page is in it.
 *   (d) GET /agents/:id/agent.json is seed-store only (see a2a.ts): no
 *       non-test source file links it, so no discovery surface points at a
 *       route that answers 404 for marketplace producers.
 *
 * Exported runRfbApningstiderNormalisererTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/rfb-apningstider-normaliserer.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: unknown;
  handler: (args: any) => Promise<any>;
}

/** The inner HTML of the hours card grid. */
function hoursGrid(body: string): string | null {
  const m = /<div class="hrs-grid">(.*)<\/div><\/div>\n/.exec(body);
  return m ? m[1]! : null;
}

/** The page without the "today" highlight, which depends on the weekday the test runs. */
function withoutToday(html: string): string {
  return html.replace(/ hrs-today/g, "").replace(/<span class="hrs-open"><span class="hrs-dot"><\/span> [^<]*<\/span>/g, "");
}

function jsonLdBlocks(body: string): any[] {
  return [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
}

/** "undefined", "[object Object]" or "NaN" in the visible HTML or in a JSON-LD string. */
function junk(body: string): string[] {
  const visible = body.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
  const found = [...visible.matchAll(/.{0,40}(\[object Object\]|\bundefined\b|\bNaN\b).{0,20}/g)].map((m) => m[0]);
  for (const ld of jsonLdBlocks(body)) {
    JSON.stringify(ld, (_k, v) => {
      if (typeof v === "string" && /\[object Object\]|undefined|NaN/.test(v)) found.push(`JSON-LD: ${v}`);
      return v;
    });
  }
  return found;
}

/** Every non-test source file under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|html|json|txt|md)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function runRfbApningstiderNormalisererTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } = require("../services/geocoding-service") as
    typeof import("../services/geocoding-service");
  const prevDb = __peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  const origError = console.error;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
    __clearGeocodeCacheForTesting();
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    // ══ fixture: one producer per stored form (shapes from live data 2026-10-17) ══
    function seedProducer(row: { id: string; name: string; city: string; geo: [number, number]; trust?: number; claimed?: boolean; hours: unknown }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          '["vegetables"]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
          ?, 1, 1, 0, 0, 0, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00')`,
      ).run(
        row.id, row.name, "Lokal produsent med gardsutsalg og mye godt.", row.name, `${row.id}@example.no`,
        "https://example.no", `key-${row.id}`, row.city, row.geo[0], row.geo[1], row.trust ?? 0.5,
      );
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status, products, opening_hours)
         VALUES (?, '2026-08-01 10:00:00', '2026-08-01 10:00:00', 'enriched', ?, ?)`,
      ).run(row.id, JSON.stringify([{ name: "Poteter", category: "vegetables" }]), JSON.stringify(row.hours));
      if (row.claimed) {
        testDb.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-08-01 10:00:00')`,
        ).run(`claim-${row.id}`, row.id, `${row.id}-owner@example.no`);
      }
    }
    const P = {
      // {day, hours} with Norwegian and nynorsk day names and a closed day (Røtter Frogner, Sognasmak).
      hours: { id: "ih-hours", name: "Hanne Timer", slug: "hanne-timer", hours: [
        { day: "Mandag", hours: "Stengt" }, { day: "Tysdag-Onsdag", hours: "10:00-16:00" },
        { day: "Mandag-Fredag", hours: "10:00-19:00" }, { day: "Lørdag", hours: "11:00-18:00" },
      ] },
      // {day, from, to} with labels that name no weekday (Tysnes Gårdsysteri).
      fromTo: { id: "ih-fromto", name: "Frode Fratil", slug: "frode-fratil", hours: [
        { day: "Påske", from: "12:00", to: "18:00" }, { day: "Fre–lør (sesong)", from: "12:00", to: "20:00" },
      ] },
      // Notes without times (Rånås Gård, Engøy Gjestegård, {note}).
      notes: { id: "ih-notes", name: "Nora Notat", slug: "nora-notat", hours: [
        { day: "by-appointment", note: "Åpent etter avtale — ring eller send SMS" },
        { day: "note", open: "1. juli - 31. juli: Mandag-søndag 09:00-16:00" },
        { note: "Selvbetjent <bod> & kjøleskap" },
      ] },
      // {period, days, …} and {days: [...]} (Ciderhuset Balestrand, Velure Gard).
      period: { id: "ih-period", name: "Per Periode", slug: "per-periode", hours: [
        { period: "April", days: "Torsdag–Fredag", open: "12:00", close: "16:00" },
        { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "08:00", close: "18:00" },
      ] },
      // A range every day, so "today" is always highlighted (main never highlighted a range).
      range: { id: "ih-range", name: "Rita Rekkevidde", slug: "rita-rekkevidde", hours: [{ day: "mon-sun", open: "00:00", close: "24:00", note: "Døgnåpen selvbetjent" }] },
    };
    seedProducer({ ...P.hours, city: "Oslo", geo: [59.91, 10.75] });
    seedProducer({ ...P.fromTo, city: "Tysnes", geo: [59.99, 5.5] });
    seedProducer({ ...P.notes, city: "Hamar", geo: [60.79, 11.07] });
    seedProducer({ ...P.period, city: "Balestrand", geo: [61.2, 6.53] });
    seedProducer({ ...P.range, city: "Moss", geo: [59.43, 10.66] });
    // Front page: the three claimed producers with the highest trust get the ultra-rich card.
    const allWeek = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    seedProducer({ id: "ih-c-long", name: "Kari Langnavn", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.99,
      hours: allWeek.map((day) => ({ day, open: "00:00", close: "24:00" })) });
    seedProducer({ id: "ih-c-range", name: "Kjell Norskuke", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.98,
      hours: [{ day: "Mandag-Søndag", hours: "00:00-24:00" }] });
    seedProducer({ id: "ih-c-reko", name: "REKO Testringen", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.97,
      hours: [{ day: "Varierer", open: "16:00", close: "17:00", note: "Utlevering skjer på avtalt tid og sted." }] });

    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    delete require.cache[require.resolve("./seo")];
    const seo = require("./seo") as typeof import("./seo");
    const router = seo.default as any;
    function handlerFor(routePath: string): any {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${routePath} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    function invoke(handler: any, req: any): { status: number; body: string } {
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: () => { status = 301; return res; },
        setHeader: () => res,
        set: () => res,
        locals: {},
      };
      console.log = () => {};
      console.error = () => {};
      try { handler(req, res, () => { status = -1; }); } finally { console.log = origLog; console.error = origError; }
      return { status, body };
    }
    const producerHandler = handlerFor("/produsent/:slug");
    const homeHandler = handlerFor("/");
    const producer = (slug: string, lang: "no" | "en" = "no") =>
      invoke(producerHandler, { params: { slug }, lang, ip: "127.0.0.1", headers: {}, get: () => undefined, query: {} });
    const home = (lang: "no" | "en") => invoke(homeHandler, { lang, query: {}, ip: "127.0.0.1", headers: {}, get: () => undefined });
    const specDays = (body: string) => (jsonLdBlocks(body).find((b) => b["@type"] === "LocalBusiness")?.openingHoursSpecification ?? [])
      .map((s: any) => s.dayOfWeek);
    const faqClaimsHours = (body: string) => JSON.stringify(jsonLdBlocks(body).find((b) => b["@type"] === "FAQPage") ?? {}).includes("har åpningstider oppført");
    const sd = (...days: string[]) => days.map((d) => `https://schema.org/${d}`);

    // ══ (a) producer page ════════════════════════════════════════════════
    const pages: Record<string, { no: string; en: string }> = {};
    for (const p of Object.values(P)) {
      const no = producer(p.slug);
      const en = producer(p.slug, "en");
      assertEq([no.status, en.status], [200, 200], `a ${p.slug}: 200 (no, en)`);
      assertTrue(faqClaimsHours(no.body), `a ${p.slug}: the FAQ says hours are listed (main: not for this form)`);
      assertEq(junk(no.body).concat(junk(en.body)), [], `a ${p.slug}: no junk text (no, en)`);
      pages[p.slug] = { no: no.body, en: en.body };
    }
    assertEq(withoutToday(hoursGrid(pages["hanne-timer"]!.no) ?? ""),
      "<div class=\"hrs-day\">Mandag</div><div class=\"hrs-time\">Stengt</div>" +
      "<div class=\"hrs-day\">Tirsdag–Onsdag</div><div class=\"hrs-time\">10:00 – 16:00</div>" +
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">10:00 – 19:00</div>" +
      "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">11:00 – 18:00</div>",
      "a {day, hours}: the days and times, a closed day as \"Stengt\" (main: no hours card)");
    assertEq(withoutToday(hoursGrid(pages["hanne-timer"]!.en) ?? ""),
      "<div class=\"hrs-day\">Monday</div><div class=\"hrs-time\">Stengt</div>" +
      "<div class=\"hrs-day\">Tuesday–Wednesday</div><div class=\"hrs-time\">10:00 – 16:00</div>" +
      "<div class=\"hrs-day\">Monday–Friday</div><div class=\"hrs-time\">10:00 – 19:00</div>" +
      "<div class=\"hrs-day\">Saturday</div><div class=\"hrs-time\">11:00 – 18:00</div>",
      "a {day, hours} /en: Norwegian and nynorsk day names in English");
    assertEq(specDays(pages["hanne-timer"]!.no), [sd("Tuesday", "Wednesday"), sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"), sd("Saturday")[0]],
      "a {day, hours}: JSON-LD for the timed entries, valid weekdays; the closed day has no times and no entry");
    assertEq(withoutToday(hoursGrid(pages["frode-fratil"]!.no) ?? ""),
      "<div class=\"hrs-day\">Påske</div><div class=\"hrs-time\">12:00 – 18:00</div>" +
      "<div class=\"hrs-day\">Fre–lør (sesong)</div><div class=\"hrs-time\">12:00 – 20:00</div>",
      "a {day, from, to}: from/to are the times; a label that is no weekday is shown as written");
    assertEq(specDays(pages["frode-fratil"]!.no), [], "a {day, from, to}: no JSON-LD hours for labels that are no weekday");
    assertEq(hoursGrid(pages["nora-notat"]!.no),
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Åpent etter avtale — ring eller send SMS</div>" +
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">1. juli - 31. juli: Mandag-søndag 09:00-16:00</div>" +
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Selvbetjent &lt;bod&gt; &amp; kjøleskap</div>",
      "a notes: each note is a text row, escaped; the markers \"by-appointment\" and \"note\" are not shown");
    assertEq(specDays(pages["nora-notat"]!.no), [], "a notes: no JSON-LD hours");
    assertEq(withoutToday(hoursGrid(pages["per-periode"]!.no) ?? ""),
      "<div class=\"hrs-day\">Torsdag–Fredag</div><div class=\"hrs-time\">12:00 – 16:00 (April)</div>" +
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">08:00 – 18:00</div>",
      "a {period, days, …} and {days: [...]}: the period is shown with its times");
    assertEq(specDays(pages["per-periode"]!.no), [sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")],
      "a period: an entry that holds only in a period has no JSON-LD (no validity dates); the year-round one does");
    {
      const grid = hoursGrid(pages["rita-rekkevidde"]!.no) ?? "";
      assertTrue(/^<div class="hrs-day hrs-today">Mandag–Søndag<span class="hrs-open">/.test(grid) && grid.includes("<div class=\"hrs-time hrs-today\">00:00 – 24:00 (Døgnåpen selvbetjent)</div>"),
        "a today: a range that covers today is highlighted (main matched only \"mon\"…\"sun\" and the long names)");
      assertEq(specDays(pages["rita-rekkevidde"]!.no), [sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")],
        "a mon-sun: JSON-LD lists the seven days (main: \"https://schema.org/mon-sun\")");
    }

    // ══ (b) front page ═══════════════════════════════════════════════════
    for (const lang of ["no", "en"] as const) {
      const r = home(lang);
      assertEq(r.status, 200, `b / ${lang}: 200`);
      const href = (slug: string) => `${lang === "en" ? "/en" : ""}/produsent/${slug}`;
      const card = (slug: string): string => new RegExp(`<a href="${href(slug)}" class="pc pc-ultra">([\\s\\S]*?)</a>`).exec(r.body)?.[1] ?? "";
      const openLine = (slug: string) => card(slug).match(/<div class="pc-meta-line">🕒[\s\S]*?<\/div>/)?.[0] ?? null;
      const openNow = lang === "en" ? "Open now" : "Åpent nå";
      assertTrue(!!card("kari-langnavn") && !!card("kjell-norskuke") && !!card("reko-testringen"), `b / ${lang}: the three claimed producers have ultra-rich cards`);
      assertEq(openLine("kari-langnavn"), `<div class="pc-meta-line">🕒 <span class="pc-open-now">${openNow}</span> <span class="pc-hours">00:00–24:00</span></div>`,
        `b / ${lang}: "monday"…"sunday" open all day is open now (main: "Stengt")`);
      assertEq(openLine("kjell-norskuke"), `<div class="pc-meta-line">🕒 <span class="pc-open-now">${openNow}</span> <span class="pc-hours">00:00–24:00</span></div>`,
        `b / ${lang}: a Norwegian range "Mandag-Søndag" from {day, hours} is open now (main: "Stengt")`);
      assertEq(openLine("reko-testringen"), null, `b / ${lang}: only "Varierer" says nothing about the day, so no open-now line (main: "Stengt")`);
      assertEq(junk(r.body), [], `b / ${lang}: no junk text`);
    }
    {
      // isOpenNow at a fixed time: Kringler Gjestegård's hours (live 2026-10-17), Saturday 12:00 in Oslo.
      const kringler = ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ day, open: "10:00", close: "17:00" }))
        .concat([{ day: "saturday", open: "10:00", close: "15:00" }]);
      assertEq(seo.isOpenNow(kringler, new Date("2026-10-17T10:00:00Z")), { isOpen: true, todayLabel: "10:00–15:00" },
        "b isOpenNow: Kringler on Saturday 12:00 is open (main: \"Stengt\")");
      assertEq(seo.isOpenNow(kringler, new Date("2026-10-18T10:00:00Z")), { isOpen: false }, "b isOpenNow: Kringler on Sunday is closed");
      assertEq(seo.isOpenNow([{ day: "mon", open: "10:00", close: "17:00" }], new Date("2026-10-12T09:00:00Z")), { isOpen: true, todayLabel: "10:00–17:00" },
        "b isOpenNow: the declared form as before (Monday 11:00)");
      assertEq([seo.isOpenNow("Man–fre 10–17"), seo.isOpenNow(null), seo.isOpenNow([])], [null, null, null],
        "b isOpenNow: free text, nothing and an empty list give no line, as before");
    }

    // ══ (c) lokal_info and the A2A auto-reply agree ══════════════════════
    {
      const mcp = require("./mcp") as typeof import("./mcp");
      const tools = new Map<string, CapturedTool>();
      const fakeServer: any = {
        registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
        resource() { /* no-op */ }, prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
      };
      mcp.registerTools(fakeServer, () => "test-client", () => undefined);
      const info = tools.get("lokal_info")!;
      const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
      const expected: Record<string, string> = {
        "hanne-timer": "Man: Stengt, Tir–Ons 10:00–16:00, Man–Fre 10:00–19:00, Lør 11:00–18:00",
        "frode-fratil": "Påske 12:00–18:00, Fre–lør (sesong) 12:00–20:00",
        "nora-notat": "Åpent etter avtale — ring eller send SMS, 1. juli - 31. juli: Mandag-søndag 09:00-16:00, Selvbetjent <bod> & kjøleskap",
        "per-periode": "Tor–Fre 12:00–16:00 (April), Man–Fre 08:00–18:00",
        "rita-rekkevidde": "Man–Søn 00:00–24:00",
      };
      for (const p of Object.values(P)) {
        console.log = () => {};
        let mcpText = "";
        let replyText = "";
        try {
          const r = await info.handler({ agentId: p.id });
          mcpText = String(r?.content?.[0]?.text ?? "");
          replyText = conversationService.generateSellerResponse(p.id)?.text ?? "";
        } finally { console.log = origLog; }
        const mcpHours = /\n## Åpningstider\n(.*)\n/.exec(mcpText)?.[1] ?? null;
        const replyHours = /\n🕐 Åpningstider: (.*)\n/.exec(replyText)?.[1] ?? null;
        assertEq(mcpHours, expected[p.slug], `c ${p.slug}: lokal_info shows the hours (main: left out)`);
        assertEq(replyHours, mcpHours, `c ${p.slug}: the A2A auto-reply shows the same hours as lokal_info`);
        const pageTimes = [...(hoursGrid(pages[p.slug]!.no) ?? "").matchAll(/(\d{2}:\d{2}) – (\d{2}:\d{2})/g)].map((m) => `${m[1]}–${m[2]}`);
        assertTrue(pageTimes.every((t) => (mcpHours ?? "").includes(t)),
          `c ${p.slug}: every time on the page is in lokal_info's hours`);
      }
    }

    // ══ (d) /agents/:id/agent.json is seed-store only; nothing links it ══
    {
      const root = path.resolve(__dirname, "..");
      const offenders: string[] = [];
      for (const file of sourceFiles(root)) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!/\/agents\/[^\s"'`]*\/agent\.json/.test(line)) return;
          const trimmed = line.trim();
          const isA2aRoute = file.endsWith(path.join("routes", "a2a.ts")) && (trimmed.startsWith("//") || trimmed.startsWith('router.get("/agents/:id/agent.json"'));
          if (!isA2aRoute) offenders.push(`${path.relative(root, file)}:${i + 1}: ${trimmed.slice(0, 120)}`);
        });
      }
      assertEq(offenders, [], "d no source file outside a2a.ts's route links /agents/:id/agent.json (seed store only, 404 for marketplace producers)");
      const a2a = fs.readFileSync(path.join(root, "routes", "a2a.ts"), "utf8");
      assertTrue(a2a.includes('router.get("/agents/:id/agent.json"'), "d the route itself is still registered (behaviour unchanged)");
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    if (prevDb) __setDbForTesting(prevDb as any);
    __setGeocodingFetchForTesting();
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-apningstider-normaliserer.test.ts`
if (require.main === module) {
  console.log("── rfb-apningstider-normaliserer (I-H: one reading of opening hours) ──");
  runRfbApningstiderNormalisererTests({ log: true }).then((r) => {
    console.log(`\nrfb-apningstider-normaliserer: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

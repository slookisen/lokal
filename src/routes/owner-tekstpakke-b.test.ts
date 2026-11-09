/**
 * owner-tekstpakke-b.test.ts — tekstpakke B (approved owner dashboard texts,
 * 2026-11-09; dev-request 2026-10-30-rfb-eierportal-testrunde-1, D3).
 *
 *   p1-*    «Slik fungerer bestillinger»: the limit line without «For å hindre
 *           misbruk», numbers from the settings.
 *   p2-*    O-1: «Ikke synlig for kunder ennå» once; the «not published yet»
 *           line where «Se profilen din» otherwise stands.
 *   p3-*    the same three number names on Oversikt and Statistikk.
 *   p4-7    Oversikt and the portal cards (the intro in «Profilinformasjon»
 *           with the shell, «Bestillinger og pause», «Tallene oppdateres av seg
 *           selv.», «Laster …»).
 *   p8-13   O-2 Statistikk (OWNER_STATS_PAGE_TEXTS): tips, «Fra visning til
 *           kontakt», «Fra AI-assistenter», source names (organic under
 *           direct), AI cards, «Trykk på kontaktinformasjonen»; days from the
 *           payload, never «Nd».
 *   nt-*    not text: no top «Logg ut» on Oversikt with the shell; one «Varer»
 *           heading on the Varer page; «Gå til varene dine» → /eier/:id/varer.
 *   selger-* the /selger tab (selger.html) keeps its old wording.
 *
 * Real routers on the production schema in an in-memory DB for the portal,
 * Varer and Mine valg pages (same harness as owner-shell-t15a); the Statistikk
 * sections are rendered from a fixed payload. Every env key it touches is
 * restored. Standalone: npx tsx src/routes/owner-tekstpakke-b.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ENV_KEYS = [
  "OWNER_DASHBOARD_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "ORDER_MESSAGES_ENABLED", "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY",
];
const ON_ID = "tpb-on";
const OFF_ID = "tpb-off";
const HIDDEN_LINE = "Profilsiden din er ikke publisert ennå, så kunder og AI-assistenter finner den ikke. Det er ikke noe du har gjort feil. Skriv til oss, så hjelper vi deg.";
const PROFILE_INTRO = "Rediger profilinformasjonen din. Endringene vises i endringsloggen, og kundeservice kan se dem.";
const OLD_INTRO = "Rediger profilinformasjonen din. Endringer logges og er synlige for support.";

function seedProducer(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for tekstpakke B.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, `Tekstgard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
}

function count(h: string, needle: string): number {
  return h.split(needle).length - 1;
}

export async function runOwnerTekstpakkeBTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.info(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.info(`  ✗ ${name}`); }
  };
  /** The new text is in the HTML, the old one is not. */
  const swap = (html: string, newText: string, oldText: string, name: string) => ok(html.includes(newText) && !html.includes(oldText), name);

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }

  try {
    // ── 1. «Slik fungerer bestillinger» ─────────────────────────────────────
    const texts = require("../owner-features/order-texts") as typeof import("../owner-features/order-texts");
    const lines = texts.ownerOrderLimitLines({ openPerBuyer: 3, perBuyerPerDay: 10, producerCeilingPerDay: 50 });
    ok(lines[1] === "Én kunde kan ha høyst 3 ubesvarte bestillinger hos deg om gangen, og sende deg høyst 10 nye bestillinger per dag.", "p1-01: the limit line without «For å hindre misbruk» (3/10)");
    const lines2 = texts.ownerOrderLimitLines({ openPerBuyer: 5, perBuyerPerDay: 7, producerCeilingPerDay: 40 });
    ok(lines2[1] === "Én kunde kan ha høyst 5 ubesvarte bestillinger hos deg om gangen, og sende deg høyst 7 nye bestillinger per dag.", "p1-02: the numbers still come from the settings (5/7)");
    ok(!lines.join(" ").includes("misbruk") && lines.length === 4, "p1-03: no «misbruk», the other lines stay");

    // ── 2–3. «Oversikt» block (pure render) ─────────────────────────────────
    const ov = require("../owner-ui/overview") as typeof import("../owner-ui/overview");
    const model = (o: Partial<import("../owner-ui/overview").OwnerOverviewModel>) => ov.renderOwnerOverview({
      agentId: ON_ID, profileSlug: "tekstgard", visibility: "visible", orders: "on", levelText: null,
      counts: { pendingOrders: 0, itemsToConfirm: 0 },
      stats: { humanViews: { value: 12, label: "siste 12 måneder" }, aiViews: { value: 5, label: "siste 12 måneder" }, aiDeliveries: { value: 7, label: "siden 1. okt. 2026" } },
      showNewsQuestion: false, newsResult: null, itemsPage: true, statsPage: true, ...o,
    });
    const hidden = model({ visibility: "hidden" });
    ok(count(hidden, "Ikke synlig for kunder ennå") === 1, "p2-01: «Ikke synlig for kunder ennå» stands once (the status badge)");
    ok(hidden.includes(`data-visibility="hidden">Ikke synlig for kunder ennå</li>`), "p2-02: the status badge says «Ikke synlig for kunder ennå»");
    ok(hidden.includes(`<p class="ow-ov-line" data-ov="profile">${HIDDEN_LINE}</p>`) && !hidden.includes(`href="/produsent/`), "p2-03: the explanation stands where «Se profilen din» otherwise is");
    ok(!hidden.includes("Skjult for kunder"), "p2-04: «Skjult for kunder» is gone");
    const visible = model({});
    ok(visible.includes(`>Se profilen din</a>`) && !visible.includes(HIDDEN_LINE), "p2-05: a published profile keeps «Se profilen din» and no explanation");
    ok(model({ visibility: "paused" }).includes(">På pause</li>"), "p2-06: «På pause» is unchanged");
    ok(visible.includes(`<div class="ep-stat-label">Besøk på profilsiden (siste 12 måneder)</div>`), "p3-01: Oversikt «Besøk på profilsiden»");
    ok(visible.includes(`<div class="ep-stat-label">Hentet av AI-assistenter (siste 12 måneder)</div>`), "p3-02: Oversikt «Hentet av AI-assistenter»");
    ok(visible.includes(`<div class="ep-stat-label">Med i treffene til AI-assistenter (siden 1. okt. 2026)</div>`), "p3-03: Oversikt «Med i treffene til AI-assistenter»");
    ok(!visible.includes("Sidevisninger fra mennesker") && !visible.includes("AI-søk"), "p3-04: the old names are gone from Oversikt");

    // ── 4, 6. Portal cards (pure) ────────────────────────────────────────────
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const moved = portalMod.ownerItemsMovedCardHtml(ON_ID);
    swap(moved, `<p>Varene dine finner du under «Varer». <a href="/eier/${ON_ID}/varer">Gå til Varer</a></p>`, "Varene dine har nå en egen side.", "p4-01: «Varene dine finner du under «Varer».» with «Gå til Varer»");
    swap(portalMod.ownerFeaturesMovedCardHtml(ON_ID), "Bestillinger, adressen de sendes til og pause velger du i «Mine valg».",
      "Om du tar imot bestillinger", "p6-01: «Bestillinger og pause» has the short sentence");

    // ── Statistikk (pure render from a fixed payload) ────────────────────────
    const sp = require("../owner-ui/stats-page") as typeof import("../owner-ui/stats-page");
    const stats: any = {
      windowDays: 45,
      funnel: { discovered: 42, viewed: 6, contactClicked: 4 },
      year: {
        humanViews: { value: 30 }, aiViews: { value: 9 }, aiDeliveries: { value: 11 },
        labels: { nb: { humanViews: "siste 12 måneder", aiViews: "siste 12 måneder", aiDeliveries: "siste 12 måneder" } },
      },
      aiFunnel: {
        windowDays: 45,
        sentToAi: { total: 11 },
        aiClicks: { total: 3, byVendor: { chatgpt: 2, claude: 1 } },
        contactClicks: { total: 4, fromAi: { total: 1 } },
      },
      viewsBySource: { totals: { direct: 3, organic: 2, search: 4, social: 1, referral: 5, unknown: 1 }, daily: [] },
      aiPlatforms: { chatgpt: 4, claude: 2, other: 1, total: 7 },
      aiDeliveries: {
        window: { total: 11, windowDays: 365, byVendor: { chatgpt: 6 }, byChannel: { mcp: 2, a2a: 1 } },
        allTime: { total: 20, byVendor: { chatgpt: 10 }, byChannel: { mcp: 3, a2a: 2 } },
      },
      matchingSearchQueries: [],
      conversationsByChannel: [{ source: "web", count: 2 }, { source: "mcp", count: 1 }, { source: "a2a", count: 1 }, { source: "api", count: 1 }],
      contactClicksByKind: [{ kind: "email", count: 2 }, { kind: "external:gard.example.no", count: 1 }],
    };
    const st = sp.renderOwnerStatsPageBody({ stats, nowMs: Date.parse("2026-11-09T12:00:00Z") });

    // 9. Fra visning til kontakt
    swap(st, "<h2>Fra visning til kontakt</h2>", "Trakt", "p9-01: «Fra visning til kontakt»");
    ok(st.includes(">Vist i søkeresultater (siden start, også roboter)</div>"), "p9-02: «Vist i søkeresultater (siden start, også roboter)»");
    ok(st.includes(">Besøk på profilsiden (siste 12 måneder)</div>"), "p9-03 / p3-05: «Besøk på profilsiden (periode)»");
    ok(st.includes(">Trykk på e-post, telefon eller nettside (siste 45 dager)</div>"), "p9-04: «Trykk på e-post, telefon eller nettside (siste N dager)», N from the payload");
    ok(st.includes("Besøk gjelder perioden på kortet, som på profilsiden din. Trykk på e-post, telefon og nettside gjelder de siste 45 dagene. Et trykk viser at noen var interessert, ikke at de fikk tak i deg. «Vist i søkeresultater» teller alt siden start, også roboter og AI. For AI, se «Med i treffene til AI-assistenter»."),
      "p9-05: the funnel explanation (days from the payload)");
    const noYear = sp.renderOwnerStatsSections({ stats: { ...stats, year: undefined }, nowMs: Date.parse("2026-11-09T12:00:00Z") });
    ok(noYear.includes(">Besøk på profilsiden (siste 45 dager)</div>"), "p9-06: without the 12-month tile the period is «siste N dager», not «Nd»");

    // 10. Fra AI-assistenter
    ok(st.includes("<h2>Fra AI-assistenter</h2>"), "p10-01: «Fra AI-assistenter»");
    ok(st.includes(">Med i treffene til AI (siste 45 dager)</div>"), "p10-02: «Med i treffene til AI» (default label «siste N dager»)");
    ok(st.includes(">Besøk fra et AI-svar (siste 45 dager, minst)</div>"), "p10-03: «Besøk fra et AI-svar (minst)»");
    ok(st.includes("Av disse kom fra et AI-svar: <strong data-ai-funnel-from-ai=\"1\">1</strong> (siste 45 dager)"), "p10-04: «Av disse kom fra et AI-svar:» and «siste N dager»");
    ok(st.includes("<h3>Besøk fra AI-svar, per assistent</h3>"), "p10-05: «Besøk fra AI-svar, per assistent»");
    ok(st.includes("«Med i treffene» er hvor mange ganger profilen din var blant treffene en AI-assistent hentet. «Besøk fra et AI-svar» er folk som trykket seg inn på profilen fra et svar i ChatGPT, Claude, Perplexity eller lignende. Tallet er et minimum, fordi ikke alle sier fra hvor besøket kom fra. Trykk på e-post, telefon og nettside viser hvor mange av dem som tok kontakt. Siste 45 dager, eller fra datoen på kortet."),
      "p10-06: the AI funnel explanation");
    const noClicks = sp.renderOwnerStatsSections({ stats: { ...stats, aiFunnel: { ...stats.aiFunnel, aiClicks: { total: 0, byVendor: {} } } }, nowMs: 0 });
    ok(noClicks.includes("Ingen besøk fra AI-svar ennå."), "p10-07: «Ingen besøk fra AI-svar ennå.»");
    ok(!st.includes("Sendt til AI") && !st.includes("Klikk fra AI-svar") && !st.includes("hvorav etter") && !st.includes("siste 45 d<") && !st.includes("siste 45 d)"), "p10-08: the old AI funnel words are gone");

    // 11. Hvor besøkene kom fra
    ok(st.includes("<h2>Hvor besøkene kom fra (siste 45 dager)</h2>"), "p11-01: «Hvor besøkene kom fra (siste N dager)»");
    ok(st.includes(`data-source="direct" data-count="5"><div class="ow-st-src-head"><span>Direkte eller fra Rett fra Bonden</span>`), "p11-02: «Direkte eller fra Rett fra Bonden» counts direct + organic (3 + 2)");
    ok(st.includes("<span>Søkemotorer (for eksempel Google)</span>") && st.includes("<span>Sosiale medier</span>") && st.includes("<span>Lenker fra andre nettsider</span>") && st.includes("<span>Ukjent</span>"),
      "p11-03: «Søkemotorer (for eksempel Google)», «Sosiale medier», «Lenker fra andre nettsider», «Ukjent»");
    ok(!st.includes(`data-source="organic"`) && !st.includes("Organisk") && !st.includes("Henvisning") && !st.includes("<span>Direkte</span>") && !st.includes("<span>Søk</span>"), "p11-04: no «Organisk» row and no old source names");
    ok(!st.includes("Visninger fra mennesker"), "p11-05: the old heading is gone");

    // 12. AI cards
    ok(st.includes("<h2>Hentet av AI-assistenter</h2>"), "p12-01 / p3-06: «Hentet av AI-assistenter»");
    ok(st.includes(">ChatGPT (siste 45 dager)</div>") && st.includes(">Claude (siste 45 dager)</div>") && st.includes(">Andre AI (siste 45 dager)</div>"), "p12-02: «ChatGPT / Claude / Andre AI (siste N dager)»");
    ok(st.includes("<h2>Med i treffene til AI-assistenter</h2>"), "p12-03 / p3-07: «Med i treffene til AI-assistenter»");
    ok(st.includes("<h3>Per assistent</h3>") && st.includes("<h3>Hvor treffet skjedde</h3>"), "p12-04: «Per assistent» and «Hvor treffet skjedde»");
    ok(st.includes(`<span>Direkte kobling for AI (MCP)</span>`) && st.includes(`<span>Andre AI-agenter (A2A)</span>`), "p12-05: «Direkte kobling for AI (MCP)» and «Andre AI-agenter (A2A)»");
    ok(st.includes(`data-channel="api"><span>Andre tjenester</span>`) && st.includes(`data-channel="mcp"><span>Direkte kobling for AI (MCP)</span>`) && st.includes(`data-channel="a2a"><span>Andre AI-agenter (A2A)</span>`),
      "p12-06: «Samtaler per kanal» uses the same channel names, «Andre tjenester» for API");
    ok(st.includes("Hvor mange ganger ChatGPT, Claude og andre AI-assistenter har hentet profilen din for noen som spurte. Roboter som bare leser sider for å lage register, telles ikke. Fordelingen per assistent gjelder de siste 45 dagene."),
      "p12-07: explanation 1");
    ok(st.includes("Hvor mange ganger profilen din var blant treffene når en AI-assistent som ChatGPT eller Claude lette etter noe for noen: et søk, et sted, en kategori eller profilsiden din. Forsiden telles ikke. Tallet sier ikke hvor mange som så profilen. Svar AI-en gir fra egen hukommelse ser vi ikke, så tallet er et minimum."),
      "p12-08: explanation 2");
    ok(!st.includes("AI-søk") && !st.includes("Per AI<") && !st.includes("Per kanal") && !st.includes("API/annet") && !st.includes(">MCP<") && !st.includes(">A2A<") && !st.includes("indekserer") && !st.includes("markedsnettverk") && !st.includes("svar via MCP"),
      "p12-09: the old AI card words are gone");

    // 13. Trykk på kontaktinformasjonen
    ok(st.includes("<h2>Trykk på kontaktinformasjonen</h2>"), "p13-01: «Trykk på kontaktinformasjonen»");
    ok(st.includes("Trykk på e-post, telefon og nettside på profilen din. Det viser interesse, ikke at kunden fikk tak i deg."), "p13-02: the contact explanation");
    ok(st.includes("<span>Lenke til (gard.example.no)</span>"), "p13-03: «Lenke til (nettsted)»");
    const emptyRead = sp.renderOwnerStatsSections({ stats: { ...stats, contactClicksByKind: [] }, nowMs: 0 });
    ok(emptyRead.includes("Ingen trykk registrert ennå."), "p13-04: «Ingen trykk registrert ennå.»");
    ok(!st.includes("Kontakt-klikk") && !st.includes("kontakt-klikk") && !st.includes("Ekstern lenke") && !st.includes("klikk-interesse"), "p13-05: no «Kontakt-klikk», «Ekstern lenke» or «klikk-interesse»");
    ok(!/\(\d+d\)/.test(st) && !/\(\d+d\)/.test(noYear) && !/siste \d+ d[)<]/.test(st), "p13-06: no «Nd» anywhere on the page");

    // 8. Tips for a new profile
    const zero: any = { ...stats, funnel: { discovered: 0, viewed: 0, contactClicked: 0 }, viewsBySource: { totals: { direct: 0, organic: 0 }, daily: [] }, aiPlatforms: { chatgpt: 0, claude: 0, other: 0, total: 0 } };
    const tips = sp.renderOwnerStatsSections({ stats: zero, nowMs: 0 });
    ok(tips.includes("<p>Profilen din er ny, så det er helt normalt at tallene under står på null. Her er noen grep for å komme i gang:</p>"), "p8-01: «Her er noen grep for å komme i gang:»");
    for (const [i, t] of [
      "Legg inn varer under «Varer», så har kunder og AI-assistenter noe å vise fram.",
      "Fyll ut profilen: om gården, kontaktinformasjon og åpningstider. Jo mer som står der, jo lettere er det for søk og AI-assistenter å finne og anbefale deg.",
      "Del lenken til profilen din (under «Se profilen din») i egne kanaler, for eksempel sosiale medier eller nyhetsbrev.",
      "Sjekk at e-post, telefon og nettside stemmer, så kundene når deg.",
    ].entries()) ok(tips.includes(`<li>${t}</li>`), `p8-0${i + 2}: tip «${t.slice(0, 30)}…»`);
    ok(!tips.includes("Produkter") && !tips.includes("&lt;din-url&gt;") && !tips.includes("tilskrives") && !tips.includes("konkrete grep"), "p8-06: no «Produkter»-fanen, «<din-url>», «tilskrives» or «konkrete grep»");
    ok(!tips.includes(`data-source="organic"`), "p8-07: a zero organic count gets no row of its own");

    // ── Routes: portal, Varer, Mine valg ────────────────────────────────────
    function findRouteHandler(router: any, path: string): Function {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.get);
      if (!layer) throw new Error(`route not found: GET ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    function invoke(handler: Function, id: string): Promise<{ status: number; html: string }> {
      const headers: Record<string, string> = { host: "rettfrabonden.com", authorization: `Bearer tok-${id}` };
      const req: any = {
        method: "GET", url: "/", path: "/", originalUrl: "/", params: { agentId: id }, body: undefined, query: {}, headers, cookies: {},
        ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com", get(name: string) { return headers[name.toLowerCase()]; },
      };
      return new Promise((resolve) => {
        let status = 200;
        let settled = false;
        const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, html: typeof body === "string" ? body : JSON.stringify(body) }); } };
        const res: any = {
          status(c: number) { status = c; return res; }, json(p: any) { settle(p); return res; }, send(p: any) { settle(p); return res; },
          redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; }, end() { settle(undefined); return res; },
          header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; }, setHeader() { return res; },
        };
        try {
          const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
          if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
        } catch (err) { settle({ __error: String(err) }); }
      });
    }

    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ORDER_MESSAGES_ENABLED = "1";
    process.env.OWNER_UNIFIED_SESSION_ENABLED = "1";
    process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
    seedProducer(db, ON_ID);
    seedProducer(db, OFF_ID);
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${ON_ID}`;

    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal"),
      varer: findRouteHandler(portalMod.default, "/eier/:agentId/varer"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg"),
    };

    // Shell off (flag unset): the top card keeps «Logg ut» and the old intro.
    const portalOff = await invoke(H.portal, ON_ID);
    const valgOff = await invoke(H.valg, ON_ID);
    ok(portalOff.status === 200 && !portalOff.html.includes("ow-nav"), "route: the portal renders without the shell (flag unset)");
    ok(portalOff.html.includes(`aria-label="Logg ut">Logg ut</button>`) && portalOff.html.includes(`<p>${OLD_INTRO}</p>`) && !portalOff.html.includes(PROFILE_INTRO),
      "nt-01 / p5-01: without the shell the top card keeps «Logg ut» and its intro (unchanged)");
    ok(valgOff.html.includes(`href="/eier/${ON_ID}/portal#bestillbare-varer">Gå til varene dine</a>`), "nt-02: without the Varer page «Gå til varene dine» keeps the portal anchor");

    process.env.OWNER_DASHBOARD_ENABLED = "1";
    const portalOn = await invoke(H.portal, ON_ID);
    const portalOffList = await invoke(H.portal, OFF_ID);
    const varerOn = await invoke(H.varer, ON_ID);
    const valgOn = await invoke(H.valg, ON_ID);
    const ph = portalOn.html;
    ok(portalOn.status === 200 && ph.includes(`<nav class="ow-nav" aria-label="Eierportal">`), "route: the portal renders in the shell (flag on, allowlisted)");

    // 5. The intro moves into «Profilinformasjon».
    ok(ph.includes(`<h2>Profilinformasjon</h2>\n        <p>${PROFILE_INTRO}</p>`), "p5-02: the intro stands in «Profilinformasjon» with the new wording");
    ok(count(ph, PROFILE_INTRO) === 1 && !ph.includes(OLD_INTRO) && !ph.includes("support."), "p5-03: the old intro (with «support») is gone from Oversikt");
    // Not text: one «Logg ut», the menu's.
    ok(count(ph, ">Logg ut<") === 1 && !ph.includes(`aria-label="Logg ut">Logg ut</button>`), "nt-03: Oversikt has one «Logg ut» (the menu's), not the top one");
    ok(ph.includes(`<form class="ow-more-form" method="post" action="/eier/${ON_ID}/logout">`), "nt-04: the menu's «Logg ut» is still the POST logout");
    ok(count(ph, "<h1") === 1, "nt-05: Oversikt still has one <h1>");
    // 3. The portal's own Statistikk card.
    ok(ph.includes(`<div class="ep-stat-label">Besøk på profilsiden (`) && ph.includes(`<div class="ep-stat-label">Hentet av AI-assistenter (`), "p3-08: the portal's Statistikk card uses the new names");
    ok(!ph.includes("Sidevisninger fra mennesker") && !ph.includes("AI-søk"), "p3-09: the old names are gone from Oversikt");
    // 4, 6, 7.
    ok(ph.includes("Varene dine finner du under «Varer».") && !ph.includes("Varene dine har nå en egen side."), "p4-02: Oversikt shows «Varene dine finner du under «Varer».»");
    ok(ph.includes("Bestillinger, adressen de sendes til og pause velger du i «Mine valg».") && !ph.includes("velger du nå i"), "p6-02: Oversikt «Bestillinger og pause» has the new sentence");
    swap(ph, "Tallene oppdateres av seg selv.", "Disse tallene oppdateres automatisk", "p7-01: «Tallene oppdateres av seg selv.»");
    swap(ph, `<li class="ep-audit-item ep-audit-meta">Laster …</li>`, "Laster ...", "p7-02: «Laster …» (one character)");
    // Off the allowlist (no shell): the new texts that are not shell-bound, the old top card.
    const po = portalOffList.html;
    ok(!po.includes("ow-nav") && po.includes(`aria-label="Logg ut">Logg ut</button>`) && po.includes(`<p>${OLD_INTRO}</p>`), "nt-06: off the allowlist the top card is unchanged (no shell)");
    ok(po.includes("Tallene oppdateres av seg selv.") && po.includes("Laster …") && po.includes("Besøk på profilsiden"), "p7-03: the Statistikk card and the change log texts are the same without the shell");

    // Not text: the Varer page has one «Varer» heading.
    const vh = varerOn.html;
    ok(varerOn.status === 200 && vh.includes("<h1>Varer</h1>"), "nt-07: the Varer page renders with its <h1> «Varer»");
    ok(count(vh, ">Varer</h2>") === 0 && count(vh, "<h1>Varer</h1>") === 1, "nt-08: no second «Varer» heading in the card");
    ok(portalOff.html.includes(`data-items-card="t13">\n        <h2>Varer</h2>`), "nt-09: the portal card (no Varer page) keeps its «Varer» heading");

    // Not text: «Gå til varene dine» → the Varer page.
    ok(valgOn.html.includes(`href="/eier/${ON_ID}/varer">Gå til varene dine</a>`) && !valgOn.html.includes("#bestillbare-varer\">Gå til varene dine"), "nt-10: «Gå til varene dine» goes to /eier/:id/varer");

    // ── /selger keeps its wording ────────────────────────────────────────────
    const selger = readFileSync(join(__dirname, "..", "public", "selger.html"), "utf8");
    ok(selger.includes("<h2>Trakt: oppdaget &rarr; sett &rarr; kontakt-klikk</h2>") && selger.includes("<h2>Kontakt-klikk etter type</h2>"), "selger-01: the /selger tab keeps «Trakt» and «Kontakt-klikk etter type»");
    ok(selger.includes("var SOURCE_LABELS = { direct: 'Direkte', organic: 'Organisk', search: 'Søk', social: 'Sosiale medier', referral: 'Henvisning', unknown: 'Ukjent' };"), "selger-02: the /selger tab keeps its source names");
    const statsSrc = readFileSync(join(__dirname, "..", "owner-ui", "stats-page.ts"), "utf8");
    ok(!/selger\.html|readFileSync/.test(statsSrc.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")), "selger-03: the Statistikk page shares no code or text with selger.html");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    cartSvc.__setCartTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerTekstpakkeBTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) { for (const f of r.failures) console.info("  - " + f); process.exit(1); }
  });
}

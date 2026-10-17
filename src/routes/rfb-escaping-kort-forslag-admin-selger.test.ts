/**
 * rfb-escaping-kort-forslag-admin-selger.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-K (security audit
 * 2026-10-17, workflow html-sink-audit: APP-1…5, DASH-1…5, ADM-1, SELGER-1).
 *
 * On main (c826bab0) the card grid on /app (app.html renderAgents) and on
 * /dashboard (dashboard.html renderAgents and the search suggestions,
 * showSuggestions) put the agent name, city, categories and id into innerHTML
 * unescaped, and the name can be written through the claim flow. admin.html's
 * showAdminAlert put "«name» slettet." into innerHTML. selger.html's escHtml
 * did not escape quotes, so a name broke out of the double-quoted
 * data-claim-name attribute in the match list. Now the cards and suggestions
 * run every value and attribute through the pages' esc() (I-I),
 * showAdminAlert sets its message as text, and escHtml escapes " and ' too.
 * From the I-I review: a badge or tag with no text is skipped (S1), and «Om»
 * uses the first value that is text (S2).
 *
 * Covers, on the real GET /agents and GET /find-match handlers with an
 * in-memory DB and the pages' own inline scripts run in a vm with a small
 * fake DOM (its innerHTML serializes text nodes and attributes as a browser
 * does):
 *   (a) the cards on app and dashboard, on page load and after a search: a
 *       name, city or category holding "<img …>", "\"><svg …>",
 *       "<a href=javascript:…" (closed or not) or "' onmouseover=…" is text,
 *       and data-id gives back the id as stored.
 *   (b) dashboard suggestions: the label is text; data-query and data-id give
 *       back the name, city and id as stored.
 *   (c) well-formed data: cards and suggestions are byte-identical to main's;
 *       a name with & or ' shows the same text, and data-query gives back a
 *       stored entity as it is.
 *   (d) admin.html: after deleting such an agent the alert shows the name as
 *       text; plain messages give main's HTML; the alert still clears; the
 *       table's id cell is escaped like its name cell.
 *   (e) selger.html: escHtml escapes quotes, and text without them comes out
 *       as before; the match list, also when opened as /selger?agent=<name>,
 *       keeps the name inside data-claim-name; well-formed matches are
 *       byte-identical to main's.
 *   (f) the producer modal on app and dashboard: no empty badge or tag, and a
 *       section with no tag left is not shown (S1); «Om» is the first value
 *       that is text (S2).
 *   (g) wrong-typed values: categories that are not a list no longer break
 *       the grid, a category that is not text gives no empty tag, and
 *       "constructor" or "__proto__" as a category is text.
 *
 * Exported runRfbEscapingKortForslagAdminSelgerTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-escaping-kort-forslag-admin-selger.test.ts
 */

import Database from "better-sqlite3";
import { decode, visibleText, startTags, injectionProblems, junk, inlineScript } from "../../tests/helpers/html-injection";
import { serializeText, jsonResponse, settle, runPage, type FetchStub, type Page } from "../../tests/helpers/fake-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const XSS = "<img src=x onerror=alert(1)>";
const BREAK_DQ = "\"><svg onload=alert(2)>";
const JS_LINK = "<a href=javascript:alert(3)>klikk</a>";
// No ">": sanitizeInput's tag strip leaves it, and the page's next ">" closes it (audit, APP-1).
const JS_OPEN = "<a href=javascript:alert(4) style=position:fixed;inset:0 x";
const BREAK_SQ = "' onmouseover='alert(5)";
const PAYLOADS = [XSS, BREAK_DQ, JS_LINK, JS_OPEN, BREAK_SQ];

// ─── Reading what the pages wrote ──────────────────────────────────────

/** The start tags with `cls` in their class list. */
function tagsWithClass(html: string, cls: string): ReturnType<typeof startTags> {
  return startTags(html).filter((t) => t.attrs.some(([n, v]) => n === "class" && v.split(/\s+/).includes(cls)));
}

/** The attributes of each tag with `cls`, decoded (what getAttribute gives). */
function attrsOf(html: string, cls: string): Array<Record<string, string>> {
  return tagsWithClass(html, cls).map((t) => Object.fromEntries(t.attrs));
}

/** The attribute names of each tag with `cls`, in order. */
function attrNamesOf(html: string, cls: string): string[][] {
  return tagsWithClass(html, cls).map((t) => t.attrs.map(([n]) => n));
}

export async function runRfbEscapingKortForslagAdminSelgerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  /** Runs one part; an error there fails that part, and the next part still runs. */
  async function section(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); }
    catch (err: any) {
      failed++;
      failures.push(`✗ ${name}: unexpected error: ${String(err?.stack || err?.message || err)}`);
      if (log) console.log(`  ✗ ${name}: unexpected error: ${String(err?.message || err)}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = __peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    // ══ fixture: one agent per payload, the payload in name, city, category and description ══
    function seed(row: { id: string; name: string; city: string; categories: unknown[]; description: string; trust: number }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          ?, '[]', '[]', '{}', '["no"]', ?, 59.91, 10.75,
          ?, 1, 0, 0, 0, 0, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00')`,
      ).run(row.id, row.name, row.description, "Produsent", `${row.trust}@example.no`, "https://example.no", `key-${row.trust}`,
        JSON.stringify(row.categories), row.city, row.trust);
    }
    const seeded = PAYLOADS.map((p, i) => ({
      id: `ik-${i}`, name: `Navn ${p}`, city: `Sted ${p}`, categories: [`Kat ${p}`, "honey"], description: `Om oss ${p}`, trust: 0.9 - i / 100,
    }));
    // An id the pages put into data-id (ids are server uuids today; hardening, APP-5).
    seeded.push({ id: `ik-id${BREAK_DQ}`, name: "Navn med rar id", city: "Sted", categories: ["eggs"], description: "Om oss", trust: 0.5 });
    for (const row of seeded) seed(row);

    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    // ══ the real handlers ════════════════════════════════════════════════
    delete require.cache[require.resolve("./marketplace")];
    const marketplace = require("./marketplace") as typeof import("./marketplace");
    const mRouter = marketplace.default as any;
    function handler(path: string): (req: unknown, res: unknown) => void {
      const layer = (mRouter.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${path} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    const agentsHandler = handler("/agents");
    const findMatchHandler = handler("/find-match");
    function call(h: (req: unknown, res: unknown) => void, query: Record<string, string>): { status: number; body: any } {
      const res: any = { statusCode: 200, body: undefined };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = (b: unknown) => { res.body = b; return res; };
      console.log = () => {};
      try { h({ query, params: {}, headers: {}, ip: "127.0.0.1" }, res); }
      finally { console.log = origLog; }
      return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) };
    }
    const listed = call(agentsHandler, {}).body;
    assertEq(listed.agents.map((a: any) => a.id).sort(), seeded.map((s) => s.id).sort(), "fixture: GET /agents lists every seeded agent");
    assertEq(listed.agents.find((a: any) => a.id === "ik-0")?.name, `Navn ${XSS}`, "fixture: GET /agents returns the name as stored (no server-side escaping)");

    /** A fetch that answers GET /agents and /find-match with the real handlers, /search with `searchBody`. */
    function routeFetch(searchBody: unknown = { results: [] }): FetchStub {
      return async (url: string, o?: { method?: string }) => {
        const u = new URL(url, "https://rettfrabonden.com");
        if (o?.method && o.method !== "GET") return jsonResponse({ success: false }, 405);
        if (u.pathname === "/api/marketplace/agents") return jsonResponse(call(agentsHandler, Object.fromEntries(u.searchParams)).body);
        if (u.pathname === "/api/marketplace/find-match") return jsonResponse(call(findMatchHandler, Object.fromEntries(u.searchParams)).body);
        if (u.pathname === "/api/marketplace/search") return jsonResponse(searchBody);
        if (u.pathname === "/health") return jsonResponse({ agents: seeded.length });
        return jsonResponse({ success: false }, 404);
      };
    }

    const appScript = inlineScript("app.html", "function renderAgents");
    const dashScript = inlineScript("dashboard.html", "function renderAgents");
    const adminScript = inlineScript("admin.html", "function showAdminAlert");
    const selgerScript = inlineScript("selger.html", "function escHtml");
    const pages: Array<[string, string]> = [["app", appScript], ["dashboard", dashScript]];

    /** A page after its own start-up (DOMContentLoaded -> loadAgents from the real GET /agents). */
    async function loadedPage(script: string, fetchStub: FetchStub = routeFetch()): Promise<Page> {
      const page = runPage(script, fetchStub, { pathname: "/app" });
      page.fireDocument("DOMContentLoaded");
      await settle();
      return page;
    }

    const CARD_TAGS = new Set(["div", "span", "button"]);
    function checkCards(html: string, label: string, ids: string[]): void {
      assertEq(injectionProblems(html, CARD_TAGS, []), [], `${label}: only the grid's own tags, no on* attribute, no href`);
      const text = visibleText(html);
      for (const p of PAYLOADS) {
        assertTrue(text.includes(`Navn ${p}`) && text.includes(`Sted ${p}`) && text.includes(`Kat ${p}`),
          `${label}: name, city and category ${JSON.stringify(p)} are shown as text`);
      }
      assertEq(attrNamesOf(html, "agent-card"), ids.map(() => ["class", "data-id"]), `${label}: each card has only class and data-id`);
      assertEq(attrsOf(html, "agent-card").map((a) => a["data-id"]), ids, `${label}: data-id gives back each id as stored`);
      assertEq(junk(html), [], `${label}: no junk text`);
    }

    async function suggestions(query: string, agents?: unknown[]): Promise<string> {
      const page = await loadedPage(dashScript);
      if (agents) page.context.allAgents = agents;
      page.el("searchInput").value = query;
      page.el("searchInput").dispatch("input");
      page.runTimers(200);
      return page.el("searchSuggestions").innerHTML;
    }
    const MATCH_TAGS = new Set(["p", "div", "strong", "span", "br", "button"]);
    function checkMatchList(html: string, label: string, expectNames: string[]): void {
      assertEq(injectionProblems(html, MATCH_TAGS, []), [], `${label}: only the list's own tags, no on* attribute, no href`);
      const buttons = startTags(html).filter((t) => t.name === "button" && t.attrs.some(([n]) => n === "data-claim-id"));
      assertEq(buttons.map((t) => t.attrs.map(([n]) => n)), expectNames.map(() => ["class", "style", "data-claim-id", "data-claim-name"]),
        `${label}: each claim button has only class, style, data-claim-id and data-claim-name`);
      assertEq(buttons.map((t) => Object.fromEntries(t.attrs)["data-claim-name"]), expectNames, `${label}: data-claim-name gives back each name as stored`);
    }
    async function modal(script: string, agent: Record<string, unknown>, data: unknown | null): Promise<{ badges: string; body: string }> {
      const page = runPage(script, async (url) => {
        if (url.endsWith("/info")) {
          if (data === null) throw new Error("offline");
          return jsonResponse({ success: true, data });
        }
        return jsonResponse({});
      }, { pathname: "/app" });
      page.context.allAgents = [agent];
      await page.context.openAgentModal(agent.id);
      return { badges: page.el("modalBadges").innerHTML, body: page.el("modalBody").innerHTML };
    }
    const base = { id: "m", name: "Gård", role: "producer", categories: ["vegetables"], skills: [], isVerified: false, isClaimed: false, location: { city: "Oslo" } };

    // ══ (a) cards on app and dashboard ═══════════════════════════════════
    await section("a cards", async () => {
      const listedIds = listed.agents.map((a: any) => a.id);
      for (const [name, script] of pages) {
        const page = await loadedPage(script);
        checkCards(page.el("agentsGrid").innerHTML, `a ${name} page load`, listedIds);
      }
      {
        // A search answered by /search (results[].agent, with a distance).
        const results = listed.agents.map((a: any, i: number) => ({ agent: { ...a, location: { ...a.location, distanceKm: 0.4 + i } } }));
        const page = await loadedPage(appScript, routeFetch({ results }));
        page.el("searchInput").value = "navn";
        page.el("searchInput").dispatch("keypress", { key: "Enter" });
        await settle();
        const html = page.el("agentsGrid").innerHTML;
        checkCards(html, "a app search", listedIds);
        assertTrue(visibleText(html).includes(`Sted ${XSS} · 400 m`), "a app search: the distance follows the escaped city");
      }
      {
        const page = await loadedPage(dashScript, routeFetch({ results: listed.agents.map((a: any) => ({ agent: a })) }));
        page.el("searchInput").value = "navn";
        page.el("searchInput").dispatch("keypress", { key: "Enter" });
        await settle();
        checkCards(page.el("agentsGrid").innerHTML, "a dashboard search", listedIds);
      }
    });

    // ══ (b) dashboard suggestions ════════════════════════════════════════
    await section("b suggestions", async () => {
      {
        const html = await suggestions("navn");
        assertEq(injectionProblems(html, new Set(["div", "span"]), []), [], "b names: only the suggestions' own tags, no on* attribute");
        const items = attrsOf(html, "suggestion-item");
        const expected = listed.agents.filter((a: any) => a.name.toLowerCase().includes("navn")).slice(0, 8);
        assertEq(items.map((a) => [a["data-query"], a["data-id"]]), expected.map((a: any) => [a.name, a.id]),
          "b names: data-query and data-id give back each name and id as stored");
        assertEq(attrNamesOf(html, "suggestion-item"), expected.map(() => ["class", "data-query", "data-id"]), "b names: each item has only class, data-query and data-id");
        for (const p of PAYLOADS) assertTrue(visibleText(html).includes(`Navn ${p}`), `b names: ${JSON.stringify(p)} is shown as text`);
      }
      {
        const html = await suggestions("sted");
        assertEq(injectionProblems(html, new Set(["div", "span"]), []), [], "b cities: only the suggestions' own tags, no on* attribute");
        const cities = [...new Set<string>(listed.agents.map((a: any) => a.location?.city))].filter((c) => c.toLowerCase().includes("sted")).slice(0, 8);
        assertEq(attrsOf(html, "suggestion-item").map((a) => a["data-query"]), cities, "b cities: data-query gives back each city as stored");
        assertEq(attrNamesOf(html, "suggestion-item"), cities.map(() => ["class", "data-query"]), "b cities: a city item has only class and data-query");
        for (const p of PAYLOADS) assertTrue(visibleText(html).includes(`📍 Sted ${p}`), `b cities: ${JSON.stringify(p)} is shown as text`);
      }
    });

    // ══ (c) well-formed data: byte-identical to main ═════════════════════
    await section("c well-formed", async () => {
      {
        const wellFormed = [
          { id: "wf-a", name: "Gård Ås", role: "producer", categories: ["vegetables", "honey", "eggs", "dairy"], location: { city: "Ås" }, isVerified: true, skills: [] },
          { id: "wf-b", name: "Bakeriet på hjørnet", role: "producer", categories: [], isVerified: false, skills: [] },
          { id: "wf-c", name: "Fjordfisk", role: "producer", categories: ["fish", "smoked-goods"], location: { city: "Bergen" }, isVerified: false, skills: [] },
        ];
        const card = (id: string, name: string, city: string, cats: string, verified: boolean) =>
          `<div class="agent-card" data-id="${id}"><div class="agent-header"><div><div class="agent-name">${name}</div><div class="agent-city">${city}</div></div>` +
          (verified ? "<span class=\"verified-badge\">Verifisert av eier</span>" : "") +
          `</div><div class="agent-categories">${cats}</div><div class="agent-card-footer">Vis detaljer &rarr;</div></div>`;
        const tag = (t: string) => `<span class="category-tag">${t}</span>`;
        const expectedCards = (cityA: string, cityC: string) => [
          card("wf-a", "Gård Ås", cityA, tag("Grønnsaker") + tag("Honning") + tag("Egg"), true),
          card("wf-b", "Bakeriet på hjørnet", "Norge", "", false),
          card("wf-c", "Fjordfisk", cityC, tag("Fisk") + tag("smoked-goods"), false),
        ].join("");
        for (const [name, script] of pages) {
          const page = await loadedPage(script, async (url) => url === "/api/marketplace/agents" ? jsonResponse({ agents: wellFormed }) : jsonResponse({}));
          assertEq(page.el("agentsGrid").innerHTML, expectedCards("Ås", "Bergen"), `c ${name}: the cards are byte-identical to main's`);
        }
        {
          const results = wellFormed.map((a, i) => ({ agent: { ...a, location: { ...(a.location ?? {}), distanceKm: [0.4, 2, 12.345][i] } } }));
          const page = await loadedPage(appScript, async (url) => url === "/api/marketplace/agents" ? jsonResponse({ agents: wellFormed })
            : url.startsWith("/api/marketplace/search") ? jsonResponse({ results }) : jsonResponse({}));
          page.el("searchInput").value = "gård";
          page.el("searchInput").dispatch("keypress", { key: "Enter" });
          await settle();
          assertEq(page.el("agentsGrid").innerHTML, expectedCards("Ås · 400 m", "Bergen · 12.3 km").replace("<div class=\"agent-city\">Norge</div>", "<div class=\"agent-city\">Norge · 2.0 km</div>"),
            "c app search: the cards with distances are byte-identical to main's");
        }
        {
          const page = await loadedPage(dashScript, async (url) => url === "/api/marketplace/agents" ? jsonResponse({ agents: wellFormed }) : jsonResponse({}));
          page.context.filteredAgents = page.context.allAgents.map((a: any, i: number) => ({ ...a, _distanceKm: [0.4, 99999, 12.345][i] }));
          page.context.renderAgents();
          assertEq(page.el("agentsGrid").innerHTML, expectedCards("Ås &middot; 400 m", "Bergen &middot; 12.3 km"), "c dashboard nearby: the cards with distances are byte-identical to main's");
        }
        const item = (query: string, label: string, type: string, typeLabel: string, id?: string) =>
          `<div class="suggestion-item" data-query="${query}"${id ? ` data-id="${id}"` : ""}><span>${label}</span><span class="suggestion-type ${type}">${typeLabel}</span></div>`;
        assertEq(await suggestions("fi", wellFormed), item("fisk", "🐟 Fisk og sjømat", "cat", "Kategori") + item("Fjordfisk", "Fjordfisk", "agent", "Produsent", "wf-c"),
          "c dashboard suggestions: a category and a producer, byte-identical to main's");
        assertEq(await suggestions("ås", wellFormed), item("Ås", "📍 Ås", "city", "Sted") + item("Gård Ås", "Gård Ås", "agent", "Produsent", "wf-a"),
          "c dashboard suggestions: a city and a producer, byte-identical to main's");
        assertEq(await suggestions("er", wellFormed), item("grønnsaker", "🥬 Grønnsaker", "cat", "Kategori") + item("meieri", "🧀 Meieri og ost", "cat", "Kategori") +
          item("urter", "🌿 Urter og krydder", "cat", "Kategori") + item("preserves", "🫙 Preserves og syltetøy", "cat", "Kategori") +
          item("Bergen", "📍 Bergen", "city", "Sted") + item("Bakeriet på hjørnet", "Bakeriet på hjørnet", "agent", "Produsent", "wf-b"),
          "c dashboard suggestions: categories, a city and a producer, byte-identical to main's");

        // A name with & or ' (well-formed, but escaped now): the same text.
        const special = [{ id: "wf-s", name: "Ola's Gård & Bakeri", role: "producer", categories: ["bread"], location: { city: "Hå" }, isVerified: false, skills: [] }];
        for (const [name, script] of pages) {
          const page = await loadedPage(script, async (url) => url === "/api/marketplace/agents" ? jsonResponse({ agents: special }) : jsonResponse({}));
          const html = page.el("agentsGrid").innerHTML;
          assertTrue(html.includes("<div class=\"agent-name\">Ola&#39;s Gård &amp; Bakeri</div>") && visibleText(html).includes("Ola's Gård & Bakeri"),
            `c ${name}: a name with ' and & is escaped and shows the same text`);
        }
        const s = await suggestions("ola", special);
        assertEq(attrsOf(s, "suggestion-item").map((a) => a["data-query"]), ["Ola's Gård & Bakeri"], "c dashboard suggestions: data-query gives back a name with ' and &");
        // A stored entity (scraped text, escaped twice): main's data-query
        // escaped only ", so the browser decoded it and the search ran for
        // "Smør & brød" instead of the stored name.
        const entity = [{ id: "wf-e", name: "Smør &amp; brød", role: "producer", categories: [], location: { city: "Os" }, isVerified: false, skills: [] }];
        const e = await suggestions("smør", entity);
        assertEq(attrsOf(e, "suggestion-item").map((a) => a["data-query"]), ["Smør &amp; brød"], "c dashboard suggestions: data-query gives back a stored entity as it is");
        assertTrue(visibleText(e).includes("Smør &amp; brød"), "c dashboard suggestions: a stored entity is shown as the text it is");
      }
    });

    // ══ (d) admin.html: the alert after a delete ═════════════════════════
    await section("d admin", async () => {
      const deletes: string[] = [];
      let deleteBody: unknown = { success: true };
      const adminFetch: FetchStub = async (url, o) => {
        if (o?.method === "DELETE") { deletes.push(url); return jsonResponse(deleteBody); }
        return routeFetch()(url, o);
      };
      const page = runPage(adminScript, adminFetch, { pathname: "/admin" });
      page.el("adminKey").value = "test-key";
      page.el("btnLogin").click();
      await settle();
      const tbody = page.el("agentTableBody");
      assertEq(tbody.children.length, seeded.length, "d admin: the table lists the agents from GET /agents");
      assertEq(injectionProblems(tbody.innerHTML, new Set(["tr", "td", "div", "span", "input", "button"]), []), [],
        "d admin: the table has only its own tags (the name was escaped already; the id cell is now too)");
      /** Clicks «Slett» on the row of `id` (the rows follow the page's agent list). */
      async function clickDelete(id: string): Promise<void> {
        const row = tbody.children[(page.context.agents as Array<{ id: string }>).findIndex((a) => a.id === id)];
        if (!row) throw new Error(`admin: no row for ${id}`);
        row.children[5]!.children[0]!.click();
        await settle();
      }
      const alert = page.el("adminAlert");
      for (const [i, p] of PAYLOADS.entries()) {
        await clickDelete(`ik-${i}`);
        assertEq(alert.innerHTML, `<div class="alert alert-success">«${serializeText(`Navn ${p}`)}» slettet.</div>`,
          `d admin: deleting «Navn ${p}» shows the name as text in the alert`);
        assertEq(injectionProblems(alert.innerHTML, new Set(["div"]), []), [], `d admin: the alert for ${JSON.stringify(p)} has only its own div`);
        assertEq(alert.textContent, `«Navn ${p}» slettet.`, `d admin: the alert reads «Navn ${p}» slettet.`);
      }
      assertEq(deletes.length, PAYLOADS.length, "d admin: one DELETE per click");
      deleteBody = { success: false, error: "Agent ikke funnet" };
      await clickDelete(`ik-id${BREAK_DQ}`);
      assertEq(alert.innerHTML, "<div class=\"alert alert-error\">Feil: Agent ikke funnet</div>", "d admin: a plain error message gives main's HTML");
      page.runTimers(5000);
      assertEq(alert.innerHTML, "", "d admin: the alert still clears after 5 s");
    });

    // ══ (e) selger.html: escHtml and the match list ══════════════════════
    await section("e selger", async () => {
      {
        const page = runPage(selgerScript, routeFetch(), { pathname: "/selger" });
        const escHtml = page.context.escHtml as (s: unknown) => string;
        assertEq(
          ["Gård Ås", "A & B <c>", "Ola\u00a0Hansen", "", null, undefined].map((v) => escHtml(v)),
          ["Gård Ås", "A &amp; B &lt;c&gt;", "Ola&nbsp;Hansen", "", "", ""],
          "e escHtml: text without quotes comes out as before (the serializer's & < > and no-break space)");
        assertEq(escHtml("\"Ola's\" <gård>"), "&quot;Ola&#39;s&quot; &lt;gård&gt;", "e escHtml: \" and ' are escaped too");
        assertEq(decode(escHtml("\"Ola's\" & <gård>")), "\"Ola's\" & <gård>", "e escHtml: as text it reads the same");
      }
      {
        // /selger?agent=<name> fills the search and runs it (the legacy path).
        const target = seeded[1]!;
        const page = runPage(selgerScript, routeFetch(), { pathname: "/selger", search: `?agent=${encodeURIComponent(target.name)}` });
        await settle();
        const html = page.el("findMatchList").innerHTML;
        const matched = call(findMatchHandler, { name: target.name, city: "" }).body.matches as Array<{ id: string; name: string }>;
        assertTrue(matched.some((m) => m.id === target.id), "e fixture: /find-match returns the agent of /selger?agent=<name>");
        checkMatchList(html, "e selger ?agent=<name>", matched.map((m) => m.name));
        assertTrue(visibleText(html).includes(target.name) && visibleText(html).includes(target.city), "e selger ?agent=<name>: the name and city are shown as text");
      }
      {
        const page = runPage(selgerScript, routeFetch(), { pathname: "/selger" });
        page.el("findName").value = "Navn";
        page.el("btnFind").click();
        await settle();
        const html = page.el("findMatchList").innerHTML;
        const matched = call(findMatchHandler, { name: "Navn", city: "" }).body.matches as Array<{ name: string }>;
        assertTrue(matched.length >= PAYLOADS.length, `e fixture: /find-match «Navn» returns the seeded agents (${matched.length})`);
        checkMatchList(html, "e selger search «Navn»", matched.map((m) => m.name));
        const text = visibleText(html);
        for (const p of PAYLOADS) {
          assertTrue(text.includes(`Navn ${p}`) && text.includes(`Sted ${p}`) && text.includes(`Kat ${p}`), `e selger search: name, city and category ${JSON.stringify(p)} are shown as text`);
        }
      }
      {
        const matches = [
          { id: "m1", name: "Gård Ås", city: "Ås", description: "Grønnsaker fra gården", categories: ["vegetables", "honey"], isVerified: false, isClaimed: false, similarity: 92 },
          { id: "m2", name: "Fjordfisk", city: "Bergen", description: "", categories: [], isVerified: true, isClaimed: false, similarity: 80 },
          { id: "m3", name: "Eid gård", city: null, description: "", categories: [], isVerified: false, isClaimed: true, similarity: 70 },
        ];
        const page = runPage(selgerScript, async (url) => url.includes("/find-match") ? jsonResponse({ success: true, matches }) : jsonResponse({}, 404), { pathname: "/selger" });
        page.el("findName").value = "gård";
        page.el("btnFind").click();
        await settle();
        const row = (name: string, badge: string, place: string, description: string, claim: string) =>
          "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:1rem;background:var(--gray-50);border-radius:12px;margin-bottom:0.5rem;border:1px solid var(--gray-200);\">" +
          `<div><strong>${name}</strong> ${badge}<br><span style="color:var(--gray-500);font-size:0.85rem;">${place}</span>${description}</div>` +
          `<div style="flex-shrink:0;margin-left:1rem;">${claim}</div></div>`;
        const claimButton = (id: string, name: string) =>
          `<button class="btn btn-primary" style="padding:6px 16px;font-size:0.85rem;" data-claim-id="${id}" data-claim-name="${name}">Dette er min butikk</button>`;
        const expected =
          "<p style=\"font-weight:600;margin-bottom:0.75rem;color:var(--forest);\">Vi fant 3 mulige treff:</p>" +
          row("Gård Ås", "<span style=\"background:var(--accent);color:white;padding:2px 8px;border-radius:12px;font-size:0.75rem;\">92% match</span>",
            "Ås — vegetables, honey", "<br><span style=\"color:var(--gray-400);font-size:0.8rem;\">Grønnsaker fra gården</span>", claimButton("m1", "Gård Ås")) +
          row("Fjordfisk", "<span style=\"background:var(--forest);color:white;padding:2px 8px;border-radius:12px;font-size:0.75rem;\">Verifisert av eier</span>",
            "Bergen", "", claimButton("m2", "Fjordfisk")) +
          row("Eid gård", "<span style=\"background:#e74c3c;color:white;padding:2px 8px;border-radius:12px;font-size:0.75rem;\">Eid</span>",
            "", "", "<span style=\"color:var(--gray-500);font-size:0.85rem;\">Denne er allerede eid av noen</span>") +
          "<div style=\"text-align:center;margin-top:1rem;padding:1rem;background:var(--gray-50);border-radius:12px;border:1px dashed var(--gray-300);\">" +
          "<p style=\"color:var(--gray-500);font-size:0.9rem;margin-bottom:0.5rem;\">Finner du ikke butikken din?</p>" +
          "<button class=\"btn btn-secondary\" id=\"btnShowRegFormFromMatches\" style=\"font-size:0.9rem;\">Registrer ny agent</button></div>";
        assertEq(page.el("findMatchList").innerHTML, expected, "e selger: well-formed matches are byte-identical to main's");
      }
    });

    // ══ (f) the modal: S1 and S2 ═════════════════════════════════════════
    await section("f modal", async () => {
      for (const [name, script] of pages) {
        const odd = await modal(script, { ...base, role: { r: 1 }, categories: [{ id: 1 }, "vegetables", null], description: "Beskrivelse", skills: [{}, null] }, {
          agent: {}, meta: {},
          knowledge: { about: { text: "objekt" }, certifications: [{ id: 1 }, null], deliveryOptions: [{ id: 2 }, "Henting"], paymentMethods: [], specialties: [5] },
        });
        assertEq(odd.badges, "<span class=\"modal-badge\">producer</span><span class=\"modal-badge\">Grønnsaker</span>",
          `f ${name}: a role that is not text reads "producer", and a category that is not text gives no badge (S1)`);
        assertTrue(!odd.body.includes("<span class=\"modal-tag cert\"></span>") && !odd.body.includes("Sertifiseringer"),
          `f ${name}: certifications with no text give no empty tag and no section (S1)`);
        assertTrue(odd.body.includes("<div class=\"modal-section-title\">Levering</div><div class=\"modal-tags\"><span class=\"modal-tag \">Henting</span></div>"),
          `f ${name}: the text value beside a non-text one is kept (S1)`);
        assertTrue(odd.body.includes("<span class=\"modal-tag \">5</span>"), `f ${name}: a number is shown as before`);
        assertTrue(!odd.body.includes("A2A Capabilities"), `f ${name}: skills with no name or id give no section (S1)`);
        assertTrue(odd.body.includes("<div class=\"modal-about\">Beskrivelse</div>"), `f ${name}: «Om» falls back to the description when about is not text (S2)`);
        assertEq(junk(odd.badges + odd.body), [], `f ${name}: no junk text`);

        const textAbout = await modal(script, { ...base, description: "Beskrivelse" }, { agent: {}, meta: {}, knowledge: { about: "Om gården" } });
        assertTrue(textAbout.body.includes("<div class=\"modal-about\">Om gården</div>"), `f ${name}: «Om» is about when it is text (as before)`);
        const noAbout = await modal(script, { ...base, description: { d: 1 } }, { agent: {}, meta: {}, knowledge: { about: 7 } });
        assertTrue(!noAbout.body.includes("modal-about"), `f ${name}: no text in about or description gives no «Om» section`);

        const basic = await modal(script, { ...base, categories: [{}, "honey"], tags: [null, "lokal"], description: { d: 1 }, role: 5 }, null);
        assertTrue(basic.body.includes("<div class=\"modal-tags\"><span class=\"modal-tag\">Honning</span><span class=\"modal-tag\">lokal</span></div>"),
          `f ${name} basic modal: only the categories and tags with text (S1)`);
        assertTrue(!basic.body.includes("modal-about"), `f ${name} basic modal: a description that is not text gives no «Om» section (S2)`);
        assertTrue(basic.body.includes("<div class=\"modal-info-value\">5</div>"), `f ${name} basic modal: a number role is shown as before`);
        const bare = await modal(script, { ...base, categories: [{}], tags: [] }, null);
        assertTrue(!bare.body.includes("Kategorier"), `f ${name} basic modal: no category or tag with text gives no section (S1)`);
      }
    });

    // ══ (g) wrong-typed values ═══════════════════════════════════════════
    await section("g wrong-typed", async () => {
      for (const [name, script] of pages) {
        const odd = [
          { id: "o1", name: "Streng", categories: "honey", location: { city: "Oslo" } },
          { id: "o2", name: "Tall", categories: 5, location: { city: { c: 1 } } },
          { id: "o3", name: "Objekt", categories: { a: 1 } },
          { id: "o4", name: "Proto", categories: ["constructor", "__proto__", "toString", "honey"] },
          { id: "o5", name: "Blandet", categories: [{ id: 1 }, "honey", null] },
        ];
        const page = await loadedPage(script, async (url) => url === "/api/marketplace/agents" ? jsonResponse({ agents: odd }) : jsonResponse({}));
        const html = page.el("agentsGrid").innerHTML;
        assertEq(attrsOf(html, "agent-card").map((a) => a["data-id"]), ["o1", "o2", "o3", "o4", "o5"], `g ${name}: categories that are not a list no longer break the grid (main: "Feil ved lasting")`);
        assertTrue(html.includes(`<div class="agent-categories"><span class="category-tag">constructor</span><span class="category-tag">__proto__</span><span class="category-tag">toString</span></div>`),
          `g ${name}: "constructor", "__proto__" and "toString" are shown as the text they are`);
        assertTrue(html.includes("<div class=\"agent-categories\"><span class=\"category-tag\">Honning</span></div>") && !html.includes("<span class=\"category-tag\"></span>"),
          `g ${name}: a category that is not text gives no empty tag on the card`);
        assertTrue(html.includes("<div class=\"agent-name\">Tall</div><div class=\"agent-city\">Norge</div>"), `g ${name}: a city that is not text reads "Norge"`);
        assertEq(junk(html), [], `g ${name}: no junk text`);
        assertTrue(!/function |native code/.test(html), `g ${name}: no function source as a category`);
        const { badges } = await modal(script, { ...odd[0]!, role: "producer", skills: [] }, null);
        assertEq(badges, "<span class=\"modal-badge\">producer</span>", `g ${name}: the modal header takes categories that are not a list too`);
        assertEq(["honey", "constructor", "__proto__", 7, null].map((v) => page.context.formatCategory(v)), ["Honning", "constructor", "__proto__", 7, null],
          `g ${name}: formatCategory() maps only the table's own keys`);
      }
    });
  } catch (err: any) {
    failed++;
    failures.push("rfb-escaping-kort-forslag-admin-selger: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = origLog;
    if (prevDb) __setDbForTesting(prevDb as any);
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbEscapingKortForslagAdminSelgerTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

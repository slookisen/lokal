/**
 * bestillinger-b2b2.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-start-
 * til-slutt-for-eier, slice B2b-2 («myk utløp»: the surfaces and the agents),
 * acceptance criterion 13.
 *
 * A producer_dashboard 'in_stock' row confirmed 20 days ago, flag
 * STOCK_SOFT_EXPIRY_ENABLED on, producer on the owner-features allowlist:
 *
 *   page-*     /produsent/:slug — the product shows the buyer text with the
 *              date and data-stock-confirmed-at / data-needs-producer-
 *              confirmation; the JSON-LD node states the date (description).
 *   offers-*   lokal_find_offers — stock_confirmed_at, needs_producer_
 *              confirmation and stock_note (the buyer text) per offer.
 *   search-*   lokal_search (detailed view) — the product line carries both
 *              fields and the buyer text.
 *   rest-*     GET /api/marketplace/catalog/offers and /agents/:id/products.
 *   a2a-*      agent/info — the product carries both fields and stock_note.
 *   feed-*     GET /feed (JSON) carries both fields with availability
 *              'in_stock'; /acp-feed.csv keeps the 12 ACP columns and the
 *              'in_stock' enum and states the date in `description`.
 *   off-*      flag off, or the producer off the allowlist → every surface
 *              byte-identical to the flag-off baseline.
 *
 * Fresh in-memory SQLite with the production schema; route handlers and MCP
 * tool handlers are called in-process (the owner-features-s2c harness).
 * Standalone: npx tsx src/routes/bestillinger-b2b2.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

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

const DAY = 86_400_000;
const ENV_KEYS = [
  "STOCK_SOFT_EXPIRY_ENABLED", "SUPPLY_GRAPH_STALE_DAYS", "SUPPLY_GRAPH_HARD_STALE_DAYS",
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_FEATURES_ENFORCE", "HANDLELISTE_ENABLED",
];

const TP = "b2b2-test-producer"; // on the allowlist
const OTHER = "b2b2-other-producer"; // never on the allowlist
const NAMES: Record<string, string> = {
  [TP]: "Lagerprove Gard Eier",
  [OTHER]: "Lagerprove Gard Annen",
};
const PRODUCT = "Listepoteter";
const BUYER_TEXT_RE = /Sist bekreftet av produsenten (\d{2}\.\d{2}\.\d{4})\. Produsenten bekrefter at varen er på lager før bestillingen gjelder\./;

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** dd.mm.yyyy of an instant in Oslo time, computed independently of the code under test. */
function osloDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

function seedProducer(db: Database.Database, id: string, confirmedAt: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, address, postal_code, about, products, verification_status, verified_second_line,
        enrichment_status, url_last_status, url_last_probed, last_verified_at)
     VALUES (?, ?, ?, 'Gardsvegen 12', '0150', ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([{ name: PRODUCT, price: "30 kr/kg", category: "vegetables" }]),
  );
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, description, unit, price_nok, availability, category, image_url,
                           availability_source, availability_updated_at)
     VALUES (?, ?, ?, ?, 'Nye poteter fra gården.', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg',
             'producer_dashboard', ?)`,
  ).run(`prod-${id}`, id, PRODUCT, PRODUCT.toLowerCase(), confirmedAt);
}

export async function runBestillingerB2b2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; query?: Record<string, string>; body?: any; lang?: string }): any {
    const headers: Record<string, string> = {};
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        locals: {},
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header(k: string, v: string) { headers[String(k).toLowerCase()] = String(v); return res; },
        set() { return res; }, type() { return res; },
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

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    for (const k of ENV_KEYS) delete process.env[k];
    clearRegistryCaches();

    for (const m of ["./marketplace-catalog", "./seo", "./mcp", "./a2a"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const seoRouter = (require("./seo") as typeof import("./seo")).default as any;
    const a2aRouter = require("./a2a").default as any;
    const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args, {}))?.content?.[0]?.text ?? "");

    const H = {
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      products: findRouteHandler(catalogRouter, "/agents/:id/products", "get"),
      offers: findRouteHandler(catalogRouter, "/offers", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
    };

    // ── Fixture: both rows confirmed 20 days ago ─────────────────────────────
    const confirmedSql = sqlTs(new Date(Date.now() - 20 * DAY));
    const confirmedIso = new Date(confirmedSql.replace(" ", "T") + "Z").toISOString();
    const confirmedDate = osloDate(confirmedIso);
    seedProducer(db, TP, confirmedSql);
    seedProducer(db, OTHER, confirmedSql);
    clearRegistryCaches();

    // ── Surface readers ──────────────────────────────────────────────────────
    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const page = async (id: string, lang = "no") =>
      String((await invoke(H.produsent, makeReq({ params: { slug: slugify(NAMES[id]) }, lang }))).body ?? "");
    const jsonLdNodes = (html: string) => {
      const found: any[] = [];
      const walk = (x: any) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          if ((x["@type"] === "Offer" || x["@type"] === "Thing") && x.name === PRODUCT) found.push(x);
          Object.values(x).forEach(walk);
        }
      };
      for (const m of html.matchAll(LD_RE)) { try { walk(JSON.parse(m[1])); } catch { /* not JSON */ } }
      return found;
    };
    const findOffersText = () => toolText("lokal_find_offers", { items: ["listepoteter"], lat: 59.9139, lng: 10.7522 });
    const findOffer = async (id: string) => {
      const parsed = JSON.parse(await findOffersText());
      return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((x: any) => x?.offers ?? []).find((o: any) => o?.producer?.agent_id === id);
    };
    const lokalSearch = (id: string) => toolText("lokal_search", { query: NAMES[id] });
    const productLine = (text: string) => text.split("\n").find((l) => l.startsWith(`- ${PRODUCT}`)) ?? "";
    const restOffers = async () => (await invoke(H.offers, makeReq({ query: { q: "listepoteter", lat: "59.9139", lng: "10.7522" } }))).body;
    const restOffer = async (id: string) => ((await restOffers())?.offers ?? []).find((o: any) => o?.producer?.agent_id === id);
    const restProducts = async (id: string) => (await invoke(H.products, makeReq({ params: { id } }))).body;
    const a2aInfo = async (id: string) =>
      (await invoke(H.a2a, makeReq({ body: { jsonrpc: "2.0", method: "agent/info", params: { agentId: id }, id: 1 } }))).body;
    const a2aProduct = async (id: string) => {
      const art = (await a2aInfo(id))?.result?.artifacts?.[0];
      const data = art?.parts?.find((p: any) => p?.data)?.data;
      return (data?.knowledge?.products ?? []).find((p: any) => p?.name === PRODUCT);
    };
    const feed = async () => (await invoke(H.feed, makeReq({}))).body;
    const feedItem = async (id: string) => ((await feed())?.items ?? []).find((i: any) => i?.seller?.agent_id === id);
    const acpCsv = async () => String((await invoke(H.acp, makeReq({}))).body ?? "");
    const ACP_HEADER = "item_id,title,description,brand,url,image_url,price,availability,is_eligible_search,is_eligible_checkout,target_countries,product_category";
    /** Minimal RFC4180 parse (quoted fields, doubled quotes). */
    const parseCsv = (text: string): string[][] => {
      const rows: string[][] = [];
      let row: string[] = [];
      let field = "";
      let q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
          if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
          else if (c === '"') q = false;
          else field += c;
        } else if (c === '"') q = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
        else field += c;
      }
      if (field || row.length) { row.push(field); rows.push(row); }
      return rows;
    };
    const acpRow = async (id: string) => parseCsv(await acpCsv()).find((r) => r[0] === `prod-${id}`);

    /** Every surface's output for one producer, as text (the byte-identity snapshot). */
    const snapshot = async (id: string) => {
      const html = await page(id);
      return {
        page: html,
        pageEn: await page(id, "en"),
        find_offers: JSON.stringify((JSON.parse(await findOffersText()) as any[]).map((r) => ({ ...r, offers: r.offers.filter((o: any) => o.producer.agent_id === id) }))),
        search: await lokalSearch(id),
        rest_offer: JSON.stringify(await restOffer(id)),
        rest_products: JSON.stringify(await restProducts(id)),
        // The task status carries the time of the call; the artifacts are the answer.
        a2a: JSON.stringify((await a2aInfo(id))?.result?.artifacts),
        feed: JSON.stringify(await feedItem(id)),
        acp: JSON.stringify(await acpRow(id)),
        acp_header: (await acpCsv()).split("\r\n")[0],
      };
    };
    // The page and lokal_search echo nothing time-dependent within a run;
    // two flag-off snapshots must already agree, or the identity checks
    // below would prove nothing.
    const setAllow = (ids: string[]) => {
      if (ids.length) process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ids.map((x) => `rfb:${x}`).join(",");
      else delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
    };

    // ════════════════════════════════════════════════════════════════════════
    // Baseline: flag off (default), producer on the list
    // ════════════════════════════════════════════════════════════════════════
    setAllow([TP]);
    const baseTP = await snapshot(TP);
    const baseOther = await snapshot(OTHER);
    {
      const again = await snapshot(TP);
      for (const k of Object.keys(baseTP) as Array<keyof typeof baseTP>) {
        assertEq(again[k] === baseTP[k], true, `off-0: the flag-off ${k} output is stable between two reads (identity checks are meaningful)`);
      }
      assertTrue(baseTP.page.includes(PRODUCT) && !baseTP.page.includes("data-stock-confirmed-at"), "off-0b: flag off → the page lists the product, no confirmation date");
      assertTrue(!BUYER_TEXT_RE.test(baseTP.search) && baseTP.search.includes(`- ${PRODUCT}`), "off-0c: flag off → lokal_search lists the product, no buyer text");
      assertEq((await feedItem(TP))?.availability, "unknown", "off-0d: flag off → the 20-day row is 'unknown' in the feed, as today");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC13 — flag on, producer on the allowlist, row confirmed 20 days ago
    // ════════════════════════════════════════════════════════════════════════
    process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
    setAllow([TP]);

    // ── Producer page (HTML + JSON-LD) ──────────────────────────────────────
    {
      const html = await page(TP);
      const visible = html.replace(LD_RE, "");
      assertTrue(visible.includes(`data-stock-confirmed-at="${confirmedIso}"`), "page-1: the product carries data-stock-confirmed-at = the confirmation time");
      assertTrue(visible.includes('data-needs-producer-confirmation="true"'), "page-2: … and data-needs-producer-confirmation=\"true\"");
      const m = visible.match(BUYER_TEXT_RE);
      assertEq(m?.[1], confirmedDate, "page-3: the visible buyer text states the date (Oslo time)");
      const nodes = jsonLdNodes(html);
      assertEq(nodes.length, 1, "page-4: one JSON-LD node for the product");
      assertEq(nodes[0]?.["@type"], "Offer", "page-5: … still the plain Offer (no Product node, rule 7)");
      assertEq(String(nodes[0]?.description ?? "").match(BUYER_TEXT_RE)?.[1], confirmedDate, "page-6: … whose description states the date and the producer's confirmation");
      assertTrue(!("availability" in (nodes[0] ?? {})) || String(nodes[0].availability).startsWith("https://schema.org/"),
        "page-7: … any availability stays a schema.org value");
      for (const m2 of html.matchAll(LD_RE)) {
        let ok = true;
        try { JSON.parse(m2[1]); } catch { ok = false; }
        assertTrue(ok, "page-8: every JSON-LD block still parses");
      }
      const en = await page(TP, "en");
      assertTrue(en.includes(`Last confirmed by the producer ${confirmedDate}. The producer confirms that the item is in stock before the order applies.`),
        "page-9: /en page: the English buyer text with the date");
    }

    // ── lokal_find_offers ───────────────────────────────────────────────────
    {
      const o = await findOffer(TP);
      assertEq(o?.availability, "in_stock", "offers-1: lokal_find_offers: the 20-day row is in_stock");
      assertEq(o?.stock_confirmed_at, confirmedIso, "offers-2: … stock_confirmed_at = the confirmation time");
      assertEq(o?.needs_producer_confirmation, true, "offers-3: … needs_producer_confirmation: true");
      assertEq(String(o?.stock_note ?? "").match(BUYER_TEXT_RE)?.[1], confirmedDate, "offers-4: … stock_note: the buyer text with the date");
      assertEq(Object.keys(o ?? {}).slice(-2), ["stock_note", "producer"], "offers-5: … stock_note sits right before producer");
    }

    // ── lokal_search (detailed view of a producer-name search) ─────────────
    {
      const line = productLine(await lokalSearch(TP));
      assertTrue(line.includes("· availability: in_stock"), "search-1: lokal_search: the product line says in_stock");
      assertTrue(line.includes(`· stock_confirmed_at: ${confirmedIso}`), "search-2: … stock_confirmed_at");
      assertTrue(line.includes("· needs_producer_confirmation: true"), "search-3: … needs_producer_confirmation: true");
      assertEq(line.match(BUYER_TEXT_RE)?.[1], confirmedDate, "search-4: … and the buyer text with the date");
      const info = productLine(await toolText("lokal_info", { agentId: TP }));
      assertTrue(info.includes(`· stock_confirmed_at: ${confirmedIso}`) && BUYER_TEXT_RE.test(info), "search-5: lokal_info's product line carries the same");
    }

    // ── REST ────────────────────────────────────────────────────────────────
    {
      const o = await restOffer(TP);
      assertEq([o?.availability, o?.stock_confirmed_at, o?.needs_producer_confirmation], ["in_stock", confirmedIso, true],
        "rest-1: GET /offers: in_stock, stock_confirmed_at, needs_producer_confirmation");
      const p = (await restProducts(TP))?.products?.[0];
      assertEq([p?.availability, p?.stock_confirmed_at, p?.needs_producer_confirmation], ["in_stock", confirmedIso, true],
        "rest-2: GET /agents/:id/products: in_stock, stock_confirmed_at, needs_producer_confirmation");
    }

    // ── A2A ─────────────────────────────────────────────────────────────────
    {
      const p = await a2aProduct(TP);
      assertEq([p?.stock_confirmed_at, p?.needs_producer_confirmation], [confirmedIso, true], "a2a-1: agent/info: the product carries stock_confirmed_at and needs_producer_confirmation");
      assertEq(String(p?.stock_note ?? "").match(BUYER_TEXT_RE)?.[1], confirmedDate, "a2a-2: … and stock_note with the date");
      assertEq(p?.price, "30 kr/kg", "a2a-3: … the product's own fields are kept");
    }

    // ── Feeds ───────────────────────────────────────────────────────────────
    {
      const it = await feedItem(TP);
      assertEq([it?.availability, it?.stock_confirmed_at, it?.needs_producer_confirmation], ["in_stock", confirmedIso, true],
        "feed-1: GET /feed: in_stock, stock_confirmed_at, needs_producer_confirmation");
      const csv = await acpCsv();
      const rows = parseCsv(csv);
      assertEq(rows[0]?.join(","), ACP_HEADER, "feed-2: ACP CSV header is still exactly the 12 ACP columns");
      assertTrue(rows.slice(1).every((r) => r.length === 12), "feed-3: … every data row has 12 fields");
      assertTrue(rows.slice(1).every((r) => ["in_stock", "out_of_stock", "preorder"].includes(r[7]) || r[7] === "unknown"),
        "feed-4: … availability is an enum value");
      const r = rows.find((x) => x[0] === `prod-${TP}`);
      assertEq(r?.[7], "in_stock", "feed-5: … the soft-window row is in_stock (valid ACP enum)");
      assertEq(r?.[2].match(BUYER_TEXT_RE)?.[1], confirmedDate, "feed-6: … its description states the date and the producer's confirmation");
      assertTrue(!!r && r[2].startsWith("Nye poteter fra gården. ") && r[2].length <= 5000, "feed-7: … after the producer's own text, within 5000 characters");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Identity: a producer off the list (flag on), then the flag off again
    // ════════════════════════════════════════════════════════════════════════
    {
      const other = await snapshot(OTHER);
      for (const k of Object.keys(baseOther) as Array<keyof typeof baseOther>) {
        assertEq(other[k] === baseOther[k], true, `off-1: flag on, producer NOT on the allowlist → ${k} byte-identical to flag off`);
      }
      setAllow([]);
      const none = await snapshot(TP);
      for (const k of Object.keys(baseTP) as Array<keyof typeof baseTP>) {
        assertEq(none[k] === baseTP[k], true, `off-2: flag on, empty allowlist → ${k} byte-identical to flag off`);
      }
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      setAllow([TP]);
      const off = await snapshot(TP);
      for (const k of Object.keys(baseTP) as Array<keyof typeof baseTP>) {
        assertEq(off[k] === baseTP[k], true, `off-3: flag off again → ${k} byte-identical to the baseline`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { cartSvc.__setCartTestDb(null); } catch { /* ignore */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBestillingerB2b2Tests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nbestillinger-b2b2: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

/**
 * owner-items-t13-v1b.test.ts — dev-request 2026-10-30-rfb-eierportal-
 * testrunde-1, slice T13 V1b (punkt 7: «Merk som utsolgt», kategori,
 * lagervalg, ferdigpakket).
 *
 *   so-*     «Merk som utsolgt»: the existing write path (supply-graph
 *            setProducerAvailabilityByProductId → 'out_of_stock'), the row
 *            becomes unorderable at the gate; only the claimant's own,
 *            producer-stated, stock-describable row; another producer's id →
 *            rejected, nothing written; the row message, group, chip, line and
 *            «På lager igjen»; «På lager igjen» restores through …/bekreft.
 *   form-*   «Legg til vare»: a closed <details>, the spec's labels, «Varen er
 *            på lager nå» ticked by default, not ticked with
 *            orders.auto_confirm on; «Kunder kan bestille varen med en gang.»
 *            only with orders on.
 *   add-*    POST /varer/ny with the V1b form: ferdigpakket = ja without the
 *            food fields → refused, the form open again with the values, no
 *            insert; a valid ferdigpakket insert stores the fields; category
 *            stored; unticked → 'out_of_stock'; same name → refused, values kept.
 *   ro-*     a session that is not the claimant's: no «Merk som utsolgt», no
 *            add form; the write routes refuse.
 *   auth-*   CSRF (Origin), no session, another producer's session — as the
 *            existing routes.
 *   off-*    off the allowlist: the portal byte-identical to flag off; the new
 *            route 404s and writes nothing.
 *   get-*    no GET writes anything.
 *   cap-*    (V1a review) «Bekreft alle» reads at most 500 ids; uten_pris must
 *            be 1–5 digits.
 *
 * Real routers + services on the production schema in an in-memory DB.
 * Standalone: npx tsx src/routes/owner-items-t13-v1b.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

const SAVED_ENV = [
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "STOCK_SOFT_EXPIRY_ENABLED",
  "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED",
  "OWNER_FEATURES_ENFORCE", "SUPPLY_GRAPH_STALE_DAYS", "SUPPLY_GRAPH_HARD_STALE_DAYS", "PRODUCT_IMPORT_ENABLED",
];

const TP = "t13b-test-producer"; // allowlisted, eligible, orders on
const OFF = "t13b-orders-off";    // allowlisted, orders off
const OTHER = "t13b-other";       // another producer
const AUTO = "t13b-auto";         // allowlisted, orders on, orders.auto_confirm on
const DAY = 86_400_000;

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runOwnerItemsT13V1bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "POST", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    for (const m of ["./owner-portal", "./owner-items-card", "../services/owner-items-view", "../services/owner-orderability"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const cart = require("../services/cart-service") as typeof import("../services/cart-service");
    const oo = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
    const view = require("../services/owner-items-view") as typeof import("../services/owner-items-view");
    const card = require("./owner-items-card") as typeof import("./owner-items-card");
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const resolveMod = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const T = view.OWNER_ITEMS_TEXT_NB;
    const X = view.OWNER_ITEMS_INVENTED_TEXT_NB;

    // ─── Fixture ──────────────────────────────────────────────────────────
    const now = new Date();
    const ago = (d: number) => sqlTs(new Date(now.getTime() - d * DAY));
    function seedProducer(id: string, o: { optIn?: number } = {}): void {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent T13 V1b.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?)`,
      ).run(id, `T13b Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.optIn ?? 1);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten gård.', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
         VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
      ).run(`claim-${id}`, id, `post@${id}.example.no`);
    }
    function seedProduct(agentId: string, pid: string, p: { name: string; price?: number | null; availability: string; source: string; updated?: string | null }): void {
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
         VALUES (?, ?, ?, ?, ?, 'stk', ?, ?, ?)`,
      ).run(pid, agentId, p.name, p.name.toLowerCase(), p.price === undefined ? 30 : p.price, p.availability, p.source, p.updated ?? null);
    }
    for (const id of [TP, OTHER, AUTO]) seedProducer(id);
    seedProducer(OFF, { optIn: 0 });
    seedProduct(TP, "b-fresh", { name: "Gulrøtter", availability: "in_stock", source: "producer_dashboard", updated: ago(1) });
    seedProduct(TP, "b-fresh2", { name: "Grønnkål", availability: "in_stock", source: "producer_dashboard", updated: ago(2) });
    seedProduct(TP, "b-admin", { name: "Poteter", availability: "in_stock", source: "admin_producer_confirmed", updated: ago(3) });
    seedProduct(TP, "b-out", { name: "Purre", availability: "out_of_stock", source: "producer_dashboard", updated: ago(5) });
    seedProduct(TP, "b-scraped", { name: "Rødbeter", availability: "in_stock", source: "enrichment" });
    seedProduct(TP, "b-alcohol", { name: "Eplesider", availability: "in_stock", source: "producer_dashboard", updated: ago(1) });
    seedProduct(OTHER, "b-other-row", { name: "Egg", availability: "in_stock", source: "producer_dashboard", updated: ago(1) });

    const ROW_SQL = `SELECT id, agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE id = ?`;
    const rowOf = (pid: string) => db.prepare(ROW_SQL).get(pid) as any;
    const srcOf = (pid: string) => db.prepare("SELECT availability, availability_source AS s, availability_updated_at AS u FROM products WHERE id = ?").get(pid) as any;
    const snap = () => JSON.stringify(db.prepare("SELECT * FROM products ORDER BY id").all());
    const auditN = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n as number;

    setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", [TP, OFF, OTHER, AUTO].map((id) => `rfb:${id}`).join(","));

    // ═══ so-* — the service ═══════════════════════════════════════════════
    {
      assertEq(cart.isRowOrderableForRealOrder(db, rowOf("b-fresh2"), now), true, "so-0: the row is orderable before");
      const a0 = auditN();
      const r = oo.markOwnerProductSoldOut(TP, "b-fresh2", { db, actorEmail: "post@t13b" });
      assertEq(r, { ok: true, changed: true }, "so-1: «Merk som utsolgt» on an own in-stock row → ok");
      const s1 = srcOf("b-fresh2");
      assertEq([s1.availability, s1.s], ["out_of_stock", "producer_dashboard"], "so-2: availability 'out_of_stock', source producer_dashboard (the existing write path)");
      assertEq(cart.isRowOrderableForRealOrder(db, rowOf("b-fresh2"), now), false, "so-3: … and the real-order gate says no");
      assertEq(auditN(), a0 + 1, "so-4: one audit row");
      const before = snap();
      assertEq(oo.markOwnerProductSoldOut(TP, "b-other-row", { db }), { ok: false, error: "not_found" }, "so-5: another producer's id → not_found");
      assertEq(oo.markOwnerProductSoldOut(TP, "b-scraped", { db }), { ok: false, error: "not_markable" }, "so-6: a scraped row → not_markable");
      assertEq(oo.markOwnerProductSoldOut(TP, "b-alcohol", { db }), { ok: false, error: "not_markable" }, "so-7: alcohol → not_markable");
      assertEq(oo.markOwnerProductSoldOut(TP, "b-out", { db }), { ok: true, changed: false }, "so-8: already sold out → ok, unchanged");
      assertEq(snap(), before, "so-9: none of these wrote anything (the sold-out row keeps its date)");
      const ad = oo.markOwnerProductSoldOut(TP, "b-admin", { db });
      assertEq([ad, srcOf("b-admin").availability, srcOf("b-admin").s], [{ ok: true, changed: true }, "out_of_stock", "admin_producer_confirmed"], "so-10: an admin-confirmed row keeps its source, as the write path does");
      // Restore.
      db.prepare("UPDATE products SET availability = 'in_stock', availability_updated_at = ? WHERE id IN ('b-fresh2', 'b-admin')").run(ago(2));
    }

    // ═══ view: the sold-out row ═══════════════════════════════════════════
    {
      const model = view.readOwnerItems(TP, db, now);
      const ctx = { now, softExpiry: false, ordersOn: true, profileEligible: true, canEdit: true };
      const out = view.ownerItemView(model.rows.find((r) => r.id === "b-out")!, ctx);
      assertEq([out.group, out.chip, out.action, out.more], ["sold_out", "sold_out", "back_in_stock", []], "so-11: a sold-out row → «Utsolgt», chip «Utsolgt», «På lager igjen», no «Mer»");
      const scr = view.ownerItemView(model.rows.find((r) => r.id === "b-scraped")!, ctx);
      const alc = view.ownerItemView(model.rows.find((r) => r.id === "b-alcohol")!, ctx);
      assertEq([scr.more, alc.more], [[], []], "so-12: no «Merk som utsolgt» on a scraped or a not-here row");
      const ro = view.ownerItemView(model.rows.find((r) => r.id === "b-fresh")!, { ...ctx, canEdit: false });
      assertEq(ro.more, [], "so-13: no «Mer» without a writing session");
    }

    // ─── Sessions and the routes ──────────────────────────────────────────
    setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", "1");
    const tokens: Record<string, string> = {};
    const addToken = (tok: string, agentId: string, email: string) => {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${tok}`, email, tok, agentId, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    };
    for (const id of [TP, OFF, OTHER, AUTO]) { tokens[id] = `tok-${id}`; addToken(tokens[id], id, `post@${id}.example.no`); }
    addToken("tok-tp-other-mail", TP, "medhjelper@t13b.example.no");
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      sold: findRouteHandler(portalMod.default, "/eier/:agentId/varer/:productId/utsolgt", "post"),
      one: findRouteHandler(portalMod.default, "/eier/:agentId/varer/:productId/bekreft", "post"),
      all: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-alle", "post"),
      ny: findRouteHandler(portalMod.default, "/eier/:agentId/varer/ny", "post"),
    };
    const portal = async (id: string, query: Record<string, string> = {}, token: string | undefined = tokens[id]) =>
      String((await invoke(H.portal, makeReq({ params: { agentId: id }, query, token }))).body ?? "");
    const ORIGIN = { origin: "https://rettfrabonden.com" };
    const loc = (x: HandlerResult) => String(x.body?.__redirect ?? "");
    const cardOf = (html: string) => {
      const i = html.indexOf('id="bestillbare-varer"');
      if (i < 0) return "";
      const j = html.indexOf('<div class="ep-card"', i);
      return html.slice(i, j < 0 ? html.length : j);
    };
    const liOf = (html: string, pid: string) => (html.match(new RegExp(`<li [^>]*id="vare-${pid}"[\\s\\S]*?</li>`)) || [""])[0];
    const formOf = (html: string) => (html.match(/<details class="ep-items-add"[\s\S]*?<\/details>/) || [""])[0];

    // ═══ so-* — the routes ════════════════════════════════════════════════
    {
      const html = await portal(TP);
      const li = liOf(html, "b-fresh");
      assertTrue(li.includes(`action="/eier/${TP}/varer/b-fresh/utsolgt"`) && li.includes(">Merk som utsolgt</button>")
        && /<details class="ep-item-more"[\s\S]*Merk som utsolgt[\s\S]*<\/details>/.test(li), "so-14: «Merk som utsolgt» is a POST form under «Mer»");
      const r = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-fresh" }, token: tokens[TP], headers: ORIGIN }));
      assertEq([r.status, loc(r)], [303, `/eier/${TP}/portal?status=vare_utsolgt&ved=vare-b-fresh#vare-b-fresh`], "so-15: POST utsolgt → 303 to #vare-<id>");
      assertEq(srcOf("b-fresh").availability, "out_of_stock", "so-16: … and the row is sold out");
      const after = await portal(TP, { status: "vare_utsolgt", ved: "vare-b-fresh" });
      const li2 = liOf(after, "b-fresh");
      assertTrue(li2.includes("Varen er merket som utsolgt. Kundene kan ikke bestille den."), "so-17: the message stands by the row");
      assertEq((after.match(/Varen er merket som utsolgt\./g) || []).length, 1, "so-18: … once");
      assertTrue(li2.includes('data-group="sold_out"') && li2.includes('data-chip="sold_out">Utsolgt</strong>') && li2.includes("Merket som utsolgt i dag.")
        && li2.includes(">På lager igjen</button>") && li2.includes('data-action="back_in_stock"'), "so-19: group «Utsolgt», chip «Utsolgt», «Merket som utsolgt i dag.», «På lager igjen»");
      assertTrue(li2.includes('data-orderable="0"'), "so-20: the row is not orderable");
      // «På lager igjen» → the existing confirm path.
      const back = await invoke(H.one, makeReq({ params: { agentId: TP, productId: "b-fresh" }, token: tokens[TP], headers: ORIGIN }));
      assertEq(loc(back), `/eier/${TP}/portal?status=vare_bekreftet&ved=vare-b-fresh#vare-b-fresh`, "so-21: «På lager igjen» posts to …/bekreft");
      assertEq([srcOf("b-fresh").availability, cart.isRowOrderableForRealOrder(db, rowOf("b-fresh"), new Date())], ["in_stock", true], "so-22: … and the row is orderable again");
      // Another producer's product, a scraped row, an unknown id.
      const before = snap();
      const foreign = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-other-row" }, token: tokens[TP], headers: ORIGIN }));
      assertEq(foreign.status, 404, "so-23: another producer's product id → 404");
      const scraped = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-scraped" }, token: tokens[TP], headers: ORIGIN }));
      assertEq(loc(scraped), `/eier/${TP}/portal?status=vare_kan_ikke_merkes&ved=vare-b-scraped#vare-b-scraped`, "so-24: a scraped row → refused, back to the row");
      assertEq(snap(), before, "so-25: … nothing written");
      const refused = await portal(TP, { status: "vare_kan_ikke_merkes", ved: "vare-b-scraped" });
      assertTrue(liOf(refused, "b-scraped").includes(X.cannotMarkSoldOut), "so-26: the refusal stands by the row");
    }

    // ═══ auth-* — CSRF / session / ownership ══════════════════════════════
    {
      const before = snap();
      const xs = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-fresh" }, token: tokens[TP], headers: { origin: "https://evil.example" } }));
      assertEq(xs.status, 403, "auth-1: cross-site POST utsolgt → 403");
      const none = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-fresh" } }));
      assertEq([none.status, loc(none)], [303, `/eier/${TP}`], "auth-2: no session → 303 to login");
      const other = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-fresh" }, token: tokens[OTHER], headers: ORIGIN }));
      assertEq([other.status, loc(other)], [303, `/eier/${TP}`], "auth-3: another producer's session → 303 to login");
      const own = await invoke(H.sold, makeReq({ params: { agentId: OTHER, productId: "b-fresh" }, token: tokens[OTHER], headers: ORIGIN }));
      assertEq(own.status, 404, "auth-4: own session, another producer's product → 404");
      const nyX = await invoke(H.ny, makeReq({ params: { agentId: TP }, body: { skjema: "v1b", name: "Snik", price: "10", paa_lager: "1" }, token: tokens[TP], headers: { origin: "https://evil.example" } }));
      assertEq(nyX.status, 403, "auth-5: cross-site POST ny (V1b form) → 403");
      assertEq(snap(), before, "auth-6: nothing written");
    }

    // ═══ form-* ═══════════════════════════════════════════════════════════
    {
      const html = await portal(TP);
      const f = formOf(cardOf(html));
      assertTrue(f.length > 0 && !/<details class="ep-items-add"[^>]*\sopen/.test(f), "form-1: «Legg til vare» is a closed <details>");
      assertTrue(f.includes(`<summary`) && f.includes(">Legg til vare</summary>") && f.includes(`action="/eier/${TP}/varer/ny"`) && f.includes('name="skjema" value="v1b"'), "form-2: summary «Legg til vare», POST to /varer/ny");
      for (const [forId, label] of [["ny_name", "Navn"], ["ny_price", "Pris (kr)"], ["ny_unit", "Enhet"], ["ny_category", "Kategori (valgfritt)"],
        ["ny_ingredients", X.fieldIngredients], ["ny_allergens", X.fieldAllergens], ["ny_net_weight", X.fieldNetWeight]]) {
        assertTrue(f.includes(`<label for="${forId}">${label}</label>`), `form-3: label «${label}»`);
      }
      assertTrue(/<input type="checkbox" name="paa_lager" value="1"[^>]* checked[^>]*> Varen er på lager nå<\/label>/.test(f), "form-4: «Varen er på lager nå» ticked by default");
      assertTrue(f.includes(T.inStockOrdersOnHint), "form-5: orders on → «Kunder kan bestille varen med en gang.»");
      assertTrue(f.includes("<legend") && f.includes(">Er varen ferdigpakket?</legend>")
        && /name="ferdigpakket" value="ja"(?![^>]*checked)/.test(f) && /name="ferdigpakket" value="nei"[^>]* checked/.test(f), "form-6: «Er varen ferdigpakket?» Ja/Nei, Nei by default");
      assertTrue(!f.includes("autofocus") && !f.includes("aria-invalid") && !f.includes("data-items-add-error"), "form-7: a fresh form has no error state");
      assertTrue((f.match(/min-height:44px/g) || []).length >= 4, "form-8: the summary and the choices are ≥ 44 px targets");
      assertTrue(!/<script/i.test(f) && !/\son[a-z]+=/i.test(f), "form-9: no script, no inline handlers (works without JavaScript)");
      // Orders off: no «med en gang» hint, still ticked.
      const off = formOf(cardOf(await portal(OFF)));
      assertTrue(!off.includes(T.inStockOrdersOnHint) && /name="paa_lager" value="1"[^>]* checked/.test(off), "form-10: orders off → no «med en gang» hint (still ticked)");
      // orders.auto_confirm on → not ticked. The setting is «Kommer snart»
      // in the registry today, so the resolver keeps its default (off) and
      // the model reads false; the card is tested with the model value on.
      const set = resolveMod.setOwnerFeatureValue("rfb", AUTO, "orders.auto_confirm", true, { actor: "owner" }, { db });
      const resolved = resolveMod.resolveOwnerFeature("rfb", AUTO, "orders.auto_confirm", { db });
      assertEq([view.readOwnerItems(AUTO, db, now).autoConfirm, resolved.value === true], [resolved.value === true, resolved.value === true],
        `form-11: the model's autoConfirm = resolveOwnerFeature(orders.auto_confirm) (${JSON.stringify(set.kind)})`);
      const autoModel = { ...view.readOwnerItems(AUTO, db, now), autoConfirm: true };
      const auto = formOf(card.renderOwnerItemsSection({ agentId: AUTO, model: autoModel, now, canEdit: true }));
      assertTrue(/<input type="checkbox" name="paa_lager" value="1"(?![^>]*checked)[^>]*>/.test(auto) && auto.includes('data-in-stock-default="0"'), "form-13: auto_confirm on → «Varen er på lager nå» not ticked by default");
      assertTrue(auto.includes(X.inStockAutoConfirmHint) && auto.includes(T.inStockOrdersOnHint), "form-14: … with the auto-confirm hint (orders on: the «med en gang» hint too)");
      const autoOff = formOf(card.renderOwnerItemsSection({ agentId: AUTO, model: { ...autoModel, autoConfirm: false }, now, canEdit: true }));
      assertTrue(/name="paa_lager" value="1"[^>]* checked/.test(autoOff) && !autoOff.includes(X.inStockAutoConfirmHint), "form-14b: auto_confirm off → ticked, no auto-confirm hint");
      assertEq(view.readOwnerItems(TP, db, now).autoConfirm, false, "form-15: auto_confirm off by default");
    }

    // ═══ add-* ════════════════════════════════════════════════════════════
    {
      const count = () => (db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ?").get(TP) as any).n as number;
      // ferdigpakket = ja without the food fields → refused, re-rendered, no insert.
      const n0 = count();
      const a0 = auditN();
      const bad = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "Syltetøy <b>", price: "79,50", unit: "glass", category: "Syltetøy", paa_lager: "1", ferdigpakket: "ja", ingredients: "", allergens: "", net_weight: "" } }));
      assertEq(bad.status, 422, "add-1: ferdigpakket = ja without ingredients/allergens/net weight → 422");
      assertEq([count(), auditN()], [n0, a0], "add-2: … no insert, no audit");
      const html = String(bad.body ?? "");
      const c = cardOf(html);
      const f = formOf(c);
      assertTrue(/<details class="ep-items-add"[^>]*\sopen/.test(f), "add-3: the form is open again");
      assertTrue(f.includes('value="Syltetøy &lt;b&gt;"') && f.includes('value="79,50"') && f.includes('value="glass"') && f.includes('id="ny_category" name="category" type="text" value="Syltetøy"')
        && /name="ferdigpakket" value="ja"[^>]* checked/.test(f) && /name="paa_lager" value="1"[^>]* checked/.test(f), "add-4: the posted values are kept (escaped)");
      const msg = X.fieldErrors;
      assertTrue(f.includes("data-items-add-error") && f.includes(msg.ingredients_required) && f.includes(msg.allergens_required) && f.includes(msg.net_weight_required.replace(/«|»/g, "")), "add-5: the message names the three required fields, in the form (in the card)");
      assertTrue(c.includes("Varen ble ikke lagt til.") && html.indexOf("Varen ble ikke lagt til.") > html.indexOf('id="bestillbare-varer"'), "add-6: the message stands in the card, not at the top");
      assertTrue(/id="ny_ingredients"[^>]*aria-invalid="true" autofocus/.test(f) && (f.match(/autofocus/g) || []).length === 1, "add-7: the first refused field is marked and focused (scrolls without JavaScript)");
      assertTrue(html.includes("<h2>Varer</h2>") && html.includes("Gulrøtter"), "add-8: the rest of the portal renders as usual");
      // An unticked box with ferdigpakket = ja kept unticked.
      const bad2 = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "Saft", price: "40", ferdigpakket: "ja", ingredients: "Solbær, sukker", allergens: "", net_weight: "0,5 l" } }));
      const f2 = formOf(cardOf(String(bad2.body ?? "")));
      assertTrue(bad2.status === 422 && /name="paa_lager" value="1"(?![^>]*checked)/.test(f2) && f2.includes(msg.allergens_required) && !f2.includes(msg.ingredients_required), "add-9: only the missing field is named; the unticked box stays unticked");
      assertEq(count(), n0, "add-10: … no insert");

      // A valid ferdigpakket insert stores the fields, the category; back to the new row.
      const ok = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "Bringebærsyltetøy", price: "89,50", unit: "glass", category: "Syltetøy", paa_lager: "1", ferdigpakket: "ja",
          ingredients: "Bringebær 60 %, sukker", allergens: "Ingen", net_weight: "350 g" } }));
      const row = db.prepare("SELECT * FROM products WHERE agent_id = ? AND name = 'Bringebærsyltetøy'").get(TP) as any;
      assertTrue(!!row, "add-11: valid ferdigpakket → inserted");
      assertEq([ok.status, loc(ok)], [303, `/eier/${TP}/portal?status=vare_lagt_til&ved=vare-${row?.id}#vare-${row?.id}`], "add-12: 303 to the new row");
      assertEq([row?.ingredients, row?.allergens, row?.net_weight, row?.category, row?.price_nok, row?.unit], ["Bringebær 60 %, sukker", "[]", "350 g", "Syltetøy", 89.5, "glass"],
        "add-13: ingredients, allergens («ingen» = none = '[]'), net weight and category stored");
      assertEq([row?.availability, row?.availability_source, cart.isRowOrderableForRealOrder(db, row, new Date())], ["in_stock", "producer_dashboard", true], "add-14: ticked → in stock, orderable");
      const shown = await portal(TP, { status: "vare_lagt_til", ved: `vare-${row?.id}` });
      assertTrue(liOf(shown, row?.id).includes("Varen er lagt til og bekreftet på lager."), "add-15: the message stands by the new row");
      const ok2 = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "Honningkake", price: "120", ferdigpakket: "ja", paa_lager: "1", ingredients: "Mel, honning, egg", allergens: "Gluten, egg", net_weight: "400 g" } }));
      const row2 = db.prepare("SELECT * FROM products WHERE agent_id = ? AND name = 'Honningkake'").get(TP) as any;
      assertEq([ok2.status, row2?.allergens], [303, JSON.stringify(["gluten", "egg"])], "add-16: allergens stored as the existing JSON list");

      // Unticked → 'out_of_stock' (the producer's statement), a «not in stock» message.
      const nis = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "Asparges", price: "60", unit: "bunt", category: "", ferdigpakket: "nei" } }));
      const row3 = db.prepare("SELECT * FROM products WHERE agent_id = ? AND name = 'Asparges'").get(TP) as any;
      assertEq([nis.status, loc(nis)], [303, `/eier/${TP}/portal?status=vare_lagt_til_ikke_lager&ved=vare-${row3?.id}#vare-${row3?.id}`], "add-17: unticked → 303 to the row, «not in stock» status");
      assertEq([row3?.availability, row3?.availability_source, row3?.category, row3?.allergens, cart.isRowOrderableForRealOrder(db, row3, new Date())], ["out_of_stock", "producer_dashboard", null, null, false],
        "add-18: unticked → 'out_of_stock', not orderable; empty category and allergens = NULL");
      const nisHtml = await portal(TP, { status: "vare_lagt_til_ikke_lager", ved: `vare-${row3?.id}` });
      const li3 = liOf(nisHtml, row3?.id);
      assertTrue(li3.includes(X.addedNotInStock) && li3.includes('data-group="sold_out"') && li3.includes(">På lager igjen</button>"), "add-19: the row is in «Utsolgt» with «På lager igjen», the message by it");

      // Same name → refused, values kept.
      const dup = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "asparges", price: "65", paa_lager: "1", ferdigpakket: "nei" } }));
      const fd = formOf(cardOf(String(dup.body ?? "")));
      assertTrue(dup.status === 422 && fd.includes("Du har allerede en vare med det navnet.") && fd.includes('value="asparges"') && fd.includes('value="65"'), "add-20: same name → refused, the form open with the values");
      // A too-long category.
      const cat = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN,
        body: { skjema: "v1b", name: "Løk", price: "20", category: "x".repeat(41), paa_lager: "1", ferdigpakket: "nei" } }));
      assertTrue(cat.status === 422 && formOf(cardOf(String(cat.body ?? ""))).includes(X.fieldErrors.category), "add-21: category over 40 characters → refused with its text");
      // A too-long field with ferdigpakket: only the length text, not «required» as well.
      assertEq(oo.addOwnerProduct(TP, { name: "Lang", price: "10", packaged: true, ingredients: "x".repeat(1501), allergens: "ingen", net_weight: "1 kg" }, { db }),
        { ok: false, error: "invalid", fields: ["ingredients"] }, "add-22: too long + ferdigpakket → only the length error");
      assertEq(count(), n0 + 3, "add-23: exactly three rows were added");
      // The B1 form (no skjema=v1b) is unchanged: a refusal is still a redirect.
      const b1 = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN, body: { name: "", price: "10" } }));
      assertEq([b1.status, loc(b1)], [303, `/eier/${TP}/portal?status=vare_ugyldig&felt=name#bestillbare-varer`], "add-24: without the V1b marker → the B1 redirect, as before");
    }

    // ═══ ro-* — not the claimant's session ════════════════════════════════
    {
      const res = await invoke(H.portal, makeReq({ params: { agentId: TP }, token: "tok-tp-other-mail" }));
      const c = cardOf(String(res.body ?? ""));
      assertTrue(res.status === 200 && c.includes(T.readOnly) && c.includes("Gulrøtter"), "ro-1: the list with «Du kan se varene, men ikke endre dem med denne innloggingen.»");
      assertTrue(!c.includes("<form") && !c.includes("<button") && !c.includes("Merk som utsolgt") && !c.includes("Legg til vare") && !c.includes("ep-items-add") && !c.includes("<summary>Mer</summary>"),
        "ro-2: no «Merk som utsolgt», no «Mer», no add form");
      const before = snap();
      const w = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-fresh" }, token: "tok-tp-other-mail", headers: ORIGIN }));
      assertEq(w.status, 403, "ro-3: POST utsolgt → 403");
      const n = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: "tok-tp-other-mail", headers: ORIGIN, body: { skjema: "v1b", name: "Snik", price: "10", ferdigpakket: "nei" } }));
      assertEq(n.status, 403, "ro-4: POST ny (V1b form) → 403");
      assertEq(snap(), before, "ro-5: nothing written");
    }

    // ═══ get-* — no GET writes anything ═══════════════════════════════════
    {
      const before = snap();
      const a0 = auditN();
      for (const q of [{}, { status: "vare_utsolgt", ved: "vare-b-fresh" }, { status: "vare_lagt_til_ikke_lager" }, { status: "vare_kan_ikke_merkes", ved: "vare-b-scraped" }]) {
        await portal(TP, q as Record<string, string>);
        await portal(AUTO, q as Record<string, string>);
      }
      assertEq([snap(), auditN()], [before, a0], "get-1: GET portal (any status) writes nothing");
    }

    // ═══ cap-* — V1a review notes ═════════════════════════════════════════
    {
      db.prepare("UPDATE products SET availability_updated_at = ? WHERE id = 'b-fresh2'").run(ago(70));
      const ids = Array.from({ length: 600 }, (_, i) => `nope-${i}`);
      ids[550] = "b-fresh2";
      const r = await invoke(H.all, makeReq({ params: { agentId: TP }, body: { id: ids }, token: tokens[TP], headers: ORIGIN }));
      assertEq([loc(r), srcOf("b-fresh2").u], [`/eier/${TP}/portal?status=ingen_varer_bekreftet#bestillbare-varer`, ago(70)], "cap-1: «Bekreft alle» reads at most 500 ids (id #551 untouched)");
      ids[10] = "b-fresh2";
      const r2 = await invoke(H.all, makeReq({ params: { agentId: TP }, body: { id: ids }, token: tokens[TP], headers: ORIGIN }));
      assertTrue(loc(r2).includes("status=varer_bekreftet") && srcOf("b-fresh2").u !== ago(70), "cap-2: … an id within the first 500 is confirmed");
      const m = portalMod.ownerItemsMessageFromQuery("varer_bekreftet", { uten_pris: "123456" });
      assertEq(m?.text, "Varene er bekreftet på lager.", "cap-3: uten_pris with more than 5 digits is ignored");
      const m2 = portalMod.ownerItemsMessageFromQuery("vare_bekreftet", { uten_pris: "2" });
      assertEq(m2?.text, "Varen er bekreftet på lager.", "cap-4: uten_pris only counts after «Bekreft alle»");
    }

    // ═══ off-* — off the allowlist ════════════════════════════════════════
    {
      const QUERIES: Array<Record<string, string>> = [{}, { status: "vare_utsolgt", ved: "vare-b-fresh" }, { status: "vare_lagt_til_ikke_lager" }];
      setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", null);
      setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", `rfb:${OTHER}`);
      const offFlag: string[] = [];
      for (const q of QUERIES) offFlag.push(await portal(TP, q));
      setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", "1");
      for (let i = 0; i < QUERIES.length; i++) {
        const on = await portal(TP, QUERIES[i]);
        assertEq(on === offFlag[i], true, `off-1.${i}: flag on, off the list → byte-identical to flag off (${JSON.stringify(QUERIES[i])})`);
        assertTrue(!on.includes("Merk som utsolgt") && !on.includes("ep-items-add") && !on.includes("merket som utsolgt") && !on.includes("/varer/"), `off-2.${i}: … no V1b output`);
      }
      const before = snap();
      const s = await invoke(H.sold, makeReq({ params: { agentId: TP, productId: "b-fresh" }, token: tokens[TP], headers: ORIGIN }));
      const n = await invoke(H.ny, makeReq({ params: { agentId: TP }, token: tokens[TP], headers: ORIGIN, body: { skjema: "v1b", name: "Av", price: "10", paa_lager: "1", ferdigpakket: "nei" } }));
      assertEq([s.status, n.status], [404, 404], "off-3: off the list → POST utsolgt / ny answer 404");
      assertEq(snap(), before, "off-4: … nothing written");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerItemsT13V1bTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

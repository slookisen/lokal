/**
 * owner-items-t13-varer.test.ts — dev-request 2026-10-30-rfb-eierportal-
 * testrunde-1, slice T13 V1a (punkt 7: the «Varer» card, view + safe bulk),
 * the V1a parts of AC 9.
 *
 *   view-*     for every fixture row × clock × soft expiry on/off,
 *              ownerItemView() gives the expected group, chip, line and action.
 *   gate-*     «Kan bestilles» (chip) only when isRowOrderableForRealOrder() is
 *              true; the header «{n} av {m}» = countOrderableProducts().
 *   date-*     «i dag», «i går», else dd.mm.åååå in Norwegian time (midnight,
 *              DST).
 *   card-*     the texts, the groups, profile reasons once, the reminder box,
 *              «Du har ingen varer ennå.», escaping.
 *   bulk-*     «Bekreft alle ({n})» only at n ≥ 2, n counts only confirmable rows
 *              in «Trenger handling», never scraped rows; the POST with ids
 *              never touches another producer's row or a scraped row (it keeps
 *              its source); «{k} varer ble ikke bekreftet fordi de mangler pris.»
 *   none-*     fresh and admin-confirmed rows have no button.
 *   ro-*       a session that is not the claimant's sees the list, no buttons.
 *   msg-*      a row's POST answers 303 to #vare-<id> and the message stands in
 *              the row; bulk/add messages stand in the card, not at the top.
 *   off-*      off the gate (flag off, or off the allowlist) the portal is
 *              byte-identical across env variants and carries no T13 output.
 *   auth-*     no session → redirect to login, as the existing routes do.
 *
 * Real routers + services on the production schema in an in-memory DB.
 * Standalone: npx tsx src/routes/owner-items-t13-varer.test.ts
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

const TP = "t13-test-producer"; // allowlisted, eligible, orders on
const OFF = "t13-orders-off";    // allowlisted, orders off
const OTHER = "t13-other";       // another producer
const EMPTY = "t13-empty";       // no products
const DAY = 86_400_000;

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runOwnerItemsT13Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const sg = require("../services/supply-graph") as typeof import("../services/supply-graph");
    const oo = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
    const scr = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
    const view = require("../services/owner-items-view") as typeof import("../services/owner-items-view");
    const card = require("./owner-items-card") as typeof import("./owner-items-card");
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
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
         VALUES (?, ?, 'Testprodusent T13.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?)`,
      ).run(id, `T13 Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.optIn ?? 1);
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
    for (const id of [TP, OTHER, EMPTY]) seedProducer(id);
    seedProducer(OFF, { optIn: 0 });

    const UPD: Record<string, string | null> = {
      "t13-fresh": ago(1), "t13-soon": ago(12), "t13-soft": ago(20), "t13-hard": ago(70), "t13-nodate": null,
      "t13-out": ago(3), "t13-unknown": ago(2), "t13-exp-noprice": ago(70),
    };
    seedProduct(TP, "t13-fresh", { name: "Gulrøtter", availability: "in_stock", source: "producer_dashboard", updated: UPD["t13-fresh"] });
    seedProduct(TP, "t13-soon", { name: "Grønnkål", availability: "in_stock", source: "producer_dashboard", updated: UPD["t13-soon"] });
    seedProduct(TP, "t13-admin", { name: "Poteter", availability: "in_stock", source: "admin_producer_confirmed" });
    seedProduct(TP, "t13-soft", { name: "Løk", availability: "in_stock", source: "producer_dashboard", updated: UPD["t13-soft"] });
    seedProduct(TP, "t13-hard", { name: "Kålrot", availability: "in_stock", source: "producer_dashboard", updated: UPD["t13-hard"] });
    seedProduct(TP, "t13-nodate", { name: "Kål", availability: "in_stock", source: "producer_dashboard", updated: null });
    seedProduct(TP, "t13-out", { name: "Purre", availability: "out_of_stock", source: "producer_dashboard", updated: UPD["t13-out"] });
    seedProduct(TP, "t13-unknown", { name: "Selleri", availability: "unknown", source: "producer_dashboard", updated: UPD["t13-unknown"] });
    seedProduct(TP, "t13-exp-noprice", { name: "Pastinakk", price: null, availability: "in_stock", source: "producer_dashboard", updated: UPD["t13-exp-noprice"] });
    seedProduct(TP, "t13-scraped", { name: "Rødbeter", availability: "in_stock", source: "enrichment" });
    seedProduct(TP, "t13-scraped-noprice", { name: "Hjemmelaget pesto", price: null, availability: "in_stock", source: "enrichment" });
    seedProduct(TP, "t13-label", { name: "Honning", price: null, availability: "in_stock", source: "enrichment" });
    seedProduct(TP, "t13-alcohol", { name: "Eplesider", availability: "in_stock", source: "producer_dashboard", updated: ago(1) });
    seedProduct(OFF, "t13-off-fresh", { name: "Egg", availability: "in_stock", source: "producer_dashboard", updated: ago(1) });
    seedProduct(OTHER, "t13-other-row", { name: "Egg", availability: "in_stock", source: "producer_dashboard", updated: ago(70) });

    const ROW_SQL = `SELECT id, agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE id = ?`;
    const rowOf = (pid: string) => db.prepare(ROW_SQL).get(pid) as any;
    const srcOf = (pid: string) => db.prepare("SELECT availability, availability_source AS s FROM products WHERE id = ?").get(pid) as any;

    const ALLOW = [TP, OFF, OTHER, EMPTY].map((id) => `rfb:${id}`).join(",");
    setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", ALLOW);

    // ═══ date-* ════════════════════════════════════════════════════════════
    {
      const f = view.formatOwnerItemDate;
      const n1 = new Date("2026-11-08T23:30:00Z"); // 00:30 on 09.11 in Oslo
      assertEq(f("2026-11-08T23:10:00Z", n1), "i dag", "date-1: same Oslo day → «i dag»");
      assertEq(f("2026-11-08T22:00:00Z", n1), "i går", "date-2: 23:00 Oslo the day before (same UTC day) → «i går»");
      assertEq(f("2026-11-07 12:00:00", n1), "07.11.2026", "date-3: two days back (SQLite format) → dd.mm.åååå");
      const dst = new Date("2027-03-28T22:30:00Z"); // 00:30 on 29.03.2027 (CEST), after the 23-hour day
      assertEq(f("2027-03-27T23:30:00Z", dst), "i går", "date-4: DST (28.03.2027, 23 h) — 00:30 CET on the 28th → «i går»");
      assertEq(f("2027-03-27T22:30:00Z", dst), "27.03.2027", "date-5: DST — the 27th → dd.mm.åååå");
      assertEq(f(null, n1), "", "date-6: no timestamp → \"\"");
      assertEq(f("not a date", n1), "", "date-7: unreadable → \"\"");
      assertEq(f("2026-11-12T12:00:00Z", n1), "12.11.2026", "date-8: a future date → dd.mm.åååå");
    }

    // ═══ view-* / gate-* ═══════════════════════════════════════════════════
    const TP_ROWS = ["t13-fresh", "t13-soon", "t13-admin", "t13-soft", "t13-hard", "t13-nodate", "t13-out", "t13-unknown", "t13-exp-noprice",
      "t13-scraped", "t13-scraped-noprice", "t13-label", "t13-alcohol"];
    type Exp = { group: string; chip: string | null; line: string; action: string | null; more: string[] };
    const fmt = (ts: string | Date | null, at: Date) => view.formatOwnerItemDate(ts, at);
    const plus = (ts: string, days: number) => new Date(sg.producerStockExpiresAt(ts)!.getTime() + (days - sg.getSupplyGraphStaleDays()) * DAY);
    function expected(pid: string, soft: boolean, at: Date): Exp {
      const upd = UPD[pid] ?? null;
      const ageDays = upd ? (at.getTime() - new Date(upd.replace(" ", "T") + "Z").getTime()) / DAY : Infinity;
      const fresh = (u: string): Exp => ({ group: "orderable", chip: "orderable", line: `Sist bekreftet ${fmt(u, at)}. Kan bestilles til ${fmt(plus(u, soft ? 60 : 14), at)}.`, action: null, more: ["confirm_now"] });
      const expiredAt = (u: string) => fmt(plus(u, soft ? 60 : 14), at);
      const must = (line: string): Exp => ({ group: "needs_action", chip: "must_confirm", line, action: "confirm", more: [] });
      switch (pid) {
        case "t13-fresh": case "t13-soon": case "t13-soft": case "t13-hard": {
          if (ageDays <= 14) return fresh(upd!);
          if (soft && ageDays <= 60) return { group: "needs_action", chip: "should_confirm", line: `Sist bekreftet ${fmt(upd!, at)}. Kundene ser denne datoen.`, action: "confirm", more: [] };
          return must(`Lagerstatus gikk ut ${expiredAt(upd!)}. Kundene kan ikke bestille varen.`);
        }
        case "t13-admin": return { group: "orderable", chip: "orderable", line: X.lineAdminConfirmed, action: null, more: [] };
        case "t13-nodate": return must(X.lineExpiredNoDate);
        case "t13-out": return { group: "sold_out", chip: "sold_out", line: `Merket som utsolgt ${fmt(upd!, at)}.`, action: "back_in_stock", more: [] };
        case "t13-unknown": return must(X.lineNotInStock);
        case "t13-exp-noprice": return { group: "needs_action", chip: "must_confirm", line: T.lineMissingPrice, action: null, more: [] };
        case "t13-scraped": return { group: "from_website", chip: "must_confirm", line: T.lineFromWebsite, action: "confirm_price_and_stock", more: [] };
        case "t13-scraped-noprice": return { group: "from_website", chip: "must_confirm", line: T.lineMissingPrice, action: null, more: [] };
        case "t13-label": return { group: "not_here", chip: "not_orderable", line: "Dette er et kategorinavn, ikke en vare.", action: null, more: [] };
        case "t13-alcohol": return { group: "not_here", chip: "not_orderable", line: "Alkohol kan ikke bestilles her.", action: null, more: [] };
      }
      throw new Error(`no expectation for ${pid}`);
    }
    const clocks: Array<[string, Date]> = [["now", now], ["+5d", new Date(now.getTime() + 5 * DAY)], ["+50d", new Date(now.getTime() + 50 * DAY)]];
    let chipOnlyWhenGate = 0;
    let chipChecks = 0;
    for (const soft of [false, true]) {
      setEnv("STOCK_SOFT_EXPIRY_ENABLED", soft ? "1" : null);
      for (const [cname, at] of clocks) {
        const model = view.readOwnerItems(TP, db, at);
        assertEq(model.softExpiry, soft, `view-0 (${soft ? "soft" : "hard"}, ${cname}): the model follows STOCK_SOFT_EXPIRY_ENABLED`);
        assertEq([model.orderable_count, model.total], [cart.countOrderableProducts(TP, db, at), TP_ROWS.length], `gate-1 (${soft ? "soft" : "hard"}, ${cname}): n = countOrderableProducts(), m = every row`);
        const ctx = { now: at, softExpiry: model.softExpiry, ordersOn: model.ordersOn, profileEligible: model.profileEligible, canEdit: true };
        for (const pid of TP_ROWS) {
          const row = model.rows.find((r) => r.id === pid)!;
          const gate = cart.isRowOrderableForRealOrder(db, rowOf(pid), at);
          assertEq(row.gate_orderable, gate, `gate-2 (${soft ? "soft" : "hard"}, ${cname}): ${pid} gate_orderable = isRowOrderableForRealOrder`);
          const v = view.ownerItemView(row, ctx);
          assertEq({ group: v.group, chip: v.chip, line: v.line, action: v.action, more: v.more }, expected(pid, soft, at),
            `view-1 (${soft ? "soft" : "hard"}, ${cname}): ${pid} → group/chip/line/action`);
          chipChecks++;
          if ((v.chip === "orderable") === gate || (!gate && v.chip !== "orderable") || (gate && v.chip === "should_confirm")) chipOnlyWhenGate++;
          if (v.chip === "orderable" && !gate) assertTrue(false, `gate-3: ${pid} shows «Kan bestilles» while the gate says no`);
        }
        // The rendered header equals the gate count.
        const html = card.renderOwnerItemsSection({ agentId: TP, model, now: at, canEdit: true });
        assertTrue(html.includes(`data-orderable-count="${model.orderable_count}">${model.orderable_count} av ${model.total} varer kan bestilles nå.</p>`),
          `gate-4 (${soft ? "soft" : "hard"}, ${cname}): «{n} av {m} varer kan bestilles nå.» with n = countOrderableProducts()`);
        const shown = (html.match(/data-chip="orderable">Kan bestilles</g) || []).length;
        assertEq(shown, model.rows.filter((r) => r.gate_orderable && view.ownerItemView(r, ctx).chip === "orderable").length, `gate-5 (${soft ? "soft" : "hard"}, ${cname}): «Kan bestilles» chips are gate-true rows only`);
        assertTrue(html.includes(soft ? `data-items-validity="soft">${T.validitySoft.replace("{14}", "14").replace("{60}", "60")}` : `data-items-validity="hard">${T.validity.replace("{14}", "14")}`),
          `card-1 (${soft ? "soft" : "hard"}, ${cname}): the one explanation follows soft expiry`);
      }
    }
    assertEq(chipOnlyWhenGate, chipChecks, `gate-3: «Kan bestilles» never shown when the gate says no (${chipChecks} checks)`);
    setEnv("STOCK_SOFT_EXPIRY_ENABLED", null);

    // Orders off: «Klar når bestillinger er på», no chip, the profile reason once.
    {
      const model = view.readOwnerItems(OFF, db, now);
      const ctx = { now, softExpiry: false, ordersOn: model.ordersOn, profileEligible: model.profileEligible, canEdit: true };
      const v = view.ownerItemView(model.rows[0], ctx);
      assertEq([model.ordersOn, v.group, v.chip, model.rows[0].gate_orderable], [false, "orderable", null, false], "view-2: orders off → «Kan bestilles» group, no chip, gate false");
      assertEq(view.ownerItemGroupLabel("orderable", ctx), "Klar når bestillinger er på", "view-3: orders off → the group is «Klar når bestillinger er på»");
      assertEq(view.ownerItemGroupLabel("orderable", { ordersOn: true, profileEligible: true }), "Kan bestilles", "view-4: orders on → «Kan bestilles»");
      const html = card.renderOwnerItemsSection({ agentId: OFF, model, now, canEdit: true });
      assertTrue(html.includes(`<h3>Klar når bestillinger er på</h3>`) && !html.includes('data-chip="orderable">'), "card-2: orders off → the group label, no «Kan bestilles» chip");
      assertEq((html.match(/Kundene kan ikke bestille noe ennå/g) || []).length, 1, "card-3: «Kundene kan ikke bestille noe ennå» once");
      assertTrue(html.includes("Bestillinger er slått av") && html.includes(`<a href="/eier/${OFF}/valg">Gå til Mine valg</a>`), "card-4: the profile reason and «Gå til Mine valg»");
      const tpHtml = card.renderOwnerItemsSection({ agentId: TP, model: view.readOwnerItems(TP, db, now), now, canEdit: true });
      assertTrue(!tpHtml.includes("Kundene kan ikke bestille noe ennå"), "card-5: an eligible profile has no profile box");
    }

    // ═══ card-* ════════════════════════════════════════════════════════════
    {
      const model = view.readOwnerItems(TP, db, now);
      const html = card.renderOwnerItemsSection({ agentId: TP, model, now, canEdit: true });
      assertTrue(html.includes(`<div class="ep-card" id="bestillbare-varer" data-items-card="t13">`) && html.includes("<h2>Varer</h2>"), "card-6: the card is «Varer» at #bestillbare-varer");
      const order = ["Trenger handling", "Kan bestilles", "Utsolgt", "Fra nettsiden din", "Kan ikke bestilles her"].map((g) => html.indexOf(g === "Kan ikke bestilles her" ? `<strong>${g}</strong>` : `<h3>${g}</h3>`));
      assertTrue(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), "card-7: the five groups in the spec's order");
      assertTrue(/<details class="ep-items-group" data-items-group="not_here"[^>]*><summary><strong>Kan ikke bestilles her<\/strong> \(2\)<\/summary>/.test(html) && !/data-items-group="not_here"[^>]* open/.test(html),
        "card-8: «Kan ikke bestilles her» is a closed <details>");
      assertTrue(html.includes(T.fromWebsiteIntro) && html.includes(T.notHereIntro), "card-9: the two group texts");
      for (const c of ["Kan bestilles", "Bør bekreftes", "Må bekreftes", "Utsolgt", "Kan ikke bestilles"]) {
        assertTrue(Object.values(T.chips).includes(c as any), `card-10: chip «${c}» exists`);
      }
      assertTrue(html.includes(">Bekreft på lager</button>") && html.includes(">Bekreft pris og lager</button>") && html.includes(">På lager igjen</button>")
        && html.includes("<summary>Mer</summary>") && html.includes(">Bekreft på lager nå</button>"), "card-11: the actions and «Mer»");
      assertTrue(!html.includes("Merk som utsolgt"), "card-12: no «Merk som utsolgt» in V1a");
      assertTrue(html.includes(`action="/eier/${TP}/varer/ny"`) && html.includes('<label for="ny_name">Navn</label>'), "card-13: the add form, as before");
      // Every row has li#vare-<id> and at most one primary action.
      for (const pid of TP_ROWS) {
        const m = html.match(new RegExp(`<li [^>]*id="vare-${pid}"[\\s\\S]*?</li>`));
        assertTrue(!!m, `card-14: ${pid} has li#vare-${pid}`);
        const li = m ? m[0] : "";
        const outsideMore = li.replace(/<details[\s\S]*?<\/details>/g, "");
        assertTrue((outsideMore.match(/<form /g) || []).length <= 1, `card-15: ${pid} has at most one primary button`);
      }
      // The reminder box (products.stock_check) — reused, inside the card.
      assertEq(scr.stockCheckOn(TP, { db }), true, "card-16: products.stock_check is on for the test producer");
      const items = scr.soonExpiringItems(TP, { db });
      assertEq(items.map((i) => i.id), ["t13-soon"], "card-17: the soon-expiring row");
      const banner = portalMod.stockCheckBannerHtml(TP, items);
      const withBanner = card.renderOwnerItemsSection({ agentId: TP, model, now, canEdit: true, bannerHtml: banner });
      assertTrue(withBanner.includes(banner) && withBanner.indexOf(banner) > withBanner.indexOf('id="bestillbare-varer"'), "card-18: the reminder box is in the card");
      // Empty.
      const empty = card.renderOwnerItemsSection({ agentId: EMPTY, model: view.readOwnerItems(EMPTY, db, now), now, canEdit: true });
      assertTrue(empty.includes("<p data-items-empty=\"1\">Du har ingen varer ennå.</p>") && !empty.includes("data-orderable-count"), "card-19: «Du har ingen varer ennå.»");
      // Escaping.
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at) VALUES (?, ?, ?, ?, 10, ?, 'in_stock', 'producer_dashboard', ?)`)
        .run(`t13-"><b>x`, OTHER, "<script>alert(1)</script>", "<script>alert(1)</script>", `"><img src=x>`, ago(70));
      const xh = card.renderOwnerItemsSection({ agentId: OTHER, model: view.readOwnerItems(OTHER, db, now), now, canEdit: true });
      assertTrue(!xh.includes("<script>alert(1)</script>") && !xh.includes("<img src=x>") && !xh.includes(`"><b>x`), "card-20: no raw tags from name, unit or id");
      assertTrue(xh.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && xh.includes("&quot;&gt;&lt;img src=x&gt;") && xh.includes(`id="vare-t13-&quot;&gt;&lt;b&gt;x"`)
        && xh.includes(`action="/eier/${OTHER}/varer/t13-%22%3E%3Cb%3Ex/bekreft"`), "card-21: name, unit and id escaped; the id URL-encoded in the action");
      assertTrue(!/\son[a-z]+=/i.test(html + xh + withBanner), "card-22: no inline on*= attributes");
      assertTrue(!/<script/i.test(html + withBanner), "card-23: no <script>");
      db.prepare("DELETE FROM products WHERE id = ?").run(`t13-"><b>x`);
      const msg = card.renderOwnerItemsSection({ agentId: TP, model, now, canEdit: true, message: { ok: false, text: "<i>x</i>" } });
      assertTrue(msg.includes("&lt;i&gt;x&lt;/i&gt;") && !msg.includes("<i>x</i>"), "card-24: messages are escaped");
    }

    // ═══ none-* — fresh and admin-confirmed rows have no button ═══════════
    {
      const model = view.readOwnerItems(TP, db, now);
      const ctx = { now, softExpiry: false, ordersOn: true, profileEligible: true, canEdit: true };
      for (const pid of ["t13-fresh", "t13-admin"]) {
        assertEq(view.ownerItemView(model.rows.find((r) => r.id === pid)!, ctx).action, null, `none-1: ${pid} has no primary action`);
      }
      const html = card.renderOwnerItemsSection({ agentId: TP, model, now, canEdit: true });
      const li = (pid: string) => (html.match(new RegExp(`<li [^>]*id="vare-${pid}"[\\s\\S]*?</li>`)) || [""])[0];
      assertTrue(li("t13-admin").includes('data-action=""') && !li("t13-admin").includes("<form") && !li("t13-admin").includes("<button"), "none-2: an admin-confirmed row has no button at all");
      assertTrue(li("t13-fresh").includes('data-action=""') && !li("t13-fresh").replace(/<details[\s\S]*?<\/details>/g, "").includes("<button"), "none-3: a fresh row has no button (only «Mer»)");
    }

    // ═══ bulk-* ════════════════════════════════════════════════════════════
    {
      const model = view.readOwnerItems(TP, db, now);
      const html = card.renderOwnerItemsSection({ agentId: TP, model, now, canEdit: true });
      // Hard rule at «now»: soft, hard, nodate, unknown are confirmable in «Trenger handling»; exp-noprice is not.
      assertTrue(html.includes(`data-confirm-all="4"`) && html.includes(">Bekreft alle (4)</button>"), "bulk-1: «Bekreft alle (4)» — n counts only the confirmable rows in «Trenger handling»");
      const form = (html.match(/<form [^>]*data-confirm-all[\s\S]*?<\/form>/) || [""])[0];
      const ids = Array.from(form.matchAll(/name="id" value="([^"]+)"/g)).map((m) => m[1]).sort();
      assertEq(ids, ["t13-exp-noprice", "t13-hard", "t13-nodate", "t13-soft", "t13-unknown"], "bulk-2: the form lists the «Trenger handling» rows — never scraped rows");
      assertTrue(html.indexOf("data-confirm-all") < html.indexOf("<h3>Trenger handling</h3>"), "bulk-3: «Bekreft alle» stands above the list");
      const one = { ...model, rows: model.rows.filter((r) => ["t13-soft", "t13-exp-noprice", "t13-scraped", "t13-fresh"].includes(r.id)) };
      assertTrue(!card.renderOwnerItemsSection({ agentId: TP, model: one, now, canEdit: true }).includes("data-confirm-all"), "bulk-4: one confirmable row in «Trenger handling» (+ unpriced, scraped) → no «Bekreft alle»");
      const scrapedMany = { ...model, rows: model.rows.filter((r) => ["t13-soft", "t13-scraped", "t13-scraped-noprice"].includes(r.id)).concat([{ ...model.rows.find((r) => r.id === "t13-scraped")!, id: "t13-scraped-2" }]) };
      assertTrue(!card.renderOwnerItemsSection({ agentId: TP, model: scrapedMany, now, canEdit: true }).includes("data-confirm-all"), "bulk-5: scraped rows never make n ≥ 2");
      setEnv("STOCK_SOFT_EXPIRY_ENABLED", "1");
      const softHtml = card.renderOwnerItemsSection({ agentId: TP, model: view.readOwnerItems(TP, db, now), now, canEdit: true });
      assertTrue(softHtml.includes(">Bekreft alle (4)</button>"), "bulk-6: soft expiry on — the soft row («Bør bekreftes») is counted the same");
      setEnv("STOCK_SOFT_EXPIRY_ENABLED", null);
      assertEq(card.ownerItemsMissingPriceText(3), "3 varer ble ikke bekreftet fordi de mangler pris.", "bulk-7: «{k} varer ble ikke bekreftet fordi de mangler pris.»");
      assertEq([card.ownerItemsMissingPriceText(0), card.ownerItemsMissingPriceText(1)], ["", X.notConfirmedMissingPriceOne], "bulk-8: k = 0 → nothing; k = 1 → singular");

      // The service: explicit ids.
      const snap = () => JSON.stringify(db.prepare("SELECT id, availability, availability_source, availability_updated_at FROM products ORDER BY id").all());
      db.prepare("UPDATE products SET availability_updated_at = ? WHERE id = 't13-admin'").run(ago(5));
      const otherBefore = srcOf("t13-other-row");
      const scrapedBefore = srcOf("t13-scraped");
      const r = oo.confirmAllOwnerProductsInStock(TP, { db, ids: ["t13-soft", "t13-scraped", "t13-other-row", "t13-exp-noprice", "t13-admin", "t13-label", "nope"], actorEmail: "post@t13" });
      assertEq(r, { ok: true, confirmed: 2, skipped_missing_price: 1 }, "bulk-9: ids → only this producer's confirmable producer-stated rows; the unpriced one counted");
      assertEq(srcOf("t13-scraped"), scrapedBefore, "bulk-10: a scraped row sent along is untouched (keeps its source)");
      assertEq(srcOf("t13-other-row"), otherBefore, "bulk-11: another producer's id is untouched");
      assertEq(srcOf("t13-admin"), { availability: "in_stock", s: "admin_producer_confirmed" }, "bulk-12: an admin-confirmed row keeps its source");
      assertEq(srcOf("t13-soft"), { availability: "in_stock", s: "producer_dashboard" }, "bulk-13: the listed row is confirmed");
      assertEq(srcOf("t13-label").s, "enrichment", "bulk-14: a category label sent along is not confirmed");
      const before = snap();
      assertEq(oo.confirmAllOwnerProductsInStock(TP, { db, ids: [] }), { ok: true, confirmed: 0, skipped_missing_price: 0 }, "bulk-15: an empty id list confirms nothing");
      assertEq(snap(), before, "bulk-16: … and writes nothing");
      // Restore the stale rows for the route tests.
      db.prepare("UPDATE products SET availability_updated_at = ? WHERE id = 't13-soft'").run(UPD["t13-soft"]);
    }

    // ─── Sessions and the routes ──────────────────────────────────────────
    setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", "1");
    const tokens: Record<string, string> = {};
    const addToken = (tok: string, agentId: string, email: string) => {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${tok}`, email, tok, agentId, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    };
    for (const id of [TP, OFF, OTHER, EMPTY]) { tokens[id] = `tok-${id}`; addToken(tokens[id], id, `post@${id}.example.no`); }
    addToken("tok-tp-other-mail", TP, "medhjelper@t13.example.no");
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
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

    // ═══ the portal with the gate on ═══════════════════════════════════════
    {
      const html = await portal(TP);
      assertTrue(html.includes(`data-items-card="t13"`) && html.includes("<h2>Varer</h2>") && !html.includes("Varer som kan bestilles"), "card-25: the portal shows the «Varer» card instead of the B1 card");
      assertTrue(html.includes('data-stock-check-banner="1"'), "card-26: … with the reminder box (products.stock_check on)");
      assertTrue(html.includes(`${cart.countOrderableProducts(TP, db)} av ${TP_ROWS.length} varer kan bestilles nå.`), "card-27: the portal header = countOrderableProducts()");
    }

    // ═══ ro-* — not the claimant's session ═════════════════════════════════
    {
      const res = await invoke(H.portal, makeReq({ params: { agentId: TP }, token: "tok-tp-other-mail" }));
      const html = String(res.body ?? "");
      assertEq(res.status, 200, "ro-1: a verified owner on another address gets the portal");
      const c = cardOf(html);
      assertTrue(c.includes("Du kan se varene, men ikke endre dem med denne innloggingen.") && c.includes("Gulrøtter"), "ro-2: the list with the read-only line");
      assertTrue(!c.includes("<form") && !c.includes("<button") && !c.includes("data-stock-check-banner") && !c.includes("/varer/ny"), "ro-3: no buttons, no forms, no reminder box");
      assertTrue(!(await portal(TP)).includes("Du kan se varene, men ikke endre"), "ro-4: the claimant does not see the read-only line");
      const w = await invoke(H.one, makeReq({ params: { agentId: TP, productId: "t13-soft" }, token: "tok-tp-other-mail", headers: ORIGIN }));
      assertEq(w.status, 403, "ro-5: … and the write route still refuses (403)");
    }

    // ═══ msg-* ═════════════════════════════════════════════════════════════
    {
      const r = await invoke(H.one, makeReq({ params: { agentId: TP, productId: "t13-hard" }, token: tokens[TP], headers: ORIGIN }));
      assertEq([r.status, loc(r)], [303, `/eier/${TP}/portal?status=vare_bekreftet&ved=vare-t13-hard#vare-t13-hard`], "msg-1: a row's POST → 303 to #vare-<id>");
      assertEq(srcOf("t13-hard"), { availability: "in_stock", s: "producer_dashboard" }, "msg-2: … and it is confirmed");
      const html = await portal(TP, { status: "vare_bekreftet", ved: "vare-t13-hard" });
      const li = (html.match(/<li [^>]*id="vare-t13-hard"[\s\S]*?<\/li>/) || [""])[0];
      assertTrue(li.includes("Varen er bekreftet på lager."), "msg-3: the message stands in the row");
      assertEq((html.match(/Varen er bekreftet på lager\./g) || []).length, 1, "msg-4: … once, not in the top card");
      const np = await invoke(H.one, makeReq({ params: { agentId: TP, productId: "t13-exp-noprice" }, token: tokens[TP], headers: ORIGIN }));
      assertEq(loc(np), `/eier/${TP}/portal?status=vare_mangler_pris&ved=vare-t13-exp-noprice#vare-t13-exp-noprice`, "msg-5: an unpriced row → back to the row");
      const foreign = await invoke(H.one, makeReq({ params: { agentId: TP, productId: "t13-other-row" }, token: tokens[TP], headers: ORIGIN }));
      assertEq([foreign.status, srcOf("t13-other-row").s], [404, "producer_dashboard"], "msg-6: another producer's row → 404");

      const all = await invoke(H.all, makeReq({ params: { agentId: TP }, body: { id: ["t13-soft", "t13-unknown", "t13-exp-noprice", "t13-scraped", "t13-other-row"] }, token: tokens[TP], headers: ORIGIN }));
      assertEq(loc(all), `/eier/${TP}/portal?status=varer_bekreftet&uten_pris=1#bestillbare-varer`, "bulk-17: POST «Bekreft alle» with ids → 303 to the card, k = 1");
      assertEq([srcOf("t13-soft"), srcOf("t13-unknown")], [{ availability: "in_stock", s: "producer_dashboard" }, { availability: "in_stock", s: "producer_dashboard" }], "bulk-18: the listed rows are confirmed");
      assertEq([srcOf("t13-scraped").s, srcOf("t13-other-row").availability], ["enrichment", "in_stock"], "bulk-19: the scraped row keeps its source; another producer's row untouched");
      assertEq((db.prepare("SELECT availability_updated_at AS u FROM products WHERE id = 't13-other-row'").get() as any).u, UPD["t13-hard"], "bulk-20: another producer's row keeps its timestamp");
      const m = await portal(TP, { status: "varer_bekreftet", uten_pris: "2" });
      const c = cardOf(m);
      assertTrue(c.includes("Varene er bekreftet på lager. 2 varer ble ikke bekreftet fordi de mangler pris."), "bulk-21: the message in the card");
      assertTrue(m.indexOf("Varene er bekreftet på lager.") > m.indexOf('id="bestillbare-varer"'), "msg-7: bulk messages stand in the card, not at the top");
      const bad = await portal(TP, { status: "varer_bekreftet", uten_pris: "<b>" });
      assertTrue(bad.includes("Varene er bekreftet på lager.") && !bad.includes("ble ikke bekreftet fordi"), "msg-8: a non-numeric uten_pris is ignored");
      const fake = await portal(TP, { status: "vare_bekreftet", ved: "vare-<b>finnes-ikke" });
      assertTrue(cardOf(fake).includes("Varen er bekreftet på lager.") && !fake.includes("<b>finnes"), "msg-9: an unknown row id → the message in the card, escaped");
      const xs = await invoke(H.all, makeReq({ params: { agentId: TP }, body: { id: ["t13-nodate"] }, token: tokens[TP], headers: { origin: "https://evil.example" } }));
      assertEq([xs.status, srcOf("t13-nodate").s], [403, "producer_dashboard"], "auth-1: cross-site bulk → 403");
      assertEq((db.prepare("SELECT availability_updated_at AS u FROM products WHERE id = 't13-nodate'").get() as any).u, null, "auth-2: … nothing written");
      const noIds = await invoke(H.all, makeReq({ params: { agentId: OTHER }, token: tokens[OTHER], headers: ORIGIN }));
      assertEq(loc(noIds), `/eier/${OTHER}/portal?status=varer_bekreftet#bestillbare-varer`, "bulk-22: without ids (older form) → every confirmable row, as before");
    }

    // ═══ auth-* ════════════════════════════════════════════════════════════
    {
      const g = await invoke(H.portal, makeReq({ params: { agentId: TP } }));
      assertEq([g.status, loc(g)], [302, `/eier/${TP}`], "auth-3: GET portal without session → 302 to login");
      for (const [name, h, params] of [["one", H.one, { agentId: TP, productId: "t13-nodate" }], ["all", H.all, { agentId: TP }], ["ny", H.ny, { agentId: TP }]] as Array<[string, Function, Record<string, string>]>) {
        const r = await invoke(h, makeReq({ params, body: { id: ["t13-nodate"], name: "Snik", price: "10" } }));
        assertEq([r.status, loc(r)], [303, `/eier/${TP}`], `auth-4: POST ${name} without session → 303 to login`);
        const o = await invoke(h, makeReq({ params, body: { id: ["t13-nodate"], name: "Snik", price: "10" }, token: tokens[OTHER], headers: ORIGIN }));
        assertEq([o.status, loc(o)], [303, `/eier/${TP}`], `auth-5: POST ${name} with another producer's session → 303 to login`);
      }
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM products WHERE name = 'Snik'").get() as any).n, 0, "auth-6: nothing added");
    }

    // ═══ off-* ═════════════════════════════════════════════════════════════
    {
      const QUERIES: Array<Record<string, string>> = [{}, { status: "vare_bekreftet", ved: "vare-t13-fresh" }, { status: "varer_bekreftet", uten_pris: "2" }];
      const noT13 = (h: string) => !h.includes("data-items-card") && !h.includes("bestillbare-varer") && !h.includes("/varer/") && !h.includes("Varen er bekreftet") && !h.includes("Varene er bekreftet");
      // Flag off (allowlisted): no card.
      setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", null);
      const offFlag: string[] = [];
      for (const q of QUERIES) offFlag.push(await portal(TP, q));
      for (let i = 0; i < QUERIES.length; i++) assertTrue(offFlag[i].includes("Profilinformasjon") && noT13(offFlag[i]), `off-1.${i}: flag off → no T13 output (${JSON.stringify(QUERIES[i])})`);
      // Flag on, TP off the list vs flag off, TP off the list: byte-identical.
      setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", `rfb:${OTHER}`);
      const offList: string[] = [];
      for (const q of QUERIES) offList.push(await portal(TP, q));
      setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", "1");
      for (let i = 0; i < QUERIES.length; i++) {
        const on = await portal(TP, QUERIES[i]);
        assertEq(on === offList[i], true, `off-2.${i}: flag on, off the list → byte-identical to flag off (${JSON.stringify(QUERIES[i])})`);
        assertTrue(noT13(on), `off-3.${i}: … and no T13 output`);
      }
      // Empty allowlist, flag on: byte-identical to all off.
      setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", null);
      const allOn = await portal(TP);
      setEnv("OWNER_ORDERABILITY_PORTAL_ENABLED", null);
      assertEq(allOn === await portal(TP), true, "off-4: empty allowlist, flag on → byte-identical to everything off");
      assertTrue(noT13(allOn), "off-5: … and no T13 output");
      // The B1 renderer is untouched (its own output for the same rows).
      const b1 = portalMod.ownerOrderabilityCardHtml(TP, oo.listOwnerProductOrderability(TP, db), "", {});
      assertTrue(b1.includes("<h2>Varer som kan bestilles</h2>") && !b1.includes("data-items-card"), "off-6: the old B1 renderer is unchanged");
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
  runOwnerItemsT13Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

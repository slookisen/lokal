/**
 * bestillinger-b2b1.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-start-
 * til-slutt-for-eier, slice B2b-1 («myk utløp»: the rule and the order path),
 * acceptance criteria 11 and 12.
 *
 *   rule-*     fixed clock, STOCK_SOFT_EXPIRY_ENABLED=1, producer on the
 *              owner-features allowlist: 10 days → orderable, no mark; 20 days →
 *              orderable, needs_producer_confirmation + stock_confirmed_at;
 *              61 days → not orderable, stock_status_expired, effective unknown.
 *   off-*      flag off, or a producer off the list → exactly today's rule.
 *   cart-*     add / view / submit follow the rule; the cart line carries the
 *              buyer text with the date.
 *   page-*     /handleliste (the checkout): the text with the date next to the
 *              item (offer) and in the summary, from the page's own code.
 *   confirm-*  the producer confirms an order → its producer_dashboard in_stock
 *              items get a fresh confirmation time (audit row);
 *              admin_producer_confirmed rows are untouched.
 *   search-*   the /handleliste search (findOffers) carries the same fields,
 *              and the page shows the text after a pick; flag off → identical.
 *   soldout-*  «Avslå – utsolgt» → the ticked items (all ticked by default;
 *              none ticked = plain decline) are out_of_stock /
 *              producer_dashboard, audit rows; plain «Avslå» unchanged; rule
 *              off → no option, the post is refused as before.
 *   scope-*    another producer's product in an order is never written.
 *   admin-*    an admin (non-seller) confirm / decline never touches stock.
 *
 * Fresh in-memory SQLite with the production schema, e-mail stubbed, an
 * in-process server with the real routers («Mine ordrer», the compact token
 * page and the producer's order page).
 * Standalone: npx tsx src/routes/bestillinger-b2b1.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 86_400_000;
const ENV_KEYS = [
  "ADMIN_KEY", "STOCK_SOFT_EXPIRY_ENABLED", "SUPPLY_GRAPH_STALE_DAYS", "SUPPLY_GRAPH_HARD_STALE_DAYS",
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED", "PAYMENTS_ENABLED", "ORDER_MESSAGES_ENABLED",
  "ORDER_CAP_NOTICE_ENABLED", "OWNER_FEATURES_ENFORCE",
];

const TP = "b2b1-test-producer"; // on the allowlist
const REAL = "b2b1-real-owner";  // verified owner, NOT on the allowlist
const BUYER_TEXT_RE = /^Sist bekreftet av produsenten (\d{2}\.\d{2}\.\d{4})\. Produsenten bekrefter at varen er på lager før bestillingen gjelder\.$/;

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** dd.mm.yyyy of an instant in Oslo time, computed independently of the code under test. */
function osloDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

export async function runBestillingerB2b1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const receiptSvc = require("../services/order-receipt-service") as typeof import("../services/order-receipt-service");
  const trustSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
  const actionsSvc = require("../services/order-actions") as typeof import("../services/order-actions");
  const supply = require("../services/supply-graph") as typeof import("../services/supply-graph");
  const soft = require("../services/stock-soft-expiry") as typeof import("../services/stock-soft-expiry");
  const offersSvc = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
  const page = require("./handleliste-page") as typeof import("./handleliste-page");

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  let server: http.Server | null = null;
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async () => ({ success: true, messageId: "stub" }));
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    receiptSvc.__setBuyerReceiptSendForTesting(async () => ({ success: true, messageId: "stub" }));
    actionsSvc.__setOrderActionsTestDb(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "b2b1-test-admin-key";

    // ── Fixture: the fixed clock T, two eligible verified producers ──────────
    const T = new Date(Math.floor(Date.now() / 1000) * 1000);
    const ago = (d: number) => sqlTs(new Date(T.getTime() - d * DAY));
    const isoOf = (sql: string) => new Date(sql.replace(" ", "T") + "Z").toISOString();
    const emailOf = (id: string) => `post@${id}.example.no`;
    const cookies: Record<string, string> = {};
    for (const id of [TP, REAL]) {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent B2b-1.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
      ).run(id, `B2b Gard ${id}`, emailOf(id), `https://${id}.example.no`, `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten gård.', 'verified', 0)`,
      ).run(id, emailOf(id), `https://${id}.example.no`);
      const tok = `sess-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`ml-${id}`, emailOf(id), tok, id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
      cookies[id] = `rfb_owner_session=${tok}`;
    }
    // [id, agent, name, source, age in days]
    const PRODUCTS: Array<[string, string, string, string, number]> = [
      ["tp-10", TP, "Gulrøtter", "producer_dashboard", 10],
      ["tp-20", TP, "Poteter", "producer_dashboard", 20],
      ["tp-20b", TP, "Purre", "producer_dashboard", 20],
      ["tp-61", TP, "Kålrot", "producer_dashboard", 61],
      ["tp-adm", TP, "Løk", "admin_producer_confirmed", 20],
      ["real-20", REAL, "Poteter", "producer_dashboard", 20],
    ];
    const resetProducts = () => {
      db.prepare("DELETE FROM products").run();
      for (const [id, agent, name, source, age] of PRODUCTS) {
        db.prepare(
          `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
           VALUES (?, ?, ?, ?, 30, 'kg', 'in_stock', 'vegetables', ?, ?)`,
        ).run(id, agent, name, name.toLowerCase(), source, ago(age));
      }
    };
    resetProducts();
    const rowOf = (id: string) => db.prepare(
      "SELECT agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE id = ?",
    ).get(id) as any;
    const prod = (id: string) => db.prepare("SELECT availability, availability_source, availability_updated_at FROM products WHERE id = ?").get(id) as any;
    const reasonsOf = (id: string) => cartSvc.orderabilityReasons(db, rowOf(id), T);
    const gateOf = (id: string) => cartSvc.isRowOrderableForRealOrder(db, rowOf(id), T);
    const ALL = PRODUCTS.map((p) => p[0]);
    const snapshot = () => JSON.stringify(ALL.map((id) => [id, reasonsOf(id), gateOf(id), cartSvc.orderPathStockFreshness(rowOf(id), T)]));
    const setAllow = (ids: string[]) => {
      if (ids.length) process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ids.map((id) => `rfb:${id}`).join(",");
      else delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
    };
    const auditRows = (agentId: string) => db.prepare(
      "SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid",
    ).all(agentId) as any[];

    // ════════════════════════════════════════════════════════════════════════
    // Today's rule (flag off) — the baseline every «off» case must equal
    // ════════════════════════════════════════════════════════════════════════
    setAllow([TP]);
    const baseline = snapshot();
    {
      assertEq(ALL.map(gateOf), [true, false, false, false, true, false],
        "off-0: flag off → today's rule: only the 10-day row and the admin_producer_confirmed row are orderable");
      assertEq(reasonsOf("tp-20").reasons.map((r) => r.code), ["stock_status_expired"], "off-0b: … the 20-day row is stock_status_expired today");
      assertEq([soft.stockSoftExpiryEnabled(), soft.stockSoftExpiryActiveFor(TP)], [false, false], "off-0c: the flag is off by default");
      for (const age of [10, 20, 61]) {
        const ts = ago(age);
        assertEq(supply.evaluateStockFreshness("in_stock", ts, "producer_dashboard", T, false),
          { availability: supply.computeEffectiveAvailability("in_stock", ts, "producer_dashboard", T), stock_confirmed_at: null, needs_producer_confirmation: false },
          `off-0d: evaluateStockFreshness(softExpiry=false) = computeEffectiveAvailability (${age} days)`);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC11 — the rule with the flag on and the producer on the list
    // ════════════════════════════════════════════════════════════════════════
    process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
    {
      assertEq([soft.stockSoftExpiryActiveFor(TP), soft.stockSoftExpiryActiveFor(REAL), soft.stockSoftExpiryActiveFor("")], [true, false, false],
        "rule-0: active = flag AND `rfb:<id>` on the allowlist");
      assertEq([supply.getSupplyGraphStaleDays(), supply.getSupplyGraphHardStaleDays()], [14, 60], "rule-0b: windows 14 / 60 days by default");

      const r10 = reasonsOf("tp-10");
      assertEq([r10.orderable, gateOf("tp-10"), "needs_producer_confirmation" in r10, "stock_confirmed_at" in r10], [true, true, false, false],
        "rule-1: 10 days → orderable, no mark (no needs_producer_confirmation / stock_confirmed_at)");

      const r20 = reasonsOf("tp-20");
      assertEq([r20.orderable, gateOf("tp-20"), r20.reasons, r20.needs_producer_confirmation, r20.stock_confirmed_at],
        [true, true, [], true, isoOf(ago(20))],
        "rule-2: 20 days → orderable, needs_producer_confirmation: true, stock_confirmed_at = the last confirmation (ISO)");
      assertEq(cartSvc.orderPathStockFreshness(rowOf("tp-20"), T).availability, "in_stock", "rule-3: 20 days → effective in_stock");
      assertEq(r20.stock_expires_at, supply.producerStockExpiresAt(ago(20))!.toISOString(), "rule-3b: stock_expires_at stays the 14-day date (the B2 reminder's cadence is unchanged)");

      const r61 = reasonsOf("tp-61");
      assertEq([r61.orderable, gateOf("tp-61"), r61.reasons.map((r) => r.code), "needs_producer_confirmation" in r61],
        [false, false, ["stock_status_expired"], false], "rule-4: 61 days → not orderable, reason stock_status_expired, no mark");
      assertEq(r61.reasons[0]!.expired_at, new Date(new Date(isoOf(ago(61))).getTime() + 60 * DAY).toISOString(), "rule-4b: … expired_at = the 60-day date");
      assertEq(cartSvc.orderPathStockFreshness(rowOf("tp-61"), T).availability, "unknown", "rule-5: 61 days → effective unknown");

      const adm = reasonsOf("tp-adm");
      assertEq([adm.orderable, "needs_producer_confirmation" in adm], [true, false], "rule-6: an admin_producer_confirmed row is unchanged (orderable, no mark)");

      // Boundaries: just inside / outside each window.
      assertEq(supply.evaluateStockFreshness("in_stock", sqlTs(new Date(T.getTime() - 14 * DAY + 60_000)), "producer_dashboard", T, true).needs_producer_confirmation, false,
        "rule-7: just under 14 days → no mark (unchanged)");
      assertEq(supply.evaluateStockFreshness("in_stock", sqlTs(new Date(T.getTime() - 60 * DAY + 60_000)), "producer_dashboard", T, true).availability, "in_stock",
        "rule-7b: just under 60 days → still in stock");
      assertEq(supply.evaluateStockFreshness("out_of_stock", ago(20), "producer_dashboard", T, true),
        { availability: "unknown", stock_confirmed_at: null, needs_producer_confirmation: false }, "rule-7c: only an in_stock row is kept (out_of_stock expires as today)");
      // Exact boundaries (the clock is whole seconds): 14 days → unchanged, 14 days + 1 s → soft; 60 days → soft, 60 days + 1 s → expired.
      const at = (ms: number) => supply.evaluateStockFreshness("in_stock", sqlTs(new Date(T.getTime() - ms)), "producer_dashboard", T, true);
      assertEq([at(14 * DAY).availability, at(14 * DAY).needs_producer_confirmation], ["in_stock", false], "rule-9: exactly 14 days → in stock, no mark (as today)");
      assertEq([at(14 * DAY + 1000).availability, at(14 * DAY + 1000).needs_producer_confirmation], ["in_stock", true], "rule-9b: 14 days + 1 s → in stock, marked");
      assertEq([at(60 * DAY).availability, at(60 * DAY).needs_producer_confirmation], ["in_stock", true], "rule-9c: exactly 60 days → still in stock, marked");
      assertEq([at(60 * DAY + 1000).availability, at(60 * DAY + 1000).needs_producer_confirmation], ["unknown", false], "rule-9d: 60 days + 1 s → unknown, no mark");
      process.env.SUPPLY_GRAPH_HARD_STALE_DAYS = "30";
      assertEq([supply.getSupplyGraphHardStaleDays(), reasonsOf("tp-20").orderable], [30, true], "rule-8: SUPPLY_GRAPH_HARD_STALE_DAYS overrides the hard window");
      process.env.SUPPLY_GRAPH_HARD_STALE_DAYS = "5";
      assertEq([supply.getSupplyGraphHardStaleDays(), reasonsOf("tp-20").orderable], [14, false], "rule-8b: a hard window under 14 days falls back to 14 (no soft window)");
      delete process.env.SUPPLY_GRAPH_HARD_STALE_DAYS;

      // Off the list (flag on) → today's rule for that producer, row for row.
      const base = JSON.parse(baseline) as any[];
      assertEq(JSON.stringify([["real-20", reasonsOf("real-20"), gateOf("real-20"), cartSvc.orderPathStockFreshness(rowOf("real-20"), T)]]),
        JSON.stringify(base.filter((x) => x[0] === "real-20")), "off-1: flag on, producer off the list → exactly today's result");
      setAllow([]);
      assertEq(snapshot(), baseline, "off-2: flag on, empty allowlist → exactly today's rule for every row");
      setAllow([TP]);
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      assertEq(snapshot(), baseline, "off-3: flag off again → exactly today's rule for every row");
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
    }

    // ── The cart: add / view / submit ──────────────────────────────────────
    {
      const c = cartSvc.createCart();
      const add20 = cartSvc.addCartItem(c.cart_id, "tp-20", 1);
      const add10 = cartSvc.addCartItem(c.cart_id, "tp-10", 2);
      const add61 = cartSvc.addCartItem(c.cart_id, "tp-61", 1);
      assertEq([add20.success, add10.success, add61.success, (add61 as any).status], [true, true, false, 409],
        "cart-1: add — 20 days accepted, 10 days accepted, 61 days refused (409 not in stock)");
      const view = cartSvc.viewCart(c.cart_id)!;
      const line = (pid: string) => view.groups.flatMap((g) => g.items).find((i) => i.product_id === pid)!;
      const l20 = line("tp-20"), l10 = line("tp-10");
      assertEq([l20.needs_producer_confirmation, l20.stock_confirmed_at], [true, isoOf(ago(20))], "cart-2: the 20-day cart line carries needs_producer_confirmation + stock_confirmed_at");
      const m = BUYER_TEXT_RE.exec(l20.stock_note ?? "");
      assertTrue(!!m && m[1] === osloDate(isoOf(ago(20))), `cart-3: the cart line's buyer text names the date (${l20.stock_note})`);
      assertEq(["stock_note" in l10, "needs_producer_confirmation" in l10, "stock_confirmed_at" in l10], [false, false, false], "cart-4: the 10-day line has no mark");
      const sub = cartSvc.submitCart(c.cart_id, { buyer_name: "Kari", buyer_email: "kari.b2b1@example.com", contact_consent: true });
      assertEq([sub.success, sub.success ? sub.orders.length : -1], [true, 1], "cart-5: submit — the order with the 20-day line is created (pending, the producer confirms)");
      const oid = sub.success ? sub.orders[0]!.order_id : "";
      assertEq((db.prepare("SELECT status FROM orders WHERE id = ?").get(oid) as any)?.status, "pending", "cart-6: … as a pending request");

      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      const c2 = cartSvc.createCart();
      const off = cartSvc.addCartItem(c2.cart_id, "tp-20", 1);
      assertEq([off.success, (off as any).status], [false, 409], "off-4: flag off → the 20-day row is refused on add, as today");
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
      cartSvc.addCartItem(c2.cart_id, "tp-20", 1);
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      const offSub = cartSvc.submitCart(c2.cart_id, { buyer_name: "Kari", buyer_email: "kari.b2b1@example.com", contact_consent: true });
      assertEq([offSub.success, (offSub as any).status, (offSub as any).unavailable?.[0]?.availability], [false, 409, "unknown"],
        "off-5: flag off at submit → the 20-day line is unavailable (unknown), as today");
      const offView = cartSvc.viewCart(c2.cart_id)!;
      assertEq("stock_note" in offView.groups[0]!.items[0]!, false, "off-6: flag off → the cart line has no mark");
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
      const c3 = cartSvc.createCart();
      const realAdd = cartSvc.addCartItem(c3.cart_id, "real-20", 1);
      assertEq([realAdd.success, (realAdd as any).status], [false, 409], "off-7: flag on, producer off the list → its 20-day row is refused, as today");
    }

    // ── The checkout page (/handleliste): next to the item and in the summary ──
    {
      const pre = offersSvc.findProducerOrderables(TP, { db, now: T, limit: 10 })!;
      const offer = (pid: string) => pre.offers.find((o) => o.product_id === pid);
      assertEq([!!offer("tp-10"), !!offer("tp-20"), !!offer("tp-61")], [true, true, false], "page-1: «Bestill for henting» pre-selects the 10- and 20-day rows, not the 61-day row");
      assertEq([offer("tp-20")!.availability, offer("tp-20")!.needs_producer_confirmation, offer("tp-20")!.stock_confirmed_at], ["in_stock", true, isoOf(ago(20))],
        "page-2: the 20-day offer: in_stock, needs_producer_confirmation, stock_confirmed_at");
      assertEq("needs_producer_confirmation" in offer("tp-10")!, false, "page-3: the 10-day offer has no mark");

      const built = page.buildHandelistePage("no", { producer_name: pre.producer.name, offers: pre.offers });
      const copyJson = /<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/.exec(built.content)?.[1] ?? "{}";
      const C = JSON.parse(copyJson);
      assertTrue(typeof C.__stock_soft === "string" && C.__stock_soft.includes("{date}"), "page-4: the page copy carries the buyer text template");

      const script = page.HANDELISTE_CLIENT_SCRIPT;
      const grab = (name: string): string => {
        const mm = script.match(new RegExp(`  function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}\\n`));
        return mm ? mm[0] : "";
      };
      const foodSrc = grab("foodNodes"), sumSrc = grab("toSummary"), chosenSrc = grab("chosen"), orderableSrc = grab("isOrderable");
      assertTrue(foodSrc.length > 0 && sumSrc.length > 0 && chosenSrc.length > 0 && orderableSrc.length > 0, "page-5: the page functions were found in the client script");
      // A minimal DOM: nodes keep their text and children.
      const mk = (tag: string, props: any, kids?: any[]) => ({ tag, text: props?.text ?? "", cls: props?.cls ?? "", children: (kids || []).filter(Boolean) });
      const texts = (n: any): string[] => [n.text, ...(n.children || []).flatMap(texts)].filter(Boolean);
      const foodNodes = new Function("mk", "C", `${foodSrc}\nreturn foodNodes;`)(mk, C) as (o: any) => any[];
      const near20 = foodNodes(offer("tp-20")).map((n) => n.text);
      const want = C.__stock_soft.replace("{date}", osloDate(isoOf(ago(20))));
      assertTrue(near20.includes(want) && BUYER_TEXT_RE.test(want), `page-6: next to the 20-day item: «${want}»`);
      assertTrue(!foodNodes(offer("tp-10")).some((n) => BUYER_TEXT_RE.test(n.text)), "page-7: no such text next to the 10-day item");

      const box: any = { tag: "div", children: [] };
      const state = { items: [{ term: "Poteter", qty: 1 }, { term: "Gulrøtter", qty: 2 }], offers: [[offer("tp-20")], [offer("tp-10")]], picks: [0, 0], hasOrders: false };
      const summary = new Function(
        "mk", "C", "state", "el", "clear", "msg", "show",
        `${orderableSrc}\n${foodSrc}\n${chosenSrc}\n${sumSrc}\nreturn toSummary;`,
      )(mk, C, state, () => ({ appendChild: (n: any) => box.children.push(n) }), () => { box.children.length = 0; }, () => {}, () => {}) as () => void;
      summary();
      const sumTexts = texts(box);
      assertEq(sumTexts.filter((t) => BUYER_TEXT_RE.test(t)), [want], "page-8: in the summary (checkout) the text with the date appears once, for the 20-day item");

      // The search flow of the page: GET /api/marketplace/catalog/offers (findOffers) → pick → summary.
      const search = async () => offersSvc.findOffers({ q: "Poteter", lat: 59.91, lng: 10.75, radiusKm: 50, limit: 5 }, { db, now: T });
      const found = await search();
      const sOffer = (agentId: string) => found.offers.find((o) => o.producer.agent_id === agentId);
      const tpHit = sOffer(TP);
      assertEq([tpHit?.product_id, tpHit?.availability, tpHit?.needs_producer_confirmation, tpHit?.stock_confirmed_at], ["tp-20", "in_stock", true, isoOf(ago(20))],
        "search-1: findOffers (the /handleliste search) gives the 20-day row as in_stock with needs_producer_confirmation + stock_confirmed_at");
      assertEq([sOffer(REAL)?.availability, sOffer(REAL) ? "needs_producer_confirmation" in sOffer(REAL)! : null], ["unknown", false],
        "search-2: the same row of a producer off the list is unknown with no mark, as today");
      assertTrue(foodNodes(tpHit).some((n) => n.text === want), "search-3: the searched offer shows the buyer text with the date next to the item");
      const box2: any = { tag: "div", children: [] };
      const state2 = { items: [{ term: "Poteter", qty: 1 }], offers: [[tpHit]], picks: [0], hasOrders: false };
      (new Function(
        "mk", "C", "state", "el", "clear", "msg", "show",
        `${orderableSrc}\n${foodSrc}\n${chosenSrc}\n${sumSrc}\nreturn toSummary;`,
      )(mk, C, state2, () => ({ appendChild: (n: any) => box2.children.push(n) }), () => { box2.children.length = 0; }, () => {}, () => {}) as () => void)();
      assertEq(texts(box2).filter((t) => BUYER_TEXT_RE.test(t)), [want], "search-4: picked from the search, the summary (checkout) shows the text with the date");
      // Flag-off identity: flag off = flag on with nobody on the list = today's answer (unknown, no fields).
      setAllow([]);
      const noneListed = JSON.stringify(await search());
      setAllow([TP]);
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      const offSearch = await search();
      assertEq(JSON.stringify(offSearch), noneListed, "off-search-1: flag off → findOffers output byte-identical to the rule being active for nobody");
      const offTp = offSearch.offers.find((o) => o.producer.agent_id === TP);
      assertEq([offTp?.availability, offTp ? "needs_producer_confirmation" in offTp : null, offTp ? "stock_confirmed_at" in offTp : null], ["unknown", false, false],
        "off-search-2: flag off → the 20-day row is unknown with no fields, as today");
      assertEq(JSON.stringify(offSearch.offers.find((o) => o.producer.agent_id === REAL)), JSON.stringify(sOffer(REAL)),
        "off-search-3: the off-list producer's offer is identical with the flag on and off");

      const offPage = page.buildHandelistePage("no", { producer_name: pre.producer.name, offers: pre.offers });
      const offCopy = JSON.parse(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/.exec(offPage.content)?.[1] ?? "{}");
      assertTrue(!("__stock_soft" in offCopy), "off-8: flag off → the page copy has no buyer text template");
      const preOff = offersSvc.findProducerOrderables(TP, { db, now: T, limit: 10 })!;
      assertEq(preOff.offers.map((o) => o.product_id), ["tp-10", "tp-adm"], "off-9: flag off → «Bestill for henting» pre-selects only today's orderable rows");
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC12 — the order path: confirm refreshes, «Utsolgt» on decline
    // ════════════════════════════════════════════════════════════════════════
    {
      const express = require("express");
      const ownerOrders = require("./owner-orders") as typeof import("./owner-orders");
      const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
      const cartRoutes = require("./marketplace-cart") as typeof import("./marketplace-cart");
      const app = express();
      app.use("/", ownerPortal.default);
      app.use("/", ownerOrders.default);
      app.use("/produsent/ordre", cartRoutes.producerOrderRouter);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; form?: string } = {}):
      Promise<{ status: number; text: string; location: string | undefined }> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form !== undefined) { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Content-Length"] = String(Buffer.byteLength(o.form)); }
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({ status: resp.statusCode || 0, text: Buffer.concat(chunks).toString("utf8"), location: resp.headers["location"] as string | undefined }));
        });
        r.on("error", reject);
        if (o.form !== undefined) r.write(o.form);
        r.end();
      });
    }
    const settle = () => new Promise((r) => setTimeout(r, 40));
    let seq = 0;
    function seedOrder(agentId: string, productIds: string[]): string {
      const id = `b2b1-order-${++seq}`;
      const created = sqlTs(new Date(Date.now() - 3600_000));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, total_nok, payment_mode,
                            notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 'pickup', ?, 90, NULL, ?, 'Kari Kjøper', 'kari.b2b1@example.com', ?, ?)
      `).run(id, agentId, `bref_${id}`, `ctok_${id}`, created, created, created);
      productIds.forEach((pid, i) => {
        db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, ?, ?, 1, 30, 30)")
          .run(`${id}-i${i}`, id, pid, (db.prepare("SELECT name FROM products WHERE id = ?").get(pid) as any).name);
      });
      return id;
    }
    const orderRow = (id: string) => db.prepare("SELECT status, cancel_reason, completion_source FROM orders WHERE id = ?").get(id) as any;
    const form = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const SOLD_OUT_FORM = 'data-sold-out-form="1"';

    // ── confirm → a fresh confirmation time for producer_dashboard in_stock items ──
    {
      resetProducts();
      const o1 = seedOrder(TP, ["tp-20", "tp-adm", "tp-61"]);
      const before = { adm: prod("tp-adm"), p61: prod("tp-61") as any };
      const a0 = auditRows(TP).length;
      const t0 = Date.now() - 1000;
      const r = await req("POST", `/produsent/ordre/ctok_${o1}/kompakt`, { form: form([["action", "confirm"]]) });
      await settle();
      assertEq([r.status, orderRow(o1).status], [303, "confirmed"], "confirm-1: the producer confirms the order (compact token page) → confirmed");
      const p20 = prod("tp-20");
      const refreshedAt = new Date(isoOf(p20.availability_updated_at)).getTime();
      assertTrue(refreshedAt >= t0 && refreshedAt <= Date.now() + 1000 && p20.availability === "in_stock" && p20.availability_source === "producer_dashboard",
        `confirm-2: the producer_dashboard in_stock item gets a fresh stock_confirmed_at (${p20.availability_updated_at})`);
      assertEq(prod("tp-adm"), before.adm, "confirm-3: the admin_producer_confirmed row is untouched");
      assertTrue(prod("tp-61").availability_updated_at !== before.p61.availability_updated_at && prod("tp-61").availability === "in_stock",
        "confirm-3b: a producer_dashboard in_stock row past 60 days in the order is refreshed too (the producer just confirmed it)");
      const rows = auditRows(TP).slice(a0);
      assertEq(rows.map((x) => [x.field_name, x.changed_by, x.new_value]),
        [["products.availability_updated_at", "owner", p20.availability_updated_at], ["products.availability_updated_at", "owner", prod("tp-61").availability_updated_at]],
        "confirm-4: one audit row (agent_knowledge_audit) per refreshed item, none for the admin row");
      assertTrue(rows.some((x) => String(x.notes).includes("tp-20") && x.old_value === ago(20)), "confirm-4b: … with the old confirmation time");
      const now20 = cartSvc.orderabilityReasons(db, rowOf("tp-20"), new Date());
      assertEq([now20.orderable, "needs_producer_confirmation" in now20], [true, false], "confirm-5: after the confirmation the item is fresh (no mark)");

      // Direct layer call with a fixed clock: the refreshed time is exactly the clock.
      resetProducts();
      const o1b = seedOrder(TP, ["tp-20b"]);
      const T2 = new Date(T.getTime() + 3600_000);
      const res = await actionsSvc.applyOrderAction(o1b, "confirm", { role: "seller", channel: "owner_portal" }, { now: T2 });
      assertEq([res.success, prod("tp-20b").availability_updated_at], [true, sqlTs(T2)], "confirm-6: applyOrderAction(confirm, now=T2) → availability_updated_at = T2");

      // Rule off (flag off) → confirming changes no product.
      resetProducts();
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      const o2 = seedOrder(TP, ["tp-20"]);
      const a1 = auditRows(TP).length;
      await req("POST", `/produsent/ordre/ctok_${o2}/kompakt`, { form: form([["action", "confirm"]]) });
      await settle();
      assertEq([orderRow(o2).status, prod("tp-20").availability_updated_at, auditRows(TP).length], ["confirmed", ago(20), a1],
        "off-10: flag off → the order is confirmed, the product row and audit log are unchanged");
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
      // Off the list → unchanged.
      const o3 = seedOrder(REAL, ["real-20"]);
      await actionsSvc.applyOrderAction(o3, "confirm", { role: "seller", channel: "producer_page" }, {});
      assertEq([orderRow(o3).status, prod("real-20").availability_updated_at, auditRows(REAL).length], ["confirmed", ago(20), 0],
        "off-11: producer off the list → confirming changes no product");
    }

    // ── «Avslå – utsolgt» ──────────────────────────────────────────────────
    {
      resetProducts();
      // The option on the three producer surfaces (rule active).
      const o4 = seedOrder(TP, ["tp-20", "tp-20b"]);
      const compact = await req("GET", `/produsent/ordre/ctok_${o4}/kompakt`);
      const boxes = (html: string) => (html.match(/<input type="checkbox" name="sold_out" value="([^"]+)" checked>/g) || []).length;
      assertTrue(compact.text.includes(SOLD_OUT_FORM) && boxes(compact.text) === 2 && compact.text.includes("Avslå – utsolgt"),
        "soldout-1: compact token page: «Avslå – utsolgt» with every item ticked by default");
      assertTrue(/value="decline">[\s\S]*?>Avslå<\/button>/.test(compact.text), "soldout-1b: … and the plain one-click «Avslå» is still there");
      const pageHtml = await req("GET", `/produsent/ordre/ctok_${o4}`);
      assertTrue(pageHtml.text.includes(SOLD_OUT_FORM) && boxes(pageHtml.text) === 2 && pageHtml.text.includes(">Avslå</button>"), "soldout-2: producer order page: the option too, beside «Avslå»");
      const list = await req("GET", `/eier/${TP}/ordrer?tab=venter`, { headers: { Cookie: cookies[TP]! } });
      assertTrue(list.text.includes(SOLD_OUT_FORM), "soldout-3: «Mine ordrer»: the option too");

      // Chosen items only (compact page).
      const a0 = auditRows(TP).length;
      const r = await req("POST", `/produsent/ordre/ctok_${o4}/kompakt`, { form: form([["action", "decline_sold_out"], ["sold_out", "tp-20"]]) });
      await settle();
      assertEq([r.status, orderRow(o4)], [303, { status: "declined", cancel_reason: null, completion_source: null }], "soldout-4: «Avslå – utsolgt» declines the order like «Avslå»");
      assertEq([prod("tp-20").availability, prod("tp-20").availability_source], ["out_of_stock", "producer_dashboard"], "soldout-5: the chosen item → out_of_stock, source producer_dashboard");
      assertEq(prod("tp-20b").availability, "in_stock", "soldout-6: the item not chosen is unchanged");
      assertEq(auditRows(TP).slice(a0).map((x) => [x.field_name, x.old_value, x.new_value, x.changed_by]),
        [["products.availability", "in_stock", "out_of_stock", "owner"]], "soldout-7: one audit row for the item set out of stock");
      assertEq(reasonsOf("tp-20").reasons.map((x) => x.code), ["not_in_stock"], "soldout-8: the item is no longer orderable (not_in_stock)");

      // Nothing ticked (producer order page, no sold_out field) → «none sold out»: a plain decline. Two values via «Mine ordrer».
      resetProducts();
      const o5 = seedOrder(TP, ["tp-20", "tp-20b"]);
      const a5 = auditRows(TP).length;
      await req("POST", `/produsent/ordre/ctok_${o5}`, { form: form([["action", "decline_sold_out"]]) });
      await settle();
      assertEq([orderRow(o5).status, prod("tp-20").availability, prod("tp-20b").availability, auditRows(TP).length], ["declined", "in_stock", "in_stock", a5],
        "soldout-9: nothing ticked → the order is declined, no item is set out of stock, no audit row");
      const o5b = seedOrder(TP, ["tp-20"]);
      await req("POST", `/produsent/ordre/ctok_${o5b}/kompakt`, { form: form([["action", "decline_sold_out"], ["sold_out", ""]]) });
      await settle();
      assertEq([orderRow(o5b).status, prod("tp-20").availability], ["declined", "in_stock"], "soldout-9b: an empty sold_out value → none sold out (compact page)");
      resetProducts();
      const o6 = seedOrder(TP, ["tp-20", "tp-20b", "tp-10"]);
      const ownerPost = await req("POST", `/eier/${TP}/ordrer/${o6}`, {
        headers: { Cookie: cookies[TP]! }, form: form([["action", "decline_sold_out"], ["sold_out", "tp-20"], ["sold_out", "tp-10"]]),
      });
      await settle();
      assertEq([ownerPost.status, orderRow(o6).status, prod("tp-20").availability, prod("tp-10").availability, prod("tp-20b").availability],
        [303, "declined", "out_of_stock", "out_of_stock", "in_stock"], "soldout-10: «Mine ordrer» with two ticked items → exactly those two");
      // An id that is not in the order is ignored.
      resetProducts();
      const o7 = seedOrder(TP, ["tp-20b"]);
      await req("POST", `/produsent/ordre/ctok_${o7}/kompakt`, { form: form([["action", "decline_sold_out"], ["sold_out", "real-20"], ["sold_out", "tp-20b"]]) });
      await settle();
      assertEq([prod("real-20").availability, prod("tp-20b").availability], ["in_stock", "out_of_stock"], "soldout-11: an id outside the order (another producer's) is never written");

      // Order scoping: an order line that is ANOTHER producer's product is never offered, refreshed or written.
      resetProducts();
      const oX = seedOrder(TP, ["tp-20b", "real-20"]);
      assertEq(soft.soldOutChoices(db, oX, TP).map((c) => c.product_id), ["tp-20b"], "scope-1: the «Utsolgt» choices are this producer's products of the order only");
      const xPage = await req("GET", `/produsent/ordre/ctok_${oX}/kompakt`);
      assertTrue(!xPage.text.includes('value="real-20"'), "scope-2: … the other producer's product has no checkbox");
      await req("POST", `/produsent/ordre/ctok_${oX}/kompakt`, { form: form([["action", "decline_sold_out"], ["sold_out", "real-20"], ["sold_out", "tp-20b"]]) });
      await settle();
      assertEq([prod("real-20").availability, prod("real-20").availability_updated_at, prod("tp-20b").availability, auditRows(REAL).length],
        ["in_stock", ago(20), "out_of_stock", 0], "scope-3: sold_out naming another producer's product in the order → that product is untouched");
      resetProducts();
      const oY = seedOrder(TP, ["tp-20b", "real-20"]);
      await actionsSvc.applyOrderAction(oY, "confirm", { role: "seller", channel: "owner_portal" }, { now: T });
      assertEq([prod("real-20").availability_updated_at, prod("tp-20b").availability_updated_at, auditRows(REAL).length], [ago(20), sqlTs(T), 0],
        "scope-4: confirming refreshes only this producer's products, never another producer's line");
      assertEq(soft.markOrderItemsSoldOut(db, oY, TP, ["real-20"], T), [], "scope-5: markOrderItemsSoldOut(… another producer's id) writes nothing");

      // A non-seller (admin) confirm / decline never touches stock.
      resetProducts();
      const oA = seedOrder(TP, ["tp-20"]);
      const aA = auditRows(TP).length;
      const rA = await actionsSvc.applyOrderAction(oA, "confirm", { role: "admin", channel: "admin" }, { now: T });
      assertEq([rA.success, orderRow(oA).status, prod("tp-20").availability_updated_at, auditRows(TP).length], [true, "confirmed", ago(20), aA],
        "admin-1: an admin confirm → confirmed, the product's confirmation time is not refreshed");
      const oB = seedOrder(TP, ["tp-20"]);
      const rB = await actionsSvc.applyOrderAction(oB, "decline", { role: "admin", channel: "admin" }, { soldOut: { productIds: ["tp-20"] } });
      assertEq([rB.success, orderRow(oB).status, prod("tp-20").availability, auditRows(TP).length], [true, "declined", "in_stock", aA],
        "admin-2: an admin decline with soldOut → declined, the item is not set out of stock");

      // Plain «Avslå» is unchanged: declined, no product or audit change.
      resetProducts();
      const o8 = seedOrder(TP, ["tp-20", "tp-20b"]);
      const a1 = auditRows(TP).length;
      await req("POST", `/produsent/ordre/ctok_${o8}/kompakt`, { form: form([["action", "decline"]]) });
      await settle();
      assertEq([orderRow(o8), prod("tp-20").availability, prod("tp-20b").availability, auditRows(TP).length],
        [{ status: "declined", cancel_reason: null, completion_source: null }, "in_stock", "in_stock", a1], "soldout-12: plain «Avslå» → declined, products and audit log unchanged");
      assertEq(orderRow(o8), orderRow(o4), "soldout-13: the declined order row is the same as with «Utsolgt» (the buyer gets today's decline)");

      // Rule off: no option on the page, the post is refused as an unknown action.
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      const o9 = seedOrder(TP, ["tp-20"]);
      const offCompact = await req("GET", `/produsent/ordre/ctok_${o9}/kompakt`);
      const offPage = await req("GET", `/produsent/ordre/ctok_${o9}`);
      const offList = await req("GET", `/eier/${TP}/ordrer?tab=venter`, { headers: { Cookie: cookies[TP]! } });
      assertTrue(![offCompact.text, offPage.text, offList.text].some((h) => h.includes(SOLD_OUT_FORM) || h.includes("Avslå – utsolgt")), "off-12: flag off → no «Utsolgt» option on any surface");
      const offPost = await req("POST", `/produsent/ordre/ctok_${o9}/kompakt`, { form: form([["action", "decline_sold_out"]]) });
      const offPost2 = await req("POST", `/produsent/ordre/ctok_${o9}`, { form: form([["action", "decline_sold_out"]]) });
      assertTrue(/error=ugyldig/.test(offPost.location || "") && /error=ugyldig/.test(offPost2.location || ""), "off-13: flag off → the post is refused as an unknown action (as today)");
      assertEq([orderRow(o9).status, prod("tp-20").availability], ["pending", "in_stock"], "off-14: … nothing changed");
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
      const o10 = seedOrder(REAL, ["real-20"]);
      const realCompact = await req("GET", `/produsent/ordre/ctok_${o10}/kompakt`);
      assertTrue(!realCompact.text.includes(SOLD_OUT_FORM), "off-15: producer off the list → no «Utsolgt» option");
      const realPost = await req("POST", `/produsent/ordre/ctok_${o10}/kompakt`, { form: form([["action", "decline_sold_out"]]) });
      assertTrue(/error=ugyldig/.test(realPost.location || "") && prod("real-20").availability === "in_stock", "off-16: … and its post is refused, nothing written");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    try { notifySvc.__setOrderNotifySendForTesting(null); notifySvc.__setOrderNotifyTestDb(null); } catch { /* ignore */ }
    try { receiptSvc.__setBuyerReceiptSendForTesting(null); receiptSvc.__setBuyerReceiptTestDb(null); } catch { /* ignore */ }
    try { actionsSvc.__setOrderActionsTestDb(null); cartSvc.__setCartTestDb(null); trustSvc.__setTrustEventTestDb(null); } catch { /* ignore */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBestillingerB2b1Tests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nbestillinger-b2b1: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

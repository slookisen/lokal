/**
 * order-bestillinger-skive4b.test.ts — dev-request 2026-10-21-rfb-bestillinger-
 * klar-for-forste-ekte-handel, FIX-UP SKIVE 4b (L3, before wave 1). No network,
 * no real e-mail, no production DB: a fresh in-memory SQLite with the real
 * production schema and the e-mail transport stubbed.
 *
 *   S1   findOffers: a scraped row never hides the confirmed item of a producer who passes the gate
 *   S2   /handleliste: a scraped row of such a producer becomes a contact choice (no generic failure)
 *   S3   POST /admin/products/producer-list: allergens required for ALL food (4c: omitted/null on non-packaged -> [] + allergens_defaulted)
 *   S4/5 the buyer-facing wording (pinned; 4c: the refusal text carries no source claim)
 *   4c   F1 price increase -> 409; F2 /handleliste shows the server text on 409 price_changed; F3 producer_confirmed on every offer of a producer who takes orders
 *   S9   a portal availability change keeps admin_producer_confirmed; the sync keeps price + category
 *   S11  a stale unit_price_snapshot cannot go into a real order
 *   T1   viewCart().producer_confirmed is true only for producer-stated lines
 *   T2   the catalog sync does not overwrite the category of a confirmed row
 *   T3   re-arming the test producer sets admin_producer_confirmed on an existing enrichment row
 *
 * Standalone: npx tsx src/routes/order-bestillinger-skive4b.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderBestillingerSkive4bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const syncSvc = require("../services/product-catalog-sync") as typeof import("../services/product-catalog-sync");
  const supply = require("../services/supply-graph") as typeof import("../services/supply-graph");
  const tpMod = require("./admin-test-producer") as typeof import("./admin-test-producer");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ORDER_CAP_OPEN_PENDING_PER_BUYER", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", "PAYMENTS_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const ADMIN_KEY = "skive4b-test-admin-key";
  const sent: Array<{ to: string; subject: string }> = [];
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject });
      return { success: true, messageId: "stub" };
    });
    tpMod.__setTestProducerDbForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
    process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";

    const LAT = 59.9, LNG = 10.75;
    const fresh = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const BUYER = { buyer_name: "Kari Kjøper", buyer_email: "kari.kjoper@example.com", contact_consent: true };
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const ordersCount = () => (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n as number;

    const addAgent = (id: string, name: string, eligible: boolean) => {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, lat, lng, city, is_active, is_verified, order_notifications_opt_in)
                  VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]', ?, ?, 'Oslo', 1, ?, ?)`)
        .run(id, name, `${id}@example.no`, `k-${id}`, LAT, LNG, eligible ? 1 : 0, eligible ? 1 : 0);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, '+47 400 11 111')").run(id, `${id}@example.no`);
    };
    const addProd = (id: string, agent: string, name: string, price: number | null, source: string, extra: { category?: string } = {}) =>
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
                  VALUES (?, ?, ?, ?, ?, 'stk', 'in_stock', ?, ?, ?)`)
        .run(id, agent, name, name.toLowerCase(), price, extra.category ?? "vegetables", source, source === "enrichment" ? null : fresh);

    // ════════════════════════════════════════════════════════════════════════
    // S1 — the offer picker prefers the producer-stated row for a producer who passes the gate
    // ════════════════════════════════════════════════════════════════════════
    {
      const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
      // Eligible producer: the scraped row «Egg» is the better name match, the confirmed row «Frittgående egg» is orderable.
      addAgent("ag-s1", "S1 Gård", true);
      addProd("p-s1-scraped", "ag-s1", "Egg", 40, "enrichment", { category: "eggs" });
      addProd("p-s1-admin", "ag-s1", "Frittgående egg", 65, "admin_producer_confirmed", { category: "eggs" });
      assertTrue(cartSvc.isEligibleForRealOrder("ag-s1"), "s1-00: setup: the producer passes the gate");
      const res = await findOffers({ q: "egg", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      const mine = res.offers.filter((o) => o.producer.agent_id === "ag-s1");
      assertEq(mine.length, 1, "s1-01: one offer per producer");
      assertEq(mine[0]?.product_id, "p-s1-admin", "s1-02: the confirmed row wins over a scraped row that matches the name better");
      assertEq(mine[0]?.price_nok, 65, "s1-03: …with the confirmed price");

      // A dashboard-stated row counts as stated too.
      addAgent("ag-s1b", "S1b Gård", true);
      addProd("p-s1b-scraped", "ag-s1b", "Honning", 90, "enrichment", { category: "honey" });
      addProd("p-s1b-dash", "ag-s1b", "Lynghonning fra gården", 120, "producer_dashboard", { category: "honey" });
      const resB = await findOffers({ q: "honning", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      assertEq(resB.offers.find((o) => o.producer.agent_id === "ag-s1b")?.product_id, "p-s1b-dash", "s1-04: a producer_dashboard row wins over a scraped row too");

      // An OUT-OF-STOCK stated row does not outrank an in-stock row: the old stock rule still decides.
      addAgent("ag-s1d", "S1d Gård", true);
      addProd("p-s1d-scraped", "ag-s1d", "Smør", 50, "enrichment", { category: "dairy" });
      addProd("p-s1d-oos", "ag-s1d", "Gårdssmør", 60, "producer_dashboard", { category: "dairy" });
      db.prepare("UPDATE products SET availability = 'out_of_stock' WHERE id = 'p-s1d-oos'").run();
      const resD = await findOffers({ q: "smør", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      assertEq(resD.offers.find((o) => o.producer.agent_id === "ag-s1d")?.product_id, "p-s1d-scraped", "s1-07: an out-of-stock stated row does not outrank an in-stock row (stock rule unchanged)");

      // Control: a producer who does NOT pass the gate is unchanged (compareOfferRows decides: the exact name).
      addAgent("ag-s1c", "S1c Gård", false);
      addProd("p-s1c-scraped", "ag-s1c", "Poteter", 20, "enrichment", { category: "vegetables" });
      addProd("p-s1c-dash", "ag-s1c", "Nypoteter fra gården", 30, "producer_dashboard", { category: "vegetables" });
      assertTrue(!cartSvc.isEligibleForRealOrder("ag-s1c"), "s1-05: setup: the control producer does not pass the gate");
      const resC = await findOffers({ q: "poteter", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      assertEq(resC.offers.find((o) => o.producer.agent_id === "ag-s1c")?.product_id, "p-s1c-scraped", "s1-06: a producer who does not pass the gate keeps the old choice");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S2 — /handleliste: a scraped row of an eligible producer becomes a contact choice
    // ════════════════════════════════════════════════════════════════════════
    {
      const page = require("./handleliste-page") as typeof import("./handleliste-page");
      const script = page.HANDELISTE_CLIENT_SCRIPT;
      const grab = (name: string): string => {
        const m = script.match(new RegExp(`  function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}\\n`));
        return m ? m[0] : "";
      };
      const isOrderableSrc = grab("isOrderable"), reasonSrc = grab("serverReason");
      const chosenSrc = grab("chosen"), submitSrc = grab("submit");
      assertTrue(isOrderableSrc.length > 0 && reasonSrc.length > 0 && chosenSrc.length > 0 && submitSrc.length > 0, "s2-00: the page functions were found in the client script");

      // isOrderable: unit cases.
      const isOrderable = new Function(`${isOrderableSrc}\nreturn isOrderable;`)() as (o: any) => boolean;
      const prod = { can_order: true, agent_id: "a" };
      assertEq(isOrderable({ product_id: "p", producer: prod, producer_confirmed: true }), true, "s2-01: a confirmed offer from a producer who takes orders is orderable");
      assertEq(isOrderable({ product_id: "p", producer: prod }), true, "s2-02: an offer without the new fields (older response) is orderable as before");
      assertEq(isOrderable({ product_id: "p", producer: prod, producer_confirmed: false }), false, "s2-03: a row the server says is not producer-confirmed is a contact choice");
      assertEq(isOrderable({ product_id: "p", producer: { can_order: false } }), false, "s2-04: a producer who does not take orders is a contact choice");
      assertEq(isOrderable({ producer: prod }), false, "s2-05: no product id is a contact choice");
      assertEq(isOrderable({ product_id: "p", producer: prod, match: "category" }), false, "s2-06: a category match is a contact choice");

      // The real submit() of the page against the real cart service (the page's own request sequence).
      addAgent("ag-s2", "S2 Gård", true);
      addProd("p-s2-scraped", "ag-s2", "Skrapte gulrøtter", 22, "enrichment");
      // Offer objects as the page holds them; producer_confirmed is absent here (no food information on the row).
      const offerOf = (productId: string) => ({ product_id: productId, producer: { agent_id: "ag-s2", name: "S2 Gård", can_order: true, vcard_url: null } });
      const EXPL_NO = "Denne varen er ikke bekreftet av produsenten, så den kan ikke bestilles her. Ta kontakt med produsenten direkte.";
      const runSubmit = async (offer: any, lang: "no" | "en"): Promise<{ result: any; msgs: string[] }> => {
        const state = { items: [{ term: "gulrøtter", qty: 1 }], offers: [[offer]], picks: [0], hasOrders: true };
        const msgs: string[] = [];
        let finish!: (v: any) => void;
        const done = new Promise<any>((r) => { finish = r; });
        const fields: Record<string, any> = {
          "hl-name": { value: "Kari Kjøper" }, "hl-email": { value: "kari.kjoper@example.com" }, "hl-phone": { value: "" },
          "hl-note": { value: "" }, "hl-consent": { checked: true }, "hl-website": { value: "" }, "hl-submit": { disabled: false, textContent: "" },
        };
        const el = (id: string) => fields[id] ?? (fields[id] = { value: "", checked: false });
        // api(): the same calls the page makes, answered by the real cart service (REST semantics).
        const api = async (method: string, path: string, body?: any) => {
          let m: RegExpMatchArray | null;
          if (method === "POST" && path === "/api/marketplace/cart") {
            const c = cartSvc.createCart();
            return { status: 201, body: { cart_id: c.cart_id, buyer_ref: c.buyer_ref } };
          }
          if (method === "POST" && (m = path.match(/^\/api\/marketplace\/cart\/([^/]+)\/wishes$/))) {
            const w = cartSvc.addCartWish(m[1]!, body.term, body.qty);
            return w.success ? { status: 201, body: { wish: w.wish } } : { status: (w as any).status, body: { error: (w as any).error } };
          }
          if (method === "PATCH" && (m = path.match(/^\/api\/marketplace\/cart\/([^/]+)\/wishes\/([^/]+)$/))) {
            const r = cartSvc.chooseCartWishOffer(m[1]!, m[2]!, { productId: body.product_id, agentId: body.agent_id, mode: body.mode, qty: body.qty });
            return r.success ? { status: 200, body: r } : { status: r.status, body: { error: r.error } };
          }
          if (method === "POST" && (m = path.match(/^\/api\/marketplace\/cart\/([^/]+)\/submit$/))) {
            const r = cartSvc.submitCart(m[1]!, BUYER);
            return r.success ? { status: 201, body: r } : { status: r.status, body: { success: false, error: r.error } };
          }
          return { status: 404, body: {} };
        };
        const factory = new Function(
          "api", "el", "msg", "lsSet", "lsDel", "LS_CART", "LS_RESULT", "errText", "renderResult", "show", "C", "state",
          `${isOrderableSrc}\n${reasonSrc}\n${chosenSrc}\n${submitSrc}\nreturn submit;`,
        );
        const submit = factory(
          api, el, (_id: string, t: string) => { msgs.push(String(t)); }, () => {}, () => {}, "cart", "result",
          () => "GENERIC_ERROR", (res: any) => finish(res), () => {},
          { sending: "…", submit: "Send", consent_needed: "x", __lang: lang }, state,
        ) as () => void;
        submit();
        const result = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 1500))]);
        return { result, msgs };
      };

      sent.length = 0;
      const before = ordersCount();
      const run = await runSubmit(offerOf("p-s2-scraped"), "no");
      assertTrue(run.result !== null, "s2-10: the submit finishes (no «Noe gikk galt»)");
      assertTrue(!run.msgs.includes("GENERIC_ERROR"), "s2-11: the generic error text is not shown");
      assertEq(run.result?.orders?.length, 0, "s2-12: no order is created for the scraped row");
      assertEq(run.result?.handoffs?.length, 1, "s2-13: the scraped row becomes a contact handoff to the producer");
      assertEq(run.result?.handoffs?.[0]?.name, "S2 Gård", "s2-14: …naming the producer");
      assertEq(run.result?.notes, [EXPL_NO], "s2-15: the server's explanation (Norwegian part) is carried to the result");
      assertEq(ordersCount(), before, "s2-16: no order row");
      await settle();
      assertEq(sent.length, 0, "s2-17: no e-mail to the producer");
      const runEn = await runSubmit(offerOf("p-s2-scraped"), "en");
      assertEq(runEn.result?.notes, ["This item is not confirmed by the producer, so it cannot be ordered here. Contact the producer directly."], "s2-18: the English page gets the English part");
      // A confirmed row is still ordered normally through the same page code.
      addProd("p-s2-admin", "ag-s2", "Bekreftede gulrøtter", 25, "admin_producer_confirmed");
      const runOk = await runSubmit(offerOf("p-s2-admin"), "no");
      assertEq([runOk.result?.orders?.length, runOk.result?.handoffs?.length, runOk.result?.notes], [1, 0, []], "s2-19: a confirmed row is still an order, with no note");
      // A scraped row flagged by the server (food information on a scraped row) never reaches the order PATCH.
      const flagged = await runSubmit({ ...offerOf("p-s2-scraped"), producer_confirmed: false }, "no");
      assertEq([flagged.result?.orders?.length, flagged.result?.handoffs?.length, flagged.result?.notes], [0, 1, []], "s2-20: a row flagged producer_confirmed:false goes straight to a contact choice");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S3 — POST /admin/products/producer-list: allergens for ALL food
    // ════════════════════════════════════════════════════════════════════════
    const express = require("express");
    const catalog = require("../routes/marketplace-catalog") as typeof import("../routes/marketplace-catalog");
    {
      const app = express();
      app.use(express.json());
      app.use("/admin/products", catalog.adminCatalogRouter);
      app.use("/admin/test-producer", tpMod.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, body?: any): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { "X-Admin-Key": ADMIN_KEY };
        let bodyStr: string | undefined;
        if (body !== undefined) { bodyStr = JSON.stringify(body); headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(bodyStr)); }
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            let parsed: any = null; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* html */ }
            resolve({ status: resp.statusCode || 0, body: parsed });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    {
      addAgent("ag-s3", "S3 Gård", false);
      const PATH = "/admin/products/producer-list";
      const count = () => (db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = 'ag-s3'").get() as any).n as number;
      const allergensOf = (norm: string) => (db.prepare("SELECT allergens FROM products WHERE agent_id = 'ag-s3' AND name_norm = ?").get(norm) as any)?.allergens;
      // 4c (Daniel, 2026-10-22T17:07Z): omitted or null allergens on non-packaged food default to [] and are reported.
      const omitted = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Poteter", price_nok: 30 }] });
      assertEq(omitted.status, 200, "s3-01: a NON-packaged product with allergens omitted is accepted (4c)");
      assertEq(allergensOf("poteter"), "[]", "s3-02: …and stored as []");
      assertEq(omitted.body?.allergens_defaulted, ["Poteter"], "s3-03: …and listed in allergens_defaulted");
      const nulled = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Nepe", price_nok: 20, allergens: null }] });
      assertTrue(nulled.status === 200 && allergensOf("nepe") === "[]" && JSON.stringify(nulled.body?.allergens_defaulted) === JSON.stringify(["Nepe"]), "s3-03b: allergens: null -> [] and listed in allergens_defaulted");
      const mixed = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Gulrøtter", price_nok: 25, allergens: [] }, { name: "Egg", price_nok: 60 }, { name: "Kålrot", price_nok: 18, allergens: ["Selleri"] }] });
      assertEq(mixed.status, 200, "s3-04: a mixed list is accepted");
      assertEq(mixed.body?.allergens_defaulted, ["Egg"], "s3-04b: only the product that got the default is listed (explicit [] and explicit list are not)");
      assertEq(allergensOf("kålrot"), '["selleri"]', "s3-04c: an explicit list is kept as stated");
      const noPk = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Syltetøy 2", price_nok: 80, packaged: true, ingredients: "Bær, sukker", net_weight: "250 g" }] });
      assertEq(noPk.status, 400, "s3-04d: packaged:true without allergens is refused (400)");
      assertTrue(Array.isArray(noPk.body?.errors) && noPk.body.errors.some((e: string) => e.startsWith("products[0]") && e.includes("allergens")), "s3-04e: …and the error names the product and allergens");
      const noPkNull = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Syltetøy 3", price_nok: 80, packaged: true, allergens: null, ingredients: "Bær", net_weight: "250 g" }] });
      assertEq(noPkNull.status, 400, "s3-04f: packaged:true with allergens null is refused (400)");
      const countBefore = count();
      const badPack = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Ny vare", price_nok: 10 }, { name: "Syltetøy 4", price_nok: 80, packaged: true }] });
      assertEq([badPack.status, count()], [400, countBefore], "s3-04g: one invalid packaged product refuses the whole list (nothing written)");
      const okEmpty = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Kepaløk", price_nok: 30, allergens: [] }] });
      assertTrue(okEmpty.status === 200 && okEmpty.body?.inserted === 1, "s3-05: [] (the producer states none) is accepted for non-packaged food");
      assertEq(okEmpty.body?.allergens_defaulted, [], "s3-05b: an explicit [] is not reported as defaulted");
      assertEq((db.prepare("SELECT allergens FROM products WHERE agent_id = 'ag-s3' AND name_norm = 'kepaløk'").get() as any)?.allergens, "[]", "s3-06: …and stored as []");
      const okSome = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Rugbrød", price_nok: 55, allergens: ["Gluten"] }] });
      assertEq(okSome.status, 200, "s3-07: a listed allergen is accepted");
      const pk = await req("POST", PATH, { agent_id: "ag-s3", products: [{ name: "Syltetøy", price_nok: 80, packaged: true, allergens: [], net_weight: "250 g" }] });
      assertEq(pk.status, 400, "s3-08: packaged food still needs ingredients");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S4 / S5 — the buyer-facing wording (pinned; 4c: no claim about where the item came from)
    // ════════════════════════════════════════════════════════════════════════
    {
      const page = require("./handleliste-page") as typeof import("./handleliste-page");
      const html = (lang: "no" | "en") => page.buildHandelistePage(lang).content;
      assertTrue(html("no").includes("ingen oppgitt av produsenten"), "s45-01: NO page copy says «ingen oppgitt av produsenten»");
      assertTrue(html("en").includes("none stated by the producer"), "s45-02: EN page copy says «none stated by the producer»");
      assertTrue(cartSvc.NOT_PRODUCER_CONFIRMED_ERROR.includes("Denne varen er ikke bekreftet av produsenten, så den kan ikke bestilles her. Ta kontakt med produsenten direkte."), "s45-03: the NO refusal text is the 4c wording");
      assertTrue(cartSvc.NOT_PRODUCER_CONFIRMED_ERROR.includes("This item is not confirmed by the producer, so it cannot be ordered here. Contact the producer directly."), "s45-04: the EN refusal text is the 4c wording");
      assertTrue(!/nettside|website/i.test(cartSvc.NOT_PRODUCER_CONFIRMED_ERROR), "s45-05: the refusal text makes no claim about the source of the item");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S9 + T2 — a portal availability change keeps the confirmation; the sync keeps price + category
    // ════════════════════════════════════════════════════════════════════════
    {
      addAgent("ag-s9", "S9 Gård", true);
      addProd("p-s9-a", "ag-s9", "Bekreftet ost", 150, "admin_producer_confirmed", { category: "cheese" });
      addProd("p-s9-b", "ag-s9", "Bekreftet smør", 80, "admin_producer_confirmed", { category: "dairy" });
      addProd("p-s9-scr", "ag-s9", "Skrapet rømme", 40, "enrichment", { category: "dairy" });
      // The portal PATCH (by product id) and the name-keyed writer both leave an admin-confirmed source alone.
      const r1 = supply.setProducerAvailabilityByProductId("ag-s9", "p-s9-a", "out_of_stock", db);
      assertTrue(r1.success === true, "s9-01: the portal PATCH succeeds");
      const row = (id: string) => db.prepare("SELECT availability, availability_source AS s, price_nok AS p, category AS c FROM products WHERE id = ?").get(id) as any;
      assertEq([row("p-s9-a").availability, row("p-s9-a").s], ["out_of_stock", "admin_producer_confirmed"], "s9-02: availability changed, the source is still admin_producer_confirmed (by id)");
      const r2 = supply.setProducerAvailability("ag-s9", "bekreftet smør", "out_of_stock", db);
      assertTrue(r2.success === true, "s9-03: the name-keyed writer succeeds");
      assertEq([row("p-s9-b").availability, row("p-s9-b").s], ["out_of_stock", "admin_producer_confirmed"], "s9-04: …and keeps the source (by name)");
      // A scraped row still becomes producer_dashboard (unchanged behaviour).
      supply.setProducerAvailabilityByProductId("ag-s9", "p-s9-scr", "in_stock", db);
      assertEq(row("p-s9-scr").s, "producer_dashboard", "s9-05: a scraped row set by the producer becomes producer_dashboard, as before");
      // Portal change -> sync: the confirmed price and category survive (the S9 chain).
      db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = 'ag-s9'").run(JSON.stringify([
        { name: "Bekreftet ost", price: "kr 999", category: "meat" },
        { name: "Bekreftet smør", price: "kr 888", category: "honey" },
      ]));
      assertTrue(syncSvc.runProductCatalogSync(db as any).success === true, "s9-06: the catalog sync runs");
      assertEq([row("p-s9-a").p, row("p-s9-a").c], [150, "cheese"], "s9-07: price AND category of the confirmed row survive the sync after a portal change (by id)");
      assertEq([row("p-s9-b").p, row("p-s9-b").c], [80, "dairy"], "s9-08: …also after a name-keyed change");

      // T2: the sync never overwrites the category of a confirmed row (no portal change involved).
      addProd("p-t2", "ag-s9", "Kategoribevart", 70, "admin_producer_confirmed", { category: "bakery" });
      db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = 'ag-s9'").run(JSON.stringify([{ name: "Kategoribevart", price: "kr 700", category: "meat" }]));
      syncSvc.runProductCatalogSync(db as any);
      assertEq([row("p-t2").p, row("p-t2").c], [70, "bakery"], "t2-01: the sync overwrites neither price nor category of an admin-confirmed row");
      addProd("p-t2-scr", "ag-s9", "Kategorisk skrapet", 70, "enrichment", { category: "bakery" });
      db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = 'ag-s9'").run(JSON.stringify([{ name: "Kategorisk skrapet", price: "kr 700", category: "meat" }]));
      syncSvc.runProductCatalogSync(db as any);
      assertEq([row("p-t2-scr").p, row("p-t2-scr").c], [700, "meat"], "t2-02: control: a scraped row is still updated by the sync");
    }

    // ════════════════════════════════════════════════════════════════════════
    // T1 — viewCart().producer_confirmed
    // ════════════════════════════════════════════════════════════════════════
    {
      addAgent("ag-t1", "T1 Gård", true);
      addProd("p-t1-admin", "ag-t1", "T1 admin", 10, "admin_producer_confirmed");
      addProd("p-t1-dash", "ag-t1", "T1 dashbord", 11, "producer_dashboard");
      addProd("p-t1-scr", "ag-t1", "T1 skrapet", 12, "enrichment");
      const cart = cartSvc.createCart();
      const ins = db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES (?, ?, ?, 'ag-t1', 1, ?)");
      ins.run("ci-t1-a", cart.cart_id, "p-t1-admin", 10);
      ins.run("ci-t1-d", cart.cart_id, "p-t1-dash", 11);
      ins.run("ci-t1-s", cart.cart_id, "p-t1-scr", 12);
      const items = cartSvc.viewCart(cart.cart_id)?.groups[0]?.items ?? [];
      const conf = (pid: string) => items.find((i) => i.product_id === pid)?.producer_confirmed;
      assertEq(conf("p-t1-admin"), true, "t1-01: admin_producer_confirmed line is producer_confirmed");
      assertEq(conf("p-t1-dash"), true, "t1-02: producer_dashboard line is producer_confirmed");
      assertEq(conf("p-t1-scr"), false, "t1-03: a scraped (enrichment) line is NOT producer_confirmed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S11 — a stale unit_price_snapshot cannot go into a real order
    // ════════════════════════════════════════════════════════════════════════
    {
      addAgent("ag-s11", "S11 Gård", true);
      addProd("p-s11", "ag-s11", "Pris-vare", 20, "admin_producer_confirmed");
      const cart = cartSvc.createCart();
      // The line was added while the price was a scraped 99; the admin then confirmed it at 20.
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-s11', ?, 'p-s11', 'ag-s11', 2, 99)").run(cart.cart_id);
      const before = ordersCount();
      sent.length = 0;
      const sub = cartSvc.submitCart(cart.cart_id, BUYER);
      assertTrue(!sub.success && sub.status === 409 && sub.error.startsWith("price_changed"), "s11-01: submit with a stale price snapshot -> 409 price_changed");
      assertEq(!sub.success ? sub.price_changed_items?.map((i) => i.product_name) : null, ["Pris-vare"], "s11-02: the refusal names the line");
      assertEq(ordersCount(), before, "s11-03: no order row");
      assertEq((db.prepare("SELECT status FROM carts WHERE id = ?").get(cart.cart_id) as any).status, "open", "s11-04: the cart stays open");
      await settle();
      assertEq(sent.length, 0, "s11-05: no e-mail to the producer");
      // Adding the item again takes a fresh snapshot; then the same cart is sent with the confirmed price.
      const re = cartSvc.addCartItem(cart.cart_id, "p-s11", 2);
      assertTrue(re.success === true && re.item.unit_price_snapshot === 20, "s11-06: re-adding takes a fresh snapshot (the confirmed price)");
      const ok = cartSvc.submitCart(cart.cart_id, BUYER);
      assertTrue(ok.success === true && ok.orders.length === 1, "s11-07: with a current snapshot the cart becomes a real order");
      assertEq(ok.success ? ok.orders[0]!.total_nok : null, 40, "s11-08: …at the confirmed price (2 x 20)");
      // F1 (4c): a price INCREASE since the snapshot is refused too (not only a drop).
      addProd("p-s11up", "ag-s11", "Prisøkning-vare", 50, "admin_producer_confirmed");
      const cartUp = cartSvc.createCart();
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-s11up', ?, 'p-s11up', 'ag-s11', 1, 40)").run(cartUp.cart_id);
      const beforeUp = ordersCount();
      sent.length = 0;
      const subUp = cartSvc.submitCart(cartUp.cart_id, BUYER);
      assertTrue(!subUp.success && subUp.status === 409 && subUp.error.startsWith("price_changed"), "s11-10: the price rose from 40 to 50 after the line was added -> 409 price_changed");
      assertEq(!subUp.success ? subUp.price_changed_items?.map((i) => i.product_name) : null, ["Prisøkning-vare"], "s11-11: the refusal names the line");
      assertEq(ordersCount(), beforeUp, "s11-12: no order row after a price increase");
      await settle();
      assertEq(sent.length, 0, "s11-13: no e-mail after a price increase");
      // A drop is still refused (unchanged), and an unchanged price passes.
      db.prepare("UPDATE products SET price_nok = 30 WHERE id = 'p-s11up'").run();
      const subDown = cartSvc.submitCart(cartUp.cart_id, BUYER);
      assertTrue(!subDown.success && subDown.status === 409, "s11-14: a price drop (40 -> 30) is refused too");
      db.prepare("UPDATE products SET price_nok = 40 WHERE id = 'p-s11up'").run();
      const subSame = cartSvc.submitCart(cartUp.cart_id, BUYER);
      assertTrue(subSame.success === true && subSame.orders.length === 1, "s11-15: with the price back at the snapshot the cart becomes a real order");

      // A producer who does not pass the gate: a stale snapshot is irrelevant (contact handoff, no price).
      addAgent("ag-s11c", "S11c Gård", false);
      addProd("p-s11c", "ag-s11c", "Kontaktvare", 10, "enrichment");
      const cart2 = cartSvc.createCart();
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-s11c', ?, 'p-s11c', 'ag-s11c', 1, 77)").run(cart2.cart_id);
      const sub2 = cartSvc.submitCart(cart2.cart_id);
      assertTrue(sub2.success === true && sub2.orders.length === 0 && sub2.contact_handoffs.length === 1, "s11-09: a producer who does not pass the gate is unchanged (handoff)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // F2 — /handleliste shows the server's text on 409 price_changed
    // ════════════════════════════════════════════════════════════════════════
    {
      const page = require("./handleliste-page") as typeof import("./handleliste-page");
      const script = page.HANDELISTE_CLIENT_SCRIPT;
      const grab = (name: string): string => {
        const m = script.match(new RegExp(`  function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}\\n`));
        return m ? m[0] : "";
      };
      const errSrc = grab("errText"), reasonSrc = grab("serverReason"), msgSrc = grab("msg");
      assertTrue(errSrc.length > 0 && reasonSrc.length > 0 && msgSrc.length > 0, "f2-00: the page functions were found");
      const errText = (lang: string) => new Function("C", `${reasonSrc}\n${errSrc}\nreturn errText;`)({ __lang: lang, error_rate: "RATE", error_conflict: "CONFLICT", error_generic: "GENERIC" }) as (r: any) => string;
      const body409 = { success: false, error: cartSvc.PRICE_CHANGED_ERROR };
      assertEq(errText("no")({ status: 409, body: body409 }), cartSvc.PRICE_CHANGED_ERROR.slice("price_changed: ".length).split(" / ")[0], "f2-01: NO page shows the server's Norwegian price_changed text");
      assertEq(errText("en")({ status: 409, body: body409 }), cartSvc.PRICE_CHANGED_ERROR.split(" / ")[1], "f2-02: EN page shows the server's English price_changed text");
      assertEq(errText("no")({ status: 409, body: { error: "something_else: x / y" } }), "CONFLICT", "f2-03: any other 409 keeps the conflict text");
      assertEq(errText("no")({ status: 409, body: {} }), "CONFLICT", "f2-04: a 409 without a body keeps the conflict text");
      assertEq(errText("no")({ status: 500, body: {} }), "GENERIC", "f2-05: other failures stay generic");
      assertEq(errText("no")({ status: 429, body: {} }), "RATE", "f2-06: 429 unchanged");
      assertTrue(/\.textContent\s*=\s*text/.test(msgSrc) && !/innerHTML/.test(msgSrc), "f2-07: the message is set via textContent");
      // The real submit() against the real cart service: a stale snapshot -> the server's 409 text reaches the message line.
      addAgent("ag-f2", "F2 Gård", true);
      addProd("p-f2", "ag-f2", "F2-vare", 20, "admin_producer_confirmed");
      const cartF2 = cartSvc.createCart();
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-f2', ?, 'p-f2', 'ag-f2', 1, 10)").run(cartF2.cart_id);
      const subF2 = cartSvc.submitCart(cartF2.cart_id, BUYER);
      assertTrue(!subF2.success && subF2.status === 409, "f2-08: setup: the real submit is refused with 409");
      if (!subF2.success) assertEq(errText("no")({ status: 409, body: { success: false, error: subF2.error } }).startsWith("prisen på en vare"), true, "f2-09: the real 409 text is what the page shows");
    }

    // ════════════════════════════════════════════════════════════════════════
    // F3 — producer_confirmed on every offer of a producer who takes orders
    // ════════════════════════════════════════════════════════════════════════
    {
      const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
      addAgent("ag-f3", "F3 Gård", true);
      addProd("p-f3-scr", "ag-f3", "Skrapte rødbeter", 25, "enrichment", { category: "vegetables" });
      const res = await findOffers({ q: "rødbeter", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      const o = res.offers.find((x) => x.producer.agent_id === "ag-f3");
      assertTrue(!!o && o.producer.can_order === true, "f3-00: setup: an offer from a producer who takes orders");
      assertEq(o?.producer_confirmed, false, "f3-01: a scraped row without food info carries producer_confirmed:false (contact choice already in step 2)");
      assertEq(o?.food_info, undefined, "f3-02: …and still no food_info");
      addAgent("ag-f3b", "F3b Gård", true);
      addProd("p-f3-adm", "ag-f3b", "Bekreftede rødbeter", 28, "admin_producer_confirmed", { category: "vegetables" });
      const res2 = await findOffers({ q: "rødbeter", lat: LAT, lng: LNG, radiusKm: 50, limit: 10 }, { db });
      assertEq(res2.offers.find((x) => x.producer.agent_id === "ag-f3b")?.producer_confirmed, true, "f3-03: a producer-stated row without food info carries producer_confirmed:true");
      addAgent("ag-f3c", "F3c Gård", false);
      addProd("p-f3-c", "ag-f3c", "Kontakt-rødbeter", 30, "enrichment", { category: "vegetables" });
      const res3 = await findOffers({ q: "rødbeter", lat: LAT, lng: LNG, radiusKm: 50, limit: 10 }, { db });
      const c = res3.offers.find((x) => x.producer.agent_id === "ag-f3c");
      assertTrue(!!c && c.producer.can_order === false && !("producer_confirmed" in c), "f3-04: a producer who does not take orders keeps the old shape (no producer_confirmed)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // T3 — re-arming the test producer: ON CONFLICT sets admin_producer_confirmed
    // ════════════════════════════════════════════════════════════════════════
    {
      const FIX_EMAIL = "post@fixture-inbox.example.no";
      const first = await req("POST", "/admin/test-producer", { email: FIX_EMAIL, apply: true });
      assertTrue(first.status === 200 && first.body?.success === true, "t3-00: setup: the test producer is created and armed");
      const fid = first.body?.agent_id as string;
      const prow = () => db.prepare("SELECT availability, availability_source AS s, id FROM products WHERE agent_id = ? AND name = ?").get(fid, tpMod.TEST_FIXTURE_PRODUCT_NAME) as any;
      assertEq(prow()?.s, "admin_producer_confirmed", "t3-01: a fresh arm writes admin_producer_confirmed");
      // An older fixture: the row exists as a scraped (enrichment) row and is out of stock.
      db.prepare("UPDATE products SET availability_source = 'enrichment', availability = 'out_of_stock' WHERE id = ?").run(prow().id);
      const re = await req("POST", "/admin/test-producer", { email: FIX_EMAIL, apply: true });
      assertTrue(re.status === 200 && re.body?.target === "existing", "t3-02: re-arming targets the existing fixture");
      assertEq([prow().s, prow().availability], ["admin_producer_confirmed", "in_stock"], "t3-03: the existing enrichment row is re-armed as admin_producer_confirmed and in stock");
      // …and the cart accepts it (the rehearsal's real check: no not_producer_confirmed).
      const cart = cartSvc.createCart();
      const add = cartSvc.addCartItem(cart.cart_id, prow().id, 1);
      assertTrue(add.success === true, "t3-04: after re-arming the fixture product can be put in the cart");
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    cartSvc.__setCartTestDb(null);
    tpMod.__setTestProducerDbForTesting(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── order-bestillinger-skive4b tests ──");
  runOrderBestillingerSkive4bTests({ log: true }).then((r) => {
    console.log(`\norder-bestillinger-skive4b: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}

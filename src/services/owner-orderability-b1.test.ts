/**
 * owner-orderability-b1.test.ts — dev-request «RFB bestillinger fra start til
 * slutt for eier», slice B1: the owner sees which items customers can order,
 * why not, and makes them orderable.
 *
 *   gate   isRowOrderableForRealOrder() now runs on the shared core
 *          evaluateOrderability(); over a fixture with one row per reason (and
 *          several clocks) it answers exactly what the pre-B1 gate answered (a
 *          verbatim reference copy below), and orderabilityReasons().orderable
 *          equals the gate for every row.
 *   AC1    the portal's orderability = the gate (same fixture); confirming a
 *          row makes it orderable; with a fixed clock 15 days later it is not,
 *          reason stock_status_expired («Lagerstatus utgått»).
 *   AC2    countOrderableProducts() = the number of rows the gate accepts, and
 *          «Mine valg» shows it.
 *   routes owner-only (no session / other owner / unverified e-mail match /
 *          cross-site rejected), flag off → no card and 404, confirm-one and
 *          confirm-all write source producer_dashboard through the existing
 *          write path, add-product validation.
 *
 * Real routers + services on the production schema in an in-memory DB;
 * handlers pulled off the router stacks (same harness as owner-features-s2e).
 * Exported runOwnerOrderabilityB1Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/owner-orderability-b1.test.ts
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

const FLAG = "OWNER_ORDERABILITY_PORTAL_ENABLED";
const SAVED_ENV = [
  FLAG, "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED", "OWNER_FEATURES_ENFORCE", "SUPPLY_GRAPH_STALE_DAYS",
];

const A = "b1-main";          // eligible producer: one row per product-level reason
const OFF = "b1-orders-off";  // opt-in off
const UNVER = "b1-unverified"; // is_verified = 0
const NOMAIL = "b1-no-mail";  // no e-mail
const BLOCKED = "b1-blocked"; // e-mail blocklisted
const XCHECK = "b1-xcheck";   // cross-check not verified → generic reason
const OTHER = "b1-other";     // another owner
const EMATCH = "b1-ematch";   // session by e-mail match, no verified ownership

const DAY = 86_400_000;

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runOwnerOrderabilityB1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.info(`  ✗ ${label}`);
    }
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
    for (const m of ["../routes/owner-portal", "../routes/owner-features", "./owner-orderability"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const cart = require("./cart-service") as typeof import("./cart-service");
    const sg = require("./supply-graph") as typeof import("./supply-graph");
    const banMod = require("./cart-item-ban") as typeof import("./cart-item-ban");
    const labelMod = require("../utils/category-label") as typeof import("../utils/category-label");
    const oo = require("./owner-orderability") as typeof import("./owner-orderability");
    const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
    const featuresMod = require("../routes/owner-features") as typeof import("../routes/owner-features");

    // ─── Fixture ──────────────────────────────────────────────────────────
    const now = new Date();
    const fresh = sqlTs(new Date(now.getTime() - 1 * DAY));
    const stale = sqlTs(new Date(now.getTime() - 15 * DAY));
    function seedProducer(id: string, o: { verified?: number; optIn?: number; email?: string; xcheck?: string; claimed?: boolean } = {}): void {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent B1.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, ?, ?)`,
      ).run(id, `B1 Gard ${id}`, o.email ?? `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
        o.verified ?? 1, o.claimed === false ? null : "2026-10-01T00:00:00.000Z", o.optIn ?? 1);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten gård.', ?, 0)`,
      ).run(id, `post@${id}.example.no`, `https://${id}.example.no`, o.xcheck ?? "verified");
      // B1b-1: the product-write POSTs need a session opened by the verified
      // claimant's own e-mail; the claimed producers' sessions are.
      if (o.claimed !== false) {
        db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
        ).run(`claim-${id}`, id, `post@${id}.example.no`);
      }
    }
    function seedProduct(agentId: string, pid: string, p: { name: string; price?: number | null; availability: string; source: string; updated?: string | null; category?: string | null }): void {
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
         VALUES (?, ?, ?, ?, ?, 'stk', ?, ?, ?, ?)`,
      ).run(pid, agentId, p.name, p.name.toLowerCase(), p.price === undefined ? 30 : p.price, p.availability, p.category ?? null, p.source, p.updated ?? null);
    }
    seedProducer(A);
    seedProducer(OFF, { optIn: 0 });
    seedProducer(UNVER, { verified: 0 });
    seedProducer(NOMAIL, { email: "" });
    seedProducer(BLOCKED, { email: "sperret@b1-blocked.example.no" });
    seedProducer(XCHECK, { xcheck: "pending" });
    seedProducer(OTHER);
    seedProducer(EMATCH, { claimed: false });
    db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('email', 'sperret@b1-blocked.example.no', 'test')`).run();

    // One row per reason (product level at A, profile level at the others).
    const FIX: Array<{ pid: string; agent: string; expect: string[] }> = [];
    const add = (agent: string, pid: string, p: Parameters<typeof seedProduct>[2], expect: string[]) => { seedProduct(agent, pid, p); FIX.push({ pid, agent, expect }); };
    add(A, "b1-ok-dash", { name: "Gulrøtter", availability: "in_stock", source: "producer_dashboard", updated: fresh }, []);
    add(A, "b1-ok-admin", { name: "Poteter", availability: "in_stock", source: "admin_producer_confirmed" }, []);
    add(A, "b1-label", { name: "Honning", price: null, availability: "in_stock", source: "enrichment" }, ["category_label", "not_confirmed_by_owner"]);
    add(A, "b1-alcohol", { name: "Eplesider", availability: "in_stock", source: "producer_dashboard", updated: fresh }, ["alcohol"]);
    add(A, "b1-service", { name: "Omvisning på gården", availability: "in_stock", source: "producer_dashboard", updated: fresh, category: "experiences" }, ["service"]);
    add(A, "b1-expired", { name: "Løk", availability: "in_stock", source: "producer_dashboard", updated: stale }, ["stock_status_expired"]);
    add(A, "b1-expired-null", { name: "Kål", availability: "in_stock", source: "producer_dashboard", updated: null }, ["stock_status_expired"]);
    add(A, "b1-out", { name: "Purre", availability: "out_of_stock", source: "producer_dashboard", updated: fresh }, ["not_in_stock"]);
    add(A, "b1-unconfirmed", { name: "Rødbeter", availability: "in_stock", source: "enrichment" }, ["not_confirmed_by_owner"]);
    // Follow-up: an unpriced scraped row (no gate reason for the missing price; the portal refuses to confirm it).
    add(A, "b1-noprice", { name: "Hjemmelaget pesto", price: null, availability: "in_stock", source: "enrichment" }, ["not_confirmed_by_owner"]);
    add(A, "b1-out-unconfirmed", { name: "Squash", availability: "out_of_stock", source: "enrichment" }, ["not_in_stock", "not_confirmed_by_owner"]);
    add(OFF, "b1-off", { name: "Egg", availability: "in_stock", source: "admin_producer_confirmed" }, ["orders_off"]);
    add(UNVER, "b1-unver", { name: "Egg", availability: "in_stock", source: "admin_producer_confirmed" }, ["owner_not_verified"]);
    add(NOMAIL, "b1-nomail", { name: "Egg", availability: "in_stock", source: "admin_producer_confirmed" }, ["order_email_missing"]);
    add(BLOCKED, "b1-blocked", { name: "Egg", availability: "in_stock", source: "admin_producer_confirmed" }, ["order_email_suppressed"]);
    add(XCHECK, "b1-xcheck", { name: "Egg", availability: "in_stock", source: "admin_producer_confirmed" }, ["producer_not_eligible"]);
    seedProduct(OTHER, "b1-other-row", { name: "Egg", availability: "in_stock", source: "enrichment" });

    const ROW_SQL = `SELECT id, agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE id = ?`;
    const rowOf = (pid: string) => db.prepare(ROW_SQL).get(pid) as any;

    // Verbatim reference copy of the pre-B1 gate (cart-service.ts at f9c704d).
    function producerTypesOf(agentId: string): string[] {
      try {
        const row = db.prepare("SELECT categories, tags FROM agents WHERE id = ?").get(agentId) as any;
        if (!row) return [];
        const out: string[] = [];
        for (const raw of [row.categories, row.tags]) {
          if (!raw) continue;
          try { const arr = JSON.parse(raw); if (Array.isArray(arr)) for (const v of arr) if (typeof v === "string") out.push(v); } catch { /* */ }
        }
        return out;
      } catch { return []; }
    }
    function legacyGate(row: any, at: Date): boolean {
      if (labelMod.isCategoryLabel({ name: row.name, hasPrice: row.price_nok != null, availabilitySource: row.availability_source })) return false;
      let banned = false;
      try {
        banned = !!banMod.classifyCartItemBan({ name: row.name, description: row.description, category: row.category, producerTypes: producerTypesOf(row.agent_id) });
      } catch { banned = true; }
      if (banned) return false;
      if (sg.computeEffectiveAvailability(row.availability, row.availability_updated_at, row.availability_source ?? "", at) !== "in_stock") return false;
      if (!cart.isProducerStatedSource(row.availability_source)) return false;
      try { return cart.isEligibleForRealOrder(row.agent_id, db); } catch { return false; }
    }

    // ═══ gate unchanged + reasons match ════════════════════════════════════
    {
      const clocks = [now, new Date(now.getTime() + 13 * DAY), new Date(now.getTime() + 14 * DAY), new Date(now.getTime() + 30 * DAY), new Date(now.getTime() - 400 * DAY)];
      let same = 0;
      let agree = 0;
      let checks = 0;
      for (const f of FIX) {
        for (const at of clocks) {
          const row = rowOf(f.pid);
          const gate = cart.isRowOrderableForRealOrder(db, row, at);
          checks++;
          if (gate === legacyGate(row, at)) same++;
          if (cart.orderabilityReasons(db, row, at).orderable === gate) agree++;
        }
      }
      assertEq(same, checks, `gate: isRowOrderableForRealOrder equals the pre-B1 gate for every fixture row × clock (${checks})`);
      assertEq(agree, checks, `gate: orderabilityReasons().orderable equals the gate for every fixture row × clock (${checks})`);
      for (const f of FIX) {
        const r = cart.orderabilityReasons(db, rowOf(f.pid), now);
        assertEq(r.reasons.map((x) => x.code), f.expect, `reasons: ${f.pid} → ${f.expect.join(", ") || "orderable"}`);
        assertEq(r.orderable, f.expect.length === 0, `reasons: ${f.pid} orderable = no reasons`);
      }
      // Precomputed producer verdict gives the same answer.
      const prod = cart.producerOrderability(db, A);
      for (const f of FIX.filter((x) => x.agent === A)) {
        assertEq(cart.orderabilityReasons(db, rowOf(f.pid), now, prod).reasons, cart.orderabilityReasons(db, rowOf(f.pid), now).reasons, `reasons: ${f.pid} with a precomputed producer verdict`);
      }
      // A product reason and a profile reason together.
      const both = cart.orderabilityReasons(db, { ...rowOf("b1-off"), availability: "out_of_stock" }, now);
      assertEq(both.reasons.map((x) => [x.code, x.level]), [["not_in_stock", "product"], ["orders_off", "profile"]], "reasons: product and profile reasons are both listed");
      const exp = cart.orderabilityReasons(db, rowOf("b1-expired"), now).reasons[0];
      assertTrue(!!exp.expired_at && Math.abs(new Date(exp.expired_at).getTime() - (now.getTime() - DAY)) < 2000, "reasons: stock_status_expired carries the expiry date (set + 14 days)");
      assertEq(cart.orderabilityReasons(db, rowOf("b1-expired-null"), now).reasons[0].expired_at, null, "reasons: never-set timestamp → expired_at null");
      // Read errors stay «no» in both.
      const broken = { prepare() { throw new Error("db down"); }, transaction: db.transaction.bind(db) };
      const okRow = rowOf("b1-ok-admin");
      assertEq([cart.isRowOrderableForRealOrder(broken, okRow, now), cart.orderabilityReasons(broken, okRow, now).orderable], [false, false], "gate: a profile read error is «no» in both");
      // A throwing ban classifier (String(description) throws inside classifyCartItemBan) is fail-closed.
      const throwing = { ...rowOf("b1-ok-admin"), description: { toString() { throw new Error("classifier boom"); } } as any };
      assertEq(cart.isRowOrderableForRealOrder(db, throwing, now), false, "gate: a throwing ban classifier → not orderable");
      assertEq(legacyGate(throwing, now), false, "gate: the pre-B1 gate also refused it");
      const tr = cart.orderabilityReasons(db, throwing, now);
      assertEq([tr.orderable, tr.reasons.map((x) => x.code)], [false, ["ban_check_failed"]], "reasons: a throwing ban classifier → ban_check_failed");
      // The missing-price rule is portal-only: the gate still accepts an unpriced producer-stated row.
      const unpriced = { ...rowOf("b1-ok-dash"), price_nok: null };
      assertEq([cart.isRowOrderableForRealOrder(db, unpriced, now), legacyGate(unpriced, now), cart.orderabilityReasons(db, unpriced, now).orderable], [true, true, true],
        "gate: an unpriced producer-stated row is unchanged by the portal's price rule");
    }

    // ═══ AC1 — portal = gate; confirm → orderable; +15 days → expired ═════════
    {
      const ov = oo.listOwnerProductOrderability(A, db, now);
      const byGate = ov.products.map((p) => [p.id, cart.isRowOrderableForRealOrder(db, rowOf(p.id), now)]);
      assertEq(ov.products.map((p) => [p.id, p.orderable]), byGate, "AC1: the portal's orderability per row equals isRowOrderableForRealOrder");
      assertEq(ov.orderable_count, 2, "AC1: 2 of A's rows can be ordered");
      assertEq(ov.products.filter((p) => !p.confirmable).map((p) => p.id).sort(), ["b1-alcohol", "b1-label", "b1-noprice", "b1-service"], "AC1: category labels, alcohol/services and unpriced rows get no confirm button");
      const np = ov.products.find((p) => p.id === "b1-noprice")!;
      assertEq([np.missing_price, np.confirmable, np.reasons.map((x) => x.code)], [true, false, ["not_confirmed_by_owner"]], "AC1: an unpriced row is flagged missing_price in the portal only");
      const offOv = oo.listOwnerProductOrderability(OFF, db, now);
      assertEq(offOv.profile_reasons.map((r) => r.code), ["orders_off"], "AC1: profile-level reasons are listed once for the card");

      const r = oo.confirmOwnerProductInStock(A, "b1-unconfirmed", { db, actorEmail: "eier@b1" });
      assertEq(r, { ok: true, confirmed: 1 }, "AC1: confirm one → ok");
      const row = rowOf("b1-unconfirmed");
      assertEq([row.availability, row.availability_source], ["in_stock", "producer_dashboard"], "AC1: the row is now producer_dashboard / in_stock");
      assertTrue(cart.isRowOrderableForRealOrder(db, row, now) && cart.orderabilityReasons(db, row, now).orderable, "AC1: confirming makes the row orderable (gate and portal)");
      const later = new Date(Date.now() + 15 * DAY);
      assertEq(cart.isRowOrderableForRealOrder(db, row, later), false, "AC1: 15 days later the gate says no");
      const lr = cart.orderabilityReasons(db, row, later);
      assertEq(lr.reasons.map((x) => x.code), ["stock_status_expired"], "AC1: 15 days later the reason is stock_status_expired");
      assertTrue(oo.orderabilityReasonTextNb(lr.reasons[0]).startsWith("Lagerstatus utgått"), "AC1: the owner reads «Lagerstatus utgått …»");
      assertTrue(cart.orderabilityReasons(db, row, now).stock_expires_at !== null, "AC1: an orderable producer_dashboard row says until when");
    }

    // ═══ AC2 — the one count ══════════════════════════════════════════════
    {
      const rows = db.prepare("SELECT agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE agent_id = ?").all(A) as any[];
      const direct = rows.filter((x) => cart.isRowOrderableForRealOrder(db, x, now)).length;
      assertEq([cart.countOrderableProducts(A, db, now), direct], [3, 3], "AC2: countOrderableProducts = rows the gate accepts");
      assertEq(cart.countOrderableProducts(OFF, db, now), 0, "AC2: orders off → the gate accepts none");
      assertEq(featuresMod.countOwnerOrderableItems(OFF, db, now), 1, "AC2: «Mine valg» still counts as if orders were on (S2e, rolled back)");
      assertEq(featuresMod.countOwnerOrderableItems(A, db, now), cart.countOrderableProducts(A, db, now), "AC2: «Mine valg» count = countOrderableProducts (orders on)");
      setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", `rfb:${A}`);
    }

    // ─── Sessions ─────────────────────────────────────────────────────────
    const tokens: Record<string, string> = {};
    for (const id of [A, OFF, OTHER, EMATCH]) {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    }
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      one: findRouteHandler(portalMod.default, "/eier/:agentId/varer/:productId/bekreft", "post"),
      all: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-alle", "post"),
      ny: findRouteHandler(portalMod.default, "/eier/:agentId/varer/ny", "post"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
    };
    const portal = async (id: string, query: Record<string, string> = {}) => String((await invoke(H.portal, makeReq({ params: { agentId: id }, query, token: tokens[id] }))).body ?? "");
    const post = (h: Function, params: Record<string, string>, token: string | undefined, body: any = {}, headers: Record<string, string> = {}) =>
      invoke(h, makeReq({ params, body, token, headers }));
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    const src = (pid: string) => (db.prepare("SELECT availability_source AS s FROM products WHERE id = ?").get(pid) as any)?.s;

    // AC2 on the page.
    {
      const html = String((await invoke(H.valg, makeReq({ params: { agentId: A }, token: tokens[A] }))).body ?? "");
      const n = cart.countOrderableProducts(A, db);
      assertTrue(html.includes(`Du har ${n} varer som kan bestilles.`) && html.includes(`data-orderable="${n}"`), `AC2: «Mine valg» shows countOrderableProducts (${n})`);
    }

    // ═══ flag off → no change ═════════════════════════════════════════════
    {
      const html = await portal(A, { status: "vare_bekreftet" });
      assertTrue(html.includes("Profilinformasjon"), "flag off: the portal renders");
      assertTrue(!html.includes("bestillbare-varer") && !html.includes("Varer som kan bestilles") && !html.includes("Varen er bekreftet"), "flag off: no card and no B1 alert");
      const before = src("b1-out-unconfirmed");
      for (const [h, params] of [[H.one, { agentId: A, productId: "b1-out-unconfirmed" }], [H.all, { agentId: A }], [H.ny, { agentId: A }]] as Array<[Function, Record<string, string>]>) {
        assertEq((await post(h, params, tokens[A], { name: "Ny", price: "10" })).status, 404, `flag off: POST → 404 (${Object.keys(params).join(",")})`);
      }
      assertEq(src("b1-out-unconfirmed"), before, "flag off: nothing written");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ? AND name = 'Ny'").get(A) as any).n, 0, "flag off: no product added");
    }

    setEnv(FLAG, "1");
    // B1a: the card and the routes are only for allowlisted subjects; the
    // producers whose card is exercised below are put on the list.
    setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", [A, OFF, OTHER, EMATCH].map((id) => `rfb:${id}`).join(","));

    // ═══ the card ═════════════════════════════════════════════════════════
    {
      const html = await portal(A);
      assertTrue(html.includes(`id="bestillbare-varer"`) && html.includes("Varer som kan bestilles"), "card: shown with the flag on");
      const n = cart.countOrderableProducts(A, db);
      assertTrue(html.includes(`data-orderable-count="${n}"`) && html.includes(`${n} av ${FIX.filter((f) => f.agent === A).length} varer kan bestilles nå.`), "card: the count equals countOrderableProducts");
      assertTrue(html.includes("Kan bestilles") && html.includes("Kan ikke bestilles"), "card: «Kan bestilles» / «Kan ikke bestilles»");
      for (const t of ["Dette er et kategorinavn, ikke en vare", "Alkohol kan ikke bestilles her", "Tjenester og opplevelser kan ikke bestilles her", "Lagerstatus utgått", "Ikke registrert på lager", "Ikke bekreftet av deg ennå"]) {
        assertTrue(html.includes(t), `card: reason text «${t}»`);
      }
      assertTrue(html.includes(`action="/eier/${A}/varer/b1-out/bekreft"`) && !html.includes(`action="/eier/${A}/varer/b1-label/bekreft"`), "card: confirm button per confirmable row only");
      assertTrue(!html.includes(`action="/eier/${A}/varer/b1-noprice/bekreft"`) && html.includes(`data-missing-price="1"`) && html.includes("Mangler pris"), "card: an unpriced row gets «Mangler pris» and no confirm button");
      assertTrue(html.includes("Bekreft at varen er på lager") && html.includes("Bekreft alle på lager") && html.includes(`action="/eier/${A}/varer/ny"`), "card: the buttons and the add form");
      const offHtml = await portal(OFF);
      assertTrue(offHtml.includes(`data-orderability-profile="blocked"`) && offHtml.includes("Bestillinger er slått av"), "card: profile-level reason shown");
      assertTrue((await portal(EMATCH)).indexOf("bestillbare-varer") === -1, "card: not for a session without verified ownership");
      const ok = await portal(A, { status: "vare_bekreftet" });
      assertTrue(ok.includes("Varen er bekreftet på lager."), "card: alert after confirm");
      const bad = await portal(A, { status: "vare_ugyldig", felt: "price,<i>zz</i>" });
      assertTrue(bad.includes("Pris må være et tall over 0") && !bad.includes("<i>zz</i>") && !bad.includes("&lt;i&gt;zz"), "card: invalid-field alert, unknown fields ignored");
    }

    // ═══ owner-only ═══════════════════════════════════════════════════════
    {
      const before = src("b1-out");
      // XSS: hostile product name and unit are escaped in the card.
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source) VALUES ('b1-xss', ?, ?, ?, 10, ?, 'in_stock', 'enrichment')`)
        .run(OTHER, "<script>alert(1)</script>", "<script>alert(1)</script>", `"><img src=x>`);
      const xh = await portal(OTHER);
      assertTrue(xh.includes(`id="bestillbare-varer"`), "xss: the card renders for the hostile row's owner");
      assertTrue(!xh.includes("<script>alert(1)</script>") && !xh.includes("<img src=x>"), "xss: no raw tags from the product name or unit");
      assertTrue(xh.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && xh.includes("&quot;&gt;&lt;img src=x&gt;"), "xss: the name and unit are shown escaped");
      db.prepare("DELETE FROM products WHERE id = 'b1-xss'").run();

      const anon = await post(H.one, { agentId: A, productId: "b1-out" }, undefined);
      assertEq([anon.status, loc(anon)], [303, `/eier/${A}`], "auth: no session → login");
      const other = await post(H.one, { agentId: A, productId: "b1-out" }, tokens[OTHER]);
      assertEq([other.status, loc(other)], [303, `/eier/${A}`], "auth: another owner's session → login, not the write");
      const ematch = await post(H.all, { agentId: EMATCH }, tokens[EMATCH]);
      assertEq(ematch.status, 403, "auth: e-mail-match session without verified ownership → 403");
      const xs = await post(H.one, { agentId: A, productId: "b1-out" }, tokens[A], {}, { origin: "https://evil.example" });
      assertEq(xs.status, 403, "auth: cross-site Origin → 403");
      const anonNew = await post(H.ny, { agentId: A }, undefined, { name: "Snik", price: "10" });
      assertEq(anonNew.status, 303, "auth: add without session → login");
      assertEq(src("b1-out"), before, "auth: nothing written by rejected calls");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM products WHERE name = 'Snik'").get() as any).n, 0, "auth: no product added by rejected calls");
      const foreign = await post(H.one, { agentId: A, productId: "b1-other-row" }, tokens[A]);
      assertEq([foreign.status, src("b1-other-row")], [404, "enrichment"], "auth: another producer's product id → 404, untouched");
    }

    // ═══ confirm one / confirm all ════════════════════════════════════════
    {
      const audits0 = (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ?").get(A) as any).n;
      const r = await post(H.one, { agentId: A, productId: "b1-out" }, tokens[A], {}, { origin: "https://rettfrabonden.com" });
      assertEq([r.status, loc(r)], [303, `/eier/${A}/portal?status=vare_bekreftet#bestillbare-varer`], "confirm one: 303 back to the card");
      const row = rowOf("b1-out");
      assertEq([row.availability, row.availability_source], ["in_stock", "producer_dashboard"], "confirm one: in_stock, source producer_dashboard");
      assertTrue(cart.isRowOrderableForRealOrder(db, row), "confirm one: now orderable");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ?").get(A) as any).n, audits0 + 1, "confirm one: an audit row");
      const npr = await post(H.one, { agentId: A, productId: "b1-noprice" }, tokens[A]);
      assertEq([loc(npr), src("b1-noprice")], [`/eier/${A}/portal?status=vare_mangler_pris#bestillbare-varer`, "enrichment"], "confirm one: an unpriced row is refused, nothing written");
      assertTrue((await portal(A, { status: "vare_mangler_pris" })).includes("Varen mangler pris, så den kan ikke bekreftes her. Legg inn pris først."), "confirm one: the refusal message");
      const lab = await post(H.one, { agentId: A, productId: "b1-label" }, tokens[A]);
      assertEq([loc(lab), src("b1-label")], [`/eier/${A}/portal?status=vare_kan_ikke_bekreftes#bestillbare-varer`, "enrichment"], "confirm one: a category label is not confirmed");

      const all = await post(H.all, { agentId: A }, tokens[A]);
      assertEq(loc(all), `/eier/${A}/portal?status=varer_bekreftet&uten_pris=1#bestillbare-varer`, "confirm all: 303 back, with the number of unpriced rows skipped");
      assertEq(src("b1-noprice"), "enrichment", "confirm all: an unpriced row is not confirmed");
      const msg = await portal(A, { status: "varer_bekreftet", uten_pris: "1" });
      assertTrue(msg.includes("Varene er bekreftet på lager. 1 vare uten pris ble ikke bekreftet — legg inn pris først."), "confirm all: the owner is told the unpriced rows were skipped");
      const msgBad = await portal(A, { status: "varer_bekreftet", uten_pris: "<b>" });
      assertTrue(msgBad.includes("Varene er bekreftet på lager.") && !msgBad.includes("uten pris ble ikke"), "confirm all: a non-numeric uten_pris is ignored");
      const after = db.prepare("SELECT id, availability, availability_source FROM products WHERE agent_id = ? ORDER BY id").all(A) as any[];
      const by = Object.fromEntries(after.map((x) => [x.id, [x.availability, x.availability_source]]));
      for (const pid of ["b1-ok-dash", "b1-expired", "b1-expired-null", "b1-out", "b1-unconfirmed", "b1-out-unconfirmed"]) {
        assertEq(by[pid], ["in_stock", "producer_dashboard"], `confirm all: ${pid} → in_stock / producer_dashboard`);
      }
      assertEq(by["b1-ok-admin"], ["in_stock", "admin_producer_confirmed"], "confirm all: an admin-confirmed row keeps its source (existing write path)");
      assertEq([by["b1-label"], by["b1-alcohol"][1], by["b1-service"][1]], [["in_stock", "enrichment"], "producer_dashboard", "producer_dashboard"], "confirm all: label untouched (alcohol/service rows keep their seeded values)");
      assertEq(cart.countOrderableProducts(A, db), 7, "confirm all: every confirmable row is orderable");
      assertEq(src("b1-other-row"), "enrichment", "confirm all: another producer's rows untouched");
    }

    // ═══ add product ══════════════════════════════════════════════════════
    {
      const bad = async (body: any, felt: string, label: string) => {
        const r = await post(H.ny, { agentId: A }, tokens[A], body);
        assertEq(loc(r), `/eier/${A}/portal?status=vare_ugyldig&felt=${encodeURIComponent(felt)}#bestillbare-varer`, label);
      };
      const n0 = (db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ?").get(A) as any).n;
      await bad({ name: "", price: "10" }, "name", "add: missing name → felt=name");
      await bad({ name: "Syltetøy", price: "" }, "price", "add: missing price → felt=price");
      await bad({ name: "Syltetøy", price: "-5" }, "price", "add: negative price → felt=price");
      await bad({ name: "Syltetøy", price: "abc" }, "price", "add: text price → felt=price");
      await bad({ name: "Syltetøy", price: "10", net_weight: "mye" }, "net_weight", "add: bad net weight → felt=net_weight");
      await bad({ name: "x".repeat(121), price: "10" }, "name", "add: name too long → felt=name");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ?").get(A) as any).n, n0, "add: nothing written on invalid input");

      const ok = await post(H.ny, { agentId: A }, tokens[A], { name: "Bringebærsyltetøy", price: "89,50", unit: "glass", ingredients: "Bringebær, sukker", allergens: "", net_weight: "350 g" });
      assertEq(loc(ok), `/eier/${A}/portal?status=vare_lagt_til#bestillbare-varer`, "add: valid → 303 vare_lagt_til");
      const p = db.prepare("SELECT * FROM products WHERE agent_id = ? AND name = 'Bringebærsyltetøy'").get(A) as any;
      assertEq([p.price_nok, p.unit, p.availability, p.availability_source, p.ingredients, p.allergens, p.net_weight, p.name_norm],
        [89.5, "glass", "in_stock", "producer_dashboard", "Bringebær, sukker", null, "350 g", "bringebærsyltetøy"], "add: stored with the owner's values; empty allergens = not stated (NULL)");
      assertTrue(cart.isRowOrderableForRealOrder(db, p), "add: the new product is orderable");
      const ok2 = await post(H.ny, { agentId: A }, tokens[A], { name: "Blåbærsyltetøy", price: "79", allergens: "Melk, egg" });
      assertEq(loc(ok2), `/eier/${A}/portal?status=vare_lagt_til#bestillbare-varer`, "add: second product");
      assertEq((db.prepare("SELECT allergens FROM products WHERE agent_id = ? AND name = 'Blåbærsyltetøy'").get(A) as any).allergens, `["melk","egg"]`, "add: allergens stored as a list");
      const dup = await post(H.ny, { agentId: A }, tokens[A], { name: "  bringebærsyltetøy ", price: "10" });
      assertEq(loc(dup), `/eier/${A}/portal?status=vare_finnes#bestillbare-varer`, "add: same name → vare_finnes");
      assertEq((db.prepare("SELECT price_nok FROM products WHERE agent_id = ? AND name_norm = 'bringebærsyltetøy'").get(A) as any).price_nok, 89.5, "add: a duplicate never overwrites");
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
  runOwnerOrderabilityB1Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

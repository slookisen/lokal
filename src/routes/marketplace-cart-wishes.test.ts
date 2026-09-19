/**
 * marketplace-cart-wishes.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 1.
 *
 * Route-level coverage for cartRouter's new wishes endpoints + the extended
 * submit endpoint (src/routes/marketplace-cart.ts):
 *   POST   /cart/:id/wishes
 *   PATCH  /cart/:id/wishes/:wid
 *   DELETE /cart/:id/wishes/:wid
 *   POST   /cart/:id/submit         (contact fields + honeypot + contact_handoffs)
 *
 * Also proves cartWishesLimiter (express-rate-limit) is actually wired on
 * all four routes AND that it actually trips (real request-driven 429, not
 * just a by-reference wiring check — cheap here since max=20/min and this
 * suite only needs one burst).
 *
 * Harness mirrors marketplace-catalog-offers.test.ts / opplevelser-booking-
 * send-guard.test.ts: router.handle(req, res, next) driven directly with a
 * hand-built req/res — no HTTP server, no body-parser (body is preset on
 * the fake req, same as every other POST-body test in this codebase). The
 * res object additionally implements setHeader/getHeader (no-ops) because,
 * unlike those other suites, this one exercises the REAL cartWishesLimiter
 * in the route stack, which needs them.
 *
 * Standalone: npx tsx src/routes/marketplace-cart-wishes.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const queryString = opts.url.split("?")[1] || "";
    const query: Record<string, string> = {};
    for (const pair of queryString.split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url.split("?")[0],
      query,
      params: {},
      headers,
      body: opts.body ?? {},
      ip: "203.0.113.7",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      _headers: {} as Record<string, string>,
      setHeader(name: string, value: unknown) {
        this._headers[name] = String(value);
        return this;
      },
      getHeader(name: string) {
        return this._headers[name];
      },
      removeHeader() {},
      append() {},
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload: any) {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined });
    });
  });
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
}

function findLayers(router: { stack: RouteLayer[] }, path: string, method: string): NonNullable<RouteLayer["route"]>[] {
  return router.stack
    .map((l) => l.route)
    .filter((r): r is NonNullable<RouteLayer["route"]> => !!r && r.path === path && !!(r.methods as any)[method]);
}

export async function runMarketplaceCartWishesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const { cartRouter } = require("./marketplace-cart") as typeof import("./marketplace-cart");
  const { cartWishesLimiter } = require("../middleware/security") as typeof import("../middleware/security");

  const prevDb = (() => {
    try { return initMod.getDb(); } catch { return undefined; }
  })();

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-a', 'Gard A', 'test', 'test', 'a@example.com', 'https://example.com', 'producer', 'key-a')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line, phone, email)
      VALUES ('agent-a', 'verified', 0, '+47 90000001', 'a@example.com')
    `).run();
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source)
      VALUES ('prod-a', 'agent-a', 'Poteter', 'poteter', 20, 'kg', 'in_stock', 'enrichment')
    `).run();

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-b', 'Gard B (kun kontakt)', 'test', 'test', 'b@example.com', 'https://example.com', 'producer', 'key-b')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line, phone, email)
      VALUES ('agent-b', 'verified', 1, '+47 90000002', 'b@example.com')
    `).run();

    // ═══════════ Wiring: cartWishesLimiter is on all four routes (by ═════
    // ═══════════ reference), BEFORE the final handler ═════════════════════

    for (const [path, method] of [
      ["/cart/:id/wishes", "post"],
      ["/cart/:id/wishes/:wid", "patch"],
      ["/cart/:id/wishes/:wid", "delete"],
      ["/cart/:id/submit", "post"],
    ] as const) {
      const layers = findLayers(cartRouter as any, path, method);
      assertEq(layers.length, 1, `wiring: exactly one ${method.toUpperCase()} ${path} route registered`);
      const layer = layers[0];
      if (layer) {
        const idx = layer.stack.findIndex((s) => s.handle === cartWishesLimiter);
        assertTrue(idx >= 0, `wiring: cartWishesLimiter is wired on ${method.toUpperCase()} ${path} (by reference, the real exported instance)`);
        assertTrue(idx >= 0 && idx < layer.stack.length - 1, `wiring: cartWishesLimiter runs BEFORE the final handler on ${method.toUpperCase()} ${path}, not after`);
      }
    }

    // ═══════════ Full happy-path flow ══════════════════════════════════════

    let cartId = "";
    let buyerRef = "";
    {
      const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
      assertEq(created.status, 201, "POST /cart: 201");
      cartId = created.body.cart_id;
      buyerRef = created.body.buyer_ref;
      assertTrue(!!cartId && !!buyerRef, "POST /cart: returns cart_id + buyer_ref");
    }

    let orderWishId = "";
    {
      const r = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cartId}/wishes`,
        headers: { "x-cart-token": buyerRef },
        body: { term: "Poteter", qty: 2, unit_hint: "kg" },
      });
      assertEq(r.status, 201, "POST /cart/:id/wishes: 201");
      assertTrue(r.body.success === true && !!r.body.wish?.id, "POST /cart/:id/wishes: returns the created wish");
      orderWishId = r.body.wish.id;
    }

    let contactWishId = "";
    {
      const r = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cartId}/wishes`,
        headers: { "x-cart-token": buyerRef },
        body: { term: "Honning", qty: 1 },
      });
      assertEq(r.status, 201, "POST /cart/:id/wishes (2nd wish): 201");
      contactWishId = r.body.wish.id;
    }

    {
      // Wrong token → 403, no leak of wish state.
      const r = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cartId}/wishes`,
        headers: { "x-cart-token": "wrong-token" },
        body: { term: "Egg", qty: 1 },
      });
      assertEq(r.status, 403, "POST /cart/:id/wishes: wrong token → 403");
    }

    {
      const r = await callRoute(cartRouter, {
        method: "PATCH",
        url: `/cart/${cartId}/wishes/${orderWishId}`,
        headers: { "x-cart-token": buyerRef },
        body: { product_id: "prod-a" },
      });
      assertEq(r.status, 200, "PATCH wishes/:wid (product_id): 200");
      assertEq(r.body.wish?.mode, "order", "PATCH wishes/:wid (product_id): mode='order'");
      assertTrue(r.body.cart?.groups?.some((g: any) => g.agent_id === "agent-a"), "PATCH wishes/:wid (product_id): mirrored into the cart view's groups");
    }

    {
      const r = await callRoute(cartRouter, {
        method: "PATCH",
        url: `/cart/${cartId}/wishes/${contactWishId}`,
        headers: { "x-cart-token": buyerRef },
        body: { agent_id: "agent-b" },
      });
      assertEq(r.status, 200, "PATCH wishes/:wid (agent_id/contact): 200");
      assertEq(r.body.wish?.mode, "contact", "PATCH wishes/:wid (agent_id/contact): mode='contact'");
    }

    {
      // Honeypot filled → rejected, no state change.
      const r = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cartId}/submit`,
        headers: { "x-cart-token": buyerRef },
        body: { buyer_ref: buyerRef, website: "https://spambot.example" },
      });
      assertEq(r.status, 400, "POST /cart/:id/submit: honeypot ('website') filled → 400");
      assertTrue(r.body.success === false, "POST /cart/:id/submit: honeypot rejection has success:false");

      const cartStillOpen = db.prepare("SELECT status FROM carts WHERE id = ?").get(cartId) as any;
      assertEq(cartStillOpen.status, "open", "POST /cart/:id/submit: honeypot rejection leaves the cart 'open' (no submit side effect)");
    }

    {
      const r = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cartId}/submit`,
        headers: { "x-cart-token": buyerRef },
        body: {
          buyer_ref: buyerRef,
          buyer_name: "Kari Testperson",
          buyer_email: "kari@example.com",
          contact_consent: true,
        },
      });
      assertEq(r.status, 201, "POST /cart/:id/submit: 201 on the real submit");
      assertEq(r.body.orders?.length, 1, "POST /cart/:id/submit: one order (the eligible producer's chosen offer)");
      assertEq(r.body.contact_handoffs?.length, 1, "POST /cart/:id/submit: one contact_handoffs entry (the contact-mode wish)");
      assertEq(r.body.contact_handoffs?.[0]?.agent_id, "agent-b", "POST /cart/:id/submit: handoff for the correct producer");
    }

    // ═══════════ DELETE wishes/:wid on an already-submitted (non-open) ═════
    // ═══════════ cart is rejected, not silently accepted ═══════════════════

    {
      const r = await callRoute(cartRouter, {
        method: "DELETE",
        url: `/cart/${cartId}/wishes/${orderWishId}?buyer_ref=${buyerRef}`,
        headers: {},
      });
      assertEq(r.status, 409, "DELETE wishes/:wid on a submitted cart: 409, not silently accepted");
    }

    // ═══════════ DELETE wishes/:wid on an OPEN cart succeeds (separate cart) ═

    {
      const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
      const cid = created.body.cart_id;
      const bref = created.body.buyer_ref;
      const w = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cid}/wishes`,
        headers: { "x-cart-token": bref },
        body: { term: "Smør", qty: 1 },
      });
      const wid = w.body.wish.id;
      const del = await callRoute(cartRouter, {
        method: "DELETE",
        url: `/cart/${cid}/wishes/${wid}?buyer_ref=${bref}`,
        headers: {},
      });
      assertEq(del.status, 200, "DELETE wishes/:wid on an open cart: 200");
      const remaining = db.prepare("SELECT COUNT(*) as c FROM cart_wishes WHERE cart_id = ?").get(cid) as any;
      assertEq(remaining.c, 0, "DELETE wishes/:wid: wish actually removed from the DB");
    }

    // ═══════════ Rate limit actually trips (real request-driven 429) ═══════
    // cartWishesLimiter: max 20/min, keyed on ip+buyer_ref — same ip+buyer_ref
    // for every call below drives the SAME bucket past its limit.

    {
      const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
      const cid = created.body.cart_id;
      const bref = created.body.buyer_ref;

      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        const r = await callRoute(cartRouter, {
          method: "POST",
          url: `/cart/${cid}/wishes`,
          headers: { "x-cart-token": bref },
          body: { term: `Vare ${i}`, qty: 1 },
        });
        statuses.push(r.status);
      }
      const first20AllOk = statuses.slice(0, 20).every((s) => s === 201);
      assertTrue(first20AllOk, "rate limit: the first 20 requests in the window all succeed (201)");
      assertEq(statuses[20], 429, "rate limit: the 21st request in the same window is rejected (429)");
    }

    {
      // A DIFFERENT buyer_ref (different cart) is on its own bucket — proves
      // the limiter key includes buyer_ref, not just IP (same fake IP for
      // every call in this whole test file).
      const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
      const cid = created.body.cart_id;
      const bref = created.body.buyer_ref;
      const r = await callRoute(cartRouter, {
        method: "POST",
        url: `/cart/${cid}/wishes`,
        headers: { "x-cart-token": bref },
        body: { term: "Poteter", qty: 1 },
      });
      assertEq(r.status, 201, "rate limit: a fresh buyer_ref (same IP) is NOT blocked by a different buyer_ref's exhausted bucket");
    }
  } finally {
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceCartWishesTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-cart-wishes: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}

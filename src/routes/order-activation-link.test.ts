/**
 * order-activation-link.test.ts — dev-request 2026-11-06-rfb-aktiveringslenke-
 * l1-pensjoneres. The «aktiveringslenke» L1 is RETIRED: the public pages and
 * the admin generate endpoint no longer do anything, and a read-only usage
 * endpoint is added. No network, no e-mail, no production DB: a fresh in-memory
 * SQLite with the real schema and the real routers (admin + public) on an
 * ephemeral port.
 *
 *   public   GET/POST /aktiver-bestillinger → 410 retirement page, with and
 *            without ORDER_ACTIVATION_LINK_SECRET, with a valid token, with
 *            garbage. The token is never inspected, no cookie set, no row
 *            written. POST with bekreft=1 + a valid token changes NO rows.
 *   admin    POST /admin/orders/activation-link → 401 without key, 410 with
 *            key (with and without secret), never creates a link.
 *   admin    GET  /admin/orders/activation-link/usage → 401 without key,
 *            correct counts with key.
 *   reset    POST /api/marketplace/admin/agents/:id/reset-claim still clears
 *            an activation_link claim (kept revocation branch).
 *
 * Standalone: npx tsx src/routes/order-activation-link.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderActivationLinkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const svc = require("../services/order-activation-link") as typeof import("../services/order-activation-link");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ORDER_ACTIVATION_LINK_SECRET"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const ADMIN_KEY = "activation-test-admin-key";
  const SECRET = "activation-test-secret-0123456789abcdef-0123456789";
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;

    // ── Seed ────────────────────────────────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')
    `);
    const insKnow = db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email) VALUES (?, 'verified', ?)");
    insAgent.run("ag-ny", "Ny <Gård> & Sønn", "ny@example.no", "k1");
    insKnow.run("ag-ny", "ny@example.no");
    insAgent.run("ag-prefilled", "Forhåndsutfylt Gård", "pre@example.no", "k8");
    insKnow.run("ag-prefilled", "pre@example.no");
    // Control for reset-claim: an earlier, non-activation claim stamp.
    db.prepare("UPDATE agents SET claimed_at = '2025-05-05T05:05:05.000Z', claimed_via = 'admin_approval' WHERE id = 'ag-prefilled'").run();

    const agentRow = (id: string) => db.prepare(
      "SELECT is_verified, claimed_at, claimed_via, order_notifications_opt_in FROM agents WHERE id = ?"
    ).get(id) as any;
    const linkCounts = () => ({
      total: (db.prepare("SELECT COUNT(*) AS n FROM order_activation_links").get() as any).n,
      used: (db.prepare("SELECT COUNT(*) AS n FROM order_activation_links WHERE used_at IS NOT NULL").get() as any).n,
    });
    const sessionCount = () => (db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-ny'").get() as any).n;

    // ── Server with the real routers ───────────────────────────────────────
    {
      const express = require("express");
      const act = require("./order-activation-link") as typeof import("./order-activation-link");
      const marketplace = require("./marketplace").default;
      const app = express();
      app.use(express.json());
      app.use("/", act.default);
      app.use("/admin/orders", act.orderActivationAdminRouter);
      app.use("/api/marketplace", marketplace);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; body: any; text: string; location: string | undefined; setCookie: string[] };
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; body?: any; form?: Record<string, string> } = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) { bodyStr = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        else if (o.body !== undefined) { bodyStr = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* html */ }
            const sc = resp.headers["set-cookie"];
            resolve({ status: resp.statusCode || 0, body: parsed, text: raw, location: resp.headers["location"] as string | undefined,
              setCookie: Array.isArray(sc) ? sc : sc ? [String(sc)] : [] });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const admin = { "X-Admin-Key": ADMIN_KEY };
    const page = (t: string) => `/aktiver-bestillinger?t=${encodeURIComponent(t)}`;
    const submit = (t: string, bekreft = true) => req("POST", "/aktiver-bestillinger", { form: bekreft ? { t, bekreft: "1" } : { t } });

    // Mint a genuinely valid token via the (untouched) service, secret set.
    process.env.ORDER_ACTIVATION_LINK_SECRET = SECRET;
    const minted = svc.createActivationLink("ag-ny");
    assertTrue(minted.ok, "seed-01: a valid activation token can still be minted via the service");
    const validToken = minted.ok ? minted.token : "";
    // One stored (unused) link row now exists for ag-ny.
    assertEq(linkCounts(), { total: 1, used: 0 }, "seed-02: service minted exactly one unused link row");
    delete process.env.ORDER_ACTIVATION_LINK_SECRET;

    // ── Public pages are retired → always 410 ──────────────────────────────
    const expectRetired = (r: Resp, label: string) => {
      assertEq(r.status, 410, `${label}: → 410`);
      assertTrue(r.text.includes("Lenken er erstattet"), `${label}: retirement title`);
      assertTrue(r.text.includes("brukes ikke lenger"), `${label}: retirement body`);
      assertTrue(r.text.includes('href="/selger"'), `${label}: links to /selger`);
      assertEq(r.setCookie.length, 0, `${label}: no Set-Cookie`);
    };

    {
      // Secret unset.
      expectRetired(await req("GET", "/aktiver-bestillinger"), "pub-get-notoken-nosecret");
      expectRetired(await req("GET", page("garbage")), "pub-get-garbage-nosecret");
      expectRetired(await req("GET", page(validToken)), "pub-get-valid-nosecret");
      expectRetired(await submit("garbage"), "pub-post-garbage-nosecret");
      expectRetired(await submit(validToken), "pub-post-valid-nosecret");

      // Secret set — still 410, token still never inspected.
      process.env.ORDER_ACTIVATION_LINK_SECRET = SECRET;
      expectRetired(await req("GET", "/aktiver-bestillinger"), "pub-get-notoken-secret");
      expectRetired(await req("GET", page(validToken)), "pub-get-valid-secret");
      expectRetired(await submit(validToken), "pub-post-valid-secret");
      expectRetired(await submit("garbage"), "pub-post-garbage-secret");

      // The 410 page must not leak the producer name/address (token not read).
      const g = await req("GET", page(validToken));
      assertTrue(!g.text.includes("ny@example.no") && !g.text.includes("Gård&gt;") && !g.text.includes("Ny <Gård>"), "pub-noleak: 410 page reveals nothing about the token's target");
    }

    // ── POST with a valid token + bekreft=1 writes nothing ─────────────────
    {
      const beforeAgent = agentRow("ag-ny");
      const beforeLinks = linkCounts();
      const beforeSessions = sessionCount();
      const r = await submit(validToken, true);
      assertEq(r.status, 410, "write-01: POST bekreft=1 + valid token → 410");
      assertEq(r.setCookie.length, 0, "write-02: no owner-session cookie set");
      assertEq(agentRow("ag-ny"), beforeAgent, "write-03: agents row (is_verified/claimed_at/claimed_via/opt_in) unchanged");
      assertEq(linkCounts(), beforeLinks, "write-04: order_activation_links redeemed state unchanged (none consumed)");
      assertEq(beforeLinks.used, 0, "write-05: link was and remains unused");
      assertEq(sessionCount(), beforeSessions, "write-06: no owner-session magic_links row created");
    }

    // ── Admin POST generate is retired → 410 after the key check ───────────
    {
      // No key → 401 (unchanged), with the secret both set and unset.
      assertEq((await req("POST", "/admin/orders/activation-link", { body: { agent_id: "ag-ny" } })).status, 401, "admin-01: no X-Admin-Key → 401 (secret set)");
      delete process.env.ORDER_ACTIVATION_LINK_SECRET;
      assertEq((await req("POST", "/admin/orders/activation-link", { body: { agent_id: "ag-ny" } })).status, 401, "admin-02: no X-Admin-Key → 401 (secret unset)");
      assertEq((await req("POST", "/admin/orders/activation-link", { headers: { "X-Admin-Key": "nope" }, body: { agent_id: "ag-ny" } })).status, 401, "admin-03: wrong X-Admin-Key → 401");

      const beforeLinks = linkCounts();
      // With key, secret unset → 410 (retired beats the old fail-closed 503).
      const retiredNoSecret = await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-ny" } });
      assertEq(retiredNoSecret.status, 410, "admin-04: valid key, secret unset → 410 retired");
      assertEq(retiredNoSecret.body?.error, "activation_link_retired", "admin-05: error = activation_link_retired");
      assertTrue(typeof retiredNoSecret.body?.message === "string" && retiredNoSecret.body.message.length > 0, "admin-06: has a message");

      // With key, secret set → still 410, still creates nothing.
      process.env.ORDER_ACTIVATION_LINK_SECRET = SECRET;
      const retiredSecret = await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-ny" } });
      assertEq(retiredSecret.status, 410, "admin-07: valid key, secret set → 410 retired");
      assertEq(retiredSecret.body?.success, false, "admin-08: success=false");
      assertEq(linkCounts(), beforeLinks, "admin-09: no link row created by either attempt");
    }

    // ── Admin GET usage → 401 without key, correct counts with key ─────────
    {
      // Seed one claimed agent so the count is non-trivial.
      db.prepare("UPDATE agents SET is_verified = 1, claimed_at = '2026-01-02T03:04:05.000Z', claimed_via = 'activation_link' WHERE id = 'ag-ny'").run();
      // A control row that must NOT be counted.
      insAgent.run("ag-other", "Annen Gård", "annen@example.no", "ko");
      insKnow.run("ag-other", "annen@example.no");
      db.prepare("UPDATE agents SET claimed_via = 'claim' WHERE id = 'ag-other'").run();

      assertEq((await req("GET", "/admin/orders/activation-link/usage")).status, 401, "usage-01: no X-Admin-Key → 401");

      const expectTotal = (db.prepare("SELECT COUNT(*) AS n FROM order_activation_links").get() as any).n;
      const expectUsed = (db.prepare("SELECT COUNT(*) AS n FROM order_activation_links WHERE used_at IS NOT NULL").get() as any).n;
      const expectClaimed = (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE claimed_via = 'activation_link'").get() as any).n;

      const u = await req("GET", "/admin/orders/activation-link/usage", { headers: admin });
      assertEq(u.status, 200, "usage-02: valid key → 200");
      assertEq(u.body, {
        success: true,
        activation_links: expectTotal,
        redeemed_links: expectUsed,
        agents_claimed_via_activation_link: expectClaimed,
      }, "usage-03: counts match the DB");
      assertEq(expectClaimed, 1, "usage-04: exactly one agent counted as claimed via activation_link");
      assertEq(expectTotal, 1, "usage-05: the seeded link row is counted");

      // Mark the link redeemed and re-check the redeemed counter tracks it.
      db.prepare("UPDATE order_activation_links SET used_at = '2026-02-02T00:00:00.000Z' WHERE agent_id = 'ag-ny'").run();
      const u2 = await req("GET", "/admin/orders/activation-link/usage", { headers: admin });
      assertEq(u2.body?.redeemed_links, 1, "usage-06: redeemed_links reflects a consumed link");
    }

    // ── reset-claim still revokes an activation_link claim ────────────────
    // The revocation branch in routes/marketplace.ts is kept; its claim is
    // seeded directly (the public redeem route is retired).
    {
      db.prepare("UPDATE agents SET is_verified = 1, claimed_at = '2026-03-03T03:03:03.000Z', claimed_via = 'activation_link' WHERE id = 'ag-ny'").run();
      const rc = await req("POST", "/api/marketplace/admin/agents/ag-ny/reset-claim", { headers: admin });
      assertEq(rc.status, 200, "reset-01: reset-claim → 200");
      const r = agentRow("ag-ny");
      assertEq([r.is_verified, r.claimed_at, r.claimed_via], [0, null, null], "reset-02: activation_link claim cleared");
      await req("POST", "/api/marketplace/admin/agents/ag-prefilled/reset-claim", { headers: admin });
      const p = agentRow("ag-prefilled");
      assertEq([p.is_verified, p.claimed_at, p.claimed_via], [0, "2025-05-05T05:05:05.000Z", "admin_approval"], "reset-03: other claim stamps unchanged (as before)");
    }

    // ── Usage with no links table → zeros, not 500 ─────────────────────────
    {
      const bareDb = new Database(":memory:");
      bareDb.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, claimed_via TEXT)");
      initMod.__setDbForTesting(bareDb as any);
      try {
        const u = await req("GET", "/admin/orders/activation-link/usage", { headers: admin });
        assertEq(u.status, 200, "notable-01: missing links table → 200 (not 500)");
        assertEq(u.body, {
          success: true,
          activation_links: 0,
          redeemed_links: 0,
          agents_claimed_via_activation_link: 0,
        }, "notable-02: reports zeros");
      } finally {
        initMod.__setDbForTesting(db as any);
        try { bareDb.close(); } catch { /* best-effort */ }
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    initMod.__setDbForTesting(prevDb as any); // null → next getDb() reopens the pristine state
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOrderActivationLinkTests({ log: true }).then((r) => {
    console.log(`\norder-activation-link: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}

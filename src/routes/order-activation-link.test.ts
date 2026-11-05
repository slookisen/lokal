/**
 * order-activation-link.test.ts — dev-request 2026-10-21 live-go handlevogn-
 * pilot og første handel, SKIVE 2 (aktiveringslenke, AC8). No network, no
 * e-mail, no production DB: a fresh in-memory SQLite with the real schema and
 * the real routers (admin + public + owner portal + marketplace reset-claim)
 * on an ephemeral port.
 *
 *   admin    401 without key, 503 without ORDER_ACTIVATION_LINK_SECRET, 200 → URL
 *   GET      shows name + address + /kjopsvilkar; HTML-escaped
 *   POST     checkbox required; first use sets is_verified / claimed_at /
 *            claimed_via (fill-only) + opt-in + session cookie + 303 redirect
 *   reuse    second use → 409 explanatory page; concurrent double-POST wins once
 *   expiry   → 410; tampered / forged / rotated-secret → 404; address changed → 410
 *   segment A already verified: claim fields untouched, opt-in + session
 *   reset    POST /admin/agents/:id/reset-claim clears an activation_link claim
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
    insAgent.run("ag-verified", "Verifisert Gård", "ver@example.no", "k2");
    insKnow.run("ag-verified", "ver@example.no");
    db.prepare("UPDATE agents SET is_verified = 1, claimed_at = '2026-01-02T03:04:05.000Z', claimed_via = 'claim' WHERE id = 'ag-verified'").run();
    insAgent.run("ag-epost", "Epost Gård", "epost@example.no", "k3");
    insKnow.run("ag-epost", "epost@example.no");
    insAgent.run("ag-race", "Race Gård", "race@example.no", "k4");
    insKnow.run("ag-race", "race@example.no");
    insAgent.run("ag-old", "Gammel Gård", "old@example.no", "k5");
    insKnow.run("ag-old", "old@example.no");
    insAgent.run("ag-noemail", "Uten Epost", "x@example.no", "k6");
    insKnow.run("ag-noemail", null);
    insAgent.run("ag-self", "Selvregistrert", "self@example.no", "k7");
    insKnow.run("ag-self", "self@example.no");
    db.prepare("UPDATE agents SET origin = 'self_registered' WHERE id = 'ag-self'").run();
    insAgent.run("ag-prefilled", "Forhåndsutfylt Gård", "pre@example.no", "k8");
    insKnow.run("ag-prefilled", "pre@example.no");
    // Not verified, but an earlier claimed_at/claimed_via exists → fill-only keeps them.
    db.prepare("UPDATE agents SET claimed_at = '2025-05-05T05:05:05.000Z', claimed_via = 'admin_approval' WHERE id = 'ag-prefilled'").run();

    const agentRow = (id: string) => db.prepare(
      "SELECT is_verified, claimed_at, claimed_via, order_notifications_opt_in FROM agents WHERE id = ?"
    ).get(id) as any;

    // ── Server with the real routers ───────────────────────────────────────
    {
      const express = require("express");
      const act = require("./order-activation-link") as typeof import("./order-activation-link");
      const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
      const marketplace = require("./marketplace").default;
      const app = express();
      app.use(express.json());
      app.use("/", ownerPortal.default);
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
    const tokenOf = (url: string) => new URL(url).searchParams.get("t") || "";
    const page = (t: string) => `/aktiver-bestillinger?t=${encodeURIComponent(t)}`;
    const submit = (t: string, bekreft = true) => req("POST", "/aktiver-bestillinger", { form: bekreft ? { t, bekreft: "1" } : { t } });
    async function generate(agentId: string): Promise<string> {
      const r = await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: agentId } });
      if (r.status !== 200) throw new Error(`generate ${agentId} → ${r.status} ${r.text}`);
      return tokenOf(r.body.url);
    }

    // ── Admin endpoint ─────────────────────────────────────────────────────
    {
      const noKey = await req("POST", "/admin/orders/activation-link", { body: { agent_id: "ag-ny" } });
      assertEq(noKey.status, 401, "admin-01: no X-Admin-Key → 401");
      const wrongKey = await req("POST", "/admin/orders/activation-link", { headers: { "X-Admin-Key": "nope" }, body: { agent_id: "ag-ny" } });
      assertEq(wrongKey.status, 401, "admin-02: wrong X-Admin-Key → 401");
      const noSecret = await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-ny" } });
      assertEq(noSecret.status, 503, "admin-03: no ORDER_ACTIVATION_LINK_SECRET → 503 (fail closed)");
      assertEq(noSecret.body?.error, "activation_secret_missing", "admin-03b: 503 names the missing secret");
      process.env.ORDER_ACTIVATION_LINK_SECRET = "too-short";
      const shortSecret = await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-ny" } });
      assertEq(shortSecret.status, 503, "admin-04: a too-short secret is treated as unset → 503");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM order_activation_links").get() as any).n, 0, "admin-05: no link row written without a usable secret");
      process.env.ORDER_ACTIVATION_LINK_SECRET = SECRET;

      const ok = await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-ny" } });
      assertEq(ok.status, 200, "admin-06: valid key + secret → 200");
      assertTrue(typeof ok.body?.url === "string" && ok.body.url.startsWith("https://rettfrabonden.com/aktiver-bestillinger?t=v1."), "admin-07: returns the activation URL");
      assertEq(ok.body?.address, "ny@example.no", "admin-08: returns the bound address");
      const exp = Date.parse(ok.body?.expires_at);
      assertTrue(Math.abs(exp - (Date.now() + 14 * 86_400_000)) < 120_000, "admin-09: expires in 14 days");
      const row = db.prepare("SELECT * FROM order_activation_links WHERE agent_id = 'ag-ny'").get() as any;
      assertTrue(!!row && row.used_at === null, "admin-10: one unused link row stored");
      assertTrue(!!row && !ok.body.url.includes(row.id), "admin-11: the stored id is a hash, not part of the token");
      assertTrue(!JSON.stringify(row).includes(tokenOf(ok.body.url)), "admin-12: the token itself is not stored");

      assertEq((await req("POST", "/admin/orders/activation-link", { headers: admin, body: {} })).status, 400, "admin-13: missing agent_id → 400");
      assertEq((await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-finnes-ikke" } })).status, 404, "admin-14: unknown agent → 404");
      assertEq((await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-noemail" } })).status, 409, "admin-15: no registered address → 409");
      assertEq((await req("POST", "/admin/orders/activation-link", { headers: admin, body: { agent_id: "ag-self" } })).status, 409, "admin-16: self-registered profile → 409");
    }

    // ── GET landing page + POST without checkbox ───────────────────────────
    const tNy = await generate("ag-ny");
    {
      const g = await req("GET", page(tNy));
      assertEq(g.status, 200, "get-01: valid link → 200");
      assertTrue(g.text.includes("Ny &lt;Gård&gt; &amp; Sønn"), "get-02: shows the profile name, HTML-escaped");
      assertTrue(!g.text.includes("Ny <Gård>"), "get-03: raw name never rendered unescaped");
      assertTrue(g.text.includes("ny@example.no"), "get-04: shows the address orders go to");
      assertTrue(g.text.includes('href="/kjopsvilkar"'), "get-05: links to /kjopsvilkar");
      assertTrue(/betaler deg direkte ved henting/.test(g.text) && /bekrefter/.test(g.text), "get-06: explains request → confirm → pay at pickup");
      assertTrue(g.text.includes("Jeg representerer Ny &lt;Gård&gt; &amp; Sønn og vil ta imot bestillinger"), "get-07: checkbox label names the producer");
      assertEq(agentRow("ag-ny").is_verified, 0, "get-08: GET alone changes nothing");

      const noBox = await submit(tNy, false);
      assertEq(noBox.status, 400, "post-01: POST without the checkbox → 400");
      assertTrue(noBox.text.includes("Kryss av"), "post-02: 400 page explains the checkbox");
      assertEq(noBox.setCookie.length, 0, "post-03: no session cookie without the checkbox");
      const r = agentRow("ag-ny");
      assertEq([r.is_verified, r.claimed_at, r.order_notifications_opt_in], [0, null, 0], "post-04: nothing written without the checkbox");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM order_activation_links WHERE agent_id = 'ag-ny' AND used_at IS NOT NULL").get() as any).n, 0, "post-05: the link is not consumed without the checkbox");
      const noToken = await req("POST", "/aktiver-bestillinger", { form: { bekreft: "1" } });
      assertEq(noToken.status, 404, "post-06: POST without a token → 404 (the token is the CSRF guard)");
    }

    // ── First use ──────────────────────────────────────────────────────────
    let sessionCookie = "";
    {
      const first = await submit(tNy);
      assertEq(first.status, 303, "use-01: first use → 303");
      assertEq(first.location, "/eier/ag-ny/portal#bestillinger", "use-02: redirects into the portal's Bestillinger");
      const c = first.setCookie.find((s) => s.startsWith("rfb_owner_session="));
      assertTrue(!!c && /HttpOnly/i.test(c) && /Secure/i.test(c) && /SameSite=Lax/i.test(c), "use-03: sets the HttpOnly owner session cookie");
      sessionCookie = c ? c.split(";")[0] : "";
      const r = agentRow("ag-ny");
      assertEq(r.is_verified, 1, "use-04: is_verified = 1");
      assertTrue(typeof r.claimed_at === "string" && !Number.isNaN(Date.parse(r.claimed_at)), "use-05: claimed_at stamped");
      assertEq(r.claimed_via, "activation_link", "use-06: claimed_via = 'activation_link'");
      assertEq(r.order_notifications_opt_in, 1, "use-07: order_notifications_opt_in = 1");
      const link = db.prepare("SELECT * FROM order_activation_links WHERE agent_id = 'ag-ny' AND used_at IS NOT NULL").get() as any;
      assertTrue(!!link.used_at && link.used_outcome === "claimed" && !!link.session_link_id && !!link.used_ip_hash, "use-08: usage logged (when, outcome, session, hashed ip)");
      const sess = db.prepare("SELECT agent_id, email, used FROM magic_links WHERE id = ?").get(link.session_link_id) as any;
      assertEq(sess, { agent_id: "ag-ny", email: "ny@example.no", used: 1 }, "use-09: session is an owner-portal magic_links row");
      const audits = db.prepare("SELECT field_name FROM agent_knowledge_audit WHERE agent_id = 'ag-ny' ORDER BY field_name").all().map((x: any) => x.field_name);
      assertEq(audits, ["claimed_at", "claimed_via", "is_verified", "order_notifications_opt_in"], "use-10: one audit row per changed field");

      const portal = await req("GET", "/eier/ag-ny/portal", { headers: { Cookie: sessionCookie } });
      assertEq(portal.status, 200, "use-11: the cookie opens the owner portal (existing verifyOwnerSession)");
      assertTrue(portal.text.includes('id="bestillinger"') && portal.text.includes("Slå av bestillinger på e-post"), "use-12: portal shows orders switched on");
      const other = await req("GET", "/eier/ag-verified/portal", { headers: { Cookie: sessionCookie } });
      assertEq(other.status, 403, "use-13: the session is scoped to this producer only");
    }

    // ── Second use ─────────────────────────────────────────────────────────
    {
      const again = await submit(tNy);
      assertEq(again.status, 409, "reuse-01: second POST → 409 explanatory page");
      assertTrue(again.text.includes("allerede brukt") && again.text.includes("/eier/ag-ny"), "reuse-02: explains and points to login");
      assertEq(again.setCookie.length, 0, "reuse-03: no new session on reuse");
      assertTrue(!/at\s+\w+\s+\(|Error:/.test(again.text), "reuse-04: no stack trace");
      const g = await req("GET", page(tNy));
      assertEq(g.status, 409, "reuse-05: GET after use → 409 explanatory page");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-ny'").get() as any).n, 1, "reuse-06: still exactly one session row");
    }

    // ── Concurrent double POST ─────────────────────────────────────────────
    {
      const tRace = await generate("ag-race");
      const results = await Promise.all([submit(tRace), submit(tRace), submit(tRace)]);
      const codes = results.map((r) => r.status).sort();
      assertEq(codes, [303, 409, 409], "race-01: concurrent POSTs — exactly one succeeds");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-race'").get() as any).n, 1, "race-02: exactly one session issued");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = 'ag-race' AND field_name = 'is_verified'").get() as any).n, 1, "race-03: claim audited once");
      // Service level: the conditional UPDATE is the guard even for a caller
      // that already inspected the token as valid.
      const tRace2 = await generate("ag-race");
      const r1 = svc.redeemActivationLink(tRace2);
      const r2 = svc.redeemActivationLink(tRace2);
      assertEq([r1.state, r2.state], ["redeemed", "used"], "race-04: service redeem twice → redeemed, used");
      // Another writer consumes the link AFTER this redeem's validity check but
      // before its single-use UPDATE (e.g. a second process on the same DB
      // file): the conditional UPDATE must be what stops it.
      const tRace3 = await generate("ag-race");
      const raceDb: any = {
        transaction: (fn: any) => db.transaction(fn),
        prepare: (sql: string) => {
          if (sql.includes("SET used_at = ?, used_ip_hash = ?")) {
            db.prepare("UPDATE order_activation_links SET used_at = 'other-writer' WHERE agent_id = 'ag-race' AND used_at IS NULL").run();
          }
          return db.prepare(sql);
        },
      };
      const sessionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-race'").get() as any).n;
      const r3 = svc.redeemActivationLink(tRace3, {}, { db: raceDb });
      assertEq(r3.state, "used", "race-05: link consumed between check and UPDATE → used (conditional UPDATE guards)");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-race'").get() as any).n, sessionsBefore, "race-06: no session issued for the losing redeem");
    }

    // ── Expired ────────────────────────────────────────────────────────────
    {
      const made = svc.createActivationLink("ag-old", { now: new Date(Date.now() - 15 * 86_400_000) });
      assertTrue(made.ok, "exp-00: back-dated link created");
      const t = made.ok ? made.token : "";
      const g = await req("GET", page(t));
      assertEq(g.status, 410, "exp-01: expired link GET → 410");
      assertTrue(g.text.includes("14 dager"), "exp-02: 410 page explains");
      const p = await submit(t);
      assertEq(p.status, 410, "exp-03: expired link POST → 410");
      assertEq(agentRow("ag-old").is_verified, 0, "exp-04: expired link changes nothing");
      const almost = svc.createActivationLink("ag-old", { now: new Date(Date.now() - 13 * 86_400_000) });
      assertEq((await req("GET", page(almost.ok ? almost.token : ""))).status, 200, "exp-05: 13-day-old link still valid");
    }

    // ── Tampered / forged / rotated secret ─────────────────────────────────
    {
      const t = await generate("ag-old");
      const [v, payload, sig] = t.split(".");
      const flip = (s: string) => s.slice(0, -2) + (s.slice(-2, -1) === "A" ? "B" : "A") + s.slice(-1);
      const badSig = `${v}.${payload}.${flip(sig)}`;
      const g1 = await req("GET", page(badSig));
      assertEq(g1.status, 404, "tamper-01: altered signature → 404");
      assertTrue(!g1.text.includes("Gammel Gård") && !g1.text.includes("old@example.no"), "tamper-02: 404 reveals nothing");
      // Re-pointed payload (other agent) with the old signature.
      const p = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      p.a = "ag-verified";
      const forgedPayload = Buffer.from(JSON.stringify(p)).toString("base64url");
      assertEq((await req("GET", page(`${v}.${forgedPayload}.${sig}`))).status, 404, "tamper-03: re-pointed payload → 404");
      assertEq((await submit(`${v}.${forgedPayload}.${sig}`)).status, 404, "tamper-04: re-pointed payload POST → 404");
      // Properly signed with ANOTHER key.
      const crypto = require("crypto");
      const otherSig = crypto.createHmac("sha256", "some-other-secret-0123456789abcdef-xyz").update("rfb-order-activation:v1:" + payload).digest("base64url");
      assertEq((await req("GET", page(`${v}.${payload}.${otherSig}`))).status, 404, "tamper-05: signed with another key → 404");
      assertEq((await req("GET", page("garbage"))).status, 404, "tamper-06: garbage → 404");
      assertEq((await req("GET", "/aktiver-bestillinger")).status, 404, "tamper-07: no token → 404");
      // Rotation: the same untouched token dies when the secret rotates.
      process.env.ORDER_ACTIVATION_LINK_SECRET = SECRET + "-rotated";
      assertEq((await req("GET", page(t))).status, 404, "rotate-01: rotated secret invalidates outstanding links");
      delete process.env.ORDER_ACTIVATION_LINK_SECRET;
      assertEq((await req("GET", page(t))).status, 503, "rotate-02: secret removed → 503 page, never a fallback key");
      assertEq((await submit(t)).status, 503, "rotate-03: secret removed → POST 503");
      process.env.ORDER_ACTIVATION_LINK_SECRET = SECRET;
      assertEq((await req("GET", page(t))).status, 200, "rotate-04: original secret back → link valid again");
      assertEq(agentRow("ag-old").is_verified, 0, "tamper-08: nothing written by any rejected attempt");
    }

    // ── Address changed after generation ───────────────────────────────────
    {
      const t = await generate("ag-epost");
      db.prepare("UPDATE agent_knowledge SET email = 'ny-eier@example.no' WHERE agent_id = 'ag-epost'").run();
      const g = await req("GET", page(t));
      assertEq(g.status, 410, "addr-01: registered address changed → link invalid (410)");
      assertTrue(!g.text.includes("ny-eier@example.no"), "addr-02: the new address is not shown");
      assertEq((await submit(t)).status, 410, "addr-03: POST also refused");
      assertEq(agentRow("ag-epost").is_verified, 0, "addr-04: nothing written");
      db.prepare("UPDATE agent_knowledge SET email = ' EPOST@example.no ' WHERE agent_id = 'ag-epost'").run();
      assertEq((await req("GET", page(t))).status, 200, "addr-05: same address (case/space-normalised) → valid again");
      db.prepare("UPDATE agent_knowledge SET email = NULL WHERE agent_id = 'ag-epost'").run();
      assertEq((await req("GET", page(t))).status, 410, "addr-06: address removed → invalid");
    }

    // ── Segment A: already verified ────────────────────────────────────────
    {
      const before = agentRow("ag-verified");
      const t = await generate("ag-verified");
      const r = await submit(t);
      assertEq(r.status, 303, "segA-01: verified producer → 303");
      assertTrue(r.setCookie.some((s) => s.startsWith("rfb_owner_session=")), "segA-02: still gets the session");
      const after = agentRow("ag-verified");
      assertEq([after.is_verified, after.claimed_at, after.claimed_via], [before.is_verified, before.claimed_at, before.claimed_via], "segA-03: claim fields untouched");
      assertEq(after.order_notifications_opt_in, 1, "segA-04: opt-in turned on");
      assertEq((db.prepare("SELECT used_outcome FROM order_activation_links WHERE agent_id = 'ag-verified'").get() as any).used_outcome, "opt_in_only", "segA-05: logged as opt_in_only");
      const audits = db.prepare("SELECT field_name FROM agent_knowledge_audit WHERE agent_id = 'ag-verified'").all().map((x: any) => x.field_name);
      assertEq(audits, ["order_notifications_opt_in"], "segA-06: only the opt-in change is audited");
    }

    // ── Fill-only on an unverified profile with an earlier claim stamp ─────
    {
      const t = await generate("ag-prefilled");
      assertEq((await submit(t)).status, 303, "fill-01: → 303");
      const r = agentRow("ag-prefilled");
      assertEq([r.is_verified, r.claimed_at, r.claimed_via, r.order_notifications_opt_in],
        [1, "2025-05-05T05:05:05.000Z", "admin_approval", 1], "fill-02: existing claimed_at/claimed_via never overwritten");
    }

    // ── reset-claim revokes an activation_link claim ───────────────────────
    {
      const rc = await req("POST", "/api/marketplace/admin/agents/ag-ny/reset-claim", { headers: admin });
      assertEq(rc.status, 200, "reset-01: reset-claim → 200");
      const r = agentRow("ag-ny");
      assertEq([r.is_verified, r.claimed_at, r.claimed_via], [0, null, null], "reset-02: activation_link claim cleared");
      await req("POST", "/api/marketplace/admin/agents/ag-prefilled/reset-claim", { headers: admin });
      const p = agentRow("ag-prefilled");
      assertEq([p.is_verified, p.claimed_at, p.claimed_via], [0, "2025-05-05T05:05:05.000Z", "admin_approval"], "reset-03: other claim stamps unchanged (as before)");
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

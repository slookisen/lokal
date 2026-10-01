/**
 * owner-order-optin-handoff-stats.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, slice 4:
 *   (a) owner self-service opt-in toggle (AC6): 401 without session, 403 for
 *       another agent's session, 200 + DB write with the owner session, form
 *       fallback, portal renders the toggle, default stays 0.
 *   (b) claim-confirmation e-mail carries the toggle sentence + link.
 *   (c) GET /admin/orders/handoff-stats (AC8): admin-key gated, per-producer
 *       30-day counts, no personal data.
 * Standalone: npx tsx src/routes/owner-order-optin-handoff-stats.test.ts
 */
import Database from "better-sqlite3";
import * as http from "http";
import express from "express";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

export async function runOwnerOrderOptinHandoffStatsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => { if (c) passed++; else { failed++; failures.push("✗ " + label); } };
  const eq = (a: unknown, b: unknown, label: string) => {
    if (a === b) passed++; else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const adminOrdersMod = require("./admin-orders") as typeof import("./admin-orders");
  const ownerPortalMod = require("./owner-portal") as typeof import("./owner-portal");
  const { emailService } = require("../services/email-service") as typeof import("../services/email-service");

  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const KEY = "s4-test-admin-key";
  const db = new Database(":memory:");
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    adminOrdersMod.__setAdminOrdersTestDb(db as any);
    process.env.ADMIN_KEY = KEY;

    const ins = db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?)`);
    ins.run("s4-a", "Gard A", "a@example.no", "k-a");
    ins.run("s4-b", "Gard B", "b@example.no", "k-b");
    ins.run("s4-c", "Gard C", "c@example.no", "k-c");
    const future = "datetime('now', '+1 day')";
    db.exec(`INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES
      ('ml-a', 'a@example.no', 'tok-a', 's4-a', 1, ${future}),
      ('ml-b', 'b@example.no', 'tok-b', 's4-b', 1, ${future}),
      ('ml-unused', 'a@example.no', 'tok-unused', 's4-a', 0, ${future})`);

    const app = express();
    app.use(express.json());
    app.use("/", ownerPortalMod.default);
    app.use("/admin/orders", adminOrdersMod.default);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    function req(method: string, path: string, o: { headers?: Record<string, string>; body?: any; form?: Record<string, string> } = {}):
      Promise<{ status: number; body: any; text: string; location?: string }> {
      // Re-pin the DB singleton right before dispatch (handlers read getDb() lazily).
      initMod.__setDbForTesting(db as any);
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(o.headers || {}) };
        let b: string | undefined;
        if (o.form) { b = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        else if (o.body !== undefined) { b = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; }
        if (b !== undefined) headers["Content-Length"] = String(Buffer.byteLength(b));
        const r = http.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: any = null; try { body = JSON.parse(text); } catch { /* html */ }
            resolve({ status: resp.statusCode || 0, body, text, location: resp.headers.location as string | undefined });
          });
        });
        r.on("error", reject);
        if (b !== undefined) r.write(b);
        r.end();
      });
    }
    const optIn = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v;
    const cookieA = { Cookie: "rfb_owner_session=tok-a" };

    // ── (a) owner toggle ────────────────────────────────────────────────────
    eq(optIn("s4-a"), 0, "toggle-00: default opt-in is 0");
    let r = await req("POST", "/api/agents/s4-a/order-notifications", { body: { opt_in: true } });
    eq(r.status, 401, "toggle-01: no session -> 401");
    eq(optIn("s4-a"), 0, "toggle-02: no session -> nothing written");
    r = await req("POST", "/api/agents/s4-a/order-notifications", { headers: { Cookie: "rfb_owner_session=tok-unused" }, body: { opt_in: true } });
    eq(r.status, 401, "toggle-03: unused (unverified) magic link -> 401");
    r = await req("POST", "/api/agents/s4-a/order-notifications", { headers: { Cookie: "rfb_owner_session=tok-b" }, body: { opt_in: true } });
    eq(r.status, 403, "toggle-04: other agent's owner session -> 403");
    eq(optIn("s4-a"), 0, "toggle-05: other agent's session -> nothing written");
    r = await req("POST", "/api/agents/s4-a/order-notifications", { headers: { "X-Admin-Key": KEY }, body: { opt_in: true } });
    eq(r.status, 401, "toggle-06: admin key is NOT an owner session -> 401");
    r = await req("POST", "/api/agents/s4-a/order-notifications", { headers: cookieA, body: { opt_in: "maybe" } });
    eq(r.status, 400, "toggle-07: invalid opt_in -> 400");
    r = await req("POST", "/api/agents/s4-a/order-notifications", { headers: cookieA, body: { opt_in: true } });
    eq(r.status, 200, "toggle-08: owner session on -> 200");
    eq(r.body?.order_notifications_opt_in, true, "toggle-09: response reflects on");
    eq(optIn("s4-a"), 1, "toggle-10: DB opt-in = 1");
    eq(optIn("s4-b"), 0, "toggle-11: other producers untouched");
    r = await req("POST", "/api/agents/s4-a/order-notifications", { headers: { Authorization: "Bearer tok-a" }, body: { opt_in: false } });
    eq(r.status, 200, "toggle-12: Bearer owner token off -> 200");
    eq(optIn("s4-a"), 0, "toggle-13: DB opt-in back to 0");

    // form fallback + portal rendering
    r = await req("POST", "/eier/s4-a/order-notifications", { form: { opt_in: "1" } });
    eq(r.status, 302, "form-01: no session -> redirect to login (nothing written)");
    eq(optIn("s4-a"), 0, "form-02: no session -> nothing written");
    r = await req("POST", "/eier/s4-a/order-notifications", { headers: { Cookie: "rfb_owner_session=tok-b" }, form: { opt_in: "1" } });
    eq(r.status, 403, "form-03: other agent's session -> 403");
    r = await req("POST", "/eier/s4-a/order-notifications", { headers: cookieA, form: { opt_in: "1" } });
    eq(r.status, 303, "form-04: owner form post -> 303 PRG");
    ok((r.location || "").includes("/eier/s4-a/portal"), "form-05: redirects back to portal");
    eq(optIn("s4-a"), 1, "form-06: form post wrote opt-in = 1");

    db.prepare("INSERT OR IGNORE INTO agent_knowledge (agent_id) VALUES ('s4-a')").run();
    r = await req("GET", "/eier/s4-a/portal", { headers: cookieA });
    eq(r.status, 200, "portal-01: portal renders for owner");
    ok(r.text.includes("Motta bestillinger på e-post"), "portal-02: toggle label present");
    ok(r.text.includes('action="/eier/s4-a/order-notifications"'), "portal-03: toggle form posts to the new route");
    ok(r.text.includes("name=\"opt_in\" value=\"0\""), "portal-04: state on -> one click turns it off ");

    // ── (b) claim confirmation e-mail ───────────────────────────────────────
    const vc = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { vc.getConfig("rfb"); } catch { vc.loadConfigsAtBoot(); }
    const txt: string = (emailService as any).generateClaimConfirmationText("Gard A", "https://x.no/eier/s4-a/portal");
    const html: string = (emailService as any).generateClaimConfirmationHtml("Gard A", "https://x.no/eier/s4-a/portal");
    ok(txt.includes("bestillinger") && txt.includes("https://x.no/eier/s4-a/portal#bestillinger"), "mail-01: text mentions orders toggle + link");
    ok(html.includes("bestillinger") && html.includes("portal#bestillinger"), "mail-02: html mentions orders toggle + link");
    ok(txt.includes("Gratulerer!") && txt.includes("Lykke til!"), "mail-03: existing text unchanged");

    // ── (c) handoff-stats ───────────────────────────────────────────────────
    const h = db.prepare("INSERT INTO cart_handoffs (id, agent_id, cart_id, item_count, created_at) VALUES (?, ?, ?, ?, ?)");
    h.run("h1", "s4-b", "cart-secret-1", 2, new Date(Date.now() - 2 * 86400e3).toISOString().replace("T", " ").slice(0, 19));
    h.run("h2", "s4-b", "cart-secret-2", 1, new Date(Date.now() - 5 * 86400e3).toISOString().replace("T", " ").slice(0, 19));
    h.run("h3", "s4-c", "cart-secret-3", 4, new Date(Date.now() - 1 * 86400e3).toISOString().replace("T", " ").slice(0, 19));
    h.run("h-old", "s4-c", "cart-secret-old", 9, new Date(Date.now() - 45 * 86400e3).toISOString().replace("T", " ").slice(0, 19));

    r = await req("GET", "/admin/orders/handoff-stats");
    eq(r.status, 403, "stats-01: no admin key -> 403");
    r = await req("GET", "/admin/orders/handoff-stats", { headers: { "X-Admin-Key": "wrong" } });
    eq(r.status, 403, "stats-02: wrong admin key -> 403");
    r = await req("GET", "/admin/orders/handoff-stats", { headers: cookieA });
    eq(r.status, 403, "stats-03: owner session is not enough -> 403");
    r = await req("GET", "/admin/orders/handoff-stats", { headers: { "X-Admin-Key": KEY } });
    eq(r.status, 200, "stats-04: admin key -> 200");
    eq(r.body?.window_days, 30, "stats-05: 30-day window");
    eq(r.body?.total_handoffs, 3, "stats-06: handoffs older than 30 d excluded");
    const prod = r.body?.producers || [];
    eq(prod.length, 2, "stats-07: one row per producer with handoffs");
    eq(prod[0]?.agent_id, "s4-b", "stats-08: sorted by handoffs desc");
    eq(prod[0]?.handoffs, 2, "stats-09: s4-b handoffs = 2");
    eq(prod[0]?.items, 3, "stats-10: s4-b items = 3");
    eq(prod[1]?.handoffs, 1, "stats-11: s4-c handoffs = 1 (old one excluded)");
    eq(prod[0]?.name, "Gard B", "stats-12: producer name included");
    const raw = JSON.stringify(r.body);
    ok(!raw.includes("cart-secret") && !raw.includes("@example.no") && !/buyer|phone|email/i.test(raw),
      "stats-13: no cart ids, e-mail, phone or buyer data in the response (AC8)");
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    adminOrdersMod.__setAdminOrdersTestDb(null);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }
  if (opts.log) { console.log(`passed ${passed} failed ${failed}`); for (const f of failures) console.log(f); }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerOrderOptinHandoffStatsTests({ log: true }).then((r) => process.exit(r.failed ? 1 : 0));
}

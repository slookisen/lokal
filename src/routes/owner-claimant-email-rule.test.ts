/**
 * owner-claimant-email-rule.test.ts — dev-request 2026-11-06-rfb-krav-for-
 * portal-og-okter-ved-eierskifte, spec point 3 / AC 3.
 *
 * Rule: only a session opened by the verified claimant's own e-mail
 * (sessionClaimantOwnerEmail) may change (a) products, (b) the order e-mail
 * and (c) the profile e-mail. A verified owner whose session was opened by
 * another address (here: agent_knowledge.email, which the /eier login also
 * accepts) gets 403 and nothing is written; the claimant's session succeeds.
 *
 *   prod-*   POST /eier/:id/varer/ny (pins the existing B1b-1 guard).
 *   order-*  POST /api/agents/:id/order-email, POST /eier/:id/order-email,
 *            POST /eier/:id/valg/ordre-epost (all via requestOwnerOrderEmailChange).
 *   prof-*   POST /api/agents/:id/update-profile and POST /eier/:id/save
 *            (field email → agent_knowledge.email). Other fields with the
 *            e-mail unchanged still save for the non-claimant owner.
 *
 * Fresh in-memory SQLite with the production schema; the order-address
 * confirmation mail is stubbed (nothing leaves the process).
 * Standalone: npx tsx src/routes/owner-claimant-email-rule.test.ts
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

const ENV_KEYS = [
  "ADMIN_KEY", "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED",
  "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_FEATURES_ENFORCE", "APP_URL", "OWNER_ORDER_EMAIL_ENABLED", "OWNER_PAUSE_ENABLED",
];

const P = "claimant-rule-producer";
const CLAIMANT = "eier@claimant-rule.example.no";
const LISTED = `post@${P}.example.no`; // agent_knowledge / contact e-mail, not the claimant

export async function runOwnerClaimantEmailRuleTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", origin: "https://rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "POST", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body ?? {}, query: {}, headers, cookies: {},
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
        req,
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }
  const es = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const prevSendConfirm = es.sendOwnerOrderEmailConfirm;
  const confirms: string[] = [];

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "claimant-rule-admin-key";
    es.sendOwnerOrderEmailConfirm = async (o: any) => { confirms.push(String(o.to)); return { success: true, messageId: "stub" }; };
    for (const m of ["./owner-portal", "./owner-features", "../services/owner-orderability"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");

    // ── Fixture: one claimed producer with a verified claimant on another address ──
    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
          order_notifications_opt_in)
       VALUES (?, 'Regel Gard', 'Testprodusent.', 'test', ?, ?, 'producer', 'key-claimant-rule', 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
    ).run(P, LISTED, `https://${P}.example.no`);
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, phone, website, about, verification_status, verified_second_line)
       VALUES (?, ?, '+47 400 00 000', ?, 'Liten gård.', 'verified', 0)`,
    ).run(P, LISTED, `https://${P}.example.no`);
    db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
       VALUES ('claim-claimant-rule', ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
    ).run(P, CLAIMANT);
    const session = (tok: string, email: string) =>
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${tok}`, email, tok, P, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    session("tok-other", LISTED);        // verified owner (claimed profile), not the claimant's address
    session("tok-claimant", CLAIMANT);   // the claimant's own address
    process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
    process.env.OWNER_ORDER_EMAIL_ENABLED = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${P}`;

    const H = {
      ny: findRouteHandler(portalMod.default, "/eier/:agentId/varer/ny", "post"),
      orderApi: findRouteHandler(portalMod.default, "/api/agents/:id/order-email", "post"),
      orderForm: findRouteHandler(portalMod.default, "/eier/:agentId/order-email", "post"),
      orderValg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/ordre-epost", "post"),
      profileApi: findRouteHandler(portalMod.default, "/api/agents/:id/update-profile", "post"),
      save: findRouteHandler(portalMod.default, "/eier/:agentId/save", "post"),
    };
    const products = () => JSON.stringify(db.prepare("SELECT * FROM products WHERE agent_id = ? ORDER BY id").all(P));
    const changeRows = () => (db.prepare("SELECT COUNT(*) AS n FROM owner_order_email_change WHERE agent_id = ?").get(P) as any).n as number;
    const knowledge = () => db.prepare("SELECT email, phone FROM agent_knowledge WHERE agent_id = ?").get(P) as { email: string; phone: string };
    const audits = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ?").get(P) as any).n as number;
    const isClaimantPage = (r: HandlerResult, needle: string) => {
      const html = String(r.body ?? "");
      return r.status === 403 && html.includes("Logg inn med eierens e-postadresse") && html.includes(needle) && html.includes(`href="/selger?agent=${P}"`);
    };

    assertTrue(portalMod.isVerifiedOwner(P, { valid: true, agentId: P, token: "tok-other" }), "pre-1: the other-address session IS a verified owner");
    assertEq([portalMod.sessionClaimantOwnerEmail(P, { token: "tok-other" }), portalMod.sessionClaimantOwnerEmail(P, { token: "tok-claimant" })],
      [null, CLAIMANT], "pre-2: … but only the claimant's session is the claimant's");

    // ═══ (a) products ════════════════════════════════════════════════════
    {
      const before = products();
      const r = await invoke(H.ny, makeReq({ params: { agentId: P }, body: { name: "Regelvare", price: "10" }, token: "tok-other" }));
      assertTrue(r.status === 403 && String(r.body).includes("Logg inn med eierens e-postadresse"), "prod-1: other address → POST varer/ny → 403 claimant-login page");
      assertEq(products(), before, "prod-2: … no product written");
      const ok = await invoke(H.ny, makeReq({ params: { agentId: P }, body: { name: "Regelvare", price: "10" }, token: "tok-claimant" }));
      assertEq(ok.status, 303, "prod-3: claimant → 303");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ? AND name = 'Regelvare'").get(P) as any).n, 1, "prod-4: … and the product exists");
    }

    // ═══ (b) order e-mail ════════════════════════════════════════════════
    {
      const NEW = "ny-ordre@claimant-rule.example.no";
      const r1 = await invoke(H.orderApi, makeReq({ params: { id: P }, body: { email: NEW }, token: "tok-other" }));
      assertEq([r1.status, r1.body?.error], [403, "claimant_login_required"], "order-1: other address → POST /api/agents/:id/order-email → 403 claimant_login_required");
      const r2 = await invoke(H.orderForm, makeReq({ params: { agentId: P }, body: { email: NEW }, token: "tok-other" }));
      assertTrue(isClaimantPage(r2, "adressen bestillingene sendes til"), "order-2: other address → POST /eier/:id/order-email → 403 claimant-login page");
      const r3 = await invoke(H.orderValg, makeReq({ params: { agentId: P }, body: { email: NEW }, token: "tok-other" }));
      assertTrue(isClaimantPage(r3, "adressen bestillingene sendes til"), "order-3: other address → POST /eier/:id/valg/ordre-epost → 403 claimant-login page");
      assertEq([changeRows(), confirms.length, (db.prepare("SELECT order_notification_email AS v FROM agents WHERE id = ?").get(P) as any).v],
        [0, 0, null], "order-4: … no change row, no confirmation mail, order address untouched");
      const ok = await invoke(H.orderApi, makeReq({ params: { id: P }, body: { email: NEW }, token: "tok-claimant" }));
      assertEq([ok.status, ok.body?.pending_email], [200, NEW], "order-5: claimant → 200, pending new address");
      assertEq([changeRows(), confirms], [1, [NEW]], "order-6: … one change row, confirmation to the new address");
      const okForm = await invoke(H.orderForm, makeReq({ params: { agentId: P }, body: { email: "annen@claimant-rule.example.no" }, token: "tok-claimant" }));
      assertEq([okForm.status, okForm.body?.__redirect], [303, `/eier/${P}/portal?status=order_email_sent#bestillinger`], "order-7: claimant → form POST → 303 order_email_sent");
    }

    // ═══ (c) profile e-mail ══════════════════════════════════════════════
    {
      const NEW = "ny-profil@claimant-rule.example.no";
      const a0 = audits();
      const r1 = await invoke(H.profileApi, makeReq({ params: { id: P }, body: { email: NEW, phone: "+47 400 00 009" }, token: "tok-other" }));
      assertEq([r1.status, r1.body?.error], [403, "claimant_login_required"], "prof-1: other address → update-profile with a new e-mail → 403 claimant_login_required");
      const r2 = await invoke(H.save, makeReq({ params: { agentId: P }, body: { field_email: NEW, field_phone: "+47 400 00 009" }, token: "tok-other" }));
      assertTrue(isClaimantPage(r2, "e-postadressen på profilen"), "prof-2: other address → POST /eier/:id/save with a new e-mail → 403 claimant-login page");
      assertEq([knowledge(), audits()], [{ email: LISTED, phone: "+47 400 00 000" }, a0], "prof-3: … nothing written (not even the phone), no audit row");
      const same = await invoke(H.profileApi, makeReq({ params: { id: P }, body: { email: ` ${LISTED} `, phone: "+47 400 00 001" }, token: "tok-other" }));
      assertEq([same.status, same.body?.updated_fields, knowledge()], [200, ["phone"], { email: LISTED, phone: "+47 400 00 001" }],
        "prof-4: other address, e-mail unchanged → other fields still save");
      const ok = await invoke(H.profileApi, makeReq({ params: { id: P }, body: { email: NEW }, token: "tok-claimant" }));
      assertEq([ok.status, ok.body?.updated_fields, knowledge().email], [200, ["email"], NEW], "prof-5: claimant → 200, the profile e-mail is changed");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    es.sendOwnerOrderEmailConfirm = prevSendConfirm;
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerClaimantEmailRuleTests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nowner-claimant-email-rule: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

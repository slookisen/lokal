/**
 * admin-test-producer-owner-login.test.ts — dev-request
 * 2026-10-22-rfb-mine-valg-eierbrytere, slice S2d-1 (AC21): POST
 * /admin/test-producer (mode "arm") with `owner_email` also sets the hidden
 * test producer's owner login (agent_knowledge.email + claimed_at), so a magic
 * link to that address lands in «Mine valg» for the fixture.
 *
 *   dry-run    owner_email lists `agent_knowledge.email` + `claimed_at` and
 *              writes nothing (create path and existing path).
 *   apply      both fields written + one audit row each; a second identical
 *              apply changes neither (idempotent); an existing claimed_at is
 *              kept; `owner_login` in the response; no e-mail sent.
 *   guard      a real producer id with owner_email → 409 not_a_test_fixture,
 *              its agent_knowledge.email / claimed_at unchanged, no audit row.
 *   validation retire + owner_email → 400; malformed owner_email → 400; nothing
 *              written.
 *   unchanged  without owner_email: no `owner_login` key, the response keys are
 *              today's, and no email/claimed_at change.
 *   AC21 e2e   request-magic-link with that address (send stubbed) → token in
 *              magic_links → /magic-link-verify → session cookie → GET
 *              /eier/<id>/valg 200 with OWNER_FEATURES_ALLOWED_SUBJECTS=rfb:<id>,
 *              404 with the allowlist empty.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stacks (same harness as rfb-hidden-test-producer.test.ts and
 * owner-features-s2b.test.ts). Exported runAdminTestProducerOwnerLoginTests
 * ({log}) -> TestSummary. Standalone:
 *   npx tsx src/routes/admin-test-producer-owner-login.test.ts
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
  cookies: Record<string, string>;
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
const REAL_ID = "s2d1-real-producer";
const PRESET_ID = "s2d1-preset-fixture";
const PRESET_CLAIMED_AT = "2026-01-02T00:00:00.000Z";
const ORDER_INBOX = "ordre@fixture-inbox.example.no";
const OWNER_EMAIL = "eier@fixture-owner.example.no";

/** The apply response keys before S2d-1 (must stay exactly these without owner_email). */
const APPLY_KEYS_WITHOUT_OWNER = [
  "success", "dry_run", "mode", "target", "agent_id", "changes", "audit_rows", "product", "can_order", "products_url",
];

function seedAgent(
  db: Database.Database,
  o: { id: string; origin: string; hidden: number; claimedAt: string | null; email: string },
): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
     VALUES (?, ?, 'Testprodusent for S2d-1.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, ?, 'rfb', ?, ?)`,
  ).run(o.id, `Gard ${o.id}`, o.email, `https://${o.id}.example.no`, `key-${o.id}`, o.origin, o.hidden, o.claimedAt);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, about, verification_status, verified_second_line)
     VALUES (?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(o.id, o.email);
}

export async function runAdminTestProducerOwnerLoginTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const cookies: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, cookies }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
        cookie(name: string, value: string) { cookies[name] = String(value); return res; },
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
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of [ALLOW_ENV, GATE_ENV, "ADMIN_KEY"]) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };
  const es = emailMod.emailService as any;
  const prevSendOwner = es.sendOwnerMagicLink;
  const sent: Array<{ to: string; verifyUrl: string }> = [];

  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!ambientKey) process.env.ADMIN_KEY = "s2d1-owner-login-standalone-key";
  const adminKey = () => process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  let tpMod: typeof import("./admin-test-producer") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    setEnv(ALLOW_ENV, null);
    setEnv(GATE_ENV, null);
    es.sendOwnerMagicLink = async (o: any) => {
      sent.push({ to: String(o.to), verifyUrl: String(o.verifyUrl) });
      return { success: true, messageId: "stub" };
    };
    for (const m of ["./admin-test-producer", "./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    tpMod = require("./admin-test-producer") as typeof import("./admin-test-producer");
    tpMod.__setTestProducerDbForTesting(db as any);
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");

    const H = {
      tp: findRouteHandler(tpMod.default, "/", "post"),
      requestLink: findRouteHandler(portalMod.default, "/api/agents/:id/request-magic-link", "post"),
      verify: findRouteHandler(portalMod.default, "/magic-link-verify", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
    };
    const postTp = (body: any) => invoke(H.tp, makeReq({ body, headers: { "x-admin-key": adminKey() } }));
    const fields = (r: HandlerResult) => ((r.body?.changes ?? []) as Array<{ field: string }>).map((c) => c.field);
    const change = (r: HandlerResult, f: string) => ((r.body?.changes ?? []) as any[]).find((c) => c.field === f);
    const login = (id: string) =>
      db.prepare(`SELECT a.claimed_at, k.email FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`).get(id) as
        { claimed_at: string | null; email: string | null } | undefined;
    const auditCount = (id?: string) =>
      (id
        ? (db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ?`).get(id) as any)
        : (db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge_audit`).get() as any)).n as number;
    const auditFor = (id: string, field: string) =>
      db.prepare(`SELECT old_value, new_value, changed_by FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = ? ORDER BY rowid`).all(id, field) as any[];
    const agentCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as any).n as number;

    // ── dry-run, create path (empty DB) ──────────────────────────────────────
    const dry0 = await postTp({ email: ORDER_INBOX, owner_email: OWNER_EMAIL });
    assertEq([dry0.status, dry0.body?.dry_run, dry0.body?.target], [200, true, "create"], "dry-run create: 200, dry_run, target create");
    assertTrue(fields(dry0).includes("agent_knowledge.email") && fields(dry0).includes("claimed_at"), "dry-run create: lists agent_knowledge.email and claimed_at");
    assertEq([change(dry0, "agent_knowledge.email")?.old, change(dry0, "agent_knowledge.email")?.new], [null, OWNER_EMAIL], "dry-run create: email null → owner_email");
    assertTrue(change(dry0, "claimed_at")?.old === null && !!change(dry0, "claimed_at")?.new, "dry-run create: claimed_at null → a timestamp");
    assertTrue(!("owner_login" in (dry0.body ?? {})), "dry-run: no owner_login (apply only)");
    assertEq([agentCount(), auditCount()], [0, 0], "dry-run create: nothing written");

    // ── apply, create path ───────────────────────────────────────────────────
    const ap1 = await postTp({ apply: true, email: ORDER_INBOX, owner_email: OWNER_EMAIL });
    assertEq([ap1.status, ap1.body?.success, ap1.body?.target], [200, true, "create"], "apply create: 200 + created");
    const FIX = String(ap1.body?.agent_id ?? "");
    const l1 = login(FIX);
    assertEq(l1?.email, OWNER_EMAIL, "apply: agent_knowledge.email = owner_email");
    assertTrue(!!l1?.claimed_at, "apply: claimed_at set");
    assertEq(change(ap1, "claimed_at")?.new, l1?.claimed_at, "apply: claimed_at change reports the written value");
    assertEq(auditFor(FIX, "agent_knowledge.email").map((a) => [a.old_value, a.new_value, a.changed_by]), [[null, OWNER_EMAIL, "admin"]], "apply: one audit row for agent_knowledge.email");
    assertEq(auditFor(FIX, "claimed_at").map((a) => [a.old_value, a.new_value]), [[null, l1?.claimed_at]], "apply: one audit row for claimed_at");
    assertEq(ap1.body?.audit_rows, ap1.body?.changes?.length, "apply: audit_rows = changes");
    assertEq(ap1.body?.owner_login, {
      email: OWNER_EMAIL,
      verified_owner: true,
      allowlisted: false,
      valg_path: `/eier/${FIX}/valg`,
      magic_link_request: `POST /api/agents/${FIX}/request-magic-link`,
    }, "apply: owner_login (verified owner, not allowlisted with the env unset)");
    assertEq(sent.length, 0, "apply: the endpoint sends no e-mail");

    // ── second identical apply → no-op for the owner fields ──────────────────
    const audBefore = auditCount(FIX);
    const ap2 = await postTp({ apply: true, email: ORDER_INBOX, owner_email: OWNER_EMAIL, agent_id: FIX });
    assertEq([ap2.status, ap2.body?.target], [200, "existing"], "apply again: 200 existing");
    assertTrue(!fields(ap2).includes("agent_knowledge.email") && !fields(ap2).includes("claimed_at"), "apply again: no email/claimed_at change (idempotent)");
    assertEq(login(FIX), l1, "apply again: email and claimed_at unchanged");
    assertEq(auditCount(FIX) - audBefore, ap2.body?.changes?.length ?? -1, "apply again: audit rows only for real changes");
    assertEq(ap2.body?.owner_login?.verified_owner, true, "apply again: owner_login still present");

    // ── existing claimed_at preserved; dry-run on existing writes nothing ────
    seedAgent(db, { id: PRESET_ID, origin: "test_fixture", hidden: 1, claimedAt: PRESET_CLAIMED_AT, email: "gammel@fixture.example.no" });
    seedAgent(db, { id: REAL_ID, origin: "discovery", hidden: 0, claimedAt: null, email: "post@real.example.no" });
    const dryP = await postTp({ email: ORDER_INBOX, owner_email: OWNER_EMAIL, agent_id: PRESET_ID });
    assertEq(dryP.status, 200, "dry-run existing: 200");
    assertEq(change(dryP, "agent_knowledge.email"), { field: "agent_knowledge.email", old: "gammel@fixture.example.no", new: OWNER_EMAIL }, "dry-run existing: email change listed");
    assertTrue(!fields(dryP).includes("claimed_at"), "dry-run existing: claimed_at already set → no change listed");
    assertEq([login(PRESET_ID)?.email, auditCount(PRESET_ID)], ["gammel@fixture.example.no", 0], "dry-run existing: nothing written");
    const apP = await postTp({ apply: true, email: ORDER_INBOX, owner_email: OWNER_EMAIL, agent_id: PRESET_ID });
    assertEq(apP.status, 200, "apply preset: 200");
    assertEq(login(PRESET_ID), { claimed_at: PRESET_CLAIMED_AT, email: OWNER_EMAIL }, "apply preset: email set, existing claimed_at preserved");
    assertEq(auditFor(PRESET_ID, "claimed_at").length, 0, "apply preset: no claimed_at audit row");

    // ── real producer → 409, nothing written ─────────────────────────────────
    const realBefore = login(REAL_ID);
    const totalAudit = auditCount();
    for (const apply of [false, true]) {
      const r = await postTp({ apply, email: ORDER_INBOX, owner_email: OWNER_EMAIL, agent_id: REAL_ID });
      assertEq([r.status, r.body?.error], [409, "not_a_test_fixture"], `real producer (${apply ? "apply" : "dry-run"}): 409 not_a_test_fixture`);
      assertTrue(!("owner_login" in (r.body ?? {})), `real producer (${apply ? "apply" : "dry-run"}): no owner_login`);
    }
    assertEq(login(REAL_ID), realBefore, "real producer: agent_knowledge.email and claimed_at unchanged");
    assertEq(auditCount(), totalAudit, "real producer: no audit row");

    // ── validation ───────────────────────────────────────────────────────────
    const snap = () => JSON.stringify([login(FIX), login(PRESET_ID), auditCount()]);
    const before = snap();
    for (const apply of [false, true]) {
      const r = await postTp({ apply, mode: "retire", owner_email: OWNER_EMAIL, agent_id: FIX });
      assertEq(r.status, 400, `retire + owner_email (${apply ? "apply" : "dry-run"}): 400`);
    }
    assertEq((await postTp({ apply: true, mode: "retire", owner_email: null, agent_id: FIX })).status, 400, "retire + owner_email null: 400");
    for (const bad of ["nope", "a@b", "", "   ", "a b@c.no", "x@y.no\u0007", 42, null, { e: 1 }, `${"a".repeat(250)}@b.no`]) {
      const r = await postTp({ apply: true, email: ORDER_INBOX, owner_email: bad, agent_id: FIX });
      assertEq(r.status, 400, `malformed owner_email ${JSON.stringify(bad).slice(0, 30)}: 400`);
    }
    assertEq(snap(), before, "validation: nothing written");
    assertEq(login(FIX), l1, "validation: fixture still armed with the owner login (retire refused)");

    // ── without owner_email: today's response ────────────────────────────────
    const plainDry = await postTp({ email: ORDER_INBOX, agent_id: PRESET_ID });
    assertEq(Object.keys(plainDry.body ?? {}), ["success", "dry_run", "mode", "target", "agent_id", "changes"], "no owner_email dry-run: today's keys");
    const plain = await postTp({ apply: true, email: ORDER_INBOX, agent_id: FIX });
    assertEq(Object.keys(plain.body ?? {}), APPLY_KEYS_WITHOUT_OWNER, "no owner_email apply: no owner_login key, today's keys");
    assertTrue(!fields(plain).includes("agent_knowledge.email") && !fields(plain).includes("claimed_at"), "no owner_email: no email/claimed_at change");
    assertEq(login(FIX), l1, "no owner_email: owner login left as is");

    // ── AC21 end to end: magic link → session → «Mine valg» ──────────────────
    const wrong = await invoke(H.requestLink, makeReq({ params: { id: FIX }, body: { email: "annen@example.no" } }));
    assertEq(wrong.status, 404, "e2e: another address is not associated → 404");
    const reqLink = await invoke(H.requestLink, makeReq({ params: { id: FIX }, body: { email: OWNER_EMAIL } }));
    assertEq([reqLink.status, reqLink.body?.success], [200, true], "e2e: request-magic-link with owner_email succeeds");
    assertEq(sent.map((s) => s.to), [OWNER_EMAIL], "e2e: the (stubbed) link goes to owner_email");
    const token = (db.prepare(`SELECT token FROM magic_links WHERE agent_id = ? AND email = ? AND used = 0`).get(FIX, OWNER_EMAIL) as any)?.token as string | undefined;
    assertTrue(!!token && sent[0]?.verifyUrl.endsWith(`token=${token}`), "e2e: magic_links row holds the e-mailed token");
    const ver = await invoke(H.verify, makeReq({ query: { token: token ?? "" } }));
    assertEq([ver.status, ver.body?.__redirect], [302, `/eier/${FIX}/portal`], "e2e: /magic-link-verify → 302 to the portal");
    assertEq(ver.cookies.rfb_owner_session, token, "e2e: session cookie = token");
    const cookieHeader = { cookie: `rfb_owner_session=${ver.cookies.rfb_owner_session ?? ""}` };
    const valg = () => invoke(H.valg, makeReq({ params: { agentId: FIX }, headers: cookieHeader }));

    setEnv(ALLOW_ENV, `rfb:${FIX}`);
    const on = await valg();
    assertEq(on.status, 200, "e2e: allowlisted → GET /eier/<id>/valg 200");
    assertTrue(String(on.body ?? "").includes("Mine valg"), "e2e: the page is «Mine valg»");
    setEnv(GATE_ENV, "1");
    assertEq((await valg()).status, 200, "e2e: also 200 with OWNER_VERIFIED_OWNER_GATE_ENABLED on");
    setEnv(GATE_ENV, null);
    const ap3 = await postTp({ apply: true, email: ORDER_INBOX, owner_email: OWNER_EMAIL, agent_id: FIX });
    assertEq(ap3.body?.owner_login?.allowlisted, true, "e2e: owner_login.allowlisted true once listed");
    setEnv(ALLOW_ENV, "");
    const off = await valg();
    assertTrue(off.status === 404 || off.status === 403, `e2e: allowlist empty → 403/404 (got ${off.status})`);
    setEnv(ALLOW_ENV, null);
    assertTrue([403, 404].includes((await valg()).status), "e2e: allowlist unset → 403/404");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    es.sendOwnerMagicLink = prevSendOwner;
    if (tpMod) tpMod.__setTestProducerDbForTesting(null);
    for (const [k, v] of Object.entries(prevEnv)) setEnv(k, v === undefined ? null : v);
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminTestProducerOwnerLoginTests({ log: true }).then((r) => {
    console.info(`\nadmin-test-producer-owner-login: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

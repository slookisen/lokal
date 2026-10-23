/**
 * avmeld-s1a.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S1a points 3 and 4.
 *
 * Point 3 — working unsubscribe (OUTREACH_UNSUBSCRIBE_ENABLED, default off):
 *   signed /avmeld/:token; GET changes nothing; POST sets an outreach-only
 *   e-mail suppression (email_bounces, bounce_type 'unsubscribe') without
 *   touching the profile; the address falls out of computeOutreachCandidates
 *   and the compose send guard; cold RFB sends carry List-Unsubscribe +
 *   List-Unsubscribe-Post (and the text is untouched); flag off = no route,
 *   no headers.
 * Point 4 — customer-service lock visible to the owner
 *   (OWNER_PORTAL_CS_LOCK_OVERRIDE, default off): «Rettet av kundeservice
 *   <dato>», the owner can save the field, the save stamps by:"owner".
 *
 * Real routers/services on the production schema in an in-memory DB.
 * Exported runAvmeldS1aTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/avmeld-s1a.test.ts
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

const UNSUB_FLAG = "OUTREACH_UNSUBSCRIBE_ENABLED";
const CS_FLAG = "OWNER_PORTAL_CS_LOCK_OVERRIDE";
const SECRET = "avmeld-s1a-test-secret";

export async function runAvmeldS1aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const saved: Record<string, string | undefined> = {
    [UNSUB_FLAG]: process.env[UNSUB_FLAG],
    [CS_FLAG]: process.env[CS_FLAG],
    ADMIN_KEY: process.env.ADMIN_KEY,
    ANALYTICS_ADMIN_KEY: process.env.ANALYTICS_ADMIN_KEY,
    OUTREACH_PAUSED: process.env.OUTREACH_PAUSED,
  };
  const setFlag = (name: string, on: boolean) => { if (on) process.env[name] = "1"; else delete process.env[name]; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return { method: "GET", params: o.params || {}, body: o.body || {}, query: {}, headers, ip: "127.0.0.1", cookies: {}, get: (n: string) => headers[n.toLowerCase()] };
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
        end() { settle(undefined); return res; },
        setHeader() { return res; }, header() { return res; }, set() { return res; }, type() { return res; },
      };
      try {
        const p = handler(req, res, () => settle({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    process.env.ADMIN_KEY = SECRET;
    delete process.env.OUTREACH_PAUSED;

    const av = require("../services/avmeld-service") as typeof import("../services/avmeld-service");
    const avRouter = require("./avmeld").default as any;
    const aoc = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
    const crm = require("./crm") as typeof import("./crm");
    const portal = require("./owner-portal").default as any;
    const vis = require("../services/agent-visibility") as typeof import("../services/agent-visibility");

    const GET = findRouteHandler(avRouter, "/avmeld/:token", "get");
    const POST = findRouteHandler(avRouter, "/avmeld/:token", "post");

    const seed = (id: string, email: string) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active, is_verified, origin, vertical_id)
         VALUES (?, ?, 'test producer', 'test', ?, 'https://avmeld-farm.no', 'producer', ?, 1, 1, 'discovery', 'rfb')`,
      ).run(id, `Gård ${id}`, email, `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed)
         VALUES (?, ?, 'Vi driver en liten gård med sau og honning, og selger kjøtt og honning direkte fra gården hele året.', '{}', 'verified', 'rich', 200, datetime('now'))`,
      ).run(id, email);
    };
    seed("av-1", "post@av1.avmeld-farm.no");
    seed("av-2", "post@av2.avmeld-farm.no");
    const candIds = () =>
      (aoc.computeOutreachCandidates(db as any, { mode: "first", cooldownDays: 60, limit: 100 }).candidates as any[]).map((c) => c.agent_id);
    const bounceCount = () => (db.prepare("SELECT COUNT(*) AS c FROM email_bounces").get() as any).c as number;

    // ═══ Token ═══════════════════════════════════════════════════════════
    assertEq(av.outreachUnsubscribeEnabled(), false, "av-1: flag defaults OFF");
    const token = av.makeUnsubscribeToken("Post@AV1.avmeld-farm.no ")!;
    assertEq(av.verifyUnsubscribeToken(token)?.email, "post@av1.avmeld-farm.no", "av-2: token round-trips the normalized address");
    assertEq(av.makeUnsubscribeToken("post@av1.avmeld-farm.no"), token, "av-3: token is deterministic per address");
    const [pl, sig] = token.split(".");
    const forged = Buffer.from("post@av2.avmeld-farm.no").toString("base64").replace(/=+$/, "") + "." + sig;
    assertEq(av.verifyUnsubscribeToken(forged), null, "av-4: payload swapped under an old signature is rejected");
    assertEq(av.verifyUnsubscribeToken(pl + "." + sig.slice(0, -2) + "xx"), null, "av-5: tampered signature rejected");
    assertEq(av.verifyUnsubscribeToken("garbage"), null, "av-6: garbage rejected");
    process.env.ADMIN_KEY = "another-secret";
    assertEq(av.verifyUnsubscribeToken(token), null, "av-7: token signed with another secret rejected");
    delete process.env.ADMIN_KEY; delete process.env.ANALYTICS_ADMIN_KEY;
    assertEq(av.makeUnsubscribeToken("a@b.no"), null, "av-8: no server secret -> no token");
    process.env.ADMIN_KEY = SECRET;

    // ═══ Flag off: route 404, no headers ═════════════════════════════════
    setFlag(UNSUB_FLAG, false);
    assertEq((await invoke(GET, makeReq({ params: { token } }))).status, 404, "av-9: flag off, GET -> 404");
    assertEq((await invoke(POST, makeReq({ params: { token } }))).status, 404, "av-10: flag off, POST -> 404");
    assertEq(bounceCount(), 0, "av-11: flag off, nothing written");
    assertEq(av.unsubscribeHeaderValues("post@av1.avmeld-farm.no"), null, "av-12: flag off, no header values");

    // ═══ Flag on: GET changes nothing ════════════════════════════════════
    setFlag(UNSUB_FLAG, true);
    const profileBefore = JSON.stringify(db.prepare("SELECT * FROM agents WHERE id = 'av-1'").get()) + JSON.stringify(db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'av-1'").get());
    assertTrue(candIds().includes("av-1"), "av-13: before: av-1 is an outreach candidate");
    const g = await invoke(GET, makeReq({ params: { token } }));
    assertEq(g.status, 200, "av-14: GET with valid token -> 200 confirm page");
    assertTrue(typeof g.body === "string" && g.body.includes("Bekreft avmelding") && g.body.includes('method="post"'), "av-15: GET renders the confirm form");
    assertTrue(!String(g.body).includes(token), "av-16: GET page does not echo the token");
    assertEq(bounceCount(), 0, "av-17: GET writes nothing");
    assertTrue(candIds().includes("av-1"), "av-18: GET leaves the address a candidate");
    assertEq((await invoke(GET, makeReq({ params: { token: "bad.token" } }))).status, 400, "av-19: GET invalid token -> 400");
    assertEq((await invoke(POST, makeReq({ params: { token: "bad.token" } }))).status, 400, "av-20: POST invalid token -> 400");
    assertEq(bounceCount(), 0, "av-21: invalid-token POST writes nothing");

    // ═══ POST sets the suppression ═══════════════════════════════════════
    const p = await invoke(POST, makeReq({ params: { token }, body: { "List-Unsubscribe": "One-Click" } }));
    assertEq(p.status, 200, "av-22: POST valid token -> 200");
    assertTrue(String(p.body).includes("ikke slettet"), "av-23: POST page says the profile is kept");
    const rows = db.prepare("SELECT email, bounce_type, investigated FROM email_bounces").all();
    assertEq(rows, [{ email: "post@av1.avmeld-farm.no", bounce_type: "unsubscribe", investigated: 1 }], "av-24: one unsubscribe row, already investigated");
    await invoke(POST, makeReq({ params: { token } }));
    assertEq(bounceCount(), 1, "av-25: POST is idempotent");
    assertTrue(!candIds().includes("av-1"), "av-26: address is gone from the outreach candidates");
    assertTrue(candIds().includes("av-2"), "av-27: other addresses unaffected");
    const profileAfter = JSON.stringify(db.prepare("SELECT * FROM agents WHERE id = 'av-1'").get()) + JSON.stringify(db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'av-1'").get());
    assertEq(profileAfter, profileBefore, "av-28: profile rows byte-identical (no delete, no opt_out stamp)");
    assertEq((db.prepare("SELECT COUNT(*) AS c FROM agent_blocklist").get() as any).c, 0, "av-29: agent_blocklist untouched (ordering/registration unaffected)");
    const row1 = db.prepare("SELECT * FROM agents WHERE id = 'av-1'").get() as any;
    assertTrue(vis.isAgentPubliclyVisible({ ...row1, is_vetted: 1 }, { surface: "gated" }), "av-30: profile is still publicly visible");
    assertTrue(db.prepare(`SELECT 1 FROM agents a WHERE a.id = 'av-1' AND ${vis.publicListableSql("a")} AND a.is_active = 1`).get() !== undefined, "av-31: profile still in the public list SQL");
    // also holds for a profile with no owner/knowledge-claim (av-2 is unowned too): suppress by token only
    assertEq(JSON.stringify(av.isUnsubscribed("POST@av1.avmeld-farm.no")), "true", "av-32: isUnsubscribed is case-insensitive");

    // ═══ Compose guard + headers ═════════════════════════════════════════
    const sent: any[] = [];
    const sendRaw = async (o: any) => { sent.push(o); return { success: true, messageId: "<m@test>" }; };
    const compose = (to: string, extra: Record<string, unknown> = {}) =>
      crm.executeCompose(
        { to, subject: "Hei", bodyText: "Uendret tekst.\nMvh", intent: "resend_send", category: "marketing", createdBy: "claude", vertical: "rfb", ...extra },
        { sendRaw },
      ) as Promise<any>;

    const blocked = await compose("post@av1.avmeld-farm.no");
    assertEq(blocked.httpStatus, 409, "av-33: compose to an unsubscribed address is refused (409)");
    assertEq(blocked.body.error, "recipient_bounced", "av-34: refusal is the suppression guard");
    assertEq(sent.length, 0, "av-35: nothing reached the transport");

    const ok = await compose("post@av2.avmeld-farm.no");
    assertEq(ok.httpStatus, 200, "av-36: compose to a normal address sends");
    assertEq(sent[0].listUnsubscribePost, "List-Unsubscribe=One-Click", "av-37: cold send has List-Unsubscribe-Post one-click");
    const lu = String(sent[0].listUnsubscribe);
    const m = lu.match(/^<https:\/\/[^/]+\/avmeld\/([^>]+)>$/);
    assertTrue(!!m, "av-38: List-Unsubscribe is one https URL in angle brackets");
    assertEq(m ? av.verifyUnsubscribeToken(m[1])?.email : null, "post@av2.avmeld-farm.no", "av-39: header token is signed for exactly this recipient");
    assertEq(sent[0].textContent, "Uendret tekst.\nMvh", "av-40: outreach text is not changed");

    // non-cold sends do not get the headers
    const reply = await compose("post@av2b.avmeld-farm.no", { category: "innkommende" });
    assertEq(reply.httpStatus, 200, "av-41: non-marketing send ok");
    assertTrue(sent[1].listUnsubscribe === undefined && sent[1].listUnsubscribePost === undefined, "av-42: non-cold send has no unsubscribe headers");

    setFlag(UNSUB_FLAG, false);
    await compose("post@av2c.avmeld-farm.no");
    assertTrue(sent[2].listUnsubscribe === undefined && sent[2].listUnsubscribePost === undefined, "av-43: flag off, cold send has no headers");
    assertEq((await compose("post@av1.avmeld-farm.no")).httpStatus, 409, "av-44: existing suppression still honoured with the flag off");
    assertTrue(!candIds().includes("av-1"), "av-45: gate still honours it with the flag off");

    // email-service header plumbing (real sendRaw with a stub transporter)
    {
      const { emailService } = require("../services/email-service") as typeof import("../services/email-service");
      const es: any = emailService;
      const prevT = es.transporter, prevC = es.isConfigured;
      let mail: any = null;
      es.transporter = { sendMail: async (m: any) => { mail = m; return { messageId: "<x>" }; } };
      es.isConfigured = true;
      try {
        await emailService.sendRaw({ to: "a@b.no", subject: "s", textContent: "t", listUnsubscribe: "<https://x/avmeld/t>", listUnsubscribePost: "List-Unsubscribe=One-Click" });
        assertEq(mail?.headers?.["List-Unsubscribe"], "<https://x/avmeld/t>", "av-46: sendRaw sets List-Unsubscribe");
        assertEq(mail?.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "av-47: sendRaw sets List-Unsubscribe-Post");
        await emailService.sendRaw({ to: "a@b.no", subject: "s", textContent: "t" });
        assertTrue(mail?.headers?.["List-Unsubscribe"] === undefined, "av-48: sendRaw without the option sets no header");
      } finally {
        es.transporter = prevT; es.isConfigured = prevC;
      }
    }

    // ═══ Point 4 — customer-service lock in the owner portal ═════════════
    const cs = require("../services/owner-cs-lock") as typeof import("../services/owner-cs-lock");
    seed("cs-1", "post@cs1.avmeld-farm.no");
    db.prepare("UPDATE agent_knowledge SET phone = '11111111', about = 'Rettet tekst fra kundeservice for gården.', curated_fields = ? WHERE agent_id = 'cs-1'")
      .run(JSON.stringify({
        phone: { by: "rfb-customer-service", locked_at: "2026-10-20T09:00:00.000Z" },
        about: { by: "admin", locked_at: "2026-10-20T09:00:00.000Z" },
      }));
    db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES ('ml1', 'post@cs1.avmeld-farm.no', 'tok-cs-1', 'cs-1', 1, datetime('now', '+1 day'))").run();
    const auth = { authorization: "Bearer tok-cs-1" };
    const PROFILE = findRouteHandler(portal, "/api/agents/:id/profile", "get");
    const UPDATE = findRouteHandler(portal, "/api/agents/:id/update-profile", "post");
    const curated = () => JSON.parse((db.prepare("SELECT curated_fields FROM agent_knowledge WHERE agent_id = 'cs-1'").get() as any).curated_fields);

    setFlag(CS_FLAG, false);
    assertEq(cs.ownerPortalCsLockOverrideEnabled(), false, "cs-1: flag defaults OFF");
    const pOff = await invoke(PROFILE, makeReq({ params: { id: "cs-1" }, headers: auth }));
    assertEq(pOff.body.fields.phone.editable, false, "cs-2: flag off, cs-locked field not editable (today)");
    assertTrue(pOff.body.fields.phone.locked_note === undefined, "cs-3: flag off, no note");
    const uOff = await invoke(UPDATE, makeReq({ params: { id: "cs-1" }, headers: auth, body: { phone: "22222222" } }));
    assertEq(uOff.body.skipped_fields, [{ field: "phone", reason: "locked_by_rfb-customer-service" }], "cs-4: flag off, owner save skipped (today)");
    assertEq((db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = 'cs-1'").get() as any).phone, "11111111", "cs-5: flag off, value unchanged");

    setFlag(CS_FLAG, true);
    const pOn = await invoke(PROFILE, makeReq({ params: { id: "cs-1" }, headers: auth }));
    assertEq(pOn.body.fields.phone.editable, true, "cs-6: flag on, cs-locked field is editable");
    assertEq(pOn.body.fields.phone.locked_note, "Rettet av kundeservice 20.10.2026", "cs-7: «Rettet av kundeservice <dato>»");
    assertEq(pOn.body.fields.description.editable, false, "cs-8: flag on, an admin lock still blocks the owner");
    assertEq(cs.csLockNote({ by: "rfb-customer-service" }), "Rettet av kundeservice", "cs-9: note without a date when locked_at is missing");

    const uOn = await invoke(UPDATE, makeReq({ params: { id: "cs-1" }, headers: auth, body: { phone: "22222222", description: "Eier prøver å overstyre admin-låsen." } }));
    assertEq(uOn.body.updated_fields, ["phone"], "cs-10: flag on, owner save of the cs-locked field succeeds");
    assertEq(uOn.body.skipped_fields, [{ field: "description", reason: "locked_by_admin" }], "cs-11: admin-locked field is still skipped");
    assertEq((db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = 'cs-1'").get() as any).phone, "22222222", "cs-12: new value stored");
    assertEq(curated().phone.by, "owner", "cs-13: the save stamps by:\"owner\"");
    assertEq(curated().about.by, "admin", "cs-14: other locks untouched");
    const pAfter = await invoke(PROFILE, makeReq({ params: { id: "cs-1" }, headers: auth }));
    assertTrue(pAfter.body.fields.phone.editable === true && pAfter.body.fields.phone.locked_note === undefined, "cs-15: after the owner save the note is gone (lock is owner's)");

    // Source pins: the portal HTML renders the note, behind the same helper.
    const src = require("fs").readFileSync(require("path").join(__dirname, "owner-portal.ts"), "utf8") as string;
    assertTrue(/isOverridableCsLock\(lockInfo\)/.test(src) && /csLockNote\(lockInfo\)/.test(src), "cs-16: portal page uses the cs-lock helper");
  } catch (err) {
    failed++;
    failures.push("avmeld-s1a: unexpected error: " + String((err as any)?.stack || err));
  } finally {
    console.log = prevLog;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAvmeldS1aTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}

/**
 * owner-flag-pilot.test.ts — dev-request 2026-11-05-eierflagg-koblet-til-
 * pilotlisten. Four owner flags accept `pilot`: on only for an owner in
 * OWNER_FEATURES_ALLOWED_SUBJECTS (`rfb:<agentId>`).
 *
 *   AC3   ownerFlagMode: "1"/"true" → all, exactly "pilot" → pilot, anything
 *         else (unset, "", "0", "Pilot", "pilot ", " pilot", "yes", "TRUE") →
 *         off; ownerFlagEnabledFor: pilot without an agent id → off.
 *   AC1/2 per call site, table-driven over off / pilot / "1" / "true", for a
 *         listed owner (PIL) and a verified owner outside the list (OUT):
 *           PRODUCT_IMPORT_ENABLED          portal card, JSON API (owner-product-import)
 *           OWNER_ORDER_EMAIL_ENABLED       portal section + status alert, POST
 *                                           /api/agents/:id/order-email, POST
 *                                           /eier/:id/order-email, GET/POST confirm
 *                                           token, «Mine valg» orders.email row
 *           OWNER_UNIFIED_SESSION_ENABLED   portal card, POST /eier/:id/selger,
 *                                           /selger login (marketplace magic-verify),
 *                                           «Mine valg» items link
 *           PRODUCT_IMPORT_OUTREACH_ENABLED landing GET/POST, /eier login return
 *                                           path, admin POST /prepare
 *   AC4   POST /admin/product-import/prepare with pilot: listed ids start,
 *         the others are rejected per id in the response, nothing started for them.
 *   AC5   switch probe reports all four flags with their mode.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; route
 * handlers invoked directly; fake fetch (no network). Env restored in finally.
 * Exported runOwnerFlagPilotTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/owner-features/owner-flag-pilot.test.ts
 */

import crypto from "crypto";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "PRODUCT_IMPORT_ENABLED", "OWNER_ORDER_EMAIL_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "PRODUCT_IMPORT_OUTREACH_ENABLED",
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_PAUSE_ENABLED",
  "OWNER_FEATURES_ENFORCE", "OWNER_AUTO_UPDATES_ENABLED", "PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY", "UNSUBSCRIBE_TOKEN_SECRET",
  "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "APP_URL", "OWNER_LOCK_ENFORCE_WRITES",
];
const DAY = 86_400_000;
const KEY = "test-admin-key-owner-flag-pilot";
const PIL = "fp-pilot";
const OUT = "fp-out";
const CAMPAIGN = "pilot-flagg";

/** Table rows: [label, env value]. "all" rows must behave exactly like today's "1"/"true". */
const MODES: Array<[string, string | null]> = [["off", null], ["pilot", "pilot"], ["all-1", "1"], ["all-true", "true"]];
const expectOn = (mode: string, agentId: string) => mode.startsWith("all") || (mode === "pilot" && agentId === PIL);

export async function runOwnerFlagPilotTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => undefined; console.error = () => undefined; }

  let op: typeof import("../services/product-import/outreach-prepare") | null = null;
  let oi: typeof import("../services/product-import/owner-import") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    process.env.ADMIN_KEY = KEY;

    const fm = require("./owner-flag-mode") as typeof import("./owner-flag-mode");
    oi = require("../services/product-import/owner-import") as typeof import("../services/product-import/owner-import");
    op = require("../services/product-import/outreach-prepare") as typeof import("../services/product-import/outreach-prepare");
    const ol = require("../services/product-import/outreach-landing") as typeof import("../services/product-import/outreach-landing");
    const robots = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
    const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
    const featuresMod = require("../routes/owner-features") as typeof import("../routes/owner-features");
    const importRouter = (require("../routes/owner-product-import") as any).default;
    const landingRouter = (require("../routes/owner-product-outreach") as any).default;
    const adminRouter = (require("../routes/admin-product-import") as any).default;
    const marketRouter = (require("../routes/marketplace") as any).default;
    const ks = (require("../services/knowledge-service") as typeof import("../services/knowledge-service")).knowledgeService;
    const probe = require("./switch-probe") as typeof import("./switch-probe");
    robots.__clearRobotsCacheForTesting();
    oi.__forgetOwnerFetchJobsForTesting();

    // ─── AC3: the shared reader ─────────────────────────────────────────────
    {
      const cases: Array<[string | undefined, string]> = [
        [undefined, "off"], ["", "off"], ["0", "off"], ["1", "all"], ["true", "all"], ["pilot", "pilot"],
        ["Pilot", "off"], ["PILOT", "off"], ["pilot ", "off"], [" pilot", "off"], ["yes", "off"], ["TRUE", "off"],
        ["on", "off"], ["2", "off"], [" 1", "off"], ["false", "off"],
      ];
      for (const [v, want] of cases) {
        const env: NodeJS.ProcessEnv = v === undefined ? {} : { X_FLAG: v };
        assertEq(fm.ownerFlagMode("X_FLAG", env), want, `AC3: ownerFlagMode(${JSON.stringify(v)}) = ${want}`);
      }
      const allow = { OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${PIL}, rfb:other` };
      assertEq(
        [fm.ownerFlagEnabledFor("X", PIL, { ...allow, X: "pilot" }), fm.ownerFlagEnabledFor("X", OUT, { ...allow, X: "pilot" }),
          fm.ownerFlagEnabledFor("X", "", { ...allow, X: "pilot" }), fm.ownerFlagEnabledFor("X", null, { ...allow, X: "pilot" }),
          fm.ownerFlagEnabledFor("X", undefined, { ...allow, X: "pilot" })],
        [true, false, false, false, false], "AC3: pilot → only the listed agent; no agent id → off");
      assertEq([fm.ownerFlagEnabledFor("X", OUT, { X: "1" }), fm.ownerFlagEnabledFor("X", null, { X: "true" }), fm.ownerFlagEnabledFor("X", "", { X: "1" })],
        [true, true, true], "AC2: \"1\"/\"true\" → on for everyone, as today (no list, no agent id needed)");
      assertEq([fm.ownerFlagEnabledFor("X", PIL, { ...allow }), fm.ownerFlagEnabledFor("X", PIL, { ...allow, X: "Pilot" }), fm.ownerFlagEnabledFor("X", PIL, { ...allow, X: "pilot " })],
        [false, false, false], "AC3: off / \"Pilot\" / \"pilot \" → off even for a listed agent");
      assertEq(fm.ownerFlagEnabledFor("X", PIL, { X: "pilot" }), false, "AC3: pilot with an empty list → nobody");
      assertEq(fm.ownerFlagEnabledFor("X", PIL, { X: "pilot", OWNER_FEATURES_ALLOWED_SUBJECTS: `gardssalg:${PIL}` }), false, "AC3: pilot reads only rfb: subjects");

      // The four per-flag readers.
      const per: Array<[string, (id: string) => boolean]> = [
        ["PRODUCT_IMPORT_ENABLED", (id) => oi!.productImportEnabledFor(id)],
        ["OWNER_ORDER_EMAIL_ENABLED", (id) => portalMod.ownerOrderEmailEnabledFor(id)],
        ["OWNER_UNIFIED_SESSION_ENABLED", (id) => portalMod.ownerUnifiedSessionEnabledFor(id)],
        ["PRODUCT_IMPORT_OUTREACH_ENABLED", (id) => op!.productImportOutreachEnabledFor(id)],
      ];
      setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", `rfb:${PIL}`);
      for (const [flag, f] of per) {
        for (const [mode, v] of [...MODES, ["Pilot", "Pilot"], ["pilot-space", "pilot "], ["yes", "yes"], ["zero", "0"], ["empty", ""]] as Array<[string, string | null]>) {
          setEnv(flag, v);
          assertEq([f(PIL), f(OUT)], [expectOn(mode, PIL), expectOn(mode, OUT)], `AC1/AC3: ${flag}=${JSON.stringify(v)} → [listed, unlisted]`);
        }
        setEnv(flag, null);
      }
      // The old all-or-nothing readers keep their meaning ("1"/"true" only).
      setEnv("PRODUCT_IMPORT_ENABLED", "pilot");
      setEnv("OWNER_ORDER_EMAIL_ENABLED", "pilot");
      setEnv("OWNER_UNIFIED_SESSION_ENABLED", "pilot");
      setEnv("PRODUCT_IMPORT_OUTREACH_ENABLED", "pilot");
      assertEq([oi.productImportEnabled(), portalMod.ownerOrderEmailEnabled(), portalMod.ownerUnifiedSessionEnabled(), op.productImportOutreachEnabled()],
        [false, false, false, false], "AC2: the global readers are true only for \"1\"/\"true\" (pilot is per owner)");
      for (const k of fm.OWNER_PILOT_FLAGS) setEnv(k, null);
      setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", null);
    }

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = {
      portal: handlerOf(portalMod.default, "/eier/:agentId/portal", "get"),
      selger: handlerOf(portalMod.default, "/eier/:agentId/selger", "post"),
      apiOrderEmail: handlerOf(portalMod.default, "/api/agents/:id/order-email", "post"),
      eierOrderEmail: handlerOf(portalMod.default, "/eier/:agentId/order-email", "post"),
      confirmGet: handlerOf(portalMod.default, "/eier/ordre-epost/bekreft/:token", "get"),
      confirmPost: handlerOf(portalMod.default, "/eier/ordre-epost/bekreft/:token", "post"),
      verify: handlerOf(portalMod.default, "/magic-link-verify", "get"),
      valg: handlerOf(featuresMod.default, "/eier/:agentId/valg", "get"),
      sett: handlerOf(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
      importApi: handlerOf(importRouter, "/api/agents/:id/product-import", "get"),
      landingGet: handlerOf(landingRouter, "/eier/:agentId/varer/forslag", "get"),
      landingPost: handlerOf(landingRouter, "/eier/:agentId/varer/forslag", "post"),
      prepare: handlerOf(adminRouter, "/prepare", "post"),
      prepareReport: handlerOf(adminRouter, "/prepare/:campaign", "get"),
      selgerLogin: handlerOf(marketRouter, "/auth/magic-verify", "get"),
    };
    type Res = { status: number; body: any; location?: string; cookies: string[]; cleared: string[] };
    const invoke = (handler: Function, o: {
      params?: Record<string, string>; token?: string; body?: any; headers?: Record<string, string>; query?: Record<string, string>;
      cookies?: Record<string, string>;
    }) =>
      new Promise<Res>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        const req: any = {
          method: "GET", url: "/", path: "/", originalUrl: "/", params: o.params || {}, body: o.body, query: o.query || {}, headers,
          cookies: o.cookies || {}, ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
          get: (n: string) => headers[n.toLowerCase()],
        };
        let status = 200;
        let settled = false;
        const cookies: string[] = [];
        const cleared: string[] = [];
        const settle = (r: Omit<Res, "cookies" | "cleared">) => { if (!settled) { settled = true; resolve({ ...r, cookies, cleared }); } };
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { settle({ status, body: b }); return res; },
          send(b: any) { settle({ status, body: b }); return res; },
          end() { settle({ status, body: "" }); return res; },
          redirect(c: number, loc: string) { settle({ status: c, body: "", location: loc }); return res; },
          setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; },
          cookie(name: string) { cookies.push(name); return res; },
          clearCookie(name: string) { cleared.push(name); return res; },
        };
        try {
          const p = handler(req, res, () => settle({ status: 0, body: "next" }));
          if (p && typeof p.catch === "function") p.catch((e: any) => settle({ status: -1, body: String(e) }));
        } catch (e) { settle({ status: -1, body: String(e) }); }
      });
    const html = (r: Res) => String(r.body ?? "");
    const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as any)?.n ?? 0);

    // ─── Fixture: two verified owners, only PIL on the pilot list ──────────
    const email = (id: string) => `post@${id}.example.no`;
    const tokens: Record<string, string> = {};
    for (const id of [PIL, OUT]) {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, claimed_at, vertical_id)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, 1, 0, 0, 0, datetime('now'), datetime('now'), '2026-10-01T00:00:00.000Z', 'rfb')`,
      ).run(id, `Gard ${id}`, email(id), `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, '[]', 'hybrid', 'verified', 0)`,
      ).run(id, email(id), `https://${id}.no`);
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at, verified_at)
         VALUES (?, ?, 'Eier', ?, 'verified', ?, ?, '2026-10-01T00:00:00.000Z')`,
      ).run(`claim-${id}`, id, email(id), `claim_${id}_0`, new Date(Date.now() + 30 * DAY).toISOString());
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, email(id), tokens[id], id, new Date().toISOString(), new Date(Date.now() + 30 * DAY).toISOString());
    }
    setEnv("OWNER_FEATURES_ALLOWED_SUBJECTS", `rfb:${PIL}`);
    const portal = (id: string, query: Record<string, string> = {}) => invoke(H.portal, { params: { agentId: id }, token: tokens[id], query });
    const valgPage = (id: string) => invoke(H.valg, { params: { agentId: id }, token: tokens[id] });
    const valgRow = (b: string, key: string) => {
      const i = b.indexOf(`data-key="${key}"`);
      if (i < 0) return "";
      const ctl = b.indexOf(`<div class="mv-item-ctl">`, i);
      return b.slice(i, b.indexOf("</div>\n        </li>", ctl));
    };
    const withMode = async (flag: string, fn: (mode: string) => Promise<void>) => {
      for (const [mode, v] of MODES) {
        setEnv(flag, v);
        await fn(mode);
      }
      setEnv(flag, null);
    };
    // «Mine valg» (owner-features.ts) is only for listed subjects: PIL. Orders on, so the orders.email row shows.
    {
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      const s = await invoke(H.sett, { params: { agentId: PIL }, token: tokens[PIL], body: { key: "orders.enabled", value: "true", confirmed: "1" } });
      assertEq(s.status, 303, "setup: orders switched on for the listed owner through «Mine valg»");
      assertEq((await valgPage(OUT)).status, 404, "setup: «Mine valg» is 404 for the unlisted owner (as before, independent of these flags)");
    }

    // ─── PRODUCT_IMPORT_ENABLED ────────────────────────────────────────────
    await withMode("PRODUCT_IMPORT_ENABLED", async (mode) => {
      for (const id of [PIL, OUT]) {
        const on = expectOn(mode, id);
        const p = await portal(id);
        assertTrue(p.status === 200 && html(p).includes('data-product-import-card="1"') === on,
          `PRODUCT_IMPORT ${mode} ${id}: portal card ${on ? "shown" : "absent"} (owner-portal productImportCardVisible)`);
        const api = await invoke(H.importApi, { params: { id }, token: tokens[id] });
        assertEq(api.status, on ? 200 : 404, `PRODUCT_IMPORT ${mode} ${id}: GET /api/agents/:id/product-import (owner-product-import access check)`);
      }
    });

    // ─── OWNER_ORDER_EMAIL_ENABLED ─────────────────────────────────────────
    const orderEmailToken = (id: string): string => {
      const raw = crypto.randomBytes(32).toString("hex");
      const now = new Date();
      db.prepare(
        `INSERT INTO owner_order_email_change (token_hash, agent_id, new_email, requested_at, expires_at, requested_by, owner_basis)
         VALUES (?, ?, ?, ?, ?, 'owner', ?)`,
      ).run(crypto.createHash("sha256").update(raw).digest("hex"), id, `ny@${id}.example.no`, now.toISOString(),
        new Date(now.getTime() + DAY).toISOString(), portalMod.ownerBasisFingerprint(id));
      return raw;
    };
    const orderEmailOf = (id: string) => (db.prepare("SELECT order_notification_email AS v FROM agents WHERE id = ?").get(id) as any)?.v ?? null;
    await withMode("OWNER_ORDER_EMAIL_ENABLED", async (mode) => {
      for (const id of [PIL, OUT]) {
        const on = expectOn(mode, id);
        const p = html(await portal(id, { status: "order_email_sent" }));
        assertEq(p.includes("Vi har sendt en bekreftelse til den nye adressen."), on, `ORDER_EMAIL ${mode} ${id}: portal status alert`);
        // The unlisted owner has no «Mine valg», so the section sits in the portal; the listed one has it in «Mine valg».
        if (id === OUT) assertEq(p.includes('id="ordre-epost"'), on, `ORDER_EMAIL ${mode} ${id}: portal «Ordre sendes til» section`);
        const api = await invoke(H.apiOrderEmail, { params: { id }, token: tokens[id], body: { email: "ikke-en-adresse" } });
        assertTrue(on ? api.status !== 404 && api.body?.error !== "not_found" : api.status === 404,
          `ORDER_EMAIL ${mode} ${id}: POST /api/agents/:id/order-email ${on ? "answers (not 404)" : "404"} (got ${api.status})`);
        const form = await invoke(H.eierOrderEmail, { params: { agentId: id }, token: tokens[id], body: { email: "ikke-en-adresse" } });
        assertTrue(on ? form.status === 303 : form.status === 404, `ORDER_EMAIL ${mode} ${id}: POST /eier/:id/order-email ${on ? "303" : "404"} (got ${form.status})`);
        const t = orderEmailToken(id);
        const g = await invoke(H.confirmGet, { params: { token: t } });
        assertTrue(on ? g.status === 200 && html(g).includes("Bekreft adressen") : g.status === 404,
          `ORDER_EMAIL ${mode} ${id}: GET confirm link ${on ? "shows the form" : "404"} (got ${g.status})`);
        const before = orderEmailOf(id);
        const c = await invoke(H.confirmPost, { params: { token: t } });
        assertTrue(on ? c.status === 200 && orderEmailOf(id) === `ny@${id}.example.no` : c.status === 404 && orderEmailOf(id) === before,
          `ORDER_EMAIL ${mode} ${id}: POST confirm ${on ? "writes the new address" : "404, nothing written"} (got ${c.status})`);
        db.prepare("UPDATE agents SET order_notification_email = NULL WHERE id = ?").run(id);
        if (id === PIL) {
          const row = valgRow(html(await valgPage(PIL)), "orders.email");
          assertTrue(row.length > 0 && row.includes(`action="/eier/${PIL}/valg/ordre-epost"`) === on,
            `ORDER_EMAIL ${mode} ${id}: «Mine valg» orders.email row ${on ? "has" : "has no"} the change form (owner-features)`);
        }
      }
      const unknown = await invoke(H.confirmGet, { params: { token: "0".repeat(64) } });
      assertEq(unknown.status, mode.startsWith("all") ? 400 : 404, `ORDER_EMAIL ${mode}: unknown confirm token → ${mode.startsWith("all") ? "400 as today" : "404 (pilot: no agent id = off)"}`);
    });

    // ─── OWNER_UNIFIED_SESSION_ENABLED ─────────────────────────────────────
    await withMode("OWNER_UNIFIED_SESSION_ENABLED", async (mode) => {
      for (const id of [PIL, OUT]) {
        const on = expectOn(mode, id);
        assertEq(html(await portal(id)).includes(`action="/eier/${id}/selger"`), on, `UNIFIED ${mode} ${id}: portal «Produkter og åpningstider» card`);
        const br = await invoke(H.selger, { params: { agentId: id }, token: tokens[id] });
        assertTrue(on ? br.status === 303 && String(br.location).startsWith("/selger?magic=") : br.status === 404,
          `UNIFIED ${mode} ${id}: POST /eier/:id/selger ${on ? "303 to /selger" : "404"} (got ${br.status})`);
        const link = ks.createMagicLink(email(id));
        const login = await invoke(H.selgerLogin, { query: { token: String(link.token) } });
        assertTrue(login.status === 200 && login.body?.success === true && login.cookies.includes("rfb_owner_session") === on,
          `UNIFIED ${mode} ${id}: /selger login (marketplace magic-verify) ${on ? "also opens" : "opens no"} /eier session`);
        if (id === PIL) {
          const row = valgRow(html(await valgPage(PIL)), "orders.enabled");
          assertEq(row.includes(`href="/eier/${PIL}/portal#produkter"`), on, `UNIFIED ${mode} ${id}: «Mine valg» items link goes to the portal card`);
        }
      }
    });

    // ─── PRODUCT_IMPORT_OUTREACH_ENABLED ───────────────────────────────────
    const fetchCalls: string[] = [];
    op.__setOutreachDepsForTesting({
      fetchImpl: (async (input: any) => {
        fetchCalls.push(String(typeof input === "string" ? input : input?.url ?? input));
        return new Response("<html><body>404</body></html>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      }) as unknown as typeof fetch,
      llm: async () => ({ text: "[]" }),
      sleep: async () => undefined,
      hostIntervalMs: 0,
    });
    const outTok = (id: string) => ol.makeOutreachToken(id, CAMPAIGN, Date.now() - 60_000) || "";
    await withMode("PRODUCT_IMPORT_OUTREACH_ENABLED", async (mode) => {
      for (const id of [PIL, OUT]) {
        const on = expectOn(mode, id);
        const t = outTok(id);
        const g = await invoke(H.landingGet, { params: { agentId: id }, query: { t } });
        assertTrue(on ? g.status === 200 && html(g).includes('data-outreach-login="1"') : g.status === 404 && html(g).includes("Fant ikke siden"),
          `OUTREACH ${mode} ${id}: landing GET ${on ? "login page" : "404"} (got ${g.status})`);
        const p = await invoke(H.landingPost, { params: { agentId: id }, body: { t } });
        assertEq(p.status, on ? 401 : 404, `OUTREACH ${mode} ${id}: landing POST without a session ${on ? "401 (route on)" : "404"}`);
        const back = ol.outreachLandingPath(id, t);
        const ml = `mlx-${mode}-${id}`;
        db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
          .run(`ml-${ml}`, email(id), ml, id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
        const v = await invoke(H.verify, { query: { token: ml }, cookies: { [ol.OUTREACH_RETURN_COOKIE]: back } });
        assertEq(v.location, on ? back : `/eier/${id}/portal`, `OUTREACH ${mode} ${id}: /eier login ${on ? "returns to the landing page" : "goes to the portal"}`);
      }
    });

    // ─── AC4: POST /admin/product-import/prepare ──────────────────────────
    {
      const post = (body: any) => invoke(H.prepare, { body, headers: { "x-admin-key": KEY } });
      const runsOf = (campaign: string) => (db.prepare("SELECT agent_id FROM product_import_runs WHERE campaign = ? ORDER BY agent_id").all(campaign) as any[]).map((r) => r.agent_id);

      const off = await post({ agentIds: [PIL, OUT], campaign: "prep-off" });
      assertEq([off.status, runsOf("prep-off")], [404, []], "AC4: flag off → 404, nothing started (unchanged)");

      setEnv("PRODUCT_IMPORT_OUTREACH_ENABLED", "pilot");
      const p = await post({ agentIds: [PIL, OUT], campaign: "prep-pilot" });
      assertEq([p.status, p.body?.recipients_total, p.body?.flag_mode], [202, 1, "pilot"], "AC4: pilot → 202, only the listed id is a recipient (route not 404)");
      assertEq((p.body?.rejected || []).map((r: any) => [r.agent_id, r.error]), [[OUT, "not_in_pilot_list"]], "AC4: the unlisted id is rejected per id in the response");
      assertTrue(typeof p.body?.rejected?.[0]?.message === "string" && p.body.rejected[0].message.length > 0, "AC4: the rejection carries a readable message");
      await op.__awaitOutreachPrepareForTesting(p.body.prepare_id);
      assertEq(runsOf("prep-pilot"), [PIL], "AC4: a run only for the listed id; nothing started for the rejected one");
      assertTrue(!fetchCalls.some((u) => u.includes(OUT)), "AC4: nothing fetched for the rejected id");
      assertEq((await invoke(H.prepareReport, { params: { campaign: "prep-pilot" }, headers: { "x-admin-key": KEY } })).status, 200, "AC4: pilot → the report route answers (not 404)");

      const none = await post({ agentIds: [OUT], campaign: "prep-none" });
      assertEq([none.status, none.body?.error, (none.body?.rejected || []).map((r: any) => r.agent_id), runsOf("prep-none")],
        [400, "no_pilot_agent_ids", [OUT], []], "AC4: pilot with no listed id → 400 with the per-id rejection, nothing started");

      setEnv("PRODUCT_IMPORT_OUTREACH_ENABLED", "1");
      const all = await post({ agentIds: [PIL, OUT], campaign: "prep-all" });
      assertEq([all.status, all.body?.recipients_total, "rejected" in (all.body || {}), "flag_mode" in (all.body || {})], [202, 2, false, false],
        "AC4/AC2: \"1\" → both started, response shape unchanged");
      await op.__awaitOutreachPrepareForTesting(all.body.prepare_id);
      assertEq(runsOf("prep-all"), [OUT, PIL].sort(), "AC2: \"1\" → a run per id, as today");
      setEnv("PRODUCT_IMPORT_OUTREACH_ENABLED", null);
    }

    // ─── AC5: switch probe reports all four flags with their mode ─────────
    {
      for (const f of fm.OWNER_PILOT_FLAGS) {
        assertTrue((probe.SWITCH_PROBE_ENV_FLAGS as readonly string[]).includes(f), `AC5: ${f} is in SWITCH_PROBE_ENV_FLAGS`);
      }
      const env: NodeJS.ProcessEnv = {
        OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${PIL}`, PRODUCT_IMPORT_ENABLED: "pilot", OWNER_ORDER_EMAIL_ENABLED: "1",
        OWNER_UNIFIED_SESSION_ENABLED: "Pilot", PRODUCT_IMPORT_OUTREACH_ENABLED: "true",
      };
      const want = { PRODUCT_IMPORT_ENABLED: "pilot", OWNER_ORDER_EMAIL_ENABLED: "all", OWNER_UNIFIED_SESSION_ENABLED: "off", PRODUCT_IMPORT_OUTREACH_ENABLED: "all" };
      const dry = probe.dryRunSwitchProbe(PIL, { db, env });
      assertEq(dry.owner_flag_modes, want, "AC5: dry run reports the mode of each of the four flags");
      assertEq(dry.plan.owner_flag_modes, want, "AC5: the plan carries the modes too");
      assertEq([dry.env_flags.PRODUCT_IMPORT_ENABLED, dry.env_flags.OWNER_ORDER_EMAIL_ENABLED, dry.env_flags.OWNER_UNIFIED_SESSION_ENABLED, dry.env_flags.PRODUCT_IMPORT_OUTREACH_ENABLED],
        ["pilot", "1", "Pilot", "true"], "AC5: env_flags keeps the raw values (existing shape)");
      assertTrue(dry.markdown.includes("| PRODUCT_IMPORT_ENABLED | pilot |") && dry.markdown.includes("| OWNER_UNIFIED_SESSION_ENABLED | off |"), "AC5: the plan report lists the modes");
      const md = probe.renderSwitchProbeMarkdown({ ...dry, markdown: "" } as any);
      assertTrue(md.includes("## Eierflagg med pilotmodus") && md.includes("| OWNER_ORDER_EMAIL_ENABLED | all |"), "AC5: the run report lists the modes");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    op?.__setOutreachDepsForTesting(null);
    try { oi?.__forgetOwnerFetchJobsForTesting(); } catch { /* ignore */ }
    console.log = prevLog;
    console.error = prevErr;
    for (const k of SAVED_ENV) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFlagPilotTests({ log: true }).then((r) => {
    console.info(`\nowner-flag-pilot: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

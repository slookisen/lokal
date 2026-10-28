/**
 * owner-features-s2a.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2a «Mine valg»: registry, storage, lookup and owner API.
 *
 *   registry   all 49 Vedlegg A keys in appendix order, each with NO+EN texts,
 *              group, default per segment, status, surfaces; the S2a live set.
 *   lookup     unknown key throws; resolution order kill switch → admin lock →
 *              requirements/locks → owner value → segment default; AC9 (a
 *              changed registry default never changes a stored choice).
 *   api        GET shape; PUT 200 + exactly one audit row; no-op PUT writes no
 *              audit; 409 coming_soon / guarantee / locked / unmet requirement /
 *              admin lock with Norwegian reason; 400 invalid value; 404 unknown
 *              key; 401/403 (e-mail-match session without verified ownership);
 *              allowlist 404 (env unset / subject not listed); Origin check;
 *              per-session rate limit.
 *   AC11       orders.enabled via PUT writes agents.order_notifications_opt_in
 *              and isEligibleForRealOrder() answers the same as for a twin
 *              producer switched through the existing Bestillinger route.
 *
 * Real router + services on the production schema in an in-memory DB; handlers
 * pulled off the router stack (same harness as owner-order-email-s1b7.test.ts).
 * Exported runOwnerFeaturesS2aTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s2a.test.ts
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
  headers: Record<string, string>;
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const KILL_ENV = "S2A_TEST_FIXTURE_KILL";
const OWNED_ID = "s2a-owned";
const TWIN_ID = "s2a-twin";
const UNBADGED_ID = "s2a-unbadged";
const EMAILMATCH_ID = "s2a-emailmatch";
const OTHER_ID = "s2a-other";

/** Vedlegg A — katalog v1, in appendix order (49). */
const VEDLEGG_A_KEYS = [
  "visibility.profile", "visibility.ai_assistants", "visibility.search_engines", "visibility.shopping_feeds",
  "visibility.english", "visibility.leaderboard",
  "contact.phone", "contact.email_mode", "contact.address",
  "products.import", "products.weekly_sync", "products.show_prices", "products.stock_check",
  "orders.enabled", "orders.email", "orders.pause", "orders.pickup_times", "orders.buyer_ai", "orders.messages",
  "orders.auto_close", "orders.reminder", "orders.gardssalg", "orders.daily_cap", "orders.min_value",
  "orders.lead_time", "orders.delivery", "orders.auto_confirm",
  "payments.prepay", "payments.pay_at_pickup",
  "notify.order_email", "notify.order_sms", "notify.report", "notify.milestones", "notify.changes",
  "auto.guarantee", "auto.updates", "auto.debio", "auto.categories", "auto.affiliations", "auto.photos",
  "stats.public_counts", "stats.public_search_terms", "stats.public_trust", "stats.share_partner",
  "comms.unsubscribe", "comms.news", "comms.beta", "comms.featured",
  "connect.own_ai",
];

// S2e (side v2) adds visibility.profile (the /eier pause card), orders.email
// (the confirmed order address) and comms.news (the first-login consent).
const S2A_LIVE = ["orders.enabled", "orders.reminder", "auto.guarantee", "notify.order_email", "comms.unsubscribe",
  "visibility.profile", "orders.email", "comms.news"];

function seedProducer(db: Database.Database, id: string, o: { claimed: boolean; isVerified: boolean }): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for Mine valg.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, ?, 0)`,
  ).run(
    id, `Valgprove Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
    o.isVerified ? 1 : 0, o.claimed ? "2026-10-01T00:00:00.000Z" : null,
  );
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
}

export async function runOwnerFeaturesS2aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertThrows(fn: () => unknown, check: (e: any) => boolean, label: string): void {
    try {
      fn();
      assertTrue(false, `${label} (did not throw)`);
    } catch (e) {
      assertTrue(check(e), label);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevAllow = process.env[ALLOW_ENV];
  const prevKill = process.env[KILL_ENV];
  const setAllow = (v: string | null) => { if (v === null) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
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
    delete process.env[KILL_ENV];
    for (const m of ["./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const { isEligibleForRealOrder } = require("../services/cart-service") as typeof import("../services/cart-service");

    // ── Registry ───────────────────────────────────────────────────────────
    {
      const keys = reg.OWNER_FEATURE_REGISTRY.map((e) => e.key);
      assertEq(keys.length, 49, "registry: 49 entries");
      assertEq(keys, VEDLEGG_A_KEYS, "registry: exactly the Vedlegg A keys, in appendix order");
      assertEq([...reg.OWNER_FEATURE_KEYS], VEDLEGG_A_KEYS, "registry: OWNER_FEATURE_KEYS matches Vedlegg A");
      assertEq(new Set(keys).size, 49, "registry: keys unique");
      const groupKeys = reg.OWNER_FEATURE_GROUPS.map((g) => g.key);
      const counts: Record<string, number> = {};
      for (const e of reg.OWNER_FEATURE_REGISTRY) counts[e.group] = (counts[e.group] || 0) + 1;
      assertEq(counts, { visibility: 6, contact: 3, products: 4, orders: 14, payments: 2, notify: 5, auto: 6, stats: 4, comms: 4, connect: 1 },
        "registry: group sizes match Vedlegg A");
      assertTrue(reg.OWNER_FEATURE_GROUPS.every((g) => !!g.label.no && !!g.label.en), "registry: every group has NO+EN label");
      const types = ["switch", "choice", "number", "date", "email", "action", "guarantee", "locked"];
      const surfaceOk = (s: string) =>
        /^(profile_html|json_ld|listing_html|mcp_search|mcp_info|rest_card|vcard|acp_feed|sitemap|llms|a2a|leaderboard|order_gate)$/.test(s) || /^(email|job):[a-z_]+$/.test(s);
      for (const e of reg.OWNER_FEATURE_REGISTRY) {
        const ok =
          !!e.label?.no && !!e.label?.en && !!e.description?.no && !!e.description?.en &&
          e.key.startsWith(`${e.group}.`) && groupKeys.includes(e.group) &&
          types.includes(e.type) &&
          e.default && "owner" in e.default && "unclaimed" in e.default &&
          e.default.owner !== undefined && e.default.unclaimed !== undefined &&
          ["live", "beta", "coming_soon"].includes(e.status) &&
          // S2e: a live consent record whose sending is not built (comms.news)
          // declares no surface — nothing to observe; every other entry has one.
          Array.isArray(e.surfaces) && (e.surfaces.length > 0 || (e.consent && e.status === "live")) && e.surfaces.every(surfaceOk) &&
          e.verticals.includes("rfb") && /^\d{4}-\d{2}-\d{2}$/.test(e.since) && /^\d{4}-\d{2}-\d{2}-/.test(e.devRequest) &&
          typeof e.consent === "boolean" && typeof e.outward === "boolean" && typeof e.advanced === "boolean";
        assertTrue(ok, `registry: ${e.key} has NO+EN texts, group, type, default per segment, status, surfaces`);
        if (e.type === "choice") {
          const opts = (e.options || []).map((o) => o.value);
          assertTrue(opts.length >= 2 && (e.options || []).every((o) => !!o.label.no && !!o.label.en)
            && [e.default.owner, e.default.unclaimed].every((d) => d === null || opts.includes(d as string)),
          `registry: ${e.key} choice options + defaults within options`);
        }
        for (const r of e.requires) {
          assertTrue(["verifiedOwner", "isVerifiedBadge", "stripeActive", "drinkProducer"].includes(r) || keys.includes(r),
            `registry: ${e.key} requires known ${r}`);
        }
        if (e.lockedWhen) assertTrue(keys.includes(e.lockedWhen), `registry: ${e.key} lockedWhen is a key`);
        if (e.lockOnUnless) assertTrue(keys.includes(e.lockOnUnless), `registry: ${e.key} lockOnUnless is a key`);
        if (e.consent) assertEq([e.default.owner, e.default.unclaimed].filter((d) => d === true).length, 0, `registry: consent entry ${e.key} defaults off`);
      }
      assertEq(reg.OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live").map((e) => e.key).sort(), [...S2A_LIVE].sort(),
        "registry: live set is exactly the S2a five + S2e visibility.profile, orders.email, comms.news");
      const g = (k: string) => reg.getOwnerFeature(k);
      assertEq(g("orders.enabled").storage?.column, "agents.order_notifications_opt_in", "registry: orders.enabled adapter column");
      assertEq([g("orders.enabled").type, g("orders.enabled").default], ["switch", { owner: false, unclaimed: false }], "registry: orders.enabled switch, off for both segments");
      assertEq([g("orders.reminder").type, g("orders.reminder").lockedWhen], ["locked", "orders.enabled"], "registry: orders.reminder locked on with orders.enabled");
      assertEq([g("notify.order_email").type, g("notify.order_email").lockedWhen], ["locked", "orders.enabled"], "registry: notify.order_email locked on with orders.enabled");
      assertEq([g("auto.guarantee").type, g("comms.unsubscribe").type], ["guarantee", "guarantee"], "registry: guarantees");
      assertEq([g("orders.email").status, g("orders.email").type, g("orders.email").confirmByEmail, g("orders.email").storage?.column],
        ["live", "email", true, "agents.order_notification_email"], "registry: orders.email live (S2e), changed only by e-mail confirmation, reads the order address column");
      assertEq(g("payments.pay_at_pickup").lockOnUnless, "payments.prepay", "registry: pay_at_pickup locked on unless prepay");
    }

    // ── Unknown key / featureOn typing ─────────────────────────────────────
    seedProducer(db, OWNED_ID, { claimed: true, isVerified: true });
    seedProducer(db, TWIN_ID, { claimed: true, isVerified: true });
    seedProducer(db, UNBADGED_ID, { claimed: true, isVerified: false });
    seedProducer(db, EMAILMATCH_ID, { claimed: false, isVerified: false });
    seedProducer(db, OTHER_ID, { claimed: true, isVerified: true });

    assertThrows(() => rs.featureOn("rfb", OWNED_ID, "orders.nope" as any), (e) => e instanceof reg.UnknownOwnerFeatureError,
      "featureOn: unknown key throws UnknownOwnerFeatureError");
    assertThrows(() => rs.resolveOwnerFeature("rfb", OWNED_ID, "nope" as any), (e) => e instanceof reg.UnknownOwnerFeatureError,
      "resolveOwnerFeature: unknown key throws");
    assertThrows(() => rs.featureOn("rfb", OWNED_ID, "notify.report"), (e) => e instanceof TypeError,
      "featureOn: non-boolean entry throws TypeError (use featureValue)");
    assertEq(rs.featureValue("rfb", OWNED_ID, "notify.report"), "monthly", "featureValue: choice default for owner segment");
    assertEq(rs.featureOn("rfb", OWNED_ID, "orders.enabled"), false, "featureOn: orders.enabled default off");
    assertEq(rs.featureOn("rfb", OWNED_ID, "auto.guarantee"), true, "featureOn: guarantee on");
    assertEq(rs.rfbFeatureOn(OWNED_ID, "comms.unsubscribe"), true, "rfbFeatureOn wrapper");
    assertEq(rs.resolveOwnerFeature("rfb", EMAILMATCH_ID, "auto.updates").value, "automatic", "segment: unclaimed profile gets the unclaimed default");
    assertEq(rs.resolveOwnerFeature("rfb", OWNED_ID, "auto.updates").value, "suggest", "segment: verified owner gets the owner default");

    // ── Resolution order (fixture registry) ────────────────────────────────
    {
      const fx = (over: Partial<import("../owner-features/registry").OwnerFeatureEntry> & { key: string }): import("../owner-features/registry").OwnerFeatureEntry => ({
        group: "visibility", type: "switch",
        label: { no: `Fiks ${over.key}`, en: `Fixture ${over.key}` }, description: { no: "Testoppføring.", en: "Test entry." },
        default: { owner: true, unclaimed: true }, requires: [], status: "live", consent: false, outward: false,
        advanced: false, verticals: ["rfb"], since: "2026-10-27", devRequest: "2026-10-22-rfb-mine-valg-eierbrytere",
        surfaces: ["profile_html"], ...over,
      });
      const mkReg = (baseDefault: boolean) => [
        fx({ key: "fx.base", default: { owner: baseDefault, unclaimed: true } }),
        fx({ key: "fx.kill", killSwitch: KILL_ENV }),
        fx({ key: "fx.dep", requires: ["fx.base" as any] }),
        fx({ key: "fx.locked", type: "locked", default: { owner: false, unclaimed: false }, lockedWhen: "fx.base" as any }),
        fx({ key: "fx.na", default: { owner: true, unclaimed: null } }),
        fx({ key: "fx.soon", status: "coming_soon" }),
      ];
      const R1 = mkReg(true);
      const o = (registry: any, env: NodeJS.ProcessEnv = {}) => ({ registry, env, db });
      const r = (key: string, registry: any = R1, env: NodeJS.ProcessEnv = {}) => rs.resolveOwnerFeature("rfb", OWNED_ID, key as any, o(registry, env));
      const set = (key: string, value: unknown, registry: any = R1, env: NodeJS.ProcessEnv = {}) =>
        rs.setOwnerFeatureValue("rfb", OWNED_ID, key, value, { actor: "owner", detail: "test" }, o(registry, env));
      const audits = () => (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ? AND key LIKE 'fx.%'").get(OWNED_ID) as { n: number }).n;

      assertEq([r("fx.base").value, r("fx.base").source, r("fx.base").changeable], [true, "default", true], "resolve: no row → segment default");
      assertEq(r("fx.locked").value, true, "resolve: locked entry on while its key is on");
      assertEq([r("fx.locked").source, r("fx.locked").reason?.no], ["locked", "Låst på så lenge «Fiks fx.base» er på."], "resolve: locked source + Norwegian reason");
      assertEq([rs.resolveOwnerFeature("rfb", EMAILMATCH_ID, "fx.na" as any, o(R1)).value, rs.resolveOwnerFeature("rfb", EMAILMATCH_ID, "fx.na" as any, o(R1)).source],
        [null, "locked"], "resolve: unclaimed default null → «Gjelder ikke» (locked)");
      assertEq([r("fx.soon").source, r("fx.soon").changeable, r("fx.soon").reason?.no], ["default", false, "Kommer snart."], "resolve: coming_soon keeps default, not changeable");

      const a0 = audits();
      const w1 = set("fx.base", false);
      assertEq([w1.kind, (w1 as any).changed], ["ok", true], "set: owner value written");
      assertEq(audits() - a0, 1, "set: exactly one audit row");
      assertEq([r("fx.base").value, r("fx.base").source], [false, "owner"], "resolve: owner value beats default");
      const w2 = set("fx.base", false);
      assertEq([w2.kind, (w2 as any).changed, audits() - a0], ["ok", false, 1], "set: no-op writes no audit row");
      assertEq([r("fx.dep").value, r("fx.dep").source, r("fx.dep").changeable], [false, "locked", false], "resolve: unmet key requirement → off, locked");
      assertEq(r("fx.dep").reason, { no: "Krever at «Fiks fx.base» er på.", en: "Requires “Fixture fx.base” to be on." }, "resolve: requirement reason NO+EN");
      const w3 = set("fx.dep", true);
      assertEq([w3.kind, (w3 as any).block, (w3 as any).reason?.no], ["blocked", "requirement_not_met", "Krever at «Fiks fx.base» er på."], "set: turning on with unmet requirement → blocked");
      assertEq([r("fx.locked").value, r("fx.locked").reason?.no], [false, "Gjelder bare når «Fiks fx.base» er på."], "resolve: locked entry off while its key is off");
      assertEq(set("fx.locked", true).kind, "blocked", "set: locked entry not settable");
      assertEq((set("fx.soon", false) as any).block, "coming_soon", "set: coming_soon blocked");
      assertEq(set("fx.base", "nei").kind, "invalid_value", "set: invalid value rejected");
      assertEq(set("fx.missing", true).kind, "unknown_key", "set: unknown key");

      // AC9: a changed registry default never changes a stored explicit value.
      const stored = () => (db.prepare("SELECT value_json, set_by, set_at FROM owner_feature_settings WHERE subject_id = ? AND key = 'fx.base'").get(OWNED_ID) as any);
      const storedBefore = stored();
      const R2 = mkReg(false);
      assertEq([r("fx.base", R2).value, r("fx.base", R2).source], [false, "owner"], "AC9: default flipped to false → stored false still owner");
      set("fx.base", true, R1); // owner turns it back on explicitly
      const R3 = mkReg(false);
      assertEq([r("fx.base", R3).value, r("fx.base", R3).source], [true, "owner"], "AC9: default false, stored explicit true stays true");
      assertEq(stored().value_json, "true", "AC9: stored row holds the explicit value");
      assertEq([storedBefore.value_json, storedBefore.set_by], ["false", "owner"], "AC9: row written with set_by owner");
      assertTrue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(storedBefore.set_at), "settings: set_at is ISO-8601");

      // Kill switch beats everything, admin lock beats the owner.
      db.prepare("INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', ?, 'fx.kill', 'true', 'owner', 0, ?)").run(OWNED_ID, new Date().toISOString());
      assertEq(r("fx.kill").source, "owner", "resolve: stored owner value (kill switch off)");
      assertEq([r("fx.kill", R1, { [KILL_ENV]: "1" }).value, r("fx.kill", R1, { [KILL_ENV]: "1" }).source], [false, "killswitch"], "resolve: kill switch on → off, source killswitch");
      assertEq(r("fx.kill", R1, { [KILL_ENV]: "1" }).reason?.no, "Denne funksjonen er midlertidig slått av for alle.", "resolve: kill switch Norwegian reason");
      assertEq((set("fx.kill", false, R1, { [KILL_ENV]: "true" }) as any).block, "killswitch", "set: blocked by kill switch");
      db.prepare("UPDATE owner_feature_settings SET set_by = 'admin', admin_locked = 1, value_json = 'false' WHERE subject_id = ? AND key = 'fx.kill'").run(OWNED_ID);
      assertEq([r("fx.kill").value, r("fx.kill").source, r("fx.kill").changeable], [false, "admin", false], "resolve: admin lock beats owner");
      assertEq(r("fx.kill", R1, { [KILL_ENV]: "1" }).source, "killswitch", "resolve: kill switch beats admin lock");
      assertEq((set("fx.kill", true) as any).block, "admin_locked", "set: admin-locked key blocked");
      assertThrows(() => db.prepare("INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, set_at) VALUES ('rfb', ?, 'fx.x', 'true', 'bogus', ?)").run(OWNED_ID, "x"),
        () => true, "schema: set_by CHECK rejects unknown actor");
      db.prepare("DELETE FROM owner_feature_settings WHERE key LIKE 'fx.%'").run();
      db.prepare("DELETE FROM owner_feature_audit WHERE key LIKE 'fx.%'").run();
    }

    // ── API ────────────────────────────────────────────────────────────────
    const H = {
      get: findRouteHandler(featuresMod.default, "/api/owner/:id/features", "get"),
      put: findRouteHandler(featuresMod.default, "/api/owner/:id/features/:key", "put"),
      optIn: findRouteHandler(portalMod.default, "/api/agents/:id/order-notifications", "post"),
    };
    const tokens: Record<string, string> = {};
    for (const id of [OWNED_ID, TWIN_ID, UNBADGED_ID, EMAILMATCH_ID, OTHER_ID]) {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    const get = (id: string, token: string | undefined = tokens[id]) => invoke(H.get, makeReq({ params: { id }, token }));
    const put = (id: string, key: string, body: any, token: string | undefined = tokens[id], headers: Record<string, string> = {}) =>
      invoke(H.put, makeReq({ params: { id, key }, body, token, headers }));
    const optInCol = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as { v: number }).v;
    const auditRows = (id: string) => db.prepare("SELECT key, old_json, new_json, actor, actor_detail, at FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const settingsRows = (id: string) => db.prepare("SELECT key FROM owner_feature_settings WHERE subject_id = ?").all(id) as any[];

    // Allowlist (AC20): unset/empty → 404 for everyone, nothing written.
    setAllow(null);
    featuresMod.__resetOwnerFeaturesRateLimitForTesting();
    assertEq((await get(OWNED_ID)).status, 404, "allowlist: env unset → GET 404");
    assertEq((await put(OWNED_ID, "orders.enabled", { value: true })).status, 404, "allowlist: env unset → PUT 404");
    setAllow("");
    assertEq((await get(OWNED_ID)).status, 404, "allowlist: env empty → GET 404");
    setAllow(`rfb:${OTHER_ID}`);
    assertEq((await get(OWNED_ID)).status, 404, "allowlist: subject not listed → GET 404 (even for its verified owner)");
    assertEq((await put(OWNED_ID, "orders.enabled", { value: true })).status, 404, "allowlist: subject not listed → PUT 404");
    setAllow(OWNED_ID);
    assertEq((await get(OWNED_ID)).status, 404, "allowlist: bare id without vertical prefix does not match");
    assertEq([optInCol(OWNED_ID), auditRows(OWNED_ID).length], [0, 0], "allowlist: nothing written while not listed");
    setAllow(` rfb:${OWNED_ID} , rfb:${TWIN_ID},rfb:${UNBADGED_ID},rfb:${EMAILMATCH_ID} `);

    // Session / ownership gate.
    assertEq((await get(OWNED_ID, "")).status, 401, "gate: no session → 401");
    assertEq((await put(OWNED_ID, "orders.enabled", { value: true }, "")).status, 401, "gate: PUT without session → 401");
    const em = await get(EMAILMATCH_ID);
    assertEq([em.status, em.body?.error], [403, "ownership_not_verified"], "gate: e-mail-match session without verified ownership → 403");
    assertEq((await put(EMAILMATCH_ID, "orders.enabled", { value: true })).status, 403, "gate: PUT by e-mail-match session → 403");
    assertEq((await get(OWNED_ID, tokens[OTHER_ID])).status, 403, "gate: another agent's session → 403");
    assertEq((await put(OWNED_ID, "orders.enabled", { value: true }, tokens[OTHER_ID])).status, 403, "gate: PUT with another agent's session → 403");

    // GET shape.
    const g1 = await get(OWNED_ID);
    assertEq([g1.status, g1.body?.success, g1.body?.segment, g1.headers["cache-control"]], [200, true, "owner", "no-store"], "GET: 200 for allowlisted verified owner");
    const feats = (g1.body?.features || []) as any[];
    assertEq(feats.map((f) => f.key), VEDLEGG_A_KEYS, "GET: all 49 entries in registry order");
    assertEq((g1.body?.groups || []).length, 10, "GET: 10 groups with labels");
    const fields = ["key", "group", "type", "label", "description", "status", "advanced", "value", "default", "source", "changeable", "reason"];
    assertTrue(feats.every((f) => fields.every((k) => k in f) && !!f.label.no && !!f.label.en), "GET: every entry carries value, source, reason, texts, status, group, advanced");
    assertTrue(feats.every((f) => f.changeable || (f.reason && f.reason.no && f.reason.en)), "GET: every non-changeable entry has a NO+EN reason");
    const byKey = (body: any) => Object.fromEntries(((body?.features || []) as any[]).map((f) => [f.key, f]));
    let fk = byKey(g1.body);
    assertEq([fk["orders.enabled"].value, fk["orders.enabled"].source, fk["orders.enabled"].changeable], [false, "default", true], "GET: orders.enabled off by default, changeable");
    assertEq([fk["orders.reminder"].value, fk["orders.reminder"].source], [false, "locked"], "GET: orders.reminder off while orders off");
    assertEq([fk["auto.guarantee"].value, fk["auto.guarantee"].source, fk["auto.guarantee"].reason.no],
      [true, "locked", "Dette er et løfte fra Rett fra Bonden og kan ikke slås av."], "GET: guarantee on, locked, Norwegian reason");
    assertEq([fk["visibility.leaderboard"].status, fk["visibility.leaderboard"].value, fk["visibility.leaderboard"].changeable], ["coming_soon", true, false], "GET: coming_soon entry shows its default, not changeable");
    assertEq(fk["orders.daily_cap"].advanced, true, "GET: advanced flag");

    // 409s with Norwegian reason; nothing written.
    const c1 = await put(OWNED_ID, "visibility.leaderboard", { value: false });
    assertEq([c1.status, c1.body?.error, c1.body?.reason, c1.body?.reason_en], [409, "coming_soon", "Kommer snart.", "Coming soon."], "PUT: coming_soon → 409");
    const c2 = await put(OWNED_ID, "auto.guarantee", { value: false });
    assertEq([c2.status, c2.body?.error], [409, "guarantee"], "PUT: guarantee → 409");
    assertEq((await put(OWNED_ID, "comms.unsubscribe", { value: false })).status, 409, "PUT: comms.unsubscribe guarantee → 409");
    const c3 = await put(OWNED_ID, "orders.reminder", { value: false });
    assertEq([c3.status, c3.body?.error, c3.body?.reason], [409, "locked", "Gjelder bare når «Ta imot bestillinger» er på."], "PUT: locked → 409 with reason");
    const c4 = await put(UNBADGED_ID, "orders.enabled", { value: true });
    assertEq([c4.status, c4.body?.error], [409, "requirement_not_met"], "PUT: orders.enabled on without is_verified → 409");
    assertTrue(/^Krever /.test(String(c4.body?.reason)) && !!c4.body?.reason_en, "PUT: requirement 409 has Norwegian reason + reason_en");
    assertEq([optInCol(UNBADGED_ID), auditRows(UNBADGED_ID).length], [0, 0], "PUT: 409 writes nothing");

    // 400 / 404.
    const b1 = await put(OWNED_ID, "orders.enabled", { value: "yes" });
    assertEq([b1.status, b1.body?.error], [400, "invalid_value"], "PUT: invalid value for switch → 400");
    assertEq((await put(OWNED_ID, "orders.enabled", {})).status, 400, "PUT: missing value → 400");
    assertEq((await put(OWNED_ID, "orders.enabled", { value: 1 })).status, 400, "PUT: number for switch → 400");
    const n1 = await put(OWNED_ID, "orders.nope", { value: true });
    assertEq([n1.status, n1.body?.error], [404, "unknown_key"], "PUT: unknown key → 404");
    assertEq((await put(OWNED_ID, "orders.enabled", { value: true }, tokens[OWNED_ID], { origin: "https://evil.example" })).status, 403, "PUT: cross-site Origin → 403");
    assertEq([optInCol(OWNED_ID), auditRows(OWNED_ID).length], [0, 0], "PUT: rejected calls wrote nothing");

    // AC11 — orders.enabled via PUT writes the column; eligibility unchanged.
    const eligBefore = [isEligibleForRealOrder(OWNED_ID), isEligibleForRealOrder(TWIN_ID)];
    assertEq(eligBefore, [false, false], "AC11: both twins ineligible while opt-in is 0");
    const p1 = await put(OWNED_ID, "orders.enabled", { value: true });
    assertEq([p1.status, p1.body?.changed, p1.body?.feature?.value, p1.body?.feature?.source], [200, true, true, "owner"], "PUT: orders.enabled on → 200 with new state");
    assertEq(optInCol(OWNED_ID), 1, "AC11: PUT wrote agents.order_notifications_opt_in = 1");
    const twin = await invoke(H.optIn, makeReq({ params: { id: TWIN_ID }, body: { opt_in: true }, token: tokens[TWIN_ID] }));
    assertEq(twin.status, 200, "AC11: twin switched on via the existing Bestillinger route");
    assertEq(isEligibleForRealOrder(OWNED_ID), isEligibleForRealOrder(TWIN_ID), "AC11: isEligibleForRealOrder same answer as the existing path (on)");
    assertEq(isEligibleForRealOrder(OWNED_ID), true, "AC11: eligible after opt-in (same gate as before)");
    let rows = auditRows(OWNED_ID);
    assertEq(rows.map((r) => [r.key, r.old_json, r.new_json, r.actor, r.actor_detail]),
      [["orders.enabled", "false", "true", "owner", `post@${OWNED_ID}.example.no`]], "PUT: exactly one audit row (adapter write)");
    assertTrue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rows[0]?.at || ""), "audit: at is ISO-8601");
    assertEq(settingsRows(OWNED_ID).length, 0, "adapter: no owner_feature_settings row (column is the source of truth)");
    fk = byKey((await get(OWNED_ID)).body);
    assertEq([fk["orders.reminder"].value, fk["notify.order_email"].value, fk["notify.order_email"].source], [true, true, "locked"], "GET: reminder + order e-mail locked on with orders.enabled");
    assertEq(rs.featureOn("rfb", OWNED_ID, "orders.enabled"), true, "featureOn reads the adapter column");

    const p2 = await put(OWNED_ID, "orders.enabled", { value: true });
    assertEq([p2.status, p2.body?.changed, auditRows(OWNED_ID).length], [200, false, 1], "PUT: no-op → 200 changed:false, no audit row");
    const p3 = await put(OWNED_ID, "orders.enabled", { value: false });
    assertEq([p3.status, p3.body?.changed, optInCol(OWNED_ID), auditRows(OWNED_ID).length], [200, true, 0, 2], "PUT: off → column 0, one more audit row");
    await invoke(H.optIn, makeReq({ params: { id: TWIN_ID }, body: { opt_in: false }, token: tokens[TWIN_ID] }));
    assertEq([isEligibleForRealOrder(OWNED_ID), isEligibleForRealOrder(TWIN_ID)], [false, false], "AC11: same answer as the existing path (off)");

    // Admin lock on an adapter key.
    db.prepare("INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', ?, 'orders.enabled', 'false', 'admin', 1, ?)").run(OWNED_ID, new Date().toISOString());
    const al = await put(OWNED_ID, "orders.enabled", { value: true });
    assertEq([al.status, al.body?.error, optInCol(OWNED_ID)], [409, "admin_locked", 0], "PUT: admin lock → 409, column untouched");
    assertTrue(/^Låst av Rett fra Bonden/.test(String(al.body?.reason)), "PUT: admin lock Norwegian reason");
    db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(OWNED_ID);

    // Rate limit per session.
    featuresMod.__resetOwnerFeaturesRateLimitForTesting();
    let lastOk = 0;
    for (let i = 0; i < featuresMod.OWNER_FEATURES_WRITES_PER_MINUTE; i++) {
      if ((await put(OWNED_ID, "orders.enabled", { value: false })).status === 200) lastOk++;
    }
    assertEq(lastOk, featuresMod.OWNER_FEATURES_WRITES_PER_MINUTE, "rate limit: 30 writes per minute allowed");
    const rl = await put(OWNED_ID, "orders.enabled", { value: false });
    assertEq([rl.status, rl.body?.error], [429, "rate_limited"], "rate limit: 31st write in the minute → 429");
    assertEq((await put(TWIN_ID, "orders.enabled", { value: false })).status, 200, "rate limit: per session (another session unaffected)");
    assertEq((await get(OWNED_ID)).status, 200, "rate limit: reads are not limited");
    featuresMod.__resetOwnerFeaturesRateLimitForTesting();

    // Schema.
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_owner_feature_audit_subject'").get();
    assertTrue(!!idx, "schema: audit index on (vertical, subject_id, at)");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    if (prevAllow === undefined) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = prevAllow;
    if (prevKill === undefined) delete process.env[KILL_ENV]; else process.env[KILL_ENV] = prevKill;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS2aTests({ log: true }).then((r) => {
    console.info(`\nowner-features-s2a: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

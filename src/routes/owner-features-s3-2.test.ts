/**
 * owner-features-s3-2.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S3-2: the owner hides single affiliations in «Mine valg»
 * (agent_affiliations.owner_hidden_at), honoured on the producer page's
 * affiliations card and its JSON-LD memberOf.
 *
 *   hide      gate on + key live (registry override): «Skjul» on umbrella A →
 *             A gone from the card and memberOf, B stays (AC1).
 *   show      «Vis igjen» brings A back (AC2).
 *   refuse    another producer's row, an unknown umbrella, a row outside the
 *             shown selection (inactive umbrella, organic claim) → 404, no
 *             write; no session / cross-site → as the other /valg/* POSTs (AC3).
 *   gate      enforce off, not allowlisted, the real registry (coming_soon) →
 *             no list, POST 404 with no write, producer page unchanged and
 *             no owner_hidden_at in its SQL (AC4).
 *   log       exactly one «Endringslogg» row per real change, none on a
 *             repeat; no timestamp change on a repeat (AC5).
 *   migrate   the schema init runs twice; the column exists (AC6).
 *   switch    auto.affiliations off (S3-1) still hides everything; a lookup
 *             that throws → no affiliations (fail closed).
 *
 * Real seo + owner-features routers on the production schema in an
 * in-memory DB; handlers pulled off the router stack (same harness as
 * owner-features-s3-1 / -s2b). Exported runOwnerFeaturesS32Tests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-features-s3-2.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ENFORCE_ENV = "OWNER_FEATURES_ENFORCE";
const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
const ENF_ID = "s32-owned";
const TWIN_ID = "s32-twin";
const UMB_A = "s32-umb-a";
const UMB_B = "s32-umb-b";
const UMB_TWIN = "s32-umb-twin";
const UMB_OFF = "s32-umb-inactive";
const UMB_ORG = "s32-umb-organic";
const NAMES: Record<string, string> = {
  [ENF_ID]: "Skjuleprove Gard Eier",
  [TWIN_ID]: "Skjuleprove Gard Tvilling",
  [UMB_A]: "Bondens marked Skjuleby",
  [UMB_B]: "Andelslaget Skjuledal",
  [UMB_TWIN]: "REKO-ringen Tvillingby",
  [UMB_OFF]: "Nedlagt marked Skjuleby",
  [UMB_ORG]: "Debio Skjuleprove",
};
const KEY = "auto.affiliations";
const FIELD = "affiliations.hidden";

function seedAgent(db: Database.Database, id: string, umbrellaType: string | null, active = 1): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at, umbrella_type, is_vetted)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, ?, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?, 1)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, active, umbrellaType,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, about, products, verification_status, enrichment_status, last_verified_at)
     VALUES (?, ?, ?, ?, '[]', 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.");
}

export async function runOwnerFeaturesS32Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevAllow = process.env[ALLOW_ENV];
  const prevEnforce = process.env[ENFORCE_ENV];
  const prevGate = process.env[GATE_ENV];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<{ status: number; body: any }> {
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
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; }, cookie() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  const enforce = require("../owner-features/enforce") as typeof import("../owner-features/enforce");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();
    setEnv(ALLOW_ENV, null);
    setEnv(ENFORCE_ENV, null);
    setEnv(GATE_ENV, null);

    for (const m of ["./seo", "./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const seoRouter = (require("./seo") as typeof import("./seo")).default as any;
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const auditLog = require("./owner-audit-log") as typeof import("./owner-audit-log");
    const produsent = findRouteHandler(seoRouter, "/produsent/:slug", "get");
    const H = {
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      hide: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/tilknytning", "post"),
    };

    // ── AC6: the migration ────────────────────────────────────────────────
    {
      const cols = () => (db.prepare("PRAGMA table_info(agent_affiliations)").all() as Array<{ name: string }>).map((c) => c.name);
      assertTrue(cols().includes("owner_hidden_at"), "migrate-1: agent_affiliations.owner_hidden_at exists after init");
      let threw = "";
      try { initMod.__initSchemaForTesting(db as any); } catch (e) { threw = String(e); }
      assertEq(threw, "", "migrate-2: schema init runs a second time without error");
      assertEq(cols().filter((c) => c === "owner_hidden_at").length, 1, "migrate-3: still exactly one owner_hidden_at column");
    }

    seedAgent(db, ENF_ID, null);
    seedAgent(db, TWIN_ID, null);
    seedAgent(db, UMB_A, "market_network");
    seedAgent(db, UMB_B, "market_network");
    seedAgent(db, UMB_TWIN, "market_network");
    seedAgent(db, UMB_OFF, "market_network", 0);
    seedAgent(db, UMB_ORG, "certification");
    const aff = db.prepare("INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES (?, ?, 'active', 'admin')");
    aff.run(ENF_ID, UMB_A);
    aff.run(ENF_ID, UMB_B);
    aff.run(ENF_ID, UMB_OFF);
    aff.run(ENF_ID, UMB_ORG);
    aff.run(TWIN_ID, UMB_A);
    aff.run(TWIN_ID, UMB_TWIN);

    const tokens: Record<string, string> = {};
    for (const id of [ENF_ID, TWIN_ID]) {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }

    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const producerPage = async (id: string) => {
      clearRegistryCaches();
      return String((await invoke(produsent, makeReq({ params: { slug: slugify(NAMES[id]) } }))).body ?? "");
    };
    /** The affiliations card's markup and the memberOf JSON (the rest of the page is not stable between renders). */
    const fingerprint = async (id: string) => {
      const html = await producerPage(id);
      const visible = html.replace(LD_RE, "");
      const at = visible.indexOf('class="aff-grid"');
      const card = at < 0 ? "" : visible.slice(at, visible.indexOf("</div></div>", at));
      const memberOf: string[] = [];
      for (const m of html.matchAll(LD_RE)) {
        try {
          const walk = (x: any) => {
            if (Array.isArray(x)) x.forEach(walk);
            else if (x && typeof x === "object") { if (x.memberOf) memberOf.push(JSON.stringify(x.memberOf)); Object.values(x).forEach(walk); }
          };
          walk(JSON.parse(m[1]));
        } catch { /* not JSON */ }
      }
      return { card, memberOf: memberOf.join("\n") };
    };
    /** [umbrella in the card, umbrella in memberOf]. */
    const shows = async (id: string, umb: string): Promise<[boolean, boolean]> => {
      const f = await fingerprint(id);
      return [f.card.includes(NAMES[umb]), f.memberOf.includes(NAMES[umb])];
    };
    const valgPage = async (id: string, token: string | undefined = tokens[id]) => String((await invoke(H.page, makeReq({ params: { agentId: id }, token }))).body ?? "");
    const post = (id: string, body: any, token: string | undefined = tokens[id], headers: Record<string, string> = {}) =>
      invoke(H.hide, makeReq({ params: { agentId: id }, body, token, headers }));
    const hiddenAt = (producer: string, umb: string) =>
      ((db.prepare("SELECT owner_hidden_at AS v FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?").get(producer, umb) as any)?.v ?? null) as string | null;
    const logRows = (id: string) => db.prepare("SELECT old_value, new_value, changed_by FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = ? ORDER BY rowid").all(id, FIELD) as any[];
    const allHidden = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_affiliations WHERE owner_hidden_at IS NOT NULL").get() as any).n as number;
    const allLog = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE field_name = ?").get(FIELD) as any).n as number;
    const resetCap = () => featuresMod.__resetOwnerFeaturesRateLimitForTesting();
    const loc = (r: { body: any }) => String(r.body?.__redirect ?? "");
    /** Every SQL text the producer page prepares while rendering. */
    const pageSql = async (id: string): Promise<string[]> => {
      const seen: string[] = [];
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { seen.push(sql); return realPrepare(sql); };
      try { await producerPage(id); } finally { (db as any).prepare = realPrepare; }
      return seen;
    };

    const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === KEY ? { ...e, status: "live" as const } : e));

    // ── Baseline ──────────────────────────────────────────────────────────
    const baseline = await fingerprint(ENF_ID);
    assertEq(await shows(ENF_ID, UMB_A), [true, true], "base-1: umbrella A in the card and memberOf");
    assertEq(await shows(ENF_ID, UMB_B), [true, true], "base-2: umbrella B in the card and memberOf");
    assertEq([baseline.card.includes(NAMES[UMB_OFF]), baseline.card.includes(NAMES[UMB_ORG])], [false, false],
      "base-3: inactive and organic-claim umbrellas are not shown (the selection)");

    // ── AC4: gate shut → no list, POST 404 without a write, page unchanged ──
    enforce.__setEnforceRegistryForTesting(LIVE);
    db.prepare("UPDATE agent_affiliations SET owner_hidden_at = '2026-11-01T00:00:00.000Z' WHERE producer_id = ? AND umbrella_id = ?").run(ENF_ID, UMB_A);
    const gateCases: Array<[string, string | null, string | null, boolean]> = [
      ["enforce unset", null, `rfb:${ENF_ID}`, true],
      ["enforce \"0\"", "0", `rfb:${ENF_ID}`, true],
      ["another subject allowlisted", "1", `rfb:${TWIN_ID}`, true],
      ["real registry (coming_soon)", "1", `rfb:${ENF_ID}`, false],
    ];
    for (const [name, enf, allow, live] of gateCases) {
      setEnv(ENFORCE_ENV, enf);
      setEnv(ALLOW_ENV, allow);
      enforce.__setEnforceRegistryForTesting(live ? LIVE : null);
      assertEq(await fingerprint(ENF_ID), baseline, `gate-${name}: producer page card and memberOf as before (stored hide ignored)`);
      assertTrue(!(await pageSql(ENF_ID)).some((q) => q.includes("owner_hidden_at")), `gate-${name}: no owner_hidden_at in the page's SQL`);
      assertEq(enforce.affiliationsPerItemEnabled(ENF_ID), false, `gate-${name}: per-item disabled`);
    }
    {
      // The page and POST need the allowlist (pageGate); with it set, enforce off and the real registry.
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      for (const [name, enf, live] of [["enforce off", null, true], ["real registry", "1", false]] as Array<[string, string | null, boolean]>) {
        setEnv(ENFORCE_ENV, enf);
        enforce.__setEnforceRegistryForTesting(live ? LIVE : null);
        resetCap();
        const html = await valgPage(ENF_ID);
        assertTrue(html.includes("Mine valg") && !html.includes("data-affiliations") && !html.includes("/valg/tilknytning"), `gate-${name}: «Mine valg» shows no affiliation list`);
        const before = [allHidden(), allLog(), hiddenAt(ENF_ID, UMB_B)];
        const r = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "1" });
        assertEq([r.status, allHidden(), allLog(), hiddenAt(ENF_ID, UMB_B)], [404, ...before], `gate-${name}: POST → 404, nothing written`);
      }
      // No query at all for the mode outside the gate.
      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        enforce.__setEnforceRegistryForTesting(LIVE);
        setEnv(ENFORCE_ENV, null);
        setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
        assertEq(enforce.affiliationsPageMode(ENF_ID), "as_before", "gate-mode-1: enforce off → as before");
        setEnv(ENFORCE_ENV, "1");
        setEnv(ALLOW_ENV, `rfb:${TWIN_ID}`);
        assertEq(enforce.affiliationsPageMode(ENF_ID), "as_before", "gate-mode-2: not allowlisted → as before");
        assertEq(queries, 0, "gate-mode-3: no DB query outside the gate");
      } finally {
        (db as any).prepare = realPrepare;
      }
    }
    db.prepare("UPDATE agent_affiliations SET owner_hidden_at = NULL").run();

    // ── Gate open ─────────────────────────────────────────────────────────
    setEnv(ENFORCE_ENV, "1");
    setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    enforce.__setEnforceRegistryForTesting(LIVE);
    resetCap();
    assertEq(enforce.affiliationsPerItemEnabled(ENF_ID), true, "on-0: per-item enabled");
    assertEq(enforce.affiliationsPageMode(ENF_ID), "hide_owner_hidden", "on-0b: page mode hides owner-hidden rows");
    assertEq(await fingerprint(ENF_ID), baseline, "on-0c: nothing hidden yet → card and memberOf as before");
    {
      const html = await valgPage(ENF_ID);
      assertTrue(html.includes('data-affiliations="2"'), "list-1: «Mine valg» lists the two shown affiliations");
      assertTrue(html.includes(`data-umbrella-id="${UMB_A}" data-hidden="0"`) && html.includes(`data-umbrella-id="${UMB_B}" data-hidden="0"`), "list-2: A and B listed as shown");
      assertTrue(!html.includes(`data-umbrella-id="${UMB_OFF}"`) && !html.includes(`data-umbrella-id="${UMB_ORG}"`) && !html.includes(`data-umbrella-id="${UMB_TWIN}"`),
        "list-3: inactive, organic-claim and the other producer's umbrellas are not listed");
      assertTrue(html.includes(">Skjul</button>") && html.includes('action="/eier/s32-owned/valg/tilknytning"'), "list-4: «Skjul» buttons posting to /valg/tilknytning");
    }

    // ── AC1: hide A ───────────────────────────────────────────────────────
    {
      const r = await post(ENF_ID, { umbrella_id: UMB_A, hidden: "1" });
      assertEq([r.status, loc(r)], [303, `/eier/${ENF_ID}/valg?melding=tilknytning_skjult&ved=gruppe-auto#gruppe-auto`], "hide-1: 303 back to the list with the message");
      assertTrue(hiddenAt(ENF_ID, UMB_A) !== null, "hide-2: owner_hidden_at set on A");
      assertEq(hiddenAt(TWIN_ID, UMB_A), null, "hide-3: the twin's row for the same umbrella untouched");
      assertEq(await shows(ENF_ID, UMB_A), [false, false], "hide-4: A gone from the card and memberOf");
      assertEq(await shows(ENF_ID, UMB_B), [true, true], "hide-5: B still in the card and memberOf");
      assertEq(await shows(TWIN_ID, UMB_A), [true, true], "hide-6: the twin still shows A");
      assertEq(logRows(ENF_ID), [{ old_value: null, new_value: NAMES[UMB_A], changed_by: "owner" }], "log-1: one change-log row for the hide");
      const html = await valgPage(ENF_ID);
      assertTrue(html.includes(`data-umbrella-id="${UMB_A}" data-hidden="1"`) && html.includes(">Vis igjen</button>"), "hide-7: A still listed, as hidden, with «Vis igjen»");
      const msg = await valgPage(ENF_ID);
      assertTrue(msg.includes("data-affiliations"), "hide-8: list still shown");
      const feed = auditLog.readOwnerAuditFeed(db, ENF_ID, 10);
      assertTrue(JSON.stringify(feed).includes("Skjult tilknytning") && JSON.stringify(feed).includes(NAMES[UMB_A]), "log-2: the owner's «Endringslogg» shows the change");
    }

    // ── AC5: a repeat writes nothing ──────────────────────────────────────
    {
      const at = hiddenAt(ENF_ID, UMB_A);
      const r = await post(ENF_ID, { umbrella_id: UMB_A, hidden: "1" });
      assertEq([r.status, loc(r)], [303, `/eier/${ENF_ID}/valg?melding=ingen_endring&ved=gruppe-auto#gruppe-auto`], "repeat-1: «Ingen endring»");
      assertEq([hiddenAt(ENF_ID, UMB_A), logRows(ENF_ID).length], [at, 1], "repeat-2: timestamp unchanged, no second log row");
    }

    // ── AC2: «Vis igjen» ──────────────────────────────────────────────────
    {
      const r = await post(ENF_ID, { umbrella_id: UMB_A, hidden: "0" });
      assertEq([r.status, loc(r)], [303, `/eier/${ENF_ID}/valg?melding=tilknytning_vist&ved=gruppe-auto#gruppe-auto`], "show-1: 303 with «vises igjen»");
      assertEq(hiddenAt(ENF_ID, UMB_A), null, "show-2: owner_hidden_at cleared");
      assertEq(await shows(ENF_ID, UMB_A), [true, true], "show-3: A back in the card and memberOf");
      assertEq(await fingerprint(ENF_ID), baseline, "show-4: card and memberOf identical to the baseline");
      assertEq(logRows(ENF_ID).length, 2, "log-3: one more row for the un-hide");
      assertEq(logRows(ENF_ID)[1], { old_value: NAMES[UMB_A], new_value: null, changed_by: "owner" }, "log-4: the un-hide row");
      await post(ENF_ID, { umbrella_id: UMB_A, hidden: "0" });
      assertEq(logRows(ENF_ID).length, 2, "log-5: a repeated «Vis igjen» writes no row");
    }

    // ── AC3: refusals ─────────────────────────────────────────────────────
    {
      const before = () => [allHidden(), allLog()];
      const b0 = before();
      for (const [name, body] of [
        ["another producer's umbrella", { umbrella_id: UMB_TWIN, hidden: "1" }],
        ["unknown umbrella", { umbrella_id: "s32-nope", hidden: "1" }],
        ["inactive umbrella", { umbrella_id: UMB_OFF, hidden: "1" }],
        ["organic-claim umbrella without Debio", { umbrella_id: UMB_ORG, hidden: "1" }],
        ["no umbrella", { hidden: "1" }],
      ] as Array<[string, any]>) {
        const r = await post(ENF_ID, body);
        assertEq([r.status, ...before()], [404, ...b0], `refuse-${name}: 404, nothing written`);
      }
      assertEq(hiddenAt(TWIN_ID, UMB_TWIN), null, "refuse-twin: the other producer's row untouched");
      const bad = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "yes" });
      assertEq([bad.status, loc(bad).includes("melding=ugyldig"), ...before()], [303, true, ...b0], "refuse-bad-value: «ugyldig», nothing written");
      // Session / ownership / Origin: as the other /valg/* POSTs (pageGate + pageWriteGuard).
      const noSession = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "1" }, "");
      assertEq([noSession.status, ...before()], [401, ...b0], "refuse-no-session: 401 like /valg/sett, nothing written");
      const otherSession = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "1" }, tokens[TWIN_ID]);
      assertEq([otherSession.status, ...before()], [403, ...b0], "refuse-other-session: 403, nothing written");
      const xs = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "1" }, tokens[ENF_ID], { origin: "https://evil.example" });
      assertEq([xs.status, ...before()], [403, ...b0], "refuse-cross-site: 403, nothing written");
      setEnv(ALLOW_ENV, `rfb:${TWIN_ID}`);
      const notListed = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "1" });
      assertEq([notListed.status, ...before()], [404, ...b0], "refuse-not-allowlisted: 404, nothing written");
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    }

    // ── Admin lock on the switch locks the rows too ──────────────────────
    {
      db.prepare(
        `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
         VALUES ('rfb', ?, ?, 'true', 'admin', 1, ?)`,
      ).run(ENF_ID, KEY, new Date().toISOString());
      resetCap();
      const r = await post(ENF_ID, { umbrella_id: UMB_B, hidden: "1" });
      assertEq([r.status, loc(r).includes("melding=sperret"), hiddenAt(ENF_ID, UMB_B), logRows(ENF_ID).length], [303, true, null, 2], "lock-1: admin-locked → «sperret», nothing written");
      const html = await valgPage(ENF_ID);
      assertTrue(html.includes("data-affiliations") && !html.includes("/valg/tilknytning"), "lock-2: list shown without buttons");
      db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(ENF_ID);
    }

    // ── S3-1 switch off still hides everything; fail closed ──────────────
    {
      await post(ENF_ID, { umbrella_id: UMB_A, hidden: "1" });
      db.prepare(
        `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
         VALUES ('rfb', ?, ?, 'false', 'owner', 0, ?)`,
      ).run(ENF_ID, KEY, new Date().toISOString());
      assertEq(enforce.affiliationsPageMode(ENF_ID), "none", "switch-1: switch off → none");
      const f = await fingerprint(ENF_ID);
      assertEq([f.card, f.memberOf], ["", ""], "switch-2: switch off → no card and no memberOf (B too)");
      assertTrue((await valgPage(ENF_ID)).includes('data-affiliations-off="1"'), "switch-3: the list says the switch is off");
      db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(ENF_ID);
      assertEq([await shows(ENF_ID, UMB_A), await shows(ENF_ID, UMB_B)], [[false, false], [true, true]], "switch-4: switch back on → B shown, A still hidden");

      const errs: string[] = [];
      const prevErr = console.error;
      console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); };
      try {
        const throwingDb = { prepare() { throw new Error("boom"); } };
        const env = { [ENFORCE_ENV]: "1", [ALLOW_ENV]: `rfb:${ENF_ID}` } as NodeJS.ProcessEnv;
        assertEq(enforce.affiliationsPageMode(ENF_ID, { db: throwingDb, env }), "none", "fail-1: a failed lookup → none");
        db.exec("ALTER TABLE owner_feature_settings RENAME TO owner_feature_settings_s32");
        try {
          const ff = await fingerprint(ENF_ID);
          assertEq([ff.card, ff.memberOf], ["", ""], "fail-2: lookup throws on the page → no affiliations");
        } finally {
          db.exec("ALTER TABLE owner_feature_settings_s32 RENAME TO owner_feature_settings");
        }
        assertTrue(errs.some((e) => e.includes("auto.affiliations lookup failed")), "fail-3: the failure is logged");
      } finally {
        console.error = prevErr;
      }
    }

    // ── AC6 again: a second init keeps the stored choice ─────────────────
    {
      const at = hiddenAt(ENF_ID, UMB_A);
      initMod.__initSchemaForTesting(db as any);
      assertTrue(at !== null && hiddenAt(ENF_ID, UMB_A) === at, "migrate-4: a second init keeps owner_hidden_at values");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    enforce.__setEnforceRegistryForTesting(null);
    setEnv(ALLOW_ENV, prevAllow ?? null);
    setEnv(ENFORCE_ENV, prevEnforce ?? null);
    setEnv(GATE_ENV, prevGate ?? null);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS32Tests({ log: true }).then((r) => {
    console.info(`\nowner-features-s3-2: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}

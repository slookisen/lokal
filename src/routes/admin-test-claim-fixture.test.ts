/**
 * admin-test-claim-fixture.test.ts — dev-request 2026-11-01-rfb-kravflyt-tal-
 * eiere-fra-e-post, AC6 (Daniel's option A, 2026-11-01): POST
 * /admin/test-claim-fixture keeps ONE hidden, UNCLAIMED claim-test profile so
 * the owner-claim flow can be tested end to end in production.
 *
 * Against the REAL routers/services on the production schema in an in-memory
 * DB (handlers pulled off each router's stack, fake req/res — the
 * rfb-hidden-test-producer.test.ts harness; selger.html's inline script in
 * node:vm — the rfb-claim-kravflyt.test.ts harness; no HTTP server, no network):
 *
 *   (unit)   isClaimTestFixtureRow / isArmedClaimTestFixtureRow and the
 *            `claimTestFixtureInfo` option of isAgentPubliclyVisible: only the
 *            armed claim fixture is let through, every other gate still holds.
 *   (guard)  no key 403; bad mode/agent_id/farm_email 400; a real producer and
 *            the order fixture (even by id) → 409 not_a_claim_test_fixture with
 *            zero writes; unknown id 404; a marker-less look-alike refused;
 *            two claim fixtures → 409.
 *   (shared) farm_email that is already a known farm e-mail of another profile
 *            (listed, case-insensitive, or delivered outreach; the order
 *            fixture's owner address) → dry-run warns, apply 409, nothing written.
 *   (arm)    dry-run writes nothing; apply creates ONE hidden unclaimed row with
 *            agent_knowledge.email = farm_email (rule 1's farm address); audit
 *            rows; farm_email masked everywhere in the response.
 *   (pins)   every reset/retire write, run directly with a real producer's id,
 *            the order fixture's id, and another claim fixture's id, changes
 *            nothing — the id AND marker pins hold on their own.
 *   (tp)     POST /admin/test-producer and the switch probe still see exactly
 *            the order fixture; the order fixture is byte-identical at the end.
 *   (claim)  selger.html /selger?agent=<id> shows the single store via the REAL
 *            GET /info; the code goes to farm_email (transport stubbed); rule 4
 *            and the resend wait hold; verify → owner; the dashboard's /info
 *            with X-Claim-Token works; owner login + session.
 *   (reset)  arm after a verified claim removes claims, ownership, the badge,
 *            magic links, owner sessions, the pause and a pending order-e-mail
 *            change; a new claim works; the K5 approval path; reset again.
 *   (retire) retire → inactive and /info 404s; idempotent; arm re-arms.
 *   (hidden) every public surface (lists, search, /find-match, feeds, sitemap,
 *            llms-full.txt, MCP, A2A, stats, top producers, card/vcard/trust,
 *            /produsent/:slug, outreach, verifier): absent — with a control
 *            phase (catalog_hidden=0) proving each surface would show it — and
 *            under ?as_public=1; /info serves it in both by-id flag states.
 *   (pipes)  Brreg self-sufficiency, org-nr backfill, website discovery and
 *            contact extraction never select it (batch and agentIds).
 *
 * Exported runAdminTestClaimFixtureTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/admin-test-claim-fixture.test.ts
 */

import * as vm from "vm";
import Database from "better-sqlite3";
import { slugify } from "../utils/slug";
import { inlineScript } from "../../tests/helpers/html-injection";
import { jsonResponse, settle, runPage, type FetchStub } from "../../tests/helpers/fake-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

const OSLO = { lat: 59.9139, lng: 10.7522 };
const LEGACY_ID = "dff0c55e-8770-47cb-9e19-bd8099fcd5d5";
const NORMAL_ID = "kf-normal";
const NORMAL_NAME = "Normal Gard Kravliste";
const LEGACY_NAME = "Ordre Gard Kravliste";
/** The fixture's name while the visibility section gives it listable data. */
const CF_LIST_NAME = "Kravtest Gard Kravliste";
// Test-only addresses on reserved example domains.
const FARM_HOST = "kravtest-innboks.example.no";
const FARM = `post@${FARM_HOST}`;
const CLAIMANT = "ola@kravtest-krever.example.test";
const STRANGER = "kari@kravtest-annen.example.test";
const LEGACY_NOTIFY = "ordre@legacy-varsel.example.test";
const LEGACY_OWNER = "eier@legacy-eier.example.test";
const OUTREACH_ADDR = "levert@outreach-gard.example.test";

function seedProducer(db: Database.Database, o: { id: string; name: string }): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id,
        order_notifications_opt_in, order_notification_email)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, ?, ?, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 1, ?)`,
  ).run(
    o.id, o.name,
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${o.id}.example.no`, `https://${o.id}.example.no`, `key-${o.id}`, OSLO.lat, OSLO.lng, `post@${o.id}.example.no`,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, field_provenance, email, website, about, products, verification_status, verified_second_line,
        enrichment_status, url_last_status, url_last_probed, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    o.id,
    JSON.stringify({ categories: [{ source_type: "website_homepage", source_url: `https://${o.id}.example.no` }] }),
    `post@${o.id}.example.no`, `https://${o.id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([
      { name: "Listepoteter", price: "30 kr/kg", category: "vegetables" },
      { name: "Gulrøtter", price: "25 kr/kg", category: "vegetables" },
      { name: "Kål", price: "20 kr/stk", category: "vegetables" },
    ]),
  );
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url, availability_source)
     VALUES (?, ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg', 'admin_producer_confirmed')`,
  ).run(`prod-${o.id}`, o.id);
  db.prepare(
    `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at, is_owner, traffic_category)
     VALUES (?, ?, 'Oslo', 'search', datetime('now'), 0, 'human')`,
  ).run(o.id, o.name);
}

export async function runAdminTestClaimFixtureTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function eq(actual: unknown, expected: unknown, label: string): void {
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
  function ok(cond: boolean, label: string): void {
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

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; headers?: Record<string, string>; path?: string }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      method: "GET", url: o.path || "/", path: o.path || "/", originalUrl: o.path || "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers,
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) {
        if (name.toLowerCase() === "host") return "rettfrabonden.com";
        return headers[name.toLowerCase()];
      },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const done = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { done(p); return res; },
        send(p: any) { done(p); return res; },
        redirect(c: number, loc: string) { status = c; done({ __redirect: loc }); return res; },
        end() { done(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
        cookie() { return res; }, clearCookie() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => done({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => done({ __error: String(err) }));
      } catch (err) {
        done({ __error: String(err) });
      }
    });
  }

  // ── env: claim limits on their defaults, no admin mail, no Fly ─────────
  const ENV_KEYS = ["CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX", "CLAIM_DOMAIN_RULE_ENABLED",
    "ADMIN_NOTIFICATION_EMAIL", "FLY_APP_NAME", "OWNER_VISIBILITY_ENFORCE_BY_ID", "OWNER_PAUSE_ENABLED",
    "OWNER_FEATURES_ENFORCE", "OWNER_UNIFIED_SESSION_ENABLED", "OUTREACH_PAUSED"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "admin-test-claim-fixture-standalone-key";
  const adminKey = () => process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? "") });
      return { messageId: `stub-${mails.length}` };
    },
  };
  const codeIn = (m: SentMail | undefined): string => (m?.text.match(/\b(\d{6})\b/) ?? [])[1] ?? "";

  const geo = require("../services/geocoding-service") as typeof import("../services/geocoding-service");
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./discovery", "./agent-stats", "./a2a",
    "./admin-test-producer", "./admin-test-claim-fixture"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* registry/seo chatter */ }; console.warn = () => { /* idem */ }; }
  const realFetch = globalThis.fetch;
  let cfMod: typeof import("./admin-test-claim-fixture") | null = null;
  let tpMod: typeof import("./admin-test-producer") | null = null;
  let wdMod: typeof import("./admin-rfb-website-discovery") | null = null;
  let bssMod: typeof import("./admin-rfb-brreg-selfsufficiency") | null = null;
  let cxMod: typeof import("./admin-rfb-contact-extraction") | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
    geo.__setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();
    clearRegistryCaches();

    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const seoMod = require("./seo") as typeof import("./seo");
    const seoRouter = seoMod.default as any;
    const discoveryRouter = require("./discovery").default as any;
    const agentStatsRouter = require("./agent-stats").default as any;
    const a2aRouter = require("./a2a").default as any;
    tpMod = require("./admin-test-producer") as typeof import("./admin-test-producer");
    cfMod = require("./admin-test-claim-fixture") as typeof import("./admin-test-claim-fixture");
    tpMod.__setTestProducerDbForTesting(db as any);
    cfMod.__setTestClaimFixtureDbForTesting(db as any);
    const adminAgentsRouter = require("./admin-agents").default as any;
    wdMod = require("./admin-rfb-website-discovery") as typeof import("./admin-rfb-website-discovery");
    bssMod = require("./admin-rfb-brreg-selfsufficiency") as typeof import("./admin-rfb-brreg-selfsufficiency");
    cxMod = require("./admin-rfb-contact-extraction") as typeof import("./admin-rfb-contact-extraction");
    const adminAgentsMod = require("./admin-agents") as typeof import("./admin-agents");
    const visibility = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    const verifier = require("../agents/lokal-agent-verifier") as typeof import("../agents/lokal-agent-verifier");
    const { computeOutreachCandidates } = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
    const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { maskEmail } = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
    const { verifyOwnerSession } = require("./owner-portal") as typeof import("./owner-portal");
    const { selectSwitchProbeFixture } = require("../owner-features/switch-probe") as typeof import("../owner-features/switch-probe");

    const tools = new Map<string, (args: any) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() { /* no-op */ }, prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");

    const H = {
      search: findRouteHandler(marketplaceRouter, "/search", "get"),
      discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
      agents: findRouteHandler(marketplaceRouter, "/agents", "get"),
      findMatch: findRouteHandler(marketplaceRouter, "/find-match", "get"),
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      trust: findRouteHandler(marketplaceRouter, "/agents/:id/trust", "get"),
      claim: findRouteHandler(marketplaceRouter, "/agents/:id/claim", "post"),
      verify: findRouteHandler(marketplaceRouter, "/agents/:id/claim/verify", "post"),
      resend: findRouteHandler(marketplaceRouter, "/agents/:id/claim/resend", "post"),
      authLogin: findRouteHandler(marketplaceRouter, "/auth/login", "post"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      offers: findRouteHandler(catalogRouter, "/offers", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      home: findRouteHandler(seoRouter, "/", "get"),
      verified: findRouteHandler(seoRouter, "/verifisert-av-eier", "get"),
      city: findRouteHandler(seoRouter, "/:city", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
      agentsJson: findRouteHandler(discoveryRouter, "/.well-known/agents.json", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "get"),
      apiStats: findRouteHandler(a2aRouter, "/api/stats", "get"),
      agentStats: findRouteHandler(agentStatsRouter, "/api/agents/:id/stats", "get"),
      testProducer: findRouteHandler(tpMod.default as any, "/", "post"),
      claimFixture: findRouteHandler(cfMod.default as any, "/", "post"),
      approve: findRouteHandler(adminAgentsRouter, "/claim-review-approve", "post"),
      orgNrBackfill: findRouteHandler(adminAgentsRouter, "/org-nr-backfill", "post"),
      bss: findRouteHandler(bssMod.default as any, "/rfb-brreg-selfsufficiency", "post"),
      wd: findRouteHandler(wdMod.default as any, "/rfb-website-discovery", "post"),
      cx: findRouteHandler(cxMod.default as any, "/rfb-contact-extraction", "post"),
    };
    const withKey = (key: string | null = adminKey()) => (key === null ? {} : { "x-admin-key": key });
    const postCf = (body: any, key: string | null = adminKey()) => invoke(H.claimFixture, makeReq({ body, headers: withKey(key) }));
    const postTp = (body: any) => invoke(H.testProducer, makeReq({ body, headers: withKey() }));
    const adminPost = (h: Function, body: any) => invoke(h, makeReq({ body, headers: withKey() }));
    const info = (id: string, headers: Record<string, string> = {}) => invoke(H.info, makeReq({ params: { id }, headers }));
    const claim = (id: string, body: any) => invoke(H.claim, makeReq({ params: { id }, body }));
    const verify = (id: string, claimId: unknown, code: unknown) => invoke(H.verify, makeReq({ params: { id }, body: { claimId, code } }));
    const resend = (id: string, claimId: unknown) => invoke(H.resend, makeReq({ params: { id }, body: { claimId } }));

    const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
    const auditCount = () => count("SELECT COUNT(*) AS n FROM agent_knowledge_audit");
    const fixtureCount = () => count("SELECT COUNT(*) AS n FROM agents WHERE origin = 'test_claim_fixture'");
    // The activity counters move whenever a public surface lists a row (the
    // as-public view lists the order fixture); everything else must not.
    const rowSnap = (id: string) => {
      const row = db.prepare("SELECT a.*, k.* FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?").get(id) as Record<string, unknown> | undefined;
      if (row) for (const c of ["discovery_count", "interaction_count", "total_interactions", "last_seen_at"]) delete row[c];
      return JSON.stringify(row);
    };
    const ownedArtefacts = (id: string) => ({
      claims: count("SELECT COUNT(*) AS n FROM agent_claims WHERE agent_id = ?", id),
      magic: count("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = ?", id),
      pause: count("SELECT COUNT(*) AS n FROM owner_profile_pause WHERE agent_id = ?", id),
      pending: count("SELECT COUNT(*) AS n FROM owner_order_email_change WHERE agent_id = ? AND outcome IS NULL", id),
    });
    const noFarm = (body: unknown, label: string) =>
      ok(!JSON.stringify(body ?? "").toLowerCase().includes(FARM.toLowerCase()), `${label}: the response never carries the full farm_email`);

    // ══ (unit) the helper and the one by-id exception ═════════════════════
    {
      const armed = { origin: "test_claim_fixture", catalog_hidden: 1, is_active: 1, is_vetted: 1, vertical_id: "rfb" };
      eq(visibility.CLAIM_TEST_FIXTURE_ORIGIN, "test_claim_fixture", "unit-1: the marker origin");
      eq(visibility.isClaimTestFixtureRow(armed), true, "unit-2: origin + catalog_hidden=1 is the claim fixture");
      eq(visibility.isClaimTestFixtureRow({ ...armed, catalog_hidden: 0 }), false, "unit-3: the same origin without catalog_hidden is not");
      eq(visibility.isClaimTestFixtureRow({ ...armed, origin: "test_fixture" }), false, "unit-4: the order fixture is not");
      eq(visibility.isClaimTestFixtureRow(undefined), false, "unit-5: no row is not");
      eq(visibility.isArmedClaimTestFixtureRow({ ...armed, is_active: 0 }), false, "unit-6: a retired claim fixture is not armed");
      const vis = (row: any, claimTestFixtureInfo?: boolean) => visibility.isAgentPubliclyVisible(row, { surface: "gated", ...(claimTestFixtureInfo ? { claimTestFixtureInfo } : {}) });
      eq(vis(armed), false, "unit-7: without the option the claim fixture is quarantined like any hidden row");
      eq(vis(armed, true), true, "unit-8: with the option (GET /info) the armed claim fixture is served");
      eq(vis({ ...armed, is_active: 0 }, true), false, "unit-9: … not once retired");
      eq(vis({ origin: "test_fixture", catalog_hidden: 1, is_active: 1 }, true), false, "unit-10: the order fixture stays hidden with the option");
      eq(vis({ origin: "discovery", catalog_hidden: 1, is_active: 1 }, true), false, "unit-11: a real hidden row stays hidden with the option");
      eq(vis({ ...armed, vertical_id: "dental" }, true), false, "unit-12: the vertical gate still applies to the claim fixture");
      eq(vis({ ...armed, origin: "self_registered" }, true), false, "unit-13: (a self_registered look-alike is no claim fixture and stays quarantined)");
      process.env.OWNER_VISIBILITY_ENFORCE_BY_ID = "1";
      eq(vis(armed, true), true, "unit-14: by-id flag on: the armed claim fixture is served");
      eq(vis({ ...armed, is_active: 0 }, true), false, "unit-15: by-id flag on: a retired one is not");
      eq(visibility.isAgentPubliclyVisible(armed, { surface: "ungated" }), false, "unit-16: by-id flag on: ungated surfaces (MCP resource, /metrics) keep it hidden");
      eq(visibility.isAgentPubliclyVisible(armed, { surface: "ungated", allowCatalogHidden: true }), false, "unit-17: by-id flag on: lokal_info's allowCatalogHidden (the order fixture's) does not reach it");
      eq(visibility.isAgentPubliclyVisible({ origin: "test_fixture", catalog_hidden: 1, is_active: 1 }, { surface: "ungated", allowCatalogHidden: true }), true,
        "unit-18: … the order fixture keeps it (unchanged)");
      delete process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;
    }

    // ══ setup: a normal producer and the armed order fixture with an owner ═
    seedProducer(db, { id: NORMAL_ID, name: NORMAL_NAME });
    seedProducer(db, { id: LEGACY_ID, name: LEGACY_NAME });
    {
      const r = await postTp({ email: LEGACY_NOTIFY, owner_email: LEGACY_OWNER, apply: true });
      eq([r.status, r.body?.agent_id, r.body?.target], [200, LEGACY_ID, "adopt_legacy"], "setup: the order fixture is armed with an owner login");
    }
    const legacyBefore = rowSnap(LEGACY_ID);
    const legacyArtefactsBefore = ownedArtefacts(LEGACY_ID);

    // ══ (guard) auth, validation, refusals ═════════════════════════════════
    {
      eq((await postCf({ farm_email: FARM }, null)).status, 403, "guard-1: no X-Admin-Key → 403");
      eq((await postCf({ farm_email: FARM }, "wrong-key")).status, 403, "guard-2: wrong X-Admin-Key → 403");
      eq((await postCf({ mode: "delete", farm_email: FARM })).status, 400, "guard-3: unknown mode → 400");
      eq((await postCf({})).status, 400, "guard-4: arm without farm_email → 400");
      eq((await postCf({ farm_email: "not-an-email" })).status, 400, "guard-5: a malformed farm_email → 400");
      eq((await postCf({ farm_email: "a,b@kravtest.example.test" })).status, 400, "guard-6: a farm_email rule 1 would not accept (two addresses) → 400");
      eq((await postCf({ farm_email: FARM, agent_id: "  " })).status, 400, "guard-7: an empty agent_id → 400");
      const beforeNormal = rowSnap(NORMAL_ID);
      const beforeAudit = auditCount();
      for (const [label, body] of [
        ["dry-run", { agent_id: NORMAL_ID, farm_email: FARM }],
        ["apply", { agent_id: NORMAL_ID, farm_email: FARM, apply: true }],
        ["retire", { agent_id: NORMAL_ID, mode: "retire", apply: true }],
        ["no farm_email (guard first)", { agent_id: NORMAL_ID, apply: true }],
      ] as Array<[string, any]>) {
        const r = await postCf(body);
        eq([r.status, r.body?.error], [409, "not_a_claim_test_fixture"], `guard-8: a real producer id (${label}) → 409 not_a_claim_test_fixture`);
      }
      for (const [label, body] of [
        ["dry-run", { agent_id: LEGACY_ID, farm_email: FARM }],
        ["apply", { agent_id: LEGACY_ID, farm_email: FARM, apply: true }],
        ["retire", { agent_id: LEGACY_ID, mode: "retire", apply: true }],
      ] as Array<[string, any]>) {
        const r = await postCf(body);
        eq([r.status, r.body?.error], [409, "not_a_claim_test_fixture"], `guard-9: the order fixture's id (${label}) → 409 — it is never reset`);
      }
      eq((await postCf({ agent_id: "no-such-agent", farm_email: FARM })).status, 404, "guard-10: an unknown id → 404");
      eq((await postCf({ mode: "retire", apply: true })).status, 404, "guard-11: retire with no claim fixture → 404");
      eq(rowSnap(NORMAL_ID), beforeNormal, "guard-13: the real producer is byte-identical after every refused call");
      eq(rowSnap(LEGACY_ID), legacyBefore, "guard-14: the order fixture is byte-identical after every refused call");
      eq([auditCount(), fixtureCount()], [beforeAudit, 0], "guard-15: no audit row, no fixture row written by refused calls");
      // A marker-less look-alike (the claim origin without catalog_hidden) is not a fixture.
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, catalog_hidden)
         VALUES ('kf-lookalike', 'Lookalike', 'x', 'test', 'l@x.example.test', 'https://l.example.test', 'producer', 'key-lookalike', 'test_claim_fixture', 0)`,
      ).run();
      const r = await postCf({ agent_id: "kf-lookalike", farm_email: FARM, apply: true });
      eq([r.status, r.body?.error], [409, "not_a_claim_test_fixture"], "guard-16: origin='test_claim_fixture' WITHOUT catalog_hidden=1 is refused (both halves of the marker)");
      db.prepare("DELETE FROM agents WHERE id = 'kf-lookalike'").run();
    }

    // ══ (shared) an address already known for another profile ═════════════
    {
      const beforeAudit = auditCount();
      let r = await postCf({ farm_email: LEGACY_OWNER });
      eq([r.status, r.body?.dry_run, r.body?.warnings?.[0]?.code], [200, true, "farm_email_shared"], "shared-1: the order fixture's owner address → dry-run warns farm_email_shared");
      ok((r.body?.warnings?.[0]?.ids ?? []).includes(LEGACY_ID), "shared-2: … naming the profile that has it");
      r = await postCf({ farm_email: LEGACY_OWNER, apply: true });
      eq([r.status, r.body?.error], [409, "farm_email_shared"], "shared-3: … and apply refuses with 409");
      ok(!JSON.stringify(r.body).includes(LEGACY_OWNER), "shared-4: the refusal does not echo the address");
      r = await postCf({ farm_email: `  POST@${NORMAL_ID.toUpperCase()}.EXAMPLE.NO ` , apply: true });
      eq([r.status, r.body?.error], [409, "farm_email_shared"], "shared-5: a real producer's listed address, any case → 409");
      db.prepare("INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id) VALUES (?, ?, datetime('now'), 'email', 'rfb')")
        .run(NORMAL_ID, OUTREACH_ADDR);
      db.prepare("UPDATE agent_knowledge SET email = NULL WHERE agent_id = ?").run(NORMAL_ID);
      r = await postCf({ farm_email: OUTREACH_ADDR, apply: true });
      eq([r.status, r.body?.error], [409, "farm_email_shared"], "shared-6: an address outreach was delivered to for another profile (its known e-mail) → 409");
      db.prepare("UPDATE agent_knowledge SET email = ? WHERE agent_id = ?").run(`post@${NORMAL_ID}.example.no`, NORMAL_ID);
      db.prepare("DELETE FROM outreach_sent_log WHERE agent_id = ?").run(NORMAL_ID);
      eq([auditCount(), fixtureCount()], [beforeAudit, 0], "shared-7: nothing written by any refused apply");
      r = await postCf({ farm_email: FARM });
      eq(r.body?.warnings, [], "shared-8: a fresh test inbox → no warning");
    }

    // ══ (arm) dry-run, then create ═════════════════════════════════════════
    let FIX = "";
    {
      const beforeAudit = auditCount();
      const beforeAgents = count("SELECT COUNT(*) AS n FROM agents");
      let r = await postCf({ farm_email: FARM });
      eq([r.status, r.body?.dry_run, r.body?.target, r.body?.agent_id], [200, true, "create", null], "arm-1: dry-run (the default) plans a create");
      ok((r.body?.changes ?? []).some((c: any) => c.field === "agents.row" && c.new === "created"), "arm-2: … the plan lists the new row");
      eq(r.body?.farm_email, maskEmail(FARM), "arm-3: … farm_email masked");
      noFarm(r.body, "arm-4");
      eq([count("SELECT COUNT(*) AS n FROM agents"), auditCount()], [beforeAgents, beforeAudit], "arm-5: dry-run wrote nothing");

      r = await postCf({ farm_email: `  ${FARM.toUpperCase()} `, apply: true });
      eq([r.status, r.body?.dry_run, r.body?.target], [200, false, "create"], "arm-6: apply creates the fixture");
      FIX = String(r.body?.agent_id ?? "");
      ok(/^[0-9a-f-]{36}$/.test(FIX), "arm-7: the fixture id is a UUID");
      eq(r.body?.selger_path, `/selger?agent=${FIX}`, "arm-8: the response gives the /selger?agent=<id> path");
      eq(r.body?.farm_email, maskEmail(FARM), "arm-9: farm_email masked (normalized)");
      noFarm(r.body, "arm-10");
      eq(r.body?.claim_check, { info_served: true, has_owner: false, code_recipient: maskEmail(FARM), shared_address: false },
        "arm-11: claim_check — /info serves it, no owner, rule 1 sends the code to farm_email, not shared");
      const row = db.prepare(
        `SELECT a.name, a.origin, a.catalog_hidden, a.is_active, a.is_verified, a.claimed_at, a.claimed_via, a.role, a.vertical_id,
                k.email, k.website, a.org_nr FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`,
      ).get(FIX);
      eq(row, { name: "Kravtest (skjult)", origin: "test_claim_fixture", catalog_hidden: 1, is_active: 1, is_verified: 0, claimed_at: null, claimed_via: null,
        role: "producer", vertical_id: "rfb", email: FARM, website: null, org_nr: null }, "arm-12: one hidden, active, unverified, unclaimed RFB producer with the farm address in agent_knowledge.email");
      eq(knowledgeService.resolveFarmContactEmail(FIX), FARM, "arm-13: rule 1 (resolveFarmContactEmail) picks farm_email");
      const audits = db.prepare("SELECT field_name, changed_by FROM agent_knowledge_audit WHERE agent_id = ?").all(FIX) as any[];
      eq(audits.length, r.body?.audit_rows, "arm-14: one audit row per reported change");
      ok(audits.length > 0 && audits.every((a) => a.changed_by === "admin"), "arm-15: audit rows are admin-attributed");
      eq(fixtureCount(), 1, "arm-16: exactly one claim fixture");
      r = await postCf({ farm_email: FARM });
      eq([r.body?.target, r.body?.agent_id, r.body?.changes], ["existing", FIX, []], "arm-17: arming the fresh fixture again changes nothing");
      r = await postCf({ farm_email: FARM, agent_id: FIX });
      eq([r.status, r.body?.agent_id], [200, FIX], "arm-18: its own id is accepted");
      eq((await postCf({ mode: "retire", farm_email: FARM })).status, 400, "guard-12: farm_email with retire → 400");
    }

    // ══ (tp) POST /admin/test-producer and the switch probe are unchanged ══
    {
      let r = await postTp({ email: LEGACY_NOTIFY });
      eq([r.status, r.body?.target, r.body?.agent_id], [200, "existing", LEGACY_ID], "tp-1: /admin/test-producer still resolves exactly the order fixture (no multiple_test_fixtures)");
      r = await postTp({ email: LEGACY_NOTIFY, owner_email: LEGACY_OWNER, apply: true });
      eq([r.status, r.body?.changes], [200, []], "tp-2: re-arming the order fixture is still a no-op");
      r = await postTp({ agent_id: FIX, email: LEGACY_NOTIFY, apply: true });
      eq([r.status, r.body?.error], [409, "not_a_test_fixture"], "tp-3: /admin/test-producer refuses the claim fixture");
      const env = { OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${LEGACY_ID},rfb:${FIX}` } as NodeJS.ProcessEnv;
      eq(selectSwitchProbeFixture(db, undefined, env), { ok: true, agentId: LEGACY_ID }, "tp-4: the switch probe still picks only the order fixture");
      eq((selectSwitchProbeFixture(db, FIX, env) as any).error, "not_a_test_fixture", "tp-5: … and refuses the claim fixture");
    }

    // ══ (pins) every write, run directly against other rows, changes nothing ═
    {
      const W = cfMod.CLAIM_FIXTURE_WRITES;
      // Give the real producer and a second claim-fixture row the artefacts a
      // reset deletes, so a missing pin would show.
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, catalog_hidden)
         VALUES ('kf-other', 'Annen kravtest', 'x', 'test', 'o@x.example.test', 'https://o.example.test', 'producer', 'key-kf-other', 'test_claim_fixture', 1)`,
      ).run();
      db.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES ('kf-other', 'annen@kravtest-other.example.test')").run();
      // A real producer WITHOUT an agent_knowledge row (an unpinned INSERT would create one).
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES ('kf-bare', 'Bar Gard', 'x', 'test', 'b@x.example.test', 'https://b.example.test', 'producer', 'key-kf-bare')`,
      ).run();
      for (const id of [NORMAL_ID, "kf-other"]) {
        db.prepare("UPDATE agents SET claimed_at = '2026-10-01T00:00:00.000Z', claimed_via = 'claim', is_verified = 1 WHERE id = ?").run(id);
        db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token) VALUES (?, ?, 'Eier', ?, 'verified', ?)`,
        ).run(`claim-${id}`, id, `eier@${id}.example.test`, `claim_tok_${id}`);
        db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES (?, ?, ?, ?, 1, ?)")
          .run(`ml-${id}`, `eier@${id}.example.test`, `tok-${id}`, id, new Date(Date.now() + 86_400_000).toISOString());
        db.prepare("INSERT INTO owner_profile_pause (agent_id, paused_at) VALUES (?, ?)").run(id, new Date().toISOString());
        db.prepare(
          `INSERT INTO owner_order_email_change (token_hash, agent_id, new_email, requested_at, expires_at) VALUES (?, ?, 'ny@x.example.test', ?, ?)`,
        ).run(`th-${id}`, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      }
      const snaps = () => [NORMAL_ID, LEGACY_ID, "kf-other", "kf-bare"].map((id) => [rowSnap(id), ownedArtefacts(id)])
        .concat([[String(count("SELECT COUNT(*) AS n FROM agent_knowledge WHERE agent_id = 'kf-bare'"))] as any]);
      const before = JSON.stringify(snaps());
      const fixBefore = JSON.stringify([rowSnap(FIX), ownedArtefacts(FIX)]);
      const nowIso = new Date().toISOString();
      const paramsFor = (id: string): Record<string, unknown[]> => ({
        resetAgent: [id], deleteClaims: [id, id], deleteMagicLinks: [id, id], deletePause: [id, id],
        supersedeOrderEmailChange: [nowIso, id, id], ensureKnowledge: [id], setKnowledge: [FARM, id, id],
        retireAgent: [id], insertKnowledge: ["about", FARM, id],
      });
      const runWrite = (name: string, sql: string, id: string): number => {
        try { return db.prepare(sql).run(...paramsFor(id)[name]!).changes; } catch { return -1; }
      };
      eq(Object.keys(paramsFor("x")).sort(), Object.keys(W).sort(), "pins-0: every write in CLAIM_FIXTURE_WRITES is exercised");
      const who: Record<string, string> = { [NORMAL_ID]: "a real producer's", [LEGACY_ID]: "the order fixture's", "kf-bare": "a knowledge-less real producer's" };
      for (const id of [NORMAL_ID, LEGACY_ID, "kf-bare"]) {
        for (const [name, sql] of Object.entries(W)) {
          eq(runWrite(name, sql, id), 0, `pins-1: ${name} run with ${who[id]} id changes 0 rows (marker pin)`);
        }
      }
      eq(JSON.stringify(snaps()), before, "pins-2: the real producers and the order fixture are byte-identical (claims, links, sessions, pause, pending change kept; no knowledge row created)");
      eq(JSON.stringify([rowSnap(FIX), ownedArtefacts(FIX)]), fixBefore, "pins-3: (writes with other ids never reach our fixture either)");
      // Our fixture's id (inside a transaction that is rolled back): each write
      // reaches our row only — never the other claim fixture (id pin).
      db.exec("BEGIN");
      try {
        for (const [name, sql] of Object.entries(W)) {
          if (name === "insertKnowledge") continue; // our knowledge row exists — the INSERT is the create path's
          ok(runWrite(name, sql, FIX) >= 0, `pins-4: ${name} runs with our fixture's id`);
        }
        eq(JSON.stringify(snaps()), before, "pins-5: … and leaves the other claim fixture (and every other row) untouched");
      } finally {
        db.exec("ROLLBACK");
      }
      eq(JSON.stringify([rowSnap(FIX), ownedArtefacts(FIX)]), fixBefore, "pins-6: (rolled back)");
      // Two claim fixtures: the endpoint names them and refuses.
      const r = await postCf({ farm_email: FARM, apply: true });
      eq([r.status, r.body?.error], [409, "multiple_claim_test_fixtures"], "pins-7: two claim-fixture rows → 409, caller must name one");
      eq(JSON.stringify(snaps()), before, "pins-8: … nothing written");
      db.prepare("DELETE FROM agents WHERE id IN ('kf-other', 'kf-bare')").run();
      for (const t of ["agent_claims", "magic_links", "owner_profile_pause", "owner_order_email_change"]) db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(NORMAL_ID);
      db.prepare("UPDATE agents SET claimed_at = NULL, claimed_via = NULL WHERE id = ?").run(NORMAL_ID);
    }

    // ══ (claim) selger.html → code to farm_email → verify → owner ═════════
    const script = inlineScript("selger.html", "function escHtml");
    const infoCalls: Array<{ id: string; token: string; status: number }> = [];
    const pageApi: FetchStub = async (url: string, o?: { method?: string }) => {
      const oo = (o ?? {}) as { body?: string; headers?: Record<string, string> };
      const body = JSON.parse(oo.body ?? "{}");
      let m = url.match(/\/api\/marketplace\/agents\/([^/]+)\/info$/);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const token = (oo.headers ?? {})["X-Claim-Token"] ?? "";
        const r = await info(id, token ? { "x-claim-token": token } : {});
        infoCalls.push({ id, token, status: r.status });
        return jsonResponse(r.body, r.status);
      }
      if (url.endsWith("/api/marketplace/auth/login")) {
        const r = await invoke(H.authLogin, makeReq({ body }));
        return jsonResponse(r.body, r.status);
      }
      m = url.match(/\/api\/marketplace\/agents\/([^/]+)\/claim(\/verify|\/resend)?$/);
      if (!m) return jsonResponse({ success: false }, 404);
      const h = m[2] === "/verify" ? H.verify : m[2] === "/resend" ? H.resend : H.claim;
      const r = await invoke(h, makeReq({ params: { id: decodeURIComponent(m[1]!) }, body }));
      return jsonResponse(r.body, r.status);
    };
    function track(page: any, id: string, hidden: boolean): () => boolean {
      const set = new Set<string>(hidden ? ["hidden"] : []);
      page.el(id).classList = {
        add: (c: string) => { set.add(c); }, remove: (c: string) => { set.delete(c); },
        toggle: (c: string, on?: boolean) => { if (on ?? !set.has(c)) set.add(c); else set.delete(c); }, contains: (c: string) => set.has(c),
      };
      return () => set.has("hidden");
    }
    function openSelger(id: string) {
      const page = runPage("", pageApi, { pathname: "/selger", search: `?agent=${id}` });
      const map = new Map<string, string>();
      page.context.localStorage = { getItem: (k: string) => (map.has(k) ? map.get(k)! : null), setItem: (k: string, v: unknown) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); } };
      const step2bHidden = track(page, "claimStep2b", true);
      track(page, "claimStep2", true);
      vm.runInContext(script, page.context, { filename: "selger.html#test-claim-fixture" });
      return { page, codeStepShown: () => !step2bHidden() };
    }
    async function requestViaPage(p: ReturnType<typeof openSelger>, email: string) {
      p.page.el("btnSingleStoreClaim").click();
      p.page.el("claimName").value = "Ola Testeier";
      p.page.el("claimEmail").value = email;
      p.page.el("btnRequestClaim").click();
      await settle();
    }
    const claimsOf = (id: string): any[] => db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? ORDER BY created_at, id").all(id) as any[];
    let firstClaimToken = "";
    let sessionToken = "";
    {
      const p = openSelger(FIX);
      await settle();
      eq(p.page.el("singleStore").style.display, "", "claim-1: /selger?agent=<fixture> shows the single store (the REAL GET /info serves the armed fixture)");
      eq(p.page.el("singleStoreName").textContent, "Kravtest (skjult)", "claim-2: … with the fixture's name");
      eq(infoCalls.filter((c) => c.id === FIX).map((c) => c.status), [200], "claim-3: … from one 200 on /info");

      const mailsBefore = mails.length;
      await requestViaPage(p, CLAIMANT);
      eq(mails.length, mailsBefore + 1, "claim-4: «Dette er min butikk» sends one code mail");
      eq(mails[mails.length - 1]?.to, FARM, "claim-5: … to farm_email (rule 1), not to the address the claimant typed");
      const code = codeIn(mails[mails.length - 1]);
      ok(/^\d{6}$/.test(code), "claim-6: … carrying a six-digit code");
      const c0 = claimsOf(FIX)[0];
      eq([c0?.status, c0?.code_sent_to, c0?.claimant_email], ["code_sent", FARM, CLAIMANT], "claim-7: the claim row: code_sent to the farm address, typed address kept");
      eq(p.codeStepShown(), true, "claim-8: the page moves to the code step");

      // No gate exemption: the resend wait and rule 4 hold for the fixture.
      let r = await resend(FIX, c0.id);
      eq([r.status, r.body?.data?.reason], [429, "too_early"], "claim-9: «Send koden på nytt» within 10 minutes → too_early, as for any profile");
      r = await claim(FIX, { name: "Kari", email: STRANGER });
      eq([r.status, mails.length], [429, mailsBefore + 1], "claim-10: another claimant within the window → 429 (rule 4), no mail");

      p.page.el("verifyCode").value = code;
      p.page.el("btnVerifyClaim").click();
      await settle();
      const c1 = claimsOf(FIX).find((c) => c.id === c0.id);
      eq(c1?.status, "verified", "claim-11: the right code on the page verifies the claim");
      const agent = db.prepare("SELECT is_verified, claimed_via, claimed_at IS NOT NULL AS claimed FROM agents WHERE id = ?").get(FIX);
      eq(agent, { is_verified: 1, claimed_via: "claim", claimed: 1 }, "claim-12: … the profile is owned (claimed_at, claimed_via 'claim', badge)");
      eq(c1?.claimant_email, FARM, "claim-13: … the owner is bound to the farm address the code went to");
      firstClaimToken = String(c1?.claim_token ?? "");
      // The owner dashboard (selger.html:1733) loads /info with X-Claim-Token.
      p.page.runTimers(1500);
      await settle();
      const dash = infoCalls.filter((c) => c.id === FIX && c.token === firstClaimToken);
      eq(dash.map((c) => c.status), [200], "claim-14: the dashboard's /info with X-Claim-Token answers 200 for the fixture");
      r = await info(FIX, { "x-claim-token": firstClaimToken });
      eq([r.status, r.body?.data?.agent?.isClaimed, r.body?.data?.agent?.id], [200, true, FIX], "claim-15: GET /info (owner read) shows the claimed fixture");

      // An owner login and session (magic link → used = 1 → a session row).
      const ml = knowledgeService.createMagicLink(FARM);
      eq([ml.success, ml.agentId], [true, FIX], "claim-16: the owner can ask for a login link with the farm address");
      const v = knowledgeService.verifyMagicLink(String(ml.token));
      eq(v.success, true, "claim-17: … and log in");
      sessionToken = String(ml.token);
      eq(verifyOwnerSession(makeReq({ headers: { authorization: `Bearer ${sessionToken}` } })).agentId, FIX, "claim-18: … which is a valid owner session for the fixture");
      db.prepare("INSERT INTO owner_profile_pause (agent_id, paused_at) VALUES (?, ?)").run(FIX, new Date().toISOString());
      db.prepare(
        `INSERT INTO owner_order_email_change (token_hash, agent_id, new_email, requested_at, expires_at) VALUES ('th-fix', ?, 'ny@kravtest.example.test', ?, ?)`,
      ).run(FIX, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }

    // ══ (reset) arm after a verified claim → a fresh unclaimed profile ═════
    {
      const before = ownedArtefacts(FIX);
      ok(before.claims >= 1 && before.magic >= 1 && before.pause === 1 && before.pending === 1, "reset-0: setup — claims, links/sessions, a pause and a pending change exist");
      let r = await postCf({ farm_email: FARM });
      const fields = (r.body?.changes ?? []).map((c: any) => c.field);
      for (const f of ["is_verified", "claimed_at", "claimed_via", "agent_knowledge.data_source", "agent_claims", "magic_links", "owner_profile_pause", "owner_order_email_change.pending"]) {
        ok(fields.includes(f), `reset-1: the dry-run plan lists ${f}`);
      }
      ok(!fields.includes(EMAIL_FIELD_NAME), "reset-2: … not the e-mail (unchanged)");
      eq(ownedArtefacts(FIX), before, "reset-3: the dry-run wrote nothing");
      const auditBefore = auditCount();
      r = await postCf({ farm_email: FARM, apply: true });
      eq([r.status, r.body?.target], [200, "existing"], "reset-4: apply resets the existing fixture");
      eq(ownedArtefacts(FIX), { claims: 0, magic: 0, pause: 0, pending: 0 }, "reset-5: claims, magic links/sessions and the pause are gone; the pending change is closed");
      eq(db.prepare("SELECT outcome FROM owner_order_email_change WHERE token_hash = 'th-fix'").get(), { outcome: "superseded" }, "reset-6: … the pending order-e-mail change is superseded");
      eq(db.prepare("SELECT a.is_active, a.is_verified, a.claimed_at, a.claimed_via, k.email, k.data_source FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?").get(FIX),
        { is_active: 1, is_verified: 0, claimed_at: null, claimed_via: null, email: FARM, data_source: "auto" }, "reset-7: unowned, no badge, farm address in place");
      eq(verifyOwnerSession(makeReq({ headers: { authorization: `Bearer ${sessionToken}` } })).valid, false, "reset-8: the previous owner's session no longer works");
      eq(knowledgeService.getClaimByToken(firstClaimToken), null, "reset-9: … nor its claim token");
      eq(auditCount() - auditBefore, r.body?.audit_rows, "reset-10: one audit row per change");
      eq(r.body?.claim_check?.has_owner, false, "reset-11: claim_check: no owner");
      r = await info(FIX);
      eq([r.status, r.body?.data?.agent?.isClaimed, r.body?.data?.agent?.isVerified], [200, false, false], "reset-12: GET /info shows an unclaimed, unverified store again");
      eq(knowledgeService.isAgentClaimed(FIX), false, "reset-13: no verified claim remains");

      // A new claim works again on the page.
      const p = openSelger(FIX);
      await settle();
      eq(p.page.el("singleStore").style.display, "", "reset-14: the single-store card is back");
      const mailsBefore = mails.length;
      await requestViaPage(p, CLAIMANT);
      eq([mails.length, mails[mails.length - 1]?.to], [mailsBefore + 1, FARM], "reset-15: a new claim sends a new code to farm_email");
      p.page.el("verifyCode").value = codeIn(mails[mails.length - 1]);
      p.page.el("btnVerifyClaim").click();
      await settle();
      eq(claimsOf(FIX).filter((c) => c.status === "verified").length, 1, "reset-16: … and verifies");

      // K5: reset, a queued claim, Daniel approves → «Profilen til X er nå din».
      r = await postCf({ farm_email: FARM, apply: true });
      eq(ownedArtefacts(FIX).claims, 0, "k5-1: reset again");
      const q = await claim(FIX, { name: "Ola", email: CLAIMANT, listedEmailWrong: true });
      eq([q.status, q.body?.data?.reason], [202, "listed_email_wrong"], "k5-2: the «feil e-post» box queues the claim");
      const before5 = mails.length;
      const a = await adminPost(H.approve, { claimId: q.body?.data?.claimId });
      eq([a.status, a.body?.agentId, a.body?.loginLinkSent], [200, FIX, true], "k5-3: POST /admin/agents/claim-review-approve approves it");
      eq(mails.slice(before5).map((m) => [m.to, m.subject.startsWith("Profilen til Kravtest (skjult) er nå din")]), [[CLAIMANT, true]],
        "k5-4: «Profilen til Kravtest (skjult) er nå din» goes to the approved address");
      ok(count("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = ?", FIX) >= 1, "k5-5: … with an owner-portal login link");
      r = await postCf({ farm_email: FARM, apply: true });
      eq([ownedArtefacts(FIX), (db.prepare("SELECT claimed_at FROM agents WHERE id = ?").get(FIX) as any).claimed_at], [{ claims: 0, magic: 0, pause: 0, pending: 0 }, null],
        "k5-6: reset removes the approved claim and its login link");
    }

    // ══ (retire) ═══════════════════════════════════════════════════════════
    {
      let r = await postCf({ mode: "retire", apply: true });
      eq([r.status, r.body?.changes], [200, [{ field: "is_active", old: "1", new: "0" }]], "retire-1: retire sets is_active 0");
      eq((await info(FIX)).status, 404, "retire-2: GET /info no longer serves a retired fixture");
      const p = openSelger(FIX);
      await settle();
      ok(p.page.el("singleStore").style.display !== "", "retire-3: /selger?agent=<id> shows no store card for it");
      const auditBefore = auditCount();
      r = await postCf({ mode: "retire", apply: true });
      eq([r.status, r.body?.changes, auditCount()], [200, [], auditBefore], "retire-4: retire again is a no-op (no audit row)");
      r = await postCf({ farm_email: FARM, apply: true });
      eq([r.status, (db.prepare("SELECT is_active FROM agents WHERE id = ?").get(FIX) as any).is_active, (await info(FIX)).status], [200, 1, 200],
        "retire-5: arm re-arms it and /info serves it again");
    }

    // ══ (hidden) every public surface; control first ═══════════════════════
    {
      // Listable data like seedProducer's, so the control phase is not vacuous.
      db.prepare(
        `UPDATE agents SET name = ?, description = ?, url = ?, lat = ?, lng = ?, city = 'Oslo', categories = '["vegetables"]', tags = '[]',
                trust_score = 0.7, is_verified = 1, order_notifications_opt_in = 1, order_notification_email = ?, contact_email = ? WHERE id = ?`,
      ).run(CF_LIST_NAME, "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
        `https://${FARM_HOST}`, OSLO.lat, OSLO.lng, FARM, FARM, FIX);
      db.prepare(
        `UPDATE agent_knowledge SET field_provenance = ?, website = ?, about = ?, products = ?, verification_status = 'verified', verified_second_line = 0,
                enrichment_status = 'rich', url_last_status = 200, url_last_probed = datetime('now'), last_verified_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = ?`,
      ).run(JSON.stringify({ categories: [{ source_type: "website_homepage", source_url: `https://${FARM_HOST}` }] }), `https://${FARM_HOST}`,
        "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
        JSON.stringify([{ name: "Listepoteter", price: "30 kr/kg", category: "vegetables" }]), FIX);
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url, availability_source)
         VALUES ('prod-kf-fix', ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg', 'admin_producer_confirmed')`,
      ).run(FIX);
      db.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at, is_owner, traffic_category)
         VALUES (?, ?, 'Oslo', 'search', datetime('now'), 0, 'human')`,
      ).run(FIX, CF_LIST_NAME);

      const ID_BY_NAME: Array<[string, string]> = [[NORMAL_ID, NORMAL_NAME], [LEGACY_ID, LEGACY_NAME], [FIX, CF_LIST_NAME]];
      const ALL = ID_BY_NAME.map(([id]) => id);
      const idsInText = (text: unknown) => {
        const t = String(typeof text === "string" ? text : JSON.stringify(text ?? ""));
        return ID_BY_NAME.filter(([, name]) => t.includes(name)).map(([id]) => id);
      };
      const idsInSitemap = (xml: string) => ID_BY_NAME.filter(([, name]) => xml.includes(`/produsent/${slugify(name)}<`)).map(([id]) => id);
      const ok200 = async (h: Function, id: string) => (await invoke(h, makeReq({ params: { id } }))).status === 200;
      async function snapshot(): Promise<Record<string, string[]>> {
        clearRegistryCaches();
        const s: Record<string, string[]> = {};
        s.search = ((await invoke(H.search, makeReq({ query: { q: "Kravliste", heleNorge: "true" } }))).body?.results ?? []).map((r: any) => r.agent.id);
        s.discover = ((await invoke(H.discover, makeReq({ body: { role: "producer" } }))).body?.results ?? []).map((r: any) => r.agent.id);
        s.lokal_search = idsInText(await toolText("lokal_search", { query: "Kravliste" }));
        s.agents = ((await invoke(H.agents, makeReq({}))).body?.agents ?? []).map((a: any) => a.id);
        s.catalog_feed = ((await invoke(H.feed, makeReq({}))).body?.items ?? []).map((i: any) => i.seller.agent_id);
        s.acp_feed_csv = idsInText((await invoke(H.acp, makeReq({}))).body);
        s.catalog_offers = ((await invoke(H.offers, makeReq({ query: { q: "listepoteter", lat: String(OSLO.lat), lng: String(OSLO.lng) } }))).body?.offers ?? [])
          .map((o: any) => o.producer.agent_id);
        const fo = JSON.parse(await toolText("lokal_find_offers", { items: ["listepoteter"], lat: OSLO.lat, lng: OSLO.lng }) || "[]");
        s.lokal_find_offers = (fo[0]?.offers ?? []).map((o: any) => o.producer.agent_id);
        s.llms_full_txt = idsInText((await invoke(H.llmsFull, makeReq({}))).body);
        seoMod.invalidateSitemapCache();
        s.sitemap = idsInSitemap(seoMod.buildSitemapXml());
        s.produsent_page = [];
        for (const [id, name] of ID_BY_NAME) {
          if ((await invoke(H.produsent, makeReq({ params: { slug: slugify(name) } }))).status === 200) s.produsent_page.push(id);
        }
        s.homepage = idsInText((await invoke(H.home, makeReq({}))).body);
        s.verifisert_av_eier = idsInText((await invoke(H.verified, makeReq({}))).body);
        s.city_page = idsInText((await invoke(H.city, makeReq({ params: { city: "oslo" } }))).body);
        s.find_match = ((await invoke(H.findMatch, makeReq({ query: { name: "Kravliste" } }))).body?.matches ?? []).map((m: any) => m.id);
        s.outreach_pool_view = (db.prepare("SELECT agent_id FROM outreach_ready_pool").all() as Array<{ agent_id: string }>).map((r) => r.agent_id);
        s.outreach_candidates = (computeOutreachCandidates(initMod.getDb(), { mode: "first", cooldownDays: 60, limit: 100 } as any).candidates ?? [])
          .map((c: any) => c.agent_id);
        s.top_producers = analyticsService.getTopProducers(20, 24 * 365).map((p) => p.agentId);
        for (const [key, h] of [["card", H.card], ["vcard", H.vcard], ["trust", H.trust], ["agent_stats", H.agentStats]] as Array<[string, Function]>) {
          s[key] = [];
          for (const id of ALL) if (await ok200(h, id)) s[key].push(id);
        }
        s.verifier_pickBatch = verifier.pickBatch(db, 100).map((r: any) => r.id);
        s.verifier_pickBatchBiased = verifier.pickBatchBiased(db, 100).map((r: any) => r.id);
        s.verifier_pickByIds = verifier.pickByIds(db, ALL).map((r: any) => r.id);
        s.__info = [];
        for (const id of ALL) if (await ok200(H.info, id)) s.__info.push(id);
        s.__a2a_card = [String((await invoke(H.a2a, makeReq({}))).body?.description ?? "")];
        const reg = (await invoke(H.apiStats, makeReq({}))).body?.data?.registry ?? {};
        s.__api_stats = [`${reg.totalAgents}/${reg.activeProducers}`];
        return s;
      }

      db.prepare("UPDATE agents SET catalog_hidden = 0 WHERE id = ?").run(FIX);
      const ctl = await snapshot();
      db.prepare("UPDATE agents SET catalog_hidden = 1 WHERE id = ?").run(FIX);
      const hid = await snapshot();
      for (const [surface, ids] of Object.entries(ctl)) {
        if (surface.startsWith("__")) continue;
        ok(ids.includes(NORMAL_ID), `hidden-control: the normal row is on ${surface} (got ${JSON.stringify(ids)})`);
        ok(ids.includes(FIX), `hidden-control: the fixture's data WOULD show on ${surface} when not hidden — the check below is not vacuous (got ${JSON.stringify(ids)})`);
      }
      for (const [surface, ids] of Object.entries(hid)) {
        if (surface.startsWith("__")) continue;
        ok(ids.includes(NORMAL_ID), `hidden: the normal row is still on ${surface}`);
        ok(!ids.includes(FIX), `hidden: the claim fixture is ABSENT from ${surface} (got ${JSON.stringify(ids)})`);
        ok(!ids.includes(LEGACY_ID), `hidden: the order fixture is absent from ${surface}`);
      }
      eq(hid.__info, [NORMAL_ID, FIX], "hidden-info: GET /info serves the normal row and the armed claim fixture — not the order fixture");
      eq(hid.__api_stats[0], "1/1", "hidden-stats: /api/stats counts only the normal row");
      eq(ctl.__api_stats[0], "2/2", "hidden-stats-control: … and would count the fixture if it were not hidden");
      ok(/\b1\+/.test(hid.__a2a_card[0]), `hidden-a2a: the /a2a card does not count the fixture (${hid.__a2a_card[0]})`);
      {
        const page = await invoke(H.produsent, makeReq({ params: { slug: slugify(CF_LIST_NAME) } }));
        ok(page.status === 404 && !String(page.body).includes(CF_LIST_NAME), "hidden-page: /produsent/<fixture-slug> → 404 without its name");
      }

      // ?as_public=1 (admin «Vis som offentlig»): opens the ORDER fixture only.
      const asPub = await visibility.runAsPublicView(() => snapshot());
      ok(asPub.search.includes(LEGACY_ID) && asPub.card.includes(LEGACY_ID), "as-public-control: the view is active (the order fixture shows on search and card)");
      for (const [surface, ids] of Object.entries(asPub)) {
        if (surface.startsWith("__")) continue;
        ok(!ids.includes(FIX), `as-public: the claim fixture stays ABSENT from ${surface} under ?as_public=1`);
      }

      // The by-id flag on: /info still serves the armed fixture, card does not.
      process.env.OWNER_VISIBILITY_ENFORCE_BY_ID = "1";
      eq([(await info(FIX)).status, (await invoke(H.card, makeReq({ params: { id: FIX } }))).status, (await info(LEGACY_ID)).status], [200, 404, 404],
        "flag-on: /info 200 for the claim fixture, card 404, /info 404 for the order fixture");
      db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(FIX);
      eq((await info(FIX)).status, 404, "flag-on: a retired claim fixture is not served");
      db.prepare("UPDATE agents SET is_active = 1 WHERE id = ?").run(FIX);
      // lokal_info's allowCatalogHidden is the order fixture's (order flow by id): never the claim fixture's.
      ok((await toolText("lokal_info", { agentId: FIX })).startsWith("Fant ingen produsent"), "flag-on: MCP lokal_info by id does not serve the claim fixture");
      ok((await toolText("lokal_info", { agentId: LEGACY_ID })).includes(LEGACY_NAME), "flag-on: … while the order fixture stays reachable by id (its order flow)");
      delete process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;

      // Back to the plain fixture for the pipeline section.
      db.prepare("DELETE FROM products WHERE id = 'prod-kf-fix'").run();
      db.prepare("DELETE FROM analytics_agent_views WHERE agent_id = ?").run(FIX);
      db.prepare("UPDATE agents SET name = 'Kravtest (skjult)', is_verified = 0, contact_email = 'kravtest@test-claim-fixture.invalid', lat = NULL, lng = NULL WHERE id = ?").run(FIX);
      db.prepare("UPDATE agent_knowledge SET website = NULL, verification_status = 'unverified' WHERE agent_id = ?").run(FIX);
      clearRegistryCaches();
    }

    // ══ (pipes) the enrichment lanes that could write its e-mail skip it ════
    {
      const fetchCalls: string[] = [];
      (globalThis as any).fetch = async (u: unknown) => { fetchCalls.push(String(u)); return { ok: false, status: 599, json: async () => ({}), text: async () => "" }; };
      bssMod.__setRfbBrregSelfSufficiencyFetchForTesting((async (u: unknown) => { fetchCalls.push(String(u)); return { ok: false, status: 599, json: async () => ({}) }; }) as any);
      const wdSearched: string[] = [];
      wdMod.__setRfbWdSearchForTesting(async (q: string) => { wdSearched.push(q); return []; });
      const ids = (pred: string) => (db.prepare(`SELECT a.id FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE ${pred}`).all() as Array<{ id: string }>).map((r) => r.id);

      // Brreg self-sufficiency + org-nr backfill predicates (batch selection).
      db.prepare("UPDATE agents SET catalog_hidden = 0 WHERE id = ?").run(FIX);
      const bssCtl = ids(bssMod.rfbBssCandidateWhereSql(db));
      const orgCtl = ids(adminAgentsMod.agentsOrgNrBackfillCandidateWhereSql(db));
      db.prepare("UPDATE agents SET catalog_hidden = 1 WHERE id = ?").run(FIX);
      ok(bssCtl.includes(FIX) && orgCtl.includes(FIX), "pipes-control: an unclaimed webless producer without org_nr IS a Brreg / org-nr candidate (not vacuous)");
      ok(!ids(bssMod.rfbBssCandidateWhereSql(db)).includes(FIX), "pipes-1: rfbBssCandidateWhereSql never selects the hidden claim fixture");
      ok(ids(bssMod.rfbBssCandidateWhereSql(db)).includes(NORMAL_ID), "pipes-1b: … while a normal candidate stays");
      ok(!ids(adminAgentsMod.agentsOrgNrBackfillCandidateWhereSql(db)).includes(FIX), "pipes-2: agentsOrgNrBackfillCandidateWhereSql never selects it");
      let r = await adminPost(H.bss, { agentIds: [FIX] });
      eq([r.status, r.body?.batch_size], [200, 0], "pipes-3: POST /admin/rfb-brreg-selfsufficiency { agentIds: [fixture] } → no target");
      r = await adminPost(H.orgNrBackfill, { agentIds: [FIX] });
      eq([r.status, r.body?.batch_size], [200, 0], "pipes-4: POST /admin/agents/org-nr-backfill { agentIds: [fixture] } → no target");

      // Website discovery: agentIds, blank batch, and the external-candidate intake.
      db.prepare("UPDATE agent_knowledge SET verification_status = 'pending_verify' WHERE agent_id = ?").run(FIX);
      r = await adminPost(H.wd, { agentIds: [FIX] });
      ok(r.status === 200 && (r.body?.not_found ?? []).includes(FIX), "pipes-5: POST /admin/rfb-website-discovery { agentIds: [fixture] } → not_found");
      r = await adminPost(H.wd, {});
      ok(r.status === 200 && !JSON.stringify(r.body).includes(FIX) && wdSearched.length === 0, "pipes-6: the blank batch (fixture pending_verify, webless) never picks it");
      const ext = await wdMod.evaluateRfbWebsiteCandidate(db, { agentId: FIX, url: "https://kravtest.invalid" }, new Set(), new Set(), { attempted: 0, verified: 0 }, "test-batch");
      eq((ext as any).outcome, "not_found", "pipes-7: an external website candidate for it → not_found");
      db.prepare("UPDATE agent_knowledge SET verification_status = 'unverified' WHERE agent_id = ?").run(FIX);

      // Contact extraction: a website (an owner may have set one) and a dead placeholder address.
      db.prepare("UPDATE agent_knowledge SET website = 'https://kravtest.invalid', field_provenance = ? WHERE agent_id = ?")
        .run(JSON.stringify({ contact_email_dns_check: { live: 0 } }), FIX);
      const rawCx = (db.prepare(cxMod.rfbCxSelectSql(cxMod.RFB_CX_ELIGIBLE_WHERE)).all() as Array<{ id: string }>).map((x) => x.id);
      ok(rawCx.includes(FIX), "pipes-control: with a website and a dead contact address it IS in the raw extraction cohort (not vacuous)");
      cxMod.__setRfbCxLockForTesting(null);
      cxMod.__resetRfbCxCooldownForTesting();
      r = await adminPost(H.cx, { agentIds: [FIX] });
      eq([r.status, r.body?.scanned, (r.body?.results ?? []).map((x: any) => [x.agent_id, x.outcome])], [200, 0, [[FIX, "not_found"]]],
        "pipes-8: POST /admin/rfb-contact-extraction { agentIds: [fixture] } → not_found, nothing scanned");
      r = await adminPost(H.cx, {});
      eq([r.status, r.body?.scanned], [200, 0], "pipes-9: … and the batch never picks it");
      // Backfill mode: blank listed e-mail + a DNS-live contact address.
      db.prepare("UPDATE agent_knowledge SET email = NULL, field_provenance = ? WHERE agent_id = ?")
        .run(JSON.stringify({ contact_email_dns_check: { live: 1 } }), FIX);
      r = await adminPost(H.cx, { mode: "backfill_from_contact_email", agentIds: [FIX] });
      eq([r.status, r.body?.scanned, (r.body?.results ?? []).map((x: any) => x.outcome)], [200, 0, ["not_found"]], "pipes-10: backfill mode by id → not_found");
      r = await adminPost(H.cx, { mode: "backfill_from_contact_email" });
      eq([r.status, r.body?.scanned], [200, 0], "pipes-11: backfill batch never picks it");
      eq(fetchCalls, [], "pipes-12: no lane made a network call for it");
      // arm restores the farm address after anything an owner or a lane changed.
      r = await postCf({ farm_email: FARM, apply: true });
      eq((db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(FIX) as any).email, FARM, "pipes-13: arm puts farm_email back in agent_knowledge.email");
    }

    // ══ the order fixture is byte-identical after everything ═══════════════
    eq(rowSnap(LEGACY_ID), legacyBefore, "tp-6: the order fixture's row is byte-identical after every claim-fixture call");
    eq(ownedArtefacts(LEGACY_ID), legacyArtefactsBefore, "tp-7: … and its claims, links and sessions are untouched");
  } catch (err) {
    failed++;
    failures.push(`admin-test-claim-fixture: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    (globalThis as any).fetch = realFetch;
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    try { cfMod?.__setTestClaimFixtureDbForTesting(null); } catch { /* ignore */ }
    try { tpMod?.__setTestProducerDbForTesting(null); } catch { /* ignore */ }
    try { wdMod?.__setRfbWdSearchForTesting(null); } catch { /* ignore */ }
    try { bssMod?.__setRfbBrregSelfSufficiencyFetchForTesting(undefined); } catch { /* ignore */ }
    try { cxMod?.__setRfbCxLockForTesting(null); cxMod?.__resetRfbCxCooldownForTesting(); } catch { /* ignore */ }
    try { geo.__setGeocodingFetchForTesting(undefined); geo.__clearGeocodeCacheForTesting(); } catch { /* ignore */ }
    clearRegistryCaches();
    if (prevDb) initMod.__setDbForTesting(prevDb);
    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

const EMAIL_FIELD_NAME = "agent_knowledge.email";

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  console.log("── dev-request 2026-11-01-rfb-kravflyt-tal-eiere-fra-e-post AC6: POST /admin/test-claim-fixture ──");
  runAdminTestClaimFixtureTests({ log: true }).then((r) => {
    console.log(`\nadmin-test-claim-fixture: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

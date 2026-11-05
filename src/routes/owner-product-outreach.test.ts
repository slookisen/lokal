/**
 * owner-product-outreach.test.ts — dev-request 2026-10-21-rfb-produktimport-
 * fra-egen-nettside, Skive 3b-2 (owner side of the outreach pre-extraction).
 *
 *   flag   PRODUCT_IMPORT_OUTREACH_ENABLED off → landing GET/POST and the
 *          admin links/log endpoints 404, nothing written.
 *   links  admin key required; one signed link per recipient with ≥ 1
 *          eligible candidate; 0-candidate recipients get no link.
 *   token  tampered / expired / issued in the future / another agent's
 *          token → neutral page, no candidates.
 *   AC19   GET changes nothing in products / agent_knowledge (only the
 *          append-only 'opened' row); no login → no candidates (login page +
 *          return cookie); segment B (session, profile not taken over) → no
 *          list until the claim, then the list.
 *   K4     (2026-11-01-rfb-kravflyt-tal-eiere-fra-e-post) no session on a
 *          profile without a verified owner (customer rule) → «Ta over
 *          profilen først» with /selger?agent=, no candidates, nothing but the
 *          'opened' row; with an owner (also is_verified = 0) → login as
 *          before; after the claim the same link → login; flag off / bad
 *          token unchanged.
 *   AC20  «Bekreft og legg inn» publishes only the ticked rows with the
 *          edited values, manual products kept; without «på lager» none is
 *          orderable (isRowOrderableForRealOrder false), with it they are.
 *   cross  a token for agent A never publishes agent B's run; POST guards
 *          (no session, cross-site, non-claimant) refuse and write nothing.
 *   AC21   fixed clock: 8 days after the extraction the page re-extracts
 *          (owner fetch, counted in the 3/day limit) before the list is
 *          shown; 6 days → no re-extraction; limit reached → the previous
 *          list with its fetch date.
 *   log    per recipient: extracted, opened, confirmed (count), in_stock.
 *   login  the /eier magic link returns to the landing page (cookie), only
 *          for this agent's landing path.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch (no network); fixed clocks. Env restored in finally.
 * Exported runOwnerProductOutreachTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-product-outreach.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "PRODUCT_IMPORT_OUTREACH_ENABLED", "PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY", "PRODUCT_IMPORT_ENABLED", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY",
  "UNSUBSCRIBE_TOKEN_SECRET", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "APP_URL",
];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const KEY = "test-admin-key-outreach";
const CAMPAIGN = "mine-valg-pilot";

type FakeRoute = { status?: number; body: string; contentType?: string };
const ROBOTS_OPEN: FakeRoute = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };
const HTML = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

export async function runOwnerProductOutreachTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => undefined; console.error = () => undefined; }

  let oi: typeof import("../services/product-import/owner-import") | null = null;
  let op: typeof import("../services/product-import/outreach-prepare") | null = null;
  let ol: typeof import("../services/product-import/outreach-landing") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    process.env.ADMIN_KEY = KEY;
    oi = require("../services/product-import/owner-import") as typeof import("../services/product-import/owner-import");
    op = require("../services/product-import/outreach-prepare") as typeof import("../services/product-import/outreach-prepare");
    ol = require("../services/product-import/outreach-landing") as typeof import("../services/product-import/outreach-landing");
    const robots = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
    const landingRouter = (require("./owner-product-outreach") as any).default;
    const adminRouter = (require("./admin-product-import") as any).default;
    const portalRouter = (require("./owner-portal") as any).default;
    const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { isRowOrderableForRealOrder } = require("../services/cart-service") as typeof import("../services/cart-service");
    robots.__clearRobotsCacheForTesting();
    oi.__forgetOwnerFetchJobsForTesting();

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = {
      get: handlerOf(landingRouter, "/eier/:agentId/varer/forslag", "get"),
      post: handlerOf(landingRouter, "/eier/:agentId/varer/forslag", "post"),
      links: handlerOf(adminRouter, "/prepare/:campaign/links", "get"),
      log: handlerOf(adminRouter, "/prepare/:campaign/log", "get"),
      verify: handlerOf(portalRouter, "/magic-link-verify", "get"),
    };
    type Res = { status: number; body: any; location?: string; cookies: Record<string, string>; cleared: string[] };
    const invoke = (handler: Function, o: {
      params?: Record<string, string>; token?: string; body?: any; headers?: Record<string, string>; query?: Record<string, string>;
      key?: string | null; cookies?: Record<string, string>;
    }) =>
      new Promise<Res>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        if (typeof o.key === "string") headers["x-admin-key"] = o.key;
        const req: any = {
          method: "GET", params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: o.cookies || {}, ip: "127.0.0.1",
          get: (n: string) => headers[n.toLowerCase()],
        };
        let status = 200;
        let settled = false;
        const cookies: Record<string, string> = {};
        const cleared: string[] = [];
        const settle = (r: Omit<Res, "cookies" | "cleared">) => { if (!settled) { settled = true; resolve({ ...r, cookies, cleared }); } };
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { settle({ status, body: b }); return res; },
          send(b: any) { settle({ status, body: b }); return res; },
          redirect(c: number, loc: string) { settle({ status: c, body: "", location: loc }); return res; },
          setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; },
          cookie(n: string, v: string) { cookies[n] = v; return res; }, clearCookie(n: string) { cleared.push(n); return res; },
        };
        try {
          const p = handler(req, res, () => settle({ status: 0, body: "next" }));
          if (p && typeof p.catch === "function") p.catch((e: any) => settle({ status: -1, body: String(e) }));
        } catch (e) { settle({ status: -1, body: String(e) }); }
      });
    const totalChanges = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const html = (r: Res) => String(r.body ?? "");

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { verified: number; claimed?: boolean; products?: unknown[] }) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, claimed_at, vertical_id, order_notifications_opt_in)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, ?, 0, 0, 0, datetime('now'), datetime('now'), ?, 'rfb', 1)`,
      ).run(id, `Gard ${id}`, `post@${id}.example.no`, `key-${id}`, o.verified, o.claimed === false ? null : "2026-10-01T00:00:00.000Z");
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, ?, 'hybrid', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, `https://${id}.no`, JSON.stringify(o.products ?? []));
      if (o.claimed !== false) {
        db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
        ).run(`claim-${id}`, id, `post@${id}.example.no`);
      }
    };
    const tokens: Record<string, string> = {};
    const session = (id: string, email = `post@${id}.example.no`, name = id) => {
      tokens[name] = `tok-${name}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${name}`, email, tokens[name], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    };
    const manual = [
      { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual" },
      { name: "Egg", category: "eggs", seasonal: false, price: "kr 55", source: "owner_manual" },
    ];
    const OWN = "po-own";
    const B = "po-b";
    const OTHER = "po-other";
    const ZERO = "po-zero";
    const STALE = "po-stale";
    const LIMIT = "po-limit";
    addAgent(OWN, { verified: 1, products: manual });
    addAgent(B, { verified: 0, claimed: false });
    addAgent(OTHER, { verified: 1 });
    addAgent(ZERO, { verified: 1 });
    addAgent(STALE, { verified: 1 });
    addAgent(LIMIT, { verified: 1 });
    const LLMA = "po-llm";
    const NOTVER = "po-notver"; // verified claim (isVerifiedOwner), but agents.is_verified = 0
    const RUNNING = "po-run";
    addAgent(LLMA, { verified: 1 });
    addAgent(NOTVER, { verified: 0 });
    addAgent(RUNNING, { verified: 1 });
    const STUCK = "po-stuck";
    addAgent(STUCK, { verified: 1 });
    // K4: not taken over and no listed e-mail (the /eier login has nowhere to send a link).
    const FREE = "po-free";
    addAgent(FREE, { verified: 0, claimed: false });
    db.prepare("UPDATE agent_knowledge SET email = NULL WHERE agent_id = ?").run(FREE);
    for (const id of [OWN, B, OTHER, ZERO, STALE, LIMIT, LLMA, NOTVER, RUNNING, STUCK]) session(id);
    session(OWN, "kollega@po-own.example.no", "own-colleague");

    const shop = (host: string, products: Array<{ title: string; handle: string; price: string }>): Record<string, FakeRoute> => ({
      [`https://${host}/robots.txt`]: ROBOTS_OPEN,
      [`https://${host}/products.json?limit=250`]: {
        contentType: "application/json",
        body: JSON.stringify({ products: products.map((p) => ({ title: p.title, handle: p.handle, variants: [{ title: "Default Title", price: p.price }] })) }),
      },
    });
    const routes: Record<string, FakeRoute> = {
      ...shop("po-own.no", [
        { title: "Lammelår", handle: "lammelar", price: "289.00" },
        { title: "Honning", handle: "honning", price: "120.00" },
        { title: "Rabarbrasaft", handle: "rabarbrasaft", price: "59.00" },
        { title: "Eplecider", handle: "eplecider", price: "149.00" },
      ]),
      ...shop("po-b.no", [{ title: "Gulrøtter", handle: "gulrotter", price: "25.00" }, { title: "Poteter", handle: "poteter", price: "30.00" }]),
      ...shop("po-other.no", [{ title: "Løk", handle: "lok", price: "20.00" }]),
      ...shop("po-zero.no", [{ title: "Eplecider", handle: "eplecider", price: "149.00" }]),
      ...shop("po-stale.no", [{ title: "Blåbærsyltetøy", handle: "syltetoy", price: "80.00" }]),
      ...shop("po-limit.no", [{ title: "Brød", handle: "brod", price: "60.00" }]),
      ...shop("po-llm.no", [{ title: "Surdeigsbrød", handle: "surdeig", price: "65.00" }]),
      ...shop("po-stuck.no", [{ title: "Rips", handle: "rips", price: "40.00" }]),
    };
    const fetchImpl = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const r = routes[url] ?? { status: 404, body: HTML("404") };
      return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    let clock = T0;
    const now = () => clock;
    op.__setOutreachDepsForTesting({ fetchImpl, llm: async () => ({ text: "[]" }), now, sleep: async () => undefined, hostIntervalMs: 0 });
    let ownerLlmCalls = 0;
    const ownerLlm = async () => {
      ownerLlmCalls++;
      return { text: JSON.stringify([{ name: "Kjøtt", price: null }, { name: "Rabarbrasaft", price: "59 kr" }]) };
    };
    oi.__setOwnerImportDepsForTesting({ fetchImpl, llm: ownerLlm, now, sleep: async () => undefined, hostIntervalMs: 0 });
    ol.__setOutreachLandingClockForTesting(now);

    // The 3b-1 pre-extraction at T0 (flag only matters for the routes).
    const started = op.startOutreachPrepare([OWN, B, OTHER, ZERO, STALE, LIMIT, LLMA, STUCK], CAMPAIGN);
    await op.__awaitOutreachPrepareForTesting(started.prepare_id);
    const prepRun = (id: string) => (db.prepare(
      "SELECT id FROM product_import_runs WHERE mode = 'outreach_prepare' AND agent_id = ? AND campaign = ?").get(id, CAMPAIGN) as { id: string }).id;
    const candId = (runId: string, name: string) =>
      (db.prepare("SELECT id FROM product_import_candidates WHERE run_id = ? AND name = ?").get(runId, name) as { id: string } | undefined)?.id ?? "";
    assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_candidates WHERE run_id = ? AND status = 'eligible'").get(prepRun(OWN)), { n: 3 },
      "fixture: three eligible candidates for the owner (alcohol rejected)");
    clock = T0 + DAY;

    const productsOf = (id: string) => (ks.knowledgeService.getKnowledge(id)?.products || []) as any[];
    const tokenFor = (id: string, issued = clock, campaign = CAMPAIGN) => ol!.makeOutreachToken(id, campaign, issued)!;
    const getPage = (id: string, t: string, session?: string, cookies?: Record<string, string>) =>
      invoke(H.get, { params: { agentId: id }, query: { t }, token: session, cookies });
    const postPage = (id: string, body: any, session?: string, headers?: Record<string, string>) =>
      invoke(H.post, { params: { agentId: id }, body, token: session, headers });
    const links = (key: string | null = KEY, campaign = CAMPAIGN) => invoke(H.links, { params: { campaign }, key });
    const logOf = (key: string | null = KEY) => invoke(H.log, { params: { campaign: CAMPAIGN }, key });
    const tOwn = tokenFor(OWN);

    // ─── flag off → 404 everywhere, nothing written ─────────────────────────
    {
      const before = totalChanges();
      const r = [await getPage(OWN, tOwn, tokens[OWN]), await postPage(OWN, { t: tOwn, run: prepRun(OWN), velg: "x" }, tokens[OWN]), await links(), await logOf()];
      assertEq(r.map((x) => x.status), [404, 404, 404, 404], "flag off: landing GET/POST, links and log answer 404");
      const k4 = await getPage(B, tokenFor(B));
      assertTrue(k4.status === 404 && !html(k4).includes('data-outreach-claim="1"') && Object.keys(k4.cookies).length === 0,
        "K4: flag off → no session on a profile without an owner still 404, no claim page, no cookie");
      assertEq(totalChanges(), before, "flag off: nothing written");
    }
    process.env.PRODUCT_IMPORT_OUTREACH_ENABLED = "1";

    // ─── Links (admin) ──────────────────────────────────────────────────────
    let linkOwn = "";
    {
      assertEq((await links(null)).status, 403, "links: no admin key → 403");
      assertEq((await links("wrong")).status, 403, "links: wrong admin key → 403");
      assertEq((await links(KEY, "no-such-campaign")).status, 404, "links: unknown campaign → 404");
      const before = totalChanges();
      const r = await links();
      assertEq(totalChanges(), before, "links: generating links writes nothing");
      const ids = (r.body.recipients as any[]).map((x) => x.agent_id);
      assertTrue(r.status === 200 && ids.includes(OWN) && ids.includes(B) && ids.includes(OTHER), "links: recipients with candidates get a link");
      assertTrue(!ids.includes(ZERO) && (r.body.without_link as any[]).some((x) => x.agent_id === ZERO && x.candidate_count === 0 && x.reason === "no_candidates"),
        "links: a recipient with 0 candidates gets no link");
      const own = (r.body.recipients as any[]).find((x) => x.agent_id === OWN);
      assertEq(own.candidate_count, 3, "links: candidate count per recipient");
      assertTrue(/^https:\/\/rettfrabonden\.com\/eier\/po-own\/varer\/forslag\?t=po1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(own.url), "links: URL is the landing path with a po1 token");
      linkOwn = decodeURIComponent(own.url.split("?t=")[1]);
      assertEq(ol.verifyOutreachToken(linkOwn, OWN).state, "valid", "links: the token verifies for its agent");
      delete process.env.ADMIN_KEY;
      process.env.ANALYTICS_ADMIN_KEY = KEY;
      process.env.UNSUBSCRIBE_TOKEN_SECRET = "";
      assertEq(ol.verifyOutreachToken(linkOwn, OWN).state, "valid", "token: same server secret via ANALYTICS_ADMIN_KEY still verifies");
      delete process.env.ANALYTICS_ADMIN_KEY;
      assertEq(ol.verifyOutreachToken(linkOwn, OWN).state, "invalid", "token: no server secret → fails closed");
      assertEq(ol.makeOutreachToken(OWN, CAMPAIGN, clock), null, "token: no server secret → no token");
      process.env.ADMIN_KEY = KEY;
    }

    // ─── Token: tamper / expiry / agent mismatch ────────────────────────────
    {
      const [v, payload, sig] = tOwn.split(".") as [string, string, string];
      const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
      const forgedPayload = Buffer.from(JSON.stringify({ a: OTHER, c: CAMPAIGN, i: Math.floor(clock / 1000) })).toString("base64url");
      const cases: Array<[string, string, string]> = [
        ["tampered signature", OWN, `${v}.${payload}.${flip(sig)}`],
        ["payload swapped to another agent", OTHER, `${v}.${forgedPayload}.${sig}`],
        ["another agent's valid token", OTHER, tOwn],
        ["wrong version", OWN, `v9.${payload}.${sig}`],
        ["garbage", OWN, "not-a-token"],
        ["issued in the future", OWN, tokenFor(OWN, clock + DAY)],
      ];
      for (const [label, id, t] of cases) {
        const r = await getPage(id, t, tokens[id]);
        assertTrue(r.status === 404 && html(r).includes('data-outreach-link="unusable"') && !html(r).includes("Honning") && !html(r).includes("Løk"),
          `token: ${label} → neutral page, no candidates`);
      }
      const old = tokenFor(OWN, clock - 31 * DAY);
      const ex = await getPage(OWN, old, tokens[OWN]);
      assertTrue(ex.status === 410 && html(ex).includes('data-outreach-link="unusable"') && !html(ex).includes("Honning"), "token: expired (31 days) → 410 neutral page");
      // K4: the claim page is only for a valid token; without a session the token check still comes first.
      const tBad = tokenFor(B);
      const [bv, bp, bs] = tBad.split(".") as [string, string, string];
      const k4Cases: Array<[string, string, number]> = [
        ["tampered", `${bv}.${bp}.${flip(bs)}`, 404],
        ["another agent's", tOwn, 404],
        ["expired", tokenFor(B, clock - 31 * DAY), 410],
      ];
      for (const [label, t, status] of k4Cases) {
        const r = await getPage(B, t);
        assertTrue(r.status === status && html(r).includes('data-outreach-link="unusable"') && !html(r).includes('data-outreach-claim="1"')
          && !html(r).includes("/selger?agent=") && !html(r).includes("Gulrøtter") && Object.keys(r.cookies).length === 0,
          `K4: ${label} token, no session, profile without an owner → neutral page as before (no claim page, no cookie)`);
      }
      assertEq(ol.verifyOutreachToken(tokenFor(OWN, clock - 29 * DAY), OWN).state, "valid", "token: 29 days old is still valid");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_outreach_events").get(), { n: 0 }, "token: refused tokens log nothing");
    }

    // ─── AC19: GET changes nothing; no login → no candidates ────────────────
    const knowledgeBefore = (db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).products;
    const productRows = () => (db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
    const rowsBefore = productRows();
    {
      const before = totalChanges();
      const anon = await getPage(OWN, tOwn);
      assertTrue(anon.status === 200 && html(anon).includes('data-outreach-login="1"') && html(anon).includes(`href="/eier/${OWN}"`),
        "AC19: no session → login page linking to the owner login");
      assertTrue(!html(anon).includes("Honning") && !html(anon).includes("Rabarbrasaft") && !html(anon).includes('name="velg"'), "AC19: no session → no candidates");
      assertEq(anon.cookies[ol.OUTREACH_RETURN_COOKIE], `/eier/${OWN}/varer/forslag?t=${encodeURIComponent(tOwn)}`, "AC19: return cookie points back to the landing page");
      assertEq(totalChanges() - before, 1, "AC19: GET without session writes only the 'opened' log row");
      await getPage(OWN, tOwn);
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_outreach_events WHERE agent_id = ? AND event = 'opened'").get(OWN) as any).n, 1,
        "log: repeated opens within the hour are logged once");
      const foreign = await getPage(OWN, tOwn, tokens[OTHER]);
      assertTrue(foreign.status === 200 && html(foreign).includes('data-outreach-login="1"') && !html(foreign).includes("Honning"),
        "AC19: a session for another profile → login page, no candidates");
    }
    // Segment B: session (e-mail match), profile not taken over.
    const tB = tokenFor(B);
    // K4: no session on a profile without a verified owner → the claim flow, not the /eier login.
    {
      const runsOfB = () => (db.prepare("SELECT COUNT(*) AS n FROM product_import_runs WHERE agent_id = ?").get(B) as { n: number }).n;
      const claimsOfB = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_claims WHERE agent_id = ?").get(B) as { n: number }).n;
      const runsBefore = runsOfB();
      const before = totalChanges();
      const r = await getPage(B, tB);
      const h = html(r);
      assertTrue(r.status === 200 && h.includes('data-outreach-claim="1"') && h.includes("Ta over profilen først") && h.includes(`href="/selger?agent=${B}"`),
        "K4: no session, profile without an owner → «Ta over profilen først» with a link to /selger?agent=");
      assertTrue(!h.includes('data-outreach-login="1"') && !h.includes(`href="/eier/${B}"`), "K4: no session, profile without an owner → no /eier login");
      assertTrue(!h.includes("Gulrøtter") && !h.includes("Poteter") && !h.includes('name="velg"') && !h.includes('data-outreach-list="1"'),
        "K4: no session, profile without an owner → no candidates");
      assertEq(totalChanges() - before, 1, "K4: writes only the 'opened' log row");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_outreach_events WHERE agent_id = ? AND event = 'opened' AND detail = 'no_session'").get(B) as any).n, 1,
        "K4: the open is logged as no_session");
      assertEq([runsOfB(), claimsOfB(), productsOf(B).length], [runsBefore, 0, 0], "K4: no run, claim or product written");
      assertEq(r.cookies[ol.OUTREACH_RETURN_COOKIE], `/eier/${B}/varer/forslag?t=${encodeURIComponent(tB)}`, "K4: the return cookie keeps the same link");
      const foreign = await getPage(B, tB, tokens[OTHER]);
      assertTrue(foreign.status === 200 && html(foreign).includes('data-outreach-claim="1"') && !html(foreign).includes("Gulrøtter"),
        "K4: another profile's session on a profile without an owner → claim page, no candidates");
      const free = await getPage(FREE, tokenFor(FREE));
      assertTrue(free.status === 200 && html(free).includes('data-outreach-claim="1"') && html(free).includes(`href="/selger?agent=${FREE}"`)
        && !html(free).includes('data-outreach-login="1"'), "K4: no listed e-mail and no owner → claim page, not the login dead end");
      const nv = await getPage(NOTVER, tokenFor(NOTVER));
      assertTrue(nv.status === 200 && html(nv).includes('data-outreach-login="1"') && !html(nv).includes('data-outreach-claim="1"'),
        "K4: verified claim with is_verified = 0 (customer rule owner), no session → login as before");
      const own = await getPage(OWN, tOwn);
      assertTrue(own.status === 200 && html(own).includes('data-outreach-login="1"') && html(own).includes(`href="/eier/${OWN}"`) && !html(own).includes('data-outreach-claim="1"'),
        "K4: verified owner, no session → login as before");
    }
    {
      const r = await getPage(B, tB, tokens[B]);
      assertTrue(r.status === 200 && html(r).includes('data-outreach-claim="1"') && html(r).includes(`href="/selger?agent=${B}"`),
        "AC19: segment B → «ta over profilen» page");
      assertTrue(!html(r).includes("Gulrøtter") && !html(r).includes('name="velg"'), "AC19: segment B → no list before the claim");
      const p = await postPage(B, { t: tB, run: prepRun(B), velg: candId(prepRun(B), "Gulrøtter") }, tokens[B]);
      assertEq(p.status, 403, "AC19: segment B → POST 403");
      assertEq(productsOf(B).length, 0, "AC19: segment B POST published nothing");
    }
    {
      const before = totalChanges();
      const r = await getPage(OWN, tOwn, tokens[OWN]);
      const h = html(r);
      assertEq(totalChanges() - before, 1, "AC19: owner GET writes only the 'opened' log row");
      assertEq((db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).products, knowledgeBefore, "AC19: owner GET leaves the profile's products unchanged");
      assertEq(productRows(), rowsBefore, "AC19: owner GET adds no catalog rows");
      assertTrue(r.status === 200 && h.includes('data-outreach-list="1"'), "list: verified owner sees the list");
      assertTrue(h.includes("Honning") && h.includes("Rabarbrasaft") && h.includes("Lammelår") && !h.includes("Eplecider"), "list: eligible candidates shown, rejected not");
      assertTrue(new RegExp(`name="velg" value="${candId(prepRun(OWN), "Honning")}" checked`).test(h)
        && new RegExp(`name="velg" value="${candId(prepRun(OWN), "Lammelår")}" checked`).test(h), "list: all candidates pre-checked");
      assertTrue(/Før: <strong>kr 250\/kg<\/strong> → Nå:/.test(h), "list: a changed price is shown as old → new");
      assertTrue(h.includes('name="paa_lager" value="1">') && h.includes("Varene er på lager, kunder kan bestille dem"), "list: «på lager» choice, off by default");
      assertTrue(h.includes("Bekreft og legg inn") && h.includes(`action="/eier/${OWN}/varer/forslag"`), "list: «Bekreft og legg inn» form");
      assertTrue(h.includes(`name="t" value="${tOwn}"`) && h.includes(`name="run" value="${prepRun(OWN)}"`), "list: token and run as hidden fields");
      assertTrue(h.includes("data-fetched-at=") && h.includes("Hentet 20.10.2026"), "list: fetch date per candidate");
      assertTrue(h.includes("Se på nettsiden") && h.includes("https://po-own.no/products/honning"), "list: source URL per candidate");
      assertTrue(!h.includes('name="fjern"') && !h.includes('data-section="not_found"'), "list: no removal of existing products from this page");
      assertTrue(!h.includes("data-outreach-notice"), "list: fresh list (1 day) has no notice");
      const col = html(await getPage(OWN, tOwn, tokens["own-colleague"]));
      assertTrue(col.includes("data-claimant-login-required"), "list: a non-claimant session is told to log in with the owner's e-mail");
    }

    // ─── Cross-agent + POST guards ──────────────────────────────────────────
    const runOwn = prepRun(OWN);
    const idHon = candId(runOwn, "Honning");
    const idLam = candId(runOwn, "Lammelår");
    const idRab = candId(runOwn, "Rabarbrasaft");
    {
      const before = totalChanges();
      const tOther = tokenFor(OTHER);
      const idLok = candId(prepRun(OTHER), "Løk");
      const a = await postPage(OWN, { t: tOwn, run: prepRun(OTHER), velg: idLok }, tokens[OWN]);
      assertEq(a.status, 404, "cross: agent A's token + agent B's run id → 404");
      const b = await postPage(OTHER, { t: tOwn, run: prepRun(OTHER), velg: idLok }, tokens[OTHER]);
      assertEq(b.status, 404, "cross: agent A's token on agent B's page → 404");
      const c = await postPage(OWN, { t: tOther, run: runOwn, velg: idHon }, tokens[OWN]);
      assertEq(c.status, 404, "cross: agent B's token on agent A's page → 404");
      const d = await postPage(OWN, { t: tOwn, run: runOwn, velg: idLok }, tokens[OWN]);
      assertEq(d.status, 400, "cross: agent B's candidate id in agent A's run is ignored (nothing selected → 400)");
      assertEq((await postPage(OWN, { t: tOwn, run: runOwn, velg: idHon })).status, 401, "POST: no session → 401");
      assertEq((await postPage(OWN, { t: tOwn, run: runOwn, velg: idHon }, tokens[OTHER])).status, 401, "POST: another profile's session → 401");
      assertEq((await postPage(OWN, { t: tOwn, run: runOwn, velg: idHon }, tokens[OWN], { origin: "https://evil.example" })).status, 403, "POST: cross-site → 403");
      assertEq((await postPage(OWN, { t: tOwn, run: runOwn, velg: idHon }, tokens["own-colleague"])).status, 403, "POST: non-claimant session → 403");
      assertEq((await postPage(OWN, { t: "po1.x.y", run: runOwn, velg: idHon }, tokens[OWN])).status, 404, "POST: bad token → 404");
      assertEq((await postPage(OWN, { t: tOwn, run: "pio-nope", velg: idHon }, tokens[OWN])).status, 404, "POST: unknown run → 404");
      assertEq(totalChanges(), before, "cross / guards: refused POSTs write nothing");
      assertEq(productsOf(OTHER).length, 0, "cross: agent B's profile unchanged");
    }

    // ─── AC20: only ticked, edited values, manual kept, not orderable ───────
    {
      const r = await postPage(OWN, {
        t: tOwn, run: runOwn, velg: [idHon, idLam],
        [`navn_${idHon}`]: "Skogshonning", [`pris_${idHon}`]: "125,50", [`enhet_${idHon}`]: "",
        [`pris_${idLam}`]: "289", [`enhet_${idLam}`]: "kg",
        [`navn_${idRab}`]: "Rabarbrasaft", [`pris_${idRab}`]: "59", [`enhet_${idRab}`]: "",
        fjern: "Egg", // never honoured on this page
      }, tokens[OWN]);
      assertTrue(r.status === 200 && html(r).includes('data-outreach-confirmed="2"') && html(r).includes('data-outreach-in-stock="0"'), "AC20: receipt with 2 published, none in stock");
      const prods = productsOf(OWN);
      const byName = (n: string) => prods.find((p) => p.name === n);
      assertEq([byName("Skogshonning")?.price, byName("Skogshonning")?.source], ["kr 125,50", "owner_import"], "AC20: edited name and price used");
      assertTrue(!byName("Honning"), "AC20: the original name is not published next to the edited one");
      assertEq(byName("Lammelår")?.price, "kr 289/kg", "AC20: ticked changed row gets the new price (stored unit kept)");
      assertTrue(!byName("Rabarbrasaft"), "AC20: unticked candidate not published");
      assertEq([byName("Egg")?.price, byName("Egg")?.source], ["kr 55", "owner_manual"], "AC20: manual product kept (a «fjern» field is ignored)");
      const rows = db.prepare(`SELECT agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source
        FROM products WHERE agent_id = ? AND name IN ('Skogshonning', 'Lammelår')`).all(OWN) as any[];
      assertEq(rows.length, 2, "AC20: catalog rows exist for the published products");
      // M7: a skive 3 owner fetch started from the portal (no refetch_started event) is not this page's run.
      db.prepare(`INSERT INTO product_import_runs (id, mode, status, agent_id, params_json, created_at)
        VALUES ('pio-portal-1', 'owner_fetch', 'completed', ?, '{"website":"https://po-own.no"}', ?)`).run(OWN, new Date(clock).toISOString().slice(0, 19).replace("T", " "));
      db.prepare(`INSERT INTO product_import_candidates
         (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
          pack_size, tier, source_url, rules_json, fetched_at, status, created_at)
       VALUES ('pic-portal-1', 'pio-portal-1', ?, 0, 'Portalhonning', 'portalhonning', 99, 'kr 99', NULL, 0, 0, NULL, 'shopify', NULL, '[]', '2026-10-21T09:00:00.000Z', 'pending', '2026-10-21 09:00:00')`).run(OWN);
      const m7Before = totalChanges();
      const m7 = await postPage(OWN, { t: tOwn, run: "pio-portal-1", velg: ["pic-portal-1"] }, tokens[OWN]);
      assertTrue((m7.status === 404 || m7.status === 409 || m7.status === 400) && totalChanges() === m7Before && !productsOf(OWN).some((p) => p.name === "Portalhonning"),
        "M7: a portal owner-fetch run (no refetch_started) is refused by the 3b POST, nothing written");
      assertTrue(rows.every((x) => !isRowOrderableForRealOrder(db, x, new Date())), "AC20: without «på lager» none is orderable");
      const again = await postPage(OWN, { t: tOwn, run: runOwn, velg: [idHon] }, tokens[OWN]);
      assertEq(again.status, 400, "AC20: an already published candidate cannot be published twice (ignored → 400)");
      const rm = oi.publishOwnerImport(OWN, runOwn, [{ id: idRab }], ["Egg"], { actorEmail: `post@${OWN}.example.no`, mode: "outreach_prepare" });
      assertTrue(!rm.ok && rm.status === 400 && rm.error === "remove_not_allowed" && !productsOf(OWN).some((p) => p.name === "Rabarbrasaft")
        && productsOf(OWN).some((p) => p.name === "Egg"), "publish: outreach mode refuses a non-empty remove list and writes nothing");
    }
    // isVerifiedOwner passes, but agents.is_verified = 0 → no list, POST 403.
    {
      const tN = tokenFor(NOTVER);
      const g = await getPage(NOTVER, tN, tokens[NOTVER]);
      assertTrue(g.status === 200 && html(g).includes('data-outreach-claim="1"') && !html(g).includes('name="velg"'), "is_verified=0 with a verified claim → no list");
      assertEq((await postPage(NOTVER, { t: tN, run: "pio-x", velg: "x" }, tokens[NOTVER])).status, 403, "is_verified=0 with a verified claim → POST 403");
    }
    // A prepare run still marked running (e.g. cut off by a restart) → neutral page, no self-refresh.
    {
      db.prepare(`INSERT INTO product_import_runs (id, mode, status, agent_id, campaign, prepare_id, created_at)
        VALUES ('pio-running-1', 'outreach_prepare', 'running', ?, ?, 'pop-gone', ?)`).run(RUNNING, CAMPAIGN, new Date(clock - DAY).toISOString().slice(0, 19).replace("T", " "));
      const r = await getPage(RUNNING, tokenFor(RUNNING), tokens[RUNNING]);
      assertTrue(r.status === 200 && html(r).includes('data-outreach-none="1"') && !html(r).includes('http-equiv="refresh"'),
        "running prepare run without a job → neutral page, no meta refresh");
    }
    // A source URL with markup is escaped in the row.
    {
      db.prepare(`INSERT INTO product_import_candidates
         (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
          pack_size, tier, source_url, rules_json, fetched_at, status, diff_kind, created_at)
       VALUES ('pic-src-xss', ?, ?, 50, 'Kålrot', 'kalrot', 30, 'kr 30', NULL, 0, 0, NULL, 'shopify', ?, '[]', '2026-10-20T09:00:00.000Z', 'eligible', 'new', '2026-10-20 09:00:00')`,
      ).run(prepRun(OTHER), OTHER, 'https://x" onmouseover=alert(1)');
      const h = html(await getPage(OTHER, tokenFor(OTHER), tokens[OTHER]));
      assertTrue(h.includes("Kålrot") && !h.includes('" onmouseover') && h.includes("&quot; onmouseover"), "XSS: a source URL with a quote is escaped");
    }
    // Segment B completes the claim → the list, then «på lager».
    {
      db.prepare("UPDATE agents SET is_verified = 1, claimed_at = '2026-10-21T00:00:00.000Z' WHERE id = ?").run(B);
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
        VALUES ('claim-po-b', ?, 'Eier', ?, 'verified', '2026-10-21T00:00:00.000Z')`).run(B, `post@${B}.example.no`);
      const runB = prepRun(B);
      const anonAfter = await getPage(B, tB);
      assertTrue(anonAfter.status === 200 && html(anonAfter).includes('data-outreach-login="1"') && !html(anonAfter).includes('data-outreach-claim="1"')
        && !html(anonAfter).includes("Gulrøtter"), "K4: after the claim the same link without a session → login, no candidates");
      const l = await getPage(B, tB, tokens[B]);
      assertTrue(html(l).includes('data-outreach-list="1"') && html(l).includes("Gulrøtter") && html(l).includes("Poteter"), "AC19: segment B sees the list once ownership is confirmed");
      const gul = candId(runB, "Gulrøtter");
      const pot = candId(runB, "Poteter");
      const r = await postPage(B, { t: tB, run: runB, velg: [gul, pot], paa_lager: "1" }, tokens[B]);
      assertTrue(r.status === 200 && html(r).includes('data-outreach-confirmed="2"') && html(r).includes('data-outreach-in-stock="2"'), "AC20: receipt with 2 published, 2 in stock");
      const rows = db.prepare(`SELECT agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source
        FROM products WHERE agent_id = ?`).all(B) as any[];
      assertTrue(rows.length === 2 && rows.every((x) => isRowOrderableForRealOrder(db, x, new Date())), "AC20: with «på lager» the published products are orderable");
    }

    // ─── AC21: freshness with a fixed clock ─────────────────────────────────
    {
      const tS = tokenFor(STALE);
      const ownerRuns = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM product_import_runs WHERE mode = 'owner_fetch' AND agent_id = ?").get(id) as { n: number }).n;
      clock = T0 + 6 * DAY;
      const six = await getPage(STALE, tS, tokens[STALE]);
      assertTrue(html(six).includes("Blåbærsyltetøy") && ownerRuns(STALE) === 0, "AC21: 6 days after the extraction → no re-extraction");
      // The website changed after the pre-extraction.
      Object.assign(routes, shop("po-stale.no", [{ title: "Blåbærsyltetøy", handle: "syltetoy", price: "95.00" }, { title: "Tyttebær", handle: "tytte", price: "70.00" }]));
      clock = T0 + 8 * DAY;
      const eight = await getPage(STALE, tS, tokens[STALE]);
      const newRun = (db.prepare("SELECT id FROM product_import_runs WHERE mode = 'owner_fetch' AND agent_id = ?").get(STALE) as { id: string } | undefined)?.id ?? "";
      assertTrue(newRun.startsWith("pio-") && ownerRuns(STALE) === 1, "AC21: 8 days after the extraction → a new extraction is started");
      assertTrue(html(eight).includes('data-import-status="running"') && !html(eight).includes('name="velg"'), "AC21: the old list is not shown while re-extracting");
      assertEq(oi.ownerFetchesToday(STALE, clock), 1, "AC21: the re-extraction counts against the owner's daily limit");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_outreach_events WHERE agent_id = ? AND event = 'refetch_started' AND run_id = ?").get(STALE, newRun) as any).n, 1,
        "AC21: refetch_started logged with the run id");
      await oi.__awaitOwnerFetchForTesting(newRun);
      const after = await getPage(STALE, tS, tokens[STALE]);
      const h = html(after);
      assertTrue(h.includes("Tyttebær") && h.includes(`name="run" value="${newRun}"`) && !h.includes("data-outreach-notice"), "AC21: the list shown is the new extraction");
      assertEq(ownerRuns(STALE), 1, "AC21: reopening does not start another extraction");
      // Publish from the re-extracted run works for this agent.
      const ty = candId(newRun, "Tyttebær");
      const p = await postPage(STALE, { t: tS, run: newRun, velg: [ty] }, tokens[STALE]);
      assertTrue(p.status === 200 && productsOf(STALE).some((x) => x.name === "Tyttebær" && x.source === "owner_import"), "AC21: confirming from the re-extracted list publishes");
      // A re-fetch run with an LLM-tier row and a category-label row: neither is shown nor publishable.
      const ins = db.prepare(`INSERT INTO product_import_candidates
         (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
          pack_size, tier, source_url, rules_json, fetched_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, ?, NULL, '[]', '2026-10-28T09:00:00.000Z', 'pending', '2026-10-28 09:00:00')`);
      ins.run("pic-llm-1", newRun, STALE, 90, "Rabarbrasaft", "rabarbrasaft", 59, "59 kr", "llm");
      ins.run("pic-cat-1", newRun, STALE, 91, "Kjøtt", "kjott", null, "", "shopify");
      const hidden = html(await getPage(STALE, tS, tokens[STALE]));
      assertTrue(!hidden.includes("Rabarbrasaft") && !hidden.includes("pic-llm-1"), "B1: accuracy unset → an LLM-tier row of the re-fetch is not shown");
      assertTrue(!hidden.includes("Kjøtt") && !hidden.includes("pic-cat-1"), "B1: a category-label row of the re-fetch is not shown");
      const pl = await postPage(STALE, { t: tS, run: newRun, velg: ["pic-llm-1", "pic-cat-1"] }, tokens[STALE]);
      assertTrue(pl.status === 400 && !productsOf(STALE).some((x) => x.name === "Rabarbrasaft" || x.name === "Kjøtt"), "B1: POSTing hidden LLM / category ids publishes nothing");
      // B2: a re-fetch row without a (kept) price is never offered (3b-1 rejects no_price / price_not_anchored).
      ins.run("pic-noprice-1", newRun, STALE, 92, "Lynghonning", "lynghonning", null, "", "shopify");
      const np = html(await getPage(STALE, tS, tokens[STALE]));
      assertTrue(!np.includes("Lynghonning") && !np.includes("pic-noprice-1"), "B2: a re-fetch row without a price is not shown");
      const npPost = await postPage(STALE, { t: tS, run: newRun, velg: ["pic-noprice-1"], [`navn_pic-noprice-1`]: "Lynghonning", [`pris_pic-noprice-1`]: "" }, tokens[STALE]);
      assertTrue(npPost.status === 400 && !productsOf(STALE).some((x) => x.name === "Lynghonning"), "B2: POSTing a no-price row's id publishes nothing");
      // (3) An old tab of the 3b-1 list cannot publish after the newer re-fetch replaced it.
      const oldBefore = totalChanges();
      const oldTab = await postPage(STALE, { t: tS, run: prepRun(STALE), velg: [candId(prepRun(STALE), "Blåbærsyltetøy")] }, tokens[STALE]);
      assertTrue(oldTab.status === 409 && html(oldTab).includes('data-outreach-replaced="1"') && totalChanges() === oldBefore,
        "(3) POST of the replaced 3b-1 run after a re-fetch → 409, nothing written");
      // M15: a re-fetch run stuck in 'running' with no job in this process (restart) → the previous list, no self-refresh.
      db.prepare(`INSERT INTO product_import_runs (id, mode, status, agent_id, params_json, created_at)
        VALUES ('pio-stuck-1', 'owner_fetch', 'running', ?, '{"website":"https://po-stuck.no"}', ?)`).run(STUCK, new Date(clock).toISOString().slice(0, 19).replace("T", " "));
      ol!.logOutreachEvent({ campaign: CAMPAIGN, agentId: STUCK, event: "refetch_started", runId: "pio-stuck-1", nowMs: clock });
      const stuck = await getPage(STUCK, tokenFor(STUCK), tokens[STUCK]);
      assertTrue(html(stuck).includes("Rips") && html(stuck).includes('data-outreach-notice="refetch_failed"') && !html(stuck).includes('http-equiv="refresh"')
        && ownerRuns(STUCK) === 1, "M15: a re-fetch stuck in running without a job → previous list with notice, no meta refresh, no new fetch");
      // LLM-only website at re-fetch time, accuracy unset → the re-fetch never calls the LLM.
      delete routes["https://po-llm.no/products.json?limit=250"];
      routes["https://po-llm.no/"] = { body: HTML(`<a href="/priser">Priser</a><p>Velkommen til en liten gård med sau og høner langs elva.</p>`) };
      routes["https://po-llm.no/priser"] = { body: HTML("<h1>Prisliste</h1><ul><li>Kjøtt</li><li>Rabarbrasaft 59 kr</li></ul><p>Henting på gården lørdager.</p>") };
      const tLl = tokenFor(LLMA);
      await getPage(LLMA, tLl, tokens[LLMA]);
      const llmRun = (db.prepare("SELECT id, llm_call_cap FROM product_import_runs WHERE mode = 'owner_fetch' AND agent_id = ?").get(LLMA) as { id: string; llm_call_cap: number } | undefined);
      assertTrue(!!llmRun && llmRun.llm_call_cap === 0, "B1: the outreach re-fetch is started with an LLM cap of 0");
      await oi.__awaitOwnerFetchForTesting(llmRun?.id ?? "");
      assertEq(ownerLlmCalls, 0, "B1: accuracy unset → the re-fetch never calls the LLM");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_candidates WHERE run_id = ? AND tier = 'llm'").get(llmRun?.id ?? ""), { n: 0 }, "B1: no LLM candidate staged by the re-fetch");
      const fallback = html(await getPage(LLMA, tLl, tokens[LLMA]));
      assertTrue(fallback.includes("Surdeigsbrød") && fallback.includes('data-outreach-notice="refetch_failed"') && !fallback.includes("Rabarbrasaft"),
        "B1: an empty re-fetch → the previous list with its date");
      await getPage(LLMA, tLl, tokens[LLMA]);
      assertEq(ownerRuns(LLMA), 1, "recentlyTried: a failed re-fetch does not start a new fetch on every GET");
      // Limit reached → previous list with its date.
      const tL = tokenFor(LIMIT);
      for (let i = 0; i < 3; i++) {
        db.prepare("INSERT INTO product_import_runs (id, mode, status, agent_id, created_at) VALUES (?, 'owner_fetch', 'completed', ?, ?)")
          .run(`pio-limit-${i}`, LIMIT, new Date(clock).toISOString().slice(0, 19).replace("T", " "));
      }
      const lim = await getPage(LIMIT, tL, tokens[LIMIT]);
      assertTrue(html(lim).includes("Brød") && html(lim).includes('data-outreach-notice="refetch_unavailable"') && html(lim).includes("20.10.2026"),
        "AC21: limit reached → the previous list with its fetch date");
      assertEq(ownerRuns(LIMIT), 3, "AC21: limit reached → no new extraction");
      // No session at 8 days → never starts an extraction (e-mail scanners).
      const tZ = tokenFor(OTHER);
      await getPage(OTHER, tZ);
      assertEq(ownerRuns(OTHER), 0, "AC21: a GET without an owner session never starts an extraction");
    }

    // ─── Per-recipient log (admin) ──────────────────────────────────────────
    {
      assertEq((await logOf(null)).status, 403, "log: no admin key → 403");
      const before = totalChanges();
      const r = await logOf();
      assertEq(totalChanges(), before, "log: reading writes nothing");
      const rec = (id: string) => (r.body.recipients as any[]).find((x) => x.agent_id === id);
      assertTrue(rec(OWN).extracted.run_id === runOwn && rec(OWN).extracted.eligible === 1, "log: extracted run per recipient (eligible left)");
      assertTrue(rec(OWN).opened.count >= 2 && rec(OWN).opened.by_owner === true, "log: opened, with and without owner session");
      assertEq([rec(OWN).confirmed.count, rec(OWN).in_stock], [2, false], "log: confirmed count and «på lager» no");
      assertEq([rec(B).confirmed.count, rec(B).in_stock], [2, true], "log: confirmed count and «på lager» yes");
      assertEq([rec(ZERO).opened.count, rec(ZERO).confirmed.times, rec(ZERO).in_stock], [0, 0, null], "log: untouched recipient");
      assertEq(rec(STALE).refetches.length, 1, "log: re-extractions listed");
      assertTrue(r.body.totals.confirmed === 3 && r.body.totals.in_stock === 1, "log: totals (response rate)");
    }

    // ─── Magic-link login returns to the landing page ──────────────────────
    {
      const back = `/eier/${OWN}/varer/forslag?t=${encodeURIComponent(tOwn)}`;
      const ml = (tok: string) => db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
        .run(`ml-${tok}`, `post@${OWN}.example.no`, tok, OWN, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
      ml("mlx-1");
      const r1 = await invoke(H.verify, { query: { token: "mlx-1" }, cookies: { [ol.OUTREACH_RETURN_COOKIE]: back } });
      assertTrue(r1.status === 302 && r1.location === back && r1.cleared.includes(ol.OUTREACH_RETURN_COOKIE), "login: magic link returns to the landing page");
      ml("mlx-2");
      const r2 = await invoke(H.verify, { query: { token: "mlx-2" }, cookies: { [ol.OUTREACH_RETURN_COOKIE]: `/eier/${OTHER}/varer/forslag?t=x` } });
      assertEq(r2.location, `/eier/${OWN}/portal`, "login: a return path for another agent is ignored");
      ml("mlx-2b");
      const r2b = await invoke(H.verify, { query: { token: "mlx-2b" }, cookies: { [ol.OUTREACH_RETURN_COOKIE]: `/eier/po-abc/varer/forslag?t=${encodeURIComponent(tOwn)}` } });
      assertEq(r2b.location, `/eier/${OWN}/portal`, "login: another agent id of the same length is ignored");
      ml("mlx-3");
      const r3 = await invoke(H.verify, { query: { token: "mlx-3" }, cookies: { [ol.OUTREACH_RETURN_COOKIE]: "https://evil.example/" } });
      assertEq(r3.location, `/eier/${OWN}/portal`, "login: a foreign URL is ignored (no open redirect)");
      delete process.env.PRODUCT_IMPORT_OUTREACH_ENABLED;
      ml("mlx-4");
      const r4 = await invoke(H.verify, { query: { token: "mlx-4" }, cookies: { [ol.OUTREACH_RETURN_COOKIE]: back } });
      assertEq(r4.location, `/eier/${OWN}/portal`, "login: flag off → the portal as before");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    op?.__setOutreachDepsForTesting(null);
    oi?.__setOwnerImportDepsForTesting(null);
    oi?.__forgetOwnerFetchJobsForTesting();
    ol?.__setOutreachLandingClockForTesting(null);
    for (const k of SAVED_ENV) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
    console.log = prevLog;
    console.error = prevErr;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerProductOutreachTests({ log: true }).then((r) => {
    console.info(`\nowner-product-outreach: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

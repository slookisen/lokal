/**
 * owner-product-import-portal.test.ts — dev-request 2026-10-21-rfb-
 * produktimport-fra-egen-nettside, Skive 3-2 (the owner portal side of
 * «Hent produkter fra nettsiden min», on top of the 3-1 JSON API).
 *
 *   flag   PRODUCT_IMPORT_ENABLED off → no card in /eier/:id/portal, the new
 *          form routes and the preview page answer 404, nothing written.
 *   AC9    is_verified = 0 (claimed but not verified, or e-mail match) → no
 *          card and 403 on the new routes; foreign session → 403; no session
 *          → login redirect; cross-site POST → 403; no website → no card;
 *          verified owner → card with website, fetches left, latest run.
 *   fetch  POST hent → 303 to the preview page; while running the page
 *          refreshes itself; 409 / 503 → «prøv igjen om litt» on the card.
 *   AC10   the candidates are not on the profile before publish.
 *   GET    the preview page writes nothing (total_changes()).
 *   diff   «Nye produkter», «Endret pris eller enhet» (gammel → ny), «Ikke
 *          funnet på nettsiden» (never preselected); blocked rows unticked.
 *   N7     a candidate with a price but no unit shows (and publishes) the
 *          stored unit.
 *   XSS    a candidate name with <script> is escaped.
 *   AC11   «Publiser valgte» merges: ticked rows published (edits applied),
 *          unticked rows and manual products kept, only ticked «ikke funnet»
 *          rows removed; 303 back to the card with the counts and the «på
 *          lager» hint; bad edit → 400, values kept, nothing written;
 *          claimant e-mail required (403).
 *   AC12   4th fetch the same UTC day → the Norwegian limit message on the
 *          card, no fetch button.
 *   zero   zero-result page: «Fant ingen produkter med pris på nettsiden.
 *          Legg dem inn selv.» + the outcome in plain Norwegian.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch injected (no network); fixed clock. Env restored in finally.
 * Exported runOwnerProductImportPortalTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-product-import-portal.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "PRODUCT_IMPORT_ENABLED", "OWNER_LOCK_ENFORCE_WRITES", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED",
];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);

type FakeRoute = { status?: number; body: string; contentType?: string };
const ROBOTS_OPEN: FakeRoute = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };
const ROBOTS_CLOSED: FakeRoute = { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" };
const HTML = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

function shopifySite(host: string, products: Array<{ title: string; handle: string; price?: string; variant?: string }>): Record<string, FakeRoute> {
  return {
    [`https://${host}/robots.txt`]: ROBOTS_OPEN,
    [`https://${host}/products.json?limit=250`]: {
      contentType: "application/json",
      body: JSON.stringify({
        products: products.map((p) => ({
          title: p.title,
          handle: p.handle,
          variants: p.price === undefined ? [] : [{ title: p.variant ?? "Default Title", price: p.price }],
        })),
      }),
    },
  };
}

export async function runOwnerProductImportPortalTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    oi = require("../services/product-import/owner-import") as typeof import("../services/product-import/owner-import");
    const robots = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
    const importRouter = (require("./owner-product-import") as any).default;
    const importMod = require("./owner-product-import") as typeof import("./owner-product-import");
    const portalRouter = (require("./owner-portal") as any).default;
    const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    robots.__clearRobotsCacheForTesting();
    oi.__forgetOwnerFetchJobsForTesting();

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = {
      portal: handlerOf(portalRouter, "/eier/:agentId/portal", "get"),
      hent: handlerOf(importRouter, "/eier/:agentId/produktimport/hent", "post"),
      page: handlerOf(importRouter, "/eier/:agentId/produktimport/:runId", "get"),
      publish: handlerOf(importRouter, "/eier/:agentId/produktimport/:runId/publiser", "post"),
    };
    type Res = { status: number; body: any; location?: string };
    const invoke = (handler: Function, o: { params: Record<string, string>; token?: string; body?: any; headers?: Record<string, string>; query?: Record<string, string> }) =>
      new Promise<Res>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        const req: any = {
          method: "GET", params: o.params, body: o.body, query: o.query || {}, headers, cookies: {}, ip: "127.0.0.1",
          get: (n: string) => headers[n.toLowerCase()],
        };
        let status = 200;
        let settled = false;
        const settle = (r: Res) => { if (!settled) { settled = true; resolve(r); } };
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { settle({ status, body: b }); return res; },
          send(b: any) { settle({ status, body: b }); return res; },
          redirect(c: number, loc: string) { settle({ status: c, body: "", location: loc }); return res; },
          setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; },
          cookie() { return res; }, clearCookie() { return res; },
        };
        try {
          const p = handler(req, res, () => settle({ status: 0, body: "next" }));
          if (p && typeof p.catch === "function") p.catch((e: any) => settle({ status: -1, body: String(e) }));
        } catch (e) { settle({ status: -1, body: String(e) }); }
      });
    const totalChanges = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const html = (r: Res) => String(r.body ?? "");

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { verified: number; claimed?: boolean; website?: string | null; products?: unknown[] }) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, claimed_at, vertical_id)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, ?, 0, 0, 0, datetime('now'), datetime('now'), ?, 'rfb')`,
      ).run(id, `Gard ${id}`, `post@${id}.example.no`, `key-${id}`, o.verified, o.claimed === false ? null : "2026-10-01T00:00:00.000Z");
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, ?, 'hybrid', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, o.website === undefined ? `https://${id}.no` : o.website, JSON.stringify(o.products ?? []));
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

    const OWN = "pi-own";
    addAgent(OWN, { verified: 1, products: [
      { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual", confirmedAt: "2026-10-01T10:00:00.000Z" },
      { name: "Egg", category: "eggs", seasonal: false, price: "kr 55", source: "owner_manual" },
      { name: "Gammel ost", category: "dairy", seasonal: false, price: "kr 90", source: "owner_manual" },
    ] });
    addAgent("pi-n7", { verified: 1, products: [
      { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual" },
      { name: "Pølse", category: "meat", seasonal: false, price: "kr 89/kg", priceUnit: "kr", source: "owner_manual" },
    ] });
    addAgent("pi-unver", { verified: 0 });
    addAgent("pi-ematch", { verified: 0, claimed: false });
    addAgent("pi-nosite", { verified: 1, website: "" });
    addAgent("pi-other", { verified: 1 });
    addAgent("pi-robots", { verified: 1 });
    addAgent("pi-down", { verified: 1 });
    addAgent("pi-c1", { verified: 1 });
    addAgent("pi-c2", { verified: 1 });
    addAgent("pi-c3", { verified: 1 });
    addAgent("pi-n1", { verified: 1, products: [
      { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual" },
      { name: "Pølse", category: "meat", seasonal: false, price: "kr 89/kg", priceUnit: "kr", source: "owner_manual" },
    ] });
    addAgent("pi-v1noowner", { verified: 1, claimed: false }); // is_verified = 1, but no verified owner (no claim, claimed_at NULL)
    addAgent("pi-jsurl", { verified: 1, website: "javascript:alert(1)" });
    for (const id of [OWN, "pi-n7", "pi-unver", "pi-ematch", "pi-nosite", "pi-other", "pi-robots", "pi-down", "pi-c1", "pi-c2", "pi-c3",
      "pi-n1", "pi-v1noowner", "pi-jsurl"]) session(id);
    session(OWN, "kollega@pi-own.example.no", "own-colleague"); // verified owner session, not the claimant's address

    const routes: Record<string, FakeRoute> = {
      ...shopifySite("pi-own.no", [
        { title: "Lammelår", handle: "lammelar", price: "289.00", variant: "1 kg" },
        { title: "Honning", handle: "honning", price: "120.00" },
        { title: "Eplecider", handle: "eplecider", price: "149.00" },
        { title: "Rabarbrasaft", handle: "rabarbrasaft", price: "59.00" },
      ]),
      ...shopifySite("pi-n7.no", [
        { title: "Lammelår", handle: "lammelar", price: "289.00" }, // price, no unit → the stored unit (kg) is published
        { title: "Pølse", handle: "polse" },                         // no price on the site → unchanged, stored price kept
        { title: "Rømme", handle: "romme" },                         // new, no price on the site
      ]),
      "https://pi-robots.no/robots.txt": ROBOTS_CLOSED,
      ...shopifySite("pi-n1.no", [
        { title: "Lammelår", handle: "lammelar", price: "289.00" }, // changed, no unit on the site → stored kg
        { title: "Pølse", handle: "polse", price: "89.00" },        // same price, no unit on the site → unchanged, stored kg kept
      ]),
      ...shopifySite("pi-c1.no", [{ title: "Gulrøtter", handle: "gulrotter", price: "25.00" }]),
      ...shopifySite("pi-c2.no", [{ title: "Poteter", handle: "poteter", price: "30.00" }]),
      ...shopifySite("pi-c3.no", [{ title: "Løk", handle: "lok", price: "20.00" }]),
    };
    const holds: Array<() => void> = [];
    let holdHosts = new Set<string>();
    const fetchImpl = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const host = new URL(url).hostname;
      if (holdHosts.has(host)) await new Promise<void>((r) => holds.push(r));
      if (host === "pi-down.no") throw new Error("ECONNREFUSED");
      const r = routes[url] ?? { status: 404, body: HTML("404") };
      return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    const llm = async () => ({ text: "[]" });
    const clock = T0;
    oi.__setOwnerImportDepsForTesting({ fetchImpl, llm, now: () => clock, sleep: async () => undefined, hostIntervalMs: 0 });

    const portalFor = (id: string, token = tokens[id], query: Record<string, string> = {}) => invoke(H.portal, { params: { agentId: id }, token, query });
    const hentFor = (id: string, token = tokens[id], headers?: Record<string, string>) => invoke(H.hent, { params: { agentId: id }, token, body: {}, headers });
    const pageFor = (id: string, runId: string, token = tokens[id]) => invoke(H.page, { params: { agentId: id, runId }, token });
    const publishFor = (id: string, runId: string, body: any, token = tokens[id], headers?: Record<string, string>) =>
      invoke(H.publish, { params: { agentId: id, runId }, token, body, headers });
    const runIdFrom = (r: Res, id: string): string => {
      const m = new RegExp(`^/eier/${id}/produktimport/([A-Za-z0-9_-]+)$`).exec(r.location ?? "");
      return m ? m[1]! : "";
    };
    const hasCard = (r: Res) => html(r).includes('data-product-import-card="1"');
    const productsOf = (id: string) => (ks.knowledgeService.getKnowledge(id)?.products || []) as any[];
    const candId = (runId: string, name: string) =>
      (db.prepare("SELECT id FROM product_import_candidates WHERE run_id = ? AND name = ?").get(runId, name) as { id: string } | undefined)?.id ?? "";

    // ─── flag off → no card, 404, nothing written ───────────────────────────
    {
      const portal = await portalFor(OWN);
      assertTrue(portal.status === 200 && !hasCard(portal) && !html(portal).includes("produktimport"), "flag off: verified owner's portal has no import card");
      const before = totalChanges();
      const r = [await hentFor(OWN), await pageFor(OWN, "pio-x"), await publishFor(OWN, "pio-x", { velg: "x" })];
      assertEq(r.map((x) => x.status), [404, 404, 404], "flag off: the new routes answer 404");
      assertEq(totalChanges(), before, "flag off: nothing written");
    }
    process.env.PRODUCT_IMPORT_ENABLED = "1";

    // ─── AC9: who sees the card / may use the routes ────────────────────────
    {
      for (const id of ["pi-unver", "pi-ematch"]) {
        const portal = await portalFor(id);
        assertTrue(portal.status === 200 && !hasCard(portal), `AC9: ${id} (is_verified=0) → portal without the import card`);
        assertEq((await hentFor(id)).status, 403, `AC9: ${id} → POST hent 403`);
        assertEq((await pageFor(id, "pio-x")).status, 403, `AC9: ${id} → preview page 403`);
        assertEq((await publishFor(id, "pio-x", { velg: "x" })).status, 403, `AC9: ${id} → publish 403`);
      }
      assertTrue(!hasCard(await portalFor("pi-nosite")), "AC9: verified owner without a website → no card");
      const noOwner = await portalFor("pi-v1noowner");
      assertTrue(noOwner.status === 200 && !hasCard(noOwner), "AC9: is_verified = 1 but the session is not a verified owner → no card");
      assertEq((await hentFor("pi-v1noowner")).status, 403, "AC9: is_verified = 1 without a verified owner → POST hent 403");
      const js = html(await portalFor("pi-jsurl"));
      assertTrue(js.includes('data-product-import-card="1"') && !/href="javascript:/i.test(js) && js.includes("javascript:alert(1)"),
        "card: a javascript: website is shown as text, never as a clickable href");
      const anon = await hentFor(OWN, "");
      assertEq([anon.status, anon.location], [303, `/eier/${OWN}`], "AC9: no session → login page");
      assertEq((await hentFor("pi-other", tokens[OWN])).status, 403, "AC9: a session for another profile → 403");
      assertEq((await pageFor("pi-other", "pio-x", tokens[OWN])).status, 403, "AC9: foreign profile → preview page 403");
      assertEq((await hentFor(OWN, tokens[OWN], { origin: "https://evil.example" })).status, 403, "AC9: cross-site POST hent → 403");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_runs").get(), { n: 0 }, "AC9: refused calls create no run");
      const portal = await portalFor(OWN);
      const h = html(portal);
      assertTrue(hasCard(portal), "AC9: verified owner (is_verified=1, website) → card shown");
      assertTrue(h.includes("Hent produkter fra nettsiden min") && h.includes("https://pi-own.no") && h.includes('data-fetches-left="3"'),
        "card: title, website and fetches left today");
      assertTrue(h.includes(`action="/eier/${OWN}/produktimport/hent"`), "card: fetch button posts to the form route");
      assertTrue(h.includes("Du har ikke hentet produkter fra nettsiden ennå"), "card: no runs yet");
    }

    // ─── Fetch from the portal + AC10 ───────────────────────────────────────
    const knowledgeBefore = (db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).products;
    holdHosts = new Set(["pi-own.no"]);
    const f1 = await hentFor(OWN);
    const run1 = runIdFrom(f1, OWN);
    assertTrue(f1.status === 303 && run1.startsWith("pio-"), "fetch: POST hent → 303 to the preview page");
    {
      const p = await pageFor(OWN, run1);
      assertTrue(p.status === 200 && html(p).includes('data-import-status="running"') && html(p).includes('http-equiv="refresh"'),
        "fetch: preview page while running refreshes itself");
      const portal = html(await portalFor(OWN));
      assertTrue(portal.includes('data-import-latest-status="running"') && !portal.includes(`action="/eier/${OWN}/produktimport/hent"`),
        "card: a running fetch is shown, no second fetch button");
      const again = await hentFor(OWN);
      assertEq(again.location, `/eier/${OWN}/portal?status=produktimport_pagar#produktimport`, "409: second fetch while one runs → card alert");
      const alert = html(await portalFor(OWN, tokens[OWN], { status: "produktimport_pagar" }));
      assertTrue(alert.includes("Prøv igjen om litt"), "409: «prøv igjen om litt» message on the card");
    }
    holdHosts = new Set();
    while (holds.length) holds.shift()!();
    await oi.__awaitOwnerFetchForTesting(run1);
    {
      assertEq((db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).products, knowledgeBefore,
        "AC10: profile products unchanged after the fetch");
      assertTrue(!productsOf(OWN).some((p) => p.name === "Honning" || p.name === "Rabarbrasaft"), "AC10: candidates are not on the profile before publish");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM products WHERE name IN ('Honning','Rabarbrasaft')").get(), { n: 0 }, "AC10: no catalog rows for candidates");
    }

    // XSS fixture: a staged candidate whose name carries markup.
    db.prepare(
      `INSERT INTO product_import_candidates
         (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
          pack_size, tier, source_url, rules_json, fetched_at, status, created_at)
       VALUES ('pic-xss', ?, ?, 99, ?, 'xss', 10, 'kr 10', NULL, 0, 0, NULL, 'shopify', 'javascript:alert(1)', '[]', '2026-10-30T10:00:00.000Z', 'pending', '2026-10-30 10:00:00')`,
    ).run(run1, OWN, `<script>alert("x")</script>Syltetøy"><img src=x onerror=alert(2)>`);

    // ─── Preview page: read-only, three sections ────────────────────────────
    {
      const before = totalChanges();
      const p = await pageFor(OWN, run1);
      await pageFor(OWN, run1);
      await portalFor(OWN);
      assertEq(totalChanges(), before, "GET: the preview page and the card write nothing");
      const h = html(p);
      assertTrue(p.status === 200 && h.includes('data-import-status="completed"'), "preview: completed run renders the form");
      assertTrue(h.includes("Nye produkter") && h.includes("Endret pris eller enhet") && h.includes("Ikke funnet på nettsiden"), "preview: three sections");
      const section = (name: string) => {
        const start = h.indexOf(`data-section="${name}"`);
        const next = h.indexOf("data-section=", start + 1);
        return h.slice(start, next < 0 ? undefined : next);
      };
      assertTrue(section("new").includes("Honning") && section("new").includes("Rabarbrasaft") && !section("new").includes("Lammelår"), "preview: new products listed");
      assertTrue(section("changed").includes("Lammelår") && /Før: <strong>kr 250\/kg<\/strong> → Nå: <strong>kr 289 \/ kg<\/strong>/.test(section("changed")),
        "preview: changed price shown as old → new");
      const nf = section("not_found");
      assertTrue(nf.includes('name="fjern" value="Egg"') && nf.includes('name="fjern" value="Gammel ost"'), "preview: not-found products listed with a remove box");
      assertTrue(!/name="fjern"[^>]*checked/.test(h), "preview: «ikke funnet» rows are never preselected");
      assertTrue(new RegExp(`name="velg" value="${candId(run1, "Honning")}" checked`).test(h), "preview: new rows preselected");
      assertTrue(new RegExp(`name="velg" value="${candId(run1, "Eplecider")}">`).test(h) && h.includes('data-blocked="alcohol"'),
        "preview: an alcohol row is not preselected and says why");
      assertTrue(h.includes(`action="/eier/${OWN}/produktimport/${run1}/publiser"`) && h.includes("Publiser valgte"), "preview: «Publiser valgte» form");
      // XSS
      assertTrue(!h.includes("<script>alert") && !h.includes("<img src=x") && h.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"),
        "XSS: candidate name is HTML-escaped in label and input value");
      assertTrue(!h.includes('href="javascript:'), "XSS: a non-http source URL is not linked");
      assertTrue(!h.includes("data-claimant-login-required"), "preview: claimant session sees no login note");
      const col = html(await pageFor(OWN, run1, tokens["own-colleague"]));
      assertTrue(col.includes("data-claimant-login-required"), "preview: a non-claimant verified-owner session is told to log in with the owner's e-mail");
      assertEq((await pageFor(OWN, "pio-unknown")).status, 404, "preview: unknown run → 404");
      assertEq((await pageFor("pi-other", run1, tokens["pi-other"])).status, 404, "preview: another profile's run id → 404");
      const portal = html(await portalFor(OWN));
      assertTrue(portal.includes('data-import-latest-status="completed"') && portal.includes("Ikke publisert ennå")
        && portal.includes(`href="/eier/${OWN}/produktimport/${run1}"`) && portal.includes('data-fetches-left="2"'),
        "card: latest run status, link to the suggestions, fetches left");
    }

    // ─── Publish: guards ────────────────────────────────────────────────────
    const idHon = candId(run1, "Honning");
    const idLam = candId(run1, "Lammelår");
    const idRab = candId(run1, "Rabarbrasaft");
    {
      const before = totalChanges();
      const col = await publishFor(OWN, run1, { velg: [idHon] }, tokens["own-colleague"]);
      assertTrue(col.status === 403 && html(col).includes('data-claimant-login-required="1"'), "publish: a non-claimant session → 403");
      assertEq((await publishFor(OWN, run1, { velg: [idHon] }, tokens[OWN], { origin: "https://evil.example" })).status, 403, "publish: cross-site → 403");
      const bad = await publishFor(OWN, run1, { velg: [idHon], [`navn_${idHon}`]: "Honning", [`pris_${idHon}`]: "abc", [`enhet_${idHon}`]: "" });
      assertTrue(bad.status === 400 && html(bad).includes('data-publish-error="1"') && html(bad).includes('value="abc"') && html(bad).includes('aria-invalid="true"'),
        "publish: a bad price → 400, message, the owner's values kept");
      assertEq(totalChanges(), before, "publish: refused / invalid publish writes nothing");
    }

    // ─── AC11: publish merges ───────────────────────────────────────────────
    {
      const r = await publishFor(OWN, run1, {
        velg: [idHon, idLam],
        // Honning: price edited; the other fields untouched (as the browser sends them).
        [`navn_${idHon}`]: "Honning", [`pris_${idHon}`]: "125,50", [`enhet_${idHon}`]: "",
        [`navn_${idLam}`]: "Lammelår", [`pris_${idLam}`]: "289", [`enhet_${idLam}`]: "kg",
        // Rabarbrasaft unticked (its fields are still sent).
        [`navn_${idRab}`]: "Rabarbrasaft", [`pris_${idRab}`]: "59", [`enhet_${idRab}`]: "",
        fjern: ["Gammel ost"],
      });
      assertEq(r.location, `/eier/${OWN}/portal?status=produktimport_publisert&publisert=2&fjernet=1&avvist=0#produktimport`,
        "AC11: publish → 303 back to the card with the counts");
      const prods = productsOf(OWN);
      const byName = (n: string) => prods.find((p) => p.name === n);
      assertEq([byName("Honning")?.price, byName("Honning")?.source], ["kr 125,50", "owner_import"], "AC11: ticked new row published with the edited price");
      assertEq(byName("Lammelår")?.price, "kr 289/kg", "AC11: ticked changed row gets the new price");
      assertTrue(!byName("Rabarbrasaft"), "AC11: unticked candidate not published");
      assertEq([byName("Egg")?.price, byName("Egg")?.source], ["kr 55", "owner_manual"], "AC11: an unticked «ikke funnet» manual product is kept");
      assertTrue(!byName("Gammel ost"), "AC11: only the explicitly ticked «ikke funnet» product is removed");
      const portal = html(await portalFor(OWN, tokens[OWN], {
        status: "produktimport_publisert", publisert: "2", fjernet: "1", avvist: "0",
      }));
      assertTrue(portal.includes('data-import-published="2"') && portal.includes("2 varer publisert og 1 vare fjernet."),
        "AC11: confirmation shows how many were published / removed");
      assertTrue(portal.includes("kan ikke bestilles før du har bekreftet at de er på lager"), "AC11: the «på lager» hint follows the confirmation");
      process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${OWN}`;
      const withB1 = html(await portalFor(OWN, tokens[OWN], { status: "produktimport_publisert", publisert: "2", fjernet: "0", avvist: "0" }));
      assertTrue(withB1.includes(`href="/eier/${OWN}/portal#bestillbare-varer"`) && withB1.includes('data-stock-hint="b1"'),
        "AC11: with the B1 card on, the hint links to «Varer som kan bestilles»");
      delete process.env.OWNER_ORDERABILITY_PORTAL_ENABLED;
      delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
      const after = html(await pageFor(OWN, run1));
      assertTrue(after.includes("Allerede behandlet (2)"), "preview after publish: published rows listed as processed");
    }

    // ─── N7: the unit that will be published ────────────────────────────────
    {
      const f = await hentFor("pi-n7");
      const rid = runIdFrom(f, "pi-n7");
      await oi.__awaitOwnerFetchForTesting(rid);
      const h = html(await pageFor("pi-n7", rid));
      const idL = candId(rid, "Lammelår");
      const idP = candId(rid, "Pølse");
      const row = (cid: string) => h.slice(h.indexOf(`data-candidate-id="${cid}"`), h.indexOf("</li>", h.indexOf(`data-candidate-id="${cid}"`)));
      assertTrue(row(idL).includes('data-publish-unit="kg"') && row(idL).includes("Publiseres som: kr 289 / kg") && row(idL).includes(`name="enhet_${idL}" type="text" value="kg"`),
        "N7: a candidate with a price but no unit shows the stored unit that will be published");
      const idR = candId(rid, "Rømme");
      assertTrue(row(idR).includes('data-price-missing="1"') && row(idR).includes("Pris mangler på nettsiden") && row(idR).includes(`name="pris_${idR}" type="text" value=""`),
        "price_missing_on_site: a new row without a price is clearly marked, price field empty");
      assertTrue(!h.includes(`data-candidate-id="${idP}"`) && /Uendret \(1\)[\s\S]*Pølse[\s\S]*prisen du har i dag beholdes/.test(h),
        "price_missing_on_site: a known product without a site price is listed as unchanged, stored price kept");
      const r = await publishFor("pi-n7", rid, {
        velg: [idL],
        [`navn_${idL}`]: "Lammelår", [`pris_${idL}`]: "289", [`enhet_${idL}`]: "kg",
        [`navn_${idR}`]: "Rømme", [`pris_${idR}`]: "", [`enhet_${idR}`]: "",
      });
      assertEq(r.status, 303, "N7: publish untouched rows → 303");
      const prods = productsOf("pi-n7");
      assertEq(prods.find((p) => p.name === "Lammelår")?.price, "kr 289/kg", "N7: the published unit is the one the preview showed");
      assertEq(prods.find((p) => p.name === "Pølse")?.price, "kr 89/kg", "price_missing_on_site: the stored price is untouched");
      assertTrue(!prods.some((p) => p.name === "Rømme"), "N7: the unticked new row is not published");
    }

    // ─── Review N1/N2: a matched row keeps its name; «Uendret» shows the kept unit
    {
      const f = await hentFor("pi-n1");
      const rid = runIdFrom(f, "pi-n1");
      await oi.__awaitOwnerFetchForTesting(rid);
      const h = html(await pageFor("pi-n1", rid));
      const idL = candId(rid, "Lammelår");
      const row = h.slice(h.indexOf(`data-candidate-id="${idL}"`), h.indexOf("</li>", h.indexOf(`data-candidate-id="${idL}"`)));
      assertTrue(row.includes('data-kind="changed"') && row.includes('data-name-locked="1"') && !row.includes(`name="navn_${idL}"`),
        "N1: a changed row (matches an existing product) has no editable name field");
      assertTrue(/Uendret \(1\)[\s\S]*Pølse <span class="ep-audit-meta">kr 89 \/ kg<\/span>/.test(h) && !/Pølse <span class="ep-audit-meta">[^<]*uten enhet/.test(h),
        "N2: «Uendret» shows the stored unit that is kept, not «(uten enhet)»");
      // A forged form post that renames the changed row anyway.
      const r = await publishFor("pi-n1", rid, {
        velg: [idL],
        [`navn_${idL}`]: "Lammelår ekstra", [`pris_${idL}`]: "289", [`enhet_${idL}`]: "kg",
      });
      assertEq(r.status, 303, "N1: publish with a renamed changed row → 303 (name ignored)");
      const prods = productsOf("pi-n1");
      assertEq(prods.filter((p) => /lammelår/i.test(String(p.name))).map((p) => [p.name, p.price]), [["Lammelår", "kr 289/kg"]],
        "N1: no duplicate product; the existing product is replaced and keeps the stored unit");
      assertEq(prods.length, 2, "N1: the profile still has exactly two products");
    }

    // ─── Zero results: outcome explained ────────────────────────────────────
    {
      const f = await hentFor("pi-robots");
      const rid = runIdFrom(f, "pi-robots");
      await oi.__awaitOwnerFetchForTesting(rid);
      const h = html(await pageFor("pi-robots", rid));
      assertTrue(h.includes("Fant ingen produkter med pris på nettsiden. Legg dem inn selv.") && h.includes('data-import-outcome="robots_blocked"')
        && h.includes("robots.txt") && !h.includes("Publiser valgte"), "zero: robots-blocked site → zero-result text + outcome explained, no publish form");
      const card = html(await portalFor("pi-robots"));
      assertTrue(card.includes("Fant ingen produkter med pris") && card.includes("robots.txt"), "zero: the card shows the outcome too");
      const f2 = await hentFor("pi-down");
      const rid2 = runIdFrom(f2, "pi-down");
      await oi.__awaitOwnerFetchForTesting(rid2);
      const h2 = html(await pageFor("pi-down", rid2));
      assertTrue(h2.includes("Fant ingen produkter med pris på nettsiden. Legg dem inn selv.") && h2.includes("Vi fikk ikke kontakt med nettsiden"),
        "zero: unreachable site → «Vi fikk ikke kontakt med nettsiden»");
    }

    // ─── 503: global cap → «prøv igjen» ─────────────────────────────────────
    {
      holdHosts = new Set(["pi-c1.no", "pi-c2.no"]);
      const a = runIdFrom(await hentFor("pi-c1"), "pi-c1");
      const b = runIdFrom(await hentFor("pi-c2"), "pi-c2");
      const c = await hentFor("pi-c3");
      assertEq(c.location, `/eier/pi-c3/portal?status=produktimport_opptatt#produktimport`, "503: a 3rd simultaneous fetch → card alert");
      assertTrue(html(await portalFor("pi-c3", tokens["pi-c3"], { status: "produktimport_opptatt" })).includes("Prøv igjen om et par minutter"),
        "503: Norwegian «prøv igjen» message rendered");
      holdHosts = new Set();
      while (holds.length) holds.shift()!();
      await oi.__awaitOwnerFetchForTesting(a);
      await oi.__awaitOwnerFetchForTesting(b);
      while (holds.length) holds.shift()!();
    }

    // ─── AC12: 4th fetch the same day ───────────────────────────────────────
    {
      // OWN has used 1 of 3 (the 409 attempt created no run).
      for (let i = 0; i < 2; i++) {
        const f = await hentFor(OWN);
        const rid = runIdFrom(f, OWN);
        assertTrue(rid !== "", `AC12: fetch ${i + 2} of 3 allowed`);
        await oi.__awaitOwnerFetchForTesting(rid);
      }
      const fourth = await hentFor(OWN);
      assertEq(fourth.location, `/eier/${OWN}/portal?status=produktimport_grense#produktimport`, "AC12: 4th fetch the same day → card alert");
      const h = html(await portalFor(OWN, tokens[OWN], { status: "produktimport_grense" }));
      assertTrue(h.includes(oi.OWNER_FETCH_DAILY_LIMIT_MESSAGE) && h.includes('data-import-alert="produktimport_grense"'), "AC12: the Norwegian limit message is rendered");
      assertTrue(h.includes('data-fetches-left="0"') && h.includes('data-import-limit="1"') && !h.includes(`action="/eier/${OWN}/produktimport/hent"`),
        "AC12: no fetch button when none are left today");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_runs WHERE agent_id = ?").get(OWN) as any).n, 3, "AC12: the refused fetch creates no run");
    }

    // ─── Pure helpers ───────────────────────────────────────────────────────
    {
      const c: any = { id: "pic-1", name: "Lammelår", price_nok: 289, unit: null, price_missing_on_site: false };
      assertEq(importMod.candidatePrefill(c, { unit: "kg" }), { name: "Lammelår", price: "289", unit: "kg" }, "prefill: stored unit when the candidate has none (N7)");
      assertEq(importMod.selectionFromForm(c, { unit: "kg" }, { name: "Lammelår", price: "289", unit: "kg" }), { id: "pic-1" }, "selection: untouched row sends only the id");
      assertEq(importMod.selectionFromForm(c, { unit: "kg" }, { name: " Lammelår ", price: "300", unit: "" }), { id: "pic-1", price: "300", unit: "" },
        "selection: only changed fields are sent; clearing the unit is explicit");
      assertEq(importMod.selectionFromForm(c, { unit: "kg" }, { name: "Annet navn", price: "289", unit: "kg" }), { id: "pic-1" },
        "selection: a row matching an existing product never sends a name (N1)");
      assertEq(importMod.selectionFromForm(c, null, { name: "Annet navn", price: "289", unit: "" }), { id: "pic-1", name: "Annet navn" },
        "selection: a new row may be renamed");
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { oi?.__setOwnerImportDepsForTesting(null); oi?.__forgetOwnerFetchJobsForTesting(); } catch { /* ignore */ }
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }
  if (log) console.info(`\nowner-product-import-portal: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerProductImportPortalTests({ log: true }).then((r) => {
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

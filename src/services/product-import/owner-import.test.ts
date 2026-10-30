/**
 * owner-import.test.ts — dev-request 2026-10-21-rfb-produktimport-fra-egen-
 * nettside, Skive 3-1 (server side of «Hent produkter fra nettsiden min»).
 *
 *   flag   PRODUCT_IMPORT_ENABLED off → every route 404, nothing written.
 *   AC9    is_verified = 0 (e-mail match, or claimed but not verified) → 403;
 *          is_verified = 1 → 202/200; foreign agent id → 403; no session →
 *          401; cross-site POST → 403; no website → 422.
 *   AC10   after a fetch, before publish: the candidates are only in
 *          product_import_candidates — agent_knowledge.products and products
 *          are byte-identical, lokal_find_offers (findOffers) and the ACP feed
 *          (GET /catalog/feed) do not list them.
 *   GET    the preview/overview GETs do not write (total_changes()).
 *   diff   new / changed (old → new) / not found; LLM tier marked.
 *   AC11   publish selected → source 'owner_import' + sourceUrl / fetchedAt /
 *          confirmedAt; unselected manual and enrichment products kept with
 *          their provenance; «not found» never deleted; explicit removal
 *          only; owner lock on products; catalog rows synced and NOT
 *          orderable (not_confirmed_by_owner); category label / alcohol /
 *          service rows rejected; bad edits → 400 and nothing written;
 *          claimant e-mail required for publish.
 *   AC12   4th fetch the same UTC day → 429 with a Norwegian message; the
 *          next UTC day is allowed again (counted from the run table).
 *   cap    a 3rd simultaneous fetch → 503 (global cap 2); a second fetch of
 *          the same profile while one runs → 409; a hung fetch times out.
 *   log    one product_import_runs row per fetch with outcome and counts.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch and LLM injected (no network); fixed clock. Env restored in finally.
 * Exported runOwnerImportTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/product-import/owner-import.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = ["PRODUCT_IMPORT_ENABLED", "OWNER_LOCK_ENFORCE_WRITES", "OWNER_VERIFIED_OWNER_GATE_ENABLED"];
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

export async function runOwnerImportTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../../database/init") as typeof import("../../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => undefined; console.error = () => undefined; }

  let oi: typeof import("./owner-import") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    oi = require("./owner-import") as typeof import("./owner-import");
    const robots = require("./robots") as typeof import("./robots");
    const router = (require("../../routes/owner-product-import") as any).default;
    const ks = require("../knowledge-service") as typeof import("../knowledge-service");
    const { runProductCatalogSync } = require("../product-catalog-sync") as typeof import("../product-catalog-sync");
    const cart = require("../cart-service") as typeof import("../cart-service");
    const { findOffers } = require("../catalog-offers") as typeof import("../catalog-offers");
    const { catalogRouter } = require("../../routes/marketplace-catalog") as typeof import("../../routes/marketplace-catalog");
    robots.__clearRobotsCacheForTesting();
    oi.__forgetOwnerFetchJobsForTesting();

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = {
      overview: handlerOf(router, "/api/agents/:id/product-import", "get"),
      fetch: handlerOf(router, "/api/agents/:id/product-import/fetch", "post"),
      run: handlerOf(router, "/api/agents/:id/product-import/runs/:runId", "get"),
      publish: handlerOf(router, "/api/agents/:id/product-import/runs/:runId/publish", "post"),
    };
    const invoke = (handler: Function, o: { params: Record<string, string>; token?: string; body?: any; headers?: Record<string, string>; query?: Record<string, string> }) =>
      new Promise<{ status: number; body: any }>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        const req: any = {
          method: "GET", params: o.params, body: o.body, query: o.query || {}, headers, cookies: {}, ip: "127.0.0.1",
          get: (n: string) => headers[n.toLowerCase()],
        };
        let status = 200;
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { resolve({ status, body: b }); return res; },
          send(b: any) { resolve({ status, body: b }); return res; },
          setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; },
        };
        try {
          const p = handler(req, res, () => resolve({ status: 0, body: "next" }));
          if (p && typeof p.catch === "function") p.catch((e: any) => resolve({ status: -1, body: String(e) }));
        } catch (e) { resolve({ status: -1, body: String(e) }); }
      });
    const totalChanges = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { verified: number; claimed?: boolean; website?: string | null; products?: unknown[]; claimEmail?: string }) => {
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
        ).run(`claim-${id}`, id, o.claimEmail ?? `post@${id}.example.no`);
      }
    };
    const tokens: Record<string, string> = {};
    const session = (id: string, email = `post@${id}.example.no`, name = id) => {
      tokens[name] = `tok-${name}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${name}`, email, tokens[name], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    };

    const OWN = "imp-own";
    const ownProducts = [
      { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual", confirmedAt: "2026-10-01T10:00:00.000Z" },
      { name: "Egg", category: "eggs", seasonal: false, price: "kr 55" },
      { name: "Gammel ost", category: "dairy", seasonal: false, price: "kr 90", source: "owner_manual", confirmedAt: "2026-10-01T10:00:00.000Z" },
    ];
    addAgent(OWN, { verified: 1, products: ownProducts });
    addAgent("imp-unver", { verified: 0 });             // claimed (customer rule) but agents.is_verified = 0
    addAgent("imp-ematch", { verified: 0, claimed: false }); // e-mail match only
    addAgent("imp-other", { verified: 1 });
    addAgent("imp-nosite", { verified: 1, website: "" });
    addAgent("imp-llm", { verified: 1 });
    addAgent("imp-robots", { verified: 1 });
    addAgent("imp-c1", { verified: 1 });
    addAgent("imp-c2", { verified: 1 });
    addAgent("imp-c3", { verified: 1 });
    for (const id of [OWN, "imp-unver", "imp-ematch", "imp-other", "imp-nosite", "imp-llm", "imp-robots", "imp-c1", "imp-c2", "imp-c3"]) session(id);
    session(OWN, "kollega@imp-own.example.no", "own-colleague"); // verified owner, not the claimant's address

    // Fake network: per-host fixtures, plus hold-able hosts for the cap test.
    const routes: Record<string, FakeRoute> = {
      ...shopifySite("imp-own.no", [
        { title: "Lammelår", handle: "lammelar", price: "289.00", variant: "1 kg" },
        { title: "Honning", handle: "honning", price: "120.00" },
        { title: "Eplecider", handle: "eplecider", price: "149.00" },
        { title: "Rabarbrasaft", handle: "rabarbrasaft", price: "59.00" },
      ]),
      ...shopifySite("imp-other.no", [{ title: "Poteter", handle: "poteter", price: "30.00" }]),
      "https://imp-llm.no/robots.txt": ROBOTS_OPEN,
      "https://imp-llm.no/": { body: HTML(`<a href="/priser">Priser</a><p>Velkommen til en liten gård med sau og høner langs elva.</p>`) },
      "https://imp-llm.no/priser": { body: HTML("<h1>Prisliste</h1><ul><li>Lammelår 250 kr/kg</li><li>Egg, 12 stk: 60,-</li></ul><p>Henting på gården lørdager.</p>") },
      "https://imp-robots.no/robots.txt": ROBOTS_CLOSED,
      ...shopifySite("imp-c3.no", [{ title: "Gulrøtter", handle: "gulrotter", price: "25.00" }]),
    };
    const fetchCalls: string[] = [];
    const holds: Array<() => void> = [];
    let holdHosts = new Set<string>();
    const fetchImpl = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      fetchCalls.push(url);
      const host = new URL(url).hostname;
      if (holdHosts.has(host)) await new Promise<void>((r) => holds.push(r));
      const r = routes[url] ?? { status: 404, body: HTML("404") };
      return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    let llmCalls = 0;
    const llm = async () => {
      llmCalls++;
      return { text: JSON.stringify([{ name: "Lammelår", price: "250 kr/kg", unit: "kg" }, { name: "Egg, 12 stk", price: "60,-", unit: "stk" }]) };
    };
    let clock = T0;
    oi.__setOwnerImportDepsForTesting({ fetchImpl, llm, now: () => clock, sleep: async () => undefined, hostIntervalMs: 0 });

    const fetchFor = (id: string, token = tokens[id]) => invoke(H.fetch, { params: { id }, token });
    const runFor = (id: string, runId: string, token = tokens[id]) => invoke(H.run, { params: { id, runId }, token });
    const publishFor = (id: string, runId: string, body: any, token = tokens[id], headers?: Record<string, string>) =>
      invoke(H.publish, { params: { id, runId }, token, body, headers });

    // ─── flag off → 404, nothing written ────────────────────────────────────
    {
      const before = totalChanges();
      const r = [
        await invoke(H.overview, { params: { id: OWN }, token: tokens[OWN] }),
        await fetchFor(OWN),
        await runFor(OWN, "x"),
        await publishFor(OWN, "x", { candidates: ["x"] }),
      ];
      assertEq(r.map((x) => x.status), [404, 404, 404, 404], "flag off: every route answers 404");
      assertEq(totalChanges(), before, "flag off: nothing written");
      assertEq(fetchCalls.length, 0, "flag off: nothing fetched");
    }
    process.env.PRODUCT_IMPORT_ENABLED = "1";

    // ─── AC9: ownership ─────────────────────────────────────────────────────
    {
      assertEq((await invoke(H.fetch, { params: { id: OWN } })).status, 401, "AC9: no session → 401");
      const unver = await fetchFor("imp-unver");
      assertEq([unver.status, unver.body.error], [403, "ownership_not_verified"], "AC9: claimed profile with is_verified=0 → 403");
      const ematch = await fetchFor("imp-ematch");
      assertEq(ematch.status, 403, "AC9: e-mail-match session without ownership (is_verified=0) → 403");
      assertEq((await invoke(H.overview, { params: { id: "imp-ematch" }, token: tokens["imp-ematch"] })).status, 403, "AC9: is_verified=0 → GET overview 403 too");
      const foreign = await fetchFor("imp-other", tokens[OWN]);
      assertEq([foreign.status, foreign.body.error], [403, "forbidden"], "AC9: a session for another agent id → 403");
      assertEq((await runFor("imp-other", "x", tokens[OWN])).status, 403, "AC9: foreign agent id → GET run 403");
      const cross = await invoke(H.fetch, { params: { id: OWN }, token: tokens[OWN], headers: { origin: "https://evil.example" } });
      assertEq(cross.status, 403, "AC9: cross-site POST → 403");
      const nosite = await fetchFor("imp-nosite");
      assertEq([nosite.status, nosite.body.error], [422, "no_website"], "AC9: no website → 422");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_runs").get(), { n: 0 }, "AC9: refused calls create no run row");
      assertEq(fetchCalls.length, 0, "AC9: refused calls fetch nothing");
      const ov = await invoke(H.overview, { params: { id: OWN }, token: tokens[OWN] });
      assertEq([ov.status, ov.body.fetches_left_today, ov.body.website], [200, 3, "https://imp-own.no"], "AC9: is_verified=1 → overview 200");
    }

    // ─── Fetch #1 (OWN) + AC10 ──────────────────────────────────────────────
    runProductCatalogSync(db as any);
    const knowledgeBefore = (db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).products;
    const productsBefore = JSON.stringify(db.prepare("SELECT * FROM products ORDER BY id").all());
    const f1 = await fetchFor(OWN);
    assertEq([f1.status, f1.body.status], [202, "running"], "AC9: is_verified=1 → POST fetch 202 running");
    assertTrue(typeof f1.body.run_id === "string" && f1.body.poll === `/api/agents/${OWN}/product-import/runs/${f1.body.run_id}`, "fetch: answers run_id + poll URL");
    const running = await runFor(OWN, f1.body.run_id);
    assertEq(running.body.status, "running", "fetch: GET while the job runs → running");
    await oi.__awaitOwnerFetchForTesting(f1.body.run_id);
    const run1 = f1.body.run_id as string;
    {
      assertEq((db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).products, knowledgeBefore,
        "AC10: agent_knowledge.products unchanged after the fetch");
      assertEq(JSON.stringify(db.prepare("SELECT * FROM products ORDER BY id").all()), productsBefore, "AC10: products table unchanged after the fetch");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM products WHERE name IN ('Honning','Rabarbrasaft','Eplecider')").get(), { n: 0 },
        "AC10: no catalog row for any candidate (cart cannot add them)");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_candidates WHERE run_id = ?").get(run1) as any).n, 4, "AC10: the 4 candidates are staged");
      const offers = await findOffers({ q: "Rabarbrasaft", lat: 59.91, lng: 10.75 }, { db: db as any, geocode: async () => null });
      assertTrue(!JSON.stringify(offers).includes("Rabarbrasaft") || offers.offers.length === 0, "AC10: lokal_find_offers does not list a candidate");
      const feed = await invoke(handlerOf(catalogRouter, "/feed", "get"), { params: {} });
      assertTrue(feed.status === 200 && !JSON.stringify(feed.body).includes("Rabarbrasaft") && !JSON.stringify(feed.body).includes("Eplecider"),
        "AC10: the ACP feed does not list a candidate");
      assertTrue(!(ks.knowledgeService.getKnowledge(OWN)?.products || []).some((p: any) => p.name === "Honning"), "AC10: the profile's product list has no candidate");
    }

    // ─── GET preview: diff, read-only ───────────────────────────────────────
    {
      const before = totalChanges();
      const p = await runFor(OWN, run1);
      const again = await runFor(OWN, run1);
      await invoke(H.overview, { params: { id: OWN }, token: tokens[OWN] });
      assertEq(totalChanges(), before, "GET: preview and overview write nothing");
      assertEq(JSON.stringify(again.body), JSON.stringify(p.body), "GET: repeated preview is identical");
      assertEq([p.status, p.body.status, p.body.outcome, p.body.tier], [200, "completed", "ok", "shopify"], "preview: completed, ok, shopify tier");
      assertEq(p.body.new.map((c: any) => c.name), ["Honning", "Eplecider", "Rabarbrasaft"], "preview: new products");
      assertEq(p.body.changed.map((c: any) => [c.name, c.old.price_nok, c.old.unit, c.price_nok, c.unit]), [["Lammelår", 250, "kg", 289, "kg"]],
        "preview: changed price, old → new");
      assertEq(p.body.not_found.map((c: any) => c.name), ["Egg", "Gammel ost"], "preview: products not found on the website");
      assertEq(p.body.counts, { new: 3, changed: 1, unchanged: 0, not_found: 2, published: 0, rejected: 0 }, "preview: counts");
      assertEq(p.body.new.find((c: any) => c.name === "Eplecider")?.publish_blocked, "alcohol", "preview: alcohol candidate marked as not publishable");
      assertTrue(p.body.new.every((c: any) => c.tier === "shopify" && c.llm === false && typeof c.source_url === "string"), "preview: tier + source_url per candidate");
      assertEq(p.body.message, null, "preview: no zero-result message when there are candidates");
      const run = db.prepare("SELECT mode, agent_id, status, outcome, count_new, count_changed, count_not_found, published_by_owner FROM product_import_runs WHERE id = ?").get(run1);
      assertEq(run, { mode: "owner_fetch", agent_id: OWN, status: "completed", outcome: "ok", count_new: 3, count_changed: 1, count_not_found: 2, published_by_owner: 0 },
        "log: one run row with outcome + counts, published_by_owner no");
      assertEq((await runFor(OWN, "pio-unknown")).status, 404, "preview: unknown run → 404");
    }

    // ─── AC11: publish ──────────────────────────────────────────────────────
    const cands = (await runFor(OWN, run1)).body;
    const idOf = (name: string) => [...cands.new, ...cands.changed].find((c: any) => c.name === name)!.id as string;
    {
      const notClaimant = await publishFor(OWN, run1, { candidates: [idOf("Honning")] }, tokens["own-colleague"]);
      assertEq([notClaimant.status, notClaimant.body.error], [403, "claimant_login_required"], "publish: a session not opened by the claimant's e-mail → 403");
      const cross = await publishFor(OWN, run1, { candidates: [idOf("Honning")] }, tokens[OWN], { origin: "https://evil.example" });
      assertEq(cross.status, 403, "publish: cross-site → 403");
      const foreign = await publishFor("imp-other", run1, { candidates: [idOf("Honning")] }, tokens[OWN]);
      assertEq(foreign.status, 403, "publish: foreign agent id → 403");
      const before = totalChanges();
      const bad = await publishFor(OWN, run1, { candidates: [{ id: idOf("Honning"), price: "abc" }, { id: idOf("Lammelår") }] });
      assertEq([bad.status, bad.body.error, bad.body.fields], [400, "invalid", [{ id: idOf("Honning"), field: "price" }]], "publish: a bad edited price → 400 naming the field");
      assertEq(totalChanges(), before, "publish: a 400 writes nothing");
      const other = await publishFor("imp-other", run1, { candidates: [idOf("Honning")] }, tokens["imp-other"]);
      assertEq(other.status, 404, "publish: another profile cannot publish this run's candidates (404)");

      const r = await publishFor(OWN, run1, {
        candidates: [{ id: idOf("Lammelår") }, { id: idOf("Honning"), price: "125" }, { id: idOf("Eplecider") }],
      });
      assertEq(r.status, 200, "AC11: publish selected → 200");
      assertEq(r.body.published.map((p: any) => [p.name, p.action]), [["Lammelår", "updated"], ["Honning", "added"]], "AC11: published (updated + added)");
      assertEq(r.body.rejected.map((p: any) => [p.name, p.reason]), [["Eplecider", "alcohol"]], "AC11: alcohol row rejected at publish");
      assertEq(r.body.catalog_sync, "ok", "AC11: catalog sync for the profile ran");
      const list = ks.knowledgeService.getKnowledge(OWN)!.products as any[];
      const lam = list.find((p) => p.name === "Lammelår");
      assertEq([lam.source, lam.price, lam.sourceUrl, lam.fetchedAt, lam.confirmedAt, lam.category],
        ["owner_import", "kr 289/kg", "https://imp-own.no/products/lammelar", new Date(T0).toISOString(), new Date(T0).toISOString(), "meat"],
        "AC11: updated product → source owner_import, sourceUrl, fetchedAt, confirmedAt; keeps its category");
      const hon = list.find((p) => p.name === "Honning");
      assertEq([hon?.source, hon?.price], ["owner_import", "kr 125"], "AC11: added product with the owner's edited price");
      assertEq(list.map((p) => p.name), ["Lammelår", "Egg", "Gammel ost", "Honning"], "AC11: merge, not replace — unselected products kept, «not found» not deleted");
      const egg = list.find((p) => p.name === "Egg");
      assertEq([egg.source, egg.confirmedAt], [undefined, undefined], "AC11: an untouched enrichment product keeps its provenance (not relabelled owner_manual)");
      assertEq(list.find((p) => p.name === "Gammel ost").source, "owner_manual", "AC11: an unselected manual product is kept as owner_manual");
      assertTrue(!list.some((p) => p.name === "Eplecider" || p.name === "Rabarbrasaft"), "AC11: rejected and unselected candidates are not on the profile");
      const locks = JSON.parse((db.prepare("SELECT curated_fields FROM agent_knowledge WHERE agent_id = ?").get(OWN) as any).curated_fields);
      assertEq(locks.products?.by, "owner", "AC11: owner lock set on products");
      const rows = db.prepare("SELECT name, source, price_nok, source_url, availability_source FROM products WHERE agent_id = ? AND name IN ('Lammelår','Honning') ORDER BY name").all(OWN);
      assertEq(rows, [
        { name: "Honning", source: "owner_import", price_nok: 125, source_url: null, availability_source: "enrichment" },
        { name: "Lammelår", source: "owner_import", price_nok: 289, source_url: "https://imp-own.no/products/lammelar", availability_source: "enrichment" },
      ].map((x) => x.name === "Honning" ? { ...x, source_url: "https://imp-own.no/products/honning" } : x), "AC11: catalog rows synced with source owner_import");
      const now = new Date();
      for (const name of ["Lammelår", "Honning"]) {
        const row = db.prepare("SELECT * FROM products WHERE agent_id = ? AND name = ?").get(OWN, name) as any;
        assertTrue(!cart.isRowOrderableForRealOrder(db as any, row, now), `AC11: ${name} is not orderable after import alone`);
        assertTrue(cart.orderabilityReasons(db as any, row, now).reasons.some((x) => x.code === "not_confirmed_by_owner"), `AC11: ${name} → not_confirmed_by_owner (needs «på lager»)`);
      }
      const runRow = db.prepare("SELECT count_published, count_removed, published_by_owner FROM product_import_runs WHERE id = ?").get(run1);
      assertEq(runRow, { count_published: 2, count_removed: 0, published_by_owner: 1 }, "log: run row records published_by_owner yes + count");
      const again = await publishFor(OWN, run1, { candidates: [idOf("Honning")] });
      assertEq([again.status, again.body.error], [409, "candidate_not_pending"], "publish: an already published candidate → 409");
      const after = (await runFor(OWN, run1)).body;
      assertEq([after.counts.published, after.counts.rejected, after.new.map((c: any) => c.name)], [2, 1, ["Rabarbrasaft"]], "preview: published/rejected moved out of the pending diff");
      const audit = db.prepare("SELECT field_name, changed_by_email FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'products.imported'").all(OWN);
      assertEq(audit, [{ field_name: "products.imported", changed_by_email: `post@${OWN}.example.no` }], "publish: audit row with the claimant's e-mail");

      // Owner lock holds against an enrichment write (OWNER_LOCK_ENFORCE_WRITES).
      process.env.OWNER_LOCK_ENFORCE_WRITES = "1";
      const skipped = ks.knowledgeService.upsertKnowledge(OWN, { products: [{ name: "Skrapt", category: "other", seasonal: false }], dataSource: "auto" }).skipped;
      delete process.env.OWNER_LOCK_ENFORCE_WRITES;
      assertTrue(skipped.some((s) => s.field === "products") && (ks.knowledgeService.getKnowledge(OWN)!.products as any[]).some((p) => p.name === "Honning"),
        "AC11: nightly enrichment cannot overwrite the imported list (owner lock)");
    }

    // ─── Fetch #2: category label / service rejected, explicit removal ──────
    clock = T0 + 60_000;
    const f2 = await fetchFor(OWN);
    assertEq(f2.status, 202, "AC12: 2nd fetch the same day → 202");
    await oi.__awaitOwnerFetchForTesting(f2.body.run_id);
    {
      const p = (await runFor(OWN, f2.body.run_id)).body;
      assertEq([p.unchanged.map((c: any) => c.name), p.changed.map((c: any) => c.name)], [["Lammelår"], ["Honning"]],
        "diff: after publish, Lammelår is unchanged and Honning (owner set 125) shows the website price as changed");
      const sid = (name: string) => [...p.new, ...p.changed, ...p.unchanged].find((c: any) => c.name === name)!.id;
      const r = await publishFor(OWN, f2.body.run_id, {
        candidates: [{ id: sid("Rabarbrasaft"), name: "Kjøtt", price: "" }, { id: sid("Eplecider"), name: "Omvisning på gården", price: "200" }],
        remove: ["Gammel ost", "Finnes ikke"],
      });
      assertEq(r.status, 200, "publish 2: 200");
      assertEq(r.body.rejected.map((x: any) => x.reason), ["category_label", "service"], "publish: a category label (no price) and a service are rejected");
      assertEq([r.body.published.length, r.body.removed, r.body.not_removed], [0, ["Gammel ost"], ["Finnes ikke"]], "publish: only the explicitly selected product is removed");
      const names = (ks.knowledgeService.getKnowledge(OWN)!.products as any[]).map((x) => x.name);
      assertEq(names, ["Lammelår", "Egg", "Honning"], "publish: removal drops only «Gammel ost»; «Egg» (not found) stays");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ? AND name = 'Gammel ost'").get(OWN), { n: 0 }, "publish: the removed product's unreferenced catalog row is deleted");
      assertEq((db.prepare("SELECT count_removed, published_by_owner FROM product_import_runs WHERE id = ?").get(f2.body.run_id) as any), { count_removed: 1, published_by_owner: 1 },
        "log: removal counted on the run row");
    }

    // ─── AC12: daily limit from the run table ───────────────────────────────
    {
      const f3 = await fetchFor(OWN);
      assertEq(f3.status, 202, "AC12: 3rd fetch the same day → 202");
      await oi.__awaitOwnerFetchForTesting(f3.body.run_id);
      const f4 = await fetchFor(OWN);
      assertEq([f4.status, f4.body.error], [429, "daily_limit"], "AC12: 4th fetch the same UTC day → 429");
      assertTrue(typeof f4.body.message === "string" && f4.body.message.includes("høyst 3 ganger per døgn"), "AC12: 429 has a clear Norwegian message");
      oi.__forgetOwnerFetchJobsForTesting(); // as after a restart: the count is the table's, not memory
      assertEq((await fetchFor(OWN)).status, 429, "AC12: still 429 after a restart (counted from the run table)");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_runs WHERE agent_id = ? AND mode = 'owner_fetch'").get(OWN) as any).n, 3,
        "AC12: refused fetches create no run row");
      clock = T0 + DAY;
      const next = await fetchFor(OWN);
      assertEq(next.status, 202, "AC12: the next UTC day → 202 again");
      await oi.__awaitOwnerFetchForTesting(next.body.run_id);
      clock = T0 + 120_000;
    }

    // ─── LLM tier allowed in the owner preview, and marked ──────────────────
    {
      const f = await fetchFor("imp-llm");
      await oi.__awaitOwnerFetchForTesting(f.body.run_id);
      const p = (await runFor("imp-llm", f.body.run_id)).body;
      assertEq([p.status, p.tier, llmCalls], ["completed", "llm", 1], "LLM: the LLM tier runs (one call) for the owner preview");
      assertTrue(p.new.length > 0 && p.new.every((c: any) => c.tier === "llm" && c.llm === true), "LLM: every candidate is marked tier llm");
    }

    // ─── Zero result explained ──────────────────────────────────────────────
    {
      const f = await fetchFor("imp-robots");
      await oi.__awaitOwnerFetchForTesting(f.body.run_id);
      const p = (await runFor("imp-robots", f.body.run_id)).body;
      assertEq([p.outcome, p.counts.new], ["robots_blocked", 0], "zero: robots_blocked, no candidates");
      assertTrue(String(p.message).startsWith("Fant ingen produkter med pris på nettsiden. Legg dem inn selv.") && String(p.message).includes("robots.txt"),
        "zero: Norwegian message with the outcome explained");
    }

    // ─── Concurrency cap, per-profile 409, timeout ──────────────────────────
    {
      holdHosts = new Set(["imp-c1.no", "imp-c2.no"]);
      const a = await fetchFor("imp-c1");
      const b = await fetchFor("imp-c2");
      assertEq([a.status, b.status], [202, 202], "cap: two simultaneous fetches accepted");
      const dup = await fetchFor("imp-c1");
      assertEq([dup.status, dup.body.error], [409, "fetch_running"], "cap: a second fetch of the same profile while one runs → 409");
      const c = await fetchFor("imp-c3");
      assertEq([c.status, c.body.error], [503, "busy"], "cap: a 3rd simultaneous fetch → 503");
      assertTrue(typeof c.body.message === "string" && c.body.message.includes("Prøv igjen"), "cap: Norwegian busy message");
      holdHosts = new Set();
      while (holds.length) holds.shift()!();
      await oi.__awaitOwnerFetchForTesting(a.body.run_id);
      await oi.__awaitOwnerFetchForTesting(b.body.run_id);
      while (holds.length) holds.shift()!();
      assertEq((await fetchFor("imp-c3")).status, 202, "cap: a slot frees when a fetch finishes");

      // A fetch that hangs past the job timeout → failed / timeout.
      oi.__setOwnerImportDepsForTesting({ fetchImpl, llm, now: () => clock, sleep: async () => undefined, hostIntervalMs: 0, jobTimeoutMs: 20 });
      holdHosts = new Set(["imp-other.no"]);
      const t = await fetchFor("imp-other");
      await new Promise((r) => setTimeout(r, 60));
      const tp = (await runFor("imp-other", t.body.run_id)).body;
      assertEq([tp.status, tp.outcome], ["failed", "timeout"], "timeout: a hung fetch ends as failed / timeout");
      holdHosts = new Set();
      while (holds.length) holds.shift()!();
      await oi.__awaitOwnerFetchForTesting(t.body.run_id);
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM product_import_candidates WHERE run_id = ?").get(t.body.run_id) as any).n, 0,
        "timeout: a late result is not staged");
      const pub = await publishFor("imp-other", t.body.run_id, { candidates: ["x"] });
      assertEq(pub.status, 409, "timeout: a failed run cannot be published");
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
  if (log) console.info(`\nowner-import: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerImportTests({ log: true }).then((r) => {
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

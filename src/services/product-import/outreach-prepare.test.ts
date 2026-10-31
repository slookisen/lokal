/**
 * outreach-prepare.test.ts — dev-request 2026-10-21-rfb-produktimport-fra-
 * egen-nettside, Skive 3b-1 (outreach pre-extraction, admin side only).
 *
 *   flag   PRODUCT_IMPORT_OUTREACH_ENABLED off → POST/GET 404, nothing written.
 *   AC16   no / wrong X-Admin-Key → 403; with key → 202, candidates staged in
 *          product_import_candidates only: agent_knowledge.products and
 *          products unchanged, lokal_find_offers and the ACP feed do not list
 *          them, the owner overview/preview/publish do not see the run, no
 *          e-mail send method is called.
 *   AC17   category label, alcohol, duplicate of an existing product (unchanged)
 *          and a price not in the source are never new; a changed price is a
 *          change; LLM tier excluded (and the LLM never called) when
 *          PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY is unset or 0.9, included at 0.96.
 *   skips  unknown agent / umbrella / no website recorded without fetching.
 *   limit  outreach rows do not count in ownerFetchesToday.
 *   report JSON + Norwegian markdown shape; GET writes nothing; 400 on bad input.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch and LLM injected (no network); fixed clock. Env restored in finally.
 * Exported runOutreachPrepareTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/product-import/outreach-prepare.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = ["PRODUCT_IMPORT_OUTREACH_ENABLED", "PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY"];
const T0 = Date.UTC(2026, 9, 31, 9, 0, 0);
const KEY = "test-admin-key";

type FakeRoute = { status?: number; body: string; contentType?: string };
const ROBOTS_OPEN: FakeRoute = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };
const HTML = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

export async function runOutreachPrepareTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const { emailService } = require("../email-service") as typeof import("../email-service");
  const patchedEmail: string[] = [];
  let op: typeof import("./outreach-prepare") | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    op = require("./outreach-prepare") as typeof import("./outreach-prepare");
    const oi = require("./owner-import") as typeof import("./owner-import");
    const robots = require("./robots") as typeof import("./robots");
    const router = (require("../../routes/admin-product-import") as any).default;
    const { runProductCatalogSync } = require("../product-catalog-sync") as typeof import("../product-catalog-sync");
    const { findOffers } = require("../catalog-offers") as typeof import("../catalog-offers");
    const { catalogRouter } = require("../../routes/marketplace-catalog") as typeof import("../../routes/marketplace-catalog");
    robots.__clearRobotsCacheForTesting();

    // No e-mail may be sent: count every send* method of the shared service.
    let emailCalls = 0;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(emailService))) {
      if (!name.startsWith("send") || typeof (emailService as any)[name] !== "function") continue;
      patchedEmail.push(name);
      (emailService as any)[name] = async () => { emailCalls++; return { success: true }; };
    }

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = { post: handlerOf(router, "/prepare", "post"), get: handlerOf(router, "/prepare/:campaign", "get") };
    const invoke = (handler: Function, o: { params?: Record<string, string>; key?: string | null; body?: any; query?: Record<string, string> }) =>
      new Promise<{ status: number; body: any; type: string | null }>((resolve) => {
        const headers: Record<string, string> = {};
        if (typeof o.key === "string") headers["x-admin-key"] = o.key;
        const req: any = { params: o.params || {}, body: o.body, query: o.query || {}, headers, get: (n: string) => headers[n.toLowerCase()] };
        let status = 200;
        let type: string | null = null;
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { resolve({ status, body: b, type }); return res; },
          send(b: any) { resolve({ status, body: b, type }); return res; },
          type(t: string) { type = t; return res; }, setHeader() { return res; }, set() { return res; },
        };
        try { handler(req, res, () => resolve({ status: 0, body: "next", type })); }
        catch (e) { resolve({ status: -1, body: String(e), type }); }
      });
    const post = (body: any, key: string | null = KEY) => invoke(H.post, { body, key });
    const report = (campaign: string, query?: Record<string, string>, key: string | null = KEY) =>
      invoke(H.get, { params: { campaign }, query, key });
    const totalChanges = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { website?: string | null; products?: unknown[]; umbrella?: string | null }) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, vertical_id, umbrella_type)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), 'rfb', ?)`,
      ).run(id, `Gard ${id}`, `post@${id}.example.no`, `key-${id}`, o.umbrella ?? null);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, ?, 'hybrid', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, o.website === undefined ? `https://${id}.no` : o.website, JSON.stringify(o.products ?? []));
    };
    const existing = [
      { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual" },
      { name: "Pølse", category: "meat", seasonal: false, price: "kr 89", priceUnit: "kr", source: "owner_manual" },
    ];
    addAgent("op-shop", { products: existing });
    addAgent("op-llm", { products: [existing[0]] });
    addAgent("op-umb", { umbrella: "cooperative" });
    addAgent("op-nosite", { website: "" });

    const routes: Record<string, FakeRoute> = {
      "https://op-shop.no/robots.txt": ROBOTS_OPEN,
      "https://op-shop.no/products.json?limit=250": {
        contentType: "application/json",
        body: JSON.stringify({ products: [
          { title: "Honning", handle: "honning", variants: [] },                                  // category label, no price
          { title: "Eplecider", handle: "eplecider", variants: [{ title: "Default Title", price: "149.00" }] }, // alcohol
          { title: "Lammelår", handle: "lammelar", variants: [{ title: "1 kg", price: "289.00" }] }, // changed price
          { title: "Pølse", handle: "polse", variants: [{ title: "Default Title", price: "89.00" }] },  // unchanged duplicate
          { title: "Rabarbrasaft", handle: "rabarbrasaft", variants: [{ title: "Default Title", price: "59.00" }] },
          { title: "Gulrøtter", handle: "gulrotter", variants: [{ title: "Default Title", price: "25.00" }] },
        ] }),
      },
      "https://op-llm.no/robots.txt": ROBOTS_OPEN,
      "https://op-llm.no/": { body: HTML(`<a href="/priser">Priser</a><p>Velkommen til en liten gård med sau og høner langs elva.</p>`) },
      "https://op-llm.no/priser": { body: HTML(
        "<h1>Prisliste</h1><ul><li>Kjøtt</li><li>Eplecider 149 kr</li><li>Lammelår 250 kr/kg</li><li>Speltbrød 65 kr</li><li>Rabarbrasaft 59 kr</li></ul><p>Henting på gården lørdager.</p>") },
    };
    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      fetchCalls.push(url);
      const r = routes[url] ?? { status: 404, body: HTML("404") };
      return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    let llmCalls = 0;
    const llm = async () => {
      llmCalls++;
      return { text: JSON.stringify([
        { name: "Kjøtt", price: null },                                // category label
        { name: "Eplecider", price: "149 kr" },                       // alcohol
        { name: "Lammelår", price: "250 kr/kg", unit: "kg" },         // duplicate, unchanged
        { name: "Speltbrød", price: "75 kr" },                        // price not in the source
        { name: "Rabarbrasaft", price: "59 kr" },                     // the one new product
      ]) };
    };
    let clock = T0;
    op.__setOutreachDepsForTesting({ fetchImpl, llm, now: () => clock, sleep: async () => undefined, hostIntervalMs: 0 });
    process.env.ADMIN_KEY = KEY;

    // ─── flag off → 404, nothing written ────────────────────────────────────
    {
      const before = totalChanges();
      const r = [await post({ agentIds: ["op-shop"], campaign: "host-2026" }), await report("host-2026")];
      assertEq(r.map((x) => x.status), [404, 404], "flag off: POST and GET answer 404");
      assertEq([totalChanges(), fetchCalls.length], [before, 0], "flag off: nothing written, nothing fetched");
    }
    process.env.PRODUCT_IMPORT_OUTREACH_ENABLED = "1";

    // ─── AC16: admin key; validation ────────────────────────────────────────
    {
      assertEq((await post({ agentIds: ["op-shop"], campaign: "host-2026" }, null)).status, 403, "AC16: no admin key → 403");
      assertEq((await post({ agentIds: ["op-shop"], campaign: "host-2026" }, "wrong")).status, 403, "AC16: wrong admin key → 403");
      assertEq((await report("host-2026", undefined, null)).status, 403, "AC16: GET report without key → 403");
      const bad = [
        await post({ agentIds: ["op-shop"], campaign: "Bad Campaign" }),
        await post({ agentIds: ["op-shop"], campaign: "x" }),
        await post({ agentIds: ["op-shop"] }),
        await post({ agentIds: [], campaign: "host-2026" }),
        await post({ agentIds: "op-shop", campaign: "host-2026" }),
        await post({ agentIds: [" "], campaign: "host-2026" }),
        await post({ agentIds: Array.from({ length: 201 }, (_, i) => `a${i}`), campaign: "host-2026" }),
      ];
      assertEq(bad.map((x) => x.status), [400, 400, 400, 400, 400, 400, 400], "validation: bad campaign / empty, non-list, blank or >200 agentIds → 400");
      assertEq(bad.map((x) => x.body.error).slice(0, 4), ["invalid_campaign", "invalid_campaign", "invalid_campaign", "invalid_agent_ids"], "validation: error codes");
      assertEq((await report("Bad_Campaign")).status, 400, "validation: GET with a bad campaign slug → 400");
      assertEq((await report("ingen-slik")).status, 404, "report: unknown campaign → 404");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_runs").get(), { n: 0 }, "refused calls create no run row");
    }

    // ─── Prepare #1 (LLM accuracy unset) ────────────────────────────────────
    runProductCatalogSync(db as any);
    const knowledgeBefore = JSON.stringify(db.prepare("SELECT agent_id, products FROM agent_knowledge ORDER BY agent_id").all());
    const productsBefore = JSON.stringify(db.prepare("SELECT * FROM products ORDER BY id").all());
    const p1 = await post({ agentIds: ["op-shop", "op-llm", "op-umb", "op-nosite", "op-unknown", "op-shop"], campaign: "host-2026" });
    assertEq([p1.status, p1.body.status, p1.body.recipients_total, p1.body.to_fetch, p1.body.skipped, p1.body.llm_included],
      [202, "running", 5, 2, 3, false], "AC16: with key → 202, de-duplicated, 3 skipped, LLM not included");
    assertTrue(typeof p1.body.prepare_id === "string" && p1.body.poll === "/admin/product-import/prepare/host-2026", "AC16: answers prepare_id + poll URL");
    const busy = await post({ agentIds: ["op-shop"], campaign: "host-2026" });
    assertEq([busy.status, busy.body.prepare_id], [409, p1.body.prepare_id], "a second prepare while one runs → 409");
    await op.__awaitOutreachPrepareForTesting(p1.body.prepare_id);
    {
      assertEq(llmCalls, 0, "AC17: accuracy unset → the LLM is never called");
      assertTrue(!fetchCalls.some((u) => /op-umb|op-nosite|op-unknown/.test(u)), "skips: nothing fetched for umbrella / no website / unknown");
      const runs = db.prepare(
        "SELECT agent_id, mode, status, outcome, campaign, prepare_id FROM product_import_runs WHERE campaign = 'host-2026' ORDER BY agent_id").all() as any[];
      assertEq(runs.map((r) => [r.agent_id, r.mode, r.status, r.outcome]), [
        ["op-llm", "outreach_prepare", "completed", "no_products_found"],
        ["op-nosite", "outreach_prepare", "completed", "skipped_no_website"],
        ["op-shop", "outreach_prepare", "completed", "ok"],
        ["op-umb", "outreach_prepare", "completed", "skipped_umbrella"],
        ["op-unknown", "outreach_prepare", "completed", "skipped_unknown_agent"],
      ], "log: one outreach_prepare run per recipient with its outcome");
      assertTrue(runs.every((r) => r.prepare_id === p1.body.prepare_id), "log: every run carries the prepare id");
      const c = db.prepare(
        "SELECT name, status, reject_reason, diff_kind, old_price_nok FROM product_import_candidates WHERE agent_id = 'op-shop' ORDER BY position").all();
      assertEq(c, [
        { name: "Honning", status: "rejected", reject_reason: "category_label", diff_kind: null, old_price_nok: null },
        { name: "Eplecider", status: "rejected", reject_reason: "alcohol", diff_kind: null, old_price_nok: null },
        { name: "Lammelår", status: "eligible", reject_reason: null, diff_kind: "changed", old_price_nok: 250 },
        { name: "Pølse", status: "unchanged", reject_reason: null, diff_kind: "unchanged", old_price_nok: 89 },
        { name: "Rabarbrasaft", status: "eligible", reject_reason: null, diff_kind: "new", old_price_nok: null },
        { name: "Gulrøtter", status: "eligible", reject_reason: null, diff_kind: "new", old_price_nok: null },
      ], "AC17: category label + alcohol rejected (audited), duplicate unchanged, changed price a change, rest new");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_candidates WHERE status = 'pending'").get(), { n: 0 },
        "staging: no outreach candidate is ever 'pending' (owner publish needs pending)");

      // AC16 / point 5: nothing public, nothing for the owner.
      assertEq(JSON.stringify(db.prepare("SELECT agent_id, products FROM agent_knowledge ORDER BY agent_id").all()), knowledgeBefore,
        "AC16: agent_knowledge unchanged after prepare");
      assertEq(JSON.stringify(db.prepare("SELECT * FROM products ORDER BY id").all()), productsBefore, "AC16: products table unchanged after prepare");
      const offers = await findOffers({ q: "Rabarbrasaft", lat: 59.91, lng: 10.75 }, { db: db as any, geocode: async () => null });
      assertTrue(!JSON.stringify((offers as any).offers ?? []).includes("Rabarbrasaft"), "AC16: lokal_find_offers does not list a prepared candidate");
      const feed = await invoke(handlerOf(catalogRouter, "/feed", "get"), {});
      assertTrue(feed.status === 200 && !JSON.stringify(feed.body).includes("Rabarbrasaft") && !JSON.stringify(feed.body).includes("Gulr"),
        "AC16: the ACP feed does not list a prepared candidate");
      const shopRun = (db.prepare("SELECT id FROM product_import_runs WHERE agent_id = 'op-shop'").get() as { id: string }).id;
      assertEq(oi.getOwnerImportPreview("op-shop", shopRun), null, "owner: the preview does not show an outreach run as the owner's");
      const ov = oi.getOwnerImportOverview("op-shop", clock);
      assertEq([ov.runs.length, ov.fetches_today, ov.fetches_left_today], [0, 0, 3], "owner: overview lists no outreach run, 3 fetches left");
      assertEq(oi.ownerFetchesToday("op-shop", clock), 0, "limit: outreach rows do not count in ownerFetchesToday");
      const pub = oi.publishOwnerImport("op-shop", shopRun, [{ id: "x" }], [], { actorEmail: null });
      assertEq(pub.ok ? 0 : pub.status, 404, "owner: publish of an outreach run → 404");
      assertEq(emailCalls, 0, "AC16: no e-mail send method was called");
    }

    // ─── Report JSON / md (read-only) ───────────────────────────────────────
    {
      const before = totalChanges();
      const r = await report("host-2026");
      const md = await report("host-2026", { format: "md" });
      assertEq(totalChanges(), before, "GET: the report writes nothing");
      assertEq([r.status, r.body.campaign, r.body.published, r.body.emails_sent, r.body.generated_at], [200, "host-2026", false, 0, new Date(T0).toISOString()],
        "report: campaign, nothing published or sent, generated time");
      assertEq(r.body.totals, { recipients: 5, with_new_or_changed: 1, new: 2, changed: 1, rejected: 2, running: 0,
        by_outcome: { no_products_found: 1, skipped_no_website: 1, ok: 1, skipped_umbrella: 1, skipped_unknown_agent: 1 } }, "report: totals");
      const shop = r.body.recipients.find((x: any) => x.agent_id === "op-shop");
      assertEq([shop.name, shop.outcome, shop.counts, shop.tiers], ["Gard op-shop", "ok",
        { new: 2, changed: 1, unchanged: 1, rejected: 2, rejected_by_reason: { category_label: 1, alcohol: 1 } }, ["shopify"]],
        "report: per recipient name, outcome, counts by reason, tiers");
      assertEq(shop.examples.map((e: any) => [e.kind, e.name, e.price_nok, e.old_price_nok]),
        [["new", "Rabarbrasaft", 59, null], ["new", "Gulrøtter", 25, null], ["changed", "Lammelår", 289, 250]], "report: up to three examples, new first");
      assertTrue(shop.examples.every((e: any) => typeof e.source_url === "string" && "unit" in e), "report: examples carry unit + source URL");
      const llmRec = r.body.recipients.find((x: any) => x.agent_id === "op-llm");
      assertEq([llmRec.llm.included, llmRec.llm.status, llmRec.counts.new], [false, "budget_exhausted", 0], "report: LLM tier marked as not used");
      assertEq([md.status, md.type], [200, "text/markdown; charset=utf-8"], "md: text/markdown");
      const text = String(md.body);
      assertTrue(text.startsWith("# Forhåndsuttrekk av produkter – kampanje host-2026\n"), "md: Norwegian title");
      assertTrue(text.includes(`Generert: ${new Date(T0).toISOString()}`) && text.includes("ingen e-post er sendt"), "md: generated time + nothing sent");
      assertTrue(text.includes("- Nye produkter: 2") && text.includes("- Endrede priser: 1"), "md: totals");
      assertEq((text.match(/^## Gard op-|^## op-unknown/gm) || []).length, 5, "md: one section per recipient");
      assertTrue(text.includes("Hoppet over: paraplyprofil") && text.includes("Hoppet over: profilen har ingen nettside"), "md: skip outcomes in Norwegian");
      assertTrue(text.includes("kr 250 → kr 289/kg (endret)") && text.includes("kategorinavn 1"), "md: changed price and rejection reasons");
    }

    // ─── AC17: LLM accuracy 0.9 → excluded; 0.96 → included ─────────────────
    {
      process.env.PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY = "0.9";
      const a = await post({ agentIds: ["op-llm"], campaign: "host-2026-llm" });
      assertEq(a.body.llm_included, false, "AC17: accuracy 0.9 → LLM not included");
      await op.__awaitOutreachPrepareForTesting(a.body.prepare_id);
      assertEq(llmCalls, 0, "AC17: accuracy 0.9 → the LLM is never called");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM product_import_candidates WHERE tier = 'llm'").get(), { n: 0 }, "AC17: accuracy 0.9 → no LLM candidate staged");

      process.env.PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY = "0.96";
      clock = T0 + 60_000;
      const b = await post({ agentIds: ["op-llm"], campaign: "host-2026-llm" });
      assertEq(b.body.llm_included, true, "AC17: accuracy 0.96 → LLM included");
      await op.__awaitOutreachPrepareForTesting(b.body.prepare_id);
      assertEq(llmCalls, 1, "AC17: accuracy 0.96 → one LLM call");
      const c = db.prepare(
        `SELECT c.name, c.status, c.reject_reason, c.diff_kind FROM product_import_candidates c
          JOIN product_import_runs r ON r.id = c.run_id WHERE r.prepare_id = ? ORDER BY c.position`).all(b.body.prepare_id);
      assertEq(c, [
        { name: "Kjøtt", status: "rejected", reject_reason: "category_label", diff_kind: null },
        { name: "Eplecider", status: "rejected", reject_reason: "alcohol", diff_kind: null },
        { name: "Lammelår", status: "unchanged", reject_reason: null, diff_kind: "unchanged" },
        { name: "Speltbrød", status: "rejected", reject_reason: "price_not_anchored", diff_kind: null },
        { name: "Rabarbrasaft", status: "eligible", reject_reason: null, diff_kind: "new" },
      ], "AC17: LLM tier — label, alcohol, duplicate and unanchored price never new; one new");
      const r = await report("host-2026-llm");
      assertEq(r.body.recipients.length, 1, "report: latest run per recipient only");
      const rec = r.body.recipients[0];
      assertEq([rec.counts.new, rec.tiers, rec.llm.included, rec.examples.map((e: any) => e.name)], [1, ["llm"], true, ["Rabarbrasaft"]],
        "report: LLM recipient counts, tier and example");
      for (const v of ["abc", "1.5", "-1"]) {
        process.env.PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY = v;
        assertEq(op.outreachLlmAllowed(), false, `AC17: invalid accuracy ${JSON.stringify(v)} → below threshold`);
      }
      assertEq(JSON.stringify(db.prepare("SELECT * FROM products ORDER BY id").all()), productsBefore, "AC16: products unchanged after every prepare");
      assertEq(emailCalls, 0, "AC16: still no e-mail send method called");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err?.message || err)}`);
  } finally {
    op?.__setOutreachDepsForTesting(null);
    for (const name of patchedEmail) delete (emailService as any)[name];
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
  runOutreachPrepareTests({ log: true }).then((r) => {
    console.info(`\noutreach-prepare: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

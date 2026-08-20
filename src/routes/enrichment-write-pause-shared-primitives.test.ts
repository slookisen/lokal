/**
 * enrichment-write-pause-shared-primitives.test.ts — dev-request
 * 2026-08-20-enrichment-write-pause-mekanisk-gjerde, PR review finding 1.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * The first cut of the write-pause gate wired itself into four HTTP handlers.
 * Review found the placement wrong: `lokal-agent-enrichment` — the routine
 * that wrote to prod through a live pause on 2026-08-20 — mostly does NOT call
 * those four, while at least five write paths it DOES call were left open. Per-
 * handler gating had already failed once, at the very first attempt, so the fix
 * pushes enforcement DOWN to the shared write primitives (marketplaceRegistry
 * .register, applyRfbAgentWebsite) as well as onto the specific handlers the
 * SKILL actually names.
 *
 * This suite is that fix's proof. It is a SIBLING of
 * admin-enrichment-write-pause.test.ts rather than an extension of it because
 * it needs a different, much larger module set (routes/marketplace.ts,
 * routes/admin-rfb-website-discovery.ts, the two extra routers exported from
 * routes/admin-knowledge.ts) and the real marketplaceRegistry singleton — the
 * same one-file-per-concern convention the rest of src/routes/*.test.ts follows.
 *
 * Every surface below is asserted twice, and the load-bearing claim is measured
 * with SQLite's own `total_changes()`, never inferred from a response body:
 *
 *   pause ACTIVE   ⇒ HTTP 423, the shared {paused, vertical, reason,
 *                    triggered_at, fail_closed} body, and ZERO rows changed.
 *   pause INACTIVE ⇒ byte-identical behaviour to before the gate existed.
 *
 * Surfaces covered (file:handler — the six from the review, plus the two shared
 * primitives and the public register route that inherits from one of them):
 *   1. marketplace.ts        POST /admin/register          (SKILL PHASE 1)
 *   2. marketplace.ts        POST /register                (public, inherits)
 *   3. marketplace-registry  register()                    (shared primitive)
 *   4. marketplace.ts        POST /admin/homepage-provenance-batch (PHASE 2B/2D)
 *   5. marketplace.ts        POST /admin/google-rating-batch       (PHASE 2F)
 *   6. admin-rfb-website-…   POST /rfb-website-review-approve?apply=1 (PHASE 3)
 *   7. admin-rfb-website-…   applyRfbAgentWebsite()        (shared primitive)
 *   8. admin-knowledge.ts    POST /admin/prune-dead-urls?apply=1    (PHASE 4)
 *   9. admin-knowledge.ts    POST /admin/homepage-content-refresh?apply=1 (PH 5)
 *
 * No outbound network: every "pause inactive" fixture is deliberately shaped so
 * the handler's own pre-fetch guards short-circuit before any fetch() — an
 * agent with neither agent_knowledge.website nor agents.url yields `no_data` /
 * an empty target set. The paused cases never reach a fetch by construction:
 * the gate sits in front of it, which is itself part of what is asserted.
 *
 * Exported runEnrichmentWritePauseSharedPrimitivesTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/enrichment-write-pause-shared-primitives.test.ts
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

export async function runEnrichmentWritePauseSharedPrimitivesTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try {
      return getDb();
    } catch {
      return undefined;
    }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const prevBrregFlag = process.env.BRREG_VERIFY_ON_REGISTER;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "ewp-shared-primitives-test-key";

  // ── req/res harness — the real handler pulled off the router's own stack,
  // invoked directly (same convention as marketplace-quarantine-gates.test.ts).
  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  function makeReq(o: { body?: any; query?: Record<string, string>; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { "x-admin-key": ADMIN_KEY };
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      params: {},
      body: o.body ?? {},
      query: o.query || {},
      headers,
      ip: "127.0.0.1",
      lang: "no",
      protocol: "https",
      get(name: string) {
        if (name.toLowerCase() === "host") return "rettfrabonden.com";
        return headers[name.toLowerCase()];
      },
    };
  }

  function invokeHandler(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => {
        if (settled) return;
        settled = true;
        resolve({ status, body });
      };
      const res: any = {
        status(c: number) {
          status = c;
          return res;
        },
        json(payload: any) {
          settle(payload);
          return res;
        },
        send(payload: any) {
          settle(payload);
          return res;
        },
        end() {
          settle(undefined);
          return res;
        },
        header() {
          return res;
        },
        set() {
          return res;
        },
        type() {
          return res;
        },
        setHeader() {
          return res;
        },
      };
      try {
        const maybePromise = handler(req, res, () => settle({ __next: true }));
        if (maybePromise && typeof maybePromise.catch === "function") {
          maybePromise.catch((err: any) => settle({ __error: String(err?.message ?? err) }));
        }
      } catch (err: any) {
        settle({ __error: String(err?.message ?? err) });
      }
    });
  }

  try {
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    // Keep the Brreg-verify slice of POST /register out of this suite — it is
    // covered elsewhere and would only add network-shaped noise.
    delete process.env.BRREG_VERIFY_ON_REGISTER;

    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // marketplace.ts / seo-adjacent code paths call getConfig(); cold-load the
    // vertical configs best-effort, same as the sibling suites.
    try {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as
        typeof import("../config/vertical-config");
      loadConfigsAtBoot();
    } catch {
      /* already loaded by another suite, or dir missing in CI */
    }

    // Fresh requires so no stale closure from an earlier suite keeps a
    // different DB handle alive.
    for (const m of [
      "./marketplace",
      "./admin-rfb-website-discovery",
      "./admin-knowledge",
      "../services/marketplace-registry",
    ]) {
      try {
        delete require.cache[require.resolve(m)];
      } catch {
        /* ignore */
      }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const rfbWdMod = require("./admin-rfb-website-discovery") as
      typeof import("./admin-rfb-website-discovery");
    const knowledgeMod = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;

    const svc = require("../services/enrichment-write-pause") as
      typeof import("../services/enrichment-write-pause");

    const adminRegisterPost = findRouteHandler(marketplaceRouter, "/admin/register", "post");
    const publicRegisterPost = findRouteHandler(marketplaceRouter, "/register", "post");
    const provenanceBatchPost = findRouteHandler(
      marketplaceRouter,
      "/admin/homepage-provenance-batch",
      "post",
    );
    const googleRatingBatchPost = findRouteHandler(marketplaceRouter, "/admin/google-rating-batch", "post");
    const websiteApprovePost = findRouteHandler(
      (rfbWdMod as any).default,
      "/rfb-website-review-approve",
      "post",
    );
    // Found by walking the SKILL's own call list rather than named in the
    // review: PHASE 2D's first PUT (the single most-used enrichment write) and
    // its batch sibling.
    const knowledgePutHandler = (() => {
      const layer = (marketplaceRouter.stack as any[]).find(
        (l: any) => l.route && l.route.path === "/agents/:id/knowledge" && l.route.methods?.put,
      );
      if (!layer) throw new Error("route not found: PUT /agents/:id/knowledge");
      return layer.route.stack[layer.route.stack.length - 1].handle as Function;
    })();
    const bulkEnrichPost = findRouteHandler(marketplaceRouter, "/admin/bulk-enrich", "post");
    const googleRatingSinglePost = findRouteHandler(marketplaceRouter, "/admin/google-rating/:id", "post");
    const prunePost = findRouteHandler((knowledgeMod as any).pruneUrlsRouter, "/prune-dead-urls", "post");
    const hcrPost = findRouteHandler(
      (knowledgeMod as any).homepageContentRefreshRouter,
      "/homepage-content-refresh",
      "post",
    );

    assertTrue(!!adminRegisterPost, "shp-01: POST /api/marketplace/admin/register handler found");
    assertTrue(!!publicRegisterPost, "shp-02: POST /api/marketplace/register handler found");
    assertTrue(!!provenanceBatchPost, "shp-03: POST /admin/homepage-provenance-batch handler found");
    assertTrue(!!googleRatingBatchPost, "shp-04: POST /admin/google-rating-batch handler found");
    assertTrue(!!websiteApprovePost, "shp-05: POST /admin/rfb-website-review-approve handler found");
    assertTrue(!!prunePost, "shp-06: POST /admin/prune-dead-urls handler found");
    assertTrue(!!hcrPost, "shp-07: POST /admin/homepage-content-refresh handler found");

    // ── Fixtures ───────────────────────────────────────────────────────────
    // RFB agent: junk website (prune bait), blank knowledge.website for the
    // website-approve lever, NO agents.url so nothing ever tries to fetch.
    const insertAgent = testDb.prepare(
      // url = '' (not NULL — the column is NOT NULL) so every homepage-fetching
      // handler's own "no usable homepage" guard short-circuits BEFORE any
      // outbound fetch: this suite makes no network calls, in either mode.
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
         VALUES (?, ?, 'test agent', 'test', ?, '', 'producer', ?, ?, NULL)`,
    );
    insertAgent.run("shp-rfb", "Gjerde Gård AS", "post@gjerde.no", "key-shp-rfb", "rfb");
    testDb
      .prepare(
        `INSERT INTO agent_knowledge (agent_id, website, curated_fields, field_provenance, updated_at)
           VALUES (?, NULL, '{}', '{}', datetime('now'))`,
      )
      .run("shp-rfb");

    // A junk-website RFB agent for prune-dead-urls.
    insertAgent.run("shp-junk", "Junk URL AS", "post@junk.no", "key-shp-junk", "rfb");
    testDb
      .prepare(
        `INSERT INTO agent_knowledge (agent_id, website, curated_fields, field_provenance, updated_at)
           VALUES (?, 'https://www.yelp.com/search?find_desc=farmers+market', '{}', '{}', datetime('now'))`,
      )
      .run("shp-junk");

    // A DENTAL agent, so the per-vertical claim can be shown to still hold on
    // the newly gated surfaces and not only on the original four.
    insertAgent.run("shp-dental", "Tannklinikk AS", "post@tann.no", "key-shp-dental", "dental");
    testDb
      .prepare(
        `INSERT INTO agent_knowledge (agent_id, website, curated_fields, field_provenance, updated_at)
           VALUES (?, NULL, '{}', '{}', datetime('now'))`,
      )
      .run("shp-dental");

    // Queue row the website-approve lever reads (the table is created lazily by
    // the route itself; create it here so we can seed before the first call).
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS agents_website_review_queue (
        agent_id TEXT PRIMARY KEY,
        candidate_url TEXT,
        final_url TEXT,
        batch_id TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    function seedQueueRow(): void {
      testDb
        .prepare(
          `INSERT INTO agents_website_review_queue
             (agent_id, candidate_url, final_url, batch_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
           ON CONFLICT(agent_id) DO UPDATE SET status='pending', updated_at=datetime('now')`,
        )
        .run("shp-rfb", "https://www.gjerdegard.no", "https://www.gjerdegard.no", "shp-batch");
    }
    seedQueueRow();

    // ── Helpers ────────────────────────────────────────────────────────────
    function totalChanges(): number {
      return (testDb.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    }
    function agentCount(): number {
      return (testDb.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    }
    function websiteOf(id: string): string | null {
      const r = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = ?").get(id) as
        | { website: string | null }
        | undefined;
      return r ? r.website : null;
    }
    function setPause(enabled: boolean, vertical = "rfb"): void {
      svc.setEnrichmentWritePause(
        testDb as any,
        enabled
          ? { vertical: vertical as any, enabled: true, reason: PAUSE_REASON, triggered_by: "platform-verifier" }
          : { vertical: vertical as any, enabled: false, cleared_by: "daniel" },
        "test",
      );
    }
    const PAUSE_REASON = "verifier: skrivepause under opprydding";

    /** Every 423 body must be the SAME shape, built by the same code. */
    function assertPausedBody(body: any, prefix: string): void {
      assertEq(body?.paused, true, `${prefix}: … paused:true`);
      assertEq(body?.vertical, "rfb", `${prefix}: … vertical resolved to rfb`);
      assertEq(body?.reason, PAUSE_REASON, `${prefix}: … the stored reason is surfaced verbatim`);
      assertTrue(typeof body?.triggered_at === "string", `${prefix}: … triggered_at surfaced`);
      assertEq(body?.fail_closed, false, `${prefix}: … flagged a real pause, not a lookup failure`);
    }

    let seq = 0;
    function adminRegisterBody(): any {
      seq++;
      return { name: `Ny Produsent ${seq}`, url: `https://www.nyprodusent${seq}.no`, role: "producer" };
    }
    function publicRegisterBody(): any {
      seq++;
      return {
        name: `Selvregistrert ${seq}`,
        description: "En ekte produsent som selger grønnsaker direkte fra gården sin.",
        provider: `Selvregistrert ${seq}`,
        contactEmail: `post${seq}@selvreg.example`,
        url: `https://www.selvreg${seq}.example`,
        role: "producer",
        skills: [{ id: "sell-vegetables", name: "Grønnsaker", description: "Selger grønnsaker", tags: ["grønt"] }],
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // (A) PAUSE ACTIVE — every newly gated surface answers 423, changes 0 rows
    // ═══════════════════════════════════════════════════════════════════════
    setPause(true);

    const agentsBefore = agentCount();
    const junkWebsiteBefore = websiteOf("shp-junk");
    const changesBefore = totalChanges();

    let r = await invokeHandler(adminRegisterPost, makeReq({ body: adminRegisterBody() }));
    assertEq(r.status, 423, "shp-10: paused POST /api/marketplace/admin/register -> 423 (the endpoint the SKILL actually calls)");
    assertPausedBody(r.body, "shp-11");

    r = await invokeHandler(publicRegisterPost, makeReq({ body: publicRegisterBody() }));
    assertEq(r.status, 423, "shp-12: paused PUBLIC POST /api/marketplace/register -> 423 (it creates a real rfb row too)");
    assertPausedBody(r.body, "shp-13");

    r = await invokeHandler(
      provenanceBatchPost,
      makeReq({ body: { agentIds: ["shp-rfb"], limit: 5 } }),
    );
    assertEq(r.status, 423, "shp-14: paused POST /admin/homepage-provenance-batch -> 423");
    assertPausedBody(r.body, "shp-15");

    process.env.GOOGLE_PLACES_API_KEY = "test-places-key-never-used";
    r = await invokeHandler(
      googleRatingBatchPost,
      makeReq({ body: { agentIds: ["shp-rfb"], include_address_phone: true } }),
    );
    assertEq(r.status, 423, "shp-16: paused POST /admin/google-rating-batch (include_address_phone) -> 423");
    assertPausedBody(r.body, "shp-17");
    // Gate sits in FRONT of the Places call, so a paused run also spends no
    // API quota — proven by the fact that no fetch could have completed
    // synchronously before the 423 above.
    delete process.env.GOOGLE_PLACES_API_KEY;

    r = await invokeHandler(
      websiteApprovePost,
      makeReq({
        body: { apply: true, approvals: [{ agent_id: "shp-rfb", url: "https://www.gjerdegard.no" }] },
      }),
    );
    assertEq(r.status, 423, "shp-18: paused POST /admin/rfb-website-review-approve?apply=1 -> 423");
    assertPausedBody(r.body, "shp-19");

    r = await invokeHandler(prunePost, makeReq({ query: { apply: "1" }, body: {} }));
    assertEq(r.status, 423, "shp-20: paused POST /admin/prune-dead-urls?apply=1 -> 423");
    assertPausedBody(r.body, "shp-21");

    r = await invokeHandler(
      hcrPost,
      makeReq({ query: { apply: "1" }, body: { agentIds: ["shp-rfb"] } }),
    );
    assertEq(r.status, 423, "shp-22: paused POST /admin/homepage-content-refresh?apply=1 -> 423");
    assertPausedBody(r.body, "shp-23");

    r = await invokeHandler(knowledgePutHandler, {
      ...makeReq({ body: { about: "Ny tekst fra berikelse", dataSource: "auto" } }),
      params: { id: "shp-rfb" },
    });
    assertEq(r.status, 423, "shp-24: paused ADMIN PUT /api/marketplace/agents/:id/knowledge -> 423 (SKILL PHASE 2D, the highest-volume enrichment write)");
    assertPausedBody(r.body, "shp-25");

    r = await invokeHandler(
      bulkEnrichPost,
      makeReq({ body: { agents: [{ agentId: "shp-rfb", data: { about: "Bulk" } }] } }),
    );
    assertEq(r.status, 423, "shp-26: paused POST /api/marketplace/admin/bulk-enrich -> 423 (batch sibling of the same write)");
    assertPausedBody(r.body, "shp-27");

    // Singular sibling of google-rating-batch. Asserted with NO Places key set,
    // which is exactly the point: the gate runs BEFORE the 503-without-key
    // check, so a loop of single calls cannot walk around the batch's gate.
    r = await invokeHandler(googleRatingSinglePost, {
      ...makeReq({ body: {} }),
      params: { id: "shp-rfb" },
    });
    assertEq(r.status, 423, "shp-28: paused POST /api/marketplace/admin/google-rating/:id -> 423 (singular sibling)");
    assertPausedBody(r.body, "shp-29");

    // ── The claim that actually matters ────────────────────────────────────
    assertEq(
      totalChanges() - changesBefore,
      0,
      "shp-30: TEN blocked write attempts changed ZERO rows (SQLite total_changes())",
    );
    assertEq(agentCount(), agentsBefore, "shp-31: no net-new agent from either register route");
    assertEq(websiteOf("shp-junk"), junkWebsiteBefore, "shp-32: prune did not null a single website");
    assertEq(websiteOf("shp-rfb"), null, "shp-33: the website-approve lever wrote nothing");
    assertEq(
      (testDb.prepare("SELECT status FROM agents_website_review_queue WHERE agent_id = ?").get("shp-rfb") as any)
        ?.status,
      "pending",
      "shp-34: … and the queue row is still 'pending', not flipped to 'applied'",
    );

    // ── The shared PRIMITIVES gate themselves, not just their routes ───────
    // This is finding 1's actual fix: a future caller that forgets its own
    // gate still cannot write.
    let threw: any = null;
    try {
      marketplaceRegistry.register({
        name: "Direkte Primitiv AS",
        description: "Registrert utenom enhver rute",
        provider: "test",
        contactEmail: "post@primitiv.example",
        url: "https://www.primitiv.example",
        role: "producer",
        skills: [],
      } as any);
    } catch (err) {
      threw = err;
    }
    assertTrue(
      svc.isEnrichmentWritePausedError(threw),
      "shp-40: marketplaceRegistry.register() — the SHARED primitive — throws on a live pause, with no route involved",
    );
    assertEq(threw?.body?.paused, true, "shp-41: … carrying the same paused body every route emits");
    assertEq(threw?.status, 423, "shp-42: … and the same 423 status");
    assertEq(agentCount(), agentsBefore, "shp-43: … having created no agent row");

    threw = null;
    try {
      rfbWdMod.applyRfbAgentWebsite(
        testDb as any,
        "shp-rfb",
        "https://www.gjerdegard.no",
        "https://www.gjerdegard.no",
        "shp-batch",
      );
    } catch (err) {
      threw = err;
    }
    assertTrue(
      svc.isEnrichmentWritePausedError(threw),
      "shp-44: applyRfbAgentWebsite() — the SHARED primitive reused by the harvest path — throws on a live pause",
    );
    assertEq(websiteOf("shp-rfb"), null, "shp-45: … having written no website");

    // ── Dry runs stay reachable during a pause (documented policy) ─────────
    // These three levers gate the APPLY path only: a dry run performs no write
    // at all, and keeping it usable is what lets an operator MEASURE while
    // writes are frozen. Asserted, not assumed, so the choice is visible.
    const dryRunChanges = totalChanges();
    r = await invokeHandler(prunePost, makeReq({ body: {} }));
    assertEq(r.status, 200, "shp-50: a prune DRY RUN is still allowed during a pause (read-only by construction)");
    assertEq(r.body?.dry_run, true, "shp-51: … and reports dry_run:true");
    r = await invokeHandler(hcrPost, makeReq({ body: { agentIds: ["shp-rfb"] } }));
    assertEq(r.status, 200, "shp-52: a homepage-content-refresh DRY RUN is still allowed during a pause");
    r = await invokeHandler(
      websiteApprovePost,
      makeReq({ body: { approvals: [{ agent_id: "shp-rfb", url: "https://www.gjerdegard.no" }] } }),
    );
    assertEq(r.status, 200, "shp-53: a website-approve DRY RUN is still allowed during a pause");
    assertEq(r.body?.dry_run, true, "shp-54: … and reports dry_run:true");
    assertEq(totalChanges() - dryRunChanges, 0, "shp-55: … and all three dry runs changed ZERO rows");

    // ── Per-vertical: an RFB pause does not reach a dental row ─────────────
    r = await invokeHandler(
      provenanceBatchPost,
      makeReq({ body: { agentIds: ["shp-dental"], limit: 5 } }),
    );
    assertTrue(r.status !== 423, "shp-60: an RFB pause does NOT block a dental-only provenance batch");
    // A batch spanning both verticals is blocked WHOLE — same policy as the
    // four original surfaces, no partial-batch semantics invented here.
    const spanChanges = totalChanges();
    r = await invokeHandler(
      provenanceBatchPost,
      makeReq({ body: { agentIds: ["shp-dental", "shp-rfb"], limit: 5 } }),
    );
    assertEq(r.status, 423, "shp-61: a batch spanning the paused vertical is blocked WHOLE");
    assertEq(totalChanges() - spanChanges, 0, "shp-62: … including the un-paused item — zero partial writes");

    // ═══════════════════════════════════════════════════════════════════════
    // (B) PAUSE INACTIVE — behaviour is what it was before the gate existed
    // ═══════════════════════════════════════════════════════════════════════
    setPause(false);

    const beforeAdminRegister = agentCount();
    r = await invokeHandler(adminRegisterPost, makeReq({ body: adminRegisterBody() }));
    assertEq(r.status, 201, "shp-70: unpaused POST /api/marketplace/admin/register -> 201 as before");
    assertEq(r.body?.success, true, "shp-71: … usual response shape");
    assertEq(agentCount(), beforeAdminRegister + 1, "shp-72: … and the agent was actually created");

    const beforePublicRegister = agentCount();
    r = await invokeHandler(publicRegisterPost, makeReq({ body: publicRegisterBody() }));
    assertEq(r.status, 201, "shp-73: unpaused PUBLIC POST /api/marketplace/register -> 201 as before");
    assertEq(agentCount(), beforePublicRegister + 1, "shp-74: … and the agent was actually created");
    assertEq(
      (testDb.prepare("SELECT origin, is_vetted FROM agents WHERE id = ?").get(r.body?.data?.id) as any)?.origin,
      "self_registered",
      "shp-75: … still quarantined as self_registered (the gate changed nothing about that)",
    );

    // Shared primitive, no pause: writes exactly as it always did.
    const beforePrimitive = agentCount();
    const created = marketplaceRegistry.register({
      name: "Direkte Primitiv AS",
      description: "Registrert utenom enhver rute",
      provider: "test",
      contactEmail: "post@primitiv.example",
      url: "https://www.primitiv.example",
      role: "producer",
      skills: [],
    } as any);
    assertTrue(!!created?.id, "shp-76: marketplaceRegistry.register() returns the created agent when no pause is set");
    assertEq(agentCount(), beforePrimitive + 1, "shp-77: … and the row really landed");

    // prune-dead-urls apply: the junk website is nulled again, as before.
    r = await invokeHandler(prunePost, makeReq({ query: { apply: "1" }, body: {} }));
    assertEq(r.status, 200, "shp-78: unpaused POST /admin/prune-dead-urls?apply=1 -> 200 as before");
    assertEq(r.body?.dry_run, false, "shp-79: … dry_run:false");
    assertTrue((r.body?.pruned as number) >= 1, "shp-80: … and it pruned at least the yelp URL");
    assertEq(websiteOf("shp-junk"), null, "shp-81: … agent_knowledge.website actually nulled");

    // website-approve apply: the queued candidate is adopted, as before.
    seedQueueRow();
    r = await invokeHandler(
      websiteApprovePost,
      makeReq({
        body: { apply: true, approvals: [{ agent_id: "shp-rfb", url: "https://www.gjerdegard.no" }] },
      }),
    );
    assertEq(r.status, 200, "shp-82: unpaused POST /admin/rfb-website-review-approve?apply=1 -> 200 as before");
    assertEq(r.body?.written_count, 1, "shp-83: … and it wrote exactly one row");
    assertEq(websiteOf("shp-rfb"), "https://www.gjerdegard.no", "shp-84: … agent_knowledge.website actually changed");

    // homepage-provenance-batch apply: the agent has neither knowledge.website
    // nor agents.url, so processAgent short-circuits at `no_data` — a real 200
    // through the whole handler with no outbound fetch.
    r = await invokeHandler(
      provenanceBatchPost,
      makeReq({ body: { agentIds: ["shp-dental"], limit: 5 } }),
    );
    assertEq(r.status, 200, "shp-85: unpaused POST /admin/homepage-provenance-batch -> 200 as before");
    assertTrue(r.body?.paused === undefined, "shp-86: … and carries no paused marker");

    // homepage-content-refresh apply: the website-less target is filtered out
    // by the handler's own selection, so this is a real 200 with no fetch.
    r = await invokeHandler(hcrPost, makeReq({ query: { apply: "1" }, body: { agentIds: ["shp-dental"] } }));
    assertEq(r.status, 200, "shp-87: unpaused POST /admin/homepage-content-refresh?apply=1 -> 200 as before");
    assertTrue(r.body?.paused === undefined, "shp-88: … and carries no paused marker");

    // The highest-volume enrichment write, unpaused: writes exactly as before.
    r = await invokeHandler(knowledgePutHandler, {
      ...makeReq({ body: { about: "Ny tekst fra berikelse", dataSource: "auto" } }),
      params: { id: "shp-rfb" },
    });
    assertEq(r.status, 200, "shp-85a: unpaused ADMIN PUT /api/marketplace/agents/:id/knowledge -> 200 as before");
    assertEq(
      (testDb.prepare("SELECT about FROM agent_knowledge WHERE agent_id = ?").get("shp-rfb") as any)?.about,
      "Ny tekst fra berikelse",
      "shp-85b: … agent_knowledge.about actually changed",
    );
    r = await invokeHandler(
      bulkEnrichPost,
      makeReq({ body: { agents: [{ agentId: "shp-rfb", data: { about: "Bulk-tekst" } }] } }),
    );
    assertEq(r.status, 200, "shp-85c: unpaused POST /api/marketplace/admin/bulk-enrich -> 200 as before");

    // google-rating-batch: with no Places key the pre-existing 503 is what
    // answers — proof the gate is not what rejects when nothing is paused.
    delete process.env.GOOGLE_PLACES_API_KEY;
    r = await invokeHandler(
      googleRatingBatchPost,
      makeReq({ body: { agentIds: ["shp-rfb"], include_address_phone: true } }),
    );
    assertEq(r.status, 503, "shp-89: unpaused POST /admin/google-rating-batch keeps its pre-existing 503-without-key behaviour");
    r = await invokeHandler(googleRatingSinglePost, {
      ...makeReq({ body: {} }),
      params: { id: "shp-rfb" },
    });
    assertEq(r.status, 503, "shp-89b: … and so does the singular /admin/google-rating/:id");

    // ═══════════════════════════════════════════════════════════════════════
    // (C) FAIL-CLOSED on the new surfaces too
    // ═══════════════════════════════════════════════════════════════════════
    // No pause is set. Point the getDb() singleton at a handle that throws:
    // "the lookup could not answer" must never read as "go ahead".
    const throwingDb: any = {
      prepare() {
        throw new Error("simulated DB failure inside the guard");
      },
      transaction() {
        throw new Error("simulated DB failure inside the guard");
      },
    };
    const beforeTrap = agentCount();
    __setDbForTesting(throwingDb);
    r = await invokeHandler(adminRegisterPost, makeReq({ body: adminRegisterBody() }));
    assertEq(r.status, 423, "shp-90: POST /api/marketplace/admin/register fails CLOSED on a throwing lookup");
    assertEq(r.body?.fail_closed, true, "shp-91: … and says fail_closed:true rather than dying as a 500");
    r = await invokeHandler(publicRegisterPost, makeReq({ body: publicRegisterBody() }));
    assertEq(r.status, 423, "shp-92: the PUBLIC register route fails CLOSED too");
    assertEq(r.body?.fail_closed, true, "shp-93: … also flagged fail_closed");
    __setDbForTesting(testDb as any);
    assertEq(agentCount(), beforeTrap, "shp-94: … and no agent slipped through while failing closed");

    // The thunk form is what makes finding 3's fix real: a getDb() that THROWS
    // is a lookup failure inside the fence, not a 500 outside it.
    const throwingThunk = () => {
      throw new Error("getDb() itself is unavailable");
    };
    const g = svc.assertEnrichmentWriteAllowed(throwingThunk as any, "rfb");
    assertEq(g.allowed, false, "shp-95: a THROWING getDb thunk => not allowed (finding 3)");
    assertEq((g as any).fail_closed, true, "shp-96: … flagged fail_closed, so the signal is not lost");
    const g2 = svc.assertEnrichmentWriteAllowedForAgents(throwingThunk as any, ["shp-rfb"]);
    assertEq(g2.allowed, false, "shp-97: the batch guard fails closed on a throwing thunk too");
    assertEq((g2 as any).fail_closed, true, "shp-98: … also flagged fail_closed");
  } catch (err: any) {
    failed++;
    failures.push(`✗ shp-fatal: unexpected error: ${String(err?.stack ?? err?.message ?? err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
    if (prevBrregFlag === undefined) delete process.env.BRREG_VERIFY_ON_REGISTER;
    else process.env.BRREG_VERIFY_ON_REGISTER = prevBrregFlag;
    try {
      __setDbForTesting((prevDb ?? null) as any);
    } catch {
      /* ignore */
    }
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runEnrichmentWritePauseSharedPrimitivesTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}

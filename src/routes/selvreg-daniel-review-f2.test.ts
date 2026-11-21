/**
 * selvreg-daniel-review-f2.test.ts — dev-request 2026-11-15-rfb-
 * selvregistrering-uten-nettside, slice F2 («godkjenning uten org.nr»).
 *
 * GET /admin/agents/self-registered-review-queue gains, per entry,
 * has_org_nr / phone / sales_place / email_confirmed / has_description /
 * product_count / daniel_review, and top-level daniel_review_ready_count.
 * POST /admin/agents/self-registered-review-approve refuses (409
 * org_nr_missing_requires_daniel) an agent without an org.nr unless the body
 * carries danielApproved: true.
 *
 * Cases:
 *   pure  services/selvreg-daniel-review.ts helpers
 *   AK-a  no org.nr, all five conditions → daniel_review.ready=true, counted
 *   AK-b  no org.nr, missing phone → ready=false, missing has "phone"
 *   AK-c  org.nr (column or valid tag) → daniel_review null
 *   AK-d  approve without org.nr → 409, is_vetted stays 0, no IndexNow ping
 *   AK-e  approve without org.nr + danielApproved:true → vetted
 *   AK-f  approve with org.nr → vetted as before (no flag needed)
 *   ro    GET writes nothing
 *
 * Production schema in an in-memory DB pinned on getDb(); handlers pulled off
 * the router stack (same harness as self-registered-queue-owner-s4b.test.ts);
 * indexnow-service replaced in the require cache (same seam as
 * marketplace-quarantine-gates.test.ts) so nothing leaves the process.
 * Exported runSelvregDanielReviewF2Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/selvreg-daniel-review-f2.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runSelvregDanielReviewF2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok   ${label}`); }
    else { failed++; failures.push(label); if (log) console.log(`  FAIL ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, a === e ? label : `${label} (expected ${e}, got ${a})`);
  };

  // ── pure helpers ──────────────────────────────────────────────────────
  {
    const h = require("../services/selvreg-daniel-review") as typeof import("../services/selvreg-daniel-review");
    eq(h.hasOrgNr("923609016", "[]"), true, "pure: 9-digit agents.org_nr → has org.nr");
    eq(h.hasOrgNr(null, JSON.stringify(["økologisk", "org_nr:923609016"])), true, "pure: valid org_nr: tag → has org.nr");
    eq(h.hasOrgNr(null, JSON.stringify(["org_nr:923609017"])), false, "pure: MOD11-invalid org_nr: tag → no org.nr");
    eq(h.hasOrgNr("", JSON.stringify(["org_nr:12345"])), false, "pure: short tag / empty column → no org.nr");
    eq(h.hasOrgNr(null, null), false, "pure: nothing → no org.nr");
    eq(h.salesPlaceOf(JSON.stringify(["REKO-ring Hamar"])), "REKO-ring Hamar", "pure: sales place from delivery_options");
    eq(h.salesPlaceOf("[]"), null, "pure: empty delivery_options → null");
    eq(h.salesPlaceOf("not json"), null, "pure: bad JSON → null");
    eq(h.countKnowledgeProducts(JSON.stringify(["Egg", { name: "Honning" }, { name: " " }, {}, 3])), 2, "pure: product count counts named entries only");
    eq(h.phoneOf("  "), null, "pure: blank phone → null");
    eq(h.hasDescriptionOf("  ", null), false, "pure: blank description, no about → false");
    eq(h.hasDescriptionOf("  ", "Om gården"), true, "pure: about counts as description");
    eq(h.computeDanielReview({ hasOrgNr: true, emailConfirmed: false, phone: null, salesPlace: null, hasDescription: false, productCount: 0 }),
      null, "pure: has org.nr → null");
    eq(h.computeDanielReview({ hasOrgNr: false, emailConfirmed: false, phone: null, salesPlace: null, hasDescription: false, productCount: 0 }),
      { required: true, ready: false, missing: ["email_confirmed", "phone", "sales_place", "description", "product"] },
      "pure: nothing given → all five codes, stable order");
    eq(h.computeDanielReview({ hasOrgNr: false, emailConfirmed: true, phone: "41234567", salesPlace: "Bondens marked", hasDescription: true, productCount: 1 }),
      { required: true, ready: true, missing: [] }, "pure: all five → ready");
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const prevAdmin = process.env.ADMIN_KEY;
  const ADMIN = "f2-daniel-review-admin-key";

  const indexNowPath = require.resolve("../services/indexnow-service");
  const originalIndexNow = require.cache[indexNowPath];
  const pingCalls: string[][] = [];
  require.cache[indexNowPath] = {
    id: indexNowPath, filename: indexNowPath, loaded: true,
    exports: { pingIndexNow: (urls: string[]) => { pingCalls.push(urls); } },
  } as any;

  const handlerOf = (router: any, path: string, method: "get" | "post"): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const makeReq = (body?: any): any => {
    const headers: Record<string, string> = { "x-admin-key": ADMIN, host: "rettfrabonden.com" };
    return {
      params: {}, body, query: {}, headers, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  };
  const invoke = (handler: Function, req: any): Promise<{ status: number; body: any }> => new Promise((resolve) => {
    let status = 200;
    let settled = false;
    const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
    const res: any = {
      status(c: number) { status = c; return res; }, json(p: any) { settle(p); return res; }, send(p: any) { settle(p); return res; },
      end() { settle(undefined); return res; }, header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
    };
    try {
      const p = handler(req, res, () => settle({ __next: true }));
      if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
    } catch (err) {
      settle({ __error: String(err) });
    }
  });

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN;

    const insert = (id: string, o: { created: string; orgNr?: string | null; tags?: string[]; claimedAt?: string | null; description?: string }) => {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, origin, is_vetted, created_at, claimed_at, org_nr, tags)
                  VALUES (?, ?, ?, 'test', ?, '', 'producer', ?, 'Hamar', 'self_registered', 0, ?, ?, ?, ?)`)
        .run(id, `Gård ${id}`, o.description ?? "En gård med egne produkter.", `post@${id}.example.test`, `key-${id}`,
          o.created, o.claimedAt ?? null, o.orgNr ?? null, JSON.stringify(o.tags ?? []));
    };
    const knowledge = (id: string, o: { phone?: string | null; delivery?: string[]; products?: unknown[] }) => {
      db.prepare(`INSERT INTO agent_knowledge (agent_id, phone, delivery_options, products) VALUES (?, ?, ?, ?)`)
        .run(id, o.phone ?? null, JSON.stringify(o.delivery ?? []), JSON.stringify(o.products ?? []));
    };
    const verifiedClaim = (id: string) => {
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, 'Eier', 'eier@x.no', 'verified')`)
        .run(`c-${id}`, id);
    };

    // AK-a: no org.nr, all five (owner via verified claim, products in agent_knowledge).
    insert("ready", { created: "2026-11-01 08:00:00" });
    knowledge("ready", { phone: "41234567", delivery: ["REKO-ring Hamar"], products: [{ name: "Egg" }] });
    verifiedClaim("ready");
    // AK-a variant: product only in the products table, owner via claimed_at.
    insert("ready-table", { created: "2026-11-02 08:00:00", claimedAt: "2026-11-02 09:00:00" });
    knowledge("ready-table", { phone: "41234568", delivery: ["Bondens marked"] });
    db.prepare(`INSERT INTO products (id, agent_id, name, name_norm) VALUES ('p1', 'ready-table', 'Honning', 'honning')`).run();
    // AK-b: everything but the phone.
    insert("no-phone", { created: "2026-11-03 08:00:00", claimedAt: "2026-11-03 09:00:00" });
    knowledge("no-phone", { delivery: ["Gårdsbutikk"], products: ["Poteter"] });
    // Nothing at all (no knowledge row, not owner-confirmed).
    insert("bare", { created: "2026-11-04 08:00:00" });
    // AK-c: org.nr in the column / as a valid tag.
    insert("org-col", { created: "2026-11-05 08:00:00", orgNr: "923609016" });
    insert("org-tag", { created: "2026-11-06 08:00:00", tags: ["org_nr:923609016"] });
    // MOD11-invalid tag → treated as no org.nr.
    insert("bad-tag", { created: "2026-11-07 08:00:00", tags: ["org_nr:923609017"] });

    for (const p of ["./admin-agents"]) delete require.cache[require.resolve(p)];
    const adminRouter = require("./admin-agents").default as any;
    const queueH = handlerOf(adminRouter, "/self-registered-review-queue", "get");
    const approveH = handlerOf(adminRouter, "/self-registered-review-approve", "post");

    const snap = () => JSON.stringify({
      agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
      knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
      products: db.prepare("SELECT * FROM products ORDER BY id").all(),
      claims: db.prepare("SELECT * FROM agent_claims ORDER BY id").all(),
    });
    const before = snap();
    const changesBefore = (db.prepare("SELECT total_changes() AS n").get() as any).n;
    const q = await invoke(queueH, makeReq());
    const changesAfter = (db.prepare("SELECT total_changes() AS n").get() as any).n;
    eq(q.status, 200, "queue: 200");
    eq(snap(), before, "ro: GET leaves agents/knowledge/products/claims unchanged");
    eq(changesAfter, changesBefore, "ro: no row changes during the GET");

    const entries = q.body.entries as any[];
    const byId = (id: string) => entries.find((e) => e.id === id);
    eq(Object.keys(q.body), ["count", "owner_confirmed_count", "daniel_review_ready_count", "entries"], "response: top-level keys");
    eq([q.body.count, q.body.owner_confirmed_count], [7, 3], "count / owner_confirmed_count unchanged semantics");
    eq(entries.map((e) => e.id), ["ready", "ready-table", "no-phone", "bare", "org-col", "org-tag", "bad-tag"],
      "order unchanged: owners first, then oldest first");
    eq(Object.keys(entries[0]).slice(0, 12),
      ["id", "name", "contact_email", "url", "created_at", "org_nr", "city", "precheck", "precheck_at", "age_days", "owner_confirmed", "owner_label"],
      "entry: existing fields first, in the same order");

    const a = byId("ready");
    eq([a.has_org_nr, a.phone, a.sales_place, a.email_confirmed, a.has_description, a.product_count],
      [false, "41234567", "REKO-ring Hamar", true, true, 1], "AK-a: per-entry facts");
    eq(a.daniel_review, { required: true, ready: true, missing: [] }, "AK-a: daniel_review ready");
    const at = byId("ready-table");
    eq([at.product_count, at.daniel_review?.ready], [1, true], "AK-a: products-table product counts; ready");
    eq(q.body.daniel_review_ready_count, 2, "AK-a: daniel_review_ready_count counts the ready ones");

    const b = byId("no-phone");
    eq([b.phone, b.daniel_review?.ready], [null, false], "AK-b: no phone → ready false");
    ok(Array.isArray(b.daniel_review?.missing) && b.daniel_review.missing.includes("phone"), "AK-b: missing contains phone");
    eq(b.daniel_review?.missing, ["phone"], "AK-b: phone is the only thing missing");

    const bare = byId("bare");
    eq(bare.daniel_review?.missing, ["email_confirmed", "phone", "sales_place", "product"], "bare: no knowledge row → four codes (description present)");
    eq([bare.phone, bare.sales_place, bare.product_count], [null, null, 0], "bare: null phone / sales_place, 0 products");

    eq([byId("org-col").has_org_nr, byId("org-col").daniel_review], [true, null], "AK-c: agents.org_nr → daniel_review null");
    eq([byId("org-tag").has_org_nr, byId("org-tag").daniel_review], [true, null], "AK-c: valid org_nr: tag → daniel_review null");
    eq([byId("bad-tag").has_org_nr, byId("bad-tag").daniel_review?.required], [false, true], "MOD11-invalid tag → needs Daniel");

    // AK-d: approve without org.nr → 409, nothing vetted, no ping.
    for (const body of [{ agentId: "ready" }, { agentId: "ready", danielApproved: "true" }, { agentId: "ready", danielApproved: 1 }]) {
      const r = await invoke(approveH, makeReq(body));
      eq([r.status, r.body], [409, { error: "org_nr_missing_requires_daniel" }], `AK-d: ${JSON.stringify(body)} → 409`);
    }
    eq((db.prepare("SELECT is_vetted FROM agents WHERE id = 'ready'").get() as any).is_vetted, 0, "AK-d: is_vetted stays 0");
    eq(pingCalls.length, 0, "AK-d: no IndexNow ping");

    // AK-e: danielApproved: true → vetted.
    const e = await invoke(approveH, makeReq({ agentId: "ready", danielApproved: true }));
    eq([e.status, e.body], [200, { success: true, agentId: "ready", isVetted: true }], "AK-e: danielApproved:true → 200");
    eq((db.prepare("SELECT is_vetted FROM agents WHERE id = 'ready'").get() as any).is_vetted, 1, "AK-e: is_vetted = 1");
    eq(pingCalls.length, 1, "AK-e: IndexNow pinged once");
    const again = await invoke(approveH, makeReq({ agentId: "ready" }));
    eq([again.status, again.body?.alreadyVetted], [200, true], "already vetted short-circuit unchanged (no flag needed, nothing new vetted)");

    // AK-f: with org.nr → as before, no flag.
    for (const id of ["org-col", "org-tag"]) {
      const f = await invoke(approveH, makeReq({ agentId: id }));
      eq([f.status, f.body], [200, { success: true, agentId: id, isVetted: true }], `AK-f: ${id} approved without danielApproved`);
      eq((db.prepare("SELECT is_vetted FROM agents WHERE id = ?").get(id) as any).is_vetted, 1, `AK-f: ${id} is_vetted = 1`);
    }
    eq(pingCalls.length, 3, "AK-f: one ping per approval");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
    if (originalIndexNow) require.cache[indexNowPath] = originalIndexNow; else delete require.cache[indexNowPath];
    if (prevAdmin === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdmin;
    initMod.__setDbForTesting(prevDb as any);
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runSelvregDanielReviewF2Tests({ log: true }).then((r) => {
    console.log(`\nselvreg-daniel-review-f2: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}

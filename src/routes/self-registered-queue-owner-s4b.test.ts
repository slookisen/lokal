/**
 * self-registered-queue-owner-s4b.test.ts — dev-request
 * 2026-11-10-rfb-registreringer-og-eierkrav-folges-opp, slice S4b.
 *
 * GET /admin/agents/self-registered-review-queue:
 *   * each entry carries owner_confirmed (shared customerRuleSql: claimed_at
 *     set OR a verified agent_claims row) and owner_label ("eier bekreftet"
 *     or null);
 *   * owner-confirmed rows sort first, each group oldest first (id as the
 *     final tie-breaker);
 *   * top-level owner_confirmed_count next to count; WHERE filter unchanged
 *     (vetted / non-self_registered rows with verified claims never appear);
 *   * read-only (agents + agent_claims snapshots identical before/after);
 *   * missing admin key → 403.
 *
 * Production schema in an in-memory DB pinned on getDb(); the handler is
 * pulled off the router stack (same harness as registration-precheck.test.ts).
 * Exported runSelfRegisteredQueueOwnerS4bTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/self-registered-queue-owner-s4b.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runSelfRegisteredQueueOwnerS4bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const prevAdmin = process.env.ADMIN_KEY;
  const ADMIN = "s4b-queue-admin-key";

  const handlerOf = (router: any, path: string, method: "get" | "post"): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const makeReq = (o: { admin?: boolean } = {}): any => {
    const headers: Record<string, string> = o.admin === false ? {} : { "x-admin-key": ADMIN };
    return {
      params: {}, body: undefined, query: {}, headers, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
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

    const insert = (id: string, o: { origin?: string; vetted?: number; created: string; claimedAt?: string | null }) => {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, origin, is_vetted, created_at, claimed_at)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'Hamar', ?, ?, ?, ?)`)
        .run(id, `Gård ${id}`, `post@${id}.example.test`, `https://${id}.example.test`, `key-${id}`,
          o.origin ?? "self_registered", o.vetted ?? 0, o.created, o.claimedAt ?? null);
    };
    const claim = (id: string, agentId: string, status: string) => {
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, 'Eier', 'eier@x.no', ?)`)
        .run(id, agentId, status);
    };

    // Non-owner rows (oldest first expected among themselves).
    insert("plain-old", { created: "2026-10-01 08:00:00" });
    insert("plain-mid", { created: "2026-10-15 08:00:00" });
    insert("pending-claim", { created: "2026-10-20 08:00:00" });
    claim("c-pending", "pending-claim", "pending");
    insert("rejected-claim", { created: "2026-10-25 08:00:00" });
    claim("c-rejected", "rejected-claim", "rejected");
    claim("c-codesent", "rejected-claim", "code_sent");
    // Equal created_at among non-owners → id tie-breaker.
    insert("tie-b", { created: "2026-10-28 08:00:00" });
    insert("tie-a", { created: "2026-10-28 08:00:00" });
    // Owner rows: newest overall, but sorted first.
    insert("owner-claimed-new", { created: "2026-11-09 08:00:00", claimedAt: "2026-11-09 09:00:00" });
    insert("owner-verified", { created: "2026-11-05 08:00:00" });
    claim("c-verified", "owner-verified", "verified");
    // Never in the queue: vetted self_registered / discovery rows with verified claims.
    insert("vetted-owned", { vetted: 1, created: "2026-09-01 08:00:00", claimedAt: "2026-09-02 08:00:00" });
    claim("c-vetted", "vetted-owned", "verified");
    insert("discovery-owned", { origin: "discovery", vetted: 0, created: "2026-09-01 08:00:00" });
    claim("c-discovery", "discovery-owned", "verified");

    for (const p of ["./admin-agents"]) delete require.cache[require.resolve(p)];
    const adminRouter = require("./admin-agents").default as any;
    const queueH = handlerOf(adminRouter, "/self-registered-review-queue", "get");

    // Auth unchanged.
    eq((await invoke(queueH, makeReq({ admin: false }))).status, 403, "auth: missing admin key → 403");

    const snap = () => JSON.stringify({
      agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
      claims: db.prepare("SELECT * FROM agent_claims ORDER BY id").all(),
    });
    const before = snap();
    const changesBefore = (db.prepare("SELECT total_changes() AS n").get() as any).n;
    const q = await invoke(queueH, makeReq());
    const changesAfter = (db.prepare("SELECT total_changes() AS n").get() as any).n;
    eq(q.status, 200, "queue: 200 with admin key");
    const entries = q.body.entries as any[];
    const ids = entries.map((e) => e.id);

    eq(ids, ["owner-verified", "owner-claimed-new", "plain-old", "plain-mid", "pending-claim", "rejected-claim", "tie-a", "tie-b"],
      "order: owners first (oldest first among them), then the rest oldest first, id breaks ties");
    const byId = (id: string) => entries.find((e) => e.id === id);
    eq([byId("owner-claimed-new").owner_confirmed, byId("owner-claimed-new").owner_label], [true, "eier bekreftet"],
      "claimed_at set → owner_confirmed + label");
    eq([byId("owner-verified").owner_confirmed, byId("owner-verified").owner_label], [true, "eier bekreftet"],
      "verified agent_claims row (claimed_at NULL) → owner_confirmed + label");
    eq([byId("pending-claim").owner_confirmed, byId("pending-claim").owner_label], [false, null], "pending claim only → not confirmed");
    eq([byId("rejected-claim").owner_confirmed, byId("rejected-claim").owner_label], [false, null], "rejected/code_sent claims only → not confirmed");
    eq([byId("plain-old").owner_confirmed, byId("plain-old").owner_label], [false, null], "no claim → not confirmed");
    eq([q.body.count, q.body.owner_confirmed_count], [8, 2], "count unchanged (all queued rows); owner_confirmed_count = 2");
    eq(Object.keys(q.body), ["count", "owner_confirmed_count", "entries"], "response: owner_confirmed_count next to count");
    eq(Object.keys(entries[0]).slice(0, 5), ["id", "name", "contact_email", "url", "created_at"], "entry: original fields first");
    ok(["org_nr", "city", "precheck", "precheck_at", "age_days"].every((k) => k in entries[0]), "entry: S2 fields kept");
    ok(!ids.includes("vetted-owned") && !ids.includes("discovery-owned"), "filter: vetted / non-self_registered owners never appear");
    ok(entries.every((e) => typeof e.owner_confirmed === "boolean"), "owner_confirmed is a boolean on every entry");

    // Read-only.
    eq(snap(), before, "read-only: agents + agent_claims unchanged");
    eq(changesAfter, changesBefore, "read-only: no row changes during the request");

    // Empty queue → zero counts.
    db.prepare("DELETE FROM agents WHERE origin = 'self_registered' AND is_vetted = 0").run();
    const empty = await invoke(queueH, makeReq());
    eq([empty.body.count, empty.body.owner_confirmed_count, empty.body.entries], [0, 0, []], "empty queue → 0 / 0 / []");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
    if (prevAdmin === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdmin;
    initMod.__setDbForTesting(prevDb as any);
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runSelfRegisteredQueueOwnerS4bTests({ log: true }).then((r) => {
    console.log(`\nself-registered-queue-owner-s4b: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}

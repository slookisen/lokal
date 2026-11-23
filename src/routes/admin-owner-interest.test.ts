/**
 * admin-owner-interest.test.ts — segment B («bekreftet, ikke eier») as an
 * admin-only field (dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-1).
 *
 * POST /admin/agents/:id/owner-interest + GET /admin/owner-interest, driven
 * over a real express app on an ephemeral port with the same mount paths as
 * src/index.ts (the POST router uses mergeParams for :id). Own in-memory DB
 * via the route's seam (__setOwnerInterestDbForTesting) — never pins the
 * shared getDb() singleton.
 *
 * Covers: set, clear, invalid value → 400, unknown agent → 404, already
 * claimed (claimed_at or verified agent_claims) → 409 on set / clear allowed,
 * dry_run writes nothing, list returns only marked agents, admin key required,
 * one audit row per real write, schema present on a fresh DB and created on a
 * DB that already has `agents` but not the table (idempotent re-init), and
 * `agents` itself is not widened.
 */

import http from "http";
import express from "express";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import ownerInterestRouter, {
  ownerInterestListRouter,
  __setOwnerInterestDbForTesting,
} from "./admin-owner-interest";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminOwnerInterestTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const s: TestSummary = { passed: 0, failed: 0, failures: [] };
  const ok = (cond: boolean, label: string) => {
    if (cond) {
      s.passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      s.failed++;
      s.failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  };

  // SHARED-GLOBAL DISCIPLINE (tests/test.ts): never reassign an ambient
  // ADMIN_KEY; only set one (and restore) when none exists.
  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "admin-owner-interest-standalone-key";
  const KEY = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  try {
    initMod.__initSchemaForTesting(db as any);
    __setOwnerInterestDbForTesting(db as any);

    // ── Schema ───────────────────────────────────────────────────────────
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    ok(
      JSON.stringify(cols("agent_owner_interest")) ===
        JSON.stringify(["agent_id", "owner_interest", "owner_interest_at", "owner_interest_thread"]),
      "fresh DB: agent_owner_interest has the three fields + agent_id",
    );
    ok(!cols("agents").some((c) => c.startsWith("owner_interest")), "agents is not widened (planner / public row order)");

    // DB that already has `agents` (a prior deploy) but not the new table.
    const old = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(old as any);
      old.exec(`DROP TABLE agent_owner_interest`);
      const before = (old.prepare(`SELECT name FROM sqlite_master WHERE name = 'agent_owner_interest'`).get() as any) ?? null;
      ok(before === null, "pre-existing DB: table absent before re-init");
      initMod.__initSchemaForTesting(old as any);
      initMod.__initSchemaForTesting(old as any); // twice: idempotent
      const n = (old.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'agent_owner_interest'`).get() as any).n;
      ok(n === 1, "pre-existing DB: table created by re-init, idempotent on a second run");
      let checkRejects = false;
      try {
        old.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
                     VALUES ('o1','Old','d','t','','https://x.no','producer','k-o1','rfb')`).run();
        old.prepare(`INSERT INTO agent_owner_interest VALUES ('o1','something_else','2026-01-01T00:00:00.000Z',NULL)`).run();
      } catch {
        checkRejects = true;
      }
      ok(checkRejects, "CHECK rejects an owner_interest value other than confirmed_positive");
    } finally {
      old.close();
    }

    // ── Fixtures ─────────────────────────────────────────────────────────
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
       VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?, 'rfb', ?)`,
    );
    insertAgent.run("oi-1", "Bakken Gård", "k-oi-1", null);
    insertAgent.run("oi-2", "Fjell Ost", "k-oi-2", null);
    insertAgent.run("oi-claimed", "Eid Gård", "k-oi-c", "2026-11-01T00:00:00Z");
    insertAgent.run("oi-vclaim", "Vik Honning", "k-oi-v", null);
    db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('c1','oi-vclaim','X','x@example.no','verified')`,
    ).run();
    // Pre-marked row that got claimed afterwards (clear must still work).
    db.prepare(
      `INSERT INTO agent_owner_interest VALUES ('oi-claimed','confirmed_positive','2026-10-01T00:00:00.000Z','thread-old')`,
    ).run();

    const app = express();
    app.use(express.json());
    app.use("/admin/agents/:id/owner-interest", ownerInterestRouter);
    app.use("/admin/owner-interest", ownerInterestListRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const call = (method: string, path: string, body?: unknown, key: string | null = KEY) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key !== null) headers["x-admin-key"] = key;
        const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let parsed: any = undefined;
            try { parsed = data ? JSON.parse(data) : undefined; } catch { parsed = data; }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    const row = (id: string) => db.prepare(`SELECT * FROM agent_owner_interest WHERE agent_id = ?`).get(id) as any;
    const audits = (id: string) =>
      db.prepare(`SELECT * FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'owner_interest' ORDER BY rowid`).all(id) as any[];

    // ── Auth ─────────────────────────────────────────────────────────────
    let r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive" }, null);
    ok(r.status === 403, `POST without key → 403 (got ${r.status})`);
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive" }, "wrong");
    ok(r.status === 403, `POST with wrong key → 403 (got ${r.status})`);
    r = await call("GET", "/admin/owner-interest", undefined, null);
    ok(r.status === 403, `GET without key → 403 (got ${r.status})`);
    ok(row("oi-1") === undefined, "no write without key");

    // ── Validation ───────────────────────────────────────────────────────
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "maybe" });
    ok(r.status === 400, `invalid interest value → 400 (got ${r.status})`);
    r = await call("POST", "/admin/agents/oi-1/owner-interest", {});
    ok(r.status === 400, `missing interest → 400 (got ${r.status})`);
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive", extra: 1 });
    ok(r.status === 400, `unknown key (strict) → 400 (got ${r.status})`);
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive", thread: "x".repeat(301) });
    ok(r.status === 400, `thread > 300 chars → 400 (got ${r.status})`);
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: null, thread: "t" });
    ok(r.status === 400, `thread with a clear → 400 (got ${r.status})`);
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive", dry_run: "yes" });
    ok(r.status === 400, `non-boolean dry_run → 400 (got ${r.status})`);
    ok(row("oi-1") === undefined && audits("oi-1").length === 0, "no write after any 400");

    // ── 404 ──────────────────────────────────────────────────────────────
    r = await call("POST", "/admin/agents/nope/owner-interest", { interest: "confirmed_positive" });
    ok(r.status === 404, `unknown agent → 404 (got ${r.status})`);

    // ── dry_run ──────────────────────────────────────────────────────────
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive", thread: "cs-123", dry_run: true });
    ok(r.status === 200 && r.body?.dry_run === true && r.body?.after?.owner_interest === "confirmed_positive", "dry_run → 200 with after");
    ok(row("oi-1") === undefined && audits("oi-1").length === 0, "dry_run writes nothing (no row, no audit)");

    // ── Set ──────────────────────────────────────────────────────────────
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: "confirmed_positive", thread: "cs-123" });
    const set = row("oi-1");
    ok(r.status === 200 && r.body?.changed === true && r.body?.dry_run === false, `set → 200 changed (got ${r.status})`);
    ok(set?.owner_interest === "confirmed_positive" && set?.owner_interest_thread === "cs-123", "set writes interest + thread");
    ok(typeof set?.owner_interest_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(set.owner_interest_at), "owner_interest_at is ISO UTC");
    const a1 = audits("oi-1");
    ok(a1.length === 1 && a1[0].changed_by === "admin" && a1[0].old_value === null && JSON.parse(a1[0].new_value).owner_interest === "confirmed_positive", "set appends exactly one audit row");

    r = await call("POST", "/admin/agents/oi-2/owner-interest", { interest: "confirmed_positive" });
    ok(r.status === 200 && row("oi-2")?.owner_interest_thread === null, "set without thread → thread NULL");

    // ── 409 already owner ────────────────────────────────────────────────
    r = await call("POST", "/admin/agents/oi-claimed/owner-interest", { interest: "confirmed_positive" });
    ok(r.status === 409 && r.body?.error === "already_owner", `claimed_at set → 409 already_owner (got ${r.status})`);
    ok(row("oi-claimed")?.owner_interest_thread === "thread-old", "409 leaves the existing row untouched");
    r = await call("POST", "/admin/agents/oi-vclaim/owner-interest", { interest: "confirmed_positive" });
    ok(r.status === 409, `verified agent_claims row → 409 (got ${r.status})`);
    ok(row("oi-vclaim") === undefined, "409 writes nothing");

    // ── List ─────────────────────────────────────────────────────────────
    r = await call("GET", "/admin/owner-interest");
    const ids = (r.body?.items ?? []).map((i: any) => i.id).sort();
    ok(r.status === 200 && JSON.stringify(ids) === JSON.stringify(["oi-1", "oi-2", "oi-claimed"]), `list returns only marked agents (got ${JSON.stringify(ids)})`);
    const it1 = (r.body?.items ?? []).find((i: any) => i.id === "oi-1");
    ok(it1?.slug === "bakken-gard" && it1?.name === "Bakken Gård" && it1?.owner_interest_thread === "cs-123" && it1?.claimed_now === false, "list item shape (slug, thread, claimed_now=false)");
    const itC = (r.body?.items ?? []).find((i: any) => i.id === "oi-claimed");
    ok(itC?.claimed_now === true, "list flags a since-claimed agent claimed_now=true");
    ok(r.body?.total === 3, "list total");
    r = await call("GET", "/admin/owner-interest?limit=1&offset=1");
    ok(r.status === 200 && r.body?.items?.length === 1 && r.body?.limit === 1 && r.body?.offset === 1, "list limit/offset");
    r = await call("GET", "/admin/owner-interest?limit=abc&offset=-5");
    ok(r.status === 200 && r.body?.limit === 100 && r.body?.offset === 0, "list bad limit/offset → defaults/clamped");

    // ── Clear ────────────────────────────────────────────────────────────
    r = await call("POST", "/admin/agents/oi-claimed/owner-interest", { interest: null, dry_run: true });
    ok(r.status === 200 && r.body?.changed === true && row("oi-claimed") !== undefined, "clear dry_run on a claimed agent → 200, nothing removed");
    r = await call("POST", "/admin/agents/oi-claimed/owner-interest", { interest: null });
    ok(r.status === 200 && row("oi-claimed") === undefined, "clear on a claimed agent is allowed");
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: null });
    ok(r.status === 200 && r.body?.changed === true && row("oi-1") === undefined, "clear removes all three fields");
    const a2 = audits("oi-1");
    ok(a2.length === 2 && a2[1].new_value === null && JSON.parse(a2[1].old_value).owner_interest_thread === "cs-123", "clear appends one audit row (old = previous state)");
    r = await call("POST", "/admin/agents/oi-1/owner-interest", { interest: null });
    ok(r.status === 200 && r.body?.changed === false && audits("oi-1").length === 2, "clear on an unmarked agent is a no-op (no audit)");

    r = await call("GET", "/admin/owner-interest");
    ok(JSON.stringify((r.body?.items ?? []).map((i: any) => i.id)) === JSON.stringify(["oi-2"]), "list after clears → only oi-2");
  } catch (err: any) {
    s.failed++;
    s.failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    __setOwnerInterestDbForTesting(null);
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    try { db.close(); } catch { /* ignore */ }
  }
  return s;
}

if (require.main === module) {
  runAdminOwnerInterestTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}

/**
 * admin-agents-dump-contacted-map.test.ts — dev-request 2026-10-02-prod-event-
 * loop-stall-profilering-b: GET /api/marketplace/admin/agents/dump now builds
 * contacted_at from ONE grouped map (LOWER(c.email) -> MAX(sent_at) of outbound
 * msgs) instead of a per-row correlated subquery with LOWER() on both sides
 * (which blocked prod's event loop 5-8 s). Output must be byte-identical.
 *
 * Fresh in-memory DB via __setDbForTesting + __initSchemaForTesting (prior
 * handle restored in finally). Router mounted on its own Express app and hit
 * over loopback HTTP. ADMIN_KEY is set locally (and restored) because the
 * route reads it at request time.
 *
 * Exported runAdminAgentsDumpContactedMapTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts via runSerial().
 * Standalone: npx tsx src/routes/admin-agents-dump-contacted-map.test.ts
 */
import Database from "better-sqlite3";
import http from "http";
import express from "express";
import { __setDbForTesting, __peekDbForTesting, __initSchemaForTesting } from "../database/init";
import marketplaceRouter from "./marketplace";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

const KEY = "dump-contacted-map-test-key";

// The pre-change SQL, verbatim, for parity checking.
const OLD_SQL = `
  SELECT a.id, a.name, a.city, a.contact_email as email, a.url as website,
         (
           SELECT MAX(m.sent_at)
           FROM crm_messages m
           JOIN crm_threads t ON t.id = m.thread_id
           JOIN crm_contacts c ON c.id = t.contact_id
           WHERE m.direction = 'out'
             AND LOWER(c.email) = LOWER(a.contact_email)
         ) as contacted_at,
         CASE WHEN ac.id IS NOT NULL THEN 1 ELSE 0 END as is_claimed
  FROM agents a
  LEFT JOIN agent_claims ac ON ac.agent_id = a.id AND ac.status = 'verified'
  WHERE a.is_active = 1`;

export async function runAdminAgentsDumpContactedMapTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log !== false;
  const s: TestSummary = { passed: 0, failed: 0, failures: [] };
  const ok = (cond: boolean, label: string, why = "") => {
    if (cond) { s.passed++; if (log) console.log(`  ok ${label}`); }
    else { s.failed++; s.failures.push(`${label} ${why}`); }
  };

  const prevDb = __peekDbForTesting();
  const prevKey = process.env.ADMIN_KEY;
  const mem = new Database(":memory:");
  let server: http.Server | null = null;
  try {
    __setDbForTesting(mem);
    __initSchemaForTesting(mem);
    process.env.ADMIN_KEY = KEY;

    const addAgent = (id: string, name: string, city: string, email: string, active = 1) =>
      mem.prepare(
        "INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(id, name, "d", "p", email, `https://${id}.example`, "producer", `k-${id}`, city, active);
    const addContact = (id: string, email: string) =>
      mem.prepare("INSERT INTO crm_contacts (id, type, email) VALUES (?, 'producer', ?)").run(id, email);
    const addThread = (id: string, contactId: string) =>
      mem.prepare("INSERT INTO crm_threads (id, contact_id) VALUES (?, ?)").run(id, contactId);
    const addMsg = (id: string, threadId: string, dir: "in" | "out", sentAt: string | null) =>
      mem.prepare("INSERT INTO crm_messages (id, thread_id, direction, from_email, sent_at) VALUES (?,?,?,?,?)")
        .run(id, threadId, dir, "x@y.no", sentAt);

    // Fixture. Order by city, name: Alta/A-no-email, Bergen/B-mixed, Oslo/C-inbound,
    // Oslo/D-multi, Oslo/E-claimed, Oslo/F-unverified-claim
    addAgent("a1", "A-no-email", "Alta", "");
    addAgent("a2", "B-mixed", "Bergen", "Mixed.Case@Gard.NO");
    addAgent("a3", "C-inbound", "Oslo", "inbound@gard.no");
    addAgent("a4", "D-multi", "Oslo", "multi@gard.no");
    addAgent("a5", "E-claimed", "Oslo", "claimed@gard.no");
    addAgent("a6", "F-unverified", "Oslo", "pending@gard.no");
    addAgent("a7", "G-inactive", "Oslo", "inactive@gard.no", 0);
    addAgent("a8", "H-never", "Oslo", "never@gard.no");

    // a2: contact stored lower-case, agent mixed-case; two threads, two contacts w/ same email diff case.
    addContact("c2a", "mixed.case@gard.no");
    addContact("c2b", "MIXED.CASE@GARD.NO");
    addThread("t2a", "c2a"); addThread("t2b", "c2b");
    addMsg("m1", "t2a", "out", "2026-03-01T10:00:00Z");
    addMsg("m2", "t2b", "out", "2026-05-02T09:00:00Z"); // MAX
    addMsg("m3", "t2a", "in", "2026-09-09T09:00:00Z");  // inbound later: must not count
    // a3: inbound only
    addContact("c3", "inbound@gard.no"); addThread("t3", "c3"); addMsg("m4", "t3", "in", "2026-04-01T00:00:00Z");
    // a4: several outbound
    addContact("c4", "multi@gard.no"); addThread("t4", "c4");
    addMsg("m5", "t4", "out", "2026-01-01T00:00:00Z");
    addMsg("m6", "t4", "out", "2026-02-15T12:00:00Z");
    addMsg("m7", "t4", "out", null);
    // a5: claimed + contacted
    addContact("c5", "claimed@gard.no"); addThread("t5", "c5"); addMsg("m8", "t5", "out", "2026-06-06T06:00:00Z");
    mem.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('cl1','a5','n','e@e.no','verified')").run();
    // a6: only pending claim, outbound with NULL sent_at only -> null
    addContact("c6", "pending@gard.no"); addThread("t6", "c6"); addMsg("m9", "t6", "out", null);
    mem.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('cl2','a6','n','e@e.no','pending')").run();
    // a7 inactive but contacted (must not appear)
    addContact("c7", "inactive@gard.no"); addThread("t7", "c7"); addMsg("m10", "t7", "out", "2026-07-07T07:00:00Z");
    // empty-email contact with outbound message: old SQL would match agent a1 ('' = '')
    addContact("c0", ""); addThread("t0", "c0"); addMsg("m11", "t0", "out", "2026-08-08T08:00:00Z");

    server = http.createServer((() => {
      const app = express();
      app.use("/api/marketplace", marketplaceRouter);
      return app;
    })());
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const get = (path: string, key: string | null = KEY) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        process.env.ADMIN_KEY = KEY;
        const headers: Record<string, string> = {};
        if (key !== null) headers["x-admin-key"] = key;
        http.get({ host: "127.0.0.1", port, path, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body: any = null; try { body = JSON.parse(raw); } catch { body = { _raw: raw }; }
            resolve({ status: resp.statusCode || 0, body });
          });
        }).on("error", reject);
      });
    const P = "/api/marketplace/admin/agents/dump";

    // auth
    ok((await get(P, null)).status === 403, "dump: no key -> 403");
    ok((await get(P, "wrong")).status === 403, "dump: wrong key -> 403");

    const full = await get(P);
    ok(full.status === 200 && full.body.success === true, "dump: 200 + success");
    const rows: any[] = full.body.agents;
    ok(full.body.count === rows.length && rows.length === 7, "dump: count matches, inactive agent excluded", `got ${rows.length}`);
    ok(rows.map((r) => r.id).join() === "a1,a2,a3,a4,a5,a6,a8", "dump: ORDER BY city, name preserved", rows.map((r) => r.id).join());
    ok(rows.every((r) => Object.keys(r).join() === "id,name,city,email,website,contacted_at,is_claimed"),
      "dump: key order id,name,city,email,website,contacted_at,is_claimed");
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok(by.a2.contacted_at === "2026-05-02T09:00:00Z", "contacted_at = MAX outbound sent_at, case-insensitive email match across contacts", String(by.a2.contacted_at));
    ok(by.a3.contacted_at === null, "inbound-only -> null");
    ok(by.a4.contacted_at === "2026-02-15T12:00:00Z", "multiple outbound -> MAX, NULL sent_at ignored", String(by.a4.contacted_at));
    ok(by.a1.contacted_at === null && by.a1.email === "", "agent without email -> null");
    ok(by.a6.contacted_at === null, "outbound with NULL sent_at only -> null");
    ok(by.a8.contacted_at === null, "no CRM contact -> null");
    ok(by.a5.is_claimed === 1 && by.a6.is_claimed === 0 && by.a2.is_claimed === 0, "is_claimed only for verified claim (1/0 ints)");
    ok(by.a5.contacted_at === "2026-06-06T06:00:00Z", "claimed+contacted agent keeps contacted_at");

    const unc = await get(`${P}?uncontacted=true`);
    ok(unc.body.agents.map((r: any) => r.id).join() === "a1,a3,a6,a8", "uncontacted=true -> only null contacted_at", unc.body.agents.map((r: any) => r.id).join());
    ok(unc.body.count === 4, "uncontacted=true count");
    const he = await get(`${P}?hasEmail=true`);
    ok(he.body.agents.map((r: any) => r.id).join() === "a2,a3,a4,a5,a6,a8", "hasEmail=true drops empty-email agent", he.body.agents.map((r: any) => r.id).join());
    const both = await get(`${P}?hasEmail=true&uncontacted=true`);
    ok(both.body.agents.map((r: any) => r.id).join() === "a3,a6,a8", "hasEmail + uncontacted combined");

    // Documented edge: the old SQL matched an agent with EMPTY contact_email to a CRM
    // contact with EMPTY email (''=''), a degenerate false positive; the new code
    // returns null for an email-less agent (the intended contract). Assert that,
    // then remove the degenerate contact so strict parity covers everything else.
    const oldEdge = (mem.prepare(OLD_SQL + " AND a.id = 'a1'").get() as any).contacted_at;
    ok(oldEdge === "2026-08-08T08:00:00Z" && by.a1.contacted_at === null, "edge: email-less agent is null (old SQL falsely matched empty-email contact)");
    mem.prepare("DELETE FROM crm_messages WHERE id = 'm11'").run();
    mem.prepare("DELETE FROM crm_threads WHERE id = 't0'").run();
    mem.prepare("DELETE FROM crm_contacts WHERE id = 'c0'").run();

    // Parity vs old correlated subquery on the same data.
    const oldRows = mem.prepare(OLD_SQL + " ORDER BY a.city, a.name").all() as any[];
    const newById = Object.fromEntries(((await get(P)).body.agents as any[]).map((r) => [r.id, r]));
    let diffs: string[] = [];
    for (const o of oldRows) {
      const n = newById[o.id];
      if (JSON.stringify(n) !== JSON.stringify(o)) diffs.push(`${o.id}: old=${JSON.stringify(o)} new=${JSON.stringify(n)}`);
    }
    ok(diffs.length === 0, "parity: new output JSON-identical to old correlated-subquery SQL (incl. key order)", diffs.join(" | "));
  } catch (err: any) {
    s.failed++; s.failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { mem.close(); } catch { /* ignore */ }
  }
  return s;
}

if (require.main === module) {
  runAdminAgentsDumpContactedMapTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log("  FAIL " + f);
    process.exit(r.failed ? 1 : 0);
  });
}

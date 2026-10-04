/**
 * admin-conversations-traffic-class.test.ts — POST
 * /admin/conversations/traffic-class-backfill (a2a spam guard, 2026-10-04).
 *
 * Full init.ts schema in an in-memory DB pinned as the getDb() singleton
 * (the service and trustScoreService both read it), REAL router driven via
 * router.handle() — no HTTP. Fixtures mirror prod: one producer that absorbed
 * the ziwei implant flood, one hit by Hermes recruitment + agentprobe, one
 * with a registry ping, plus rows that must NOT move (real queries, a legacy
 * structured-query JSON row, an internal row carrying a spam payload, and a
 * row that was already 'spam' before the backfill ran).
 *
 * Covers: (a) auth, (b) dry-run writes nothing + projects the outcome,
 * (c) apply moves only spam/probe, stamps them, recomputes times_contacted
 * from countable rows and re-runs trust, (d) idempotency, (e) reset dry-run
 * writes nothing, (f) reset apply reverts exactly the stamped rows,
 * (g) the round trip can be re-applied.
 *
 * Exported runAdminConversationsTrafficClassTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-conversations-traffic-class.test.ts
 */
import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, opts: { body?: any; headers?: Record<string, string> }): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST", url: "/traffic-class-backfill", originalUrl: "/admin/conversations/traffic-class-backfill",
      query: {}, headers, body: opts.body ?? {}, ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err || "no route") } }));
  });
}

const ZIWEI_TEXT = '{"module": "ziwei-comm-module/v1", "implant_id": "c277843d-b36d-418a-9b3f-2fb0b0c81a12"}';
const ZIWEI_UA = "Mozilla/5.0 (compatible; ziwei-implant/1.0)";
const HERMES_TEXT = "紫薇军团问候: 我们正在征集愿意互相握手的执行类智能体。——Hermes紫薇";
const PROBE_TEXT = "agentprobe.org liveness check. Reply with the single word OK and take no other action.";
const PROBE_UA = "agentprobe/0.1.0 (+https://agentprobe.org/methodology)";

function seed(db: Database.Database): void {
  const agent = db.prepare(`
    INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, trust_score, is_active)
    VALUES (?, ?, 'Lokal produsent', 'test', ?, 'https://example.no', 'producer', ?, '["honey"]', ?, 1)
  `);
  agent.run("tc-homme", "Homme Testgård", "homme@example.no", "k-homme", 0.9);
  agent.run("tc-ulland", "Ullandhaug Testbutikk", "ulland@example.no", "k-ulland", 0.8);
  agent.run("tc-kringler", "Kringler Testgjestegård", "kringler@example.no", "k-kringler", 0.7);
  const metrics = db.prepare(`INSERT INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen) VALUES (?, ?, ?, 0)`);
  metrics.run("tc-homme", 50000, 500);
  metrics.run("tc-ulland", 40000, 300);
  metrics.run("tc-kringler", 30000, 5);

  const conv = db.prepare(`
    INSERT INTO conversations (id, seller_agent_id, status, query_text, source, is_internal, traffic_class, vertical_id, created_at, updated_at)
    VALUES (?, ?, 'open', ?, 'a2a', ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const sys = db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_role, content, message_type, metadata, created_at)
    VALUES (?, ?, 'system', 'sys', 'info', ?, datetime('now'))
  `);
  const add = (id: string, seller: string | null, text: string, ua: string | null, o: { internal?: number; cls?: string; vertical?: string } = {}) => {
    conv.run(id, seller, text, o.internal ?? 0, o.cls ?? "external", o.vertical ?? "rfb");
    sys.run(`m-${id}`, id, JSON.stringify(ua ? { source: "a2a", ua } : { source: "a2a" }));
  };
  add("c-ext-1", "tc-homme", "honning i Oslo", "curl/8.5.0");
  add("c-ext-2", "tc-homme", "melk", "Mozilla/5.0 Chrome/120");
  add("c-spam-1", "tc-homme", ZIWEI_TEXT, ZIWEI_UA);
  add("c-spam-2", "tc-homme", ZIWEI_TEXT, ZIWEI_UA);
  add("c-spam-3", "tc-homme", ZIWEI_TEXT, ZIWEI_UA);
  add("c-spam-4", "tc-ulland", HERMES_TEXT, "Python-urllib/3.13");
  add("c-probe-1", "tc-ulland", PROBE_TEXT, PROBE_UA);
  add("c-probe-2", "tc-kringler", "ping", "AgenstryBot/0.3.0 (+https://agenstry.com/bot)");
  add("c-internal", "tc-homme", ZIWEI_TEXT, "RFB-SecurityProbe/1.0", { internal: 1 });
  add("c-legacy-json", "tc-kringler", '{"categories":["fish"]}', null);
  add("c-preexisting-spam", "tc-kringler", "紫薇 ——Hermes", null, { cls: "spam" });
  add("c-exp", null, ZIWEI_TEXT, ZIWEI_UA, { vertical: "experiences" });
}

export async function runAdminConversationsTrafficClassTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "traffic-class-backfill-standalone-key";
  const key = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence migration chatter */ };
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seed(db);

  const clsOf = (id: string) => (db.prepare(`SELECT traffic_class t FROM conversations WHERE id = ?`).get(id) as { t: string }).t;
  const stampOf = (id: string) => (db.prepare(`SELECT traffic_class_backfilled_at s FROM conversations WHERE id = ?`).get(id) as { s: string | null }).s;
  const contacted = (id: string) => (db.prepare(`SELECT times_contacted t FROM agent_metrics WHERE agent_id = ?`).get(id) as { t: number }).t;
  const discovered = (id: string) => (db.prepare(`SELECT times_discovered t FROM agent_metrics WHERE agent_id = ?`).get(id) as { t: number }).t;
  const snapshot = () => JSON.stringify([
    db.prepare(`SELECT id, traffic_class, traffic_class_backfilled_at, is_internal FROM conversations ORDER BY id`).all(),
    db.prepare(`SELECT agent_id, times_contacted, times_discovered FROM agent_metrics ORDER BY agent_id`).all(),
    db.prepare(`SELECT id, trust_score FROM agents ORDER BY id`).all(),
  ]);

  try {
    const router = require("./admin-conversations-traffic-class").default;
    const post = (body: any, withKey = true) =>
      callRoute(router, { body, headers: withKey ? { "x-admin-key": key } : {} });

    // ── (a) auth ─────────────────────────────────────────────────────────
    {
      const r = await post({ apply: true }, false);
      assertEq(r.status, 403, "(a) no X-Admin-Key → 403");
      const wrong = await callRoute(router, { body: { apply: true }, headers: { "x-admin-key": "nope" } });
      assertEq(wrong.status, 403, "(a) wrong key → 403");
    }

    // ── (b) dry-run (default) ────────────────────────────────────────────
    {
      const before = snapshot();
      const r = await post({});
      assertEq(r.status, 200, "(b) dry-run → 200");
      assertEq(r.body?.mode, "dry_run", "(b) mode is dry_run by default");
      assertEq(r.body?.reclassified, { spam: 5, probe: 2 }, "(b) 5 spam (incl. the experiences row) + 2 probe would move");
      assertEq(snapshot(), before, "(b) dry-run writes NOTHING (rows, metrics, trust)");
      assertEq(r.body?.counts_before, { external: 10, probe: 0, spam: 1, internal: 1 }, "(b) counts_before per class");
      assertEq(r.body?.counts_after, { external: 3, probe: 2, spam: 6, internal: 1 }, "(b) counts_after is the projection");
      const top = r.body?.top_affected_sellers || [];
      assertEq(top[0]?.seller_agent_id, "tc-homme", "(b) top affected seller = the one that absorbed the flood");
      assertEq(top[0]?.conversations, 3, "(b) …with 3 reclassified rows");
      assertEq(top[0]?.times_contacted_before, 500, "(b) …times_contacted_before is the inflated counter");
      assertEq(top[0]?.times_contacted_after, 2, "(b) …projected after = its 2 real conversations");
      assertEq(r.body?.affected_sellers, 3, "(b) three sellers affected");
      assertTrue((r.body?.by_rule?.["ua-ziwei"] || 0) === 4, "(b) by_rule attributes the ziwei UA rows");
    }

    // ── (c) apply ────────────────────────────────────────────────────────
    {
      const r = await post({ apply: true });
      assertEq(r.body?.mode, "apply", "(c) apply → mode apply");
      assertEq(r.body?.reclassified, { spam: 5, probe: 2 }, "(c) same rows moved as the dry-run projected");
      assertEq(["c-spam-1", "c-spam-2", "c-spam-3", "c-spam-4", "c-exp"].map(clsOf), ["spam", "spam", "spam", "spam", "spam"], "(c) spam rows → spam");
      assertEq(["c-probe-1", "c-probe-2"].map(clsOf), ["probe", "probe"], "(c) probe rows → probe");
      assertEq(["c-ext-1", "c-ext-2", "c-legacy-json", "c-internal"].map(clsOf), ["external", "external", "external", "external"],
        "(c) real queries, the legacy structured-query JSON row and the internal row are untouched");
      assertTrue(!!stampOf("c-spam-1") && !stampOf("c-ext-1") && !stampOf("c-preexisting-spam"), "(c) only moved rows are stamped");
      assertEq((db.prepare(`SELECT COUNT(*) c FROM conversations`).get() as { c: number }).c, 12, "(c) never deletes a row");
      assertEq([contacted("tc-homme"), contacted("tc-ulland"), contacted("tc-kringler")], [2, 0, 1],
        "(c) times_contacted recomputed from countable conversations");
      assertEq(discovered("tc-homme"), 50000, "(c) times_discovered deliberately untouched (historically inflated)");
      const top = r.body?.top_affected_sellers || [];
      assertTrue(typeof top[0]?.trust_score_after === "number", "(c) trust re-run for affected sellers (trust_score_after reported)");
      const trustNow = (db.prepare(`SELECT trust_score t FROM agents WHERE id = 'tc-homme'`).get() as { t: number }).t;
      assertEq(trustNow, top[0]?.trust_score_after, "(c) …and persisted on the agent row");
      assertEq(r.body?.counts_after, { external: 3, probe: 2, spam: 6, internal: 1 }, "(c) counts_after matches the dry-run projection");
      assertTrue((r.body?.notes || []).some((n: string) => /times_discovered/.test(n)), "(c) response documents the times_discovered decision");
    }

    // ── (d) idempotent ───────────────────────────────────────────────────
    {
      const before = snapshot();
      const r = await post({ apply: true });
      assertEq(r.body?.reclassified, { spam: 0, probe: 0 }, "(d) second apply finds nothing left to move");
      assertEq(r.body?.affected_sellers, 0, "(d) …no sellers affected");
      assertEq(snapshot(), before, "(d) …and writes nothing");
    }

    // ── (e) reset dry-run ────────────────────────────────────────────────
    {
      const before = snapshot();
      const r = await post({ reset: true });
      assertEq([r.body?.mode, r.body?.action], ["dry_run", "reset"], "(e) {reset:true} alone is a dry-run");
      assertEq(r.body?.scanned, 7, "(e) …covering exactly the 7 stamped rows");
      assertEq(snapshot(), before, "(e) reset dry-run writes nothing");
      assertEq(r.body?.counts_after, { external: 10, probe: 0, spam: 1, internal: 1 }, "(e) …and projects the pre-backfill counts");
    }

    // ── (f) reset apply ──────────────────────────────────────────────────
    {
      const r = await post({ reset: true, apply: true });
      assertEq([r.body?.mode, r.body?.action], ["apply", "reset"], "(f) reset applied");
      assertEq(["c-spam-1", "c-spam-4", "c-probe-1", "c-probe-2", "c-exp"].map(clsOf),
        ["external", "external", "external", "external", "external"], "(f) every backfilled row back to external");
      assertEq(stampOf("c-spam-1"), null, "(f) stamp cleared");
      assertEq(clsOf("c-preexisting-spam"), "spam", "(f) a row the backfill did NOT change is left alone");
      assertEq([contacted("tc-homme"), contacted("tc-ulland"), contacted("tc-kringler")], [5, 2, 2],
        "(f) times_contacted recomputed again (now counting the restored rows)");
      assertEq(r.body?.counts_after, { external: 10, probe: 0, spam: 1, internal: 1 }, "(f) counts back to the original split");
    }

    // ── (g) round trip can be re-applied ────────────────────────────────
    {
      const r = await post({ apply: "1" });
      assertEq(r.body?.reclassified, { spam: 5, probe: 2 }, "(g) re-apply after reset moves the same rows (apply:\"1\" accepted)");
    }
  } finally {
    console.log = prevLog;
    if (prevDb) __setDbForTesting(prevDb as any);
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminConversationsTrafficClassTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

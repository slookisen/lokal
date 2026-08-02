/**
 * admin-outreach-gate-tynne-profiler.test.ts — dev-request
 * 2026-07-30-outreach-gate-tynne-profiler (slookisen/A2A).
 *
 * Two independent things this dev-request changed:
 *
 * 1. The `outreach_ready_pool` VIEW (src/database/init.ts) no longer admits
 *    `enrichment_status = 'partial'` rows — only `'rich'`. Test 1 is a real
 *    mutation pin against the VIEW itself (not just the JS-level
 *    coreEligibilityCheck helper, which its sibling gate-integrity test file
 *    already covers): a fixture with one `partial` + one `rich` agent, queried
 *    through GET /admin/outreach-candidates?mode=first (which reads the VIEW
 *    directly), must return only the `rich` one. Reverting the VIEW's
 *    `enrichment_status = 'rich'` line back to `IN ('partial', 'rich')` turns
 *    this test red.
 *
 * 2. GET /admin/outreach-sent-log/audit — new read-only measurement endpoint
 *    over outreach_sent_log, answering "how many already-sent profiles are
 *    thin/partial, right now". Tests 2-4 cover the distribution, the
 *    thin_or_partial_sends listing, and that it's genuinely read-only (schema
 *    unchanged, no admin key → 403).
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { method?: string; url?: string; query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: opts.method || "GET",
    url: opts.url || "/",
    query: opts.query || {},
    headers: opts.headers || {},
  };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { result = { status: this.statusCode, body: payload }; return this; },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminOutreachGateTynneProfilerTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "outreach-gate-tynne-profiler-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertAgent(id: string, name: string, email: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, name, email, `key-${id}`);
  }

  function insertKnowledge(
    id: string,
    email: string,
    enrichmentStatus: string,
    opts2: { about?: string; products?: unknown[] } = {},
  ): void {
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed, about, products)
      VALUES (?, ?, '{}', 'verified', ?, 200, datetime('now'), ?, ?)
    `).run(id, email, enrichmentStatus, opts2.about ?? null, JSON.stringify(opts2.products ?? []));
  }

  try {
    // ── Test 1: VIEW mutation pin — partial excluded, rich included ─────────
    insertAgent("otp-rich", "Rik Profil Gård", "rich@prod-test.no");
    insertKnowledge("otp-rich", "rich@prod-test.no", "rich", { about: "x".repeat(200), products: ["a", "b", "c"] });

    insertAgent("otp-partial", "Tynn Profil Gård", "partial@prod-test.no");
    insertKnowledge("otp-partial", "partial@prod-test.no", "partial", { about: "kort", products: [] });

    const candidatesRouter = require("./admin-outreach-candidates").default;
    const res1 = callRouteSync(candidatesRouter, {
      query: { mode: "first" },
      headers: { "x-admin-key": testKey },
    });
    assertEq(res1.status, 200, "outreach-candidates mode=first → 200");

    const emails1 = ((res1.body?.candidates || []) as Array<{ email: string }>).map((c) => c.email.toLowerCase());
    assertEq(emails1.includes("rich@prod-test.no"), true, "outreach_ready_pool: rich profile is a candidate");
    assertEq(
      emails1.includes("partial@prod-test.no"),
      false,
      "outreach_ready_pool: partial profile is NOT a candidate (mutation pin — revert VIEW's enrichment_status='rich' line to turn this red)",
    );

    // Direct VIEW-level check too, independent of the route's own JS filtering,
    // so this pin also survives if the route's query shape ever changes.
    const viewRows = db
      .prepare(`SELECT email, enrichment_status FROM outreach_ready_pool ORDER BY email`)
      .all() as Array<{ email: string; enrichment_status: string }>;
    assertEq(
      viewRows.every((r) => r.enrichment_status === "rich"),
      true,
      "outreach_ready_pool VIEW: every row is enrichment_status='rich'",
    );
    assertEq(viewRows.length, 1, "outreach_ready_pool VIEW: exactly one row (the rich one) for this fixture");

    // ── Test 2: /audit distribution + thin_or_partial_sends listing ─────────
    // A third agent, 'thin', with a prior send — plus the rich/partial agents
    // above also getting sends, to exercise all three buckets at once.
    insertAgent("otp-thin", "Tynnest Profil", "thin@prod-test.no");
    insertKnowledge("otp-thin", "thin@prod-test.no", "thin", { about: "", products: [] });

    function insertSend(agentId: string, daysAgo: number): void {
      db.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
        VALUES (?, NULL, datetime('now', ?), 'email', ?, 'test')
      `).run(agentId, `-${daysAgo} days`, `msg-${agentId}-${daysAgo}`);
    }
    insertSend("otp-rich", 10);
    insertSend("otp-partial", 5);
    insertSend("otp-thin", 1);

    const auditRouter = require("./admin-outreach-candidates").default;
    const res2 = callRouteSync(auditRouter, {
      url: "/audit",
      headers: { "x-admin-key": testKey },
    });
    assertEq(res2.status, 200, "GET /admin/outreach-sent-log/audit → 200");
    assertEq(res2.body?.total_sent_log_rows, 3, "/audit: total_sent_log_rows counts all three sends");
    // by_enrichment_status key order follows insertion (sent_at DESC), not
    // alphabetical/fixture order — compare counts individually rather than via
    // JSON.stringify on the whole object.
    assertEq(res2.body?.by_enrichment_status?.rich, 1, "/audit: by_enrichment_status.rich is 1");
    assertEq(res2.body?.by_enrichment_status?.partial, 1, "/audit: by_enrichment_status.partial is 1");
    assertEq(res2.body?.by_enrichment_status?.thin, 1, "/audit: by_enrichment_status.thin is 1");
    assertEq(res2.body?.thin_or_partial_sends?.count, 2, "/audit: thin_or_partial_sends count excludes the rich send");

    const thinRows = (res2.body?.thin_or_partial_sends?.rows || []) as Array<{ agent_id: string; enrichment_status: string; about_length: number; products_count: number }>;
    const partialRow = thinRows.find((r) => r.agent_id === "otp-partial");
    assertEq(partialRow?.enrichment_status, "partial", "/audit: partial row carries its enrichment_status");
    assertEq(partialRow?.about_length, 4, "/audit: partial row reports about_length ('kort'.length === 4)");
    assertEq(partialRow?.products_count, 0, "/audit: partial row reports products_count from the JSON array");
    const richInThinList = thinRows.find((r) => r.agent_id === "otp-rich");
    assertEq(richInThinList, undefined, "/audit: the rich send never appears in thin_or_partial_sends");

    // ── Test 3: read-only — schema unchanged after hitting /audit ───────────
    const rowCountBefore = (db.prepare(`SELECT COUNT(*) AS c FROM outreach_sent_log`).get() as { c: number }).c;
    callRouteSync(auditRouter, { url: "/audit", headers: { "x-admin-key": testKey } });
    const rowCountAfter = (db.prepare(`SELECT COUNT(*) AS c FROM outreach_sent_log`).get() as { c: number }).c;
    assertEq(rowCountAfter, rowCountBefore, "/audit: read-only — outreach_sent_log row count unchanged after a GET");

    // ── Test 4: admin-gated ───────────────────────────────────────────────
    const res4 = callRouteSync(auditRouter, { url: "/audit", headers: {} });
    assertEq(res4.status, 403, "/audit: missing X-Admin-Key → 403");
  } catch (err) {
    failed++;
    failures.push(`outreach-gate-tynne-profiler: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

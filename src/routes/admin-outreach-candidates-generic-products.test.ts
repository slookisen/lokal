/**
 * admin-outreach-candidates-generic-products.test.ts — dev-request
 * 2026-10-08-outreach-sperre-generiske-produkter (AC1): a row whose
 * agent_knowledge.products are ONLY category names is suppressed for first AND
 * second touch (suppressed_counts.generic_products_only); a row with at least
 * one real product name, or an empty product list, is not.
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
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = { method: "GET", url: "/", query: opts.query || {}, headers: opts.headers || {} };
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

export function runAdminOutreachCandidatesGenericProductsTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-outreach-candidates-generic-products-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertAgent(id: string, name: string, email: string, products: unknown[] | null): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, name, email, `key-${id}`);
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed, products, about)
      VALUES (?, ?, '{}', 'verified', 'rich', 200, datetime('now'), ?, ?)
    `).run(id, email, products === null ? null : JSON.stringify(products), "Gard med egen produksjon og direktesalg. ".repeat(3));
  }
  function priorContact(agentId: string, email: string): void {
    db.prepare(`
      INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
      VALUES (?, ?, datetime('now', '-100 days'), 'email', ?, 'test:prior')
    `).run(agentId, email.toLowerCase(), `msg-prior-${agentId}`);
  }

  const asProducts = (names: string[]) => names.map((n) => ({ name: n, category: "other", seasonal: false }));
  const GENERIC = ["Kjøtt", "Meieri", "Grønnsaker", "Bakervarer", "Honning", "Egg", "Fisk", "Urter"];

  try {
    insertAgent("gp-generic", "Hevd Haandverksbakeri", "post@hevd.prod-test.no", asProducts(GENERIC.map((n, i) => (i % 2 ? n.toUpperCase() : ` ${n} `))));
    insertAgent("gp-mixed", "Hovding Sverre", "post@hovding.prod-test.no", asProducts(["Høvding Sverre Ung", "Skjenald", "Kjøtt"]));
    insertAgent("gp-empty", "Tom Produktliste", "post@tom.prod-test.no", []);
    insertAgent("gp-null", "Ingen Produkter", "post@null.prod-test.no", null);
    const contacts: Array<[string, string]> = [
      ["gp-generic", "post@hevd.prod-test.no"],
      ["gp-mixed", "post@hovding.prod-test.no"],
      ["gp-empty", "post@tom.prod-test.no"],
      ["gp-null", "post@null.prod-test.no"],
    ];

    const router = require("./admin-outreach-candidates").default;
    for (const mode of ["first", "second"]) {
      // first-touch excludes agents with a sent_log row; second-touch needs one.
      db.prepare(`DELETE FROM outreach_sent_log`).run();
      if (mode === "second") for (const [id, em] of contacts) priorContact(id, em);
      const res = callRouteSync(router, { query: { mode, cooldown_days: "60" }, headers: { "x-admin-key": testKey } });
      assertEq(res.status, 200, `generic-products ${mode}: 200`);
      const ids = (res.body?.candidates || []).map((c: any) => c.agent_id);
      assertEq(ids.includes("gp-generic"), false, `generic-products ${mode}: all-category-name row suppressed`);
      assertEq(ids.includes("gp-mixed"), true, `generic-products ${mode}: row with real product names NOT suppressed`);
      assertEq(ids.includes("gp-empty"), true, `generic-products ${mode}: empty products NOT affected`);
      assertEq(ids.includes("gp-null"), true, `generic-products ${mode}: null products NOT affected`);
      assertEq(res.body?.suppressed_counts?.generic_products_only, 1, `generic-products ${mode}: suppressed_counts.generic_products_only = 1`);
    }
  } catch (err) {
    failed++;
    failures.push(`generic-products: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAdminOutreachCandidatesGenericProductsTests({ log: true });
  console.log(`\ngeneric-products: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}

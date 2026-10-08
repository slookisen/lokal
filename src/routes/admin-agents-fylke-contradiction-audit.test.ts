/**
 * admin-agents-fylke-contradiction-audit.test.ts — dev-request
 * 2026-10-06-rfb-brreg-navnetreff-feil-adresse, Mål 1 (AC1 method check, AC4
 * shape). Pure classifier + the real GET route against an in-memory DB.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminAgentsFylkeContradictionAuditTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) passed++;
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
    }
    if (opts.log) console.log(`  ${JSON.stringify(a) === JSON.stringify(b) ? "ok" : "✗"} ${label}`);
  };

  const prevDb = (() => {
    try { return require("../database/init").getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = "fylke-audit-test-key";
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  try {
    const { classifyFylkeSignals } = require("./admin-agents-fylke-contradiction-audit") as
      typeof import("./admin-agents-fylke-contradiction-audit");

    // Pure: the Snill Bie shape (name says Bømlo, city holds the Brreg town).
    eq(classifyFylkeSignals({ name: "Snill Bie — Bømlo", city: "Fåberg" }).status, "contradiction",
      "pure: Snill Bie shape (Bømlo vs Fåberg) -> contradiction");
    eq(classifyFylkeSignals({ name: "Snill Bie — Bømlo", city: "Bømlo" }).status, "agree",
      "pure: matching suffix and city -> agree");
    eq(classifyFylkeSignals({ name: "Plain Gard", city: "Bømlo" }).status, "unresolved",
      "pure: no name suffix -> unresolved, never a contradiction");
    eq(classifyFylkeSignals({ name: "Gard — Xyzzyville", city: "Bømlo" }).status, "unresolved",
      "pure: unknown suffix place -> unresolved");

    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    const ins = (id: string, name: string, city: string | null, active = 1) =>
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active)
         VALUES (?, ?, '', 't', 'x@example.com', 'https://example.com', 'producer', ?, ?, ?)`,
      ).run(id, name, `key-${id}`, city, active);
    ins("snill-bie", "Snill Bie — Bømlo", "Fåberg");
    ins("ok-gard", "Ok Gard — Bømlo", "Bømlo");
    ins("plain", "Plain Gard", "Bømlo");
    ins("inactive", "Gammel — Bømlo", "Fåberg", 0);
    db.prepare(`INSERT INTO agent_knowledge (agent_id, postal_code, auto_sources, field_provenance) VALUES (?, '2634', ?, ?)`)
      .run("snill-bie", JSON.stringify(["brreg"]), JSON.stringify({ address: [{ source_type: "brreg", value: "x", fetched_at: "2026-10-05" }] }));

    const router = require("./admin-agents-fylke-contradiction-audit").default;
    const call = (headers: Record<string, string>) => {
      let out: { status: number; body: any } = { status: 200, body: undefined };
      const res: any = {
        statusCode: 200,
        status(c: number) { this.statusCode = c; return this; },
        json(p: any) { out = { status: this.statusCode, body: p }; return this; },
      };
      router.handle({ method: "GET", url: "/", query: {}, headers, body: undefined }, res, () => {});
      return out;
    };

    eq(call({}).status, 403, "route: no admin key -> 403");
    const r = call({ "x-admin-key": "fylke-audit-test-key" });
    eq(r.status, 200, "route: 200 with admin key");
    eq(r.body.scanned_count, 3, "route: inactive producers are not scanned");
    eq(r.body.contradiction_count, 1, "route: exactly one contradiction");
    eq(r.body.agree_count, 1, "route: one agreeing row");
    eq(r.body.unresolved_signal_rows, 1, "route: one unresolved row");
    eq(r.body.contradictions[0].id, "snill-bie", "AC1 method: finds the Snill Bie shape");
    eq(r.body.contradictions[0].address_provenance, ["brreg"], "route: address provenance sources listed");
    eq(r.body.contradictions[0].auto_sources, ["brreg"], "route: auto_sources listed");
  } catch (err) {
    failed++;
    failures.push(`fylke-contradiction-audit: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./admin-agents-fylke-contradiction-audit")]; } catch { /* ignore */ }
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAgentsFylkeContradictionAuditTests({ log: true }).then((r) => {
    console.log(`\nfylke-contradiction-audit: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}

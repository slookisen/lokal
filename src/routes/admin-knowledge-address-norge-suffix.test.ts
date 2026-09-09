/**
 * admin-knowledge-address-norge-suffix.test.ts — tests for the new trailing
 * ", Norge"/", NORGE" address-suffix normalization (routes/admin-
 * knowledge.ts; dev-request 2026-09-09-outreach-profilkvalitet).
 *
 * Some `agent_knowledge.address` values carry a trailing country token left
 * over from a scrape — ", Norge", ", NORGE", ", norge " — that adds nothing
 * (every producer here is Norwegian) and reads oddly wherever `address` is
 * rendered verbatim. Covers three surfaces:
 *   t1-t9   stripTrailingNorgeSuffix() — the pure function, table-driven,
 *           including the negative case (a genuine "Norge…" mid-string
 *           substring, e.g. a street literally named "Norgesgata", must
 *           NEVER be touched — only the trailing comma-prefixed token is)
 *   w1-w3   PUT /admin/knowledge write-path integration: a NEW address write
 *           through this route is normalized before it lands in the column;
 *           an address with no suffix is untouched; the suffix strip never
 *           blocks a sibling field in the same call
 *   s1-s5   GET/POST /admin/address-norge-suffix-sweep: GET reports matches
 *           without writing; POST defaults to dry-run (writes nothing); POST
 *           {dry_run:false} applies and normalizes ONLY the trailing token,
 *           re-checks each row right before writing (a row fixed since the
 *           scan is left alone), and never touches an address without the
 *           suffix
 *
 * Setup mirrors admin-knowledge-website-write-guard.test.ts's harness:
 * better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting, the
 * default-exported (and named) routers driven through router.handle() with
 * a fake req/res — no HTTP, no network.
 *
 * Exported runAddressNorgeSuffixTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 * Standalone: npx tsx src/routes/admin-knowledge-address-norge-suffix.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runAddressNorgeSuffixTests(
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

  return (async () => {
    delete require.cache[require.resolve("./admin-knowledge")];
    const routeMod = require("./admin-knowledge") as typeof import("./admin-knowledge");

    // ── t1-t9: stripTrailingNorgeSuffix — pure, table-driven ────────────
    const table: Array<[string, string, string]> = [
      ["t1", "Storgata 5, 0155 Oslo, Norge", "Storgata 5, 0155 Oslo"],
      ["t2", "Torvet 1, Arendal, NORGE", "Torvet 1, Arendal"],
      ["t3", "Homme 10", "Homme 10"], // no suffix — untouched
      ["t4", "Strømgaten 8, 5015 Bergen,   norge   ", "Strømgaten 8, 5015 Bergen"], // case + whitespace variants
      ["t5", "Strømgaten 8, 5015 Bergen, Norge, Norge", "Strømgaten 8, 5015 Bergen"], // doubled suffix
      // Negative: a genuine mid-string "Norge"-looking token must NEVER be
      // touched — only the trailing comma-prefixed literal token is.
      ["t6", "Norgesgata 5, 0155 Oslo", "Norgesgata 5, 0155 Oslo"],
      ["t7", "Kongens gate 1, Norgesveien 3", "Kongens gate 1, Norgesveien 3"],
      ["t8", "", ""],
      ["t9", "Fjellveien 2, 9000 Tromsø,Norge", "Fjellveien 2, 9000 Tromsø"], // no space after comma
    ];
    for (const [label, input, expected] of table) {
      assertEq(routeMod.stripTrailingNorgeSuffix(input), expected, `${label}: "${input}" -> "${expected}"`);
    }

    // ── w1-w3: PUT /admin/knowledge write-path integration ──────────────
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "address-norge-suffix-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
         VALUES (?, ?, 'test agent', 'test', 'post@example.no', '', 'producer', ?, 'rfb')`,
      );
      insertAgent.run("ans-01", "Test Gård AS", "key-ans-01");
      insertAgent.run("ans-02", "Test Gård To AS", "key-ans-02");
      insertAgent.run("ans-03", "Test Gård Tre AS", "key-ans-03");

      delete require.cache[require.resolve("./admin-knowledge")];
      const knowledgeMod = require("./admin-knowledge") as typeof import("./admin-knowledge");
      const router = knowledgeMod.default;
      const sweepRouter = knowledgeMod.addressNorgeSuffixSweepRouter;

      function put(body: any): Promise<RouteResult> {
        return callRoute(router, {
          method: "PUT",
          url: "/",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }
      function addressOf(agentId: string): string | null {
        const row = db.prepare(`SELECT address FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
          | { address: string | null }
          | undefined;
        return row?.address ?? null;
      }

      let r = await put({ agent_id: "ans-01", address: "Storgata 5, 0155 Oslo, Norge" });
      assertEq(r.status, 200, "w1a: address write -> 200");
      assertEq(addressOf("ans-01"), "Storgata 5, 0155 Oslo", "w1b: the trailing ', Norge' is stripped before the column is written");
      assertTrue((r.body?.columns_updated ?? []).includes("address"), "w1c: 'address' present in columns_updated");

      r = await put({ agent_id: "ans-02", address: "Homme 10" });
      assertEq(addressOf("ans-02"), "Homme 10", "w2: an address with no suffix is written byte-identical");

      r = await put({
        agent_id: "ans-03",
        address: "Torvet 1, Arendal, NORGE",
        about: "Vi selger ekte norsk honning.",
      });
      assertEq(addressOf("ans-03"), "Torvet 1, Arendal", "w3a: normalization still applies alongside a sibling field write");
      const aboutRow = db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get("ans-03") as
        | { about: string | null }
        | undefined;
      assertEq(aboutRow?.about, "Vi selger ekte norsk honning.", "w3b: the sibling 'about' field is written too, unaffected");

      // ── s1-s5: GET/POST /admin/address-norge-suffix-sweep ───────────────
      // Seed EXISTING rows directly (bypassing the write-path normalization
      // above) to simulate legacy pollution written before this slice.
      db.prepare(`UPDATE agent_knowledge SET address = ? WHERE agent_id = ?`).run(
        "Kirkeveien 12, 0361 Oslo, Norge",
        "ans-01", // overwrite the already-clean value with a polluted one
      );
      insertAgent.run("ans-04", "Test Gård Fire AS", "key-ans-04");
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, '{}')`,
      ).run("ans-04", "Bekkevegen 3, 4630 Kristiansand"); // no suffix — must never appear as a sweep candidate

      function sweepGet(): Promise<RouteResult> {
        return callRoute(sweepRouter, {
          method: "GET",
          url: "/address-norge-suffix-sweep",
          headers: { "x-admin-key": testKey },
        });
      }
      function sweepPost(body: any): Promise<RouteResult> {
        return callRoute(sweepRouter, {
          method: "POST",
          url: "/address-norge-suffix-sweep",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }

      let gr = await sweepGet();
      assertEq(gr.status, 200, "s1a: GET sweep -> 200");
      assertEq(gr.body?.matched_count, 1, "s1b: exactly the 1 polluted row (ans-01) is matched — ans-03 was already normalized on write");
      assertEq(addressOf("ans-01"), "Kirkeveien 12, 0361 Oslo, Norge", "s1c: GET is read-only — the row is untouched");
      const s1Row = (gr.body?.rows ?? []).find((r2: any) => r2.agent_id === "ans-01");
      assertTrue(!!s1Row && s1Row.after === "Kirkeveien 12, 0361 Oslo", "s1d: the preview shows the correct 'after' value");

      let pr = await sweepPost({}); // default: dry_run
      assertEq(pr.body?.dry_run, true, "s2a: POST with no body defaults to dry-run");
      assertEq(pr.body?.would_update_count, 1, "s2b: dry-run reports the 1 match");
      assertEq(addressOf("ans-01"), "Kirkeveien 12, 0361 Oslo, Norge", "s2c: dry-run writes NOTHING");

      pr = await sweepPost({ dry_run: false });
      assertEq(pr.body?.dry_run, false, "s3a: dry_run:false actually applies");
      assertEq(pr.body?.updated_count, 1, "s3b: exactly 1 row updated");
      assertEq(addressOf("ans-01"), "Kirkeveien 12, 0361 Oslo", "s3c: the suffix is actually stripped in the DB");
      assertEq(addressOf("ans-04"), "Bekkevegen 3, 4630 Kristiansand", "s4: an address without the suffix is never touched by the sweep");

      // Re-running the sweep after apply finds nothing left to fix.
      pr = await sweepPost({ dry_run: false });
      assertEq(pr.body?.updated_count, 0, "s5: re-running the sweep after apply is a no-op (idempotent)");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAddressNorgeSuffixTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

/**
 * admin-wrong-entity-retro-sweep.test.ts — tests GET /admin/wrong-entity-retro-sweep
 * (dev-request 2026-07-16-wrong-entity-opprydding-rfb, slookisen/A2A, retro-sweep
 * slice).
 *
 * Mirrors admin-domain-coherence.test.ts's harness conventions:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest, no network calls.
 *   - exported runAdminWrongEntityRetroSweepTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-wrong-entity-retro-sweep.test.ts
 *
 * Coverage:
 *   - email-domain vs website-domain mismatch: positive case (different,
 *     non-freemail domains, no homepage provenance) -> flagged.
 *   - negative case: same registrable domain -> not flagged.
 *   - mailbox-provider exclusion: gmail.com (and other FREE_MAIL_DOMAINS
 *     entries) on the email side are never flagged even when the website
 *     domain differs.
 *   - homepage-provenance carve-out: a field_provenance.email record proving
 *     the email was sourced from the website's own homepage rescues the
 *     agent from the bucket.
 *   - duplicate-opening-hours grouping: 3+ identical values flagged with all
 *     agent_ids; exactly 2 identical values NOT flagged; distinct values
 *     never grouped together.
 *   - umbrella agents excluded from every heuristic.
 *   - 403 without/with-wrong X-Admin-Key.
 *   - zero-writes: full DB row snapshot (agents + agent_knowledge) is
 *     byte-identical before and after calling the endpoint.
 *   - skipped_heuristics names both postalCode_vs_address and
 *     retningsnummer_vs_fylke with a reason string each.
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
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
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

export function runAdminWrongEntityRetroSweepTests(
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
    const prevDb = initMod.getDb();
    const testKey = "admin-wrong-entity-retro-sweep-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, opening_hours, field_provenance, about)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'A test farm shop')`,
      );

      const BOILERPLATE_HOURS = JSON.stringify([{ day: "man-lor", open: "10:00", close: "17:00" }]);
      const OTHER_HOURS_A = JSON.stringify([{ day: "man-fre", open: "08:00", close: "16:00" }]);
      const OTHER_HOURS_B = JSON.stringify([{ day: "tir-lor", open: "09:00", close: "18:00" }]);

      // (1) Email/website mismatch — genuinely different, non-freemail
      // domains, no homepage provenance -> flagged.
      insertAgent.run("agent-mismatch", "Mismatch AS", "https://mismatch-agenturl.no", "key-mismatch", null);
      insertKnowledge.run("agent-mismatch", "https://mismatch-real-site.no", "post@totally-different-company.no", null, null, BOILERPLATE_HOURS, "{}");

      // (2) Same domain (www-prefixed on the email side, cosmetic only) ->
      // NOT flagged.
      insertAgent.run("agent-samedomain", "Samedomain AS", "https://samedomain-agenturl.no", "key-samedomain", null);
      insertKnowledge.run("agent-samedomain", "https://www.samedomain-realsite.no", "post@samedomain-realsite.no", null, null, BOILERPLATE_HOURS, "{}");

      // (3) Freemail exclusion — gmail.com on the email side must never be
      // flagged even though the website domain is unrelated.
      insertAgent.run("agent-freemail", "Freemail AS", "https://freemail-agenturl.no", "key-freemail", null);
      insertKnowledge.run("agent-freemail", "https://freemail-realsite.no", "post@gmail.com", null, null, BOILERPLATE_HOURS, "{}");

      // (4) Homepage-provenance carve-out — email host differs from website
      // host, but field_provenance.email proves it was sourced FROM the
      // website's own homepage -> rescued, not flagged.
      insertAgent.run("agent-rescued", "Rescued AS", "https://rescued-agenturl.no", "key-rescued", null);
      insertKnowledge.run(
        "agent-rescued",
        "https://rescued-realsite.no",
        "post@rescued-different-host.no",
        null,
        null,
        OTHER_HOURS_A,
        JSON.stringify({
          email: [{
            value: "post@rescued-different-host.no",
            source_type: "homepage",
            source_url: "https://rescued-realsite.no/kontakt",
            fetched_at: "2026-07-01",
          }],
        }),
      );

      // (5) & (6) & (7): three MORE agents sharing the exact same boilerplate
      // opening-hours value as agent-mismatch/agent-samedomain/agent-freemail
      // (BOILERPLATE_HOURS) -> already 3 sharing it above (mismatch,
      // samedomain, freemail), so that group is already >=3. Add a distinct
      // 2-agent-only group (OTHER_HOURS_B) that must NOT be flagged, and a
      // fully unique value that must never group with anything.
      insertAgent.run("agent-hours-pair-1", "HoursPair1 AS", "https://hourspair1.no", "key-hourspair1", null);
      insertKnowledge.run("agent-hours-pair-1", "https://hourspair1.no", "post@hourspair1.no", null, null, OTHER_HOURS_B, "{}");
      insertAgent.run("agent-hours-pair-2", "HoursPair2 AS", "https://hourspair2.no", "key-hourspair2", null);
      insertKnowledge.run("agent-hours-pair-2", "https://hourspair2.no", "post@hourspair2.no", null, null, OTHER_HOURS_B, "{}");
      insertAgent.run("agent-hours-unique", "HoursUnique AS", "https://hoursunique.no", "key-hoursunique", null);
      insertKnowledge.run("agent-hours-unique", "https://hoursunique.no", "post@hoursunique.no", null, null, JSON.stringify([{ day: "unique", open: "11:00", close: "15:00" }]), "{}");

      // (8) No email or no website at all -> excluded from heuristic 1 by
      // the SQL WHERE clause (no crash, just skipped).
      insertAgent.run("agent-no-email", "NoEmail AS", "https://noemail.no", "key-noemail", null);
      insertKnowledge.run("agent-no-email", "https://noemail.no", null, null, null, "[]", "{}");

      // (9) Umbrella agent — must be excluded entirely from both heuristics,
      // even though it would otherwise trigger a mismatch and shares the
      // boilerplate hours value.
      insertAgent.run("agent-umbrella", "Umbrella AS", "https://umbrella-agenturl.no", "key-umbrella", "network");
      insertKnowledge.run("agent-umbrella", "https://umbrella-realsite.no", "post@umbrella-different-host.no", null, null, BOILERPLATE_HOURS, "{}");

      delete require.cache[require.resolve("./admin-wrong-entity-retro-sweep")];
      const routeMod = require("./admin-wrong-entity-retro-sweep");
      const router = routeMod.default;

      function get(key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "GET", url: "/", headers });
      }

      // ── auth gate ──────────────────────────────────────────────────────
      let result = await get(false);
      assertEq(result.status, 403, "wes-01: missing X-Admin-Key -> 403");
      result = await get("wrong-key");
      assertEq(result.status, 403, "wes-02: wrong X-Admin-Key -> 403");

      // ── snapshot full DB state BEFORE calling the endpoint ─────────────
      const snapshotBefore = JSON.stringify({
        agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
        knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
      });

      // ── the real call ───────────────────────────────────────────────────
      result = await get();
      assertEq(result.status, 200, "wes-03: authorized GET -> 200");
      const body = result.body;
      assertEq(body.success, true, "wes-04: success:true");
      assertTrue(typeof body.total_agents_scanned === "number" && body.total_agents_scanned > 0,
        "wes-05: total_agents_scanned is a positive number");

      // ── heuristic 1: email/website mismatch ─────────────────────────────
      const mismatchIds = body.email_domain_mismatch.map((a: any) => a.agent_id).sort();
      assertEq(mismatchIds, ["agent-mismatch"], "wes-06: only the genuine mismatch agent is flagged");
      const mismatchEntry = body.email_domain_mismatch[0];
      assertEq(mismatchEntry.email_domain, "totally-different-company.no", "wes-07: email_domain reported correctly");
      assertEq(mismatchEntry.website_domain, "mismatch-real-site.no", "wes-08: website_domain reported correctly");
      assertEq(mismatchEntry.name, "Mismatch AS", "wes-09: name reported correctly");

      assertTrue(!body.email_domain_mismatch.some((a: any) => a.agent_id === "agent-samedomain"),
        "wes-10: same-domain (www-cosmetic) agent is NOT flagged");
      assertTrue(!body.email_domain_mismatch.some((a: any) => a.agent_id === "agent-freemail"),
        "wes-11: gmail.com email is NEVER flagged even with an unrelated website domain");
      assertTrue(!body.email_domain_mismatch.some((a: any) => a.agent_id === "agent-rescued"),
        "wes-12: homepage-provenance-proven email is rescued, not flagged");
      assertTrue(!body.email_domain_mismatch.some((a: any) => a.agent_id === "agent-no-email"),
        "wes-13: agent missing email/website is excluded, not crashed on");
      assertTrue(!body.email_domain_mismatch.some((a: any) => a.agent_id === "agent-umbrella"),
        "wes-14: umbrella agent is excluded from email_domain_mismatch even though it would otherwise match");

      // ── heuristic 2: duplicate opening hours ────────────────────────────
      const boilerplateGroup = body.duplicate_opening_hours.find((g: any) => g.value === BOILERPLATE_HOURS);
      assertTrue(!!boilerplateGroup, "wes-15: the 3+-shared boilerplate value is present as a group");
      assertEq(boilerplateGroup.agent_ids.sort(), ["agent-freemail", "agent-mismatch", "agent-samedomain"],
        "wes-16: boilerplate group lists exactly the 3 non-umbrella agents sharing it (umbrella excluded)");

      const pairGroup = body.duplicate_opening_hours.find((g: any) => g.value === OTHER_HOURS_B);
      assertTrue(!pairGroup, "wes-17: a value shared by only 2 agents is NOT flagged");

      const uniqueGroup = body.duplicate_opening_hours.find((g: any) =>
        g.agent_ids && g.agent_ids.includes("agent-hours-unique"));
      assertTrue(!uniqueGroup, "wes-18: a fully unique opening-hours value never appears as a group");

      // ── skipped_heuristics ───────────────────────────────────────────────
      assertTrue(Array.isArray(body.skipped_heuristics) && body.skipped_heuristics.length === 2,
        "wes-19: skipped_heuristics lists exactly 2 entries");
      assertTrue(body.skipped_heuristics.some((s: string) => s.startsWith("postalCode_vs_address:")),
        "wes-20: postalCode_vs_address is named as skipped with a reason");
      assertTrue(body.skipped_heuristics.some((s: string) => s.startsWith("retningsnummer_vs_fylke:")),
        "wes-21: retningsnummer_vs_fylke is named as skipped with a reason");

      // ── ZERO WRITES: full DB state unchanged after the call ─────────────
      const snapshotAfter = JSON.stringify({
        agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
        knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
      });
      assertEq(snapshotAfter, snapshotBefore, "wes-22: DB row state is byte-identical before/after — the endpoint made zero writes");

      // A second consecutive call must be fully idempotent (still zero
      // writes, same result) — proves there's no hidden first-call-only
      // side effect (e.g. a parking-style stamp).
      const result2 = await get();
      assertEq(JSON.stringify(result2.body), JSON.stringify(body), "wes-23: a second call returns an identical result (fully idempotent, no state accrual)");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminWrongEntityRetroSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

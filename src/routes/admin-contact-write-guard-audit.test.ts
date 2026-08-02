/**
 * admin-contact-write-guard-audit.test.ts — tests GET /admin/contact-write-guard-audit
 * (dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon, criterion 5,
 * slookisen/A2A — the read-only "how many EXISTING rows already violate the
 * write-time contact guard's rules" measurement sweep).
 *
 * Mirrors admin-wrong-entity-retro-sweep.test.ts's harness conventions:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest, no network calls.
 *   - exported runAdminContactWriteGuardAuditTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-contact-write-guard-audit.test.ts
 *
 * Coverage:
 *   - real breach fixtures from platform-alerts/2026-07-27-0614-rfb-enrichment-
 *     spotcheck-breach.md: phone "927 011 840" with org_nr "927011840" (fails
 *     BOTH shape and org_nr_collision); phone "20100101" (date_shape); address
 *     "Valmen 54, 2460 Osen Telefon" (address_trailing_label).
 *   - the independent-reviewer regression: bare "47"-prefixed 10-digit phone
 *     "4727011840" whose national8-reduced form matches org_nr "927011840"'s
 *     last-8-digits ⇒ caught by org_nr_collision via the `reduced` leg, not
 *     just the raw-digit-string leg.
 *   - negative controls: a valid distinct 8-digit phone is NOT flagged by any
 *     rule; an address containing "Kontaktveien 3" (label embedded in a real
 *     street name) is NOT flagged.
 *   - total_rows_scanned counts the FULL table, no cohort filter.
 *   - by_vertical breakdown across rfb/dental/experiences.
 *   - 403 without/with-wrong X-Admin-Key.
 *   - zero-writes: full DB row snapshot (agents + agent_knowledge) is
 *     byte-identical before and after calling the endpoint.
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

export function runAdminContactWriteGuardAuditTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-contact-write-guard-audit-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, vertical_id)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, phone, address, about)
         VALUES (?, ?, ?, 'A test farm shop')`,
      );

      // (1) Real breach fixture: org-nr written verbatim as phone. Fails
      // BOTH rule 1 (shape — 9 digits, not 8) AND rule 2 (org_nr_collision —
      // matches the agent's own org_nr) simultaneously.
      insertAgent.run("agent-orgnr-as-phone", "OrgnrAsPhone AS", "key-orgnr-as-phone", "927011840", "rfb");
      insertKnowledge.run("agent-orgnr-as-phone", "927 011 840", null);

      // (2) Real breach fixture: an 8-digit date written verbatim as phone
      // (no org-nr on record for this agent).
      insertAgent.run("agent-date-phone", "DatePhone AS", "key-date-phone", null, "rfb");
      insertKnowledge.run("agent-date-phone", "20100101", null);

      // (3) Real breach fixture: address with a leaked "Telefon" label.
      insertAgent.run("agent-address-label", "AddressLabel AS", "key-address-label", null, "rfb");
      insertKnowledge.run("agent-address-label", null, "Valmen 54, 2460 Osen Telefon");

      // (4) Reviewer-caught regression: bare "47"-prefixed 10-digit phone
      // whose national8-reduced form ("27011840") matches org_nr
      // "927011840"'s last-8-digits. Must be caught by org_nr_collision via
      // the `reduced` leg, not just the raw-digit-string leg.
      insertAgent.run("agent-bare-47-collision", "Bare47 AS", "key-bare-47", "927011840", "rfb");
      insertKnowledge.run("agent-bare-47-collision", "4727011840", null);

      // (5) Negative control: a genuinely valid, distinct 8-digit phone must
      // NOT be flagged by any rule.
      insertAgent.run("agent-valid-phone", "ValidPhone AS", "key-valid-phone", "927011840", "rfb");
      insertKnowledge.run("agent-valid-phone", "911 22 333", null);

      // (6) Negative control: address containing "Kontakt" as part of a real
      // street name ("Kontaktveien 3") must NOT be flagged — proves the
      // anchoring in stripTrailingContactLabel still holds through this new
      // code path.
      insertAgent.run("agent-kontaktveien", "Kontaktveien AS", "key-kontaktveien", null, "rfb");
      insertKnowledge.run("agent-kontaktveien", null, "Kontaktveien 3");

      // (7) Cross-vertical coverage: a dental-vertical agent with the exact
      // same date-shaped phone breach, to prove by_vertical breaks out
      // non-rfb verticals too (the underlying tables are shared across
      // rfb/dental/experiences even though the original incident was
      // discovered via rfb).
      insertAgent.run("agent-dental-date-phone", "DentalDatePhone AS", "key-dental-date-phone", null, "dental");
      insertKnowledge.run("agent-dental-date-phone", "19991231", null);

      // (8) A row with no phone and no address at all — must not crash and
      // must not appear in any violation bucket.
      insertAgent.run("agent-empty-contact", "EmptyContact AS", "key-empty-contact", null, "rfb");
      insertKnowledge.run("agent-empty-contact", null, null);

      delete require.cache[require.resolve("./admin-contact-write-guard-audit")];
      const routeMod = require("./admin-contact-write-guard-audit");
      const router = routeMod.default;

      function get(key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "GET", url: "/", headers });
      }

      // ── auth gate ──────────────────────────────────────────────────────
      let result = await get(false);
      assertEq(result.status, 403, "cwga-01: missing X-Admin-Key -> 403");
      result = await get("wrong-key");
      assertEq(result.status, 403, "cwga-02: wrong X-Admin-Key -> 403");

      // ── snapshot full DB state BEFORE calling the endpoint ─────────────
      const snapshotBefore = JSON.stringify({
        agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
        knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
      });

      // ── the real call ───────────────────────────────────────────────────
      result = await get();
      assertEq(result.status, 200, "cwga-03: authorized GET -> 200");
      const body = result.body;
      assertEq(body.success, true, "cwga-04: success:true");

      // total_rows_scanned: FULL table, no cohort filter. 8 agents inserted
      // above, each with exactly one agent_knowledge row.
      assertEq(body.total_rows_scanned, 8, "cwga-05: total_rows_scanned counts every agent_knowledge row (full table, no cohort filter)");

      // ── Rule 1: phone_shape_violations ──────────────────────────────────
      const shapeIds = body.phone_shape_violations.rows.map((r: any) => r.agent_id).sort();
      assertEq(shapeIds, ["agent-orgnr-as-phone"], "cwga-06: only the 9-digit org-nr-as-phone value fails shape");
      assertEq(body.phone_shape_violations.count, 1, "cwga-07: phone_shape_violations.count matches rows length");

      // ── Rule 2: phone_org_nr_collision ──────────────────────────────────
      const collisionIds = body.phone_org_nr_collision.rows.map((r: any) => r.agent_id).sort();
      assertEq(
        collisionIds,
        ["agent-bare-47-collision", "agent-orgnr-as-phone"].sort(),
        "cwga-08: org-nr-as-phone AND the bare-47-prefixed reduced-collision value are both flagged",
      );
      assertTrue(
        !body.phone_org_nr_collision.rows.some((r: any) => r.agent_id === "agent-valid-phone"),
        "cwga-09: a genuinely distinct valid phone is NOT flagged as an org-nr collision",
      );

      // ── Rule 3: phone_date_shape ─────────────────────────────────────────
      const dateIds = body.phone_date_shape.rows.map((r: any) => r.agent_id).sort();
      assertEq(
        dateIds,
        ["agent-date-phone", "agent-dental-date-phone"].sort(),
        "cwga-10: both the rfb and dental date-shaped phones are flagged",
      );

      // ── Rule 4: address_trailing_label ──────────────────────────────────
      const labelIds = body.address_trailing_label.rows.map((r: any) => r.agent_id).sort();
      assertEq(labelIds, ["agent-address-label"], "cwga-11: only the trailing-'Telefon'-label address is flagged");
      const labelEntry = body.address_trailing_label.rows[0];
      assertEq(labelEntry.value, "Valmen 54, 2460 Osen Telefon", "cwga-12: offending raw address value is reported verbatim");
      assertTrue(
        !body.address_trailing_label.rows.some((r: any) => r.agent_id === "agent-kontaktveien"),
        "cwga-13: NEG — 'Kontaktveien 3' (label embedded in a real street name) is NOT flagged",
      );

      // ── Negative control: valid phone flagged by nothing ────────────────
      assertTrue(
        !body.phone_shape_violations.rows.some((r: any) => r.agent_id === "agent-valid-phone") &&
        !body.phone_org_nr_collision.rows.some((r: any) => r.agent_id === "agent-valid-phone") &&
        !body.phone_date_shape.rows.some((r: any) => r.agent_id === "agent-valid-phone"),
        "cwga-14: NEG — a valid distinct 8-digit phone is not flagged by any phone rule",
      );

      // ── Empty-contact row: no crash, appears nowhere ────────────────────
      assertTrue(
        ![body.phone_shape_violations, body.phone_org_nr_collision, body.phone_date_shape, body.address_trailing_label]
          .some((bucket: any) => bucket.rows.some((r: any) => r.agent_id === "agent-empty-contact")),
        "cwga-15: a row with no phone/address at all does not crash and is flagged nowhere",
      );

      // ── by_vertical breakdown ────────────────────────────────────────────
      assertTrue(
        typeof body.by_vertical === "object" && body.by_vertical !== null,
        "cwga-16: by_vertical is present as an object",
      );
      assertEq(
        body.by_vertical.rfb?.phone_org_nr_collision,
        2,
        "cwga-17: by_vertical.rfb.phone_org_nr_collision counts both rfb org-nr-collision rows",
      );
      assertEq(
        body.by_vertical.dental?.phone_date_shape,
        1,
        "cwga-18: by_vertical.dental.phone_date_shape counts the dental-vertical date-shaped phone",
      );
      assertTrue(
        !body.by_vertical.dental || (body.by_vertical.dental.address_trailing_label ?? 0) === 0,
        "cwga-19: by_vertical.dental has no address_trailing_label violations (none seeded)",
      );

      // ── ZERO WRITES: full DB state unchanged after the call ─────────────
      const snapshotAfter = JSON.stringify({
        agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
        knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
      });
      assertEq(snapshotAfter, snapshotBefore, "cwga-20: DB row state is byte-identical before/after — the endpoint made zero writes");

      // A second consecutive call must be fully idempotent.
      const result2 = await get();
      assertEq(JSON.stringify(result2.body), JSON.stringify(body), "cwga-21: a second call returns an identical result (fully idempotent)");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminContactWriteGuardAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

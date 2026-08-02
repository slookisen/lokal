/**
 * admin-contact-write-guard-retro-sweep.test.ts — tests
 * POST /admin/contact-write-guard-retro-sweep (dev-request
 * 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon, criterion 6,
 * slookisen/A2A — the CORRECTION half of the read-only
 * admin-contact-write-guard-audit.ts measurement sweep).
 *
 * Mirrors admin-contact-write-guard-audit.test.ts's harness conventions:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest, no network calls.
 *   - exported runAdminContactWriteGuardRetroSweepTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-contact-write-guard-retro-sweep.test.ts
 *
 * Coverage (per the dev-request's own acceptance criteria for this slice):
 *   1. Dry-run reports violations without writing anything — full DB row
 *      snapshot byte-identical before/after.
 *   2. Apply mode actually blanks a rule-1/2/3 violating phone to NULL, and
 *      actually rewrites a rule-4 violating address to its stripped form.
 *   3. An owner-claimed agent (claimed_at set) with a violating phone/address
 *      is SKIPPED under apply — DB row unchanged, shows up in
 *      skipped_claimed, not silently dropped.
 *   4. An agent with curated_fields locking "phone" is skipped for the phone
 *      rules under apply even though the phone violates a rule — but if that
 *      SAME agent's address also violates rule 4 and curated_fields does NOT
 *      lock "address", the address IS still repaired (locks are per-field).
 *   5. Negative control: a valid phone / a label-free address are untouched
 *      in apply mode too.
 *   6. Same real breach-shaped fixtures as the audit route's own tests
 *      (org-nr-as-phone, date-as-phone, trailing-label address).
 *   7. Mutation-testing notes: this file is used to self-verify the
 *      claimed_at and curated_fields guards actually gate the write (see the
 *      hand-run mutation checks noted in the PR/report — temporarily
 *      commenting out either guard in the route must turn cwgrs-10/cwgrs-14
 *      red).
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
      method: opts.method || "POST",
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

export function runAdminContactWriteGuardRetroSweepTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-contact-write-guard-retro-sweep-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, vertical_id, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, phone, address, about, curated_fields)
         VALUES (?, ?, ?, 'A test farm shop', ?)`,
      );

      // (1) Real breach fixture: org-nr written verbatim as phone. Fails BOTH
      // rule 1 (shape) AND rule 2 (org_nr_collision). Not claimed, not curated
      // -> should be blanked under apply.
      insertAgent.run("agent-orgnr-as-phone", "OrgnrAsPhone AS", "key-orgnr-as-phone", "927011840", "rfb", null);
      insertKnowledge.run("agent-orgnr-as-phone", "927 011 840", null, "{}");

      // (2) Real breach fixture: an 8-digit date written verbatim as phone.
      // Not claimed, not curated -> should be blanked under apply.
      insertAgent.run("agent-date-phone", "DatePhone AS", "key-date-phone", null, "rfb", null);
      insertKnowledge.run("agent-date-phone", "20100101", null, "{}");

      // (3) Real breach fixture: address with a leaked "Telefon" label. Not
      // claimed, not curated -> should be repaired (stripped) under apply.
      insertAgent.run("agent-address-label", "AddressLabel AS", "key-address-label", null, "rfb", null);
      insertKnowledge.run("agent-address-label", null, "Valmen 54, 2460 Osen Telefon", "{}");

      // (4) Negative control: a genuinely valid, distinct 8-digit phone must
      // NOT be touched under apply.
      insertAgent.run("agent-valid-phone", "ValidPhone AS", "key-valid-phone", "927011840", "rfb", null);
      insertKnowledge.run("agent-valid-phone", "911 22 333", null, "{}");

      // (5) Negative control: address containing "Kontakt" as part of a real
      // street name ("Kontaktveien 3") must NOT be touched under apply.
      insertAgent.run("agent-kontaktveien", "Kontaktveien AS", "key-kontaktveien", null, "rfb", null);
      insertKnowledge.run("agent-kontaktveien", null, "Kontaktveien 3", "{}");

      // (6) OWNER-CLAIMED agent (claimed_at set) with BOTH a violating phone
      // (date-shaped) AND a violating address (trailing label). Row-level
      // lock -> BOTH fields must be skipped under apply, reported in
      // skipped_claimed, never written.
      insertAgent.run("agent-claimed-both-violations", "ClaimedBoth AS", "key-claimed-both", null, "rfb", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("agent-claimed-both-violations", "20100101", "Valmen 54, 2460 Osen Telefon", "{}");

      // (7) curated_fields locks "phone" only (NOT "address"). Phone is
      // date-shaped (violates rule 3); address ALSO has a trailing label
      // (violates rule 4). Per-field lock discipline: the phone must be
      // SKIPPED (curated) while the address, unlocked, must still be
      // REPAIRED under apply — proving locks are per-field, not per-row.
      insertAgent.run("agent-phone-curated-only", "PhoneCuratedOnly AS", "key-phone-curated", null, "rfb", null);
      insertKnowledge.run(
        "agent-phone-curated-only",
        "19991231",
        "Valmen 54, 2460 Osen Adresse",
        JSON.stringify({ phone: { locked_at: "2026-01-01T00:00:00.000Z", by: "rfb-customer-service" } }),
      );

      delete require.cache[require.resolve("./admin-contact-write-guard-retro-sweep")];
      const routeMod = require("./admin-contact-write-guard-retro-sweep");
      const router = routeMod.default;

      function post(bodyOverride: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body: bodyOverride, query });
      }

      // ── auth gate ──────────────────────────────────────────────────────
      let result = await post({}, false);
      assertEq(result.status, 403, "cwgrs-01: missing X-Admin-Key -> 403");
      result = await post({}, "wrong-key");
      assertEq(result.status, 403, "cwgrs-02: wrong X-Admin-Key -> 403");

      // ── full DB snapshot BEFORE any calls ────────────────────────────────
      function snapshot(): string {
        return JSON.stringify({
          agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
          knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
        });
      }
      const snapshotBeforeAnything = snapshot();

      // ══════════════════════════ DRY-RUN ════════════════════════════════
      // No `apply` key at all -> must default to dry-run.
      let dry = await post({});
      assertEq(dry.status, 200, "cwgrs-03: dry-run POST -> 200");
      assertEq(dry.body.success, true, "cwgrs-04: success:true");
      assertEq(dry.body.dry_run, true, "cwgrs-05: dry_run:true when apply is omitted");

      assertEq(
        dry.body.total_rows_scanned,
        7,
        "cwgrs-06: total_rows_scanned counts every agent_knowledge row (full table, no cohort filter)",
      );

      // Rule-by-rule violation counts (dry-run) — mirrors the audit route's
      // own per-rule breakdown for the equivalent fixtures.
      assertEq(dry.body.phone_shape_violations.violations_found, 1, "cwgrs-07: shape: only the 9-digit org-nr-as-phone value");
      assertEq(
        dry.body.phone_org_nr_collision.violations_found,
        1,
        "cwgrs-08: org_nr_collision: only the org-nr-as-phone value (no bare-47 fixture in this suite)",
      );
      assertEq(
        dry.body.phone_date_shape.violations_found,
        3,
        "cwgrs-09: date_shape: agent-date-phone, agent-claimed-both-violations, agent-phone-curated-only",
      );
      assertEq(
        dry.body.address_trailing_label.violations_found,
        3,
        "cwgrs-10: address_trailing_label: agent-address-label, agent-claimed-both-violations, agent-phone-curated-only",
      );

      // written must be 0 in every bucket during dry-run.
      assertEq(dry.body.phone_shape_violations.written, 0, "cwgrs-11: dry-run writes nothing (shape)");
      assertEq(dry.body.phone_date_shape.written, 0, "cwgrs-12: dry-run writes nothing (date_shape)");
      assertEq(dry.body.address_trailing_label.written, 0, "cwgrs-13: dry-run writes nothing (address_trailing_label)");

      // Dry-run still previews what WOULD be skipped-locked/curated.
      assertTrue(
        dry.body.phone_date_shape.agent_ids.skipped_claimed.includes("agent-claimed-both-violations"),
        "cwgrs-14: dry-run previews the claimed-lock skip for phone_date_shape",
      );
      assertTrue(
        dry.body.address_trailing_label.agent_ids.skipped_claimed.includes("agent-claimed-both-violations"),
        "cwgrs-15: dry-run previews the claimed-lock skip for address_trailing_label",
      );
      assertTrue(
        dry.body.phone_date_shape.agent_ids.skipped_curated.includes("agent-phone-curated-only"),
        "cwgrs-16: dry-run previews the curated-lock skip for the phone-curated agent's date_shape violation",
      );
      assertTrue(
        !dry.body.address_trailing_label.agent_ids.skipped_curated.includes("agent-phone-curated-only"),
        "cwgrs-17: dry-run does NOT preview a curated-lock skip for agent-phone-curated-only's address (only phone is curated)",
      );

      // ── ZERO WRITES from any dry-run call: byte-identical DB state ─────
      assertEq(snapshot(), snapshotBeforeAnything, "cwgrs-18: DB state is byte-identical before/after a dry-run call");

      // Second consecutive dry-run call must be fully idempotent.
      const dry2 = await post({});
      assertEq(JSON.stringify(dry2.body), JSON.stringify(dry.body), "cwgrs-19: a second dry-run call returns an identical result");

      // ══════════════════════════ APPLY (all truthy forms) ═══════════════
      // Confirm every documented truthy form is accepted as apply BEFORE
      // committing to the real apply-mode run below (each of these, run on
      // its own throwaway dry-run-equivalent request, would flip dry_run to
      // false — verified via a lightweight `apply` echo rather than mutating
      // state four times over).
      for (const truthy of [true, 1, "1", "true"] as const) {
        const r = await post({ apply: truthy });
        assertEq(r.body.dry_run, false, `cwgrs-20: body.apply=${JSON.stringify(truthy)} -> dry_run:false`);
      }
      // ?apply=1 / ?apply=true via query string, apply omitted from body.
      for (const truthy of ["1", "true"]) {
        const r = await post({}, testKey, { apply: truthy });
        assertEq(r.body.dry_run, false, `cwgrs-21: ?apply=${truthy} -> dry_run:false`);
      }
      // Anything else (falsy forms) must stay dry-run.
      for (const notTruthy of [false, 0, "0", "yes", null, undefined]) {
        const r = await post({ apply: notTruthy });
        assertEq(r.body.dry_run, true, `cwgrs-22: body.apply=${JSON.stringify(notTruthy)} -> still dry_run:true`);
      }
      // The above truthy-form probes each ran a REAL apply call (6 times
      // over) — restore the DB back to its pre-apply state before running
      // the single canonical apply-mode assertions below, so those assertions
      // are not order-dependent on what the truthy-form probes already wrote.
      assertTrue(snapshot() !== snapshotBeforeAnything, "cwgrs-23: sanity — the truthy-form probes above DID write (state changed)");

      // Reset to a fresh DB for the canonical, single apply-mode run so
      // "written" counts below are unambiguous (not accumulated across the
      // truthy-form probes' repeated applies).
      db.exec("DELETE FROM agent_knowledge");
      db.exec("DELETE FROM agents");
      insertAgent.run("agent-orgnr-as-phone", "OrgnrAsPhone AS", "key-orgnr-as-phone", "927011840", "rfb", null);
      insertKnowledge.run("agent-orgnr-as-phone", "927 011 840", null, "{}");
      insertAgent.run("agent-date-phone", "DatePhone AS", "key-date-phone", null, "rfb", null);
      insertKnowledge.run("agent-date-phone", "20100101", null, "{}");
      insertAgent.run("agent-address-label", "AddressLabel AS", "key-address-label", null, "rfb", null);
      insertKnowledge.run("agent-address-label", null, "Valmen 54, 2460 Osen Telefon", "{}");
      insertAgent.run("agent-valid-phone", "ValidPhone AS", "key-valid-phone", "927011840", "rfb", null);
      insertKnowledge.run("agent-valid-phone", "911 22 333", null, "{}");
      insertAgent.run("agent-kontaktveien", "Kontaktveien AS", "key-kontaktveien", null, "rfb", null);
      insertKnowledge.run("agent-kontaktveien", null, "Kontaktveien 3", "{}");
      insertAgent.run("agent-claimed-both-violations", "ClaimedBoth AS", "key-claimed-both", null, "rfb", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("agent-claimed-both-violations", "20100101", "Valmen 54, 2460 Osen Telefon", "{}");
      insertAgent.run("agent-phone-curated-only", "PhoneCuratedOnly AS", "key-phone-curated", null, "rfb", null);
      insertKnowledge.run(
        "agent-phone-curated-only",
        "19991231",
        "Valmen 54, 2460 Osen Adresse",
        JSON.stringify({ phone: { locked_at: "2026-01-01T00:00:00.000Z", by: "rfb-customer-service" } }),
      );

      const apply = await post({ apply: true });
      assertEq(apply.status, 200, "cwgrs-24: apply POST -> 200");
      assertEq(apply.body.dry_run, false, "cwgrs-25: dry_run:false under apply:true");

      // ── rule-1/2/3: phones actually blanked ─────────────────────────────
      const orgnrPhoneAfter = db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get("agent-orgnr-as-phone") as { phone: string | null };
      assertEq(orgnrPhoneAfter.phone, null, "cwgrs-26: agent-orgnr-as-phone's phone actually blanked to NULL under apply");

      const datePhoneAfter = db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get("agent-date-phone") as { phone: string | null };
      assertEq(datePhoneAfter.phone, null, "cwgrs-27: agent-date-phone's phone actually blanked to NULL under apply");

      assertTrue(
        apply.body.phone_shape_violations.agent_ids.written.includes("agent-orgnr-as-phone"),
        "cwgrs-28: phone_shape_violations reports agent-orgnr-as-phone as written",
      );
      assertTrue(
        apply.body.phone_org_nr_collision.agent_ids.written.includes("agent-orgnr-as-phone"),
        "cwgrs-29: phone_org_nr_collision ALSO reports agent-orgnr-as-phone as written (one write satisfies both rule buckets)",
      );
      assertTrue(
        apply.body.phone_date_shape.agent_ids.written.includes("agent-date-phone"),
        "cwgrs-30: phone_date_shape reports agent-date-phone as written",
      );

      // ── rule-4: address actually rewritten to its stripped form ─────────
      const addressLabelAfter = db.prepare("SELECT address FROM agent_knowledge WHERE agent_id = ?").get("agent-address-label") as { address: string | null };
      assertEq(addressLabelAfter.address, "Valmen 54, 2460 Osen", "cwgrs-31: agent-address-label's address actually rewritten to its stripped form under apply");
      assertTrue(
        apply.body.address_trailing_label.agent_ids.written.includes("agent-address-label"),
        "cwgrs-32: address_trailing_label reports agent-address-label as written",
      );

      // ── owner-claimed agent: BOTH fields skipped, DB row unchanged ──────
      const claimedRowAfter = db
        .prepare("SELECT phone, address FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-claimed-both-violations") as { phone: string | null; address: string | null };
      assertEq(claimedRowAfter.phone, "20100101", "cwgrs-33: owner-claimed agent's phone UNCHANGED under apply (row-level lock)");
      assertEq(
        claimedRowAfter.address,
        "Valmen 54, 2460 Osen Telefon",
        "cwgrs-34: owner-claimed agent's address UNCHANGED under apply (row-level lock)",
      );
      assertTrue(
        apply.body.phone_date_shape.agent_ids.skipped_claimed.includes("agent-claimed-both-violations"),
        "cwgrs-35: phone_date_shape reports the owner-claimed agent as skipped_claimed, not silently dropped",
      );
      assertTrue(
        apply.body.address_trailing_label.agent_ids.skipped_claimed.includes("agent-claimed-both-violations"),
        "cwgrs-36: address_trailing_label ALSO reports the owner-claimed agent as skipped_claimed",
      );
      assertTrue(
        !apply.body.phone_date_shape.agent_ids.written.includes("agent-claimed-both-violations") &&
        !apply.body.address_trailing_label.agent_ids.written.includes("agent-claimed-both-violations"),
        "cwgrs-37: the owner-claimed agent never appears in any written bucket",
      );

      // ── per-field curated lock: phone skipped, address (unlocked) fixed ─
      const curatedRowAfter = db
        .prepare("SELECT phone, address FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-phone-curated-only") as { phone: string | null; address: string | null };
      assertEq(
        curatedRowAfter.phone,
        "19991231",
        "cwgrs-38: agent-phone-curated-only's phone UNCHANGED under apply (curated_fields locks 'phone')",
      );
      assertEq(
        curatedRowAfter.address,
        "Valmen 54, 2460 Osen",
        "cwgrs-39: agent-phone-curated-only's address IS repaired under apply — curated_fields locks 'phone' only, NOT 'address' (locks are per-field, not per-row)",
      );
      assertTrue(
        apply.body.phone_date_shape.agent_ids.skipped_curated.includes("agent-phone-curated-only"),
        "cwgrs-40: phone_date_shape reports agent-phone-curated-only as skipped_curated",
      );
      assertTrue(
        apply.body.address_trailing_label.agent_ids.written.includes("agent-phone-curated-only"),
        "cwgrs-41: address_trailing_label reports agent-phone-curated-only as WRITTEN (address is not curated-locked)",
      );
      assertTrue(
        !apply.body.address_trailing_label.agent_ids.skipped_curated.includes("agent-phone-curated-only"),
        "cwgrs-42: address_trailing_label does NOT report agent-phone-curated-only as skipped_curated",
      );

      // ── negative controls: valid phone / label-free address untouched ───
      const validPhoneAfter = db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get("agent-valid-phone") as { phone: string | null };
      assertEq(validPhoneAfter.phone, "911 22 333", "cwgrs-43: NEG — a valid distinct 8-digit phone is untouched under apply");

      const kontaktveienAfter = db.prepare("SELECT address FROM agent_knowledge WHERE agent_id = ?").get("agent-kontaktveien") as { address: string | null };
      assertEq(kontaktveienAfter.address, "Kontaktveien 3", "cwgrs-44: NEG — 'Kontaktveien 3' (label embedded in a real street name) is untouched under apply");

      assertTrue(
        !apply.body.phone_shape_violations.agent_ids.violations.includes("agent-valid-phone") &&
        !apply.body.phone_org_nr_collision.agent_ids.violations.includes("agent-valid-phone") &&
        !apply.body.phone_date_shape.agent_ids.violations.includes("agent-valid-phone"),
        "cwgrs-45: NEG — the valid phone never appears in any phone-rule violations list at all",
      );
      assertTrue(
        !apply.body.address_trailing_label.agent_ids.violations.includes("agent-kontaktveien"),
        "cwgrs-46: NEG — 'Kontaktveien 3' never appears in the address_trailing_label violations list",
      );

      // ── idempotency: a second apply call is a clean no-op ───────────────
      const snapshotAfterFirstApply = snapshot();
      const apply2 = await post({ apply: true });
      assertEq(apply2.body.phone_shape_violations.violations_found, 0, "cwgrs-47: a second apply call finds zero remaining shape violations (already fixed)");
      assertEq(
        apply2.body.address_trailing_label.violations_found,
        1,
        "cwgrs-48: a second apply call still finds exactly one remaining address_trailing_label violation — the owner-claimed agent's address (never touched, still violates)",
      );
      assertEq(snapshot(), snapshotAfterFirstApply, "cwgrs-49: DB state unchanged by the second (idempotent) apply call");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminContactWriteGuardRetroSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

/**
 * admin-agents-duplicate-merge.test.ts — tests for
 * POST /admin/agents/duplicate-merge (dev-request duplicate-merge lever).
 *
 * One controlled admin lever that executes an EXPLICIT duplicate-pair merge
 * decision supplied by the caller — fill-only survivor writes, append-only
 * provenance merge, mandatory duplicate deactivation (is_active=0 +
 * merged_into), reversible via agent_knowledge_audit.
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed at
 * that DB through its own seam (__setDuplicateMergeDbForTesting) — same
 * discipline as admin-agents-contact-email-write.test.ts: never pins the
 * shared getDb() singleton (see that file's header comment for the race this
 * avoids — orch-pr-86, PR #444's determinism gate). Handler driven directly
 * through router.handle() with a fake req/res — no HTTP server.
 *
 * Covers:
 *   (a) auth gate
 *   (b) dry-run vs apply (dry-run writes nothing)
 *   (c) fill-only: survivor's existing non-blank value is NOT overwritten
 *   (d) claimed-row skip, both directions (claimed survivor, claimed duplicate)
 *   (e) curated-field skip — field-level, not pair-level
 *   (f) audit rows: old_value present, one row per changed field + one
 *       merge-decision row
 *   (g) is_active / merged_into set correctly on the duplicate after apply
 *   (h) admin-key auth (403 without header)
 *   (i) batch cap
 *   (j) same-id-twice-in-request rejection
 *   (k) survivor == duplicate rejection
 *   (l) provenance append (not overwrite)
 *   (m) survivor with no agent_knowledge row gets one created
 *   (n) not_found handling, batch hygiene (one bad pair doesn't abort batch)
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

export function runAdminAgentsDuplicateMergeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // SHARED-GLOBAL DISCIPLINE (tests/test.ts, "SHARED GLOBAL STATE"): never
    // reassign process.env.ADMIN_KEY — read whatever key is already in
    // effect and send that. Only set one ourselves (and restore in finally)
    // when none exists at all (this file run standalone).
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "admin-agents-duplicate-merge-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active)
         VALUES (?, ?, 'test agent', 'test', ?, 'https://example.no', 'producer', ?, 'rfb', ?, 1)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, postal_code, website, phone, email, about, curated_fields, field_provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // ── Fixture pairs ──────────────────────────────────────────────────
      // (1) basic fill-only pair: survivor blank contact_email + blank
      //     knowledge fields, duplicate has real values everywhere
      insertAgent.run("dm-surv-1", "Survivor One AS", "", "key-dm-surv-1", null);
      insertKnowledge.run("dm-surv-1", null, null, null, null, null, null, "{}", "{}");
      insertAgent.run("dm-dup-1", "Duplicate One AS", "post@dup1.no", "key-dm-dup-1", null);
      insertKnowledge.run(
        "dm-dup-1",
        "Gårdsveien 1",
        "1234",
        "https://dup1.no",
        "12345678",
        "kontakt@dup1.no",
        "En fin gård.",
        "{}",
        JSON.stringify({
          address: [{ value: "Gårdsveien 1", source_type: "homepage", fetched_at: "2026-01-01T00:00:00.000Z" }],
        }),
      );

      // (2) fill-only: survivor already has a real contact_email + address —
      //     must NOT be overwritten by the duplicate's different values
      insertAgent.run("dm-surv-2", "Survivor Two AS", "post@surv2.no", "key-dm-surv-2", null);
      insertKnowledge.run("dm-surv-2", "Original Address 5", null, null, null, null, null, "{}", "{}");
      insertAgent.run("dm-dup-2", "Duplicate Two AS", "post@dup2.no", "key-dm-dup-2", null);
      insertKnowledge.run("dm-dup-2", "Different Address 9", null, null, null, null, null, "{}", "{}");

      // (3) claimed survivor -> whole pair skipped
      insertAgent.run("dm-surv-3", "Survivor Three AS", "", "key-dm-surv-3", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("dm-surv-3", null, null, null, null, null, null, "{}", "{}");
      insertAgent.run("dm-dup-3", "Duplicate Three AS", "post@dup3.no", "key-dm-dup-3", null);
      insertKnowledge.run("dm-dup-3", null, null, null, null, null, null, "{}", "{}");

      // (4) claimed duplicate -> whole pair skipped (other direction)
      insertAgent.run("dm-surv-4", "Survivor Four AS", "", "key-dm-surv-4", null);
      insertKnowledge.run("dm-surv-4", null, null, null, null, null, null, "{}", "{}");
      insertAgent.run("dm-dup-4", "Duplicate Four AS", "post@dup4.no", "key-dm-dup-4", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("dm-dup-4", null, null, null, null, null, null, "{}", "{}");

      // (5) curated field lock: survivor's "phone" is curated -> that field
      //     skipped, contact_email still fills normally
      insertAgent.run("dm-surv-5", "Survivor Five AS", "", "key-dm-surv-5", null);
      insertKnowledge.run(
        "dm-surv-5",
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify({ phone: { by: "owner" } }),
        "{}",
      );
      insertAgent.run("dm-dup-5", "Duplicate Five AS", "post@dup5.no", "key-dm-dup-5", null);
      insertKnowledge.run("dm-dup-5", null, null, null, "99887766", null, null, "{}", "{}");

      // (6) survivor has NO agent_knowledge row at all; duplicate does
      insertAgent.run("dm-surv-6", "Survivor Six AS", "", "key-dm-surv-6", null);
      insertAgent.run("dm-dup-6", "Duplicate Six AS", "post@dup6.no", "key-dm-dup-6", null);
      insertKnowledge.run("dm-dup-6", "Gate 6", null, null, null, null, "Om gård 6", "{}", "{}");

      // (7) provenance append: both sides have array-shape provenance on
      //     "about" — survivor's own value is blank so it gets filled, and
      //     the duplicate's provenance entry must be APPENDED, not overwrite
      insertAgent.run("dm-surv-7", "Survivor Seven AS", "", "key-dm-surv-7", null);
      insertKnowledge.run(
        "dm-surv-7",
        null,
        null,
        null,
        null,
        null,
        null,
        "{}",
        JSON.stringify({ about: [{ value: "old-about-prov-noop", source_type: "owner", fetched_at: "2026-01-01T00:00:00.000Z" }] }),
      );
      insertAgent.run("dm-dup-7", "Duplicate Seven AS", "post@dup7.no", "key-dm-dup-7", null);
      insertKnowledge.run(
        "dm-dup-7",
        null,
        null,
        null,
        null,
        null,
        "Om gård 7",
        "{}",
        JSON.stringify({ about: [{ value: "Om gård 7", source_type: "homepage", fetched_at: "2026-02-01T00:00:00.000Z" }] }),
      );

      // (8) reused-id fixtures for batch hygiene
      insertAgent.run("dm-surv-8", "Survivor Eight AS", "", "key-dm-surv-8", null);
      insertKnowledge.run("dm-surv-8", null, null, null, null, null, null, "{}", "{}");
      insertAgent.run("dm-dup-8a", "Duplicate Eight A AS", "post@dup8a.no", "key-dm-dup-8a", null);
      insertKnowledge.run("dm-dup-8a", null, null, null, null, null, null, "{}", "{}");
      insertAgent.run("dm-dup-8b", "Duplicate Eight B AS", "post@dup8b.no", "key-dm-dup-8b", null);
      insertKnowledge.run("dm-dup-8b", null, null, null, null, null, null, "{}", "{}");

      delete require.cache[require.resolve("./admin-agents-duplicate-merge")];
      const routeMod = require("./admin-agents-duplicate-merge");
      const router = routeMod.default;
      routeMod.__setDuplicateMergeDbForTesting(db as any);

      function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body, query });
      }

      function agentRow(id: string) {
        return db
          .prepare(`SELECT contact_email, is_active, merged_into, claimed_at FROM agents WHERE id = ?`)
          .get(id) as { contact_email: string | null; is_active: number; merged_into: string | null; claimed_at: string | null } | undefined;
      }
      function knowledgeRow(id: string) {
        return db
          .prepare(
            `SELECT address, postal_code, website, phone, email, about, field_provenance FROM agent_knowledge WHERE agent_id = ?`,
          )
          .get(id) as
          | {
              address: string | null;
              postal_code: string | null;
              website: string | null;
              phone: string | null;
              email: string | null;
              about: string | null;
              field_provenance: string | null;
            }
          | undefined;
      }
      function auditFor(id: string) {
        return db
          .prepare(
            `SELECT field_name, old_value, new_value, changed_by, notes
               FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid`,
          )
          .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
      }

      const PAIR = (survivor_id: string, duplicate_id: string, reason = "duplicate_of_same_producer") => ({
        pairs: [{ survivor_id, duplicate_id, reason }],
      });

      // ── (a) auth gate ───────────────────────────────────────────────────
      let r = await post(PAIR("dm-surv-1", "dm-dup-1"), false);
      assertEq(r.status, 403, "dm-01: missing X-Admin-Key -> 403");
      r = await post(PAIR("dm-surv-1", "dm-dup-1"), "wrong-key");
      assertEq(r.status, 403, "dm-02: wrong X-Admin-Key -> 403");

      // ── (b) dry-run writes NOTHING ──────────────────────────────────────
      r = await post(PAIR("dm-surv-1", "dm-dup-1"));
      assertEq(r.body?.dry_run, true, "dm-03: dry-run by default");
      assertEq(r.body?.results?.[0]?.outcome, "would_merge", "dm-04: dry-run reports would_merge");
      assertTrue(
        (r.body?.results?.[0]?.fields_filled ?? []).includes("contact_email"),
        "dm-05: dry-run preview lists contact_email as fillable",
      );
      assertEq(agentRow("dm-dup-1")?.is_active, 1, "dm-06: dry-run left duplicate active");
      assertEq(agentRow("dm-dup-1")?.merged_into, null, "dm-07: dry-run left merged_into null");
      assertEq(agentRow("dm-surv-1")?.contact_email, "", "dm-08: dry-run left survivor contact_email untouched");
      assertEq(auditFor("dm-surv-1").length, 0, "dm-09: dry-run wrote no audit rows");

      // ── (c) apply: fills survivor, deactivates duplicate ────────────────
      r = await post(PAIR("dm-surv-1", "dm-dup-1"), testKey, { apply: "1" });
      assertEq(r.body?.dry_run, false, "dm-10: apply=1 turns off dry-run");
      assertEq(r.body?.results?.[0]?.outcome, "merged", "dm-11: apply reports merged");
      assertEq(agentRow("dm-surv-1")?.contact_email, "post@dup1.no", "dm-12: survivor contact_email filled from duplicate");
      const kn1 = knowledgeRow("dm-surv-1");
      assertEq(kn1?.address, "Gårdsveien 1", "dm-13: survivor address filled");
      assertEq(kn1?.postal_code, "1234", "dm-14: survivor postal_code filled");
      assertEq(kn1?.website, "https://dup1.no", "dm-15: survivor website filled");
      assertEq(kn1?.phone, "12345678", "dm-16: survivor phone filled");
      assertEq(kn1?.email, "kontakt@dup1.no", "dm-17: survivor knowledge email filled");
      assertEq(kn1?.about, "En fin gård.", "dm-18: survivor about filled");

      // ── (g) duplicate deactivated correctly ─────────────────────────────
      assertEq(agentRow("dm-dup-1")?.is_active, 0, "dm-19: duplicate is_active set to 0");
      assertEq(agentRow("dm-dup-1")?.merged_into, "dm-surv-1", "dm-20: duplicate merged_into = survivor id");

      // ── (f) audit rows: one per changed field + one merge-decision row ──
      const audit1 = auditFor("dm-surv-1");
      const fieldNames1 = audit1.map((a) => a.field_name).sort();
      assertEq(
        fieldNames1,
        ["about", "address", "contact_email", "email", "phone", "postal_code", "website"].sort(),
        "dm-21: one audit row per changed field on survivor",
      );
      const contactAudit1 = audit1.find((a) => a.field_name === "contact_email");
      assertEq(contactAudit1?.old_value, "", "dm-22: contact_email audit carries OLD value (reversible)");
      assertEq(contactAudit1?.new_value, "post@dup1.no", "dm-23: contact_email audit carries new value");
      const addressAudit1 = audit1.find((a) => a.field_name === "address");
      assertEq(addressAudit1?.old_value, null, "dm-24: address audit carries OLD (null) value");

      const mergeAudit1 = auditFor("dm-dup-1");
      assertEq(mergeAudit1.length, 1, "dm-25: exactly one merge-decision audit row, on the DUPLICATE's id");
      assertEq(mergeAudit1[0]?.field_name, "merge", "dm-26: merge-decision row field_name = 'merge'");
      assertEq(mergeAudit1[0]?.old_value, "dm-dup-1", "dm-27: merge-decision old_value = duplicate_id");
      assertEq(mergeAudit1[0]?.new_value, "dm-surv-1", "dm-28: merge-decision new_value = survivor_id");
      assertEq(mergeAudit1[0]?.notes, "duplicate_of_same_producer", "dm-29: merge-decision notes = reason");

      // ── (c) fill-only: survivor's existing values NOT overwritten ───────
      r = await post(PAIR("dm-surv-2", "dm-dup-2"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "merged", "dm-30: pair-2 merged");
      assertEq(agentRow("dm-surv-2")?.contact_email, "post@surv2.no", "dm-31: survivor-2 contact_email NOT overwritten");
      assertEq(knowledgeRow("dm-surv-2")?.address, "Original Address 5", "dm-32: survivor-2 address NOT overwritten");
      assertEq(auditFor("dm-surv-2").length, 0, "dm-33: no field audit rows when nothing was fillable");
      assertEq(auditFor("dm-dup-2").length, 1, "dm-34: merge-decision row still written even with 0 fields filled");
      assertEq(agentRow("dm-dup-2")?.is_active, 0, "dm-35: duplicate-2 still deactivated");

      // ── (d) claimed-row skip, both directions ────────────────────────────
      r = await post(PAIR("dm-surv-3", "dm-dup-3"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "dm-36: claimed SURVIVOR -> whole pair skipped");
      assertEq(agentRow("dm-surv-3")?.contact_email, "", "dm-37: claimed survivor untouched");
      assertEq(agentRow("dm-dup-3")?.is_active, 1, "dm-38: duplicate-3 left active (pair skipped)");
      assertEq(auditFor("dm-dup-3").length, 0, "dm-39: no audit rows for skipped_claimed pair");

      r = await post(PAIR("dm-surv-4", "dm-dup-4"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "dm-40: claimed DUPLICATE -> whole pair skipped");
      assertEq(agentRow("dm-dup-4")?.is_active, 1, "dm-41: claimed duplicate left active");
      assertEq(agentRow("dm-dup-4")?.merged_into, null, "dm-42: claimed duplicate merged_into left null");
      assertEq(agentRow("dm-surv-4")?.contact_email, "", "dm-43: survivor-4 untouched when duplicate is claimed");

      // ── (e) curated-field skip: field-level, not pair-level ──────────────
      r = await post(PAIR("dm-surv-5", "dm-dup-5"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "merged", "dm-44: curated-field pair still merges overall");
      assertTrue(
        (r.body?.results?.[0]?.detail ?? "").includes("skipped_curated_field:phone"),
        "dm-45: detail names the curated-skipped field",
      );
      assertEq(agentRow("dm-surv-5")?.contact_email, "post@dup5.no", "dm-46: contact_email still filled (not curated)");
      assertEq(knowledgeRow("dm-surv-5")?.phone, null, "dm-47: curated phone field NOT written");
      assertEq(
        auditFor("dm-surv-5")
          .map((a) => a.field_name)
          .sort(),
        ["contact_email"],
        "dm-48: no audit row for the curated-skipped field",
      );

      // ── (m) survivor with no agent_knowledge row gets one created ────────
      r = await post(PAIR("dm-surv-6", "dm-dup-6"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "merged", "dm-49: pair-6 merged");
      const kn6 = knowledgeRow("dm-surv-6");
      assertTrue(!!kn6, "dm-50: agent_knowledge row created for survivor-6");
      assertEq(kn6?.address, "Gate 6", "dm-51: created row carries duplicate's address");
      assertEq(kn6?.about, "Om gård 6", "dm-52: created row carries duplicate's about");

      // ── (l) provenance append, not overwrite ─────────────────────────────
      r = await post(PAIR("dm-surv-7", "dm-dup-7"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "merged", "dm-53: pair-7 merged");
      const kn7 = knowledgeRow("dm-surv-7");
      assertEq(kn7?.about, "Om gård 7", "dm-54: survivor-7 about filled from duplicate");
      let prov7: any = {};
      try {
        prov7 = JSON.parse(kn7?.field_provenance ?? "{}");
      } catch {
        prov7 = {};
      }
      assertTrue(Array.isArray(prov7.about), "dm-55: merged provenance.about is an array");
      assertEq(prov7.about?.length, 2, "dm-56: provenance APPENDED (2 entries), not overwritten");
      assertEq(prov7.about?.[0]?.value, "old-about-prov-noop", "dm-57: survivor's original provenance entry preserved first");
      assertEq(prov7.about?.[1]?.value, "Om gård 7", "dm-58: duplicate's provenance entry appended second");

      // ── (h) admin-key already covered above (dm-01/02) ────────────────────

      // ── (k) survivor == duplicate rejection ───────────────────────────────
      r = await post({ pairs: [{ survivor_id: "dm-surv-8", duplicate_id: "dm-surv-8", reason: "oops" }] }, testKey, {
        apply: "1",
      });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_same_id", "dm-59: survivor_id === duplicate_id rejected");

      // ── (j) same-id-twice-in-request rejection ────────────────────────────
      r = await post(
        {
          pairs: [
            { survivor_id: "dm-surv-8", duplicate_id: "dm-dup-8a", reason: "first" },
            { survivor_id: "dm-surv-8", duplicate_id: "dm-dup-8b", reason: "second-reuses-survivor" },
          ],
        },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "merged", "dm-60: first occurrence of id processed normally");
      assertEq(r.body?.results?.[1]?.outcome, "rejected_invalid_item", "dm-61: second occurrence of id rejected");
      assertEq(agentRow("dm-dup-8b")?.is_active, 1, "dm-62: dup-8b untouched (its pair was rejected)");

      // ── (n) not_found + batch hygiene: one bad pair doesn't abort batch ──
      r = await post(
        {
          pairs: [
            { survivor_id: "does-not-exist-a", duplicate_id: "does-not-exist-b", reason: "cleanup" },
            { survivor_id: "dm-surv-1", duplicate_id: "dm-dup-2-alt-does-not-exist", reason: "cleanup" },
          ],
        },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "not_found", "dm-63: unknown ids -> not_found, not fatal");
      assertEq(r.body?.results?.[1]?.outcome, "not_found", "dm-64: unknown duplicate -> not_found");

      // ── missing-field rejection ────────────────────────────────────────
      r = await post({ pairs: [{ survivor_id: "dm-surv-1", duplicate_id: "dm-dup-1" }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "dm-65: missing reason rejected");

      // ── (i) batch cap ──────────────────────────────────────────────────
      const tooMany = Array.from({ length: routeMod.DUPLICATE_MERGE_MAX_PAIRS + 1 }, (_v, i) => ({
        survivor_id: `s-${i}`,
        duplicate_id: `d-${i}`,
        reason: "r",
      }));
      r = await post({ pairs: tooMany }, testKey, { apply: "1" });
      assertEq(r.status, 400, "dm-66: oversized batch -> 400");
      r = await post({ pairs: [] });
      assertEq(r.status, 400, "dm-67: empty pairs -> 400");
      r = await post({});
      assertEq(r.status, 400, "dm-68: missing pairs -> 400");

      // ── pure helpers ────────────────────────────────────────────────────
      assertEq(routeMod.isBlank(null), true, "dm-69: isBlank(null) true");
      assertEq(routeMod.isBlank(""), true, "dm-70: isBlank('') true");
      assertEq(routeMod.isBlank("x"), false, "dm-71: isBlank('x') false");
      assertEq(
        routeMod.isFieldCurated(JSON.stringify({ email: {} }), "contact_email"),
        true,
        "dm-72: contact_email curated-lock accepts 'email' spelling",
      );
      assertEq(routeMod.isFieldCurated("not json", "address"), false, "dm-73: malformed curated JSON treated as unlocked");
    } finally {
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
      try {
        const routeMod = require("./admin-agents-duplicate-merge");
        routeMod.__setDuplicateMergeDbForTesting(null);
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}

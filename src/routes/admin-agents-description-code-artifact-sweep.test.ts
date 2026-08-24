/**
 * admin-agents-description-code-artifact-sweep.test.ts — tests for
 * POST /admin/agents/description-code-artifact-sweep (dev-request
 * 2026-08-24-produsentbeskrivelser-skrapt-js-opprydding, Endring 4).
 *
 * Setup mirrors the url-write sibling (admin-agents-url-write.test.ts)
 * exactly: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed
 * at that DB through its OWN seam (__setDescriptionSweepDbForTesting). This
 * block mutates NO shared global — not the getDb() singleton, not
 * process.env.ADMIN_KEY (it sends whatever key is already in effect).
 * Handler driven through router.handle() with a fake req/res — no HTTP, no
 * network.
 *
 * Covers:
 *   (a) auth gate
 *   (b) dry-run by default writes NOTHING, reports would_write + a truncated
 *       preview (never the full old value)
 *   (c) apply cleans the row to '' + writes a reversible agent_knowledge_audit
 *       row carrying the full OLD value
 *   (d) claimed_at row lock
 *   (e) verified agent_claims lock (the same gap url-write closes) — pending
 *       claims do NOT lock
 *   (f) curated_fields 'description' lock
 *   (g) row without agent_knowledge is still writable (LEFT JOIN)
 *   (h) a normal (non-junk) description is never a candidate at all
 *   (i) re-running after a successful clean finds nothing left to do
 *       (idempotence — a cleaned '' description is no longer a candidate)
 *   (j) empty catalog -> no errors
 *   (l) batch cap: >200 candidates -> exactly 200 processed,
 *       candidates_considered/scanned show the full pre-cap count (own
 *       isolated DB, seeded separately from the sections above so earlier
 *       writes never change this count)
 *   (m)-(o) [Section D, own isolated DB] round-2 review finding 3: this
 *       route is now wired to the enrichment-write-pause gate the same way
 *       the url-write sibling is — a live pause on 'rfb' -> 423 {paused:true}
 *       with ZERO writes (dry-run request included, since the gate runs
 *       unconditionally before the apply/dry-run branch, same discipline as
 *       the sibling), and clearing the pause restores normal behavior.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { setEnrichmentWritePause } from "../services/enrichment-write-pause";

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

// Same-shape stand-in for the real Helios-class defect (see
// description-quality.ts's looksLikeCodeArtifact doc comment) — a
// Squarespace-bootstrap fixture, NOT the real live text (this dev-request's
// research never captured it verbatim).
const SQUARESPACE_JUNK =
  'Y.Squarespace = Y.Squarespace || {}; Static.SQUARESPACE_CONTEXT = {"website":{"id":"123"},"cacheBust":"abc"}; window.Y.Squarespace.afterBodyLoad(Y);';

const NORMAL_DESC =
  "Vi driver med økologisk grønnsaksdyrking og selger direkte fra gården hver lørdag.";

export function runAdminAgentsDescriptionCodeArtifactSweepTests(
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
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "desc-sweep-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    // ─── Section A: main behavior (single shared DB) ─────────────────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);

        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
           VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?)`,
        );
        const insertKnowledge = db.prepare(
          `INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, ?)`,
        );
        const insertClaim = db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status)
           VALUES (?, ?, 'Test Claimant', 'claimant@example.no', ?)`,
        );

        // (1) plain junk row, unclaimed/uncurated -> cleanable
        insertAgent.run("ds-junk", "Junk Gård AS", SQUARESPACE_JUNK, "key-ds-junk", null);
        insertKnowledge.run("ds-junk", "{}");

        // (2) claimed_at set -> row-level lock
        insertAgent.run("ds-claimed", "Claimet Gård AS", SQUARESPACE_JUNK, "key-ds-claimed", "2026-01-01T00:00:00.000Z");
        insertKnowledge.run("ds-claimed", "{}");

        // (3) claimed_at NULL but a VERIFIED agent_claims row — the same gap
        // the url-write sibling closes.
        insertAgent.run("ds-verified-claim", "Verifisert Eier AS", SQUARESPACE_JUNK, "key-ds-vclaim", null);
        insertKnowledge.run("ds-verified-claim", "{}");
        insertClaim.run("claim-ds-verified", "ds-verified-claim", "verified");

        // (4) a PENDING claim must NOT lock
        insertAgent.run("ds-pending-claim", "Pending Eier AS", SQUARESPACE_JUNK, "key-ds-pclaim", null);
        insertKnowledge.run("ds-pending-claim", "{}");
        insertClaim.run("claim-ds-pending", "ds-pending-claim", "pending");

        // (5) curated_fields locks the description field specifically
        insertAgent.run("ds-curated", "Kuratert Gård AS", SQUARESPACE_JUNK, "key-ds-curated", null);
        insertKnowledge.run("ds-curated", JSON.stringify({ description: { by: "owner" } }));

        // (6) NO agent_knowledge row at all — LEFT JOIN must still write it
        insertAgent.run("ds-no-knowledge", "UtenKunnskap AS", SQUARESPACE_JUNK, "key-ds-nokn", null);

        // (7) a normal, non-junk description — must NEVER be a candidate
        insertAgent.run("ds-clean", "Ekte Gård AS", NORMAL_DESC, "key-ds-clean", null);
        insertKnowledge.run("ds-clean", "{}");

        // (8) already-empty description — must NEVER be a candidate either
        insertAgent.run("ds-empty", "TomBeskrivelse AS", "", "key-ds-empty", null);
        insertKnowledge.run("ds-empty", "{}");

        delete require.cache[require.resolve("./admin-agents-description-code-artifact-sweep")];
        const routeMod = require("./admin-agents-description-code-artifact-sweep");
        const router = routeMod.default;
        routeMod.__setDescriptionSweepDbForTesting(db as any);

        function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
          const headers: Record<string, string> = {};
          if (key !== false) headers["x-admin-key"] = key;
          return callRoute(router, { method: "POST", url: "/", headers, body, query });
        }
        const APPLY = { apply: "1" };
        function descOf(id: string): string | null {
          const row = db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as { description: string } | undefined;
          return row?.description ?? null;
        }
        function auditFor(id: string) {
          return db
            .prepare(
              `SELECT field_name, old_value, new_value, changed_by, notes
                 FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at`,
            )
            .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
        }
        function resultFor(body: any, agentId: string): any {
          return (body?.results ?? []).find((r: any) => r.agent_id === agentId);
        }

        // ── (a) auth gate ───────────────────────────────────────────────
        let r = await post({}, false);
        assertEq(r.status, 403, "ds-01: missing X-Admin-Key -> 403");
        r = await post({}, "wrong-key");
        assertEq(r.status, 403, "ds-02: wrong X-Admin-Key -> 403");

        // ── (b) dry-run by default: writes NOTHING, previews truncated ───
        r = await post({});
        assertEq(r.body?.dry_run, true, "ds-03: dry-run by default");
        assertEq(resultFor(r.body, "ds-junk")?.outcome, "would_write", "ds-04: dry-run reports would_write for the junk row");
        assertTrue(
          typeof resultFor(r.body, "ds-junk")?.old_value_preview === "string" &&
            resultFor(r.body, "ds-junk").old_value_preview.length <= 81,
          "ds-05: dry-run response carries a truncated preview (never the full value)",
        );
        assertTrue(
          resultFor(r.body, "ds-junk").old_value_preview.length < SQUARESPACE_JUNK.length,
          "ds-06: preview is shorter than the full junk string (never the full old value in the response)",
        );
        assertEq(descOf("ds-junk"), SQUARESPACE_JUNK, "ds-07: dry-run left the column untouched");
        assertEq(auditFor("ds-junk").length, 0, "ds-08: dry-run wrote no audit row");
        assertEq(resultFor(r.body, "ds-clean"), undefined, "ds-09: a normal description never appears as a candidate");
        assertEq(resultFor(r.body, "ds-empty"), undefined, "ds-10: an already-empty description never appears as a candidate");

        // ── (c)-(g) ONE apply call processes EVERY candidate found in the
        // full-catalog scan (this route's whole point — unlike the url-write
        // sibling, which acts on a client-supplied {agent_id} list, this one
        // has no per-target selection: a single apply call sweeps the whole
        // flagged set up to the cap in one pass). So all lock/audit
        // assertions below read off this SAME response. ──────────────────
        r = await post({ reason: "test-sweep" }, testKey, APPLY);
        assertEq(r.body?.dry_run, false, "ds-11: apply=1 turns off dry-run");

        // (c) plain junk row -> written + audited
        assertEq(resultFor(r.body, "ds-junk")?.outcome, "written", "ds-12: apply reports written for the junk row");
        assertEq(descOf("ds-junk"), "", "ds-13: description cleared to '' (agents.description is TEXT NOT NULL)");
        const audit = auditFor("ds-junk");
        assertEq(audit.length, 1, "ds-14: exactly one audit row");
        assertEq(audit[0]?.field_name, "description", "ds-15: audit names the RIGHT column");
        assertEq(audit[0]?.old_value, SQUARESPACE_JUNK, "ds-16: audit preserves the FULL old value (reversible)");
        assertEq(audit[0]?.new_value, "", "ds-17: audit records the new value ''");
        assertEq(audit[0]?.changed_by, "system", "ds-18: audit changed_by=system");
        assertTrue((audit[0]?.notes ?? "").includes("test-sweep"), "ds-19: audit notes carry the caller's reason");

        // (d) claimed_at row lock
        assertEq(resultFor(r.body, "ds-claimed")?.outcome, "skipped_claimed", "ds-20: claimed_at row skipped");
        assertEq(descOf("ds-claimed"), SQUARESPACE_JUNK, "ds-21: claimed row untouched");
        assertEq(auditFor("ds-claimed").length, 0, "ds-22: claimed row wrote no audit");

        // (e) verified agent_claims locks; pending does not
        assertEq(resultFor(r.body, "ds-verified-claim")?.outcome, "skipped_claimed", "ds-23: verified agent_claims row locks even with claimed_at NULL");
        assertEq(descOf("ds-verified-claim"), SQUARESPACE_JUNK, "ds-24: owner-verified row untouched");
        assertEq(resultFor(r.body, "ds-pending-claim")?.outcome, "written", "ds-25: a non-verified claim does NOT lock the row");
        assertEq(descOf("ds-pending-claim"), "", "ds-26: pending-claim row cleaned");

        // (f) curated_fields 'description' lock
        assertEq(resultFor(r.body, "ds-curated")?.outcome, "skipped_curated", "ds-27: curated description skipped");
        assertEq(descOf("ds-curated"), SQUARESPACE_JUNK, "ds-28: curated row untouched");

        // (g) LEFT JOIN — no agent_knowledge row is still writable
        assertEq(resultFor(r.body, "ds-no-knowledge")?.outcome, "written", "ds-29: row without agent_knowledge is still writable");
        assertEq(descOf("ds-no-knowledge"), "", "ds-30: ...and actually cleaned");

        // ── (i) idempotence — a cleaned row is no longer a candidate; the
        // still-locked rows (claimed/verified-claim/curated) remain
        // candidates forever (never written) and keep reporting their same
        // skip outcome on every re-run — that's correct, not a bug, since
        // nothing about them changed. ─────────────────────────────────────
        r = await post({});
        assertEq(resultFor(r.body, "ds-junk"), undefined, "ds-31: a re-run after cleaning no longer lists the row at all");
        assertEq(resultFor(r.body, "ds-pending-claim"), undefined, "ds-32: same for the other row cleaned above");
        assertEq(resultFor(r.body, "ds-no-knowledge"), undefined, "ds-32b: same for the LEFT JOIN row cleaned above");
        assertEq(resultFor(r.body, "ds-claimed")?.outcome, "would_write", "ds-32c: the still-locked claimed row keeps showing up on every re-run (nothing wrote it, so it's still a candidate)");

        // Note: enrichment-write-pause wiring is exercised separately below
        // (Section D, own isolated DB) — see this route's own header comment
        // for why it is now wired the same way the url-write sibling is.

        // ── (j) empty catalog is exercised separately below (own DB) ─────
      } finally {
        try {
          const routeMod = require("./admin-agents-description-code-artifact-sweep");
          routeMod.__setDescriptionSweepDbForTesting(null);
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    // ─── Section B: empty catalog -> no errors ───────────────────────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);
        const routeMod = require("./admin-agents-description-code-artifact-sweep");
        const router = routeMod.default;
        routeMod.__setDescriptionSweepDbForTesting(db as any);

        const r = await callRoute(router, {
          method: "POST",
          url: "/",
          headers: { "x-admin-key": testKey },
          body: {},
        });
        assertEq(r.status, 200, "ds-38: empty catalog -> 200, not an error");
        assertEq(r.body?.scanned, 0, "ds-39: empty catalog -> scanned=0");
        assertEq(r.body?.candidates_considered, 0, "ds-40: empty catalog -> candidates_considered=0");
        assertEq(r.body?.results?.length, 0, "ds-41: empty catalog -> no results");
      } finally {
        try {
          const routeMod = require("./admin-agents-description-code-artifact-sweep");
          routeMod.__setDescriptionSweepDbForTesting(null);
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    // ─── Section C: batch cap — isolated DB seeded ONLY with candidates,
    // so nothing from Section A's writes can shift this count. ────────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);
        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
           VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb')`,
        );

        const TOTAL_JUNK = 205; // > DESCRIPTION_SWEEP_MAX_ITEMS (200)
        for (let i = 0; i < TOTAL_JUNK; i++) {
          insertAgent.run(`ds-cap-${i}`, `Cap Gård ${i} AS`, SQUARESPACE_JUNK, `key-ds-cap-${i}`);
        }
        // A handful of clean rows too, to prove they're scanned but never counted as candidates.
        for (let i = 0; i < 5; i++) {
          insertAgent.run(`ds-cap-clean-${i}`, `Clean Gård ${i} AS`, NORMAL_DESC, `key-ds-cap-clean-${i}`);
        }

        const routeMod = require("./admin-agents-description-code-artifact-sweep");
        const router = routeMod.default;
        routeMod.__setDescriptionSweepDbForTesting(db as any);

        const r = await callRoute(router, {
          method: "POST",
          url: "/",
          headers: { "x-admin-key": testKey },
          body: {},
        });
        assertEq(r.body?.scanned, TOTAL_JUNK + 5, "ds-42: scanned counts the FULL catalog (junk + clean rows)");
        assertEq(r.body?.candidates_considered, TOTAL_JUNK, "ds-43: candidates_considered is the full pre-cap flagged count");
        assertEq(r.body?.batch_size, routeMod.DESCRIPTION_SWEEP_MAX_ITEMS, "ds-44: batch_size is capped at DESCRIPTION_SWEEP_MAX_ITEMS");
        assertEq(r.body?.results?.length, routeMod.DESCRIPTION_SWEEP_MAX_ITEMS, "ds-45: exactly the capped number of results is returned");
        assertEq(routeMod.DESCRIPTION_SWEEP_MAX_ITEMS, 200, "ds-46: the cap itself is 200, per the byggspec");
      } finally {
        try {
          const routeMod = require("./admin-agents-description-code-artifact-sweep");
          routeMod.__setDescriptionSweepDbForTesting(null);
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    // ─── Section D: enrichment-write-pause wiring (round-2 review finding
    // 3) — own isolated DB, one candidate agent, vertical_id='rfb'. ────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);

        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
           VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb')`,
        );
        insertAgent.run("ds-pause-rfb", "Pauset Gård AS", SQUARESPACE_JUNK, "key-ds-pause-rfb");

        const routeMod = require("./admin-agents-description-code-artifact-sweep");
        const router = routeMod.default;
        routeMod.__setDescriptionSweepDbForTesting(db as any);

        function post(body: any, query?: Record<string, string>): Promise<RouteResult> {
          return callRoute(router, {
            method: "POST",
            url: "/",
            headers: { "x-admin-key": testKey },
            body,
            query,
          });
        }
        function descOf(id: string): string | null {
          const row = db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as { description: string } | undefined;
          return row?.description ?? null;
        }
        function auditCount(): number {
          return (db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge_audit`).get() as { n: number }).n;
        }

        // ── (m) pause 'rfb' -> dry-run request also gets 423, zero writes ──
        setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: true, reason: "test-pause" }, "test-actor");
        let r = await post({});
        assertEq(r.status, 423, "dspause-01: paused 'rfb' -> dry-run sweep request -> 423 (gate runs unconditionally)");
        assertEq(r.body?.paused, true, "dspause-02: … paused:true");
        assertEq(r.body?.vertical, "rfb", "dspause-03: … vertical resolved from agents.vertical_id");
        assertEq(r.body?.reason, "test-pause", "dspause-04: … stored reason surfaced");
        assertEq(r.body?.fail_closed, false, "dspause-05: … a real pause, not a lookup failure");
        assertEq(descOf("ds-pause-rfb"), SQUARESPACE_JUNK, "dspause-06: dry-run under pause touched nothing");

        // ── (n) apply request under the same pause -> also 423, zero writes ─
        r = await post({ reason: "should-not-run" }, { apply: "1" });
        assertEq(r.status, 423, "dspause-07: paused 'rfb' -> apply=1 sweep request -> 423 too");
        assertEq(descOf("ds-pause-rfb"), SQUARESPACE_JUNK, "dspause-08: apply under pause changed NOTHING");
        assertEq(auditCount(), 0, "dspause-09: apply under pause wrote NO audit row");

        // ── (o) clearing the pause restores normal behavior ─────────────
        setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: false, cleared_by: "test-actor" }, "test-actor");
        r = await post({ reason: "post-clear" }, { apply: "1" });
        assertEq(r.status, 200, "dspause-10: cleared pause -> sweep works normally again");
        assertEq(r.body?.dry_run, false, "dspause-11: apply=1 honored again");
        assertEq(descOf("ds-pause-rfb"), "", "dspause-12: row cleaned exactly as it would have been without the pause");
        assertEq(auditCount(), 1, "dspause-13: exactly one audit row written post-clear");
      } finally {
        try {
          const routeMod = require("./admin-agents-description-code-artifact-sweep");
          routeMod.__setDescriptionSweepDbForTesting(null);
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (setKeyOurselves) delete process.env.ADMIN_KEY;

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminAgentsDescriptionCodeArtifactSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

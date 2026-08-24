/**
 * marketplace-patch-description-artifact-guard.test.ts — tests for the
 * write-time code-artifact gate on `PATCH /agents/:id`, `PUT /agents/:id`,
 * and `PUT /agents/:id/description` (dev-request 2026-08-24-produsent
 * beskrivelser-skrapt-js-opprydding, Endring 3 + the round-2 review's
 * finding 2: the reviewer found the latter two write paths reached the same
 * unprotected sink and were not gated by the first pass).
 *
 * Mirrors marketplace-availability-patch.test.ts's structure exactly:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (swaps the shared getDb() singleton, restored
 *     in `finally`).
 *   - the router is exercised directly (router.handle(req, res, next)), no
 *     HTTP server / supertest.
 *   - exported runMarketplacePatchDescriptionArtifactGuardTests({log}) ->
 *     TestSummary; wired into tests/test.ts via runSerial().
 *     Standalone: npx tsx src/routes/marketplace-patch-description-artifact-guard.test.ts
 *
 * Covers, for PATCH /agents/:id:
 *   (1) a description containing code/script artifacts -> 400, BEFORE any
 *       write (DB confirmed unchanged).
 *   (2) a normal description -> 200, written exactly as before the gate
 *       existed (regression control — this is the reviewer's specific
 *       concern per the byggspec).
 *   (3) a description that merely NAMES a technology in flowing prose
 *       (mentions "JavaScript") -> 200, NOT rejected (Daniel's explicit
 *       requirement — this is the critical negative control).
 *   (4) a PATCH that never touches `description` at all (e.g. only `name`)
 *       -> 200, completely unaffected by the new gate.
 *   (5) the gate fires for BOTH accepted auth modes (X-Admin-Key and the
 *       agent's own X-API-Key), since the check sits after the authorized
 *       branch, not inside just one of them.
 *   (6) unauthenticated code-artifact PATCH -> 403 (auth gate still runs
 *       FIRST — a 400 must never leak past authorization).
 *   (7) explicit `description: null` -> 400 (clean guard), never the
 *       uncaught SqliteError/HTTP 500 the reviewer reproduced live against
 *       the pre-existing (unguarded) behavior.
 *
 * And, added in the round-2 review pass, the two additional write paths:
 *   (8)-(11) PUT /agents/:id (agent's own X-API-Key): code-artifact -> 400
 *       (row untouched), normal description -> 200 (regression control),
 *       explicit null -> 400 (same clean guard as PATCH).
 *   (12)-(16) PUT /agents/:id/description: code-artifact -> 400 under each
 *       of its three accepted auth modes (X-Admin-Key, X-Claim-Token,
 *       X-API-Key — X-Claim-Token is the most realistic real-world path for
 *       this exact defect, a producer pasting scraped page text into their
 *       own claimed listing), normal description -> 200 (regression
 *       control, existing length/shape validation unchanged), explicit
 *       null -> 400 via the route's PRE-EXISTING "description må være
 *       string" type check (already safe before this dev-request; verified
 *       here as a regression guard, not a new code path).
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
  rePin?: () => void,
): Promise<RouteResult> {
  return new Promise((resolve) => {
    if (rePin) rePin();
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

// Same-shape stand-in for the real Helios-class defect (see
// description-quality.ts's looksLikeCodeArtifact doc comment) — a
// Squarespace-bootstrap fixture, NOT the real live text.
const SQUARESPACE_JUNK =
  'Y.Squarespace = Y.Squarespace || {}; Static.SQUARESPACE_CONTEXT = {"website":{"id":"123"},"cacheBust":"abc"}; window.Y.Squarespace.afterBodyLoad(Y);';

const NORMAL_DESC =
  "Vi driver med økologisk grønnsaksdyrking og selger direkte fra gården hver lørdag.";

const TECH_MENTION_DESC =
  "Vi bruker moderne teknologi og JavaScript-baserte verktøy i gårdsdriften vår.";

export function runMarketplacePatchDescriptionArtifactGuardTests(
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

  return (async () => {
    const prevDb = initMod.getDb();
    const testAdminKey = process.env.ADMIN_KEY || "marketplace-patch-desc-guard-test-admin-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = testAdminKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, ?, 'test', 'x@example.com', 'https://example.no', 'producer', ?)`,
      );
      insertAgent.run("pg-a", "Gard A AS", NORMAL_DESC, "api-key-pg-a");
      insertAgent.run("pg-b", "Gard B AS", NORMAL_DESC, "api-key-pg-b");
      insertAgent.run("pg-c", "Gard C AS", NORMAL_DESC, "api-key-pg-c");
      insertAgent.run("pg-d", "Gard D AS", NORMAL_DESC, "api-key-pg-d");

      // A verified claim on pg-c — this is the most realistic real-world
      // path for this exact defect: a producer pastes scraped page text
      // into their OWN claimed listing via X-Claim-Token.
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
         VALUES ('claim-pg-c', 'pg-c', 'Eier C', 'eier-c@example.com', 'verified', 'claim-token-pg-c',
                 datetime('now', '+30 days'))`,
      ).run();

      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      const rePin = () => {
        initMod.__setDbForTesting(db as any);
        process.env.ADMIN_KEY = testAdminKey;
        delete process.env.ANALYTICS_ADMIN_KEY;
      };

      function descOf(id: string): string {
        const row = db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as { description: string };
        return row.description;
      }

      // ── (1) code-artifact description -> 400, BEFORE any write ─────────
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-a",
          headers: { "x-admin-key": testAdminKey },
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 400, "pg-01: code-artifact description -> 400");
        assertEq(r.body?.error, "description contains code/script artifacts — rejected", "pg-02: 400 body carries the exact rejection message");
        assertEq(descOf("pg-a"), NORMAL_DESC, "pg-03: rejected PATCH never touched the row");
      }

      // ── (2) normal description -> 200, written exactly as before ───────
      {
        const newDesc = "Vi selger egg, honning og bær rett fra gårdsbutikken hver helg.";
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-a",
          headers: { "x-admin-key": testAdminKey },
          body: { description: newDesc },
        }, rePin);
        assertEq(r.status, 200, "pg-04: normal description PATCH -> 200 (regression control)");
        assertEq(r.body?.success, true, "pg-05: normal description PATCH -> success:true");
        assertEq(r.body?.data?.description, newDesc, "pg-06: response echoes the new description");
        assertEq(descOf("pg-a"), newDesc, "pg-07: row actually updated");
      }

      // ── (3) prose that merely NAMES a technology -> 200, NOT rejected ──
      // (Daniel's explicit requirement — the critical negative control.)
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-a",
          headers: { "x-admin-key": testAdminKey },
          body: { description: TECH_MENTION_DESC },
        }, rePin);
        assertEq(r.status, 200, "pg-08: description merely mentioning 'JavaScript' in prose -> 200 (NOT rejected)");
        assertEq(descOf("pg-a"), TECH_MENTION_DESC, "pg-09: written exactly as sent");
      }

      // ── (4) PATCH that never touches `description` -> 200, unaffected ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-a",
          headers: { "x-admin-key": testAdminKey },
          body: { name: "Gard A Oppdatert AS" },
        }, rePin);
        assertEq(r.status, 200, "pg-10: PATCH without a 'description' key -> 200, gate never even runs");
        assertEq(descOf("pg-a"), TECH_MENTION_DESC, "pg-11: description column untouched by a name-only PATCH");
      }

      // ── (5) gate fires under BOTH accepted auth modes ──────────────────
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-b",
          headers: { "x-api-key": "api-key-pg-b" },
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 400, "pg-12: code-artifact description rejected under X-API-Key auth too");
        assertEq(descOf("pg-b"), NORMAL_DESC, "pg-13: agent's own API-key PATCH still didn't write junk");
      }

      // ── (6) unauthenticated code-artifact PATCH -> 403, not 400 ────────
      // (auth runs FIRST — a validation error must never leak past it)
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-b",
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 403, "pg-14: unauthenticated request -> 403 (auth gate runs before the artifact gate)");
        assertEq(descOf("pg-b"), NORMAL_DESC, "pg-15: unauthenticated PATCH never touched the row");
      }

      // ── (7) explicit `description: null` -> 400, clean guard ───────────
      // (round-2 review finding 4 — pre-existing bug, reproduced live by the
      // reviewer as an uncaught SqliteError -> HTTP 500 with a leaked stack
      // trace; now caught cleanly BEFORE the write.)
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/pg-a",
          headers: { "x-admin-key": testAdminKey },
          body: { description: null },
        }, rePin);
        assertEq(r.status, 400, "pg-16: PATCH description:null -> 400, not a 500");
        assertEq(
          r.body?.error,
          "description cannot be null — agents.description is NOT NULL",
          "pg-17: null-guard carries a clean, specific error message",
        );
        assertEq(descOf("pg-a"), TECH_MENTION_DESC, "pg-18: row untouched by the rejected null PATCH");
      }

      // ═══════════════════════════════════════════════════════════════
      // PUT /agents/:id — round-2 review finding 2, write path #1
      // ═══════════════════════════════════════════════════════════════

      // ── (8) code-artifact description -> 400, BEFORE any write ─────────
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-d",
          headers: { "x-api-key": "api-key-pg-d" },
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 400, "pgput-01: PUT /agents/:id code-artifact description -> 400");
        assertEq(
          r.body?.error,
          "description contains code/script artifacts — rejected",
          "pgput-02: same rejection message as the PATCH gate",
        );
        assertEq(descOf("pg-d"), NORMAL_DESC, "pgput-03: rejected PUT never touched the row");
      }

      // ── (9) normal description -> 200, written exactly as before ───────
      {
        const newDesc = "Vi selger poteter og gulrøtter rett fra jordet, hele høsten.";
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-d",
          headers: { "x-api-key": "api-key-pg-d" },
          body: { description: newDesc },
        }, rePin);
        assertEq(r.status, 200, "pgput-04: normal description PUT -> 200 (regression control)");
        assertEq(r.body?.success, true, "pgput-05: normal description PUT -> success:true");
        assertEq(descOf("pg-d"), newDesc, "pgput-06: row actually updated");
      }

      // ── (10) PUT that never touches `description` -> 200, unaffected ───
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-d",
          headers: { "x-api-key": "api-key-pg-d" },
          body: { name: "Gard D Oppdatert AS" },
        }, rePin);
        assertEq(r.status, 200, "pgput-07: PUT without a 'description' key -> 200, gate never even runs");
        assertEq(descOf("pg-d"), "Vi selger poteter og gulrøtter rett fra jordet, hele høsten.", "pgput-08: description column untouched");
      }

      // ── (11) explicit `description: null` -> 400, clean guard ──────────
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-d",
          headers: { "x-api-key": "api-key-pg-d" },
          body: { description: null },
        }, rePin);
        assertEq(r.status, 400, "pgput-09: PUT description:null -> 400, not a 500");
        assertEq(
          r.body?.error,
          "description cannot be null — agents.description is NOT NULL",
          "pgput-10: same clean null-guard message as PATCH",
        );
      }

      // ═══════════════════════════════════════════════════════════════
      // PUT /agents/:id/description — round-2 review finding 2, write
      // path #2 ("PR-42"). Existing length/type validation is UNCHANGED —
      // these tests only add coverage for the new code-artifact check.
      // ═══════════════════════════════════════════════════════════════

      // ── (12) code-artifact -> 400 under X-Admin-Key ─────────────────────
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-c/description",
          headers: { "x-admin-key": testAdminKey },
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 400, "pgdesc-01: X-Admin-Key code-artifact description -> 400");
        assertEq(
          r.body?.error,
          "description contains code/script artifacts — rejected",
          "pgdesc-02: same rejection message text, wrapped in this route's {success,error} shape",
        );
        assertEq(r.body?.success, false, "pgdesc-03: success:false in the rejection body");
        assertEq(descOf("pg-c"), NORMAL_DESC, "pgdesc-04: rejected PUT .../description never touched the row");
      }

      // ── (13) code-artifact -> 400 under X-Claim-Token (the most
      // realistic real-world path: a producer's own claim) ────────────────
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-c/description",
          headers: { "x-claim-token": "claim-token-pg-c" },
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 400, "pgdesc-05: X-Claim-Token code-artifact description -> 400");
        assertEq(descOf("pg-c"), NORMAL_DESC, "pgdesc-06: rejected claim-token PUT never touched the row");
      }

      // ── (14) code-artifact -> 400 under X-API-Key ───────────────────────
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-c/description",
          headers: { "x-api-key": "api-key-pg-c" },
          body: { description: SQUARESPACE_JUNK },
        }, rePin);
        assertEq(r.status, 400, "pgdesc-07: X-API-Key code-artifact description -> 400");
        assertEq(descOf("pg-c"), NORMAL_DESC, "pgdesc-08: rejected API-key PUT never touched the row");
      }

      // ── (15) normal description -> 200, written exactly as before
      // (regression control — existing length/shape validation unchanged) ─
      {
        const newDesc = "Vi driver med bærproduksjon og selger rett fra gården hver helg.";
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-c/description",
          headers: { "x-claim-token": "claim-token-pg-c" },
          body: { description: newDesc },
        }, rePin);
        assertEq(r.status, 200, "pgdesc-09: normal description PUT .../description -> 200 (regression control)");
        assertEq(r.body?.success, true, "pgdesc-10: success:true");
        assertEq(descOf("pg-c"), newDesc, "pgdesc-11: row actually updated");
      }

      // ── (16) explicit `description: null` -> 400 via the route's
      // PRE-EXISTING "description må være string" type check (already safe
      // before this dev-request; verified here as a regression guard). ────
      {
        const r = await callRoute(router, {
          method: "PUT",
          url: "/agents/pg-c/description",
          headers: { "x-claim-token": "claim-token-pg-c" },
          body: { description: null },
        }, rePin);
        assertEq(r.status, 400, "pgdesc-12: PUT .../description with description:null -> 400, not a 500");
        assertEq(r.body?.error, "description må være string.", "pgdesc-13: pre-existing type-check message, unchanged");
        assertEq(
          descOf("pg-c"),
          "Vi driver med bærproduksjon og selger rett fra gården hver helg.",
          "pgdesc-14: row untouched by the rejected null PUT",
        );
      }
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMarketplacePatchDescriptionArtifactGuardTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

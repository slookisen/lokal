/**
 * admin-agents-contact-email-write.test.ts — tests for
 * POST /admin/agents/contact-email-write (dev-request
 * 2026-08-01-rfb-contact-email-skrivespak, P0).
 *
 * The route exists because `agents.contact_email` — the column outreach
 * actually sends to — had no UPDATE path anywhere in src/, leaving 77 agents
 * carrying the platform's own address as the producer's contact (36 of them
 * already contacted) and 202 with a DNS-dead domain, all unfixable.
 *
 * Setup mirrors admin-contact-write-guard-retro-sweep.test.ts exactly:
 * better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting, and
 * the route's handler driven directly through router.handle() with a fake
 * req/res — no HTTP server, no supertest, no network.
 *
 * Covers:
 *   (a) auth gate
 *   (b) dry-run by default writes NOTHING (the column is untouched)
 *   (c) apply clears the column AND leaves a reversible audit row
 *   (d) apply can set a real address
 *   (e) claimed_at row-level lock is never written through
 *   (f) curated_fields per-field lock (both spellings) is never written through
 *   (g) writing a platform-owned domain IN is refused — fail closed both ways
 *   (h) syntactic validation, required reason, empty-string-is-not-a-clear
 *   (i) idempotence — a second apply adds no second audit row
 *   (j) rows with NO agent_knowledge row are still writable (LEFT JOIN)
 *   (k) batch hygiene — unknown ids don't abort the batch, dupes rejected,
 *       oversized/empty batches rejected
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

export function runAdminAgentsContactEmailWriteTests(
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
    const testKey = "admin-agents-contact-email-write-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
         VALUES (?, ?, 'test agent', 'test', ?, 'https://example.no', 'producer', ?, 'rfb', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, ?)`,
      );

      // (1) platform-owned email, unclaimed/uncurated -> clearable
      insertAgent.run("cew-platform", "PlatformEmail AS", "kontakt@rettfrabonden.com", "key-cew-platform", null);
      insertKnowledge.run("cew-platform", "{}");

      // (2) empty contact_email -> settable
      insertAgent.run("cew-empty", "EmptyEmail AS", "", "key-cew-empty", null);  // NOT NULL column: "" is the cleared form
      insertKnowledge.run("cew-empty", "{}");

      // (3) owner-claimed, platform email -> row-level lock
      insertAgent.run("cew-claimed", "ClaimedAgent AS", "kontakt@rettfrabonden.com", "key-cew-claimed", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("cew-claimed", "{}");

      // (4) curated lock spelled "email" (the knowledge column's own name)
      insertAgent.run("cew-curated-email", "CuratedEmail AS", "kontakt@rettfrabonden.com", "key-cew-cur-email", null);
      insertKnowledge.run("cew-curated-email", JSON.stringify({ email: { by: "owner" } }));

      // (5) curated lock spelled "contact_email"
      insertAgent.run("cew-curated-contact", "CuratedContact AS", "kontakt@rettfrabonden.com", "key-cew-cur-contact", null);
      insertKnowledge.run("cew-curated-contact", JSON.stringify({ contact_email: { by: "owner" } }));

      // (6) a real producer address — negative control for the platform check
      insertAgent.run("cew-real", "RealEmail AS", "post@syse.no", "key-cew-real", null);
      insertKnowledge.run("cew-real", "{}");

      // (7) NO agent_knowledge row at all: contact_email lives on `agents`, so
      // this must still be writable. An INNER JOIN would silently skip it.
      insertAgent.run("cew-no-knowledge", "NoKnowledge AS", "kontakt@rettfrabonden.com", "key-cew-nokn", null);

      // (8) fly.dev subdomain fixture
      insertAgent.run("cew-flydev", "FlyDevEmail AS", "tjamsland@lokal.fly.dev", "key-cew-flydev", null);
      insertKnowledge.run("cew-flydev", "{}");

      delete require.cache[require.resolve("./admin-agents-contact-email-write")];
      const routeMod = require("./admin-agents-contact-email-write");
      const router = routeMod.default;

      function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body, query });
      }
      function emailOf(id: string): string | null {
        const row = db.prepare(`SELECT contact_email FROM agents WHERE id = ?`).get(id) as
          | { contact_email: string | null }
          | undefined;
        return row?.contact_email ?? null;
      }
      function auditFor(id: string) {
        return db
          .prepare(
            `SELECT field_name, old_value, new_value, changed_by, notes
               FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at`,
          )
          .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
      }
      const CLEAR = (id: string, reason = "platform_email_not_producer_contact") => ({
        items: [{ agent_id: id, email: null, reason }],
      });

      // ── (a) auth gate ───────────────────────────────────────────────────
      let r = await post(CLEAR("cew-platform"), false);
      assertEq(r.status, 403, "cew-01: missing X-Admin-Key -> 403");
      r = await post(CLEAR("cew-platform"), "wrong-key");
      assertEq(r.status, 403, "cew-02: wrong X-Admin-Key -> 403");

      // ── (b) dry-run writes NOTHING ──────────────────────────────────────
      r = await post(CLEAR("cew-platform"));
      assertEq(r.body?.dry_run, true, "cew-03: dry-run by default");
      assertEq(r.body?.results?.[0]?.outcome, "would_write", "cew-04: dry-run reports would_write");
      assertEq(emailOf("cew-platform"), "kontakt@rettfrabonden.com", "cew-05: dry-run left the column untouched");
      assertEq(auditFor("cew-platform").length, 0, "cew-06: dry-run wrote no audit row");

      // ── (c) apply clears + audits reversibly ────────────────────────────
      r = await post(CLEAR("cew-platform"), testKey, { apply: "1" });
      assertEq(r.body?.dry_run, false, "cew-07: apply=1 turns off dry-run");
      assertEq(r.body?.results?.[0]?.outcome, "written", "cew-08: apply reports written");
      assertEq(emailOf("cew-platform"), "", "cew-09: contact_email actually cleared (stored as \"\" — NOT NULL column)");
      const audit = auditFor("cew-platform");
      assertEq(audit.length, 1, "cew-10: exactly one audit row");
      assertEq(audit[0]?.field_name, "contact_email", "cew-11: audit names the RIGHT column");
      assertEq(audit[0]?.old_value, "kontakt@rettfrabonden.com", "cew-12: audit preserves old value (reversible)");
      assertEq(audit[0]?.new_value, "", "cew-13: audit records the empty string actually written");
      assertEq(audit[0]?.changed_by, "system", "cew-14: audit changed_by=system");
      assertTrue(
        (audit[0]?.notes ?? "").includes("platform_email_not_producer_contact"),
        "cew-15: audit notes carry the caller's reason",
      );

      // ── (d) apply can SET a real address ────────────────────────────────
      r = await post(
        { items: [{ agent_id: "cew-empty", email: "post@nygard.no", reason: "extracted_from_homepage" }] },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "written", "cew-16: set reports written");
      assertEq(emailOf("cew-empty"), "post@nygard.no", "cew-17: address actually set");

      // ── (e) claimed_at row-level lock ───────────────────────────────────
      r = await post(CLEAR("cew-claimed"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "cew-18: claimed row skipped");
      assertEq(emailOf("cew-claimed"), "kontakt@rettfrabonden.com", "cew-19: claimed row untouched");
      assertEq(auditFor("cew-claimed").length, 0, "cew-20: claimed row wrote no audit");

      // ── (f) curated per-field lock, BOTH spellings ──────────────────────
      r = await post(CLEAR("cew-curated-email"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_curated", "cew-21: curated 'email' skipped");
      assertEq(emailOf("cew-curated-email"), "kontakt@rettfrabonden.com", "cew-22: curated 'email' untouched");
      r = await post(CLEAR("cew-curated-contact"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_curated", "cew-23: curated 'contact_email' skipped");

      // ── (g) refuse to write a platform domain IN ────────────────────────
      r = await post(
        { items: [{ agent_id: "cew-real", email: "kontakt@rettfrabonden.com", reason: "oops" }] },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "rejected_platform_domain", "cew-24: platform domain refused on write-in");
      assertEq(emailOf("cew-real"), "post@syse.no", "cew-25: real address untouched by the refusal");
      r = await post(
        { items: [{ agent_id: "cew-real", email: "noe@lokal.fly.dev", reason: "oops" }] },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "rejected_platform_domain", "cew-26: *.fly.dev refused too");

      // ── (h) validation / reason / empty-string ──────────────────────────
      r = await post({ items: [{ agent_id: "cew-real", email: "ikke-en-epost", reason: "r" }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_email", "cew-27: invalid syntax rejected");
      r = await post({ items: [{ agent_id: "cew-real", email: null }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_missing_reason", "cew-28: clearing still requires a reason");
      r = await post({ items: [{ agent_id: "cew-real", email: "", reason: "r" }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "cew-29: empty string is not a clear instruction");
      assertEq(emailOf("cew-real"), "post@syse.no", "cew-30: negative controls left the real address intact");

      // ── (i) idempotence ─────────────────────────────────────────────────
      r = await post(CLEAR("cew-platform"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_unchanged", "cew-31: re-clearing reports unchanged");
      assertEq(auditFor("cew-platform").length, 1, "cew-32: idempotent re-apply adds no second audit row");

      // ── (j) row with no agent_knowledge row ─────────────────────────────
      r = await post(CLEAR("cew-no-knowledge"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "written", "cew-33: row without agent_knowledge is still writable");
      assertEq(emailOf("cew-no-knowledge"), "", "cew-34: ...and actually cleared");

      // ── (k) batch hygiene ───────────────────────────────────────────────
      r = await post(
        {
          items: [
            { agent_id: "does-not-exist", email: null, reason: "cleanup" },
            { agent_id: "cew-flydev", email: null, reason: "cleanup" },
          ],
        },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "not_found", "cew-35: unknown id reported, not fatal");
      assertEq(r.body?.results?.[1]?.outcome, "written", "cew-36: rest of the batch still processed");
      assertEq(emailOf("cew-flydev"), "", "cew-37: fly.dev fixture cleared");

      r = await post(
        {
          items: [
            { agent_id: "cew-real", email: null, reason: "cleanup" },
            { agent_id: "cew-real", email: "post@annen.no", reason: "cleanup" },
          ],
        },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[1]?.outcome, "rejected_invalid_item", "cew-38: duplicate agent_id in one request rejected");

      const tooMany = Array.from({ length: routeMod.CONTACT_EMAIL_WRITE_MAX_ITEMS + 1 }, (_v, i) => ({
        agent_id: `bulk-${i}`,
        email: null,
        reason: "r",
      }));
      r = await post({ items: tooMany }, testKey, { apply: "1" });
      assertEq(r.status, 400, "cew-39: oversized batch -> 400");
      r = await post({ items: [] });
      assertEq(r.status, 400, "cew-40: empty items -> 400");
      r = await post({});
      assertEq(r.status, 400, "cew-41: missing items -> 400");

      // ── pure helpers ────────────────────────────────────────────────────
      assertEq(routeMod.isPlatformOwnedEmailDomain("INFO@RettFraBonden.com"), true, "cew-42: platform check is case-insensitive");
      assertEq(routeMod.isPlatformOwnedEmailDomain("post@rettfrabonden.no"), false, "cew-43: .no lookalike is NOT platform-owned");
      assertEq(routeMod.isSyntacticallyValidEmail("a.b-c+d@sub.example.co.uk"), true, "cew-44: ordinary address accepted");
      assertEq(routeMod.isSyntacticallyValidEmail("post@syse"), false, "cew-45: missing TLD rejected");
      assertEq(routeMod.isContactEmailCurated("not json"), false, "cew-46: malformed curated JSON treated as unlocked");
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        db.close();
      } catch {
        /* ignore */
      }
      initMod.__setDbForTesting(prevDb as any);
    }

    return { passed, failed, failures };
  })();
}

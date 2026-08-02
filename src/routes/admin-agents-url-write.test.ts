/**
 * admin-agents-url-write.test.ts — tests for POST /admin/agents/url-write
 * (dev-request 2026-08-01-rfb-agents-url-skrivespak).
 *
 * The route exists because `agents.url` — the homepage the catalog serves and
 * the field enrichment reads a producer's email off — had no UPDATE path
 * anywhere in src/. Measured on the live catalog 2026-08-01 (971 homepages
 * probed): only 445 are a real own site, 340 are a shared directory host, 87
 * an own host that is down, 4 point at rettfrabonden.com — none fixable.
 *
 * Setup mirrors the contact-email sibling: better-sqlite3 ":memory:" +
 * __initSchemaForTesting, route pointed at that DB through its OWN seam
 * (__setUrlWriteDbForTesting). This block mutates NO shared global — not the
 * getDb() singleton (pinning it races blocks that read it across an await, the
 * concrete cause of PR #444's determinism-gate failure), not
 * process.env.ADMIN_KEY (it sends whatever key is already in effect). Handler
 * driven through router.handle() with a fake req/res — no HTTP, no network.
 *
 * Covers:
 *   (a) auth gate
 *   (b) dry-run by default writes NOTHING
 *   (c) apply replaces a directory URL with a real one + reversible audit
 *   (d) clearing (url: null) stores "" — agents.url is TEXT NOT NULL
 *   (e) claimed_at row lock
 *   (f) THE GAP THIS ROUTE CLOSES: agent_claims status='verified' locks too,
 *       while a non-verified claim does not
 *   (g) curated_fields per-field lock, both spellings
 *   (h) directory hosts rejected by default, allowed only on explicit opt-in
 *   (i) platform hosts refused in both directions
 *   (j) shape validation, required reason, empty-string-is-not-a-clear
 *   (k) idempotence, LEFT JOIN (no knowledge row), batch hygiene
 *   (l) pure helpers
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

export function runAdminAgentsUrlWriteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // SHARED-GLOBAL DISCIPLINE (tests/test.ts, "SHARED GLOBAL STATE"): read the
    // ambient admin key and send THAT, mutating nothing. Only set one when this
    // file is run standalone outside the suite — and restore it in `finally`.
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "admin-agents-url-write-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'post@example.no', ?, 'producer', ?, 'rfb', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, ?)`,
      );
      const insertClaim = db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status)
         VALUES (?, ?, 'Test Claimant', 'claimant@example.no', ?)`,
      );

      // (1) directory URL, unclaimed/uncurated -> replaceable with a real site
      insertAgent.run("uw-directory", "Direktoriet AS", "https://www.bondensmarked.no/produsent/123", "key-uw-dir", null);
      insertKnowledge.run("uw-directory", "{}");

      // (2) empty url -> settable
      insertAgent.run("uw-empty", "TomUrl AS", "", "key-uw-empty", null);
      insertKnowledge.run("uw-empty", "{}");

      // (3) claimed_at set -> row-level lock
      insertAgent.run("uw-claimed", "Claimet AS", "https://www.hanen.no/bedrift/686", "key-uw-claimed", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("uw-claimed", "{}");

      // (4) THE GAP: claimed_at NULL, but a VERIFIED row in agent_claims. This
      // is the exact production shape that forced the A0 batch to exclude three
      // agents by hand (Farmors Marked, Hommelstad Gård, Røhne Bryggerhus).
      insertAgent.run("uw-verified-claim", "Verifisert Eier AS", "https://www.facebook.com/verifisert", "key-uw-vclaim", null);
      insertKnowledge.run("uw-verified-claim", "{}");
      insertClaim.run("claim-uw-verified", "uw-verified-claim", "verified");

      // (5) a claim that is NOT verified must NOT lock — otherwise every
      // abandoned pending claim would freeze the row forever.
      insertAgent.run("uw-pending-claim", "Pending Eier AS", "https://www.rekonorge.no/x", "key-uw-pclaim", null);
      insertKnowledge.run("uw-pending-claim", "{}");
      insertClaim.run("claim-uw-pending", "uw-pending-claim", "pending");

      // (6)(7) curated locks, both spellings
      insertAgent.run("uw-curated-website", "Kuratert Website AS", "https://www.hanen.no/bedrift/1", "key-uw-cw", null);
      insertKnowledge.run("uw-curated-website", JSON.stringify({ website: { by: "owner" } }));
      insertAgent.run("uw-curated-url", "Kuratert Url AS", "https://www.hanen.no/bedrift/2", "key-uw-cu", null);
      insertKnowledge.run("uw-curated-url", JSON.stringify({ url: { by: "owner" } }));

      // (8) a real own homepage — negative control
      insertAgent.run("uw-real", "Ekte Gård AS", "https://www.ergagardsutsalg.no", "key-uw-real", null);
      insertKnowledge.run("uw-real", "{}");

      // (9) NO agent_knowledge row: url lives on `agents`, so this must still
      // be writable. An INNER JOIN would silently skip it.
      insertAgent.run("uw-no-knowledge", "UtenKunnskap AS", "https://www.lokalmat.no/p/9", "key-uw-nokn", null);

      // (10) our own site standing in as the producer's homepage (4 measured)
      insertAgent.run("uw-platform", "Plattform AS", "https://rettfrabonden.com/agent/solvang", "key-uw-plat", null);
      insertKnowledge.run("uw-platform", "{}");

      delete require.cache[require.resolve("./admin-agents-url-write")];
      const routeMod = require("./admin-agents-url-write");
      const router = routeMod.default;
      routeMod.__setUrlWriteDbForTesting(db as any);

      function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body, query });
      }
      const APPLY = { apply: "1" };
      function urlOf(id: string): string | null {
        const row = db.prepare(`SELECT url FROM agents WHERE id = ?`).get(id) as { url: string | null } | undefined;
        return row?.url ?? null;
      }
      function auditFor(id: string) {
        return db
          .prepare(
            `SELECT field_name, old_value, new_value, changed_by, notes
               FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at`,
          )
          .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
      }
      const SET = (id: string, url: string | null, reason = "homepage_verified_live") => ({
        items: [{ agent_id: id, url, reason }],
      });

      // ── (a) auth gate ───────────────────────────────────────────────────
      let r = await post(SET("uw-directory", "https://www.gard.no"), false);
      assertEq(r.status, 403, "uw-01: missing X-Admin-Key -> 403");
      r = await post(SET("uw-directory", "https://www.gard.no"), "wrong-key");
      assertEq(r.status, 403, "uw-02: wrong X-Admin-Key -> 403");

      // ── (b) dry-run writes NOTHING ──────────────────────────────────────
      r = await post(SET("uw-directory", "https://www.akerhaugengard.no"));
      assertEq(r.body?.dry_run, true, "uw-03: dry-run by default");
      assertEq(r.body?.results?.[0]?.outcome, "would_write", "uw-04: dry-run reports would_write");
      assertEq(r.body?.results?.[0]?.old_value, "https://www.bondensmarked.no/produsent/123", "uw-05: dry-run shows the old value");
      assertEq(urlOf("uw-directory"), "https://www.bondensmarked.no/produsent/123", "uw-06: dry-run left the column untouched");
      assertEq(auditFor("uw-directory").length, 0, "uw-07: dry-run wrote no audit row");

      // ── (c) apply replaces + audits reversibly ──────────────────────────
      r = await post(SET("uw-directory", "https://www.akerhaugengard.no"), testKey, APPLY);
      assertEq(r.body?.dry_run, false, "uw-08: apply=1 turns off dry-run");
      assertEq(r.body?.results?.[0]?.outcome, "written", "uw-09: apply reports written");
      assertEq(urlOf("uw-directory"), "https://www.akerhaugengard.no", "uw-10: url actually replaced");
      const audit = auditFor("uw-directory");
      assertEq(audit.length, 1, "uw-11: exactly one audit row");
      assertEq(audit[0]?.field_name, "url", "uw-12: audit names the RIGHT column");
      assertEq(audit[0]?.old_value, "https://www.bondensmarked.no/produsent/123", "uw-13: audit preserves old value (reversible)");
      assertEq(audit[0]?.new_value, "https://www.akerhaugengard.no", "uw-14: audit records the new value");
      assertEq(audit[0]?.changed_by, "system", "uw-15: audit changed_by=system");
      assertTrue((audit[0]?.notes ?? "").includes("homepage_verified_live"), "uw-16: audit notes carry the caller's reason");

      // ── (d) clearing stores "" — agents.url is TEXT NOT NULL ────────────
      r = await post(SET("uw-platform", null, "platform_site_not_producer_homepage"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "written", "uw-17: clearing a platform-host url is written");
      assertEq(urlOf("uw-platform"), "", "uw-18: cleared url stored as \"\" (NOT NULL column), never NULL");
      assertEq(auditFor("uw-platform")[0]?.old_value, "https://rettfrabonden.com/agent/solvang", "uw-19: clear is reversible from the audit row");

      // ── (e) claimed_at row lock ─────────────────────────────────────────
      r = await post(SET("uw-claimed", "https://www.ergagardsutsalg.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "uw-20: claimed_at row skipped");
      assertEq(urlOf("uw-claimed"), "https://www.hanen.no/bedrift/686", "uw-21: claimed row untouched");
      assertEq(auditFor("uw-claimed").length, 0, "uw-22: claimed row wrote no audit");

      // ── (f) THE GAP: verified agent_claims locks; pending does not ──────
      r = await post(SET("uw-verified-claim", "https://www.farmorsmarked.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "uw-23: verified agent_claims row locks even with claimed_at NULL");
      assertEq(urlOf("uw-verified-claim"), "https://www.facebook.com/verifisert", "uw-24: owner-verified row untouched");
      assertEq(auditFor("uw-verified-claim").length, 0, "uw-25: owner-verified row wrote no audit");

      r = await post(SET("uw-pending-claim", "https://www.pendinggard.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "written", "uw-26: a non-verified claim does NOT lock the row");
      assertEq(urlOf("uw-pending-claim"), "https://www.pendinggard.no", "uw-27: pending-claim row written");

      // ── (g) curated per-field lock, BOTH spellings ──────────────────────
      r = await post(SET("uw-curated-website", "https://www.ny.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "skipped_curated", "uw-28: curated 'website' skipped");
      assertEq(urlOf("uw-curated-website"), "https://www.hanen.no/bedrift/1", "uw-29: curated 'website' untouched");
      r = await post(SET("uw-curated-url", "https://www.ny.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "skipped_curated", "uw-30: curated 'url' skipped");

      // ── (h) directory hosts rejected by default, opt-in allows ──────────
      r = await post(SET("uw-real", "https://www.hanen.no/bedrift/999"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_directory_host", "uw-31: directory host refused by default");
      assertEq(urlOf("uw-real"), "https://www.ergagardsutsalg.no", "uw-32: real homepage untouched by the refusal");
      r = await post(SET("uw-real", "https://www.facebook.com/gardenmin"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_directory_host", "uw-33: social host counts as a directory host");
      r = await post(
        { items: [{ agent_id: "uw-empty", url: "https://www.bondensmarkedtroms.no/x", reason: "eneste_reelle_tilstedevaerelse" }], allow_directory_host: true },
        testKey,
        APPLY,
      );
      assertEq(r.body?.results?.[0]?.outcome, "written", "uw-34: allow_directory_host: true is an explicit escape hatch");
      assertEq(urlOf("uw-empty"), "https://www.bondensmarkedtroms.no/x", "uw-35: ...and actually writes");

      // ── (i) platform hosts refused in both directions ───────────────────
      r = await post(SET("uw-real", "https://rettfrabonden.com/agent/x"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_platform_host", "uw-36: our own site refused as a producer homepage");
      r = await post(SET("uw-real", "https://lokal.fly.dev/agent/x"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_platform_host", "uw-37: *.fly.dev refused too");

      // ── (j) shape validation / reason / empty string ────────────────────
      r = await post(SET("uw-real", "ikke-en-url"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_url", "uw-38: bare string without scheme rejected");
      r = await post(SET("uw-real", "ftp://gard.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_url", "uw-39: non-http(s) scheme rejected");
      r = await post(SET("uw-real", "https://localhost"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_url", "uw-40: host without a dot rejected");
      r = await post({ items: [{ agent_id: "uw-real", url: null }] }, testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_missing_reason", "uw-41: clearing still requires a reason");
      r = await post({ items: [{ agent_id: "uw-real", url: "", reason: "r" }] }, testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "uw-42: empty string is not a clear instruction");
      r = await post({ items: [{ agent_id: "uw-real", reason: "r" }] }, testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "uw-43: missing url is malformed, never an inferred clear");
      assertEq(urlOf("uw-real"), "https://www.ergagardsutsalg.no", "uw-44: negative controls left the real homepage intact");

      // ── (k) idempotence, LEFT JOIN, batch hygiene ───────────────────────
      r = await post(SET("uw-directory", "https://www.akerhaugengard.no"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "skipped_unchanged", "uw-45: re-writing the same value reports unchanged");
      assertEq(auditFor("uw-directory").length, 1, "uw-46: idempotent re-apply adds no second audit row");

      r = await post(SET("uw-no-knowledge", null, "directory_host_not_own_homepage"), testKey, APPLY);
      assertEq(r.body?.results?.[0]?.outcome, "written", "uw-47: row without agent_knowledge is still writable (LEFT JOIN)");
      assertEq(urlOf("uw-no-knowledge"), "", "uw-48: ...and actually cleared");

      r = await post(
        {
          items: [
            { agent_id: "does-not-exist", url: null, reason: "cleanup" },
            { agent_id: "uw-curated-website", url: "https://www.x.no", reason: "cleanup" },
          ],
        },
        testKey,
        APPLY,
      );
      assertEq(r.body?.results?.[0]?.outcome, "not_found", "uw-49: unknown id reported, not fatal");
      assertEq(r.body?.results?.[1]?.outcome, "skipped_curated", "uw-50: rest of the batch still processed");

      r = await post(
        {
          items: [
            { agent_id: "uw-real", url: null, reason: "cleanup" },
            { agent_id: "uw-real", url: "https://www.annen.no", reason: "cleanup" },
          ],
        },
        testKey,
        APPLY,
      );
      assertEq(r.body?.results?.[1]?.outcome, "rejected_invalid_item", "uw-51: duplicate agent_id in one request rejected");

      const tooMany = Array.from({ length: routeMod.URL_WRITE_MAX_ITEMS + 1 }, (_v, i) => ({
        agent_id: `bulk-${i}`,
        url: null,
        reason: "r",
      }));
      r = await post({ items: tooMany }, testKey, APPLY);
      assertEq(r.status, 400, "uw-52: oversized batch -> 400");
      r = await post({ items: [] });
      assertEq(r.status, 400, "uw-53: empty items -> 400");
      r = await post({});
      assertEq(r.status, 400, "uw-54: missing items -> 400");

      // ── (l) pure helpers ────────────────────────────────────────────────
      assertEq(routeMod.hostOf("https://WWW.Gard.NO/side?x=1"), "gard.no", "uw-55: hostOf lowercases and strips www/path");
      assertEq(routeMod.hostOf("https://gard.no:8443/"), "gard.no", "uw-56: hostOf strips an explicit port");
      assertEq(routeMod.hostOf("bare-tekst"), "", "uw-57: hostOf returns \"\" for an unparseable value");
      assertEq(routeMod.isPlatformOwnedHost("https://www.rettfrabonden.com"), true, "uw-58: platform host detected through www");
      assertEq(routeMod.isPlatformOwnedHost("https://rettfrabonden.no"), false, "uw-59: .no lookalike is NOT platform-owned");
      assertEq(routeMod.isDirectoryHost("https://m.facebook.com/gard"), true, "uw-60: directory match covers subdomains");
      assertEq(routeMod.isDirectoryHost("https://minhanen.no"), false, "uw-61: a domain merely CONTAINING a directory name is not one");
      assertEq(routeMod.isUsableHomepageUrl("https://gard.no"), true, "uw-62: plain https url accepted");
      assertEq(routeMod.isUsableHomepageUrl("https://gard.no/med mellomrom"), false, "uw-63: whitespace in the url rejected");
      assertEq(routeMod.isUrlCurated("not json"), false, "uw-64: malformed curated JSON treated as unlocked");
      assertEq(routeMod.hostOf("https://evil.com@rettfrabonden.com/"), "rettfrabonden.com", "uw-65: hostOf strips userinfo before the real host");
      assertEq(routeMod.hostOf("https://user:pass@facebook.com/x"), "facebook.com", "uw-66: hostOf strips user:pass userinfo too");
      assertEq(routeMod.isPlatformOwnedHost("https://evil.com@rettfrabonden.com/"), true, "uw-67: userinfo can no longer smuggle a platform host past the guard");
      assertEq(routeMod.isDirectoryHost("https://x@facebook.com/"), true, "uw-68: userinfo can no longer smuggle a directory host past the guard");
    } finally {
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
      try {
        const routeMod = require("./admin-agents-url-write");
        routeMod.__setUrlWriteDbForTesting(null);
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

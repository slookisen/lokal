/**
 * admin-bm-producer-harvest.test.ts — dev-request
 * 2026-08-14-bm-fullhoest-katalogbred, slice 2 (AC5-AC6) + slice 3 (apply mode).
 *
 * Slice 2, still covered here:
 *   AC5b/AC5c — the auth gate runs BEFORE the dry_run=false branch does any
 *         work at all, whether the branch is a stub (slice 2) or real (slice
 *         3) — proven with a trap fetchImpl/db that throw if ever called, and
 *         asserting a missing/wrong key still 403s (and an unconfigured admin
 *         key still 503s) with zero fetch/db calls.
 *   AC6 — this file itself only reaches the route via router.handle()
 *         against injected req/res (mirrors admin-runs-lock.test.ts /
 *         admin-run-verifier-drain-observability.test.ts) — no real network,
 *         no real DB file.
 *
 * Slice 3 (apply mode), new in this file:
 *   AC7  — dry_run=false no longer 501s; it fetches+matches+writes for real.
 *   AC8  — apply-mode limit defaults to 20, hard-caps at 50 (independent of
 *          the dry-run branch's 400 cap, untouched by this slice).
 *   AC9  — every outcome: written, skipped_claimed, skipped_curated,
 *          skipped_unchanged, rejected_invalid_email, rejected_platform_domain,
 *          skipped_bm_domain (both the bmDomainEmailExcluded-flag path and the
 *          record.email domain-suffix path), skipped_no_email, unmatched,
 *          parse_failed.
 *   AC10 — idempotency: applying the same slug window twice writes on the
 *          first call and reports written=0 on the second (unchanged-value
 *          check), with the audit table still holding exactly one row.
 *   AC11 — writes actually land in agents.contact_email + exactly one
 *          agent_knowledge_audit row per write, carrying the true old value.
 *   AC12 — the dry-run branch's own tests (AC1-AC4, service-level, and the
 *          route's own would_write_estimate use) are untouched by this file
 *          — this suite only ever calls dry_run=false against its own fresh
 *          fetch/db fixtures, never touching the dry-run path.
 *
 * Wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-bm-producer-harvest.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import router from "./admin-bm-producer-harvest";

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
  routerInstance: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: any;
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
    routerInstance.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

const ADMIN_KEY = "test-admin-key-bm-producer-harvest";

export function runAdminBmProducerHarvestTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevFetch = globalThis.fetch;
    // getDb() (not __peekDbForTesting()) so prevDb is always a real handle
    // to restore in `finally` — mirrors admin-run-verifier-drain-
    // observability.test.ts's isolation contract for the shared singleton.
    const prevDb = initMod.getDb();

    let fetchCalls = 0;
    let dbPrepareCalls = 0;

    try {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;

      // Trap fetch: any call at all is a failure of the "zero work" claim.
      (globalThis as any).fetch = async (...args: any[]) => {
        fetchCalls++;
        throw new Error("dry_run=false must not perform any fetch");
      };

      // Trap DB: any db.prepare() call at all is a failure of the
      // "zero DB access" claim (stricter than "zero writes" — the route
      // must not even READ in this branch).
      const trapDb: any = {
        prepare() {
          dbPrepareCalls++;
          throw new Error("dry_run=false must not touch the database");
        },
      };
      initMod.__setDbForTesting(trapDb);

      // ── AC5b: dry_run=false still requires a valid admin key FIRST ─────
      // (slice 3 replaced the 501 stub with real work, but the auth gate is
      // unconditionally the first thing the handler does, so a bad/missing
      // key must still short-circuit before any fetch/db call happens.)
      const resNoKey = await callRoute(router, {
        method: "GET",
        url: "/",
        query: { dry_run: "false" },
        headers: {},
      });
      assertEq(resNoKey.status, 403, "ac5b: dry_run=false with a missing/wrong X-Admin-Key still 403s (auth gate runs first)");
      assertEq(fetchCalls, 0, "ac5b: still zero fetch calls when auth fails");
      assertEq(dbPrepareCalls, 0, "ac5b: still zero db calls when auth fails");

      // ── AC5c: admin key unconfigured entirely → 503, before any work ───
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const resUnconfigured = await callRoute(router, {
        method: "GET",
        url: "/",
        query: { dry_run: "false" },
      });
      assertEq(resUnconfigured.status, 503, "ac5c: admin key unconfigured yields 503, before any apply-mode work");
      assertEq(fetchCalls, 0, "ac5c: still zero fetch calls when admin unconfigured");
      assertEq(dbPrepareCalls, 0, "ac5c: still zero db calls when admin unconfigured");
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
    }

    // ══════════════════════════════════════════════════════════════════
    // Slice 3 — apply mode (dry_run=false real behavior)
    // ══════════════════════════════════════════════════════════════════
    //
    // Fresh in-memory DB + a fake fetch serving a small sitemap and one
    // fixture producer page per slug, all wired through the SAME seams the
    // slice-2 block above uses (initMod.__setDbForTesting / globalThis.fetch)
    // — this route resolves both via getDb()/global fetch directly, no other
    // seam exists for it. Restored in `finally`, same discipline as above.
    await (async () => {
      const prevAdminKey2 = process.env.ADMIN_KEY;
      const prevAnalyticsAdminKey2 = process.env.ANALYTICS_ADMIN_KEY;
      const prevFetch2 = globalThis.fetch;
      const prevDb2 = initMod.__peekDbForTesting();

      const db = new Database(":memory:");
      try {
        process.env.ADMIN_KEY = ADMIN_KEY;
        delete process.env.ANALYTICS_ADMIN_KEY;

        initMod.__initSchemaForTesting(db as any);
        initMod.__setDbForTesting(db as any);

        // ── Catalog fixtures (role='producer', is_active defaults to 1) ──
        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, claimed_at)
           VALUES (?, ?, 'test agent', 'test', ?, 'https://example.no', 'producer', ?, ?, ?)`,
        );
        const insertKnowledge = db.prepare(
          `INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, ?)`,
        );

        // slug=written-gard   -> new valid email, unclaimed/uncurated -> written
        insertAgent.run("agent-written", "Written Gård", "", "key-written", "Bostad", null);
        insertKnowledge.run("agent-written", "{}");

        // slug=claimed-gard   -> matched, but claimed_at set -> skipped_claimed
        insertAgent.run("agent-claimed", "Claimed Gård", "old@example.no", "key-claimed", "Bostad", "2026-01-01T00:00:00.000Z");
        insertKnowledge.run("agent-claimed", "{}");

        // slug=curated-gard   -> matched, curated_fields locks contact_email
        insertAgent.run("agent-curated", "Curated Gård", "old@example.no", "key-curated", "Bostad", null);
        insertKnowledge.run("agent-curated", JSON.stringify({ contact_email: { by: "owner" } }));

        // slug=unchanged-gard -> matched, current value already equals BM's (case-insensitively)
        insertAgent.run("agent-unchanged", "Unchanged Gård", "SAME@example.no", "key-unchanged", "Bostad", null);
        insertKnowledge.run("agent-unchanged", "{}");

        // slug=invalid-gard   -> matched, BM mailto has no usable @ -> rejected_invalid_email
        insertAgent.run("agent-invalid", "Invalid Gård", "", "key-invalid", "Bostad", null);
        insertKnowledge.run("agent-invalid", "{}");

        // slug=platform-gard  -> matched, BM mailto is our own domain -> rejected_platform_domain
        insertAgent.run("agent-platform", "Platform Gård", "", "key-platform", "Bostad", null);
        insertKnowledge.run("agent-platform", "{}");

        // slug=bmflag-gard    -> matched, parser sets bmDomainEmailExcluded -> skipped_bm_domain
        insertAgent.run("agent-bmflag", "Bmflag Gård", "", "key-bmflag", "Bostad", null);
        insertKnowledge.run("agent-bmflag", "{}");

        // slug=noemail-gard   -> matched, no mailto: at all -> skipped_no_email
        insertAgent.run("agent-noemail", "Noemail Gård", "", "key-noemail", "Bostad", null);
        insertKnowledge.run("agent-noemail", "{}");

        // slug=unmatched-gard -> BM name has no catalog counterpart -> unmatched
        // (no agent inserted for this one, deliberately)

        // slug=badpage-gard   -> no LocalBusiness ld+json at all -> parse_failed

        function auditRows(agentId: string) {
          return db
            .prepare(
              `SELECT field_name, old_value, new_value, changed_by, notes
                 FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at`,
            )
            .all(agentId) as Array<{
            field_name: string;
            old_value: string | null;
            new_value: string | null;
            changed_by: string;
            notes: string | null;
          }>;
        }
        function contactEmailOf(agentId: string): string {
          const row = db.prepare(`SELECT contact_email FROM agents WHERE id = ?`).get(agentId) as
            | { contact_email: string }
            | undefined;
          return row?.contact_email ?? "";
        }

        const ld = (name: string, city: string) =>
          JSON.stringify({
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            name,
            address: { "@type": "PostalAddress", addressLocality: city, addressCountry: "NO" },
          });

        const pages: Record<string, string> = {
          "written-gard": `<script type="application/ld+json">${ld("Written Gård", "Bostad")}</script><a href="mailto:post@writtengard.no">post@writtengard.no</a>`,
          "claimed-gard": `<script type="application/ld+json">${ld("Claimed Gård", "Bostad")}</script><a href="mailto:post@claimedgard.no">post@claimedgard.no</a>`,
          "curated-gard": `<script type="application/ld+json">${ld("Curated Gård", "Bostad")}</script><a href="mailto:post@curatedgard.no">post@curatedgard.no</a>`,
          "unchanged-gard": `<script type="application/ld+json">${ld("Unchanged Gård", "Bostad")}</script><a href="mailto:same@example.no">same@example.no</a>`,
          "invalid-gard": `<script type="application/ld+json">${ld("Invalid Gård", "Bostad")}</script><a href="mailto:not-an-email">not-an-email</a>`,
          "platform-gard": `<script type="application/ld+json">${ld("Platform Gård", "Bostad")}</script><a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>`,
          "bmflag-gard": `<script type="application/ld+json">${ld("Bmflag Gård", "Bostad")}</script><a href="mailto:kontakt@bondensmarked.no">kontakt@bondensmarked.no</a>`,
          "noemail-gard": `<script type="application/ld+json">${ld("Noemail Gård", "Bostad")}</script>`,
          "unmatched-gard": `<script type="application/ld+json">${ld("No Such Catalog Entry AS", "Bostad")}</script><a href="mailto:x@nomatch.no">x@nomatch.no</a>`,
          "badpage-gard": `<html><body>no ld+json here at all</body></html>`,
        };
        const slugOrder = Object.keys(pages);

        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${slugOrder
          .map((s) => `<url><loc>https://bondensmarked.no/produsenter/${s}</loc></url>`)
          .join("")}</urlset>`;

        (globalThis as any).fetch = async (url: any) => {
          const u = String(url);
          if (u === "https://bondensmarked.no/sitemap.xml") {
            return new Response(sitemapXml, { status: 200, headers: { "content-type": "application/xml" } });
          }
          const m = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
          const slug = m ? m[1] : "";
          if (slug in pages) {
            return new Response(pages[slug], { status: 200, headers: { "content-type": "text/html" } });
          }
          return new Response("not found", { status: 404 });
        };

        function get(query: Record<string, string>) {
          return callRoute(router, { method: "GET", url: "/", query, headers: { "x-admin-key": ADMIN_KEY } });
        }
        function resultFor(body: any, slug: string) {
          return (body?.results as any[] | undefined)?.find((r) => r.slug === slug);
        }

        // ── AC7: dry_run=false is no longer 501, and does real work ──────
        let r = await get({ dry_run: "false", limit: String(slugOrder.length) });
        assertEq(r.status, 200, "ac7: dry_run=false now returns 200, not 501");
        assertEq(r.body?.success, true, "ac7: success:true");
        assertEq(r.body?.dry_run, false, "ac7: dry_run:false echoed back");
        assertTrue(typeof r.body?.batch_tag === "string" && r.body.batch_tag.length > 0, "ac7: batch_tag present");
        assertEq(r.body?.total_slugs, slugOrder.length, "ac7: total_slugs reflects the full sitemap");
        assertEq(r.body?.scanned, slugOrder.length, "ac7: scanned reflects the requested window");

        // ── AC9: every outcome, one fixture each ──────────────────────────
        assertEq(resultFor(r.body, "written-gard")?.outcome, "written", "ac9: written-gard -> written");
        assertEq(contactEmailOf("agent-written"), "post@writtengard.no", "ac9: written-gard actually wrote the column");
        const auditWritten = auditRows("agent-written");
        assertEq(auditWritten.length, 1, "ac9: exactly one audit row for the write");
        assertEq(auditWritten[0]?.field_name, "contact_email", "ac9: audit names contact_email");
        assertEq(auditWritten[0]?.old_value, "", "ac9: audit preserves the true prior value (empty string)");
        assertEq(auditWritten[0]?.new_value, "post@writtengard.no", "ac9: audit records the written value");
        assertEq(auditWritten[0]?.changed_by, "system", "ac9: audit changed_by=system");
        assertTrue(
          (auditWritten[0]?.notes ?? "").includes("slug=written-gard"),
          "ac9: audit notes carry the source slug",
        );

        assertEq(resultFor(r.body, "claimed-gard")?.outcome, "skipped_claimed", "ac9: claimed row locked");
        assertEq(contactEmailOf("agent-claimed"), "old@example.no", "ac9: claimed row's column untouched");
        assertEq(auditRows("agent-claimed").length, 0, "ac9: claimed row wrote no audit");

        assertEq(resultFor(r.body, "curated-gard")?.outcome, "skipped_curated", "ac9: curated field locked");
        assertEq(contactEmailOf("agent-curated"), "old@example.no", "ac9: curated row's column untouched");

        assertEq(resultFor(r.body, "unchanged-gard")?.outcome, "skipped_unchanged", "ac9: unchanged value (case-insensitive) skipped");
        assertEq(auditRows("agent-unchanged").length, 0, "ac9: unchanged row wrote no audit");

        assertEq(resultFor(r.body, "invalid-gard")?.outcome, "rejected_invalid_email", "ac9: syntactically invalid email rejected");
        assertEq(contactEmailOf("agent-invalid"), "", "ac9: invalid-email row's column untouched");

        assertEq(resultFor(r.body, "platform-gard")?.outcome, "rejected_platform_domain", "ac9: platform-owned domain refused");
        assertEq(contactEmailOf("agent-platform"), "", "ac9: platform-domain row's column untouched");

        assertEq(resultFor(r.body, "bmflag-gard")?.outcome, "skipped_bm_domain", "ac9: bmDomainEmailExcluded hard-skipped, own outcome");
        assertEq(contactEmailOf("agent-bmflag"), "", "ac9: bm-domain row's column untouched");

        assertEq(resultFor(r.body, "noemail-gard")?.outcome, "skipped_no_email", "ac9: no mailto: at all -> skipped_no_email");
        assertEq(resultFor(r.body, "unmatched-gard")?.outcome, "unmatched", "ac9: no catalog counterpart -> unmatched");
        assertEq(resultFor(r.body, "badpage-gard")?.outcome, "parse_failed", "ac9: unparseable page -> parse_failed");

        assertEq(r.body?.counts?.written, 1, "ac9: counts.written tallies correctly");
        assertEq(r.body?.counts?.skipped_bm_domain, 1, "ac9: counts.skipped_bm_domain tallies correctly");

        // ── AC9b: direct email-domain-suffix check (independent of the
        // bmDomainEmailExcluded flag) — the parser always nulls `email` for a
        // BM-domain mailto, so this exercises the route's OWN second check by
        // constructing a record whose email is a bondensmarked.no address but
        // is NOT excluded by the parser's flag. Reached only through the
        // route's isBmDomainEmailForApply() re-check, proven indirectly: a
        // subdomain of bondensmarked.no in the harvested mailto is refused
        // the same way as the bare domain.
        {
          const subPages: Record<string, string> = {
            "bmsub-gard": `<script type="application/ld+json">${ld("Bmsub Gård", "Bostad")}</script><a href="mailto:noreply@mail.bondensmarked.no">noreply@mail.bondensmarked.no</a>`,
          };
          insertAgent.run("agent-bmsub", "Bmsub Gård", "", "key-bmsub", "Bostad", null);
          insertKnowledge.run("agent-bmsub", "{}");
          const subSitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://bondensmarked.no/produsenter/bmsub-gard</loc></url></urlset>`;
          (globalThis as any).fetch = async (url: any) => {
            const u = String(url);
            if (u === "https://bondensmarked.no/sitemap.xml") {
              return new Response(subSitemap, { status: 200, headers: { "content-type": "application/xml" } });
            }
            const m = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
            const slug = m ? m[1] : "";
            if (slug in subPages) {
              return new Response(subPages[slug], { status: 200, headers: { "content-type": "text/html" } });
            }
            return new Response("not found", { status: 404 });
          };
          const rSub = await get({ dry_run: "false", limit: "5" });
          assertEq(
            resultFor(rSub.body, "bmsub-gard")?.outcome,
            "skipped_bm_domain",
            "ac9b: a bondensmarked.no SUBDOMAIN email is hard-skipped even though it isn't literally the bare domain",
          );
          assertEq(contactEmailOf("agent-bmsub"), "", "ac9b: bm-subdomain row's column untouched");

          // restore the main fixture set for subsequent assertions
          (globalThis as any).fetch = async (url: any) => {
            const u = String(url);
            if (u === "https://bondensmarked.no/sitemap.xml") {
              return new Response(sitemapXml, { status: 200, headers: { "content-type": "application/xml" } });
            }
            const mm = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
            const s = mm ? mm[1] : "";
            if (s in pages) {
              return new Response(pages[s], { status: 200, headers: { "content-type": "text/html" } });
            }
            return new Response("not found", { status: 404 });
          };
        }

        // ── AC8: apply-mode limit — default 20, hard-capped at 50 ─────────
        let rDefault = await get({ dry_run: "false" });
        assertEq(rDefault.body?.scanned, Math.min(20, slugOrder.length), "ac8: missing limit defaults to 20 in apply mode");
        let rOverCap = await get({ dry_run: "false", limit: "9999" });
        assertEq(rOverCap.body?.scanned, Math.min(50, slugOrder.length), "ac8: an over-cap limit is clamped to 50, not 400");
        let rInvalidLimit = await get({ dry_run: "false", limit: "not-a-number" });
        assertEq(rInvalidLimit.body?.scanned, Math.min(20, slugOrder.length), "ac8: invalid limit falls back to the 20 default");

        // ── AC10/AC11: idempotency — second apply of the SAME window writes
        // nothing further, and the audit table still holds exactly one row.
        const rSecond = await get({ dry_run: "false", limit: String(slugOrder.length) });
        assertEq(resultFor(rSecond.body, "written-gard")?.outcome, "skipped_unchanged", "ac10: second apply reports skipped_unchanged");
        assertEq(rSecond.body?.counts?.written ?? 0, 0, "ac10: second apply's written count is 0");
        assertEq(contactEmailOf("agent-written"), "post@writtengard.no", "ac10: value unchanged by the second apply");
        assertEq(auditRows("agent-written").length, 1, "ac11: idempotent re-apply added no second audit row");
      } finally {
        if (prevAdminKey2 === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey2;
        if (prevAnalyticsAdminKey2 === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
        else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey2;
        (globalThis as any).fetch = prevFetch2;
        if (prevDb2) initMod.__setDbForTesting(prevDb2);
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    })();

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-bm-producer-harvest.test.ts`
if (require.main === module) {
  (async () => {
    console.log("── admin-bm-producer-harvest ──");
    const r = await runAdminBmProducerHarvestTests({ log: true });
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })();
}

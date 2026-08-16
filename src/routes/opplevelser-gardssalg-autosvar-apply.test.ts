/**
 * opplevelser-gardssalg-autosvar-apply.test.ts — tests for the write-side
 * wiring of the autosvar-redirect flow (dev-request 2026-08-16-opplevagent-
 * outreach-rutine, slookisen/A2A, spec point 6 "Autosvar-regelen"):
 *
 *   - POST /admin/gardssalg-autosvar-apply           (src/routes/opplevelser.ts)
 *   - POST /admin/gardssalg-autosvar-review-approve   (src/routes/opplevelser.ts)
 *   - gardssalg_autosvar_review_queue                 (src/database/init-experiences.ts)
 *
 * GET /admin/gardssalg-autosvar-scan (opplevelser-gardssalg-autosvar-scan.
 * test.ts) only DETECTS candidates — this suite covers the missing write-side
 * lever: domain_match auto-applies (idempotently); domain_mismatch and
 * no_website_on_file NEVER write epost directly ("Ved domene-avvik: legg i
 * review-kø, aldri auto-bytt") and instead land in
 * gardssalg_autosvar_review_queue for a human to resolve via
 * POST /admin/gardssalg-autosvar-review-approve (force:true).
 *
 * Harness copied verbatim from opplevelser-gardssalg-autosvar-scan.test.ts
 * (fresh in-memory EXPERIENCES db via db-factory, fresh in-memory RFB db
 * injected via database/init's __setDbForTesting/__initSchemaForTesting),
 * extended with a POST-capable callRoute and gardssalg_autosvar_review_queue
 * fixture readers.
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403 (both new routes)
 *   (b) dry-run (apply unset): domain_match -> would_apply, domain_mismatch/
 *       no_website_on_file -> would_queue, and ZERO writes anywhere (no epost
 *       change, no queue row, no audit row)
 *   (c) apply=true: domain_match candidate is auto-applied (epost written,
 *       audit row inserted); domain_mismatch/no_website_on_file candidates
 *       are NEVER written to epost — instead upserted into
 *       gardssalg_autosvar_review_queue
 *   (d) idempotency: a second apply=true run reports the already-applied
 *       domain_match candidate as already_set (no re-write, audit count
 *       stays at 1) and re-upserts (not duplicates) the queue rows
 *       (UNIQUE(provider_id) — row count stays 1 per provider)
 *   (e) gardssalg-autosvar-review-approve: rejects a provider_id that is NOT
 *       in the review queue (not_in_review_queue)
 *   (f) gardssalg-autosvar-review-approve dry-run: reports what would be
 *       approved, writes nothing, queue row still present
 *   (g) gardssalg-autosvar-review-approve apply=true: force-applies the
 *       queued domain-mismatch candidate_email (bypassing the domain guard,
 *       force:true is correct here because a human just approved it),
 *       clears the queue row, writes exactly one audit row
 *
 * Exported runOpplevelserGardssalgAutosvarApplyTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-autosvar-apply.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url: string;
    query?: Record<string, string>;
    body?: any;
    headers?: Record<string, string>;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const query = opts.query || {};
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = opts.url + (qs ? `?${qs}` : "");
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: opts.url,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgAutosvarApplyTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-autosvar-apply-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    // NOTE: unlike opplevelser-gardssalg-autosvar-scan.test.ts (which reads
    // gardssalg-autosvar-scan's data ONLY via opplevelser.ts's own direct
    // getExpDb/getRfbDb bindings, never through experience-store), this suite
    // exercises applyGardssalgSetContactEmail / upsertGardssalgAutosvar-
    // ReviewQueue / etc., all defined in ../services/experience-store. That
    // module must be cache-cleared here too (same as opplevelser-gardssalg-
    // set-contact-email.test.ts's convention) — otherwise a STALE
    // experience-store cached by an earlier-run suite in the same process
    // stays bound to ITS OLD db-factory module instance (a different,
    // disconnected :memory: handle than the fresh one this test's dbFactory
    // require creates), and every experience-store write in this suite would
    // silently operate against that unrelated db instead of the one this
    // test's fixtures/route calls populate — surfacing as a `FOREIGN KEY
    // constraint failed` the moment a provider_id genuinely present in THIS
    // test's db is looked up in that other, empty one.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        /* already loaded by an earlier suite in the same process */
      }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fixture helpers (copied from opplevelser-gardssalg-autosvar-scan.test.ts) ──
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, hjemmeside, epost, created_at)
         VALUES (@id, @navn, 'experiences', @hjemmeside, @epost, @created_at)`,
      );
      function mkProvider(p: { id: string; navn: string; hjemmeside?: string | null; epost?: string | null }): void {
        insertProvider.run({
          hjemmeside: null,
          epost: null,
          created_at: "2026-01-01 00:00:00",
          ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb
          .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`)
          .all(providerId);
      }
      function getQueueRow(providerId: string): any {
        return expDb.prepare(`SELECT * FROM gardssalg_autosvar_review_queue WHERE provider_id = ?`).get(providerId);
      }
      function countQueueRows(providerId: string): number {
        return (
          expDb
            .prepare(`SELECT COUNT(*) AS n FROM gardssalg_autosvar_review_queue WHERE provider_id = ?`)
            .get(providerId) as any
        ).n;
      }

      let contactIdSeq = 0;
      function mkInboundMessage(o: {
        providerId: string | null;
        contactEmail: string;
        bodyText?: string | null;
        bodyHtml?: string | null;
        sentAt?: string | null;
      }): { threadId: string; messageId: string } {
        contactIdSeq++;
        const contactId = `cid-${contactIdSeq}`;
        const threadId = `tid-${contactIdSeq}`;
        const msgId = `mid-${contactIdSeq}`;
        const vertical = o.providerId ? "experiences" : "rfb";
        rfbDb
          .prepare(
            `INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
             VALUES (?, 'producer', NULL, ?, ?, 'Test Contact', 'active', ?)`,
          )
          .run(contactId, o.providerId, o.contactEmail, vertical);
        rfbDb
          .prepare(
            `INSERT INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
             VALUES (?, ?, 'Re: outreach', 'new', 'innkommende', ?)`,
          )
          .run(threadId, contactId, vertical);
        rfbDb
          .prepare(
            `INSERT INTO crm_messages
               (id, thread_id, direction, from_email, to_emails, subject, body_text, body_html, sent_at, delivery_status, vertical_id)
             VALUES (?, ?, 'in', ?, '["outreach@opplevagent.no"]', 'Re: outreach', ?, ?, ?, 'sent', ?)`,
          )
          .run(msgId, threadId, o.contactEmail, o.bodyText ?? null, o.bodyHtml ?? null, o.sentAt ?? null, vertical);
        return { threadId, messageId: msgId };
      }

      const auth = { "x-admin-key": testKey };

      // ── (a) auth on both new routes ──────────────────────────────────────
      const unauthApply = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-autosvar-apply", body: {} });
      assertEq(unauthApply.status, 403, "a1: unauthenticated apply -> 403");
      const unauthApprove = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-autosvar-review-approve",
        body: { provider_ids: ["whatever"] },
      });
      assertEq(unauthApprove.status, 403, "a2: unauthenticated approve -> 403");

      // ── Fixtures ────────────────────────────────────────────────────────
      mkProvider({ id: "aa-match", navn: "Monkey Brew Gård", hjemmeside: "https://monkeybrew.no", epost: "frank@monkeybrew.no" });
      mkInboundMessage({
        providerId: "aa-match",
        contactEmail: "frank@monkeybrew.no",
        bodyText: "Hei, Frank har sluttet. For henvendelser ber jeg deg ta kontakt med jorg@monkeybrew.no fremover. Mvh",
        sentAt: "2026-08-01 09:00:00",
      });

      mkProvider({ id: "aa-mismatch", navn: "Anna Cider Gård", hjemmeside: "https://annacider.no", epost: "post@annacider.no" });
      mkInboundMessage({
        providerId: "aa-mismatch",
        contactEmail: "post@annacider.no",
        bodyText: "Vennligst henvend deg til ny-kontakt@et-helt-annet-domene.no i stedet.",
        sentAt: "2026-08-02 09:00:00",
      });

      mkProvider({ id: "aa-nowebsite", navn: "Ukjent Nettside Gård", hjemmeside: null, epost: "post@ukjentgard.no" });
      mkInboundMessage({
        providerId: "aa-nowebsite",
        contactEmail: "post@ukjentgard.no",
        bodyText: "Kontakt oss på ny-post@ukjentgard-erstatning.no fremover, takk.",
        sentAt: "2026-08-03 09:00:00",
      });

      // ── (b) dry-run: apply unset -> report only, ZERO writes ──────────────
      const dryRes = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-autosvar-apply", headers: auth, body: {} });
      assertEq(dryRes.status, 200, "b1: dry-run apply -> 200");
      assertEq(dryRes.body.dry_run, true, "b2: dry_run:true when apply is unset");
      const dryMatch = (dryRes.body.results as any[]).find((r) => r.provider_id === "aa-match");
      const dryMismatch = (dryRes.body.results as any[]).find((r) => r.provider_id === "aa-mismatch");
      const dryNoWebsite = (dryRes.body.results as any[]).find((r) => r.provider_id === "aa-nowebsite");
      assertEq(dryMatch?.outcome, "would_apply", "b3: dry-run domain_match candidate -> would_apply");
      assertEq(dryMismatch?.outcome, "would_queue", "b4: dry-run domain_mismatch candidate -> would_queue");
      assertEq(dryNoWebsite?.outcome, "would_queue", "b5: dry-run no_website_on_file candidate -> would_queue");
      assertEq(getProviderRow("aa-match").epost, "frank@monkeybrew.no", "b6: dry-run wrote NOTHING to aa-match's epost");
      assertEq(getProviderRow("aa-mismatch").epost, "post@annacider.no", "b7: dry-run wrote NOTHING to aa-mismatch's epost");
      assertEq(getProviderRow("aa-nowebsite").epost, "post@ukjentgard.no", "b8: dry-run wrote NOTHING to aa-nowebsite's epost");
      assertEq(getQueueRow("aa-mismatch"), undefined, "b9: dry-run created NO review-queue row for aa-mismatch");
      assertEq(getQueueRow("aa-nowebsite"), undefined, "b10: dry-run created NO review-queue row for aa-nowebsite");
      assertEq(getAuditRows("aa-match").length, 0, "b11: dry-run created NO audit row");

      // ── (c) apply=true: domain_match auto-applies; mismatch/no_website queue ──
      const applyRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-autosvar-apply",
        query: { apply: "true" },
        headers: auth,
        body: {},
      });
      assertEq(applyRes.status, 200, "c1: apply=true -> 200");
      assertEq(applyRes.body.dry_run, false, "c2: dry_run:false when apply=true");
      const applyMatch = (applyRes.body.results as any[]).find((r) => r.provider_id === "aa-match");
      const applyMismatch = (applyRes.body.results as any[]).find((r) => r.provider_id === "aa-mismatch");
      const applyNoWebsite = (applyRes.body.results as any[]).find((r) => r.provider_id === "aa-nowebsite");
      assertEq(applyMatch?.outcome, "applied", "c3: domain_match candidate -> applied");
      assertEq(applyMismatch?.outcome, "queued", "c4: domain_mismatch candidate -> queued (never applied directly)");
      assertEq(applyNoWebsite?.outcome, "queued", "c5: no_website_on_file candidate -> queued (never applied directly)");

      assertEq(getProviderRow("aa-match").epost, "jorg@monkeybrew.no", "c6: aa-match's epost WAS auto-applied to the candidate email");
      const matchAudit = getAuditRows("aa-match");
      assertEq(matchAudit.length, 1, "c7: exactly one audit row for the auto-applied write");
      assertEq(matchAudit[0].new_value, "jorg@monkeybrew.no", "c8: audit new_value is the candidate email");

      assertEq(getProviderRow("aa-mismatch").epost, "post@annacider.no", "c9: aa-mismatch's epost UNCHANGED — never written directly");
      assertEq(getProviderRow("aa-nowebsite").epost, "post@ukjentgard.no", "c10: aa-nowebsite's epost UNCHANGED — never written directly");

      const mismatchQueueRow = getQueueRow("aa-mismatch");
      assertTrue(!!mismatchQueueRow, "c11: aa-mismatch landed in gardssalg_autosvar_review_queue");
      assertEq(mismatchQueueRow?.candidate_email, "ny-kontakt@et-helt-annet-domene.no", "c12: queued candidate_email is correct");
      assertEq(mismatchQueueRow?.classification, "domain_mismatch", "c13: queued classification is domain_mismatch");
      assertEq(mismatchQueueRow?.contact_email, "post@annacider.no", "c14: queued contact_email is the OLD epost, for diffing");

      const noWebsiteQueueRow = getQueueRow("aa-nowebsite");
      assertTrue(!!noWebsiteQueueRow, "c15: aa-nowebsite landed in gardssalg_autosvar_review_queue");
      assertEq(noWebsiteQueueRow?.classification, "no_website_on_file", "c16: queued classification is no_website_on_file");

      // ── (d) idempotency: repeat apply=true ─────────────────────────────────
      const applyAgainRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-autosvar-apply",
        query: { apply: "true" },
        headers: auth,
        body: {},
      });
      const againMatch = (applyAgainRes.body.results as any[]).find((r) => r.provider_id === "aa-match");
      assertEq(againMatch?.outcome, "already_set", "d1: repeat apply on an already-applied domain_match candidate -> already_set");
      assertEq(getAuditRows("aa-match").length, 1, "d2: repeat apply did NOT insert a second audit row (idempotent)");
      assertEq(countQueueRows("aa-mismatch"), 1, "d3: repeat apply upserts (not duplicates) the domain_mismatch queue row");
      assertEq(countQueueRows("aa-nowebsite"), 1, "d4: repeat apply upserts (not duplicates) the no_website_on_file queue row");

      // ── (e) review-approve: reject an unqueued provider_id ─────────────────
      const rejectRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-autosvar-review-approve",
        query: { apply: "true" },
        headers: auth,
        body: { provider_ids: ["aa-match"] }, // aa-match was auto-applied, never queued
      });
      assertEq(rejectRes.status, 200, "e1: review-approve call -> 200");
      assertEq(rejectRes.body.rejected?.[0]?.reason, "not_in_review_queue", "e2: an unqueued provider_id is rejected as not_in_review_queue");
      assertEq(rejectRes.body.written_count, 0, "e3: nothing written for the unqueued provider_id");

      // ── (f) review-approve dry-run: report only, no write ──────────────────
      const approveDryRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-autosvar-review-approve",
        headers: auth,
        body: { provider_ids: ["aa-mismatch"] },
      });
      assertEq(approveDryRes.status, 200, "f1: review-approve dry-run -> 200");
      assertEq(approveDryRes.body.dry_run, true, "f2: dry_run:true when apply is unset");
      assertEq(approveDryRes.body.written_count, 0, "f3: dry-run writes nothing");
      assertEq(getProviderRow("aa-mismatch").epost, "post@annacider.no", "f4: dry-run approve did not touch epost");
      assertTrue(!!getQueueRow("aa-mismatch"), "f5: dry-run approve left the queue row in place");

      // ── (g) review-approve apply=true: force-applies the queued candidate ──
      const approveApplyRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-autosvar-review-approve",
        query: { apply: "true" },
        headers: auth,
        body: { provider_ids: ["aa-mismatch", "aa-nowebsite"] },
      });
      assertEq(approveApplyRes.status, 200, "g1: review-approve apply=true -> 200");
      assertEq(approveApplyRes.body.dry_run, false, "g2: dry_run:false when apply=true");
      assertEq(approveApplyRes.body.written_count, 2, "g3: both queued providers written");

      assertEq(
        getProviderRow("aa-mismatch").epost,
        "ny-kontakt@et-helt-annet-domene.no",
        "g4: aa-mismatch's epost force-applied to the queued candidate_email despite the domain mismatch",
      );
      const mismatchAuditAfterApprove = getAuditRows("aa-mismatch");
      assertEq(mismatchAuditAfterApprove.length, 1, "g5: exactly one audit row for the approved write");
      assertEq(getQueueRow("aa-mismatch"), undefined, "g6: aa-mismatch's queue row cleared after approval");

      assertEq(
        getProviderRow("aa-nowebsite").epost,
        "ny-post@ukjentgard-erstatning.no",
        "g7: aa-nowebsite's epost applied to the queued candidate_email",
      );
      assertEq(getQueueRow("aa-nowebsite"), undefined, "g8: aa-nowebsite's queue row cleared after approval");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-autosvar-apply: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) {
          initMod.__setDbForTesting(prevRfbDb);
        }
      } catch {
        // best-effort cleanup
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-autosvar-apply.test.ts
if (require.main === module) {
  runOpplevelserGardssalgAutosvarApplyTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

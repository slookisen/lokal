/**
 * pending-verify-unpark-data-enriched-at-writesites.test.ts — AC6 regression
 * suite for dev-request 2026-09-01-rfb-pending-verify-unpark-lever's "Skive —
 * gjenopptak" byggspec (Daniel Alternativ B, 2026-09-02): proves each of the
 * 7 curated write sites that stamp `agent_knowledge.data_enriched_at` does
 * so ONLY on a genuine content write, and NEVER on a no-op call (a re-run
 * that finds nothing new to write). Without this, POST
 * /admin/agents/pending-verify-unpark's freshness filter
 * (`data_enriched_at > pending_verify_parked_since`) would false-admit rows
 * that received zero new data — the exact wasted-cycle problem the 30-day
 * parking mechanism exists to prevent (see that route's own header comment
 * and the dev-request's build log for the full "why not agent_knowledge.
 * updated_at" history — 3 review rounds found at least 3 unconditional
 * no-op stamps on that column across this same codebase).
 *
 * Covers, one block per write site (letters match the byggspec's own (a)-(g)
 * labelling):
 *   (a) admin-agents-contact-email-write.ts — applyContactEmail()
 *   (b) admin-agents-url-write.ts — applyUrl()
 *   (c) admin-rfb-contact-extraction.ts — applyRfbCxWrite()
 *   (d) admin-agents.ts — applyAgentBrregContact()
 *   (e) search-enrich-sweep.ts — applyEnrichWrite() (both genuine-write branches)
 *   (f) marketplace.ts POST /admin/google-rating-batch (the provenanceChanged-
 *       gated block from 297d179)
 *   (g) marketplace.ts POST /admin/homepage-provenance-batch (the NEW guard
 *       built in this slice) — both branches required by AC6: (i) a no-op
 *       candidate (everything already on file, same provenance) leaves
 *       data_enriched_at untouched, and (ii) a genuine fill (empty column)
 *       sets it.
 *
 * Each block also asserts the POSITIVE case (a genuine write DOES stamp
 * data_enriched_at) alongside the no-op assertion — a no-op-only suite could
 * pass vacuously if a site's stamp were dead code that never fires at all.
 *
 * (a)/(b)/(c) call their route's internal apply*() function directly — each
 * was given a testability `export` in this same slice (no behavior change)
 * specifically so this suite does not have to reconstruct three separate
 * full HTTP batch-request/response shapes (auth, dry-run flag, per-item
 * outcome reporting) that are already covered by those routes' OWN test
 * suites. (d)/(e) were already exported. (f)/(g) are HTTP-only routes on
 * marketplace.ts (no standalone exported function covers their write logic),
 * so those two blocks exercise the real POST handler via `router.handle`
 * directly — same pattern (in-memory db injection, global.fetch stub,
 * fresh `require` of the route module) as
 * homepage-provenance-junk-email-replace.test.ts and
 * marketplace-rfb-contact-judge.test.ts.
 *
 * Standalone by design (like this dev-request's OWN route test,
 * admin-agents-pending-verify-unpark.test.ts, and admin-rfb-contact-
 * extraction.test.ts before it) — not wired into tests/test.ts. This file
 * spans SIX otherwise-unrelated route/service modules and two fetch-stubbing
 * HTTP blocks; running it standalone avoids adding a new dependency into
 * tests/test.ts's long serial fetch-mock/db-singleton chain for a slice this
 * narrow. Run directly: `npx tsx src/routes/pending-verify-unpark-data-enriched-at-writesites.test.ts`.
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
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
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

export async function runPendingVerifyUnparkWriteSitesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = initMod.__peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const prevFetch = (globalThis as any).fetch;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "pv-unpark-writesites-test-key";

  function insertAgent(id: string, o: { url?: string; contactEmail?: string } = {}): void {
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
       VALUES (?, ?, 't', 't', ?, ?, 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
    ).run(id, id, o.contactEmail ?? "", o.url ?? "https://example.com", `key-${id}`);
  }

  function knowledgeDataEnrichedAt(agentId: string): string | null {
    return (db.prepare(`SELECT data_enriched_at FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as any)
      ?.data_enriched_at ?? null;
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    // ════════════════════════════════════════════════════════════════════
    // (a) admin-agents-contact-email-write.ts — applyContactEmail()
    // ════════════════════════════════════════════════════════════════════
    {
      delete require.cache[require.resolve("./admin-agents-contact-email-write")];
      const { applyContactEmail } = require("./admin-agents-contact-email-write") as
        typeof import("./admin-agents-contact-email-write");

      const id = "a-writesite-agent";
      insertAgent(id, { contactEmail: "keep@example.com" });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, data_enriched_at) VALUES (?, NULL)`,
      ).run(id);

      // No-op: same value written back -> outcome skipped_unchanged.
      const noop = applyContactEmail(db as any, id, "keep@example.com", "test-noop", "test-batch");
      assertEq(noop.outcome, "skipped_unchanged", "a1: same-value call outcome is skipped_unchanged");
      assertEq(knowledgeDataEnrichedAt(id), null, "a2: no-op call does NOT stamp data_enriched_at");

      // Genuine write: a real change -> data_enriched_at stamped.
      const written = applyContactEmail(db as any, id, "new@example.com", "test-write", "test-batch");
      assertEq(written.outcome, "written", "a3: distinct-value call outcome is written");
      assertTrue(!!knowledgeDataEnrichedAt(id), "a4: genuine write DOES stamp data_enriched_at");
    }

    // ════════════════════════════════════════════════════════════════════
    // (b) admin-agents-url-write.ts — applyUrl()
    // ════════════════════════════════════════════════════════════════════
    {
      delete require.cache[require.resolve("./admin-agents-url-write")];
      const { applyUrl } = require("./admin-agents-url-write") as typeof import("./admin-agents-url-write");

      const id = "b-writesite-agent";
      insertAgent(id, { url: "https://keep.example.com" });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, data_enriched_at) VALUES (?, NULL)`,
      ).run(id);

      const noop = applyUrl(id, "https://keep.example.com", "test-noop", "test-batch");
      assertEq(noop.outcome, "skipped_unchanged", "b1: same-value call outcome is skipped_unchanged");
      assertEq(knowledgeDataEnrichedAt(id), null, "b2: no-op call does NOT stamp data_enriched_at");

      const written = applyUrl(id, "https://new.example.com", "test-write", "test-batch");
      assertEq(written.outcome, "written", "b3: distinct-value call outcome is written");
      assertTrue(!!knowledgeDataEnrichedAt(id), "b4: genuine write DOES stamp data_enriched_at");
    }

    // ════════════════════════════════════════════════════════════════════
    // (c) admin-rfb-contact-extraction.ts — applyRfbCxWrite()
    // ════════════════════════════════════════════════════════════════════
    // data_enriched_at is stamped ONLY by the fill-only agent_knowledge.email
    // branch (guarded by `!cur.knowledge_email || !cur.knowledge_email.trim()`)
    // — NOT by the agents.contact_email branch. So the no-op case for THIS
    // site is "knowledge_email already filled" (that branch never runs),
    // even though the outcome is still "written" (the contact_email side can
    // still change independently).
    {
      delete require.cache[require.resolve("./admin-rfb-contact-extraction")];
      const { applyRfbCxWrite } = require("./admin-rfb-contact-extraction") as
        typeof import("./admin-rfb-contact-extraction");

      const id = "c-writesite-agent";
      insertAgent(id, { contactEmail: "old@example.com" });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, data_enriched_at) VALUES (?, 'already-filled@example.com', NULL)`,
      ).run(id);

      const noop = applyRfbCxWrite(db as any, id, "scraped@example.com", "https://source.example.com", "batch-1");
      assertEq(noop.outcome, "written", "c1: contact_email side still writes (outcome written)");
      assertEq(knowledgeDataEnrichedAt(id), null, "c2: knowledge.email already filled -> fill-only branch never runs -> data_enriched_at untouched");

      // Genuine write: knowledge_email empty -> fill-only branch runs.
      const id2 = "c-writesite-agent-2";
      insertAgent(id2, { contactEmail: "scraped2@example.com" });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, data_enriched_at) VALUES (?, NULL, NULL)`,
      ).run(id2);
      const written = applyRfbCxWrite(db as any, id2, "scraped2@example.com", "https://source.example.com", "batch-1");
      assertEq(written.outcome, "written", "c3: outcome written");
      assertTrue(!!knowledgeDataEnrichedAt(id2), "c4: knowledge.email fill-only branch DOES stamp data_enriched_at");
    }

    // ════════════════════════════════════════════════════════════════════
    // (d) admin-agents.ts — applyAgentBrregContact()
    // ════════════════════════════════════════════════════════════════════
    {
      delete require.cache[require.resolve("./admin-agents")];
      const { applyAgentBrregContact } = require("./admin-agents") as typeof import("./admin-agents");

      const id = "d-writesite-agent";
      insertAgent(id);
      const addr = "Storgata 1, 1400 Ski";
      const existingProv = JSON.stringify({
        address: { sources: [{ source_type: "brreg", value: addr, fetched_at: "2026-01-01T00:00:00.000Z", source_url: "https://brreg.example" }] },
      });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, field_provenance, data_enriched_at) VALUES (?, ?, ?, NULL)`,
      ).run(id, addr, existingProv);

      // No-op: identical address, already recorded in provenance, column already filled.
      const noopTouched = applyAgentBrregContact(db as any, id, { address: addr }, "https://brreg.example");
      assertEq(noopTouched, [], "d1: identical/already-recorded address -> touched=[] (full no-op, function returns before any write)");
      assertEq(knowledgeDataEnrichedAt(id), null, "d2: no-op call does NOT stamp data_enriched_at");

      // Genuine write: empty phone column gets filled.
      const written = applyAgentBrregContact(db as any, id, { phone: "+4712345678" }, "https://brreg.example");
      assertEq(written, ["phone"], "d3: empty phone column -> touched=['phone']");
      assertTrue(!!knowledgeDataEnrichedAt(id), "d4: genuine fill-only write DOES stamp data_enriched_at");
    }

    // ════════════════════════════════════════════════════════════════════
    // (e) search-enrich-sweep.ts — applyEnrichWrite() (both branches)
    // ════════════════════════════════════════════════════════════════════
    {
      delete require.cache[require.resolve("../services/search-enrich-sweep")];
      const { applyEnrichWrite } = require("../services/search-enrich-sweep") as
        typeof import("../services/search-enrich-sweep");

      const id = "e-writesite-agent";
      insertAgent(id);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, data_enriched_at) VALUES (?, 'already@example.com', 'https://already.example.com', NULL)`,
      ).run(id);

      // No-op: email already set, chosenUrl already set to the SAME value ->
      // colSets stays empty AND emailWritten stays false -> neither branch runs.
      const nowIso1 = new Date().toISOString();
      applyEnrichWrite(db as any, id, "found@example.com", "https://already.example.com", nowIso1);
      assertEq(knowledgeDataEnrichedAt(id), null, "e1: both columns already filled -> no-op -> data_enriched_at untouched");

      // Genuine write: empty email + no chosenUrl -> branch 1 (colSets) fires with email only.
      const id2 = "e-writesite-agent-2";
      insertAgent(id2);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, data_enriched_at) VALUES (?, NULL, NULL, NULL)`).run(id2);
      const nowIso2 = new Date().toISOString();
      const res2 = applyEnrichWrite(db as any, id2, "brandnew@example.com", null, nowIso2);
      assertTrue(res2.emailWritten, "e2: emailWritten true for the empty-email fill");
      assertTrue(!!knowledgeDataEnrichedAt(id2), "e3: genuine fill (branch 1: colSets) DOES stamp data_enriched_at");

      // Genuine write path via branch 2 (provenance-merge, emailWritten guard)
      // is exercised by the SAME call above (colSets.length>0 AND emailWritten
      // both true in one call, since email itself was the empty column filled)
      // — branch 2 is unreachable independently of branch 1 (it is only
      // entered `if (emailWritten)`, which is only ever set true inside
      // branch 1's own email-fill condition), so e3 above already covers it.
    }

    // ════════════════════════════════════════════════════════════════════
    // (f) marketplace.ts — POST /admin/google-rating-batch
    // ════════════════════════════════════════════════════════════════════
    {
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      process.env.GOOGLE_PLACES_API_KEY = "test-places-key-noop-suite";

      const id = "f-writesite-agent";
      insertAgent(id, { url: "https://f-writesite.example.com" });
      const addr = "Storgata 1, 1400 Ski";
      const existingProv = JSON.stringify({
        address: { sources: [{ source_type: "google_places", value: addr, fetched_at: "2026-01-01T00:00:00.000Z" }] },
      });
      db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, field_provenance, google_enterprise_fetched_at, data_enriched_at)
         VALUES (?, ?, '+4799999999', ?, datetime('now'), NULL)`,
      ).run(id, addr, existingProv);

      (globalThis as any).fetch = async (url: string) => {
        if (typeof url === "string" && url.includes("places.googleapis.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ places: [{ id: "place-f-1", formattedAddress: addr }] }),
          } as any;
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
      };

      // No-op: google_enterprise_fetched_at is fresh (pro-tier mask, no rating
      // requested), address+phone already filled (fill-only skip), and the
      // Places answer's address is byte-identical to what's already recorded
      // in field_provenance under the SAME source_type -> provenanceChanged
      // is false -> the whole UPDATE is skipped (sets.length === 0).
      const noopResult = await callRoute(router, {
        method: "POST",
        url: "/admin/google-rating-batch",
        headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
        body: { agentIds: [id], include_address_phone: true, max_details_calls: 0 },
      });
      assertEq(noopResult.status, 200, "f1: POST /admin/google-rating-batch -> 200");
      assertEq(knowledgeDataEnrichedAt(id), null, "f2: no-op Google answer (same address, already-recorded provenance) does NOT stamp data_enriched_at");

      // Genuine write: a fresh agent with an EMPTY address column -> writeAddr
      // becomes true -> the gated block runs and stamps data_enriched_at.
      const id2 = "f-writesite-agent-2";
      insertAgent(id2, { url: "https://f-writesite-2.example.com" });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, phone, field_provenance, google_enterprise_fetched_at, data_enriched_at)
         VALUES (?, NULL, NULL, '{}', datetime('now'), NULL)`,
      ).run(id2);
      const writeResult = await callRoute(router, {
        method: "POST",
        url: "/admin/google-rating-batch",
        headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
        body: { agentIds: [id2], include_address_phone: true, max_details_calls: 0 },
      });
      assertEq(writeResult.status, 200, "f3: POST /admin/google-rating-batch -> 200 (genuine-write agent)");
      assertTrue(!!knowledgeDataEnrichedAt(id2), "f4: genuine address fill DOES stamp data_enriched_at");
    }

    // ════════════════════════════════════════════════════════════════════
    // (g) marketplace.ts — POST /admin/homepage-provenance-batch (NEW guard)
    // ════════════════════════════════════════════════════════════════════
    {
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      const addr = "Storgata 1, 1400 Ski";
      // extractAddress() strips ALL tags (including <title>/<h1>) and matches
      // against the resulting flattened text with a lazy-but-unanchored
      // regex — a colon-free run of letters+spaces immediately before the
      // address (e.g. "G Noop AS G Noop AS Storgata 1, ...") gets swallowed
      // into the street-name capture group. A real page has enough
      // intervening punctuation/markup-stripped-to-space text that this
      // essentially never happens; this minimal fixture needs an explicit
      // non-letter/space separator ("Adresse: ") so the match starts exactly
      // at "Storgata", same as every other extractAddress test fixture in
      // this codebase (see homepage-provenance-contact-extraction-fix.test.ts).
      const pageHtmlFor = (producerName: string) =>
        `<html><head><title>${producerName}</title></head><body>
          <h1>${producerName}</h1>
          <p>Adresse: ${addr}</p>
        </body></html>`;

      (globalThis as any).fetch = async (url: string) => {
        if (typeof url === "string" && url.includes("g-noop.example.com")) {
          return { ok: true, status: 200, text: async () => pageHtmlFor("G Noop AS") } as any;
        }
        if (typeof url === "string" && url.includes("g-fill.example.com")) {
          return { ok: true, status: 200, text: async () => pageHtmlFor("G Fill AS") } as any;
        }
        return { ok: false, status: 404, text: async () => "" } as any;
      };

      // ── (g-i) no-op candidate: address already on file, byte-identical to
      // what the page extracts, and ALREADY recorded in field_provenance
      // under the same source_type:"homepage" -> columnWritten stays false
      // (fill-only, column non-empty) AND provenanceChanged is false (dedup
      // by source_type+value) -> field_provenance/updated_at/data_enriched_at
      // must ALL stay untouched (only the always-on attempt/outcome/streak
      // columns move). ──
      {
        const id = "g-noop-agent";
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
           VALUES (?, 'G Noop AS', 't', 't', '', 'https://g-noop.example.com', 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
        ).run(id, `key-${id}`);
        const existingProv = JSON.stringify({
          address: { sources: [{ source_type: "homepage", value: addr, fetched_at: "2026-01-01T00:00:00.000Z", source_url: "https://g-noop.example.com" }] },
        });
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, address, phone, email, field_provenance, data_enriched_at)
           VALUES (?, 'https://g-noop.example.com', ?, NULL, NULL, ?, NULL)`,
        ).run(id, addr, existingProv);

        const provBefore = (db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as any).field_provenance;

        const r = await callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
          body: { agentIds: [id] },
        });
        assertEq(r.status, 200, "g-i-1: POST /admin/homepage-provenance-batch -> 200 (no-op candidate)");
        const rowAfter = db.prepare(`SELECT field_provenance, data_enriched_at, last_enrichment_outcome FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
        assertEq(rowAfter.last_enrichment_outcome, "enriched", "g-i-2: outcome still stamped 'enriched' (the always-on attempt tracking is unaffected by this guard)");
        assertEq(rowAfter.field_provenance, provBefore, "g-i-3: field_provenance UNCHANGED byte-for-byte (provenanceChanged false, columnWritten false)");
        assertEq(rowAfter.data_enriched_at, null, "g-i-4: AC6 — no-op call does NOT stamp data_enriched_at");
      }

      // ── (g-ii) genuine fill: address column empty, no prior provenance for
      // it -> columnWritten becomes true -> field_provenance/updated_at/
      // data_enriched_at all get stamped. ──
      {
        const id = "g-fill-agent";
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
           VALUES (?, 'G Fill AS', 't', 't', '', 'https://g-fill.example.com', 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
        ).run(id, `key-${id}`);
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, address, phone, email, field_provenance, data_enriched_at)
           VALUES (?, 'https://g-fill.example.com', NULL, NULL, NULL, '{}', NULL)`,
        ).run(id);

        const r = await callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
          body: { agentIds: [id] },
        });
        assertEq(r.status, 200, "g-ii-1: POST /admin/homepage-provenance-batch -> 200 (genuine-fill candidate)");
        const rowAfter = db.prepare(`SELECT address, data_enriched_at FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
        assertEq(rowAfter.address, addr, "g-ii-2: address column genuinely filled from the page");
        assertTrue(!!rowAfter.data_enriched_at, "g-ii-3: AC6 — genuine fill DOES stamp data_enriched_at (the new guard's other branch)");
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("pending-verify-unpark-data-enriched-at-writesites: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (globalThis as any).fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
    try {
      if (prevDb) initMod.__setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/pending-verify-unpark-data-enriched-at-writesites.test.ts`
if (require.main === module) {
  runPendingVerifyUnparkWriteSitesTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

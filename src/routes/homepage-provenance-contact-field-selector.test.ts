/**
 * homepage-provenance-contact-field-selector.test.ts — dev-request
 * 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring, AC4 (skive C1).
 *
 * The default auto-select of POST /admin/homepage-provenance-batch
 * (routes/marketplace.ts) used to exclude every profile whose
 * field_provenance contained "homepage" anywhere. applyRfbAgentWebsite writes
 * a homepage source on `website` only, so a profile that just got a website
 * was never picked for contact extraction. Now only a homepage source on
 * address / phone / email excludes (services/homepage-contact-provenance.ts).
 *
 * Covers:
 *   (1) homepage source only on website (and only on about) -> selected;
 *   (2) homepage source on address / phone / email -> not selected, also in
 *       the legacy {sources:[…]} wrapper, with spaced JSON and with the old
 *       `source` key;
 *   (3) '{}', '' and malformed field_provenance -> selected; NULL (column is
 *       NOT NULL in the schema, so checked on the SQL fragment directly)
 *       -> not excluded;
 *   (4) no_yield / wrong_entity backoff still excludes;
 *   (5) empty about still excludes;
 *   (6) GET /admin/homepage-provenance-cohort and the JS mirror
 *       hasHomepageContactProvenance agree with the batch selector.
 *
 * Same harness as homepage-provenance-selector-rotation.test.ts: in-memory
 * prod-schema DB via __setDbForTesting/__initSchemaForTesting, router called
 * directly, global.fetch stubbed (selection is observed by which hosts get
 * fetched — no real network), ANTHROPIC_API_KEY stubbed; all restored after.
 * Exported runHomepageProvenanceContactFieldSelectorTests({log}) -> TestSummary,
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/homepage-provenance-contact-field-selector.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  hasHomepageContactProvenance,
  homepageContactProvenanceSql,
} from "../services/homepage-contact-provenance";

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
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
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
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

const HP = (value: string) => ({ value, source_type: "homepage", fetched_at: "2026-10-01T00:00:00Z", source_url: "https://x.no" });
const GP = (value: string) => ({ value, source_type: "google_places", fetched_at: "2026-10-01T00:00:00Z" });

export function runHomepageProvenanceContactFieldSelectorTests(
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
    const testKey = process.env.ADMIN_KEY || "homepage-contact-field-selector-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;
    const prevParkingDisabled = process.env.HOMEPAGE_PARKING_DISABLED;
    delete process.env.HOMEPAGE_PARKING_DISABLED;
    const prevNoYieldBackoffDays = process.env.NO_YIELD_BACKOFF_DAYS;
    delete process.env.NO_YIELD_BACKOFF_DAYS;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-contact-field-selector";

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, website, email, about, field_provenance, verification_status,
            no_yield_streak, wrong_entity_streak, last_enrichment_attempt_at)
         VALUES (?, ?, NULL, ?, ?, 'pending_verify', ?, ?, ?)`,
      );

      const hostNames: Record<string, string> = {};
      const hostOf: Record<string, string> = {};
      function add(
        id: string,
        prov: string,
        o: { about?: string; noYield?: number; wrongEntity?: number; lastAttempt?: string | null } = {},
      ): void {
        const host = `${id}.no`;
        const name = `Gard ${id.replace(/[^a-z0-9]/gi, "")} AS`;
        hostNames[host] = name;
        hostOf[id] = host;
        insertAgent.run(id, name, `https://${host}`, `key-${id}`);
        insertKnowledge.run(
          id,
          `https://${host}`,
          o.about ?? "En liten gard med gardsutsalg.",
          prov,
          o.noYield ?? 0,
          o.wrongEntity ?? 0,
          o.lastAttempt ?? null,
        );
      }

      const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);

      // (1) selected
      add("sel-website-only", JSON.stringify({ website: [HP("https://sel-website-only.no")] }));
      add("sel-about-only", JSON.stringify({ about: [HP("Om garden")], address: [GP("Testveien 1")] }));
      add("sel-website-homepage-type", JSON.stringify({ address: [{ value: "Testveien 1", source_type: "website_homepage", fetched_at: "2026-10-01" }] }));
      // (3) selected
      add("sel-empty-obj", "{}");
      add("sel-empty-str", "");
      add("sel-malformed", '{"address": [ {"source_type":"homepage"');
      add("sel-array-json", JSON.stringify([HP("x")]));
      // (2) excluded
      add("excl-address", JSON.stringify({ website: [HP("https://x.no")], address: [HP("Testveien 1")] }));
      add("excl-phone", JSON.stringify({ phone: [GP("91234567"), HP("91234567")] }));
      add("excl-email", JSON.stringify({ email: [HP("post@excl-email.no")] }));
      add("excl-wrapped", JSON.stringify({ address: { sources: [HP("Testveien 1")] } }));
      add("excl-spaced", '{"phone": [{"value": "91234567", "source_type": "homepage"}]}');
      add("excl-legacy-source-key", JSON.stringify({ email: [{ value: "a@b.no", source: "homepage" }] }));
      add("excl-single-record", JSON.stringify({ address: HP("Testveien 1") }));
      // (4) backoff still excludes (website-only provenance, would be selected otherwise)
      add("excl-noyield", JSON.stringify({ website: [HP("https://x.no")] }), { noYield: 3, lastAttempt: recent });
      add("excl-wrongentity", JSON.stringify({ website: [HP("https://x.no")] }), { wrongEntity: 3, lastAttempt: recent });
      // (5) empty about still excludes
      add("excl-empty-about", JSON.stringify({ website: [HP("https://x.no")] }), { about: "" });

      const expectSelected = [
        "sel-website-only", "sel-about-only", "sel-website-homepage-type",
        "sel-empty-obj", "sel-empty-str", "sel-malformed", "sel-array-json",
      ];
      const expectExcluded = [
        "excl-address", "excl-phone", "excl-email", "excl-wrapped", "excl-spaced",
        "excl-legacy-source-key", "excl-single-record",
        "excl-noyield", "excl-wrongentity", "excl-empty-about",
      ];

      delete require.cache[require.resolve("./marketplace")];
      const router = require("./marketplace").default;

      const fetchedHosts: string[] = [];
      (globalThis as any).fetch = async (url: string) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo." }] }),
          } as any;
        }
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);
        const name = hostNames[host] ?? "Ukjent AS";
        // Mentions the producer, no contact fields -> no_yield; nothing written
        // to address/phone/email, so the provenance fixtures stay as inserted.
        return {
          ok: true,
          status: 200,
          text: async () => `<html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
        } as any;
      };

      const r = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 100 },
      });
      assertEq(r.status, 200, "cf-01: default auto-select batch -> 200");
      const fetched = new Set(fetchedHosts);
      for (const id of expectSelected) {
        assertTrue(fetched.has(hostOf[id]), `cf-sel: ${id} selected by the default auto-select`);
      }
      for (const id of expectExcluded) {
        assertTrue(!fetched.has(hostOf[id]), `cf-excl: ${id} not selected by the default auto-select`);
      }
      assertEq(fetched.size, expectSelected.length, "cf-02: exactly the expected set was fetched");

      // NULL can't be stored (column is NOT NULL DEFAULT '{}'), so check the
      // shared SQL fragment directly: NULL / '{}' / malformed -> 0, never throws.
      const frag = homepageContactProvenanceSql("k");
      const evalFrag = (v: string | null) =>
        (db.prepare(`SELECT ${frag} AS hit FROM (SELECT ? AS field_provenance) k`).get(v) as { hit: number }).hit;
      assertEq(evalFrag(null), 0, "cf-03: NULL field_provenance -> no homepage contact source");
      assertEq(evalFrag("{}"), 0, "cf-04: '{}' -> no homepage contact source");
      assertEq(evalFrag("not json"), 0, "cf-05: malformed JSON -> 0, no throw");
      assertEq(evalFrag(JSON.stringify({ email: [HP("a@b.no")] })), 1, "cf-06: homepage source on email -> 1");

      // (6) JS mirror and the cohort route agree with the batch selector.
      const provRows = db
        .prepare(`SELECT agent_id, field_provenance FROM agent_knowledge`)
        .all() as Array<{ agent_id: string; field_provenance: string | null }>;
      for (const row of provRows) {
        assertEq(
          hasHomepageContactProvenance(row.field_provenance) ? 1 : 0,
          evalFrag(row.field_provenance),
          `cf-mirror: JS mirror == SQL fragment for ${row.agent_id}`,
        );
      }

      const cohortPath = require.resolve("./admin-homepage-provenance-cohort");
      delete require.cache[cohortPath];
      const cohortRouter = require("./admin-homepage-provenance-cohort").default;
      const c = await callRoute(cohortRouter, {
        method: "GET",
        url: "/?limit=1000",
        headers: { "x-admin-key": testKey },
        query: { limit: "1000" },
      });
      assertEq(c.status, 200, "cf-07: cohort route -> 200");
      const cohortIds = new Set<string>(c.body?.agentIds ?? []);
      // The batch run above stamped no_yield on the selected rows (streak 1,
      // still below the backoff threshold), so the cohort is unchanged.
      for (const id of expectSelected) assertTrue(cohortIds.has(id), `cf-cohort-sel: ${id} in cohort listing`);
      for (const id of expectExcluded) assertTrue(!cohortIds.has(id), `cf-cohort-excl: ${id} not in cohort listing`);
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED;
      else process.env.HOMEPAGE_PARKING_DISABLED = prevParkingDisabled;
      if (prevNoYieldBackoffDays === undefined) delete process.env.NO_YIELD_BACKOFF_DAYS;
      else process.env.NO_YIELD_BACKOFF_DAYS = prevNoYieldBackoffDays;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageProvenanceContactFieldSelectorTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

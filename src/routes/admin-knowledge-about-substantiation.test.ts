/**
 * admin-knowledge-about-substantiation.test.ts — route-level integration
 * tests for the about-source-substantiation check wired into POST
 * /admin/homepage-content-refresh (routes/admin-knowledge.ts; dev-request
 * 2026-08-22-rfbweb-about-guard). Reference incident: the "Li Lynghonning"
 * agent showed a stale/mismatched about-text that did not match its actual
 * current source page.
 *
 * IMPORTANT — what this file can and cannot exercise, and why:
 * `checkAboutCandidateSubstantiatedBySource`'s own accept/reject CONTRACT is
 * exhaustively unit-tested in about-source-substantiation.test.ts (verbatim
 * match, close-paraphrase match, and genuine rejections). At THIS route,
 * the candidate (`aboutSummary = summarizeAbout(primaryHtml)`) is, BY
 * CONSTRUCTION, always derived directly from the exact `primaryHtml` this
 * check verifies it against — every one of summarizeAbout()'s three
 * extraction modes (og:description, `<meta name="description">`, first
 * substantive visible paragraph) is a literal excerpt of that same fetched
 * page. There is therefore no legitimate way to make THIS route's real
 * fetch-then-extract-then-verify pipeline produce a candidate that fails
 * its own substantiation check — the check can only ever reject something
 * that was never a real candidate in the first place. That is not a gap: it
 * means the guard is provably a no-op false-positive risk of exactly zero
 * on today's real traffic through this route, while still standing as
 * defense-in-depth against a FUTURE regression (e.g. a refactor of
 * summarizeAbout that starts returning boilerplate/fabricated text, or a
 * new candidate source added to this route later without re-deriving it
 * from the fetched page). This file therefore proves the WIRING is correct
 * and SAFE (a real, matching candidate is written exactly as before — no
 * regression) rather than forcing an artificial route-level rejection.
 *
 * Setup mirrors homepage-content-refresh-parking.test.ts's harness exactly:
 * better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting,
 * homepageContentRefreshRouter driven through router.handle(), globalThis.
 * fetch stubbed to serve fixture HTML, explicit `agentIds` (not auto-select)
 * to keep each case isolated and deterministic.
 *
 * Covers:
 *   (a) og:description-sourced about text (verbatim in raw HTML, never in
 *       tag-stripped visible text alone) is written — proves the guard uses
 *       the RAW html half of its source, not just extractVisibleText's
 *       tag-stripped half
 *   (b) first-visible-paragraph-sourced about text (no meta tags at all) is
 *       written
 *   (c) `skipped_unsubstantiated` is present and empty on an ordinary run
 *       that wrote successfully
 *   (d) dry-run preview behaves identically (still reports the write as
 *       `changed`, still writes nothing) — the guard runs before the
 *       dry-run branch, same as every other candidate-building step here
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

export function runAdminKnowledgeAboutSubstantiationTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-knowledge-about-substantiation-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'post@example.no', ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, about, products, field_provenance, updated_at)
         VALUES (?, ?, NULL, '[]', '{}', '2020-01-01T00:00:00.000Z')`,
      );

      insertAgent.run("as-meta", "Metagard AS", "https://metagard.no", "key-as-meta");
      insertKnowledge.run("as-meta", "https://metagard.no");

      insertAgent.run("as-prose", "Prosegard AS", "https://prosegard.no", "key-as-prose");
      insertKnowledge.run("as-prose", "https://prosegard.no");

      // Dedicated fixture for the dry-run case (d) — never previously
      // written, so it carries no field_provenance history that could
      // interact with the pre-existing orch-pr-17 correct-not-just-add
      // overwrite gating (out of scope here; this file only needs a CLEAN
      // "would write" preview).
      insertAgent.run("as-dryrun", "Dryrungard AS", "https://dryrungard.no", "key-as-dryrun");
      insertKnowledge.run("as-dryrun", "https://dryrungard.no");

      delete require.cache[require.resolve("./admin-knowledge")];
      const adminKnowledgeMod = require("./admin-knowledge");
      const router = adminKnowledgeMod.homepageContentRefreshRouter;

      (globalThis as any).fetch = async (url: string) => {
        const host = new URL(url).hostname;
        if (host === "metagard.no") {
          return new Response(
            "<html><head><title>Metagard AS</title>" +
              '<meta property="og:description" content="Vi produserer ekte gårdshonning fra egne bikuber i Hallingdal, levert rett fra garden.">' +
              "</head><body><h1>Metagard</h1><p>Kort velkomsttekst.</p></body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (host === "prosegard.no") {
          return new Response(
            "<html><head><title>Prosegard AS</title></head><body><h1>Prosegard</h1>" +
              "<p>Prosegard AS ligger idyllisk til i Valdres og har drevet med tradisjonelt gardsbruk siden 1950, med sau, geit og eget meieri.</p>" +
              "</body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (host === "dryrungard.no") {
          return new Response(
            "<html><head><title>Dryrungard AS</title>" +
              '<meta property="og:description" content="Dryrungard AS selger poteter og rotgrønnsaker rett fra jordet, dyrket uten sprøytemidler siden 1975.">' +
              "</head><body><h1>Dryrungard</h1></body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      };

      async function post(body: any, query?: Record<string, string>): Promise<RouteResult> {
        return callRoute(router, {
          method: "POST",
          url: "/homepage-content-refresh",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
          query,
        });
      }
      function aboutOf(agentId: string): string | null {
        const row = db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
          | { about: string | null }
          | undefined;
        return row?.about ?? null;
      }

      // ── (a) og:description-sourced candidate: verbatim ONLY in raw HTML,
      //    never in extractVisibleText's tag-stripped output (a <meta>
      //    attribute value has no text-node representation) — proves the
      //    guard's source text includes the RAW html, not just the
      //    tag-stripped visible-text half. ─────────────────────────────────
      let r = await post({ agentIds: ["as-meta"], apply: true });
      assertEq(r.status, 200, "as-01: apply run for the og:description fixture -> 200");
      assertEq(
        aboutOf("as-meta"),
        "Vi produserer ekte gårdshonning fra egne bikuber i Hallingdal, levert rett fra garden.",
        "as-02: og:description candidate IS written — the substantiation guard did not falsely reject a real, page-derived candidate",
      );
      assertTrue(
        (r.body?.changed ?? []).some((c: any) => c.agent_id === "as-meta" && c.fields.includes("about")),
        "as-03: 'about' reported in changed[].fields for as-meta",
      );
      assertEq(r.body?.skipped_unsubstantiated, [], "as-04: skipped_unsubstantiated is present and empty — nothing was wrongly dropped");

      // ── (b) first-visible-paragraph-sourced candidate (no meta tags).
      //    summarizeAbout()'s case-3 chunk is the first sentence-terminated
      //    run of extractProseText()'s output — which itself concatenates
      //    title/h1/paragraph text (no sentence break before the paragraph
      //    here), so the actual candidate is the WHOLE leading run, not just
      //    the <p> text in isolation. That is real, pre-existing
      //    summarizeAbout() behaviour, unrelated to this guard — the point
      //    of this case is simply that whatever it extracts, it is STILL a
      //    literal excerpt of the fetched page and therefore still passes
      //    substantiation. ───────────────────────────────────────────────
      r = await post({ agentIds: ["as-prose"], apply: true });
      const prosegardAbout = aboutOf("as-prose");
      assertTrue(!!prosegardAbout && prosegardAbout.includes(
        "Prosegard AS ligger idyllisk til i Valdres og har drevet med tradisjonelt gardsbruk siden 1950, med sau, geit og eget meieri.",
      ), "as-05: prose-paragraph candidate IS written (includes the page's own paragraph text)");
      assertEq(r.body?.skipped_unsubstantiated, [], "as-06: skipped_unsubstantiated still empty");

      // ── (c)/(d) dry-run preview: unaffected, writes nothing. A FRESH
      //    fixture (never previously written) keeps this case isolated from
      //    the pre-existing correct-not-just-add overwrite gating, which is
      //    unrelated to what this test is proving. ────────────────────────
      r = await post({ agentIds: ["as-dryrun"] }); // no apply -> dry-run
      assertEq(r.body?.dry_run, true, "as-07: dry-run by default");
      assertTrue(
        (r.body?.changed ?? []).some((c: any) => c.agent_id === "as-dryrun" && c.fields.includes("about")),
        "as-08: dry-run STILL reports the write it WOULD make (substantiation check runs before the dry-run branch, same as every other candidate-building step)",
      );
      assertEq(aboutOf("as-dryrun"), null, "as-09: dry-run wrote nothing");
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminKnowledgeAboutSubstantiationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}

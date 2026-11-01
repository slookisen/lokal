/**
 * homepage-content-refresh-extraction-parity.test.ts — POST
 * /admin/homepage-content-refresh (routes/admin-knowledge.ts) before and
 * after its per-agent refresh was extracted into refreshHomepageContent()
 * (+ selectHomepageContentRefreshTargetsByIds()) so the platform-side daily
 * RFB send (services/rfb-marketing-daily.ts) can run the same refresh for the
 * producers it is about to e-mail (owner decision 2026-09-29, A2A
 * daniel-responses/2026-09-29-live-rfb-marketing-aktiveringsvalg.md:
 * «Oppfriskning av hjemmeside før utsending»).
 *
 * The GOLDEN_* constants below were captured by running THIS file's
 * scenarios against the route as it was BEFORE the extraction (origin/main
 * 8744986e). The route must still answer byte-identically and leave the
 * database byte-identical (timestamps normalized); the extracted function,
 * called directly with the same targets, must produce the same result and
 * the same database.
 *
 * Scenarios (explicit agentIds, global fetch stubbed — no network):
 *   S1 apply: a google_places-sourced profile overwritten from its homepage;
 *      a curated-locked `about` left alone; a permanent 404 (parking strike);
 *      a transient timeout (no strike); a gambling/theme-spam page (skipped,
 *      nothing written); no homepage + an umbrella (filtered out).
 *   S2 the same with apply off (dry run): same report, nothing written.
 *   S3 enrichment write-pause on (rfb): 423, nothing written, nothing fetched.
 *   S4 auto-select (no agentIds), apply. Since dev-request 2026-10-15-
 *      homepage-refresh-autoutvalg-erstatter-ikke-ubekreftede-kategorier its
 *      body also carries a categories_corroboration tally (last key).
 *
 * Skive B (dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-
 * forverring): GOLDEN S1/S2/S4 re-captured with the about judges stubbed to
 * approve (tests/helpers/hcr-about-judges.ts). Database, fetches and every
 * earlier body key are unchanged; the body only gained about_reviews and the
 * four about_* counters (after parked_now) and, for S1/S2 (explicit
 * agentIds), the categories_corroboration tally as last key.
 *
 * Standalone: npx tsx src/routes/homepage-content-refresh-extraction-parity.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
// skive B (dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring): the about
// LLM judges approve everything here — this suite tests other guards.
import { useApproveAllAboutJudges } from "../../tests/helpers/hcr-about-judges";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(router: any, opts: { body?: any; query?: Record<string, string>; headers: Record<string, string> }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers;
    const req: any = {
      method: "POST",
      url: "/homepage-content-refresh",
      originalUrl: "/homepage-content-refresh",
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => resolve({ status: 500, body: { error: String(err ?? "unmatched") } }));
  });
}

const GOOGLE_ABOUT = "Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.";
const PAGE_ABOUT = "Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.";

function page(title: string, og: string, body: string): string {
  return (
    `<html><head><title>${title}</title><meta property="og:description" content="${og}"></head>` +
    `<body><h1>${title}</h1><p>${body}</p></body></html>`
  );
}

const PAGES: Record<string, { status: number; html?: string; throwTimeout?: boolean }> = {
  "google-gard.no": { status: 200, html: page("Google Gård", PAGE_ABOUT, "Vi selger honning, egg og lammekjøtt. Velkommen til gården!") },
  "curated-gard.no": { status: 200, html: page("Kuratert Gård", PAGE_ABOUT, "Honning og egg fra egne høner.") },
  "dead-gard.no": { status: 404 },
  "slow-gard.no": { status: 0, throwTimeout: true },
  "spam-gard.no": { status: 200, html: page("Beste norske casino 2026", "Casino bonus og free spins", "Spill casino med velkomstbonus.") },
  "auto-gard.no": { status: 200, html: page("Auto Gård", PAGE_ABOUT, "Honning og egg.") },
};

/** Timestamps vary per run; everything else must match byte for byte. */
function norm(v: unknown): string {
  return JSON.stringify(v)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, "<iso>")
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<sqlts>");
}

export async function runHomepageContentRefreshExtractionParityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const restoreAboutJudges = useApproveAllAboutJudges();
  const PRINT = process.env.HCR_PARITY_PRINT === "1";

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

  const prevDb = initMod.__peekDbForTesting();
  const prevFetch = (globalThis as any).fetch;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevParking = process.env.HOMEPAGE_PARKING_DISABLED;
  delete process.env.HOMEPAGE_PARKING_DISABLED;
  const testKey = process.env.ADMIN_KEY || "hcr-extraction-parity-test-key";
  process.env.ADMIN_KEY = testKey;
  const headers = { "x-admin-key": testKey, "content-type": "application/json" };

  const fetched: string[] = [];
  const stubFetch = async (url: string) => {
    const u = new URL(url);
    fetched.push(u.host + u.pathname);
    const p = PAGES[u.host];
    if (!p) return new Response("", { status: 404 });
    if (p.throwTimeout) {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }
    if (u.pathname !== "/" && u.pathname !== "") return new Response("", { status: 404 });
    if (p.status !== 200) return new Response("", { status: p.status });
    return new Response(p.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };

  function freshDb(): any {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
       VALUES (?, ?, ?, 'test', 'post@example.no', ?, 'producer', ?, ?)`,
    );
    const insK = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, website, about, products, field_provenance, curated_fields, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const gp = (v: string) =>
      JSON.stringify({ about: [{ source_type: "google_places", value: v, fetched_at: "2026-01-01T00:00:00.000Z" }] });
    insA.run("hp-google", "Google Gård", GOOGLE_ABOUT, "https://google-gard.no", "k1", null);
    insK.run("hp-google", "https://google-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2020-01-01T00:00:00.000Z");
    insA.run("hp-curated", "Kuratert Gård", "Eierens egen tekst", "https://curated-gard.no", "k2", null);
    insK.run("hp-curated", "https://curated-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), JSON.stringify({ about: true }), "2020-01-02T00:00:00.000Z");
    insA.run("hp-dead", "Død Gård", "d", "https://dead-gard.no", "k3", null);
    insK.run("hp-dead", "https://dead-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2020-01-03T00:00:00.000Z");
    insA.run("hp-slow", "Treg Gård", "d", "https://slow-gard.no", "k4", null);
    insK.run("hp-slow", "https://slow-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2020-01-04T00:00:00.000Z");
    insA.run("hp-spam", "Spam Gård", "d", "https://spam-gard.no", "k5", null);
    insK.run("hp-spam", "https://spam-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2020-01-05T00:00:00.000Z");
    insA.run("hp-noweb", "Uten Nett", "d", "", "k6", null);
    insK.run("hp-noweb", null, GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2020-01-06T00:00:00.000Z");
    insA.run("hp-umbrella", "Paraply", "d", "https://google-gard.no", "k7", "cooperative");
    insK.run("hp-umbrella", "https://google-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2020-01-07T00:00:00.000Z");
    insA.run("hp-auto", "Auto Gård", "d", "https://auto-gard.no", "k8", null);
    insK.run("hp-auto", "https://auto-gard.no", GOOGLE_ABOUT, "[]", gp(GOOGLE_ABOUT), "{}", "2019-01-01T00:00:00.000Z");
    return db;
  }

  function dbSnapshot(db: any): unknown {
    return {
      k: db
        .prepare(
          `SELECT agent_id, about, products, field_provenance, curated_fields, homepage_fetch_attempts,
                  homepage_unreachable_since, updated_at FROM agent_knowledge WHERE agent_id LIKE 'hp-%' ORDER BY agent_id`,
        )
        .all(),
      a: db.prepare(`SELECT id, description, categories FROM agents WHERE id LIKE 'hp-%' ORDER BY id`).all(),
    };
  }

  const EXPLICIT = ["hp-google", "hp-curated", "hp-dead", "hp-slow", "hp-spam", "hp-noweb", "hp-umbrella"];
  const printed: Record<string, string> = {};

  try {
    delete require.cache[require.resolve("./admin-knowledge")];
    const mod = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
    const router = mod.homepageContentRefreshRouter as any;
    (globalThis as any).fetch = stubFetch;
    const fnAvailable = typeof (mod as any).refreshHomepageContent === "function";

    // S1 + S2: explicit list, apply and dry run.
    for (const [name, apply] of [["S1", true], ["S2", false]] as const) {
      let db = freshDb();
      fetched.length = 0;
      const r = await callRoute(router, { body: { agentIds: EXPLICIT, apply }, headers });
      const routeOut = norm({ status: r.status, body: r.body, db: dbSnapshot(db), fetched: [...fetched].sort() });
      printed[name] = routeOut;
      if (!PRINT) assertEq(routeOut, GOLDEN[name], `${name}: the route answers and writes exactly as before the extraction`);
      if (fnAvailable) {
        db = freshDb();
        fetched.length = 0;
        const targets = (mod as any).selectHomepageContentRefreshTargetsByIds(db, EXPLICIT, 25);
        const out = await (mod as any).refreshHomepageContent(db, targets, { dryRun: !apply });
        // The route adds truncated/not_reached (dev-request 2026-10-31 S1) after the result keys,
        // and (skive B, dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring) the
        // categories_corroboration tally for explicit agentIds too.
        const notReached = (mod as any).homepageContentRefreshNotReached(out);
        const fnBody = {
          dry_run: !apply,
          ...out,
          truncated: notReached > 0,
          not_reached: notReached,
          categories_corroboration: (mod as any).homepageContentRefreshCorroborationTally(out),
        };
        const fnOut = norm({ status: 200, body: fnBody, db: dbSnapshot(db), fetched: [...fetched].sort() });
        assertEq(fnOut, routeOut, `${name}: refreshHomepageContent() == the route (result, database, fetches)`);
      }
    }

    // S3: write-pause on → 423, nothing written, nothing fetched.
    {
      const db = freshDb();
      pauseSvc.setEnrichmentWritePause(db, { vertical: "rfb", enabled: true, reason: "parity test" }, "test");
      fetched.length = 0;
      const r = await callRoute(router, { body: { agentIds: EXPLICIT, apply: true }, headers });
      const routeOut = norm({ status: r.status, body: r.body, db: dbSnapshot(db), fetched });
      printed.S3 = routeOut;
      if (!PRINT) assertEq(routeOut, GOLDEN.S3, "S3: write-pause → the same 423, nothing written, nothing fetched");
    }

    // S4: auto-select, apply.
    {
      const db = freshDb();
      fetched.length = 0;
      const r = await callRoute(router, { body: { limit: 3 }, query: { apply: "1" }, headers });
      const routeOut = norm({ status: r.status, body: r.body, db: dbSnapshot(db), fetched: [...fetched].sort() });
      printed.S4 = routeOut;
      // dev-request 2026-10-15-homepage-refresh-autoutvalg-erstatter-ikke-
      // ubekreftede-kategorier: the auto-select now refreshes with
      // categoriesCorroborateOnly and answers with a categories_corroboration
      // tally as its LAST key. Golden S4 = the pre-change capture plus that key
      // ({corroborated:0, categories_not_supported_by_homepage:0}: every S4 row
      // has empty stored categories, so the page's categories are written as
      // before); the database and the fetches are unchanged.
      if (!PRINT) assertEq(routeOut, GOLDEN.S4, "S4: auto-select apply is unchanged apart from the categories_corroboration tally");
    }

    if (fnAvailable) {
      // Explicit-id selection = the route's own filter: umbrellas and
      // producers without a homepage are dropped, the limit caps the list.
      const db = freshDb();
      const sel = (mod as any).selectHomepageContentRefreshTargetsByIds(db, [...EXPLICIT, "missing", 7, " "], 25);
      assertEq(
        sel.map((t: any) => t.agent_id),
        ["hp-google", "hp-curated", "hp-dead", "hp-slow", "hp-spam"],
        "P1: selection by ids drops umbrella / no-homepage / unknown / non-string ids",
      );
      assertEq(
        (mod as any).selectHomepageContentRefreshTargetsByIds(db, EXPLICIT, 2).map((t: any) => t.agent_id),
        ["hp-google", "hp-curated"],
        "P2: the limit caps the id list before filtering (as the route did)",
      );

      // The caller-only bounds (never set by the route).
      // D1: a deadline already passed → nothing fetched, nothing written, no strike.
      {
        const db2 = freshDb();
        const before = norm(dbSnapshot(db2));
        fetched.length = 0;
        const t = (mod as any).selectHomepageContentRefreshTargetsByIds(db2, ["hp-google", "hp-dead"], 25);
        const out = await (mod as any).refreshHomepageContent(db2, t, { dryRun: false, deadlineAt: Date.now() - 1 });
        assertEq(
          [fetched.length, out.errors.map((e: any) => e.error), norm(dbSnapshot(db2)) === before],
          [0, ["refresh_deadline_exceeded for https://google-gard.no", "refresh_deadline_exceeded for https://dead-gard.no"], true],
          "D1: past deadline → no fetch, deadline error per agent, database untouched (no parking strike)",
        );
      }
      // D2: the injected fetchImpl is used instead of the global fetch, and
      // the SSRF guard still runs first (a link-local host never reaches it).
      {
        const db2 = freshDb();
        db2.prepare(`UPDATE agent_knowledge SET website = 'http://169.254.169.254' WHERE agent_id = 'hp-dead'`).run();
        const seen: string[] = [];
        const own = (async (url: string) => {
          seen.push(new URL(url).host);
          return stubFetch(url);
        }) as unknown as typeof fetch;
        (globalThis as any).fetch = async () => {
          throw new Error("global fetch must not be used");
        };
        const t = (mod as any).selectHomepageContentRefreshTargetsByIds(db2, ["hp-google", "hp-dead"], 25);
        const out = await (mod as any).refreshHomepageContent(db2, t, { dryRun: false, fetchImpl: own });
        (globalThis as any).fetch = stubFetch;
        assertEq(
          [seen.includes("google-gard.no"), seen.includes("169.254.169.254"), out.changed.map((c: any) => c.agent_id), out.errors.map((e: any) => e.error)],
          [true, false, ["hp-google"], ["fetch_failed:ssrf_blocked (permanent) for http://169.254.169.254"]],
          "D2: fetchImpl seam used; the SSRF guard still blocks a link-local host before any fetch",
        );
      }
      // D3: a hanging site is aborted at the deadline; the late agent writes nothing.
      {
        const db2 = freshDb();
        const before = norm(dbSnapshot(db2));
        const hanging = ((_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_res, rej) => {
            if (init?.signal?.aborted) return rej(init.signal.reason);
            init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
          })) as unknown as typeof fetch;
        const t = (mod as any).selectHomepageContentRefreshTargetsByIds(db2, ["hp-google"], 25);
        // AbortSignal.timeout's timer is unref'd: hold the event loop open so a
        // standalone run does not exit while only the hanging fetch is pending.
        const keepAlive = setTimeout(() => undefined, 5000);
        const t0 = Date.now();
        const out = await (mod as any).refreshHomepageContent(db2, t, { dryRun: false, fetchImpl: hanging, deadlineAt: Date.now() + 150 });
        const ms = Date.now() - t0;
        clearTimeout(keepAlive);
        assertEq(
          [ms < 2000, out.errors.map((e: any) => e.error), norm(dbSnapshot(db2)) === before],
          [true, ["refresh_deadline_exceeded for https://google-gard.no"], true],
          "D3: a hanging homepage is cut off at the deadline; nothing written, no strike",
        );
      }
    }

    // ── dev-request 2026-10-31 S1: the route's own time budget and ?limit ──
    // R1: slow sites → the route answers within its budget, truncated:true,
    // and the targets it did not reach get no strike, no parking and no
    // rotation stamp.
    {
      const prevBudget = process.env.HCR_ROUTE_TIME_BUDGET_MS;
      process.env.HCR_ROUTE_TIME_BUDGET_MS = "300";
      const db2 = freshDb();
      const ids = ["hp-google", "hp-dead", "hp-slow", "hp-spam", "hp-curated"];
      // hp-dead (a 404 = permanent strike when reached) hangs here too, so a
      // strike on it would show up below.
      const slowFetch = ((url: string, init?: { signal?: AbortSignal }) => {
        const host = new URL(url).host;
        if (host === "google-gard.no") return stubFetch(url);
        return new Promise((_res, rej) => {
          if (init?.signal?.aborted) return rej(init.signal.reason);
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
        });
      }) as unknown as typeof fetch;
      (globalThis as any).fetch = slowFetch;
      // Hard 5 s guard: if the route's deadline ever goes missing, the hanging
      // fetches never settle — the race then records an explicit failure
      // instead of the run exiting 0 once nothing keeps the event loop alive.
      // The ref'd guard timer also holds the loop open while AbortSignal's
      // unref'd timer is pending, and is cleared as soon as the race settles.
      const R1_TIMED_OUT = Symbol("r1-timed-out");
      let r1Guard: ReturnType<typeof setTimeout> | undefined;
      const t0 = Date.now();
      const raced = await Promise.race([
        callRoute(router, { body: { agentIds: ids, apply: true }, headers }),
        new Promise<typeof R1_TIMED_OUT>((resolve) => {
          r1Guard = setTimeout(() => resolve(R1_TIMED_OUT), 5000);
        }),
      ]);
      const ms = Date.now() - t0;
      clearTimeout(r1Guard);
      (globalThis as any).fetch = stubFetch;
      if (prevBudget === undefined) delete process.env.HCR_ROUTE_TIME_BUDGET_MS;
      else process.env.HCR_ROUTE_TIME_BUDGET_MS = prevBudget;
      if (raced === R1_TIMED_OUT) {
        failed++;
        const msg = "✗ R1: the route did not answer within 5 s — its time budget/deadline is not enforced";
        failures.push(msg);
        if (log) console.log("  " + msg);
      } else {
        const r = raced;
        const unreached = db2
          .prepare(
            `SELECT agent_id, homepage_fetch_attempts, homepage_unreachable_since, homepage_content_checked_at
               FROM agent_knowledge WHERE agent_id IN ('hp-dead','hp-slow','hp-spam','hp-curated') ORDER BY agent_id`,
          )
          .all();
        assertEq(
          [
            r.status,
            ms < 3000,
            r.body.truncated,
            r.body.not_reached,
            r.body.changed.map((c: any) => c.agent_id),
            r.body.parked_now,
            unreached.every((u: any) => u.homepage_fetch_attempts === 0 && u.homepage_unreachable_since === null && u.homepage_content_checked_at === null),
          ],
          [200, true, true, 4, ["hp-google"], [], true],
          "R1: slow sites → answer within the budget, truncated:true, not_reached:4, no strike/parking/stamp on unreached targets",
        );
      }
    }
    // R2: ?limit=5 → 5 targets; the body's limit wins over the query's.
    {
      const db2 = freshDb();
      const insA = db2.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
         VALUES (?, ?, 'd', 'test', 'post@example.no', ?, 'producer', ?, NULL)`,
      );
      const insK = db2.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, about, products, field_provenance, curated_fields, updated_at)
         VALUES (?, ?, 'x', '[]', '{}', '{}', '2020-01-01T00:00:00.000Z')`,
      );
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const id = `hp-lim-${i}`;
        ids.push(id);
        insA.run(id, `Lim ${i}`, `https://lim-${i}.no`, `kl${i}`);
        insK.run(id, `https://lim-${i}.no`);
      }
      const q = await callRoute(router, { body: { agentIds: ids }, query: { limit: "5" }, headers });
      const both = await callRoute(router, { body: { agentIds: ids, limit: 2 }, query: { limit: "5" }, headers });
      const big = await callRoute(router, { body: { agentIds: ids }, query: { limit: "500" }, headers });
      assertEq(
        [q.body.dry_run, q.body.errors.length, both.body.errors.length, big.body.errors.length, q.body.truncated, q.body.not_reached],
        [true, 5, 2, 8, false, 0],
        "R2: ?limit=5 → 5 targets; body limit 2 wins over ?limit=5; the 100 cap still applies",
      );
      assertEq(
        [
          (mod as any).resolveHomepageContentRefreshLimit(undefined, undefined),
          (mod as any).resolveHomepageContentRefreshLimit(undefined, "5"),
          (mod as any).resolveHomepageContentRefreshLimit(3, "5"),
          (mod as any).resolveHomepageContentRefreshLimit(undefined, "1000"),
          (mod as any).resolveHomepageContentRefreshLimit(undefined, "abc"),
          (mod as any).resolveHcrRouteTimeBudgetMs({}),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "1500" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "-4" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "x" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: " 2000 " }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "1500ms" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "1.5" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "0" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "999999" }),
          (mod as any).resolveHcrRouteTimeBudgetMs({ HCR_ROUTE_TIME_BUDGET_MS: "99999999999999999999" }),
        ],
        [25, 5, 3, 100, 25, 40000, 1500, 40000, 40000, 2000, 40000, 40000, 40000, 300000, 300000],
        "R3: limit (body > query, default 25, cap 100) and budget (env all-digit positive integer, clamped to 300000, else 40000) resolution",
      );
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack ?? err}`);
  } finally {
    restoreAboutJudges();
    (globalThis as any).fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevParking === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED;
    else process.env.HOMEPAGE_PARKING_DISABLED = prevParking;
    initMod.__setDbForTesting(prevDb as any);
  }
  if (PRINT) console.log(JSON.stringify(printed, null, 2));
  return { passed, failed, failures };
}

// Captured from the pre-extraction route (origin/main 8744986e); S1/S2/S4 re-captured
// 2026-10-11 (dev-request 2026-10-10-rfb-homepage-refresh-kategorinavn-som-produkter):
// the refresh no longer writes products built from category names, so `products`
// stays untouched and by_field.products is 0.
// S1/S2/S4 re-captured 2026-10-31 (dev-request S1, route time budget): the body
// gains `truncated:false, not_reached:0` after the result keys (before S4's
// categories_corroboration, still the last key); nothing else changed.
const GOLDEN: Record<string, string> = {
  S1:
    "{\"status\":200,\"body\":{\"dry_run\":false,\"scanned\":2,\"by_field\":{\"about\":1,\"products\":0,\"categories\":2,\"description\":2},\"changed\":[{\"agent_id\":\"hp-google\",\"fields\":[\"about\",\"description\",\"categories\"]},{\"agent_id\":\"hp-curated\",\"fields\":[\"description\",\"categories\"]}],\"skipped_curated\":[{\"agent_id\":\"hp-curated\",\"fields\":[\"about\"]}],\"skipped_unsubstantiated\":[],\"errors\":[{\"agent_id\":\"hp-dead\",\"error\":\"fetch_failed:http_404 (permanent) for https://dead-gard.no\"},{\"agent_id\":\"hp-slow\",\"error\":\"fetch_failed:timeout (transient) for https://slow-gard.no\"},{\"agent_id\":\"hp-spam\",\"error\":\"theme_spam_page for https://spam-gard.no\"}],\"parked_now\":[],\"about_reviews\":[{\"agent_id\":\"hp-google\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}},{\"agent_id\":\"hp-curated\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}}],\"about_judge_rejected\":0,\"about_not_supported\":0,\"about_not_better\":0,\"about_judge_unavailable\":0,\"truncated\":false,\"not_reached\":0,\"categories_corroboration\":{\"corroborated\":0,\"categories_not_supported_by_homepage\":0}},\"db\":{\"k\":[{\"agent_id\":\"hp-auto\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-curated\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}],\\\"description\\\":[{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://curated-gard.no\\\"}],\\\"categories\\\":[{\\\"value\\\":\\\"honey,eggs\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://curated-gard.no\\\"}]}\",\"curated_fields\":\"{\\\"about\\\":true}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-dead\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":1,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-google\",\"about\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"},{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://google-gard.no\\\"}],\\\"description\\\":[{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://google-gard.no\\\"}],\\\"categories\\\":[{\\\"value\\\":\\\"meat,honey,eggs\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://google-gard.no\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-noweb\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-slow\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-spam\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-umbrella\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"}],\"a\":[{\"id\":\"hp-auto\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-curated\",\"description\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"categories\":\"[\\\"honey\\\",\\\"eggs\\\"]\"},{\"id\":\"hp-dead\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-google\",\"description\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"categories\":\"[\\\"meat\\\",\\\"honey\\\",\\\"eggs\\\"]\"},{\"id\":\"hp-noweb\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-slow\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-spam\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-umbrella\",\"description\":\"d\",\"categories\":\"[]\"}]},\"fetched\":[\"curated-gard.no/\",\"curated-gard.no/about\",\"curated-gard.no/om-oss\",\"curated-gard.no/produkter\",\"dead-gard.no/\",\"google-gard.no/\",\"google-gard.no/about\",\"google-gard.no/om-oss\",\"google-gard.no/produkter\",\"slow-gard.no/\",\"slow-gard.no/\",\"spam-gard.no/\",\"spam-gard.no/about\",\"spam-gard.no/om-oss\",\"spam-gard.no/produkter\"]}",
  S2:
    "{\"status\":200,\"body\":{\"dry_run\":true,\"scanned\":2,\"by_field\":{\"about\":1,\"products\":0,\"categories\":2,\"description\":2},\"changed\":[{\"agent_id\":\"hp-google\",\"fields\":[\"about\",\"description\",\"categories\"]},{\"agent_id\":\"hp-curated\",\"fields\":[\"description\",\"categories\"]}],\"skipped_curated\":[{\"agent_id\":\"hp-curated\",\"fields\":[\"about\"]}],\"skipped_unsubstantiated\":[],\"errors\":[{\"agent_id\":\"hp-dead\",\"error\":\"fetch_failed:http_404 (permanent) for https://dead-gard.no\"},{\"agent_id\":\"hp-slow\",\"error\":\"fetch_failed:timeout (transient) for https://slow-gard.no\"},{\"agent_id\":\"hp-spam\",\"error\":\"theme_spam_page for https://spam-gard.no\"}],\"parked_now\":[],\"about_reviews\":[{\"agent_id\":\"hp-google\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}},{\"agent_id\":\"hp-curated\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}}],\"about_judge_rejected\":0,\"about_not_supported\":0,\"about_not_better\":0,\"about_judge_unavailable\":0,\"truncated\":false,\"not_reached\":0,\"categories_corroboration\":{\"corroborated\":0,\"categories_not_supported_by_homepage\":0}},\"db\":{\"k\":[{\"agent_id\":\"hp-auto\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-curated\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{\\\"about\\\":true}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-dead\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-google\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-noweb\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-slow\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-spam\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-umbrella\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"}],\"a\":[{\"id\":\"hp-auto\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-curated\",\"description\":\"Eierens egen tekst\",\"categories\":\"[]\"},{\"id\":\"hp-dead\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-google\",\"description\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"categories\":\"[]\"},{\"id\":\"hp-noweb\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-slow\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-spam\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-umbrella\",\"description\":\"d\",\"categories\":\"[]\"}]},\"fetched\":[\"curated-gard.no/\",\"curated-gard.no/about\",\"curated-gard.no/om-oss\",\"curated-gard.no/produkter\",\"dead-gard.no/\",\"google-gard.no/\",\"google-gard.no/about\",\"google-gard.no/om-oss\",\"google-gard.no/produkter\",\"slow-gard.no/\",\"slow-gard.no/\",\"spam-gard.no/\",\"spam-gard.no/about\",\"spam-gard.no/om-oss\",\"spam-gard.no/produkter\"]}",
  S3:
    "{\"status\":423,\"body\":{\"error\":\"Berikelses-skrivepause er aktiv for denne vertikalen — ingen skriving utført.\",\"paused\":true,\"vertical\":\"rfb\",\"reason\":\"parity test\",\"triggered_at\":\"<sqlts>\",\"fail_closed\":false},\"db\":{\"k\":[{\"agent_id\":\"hp-auto\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-curated\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{\\\"about\\\":true}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-dead\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-google\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-noweb\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-slow\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-spam\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-umbrella\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"}],\"a\":[{\"id\":\"hp-auto\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-curated\",\"description\":\"Eierens egen tekst\",\"categories\":\"[]\"},{\"id\":\"hp-dead\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-google\",\"description\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"categories\":\"[]\"},{\"id\":\"hp-noweb\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-slow\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-spam\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-umbrella\",\"description\":\"d\",\"categories\":\"[]\"}]},\"fetched\":[]}",
  S4:
    "{\"status\":200,\"body\":{\"dry_run\":false,\"scanned\":3,\"by_field\":{\"about\":2,\"products\":0,\"categories\":3,\"description\":3},\"changed\":[{\"agent_id\":\"hp-auto\",\"fields\":[\"about\",\"description\",\"categories\"]},{\"agent_id\":\"hp-google\",\"fields\":[\"about\",\"description\",\"categories\"]},{\"agent_id\":\"hp-curated\",\"fields\":[\"description\",\"categories\"]}],\"skipped_curated\":[{\"agent_id\":\"hp-curated\",\"fields\":[\"about\"]}],\"skipped_unsubstantiated\":[],\"errors\":[],\"parked_now\":[],\"about_reviews\":[{\"agent_id\":\"hp-auto\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}},{\"agent_id\":\"hp-google\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}},{\"agent_id\":\"hp-curated\",\"about_review\":{\"candidate\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"quality\":{\"approved\":true,\"reasoning\":\"stub: godkjent\"},\"facts\":{\"supported\":true,\"unsupported_claims\":[]},\"comparison\":{\"verdict\":\"BEDRE\",\"reasoning\":\"stub: bedre\"},\"decision\":\"write\"}}],\"about_judge_rejected\":0,\"about_not_supported\":0,\"about_not_better\":0,\"about_judge_unavailable\":0,\"truncated\":false,\"not_reached\":0,\"categories_corroboration\":{\"corroborated\":0,\"categories_not_supported_by_homepage\":0}},\"db\":{\"k\":[{\"agent_id\":\"hp-auto\",\"about\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"},{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://auto-gard.no\\\"}],\\\"description\\\":[{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://auto-gard.no\\\"}],\\\"categories\\\":[{\\\"value\\\":\\\"honey,eggs\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://auto-gard.no\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-curated\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}],\\\"description\\\":[{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://curated-gard.no\\\"}],\\\"categories\\\":[{\\\"value\\\":\\\"honey,eggs\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://curated-gard.no\\\"}]}\",\"curated_fields\":\"{\\\"about\\\":true}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-dead\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-google\",\"about\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"},{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://google-gard.no\\\"}],\\\"description\\\":[{\\\"value\\\":\\\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://google-gard.no\\\"}],\\\"categories\\\":[{\\\"value\\\":\\\"meat,honey,eggs\\\",\\\"source_type\\\":\\\"website_homepage\\\",\\\"fetched_at\\\":\\\"<iso>\\\",\\\"source_url\\\":\\\"https://google-gard.no\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-noweb\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-slow\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-spam\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"},{\"agent_id\":\"hp-umbrella\",\"about\":\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\",\"products\":\"[]\",\"field_provenance\":\"{\\\"about\\\":[{\\\"source_type\\\":\\\"google_places\\\",\\\"value\\\":\\\"Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.\\\",\\\"fetched_at\\\":\\\"<iso>\\\"}]}\",\"curated_fields\":\"{}\",\"homepage_fetch_attempts\":0,\"homepage_unreachable_since\":null,\"updated_at\":\"<iso>\"}],\"a\":[{\"id\":\"hp-auto\",\"description\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"categories\":\"[\\\"honey\\\",\\\"eggs\\\"]\"},{\"id\":\"hp-curated\",\"description\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"categories\":\"[\\\"honey\\\",\\\"eggs\\\"]\"},{\"id\":\"hp-dead\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-google\",\"description\":\"Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.\",\"categories\":\"[\\\"meat\\\",\\\"honey\\\",\\\"eggs\\\"]\"},{\"id\":\"hp-noweb\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-slow\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-spam\",\"description\":\"d\",\"categories\":\"[]\"},{\"id\":\"hp-umbrella\",\"description\":\"d\",\"categories\":\"[]\"}]},\"fetched\":[\"auto-gard.no/\",\"auto-gard.no/about\",\"auto-gard.no/om-oss\",\"auto-gard.no/produkter\",\"curated-gard.no/\",\"curated-gard.no/about\",\"curated-gard.no/om-oss\",\"curated-gard.no/produkter\",\"google-gard.no/\",\"google-gard.no/about\",\"google-gard.no/om-oss\",\"google-gard.no/produkter\"]}",
};

if (require.main === module) {
  runHomepageContentRefreshExtractionParityTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}

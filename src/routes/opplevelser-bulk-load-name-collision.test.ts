/**
 * opplevelser-bulk-load-name-collision.test.ts — POST /api/opplevelser/admin/
 * bulk-load stamps experience_providers.name_collision at first harvest when
 * classifyProvider()'s Brreg verdict carries name_collision:true (>=2 Brreg
 * entities share the name and kommune didn't disambiguate).
 *
 * Same harness as opplevelser-bulk-load-scope-gate.test.ts: in-memory
 * experiences DB, fresh requires, router.handle(), Brreg stubbed via
 * __setBrregFetchForTesting, in-memory RFB db for the blocklist gate, mocked
 * globalThis.fetch for the admission-gate judge.
 *
 * Covers:
 *   (a) apply, colliding name, evidence-backed row -> name_collision = 1 in
 *       DB, flagged_name_collision:1 with the name listed.
 *   (b) dry-run, same input -> flagged_name_collision:1, no provider row.
 *   (c) non-colliding name -> name_collision stays 0, counter 0.
 *   (d) existing provider re-harvested with a colliding name -> stamped.
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
  opts: { method?: "GET" | "POST"; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/bulk-load";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
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

export function runOpplevelserBulkLoadNameCollisionTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "bulk-load-name-collision-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-name-collision";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const experienceBrregPath = require.resolve("../services/experience-brreg");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, experienceBrregPath, opplevelserPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let prevRfbDb: unknown = null;
    let expBrreg: typeof import("../services/experience-brreg") | null = null;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      expBrreg = require("../services/experience-brreg") as typeof import("../services/experience-brreg");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const initMod = require("../database/init") as typeof import("../database/init");
      const RfbDatabase = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new RfbDatabase(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      // Brreg stub: a name containing "Tvilling" returns two same-named
      // entities in another kommune (collision -> unverified +
      // name_collision:true); every other name returns no candidates
      // (plain unverified, name_collision:false).
      expBrreg.__setBrregFetchForTesting(async (url: string) => {
        const navn = decodeURIComponent(String(url).split("navn=")[1]?.split("&")[0] ?? "");
        const enheter = navn.includes("Tvilling")
          ? [
              { organisasjonsnummer: "911111111", navn, naeringskode1: { kode: "01.410" }, forretningsadresse: { kommune: "BERGEN" } },
              { organisasjonsnummer: "922222222", navn, naeringskode1: { kode: "01.410" }, forretningsadresse: { kommune: "TROMSØ" } },
            ]
          : [];
        return { ok: true, status: 200, json: async () => ({ _embedded: { enheter } }) };
      });

      globalThis.fetch = (async (url: any) => {
        const urlStr = String(url);
        if (urlStr === "https://api.anthropic.com/v1/messages") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "MATCH\nStemmer med kilden." }] }),
          } as unknown as Response;
        }
        const bytes = new TextEncoder().encode("<html><body>Gårdsutsalg med ost.</body></html>");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url: urlStr,
          headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
          arrayBuffer: async () => bytes.buffer,
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const providerByName = (navn: string) =>
        expDb.prepare("SELECT id, name_collision FROM experience_providers WHERE navn = ?").get(navn) as
          | { id: string; name_collision: number }
          | undefined;
      const row = (provider_name: string, title: string) => ({
        title, provider_name, category: "mat_drikke", kommune: "Voss", fylke: "Vestland",
        confidence: "high", evidence_url: "https://evidence.example/" + encodeURIComponent(title),
      });

      const COLLIDING = "Tvilling Gardsysteri AS";
      const PAYLOAD = { experiences: [row(COLLIDING, "Ostesmaking på gården")] };

      // ── (b) dry-run first: counts, writes nothing ──────────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: PAYLOAD });
        assertEq(r.status, 200, "nc-b1: dry-run -> 200");
        assertEq(r.body.dry_run, true, "nc-b2: dry_run:true");
        assertEq(r.body.flagged_name_collision, 1, "nc-b3: dry-run counts the would-be-stamped provider");
        assertEq(r.body.flagged_name_collision_providers, [COLLIDING], "nc-b4: dry-run lists the provider name");
        assertEq(providerByName(COLLIDING), undefined, "nc-b5: dry-run created no provider row");
        const stamped = (expDb.prepare("SELECT COUNT(*) AS n FROM experience_providers WHERE name_collision = 1").get() as { n: number }).n;
        assertEq(stamped, 0, "nc-b6: dry-run stamped nothing");
      }

      // ── (a) apply: new provider is created and stamped ─────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { ...PAYLOAD, apply: true } });
        assertEq(r.status, 200, "nc-a1: apply -> 200");
        assertEq(r.body.providers_inserted, 1, "nc-a2: evidence-backed unverified provider inserted");
        assertEq(r.body.flagged_name_collision, 1, "nc-a3: apply counter 1");
        assertEq(r.body.flagged_name_collision_providers, [COLLIDING], "nc-a4: apply lists the provider name");
        assertEq(providerByName(COLLIDING)?.name_collision, 1, "nc-a5: experience_providers.name_collision = 1");
      }

      // ── (c) non-colliding name: column stays 0, counter 0 ──────────────
      {
        const PLAIN = "Solberg Gardsmat AS";
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { apply: true, experiences: [row(PLAIN, "Gårdsbutikk med lokal mat")] },
        });
        assertEq(r.status, 200, "nc-c1: apply -> 200");
        assertEq(r.body.flagged_name_collision, 0, "nc-c2: counter 0");
        assertEq(r.body.flagged_name_collision_providers, [], "nc-c3: empty list");
        const p = providerByName(PLAIN);
        assertEq(!!p, true, "nc-c4: provider created");
        assertEq(p?.name_collision, 0, "nc-c5: name_collision stays 0");
      }

      // ── (d) existing provider re-harvested with a colliding name ──────
      {
        const EXISTING = "Tvilling Bryggeri AS";
        const existingId = expStore.createProvider({ navn: EXISTING, kommune: "Voss", source: "seed" });
        assertEq(providerByName(EXISTING)?.name_collision, 0, "nc-d1: precondition: not stamped");
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { apply: true, experiences: [row(EXISTING, "Ølsmaking i bryggeriet")] },
        });
        assertEq(r.status, 200, "nc-d2: apply -> 200");
        assertEq(r.body.providers_inserted, 0, "nc-d3: existing provider reused");
        assertEq(r.body.flagged_name_collision, 1, "nc-d4: counter 1");
        const p = providerByName(EXISTING);
        assertEq(p?.id, existingId, "nc-d5: same provider row");
        assertEq(p?.name_collision, 1, "nc-d6: existing provider stamped");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-bulk-load-name-collision: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      try { expBrreg?.__setBrregFetchForTesting(null); } catch { /* best-effort */ }
      try {
        if (prevRfbDb) {
          (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb as any);
        }
      } catch { /* best-effort */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-bulk-load-name-collision.test.ts`
if (require.main === module) {
  runOpplevelserBulkLoadNameCollisionTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

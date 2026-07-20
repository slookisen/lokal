/**
 * opplevelser-gardssalg-mcp-discoverability.test.ts — dev-request
 * 2026-07-20-gardssalg-mcp-discoverability: the gårdssalg vertical (74-row
 * farm-sale drink producers in experience_providers) had ZERO presence in
 * the agent-facing MCP surface — list_experience_categories never mentioned
 * it, and there was no tool at all to search/filter gårdssalg producers.
 *
 * Covers:
 *   (a) list_experience_categories now appends a gårdssalg entry with a
 *       real, live count (== countGardssalgProviders()).
 *   (b) the new discover_gardssalg tool returns booking.live:false + the
 *       honest dark-launch note when BOOKING_DISPATCH_ENABLED is unset,
 *       even for a provider whose OWN booking_live=1 — the global master
 *       switch still gates dispatch (isBookingPaused()'s double-gate).
 *   (c) booking.live:true (and the "book directly" note) once BOTH the env
 *       flag AND the provider's own booking_live=1 are set.
 *   (d) a catalog_hidden=1 seeded row NEVER appears in discover_gardssalg
 *       output, in list_experience_categories's count, or in any filter
 *       combination — the load-bearing data-leak regression test.
 *
 * Same real-MCP-session-over-HTTP approach as
 * opplevelser-discover-geo.test.ts's (f) block (the synthetic router.handle()
 * shortcut can't drive the MCP SDK's StreamableHTTPServerTransport).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-mcp-discoverability.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserGardssalgMcpDiscoverabilityTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Parses a JSON-RPC response body that may be a raw JSON object or an SSE
// stream ("event: message\ndata: {...}\n\n") — same helper as
// opplevelser-discover-geo.test.ts / experiences-llms-examples.test.ts,
// needed because the MCP Streamable HTTP transport can reply either way
// depending on the Accept header negotiation.
function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

export function runOpplevelserGardssalgMcpDiscoverabilityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.BOOKING_DISPATCH_ENABLED;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const experiencesMcpPath = require.resolve("./experiences-mcp");
    const cachePaths = [dbFactoryPath, expStorePath, experiencesMcpPath];
    for (const p of cachePaths) delete require.cache[p];

    let server: http.Server | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── Fixtures ────────────────────────────────────────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, booking_live, catalog_hidden, lat, lon, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @booking_live, @catalog_hidden, @lat, @lon, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`
      );
      // gm-live: real, publicly-listed, onboarded for booking (booking_live=1).
      insertProvider.run({
        id: "gm-live", navn: "Gårdsmat Live AS", fylke: "Vestland", kommune: "Bergen", producer_type: "bryggeri",
        booking_live: 1, catalog_hidden: null, lat: 60.39, lon: 5.32, slug: "gaardsmat-live",
      });
      // gm-hidden: catalog_hidden=1 test provider — matches every filter
      // below (same fylke/kommune/producer_type/booking_live as gm-live) yet
      // must NEVER appear in discover_gardssalg output or the category count.
      insertProvider.run({
        id: "gm-hidden", navn: "Skjult Gårdsmat AS", fylke: "Vestland", kommune: "Bergen", producer_type: "bryggeri",
        booking_live: 1, catalog_hidden: 1, lat: 60.40, lon: 5.33, slug: "skjult-gaardsmat",
      });

      assertEq(expStore.countGardssalgProviders(), 1, "fixture sanity: countGardssalgProviders() sees only the 1 non-hidden row");

      // ── Real MCP session over HTTP ───────────────────────────────────────
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpRouter as any)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const initRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gardssalg-mcp-test-client", version: "1.0.0" } },
          id: "1",
        }),
      });
      assertTrue(initRes.ok, `init: MCP initialize returns 2xx (got ${initRes.status})`);
      const sessionId = initRes.headers.get("mcp-session-id");
      assertTrue(!!sessionId, "init2: MCP initialize response carries an mcp-session-id header");
      await initRes.text();

      async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
        const res = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "tools/call",
            params: { name, arguments: args },
            id: String(Math.random()),
          }),
        });
        assertTrue(res.ok, `${name}: tools/call returns 2xx (got ${res.status})`);
        const body = parseJsonRpcBody(await res.text(), res.headers.get("content-type"));
        assertTrue(!("error" in body), `${name}: no top-level JSON-RPC error (got ${JSON.stringify(body.error)})`);
        const text = body.result?.content?.[0]?.text;
        assertTrue(typeof text === "string", `${name}: returns a text content block`);
        return JSON.parse(text);
      }

      // ── (a) list_experience_categories includes the gårdssalg entry ──────
      const categoriesResult = await callTool("list_experience_categories");
      const gardssalgEntry = (categoriesResult.categories as any[]).find((c) => c.category === "gardssalg_smaking");
      assertTrue(!!gardssalgEntry, "a1: list_experience_categories includes a gardssalg_smaking entry");
      assertEq(gardssalgEntry?.count, 1, "a2: gardssalg_smaking entry's count matches countGardssalgProviders() (hidden row excluded)");
      assertEq(categoriesResult.count, categoriesResult.categories.length, "a3: top-level count matches the categories array length (gårdssalg entry included)");

      // ── (d, part 1) discover_gardssalg never leaks the hidden row ────────
      const discoverAllResult = await callTool("discover_gardssalg", { fylke: "Vestland", kommune: "Bergen", producer_type: "bryggeri", booking_live: true });
      const names = (discoverAllResult.gardssalg_producers as any[]).map((p) => p.navn);
      assertTrue(!names.includes("Skjult Gårdsmat AS"), "d1: discover_gardssalg never returns the catalog_hidden=1 row, even matching every filter it has");
      assertTrue(names.includes("Gårdsmat Live AS"), "d2: discover_gardssalg still returns the real (non-hidden) matching row");
      assertEq(discoverAllResult.count, 1, "d3: exactly 1 producer returned (the hidden one is truly absent, not just filtered by name)");

      // ── (b) BOOKING_DISPATCH_ENABLED unset → booking.live:false + dark-
      //     launch note, even though gm-live's OWN booking_live=1 ──────────
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const pausedResult = await callTool("discover_gardssalg", { fylke: "Vestland" });
      const gmLivePaused = (pausedResult.gardssalg_producers as any[]).find((p) => p.navn === "Gårdsmat Live AS");
      assertTrue(!!gmLivePaused, "b1: gm-live present in the Vestland result");
      assertEq(gmLivePaused?.booking?.live, false, "b2: BOOKING_DISPATCH_ENABLED unset -> booking.live:false even for a booking_live=1 provider");
      assertEq(gmLivePaused?.booking?.mode, "paused", "b3: booking.mode is 'paused' when dispatch is globally off");
      assertTrue(
        typeof gmLivePaused?.booking?.note === "string" && /åpner snart|open soon/i.test(gmLivePaused.booking.note),
        "b4: booking.note carries the honest dark-launch message when paused"
      );
      assertTrue(!(pausedResult.gardssalg_producers as any[]).some((p) => p.navn === "Skjult Gårdsmat AS"), "b5: hidden row still absent with dispatch off");

      // ── (c) BOOKING_DISPATCH_ENABLED=true + provider booking_live=1 →
      //     booking.live:true ──────────────────────────────────────────────
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      const liveResult = await callTool("discover_gardssalg", { fylke: "Vestland" });
      const gmLiveLive = (liveResult.gardssalg_producers as any[]).find((p) => p.navn === "Gårdsmat Live AS");
      assertTrue(!!gmLiveLive, "c1: gm-live present in the Vestland result");
      assertEq(gmLiveLive?.booking?.live, true, "c2: BOOKING_DISPATCH_ENABLED=true + provider booking_live=1 -> booking.live:true");
      assertEq(gmLiveLive?.booking?.mode, "request", "c3: booking.mode is 'request' when live");
      assertTrue(
        typeof gmLiveLive?.booking?.note === "string" && /book direkte|book directly/i.test(gmLiveLive.booking.note),
        "c4: booking.note carries the 'book directly' message when live"
      );
      assertTrue(!(liveResult.gardssalg_producers as any[]).some((p) => p.navn === "Skjult Gårdsmat AS"), "c5: hidden row still absent even with dispatch on globally (it is never returned by the query at all)");

      // ── (d, part 2) profile_url shape ────────────────────────────────────
      assertEq(gmLiveLive?.profile_url, "https://opplevagent.no/kategori/gardssalg/produsent/gaardsmat-live", "d4: profile_url is built from the provider's slug");

      // ── zero-results shape ────────────────────────────────────────────────
      const zeroResult = await callTool("discover_gardssalg", { fylke: "Ingen-Fylke-Finnes" });
      assertEq(zeroResult.count, 0, "z1: an impossible fylke returns count 0");
      assertTrue(/Ingen gårdssalg-produsenter funnet/.test(zeroResult.summary), "z2: zero-result summary uses the honest 'ingen funnet' copy");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-mcp-discoverability: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-mcp-discoverability.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgMcpDiscoverabilityTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

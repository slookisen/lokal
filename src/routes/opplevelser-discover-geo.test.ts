/**
 * opplevelser-discover-geo.test.ts — dev-request
 * 2026-07-04-opplevagent-naer-meg-geosok, item 2: geo params (lat/lng/
 * radius_km/sort=distance) on the discover API + discover_experiences MCP
 * tool + opplevelser_discover A2A skill + openapi.json + llms.txt.
 *
 * Covers, per the dev-request's acceptance criteria:
 *   (a) omitting lat/lng/radius_km/sort produces unchanged behavior — no
 *       distance_km/geo_precision fields, no radius filtering, same rows.
 *   (b) lat/lng/radius_km filters to the radius, sorts ascending by
 *       distance, attaches a rounded distance_km + honest geo_precision.
 *   (c) a row with geo_precision IS NULL (never geocoded) is excluded from
 *       a geo-filtered result rather than shown with a fabricated distance.
 *   (d) radius_km with zero matches returns an empty array, not an error.
 *   (e) lat without lng (or vice versa) is a 400 Invalid query, not a crash.
 *   (f) the discover_experiences MCP tool accepts the same args and returns
 *       the same distance_km/geo_precision shape (real MCP session handshake,
 *       mirrors experiences-llms-examples.test.ts's approach since the
 *       synthetic router.handle() shortcut can't drive the MCP SDK's
 *       StreamableHTTPServerTransport).
 *   (g) the opplevelser_discover A2A skill (handleExperiencesMessageSend)
 *       accepts the same structured args and surfaces distance_km/
 *       geo_precision on the returned experience rows.
 *   (h) openapi.json documents lat/lng/radius_km/sort + distance_km/
 *       geo_precision on the Experience schema.
 *   (i) llms.txt documents the new params.
 *
 * Fixtures: a Tromsø-area provider with two geocoded experiences (one
 * address-precision at the exact origin, one kommune-precision ~35km away),
 * one Oslo experience (address-precision, ~1400km away — used to prove
 * radius exclusion), and one Tromsø-area experience with no geocode at all
 * (geo_precision IS NULL — used to prove honest exclusion).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-discover-geo.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserDiscoverGeoTests() and folds its pass/fail counts into
 *      the `npm test` summary (see opplevelser-discover-relax.test.ts for
 *      the precedent this follows).
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : null });
    });
  });
}

// Parses a JSON-RPC response body that may be a raw JSON object or an SSE
// stream ("event: message\ndata: {...}\n\n") — same helper as
// experiences-llms-examples.test.ts, needed because the MCP Streamable HTTP
// transport can reply either way depending on the Accept header negotiation.
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

export function runOpplevelserDiscoverGeoTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevBaseUrl = process.env.OPPLEVAGENT_BASE_URL;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const experiencesA2aPath = require.resolve("./experiences-a2a");
    const experiencesMcpPath = require.resolve("./experiences-mcp");
    const openapiPath = require.resolve("../services/experiences-openapi");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, opplevelserPath, experiencesA2aPath, experiencesMcpPath, openapiPath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    let server: http.Server | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");

      // ── Fixtures ──────────────────────────────────────────────────────
      const tromsoProviderId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const osloProviderId = expStore.createProvider({
        navn: "Oslo Byvandring AS", fylke: "Oslo", kommune: "Oslo",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // Right at the search origin — distance ≈ 0.0 km, address-precision.
      expStore.createExperience({
        title: "Nordlysjakt i sentrum", provider_id: tromsoProviderId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
        loc_lat: 69.65, loc_lon: 18.95, geo_precision: "address",
      });
      // ~35 km from the origin (well within a 50km radius), kommune-precision.
      expStore.createExperience({
        title: "Fjordtur utenfor byen", provider_id: tromsoProviderId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
        loc_lat: 69.90, loc_lon: 19.50, geo_precision: "kommune",
      });
      // Oslo — >1000 km from the Tromsø origin, must be excluded by radius_km=50.
      expStore.createExperience({
        title: "Oslo-tur", provider_id: osloProviderId,
        provider_match_status: "matched", kommune: "Oslo", fylke: "Oslo",
        verification_status: "verified", confidence: "high",
        loc_lat: 59.9139, loc_lon: 10.7522, geo_precision: "address",
      });
      // Never geocoded — geo_precision IS NULL. Must never get a fabricated
      // distance_km; must be excluded from any geo-filtered result.
      expStore.createExperience({
        title: "Ikke-geokodet tur", provider_id: tromsoProviderId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) No geo params → unchanged behavior ─────────────────────────
      const resNoGeo = await callRoute(opplevelserRouter, "/discover?fylke=Troms%20og%20Finnmark");
      assertTrue(resNoGeo.handled, "a1: GET /discover (no geo) is handled");
      assertEq(resNoGeo.status, 200, "a2: GET /discover (no geo) returns 200");
      assertEq(resNoGeo.body.count, 3, "a3: no-geo query returns all 3 Tromsø-fylke fixtures (incl. the ungeocoded one)");
      for (const row of resNoGeo.body.results) {
        assertTrue(!("distance_km" in row), `a4: result row "${row.title}" has no distance_km when lat/lng omitted`);
        assertTrue(!("geo_precision" in row), `a5: result row "${row.title}" has no geo_precision when lat/lng omitted`);
      }

      // ── (b) lat/lng/radius_km → filters + sorts + distance_km + precision ──
      const resGeo = await callRoute(opplevelserRouter, "/discover?lat=69.65&lng=18.95&radius_km=50");
      assertTrue(resGeo.handled, "b1: GET /discover (geo) is handled");
      assertEq(resGeo.status, 200, "b2: GET /discover (geo) returns 200");
      assertEq(resGeo.body.count, 2, "b3: radius_km=50 around Tromsø keeps exactly the 2 nearby rows (Oslo + ungeocoded excluded)");
      const titles = resGeo.body.results.map((r: any) => r.title);
      assertEq(titles, ["Nordlysjakt i sentrum", "Fjordtur utenfor byen"], "b4: results sorted ascending by distance (nearest first)");
      const [first, second] = resGeo.body.results;
      assertTrue(typeof first.distance_km === "number" && first.distance_km >= 0 && first.distance_km < 1, "b5: nearest row's distance_km is ~0 (rounded sensibly)");
      assertEq(first.geo_precision, "address", "b6: nearest row honestly reports address-precision");
      assertTrue(typeof second.distance_km === "number" && second.distance_km > first.distance_km && second.distance_km < 50, "b7: second row's distance_km is greater than the first's and within the radius");
      assertEq(second.geo_precision, "kommune", "b8: second row honestly reports kommune-precision (approximate)");

      // ── (c) geo_precision IS NULL excluded from geo-filtered results ───
      assertTrue(!titles.includes("Ikke-geokodet tur"), "c1: the never-geocoded row is excluded from the geo-filtered result");

      // ── (d) radius_km with no matches → empty array, not an error ──────
      const resEmpty = await callRoute(opplevelserRouter, "/discover?lat=78.0&lng=15.0&radius_km=1");
      assertTrue(resEmpty.handled, "d1: GET /discover (impossible radius) is handled, not thrown");
      assertEq(resEmpty.status, 200, "d2: impossible radius still returns 200 (not an error)");
      assertEq(resEmpty.body.count, 0, "d3: impossible radius returns count 0");
      assertEq(resEmpty.body.results, [], "d4: impossible radius returns an empty results array");

      // ── (e) lat without lng → 400 Invalid query ────────────────────────
      const resBadGeo = await callRoute(opplevelserRouter, "/discover?lat=69.65");
      assertEq(resBadGeo.status, 400, "e1: lat without lng is rejected with 400");

      // ── (f) MCP discover_experiences tool accepts the same geo args ────
      process.env.OPPLEVAGENT_BASE_URL = "http://127.0.0.1:0"; // placeholder, overwritten once the real port is known below
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
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "geo-test-client", version: "1.0.0" } },
          id: "1",
        }),
      });
      assertTrue(initRes.ok, `f1: MCP initialize returns 2xx (got ${initRes.status})`);
      const sessionId = initRes.headers.get("mcp-session-id");
      assertTrue(!!sessionId, "f2: MCP initialize response carries an mcp-session-id header");
      // Drain the initialize response body (required before issuing the next request on some transports).
      await initRes.text();

      const callRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "tools/call",
          params: { name: "discover_experiences", arguments: { lat: 69.65, lng: 18.95, radius_km: 50 } },
          id: "2",
        }),
      });
      assertTrue(callRes.ok, `f3: MCP tools/call (geo args) returns 2xx (got ${callRes.status})`);
      const callBody = parseJsonRpcBody(await callRes.text(), callRes.headers.get("content-type"));
      assertTrue(!("error" in callBody), `f4: MCP tools/call (geo args) has no top-level error (got ${JSON.stringify(callBody.error)})`);
      const toolText = callBody.result?.content?.[0]?.text;
      assertTrue(typeof toolText === "string", "f5: MCP tools/call returns a text content block");
      const toolResult = JSON.parse(toolText);
      assertEq(toolResult.count, 2, "f6: MCP discover_experiences with lat/lng/radius_km returns the same 2 nearby rows");
      assertTrue(
        toolResult.experiences.every((e: any) => typeof e.distance_km === "number" && (e.geo_precision === "address" || e.geo_precision === "kommune")),
        "f7: every MCP result row carries a numeric distance_km and a valid geo_precision"
      );

      // ── (g) A2A opplevelser_discover skill accepts the same geo args ──
      const { handleExperiencesMessageSend } = require("./experiences-a2a") as typeof import("./experiences-a2a");
      const a2aResult: any = handleExperiencesMessageSend(
        { message: { data: { lat: 69.65, lng: 18.95, radius_km: 50 } } },
        1
      );
      const a2aExperiences = a2aResult.result.artifacts[1].parts[0].data.experiences;
      assertEq(a2aExperiences.length, 2, "g1: A2A message/send with lat/lng/radius_km returns the same 2 nearby rows");
      assertTrue(
        a2aExperiences.every((e: any) => typeof e.distance_km === "number" && (e.geo_precision === "address" || e.geo_precision === "kommune")),
        "g2: every A2A result row carries a numeric distance_km and a valid geo_precision"
      );

      // ── (h) openapi.json documents the new params + schema fields ─────
      const { getExperiencesOpenapi } = require("../services/experiences-openapi") as typeof import("../services/experiences-openapi");
      const spec: any = getExperiencesOpenapi();
      const discoverParams: any[] = spec.paths["/api/opplevelser/discover"].get.parameters;
      const paramNames = discoverParams.map((p) => p.name);
      for (const name of ["lat", "lng", "radius_km", "sort"]) {
        assertTrue(paramNames.includes(name), `h1: openapi discover params include "${name}"`);
      }
      const experienceSchema = spec.components.schemas.Experience;
      assertTrue(!!experienceSchema.properties.distance_km, "h2: Experience schema declares distance_km");
      assertTrue(!!experienceSchema.properties.geo_precision, "h3: Experience schema declares geo_precision");

      // ── (i) llms.txt documents the new params ──────────────────────────
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const llmsRes = await callRoute(seoRouter, "/llms.txt");
      // /llms.txt uses res.send(), not res.json() — callRoute() only resolves
      // on res.json(), so drive it with a minimal send-aware fake res instead.
      let llmsText = "";
      let llmsHandled = false;
      await new Promise<void>((resolve) => {
        const req: any = { method: "GET", url: "/llms.txt", originalUrl: "/llms.txt", path: "/llms.txt", query: {}, headers: {}, get() { return undefined; } };
        const res: any = {
          setHeader() {},
          send(body: unknown) { llmsText = String(body); llmsHandled = true; resolve(); },
        };
        seoRouter.handle(req, res, () => resolve());
      });
      assertTrue(llmsHandled, "i1: GET /llms.txt is handled");
      assertTrue(llmsText.includes("radius_km"), "i2: llms.txt documents radius_km");
      assertTrue(llmsText.includes("lat=69.65&lng=18.95"), "i3: llms.txt includes a near-me example");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-discover-geo: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevBaseUrl === undefined) {
        delete process.env.OPPLEVAGENT_BASE_URL;
      } else {
        process.env.OPPLEVAGENT_BASE_URL = prevBaseUrl;
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

// Standalone runner: `npx tsx src/routes/opplevelser-discover-geo.test.ts`
if (require.main === module) {
  runOpplevelserDiscoverGeoTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

/**
 * reise-page.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2c + the JSON API.
 *
 * Covers the two /reise pages and the two /reise API mounts:
 *   • RFB          seo.ts               GET /reise, /api/marketplace/reise
 *   • OpplevAgent  experiences-seo.ts   GET /reise, /api/opplevelser/reise
 *
 * The assertions that matter are the ones about what the pages must NOT say:
 *   x1-x6   HOST ISOLATION — neither page leaks the other vertical's identity,
 *           and neither API mount can be talked into reading the other's
 *           catalogue via ?sources=.
 *   n1-n7   NO FABRICATED NUMBERS — the approximate section never renders a
 *           digit, and the itinerary never calls detour_km a driving distance.
 *   f1-f5   the form degrades to a plain GET with no JavaScript required.
 *   e1-e4   empty / unroutable states say so instead of rendering a broken page.
 *   j1-j9   the JSON shape Fase 6's MCP tool will consume.
 *
 * The router-invocation harness mirrors orch19-06's invokeGet() in tests/test.ts
 * and experiences-seo-gsc-fixes.test.ts: build a mock req/res, call
 * router.handle() directly, no HTTP server, no port.
 *
 * Routing is forced to `refuse` (ROUTING_FALLBACK) or a straight line depending
 * on the case — never the network. The geocoder's fetch is stubbed to 404, so
 * only geocoding-service's hardcoded MAJOR_CITIES table resolves; Oslo and
 * Trondheim are in it, everything else honestly fails.
 *
 * Exported runReisePageTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/reise-page.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "../services/geocoding-service";
import { __clearRouteCacheForTesting } from "../services/route-corridor-service";
import { serialiseCorridor } from "./reise-api";
import type { CorridorSearchResult } from "../services/route-corridor-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface MockResponse {
  status: number;
  body: string;
  json?: any;
  headers: Record<string, string>;
}

/**
 * Invoke ONE route on a router without an HTTP server. `hostname` is set
 * because the host gates live in index.ts, not in the routers — but the SSR
 * pages read nothing from it, so the isolation assertions below are about
 * CONTENT, which is where a leak would actually show up.
 */
function invoke(
  router: any,
  url: string,
  hostname: string,
): Promise<MockResponse> {
  return new Promise((resolve) => {
    const [path, qs] = url.split("?");
    const out: MockResponse = { status: 200, body: "", headers: {} };
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path,
      baseUrl: "",
      hostname,
      query: Object.fromEntries(new URLSearchParams(qs || "")),
      headers: { host: hostname },
      lang: "no",
      get(name: string) { return name.toLowerCase() === "host" ? hostname : undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { out.status = code; this.statusCode = code; return this; },
      setHeader(k: string, v: string) { out.headers[String(k).toLowerCase()] = String(v); return this; },
      redirect(to: string) { out.status = 302; out.body = to; resolve(out); },
      json(payload: any) { out.json = payload; out.body = JSON.stringify(payload); resolve(out); },
      send(body: unknown) { out.body = String(body); resolve(out); },
    };
    router.handle(req, res, () => {
      out.status = out.status === 200 ? 404 : out.status;
      resolve(out);
    });
  });
}

function seedRfb(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at, geo_precision)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, ?, '[]', '[]', '{}', '["no"]',
            0.6, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?)
  `);
  const rows: Array<[string, string, string, number, number, string | null, string]> = [
    // Along a straight Oslo→Trondheim line, at address precision.
    ["r-exact", "Mjøsa Gårdsutsalg", "Ringsaker", 60.60, 10.90, "address", '["vegetables"]'],
    ["r-beer", "Gudbrandsdal Bryggeri", "Ringebu", 61.53, 10.15, "address", '["beverages"]'],
    // Centroid / unknown provenance — must NOT enter the itinerary.
    ["r-komm", "Sentroid Gård", "Lillehammer", 61.11, 10.47, "kommune", '["dairy"]'],
    ["r-null", "Ukjent Gård", "Otta", 61.77, 9.54, null, '["fruit"]'],
  ];
  for (const [id, name, city, lat, lng, prec, cats] of rows) {
    stmt.run(id, name, "Lokal produsent", `${id}@example.no`, `https://${id}.example.no`,
      "key-" + id, lat, lng, city, cats, prec);
  }
}

export async function runReisePageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    ok(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const prevDb = (initMod as any).__peekDbForTesting?.();
  const prevProvider = process.env.ROUTING_PROVIDER;
  const prevFallback = process.env.ROUTING_FALLBACK;
  const prevToken = process.env.MAPBOX_ACCESS_TOKEN;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  (initMod as any).__setDbForTesting(db as any);
  (initMod as any).__initSchemaForTesting(db as any);
  seedRfb(db);

  __setGeocodingFetchForTesting((async () =>
    ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch);
  __clearGeocodeCacheForTesting();
  __clearRouteCacheForTesting();

  // No Mapbox token in tests, ever. The straight-line substitute is what runs,
  // which also means every case below exercises the degraded path's honesty.
  delete process.env.MAPBOX_ACCESS_TOKEN;
  delete process.env.ROUTING_PROVIDER;
  process.env.ROUTING_FALLBACK = "straight_line";

  // seo.ts's shell() and the /reise handler both call getConfig(), which throws
  // unless the vertical configs were cold-loaded at boot. Same best-effort load
  // as sok-search-honesty.test.ts.
  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    loadConfigsAtBoot();
  } catch { /* already loaded by another suite, or the dir is missing in CI */ }

  const seoRouter = require("./seo").default;
  const expSeoRouter = require("./experiences-seo").default;
  const marketplaceRouter = require("./marketplace").default;

  try {
    // ══ f: the form, with no query ════════════════════════════════════
    {
      const r = await invoke(seoRouter, "/reise", "rettfrabonden.com");
      eq(r.status, 200, "f1: RFB /reise renders without a query");
      ok(/name="from"/.test(r.body) && /name="to"/.test(r.body),
        "f2: …with from and to fields");
      ok(/type="range"[^>]*name="detour"/.test(r.body), "f3: …and a detour slider");
      ok(/<form[^>]*method="GET"/.test(r.body),
        "f4: …as a plain GET form — the page works with JavaScript disabled");
      ok(/name="drink"/.test(r.body), "f5: …with the drink filter Daniel asked for");

      const e = await invoke(expSeoRouter, "/reise", "opplevagent.no");
      eq(e.status, 200, "f6: OpplevAgent /reise renders too");
      ok(/name="from"/.test(e.body) && /type="range"/.test(e.body) && /name="drink"/.test(e.body),
        "f7: …with the same three controls");
    }

    // ══ x: HOST ISOLATION ═════════════════════════════════════════════
    //
    // The existing orch19-* / mcpcard-* families assert opplevagent and dental
    // surfaces never carry RFB identity. A new page on both hosts is exactly
    // the kind of thing that breaks that, so it is asserted here directly.
    {
      const rfb = await invoke(seoRouter, "/reise?from=Oslo&to=Trondheim", "rettfrabonden.com");
      const exp = await invoke(expSeoRouter, "/reise?from=Oslo&to=Trondheim", "opplevagent.no");

      // On the RFB side the assertion is scoped to the CONTENT this page
      // generates, not the whole document. Two pre-existing, deliberate
      // mentions live in seo.ts's shared shell and are not leaks:
      //   • seo.ts:478 — the service-worker registration guard, which names
      //     finn-tannlege.com and opplevagent.no precisely in order to NOT
      //     register on them. Removing it would be the bug.
      //   • seo.ts:1263-1264 — the homepage's .network-strip, which links the
      //     sister sites on purpose (RFB is the only vertical that does).
      // Neither is reachable from /reise's own markup, and asserting on the
      // full document would just pin the shell's internals.
      const rfbContent = rfb.body.slice(
        Math.max(0, rfb.body.indexOf('class="reise-hero"')),
        rfb.body.indexOf("<footer") > 0 ? rfb.body.indexOf("<footer") : undefined,
      );
      ok(rfbContent.length > 200, "x0: the RFB /reise content block was located");
      ok(!/Opplevagent/i.test(rfbContent), "x1: the RFB /reise content does not mention Opplevagent");
      ok(!/opplevagent\.no/i.test(rfbContent), "x2: …nor link to opplevagent.no");
      ok(!/tannlege/i.test(rfbContent), "x3: …nor the dental vertical");

      ok(!/Rett fra Bonden/i.test(exp.body), "x4: the OpplevAgent page does not mention Rett fra Bonden");
      ok(!/rettfrabonden\.no|rettfrabonden\.com/i.test(exp.body), "x5: …nor link to rettfrabonden.com");
      ok(!/tannlege|finn-tannlege/i.test(exp.body), "x6: …nor the dental vertical");

      // Neither page should be indexable — unbounded from/to is scaled-template
      // content, which Google's March-2026 update penalises.
      ok(/noindex/.test(rfb.body), "x7: the RFB page is noindex");
      ok(/noindex/.test(exp.body), "x8: the OpplevAgent page is noindex");
    }

    // ══ n: NO FABRICATED NUMBERS ══════════════════════════════════════
    {
      const r = await invoke(seoRouter, "/reise?from=Oslo&to=Trondheim&detour=40", "rettfrabonden.com");
      eq(r.status, 200, "n1: a real corridor query renders");

      // Straight-line mode (no Mapbox token in tests) suppresses detour_km
      // entirely, and the page must say why rather than quietly omitting it.
      ok(/luftlinje/i.test(r.body),
        "n2: with no routing token the page SAYS it is showing a straight line, not a route");
      // Scoped to the itinerary rows: the summary line legitimately restates
      // the slider ("N stopp innenfor 20 km fra ruten"), which is a statement
      // about the FILTER, not a measurement of any producer. What must not
      // appear is a per-producer offset.
      const rows = (r.body.match(/<div class="reise-detour">[\s\S]*?<\/div>/g) || []).join("\n");
      ok(!/\d+[,.]\d+\s*km fra ruten/.test(rows),
        "n3: …and no producer row prints a «km fra ruten» figure, because the line is not the road");
      ok(rows.length === 0 || /langs ruten/.test(rows),
        "n3b: …the rows say «langs ruten» instead");
      ok(/etter \d+ km/.test(r.body),
        "n4: …but still shows travel order, which is real even on a straight line");

      // The itinerary must never call the offset a driving distance.
      ok(!/km å kjøre|km kjøring til|kjøreavstand/i.test(r.body),
        "n5: the page never calls the corridor offset a driving distance");

      // The approximate section: places, never numbers.
      const approxMatch = r.body.match(/<section class="reise-approx">[\s\S]*?<\/section>/);
      if (approxMatch) {
        const inner = approxMatch[0].replace(/<h2>[\s\S]*?<\/h2>/, "");
        ok(!/\d+[,.]\d+\s*km/.test(inner),
          "n6: the approximate section contains no km figure for any producer");
      } else {
        ok(true, "n6: (no approximate section rendered for this route)");
      }

      // The centroid/unknown rows must be absent from the ordered list.
      const listMatch = r.body.match(/<ul class="reise-list">[\s\S]*?<\/ul>/);
      const list = listMatch ? listMatch[0] : "";
      ok(!/Sentroid Gård/.test(list),
        "n7: a kommune-centroid producer is NOT in the travel-ordered list");
      ok(!/Ukjent Gård/.test(list),
        "n8: a NULL-provenance producer is NOT in the travel-ordered list — the allow-list, through the page");
    }

    // ══ e: honest failure states ══════════════════════════════════════
    {
      const r = await invoke(seoRouter, "/reise?from=Kvxzyq&to=Trondheim", "rettfrabonden.com");
      eq(r.status, 200, "e1: an ungeocodable origin still renders a page");
      ok(/fant ikke stedet/i.test(r.body),
        "e2: …and says which place it could not find, rather than showing an empty list");
      ok(!/<ul class="reise-list">/.test(r.body),
        "e3: …with no results list that would imply the search worked");

      // Refusal mode: no provider at all.
      process.env.ROUTING_FALLBACK = "refuse";
      __clearRouteCacheForTesting();
      const ref = await invoke(seoRouter, "/reise?from=Oslo&to=Trondheim", "rettfrabonden.com");
      ok(/ruteberegning/i.test(ref.body),
        "e4: with routing disabled the page explains that, instead of faking a corridor");
      process.env.ROUTING_FALLBACK = "straight_line";
      __clearRouteCacheForTesting();
    }

    // ══ j: the JSON API ═══════════════════════════════════════════════
    {
      const r = await invoke(marketplaceRouter, "/reise?from=Oslo&to=Trondheim&detour_max_km=40", "rettfrabonden.com");
      const j = r.json;
      eq(j.success, true, "j1: /api/marketplace/reise answers");
      ok(Array.isArray(j.stops), "j2: stops is an array");
      ok(Array.isArray(j.approximate), "j3: approximate is a SEPARATE array, not a flag on stops");
      ok(Array.isArray(j.notes) && j.notes.length > 0,
        "j4: notes carries the degradation the caller must relay");
      eq(j.route.kind, "straight_line", "j5: route.kind tells a consumer what it is looking at");

      for (const s of j.stops) {
        ok("along_km" in s && "detour_km" in s && "detour_minutes" in s && "geo_precision" in s && "url" in s,
          `j6: stop «${s.name}» carries the full LLM-facing shape`);
        eq(s.geo_precision, "address", `j7: every listed stop is address precision («${s.name}»)`);
        eq(s.detour_km, null, `j8: detour_km is null (not absent) in straight-line mode («${s.name}»)`);
        eq(s.detour_minutes, null, `j8b: detour_minutes is reserved for Fase 4 («${s.name}»)`);
      }
      for (const g of j.approximate) {
        for (const i of g.items) {
          ok(!("along_km" in i) && !("detour_km" in i),
            `j9: approximate item «${i.name}» carries NO positional number at all`);
        }
      }

      // Missing endpoints → a 400 a machine can branch on.
      const bad = await invoke(marketplaceRouter, "/reise?from=Oslo", "rettfrabonden.com");
      eq(bad.status, 400, "j10: a missing ?to= is a 400");
      eq(bad.json.error, "missing_endpoints", "j11: …with a machine-readable code");

      // Source isolation: the RFB mount must not be talkable into reading the
      // experiences catalogue, whatever the query string says.
      const inject = await invoke(
        marketplaceRouter,
        "/reise?from=Oslo&to=Trondheim&sources=experience,gardssalg",
        "rettfrabonden.com",
      );
      ok(inject.json.stops.every((s: any) => s.source === "rfb"),
        "x9: ?sources= cannot make the RFB mount read the experiences catalogue");
    }

    // ══ serialiseCorridor, in isolation ═══════════════════════════════
    {
      const failure: CorridorSearchResult = {
        ok: false, failure: "no_routing_provider", reason: "Ingen ruteberegning.",
        stops: [], approximate: [], notes: [], queryMs: 0,
        counts: { scanned: 0, precise: 0, imprecise: 0, afterSpacing: 0 },
      };
      const s = serialiseCorridor(failure);
      eq(s.success, false, "j12: a failed corridor serialises as success:false");
      eq(s.error, "no_routing_provider", "j13: …with the machine code");
      eq(s.stops, [], "j14: …and empty arrays rather than missing keys");
    }
  } finally {
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    __clearRouteCacheForTesting();
    if (prevProvider === undefined) delete process.env.ROUTING_PROVIDER; else process.env.ROUTING_PROVIDER = prevProvider;
    if (prevFallback === undefined) delete process.env.ROUTING_FALLBACK; else process.env.ROUTING_FALLBACK = prevFallback;
    if (prevToken === undefined) delete process.env.MAPBOX_ACCESS_TOKEN; else process.env.MAPBOX_ACCESS_TOKEN = prevToken;
    if (prevDb) (initMod as any).__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runReisePageTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log("  " + f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

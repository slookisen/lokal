/**
 * sok-search-honesty.test.ts — review follow-up for dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 0.
 *
 * The RFB /sok HTML page (src/routes/seo.ts). marketplace-search-honesty.test.ts
 * covers the JSON API; this covers what a human (and Googlebot) actually sees.
 *
 *   B2  PRIVACY. A coordinates-only /sok request logged
 *       query_text = "nær 59.914, 10.752" into `conversations` — 3 decimals is
 *       ~110 m, household level — and that column is rendered on the
 *       UNAUTHENTICATED /samtaler list and /samtale/<uuid> pages, which the
 *       code's own comments note Googlebot crawls. redactPII() does not
 *       recognise coordinates. The new homepage «Finn i nærheten» button made
 *       this the primary way the route is reached.
 *
 *   B3  The H1 contradicted the page's own relaxation banner: «Produsenter nær
 *       deg (30 km) — 4 treff» directly above «Ingen treff nær din posisjon —
 *       utvidet til hele Norge», with a producer 1 150 km away in the list.
 *       <title> and og:description were built from the same string.
 *
 *   7   The «Vis hele Norge» link built `?q=&heleNorge=true` on a
 *       coordinates-only search, which 302s straight back to the homepage.
 *   8   The radius <select> marked no option when ?radius= was off the preset
 *       ladder, so the control showed 10 km while the search ran at 75 km.
 *   9   The page called the geolocation prompt with no user gesture whenever
 *       the query looked like proximity intent — and isProximityIntent()
 *       matches a producer named "Nærmeste Gård AS".
 *
 * Same harness as experiences-seo-sok-geo.test.ts (synthetic req/res driving
 * the real router, res.send() HTML) with the RFB in-memory schema and a
 * stubbed geocoder fetch.
 *
 * Exported runSokSearchHonestyTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/sok-search-honesty.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

// Vadsø — deliberately ~1 500 km from every seeded producer, so any
// coordinates-only search from here must relax the geo filter.
const VADSO = { lat: 70.0803, lng: 29.7309 };
// Oslo — close to one seeded producer.
const OSLO = { lat: 59.9139, lng: 10.7522 };

const SEED = [
  { id: "s-oslo",   name: "Grünerløkka Gårdsmat", city: "Oslo",      lat: 59.9231, lng: 10.7601 },
  { id: "s-sorum",  name: "Sørum Gårdsutsalg",    city: "Sørum",     lat: 59.9833, lng: 11.2333 },
  { id: "s-stange", name: "Stange Gårdsutsalg",   city: "Stange",    lat: 60.7167, lng: 11.1833 },
  { id: "s-tromso", name: "Tromsø Sjømat",        city: "Tromsø",    lat: 69.6496, lng: 18.9560 },
];

function seedAgents(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, '["honey"]', '[]', '[]', '{}', '["no"]',
            0.6, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const a of SEED) {
    stmt.run(a.id, a.name, "Lokal produsent", "test", `${a.id}@example.no`,
      `https://${a.id}.example.no`, "key-" + a.id, a.lat, a.lng, a.city);
  }
}

function callHtml(
  router: any,
  url: string,
  headers: Record<string, string> = { "user-agent": BROWSER_UA },
): Promise<{ status: number; body: string; redirectedTo?: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers,
      ip: "127.0.0.1",
      lang: "no",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() { return this; },
      redirect(to: string) { resolve({ status: 302, body: "", redirectedTo: to }); },
      send(body: unknown) { resolve({ status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: statusCode, body: err ? String(err) : "" });
    });
  });
}

export async function runSokSearchHonestyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seedAgents(db);

  // Every Kartverket/Kommuneinfo call 404s: any geo in these tests can only
  // come from the coordinates in the URL.
  __setGeocodingFetchForTesting((async () =>
    ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch);
  __clearGeocodeCacheForTesting();

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    // seo.ts's shell() calls getConfig(), which throws unless the vertical
    // configs were cold-loaded at boot. Same best-effort load as
    // admin-agents-brreg-catalog-sweep.test.ts.
    try {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as
        typeof import("../config/vertical-config");
      loadConfigsAtBoot();
    } catch { /* already loaded by another suite, or dir missing in CI */ }

    const router = require("./seo").default;
    const queryTexts = () =>
      (db.prepare("SELECT query_text FROM conversations").all() as Array<{ query_text: string | null }>)
        .map((r) => r.query_text || "");

    // ══════════════════════════════════════════════════════════════
    // B2 — the visitor's GPS position must never reach a public record
    // ══════════════════════════════════════════════════════════════
    {
      db.prepare("DELETE FROM conversations").run();
      const r = await callHtml(router, `/sok?lat=${OSLO.lat}&lng=${OSLO.lng}&radius=30`);
      assertEq(r.status, 200, "B2: coordinates-only /sok renders");
      assertTrue(/Gårdsmat/.test(r.body), "B2: …with real results (so the logging path really ran)");

      const logged = queryTexts();
      assertTrue(logged.length > 0, "B2: a conversation WAS logged (the path under test is live)");
      // A coordinate-shaped string is two signed decimals separated by a comma.
      const COORD = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;
      assertTrue(!logged.some((t) => COORD.test(t)),
        `B2: no coordinate-shaped string reached conversations.query_text (got ${JSON.stringify(logged)})`);
      assertTrue(!logged.some((t) => t.includes("59.91") || t.includes("10.75")),
        `B2: neither the latitude nor the longitude leaked (got ${JSON.stringify(logged)})`);
      assertEq(logged, ["nærhetssøk"], "B2: the position is replaced by a neutral label");
    }
    {
      // A text search still logs its text — B2 must not blind the log entirely.
      db.prepare("DELETE FROM conversations").run();
      await callHtml(router, "/sok?q=honning");
      assertEq(queryTexts(), ["honning"], "B2: a normal text search still logs the query text");
    }

    // ══════════════════════════════════════════════════════════════
    // B3 — the heading must not contradict the relaxation banner
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, `/sok?lat=${VADSO.lat}&lng=${VADSO.lng}&radius=30`);
      assertEq(r.status, 200, "B3: coordinates-only search from Vadsø renders");
      assertTrue(/geoRelaxedNote/.test(r.body),
        "B3: the page correctly shows the «utvidet til hele Norge» banner");
      assertTrue(/Tromsø Sjømat|Gårdsmat/.test(r.body),
        "B3: …and really is listing far-away producers");

      const h1 = (r.body.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || "";
      assertTrue(!/nær deg/i.test(h1),
        `B3: the H1 no longer claims proximity (got "${h1.trim()}")`);
      assertTrue(/hele Norge/i.test(h1),
        `B3: the H1 states what actually happened (got "${h1.trim()}")`);

      const title = (r.body.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
      assertTrue(!/nær deg/i.test(title), `B3: <title> does not claim proximity either (got "${title.trim()}")`);

      const desc = (r.body.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
      assertTrue(!/nær posisjonen din\.$/.test(desc.trim()),
        `B3: og/meta description does not claim proximity (got "${desc}")`);
      assertTrue(/hele Norge/i.test(desc), `B3: …it says the results are nationwide (got "${desc}")`);
    }
    {
      // Control: a genuinely local coordinates-only search keeps the proximity
      // heading, because that one is true.
      const r = await callHtml(router, `/sok?lat=${OSLO.lat}&lng=${OSLO.lng}&radius=200`);
      const h1 = (r.body.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || "";
      assertTrue(/nær deg/i.test(h1),
        `B3 control: a real proximity search still says «nær deg» (got "${h1.trim()}")`);
      assertTrue(!/geoRelaxedNote/.test(r.body), "B3 control: …and shows no relaxation banner");
    }

    {
      // item 6 companion: when the auto-expand ladder widens the search, the
      // heading must report the radius that was APPLIED, not the one asked
      // for. Only one producer sits within 30 km of Oslo, so a 30 km request
      // climbs the ladder until it has three.
      const r = await callHtml(router, `/sok?lat=${OSLO.lat}&lng=${OSLO.lng}&radius=30`);
      const h1 = (r.body.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || "";
      assertTrue(/nær deg/i.test(h1), `item 6: still a proximity heading (got "${h1.trim()}")`);
      const km = Number((h1.match(/\((\d+) km\)/) || [])[1] || 0);
      assertTrue(km > 30,
        `item 6: the heading reports the WIDENED radius, not the requested 30 km (got ${km})`);
      // …and the ladder never narrows below what was asked for.
      const r2 = await callHtml(router, `/sok?lat=${OSLO.lat}&lng=${OSLO.lng}&radius=100`);
      const h2 = (r2.body.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || "";
      const km2 = Number((h2.match(/\((\d+) km\)/) || [])[1] || 0);
      assertTrue(km2 >= 100,
        `item 6: a 100 km request is never narrowed to the ladder's first step of 50 (got ${km2})`);
    }

    // ══════════════════════════════════════════════════════════════
    // item 7 — «Vis hele Norge» must not be a dead link
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, `/sok?lat=${OSLO.lat}&lng=${OSLO.lng}&radius=200`);
      const link = (r.body.match(/href="([^"]*heleNorge=true[^"]*)"/) || [])[1] || "";
      assertTrue(link.length > 0, "item 7: the «Vis hele Norge» link is rendered");
      assertTrue(!/[?&]q=&/.test(link) && !/[?&]q=$/.test(link),
        `item 7: it no longer emits an empty q= (got "${link}")`);
      assertTrue(link.includes("lat=") && link.includes("lng="),
        `item 7: it carries the coordinates through (got "${link}")`);

      // …and following it actually lands on a page instead of redirecting home.
      const followed = await callHtml(router, link.replace(/&amp;/g, "&"));
      assertEq(followed.status, 200, "item 7: following the link renders a page, not a 302 to /");
    }

    // ══════════════════════════════════════════════════════════════
    // item 8 — the radius control must report the applied radius
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, `/sok?q=honning&radius=75`);
      const sel = (r.body.match(/<select name="radius"[\s\S]*?<\/select>/) || [])[0] || "";
      assertTrue(sel.length > 0, "item 8: the radius select is rendered");
      assertTrue(/<option value="75" selected>75 km<\/option>/.test(sel),
        `item 8: an off-ladder ?radius=75 is spliced in AND marked selected (got ${sel})`);
      assertEq((sel.match(/ selected>/g) || []).length, 1,
        "item 8: exactly one option is selected");
    }
    {
      const r = await callHtml(router, `/sok?q=honning&radius=50`);
      const sel = (r.body.match(/<select name="radius"[\s\S]*?<\/select>/) || [])[0] || "";
      assertTrue(/<option value="50" selected>/.test(sel), "item 8: an on-ladder radius is marked too");
      assertEq((sel.match(/ selected>/g) || []).length, 1, "item 8: …still exactly one");
    }
    {
      const r = await callHtml(router, `/sok?q=honning`);
      const sel = (r.body.match(/<select name="radius"[\s\S]*?<\/select>/) || [])[0] || "";
      assertTrue(/<option value="30" selected>/.test(sel), "item 8: the default 30 km is marked when none given");
    }

    // ══════════════════════════════════════════════════════════════
    // item 9 — no geolocation prompt without a user gesture
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, "/sok?q=nær meg");
      assertTrue(/needsLocationNote/.test(r.body),
        "item 9: a «nær meg» search still surfaces the needs-location notice");
      assertTrue(!/\)\s*ask\(\);/.test(r.body) && !/if \(true\) ask\(\)/.test(r.body),
        "item 9: the page does NOT call ask() outside the click handler");
      assertTrue(/data-needs-location/.test(r.body),
        "item 9: …it highlights the button instead");
      assertTrue(/addEventListener\('click', ask\)/.test(r.body),
        "item 9: the prompt is still reachable — behind the button's click handler");
    }
    {
      // The hazard the reviewer named: a producer NAME that trips the
      // deliberately broad /\bnærmeste\b/ intent pattern must not pop a prompt.
      const r = await callHtml(router, "/sok?q=Nærmeste Gård AS");
      assertTrue(!/if \(true\) ask\(\)/.test(r.body),
        "item 9: searching a producer called «Nærmeste Gård AS» does not auto-fire the permission prompt");
    }
  } finally {
    console.log = prevLog;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runSokSearchHonestyTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

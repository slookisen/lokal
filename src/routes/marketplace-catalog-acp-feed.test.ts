/**
 * marketplace-catalog-acp-feed.test.ts — proves GET /api/marketplace/catalog/acp-feed.csv
 * (the OpenAI Agentic Commerce Protocol non-Ads CSV product feed) emits a
 * correctly-shaped, correctly-escaped CSV using the exact same
 * filter/source as GET /feed in the same file.
 *
 * dev-request 2026-08-24-acp-produktfeed-rfb.
 *
 * Covers:
 *   - Content-Type: text/csv; charset=utf-8, header row exactly the 12 ACP
 *     column names in spec order.
 *   - A fully-populated seeded product round-trips correctly through every
 *     field.
 *   - A `description` containing a comma AND a double-quote round-trips
 *     correctly through a real CSV parse (proves RFC4180 escaping, not a
 *     naive `.join(",")`).
 *   - A row with `image_url = NULL` and a row with `price_nok = NULL` are
 *     both excluded from the output; `X-Acp-Feed-Skipped-Count` reflects the
 *     exact skipped count.
 *
 * Harness mirrors marketplace-catalog-second-line.test.ts /
 * marketplace-catalog-supply-graph.test.ts: in-memory better-sqlite3 DB via
 * __setDbForTesting + __initSchemaForTesting, router exercised directly
 * (router.handle(req, res, next)) — no HTTP server, no network calls. The
 * `res` mock here additionally supports `.header()`/`.send()` (this route
 * emits raw CSV text with headers, not `.json()`) — purely additive to the
 * sibling harness, nothing shared/modified.
 *
 * Run standalone:  npx tsx src/routes/marketplace-catalog-acp-feed.test.ts
 *
 * NOT wired into tests/test.ts's require()-list on purpose — the spec for
 * this slice (dev-request 2026-08-24-acp-produktfeed-rfb) names exactly 5
 * files to touch and tests/test.ts is not one of them ("PR hygiene requires
 * a tight diff"). runMarketplaceCatalogAcpFeedTests() is exported with the
 * same shape as the sibling *.test.ts files' runners specifically so a
 * follow-up slice can wire it into the gate with a one-line, low-risk diff
 * to tests/test.ts.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { catalogRouter } from "./marketplace-catalog";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: string | undefined;
  headers: Record<string, string>;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; params?: Record<string, string>; query?: Record<string, any>; headers?: Record<string, string> }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const reqHeaders = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      params: opts.params || {},
      query: opts.query || {},
      headers: reqHeaders,
      ip: "127.0.0.1",
      get(name: string) {
        return reqHeaders[name.toLowerCase()];
      },
    };
    const resHeaders: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      header(name: string, value?: string) {
        if (value === undefined) return resHeaders[name.toLowerCase()];
        resHeaders[name.toLowerCase()] = value;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: JSON.stringify(payload), headers: resHeaders });
        return this;
      },
      send(body: string) {
        resolve({ status: this.statusCode, body, headers: resHeaders });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, headers: resHeaders });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? String(err) : undefined, headers: resHeaders });
    });
  });
}

// ─── Minimal RFC4180 CSV line parser (test-only; independent implementation
// from the route's escapeCsvField, so a passing test actually proves
// interoperable escaping, not a mirror-image bug). Splits a full CSV text
// blob (CRLF or LF line endings) into rows of string fields. ─────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const ACP_HEADER = [
  "item_id", "title", "description", "brand", "url", "image_url",
  "price", "availability", "is_eligible_search", "is_eligible_checkout",
  "target_countries", "product_category",
];

export async function runMarketplaceCatalogAcpFeedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = initMod.getDb();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  (initMod as any).__setDbForTesting(db);
  (initMod as any).__initSchemaForTesting(db);

  try {
    // ── Fixture: one verified, non-umbrella agent. ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
      VALUES ('agent-acp', 'Åsen Gård', 'test', 'test', 'acp@example.com', 'https://example.com', 'producer', 'key-acp', 'Oslo')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status)
      VALUES ('agent-acp', 'verified')
    `).run();

    // Row 1: fully-populated, valid — should appear.
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, description, price_nok, currency, availability, category, image_url)
      VALUES ('prod-valid', 'agent-acp', 'Økologiske Poteter', 'okologiske poteter', 'Ferske poteter fra åsen', 275, 'NOK', 'in_stock', 'grønnsaker', 'https://example.com/poteter.jpg')
    `).run();

    // Row 2: description contains a comma AND a double-quote — proves real
    // RFC4180 escaping, not naive .join(",").
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, description, price_nok, currency, availability, category, image_url)
      VALUES ('prod-escape', 'agent-acp', 'Spesial-egg', 'spesial-egg', 'Store, ferske egg fra "frittgående" høner', 89.5, 'NOK', 'in_stock', 'egg', 'https://example.com/egg.jpg')
    `).run();

    // Row 3: image_url NULL — must be excluded.
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, description, price_nok, currency, availability, category, image_url)
      VALUES ('prod-no-image', 'agent-acp', 'Uten Bilde', 'uten bilde', 'test', 50, 'NOK', 'in_stock', 'annet', NULL)
    `).run();

    // Row 4: price_nok NULL — must be excluded.
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, description, price_nok, currency, availability, category, image_url)
      VALUES ('prod-no-price', 'agent-acp', 'Uten Pris', 'uten pris', 'test', NULL, 'NOK', 'in_stock', 'annet', 'https://example.com/uten-pris.jpg')
    `).run();

    const res = await callRoute(catalogRouter, { url: "/acp-feed.csv" });

    assertEq(res.status, 200, "acp-feed: 200 OK");
    assertEq(res.headers["content-type"], "text/csv; charset=utf-8", "acp-feed: Content-Type is text/csv; charset=utf-8");
    assertEq(res.headers["cache-control"], "public, max-age=300", "acp-feed: Cache-Control is public, max-age=300");
    assertEq(res.headers["x-acp-feed-skipped-count"], "2", "acp-feed: X-Acp-Feed-Skipped-Count reflects the 2 rows skipped (missing image_url / price_nok)");

    const body = res.body ?? "";
    const table = parseCsv(body);
    // Trailing CRLF produces one trailing empty row from the parser; drop it.
    while (table.length > 0 && table[table.length - 1].length === 1 && table[table.length - 1][0] === "") {
      table.pop();
    }

    assertEq(table[0], ACP_HEADER, "acp-feed: header row is exactly the 12 ACP column names, in order");
    assertEq(table.length, 3, "acp-feed: header + 2 valid data rows (prod-no-image and prod-no-price excluded)");

    const byId = new Map<string, string[]>();
    for (let i = 1; i < table.length; i++) {
      byId.set(table[i][0], table[i]);
    }

    assertTrue(!byId.has("prod-no-image"), "acp-feed: row with NULL image_url is absent from the output");
    assertTrue(!byId.has("prod-no-price"), "acp-feed: row with NULL price_nok is absent from the output");

    // ── Full field verification on the fully-populated row ──
    const valid = byId.get("prod-valid");
    assertTrue(!!valid, "acp-feed: prod-valid is present");
    if (valid) {
      const [
        item_id, title, description, brand, url, image_url, price,
        availability, is_eligible_search, is_eligible_checkout,
        target_countries, product_category,
      ] = valid;
      assertEq(item_id, "prod-valid", "acp-feed: item_id = p.id");
      assertEq(title, "Økologiske Poteter", "acp-feed: title = p.name");
      assertEq(description, "Ferske poteter fra åsen", "acp-feed: description = p.description");
      assertEq(brand, "Åsen Gård", "acp-feed: brand = a.name");
      assertEq(url, "https://rettfrabonden.com/produsent/asen-gard", "acp-feed: url reuses BASE_URL + slugify(a.name), same pattern as /feed's profile_url");
      assertEq(image_url, "https://example.com/poteter.jpg", "acp-feed: image_url = p.image_url");
      assertEq(price, "275.00 NOK", "acp-feed: price = `${price_nok.toFixed(2)} ${currency}`");
      assertEq(availability, "in_stock", "acp-feed: availability = computeEffectiveAvailability(...)");
      assertEq(is_eligible_search, "true", "acp-feed: is_eligible_search is always literal 'true'");
      assertEq(is_eligible_checkout, "false", "acp-feed: is_eligible_checkout is always literal 'false' (discovery-only)");
      assertEq(target_countries, "NO", "acp-feed: target_countries is always literal 'NO'");
      assertEq(product_category, "grønnsaker", "acp-feed: product_category = p.category");
    }

    // ── Escaping round-trip: comma + double-quote in description ──
    const escaped = byId.get("prod-escape");
    assertTrue(!!escaped, "acp-feed: prod-escape is present");
    if (escaped) {
      assertEq(
        escaped[2],
        'Store, ferske egg fra "frittgående" høner',
        "acp-feed: description with comma + embedded double-quote round-trips correctly through CSV parse"
      );
      assertEq(escaped[6], "89.50 NOK", "acp-feed: prod-escape price formatted to 2 decimals");
    }

    // Raw-text sanity: the escaped description must actually appear
    // double-quote-wrapped with doubled inner quotes in the raw CSV body
    // (proves this isn't accidentally passing via a lenient parser).
    assertTrue(
      body.includes('"Store, ferske egg fra ""frittgående"" høner"'),
      "acp-feed: raw CSV body contains the RFC4180-escaped field verbatim"
    );
  } finally {
    (initMod as any).__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceCatalogAcpFeedTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-catalog-acp-feed: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}

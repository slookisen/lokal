/**
 * admin-drink-coverage.test.ts — tests for GET /admin/agents/drink-coverage
 * (src/routes/admin-drink-coverage.ts), dev-request 2026-07-25-reisesok-
 * korridor-discovery-og-naerhetssok, Fase 5c: «Datadekning måles og
 * rapporteres (hvor mange drikkesteder finnes faktisk per fylke).»
 *
 * Harness mirrors admin-agents-category-description-provenance-audit.test.ts:
 * a fresh in-memory SQLite DB via __setDbForTesting/__initSchemaForTesting,
 * the route module required fresh, the handler invoked directly via
 * router.handle() (no real HTTP/socket round-trip).
 *
 * Exported runAdminDrinkCoverageTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 * Standalone: npx tsx src/routes/admin-drink-coverage.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(router: any, opts: { headers?: Record<string, string> } = {}): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: "GET",
    url: "/",
    originalUrl: "/",
    path: "/",
    query: {},
    headers: opts.headers || {},
    get() { return undefined; },
  };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { result = { status: this.statusCode, body: payload }; return this; },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export async function runAdminDrinkCoverageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "drink-coverage-test-key";

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  function insertAgent(o: {
    id: string; name: string; description?: string; city?: string | null;
    categories?: string[]; isActive?: boolean; role?: string; umbrellaType?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, city, categories, is_active, umbrella_type)
       VALUES (?, ?, ?, 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?)`,
    ).run(
      o.id, o.name, o.description ?? "", o.role ?? "producer", `key-${o.id}`,
      o.city ?? null, JSON.stringify(o.categories ?? []),
      o.isActive === false ? 0 : 1, o.umbrellaType ?? null,
    );
  }

  try {
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = testKey;

    // Drink producers — one per readily-identifiable subcategory, plus one
    // whose text does not classify into any of the six (unclassified).
    insertAgent({
      id: "ag-bryggeri1", name: "Ruteøl Bryggeri", city: "Kristiansand",
      categories: ["beverages"], description: "Lite bryggeri i Kristiansand.",
    });
    insertAgent({
      id: "ag-bryggeri2", name: "Fjellstad Ølhus", city: "Kristiansand",
      categories: ["beer"], description: "Mikrobryggeri med lokal humle på gården.",
    });
    insertAgent({
      id: "ag-vingard1", name: "Sørlandsk Vingård", city: "Grimstad",
      categories: ["beverages"], description: "Vingård med egen vinproduksjon.",
    });
    insertAgent({
      id: "ag-unclassified", name: "Litt Av Hvert Gård", city: "Oslo",
      categories: ["drikke"], description: "Selger diverse drikke fra gården.",
    });
    // Non-drink producer — must never be counted.
    insertAgent({
      id: "ag-honning", name: "Oslo Honning", city: "Oslo",
      categories: ["honey"], description: "Lokal birøkter.",
    });
    // Inactive drink producer — excluded by is_active=1 gate.
    insertAgent({
      id: "ag-inactive", name: "Nedlagt Bryggeri", city: "Bergen",
      categories: ["beverages"], description: "Bryggeri som ikke lenger er aktivt.",
      isActive: false,
    });
    // Umbrella agent carrying beverages — excluded (not a place you stop at,
    // same umbrella_type IS NULL rule route-corridor-service.ts's
    // loadRfbCandidates uses).
    insertAgent({
      id: "ag-umbrella", name: "Bryggeriforeningen", city: "Oslo",
      categories: ["beverages"], description: "Bransjeorganisasjon for bryggerier.",
      umbrellaType: "industry_org",
    });

    const router = (require("./admin-drink-coverage") as typeof import("./admin-drink-coverage")).default as any;

    // ── 403 without key ─────────────────────────────────────────────────
    const noKey = callRoute(router, {});
    assertEq(noKey.status, 403, "a1: without X-Admin-Key -> 403");

    // ── happy path ───────────────────────────────────────────────────────
    const ok = callRoute(router, { headers: { "x-admin-key": testKey } });
    assertEq(ok.status, 200, "b1: with valid key -> 200");
    assertEq(ok.body.grouped_by, "city", "b2: honestly reports grouped_by:\"city\" (RFB has no fylke column)");
    assertEq(ok.body.scanned_producers, 5,
      "b3: scanned_producers is 5 (active, role=producer, umbrella_type IS NULL — excludes ag-inactive + ag-umbrella)");
    assertEq(ok.body.drink_producers, 4,
      "b4: drink_producers counts exactly the 4 real drink rows (bryggeri1, bryggeri2, vingard1, unclassified) — not honning, not inactive, not umbrella");
    assertEq(ok.body.by_subcategory.bryggeri, 2, "b5: by_subcategory.bryggeri = 2");
    assertEq(ok.body.by_subcategory["vingård"], 1, "b6: by_subcategory.vingård = 1");
    assertEq(ok.body.by_subcategory.unclassified, 1,
      "b7: by_subcategory.unclassified = 1 (generic 'drikke' category, no specific subcategory keyword in the text)");
    assertEq(ok.body.by_subcategory.mjød, 0, "b8: subcategories with zero real matches are present as 0, not absent");

    assertTrue(Array.isArray(ok.body.by_city), "b9: by_city is an array");
    const kristiansand = ok.body.by_city.find((c: any) => c.city === "Kristiansand");
    assertEq(kristiansand?.total, 2, "b10: Kristiansand carries 2 drink producers (both breweries)");
    assertEq(kristiansand?.by_subcategory?.bryggeri, 2, "b11: …both classified as bryggeri");
    const oslo = ok.body.by_city.find((c: any) => c.city === "Oslo");
    assertEq(oslo?.total, 1, "b12: Oslo carries 1 (the unclassified drink row) — NOT ag-honning or ag-umbrella");
    assertTrue(!ok.body.by_city.some((c: any) => c.city === "Bergen"),
      "b13: Bergen does not appear at all (its only agent was inactive)");

    // ── zero-drink edge case ────────────────────────────────────────────
    const db2 = new Database(":memory:");
    db2.pragma("journal_mode = DELETE");
    __setDbForTesting(db2 as any);
    __initSchemaForTesting(db2 as any);
    const router2 = (() => {
      delete require.cache[require.resolve("./admin-drink-coverage")];
      return (require("./admin-drink-coverage") as typeof import("./admin-drink-coverage")).default as any;
    })();
    const empty = callRoute(router2, { headers: { "x-admin-key": testKey } });
    assertEq(empty.status, 200, "c1: zero-agent DB -> still 200");
    assertEq(empty.body.drink_producers, 0, "c2: drink_producers = 0");
    assertEq(empty.body.by_city, [], "c3: by_city is an empty array, not omitted");
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runAdminDrinkCoverageTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log("  " + f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}

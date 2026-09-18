/**
 * admin-agents-category-description-provenance-audit.test.ts — unit +
 * integration tests for dev-request 2026-09-09-rfb-kategori-og-beskrivelse-
 * provenance-audit (slookisen/A2A).
 *
 * Covers the 3 acceptance criteria:
 *   AC1 — GET /admin/agents/category-description-provenance-audit lists
 *         counts + examples per class; a Soli Brug-shaped row (NACE-default-
 *         only category) and a DalPro Gårdsmat-shaped row (nav-boilerplate
 *         description) are both caught, and a normal/corroborated row is NOT.
 *   AC2 — a row whose categories are NACE-default-only (no website_homepage/
 *         owner provenance) is EXCLUDED from GET /admin/outreach-candidates
 *         (the real pool-eligibility gate, not just this report), while an
 *         otherwise-identical row WITH website-corroborated categories still
 *         gets through — proven against the real route, not just the report.
 *   AC3 — POST .../route-boilerplate-to-reenrichment (apply=true) nulls a
 *         confirmed-boilerplate `agents.description` via the SAME
 *         applyRfbRetroScanNull the RFB retro-scan already uses (routing the
 *         row back to re-enrichment — TRIM(description)='' is this
 *         codebase's existing re-enrichment candidate shape), while the
 *         dry-run default writes nothing.
 *
 * Also unit-tests the two pure detectors this feature is built from:
 *   - categoriesLackWebsiteCorroboration / fieldLacksWebsiteCorroboration
 *     (services/cross-source-validator.ts) — the REAL mechanism this dev-
 *     request's own "held-for-reenrichment" name does not refer to anything;
 *     see that module's doc comment for the correction.
 *   - isJunkDescription (services/description-quality.ts) is REUSED, not
 *     reimplemented — no new boilerplate detector is added by this feature.
 *
 * Harness mirrors admin-outreach-candidates-gate-integrity.test.ts and
 * admin-agents-category-sanity-report.test.ts: a fresh in-memory SQLite DB
 * via __setDbForTesting/__initSchemaForTesting, route modules required
 * fresh, handlers invoked directly (no real HTTP/socket round-trip).
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

function callRouteSync(
  router: any,
  opts: { method?: string; path?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: opts.method || "GET",
    url: opts.path || "/",
    query: opts.query || {},
    headers: opts.headers || {},
    body: opts.body,
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

// Realistic Soli Brug-shaped nav-menu boilerplate — the DalPro Gårdsmat live
// example was "Meny Gårdsopplevelser Kurs Industrikurs …" (truncated by
// Daniel's own report); a real scraped nav bar carries many more menu items
// than the truncated excerpt shows, so this fixture is built the same shape
// (several STRONG_NAV_TOKENS/DENSITY_NAV_WORDS clustered), not a minimal
// gaming of the detector's threshold.
const DALPRO_SHAPED_BOILERPLATE =
  "Meny Forside Produkter Kontakt Gårdsopplevelser Kurs Industrikurs Nyheter " +
  "Blogg Produksjon Om oss Tjenester Facebook-f Instagram";

const NORMAL_PROSE_DESCRIPTION =
  "Vi driver med økologisk grønnsaksdyrking og selger direkte fra gården " +
  "hver lørdag. Velkommen innom!";

export async function runAdminAgentsCategoryDescriptionProvenanceAuditTests(
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

  // ── Pure-function unit tests (no DB) ────────────────────────────────────
  try {
    const {
      fieldLacksWebsiteCorroboration,
      categoriesLackWebsiteCorroboration,
    } = require("../services/cross-source-validator") as typeof import("../services/cross-source-validator");
    const { isJunkDescription } = require("../services/description-quality") as
      typeof import("../services/description-quality");

    // fieldLacksWebsiteCorroboration
    assertEq(fieldLacksWebsiteCorroboration(false, []), false, "pure: no value -> not gated (data_insufficient, different claim)");
    assertEq(fieldLacksWebsiteCorroboration(true, []), true, "pure: value present, zero provenance records -> lacks corroboration");
    assertEq(
      fieldLacksWebsiteCorroboration(true, [{ value: "fish", source_type: "category_inference", fetched_at: "2026-01-01" }]),
      true,
      "pure: value present, only category_inference provenance -> lacks corroboration",
    );
    assertEq(
      fieldLacksWebsiteCorroboration(true, [{ value: "fish", source_type: "brreg", fetched_at: "2026-01-01" }]),
      true,
      "pure: value present, only Tier-B brreg provenance (no website corroboration) -> lacks corroboration",
    );
    assertEq(
      fieldLacksWebsiteCorroboration(true, [{ value: "vegetables", source_type: "website_homepage", fetched_at: "2026-01-01" }]),
      false,
      "pure: value present, website_homepage provenance -> CORROBORATED",
    );
    assertEq(
      fieldLacksWebsiteCorroboration(true, [{ value: "vegetables", source_type: "owner", fetched_at: "2026-01-01" }]),
      false,
      "pure: value present, owner (Tier-S) provenance -> CORROBORATED",
    );
    assertEq(
      fieldLacksWebsiteCorroboration(true, {
        value: "vegetables",
        source_type: "website_homepage",
        fetched_at: "2026-01-01",
      } as any),
      false,
      "pure: legacy single-object (non-array) shape with website_homepage -> CORROBORATED",
    );

    // categoriesLackWebsiteCorroboration (raw-JSON-column convenience wrapper)
    assertEq(
      categoriesLackWebsiteCorroboration(JSON.stringify(["fish"]), null),
      true,
      "categoriesLackWebsiteCorroboration: Soli Brug shape (categories present, field_provenance NULL) -> true",
    );
    assertEq(
      categoriesLackWebsiteCorroboration(JSON.stringify(["fish"]), "{}"),
      true,
      "categoriesLackWebsiteCorroboration: categories present, field_provenance='{}' -> true",
    );
    assertEq(
      categoriesLackWebsiteCorroboration(
        JSON.stringify(["fish"]),
        JSON.stringify({ categories: [{ value: "fish", source_type: "category_inference", fetched_at: "2026-01-01" }] }),
      ),
      true,
      "categoriesLackWebsiteCorroboration: categories present, category_inference-only provenance -> true",
    );
    assertEq(
      categoriesLackWebsiteCorroboration(
        JSON.stringify(["vegetables"]),
        JSON.stringify({ categories: [{ value: "vegetables", source_type: "website_homepage", fetched_at: "2026-01-01" }] }),
      ),
      false,
      "categoriesLackWebsiteCorroboration: categories present, website_homepage provenance -> false (corroborated)",
    );
    assertEq(
      categoriesLackWebsiteCorroboration(JSON.stringify([]), null),
      false,
      "categoriesLackWebsiteCorroboration: empty categories array -> false (nothing to gate)",
    );
    assertEq(
      categoriesLackWebsiteCorroboration("not valid json[", null),
      false,
      "categoriesLackWebsiteCorroboration: malformed categories JSON -> false, never throws",
    );

    // isJunkDescription reuse — DalPro-shaped boilerplate is caught by the
    // EXISTING detector (no new/parallel detector was written for this
    // feature); normal prose is not.
    assertTrue(
      isJunkDescription(DALPRO_SHAPED_BOILERPLATE),
      "isJunkDescription (reused as-is): DalPro Gårdsmat-shaped nav boilerplate -> true",
    );
    assertTrue(
      !isJunkDescription(NORMAL_PROSE_DESCRIPTION),
      "isJunkDescription (reused as-is): normal prose description -> false (no false positive)",
    );
  } catch (err) {
    failed++;
    failures.push(`pure-function tests: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  }

  // ── DB-backed route tests ───────────────────────────────────────────────
  const prevDb = (() => {
    try { return require("../database/init").getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "provenance-audit-test-key";

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  function insertAgent(o: {
    id: string;
    name: string;
    description?: string;
    categories?: string[];
    orgNr?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, categories)
       VALUES (?, ?, ?, 't', 'x@example.com', 'https://example.com', 'producer', ?, ?, ?)`,
    ).run(
      o.id,
      o.name,
      o.description ?? "",
      `key-${o.id}`,
      o.orgNr ?? null,
      JSON.stringify(o.categories ?? []),
    );
  }

  function insertKnowledge(agentId: string, o: { about?: string | null; fieldProvenance?: Record<string, unknown> } = {}): void {
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, about, field_provenance) VALUES (?, ?, ?)`,
    ).run(agentId, o.about ?? null, JSON.stringify(o.fieldProvenance ?? {}));
  }

  // Fully outreach_ready_pool-eligible fixture, same shape as
  // admin-outreach-candidates-gate-integrity.test.ts's insertVerifiedPoolAgent
  // — mode=first candidacy depends on this exact shape (rich, verified,
  // content-threshold cleared, fresh URL probe, non-umbrella, active,
  // producer role).
  function insertPoolEligibleAgent(o: {
    id: string;
    name: string;
    email: string;
    categories?: string[];
    fieldProvenance?: Record<string, unknown>;
  }): void {
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
       VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?, ?)`,
    ).run(o.id, o.name, o.email, `key-${o.id}`, JSON.stringify(o.categories ?? []));
    db.prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, about, field_provenance, verification_status, enrichment_status,
          url_last_status, url_last_probed)
       VALUES (?, ?, ?, ?, 'verified', 'rich', 200, datetime('now'))`,
    ).run(o.id, o.email, "x".repeat(200), JSON.stringify(o.fieldProvenance ?? {}));
  }

  try {
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = testKey;

    // ── AC1 fixtures ───────────────────────────────────────────────────────
    // Soli Brug-shaped: NACE-default-only category, no field_provenance at all.
    insertAgent({ id: "soli-brug", name: "Soli Brug", categories: ["fish"], orgNr: "910111111" });
    insertKnowledge("soli-brug");

    // DalPro Gårdsmat-shaped: boilerplate description, otherwise-normal categories.
    insertAgent({
      id: "dalpro",
      name: "DalPro Gårdsmat",
      description: DALPRO_SHAPED_BOILERPLATE,
      categories: ["vegetables"],
      orgNr: "910222222",
    });
    insertKnowledge("dalpro", {
      fieldProvenance: {
        categories: [{ value: "vegetables", source_type: "website_homepage", fetched_at: "2026-01-01" }],
      },
    });

    // Clean control row: corroborated categories + normal prose description —
    // must NOT appear in either flagged class.
    insertAgent({
      id: "clean-control",
      name: "Ren Kontrollgård",
      description: NORMAL_PROSE_DESCRIPTION,
      categories: ["vegetables", "eggs"],
      orgNr: "910333333",
    });
    insertKnowledge("clean-control", {
      fieldProvenance: {
        categories: [{ value: "vegetables", source_type: "website_homepage", fetched_at: "2026-01-01" }],
      },
    });

    const routePath = require.resolve("./admin-agents-category-description-provenance-audit");
    delete require.cache[routePath];
    const auditRouter = require("./admin-agents-category-description-provenance-audit").default;

    // Auth gate
    const noKey = callRouteSync(auditRouter, {});
    assertEq(noKey.status, 403, "auth: GET without X-Admin-Key -> 403");

    const report = callRouteSync(auditRouter, { headers: { "x-admin-key": testKey } });
    assertEq(report.status, 200, "AC1: GET report -> 200");
    assertEq(report.body?.success, true, "AC1: success=true");
    assertEq(report.body?.scanned_count, 3, "AC1: scanned_count counts all 3 RFB producer fixtures");

    const naceIds: string[] = (report.body?.nace_default_only_categories?.examples ?? []).map((e: any) => e.id);
    assertTrue(naceIds.includes("soli-brug"), "AC1: Soli Brug-shaped row IS caught as NACE-default-only categories");
    assertTrue(!naceIds.includes("dalpro"), "AC1: DalPro (website-corroborated categories) is NOT in the categories class");
    assertTrue(!naceIds.includes("clean-control"), "AC1: clean control row is NOT in the categories class");
    assertEq(report.body?.nace_default_only_categories?.count, 1, "AC1: nace_default_only_categories.count == 1");

    const boilerplateIds: string[] = (report.body?.boilerplate_description?.examples ?? []).map((e: any) => e.id);
    assertTrue(boilerplateIds.includes("dalpro"), "AC1: DalPro Gårdsmat-shaped row IS caught as boilerplate description");
    assertTrue(!boilerplateIds.includes("soli-brug"), "AC1: Soli Brug (empty description) is NOT in the boilerplate class");
    assertTrue(!boilerplateIds.includes("clean-control"), "AC1: clean control row is NOT in the boilerplate class");

    // Read-only: report never writes.
    const beforeAll = db.prepare("SELECT id, categories, description FROM agents ORDER BY id").all();
    callRouteSync(auditRouter, { headers: { "x-admin-key": testKey } });
    const afterAll = db.prepare("SELECT id, categories, description FROM agents ORDER BY id").all();
    assertEq(afterAll, beforeAll, "AC1: read-only — GET / makes zero DB writes");

    // ── AC2: real outreach-candidates gate excludes NACE-default-only rows ──
    insertPoolEligibleAgent({
      id: "soli-brug-pool",
      name: "Soli Brug Pool",
      email: "soli@prod-test.no",
      categories: ["fish"],
      // no field_provenance.categories at all — the real-world NACE-seeded shape
    });
    insertPoolEligibleAgent({
      id: "corroborated-pool",
      name: "Korrobert Gård",
      email: "korrobert@prod-test.no",
      categories: ["vegetables"],
      fieldProvenance: {
        categories: [{ value: "vegetables", source_type: "website_homepage", fetched_at: "2026-01-01" }],
      },
    });
    insertPoolEligibleAgent({
      id: "no-categories-pool",
      name: "Ingen Kategori Gård",
      email: "ingenkat@prod-test.no",
      categories: [],
    });

    const candidatesRouterPath = require.resolve("./admin-outreach-candidates");
    delete require.cache[candidatesRouterPath];
    const candidatesRouter = require("./admin-outreach-candidates").default;

    const gateResult = callRouteSync(candidatesRouter, {
      query: { mode: "first" },
      headers: { "x-admin-key": testKey },
    });
    assertEq(gateResult.status, 200, "AC2: GET /admin/outreach-candidates mode=first -> 200");

    const gateIds: string[] = (gateResult.body?.candidates ?? []).map((c: any) => c.agent_id);
    assertTrue(
      !gateIds.includes("soli-brug-pool"),
      "AC2: Soli Brug-shaped pool row (NACE-default-only categories) is EXCLUDED from real outreach candidates",
    );
    assertTrue(
      gateIds.includes("corroborated-pool"),
      "AC2: website-corroborated-categories row is NOT falsely suppressed (still a candidate)",
    );
    assertTrue(
      gateIds.includes("no-categories-pool"),
      "AC2: row with no categories at all is NOT suppressed by this gate (nothing to gate — different claim)",
    );
    assertTrue(
      (gateResult.body?.suppressed_counts?.categories_not_corroborated ?? 0) >= 1,
      "AC2: suppressed_counts.categories_not_corroborated is reported and >= 1",
    );

    // ── AC3: boilerplate description routes to re-enrichment via the REAL
    //         null-and-requeue mechanism (applyRfbRetroScanNull) ────────────

    // Dry-run default: no writes.
    const dryRun = callRouteSync(auditRouter, {
      method: "POST",
      path: "/route-boilerplate-to-reenrichment",
      headers: { "x-admin-key": testKey },
    });
    assertEq(dryRun.status, 200, "AC3: POST route-boilerplate-to-reenrichment (dry-run) -> 200");
    assertEq(dryRun.body?.dry_run, true, "AC3: dry_run:true by default");
    assertTrue(
      (dryRun.body?.candidates ?? []).some((c: any) => c.id === "dalpro" && c.field === "description"),
      "AC3: dry-run response lists the DalPro row as a boilerplate-description candidate",
    );
    const dalproBefore = db.prepare("SELECT description FROM agents WHERE id = 'dalpro'").get() as { description: string };
    assertEq(dalproBefore.description, DALPRO_SHAPED_BOILERPLATE, "AC3: dry-run default writes NOTHING (description unchanged)");

    // apply=1: routes the boilerplate description back to re-enrichment.
    const applied = callRouteSync(auditRouter, {
      method: "POST",
      path: "/route-boilerplate-to-reenrichment",
      query: { apply: "1" },
      headers: { "x-admin-key": testKey },
    });
    assertEq(applied.status, 200, "AC3: POST route-boilerplate-to-reenrichment (apply=1) -> 200");
    assertEq(applied.body?.dry_run, false, "AC3: dry_run:false when apply=1");
    assertTrue(
      (applied.body?.routed_to_reenrichment ?? []).some((r: any) => r.agent_id === "dalpro" && r.field === "description"),
      "AC3: apply=1 reports DalPro's description as routed_to_reenrichment",
    );

    const dalproAfter = db.prepare("SELECT description FROM agents WHERE id = 'dalpro'").get() as { description: string };
    assertEq(
      dalproAfter.description,
      "",
      "AC3: apply=1 NULLS (empties) the boilerplate description — the same shape brreg-description-fallback's own candidate WHERE clause (TRIM(description)='') already re-selects for (re-)enrichment",
    );

    const dalproKnowledge = db
      .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = 'dalpro'")
      .get() as { field_provenance: string };
    const dalproProv = JSON.parse(dalproKnowledge.field_provenance || "{}");
    assertTrue(
      !("description" in dalproProv),
      "AC3: field_provenance.description entry is removed when the field is nulled (no stale source claim left behind)",
    );

    // Clean control's description must be completely untouched by the apply
    // call (it was never flagged — never in the candidate set to begin with).
    const cleanAfter = db.prepare("SELECT description FROM agents WHERE id = 'clean-control'").get() as {
      description: string;
    };
    assertEq(
      cleanAfter.description,
      NORMAL_PROSE_DESCRIPTION,
      "AC3: apply=1 never touches a row that isJunkDescription did not flag (clean-control untouched)",
    );

    // Auth gate on the POST route too.
    const postNoKey = callRouteSync(auditRouter, { method: "POST", path: "/route-boilerplate-to-reenrichment" });
    assertEq(postNoKey.status, 403, "auth: POST route-boilerplate-to-reenrichment without X-Admin-Key -> 403");
  } catch (err) {
    failed++;
    failures.push(
      `admin-agents-category-description-provenance-audit: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    );
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./admin-agents-category-description-provenance-audit")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./admin-outreach-candidates")]; } catch { /* ignore */ }
    db.close();
  }

  return { passed, failed, failures };
}

// Standalone runner:
// `npx tsx src/routes/admin-agents-category-description-provenance-audit.test.ts`
if (require.main === module) {
  console.log("── dev-request 2026-09-09-rfb-kategori-og-beskrivelse-provenance-audit ──");
  runAdminAgentsCategoryDescriptionProvenanceAuditTests({ log: true }).then((r) => {
    console.log(`\ncategory-description-provenance-audit: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}

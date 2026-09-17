/**
 * cross-vertical-contact-lookup.test.ts — unit tests for
 * findCrossVerticalEntriesByEmail() (services/cross-vertical-contact-lookup.ts),
 * added per dev-requests/2026-09-13-fjern-svar-kobles-ikke-paa-tvers-av-vertikaler.md.
 *
 * Mirrors crm-service.test.ts / route-level tests being split apart: this
 * file exercises the pure lookup function directly (no HTTP layer), while
 * admin-cross-vertical-contact-lookup.test.ts covers the route's own
 * validation/response-shape/auth concerns.
 *
 * Same DB seams as the route test: rfb via __setDbForTesting +
 * __initSchemaForTesting on an in-memory db; dental/experiences via
 * db-factory.ts's getDb() + __resetDbFactoryForTesting(), pointed at a
 * scratch temp directory via DENTAL_DB_PATH/EXPERIENCES_DB_PATH.
 *
 * Covers:
 *   (a) empty / whitespace-only email -> [] immediately, no query run
 *   (b) exact match found on exactly one non-excluded vertical
 *   (c) a match on the excludeVertical itself is never returned
 *   (d) no rows anywhere -> []
 *   (e) round-1 review fix-up (PR #860): a deactivated/terminal row for the
 *       target email is EXCLUDED from hits, while an active row for the same
 *       email in the same table IS included — one pair per vertical, proving
 *       the is_active / is_inactive / terminal_status filter actually
 *       discriminates:
 *         - rfb agents.is_active: 0 excluded, 1 included
 *         - dental_agents.is_inactive: 1 excluded, NULL/0 included
 *         - experience_providers.terminal_status: 'dod_kilde' excluded, NULL
 *           included
 *   (f) whitespace-trim regression: a stored email with incidental
 *       leading/trailing whitespace still matches a clean query-side email
 *   (g) round-2 review fix-up (PR #860): the two liveness predicates that
 *       were too narrow are now fuller, proven discriminating (not just
 *       absent) with one excluded/included pair each:
 *         - dental_agents.verification_status: 'rejected' excluded,
 *           'verified' included (both rows also is_inactive-clear, so this
 *           isolates the verification_status half specifically)
 *         - experience_providers.catalog_hidden: 1 excluded, NULL included
 *           (both rows also terminal_status-clear, so this isolates the
 *           catalog_hidden half specifically)
 *   (h) round-3 review fix-up (PR #860): two more predicate halves, again
 *       proven discriminating with one excluded/included pair each:
 *         - dental_agents: a row that passes verification_status/
 *           is_inactive but is classified catalog_class='lab_leverandor'
 *           (fails DENTAL_CLINIC_CLASS_SQL) is excluded, while a sibling row
 *           with the same email and catalog_class='klinikk' is included
 *         - experience_providers: a row that passes terminal_status/
 *           catalog_hidden but has name_collision=1 is excluded, while a
 *           sibling row with the same email and name_collision=0 is
 *           included
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import * as initMod from "../database/init";
import * as dbFactory from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrossVerticalContactLookupTests(
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
    const prevDb = initMod.getDb();
    const scratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cross-vertical-contact-lookup-test-"),
    );
    const scratchDentalDbPath = path.join(scratchRoot, "dental.db");
    const scratchExperiencesDbPath = path.join(scratchRoot, "experiences.db");
    const prevDentalDbPathEnv = process.env.DENTAL_DB_PATH;
    const prevExperiencesDbPathEnv = process.env.EXPERIENCES_DB_PATH;
    process.env.DENTAL_DB_PATH = scratchDentalDbPath;
    process.env.EXPERIENCES_DB_PATH = scratchExperiencesDbPath;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      dbFactory.__resetDbFactoryForTesting();
      const experiencesDb = dbFactory.getDb("experiences");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', ?, 'https://example.com', 'producer', ?)`,
      );
      insertAgent.run("rfb-agent-1", "RFB Gård", "shared@example.com", "key-1");

      experiencesDb
        .prepare(`INSERT INTO experience_providers (id, navn, epost) VALUES (?, ?, ?)`)
        .run("exp-provider-1", "Opplevelse AS", "shared@example.com");

      delete require.cache[require.resolve("./cross-vertical-contact-lookup")];
      const mod = require("./cross-vertical-contact-lookup") as
        typeof import("./cross-vertical-contact-lookup");

      // ── (a) empty / whitespace-only email -> [] immediately ─────────
      assertEq(mod.findCrossVerticalEntriesByEmail("", "rfb"), [], "(a) empty email -> []");
      assertEq(mod.findCrossVerticalEntriesByEmail("   ", "rfb"), [], "(a) whitespace-only email -> []");

      // ── (b) exact match found on a non-excluded vertical ────────────
      const hits = mod.findCrossVerticalEntriesByEmail("shared@example.com", "dental");
      assertEq(hits.length, 2, "(b) shared email matches rfb + experiences when excluding dental");
      assertEq(
        hits.find((h) => h.vertical === "rfb"),
        { vertical: "rfb", id: "rfb-agent-1", name: "RFB Gård" },
        "(b) rfb hit shape",
      );
      assertEq(
        hits.find((h) => h.vertical === "experiences"),
        { vertical: "experiences", id: "exp-provider-1", name: "Opplevelse AS" },
        "(b) experiences hit shape",
      );

      // ── (c) a match on the excludeVertical itself is never returned ──
      const excludingRfb = mod.findCrossVerticalEntriesByEmail("shared@example.com", "rfb");
      assertEq(
        excludingRfb.every((h) => h.vertical !== "rfb"),
        true,
        "(c) excludeVertical='rfb' never appears in the results",
      );
      assertEq(excludingRfb.length, 1, "(c) only the experiences hit remains when excluding rfb");

      // ── (d) no rows anywhere -> [] ───────────────────────────────────
      assertEq(
        mod.findCrossVerticalEntriesByEmail("nobody-anywhere@example.com", "rfb"),
        [],
        "(d) genuinely unmatched email -> []",
      );

      // ── (e) round-1 review fix-up (PR #860): liveness filter per vertical ──
      const dentalDb = dbFactory.getDb("dental");

      // rfb: is_active = 0 excluded, is_active = 1 included
      insertAgent.run("rfb-inactive-1", "RFB Inaktiv", "rfb-liveness@example.com", "key-2");
      db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run("rfb-inactive-1");
      insertAgent.run("rfb-active-1", "RFB Aktiv", "rfb-liveness@example.com", "key-3");
      const rfbLiveness = mod.findCrossVerticalEntriesByEmail("rfb-liveness@example.com", "dental");
      assertEq(
        rfbLiveness.filter((h) => h.vertical === "rfb").map((h) => h.id),
        ["rfb-active-1"],
        "(e) rfb: is_active=0 row excluded, is_active=1 row for same email included",
      );

      // dental: is_inactive = 1 excluded, is_inactive = NULL/0 included
      dentalDb
        .prepare(`INSERT INTO dental_agents (id, navn, epost, is_inactive) VALUES (?, ?, ?, 1)`)
        .run("dental-inactive-1", "Dental Inaktiv", "dental-liveness@example.com");
      dentalDb
        .prepare(`INSERT INTO dental_agents (id, navn, epost, is_inactive) VALUES (?, ?, ?, 0)`)
        .run("dental-active-1", "Dental Aktiv", "dental-liveness@example.com");
      const dentalLiveness = mod.findCrossVerticalEntriesByEmail("dental-liveness@example.com", "rfb");
      assertEq(
        dentalLiveness.filter((h) => h.vertical === "dental").map((h) => h.id),
        ["dental-active-1"],
        "(e) dental: is_inactive=1 row excluded, is_inactive=0 row for same email included",
      );

      // experiences: terminal_status='dod_kilde' excluded, terminal_status=NULL included
      experiencesDb
        .prepare(
          `INSERT INTO experience_providers (id, navn, epost, terminal_status) VALUES (?, ?, ?, 'dod_kilde')`,
        )
        .run("exp-terminal-1", "Opplevelse Død", "exp-liveness@example.com");
      experiencesDb
        .prepare(`INSERT INTO experience_providers (id, navn, epost) VALUES (?, ?, ?)`)
        .run("exp-active-1", "Opplevelse Aktiv", "exp-liveness@example.com");
      const expLiveness = mod.findCrossVerticalEntriesByEmail("exp-liveness@example.com", "rfb");
      assertEq(
        expLiveness.filter((h) => h.vertical === "experiences").map((h) => h.id),
        ["exp-active-1"],
        "(e) experiences: terminal_status='dod_kilde' row excluded, terminal_status=NULL row for same email included",
      );

      // ── (g) round-2 review fix-up (PR #860): fuller liveness predicates ──
      // dental: verification_status='rejected' excluded, 'verified' included
      // (both rows is_inactive-clear, so this isolates the
      // verification_status half of the predicate specifically).
      dentalDb
        .prepare(
          `INSERT INTO dental_agents (id, navn, epost, verification_status) VALUES (?, ?, ?, 'rejected')`,
        )
        .run("dental-rejected-1", "Dental Avvist", "dental-verification@example.com");
      dentalDb
        .prepare(
          `INSERT INTO dental_agents (id, navn, epost, verification_status) VALUES (?, ?, ?, 'verified')`,
        )
        .run("dental-verified-1", "Dental Verifisert", "dental-verification@example.com");
      const dentalVerification = mod.findCrossVerticalEntriesByEmail(
        "dental-verification@example.com",
        "rfb",
      );
      assertEq(
        dentalVerification.filter((h) => h.vertical === "dental").map((h) => h.id),
        ["dental-verified-1"],
        "(g) dental: verification_status='rejected' row excluded, 'verified' row for same email included",
      );

      // experiences: catalog_hidden=1 excluded, catalog_hidden IS NULL included
      // (both rows terminal_status-clear, so this isolates the
      // catalog_hidden half of the predicate specifically).
      experiencesDb
        .prepare(
          `INSERT INTO experience_providers (id, navn, epost, catalog_hidden) VALUES (?, ?, ?, 1)`,
        )
        .run("exp-hidden-1", "Opplevelse Skjult", "exp-catalog-hidden@example.com");
      experiencesDb
        .prepare(`INSERT INTO experience_providers (id, navn, epost) VALUES (?, ?, ?)`)
        .run("exp-visible-1", "Opplevelse Synlig", "exp-catalog-hidden@example.com");
      const expCatalogHidden = mod.findCrossVerticalEntriesByEmail(
        "exp-catalog-hidden@example.com",
        "rfb",
      );
      assertEq(
        expCatalogHidden.filter((h) => h.vertical === "experiences").map((h) => h.id),
        ["exp-visible-1"],
        "(g) experiences: catalog_hidden=1 row excluded, catalog_hidden IS NULL row for same email included",
      );

      // ── (h) round-3 review fix-up (PR #860): DENTAL_CLINIC_CLASS_SQL /
      // name_collision predicate halves ────────────────────────────────
      // dental: catalog_class='lab_leverandor' (fails DENTAL_CLINIC_CLASS_SQL)
      // excluded, catalog_class='klinikk' included (both rows also pass
      // verification_status/is_inactive, so this isolates the
      // DENTAL_CLINIC_CLASS_SQL half specifically).
      dentalDb
        .prepare(
          `INSERT INTO dental_agents (id, navn, epost, catalog_class) VALUES (?, ?, ?, 'lab_leverandor')`,
        )
        .run("dental-lab-1", "Dental Lab", "dental-catalog-class@example.com");
      dentalDb
        .prepare(
          `INSERT INTO dental_agents (id, navn, epost, catalog_class) VALUES (?, ?, ?, 'klinikk')`,
        )
        .run("dental-clinic-1", "Dental Klinikk", "dental-catalog-class@example.com");
      const dentalCatalogClass = mod.findCrossVerticalEntriesByEmail(
        "dental-catalog-class@example.com",
        "rfb",
      );
      assertEq(
        dentalCatalogClass.filter((h) => h.vertical === "dental").map((h) => h.id),
        ["dental-clinic-1"],
        "(h) dental: catalog_class='lab_leverandor' row excluded (fails DENTAL_CLINIC_CLASS_SQL), 'klinikk' row for same email included",
      );

      // experiences: name_collision=1 excluded, name_collision=0 included
      // (both rows also terminal_status/catalog_hidden-clear, so this
      // isolates the name_collision half specifically).
      experiencesDb
        .prepare(
          `INSERT INTO experience_providers (id, navn, epost, name_collision) VALUES (?, ?, ?, 1)`,
        )
        .run("exp-collision-1", "Opplevelse Kollisjon", "exp-name-collision@example.com");
      experiencesDb
        .prepare(
          `INSERT INTO experience_providers (id, navn, epost, name_collision) VALUES (?, ?, ?, 0)`,
        )
        .run("exp-resolved-1", "Opplevelse Avklart", "exp-name-collision@example.com");
      const expNameCollision = mod.findCrossVerticalEntriesByEmail(
        "exp-name-collision@example.com",
        "rfb",
      );
      assertEq(
        expNameCollision.filter((h) => h.vertical === "experiences").map((h) => h.id),
        ["exp-resolved-1"],
        "(h) experiences: name_collision=1 row excluded, name_collision=0 row for same email included",
      );

      // ── (f) whitespace-trim regression ───────────────────────────────
      insertAgent.run("rfb-whitespace-1", "RFB Whitespace", "  whitespace@example.com  ", "key-4");
      const whitespaceHits = mod.findCrossVerticalEntriesByEmail("whitespace@example.com", "dental");
      assertEq(
        whitespaceHits.some((h) => h.id === "rfb-whitespace-1"),
        true,
        "(f) stored email with incidental leading/trailing whitespace still matches a clean query-side email",
      );
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevDentalDbPathEnv === undefined) delete process.env.DENTAL_DB_PATH;
      else process.env.DENTAL_DB_PATH = prevDentalDbPathEnv;
      if (prevExperiencesDbPathEnv === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPathEnv;
      try {
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup — never fail the suite over teardown
      }
      db.close();
      try {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        // best-effort scratch-dir cleanup; never fail the test suite over it
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/cross-vertical-contact-lookup.test.ts`
if (require.main === module) {
  runCrossVerticalContactLookupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

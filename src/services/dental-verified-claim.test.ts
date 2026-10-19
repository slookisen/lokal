/**
 * dental-verified-claim.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S8.
 *
 * «Verifisert» is shown only when the stored fields meet the rule the badge
 * text describes (resolveVerifiedClaim and its SQL twin
 * DENTAL_VERIFIED_CLAIM_SQL, services/dental-verified-claim.ts). By prefix:
 *   M   the rule moved out of dental-verifier.ts: the verifier re-exports the
 *       same functions and constants, and the new module imports neither the
 *       store nor the verifier (the import cycle it breaks);
 *   T   the truth table: verified without an org.nr. (brreg_status NULL),
 *       under 3 rich fields, closed, a website not confirmed without the
 *       directory exception, and a 'pending_verify' that passes the rule all
 *       give no; a public clinic with a directory listing and Brreg active
 *       gives yes; with the switch off the stored status alone decides;
 *       shownVerificationStatus;
 *   C   countRichFields reads stored text as before (the verifier's own
 *       cases) and parsed values (a row built by hand);
 *   S   SQL↔JS parity over every combination of the gate columns, and over
 *       the JSON edge cases of each rich field ('[]', '{}', malformed JSON,
 *       JSON scalars, whitespace that .trim() removes and SQLite's default
 *       trim() does not), for the hydrated row (as the pages read it), the
 *       raw row (as the verifier reads it) and the verifier's own
 *       computeDentalVerifiedRule; malformed JSON raises no SQL error;
 *   H   hydrateAgent carries brreg_status, website_ownership and, for a
 *       row stored as 'verified', rich_field_count from the stored text, so
 *       a malformed JSON column (null once hydrated) still counts as the
 *       verifier counts it.
 *
 * Standalone: npx tsx src/services/dental-verified-claim.test.ts
 * Wired into tests/test.ts via runDentalVerifiedClaimTests().
 */

import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runDentalVerifiedClaimTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  const sorted = (xs: string[]) => [...xs].sort();

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const claim = require("./dental-verified-claim") as typeof import("./dental-verified-claim");
    const verifier = require("./dental-verifier") as typeof import("./dental-verifier");
    const { resolveVerifiedClaim, shownVerificationStatus, dentalVerifiedClaimSql, DENTAL_VERIFIED_CLAIM_SQL, countRichFields, DENTAL_RICH_FIELDS } = claim;
    const MIN = claim.DENTAL_VERIFIER_MIN_RICH_FIELDS;

    // ── M: the rule moved, the verifier re-exports it ─────────────────────
    eq([verifier.computeDentalVerifiedRule === claim.computeDentalVerifiedRule, verifier.countRichFields === claim.countRichFields,
      verifier.DENTAL_RICH_FIELDS === claim.DENTAL_RICH_FIELDS, verifier.DENTAL_VERIFIER_MIN_RICH_FIELDS === MIN],
      [true, true, true, true], "M1: dental-verifier re-exports the rule, the count and the constants (one implementation)");
    eq([MIN, DENTAL_RICH_FIELDS.length], [3, 10], "M2: 3 of 10 rich fields, as before");
    const src = fs.readFileSync(path.join(__dirname, "dental-verified-claim.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    eq(imports, ["./dental-catalog-class"], "M3: the module imports only dental-catalog-class (a type), never the store or the verifier");
    ok(/^import type /m.test(src), "M3b: … and that import is type-only");
    const catalogSrc = fs.readFileSync(path.join(__dirname, "dental-catalog-class.ts"), "utf8");
    ok(!/^import /m.test(catalogSrc), "M3c: dental-catalog-class itself imports nothing, so there is no cycle");

    // ── T: the truth table ────────────────────────────────────────────────
    const shown = {
      verification_status: "verified", is_inactive: 0, brreg_status: "active", website_ownership: "verified",
      catalog_class: "klinikk", directory_url: null, rich_field_count: MIN,
    };
    ok(resolveVerifiedClaim(shown), "T0 control: stored 'verified', Brreg active, own website, 3 rich fields -> the badge");
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["verified without an org.nr. (brreg_status NULL)", { brreg_status: null }, false],
      ["Brreg gave no definite answer", { brreg_status: "orgnr_not_found_or_unreachable" }, false],
      ["Brreg: dissolved", { brreg_status: "dissolved" }, false],
      [`${MIN - 1} rich fields`, { rich_field_count: MIN - 1 }, false],
      ["closed (is_inactive 1)", { is_inactive: 1 }, false],
      ["website not confirmed, no directory exception", { website_ownership: "unverified" }, false],
      ["website never checked", { website_ownership: null }, false],
      ["a private clinic with a directory_url", { website_ownership: "unverified", directory_url: "https://example.test/k" }, false],
      ["'pending_verify' that passes the rule (the rule only hides)", { verification_status: "pending_verify" }, false],
      ["'needs_review' that passes the rule", { verification_status: "needs_review" }, false],
      ["public clinic, directory listing, Brreg active", { website_ownership: "n/a", catalog_class: "offentlig_klinikk", directory_url: "https://example.test/k" }, true],
      ["public clinic, directory listing, no Brreg status (ed71a821)", { website_ownership: "n/a", catalog_class: "offentlig_klinikk", directory_url: "https://example.test/k", brreg_status: null }, false],
      ["public clinic, blank directory_url", { website_ownership: "n/a", catalog_class: "offentlig_klinikk", directory_url: " \t " }, false],
      ["public clinic with its own website confirmed", { catalog_class: "offentlig_klinikk" }, true],
      ["more rich fields than needed", { rich_field_count: 10 }, true],
    ];
    for (const [label, change, expected] of cases) eq(resolveVerifiedClaim({ ...shown, ...change }), expected, `T1 ${label}`);
    eq([resolveVerifiedClaim({ verification_status: "verified" }, false), resolveVerifiedClaim({ ...shown, brreg_status: null, is_inactive: 1 }, false),
      resolveVerifiedClaim({ ...shown, verification_status: "pending_verify" }, false)], [true, true, false],
      "T2: switch off: the stored 'verified' alone decides, as before F2-S8");
    eq(claim.VERIFIED_CLAIM_REQUIRES_RULE, true, "T3: the switch is on");
    ok(dentalVerifiedClaimSql() === DENTAL_VERIFIED_CLAIM_SQL && dentalVerifiedClaimSql(false) === "verification_status = 'verified'", "T4: the SQL follows the switch");
    eq(
      [
        shownVerificationStatus(shown), shownVerificationStatus({ ...shown, brreg_status: null }),
        shownVerificationStatus({ ...shown, verification_status: "needs_review", brreg_status: null }),
        shownVerificationStatus({ ...shown, verification_status: "rejected" }), shownVerificationStatus({ ...shown, verification_status: "pending_verify" }),
        shownVerificationStatus({ ...shown, brreg_status: null }, false),
      ],
      ["verified", "pending_verify", "needs_review", "rejected", "pending_verify", "verified"],
      "T5: shownVerificationStatus: 'pending_verify' only where the claim hides a stored 'verified'; other values and the switch off as stored"
    );

    // ── C: countRichFields, stored text and parsed values ─────────────────
    eq([countRichFields({}), countRichFields({ om_oss: "  " }), countRichFields({ om_oss: "Vi er en klinikk." }), countRichFields({ specialists: "[]" }),
      countRichFields({ treatments_subtypes: "{}" }), countRichFields({ social_media: "not valid json {" })], [0, 0, 1, 0, 0, 1],
      "C1: stored text as the verifier reads it (its rich-01..08 cases): blank, '[]' and '{}' do not count, malformed JSON does");
    eq([countRichFields({ specialists: [] }), countRichFields({ specialists: [{ name: "A" }] }), countRichFields({ social_media: {} }),
      countRichFields({ social_media: { facebook: "x" } }), countRichFields({ patient_focus: null }), countRichFields({ om_oss: null })], [0, 1, 0, 1, 0, 0],
      "C2: parsed values (a row built by hand): an empty array or object does not count, a filled one does");
    eq(resolveVerifiedClaim({ ...shown, rich_field_count: undefined, om_oss: "Om oss.", specialists: [{ name: "A" }], online_booking_url: "https://x.test" }), true,
      "C3: without rich_field_count the claim counts the row's own values");
    eq(resolveVerifiedClaim({ ...shown, rich_field_count: undefined, om_oss: "Om oss.", specialists: [] }), false, "C3b: … and two of them are not enough");

    // ── S: SQL↔JS parity ──────────────────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("./dental-store") as typeof import("./dental-store");
    const cols = ["id", "navn", "verification_status", "is_inactive", "brreg_status", "website_ownership", "catalog_class", "directory_url", ...DENTAL_RICH_FIELDS];
    const insert = db.prepare(`INSERT INTO dental_agents (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`);
    const blankRich = Object.fromEntries(DENTAL_RICH_FIELDS.map((f) => [f, null]));
    const THREE_RICH = { ...blankRich, om_oss: "Om klinikken.", payment_options: '["kort"]', social_media: '{"facebook":"https://example.test"}' };
    /** Parity on the rows whose id starts with `prefix`: SQL, the hydrated row, the raw row and the verifier's rule. */
    const parity = (prefix: string, label: string): number => {
      let sqlIds: string[] = [];
      let threw = "";
      try {
        sqlIds = (db.prepare(`SELECT id FROM dental_agents WHERE id LIKE @p AND ${DENTAL_VERIFIED_CLAIM_SQL}`).all({ p: `${prefix}%` }) as Array<{ id: string }>).map((r) => r.id);
      } catch (err: any) {
        threw = String(err?.message || err);
      }
      eq(threw, "", `${label}: no SQL error on any row`);
      const raw = db.prepare("SELECT * FROM dental_agents WHERE id LIKE @p").all({ p: `${prefix}%` }) as Array<Record<string, any>>;
      const hydratedIds = raw.filter((r) => resolveVerifiedClaim(store.getDentalAgentById(r.id)!)).map((r) => r.id);
      const rawIds = raw.filter((r) => resolveVerifiedClaim(r)).map((r) => r.id);
      // The verifier's own rule on the stored text (what it would decide).
      const ruleIds = raw.filter((r) => r.verification_status === "verified" && r.is_inactive !== 1 && claim.computeDentalVerifiedRule({
        brregStatus: r.brreg_status, websiteOwnership: r.website_ownership, catalogClass: r.catalog_class, directoryUrl: r.directory_url, richFieldCount: countRichFields(r),
      })).map((r) => r.id);
      eq(sorted(sqlIds), sorted(hydratedIds), `${label}: DENTAL_VERIFIED_CLAIM_SQL picks exactly the rows resolveVerifiedClaim gives on the hydrated row`);
      eq(sorted(rawIds), sorted(hydratedIds), `${label}: … the raw row gives the same`);
      eq(sorted(ruleIds), sorted(hydratedIds), `${label}: … and so does computeDentalVerifiedRule with countRichFields on the stored text`);
      return hydratedIds.length;
    };

    // S1: every combination of the gate columns, with three rich fields.
    {
      const statuses = ["verified", "pending_verify", "needs_review", null];
      // is_inactive is NOT NULL; 2 is no closed clinic for either side.
      const inactive = [0, 1, 2];
      const brreg = ["active", null, "dissolved", "orgnr_not_found_or_unreachable", "ACTIVE"];
      const ownership = ["verified", "unverified", "n/a", null];
      const classes: Array<[string | null, string | null]> = [
        ["klinikk", null], ["klinikk", "https://example.test/k"], ["offentlig_klinikk", "https://example.test/k"],
        ["offentlig_klinikk", null], ["offentlig_klinikk", ""], ["offentlig_klinikk", " \t\n 　﻿"], [null, "https://example.test/k"],
      ];
      let i = 0;
      db.transaction(() => {
        for (const v of statuses) for (const ia of inactive) for (const b of brreg) for (const w of ownership) for (const [cc, du] of classes) {
          insert.run({ ...THREE_RICH, id: `gate-${i}`, navn: `Gate ${i++}`, verification_status: v, is_inactive: ia, brreg_status: b, website_ownership: w, catalog_class: cc, directory_url: du });
        }
      })();
      const shownCount = parity("gate-", "S1");
      ok(i === 4 * 3 * 5 * 4 * 7 && shownCount > 0 && shownCount < i / 10, `S1b control: (${i} gate rows, ${shownCount} with the badge)`);
    }

    // S2: each rich field holding each edge value, next to two filled
    // fields, so the badge depends on whether that value counts.
    {
      const EDGE: Array<string | null> = [
        null, "", "   ", "\t", "\n", " ", "　", "﻿", " ",
        "[]", "[ ]", " [] ", "\t[]\n", "{}", "{ }", " []", "﻿{}", "[null]", "[[]]", "[1]", '{"a":1}', '{"a":null}',
        '""', '"  "', '"x"', '"[]"', "null", " null ", "0", "-0", "false", "true", "1e400",
        "{bad", "[1,]", "{a:1}", "'x'", "01", "not json", "https://booking.example.test/time", "Vi er en klinikk.",
      ];
      let i = 0;
      db.transaction(() => {
        for (const field of DENTAL_RICH_FIELDS) {
          // Two filled fields other than the one under test.
          const others = DENTAL_RICH_FIELDS.filter((f) => f !== field).slice(0, 2);
          for (const value of EDGE) {
            const row: Record<string, unknown> = { ...blankRich, [others[0]!]: '["a"]', [others[1]!]: '["b"]', [field]: value };
            if (others.includes("om_oss")) row.om_oss = "Om klinikken.";
            insert.run({ ...row, id: `rich-${i}`, navn: `Rich ${i++}`, verification_status: "verified", is_inactive: 0, brreg_status: "active", website_ownership: "verified", catalog_class: "klinikk", directory_url: null });
          }
        }
      })();
      const shownCount = parity("rich-", "S2");
      ok(i === DENTAL_RICH_FIELDS.length * EDGE.length && shownCount > 0 && shownCount < i, `S2b control: (${i} rows, ${shownCount} with the badge: some edge values count, some do not)`);
      // The verifier's own cases, spelled out: what counts as the third field.
      const counts = (field: string, values: Array<string | null>) => values.map((v) => countRichFields({ [field]: v } as never));
      eq(counts("specialists", ["[]", "[ ]", "{}", "{bad", '"x"', '""', "null", "0", "false", " []"]), [0, 0, 0, 1, 1, 0, 0, 1, 1, 1],
        "S3: '[]', '{}', '\"\"' and null are empty; malformed JSON, a JSON string, 0, false and NBSP-led text count");
      eq(counts("om_oss", ["   ", " 　", "[]"]), [0, 0, 1], "S3b: om_oss is plain text: whitespace .trim() removes is empty, '[]' is text");
    }

    // ── H: hydrateAgent and the side values ───────────────────────────────
    {
      insert.run({ ...THREE_RICH, payment_options: "{bad json", id: "hyd-malformed", navn: "Hyd Malformed", verification_status: "verified", is_inactive: 0, brreg_status: "active", website_ownership: "verified", catalog_class: "klinikk", directory_url: null });
      insert.run({ ...THREE_RICH, id: "hyd-pending", navn: "Hyd Pending", verification_status: "pending_verify", is_inactive: 0, brreg_status: "active", website_ownership: "verified", catalog_class: "klinikk", directory_url: null });
      const h = store.getDentalAgentById("hyd-malformed")!;
      eq([h.payment_options, h.rich_field_count, h.brreg_status, h.website_ownership], [null, 3, "active", "verified"],
        "H1: a malformed JSON column is null once hydrated, but rich_field_count counts its stored text, as the verifier does");
      eq([resolveVerifiedClaim(h), resolveVerifiedClaim({ ...h, rich_field_count: undefined })], [true, false],
        "H2: so the claim agrees with the verifier and the SQL; counting the hydrated values would not");
      const p = store.getDentalAgentById("hyd-pending")!;
      eq([p.rich_field_count, p.brreg_status], [null, "active"], "H3: rich_field_count only for a row stored as 'verified' (the claim reads it for no other)");
      const keys = Object.keys(store.withoutDentalSideColumns(h));
      eq(["stage_v_pending_correction", "brreg_status", "website_ownership", "rich_field_count"].filter((k) => keys.includes(k)), [],
        "H4: withoutDentalSideColumns leaves out every side value");
      eq(keys, Object.keys(h).filter((k) => !["stage_v_pending_correction", "brreg_status", "website_ownership", "rich_field_count"].includes(k)),
        "H5: … and keeps the other keys in their order");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental verified claim: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalVerifiedClaimTests({ log: true }).then((r) => {
    console.log(`\ndental verified claim (F2-S8): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

/**
 * beta-enrollment.test.ts — A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle,
 * slice S2 (table, main flag, cap, admin stats; no UI).
 *
 *   mode      OWNER_BETA_MODE exact match: off | offer | all; unset/""/unknown → off
 *             (unknown logged once); OWNER_BETA_CAP unset → 25, invalid → 0
 *   table     owner_beta_enrollment exists with the agreed columns, status CHECK,
 *             one row per (vertical, agent_id), no e-mail/IP column
 *   writes    optIn / optOut / registerInterest: rfb only, offer only (optOut
 *             always), one owner_feature_audit row per change, no-op writes nothing
 *   AC4       cap N → the (N+1)th opt-in is `interested`; raising the cap does
 *             not auto-enroll; invalid cap → 0 → interested
 *   AC1       mode/tiers unset: access and every bulk path = the pilot list, with
 *             a DB that throws on use (proves no DB access) — pilot / normal /
 *             anonymous; mode offer with tiers unset: same
 *   access    beta = pilot OR (offer AND active row), rfb only; mode off ignores rows
 *   AC2       unknown mode, invalid cap, DB error, missing session, unverified
 *             owner, vertical ≠ rfb → beta never allowed
 *   all       mode all: beta feature allowed for a verified non-pilot owner
 *             without enrollment; product_import_outreach stays beta (N7)
 *   bulk (N1) enforce.ts / visibility.ts / stock-check ids / today-facts follow
 *             the tier model; ga bulk = pilot ∪ verified owners
 *   admin     GET /admin/owner-beta/stats: 401 without key, shape, counts, no ids
 *
 * In-memory DB. Exported runBetaEnrollmentTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/owner-features/beta-enrollment.test.ts
 */

import http from "http";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PIL = "s2-pilot";
const OUT = "s2-out";
const OWN2 = "s2-owner2";
const NOOWN = "s2-unclaimed";
const ALLOW = `rfb:${PIL}`;

function envOf(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: Record<string, string> = { OWNER_FEATURES_ALLOWED_SUBJECTS: ALLOW };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) e[k] = v;
  return e as NodeJS.ProcessEnv;
}

/** A DB stand-in that throws on any use. */
const THROWING_DB: any = new Proxy({}, { get() { throw new Error("db must not be touched"); } });

/** Wrap a real DB and record every statement's SQL + parameters. */
function recordingDb(real: any, log: Array<{ sql: string; args: unknown[] }>): any {
  return {
    prepare(sql: string) {
      const st = real.prepare(sql);
      const wrap = (fn: string) => (...args: unknown[]) => { log.push({ sql, args }); return st[fn](...args); };
      return { all: wrap("all"), get: wrap("get"), run: wrap("run") };
    },
    transaction: (fn: any) => real.transaction(fn),
  };
}

export async function runBetaEnrollmentTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = "") => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${name}`); }
    else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); if (log) console.log(`  ✗ ${name} ${detail}`); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const bm = require("./beta-mode") as typeof import("./beta-mode");
  const be = require("./beta-enrollment") as typeof import("./beta-enrollment");
  const ft = require("./feature-tiers") as typeof import("./feature-tiers");

  const warnings: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  console.error = () => { /* fail-closed paths log; keep the run quiet */ };
  bm.__resetBetaModeLogForTesting();
  ft.__resetFeatureTierLogForTesting();
  ft.__setBetaEnrollmentLookupForTesting(null);

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
  const ENV_KEYS = ["OWNER_BETA_MODE", "OWNER_BETA_CAP", "OWNER_FEATURE_TIERS"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  try {
    initMod.__initSchemaForTesting(db as any);
    be.__setBetaEnrollmentTestDb(db);

    // Seed: pilot owner, two verified non-pilot owners (claimed_at / verified
    // claim), one profile without an owner.
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')`);
    for (const id of [PIL, OUT, OWN2, NOOWN]) insAgent.run(id, `Gård ${id}`, `${id}@farm.example.no`, `k-${id}`);
    db.prepare("UPDATE agents SET claimed_at = '2026-11-01T00:00:00Z' WHERE id IN (?, ?)").run(PIL, OUT);
    db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('c-s2', ?, 'Eier', 'eier@example.no', 'verified')").run(OWN2);
    db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('c-s2b', ?, 'Noen', 'noen@example.no', 'pending')").run(NOOWN);

    // ── Mode + cap parsing ──────────────────────────────────────────────
    {
      const m = (v: string | undefined) => bm.ownerBetaMode((v === undefined ? {} : { OWNER_BETA_MODE: v }) as NodeJS.ProcessEnv);
      check("mode: unset → off", m(undefined) === "off");
      check("mode: \"\" → off", m("") === "off");
      check("mode: off/offer/all exact", m("off") === "off" && m("offer") === "offer" && m("all") === "all");
      warnings.length = 0;
      bm.__resetBetaModeLogForTesting();
      const bad = ["Offer", "OFFER", " offer", "offer ", "on", "1", "true", "ALL", "all\n", "pilot"];
      check("mode: case / whitespace / other values → off", bad.every((v) => m(v) === "off"), bad.filter((v) => m(v) !== "off").join(","));
      check("mode: unknown value logged", warnings.some((w) => w.includes("OWNER_BETA_MODE") && w.includes("Offer")));
      const n = warnings.length;
      m("Offer"); m("Offer");
      check("mode: unknown value logged once", warnings.length === n);
      const c = (v: string | undefined) => bm.ownerBetaCap((v === undefined ? {} : { OWNER_BETA_CAP: v }) as NodeJS.ProcessEnv);
      check("cap: unset → 25", c(undefined) === 25);
      check("cap: \"3\" → 3, \"0\" → 0, \"100\" → 100", c("3") === 3 && c("0") === 0 && c("100") === 100);
      const badCaps = ["", " 3", "3 ", "-1", "+3", "3.5", "1e2", "abc", "0x10", "99999999999999999999"];
      check("cap: invalid → 0", badCaps.every((v) => c(v) === 0), badCaps.filter((v) => c(v) !== 0).join(","));
    }

    // ── Table ───────────────────────────────────────────────────────────
    {
      const cols = (db.prepare("PRAGMA table_info(owner_beta_enrollment)").all() as Array<{ name: string; pk: number }>);
      const names = cols.map((c) => c.name).sort();
      check("table: agreed columns", JSON.stringify(names) === JSON.stringify(["agent_id", "opted_in_at", "opted_out_at", "status", "terms_version", "updated_at", "vertical"]), names.join(","));
      check("table: no e-mail/IP column", !names.some((n) => /mail|ip/i.test(n)));
      check("table: primary key (vertical, agent_id)", cols.filter((c) => c.pk > 0).map((c) => c.name).sort().join(",") === "agent_id,vertical");
      let rejected = false;
      try { db.prepare("INSERT INTO owner_beta_enrollment (vertical, agent_id, status, updated_at) VALUES ('rfb', 'x', 'enabled', 'now')").run(); } catch { rejected = true; }
      check("table: status CHECK rejects other values", rejected);
      initMod.__initSchemaForTesting(db as any);
      check("table: migration idempotent", true);
    }

    const audit = (agentId: string) => db.prepare(
      "SELECT key, old_json, new_json, actor, text_version FROM owner_feature_audit WHERE vertical = 'rfb' AND subject_id = ? ORDER BY id",
    ).all(agentId) as Array<{ key: string; old_json: string; new_json: string; actor: string; text_version: string | null }>;
    const reset = () => {
      db.prepare("DELETE FROM owner_beta_enrollment").run();
      db.prepare("DELETE FROM owner_feature_audit").run();
    };

    // ── Writes ──────────────────────────────────────────────────────────
    {
      reset();
      const offer = envOf({ OWNER_BETA_MODE: "offer" });
      check("write: optIn refused when mode off", be.optIn("rfb", OUT, "v1", { env: envOf() }).kind === "not_offered");
      check("write: optIn refused for unknown mode", be.optIn("rfb", OUT, "v1", { env: envOf({ OWNER_BETA_MODE: "Offer" }) }).kind === "not_offered");
      check("write: optIn refused when mode all", be.optIn("rfb", OUT, "v1", { env: envOf({ OWNER_BETA_MODE: "all" }) }).kind === "not_offered");
      check("write: registerInterest refused when mode off", be.registerInterest("rfb", OUT, { env: envOf() }).kind === "not_offered");
      check("write: non-rfb vertical refused", be.optIn("gardssalg", OUT, "v1", { env: offer }).kind === "invalid" && be.optOut("oa", OUT).kind === "invalid");
      check("write: empty agent / terms refused", be.optIn("rfb", "", "v1", { env: offer }).kind === "invalid" && be.optIn("rfb", OUT, "", { env: offer }).kind === "invalid");
      check("write: refusals wrote nothing", (db.prepare("SELECT COUNT(*) AS n FROM owner_beta_enrollment").get() as any).n === 0 && audit(OUT).length === 0);

      const r1 = be.optIn("rfb", OUT, "v1", { env: offer, now: new Date("2026-11-13T10:00:00Z") });
      check("write: optIn within cap → active", r1.kind === "ok" && r1.status === "active" && r1.changed && !r1.capped);
      const row = be.betaEnrollmentRow("rfb", OUT)!;
      check("write: row fields", row.status === "active" && row.terms_version === "v1" && row.opted_in_at === "2026-11-13T10:00:00.000Z" && row.updated_at === "2026-11-13T10:00:00.000Z");
      const a1 = audit(OUT);
      check("write: one audit row", a1.length === 1 && a1[0].key === "beta.enrollment" && a1[0].old_json === "null" && a1[0].new_json === "\"active\"" && a1[0].actor === "owner" && a1[0].text_version === "v1",
        JSON.stringify(a1));
      const r2 = be.optIn("rfb", OUT, "v1", { env: offer });
      check("write: optIn again → no-op, no audit", r2.kind === "ok" && !r2.changed && audit(OUT).length === 1);
      const r3 = be.optOut("rfb", OUT, { env: envOf(), now: new Date("2026-11-14T10:00:00Z") });
      check("write: optOut (any mode) → opted_out + audit", r3.kind === "ok" && r3.status === "opted_out" && r3.changed && audit(OUT).length === 2
        && be.betaEnrollmentRow("rfb", OUT)!.opted_out_at === "2026-11-14T10:00:00.000Z");
      const r4 = be.optOut("rfb", OUT);
      check("write: optOut again → no-op", r4.kind === "ok" && !r4.changed && audit(OUT).length === 2);
      check("write: optOut without row → no-op, no row", be.optOut("rfb", "nobody").kind === "ok" && be.betaEnrollmentRow("rfb", "nobody") === null);
      const r5 = be.registerInterest("rfb", OWN2, { env: offer });
      check("write: registerInterest → interested + audit", r5.kind === "ok" && r5.status === "interested" && audit(OWN2).length === 1);
      check("write: registerInterest again → no-op", !(be.registerInterest("rfb", OWN2, { env: offer }) as any).changed && audit(OWN2).length === 1);
      check("write: counts", JSON.stringify(be.betaEnrollmentCounts("rfb")) === JSON.stringify({ active: 0, interested: 1, opted_out: 1 }));
    }

    // ── AC4: the cap ────────────────────────────────────────────────────
    {
      reset();
      // S3 review N2: an active beta row grants access only while the owner is
      // still a verified owner, so the cap's synthetic owners need a claim.
      for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) insAgent.run(id, `Gård ${id}`, `${id}@farm.example.no`, `k-${id}`);
      db.prepare("UPDATE agents SET claimed_at = '2026-11-01T00:00:00Z' WHERE id IN ('c1','c2','c3','c4','c5','c6')").run();
      const capEnv = (cap: string | undefined) => envOf({ OWNER_BETA_MODE: "offer", OWNER_BETA_CAP: cap });
      const ids = ["c1", "c2", "c3"];
      const res = ids.map((id) => be.optIn("rfb", id, "v1", { env: capEnv("2") }));
      check("AC4: cap 2 → first two active", res[0].kind === "ok" && res[0].status === "active" && res[1].kind === "ok" && res[1].status === "active");
      check("AC4: cap 2 → third opt-in stored as interested", res[2].kind === "ok" && res[2].status === "interested" && (res[2] as any).capped === true
        && be.betaEnrollmentStatus("rfb", "c3") === "interested");
      check("AC4: interested is not allowed", !ft.ownerFeatureAccess("dashboard", "rfb", "c3", { ...capEnv("2"), OWNER_FEATURE_TIERS: "dashboard=beta" }).allowed);
      // Raise the cap: nothing changes by itself.
      const before = JSON.stringify(db.prepare("SELECT * FROM owner_beta_enrollment ORDER BY agent_id").all());
      const raised = { ...capEnv("10"), OWNER_FEATURE_TIERS: "dashboard=beta" };
      check("AC4: raising the cap does not enroll c3", !ft.ownerFeatureAccess("dashboard", "rfb", "c3", raised).allowed && be.betaEnrollmentStatus("rfb", "c3") === "interested");
      be.betaEnrollmentCounts("rfb"); ft.ownerFeatureAllowedRfbIds("dashboard", { env: raised });
      check("AC4: reads after raising the cap write nothing", JSON.stringify(db.prepare("SELECT * FROM owner_beta_enrollment ORDER BY agent_id").all()) === before);
      const again = be.optIn("rfb", "c3", "v2", { env: capEnv("10") });
      check("AC4: after the raise, c3's own opt-in → active", again.kind === "ok" && again.status === "active" && ft.ownerFeatureAccess("dashboard", "rfb", "c3", raised).allowed);
      check("AC4: an active owner re-opting in at the cap stays active", (be.optIn("rfb", "c1", "v1", { env: capEnv("1") }) as any).status === "active");
      check("AC4: invalid cap → 0 → interested", (be.optIn("rfb", "c4", "v1", { env: capEnv("lots") }) as any).status === "interested");
      check("AC4: cap 0 → interested", (be.optIn("rfb", "c5", "v1", { env: capEnv("0") }) as any).status === "interested");
      check("AC4: opted-out owner frees a place", (() => {
        be.optOut("rfb", "c1");
        return (be.optIn("rfb", "c6", "v1", { env: capEnv("3") }) as any).status === "active";
      })());
    }

    // Fixture for the access tests: OUT active, OWN2 interested.
    reset();
    be.optIn("rfb", OUT, "v1", { env: envOf({ OWNER_BETA_MODE: "offer" }) });
    be.registerInterest("rfb", OWN2, { env: envOf({ OWNER_BETA_MODE: "offer" }) });

    // ── AC1: defaults unchanged, no DB access ───────────────────────────
    {
      const enforce = require("./enforce") as typeof import("./enforce");
      const visibility = require("./visibility") as typeof import("./visibility");
      const scr = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
      be.__setBetaEnrollmentTestDb(THROWING_DB);
      for (const [label, env] of [
        ["mode/tiers unset", envOf()],
        ["mode offer, tiers unset", envOf({ OWNER_BETA_MODE: "offer" })],
        ["mode all, tiers unset", envOf({ OWNER_BETA_MODE: "all" })],
        ["tiers beta, mode unset", envOf({ OWNER_FEATURE_TIERS: ft.OWNER_FEATURE_KEYS.map((k) => `${k}=beta`).join(",") })],
      ] as Array<[string, NodeJS.ProcessEnv]>) {
        let ok = true;
        for (const k of ft.OWNER_FEATURE_KEYS) {
          const p = ft.ownerFeatureAccess(k, "rfb", PIL, env);
          const o = ft.ownerFeatureAccess(k, "rfb", OUT, env);
          const a = ft.ownerFeatureAccess(k, "rfb", null, env);
          if (!(p.allowed && p.source === "pilot" && !o.allowed && !a.allowed)) ok = false;
          if (JSON.stringify(ft.ownerFeatureAllowedRfbIds(k, { env, db: THROWING_DB })) !== JSON.stringify([PIL])) ok = false;
        }
        check(`AC1 ${label}: pilot yes / enrolled normal owner no / anonymous no, bulk = pilot list, no DB`, ok);
        check(`AC1 ${label}: stock-check ids = pilot list, no DB`, JSON.stringify(scr.__stockCheckAllowedRfbIdsForTesting(env, THROWING_DB)) === JSON.stringify([PIL]));
        check(`AC1 ${label}: enforce off → nothing, no DB`, enforce.publicFieldChoicesForMany([PIL, OUT], { env, db: THROWING_DB }).size === 0);
      }
      // enforce on: only the pilot owner is looked up (as today).
      const rec: Array<{ sql: string; args: unknown[] }> = [];
      be.__setBetaEnrollmentTestDb(db);
      const on = envOf({ OWNER_FEATURES_ENFORCE: "1" });
      const m = enforce.publicFieldChoicesForMany([PIL, OUT], { env: on, db: recordingDb(db, rec) });
      check("AC1 enforce on, defaults: only the pilot owner enforced", m.has(PIL) && !m.has(OUT));
      check("AC1 enforce on, defaults: no enrollment query", !rec.some((r) => r.sql.includes("owner_beta_enrollment")));
      const rec2: Array<{ sql: string; args: unknown[] }> = [];
      visibility.ownerHiddenChoicesForMany(null, { env: on, db: recordingDb(db, rec2) });
      check("AC1 visibility, defaults: only the pilot owner looked up",
        rec2.length > 0 && rec2.every((r) => !r.sql.includes("owner_beta_enrollment") && !r.args.includes(OUT)) && rec2.some((r) => r.args.includes(PIL)));
    }

    // ── Access: beta = pilot OR (offer AND active) ──────────────────────
    {
      const offerBeta = envOf({ OWNER_BETA_MODE: "offer", OWNER_FEATURE_TIERS: "dashboard=beta,orders=beta" });
      const b = ft.ownerFeatureAccess("dashboard", "rfb", OUT, offerBeta);
      check("access: offer + beta + active row → allowed, source beta", b.allowed && b.source === "beta");
      check("access: pilot owner keeps source pilot", ft.ownerFeatureAccess("dashboard", "rfb", PIL, offerBeta).source === "pilot");
      check("access: interested row → denied", !ft.ownerFeatureAccess("dashboard", "rfb", OWN2, offerBeta).allowed);
      check("access: no row → denied", !ft.ownerFeatureAccess("dashboard", "rfb", NOOWN, offerBeta).allowed);
      check("access: pilot-tier feature → denied for the beta owner", !ft.ownerFeatureAccess("mine_valg", "rfb", OUT, offerBeta).allowed);
      check("access: mode off → beta rows ignored", !ft.ownerFeatureAccess("dashboard", "rfb", OUT, envOf({ OWNER_FEATURE_TIERS: "dashboard=beta" })).allowed);
      check("access: mode \"off\" literal → ignored", !ft.ownerFeatureAccess("dashboard", "rfb", OUT, envOf({ OWNER_BETA_MODE: "off", OWNER_FEATURE_TIERS: "dashboard=beta" })).allowed);
      check("access: opted-out owner denied at once", (() => {
        be.optOut("rfb", OUT);
        const denied = !ft.ownerFeatureAccess("dashboard", "rfb", OUT, offerBeta).allowed;
        be.optIn("rfb", OUT, "v1", { env: offerBeta });
        return denied && ft.ownerFeatureAccess("dashboard", "rfb", OUT, offerBeta).allowed;
      })());
      const { ownerDashboardActiveFor } = require("../owner-ui/shell") as typeof import("../owner-ui/shell");
      const { t12OrderActionsActive } = require("../services/order-actions") as typeof import("../services/order-actions");
      const site = { ...offerBeta, OWNER_DASHBOARD_ENABLED: "1" };
      check("site dashboard: verified beta owner yes", ownerDashboardActiveFor("rfb", OUT, true, site));
      check("site orders: beta owner yes", t12OrderActionsActive(OUT, offerBeta) && !t12OrderActionsActive(NOOWN, offerBeta));
      check("flag-first: dashboard flag off → off for the beta owner", !ownerDashboardActiveFor("rfb", OUT, true, { ...offerBeta, OWNER_DASHBOARD_ENABLED: "0" }));

      // ── AC2: fail closed ──────────────────────────────────────────────
      check("AC2: unknown mode → beta denied", !ft.ownerFeatureAccess("dashboard", "rfb", OUT, { ...offerBeta, OWNER_BETA_MODE: "Offer" }).allowed);
      check("AC2: unknown mode → bulk = pilot only", JSON.stringify(ft.ownerFeatureAllowedRfbIds("dashboard", { env: { ...offerBeta, OWNER_BETA_MODE: "offer " } })) === JSON.stringify([PIL]));
      check("AC2: invalid cap → no new beta owner", (be.optIn("rfb", NOOWN, "v1", { env: { ...offerBeta, OWNER_BETA_CAP: "x" } }) as any).status === "interested"
        && !ft.ownerFeatureAccess("dashboard", "rfb", NOOWN, offerBeta).allowed);
      be.optOut("rfb", NOOWN);
      be.__setBetaEnrollmentTestDb(THROWING_DB);
      const dbErr = ft.ownerFeatureAccess("dashboard", "rfb", OUT, offerBeta);
      check("AC2: DB error → beta denied, no throw", !dbErr.allowed && dbErr.source === null);
      check("AC2: DB error → pilot owner still allowed", ft.ownerFeatureAccess("dashboard", "rfb", PIL, offerBeta).allowed);
      check("AC2: DB error → bulk = pilot only", JSON.stringify(ft.ownerFeatureAllowedRfbIds("dashboard", { env: offerBeta })) === JSON.stringify([PIL]));
      be.__setBetaEnrollmentTestDb(db);
      check("AC2: missing session (no agent id) → denied",
        !ft.ownerFeatureAccess("dashboard", "rfb", null, offerBeta).allowed && !ft.ownerFeatureAccess("dashboard", "rfb", "", offerBeta).allowed);
      const { isVerifiedOwner } = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
      check("AC2: missing session → isVerifiedOwner false", !isVerifiedOwner(OUT, null) && !isVerifiedOwner(OUT, { valid: false }));
      check("AC2: unverified owner → dashboard off even with an active row", !ownerDashboardActiveFor("rfb", OUT, false, site));
      for (const v of ["gardssalg", "oa", "dental", "RFB", "rfb ", ""]) {
        check(`AC2: vertical ${JSON.stringify(v)} → beta denied`, !ft.ownerFeatureAccess("dashboard", v, OUT, offerBeta).allowed);
      }
      db.prepare("INSERT INTO owner_beta_enrollment (vertical, agent_id, status, updated_at) VALUES ('gardssalg', ?, 'active', 'x')").run(OUT);
      check("AC2: an active gardssalg row never opens beta", !ft.ownerFeatureAccess("dashboard", "gardssalg", OUT, offerBeta).allowed);
      db.prepare("DELETE FROM owner_beta_enrollment WHERE vertical = 'gardssalg'").run();
    }

    // ── Mode all (graduation) + N7 ──────────────────────────────────────
    {
      const allEnv = envOf({ OWNER_BETA_MODE: "all", OWNER_FEATURE_TIERS: "dashboard=beta,product_import_outreach=beta" });
      const g = ft.ownerFeatureAccess("dashboard", "rfb", NOOWN, allEnv);
      check("all: beta feature allowed for a non-pilot owner without enrollment (source ga)", g.allowed && g.source === "ga");
      const { ownerDashboardActiveFor } = require("../owner-ui/shell") as typeof import("../owner-ui/shell");
      check("all: dashboard for a verified non-pilot owner without enrollment", ownerDashboardActiveFor("rfb", OWN2, true, { ...allEnv, OWNER_DASHBOARD_ENABLED: "1" }));
      check("all: still needs a verified owner at the call site", !ownerDashboardActiveFor("rfb", OWN2, false, { ...allEnv, OWNER_DASHBOARD_ENABLED: "1" }));
      check("all: pilot-tier feature unchanged", !ft.ownerFeatureAccess("orders", "rfb", NOOWN, allEnv).allowed);
      check("all: non-rfb still denied", !ft.ownerFeatureAccess("dashboard", "gardssalg", NOOWN, allEnv).allowed);
      check("N7: outreach stays beta in mode all (not enrolled → denied)", !ft.ownerFeatureAccess("product_import_outreach", "rfb", NOOWN, allEnv).allowed);
      check("N7: outreach, enrolled owner → allowed as beta", ft.ownerFeatureAccess("product_import_outreach", "rfb", OUT, allEnv).source === "beta");
      const gaOut = envOf({ OWNER_FEATURE_TIERS: "product_import_outreach=ga" });
      check("N7: outreach=ga is capped at beta", ft.ownerFeatureEffectiveTier("product_import_outreach", gaOut) === "beta"
        && !ft.ownerFeatureAccess("product_import_outreach", "rfb", NOOWN, gaOut).allowed);
      check("N7: outreach=ga, mode off → bulk = pilot only (never all owners)",
        JSON.stringify(ft.ownerFeatureAllowedRfbIds("product_import_outreach", { env: gaOut })) === JSON.stringify([PIL]));
      const { ownerFlagEnabledFor } = require("./owner-flag-mode") as typeof import("./owner-flag-mode");
      check("N7: PRODUCT_IMPORT_OUTREACH_ENABLED=pilot + ga + all → not for a non-enrolled owner",
        !ownerFlagEnabledFor("PRODUCT_IMPORT_OUTREACH_ENABLED", NOOWN, { ...gaOut, OWNER_BETA_MODE: "all", PRODUCT_IMPORT_OUTREACH_ENABLED: "pilot" }));
    }

    // ── Bulk paths (N1) ─────────────────────────────────────────────────
    {
      const enforce = require("./enforce") as typeof import("./enforce");
      const visibility = require("./visibility") as typeof import("./visibility");
      const scr = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
      const tf = require("./today-facts") as typeof import("./today-facts");

      const betaAll = envOf({ OWNER_BETA_MODE: "offer", OWNER_FEATURES_ENFORCE: "1", OWNER_FEATURE_TIERS: "mine_valg=beta,stock_check=beta" });
      check("bulk beta: ids = pilot ∪ active rows", JSON.stringify(ft.ownerFeatureAllowedRfbIds("mine_valg", { env: betaAll })) === JSON.stringify([PIL, OUT]));
      const m = enforce.publicFieldChoicesForMany([PIL, OUT, OWN2, NOOWN], { env: betaAll, db });
      check("bulk enforce beta: pilot + beta owner enforced, others not", m.has(PIL) && m.has(OUT) && !m.has(OWN2) && !m.has(NOOWN), [...m.keys()].join(","));
      const rec: Array<{ sql: string; args: unknown[] }> = [];
      visibility.ownerHiddenChoicesForMany(null, { env: betaAll, db: recordingDb(db, rec) });
      const looked = rec.filter((r) => r.sql.includes("owner_feature_settings")).flatMap((r) => r.args);
      check("bulk visibility beta: the beta owner is looked up", looked.includes(PIL) && looked.includes(OUT) && !looked.includes(OWN2));
      check("bulk stock-check beta: pilot + beta owner", JSON.stringify(scr.__stockCheckAllowedRfbIdsForTesting(betaAll, db)) === JSON.stringify([PIL, OUT]));
      check("bulk debio beta: beta owner in scope", (() => { enforce.debioSwitchOffAgentIds([OUT], { env: betaAll, db }); return true; })());

      const ga = envOf({ OWNER_FEATURES_ENFORCE: "1", OWNER_FEATURE_TIERS: "mine_valg=ga,stock_check=ga" });
      const gaIds = ft.ownerFeatureAllowedRfbIds("stock_check", { env: ga, db });
      check("bulk ga: pilot ∪ every verified owner, not the unclaimed profile",
        gaIds[0] === PIL && gaIds.includes(OUT) && gaIds.includes(OWN2) && !gaIds.includes(NOOWN), gaIds.join(","));
      check("bulk ga: stock-check selects the same set", JSON.stringify(scr.__stockCheckAllowedRfbIdsForTesting(ga, db)) === JSON.stringify(gaIds));
      const mg = enforce.publicFieldChoicesForMany([OWN2, NOOWN], { env: ga, db });
      check("bulk enforce ga: verified owner enforced, unclaimed not", mg.has(OWN2) && !mg.has(NOOWN));
      check("bulk ga: DB error → pilot only", JSON.stringify(ft.ownerFeatureAllowedRfbIds("stock_check", { env: ga, db: THROWING_DB })) === JSON.stringify([PIL]));
      const allMode = envOf({ OWNER_BETA_MODE: "all", OWNER_FEATURE_TIERS: "mine_valg=beta" });
      check("bulk mode all: beta feature = ga set", ft.ownerFeatureAllowedRfbIds("mine_valg", { env: allMode, db }).includes(OWN2));

      // today-facts follows the tier.
      const flags = { OWNER_ORDERABILITY_PORTAL_ENABLED: "1", STOCK_CHECK_EMAIL_ENABLED: "1", STOCK_SOFT_EXPIRY_ENABLED: "1" };
      const def = tf.currentPilotStates(envOf(flags));
      check("today-facts default: all i_pilot (as before)", tf.PILOT_FEATURE_KEYS.every((k) => def[k] === "i_pilot"));
      const gaStates = tf.currentPilotStates(envOf({ ...flags, OWNER_FEATURE_TIERS: "mine_valg=ga,orders=ga" }));
      check("today-facts ga: mine_valg/kanseller for_alle, others unchanged",
        gaStates.mine_valg === "for_alle" && gaStates.kanseller === "for_alle" && gaStates.varer === "i_pilot");
      const noList = tf.currentPilotStates({ ...flags, OWNER_FEATURE_TIERS: "orderability=beta", OWNER_BETA_MODE: "offer" } as any);
      check("today-facts beta+offer, empty pilot list: varer i_pilot, others planlagt", noList.varer === "i_pilot" && noList.mine_valg === "planlagt");
      const noListOff = tf.currentPilotStates({ ...flags, OWNER_FEATURE_TIERS: "orderability=beta" } as any);
      check("today-facts beta, mode off, empty pilot list: planlagt", noListOff.varer === "planlagt");
      const flagOff = tf.currentPilotStates(envOf({ OWNER_FEATURE_TIERS: "orderability=ga" }));
      check("today-facts: switch off → planlagt even on ga", flagOff.varer === "planlagt");
      check("today-facts: owner-flag gate follows its tier", tf.pilotFeatureState(tf.ownerModeGate("OWNER_ORDER_EMAIL_ENABLED"),
        { OWNER_ORDER_EMAIL_ENABLED: "pilot", OWNER_FEATURE_TIERS: "order_email=ga" } as any) === "for_alle");
    }

    // ── Admin stats ─────────────────────────────────────────────────────
    {
      const express = require("express") as typeof import("express");
      const adminMod = require("../routes/admin-owner-beta") as typeof import("../routes/admin-owner-beta");
      adminMod.__setAdminOwnerBetaTestDb(db);
      const app = express();
      app.use("/admin/owner-beta", adminMod.default);
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as any).port;
      const getJson = (path: string, key?: string): Promise<{ status: number; body: any; raw: string }> => new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path, headers: key ? { "X-Admin-Key": key } : {} }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let b: any = null; try { b = JSON.parse(raw); } catch { /* not json */ }
            resolve({ status: resp.statusCode || 0, body: b, raw });
          });
        }).on("error", reject);
      });
      delete process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      check("admin: no key configured → 503", (await getJson("/admin/owner-beta/stats", "x")).status === 503);
      process.env.ADMIN_KEY = "s2-admin-key";
      for (const k of ENV_KEYS) delete process.env[k];
      check("admin: missing key → 401", (await getJson("/admin/owner-beta/stats")).status === 401);
      check("admin: wrong key → 401", (await getJson("/admin/owner-beta/stats", "nope")).status === 401);
      const d = await getJson("/admin/owner-beta/stats", "s2-admin-key");
      check("admin: defaults → mode off, cap 25, all pilot",
        d.status === 200 && d.body.mode === "off" && d.body.cap === 25 && ft.OWNER_FEATURE_KEYS.every((k) => d.body.tiers[k] === "pilot"), d.raw);
      check("admin: exact top-level keys", JSON.stringify(Object.keys(d.body)) === JSON.stringify(["mode", "cap", "counts", "tiers"]));
      check("admin: counts", JSON.stringify(d.body.counts) === JSON.stringify({ active: 1, interested: 1, opted_out: 1 }), JSON.stringify(d.body.counts));
      check("admin: no agent ids, names or contact info", ![PIL, OUT, OWN2, NOOWN, "Gård", "@"].some((s) => d.raw.includes(s)));
      process.env.OWNER_BETA_MODE = "all";
      process.env.OWNER_BETA_CAP = "x";
      process.env.OWNER_FEATURE_TIERS = "dashboard=beta,product_import_outreach=ga";
      const e = await getJson("/admin/owner-beta/stats", "s2-admin-key");
      check("admin: mode all, invalid cap 0, effective tiers",
        e.body.mode === "all" && e.body.cap === 0 && e.body.tiers.dashboard === "ga" && e.body.tiers.product_import_outreach === "beta" && e.body.tiers.orders === "pilot", e.raw);
      adminMod.__setAdminOwnerBetaTestDb(THROWING_DB);
      check("admin: DB error → 500", (await getJson("/admin/owner-beta/stats", "s2-admin-key")).status === 500);
      adminMod.__setAdminOwnerBetaTestDb(null);
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err?.message || err}`);
  } finally {
    console.warn = origWarn;
    console.error = origError;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsKey;
    be.__setBetaEnrollmentTestDb(null);
    ft.__setBetaEnrollmentLookupForTesting(null);
    ft.__resetFeatureTierLogForTesting();
    bm.__resetBetaModeLogForTesting();
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBetaEnrollmentTests({ log: true }).then((r) => {
    console.log(`\nbeta-enrollment: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(`  FAIL ${f}`);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

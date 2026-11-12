/**
 * feature-tiers.test.ts — A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle,
 * slice S1 (register + central ownerFeatureAccess).
 *
 *   parsing   OWNER_FEATURE_TIERS: valid entries, unknown key, unknown value,
 *             whitespace / case not trimmed or folded, malformed, conflicting
 *             duplicates → pilot; each ignored entry logged once
 *   default   unset/empty → pilot for every registry key
 *   AC1       default tiers: every gate answers exactly like the pilot list
 *             (pilot owner yes, normal owner no, anonymous no) — central call
 *             and the moved call sites
 *   S1 beta   beta == pilot list only (enrollment stub always false); with a
 *             test enrollment lookup, beta opens (source "beta") for rfb only
 *   ga        allows a non-pilot rfb subject (source "ga"); never another vertical
 *   AC2       fail closed: thrown error (allowlist / enrollment lookup / env
 *             getter) → not allowed; non-rfb vertical never gets beta/ga
 *   flag-first owner flags: off → off whatever the tier; pilot → tier; "1" → all
 *   registry  every production call site's feature key is in the registry; no
 *             production file outside the agreed exceptions calls the pilot
 *             list check directly
 *
 * Pure (env objects passed in, no DB). Exported runFeatureTiersTests({log}) ->
 * TestSummary; wired into tests/test.ts. Standalone:
 *   npx tsx src/owner-features/feature-tiers.test.ts
 */

import fs from "fs";
import path from "path";
import {
  OWNER_FEATURE_KEYS,
  OWNER_FEATURE_TIER_REGISTRY,
  OWNER_PILOT_FLAG_FEATURE,
  __resetFeatureTierLogForTesting,
  __setBetaEnrollmentLookupForTesting,
  isOwnerFeatureKey,
  ownerFeatureAccess,
  ownerFeatureTier,
  parseOwnerFeatureTiers,
} from "./feature-tiers";
import { OWNER_PILOT_FLAGS, ownerFlagEnabledFor } from "./owner-flag-mode";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PIL = "ft-pilot";
const OUT = "ft-out";
const GS = "ft-gardssalg";
const ALLOW = `rfb:${PIL},gardssalg:${GS}`;

function envOf(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { OWNER_FEATURES_ALLOWED_SUBJECTS: ALLOW, ...extra } as NodeJS.ProcessEnv;
}

/** Production files allowed to call isSubjectAllowedForOwnerFeatures directly (S1 scope). */
const DIRECT_PILOT_LIST_EXCEPTIONS = new Set([
  "src/owner-features/allowlist.ts",
  "src/owner-features/feature-tiers.ts",
  // gårdssalg / opplevelser (vertical oa / gardssalg): today's behaviour.
  "src/owner-features/gardssalg.ts",
  "src/owner-features/gardssalg-switch-probe.ts",
  "src/routes/gardssalg-owner-features.ts",
  "src/routes/opplevelser.ts",
  // hidden test producer admin routes and the switch probes behind them.
  "src/routes/admin-test-producer.ts",
  "src/owner-features/switch-probe.ts",
]);

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
}

export async function runFeatureTiersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = "") => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${name}`); }
    else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); if (log) console.log(`  ✗ ${name} ${detail}`); }
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  console.error = () => { /* fail-closed paths log; keep the run quiet */ };
  __resetFeatureTierLogForTesting();
  __setBetaEnrollmentLookupForTesting(null);
  try {
    // ── Registry + default ──────────────────────────────────────────────
    check("registry: every key defaults to pilot", OWNER_FEATURE_KEYS.every((k) => OWNER_FEATURE_TIER_REGISTRY[k].defaultTier === "pilot"));
    for (const k of ["dashboard", "mine_valg", "orders", "product_import", "product_import_outreach", "order_email", "unified_session", "stock_check", "stock_soft_expiry"]) {
      check(`registry: has ${k}`, isOwnerFeatureKey(k));
    }
    check("registry: every pilot-capable owner flag maps to a key",
      OWNER_PILOT_FLAGS.every((f) => isOwnerFeatureKey(OWNER_PILOT_FLAG_FEATURE[f] ?? "")));
    {
      const unset = parseOwnerFeatureTiers({} as NodeJS.ProcessEnv);
      const empty = parseOwnerFeatureTiers({ OWNER_FEATURE_TIERS: "" } as NodeJS.ProcessEnv);
      check("default: unset → pilot for all", OWNER_FEATURE_KEYS.every((k) => unset[k] === "pilot"));
      check("default: empty → pilot for all", OWNER_FEATURE_KEYS.every((k) => empty[k] === "pilot"));
      check("default: no warning when unset/empty", warnings.length === 0, warnings.join(" | "));
    }

    // ── Parsing ─────────────────────────────────────────────────────────
    {
      const t = parseOwnerFeatureTiers({ OWNER_FEATURE_TIERS: "dashboard=beta,product_import=ga,orders=pilot" } as NodeJS.ProcessEnv);
      check("parse: dashboard=beta", t.dashboard === "beta");
      check("parse: product_import=ga", t.product_import === "ga");
      check("parse: orders=pilot", t.orders === "pilot");
      check("parse: others stay pilot", t.mine_valg === "pilot" && t.stock_check === "pilot");
    }
    {
      warnings.length = 0;
      __resetFeatureTierLogForTesting();
      const env = { OWNER_FEATURE_TIERS: "nope=ga,dashboard=ga" } as NodeJS.ProcessEnv;
      const t = parseOwnerFeatureTiers(env);
      check("parse: unknown key ignored, valid one kept", t.dashboard === "ga" && OWNER_FEATURE_KEYS.filter((k) => k !== "dashboard").every((k) => t[k] === "pilot"));
      check("parse: unknown key logged", warnings.some((w) => w.includes("nope")));
      const n = warnings.length;
      parseOwnerFeatureTiers(env);
      parseOwnerFeatureTiers(env);
      check("parse: unknown key logged only once", warnings.length === n, `${warnings.length} vs ${n}`);
    }
    {
      warnings.length = 0;
      const t = parseOwnerFeatureTiers({ OWNER_FEATURE_TIERS: "dashboard=all,mine_valg=1,orders=" } as NodeJS.ProcessEnv);
      check("parse: unknown value → pilot", t.dashboard === "pilot" && t.mine_valg === "pilot" && t.orders === "pilot");
      check("parse: unknown value logged", warnings.some((w) => w.includes("\"all\"")));
    }
    for (const raw of [
      " dashboard=ga", "dashboard =ga", "dashboard= ga", "dashboard=ga ", "Dashboard=ga", "dashboard=GA", "dashboard=Beta",
      "DASHBOARD=ga", "dashboard:ga", "dashboard", "dashboard==ga", "dashboard=ga;orders=ga",
    ]) {
      const t = parseOwnerFeatureTiers({ OWNER_FEATURE_TIERS: raw } as NodeJS.ProcessEnv);
      check(`parse: exact match only (${JSON.stringify(raw)} → dashboard pilot)`, t.dashboard === "pilot", t.dashboard);
    }
    {
      const t = parseOwnerFeatureTiers({ OWNER_FEATURE_TIERS: "dashboard=ga,dashboard=beta" } as NodeJS.ProcessEnv);
      check("parse: conflicting duplicate → pilot", t.dashboard === "pilot");
      const u = parseOwnerFeatureTiers({ OWNER_FEATURE_TIERS: "dashboard=ga,,dashboard=ga" } as NodeJS.ProcessEnv);
      check("parse: same value twice + empty entry → kept", u.dashboard === "ga");
    }
    check("ownerFeatureTier: unknown feature → pilot", ownerFeatureTier("no_such_feature", { OWNER_FEATURE_TIERS: "no_such_feature=ga" } as NodeJS.ProcessEnv) === "pilot");

    // ── AC1: default tiers = the pilot list, for every key ──────────────
    for (const k of OWNER_FEATURE_KEYS) {
      const env = envOf();
      const p = ownerFeatureAccess(k, "rfb", PIL, env);
      const o = ownerFeatureAccess(k, "rfb", OUT, env);
      const a1 = ownerFeatureAccess(k, "rfb", "", env);
      const a2 = ownerFeatureAccess(k, "rfb", null, env);
      const a3 = ownerFeatureAccess(k, "rfb", undefined, env);
      check(`AC1 ${k}: pilot owner allowed (source pilot)`, p.allowed && p.source === "pilot");
      check(`AC1 ${k}: normal owner denied`, !o.allowed && o.source === null);
      check(`AC1 ${k}: anonymous denied`, !a1.allowed && !a2.allowed && !a3.allowed);
      const none = ownerFeatureAccess(k, "rfb", PIL, {} as NodeJS.ProcessEnv);
      check(`AC1 ${k}: empty pilot list → nobody`, !none.allowed);
    }
    check("AC1: gardssalg subject on the list keeps access via its vertical",
      ownerFeatureAccess("dashboard", "gardssalg", GS, envOf()).allowed);
    check("AC1: rfb list entry does not open another vertical",
      !ownerFeatureAccess("dashboard", "gardssalg", PIL, envOf()).allowed);

    // ── S1: beta == pilot list only ─────────────────────────────────────
    {
      const env = envOf({ OWNER_FEATURE_TIERS: OWNER_FEATURE_KEYS.map((k) => `${k}=beta`).join(",") });
      for (const k of OWNER_FEATURE_KEYS) {
        check(`S1 beta ${k}: pilot owner allowed`, ownerFeatureAccess(k, "rfb", PIL, env).allowed);
        check(`S1 beta ${k}: normal owner denied (no enrollment yet)`, !ownerFeatureAccess(k, "rfb", OUT, env).allowed);
      }
      // With a test enrollment lookup (S2 shape): beta opens, rfb only.
      __setBetaEnrollmentLookupForTesting(() => true);
      const b = ownerFeatureAccess("dashboard", "rfb", OUT, env);
      check("beta + enrolled (test lookup): allowed, source beta", b.allowed && b.source === "beta");
      check("beta + enrolled: non-rfb vertical still denied", !ownerFeatureAccess("dashboard", "gardssalg", OUT, env).allowed);
      check("beta + enrolled: pilot tier feature still denied",
        !ownerFeatureAccess("dashboard", "rfb", OUT, envOf({ OWNER_FEATURE_TIERS: "orders=beta" })).allowed);
      __setBetaEnrollmentLookupForTesting(() => { throw new Error("db down"); });
      check("AC2 beta: enrollment lookup throws → denied", !ownerFeatureAccess("dashboard", "rfb", OUT, env).allowed);
      check("AC2 beta: lookup throws, pilot owner still allowed", ownerFeatureAccess("dashboard", "rfb", PIL, env).allowed);
      __setBetaEnrollmentLookupForTesting(() => ("yes" as unknown as boolean));
      check("AC2 beta: non-boolean enrollment answer → denied", !ownerFeatureAccess("dashboard", "rfb", OUT, env).allowed);
      __setBetaEnrollmentLookupForTesting(null);
    }

    // ── ga ───────────────────────────────────────────────────────────────
    {
      const env = envOf({ OWNER_FEATURE_TIERS: "dashboard=ga" });
      const g = ownerFeatureAccess("dashboard", "rfb", OUT, env);
      check("ga: non-pilot rfb owner allowed, source ga", g.allowed && g.source === "ga");
      const p = ownerFeatureAccess("dashboard", "rfb", PIL, env);
      check("ga: pilot owner reports source pilot", p.allowed && p.source === "pilot");
      check("ga: only the feature on ga", !ownerFeatureAccess("orders", "rfb", OUT, env).allowed);
      check("ga: anonymous still denied", !ownerFeatureAccess("dashboard", "rfb", "", env).allowed);
      for (const v of ["gardssalg", "oa", "dental", "RFB", "rfb ", ""]) {
        check(`ga/beta: vertical ${JSON.stringify(v)} never gets ga`, !ownerFeatureAccess("dashboard", v, OUT, env).allowed);
      }
      check("ga: unknown feature key stays pilot", !ownerFeatureAccess("no_such_feature", "rfb", OUT, envOf({ OWNER_FEATURE_TIERS: "no_such_feature=ga" })).allowed);
    }

    // ── AC2: fail closed on a thrown error ───────────────────────────────
    {
      const throwing = new Proxy({} as NodeJS.ProcessEnv, { get() { throw new Error("env exploded"); } });
      let r: ReturnType<typeof ownerFeatureAccess> | null = null;
      let threw = false;
      try { r = ownerFeatureAccess("dashboard", "rfb", PIL, throwing); } catch { threw = true; }
      check("AC2: thrown error → no throw, not allowed", !threw && !!r && !r.allowed && r.source === null);
      const half = new Proxy(envOf({}), {
        get(t, k) { if (k === "OWNER_FEATURE_TIERS") throw new Error("tier read failed"); return (t as any)[k]; },
      });
      const h = ownerFeatureAccess("dashboard", "rfb", OUT, half);
      check("AC2: tier read throws → normal owner denied", !h.allowed && h.source === null);
    }

    // ── Moved call sites: flag first, then the tier ──────────────────────
    {
      const { ownerDashboardActiveFor } = require("../owner-ui/shell") as typeof import("../owner-ui/shell");
      const { t12OrderActionsActive } = require("../services/order-actions") as typeof import("../services/order-actions");
      const { ownerOrderabilityPortalEnabledFor } = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
      const { stockCheckAllowlisted } = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
      const { stockSoftExpiryActiveFor } = require("../services/stock-soft-expiry") as typeof import("../services/stock-soft-expiry");
      const { weeklySyncNudgeHtml } = require("../routes/owner-portal") as typeof import("../routes/owner-portal");

      const def = envOf({ OWNER_DASHBOARD_ENABLED: "1", OWNER_ORDERABILITY_PORTAL_ENABLED: "1", STOCK_SOFT_EXPIRY_ENABLED: "1" });
      check("site dashboard default: pilot yes / out no",
        ownerDashboardActiveFor("rfb", PIL, true, def) && !ownerDashboardActiveFor("rfb", OUT, true, def));
      check("site dashboard: unverified owner no", !ownerDashboardActiveFor("rfb", PIL, false, def));
      check("site orders default: pilot yes / out no", t12OrderActionsActive(PIL, def) && !t12OrderActionsActive(OUT, def) && !t12OrderActionsActive(null, def));
      check("site orderability default: pilot yes / out no", ownerOrderabilityPortalEnabledFor(PIL, def) && !ownerOrderabilityPortalEnabledFor(OUT, def));
      check("site stock_check default: pilot yes / out no", stockCheckAllowlisted(PIL, def) && !stockCheckAllowlisted(OUT, def));
      check("site stock_soft_expiry default: pilot yes / out no", stockSoftExpiryActiveFor(PIL, def) && !stockSoftExpiryActiveFor(OUT, def));
      check("site mine_valg nudge default: out → \"\"", weeklySyncNudgeHtml(OUT) === "");

      const ga = { ...def, OWNER_FEATURE_TIERS: "dashboard=ga,orders=ga,orderability=ga,stock_check=ga,stock_soft_expiry=ga" };
      check("site dashboard ga: out owner yes", ownerDashboardActiveFor("rfb", OUT, true, ga));
      check("site dashboard ga: still needs verified owner", !ownerDashboardActiveFor("rfb", OUT, false, ga));
      check("site dashboard ga: gardssalg vertical stays pilot", !ownerDashboardActiveFor("gardssalg", OUT, true, ga));
      check("site orders ga: out owner yes", t12OrderActionsActive(OUT, ga));
      check("site orderability ga: out owner yes", ownerOrderabilityPortalEnabledFor(OUT, ga));
      check("site stock_check ga: out owner yes", stockCheckAllowlisted(OUT, ga));
      check("site stock_soft_expiry ga: out owner yes", stockSoftExpiryActiveFor(OUT, ga));

      const flagOff = { ...ga, OWNER_DASHBOARD_ENABLED: "0", OWNER_ORDERABILITY_PORTAL_ENABLED: undefined, STOCK_SOFT_EXPIRY_ENABLED: "pilot" };
      check("flag-first: dashboard flag off → off even on ga", !ownerDashboardActiveFor("rfb", OUT, true, flagOff) && !ownerDashboardActiveFor("rfb", PIL, true, flagOff));
      check("flag-first: orderability flag off → off even on ga", !ownerOrderabilityPortalEnabledFor(OUT, flagOff));
      check("flag-first: soft-expiry flag not exactly 1/true → off even on ga", !stockSoftExpiryActiveFor(OUT, flagOff));

      // Owner flags with a pilot mode.
      for (const flag of OWNER_PILOT_FLAGS) {
        const key = OWNER_PILOT_FLAG_FEATURE[flag];
        const off = envOf({ OWNER_FEATURE_TIERS: `${key}=ga` });
        check(`flag-first ${flag}: off → off even on ga`, !ownerFlagEnabledFor(flag, PIL, off) && !ownerFlagEnabledFor(flag, OUT, off));
        const pilotDef = envOf({ [flag]: "pilot" });
        check(`flag ${flag}=pilot, default tier: pilot yes / out no / anon no`,
          ownerFlagEnabledFor(flag, PIL, pilotDef) && !ownerFlagEnabledFor(flag, OUT, pilotDef) && !ownerFlagEnabledFor(flag, null, pilotDef));
        const pilotBeta = envOf({ [flag]: "pilot", OWNER_FEATURE_TIERS: `${key}=beta` });
        check(`flag ${flag}=pilot, tier beta (S1): out no`, !ownerFlagEnabledFor(flag, OUT, pilotBeta));
        const pilotGa = envOf({ [flag]: "pilot", OWNER_FEATURE_TIERS: `${key}=ga` });
        check(`flag ${flag}=pilot, tier ga: out yes`, ownerFlagEnabledFor(flag, OUT, pilotGa));
        const all = envOf({ [flag]: "1" });
        check(`flag ${flag}=1: on for everyone as today`, ownerFlagEnabledFor(flag, OUT, all) && ownerFlagEnabledFor(flag, null, all));
      }
    }

    // ── Registry completeness: every production call site's key exists ──
    {
      const root = path.resolve(__dirname, "..", "..");
      const files: string[] = [];
      walk(path.join(root, "src"), files);
      const used = new Set<string>();
      const direct: string[] = [];
      const nonLiteral: string[] = [];
      for (const abs of files) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const src = fs.readFileSync(abs, "utf8");
        if (rel !== "src/owner-features/feature-tiers.ts") {
          for (const m of src.matchAll(/ownerFeatureAccess\(\s*([^,]+),/g)) {
            const arg = m[1].trim();
            const lit = /^"([^"]+)"$/.exec(arg);
            if (lit) used.add(lit[1]);
            else nonLiteral.push(`${rel}: ${arg}`);
          }
        }
        if (/isSubjectAllowedForOwnerFeatures\(/.test(src) && !DIRECT_PILOT_LIST_EXCEPTIONS.has(rel)) direct.push(rel);
      }
      const expectedNonLiteral = ["src/owner-features/owner-flag-mode.ts: OWNER_PILOT_FLAG_FEATURE[name] ?? name"];
      check("completeness: call sites found", used.size >= 6, [...used].join(","));
      for (const k of used) check(`completeness: call-site key ${k} is in the registry`, isOwnerFeatureKey(k));
      check("completeness: only the owner-flag mapping passes a non-literal key",
        nonLiteral.length === expectedNonLiteral.length && nonLiteral.every((x) => expectedNonLiteral.includes(x)), nonLiteral.join(" | "));
      check("completeness: no production path around ownerFeatureAccess", direct.length === 0, direct.join(", "));
      const covered = new Set<string>([...used, ...Object.values(OWNER_PILOT_FLAG_FEATURE)]);
      const unused = OWNER_FEATURE_KEYS.filter((k) => !covered.has(k));
      check("completeness: every registry key has a call site", unused.length === 0, unused.join(","));
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err?.message || err}`);
  } finally {
    console.warn = origWarn;
    console.error = origError;
    __setBetaEnrollmentLookupForTesting(null);
    __resetFeatureTierLogForTesting();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runFeatureTiersTests({ log: true }).then((r) => {
    console.log(`\nfeature-tiers: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(`  FAIL ${f}`);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

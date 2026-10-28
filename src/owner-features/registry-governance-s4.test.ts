/**
 * registry-governance-s4.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S4 «styringsregelen», the lokal CI part:
 *
 *   shape      every entry in OWNER_FEATURE_REGISTRY has NO+EN label and
 *              description text (and NO+EN option labels), a known group, a
 *              default for every segment (owner + unclaimed) and a valid
 *              status; registry keys == OWNER_FEATURE_KEYS, no duplicates.
 *   readers    every `live` entry has at least one real reader in src/
 *              (non-test files) — see READER DEFINITION below.
 *   lookups    no non-test source under src/ passes a string-literal key that
 *              is not in OWNER_FEATURE_KEYS to a key-taking lookup
 *              (featureOn, rfbFeatureOn, featureValue, resolveOwnerFeature,
 *              setOwnerFeatureValue, getOwnerFeature, findOwnerFeature).
 *   self-check the checkers run on a small synthetic registry + source fixture
 *              (missing EN label, live key without reader, unknown featureOn
 *              key) and must report each — proves the gate can fail.
 *
 * READER DEFINITION. Live entries today are read through storage adapters and
 * enforcement lists rather than a literal featureOn('<key>'), so a «reader» is
 * any of:
 *   (a) a key-taking lookup call (list above) with the key as a string literal
 *       in a non-test src file;
 *   (b) the key as a string literal anywhere in a non-test src file other than
 *       src/owner-features/registry.ts (enforcement lists such as
 *       ENFORCED_OWNER_FEATURE_KEYS / OWNER_VISIBILITY_KEYS, adapters writing
 *       owner_feature_settings, the page/changes code);
 *   (c) a storage adapter declared on the entry (`storage`) — the adapter's
 *       column stays the source of truth and is read by existing code.
 * Two structural cases count as read without a reader of their own, because
 * they have no independent value a reader could branch on:
 *   (d) type `locked` with `lockedWhen`: the value is derived entirely from
 *       the parent key, so the parent must itself have a direct reader (a–c);
 *   (e) type `guarantee`: a fixed promise (the resolver always returns the
 *       default, never an owner choice); it must default to ON for owners.
 * Every live entry that passes only via (d) or (e) is printed in the log so
 * the exemption stays visible.
 *
 * Pure static check: no DB, no env, no globals. Exported
 * runRegistryGovernanceS4Tests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/owner-features/registry-governance-s4.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  OWNER_FEATURE_GROUPS,
  OWNER_FEATURE_KEYS,
  OWNER_FEATURE_REGISTRY,
  type OwnerFeatureEntry,
} from "./registry";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SRC_ROOT = path.resolve(__dirname, "..");
const REGISTRY_FILE = path.join(SRC_ROOT, "owner-features", "registry.ts");

const VALID_STATUSES = ["live", "beta", "coming_soon"] as const;
const SEGMENTS = ["owner", "unclaimed"] as const;

/** Key-taking lookups → index of the key argument. */
export const KEY_LOOKUPS: Record<string, number> = {
  featureOn: 2,
  featureValue: 2,
  resolveOwnerFeature: 2,
  setOwnerFeatureValue: 2,
  rfbFeatureOn: 1,
  getOwnerFeature: 0,
  findOwnerFeature: 0,
};

export interface LookupCall {
  file: string;
  line: number;
  fn: string;
  key: string;
}

export interface SourceScan {
  /** String literals per file (registry.ts excluded by the caller). */
  literals: Map<string, Set<string>>;
  /** Key-taking lookup calls whose key argument is a string literal. */
  calls: LookupCall[];
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Scans one source text into `scan`. Literals are skipped for registry.ts. */
export function scanSourceText(file: string, text: string, scan: SourceScan, opts: { collectLiterals?: boolean } = {}): void {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const lits = new Set<string>();
  const visit = (node: ts.Node): void => {
    const lit = literalText(node);
    if (lit !== null) lits.add(lit);
    if (ts.isCallExpression(node)) {
      const fn = calleeName(node.expression);
      if (fn && Object.prototype.hasOwnProperty.call(KEY_LOOKUPS, fn)) {
        const arg = node.arguments[KEY_LOOKUPS[fn]];
        const key = arg ? literalText(arg) : null;
        if (key !== null) {
          const line = sf.getLineAndCharacterOfPosition(arg!.getStart(sf)).line + 1;
          scan.calls.push({ file, line, fn, key });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (opts.collectLiterals !== false) scan.literals.set(file, lits);
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      listSourceFiles(p, out);
    } else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Scans every non-test .ts file under src/. */
export function scanSrc(root: string = SRC_ROOT, registryFile: string = REGISTRY_FILE): SourceScan {
  const scan: SourceScan = { literals: new Map(), calls: [] };
  for (const file of listSourceFiles(root)) {
    const rel = path.relative(root, file);
    scanSourceText(rel, fs.readFileSync(file, "utf8"), scan, { collectLiterals: file !== registryFile });
  }
  return scan;
}

function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function localizedProblems(where: string, v: { no?: unknown; en?: unknown } | undefined): string[] {
  const out: string[] = [];
  if (!v || !hasText(v.no)) out.push(`${where}: missing Norwegian text`);
  if (!v || !hasText(v.en)) out.push(`${where}: missing English text`);
  return out;
}

/** Rule 1: NO+EN texts, group, default per segment, status; keys match OWNER_FEATURE_KEYS. */
export function checkEntryShape(
  registry: readonly OwnerFeatureEntry[],
  keys: readonly string[],
  groups: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of registry) {
    const k = e.key || "<no key>";
    if (seen.has(k)) problems.push(`${k}: duplicate registry entry`);
    seen.add(k);
    if (!keys.includes(k)) problems.push(`${k}: not in OWNER_FEATURE_KEYS`);
    problems.push(...localizedProblems(`${k}.label`, e.label));
    problems.push(...localizedProblems(`${k}.description`, e.description));
    for (const o of e.options ?? []) problems.push(...localizedProblems(`${k}.options[${o.value}].label`, o.label));
    if (!groups.includes(e.group)) problems.push(`${k}: unknown group ${JSON.stringify(e.group)}`);
    if (!(VALID_STATUSES as readonly string[]).includes(e.status)) problems.push(`${k}: invalid status ${JSON.stringify(e.status)}`);
    const d = e.default as Record<string, unknown> | undefined;
    for (const seg of SEGMENTS) {
      if (!d || !Object.prototype.hasOwnProperty.call(d, seg)) {
        problems.push(`${k}: no default for segment ${seg}`);
        continue;
      }
      const v = d[seg];
      if (!(v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number")) {
        problems.push(`${k}: default.${seg} has invalid type ${typeof v}`);
      }
    }
  }
  for (const k of keys) if (!seen.has(k)) problems.push(`${k}: in OWNER_FEATURE_KEYS but has no registry entry`);
  return problems;
}

export interface ReaderReport {
  problems: string[];
  /** Live keys that pass only via the structural cases (d) / (e). */
  structural: string[];
}

/** Rule 2: every live entry has a reader (see READER DEFINITION). */
export function checkLiveReaders(registry: readonly OwnerFeatureEntry[], scan: SourceScan): ReaderReport {
  const byKey = new Map(registry.map((e) => [e.key, e] as const));
  const callKeys = new Set(scan.calls.map((c) => c.key));
  const directReader = (key: string): string | null => {
    if (callKeys.has(key)) return "lookup call";
    for (const [file, lits] of scan.literals) if (lits.has(key)) return `literal in ${file}`;
    if (byKey.get(key)?.storage) return "storage adapter";
    return null;
  };
  const problems: string[] = [];
  const structural: string[] = [];
  for (const e of registry) {
    if (e.status !== "live") continue;
    if (directReader(e.key)) continue;
    if (e.type === "locked" && e.lockedWhen) {
      const parent = byKey.get(e.lockedWhen);
      if (parent && parent.status === "live" && directReader(parent.key)) {
        structural.push(`${e.key} (locked, derived from ${parent.key})`);
        continue;
      }
      problems.push(`${e.key}: live locked entry, but its parent ${e.lockedWhen} is not live or has no reader`);
      continue;
    }
    if (e.type === "guarantee") {
      if (e.default.owner === true) {
        structural.push(`${e.key} (guarantee, fixed on)`);
        continue;
      }
      problems.push(`${e.key}: live guarantee must default to ON for owners`);
      continue;
    }
    problems.push(`${e.key}: live entry has no reader in src/ (no lookup call, no key literal outside registry.ts, no storage adapter)`);
  }
  return { problems, structural };
}

/** Rule 3: no lookup with a string-literal key outside OWNER_FEATURE_KEYS. */
export function checkUnknownLookupKeys(calls: readonly LookupCall[], keys: readonly string[]): string[] {
  return calls
    .filter((c) => !keys.includes(c.key))
    .map((c) => `${c.file}:${c.line}: ${c.fn}(…${JSON.stringify(c.key)}…) — key not in OWNER_FEATURE_KEYS`);
}

export async function runRegistryGovernanceS4Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string, detail: string[] = []): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}` + detail.map((d) => `\n    ${d}`).join("");
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }

  try {
    const keys = OWNER_FEATURE_KEYS as readonly string[];
    const groups = OWNER_FEATURE_GROUPS.map((g) => g.key as string);

    // ── Self-check: the checkers must report a synthetic violation of each rule.
    const base = OWNER_FEATURE_REGISTRY.find((e) => e.key === "contact.phone")!;
    const fx = (over: Partial<OwnerFeatureEntry>): OwnerFeatureEntry => ({ ...base, storage: undefined, ...over });
    const fixtureKeys = ["fx.no_en", "fx.live_no_reader", "fx.live_read", "fx.lock_orphan", "fx.bad_guarantee"];
    const fixture: OwnerFeatureEntry[] = [
      fx({ key: "fx.no_en", label: { no: "Bare norsk", en: "" } }),
      fx({ key: "fx.live_no_reader", status: "live" }),
      fx({ key: "fx.live_read", status: "live" }),
      fx({ key: "fx.lock_orphan", type: "locked", status: "live", lockedWhen: "fx.live_no_reader" as any }),
      fx({ key: "fx.bad_guarantee", type: "guarantee", status: "live", default: { owner: false, unclaimed: null } }),
      fx({ key: "fx.bad_status", status: "shipped" as any, default: { owner: true } as any }),
    ];
    const fxScan: SourceScan = { literals: new Map(), calls: [] };
    scanSourceText(
      "fixture/reader.ts",
      [
        `import { featureOn, rfbFeatureOn } from "../owner-features/resolve";`,
        `// "fx.live_no_reader" in a comment is not a reader`,
        `export const a = featureOn("rfb", id, "fx.live_read");`,
        `export const b = rfbFeatureOn(id, "fx.typo_key");`,
      ].join("\n"),
      fxScan,
    );
    const shapeFx = checkEntryShape(fixture, fixtureKeys, groups);
    assertTrue(shapeFx.some((p) => p.startsWith("fx.no_en.label: missing English")), "self-check: missing EN label is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p.startsWith("fx.bad_status: invalid status")), "self-check: invalid status is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p === "fx.bad_status: no default for segment unclaimed"), "self-check: missing segment default is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p.startsWith("fx.bad_status: not in OWNER_FEATURE_KEYS")), "self-check: entry outside OWNER_FEATURE_KEYS is reported", shapeFx);
    const readersFx = checkLiveReaders(fixture, fxScan);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.live_no_reader:")), "self-check: live key without reader is reported (comment does not count)", readersFx.problems);
    assertTrue(!readersFx.problems.some((p) => p.startsWith("fx.live_read:")), "self-check: featureOn literal counts as reader", readersFx.problems);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.lock_orphan:")), "self-check: locked entry whose parent has no reader is reported", readersFx.problems);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.bad_guarantee:")), "self-check: guarantee defaulting off is reported", readersFx.problems);
    const unknownFx = checkUnknownLookupKeys(fxScan.calls, fixtureKeys);
    assertTrue(unknownFx.length === 1 && unknownFx[0].includes(`rfbFeatureOn(…"fx.typo_key"…)`), "self-check: unknown featureOn key is reported", unknownFx);

    // ── Rule 1: registry shape.
    const shape = checkEntryShape(OWNER_FEATURE_REGISTRY, keys, groups);
    assertTrue(OWNER_FEATURE_REGISTRY.length > 0, "registry is not empty");
    assertTrue(shape.length === 0, `rule 1: all ${OWNER_FEATURE_REGISTRY.length} entries have NO+EN texts, group, default per segment, valid status`, shape);

    // ── Rule 2 + 3 against the real src/ tree.
    const scan = scanSrc();
    assertTrue(scan.literals.size > 50, `src/ scan found non-test source files (${scan.literals.size})`);
    assertTrue(!scan.literals.has(path.relative(SRC_ROOT, REGISTRY_FILE)), "registry.ts literals are excluded from the reader scan");

    const live = OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live");
    const readers = checkLiveReaders(OWNER_FEATURE_REGISTRY, scan);
    assertTrue(readers.problems.length === 0, `rule 2: every live entry (${live.length}) has a reader in src/`, readers.problems);
    if (log && readers.structural.length) {
      console.info(`  note: live entries read only structurally (d/e): ${readers.structural.join(", ")}`);
    }

    const unknown = checkUnknownLookupKeys(scan.calls, keys);
    assertTrue(unknown.length === 0, `rule 3: no lookup with an unknown string-literal key (${scan.calls.length} literal-key calls checked)`, unknown);
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRegistryGovernanceS4Tests({ log: true }).then((r) => {
    console.info(`\nregistry-governance-s4: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}

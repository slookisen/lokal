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
 *   matrix     (S4-2a) every surface of every `live` entry has a case in
 *              OWNER_FEATURE_MATRIX_CASES (owner-feature-matrix.test.ts, the
 *              suite that runs default → on → off → on again per case), and
 *              no case names a key that is not a live registry entry or a
 *              surface the entry does not declare (stale case), no duplicates.
 *   self-check the checkers run on a small synthetic registry + source fixture
 *              (missing EN label, live key without reader, unknown featureOn
 *              key, live surface without matrix case, stale matrix case) and
 *              must report each — proves the gate can fail.
 *
 * READER DEFINITION. Live entries today are read through storage adapters and
 * enforcement lists rather than a literal featureOn('<key>'), so a «reader» is
 * any of:
 *   (a) a key-taking lookup call (list above) with the key as a string literal
 *       in a non-test src file;
 *   (b) the key as a string literal in a non-test src file outside
 *       NON_READER_FILES (enforcement lists such as ENFORCED_OWNER_FEATURE_KEYS
 *       / OWNER_VISIBILITY_KEYS, adapters writing owner_feature_settings).
 *       NON_READER_FILES only define, set or display values and never enforce
 *       them: registry.ts (the definitions), changes.ts (OWNER_LEVELS presets
 *       write values) and page.ts (OWNER_PAGE_STATUS_KEYS only show them). A
 *       key named only there has no enforcement, so it does not count;
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
 * Pure static check: no DB, no env, no globals (importing the matrix suite
 * only reads its coverage map; the suite itself runs separately). Exported
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
import { OWNER_FEATURE_MATRIX_CASES, matrixCaseId, type OwnerFeatureMatrixCase } from "./owner-feature-matrix.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SRC_ROOT = path.resolve(__dirname, "..");

/**
 * Files whose key literals never count as a reader (rule 2b): they define,
 * write (level presets) or display values but do not enforce them. Paths are
 * relative to src/, '/'-separated.
 */
export const NON_READER_FILES = [
  "owner-features/registry.ts",
  "owner-features/changes.ts",
  "owner-features/page.ts",
];

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
  /** String literals per file (relative to src/). */
  literals: Map<string, Set<string>>;
  /** Key-taking lookup calls whose key argument is a string literal. */
  calls: LookupCall[];
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * The string literal behind `node`, after unwrapping casts and parentheses
 * (`"k" as OwnerFeatureKey`, `<any>"k"`, `"k" satisfies …`, `("k")`, `"k"!`),
 * so a cast cannot hide an unknown key from rule 3 (or a reader from rule 2a).
 */
function literalText(node: ts.Node): string | null {
  while (
    ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Scans one source text into `scan` (`file` relative to src/, '/'-separated). */
export function scanSourceText(file: string, text: string, scan: SourceScan): void {
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
  scan.literals.set(file, lits);
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
export function scanSrc(root: string = SRC_ROOT): SourceScan {
  const scan: SourceScan = { literals: new Map(), calls: [] };
  for (const file of listSourceFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    scanSourceText(rel, fs.readFileSync(file, "utf8"), scan);
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
    if (e.confirmOn) problems.push(...localizedProblems(`${k}.confirmOn`, e.confirmOn));
    if (e.confirmOff) problems.push(...localizedProblems(`${k}.confirmOff`, e.confirmOff));
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
export function checkLiveReaders(
  registry: readonly OwnerFeatureEntry[],
  scan: SourceScan,
  nonReaderFiles: readonly string[] = NON_READER_FILES,
): ReaderReport {
  const byKey = new Map(registry.map((e) => [e.key, e] as const));
  const callKeys = new Set(scan.calls.map((c) => c.key));
  const directReader = (key: string): string | null => {
    if (callKeys.has(key)) return "lookup call";
    for (const [file, lits] of scan.literals) {
      if (!nonReaderFiles.includes(file) && lits.has(key)) return `literal in ${file}`;
    }
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
    problems.push(`${e.key}: live entry has no reader in src/ (no lookup call, no key literal outside ${NON_READER_FILES.join(", ")}, no storage adapter)`);
  }
  return { problems, structural };
}

/** Rule 3: no lookup with a string-literal key outside OWNER_FEATURE_KEYS. */
export function checkUnknownLookupKeys(calls: readonly LookupCall[], keys: readonly string[]): string[] {
  return calls
    .filter((c) => !keys.includes(c.key))
    .map((c) => `${c.file}:${c.line}: ${c.fn}(…${JSON.stringify(c.key)}…) — key not in OWNER_FEATURE_KEYS`);
}

/**
 * Rule 4 (S4-2a): the CI matrix covers every surface of every live entry, and
 * names nothing the registry does not have.
 */
export function checkMatrixCoverage(
  registry: readonly OwnerFeatureEntry[],
  cases: readonly Pick<OwnerFeatureMatrixCase, "key" | "surface">[],
): string[] {
  const problems: string[] = [];
  const byKey = new Map(registry.map((e) => [e.key, e] as const));
  const caseIds = new Set<string>();
  for (const c of cases) {
    const id = matrixCaseId(c);
    if (caseIds.has(id)) problems.push(`${id}: duplicate matrix case`);
    caseIds.add(id);
    const e = byKey.get(c.key);
    if (!e) problems.push(`${id}: stale matrix case — key not in the registry`);
    else if (e.status !== "live") problems.push(`${id}: stale matrix case — ${c.key} is ${e.status}, not live`);
    else if (!(e.surfaces as readonly string[]).includes(c.surface)) problems.push(`${id}: stale matrix case — ${c.key} does not declare surface ${c.surface}`);
  }
  for (const e of registry) {
    if (e.status !== "live") continue;
    for (const s of e.surfaces) {
      if (!caseIds.has(matrixCaseId({ key: e.key, surface: s }))) problems.push(`${e.key} × ${s}: live surface has no matrix case in OWNER_FEATURE_MATRIX_CASES`);
    }
  }
  return problems;
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
    const fixtureKeys = ["fx.no_en", "fx.live_no_reader", "fx.live_read", "fx.lock_orphan", "fx.bad_guarantee", "fx.preset_only", "fx.cast_read"];
    const fixture: OwnerFeatureEntry[] = [
      fx({ key: "fx.no_en", label: { no: "Bare norsk", en: "" } }),
      fx({ key: "fx.live_no_reader", status: "live" }),
      fx({ key: "fx.live_read", status: "live" }),
      fx({ key: "fx.lock_orphan", type: "locked", status: "live", lockedWhen: "fx.live_no_reader" as any }),
      fx({ key: "fx.bad_guarantee", type: "guarantee", status: "live", default: { owner: false, unclaimed: null } }),
      fx({ key: "fx.bad_status", status: "shipped" as any, default: { owner: true } as any }),
      fx({ key: "fx.preset_only", status: "live" }),
      fx({ key: "fx.cast_read", status: "live", confirmOn: { no: "Sikker?", en: "" } }),
    ];
    const fxScan: SourceScan = { literals: new Map(), calls: [] };
    scanSourceText(
      "fixture/reader.ts",
      [
        `import { featureOn, rfbFeatureOn } from "../owner-features/resolve";`,
        `// "fx.live_no_reader" in a comment is not a reader`,
        `export const a = featureOn("rfb", id, "fx.live_read");`,
        `export const b = rfbFeatureOn(id, "fx.typo_key");`,
        `export const c = featureOn("rfb", "a", "nope.key" as OwnerFeatureKey, { db });`,
        `export const d = rfbFeatureOn(id, (<any>"fx.cast_read")!);`,
      ].join("\n"),
      fxScan,
    );
    // Preset / display files: their literals must not count as readers.
    scanSourceText("owner-features/changes.ts", `export const L = [{ values: { "fx.preset_only": true } }];`, fxScan);
    scanSourceText("owner-features/page.ts", `export const K = ["fx.preset_only"];`, fxScan);
    const shapeFx = checkEntryShape(fixture, fixtureKeys, groups);
    assertTrue(shapeFx.some((p) => p.startsWith("fx.no_en.label: missing English")), "self-check: missing EN label is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p.startsWith("fx.bad_status: invalid status")), "self-check: invalid status is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p === "fx.bad_status: no default for segment unclaimed"), "self-check: missing segment default is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p.startsWith("fx.bad_status: not in OWNER_FEATURE_KEYS")), "self-check: entry outside OWNER_FEATURE_KEYS is reported", shapeFx);
    assertTrue(shapeFx.some((p) => p === "fx.cast_read.confirmOn: missing English text"), "self-check: confirmOn without EN is reported", shapeFx);
    const readersFx = checkLiveReaders(fixture, fxScan);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.live_no_reader:")), "self-check: live key without reader is reported (comment does not count)", readersFx.problems);
    assertTrue(!readersFx.problems.some((p) => p.startsWith("fx.live_read:")), "self-check: featureOn literal counts as reader", readersFx.problems);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.preset_only:")), "self-check: key named only in changes.ts presets / page.ts display is reported", readersFx.problems);
    assertTrue(!readersFx.problems.some((p) => p.startsWith("fx.cast_read:")), "self-check: cast featureOn literal counts as reader", readersFx.problems);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.lock_orphan:")), "self-check: locked entry whose parent has no reader is reported", readersFx.problems);
    assertTrue(readersFx.problems.some((p) => p.startsWith("fx.bad_guarantee:")), "self-check: guarantee defaulting off is reported", readersFx.problems);
    const unknownFx = checkUnknownLookupKeys(fxScan.calls, fixtureKeys);
    assertTrue(unknownFx.some((u) => u.includes(`rfbFeatureOn(…"fx.typo_key"…)`)), "self-check: unknown featureOn key is reported", unknownFx);
    assertTrue(unknownFx.some((u) => u.includes(`featureOn(…"nope.key"…)`)), "self-check: unknown featureOn key behind `as` cast is reported", unknownFx);
    assertTrue(unknownFx.length === 2, "self-check: exactly the two unknown keys are reported (cast known key is fine)", unknownFx);

    const fxMatrixReg: OwnerFeatureEntry[] = [
      fx({ key: "fx.mx_live", status: "live", surfaces: ["order_gate", "email:fx_mail"] }),
      fx({ key: "fx.mx_soon", status: "coming_soon", surfaces: ["profile_html"] }),
    ];
    const matrixFx = checkMatrixCoverage(fxMatrixReg, [
      { key: "fx.mx_live", surface: "order_gate" },
      { key: "fx.mx_live", surface: "order_gate" },
      { key: "fx.mx_live", surface: "job:fx_gone" },
      { key: "fx.mx_gone", surface: "order_gate" },
      { key: "fx.mx_soon", surface: "profile_html" },
    ]);
    assertTrue(matrixFx.some((p) => p.startsWith("fx.mx_live × email:fx_mail: live surface has no matrix case")), "self-check: live surface without matrix case is reported", matrixFx);
    assertTrue(matrixFx.some((p) => p.startsWith("fx.mx_live × job:fx_gone: stale matrix case")), "self-check: matrix case for an undeclared surface is reported", matrixFx);
    assertTrue(matrixFx.some((p) => p.startsWith("fx.mx_gone × order_gate: stale matrix case — key not in the registry")), "self-check: matrix case for an unknown key is reported", matrixFx);
    assertTrue(matrixFx.some((p) => p.startsWith("fx.mx_soon × profile_html: stale matrix case")), "self-check: matrix case for a non-live key is reported", matrixFx);
    assertTrue(matrixFx.some((p) => p === "fx.mx_live × order_gate: duplicate matrix case"), "self-check: duplicate matrix case is reported", matrixFx);
    assertTrue(!matrixFx.some((p) => p.startsWith("fx.mx_soon ×") && p.includes("no matrix case")), "self-check: a coming_soon entry needs no matrix case", matrixFx);
    assertTrue(matrixFx.length === 5, "self-check: exactly the five matrix problems are reported", matrixFx);

    // ── Rule 1: registry shape.
    const shape = checkEntryShape(OWNER_FEATURE_REGISTRY, keys, groups);
    assertTrue(OWNER_FEATURE_REGISTRY.length > 0, "registry is not empty");
    assertTrue(shape.length === 0, `rule 1: all ${OWNER_FEATURE_REGISTRY.length} entries have NO+EN texts, group, default per segment, valid status`, shape);

    // ── Rule 2 + 3 against the real src/ tree.
    const scan = scanSrc();
    assertTrue(scan.literals.size > 50, `src/ scan found non-test source files (${scan.literals.size})`);
    assertTrue(NON_READER_FILES.every((f) => scan.literals.has(f)), "every NON_READER_FILES path exists in the src/ scan (no stale exclusion)");

    const live = OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live");
    const readers = checkLiveReaders(OWNER_FEATURE_REGISTRY, scan);
    assertTrue(readers.problems.length === 0, `rule 2: every live entry (${live.length}) has a reader in src/`, readers.problems);
    if (readers.structural.length) {
      console.info(`  note: live entries read only structurally (d/e): ${readers.structural.join(", ")}`);
    }

    const unknown = checkUnknownLookupKeys(scan.calls, keys);
    assertTrue(unknown.length === 0, `rule 3: no lookup with an unknown string-literal key (${scan.calls.length} literal-key calls checked)`, unknown);

    // ── Rule 4: CI matrix per live key × surface.
    const liveSurfaces = live.reduce((n, e) => n + e.surfaces.length, 0);
    const matrix = checkMatrixCoverage(OWNER_FEATURE_REGISTRY, OWNER_FEATURE_MATRIX_CASES);
    assertTrue(matrix.length === 0, `rule 4: every live surface (${liveSurfaces}) has a matrix case, no stale case (${OWNER_FEATURE_MATRIX_CASES.length} cases)`, matrix);
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

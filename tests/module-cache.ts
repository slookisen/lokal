/**
 * Test-only: take modules out of require.cache for one block and put the
 * previous entries back when the block ends.
 *
 * Blocks that want a fresh db-factory (and the stores/routes bound to it)
 * delete those require.cache entries and re-require them. Code loaded
 * earlier keeps the copy it already holds, so without a restore several
 * db-factory copies stay alive, each with its own handle cache, and a later
 * __resetDbFactoryForTesting() only reaches whichever copy require.cache
 * holds at that moment — not necessarily the one production code uses.
 *
 * swapOutModules(ids) deletes the entries and returns restore(), to be
 * called in `finally`. restore():
 *   - puts each previous entry back, or deletes the id when there was none.
 *     Counted per id: when async blocks overlap on the same id, the entry
 *     goes back when the last of them restores, never under a running block;
 *   - drops modules that were first loaded while the swap was active and are
 *     still bound to a copy that has left require.cache (found through
 *     Module#children), so the next require() loads them against the
 *     restored copies instead of a closed or stale handle cache;
 *   - when it closes the last open swap, does that again for everything
 *     loaded since the first of the overlapping swaps opened. With async
 *     blocks overlapping, block B can take a module that block A's copy had
 *     just bound as its own "previous" entry and put it back after A has
 *     already restored; only this pass catches that.
 * Resetting the block's own db-factory copy stays the block's job: call
 * __resetDbFactoryForTesting() on the copy it required, not on a re-require.
 */

type CachedModule = NodeJS.Module;

interface Slot {
  /** Blocks that have this id swapped out right now. */
  depth: number;
  /** The entry to put back once depth is 0 again. */
  previous: CachedModule | undefined;
}

interface Overlap {
  /** Swaps opened and not yet restored, over all ids. */
  open: number;
  /** require.cache as it was when the first of the open swaps began. */
  before: Map<string, CachedModule | undefined> | null;
}

// On globalThis, like db-factory's resolved-path record: if this module is
// ever loaded twice, both copies must share one table.
function slots(): Map<string, Slot> {
  const g = globalThis as { [key: symbol]: Map<string, Slot> | undefined };
  return (g[Symbol.for("lokal.tests.moduleCacheSlots")] ??= new Map());
}

function overlap(): Overlap {
  const g = globalThis as { [key: symbol]: Overlap | undefined };
  return (g[Symbol.for("lokal.tests.moduleCacheOverlap")] ??= { open: 0, before: null });
}

/** Ids (from require.resolve) that a block still has swapped out. */
export function swappedOutModuleIds(): string[] {
  return [...slots()].filter(([, slot]) => slot.depth > 0).map(([id]) => id);
}

export function swapOutModules(ids: readonly string[]): () => void {
  const table = slots();
  const open = overlap();
  const own = [...new Set(ids)];
  const before = new Map(Object.entries(require.cache));
  if (open.open === 0) open.before = before;
  open.open++;
  for (const id of own) {
    let slot = table.get(id);
    if (!slot || slot.depth === 0) {
      slot = { depth: 0, previous: require.cache[id] };
      table.set(id, slot);
    }
    slot.depth++;
    __diagLog(`swap-out depth=${slot.depth} prev=${__diagTag(slot.previous)} cur=`, id, require.cache[id]); // TEMP-DIAG
    delete require.cache[id];
  }

  let restored = false;
  return function restoreModules(): void {
    if (restored) return;
    restored = true;
    for (const id of own) {
      const slot = table.get(id)!;
      slot.depth--;
      __diagLog(`restore depth=${slot.depth} block-copy=${__diagTag(require.cache[id])} put-back=`, id, slot.depth > 0 ? null : (slot.previous ?? null)); // TEMP-DIAG
      if (slot.depth > 0) continue;
      if (slot.previous) require.cache[id] = slot.previous;
      else delete require.cache[id];
    }
    dropModulesBoundToStaleCopies(before, table);
    open.open--;
    if (open.open === 0 && open.before) {
      const epochBefore = open.before;
      open.before = null;
      dropModulesBoundToStaleCopies(epochBefore, table);
    }
  };
}

/** swapOutModules() around fn; restores when fn returns, throws or settles. */
export function withModulesSwappedOut<T>(ids: readonly string[], fn: () => T): T {
  const restore = swapOutModules(ids);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

// TEMP-DIAG (PR #1042 CI investigation) — remove before merge.
const __diagTags = new WeakMap<object, number>();
let __diagSeq = 0;
const __diagTag = (m: unknown): string => {
  if (!m || typeof m !== "object") return "none";
  if (!__diagTags.has(m)) __diagTags.set(m, ++__diagSeq);
  return `#${__diagTags.get(m)}`;
};
const __diagRe = /email-service|booking-store/;
const __diagRel = (p: string) => String(p).replace(/.*[\\/](src|tests)[\\/]/, "$1/");
export function __diagStaleBindings(where: string): void {
  const cache = require.cache;
  const lines: string[] = [];
  for (const [id, m] of Object.entries(cache)) {
    if (!m || /[\\/]tests[\\/]|\.test\.ts$/.test(id)) continue;
    for (const c of m.children ?? []) {
      if (!c || !/email-service|booking-store|db-factory/.test(c.filename)) continue;
      if (cache[c.filename] !== c) lines.push(`${__diagRel(id)}${__diagTag(m)} -> ${__diagRel(c.filename)}${__diagTag(c)} (current ${__diagTag(cache[c.filename])})`);
    }
  }
  const bs = Object.keys(cache).find((k) => /[\\/]services[\\/]booking-store\.ts$/.test(k));
  const es = Object.keys(cache).find((k) => /[\\/]services[\\/]email-service\.ts$/.test(k));
  const bsEmail = bs ? (cache[bs]!.children ?? []).filter((c) => /email-service/.test(c.filename)).map(__diagTag).join(",") : "-";
  console.log(`MCDIAG [${where}] booking-store=${bs ? __diagTag(cache[bs]) : "absent"} its email=${bsEmail} | email-service=${es ? __diagTag(cache[es]) : "absent"} | open=${overlap().open} | stale bindings=${lines.length}`);
  for (const l of lines.slice(0, 30)) console.log(`MCDIAG   ${l}`);
}
function __diagLog(what: string, id: string, m?: unknown): void {
  if (__diagRe.test(id)) console.log(`MCDIAG ${what} ${__diagRel(id)} ${m === undefined ? "" : __diagTag(m)} open=${overlap().open}`);
}
// END TEMP-DIAG

function dropModulesBoundToStaleCopies(
  before: Map<string, CachedModule | undefined>,
  table: Map<string, Slot>,
): void {
  const cache = require.cache;
  const memo = new Map<CachedModule, boolean>();
  // A module object loaded after the swap began is bound to a stale copy if
  // it has left require.cache itself, or if anything it required has.
  // Some tests put hand-built entries ({ id, exports, ... }) in the cache,
  // without filename/children; for cache entries the key is passed in.
  const boundToStale = (m: CachedModule, key: string = m.filename ?? m.id): boolean => {
    if (before.get(key) === m) return false;
    const known = memo.get(m);
    if (known !== undefined) return known;
    memo.set(m, false); // cycles
    const stale = cache[key] !== m || (m.children ?? []).some((c) => boundToStale(c));
    memo.set(m, stale);
    return stale;
  };
  // Decide first, then edit the cache, so the answer does not depend on the
  // order the entries are visited in. An id another block still has swapped
  // out is left to that block's restore.
  const stale = Object.entries(cache)
    .filter(([id, m]) => m && boundToStale(m, id) && (table.get(id)?.depth ?? 0) === 0)
    .map(([id]) => id);
  for (const id of stale) {
    // The entry from before the swap is not bound to the block's copies.
    const previous = before.get(id);
    __diagLog(`drop stale=${__diagTag(cache[id])} replace-with=`, id, previous ?? null); // TEMP-DIAG
    if (previous) cache[id] = previous;
    else delete cache[id];
  }
}

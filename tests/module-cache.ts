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
 *     restored copies instead of a closed or stale handle cache.
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

// On globalThis, like db-factory's resolved-path record: if this module is
// ever loaded twice, both copies must share one table.
function slots(): Map<string, Slot> {
  const g = globalThis as { [key: symbol]: Map<string, Slot> | undefined };
  return (g[Symbol.for("lokal.tests.moduleCacheSlots")] ??= new Map());
}

/** Ids (from require.resolve) that a block still has swapped out. */
export function swappedOutModuleIds(): string[] {
  return [...slots()].filter(([, slot]) => slot.depth > 0).map(([id]) => id);
}

export function swapOutModules(ids: readonly string[]): () => void {
  const table = slots();
  const own = [...new Set(ids)];
  const before = new Map(Object.entries(require.cache));
  for (const id of own) {
    let slot = table.get(id);
    if (!slot || slot.depth === 0) {
      slot = { depth: 0, previous: require.cache[id] };
      table.set(id, slot);
    }
    slot.depth++;
    delete require.cache[id];
  }

  let restored = false;
  return function restoreModules(): void {
    if (restored) return;
    restored = true;
    for (const id of own) {
      const slot = table.get(id)!;
      slot.depth--;
      if (slot.depth > 0) continue;
      if (slot.previous) require.cache[id] = slot.previous;
      else delete require.cache[id];
    }
    dropModulesBoundToStaleCopies(before, table);
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
    if (previous) cache[id] = previous;
    else delete cache[id];
  }
}

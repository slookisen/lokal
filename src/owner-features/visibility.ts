// ─── «Mine valg» — the owner's visibility choices (S2c-2) ────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2c-2: the lookup
// behind the shared visibility predicate in services/agent-visibility.ts,
// which requires this module lazily and only while OWNER_FEATURES_ENFORCE is
// on. Surfaces never call this file directly — they ask agent-visibility.ts
// (publicListableSql, isAgentIdPubliclyVisible, notOwnerHiddenSql,
// ownerHiddenAgentIds, ownerHidesAgent), so the rule lives in one place.
//
// Only subjects in OWNER_FEATURES_ALLOWED_SUBJECTS (`rfb:<agents.id>`) are
// looked up; a profile outside the allowlist is never hidden and costs no
// query. All allowlisted profiles resolve with ONE query
// (resolveOwnerFeatureKeysForSubjects), so a list surface pays one lookup per
// request, not one per row. Values come from the resolver: a key that is still
// `coming_soon` keeps its default (shown) — only an admin lock, or the status
// flip after the S2d switch probe, makes a choice take effect.
// A failed lookup hides the allowlisted profiles everywhere (fail closed) and logs.

import { ownerFeaturesAllowedSubjects } from "./allowlist";
import { resolveOwnerFeatureKeysForSubjects, type ResolvedOwnerFeature } from "./resolve";
import type { OwnerFeatureEntry, OwnerFeatureKey } from "./registry";
import type { OwnerVisibilityChoice } from "../services/agent-visibility";

export const OWNER_VISIBILITY_KEYS: Record<OwnerVisibilityChoice, OwnerFeatureKey> = {
  profile: "visibility.profile",
  ai_assistants: "visibility.ai_assistants",
  search_engines: "visibility.search_engines",
  shopping_feeds: "visibility.shopping_feeds",
  english: "visibility.english",
  leaderboard: "visibility.leaderboard",
};

const CHOICES = Object.keys(OWNER_VISIBILITY_KEYS) as OwnerVisibilityChoice[];
const KEYS = CHOICES.map((c) => OWNER_VISIBILITY_KEYS[c]);

export interface OwnerVisibilityOptions {
  db?: any;
  env?: NodeJS.ProcessEnv;
}

let registryOverride: OwnerFeatureEntry[] | null = null;

/** Test hook: resolve against a fixture registry (e.g. the keys flipped live). */
export function __setVisibilityRegistryForTesting(registry: OwnerFeatureEntry[] | null): void {
  registryOverride = registry;
}

/** The choices that hide one profile, from its resolved keys. profile off hides everything. */
function hiddenChoices(byKey: Record<string, ResolvedOwnerFeature>): Set<OwnerVisibilityChoice> {
  const off = (c: OwnerVisibilityChoice) => byKey[OWNER_VISIBILITY_KEYS[c]]?.value === false;
  if (off("profile")) return new Set(CHOICES);
  return new Set(CHOICES.filter(off));
}

function allowlistedIds(env: NodeJS.ProcessEnv): string[] {
  return ownerFeaturesAllowedSubjects(env)
    .filter((s) => s.startsWith("rfb:"))
    .map((s) => s.slice(4))
    .filter(Boolean);
}

/**
 * Hidden choices per allowlisted profile (only profiles with at least one
 * hidden choice are in the map). One query for all of them.
 */
export function ownerHiddenChoicesForMany(
  agentIds: Iterable<string> | null,
  opts: OwnerVisibilityOptions = {},
): Map<string, Set<OwnerVisibilityChoice>> {
  const env = opts.env ?? process.env;
  const out = new Map<string, Set<OwnerVisibilityChoice>>();
  const allowed = allowlistedIds(env);
  if (allowed.length === 0) return out;
  const wanted = agentIds === null ? allowed : [...new Set(agentIds)].filter((id) => allowed.includes(id));
  if (wanted.length === 0) return out;
  try {
    const resolved = resolveOwnerFeatureKeysForSubjects("rfb", wanted, KEYS, {
      db: opts.db, env, registry: registryOverride ?? undefined,
    });
    for (const [id, byKey] of resolved) {
      const hidden = hiddenChoices(byKey);
      if (hidden.size > 0) out.set(id, hidden);
    }
  } catch (err) {
    console.error("[owner-features] visibility lookup failed, hiding the allowlisted profiles:", err);
    for (const id of wanted) out.set(id, new Set(CHOICES));
  }
  return out;
}

/** Ids of the allowlisted profiles hidden on a `choice` surface. */
export function ownerHiddenIdsFor(choice: OwnerVisibilityChoice, opts: OwnerVisibilityOptions = {}): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, hidden] of ownerHiddenChoicesForMany(null, opts)) if (hidden.has(choice)) ids.add(id);
  return ids;
}

/** The choices that hide one profile (empty, without a query, when it is not allowlisted). */
export function ownerHiddenChoicesFor(agentId: string, opts: OwnerVisibilityOptions = {}): ReadonlySet<OwnerVisibilityChoice> {
  return ownerHiddenChoicesForMany([agentId], opts).get(agentId) ?? new Set();
}

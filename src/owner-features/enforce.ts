// ─── «Mine valg» — the owner's choices on public surfaces (S2c-1) ───────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2c-1: server-side
// enforcement of contact.phone, contact.address, products.show_prices and
// stats.public_counts / public_search_terms / public_trust on the surfaces
// each declares in the registry (`surfaces`).
//
// Gate: OWNER_FEATURES_ENFORCE ("1"/"true") AND the subject has the
// `mine_valg` owner feature (feature-tiers.ts ownerFeatureAllowedRfbIds: the
// pilot list OWNER_FEATURES_ALLOWED_SUBJECTS by default; beta/ga per tier,
// beta-for-alle S2). Otherwise the lookup returns nothing
// without touching the DB, and every surface renders exactly as before.
// Values come from the resolver (./resolve.ts), so a key that is still
// `coming_soon` keeps its default (shown) — only an admin lock or the status
// flip after the S2d switch probe makes a choice take effect.
//
// The `auto.*` switches with a public effect have their own off-set helpers
// on the same gate: auto.debio (debioSwitchOffAgentIds) and, «Mine valg»
// S3-1, auto.affiliations (affiliationsSwitchOffAgentIds: no affiliations
// card and no JSON-LD memberOf on the producer page). S3-2: with the key
// live, the owner hides single affiliations (affiliationsPerItemEnabled,
// affiliationsPageMode).
//
// List surfaces resolve all their allowlisted subjects with one query
// (resolveOwnerFeatureKeysForSubjects). A failed lookup for an allowlisted
// subject hides the enforced fields (fail closed) and logs.

import { ownerFeatureAllowedRfbIds } from "./feature-tiers";
import { resolveOwnerFeatureKeysForSubjects, type ResolvedOwnerFeature } from "./resolve";
import { OWNER_FEATURE_REGISTRY, ownerFeatureStatus, type OwnerFeatureEntry, type OwnerFeatureKey } from "./registry";
import { isProductHeader, isProductNoise, parseProductPrice, productPriceText } from "../services/knowledge-service";

export const OWNER_FEATURES_ENFORCE_ENV = "OWNER_FEATURES_ENFORCE";

export const ENFORCED_OWNER_FEATURE_KEYS = [
  "contact.phone",
  "contact.address",
  "products.show_prices",
  "stats.public_counts",
  "stats.public_search_terms",
  "stats.public_trust",
] as const satisfies readonly OwnerFeatureKey[];

/** What a public surface may show for one profile. true = as today. */
export interface PublicFieldChoices {
  phone: boolean;
  /** false = «Bare sted»: no street address, postal code or coordinates. */
  address: boolean;
  prices: boolean;
  publicCounts: boolean;
  publicSearchTerms: boolean;
  publicTrust: boolean;
}

const HIDE_ALL: PublicFieldChoices = {
  phone: false, address: false, prices: false, publicCounts: false, publicSearchTerms: false, publicTrust: false,
};

export function ownerFeaturesEnforceOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OWNER_FEATURES_ENFORCE_ENV];
  return v === "1" || v === "true";
}

let registryOverride: OwnerFeatureEntry[] | null = null;

/** Test hook: resolve against a fixture registry (e.g. the keys flipped live). */
export function __setEnforceRegistryForTesting(registry: OwnerFeatureEntry[] | null): void {
  registryOverride = registry;
}

function toChoices(byKey: Record<string, ResolvedOwnerFeature>): PublicFieldChoices {
  return {
    phone: byKey["contact.phone"]?.value !== false,
    address: byKey["contact.address"]?.value !== "place",
    prices: byKey["products.show_prices"]?.value !== false,
    publicCounts: byKey["stats.public_counts"]?.value !== false,
    publicSearchTerms: byKey["stats.public_search_terms"]?.value !== false,
    publicTrust: byKey["stats.public_trust"]?.value !== false,
  };
}

export interface EnforceOptions {
  db?: any;
  env?: NodeJS.ProcessEnv;
}

/**
 * Choices for the enforced subjects among `agentIds` (vertical rfb). An id
 * missing from the map is not enforced: render it as today.
 */
export function publicFieldChoicesForMany(agentIds: Iterable<string>, opts: EnforceOptions = {}): Map<string, PublicFieldChoices> {
  const env = opts.env ?? process.env;
  const out = new Map<string, PublicFieldChoices>();
  if (!ownerFeaturesEnforceOn(env)) return out;
  const allowed = new Set(ownerFeatureAllowedRfbIds("mine_valg", { env, db: opts.db }));
  if (allowed.size === 0) return out;
  const ids = [...new Set(agentIds)].filter((id) => typeof id === "string" && allowed.has(id));
  if (ids.length === 0) return out;
  try {
    const resolved = resolveOwnerFeatureKeysForSubjects("rfb", ids, ENFORCED_OWNER_FEATURE_KEYS, {
      db: opts.db, env, registry: registryOverride ?? undefined,
    });
    for (const [id, byKey] of resolved) out.set(id, toChoices(byKey));
  } catch (err) {
    console.error("[owner-features] enforcement lookup failed, hiding the enforced fields:", err);
    for (const id of ids) out.set(id, HIDE_ALL);
  }
  return out;
}

/** Choices for one profile; null = not enforced (render as today). */
export function publicFieldChoices(agentId: string, opts: EnforceOptions = {}): PublicFieldChoices | null {
  if (!agentId) return null;
  return publicFieldChoicesForMany([agentId], opts).get(agentId) ?? null;
}

export function hidesContact(c: PublicFieldChoices | null | undefined): boolean {
  return !!c && (!c.phone || !c.address);
}
export function hidesPrices(c: PublicFieldChoices | null | undefined): boolean {
  return !!c && !c.prices;
}
export function hidesTrust(c: PublicFieldChoices | null | undefined): boolean {
  return !!c && !c.publicTrust;
}
export function hidesAddress(c: PublicFieldChoices | null | undefined): boolean {
  return !!c && !c.address;
}

/**
 * A copy of a knowledge object without the hidden phone / street address /
 * postal code. The same object when nothing is hidden.
 */
export function withoutHiddenContact<T>(k: T, c: PublicFieldChoices | null | undefined): T {
  if (!hidesContact(c) || !k || typeof k !== "object") return k;
  const out: any = { ...(k as any) };
  if (!c!.phone) delete out.phone;
  if (!c!.address) {
    delete out.address;
    delete out.postalCode;
  }
  return out;
}

/** One products-JSON entry without its price (field, unit and a «– kr 275/kg» in the name). */
export function productWithoutPrice(p: unknown): unknown {
  const name = typeof p === "string" ? p : p && typeof p === "object" ? (p as any).name : undefined;
  let cleanName = name;
  if (typeof name === "string" && !isProductHeader(name.trim()) && !isProductNoise(name.trim())) {
    const parsed = parseProductPrice({ name } as any);
    if (parsed.price) cleanName = parsed.cleanName;
  }
  if (typeof p === "string") return cleanName;
  if (!p || typeof p !== "object") return p;
  const out: any = { ...(p as any) };
  if (typeof name === "string") out.name = cleanName;
  // A non-numeric price text on a section header is a descriptor, not a price.
  if (!(typeof name === "string" && isProductHeader(name.trim()) && !/\d/.test(productPriceText(out.price)))) {
    delete out.price;
  }
  delete out.priceUnit;
  return out;
}

/** A copy of a knowledge object with prices removed from `products` when hidden. */
export function withoutHiddenPrices<T>(k: T, c: PublicFieldChoices | null | undefined): T {
  if (!hidesPrices(c) || !k || typeof k !== "object" || !Array.isArray((k as any).products)) return k;
  return { ...(k as any), products: (k as any).products.map(productWithoutPrice) };
}

/** Contact and prices together (surfaces that read both from one object). */
export function withoutHiddenFields<T>(k: T, c: PublicFieldChoices | null | undefined): T {
  return withoutHiddenPrices(withoutHiddenContact(k, c), c);
}

/** A copy of an agent object without coordinates when the address is hidden. */
export function withoutHiddenCoordinates<T>(agent: T, c: PublicFieldChoices | null | undefined): T {
  if (!hidesAddress(c) || !agent || typeof agent !== "object") return agent;
  const a = agent as any;
  if (!a.location || typeof a.location !== "object") return agent;
  const { lat: _lat, lng: _lng, ...location } = a.location;
  return { ...a, location } as T;
}

/**
 * A getAgentInfo() response for a public by-id read (REST /info, the MCP
 * producer resource, A2A agent/info): knowledge without the hidden fields,
 * agent without coordinates (address hidden) and trust score (trust hidden).
 * The same object when not enforced.
 */
export function publicAgentInfo<T extends { agent: any; knowledge: any }>(info: T, c: PublicFieldChoices | null | undefined): T {
  if (!c || !info) return info;
  const agent: any = withoutHiddenCoordinates({ ...info.agent }, c);
  if (hidesTrust(c)) delete agent.trustScore;
  return { ...info, agent, knowledge: withoutHiddenFields(info.knowledge, c) };
}


/**
 * The allowlisted subjects among `agentIds` when the gate is open
 * (OWNER_FEATURES_ENFORCE on AND the `mine_valg` owner feature); [] = gate
 * shut (no DB read for the resolution itself).
 */
function gatedSubjectIds(agentIds: Iterable<string>, env: NodeJS.ProcessEnv, db: any): string[] {
  if (!ownerFeaturesEnforceOn(env)) return [];
  const allowed = new Set(ownerFeatureAllowedRfbIds("mine_valg", { env, db }));
  if (allowed.size === 0) return [];
  return [...new Set(agentIds)].filter((id) => typeof id === "string" && allowed.has(id));
}

/**
 * The agents among `ids` whose switch `key` resolves to false. A failed
 * lookup counts every id as off (fail closed) and logs `<key> lookup failed`.
 */
function switchOffIds(ids: string[], key: OwnerFeatureKey, env: NodeJS.ProcessEnv, db: any): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  try {
    const resolved = resolveOwnerFeatureKeysForSubjects("rfb", ids, [key], {
      db, env, registry: registryOverride ?? undefined,
    });
    for (const [id, byKey] of resolved) if (byKey[key]?.value === false) out.add(id);
  } catch (err) {
    console.error(`[owner-features] ${key} lookup failed, treating the switch as off:`, err);
    for (const id of ids) out.add(id);
  }
  return out;
}

/**
 * Økologi S1 (A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-
 * og-tekstrevisjon, S1.7): the agents among `agentIds` whose `auto.debio`
 * switch is off — no organic display at all for them (the register sync
 * leaves their `debio_verified` at 0, the profile page shows no approval).
 * Same gate as the choices above: OWNER_FEATURES_ENFORCE and the allowlist,
 * otherwise nobody is off. A failed lookup counts the allowlisted ids as off
 * (fail closed) and logs.
 */
export function debioSwitchOffAgentIds(agentIds: Iterable<string>, opts: EnforceOptions = {}): Set<string> {
  const env = opts.env ?? process.env;
  return switchOffIds(gatedSubjectIds(agentIds, env, opts.db), "auto.debio", env, opts.db);
}

const AFFILIATIONS_KEY = "auto.affiliations" as const satisfies OwnerFeatureKey;

/**
 * «Mine valg» S3-1: the agents among `agentIds` whose `auto.affiliations`
 * switch is off — the producer page shows no affiliations card and its
 * JSON-LD no memberOf. Same gate and fail-closed rule as
 * debioSwitchOffAgentIds.
 */
export function affiliationsSwitchOffAgentIds(agentIds: Iterable<string>, opts: EnforceOptions = {}): Set<string> {
  const env = opts.env ?? process.env;
  return switchOffIds(gatedSubjectIds(agentIds, env, opts.db), AFFILIATIONS_KEY, env, opts.db);
}

/** Is the `auto.affiliations` entry live (the registry override in tests)? Registry only, no DB. */
function affiliationsKeyLive(env: NodeJS.ProcessEnv): boolean {
  const e = (registryOverride ?? OWNER_FEATURE_REGISTRY).find((x) => x.key === AFFILIATIONS_KEY);
  return !!e && ownerFeatureStatus(e, env) === "live";
}

/**
 * «Mine valg» S3-2: may the owner hide single affiliations, and does the
 * producer page honour it? The S3-1 gate (OWNER_FEATURES_ENFORCE AND the
 * profile in the `mine_valg` allowlist) AND `auto.affiliations` live. Reads
 * no setting (the allowlist only); false outside the gate.
 */
export function affiliationsPerItemEnabled(agentId: string, opts: EnforceOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (!agentId) return false;
  if (gatedSubjectIds([agentId], env, opts.db).length === 0) return false;
  return affiliationsKeyLive(env);
}

/**
 * What the producer page shows of its affiliations (forward direction):
 *   as_before          gate shut, or the key not live: the query as before;
 *   none               the switch is off (S3-1), or the lookup failed (fail closed);
 *   hide_owner_hidden  S3-2: shown, minus the rows the owner hid.
 * One lookup; outside the gate no DB read for it.
 */
export type AffiliationsPageMode = "as_before" | "none" | "hide_owner_hidden";

export function affiliationsPageMode(agentId: string, opts: EnforceOptions = {}): AffiliationsPageMode {
  const env = opts.env ?? process.env;
  const ids = agentId ? gatedSubjectIds([agentId], env, opts.db) : [];
  if (ids.length === 0) return "as_before";
  if (switchOffIds(ids, AFFILIATIONS_KEY, env, opts.db).has(agentId)) return "none";
  return affiliationsKeyLive(env) ? "hide_owner_hidden" : "as_before";
}

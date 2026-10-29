// ─── «Mine valg» — the owner's choices on public surfaces (S2c-1) ───────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2c-1: server-side
// enforcement of contact.phone, contact.address, products.show_prices and
// stats.public_counts / public_search_terms / public_trust on the surfaces
// each declares in the registry (`surfaces`).
//
// Gate: OWNER_FEATURES_ENFORCE ("1"/"true") AND the subject is in
// OWNER_FEATURES_ALLOWED_SUBJECTS. Otherwise the lookup returns nothing
// without touching the DB, and every surface renders exactly as before.
// Values come from the resolver (./resolve.ts), so a key that is still
// `coming_soon` keeps its default (shown) — only an admin lock or the status
// flip after the S2d switch probe makes a choice take effect.
//
// List surfaces resolve all their allowlisted subjects with one query
// (resolveOwnerFeatureKeysForSubjects). A failed lookup for an allowlisted
// subject hides the enforced fields (fail closed) and logs.

import { ownerFeaturesAllowedSubjects } from "./allowlist";
import { resolveOwnerFeatureKeysForSubjects, type ResolvedOwnerFeature } from "./resolve";
import type { OwnerFeatureEntry, OwnerFeatureKey } from "./registry";
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
  const allowed = new Set(ownerFeaturesAllowedSubjects(env));
  if (allowed.size === 0) return out;
  const ids = [...new Set(agentIds)].filter((id) => typeof id === "string" && allowed.has(`rfb:${id}`));
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
  const out = new Set<string>();
  if (!ownerFeaturesEnforceOn(env)) return out;
  const allowed = new Set(ownerFeaturesAllowedSubjects(env));
  if (allowed.size === 0) return out;
  const ids = [...new Set(agentIds)].filter((id) => typeof id === "string" && allowed.has(`rfb:${id}`));
  if (ids.length === 0) return out;
  try {
    const resolved = resolveOwnerFeatureKeysForSubjects("rfb", ids, ["auto.debio"], {
      db: opts.db, env, registry: registryOverride ?? undefined,
    });
    for (const [id, byKey] of resolved) if (byKey["auto.debio"]?.value === false) out.add(id);
  } catch (err) {
    console.error("[owner-features] auto.debio lookup failed, treating the switch as off:", err);
    for (const id of ids) out.add(id);
  }
  return out;
}

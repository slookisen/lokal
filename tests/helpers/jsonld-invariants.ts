/**
 * Shared JSON-LD invariants for page tests on all three sites (RFB,
 * Opplevagent, dental).
 *
 * dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
 * (S1): forbiddenNodes() is new; offersWithoutPrice() moved here from
 * src/routes/rfb-makesoffer-price-optional.test.ts (dev-request
 * 2026-09-29-gsc-strukturerte-data-og-5xx) so every site checks the same walk.
 *
 * Deliberately independent of src/services/structured-data-policy.ts: these
 * look at what a page actually rendered, not at the module's idea of it.
 */

/**
 * Every <script type="application/ld+json"> block on a page, parsed. Throws on
 * a block that does not parse, so a broken block cannot pass an invariant by
 * being invisible to it.
 */
export function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m, i) => {
    try {
      return JSON.parse(m[1]);
    } catch (err) {
      throw new Error(`jsonLdBlocks: ld+json block #${i} does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

/** Permanent invariant: no Offer without a numeric price > 0, anywhere. Returns the count. */
export function offersWithoutPrice(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + offersWithoutPrice(x), 0);
  if (!node || typeof node !== "object") return 0;
  const obj = node as Record<string, unknown>;
  let bad = typesOf(obj).includes("Offer") && !(typeof obj.price === "number" && obj.price > 0) ? 1 : 0;
  for (const v of Object.values(obj)) bad += offersWithoutPrice(v);
  return bad;
}

// Third-party ratings/reviews (Google's review-snippet guidelines: only
// ratings the site collects itself; none of the three sites has such a flow),
// and return/shipping terms, which no producer or provider has stated (no
// policy data exists on any site).
const FORBIDDEN_KEYS = new Set(["aggregateRating", "review", "reviews", "hasMerchantReturnPolicy", "shippingDetails"]);
const FORBIDDEN_TYPES = new Set(["AggregateRating", "Review", "MerchantReturnPolicy", "OfferShippingDetails"]);

/**
 * JSON paths ("$[0].makesOffer[0].itemOffered.aggregateRating") of every
 * forbidden node: by key anywhere, and by @type under any other key. A hit is
 * not walked into, so one node is reported once. [] when clean.
 */
export function forbiddenNodes(ld: unknown): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typesOf(obj).some((t) => FORBIDDEN_TYPES.has(t))) {
      hits.push(path);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.has(k)) hits.push(`${path}.${k}`);
      else walk(v, `${path}.${k}`);
    }
  };
  walk(ld, "$");
  return hits;
}

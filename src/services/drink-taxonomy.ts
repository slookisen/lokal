// ─── Shared drink-venue taxonomy ────────────────────────────────────────
//
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok
// (slookisen/A2A), Fase 5a: «Enhetlig `drikke`-taksonomi på tvers:
// `bryggeri`, `cideri`, `vingård`, `destilleri`, `gårdskafé`, `mjød`.»
//
// Before this module, "drink venue" existed as THREE separate, narrower
// signals that had each grown independently and never spoke the same
// vocabulary:
//   - RFB's search-field parser (marketplace-registry.ts DRINK_KEYWORDS)
//     routes many drink words to the single flat category `beverages` —
//     it cannot say WHICH kind of drink venue a query meant.
//   - route-corridor-service.ts's DRINK_PRODUCER_TYPES is gårdssalg's own
//     producer_type vocabulary (bryggeri/cideri/sideri/vingård/vingard/
//     destilleri/mjøderi/mjoderi/seltzeri) — it has no `gårdskafé` member
//     and is a closed set of exact DB values, not a text classifier.
//   - route-corridor-service.ts's DRINK_CATEGORIES is RFB's own tag
//     vocabulary (beverages/beer/cider/sider/juice/coffee/drikke) — also
//     flat, no subcategory.
//
// None of those three is Daniel's six-value list, and none is shared code
// BOTH platforms' MCP tools/REST filters can point at for the specific
// question "which of the six is this?". This module is that missing,
// additive layer: a single canonical enum + a text/producer_type
// classifier, used by BOTH platforms without changing what the three
// existing constants above already do (they are untouched — regressing a
// tested, live-verified 2026-07-25 slice is explicitly out of scope here).
//
// Deliberately dependency-free (no imports from marketplace-registry.ts or
// route-corridor-service.ts, and nothing here imports either of those in
// return) so any layer — the parser, `/reise`, the REST API, an MCP tool
// schema, an admin coverage report — can import this module with zero risk
// of a circular import. This is the "single shared constant/enum module"
// the dev-request's Fase 5a calls for; route-intent.ts is the precedent for
// a small, dependency-free, cross-platform-shared service module.

/** Fase 5a's exact six-value taxonomy, in Daniel's own order. */
export const DRINK_SUBCATEGORIES = [
  "bryggeri",
  "cideri",
  "vingård",
  "destilleri",
  "gårdskafé",
  "mjød",
] as const;

export type DrinkSubcategory = (typeof DRINK_SUBCATEGORIES)[number];

export function isDrinkSubcategory(value: unknown): value is DrinkSubcategory {
  return typeof value === "string" && (DRINK_SUBCATEGORIES as readonly string[]).includes(value);
}

interface DrinkSubcategoryMeta {
  /** Norwegian display label. */
  labelNo: string;
  /** English display label, for the MCP/API surfaces agents read. */
  labelEn: string;
  /**
   * Text keywords that identify this subcategory in a free-text query or a
   * producer name/description. Matched with a Norwegian-aware word
   * boundary (see wordBoundary() below) — NOT a bare substring test, so
   * short tokens like `vin` do not fire inside unrelated words (`kvinne`).
   */
  keywords: readonly string[];
  /**
   * Exact gårdssalg `producer_type` column values (experience_providers)
   * that belong to this subcategory. Lower-case, matches
   * route-corridor-service.ts's DRINK_PRODUCER_TYPES member spellings so a
   * producer_type lookup here agrees with isGardssalgDrinkType() there.
   */
  producerTypes: readonly string[];
}

export const DRINK_SUBCATEGORY_META: Readonly<Record<DrinkSubcategory, DrinkSubcategoryMeta>> = {
  bryggeri: {
    labelNo: "Bryggeri",
    labelEn: "Brewery",
    keywords: [
      "bryggeri", "bryggeriet", "mikrobryggeri", "håndverksbryggeri",
      "ølbryggeri", "bryggerhus", "øl", "ale", "pils", "håndverksøl", "brygg",
    ],
    producerTypes: ["bryggeri"],
  },
  cideri: {
    labelNo: "Cideri",
    labelEn: "Cidery",
    keywords: ["cideri", "sideri", "sider", "cider", "eplesider"],
    producerTypes: ["cideri", "sideri"],
  },
  vingård: {
    labelNo: "Vingård",
    labelEn: "Winery",
    keywords: ["vingård", "vingard", "vinprodusent", "vinproduksjon", "musserende", "vin"],
    producerTypes: ["vingård", "vingard"],
  },
  destilleri: {
    labelNo: "Destilleri",
    labelEn: "Distillery",
    keywords: ["destilleri", "brenneri", "gårdsbrenneri", "gardsbrenneri", "akevitt", "gin", "whisky"],
    producerTypes: ["destilleri"],
  },
  gårdskafé: {
    labelNo: "Gårdskafé",
    labelEn: "Farm café",
    // Deliberately only the compound forms — a bare "kafé"/"kafe" is a
    // false-positive trap (matches any café mentioned nearby, not a farm
    // one), the same false-positive class salgskanal-matcher.ts's own
    // gardskafe-servering matcher already guards against.
    keywords: ["gårdskafé", "gårdskafe", "gardskafé", "gardskafe"],
    producerTypes: ["gårdskafé", "gardskafe"],
  },
  mjød: {
    labelNo: "Mjød",
    labelEn: "Mead",
    keywords: ["mjød", "mjøderi", "mjod", "mjoderi"],
    producerTypes: ["mjøderi", "mjoderi"],
  },
};

/**
 * Terms that mark a query/description as drink-related WITHOUT pointing at
 * one specific subcategory (e.g. the umbrella words themselves, or
 * one-off/ambiguous drink words that are real signal for "some drink venue"
 * but not for any one of the six). Kept separate from the per-subcategory
 * keyword lists above so `classifyDrinkSubcategory` never has to guess.
 */
export const GENERIC_DRINK_TERMS = [
  "drikke", "drikkevarer", "drikkested", "drikkesteder", "beverages", "drinks",
  "most", "eplemost", "saft", "juice", "eplejuice",
  "kombucha", "seltzer", "seltzeri",
  "kaffe", "kaffebrenneri",
] as const;

// Mirrors marketplace-registry.ts's norwegianWordBoundary() — duplicated
// rather than imported, see the module comment above on why this file
// stays dependency-free. JS's \b is ASCII-only ([A-Za-z0-9_]); without this,
// every keyword beginning with æ/ø/å here (øl, øl-, mjød, …) would be dead
// code, exactly as documented at the original site.
const NORWEGIAN_WORD_CHAR = "0-9A-Za-zÀ-ÖØ-öø-ÿ_";
function wordBoundaryTest(term: string, haystack: string): boolean {
  const re = new RegExp(
    `(?<![${NORWEGIAN_WORD_CHAR}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![${NORWEGIAN_WORD_CHAR}])`,
    "i",
  );
  return re.test(haystack);
}

/**
 * Classify free text (a search query, or a producer name + description) into
 * one of the six canonical subcategories. Returns the FIRST subcategory (in
 * DRINK_SUBCATEGORIES order) whose keyword list matches; a query is very
 * rarely about two drink subcategories at once, and a stable, documented tie
 * rule beats an arbitrary one.
 *
 * Returns null when no subcategory-specific keyword matches — including when
 * only a GENERIC_DRINK_TERMS word matched (see isGenericDrinkText below for
 * that case): "drikkesteder" alone means "some drink venue", not any
 * specific one of the six, and this function must not guess.
 */
export function classifyDrinkSubcategoryFromText(text: string | null | undefined): DrinkSubcategory | null {
  const haystack = String(text || "");
  if (!haystack.trim()) return null;
  for (const sub of DRINK_SUBCATEGORIES) {
    const { keywords } = DRINK_SUBCATEGORY_META[sub];
    if (keywords.some((kw) => wordBoundaryTest(kw, haystack))) return sub;
  }
  return null;
}

/**
 * True when the text carries ANY drink signal — subcategory-specific or the
 * generic umbrella words ("drikkesteder", "beverages", …). Used to detect
 * "the user is asking about drink venues in general" separately from "which
 * exact one".
 */
export function isGenericDrinkText(text: string | null | undefined): boolean {
  const haystack = String(text || "");
  if (!haystack.trim()) return false;
  if (classifyDrinkSubcategoryFromText(haystack)) return true;
  return GENERIC_DRINK_TERMS.some((kw) => wordBoundaryTest(kw, haystack));
}

/**
 * Classify a gårdssalg `experience_providers.producer_type` value into one
 * of the six canonical subcategories. Case-insensitive exact match against
 * each subcategory's known producer_type spellings (both the with- and
 * without-diacritic forms the DB actually carries, e.g. `vingård`/`vingard`).
 * Returns null for a non-drink or unrecognised producer_type — callers that
 * need the existing "unknown producer_type counts as drink" business rule
 * keep using isGardssalgDrinkType() (route-corridor-service.ts) for that;
 * this function answers a narrower, stricter question (which one, exactly)
 * and is not a replacement for that rule.
 */
export function classifyDrinkSubcategoryFromProducerType(
  producerType: string | null | undefined,
): DrinkSubcategory | null {
  const t = String(producerType || "").trim().toLowerCase();
  if (!t) return null;
  for (const sub of DRINK_SUBCATEGORIES) {
    if (DRINK_SUBCATEGORY_META[sub].producerTypes.includes(t)) return sub;
  }
  return null;
}

/** All producer_type values (lower-case) the six subcategories recognise, flattened — for MCP/enum docs and admin reports. */
export function allDrinkProducerTypes(): string[] {
  return DRINK_SUBCATEGORIES.flatMap((sub) => DRINK_SUBCATEGORY_META[sub].producerTypes as unknown as string[]);
}

/**
 * OpplevAgent's `discover_gardssalg` MCP tool (experiences-mcp.ts) calls this
 * to resolve its `producer_type` input into what it hands
 * GardssalgSearchFilter.producer_type: when the caller passed one of the six
 * canonical spellings (e.g. the spec's own "mjød"), expand it to every known
 * DB spelling of that type (`experience_providers.producer_type` is an EXACT
 * match column and carries alias spellings like 'mjøderi'/'mjoderi' — an
 * exact filter on "mjød" alone would otherwise match zero rows, even though
 * meaderies exist in the data). Any other value (a non-canonical gårdssalg
 * type like "gardsbutikk", or a DB spelling typed directly, e.g. "mjøderi")
 * passes through unchanged.
 */
export function resolveGardssalgProducerTypeFilter(input: string): string | string[] {
  return isDrinkSubcategory(input) ? [...DRINK_SUBCATEGORY_META[input].producerTypes] : input;
}

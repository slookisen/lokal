// ─── RFB produkt×sted landing pages: /mat/<kategori>/<sted> ─────────────────
// dev-request 2026-09-24-ai-sok-bli-svaret-rfb, slice B6.
//
// The Opplevagent pattern (experience-indexability.ts isProduktByCellIndexable()
// + /kategori/:category/:kommune in experiences-seo.ts) ported to the RFB
// catalogue: ONE gate decides both whether the route answers 200 and whether
// the URL is in sitemap.xml, so a listed URL is always a served page and a
// thin combination is never listed. On RFB `/kategori/<slug>` already means a
// sales channel (salgskanal), hence the `/mat/` prefix.
//
//   - <kategori> is one of the product categories the platform stores in
//     agents.categories (PRODUCT_CATEGORY_KEYWORDS' keys in
//     marketplace-registry.ts / PLATFORM_CATEGORIES in search-enrich.ts, plus
//     «berries», which 27 producers carry). There is no separate cheese
//     category: cheese producers carry «dairy», so the page is /mat/meieri/…;
//     no alias maps «ost» onto it, because a dairy producer that sells milk
//     only is not a cheese producer.
//   - <sted> is a place-page slug: exactly the slugs seo.ts's
//     placeSlugsForCity() puts a producer on (its own city page and its fylke
//     page), so /<sted> is always a live place page with the same producers.
//   - The gate: a combination is served/listed iff it has at least
//     MAT_LANDING_MIN_PRODUCERS publicly visible producers. 2 is the same
//     default as Opplevagent's PRODUKT_BY_MIN_EXPERIENCES and the smallest
//     number for which «produsenter av X i Y» is a list rather than a single
//     producer page in disguise (the thin-content case E4-S1 measured).
//
// Pure: no DB, no I/O. The caller (seo.ts) supplies the visible agents and the
// place predicate, so the route and the sitemap share them too.
//
// Flag: RFB_MAT_LANDING_ENABLED ("true"/"1"), default off. Off = the route
// falls through to the normal 404 and the sitemap has no /mat/ entries, i.e.
// the same bytes as before this slice. Read per call (no restart needed for a
// test; in production it is a fly.toml [env] value like the other *_ENABLED
// flags).

export const RFB_MAT_LANDING_FLAG = "RFB_MAT_LANDING_ENABLED";

/** Is the /mat/<kategori>/<sted> page family switched on? Read per call. */
export function isRfbMatLandingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[RFB_MAT_LANDING_FLAG] || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Minimum number of publicly visible producers a combination needs. */
export const MAT_LANDING_MIN_PRODUCERS = 2;

/**
 * The gate the /mat route AND the sitemap read: true = serve with 200 and
 * list; false = 404 and not listed.
 */
export function isMatLandingComboIndexable(producerCount: number): boolean {
  return Number.isFinite(producerCount) && producerCount >= MAT_LANDING_MIN_PRODUCERS;
}

export interface MatCategory {
  /** The value stored in agents.categories. */
  key: string;
  /** URL slug (lowercase ASCII, slugify()-stable). */
  slug: string;
  /** Heading form, e.g. "Kjøtt". */
  label: string;
  /** In-sentence form, e.g. "kjøtt". */
  noun: string;
  /** «lokal(e/t) X» with the adjective in agreement: "lokalt kjøtt", "lokal fisk", "lokale grønnsaker". */
  localNoun: string;
}

/** The categories with a landing page, in display order. */
export const MAT_CATEGORIES: readonly MatCategory[] = [
  { key: "vegetables", slug: "gronnsaker", label: "Grønnsaker", noun: "grønnsaker", localNoun: "lokale grønnsaker" },
  { key: "fruit", slug: "frukt", label: "Frukt", noun: "frukt", localNoun: "lokal frukt" },
  { key: "berries", slug: "baer", label: "Bær", noun: "bær", localNoun: "lokale bær" },
  { key: "dairy", slug: "meieri", label: "Meieriprodukter", noun: "meieriprodukter", localNoun: "lokale meieriprodukter" },
  { key: "eggs", slug: "egg", label: "Egg", noun: "egg", localNoun: "lokale egg" },
  { key: "meat", slug: "kjott", label: "Kjøtt", noun: "kjøtt", localNoun: "lokalt kjøtt" },
  { key: "fish", slug: "fisk", label: "Fisk", noun: "fisk", localNoun: "lokal fisk" },
  { key: "bakery", slug: "bakeri", label: "Bakervarer", noun: "bakervarer", localNoun: "lokale bakervarer" },
  { key: "honey", slug: "honning", label: "Honning", noun: "honning", localNoun: "lokal honning" },
  { key: "herbs", slug: "urter", label: "Urter", noun: "urter", localNoun: "lokale urter" },
  { key: "beverages", slug: "drikke", label: "Drikke", noun: "drikke", localNoun: "lokal drikke" },
];

const BY_SLUG = new Map(MAT_CATEGORIES.map((c) => [c.slug, c]));
const BY_KEY = new Map(MAT_CATEGORIES.map((c) => [c.key, c]));

export function matCategoryBySlug(slug: string): MatCategory | undefined {
  return BY_SLUG.get(slug);
}

/** The landing-page categories a producer's `categories` value names (exact key, case-insensitive). */
export function matCategoriesOf(categories: unknown): MatCategory[] {
  if (!Array.isArray(categories)) return [];
  const out: MatCategory[] = [];
  const seen = new Set<string>();
  for (const c of categories) {
    if (typeof c !== "string") continue;
    const cat = BY_KEY.get(c.trim().toLowerCase());
    if (cat && !seen.has(cat.key)) {
      seen.add(cat.key);
      out.push(cat);
    }
  }
  return out;
}

export function matLandingPath(categorySlug: string, placeSlug: string): string {
  return `/mat/${categorySlug}/${placeSlug}`;
}

export interface MatLandingCombo<A> {
  category: MatCategory;
  placeSlug: string;
  /** In the order of the input list. */
  producers: A[];
}

/**
 * Every (category, place) combination the given producers fill, keyed by
 * matLandingPath(). One pass over the list: no per-combination query. With
 * `only`, just that one combination is collected (the route's case).
 */
export function collectMatLandingCombos<A>(
  agents: readonly A[],
  opts: {
    categoriesOf: (a: A) => unknown;
    placeSlugsOf: (a: A) => readonly string[];
    only?: { categorySlug: string; placeSlug: string };
  },
): Map<string, MatLandingCombo<A>> {
  const combos = new Map<string, MatLandingCombo<A>>();
  for (const a of agents) {
    const cats = matCategoriesOf(opts.categoriesOf(a));
    if (cats.length === 0) continue;
    const places = opts.placeSlugsOf(a);
    for (const cat of cats) {
      if (opts.only && cat.slug !== opts.only.categorySlug) continue;
      for (const place of places) {
        if (!place) continue;
        if (opts.only && place !== opts.only.placeSlug) continue;
        const key = matLandingPath(cat.slug, place);
        let combo = combos.get(key);
        if (!combo) {
          combo = { category: cat, placeSlug: place, producers: [] };
          combos.set(key, combo);
        }
        combo.producers.push(a);
      }
    }
  }
  return combos;
}

/** How many of a combination's producers sell through each pickup/delivery channel (agent_salgskanal). */
export interface MatLandingChannels {
  gardsbutikk: number;
  rekoRing: number;
  selvplukk: number;
  hjemlevering: number;
}

function names(list: readonly string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} og ${list[list.length - 1]}`;
}


/** "1 lokal produsent" / "3 lokale produsenter". */
function localProducers(n: number): string {
  return n === 1 ? "1 lokal produsent" : `${n} lokale produsenter`;
}

/**
 * Subject-first clauses, so the sentence keeps V2 word order whatever the
 * counts are: the first names the group («1 av dem har …», «2 av de 3
 * produsentene selger …»), the rest are «N <verb> …». Norwegian verbs do not
 * inflect for number, so 1 and >1 read the same. `group` is "dem" or e.g.
 * "de 3 produsentene".
 */
function channelClauses(items: Array<{ count: number; predicate: string }>, group: string): string {
  const clauses = items
    .filter((i) => i.count > 0)
    .map((i, idx) => (idx === 0 ? `${i.count} av ${group} ${i.predicate}` : `${i.count} ${i.predicate}`));
  return names(clauses);
}

function allChannelItems(ch: MatLandingChannels): Array<{ count: number; predicate: string }> {
  return [
    { count: ch.gardsbutikk, predicate: "har gårdsbutikk eller gårdsutsalg" },
    { count: ch.selvplukk, predicate: "har selvplukk" },
    { count: ch.rekoRing, predicate: "selger via REKO-ring" },
    { count: ch.hjemlevering, predicate: "leverer hjem" },
  ];
}

/**
 * Answer-first opening: product + place + how many producers + how to get the
 * goods, from real data only. null below the gate (never rendered then).
 */
export function buildMatLandingAnswerFirst(params: {
  category: MatCategory;
  placeName: string;
  producerNames: readonly string[];
  channels: MatLandingChannels;
}): string | null {
  const n = params.producerNames.length;
  if (!isMatLandingComboIndexable(n)) return null;
  const shown = params.producerNames.slice(0, 3);
  const rest = n - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} og ${rest} til` : names(shown);
  const ch = channelClauses(allChannelItems(params.channels), "dem");
  const howTo = ch ? ` ${ch}.` : "";
  return `${params.category.label} i ${params.placeName}: ${localProducers(n)} på Rett fra Bonden — ${list}.${howTo} Du handler direkte med produsenten; kontaktinformasjonen produsenten har gjort offentlig, står på profilsiden.`;
}

/**
 * FAQPage from real data only (counts, names, channel memberships). No prices,
 * opening hours or ratings. null below the gate.
 */
export function buildMatLandingFaqJsonLd(params: {
  category: MatCategory;
  placeName: string;
  url: string;
  producerNames: readonly string[];
  verifiedCount: number;
  channels: MatLandingChannels;
}): any | null {
  const n = params.producerNames.length;
  if (!isMatLandingComboIndexable(n)) return null;
  const noun = params.category.noun;
  const place = params.placeName;
  const shown = params.producerNames.slice(0, 5);
  const rest = n - shown.length;
  const qas: Array<{ q: string; a: string }> = [];

  qas.push({
    q: `Hvor kan jeg kjøpe ${params.category.localNoun} i ${place}?`,
    a: `Rett fra Bonden har ${localProducers(n)} av ${noun} i ${place}: ${rest > 0 ? `${shown.join(", ")} og ${rest} til` : names(shown)}.`,
  });

  // Pickup at the farm: farm shop and self-picking only. REKO-ring pickup is
  // at the ring's meeting point, not at the producer, so it has its own question.
  const atFarm = channelClauses([
    { count: params.channels.gardsbutikk, predicate: "har gårdsbutikk eller gårdsutsalg" },
    { count: params.channels.selvplukk, predicate: "har selvplukk" },
  ], `de ${n} produsentene`);
  if (atFarm) {
    qas.push({
      q: `Kan jeg hente ${noun} selv hos produsenten i ${place}?`,
      a: `${atFarm}. Se profilsiden til hver produsent for adresse og hvordan du handler.`,
    });
  }
  if (params.channels.rekoRing > 0) {
    qas.push({
      q: `Kan jeg kjøpe ${noun} via REKO-ring i ${place}?`,
      a: `${params.channels.rekoRing} av de ${n} produsentene selger via REKO-ring, med fast henteordning på ringens utleveringssted. Bestilling og henting avtaler du med produsenten.`,
    });
  }
  if (params.channels.hjemlevering > 0) {
    qas.push({
      q: `Kan jeg få ${noun} levert hjem i ${place}?`,
      a: `${params.channels.hjemlevering} av de ${n} produsentene oppgir hjemlevering. Avtal levering direkte med produsenten.`,
    });
  }

  qas.push({
    q: `Hvordan kontakter jeg produsentene av ${noun} i ${place}?`,
    a: `Hver produsent har en profilside på Rett fra Bonden med kontaktinformasjonen produsenten har gjort offentlig. Du handler direkte med produsenten, uten mellomledd.`,
  });

  if (params.verifiedCount > 0) {
    qas.push({
      q: `Er produsentene av ${noun} i ${place} verifisert?`,
      a: `${params.verifiedCount} av de ${n} produsentene er verifisert av eier.`,
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${params.url}#faq`,
    "mainEntity": qas.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a },
    })),
  };
}

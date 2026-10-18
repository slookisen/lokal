// ─── Dental search vocabulary (dev-request 2026-10-16-tannlege-sok-naturlig-sprak, S1)
//
// The word lists dental-query-parser.ts reads, kept as data so the parser
// itself holds no dental words. Another vertical can define its own object
// of the same shape (SearchVocabulary) and reuse the shared primitives in
// src/services/search-intent/norwegian-query.ts.
//
// All words are lower case and in the form tokenize() produces (hyphens split
// words: "helfo-avtale" is the tokens "helfo", "avtale"). Specialty synonyms
// match a whole token sequence where the LAST word may continue
// ("kjeveortoped" also matches "kjeveortopeden"). Triggers and stopwords
// match whole tokens only, so each inflected trigger form is listed: a
// clinic name such as "Akuttklinikken" or "Helfotannlegen" stays a name word.

export interface SearchSpecialty {
  /** Stored specialty name; mirrors SPECIALTY_PAGES[].navn in routes/dental-seo.ts (checked by a test). */
  canonical: string;
  /** Mirrors SPECIALTY_PAGES[].slug. */
  slug: string;
  /** Words and phrases (Norwegian and English) a person uses for it. */
  synonyms: readonly string[];
  /**
   * Lower-case stems the store also matches inside specialists[].title, the
   * free-text title deep-scrape stores ("Kjeveortoped", "Spesialist i
   * endodonti"). Kept short on purpose: "oralkirurg" also matches a title
   * like "Oralkirurg og kjevekirurg" (that clinic does oral surgery).
   */
  title_stems: readonly string[];
}

export interface SearchVocabulary {
  /** Whole tokens dropped before name matching; never a place on their own. */
  stopwords: ReadonlySet<string>;
  specialties: readonly SearchSpecialty[];
  /** Emergency-duty triggers -> acute filter (whole tokens). */
  akutt: readonly string[];
  /** Helfo direct-billing triggers -> helfo filter (whole tokens). */
  helfo: readonly string[];
  /** A trigger right after one of these is not applied ("uten helfo"). */
  negations: ReadonlySet<string>;
  /**
   * Right after a place, one of these names it as the kommune ("Kvam
   * kommune"), so a poststed of that name in another kommune also covers the
   * kommune. Whole tokens; each is a stopword too.
   */
  kommuneWords: ReadonlySet<string>;
}

export const DENTAL_SEARCH_VOCABULARY: SearchVocabulary = {
  stopwords: new Set([
    // the subject itself
    "tannlege", "tannleger", "tannlegen", "tannlegene", "tannlegekontor", "tannklinikk", "tannklinikker",
    "tannklinikken", "klinikk", "klinikker", "klinikken", "dentist", "dentists", "dental", "clinic", "clinics",
    // verbs and request words
    "finn", "finne", "søk", "søker", "vis", "trenger", "vil", "ønsker", "leter", "anbefal", "anbefalt",
    "find", "search", "show", "need", "want", "looking", "recommend", "recommended", "list",
    // function words
    "i", "in", "på", "at", "ved", "nær", "near", "nearby", "rundt", "around", "med", "with", "uten",
    "for", "til", "to", "fra", "from", "og", "and", "eller", "or", "en", "et", "ei", "a", "an", "the",
    "som", "who", "that", "har", "has", "have", "kan", "can", "jeg", "meg", "min", "mitt", "me", "my",
    "of", "av", "etter", "hvor", "where", "hva", "what", "hvilke", "hvilken", "which", "ikke", "not", "no",
    "nærmeste", "nearest", "close", "beste", "best", "god", "gode", "good",
    "hos", "as", "by", "byen", "city", "kommune", "kommunen", "municipality", "fylke", "fylket", "county",
    "er", "is", "are", "det", "den", "de", "it", "this", "there", "noen", "some", "any", "on", "do", "does",
    "tar", "imot", "take", "takes", "accept", "accepts", "accepting", "ny", "nye", "new", "please",
    "åpen", "åpent", "åpne", "open", "pasient", "pasienter", "patient", "patients", "hjelp", "help",
    "sentrum", "downtown", "du", "dere", "vi", "oss", "you", "your", "we", "us", "our", "could", "would",
    "will", "get", "give", "tell", "about", "om", "gi", "kunne", "available", "ledig", "ledige",
    "appointment", "appointments", "book", "booking", "bestille",
    // who it is for: most clinics treat children ("barnetannlege" is the specialty pedodonti)
    "barn", "barna", "children", "child", "kids", "kid", "voksne", "adults", "familie", "family",
    // words that read like places but are not meant as one here ("en time", Time kommune)
    "time", "timer", "dag", "today", "idag", "nå", "now", "avtale", "agreement", "område", "area",
  ]),
  specialties: [
    {
      canonical: "kjeveortopedi",
      slug: "kjeveortopedi",
      synonyms: ["kjeveortopedi", "kjeveortoped", "tannregulering", "regulering", "tannbøyle", "orthodontist",
        "orthodontics", "orthodontic", "braces"],
      title_stems: ["kjeveortoped"],
    },
    {
      canonical: "oral kirurgi og oral medisin",
      slug: "oral-kirurgi-og-oral-medisin",
      synonyms: ["oral kirurgi og oral medisin", "oral kirurgi", "oral kirurg", "oral medisin", "oralkirurg", "oralkirurgi",
        "oral surgeon", "oral surgery"],
      title_stems: ["oralkirurg"],
    },
    {
      canonical: "periodonti",
      slug: "periodonti",
      synonyms: ["periodonti", "periodontist", "tannkjøtt", "periodontics", "gum disease"],
      title_stems: ["periodont"],
    },
    {
      canonical: "endodonti",
      slug: "endodonti",
      synonyms: ["endodonti", "endodontist", "rotbehandling", "rotfylling", "endodontics", "root canal"],
      title_stems: ["endodont"],
    },
    {
      canonical: "pedodonti",
      slug: "pedodonti",
      synonyms: ["pedodonti", "pedodontist", "barnetannlege", "barnetannpleie", "pediatric dentist",
        "paediatric dentist", "children's dentist", "kids dentist"],
      title_stems: ["pedodont"],
    },
    {
      canonical: "oral protetikk",
      slug: "oral-protetikk",
      synonyms: ["oral protetikk", "protetikk", "protetiker", "prosthodontist", "prosthodontics"],
      title_stems: ["protetik"],
    },
    {
      canonical: "kjeve- og ansiktsradiologi",
      slug: "kjeve-og-ansiktsradiologi",
      synonyms: ["kjeve- og ansiktsradiologi", "ansiktsradiologi", "kjeveradiologi", "radiolog", "radiologi",
        "dental radiology", "radiologist"],
      title_stems: ["radiolog"],
    },
  ],
  akutt: ["akutt", "akuttvakt", "akuttvakta", "akuttvakten", "akutthjelp", "akuttime", "akuttimer",
    "akuttbehandling", "akuttpasient", "akuttpasienter", "tannlegevakt", "tannlegevakta", "tannlegevakten",
    "tannvakt", "emergency", "urgent", "øyeblikkelig hjelp"],
  helfo: ["helfo", "helfoavtale", "helfoavtalen", "direkteoppgjør", "direkteoppgjor", "direct billing"],
  negations: new Set(["uten", "ikke", "without", "not", "no"]),
  kommuneWords: new Set(["kommune", "kommunen", "municipality"]),
};

/**
 * The vocabulary entry for a whole specialty value: the stored name, its
 * slug or one of its synonyms ("kjeveortoped", "Orthodontist"), ignoring
 * case, spaces and hyphens. null when none matches.
 */
export function findSearchSpecialty(
  value: string,
  vocabulary: SearchVocabulary = DENTAL_SEARCH_VOCABULARY
): SearchSpecialty | null {
  const key = (s: string) => String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
  const v = key(value);
  if (!v) return null;
  return vocabulary.specialties.find((s) => [s.canonical, s.slug, ...s.synonyms].some((w) => key(w) === v)) ?? null;
}

/**
 * The lower-case words the specialty filter looks for inside
 * specialists[].title (dental-store specialtyMatch): each name as given plus
 * the entry's title stems. A word that contains another one in the list is
 * left out: "kjeveortoped" already matches every title "kjeveortopedi" does.
 * The clinic cards read titles with the same words (clinicSpecialties).
 */
export function specialtyTitleWords(names: readonly string[], entry: SearchSpecialty | null): string[] {
  const words = [...new Set([...names.map((n) => n.toLowerCase()), ...(entry?.title_stems ?? [])])];
  return words.filter((w) => !words.some((other) => other !== w && w.includes(other)));
}

/** What clinicSpecialties reads from a clinic row (a DentalAgent has both). */
export interface ClinicSpecialtySource {
  available_specialties?: readonly string[] | null;
  specialists?: ReadonlyArray<{ specialty?: string | null; title?: string | null } | null> | null;
}

/**
 * The specialties a clinic is shown with: the MCP/A2A card's spesialiteter
 * and «Spesialist» badge, and the chips on the web card (dev-request
 * 2026-10-17-dental-d3-rettelser, D3d). They are what the specialty filter
 * finds the clinic by, in this order and without duplicates (ignoring case):
 * available_specialties, then specialists[].specialty, then every vocabulary
 * specialty whose title words (specialtyTitleWords, as the filter reads
 * them) occur in a specialists[].title. A title such as "Tannlege" or
 * "Spesialist" adds nothing. Kept here, next to the words, so the store, the
 * card and the web pages read titles the same way without importing each
 * other.
 */
export function clinicSpecialties(
  clinic: ClinicSpecialtySource,
  vocabulary: SearchVocabulary = DENTAL_SEARCH_VOCABULARY
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push(name);
  };
  for (const name of clinic.available_specialties ?? []) add(name);
  const specialists = Array.isArray(clinic.specialists) ? clinic.specialists : [];
  for (const person of specialists) add(person?.specialty);
  const titles = specialists.flatMap((person) => (typeof person?.title === "string" ? [person.title.toLowerCase()] : []));
  if (titles.length === 0) return out;
  for (const { canonical, words } of titleWordsOf(vocabulary)) {
    if (titles.some((title) => words.some((w) => title.includes(w)))) add(canonical);
  }
  return out;
}

// Each vocabulary specialty's title words (specialtyTitleWords of its
// canonical name), worked out once per vocabulary object: clinicSpecialties
// runs per clinic card and, for the /sted and /fylke specialist count
// (dental-area-facts.ts, F1-S3), per row with a staff list.
const titleWordsByVocabulary = new WeakMap<SearchVocabulary, ReadonlyArray<{ canonical: string; words: string[] }>>();
function titleWordsOf(vocabulary: SearchVocabulary): ReadonlyArray<{ canonical: string; words: string[] }> {
  let list = titleWordsByVocabulary.get(vocabulary);
  if (!list) {
    list = vocabulary.specialties.map((entry) => ({ canonical: entry.canonical, words: specialtyTitleWords([entry.canonical], entry) }));
    titleWordsByVocabulary.set(vocabulary, list);
  }
  return list;
}

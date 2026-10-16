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

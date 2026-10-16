// ─── Experience page facts: «Kort fortalt», the facts table, fallback meta ───
// dev-request 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E2-S1.
//
// Every /opplevelse/<slug> page should answer first: what it is, where, what
// it costs and how it is booked, before any prose. And the ~145 pages without
// a description all shared one generic meta description («<tittel> i <sted>.
// <kategori> på Opplevagent — håndplukkede norske opplevelser …»), so Google
// saw near-identical snippets.
//
// One fact list, built here from the row's own fields, now feeds three things
// that used to be (or would otherwise be) built separately:
//   - the «Kort fortalt» box (KORT_FORTALT_FACT_KEYS) over the lede,
//   - the facts table (TABLE_FACT_KEYS — exactly the rows it had before),
//   - the meta / JSON-LD description of a page without a real description
//     (buildExperienceFactSentence()).
// They read the same label and value for the same fact, so they cannot drift.
//
// Rules:
//   - Only fields that are set. No LLM, no free text beyond the row's own
//     values; every number in the output is one of the row's numbers.
//   - per_adult: the price is the adult price, never «fra» (the lowest price
//     for all ages) — same rule as the list cards and the MCP instructions.
//   - Words come in, already in the page's UI language (`words`, built by
//     experiences-seo.ts from oaProfileLabels(uiLang) and its value labels).
//     Never pass labels for req.lang: with the language switcher off an /en
//     page is lang="nb" and must not show «per adult» (lokal#1092 review, S1).
//
// Pure: no DB, no env, no I/O.

import type { Experience } from "./experience-store";
import type { Lang } from "../i18n/t";

/** Same cap the detail page puts on its meta description. */
export const META_DESCRIPTION_MAX_LENGTH = 155;

export type ExperienceFactKey =
  | "category" | "place" | "fylke" | "kommune" | "indoor" | "season" | "duration" | "group" | "age"
  | "price" | "languages" | "accessibility" | "meeting" | "booking" | "provider";

export interface ExperienceFact {
  key: ExperienceFactKey;
  label: string;
  /** Plain text; the caller escapes it. */
  value: string;
  /** Same-site page for the value (category, fylke, kommune, tilbyder). */
  href?: string;
  /**
   * The value only says the field is unknown («Pris ikke oppgitt»). Shown in
   * the table and the box as before, but no fact for the sentence.
   */
  unknown?: true;
}

/** The facts table's rows, in its order (unchanged by E2-S1). */
export const TABLE_FACT_KEYS: readonly ExperienceFactKey[] = [
  "category", "fylke", "kommune", "indoor", "season", "duration", "group", "price", "languages", "accessibility", "meeting",
];
/** The «Kort fortalt» box: what, where, price, length, when, who, how to book, by whom. */
export const KORT_FORTALT_FACT_KEYS: readonly ExperienceFactKey[] = [
  "category", "place", "price", "duration", "season", "group", "age", "booking", "provider",
];
/** Facts the sentence adds after its «<tittel> – <kategori> i <sted>.» head, by priority. */
const SENTENCE_FACT_KEYS: readonly ExperienceFactKey[] = ["price", "duration", "season", "group", "age", "booking", "provider"];

type AgeSuitability = NonNullable<Experience["age_suitability"]>;
type BookingType = NonNullable<Experience["booking_type"]>;

/** Labels and value words, all in the page's UI language. */
export interface ExperienceFactWords {
  fCategory: string; fPlace: string; fFylke: string; fKommune: string; fIndoor: string; fSeason: string;
  fDuration: string; fGroup: string; fAge: string; fPrice: string; fLanguages: string; fAccess: string;
  fMeeting: string; fBooking: string; fProvider: string;
  approx: string; min: string; persons: string; upTo: string; from: string; kr: string;
  /** Leading space included, e.g. " pr. person". */
  perPerson: string; perGroup: string; perAdult: string;
  ageFrom: (minAge: number) => string;
  ageSuitability: Record<AgeSuitability, string>;
  bookingType: Record<BookingType, string>;
  brregVerified: string;
  /** «i» in «… i Strand, Rogaland». */
  inPlace: string;
  catLabel: (category: string) => string;
  seasonLabel: (season: string) => string;
  ioLabel: (indoorOutdoor: string) => string;
  priceBandLabel: (band: string) => string;
}

export type ExperienceFactsInput = Pick<
  Experience,
  | "category" | "kommune" | "fylke" | "indoor_outdoor" | "season" | "duration_min" | "duration_max"
  | "group_min" | "group_max" | "min_age" | "age_suitability" | "price_from" | "price_band" | "price_unit"
  | "languages" | "accessibility" | "meeting_point" | "booking_type" | "booking_url"
>;

/** Same http(s)-only rule as safeHttpUrl() in experiences-seo.ts. */
function isHttpUrl(u: unknown): boolean {
  return /^https?:\/\//i.test(String(u ?? "").trim());
}

/**
 * Every fact the row supports, each once. `meeting_point` is the display
 * value (the caller swaps in a published translation when it has one).
 */
export function buildExperienceFacts(
  exp: ExperienceFactsInput,
  provider: Record<string, unknown> | null,
  words: ExperienceFactWords
): ExperienceFact[] {
  const W = words;
  const facts: ExperienceFact[] = [];
  const add = (key: ExperienceFactKey, label: string, value: string, extra: Partial<ExperienceFact> = {}): void => {
    facts.push({ key, label, value, ...extra });
  };
  const cat = exp.category || null;
  if (cat) add("category", W.fCategory, W.catLabel(cat), { href: `/kategori/${encodeURIComponent(cat)}` });
  const place = [exp.kommune, exp.fylke].filter(Boolean).join(", ");
  if (place) add("place", W.fPlace, place);
  if (exp.fylke) add("fylke", W.fFylke, exp.fylke, { href: `/fylke/${encodeURIComponent(exp.fylke)}` });
  if (exp.kommune) add("kommune", W.fKommune, exp.kommune, { href: `/kommune/${encodeURIComponent(exp.kommune)}` });
  if (exp.indoor_outdoor) add("indoor", W.fIndoor, W.ioLabel(exp.indoor_outdoor));
  if ((exp.season || []).length) add("season", W.fSeason, (exp.season || []).map(W.seasonLabel).join(", "));
  if (exp.duration_min || exp.duration_max) {
    add("duration", W.fDuration, exp.duration_min && exp.duration_max && exp.duration_min !== exp.duration_max
      ? `${exp.duration_min}–${exp.duration_max} ${W.min}`
      : `${W.approx} ${exp.duration_min || exp.duration_max} ${W.min}`);
  }
  if (exp.group_min || exp.group_max) {
    add("group", W.fGroup, exp.group_min && exp.group_max ? `${exp.group_min}–${exp.group_max} ${W.persons}`
      : exp.group_max ? `${W.upTo} ${exp.group_max} ${W.persons}` : `${W.from} ${exp.group_min} ${W.persons}`);
  }
  if (exp.min_age) add("age", W.fAge, W.ageFrom(exp.min_age));
  else if (exp.age_suitability && W.ageSuitability[exp.age_suitability]) add("age", W.fAge, W.ageSuitability[exp.age_suitability]);
  if (exp.price_from || exp.price_band) {
    const unit = exp.price_unit === "per_adult" ? W.perAdult
      : exp.price_unit === "per_person" ? W.perPerson : exp.price_unit === "per_group" ? W.perGroup : "";
    if (exp.price_from) {
      add("price", W.fPrice, `${exp.price_unit === "per_adult" ? "" : W.from + " "}${exp.price_from} ${W.kr}${unit}`);
    } else {
      // price_band 'ukjent' means "we do not know" — still shown, not a fact.
      add("price", W.fPrice, W.priceBandLabel(String(exp.price_band)), exp.price_band === "ukjent" ? { unknown: true } : {});
    }
  }
  if ((exp.languages || []).length) add("languages", W.fLanguages, (exp.languages || []).join(", "));
  if ((exp.accessibility || []).length) add("accessibility", W.fAccess, (exp.accessibility || []).join(", "));
  if (exp.meeting_point) add("meeting", W.fMeeting, exp.meeting_point);
  if (exp.booking_type && W.bookingType[exp.booking_type]) add("booking", W.fBooking, W.bookingType[exp.booking_type]);
  else if (isHttpUrl(exp.booking_url)) add("booking", W.fBooking, W.bookingType.external);
  const provName = provider ? String(provider.navn ?? "").trim() : "";
  if (provider && provName) {
    const verified = Number(provider.brreg_verified) === 1;
    add("provider", W.fProvider, verified ? `${provName} (${W.brregVerified})` : provName,
      { href: `/tilbyder/${encodeURIComponent(String(provider.slug || provider.id))}` });
  }
  return facts;
}

/** The facts for `keys`, in the order of `keys`. */
export function pickFacts(facts: readonly ExperienceFact[], keys: readonly ExperienceFactKey[]): ExperienceFact[] {
  const out: ExperienceFact[] = [];
  for (const key of keys) {
    const fact = facts.find((f) => f.key === key);
    if (fact) out.push(fact);
  }
  return out;
}

/**
 * Deterministic description for a page without one, from `facts` only:
 * «<tittel> – <kategori> i <sted>.» and then «<Etikett>: <verdi>.» per fact
 * in SENTENCE_FACT_KEYS order. A fact is added whole or not at all, so the
 * result fits `maxLength` without a cut-off number. The head itself is never
 * shortened (the caller's usual truncation covers an extreme title).
 */
export function buildExperienceFactSentence(
  title: string,
  facts: readonly ExperienceFact[],
  words: Pick<ExperienceFactWords, "inPlace">,
  maxLength: number = META_DESCRIPTION_MAX_LENGTH
): string {
  const category = facts.find((f) => f.key === "category");
  const place = facts.find((f) => f.key === "place");
  const head = title.trim().replace(/\.+$/, "");
  let sentence = `${head}${category ? ` – ${category.value.toLowerCase()}` : ""}${place ? ` ${words.inPlace} ${place.value}` : ""}.`;
  for (const fact of pickFacts(facts, SENTENCE_FACT_KEYS)) {
    if (fact.unknown) continue;
    const clause = `${fact.label}: ${fact.value}.`;
    if (sentence.length + 1 + clause.length <= maxLength) sentence += ` ${clause}`;
  }
  return sentence;
}

const MONTHS: Record<Lang, readonly string[]> = {
  no: ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  sv: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
};

/**
 * «Sist oppdatert» date from a row's updated_at (SQLite "YYYY-MM-DD HH:MM:SS"
 * or ISO): `iso` for <time datetime>, `text` like «16. oktober 2026». The
 * date part is read as written (UTC, like the sitemap's lastmod), so the page
 * and its sitemap entry show the same day. null for anything unparseable.
 */
export function formatFactDate(value: string | null | undefined, lang: Lang): { iso: string; text: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!m) return null;
  const year = m[1];
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const monthName = MONTHS[lang][month - 1];
  const text = lang === "no" ? `${day}. ${monthName} ${year}` : `${day} ${monthName} ${year}`;
  return { iso: `${m[1]}-${m[2]}-${m[3]}`, text };
}

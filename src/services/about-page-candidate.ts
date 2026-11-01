/**
 * about-page-candidate.ts — dev-request 2026-10-27-rfb-berikelse-om-oss-sider-
 * til-beskrivelse (RFB + gårdssalg).
 *
 * The producer description used to be built from the HOMEPAGE alone
 * (summarizeAbout(primaryHtml): og:description, else meta description, else
 * the first sentence, capped at 300 chars), even when the producer's own
 * «Om oss»/«Om gården»/«Historie»/«About» page had far more and better text.
 * This module holds the shared, deterministic (no LLM) part of using that
 * page instead:
 *
 *   - the ONE switch, ENRICHMENT_ABOUT_PAGE_ENABLED (default OFF): with it
 *     off, both enrichment paths behave exactly as before — same sub-pages
 *     fetched, same candidate, same response;
 *   - which fallback paths are about pages;
 *   - pickAboutPageCandidate: the about-page candidate (summarizeAboutPageProse)
 *     replaces the homepage one only when it clears the SAME guards the
 *     homepage candidate has (meetsAboutQualityBar, verbatim/close-paraphrase
 *     substantiation against the ABOUT page's own HTML and text, not a code
 *     artifact, not theme spam, the page itself not theme spam) AND is
 *     clearly more substantial than the homepage candidate.
 *
 * Callers (routes/admin-knowledge.ts refreshHomepageContent, routes/
 * opplevelser.ts runGardssalgContentRefresh) keep every lock and precedence
 * rule they already had; this module never decides whether a field may be
 * written.
 */

import {
  summarizeAboutPageProse,
  meetsAboutQualityBar,
  extractVisibleText,
  extractProseParagraphs,
  extractTitle,
  decodeHtmlEntities,
  pageLooksLikeThemeSpam,
  stripNorwegianAccents,
} from "./search-enrich";
import { checkAboutCandidateSubstantiatedBySource } from "./about-source-substantiation";
import { looksLikeCodeArtifact, looksLikeThemeSpam } from "./description-quality";

/** The env switch. Only the literal "1" or "true" enables; read at call time. */
export const ENRICHMENT_ABOUT_PAGE_FLAG = "ENRICHMENT_ABOUT_PAGE_ENABLED";

/** Only the literal "1" or "true" enables; anything else (incl. unset) is OFF. Read at call time. */
export function isEnrichmentAboutPageEnabled(): boolean {
  const v = process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
  return v === "1" || v === "true";
}

/**
 * How a refresh run came to use the about-page logic: the env flag (any run),
 * or a dry run's explicit `about_page_preview` (spec 6 — the preview Daniel
 * must see before anything is written). null = off, today's behaviour.
 * A preview request is honoured ONLY in a dry run.
 */
export type AboutPageMode = "env_flag" | "dry_run_preview";
export function resolveAboutPageMode(opts: { dryRun: boolean; previewRequested: boolean }): AboutPageMode | null {
  if (isEnrichmentAboutPageEnabled()) return "env_flag";
  if (opts.dryRun && opts.previewRequested) return "dry_run_preview";
  return null;
}

/** The body/query value a caller sends for `about_page_preview`: true / 1 / "1" / "true". */
export function aboutPagePreviewRequested(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * A fixed fallback path (HCR_CONTENT_PATHS, GARDSSALG_CONTENT_PATHS) that is
 * an about page — the same vocabulary as discoverContentLinks' about pattern,
 * plus the bare Norwegian «/om».
 */
const ABOUT_PATH_RE = /^\/(?:om|om-?oss|om-?garden|om-?gården|about|about-us|historie|historien|var-historie|vår-historie)\/?$/i;
export function isAboutFallbackPath(path: string): boolean {
  return ABOUT_PATH_RE.test(path);
}

/** The about-page candidate must be at least this many chars longer than the homepage candidate … */
export const ABOUT_PAGE_MIN_GAIN_CHARS = 60;
/** … and at least this many times as long. */
export const ABOUT_PAGE_MIN_GAIN_RATIO = 1.3;
/**
 * … and carry at least this many distinct content words (>= 4 letters) that
 * are not part of the producer's name — «more than name and place».
 */
export const ABOUT_PAGE_MIN_CONTENT_WORDS = 10;

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of stripNorwegianAccents(text.toLowerCase()).split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

/**
 * Spec 3, last condition: the about-page candidate is CLEARLY more
 * substantial than the homepage candidate — longer by at least
 * ABOUT_PAGE_MIN_GAIN_CHARS and ABOUT_PAGE_MIN_GAIN_RATIO, and not just the
 * producer's name plus a place (ABOUT_PAGE_MIN_CONTENT_WORDS content words
 * outside the name). PURE.
 */
export function aboutPageCandidateIsMoreSubstantial(
  aboutCandidate: string,
  homepageCandidate: string | null | undefined,
  producerName?: string | null,
): boolean {
  const about = aboutCandidate.replace(/\s+/g, " ").trim();
  const home = String(homepageCandidate ?? "").replace(/\s+/g, " ").trim();
  if (about.length < home.length + ABOUT_PAGE_MIN_GAIN_CHARS) return false;
  if (about.length < Math.ceil(home.length * ABOUT_PAGE_MIN_GAIN_RATIO)) return false;
  const nameWords = contentWords(producerName ?? "");
  let n = 0;
  for (const w of contentWords(about)) if (!nameWords.has(w)) n++;
  return n >= ABOUT_PAGE_MIN_CONTENT_WORDS;
}

// Words of a producer name that say what kind of business it is, not which
// one (folded: lower-case, æ/ø/å stripped). A name made only of these (and
// words shorter than 3 letters) has nothing to recognise the producer by.
const PRODUCER_NAME_GENERIC_WORDS: ReadonlySet<string> = new Set(
  [
    "as", "sa", "da", "ans", "enk", "nuf", "ba", "ltd",
    "og", "and", "the", "med", "fra", "til", "ved", "hos", "paa", "for",
    "gård", "gard", "gården", "garden", "gårds", "gards", "gårdene", "gardene",
    "gårdsmat", "gardsmat", "gårdsbruk", "gårdsbruket", "gårdsbutikk", "gårdsbutikken",
    "gårdsutsalg", "gårdsutsalget", "gårdsysteri", "gårdsbakeri", "gårdsmeieri",
    "bruk", "bruket", "farm", "farms", "mat", "matforedling", "foredling", "produkter",
    "bakeri", "bakeriet", "ysteri", "ysteriet", "meieri", "meieriet", "bryggeri", "bryggeriet",
    "bryggerhus", "brygghus", "sideri", "sideriet", "cideri", "ciderhus", "mosteri", "mosteriet",
    "brenneri", "brenneriet", "destilleri", "destilleriet", "vingård", "vingard",
    "gartneri", "gartneriet", "planteskole", "slakteri", "slakteriet", "pølsemakeri", "røkeri",
    "honning", "birøkt", "birøkteri", "økologisk", "kjøtt", "fisk", "sjømat", "bær", "frukt",
    "grønt", "grønnsaker", "butikk", "butikken", "utsalg", "handel", "kafe", "kafé", "cafe",
    "restaurant", "landhandel", "mølle", "mølla", "smie", "verksted",
  ].map((w) => stripNorwegianAccents(w.toLowerCase())),
);

/**
 * The words that identify THIS producer in its name (folded, >= 3 letters,
 * not PRODUCER_NAME_GENERIC_WORDS, not a number), from the part before a
 * place suffix («Tverås Gårdsmat — Gol», «… (Gol)»). PURE.
 */
export function producerNameTokens(name: string | null | undefined): string[] {
  const head = String(name ?? "").split(/\s+[—–-]\s+|\s*\(/)[0] ?? "";
  const out: string[] = [];
  for (const w of stripNorwegianAccents(head.toLowerCase()).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || /^\d+$/.test(w) || PRODUCER_NAME_GENERIC_WORDS.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * True when the about page is about THIS producer: one of its
 * producerNameTokens starts a word (compounds allowed: «Tveråsgarden») in the
 * candidate text, the page title (og:title / <title>) or its first <h1>.
 * A «Historie» page about the village, or a blog post, on the producer's own
 * host does not name the producer and fails. PURE.
 */
export function aboutPageNamesProducer(candidate: string, html: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "";
  const hay = stripNorwegianAccents(
    decodeHtmlEntities([candidate, extractTitle(html), title, h1].join(" ").replace(/<[^>]+>/g, " ")).toLowerCase(),
  );
  return tokens.some((t) => new RegExp(`(?:^|[^a-z0-9])${t}`).test(hay));
}

/** pickAboutPageCandidate's refusal when no about page was chosen because none named the producer. */
export const ABOUT_PAGE_NOT_ABOUT_PRODUCER = "about_page_not_about_producer";

/** Why one fetched about page did not become the candidate ("chosen" when it did). */
export type AboutPageVerdict =
  | "chosen"
  | "theme_spam_page"
  | "no_prose"
  | "below_quality_bar"
  | "not_substantiated"
  | "code_artifact"
  | "theme_spam"
  | "not_about_producer"
  | "not_more_substantial"
  | "not_evaluated";

export type AboutPageEvaluation = {
  url: string;
  candidate: string;
  verdict: AboutPageVerdict;
  /** not_substantiated only: checkAboutCandidateSubstantiatedBySource's reason. */
  detail?: string;
};

export type AboutPagePick = {
  /** The about page whose candidate replaces the homepage one; null = keep the homepage candidate. */
  chosen: { url: string; text: string } | null;
  /** Every fetched about page, in fetch order, with its verdict. */
  evaluated: AboutPageEvaluation[];
  /**
   * Why no about page was used, when that was a source/entity reason: the
   * caller's refusal, a homepage candidate that reads as spam, or a producer
   * name with no distinctive word (nothing considered at all); or
   * ABOUT_PAGE_NOT_ABOUT_PRODUCER when a fetched page was rejected for not
   * naming the producer and none was chosen.
   */
  refused?: string;
};

/**
 * Pick the about-page candidate, or keep the homepage one (spec 3). PURE.
 *
 * Each fetched about page, in order, until one is chosen:
 *   1. the page as a whole must not read as theme spam (pageLooksLikeThemeSpam);
 *   2. summarizeAboutPageProse(html) must yield text;
 *   3. meetsAboutQualityBar (the RFB homepage candidate's own bar: length,
 *      boilerplate, Norwegian, nav-menu leakage, umbrella «våre medlemmer»);
 *   4. checkAboutCandidateSubstantiatedBySource against THIS page's raw HTML
 *      plus its visible text (the homepage candidate's own source form);
 *   5. not looksLikeCodeArtifact, not looksLikeThemeSpam;
 *   6. the page is about THIS producer (aboutPageNamesProducer: a
 *      distinctive word of its name in the text, title or <h1>);
 *   7. aboutPageCandidateIsMoreSubstantial than the homepage candidate.
 * Pages after the chosen one are reported as not_evaluated.
 *
 * Nothing is considered when `refusal` is set (the caller's own source
 * refusal: directory/social host, wrong-entity website, …), when the
 * homepage candidate itself reads as theme spam (a domain that may be
 * hijacked is not a source for any page on it), or when the producer name
 * has no distinctive word to check step 6 with (fail closed).
 */
export function pickAboutPageCandidate(input: {
  homepageCandidate: string | null | undefined;
  aboutPages: ReadonlyArray<{ url: string; html: string }>;
  producerName?: string | null;
  refusal?: string | null;
}): AboutPagePick {
  const evaluated: AboutPageEvaluation[] = [];
  const nameTokens = producerNameTokens(input.producerName);
  const refused =
    input.refusal ??
    (looksLikeThemeSpam(input.homepageCandidate) ? "homepage candidate reads as theme spam" : null) ??
    (input.aboutPages.length > 0 && nameTokens.length === 0
      ? `${ABOUT_PAGE_NOT_ABOUT_PRODUCER} (no distinctive word in the producer name)`
      : null);
  if (refused) {
    for (const p of input.aboutPages) evaluated.push({ url: p.url, candidate: "", verdict: "not_evaluated" });
    return { chosen: null, evaluated, refused };
  }
  let chosen: { url: string; text: string } | null = null;
  for (const page of input.aboutPages) {
    if (chosen) {
      evaluated.push({ url: page.url, candidate: "", verdict: "not_evaluated" });
      continue;
    }
    if (pageLooksLikeThemeSpam(page.html)) {
      evaluated.push({ url: page.url, candidate: "", verdict: "theme_spam_page" });
      continue;
    }
    const text = summarizeAboutPageProse(page.html);
    if (!text) {
      evaluated.push({ url: page.url, candidate: "", verdict: "no_prose" });
      continue;
    }
    if (!meetsAboutQualityBar(text)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "below_quality_bar" });
      continue;
    }
    const sub = checkAboutCandidateSubstantiatedBySource(text, `${page.html}\n${extractVisibleText(page.html)}`);
    if (!sub.substantiated) {
      evaluated.push({ url: page.url, candidate: text, verdict: "not_substantiated", detail: sub.reason });
      continue;
    }
    if (looksLikeCodeArtifact(text)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "code_artifact" });
      continue;
    }
    if (looksLikeThemeSpam(text)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "theme_spam" });
      continue;
    }
    if (!aboutPageNamesProducer(text, page.html, nameTokens)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "not_about_producer" });
      continue;
    }
    if (!aboutPageCandidateIsMoreSubstantial(text, input.homepageCandidate, input.producerName)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "not_more_substantial" });
      continue;
    }
    evaluated.push({ url: page.url, candidate: text, verdict: "chosen" });
    chosen = { url: page.url, text };
  }
  if (!chosen && evaluated.some((e) => e.verdict === "not_about_producer")) {
    return { chosen, evaluated, refused: ABOUT_PAGE_NOT_ABOUT_PRODUCER };
  }
  return { chosen, evaluated };
}

/**
 * True when `url` is on `base`'s host and inside its path section (`base`'s
 * own path, or below it). The about page must be the producer's own page:
 * a deep-path homepage on a shared host (a directory listing) must never
 * borrow the host's root «Om oss», which describes the directory, not the
 * producer — the 2026-07-19 hanen.no cross-contamination. PURE.
 */
export function urlIsInSection(url: string, base: string): boolean {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return false;
  }
  if (u.host.toLowerCase() !== b.host.toLowerCase()) return false;
  const section = b.pathname.replace(/\/+$/, "");
  if (!section) return true;
  return u.pathname === section || u.pathname.startsWith(`${section}/`);
}

/**
 * The section a sub-page must stay inside, from the homepage URL actually
 * read: the homepage's own directory (an extensionless last segment counts
 * as a section of its own; an explicit file such as /index.html falls back
 * to its parent). The same rule crFetchGardssalgContent uses for its crawl
 * base. Returns null for an unparseable URL. PURE.
 */
export function homepageSectionBase(homepageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(homepageUrl);
  } catch {
    return null;
  }
  let dir = u.pathname;
  if (!dir.endsWith("/")) {
    const lastSeg = dir.slice(dir.lastIndexOf("/") + 1);
    dir = lastSeg.includes(".") ? dir.replace(/[^/]*$/, "") : `${dir}/`;
  }
  return `${u.protocol}//${u.host}${dir === "/" ? "" : dir.replace(/\/$/, "")}`;
}

/**
 * True when the about page's own prose made it into `contentText` (the
 * capped visible text of every fetched page that the gårdssalg LLM
 * rewrite/fill reads). Checks the first 120 chars of the page's first prose
 * paragraph of at least 40 chars (extractProseParagraphs — not the nav/header
 * text the homepage shares), else of its visible text. PURE.
 */
export function aboutPageTextIncluded(aboutHtml: string, contentText: string): boolean {
  if (!aboutHtml || !contentText) return false;
  const para = extractProseParagraphs(aboutHtml).find((p) => p.length >= 40) ?? extractVisibleText(aboutHtml);
  const probe = para.slice(0, 120).trim();
  return probe.length > 0 && contentText.includes(probe);
}

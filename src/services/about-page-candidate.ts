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
  MAX_PROSE_SCAN_LEN,
  THEME_SPAM_PAGE_TEXT_CHARS,
  THEME_SPAM_PAGE_MIN_STRONG_HITS,
} from "./search-enrich";
import { checkAboutCandidateSubstantiatedBySource } from "./about-source-substantiation";
import { looksLikeCodeArtifact, looksLikeThemeSpam, countThemeSpamStrongHits } from "./description-quality";

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

/**
 * Every regex this module runs on an about page's HTML runs on at most its
 * first ABOUT_PAGE_SCAN_CAP chars — the cap extractProseText already uses
 * (MAX_PROSE_SCAN_LEN), so the prose candidate always comes from inside it.
 * fetchPage does not cap the body, and a page full of unclosed <title>/<h1>
 * tags makes those lazy scans quadratic (measured: 450 kB -> ~39 s, all of
 * it synchronous on the event loop).
 */
export const ABOUT_PAGE_SCAN_CAP = MAX_PROSE_SCAN_LEN;

/**
 * aboutPageContentWindow reads at most this many chars of the raw page. It is
 * a single forward pass, so the bound is only there to cap memory on an
 * absurd body (fetchPage does not cap it); real about pages measured
 * 2026-11-01 were 63–792 kB.
 */
export const ABOUT_PAGE_RAW_SCAN_CAP = 2_000_000;

// The next block aboutPageContentWindow drops: an element whose content is
// never the page's own prose (code, styles, the <head>, inline icons, form
// controls with their help text — a hidden «forgot password» popup measured
// on a real «Om oss» page — and dialogs), or an HTML comment. The lookahead
// keeps «<header», «<scripts» and the like out. Group 1 is the element name;
// no group 1 = «<!--».
const ABOUT_PAGE_DROP_OPEN_RE = /<(?:(script|style|noscript|template|svg|head|fieldset|dialog)(?=[\s>/])|!--)/gi;

/**
 * The part of an about page that holds its text, for the bounded scans in
 * this module (dev-request 2026-10-27-rfb-berikelse-om-oss-sider-til-
 * beskrivelse, AC2 preview 2026-11-01).
 *
 * Reading the first ABOUT_PAGE_SCAN_CAP chars of the RAW page, as the
 * scans did before, sees only <head> on most CMS sites: of 8 real «Om oss»
 * pages <body> started at 26–377 kB, behind inline CSS and scripts, so 7 of 9
 * pages in the preview gave no prose at all. And where a <script> crossed the
 * cut, its unterminated text was read as prose («(function () { 'use
 * strict'; var path = …»).
 *
 * One forward pass over the first ABOUT_PAGE_RAW_SCAN_CAP chars drops every
 * <head>, <script>, <style>, <noscript>, <template>, <svg>, <fieldset> and
 * <dialog> element and every HTML comment, whole (each search only moves forward, so the pass is
 * linear in the input, whatever the markup). A block that is never closed
 * ends the page there — an unterminated <script> must not become text; an
 * unclosed <head> instead ends at <body> when there is one. What is left is
 * read from its first <main> (else <body>, else the start) for
 * ABOUT_PAGE_SCAN_CAP chars. PURE.
 */
export function aboutPageContentWindow(html: string): string {
  if (!html) return "";
  const raw = html.slice(0, ABOUT_PAGE_RAW_SCAN_CAP);
  const kept: string[] = [];
  let pos = 0;
  const open = new RegExp(ABOUT_PAGE_DROP_OPEN_RE.source, "gi");
  for (;;) {
    open.lastIndex = pos;
    const m = open.exec(raw);
    if (!m) {
      kept.push(raw.slice(pos));
      break;
    }
    kept.push(raw.slice(pos, m.index), " ");
    const tag = m[1]?.toLowerCase();
    const close = tag ? new RegExp(`</${tag}\\s*>`, "gi") : /-->/g;
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(raw);
    if (c) {
      pos = c.index + c[0].length;
      continue;
    }
    if (tag === "head") {
      const body = /<body(?=[\s>])/gi;
      body.lastIndex = m.index + m[0].length;
      const b = body.exec(raw);
      if (b) {
        pos = b.index;
        continue;
      }
    }
    break;
  }
  const cleaned = kept.join("");
  const start = /<main(?=[\s>])/i.exec(cleaned)?.index ?? /<body(?=[\s>])/i.exec(cleaned)?.index ?? 0;
  return cleaned.slice(start, start + ABOUT_PAGE_SCAN_CAP);
}

// Script text that reads as a sentence to the prose extractor: a function
// expression, a variable declaration, a strict-mode directive, a browser
// global's member, an arrow function body. None of these occur in a
// producer's own description.
const ABOUT_PAGE_SCRIPT_TEXT_RE =
  /\bfunction\s*\(|\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=|["']use strict["']|\b(?:window|document)\.[A-Za-z_$]|=>\s*\{/;

/**
 * Defence in depth behind aboutPageContentWindow: true when an about-page
 * candidate reads as JavaScript (ABOUT_PAGE_SCRIPT_TEXT_RE) — the shape
 * looksLikeCodeArtifact does not catch. Applied to about-page candidates
 * only, so the homepage path is unchanged. PURE.
 */
export function aboutPageTextLooksLikeScript(text: string): boolean {
  return ABOUT_PAGE_SCRIPT_TEXT_RE.test(text);
}

/**
 * The page's complete <meta …> tags and its <title> element (content of at
 * most 300 chars), and nothing else. Both patterns stop at the next `<`/`>`
 * or a fixed length, so this is linear in `head` — unlike running
 * extractTitle/extractMetaDescriptions on raw HTML, whose `[^>]+` scans
 * backtrack badly on unclosed tags (a page of unclosed `<meta content='x' `
 * takes seconds per few kB). Feeding these tags to the existing extractors
 * gives the same title and meta descriptions for any well-formed page.
 */
function headTagsOf(head: string): string {
  const metas = head.match(/<meta\b[^<>]*>/gi) ?? [];
  const title = /<title\b[^<>]*>[^<]{0,300}<\/title>/i.exec(head)?.[0] ?? "";
  return `<html><head>${title}${metas.join("")}</head><body></body></html>`;
}

/**
 * pageLooksLikeThemeSpam's rule for an about page, on bounded input: its
 * title or a meta description reads as theme spam (pageLooksLikeThemeSpam on
 * headTagsOf(head)), or the opening THEME_SPAM_PAGE_TEXT_CHARS of its visible
 * text (from `body`, aboutPageContentWindow) carry
 * THEME_SPAM_PAGE_MIN_STRONG_HITS strong gambling phrases. `head` is the
 * page's first ABOUT_PAGE_SCAN_CAP chars; `body` is already capped too. PURE.
 */
function aboutPageLooksLikeThemeSpam(head: string, body: string): boolean {
  if (pageLooksLikeThemeSpam(headTagsOf(head))) return true;
  return countThemeSpamStrongHits(extractVisibleText(body).slice(0, THEME_SPAM_PAGE_TEXT_CHARS)) >= THEME_SPAM_PAGE_MIN_STRONG_HITS;
}

// Company forms and function words in a producer name, compared on the word
// as written (lower-case, NOT accent-folded: «AS» is generic, the place «Ås»
// is not, although both fold to "as").
const PRODUCER_NAME_GENERIC_FORMS: ReadonlySet<string> = new Set([
  "as", "sa", "da", "ans", "enk", "nuf", "ba", "ltd",
  "og", "and", "the", "med", "fra", "til", "ved", "hos", "paa", "på", "for",
]);

// Words of a producer name that say what kind of business it is, not which
// one, compared accent-folded (lower-case, æ/ø/å stripped). A name made only
// of these and PRODUCER_NAME_GENERIC_FORMS has nothing to recognise the
// producer by.
const PRODUCER_NAME_GENERIC_WORDS: ReadonlySet<string> = new Set(
  [
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

function distinctiveNameWords(part: string): string[] {
  const out: string[] = [];
  for (const w of part.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || /^\d+$/.test(w) || out.includes(w)) continue;
    if (PRODUCER_NAME_GENERIC_FORMS.has(w) || PRODUCER_NAME_GENERIC_WORDS.has(stripNorwegianAccents(w))) continue;
    out.push(w);
  }
  return out;
}

/**
 * The words that identify THIS producer in its name, lower-case as written
 * (>= 2 letters, not a company form/function word, not a business-type word,
 * not a number). Taken from the part before a place suffix («Tverås Gårdsmat
 * — Gol», «… (Gol)»); when that part has none («Gården AS — Hovland»), from
 * the whole name. PURE.
 */
export function producerNameTokens(name: string | null | undefined): string[] {
  const full = String(name ?? "");
  const head = full.split(/\s+[—–-]\s+|\s*\(/)[0] ?? "";
  const fromHead = distinctiveNameWords(head);
  return fromHead.length > 0 ? fromHead : distinctiveNameWords(full);
}

/** A name word shorter than this must match a whole word; longer ones may start a compound. */
export const PRODUCER_NAME_PREFIX_MIN_LETTERS = 5;

/**
 * Does one name word occur in the page text? `lowerText` is the text
 * lower-cased; `foldedText` the same accent-folded.
 *   - a word of PRODUCER_NAME_PREFIX_MIN_LETTERS or more letters may start a
 *     word, compounds included («Tverås» in «Tveråsgarden»), compared
 *     accent-folded;
 *   - a shorter word must BE a whole word, optionally with a genitive «s»,
 *     compared as written («Nes» matches «Nes gård» / «Nes' » but not
 *     «neste»; «Ås» does not match the company form «AS»);
 *   - a word of more than PRODUCER_NAME_PREFIX_MIN_LETTERS letters ending in
 *     «s» is also tried without it (the name «Hovlands Gårdsbutikk», the page
 *     «Hovland gård»); a shorter one is not («Grans» must not become the
 *     common noun «gran»).
 */
function nameWordOccurs(word: string, lowerText: string, foldedText: string): boolean {
  const forms =
    word.length > PRODUCER_NAME_PREFIX_MIN_LETTERS && word.endsWith("s") ? [word, word.slice(0, -1)] : [word];
  return forms.some((f) => {
    if (f.length >= PRODUCER_NAME_PREFIX_MIN_LETTERS) {
      return new RegExp(`(?:^|[^a-z0-9])${stripNorwegianAccents(f)}`).test(foldedText);
    }
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${f}s?(?![\\p{L}\\p{N}])`, "u").test(lowerText);
  });
}

/**
 * True when the about page is about THIS producer: one of its
 * producerNameTokens occurs (nameWordOccurs) in the candidate text, the page
 * title (og:title / <title>) or its first <h1>. A «Historie» page about the
 * village, or a blog post, on the producer's own host does not name the
 * producer and fails. Reads the title from the first ABOUT_PAGE_SCAN_CAP
 * chars of `html` and the <h1> from `contentWindow` (the caller's
 * aboutPageContentWindow(html); computed here when not given). PURE.
 */
export function aboutPageNamesProducer(
  candidate: string,
  html: string,
  tokens: readonly string[],
  contentWindow?: string,
): boolean {
  if (tokens.length === 0) return false;
  const head = html.slice(0, ABOUT_PAGE_SCAN_CAP);
  const body = contentWindow ?? aboutPageContentWindow(html);
  const tags = headTagsOf(head);
  // og:title or <title> (extractTitle on the bounded tags), the <title>
  // itself, and the first <h1> of the page's text (aboutPageContentWindow —
  // on most CMS sites <body> starts beyond the first ABOUT_PAGE_SCAN_CAP
  // chars), its content read to at most 500 chars, so an unclosed <h1>
  // costs a bounded scan per occurrence.
  const title = /<title\b[^<>]*>([^<]{0,300})<\/title>/i.exec(head)?.[1] ?? "";
  const h1 = /<h1\b[^<>]*>([\s\S]{0,500}?)<\/h1>/i.exec(body)?.[1] ?? "";
  const lower = decodeHtmlEntities([candidate, extractTitle(tags), title, h1].join(" ").replace(/<[^>]+>/g, " ")).toLowerCase();
  const folded = stripNorwegianAccents(lower);
  return tokens.some((t) => nameWordOccurs(t, lower, folded));
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
 *   1. the page as a whole must not read as theme spam (pageLooksLikeThemeSpam's
 *      rule on bounded input: aboutPageLooksLikeThemeSpam);
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
  for (const fetchedPage of input.aboutPages) {
    if (chosen) {
      evaluated.push({ url: fetchedPage.url, candidate: "", verdict: "not_evaluated" });
      continue;
    }
    // Bounded scans only: the page's head tags are read from its first
    // ABOUT_PAGE_SCAN_CAP chars (headTagsOf), everything else from
    // aboutPageContentWindow (its text, scripts/styles/head dropped, at most
    // ABOUT_PAGE_SCAN_CAP chars — extractProseText's own cap).
    const page = {
      url: fetchedPage.url,
      head: fetchedPage.html.slice(0, ABOUT_PAGE_SCAN_CAP),
      body: aboutPageContentWindow(fetchedPage.html),
    };
    if (aboutPageLooksLikeThemeSpam(page.head, page.body)) {
      evaluated.push({ url: page.url, candidate: "", verdict: "theme_spam_page" });
      continue;
    }
    const text = summarizeAboutPageProse(page.body);
    if (!text) {
      evaluated.push({ url: page.url, candidate: "", verdict: "no_prose" });
      continue;
    }
    if (!meetsAboutQualityBar(text)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "below_quality_bar" });
      continue;
    }
    const sub = checkAboutCandidateSubstantiatedBySource(text, `${page.body}\n${extractVisibleText(page.body)}`);
    if (!sub.substantiated) {
      evaluated.push({ url: page.url, candidate: text, verdict: "not_substantiated", detail: sub.reason });
      continue;
    }
    if (looksLikeCodeArtifact(text) || aboutPageTextLooksLikeScript(text)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "code_artifact" });
      continue;
    }
    if (looksLikeThemeSpam(text)) {
      evaluated.push({ url: page.url, candidate: text, verdict: "theme_spam" });
      continue;
    }
    if (!aboutPageNamesProducer(text, fetchedPage.html, nameTokens, page.body)) {
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
 * text the homepage shares), else of its visible text — both read from
 * aboutPageContentWindow. PURE.
 */
export function aboutPageTextIncluded(aboutHtml: string, contentText: string): boolean {
  if (!aboutHtml || !contentText) return false;
  const body = aboutPageContentWindow(aboutHtml);
  const para = extractProseParagraphs(body).find((p) => p.length >= 40) ?? extractVisibleText(body);
  const probe = para.slice(0, 120).trim();
  return probe.length > 0 && contentText.includes(probe);
}

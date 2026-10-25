// ─── Landing pages built from facts (dev-request 2026-10-16-finn-tannlege-landingssider, F1-S3)
//
// Pure helpers for a list/landing page that answers first with real numbers,
// shows a fact table and a visible FAQ. They know nothing about any vertical:
// the caller passes its own facts, sentences and Q/As and its own thresholds
// (config), so Rett fra Bonden and Opplevagent can use the same gate.
//
// The rule behind all four: no claim without a number behind it. A fact that
// is missing, zero or not a finite number is not a fact; a Q/A whose answer
// holds no digit is dropped; the JSON-LD is made from the very list the
// visible FAQ is made from, so the two cannot disagree.

/** The numbers a landing page may state. Missing, null or non-finite values are not facts. */
export type LandingFacts = Record<string, number | null | undefined>;

/** One question and its answer, both plain text (escaped when rendered). */
export interface LandingQa {
  q: string;
  a: string;
}

export interface FactFaq {
  /** The visible FAQ block, or "" when there is nothing to show. */
  html: string;
  /** The FAQPage JSON-LD, built from the same Q/As as `html`; null when there are fewer than minQas. */
  jsonLd: Record<string, unknown> | null;
}

/** Most Q/As a landing page shows (the spec asks for 3-5). */
export const LANDING_FAQ_MAX_QAS = 5;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A real fact is a finite number above zero: a count of none is not worth stating. */
export function isRealFact(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** How many of the facts are real. */
export function countRealFacts(facts: LandingFacts): number {
  let n = 0;
  for (const v of Object.values(facts)) if (isRealFact(v)) n++;
  return n;
}

/**
 * True when the page has enough behind it for a FAQ: `facts.listings` (the
 * number of listings on the page) is at least `minListings`, and at least
 * `minFacts` of the OTHER facts are real. The listing count itself is not
 * counted as one of the facts.
 */
export function passesLandingGate(
  facts: LandingFacts & { listings: number },
  opts: { minListings: number; minFacts: number }
): boolean {
  const { listings, ...rest } = facts;
  if (!(typeof listings === "number" && Number.isFinite(listings))) return false;
  return listings >= opts.minListings && countRealFacts(rest) >= opts.minFacts;
}

/** Whitespace-separated words. */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/**
 * The answer-first paragraph: the sentences in the order given (most
 * important first), as many as fit in `maxWords`. A sentence that would take
 * it past the limit ends the paragraph, so the order of the claims is kept.
 * Null when fewer than `minWords` words come out: better no paragraph than a
 * thin one.
 */
export function buildAnswerFirst(
  sentences: string[],
  opts: { minWords?: number; maxWords?: number } = {}
): string | null {
  const minWords = opts.minWords ?? 40;
  const maxWords = opts.maxWords ?? 60;
  const kept: string[] = [];
  let words = 0;
  for (const raw of sentences) {
    const s = raw.trim();
    if (s === "") continue;
    const n = wordCount(s);
    if (words + n > maxWords) break;
    kept.push(s);
    words += n;
  }
  return words >= minWords ? kept.join(" ") : null;
}

/**
 * The visible FAQ and its FAQPage JSON-LD from ONE list of Q/As. Q/As whose
 * answer has no digit are dropped (no claim without a number), at most
 * LANDING_FAQ_MAX_QAS are kept, and under `minQas` there is neither html nor
 * JSON-LD. Every interpolated value is escaped.
 */
export function buildFactFaq(
  qas: LandingQa[],
  opts: { url: string; minQas: number; heading?: string }
): FactFaq {
  const kept = qas
    .filter((qa) => typeof qa.q === "string" && qa.q.trim() !== "" && typeof qa.a === "string" && /\d/.test(qa.a))
    .slice(0, LANDING_FAQ_MAX_QAS);
  if (kept.length < Math.max(1, opts.minQas)) return { html: "", jsonLd: null };
  const heading = opts.heading ?? "Vanlige spørsmål";
  const html =
    `<section class="landing-faq" aria-labelledby="landing-faq-heading" style="margin-top:32px">` +
    `<h2 id="landing-faq-heading" style="font-size:1.15rem;margin-bottom:12px">${escapeHtml(heading)}</h2>` +
    kept
      .map(
        (qa) =>
          `<div class="landing-faq-item" style="margin-bottom:14px"><h3 style="font-size:1rem;margin-bottom:4px">${escapeHtml(qa.q)}</h3>` +
          `<p style="margin:0">${escapeHtml(qa.a)}</p></div>`
      )
      .join("") +
    `</section>`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: opts.url,
    mainEntity: kept.map((qa) => ({
      "@type": "Question",
      name: qa.q,
      acceptedAnswer: { "@type": "Answer", text: qa.a },
    })),
  };
  return { html, jsonLd };
}

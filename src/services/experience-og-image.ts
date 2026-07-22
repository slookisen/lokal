/**
 * experience-og-image.ts — per-page branded OG (Open Graph) image generator
 * for Opplevagent (opplevagent.no).
 *
 * dev-request 2026-07-12-opplevagent-serp-innholdsberikelse, item 3: link
 * previews (Slack, X, Messenger, …) on opplevelse-detail, tilbyder-detail,
 * and kategori/fylke/kommune-browse pages were falling back to the tiny
 * app-icon `favicon.svg` as `og:image`, because those pages have no real
 * photo to show. Daniel's explicit, standing constraint (2026-07-10): no
 * auto-fetched/scraped photos, ever — image rights are out of scope for this
 * vertical. The dev-request's own spec sanctions exactly this interim path:
 * "kan som mellomløsning bruke en branded SVG/tekst-mal generert av oss
 * selv" (an interim, self-generated branded SVG/text template).
 *
 * `renderExperienceOgImageSvg()` is a pure function: given a label (+
 * optional sublabel/accent color) it returns a deterministic 1200×630 SVG —
 * the standard OG image aspect ratio — built entirely from inline
 * `<text>`/`<path>`/shape markup. No raster images, no external fetches, no
 * externally-loaded fonts (an inline `font-family` fallback stack is used,
 * same convention as the rest of this codebase's inline `<style>` blocks).
 *
 * Visual language deliberately reuses the "Konstellasjon" brand mark already
 * shipped in `experiences-seo.ts`'s `/favicon.svg` and `/logo.svg` routes
 * (three agent nodes + a coral spark) and the same CSS custom-property
 * palette (`--fjord-*`, `--teal-*`, `--amber-*`, `--gold`, `--olive`,
 * `--canvas`) so the generated image reads as unmistakably Opplevagent.
 *
 * Security: every piece of interpolated text (label, sublabel — which can
 * come from DB data such as provider names or kommune names, i.e. not fully
 * trusted/sanitized input) is XML-escaped before being placed inside the SVG
 * markup, to prevent SVG/XML injection. Reuses `escapeHtml()` from
 * `../routes/experiences-seo` — the same escaper already used everywhere
 * else in that file for the identical `& < > " '` escaping — rather than
 * defining a second one; XML escaping doesn't differ from HTML escaping for
 * that character set. (This does create a route→service→route import edge,
 * but only ever resolved at *call* time — the service never touches
 * `escapeHtml` at module-evaluation time — and TypeScript's commonjs output
 * keeps named imports as deferred property access on the required module
 * object, so the require-cycle is safe here; see the codebase's existing
 * services/dental-store.ts / services/search-enrich-sweep.ts →
 * routes/admin-knowledge.ts precedent for a service importing from a route
 * module.)
 */

import { escapeHtml } from "../routes/experiences-seo";

const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

// Query-param / input bound — an absurdly long label/sublabel must never be
// allowed to bloat the generated SVG (or the request that produced it).
// Truncated, never rejected — this codebase's general "never fail closed on
// cosmetic input" convention (see e.g. metaDescRaw/about_text truncation
// elsewhere in experiences-seo.ts).
const MAX_INPUT_LEN = 120;

// Display bounds — tighter than MAX_INPUT_LEN, because these govern how much
// text can actually sit inside the fixed 1200×630 canvas without the SVG
// <text> overflowing its box. Label may wrap onto a second line; sublabel is
// always a single line.
const LABEL_CHARS_PER_LINE = 24;
const SUBLABEL_MAX_CHARS = 52;

const BRAND_CREAM = "#f7f4ee";
const BRAND_CORAL = "#ff5d3b";
const BRAND_TEAL = "#3cc3b4";
const BRAND_FJORD_900 = "#0b2e29";

// Default accent — same brand teal-to-fjord tone used for `theme-color`
// elsewhere in experiences-seo.ts — used whenever no (or an unrecognized)
// category accent is supplied, e.g. for shared browse pages that don't carry
// a single category (tilbyder pages, /opplevelser, /sok, /fylke, /kommune).
export const DEFAULT_OG_ACCENT = "#0e3c36"; // --fjord-800

// Companion color map to CATEGORY_LABELS in experiences-seo.ts (same keys,
// ~line 149 there) — one distinct, on-brand color per category, drawn from
// the same palette used throughout experiences-seo.ts's <style> blocks
// (--fjord-900/800/700/600, --teal-500/400, --amber-500/400, --gold,
// --olive). Kept here (not imported) since experiences-seo.ts's
// CATEGORY_LABELS is not exported and duplicating ten short hex strings is
// far simpler/safer than exporting+threading a whole label map just to key
// off its keys.
export const CATEGORY_OG_ACCENT_COLORS: Record<string, string> = {
  vinter_sno: "#3cc3b4", // --teal-400 (icy)
  sightseeing_transport: "#0c7264", // --fjord-600
  dyreliv_safari: "#6f7a4f", // --olive
  natur_friluft: "#0f5a50", // --fjord-700
  kultur_historie: "#c98a2b", // --gold
  overnatting_opplevelse: "#0b2e29", // --fjord-900
  adrenalin_action: "#ff5d3b", // --amber-500 / --coral-500
  velvaere_spa: "#12a594", // --teal-500
  mat_drikke: "#ff8566", // --amber-400
  gardssalg: "#0e3c36", // --fjord-800
};

/** Resolve a category slug to its OG accent color, falling back to the brand default. */
export function resolveOgAccentColor(category?: string | null): string {
  if (category && CATEGORY_OG_ACCENT_COLORS[category]) return CATEGORY_OG_ACCENT_COLORS[category];
  return DEFAULT_OG_ACCENT;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/;

function boundedText(raw: unknown, maxLen: number): string {
  const s = String(raw ?? "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)).trim() + "…";
}

// Break `text` onto at most two lines, each at most `maxChars` long,
// preferring a whitespace break at/before the limit. Any remainder past the
// second line is ellipsis-truncated. Pure + deterministic (no font metrics —
// a character-count heuristic is good enough for a decorative fallback
// image).
function wrapToTwoLines(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text ? [text] : [];
  let breakAt = text.lastIndexOf(" ", maxChars);
  if (breakAt <= 0) breakAt = maxChars;
  const line1 = text.slice(0, breakAt).trim();
  let line2 = text.slice(breakAt).trim();
  if (line2.length > maxChars) {
    line2 = line2.slice(0, Math.max(0, maxChars - 1)).trim() + "…";
  }
  return line2 ? [line1, line2] : [line1];
}

// Small watermark rendition of the «Konstellasjon» mark (three agent nodes +
// coral spark) — the same path/circle geometry as brandMarkSvg() /
// /favicon.svg / /logo.svg in experiences-seo.ts, parameterized for reuse at
// two sizes here (a subtle background watermark + the header lockup icon).
function constellationMark(opts: { size: number; opacity: number; monochrome?: boolean }): string {
  const { size, opacity, monochrome } = opts;
  const spark = monochrome ? BRAND_CREAM : BRAND_CORAL;
  const scale = (size / 48).toFixed(3);
  return `<g opacity="${opacity}" transform="scale(${scale})">` +
    `<path d="M9 33 L24 11 L43 19 L31 38 Z" fill="none" stroke="${BRAND_CREAM}" stroke-width="2" stroke-linejoin="round" opacity="0.55"/>` +
    `<circle cx="9" cy="33" r="4.4" fill="${BRAND_CREAM}"/>` +
    `<circle cx="43" cy="19" r="4.4" fill="${BRAND_CREAM}"/>` +
    `<circle cx="31" cy="38" r="4.4" fill="${BRAND_CREAM}"/>` +
    `<path d="M24 3 C25.1 8.9 26.9 10.7 32.8 11.8 C26.9 12.9 25.1 14.7 24 20.6 C22.9 14.7 21.1 12.9 15.2 11.8 C21.1 10.7 22.9 8.9 24 3 Z" fill="${spark}"/>` +
    `</g>`;
}

export interface ExperienceOgImageOptions {
  /** Primary text — experience title, provider name, category/place name, … */
  label: string;
  /** Secondary text under the label — category label, place, etc. Optional. */
  sublabel?: string | null;
  /** Background accent color as a `#rgb`/`#rrggbb` hex string. Falls back to DEFAULT_OG_ACCENT if missing/invalid. */
  accent?: string | null;
}

/**
 * Render a branded, deterministic 1200×630 OG-image SVG. Pure — no I/O, no
 * fetches. All interpolated text is XML-escaped.
 */
export function renderExperienceOgImageSvg(opts: ExperienceOgImageOptions): string {
  const accent = opts.accent && HEX_COLOR_RE.test(opts.accent) ? opts.accent : DEFAULT_OG_ACCENT;

  const rawLabel = boundedText(opts.label, MAX_INPUT_LEN) || "Opplevagent";
  const rawSublabel = opts.sublabel ? boundedText(opts.sublabel, MAX_INPUT_LEN) : "";

  const labelLines = wrapToTwoLines(rawLabel, LABEL_CHARS_PER_LINE);
  const sublabelDisplay = rawSublabel ? boundedText(rawSublabel, SUBLABEL_MAX_CHARS) : "";

  const labelFontSize = labelLines.length > 1 ? 56 : 66;
  const labelLineHeight = labelLines.length > 1 ? 66 : 0;
  const labelBaseY = labelLines.length > 1 ? 428 : 466;

  const labelTspans = labelLines
    .map((line, i) => `<tspan x="70" y="${labelBaseY + i * labelLineHeight}">${escapeHtml(line)}</tspan>`)
    .join("");

  const sublabelY = labelBaseY + (labelLines.length > 1 ? labelLineHeight : 0) + 54;

  const sublabelText = sublabelDisplay
    ? `<text x="70" y="${sublabelY}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" font-size="30" font-weight="600" fill="${BRAND_CREAM}" opacity="0.86">${escapeHtml(sublabelDisplay)}</text>`
    : "";

  const ariaLabel = escapeHtml([rawLabel, rawSublabel].filter(Boolean).join(" — "));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" viewBox="0 0 ${OG_IMAGE_WIDTH} ${OG_IMAGE_HEIGHT}" role="img" aria-label="${ariaLabel}">` +
    `<title>${ariaLabel}</title>` +
    `<defs>` +
    `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${BRAND_FJORD_900}" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="${BRAND_FJORD_900}" stop-opacity="0.66"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" fill="${accent}"/>` +
    `<g transform="translate(780 -40)">${constellationMark({ size: 520, opacity: 0.14 })}</g>` +
    `<rect x="0" y="300" width="${OG_IMAGE_WIDTH}" height="330" fill="url(#scrim)"/>` +
    `<g transform="translate(70 56)">` +
    constellationMark({ size: 40, opacity: 0.95 }) +
    `<text x="58" y="30" font-family="'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="28" font-weight="700" fill="${BRAND_CREAM}">opplevagent<tspan fill="${BRAND_TEAL}">.no</tspan></text>` +
    `</g>` +
    `<text font-family="'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${labelFontSize}" font-weight="800" fill="${BRAND_CREAM}">${labelTspans}</text>` +
    sublabelText +
    `</svg>`;
}

/**
 * Headless-browser rendering fallback for JS-built producer sites.
 *
 * Why this module exists (Daniel, live session 2026-08-13). The shared fetcher
 * (services/fetch-page.ts) reads raw HTML. That is correct and cheap for the
 * overwhelming majority of Norwegian producer sites, but it returns nothing
 * usable for a site whose content is assembled in the browser. The case that
 * forced this, measured the same day:
 *
 *   67northdistillery.no   179 883 B HTML   →   19 visible chars   10 <script>
 *
 * Nineteen characters — the page title, "67 North Distillery", and nothing
 * else. The row sits in `needs_enrichment` because `about_text` and `products`
 * are empty, and they are empty because THERE IS NO TEXT TO EXTRACT from the
 * source. No amount of re-running the existing enrichment chain fixes that;
 * the content only exists after JavaScript runs.
 *
 * Contrast with a real server-rendered producer page from the 2026-07-26 probe
 * recorded in fetch-page.ts:
 *
 *   hamre-hagen.no          12 341 B HTML   →  305 visible chars
 *
 * That two-orders-of-magnitude gap in text-per-byte is what shouldEscalate-
 * ToRender() below keys on.
 *
 * ── Contract ───────────────────────────────────────────────────────────────
 *
 * Same discipline as fetch-page.ts, deliberately: NEVER a bare null. Every
 * failure comes back as a named reason. A caller must be able to tell "no
 * browser is installed here" apart from "the browser ran and the page was
 * still empty" — those have completely different remedies, and collapsing them
 * is the exact mistake fetch-page.ts exists to document.
 *
 * ── Deployment note, load-bearing ──────────────────────────────────────────
 *
 * This module does NOT add a runtime dependency, and production DOES render —
 * via a backend, not via a bundled browser. `defaultRenderImpl` picks that
 * backend with `selectRenderBackend()`, keyed on whether `RENDER_WORKER_KEY`
 * is configured:
 *
 *   - "worker" (production, and any environment with the key set): the
 *     render is delegated to `render-worker/`, the standalone, already-live
 *     `lokal-render-worker` Fly app (own image, built on
 *     `mcr.microsoft.com/playwright`, own autoscale-to-zero, own internal
 *     concurrency cap) via `services/render-client.ts`. Nothing is launched
 *     in-process; this app's own memory/image footprint (Dockerfile:
 *     node:20-alpine, 1024 MB, shared-cpu-1x, serving both
 *     rettfrabonden.com and opplevagent.no) is untouched by rendering at all.
 *     A failed call to the worker (bad response, timeout, network error) is
 *     a real render failure for that page/attempt, classified by
 *     `classifyRenderError()` same as the local path below — it is NOT
 *     `renderer_unavailable`, because the worker being reachable in
 *     principle is exactly what "configured" means here.
 *   - "local" (RENDER_WORKER_KEY unset — dev/sandbox only): the original
 *     `playwright-core` path, imported lazily inside a try/catch so merely
 *     loading this module never requires the package to exist. This is what
 *     makes `renderPage()` work in a session container that happens to ship
 *     Chromium at $PLAYWRIGHT_BROWSERS_PATH, and it is kept as a harmless
 *     fallback branch, not the production path. Playwright's own Chromium
 *     builds are glibc-only and do not run on Alpine/musl, so this branch
 *     was never going to be production's answer — apk-installing a system
 *     Chromium into the main image remains out of scope (roughly +400 MB of
 *     image and 150-300 MB more RSS while a page is open, on a machine that
 *     already sits around 286 MB, with no staging environment to catch a
 *     boot failure before real traffic) and is not needed now that the
 *     worker covers production.
 *
 * `renderer_unavailable` is reserved for the genuine case: no worker key AND
 * the local `playwright-core` import fails — this environment has no
 * rendering capability at all.
 *
 * The escalation decision and the backend selection are both PURE and
 * unit-tested; the render itself is the only part here that does I/O.
 */

import { visibleTextOf } from "./fetch-page";
// Distinct local name: render-client.ts independently exports its own
// `renderPage`, unrelated in shape to this module's export of the same name
// — a pre-existing naming collision between two independently-written files.
import { renderPage as callRenderWorker } from "./render-client";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Wall-clock cap for one render, including navigation and settle. */
export const DEFAULT_RENDER_TIMEOUT_MS = 20_000;

/**
 * Visible-character floor under which a fetched page is considered a JS shell
 * worth re-fetching through a browser.
 *
 * 200 sits deliberately between the two measured poles: 67 North's 19 and
 * hamre-hagen's 305. It is a floor for ESCALATION, never for rejection — a
 * page below it is not discarded, it is retried harder. fetch-page.ts refuses
 * to carry any "too thin" threshold because there it would silently hide real
 * pages from the extractors; here the failure mode of a wrong guess is one
 * wasted render, not a lost producer. That asymmetry is why a threshold is
 * acceptable in this module and not in that one.
 */
export const RENDER_ESCALATION_TEXT_FLOOR = 200;

/**
 * Byte floor for escalation. A genuinely tiny response is an error stub, not a
 * JS app — isUnusableBody() already catches the markup-free ones, and this
 * stops the rest from each costing a browser launch.
 */
export const RENDER_ESCALATION_MIN_BYTES = 2_000;

/**
 * Boilerplate-aware companion to RENDER_ESCALATION_TEXT_FLOOR (dev-request
 * 2026-08-17-berikelse-uttrekk-evidence-url-og-render, Skive 2a).
 *
 * Measured live, 2026-08-17: a gårdssalg homepage came back with
 * `chars_before: 2043` — comfortably over the 200-char raw floor above, so
 * shouldEscalateToRender said "has enough text" — yet the enrichment run on
 * that exact fetch extracted ZERO of the four content fields (about_text,
 * visit_text, opening_hours_text, products) from it. The 2043 characters
 * were real, but they were nav/footer/cookie-banner chrome from a JS shell,
 * not producer content — visibleTextOf() (fetch-page.ts) only strips
 * script/style/comments/tags, it has no notion of structural boilerplate.
 *
 * 400 is the dev-request's own worked example ("< 400 tegn ekstrahert tekst
 * etter boilerplate-fjerning"), applied to mainContentTextOf()'s output, NOT
 * to raw visibleTextOf() output — see shouldEscalateToRender()'s gap
 * requirement below for why reusing RENDER_ESCALATION_TEXT_FLOOR's value of
 * 200 as a blanket replacement would have been wrong: hamre-hagen.no (the
 * fixture RENDER_ESCALATION_TEXT_FLOOR is itself calibrated against) is a
 * real, content-bearing page whose ENTIRE body is only 305 characters — well
 * under 400 — and must never be judged eligible just because it is short.
 * This floor only ever applies to pages where boilerplate stripping removed
 * a meaningful chunk of the raw text (the gap check), so a genuinely short
 * real page with little to no nav/footer/cookie chrome never reaches it.
 */
export const RENDER_ESCALATION_MAIN_CONTENT_TEXT_FLOOR = 400;

// ── Result types ────────────────────────────────────────────────────────────

export type RenderFailureReason =
  /** No browser/playwright-core in this environment. NOT a site problem. */
  | "renderer_unavailable"
  /** The browser launched but navigation exceeded the timeout. */
  | "render_timeout"
  /** Navigation itself failed (DNS, TLS, refused) inside the browser. */
  | "render_navigation_failed"
  /** The browser rendered the page and it still carried no usable text. */
  | "render_empty"
  | "unknown";

export type RenderPageResult =
  | {
      ok: true;
      /** Serialized DOM AFTER scripts ran. */
      html: string;
      /** Visible text of that DOM, already extracted. */
      text: string;
      finalUrl: string;
      /** Milliseconds the render took, for cost reporting. */
      elapsedMs: number;
    }
  | {
      ok: false;
      reason: RenderFailureReason;
      detail: string;
      elapsedMs: number;
    };

// ── Pure decision ───────────────────────────────────────────────────────────

// ── mainContentTextOf internals ─────────────────────────────────────────────
//
// Finding 1 (independent-reviewer fix-up, 2026-08-17): the original
// implementation stripped each chrome category with its own
// `<tag\b[\s\S]*?<\/tag>` / `<(\w+)...>[\s\S]*?<\/\1>` regex. That "lazy
// scan to the matching closing tag" shape is quadratic on malformed HTML:
// for EVERY candidate opening tag that has no closing tag anywhere after it
// (a buggy producer CMS emitting unclosed `<div class="cookie-x">` chrome,
// not even an adversarial input), the regex engine scans all the way to
// end-of-string before giving up on that one candidate, then repeats for
// the next candidate. N unclosed candidates over a document of length L is
// O(N·L) — reviewer-measured at 15.8s for a 1.29 MB payload of 60 000
// unclosed `<div class="cookie-x">` tags, 44s at 2.2 MB, blocking the whole
// single-threaded event loop (every route on both sites) for the duration.
//
// The fix below replaces ALL FOUR chrome categories (nav/header/footer,
// ARIA-role landmarks, and the class/id keyword clause) with a single
// linear-time pass, so the same failure mode can't resurface via an
// unclosed <nav>/<header>/<footer>/role tag either:
//
//   1. One single forward regex pass collects every opening tag's name,
//      attributes, and position — O(n) (regex.exec advances strictly past
//      each match; nothing here re-scans from an interior position).
//   2. A second single forward regex pass collects every closing tag's
//      name and position — also O(n) — grouped by lower-cased tag name.
//   3. For each opening-tag candidate that is chrome (tag name is
//      nav/header/footer, OR it carries a matching ARIA role, OR its
//      class/id carries a chrome token — see classAttrIsChrome below), we
//      need "the next closing tag of the same name after this candidate".
//      Candidates of the same tag name are visited in the SAME left-to-
//      right order they were collected in step 1, and step 2's per-name
//      closing-tag lists are already sorted left-to-right too — so a single
//      monotonically-advancing cursor per tag name finds each candidate's
//      closing tag (or proves none exists) WITHOUT re-scanning: the cursor
//      only ever moves forward, and its total forward movement across all
//      candidates of one tag name is bounded by that tag name's closing-tag
//      count. Summed over all tag names, total cursor movement is O(n).
//      Critically: when no closing tag exists for a candidate, the cursor
//      simply reaches the end of that tag name's list and stops — an O(1)
//      "give up", never an O(n) rescan. That is the specific property that
//      kills the quadratic blowup: an unclosed candidate now costs O(1),
//      not O(remaining document length).
//   4. The resulting strip ranges are sorted (already emitted in start
//      order) and merged, then the output is built with one linear copy
//      pass over the original string.
//
// Worst case overall: steps 1+2 are O(n) each, step 3 is O(n) total across
// all cursors, step 4 is O(n). No step ever re-scans a suffix of the input
// per-candidate, so the whole function is O(n) regardless of how many
// candidates are unclosed. This is the same reasoning fetch-page.ts's
// visibleTextOf() relies on for its own script/style stripping (a single
// forward lazy scan per tag TYPE, not per candidate instance) — the bug
// here was doing that scan per INSTANCE instead of per type.

type ChromeTagCandidate = { tagLower: string; start: number; afterOpenTag: number };
type StripRange = { start: number; end: number };

const CHROME_STRUCTURAL_TAGS = new Set(["nav", "header", "footer"]);
const CHROME_ROLE_RE = /\brole\s*=\s*["'](navigation|banner|contentinfo)["']/i;
const CLASS_OR_ID_ATTR_RE = /\b(?:class|id)\s*=\s*["']([^"']*)["']/gi;

/**
 * Compound two-word signals that reliably identify a consent/menu widget.
 * Checked against ADJACENT hyphen-separated words *within* a single class/id
 * token (e.g. token "cookie-consent-banner" contains the adjacent pair
 * "cookie-consent" -> chrome). Finding 2 (independent-reviewer fix-up): the
 * bare single words "cookie", "hamburger", "sidebar", "consent", "gdpr" are
 * DELIBERATELY not matched on their own below — this is a farm-shop/
 * producer-goods platform where `id="hamburger-info"` (a meat product),
 * `class="cookie-jar-produkter"` (baked goods), and `class="sidebar"` (an
 * opening-hours widget — very common producer-site layout) are all
 * plausible REAL content, not chrome. Requiring the fuller compound is the
 * tightened signal; see mct-fp-* tests in render-page.test.ts.
 */
const CHROME_COMPOUND_BIGRAMS = new Set([
  "cookie-consent",
  "cookie-banner",
  "cookie-notice",
  "cookie-popup",
  "cookie-bar",
  "gdpr-banner",
  "gdpr-consent",
  "gdpr-notice",
  "consent-banner",
  "consent-manager",
  "consent-popup",
  "nav-menu",
  "site-nav",
  "menu-toggle",
  "nav-toggle",
  "nav-sidebar",
  "sidebar-nav",
  "mobile-menu",
  "mobile-nav",
  "hamburger-menu",
  "nav-hamburger",
]);

/**
 * Single bare words that are unambiguous boilerplate signals even alone —
 * unlike cookie/hamburger/sidebar/consent/gdpr (see CHROME_COMPOUND_BIGRAMS
 * doc comment), none of these plausibly names real farm-shop content.
 */
const CHROME_BARE_WORDS = new Set(["navbar"]);

/** Whether a single class/id ATTRIBUTE VALUE carries a chrome signal. PURE. */
function classOrIdValueIsChrome(attrValue: string): boolean {
  for (const rawToken of attrValue.split(/\s+/)) {
    if (!rawToken) continue;
    const token = rawToken.toLowerCase();
    if (CHROME_BARE_WORDS.has(token)) return true;
    const words = token.split("-");
    if (words.length < 2) continue;
    for (let i = 0; i + 1 < words.length; i++) {
      if (CHROME_COMPOUND_BIGRAMS.has(`${words[i]}-${words[i + 1]}`)) return true;
    }
  }
  return false;
}

/** Whether an opening tag's raw attribute text carries a chrome class/id. PURE. */
function attrsHaveChromeClassOrId(attrs: string): boolean {
  CLASS_OR_ID_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_OR_ID_ATTR_RE.exec(attrs))) {
    if (classOrIdValueIsChrome(m[1])) return true;
  }
  return false;
}

/**
 * Strip structural chrome — `<nav>`, `<header>`, `<footer>`, ARIA landmark
 * equivalents (`role="navigation"/"banner"/"contentinfo"`), and cookie-
 * consent/menu widgets identified by class/id — before reducing to visible
 * text via visibleTextOf(). PURE. Linear in html.length — see the internals
 * comment above for the worst-case proof.
 *
 * This exists ONLY to make shouldEscalateToRender's floor comparison
 * content-based rather than raw-length-based (Skive 2a, see
 * RENDER_ESCALATION_MAIN_CONTENT_TEXT_FLOOR's doc comment for the measured
 * case). It is deliberately NOT used anywhere in the actual extraction
 * pipeline — fetch-page.ts's visibleTextOf() stays the single source of
 * truth there, unchanged, per that module's own doc comment on why no
 * "too thin" heuristic belongs in the fetcher. Stripping real content by
 * mistake here only costs one wrong render-eligibility guess; doing the same
 * in the extractor would silently hide real pages from every downstream
 * field.
 */
export function mainContentTextOf(html: string): string {
  // Step 1: one forward pass collecting every chrome-eligible opening tag.
  const candidates: ChromeTagCandidate[] = [];
  const openTagRe = /<(\w+)\b([^>]*)>/g;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openTagRe.exec(html))) {
    const tagLower = openMatch[1].toLowerCase();
    const attrs = openMatch[2];
    const isChrome =
      CHROME_STRUCTURAL_TAGS.has(tagLower) || CHROME_ROLE_RE.test(attrs) || attrsHaveChromeClassOrId(attrs);
    if (isChrome) {
      candidates.push({
        tagLower,
        start: openMatch.index,
        afterOpenTag: openMatch.index + openMatch[0].length,
      });
    }
  }
  if (candidates.length === 0) return visibleTextOf(html);

  // Step 2: one forward pass collecting every closing tag, grouped by name.
  const closingsByTag = new Map<string, number[]>();
  const closeTagRe = /<\/(\w+)\s*>/g;
  let closeMatch: RegExpExecArray | null;
  while ((closeMatch = closeTagRe.exec(html))) {
    const tagLower = closeMatch[1].toLowerCase();
    let list = closingsByTag.get(tagLower);
    if (!list) {
      list = [];
      closingsByTag.set(tagLower, list);
    }
    list.push(closeMatch.index);
  }

  // Step 3: monotonic per-tag-name cursor — never rescans, never rewinds.
  const cursorByTag = new Map<string, number>();
  const ranges: StripRange[] = [];
  for (const candidate of candidates) {
    const closings = closingsByTag.get(candidate.tagLower);
    if (!closings) continue; // no closing tag anywhere in the document: O(1) give-up.
    let cursor = cursorByTag.get(candidate.tagLower) ?? 0;
    while (cursor < closings.length && closings[cursor] < candidate.afterOpenTag) {
      cursor++;
    }
    cursorByTag.set(candidate.tagLower, cursor);
    if (cursor >= closings.length) continue; // no closing AFTER this candidate: O(1) give-up.
    const closeStart = closings[cursor];
    ranges.push({ start: candidate.start, end: closeStart });
  }

  // Step 4: merge overlapping/nested ranges, then one linear copy pass.
  ranges.sort((a, b) => a.start - b.start);
  const merged: StripRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  // Each merged range's `end` currently points at the START of its closing
  // tag; extend it to cover the closing tag itself (bounded, single regex
  // exec per merged range — not per candidate, so still O(n) total since
  // merged ranges cannot overlap and their closing-tag scans stay within
  // each range's own small closing-tag text).
  for (const r of merged) {
    const closeTagMatch = /^<\/\w+\s*>/.exec(html.slice(r.end));
    if (closeTagMatch) r.end += closeTagMatch[0].length;
  }

  let out = "";
  let cursor = 0;
  for (const r of merged) {
    out += html.slice(cursor, r.start) + " ";
    cursor = r.end;
  }
  out += html.slice(cursor);

  return visibleTextOf(out);
}

/**
 * Whether a successfully-fetched page looks like a JS shell worth rendering.
 * PURE — no network, no browser.
 *
 * All three conditions must hold:
 *   1. the visible text is under the escalation floor (raw) OR the page
 *      reads as content-thin once boilerplate chrome is stripped out (see
 *      below),
 *   2. the response is big enough to be an application rather than a stub, and
 *   3. the markup actually contains a script — without one, running a browser
 *      cannot produce text that raw HTML did not already have.
 *
 * Condition 3 is what keeps this from firing on a small-but-complete static
 * page (the `og:description`-only producer site fetch-page.ts documents, whose
 * body text is 20 characters): no script, no escalation, no wasted launch.
 *
 * The boilerplate-aware branch (Skive 2a, dev-request 2026-08-17-berikelse-
 * uttrekk-evidence-url-og-render) only fires once BOTH of these hold:
 *   - mainContentTextOf(html) is under RENDER_ESCALATION_MAIN_CONTENT_TEXT_
 *     FLOOR, AND
 *   - stripping boilerplate removed at least RENDER_ESCALATION_TEXT_FLOOR
 *     characters' worth of text (rawLen - mainLen >= the same 200-char
 *     floor the raw check uses).
 *
 * That second condition is load-bearing, not decorative: without it, a
 * genuinely short real page with little or no nav/footer (hamre-hagen.no,
 * 305 total visible chars — see RENDER_ESCALATION_TEXT_FLOOR's own doc
 * comment) would have mainLen ≈ rawLen ≈ 305, which is under the 400-char
 * main-content floor too, and would wrongly become eligible purely for
 * being short. Requiring a real gap means the branch only fires when
 * boilerplate chrome is what pushed the raw count over 200 in the first
 * place — exactly the 2043-chars-of-chrome-zero-fields-extracted shape this
 * was built for, not an ordinary short producer page.
 */
export function shouldEscalateToRender(html: string, opts: { bytes?: number } = {}): boolean {
  const bytes = opts.bytes ?? Buffer.byteLength(html);
  if (bytes < RENDER_ESCALATION_MIN_BYTES) return false;
  if (!/<script\b/i.test(html)) return false;
  const rawLen = visibleTextOf(html).length;
  if (rawLen < RENDER_ESCALATION_TEXT_FLOOR) return true;
  const mainLen = mainContentTextOf(html).length;
  return (
    mainLen < RENDER_ESCALATION_MAIN_CONTENT_TEXT_FLOOR &&
    rawLen - mainLen >= RENDER_ESCALATION_TEXT_FLOOR
  );
}

/**
 * Strip the chrome that survives rendering but is not producer content —
 * script/style/noscript bodies and HTML comments — then reduce to visible
 * text. PURE. Reuses visibleTextOf so raw-HTML and rendered-DOM extraction can
 * never drift apart.
 */
export function renderedTextOf(html: string): string {
  return visibleTextOf(html);
}

/**
 * Which render backend `defaultRenderImpl` should use. PURE — reads only
 * whether `RENDER_WORKER_KEY` is configured, no I/O of its own.
 *
 * "worker" wins whenever the key is present: `render-worker/` (a standalone,
 * already-live Fly app — see the deployment note above) is the ONLY backend
 * available in production, since production's Alpine image has no browser
 * and this repo is not adding one. "local" — the original `playwright-core`
 * path — is the fallback for a dev/sandbox environment that has no worker
 * key configured but may happen to have a local Chromium.
 */
export function selectRenderBackend(): "worker" | "local" {
  return process.env.RENDER_WORKER_KEY ? "worker" : "local";
}

/**
 * What a caller's headless escalation did on ONE fetch — the reportable
 * record of a decision that is otherwise invisible.
 *
 * Daniel, live session 2026-08-15. The first version of this diagnostic was
 * emitted only when a render was actually ATTEMPTED, so an absent record
 * collapsed three states with three different remedies:
 *
 *   flag off               -> set GARDSSALG_HEADLESS_FALLBACK_ENABLED
 *   flag on, not eligible  -> nothing to do (or the thresholds are wrong)
 *   attempted, failed      -> read `reason`
 *
 * Distinguishing them cost a deploy and a live probe per round, on exactly
 * the rows that are hardest to reach. So the two decision bits are now part
 * of the record and it is emitted unconditionally: `flag_enabled` is the
 * caller's kill switch, `eligible` is shouldEscalateToRender()'s verdict, and
 * `attempted` is their conjunction. This is the same rule fetch-page.ts's
 * module doc states for failures — never collapse states whose remedies
 * differ — applied to the decision instead of the outcome.
 *
 * `chars_before` is always meaningful (it is why `eligible` came out the way
 * it did); `chars_after`, `ok`, `reason`, `detail` and `elapsed_ms` exist
 * only once `attempted` is true.
 */
export type RenderEscalationDiagnostic = {
  /** The caller's env kill switch, as read on this call. */
  flag_enabled: boolean;
  /** shouldEscalateToRender()'s verdict on the fetched page. */
  eligible: boolean;
  /** flag_enabled && eligible — whether renderPage() was actually called. */
  attempted: boolean;
  /** Which backend renderPage would use — "worker" needs RENDER_WORKER_KEY. */
  backend: "worker" | "local";
  /** Visible-text length of the RAW fetch, always present. */
  chars_before: number;
  /** Present only when `attempted`. */
  ok?: boolean;
  /** Named failure reason from classifyRenderError. Absent on success. */
  reason?: RenderFailureReason | string;
  detail?: string;
  /** Visible-text length AFTER rendering. Present only on a successful render. */
  chars_after?: number;
  elapsed_ms?: number;
  /**
   * Sub-pages this caller additionally rendered, and how many of those renders
   * failed. Only a caller that crawls beyond the primary page sets these; both
   * are absent when no sub-page was escalated.
   *
   * They are counters rather than per-page records on purpose: what an operator
   * needs from a sweep is "did the crawl read this site or not", and a per-page
   * breakdown at GARDSSALG_MAX_PAGES × cohort size is a report nobody reads.
   */
  subpages_rendered?: number;
  subpages_render_failed?: number;
};

// ── The renderer ────────────────────────────────────────────────────────────

export type RenderPageOptions = {
  userAgent: string;
  timeoutMs?: number;
  /**
   * Injected for tests. Receives the url and must resolve to the post-script
   * DOM. Passing a stub here keeps the whole test suite browser-free — the
   * `npm test` gate must never require Chromium, since production has none.
   */
  renderImpl?: (url: string, timeoutMs: number, userAgent: string) => Promise<{ html: string; finalUrl: string }>;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
};

/**
 * Load a URL in a headless browser and return the DOM after scripts have run.
 * Never throws, never returns a bare null.
 *
 * The browser is launched and closed around each call. That is deliberately
 * wasteful of startup time (~300 ms) in exchange for bounded memory: a
 * long-lived browser accumulating pages is precisely what would push a 1024 MB
 * machine over.
 */
export async function renderPage(url: string, opts: RenderPageOptions): Promise<RenderPageResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const elapsed = () => now() - started;

  const impl = opts.renderImpl ?? defaultRenderImpl;

  let rendered: { html: string; finalUrl: string };
  try {
    rendered = await impl(url, timeoutMs, opts.userAgent);
  } catch (err) {
    return { ok: false, ...classifyRenderError(err), elapsedMs: elapsed() };
  }

  const text = renderedTextOf(rendered.html);
  if (text.length === 0) {
    return {
      ok: false,
      reason: "render_empty",
      detail: `rendered ${rendered.html.length}B, 0 visible chars`,
      elapsedMs: elapsed(),
    };
  }

  return { ok: true, html: rendered.html, text, finalUrl: rendered.finalUrl, elapsedMs: elapsed() };
}

/**
 * Map a thrown render error to a named reason. PURE.
 *
 * `renderer_unavailable` is separated from every site-side failure on purpose:
 * it means THIS MACHINE cannot render, so a caller must not record anything
 * about the producer — not a strike, not a verification stamp, nothing. Every
 * other reason is a statement about the site (or the attempt).
 *
 * Covers two shapes now: the local `playwright-core` errors this always
 * handled, and `render-client.ts`'s thrown messages for the worker path
 * (`render-worker <status>: <body>`, `RENDER_WORKER_KEY env var not set`,
 * plain `fetch failed`, or an `AbortError` from the client-side timeout).
 * Once `RENDER_WORKER_KEY` is configured, a worker-side failure is a REAL
 * render failure about that page/attempt — it must land in one of the
 * timeout/navigation/unknown buckets below, never `renderer_unavailable`.
 * The one exception is `RENDER_WORKER_KEY env var not set`: only reachable by
 * racing the env var away between `selectRenderBackend()` picking "worker"
 * and `render-client.ts`'s own guard running, which genuinely does mean this
 * attempt had no backend at all — `renderer_unavailable` is the sane bucket
 * for that message specifically, not for any other worker failure.
 */
export function classifyRenderError(err: unknown): { reason: RenderFailureReason; detail: string } {
  const e = err as { name?: string; message?: string; code?: string };
  const probe = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`;
  const detail = String(e?.message ?? e?.name ?? "error").slice(0, 120);

  if (
    /PLAYWRIGHT_UNAVAILABLE|Cannot find module|ERR_MODULE_NOT_FOUND|browserType\.launch|RENDER_WORKER_KEY env var not set/i.test(
      probe,
    )
  ) {
    return { reason: "renderer_unavailable", detail };
  }
  // render-worker 504 = the worker's own navigation-timeout response
  // (render-worker/src/index.ts classifies its page.goto timeout as 504).
  if (/render-worker 504|Timeout|timed out|TimeoutError|AbortError/i.test(probe)) {
    return { reason: "render_timeout", detail };
  }
  // render-worker 502 = the worker's own navigation-failed response (DNS,
  // TLS, refused — everything page.goto threw that wasn't a timeout).
  if (/render-worker 502|net::|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|navigation/i.test(probe)) {
    return { reason: "render_navigation_failed", detail };
  }
  return { reason: "unknown", detail };
}

/**
 * The real render path. Branches on `selectRenderBackend()`:
 *   - "worker": delegate to the already-live render-worker via
 *     render-client.ts. No browser touches this process.
 *   - "local": the original playwright-core path, unchanged.
 */
async function defaultRenderImpl(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ html: string; finalUrl: string }> {
  if (selectRenderBackend() === "worker") {
    // Same `domcontentloaded` preference as the local branch below, and for
    // the identical reason: producer sites routinely hold a socket open
    // (chat widgets, analytics beacons) and never reach networkidle.
    //
    // `user_agent: userAgent` matters: every caller of this module's
    // renderPage() (marketplace.ts, admin-rfb-website-discovery.ts) passes a
    // specific UA precisely so the render looks like the SAME client as
    // that caller's own plain fetch, not a different crawler, to the target
    // site — see marketplace.ts's comment directly above its UA constant.
    // Dropping it here would silently defeat that for every worker-backed
    // render.
    //
    // Deploy caveat, load-bearing: render-worker/ is a SEPARATE Fly app
    // (`lokal-render-worker`), deployed only by a manual
    // `fly deploy --config render-worker/fly.toml --dockerfile
    // render-worker/Dockerfile` — it is NOT auto-deployed by this repo's
    // `git push origin main` → GitHub Actions pipeline (only the main
    // `lokal` app is). So this UA plumbing is real, correct, and forward-
    // compatible today, but the override will not actually take effect in
    // production until someone with Fly credentials manually redeploys
    // render-worker/. Until then, the worker keeps using its own default
    // USER_AGENT constant (render-worker/src/index.ts) — identical to
    // today's behaviour, not a regression, but also not yet the fix.
    const result = await callRenderWorker(url, {
      timeout_ms: timeoutMs,
      wait_for: "domcontentloaded",
      user_agent: userAgent,
    });
    return { html: result.html, finalUrl: result.final_url };
  }
  return defaultLocalRenderImpl(url, timeoutMs, userAgent);
}

/**
 * The local browser path. Imported lazily so that merely loading this
 * module — which the server does — never requires playwright-core to exist.
 * Unchanged by the worker-backend addition above; still the dev/sandbox
 * fallback for an environment with no RENDER_WORKER_KEY configured.
 */
async function defaultLocalRenderImpl(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ html: string; finalUrl: string }> {
  let chromium: any;
  try {
    // The specifier is built at runtime, NOT written as a literal, and that is
    // load-bearing rather than stylistic: `await import("playwright-core")`
    // makes TypeScript resolve the module at COMPILE time, so `npx tsc` fails
    // with TS2307 anywhere the package is absent — which is every clean
    // install, including CI and the production build. This module's whole
    // premise is that it ships inert without the dependency; a version that
    // cannot compile without it breaks the build instead. (Caught by CI on
    // slookisen/lokal#573 after a local typecheck passed only because a
    // --no-save install had left the package lying around.)
    const spec = "playwright-core";
    ({ chromium } = await import(spec));
  } catch {
    throw new Error("PLAYWRIGHT_UNAVAILABLE: playwright-core is not installed in this environment");
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

  // Honour the ambient egress proxy. Node's fetch (and therefore fetch-page.ts)
  // picks HTTPS_PROXY up from the environment, but a browser does not — it
  // opens its own sockets. Without this, a sandboxed/corporate environment
  // renders every page as ERR_CONNECTION_RESET while the plain fetcher on the
  // same machine succeeds, which reads as "the site is broken" and would get
  // recorded against the producer. Measured exactly that on 2026-08-13 before
  // this branch existed.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || undefined;

  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxyServer ? { proxy: { server: proxyServer, ...(noProxy ? { bypass: noProxy } : {}) } } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();
    // `domcontentloaded` then a short settle beats `networkidle`: producer
    // sites routinely hold a socket open (chat widgets, analytics beacons) and
    // never reach networkidle, which would burn the whole timeout on a page
    // that finished painting in a second.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1_500);
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } finally {
    await browser.close().catch(() => {});
  }
}

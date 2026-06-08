// ─── bondensmarked-source.ts (orchestrator PR-123/PR-124, 2026-06-06) ─────────
//
// Server-side canonical-source module for Bondens marked (BM).
//
// Policy (Daniel): bondensmarked.no/lokallag is the single source of truth
// (fasit) for all BM lokallag, market days, and market places.
//
// This module is intentionally dependency-light — no new npm packages.
// Parsing uses the same regex/string approach as bm-events-scraper.ts.
//
// The live fetch will work in prod (not sandbox-restricted). For dev/tests,
// validate by passing saved HTML directly to parseBmLokallagHtml() or
// parseBmLokallagDetailHtml().
//
// ─── Structural anchors (INDEX page /lokallag) ────────────────────────────────
//   NAME  : <p class="font-semibold leading-tight line-clamp-1">NAME</p>
//   SLUG  : <a … href="/lokallag/SLUG">
//   COUNTS: (\d+)<!-- --> <!-- -->(markeder|markedsplasser|produsenter|marked)
//   DATE  : <span … class="text-xl font-bold leading-none block">13.</span>
//            + <span … tracking-wide text-muted-foreground">JUN</span>
//           + <p class="text-xs text-muted-foreground">Neste marked</p>
//            + <p class="text-sm font-medium line-clamp-1">VENUE NAME</p>
//   PAUSED: body text contains "legge driften på is" (Telemark)
//
// ─── Structural anchors (DETAIL page /lokallag/<slug>) ────────────────────────
//   MARKET DAYS:
//     anchor href : href="/markeder/TITLE-YYYY-MM-DD"  (ISO date in slug)
//     time        : class="text-base font-bold text-muted-foreground">10:00<!-- --> – <!-- -->17:00
//     title       : class="font-semibold tracking-tight line-clamp-1 text-lg">TITLE</h3>
//     place       : class="line-clamp-1">PLACE</span>  (first span after h3 in card)
//   MARKEDSPLASSER (preview, 3 shown on detail page):
//     href="/markedsplasser/SLUG", name class="font-semibold leading-tight line-clamp-1">NAME
//   LOKALLAG UUID (for full markedsplasser fetch):
//     href="/markedsplasser?lokallag=UUID"  (extracted to build full-list URL)
//   FULL MARKEDSPLASSER (/markedsplasser?lokallag=UUID page):
//     same card structure: class="font-semibold leading-tight line-clamp-1">NAME
//   PRODUSENTER count:
//     Produsenter (<!-- -->N<!-- -->) in rendered HTML
//
// TODO PR-125: wire fetchBmLokallagDetail() into the daily bm-events-scraper
//   to auto-correct event start/end times and auto-create missing markedsplasser.
//   The mutations belong in the scraper, not here — this module stays read-only.

const BM_BASE_URL = "https://bondensmarked.no";
const BM_LOKALLAG_URL = `${BM_BASE_URL}/lokallag`;
const FETCH_TIMEOUT_MS = 15_000;

// PR-125: lokallag slugs are interpolated into bondensmarked.no URLs. Validate
// before any fetch to prevent path-traversal / URL injection once the daily
// scraper starts calling fetchBmLokallagDetail() with slugs from the index page.
const LOKALLAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
export function isValidLokallagSlug(slug: unknown): slug is string {
  return typeof slug === "string" && LOKALLAG_SLUG_RE.test(slug);
}

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface BmLokallag {
  /** Display name exactly as shown on bondensmarked.no */
  name: string;
  /** URL slug, e.g. "oslo-og-omegn" */
  slug: string;
  /** Canonical URL, e.g. "https://bondensmarked.no/lokallag/oslo-og-omegn" */
  url: string;
  /** Number of upcoming/total markets listed on the canonical page */
  markeder: number;
  /** Number of producers listed on the canonical page */
  produsenter: number;
  /** Number of market places listed on the canonical page */
  markedsplasser: number;
  /**
   * Next market date string as shown on the page, e.g. "13. JUN".
   * Undefined when the lokallag has no upcoming market (paused or off-season).
   */
  nesteMarked?: string;
  /**
   * true when the canonical page signals the lokallag is suspended
   * ("legge driften på is"). Currently: Telemark.
   */
  paused: boolean;
}

/** A single upcoming market day parsed from a lokallag detail page. */
export interface BmMarketDay {
  /** ISO date string, e.g. "2026-07-04" — extracted from the /markeder/SLUG href. */
  date: string;
  /**
   * PR-125: the full event slug from the /markeder/<slug> href, e.g.
   * "torvet-i-arendal-2026-07-04". This is the UNIQUE natural key the
   * bm-events scraper stores in bm_market_events.event_slug, so the daily
   * time-correction step can join exactly (no fuzzy matching).
   */
  eventSlug?: string;
  /**
   * Market-place / venue name as shown, e.g. "Arendal - Torvet, ARENDAL".
   * May include city suffix in all-caps separated by comma.
   */
  place: string;
  /** Start time, e.g. "10:00". Parsed from the rendered time element. */
  startTime?: string;
  /** End time, e.g. "15:00". Parsed from the rendered time element. */
  endTime?: string;
  /** Market event title, e.g. "Torvet i Arendal". */
  title?: string;
}

/** Per-lokallag detail parsed from bondensmarked.no/lokallag/<slug>. */
export interface BmLokallagDetail {
  /** The lokallag URL slug, e.g. "agder". */
  slug: string;
  /**
   * Full list of markedsplass names for this lokallag.
   * Populated by a second fetch to /markedsplasser?lokallag=<uuid>.
   * Falls back to the 3-item preview on the detail page if the second fetch fails.
   */
  markedsplasser: string[];
  /** All upcoming market days listed on the detail page, with real start/end times. */
  marketDays: BmMarketDay[];
  /** Number of produsenter as shown on the detail page. */
  produsenter?: number;
}

// ─── Fetch + parse: INDEX page ────────────────────────────────────────────────

/**
 * Fetches https://bondensmarked.no/lokallag server-side and returns the 14
 * parsed lokallag entries. Each entry is parsed in isolation (try/catch) so a
 * single malformed card never kills the whole list.
 *
 * NOT safe to call from a sandboxed environment — use parseBmLokallagHtml()
 * directly in tests/dev with a saved HTML string.
 */
export async function fetchBmLokallag(): Promise<BmLokallag[]> {
  const html = await bmFetch(BM_LOKALLAG_URL);
  return parseBmLokallagHtml(html);
}

/**
 * Pure parser — exposed for testing against saved HTML without a live fetch.
 */
export function parseBmLokallagHtml(html: string): BmLokallag[] {
  // ── Step 1: extract all href="/lokallag/<slug>" slugs in document order ──
  const slugRe = /href="\/lokallag\/([^"]+)"/g;
  const slugs: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = slugRe.exec(html)) !== null) {
    const s = sm[1];
    if (!slugs.includes(s)) slugs.push(s); // deduplicate (nav + cards)
  }

  // ── Step 2: extract all canonical names in document order ──
  // Anchor: <p class="font-semibold leading-tight line-clamp-1">NAME</p>
  const nameRe = /<p class="font-semibold leading-tight line-clamp-1">([^<]+)<\/p>/g;
  const names: string[] = [];
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(html)) !== null) {
    // Decode HTML entities (only & and common ones appear in the sample)
    names.push(decodeHtmlEntities(nm[1]));
  }

  if (slugs.length !== names.length) {
    console.warn(
      `[bondensmarked-source] slug count (${slugs.length}) ≠ name count (${names.length}); ` +
      `page structure may have changed. Proceeding with zip(min).`
    );
  }

  const results: BmLokallag[] = [];
  const count = Math.min(slugs.length, names.length);

  for (let i = 0; i < count; i++) {
    try {
      const slug = slugs[i];
      const name = names[i];

      // ── Isolate the card block for this slug ──
      const cardStart = html.indexOf(`href="/lokallag/${slug}"`);
      const nextSlug = slugs[i + 1];
      const cardEnd = nextSlug
        ? html.indexOf(`href="/lokallag/${nextSlug}"`, cardStart + 1)
        : html.length;
      const card = cardEnd > cardStart ? html.slice(cardStart, cardEnd) : html.slice(cardStart);

      // ── PAUSED: "legge driften på is" in card body ──
      const paused =
        card.includes("legge driften på is") ||
        card.includes("driften på is") ||
        card.includes("på is");

      // ── COUNTS: (\d+)<!-- --> <!-- -->(markeder|markedsplasser|produsenter|marked) ──
      // The React-rendered HTML injects <!-- --> between text nodes and the label.
      // NOTE: markedsplasser must appear before marked to prevent prefix match
      const countRe = /(\d+)<!-- -->\s*<!-- -->(markeder|markedsplasser|produsenter|marked)/g;
      let markeder = 0;
      let produsenter = 0;
      let markedsplasser = 0;
      let cm: RegExpExecArray | null;
      while ((cm = countRe.exec(card)) !== null) {
        const n = parseInt(cm[1], 10);
        const label = cm[2];
        if (label === "markeder" || label === "marked") markeder = n;
        else if (label === "produsenter") produsenter = n;
        else if (label === "markedsplasser") markedsplasser = n;
      }

      // ── NESTE MARKED date ──
      // Structure: <span …block">DD.</span><span …muted-foreground">MON</span>
      //            … <p …>Neste marked</p>
      // We parse: day span + month span, appear just before "Neste marked" label.
      let nesteMarked: string | undefined;
      const nesteIdx = card.indexOf("Neste marked</p>");
      if (nesteIdx !== -1) {
        // Walk back from "Neste marked" to find the day + month spans
        const before = card.slice(Math.max(0, nesteIdx - 600), nesteIdx);
        const dayM = /class="text-xl font-bold leading-none block">(\d+\.)<\/span>/.exec(before);
        const monM = /tracking-wide text-muted-foreground">([A-ZÆØÅ]{3})<\/span>/.exec(before);
        if (dayM && monM) {
          nesteMarked = `${dayM[1]} ${monM[1]}`;
        }
      }

      results.push({
        name,
        slug,
        url: `${BM_BASE_URL}/lokallag/${slug}`,
        markeder,
        produsenter,
        markedsplasser,
        nesteMarked,
        paused,
      });
    } catch (err) {
      console.error(
        `[bondensmarked-source] failed to parse entry ${i} (slug=${slugs[i]}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return results;
}

// ─── Fetch + parse: DETAIL page ───────────────────────────────────────────────

/**
 * Fetches https://bondensmarked.no/lokallag/<slug> server-side and returns the
 * full set of upcoming market days (with real start/end times) plus the
 * complete list of markedsplasser for that lokallag.
 *
 * Two HTTP GETs are made:
 *   1. https://bondensmarked.no/lokallag/<slug>          — market days + UUID
 *   2. https://bondensmarked.no/markedsplasser?lokallag=<uuid>  — full MP list
 *
 * Each section is wrapped in its own try/catch so a parsing failure in one
 * section never suppresses data from the other. Anomalies are console.warn'd.
 *
 * Returns a partial result (empty arrays / undefined) on shape change rather
 * than throwing — callers should check array lengths and log deviations.
 *
 * NOT safe to call from a sandboxed environment — use parseBmLokallagDetailHtml()
 * directly in tests/dev with a saved HTML string.
 */
export async function fetchBmLokallagDetail(slug: string): Promise<BmLokallagDetail> {
  // PR-125: reject malformed slugs before URL interpolation (path-traversal guard).
  if (!isValidLokallagSlug(slug)) {
    throw new Error(`fetchBmLokallagDetail: invalid lokallag slug ${JSON.stringify(slug)}`);
  }
  const url = `${BM_BASE_URL}/lokallag/${slug}`;
  const html = await bmFetch(url);
  return parseBmLokallagDetailHtml(slug, html);
}

/**
 * Pure parser for the lokallag detail page — exposed for testing without a
 * live fetch. Pass the saved HTML and the expected slug.
 *
 * When fullMpHtml is provided it is used for markedsplasser parsing instead
 * of making a second live fetch (useful in tests / CI).
 */
export async function parseBmLokallagDetailHtml(
  slug: string,
  html: string,
  fullMpHtml?: string,
): Promise<BmLokallagDetail> {
  // ── Section 1: Market days ──────────────────────────────────────────────────
  // Structural anchors (real Agder sample, 2026-06-07):
  //   href="/markeder/TITLE-YYYY-MM-DD" — ISO date embedded in URL slug
  //   class="text-base font-bold text-muted-foreground">10:00<!-- --> – <!-- -->17:00</p>
  //   class="font-semibold tracking-tight line-clamp-1 text-lg">TITLE</h3>
  //   class="line-clamp-1">PLACE, CITY</span>  (first match after h3 within card)
  const marketDays: BmMarketDay[] = [];
  try {
    // Each market event card is an <a href="/markeder/..."> anchor.
    // We capture: ISO date from href, time string, title, and place in one pass.
    const eventRe =
      /href="\/markeder\/([^"]*?(\d{4}-\d{2}-\d{2}))"[^>]*>[\s\S]*?class="text-base font-bold text-muted-foreground">([\s\S]*?)<\/p>[\s\S]*?class="font-semibold tracking-tight line-clamp-1 text-lg">([\s\S]*?)<\/h3>[\s\S]*?class="line-clamp-1">([\s\S]*?)<\/span>/g;
    let em: RegExpExecArray | null;
    while ((em = eventRe.exec(html)) !== null) {
      const eventSlug = em[1];
      const date = em[2];
      const rawTime = em[3];
      const title = decodeHtmlEntities(stripHtmlTags(em[4]).trim());
      const place = decodeHtmlEntities(stripHtmlTags(em[5]).trim());

      // Extract HH:MM times — strips React HTML comments (<!-- -->) reliably
      const times = rawTime.match(/\d{2}:\d{2}/g) ?? [];
      const startTime = times[0];
      const endTime = times[1];

      if (!date) continue; // paranoia guard
      marketDays.push({ date, eventSlug, place, startTime, endTime, title: title || undefined });
    }

    if (marketDays.length === 0) {
      console.warn(`[bondensmarked-source] detail(${slug}): no market days found — page structure may have changed`);
    }
  } catch (err) {
    console.warn(`[bondensmarked-source] detail(${slug}): market-day parsing failed:`, err instanceof Error ? err.message : String(err));
  }

  // ── Section 2: Produsenter count ───────────────────────────────────────────
  // Rendered: "Produsenter (<!-- -->19<!-- -->)" from React children array
  let produsenter: number | undefined;
  try {
    const prodM = /Produsenter \(<!-- -->(\d+)<!-- -->\)/.exec(html);
    if (prodM) {
      produsenter = parseInt(prodM[1], 10);
    } else {
      console.warn(`[bondensmarked-source] detail(${slug}): produsenter count not found`);
    }
  } catch (err) {
    console.warn(`[bondensmarked-source] detail(${slug}): produsenter extraction failed:`, err instanceof Error ? err.message : String(err));
  }

  // ── Section 3: Markedsplasser (full list via lokallag UUID) ────────────────
  // The detail page previews only ~3 markedsplasser. The full list lives at:
  //   /markedsplasser?lokallag=<uuid>
  // The UUID is embedded in the "Se alle" button:
  //   href="/markedsplasser?lokallag=UUID"
  let markedsplasser: string[] = [];
  try {
    // Extract lokallag UUID from the "Se alle" markedsplasser link
    const uuidM = /href="\/markedsplasser\?lokallag=([a-f0-9-]{36})"/.exec(html);
    const lokallagUuid = uuidM?.[1];

    if (lokallagUuid) {
      // Fetch the full markedsplasser list (second request)
      let mpHtml: string;
      if (fullMpHtml) {
        mpHtml = fullMpHtml; // test override
      } else {
        try {
          mpHtml = await bmFetch(`${BM_BASE_URL}/markedsplasser?lokallag=${lokallagUuid}`);
        } catch (fetchErr) {
          console.warn(
            `[bondensmarked-source] detail(${slug}): markedsplasser fetch failed, falling back to preview:`,
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          );
          // Fall back to the preview names on the detail page itself
          markedsplasser = parseMpPreviewFromDetailHtml(html);
          return { slug, markedsplasser, marketDays, produsenter };
        }
      }
      // PR-125: single parse covers both the test override (fullMpHtml) and the
      // live-fetch path; the earlier in-branch parse was dead (immediately overwritten).
      markedsplasser = parseMpListHtml(mpHtml ?? fullMpHtml ?? "");
      if (markedsplasser.length === 0) {
        console.warn(`[bondensmarked-source] detail(${slug}): full markedsplasser list empty — falling back to preview`);
        markedsplasser = parseMpPreviewFromDetailHtml(html);
      }
    } else {
      console.warn(`[bondensmarked-source] detail(${slug}): lokallag UUID not found, falling back to preview markedsplasser`);
      markedsplasser = parseMpPreviewFromDetailHtml(html);
    }
  } catch (err) {
    console.warn(`[bondensmarked-source] detail(${slug}): markedsplasser section failed:`, err instanceof Error ? err.message : String(err));
    try {
      markedsplasser = parseMpPreviewFromDetailHtml(html);
    } catch { /* ignore secondary failure */ }
  }

  return { slug, markedsplasser, marketDays, produsenter };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Shared fetch helper — sets User-Agent + timeout, throws on non-2xx.
 * All fetches in this module go through here so no new deps are needed.
 */
async function bmFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`bmFetch: HTTP ${res.status} from ${url}`);
  }
  return res.text();
}

/**
 * Parses the full markedsplasser list from the /markedsplasser?lokallag=<uuid> page.
 * Cards share the same structure as the preview on the detail page.
 * Anchor: <p class="font-semibold leading-tight line-clamp-1">NAME</p>
 */
function parseMpListHtml(html: string): string[] {
  const names: string[] = [];
  // Same card title class as index page lokallag names, but scoped to marketplace cards
  const mpRe = /href="\/markedsplasser\/[^"]*"[\s\S]*?class="font-semibold leading-tight line-clamp-1">([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = mpRe.exec(html)) !== null) {
    const name = decodeHtmlEntities(stripHtmlTags(m[1]).trim());
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Parses the 3-item markedsplasser preview embedded in the lokallag detail page.
 * Used as fallback when the full /markedsplasser?lokallag= fetch fails.
 */
function parseMpPreviewFromDetailHtml(html: string): string[] {
  // PR-125: the detail-page preview cards share the exact card structure as the
  // full /markedsplasser?lokallag= list, so delegate to the shared parser
  // instead of duplicating the regex (was byte-identical to parseMpListHtml).
  return parseMpListHtml(html);
}

/** Strip HTML tags (for cleaning RSC-generated text fragments). */
function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/<!--.*?-->/gs, "");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

// ─── bondensmarked-source.ts (orchestrator PR-123, 2026-06-06) ────────────────
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
// validate by passing saved HTML directly to parseBmLokallagHtml().
//
// Structural anchors keyed on from the real /lokallag sample HTML:
//   NAME  : <p class="font-semibold leading-tight line-clamp-1">NAME</p>
//   SLUG  : <a … href="/lokallag/SLUG">
//   COUNTS: (\d+)<!-- --> <!-- -->(markeder|markedsplasser|produsenter|marked)
//   DATE  : <span … class="text-xl font-bold leading-none block">13.</span>
//            + <span … tracking-wide text-muted-foreground">JUN</span>
//           + <p class="text-xs text-muted-foreground">Neste marked</p>
//            + <p class="text-sm font-medium line-clamp-1">VENUE NAME</p>
//   PAUSED: body text contains "legge driften på is" (Telemark)
//
// TODO PR-124: per-lokallag DETAIL-page parsing (full market-day times,
//   individual markedsplasser lists). We don't have a detail-page HTML
//   sample yet — slot parser here once the sample is available.

const BM_LOKALLAG_URL = "https://bondensmarked.no/lokallag";
const FETCH_TIMEOUT_MS = 15_000;

// ─── Public interface ─────────────────────────────────────────────────────────

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

// ─── Fetch + parse ────────────────────────────────────────────────────────────

/**
 * Fetches https://bondensmarked.no/lokallag server-side and returns the 14
 * parsed lokallag entries. Each entry is parsed in isolation (try/catch) so a
 * single malformed card never kills the whole list.
 *
 * NOT safe to call from a sandboxed environment — use parseBmLokallagHtml()
 * directly in tests/dev with a saved HTML string.
 */
export async function fetchBmLokallag(): Promise<BmLokallag[]> {
  const res = await fetch(BM_LOKALLAG_URL, {
    redirect: "follow",
    headers: {
      "User-Agent": "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`fetchBmLokallag: HTTP ${res.status} from ${BM_LOKALLAG_URL}`);
  }
  const html = await res.text();
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
        url: `https://bondensmarked.no/lokallag/${slug}`,
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

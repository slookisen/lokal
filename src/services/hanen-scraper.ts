// ─── Hanen member scraper (Phase 5.11 C.2, 2026-05-16) ──────────────
//
// Hanen (https://hanen.no) is the Norwegian umbrella body for ~400-500
// farm-tourism / matagent members. Their /medlemmer page is a
// JS-rendered SPA — bare fetch returns the empty shell, so we MUST
// fetch through the lokal-render-worker (PR-57 Playwright service).
//
// Pipeline (one renderPage() call per scrape run, by design):
//   1. fetchHanenListing()    — render hanen.no/medlemmer, return HTML
//   2. parseHanenMembers()    — regex-extract per-member name/location/
//                               website/category from the rendered HTML.
//                               Falls back to embedded JSON if Hanen
//                               ships its member list as a __NEXT_DATA__
//                               blob; otherwise greps anchor structures.
//   3. matchHanenMemberToAgent() — Dice-coefficient ≥ 0.85 fuzzy match
//                               against the agents table.
//   4. runHanenScraper()      — orchestrates 1+2+3, idempotent-upserts
//                               agent_affiliations(source='inferred')
//                               for matched members, logs unmatched
//                               into hanen_unmatched_members.
//
// Constraints (from the C.2 brief):
//   - ONE renderPage() call (no per-member detail-page loops).
//   - Up to 5 pages if Hanen paginates server-side; today their
//     /medlemmer view is a single infinite-scroll page so this is
//     usually 1 call.
//   - Total wall time < 120s (Fly proxy limit on admin endpoint).
//   - NO new producer agents are created. Unmatched members go to
//     hanen_unmatched_members for the Phase B.2-equivalent later.
//   - NO new external deps — regex parsing on the returned HTML string.

import { getDb } from "../database/init";
import { renderPage } from "./render-client";
import { nameSimilarity, nameVariants } from "./name-matcher";
import { cityToFylke, fylkerMatch, normaliseFylke } from "./norway-fylke";
import { parseNameLocationSuffix, normaliseDomain, domainsMatch } from "./location-suffix-parser";

const LISTING_URL = "https://hanen.no/medlemmer";

// Match-score cut-off. Conservative on purpose: false positives create
// wrong umbrella claims which damage Hanen's data quality more than a
// missed match (which just stays in hanen_unmatched_members for later
// review). 0.85 on Dice ≈ "two characters different in a 12-char name".
const MATCH_THRESHOLD = 0.85;

// PR-69 dual-corroboration cut-off. When BOTH the agent's name-suffix
// fylke AND the agent's city-derived fylke independently agree with
// the Hanen-side fylke, we can safely accept a lower Dice score —
// the two independent location signals provide the corroboration that
// MATCH_THRESHOLD = 0.85 was protecting against false positives for.
// 0.75 on Dice ≈ "a Norwegian name with an org-form ('Heim Gård AS')
// vs the bare farm-name ('Heim Gard')".
const DUAL_CORROBORATION_THRESHOLD = 0.75;

// renderPage default is 30s — Hanen's SPA cold-loads slowly, especially
// behind their Cloudflare front. 60s leaves ample headroom inside the
// 120s Fly admin endpoint cap (60s render + 30s parse/match/upsert + slack).
const RENDER_TIMEOUT_MS = 60000;

// Default ceiling on pages to crawl. Hanen's /medlemmer ships ~50
// members per WordPress page, total membership ~590, so a full sweep
// needs ~12 pages. We default to 5 (one HTTP call ≈ 60s render * 5 ~=
// 5min, well past Fly's 120s proxy cap — see HANEN_MAX_PAGES_HARD_CAP
// note below for why this is still fire-and-forget territory).
const MAX_PAGES = 5;

// Hard cap on the ?max_pages query param. Above 20 the cumulative
// wall time (~20min) is well past any HTTP deadline; the server keeps
// running after Fly cuts the response but callers can no longer see
// progress. 20 was chosen as enough to comfortably cover the full
// ~590-member Hanen corpus (~12 pages) with safety margin.
const MAX_PAGES_HARD_CAP = 20;

// PR-65 (2026-05-17): max value for the ?start_page=N offset param.
// Hanen ships ~12 pages today; 100 leaves comfortable headroom for
// growth without admitting "scroll the entire EU" requests.
const MAX_START_PAGE = 100;

export type HanenMemberRecord = {
  parsed_name: string;
  parsed_location: string;        // kommune + fylke as a single string
  parsed_website: string | null;
  parsed_category: string | null;
  source_url: string;
};

export type HanenScrapeResult = {
  success: boolean;
  fetched: number;                // raw HTML pages fetched (typically 1)
  parsed: number;                 // distinct members extracted from HTML
  matched: number;                // members matched ≥ MATCH_THRESHOLD (HIGH+MEDIUM)
  matched_high: number;           // PR-64: HIGH-confidence matches only
  review_required: number;        // PR-64: MEDIUM-confidence matches (auto-attached as review_required, or pending_confirmation+evidence flag if widening unavailable)
  rejected_location_mismatch: number; // PR-64: matches above-threshold but rejected on fylke conflict
  unmatched: number;              // members logged to unmatched table (below-threshold)
  upserted: number;               // agent_affiliations rows written
  errors: string[];
};

// ─── matcher verdict types (PR-64) ─────────────────────────────
// PR-64 widened the single-signal { name_dice | below_threshold } verdict
// to a multi-signal scorer that combines name-Dice + location-fylke
// agreement and emits one of seven methods with a HIGH/MEDIUM/null
// confidence tier.
//
// Confidence semantics:
//   "high"   → auto-attach as pending_confirmation, no human required.
//   "medium" → attach as review_required (or pending_confirmation +
//              evidence_json.match_confidence='medium' as fallback) so
//              admin UI can surface it for triage.
//   null     → no match emitted; logged to hanen_unmatched_members.
export type MatchConfidence = "high" | "medium" | null;

export type MatchVerdict = {
  agent_id: string | null;
  score: number;
  method:
    | "exact_name_with_location"
    | "dice_high_with_location"
    | "dice_high_no_location"
    | "dice_medium_with_location"
    | "below_threshold"
    | "location_mismatch_rejection"
    // PR-67: new signal-based promotions (all confidence="high")
    | "domain_match_exact"
    | "domain_match_with_dice_high"
    | "fylke_match_with_dice_high"
    | "name_suffix_location_match"
    // PR-69: dual-corroboration fylke match — Dice >= 0.75 with BOTH
    // name-suffix-fylke AND city-fylke agreeing with Hanen-side fylke.
    | "fylke_dual_corroboration";
  confidence: MatchConfidence;
  location_check: "match" | "mismatch" | "unknown";
};

// Backwards-compat alias for callers/tests that imported the old name.
// The old discriminated union is retained as a structural subset of the
// new MatchVerdict (agent_id + score + method) so existing test code
// continues to compile.
export type HanenMatchVerdict = MatchVerdict;

// ─── 1. fetchHanenListing ──────────────────────────────────────
// Renders hanen.no/medlemmer through the render-worker. Returns the
// raw HTML (a single string per page). If `maxPages` > 1 we naively
// try ?page=2..N; the parser also handles "all members in one page".
//
// The renderer override is exposed for tests so they can avoid the
// real worker call (and to keep the unit tests deterministic).
export async function fetchHanenListing(
  opts?: {
    maxPages?: number;
    startPage?: number;
    renderer?: (url: string) => Promise<string>;
  }
): Promise<{ pages: Array<{ url: string; html: string }>; errors: string[] }> {
  // Respect the caller's maxPages but never exceed the hard cap. The
  // default (MAX_PAGES) is conservative; admin callers ramp via
  // ?max_pages=N when running a one-off full sweep.
  const cap = Math.min(opts?.maxPages ?? MAX_PAGES, MAX_PAGES_HARD_CAP);

  // PR-65: support ?start_page=N offset so a full ~590-member sweep
  // can be chunked across multiple admin POSTs (each chunk stays under
  // Fly's 120s proxy limit). Default 1; clamp at MAX_START_PAGE.
  const rawStart = opts?.startPage ?? 1;
  const startPage = Math.min(
    Math.max(1, Number.isFinite(rawStart) && rawStart > 0 ? Math.floor(rawStart) : 1),
    MAX_START_PAGE,
  );
  const endPage = startPage + cap - 1; // inclusive

  const errors: string[] = [];
  const pages: Array<{ url: string; html: string }> = [];

  const render = opts?.renderer ?? (async (url: string) => {
    const r = await renderPage(url, {
      timeout_ms: RENDER_TIMEOUT_MS,
      wait_for: "networkidle",
    });
    return r.html;
  });

  // We always need page 1's HTML to detect whether pagination exists
  // (the <ul class="page-numbers"> block lives only on page 1). When
  // startPage === 1 we keep this page in the returned `pages` array;
  // when startPage > 1 we use it ONLY for the pagination-presence
  // sniff and do not surface it to the caller (the caller is asking
  // for a later slice and would otherwise re-process page 1 contents).
  let page1Html = "";
  try {
    page1Html = await render(LISTING_URL);
    if (startPage === 1) {
      pages.push({ url: LISTING_URL, html: page1Html });
    }
  } catch (e) {
    errors.push(`fetchHanenListing(page=1) failed: ${e instanceof Error ? e.message : String(e)}`);
    return { pages, errors };
  }

  // Hanen is a WordPress + Beaver Builder site (verified 2026-05-16):
  // pagination is /medlemmer/page/N/ (NOT ?page=N). Page 1 ships with a
  // <ul class="page-numbers"> block; absence means "this is already the
  // last page" → stop. We also bail on duplicate content (defensive vs.
  // CDN echo) and empty pages (<500 bytes is always a soft 404 here).
  const hasPagination = /class=["'][^"']*page-numbers/i.test(page1Html);
  if (hasPagination && endPage >= 2) {
    const firstExtra = Math.max(2, startPage);
    for (let n = firstExtra; n <= endPage; n++) {
      const url = `${LISTING_URL.replace(/\/$/, "")}/page/${n}/`;
      try {
        const html = await render(url);
        if (!html || html.length < 500 || html === page1Html) break;
        pages.push({ url, html });
      } catch (e) {
        errors.push(`fetchHanenListing(page=${n}) failed: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
  }

  return { pages, errors };
}

// ─── 2. parseHanenMembers ──────────────────────────────────────
// Extract members from a Hanen listing HTML string. Two strategies in
// priority order; first one with >0 hits wins:
//
//   (a) Embedded __NEXT_DATA__ JSON (Next.js apps often inline the full
//       props payload; if so we get clean fields).
//   (b) Regex over rendered DOM — Hanen ships each member as
//       <a href="/medlem/...">...</a> with name/location/category
//       inline. We match defensively against several plausible
//       layouts; tested against fixture HTML.
//
// Source-URL is the listing URL passed in (each member shares the same
// source_url for the scrape; per-member detail pages are intentionally
// NOT fetched per the C.2 brief).
export function parseHanenMembers(html: string, sourceUrl: string): HanenMemberRecord[] {
  if (!html || html.length < 200) return [];

  const seen = new Set<string>();
  const out: HanenMemberRecord[] = [];

  const pushUnique = (rec: HanenMemberRecord) => {
    const key = rec.parsed_name.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(rec);
  };

  // ── (a) Try __NEXT_DATA__ JSON first ──
  const nextDataRe = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/;
  const m = nextDataRe.exec(html);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      const candidates = collectMemberArrays(parsed);
      for (const c of candidates) {
        const rec = normaliseJsonMember(c, sourceUrl);
        if (rec) pushUnique(rec);
      }
    } catch {
      // Bad JSON — fall through to DOM parse.
    }
    if (out.length > 0) return out;
  }

  // ── (b) DOM/regex fallback for the real Hanen WordPress markup ──
  // Hanen is a Beaver-Builder WordPress site (verified 2026-05-16):
  // each member is rendered as a <div class="fl-post-grid-post ...
  // hanen_county-<fylke> hanen_member_type-<type> hanen_category-<cat>
  // hanen_regional_team-<region>"> wrapping itemtype="schema.org/CreativeWork"
  // markup. The member's detail URL is /bedrift/<slug>/. Class names
  // carry kommune/fylke/category — way more reliable than text parsing.
  //
  // We also keep a /medlem/ regex around so the test fixture (and any
  // future Hanen site redesign that switches URL schemes) keeps working.

  // Strategy A: full WordPress post-grid block.
  const postRe = /<div\s+class=["']([^"']*fl-post-grid-post[^"']*)["'][^>]*itemtype=["']https:\/\/schema\.org\/CreativeWork["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let post: RegExpExecArray | null;
  while ((post = postRe.exec(html)) !== null) {
    const classes = post[1];
    const inner = post[2];

    // Detail URL from the post itemid meta tag, falling back to the
    // first /bedrift/ link in the block.
    let detailUrl = "";
    const itemId = /itemid=["'](https?:\/\/[^"']*bedrift\/[^"']+)["']/i.exec(inner);
    if (itemId) detailUrl = itemId[1];
    if (!detailUrl) {
      const linkRe = /href=["'](https?:\/\/[^"']*\/bedrift\/[^"'/]+\/?)["']/i.exec(inner);
      if (linkRe) detailUrl = linkRe[1];
    }
    if (!detailUrl) detailUrl = sourceUrl;

    // Name from itemid `content="..."` (cleanest) or the visible <h2>.
    let name = "";
    const contentRe = /itemid=["'][^"']+["']\s+content=["']([^"']+)["']/i.exec(inner);
    if (contentRe) name = contentRe[1].trim();
    if (!name) {
      const titleRe = /<a[^>]+href=["'][^"']*\/bedrift\/[^"']+["'][^>]*title=["']([^"']+)["']/i.exec(inner);
      if (titleRe) name = titleRe[1].trim();
    }
    if (!name) {
      const h2Re = /<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(inner);
      if (h2Re) name = stripTags(h2Re[1]);
    }
    if (!name) continue;

    // Location: hanen_county-<fylke> on the wrapper div.
    let location = "";
    const countyMatch = /hanen_county-([a-z0-9-]+)/i.exec(classes);
    if (countyMatch) {
      // "hordaland" → "Hordaland"; "sogn-og-fjordane" → "Sogn og fjordane".
      location = countyMatch[1].replace(/-/g, " ");
      location = location.charAt(0).toUpperCase() + location.slice(1);
    }

    // Category: first hanen_category-<cat> class. We pick the first
    // because the order on the wrapper roughly matches Hanen's primary
    // tag (visit-confirmed by the structure of /utforsk/ filter pages).
    let category: string | null = null;
    const catMatch = /hanen_category-([a-z0-9-]+)/i.exec(classes);
    if (catMatch) {
      category = catMatch[1].replace(/-/g, " ");
      category = category.charAt(0).toUpperCase() + category.slice(1);
    }

    // PR-69: Website extraction from Strategy A. Hanen's WordPress
    // post-grid card often ships a "Besøk hjemmeside" / "Hjemmeside"
    // anchor or an `itemprop="url"` link pointing at the member's
    // own domain. We extract the FIRST external (non-hanen.no) link
    // from the inner block. If no such link is present, leave null
    // (downstream still records the member, just with no Signal C).
    const website = extractExternalWebsite(inner);

    pushUnique({
      parsed_name: name,
      parsed_location: location,
      parsed_website: website,
      parsed_category: category,
      source_url: detailUrl,
    });
  }
  if (out.length > 0) return out;

  // Strategy B: simpler href grep (test fixtures + /medlem/<id> legacy URLs).
  // Supports two URL forms: /medlem/<id> and /bedrift/<slug>. Inner block
  // is whatever is between the opening <a> and the closing </a> when the
  // anchor itself wraps the visible card.
  const cardRe = /<a[^>]+href=["'](\/medlem\/[^"']+|\/bedrift\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let card: RegExpExecArray | null;
  while ((card = cardRe.exec(html)) !== null) {
    const inner = card[2];
    const detailUrl = card[1].startsWith("http") ? card[1] : `https://hanen.no${card[1]}`;

    let name = "";
    const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/;
    const hm = headingRe.exec(inner);
    if (hm) {
      name = stripTags(hm[1]);
    } else {
      const txt = stripTags(inner).trim();
      const firstLine = txt.split(/\n+/)[0] || "";
      name = firstLine.trim();
    }
    if (!name) continue;

    let location = "";
    const locRe = /<(?:span|p|div)[^>]*class=["'][^"']*(?:location|kommune|fylke|place)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|p|div)>/i;
    const lm = locRe.exec(inner);
    if (lm) location = stripTags(lm[1]).trim();
    if (!location) {
      const after = stripTags(inner.replace(headingRe, "")).trim();
      const parenMatch = /\(([^)]+)\)/.exec(after);
      if (parenMatch) location = parenMatch[1].trim();
      else if (after.includes(",")) location = after.split(",").slice(0, 2).join(",").trim();
    }

    let category: string | null = null;
    const catRe = /<(?:span|div)[^>]*class=["'][^"']*(?:category|kategori|type)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i;
    const cm = catRe.exec(inner);
    if (cm) category = stripTags(cm[1]).trim() || null;

    let website: string | null = null;
    const webRe = /href=["'](https?:\/\/(?!hanen\.no|www\.hanen\.no)[^"']+)["']/i;
    const wm = webRe.exec(inner);
    if (wm) website = wm[1];

    pushUnique({
      parsed_name: name,
      parsed_location: location,
      parsed_website: website,
      parsed_category: category,
      source_url: detailUrl,
    });
  }

  return out;
}

// ─── 3. matchHanenMemberToAgent (PR-64: location-aware multi-signal) ──
// PR-64 hardening:
//   - Generate multiple normalised variants of each name (org/farm
//     suffix stripped, first-word fallback) and take the MAX Dice over
//     the cross product. Pulls "Heim Gård AS" ↔ "Heim Gardsbutikk"
//     above threshold without weakening the global cut-off.
//   - Compare member.parsed_location (a fylke string from Hanen's
//     hanen_county-<fylke> class) against the agent's city
//     (mapped through cityToFylke()). location_check ∈ {match,
//     mismatch, unknown}.
//   - Decision tree (in order, first hit wins):
//       Dice == 1.0 AND location match  → HIGH  exact_name_with_location
//       Dice ≥ 0.95  AND location match  → HIGH  dice_high_with_location
//       Dice ≥ 0.95  AND location mismatch → REJECT location_mismatch_rejection
//       Dice ≥ 0.95  AND location unknown  → MEDIUM dice_high_no_location
//       Dice ≥ 0.85  AND location match  → MEDIUM dice_medium_with_location
//       Dice ≥ 0.85  AND location mismatch → REJECT location_mismatch_rejection
//       otherwise                          → null  below_threshold
//
// The 0.95 + mismatch and 0.85 + mismatch REJECTs are the false-positive
// defense: Norwegian farm names recur across the country ("Liset Gård"
// in both Oslo and Trøndelag). Dice alone would auto-attach to the
// wrong family.
//
// O(N · M · |variants|²) — for the typical 50 members × ~1500 producers
// × ~4 variants per side = ~1.2M Dice calls per scrape run. Each Dice
// is O(L) on the bigrams, L ~= 15 chars → still well under 1s wall.
export function matchHanenMemberToAgent(
  member: HanenMemberRecord,
  agents: Array<{ id: string; name: string; city: string | null; website?: string | null }>
): MatchVerdict {
  // Member-side: variants of the parsed Hanen name + fylke from the
  // hanen_county-<fylke> class (or empty string if unknown).
  const memberVariants = nameVariants(member.parsed_name);
  const memberFylke = normaliseFylke(member.parsed_location);
  // PR-67 signal A — parse the Hanen member's name for a trailing
  // location-suffix ("Foo — Sandane"). Used when the parsed_location
  // from class-attribute fallback is empty.
  const memberNameSuffix = parseNameLocationSuffix(member.parsed_name).location_hint;
  const memberFylkeFromSuffix = memberFylke ?? normaliseFylke(memberNameSuffix || "");
  // PR-67 signal C — Hanen member-side website (domain only).
  const memberDomain = normaliseDomain(member.parsed_website);

  // PR-67 — per-candidate signals so the decision tree can emit the new
  // method values. We collect:
  //   - locationCheck   : strict city → fylke vs member fylke
  //   - suffixLocCheck  : member name-suffix fylke vs agent city/suffix fylke
  //   - fylkeFallback   : either-side fylke match including suffix hints
  //   - domainCheck     : agent_knowledge.website domain == member website domain
  // PR-67 iter2 P1-2: a small Dice boost given to candidates whose
  // domain matches the Hanen-member's parsed_website. This breaks ties
  // and slight Dice inversions so that domain-corroborated candidates
  // out-rank a marginally-higher-Dice candidate without a domain match.
  // 0.05 is tuned to flip a (0.94 domain) over a (0.96 no-domain) but
  // not flip a (0.85 domain) over a (0.95 no-domain).
  const DOMAIN_BOOST = 0.05;

  let best: {
    id: string;
    score: number;
    rankKey: number;
    locationCheck: "match" | "mismatch" | "unknown";
    fylkeFallback: "match" | "mismatch" | "unknown";
    suffixLocCheck: "match" | "mismatch" | "unknown";
    domainCheck: "match" | "unknown";
    // PR-69: dual-corroboration — TRUE when the agent has BOTH a
    // name-suffix-derived fylke AND a city-derived fylke, AND both
    // point at the same fylke as the Hanen member-side fylke.
    dualCorroboration: "match" | "unknown";
  } | null = null;
  for (const a of agents) {
    const agentVariants = nameVariants(a.name);
    let bestForAgent = 0;
    for (const mv of memberVariants) {
      for (const av of agentVariants) {
        // Use raw diceCoefficient via nameSimilarity for symmetric
        // normalisation. Variants are already normalised so this is a
        // no-op normalise + Dice on bigrams.
        const s = nameSimilarity(mv, av);
        if (s > bestForAgent) bestForAgent = s;
      }
    }
    // Domain corroboration computed up-front so it can boost rankKey.
    const candidateDomainMatch = domainsMatch(a.website, member.parsed_website);
    const rankKey = bestForAgent + (candidateDomainMatch ? DOMAIN_BOOST : 0);
    if (!best || rankKey > best.rankKey) {
      // Strict locationCheck — same semantics as PR-64. memberFylke is
      // the Hanen-side fylke from hanen_county-<fylke>; agent fylke is
      // mapped from agents.city via cityToFylke().
      const agentFylke = cityToFylke(a.city);
      let locationCheck: "match" | "mismatch" | "unknown";
      if (memberFylke && agentFylke) {
        locationCheck = fylkerMatch(memberFylke, agentFylke) ? "match" : "mismatch";
      } else {
        locationCheck = "unknown";
      }

      // PR-67 signal A — agent-side name-suffix fylke. Parses the
      // agent's NAME for a trailing location-suffix ("Heim Gard —
      // Hemsedal") and resolves it via cityToFylke()/normaliseFylke().
      // This signal is reachable ONLY when the agent has a name-suffix
      // — it's the "agent's own name carries location evidence" path.
      const agentNameSuffix = parseNameLocationSuffix(a.name).location_hint;
      const agentFylkeFromAgentSuffix = agentNameSuffix
        ? (cityToFylke(agentNameSuffix) ?? normaliseFylke(agentNameSuffix))
        : null;

      // suffixLocCheck — fires only when BOTH sides carry name-suffix
      // evidence (member's parsed_name AND agent's name). This is
      // distinct from the broader fylkeFallback below so that branch B
      // is reachable independently. Note: in suffixLocCheck we
      // deliberately require the agent's fylke to come from its NAME
      // suffix (not its city), so that the "agent has city but no name
      // suffix" case routes to branch B instead.
      let suffixLocCheck: "match" | "mismatch" | "unknown" = "unknown";
      if (memberFylkeFromSuffix && agentFylkeFromAgentSuffix) {
        suffixLocCheck = fylkerMatch(memberFylkeFromSuffix, agentFylkeFromAgentSuffix) ? "match" : "mismatch";
      }

      // PR-67 signal B — fylke-fallback. Uses the agent's CITY-derived
      // fylke (cityToFylke(a.city)) against the member-side fylke (from
      // parsed_location OR name-suffix). Reachable when the agent has a
      // city but no name-suffix, and the strict locationCheck path was
      // "unknown" (e.g. member's parsed_location was empty so strict
      // path needed both signals). This covers the case suffixLocCheck
      // can't — agent's evidence is in agents.city, not its name.
      let fylkeFallback: "match" | "mismatch" | "unknown" = "unknown";
      if (memberFylkeFromSuffix && agentFylke) {
        fylkeFallback = fylkerMatch(memberFylkeFromSuffix, agentFylke) ? "match" : "mismatch";
      }

      // PR-67 signal C — domain corroboration. Agents pass website via
      // an optional `website` field (joined from agent_knowledge at
      // call-time). Hanen-member side uses `parsed_website`.
      const domainCheck: "match" | "unknown" = candidateDomainMatch ? "match" : "unknown";

      // PR-69 signal D — dual-corroboration. Requires the agent to
      // carry BOTH a name-suffix-derived fylke AND a city-derived
      // fylke, and BOTH must agree with the Hanen member-side fylke
      // (which itself comes from parsed_location OR member-name-suffix).
      // This is a stricter signal than the single-source fylke fallback,
      // so it justifies a lower Dice threshold (0.75 vs 0.85/0.95).
      let dualCorroboration: "match" | "unknown" = "unknown";
      if (
        memberFylkeFromSuffix &&
        agentFylkeFromAgentSuffix &&
        agentFylke &&
        fylkerMatch(memberFylkeFromSuffix, agentFylkeFromAgentSuffix) &&
        fylkerMatch(memberFylkeFromSuffix, agentFylke)
      ) {
        dualCorroboration = "match";
      }

      best = {
        id: a.id,
        score: bestForAgent,
        rankKey,
        locationCheck,
        fylkeFallback,
        suffixLocCheck,
        domainCheck,
        dualCorroboration,
      };
    }
  }

  if (!best) {
    return {
      agent_id: null,
      score: 0,
      method: "below_threshold",
      confidence: null,
      location_check: "unknown",
    };
  }

  const score = best.score;
  const loc = best.locationCheck;
  const fy = best.fylkeFallback;
  const sx = best.suffixLocCheck;
  const dom = best.domainCheck;

  // ── Decision tree — first matching rule wins ──
  // PR-67 introduces four new HIGH-confidence early-out rules ABOVE the
  // PR-64 tree so any of the new signals can promote MEDIUM → HIGH:
  //
  //   C. domain_match_exact          — Dice >= 0.95 AND domain match
  //   C. domain_match_with_dice_high — Dice >= MATCH_THRESHOLD AND domain match
  //   A. name_suffix_location_match  — Dice >= 0.95 AND name-suffix-fylke match
  //   B. fylke_match_with_dice_high  — Dice >= 0.95 AND fylke-fallback match
  //
  // Order: domain wins over location (a matching website is a stronger
  // signal than a fylke); within location, name-suffix wins over the
  // generic fylke-fallback because the suffix is a per-agent assertion.

  // C. Domain match — strongest new signal. PR-67 iter2 P0-1: gated on
  // loc !== "mismatch" so a domain hit does NOT override a strict fylke
  // mismatch. A shared/franchise hosting domain colliding with a
  // producer in the wrong fylke must fall through to the
  // location_mismatch_rejection branch below.
  if (score >= MATCH_THRESHOLD && dom === "match" && loc !== "mismatch") {
    return {
      agent_id: best.id,
      score,
      method: score >= 0.95 ? "domain_match_exact" : "domain_match_with_dice_high",
      confidence: "high",
      location_check: loc,
    };
  }

  // A. Name-suffix-derived fylke match (Dice >= 0.95, MEDIUM tier).
  // Only fires when strict locationCheck is "unknown" (city missing) AND
  // suffix-derived fylke check matches. Mismatched suffix is NOT a
  // rejection signal (the suffix is heuristic; let dice_high_no_location
  // still produce MEDIUM).
  if (score >= 0.95 && loc === "unknown" && sx === "match") {
    return {
      agent_id: best.id,
      score,
      method: "name_suffix_location_match",
      confidence: "high",
      location_check: loc,
    };
  }

  // B. Fylke-fallback match (Dice >= 0.95, MEDIUM tier). Fires when
  // strict locationCheck is "unknown" but the broader fallback (any
  // side's fylke from city OR suffix) matches. Same caveat as (A): we
  // don't promote-reject on fallback mismatch.
  if (score >= 0.95 && loc === "unknown" && fy === "match") {
    return {
      agent_id: best.id,
      score,
      method: "fylke_match_with_dice_high",
      confidence: "high",
      location_check: loc,
    };
  }

  // ── PR-64 decision tree (unchanged below) ──
  if (score === 1.0 && loc === "match") {
    return {
      agent_id: best.id,
      score,
      method: "exact_name_with_location",
      confidence: "high",
      location_check: loc,
    };
  }
  if (score >= 0.95 && loc === "match") {
    return {
      agent_id: best.id,
      score,
      method: "dice_high_with_location",
      confidence: "high",
      location_check: loc,
    };
  }
  if (score >= 0.95 && loc === "mismatch") {
    return {
      agent_id: null,
      score,
      method: "location_mismatch_rejection",
      confidence: null,
      location_check: loc,
    };
  }
  if (score >= 0.95 && loc === "unknown") {
    return {
      agent_id: best.id,
      score,
      method: "dice_high_no_location",
      confidence: "medium",
      location_check: loc,
    };
  }

  // PR-69 signal D — dual-corroboration. Placed BEFORE the MEDIUM-tier
  // fall-throughs (dice_medium_with_location, location_mismatch_rejection
  // at 0.85, below_threshold) so it can promote MEDIUM → HIGH and rescue
  // Dice [0.75, 0.85) cases that would otherwise drop to below_threshold.
  // Requires BOTH the agent's name-suffix-derived fylke AND the agent's
  // city-derived fylke to agree with the Hanen-side fylke — two
  // independent location signals + Dice >= 0.75. By construction the
  // agent fylke must equal the member fylke, so locationCheck cannot
  // be "mismatch" here; the guard is purely defensive.
  const dc = best.dualCorroboration;
  if (
    score >= DUAL_CORROBORATION_THRESHOLD &&
    dc === "match" &&
    loc !== "mismatch"
  ) {
    return {
      agent_id: best.id,
      score,
      method: "fylke_dual_corroboration",
      confidence: "high",
      location_check: loc,
    };
  }

  if (score >= MATCH_THRESHOLD && loc === "match") {
    return {
      agent_id: best.id,
      score,
      method: "dice_medium_with_location",
      confidence: "medium",
      location_check: loc,
    };
  }
  if (score >= MATCH_THRESHOLD && loc === "mismatch") {
    return {
      agent_id: null,
      score,
      method: "location_mismatch_rejection",
      confidence: null,
      location_check: loc,
    };
  }
  // Below threshold — no match, but the score is preserved so the
  // unmatched-table row can record how close we got.
  return {
    agent_id: null,
    score,
    method: "below_threshold",
    confidence: null,
    location_check: loc,
  };
}

// ─── 4. runHanenScraper ────────────────────────────────────────
// Top-level pipeline. Idempotent on (producer_id, umbrella_id) — the
// underlying UNIQUE constraint plus INSERT OR IGNORE keeps reruns
// harmless. Unmatched members upsert into hanen_unmatched_members on
// parsed_name (UNIQUE) so re-running just refreshes the last_seen_at.
export async function runHanenScraper(opts?: {
  maxPages?: number;
  startPage?: number;
  renderer?: (url: string) => Promise<string>;
}): Promise<HanenScrapeResult> {
  const result: HanenScrapeResult = {
    success: false,
    fetched: 0,
    parsed: 0,
    matched: 0,
    matched_high: 0,
    review_required: 0,
    rejected_location_mismatch: 0,
    unmatched: 0,
    upserted: 0,
    errors: [],
  };

  // Look up the Hanen umbrella agent. We key off NAME because we don't
  // have a stable slug column on agents — slugify(name) === "hanen-..."
  // is too brittle. The Hanen seed (seed-norway-expansion.ts) registers
  // "HANEN (Bygdeturisme & gardsmat)" — match either it OR the bare
  // "Hanen" string in case the seed naming is normalised later.
  const db = getDb();
  let umbrella: { id: string } | undefined;
  try {
    umbrella = db.prepare(
      "SELECT id FROM agents WHERE (LOWER(name) LIKE 'hanen%' OR LOWER(name) = 'hanen') AND umbrella_type IS NOT NULL LIMIT 1"
    ).get() as { id: string } | undefined;
    if (!umbrella) {
      // Fallback for old seeds: just match by name without requiring
      // umbrella_type (Hanen was originally registered as role=quality).
      umbrella = db.prepare(
        "SELECT id FROM agents WHERE LOWER(name) LIKE 'hanen%' LIMIT 1"
      ).get() as { id: string } | undefined;
    }
  } catch (e) {
    result.errors.push(`Hanen umbrella lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  if (!umbrella) {
    result.errors.push("Hanen umbrella agent not found in agents table — seed required");
    return result;
  }

  // 1. Fetch (render-worker).
  const { pages, errors: fetchErrors } = await fetchHanenListing({
    maxPages: opts?.maxPages,
    startPage: opts?.startPage,
    renderer: opts?.renderer,
  });
  result.fetched = pages.length;
  result.errors.push(...fetchErrors);
  if (pages.length === 0) {
    return result;
  }

  // 2. Parse all pages, de-dupe on name across pages.
  const members: HanenMemberRecord[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const found = parseHanenMembers(p.html, p.url);
    for (const m of found) {
      const key = m.parsed_name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        members.push(m);
      }
    }
  }
  result.parsed = members.length;
  if (members.length === 0) {
    result.errors.push("No members parsed from Hanen HTML — selector drift or empty render");
    result.success = true;
    return result;
  }

  // 3. Load matching corpus once. PR-64: tightened to role='producer'
  // (excludes consumer/quality/logistics/price-intel agents per reviewer
  // note on PR-62 — they should never be tagged as Hanen members).
  let agents: Array<{ id: string; name: string; city: string | null }> = [];
  try {
    // PR-67: LEFT JOIN agent_knowledge to pick up the website for
    // domain-corroboration matching. agent_knowledge is 1:1 with
    // agents but optional, so LEFT JOIN keeps agents without a
    // knowledge row visible (website will be null in that case).
    agents = db.prepare(
      "SELECT a.id, a.name, a.city, k.website AS website "
      + "FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id "
      + "WHERE a.is_active = 1 AND (a.umbrella_type IS NULL OR a.umbrella_type = '') AND a.role = 'producer'"
    ).all() as Array<{ id: string; name: string; city: string | null; website: string | null }>;
  } catch (e) {
    result.errors.push(`producer corpus load failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // 4. Match + upsert. PR-64 three-tier writeback:
  //   - HIGH confidence  → INSERT with status='pending_confirmation' (today's behaviour)
  //   - MEDIUM confidence → INSERT with status='review_required' if the
  //                         CHECK widening is in place; FALLBACK to
  //                         'pending_confirmation' with evidence_json.match_confidence='medium'
  //                         so admin UI can still surface it.
  //   - location_mismatch_rejection → log to hanen_unmatched_members
  //                         with best_match_score=-1 to differentiate
  //                         from "no name match" (which uses the real score)
  //   - below_threshold  → log to hanen_unmatched_members as today
  //
  // INSERT … ON CONFLICT on the UNIQUE (producer_id, umbrella_id)
  // constraint keeps reruns idempotent. We refresh evidence_json only
  // when the existing status is still pending_confirmation or
  // review_required (i.e. not yet acted on by the producer/admin).

  // Detect whether the schema migration widened the status CHECK to
  // include 'review_required'. If not, we keep MEDIUM matches as
  // pending_confirmation + evidence flag. Cached per-call; the schema
  // doesn't change mid-process.
  let statusCheckIncludesReviewRequired = false;
  try {
    const schemaRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_affiliations'"
    ).get() as { sql: string } | undefined;
    statusCheckIncludesReviewRequired = !!(schemaRow && /'review_required'/.test(schemaRow.sql));
  } catch {
    // tolerate — fall back to pending_confirmation
  }

  const insertAff = db.prepare(`
    INSERT INTO agent_affiliations
      (producer_id, umbrella_id, status, source, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, 'inferred', ?, ?, ?)
    ON CONFLICT(producer_id, umbrella_id) DO UPDATE SET
      status = CASE
        WHEN agent_affiliations.status IN ('pending_confirmation','review_required')
          THEN excluded.status
        ELSE agent_affiliations.status
      END,
      evidence_json = CASE
        WHEN agent_affiliations.status IN ('pending_confirmation','review_required')
          THEN excluded.evidence_json
        ELSE agent_affiliations.evidence_json
      END,
      updated_at = excluded.updated_at
  `);
  const insertUnmatched = db.prepare(`
    INSERT INTO hanen_unmatched_members
      (parsed_name, parsed_location, parsed_website, parsed_category, source_url, best_match_score, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parsed_name) DO UPDATE SET
      parsed_location = excluded.parsed_location,
      parsed_website = excluded.parsed_website,
      parsed_category = excluded.parsed_category,
      source_url = excluded.source_url,
      best_match_score = excluded.best_match_score,
      last_seen_at = excluded.last_seen_at
  `);

  const nowIso = new Date().toISOString();
  for (const member of members) {
    let verdict: MatchVerdict;
    try {
      verdict = matchHanenMemberToAgent(member, agents);
    } catch (e) {
      result.errors.push(`match failed for "${member.parsed_name}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (verdict.agent_id && verdict.confidence === "high") {
      result.matched++;
      result.matched_high++;
      const evidence = {
        source: "hanen.no/medlemmer",
        umbrella_slug: "hanen",
        scraped_at: nowIso,
        parsed_name: member.parsed_name,
        parsed_location: member.parsed_location,
        parsed_website: member.parsed_website,
        parsed_category: member.parsed_category,
        match_score: verdict.score,
        match_method: verdict.method,
        match_confidence: "high",
        location_check: verdict.location_check,
      };
      try {
        insertAff.run(
          verdict.agent_id,
          umbrella.id,
          "pending_confirmation",
          JSON.stringify(evidence),
          nowIso,
          nowIso,
        );
        result.upserted++;
      } catch (e) {
        result.errors.push(`upsert affiliation for "${member.parsed_name}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (verdict.agent_id && verdict.confidence === "medium") {
      result.matched++;
      result.review_required++;
      const targetStatus = statusCheckIncludesReviewRequired
        ? "review_required"
        : "pending_confirmation";
      const evidence = {
        source: "hanen.no/medlemmer",
        umbrella_slug: "hanen",
        scraped_at: nowIso,
        parsed_name: member.parsed_name,
        parsed_location: member.parsed_location,
        parsed_website: member.parsed_website,
        parsed_category: member.parsed_category,
        match_score: verdict.score,
        match_method: verdict.method,
        match_confidence: "medium",
        location_check: verdict.location_check,
        // review_required flag carries even if we couldn't promote the
        // row's status — admin UI can pivot on this field alone.
        review_required: true,
      };
      try {
        insertAff.run(
          verdict.agent_id,
          umbrella.id,
          targetStatus,
          JSON.stringify(evidence),
          nowIso,
          nowIso,
        );
        result.upserted++;
      } catch (e) {
        result.errors.push(`upsert affiliation for "${member.parsed_name}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (verdict.method === "location_mismatch_rejection") {
      // Above-threshold name match REJECTED on fylke conflict. Log to
      // unmatched table with best_match_score=-1 so admin triage can
      // distinguish "false-positive prevented" from "no match found".
      result.rejected_location_mismatch++;
      try {
        insertUnmatched.run(
          member.parsed_name,
          member.parsed_location,
          member.parsed_website,
          member.parsed_category,
          member.source_url,
          -1,
          nowIso,
        );
      } catch (e) {
        result.errors.push(`upsert location-rejected "${member.parsed_name}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // below_threshold — no name match strong enough. Log the real score.
      result.unmatched++;
      try {
        insertUnmatched.run(
          member.parsed_name,
          member.parsed_location,
          member.parsed_website,
          member.parsed_category,
          member.source_url,
          verdict.score,
          nowIso,
        );
      } catch (e) {
        result.errors.push(`upsert unmatched "${member.parsed_name}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  result.success = true;
  return result;
}

// ─── helpers ───────────────────────────────────────────────────

// PR-69: extract the first external (non-Hanen) website link from a
// rendered member-card block. The Hanen WordPress listing pages today
// include — for many members — either a "Besøk hjemmeside"/"Hjemmeside"
// labelled anchor, or an `itemprop="url"` <link>/<a> pointing at the
// member's own domain. We scan all anchor hrefs in priority order:
//
//   1. <a itemprop="url" href="...">                — schema.org canonical
//   2. <a ... href="..."> ... Besøk hjemmeside ...  — labelled CTA
//   3. <a ... href="..."> ... hjemmeside ...        — case-insensitive fallback
//   4. <a class="...website|hjemmeside..." href="...">  — class-name hint
//   5. first generic <a href="http..."> NOT pointing at hanen.no       (lowest priority)
//
// In all cases the href MUST be absolute (http/https) AND its host
// MUST NOT be hanen.no / www.hanen.no (those are the listing-detail
// links we already capture in detailUrl). Returns null when no such
// link exists. Pure string utility — no I/O, no deps.
export function extractExternalWebsite(block: string): string | null {
  if (!block) return null;

  // Helper: is this href a usable external (non-hanen) URL?
  const isExternal = (href: string): boolean => {
    if (!href) return false;
    if (!/^https?:\/\//i.test(href)) return false;
    // strip protocol + optional www
    const stripped = href.replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
    // First host-part token (before / ? # space)
    const host = stripped.split(/[\s/?#]/)[0] || "";
    if (!host) return false;
    // Skip Hanen's own domain — that's the detail-page URL, not the
    // member's external website.
    if (host === "hanen.no" || host.endsWith(".hanen.no")) return false;
    return true;
  };

  // 1. itemprop="url" with href on the SAME tag (order-independent).
  //    Matches both `<a itemprop="url" href="...">` and `<a href="..." itemprop="url">`.
  const itempropRe = /<a[^>]*itemprop=["']url["'][^>]*href=["']([^"']+)["'][^>]*>/i;
  const itempropRe2 = /<a[^>]*href=["']([^"']+)["'][^>]*itemprop=["']url["'][^>]*>/i;
  const ip = itempropRe.exec(block) ?? itempropRe2.exec(block);
  if (ip && isExternal(ip[1])) return ip[1];

  // 2/3. Labelled CTA: "Besøk hjemmeside" or any anchor whose visible
  //    text mentions "hjemmeside" (case-insensitive). Scan all anchors
  //    sequentially and pick the first whose inner text matches.
  const allAnchorsRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const externalHits: string[] = [];
  while ((m = allAnchorsRe.exec(block)) !== null) {
    const href = m[1];
    const inner = m[2];
    if (!isExternal(href)) continue;
    const text = inner.replace(/<[^>]+>/g, " ").toLowerCase();
    if (/hjemmeside|bes[øo]k\s+hjemmeside|nettside|websted/i.test(text)) {
      return href;
    }
    externalHits.push(href);
  }

  // 4. class-name hint on the anchor itself ("...website..." / "...hjemmeside...").
  const classHintRe = /<a[^>]*class=["'][^"']*(?:website|hjemmeside|nettside)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i;
  const ch = classHintRe.exec(block);
  if (ch && isExternal(ch[1])) return ch[1];

  // 5. Fallback: first non-hanen external link we saw.
  if (externalHits.length > 0) return externalHits[0];

  return null;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&aelig;/gi, "æ")
    .replace(/&oslash;/gi, "ø")
    .replace(/&aring;/gi, "å")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Walk arbitrary JSON and collect array-of-object nodes that look like
// member records (have a 'name' field plus at least one of
// kommune/fylke/sted/url). Conservative — false positives just become
// no-ops downstream when parseHanenMembers can't extract a name.
function collectMemberArrays(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (Array.isArray(node)) {
    let looksLikeMembers = false;
    if (node.length > 5 && typeof node[0] === "object" && node[0] !== null) {
      const sample = node[0];
      if (typeof sample.name === "string" || typeof sample.title === "string") {
        if (
          "kommune" in sample || "fylke" in sample || "sted" in sample ||
          "city" in sample || "location" in sample || "url" in sample ||
          "slug" in sample || "id" in sample
        ) {
          looksLikeMembers = true;
        }
      }
    }
    if (looksLikeMembers) {
      out.push(...node);
    } else {
      for (const v of node) collectMemberArrays(v, out);
    }
  } else if (typeof node === "object") {
    for (const k of Object.keys(node)) {
      collectMemberArrays(node[k], out);
    }
  }
  return out;
}

function normaliseJsonMember(m: any, sourceUrl: string): HanenMemberRecord | null {
  if (!m || typeof m !== "object") return null;
  const name = (typeof m.name === "string" && m.name) ||
               (typeof m.title === "string" && m.title) || "";
  if (!name.trim()) return null;
  const kommune = (typeof m.kommune === "string" && m.kommune) ||
                  (typeof m.city === "string" && m.city) || "";
  const fylke = (typeof m.fylke === "string" && m.fylke) ||
                (typeof m.region === "string" && m.region) || "";
  const location = [kommune, fylke].filter(Boolean).join(", ");
  const website = (typeof m.url === "string" && /^https?:/.test(m.url) && !m.url.includes("hanen.no")) ? m.url : null;
  const category = (typeof m.category === "string" && m.category) ||
                   (typeof m.type === "string" && m.type) || null;
  return {
    parsed_name: name.trim(),
    parsed_location: location,
    parsed_website: website,
    parsed_category: category,
    source_url: sourceUrl,
  };
}

// ─── 5. reclassifyHanenAffiliations (PR-67) ────────────────────
// Re-run the v3 matcher against existing review_required affiliations
// WITHOUT re-fetching Hanen pages. Reads each row's evidence_json to
// reconstruct the parsed Hanen member, then re-evaluates against the
// current producer + agent_knowledge tables. Promotes high-confidence
// verdicts to pending_confirmation; leaves the rest as-is.
//
// Idempotent + cheap (no I/O outside SQLite). Designed for the
// ?re_classify_only=1 query mode on POST /admin/hanen/scrape.

export type HanenReclassifyResult = {
  rows_examined: number;
  promoted: number;
  still_pending: number;
  errors: string[];
};

export function reclassifyHanenAffiliations(): HanenReclassifyResult {
  const result: HanenReclassifyResult = {
    rows_examined: 0,
    promoted: 0,
    still_pending: 0,
    errors: [],
  };
  const db = getDb();

  // Locate Hanen umbrella — same lookup as runHanenScraper().
  let umbrella: { id: string } | undefined;
  try {
    umbrella = db.prepare(
      "SELECT id FROM agents WHERE (LOWER(name) LIKE 'hanen%' OR LOWER(name) = 'hanen') AND umbrella_type IS NOT NULL LIMIT 1"
    ).get() as { id: string } | undefined;
    if (!umbrella) {
      umbrella = db.prepare(
        "SELECT id FROM agents WHERE LOWER(name) LIKE 'hanen%' LIMIT 1"
      ).get() as { id: string } | undefined;
    }
  } catch (e) {
    result.errors.push(`Hanen umbrella lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  if (!umbrella) {
    result.errors.push("Hanen umbrella agent not found in agents table");
    return result;
  }

  // Load the producer corpus once, same shape as runHanenScraper().
  let agents: Array<{ id: string; name: string; city: string | null; website: string | null }> = [];
  try {
    agents = db.prepare(
      "SELECT a.id, a.name, a.city, k.website AS website "
      + "FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id "
      + "WHERE a.is_active = 1 AND (a.umbrella_type IS NULL OR a.umbrella_type = '') AND a.role = 'producer'"
    ).all() as Array<{ id: string; name: string; city: string | null; website: string | null }>;
  } catch (e) {
    result.errors.push(`producer corpus load failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Read all current review_required rows for the Hanen umbrella.
  let rows: Array<{ id: number; producer_id: string; evidence_json: string | null }> = [];
  try {
    rows = db.prepare(
      "SELECT id, producer_id, evidence_json FROM agent_affiliations "
      + "WHERE umbrella_id = ? AND status = 'review_required'"
    ).all(umbrella.id) as Array<{ id: number; producer_id: string; evidence_json: string | null }>;
  } catch (e) {
    result.errors.push(`affiliations read failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  result.rows_examined = rows.length;

  const update = db.prepare(
    "UPDATE agent_affiliations SET status = ?, evidence_json = ?, updated_at = ? WHERE id = ?"
  );
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    if (!row.evidence_json) {
      result.still_pending++;
      continue;
    }
    let ev: any;
    try {
      ev = JSON.parse(row.evidence_json);
    } catch {
      result.still_pending++;
      continue;
    }
    // Reconstruct a Hanen member record from the persisted evidence.
    const member: HanenMemberRecord = {
      parsed_name: typeof ev.parsed_name === "string" ? ev.parsed_name : "",
      parsed_location: typeof ev.parsed_location === "string" ? ev.parsed_location : "",
      parsed_website: typeof ev.parsed_website === "string" ? ev.parsed_website : null,
      parsed_category: typeof ev.parsed_category === "string" ? ev.parsed_category : null,
      source_url: typeof ev.source_url === "string" ? ev.source_url : (typeof ev.source === "string" ? ev.source : ""),
    };
    if (!member.parsed_name) {
      result.still_pending++;
      continue;
    }

    let verdict: MatchVerdict;
    try {
      // Limit to just THIS row's producer — we're verifying the existing
      // candidate gained new signals, not searching afresh. Pull the
      // agent record + any others (matcher picks highest Dice).
      verdict = matchHanenMemberToAgent(member, agents);
    } catch (e) {
      result.errors.push(`re-match failed for "${member.parsed_name}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (
      verdict.agent_id === row.producer_id &&
      verdict.confidence === "high"
    ) {
      // Promote — preserve historical evidence fields and add the
      // updated signal record.
      const newEvidence = {
        ...ev,
        match_score: verdict.score,
        match_method: verdict.method,
        match_confidence: "high",
        location_check: verdict.location_check,
        reclassified_at: nowIso,
        reclassified_from: "review_required",
      };
      // Drop the legacy `review_required: true` flag — the status column
      // now carries that information.
      delete newEvidence.review_required;
      try {
        update.run("pending_confirmation", JSON.stringify(newEvidence), nowIso, row.id);
        result.promoted++;
      } catch (e) {
        result.errors.push(`promote affiliation ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      result.still_pending++;
    }
  }

  return result;
}

// Exported constants so tests + the admin route can sanity-check.
export const HANEN_MATCH_THRESHOLD = MATCH_THRESHOLD;
export const HANEN_DUAL_CORROBORATION_THRESHOLD = DUAL_CORROBORATION_THRESHOLD;
export const HANEN_LISTING_URL = LISTING_URL;
export const HANEN_MAX_PAGES_DEFAULT = MAX_PAGES;
export const HANEN_MAX_PAGES_HARD_CAP = MAX_PAGES_HARD_CAP;
export const HANEN_MAX_START_PAGE = MAX_START_PAGE;

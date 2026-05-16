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
import { nameSimilarity } from "./name-matcher";

const LISTING_URL = "https://hanen.no/medlemmer";

// Match-score cut-off. Conservative on purpose: false positives create
// wrong umbrella claims which damage Hanen's data quality more than a
// missed match (which just stays in hanen_unmatched_members for later
// review). 0.85 on Dice ≈ "two characters different in a 12-char name".
const MATCH_THRESHOLD = 0.85;

// renderPage default is 30s — Hanen's SPA cold-loads slowly, especially
// behind their Cloudflare front. 60s leaves ample headroom inside the
// 120s Fly admin endpoint cap (60s render + 30s parse/match/upsert + slack).
const RENDER_TIMEOUT_MS = 60000;

// Hard ceiling on pages to crawl if Hanen ever switches to paged URLs
// (?page=N). Defensive; today's site is single-page.
const MAX_PAGES = 5;

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
  matched: number;                // members matched ≥ MATCH_THRESHOLD
  unmatched: number;              // members logged to unmatched table
  upserted: number;               // agent_affiliations rows written
  errors: string[];
};

export type HanenMatchVerdict =
  | { agent_id: string; score: number; method: "name_dice" }
  | { agent_id: null; score: number; method: "below_threshold" };

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
    renderer?: (url: string) => Promise<string>;
  }
): Promise<{ pages: Array<{ url: string; html: string }>; errors: string[] }> {
  const cap = Math.min(opts?.maxPages ?? MAX_PAGES, MAX_PAGES);
  const errors: string[] = [];
  const pages: Array<{ url: string; html: string }> = [];

  const render = opts?.renderer ?? (async (url: string) => {
    const r = await renderPage(url, {
      timeout_ms: RENDER_TIMEOUT_MS,
      wait_for: "networkidle",
    });
    return r.html;
  });

  // Always fetch page 1.
  try {
    const html = await render(LISTING_URL);
    pages.push({ url: LISTING_URL, html });
  } catch (e) {
    errors.push(`fetchHanenListing(page=1) failed: ${e instanceof Error ? e.message : String(e)}`);
    return { pages, errors };
  }

  // Hanen is a WordPress + Beaver Builder site (verified 2026-05-16):
  // pagination is /medlemmer/page/N/ (NOT ?page=N). Page 1 ships with a
  // <ul class="page-numbers"> block; absence means "this is already the
  // last page" → stop. We also bail on duplicate content (defensive vs.
  // CDN echo) and empty pages (<500 bytes is always a soft 404 here).
  if (cap > 1 && /class=["'][^"']*page-numbers/i.test(pages[0].html)) {
    for (let n = 2; n <= cap; n++) {
      const url = `${LISTING_URL.replace(/\/$/, "")}/page/${n}/`;
      try {
        const html = await render(url);
        if (!html || html.length < 500 || html === pages[0].html) break;
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

    // Website: not exposed on the listing page. Detail-page fetch is
    // out of scope per the C.2 brief (one renderPage() per run).
    pushUnique({
      parsed_name: name,
      parsed_location: location,
      parsed_website: null,
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

// ─── 3. matchHanenMemberToAgent ────────────────────────────────
// Returns the best-scoring agent above MATCH_THRESHOLD or null. Pulls
// every active producer (umbrella_type IS NULL) once and scores each
// with Dice. At ~1500 producers × N Hanen members this is O(N·1500) —
// fast enough (<1s for 500 members on a warm SQLite cache).
export function matchHanenMemberToAgent(
  member: HanenMemberRecord,
  agents: Array<{ id: string; name: string; city: string | null }>
): HanenMatchVerdict {
  let best: { id: string; score: number } | null = null;
  for (const a of agents) {
    const score = nameSimilarity(member.parsed_name, a.name);
    if (!best || score > best.score) {
      best = { id: a.id, score };
    }
  }
  if (best && best.score >= MATCH_THRESHOLD) {
    return { agent_id: best.id, score: best.score, method: "name_dice" };
  }
  return { agent_id: null, score: best?.score ?? 0, method: "below_threshold" };
}

// ─── 4. runHanenScraper ────────────────────────────────────────
// Top-level pipeline. Idempotent on (producer_id, umbrella_id) — the
// underlying UNIQUE constraint plus INSERT OR IGNORE keeps reruns
// harmless. Unmatched members upsert into hanen_unmatched_members on
// parsed_name (UNIQUE) so re-running just refreshes the last_seen_at.
export async function runHanenScraper(opts?: {
  maxPages?: number;
  renderer?: (url: string) => Promise<string>;
}): Promise<HanenScrapeResult> {
  const result: HanenScrapeResult = {
    success: false,
    fetched: 0,
    parsed: 0,
    matched: 0,
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

  // 3. Load matching corpus once (active producers only).
  let agents: Array<{ id: string; name: string; city: string | null }> = [];
  try {
    agents = db.prepare(
      "SELECT id, name, city FROM agents WHERE is_active = 1 AND (umbrella_type IS NULL OR umbrella_type = '')"
    ).all() as Array<{ id: string; name: string; city: string | null }>;
  } catch (e) {
    result.errors.push(`producer corpus load failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // 4. Match + upsert.
  // INSERT OR IGNORE on agent_affiliations relies on the UNIQUE
  // (producer_id, umbrella_id) constraint declared in init.ts. On
  // conflict we leave the existing row alone (it may have been
  // already accepted/rejected by the producer). Updating evidence_json
  // for an existing pending_confirmation row IS done so re-scrapes
  // refresh match_score + scraped_at — matters if Hanen renames a
  // member and our match score improves.
  const insertAff = db.prepare(`
    INSERT INTO agent_affiliations
      (producer_id, umbrella_id, status, source, evidence_json, created_at, updated_at)
    VALUES (?, ?, 'pending_confirmation', 'inferred', ?, ?, ?)
    ON CONFLICT(producer_id, umbrella_id) DO UPDATE SET
      evidence_json = CASE
        WHEN agent_affiliations.status = 'pending_confirmation'
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
    let verdict: HanenMatchVerdict;
    try {
      verdict = matchHanenMemberToAgent(member, agents);
    } catch (e) {
      result.errors.push(`match failed for "${member.parsed_name}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (verdict.agent_id) {
      result.matched++;
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
      };
      try {
        insertAff.run(verdict.agent_id, umbrella.id, JSON.stringify(evidence), nowIso, nowIso);
        result.upserted++;
      } catch (e) {
        result.errors.push(`upsert affiliation for "${member.parsed_name}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
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

// Exported constants so tests + the admin route can sanity-check.
export const HANEN_MATCH_THRESHOLD = MATCH_THRESHOLD;
export const HANEN_LISTING_URL = LISTING_URL;

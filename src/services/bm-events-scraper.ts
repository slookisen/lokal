// ─── Bondens marked events scraper (Phase 5.11 PR-56, 2026-05-16) ────
//
// Daily pipeline that fetches upcoming markedsdager from bondensmarked.no,
// matches them to existing venue/lokallag agents, and upserts into the
// bm_market_events table. Designed to run from:
//
//   - cron via POST /admin/bm-events/scrape (Cowork scheduled-task, daily 05:00 UTC)
//   - ad-hoc by Daniel from the same admin endpoint
//
// All four exported functions are pure (take their inputs explicitly) so
// tests can drive them with a stubbed global `fetch`.
//
// Matching strategy (in priority order):
//   1. venue_exact     — agents.name (lower) == event location_text (lower)
//                        AND agents.umbrella_type = 'venue'
//   2. venue_fuzzy     — Norwegian-aware substring match between event
//                        location_text and any venue name in the BM tree
//                        (length-scored, longest-overlap wins)
//   3. lokallag_fallback — when no venue matches, find a lokallag in the
//                        Bondens marked Norge tree whose city matches the
//                        event location_text. Returns the lokallag's id.
//   4. unmatched       — push to ScrapeResult.errors[]; do NOT create a
//                        new venue here (out of scope for this PR).
//
// We do NOT try to detect Cloudflare-style empty-body responses ourselves;
// caller passes useRenderWorker=true to force the render-worker fallback.

import { getDb } from "../database/init";
import { renderPage } from "./render-client";
import { normaliseForMatch } from "./name-matcher";

const LISTING_URL = "https://bondensmarked.no/markeder";
const EVENT_BASE = "https://bondensmarked.no/markeder/";

// Concurrency cap when fetching individual event pages. 6 keeps us well
// under typical Cloudflare per-IP rate-limits and finishes ~150 events in
// roughly 30s on a healthy network.
const FETCH_CONCURRENCY = 6;

// Per-page timeout. Some bondensmarked.no pages are slow at peak load.
const FETCH_TIMEOUT_MS = 15000;

export type BmEventRecord = {
  event_slug: string;
  event_name: string;
  location_text: string;
  start_at: string;
  end_at: string | null;
  source_url: string;
};

export type ScrapeResult = {
  fetched: number;
  parsed: number;
  matched_to_venue: number;
  matched_to_lokallag_fallback: number;
  unmatched: number;
  upserted: number;
  errors: string[];
};

// ─── 1. fetchEventSlugs ─────────────────────────────────────────
// Pulls the listing HTML and extracts unique slugs from /markeder/<slug>
// hrefs. Tolerates additional query strings or fragment markers.
export async function fetchEventSlugs(
  listingUrl: string = LISTING_URL,
  useRenderWorker: boolean = false
): Promise<string[]> {
  const html = useRenderWorker
    ? (await renderPage(listingUrl, { wait_for: "domcontentloaded" })).html
    : await fetchHtml(listingUrl);

  const slugs = new Set<string>();
  const re = /href=["']\/markeder\/([a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    slugs.add(m[1]);
  }
  return [...slugs].sort();
}

// ─── 2. fetchEventDetails ──────────────────────────────────────
// Fetches a single event page, finds <script type="application/ld+json">
// blocks, parses each, and returns the first one with @type === "Event".
export async function fetchEventDetails(
  slug: string,
  useRenderWorker: boolean = false
): Promise<BmEventRecord | null> {
  const url = EVENT_BASE + slug;
  const html = useRenderWorker
    ? (await renderPage(url, { wait_for: "domcontentloaded" })).html
    : await fetchHtml(url);

  const blocks = extractJsonLdBlocks(html);
  for (const raw of blocks) {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of candidates) {
      if (!node || node["@type"] !== "Event") continue;
      const name = typeof node.name === "string" ? node.name.trim() : "";
      const startAt = typeof node.startDate === "string" ? node.startDate : "";
      if (!name || !startAt) continue;
      // location is sometimes a string, sometimes a Place object.
      let locationText = "";
      if (typeof node.location === "string") {
        locationText = node.location;
      } else if (node.location && typeof node.location === "object") {
        locationText = node.location.name || node.location.address?.addressLocality || "";
      }
      return {
        event_slug: slug,
        event_name: name,
        location_text: locationText,
        start_at: startAt,
        end_at: typeof node.endDate === "string" ? node.endDate : null,
        source_url: url,
      };
    }
  }
  return null;
}

// ─── 3. matchEventToVenue ──────────────────────────────────────
// Returns { agent_id, match_type }. agent_id is null only when match_type
// is 'unmatched'. Reads the BM tree once per call (acceptable — at most ~80
// agents in the tree, query is indexed on parent_umbrella_id).
export async function matchEventToVenue(
  record: BmEventRecord
): Promise<{
  agent_id: string | null;
  match_type: "venue_exact" | "venue_fuzzy" | "lokallag_fallback" | "unmatched";
}> {
  const db = getDb();

  // Find the national umbrella so we can scope the venue/lokallag search.
  // If it's missing (fresh DB without the A4 migration applied) we cannot
  // do lokallag fallback, only direct venue_exact on any 'venue' agent.
  const national = db.prepare(
    "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type IS NOT NULL"
  ).get("Bondens marked Norge") as { id: string } | undefined;

  // ── 1. venue_exact: case-insensitive name == location_text ──
  // Use event_name first (often more specific, e.g. "Lyngdal Sentrum"),
  // then fall back to location_text ("Lyngdal").
  const exactCandidates = [record.event_name, record.location_text]
    .map(s => (s || "").trim())
    .filter(s => s.length > 0);
  for (const candidate of exactCandidates) {
    const row = db.prepare(
      "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type = 'venue' AND is_active = 1 LIMIT 1"
    ).get(candidate) as { id: string } | undefined;
    if (row) return { agent_id: row.id, match_type: "venue_exact" };
  }

  // ── 2. venue_fuzzy: Norwegian-aware substring scoring ──
  // Pull all venue agents in the BM tree (parent_umbrella_id under the
  // national umbrella, possibly via a lokallag intermediate). Score each by
  // whether the normalised location_text (or event_name) is contained in
  // the venue's normalised name, or vice-versa. Pick the longest overlap.
  type Venue = { id: string; name: string };
  let venues: Venue[] = [];
  try {
    if (national) {
      // Two hops: national → lokallag → venue. Use a recursive-style 2-step
      // since SQLite WITH RECURSIVE adds complexity for marginal benefit.
      const lokallagIds = db.prepare(
        "SELECT id FROM agents WHERE parent_umbrella_id = ? AND umbrella_type = 'market_network'"
      ).all(national.id) as Array<{ id: string }>;
      const lokallagIdList = lokallagIds.map(r => r.id);
      if (lokallagIdList.length > 0) {
        const placeholders = lokallagIdList.map(() => "?").join(",");
        venues = db.prepare(
          `SELECT id, name FROM agents WHERE umbrella_type = 'venue' AND is_active = 1 AND parent_umbrella_id IN (${placeholders})`
        ).all(...lokallagIdList) as Venue[];
      }
    }
    if (venues.length === 0) {
      // Fallback: just pull all 'venue' agents if the BM tree isn't seeded.
      venues = db.prepare(
        "SELECT id, name FROM agents WHERE umbrella_type = 'venue' AND is_active = 1"
      ).all() as Venue[];
    }
  } catch (e) {
    // Schema older than A1 migration — silently use empty list.
    venues = [];
  }

  const needles = exactCandidates.map(normaliseForMatch).filter(s => s.length >= 3);
  let best: { id: string; score: number } | null = null;
  for (const v of venues) {
    const venueNorm = normaliseForMatch(v.name);
    if (!venueNorm) continue;
    for (const needle of needles) {
      let overlap = 0;
      if (venueNorm === needle) {
        overlap = needle.length * 2; // exact normalised hit beats any substring
      } else if (venueNorm.includes(needle)) {
        overlap = needle.length;
      } else if (needle.includes(venueNorm) && venueNorm.length >= 4) {
        overlap = venueNorm.length;
      }
      if (overlap > 0 && (!best || overlap > best.score)) {
        best = { id: v.id, score: overlap };
      }
    }
  }
  if (best && best.score >= 4) {
    return { agent_id: best.id, match_type: "venue_fuzzy" };
  }

  // ── 3. lokallag_fallback: city-substring match against lokallag rows ──
  if (national) {
    try {
      const lokallags = db.prepare(
        "SELECT id, name, city FROM agents WHERE parent_umbrella_id = ? AND umbrella_type = 'market_network' AND is_active = 1"
      ).all(national.id) as Array<{ id: string; name: string; city: string | null }>;

      const locNorm = normaliseForMatch(record.location_text);
      const eventNorm = normaliseForMatch(record.event_name);
      let bestLok: { id: string; score: number } | null = null;
      for (const l of lokallags) {
        const cityNorm = normaliseForMatch(l.city || "");
        const nameNorm = normaliseForMatch(l.name);
        let s = 0;
        if (cityNorm && (locNorm.includes(cityNorm) || eventNorm.includes(cityNorm))) {
          s = Math.max(s, cityNorm.length);
        }
        if (nameNorm && (locNorm.includes(nameNorm) || eventNorm.includes(nameNorm))) {
          s = Math.max(s, nameNorm.length);
        }
        if (s > 0 && (!bestLok || s > bestLok.score)) {
          bestLok = { id: l.id, score: s };
        }
      }
      if (bestLok && bestLok.score >= 3) {
        return { agent_id: bestLok.id, match_type: "lokallag_fallback" };
      }
    } catch {
      // ignore — fall through to unmatched
    }
  }

  return { agent_id: null, match_type: "unmatched" };
}

// ─── 4. runBmEventsScraper ─────────────────────────────────────
// Top-level pipeline. Idempotent on event_slug. Returns a ScrapeResult so
// the admin endpoint can surface progress to the cron worker / dashboard.
export async function runBmEventsScraper(opts?: {
  maxEvents?: number;
  useRenderWorker?: boolean;
}): Promise<ScrapeResult> {
  const maxEvents = opts?.maxEvents ?? 600;
  const useRenderWorker = opts?.useRenderWorker ?? false;

  const result: ScrapeResult = {
    fetched: 0,
    parsed: 0,
    matched_to_venue: 0,
    matched_to_lokallag_fallback: 0,
    unmatched: 0,
    upserted: 0,
    errors: [],
  };

  let slugs: string[];
  try {
    slugs = await fetchEventSlugs(LISTING_URL, useRenderWorker);
  } catch (e) {
    result.errors.push(`fetchEventSlugs failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  result.fetched = slugs.length;

  if (slugs.length === 0) {
    result.errors.push("listing returned 0 event slugs — possibly a Cloudflare challenge or DOM change; try useRenderWorker=true");
    return result;
  }

  // Cap before fanning out so a misconfigured caller can't flood the source.
  const capped = slugs.slice(0, maxEvents);

  const db = getDb();
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO bm_market_events
      (venue_agent_id, event_slug, event_name, location_text, start_at, end_at, source_url, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // Process slugs in concurrent batches to keep the run reasonable.
  for (let i = 0; i < capped.length; i += FETCH_CONCURRENCY) {
    const batch = capped.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(slug => fetchEventDetails(slug, useRenderWorker))
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const slug = batch[j];
      if (s.status === "rejected") {
        result.errors.push(`fetchEventDetails(${slug}) failed: ${String(s.reason).slice(0, 200)}`);
        continue;
      }
      const record = s.value;
      if (!record) {
        result.errors.push(`fetchEventDetails(${slug}) returned no Event JSON-LD`);
        continue;
      }
      result.parsed++;

      let match: Awaited<ReturnType<typeof matchEventToVenue>>;
      try {
        match = await matchEventToVenue(record);
      } catch (e) {
        result.errors.push(`matchEventToVenue(${slug}) threw: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      if (match.match_type === "venue_exact" || match.match_type === "venue_fuzzy") {
        result.matched_to_venue++;
      } else if (match.match_type === "lokallag_fallback") {
        result.matched_to_lokallag_fallback++;
      } else {
        result.unmatched++;
        result.errors.push(`unmatched: ${slug} (event_name="${record.event_name}", location="${record.location_text}")`);
        continue;
      }

      try {
        upsertStmt.run(
          match.agent_id,
          record.event_slug,
          record.event_name,
          record.location_text,
          record.start_at,
          record.end_at,
          record.source_url,
        );
        result.upserted++;
      } catch (e) {
        result.errors.push(`upsert(${slug}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return result;
}

// ─── helpers ────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      // Identify as a polite scraper. bondensmarked.no does not block on UA
      // but we send one anyway for transparency / log readability.
      "User-Agent": "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

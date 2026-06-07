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
//   4. unmatched       — push to ScrapeResult.errors[]. PR-94 (2026-06-01)
//                        auto-creates a placeholder agent (umbrella_type=
//                        \'bm_venue\', agent_review_status=\'pending_review\')
//                        so Daniel can confirm/reject from the admin
//                        review queue. The event row is linked to that
//                        placeholder agent; once confirmed it appears in
//                        bm-events listings + on profile pages.
//
// We do NOT try to detect Cloudflare-style empty-body responses ourselves;
// caller passes useRenderWorker=true to force the render-worker fallback.

import { getDb } from "../database/init";
import { renderPage } from "./render-client";
import {
  fetchBmLokallag,
  fetchBmLokallagDetail,
  isValidLokallagSlug,
  type BmMarketDay,
} from "./bondensmarked-source";
import { normaliseForMatch, normaliseBmLocation } from "./name-matcher";
import { slugify } from "../utils/slug";
import { v4 as uuid } from "uuid";
import * as crypto from "crypto";

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
  /**
   * PR-94: count of events for which no existing agent matched — but a
   * placeholder bm_venue agent (status=pending_review) was auto-created
   * and the event was linked to it. Distinct from `unmatched` which now
   * only counts true failures (auto-create itself errored).
   */
  auto_created_bm_venue: number;
  unmatched: number;
  upserted: number;
  /** PR-125: bm_market_events rows whose times were checked against the lokallag fasit. */
  event_times_checked: number;
  /** PR-125: bm_market_events rows whose start/end times were corrected from the fasit. */
  event_times_corrected: number;
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
  /**
   * PR-94 added \'bm_venue_auto\' as a 5th tier. When the matcher would
   * otherwise return \'unmatched\', it now creates a placeholder agent
   * (umbrella_type=\'bm_venue\', agent_review_status=\'pending_review\')
   * and returns its id. The scraper pipeline links the event to that id.
   */
  match_type: "venue_exact" | "venue_fuzzy" | "lokallag_fallback" | "bm_venue_auto" | "unmatched";
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

  // PR-94: use normaliseBmLocation so "Kaupangermart´n" / "Digerneset"
  // / "Skogen" collapse to the same form as their agent counterparts.
  const needles = exactCandidates.map(normaliseBmLocation).filter(s => s.length >= 3);
  let best: { id: string; score: number } | null = null;
  for (const v of venues) {
    const venueNorm = normaliseBmLocation(v.name);
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

      // PR-94: normaliseBmLocation matches the venue-side normalisation
      // so lokallag-fallback consistently handles Norwegian suffix variants.
      const locNorm = normaliseBmLocation(record.location_text);
      const eventNorm = normaliseBmLocation(record.event_name);
      let bestLok: { id: string; score: number } | null = null;
      for (const l of lokallags) {
        const cityNorm = normaliseBmLocation(l.city || "");
        const nameNorm = normaliseBmLocation(l.name);
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

  // ── 4. PR-94 Phase B.2: auto-create a bm_venue agent ──
  // No producer-side agent matched. Rather than dropping the event, we
  // create a placeholder agent so the event is preserved + surfaces in
  // the admin review queue (Daniel confirms or rejects later).
  //
  // De-duplication strategy: slug from event_name (preferred — most
  // specific) OR location_text. If an agent already exists with this
  // exact slug (regardless of umbrella_type) we link to it instead of
  // re-creating. The `ON CONFLICT DO NOTHING` semantics are achieved
  // via a pre-check because agents.name has no UNIQUE constraint and
  // agents.id is the only PK.
  try {
    const venueId = await getOrCreateBmVenueAgent(record);
    if (venueId) {
      return { agent_id: venueId, match_type: "bm_venue_auto" };
    }
  } catch {
    // Fall through to plain unmatched on any DB error so the scraper
    // continues processing the rest of the batch.
  }

  return { agent_id: null, match_type: "unmatched" };
}

// ─── PR-94 helper: getOrCreateBmVenueAgent ──────────────────────
// Creates a placeholder agent (umbrella_type=\'bm_venue\', status=
// \'pending_review\') for an unmatched BM event. Idempotent on slug —
// re-running the scraper on the same event re-uses the existing row
// and merely appends `first_seen` metadata.
//
// Required NOT NULL columns on agents are filled with synthetic
// placeholder values (description = "(auto-created from BM scraper)",
// provider = "bondensmarked.no", contact_email = "noreply@…",
// url = source_url, role = \'producer\' to satisfy the CHECK constraint,
// api_key = random hex). The agent is is_active=0 while pending so it
// doesn\'t pollute discovery; admin confirm flips it to is_active=1.
export async function getOrCreateBmVenueAgent(
  record: BmEventRecord
): Promise<string | null> {
  const db = getDb();
  const nameCandidate = (record.event_name || record.location_text || "").trim();
  if (!nameCandidate) return null;
  const slug = slugify(nameCandidate);
  if (!slug || slug.length < 2) return null;

  // Check by slug-derivable name (case-insensitive) first to avoid dupes.
  // We store the original event_name as the agent name and rely on
  // slugify(name) being stable across runs.
  const existing = db.prepare(
    "SELECT id, bm_venue_meta FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type = \'bm_venue\' LIMIT 1"
  ).get(nameCandidate) as { id: string; bm_venue_meta: string | null } | undefined;

  if (existing) {
    // Merge metadata: track distinct locations seen for this venue.
    try {
      const meta = existing.bm_venue_meta ? JSON.parse(existing.bm_venue_meta) : {};
      meta.last_seen_at = new Date().toISOString();
      const locs: string[] = Array.isArray(meta.locations) ? meta.locations : [];
      if (record.location_text && !locs.includes(record.location_text)) {
        locs.push(record.location_text);
      }
      meta.locations = locs;
      const slugs: string[] = Array.isArray(meta.event_slugs) ? meta.event_slugs : [];
      if (record.event_slug && !slugs.includes(record.event_slug)) {
        slugs.push(record.event_slug);
      }
      meta.event_slugs = slugs;
      db.prepare("UPDATE agents SET bm_venue_meta = ? WHERE id = ?").run(
        JSON.stringify(meta),
        existing.id
      );
    } catch {
      // Metadata-merge is best-effort; don\'t fail the match because of it.
    }
    return existing.id;
  }

  // Create new bm_venue placeholder agent.
  const id = uuid();
  const apiKey = "bmv_" + crypto.randomBytes(20).toString("hex");
  const now = new Date().toISOString();
  const meta = {
    first_event_name: record.event_name,
    first_event_slug: record.event_slug,
    first_location_text: record.location_text,
    first_seen_at: now,
    last_seen_at: now,
    source_url: record.source_url,
    locations: record.location_text ? [record.location_text] : [],
    event_slugs: record.event_slug ? [record.event_slug] : [],
  };
  try {
    db.prepare(`
      INSERT INTO agents (
        id, name, description, provider, contact_email, url, role,
        api_key, city,
        umbrella_type, agent_review_status, bm_venue_meta,
        is_active, is_verified, trust_score,
        created_at, last_seen_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, \'producer\',
        ?, ?,
        \'bm_venue\', \'pending_review\', ?,
        0, 0, 0,
        ?, ?
      )
    `).run(
      id,
      nameCandidate,
      `(Auto-opprettet fra Bondens marked-skraper ${now.slice(0, 10)}. Venter Daniel-bekreftelse.)`,
      "bondensmarked.no",
      "noreply@rettfrabonden.com",
      record.source_url,
      apiKey,
      record.location_text || null,
      JSON.stringify(meta),
      now,
      now,
    );
    return id;
  } catch {
    // Possible api_key collision (extremely unlikely) — retry once.
    return null;
  }
}

// ─── 4. runBmEventsScraper ─────────────────────────────────────
// Top-level pipeline. Idempotent on event_slug. Returns a ScrapeResult so
// the admin endpoint can surface progress to the cron worker / dashboard.
export async function runBmEventsScraper(opts?: {
  maxEvents?: number;
  useRenderWorker?: boolean;
  correctTimes?: boolean;
}): Promise<ScrapeResult> {
  const maxEvents = opts?.maxEvents ?? 600;
  const useRenderWorker = opts?.useRenderWorker ?? false;
  const correctTimes = opts?.correctTimes ?? true;

  const result: ScrapeResult = {
    fetched: 0,
    parsed: 0,
    matched_to_venue: 0,
    matched_to_lokallag_fallback: 0,
    auto_created_bm_venue: 0,
    unmatched: 0,
    upserted: 0,
    event_times_checked: 0,
    event_times_corrected: 0,
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
      } else if (match.match_type === "bm_venue_auto") {
        // PR-94: not an error — a placeholder bm_venue agent was created.
        result.auto_created_bm_venue++;
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

  // ── PR-125: correct stored event times from the lokallag fasit ──
  // bondensmarked.no/lokallag detail pages are Daniel-declared source of truth
  // for market-day times (Randi: shown 08:00-13:00, real 10:00-15:00/17:00).
  // The per-event JSON-LD can carry stale times, so after upserting we splice
  // the fasit HH:MM onto matching rows (joined by event_slug; idempotent —
  // only writes when the time actually differs). Never inserts/deletes.
  if (correctTimes) {
    try {
      const corr = await correctEventTimesFromCanonical({ useRenderWorker });
      result.event_times_checked = corr.checked;
      result.event_times_corrected = corr.corrected;
      if (corr.errors.length) {
        result.errors.push(...corr.errors.slice(0, 20).map((e) => `time-correct: ${e}`));
      }
    } catch (e) {
      result.errors.push(`time-correction step failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

// ─── PR-125: lokallag-fasit time correction ─────────────────────────────────

/**
 * Replace the HH:MM time-of-day in an ISO-like timestamp while preserving the
 * date, any seconds, and the timezone offset. Returns null when the input has
 * no parseable `YYYY-MM-DDTHH:MM` component, so we never fabricate a time onto
 * a date-only or malformed value.
 *
 * LOAD-BEARING ASSUMPTION: the stored `start_at` (raw BM per-event JSON-LD
 * `startDate`) and the lokallag-detail fasit HH:MM express the SAME wall-clock
 * local time. We swap only HH:MM and keep the original offset verbatim, so the
 * two stay internally consistent. If BM ever changes its JSON-LD to emit true
 * UTC while the detail page keeps wall-clock, this would write a skewed time —
 * the date-match guard in applyMarketDayTimeCorrections bounds the blast radius
 * (a day shift would be skipped), but a same-day hour skew would not be caught.
 */
export function spliceTimeOfDay(existing: string | null | undefined, hhmm: string): string | null {
  if (!existing || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T)\d{2}:\d{2}(.*)$/.exec(existing);
  if (!m) return null;
  return `${m[1]}${hhmm}${m[2]}`;
}

export type BmTimeCorrectionResult = {
  checked: number;
  corrected: number;
  skipped_no_row: number;
  /** PR-125: rows whose stored date != the fasit market-day date (collision guard; never written). */
  skipped_date_mismatch: number;
  errors: string[];
};

/**
 * Apply fasit market-day times onto existing bm_market_events rows, joined by
 * event_slug (UNIQUE natural key). Idempotent: only UPDATEs when the spliced
 * time differs. Pure mutation on existing rows — never inserts or deletes.
 * Testable directly with an in-memory DB (no network).
 */
export function applyMarketDayTimeCorrections(marketDays: BmMarketDay[]): BmTimeCorrectionResult {
  const db = getDb();
  const sel = db.prepare("SELECT start_at, end_at FROM bm_market_events WHERE event_slug = ?");
  const upd = db.prepare("UPDATE bm_market_events SET start_at = ?, end_at = ? WHERE event_slug = ?");
  const res: BmTimeCorrectionResult = { checked: 0, corrected: 0, skipped_no_row: 0, skipped_date_mismatch: 0, errors: [] };
  // Wrap the batch in a single transaction — all-or-nothing, and faster than N
  // autocommits. better-sqlite3 transactions are synchronous (this fn is sync).
  const applyAll = db.transaction((days: BmMarketDay[]) => {
    for (const md of days) {
      if (!md.eventSlug || !md.startTime) continue;
      res.checked++;
      try {
        const row = sel.get(md.eventSlug) as { start_at: string; end_at: string | null } | undefined;
        if (!row) { res.skipped_no_row++; continue; }
        // Date-match guard: only ever correct a row whose stored calendar date
        // equals the fasit market-day date. event_slug already encodes the date,
        // so a mismatch means a slug collision / unexpected data — skip, never write.
        if (md.date && row.start_at.slice(0, 10) !== md.date) { res.skipped_date_mismatch++; continue; }
        const newStart = spliceTimeOfDay(row.start_at, md.startTime) ?? row.start_at;
        // end_at: when the fasit has an end time we splice it onto the existing
        // end (or the start's date if end_at is null). Daytime markets never cross
        // midnight, so deriving the end date from the start date is safe here.
        const newEnd = md.endTime
          ? (spliceTimeOfDay(row.end_at ?? row.start_at, md.endTime) ?? row.end_at)
          : row.end_at;
        if (newStart !== row.start_at || newEnd !== row.end_at) {
          upd.run(newStart, newEnd, md.eventSlug);
          res.corrected++;
        }
      } catch (e) {
        res.errors.push(`${md.eventSlug}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  applyAll(marketDays);
  return res;
}

/**
 * Daily-scraper step: fetch the lokallag index + each lokallag detail page
 * (the fasit) and apply time corrections to stored events. Live-fetch — not
 * unit-tested (sandbox-restricted); the pure DB step above carries the tests.
 */
export async function correctEventTimesFromCanonical(
  opts?: { useRenderWorker?: boolean }
): Promise<{ lokallag_processed: number; checked: number; corrected: number; errors: string[] }> {
  void opts; // reserved (render-worker fallback not needed for server-side fetch)
  const out = { lokallag_processed: 0, checked: 0, corrected: 0, errors: [] as string[] };
  let lokallag: Awaited<ReturnType<typeof fetchBmLokallag>>;
  try {
    lokallag = await fetchBmLokallag();
  } catch (e) {
    out.errors.push(`fetchBmLokallag failed: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  for (const lok of lokallag) {
    if (!isValidLokallagSlug(lok.slug)) {
      out.errors.push(`skip invalid slug: ${JSON.stringify(lok.slug)}`);
      continue;
    }
    try {
      const detail = await fetchBmLokallagDetail(lok.slug);
      const r = applyMarketDayTimeCorrections(detail.marketDays);
      out.lokallag_processed++;
      // Polite ~150ms gap between lokallag so the ~14 detail (+ markedsplasser)
      // fetches don't burst bondensmarked.no within one scrape cycle.
      await new Promise((resolve) => setTimeout(resolve, 150));
      out.checked += r.checked;
      out.corrected += r.corrected;
      if (r.errors.length) out.errors.push(...r.errors);
    } catch (e) {
      out.errors.push(`detail(${lok.slug}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
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

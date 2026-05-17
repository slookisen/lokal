// ─── BM event-participant scraper (Phase 5.11 PR-71, 2026-05-17) ────
//
// The Bondens marked events scraper (PR-56) populates `bm_market_events`
// with venue + start_at + slug, but each event's PARTICIPANT LIST
// (`/markeder/<slug>` detail page → "Produsenter (N)" section) is NOT
// linked to producer agents. Today the 13 BM lokallag umbrellas hold
// only ~73 producer affiliations total — they should each have 30-80.
//
// This module closes that gap. For every event we:
//
//   1. Fetch the detail HTML (`https://bondensmarked.no/markeder/<slug>`).
//      Pages are server-rendered (verified 2026-05-17): each participant
//      is an `<a href="/produsenter/<slug>">...<h3>Producer Name</h3>...</a>`
//      block. NO render-worker fallback is needed.
//   2. Extract the participants (name + producer-page slug + first
//      category label).
//   3. Walk the event's `venue_agent_id` → `parent_umbrella_id` chain to
//      land on the lokallag umbrella (`umbrella_type='market_network'`).
//      Affiliations always link the producer to a LOKALLAG, never to a
//      bare venue, so a producer appearing at 3 venues of one lokallag
//      gets exactly one affiliation row (UNIQUE producer_id + umbrella_id).
//   4. Name-match each parsed participant against existing producer
//      agents using the shared Dice + nameVariants logic from the Hanen
//      v3 matcher (HIGH / MEDIUM / REJECT classification).
//   5. Upsert `agent_affiliations` (status='active' for HIGH,
//      status='review_required' for MEDIUM, fallback to
//      pending_confirmation if the schema CHECK doesn't include
//      review_required). source='scraped'. evidence_json captures
//      event_id, parsed_name, parsed_slug, match_method.
//   6. Anything that doesn't reach MEDIUM lands in
//      `bm_unmatched_participants` for later triage.
//
// Idempotency: re-runs refresh evidence_json on pending rows and skip
// already-active rows. `bm_market_events.last_participants_scraped_at`
// is updated on each successful pass so the default mode ("events not
// scraped in the past 7 days") can prune the work-set automatically.
//
// Concurrency: keeps to 6 in-flight fetches (same as bm-events PR-56)
// so the source's per-IP rate-limits are respected.

import { getDb } from "../database/init";
import { renderPage } from "./render-client";
import { nameVariants, nameSimilarity } from "./name-matcher";

const EVENT_BASE = "https://bondensmarked.no/markeder/";

// Concurrency cap when fetching detail pages.
const FETCH_CONCURRENCY = 6;

// Per-page timeout. Detail pages are static HTML (~200KB) — 15s is plenty.
const FETCH_TIMEOUT_MS = 15000;

// Default lookback for the "stale" filter: re-scrape an event if its
// last_participants_scraped_at is null OR older than 7 days. Matches the
// daily-cron cadence + slack for retries.
const DEFAULT_STALE_DAYS = 7;

// Match-score thresholds. Conservative HIGH=0.95 (same as Hanen v3) and
// MEDIUM=0.85 (same as PR-67) — a false-positive here links a producer
// to the wrong lokallag, which is worse than a missed link (they sit in
// bm_unmatched_participants and can be reviewed).
const MATCH_THRESHOLD_HIGH = 0.95;
const MATCH_THRESHOLD_MEDIUM = 0.85;

// PR-71 hard cap on processing budget per call. The default "all
// upcoming" set is ~150 events; full sweep finishes in ~60s wall-clock
// at FETCH_CONCURRENCY=6 (each page ~3s). 500 covers a worst-case
// backlog without admitting accidental "scan the entire EU" requests.
const MAX_EVENTS_PER_RUN_HARD_CAP = 500;

export type BmParticipantRecord = {
  parsed_name: string;
  parsed_slug: string;          // /produsenter/<slug> — used as a fallback
                                // identity signal when names collide.
  parsed_category: string | null;
};

export type ParticipantMatchVerdict = {
  agent_id: string | null;
  score: number;
  method:
    | "exact_match"
    | "dice_high"
    | "dice_medium"
    | "below_threshold";
  confidence: "high" | "medium" | null;
};

export type BmParticipantsScrapeResult = {
  success: boolean;
  events_processed: number;
  events_skipped: number;       // no venue/lokallag resolvable, or fetch failed
  participants_found: number;
  affiliations_created: number;
  affiliations_updated: number;
  unmatched_logged: number;
  errors: string[];
};

// ─── 1. fetchEventDetailHtml ───────────────────────────────────
// Returns the raw HTML for a single event detail page. Designed to be
// stubbable for tests via the `fetcher` option. Direct HTTP GET — the
// detail pages are static (server-rendered Next.js with the full
// participant list in the initial HTML).
//
// useRenderWorker=true falls back to the lokal-render-worker (Playwright)
// — kept for parity with bm-events-scraper.ts in case bondensmarked.no
// switches to client-side rendering later. Default false.
export async function fetchEventDetailHtml(
  slug: string,
  opts?: {
    useRenderWorker?: boolean;
    fetcher?: (url: string) => Promise<string>;
  }
): Promise<string> {
  const url = EVENT_BASE + slug;
  if (opts?.fetcher) return opts.fetcher(url);
  if (opts?.useRenderWorker) {
    const r = await renderPage(url, { wait_for: "domcontentloaded" });
    return r.html;
  }
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ─── 2. parseEventParticipants ─────────────────────────────────
// Extract producer-participants from a BM event detail HTML string.
//
// Page structure (verified 2026-05-17 against
// https://bondensmarked.no/markeder/bragernes-torg-2026-05-30):
//
//   <section><h2>Produsenter (11)</h2>
//     <div class="grid ...">
//       <a href="/produsenter/eiker-gardsysteri" class="...">
//         <img alt="Eiker Gårdsysteri" ... />
//         <h3>Eiker Gårdsysteri</h3>
//         <span class="...">Ost og meieri</span>
//       </a>
//       ...
//     </div>
//   </section>
//
// We anchor on the `href="/produsenter/<slug>"` pattern (URL-stable, the
// section/class structure is Tailwind and may change). Each <a> block is
// captured and we extract:
//   - parsed_slug: the URL slug (used for de-duplication AND as a
//                  fallback identity signal — two producers with the
//                  same display name but different slugs are different).
//   - parsed_name: prefer <h3>; fall back to <img alt>.
//   - parsed_category: first <span> with non-trivial text inside.
//
// Returns a de-duplicated list (keyed on slug). Filters obvious
// false-positives like "/produsenter" (the index link in the navbar)
// and "/produsenter/finn-produsent" (utility links).
export function parseEventParticipants(html: string): BmParticipantRecord[] {
  if (!html || html.length < 500) return [];

  const seen = new Set<string>();
  const out: BmParticipantRecord[] = [];

  // Match each <a ...> block that anchors on /produsenter/<slug>. We
  // require the slug to be at least 3 chars to filter out trivial paths.
  const anchorRe = /<a[^>]+href=["']\/produsenter\/([a-z0-9][a-z0-9-]{2,})["'][^>]*>([\s\S]*?)<\/a>/gi;

  // Skip-list of slugs that are navbar/utility links, not actual
  // participants. These appear on every page and would otherwise dupe.
  const skipSlugs = new Set(["finn-produsent", "bli-produsent"]);

  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const slug = m[1];
    const inner = m[2];

    if (skipSlugs.has(slug)) continue;
    if (seen.has(slug)) continue;

    // Name: prefer <h3>; fall back to <img alt>.
    let name = "";
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    if (h3) name = stripTags(h3[1]).trim();
    if (!name) {
      const imgAlt = /<img[^>]+alt=["']([^"']+)["']/i.exec(inner);
      if (imgAlt) name = imgAlt[1].trim();
    }
    if (!name) continue;

    // First non-empty <span> inside the card — usually the category badge.
    let category: string | null = null;
    const spanRe = /<span[^>]*>([\s\S]*?)<\/span>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = spanRe.exec(inner)) !== null) {
      const text = stripTags(sm[1]).trim();
      // Skip empty, "+N" badges (multi-category overflow), and very short
      // strings (icons render as <span> with nothing useful inside).
      if (text && text.length >= 3 && !/^\+\d+$/.test(text)) {
        category = text;
        break;
      }
    }

    seen.add(slug);
    out.push({
      parsed_name: name,
      parsed_slug: slug,
      parsed_category: category,
    });
  }

  return out;
}

// ─── 3. resolveEventLokallag ───────────────────────────────────
// Given an event row's `venue_agent_id`, walk up the parent chain to
// the lokallag (umbrella_type='market_network'). Returns the
// market_network agent_id (or null if the chain is malformed — e.g. a
// venue with no parent_umbrella_id, or a parent that doesn't exist).
//
// We walk at most 5 hops as a defensive ceiling against a cyclic chain
// — the real tree is national → lokallag → venue (2 hops from venue).
export function resolveEventLokallag(venueAgentId: string): string | null {
  const db = getDb();
  let currentId: string | null = venueAgentId;
  for (let hop = 0; hop < 5 && currentId; hop++) {
    const row = db.prepare(
      "SELECT id, umbrella_type, parent_umbrella_id FROM agents WHERE id = ? LIMIT 1"
    ).get(currentId) as { id: string; umbrella_type: string | null; parent_umbrella_id: string | null } | undefined;
    if (!row) return null;
    if (row.umbrella_type === "market_network") return row.id;
    currentId = row.parent_umbrella_id;
  }
  return null;
}

// ─── 4. matchParticipantToAgent ────────────────────────────────
// Score the parsed participant name against the existing producer
// corpus using nameVariants() cross-product + Dice. Mirrors the
// Hanen v3 decision tree but simpler — BM has no fylke signal on the
// participant side (the event already locates them via the lokallag),
// so we use pure name-Dice with a tighter threshold.
//
// Decision tree:
//   Dice == 1.0          → HIGH    exact_match
//   Dice >= 0.95         → HIGH    dice_high
//   Dice >= 0.85         → MEDIUM  dice_medium
//   else                 → null    below_threshold
export function matchParticipantToAgent(
  participant: BmParticipantRecord,
  agents: Array<{ id: string; name: string }>
): ParticipantMatchVerdict {
  const participantVariants = nameVariants(participant.parsed_name);
  // Also include the slug as a normalised variant — sometimes
  // "Eventyrsmak v/ Bakke Gård" has slug "eventyrsmak-v-bakke-gard"
  // which after de-hyphenation is closer to the slug-style spelling
  // than the visible display name.
  const slugAsName = participant.parsed_slug.replace(/-/g, " ");
  for (const v of nameVariants(slugAsName)) {
    if (!participantVariants.includes(v)) participantVariants.push(v);
  }

  let best: { id: string; score: number } | null = null;
  for (const a of agents) {
    const agentVariants = nameVariants(a.name);
    let bestForAgent = 0;
    for (const pv of participantVariants) {
      for (const av of agentVariants) {
        const s = nameSimilarity(pv, av);
        if (s > bestForAgent) bestForAgent = s;
        if (bestForAgent === 1) break;
      }
      if (bestForAgent === 1) break;
    }
    if (!best || bestForAgent > best.score) {
      best = { id: a.id, score: bestForAgent };
    }
  }

  if (!best) {
    return { agent_id: null, score: 0, method: "below_threshold", confidence: null };
  }

  if (best.score === 1.0) {
    return { agent_id: best.id, score: best.score, method: "exact_match", confidence: "high" };
  }
  if (best.score >= MATCH_THRESHOLD_HIGH) {
    return { agent_id: best.id, score: best.score, method: "dice_high", confidence: "high" };
  }
  if (best.score >= MATCH_THRESHOLD_MEDIUM) {
    return { agent_id: best.id, score: best.score, method: "dice_medium", confidence: "medium" };
  }
  return { agent_id: null, score: best.score, method: "below_threshold", confidence: null };
}

// ─── 5. runBmEventParticipantsScraper ──────────────────────────
// Top-level pipeline. Selects events to process based on `opts`,
// fetches each detail page, name-matches participants, upserts
// affiliations, and records unmatched rows.
//
// Selection precedence:
//   - opts.eventIds: explicit list (overrides everything else).
//   - opts.allUpcoming: every event with start_at >= now, ignoring
//                       last_participants_scraped_at.
//   - default: events with start_at >= now AND
//              (last_participants_scraped_at IS NULL
//               OR last_participants_scraped_at < now - 7 days).
export async function runBmEventParticipantsScraper(opts?: {
  eventIds?: number[];
  allUpcoming?: boolean;
  dryRun?: boolean;
  useRenderWorker?: boolean;
  fetcher?: (url: string) => Promise<string>;
  staleDays?: number;
  maxEvents?: number;
}): Promise<BmParticipantsScrapeResult> {
  const result: BmParticipantsScrapeResult = {
    success: false,
    events_processed: 0,
    events_skipped: 0,
    participants_found: 0,
    affiliations_created: 0,
    affiliations_updated: 0,
    unmatched_logged: 0,
    errors: [],
  };

  const dryRun = opts?.dryRun === true;
  const useRenderWorker = opts?.useRenderWorker === true;
  const staleDays = Math.max(1, Math.floor(opts?.staleDays ?? DEFAULT_STALE_DAYS));
  const maxEvents = Math.min(
    Math.max(1, Math.floor(opts?.maxEvents ?? MAX_EVENTS_PER_RUN_HARD_CAP)),
    MAX_EVENTS_PER_RUN_HARD_CAP,
  );

  const db = getDb();

  // ── 5.1 select events to process ─────────────────────────────
  type EventRow = { id: number; event_slug: string; venue_agent_id: string; event_name: string };
  let events: EventRow[] = [];
  try {
    if (opts?.eventIds && opts.eventIds.length > 0) {
      const ids = opts.eventIds.slice(0, maxEvents);
      const placeholders = ids.map(() => "?").join(",");
      events = db.prepare(
        `SELECT id, event_slug, venue_agent_id, event_name FROM bm_market_events WHERE id IN (${placeholders})`
      ).all(...ids) as EventRow[];
    } else if (opts?.allUpcoming) {
      events = db.prepare(
        `SELECT id, event_slug, venue_agent_id, event_name FROM bm_market_events WHERE start_at >= datetime('now') ORDER BY start_at ASC LIMIT ?`
      ).all(maxEvents) as EventRow[];
    } else {
      // Default: upcoming AND stale-or-never.
      const staleCutoff = `-${staleDays} days`;
      events = db.prepare(
        `SELECT id, event_slug, venue_agent_id, event_name FROM bm_market_events
         WHERE start_at >= datetime('now')
           AND (last_participants_scraped_at IS NULL
                OR last_participants_scraped_at < datetime('now', ?))
         ORDER BY start_at ASC LIMIT ?`
      ).all(staleCutoff, maxEvents) as EventRow[];
    }
  } catch (e) {
    // Schema migration not applied yet (last_participants_scraped_at
    // missing). Fall back to "all upcoming, no stale filter" so the
    // first run can still proceed.
    try {
      events = db.prepare(
        `SELECT id, event_slug, venue_agent_id, event_name FROM bm_market_events WHERE start_at >= datetime('now') ORDER BY start_at ASC LIMIT ?`
      ).all(maxEvents) as EventRow[];
      result.errors.push(`stale-filter skipped: ${e instanceof Error ? e.message : String(e)}`);
    } catch (e2) {
      result.errors.push(`event-select failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
      return result;
    }
  }

  if (events.length === 0) {
    result.success = true;
    return result;
  }

  // ── 5.2 load producer corpus once ────────────────────────────
  let producers: Array<{ id: string; name: string }> = [];
  try {
    producers = db.prepare(
      "SELECT id, name FROM agents WHERE is_active = 1 AND role = 'producer' AND (umbrella_type IS NULL OR umbrella_type = '')"
    ).all() as Array<{ id: string; name: string }>;
  } catch (e) {
    result.errors.push(`producer corpus load failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // ── 5.3 detect schema flags once ─────────────────────────────
  let statusCheckIncludesReviewRequired = false;
  let hasLastScrapedColumn = false;
  let hasUnmatchedTable = false;
  try {
    const schemaRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_affiliations'"
    ).get() as { sql: string } | undefined;
    statusCheckIncludesReviewRequired = !!(schemaRow && /'review_required'/.test(schemaRow.sql));
  } catch { /* ignore */ }
  try {
    const cols = db.prepare("PRAGMA table_info(bm_market_events)").all() as Array<{ name: string }>;
    hasLastScrapedColumn = cols.some(c => c.name === "last_participants_scraped_at");
  } catch { /* ignore */ }
  try {
    const tbl = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bm_unmatched_participants'"
    ).get();
    hasUnmatchedTable = !!tbl;
  } catch { /* ignore */ }

  // Prepare upsert statements once.
  const insertAff = db.prepare(`
    INSERT INTO agent_affiliations
      (producer_id, umbrella_id, status, source, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, 'scraped', ?, ?, ?)
    ON CONFLICT(producer_id, umbrella_id) DO UPDATE SET
      status = CASE
        WHEN agent_affiliations.status IN ('pending_confirmation','review_required')
          THEN excluded.status
        ELSE agent_affiliations.status
      END,
      evidence_json = CASE
        WHEN agent_affiliations.status IN ('pending_confirmation','review_required','active')
          THEN excluded.evidence_json
        ELSE agent_affiliations.evidence_json
      END,
      updated_at = excluded.updated_at
  `);
  const insertUnmatched = hasUnmatchedTable
    ? db.prepare(`
        INSERT INTO bm_unmatched_participants
          (event_id, venue_id, parsed_name, parsed_slug, parsed_category, best_match_score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(event_id, parsed_name) DO UPDATE SET
          parsed_slug = excluded.parsed_slug,
          parsed_category = excluded.parsed_category,
          best_match_score = excluded.best_match_score
      `)
    : null;
  const updateScrapedAt = hasLastScrapedColumn
    ? db.prepare("UPDATE bm_market_events SET last_participants_scraped_at = datetime('now') WHERE id = ?")
    : null;

  // ── 5.4 process events in concurrent batches ─────────────────
  const nowIso = new Date().toISOString();
  for (let i = 0; i < events.length; i += FETCH_CONCURRENCY) {
    const batch = events.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ev => {
        const html = await fetchEventDetailHtml(ev.event_slug, {
          useRenderWorker,
          fetcher: opts?.fetcher,
        });
        return { ev, html };
      })
    );

    for (const s of settled) {
      if (s.status === "rejected") {
        result.events_skipped++;
        result.errors.push(`fetch failed: ${String(s.reason).slice(0, 200)}`);
        continue;
      }
      const { ev, html } = s.value;
      const lokallag = resolveEventLokallag(ev.venue_agent_id);
      if (!lokallag) {
        result.events_skipped++;
        result.errors.push(`event ${ev.id} (${ev.event_slug}): could not resolve lokallag from venue_agent_id=${ev.venue_agent_id}`);
        continue;
      }
      const participants = parseEventParticipants(html);
      result.events_processed++;
      result.participants_found += participants.length;

      for (const p of participants) {
        let verdict: ParticipantMatchVerdict;
        try {
          verdict = matchParticipantToAgent(p, producers);
        } catch (e) {
          result.errors.push(`match failed for ${p.parsed_slug}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }

        const evidence = {
          source: "bondensmarked.no/markeder",
          event_id: ev.id,
          event_slug: ev.event_slug,
          venue_agent_id: ev.venue_agent_id,
          scraped_at: nowIso,
          parsed_name: p.parsed_name,
          parsed_slug: p.parsed_slug,
          parsed_category: p.parsed_category,
          match_score: verdict.score,
          match_method: verdict.method,
          match_confidence: verdict.confidence,
        };

        if (verdict.agent_id && verdict.confidence === "high") {
          if (dryRun) {
            result.affiliations_created++;
            continue;
          }
          try {
            const existing = db.prepare(
              "SELECT id FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?"
            ).get(verdict.agent_id, lokallag);
            insertAff.run(
              verdict.agent_id,
              lokallag,
              "active",
              JSON.stringify(evidence),
              nowIso,
              nowIso,
            );
            if (existing) result.affiliations_updated++;
            else result.affiliations_created++;
          } catch (e) {
            result.errors.push(`upsert active for ${p.parsed_slug}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (verdict.agent_id && verdict.confidence === "medium") {
          if (dryRun) {
            result.affiliations_created++;
            continue;
          }
          const targetStatus = statusCheckIncludesReviewRequired
            ? "review_required"
            : "pending_confirmation";
          try {
            const existing = db.prepare(
              "SELECT id FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?"
            ).get(verdict.agent_id, lokallag);
            insertAff.run(
              verdict.agent_id,
              lokallag,
              targetStatus,
              JSON.stringify({ ...evidence, review_required: true }),
              nowIso,
              nowIso,
            );
            if (existing) result.affiliations_updated++;
            else result.affiliations_created++;
          } catch (e) {
            result.errors.push(`upsert review for ${p.parsed_slug}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          // below_threshold — log to unmatched table.
          if (dryRun) {
            result.unmatched_logged++;
            continue;
          }
          if (insertUnmatched) {
            try {
              insertUnmatched.run(
                ev.id,
                lokallag,
                p.parsed_name,
                p.parsed_slug,
                p.parsed_category,
                verdict.score,
              );
              result.unmatched_logged++;
            } catch (e) {
              result.errors.push(`unmatched log for ${p.parsed_slug}: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            result.unmatched_logged++; // counted but not persisted
          }
        }
      }

      // Stamp the event as scraped — even if 0 participants were parsed,
      // so we don't re-fetch it tomorrow for an empty page.
      if (!dryRun && updateScrapedAt) {
        try { updateScrapedAt.run(ev.id); } catch (e) {
          result.errors.push(`stamp scraped_at for event ${ev.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
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
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Exported for tests that need to validate the threshold constants.
export const _internals = {
  MATCH_THRESHOLD_HIGH,
  MATCH_THRESHOLD_MEDIUM,
  DEFAULT_STALE_DAYS,
  MAX_EVENTS_PER_RUN_HARD_CAP,
};

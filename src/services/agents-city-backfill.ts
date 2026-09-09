// ─── RFB City Backfill Worker ────────────────────────────────────────
// dev-request 2026-09-09-outreach-profilkvalitet.
//
// WHY
// ───
// `agents.city` is often empty, and there is a measurable chain of profile-
// quality damage that traces to exactly that: the seo.ts hero location line
// doesn't render (`cityName ? … : ""`), buildProducerAnswerFirstOpening
// returns null (needs at least two of {products, city}), JSON-LD
// addressLocality is empty, and the contact card shows a bare postal code
// with no city name. Outreach emails are going out pointing producers at
// profiles missing all four.
//
// Before this worker there was no write path for `agents.city` at all (see
// routes/admin-knowledge.ts's new city write-path block — PUT
// /admin/knowledge accepted address/postalCode/about/products/description/
// categories but not city) and no backfill for it either; `city` was set
// once, at POST /admin/agents/register, and never touched again.
//
// THE ONE RULE THAT OUTRANKS YIELD (same rule agents-postal-backfill.ts
// enforces in the opposite direction)
// ────────────────────────────────────────────────────────────────────
// NEVER WRITE AN UNCORROBORATED OR AMBIGUOUS CITY. A wrong city is not a
// graceful degradation — it renders confidently on the public profile page,
// in JSON-LD, and in the outreach email itself. Every ambiguous, partial, or
// uncorroborated case therefore skips the row and stamps/logs the outcome;
// writing nothing is always the correct fallback.
//
// SOURCE PRIORITY (per dev-request spec, cheapest/most-authoritative first)
// ───────────────────────────────────────────────────────────────────────
//   (a) Brreg forretningsadresse `poststed`, keyed on `agents.org_nr` — the
//       producer's own registered business address; reuses
//       `fetchBrregBusinessAddress` (services/brreg-client.ts), which never
//       throws and returns null on any transport/parse failure or 404. A
//       Brreg hit is corroborated, not trusted outright: its own
//       `postnummer` must literally equal `agent_knowledge.postal_code`
//       (skipped entirely when no postal_code is on file to corroborate
//       against), and the tier is gated off when `agents.brreg_flag` is
//       dissolved/bankrupt/wrong_nace — the same cross-verification
//       discipline Tiers b/c apply below (post-review fix, PR #842).
//   (b) The official postal-code registry (Bring's postnummerregister —
//       postnummer -> poststed is a strict, unambiguous 1:1 official
//       mapping in Norway, no disambiguation needed), keyed on
//       `agent_knowledge.postal_code`. Fetched once per process and cached;
//       a truncated/garbage response (fewer than
//       POSTAL_REGISTRY_MIN_SANE_ROWS rows) is never trusted or cached.
//   (c) Kartverket, deriving `poststed` from the free-text address, but
//       ONLY when a `postal_code` is already on file to cross-verify
//       against: reuses `parseAddressParts`/`probeKartverket` from
//       agents-postal-backfill.ts (SAME G1-enumerability/G2-uniqueness
//       guards that worker already relies on) and additionally requires the
//       resolved hit's own `postnummer` to literally EQUAL the given
//       `postal_code` — the exact "vacuous inline-number check" failure
//       postal-backfill's own REVIEW B2 documents (a conjunctive
//       street+number query can match a DIFFERENT record whose house
//       number coincidentally equals the search token) does not get a free
//       pass here just because the token happens to be a postal code
//       instead of a house number.
//
// On ambiguity or when nothing corroborates, the row is SKIPPED (never
// written) and the outcome is stamped so the next tick's ordering rotates
// past it, same "ALWAYS STAMP" discipline agents-postal-backfill.ts
// documents at length (a worker whose refusal path does not write a stamp
// re-picks the identical batch forever).
//
// WRITE PATH
// ──────────
// Applied directly against the DB (`agents.city`), mirroring agents-postal-
// backfill.ts's own architecture (this worker runs unattended, in the same
// process, and every candidate row is a pure ADD by construction — city is
// only ever selected when it is already empty — so the "never overwrite a
// populated value without allow_correct" gate PUT /admin/knowledge's new
// city write-path block enforces is trivially satisfied here too):
//   • the UPDATE itself carries `AND (city IS NULL OR TRIM(city) = '')`, so
//     even a selector bug or a concurrent owner edit landing between SELECT
//     and UPDATE cannot clobber a city that already exists — the identical
//     never-overwrite discipline agents-postal-backfill.ts's `writePostal`
//     statement uses.
//   • field_provenance for "city" is merged via `mergeFieldProvenance`
//     (routes/admin-knowledge.ts, already reused this way by
//     services/dental-store.ts and services/search-enrich-sweep.ts) — the
//     SAME provenance shape/merge semantics the rest of the platform's
//     write paths use, so a later reader (or a later allow_correct
//     overwrite through PUT /admin/knowledge) can tell a backfilled city
//     apart from a scraped one.
//   • city_backfill_attempted_at is stamped on EVERY attempt, including
//     skips — the ALWAYS-STAMP rotation discipline above.
//
// Deliberately NOT gated by the enrichment write-pause guard: agents-postal-
// backfill.ts (the worker this one mirrors) is itself listed as a disclosed,
// ungated gap in that guard module's own header comment ("Still ungated,
// documented rather than proven unreachable: … /admin/postal-backfill …").
// This worker follows the same, already-accepted posture rather than
// inventing a new one — a follow-up to gate the whole backfill family is
// noted there, not solved here.

import { getDb } from "../database/init";
import { fetchBrregBusinessAddress, type BrregAddress } from "./brreg-client";
import { normalizeCityLabel } from "./city-normalizer";
import { takeKartverketBudget } from "./kartverket-budget";
import {
  parseAddressParts,
  probeKartverket,
  type PostalProbeResult,
} from "./agents-postal-backfill";
import type { GeocodeDeps } from "./dental-geocode-worker";
import { mergeFieldProvenance } from "../routes/admin-knowledge";
import {
  startBackfillScheduler,
  type BackfillSchedulerDeps,
  type BackfillSchedulerHandle,
} from "./backfill-scheduler";

const POSTAL_REGISTRY_URL = "https://www.bring.no/postnummerregister-ansi.txt";
/** Kartverket throttle after each probe — same pacing as agents-postal-backfill.ts. */
const KARTVERKET_THROTTLE_MS = 350;
/**
 * Sanity floor for the fetched postal registry. Norway has ~4 400 in-use
 * postnummer; a response with far fewer rows is a truncated fetch or an
 * error page, not the real registry, and must never be cached or trusted.
 */
const POSTAL_REGISTRY_MIN_SANE_ROWS = 1000;

export type AgentsCityBackfillDeps = GeocodeDeps;

// ── Postal-code registry (source b) ────────────────────────────────────

async function fetchPostalRegistryText(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(POSTAL_REGISTRY_URL, {
      headers: { "User-Agent": "RFBBot/1.0 (https://rettfrabonden.com)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // The file is legacy ANSI/ISO-8859-1 (per its own filename) — decoding as
    // UTF-8 would corrupt every æ/ø/å poststed.
    return new TextDecoder("iso-8859-1").decode(buf);
  } catch {
    return null;
  }
}

/**
 * Parse the tab-separated postnummerregister text into postnummer -> poststed.
 * Pure — exported for unit-testing without network I/O. Malformed/short lines
 * are skipped, not fatal to the rest of the parse. Case where the SAME
 * postnummer appears twice keeps the FIRST occurrence (the registry is
 * expected to be a clean 1:1 mapping; a duplicate is treated as noise, not a
 * reason to prefer a later row).
 */
export function parsePostalRegistry(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const pn = (parts[0] ?? "").trim();
    const poststed = (parts[1] ?? "").trim();
    if (!/^\d{4}$/.test(pn) || !poststed) continue;
    if (!map.has(pn)) map.set(pn, poststed);
  }
  return map;
}

// Per-process cache — fetched (and re-usable) at most once per process,
// mirroring brreg-client.ts's own per-process cache convention. A
// too-small/garbage parse is never cached (see POSTAL_REGISTRY_MIN_SANE_ROWS).
let registryCache: Map<string, string> | null = null;
let registryCachePromise: Promise<Map<string, string> | null> | null = null;

export function __clearCityPostalRegistryCacheForTesting(): void {
  registryCache = null;
  registryCachePromise = null;
}

async function getPostalRegistry(fetchImpl: typeof fetch): Promise<Map<string, string> | null> {
  if (registryCache) return registryCache;
  if (!registryCachePromise) {
    registryCachePromise = (async () => {
      const text = await fetchPostalRegistryText(fetchImpl);
      if (!text) return null;
      const map = parsePostalRegistry(text);
      if (map.size < POSTAL_REGISTRY_MIN_SANE_ROWS) {
        console.warn(
          `[city-backfill] postnummerregister fetch looked truncated/garbage (${map.size} rows) — not cached, not trusted`,
        );
        return null;
      }
      registryCache = map;
      return map;
    })().finally(() => {
      registryCachePromise = null;
    });
  }
  return registryCachePromise;
}

// ── Per-row resolution ──────────────────────────────────────────────────

export type CityResolution =
  | {
      status: "resolved";
      city: string;
      source: "brreg_forretningsadresse" | "postnummerregister" | "kartverket_adresse";
      detail: string;
    }
  | { status: "skip"; reason: string; detail?: string };

/**
 * Resolve one producer's city, or refuse. Tries (a) Brreg forretningsadresse,
 * then (b) the postal-code registry, then (c) Kartverket — see the module
 * header for the full rationale and safety guards on each tier. Never
 * throws: any tier's own failure just falls through to the next.
 */
export async function resolveCityForRow(
  row: {
    org_nr: string | null;
    address: string | null;
    postal_code: string | null;
    /**
     * Optional — only the worker's DB-backed candidate rows carry it (see
     * runCityBackfillTick's SELECT); tests/callers that omit it are treated
     * as "no flag on file" (never gates Tier a).
     */
    brreg_flag?: string | null;
  },
  deps: AgentsCityBackfillDeps = {},
): Promise<CityResolution> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // ── (a) Brreg forretningsadresse ────────────────────────────────────
  // REVIEW (PR #842, code-reviewer CHANGES-REQUESTED): this tier used to
  // trust a single Brreg hit outright, with zero corroboration — the one
  // tier that didn't follow this module's own "NEVER WRITE AN
  // UNCORROBORATED OR AMBIGUOUS CITY" rule that Tiers b/c both already
  // enforce for their own inputs. Fixed with the SAME two disciplines b/c
  // already apply:
  //   1. cross-check: the Brreg hit's own `postnummer` must literally EQUAL
  //      `row.postal_code` when a postal_code is on file — identical in
  //      spirit to Tier c's own "resolved hit's own postnummer must
  //      literally EQUAL the given postal_code" rule below. No postal_code
  //      on file at all means nothing to corroborate against, so Tier a is
  //      skipped entirely (same posture Tiers b/c already take when their
  //      own corroboration input is missing/unusable).
  //   2. gate: `agents.brreg_flag` of dissolved/bankrupt/wrong_nace (the
  //      SAME BRREG_SWEEP_REVIEW_FLAGS set routes/admin-agents.ts already
  //      classifies as review-worthy) skips Tier a — a dissolved/bankrupt
  //      entity's registered Brreg address is exactly the kind of stale
  //      signal this worker must not write confidently.
  // `brreg_verified` is deliberately NOT required here. Per
  // runBrregVerifyForRegister (routes/admin-agents.ts:155-192) it encodes
  // "active AND NACE overlaps the vertical's allowlist" — a business-
  // eligibility check unrelated to whether the registered ADDRESS is
  // trustworthy — and it defaults to 0 for the many pre-existing org_nr
  // values captured before the brreg-verification-gate slice existed (0
  // there means "never checked", not "known-bad"). The rest of this
  // codebase (registration itself, admin-outreach-pool.ts, etc.) already
  // treats an org_nr as usable without requiring brreg_verified = 1;
  // requiring it here would invent a stricter standard than the codebase
  // applies to org_nr-derived data anywhere else. brreg_flag is a
  // different, narrower signal — an actual negative Brreg finding, not
  // merely "never checked" — and is what gates, above.
  const orgNr = (row.org_nr || "").trim();
  const postalCode = (row.postal_code || "").trim();
  const postalCodeUsable = /^\d{4}$/.test(postalCode);
  const brregFlag = (row.brreg_flag || "").trim();
  const brregFlagBlocksTierA =
    brregFlag === "dissolved" || brregFlag === "bankrupt" || brregFlag === "wrong_nace";

  if (orgNr && !brregFlagBlocksTierA && postalCodeUsable) {
    let brregAddr: BrregAddress | null = null;
    try {
      brregAddr = await fetchBrregBusinessAddress(orgNr, fetchImpl);
    } catch {
      brregAddr = null;
    }
    if (brregAddr?.poststed) {
      if (brregAddr.postnummer === postalCode) {
        const display = normalizeCityLabel(brregAddr.poststed);
        if (display) {
          return {
            status: "resolved",
            city: display,
            source: "brreg_forretningsadresse",
            detail: `brreg org ${orgNr}`,
          };
        }
      }
      // else: postnummer missing/mismatched vs row.postal_code — not
      // corroborated, never trust it "by coincidence" (same REVIEW B2
      // posture Tier c documents below) — fall through to Tier b/c.
    }
  }

  // ── (b) Official postal-code registry ───────────────────────────────
  if (postalCodeUsable) {
    let registry: Map<string, string> | null = null;
    try {
      registry = await getPostalRegistry(fetchImpl);
    } catch {
      registry = null;
    }
    const poststed = registry?.get(postalCode);
    if (poststed) {
      const display = normalizeCityLabel(poststed);
      if (display) {
        return {
          status: "resolved",
          city: display,
          source: "postnummerregister",
          detail: `postnummer ${postalCode}`,
        };
      }
    }
  }

  // ── (c) Kartverket — address text, cross-verified against postal_code ──
  const address = (row.address || "").trim();
  if (address && postalCodeUsable) {
    const { street } = parseAddressParts(address);
    if (street && /\d/.test(street)) {
      let probe: PostalProbeResult;
      try {
        await takeKartverketBudget(sleep, 1);
        probe = await probeKartverket(street, postalCode, null, fetchImpl);
        await sleep(KARTVERKET_THROTTLE_MS);
      } catch {
        probe = { status: "no_match", query: `${street} ${postalCode}` };
      }
      if (probe.status === "resolved") {
        // REVIEW B2 (agents-postal-backfill.ts): a conjunctive street+number
        // query can match a DIFFERENT record whose house number happens to
        // equal the search token. Require the resolved postnummer to
        // literally equal the one we already trust before reading its
        // poststed — never accept it "by coincidence".
        if (probe.postal_code === postalCode && probe.hit.poststed) {
          const display = normalizeCityLabel(probe.hit.poststed);
          if (display) {
            return {
              status: "resolved",
              city: display,
              source: "kartverket_adresse",
              detail: `${probe.query} → ${probe.hit.poststed}`,
            };
          }
        }
        // Resolved to a DIFFERENT postnummer than the one on file, or the
        // hit carries no poststed — not corroborated, fall through to skip.
      } else if (probe.status === "ambiguous" || probe.status === "not_enumerable") {
        return {
          status: "skip",
          reason: "kartverket_ambiguous",
          detail: probe.status === "ambiguous" ? probe.distinct.join("/") : `${probe.total} hits`,
        };
      }
      // no_match / uncorroborated (place=null so G3 never fires) → fall through.
    }
  }

  return { status: "skip", reason: "no_usable_source" };
}

// ── Worker ──────────────────────────────────────────────────────────────

export type CityBackfillPlannedChange = {
  agent_id: string;
  name: string;
  city: string | null;
  source: string | null;
  outcome: string;
  detail: string | null;
};

export type CityBackfillResult = {
  dry_run: boolean;
  processed: number;
  resolved: number;
  resolved_brreg: number;
  resolved_postnummerregister: number;
  resolved_kartverket: number;
  skipped: number;
  errors: number;
  duration_ms: number;
  planned: CityBackfillPlannedChange[];
  skipped_already_running: boolean;
};

type CandidateRow = {
  agent_id: string;
  name: string | null;
  org_nr: string | null;
  address: string | null;
  postal_code: string | null;
  brreg_flag: string | null;
};

// Strictly-increasing attempt stamps — same reasoning (and the same measured
// failure) as agents-postal-backfill.ts's nextAttemptStamp(): datetime('now')
// has 1-second granularity, so a warm batch stamping inside one second would
// collapse the "oldest first" ordering to the id tiebreaker and the next tick
// would re-pick the identical rows.
let lastStampMs = 0;
function nextAttemptStamp(): string {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs).toISOString();
}

// Single-flight guard: an adaptive tick and an admin POST can overlap, and
// selection happens up front, so two concurrent ticks would select the
// identical batch.
let running = false;

export const CITY_BACKFILL_LIMIT_DEFAULT = 50;

/** Work-queue counts for the admin endpoint / ops. One table scan. */
export function cityBackfillQueueStatus(): {
  active: number;
  city_empty: number;
  city_empty_with_source: number;
  never_attempted: number;
  backfilled: number;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS active,
         COUNT(*) FILTER (WHERE a.city IS NULL OR TRIM(a.city) = '') AS city_empty,
         COUNT(*) FILTER (
           WHERE (a.city IS NULL OR TRIM(a.city) = '')
             AND (
                   (a.org_nr IS NOT NULL AND TRIM(a.org_nr) <> '')
                OR (k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> '')
                OR (k.address IS NOT NULL AND TRIM(k.address) <> '')
                 )
         ) AS city_empty_with_source,
         COUNT(*) FILTER (
           WHERE (a.city IS NULL OR TRIM(a.city) = '')
             AND k.city_backfill_attempted_at IS NULL
         ) AS never_attempted,
         COUNT(*) FILTER (WHERE k.city_backfill_source IS NOT NULL) AS backfilled
       FROM agents a
       JOIN agent_knowledge k ON k.agent_id = a.id
       WHERE a.is_active = 1`,
    )
    .get() as any;
  return {
    active: row?.active ?? 0,
    city_empty: row?.city_empty ?? 0,
    city_empty_with_source: row?.city_empty_with_source ?? 0,
    never_attempted: row?.never_attempted ?? 0,
    backfilled: row?.backfilled ?? 0,
  };
}

function emptyStats(dryRun: boolean): CityBackfillResult {
  return {
    dry_run: dryRun,
    processed: 0,
    resolved: 0,
    resolved_brreg: 0,
    resolved_postnummerregister: 0,
    resolved_kartverket: 0,
    skipped: 0,
    errors: 0,
    duration_ms: 0,
    planned: [],
    skipped_already_running: false,
  };
}

/**
 * One tick. Selects up to `limit` active producers with an empty `city` and
 * at least one usable source (org_nr, postal_code, or address), resolves
 * what it safely can, and stamps EVERY attempt (including skips) so the
 * next tick's rotation is disjoint.
 */
export async function cityBackfillTick(
  limit: number = CITY_BACKFILL_LIMIT_DEFAULT,
  deps: AgentsCityBackfillDeps & { dryRun?: boolean } = {},
): Promise<CityBackfillResult> {
  if (running) {
    console.log("[city-backfill] tick skipped — a tick is already running");
    return { ...emptyStats(deps.dryRun === true), skipped_already_running: true };
  }
  running = true;
  try {
    return await runCityBackfillTick(limit, deps);
  } finally {
    running = false;
  }
}

async function runCityBackfillTick(
  limit: number,
  deps: AgentsCityBackfillDeps & { dryRun?: boolean },
): Promise<CityBackfillResult> {
  const start = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb();
  const stats = emptyStats(dryRun);

  const candidates = db
    .prepare(
      `SELECT a.id AS agent_id, a.name AS name, a.org_nr AS org_nr,
              a.brreg_flag AS brreg_flag,
              k.address AS address, k.postal_code AS postal_code
         FROM agents a
         JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1
          AND (a.city IS NULL OR TRIM(a.city) = '')
          AND (
                (a.org_nr IS NOT NULL AND TRIM(a.org_nr) <> '')
             OR (k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> '')
             OR (k.address IS NOT NULL AND TRIM(k.address) <> '')
              )
        ORDER BY (k.city_backfill_attempted_at IS NOT NULL),
                 k.city_backfill_attempted_at ASC,
                 a.id ASC
        LIMIT ?`,
    )
    .all(limit) as CandidateRow[];

  // NEVER OVERWRITE, enforced by the write itself and not only by the
  // selector — same discipline as agents-postal-backfill.ts's writePostal.
  const writeCity = db.prepare(
    `UPDATE agents SET city = ? WHERE id = ? AND (city IS NULL OR TRIM(city) = '')`,
  );
  const stampProvenance = db.prepare(
    `UPDATE agent_knowledge
        SET field_provenance = ?,
            city_backfill_source = ?,
            city_backfill_outcome = ?,
            city_backfill_attempted_at = ?,
            updated_at = ?
      WHERE agent_id = ?`,
  );
  const stampOnly = db.prepare(
    `UPDATE agent_knowledge
        SET city_backfill_outcome = ?,
            city_backfill_attempted_at = ?
      WHERE agent_id = ?`,
  );
  const getProvenance = db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`);

  for (const row of candidates) {
    stats.processed++;
    try {
      const resolution = await resolveCityForRow(row, deps);

      if (resolution.status === "resolved") {
        stats.planned.push({
          agent_id: row.agent_id,
          name: row.name ?? "",
          city: resolution.city,
          source: resolution.source,
          outcome: "resolved",
          detail: resolution.detail,
        });
        if (!dryRun) {
          const res = writeCity.run(resolution.city, row.agent_id);
          if (res.changes > 0) {
            stats.resolved++;
            if (resolution.source === "brreg_forretningsadresse") stats.resolved_brreg++;
            else if (resolution.source === "postnummerregister") stats.resolved_postnummerregister++;
            else stats.resolved_kartverket++;

            // Merge field_provenance for "city" the SAME way PUT
            // /admin/knowledge does (mergeFieldProvenance), so a later
            // reader — or a later allow_correct overwrite through that
            // route — can tell this value apart from a scraped one.
            const existingRow = getProvenance.get(row.agent_id) as { field_provenance?: string } | undefined;
            let existing: Record<string, unknown> = {};
            if (existingRow?.field_provenance) {
              try {
                const parsed = JSON.parse(existingRow.field_provenance);
                if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
              } catch {
                existing = {};
              }
            }
            let merged: Record<string, unknown> = existing;
            try {
              merged = mergeFieldProvenance(existing, {
                city: [
                  {
                    value: resolution.city,
                    source_type: resolution.source,
                    fetched_at: nextAttemptStamp(),
                  },
                ],
              });
            } catch (mergeErr) {
              console.error(`[city-backfill] provenance merge failed for ${row.agent_id}:`, mergeErr);
            }
            stampProvenance.run(
              JSON.stringify(merged),
              resolution.source,
              "resolved",
              nextAttemptStamp(),
              new Date().toISOString(),
              row.agent_id,
            );
          } else {
            // The never-overwrite guard fired: a city appeared between our
            // SELECT and this UPDATE (an owner editing their own profile
            // mid-tick). Not a write we made — do not claim it as resolved,
            // but STILL stamp the attempt (ALWAYS STAMP) so the row rotates.
            stampOnly.run("skipped_existing", nextAttemptStamp(), row.agent_id);
            stats.planned[stats.planned.length - 1].outcome = "skipped_existing";
            stats.planned[stats.planned.length - 1].city = null;
          }
        }
        continue;
      }

      stats.skipped++;
      stats.planned.push({
        agent_id: row.agent_id,
        name: row.name ?? "",
        city: null,
        source: null,
        outcome: resolution.reason,
        detail: resolution.detail ?? null,
      });
      if (!dryRun) stampOnly.run(resolution.reason, nextAttemptStamp(), row.agent_id);
    } catch (err) {
      stats.errors++;
      console.error(`[city-backfill] failed for ${row.agent_id}:`, err);
      // ALWAYS STAMP, including on the error path — agents-postal-backfill.ts
      // shipped its sibling worker without this once and a persistently-
      // throwing row starved the whole queue behind the LIMIT.
      stats.planned.push({
        agent_id: row.agent_id,
        name: row.name ?? "",
        city: null,
        source: null,
        outcome: "error",
        detail: String((err as any)?.message || err),
      });
      if (!dryRun) {
        try {
          stampOnly.run("error", nextAttemptStamp(), row.agent_id);
        } catch (stampErr) {
          console.error(`[city-backfill] could not stamp attempt for ${row.agent_id}:`, stampErr);
        }
      }
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}

// ── Scheduling ────────────────────────────────────────────────────────

export const CITY_BACKFILL_BACKLOG_INTERVAL_MS = 120_000;
export const CITY_BACKFILL_IDLE_INTERVAL_MS = 60 * 60_000;
export const CITY_BACKFILL_BOOT_DELAY_MS = 50_000;

/** True while rows remain that this worker has never attempted. */
export function cityBackfillHasBacklog(): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agents a
         JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1
          AND (a.city IS NULL OR TRIM(a.city) = '')
          AND (
                (a.org_nr IS NOT NULL AND TRIM(a.org_nr) <> '')
             OR (k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> '')
             OR (k.address IS NOT NULL AND TRIM(k.address) <> '')
              )
          AND k.city_backfill_attempted_at IS NULL`,
    )
    .get() as any;
  return (row?.n ?? 0) > 0;
}

/**
 * Register the adaptive tick loop (src/index.ts). Not wired into boot by
 * this slice — see the admin-triggered route (POST /admin/agents/
 * city-backfill, routes/marketplace.ts) for the reviewable/rehearsable path
 * this ships with; wiring the automatic scheduler is a one-line follow-up
 * once the admin-triggered runs have been spot-checked on prod, same
 * staged rollout agents-postal-backfill.ts went through.
 */
export function startCityBackfillWorker(
  overrides: Partial<BackfillSchedulerDeps> = {},
): BackfillSchedulerHandle {
  return startBackfillScheduler({
    label: "city-backfill",
    backlogDelayMs: CITY_BACKFILL_BACKLOG_INTERVAL_MS,
    idleDelayMs: CITY_BACKFILL_IDLE_INTERVAL_MS,
    bootDelayMs: CITY_BACKFILL_BOOT_DELAY_MS,
    hasBacklog: cityBackfillHasBacklog,
    runTick: async () => {
      const r = await cityBackfillTick(CITY_BACKFILL_LIMIT_DEFAULT);
      if (r.skipped_already_running) {
        console.log("[city-backfill] tick skipped — the previous tick is still running");
        return;
      }
      console.log(
        `[city-backfill] tick processed=${r.processed} resolved=${r.resolved} ` +
        `(brreg=${r.resolved_brreg} postnummerregister=${r.resolved_postnummerregister} kartverket=${r.resolved_kartverket}) ` +
        `skipped=${r.skipped} errors=${r.errors} duration_ms=${r.duration_ms}`,
      );
    },
    ...overrides,
  });
}

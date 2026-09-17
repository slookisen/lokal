// ─── Experiences provider org.nr-from-own-website backfill (Trinn A) ───────
//
// PROBLEM. POST /admin/experiences-content-judge-sweep's quarantine-exit
// promotion logic (routes/opplevelser.ts) requires provider.brreg_active===1
// as one of its three independent promotion requirements. The existing
// re-check (services/experience-brreg-recheck-backfill.ts) re-runs
// classifyProvider()'s Brreg NAME search for providers stuck at
// brreg_active IS NULL — but a fuzzy name search only resolves a small
// fraction of them; 1774 providers are stuck at brreg_active IS NULL
// forever because their name is too common/ambiguous for a confident Brreg
// name match. See dev-request 2026-09-14-opplevagent-karantene-utgang-
// brreg-krav.md (slookisen/A2A) for the full background and Daniel's
// approval.
//
// THIS FILE is "Trinn A": instead of searching Brreg by NAME, it fetches the
// provider's OWN website, extracts the provider's OWN org.nr — but only when
// it is actually LABELED as one on the page ("Org.nr: 123 456 789",
// "Foretaksnr 123456789", "NO 123 456 789 MVA" — never a bare unlabeled
// 9-digit number, which would false-positive on phone numbers, postal
// addresses, product codes, etc.) — and looks THAT org.nr up directly in
// Brreg (verifyOrgNumber(), services/brreg-client.ts — a precise
// GET /enheter/{orgNr} lookup, not a fuzzy name search). A direct org.nr hit
// is corroborated (name or poststed/kommune must agree with the provider's
// own row) before ever being written, per Daniel's explicit condition — "ved
// tvil: ikke skriv".
//
// SCOPE — TRINN A ONLY. "Trinn B" (a name+kommune Brreg search when no
// org.nr can be found on the website — needs a kommune -> kommunenummer
// table this slice does not have) is EXPLICITLY OUT OF SCOPE here. A
// provider whose website yields no labeled org.nr is simply left
// `still_unresolved` (bucketed under `no_orgnr_found`) — correct, expected
// behavior for THIS slice, not a bug.
//
// NON-GOALS (unchanged by this file): the content-judge-sweep promotion
// gate's brreg_active===1 requirement itself; the content-judge; the
// bulk-load admission gate; experience-brreg-recheck-backfill.ts's own
// name-search path (this file adds a second, independent path — zero
// changes to that file). This file only ever feeds brreg_active a fresh,
// confirmed answer for providers whose OWN website carries a labeled org.nr
// — it never relaxes what reads that column.
//
// PATTERN: mirrors services/experience-brreg-recheck-backfill.ts's overall
// shape (dry-run-default, admin-key-gated route, keyset `after` pagination,
// per-row try/catch isolation, org_nr-collision guard before any write,
// result-shape conventions) — see that file's own header for the rationale
// behind each of those. New here (this file has no sibling for these):
// fetching an arbitrary PRODUCER website per candidate (SSRF-guarded via
// fetch-page.ts's fetchPage()) and a bounded, wall-clock TIME BUDGET across
// the whole batch (see EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS below) — a
// near-identical unbounded per-target website-fetch loop already caused a
// real production 60s-timeout incident on the RFB side (dev-request
// 2026-09-02-rfb-website-discovery-timeout-tier1-uten-url, A2A repo); this
// file mirrors that fix's own pattern (routes/admin-rfb-website-discovery.ts,
// RFB_WD_TIME_BUDGET_MS) rather than repeating the mistake.
//
// SELECTION. `brreg_active IS NULL` AND a non-blank `hjemmeside` (nothing to
// fetch otherwise) AND NOT owner-locked (`content_source NOT IN
// ('manual','claim')` — same convention experience-brreg-recheck-backfill.ts
// and the gårdssalg org_nr-backfill already apply to this SAME table) AND
// NOT catalog_hidden (a hidden/removed provider is not worth spending fetch
// budget re-checking).
//
// RATE LIMITING. Two independent, separately-motivated guards:
//   - EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS: a wall-clock budget across the
//     WHOLE batch, so one call can never again produce the RFB-side timeout
//     incident this pattern is modeled on. Checked before every network
//     fetch (both the homepage and each discovered sub-page).
//   - EXPERIENCE_ORGNR_WEBSITE_PACE_MS: a small politeness sleep BETWEEN
//     candidates, purely toward the arbitrary PRODUCER websites being
//     fetched here (NOT toward Brreg — verifyOrgNumber/
//     fetchBrregBusinessAddress are direct single-entity lookups, cheap, and
//     already have their own tiny per-process caches in brreg-client.ts).

import { getDb } from "../database/db-factory";
import { sleep as defaultSleep } from "./experience-brreg";
import { getProviderByOrgnr, setBrregVerification } from "./experience-store";
import {
  fetchPage,
  discoverContentLinks,
  visibleTextOf,
  DEFAULT_FETCH_TIMEOUT_MS,
} from "./fetch-page";
import { verifyOrgNumber, fetchBrregBusinessAddress, normaliseName } from "./brreg-client";

const VERTICAL = "experiences";

/** Order-of-magnitude match to the sibling backfill's 25/50 — a bigger cap
 * mostly means a longer HTTP call (website fetches, not Brreg calls), which
 * is exactly what EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS below exists to
 * bound regardless of `limit`. */
export const EXPERIENCE_ORGNR_WEBSITE_DEFAULT_LIMIT = 20;
export const EXPERIENCE_ORGNR_WEBSITE_MAX_LIMIT = 50;

/**
 * Wall-clock budget for one experienceOrgnrFromWebsiteTick() call, checked
 * before every network fetch (homepage AND each discovered sub-page). See
 * this file's header — modeled directly on RFB_WD_TIME_BUDGET_MS
 * (routes/admin-rfb-website-discovery.ts), the fix for a near-identical
 * unbounded per-target website-fetch loop that caused a real 60s-timeout
 * production incident. Once exceeded, no NEW candidate fetch starts; a
 * candidate already fetched is allowed to finish (this stops new attempts,
 * not one already running).
 */
export const EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS = 30_000;

/** Politeness window between candidates' website fetches — toward the
 * arbitrary PRODUCER sites being fetched, not toward Brreg. Injectable via
 * `deps.sleep`; tests pass a no-op. */
export const EXPERIENCE_ORGNR_WEBSITE_PACE_MS = 200;

/** Per-provider cap on discovered contact/about sub-pages tried when the
 * homepage itself carries no labeled org.nr — bounds per-provider cost
 * independently of the batch-level time budget above. */
const MAX_SUBPAGES_PER_CANDIDATE = 2;

const EXPERIENCE_ORGNR_WEBSITE_USER_AGENT = "Lokal-Experiences-OrgnrFromWebsite/1.0";

// Test-only injection point for the wall-clock used by the time-budget check
// above (mirrors __setRfbWdNowForTesting, admin-rfb-website-discovery.ts):
// production code always leaves this null and gets the real Date.now(); a
// test installs a deterministic override so budget-exceeded behavior can be
// exercised without actually waiting EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS
// of real wall-clock time.
let nowForTesting: (() => number) | null = null;
export function __setNowForTesting(fn: (() => number) | null): void {
  nowForTesting = fn;
}
function effectiveNowMs(depsNow?: () => number): number {
  if (depsNow) return depsNow();
  return nowForTesting ? nowForTesting() : Date.now();
}

// ─── Org-nr extraction (pure) ───────────────────────────────────────────
//
// A provider's own org.nr, when published on its site, appears as a LABELED
// number — "Org.nr: 123 456 789", "Org.nr. 123456789", "Organisasjonsnr
// 123 456 789", "Foretaksnummer 123 456 789" — or the MVA form
// ("NO 123 456 789 MVA" / "MVA-nr 123456789"). This is deliberately NEVER a
// bare unlabeled 9-digit-number regex: an arbitrary producer website is full
// of 9-digit-shaped strings that are NOT an org.nr (phone numbers, postal
// addresses, product codes, bank account fragments, …). "Org.nr er
// entydig" (Daniel's approval condition) only holds when it is actually
// labeled as one.
const ORGNR_LABELED_RE =
  /\b(?:org(?:anisasjons)?|foretaks)\.?\s*(?:nr\.?|nummer)\s*:?\s*(\d{3}\s?\d{3}\s?\d{3})\b/i;
const ORGNR_MVA_RE = /\bNO\s?(\d{3}\s?\d{3}\s?\d{3})\s?MVA\b/i;

/**
 * Extract a LABELED org.nr from free text. Tries the "Org.nr:"-family label
 * first, then the "NO … MVA" form; first match wins. Returns null when
 * neither pattern matches, or when the captured group (whitespace stripped)
 * isn't exactly 9 digits. Pure — no network/IO. Exported for unit tests.
 */
export function extractOrgNrFromText(text: string): string | null {
  if (!text) return null;

  const labeled = text.match(ORGNR_LABELED_RE);
  if (labeled) {
    const digits = labeled[1]!.replace(/\s/g, "");
    if (/^\d{9}$/.test(digits)) return digits;
  }

  const mva = text.match(ORGNR_MVA_RE);
  if (mva) {
    const digits = mva[1]!.replace(/\s/g, "");
    if (/^\d{9}$/.test(digits)) return digits;
  }

  return null;
}

// ─── Corroboration gate (pure) ──────────────────────────────────────────
//
// Daniel's explicit condition, must pass before any write: accept the Brreg
// hit only if EITHER (a) the Brreg entity's registered name shares at least
// one meaningful word (length >= 3 after normaliseName(), tokenized on
// whitespace) with the provider's own `navn`, OR (b) the Brreg entity's
// registered poststed (fetchBrregBusinessAddress()), normalised, exactly
// equals the provider row's own `poststed` OR `kommune` field, normalised.
// Own, local function — NOT a call into gardssalgOrgnrPostalCorroborated
// (experience-store.ts), which is a different vertical's org_nr-backfill
// concept (postnummer-first, with a same-region conflict veto) — same
// underlying idea (poststed as the generic-vertical proxy for "kommune",
// since Brreg's address API exposes poststed, not a separate kommune-name
// field), different, smaller, purpose-built gate for this file.
function nameTokensOf(s: string | null | undefined): Set<string> {
  return new Set(
    normaliseName(s || "")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
}

export type OrgnrWebsiteCorroborationResult = { ok: boolean; reason: string };

/** Exported for unit tests. Pure — no network/IO. */
export function experienceOrgnrWebsiteCorroborated(
  target: { navn: string; poststed: string | null; kommune: string | null },
  brreg: { name: string | null; poststed: string | null }
): OrgnrWebsiteCorroborationResult {
  const targetTokens = nameTokensOf(target.navn);
  const brregTokens = nameTokensOf(brreg.name);
  for (const t of targetTokens) {
    if (brregTokens.has(t)) return { ok: true, reason: `name_overlap:${t}` };
  }

  const brregPoststed = normaliseName(brreg.poststed || "");
  if (brregPoststed) {
    const targetPoststed = normaliseName(target.poststed || "");
    if (targetPoststed && targetPoststed === brregPoststed) {
      return { ok: true, reason: "poststed_match" };
    }
    const targetKommune = normaliseName(target.kommune || "");
    if (targetKommune && targetKommune === brregPoststed) {
      return { ok: true, reason: "kommune_match" };
    }
  }

  return { ok: false, reason: "name_and_place_mismatch" };
}

// ─── Candidate selection ─────────────────────────────────────────────────

/** Rows never given a confident brreg_active verdict AND carrying a website
 * to try (see file header for the full rationale of each clause). */
const CANDIDATE_WHERE = `
  brreg_active IS NULL
  AND hjemmeside IS NOT NULL AND hjemmeside != ''
  AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))
  AND (catalog_hidden IS NULL OR catalog_hidden != 1)
`;

/** Denominator for the admin endpoint — how many providers this batch could
 * still re-check. */
export function experienceOrgnrFromWebsiteQueueStatus(): { eligible: number } {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE ${CANDIDATE_WHERE}`)
    .get() as { n: number } | undefined;
  return { eligible: row?.n ?? 0 };
}

type CandidateRow = {
  id: string;
  navn: string;
  kommune: string | null;
  postnummer: string | null;
  poststed: string | null;
  hjemmeside: string;
};

// ─── Result shape ────────────────────────────────────────────────────────

export type ExperienceOrgnrFromWebsiteOutcome =
  | "resolved_active"
  | "resolved_inactive"
  | "no_orgnr_found"
  | "orgnr_not_found_in_brreg"
  | "corroboration_failed"
  | "orgnr_collision"
  | "fetch_failed"
  | "error";

export type ExperienceOrgnrFromWebsitePlannedRow = {
  provider_id: string;
  navn: string;
  outcome: ExperienceOrgnrFromWebsiteOutcome;
  org_nr: string | null;
  detail: string;
};

export type ExperienceOrgnrFromWebsiteResult = {
  dry_run: boolean;
  processed: number;
  /** Extracted org.nr from the provider's own site, Brreg confirms active,
   * corroborated — brreg_active written as 1. */
  resolved_active: number;
  /** Same, but Brreg confirms konkurs/avvikling/slettet — brreg_active
   * written as 0. A CONFIRMED answer, not a guess — still counts as
   * "resolved". */
  resolved_inactive: number;
  /** Homepage (and, if tried, its discovered contact/about sub-pages) fetched
   * fine, but no LABELED org.nr found anywhere. Trinn-A's expected leftover
   * bucket — NOT a bug; Trinn B (name+kommune search) is a separate, later
   * slice. */
  no_orgnr_found: number;
  /** An org.nr WAS extracted from the site, but Brreg has no such entity
   * (typo'd digit, an accountant's/franchise's org-nr, …) — never guessed. */
  orgnr_not_found_in_brreg: number;
  /** An org.nr was extracted and exists in Brreg, but neither the name nor
   * the poststed/kommune corroborates it against this provider's own row —
   * Daniel's precision condition failed; never written. */
  corroboration_failed: number;
  /** The extracted (and corroborated) org.nr is already held by a DIFFERENT
   * existing provider row (org_nr is UNIQUE) — never written, never a thrown
   * DB error. */
  orgnr_collision: number;
  /** The homepage fetch itself failed (dns/timeout/4xx/5xx/…) — distinct
   * from "fetched fine, found nothing". */
  fetch_failed: number;
  /** An unexpected throw somewhere in this candidate's processing (DB error,
   * bug, …) — fail-closed identically to every other still-unresolved
   * outcome; isolated so one candidate's failure never aborts the batch. */
  errors: number;
  /** provider ids whose processing never even started this call because the
   * batch's wall-clock time budget was already exhausted — NOT counted in
   * `processed` (they were never attempted). */
  skipped_due_to_time_budget: string[];
  duration_ms: number;
  planned: ExperienceOrgnrFromWebsitePlannedRow[];
  /** Keyset pagination cursor — id of the last row SCANNED (selected from the
   * DB) this call, or null once the page came back shorter than `limit`
   * (nothing left eligible). Pass back as `deps.after` on the next call. */
  next_after: string | null;
};

export type ExperienceOrgnrFromWebsiteDeps = {
  /** Report what would change; write nothing. */
  dryRun?: boolean;
  /** Keyset pagination cursor — see next_after's own comment above. */
  after?: string;
  /** Injectable pacing sleep — tests pass a no-op. Defaults to the real
   * setTimeout-based sleep(). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable wall-clock read for this call only — takes priority over
   * __setNowForTesting()'s module-level override when both are set. Defaults
   * to the real clock. */
  now?: () => number;
};

function emptyResult(dryRun: boolean): ExperienceOrgnrFromWebsiteResult {
  return {
    dry_run: dryRun,
    processed: 0,
    resolved_active: 0,
    resolved_inactive: 0,
    no_orgnr_found: 0,
    orgnr_not_found_in_brreg: 0,
    corroboration_failed: 0,
    orgnr_collision: 0,
    fetch_failed: 0,
    errors: 0,
    skipped_due_to_time_budget: [],
    duration_ms: 0,
    planned: [],
    next_after: null,
  };
}

/**
 * One pass over up to `limit` eligible providers. See this file's header for
 * the full decision rule. NEVER writes brreg_active (or org_nr/
 * brreg_verified) without THIS call's own fresh corroborated Brreg org.nr
 * lookup — an unresolved row is left byte-identical.
 */
export async function experienceOrgnrFromWebsiteTick(
  limit: number = EXPERIENCE_ORGNR_WEBSITE_DEFAULT_LIMIT,
  deps: ExperienceOrgnrFromWebsiteDeps = {}
): Promise<ExperienceOrgnrFromWebsiteResult> {
  const wallStart = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb(VERTICAL);
  const sleepFn = deps.sleep ?? defaultSleep;
  const after = typeof deps.after === "string" ? deps.after : "";
  const cappedLimit = Math.max(1, Math.min(EXPERIENCE_ORGNR_WEBSITE_MAX_LIMIT, limit));
  const result = emptyResult(dryRun);

  const budgetStartMs = effectiveNowMs(deps.now);

  const candidates = db
    .prepare(
      `SELECT id, navn, kommune, postnummer, poststed, hjemmeside FROM experience_providers
        WHERE ${CANDIDATE_WHERE}
          AND id > ?
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(after, cappedLimit) as CandidateRow[];

  // Keyset cursor for the NEXT call — "last id SCANNED" means the last row
  // this call's own SELECT returned, regardless of whether time-budget
  // exhaustion later stopped this call from actually attempting all of them
  // (same convention as experience-brreg-recheck-backfill.ts's next_after:
  // without it, a bare `ORDER BY id LIMIT ?` would re-select the same
  // unchanged rows forever).
  result.next_after =
    candidates.length === cappedLimit && candidates.length > 0
      ? candidates[candidates.length - 1].id
      : null;

  for (let i = 0; i < candidates.length; i++) {
    if (effectiveNowMs(deps.now) - budgetStartMs >= EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS) {
      for (let j = i; j < candidates.length; j++) {
        result.skipped_due_to_time_budget.push(candidates[j].id);
      }
      break;
    }

    const row = candidates[i];
    if (i > 0) await sleepFn(EXPERIENCE_ORGNR_WEBSITE_PACE_MS);

    result.processed++;

    let outcome: ExperienceOrgnrFromWebsiteOutcome = "error";
    let orgNr: string | null = null;
    let detail = "";

    try {
      const homepage = await fetchPage(row.hjemmeside, {
        userAgent: EXPERIENCE_ORGNR_WEBSITE_USER_AGENT,
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      });

      let found: string | null = null;
      if (!homepage.ok) {
        outcome = "fetch_failed";
        detail = `homepage fetch failed (${homepage.reason}): ${homepage.detail}`;
      } else {
        found = extractOrgNrFromText(visibleTextOf(homepage.html));

        if (!found) {
          const subpages = discoverContentLinks(homepage.html, row.hjemmeside, MAX_SUBPAGES_PER_CANDIDATE);
          for (const subUrl of subpages) {
            if (effectiveNowMs(deps.now) - budgetStartMs >= EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS) {
              // Budget exhausted mid-candidate: this candidate was already
              // attempted (processed++ above; the homepage fetch already
              // happened), so it is NOT retroactively moved to
              // skipped_due_to_time_budget — it simply stops trying further
              // sub-pages and falls through to whatever was found so far.
              break;
            }
            const sub = await fetchPage(subUrl, {
              userAgent: EXPERIENCE_ORGNR_WEBSITE_USER_AGENT,
              timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
            });
            if (!sub.ok) continue;
            const subFound = extractOrgNrFromText(visibleTextOf(sub.html));
            if (subFound) {
              found = subFound;
              break;
            }
          }
        }

        if (!found) {
          outcome = "no_orgnr_found";
          detail =
            "no labeled org.nr found on the homepage or its discovered contact/about sub-pages — left unresolved (Trinn B name+kommune search is a separate, later slice)";
        } else {
          orgNr = found;
          const verify = await verifyOrgNumber(orgNr);
          if (!verify.exists) {
            outcome = "orgnr_not_found_in_brreg";
            detail = `extracted org.nr ${orgNr} from the provider's own website, but Brreg has no such entity`;
          } else {
            const address = await fetchBrregBusinessAddress(orgNr);
            const corrob = experienceOrgnrWebsiteCorroborated(
              { navn: row.navn, poststed: row.poststed, kommune: row.kommune },
              { name: verify.name, poststed: address?.poststed ?? null }
            );
            if (!corrob.ok) {
              outcome = "corroboration_failed";
              detail =
                `org.nr ${orgNr} exists in Brreg (navn="${verify.name}") but neither name nor poststed/kommune ` +
                `corroborates against this provider's own row (navn="${row.navn}", poststed="${row.poststed}", ` +
                `kommune="${row.kommune}", brreg poststed="${address?.poststed ?? null}") — left unresolved, never guessed`;
            } else {
              const holder = getProviderByOrgnr(orgNr);
              if (holder && (holder.id as string) !== row.id) {
                outcome = "orgnr_collision";
                detail = `extracted org.nr ${orgNr} is already held by a different provider row (${holder.id as string}) — left unresolved, org_nr collision, not a guess`;
              } else {
                const active = verify.active ? 1 : 0;
                if (!dryRun) {
                  setBrregVerification(row.id, active as 0 | 1, orgNr);
                }
                if (active === 1) {
                  outcome = "resolved_active";
                  detail = `org.nr ${orgNr} extracted from the provider's own website, corroborated (${corrob.reason}), Brreg confirms active — brreg_active -> 1`;
                } else {
                  outcome = "resolved_inactive";
                  detail = `org.nr ${orgNr} extracted from the provider's own website, corroborated (${corrob.reason}), Brreg confirms konkurs/under avvikling/slettet — brreg_active -> 0 (a confirmed answer, not a guess)`;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      outcome = "error";
      detail = `unexpected error (${err instanceof Error ? err.message : String(err)}) — left unresolved, never guessed`;
      console.error(`[experience-orgnr-from-website] failed for ${row.id}:`, err);
    }

    switch (outcome) {
      case "resolved_active":
        result.resolved_active++;
        break;
      case "resolved_inactive":
        result.resolved_inactive++;
        break;
      case "no_orgnr_found":
        result.no_orgnr_found++;
        break;
      case "orgnr_not_found_in_brreg":
        result.orgnr_not_found_in_brreg++;
        break;
      case "corroboration_failed":
        result.corroboration_failed++;
        break;
      case "orgnr_collision":
        result.orgnr_collision++;
        break;
      case "fetch_failed":
        result.fetch_failed++;
        break;
      case "error":
        result.errors++;
        break;
    }

    result.planned.push({
      provider_id: row.id,
      navn: row.navn,
      outcome,
      org_nr: orgNr,
      detail,
    });
  }

  result.duration_ms = Date.now() - wallStart;
  return result;
}

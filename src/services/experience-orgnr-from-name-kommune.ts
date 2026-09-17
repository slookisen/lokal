// ─── Experiences provider org.nr-from-name+kommune backfill (Trinn B) ──────
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
// approval of TWO independent remediation paths.
//
// "Trinn A" (services/experience-orgnr-from-website.ts, merged as lokal PR
// #871) extracts a LABELED org.nr from the provider's own website and looks
// it up directly in Brreg. It is EXPLICITLY OUT OF SCOPE here — a provider
// whose website carries no labeled org.nr (or has no website at all) is
// simply left unresolved by Trinn A.
//
// THIS FILE is "Trinn B" — Daniel's own words (2026-09-14): "søk Brreg på
// navn avgrenset til sted, men foretaket må bekreftes når det finnes like
// navn" (search Brreg by name restricted to place, but the company must be
// confirmed when there are several matching names). It searches Brreg's
// `GET /enheter?navn=<navn>&kommunenummer=<knr>` endpoint (empirically
// verified to honour `kommunenummer` as a real server-side filter, not a
// no-op) using the provider's OWN name and its OWN kommune (resolved to a
// kommunenummer — see services/fylke-2024-migration.ts's
// resolveKommunenummerForName()). Daniel's exact confirmation rule, which
// this file applies before EVER writing:
//
//   Godta bare ved bekreftelse: nøyaktig ett treff, ELLER ett av treffene
//   har forretningsadresse som matcher lagret adresse (gate + husnummer),
//   ELLER treffets registrerte hjemmeside matcher leverandørens domene.
//   Flere like navn uten bekreftelse -> still_unresolved med grunn
//   ambiguous_name, aldri gjett.
//
// i.e. accept a hit only when EITHER (a) there is exactly ONE hit, OR (b)
// one of several hits has a forretningsadresse matching the provider's own
// stored address (street+house-number), OR (c) one of several hits'
// Brreg-registered website matches the provider's own website domain.
// Multiple hits with no such confirmation (or, just as importantly,
// MULTIPLE hits each independently confirmable — never pick one among
// several arbitrarily) -> left unresolved, reason `ambiguous_name`, NEVER
// GUESSED — see dev-request 2026-09-14-opplevagent-karantene-utgang-brreg-
// krav.md's own "aldri gjett" condition, the same discipline Trinn A applies
// to its own corroboration gate.
//
// SCOPE — TRINN B ONLY, fully independent of Trinn A: candidate selection
// below is deliberately WIDER than Trinn A's (no `hjemmeside` requirement —
// Trinn B does not need a website; domain corroboration is simply
// unavailable when a row has none, the other two confirmation paths may
// still apply). Trinn A's own file/route/tests are untouched.
//
// NON-GOALS (unchanged by this file): the content-judge-sweep promotion
// gate's brreg_active===1 requirement itself; the content-judge; the
// bulk-load admission gate; experience-brreg-recheck-backfill.ts's own
// name-search path; experience-orgnr-from-website.ts (Trinn A) — zero
// changes to any of these. This file only ever feeds brreg_active a fresh,
// confirmed answer for providers whose name+kommune search resolves to
// exactly one confirmed Brreg entity — it never relaxes what reads that
// column.
//
// PATTERN: mirrors services/experience-orgnr-from-website.ts's (Trinn A)
// overall shape closely — dry-run-default, admin-key-gated route, keyset
// `after` pagination, wall-clock time-budget checked before every network
// call, per-row try/catch isolation, org_nr-collision guard before any
// write, setBrregVerification() write, test-injectable clock, result-shape
// conventions (a `planned` array of per-row outcomes, an outcome enum, a
// `next_after` cursor) — but with its OWN, separate module-local clock
// override (not shared with Trinn A's).

import { getDb } from "../database/db-factory";
import { getProviderByOrgnr, setBrregVerification, homepageRegistrableDomain } from "./experience-store";
import { addressesMatch } from "./contact-normalizer";
import { domainsEquivalent } from "./cross-source-validator";
import { isKnownKommunenummer, resolveKommunenummerForName } from "./fylke-2024-migration";
import { searchBrregByNameAndKommune, verifyOrgNumber, fetchBrregWebsite, type BrregNameKommuneHit } from "./brreg-client";

const VERTICAL = "experiences";

/** Same order-of-magnitude batch discipline as Trinn A
 * (EXPERIENCE_ORGNR_WEBSITE_DEFAULT_LIMIT/MAX_LIMIT) — a bigger cap mostly
 * means more Brreg calls (cheap, direct, already cached per-process), which
 * is exactly what EXPERIENCE_ORGNR_NAME_KOMMUNE_TIME_BUDGET_MS below exists
 * to bound regardless of `limit`. */
export const EXPERIENCE_ORGNR_NAME_KOMMUNE_DEFAULT_LIMIT = 20;
export const EXPERIENCE_ORGNR_NAME_KOMMUNE_MAX_LIMIT = 50;

/**
 * Wall-clock budget for one experienceOrgnrFromNameKommuneTick() call,
 * checked before every network call. Trinn B's per-candidate cost is much
 * cheaper than Trinn A's (one Brreg name+kommune search, plus at most one
 * extra fetchBrregWebsite() call per ambiguous-hit candidate — never an
 * arbitrary PRODUCER website fetch), but this file keeps the SAME budget
 * discipline anyway: fetchBrregWebsite() still does real network I/O, and a
 * batch of up to EXPERIENCE_ORGNR_NAME_KOMMUNE_MAX_LIMIT candidates each
 * making 1-2 real HTTP calls is exactly the shape of unbounded-batch-loop
 * that previously caused a real production 60s-timeout incident elsewhere
 * in this codebase (see experience-orgnr-from-website.ts's own header for
 * the incident this pattern is modeled on).
 */
export const EXPERIENCE_ORGNR_NAME_KOMMUNE_TIME_BUDGET_MS = 30_000;

// Test-only injection point for the wall-clock used by the time-budget check
// above — this file's OWN module-local state, deliberately NOT shared with
// experience-orgnr-from-website.ts's __setNowForTesting (same pattern name/
// shape, separate module).
let nowForTesting: (() => number) | null = null;
export function __setNowForTesting(fn: (() => number) | null): void {
  nowForTesting = fn;
}
function effectiveNowMs(depsNow?: () => number): number {
  if (depsNow) return depsNow();
  return nowForTesting ? nowForTesting() : Date.now();
}

// ─── Candidate selection ─────────────────────────────────────────────────
//
// Deliberately WIDER than Trinn A (experience-orgnr-from-website.ts): NO
// `hjemmeside` requirement — Trinn B's confirmation rule can succeed on
// exactly-one-hit or address-match alone, with no website at all. See file
// header for the full rationale of the other clauses (owner-locked rows,
// catalog_hidden rows — same conventions Trinn A and
// experience-brreg-recheck-backfill.ts already apply to this SAME table).
const CANDIDATE_WHERE = `
  brreg_active IS NULL
  AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))
  AND (catalog_hidden IS NULL OR catalog_hidden != 1)
`;

/** Denominator for the admin endpoint — how many providers this batch could
 * still re-check. */
export function experienceOrgnrFromNameKommuneQueueStatus(): { eligible: number } {
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
  kommunenummer: string | null;
  postnummer: string | null;
  poststed: string | null;
  adresse: string | null;
  hjemmeside: string | null;
};

// ─── Result shape ────────────────────────────────────────────────────────

export type ExperienceOrgnrFromNameKommuneOutcome =
  | "resolved_active"
  | "resolved_inactive"
  | "no_kommune_match"
  | "no_brreg_hits"
  | "ambiguous_name"
  | "orgnr_collision"
  | "error";

export type ExperienceOrgnrFromNameKommunePlannedRow = {
  provider_id: string;
  navn: string;
  outcome: ExperienceOrgnrFromNameKommuneOutcome;
  org_nr: string | null;
  detail: string;
};

export type ExperienceOrgnrFromNameKommuneResult = {
  dry_run: boolean;
  processed: number;
  /** Confirmed Brreg hit (exact-one, address-match, or domain-match),
   * Brreg confirms active — brreg_active written as 1. */
  resolved_active: number;
  /** Same, but Brreg confirms konkurs/avvikling/slettet — brreg_active
   * written as 0. A CONFIRMED answer, not a guess — still counts as
   * "resolved". */
  resolved_inactive: number;
  /** The row's `kommune` (or its own `kommunenummer`) could not be resolved
   * to exactly one valid kommunenummer — blank kommune, or
   * resolveKommunenummerForName() returned needs_review. Corresponds to the
   * spec's "rader der kommune ikke er en kommune hoppes over og telles". */
  no_kommune_match: number;
  /** The name+kommunenummer search returned zero hits. */
  no_brreg_hits: number;
  /** 2+ hits, none confirmable by address or domain match — OR confirmable
   * by MULTIPLE conflicting hits. Daniel's "aldri gjett" condition — never
   * picks a "best" hit among ties. */
  ambiguous_name: number;
  /** The confirmed org.nr is already held by a DIFFERENT existing provider
   * row (org_nr is UNIQUE) — never written, never a thrown DB error. */
  orgnr_collision: number;
  /** An unexpected throw somewhere in this candidate's processing (DB
   * error, bug, an unconfirmed Brreg direct-verify lookup for an org.nr the
   * search itself just returned, …) — fail-closed identically to every
   * other still-unresolved outcome; isolated so one candidate's failure
   * never aborts the batch. */
  errors: number;
  /** provider ids whose processing never even started this call because the
   * batch's wall-clock time budget was already exhausted — NOT counted in
   * `processed` (they were never attempted). */
  skipped_due_to_time_budget: string[];
  duration_ms: number;
  planned: ExperienceOrgnrFromNameKommunePlannedRow[];
  /** Keyset pagination cursor — id of the last row SCANNED (selected from the
   * DB) this call, or null once the page came back shorter than `limit`
   * (nothing left eligible). Pass back as `deps.after` on the next call. */
  next_after: string | null;
};

export type ExperienceOrgnrFromNameKommuneDeps = {
  /** Report what would change; write nothing. */
  dryRun?: boolean;
  /** Keyset pagination cursor — see next_after's own comment above. */
  after?: string;
  /** Injectable wall-clock read for this call only — takes priority over
   * __setNowForTesting()'s module-level override when both are set. Defaults
   * to the real clock. */
  now?: () => number;
};

function emptyResult(dryRun: boolean): ExperienceOrgnrFromNameKommuneResult {
  return {
    dry_run: dryRun,
    processed: 0,
    resolved_active: 0,
    resolved_inactive: 0,
    no_kommune_match: 0,
    no_brreg_hits: 0,
    ambiguous_name: 0,
    orgnr_collision: 0,
    errors: 0,
    skipped_due_to_time_budget: [],
    duration_ms: 0,
    planned: [],
    next_after: null,
  };
}

/**
 * Resolve one candidate row's kommunenummer — the row's OWN column when
 * non-blank AND known (validated against the vendored kommune-fylke-2024
 * table via isKnownKommunenummer(), the same table resolveFylke2024()
 * validates its own kommunenummer branch against), else
 * resolveKommunenummerForName(row.kommune). Never guesses: returns
 * `{detail}` (caller reports no_kommune_match) when neither source yields
 * exactly one valid kommunenummer.
 *
 * A non-blank but UNKNOWN own-column value (typo'd digit, stale pre-2024
 * code, upstream geocode error) does NOT fall through to name-resolution —
 * that would just substitute one unvalidated guess (a wrong name-resolved
 * kommune) for another (a wrong own-column kommune), equally capable of
 * silently restricting the Brreg search to the wrong place. Reported as
 * `kommunenummer_not_found:<value>` instead, consistent with "never guess".
 */
function resolveCandidateKommunenummer(row: CandidateRow): { kommunenummer: string } | { detail: string } {
  const ownKommunenummer = typeof row.kommunenummer === "string" ? row.kommunenummer.trim() : "";
  if (ownKommunenummer) {
    if (isKnownKommunenummer(ownKommunenummer)) return { kommunenummer: ownKommunenummer };
    return { detail: `kommunenummer_not_found:${ownKommunenummer}` };
  }

  const resolved = resolveKommunenummerForName(row.kommune ?? "");
  if ("kommunenummer" in resolved) return { kommunenummer: resolved.kommunenummer };
  return { detail: resolved.needs_review };
}

/**
 * Among 2+ raw Brreg hits, find hits CONFIRMED against the provider's own
 * row via address match (street+house-number) or domain match (Brreg's
 * registered website vs the provider's own hjemmeside). Pure address check;
 * domain check does real network I/O (fetchBrregWebsite) and is only
 * attempted when address didn't already confirm the SAME hit AND the
 * provider has a hjemmeside to compare against. Exported for unit tests.
 */
async function confirmedHitsAmong(
  hits: BrregNameKommuneHit[],
  row: CandidateRow,
): Promise<BrregNameKommuneHit[]> {
  const providerDomain = homepageRegistrableDomain(row.hjemmeside);
  const confirmed: BrregNameKommuneHit[] = [];

  for (const hit of hits) {
    let ok = false;
    if (row.adresse && row.adresse.trim() && hit.address && hit.address.trim()) {
      ok = addressesMatch(row.adresse, hit.address);
    }
    if (!ok && providerDomain) {
      const hitWebsite = await fetchBrregWebsite(hit.orgnumber);
      const hitDomain = homepageRegistrableDomain(hitWebsite);
      if (hitDomain && domainsEquivalent(providerDomain, hitDomain)) ok = true;
    }
    if (ok) confirmed.push(hit);
  }

  return confirmed;
}

/**
 * One pass over up to `limit` eligible providers. See this file's header for
 * the full decision rule. NEVER writes brreg_active (or org_nr/
 * brreg_verified) without THIS call's own fresh confirmed Brreg hit — an
 * unresolved row is left byte-identical.
 */
export async function experienceOrgnrFromNameKommuneTick(
  limit: number = EXPERIENCE_ORGNR_NAME_KOMMUNE_DEFAULT_LIMIT,
  deps: ExperienceOrgnrFromNameKommuneDeps = {},
): Promise<ExperienceOrgnrFromNameKommuneResult> {
  const wallStart = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb(VERTICAL);
  const after = typeof deps.after === "string" ? deps.after : "";
  const cappedLimit = Math.max(1, Math.min(EXPERIENCE_ORGNR_NAME_KOMMUNE_MAX_LIMIT, limit));
  const result = emptyResult(dryRun);

  const budgetStartMs = effectiveNowMs(deps.now);

  const candidates = db
    .prepare(
      `SELECT id, navn, kommune, kommunenummer, postnummer, poststed, adresse, hjemmeside
         FROM experience_providers
        WHERE ${CANDIDATE_WHERE}
          AND id > ?
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(after, cappedLimit) as CandidateRow[];

  // Keyset cursor for the NEXT call — "last id SCANNED" means the last row
  // this call's own SELECT returned, regardless of whether time-budget
  // exhaustion later stopped this call from actually attempting all of them
  // (same convention as experience-orgnr-from-website.ts's next_after).
  result.next_after =
    candidates.length === cappedLimit && candidates.length > 0
      ? candidates[candidates.length - 1].id
      : null;

  for (let i = 0; i < candidates.length; i++) {
    if (effectiveNowMs(deps.now) - budgetStartMs >= EXPERIENCE_ORGNR_NAME_KOMMUNE_TIME_BUDGET_MS) {
      for (let j = i; j < candidates.length; j++) {
        result.skipped_due_to_time_budget.push(candidates[j].id);
      }
      break;
    }

    const row = candidates[i];
    result.processed++;

    let outcome: ExperienceOrgnrFromNameKommuneOutcome = "error";
    let orgNr: string | null = null;
    let detail = "";

    try {
      const kommuneResolution = resolveCandidateKommunenummer(row);
      if (!("kommunenummer" in kommuneResolution)) {
        outcome = "no_kommune_match";
        detail = `kommune could not be resolved to exactly one kommunenummer (${kommuneResolution.detail}) — left unresolved, never guessed`;
      } else {
        const kommunenummer = kommuneResolution.kommunenummer;
        const hits = await searchBrregByNameAndKommune(row.navn, kommunenummer);

        if (hits.length === 0) {
          outcome = "no_brreg_hits";
          detail = `Brreg name+kommune search (navn="${row.navn}", kommunenummer=${kommunenummer}) returned zero hits`;
        } else if (hits.length === 1) {
          orgNr = hits[0].orgnumber;
          detail = `exactly one Brreg hit for navn="${row.navn}" in kommunenummer=${kommunenummer} — accepted per Daniel's rule, no further corroboration needed`;
        } else {
          // 2+ hits — check budget before the (possibly network-calling)
          // per-hit corroboration pass, mirroring Trinn A's own sub-page
          // discovery loop: budget exhaustion mid-candidate stops trying
          // further leads, it does not retroactively move this candidate to
          // skipped_due_to_time_budget (it was already attempted — the
          // search above already happened).
          if (effectiveNowMs(deps.now) - budgetStartMs >= EXPERIENCE_ORGNR_NAME_KOMMUNE_TIME_BUDGET_MS) {
            outcome = "ambiguous_name";
            detail = `${hits.length} Brreg hits for navn="${row.navn}" in kommunenummer=${kommunenummer}, time budget exhausted before corroboration could be attempted — left unresolved, never guessed`;
          } else {
            const confirmed = await confirmedHitsAmong(hits, row);
            if (confirmed.length === 1) {
              orgNr = confirmed[0].orgnumber;
              detail = `${hits.length} Brreg hits for navn="${row.navn}" in kommunenummer=${kommunenummer}, exactly one confirmed by address/domain match — accepted`;
            } else {
              outcome = "ambiguous_name";
              detail =
                confirmed.length === 0
                  ? `${hits.length} Brreg hits for navn="${row.navn}" in kommunenummer=${kommunenummer}, none confirmed by address or domain match — left unresolved, never guessed`
                  : `${hits.length} Brreg hits for navn="${row.navn}" in kommunenummer=${kommunenummer}, ${confirmed.length} hits INDEPENDENTLY confirmed (conflicting) — never picks one arbitrarily, left unresolved`;
            }
          }
        }

        if (orgNr) {
          const holder = getProviderByOrgnr(orgNr);
          if (holder && (holder.id as string) !== row.id) {
            outcome = "orgnr_collision";
            detail = `confirmed org.nr ${orgNr} is already held by a different provider row (${holder.id as string}) — left unresolved, org_nr collision, not a guess`;
          } else {
            const verify = await verifyOrgNumber(orgNr);
            if (!verify.exists) {
              // The org.nr came directly from Brreg's own search response
              // moments ago — a failed direct-verify lookup here means a
              // transient error, not "doesn't exist". Fail-closed: never
              // guess active/inactive from an unconfirmed verify.
              outcome = "error";
              detail = `org.nr ${orgNr} was returned by Brreg's own name+kommune search, but the direct GET /enheter/{orgNr} verify lookup did not confirm it exists — treated as a transient error, left unresolved, never guessed`;
            } else {
              const active = verify.active ? 1 : 0;
              if (!dryRun) {
                setBrregVerification(row.id, active as 0 | 1, orgNr);
              }
              if (active === 1) {
                outcome = "resolved_active";
                detail = `${detail}; Brreg confirms active — brreg_active -> 1`;
              } else {
                outcome = "resolved_inactive";
                detail = `${detail}; Brreg confirms konkurs/under avvikling/slettet — brreg_active -> 0 (a confirmed answer, not a guess)`;
              }
            }
          }
        }
      }
    } catch (err) {
      outcome = "error";
      orgNr = null;
      detail = `unexpected error (${err instanceof Error ? err.message : String(err)}) — left unresolved, never guessed`;
      console.error(`[experience-orgnr-from-name-kommune] failed for ${row.id}:`, err);
    }

    switch (outcome) {
      case "resolved_active":
        result.resolved_active++;
        break;
      case "resolved_inactive":
        result.resolved_inactive++;
        break;
      case "no_kommune_match":
        result.no_kommune_match++;
        break;
      case "no_brreg_hits":
        result.no_brreg_hits++;
        break;
      case "ambiguous_name":
        result.ambiguous_name++;
        break;
      case "orgnr_collision":
        result.orgnr_collision++;
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

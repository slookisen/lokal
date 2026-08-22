// ─── Local (vendored) org_nr candidate lookup ───────────────────────────────
//
// dev-request 2026-07-26-rfb-outreach-tilsig-blokkerdiagnose-og-orgnr, Steg 2
// ("Billigere kilde først"): before crawling Brreg's name-search over the
// network for an RFB agent's org_nr, check two already-scraped local
// discovery files first — Lokalmat.no (api.lokalmat.no/producers, ~1520 of
// 1522 producers carry an orgnr) and Debio's certification registry
// (portal.debio.no ACM certsearch, 2902 certified businesses, all with
// orgnr). ~20% estimated overlap with the RFB producer cohort per the
// dev-request's own measurement.
//
// These two source files (discovery-candidates/2026-05-14-lokalmat.json,
// discovery-candidates/2026-05-14-debio.json) live in the slookisen/A2A repo
// (the control-plane workspace), NOT in this `lokal` app repo — and per the
// dev-request's own explicit instruction, this file does NOT do a runtime
// cross-repo read (fragile: a relative/absolute path into a sibling
// checkout would break the moment either repo's on-disk layout changes, or
// simply doesn't exist on whatever host actually runs this service).
//
// Instead: src/data/local-orgnr-candidates.json is a ONE-TIME, checked-in,
// MINIMAL vendored extract of both files — only the five fields this
// matcher actually needs (orgnr, name, postal_code, city, source). Email/
// phone/address/product-group data from the originals is deliberately NOT
// vendored (out of scope for this slice, which only ever writes org_nr —
// see applyAgentOrgNr in routes/admin-agents.ts). Re-vendor by re-running
// the extraction against a fresher A2A discovery-candidates pull if the
// source lists are ever refreshed; there is no automatic sync.
//
// Confidence rubric is UNCHANGED from brreg-client.ts's scoreNameMatch —
// this is a candidate GENERATOR, not a separate trust tier. A local-JSON
// hit still goes through the exact same write-bar veto chain as a live
// Brreg name-search hit (ambiguous ties / stripped-name-postal-corroboration
// / previously-rolled-back / live verifyOrgNumber liveness check) before
// anything is ever written — see POST /admin/agents/org-nr-backfill.

import * as fs from "fs";
import * as path from "path";
import { normaliseName, scoreNameMatch, type BrregHit } from "./brreg-client";

export type LocalOrgnrSource = "lokalmat" | "debio";

export type LocalOrgnrCandidateRecord = {
  orgnr: string;
  name: string;
  postal_code: string | null;
  city: string | null;
  source: LocalOrgnrSource;
};

// A hit from the local vendored data, shaped identically to BrregHit (so it
// can flow through the exact same postal-corroboration / auto-write-
// eligibility / veto-chain functions Brreg hits use) plus a `local_source`
// tag the caller needs to build an honest evidence_url / provenance
// source_type (distinct from a real Brreg-search hit).
export type LocalOrgnrHit = BrregHit & { local_source: LocalOrgnrSource };

const DATA_FILE = path.join(__dirname, "..", "data", "local-orgnr-candidates.json");

let cache: LocalOrgnrCandidateRecord[] | null = null;

// Defence-in-depth against a future re-vendor reintroducing the same class
// of bug this file's org_nr normalization once fixed: 699/4408 rows in the
// 2026-07-27 vendored extract carried a spaced org_nr (e.g. "920 846 432"
// instead of "920846432") straight from the Lokalmat/Debio source data.
// Left unnormalized, such a record could pass name+postal corroboration but
// fail the live Brreg liveness check (Brreg 404s on a space-containing URL),
// landing a permanently-stuck review-queue entry: the review-approve route
// strips whitespace from a human's SUBMITTED org_nr before comparing it, but
// would be comparing against an unstripped candidate_orgnr, so no input a
// human types could ever match. Stripping every non-digit character here
// (not just whitespace) means the vendored file's own orgnr values never
// need to be perfectly clean for correct behavior — this is the load-time
// backstop, in addition to the vendored file itself being normalized.
function normalizeOrgnr(raw: string): string {
  return raw.replace(/\D/g, "");
}

function loadRecords(): LocalOrgnrCandidateRecord[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const rawRecords = Array.isArray(parsed?.candidates) ? (parsed.candidates as LocalOrgnrCandidateRecord[]) : [];
    cache = rawRecords.map((r) =>
      r && typeof r.orgnr === "string" ? { ...r, orgnr: normalizeOrgnr(r.orgnr) } : r,
    );
  } catch (err) {
    // Fail-safe, mirrors every brreg-client.ts fetch function's convention:
    // a missing/corrupt vendored file must never crash the backfill route —
    // it just means the local-JSON-first optimization silently degrades to
    // "always fall through to the Brreg network search".
    console.warn(
      "[local-orgnr-candidates] failed to load vendored data file, local-JSON-first optimization disabled for this process:",
      err instanceof Error ? err.message : err,
    );
    cache = [];
  }
  return cache;
}

/** Test-only: inject a small fixture set instead of the real ~4.4k-row file, or reset to force a fresh disk read. */
export function __setLocalOrgnrCandidatesForTesting(records: LocalOrgnrCandidateRecord[] | null): void {
  cache = records;
}

export function localOrgnrCandidateCount(): number {
  return loadRecords().length;
}

/**
 * findLocalOrgnrCandidate(name, postalCode) — the local-JSON analogue of
 * brreg-client.ts's findOrgnumberByName, over the vendored Lokalmat+Debio
 * extract instead of a live Brreg network call. Same confidence rubric
 * (scoreNameMatch, threshold >= 0.9), same "best hit wins" reduction.
 *
 * exact_ties is counted over DISTINCT org numbers, not raw matching records
 * — Lokalmat and Debio are known to share ~125 producers (2026-05-14-
 * summary.md), so the same real business can legitimately appear twice in
 * the merged candidate list. Two records that are actually the SAME orgnr
 * are corroboration, not an ambiguous identity collision; only two records
 * scoring 1.0 with DIFFERENT org numbers for the same query name are a
 * genuine tie that the caller's write-bar must refuse to auto-resolve.
 *
 * Returns null when nothing scores >= 0.9, or when the vendored file failed
 * to load (see loadRecords' fail-safe above) — callers should always treat
 * a null return as "fall through to the Brreg network search", never as an
 * error.
 */
// `opts.kommuneFilter: true` (additive, default off — byte-identical
// behaviour when omitted) — dev-request 2026-08-22-rfb-website-email-
// selvforsyning, heuristic (3): narrows the CANDIDATE SET to records whose
// postal_code shares the caller's postalCode's first 2 digits (a rough
// kommune/region proxy — this vendored file carries no real kommunenummer
// column) BEFORE scoring, rather than only using postal_code to bump the
// confidence tier after the fact. Cuts false ties among common surnames/
// words scattered nationally (e.g. "Haugen") down to the caller's own
// region. Silently inert (no filtering) when the caller passes no
// postalCode — there is nothing to narrow by. Never used by the existing
// org-nr-backfill route (admin-agents.ts) — only by the new selvforsyning
// route's riskier, broader-net heuristics (domain-token, personal-name-ENK).
export function findLocalOrgnrCandidate(
  name: string,
  postalCode?: string | null,
  opts?: { kommuneFilter?: boolean },
): LocalOrgnrHit | null {
  const cleanName = (name || "").trim();
  if (!cleanName) return null;

  const records = loadRecords();
  if (records.length === 0) return null;

  const cleanPostal = (postalCode || "").trim();
  const kommunePrefix =
    opts?.kommuneFilter && cleanPostal.length >= 2 ? cleanPostal.slice(0, 2) : null;

  let best: LocalOrgnrHit | null = null;
  const exactOrgnrs = new Set<string>();

  for (const r of records) {
    if (!r || typeof r.orgnr !== "string" || typeof r.name !== "string") continue;
    if (kommunePrefix) {
      const rPostal = (r.postal_code || "").trim();
      if (rPostal.slice(0, 2) !== kommunePrefix) continue;
    }
    // Normalize again here (in addition to loadRecords' own normalization)
    // so a record injected straight into the cache via
    // __setLocalOrgnrCandidatesForTesting (bypassing loadRecords entirely)
    // can never carry an un-normalized orgnr into a hit either — same
    // digits-only rule, applied at every point this file reads r.orgnr.
    const orgnr = normalizeOrgnr(r.orgnr);
    if (!orgnr) continue;
    const score = scoreNameMatch(cleanName, r.name, postalCode ?? null, r.postal_code ?? null);
    if (score <= 0) continue;
    if (score === 1.0) exactOrgnrs.add(orgnr);
    if (!best || score > best.confidence) {
      best = {
        orgnumber: orgnr,
        name: r.name,
        confidence: score,
        brreg_postal: r.postal_code,
        brreg_poststed: r.city,
        address: null, // this slice writes org_nr only — no address data is vendored or used
        local_source: r.source,
      };
    }
  }
  if (!best) return null;
  best.exact_ties = exactOrgnrs.size;

  return best.confidence >= 0.9 ? best : null;
}

// Re-exported so callers that only need name-normalisation (e.g. building a
// diagnostic report) don't have to import brreg-client.ts just for this.
export { normaliseName };

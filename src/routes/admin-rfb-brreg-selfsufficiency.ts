// ─── POST /admin/rfb-brreg-selfsufficiency ──────────────────────────────────
//
// dev-request 2026-08-22-rfb-website-email-selvforsyning. Daniel found by
// hand, in seconds, that many RFB producer profiles the pipeline reports as
// "no website / no email" actually have a findable website + contact info
// via a Brreg (Enhetsregisteret) lookup — see the pilot that measured this,
// verification-pilot/2026-08-22-rfb-source-breadth-pilot-50.md (slookisen/A2A):
// Brreg's OWN registered contact block decided/strengthened 15 of 29 pilot
// verdicts, and was not part of ANY existing candidate source in this repo.
//
// This route is a self-contained BATCH job over three parts, none of which
// invent a new write path — every part feeds the EXACT existing veto-chain/
// write-path machinery this codebase already ships and has already reviewed:
//
//   (a) org_nr resolution — for RFB producer rows missing org_nr. Runs the
//       SAME base candidate chain admin-agents.ts's own
//       POST /admin/agents/org-nr-backfill route already runs (core-name
//       strip via parseNameLocationSuffix -> findLocalOrgnrCandidate ->
//       findOrgnumberByName, cheaper-source-first, confidence-compared), and
//       — ONLY when that base chain finds nothing — tries two ADDITIONAL
//       candidate-generation strategies before giving up:
//         1. domain-token-as-company-name (agents.url / agent_knowledge.website
//            -> a domain's meaningful token, e.g. torgersenmat.no -> "Torgersen")
//         2. personal-name-ENK pattern (a short, personal-name-shaped profile
//            name tried as "<name> ENK" — normaliseNamePruned, brreg-client.ts,
//            already strips "ENK" as an org-form suffix on both sides of every
//            comparison this rubric makes)
//       EVERY hit from EVERY strategy — base or new — goes through the exact
//       same write-bar this file imports from admin-agents.ts:
//       agentOrgNrAutoWriteEligible (confidence===1.0 AND
//       agentOrgNrPostalCorroborated) -> applyAgentOrgNr on eligible, else
//       upsertAgentOrgNrReviewQueue. This route NEVER writes agents.org_nr
//       itself — applyAgentOrgNr (admin-agents.ts) is the only writer, same
//       as its own sibling route.
//
//   (b) Brreg hjemmeside -> agents_website_review_queue — for rows that HAVE
//       (already, or freshly resolved by (a) in this same call, apply-mode
//       only — see the effectiveOrgNr note below) an org_nr but are missing
//       agent_knowledge.website. ONE fetchBrregContact(orgNr) call
//       (services/brreg-client.ts) serves both this leg and (c). A returned
//       `hjemmeside` is fed into the EXISTING external-candidates-intake
//       function evaluateRfbWebsiteCandidate (admin-rfb-website-discovery.ts)
//       — never a second write path, never a direct write to
//       agent_knowledge.website (that function only ever queues).
//
//   (c) Brreg telefon/mobil as anchor-field evidence — threaded into the SAME
//       evaluateRfbWebsiteCandidate call via its new (additive) 8th param,
//       `contactOverride`, so a candidate page carrying the producer's own
//       Brreg-registered phone number can verify even when
//       agent_knowledge.phone is blank/stale (today's hardcoded
//       `telefon: t.phone, mobil: null` never had Brreg's OWN registered
//       numbers wired in for RFB agents at all).
//
//   (d) Brreg epostadresse -> agents.contact_email — dev-request
//       2026-08-22-rfb-website-email-selvforsyning, Grep 1d. Daniel gave
//       explicit GO (daniel-responses/): "ja, godkjenn Brreg som e-postkilde
//       — egen side vinner ved avvik" (approve Brreg as an email source, own
//       site wins on conflict). Reuses the SAME `contact` object already
//       fetched for parts (b)/(c) — no second fetchBrregContact call. The
//       candidate always passes through the shared LLM-judge +
//       deterministic-backstop gate (gateContactCandidates,
//       services/contact-candidate-judge.ts — same shared gate
//       admin-rfb-contact-extraction.ts's email leg uses) AND the
//       isPlatformOwnedEmailDomain check BEFORE it is ever compared against
//       an existing contact_email. A non-blank existing contact_email that
//       DIFFERS from the gate-approved Brreg candidate is NEVER overwritten
//       — "egen side vinner ved avvik": the discrepancy is still always
//       routed through the judge (so the verdict is visible in the
//       response), but automated conflict resolution never wins over the
//       producer's own site. Only ever writes `agents.contact_email` when it
//       was blank to begin with. Never a second write path — this route's
//       own applyRfbBssEmailWrite is the sole writer for this column from
//       this slice, mirroring applyRfbCxWrite's write discipline (fresh
//       claimed_at/curated_fields re-read immediately before write, one
//       agent_knowledge_audit row per write).
//
// Dry-run-by-default, matching BOTH sibling batch routes this one calls into
// (`apply` truthy check, identical spelling/precedence to
// POST /admin/agents/org-nr-backfill and POST /admin/rfb-website-discovery):
// only the FINAL org_nr write (applyAgentOrgNr) is gated by `apply` — the
// review-queue upserts this route triggers (both org_nr's and website's) fire
// unconditionally on every call, exactly mirroring both sibling routes' own
// "queueing a reversible proposal is not a 'write' in the dry-run sense"
// convention (see admin-rfb-website-discovery.ts's own file-header comment).
//
// Auth: X-Admin-Key header (requireAdmin) — deliberately re-defined locally,
// same as every other admin route file in this codebase.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import {
  findLocalOrgnrCandidate,
  type LocalOrgnrHit,
} from "../services/local-orgnr-candidates";
import {
  findOrgnumberByName,
  verifyOrgNumber,
  fetchBrregContact,
  BRREG_BASE_URL,
  BRREG_SEARCH_PATH,
  type BrregHit,
  type BrregContact,
} from "../services/brreg-client";
import { parseNameLocationSuffix, normaliseDomain } from "../services/location-suffix-parser";
import {
  agentsOrgNrBackfillCandidateWhereSql,
  agentOrgNrPostalCorroborated,
  agentOrgNrAutoWriteEligible,
  agentOrgNrWasRolledBack,
  applyAgentOrgNr,
  upsertAgentOrgNrReviewQueue,
  clearAgentOrgNrReviewQueueEntry,
} from "./admin-agents";
import {
  evaluateRfbWebsiteCandidate,
  rfbWdExistingWebsiteHosts,
  rfbWebsiteHostExclusionReason,
  ensureRfbWebsiteReviewQueueTable,
  type RfbWdFallbackCounters,
} from "./admin-rfb-website-discovery";
import {
  enrichmentWritePauseBlockForAgents,
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
} from "../services/enrichment-write-pause";
import {
  isPlatformOwnedEmailDomain,
  isContactEmailCurated,
} from "./admin-agents-contact-email-write";
// dev-request 2026-08-22-rfb-website-email-selvforsyning, Grep 1d: Daniel's
// explicit GO (daniel-responses/) approved Brreg's own registered `epost` as
// a contact-email source, own-site-wins-on-conflict. Same shared LLM-judge +
// deterministic-backstop gate as admin-rfb-contact-extraction.ts's email leg
// (Grep 5b) — see contact-candidate-judge.ts's own doc comment.
import { gateContactCandidates } from "../services/contact-candidate-judge";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// Batch/limit convention: this route's per-row cost is the UNION of both
// siblings' — up to 3 org_nr candidate searches (part a) PLUS one
// fetchBrregContact call PLUS (part b) a live page fetch through
// evaluateRfbWebsiteCandidate. Rather than invent a new number, this takes
// the SMALLER of the two named sibling caps (RFB_WD_HARD_CAP=48, the one
// covering the more expensive network-fetch leg this route also performs)
// — same "keep the per-call cap smaller bounds wall-clock cost" reasoning
// admin-rfb-website-discovery.ts's own header comment already gives for
// choosing 48 over admin-agents.ts's 100. Default 25 matches BOTH siblings'
// own default verbatim (AGENTS_ORGNR_BACKFILL_DEFAULT_LIMIT ===
// RFB_WD_DEFAULT_LIMIT === 25).
export const RFB_BSS_DEFAULT_LIMIT = 25;
export const RFB_BSS_HARD_CAP = 48;

// ─── injectable fetch seam ──────────────────────────────────────────────────
// Covers every Brreg call this route makes directly (findOrgnumberByName,
// verifyOrgNumber, fetchBrregContact — all three already accept an explicit
// fetchImpl param in brreg-client.ts). Mirrors
// __setAgentsOrgNrBackfillFetchForTesting (admin-agents.ts) exactly — NOT a
// globalThis.fetch monkeypatch, for the same concurrency-safety reason that
// file's own header comment documents. (The website-candidate leg's own
// page-fetch, inherited via evaluateRfbWebsiteCandidate -> fetch-page.ts,
// is NOT covered by this seam — that module reads globalThis.fetch directly
// and has no injectable param of its own; see this route's own test file
// header for how that specific, unavoidable gap is handled.)
let rfbBssFetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

export function __setRfbBrregSelfSufficiencyFetchForTesting(impl?: typeof fetch): void {
  rfbBssFetchImpl = impl || ((...args: Parameters<typeof fetch>) => fetch(...args));
}

interface RfbBssTargetRow {
  id: string;
  name: string;
  org_nr: string | null;
  claimed_at: string | null;
  city: string | null;
  url: string | null;
  postal_code: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  contact_email: string | null;
  curated_fields: string | null;
}

// Combined cohort: a row qualifies if it is missing org_nr OR missing
// website (or both) — the scope filters (role/active/umbrella/vertical/
// claimed_at) are an EXACT mirror of agentsOrgNrBackfillCandidateWhereSql's
// own predicate (admin-agents.ts, imported above and also used directly
// below for the org_nr-only diagnostic count), extended with the website-OR
// branch this route's own combined batch needs. Never diverges from that
// predicate's scope filters by hand-editing them separately.
function rfbBssCandidateWhereSql(): string {
  return `
    a.role = 'producer'
    AND a.is_active = 1
    AND a.umbrella_type IS NULL
    AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
    AND a.claimed_at IS NULL
    AND (
      (a.org_nr IS NULL OR TRIM(a.org_nr) = '')
      OR (k.website IS NULL OR TRIM(k.website) = '')
    )
  `;
}

function rfbBssSelectSql(extraWhere: string): string {
  return `
    SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.claimed_at AS claimed_at,
           a.city AS city, a.url AS url, a.contact_email AS contact_email,
           k.postal_code AS postal_code, k.website AS website, k.phone AS phone, k.address AS address,
           k.curated_fields AS curated_fields
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE ${rfbBssCandidateWhereSql()} ${extraWhere}
  `;
}

function countRfbBssCandidates(db: ReturnType<typeof getDb>): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${rfbBssSelectSql("")})`).get() as { n: number };
  return row?.n ?? 0;
}

// Diagnostic-only reuse of admin-agents.ts's own org_nr-missing pool size —
// demonstrates this route actually calls the imported selector rather than
// merely mirroring its shape by hand. Not used for row selection (this
// route's own combined predicate above is), purely a response-shape
// cross-check a human can compare against
// GET /admin/agents/org-nr-review-queue's own cohort.
function countOrgNrOnlyPool(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE ${agentsOrgNrBackfillCandidateWhereSql()}`,
    )
    .get() as { n: number };
  return row?.n ?? 0;
}

function fetchRfbBssBatch(db: ReturnType<typeof getDb>, cap: number): RfbBssTargetRow[] {
  return db
    .prepare(`${rfbBssSelectSql("")} ORDER BY a.created_at ASC, a.id ASC LIMIT ?`)
    .all(cap) as RfbBssTargetRow[];
}

// agentIds override — scoped to role/vertical only (NOT the blank-org_nr/
// blank-website/claimed/active/umbrella filters), mirroring
// getAgentOrgNrBackfillTarget's / getRfbWebsiteDiscoveryTarget's own override
// semantics exactly: an admin can force an attempt on any RFB producer row;
// already-resolved/locked state is still enforced, just reported as a
// specific outcome rather than silently omitted.
function getRfbBssTarget(db: ReturnType<typeof getDb>, agentId: string): RfbBssTargetRow | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.claimed_at AS claimed_at,
              a.city AS city, a.url AS url, a.contact_email AS contact_email,
              k.postal_code AS postal_code, k.website AS website, k.phone AS phone, k.address AS address,
              k.curated_fields AS curated_fields
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ? AND a.role = 'producer' AND COALESCE(a.vertical_id, 'rfb') = 'rfb'`,
    )
    .get(agentId) as RfbBssTargetRow | undefined;
  return row ?? null;
}

// ─── Heuristic 1: domain-token-as-company-name ──────────────────────────────
//
// A curated, small set of generic Norwegian farm/shop words that commonly
// get appended to a company's own name to form its domain — stripped
// (repeatedly, longest-first-match not required since the list is short and
// disjoint enough) from the domain's leading label so "torgersenmat.no"
// yields "torgersen" rather than being searched verbatim (which would almost
// never exact-match a Brreg-registered company name). Deliberately NOT
// exhaustive — a miss here just means this heuristic finds nothing for that
// row, falling through to no_candidate like any other unresolved row; it can
// never cause a WRONG write, since every hit still passes through the exact
// same confidence/corroboration/liveness write-bar as every other candidate
// source in this file.
const RFB_BSS_DOMAIN_GENERIC_SUFFIXES = [
  "gardsbutikk", "gaardsbutikk", "gardsutsalg", "gardsmat", "gaardsmat",
  "produkter", "produksjon", "bryggeri", "bakeri", "meieri", "slakteri",
  "fiskeri", "kaffebrenneri", "gard", "gaard", "butikk", "mat", "fisk", "honning",
];

/**
 * domainTokenCandidateName(hostOrUrl) — derives a company-name CANDIDATE
 * from a domain's leading label by stripping a trailing generic word (see
 * RFB_BSS_DOMAIN_GENERIC_SUFFIXES above), e.g. "torgersenmat.no" -> "Torgersen".
 * Returns null when the input has no usable host, the resulting token is
 * shorter than 3 characters, or the token IS itself one of the generic words
 * (nothing left to search). Pure — exported for tests.
 */
export function domainTokenCandidateName(hostOrUrl: string | null | undefined): string | null {
  const host = normaliseDomain(hostOrUrl || "");
  if (!host) return null;
  const label = host.split(".")[0] || "";
  let token = label.toLowerCase();
  if (!token) return null;

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of RFB_BSS_DOMAIN_GENERIC_SUFFIXES) {
      if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
        token = token.slice(0, token.length - suffix.length);
        stripped = true;
        break;
      }
    }
  }
  if (token.length < 3) return null;
  if (RFB_BSS_DOMAIN_GENERIC_SUFFIXES.includes(token)) return null;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

// Platform's own domain — never a usable "producer's own site" signal (same
// defect class admin-agents-url-write.ts's own header measured: 4/1623 rows
// showed rettfrabonden.com as the producer's homepage).
const RFB_BSS_PLATFORM_HOSTS: ReadonlySet<string> = new Set(["rettfrabonden.com"]);

/**
 * Picks the best available domain source for a target row — prefers
 * agent_knowledge.website over agents.url (a confirmed-adopted website is a
 * stronger signal than the catalog's own homepage field, per
 * admin-agents-url-write.ts's own measured caveats about agents.url quality),
 * skipping directory/social/known-bad hosts (rfbWebsiteHostExclusionReason,
 * admin-rfb-website-discovery.ts — reused, not re-curated) and the platform's
 * own host. Returns null when neither field offers a usable host. Pure —
 * exported for tests.
 */
export function pickDomainSourceForTarget(t: {
  website: string | null;
  url: string | null;
}): string | null {
  for (const raw of [t.website, t.url]) {
    if (!raw || !raw.trim()) continue;
    const host = normaliseDomain(raw);
    if (!host || !host.includes(".")) continue;
    if (RFB_BSS_PLATFORM_HOSTS.has(host)) continue;
    if (rfbWebsiteHostExclusionReason(host)) continue;
    return host;
  }
  return null;
}

// ─── Heuristic 2: personal-name-ENK pattern ─────────────────────────────────
//
// A curated block-list of common Norwegian farm/product/channel words — a
// token matching one of these is a business-shaped name, not a personal one,
// so the heuristic must not fire on it (avoids searching "Gården ENK" or
// similar nonsense). Deliberately small; a miss here (a genuinely personal
// name this list fails to recognise) just means the heuristic doesn't fire —
// same "can only under-trigger, never mis-write" safety property as the
// domain-token heuristic above.
const RFB_BSS_PERSONAL_NAME_BLOCK_WORDS: ReadonlySet<string> = new Set([
  "gard", "gård", "gaard", "mat", "fisk", "fiske", "bakeri", "meieri",
  "bryggeri", "slakteri", "honning", "butikk", "produkter", "produksjon",
  "gardsutsalg", "gardsbutikk", "kaffebrenneri", "fiskeri", "landbruk",
  "andelslandbruk", "reko", "marked", "vilt", "bigård", "bigard",
]);

/**
 * looksLikePersonalName(name) — a small, deliberately conservative heuristic:
 * true only when `name` is one or two Title-Case tokens (Norwegian letters
 * only, no digits/punctuation beyond an internal hyphen/apostrophe), and
 * neither token is a known business/farm word. This is a SHAPE check, not a
 * real-name-registry lookup — it will both miss real personal names (a
 * three-word one) and occasionally fire on a genuine two-word farm name that
 * happens to look person-shaped. Neither failure mode is unsafe: this only
 * decides whether the personal-name-ENK CANDIDATE SEARCH is attempted at
 * all, never whether a candidate is trusted — every hit it produces still
 * passes through the exact same write-bar as every other source in this
 * file. Pure — exported for tests.
 */
export function looksLikePersonalName(name: string): boolean {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return false;
  const personalTokenRe = /^[A-ZÆØÅ][a-zæøåA-ZÆØÅ'-]{1,}$/;
  for (const t of tokens) {
    if (!personalTokenRe.test(t)) return false;
    if (RFB_BSS_PERSONAL_NAME_BLOCK_WORDS.has(t.toLowerCase())) return false;
  }
  return true;
}

// ─── Part (a): org_nr resolution ────────────────────────────────────────────

export type RfbBssOrgNrOutcome =
  | "already_had"
  | "written"
  | "would_write"
  | "queued"
  | "no_candidate";

export interface RfbBssOrgNrResolution {
  outcome: RfbBssOrgNrOutcome;
  sourceType: string | null;
  orgNr: string | null;
  reason: string | null;
}

interface RfbBssOrgNrAttempt {
  searchName: string;
  requiresCorroboration: boolean;
  // Constant heuristic tag for the two NEW strategies (per spec: distinct
  // sourceType regardless of whether the underlying hit came from the local
  // vendored file or a live Brreg search); the base chain instead keeps its
  // ORIGINAL local_json_<source>/brreg_name_search distinction (byte-parity
  // with admin-agents.ts's own route) — null here signals "use the base
  // chain's own local/live distinction".
  fixedSourceType: string | null;
  // Only the base chain's own local-JSON lookup keeps IDENTICAL call
  // behaviour to admin-agents.ts's route (no kommune pre-filter) — the two
  // new, broader-net heuristics opt into the pre-filter to cut false ties
  // among common surnames/words (heuristic 3).
  kommuneFilter: boolean;
}

/**
 * Resolves (or queues, or gives up on) an org_nr for ONE target row. Tries,
 * in order, the base candidate chain (mirrors admin-agents.ts's own
 * POST /admin/agents/org-nr-backfill route: core-name-stripped
 * findLocalOrgnrCandidate -> findOrgnumberByName, cheaper-source-first,
 * confidence-compared) and then — ONLY if that produces no hit at all — the
 * domain-token and personal-name-ENK heuristics, in that order, stopping at
 * the first strategy that produces ANY hit. Every hit found by ANY strategy
 * goes through the identical write-bar veto chain
 * (agentOrgNrPostalCorroborated / agentOrgNrAutoWriteEligible /
 * agentOrgNrWasRolledBack / verifyOrgNumber liveness), then either
 * applyAgentOrgNr (apply mode) or upsertAgentOrgNrReviewQueue — never a
 * direct write. Already-has-org_nr rows short-circuit immediately (no
 * network call at all). Never throws — a genuine Brreg failure surfaces as
 * `queued`/`brreg_verify_failed` like any other veto, matching the base
 * route's own no-throw discipline.
 */
export async function resolveOrgNrForTarget(
  db: ReturnType<typeof getDb>,
  target: RfbBssTargetRow,
  batchId: string,
  apply: boolean,
  fetchImpl: typeof fetch,
): Promise<RfbBssOrgNrResolution> {
  if (target.org_nr && target.org_nr.trim() !== "") {
    return { outcome: "already_had", sourceType: null, orgNr: target.org_nr, reason: null };
  }

  const { core_name } = parseNameLocationSuffix(target.name);
  const baseSearchName = core_name || target.name;
  const baseNameWasStripped = baseSearchName !== (target.name || "").replace(/\s+/g, " ").trim();

  const attempts: RfbBssOrgNrAttempt[] = [
    { searchName: baseSearchName, requiresCorroboration: baseNameWasStripped, fixedSourceType: null, kommuneFilter: false },
  ];

  const domainSource = pickDomainSourceForTarget(target);
  const domainToken = domainSource ? domainTokenCandidateName(domainSource) : null;
  if (domainToken) {
    attempts.push({
      searchName: domainToken,
      requiresCorroboration: true,
      fixedSourceType: "domain_token_name_match",
      kommuneFilter: true,
    });
  }

  if (looksLikePersonalName(baseSearchName)) {
    attempts.push({
      searchName: `${baseSearchName} ENK`,
      requiresCorroboration: true,
      fixedSourceType: "personal_name_enk_match",
      kommuneFilter: true,
    });
  }

  // Two-phase pick: a hit that scores an AMBIGUOUS exact-tie (>1 distinct
  // org numbers tied at confidence 1.0 within its own attempt) is never
  // immediately committed to — it is remembered as a fallback, and the
  // waterfall keeps trying LATER, more specific attempts (which is exactly
  // when the kommune pre-filter / domain-token / personal-name-ENK
  // heuristics earn their keep: a common name that ties nationally via the
  // base chain's unfiltered search can still resolve cleanly once a later
  // attempt narrows the candidate set). Only when EVERY attempt has been
  // tried do we fall back to the first ambiguous hit found (still reported
  // as `ambiguous_exact_name_ties`, never silently dropped) — this can only
  // ever make a candidate MORE likely to need human review, never less, so
  // it cannot weaken the existing write-bar.
  type RfbBssOrgNrCandidatePick = {
    hit: BrregHit | LocalOrgnrHit;
    sourceType: string;
    requiresCorroboration: boolean;
    isLocalHit: boolean;
  };
  let chosen: RfbBssOrgNrCandidatePick | null = null;
  let ambiguousFallback: RfbBssOrgNrCandidatePick | null = null;

  for (const attempt of attempts) {
    const localHit = findLocalOrgnrCandidate(
      attempt.searchName,
      target.postal_code,
      attempt.kommuneFilter ? { kommuneFilter: true } : undefined,
    );

    let hit: BrregHit | LocalOrgnrHit | null = null;
    if (localHit && localHit.confidence >= 1.0) {
      hit = localHit;
    } else {
      const brregHit = await findOrgnumberByName(attempt.searchName, target.postal_code, fetchImpl);
      if (brregHit && (!localHit || brregHit.confidence > localHit.confidence)) {
        hit = brregHit;
      } else if (localHit) {
        hit = localHit;
      }
    }
    if (!hit) continue;

    const isLocalHit = Object.prototype.hasOwnProperty.call(hit, "local_source");
    const sourceType =
      attempt.fixedSourceType ?? (isLocalHit ? `local_json_${(hit as LocalOrgnrHit).local_source}` : "brreg_name_search");
    const candidate = { hit, sourceType, requiresCorroboration: attempt.requiresCorroboration, isLocalHit };

    const isAmbiguous = (hit.exact_ties ?? (hit.confidence === 1.0 ? 1 : 0)) > 1;
    if (isAmbiguous) {
      if (!ambiguousFallback) ambiguousFallback = candidate;
      continue;
    }
    chosen = candidate;
    break;
  }

  const picked = chosen ?? ambiguousFallback;
  if (picked) {
    const { hit, sourceType, requiresCorroboration, isLocalHit } = picked;

    let vetoReason: string | null = null;
    if ((hit.exact_ties ?? (hit.confidence === 1.0 ? 1 : 0)) > 1) {
      vetoReason = "ambiguous_exact_name_ties";
    } else if (requiresCorroboration && !agentOrgNrPostalCorroborated(target, hit)) {
      vetoReason = "heuristic_name_requires_postal_match";
    } else {
      let rolledBack = false;
      try {
        rolledBack = agentOrgNrWasRolledBack(db, target.id);
      } catch {
        rolledBack = false;
      }
      if (rolledBack) vetoReason = "previously_rolled_back";
    }
    if (!vetoReason && agentOrgNrAutoWriteEligible(target, hit)) {
      try {
        const ver = await verifyOrgNumber(hit.orgnumber, fetchImpl);
        if (!ver.exists || !ver.active) vetoReason = "brreg_not_active";
      } catch {
        vetoReason = "brreg_verify_failed";
      }
    }

    const evidenceUrl = isLocalHit
      ? `local-json://${(hit as LocalOrgnrHit).local_source}/${encodeURIComponent(hit.orgnumber)}`
      : `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(hit.orgnumber)}`;

    if (!vetoReason && agentOrgNrAutoWriteEligible(target, hit)) {
      if (apply) {
        const written = applyAgentOrgNr(db, target.id, hit.orgnumber, evidenceUrl, sourceType, batchId);
        if (written.length > 0) {
          clearAgentOrgNrReviewQueueEntry(db, target.id);
          return { outcome: "written", sourceType, orgNr: hit.orgnumber, reason: null };
        }
        return { outcome: "queued", sourceType, orgNr: null, reason: "already_filled_or_conflict_at_write_time" };
      }
      return { outcome: "would_write", sourceType, orgNr: hit.orgnumber, reason: null };
    }

    const reason = vetoReason ?? "needs_human_review";
    upsertAgentOrgNrReviewQueue(db, {
      agent_id: target.id,
      agent_name: target.name,
      candidate_orgnr: hit.orgnumber,
      candidate_name: hit.name,
      candidate_confidence: hit.confidence,
      candidate_address: hit.address ?? null,
      candidate_source: sourceType,
      reason,
      batch_id: batchId,
    });
    return { outcome: "queued", sourceType, orgNr: null, reason };
  }

  upsertAgentOrgNrReviewQueue(db, {
    agent_id: target.id,
    agent_name: target.name,
    candidate_orgnr: null,
    candidate_name: null,
    candidate_confidence: null,
    candidate_address: null,
    candidate_source: null,
    reason: "no_candidate_found_any_heuristic",
    batch_id: batchId,
  });
  return { outcome: "no_candidate", sourceType: null, orgNr: null, reason: "no_candidate_found_any_heuristic" };
}

// ─── Parts (b)+(c): Brreg hjemmeside + telefon/mobil evidence ───────────────

export type RfbBssWebsiteOutcome =
  | "website_already_present"
  | "brreg_contact_fetch_failed"
  | "no_brreg_hjemmeside"
  | "website_proposed"
  | "website_rejected"
  | "agent_not_found";

export interface RfbBssWebsiteResolution {
  outcome: RfbBssWebsiteOutcome;
  detail?: string;
}

// ─── Part (d): Brreg epostadresse -> agents.contact_email ──────────────────

export type RfbBssEmailOutcome =
  | "email_already_present"
  | "no_brreg_epost"
  | "email_written"
  | "email_would_write"
  | "email_conflict_kept_own"
  | "email_conflict_at_write_time"
  | "email_rejected_by_gate"
  | "email_rejected_platform_domain"
  | "email_skipped_locked"
  | "email_skipped_curated"
  | "not_attempted";

export interface RfbBssEmailResolution {
  outcome: RfbBssEmailOutcome;
  detail?: string;
}

/**
 * Writes ONE agent's contact_email from a gate-approved Brreg candidate.
 * Mirrors applyRfbCxWrite (admin-rfb-contact-extraction.ts) AS CLOSELY AS
 * POSSIBLE: same transaction shape, same fresh-read-immediately-before-write
 * discipline (re-reads claimed_at/contact_email/curated_fields from a live
 * SELECT inside the transaction, not the stale `target` snapshot passed by
 * the caller), same agent_knowledge_audit insert shape.
 */
function applyRfbBssEmailWrite(
  db: ReturnType<typeof getDb>,
  agentId: string,
  newEmail: string,
  orgNr: string,
  batchId: string,
): { outcome: "written" | "skippedLocked" | "skippedCurated" | "conflictAtWriteTime"; oldValue?: string | null } {
  const tx = db.transaction((): { outcome: "written" | "skippedLocked" | "skippedCurated" | "conflictAtWriteTime"; oldValue?: string | null } => {
    const cur = db
      .prepare(
        `SELECT a.claimed_at AS claimed_at, a.contact_email AS contact_email, k.curated_fields AS curated_fields
           FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(agentId) as { claimed_at: string | null; contact_email: string | null; curated_fields: string | null } | undefined;

    if (!cur) return { outcome: "skippedLocked" }; // vanished mid-batch — treat as untouchable, never write
    if (cur.claimed_at) return { outcome: "skippedLocked", oldValue: cur.contact_email };
    if (isContactEmailCurated(cur.curated_fields)) return { outcome: "skippedCurated", oldValue: cur.contact_email };

    // Grep 1d TOCTOU fix: contact_email itself is re-checked fresh here too,
    // symmetric with the claimed_at/curated_fields checks above — the scan-
    // time decision in resolveEmailForTarget only compared the STALE `target`
    // snapshot against the gate-approved candidate, so a concurrent writer
    // (e.g. admin-agents-contact-email-write.ts, or admin-rfb-contact-
    // extraction.ts's own write path) can land a real address on this exact
    // row in the window between that scan and this write. Folded into ONE
    // outcome ("conflictAtWriteTime") whether the freshly-read value DIFFERS
    // from newEmail (a genuine race — "egen side vinner ved avvik" applies
    // here too, so never overwrite) or already EQUALS it case-insensitively
    // (already-satisfied no-op) — both cases mean "don't write, something
    // non-blank is already there", so there is no caller-visible need to
    // split them into two separate outcomes.
    const curEmail = (cur.contact_email ?? "").trim();
    if (curEmail) {
      return { outcome: "conflictAtWriteTime", oldValue: cur.contact_email };
    }

    db.prepare(`UPDATE agents SET contact_email = ? WHERE id = ?`).run(newEmail, agentId);
    db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, 'contact_email', ?, ?, 'system', NULL, datetime('now'), ?)`,
    ).run(randomUUID(), agentId, cur.contact_email, newEmail, `rfb-brreg-selfsufficiency org_nr:${orgNr} batch:${batchId}`);

    return { outcome: "written", oldValue: cur.contact_email };
  });
  return tx();
}

/**
 * Resolves (or writes, or vetoes) a Brreg-sourced contact_email for ONE
 * target row that already has an org_nr AND a fetched Brreg `contact` object
 * (reused from the SAME fetchBrregContact call parts (b)/(c) already made —
 * this function never fetches Brreg itself). "Egen side vinner ved avvik"
 * (Daniel's GO, dev-request 2026-08-22-rfb-website-email-selvforsyning): a
 * non-blank existing contact_email that DIFFERS from the gate-approved Brreg
 * candidate is NEVER overwritten — the candidate is still always routed
 * through gateContactCandidates first (so the discrepancy is visible in the
 * response as email_conflict_kept_own), but the existing value always wins.
 * Never throws.
 */
export async function resolveEmailForTarget(
  db: ReturnType<typeof getDb>,
  target: RfbBssTargetRow,
  orgNr: string,
  brregEpost: string | null,
  batchId: string,
  apply: boolean,
): Promise<RfbBssEmailResolution> {
  if (!brregEpost || !brregEpost.trim()) {
    return { outcome: "no_brreg_epost" };
  }

  // Cheap, deterministic, checked BEFORE the LLM gate to avoid wasting a
  // judge call on an obviously-wrong candidate — mirrors
  // admin-rfb-contact-extraction.ts's own check ordering.
  if (isPlatformOwnedEmailDomain(brregEpost)) {
    return { outcome: "email_rejected_platform_domain" };
  }

  const gated = await gateContactCandidates({
    businessName: target.name,
    sourceContext: `Data fra Brønnøysundregistrene (Brreg) for org.nr ${orgNr}: epost=${JSON.stringify(brregEpost)}.`,
    candidateEmail: brregEpost,
  });
  if (!gated.email) {
    return { outcome: "email_rejected_by_gate", detail: gated.emailRejectedReason ?? "avvist av dommer" };
  }
  const gateApprovedEmail = gated.email;

  const existing = (target.contact_email ?? "").trim();
  if (existing && existing.toLowerCase() !== gateApprovedEmail.trim().toLowerCase()) {
    return {
      outcome: "email_conflict_kept_own",
      detail: `existing="${existing}" brreg_candidate="${gateApprovedEmail}"`,
    };
  }
  if (existing && existing.toLowerCase() === gateApprovedEmail.trim().toLowerCase()) {
    return { outcome: "email_already_present" };
  }

  if (!apply) {
    return { outcome: "email_would_write" };
  }

  const written = applyRfbBssEmailWrite(db, target.id, gateApprovedEmail, orgNr, batchId);
  if (written.outcome === "written") return { outcome: "email_written" };
  if (written.outcome === "skippedLocked") return { outcome: "email_skipped_locked" };
  if (written.outcome === "conflictAtWriteTime") {
    return {
      outcome: "email_conflict_at_write_time",
      detail: `existing_at_write_time="${written.oldValue ?? ""}" brreg_candidate="${gateApprovedEmail}"`,
    };
  }
  return { outcome: "email_skipped_curated" };
}

/**
 * Resolves (or queues, or gives up on) a website + contact-evidence proposal
 * for ONE target row that already has (or just got) an org_nr, AND (part d)
 * a Brreg-sourced contact_email resolution. ONE fetchBrregContact call
 * serves the `hjemmeside` need, the `telefon`/`mobil` evidence threaded into
 * evaluateRfbWebsiteCandidate's `contactOverride` param, AND (part d)
 * `epost` — no second fetchBrregContact call for the email leg. Never writes
 * agent_knowledge.website directly — that remains evaluateRfbWebsiteCandidate's
 * exclusive privilege (queue-only, never a direct column write). Never
 * throws.
 *
 * Scope boundary (explicit, load-bearing, part d): the email leg is only
 * ever computed when a Brreg `contact` fetch actually happens — and this
 * route's own cohort (rfbBssCandidateWhereSql) only requires org_nr-missing
 * OR website-missing, so a row that already has a website in this cohort
 * only qualified because org_nr was missing. This function's own early
 * return (target.website already non-blank -> no fetch at all) means such a
 * row's email outcome is `not_attempted` — Grep 1d does NOT widen the fetch
 * trigger to also cover "has website, missing email" rows in this slice; a
 * future slice can if that gap matters in practice. Likewise, when the
 * Brreg contact fetch itself throws/returns null, the email outcome is also
 * `not_attempted` (not a distinct email-specific fetch-failure outcome) —
 * same simplification as the website leg's own `brreg_contact_fetch_failed`.
 */
export async function resolveWebsiteAndContactForTarget(
  db: ReturnType<typeof getDb>,
  target: RfbBssTargetRow,
  orgNr: string,
  batchId: string,
  existingHosts: Set<string>,
  hostsProposedThisBatch: Set<string>,
  fallbackCounters: RfbWdFallbackCounters,
  fetchImpl: typeof fetch,
  apply: boolean,
): Promise<RfbBssWebsiteResolution & { email: RfbBssEmailResolution }> {
  if (target.website && target.website.trim() !== "") {
    return { outcome: "website_already_present", email: { outcome: "not_attempted" } };
  }

  let contact: BrregContact | null;
  try {
    contact = await fetchBrregContact(orgNr, fetchImpl);
  } catch {
    contact = null;
  }
  if (!contact) {
    return { outcome: "brreg_contact_fetch_failed", email: { outcome: "not_attempted" } };
  }

  // Part (d): computed BEFORE the hjemmeside check below — email resolution
  // is independent of whether a hjemmeside was found.
  const email = await resolveEmailForTarget(db, target, orgNr, contact.epost, batchId, apply);

  if (!contact.hjemmeside) {
    return { outcome: "no_brreg_hjemmeside", email };
  }

  const outcome = await evaluateRfbWebsiteCandidate(
    db,
    { agentId: target.id, url: contact.hjemmeside },
    existingHosts,
    hostsProposedThisBatch,
    fallbackCounters,
    batchId,
    "brreg_register_candidate",
    { telefon: contact.telefon, mobil: contact.mobil },
  );

  switch (outcome.outcome) {
    case "proposed":
      return { outcome: "website_proposed", email };
    case "already_has_website":
      return { outcome: "website_already_present", email };
    case "not_found":
      return { outcome: "agent_not_found", email };
    case "rejected":
      return { outcome: "website_rejected", detail: outcome.reason, email };
  }
}

// ─── Route ───────────────────────────────────────────────────────────────

const router = Router();

router.post("/rfb-brreg-selfsufficiency", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : RFB_BSS_DEFAULT_LIMIT,
    RFB_BSS_HARD_CAP,
  );

  try {
    const db = getDb();
    ensureRfbWebsiteReviewQueueTable(db);
    const batchId = `rfb-brreg-selfsufficiency-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
    const candidateCount = countRfbBssCandidates(db);
    const orgNrOnlyPoolSize = countOrgNrOnlyPool(db);

    let targets: RfbBssTargetRow[];
    const skippedLocked: string[] = [];
    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      const ids = Array.from(
        new Set(
          (body.agentIds as unknown[])
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim()),
        ),
      ).slice(0, limit);
      const raw = ids.map((id) => getRfbBssTarget(db, id)).filter((t): t is RfbBssTargetRow => t !== null);
      targets = [];
      for (const t of raw) {
        if (t.claimed_at) {
          skippedLocked.push(t.id);
        } else {
          targets.push(t);
        }
      }
    } else {
      targets = fetchRfbBssBatch(db, limit);
    }

    // Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
    // pause-mekanisk-gjerde) — APPLY path only, same placement/discipline as
    // POST /admin/agents/org-nr-backfill's own gate: after target selection
    // (so the gate judges the verticals about to be written), before any
    // Brreg call or write. A dry run stays reachable so an operator can still
    // measure. `getDb` passed as a thunk so a getDb() throw fails CLOSED.
    if (apply) {
      const pauseBlock = enrichmentWritePauseBlockForAgents(
        getDb,
        targets.map((t) => t.id),
      );
      if (pauseBlock) {
        res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
        return;
      }
    }

    const existingHosts = rfbWdExistingWebsiteHosts(db);
    const hostsProposedThisBatch = new Set<string>();
    const fallbackCounters: RfbWdFallbackCounters = { attempted: 0, verified: 0 };

    const orgNrCounts: Record<RfbBssOrgNrOutcome, number> = {
      already_had: 0,
      written: 0,
      would_write: 0,
      queued: 0,
      no_candidate: 0,
    };
    const orgNrBySource: Record<string, number> = {};
    const websiteCounts: Record<RfbBssWebsiteOutcome | "skipped_no_org_nr", number> = {
      website_already_present: 0,
      brreg_contact_fetch_failed: 0,
      no_brreg_hjemmeside: 0,
      website_proposed: 0,
      website_rejected: 0,
      agent_not_found: 0,
      skipped_no_org_nr: 0,
    };
    const websiteRejectReasons: Record<string, number> = {};

    const emailCounts: Record<RfbBssEmailOutcome, number> = {
      email_already_present: 0,
      no_brreg_epost: 0,
      email_written: 0,
      email_would_write: 0,
      email_conflict_kept_own: 0,
      email_conflict_at_write_time: 0,
      email_rejected_by_gate: 0,
      email_rejected_platform_domain: 0,
      email_skipped_locked: 0,
      email_skipped_curated: 0,
      not_attempted: 0,
    };
    const emailRejectReasons: Record<string, number> = {};

    const details: Array<{
      agent_id: string;
      agent_name: string;
      org_nr_outcome: RfbBssOrgNrOutcome;
      org_nr_source: string | null;
      org_nr: string | null;
      website_outcome: RfbBssWebsiteOutcome | "skipped_no_org_nr";
      website_reject_reason?: string;
      email_outcome: RfbBssEmailOutcome;
      email_detail?: string;
    }> = [];
    const errors: Array<{ agent_id: string; stage: "org_nr" | "website"; error: string }> = [];

    for (const t of targets) {
      let orgNrResolution: RfbBssOrgNrResolution;
      try {
        orgNrResolution = await resolveOrgNrForTarget(db, t, batchId, apply, rfbBssFetchImpl);
      } catch (e: any) {
        errors.push({ agent_id: t.id, stage: "org_nr", error: e?.message ?? String(e) });
        continue;
      }
      orgNrCounts[orgNrResolution.outcome]++;
      if (orgNrResolution.sourceType) {
        orgNrBySource[orgNrResolution.sourceType] = (orgNrBySource[orgNrResolution.sourceType] ?? 0) + 1;
      }

      const effectiveOrgNr =
        t.org_nr && t.org_nr.trim() !== ""
          ? t.org_nr
          : orgNrResolution.outcome === "written"
            ? orgNrResolution.orgNr
            : null;

      let websiteResolution: RfbBssWebsiteResolution | { outcome: "skipped_no_org_nr" };
      let emailResolution: RfbBssEmailResolution;
      if (!effectiveOrgNr) {
        websiteResolution = { outcome: "skipped_no_org_nr" };
        emailResolution = { outcome: "not_attempted" };
      } else {
        try {
          const combined = await resolveWebsiteAndContactForTarget(
            db,
            t,
            effectiveOrgNr,
            batchId,
            existingHosts,
            hostsProposedThisBatch,
            fallbackCounters,
            rfbBssFetchImpl,
            apply,
          );
          const { email, ...website } = combined;
          websiteResolution = website;
          emailResolution = email;
        } catch (e: any) {
          errors.push({ agent_id: t.id, stage: "website", error: e?.message ?? String(e) });
          websiteResolution = { outcome: "brreg_contact_fetch_failed" };
          emailResolution = { outcome: "not_attempted" };
        }
      }
      websiteCounts[websiteResolution.outcome]++;
      if ("detail" in websiteResolution && websiteResolution.detail) {
        websiteRejectReasons[websiteResolution.detail] = (websiteRejectReasons[websiteResolution.detail] ?? 0) + 1;
      }
      emailCounts[emailResolution.outcome]++;
      if (emailResolution.detail) {
        emailRejectReasons[emailResolution.detail] = (emailRejectReasons[emailResolution.detail] ?? 0) + 1;
      }

      details.push({
        agent_id: t.id,
        agent_name: t.name,
        org_nr_outcome: orgNrResolution.outcome,
        org_nr_source: orgNrResolution.sourceType,
        org_nr: orgNrResolution.orgNr ?? (t.org_nr && t.org_nr.trim() !== "" ? t.org_nr : null),
        website_outcome: websiteResolution.outcome,
        ...("detail" in websiteResolution && websiteResolution.detail ? { website_reject_reason: websiteResolution.detail } : {}),
        email_outcome: emailResolution.outcome,
        ...(emailResolution.detail ? { email_detail: emailResolution.detail } : {}),
      });
    }

    res.json({
      success: true,
      dry_run: dryRun,
      batch_id: batchId,
      candidate_count: candidateCount,
      org_nr_only_pool_size: orgNrOnlyPoolSize,
      batch_size: targets.length,
      remaining_count: Math.max(0, candidateCount - targets.length),
      limit,
      skipped_locked: skippedLocked,
      org_nr: { ...orgNrCounts, by_source: orgNrBySource },
      website: { ...websiteCounts, reject_reasons: websiteRejectReasons },
      email: { ...emailCounts, reject_reasons: emailRejectReasons },
      headless_fallback_attempted: fallbackCounters.attempted,
      headless_fallback_verified: fallbackCounters.verified,
      details,
      errors,
    });
  } catch (err: any) {
    res.status(500).json({ error: "rfb-brreg-selfsufficiency failed", detail: err.message });
  }
});

export default router;

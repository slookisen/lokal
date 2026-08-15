// ─── POST /admin/dental/hjemmeside-discovery-batch + POST /admin/dental/
//     hjemmeside-discovery-approve ────────────────────────────────────────
//
// dev-request 2026-08-15-dental-hjemmeside-brreg-navnesoek, item 3 (the
// Brreg-field leg only — no navnesøk/name-search fallback in this slice).
//
// WHY: item 1 (admin-dental-hjemmeside-cleanup.ts) moves directory/booking-
// portal URLs OUT of dental_agents.hjemmeside; item 2 (admin-dental-mark-
// inactive.ts) permanently flags closed clinics. Neither backfills a real
// clinic homepage for a row left blank by that cleanup. This route is the
// FIRST discovery leg for that backfill: for a clinic with a known org_nr
// but a blank hjemmeside, Brreg's own enhetsregister already has a
// self-registered `hjemmeside` field for that org_nr (fetchBrregWebsite,
// services/brreg-client.ts) — this route fetches that candidate, verifies
// the fetched page really is the clinic's OWN site (org_nr-on-page OR
// name+place evidence, gardssalgWebsiteEvidenceMatch), and queues verified
// candidates for a SEPARATE, explicit, dry-run-default apply step. It NEVER
// writes dental_agents.hjemmeside directly — the only write this half of
// the route performs is an upsert into the new, lazily-created
// dental_website_review_queue table.
//
// This is the dental-vertical, single-known-URL analogue of POST
// /admin/rfb-website-discovery (admin-rfb-website-discovery.ts) — read that
// file first, it is the primary template: discover → evidence-match →
// review-queue → separate approve-with-fill-only-write route, same shape,
// different table (dental_agents/dental_website_review_queue instead of
// agents/agents_website_review_queue) and a much narrower candidate set
// (ONE Brreg-registered URL per clinic, never a guessed-host list, so there
// is no shared-host guard here — a genuine clinic homepage is not something
// two different org_nrs can both legitimately register at Brreg).
//
// Aggregator/directory-host exclusion reuses item 1's classifier
// (classifyHjemmeside, services/dental-hjemmeside-classifier.ts) rather than
// re-implementing a second domain list — Brreg's own hjemmeside field is
// occasionally itself a directory/booking-portal URL (the exact same bad
// shapes item 1 sweeps out of hjemmeside), and this route must reject those
// the same way, before ever fetching them.
//
// No new audit table: dental_agents has none today (unlike agent_knowledge's
// agent_knowledge_audit) — this route follows the field_provenance-merge-
// only convention item 2 (admin-dental-mark-inactive.ts) already established
// for this exact table: parse the existing JSON blob (tolerating null/junk),
// spread it, set only the "hjemmeside" key, preserving every other field's
// provenance untouched (mergeHjemmesideDiscoveryProvenance below).
//
// Injectable fetch/render seams (dentalWdFetchImpl / __setDentalWdFetchFor-
// Testing, dentalWdRenderPageImplForTesting / __setDentalWdRenderPageImpl-
// ForTesting) rather than a monkey-patched globalThis.fetch: this route's
// own test file is wired into tests/test.ts (mirrors admin-dental-mark-
// inactive.test.ts's convention, not admin-rfb-website-discovery.test.ts's
// standalone-only one), where many test blocks run interleaved in one
// process — a global fetch reassignment here would poison a concurrently-
// running block's real fetch() calls (dev-request 2026-07-25-testsuite-
// ikke-deterministisk-delte-globaler; admin-agents.ts's own
// __setAgentsOrgNrBackfillFetchForTesting seam exists for exactly this
// reason and is the one mirrored here, not RFB's global swap).
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route file in this codebase).
//
// Non-goals (do not extend this route to cover these — separate future
// slices per the dev-request): no changes to items 1/2/4's own endpoints, no
// new audit table, no auto-apply (apply is always a separate, explicit,
// dry-run-default call).
//
// ─── Tier 2: navnesøk (name-search) fallback (dev-request
//     2026-08-15-dental-hjemmeside-brreg-navnesoek, item 3 navnesøk leg) ───
// For a row where the Brreg-field leg above did NOT queue a candidate this
// call (no_brreg_website / aggregator_host / insufficient_evidence /
// fetch_failed), try ONE braveSearch call (services/search-enrich.ts) for
// `"<navn>" <poststed>` (gardssalgWebsiteSearchQuery — dental has no kommune
// column, poststed alone), take up to DENTAL_WD_SEARCH_MAX_CANDIDATES
// candidate hosts (gardssalgWebsiteSearchCandidateHosts, both
// services/experience-store.ts), and try each host in order: the SAME
// classifyHjemmeside exclusion, the SAME fetchPage timeout/UA, the SAME
// gardssalgWebsiteEvidenceMatch queue-gate as the Brreg leg — first verified
// hit wins. Mirrors RFB's own tier-2 (routes/opplevelser.ts, dev-request
// 2026-07-21-gardssalg-soekebasert-nettsidefunn) in its NARROWEST form: no
// subpages, no embedded-layer second chance, no shared-host-in-catalog guard
// (every tier-2 candidate here already came from a live search result, not a
// guessed host list, so there is nothing to guard against). Queued via the
// SAME dental_website_review_queue table, tagged reason: 'navnesok_fallback'
// (vs the Brreg leg's 'brreg_field') so the approve route can stamp the
// correct field_provenance.hjemmeside.source_type.
//
// Cost control: at most ONE braveSearch call per row per batch call, and
// only attempted when the Brreg leg found nothing this row AND a search seam
// is wired (dentalWdSearchImpl / __setDentalWdSearchForTesting, mirroring
// the fetch/render seams above) — production wires it to the real
// braveSearch only when BRAVE_API_KEY/BRAVE_SEARCH_API_KEY is configured; no
// key configured -> tier 2 silently skipped, tier 1 still runs (mirrors
// RFB's own "free tier still works without a key" behaviour).

import { Router, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";
import { fetchBrregWebsite } from "../services/brreg-client";
import { classifyHjemmeside } from "../services/dental-hjemmeside-classifier";
import {
  gardssalgWebsiteEvidenceMatch,
  gardssalgPageText,
  gardssalgWebsiteSearchQuery,
  gardssalgWebsiteSearchCandidateHosts,
} from "../services/experience-store";
import { fetchPage, DEFAULT_FETCH_TIMEOUT_MS } from "../services/fetch-page";
import { renderPage, shouldEscalateToRender } from "../services/render-page";
import { braveSearch, type BraveResult } from "../services/search-enrich";

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

// ─── dental_website_review_queue (lazy, ensureXTable pattern) ─────────────
// Mirrors ensureRfbWebsiteReviewQueueTable (admin-rfb-website-discovery.ts)
// exactly: a CREATE TABLE IF NOT EXISTS run from inside this route file, so
// the table exists on a fresh checkout without any edit to init-dental.ts.
// agent_id is UNIQUE — "refresh, don't pile up": a repeat discovery call for
// an already-queued clinic replaces its pending proposal via
// ON CONFLICT(agent_id), never accumulates duplicates.
export function ensureDentalWebsiteReviewQueueTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dental_website_review_queue (
      id             TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL UNIQUE,
      agent_name     TEXT,
      candidate_url  TEXT NOT NULL,
      final_url      TEXT,
      evidence       TEXT,
      confidence     REAL,
      reason         TEXT,
      batch_id       TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dental_website_review_queue_status ON dental_website_review_queue(status)`);
}

// Single cap used both as the auto-select LIMIT and as the max length of an
// explicit agentIds override array — mirrors the dev-request's own "batch
// cap of 25/call" framing (a single number, unlike RFB's separate default/
// hard-cap pair).
export const DENTAL_WD_BATCH_CAP = 25;

// Approve route's own cap — mirrors RFB's rfb-website-review-approve (200
// approvals/call) and the dev-request's explicit instruction.
export const DENTAL_WD_APPROVE_MAX = 200;

// Tier-2 candidate-host cap — deliberately narrower than RFB's own current
// live value (10, raised there only after a live-measured cohort showed 5
// was too thin for gårdssalg). This is dental's first cut; raise later on
// measured dental evidence, not guessed up front.
export const DENTAL_WD_SEARCH_MAX_CANDIDATES = 5;

const DENTAL_WD_USER_AGENT = "Lokal-Dental-WebsiteDiscovery/1.0";

// Deliberately below render-page.ts's DEFAULT_RENDER_TIMEOUT_MS (20s), same
// reasoning as RFB_WD_RENDER_TIMEOUT_MS (admin-rfb-website-discovery.ts): a
// single discovery call can walk up to DENTAL_WD_BATCH_CAP (25) candidates,
// each potentially triggering one render escalation — a smaller per-render
// bound caps that worst-case wall-clock without touching render-page.ts's
// own tested default for other, non-batched callers.
export const DENTAL_WD_RENDER_TIMEOUT_MS = 12_000;

// Flag-gated, default OFF — mirrors this codebase's existing boolean-env-flag
// idiom exactly (grep `process.env.\w+ === "true"`, e.g. RFB's
// RFB_WD_HEADLESS_FALLBACK_ENABLED in admin-rfb-website-discovery.ts,
// marketplace.ts's HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED). Deliberately
// NOT added to fly.toml's [env] block — an env var absent there and not set
// as a Fly secret is `undefined`, which is exactly what this function
// requires to gate to "do not attempt render" below. This route's own
// headless-render escalation was never part of dev-request 2026-08-14-fetch-
// vegg-headless-fallback's stated scope (that dev-request names only
// admin-rfb-website-discovery.ts and marketplace.ts as consumers) — this
// flag exists so THIS route's escalation behaviour stays byte-identical to
// before that dev-request's worker-wiring change (renderPage() always
// resolved renderer_unavailable in production until now) until a separate,
// deliberately-scoped dev-request reviews and turns it on.
function dentalWdHeadlessFallbackEnabled(): boolean {
  return process.env.DENTAL_WD_HEADLESS_FALLBACK_ENABLED === "true";
}

// ─── injectable fetch seam for this route's own Brreg + page-fetch calls ──
// See file header. Threaded into BOTH fetchBrregWebsite's own fetchImpl
// parameter and fetchPage's `fetchImpl` option, so a single test stub can
// serve both the Brreg enhetsregister lookup and the candidate-page fetch.
// Production code never calls the setter, so behaviour outside tests is
// byte-identical to calling the real global fetch directly.
let dentalWdFetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);
export function __setDentalWdFetchForTesting(impl?: typeof fetch): void {
  dentalWdFetchImpl = impl || ((...args: Parameters<typeof fetch>) => fetch(...args));
}

// Test-only injection point for renderPage — mirrors
// __setRfbWdRenderPageImplForTesting (admin-rfb-website-discovery.ts): this
// codebase's esbuild/tsx toolchain compiles `import { renderPage } from ...`
// to a live binding that cannot be monkeypatched from OUTSIDE this module.
// Production code always leaves this null and gets the real renderPage
// (and therefore the real, lazily-imported playwright-core —
// `renderer_unavailable` wherever it isn't installed, exactly as documented
// in render-page.ts).
let dentalWdRenderPageImplForTesting: typeof renderPage | null = null;
export function __setDentalWdRenderPageImplForTesting(impl: typeof renderPage | null): void {
  dentalWdRenderPageImplForTesting = impl;
}

// Test-only injection point for the tier-2 search seam — mirrors
// dentalWdFetchImpl/dentalWdRenderPageImplForTesting exactly. `null` by
// default (production computes the real search function per-request from
// whichever Brave env key is configured — see dentalWdActiveSearchImpl
// below — so leaving this null in production is not itself "tier 2
// disabled", only "no test override installed"). Tests inject a stub that
// hands back BraveResult[] directly and never touches the network, same
// seam-not-global-monkeypatch convention as the fetch/render seams' own
// header note explains.
let dentalWdSearchImpl: ((query: string) => Promise<BraveResult[]>) | null = null;
export function __setDentalWdSearchForTesting(impl: ((query: string) => Promise<BraveResult[]>) | null): void {
  dentalWdSearchImpl = impl;
}

// The search function this route actually uses for one batch call: a test
// override always wins (never touches the network); otherwise the real
// braveSearch, wired with whichever Brave env key is configured; otherwise
// null (tier 2 silently skipped for the whole batch call, tier 1 still
// runs). Computed once per batch call (not per row) so every row in one
// call shares the identical resolved function — mirrors RFB's own
// gardssalg-website-discovery route (routes/opplevelser.ts).
function dentalWdActiveSearchImpl(): ((query: string) => Promise<BraveResult[]>) | null {
  if (dentalWdSearchImpl) return dentalWdSearchImpl;
  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || "";
  return braveKey ? (query: string) => braveSearch(query, braveKey, DENTAL_WD_SEARCH_MAX_CANDIDATES) : null;
}

interface DentalWdTargetRow {
  id: string;
  navn: string;
  org_nr: string;
  poststed: string | null;
  telefon: string | null;
  mobil: string | null;
  adresse: string | null;
  postnummer: string | null;
  hjemmeside: string | null;
}

interface DentalWdEvidence {
  org_nr_found: boolean;
  name_found: boolean;
  place_found: boolean;
  phone_found: boolean;
  address_found: boolean;
  postnr_found: boolean;
  title_found: boolean;
  verified: boolean;
}

// Candidate-selection WHERE clause — shared by auto-select and the
// agentIds-override id lookup so the two can never drift out of sync with
// each other. Exact predicate per the dev-request: org_nr known, hjemmeside
// blank (post item-1 cleanup), never a directory_url row (already cleaned/
// classified bad by item 1 — re-discovering a bad value for it is pointless),
// never an inactive clinic (item 2).
function dentalWdSelectSql(extraWhere: string): string {
  return `
    SELECT id, navn, org_nr, poststed, telefon, mobil, adresse, postnummer, hjemmeside
      FROM dental_agents
     WHERE org_nr IS NOT NULL
       AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')
       AND directory_url IS NULL
       AND (is_inactive IS NULL OR is_inactive = 0)
       ${extraWhere}
  `;
}

// Auto-select ordering: ORDER BY RANDOM() — mirrors RFB's own blank-mode
// auto-select (selectRfbWebsiteDiscoveryTargets, admin-rfb-website-
// discovery.ts), adopted there after oldest-first was measured to
// concentrate the queue head on a stale cohort and tank the hit rate.
function selectDentalWebsiteDiscoveryTargets(db: ReturnType<typeof getDb>, limit: number): DentalWdTargetRow[] {
  return db.prepare(`${dentalWdSelectSql("")} ORDER BY RANDOM() LIMIT ?`).all(limit) as DentalWdTargetRow[];
}

// agentIds override: id must ALSO satisfy the same eligibility predicate as
// auto-select (unlike RFB's own override, which relaxes the blank-website
// filter to report a specific already_has_website reason) — a clinic
// without an org_nr, already-hjemmeside, already-cleaned-to-directory_url,
// or inactive row is simply not a valid discovery target under any path, so
// a non-match here is reported as one generic "not_eligible" rather than
// trying to enumerate which specific predicate failed.
function getDentalWebsiteDiscoveryCandidateById(db: ReturnType<typeof getDb>, id: string): DentalWdTargetRow | null {
  const row = db.prepare(`${dentalWdSelectSql("AND id = @id")}`).get({ id }) as DentalWdTargetRow | undefined;
  return row ?? null;
}

// Confidence per the dev-request's explicit rule: full confidence when the
// page carries the clinic's own registered org_nr (a registry-sourced
// signal), a shade under full when verification rests on name+place alone.
export function dentalWdConfidence(evidence: DentalWdEvidence): number {
  return evidence.org_nr_found ? 1.0 : 0.9;
}

// The ONLY write the discovery half of this route ever performs. Upsert-in-
// place on agent_id (UNIQUE) — "refresh, don't pile up", identical idiom to
// upsertRfbWebsiteReviewQueue: a re-run of this route for an already-queued
// clinic replaces its pending proposal rather than accumulating duplicates.
// Fully reversible — `DELETE FROM dental_website_review_queue` undoes every
// effect of every discovery call.
function upsertDentalWebsiteReviewQueue(
  db: ReturnType<typeof getDb>,
  entry: {
    agent_id: string;
    agent_name: string;
    candidate_url: string;
    final_url: string;
    evidence: DentalWdEvidence;
    confidence: number;
    batch_id: string;
  },
  reason: "brreg_field" | "navnesok_fallback",
): void {
  db.prepare(
    `INSERT INTO dental_website_review_queue
       (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
     VALUES (@id, @agent_id, @agent_name, @candidate_url, @final_url, @evidence, @confidence,
             @reason, @batch_id, 'pending', datetime('now'), datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       candidate_url = excluded.candidate_url,
       final_url = excluded.final_url,
       evidence = excluded.evidence,
       confidence = excluded.confidence,
       reason = excluded.reason,
       batch_id = excluded.batch_id,
       status = 'pending',
       updated_at = datetime('now')`,
  ).run({
    id: uuid(),
    agent_id: entry.agent_id,
    agent_name: entry.agent_name,
    candidate_url: entry.candidate_url,
    final_url: entry.final_url,
    evidence: JSON.stringify(entry.evidence),
    confidence: entry.confidence,
    reason,
    batch_id: entry.batch_id,
  });
}

interface DentalWdResultEntry {
  agent_id: string;
  agent_name: string;
  status:
    | "queued"
    | "no_brreg_website"
    | "aggregator_host"
    | "fetch_failed"
    | "insufficient_evidence"
    | "not_eligible";
  candidate_url?: string;
  final_url?: string;
  evidence?: DentalWdEvidence;
  confidence?: number;
  reason?: string;
  // Informational-only (dev-request 2026-08-15-dental-hjemmeside-brreg-
  // navnesoek, item 3 navnesøk leg): true only when a search seam was wired
  // AND the tier-2 leg actually ran for this row (the Brreg leg did not
  // queue this row this call). Distinguishes "tier 2 ran and found nothing"
  // from "tier 2 never ran (no key/seam)" — NOT a new top-level `skipped`
  // bucket; the existing 4 skip reasons stay the response shape's skip
  // taxonomy. Absent (undefined) on `not_eligible` results, which never
  // reach either leg.
  search_attempted?: boolean;
}

// Tier 1 — processes ONE candidate clinic end-to-end via the Brreg-field
// leg: Brreg lookup -> aggregator/directory-host exclusion (item 1's
// classifier, no fetch if it fires) -> bounded-timeout page fetch ->
// optional headless-render escalation for a JS-shell page -> ownership-
// evidence match -> queue (or a named skip reason). Never throws on a
// network/render failure — every outcome is a named status.
async function processDentalWdBrregLeg(
  db: ReturnType<typeof getDb>,
  t: DentalWdTargetRow,
  batchId: string,
): Promise<DentalWdResultEntry> {
  const base = { agent_id: t.id, agent_name: t.navn };

  const brregWebsite = await fetchBrregWebsite(t.org_nr, dentalWdFetchImpl);
  if (!brregWebsite) {
    return { ...base, status: "no_brreg_website" };
  }

  const classification = classifyHjemmeside(brregWebsite);
  if (classification.isBad) {
    return { ...base, status: "aggregator_host", reason: classification.reason ?? undefined };
  }

  const fetchResult = await fetchPage(brregWebsite, {
    userAgent: DENTAL_WD_USER_AGENT,
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl: dentalWdFetchImpl,
  });
  if (!fetchResult.ok) {
    return { ...base, status: "fetch_failed", reason: fetchResult.reason };
  }

  let html = fetchResult.html;
  let finalUrl = fetchResult.finalUrl;

  // Headless-render escalation for a page that looks like a JS shell
  // (shouldEscalateToRender is pure — no network). Flag-gated (see
  // dentalWdHeadlessFallbackEnabled above) — unset/anything-other-than-
  // "true" = disabled = this route never attempts a render, exactly as
  // before this whole PR wired render-page.ts to a real production backend.
  // A render failure (including `renderer_unavailable`) simply falls
  // through to evidence-matching the plain-fetched html: never a throw,
  // never treated as fetch_failed.
  if (dentalWdHeadlessFallbackEnabled() && shouldEscalateToRender(html)) {
    const renderFn = dentalWdRenderPageImplForTesting ?? renderPage;
    const rendered = await renderFn(finalUrl, {
      userAgent: DENTAL_WD_USER_AGENT,
      timeoutMs: DENTAL_WD_RENDER_TIMEOUT_MS,
    });
    if (rendered.ok) {
      html = rendered.html;
      finalUrl = rendered.finalUrl;
    }
  }

  const pageText = gardssalgPageText(html);
  const evidence = gardssalgWebsiteEvidenceMatch(pageText, {
    orgNr: t.org_nr,
    navn: t.navn,
    poststed: t.poststed,
    telefon: t.telefon,
    mobil: t.mobil,
    adresse: t.adresse,
    postnummer: t.postnummer,
  });

  // Dev-request's own gate — deliberately NOT evidence.verified, which also
  // accepts phone+name or name+address+postnr without a place match. Only
  // org_nr on the page, or name AND place together, are enough for THIS
  // route to queue a candidate.
  if (!(evidence.org_nr_found || (evidence.name_found && evidence.place_found))) {
    return { ...base, status: "insufficient_evidence", evidence };
  }

  const confidence = dentalWdConfidence(evidence);
  let candidateUrl: string;
  try {
    const u = new URL(finalUrl);
    candidateUrl = `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    candidateUrl = brregWebsite;
  }

  upsertDentalWebsiteReviewQueue(
    db,
    {
      agent_id: t.id,
      agent_name: t.navn,
      candidate_url: candidateUrl,
      final_url: finalUrl,
      evidence,
      confidence,
      batch_id: batchId,
    },
    "brreg_field",
  );

  return { ...base, status: "queued", candidate_url: candidateUrl, final_url: finalUrl, evidence, confidence };
}

// Tier 2 — navnesøk (name-search) fallback, tried ONLY when tier 1 (above)
// did not queue this row this call. ONE searchFn call for the whole row
// (cost control), whose top candidate hosts (up to
// DENTAL_WD_SEARCH_MAX_CANDIDATES) are tried in order against the SAME
// exclusion/fetch/evidence pipeline tier 1 uses: classifyHjemmeside
// exclusion (no fetch if it fires) -> bounded-timeout page fetch (SAME
// timeout/UA as tier 1, no headless-render escalation — narrowest-shippable-
// leg scope) -> the SAME ownership-evidence gate as tier 1. First verified
// host wins and is queued with reason 'navnesok_fallback'. Returns null
// (never a skip-reason of its own) when the search call itself fails, when
// it returns zero usable candidates, or when every candidate host is
// excluded/unfetchable/unverified — callers fall back to the ORIGINAL tier-1
// result in every one of those cases, per the dev-request's "preserve the
// Brreg leg's original skip status when tier 2 also finds nothing" rule.
async function processDentalWdSearchLeg(
  db: ReturnType<typeof getDb>,
  t: DentalWdTargetRow,
  batchId: string,
  searchFn: (query: string) => Promise<BraveResult[]>,
): Promise<DentalWdResultEntry | null> {
  const base = { agent_id: t.id, agent_name: t.navn };

  let results: BraveResult[];
  try {
    const query = gardssalgWebsiteSearchQuery({ navn: t.navn, poststed: t.poststed });
    results = await searchFn(query);
  } catch {
    // A search failure (network/HTTP error) must not abort the row — it
    // simply falls through to the original tier-1 result, exactly like a
    // search that returned zero hits would.
    return null;
  }

  const hosts = gardssalgWebsiteSearchCandidateHosts(results, DENTAL_WD_SEARCH_MAX_CANDIDATES);

  for (const host of hosts) {
    const candidateUrlGuess = `https://${host}`;

    const classification = classifyHjemmeside(candidateUrlGuess);
    if (classification.isBad) continue;

    const fetchResult = await fetchPage(candidateUrlGuess, {
      userAgent: DENTAL_WD_USER_AGENT,
      timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      fetchImpl: dentalWdFetchImpl,
    });
    if (!fetchResult.ok) continue;

    const pageText = gardssalgPageText(fetchResult.html);
    const evidence = gardssalgWebsiteEvidenceMatch(pageText, {
      orgNr: t.org_nr,
      navn: t.navn,
      poststed: t.poststed,
      telefon: t.telefon,
      mobil: t.mobil,
      adresse: t.adresse,
      postnummer: t.postnummer,
    });

    // SAME gate as tier 1 — see processDentalWdBrregLeg's own comment.
    if (!(evidence.org_nr_found || (evidence.name_found && evidence.place_found))) continue;

    const finalUrl = fetchResult.finalUrl;
    const confidence = dentalWdConfidence(evidence);
    let candidateUrl: string;
    try {
      const u = new URL(finalUrl);
      candidateUrl = `${u.protocol}//${u.host.toLowerCase()}`;
    } catch {
      candidateUrl = candidateUrlGuess;
    }

    upsertDentalWebsiteReviewQueue(
      db,
      {
        agent_id: t.id,
        agent_name: t.navn,
        candidate_url: candidateUrl,
        final_url: finalUrl,
        evidence,
        confidence,
        batch_id: batchId,
      },
      "navnesok_fallback",
    );

    return { ...base, status: "queued", candidate_url: candidateUrl, final_url: finalUrl, evidence, confidence };
  }

  return null;
}

// Processes ONE candidate clinic end-to-end across BOTH tiers: tier 1
// (Brreg-field leg) always runs first; tier 2 (navnesøk fallback) runs ONLY
// when tier 1 did not queue this row AND a search seam is wired (test
// override or a configured Brave key), and is attempted at most once. When
// tier 2 also finds nothing (or isn't attempted at all), the ORIGINAL tier-1
// result is returned UNCHANGED — existing skip-reason semantics for a
// Brreg-only failure are fully preserved.
async function processDentalWdCandidate(
  db: ReturnType<typeof getDb>,
  t: DentalWdTargetRow,
  batchId: string,
  searchFn: ((query: string) => Promise<BraveResult[]>) | null,
): Promise<DentalWdResultEntry> {
  const tier1 = await processDentalWdBrregLeg(db, t, batchId);
  if (tier1.status === "queued") {
    return { ...tier1, search_attempted: false };
  }
  if (!searchFn) {
    return { ...tier1, search_attempted: false };
  }

  const tier2 = await processDentalWdSearchLeg(db, t, batchId, searchFn);
  if (tier2) {
    return { ...tier2, search_attempted: true };
  }
  return { ...tier1, search_attempted: true };
}

const router = Router();

router.post("/hjemmeside-discovery-batch", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown };
  const batchId = `dental-hjemmeside-discovery-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15)}`;

  const db = getDb("dental");
  ensureDentalWebsiteReviewQueueTable(db);

  let targets: DentalWdTargetRow[] = [];
  const notEligible: DentalWdResultEntry[] = [];

  if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
    const ids = (body.agentIds as unknown[])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim());
    if (ids.length > DENTAL_WD_BATCH_CAP) {
      res.status(400).json({ error: `Too many agentIds (max ${DENTAL_WD_BATCH_CAP} per call)` });
      return;
    }
    const seenIds = new Set<string>();
    for (const id of ids) {
      if (seenIds.has(id)) {
        notEligible.push({ agent_id: id, agent_name: "", status: "not_eligible", reason: "duplicate_in_request" });
        continue;
      }
      seenIds.add(id);
      const row = getDentalWebsiteDiscoveryCandidateById(db, id);
      if (!row) {
        notEligible.push({ agent_id: id, agent_name: "", status: "not_eligible", reason: "not_eligible" });
        continue;
      }
      targets.push(row);
    }
  } else {
    targets = selectDentalWebsiteDiscoveryTargets(db, DENTAL_WD_BATCH_CAP);
  }

  const skipped = { no_brreg_website: 0, aggregator_host: 0, insufficient_evidence: 0, fetch_failed: 0 };
  const results: DentalWdResultEntry[] = [];
  let queued = 0;

  // Resolved ONCE per batch call — see dentalWdActiveSearchImpl's own doc
  // comment. null (tier 2 skipped for every row this call) whenever no test
  // override is installed and no Brave key is configured.
  const searchFn = dentalWdActiveSearchImpl();

  for (const t of targets) {
    const entry = await processDentalWdCandidate(db, t, batchId, searchFn);
    results.push(entry);
    if (entry.status === "queued") queued++;
    else if (Object.prototype.hasOwnProperty.call(skipped, entry.status)) {
      skipped[entry.status as keyof typeof skipped]++;
    }
  }

  for (const ne of notEligible) results.push(ne);

  res.json({
    success: true,
    batch_id: batchId,
    scanned: targets.length,
    queued,
    skipped,
    results,
  });
});

interface DentalWdQueueRow {
  agent_id: string;
  candidate_url: string;
  final_url: string | null;
  batch_id: string | null;
  status: string;
  reason: string | null;
}

type DentalWdApplyResult = { written: true } | { written: false; reason: string };

// Parse dental_agents.field_provenance (JSON string, possibly null/malformed)
// into a plain object — malformed/non-object/array JSON is treated as empty
// so a corrupted existing blob never blocks this write (mirrors
// parseFieldProvenance in admin-dental-mark-inactive.ts /
// admin-dental-hjemmeside-cleanup.ts).
function parseFieldProvenance(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface HjemmesideDiscoveryProvenanceEntry {
  source_type: "brreg_registered_website" | "search_verified_website";
  value: string;
  source_url: string;
  fetched_at: string;
}

// Maps a dental_website_review_queue row's `reason` to the field_provenance
// source_type it should stamp. 'navnesok_fallback' -> the tier-2, search-
// discovered source_type; ANYTHING ELSE (including the existing tier-1
// literal 'brreg_field' and any legacy/unrecognized value) -> the tier-1
// source_type — so a row from before this slice, or any value this route
// doesn't recognize, safely defaults to the ORIGINAL, unchanged behaviour
// rather than silently mis-stamping it as search-sourced.
function dentalWdSourceTypeForReason(
  reason: string | null | undefined,
): HjemmesideDiscoveryProvenanceEntry["source_type"] {
  return reason === "navnesok_fallback" ? "search_verified_website" : "brreg_registered_website";
}

/**
 * Merges a single hjemmeside-discovery provenance entry into an existing
 * field_provenance blob, preserving every OTHER field's provenance
 * untouched — same merge-not-clobber idiom as mergeInactiveProvenance
 * (admin-dental-mark-inactive.ts) / mergeHjemmesideCleanupProvenance
 * (admin-dental-hjemmeside-cleanup.ts): only the "hjemmeside" key is set.
 * Pure — exported for unit-testing.
 */
export function mergeHjemmesideDiscoveryProvenance(
  existingRaw: string | null | undefined,
  entry: HjemmesideDiscoveryProvenanceEntry,
): string {
  const existing = parseFieldProvenance(existingRaw);
  return JSON.stringify({ ...existing, hjemmeside: entry });
}

// The ONLY write this half of the route ever performs. Fill-only, re-
// checked against a FRESH row snapshot inside its own transaction — never
// trusts the queue row's vintage. Mirrors applyRfbAgentWebsite (admin-rfb-
// website-discovery.ts)'s re-check-before-write shape, minus the owner-
// claim/curated-field locks and audit-table insert that route also performs
// (dental_agents has no claimed_at/curated_fields concept and, per the dev-
// request's own non-goals, gets no new audit table in this slice).
export function applyDentalWebsiteDiscovery(
  db: ReturnType<typeof getDb>,
  agentId: string,
  url: string,
  finalUrl: string,
  batchId: string | null,
  queueReason: string | null,
): DentalWdApplyResult {
  let result: DentalWdApplyResult = { written: false, reason: "write_skipped_by_guards" };
  const tx = db.transaction(() => {
    const current = db
      .prepare(`SELECT hjemmeside, field_provenance FROM dental_agents WHERE id = ?`)
      .get(agentId) as { hjemmeside: string | null; field_provenance: string | null } | undefined;
    if (!current) {
      result = { written: false, reason: "agent_not_found" };
      return;
    }

    const upd = db
      .prepare(
        `UPDATE dental_agents
            SET hjemmeside = ?, updated_at = datetime('now')
          WHERE id = ? AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')`,
      )
      .run(url, agentId);
    if (upd.changes !== 1) {
      // Row was blank at queue time but filled by something else since —
      // re-checked HERE, at write time, not trusted from the queue row.
      result = { written: false, reason: "no_longer_blank" };
      return;
    }

    const mergedProvenance = mergeHjemmesideDiscoveryProvenance(current.field_provenance, {
      source_type: dentalWdSourceTypeForReason(queueReason),
      value: url,
      source_url: finalUrl,
      fetched_at: new Date().toISOString(),
    });
    db.prepare(`UPDATE dental_agents SET field_provenance = ? WHERE id = ?`).run(mergedProvenance, agentId);

    db.prepare(
      `UPDATE dental_website_review_queue
          SET status = 'applied', updated_at = datetime('now')
        WHERE agent_id = ? AND status = 'pending'`,
    ).run(agentId);

    result = { written: true };
  });
  tx();
  return result;
}

router.post("/hjemmeside-discovery-approve", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { approvals?: unknown; apply?: unknown };
  // STRICT: only the literal boolean true triggers a real write — same
  // convention as admin-dental-mark-inactive.ts's STRICT-FALSE dry_run parse,
  // inverted here per the dev-request's explicit "only apply === true" rule.
  const apply = body.apply === true;
  const dryRun = !apply;

  if (!Array.isArray(body.approvals) || body.approvals.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'approvals' array of {agent_id, url}" });
    return;
  }
  if (body.approvals.length > DENTAL_WD_APPROVE_MAX) {
    res.status(400).json({ error: `Too many approvals (max ${DENTAL_WD_APPROVE_MAX} per call)` });
    return;
  }

  const db = getDb("dental");
  ensureDentalWebsiteReviewQueueTable(db);

  const pending = db
    .prepare(`SELECT agent_id, candidate_url, final_url, batch_id, status, reason FROM dental_website_review_queue WHERE status = 'pending'`)
    .all() as DentalWdQueueRow[];
  const byAgent = new Map(pending.map((q) => [q.agent_id, q]));

  const seen = new Set<string>();
  const results: Array<{ agent_id: string; url: string; status: "would_apply" | "applied" }> = [];
  const skipped: Array<{ agent_id: string; url?: string; reason: string }> = [];

  for (const raw of body.approvals as unknown[]) {
    const a = raw as { agent_id?: unknown; url?: unknown };
    const agentId = typeof a?.agent_id === "string" ? a.agent_id.trim() : "";
    const url = typeof a?.url === "string" ? a.url.trim() : "";
    if (!agentId || !url) {
      skipped.push({ agent_id: agentId || "(missing)", reason: "invalid_item" });
      continue;
    }
    if (seen.has(agentId)) {
      skipped.push({ agent_id: agentId, url, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(agentId);

    const q = byAgent.get(agentId);
    if (!q) {
      skipped.push({ agent_id: agentId, url, reason: "not_in_review_queue" });
      continue;
    }
    if (q.candidate_url !== url) {
      skipped.push({ agent_id: agentId, url, reason: "mismatch_with_queued_candidate" });
      continue;
    }

    // Fill-only re-check against the CURRENT row, not the queue row's
    // vintage — mirrors admin-rfb-website-discovery.ts's no_longer_blank
    // re-check pattern exactly. Dry-run reports the SAME outcome a real
    // apply would hit right now, without writing anything.
    const currentRow = db.prepare(`SELECT hjemmeside FROM dental_agents WHERE id = ?`).get(agentId) as
      | { hjemmeside: string | null }
      | undefined;
    if (!currentRow) {
      skipped.push({ agent_id: agentId, url, reason: "agent_not_found" });
      continue;
    }
    if (currentRow.hjemmeside && currentRow.hjemmeside.trim() !== "") {
      skipped.push({ agent_id: agentId, url, reason: "no_longer_blank" });
      continue;
    }

    if (dryRun) {
      results.push({ agent_id: agentId, url, status: "would_apply" });
      continue;
    }

    const applied = applyDentalWebsiteDiscovery(db, agentId, url, q.final_url || url, q.batch_id, q.reason);
    if (applied.written) {
      results.push({ agent_id: agentId, url, status: "applied" });
    } else {
      skipped.push({ agent_id: agentId, url, reason: applied.reason });
    }
  }

  res.json({
    success: true,
    dry_run: dryRun,
    requested: (body.approvals as unknown[]).length,
    ...(dryRun ? { would_apply_count: results.length } : { applied_count: results.length }),
    results,
    skipped,
  });
});

export default router;

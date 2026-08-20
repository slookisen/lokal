// ─── POST /admin/rfb-website-discovery + GET /admin/rfb-website-review-queue ─
//
// dev-requests/2026-08-06-rfb-website-discovery-slice.md (interactive-session
// intake, per CLAUDE.md's "Dev-request intake" flow — L4 confirmed by Daniel
// same day). RFB has ~981 producer `agents` rows stuck in
// verification_status IN ('pending_verify','review_required') with no
// website on file (agent_knowledge.website blank) — without a website the
// enrichment/verification chain can never gather enough corroborating
// sources to promote them into the outreach-ready pool. This route is
// DISCOVERY + QUEUEING ONLY: for each candidate row, it guesses likely
// domain names from the producer's own name (gardssalgWebsiteCandidateHosts,
// services/experience-store.ts — one of the few pure, DB-independent helpers
// from the opplevagent/gårdssalg website-discovery mechanism that is safe to
// reuse directly by import; everything else here — fetch, host exclusion,
// shared-host guard — is a fresh, RFB-scoped re-implementation, NOT a call
// into opplevelser.ts, per the dev-request's explicit scoping instruction),
// fetches each candidate, and verifies the page is really that producer's
// site (org_nr / name / place evidence, gardssalgWebsiteEvidenceMatch)
// before proposing it.
//
// This route NEVER writes agent_knowledge.website or any other pre-existing
// column — the ONLY write it ever performs is an INSERT/upsert into the new
// `agents_website_review_queue` table, lazily created by
// ensureRfbWebsiteReviewQueueTable() below (mirrors ensureFindingsTable,
// services/search-enrich-sweep.ts — src/database/init.ts is out of scope for
// this slice and is never touched), status 'pending'. "dry-run" framing does
// not apply here the way it does to the
// gårdssalg sibling route: there is no live field this route could apply a
// change to even if it wanted to — queueing a reversible proposal (fully
// undone via `DELETE FROM agents_website_review_queue`) is the entire
// effect, every call. Approval/apply (writing agent_knowledge.website from a
// queued, human-approved candidate) is explicitly out of scope for this
// slice — a future slice, mirroring POST /admin/agents/org-nr-review-approve.
//
// Target cohort mirrors POST /admin/agents/org-nr-backfill's scoping exactly
// (admin-agents.ts, dev-request 2026-07-26-rfb-outreach-tilsig-
// blokkerdiagnose-og-orgnr) — the SAME 959/981-agent RFB cohort this route's
// sibling slice already measured: role='producer', COALESCE(vertical_id,
// 'rfb')='rfb'. Real column names (verified against src/database/init.ts,
// never guessed): `website`/`verification_status`/`postal_code`/`address`/
// `phone` live on `agent_knowledge` (agent_id FK), NOT on `agents` —
// `agents` itself only carries `org_nr` (added by ALTER, PR org-nr-gate) and
// `city` (no separate kommune/poststed column exists on this table, so
// `agents.city` is used as the evidence target's `kommune`).
//
// Auth: X-Admin-Key header (requireAdmin), same pattern as every other admin
// route file in this codebase (e.g. admin-agents.ts, admin-dental-hjemmeside-
// cleanup.ts) — deliberately re-defined locally rather than imported; no
// admin route file in this codebase shares that function via import.

import { Router, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/init";
import {
  gardssalgWebsiteCandidateHosts,
  gardssalgPageText,
  gardssalgWebsiteEvidenceMatch,
} from "../services/experience-store";
import { fetchPage, DEFAULT_FETCH_TIMEOUT_MS } from "../services/fetch-page";
import { renderPage, shouldEscalateToRender } from "../services/render-page";
import { mergeFieldProvenance } from "./admin-knowledge";
// dev-request 2026-08-20-enrichment-write-pause-mekanisk-gjerde — the
// mechanical fence. `getDb` is passed as a THUNK (never `getDb()`) so a
// getDb() that throws fails closed as a 423 instead of escaping as a 500.
import {
  assertEnrichmentWriteAllowedForAgentsOrThrow,
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
  enrichmentWritePauseBlockForAgents,
  sendEnrichmentWritePausedIfPaused,
} from "../services/enrichment-write-pause";

// ─── agents_website_review_queue (lazy, ensureXTable pattern) ──────────────
//
// src/database/init.ts is out of scope for this slice — mirrors
// ensureFindingsTable (services/search-enrich-sweep.ts) exactly: a
// CREATE TABLE IF NOT EXISTS run from inside this route file, called at the
// top of each handler (same call-site convention as admin-search-enrich.ts's
// `const db = getDb(); ensureFindingsTable(db);`) so the table is guaranteed
// to exist on a fresh main checkout without any edit to init.ts.
// agent_id is UNIQUE — this route re-runs "refresh, don't pile up" (a repeat
// discovery call for an already-queued agent replaces its pending proposal
// via ON CONFLICT(agent_id), never accumulates duplicates).
export function ensureRfbWebsiteReviewQueueTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents_website_review_queue (
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_website_review_queue_status ON agents_website_review_queue(status)`);

  // Additive migration: `existing_url` (nullable) was added for the
  // "aggregator_replace" discovery mode, which needs to record the
  // producer's CURRENT (aggregator/directory) website alongside the newly
  // proposed candidate — the "blank" mode leaves this column NULL, since
  // there was never a prior website to record. SQLite has no
  // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so this is guarded by
  // checking PRAGMA table_info first, making the migration idempotent
  // across repeated calls (this function runs at the top of every handler).
  const existingCols = db.prepare(`PRAGMA table_info(agents_website_review_queue)`).all() as Array<{ name: string }>;
  if (!existingCols.some((c) => c.name === "existing_url")) {
    db.exec(`ALTER TABLE agents_website_review_queue ADD COLUMN existing_url TEXT`);
  }
}

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

// Batch/limit convention: task instructions point at GS_WD_HARD_CAP-style
// caps (opplevelser.ts) — that family runs 30-48 depending on the
// endpoint's own total-cohort size. This route's cohort (~981 RFB producer
// agents) is closer in scale to admin-agents.ts's own org-nr-backfill
// sibling (AGENTS_ORGNR_BACKFILL_DEFAULT_LIMIT=25 / MAX_LIMIT=100) than to
// gårdssalg's 48-74-total-provider cohort, but the dev-request explicitly
// named the 30-48 GS_WD range, so this route takes the top of that named
// range (48) rather than the RFB-sibling's 100 — each call also performs a
// live network fetch per candidate host, unlike org-nr-backfill's DB/Brreg
// lookups, so keeping the per-call cap smaller bounds wall-clock cost too.
export const RFB_WD_DEFAULT_LIMIT = 25;
export const RFB_WD_HARD_CAP = 48;

const RFB_WD_USER_AGENT = "Lokal-RFB-WebsiteDiscovery/1.0";

// ─── Headless-render fallback (dev-request 2026-08-14-rfb-wd-headless-
// fallback) ──────────────────────────────────────────────────────────────
//
// Daniel measured 2026-08-13: 5/5 manually-checked website-discovery
// candidates were wrongly rejected `no_candidate_verified` even though the
// sites are real and live in a browser — the plain fetcher
// (services/fetch-page.ts) only ever sees the pre-script HTML, and a
// JS-built producer site (Wix/Squarespace-class) renders its actual content
// client-side, so evidence-matching against the raw fetch finds nothing to
// match against. services/render-page.ts (merged 2026-08-13, commits
// 8a51d85/f79ea4b) exists exactly for this: a headless-browser re-fetch of
// the SAME url, gated behind shouldEscalateToRender() so it only fires on
// pages that actually look like a JS shell (big + scripted + near-empty
// visible text), never on every miss.
//
// Flag-gated, default OFF — mirrors this codebase's existing boolean-env-
// flag idiom exactly (grep `process.env.\w+ === "true"`, e.g.
// admin-homepage-provenance-cohort.ts's HOMEPAGE_PARKING_DISABLED,
// admin-agents.ts's BRREG_VERIFY_ON_REGISTER). Unset/anything-other-than-
// the-literal-string-"true" = disabled = today's exact behaviour, zero
// regression risk — this is the "flag off = byte-identical to before" claim
// the dev-request makes.
function rfbWdHeadlessFallbackEnabled(): boolean {
  return process.env.RFB_WD_HEADLESS_FALLBACK_ENABLED === "true";
}

// Deliberately BELOW render-page.ts's own DEFAULT_RENDER_TIMEOUT_MS (20s).
// A single discovery call can walk up to RFB_WD_HARD_CAP (48) targets, each
// trying several name-guessed hosts before giving up, and the fallback can
// in principle fire more than once per call — a smaller per-render bound
// caps the worst-case wall-clock this still-rare, opt-in path can add to one
// batch without touching render-page.ts's own tested default (which other,
// future, non-batched callers may still want in full).
export const RFB_WD_RENDER_TIMEOUT_MS = 12_000;

// Per-call fallback counters, threaded through tryRfbWebsiteCandidateHost by
// mutable reference so both response shapes that call it (the external-
// candidates path and the auto-select/agentIds path) can report the same
// two numbers without a second code path to keep in sync.
// Exported (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 5) so
// admin-bm-producer-harvest.ts's apply-mode loop can thread its OWN
// fallback-counter accumulator through evaluateRfbWebsiteCandidate (below),
// same shared-across-the-whole-call convention this route's own external-
// candidates branch already uses — no behavior here is altered.
export interface RfbWdFallbackCounters {
  attempted: number;
  verified: number;
}

// Test-only injection point for renderPage (mirrors __setRfbCxRowDelayForTesting,
// admin-rfb-contact-extraction.ts): this codebase's esbuild/tsx toolchain
// compiles `import { renderPage } from ...` to a live binding that cannot be
// monkeypatched from OUTSIDE this module (see the file-header note in
// opplevelser-content-refresh-errors-by-persistence.test.ts) — a reference
// held INSIDE the module can still be swapped, though, same trick
// render-page.ts's own `renderImpl` option uses one level down. Production
// code always leaves this null and gets the real renderPage (and therefore
// the real, lazily-imported playwright-core — `renderer_unavailable`
// wherever it isn't installed, exactly as documented in render-page.ts).
let renderPageImplForTesting: typeof renderPage | null = null;
export function __setRfbWdRenderPageImplForTesting(impl: typeof renderPage | null): void {
  renderPageImplForTesting = impl;
}

// ─── Local, RFB-scoped re-implementation of the aggregator/directory +
// social-media host exclusion opplevelser.ts's gardssalg website-discovery
// keeps as LOCAL (non-exported) helpers — deliberately re-implemented here
// rather than imported (see file header), mirroring the shape of
// isDirectoryOrAggregatorHost / gardssalgSocialMediaHostReason
// (cross-source-validator.ts / experience-store.ts) but kept small and
// scoped to what this route needs. Suffix-walks the host down to its eTLD+1
// so a subdomain (e.g. "m.facebook.com") still matches its family entry.
export const RFB_WD_SOCIAL_HOSTS: ReadonlySet<string> = new Set([
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "linkedin.com",
  "pinterest.com",
  "snapchat.com",
]);

export const RFB_WD_DIRECTORY_HOSTS: ReadonlySet<string> = new Set([
  "1881.no",
  "gulesider.no",
  "proff.no",
  "brreg.no",
  "hanen.no",
  "hanen.com",
  "bondensmarked.no",
  "rekonorge.no",
  "reko.no",
  "lokalmat.no",
  "kortreistmat.no",
  "godtlokalt.no",
  "matprat.no",
  "visitnorway.no",
  "visitnorway.com",
  "tripadvisor.com",
  "yelp.com",
  "google.com",
  "google.no",
  "bing.com",
  "wikipedia.org",
]);

// Individually-known-bad hosts — NOT aggregators/directories (those live in
// RFB_WD_DIRECTORY_HOSTS above) and NOT social platforms (RFB_WD_SOCIAL_HOSTS)
// but specific producer-owned-looking domains independently confirmed to be
// hijacked, dead, or now belonging to a different entity than the RFB
// producer the domain name suggests. First entry: storbuktgard.no (Storbukt
// Gård — Balsfjord, agent 711c3807-17ab-4742-b13f-3c0162176a94) — its former
// site now 308-redirects to a spam site (correos.se.cemeterybook.com), per
// enrichment-reports/2026-08-10-hjemmesidejakt-pilot-20-rfb.md (row 12, §5
// F3) and the accompanying kandidater.json (slookisen/A2A, ~lines 205-219).
// This agent's agent_knowledge.website is currently blank (not wrongly set)
// — this entry is preventative, defense in depth, so no future
// discovery/verification pass can ever write this hijacked domain as the
// producer's own site even though today's evidence-match gate already
// happens to reject it independently.
export const RFB_WD_KNOWN_BAD_HOSTS: ReadonlySet<string> = new Set([
  "storbuktgard.no",
]);

// Exported (dev-request rfb-contact-extraction slice) so the sibling
// POST /admin/rfb-contact-extraction route (admin-rfb-contact-extraction.ts)
// can apply the SAME aggregator/social-media host exclusion to its own,
// differently-shaped cohort (rows that already have a website but a blank or
// DNS-dead contact_email) without re-implementing or drifting from this
// curated list. Export-only change — no behavior here is altered.
export function rfbWebsiteHostExclusionReason(host: string | null): string | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  for (let i = 0; i + 2 <= labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (RFB_WD_SOCIAL_HOSTS.has(suffix)) return "social_media_host";
  }
  for (let i = 0; i + 2 <= labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (RFB_WD_DIRECTORY_HOSTS.has(suffix)) return "blocklisted_directory_domain";
  }
  for (let i = 0; i + 2 <= labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (RFB_WD_KNOWN_BAD_HOSTS.has(suffix)) return "known_hijacked_domain";
  }
  return null;
}

// Small, local host-from-URL helper (mirrors hostFromUrlLike's shape,
// cross-source-validator.ts, but re-implemented rather than imported — see
// file header). Used both for the initial candidate host and to re-check the
// FINAL host after a fetch follows a redirect.
function rfbWdHostFromUrl(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

interface RfbWdTargetRow {
  id: string;
  name: string;
  org_nr: string | null;
  city: string | null;
  postal_code: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
}

// Shared SELECT shape for both the auto-select batch and the agentIds
// override lookup — real column names verified against src/database/init.ts
// (website/verification_status/postal_code/address/phone live on
// agent_knowledge, joined by agent_id; org_nr/city live directly on agents).
// `a.umbrella_type IS NULL` mirrors the canonical Phase 5.11 A4.1 umbrella-
// agent exclusion verbatim (src/database/init.ts, outreach_ready_pool view,
// ~line 2081) — an umbrella/venue row (REKO-ring, Bondens marked/torg) can
// structurally never have its own producer website, so it should never have
// been a discovery candidate. Measured 2026-08-13
// (enrichment-reports/2026-08-13-websoek-jakt-wrong-contact-og-wilsgaard.md,
// Funn A): 64% of the then-current discovery queue (30/47) were such rows.
function rfbWdSelectSql(extraWhere: string): string {
  return `
    SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.city AS city,
           k.postal_code AS postal_code, k.phone AS phone, k.address AS address,
           k.website AS website
      FROM agents a
      JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.role = 'producer'
       AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
       AND a.umbrella_type IS NULL  /* Phase 5.11 A4.1: exclude umbrella agents from marketing outreach */
       ${extraWhere}
  `;
}

// Pick strategy: ORDER BY RANDOM() (mirrors the getRelatedBySameCity /
// dental "recently-enriched" / marketplace "recently-enriched" precedent —
// grep `ORDER BY RANDOM()` in src/ — SQLite's native random ordering, no new
// helper needed) rather than oldest-first. Measured 2026-08-13
// (enrichment-reports/2026-08-13-websoek-jakt-wrong-contact-og-wilsgaard.md,
// Funn B): oldest-first concentrated the head of the queue on old
// Oslo-market-era rows, tanking the discovery hit-rate from 60% (random
// sample) to 6% (auto-select head). Deliberately scoped to THIS function
// only — selectRfbWebsiteReplacementTargets (aggregator_replace mode) keeps
// its own a.created_at ASC ordering untouched.
function selectRfbWebsiteDiscoveryTargets(db: ReturnType<typeof getDb>, limit: number): RfbWdTargetRow[] {
  return db
    .prepare(
      `${rfbWdSelectSql(
        `AND k.verification_status IN ('pending_verify','review_required')
         AND (k.website IS NULL OR TRIM(k.website) = '')`,
      )} ORDER BY RANDOM() LIMIT ?`,
    )
    .all(limit) as RfbWdTargetRow[];
}

// Request-body mode selector: "blank" (default, unchanged) targets producer
// rows with NO website on file; "aggregator_replace" targets a DIFFERENT
// cohort — rows that DO have a website, but that website is itself a
// directory/aggregator/social host (rfbWebsiteHostExclusionReason) rather
// than the producer's own real site. The host-exclusion check can't be
// expressed in SQL (it walks eTLD+1 suffixes against the curated sets), so
// this selects every non-blank-website row (same rfbWdSelectSql shape as the
// blank-mode selector) and filters/limits in application code — the cohort
// this route operates on (~981 RFB producer agents) is small enough that
// this costs nothing that matters. Never selects blank-website rows (the
// WHERE clause enforces that up front, same as the blank-mode selector's
// inverse).
function selectRfbWebsiteReplacementTargets(db: ReturnType<typeof getDb>, limit: number): RfbWdTargetRow[] {
  const rows = db
    .prepare(
      `${rfbWdSelectSql(`AND k.website IS NOT NULL AND TRIM(k.website) != ''`)} ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all() as RfbWdTargetRow[];
  const out: RfbWdTargetRow[] = [];
  for (const r of rows) {
    const host = rfbWdHostFromUrl(r.website as string);
    if (host && rfbWebsiteHostExclusionReason(host)) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// agentIds override: scoped to role/vertical only (NOT the verification-
// status/blank-website filters) — mirrors getAgentOrgNrBackfillTarget's own
// override semantics (admin-agents.ts): an admin can force a lookup attempt
// on any RFB producer agent; already-has-a-website is still enforced, just
// reported as `already_has_website` rather than silently omitted.
function getRfbWebsiteDiscoveryTarget(db: ReturnType<typeof getDb>, agentId: string): RfbWdTargetRow | null {
  const row = db.prepare(`${rfbWdSelectSql("AND a.id = @id")}`).get({ id: agentId }) as RfbWdTargetRow | undefined;
  return row ?? null;
}

// rfbWdSelectSql INNER JOINs agent_knowledge, so a producer with no knowledge
// row at all is invisible to this whole route — it 404s out of the external-
// candidate intake as `not_found` even though the agents row is a fully valid
// target. Measured 2026-08-13 (Bondens marked cross-match): 8 of 24 webless
// producers had no agent_knowledge row, i.e. a third of that cohort could
// never receive a website through the governed lever. Every agent_knowledge
// column except the PK is nullable or defaulted (database/init.ts), so the
// missing row is created EMPTY for an eligible producer and the evidence gate
// then decides on the merits. Only the external-candidate path calls this —
// auto-select SELECTs from knowledge state and has no candidate URL that
// would justify manufacturing rows.
function ensureKnowledgeRowForExternalCandidate(db: ReturnType<typeof getDb>, agentId: string): boolean {
  const eligible = db
    .prepare(
      `SELECT a.id AS id
         FROM agents a
        WHERE a.id = ?
          AND a.role = 'producer'
          AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
          AND NOT EXISTS (SELECT 1 FROM agent_knowledge k WHERE k.agent_id = a.id)`,
    )
    .get(agentId) as { id: string } | undefined;
  if (!eligible) return false;
  db.prepare(`INSERT OR IGNORE INTO agent_knowledge (agent_id) VALUES (?)`).run(agentId);
  return true;
}

// All hosts already carried by some OTHER agent's live agent_knowledge.website
// — a candidate landing on one of these is never this row's own site (mirrors
// gardssalgSharedHostCounts' role, re-implemented locally per the file
// header's scoping instruction). Exported (slice 5) so
// admin-bm-producer-harvest.ts's apply-mode loop can build the SAME
// existingHosts snapshot evaluateRfbWebsiteCandidate expects, once per call,
// rather than re-implementing this query — ground-rule "export, don't
// duplicate".
export function rfbWdExistingWebsiteHosts(db: ReturnType<typeof getDb>): Set<string> {
  const rows = db
    .prepare(`SELECT website FROM agent_knowledge WHERE website IS NOT NULL AND TRIM(website) != ''`)
    .all() as Array<{ website: string }>;
  const hosts = new Set<string>();
  for (const r of rows) {
    const h = rfbWdHostFromUrl(r.website);
    if (h) hosts.add(h);
  }
  return hosts;
}

// Exported (slice 5, see RfbWdFallbackCounters note above) — needed for
// evaluateRfbWebsiteCandidate's/RfbWdCandidateOutcome's own signatures.
export interface RfbWdEvidence {
  org_nr_found: boolean;
  name_found: boolean;
  place_found: boolean;
  phone_found: boolean;
  address_found: boolean;
  postnr_found: boolean;
  verified: boolean;
}

export interface RfbWdHit {
  host: string;
  finalUrl: string;
  evidence: RfbWdEvidence;
}

// Tries ONE candidate host: pre-fetch exclusion (social/directory + shared-
// host-in-catalog + shared-host-already-proposed-this-batch) -> fetch
// (services/fetch-page.ts's shared, already-SSRF-guarded, classified fetcher
// — reused rather than reinvented, per the dev-request's own "check for a
// shared fetch-with-timeout helper before reinventing one" instruction; this
// module is explicitly the shared fetcher for "every enrichment pipeline
// (rfb, dental, experiences)", not an opplevagent-vertical file, so importing
// it does not violate the "don't call into opplevelser.ts" scoping rule) ->
// final-host re-check after any redirect -> ownership-evidence match.
// Shared "final host after a redirect" exclusion re-check — used after BOTH
// a plain-fetch redirect and (headless fallback) a render redirect, so the
// two paths can never drift apart. Pushes the rejection reason into
// excludedHere and returns true when the host must be rejected.
function rfbWdCheckFinalHostExclusion(
  finalHost: string,
  existingHosts: Set<string>,
  hostsProposedThisBatch: Set<string>,
  excludedHere: Array<{ host: string; reason: string }>,
): boolean {
  const finalReason = rfbWebsiteHostExclusionReason(finalHost);
  if (finalReason) {
    excludedHere.push({ host: finalHost, reason: finalReason });
    return true;
  }
  if (existingHosts.has(finalHost)) {
    excludedHere.push({ host: finalHost, reason: "host_already_in_use" });
    return true;
  }
  if (hostsProposedThisBatch.has(finalHost)) {
    excludedHere.push({ host: finalHost, reason: "host_already_proposed_this_batch" });
    return true;
  }
  return false;
}

async function tryRfbWebsiteCandidateHost(
  host: string,
  evidenceTarget: Parameters<typeof gardssalgWebsiteEvidenceMatch>[1],
  existingHosts: Set<string>,
  hostsProposedThisBatch: Set<string>,
  tried: string[],
  excludedHere: Array<{ host: string; reason: string }>,
  fallbackCounters: RfbWdFallbackCounters,
): Promise<RfbWdHit | null> {
  const preReason = rfbWebsiteHostExclusionReason(host);
  if (preReason) {
    excludedHere.push({ host, reason: preReason });
    return null;
  }
  if (existingHosts.has(host)) {
    excludedHere.push({ host, reason: "host_already_in_use" });
    return null;
  }
  if (hostsProposedThisBatch.has(host)) {
    excludedHere.push({ host, reason: "host_already_proposed_this_batch" });
    return null;
  }

  tried.push(host);
  const result = await fetchPage(`https://${host}`, {
    userAgent: RFB_WD_USER_AGENT,
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const finalHost = rfbWdHostFromUrl(result.finalUrl) || host;
  if (finalHost !== host) {
    if (rfbWdCheckFinalHostExclusion(finalHost, existingHosts, hostsProposedThisBatch, excludedHere)) {
      return null;
    }
  }

  const pageText = gardssalgPageText(result.html);
  const evidence = gardssalgWebsiteEvidenceMatch(pageText, evidenceTarget);
  if (evidence.verified) {
    return { host: finalHost, finalUrl: result.finalUrl, evidence };
  }

  // ── Headless-render fallback ──────────────────────────────────────────
  // Only for a page that (a) really did fetch, (b) really did fail plain
  // evidence-matching, and (c) really does look like a JS shell — never a
  // blanket retry of every miss. A genuinely unreachable host never reaches
  // here at all (the `!result.ok` return above already left).
  if (rfbWdHeadlessFallbackEnabled() && shouldEscalateToRender(result.html)) {
    fallbackCounters.attempted++;
    const renderFn = renderPageImplForTesting ?? renderPage;
    const rendered = await renderFn(`https://${finalHost}`, {
      userAgent: RFB_WD_USER_AGENT,
      timeoutMs: RFB_WD_RENDER_TIMEOUT_MS,
    });
    if (rendered.ok) {
      const renderedFinalHost = rfbWdHostFromUrl(rendered.finalUrl) || finalHost;
      if (renderedFinalHost !== finalHost) {
        if (rfbWdCheckFinalHostExclusion(renderedFinalHost, existingHosts, hostsProposedThisBatch, excludedHere)) {
          return null;
        }
      }
      const renderedPageText = gardssalgPageText(rendered.html);
      const renderedEvidence = gardssalgWebsiteEvidenceMatch(renderedPageText, evidenceTarget);
      if (renderedEvidence.verified) {
        fallbackCounters.verified++;
        return { host: renderedFinalHost, finalUrl: rendered.finalUrl, evidence: renderedEvidence };
      }
    }
    // !rendered.ok (including `renderer_unavailable` — this machine simply
    // cannot render, never a statement about the site) or render succeeded
    // but still didn't verify: fall through to the same `no candidate`
    // outcome as if no fallback had ever been attempted. Never a throw,
    // never a negative signal recorded against the producer.
  }

  return null;
}

function rfbWdConfidence(evidence: RfbWdEvidence): number {
  if (evidence.org_nr_found) return 1.0;
  if (evidence.phone_found) return 0.95;
  if (evidence.address_found || evidence.postnr_found) return 0.92;
  return 0.9; // name + place
}

// The ONLY write this route ever performs. Upsert-in-place on agent_id
// (UNIQUE) — "refresh, don't pile up", the same idiom this codebase already
// uses for agents_org_nr_review_queue / gardssalg_website_review_queue: a
// re-run of this route for an already-queued agent replaces its pending
// proposal rather than accumulating duplicates. Fully reversible — nothing
// else in this route or elsewhere reads this table yet (a future
// approve/apply slice would), and `DELETE FROM agents_website_review_queue`
// undoes every effect of every call.
function upsertRfbWebsiteReviewQueue(
  db: ReturnType<typeof getDb>,
  entry: {
    agent_id: string;
    agent_name: string;
    candidate_url: string;
    final_url: string;
    evidence: RfbWdEvidence;
    confidence: number;
    batch_id: string;
    // "blank" mode omits both — default reason preserves today's row shape
    // exactly; existing_url stays NULL since there was no prior website.
    reason?: string;
    existing_url?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO agents_website_review_queue
       (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, existing_url, batch_id, status, created_at, updated_at)
     VALUES (@id, @agent_id, @agent_name, @candidate_url, @final_url, @evidence, @confidence,
             @reason, @existing_url, @batch_id, 'pending', datetime('now'), datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       candidate_url = excluded.candidate_url,
       final_url = excluded.final_url,
       evidence = excluded.evidence,
       confidence = excluded.confidence,
       reason = excluded.reason,
       existing_url = excluded.existing_url,
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
    reason: entry.reason ?? "website_discovery_candidate",
    existing_url: entry.existing_url ?? null,
    batch_id: entry.batch_id,
  });
}

// ─── evaluateRfbWebsiteCandidate (dev-request 2026-08-14-bm-fullhoest-
// katalogbred, slice 5) ─────────────────────────────────────────────────────
//
// Pure extraction of the external-candidate intake's per-item body below
// (originally inline in POST /rfb-website-discovery's `candidates` branch,
// ~L720-795 before this slice) — mechanical, zero behavior change: target
// lookup/knowledge-row-creation, already-has-website check, host resolution,
// tryRfbWebsiteCandidateHost's evidence-gating, and (on a verified hit)
// upsertRfbWebsiteReviewQueue — the SAME "review-kø, aldri auto-skriv"
// discipline every call into this route already followed. NEVER writes
// agent_knowledge.website or any other pre-existing column; the queue upsert
// is the only side effect, exactly as before. Exported so
// admin-bm-producer-harvest.ts's apply-mode loop can reuse this EXACT
// evidence-gating logic for its own `record.website` candidates via
// import — never a copy/paste, never a self-HTTP round-trip (ground rules).
//
// `existingHosts`/`hostsProposedThisBatch`/`fallbackCounters` are threaded
// by the CALLER across its whole batch (this route's own candidates branch
// builds them once per request, same as before this slice; the BM harvest
// route builds its own equivalents once per apply-mode call) — this function
// never constructs or resets them itself, so the shared-host-dedup guarantee
// is identical regardless of which caller drives it.
export type RfbWdCandidateOutcome =
  | {
      outcome: "proposed";
      agent_id: string;
      agent_name: string;
      candidate_url: string;
      final_url: string;
      evidence: RfbWdEvidence;
      confidence: number;
    }
  | {
      outcome: "rejected";
      agent_id: string;
      agent_name: string;
      reason: string;
      tried: string[];
      excluded: Array<{ host: string; reason: string }>;
    }
  | { outcome: "already_has_website"; agent_id: string; agent_name: string }
  | { outcome: "not_found"; agent_id: string };

export async function evaluateRfbWebsiteCandidate(
  db: ReturnType<typeof getDb>,
  candidate: { agentId: string; url: string },
  existingHosts: Set<string>,
  hostsProposedThisBatch: Set<string>,
  fallbackCounters: RfbWdFallbackCounters,
  batchId: string,
): Promise<RfbWdCandidateOutcome> {
  let t = getRfbWebsiteDiscoveryTarget(db, candidate.agentId);
  if (!t && ensureKnowledgeRowForExternalCandidate(db, candidate.agentId)) {
    t = getRfbWebsiteDiscoveryTarget(db, candidate.agentId);
  }
  if (!t) {
    return { outcome: "not_found", agent_id: candidate.agentId };
  }
  if (t.website && t.website.trim() !== "") {
    return { outcome: "already_has_website", agent_id: t.id, agent_name: t.name };
  }

  const host = rfbWdHostFromUrl(candidate.url);
  if (!host) {
    return { outcome: "rejected", agent_id: t.id, agent_name: t.name, reason: "invalid_candidate_url", tried: [], excluded: [] };
  }

  const evidenceTarget = {
    orgNr: t.org_nr,
    navn: t.name,
    kommune: t.city,
    poststed: null as string | null,
    telefon: t.phone,
    mobil: null as string | null,
    adresse: t.address,
    postnummer: t.postal_code,
  };
  const tried: string[] = [];
  const excludedHere: Array<{ host: string; reason: string }> = [];
  const hit = await tryRfbWebsiteCandidateHost(
    host,
    evidenceTarget,
    existingHosts,
    hostsProposedThisBatch,
    tried,
    excludedHere,
    fallbackCounters,
  );

  if (hit) {
    hostsProposedThisBatch.add(hit.host);
    let candidateUrl: string;
    try {
      const u = new URL(hit.finalUrl);
      candidateUrl = `${u.protocol}//${u.host.toLowerCase()}`;
    } catch {
      candidateUrl = `https://${hit.host}`;
    }
    const confidence = rfbWdConfidence(hit.evidence);
    upsertRfbWebsiteReviewQueue(db, {
      agent_id: t.id,
      agent_name: t.name,
      candidate_url: candidateUrl,
      final_url: hit.finalUrl,
      evidence: hit.evidence,
      confidence,
      batch_id: batchId,
      reason: "website_discovery_candidate_external",
    });
    return {
      outcome: "proposed",
      agent_id: t.id,
      agent_name: t.name,
      candidate_url: candidateUrl,
      final_url: hit.finalUrl,
      evidence: hit.evidence,
      confidence,
    };
  }

  let reason: string;
  if (excludedHere.length > 0) reason = excludedHere[0].reason;
  else reason = "no_candidate_verified";
  return { outcome: "rejected", agent_id: t.id, agent_name: t.name, reason, tried, excluded: excludedHere };
}

const router = Router();

// External-candidate intake item shape (dev-request 2026-08-10-rfb-
// hjemmesidejakt-full-loype, punkt 4a): a caller (web-search session/routine)
// proposes a SPECIFIC url for a SPECIFIC agent instead of relying on this
// route's own name-guessed hosts. The proposed url gets the EXACT same
// treatment a guessed host gets — host exclusion (social/directory),
// shared-host guards, server-side fetch, redirect re-check, ownership-
// evidence match — before it may enter the review queue. The 2026-08-10
// pilot measured why this intake is needed: name-guessing scored 0/25 and
// 0/9 on cohorts where interactive web search scored 12/20, but the searcher
// had no governed way to hand its finds to the queue.
interface RfbWdExternalCandidate {
  agentId: string;
  url: string;
}

function parseExternalCandidates(raw: unknown): RfbWdExternalCandidate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RfbWdExternalCandidate[] = [];
  for (const item of raw) {
    const o = item as { agentId?: unknown; url?: unknown };
    const agentId = typeof o?.agentId === "string" ? o.agentId.trim() : "";
    const url = typeof o?.url === "string" ? o.url.trim() : "";
    if (!agentId || !url) return null; // malformed item poisons the whole call — 400, never a silent partial run
    out.push({ agentId, url });
  }
  return out;
}

router.post("/rfb-website-discovery", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown; mode?: unknown; candidates?: unknown };
  // "blank" (default/omitted) — unchanged, byte-identical behaviour: targets
  // producer rows with NO website on file. "aggregator_replace" is the new
  // mode: targets rows whose CURRENT website is itself a directory/
  // aggregator/social host rather than the producer's own real site. Any
  // value other than the literal string "aggregator_replace" resolves to
  // "blank", so an omitted/unset mode is indistinguishable from today.
  const mode: "blank" | "aggregator_replace" = body.mode === "aggregator_replace" ? "aggregator_replace" : "blank";
  const batchId = `rfb-website-discovery-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const db = getDb();
  ensureRfbWebsiteReviewQueueTable(db);
  const notFound: string[] = [];
  const alreadyHasWebsite: Array<{ agent_id: string; agent_name: string; reason?: string }> = [];
  let targets: RfbWdTargetRow[] = [];

  // ── External-candidate intake (punkt 4a) — mutually exclusive with every
  //    other selection path so a call's cohort is never ambiguous ───────────
  if (body.candidates !== undefined) {
    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      res.status(400).json({ error: "candidates og agentIds kan ikke kombineres i samme kall" });
      return;
    }
    if (mode === "aggregator_replace") {
      res.status(400).json({ error: "candidates støtter kun blank-modus (fill-only)" });
      return;
    }
    const candidates = parseExternalCandidates(body.candidates);
    if (candidates === null || candidates.length === 0) {
      res.status(400).json({ error: "candidates må være en ikke-tom array av {agentId, url}" });
      return;
    }
    if (candidates.length > RFB_WD_HARD_CAP) {
      res.status(400).json({ error: `Too many candidates (max ${RFB_WD_HARD_CAP} per call)` });
      return;
    }

    const existingHostsExt = rfbWdExistingWebsiteHosts(db);
    const hostsProposedExt = new Set<string>();
    const fallbackCountersExt: RfbWdFallbackCounters = { attempted: 0, verified: 0 };
    const proposedExt: Array<{
      agent_id: string;
      agent_name: string;
      candidate_url: string;
      final_url: string;
      evidence: RfbWdEvidence;
      confidence: number;
    }> = [];
    const rejectedExt: Array<{
      agent_id: string;
      agent_name: string;
      reason: string;
      tried: string[];
      excluded: Array<{ host: string; reason: string }>;
    }> = [];
    const seenAgentIds = new Set<string>();

    for (const c of candidates) {
      if (seenAgentIds.has(c.agentId)) {
        rejectedExt.push({ agent_id: c.agentId, agent_name: "", reason: "duplicate_agent_in_request", tried: [], excluded: [] });
        continue;
      }
      seenAgentIds.add(c.agentId);

      // Per-candidate evaluation is now the shared, exported
      // evaluateRfbWebsiteCandidate (slice 5) — this loop only translates its
      // discriminated-union return into the SAME proposedExt/rejectedExt/
      // alreadyHasWebsite/notFound buckets it always pushed into, so the
      // response shape below is byte-identical to before the extraction.
      const outcome = await evaluateRfbWebsiteCandidate(
        db,
        { agentId: c.agentId, url: c.url },
        existingHostsExt,
        hostsProposedExt,
        fallbackCountersExt,
        batchId,
      );

      switch (outcome.outcome) {
        case "not_found":
          notFound.push(outcome.agent_id);
          break;
        case "already_has_website":
          alreadyHasWebsite.push({ agent_id: outcome.agent_id, agent_name: outcome.agent_name });
          break;
        case "proposed":
          proposedExt.push({
            agent_id: outcome.agent_id,
            agent_name: outcome.agent_name,
            candidate_url: outcome.candidate_url,
            final_url: outcome.final_url,
            evidence: outcome.evidence,
            confidence: outcome.confidence,
          });
          break;
        case "rejected":
          rejectedExt.push({
            agent_id: outcome.agent_id,
            agent_name: outcome.agent_name,
            reason: outcome.reason,
            tried: outcome.tried,
            excluded: outcome.excluded,
          });
          break;
      }
    }

    res.json({
      success: true,
      mode: "external_candidates",
      batch_id: batchId,
      scanned: seenAgentIds.size,
      proposed: proposedExt,
      rejected: rejectedExt,
      already_has_website: alreadyHasWebsite,
      not_found: notFound,
      headless_fallback_attempted: fallbackCountersExt.attempted,
      headless_fallback_verified: fallbackCountersExt.verified,
    });
    return;
  }

  if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
    const ids = (body.agentIds as unknown[])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim());
    if (ids.length > RFB_WD_HARD_CAP) {
      res.status(400).json({ error: `Too many agentIds (max ${RFB_WD_HARD_CAP} per call)` });
      return;
    }
    for (const id of ids) {
      const t = getRfbWebsiteDiscoveryTarget(db, id);
      if (!t) {
        notFound.push(id);
      } else if (mode === "aggregator_replace") {
        // Inverted-check idiom mirrored from blank mode's own
        // already-has-website check, but the semantics are inverted for
        // this cohort: a row only qualifies if its CURRENT website is a
        // known aggregator/directory/social host. Blank websites and
        // already-genuine sites are both rejected here, distinguished from
        // blank mode's rejection reason so a caller isn't guessing.
        const currentHost = t.website ? rfbWdHostFromUrl(t.website) : null;
        const exclusionReason = currentHost ? rfbWebsiteHostExclusionReason(currentHost) : null;
        if (!t.website || t.website.trim() === "" || !exclusionReason) {
          alreadyHasWebsite.push({ agent_id: t.id, agent_name: t.name, reason: "no_current_aggregator_website" });
        } else {
          targets.push(t);
        }
      } else if (t.website && t.website.trim() !== "") {
        alreadyHasWebsite.push({ agent_id: t.id, agent_name: t.name });
      } else {
        targets.push(t);
      }
    }
  } else {
    const limit = Math.min(
      typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : RFB_WD_DEFAULT_LIMIT,
      RFB_WD_HARD_CAP,
    );
    if (mode === "aggregator_replace") {
      targets = selectRfbWebsiteReplacementTargets(db, limit);
      // Auto-select's own filtering already excludes rows that don't
      // qualify, but the check is repeated defensively (same convention as
      // blank mode below) so the two selection paths can never silently
      // diverge in behaviour.
      targets = targets.filter((t) => {
        const currentHost = t.website ? rfbWdHostFromUrl(t.website) : null;
        const exclusionReason = currentHost ? rfbWebsiteHostExclusionReason(currentHost) : null;
        if (!t.website || t.website.trim() === "" || !exclusionReason) {
          alreadyHasWebsite.push({ agent_id: t.id, agent_name: t.name, reason: "no_current_aggregator_website" });
          return false;
        }
        return true;
      });
    } else {
      targets = selectRfbWebsiteDiscoveryTargets(db, limit);
      // Auto-select's own WHERE already excludes non-blank website, but the
      // check is repeated defensively so the two selection paths can never
      // silently diverge in behaviour.
      targets = targets.filter((t) => {
        if (t.website && t.website.trim() !== "") {
          alreadyHasWebsite.push({ agent_id: t.id, agent_name: t.name });
          return false;
        }
        return true;
      });
    }
  }

  const existingHosts = rfbWdExistingWebsiteHosts(db);
  const hostsProposedThisBatch = new Set<string>();
  const fallbackCounters: RfbWdFallbackCounters = { attempted: 0, verified: 0 };

  const proposed: Array<{
    agent_id: string;
    agent_name: string;
    candidate_url: string;
    final_url: string;
    evidence: RfbWdEvidence;
    confidence: number;
    existing_url?: string | null;
  }> = [];
  const rejected: Array<{
    agent_id: string;
    agent_name: string;
    reason: string;
    tried: string[];
    excluded: Array<{ host: string; reason: string }>;
  }> = [];

  for (const t of targets) {
    const evidenceTarget = {
      orgNr: t.org_nr,
      navn: t.name,
      kommune: t.city,
      poststed: null as string | null,
      telefon: t.phone,
      mobil: null as string | null,
      adresse: t.address,
      postnummer: t.postal_code,
    };

    const hosts = gardssalgWebsiteCandidateHosts(t.name);
    const tried: string[] = [];
    const excludedHere: Array<{ host: string; reason: string }> = [];

    let hit: RfbWdHit | null = null;
    for (const host of hosts) {
      hit = await tryRfbWebsiteCandidateHost(
        host,
        evidenceTarget,
        existingHosts,
        hostsProposedThisBatch,
        tried,
        excludedHere,
        fallbackCounters,
      );
      if (hit) break;
    }

    if (hit) {
      hostsProposedThisBatch.add(hit.host);
      let candidateUrl: string;
      try {
        const u = new URL(hit.finalUrl);
        candidateUrl = `${u.protocol}//${u.host.toLowerCase()}`;
      } catch {
        candidateUrl = `https://${hit.host}`;
      }
      const confidence = rfbWdConfidence(hit.evidence);
      // Reason + existing_url are mode-scoped: blank mode omits both (undefined
      // existing_url, default reason inside upsertRfbWebsiteReviewQueue) so its
      // queue-row shape and this response are unchanged from before this mode
      // existed; aggregator_replace records the producer's CURRENT (bad)
      // website alongside the newly proposed candidate.
      const isReplacement = mode === "aggregator_replace";
      const existingUrl = isReplacement ? t.website : undefined;
      upsertRfbWebsiteReviewQueue(db, {
        agent_id: t.id,
        agent_name: t.name,
        candidate_url: candidateUrl,
        final_url: hit.finalUrl,
        evidence: hit.evidence,
        confidence,
        batch_id: batchId,
        reason: isReplacement ? "website_discovery_candidate_replacement" : undefined,
        existing_url: existingUrl,
      });
      proposed.push({
        agent_id: t.id,
        agent_name: t.name,
        candidate_url: candidateUrl,
        final_url: hit.finalUrl,
        evidence: hit.evidence,
        confidence,
        existing_url: existingUrl,
      });
    } else {
      // No verified candidate. Reason: if no candidate host could even be
      // generated, say so; else if ANY generated host was excluded (curated
      // aggregator/social host, or a shared-host guard hit) that specific,
      // actionable reason dominates — a human reviewing "host_already_in_use"
      // does not need to also know a different, less-likely candidate host
      // separately failed the evidence check. Only when NO host was ever
      // excluded does this fall through to the generic "we fetched real
      // candidates and none of them carried matching evidence" reason.
      let reason: string;
      if (hosts.length === 0) reason = "no_candidate_hosts";
      else if (excludedHere.length > 0) reason = excludedHere[0].reason;
      else reason = "no_candidate_verified";
      rejected.push({ agent_id: t.id, agent_name: t.name, reason, tried, excluded: excludedHere });
    }
  }

  res.json({
    success: true,
    mode,
    batch_id: batchId,
    scanned: targets.length,
    proposed,
    rejected,
    already_has_website: alreadyHasWebsite,
    not_found: notFound,
    headless_fallback_attempted: fallbackCounters.attempted,
    headless_fallback_verified: fallbackCounters.verified,
  });
});

router.get("/rfb-website-review-queue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  ensureRfbWebsiteReviewQueueTable(db);
  const rows = db
    .prepare(`SELECT * FROM agents_website_review_queue WHERE status = 'pending' ORDER BY created_at DESC`)
    .all();
  res.json({ success: true, count: rows.length, queue: rows });
});

// ─── POST /admin/rfb-website-review-approve (punkt 4b — the apply slice) ────
//
// The adoption lever for queued website candidates — the RFB mirror of
// POST /api/opplevelser/admin/gardssalg-website-review-approve
// (routes/opplevelser.ts), same strict confirmation-surface contract:
// ONLY the queued (agent_id, candidate_url) pair can be approved; a
// different URL is rejected (mismatch_with_queued_candidate), a non-queued
// agent is rejected (not_in_review_queue). Never an arbitrary-write surface.
//
// Writes go through applyRfbAgentWebsite below: fill-only (the row's
// agent_knowledge.website must STILL be blank at write time), owner-claim
// lock (agents.claimed_at), per-field curated lock
// (agent_knowledge.curated_fields.website), host-exclusion re-check, and
// shared-host re-check — all re-read from a FRESH row snapshot inside the
// write's own transaction (same re-check-before-write convention as the
// contact-write-guard retro-sweep). A confirmed write also merges a
// field_provenance record (source_type "homepage" — the evidence WAS the
// producer's own live page, verified at queue time) via the SAME
// mergeFieldProvenance every other provenance writer uses, appends an
// agent_knowledge_audit row, and flips the queue entry to status='applied'.
//
// Dry-run by default (apply === true/1/"1"/"true" in body, or ?apply=1/true
// — the exact truthy-check every other approve lever uses). NOTE the
// enrichment write-pause discipline (controller/enrichment-write-pause.yaml,
// slookisen/A2A): while a vertical's pause is enabled, callers must not
// invoke this lever with apply=true — the discipline lives in WHO calls it,
// same as the retro-sweep's own apply contract.

type RfbWdApplyResult =
  | { written: true }
  | { written: false; reason: string };

export function applyRfbAgentWebsite(
  db: ReturnType<typeof getDb>,
  agentId: string,
  candidateUrl: string,
  finalUrl: string,
  batchId: string | null,
): RfbWdApplyResult {
  // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
  // pause-mekanisk-gjerde; PR review finding 1) ─────────────────────────────
  // On the SHARED primitive, not only on the route below, so any future reuse
  // (admin-bm-producer-harvest's harvest path is the one already named in this
  // repo) inherits the fence instead of having to remember its own gate call.
  // Vertical comes from this agent's own `agents.vertical_id`, same resolution
  // as every other gated surface; a lookup that cannot answer fails CLOSED.
  //
  // THROWS rather than returning a {written:false, reason} — deliberately. A
  // per-item reason would turn a live pause into a partial-batch outcome, and
  // the promise this dev-request makes is ZERO writes while a pause is live,
  // for the whole request. The route below catches it and answers 423.
  assertEnrichmentWriteAllowedForAgentsOrThrow(db, [agentId]);

  const host = rfbWdHostFromUrl(candidateUrl);
  if (!host) return { written: false, reason: "invalid_candidate_url" };
  const exclusion = rfbWebsiteHostExclusionReason(host);
  if (exclusion) return { written: false, reason: exclusion };

  let result: RfbWdApplyResult = { written: false, reason: "write_skipped_by_guards" };
  const tx = db.transaction(() => {
    // Fresh snapshot inside the transaction — never trust the queue row's
    // vintage for lock/fill state.
    const fresh = db
      .prepare(
        `SELECT a.claimed_at AS claimed_at, k.website AS website,
                k.curated_fields AS curated_fields, k.field_provenance AS field_provenance
           FROM agents a
           JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(agentId) as
      | { claimed_at: string | null; website: string | null; curated_fields: string | null; field_provenance: string | null }
      | undefined;
    if (!fresh) {
      result = { written: false, reason: "agent_not_found" };
      return;
    }
    if (fresh.claimed_at !== null) {
      result = { written: false, reason: "owner_claimed_row_locked" };
      return;
    }
    let curated: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fresh.curated_fields || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) curated = parsed;
    } catch {
      /* malformed curated_fields → treat as no locks (matches canCorrectFactualField's tolerance) */
    }
    if (Object.prototype.hasOwnProperty.call(curated, "website")) {
      result = { written: false, reason: "curated_field_locked" };
      return;
    }
    if (fresh.website && fresh.website.trim() !== "") {
      result = { written: false, reason: "no_longer_blank" };
      return;
    }
    // Shared-host re-check at write time: the host must not have been taken
    // by ANOTHER agent between queue time and now. rfbWdExistingWebsiteHosts
    // collects every non-blank website host; this row's own is blank (checked
    // above), so a hit here is always another agent's.
    if (rfbWdExistingWebsiteHosts(db).has(host)) {
      result = { written: false, reason: "host_already_in_use" };
      return;
    }

    const upd = db
      .prepare(
        `UPDATE agent_knowledge
            SET website = ?, updated_at = datetime('now')
          WHERE agent_id = ? AND (website IS NULL OR TRIM(website) = '')`,
      )
      .run(candidateUrl, agentId);
    if (upd.changes !== 1) {
      result = { written: false, reason: "no_longer_blank" };
      return;
    }

    // Provenance: same merge helper as every other provenance writer.
    let existingProv: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fresh.field_provenance || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingProv = parsed;
    } catch {
      /* malformed → start clean; merge helper rebuilds well-formed shape */
    }
    const merged = mergeFieldProvenance(existingProv, {
      website: {
        sources: [
          {
            source_type: "homepage",
            value: candidateUrl,
            source_url: finalUrl,
            fetched_at: new Date().toISOString(),
          },
        ],
      },
    });
    db.prepare(`UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?`).run(
      JSON.stringify(merged),
      agentId,
    );

    db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, 'website', NULL, ?, 'admin', NULL, datetime('now'), ?)`,
    ).run(uuid(), agentId, candidateUrl, `batch:${batchId ?? "manual"} source:rfb-website-review-approve`);

    db.prepare(
      `UPDATE agents_website_review_queue
          SET status = 'applied', updated_at = datetime('now')
        WHERE agent_id = ? AND status = 'pending'`,
    ).run(agentId);

    result = { written: true };
  });
  tx();
  return result;
}

router.post("/rfb-website-review-approve", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { approvals?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.approvals) || body.approvals.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'approvals' array of {agent_id, url}" });
    return;
  }
  if (body.approvals.length > 200) {
    res.status(400).json({ error: "Too many approvals (max 200 per call)" });
    return;
  }

  // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
  // pause-mekanisk-gjerde; PR review finding 1) ─────────────────────────────
  // `lokal-agent-enrichment` calls this with apply=1 (SKILL PHASE 3:
  // `POST $BASE/admin/rfb-website-review-approve?apply=1`). Gated on the
  // APPLY path only — a dry run performs no write at all, and leaving it
  // reachable during a pause is what lets an operator still MEASURE the queue
  // while writes are frozen. Gated per-REQUEST over every agent_id named in
  // the body, so a batch spanning a paused vertical is blocked whole: zero
  // writes, not a partially-applied batch. `getDb` passed as a thunk so a
  // getDb() throw also fails closed here.
  if (apply) {
    const pauseBlock = enrichmentWritePauseBlockForAgents(
      getDb,
      (body.approvals as unknown[]).map((raw) => {
        const id = (raw as { agent_id?: unknown } | null)?.agent_id;
        return typeof id === "string" ? id : "";
      }),
    );
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const db = getDb();
  ensureRfbWebsiteReviewQueueTable(db);
  const pending = db
    .prepare(`SELECT * FROM agents_website_review_queue WHERE status = 'pending'`)
    .all() as Array<{ agent_id: string; candidate_url: string; final_url: string | null; batch_id: string | null }>;
  const byAgent = new Map(pending.map((q) => [q.agent_id, q]));

  const seen = new Set<string>();
  const approved: Array<{ agent_id: string; url: string }> = [];
  const written: Array<{ agent_id: string; url: string }> = [];
  const rejected: Array<{ agent_id: string; reason: string }> = [];

  for (const raw of body.approvals as unknown[]) {
    const a = raw as { agent_id?: unknown; url?: unknown };
    const aid = typeof a?.agent_id === "string" ? a.agent_id.trim() : "";
    const url = typeof a?.url === "string" ? a.url.trim() : "";
    if (!aid || !url) {
      rejected.push({ agent_id: aid || "(missing)", reason: "invalid_item" });
      continue;
    }
    if (seen.has(aid)) {
      rejected.push({ agent_id: aid, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(aid);
    const q = byAgent.get(aid);
    if (!q) {
      rejected.push({ agent_id: aid, reason: "not_in_review_queue" });
      continue;
    }
    if (q.candidate_url !== url) {
      rejected.push({ agent_id: aid, reason: "mismatch_with_queued_candidate" });
      continue;
    }
    approved.push({ agent_id: aid, url });
    if (!dryRun) {
      try {
        const w = applyRfbAgentWebsite(db, aid, q.candidate_url, q.final_url || q.candidate_url, q.batch_id);
        if (w.written) {
          written.push({ agent_id: aid, url: q.candidate_url });
        } else {
          rejected.push({ agent_id: aid, reason: w.reason });
        }
      } catch (err: any) {
        // A pause that went live between this request's gate and this item's
        // write: applyRfbAgentWebsite's own gate caught it. Abort the WHOLE
        // remaining batch with the shared 423 rather than degrading it into a
        // per-item `write_failed:` reason — a live pause is never a per-item
        // outcome. Items already written before the pause landed stand; that
        // is a genuine race, and stopping here is the narrowest response to it.
        if (sendEnrichmentWritePausedIfPaused(err, res)) return;
        rejected.push({ agent_id: aid, reason: `write_failed: ${err?.message ?? String(err)}` });
      }
    }
  }

  res.json({
    dry_run: dryRun,
    approved_count: approved.length,
    approved,
    written_count: written.length,
    written,
    rejected,
  });
});

export default router;

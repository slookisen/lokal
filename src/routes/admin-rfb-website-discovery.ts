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
// `agents_website_review_queue` table (src/database/init.ts), status
// 'pending'. "dry-run" framing does not apply here the way it does to the
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

// ─── Local, RFB-scoped re-implementation of the aggregator/directory +
// social-media host exclusion opplevelser.ts's gardssalg website-discovery
// keeps as LOCAL (non-exported) helpers — deliberately re-implemented here
// rather than imported (see file header), mirroring the shape of
// isDirectoryOrAggregatorHost / gardssalgSocialMediaHostReason
// (cross-source-validator.ts / experience-store.ts) but kept small and
// scoped to what this route needs. Suffix-walks the host down to its eTLD+1
// so a subdomain (e.g. "m.facebook.com") still matches its family entry.
const RFB_WD_SOCIAL_HOSTS: ReadonlySet<string> = new Set([
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

const RFB_WD_DIRECTORY_HOSTS: ReadonlySet<string> = new Set([
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

function rfbWebsiteHostExclusionReason(host: string | null): string | null {
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
function rfbWdSelectSql(extraWhere: string): string {
  return `
    SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.city AS city,
           k.postal_code AS postal_code, k.phone AS phone, k.address AS address,
           k.website AS website
      FROM agents a
      JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.role = 'producer'
       AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
       ${extraWhere}
  `;
}

function selectRfbWebsiteDiscoveryTargets(db: ReturnType<typeof getDb>, limit: number): RfbWdTargetRow[] {
  return db
    .prepare(
      `${rfbWdSelectSql(
        `AND k.verification_status IN ('pending_verify','review_required')
         AND (k.website IS NULL OR TRIM(k.website) = '')`,
      )} ORDER BY a.created_at ASC, a.id ASC LIMIT ?`,
    )
    .all(limit) as RfbWdTargetRow[];
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

// All hosts already carried by some OTHER agent's live agent_knowledge.website
// — a candidate landing on one of these is never this row's own site (mirrors
// gardssalgSharedHostCounts' role, re-implemented locally per the file
// header's scoping instruction).
function rfbWdExistingWebsiteHosts(db: ReturnType<typeof getDb>): Set<string> {
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

interface RfbWdEvidence {
  org_nr_found: boolean;
  name_found: boolean;
  place_found: boolean;
  phone_found: boolean;
  address_found: boolean;
  postnr_found: boolean;
  verified: boolean;
}

interface RfbWdHit {
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
async function tryRfbWebsiteCandidateHost(
  host: string,
  evidenceTarget: Parameters<typeof gardssalgWebsiteEvidenceMatch>[1],
  existingHosts: Set<string>,
  hostsProposedThisBatch: Set<string>,
  tried: string[],
  excludedHere: Array<{ host: string; reason: string }>,
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
    const finalReason = rfbWebsiteHostExclusionReason(finalHost);
    if (finalReason) {
      excludedHere.push({ host: finalHost, reason: finalReason });
      return null;
    }
    if (existingHosts.has(finalHost)) {
      excludedHere.push({ host: finalHost, reason: "host_already_in_use" });
      return null;
    }
    if (hostsProposedThisBatch.has(finalHost)) {
      excludedHere.push({ host: finalHost, reason: "host_already_proposed_this_batch" });
      return null;
    }
  }

  const pageText = gardssalgPageText(result.html);
  const evidence = gardssalgWebsiteEvidenceMatch(pageText, evidenceTarget);
  if (!evidence.verified) return null;

  return { host: finalHost, finalUrl: result.finalUrl, evidence };
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
  },
): void {
  db.prepare(
    `INSERT INTO agents_website_review_queue
       (id, agent_id, agent_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, updated_at)
     VALUES (@id, @agent_id, @agent_name, @candidate_url, @final_url, @evidence, @confidence,
             'website_discovery_candidate', @batch_id, 'pending', datetime('now'), datetime('now'))
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
    batch_id: entry.batch_id,
  });
}

const router = Router();

router.post("/rfb-website-discovery", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown };
  const batchId = `rfb-website-discovery-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const db = getDb();
  const notFound: string[] = [];
  const alreadyHasWebsite: Array<{ agent_id: string; agent_name: string }> = [];
  let targets: RfbWdTargetRow[] = [];

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

  const existingHosts = rfbWdExistingWebsiteHosts(db);
  const hostsProposedThisBatch = new Set<string>();

  const proposed: Array<{
    agent_id: string;
    agent_name: string;
    candidate_url: string;
    final_url: string;
    evidence: RfbWdEvidence;
    confidence: number;
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
      hit = await tryRfbWebsiteCandidateHost(host, evidenceTarget, existingHosts, hostsProposedThisBatch, tried, excludedHere);
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
      upsertRfbWebsiteReviewQueue(db, {
        agent_id: t.id,
        agent_name: t.name,
        candidate_url: candidateUrl,
        final_url: hit.finalUrl,
        evidence: hit.evidence,
        confidence,
        batch_id: batchId,
      });
      proposed.push({
        agent_id: t.id,
        agent_name: t.name,
        candidate_url: candidateUrl,
        final_url: hit.finalUrl,
        evidence: hit.evidence,
        confidence,
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
    batch_id: batchId,
    scanned: targets.length,
    proposed,
    rejected,
    already_has_website: alreadyHasWebsite,
    not_found: notFound,
  });
});

router.get("/rfb-website-review-queue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM agents_website_review_queue WHERE status = 'pending' ORDER BY created_at DESC`)
    .all();
  res.json({ success: true, count: rows.length, queue: rows });
});

export default router;

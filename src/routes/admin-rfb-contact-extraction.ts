// ─── POST /admin/rfb-contact-extraction ──────────────────────────────────────
//
// dev-requests/2026-08-07-rfb-contact-extraction.md. Extracts a corroborated
// contact email straight from a producer's OWN website and writes it to
// `agents.contact_email` — the column outreach actually sends to — for RFB
// producer agents whose contact_email is currently blank OR has been
// DNS-flagged-dead by admin-agents-contact-email-dns-check.ts
// (field_provenance.contact_email_dns_check.live === false).
//
// Schema (verified against src/database/init.ts): `agents` has NO `website`
// column — `website` lives on `agent_knowledge` (agent_id FK). Real column
// split: contact_email/org_nr/claimed_at/role/vertical_id live on `agents`;
// website/field_provenance/curated_fields live on `agent_knowledge`. Cohort
// query mirrors admin-rfb-website-discovery.ts's rfbWdSelectSql join style
// exactly (INNER JOIN agent_knowledge ON agent_id — behaviourally identical
// to a LEFT JOIN here since every row in this cohort is required to already
// carry a non-blank website).
//
// Extraction is REUSED, not reimplemented: extractGardssalgContactEmail
// (services/experience-store.ts) is a pure function shared across the
// RFB/gårdssalg boundary. extractGardssalgContactPhone is deliberately NOT
// imported — phone extraction/writing is out of scope for this slice.
//
// Fetch/orchestration hardening (per-host 429 cooldown, a run-lock returning
// 409 on a concurrent call to THIS route, a between-rows event-loop yield, a
// client-disconnect check between rows) mirrors
// POST /api/opplevelser/admin/gardssalg-contact-extraction's pattern
// (opplevelser.ts ~line 5034) — REIMPLEMENTED locally here, not imported, so
// opplevelser.ts stays completely untouched (per this slice's own scoping).
// One deliberate difference from that sibling: the spec here describes AT
// MOST ONE additional contact-page fetch per row ("an additional fetch of
// that page", singular) rather than the sibling's up-to-two
// (gardssalgContactPageLinks(html, host, 2)) — this route calls it with
// max=1.
//
// Write path mirrors admin-agents-contact-email-write.ts exactly: fill-or-
// replace-if-flagged-dead (not fill-only — a row entered this cohort BECAUSE
// its address is blank or confirmed dead, so overwriting a dead address with
// a newly corroborated one is the intended effect), curated_fields lock
// (isContactEmailCurated), claimed_at row lock, isPlatformOwnedEmailDomain +
// isSyntacticallyValidEmail write-bar (both imported directly from that
// file — it already exports them), one agent_knowledge_audit row per write.
//
// IMPORTANT — agent_knowledge_audit.changed_by has a hard
// CHECK(changed_by IN ('owner','admin','system')) constraint
// (src/database/init.ts) — this route writes changed_by:'system' (matching
// every other automated writer in the codebase) and puts the actual source
// URL + batch id in `notes` instead. The DNS-check flag
// (field_provenance.contact_email_dns_check) is read here as a cohort
// filter ONLY, never written.
//
// agent_knowledge.email — the column BOTH funnel gates actually read
// (pickPendingVerifyBatch / lokal-agent-verifier.ts's `k.email AS email`,
// and admin-outreach-candidates.ts's `k.email IS NOT NULL AND k.email !=
// ''`) — was, before this fix, never written by this route at all: only
// agents.contact_email was written, so a found+written address never
// reached either gate. applyRfbCxWrite now ALSO writes agent_knowledge.email
// (+ a field_provenance["email"] entry, source_type:"rfb_contact_extraction",
// source_url: the page the address was scraped from — merged via the SAME
// mergeFieldProvenance every other admin write path uses) whenever a write
// happens. Semantics deliberately differ per column:
//   - agents.contact_email: fill-OR-replace-if-DNS-flagged-dead (unchanged
//     from before this fix — the cohort itself is scoped to blank-or-dead).
//   - agent_knowledge.email: FILL-ONLY. A row can enter this cohort solely
//     because its agents.contact_email is dead/blank while its
//     agent_knowledge.email already carries a perfectly good, unrelated
//     value (that column has its own, independent history — e.g. written by
//     POST /admin/agents/register or PUT /admin/knowledge) — so this route
//     must never clobber an existing agent_knowledge.email, only fill a
//     genuinely empty one. Checked from the SAME fresh in-transaction
//     snapshot as the claimed_at/curated_fields re-check below.
//
// Auth: X-Admin-Key header, LOCAL requireAdmin() — this codebase's
// convention is every admin route file redefines this locally rather than
// sharing it (verified against admin-rfb-website-discovery.ts and
// admin-agents-contact-email-write.ts).
//
// Non-goals (do not build these here): phone extraction/writing; approving
// agents_website_review_queue candidates into agent_knowledge.website (a
// separate future slice); gating any outreach selector on this data (a
// separate future "Steg B"); any change to opplevelser.ts or
// src/database/init.ts.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import {
  rfbWebsiteHostExclusionReason,
  RFB_WD_SOCIAL_HOSTS,
  RFB_WD_DIRECTORY_HOSTS,
} from "./admin-rfb-website-discovery";
import {
  isPlatformOwnedEmailDomain,
  isSyntacticallyValidEmail,
  isContactEmailCurated,
} from "./admin-agents-contact-email-write";
// dev-request: agent_knowledge.email column write. The two funnel gates
// (pickPendingVerifyBatch / lokal-agent-verifier.ts, and the outreach
// candidate selector / admin-outreach-candidates.ts) both read
// agent_knowledge.email, NOT agents.contact_email — this route previously
// wrote only the latter, so a found+written address never actually reached
// either gate. mergeFieldProvenance is the SAME field_provenance merge
// every other admin write path in this codebase uses (see admin-agents.ts's
// POST /register contact-field write for the closest sibling pattern) —
// reused here rather than reinvented.
import { mergeFieldProvenance } from "./admin-knowledge";
import { extractGardssalgContactEmail, gardssalgContactPageLinks, homepageRegistrableDomain, gardssalgPageText } from "../services/experience-store";
import { fetchPage, DEFAULT_FETCH_TIMEOUT_MS } from "../services/fetch-page";
import { hostFromUrlLike, FREE_MAIL_DOMAINS } from "../services/cross-source-validator";
// dev-request 2026-09-02-rfb-innhoestet-contact-email-uten-k-email (mode
// "backfill_from_contact_email", below): the domain-coherence rule to mirror
// EXACTLY is lokal-agent-verifier.ts's computeKvalitetsGate email_own_domain
// (exact/subdomain hostname equality) — NOT
// cross-source-validator.ts's isAcceptableHomepageEmail/registrableDomain
// (registrable-domain equality, which can disagree with the verifier's rule
// on multi-level TLDs). hostnameFromUrl/emailDomain are the verifier's own
// helpers, now exported specifically so this route can reuse them instead of
// re-deriving similar-but-subtly-different logic.
import { hostnameFromUrl as verifierHostnameFromUrl, emailDomain as verifierEmailDomain } from "../agents/lokal-agent-verifier";
// dev-request 2026-08-19-kursjustering-drikkefunnel-llm-og-supply, Grep 5b —
// shared LLM-judge + deterministic-backstop contact gate (mirrors lokal#655's
// marketplace.ts pattern; see contact-candidate-judge.ts's own doc comment).
import { gateContactCandidates } from "../services/contact-candidate-judge";

// Re-exported so this route's own test file (and any future caller) can
// build a guaranteed-excluded fixture host without a second import path back
// into admin-rfb-website-discovery.ts — this route's own logic relies on
// them only indirectly, through rfbWebsiteHostExclusionReason's closure.
export { RFB_WD_SOCIAL_HOSTS, RFB_WD_DIRECTORY_HOSTS };

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

// Conservative caps — this route makes live third-party web fetches per row,
// same cost class as gårdssalg's GS_CX_DEFAULT_LIMIT/hard-cap-48 pair
// (opplevelser.ts).
export const RFB_CX_DEFAULT_LIMIT = 8;
export const RFB_CX_HARD_CAP = 48;

const RFB_CX_USER_AGENT = "Lokal-RFB-ContactExtraction/1.0";
const RFB_CX_ROW_DELAY_MS = 250;

let rfbCxRowDelayMs = RFB_CX_ROW_DELAY_MS;
/** Test-only: pass null to restore the production delay. */
export function __setRfbCxRowDelayForTesting(ms: number | null): void {
  rfbCxRowDelayMs = ms ?? RFB_CX_ROW_DELAY_MS;
}

// Kjørelås: ett kall om gangen; nummer to får 409 umiddelbart (mirrors
// gsCxRunning, opplevelser.ts — same herding rationale: an abandoned/timed-
// out apply call must never stack with a fresh one and saturate the event
// loop).
let rfbCxRunning = false;

// Per-host cooldown on a 429 (mirrors GS_CX_COOLDOWN_MS): a rate-limited host
// is parked for this long so neither the rest of THIS run nor a fresh run
// started within the window hammers it again.
const RFB_CX_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
const rfbCxHostCooldownUntil = new Map<string, number>();
/** Test-only. */
export function __resetRfbCxCooldownForTesting(): void {
  rfbCxHostCooldownUntil.clear();
}

type RfbCxFetchOutcome =
  | { kind: "ok"; html: string; finalUrl: string }
  | { kind: "cooldown_skipped"; host: string }
  | { kind: "failed" };

async function rfbCxFetchPage(url: string): Promise<RfbCxFetchOutcome> {
  const host = hostFromUrlLike(url);
  if (host) {
    const until = rfbCxHostCooldownUntil.get(host);
    if (until !== undefined && until > Date.now()) {
      return { kind: "cooldown_skipped", host };
    }
  }
  const result = await fetchPage(url, { userAgent: RFB_CX_USER_AGENT, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS });
  if (result.ok) {
    return { kind: "ok", html: result.html, finalUrl: result.finalUrl };
  }
  if (result.reason === "http_429" && host) {
    rfbCxHostCooldownUntil.set(host, Date.now() + RFB_CX_COOLDOWN_MS);
  }
  return { kind: "failed" };
}

interface RfbCxTargetRow {
  id: string;
  name: string;
  contact_email: string | null;
  org_nr: string | null;
  claimed_at: string | null;
  website: string;
  field_provenance: string | null;
  curated_fields: string | null;
}

// Cohort SQL — same join style as admin-rfb-website-discovery.ts's
// rfbWdSelectSql: `agents a JOIN agent_knowledge k ON k.agent_id = a.id`.
// Every row selected here is REQUIRED to already carry a non-blank website
// (unlike the sibling's blank-website cohort), so an INNER JOIN and a LEFT
// JOIN + `k.website IS NOT NULL` filter are behaviourally identical; INNER
// JOIN is used to mirror the sibling file's literal join style exactly.
function rfbCxSelectSql(extraWhere: string): string {
  return `
    SELECT a.id AS id, a.name AS name, a.contact_email AS contact_email, a.org_nr AS org_nr,
           a.claimed_at AS claimed_at,
           k.website AS website, k.field_provenance AS field_provenance, k.curated_fields AS curated_fields
      FROM agents a
      JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.role = 'producer'
       AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
       AND k.website IS NOT NULL AND TRIM(k.website) != ''
       ${extraWhere}
  `;
}

// Fill-or-replace-if-flagged-dead: contact_email is blank, OR the DNS check
// (admin-agents-contact-email-dns-check.ts) has stamped it dead. Read as a
// cohort filter only — this route never writes contact_email_dns_check.
const RFB_CX_ELIGIBLE_WHERE = `
  AND (
    TRIM(COALESCE(a.contact_email,'')) = ''
    OR json_extract(k.field_provenance,'$.contact_email_dns_check.live') = 0
  )
`;

function selectRfbCxTargets(db: ReturnType<typeof getDb>, limit: number): RfbCxTargetRow[] {
  return db
    .prepare(`${rfbCxSelectSql(RFB_CX_ELIGIBLE_WHERE)} ORDER BY a.created_at ASC, a.id ASC LIMIT ?`)
    .all(limit) as RfbCxTargetRow[];
}

function selectRfbCxTargetsByIds(db: ReturnType<typeof getDb>, ids: string[]): RfbCxTargetRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`${rfbCxSelectSql(`${RFB_CX_ELIGIBLE_WHERE} AND a.id IN (${placeholders})`)}`)
    .all(...ids) as RfbCxTargetRow[];
  // Preserve caller order, same convention as the sibling discovery route's
  // agentIds handling.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is RfbCxTargetRow => !!r);
}

// ─── mode: "backfill_from_contact_email" cohort ────────────────────────────
//
// dev-request 2026-09-02-rfb-innhoestet-contact-email-uten-k-email (option
// A): 58+ rows carry a harvested, domain-coherent agents.contact_email (from
// a much earlier live-website scrape) but a blank agent_knowledge.email — the
// column BOTH funnel gates actually read. These rows are invisible to
// RFB_CX_ELIGIBLE_WHERE above (contact_email is already non-blank so the
// first clause excludes them, and they were never DNS-checked as dead so the
// second clause doesn't match either). This is a pure re-classification/
// backfill of an address ALREADY on file — no page fetch, no new scrape.
//
// Cohort requires field_provenance.contact_email_dns_check.live = 1
// (explicitly DNS-confirmed alive) rather than merely "not flagged dead" —
// a never-DNS-checked row (json_extract returns NULL, not 0) must NOT be
// eligible, since an explicit-1 check is the only way to guarantee AC3
// (liveness actually verified) with no live network call in this route.
const RFB_CX_BACKFILL_ELIGIBLE_WHERE = `
  AND TRIM(COALESCE(k.email,'')) = ''
  AND TRIM(COALESCE(a.contact_email,'')) != ''
  AND json_extract(k.field_provenance,'$.contact_email_dns_check.live') = 1
`;

function selectRfbCxBackfillTargets(db: ReturnType<typeof getDb>, limit: number): RfbCxTargetRow[] {
  return db
    .prepare(`${rfbCxSelectSql(RFB_CX_BACKFILL_ELIGIBLE_WHERE)} ORDER BY a.created_at ASC, a.id ASC LIMIT ?`)
    .all(limit) as RfbCxTargetRow[];
}

function selectRfbCxBackfillTargetsByIds(db: ReturnType<typeof getDb>, ids: string[]): RfbCxTargetRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`${rfbCxSelectSql(`${RFB_CX_BACKFILL_ELIGIBLE_WHERE} AND a.id IN (${placeholders})`)}`)
    .all(...ids) as RfbCxTargetRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is RfbCxTargetRow => !!r);
}

// source_type for backfill-mode writes specifically — distinct from
// RFB_CX_PROVENANCE_SOURCE_TYPE (fresh scrape) so these writes are
// distinguishable in field_provenance.email as "copied from an
// already-harvested agents.contact_email", per the dev-request's AC1.
const RFB_CX_BACKFILL_PROVENANCE_SOURCE_TYPE = "harvest_contact_email";

// Domain-coherence check mirroring lokal-agent-verifier.ts's
// computeKvalitetsGate email_own_domain EXACTLY: own-domain-or-subdomain
// match against the website's host (either direction — subdomain email on a
// bare-domain site, or vice versa), OR the email's domain is a known
// free-mail/ISP provider.
function backfillEmailOwnDomain(email: string, website: string): boolean {
  const websiteHost = verifierHostnameFromUrl(website);
  const eDom = verifierEmailDomain(email);
  const emailMatchesSite = !!(
    websiteHost &&
    eDom &&
    (eDom === websiteHost || eDom.endsWith("." + websiteHost) || websiteHost.endsWith("." + eDom))
  );
  const isFreeMail = !!(eDom && FREE_MAIL_DOMAINS.includes(eDom));
  return emailMatchesSite || isFreeMail;
}

type ItemOutcome =
  | "written"
  | "no_contact_found"
  | "skippedCurated"
  | "skippedLocked"
  | "rejected_platform_domain"
  | "rejected_invalid_syntax"
  | "cooldown_skipped"
  | "fetch_failed"
  | "host_excluded"
  | "not_found"
  // backfill_from_contact_email mode only (dev-request
  // 2026-09-02-rfb-innhoestet-contact-email-uten-k-email): a.contact_email
  // fails the domain-coherence check email_own_domain mirrors — neither an
  // own-domain/subdomain match against k.website nor a FREE_MAIL_DOMAINS hit.
  | "rejected_domain_mismatch";

interface ResultItem {
  agent_id: string;
  agent_name?: string;
  outcome: ItemOutcome;
  email?: string | null;
  // "embedded_same_domain" added by dev-request 2026-08-08-gardssalg-brreg-
  // verify-og-embedded-evidens: the shared extractor gained a lowest-priority
  // same-domain tier read from script-embedded JSON (sitebuilder SPAs).
  // "mailto_other_domain" / "text_other_domain" added by dev-request
  // kontaktadresse-domeneblind-mailto-og-tekst: a foreign-domain address is
  // still returned (never silently dropped) but flagged for review instead
  // of trusted outright.
  email_source?:
    | "mailto"
    | "text_same_domain"
    | "text_contact_page"
    | "embedded_same_domain"
    | "mailto_other_domain"
    | "text_other_domain";
  source_url?: string;
  old_value?: string | null;
  detail?: string;
}

// source_type recorded on the agent_knowledge.email field_provenance entry
// this route writes — identifies this route as the source, distinct from
// "agent_registration" (POST /register) / "website_homepage" (PUT
// /admin/knowledge) which write the SAME column via other paths.
const RFB_CX_PROVENANCE_SOURCE_TYPE = "rfb_contact_extraction";

/**
 * Writes ONE agent's contact_email (agents table) AND, fill-only,
 * agent_knowledge.email (+ field_provenance). Re-reads claimed_at,
 * curated_fields AND the current agent_knowledge.email from a FRESH
 * snapshot immediately before writing, inside its own transaction — mirrors
 * admin-agents-contact-email-write.ts's applyContactEmail exactly, including
 * the race-caught re-check (a row locked/curated between this batch's scan
 * and this row's write is left alone).
 *
 * The agents.contact_email UPDATE + its agent_knowledge_audit row are
 * skipped when newEmail is byte-identical to the row's current
 * contact_email (mirrors applyContactEmail's own skipped_unchanged
 * convention) — genuinely a no-op in normal (scrape) mode, and BY
 * CONSTRUCTION always the case in mode:"backfill_from_contact_email" (that
 * mode copies an already-on-file agents.contact_email into
 * agent_knowledge.email, so newEmail === cur.contact_email on every call).
 * Skipping avoids fabricating an "X changed to X" row in an audit trail
 * admin-agent-audit.ts documents as the Daniel-only view of real
 * profile-update history. The fill-only agent_knowledge.email write below
 * still runs regardless, and the caller-visible outcome stays "written"
 * either way — this changes DB-level audit noise only, never the API
 * response.
 *
 * Exported (dev-request 2026-09-01-rfb-pending-verify-unpark-lever, AC6): so
 * the write-site no-op regression test for this function's data_enriched_at
 * stamp can call it directly instead of round-tripping the whole HTTP batch
 * shape — no behavior change, purely a testability export.
 */
export function applyRfbCxWrite(
  db: ReturnType<typeof getDb>,
  agentId: string,
  newEmail: string,
  sourceUrl: string,
  batchId: string,
  sourceType: string = RFB_CX_PROVENANCE_SOURCE_TYPE,
): { outcome: "written" | "skippedLocked" | "skippedCurated"; oldValue?: string | null } {
  const tx = db.transaction((): { outcome: "written" | "skippedLocked" | "skippedCurated"; oldValue?: string | null } => {
    const cur = db
      .prepare(
        `SELECT a.claimed_at AS claimed_at, a.contact_email AS contact_email,
                k.curated_fields AS curated_fields, k.email AS knowledge_email,
                k.field_provenance AS field_provenance
           FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(agentId) as {
        claimed_at: string | null;
        contact_email: string | null;
        curated_fields: string | null;
        knowledge_email: string | null;
        field_provenance: string | null;
      } | undefined;

    if (!cur) return { outcome: "skippedLocked" }; // vanished mid-batch — treat as untouchable, never write
    if (cur.claimed_at) return { outcome: "skippedLocked", oldValue: cur.contact_email };
    if (isContactEmailCurated(cur.curated_fields)) return { outcome: "skippedCurated", oldValue: cur.contact_email };

    // Genuinely-unchanged guard (mirrors admin-agents-contact-email-write.ts's
    // skipped_unchanged convention): in the normal (scrape) mode newEmail is
    // freshly discovered and this is almost always a real change, but in
    // mode:"backfill_from_contact_email" newEmail is BY CONSTRUCTION identical
    // to cur.contact_email (that mode's entire premise is copying an
    // already-on-file address into agent_knowledge.email) — writing the SAME
    // value back to agents.contact_email and inserting an
    // agent_knowledge_audit row claiming it "changed" from X to X would
    // fabricate audit noise on an endpoint admin-agent-audit.ts documents as
    // the Daniel-only view of real profile-update history, and would break
    // the dev-request's rollback contract (resetting k.email for
    // provenance:harvest_contact_email rows must be sufficient — a spurious
    // audit row is exactly the "something else" that wouldn't clean up).
    // Skip ONLY the contact_email column write + its audit row; the
    // fill-only agent_knowledge.email write below still runs, and the
    // caller-visible outcome stays "written" either way.
    if (newEmail !== cur.contact_email) {
      db.prepare(`UPDATE agents SET contact_email = ? WHERE id = ?`).run(newEmail, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'contact_email', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.contact_email, newEmail, `rfb-contact-extraction ${sourceUrl} batch:${batchId}`);
    }

    // agent_knowledge.email — FILL-ONLY (see header comment). A row already
    // carrying a non-empty value here keeps it untouched; only a genuinely
    // empty/blank value gets filled with the address this route just
    // corroborated, alongside a field_provenance entry recording where it
    // came from.
    if (!cur.knowledge_email || !cur.knowledge_email.trim()) {
      const nowIso = new Date().toISOString();
      let existingProv: Record<string, unknown> = {};
      if (cur.field_provenance) {
        try {
          const parsed = JSON.parse(cur.field_provenance);
          if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
        } catch {
          /* tolerate junk, mirrors every other mergeFieldProvenance call site */
        }
      }
      const mergedProv = mergeFieldProvenance(existingProv, {
        email: [{ value: newEmail, source_type: sourceType, source_url: sourceUrl, fetched_at: nowIso }],
      });
      // dev-request 2026-09-01-rfb-pending-verify-unpark-lever (Daniel Alternativ B,
      // write-site (c)): this fill-only branch is already gated above by
      // `if (!cur.knowledge_email || !cur.knowledge_email.trim())` — never a no-op.
      // Same nowIso already used for updated_at, no separate Date computation.
      db.prepare(`UPDATE agent_knowledge SET email = ?, field_provenance = ?, updated_at = ?, data_enriched_at = ? WHERE agent_id = ?`).run(
        newEmail,
        JSON.stringify(mergedProv),
        nowIso,
        nowIso,
        agentId,
      );
    }

    return { outcome: "written", oldValue: cur.contact_email };
  });
  return tx();
}

const router = Router();

router.post("/rfb-contact-extraction", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // Kjørelås checked/set synchronously, before any await — a concurrent call
  // fired right after this one must see the lock. The `finally` below is the
  // only thing that releases it, so a thrown error never leaves it hanging.
  if (rfbCxRunning) {
    res.status(409).json({ error: "run_in_progress", detail: "en rfb-contact-extraction-kjøring pågår allerede — vent til den er ferdig" });
    return;
  }
  rfbCxRunning = true;

  try {
    const body = (req.body ?? {}) as { limit?: unknown; agentIds?: unknown; apply?: unknown; mode?: unknown };
    const apply =
      body.apply === true ||
      body.apply === 1 ||
      body.apply === "1" ||
      body.apply === "true" ||
      req.query?.apply === "1" ||
      req.query?.apply === "true";
    const dryRun = !apply;
    // dev-request 2026-09-02-rfb-innhoestet-contact-email-uten-k-email
    // (option A): mode:"backfill_from_contact_email" is a pure DB
    // re-classification/backfill of an address ALREADY on file
    // (agents.contact_email) — no page fetch, different cohort, different
    // per-row checks (see the isBackfillMode branch below). Any other/absent
    // mode value keeps today's normal scrape flow completely untouched.
    const isBackfillMode = body.mode === "backfill_from_contact_email";

    const batchId = `rfb-contact-extraction-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
    const db = getDb();

    let targets: RfbCxTargetRow[] = [];
    const results: ResultItem[] = [];

    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      const ids = (body.agentIds as unknown[])
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim());
      if (ids.length > RFB_CX_HARD_CAP) {
        res.status(400).json({ error: `Too many agentIds (max ${RFB_CX_HARD_CAP} per call)` });
        return;
      }
      targets = isBackfillMode ? selectRfbCxBackfillTargetsByIds(db, ids) : selectRfbCxTargetsByIds(db, ids);
      const foundIds = new Set(targets.map((t) => t.id));
      for (const id of ids) {
        if (!foundIds.has(id)) results.push({ agent_id: id, outcome: "not_found" });
      }
    } else {
      const limit = Math.min(
        typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : RFB_CX_DEFAULT_LIMIT,
        RFB_CX_HARD_CAP,
      );
      targets = isBackfillMode ? selectRfbCxBackfillTargets(db, limit) : selectRfbCxTargets(db, limit);
    }

    if (isBackfillMode) {
      // No page fetch — the email is already known from a.contact_email, so
      // no rfbCxRowDelayMs pacing and no client-disconnect check either (both
      // exist solely to be polite to third-party hosts / bail out of a
      // long-running live-fetch loop; neither applies to a pure DB pass).
      for (const t of targets) {
        if (t.claimed_at) {
          results.push({ agent_id: t.id, agent_name: t.name, outcome: "skippedLocked" });
          continue;
        }
        if (isContactEmailCurated(t.curated_fields)) {
          results.push({ agent_id: t.id, agent_name: t.name, outcome: "skippedCurated" });
          continue;
        }

        const contactEmail = (t.contact_email || "").trim();
        if (isPlatformOwnedEmailDomain(contactEmail)) {
          results.push({ agent_id: t.id, agent_name: t.name, outcome: "rejected_platform_domain", email: contactEmail });
          continue;
        }
        if (!isSyntacticallyValidEmail(contactEmail)) {
          results.push({ agent_id: t.id, agent_name: t.name, outcome: "rejected_invalid_syntax", email: contactEmail });
          continue;
        }
        if (!backfillEmailOwnDomain(contactEmail, t.website)) {
          results.push({ agent_id: t.id, agent_name: t.name, outcome: "rejected_domain_mismatch", email: contactEmail });
          continue;
        }

        if (dryRun) {
          results.push({
            agent_id: t.id, agent_name: t.name, outcome: "written",
            email: contactEmail, source_url: t.website, old_value: t.contact_email,
          });
          continue;
        }

        // source_url = t.website (the producer's own site), per the
        // dev-request's spec — NOT the (unrelated) location the address was
        // originally scraped from.
        const written = applyRfbCxWrite(db, t.id, contactEmail, t.website, batchId, RFB_CX_BACKFILL_PROVENANCE_SOURCE_TYPE);
        if (written.outcome === "written") {
          results.push({
            agent_id: t.id, agent_name: t.name, outcome: "written",
            email: contactEmail, source_url: t.website, old_value: written.oldValue,
          });
        } else {
          results.push({ agent_id: t.id, agent_name: t.name, outcome: written.outcome, old_value: written.oldValue });
        }
      }

      const backfillCounts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {});

      res.json({
        success: true,
        dry_run: dryRun,
        batch_id: batchId,
        scanned: targets.length,
        aborted_client_disconnect: false,
        counts: backfillCounts,
        results,
      });
      return;
    }

    let clientDisconnected = false;
    for (const t of targets) {
      // Client-disconnect check BEFORE the delay and BEFORE any work on this
      // row — an abandoned run must abort cleanly, not complete silently.
      if ((req as any).aborted === true || res.writableEnded || (res as any).destroyed === true) {
        clientDisconnected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, rfbCxRowDelayMs));

      const host = hostFromUrlLike(t.website);
      const exclusionReason = host ? rfbWebsiteHostExclusionReason(host) : "invalid_website_url";
      if (exclusionReason) {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "host_excluded", detail: exclusionReason });
        continue;
      }

      // Locked/curated rows are skipped BEFORE any fetch — no point spending
      // a live network call on a row this route will refuse to write to
      // anyway. (Re-checked from a fresh snapshot again at write time below,
      // guarding against a race during this batch's own live-fetch window.)
      if (t.claimed_at) {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "skippedLocked" });
        continue;
      }
      if (isContactEmailCurated(t.curated_fields)) {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "skippedCurated" });
        continue;
      }

      const frontOutcome = await rfbCxFetchPage(t.website);
      if (frontOutcome.kind === "cooldown_skipped") {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "cooldown_skipped", detail: frontOutcome.host });
        continue;
      }
      if (frontOutcome.kind === "failed") {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "fetch_failed" });
        continue;
      }

      const front = { html: frontOutcome.html, finalUrl: frontOutcome.finalUrl };
      const finalHost = hostFromUrlLike(front.finalUrl) || host || "";
      const homeDomain = homepageRegistrableDomain(t.website);

      // Contact-ish subpage FIRST (that's where the info is authoritative),
      // front page as fallback — mirrors gårdssalg-contact-extraction's page
      // ordering. AT MOST ONE additional fetch (max=1): the spec's wording
      // ("an additional fetch of that page", singular) is one page, unlike
      // the sibling's up-to-two.
      const pages: Array<{ url: string; html: string; contactish: boolean }> = [];
      for (const sub of gardssalgContactPageLinks(front.html, finalHost, 1)) {
        const subOutcome = await rfbCxFetchPage(sub);
        if (subOutcome.kind === "ok") pages.push({ url: subOutcome.finalUrl, html: subOutcome.html, contactish: true });
        // A cooldown/failed subpage is simply not added — the front page
        // (already in hand) still stands as a fallback source.
      }
      pages.push({ url: front.finalUrl, html: front.html, contactish: false });

      let email: ReturnType<typeof extractGardssalgContactEmail> = null;
      let emailUrl = "";
      let emailPageHtml = "";
      for (const pg of pages) {
        email = extractGardssalgContactEmail(pg.html, homeDomain, pg.contactish);
        if (email) {
          emailUrl = pg.url;
          emailPageHtml = pg.html;
          break;
        }
      }

      if (!email) {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "no_contact_found" });
        continue;
      }

      if (!isSyntacticallyValidEmail(email.email)) {
        results.push({
          agent_id: t.id, agent_name: t.name, outcome: "rejected_invalid_syntax",
          email: email.email, email_source: email.source, source_url: emailUrl,
        });
        continue;
      }
      if (isPlatformOwnedEmailDomain(email.email)) {
        results.push({
          agent_id: t.id, agent_name: t.name, outcome: "rejected_platform_domain",
          email: email.email, email_source: email.source, source_url: emailUrl,
        });
        continue;
      }

      // Grep 5b LLM-judge contact gate (dev-request 2026-08-19-kursjustering-
      // drikkefunnel-llm-og-supply): every candidate — dry-run preview
      // included, so a preview never promises a write the gate would then
      // refuse — must clear the shared backstop+LLM-judge gate before it is
      // eligible to be reported/written as "found". A rejected candidate is
      // treated EXACTLY like extractGardssalgContactEmail having found
      // nothing: fail-closed, no write, no throw.
      const gated = await gateContactCandidates({
        businessName: t.name,
        sourceContext: gardssalgPageText(emailPageHtml),
        candidateEmail: email.email,
      });
      if (!gated.email) {
        console.log(
          `[rfb-contact-extraction] ${t.id} (${t.name}) email candidate "${email.email}" REJECTED by contact gate for ${emailUrl} — ${gated.emailRejectedReason ?? "unknown reason"}; not written`
        );
        results.push({ agent_id: t.id, agent_name: t.name, outcome: "no_contact_found" });
        continue;
      }
      const gatedEmail = gated.email;

      if (dryRun) {
        results.push({
          agent_id: t.id, agent_name: t.name, outcome: "written",
          email: gatedEmail, email_source: email.source, source_url: emailUrl, old_value: t.contact_email,
        });
        continue;
      }

      const written = applyRfbCxWrite(db, t.id, gatedEmail, emailUrl, batchId);
      if (written.outcome === "written") {
        results.push({
          agent_id: t.id, agent_name: t.name, outcome: "written",
          email: gatedEmail, email_source: email.source, source_url: emailUrl, old_value: written.oldValue,
        });
      } else {
        results.push({ agent_id: t.id, agent_name: t.name, outcome: written.outcome, old_value: written.oldValue });
      }
    }

    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      dry_run: dryRun,
      batch_id: batchId,
      scanned: targets.length,
      aborted_client_disconnect: clientDisconnected,
      counts,
      results,
    });
  } finally {
    rfbCxRunning = false;
  }
});

export default router;

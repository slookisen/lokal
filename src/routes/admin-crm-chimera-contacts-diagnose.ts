// ─── Admin: GET /admin/crm-chimera-contacts-diagnose ───────────────────────
//
// dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding — slice 3, the
// "diagnose the remaining 13 crm_contacts rows" half. Slices 1+2 (PR #405,
// #407) fixed the code-level root cause (classifyEmail's platform-name
// guard) and cleared the chimera agent_knowledge row's Bondens-Kolonial
// contamination. What both of those slices deliberately did NOT touch:
// crm_contacts rows whose agent_id still points at the chimera
// (2b5fc7a6-b446-4bea-8c2d-21315c6c6e17, agents.name "Rett fra Bonden" — the
// platform's own name, role 'logistics') — a leftover "house bucket" for
// contacts nobody has ever classified.
//
// ── THIS IS A DIAGNOSIS TOOL, NOT A CORRECTION TOOL — NO APPLY MODE AT ALL ──
// Unlike sibling admin-crm-chimera-agent-clear.ts (which has a real
// apply:true write path), this endpoint accepts NO apply/mutate parameter
// of any kind and issues ZERO writes — every statement below is a SELECT.
// Whether/when to actually reassign any of these contacts is a follow-up
// decision (a future slice, or Daniel) — explicitly out of scope here, per
// the dev-request's own framing ("deserves a dedicated dry-run-first pass").
//
// Per-contact classification (dev-request spec item 2):
//   - noreply/no-reply/system/automated sender pattern (GitHub/Google
//     noreply etc.) -> proposed type: "system", agent_id: null.
//   - Otherwise, a confident real-agent match via the SAME matching tiers
//     classifyEmail() (crm-service.ts) already uses for this exact class of
//     problem — exact agents.contact_email, exact agent_knowledge.email,
//     then domain match (skipping freemail domains) — plus one additional
//     tier not in classifyEmail: an exact 9-digit Norwegian org-nr found in
//     the contact's free-text `organization` field against agents.org_nr
//     (the same org_nr correlation used by the agents_org_nr_* backfill
//     machinery elsewhere in the codebase). -> proposed type: "producer",
//     agent_id: <match>.
//   - No confident match on any of the above -> proposed type: "unknown",
//     agent_id: null, flagged for manual review. NEVER a guess.
//
// Why this does NOT call crmService.classifyEmail() directly, despite reuse
// being requested: classifyEmail()'s platform-name-match branch
// (blockIfPlatformNameAgent) calls this.logAction(), which INSERTs into
// crm_actions as a side effect — a real write. This route's job is a strict
// zero-write guarantee (acceptance criterion 3), so calling a method that
// can write anywhere in its call graph is unsafe even though the write
// would usually be a no-op for these particular contacts. Instead, the
// exact-match / domain-match tiers are reimplemented here as plain SELECTs
// (see resolveProducerMatch below), deliberately kept in the same order and
// with the same freemail-skip and platform-name-agent exclusions as
// classifyEmail, so the proposal this endpoint reports is the same one
// classifyEmail would have produced — just without the ability to write.
//
// Why NOT a pure name-similarity tier: admin-wrong-entity-retro-sweep.ts
// (this route's closest sibling) already establishes the precedent of
// explicitly skipping heuristics with a high false-positive risk rather
// than fabricating a scoring function from memory (see its
// SKIPPED_HEURISTICS). A contact's freetext `name`/`organization` vs.
// agents.name is included in every proposal's `evidence` block for a human
// to read, but is never, by itself, enough to produce a "producer" proposal
// — only exact-email / domain / org_nr do that. This keeps "never guess"
// literal.
//
// Scope guard: exactly the crm_contacts rows on
// agent_id = '2b5fc7a6-b446-4bea-8c2d-21315c6c6e17' — no sweep over other
// agents' contacts. crm_contacts.agent_id is schema-enforced rfb-only
// (trg_crm_contacts_agent_vertical_{ins,upd} in database/init.ts), so every
// row this endpoint reads is guaranteed vertical 'rfb' and candidate matches
// are looked up against the `agents` table only (no experiences/dental
// dispatch needed, unlike classifyEmail's general form).
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getConfig } from "../config/vertical-config";
import { FREE_MAIL_DOMAINS, hostFromUrlLike, registrableDomain } from "../services/cross-source-validator";
import { CHIMERA_AGENT_ID } from "./admin-crm-chimera-agent-clear";

const router = Router();

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

const FREEMAIL_SET: ReadonlySet<string> = new Set(FREE_MAIL_DOMAINS);

// GitHub's per-notification address convention is
// "<id>+<login>@users.noreply.github.com" — the localpart varies per user,
// so the localpart regex below can't catch it; the "noreply" label sitting
// inside the DOMAIN is the actual signal. Checked independently of the
// localpart regex (see isSystemSender below).
function domainHasNoreplyLabel(domain: string): boolean {
  return domain.split(".").includes("noreply");
}

// Local-part conventions for automated/system senders. Anchored (not a
// substring match) so a real person named e.g. "systemad@somefarm.no" isn't
// swept up — matches the localpart itself, optionally followed by a
// separator + suffix (e.g. "noreply-comments", "notifications+123").
const SYSTEM_LOCALPART_RE =
  /^(no-?reply|donotreply|do-?not-?reply|notifications?|mailer-daemon|postmaster|webmaster|automated?|alerts?|bounces?|system)([._+-].*)?$/i;

interface SystemSenderMatch {
  matched: boolean;
  matched_by?: "local_part_pattern" | "noreply_subdomain";
}

function isSystemSender(localPart: string, domain: string): SystemSenderMatch {
  if (SYSTEM_LOCALPART_RE.test(localPart)) return { matched: true, matched_by: "local_part_pattern" };
  if (domain && domainHasNoreplyLabel(domain)) return { matched: true, matched_by: "noreply_subdomain" };
  return { matched: false };
}

// A bare 9-digit run — the shape of a Norwegian organisasjonsnummer — found
// inside a contact's free-text `organization` (or, failing that, `name`)
// field. Word-boundary-delimited so it doesn't match a 9-digit substring of
// a longer number.
const ORG_NR_RE = /\b(\d{9})\b/;

function extractOrgNr(...texts: Array<string | null>): string | null {
  for (const t of texts) {
    if (!t) continue;
    const m = ORG_NR_RE.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

interface AgentCandidate {
  id: string;
  name: string;
}

/**
 * Same guard classifyEmail() applies (crm-service.ts, fix 2 of this dev-
 * request's slice 1): a matched agent whose name equals the vertical's own
 * platform display_name is the house-bucket itself, never a real match.
 * Read-only re-implementation — no logAction call, unlike classifyEmail's
 * blockIfPlatformNameAgent (see file header for why).
 */
function isPlatformNameAgent(db: ReturnType<typeof getDb>, agentName: string): boolean {
  let displayName: string | null = null;
  try {
    displayName = getConfig("rfb").display_name || null;
  } catch (e) {
    console.error("[crm-chimera-contacts-diagnose] getConfig('rfb') failed, guard skipped:", e);
    return false;
  }
  if (!displayName) return false;
  return agentName.trim().toLowerCase() === displayName.trim().toLowerCase();
}

type MatchTier = "exact_contact_email" | "exact_knowledge_email" | "contact_email_domain" | "website_domain" | "org_nr";

interface ProducerMatch {
  tier: MatchTier;
  agent: AgentCandidate;
  detail: Record<string, unknown>;
}

/**
 * The read-only equivalent of classifyEmail()'s rfb-vertical matching path,
 * plus one additional org_nr tier — see file header. Returns the FIRST
 * confident match found, in the same tier order classifyEmail uses (exact
 * email tiers before domain tiers), tried after the exact-email tiers.
 * Every candidate is filtered to is_active=1, excludes the chimera agent id
 * itself, and excludes any agent that IS the platform-name house-bucket
 * (defense in depth — this contact set is already known to be on the
 * chimera specifically, but a future re-run of this same tool against a
 * different agent_id should not silently match a DIFFERENT house-bucket).
 */
function resolveProducerMatch(
  db: ReturnType<typeof getDb>,
  lowerEmail: string,
  domain: string,
  organization: string | null,
  contactName: string | null,
): ProducerMatch | null {
  const accept = (row: AgentCandidate | undefined): AgentCandidate | null => {
    if (!row) return null;
    if (row.id === CHIMERA_AGENT_ID) return null;
    if (isPlatformNameAgent(db, row.name)) return null;
    return row;
  };

  // 1. Exact match on agents.contact_email
  const exact = accept(
    db
      .prepare("SELECT id, name FROM agents WHERE LOWER(contact_email) = ? AND is_active = 1 LIMIT 1")
      .get(lowerEmail) as AgentCandidate | undefined,
  );
  if (exact) return { tier: "exact_contact_email", agent: exact, detail: { matched_email: lowerEmail } };

  // 1b. Exact match on agent_knowledge.email
  const exactKnowledge = accept(
    db
      .prepare(
        "SELECT a.id, a.name FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id WHERE LOWER(k.email) = ? AND a.is_active = 1 LIMIT 1",
      )
      .get(lowerEmail) as AgentCandidate | undefined,
  );
  if (exactKnowledge) return { tier: "exact_knowledge_email", agent: exactKnowledge, detail: { matched_email: lowerEmail } };

  // 2. Domain match on agents.contact_email (skip freemail domains — a
  // shared @gmail.com proves nothing about which org the sender belongs to)
  if (domain && !FREEMAIL_SET.has(domain)) {
    const byDomain = accept(
      db
        .prepare("SELECT id, name FROM agents WHERE LOWER(contact_email) LIKE ? AND is_active = 1 LIMIT 1")
        .get(`%@${domain}`) as AgentCandidate | undefined,
    );
    if (byDomain) return { tier: "contact_email_domain", agent: byDomain, detail: { matched_domain: domain } };

    // 2b. Domain match on agent_knowledge.website's registrable domain — not
    // part of classifyEmail's own tiers, but the same LIKE-prefilter /
    // JS-verify shape classifyEmailAgainstProviders (crm-service.ts) uses
    // for its hjemmeside tier, adapted here against agents' website field.
    const websiteCandidates = db
      .prepare(
        `SELECT a.id, a.name, k.website FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
          WHERE a.is_active = 1 AND k.website IS NOT NULL AND k.website LIKE ? LIMIT 25`,
      )
      .all(`%${domain}%`) as Array<AgentCandidate & { website: string }>;
    for (const c of websiteCandidates) {
      const host = hostFromUrlLike(c.website);
      if (!host) continue;
      if (registrableDomain(host) !== domain) continue;
      const accepted = accept({ id: c.id, name: c.name });
      if (accepted) return { tier: "website_domain", agent: accepted, detail: { matched_domain: domain, website: c.website } };
    }
  }

  // 3. org_nr correlation — a 9-digit organisasjonsnummer embedded in the
  // contact's free-text organization (or, failing that, name) field,
  // matched exactly against agents.org_nr.
  const orgNr = extractOrgNr(organization, contactName);
  if (orgNr) {
    const byOrgNr = accept(
      db.prepare("SELECT id, name FROM agents WHERE org_nr = ? AND is_active = 1 LIMIT 1").get(orgNr) as
        | AgentCandidate
        | undefined,
    );
    if (byOrgNr) return { tier: "org_nr", agent: byOrgNr, detail: { org_nr: orgNr } };
  }

  return null;
}

interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  domain: string | null;
  organization: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── READ-ONLY / DIAGNOSIS ONLY — no apply param exists, no writes ever ──
  try {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT id, email, name, domain, organization, status, first_seen_at, last_seen_at
           FROM crm_contacts
          WHERE agent_id = ?
       ORDER BY id`,
      )
      .all(CHIMERA_AGENT_ID) as ContactRow[];

    const summary = { system: 0, producer_match: 0, unknown: 0 };

    const proposals = rows.map((row) => {
      const lowerEmail = row.email.trim().toLowerCase();
      const atIdx = lowerEmail.lastIndexOf("@");
      const localPart = atIdx >= 0 ? lowerEmail.slice(0, atIdx) : lowerEmail;
      const emailDomain = atIdx >= 0 ? lowerEmail.slice(atIdx + 1) : (row.domain || "").trim().toLowerCase();

      const systemMatch = isSystemSender(localPart, emailDomain);
      if (systemMatch.matched) {
        summary.system++;
        return {
          contact_id: row.id,
          email: row.email,
          name: row.name,
          organization: row.organization,
          status: row.status,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
          proposed_type: "system" as const,
          proposed_agent_id: null,
          flagged_for_manual_review: false,
          evidence: {
            reason: "noreply/system/automated sender pattern",
            matched_by: systemMatch.matched_by,
            local_part: localPart,
            email_domain: emailDomain,
          },
        };
      }

      const match = resolveProducerMatch(db, lowerEmail, emailDomain, row.organization, row.name);
      if (match) {
        summary.producer_match++;
        return {
          contact_id: row.id,
          email: row.email,
          name: row.name,
          organization: row.organization,
          status: row.status,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
          proposed_type: "producer" as const,
          proposed_agent_id: match.agent.id,
          flagged_for_manual_review: false,
          evidence: {
            reason: `confident match via ${match.tier}`,
            match_tier: match.tier,
            matched_agent_id: match.agent.id,
            matched_agent_name: match.agent.name,
            ...match.detail,
            // Informational only — never the basis for the match itself
            // (see file header on why pure name-similarity is not a tier).
            contact_name_or_organization: row.name || row.organization || null,
          },
        };
      }

      summary.unknown++;
      return {
        contact_id: row.id,
        email: row.email,
        name: row.name,
        organization: row.organization,
        status: row.status,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        proposed_type: "unknown" as const,
        proposed_agent_id: null,
        flagged_for_manual_review: true,
        evidence: {
          reason: "no confident match on exact email, contact-email domain, website domain, or org_nr — never guessed",
          email_domain: emailDomain,
          checked_org_nr: extractOrgNr(row.organization, row.name),
          contact_name_or_organization: row.name || row.organization || null,
        },
      };
    });

    res.json({
      success: true,
      agent_id: CHIMERA_AGENT_ID,
      contact_count: rows.length,
      summary,
      proposals,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;

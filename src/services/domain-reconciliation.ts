// ─── Domain-incoherent reconciliation (dev-request 2026-07-12-rfb-enrichment-
// pool-refill-and-waste-reduction, item 3, 2026-07-13) ──────────────────────
//
// Systematizes the manual 2026-07-05 fix into a repeatable, audited
// classifier + sweep over the review_required/data_insufficient cohort
// (~84 agents today). Two historically-confirmed bug shapes:
//
//   (a) stale_knowledge_website — agent_knowledge.website points at an
//       unrelated company/aggregator while agents.url is correct (19-agent
//       shape, fixed by hand on 07-05 via PUT /admin/knowledge).
//   (b) circular_scramble_detected — agents.url holds a DIFFERENT agent's
//       real URL while agent_knowledge.website is correct for every agent
//       involved (5-agent circular chain shape, fixed by hand on 07-05 via
//       PATCH /agents/:id).
//
// Reuses the existing domain-coherence/fuzzy-match toolkit in
// cross-source-validator.ts (domainCoherenceCheck, domainsEquivalent,
// hostFromUrlLike, registrableDomain) — does not reimplement any of it.
//
// GET /admin/domain-reconciliation-audit (src/routes/admin-domain-
// reconciliation.ts) calls classifyReconciliationCohort() read-only. POST
// /admin/domain-reconciliation-sweep calls the same classifier, then (when
// dry_run=false) applies corrections for the two high-confidence shapes and
// stamps review_required_last_audited_at on everything else so
// pickReviewQueueBatch's 21-day backoff (lokal-agent-verifier.ts) stops
// re-draining the same 0-state-change cohort daily.
//
// Non-goals (scope, per the dev-request spec): no automatic correction for
// manual_review_needed rows; no change to domainCoherenceCheck itself.

import {
  domainCoherenceCheck,
  domainsEquivalent,
  hostFromUrlLike,
  isDirectoryOrAggregatorHost,
  registrableDomain,
} from "./cross-source-validator";

export type ReconciliationClassification =
  | "circular_scramble_detected"
  | "stale_knowledge_website"
  | "manual_review_needed";

export interface ProposedFix {
  field: "agents.url" | "agent_knowledge.website";
  new_value: string;
}

export interface ReconciliationAgentResult {
  agent_id: string;
  name: string | null;
  verification_status: string;
  agent_url: string | null;
  knowledge_website: string | null;
  knowledge_email: string | null;
  coherent: boolean;
  coherence_reason?: string;
  classification: ReconciliationClassification;
  proposed_fix: ProposedFix | null;
  related_agent_ids: string[];
  reasoning: string;
}

export type AgentRow = {
  agent_id: string;
  name: string | null;
  url: string | null;
  website: string | null;
  email: string | null;
  verification_status: string;
};

// Full (non-collapsed) host of a URL-like string, or null when unparseable/empty.
function hostOf(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  return hostFromUrlLike(raw);
}

// Registrable domain of a URL-like string, or null when unparseable/empty.
function rootOf(raw: string | null | undefined): string | null {
  const host = hostOf(raw);
  if (!host) return null;
  return registrableDomain(host);
}

// True when `raw` resolves to a known directory/aggregator/shared-hosting
// host (e.g. a Google Business Site page-builder placeholder, a Norwegian
// municipal *.kommune.no domain, or an entry in KNOWN_DIRECTORY_HOSTS). Used
// to keep the circular-scramble matcher from collapsing two UNRELATED
// agents that both legitimately sit on a shared-hosting/aggregator fallback
// (registrableDomain naively takes the last two labels for any TLD outside
// the tiny co.uk/com.au/co.nz/co.jp special-case list, so e.g.
// companyx.business.site and companyy.business.site both "collapse" to the
// same bogus registrable root "business.site" — isDirectoryOrAggregatorHost
// suffix-walks the FULL host, so it correctly recognizes the shared-hosting
// family instead of trusting that bogus collapsed root).
function isAggregatorHost(raw: string | null | undefined): boolean {
  const host = hostOf(raw);
  return !!host && isDirectoryOrAggregatorHost(host);
}

/**
 * Classify a single agent given the full cross-matching universe (every
 * agent with a usable agent_knowledge.website, any verification_status — a
 * circular-scramble partner may already be `verified`). PURE — no DB access,
 * no writes.
 */
export function classifyAgent(
  agent: AgentRow,
  universe: readonly AgentRow[]
): ReconciliationAgentResult {
  const coherence = domainCoherenceCheck(agent.url, agent.website, agent.email);

  const base = {
    agent_id: agent.agent_id,
    name: agent.name,
    verification_status: agent.verification_status,
    agent_url: agent.url,
    knowledge_website: agent.website,
    knowledge_email: agent.email,
    coherent: coherence.coherent,
    coherence_reason: coherence.reason,
  };

  if (coherence.coherent) {
    return {
      ...base,
      classification: "manual_review_needed",
      proposed_fix: null,
      related_agent_ids: [],
      reasoning:
        "domainCoherenceCheck passes — this row's review_required/data_insufficient status is not a " +
        "domain-coherence issue (e.g. a cross-source address/phone conflict instead); no automatic signal here.",
    };
  }

  // ── circular_scramble_detected ────────────────────────────────────────
  // This agent's OWN agents.url domain-matches ANOTHER agent's OWN
  // agent_knowledge.website. Generalizes the 07-05 5-agent chain shape: each
  // agent in the audited cohort is classified independently against the
  // full universe, so a chain A.url≈B.website, B.url≈C.website, … is
  // detected agent-by-agent without needing explicit cycle reconstruction —
  // every implicated agent's own row will itself carry a circular_scramble_
  // detected classification (or already be coherent, if it's the *target*
  // of someone else's mismatch rather than mismatched itself).
  const ownUrlRoot = rootOf(agent.url);
  const matches: AgentRow[] = [];
  // Aggregator/shared-hosting guard (BLOCKER 1 fix): if THIS agent's own
  // agents.url sits on a known directory/aggregator/shared-hosting host
  // (business.site, kommune.no, fylkeskommune.no, KNOWN_DIRECTORY_HOSTS,
  // …), a root-domain collision against some other agent's website is
  // expected and meaningless — every tenant on that shared host collapses
  // to the same (bogus) registrable root. Never treat it as a scramble.
  const ownUrlIsAggregator = isAggregatorHost(agent.url);
  if (ownUrlRoot && !ownUrlIsAggregator) {
    for (const other of universe) {
      if (other.agent_id === agent.agent_id) continue;
      const otherWebsiteRoot = rootOf(other.website);
      if (!otherWebsiteRoot || !domainsEquivalent(ownUrlRoot, otherWebsiteRoot)) continue;
      // Same guard on the OTHER side: a match against another agent's
      // website is only meaningful evidence of a real scramble if that
      // website is itself a genuine company domain, not a shared-hosting/
      // aggregator fallback (two unrelated agents can each legitimately
      // have agent_knowledge.website on the same aggregator family).
      if (isAggregatorHost(other.website)) continue;
      matches.push(other);
    }
  }

  if (matches.length > 0) {
    const newUrl = agent.website && agent.website.trim() ? agent.website.trim() : null;
    return {
      ...base,
      classification: "circular_scramble_detected",
      proposed_fix: newUrl ? { field: "agents.url", new_value: newUrl } : null,
      related_agent_ids: matches.map((m) => m.agent_id),
      reasoning:
        `agents.url (${agent.url}) domain-matches ${matches.length === 1 ? "another agent's" : "other agents'"} ` +
        `agent_knowledge.website (${matches.map((m) => `${m.agent_id}:${m.website}`).join(", ")}) — this agent's ` +
        `own agent_knowledge.website (${agent.website ?? "none"}) is the trustworthy value for THIS agent ` +
        `(the 07-05 5-agent-chain shape: agents.url got scrambled between entities, knowledge.website did not); ` +
        `propose agents.url ← agent_knowledge.website.`,
    };
  }

  // ── stale_knowledge_website ────────────────────────────────────────────
  // Agent's own url is internally coherent against itself/email (nothing
  // contradicts trusting it), but the stored website diverges and is not
  // claimed by any other agent's url.
  const ownCoherence = domainCoherenceCheck(agent.url, null, agent.email);
  if (ownCoherence.coherent && agent.url && agent.url.trim()) {
    return {
      ...base,
      classification: "stale_knowledge_website",
      proposed_fix: { field: "agent_knowledge.website", new_value: agent.url.trim() },
      related_agent_ids: [],
      reasoning:
        `agents.url (${agent.url}) is internally coherent against agent_knowledge.email (domainCoherenceCheck ` +
        `passes with website omitted); agent_knowledge.website (${agent.website ?? "none"}) diverges from it and ` +
        `is not claimed by any other agent's url — propose agent_knowledge.website ← agents.url (the 07-05 ` +
        `19-agent shape: an unrelated company/aggregator got written into knowledge.website).`,
    };
  }

  return {
    ...base,
    classification: "manual_review_needed",
    proposed_fix: null,
    related_agent_ids: [],
    reasoning:
      `domain-coherence mismatch (${coherence.reason ?? "unknown"}) but no confident automatic signal: no other ` +
      `agent's website claims this agent's url, and this agent's own url does not cleanly cohere against its ` +
      `email either — needs human review.`,
  };
}

/**
 * Read-only classification pass over every review_required/data_insufficient
 * agent. ZERO writes — safe to call from a GET route or as the first phase
 * of the sweep (before any write decision is made).
 */
export function classifyReconciliationCohort(db: any): ReconciliationAgentResult[] {
  const cohort = db
    .prepare(
      `SELECT a.id AS agent_id, a.name, a.url,
              k.website, k.email, k.verification_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status IN ('review_required', 'data_insufficient')
     ORDER BY a.id ASC`
    )
    .all() as AgentRow[];

  // Cross-matching universe: every agent with a usable website, any status —
  // a scramble partner may already be `verified`.
  const universe = db
    .prepare(
      `SELECT a.id AS agent_id, a.name, a.url,
              k.website, k.email, k.verification_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.website IS NOT NULL AND k.website != ''`
    )
    .all() as AgentRow[];

  return cohort.map((agent) => classifyAgent(agent, universe));
}

// ─── Sweep write helpers (used only by POST /admin/domain-reconciliation-
// sweep — never by the read-only GET audit route) ───────────────────────────

function readFieldProvenance(db: any, agentId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
    .get(agentId) as { field_provenance?: string } | undefined;
  if (!row?.field_provenance) return {};
  try {
    const parsed = JSON.parse(row.field_provenance);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Re-check a proposed fix against INDEPENDENT evidence before writing it —
 * evidence that was not itself used to derive the proposed value, so this
 * can actually fail.
 *
 * BLOCKER 2 fix: the previous implementation called
 * domainCoherenceCheck(fix.new_value, r.knowledge_website, r.knowledge_email)
 * (or the website-branch mirror) — but fix.new_value IS r.knowledge_website
 * (resp. r.agent_url) by construction (see classifyAgent's two proposed_fix
 * sites), so the url/website leg of that check compared a value against
 * itself and could never fail; only the email leg ever did any real work.
 * This version:
 *   (1) never re-derives a value from the fix itself to check against — it
 *       checks the proposed value against the agent's own STORED email only
 *       (domainCoherenceCheck(proposed, null, email)), which is independent
 *       signal not used anywhere in either proposed_fix computation; and
 *   (2) rejects outright if the proposed value itself resolves to a known
 *       directory/aggregator/shared-hosting host — defense in depth
 *       alongside the BLOCKER 1 classifier-level guard: a correction must
 *       never resolve TO an aggregator domain, regardless of how it was
 *       derived.
 */
export function recheckProposedFix(r: ReconciliationAgentResult, fix: ProposedFix): boolean {
  const proposed = fix.new_value;
  if (isAggregatorHost(proposed)) return false;
  return domainCoherenceCheck(proposed, null, r.knowledge_email).coherent;
}

/**
 * Apply an atomic correction for one agent: write agents.url OR
 * agent_knowledge.website (never both — the two classifications are
 * mutually exclusive in which field is wrong), append a field_provenance
 * entry (both the standard ProvenanceRecord-array shape for the corrected
 * field, AND a dedicated domain_reconciliation_history audit entry naming
 * the related agent ids), and reset verification_status to 'pending_verify'
 * (never straight to 'verified' — the verifier re-checks with corrected
 * data on its next pass). Caller owns the transaction.
 */
export function applyReconciliationFix(
  db: any,
  r: ReconciliationAgentResult,
  nowIso: string
): void {
  const fix = r.proposed_fix;
  if (!fix) return;

  const existingProv = readFieldProvenance(db, r.agent_id);
  const fieldKey = fix.field === "agents.url" ? "url" : "website";
  const existingArr = Array.isArray(existingProv[fieldKey]) ? (existingProv[fieldKey] as unknown[]) : [];
  const provRecord = {
    value: fix.new_value,
    source_type: "domain_reconciliation_sweep",
    fetched_at: nowIso,
  };
  const existingHistory = Array.isArray(existingProv.domain_reconciliation_history)
    ? (existingProv.domain_reconciliation_history as unknown[])
    : [];
  const historyEntry = {
    at: nowIso,
    classification: r.classification,
    corrected_field: fix.field,
    old_value: fix.field === "agents.url" ? r.agent_url : r.knowledge_website,
    new_value: fix.new_value,
    related_agent_ids: r.related_agent_ids,
    reasoning: r.reasoning,
  };

  const newProv = {
    ...existingProv,
    [fieldKey]: [...existingArr, provRecord],
    domain_reconciliation_history: [...existingHistory, historyEntry],
  };

  if (fix.field === "agents.url") {
    db.prepare("UPDATE agents SET url = ? WHERE id = ?").run(fix.new_value, r.agent_id);
  } else {
    db.prepare("UPDATE agent_knowledge SET website = ? WHERE agent_id = ?").run(fix.new_value, r.agent_id);
  }

  db.prepare(
    "UPDATE agent_knowledge SET field_provenance = ?, verification_status = 'pending_verify' WHERE agent_id = ?"
  ).run(JSON.stringify(newProv), r.agent_id);
}

/**
 * Sliding-backoff stamp for a no-fix visit (manual_review_needed, or a
 * proposed fix that failed recheckProposedFix). Always overwrites — see the
 * migration comment in database/init.ts for why this must never be a
 * conditional "only if null" write.
 */
export function stampReviewRequiredAudited(db: any, agentId: string, nowIso: string): void {
  db.prepare(
    "UPDATE agent_knowledge SET review_required_last_audited_at = ? WHERE agent_id = ?"
  ).run(nowIso, agentId);
}

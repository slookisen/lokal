// ─── Debio cross-check orchestrator (Phase 5.11 C.1-A, 2026-05-16) ───
//
// Pipeline:
//   1. fetchDebioOperators(since) — pull Debio operators from EU TRACES NT
//      and filter client-side to competentAuthority.code == "NO-ØKO-01".
//   2. For each TRACES operator:
//      a. findOrgnumberByName(name, postal) — reverse-lookup orgnumber
//         via Brreg name search. Returns hit only when confidence ≥ 0.9.
//      b. If orgnumber found → look up our agent by orgnumber.
//      c. If no orgnumber match → fuzzy-match TRACES name against ALL
//         producer-agent names (Dice coefficient on normalised tokens).
//      d. Matched → upsert agent_affiliations(producer_id, debio_umbrella,
//         status='pending_confirmation', source='inferred').
//      e. Unmatched → upsert into debio_unmatched_operators (so the next
//         run can re-attempt as more producer agents are added).
//
// Idempotency: ON CONFLICT(producer_id, umbrella_id) DO UPDATE on the
// affiliations table so re-running never duplicates a row.
//
// "Inferred" is the same trust class as PR-58's organic-keyword auto-tag:
// no human has reviewed the link, so the row carries source='inferred'
// and status='pending_confirmation' until the producer accepts in the
// owner portal.
//
// NOTE: This module deliberately does NOT create new producer agents.
// Unmatched TRACES operators are surfaced via debio_unmatched_operators
// for a future "manual review" workflow.

import { getDb } from "../database/init";
import { fetchDebioOperators, TracesOperator } from "./traces-client";
import { findOrgnumberByName, normaliseName, BrregHit } from "./brreg-client";

// ─── Minimal Dice coefficient (inline until PR-62 C.2 lands) ─────────
// TODO: consolidate with name-matcher.ts once PR-62 merges. The C.2 PR
// introduces src/services/name-matcher.ts with a richer fuzzy-matcher;
// for now this 10-line Dice keeps the cross-check self-contained.
export function diceCoefficient(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const grams = (s: string) => {
    const g = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
  };
  const ga = grams(na), gb = grams(nb);
  let inter = 0;
  for (const [k, v] of ga) {
    const w = gb.get(k);
    if (w !== undefined) inter += Math.min(v, w);
  }
  return (2 * inter) / (na.length - 1 + nb.length - 1);
}

const FUZZY_NAME_THRESHOLD = 0.85;

// ─── Default Debio "since" cutoff ────────────────────────────────────
// Phase 5.11 C.1-A acceptance criterion: an incremental run must finish
// within Fly's 120s proxy limit. 2026-01-01 leaves only YTD-issued certs
// to process which keeps the Brreg lookups bounded.
export const DEFAULT_SINCE_ISO = "2026-01-01";

export type CrossCheckResult = {
  traces_fetched: number;        // count of NO-ØKO-01 records pulled from TRACES
  traces_filtered: number;       // same as traces_fetched (kept for response symmetry)
  brreg_resolved: number;        // TRACES ops resolved to an orgnumber via Brreg
  agents_matched: number;        // matched to one of our existing producer agents
  affiliations_upserted: number; // rows inserted OR updated
  unmatched_persisted: number;   // rows landed in debio_unmatched_operators
  errors: string[];
  since: string;
  duration_ms: number;
};

export type CrossCheckOptions = {
  since?: string;                // ISO date; default DEFAULT_SINCE_ISO
  fetchImpl?: typeof fetch;      // injected in tests
  delayMs?: number;              // override TRACES polite-delay (tests use 0)
  maxFiltered?: number;          // hard cap on TRACES records processed
  /** Override which umbrella agent counts as Debio. Tests use this. */
  debioUmbrellaId?: string;
};

// ─── Helper: find the Debio umbrella agent's id ──────────────────────
// We don't carry an `umbrella_slug` column on agents; the seed-script
// names it "Debio Sertifisering" or similar. Match flexibly.
export function findDebioUmbrellaId(db: ReturnType<typeof getDb>): string | null {
  // Most specific first.
  const candidates = db.prepare(`
    SELECT id, name FROM agents
    WHERE umbrella_type IS NOT NULL
      AND (
        lower(name) = 'debio'
        OR lower(name) LIKE 'debio %'
        OR lower(name) LIKE '%debio%sertifis%'
        OR lower(name) LIKE 'debio sertifis%'
      )
    ORDER BY length(name) ASC
    LIMIT 1
  `).get() as { id: string; name: string } | undefined;
  return candidates?.id ?? null;
}

// ─── Helper: look up our producer agent by orgnumber ─────────────────
// Brreg returns 9-digit numeric strings. We store the orgnumber in
// agents.organisasjonsnummer — column name might differ across migrations.
function findAgentByOrgnumber(db: ReturnType<typeof getDb>, orgnr: string): string | null {
  // Try the canonical column name first.
  const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  const candidates = [
    "organisasjonsnummer", "organisation_number", "orgnumber", "orgnr", "org_number",
  ].filter(c => colNames.has(c));
  for (const col of candidates) {
    try {
      const row = db.prepare(`SELECT id FROM agents WHERE ${col} = ? LIMIT 1`).get(orgnr) as { id: string } | undefined;
      if (row?.id) return row.id;
    } catch { /* column absent — keep trying */ }
  }
  return null;
}

// ─── Helper: fuzzy-match TRACES name against all producer agents ─────
// O(n) over agents; producers list is < ~5k so this is cheap enough.
function fuzzyMatchAgent(
  db: ReturnType<typeof getDb>,
  tracesName: string,
): { agent_id: string; score: number } | null {
  const agents = db.prepare(`
    SELECT id, name FROM agents
    WHERE umbrella_type IS NULL
      AND (role IS NULL OR role = 'producer')
      AND is_active = 1
  `).all() as Array<{ id: string; name: string }>;

  let best: { agent_id: string; score: number } | null = null;
  for (const a of agents) {
    if (!a.name) continue;
    const s = diceCoefficient(tracesName, a.name);
    if (!best || s > best.score) best = { agent_id: a.id, score: s };
  }
  return (best && best.score >= FUZZY_NAME_THRESHOLD) ? best : null;
}

// ─── Helper: upsert one affiliation row (idempotent) ─────────────────
// agent_affiliations has UNIQUE(producer_id, umbrella_id). We DO NOT
// overwrite when a row already exists with status != pending_confirmation
// (the producer may have accepted or rejected and we don't want to revert)
// but we DO refresh the evidence_json so re-runs reflect the latest TRACES
// snapshot.
function upsertAffiliation(
  db: ReturnType<typeof getDb>,
  agentId: string,
  umbrellaId: string,
  evidence: Record<string, unknown>,
): "inserted" | "updated" | "preserved" {
  const existing = db.prepare(
    "SELECT id, status FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?"
  ).get(agentId, umbrellaId) as { id: number; status: string } | undefined;

  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify(evidence);

  if (!existing) {
    db.prepare(`
      INSERT INTO agent_affiliations
        (producer_id, umbrella_id, status, source, evidence_json, created_at, updated_at)
      VALUES (?, ?, 'pending_confirmation', 'inferred', ?, ?, ?)
    `).run(agentId, umbrellaId, evidenceJson, now, now);
    return "inserted";
  }

  // Only refresh evidence if the row is still pending — never overwrite an
  // accepted/rejected status by a re-run of the auto-detector.
  if (existing.status === "pending_confirmation") {
    db.prepare(
      "UPDATE agent_affiliations SET evidence_json = ?, updated_at = ? WHERE id = ?"
    ).run(evidenceJson, now, existing.id);
    return "updated";
  }
  return "preserved";
}

// ─── Helper: persist unmatched TRACES operator for later review ──────
function upsertUnmatchedOperator(
  db: ReturnType<typeof getDb>,
  op: TracesOperator,
  bestScore: number | null,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO debio_unmatched_operators
      (operator_name, postal_code, operator_identifier, first_seen_at, last_seen_at, best_match_score)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(operator_name) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      best_match_score = excluded.best_match_score,
      postal_code = COALESCE(excluded.postal_code, debio_unmatched_operators.postal_code),
      operator_identifier = COALESCE(excluded.operator_identifier, debio_unmatched_operators.operator_identifier)
  `).run(
    op.operator_name,
    op.postal_code,
    op.operator_identifier,
    now,
    now,
    bestScore,
  );
}

// ─── Main entry: orchestrate TRACES → Brreg → our agents ─────────────
export async function runDebioCrossCheck(
  opts: CrossCheckOptions = {},
): Promise<CrossCheckResult> {
  const since = opts.since ?? DEFAULT_SINCE_ISO;
  const t0 = Date.now();
  const result: CrossCheckResult = {
    traces_fetched: 0,
    traces_filtered: 0,
    brreg_resolved: 0,
    agents_matched: 0,
    affiliations_upserted: 0,
    unmatched_persisted: 0,
    errors: [],
    since,
    duration_ms: 0,
  };

  const db = getDb();
  const debioUmbrellaId = opts.debioUmbrellaId ?? findDebioUmbrellaId(db);
  if (!debioUmbrellaId) {
    result.errors.push(
      "Debio umbrella agent not found in agents table (expected an umbrella whose name contains 'Debio'). " +
      "Tip: seed an umbrella row before running the cross-check.",
    );
    result.duration_ms = Date.now() - t0;
    return result;
  }

  let operators: TracesOperator[];
  try {
    operators = await fetchDebioOperators({
      since,
      fetchImpl: opts.fetchImpl,
      delayMs: opts.delayMs,
      maxFiltered: opts.maxFiltered,
    });
  } catch (e) {
    result.errors.push(
      `fetchDebioOperators failed: ${e instanceof Error ? e.message : String(e)}. ` +
      `Tip: TRACES pulls can exceed Fly's 120s proxy timeout — re-run with a tighter ?since=`,
    );
    result.duration_ms = Date.now() - t0;
    return result;
  }
  result.traces_fetched = operators.length;
  result.traces_filtered = operators.length;

  for (const op of operators) {
    // Step 1: Brreg reverse lookup.
    let brregHit: BrregHit | null = null;
    try {
      brregHit = await findOrgnumberByName(op.operator_name, op.postal_code, opts.fetchImpl);
    } catch (e) {
      result.errors.push(
        `brreg lookup failed for "${op.operator_name}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (brregHit) result.brreg_resolved++;

    // Step 2: agent lookup.
    let matchedAgentId: string | null = null;
    let matchMethod: "orgnumber" | "name_fuzzy" = "orgnumber";
    let matchScore = brregHit?.confidence ?? 0;

    if (brregHit) {
      matchedAgentId = findAgentByOrgnumber(db, brregHit.orgnumber);
    }
    if (!matchedAgentId) {
      const fuzz = fuzzyMatchAgent(db, op.operator_name);
      if (fuzz) {
        matchedAgentId = fuzz.agent_id;
        matchMethod = "name_fuzzy";
        matchScore = fuzz.score;
      }
    }

    if (!matchedAgentId) {
      try {
        upsertUnmatchedOperator(db, op, brregHit?.confidence ?? null);
        result.unmatched_persisted++;
      } catch (e) {
        result.errors.push(
          `unmatched insert failed for "${op.operator_name}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    }

    result.agents_matched++;

    // Step 3: upsert affiliation.
    try {
      const decision = upsertAffiliation(db, matchedAgentId, debioUmbrellaId, {
        traces_operator_id: op.operator_identifier,
        traces_operator_name: op.operator_name,
        traces_postal_code: op.postal_code,
        brreg_orgnumber: brregHit?.orgnumber ?? null,
        brreg_confidence: brregHit?.confidence ?? null,
        agent_match_method: matchMethod,
        match_score: matchScore,
        scraped_at: new Date().toISOString(),
      });
      if (decision === "inserted" || decision === "updated") {
        result.affiliations_upserted++;
      }
    } catch (e) {
      result.errors.push(
        `affiliation upsert failed for agent ${matchedAgentId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

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
import { fetchFinnokoCompanies, FinnokoCompany } from "./debio-finnoko-client";
import { findOrgnumberByName, normaliseName, BrregHit } from "./brreg-client";

// ─── PR-70: data-source selector ─────────────────────────────────────
//
// The cross-check has TWO upstream sources:
//   - "finnoko" (PRIMARY, PR-70): pulls Debio's own ACM directory at
//     https://finnoko.debio.no/api/acm/companies — ~82 Norwegian
//     producers, single round-trip, no pagination. By construction
//     every record is Debio-certified.
//   - "traces" (FALLBACK, PR-66): pulls EU TRACES NT and filters
//     client-side to competentAuthority.code == NO-ØKO-01. Empirical
//     record yield is ~0 because the live portal rejected the POST
//     filter shape. Kept as fallback so the system gracefully
//     degrades if finnoko goes down.
//   - "auto" (DEFAULT): try finnoko first, fall back to traces only
//     if the finnoko fetch raises.
export type DebioSource = "finnoko" | "traces" | "auto";

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
  // PR-70: which upstream source actually delivered the operator
  // records used in this run. "finnoko" | "traces" | "none" (no data
  // returned by either source).
  source_used: DebioSource | "none";
  // PR-70: count of Debio-certified records pulled from finnoko.debio.no
  finnoko_fetched: number;
  // PR-70: count of finnoko records that passed our shape filter
  // (display_name + partner_sid required). Same number as
  // finnoko_fetched in practice — kept for response symmetry with
  // the TRACES traces_fetched/traces_filtered pair.
  finnoko_filtered: number;
  traces_fetched: number;        // count of NO-ØKO-01 records pulled from TRACES
  traces_filtered: number;       // same as traces_fetched (kept for response symmetry)
  brreg_resolved: number;        // ops resolved to an orgnumber via Brreg
  agents_matched: number;        // matched to one of our existing producer agents
  affiliations_upserted: number; // rows inserted OR updated
  unmatched_persisted: number;   // rows landed in debio_unmatched_operators
  errors: string[];
  since: string;
  duration_ms: number;
  // PR-65: which slice of the TRACES global list this run processed.
  // start = startTracesPage opt; end = start + maxTracesPages - 1
  // (inclusive). Always present; defaults are {start:0, end:1199}.
  traces_pages_processed: { start: number; end: number };
};

export type CrossCheckOptions = {
  since?: string;                // ISO date; default DEFAULT_SINCE_ISO
  fetchImpl?: typeof fetch;      // injected in tests
  delayMs?: number;              // override TRACES polite-delay (tests use 0)
  maxFiltered?: number;          // hard cap on TRACES records processed
  /** Override which umbrella agent counts as Debio. Tests use this. */
  debioUmbrellaId?: string;
  /** PR-65: start TRACES pagination from this 0-based page index. Default 0. */
  startTracesPage?: number;
  /** PR-65: max TRACES pages this call may fetch. Default 1200. */
  maxTracesPages?: number;
  /**
   * PR-70: choose the upstream Debio operator list.
   *   "finnoko" — query finnoko.debio.no/api/acm/companies (primary)
   *   "traces"  — query EU TRACES NT (legacy fallback)
   *   "auto"    — try finnoko first, fall back to TRACES on error
   * Default: "auto".
   */
  source?: DebioSource;
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

// ─── PR-70: shared per-operator matching shape ──────────────────────
//
// Both the finnoko and TRACES sources are normalised into this shape
// before the Brreg→agent matching loop. Keeps the matching logic
// identical regardless of source.
type NormalisedOperator = {
  operator_name: string;
  postal_code: string | null;
  operator_identifier: string | null;
  /** Source-tagged raw record, used to enrich evidence_json. */
  source: "finnoko" | "traces";
  raw: TracesOperator | FinnokoCompany;
};

// ─── PR-70: per-operator matcher (Brreg → agents → affiliation) ──────
//
// Extracted from the prior inline loop in runDebioCrossCheck so the
// finnoko and traces source paths can share it. Pure side-effects:
//   - mutates `result` counters and errors
//   - writes to agent_affiliations and debio_unmatched_operators
async function matchAndUpsertOne(
  db: ReturnType<typeof getDb>,
  op: NormalisedOperator,
  debioUmbrellaId: string,
  fetchImpl: typeof fetch | undefined,
  result: CrossCheckResult,
): Promise<void> {
  // Step 1: Brreg reverse lookup.
  let brregHit: BrregHit | null = null;
  try {
    brregHit = await findOrgnumberByName(op.operator_name, op.postal_code, fetchImpl);
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
      // Reuse the same `debio_unmatched_operators` table — the row
      // shape (operator_name, postal_code, operator_identifier) is
      // source-agnostic. The finnoko `partner_sid` is stringified
      // into operator_identifier for stable cross-source dedup.
      upsertUnmatchedOperator(
        db,
        {
          operator_name: op.operator_name,
          postal_code: op.postal_code,
          operator_identifier: op.operator_identifier,
          country: null,
          city: null,
          status: null,
          issued_on: null,
          expires_on: null,
        },
        brregHit?.confidence ?? null,
      );
      result.unmatched_persisted++;
    } catch (e) {
      result.errors.push(
        `unmatched insert failed for "${op.operator_name}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return;
  }

  result.agents_matched++;

  // Step 3: upsert affiliation. Evidence JSON is source-tagged so
  // a downstream reviewer can see whether the match came from
  // finnoko or TRACES.
  try {
    const evidence: Record<string, unknown> = {
      source: op.source,
      operator_id: op.operator_identifier,
      operator_name: op.operator_name,
      postal_code: op.postal_code,
      brreg_orgnumber: brregHit?.orgnumber ?? null,
      brreg_confidence: brregHit?.confidence ?? null,
      agent_match_method: matchMethod,
      match_score: matchScore,
      scraped_at: new Date().toISOString(),
    };
    // Keep TRACES-shaped keys around for backward-compat with PR-63
    // evidence-readers (the cross-check has been in prod long enough
    // that some consumers may grep for these specific keys).
    if (op.source === "traces") {
      evidence.traces_operator_id = op.operator_identifier;
      evidence.traces_operator_name = op.operator_name;
      evidence.traces_postal_code = op.postal_code;
    } else {
      evidence.finnoko_partner_sid = op.operator_identifier;
      evidence.finnoko_display_name = op.operator_name;
    }
    const decision = upsertAffiliation(db, matchedAgentId, debioUmbrellaId, evidence);
    if (decision === "inserted" || decision === "updated") {
      result.affiliations_upserted++;
    }
  } catch (e) {
    result.errors.push(
      `affiliation upsert failed for agent ${matchedAgentId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ─── PR-70: finnoko-source cross-check helper ────────────────────────
//
// Fetches the finnoko company list (single HTTP GET, ~82 records) and
// runs the shared matcher. Returns the count of records actually
// processed so the caller (runDebioCrossCheck) can update
// result.finnoko_fetched/filtered + decide whether to attempt a
// TRACES fallback.
//
// Exported so the admin route can call it directly when source=finnoko
// is forced; "auto" mode also goes through here.
export async function crossCheckViaFinnoko(
  db: ReturnType<typeof getDb>,
  debioUmbrellaId: string,
  result: CrossCheckResult,
  opts: CrossCheckOptions = {},
): Promise<{ fetched: number; processed: number }> {
  let companies: FinnokoCompany[];
  try {
    companies = await fetchFinnokoCompanies({ fetchImpl: opts.fetchImpl });
  } catch (e) {
    result.errors.push(
      `fetchFinnokoCompanies failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }

  result.finnoko_fetched = companies.length;
  result.finnoko_filtered = companies.length;

  const cap = opts.maxFiltered && opts.maxFiltered > 0
    ? Math.min(opts.maxFiltered, companies.length)
    : companies.length;

  for (let i = 0; i < cap; i++) {
    const c = companies[i];
    await matchAndUpsertOne(
      db,
      {
        operator_name: c.display_name,
        // finnoko has no postal-code field — Brreg lookup falls back
        // to name-only mode, which still works (just lower confidence
        // when multiple Brreg hits exist).
        postal_code: null,
        operator_identifier: String(c.partner_sid),
        source: "finnoko",
        raw: c,
      },
      debioUmbrellaId,
      opts.fetchImpl,
      result,
    );
  }

  return { fetched: companies.length, processed: cap };
}

// ─── PR-70: TRACES-source cross-check helper (extracted) ─────────────
//
// Same body as the legacy pre-PR-70 inline loop, just refactored into
// a callable so source-selection can dispatch into it.
export async function crossCheckViaTraces(
  db: ReturnType<typeof getDb>,
  debioUmbrellaId: string,
  result: CrossCheckResult,
  opts: CrossCheckOptions = {},
  startTracesPage: number = 0,
  maxTracesPages: number = 1200,
): Promise<void> {
  const since = opts.since ?? DEFAULT_SINCE_ISO;
  let operators: TracesOperator[];
  try {
    operators = await fetchDebioOperators({
      since,
      fetchImpl: opts.fetchImpl,
      delayMs: opts.delayMs,
      maxFiltered: opts.maxFiltered,
      startTracesPage,
      maxTracesPages,
    });
  } catch (e) {
    result.errors.push(
      `fetchDebioOperators failed: ${e instanceof Error ? e.message : String(e)}. ` +
      `Tip: TRACES pulls can exceed Fly's 120s proxy timeout — re-run with a tighter ?since=`,
    );
    throw e;
  }
  result.traces_fetched = operators.length;
  result.traces_filtered = operators.length;

  for (const op of operators) {
    await matchAndUpsertOne(
      db,
      {
        operator_name: op.operator_name,
        postal_code: op.postal_code,
        operator_identifier: op.operator_identifier,
        source: "traces",
        raw: op,
      },
      debioUmbrellaId,
      opts.fetchImpl,
      result,
    );
  }
}

// ─── Main entry: orchestrate finnoko / TRACES → Brreg → our agents ───
//
// PR-70: source selection lives here.
//   - opts.source === "finnoko"  → finnoko only; do NOT fall back.
//   - opts.source === "traces"   → TRACES only; do NOT call finnoko.
//   - opts.source === "auto" (default) → try finnoko first, fall
//     back to TRACES only if the finnoko call threw.
export async function runDebioCrossCheck(
  opts: CrossCheckOptions = {},
): Promise<CrossCheckResult> {
  const since = opts.since ?? DEFAULT_SINCE_ISO;
  const t0 = Date.now();
  const source: DebioSource = opts.source ?? "auto";

  // PR-65: compute the inclusive page window we'll report back, so
  // even if the run fails early the caller knows which slice was
  // attempted. Defaults match the prior global-sweep behaviour.
  const startTracesPage = Math.max(
    0,
    Number.isFinite(opts.startTracesPage) ? Math.floor(opts.startTracesPage ?? 0) : 0,
  );
  const maxTracesPages = Math.max(
    1,
    Number.isFinite(opts.maxTracesPages) && (opts.maxTracesPages ?? 0) > 0
      ? Math.floor(opts.maxTracesPages ?? 1200)
      : 1200,
  );

  const result: CrossCheckResult = {
    source_used: "none",
    finnoko_fetched: 0,
    finnoko_filtered: 0,
    traces_fetched: 0,
    traces_filtered: 0,
    brreg_resolved: 0,
    agents_matched: 0,
    affiliations_upserted: 0,
    unmatched_persisted: 0,
    errors: [],
    since,
    duration_ms: 0,
    traces_pages_processed: {
      start: startTracesPage,
      end: startTracesPage + maxTracesPages - 1,
    },
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

  // ─── Source dispatch ────────────────────────────────────────────
  if (source === "finnoko") {
    try {
      await crossCheckViaFinnoko(db, debioUmbrellaId, result, opts);
      result.source_used = "finnoko";
    } catch {
      // crossCheckViaFinnoko already pushed the error onto result.errors.
      result.source_used = "none";
    }
  } else if (source === "traces") {
    try {
      await crossCheckViaTraces(db, debioUmbrellaId, result, opts, startTracesPage, maxTracesPages);
      result.source_used = "traces";
    } catch {
      result.source_used = "none";
    }
  } else {
    // "auto" — try finnoko first; on thrown error fall back to TRACES.
    let finnokoOk = false;
    try {
      await crossCheckViaFinnoko(db, debioUmbrellaId, result, opts);
      finnokoOk = true;
      result.source_used = "finnoko";
    } catch {
      // pushed error already; will attempt TRACES below.
    }
    if (!finnokoOk) {
      try {
        await crossCheckViaTraces(db, debioUmbrellaId, result, opts, startTracesPage, maxTracesPages);
        result.source_used = "traces";
      } catch {
        result.source_used = "none";
      }
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

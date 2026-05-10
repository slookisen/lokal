// ─── marketing-dedupe — WO-20 / PR-22 ──────────────────────────────────
//
// Pure functions used by /admin/outreach-ready-pool to ensure that when
// multiple agents share the same recipient email (e.g. four "agder@bondens-
// marked.no" pool agents — Mandal, Lyngdal, Grimstad, plus Agder root), we
// only pick ONE per batch. The others stay in the pool and become eligible
// next batch (after the chosen one moves to outreach_sent_log → out of view).
//
// Tiebreaker rules (in order):
//   1. Highest views_count (most-active agent — proxies real demand).
//   2. Highest google_rating * google_review_count (most-reviewed).
//   3. Lexicographic by name (stable, deterministic).
//
// Net effect: max 1 outreach email per recipient address per batch.
// Domain-reputation safe; no human ever gets four "Hei <agent>!" emails.
//
// References:
//   - PR-22 / WO-20 work-order
//   - Today's incident: 4 agder@bondensmarked.no agents in pool

export interface DedupeCandidate {
  agent_id: string;
  name: string;
  email: string | null;
  views_count?: number | null;
  google_rating?: number | null;
  google_review_count?: number | null;
  // pass-through fields are preserved by callers — not used by dedupe itself.
  [extra: string]: unknown;
}

export interface DedupeResult<T extends DedupeCandidate> {
  /** Agents that survived dedupe — one per email. */
  selected: T[];
  /** Agents suppressed THIS batch (still eligible next batch). */
  suppressed: T[];
  /** How many distinct emails had >=2 agents (drove the suppression). */
  emails_with_collisions: number;
}

/**
 * Pick a single agent per email group using the tiebreaker chain above.
 * Agents with null/empty email pass through unchanged (they have no
 * collision risk - they shouldn't even be in the pool, but we defensively
 * keep them rather than silently drop).
 */
export function dedupeByEmail<T extends DedupeCandidate>(candidates: T[]): DedupeResult<T> {
  const groups = new Map<string, T[]>();
  const passthrough: T[] = [];

  for (const c of candidates) {
    const e = (c.email ?? "").trim().toLowerCase();
    if (!e) {
      passthrough.push(c);
      continue;
    }
    const list = groups.get(e);
    if (list) list.push(c);
    else groups.set(e, [c]);
  }

  const selected: T[] = [...passthrough];
  const suppressed: T[] = [];
  let collisions = 0;

  for (const [, group] of groups) {
    if (group.length === 1) {
      selected.push(group[0]);
      continue;
    }
    collisions++;
    // Sort descending by tiebreaker chain - first element wins.
    const sorted = [...group].sort(compareCandidates);
    selected.push(sorted[0]);
    for (let i = 1; i < sorted.length; i++) suppressed.push(sorted[i]);
  }

  return { selected, suppressed, emails_with_collisions: collisions };
}

/**
 * Compare two candidates for "who wins the email group". Returns negative if
 * `a` should come first (a wins), positive if `b` should come first.
 */
export function compareCandidates(a: DedupeCandidate, b: DedupeCandidate): number {
  // 1. views_count desc
  const av = numOrZero(a.views_count);
  const bv = numOrZero(b.views_count);
  if (av !== bv) return bv - av;

  // 2. google_rating * google_review_count desc
  const aScore = numOrZero(a.google_rating) * numOrZero(a.google_review_count);
  const bScore = numOrZero(b.google_rating) * numOrZero(b.google_review_count);
  if (aScore !== bScore) return bScore - aScore;

  // 3. name asc (lexicographic, stable)
  const an = String(a.name ?? "");
  const bn = String(b.name ?? "");
  if (an < bn) return -1;
  if (an > bn) return 1;

  // Final fallback so the sort is fully deterministic
  return String(a.agent_id).localeCompare(String(b.agent_id));
}

function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * experience-content-judge.ts — dev-request 2026-07-12-experiences-
 * enrichment-supply-and-aggregator-hygiene, item 5 ("wrong_content_rate
 * holdout"), slice claimed 2026-08-07T05:56Z.
 *
 * Makes charters/experiences-enrichment.yaml's `wrong_content_rate`
 * guardrail (status: not_computable_yet, threshold 0.02, since 2026-06-17)
 * actually computable: sample enriched `experiences` rows and grade the
 * written description/category/price against the page they were actually
 * enriched from.
 *
 * FIX (2026-08-25, wrong_content_rate = 0.25 root-cause): this module used to
 * re-fetch `experiences.evidence_url` and treat it as "the live source page
 * it was enriched from" — that is exactly the claim `applyExperienceContent`'s
 * own doc comment (src/services/experience-store.ts) warns is false:
 * `evidence_url` is DISCOVERY-time provenance, written ONCE at
 * createExperience() from the ORIGINAL harvest row and never updated again by
 * either the twice-daily content-refresh writer or a richer re-harvest merge.
 * The page actually used to WRITE a field's current value is recorded
 * PER-FIELD in `content_field_evidence` (JSON: field -> source URL), stamped
 * by applyExperienceContent on every write. The two can point at completely
 * different pages — a row harvested from one listing, then enriched months
 * later from its real homepage — and comparing the enriched fields against
 * the wrong (stale, discovery-time) page produces exactly the false-mismatch
 * pattern the 2026-08-25 holdout run (0.25, 12x threshold) hit: e.g. an
 * experience's stored content re-graded against a completely unrelated page
 * that happens to be the ORIGINAL discovery source, not the enrichment
 * source. `resolveHoldoutEvidenceUrl()` below fixes this by preferring the
 * per-field `content_field_evidence` URL for whichever judged field actually
 * carries one (description, then category, then price_from — the fields
 * content-refresh writes and this judge grades), falling back to the legacy
 * `evidence_url` only when NO field carries genuine per-field provenance
 * (rows written before content_field_evidence existed). A row with neither is
 * excluded from the holdout pool entirely (see sampleEnrichedExperiencesFor
 * Holdout) rather than graded against a citation known to be untrustworthy.
 *
 * Two pieces:
 *   - sampleEnrichedExperiencesForHoldout(db, n): pure-ish DB read, the
 *     candidate pool for the holdout.
 *   - judgeExperienceContentMatch(row, pageText): the fail-closed LLM judge.
 *     Mirrors judgeGardssalgAboutCandidate's EXACT sentinel/fail-closed
 *     contract (src/routes/opplevelser.ts, ~line 11178) — direct fetch to
 *     https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env,
 *     model claude-haiku-4-5, NEVER throws.
 *
 * IMPORTANT deviation from a plain boolean "approved" verdict (unlike
 * judgeGardssalgAboutCandidate): this judge's caller (POST /admin/
 * experiences-wrong-content-rate) needs to tell a genuinely-rendered
 * MISMATCH verdict apart from "the judge itself failed to produce a
 * trustworthy opinion" (missing key / network error / non-200 / unparseable
 * JSON / ambiguous verdict text) — the dev-request's own design section is
 * explicit that BOTH judge failure and fetchPage() failure must exclude the
 * row from BOTH numerator and denominator ("unresolved", never silently
 * counted as a match, and — just as important for an honest rate — never
 * silently counted as a mismatch either, since a judge outage is not a
 * content-quality signal). A bare boolean cannot distinguish "LLM said
 * MISMATCH" from "LLM call itself failed", so this module returns a
 * discriminated union: `{ ok: true, verdict, reasoning }` on a genuine
 * rendered verdict, `{ ok: false, reasoning }` on any failure. `ok: false`
 * IS the fail-closed sentinel — the function still never throws and never
 * fabricates a verdict on doubt, exactly the same discipline as
 * judgeGardssalgAboutCandidate, just surfaced through a shape the caller can
 * route to "unresolved" instead of misreading as a match.
 */

import type Database from "better-sqlite3";
import {
  parseContentFieldEvidence,
  HARVEST_PROVENANCE_SENTINEL,
  BLANK_PROVENANCE_SENTINEL,
} from "./experience-store";

export interface HoldoutExperienceRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  price_band: string | null;
  price_from: number | null;
  // Legacy discovery-time citation — see the module header. Never fetched
  // directly by the caller any more; resolveHoldoutEvidenceUrl() below is the
  // only sanctioned way to turn a row into a URL to check content against.
  // Nullable despite the SQL below still filtering NOT NULL rows in the
  // common case: content_field_evidence-only rows (no legacy evidence_url at
  // all) are now also eligible, so the type must not lie about that.
  evidence_url: string | null;
  content_field_evidence: string | null;
}

// Judged fields, in priority order, that content-refresh actually writes and
// this holdout actually grades (title is never touched by content-refresh —
// see applyExperienceContent — so it has no per-field evidence entry and is
// deliberately not in this list). The first field that carries a genuine
// (non-sentinel) per-field source URL wins; in the overwhelming common case
// all fields written by the SAME content-refresh pass share one URL anyway,
// so the choice among them rarely matters — this only breaks ties when a
// row's fields were filled by different passes over time.
const HOLDOUT_JUDGED_FIELDS = ["description", "category", "price_from"] as const;

/**
 * Resolve the actual page a holdout row's graded content should be checked
 * against. Prefers the PER-FIELD provenance in `content_field_evidence`
 * (stamped by applyExperienceContent at write time — the true "what page did
 * this field's value come from") over the row's `evidence_url` column, which
 * is DISCOVERY-time provenance frozen at insert and never updated by
 * enrichment (see module header). Falls back to `evidence_url` only when NO
 * judged field carries genuine per-field provenance at all (older rows
 * written before content_field_evidence existed) — never silently prefers
 * the known-untrustworthy column when a trustworthy one is available.
 * Returns null when there is truly nothing fetchable to check against (no
 * per-field evidence AND no evidence_url) — the caller must treat that as
 * unresolved, never fabricate a comparison.
 */
export function resolveHoldoutEvidenceUrl(row: HoldoutExperienceRow): string | null {
  const evidence = parseContentFieldEvidence(row.content_field_evidence);
  for (const field of HOLDOUT_JUDGED_FIELDS) {
    const src = evidence[field];
    if (!src) continue;
    const trimmed = src.trim();
    if (!trimmed) continue;
    if (trimmed === HARVEST_PROVENANCE_SENTINEL || trimmed === BLANK_PROVENANCE_SENTINEL) continue;
    return trimmed;
  }
  const legacy = row.evidence_url?.trim();
  return legacy || null;
}

// Pool cap for the initial SQL read — avoids ORDER BY RANDOM() on a
// potentially large table (per the dev-request's own design note). The pool
// is read most-recently-updated-first, then shuffled in JS and sliced to the
// caller's requested `n`.
const HOLDOUT_POOL_CAP = 500;

/**
 * Selects up to `n` rows from `experiences` eligible for the wrong_content_
 * rate holdout: enrichment_state='enriched' AND content_source='provider_
 * site' AND (evidence_url IS NOT NULL OR content_field_evidence IS NOT
 * NULL) — the SQL-level pass admits either citation source, then the pool is
 * filtered (in JS) to rows resolveHoldoutEvidenceUrl() can actually resolve
 * to a real, non-sentinel URL — a row with no genuinely-checkable citation at
 * all carries no signal for the holdout and must not be sampled into it (see
 * resolveHoldoutEvidenceUrl's doc comment). Read-only — a single SELECT, zero
 * writes. `n` is used as-is (the caller — the admin route — is responsible
 * for clamping the requested sample_size to its own cap before calling
 * this).
 */
export function sampleEnrichedExperiencesForHoldout(
  db: Database.Database,
  n: number,
): HoldoutExperienceRow[] {
  const safeN = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (safeN <= 0) return [];

  const rawPool = db
    .prepare(
      `SELECT id, title, description, category, price_band, price_from,
              evidence_url, content_field_evidence
         FROM experiences
        WHERE enrichment_state = 'enriched'
          AND content_source = 'provider_site'
          AND (evidence_url IS NOT NULL OR content_field_evidence IS NOT NULL)
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(HOLDOUT_POOL_CAP) as HoldoutExperienceRow[];

  const pool = rawPool.filter((row) => resolveHoldoutEvidenceUrl(row) !== null);

  // Fisher-Yates shuffle in JS — the pool is already capped by the SQL LIMIT
  // above, so this never touches more than HOLDOUT_POOL_CAP rows.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }

  return pool.slice(0, Math.min(safeN, pool.length));
}

export type ExperienceContentJudgeVerdict =
  | { ok: true; verdict: "MATCH" | "MISMATCH"; reasoning: string }
  | { ok: false; reasoning: string };

const JUDGE_MATCH_TOKEN = "MATCH";
const JUDGE_MISMATCH_TOKEN = "MISMATCH";
// Same cap style as GARDSSALG_JUDGE_CANDIDATE_CHAR_CAP
// (src/routes/opplevelser.ts) — bounds LLM spend per row.
const JUDGE_PAGE_TEXT_CHAR_CAP = 4000;

/**
 * Fail-closed LLM judge: does the written experience content (title/
 * description/category/price) plausibly match what the live evidence_url
 * page actually says? Same never-throw/fail-closed contract as
 * judgeGardssalgAboutCandidate — missing ANTHROPIC_API_KEY, network failure,
 * non-200, unparseable JSON, or an ambiguous/unexpected verdict token all
 * resolve to `{ ok: false }`, NEVER a thrown error and NEVER a fabricated
 * MATCH/MISMATCH verdict on doubt.
 */
export async function judgeExperienceContentMatch(
  row: HoldoutExperienceRow,
  pageText: string,
): Promise<ExperienceContentJudgeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reasoning: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const cappedPageText = (pageText || "").slice(0, JUDGE_PAGE_TEXT_CHAR_CAP);
  const priceLine =
    row.price_band || row.price_from != null
      ? `Prisklasse: ${row.price_band ?? "ukjent"}${row.price_from != null ? `, fra ${row.price_from} kr` : ""}`
      : "Prisklasse: (ikke satt)";

  const prompt = `Du er en kvalitetsdommer som sjekker om innhold skrevet om en opplevelse faktisk stemmer med kildesiden det ble hentet fra. Under er (1) innholdet som er lagret i databasen for opplevelsen "${row.title}", og (2) den synlige teksten fra kildesiden (evidence_url) innholdet skal være hentet fra.

Lagret innhold:
Tittel: ${row.title}
Beskrivelse: ${row.description ?? "(ingen)"}
Kategori: ${row.category ?? "(ingen)"}
${priceLine}

Synlig tekst fra kildesiden:
${cappedPageText}

Vurder om det lagrede innholdet plausibelt stemmer overens med kildesiden — samme tilbyder/aktivitet, ikke åpenbart hentet fra feil side eller fabrikkert. Dette er IKKE en kvalitetsvurdering av hvor godt teksten er skrevet, kun om innholdet faktisk stemmer med kilden.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${JUDGE_MATCH_TOKEN}
<kort begrunnelse>

eller

${JUDGE_MISMATCH_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${JUDGE_MISMATCH_TOKEN}.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { ok: false, reasoning: "nettverksfeil under dommer-kall — avvist fail-closed" }; // never fabricate
  }

  if (!response.ok) {
    return { ok: false, reasoning: `dommer-API svarte status ${response.status} — avvist fail-closed` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { ok: false, reasoning: "ikke-parsbar JSON fra dommer-API — avvist fail-closed" };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { ok: false, reasoning: "uventet svarformat fra dommer-API — avvist fail-closed" };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toUpperCase();
  const reasoning = lines.slice(1).join(" ").trim();

  // Only the EXACT token approves either verdict. Anything else — garbage, a
  // token merely CONTAINING one of the two words inside a longer sentence,
  // an empty response — is fail-closed (ok: false), never a guessed verdict.
  if (verdictToken === JUDGE_MATCH_TOKEN) {
    return { ok: true, verdict: "MATCH", reasoning: reasoning || "vurdert som treff av LLM-dommer" };
  }
  if (verdictToken === JUDGE_MISMATCH_TOKEN) {
    return { ok: true, verdict: "MISMATCH", reasoning: reasoning || "vurdert som avvik av LLM-dommer" };
  }
  return { ok: false, reasoning: "uventet/tvetydig dommersvar — avvist fail-closed" };
}

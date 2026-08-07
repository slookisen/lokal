/**
 * experience-content-judge.ts — dev-request 2026-07-12-experiences-
 * enrichment-supply-and-aggregator-hygiene, item 5 ("wrong_content_rate
 * holdout"), slice claimed 2026-08-07T05:56Z.
 *
 * Makes charters/experiences-enrichment.yaml's `wrong_content_rate`
 * guardrail (status: not_computable_yet, threshold 0.02, since 2026-06-17)
 * actually computable: sample enriched `experiences` rows and grade the
 * written description/category/price against the row's own `evidence_url`
 * (the live source page it was enriched from).
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

export interface HoldoutExperienceRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  price_band: string | null;
  price_from: number | null;
  evidence_url: string;
}

// Pool cap for the initial SQL read — avoids ORDER BY RANDOM() on a
// potentially large table (per the dev-request's own design note). The pool
// is read most-recently-updated-first, then shuffled in JS and sliced to the
// caller's requested `n`.
const HOLDOUT_POOL_CAP = 500;

/**
 * Selects up to `n` rows from `experiences` eligible for the wrong_content_
 * rate holdout: enrichment_state='enriched' AND content_source='provider_
 * site' AND evidence_url IS NOT NULL. Read-only — a single SELECT, zero
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

  const pool = db
    .prepare(
      `SELECT id, title, description, category, price_band, price_from, evidence_url
         FROM experiences
        WHERE enrichment_state = 'enriched'
          AND content_source = 'provider_site'
          AND evidence_url IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(HOLDOUT_POOL_CAP) as HoldoutExperienceRow[];

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

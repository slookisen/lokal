// ─── Salgskanal auto-matcher (dev-request 2026-07-06-rfb-salgskanal-kategorier) ──
//
// "Salgskanal" (sales-channel) grouping: browsable by HOW you get the goods
// (Selvplukk / Hjemlevering / Gårdsbutikk / Gårdskafé-servering / REKO-ring),
// distinct from product categories (vegetables/fruit/...) and umbrella orgs
// (Hanen/Debio/Bondens marked). Membership is auto-derived from free text —
// NO manual curation by default (source='manual' rows are the escape hatch,
// see runSalgskanalSweep() below).
//
// Architecture mirrors the two existing auto-matcher precedents in this
// codebase:
//   - src/services/organic-keyword-detector.ts (PR-58): pure function,
//     string in -> structured signal out (matched_keywords + evidence
//     snippets). matchSalgskanalCategories() below follows this shape.
//   - src/services/hanen-scraper.ts / debio-verification-service.ts
//     (PR-64/PR-95): a pure matcher + a DB-touching sweep function that
//     loads the producer corpus, matches, and idempotently
//     upserts/refreshes rows, run via an admin route + a periodic
//     scheduler tick in src/index.ts. runSalgskanalSweep() below follows
//     this shape.
//
// Precision stance (dev-request risk #1, "absent beats wrong"): prefer
// false negatives over false positives. Concretely:
//   - Gårdskafé/servering requires EITHER a strong same-word signal
//     ("gårdskafé"/"sommerkafé") OR >= 2 distinct weak signals (a bare
//     café mention AND a serving mention) — a lone "kafé i nærheten"
//     (a nearby café, not their own) must NOT match.
//   - Hjemlevering only matches on delivery-TO-THE-HOME phrasing
//     ("hjemlever*", "leverer hjem", "hjem til døra", "utkjøring", "home
//     delivery") — "levering til butikk" (delivery TO A SHOP) must NOT
//     match, since none of those phrases are substrings of it.
//   - REKO-ring requires the "reko" + "ring" pairing (not bare "REKO",
//     which is too generic/acronym-collision-prone on its own).
//
// No Norwegian-text transliteration here: display text (producer
// name/description) is matched as-is (NFC + lowercase only). The 5
// category slugs are already plain ASCII words, so no slugify() call is
// needed for them; if a future slice ever derives an identifier from a
// producer name it must reuse src/utils/slug.ts, not reinvent one.

export type SalgskanalCategorySlug =
  | "selvplukk"
  | "hjemlevering"
  | "gardsbutikk"
  | "gardskafe-servering"
  | "reko-ring";

export const SALGSKANAL_CATEGORY_SLUGS: SalgskanalCategorySlug[] = [
  "gardsbutikk",
  "gardskafe-servering",
  "reko-ring",
  "selvplukk",
  "hjemlevering",
];

export const SALGSKANAL_CATEGORY_NAMES: Record<SalgskanalCategorySlug, string> = {
  gardsbutikk: "Gårdsbutikk",
  "gardskafe-servering": "Gårdskafé/servering",
  "reko-ring": "REKO-ring",
  selvplukk: "Selvplukk",
  hjemlevering: "Hjemlevering",
};

export type SalgskanalMatchInput = {
  name?: string | null;
  description?: string | null;
  tags?: string[] | null;
  skills?: string[] | null;
  /**
   * Optional extra free text folded into the scan alongside
   * name/description/tags/skills — e.g. agent_knowledge.about /
   * specialties / delivery_options, when the caller has that joined in.
   * Not part of the dev-request's named field list, so it defaults to
   * empty and is purely additive to recall.
   */
  additionalText?: string | null;
};

export type SalgskanalCategoryMatch = {
  category: SalgskanalCategorySlug;
  matched: boolean;
  matched_keywords: string[];
  evidence_snippet: string | null;
};

// ─── Keyword tables (case-insensitive substring match on normalised text) ──
// Deliberately plain substring lists (not regex) — same style as
// organic-keyword-detector.ts's HIGH/MEDIUM/LOW tables. Whitespace in
// multi-word phrases matches literally because normalise() below collapses
// all whitespace runs to single spaces before matching.

const SELVPLUKK_KEYWORDS = [
  "selvplukk", "sjølplukk", "plukk selv", "plukke selv", "plukk sjøl", "plukke sjøl",
  "self-pick", "self pick", "pick-your-own", "pick your own",
];

const HJEMLEVERING_KEYWORDS = [
  "hjemlevering", "hjemlever", "heimlevering", "heimlever",
  "leverer hjem", "leverer helt hjem", "hjem til døra", "hjem til dora",
  "utkjøring", "utkjoring", "home delivery",
];

const GARDSBUTIKK_KEYWORDS = [
  "gårdsbutikk", "gardsbutikk", "gårdsutsalg", "gardsutsalg",
  "farm-shop", "farm shop",
];

// Gårdskafé/servering — precision-gated (see module header). "Strong"
// keywords are unambiguous claims of an own on-farm café and qualify
// alone; "weak" keywords need corroboration from the OTHER weak group.
const GARDSKAFE_STRONG_KEYWORDS = [
  "gårdskafé", "gårdskafe", "gardskafé", "gardskafe",
  "sommerkafé", "sommerkafe",
];
const GARDSKAFE_WEAK_CAFE_KEYWORDS = ["kafé", "kafe", "café", "cafe"];
const GARDSKAFE_WEAK_SERVERING_KEYWORDS = ["servering", "serverer", "serveres"];

const REKO_KEYWORDS = ["reko-ring", "reko ring", "rekoring", "reko-ringen", "reko ringen"];

// ─── Helpers ────────────────────────────────────────────────────────────

/** Lowercase + collapse whitespace. Keeps Norwegian characters as-is (no
 * transliteration — this is for MATCHING, not for a display/identifier). */
function normalise(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if any keyword in `keywords` occurs as a substring of `haystack`
 * (both already normalised/lowercased). Returns the list of keywords that
 * actually fired (for the evidence record), not just a boolean. */
function findHits(haystack: string, keywords: string[]): string[] {
  const hits: string[] = [];
  for (const k of keywords) {
    if (haystack.includes(k)) hits.push(k);
  }
  return hits;
}

/** First occurrence of `keyword` in `raw` (case-insensitive), returned as a
 * ~140-char snippet of the ORIGINAL (non-normalised) text so the evidence
 * record is human-readable. Mirrors organic-keyword-detector.ts's
 * buildSnippet(). Returns null if not found (shouldn't happen when called
 * with a keyword that already matched the normalised haystack, but the
 * raw/normalised strings can differ slightly in whitespace so we guard). */
function buildSnippet(raw: string, keyword: string): string | null {
  const idx = raw.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 60);
  const end = Math.min(raw.length, idx + keyword.length + 60);
  let snippet = raw.slice(start, end).trim();
  if (snippet.length > 200) snippet = snippet.slice(0, 200);
  return snippet;
}

function buildHaystack(input: SalgskanalMatchInput): { raw: string; normalised: string } {
  const parts = [
    input.name || "",
    input.description || "",
    (input.tags || []).join(" "),
    (input.skills || []).join(" "),
    input.additionalText || "",
  ].filter(Boolean);
  const raw = parts.join(" \n ").replace(/\s+/g, " ").trim();
  return { raw, normalised: normalise(raw) };
}

function matchOne(
  category: SalgskanalCategorySlug,
  raw: string,
  normalised: string,
): SalgskanalCategoryMatch {
  let matchedKeywords: string[] = [];
  let matched = false;

  switch (category) {
    case "selvplukk": {
      matchedKeywords = findHits(normalised, SELVPLUKK_KEYWORDS);
      matched = matchedKeywords.length > 0;
      break;
    }
    case "hjemlevering": {
      matchedKeywords = findHits(normalised, HJEMLEVERING_KEYWORDS);
      matched = matchedKeywords.length > 0;
      break;
    }
    case "gardsbutikk": {
      matchedKeywords = findHits(normalised, GARDSBUTIKK_KEYWORDS);
      matched = matchedKeywords.length > 0;
      break;
    }
    case "gardskafe-servering": {
      const strong = findHits(normalised, GARDSKAFE_STRONG_KEYWORDS);
      const weakCafe = findHits(normalised, GARDSKAFE_WEAK_CAFE_KEYWORDS);
      const weakServering = findHits(normalised, GARDSKAFE_WEAK_SERVERING_KEYWORDS);
      if (strong.length > 0) {
        matched = true;
        matchedKeywords = strong;
      } else if (weakCafe.length > 0 && weakServering.length > 0) {
        // >= 2 distinct signals (a café mention AND a serving mention) —
        // the precision guard from the dev-request's risk #1. A lone
        // "kafé i nærheten" (weakCafe only, no servering signal) falls
        // through to below_threshold here.
        matched = true;
        matchedKeywords = [...weakCafe, ...weakServering];
      } else {
        matchedKeywords = [...weakCafe, ...weakServering];
        matched = false;
      }
      break;
    }
    case "reko-ring": {
      matchedKeywords = findHits(normalised, REKO_KEYWORDS);
      matched = matchedKeywords.length > 0;
      break;
    }
  }

  // Dedup while preserving first-seen order (a phrase can appear in more
  // than one keyword list, e.g. "gardskafe" inside both a strong keyword
  // and incidentally as a substring elsewhere).
  matchedKeywords = Array.from(new Set(matchedKeywords));

  let evidence_snippet: string | null = null;
  for (const k of matchedKeywords) {
    const snippet = buildSnippet(raw, k);
    if (snippet) {
      evidence_snippet = snippet;
      break;
    }
  }

  return {
    category,
    matched,
    matched_keywords: matched ? matchedKeywords : [],
    evidence_snippet: matched ? evidence_snippet : null,
  };
}

// ─── Public matcher — pure function, no I/O ────────────────────────────
//
// Scans name/description/tags/skills (+ optional additionalText) and
// returns a verdict for EACH of the 5 categories (matched: true/false),
// so callers can both filter for matches and audit near-misses.
export function matchSalgskanalCategories(
  input: SalgskanalMatchInput,
): SalgskanalCategoryMatch[] {
  const { raw, normalised } = buildHaystack(input);
  if (!normalised) {
    return SALGSKANAL_CATEGORY_SLUGS.map((category) => ({
      category,
      matched: false,
      matched_keywords: [],
      evidence_snippet: null,
    }));
  }
  return SALGSKANAL_CATEGORY_SLUGS.map((category) => matchOne(category, raw, normalised));
}

// ─── Sweep — DB-touching wiring (mirrors runHanenScraper / ─────────────
// syncDebioVerifications' idempotent-upsert pattern) ────────────────────
//
// Loads the active producer corpus, matches each producer against all 5
// categories, and maintains agent_salgskanal so membership stays current
// without manual curation:
//   - matched categories  -> INSERT (source='auto') or, if an 'auto' row
//     already exists, REFRESH its matched_keywords/evidence_snippet/
//     updated_at. A 'manual' row for the same (agent, category) is NEVER
//     touched (admin override survives re-runs, per the dev-request's own
//     "koblingstabell ... source: auto|manual" requirement).
//   - categories that no longer match (e.g. a producer edited their
//     profile) -> the existing 'auto' row is deleted, so the table stays
//     accurate as descriptions change ("løpende vedlikeholdt uten manuell
//     kuratering"). 'manual' rows are, again, never deleted by the sweep.
//
// Runnable on demand (a future admin route) or on a periodic scheduler
// tick (src/index.ts) — see the dev-request's work item 2 ("kjøres som
// backfill + løpende (cron eller on-write)").
import { getDb } from "../database/init";

export type SalgskanalSweepResult = {
  examined: number;
  matched_total: number;
  upserted: number;
  refreshed: number;
  removed_stale: number;
  by_category: Record<SalgskanalCategorySlug, number>;
  errors: string[];
};

type ProducerRow = {
  id: string;
  name: string;
  description: string | null;
  tags: string | null;
  skills: string | null;
};

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function runSalgskanalSweep(opts?: {
  db?: ReturnType<typeof getDb>;
  nowIso?: string;
}): SalgskanalSweepResult {
  const db = opts?.db ?? getDb();
  const now = opts?.nowIso ?? new Date().toISOString();

  const result: SalgskanalSweepResult = {
    examined: 0,
    matched_total: 0,
    upserted: 0,
    refreshed: 0,
    removed_stale: 0,
    by_category: {
      selvplukk: 0,
      hjemlevering: 0,
      gardsbutikk: 0,
      "gardskafe-servering": 0,
      "reko-ring": 0,
    },
    errors: [],
  };

  let producers: ProducerRow[] = [];
  try {
    producers = db.prepare(
      "SELECT id, name, description, tags, skills FROM agents " +
      "WHERE is_active = 1 AND (umbrella_type IS NULL OR umbrella_type = '') " +
      "AND (role IS NULL OR role = 'producer')"
    ).all() as ProducerRow[];
  } catch (e) {
    result.errors.push(`producer corpus load failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  result.examined = producers.length;

  const selectExisting = db.prepare(
    "SELECT category_slug, source FROM agent_salgskanal WHERE agent_id = ?"
  );
  const insertAuto = db.prepare(`
    INSERT INTO agent_salgskanal
      (agent_id, category_slug, source, matched_keywords, evidence_snippet, created_at, updated_at)
    VALUES (?, ?, 'auto', ?, ?, ?, ?)
  `);
  const refreshAuto = db.prepare(`
    UPDATE agent_salgskanal
    SET matched_keywords = ?, evidence_snippet = ?, updated_at = ?
    WHERE agent_id = ? AND category_slug = ? AND source = 'auto'
  `);
  const deleteStaleAuto = db.prepare(
    "DELETE FROM agent_salgskanal WHERE agent_id = ? AND category_slug = ? AND source = 'auto'"
  );

  for (const p of producers) {
    let verdicts: SalgskanalCategoryMatch[];
    try {
      verdicts = matchSalgskanalCategories({
        name: p.name,
        description: p.description,
        tags: parseJsonArray(p.tags),
        skills: parseJsonArray(p.skills),
      });
    } catch (e) {
      result.errors.push(`match failed for agent ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let existingRows: Array<{ category_slug: SalgskanalCategorySlug; source: "auto" | "manual" }> = [];
    try {
      existingRows = selectExisting.all(p.id) as Array<{ category_slug: SalgskanalCategorySlug; source: "auto" | "manual" }>;
    } catch (e) {
      result.errors.push(`existing-rows load failed for agent ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const existingBySlug = new Map(existingRows.map((r) => [r.category_slug, r.source]));

    for (const v of verdicts) {
      const existingSource = existingBySlug.get(v.category);

      if (v.matched) {
        result.matched_total++;
        result.by_category[v.category]++;
        if (existingSource === "manual") {
          // Admin override — never touched by the auto sweep.
          continue;
        }
        try {
          const keywordsJson = JSON.stringify(v.matched_keywords);
          if (existingSource === "auto") {
            refreshAuto.run(keywordsJson, v.evidence_snippet, now, p.id, v.category);
            result.refreshed++;
          } else {
            insertAuto.run(p.id, v.category, keywordsJson, v.evidence_snippet, now, now);
            result.upserted++;
          }
        } catch (e) {
          result.errors.push(`upsert failed for agent ${p.id} category ${v.category}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (existingSource === "auto") {
        // No longer matches and the row was matcher-written — remove it
        // so membership reflects the current profile text. Manual rows
        // are left untouched even when the matcher would no longer agree.
        try {
          deleteStaleAuto.run(p.id, v.category);
          result.removed_stale++;
        } catch (e) {
          result.errors.push(`stale-removal failed for agent ${p.id} category ${v.category}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return result;
}

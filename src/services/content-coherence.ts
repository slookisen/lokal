// ─── content-coherence: profile-vs-homepage coherence gate (PR-B) ────────────
//
// PURE, deterministic brain for the content-coherence outreach gate. It answers
// ONE question: does a producer's STORED profile content
// (about / products / categories / description) CONTRADICT what the producer's
// OWN homepage says about itself? If so, the verifier downgrades the producer to
// `review_required` and the outreach endpoint suppresses it — so we never
// cold-email a producer whose profile is wrong about its own business.
//
// This rides on PR-A's homepage CONTENT extraction: the homepage signals here
// (businessTypeTokens / productMentions / aboutSummary) are exactly the shape
// PR-A's `content_signals` produces from a CONFIRMED producer homepage, and the
// distinctive-vs-benign lexicon split is reused from cross-source-validator so
// the calibration that keeps the 24 domain_coherence false-positives in check
// is shared rather than re-litigated.
//
// DESIGN PRINCIPLES (all four are HARD constraints of the gate):
//   1. A `conflict` requires a DISTINCTIVE SPECIALIST MISMATCH. Only the curated
//      distinctive tokens (andelslandbruk, besøkshage, ysteri, …) and the hard
//      food-type categories they map to can ever produce a conflict. The benign
//      gård-family tokens (gard, mat, frukt, bruk …) NEVER conflict — a leftover
//      "gård" on a farm's own page is fully expected.
//   2. Conservative by default. Anything we cannot confidently read as a
//      contradiction is `coherent`. Same philosophy as cross-source-validator's
//      `pageMentionsProducer`: we never downgrade what we cannot judge.
//   3. No homepage signal → `no_homepage_signal` (advisory only; the caller must
//      NOT suppress on it — that would mass-quarantine legitimately
//      homepage-less producers).
//   4. This axis is SEPARATE from address/phone domain_coherence. It compares
//      CONTENT (what the producer sells / is), never address/phone, so it cannot
//      widen the existing domain_coherence false-positive set.
//
// PURE: no network, no LLM, no DB. Same input → same output.

import {
  DISTINCTIVE_SPECIALIST_TOKENS,
  BENIGN_BUSINESS_TOKENS,
} from "./cross-source-validator";

// ─── public types ────────────────────────────────────────────────────────────

export type ContentCoherenceVerdict = "coherent" | "conflict" | "no_homepage_signal";

export interface ContentCoherenceResult {
  verdict: ContentCoherenceVerdict;
  /** Human-readable conflict descriptors, e.g. "meat≠andelslandbruk(vegetables)". */
  conflicts: string[];
  /** Categories the homepage CORROBORATES (present on both sides). */
  corroborated: string[];
  /** Short machine-ish reason for observability; optional. */
  reason?: string;
}

/** Homepage CONTENT signals — exactly PR-A's `content_signals` shape (subset). */
export interface HomepageContentSignals {
  /** Distinctive/benign business-type tokens found on the page (accent-stripped). */
  businessTypeTokens: string[];
  /** Normalized platform category hits (vegetables, meat, fish, …). */
  productMentions: string[];
  /** Deterministic extractive about summary, or undefined/"". */
  aboutSummary?: string;
}

/** Stored profile content (free text + arrays-or-CSV). */
export interface StoredContent {
  about?: string;
  products?: string[] | string;
  categories?: string[] | string;
  description?: string;
}

// ─── local accent/normalization helpers (aligned with cross-source-validator) ─
//
// Kept local + dependency-free so this module is a leaf importer of
// cross-source-validator (only the two token Sets). Same transliteration the
// name/email matchers use: å→a, æ→ae, ø→o, NFD diacritic strip, plus the
// 'aa'→'a' digraph collapse so "gaard" ≡ "gård"→"gard".
function stripAccents(s: string): string {
  return s
    .replace(/å/g, "a").replace(/Å/g, "a")
    .replace(/æ/g, "ae").replace(/Æ/g, "ae")
    .replace(/ø/g, "o").replace(/Ø/g, "o")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
function collapseAa(s: string): string {
  return s.replace(/(?<!a)aa(?!a)/g, "a");
}
function norm(s: string): string {
  return collapseAa(stripAccents((s || "").toLowerCase()));
}

// Benign gård-family tokens (BENIGN_BUSINESS_TOKENS) are never tested directly:
// the gate is structurally distinctive-only — a conflict can ONLY be driven by a
// DISTINCTIVE token, so a benign token can never produce one. BENIGN_BUSINESS_TOKENS
// is still imported because extractBusinessTypeTokensForCoherence() reports benign
// tokens too (provenance/observability symmetry with PR-A's extractor).
function isDistinctive(tok: string): boolean {
  const t = norm(tok);
  return DISTINCTIVE_SPECIALIST_TOKENS.has(t) || DISTINCTIVE_SPECIALIST_TOKENS.has(collapseAa(t));
}

// ─── category lexicon (mirrors search-enrich CONTENT_CATEGORY_LEXICON / the
// platform's 10 canonical categories) ────────────────────────────────────────
//
// Used to map BOTH free text and array values to the normalized platform
// categories so stored and homepage are compared on the same ground. Kept local
// (accent-stripped at match time) so this stays a leaf module. The 10 keys MUST
// match the platform set: vegetables, fruit, berries, dairy, eggs, meat, fish,
// bread, honey, herbs.
const CATEGORY_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["vegetables", [
    "vegetables", "gronnsaker", "gronnsak", "gront", "poteter", "potet",
    "gulrotter", "gulrot", "lok", "kal", "tomat", "tomater", "agurk",
    "brokkoli", "blomkal", "squash", "paprika", "selleri", "purre", "spinat",
    "salat", "reddik", "gresskar", "mais", "erter", "bonner", "rodbeter",
    "nepe", "pastinakk", "andelslandbruk",
  ]],
  ["fruit", [
    "fruit", "frukt", "epler", "eple", "parer", "pare", "plommer", "plomme",
    "kirsebar", "moreller", "druer",
  ]],
  ["berries", [
    "berries", "bar", "jordbar", "blabar", "bringebar", "tyttebar",
    "solbar", "rips", "stikkelsbar", "multe", "multer", "markjordbar",
  ]],
  ["dairy", [
    "dairy", "meieri", "melk", "ost", "smor", "yoghurt", "flote", "romme",
    "brunost", "hvitost", "geitost", "pultost", "gamalost", "smoreost",
    "ysteri", "ysteriet",
  ]],
  ["eggs", ["eggs", "egg", "frittgaende"]],
  ["meat", [
    "meat", "kjott", "lam", "lammekjott", "svin", "svinekjott", "storfe",
    "storfekjott", "kylling", "vilt", "elg", "hjort", "rein", "reinsdyr",
    "polser", "spekemat", "fenalar", "ribbe", "pinnekjott", "geit", "geitekjott",
    "slakteri",
  ]],
  ["fish", [
    "fish", "fisk", "sjomat", "laks", "torsk", "reker", "krabbe", "blaskjell",
    "orret", "roye", "sei", "hyse", "kveite", "steinbit", "torrfisk",
    "klippfisk", "lutefisk", "rakfisk", "gravlaks",
  ]],
  ["bread", [
    "bread", "brod", "bakervarer", "bakeri", "lefse", "lefser", "flatbrod",
    "rundstykker", "boller", "kanelboller", "surdeig", "grovbrod",
  ]],
  ["honey", ["honey", "honning", "birokt"]],
  ["herbs", ["herbs", "urter", "krydder", "dill", "persille", "basilikum", "timian"]],
];

// Distinctive business-type tokens → the category they unambiguously imply.
// ONLY tokens whose business type maps to a single hard food category are listed
// (so "besøkshage"/"hagekonsulent" — a service axis, handled separately — and
// generic ones like "kafe"/"kro" are deliberately absent). This is the bridge
// that lets a homepage that says "andelslandbruk" contradict a stored "meat".
const DISTINCTIVE_TOKEN_CATEGORY: ReadonlyMap<string, string> = new Map([
  ["andelslandbruk", "vegetables"],
  ["gartneri", "vegetables"],
  ["ysteri", "dairy"], ["ysteriet", "dairy"],
  ["meieri", "dairy"], ["meieriet", "dairy"],
  ["bakeri", "bread"], ["bakeriet", "bread"],
  ["slakteri", "meat"],
  ["kjott", "meat"],
  ["fisk", "fish"],
  ["vingard", "fruit"], ["vingaard", "fruit"],
]);

// HARD food-type categories that are MUTUALLY EXCLUSIVE as a PRIMARY business
// type. A producer can plausibly do several plant categories together
// (vegetables/fruit/berries/herbs), so those share one "plant" bucket and never
// contradict each other. But a distinctively-vegetable (andelslandbruk) homepage
// genuinely contradicts a stored "meat"/"fish" primary, etc. Categories NOT in a
// bucket here (eggs, honey — common farm sidelines) never drive a conflict.
const EXCLUSIVE_BUCKET: ReadonlyMap<string, string> = new Map([
  ["vegetables", "plant"], ["fruit", "plant"], ["berries", "plant"], ["herbs", "plant"],
  ["meat", "meat"],
  ["fish", "fish"],
  ["dairy", "dairy"],
  ["bread", "bread"],
]);

// The besøkshage ↔ hagekonsulent SERVICE axis (Ingunnshage): a visiting garden
// (produce / pick-your-own) is a fundamentally different business from a garden
// CONSULTANCY service. These two distinctive tokens directly contradict.
const SERVICE_AXIS_CONFLICTS: ReadonlyArray<readonly [string, string]> = [
  ["besokshage", "hagekonsulent"],
];

// ─── extraction from stored content ──────────────────────────────────────────

/** Flatten a string | string[] | undefined into a single lowercased text blob. */
function toText(v: string[] | string | undefined): string {
  if (!v) return "";
  if (Array.isArray(v)) return v.join(" ");
  // Tolerate a JSON-array string ('["meat","eggs"]') or a CSV — just dump the
  // raw text; the category matcher is word-boundary based so brackets/quotes are
  // harmless separators.
  return String(v);
}

/** All stored content as one normalized haystack. */
function storedHaystack(stored: StoredContent): string {
  return norm(
    [
      stored.about ?? "",
      stored.description ?? "",
      toText(stored.products),
      toText(stored.categories),
    ].join(" \n "),
  );
}

/** Categories implied by a normalized text haystack (word-boundary matches). */
function categoriesFromText(hayNorm: string): Set<string> {
  const out = new Set<string>();
  if (!hayNorm) return out;
  for (const [category, keywords] of CATEGORY_LEXICON) {
    for (const kw of keywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(hayNorm)) {
        out.add(category);
        break;
      }
    }
  }
  return out;
}

/** Distinctive tokens present in a normalized text haystack. */
function distinctiveTokensInText(hayNorm: string): Set<string> {
  const out = new Set<string>();
  if (!hayNorm) return out;
  for (const tok of DISTINCTIVE_SPECIALIST_TOKENS) {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(hayNorm)) out.add(tok);
  }
  return out;
}

// ─── homepage-signal reconstruction helpers (used by the verifier) ───────────
//
// The verifier does not have PR-A's in-memory `content_signals`; it only has the
// persisted field_provenance. These PURE helpers let it rebuild the homepage
// signals from the raw website_homepage provenance VALUES (free text / category
// strings) using the SAME lexicon as the gate, so reconstruction and judging
// stay perfectly aligned. Exported so they can be unit-tested too.

/** Distinctive/benign business-type tokens present in a free-text blob. */
export function extractBusinessTypeTokensForCoherence(text: string): string[] {
  const hay = norm(text || "");
  if (!hay) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const set of [DISTINCTIVE_SPECIALIST_TOKENS, BENIGN_BUSINESS_TOKENS]) {
    for (const tok of set) {
      if (seen.has(tok)) continue;
      const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(hay)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }
  return out;
}

/**
 * Normalized platform categories present in a free-text blob (e.g. a stored
 * categories value, a product list, or a homepage about value). Accepts either a
 * raw category KEY ("vegetables") or Norwegian product nouns ("grønnsaker").
 */
export function extractProductCategoriesForCoherence(text: string): string[] {
  const hay = norm(text || "");
  if (!hay) return [];
  return [...categoriesFromText(hay)];
}

// ─── the gate ────────────────────────────────────────────────────────────────

/**
 * Compare STORED profile content against the producer's HOMEPAGE signals.
 *
 *   homepage null/empty            → "no_homepage_signal" (advisory only)
 *   distinctive specialist mismatch→ "conflict"
 *   everything else                → "coherent" (conservative default)
 *
 * PURE / deterministic. See module header for the full constraint list.
 */
export function contentCoherenceCheck(
  stored: StoredContent,
  homepage: HomepageContentSignals | null,
): ContentCoherenceResult {
  // ── (0) No homepage signal → advisory only, NEVER a conflict ───────────────
  const hpTokensRaw = (homepage?.businessTypeTokens ?? []).map(norm).filter(Boolean);
  const hpMentions = (homepage?.productMentions ?? []).map((m) => norm(m)).filter(Boolean);
  const hpAbout = norm(homepage?.aboutSummary ?? "");
  const homepageEmpty =
    !homepage ||
    (hpTokensRaw.length === 0 && hpMentions.length === 0 && hpAbout.trim() === "");
  if (homepageEmpty) {
    return {
      verdict: "no_homepage_signal",
      conflicts: [],
      corroborated: [],
      reason: "homepage_no_content_signal",
    };
  }

  // ── (1) build category + distinctive-token sets for BOTH sides ─────────────
  const storedHay = storedHaystack(stored);
  const storedCats = categoriesFromText(storedHay);
  const storedDistinctive = distinctiveTokensInText(storedHay);

  // Homepage categories: explicit productMentions (already normalized to keys),
  // PLUS categories the homepage's distinctive tokens unambiguously imply, PLUS
  // anything the aboutSummary text mentions. (businessTypeTokens that are only
  // benign add nothing here — by design.)
  const homepageCats = new Set<string>();
  for (const m of hpMentions) if (EXCLUSIVE_BUCKET.has(m) || CATEGORY_LEXICON.some(([k]) => k === m)) homepageCats.add(m);
  for (const t of hpTokensRaw) {
    const cat = DISTINCTIVE_TOKEN_CATEGORY.get(t) ?? DISTINCTIVE_TOKEN_CATEGORY.get(collapseAa(t));
    if (cat) homepageCats.add(cat);
  }
  for (const c of categoriesFromText(hpAbout)) homepageCats.add(c);

  const homepageDistinctive = new Set<string>(hpTokensRaw.filter((t) => isDistinctive(t)));
  // aboutSummary may also carry a distinctive token (e.g. "andelslandbruk").
  for (const t of distinctiveTokensInText(hpAbout)) homepageDistinctive.add(t);

  // ── (2) corroboration (for reporting + to suppress false conflicts) ────────
  const corroborated: string[] = [];
  for (const c of storedCats) if (homepageCats.has(c)) corroborated.push(c);

  // ── (3) DISTINCTIVE specialist mismatch detection ──────────────────────────
  // A conflict needs a DISTINCTIVE signal driving it — never benign overlap.
  const conflicts: string[] = [];

  // (3a) SERVICE-axis direct token contradiction (besøkshage ↔ hagekonsulent).
  for (const [a, b] of SERVICE_AXIS_CONFLICTS) {
    const storedHasA = storedDistinctive.has(a);
    const storedHasB = storedDistinctive.has(b);
    const hpHasA = homepageDistinctive.has(a);
    const hpHasB = homepageDistinctive.has(b);
    // Conflict when the two sides land on OPPOSITE ends of the axis.
    if ((storedHasB && hpHasA) || (storedHasA && hpHasB)) {
      const storedTok = storedHasA ? a : b;
      const hpTok = hpHasA ? a : b;
      conflicts.push(`${storedTok}≠${hpTok}`);
    }
  }

  // (3b) HARD food-type bucket contradiction, driven by a DISTINCTIVE homepage
  // signal. The homepage must distinctively assert a food type (via a
  // distinctive token, OR a productMention that maps to an exclusive bucket),
  // and the stored side must assert a DIFFERENT exclusive bucket that the
  // homepage does NOT corroborate. This is what catches:
  //   - Grette: stored meat   vs homepage andelslandbruk→vegetables(plant)
  //   - Bomstad: stored fish  vs homepage geit→meat (goat page)
  //   - Fløy:   stored bread  vs homepage distinctively another type
  // Buckets, not raw categories, so plant sidelines (veg+fruit+berries) never
  // self-conflict and eggs/honey never drive a conflict.
  const homepageBuckets = new Set<string>();
  for (const c of homepageCats) {
    const b = EXCLUSIVE_BUCKET.get(c);
    if (b) homepageBuckets.add(b);
  }
  // Only treat the homepage as having a DISTINCTIVE food assertion when its
  // bucket is backed by a distinctive token OR an explicit productMention (not
  // merely an incidental about-text word) — keeps benign/ambiguous pages from
  // ever driving a conflict.
  const homepageDistinctiveBuckets = new Set<string>();
  for (const t of homepageDistinctive) {
    const cat = DISTINCTIVE_TOKEN_CATEGORY.get(t) ?? DISTINCTIVE_TOKEN_CATEGORY.get(collapseAa(t));
    const b = cat ? EXCLUSIVE_BUCKET.get(cat) : undefined;
    if (b) homepageDistinctiveBuckets.add(b);
  }
  for (const m of hpMentions) {
    const b = EXCLUSIVE_BUCKET.get(m);
    if (b) homepageDistinctiveBuckets.add(b);
  }

  if (homepageDistinctiveBuckets.size > 0) {
    const storedBuckets = new Set<string>();
    for (const c of storedCats) {
      const b = EXCLUSIVE_BUCKET.get(c);
      if (b) storedBuckets.add(b);
    }
    for (const sb of storedBuckets) {
      // Stored asserts an exclusive bucket the homepage does NOT have at all,
      // AND the homepage distinctively asserts a DIFFERENT exclusive bucket.
      if (!homepageBuckets.has(sb)) {
        const opposing = [...homepageDistinctiveBuckets].filter((hb) => hb !== sb);
        if (opposing.length > 0) {
          conflicts.push(`${sb}≠${opposing.join("/")}`);
        }
      }
    }
  }

  if (conflicts.length > 0) {
    // Dedupe while preserving order.
    const seen = new Set<string>();
    const deduped = conflicts.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
    return {
      verdict: "conflict",
      conflicts: deduped,
      corroborated,
      reason: "distinctive_specialist_mismatch",
    };
  }

  // ── (4) conservative default ───────────────────────────────────────────────
  return {
    verdict: "coherent",
    conflicts: [],
    corroborated,
    reason: corroborated.length > 0 ? "corroborated" : "no_distinctive_conflict",
  };
}

// ─── Location-suffix parser (Phase 5.11 C.2 PR-67, 2026-05-17) ──────
//
// Many Hanen producer-agent names ship with a location suffix appended
// after an em-dash, en-dash, hyphen, or in parentheses:
//
//   "Lerum Konserves — Sogndal"
//   "Olavsbu Seter - Hemsedal"
//   "Heim Gård — Hol, Hallingdal"
//   "Bratabu (Lyngdal)"
//
// PR-67 turns those suffixes into a secondary location signal so the
// matcher can corroborate (or fall back from) the agent's `city` field
// when the agent table itself lacks a city / kommune mapping. Pure
// string utility — no DB, no I/O, no deps.
//
// Contract:
//   parseNameLocationSuffix(name): { core_name, location_hint }
//
//   - core_name: the input with the suffix stripped (trimmed). Empty
//                input → "". If no suffix detected → original input
//                (trimmed).
//   - location_hint: the suffix text, normalised (lowercase, accents
//                stripped, single-spaced). null when no suffix was
//                detected. Multi-part suffixes like "Hol, Hallingdal"
//                are kept verbatim (the matcher tries comma-split when
//                resolving fylke).
//
// Detection rules (first match wins):
//   1. `name = main + " — " + suffix`  (em-dash, U+2014)
//   2. `name = main + " – " + suffix`  (en-dash, U+2013)
//   3. `name = main + " - " + suffix`  (ASCII hyphen, REQUIRES surrounding
//      whitespace so it doesn't eat hyphenated farm names like
//      "Olav-Gard")
//   4. `name = main + " (" + suffix + ")"`  (parenthesised, end-of-string)
//
// Negative cases (return location_hint=null):
//   - "Foo"                                (no separator)
//   - "Foo-Bar"                            (hyphen with no whitespace)
//   - "Foo (kort beskrivelse av gården)"   (parens longer than 30 chars)
//   - ""                                   (empty input)
//
// Length guard: location hints longer than 60 characters are rejected
// (we'd otherwise pick up tag-lines or descriptions). 60 covers
// "Hol, Hallingdal" + "Sogn og Fjordane" with margin.

const MAX_HINT_LENGTH = 60;
const MAX_PAREN_LENGTH = 30;

function normaliseHint(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseNameLocationSuffix(name: string | null | undefined): {
  core_name: string;
  location_hint: string | null;
} {
  if (!name) return { core_name: "", location_hint: null };
  const trimmed = name.trim();
  if (!trimmed) return { core_name: "", location_hint: null };

  // 1. Em-dash separator: " — " (with whitespace).
  const emDash = / — (.+)$/.exec(trimmed);
  if (emDash) {
    const hint = emDash[1].trim();
    if (hint.length > 0 && hint.length <= MAX_HINT_LENGTH) {
      const core = trimmed.slice(0, trimmed.length - emDash[0].length).trim();
      if (core.length > 0) {
        return { core_name: core, location_hint: normaliseHint(hint) };
      }
    }
  }

  // 2. En-dash separator: " – " (with whitespace).
  const enDash = / – (.+)$/.exec(trimmed);
  if (enDash) {
    const hint = enDash[1].trim();
    if (hint.length > 0 && hint.length <= MAX_HINT_LENGTH) {
      const core = trimmed.slice(0, trimmed.length - enDash[0].length).trim();
      if (core.length > 0) {
        return { core_name: core, location_hint: normaliseHint(hint) };
      }
    }
  }

  // 3. ASCII hyphen with surrounding whitespace: " - "
  //    Required whitespace prevents hyphenated farm names from matching.
  const hyphen = / - (.+)$/.exec(trimmed);
  if (hyphen) {
    const hint = hyphen[1].trim();
    if (hint.length > 0 && hint.length <= MAX_HINT_LENGTH) {
      const core = trimmed.slice(0, trimmed.length - hyphen[0].length).trim();
      if (core.length > 0) {
        return { core_name: core, location_hint: normaliseHint(hint) };
      }
    }
  }

  // 4. Parenthesised tail: "Name (Suffix)".
  //    Bounded to MAX_PAREN_LENGTH so descriptions aren't mistaken
  //    for locations. End-of-string anchor.
  const paren = /\s*\(([^()]{1,30})\)\s*$/.exec(trimmed);
  if (paren) {
    const hint = paren[1].trim();
    if (hint.length > 0 && hint.length <= MAX_PAREN_LENGTH) {
      const core = trimmed.slice(0, trimmed.length - paren[0].length).trim();
      if (core.length > 0) {
        return { core_name: core, location_hint: normaliseHint(hint) };
      }
    }
  }

  return { core_name: trimmed, location_hint: null };
}

// ─── domain normaliser ─────────────────────────────────────────
// Domain corroboration (PR-67 signal C). Strip protocol, www., paths,
// trailing slashes, and lowercase. Returns empty string for bad input.
// Use domainsMatch(a, b) for the comparison.
//
//   normaliseDomain("https://www.bratabu.no/")   → "bratabu.no"
//   normaliseDomain("HTTP://Bratabu.no")         → "bratabu.no"
//   normaliseDomain("bratabu.no/path?q=1")       → "bratabu.no"
//   normaliseDomain("")                          → ""
//   normaliseDomain(null)                        → ""

export function normaliseDomain(url: string | null | undefined): string {
  if (!url) return "";
  let s = String(url).trim().toLowerCase();
  if (!s) return "";
  // Strip protocol
  s = s.replace(/^https?:\/\//, "");
  // Strip www.
  s = s.replace(/^www\./, "");
  // Drop everything after the first slash, question mark, hash, or whitespace.
  s = s.split(/[\s/?#]/)[0] || "";
  // Drop trailing dot (unusual, but valid DNS).
  s = s.replace(/\.$/, "");
  return s;
}

export function domainsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normaliseDomain(a);
  const nb = normaliseDomain(b);
  if (!na || !nb) return false;
  return na === nb;
}

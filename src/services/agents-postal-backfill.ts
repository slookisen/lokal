// ─── RFB Postal-Code Backfill Worker ────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a
// follow-up. Daniel, in-session 2026-07-25:
//   «Kan du lage en fiks for å finne postnummer på de som mangler kun dette?»
//
// WHY
// ───
// Fase 1a's agents-geocode-worker.ts reaches Tier A — real `geo_precision =
// 'address'`, the ONLY tier the honesty rule (geo-precision.ts) lets state a km
// figure — only when a producer has BOTH `agent_knowledge.address` AND
// `agent_knowledge.postal_code`. A measured census (n = 250 of 1 523 active RFB
// producers, uniform random, 2026-07-25) found:
//
//   68.8 %  street + postnummer          → Tier-A eligible today
//   13.2 %  street but NO postnummer     → blocked from address precision by a
//                                          missing FOUR-DIGIT NUMBER, nothing else
//   21.2 %  neither
//
// That middle band (~200 producers platform-wide) is the cheapest precision
// this platform can buy. This worker buys it: resolve the postnummer from
// Kartverket, write it back, and the Fase-1a geocode worker places the row at
// address precision on its next pass — no change to that worker at all.
//
// THE ONE RULE THAT OUTRANKS YIELD
// ────────────────────────────────
// NEVER WRITE A WRONG POSTNUMMER. A wrong postnummer does not degrade
// gracefully: it produces a *precise* coordinate that gets tagged
// `geo_precision='address'`, which then LICENSES a km figure — the exact class
// of fabricated-precision harm this whole dev-request exists to remove
// («blåskjell Kautokeino» → Larvik, 1 400 km). Every ambiguous, partial or
// uncorroborated case therefore refuses and stamps. Writing nothing is always
// the correct fallback; the row simply stays where it already was.
//
// HOW THE MATCH WORKS (and why it is safe)
// ────────────────────────────────────────
// Kartverket's adresser/v1/sok is STRICTLY CONJUNCTIVE, not fuzzy — verified
// live while building this (see the probe log in the slice report):
//     sok=Storgata 5             → totaltAntallTreff 102
//     sok=Storgata 5 Oslo        → 1   (postnummer 0155)
//     sok=Storgata 5 Bergen      → 0   (no such address in Bergen — a WRONG
//                                       poststed yields zero, not a near miss)
//     sok=Kirkeveien Oslo        → 123 spanning 0266, 0361, … (a long street
//                                       really does span several postnummer)
// So "street + place" is a usable probe, and the failure mode of a wrong place
// is 0 hits (refuse), not a plausible-looking wrong hit. Four guards sit on top:
//
//   G1 ENUMERABILITY. treffPerSide=100 and the result is refused outright if
//      `totaltAntallTreff` exceeds what came back. We never judge uniqueness
//      from a truncated page.
//   G2 UNIQUENESS. The DISTINCT set of `postnummer` across the whole result
//      must be exactly one. `Kirkeveien Oslo` (123 hits, many postnummer) and
//      any address missing its house number refuse here. Several hits sharing
//      ONE postnummer (e.g. Storgata 5A / 5B) are fine — that is not ambiguity.
//   G3 CORROBORATION. The hit's own `poststed` OR `kommunenavn` must match the
//      place token we searched with. This is the same-street-name-in-another-
//      town guard the brief asked about, and the answer is: yes, cross-check,
//      because the conjunctive match alone only proves the token appeared in
//      SOME field — `adressenavn` and `adressetilleggsnavn` (farm names!) are
//      searched too, so `sok=Bøveien 3 Bø` can match on the street's own name
//      rather than on the place. G3 costs almost no yield (a hit found VIA the
//      place token normally carries it in poststed/kommunenavn) and removes the
//      entire false-positive class. kommunenavn is accepted alongside poststed
//      because RFB's `city` is as often a kommune as a poststed. The comparison
//      allows ONE character of slack on names of 5+ characters — measured
//      necessity, not politeness: `sok=Norafjordvegen 977 Slinde` returns the
//      globally unique address whose poststed is spelled "SLINDA", and
//      definite/indefinite forms differing by one trailing vowel are everywhere
//      in Norwegian place names. Short names, where one edit is a different
//      place entirely (Bø/Bo, Vik/Vok), still require an exact match.
//   G4 CROSS-CANDIDATE AGREEMENT. RFB's `city` is documented-polluted
//      (city-normalizer.ts:10-21) and frequently compound — "Mjøndalen/Drammen",
//      "Frogn", "Bergen, Norge". We derive several place candidates, probe each,
//      and accept only if every candidate that resolved agrees on ONE
//      postnummer. Two candidates disagreeing = ambiguous = refuse. This is what
//      stops us from silently picking Drammen when the farm is in Mjøndalen.
//
// THE HIGH-YIELD PATH: an inline postnummer, VERIFIED
// ──────────────────────────────────────────────────
// Measured against live prod: most of this cohort's addresses already CONTAIN
// the postnummer, just never parsed out of the free-text field —
// "Garderveien 20, 1455 Nordre Frogn" with postal_code empty. We do NOT trust
// that string on its own (it is scraped text and could be a house number, a
// year, or plain wrong). We treat it as a HYPOTHESIS and verify it against
// Kartverket exactly like any other candidate: query `street + NNNN` and require
// G1/G2 to hold and the resulting postnummer to EQUAL the hypothesis. A scraped
// digit string that Kartverket does not confirm is discarded, not written.
//
// THE LAST-RESORT TIER: a GLOBALLY UNIQUE street address
// ──────────────────────────────────────────────────────
// The single biggest refusal reason measured on live prod is not ambiguity —
// it is that `city` is NULL and the address carries no trailing place either,
// so there is no token to search WITH ("Borgestadveien 23A"). For those, one
// last probe asks whether the street + house number identifies exactly ONE
// address in all of Norway. If it does there is nothing to disambiguate, and
// the producer's own address field already named that address uniquely.
// Crucially this tier runs ONLY when no earlier probe was refused: a query that
// already produced an ambiguous or uncorroborated result must stay refused, or
// the fallback would quietly answer with the very record G2/G3 just rejected.
//
// PROVENANCE (so a later reader can tell these apart from scraped values)
// ──────────────────────────────────────────────────────────────────────
//   agent_knowledge.postal_code_source  — 'kartverket_adresse_inline'
//                                         (a number already in the address
//                                          text, Kartverket-confirmed)
//                                       | 'kartverket_adresse_sok'
//                                         (derived from street + place)
//                                       | 'kartverket_adresse_unik'
//                                         (street is globally unique in Norway)
//   agent_knowledge.postal_code_prev    — whatever stood in postal_code before
//                                         this worker touched it, mirroring
//                                         Fase 1a's agents.geocode_prev_lat/lng
//                                         rollback latch. One generation deep.
//
// OPERATIONAL SHAPE (identical to the Fase-1a worker, deliberately)
//   • additive + idempotent migration for the four new columns
//   • ALWAYS STAMP: postal_backfill_attempted_at is written on EVERY attempt,
//     including refusals AND the error path, and the selector orders by it.
//     Fase 1a took TWO review blockers for exactly this (a selector keyed on a
//     column the failure paths never wrote re-picked the identical batch
//     forever); it is not repeated here.
//   • NEVER OVERWRITE: the UPDATE itself carries
//     `AND (postal_code IS NULL OR TRIM(postal_code) = '')`, so even a selector
//     bug cannot clobber a postnummer we already had.
//   • single-flight guard (hourly tick vs. admin POST overlapping)
//   • dry_run is a STRICT boolean — reuses parseDryRunFlag() from the Fase-1a
//     worker, where `{"dry_run":"true"}` once performed a real prod write
//   • X-Admin-Key endpoint with a clamped limit (clampGeocodeBatchLimit)
//   • hourly tick + boot tick registered in src/index.ts
//   • disable with RFB_DISABLE_POSTAL_BACKFILL=1
//
// Rate limiting: THROTTLE_MS (350 ms) after EVERY Kartverket request, same
// courtesy pacing as dental-geocode-worker.ts. Volume here is ~200 rows total,
// once — this worker goes quiet by itself.

import { getDb } from "../database/init";
import { transliterate, stripHouseLetterSuffix, type GeocodeDeps } from "./dental-geocode-worker";
import { normalizeCityLabel } from "./city-normalizer";

const KARTVERKET_BASE = "https://ws.geonorge.no/adresser/v1/sok";
const THROTTLE_MS = 350;

/**
 * Page size for the uniqueness probe (G1). 100 is generous — a street+place
 * query that returns more than this is not something we could ever call
 * unambiguous anyway. Verified live: treffPerSide=200 is accepted by the API
 * and `sok=Storgata 5` returns all 102 hits, so 100 is a real cap and not an
 * API-imposed one.
 */
const PAGE_SIZE = 100;

/** Max distinct place candidates probed per row — bounds the API cost. */
const MAX_PLACE_CANDIDATES = 3;

export type PostalBackfillDeps = GeocodeDeps & {
  /** Report what would change; write nothing (not even the attempt stamp). */
  dryRun?: boolean;
};

/** One Kartverket address record, reduced to the fields this worker judges on. */
export type AddressHit = {
  postnummer: string;
  poststed: string;
  kommunenummer: string;
  kommunenavn: string;
  adressetekst: string;
};

export type PostalProbeResult =
  | { status: "resolved"; postal_code: string; hit: AddressHit; query: string; hits: number }
  | { status: "ambiguous"; distinct: string[]; query: string; hits: number }
  | { status: "not_enumerable"; total: number; query: string }
  | { status: "uncorroborated"; query: string; hits: number }
  | { status: "no_match"; query: string };

export type PostalResolution =
  | {
      status: "resolved";
      postal_code: string;
      source: "kartverket_adresse_inline" | "kartverket_adresse_sok" | "kartverket_adresse_unik";
      poststed: string;
      kommunenummer: string;
      kommunenavn: string;
      matched_query: string;
    }
  | { status: "ambiguous"; detail: string }
  | { status: "no_match"; detail: string }
  | { status: "unusable_input"; detail: string };

// ── Address parsing ─────────────────────────────────────────────────

/**
 * Split a free-text address into the street part and the extra place/postal
 * tokens that trail it.
 *
 * RFB's `agent_knowledge.address` is scraped free text and comes in at least
 * these shapes (all observed live on prod 2026-07-25):
 *   "Homme 10"
 *   "Garderveien 20, 1455 Nordre Frogn"
 *   "Torvet 11, Arendal"
 *   "Strømgaten 8, 5015 Bergen, Norge"
 *
 * Everything before the first comma is the street. Everything after it is
 * mined for (a) a 4-digit postnummer HYPOTHESIS and (b) additional place
 * candidates. Nothing mined here is trusted — it all goes through the same
 * Kartverket verification as the `city` column does.
 */
export function parseAddressParts(raw: string): {
  street: string;
  inlinePostal: string | null;
  trailingPlaces: string[];
} {
  const trimmed = (raw || "").trim();
  const segments = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  let street = segments[0] ?? "";
  const rest = segments.slice(1);

  let inlinePostal: string | null = null;
  const trailingPlaces: string[] = [];

  // Comma-less "Leirvikveien 276 7273 Norddyrøy" (observed live on prod).
  // Split on the LAST "<4 digits> <word…>" run, because the HOUSE number can
  // itself be four digits ("Vestbygdvegen 1030 8412 Vestbygd") and the
  // rightmost such run is the postnummer + poststed. The 4-digit group must be
  // followed by at least one alphabetic word: a bare trailing number
  // ("Storgata 5 0155") is deliberately NOT mined, because there is nothing to
  // distinguish it from a second house number and refusing is cheaper than
  // guessing. Whatever is mined here is still only a HYPOTHESIS — it goes
  // through the same Kartverket confirmation as everything else.
  const inlineTail = street.match(/^(.*\d.*?)\s+(\d{4})\s+([^\d]+)$/);
  if (inlineTail) {
    street = inlineTail[1].trim();
    inlinePostal = inlineTail[2];
    if (inlineTail[3].trim()) trailingPlaces.push(inlineTail[3].trim());
  }

  for (const seg of rest) {
    // "1455 Nordre Frogn" → postal 1455, place "Nordre Frogn".
    // A standalone 4-digit token counts too ("Torvet 11, 4836").
    const m = seg.match(/^(\d{4})\b\s*(.*)$/);
    if (m) {
      if (!inlinePostal) inlinePostal = m[1];
      if (m[2].trim()) trailingPlaces.push(m[2].trim());
      continue;
    }
    trailingPlaces.push(seg);
  }

  return { street, inlinePostal, trailingPlaces };
}

/**
 * Place candidates to probe, in priority order.
 *
 * `city` and any trailing address segments are each split on the separators
 * RFB's free text actually uses ("Mjøndalen/Drammen", "Hamar og Ringsaker",
 * "Bergen, Norge") and passed through city-normalizer's normalizeCityLabel(),
 * which drops the documented pollution classes — "Norge", fylke names
 * ("Akershus"), and multi-kommune region labels ("Lofoten", "Hallingdal").
 * Those are not places Kartverket can key on, and probing them would only
 * spend requests to get 0 hits.
 */
export function placeCandidates(city: string | null | undefined, trailingPlaces: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const norm = normalizeCityLabel(raw);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(norm);
  };
  const explode = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const part of String(raw).split(/[/|]| og /i)) {
      const p = part.trim();
      if (p) push(p);
    }
  };

  explode(city);
  for (const t of trailingPlaces) explode(t);
  return out.slice(0, MAX_PLACE_CANDIDATES);
}

// ── Kartverket probe ────────────────────────────────────────────────

/** Levenshtein distance, capped — only ever asked "is this ≤ 1?". */
function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) { i++; j++; } else { j++; }
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/**
 * Case- and diacritic-tolerant equality for Norwegian place labels, with ONE
 * character of slack on names of 5+ characters.
 *
 * The slack is not cosmetic — it was measured. adresser/v1/sok is conjunctive
 * but NOT literal: `sok=Norafjordvegen 977 Slinde` returns the (globally
 * unique) address whose poststed is spelled "SLINDA". Definite/indefinite forms
 * of Norwegian place names differ by exactly this one trailing vowel all over
 * the country — Slinde/Slinda, Vestbygd/Vestbygda, Sokna/Sokn — so a strict
 * comparison would veto correct, unambiguous matches.
 *
 * The 5-character floor keeps the slack away from the short names where one
 * edit changes the place entirely (Bø/Bo, Vik/Vok, Rød/Råd, Voss/Ross). Those
 * still require an exact fold match.
 */
export function samePlace(a: string | null | undefined, b: string | null | undefined): boolean {
  const fold = (s: string | null | undefined) =>
    (s || "")
      .trim()
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "oe")
      .replace(/å/g, "aa")
      .replace(/\s+/g, " ");
  const fa = fold(a);
  const fb = fold(b);
  if (fa.length === 0 || fb.length === 0) return false;
  if (fa === fb) return true;
  if (fa.length >= 5 && fb.length >= 5) return editDistanceAtMost1(fa, fb);
  return false;
}

/**
 * One `street + token` probe against adresser/v1/sok, judged by G1–G3.
 *
 * `place` is the token used for corroboration. When probing an inline
 * postnummer hypothesis there is no place token, so pass null and G3 is
 * satisfied by the postnummer equality check in resolvePostalCode() instead.
 *
 * Any transport-level problem (non-2xx, malformed JSON, network error, abort)
 * resolves to `no_match`, exactly like kartverketQuery() in
 * dental-geocode-worker.ts: a failed probe is never evidence FOR a postnummer.
 */
export async function probeKartverket(
  street: string,
  token: string,
  place: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<PostalProbeResult> {
  const query = `${street} ${token}`.trim();
  const url = `${KARTVERKET_BASE}?sok=${encodeURIComponent(query)}&treffPerSide=${PAGE_SIZE}`;

  let data: any;
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "RFBBot/1.0 (https://rettfrabonden.com)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: "no_match", query };
    data = await res.json();
  } catch {
    return { status: "no_match", query };
  }

  const raw: any[] = Array.isArray(data?.adresser) ? data.adresser : [];
  const total = Number(data?.metadata?.totaltAntallTreff);

  if (raw.length === 0) return { status: "no_match", query };

  // G1 — enumerability. Never judge uniqueness from a truncated page.
  if (Number.isFinite(total) && total > raw.length) {
    return { status: "not_enumerable", total, query };
  }

  const hits: AddressHit[] = [];
  for (const a of raw) {
    const pn = typeof a?.postnummer === "string" ? a.postnummer.trim() : "";
    if (!/^\d{4}$/.test(pn)) continue; // a record without a usable postnummer is not evidence
    hits.push({
      postnummer: pn,
      poststed: typeof a?.poststed === "string" ? a.poststed : "",
      kommunenummer: typeof a?.kommunenummer === "string" ? a.kommunenummer : "",
      kommunenavn: typeof a?.kommunenavn === "string" ? a.kommunenavn : "",
      adressetekst: typeof a?.adressetekst === "string" ? a.adressetekst : "",
    });
  }
  if (hits.length === 0) return { status: "no_match", query };

  // G2 — uniqueness across the WHOLE result set.
  const distinct = Array.from(new Set(hits.map((h) => h.postnummer))).sort();
  if (distinct.length > 1) {
    return { status: "ambiguous", distinct, query, hits: hits.length };
  }

  // G3 — corroboration against the place token we searched with.
  if (place !== null) {
    const corroborated = hits.some(
      (h) => samePlace(h.poststed, place) || samePlace(h.kommunenavn, place)
    );
    if (!corroborated) return { status: "uncorroborated", query, hits: hits.length };
  }

  return { status: "resolved", postal_code: distinct[0], hit: hits[0], query, hits: hits.length };
}

/**
 * Resolve one producer's postnummer, or refuse.
 *
 * Order of work (each step pays 1–3 Kartverket requests, all throttled):
 *   1. Inline hypothesis — if the address text already carries a 4-digit
 *      number, probe `street + NNNN` and accept ONLY if Kartverket confirms
 *      that exact postnummer. Highest yield on real prod data and the least
 *      guessing: the number came from the record itself, we merely check it.
 *   2. Place candidates — `street + place` for each candidate, through the
 *      street-variant ladder (as-is → transliterated → house-letter stripped,
 *      the same two recovery transforms dental-geocode-worker.ts already uses).
 *   3. G4 — every candidate that resolved must agree. Disagreement is treated
 *      as ambiguity and refused; the alternative is picking one at random and
 *      calling it precision.
 */
export async function resolvePostalCode(
  address: string,
  city: string | null | undefined,
  deps: PostalBackfillDeps = {}
): Promise<PostalResolution> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const { street, inlinePostal, trailingPlaces } = parseAddressParts(address);

  // A street part with no digits at all is a street NAME, not an address —
  // it can never be unique (G2 would refuse every time) so we do not spend
  // requests discovering that.
  if (!street || !/\d/.test(street)) {
    return { status: "unusable_input", detail: "address has no house number" };
  }

  const variants = [street];
  const t = transliterate(street);
  if (t !== street) variants.push(t);
  const s = stripHouseLetterSuffix(street);
  if (s !== street && !variants.includes(s)) variants.push(s);

  // ── 1. Inline postnummer hypothesis, verified ─────────────────────
  if (inlinePostal) {
    for (const variant of variants) {
      const r = await probeKartverket(variant, inlinePostal, null, fetchImpl);
      await sleep(THROTTLE_MS);
      if (r.status === "resolved" && r.postal_code === inlinePostal) {
        return {
          status: "resolved",
          postal_code: r.postal_code,
          source: "kartverket_adresse_inline",
          poststed: r.hit.poststed,
          kommunenummer: r.hit.kommunenummer,
          kommunenavn: r.hit.kommunenavn,
          matched_query: r.query,
        };
      }
      if (r.status === "ambiguous" || r.status === "not_enumerable") {
        // Should not happen with a postnummer in the query, but if it does the
        // hypothesis is not confirmable — stop rather than fall through to a
        // weaker signal that might contradict it.
        return { status: "ambiguous", detail: `inline ${inlinePostal}: ${r.status}` };
      }
      if (r.status === "resolved") {
        // Kartverket found the street at a DIFFERENT postnummer than the text
        // claims. The scraped digits are wrong or belong to something else.
        return { status: "ambiguous", detail: `inline ${inlinePostal} contradicted by ${r.postal_code}` };
      }
    }
    // Unconfirmed hypothesis: fall through to the place candidates. The
    // inline number is simply discarded — never written on its own authority.
  }

  // ── 2. Place candidates ───────────────────────────────────────────
  const places = placeCandidates(city, trailingPlaces);

  const resolutions: Array<{ postal: string; probe: PostalProbeResult & { status: "resolved" } }> = [];
  let sawAmbiguity = false;
  /** True once any probe returned hits we then REFUSED (ambiguous or uncorroborated). */
  let sawRefusal = false;
  const detailParts: string[] = [];

  for (const place of places) {
    for (const variant of variants) {
      const r = await probeKartverket(variant, place, place, fetchImpl);
      await sleep(THROTTLE_MS);
      if (r.status === "resolved") {
        resolutions.push({ postal: r.postal_code, probe: r });
        break;
      }
      if (r.status === "ambiguous") {
        sawAmbiguity = true;
        sawRefusal = true;
        detailParts.push(`${place}: ${r.distinct.join("/")}`);
        break;
      }
      if (r.status === "not_enumerable") {
        sawAmbiguity = true;
        sawRefusal = true;
        detailParts.push(`${place}: ${r.total} hits, not enumerable`);
        break;
      }
      if (r.status === "uncorroborated") {
        sawRefusal = true;
        detailParts.push(`${place}: hit did not corroborate the place`);
        break;
      }
      // no_match → try the next street variant, then the next place.
    }
  }

  // ── 3. G4 — cross-candidate agreement ─────────────────────────────
  const distinct = Array.from(new Set(resolutions.map((r) => r.postal)));
  if (distinct.length > 1) {
    return {
      status: "ambiguous",
      detail: `place candidates disagree: ${distinct.sort().join("/")}`,
    };
  }
  if (distinct.length === 1) {
    if (sawAmbiguity) {
      // One candidate resolved cleanly but another was ambiguous. The clean
      // one might still be the wrong town; refuse.
      return { status: "ambiguous", detail: `resolved ${distinct[0]} but ${detailParts.join("; ")}` };
    }
    const best = resolutions[0].probe;
    return {
      status: "resolved",
      postal_code: distinct[0],
      source: "kartverket_adresse_sok",
      poststed: best.hit.poststed,
      kommunenummer: best.hit.kommunenummer,
      kommunenavn: best.hit.kommunenavn,
      matched_query: best.query,
    };
  }

  if (sawAmbiguity) return { status: "ambiguous", detail: detailParts.join("; ") || "ambiguous" };

  // ── 4. Last resort — a GLOBALLY unique street address ─────────────
  // If "Borgestadveien 23A" identifies exactly ONE address in all of Norway,
  // there is nothing to disambiguate and no place token is needed: the
  // producer's own address field already names that address uniquely. This
  // rescues the two shapes place-matching cannot serve — `city` NULL with no
  // usable trailing place (measured: the single largest refusal reason in this
  // cohort), and a poststed spelled differently from anything on the record.
  //
  // It runs ONLY when nothing was refused earlier (`sawRefusal`). That
  // condition is what stops this tier from quietly overturning G2/G3: a query
  // that already produced hits we judged ambiguous, or a hit whose poststed
  // contradicted the producer's own city, must stay refused — re-asking the
  // same question without the place token would answer it with the very record
  // the corroboration guard just rejected.
  if (!sawRefusal) {
    for (const variant of variants) {
      const r = await probeKartverket(variant, "", null, fetchImpl);
      await sleep(THROTTLE_MS);
      if (r.status === "resolved") {
        return {
          status: "resolved",
          postal_code: r.postal_code,
          source: "kartverket_adresse_unik",
          poststed: r.hit.poststed,
          kommunenummer: r.hit.kommunenummer,
          kommunenavn: r.hit.kommunenavn,
          matched_query: r.query,
        };
      }
      if (r.status === "ambiguous" || r.status === "not_enumerable") {
        // The street name exists in several places — exactly the "long street /
        // common street name" case. Refuse; this is the normal outcome here.
        return {
          status: "ambiguous",
          detail:
            r.status === "ambiguous"
              ? `street is not globally unique: ${r.distinct.slice(0, 5).join("/")}${r.distinct.length > 5 ? "…" : ""}`
              : `street is not globally unique: ${r.total} hits`,
        };
      }
    }
  }

  if (places.length === 0) {
    return {
      status: "unusable_input",
      detail: inlinePostal
        ? `inline ${inlinePostal} unconfirmed, no usable place token, street not globally unique`
        : "no usable place token (city empty or documented pollution) and street not globally unique",
    };
  }
  return { status: "no_match", detail: detailParts.join("; ") || "no Kartverket hit for any candidate" };
}

// ── Worker ──────────────────────────────────────────────────────────

export type PostalBackfillPlannedChange = {
  agent_id: string;
  name: string;
  address: string;
  city: string | null;
  postal_code: string | null;
  source: string | null;
  outcome: string;
  detail: string | null;
};

export type PostalBackfillResult = {
  dry_run: boolean;
  processed: number;
  /** Postnummer written (or that would be written). */
  resolved: number;
  /** …of which confirmed an inline number already present in the address text. */
  resolved_inline: number;
  /** …of which were derived from street + place. */
  resolved_lookup: number;
  /** More than one distinct postnummer in play — refused on purpose. */
  ambiguous: number;
  /** Kartverket knows nothing matching — refused. */
  no_match: number;
  /** No house number, or no usable place token after pollution filtering. */
  unusable: number;
  errors: number;
  duration_ms: number;
  planned: PostalBackfillPlannedChange[];
  skipped_already_running: boolean;
};

type CandidateRow = {
  agent_id: string;
  name: string | null;
  city: string | null;
  address: string | null;
  postal_code: string | null;
};

// Strictly-increasing attempt stamps — same reasoning (and the same measured
// failure) as agents-geocode-worker.ts's nextAttemptStamp(): datetime('now')
// has 1-second granularity, a warm batch stamps inside one second, the
// "oldest first" ordering collapses to the id tiebreaker and the next tick
// re-picks the identical rows.
let lastStampMs = 0;
function nextAttemptStamp(): string {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs).toISOString();
}

// Single-flight guard: the hourly tick and an admin POST can overlap, and
// selection happens up front, so two concurrent ticks would select the
// identical batch and double the load on a free public API.
let running = false;

export const POSTAL_BACKFILL_LIMIT_DEFAULT = 50;

/** Work-queue counts for the admin endpoint / ops. One table scan. */
export function postalBackfillQueueStatus(): {
  active: number;
  with_address: number;
  address_and_postal: number;
  address_no_postal: number;
  pending: number;
  never_attempted: number;
  backfilled: number;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS active,
         COUNT(*) FILTER (WHERE k.address IS NOT NULL AND TRIM(k.address) <> '') AS with_address,
         COUNT(*) FILTER (
           WHERE k.address IS NOT NULL AND TRIM(k.address) <> ''
             AND k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> ''
         ) AS address_and_postal,
         COUNT(*) FILTER (
           WHERE k.address IS NOT NULL AND TRIM(k.address) <> ''
             AND (k.postal_code IS NULL OR TRIM(k.postal_code) = '')
         ) AS address_no_postal,
         COUNT(*) FILTER (
           WHERE k.address IS NOT NULL AND TRIM(k.address) <> ''
             AND (k.postal_code IS NULL OR TRIM(k.postal_code) = '')
             AND k.postal_backfill_attempted_at IS NULL
         ) AS never_attempted,
         COUNT(*) FILTER (WHERE k.postal_code_source IS NOT NULL) AS backfilled
       FROM agents a
       JOIN agent_knowledge k ON k.agent_id = a.id
       WHERE a.is_active = 1`
    )
    .get() as any;
  return {
    active: row?.active ?? 0,
    with_address: row?.with_address ?? 0,
    address_and_postal: row?.address_and_postal ?? 0,
    address_no_postal: row?.address_no_postal ?? 0,
    // Every address-without-postal row is still worth an attempt; the ones
    // already attempted come round again after the rest of the queue.
    pending: row?.address_no_postal ?? 0,
    never_attempted: row?.never_attempted ?? 0,
    backfilled: row?.backfilled ?? 0,
  };
}

function emptyStats(dryRun: boolean): PostalBackfillResult {
  return {
    dry_run: dryRun,
    processed: 0,
    resolved: 0,
    resolved_inline: 0,
    resolved_lookup: 0,
    ambiguous: 0,
    no_match: 0,
    unusable: 0,
    errors: 0,
    duration_ms: 0,
    planned: [],
    skipped_already_running: false,
  };
}

/**
 * One tick. Selects up to `limit` active producers that have a street address
 * but no postnummer, resolves what it safely can, and stamps EVERY attempt so
 * the next tick picks a disjoint batch.
 */
export async function postalBackfillTick(
  limit: number = POSTAL_BACKFILL_LIMIT_DEFAULT,
  deps: PostalBackfillDeps = {}
): Promise<PostalBackfillResult> {
  if (running) {
    console.log("[postal-backfill] tick skipped — a tick is already running");
    return { ...emptyStats(deps.dryRun === true), skipped_already_running: true };
  }
  running = true;
  try {
    return await runPostalBackfillTick(limit, deps);
  } finally {
    running = false;
  }
}

async function runPostalBackfillTick(
  limit: number,
  deps: PostalBackfillDeps
): Promise<PostalBackfillResult> {
  const start = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb();
  const stats = emptyStats(dryRun);

  // Candidate selection: active, has a street address, has NO postnummer.
  // Rotation: never-attempted first (the `IS NOT NULL` expression sorts
  // false=0 before true=1), then oldest attempt, then id as a stable tiebreak.
  const candidates = db
    .prepare(
      `SELECT k.agent_id AS agent_id, a.name AS name, a.city AS city,
              k.address AS address, k.postal_code AS postal_code
         FROM agent_knowledge k
         JOIN agents a ON a.id = k.agent_id
        WHERE a.is_active = 1
          AND k.address IS NOT NULL AND TRIM(k.address) <> ''
          AND (k.postal_code IS NULL OR TRIM(k.postal_code) = '')
        ORDER BY (k.postal_backfill_attempted_at IS NOT NULL),
                 k.postal_backfill_attempted_at ASC,
                 k.agent_id ASC
        LIMIT ?`
    )
    .all(limit) as CandidateRow[];

  // NEVER OVERWRITE, enforced by the write itself and not only by the
  // selector: the guard is in the WHERE clause, so a future selector change
  // (or a concurrent owner edit landing between SELECT and UPDATE) cannot
  // clobber a postnummer that exists.
  const writePostal = db.prepare(
    `UPDATE agent_knowledge
        SET postal_code_prev = postal_code,
            postal_code = ?,
            postal_code_source = ?,
            postal_backfill_outcome = ?,
            postal_backfill_attempted_at = ?
      WHERE agent_id = ?
        AND (postal_code IS NULL OR TRIM(postal_code) = '')`
  );
  const stampOnly = db.prepare(
    `UPDATE agent_knowledge
        SET postal_backfill_outcome = ?,
            postal_backfill_attempted_at = ?
      WHERE agent_id = ?`
  );
  // A newly-postnummered row becomes Tier-A eligible for the Fase-1a geocode
  // worker, whose selector puts never-attempted rows at the head of its queue.
  // Clearing the stamp is honest — the row has never been attempted WITH this
  // data — and is what turns a postnummer into an actual coordinate on the
  // next hour's tick instead of after a full rotation of ~1 500 producers.
  const requeueGeocode = db.prepare(
    `UPDATE agents SET geocode_attempted_at = NULL
      WHERE id = ? AND (geo_precision IS NULL OR geo_precision <> 'address')`
  );

  for (const row of candidates) {
    stats.processed++;
    try {
      const address = (row.address || "").trim();
      const resolution = await resolvePostalCode(address, row.city, deps);

      if (resolution.status === "resolved") {
        stats.resolved++;
        if (resolution.source === "kartverket_adresse_inline") stats.resolved_inline++;
        else stats.resolved_lookup++;
        const outcome =
          resolution.source === "kartverket_adresse_inline" ? "inline_confirmed" : "lookup_resolved";
        stats.planned.push({
          agent_id: row.agent_id,
          name: row.name ?? "",
          address,
          city: row.city,
          postal_code: resolution.postal_code,
          source: resolution.source,
          outcome,
          detail: `${resolution.matched_query} → ${resolution.postal_code} ${resolution.poststed} (${resolution.kommunenavn})`,
        });
        if (!dryRun) {
          writePostal.run(
            resolution.postal_code,
            resolution.source,
            outcome,
            nextAttemptStamp(),
            row.agent_id
          );
          requeueGeocode.run(row.agent_id);
        }
        continue;
      }

      const outcome =
        resolution.status === "ambiguous"
          ? "ambiguous"
          : resolution.status === "unusable_input"
          ? "unusable_input"
          : "no_match";
      if (resolution.status === "ambiguous") stats.ambiguous++;
      else if (resolution.status === "unusable_input") stats.unusable++;
      else stats.no_match++;

      stats.planned.push({
        agent_id: row.agent_id,
        name: row.name ?? "",
        address,
        city: row.city,
        postal_code: null,
        source: null,
        outcome,
        detail: resolution.detail,
      });
      if (!dryRun) stampOnly.run(outcome, nextAttemptStamp(), row.agent_id);
    } catch (err) {
      stats.errors++;
      console.error(`[postal-backfill] failed for ${row.agent_id}:`, err);
      // ALWAYS STAMP, including here. Fase 1a shipped this worker's sibling
      // without an error-path stamp and a persistently-throwing row starved
      // the entire queue behind the LIMIT. Same bug, not repeated.
      stats.planned.push({
        agent_id: row.agent_id,
        name: row.name ?? "",
        address: (row.address || "").trim(),
        city: row.city,
        postal_code: null,
        source: null,
        outcome: "error",
        detail: String((err as any)?.message || err),
      });
      if (!dryRun) {
        try {
          stampOnly.run("error", nextAttemptStamp(), row.agent_id);
        } catch (stampErr) {
          // Guard the guard: if the DB itself is failing, throwing here would
          // abort the tick and lose the rows already processed.
          console.error(`[postal-backfill] could not stamp attempt for ${row.agent_id}:`, stampErr);
        }
      }
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}

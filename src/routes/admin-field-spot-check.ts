// ─── Admin: POST /admin/field-spot-check ─────────────────────────────────────
//
// dev-request 2026-09-22-telefon-css-js-identifikator-falske-positiver,
// point 2 fix-up (B3, adversarial-review CHANGES-REQUESTED finding).
// computeFieldSpotCheck() / fieldSpotCheckSubpageCandidates() (src/agents/
// lokal-agent-verifier.ts) fix the weekly field-verification spot-check's
// FETCH/MEASUREMENT method (follow up to 3 same-domain subpages before
// declaring a field "mismatch" — see that module's own header comment for
// the Vollan Gård repro this closes) — but shipped with NO production
// caller. GET /admin/agents/recently-enriched (routes/marketplace.ts) only
// ever serves the SAMPLE of recently-enriched agents; its own comment says
// the actual spot-check logic (fetch + compare + escalate) "lives in a
// separate SKILL, not here" — i.e. an external operational agent/skill is
// expected to call an HTTP endpoint to do the fetch+compare work, not an
// in-process function nothing calls. This route IS that endpoint: a thin
// HTTP wrapper so the SKILL actually has something to call.
//
// ── Parameter shape ───────────────────────────────────────────────────────
// { agent_id, field_name } — mirrors GET /admin/agents/recently-enriched's
// own output shape (that route returns field_provenance keyed by field
// name, e.g. "phone"/"about"/"address" — see cross-source-validator.ts's
// FieldName type and computeFieldSpotCheck's own Vollan Gård "about" repro).
// The CURRENT stored value for `field_name` and the agent's homepage
// (COALESCE(agent_knowledge.website, agents.url) — the SAME `homepage_url`
// concept every other call site in this codebase computes) are resolved
// server-side from agent_knowledge, so the SKILL never has to know this
// codebase's DB schema — it just names the agent and the field.
//
// FIELD_COLUMN_MAP is a deliberate WHITELIST (not an arbitrary
// `agent_knowledge[field_name]` lookup) — field_name comes straight from an
// external caller's request body, and an unvalidated column name plugged
// into SQL (even parameterized-query-adjacent code like this) is exactly
// the kind of thing that must never be trusted verbatim.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase, including this dev-request's own sibling
// admin-phone-context-gate-retro-scan.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { computeFieldSpotCheck } from "../agents/lokal-agent-verifier";
import { checkAboutCandidateFactSubstantiated } from "../services/about-fact-substantiation";
import {
  checkAboutCandidateSubstantiatedBySource,
  type AboutSubstantiationVerdict,
} from "../services/about-source-substantiation";
import {
  canonicalizeAddressVariants,
  foldAccentsForComparison,
  normalizeAddress,
  prepareAddressForComparison,
  splitAddress,
} from "../services/contact-normalizer";
import { decodeHtmlEntities } from "../services/search-enrich";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

/** Normalize a stored phone number to 8 national digits: strip every
 *  non-digit, then strip a leading 0047/47 country code when exactly 8
 *  digits remain. Returns null when the value doesn't normalize to 8 digits
 *  (caller then falls back to the text check). PURE. Exported for tests. */
export function normalizePhoneToNationalDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (/^\d{8}$/.test(digits)) return digits;
  const m = /^(?:0047|47)(\d{8})$/.exec(digits);
  return m ? m[1]! : null;
}

/** Phone-specific substantiation: the text-based default false-mismatches
 *  on formatting differences ("+47 41 63 44 22" vs "41634422"). Collapses
 *  separators (space/nbsp/dot/dash/parentheses/+) between digits on the page
 *  text, then requires the 8 national digits to be a WHOLE digit run —
 *  optionally prefixed by a 47/0047 country code — so a number embedded in
 *  a longer digit run (ids, other numbers) never matches. Falls back to the
 *  standard text check when the stored value isn't an 8-digit number. PURE.
 *  Exported for tests. */
export function checkPhoneSubstantiatedBySource(
  candidate: string | null | undefined,
  sourceText: string | null | undefined,
): AboutSubstantiationVerdict {
  const national = normalizePhoneToNationalDigits(candidate);
  if (!national) return checkAboutCandidateSubstantiatedBySource(candidate, sourceText);
  const collapsed = (sourceText || "").replace(/(\d)[ \t\u00a0.\-()+]+(?=\d)/g, "$1");
  for (const run of collapsed.match(/\d+/g) || []) {
    if (run === national || run === "47" + national || run === "0047" + national) {
      return { substantiated: true, reason: `phone ${national} found on page (digits normalized)` };
    }
  }
  return { substantiated: false, reason: `phone ${national} not found on page as a whole 8-digit number` };
}

/** `about`-specific substantiation (W40 false-positive fix, b1). FIRST the
 *  write-guard's own check (checkAboutCandidateSubstantiatedBySource:
 *  verbatim, or >= 70% significant-word overlap) — anything the write-guard
 *  would accept as substantiated by this page is, by definition, not a data
 *  error, so it is a `match`. Only when that fails does the fact-level check
 *  (about-fact-substantiation.ts — tolerant of dialectal/paraphrase
 *  rewording, strict on locally-corroborated facts) get a second, extra
 *  chance. Before this, the route ran ONLY the fact-level check, which
 *  rejected texts the write-guard accepts (W40: Aukrust's verbatim
 *  meta-description/paragraph, Oceanfood's 88%-overlap text). Neither check
 *  is loosened by combining them: a candidate passes only if one of the two
 *  existing checks, unchanged, passes it. PURE. Exported for tests. */
export function checkAboutSpotCheckSubstantiated(
  candidate: string | null | undefined,
  sourceText: string | null | undefined,
): AboutSubstantiationVerdict {
  const guard = checkAboutCandidateSubstantiatedBySource(candidate, sourceText);
  if (guard.substantiated) return { substantiated: true, reason: `write-guard check: ${guard.reason}` };
  const fact = checkAboutCandidateFactSubstantiated(candidate, sourceText);
  if (fact.substantiated) return { substantiated: true, reason: `fact-level check: ${fact.reason}` };
  return {
    substantiated: false,
    reason: `write-guard check: ${guard.reason} | fact-level check: ${fact.reason}`,
  };
}

// ── Address (W40 false-positive fix, b4) ─────────────────────────────────────

/** Road designations ("Fv109", "Fv 109", "Rv. 7", "E6", "Fylkesvegen 109"):
 *  the number after one of these is a ROAD number, never a house number, so
 *  such a value has no street + house number to compare structurally. Tested
 *  against the street-name part AFTER normalizeAddress's canonicalization
 *  (which already turns "-vegen" into "-veien"). */
const ROAD_DESIGNATION_RE = /^(?:fv|rv|ev|kv|e|fylkesvei(?:en)?|riksvei(?:en)?|europavei(?:en)?)\.?$/;

/** "<street name> <house number>" as one comma segment, e.g. "lauvdalen
 *  186", "st. olavs gate 5b", "ullstindveien 1242/1246". */
const STREET_AND_NUMBER_RE = /^(\p{L}[\p{L}\p{N}.' -]*?)\s+(\d{1,4}[a-zæøå]?(?:\/\d{1,4}[a-zæøå]?)?)$/u;

export interface ParsedStreetAddress {
  /** Normalized street name ("lauvdalen", "solsideveien"). */
  street: string;
  /** Normalized house number incl. letter suffix ("186", "20b", "1242/1246"). */
  houseNumber: string;
  /** 4-digit postal code, or null when the stored value carries none. */
  postcode: string | null;
}

/** Parse a stored address into street name + house number + postal code
 *  using the SAME normalizer every other address comparison in this codebase
 *  uses (contact-normalizer.ts: prepareAddressForComparison → label/URL/
 *  own-name/company-form strip + accent fold; normalizeAddress →
 *  veg/vei + "12 a"/"12a" canonicalization; splitAddress → postal tail).
 *  Takes the LAST comma segment of the street part that ends in a house
 *  number, so a leading farm/company name ("Nordgard Aukrust, Solsidevegen
 *  449, 2686 Lom") is skipped. Returns null when there is no street + house
 *  number to compare (farm-name-only values like "Lønsdal, 8255 Røkland",
 *  road designations like "Fv109, 5776 Nå"). PURE. Exported for tests. */
export function parseStoredStreetAddress(
  raw: string | null | undefined,
  ownName?: string | null,
): ParsedStreetAddress | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const norm = normalizeAddress(prepareAddressForComparison(raw, ownName)).normalize("NFC");
  if (!norm) return null;
  const { street, postcode } = splitAddress(norm);
  const segments = street.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = STREET_AND_NUMBER_RE.exec(segments[i]!);
    if (!m) continue;
    const name = m[1]!.trim();
    if (ROAD_DESIGNATION_RE.test(name)) return null;
    return { street: name, houseNumber: m[2]!, postcode };
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Page text normalized the same way as the stored side: tags -> spaces,
 *  entities decoded, accents folded, lowercased, whitespace collapsed,
 *  veg/vei + house-letter variants canonicalized. PURE. */
function normalizeSourceForAddress(sourceText: string): string {
  return canonicalizeAddressVariants(
    foldAccentsForComparison(decodeHtmlEntities(sourceText.replace(/<[^>]+>/g, " ")))
      .toLowerCase()
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// A postal code written DIRECTLY after the street + house number on the page
// (after separators only, optionally "N-"/"NO-"-prefixed): "Lauvdalen 186
// 8360 Bøstad", "Storgata 1, 0150 Oslo", "Reisetevegen 83, N-5776 Nå". A
// longer digit run (phone number) never counts.
const ADJACENT_POSTCODE_RE = /^[\s,.;:|·•/–—-]*(?:no?-\s?)?(\d{4})(?!\d)/;

/** Address-specific substantiation (W40 false-positive fix, b4). The
 *  default text check (>= 70% significant-word overlap) both MISSES real
 *  matches (house numbers under 4 digits never count as significant words,
 *  formatting/label noise counts against the value) and can PASS wrong ones
 *  (a different house number on the same street is invisible to it). This
 *  compares the parts that identify a place instead:
 *    match    = the page has the stored street name immediately followed by
 *               the stored house number (whole number — "186" never matches
 *               "1860" or "186b"), AND either the stored value has no postal
 *               code, or the page gives the SAME postal code right after it,
 *               or the page gives NO postal code right after it (e.g. a
 *               terms page's "Vindhella 717, borgundchili@gmail.com").
 *    mismatch = street + number not on the page, or the page only ever
 *               gives a DIFFERENT postal code right after it.
 *  A stored value with no street + house number (farm-name-only, or a road
 *  designation like "Fv109, 5776 Nå") cannot be compared structurally and
 *  falls back, unchanged, to the default text check — so "Fv109, 5776 Nå"
 *  against a page saying "Reisetevegen 83, 5776 NÅ" stays a mismatch. PURE.
 *  Exported for tests. */
export function checkAddressSubstantiatedBySource(
  candidate: string | null | undefined,
  sourceText: string | null | undefined,
  opts: { ownName?: string | null } = {},
): AboutSubstantiationVerdict {
  const parsed = parseStoredStreetAddress(candidate, opts.ownName);
  if (!parsed) {
    const fallback = checkAboutCandidateSubstantiatedBySource(candidate, sourceText);
    return {
      substantiated: fallback.substantiated,
      reason: `no street + house number in stored address — text check: ${fallback.reason}`,
    };
  }
  const src = (sourceText ?? "").trim();
  if (!src) {
    return { substantiated: false, reason: "no source text available to verify against — cannot verify, fail-closed" };
  }
  const normSrc = normalizeSourceForAddress(src);
  const streetPattern = parsed.street.split(/\s+/).map(escapeRegExp).join("\\s*");
  const numberVariants = parsed.houseNumber.includes("/")
    ? [parsed.houseNumber, ...parsed.houseNumber.split("/")]
    : [parsed.houseNumber];
  // Whole house number only: "186" never matches "1860" or "186b", and a
  // bare number never matches one the page writes with a separate house
  // letter ("20 B" — letters a-h only, so the preposition "i" in "… 717 i
  // Borgund" is not mistaken for one). "20b" matches "20b" and "20 b".
  const numberPattern = numberVariants
    .map((n) => {
      const m = /^(\d+)([a-zæøå]?)$/.exec(n);
      if (!m) return `${escapeRegExp(n)}(?![\\p{L}\\p{N}])`;
      return m[2]
        ? `${m[1]}\\s?${m[2]}(?![\\p{L}\\p{N}])`
        : `${m[1]}(?![\\p{L}\\p{N}])(?!\\s[a-h](?![\\p{L}\\p{N}]))`;
    })
    .join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${streetPattern}\\s*,?\\s*(?:${numberPattern})`, "gu");
  const label = `${parsed.street} ${parsed.houseNumber}`;
  let found = 0;
  const conflicting = new Set<string>();
  for (const m of normSrc.matchAll(re)) {
    found++;
    const after = normSrc.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    const pc = ADJACENT_POSTCODE_RE.exec(after)?.[1] ?? null;
    if (pc === null) continue;
    if (parsed.postcode === null || pc === parsed.postcode) {
      return {
        substantiated: true,
        reason: `address match: street + house number "${label}" with postal code ${pc} found on page`,
      };
    }
    conflicting.add(pc);
  }
  if (found === 0) {
    return {
      substantiated: false,
      reason: `address mismatch: street + house number "${label}" not found on page`,
    };
  }
  if (conflicting.size > 0) {
    return {
      substantiated: false,
      reason:
        `address mismatch: "${label}" found on page but only with a different postal code ` +
        `(${[...conflicting].join(", ")}; stored ${parsed.postcode})`,
    };
  }
  return {
    substantiated: true,
    reason:
      `address match: street + house number "${label}" found on page ` +
      `(page gives no postal code next to it${parsed.postcode ? `; stored ${parsed.postcode}` : ""})`,
  };
}

/** Whitelisted spot-checkable fields -> their agent_knowledge column. Only
 *  fields this codebase actually tracks per-field provenance for (see
 *  cross-source-validator.ts's FieldName union plus "about", the field
 *  computeFieldSpotCheck's own Vollan Gård repro exercises) are exposed —
 *  never an arbitrary caller-supplied column name. */
const FIELD_COLUMN_MAP: Readonly<Record<string, string>> = Object.freeze({
  phone: "phone",
  address: "address",
  about: "about",
});

interface AgentRow {
  url: string | null;
  name: string;
}

interface KnowledgeRow {
  website: string | null;
  phone: string | null;
  address: string | null;
  about: string | null;
}

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agent_id?: unknown; field_name?: unknown };
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const fieldName = typeof body.field_name === "string" ? body.field_name.trim() : "";

  if (!agentId) {
    res.status(400).json({ success: false, error: "agent_id (string) is required" });
    return;
  }
  if (!fieldName) {
    res.status(400).json({ success: false, error: "field_name (string) is required" });
    return;
  }
  // hasOwnProperty.call (not a plain `FIELD_COLUMN_MAP[fieldName]` index)
  // so an inherited Object.prototype property name ("constructor",
  // "toString", "hasOwnProperty", "__proto__") can never pass this
  // whitelist check via prototype-chain lookup.
  const column = Object.prototype.hasOwnProperty.call(FIELD_COLUMN_MAP, fieldName)
    ? FIELD_COLUMN_MAP[fieldName]
    : undefined;
  if (!column) {
    res.status(400).json({
      success: false,
      error: `unsupported field_name "${fieldName}" — supported: ${Object.keys(FIELD_COLUMN_MAP).join(", ")}`,
    });
    return;
  }

  try {
    const db = getDb();

    let agent = db.prepare(`SELECT url AS url, name AS name FROM agents WHERE id = ?`).get(agentId) as
      | AgentRow
      | undefined;
    let knowledge: KnowledgeRow | undefined;
    let homepageSource = "agent_knowledge.website and agents.url both blank";

    if (agent) {
      knowledge = db
        .prepare(`SELECT website AS website, phone AS phone, address AS address, about AS about FROM agent_knowledge WHERE agent_id = ?`)
        .get(agentId) as KnowledgeRow | undefined;
    } else {
      // dev-request 2026-09-28-dental-field-spot-check-404-endepunkt-mangler:
      // dental clinics live in dental_agents (separate dental DB), not
      // agents. Only reached when the RFB lookup found nothing, so RFB
      // behaviour is unchanged. Column mapping: hjemmeside -> website,
      // telefon -> phone, adresse -> address, om_oss -> about. Read-only.
      let dental: { navn: string; hjemmeside: string | null; telefon: string | null; adresse: string | null; om_oss: string | null } | undefined;
      try {
        dental = getVerticalDb("dental")
          .prepare(`SELECT navn AS navn, hjemmeside AS hjemmeside, telefon AS telefon, adresse AS adresse, om_oss AS om_oss FROM dental_agents WHERE id = ?`)
          .get(agentId) as typeof dental;
      } catch (err) {
        console.warn(`[field-spot-check] dental lookup failed for ${agentId}:`, (err as Error)?.message);
        dental = undefined; // dental DB unavailable -> treat as not found
      }
      if (dental) {
        agent = { url: null, name: dental.navn };
        knowledge = { website: dental.hjemmeside, phone: dental.telefon, address: dental.adresse, about: dental.om_oss };
        homepageSource = "dental_agents.hjemmeside blank";
      }
    }
    if (!agent) {
      res.status(404).json({ success: false, error: `agent not found: ${agentId}` });
      return;
    }

    const rootUrl = (knowledge?.website && knowledge.website.trim()) || (agent.url && agent.url.trim()) || null;
    if (!rootUrl) {
      res.status(400).json({
        success: false,
        error: `no homepage_url on file for this agent (${homepageSource}) — cannot spot-check`,
      });
      return;
    }

    const fieldValue = (knowledge as any)?.[column] ?? null;

    // Per-field judgment of the stored value against each fetched page:
    //   about   — write-guard check first, fact-level check
    //             (about-fact-substantiation.ts, dev-request
    //             2026-09-24-stikkproeve-undersider-og-faktanivaa-about Del B)
    //             as an extra chance (checkAboutSpotCheckSubstantiated).
    //   phone   — normalized 8-digit national number (#933).
    //   address — street name + house number + postal code
    //             (checkAddressSubstantiatedBySource), the producer's own
    //             name stripped from the front of the stored value.
    // W40 false-positive fix: 12 of 14 W40 "mismatches" were this route
    // judging/fetching wrongly, not bad data — see each function's comment.
    const ownName = agent.name;
    const substantiate =
      fieldName === "about"
        ? checkAboutSpotCheckSubstantiated
        : fieldName === "phone"
          ? checkPhoneSubstantiatedBySource
          : fieldName === "address"
            ? (candidate: string | null | undefined, sourceText: string | null | undefined) =>
                checkAddressSubstantiatedBySource(candidate, sourceText, { ownName })
            : undefined; // unreachable today (FIELD_COLUMN_MAP whitelist) — computeFieldSpotCheck's default
    const result = await computeFieldSpotCheck({ field_value: fieldValue, root_url: rootUrl }, { substantiate });

    res.json({
      success: true,
      agent_id: agentId,
      field_name: fieldName,
      field_value: fieldValue,
      root_url: rootUrl,
      status: result.status,
      checked_url: result.checked_url,
      urls_tried: result.urls_tried,
      reason: result.reason,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;

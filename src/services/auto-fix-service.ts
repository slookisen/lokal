// ─── auto-fix-service — WO-26 ───────────────────────────────────────────────
//
// Pure-function module that takes an agent's current state and returns a list
// of proposed fixes. Each fix is a structured AutoFixAction (no DB mutation
// happens in this module — the route layer is responsible for applying or
// dry-running).
//
// Background — the 2026-05-09 30-agent quality probe found a 43% FAIL rate
// across these defect classes:
//
//   1. Postcode↔fylke mismatch              (~23%) — deterministic, sometimes
//                                                    needs Brreg lookup
//   2. Template-leak (dup streetAddress)     (~17%) — re-fetch eligibility
//   3. Wrong-fit (festival, certifier, etc.) (~17%) — flag, never delete
//   4. Wrong phone (rfb ≠ website)           (~13%) — re-scrape homepage
//   5. Bondens Marked URL-rot                ( ~7%) — heuristic update
//
// Strategies are layered. Each strategy may emit zero or more actions. The
// result is the union of all strategies' actions, plus a confidence summary
// and a manual_review_recommended flag the route layer uses to decide
// whether an automatic apply is appropriate.
//
// Reference: WO-26 work order (2026-05-09).

import {
  validateAddressConsistency,
  findDuplicateStreetAddresses,
  type DuplicateStreetAddressGroup,
} from "./cross-source-validator";
import { fylkeForPostcode, fylkeForCity } from "./postcode-fylke";
import type { BrregFn, BrregLookupResult } from "../agents/lokal-agent-verifier";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AutoFixAction =
  | {
      type: "set_field";
      field: string;
      old_value: unknown;
      new_value: unknown;
      source: string;
      reason: string;
    }
  | {
      type: "set_status";
      old_status: string;
      new_status: string;
      reason: string;
    }
  | {
      type: "flag_review";
      field: string;
      reason: string;
    };

export type AutoFixConfidence = "high" | "medium" | "low";

export type AutoFixResult = {
  agent_id: string;
  actions: AutoFixAction[];
  fix_categories: string[];
  confidence: AutoFixConfidence;
  manual_review_recommended: boolean;
};

// Shape we expect from agent_knowledge (loose — caller may pass the raw row)
export type CurrentKnowledge = {
  agent_id?: string;
  name?: string | null;
  address?: string | null; // streetAddress
  postal_code?: string | null;
  city?: string | null; // addressLocality
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  url?: string | null; // agents.url (the agent record's primary URL)
  verification_status?: string | null;
  outreach_eligible_at?: string | null;
};

export type HomepageProbe = (
  url: string
) => Promise<{ html: string; status: number } | null>;

export type PostenLookupFn = (
  postcode: string
) => Promise<{ city: string; fylke: string } | null>;

export type PlanAutoFixInput = {
  agent_id: string;
  current_knowledge: CurrentKnowledge;
  brregLookup?: BrregFn | null;
  postenLookup?: PostenLookupFn | null;
  homepageProbe?: HomepageProbe | null;
  duplicateStreetAddresses?: DuplicateStreetAddressGroup[];
  naceBlacklist?: readonly string[];
};

// ─── NACE blacklist (initial, conservative set) ─────────────────────────────
//
// Daniel-approved set: festivals, wellness centres, certification bodies,
// food wholesale, retail chains, courier/delivery. Hotels/restaurants
// (55.* / 56.*) intentionally excluded — some farms have legitimate gårdsmat
// or gård-overnatting operations and we don't want to false-positive them.
//
// Brreg returns NACE codes either as bare numbers ("47.11") or with a label
// ("47.11 — Butikkhandel med bredt vareutvalg ..."). We match on the leading
// numeric segment, so the strategy is safe against label drift.

export const DEFAULT_NACE_BLACKLIST: readonly string[] = [
  "79.90", // Other reservation services / festivals
  "96.04", // Wellness/spa
  "71.20", // Technical testing & analysis (certification bodies)
  "46.31", // Wholesale fruit & vegetables
  "46.32", // Wholesale meat
  "46.33", // Wholesale dairy / eggs / oils
  "47.11", // Retail chains — supermarkets
  "47.19", // Other non-specialised retail
  "53.20", // Other postal & courier
];

// ─── Helpers ────────────────────────────────────────────────────────────────

// Strip +47 / 0047 / spaces / dashes — return digits only, for comparison.
export function normalizePhoneDigits(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw)
    .replace(/^\+47/, "")
    .replace(/^0047/, "")
    .replace(/^\+/, "")
    .replace(/[\s\-().]/g, "")
    .replace(/\D/g, "");
}

// Find Norwegian-style phone numbers in an HTML blob. Returns digits-only
// strings. Patterns covered: "+47 XX XX XX XX", "+47XXXXXXXX", "XXX XX XXX",
// "XXXXXXXX". We avoid matching org-numbers (9 digits that don't start with
// 4/9 — Norwegian mobile prefixes — and aren't preceded by "+47").
export function extractPhonesFromHtml(html: string): string[] {
  if (!html) return [];
  const out = new Set<string>();
  // +47-prefixed (most reliable)
  const re1 = /\+\s*47[\s\-]*((?:\d[\s\-]*){8})/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(html)) !== null) {
    const digits = m[1]!.replace(/\D/g, "");
    if (digits.length === 8) out.add(digits);
  }
  // 0047-prefixed
  const re2 = /00\s*47[\s\-]*((?:\d[\s\-]*){8})/g;
  while ((m = re2.exec(html)) !== null) {
    const digits = m[1]!.replace(/\D/g, "");
    if (digits.length === 8) out.add(digits);
  }
  // Bare 8-digit starting with 4 or 9 (Norwegian mobile/landline)
  // Must be word-bounded so we don't grab parts of org-numbers.
  const re3 = /(?:^|[^\d+])((?:[49]\d)[\s\-]?(?:\d\d)[\s\-]?(?:\d\d)[\s\-]?(?:\d\d))(?:$|[^\d])/g;
  while ((m = re3.exec(html)) !== null) {
    const digits = m[1]!.replace(/\D/g, "");
    if (digits.length === 8) out.add(digits);
  }
  return Array.from(out);
}

// Pull NACE numeric prefix from a Brreg naering string.
// "79.90 Annet — festivaler"  → "79.90"
// "47.11"                      → "47.11"
// undefined / not a NACE-shape → null
export function extractNaceCode(naering: string | null | undefined): string | null {
  if (!naering) return null;
  const m = String(naering).match(/^\s*(\d{2}\.\d{1,2})/);
  return m ? m[1]! : null;
}

// ─── Strategy 1: Postcode↔fylke fix ─────────────────────────────────────────
//
// Logic:
//   - Run validateAddressConsistency().
//   - If inconsistent: try Brreg lookup. If Brreg returns an authoritative
//     address whose postcode/locality both pass the consistency check,
//     prefer Brreg's complete address.
//   - If no Brreg or Brreg disagrees with itself: emit flag_review — we
//     can't confidently pick a side without a tie-breaker.
//
// Confidence:
//   - high   : Brreg returned a self-consistent address that we adopted.
//   - medium : (reserved for future deterministic-table-only fixes)
//   - low    : flag_review only — needs Daniel.

async function strategyPostcodeFylke(
  input: PlanAutoFixInput
): Promise<{ actions: AutoFixAction[]; category?: string; confidence?: AutoFixConfidence }> {
  const k = input.current_knowledge;
  const r = validateAddressConsistency({
    streetAddress: k.address ?? null,
    postalCode: k.postal_code ?? null,
    addressLocality: k.city ?? null,
  });
  if (r.ok) return { actions: [] };

  const actions: AutoFixAction[] = [];

  // Try Brreg as authoritative source
  if (input.brregLookup && k.name) {
    let brreg: BrregLookupResult | null = null;
    try {
      brreg = await input.brregLookup(k.name, k.city ?? null);
    } catch {
      brreg = null;
    }
    // BrregFn today returns is_active/is_konkurs/naering — not the address
    // shape we'd need to override fields. The plumbing for an address-bearing
    // Brreg payload is tracked in WO-25's reviewer P3. Until then, fall
    // through to flag_review.
    void brreg;
  }

  // Try Posten lookup as a deterministic table-fix
  if (input.postenLookup && k.postal_code) {
    let posten: { city: string; fylke: string } | null = null;
    try {
      posten = await input.postenLookup(k.postal_code);
    } catch {
      posten = null;
    }
    if (posten) {
      const cityFylke = fylkeForCity(k.city ?? null);
      const postFylke = fylkeForPostcode(k.postal_code ?? null);
      // If the postcode's true fylke matches the current city's fylke,
      // the postcode is actually OK and only the rendered city was wrong
      // (e.g. "Mandal" was a template-leak label but the postcode is
      // correct for this farm). We don't know which side to trust without
      // an authoritative source — flag for review.
      if (posten.city && cityFylke && postFylke && cityFylke !== postFylke) {
        actions.push({
          type: "flag_review",
          field: "address",
          reason: `postcode ${k.postal_code} resolves to ${posten.city} (${posten.fylke}) but addressLocality is ${k.city} (${cityFylke}); cannot disambiguate without Brreg`,
        });
        return {
          actions,
          category: "postcode_fylke",
          confidence: "low",
        };
      }
    }
  }

  // No authoritative source available — emit flag_review
  actions.push({
    type: "flag_review",
    field: "address",
    reason: `postcode ${k.postal_code ?? "?"} and addressLocality ${k.city ?? "?"} are in different fylker; no authoritative source available to pick a side`,
  });
  return {
    actions,
    category: "postcode_fylke",
    confidence: "low",
  };
}

// ─── Strategy 2: Template-leak fix ─────────────────────────────────────────
//
// If this agent's streetAddress (case/whitespace-normalised) appears on
// >1 agent in the duplicateStreetAddresses report, it is a template-leak.
// We demote to `unverified`, clear the address fields, and let the next
// verifier run re-fetch from primary sources.
//
// Confidence: high — duplicates are dispositive.

function strategyTemplateLeak(
  input: PlanAutoFixInput
): { actions: AutoFixAction[]; category?: string; confidence?: AutoFixConfidence } {
  const k = input.current_knowledge;
  if (!k.address || !k.address.trim()) return { actions: [] };
  const groups = input.duplicateStreetAddresses ?? [];
  if (groups.length === 0) return { actions: [] };

  const myAddr = k.address.trim().toLowerCase();
  const hit = groups.find(
    (g) =>
      g.streetAddress.trim().toLowerCase() === myAddr &&
      g.agent_ids.includes(input.agent_id)
  );
  if (!hit) return { actions: [] };

  const actions: AutoFixAction[] = [];

  // Clear address-shape fields so the next verifier round will re-fetch.
  if (k.address) {
    actions.push({
      type: "set_field",
      field: "address",
      old_value: k.address,
      new_value: null,
      source: "auto-fix:template-leak",
      reason: `streetAddress "${k.address}" appears on ${hit.count} agents (template-leak)`,
    });
  }
  if (k.postal_code) {
    actions.push({
      type: "set_field",
      field: "postal_code",
      old_value: k.postal_code,
      new_value: null,
      source: "auto-fix:template-leak",
      reason: "cleared with leaked address",
    });
  }
  if (k.city) {
    actions.push({
      type: "set_field",
      field: "city",
      old_value: k.city,
      new_value: null,
      source: "auto-fix:template-leak",
      reason: "cleared with leaked address",
    });
  }

  // Demote so the agent re-enters the verifier queue.
  actions.push({
    type: "set_status",
    old_status: k.verification_status ?? "unknown",
    new_status: "unverified",
    reason: `template-leak: address "${k.address}" shared by ${hit.count} agents`,
  });

  return { actions, category: "duplicate_streetAddress", confidence: "high" };
}

// ─── Strategy 3: Wrong-fit (NACE-blacklist) ────────────────────────────────
//
// If Brreg returns a NACE code on the blacklist: set verification_status
// to 'wrong_fit', clear outreach_eligible_at. We never auto-DELETE — Daniel
// reviews wrong_fit cases manually.
//
// Confidence: high — Brreg is the legal source of truth.

async function strategyWrongFit(
  input: PlanAutoFixInput
): Promise<{ actions: AutoFixAction[]; category?: string; confidence?: AutoFixConfidence }> {
  if (!input.brregLookup) return { actions: [] };
  const k = input.current_knowledge;
  if (!k.name) return { actions: [] };

  let brreg: BrregLookupResult | null = null;
  try {
    brreg = await input.brregLookup(k.name, k.city ?? null);
  } catch {
    return { actions: [] };
  }
  if (!brreg) return { actions: [] };

  const blacklist = input.naceBlacklist ?? DEFAULT_NACE_BLACKLIST;
  const naceCode = extractNaceCode(brreg.naering ?? null);
  if (!naceCode) return { actions: [] };
  if (!blacklist.includes(naceCode)) return { actions: [] };

  const actions: AutoFixAction[] = [
    {
      type: "set_status",
      old_status: k.verification_status ?? "unknown",
      new_status: "wrong_fit",
      reason: `Brreg NACE ${naceCode} on wrong-fit blacklist (naering="${brreg.naering}")`,
    },
  ];
  if (k.outreach_eligible_at) {
    actions.push({
      type: "set_field",
      field: "outreach_eligible_at",
      old_value: k.outreach_eligible_at,
      new_value: null,
      source: "auto-fix:wrong-fit",
      reason: `cleared because NACE ${naceCode} is wrong-fit`,
    });
  }
  return { actions, category: "wrong_fit", confidence: "high" };
}

// ─── Strategy 4: Phone re-fetch ─────────────────────────────────────────────
//
// If we have a homepageProbe and the agent has both a website and a phone:
// fetch the homepage, extract phone numbers, and if the current phone does
// NOT appear but a different one does, propose updating to the homepage's.
//
// Confidence: medium — websites can be out-of-date or have multiple numbers
// (main line vs. fax vs. shop). Daniel should still glance at these.

async function strategyPhoneRefetch(
  input: PlanAutoFixInput
): Promise<{ actions: AutoFixAction[]; category?: string; confidence?: AutoFixConfidence }> {
  if (!input.homepageProbe) return { actions: [] };
  const k = input.current_knowledge;
  if (!k.website || !k.phone) return { actions: [] };

  let probe: { html: string; status: number } | null = null;
  try {
    probe = await input.homepageProbe(k.website);
  } catch {
    return { actions: [] };
  }
  if (!probe || probe.status >= 400 || !probe.html) return { actions: [] };

  const homepagePhones = extractPhonesFromHtml(probe.html);
  if (homepagePhones.length === 0) return { actions: [] };

  const currentDigits = normalizePhoneDigits(k.phone);
  if (currentDigits && homepagePhones.includes(currentDigits)) {
    return { actions: []  }; // current phone agrees with homepage — fine
  }

  // The current phone is NOT on the homepage but at least one OTHER phone IS.
  // Propose update to the first homepage phone (deterministic — first match).
  const newPhone = homepagePhones[0]!;
  // Format as "+47 XX XX XX XX" for storage consistency
  const formatted = `+47 ${newPhone.slice(0, 2)} ${newPhone.slice(2, 4)} ${newPhone.slice(4, 6)} ${newPhone.slice(6, 8)}`;

  return {
    actions: [
      {
        type: "set_field",
        field: "phone",
        old_value: k.phone,
        new_value: formatted,
        source: `homepage:${k.website}`,
        reason: `current phone ${currentDigits} not on homepage; homepage shows ${newPhone}`,
      },
    ],
    category: "phone_refetch",
    confidence: "medium",
  };
}

// ─── Strategy 5: Bondens Marked URL-rot ────────────────────────────────────
//
// Heuristic: agents whose name starts with "Bondens marked" and whose `url`
// either 404s or contains "Lokallag ikke funnet" — replace the url with the
// chapter index page.
//
// Confidence: medium (some chapters genuinely have working pages and we don't
// want to overwrite a fine URL).

async function strategyBondensMarkedUrl(
  input: PlanAutoFixInput
): Promise<{ actions: AutoFixAction[]; category?: string; confidence?: AutoFixConfidence }> {
  const k = input.current_knowledge;
  const name = (k.name ?? "").trim();
  if (!/^bondens\s+marked/i.test(name)) return { actions: [] };
  const currentUrl = k.url ?? "";
  if (!currentUrl) return { actions: [] };

  // If we have a homepageProbe, use it. Otherwise, we cannot decide — skip.
  if (!input.homepageProbe) return { actions: [] };

  let probe: { html: string; status: number } | null = null;
  try {
    probe = await input.homepageProbe(currentUrl);
  } catch {
    return { actions: [] };
  }

  const indexUrl = "https://bondensmarked.no";
  const looksRotted =
    probe === null ||
    probe.status === 404 ||
    (typeof probe.html === "string" && /lokallag\s+ikke\s+funnet/i.test(probe.html));

  if (!looksRotted) return { actions: [] };
  if (currentUrl === indexUrl || currentUrl === indexUrl + "/") return { actions: [] };

  return {
    actions: [
      {
        type: "set_field",
        field: "url",
        old_value: currentUrl,
        new_value: indexUrl,
        source: "auto-fix:bondens-marked-rot",
        reason:
          probe === null
            ? "homepage probe failed; falling back to chapter index"
            : probe.status === 404
              ? `404 from ${currentUrl}; falling back to chapter index`
              : `"Lokallag ikke funnet" detected at ${currentUrl}; falling back to chapter index`,
      },
    ],
    category: "bondens_marked_url",
    confidence: "medium",
  };
}

// ─── Confidence aggregation ────────────────────────────────────────────────

function combineConfidence(items: AutoFixConfidence[]): AutoFixConfidence {
  if (items.length === 0) return "high";
  // Lowest wins: low > medium > high
  if (items.includes("low")) return "low";
  if (items.includes("medium")) return "medium";
  return "high";
}

// ─── Main entrypoint ───────────────────────────────────────────────────────

export async function planAutoFix(input: PlanAutoFixInput): Promise<AutoFixResult> {
  const allActions: AutoFixAction[] = [];
  const categories: string[] = [];
  const confidences: AutoFixConfidence[] = [];

  const strategies: Array<
    () => Promise<{
      actions: AutoFixAction[];
      category?: string;
      confidence?: AutoFixConfidence;
    }>
  > = [
    () => strategyPostcodeFylke(input),
    async () => strategyTemplateLeak(input),
    () => strategyWrongFit(input),
    () => strategyPhoneRefetch(input),
    () => strategyBondensMarkedUrl(input),
  ];

  for (const s of strategies) {
    try {
      const r = await s();
      if (r.actions.length > 0) {
        allActions.push(...r.actions);
        if (r.category) categories.push(r.category);
        if (r.confidence) confidences.push(r.confidence);
      }
    } catch (err) {
      // A single strategy crash should not poison the whole plan.
      console.error(`[auto-fix] strategy crashed for ${input.agent_id}:`, err);
    }
  }

  const confidence = combineConfidence(confidences);

  // Manual-review-recommended logic:
  //   - Any flag_review action → must be human-reviewed.
  //   - Confidence "low" → human-reviewed.
  //   - Multiple set_field actions affecting different categories → review.
  //   - All other cases (single high-confidence category) → safe to auto-apply.
  const hasFlag = allActions.some((a) => a.type === "flag_review");
  const manual_review_recommended =
    hasFlag || confidence === "low" || categories.length > 1;

  return {
    agent_id: input.agent_id,
    actions: allActions,
    fix_categories: categories,
    confidence,
    manual_review_recommended,
  };
}

// ─── Re-export for callers that want the duplicate report ───────────────────

export { findDuplicateStreetAddresses };

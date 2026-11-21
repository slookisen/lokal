// selvreg-daniel-review.ts — dev-request 2026-11-15-rfb-selvregistrering-
// uten-nettside, slice F2 («godkjenning uten org.nr»).
//
// The customer-service routine may release a self-registered profile only
// when it finds the business in Brønnøysund, which needs an org.nr. A
// self-registered profile WITHOUT an org.nr is therefore never released by
// the routine: it is presented to Daniel once ALL of these hold —
//   email_confirmed  the owner has confirmed the e-mail address
//   phone            a phone number was given
//   sales_place      «Hvor selger du?» was answered
//   description      the profile has a (non-empty) description
//   product          the profile lists at least one product
// — and Daniel approves or rejects (POST self-registered-review-approve with
// `danielApproved: true`). Pure functions only; the queue route
// (routes/admin-agents.ts) reads the DB facts and passes them in.

import { normalizeOrgNr } from "./claim-assessment";
import { validOwnerOrgNr } from "./debio-register-client";

/** Stable codes for what a no-org.nr profile still lacks, in this order. */
export const DANIEL_REVIEW_CONDITIONS = ["email_confirmed", "phone", "sales_place", "description", "product"] as const;
export type DanielReviewCondition = (typeof DANIEL_REVIEW_CONDITIONS)[number];

export interface DanielReview {
  required: true;
  ready: boolean;
  missing: DanielReviewCondition[];
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function parseJsonArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * True when the agent has an org.nr: agents.org_nr holds 9 digits (the
 * audited admin/Brreg column; same normalizeOrgNr as registration-precheck's
 * orgNrOfRow), OR the tags carry an `org_nr:<9 digits>` tag (what F1's
 * POST /register writes) whose digits pass the MOD11 check. The tag check is
 * stricter than the pre-check's (it also wants MOD11): a number that can
 * never be found in Brønnøysund must not let a profile skip Daniel.
 */
export function hasOrgNr(orgNrColumn: unknown, tags: unknown): boolean {
  if (normalizeOrgNr(orgNrColumn)) return true;
  const list = parseJsonArray(tags);
  const candidates: string[] = list
    ? list.filter((t): t is string => typeof t === "string")
    : typeof tags === "string" ? [tags] : [];
  for (const t of candidates) {
    for (const m of t.matchAll(/org_nr:(\d{9})(?!\d)/gi)) {
      if (validOwnerOrgNr(m[1]!)) return true;
    }
  }
  return false;
}

/** Trimmed phone, or null when missing/blank. */
export function phoneOf(raw: unknown): string | null {
  return nonEmpty(raw) ? raw.trim() : null;
}

/**
 * The self-reported sales place: F1 stores «Hvor selger du?» as the single
 * entry of agent_knowledge.delivery_options (a JSON array). The non-empty
 * string entries joined with "; ", or null when there are none.
 */
export function salesPlaceOf(deliveryOptionsJson: unknown): string | null {
  const list = parseJsonArray(deliveryOptionsJson);
  if (!list) return null;
  const parts = list.filter(nonEmpty).map((s) => s.trim());
  return parts.length ? parts.join("; ") : null;
}

/**
 * Products listed in agent_knowledge.products (JSON array; the source of
 * truth the products table is synced from): text entries and objects with a
 * non-empty `name`.
 */
export function countKnowledgeProducts(productsJson: unknown): number {
  const list = parseJsonArray(productsJson);
  if (!list) return 0;
  return list.filter((p) => nonEmpty(p) || (!!p && typeof p === "object" && nonEmpty((p as { name?: unknown }).name))).length;
}

export interface DanielReviewInput {
  hasOrgNr: boolean;
  emailConfirmed: boolean;
  phone: string | null;
  salesPlace: string | null;
  hasDescription: boolean;
  productCount: number;
}

/** null when the profile has an org.nr (the routine's Brønnøysund rule applies). */
export function computeDanielReview(i: DanielReviewInput): DanielReview | null {
  if (i.hasOrgNr) return null;
  const missing: DanielReviewCondition[] = [];
  if (!i.emailConfirmed) missing.push("email_confirmed");
  if (!nonEmpty(i.phone)) missing.push("phone");
  if (!nonEmpty(i.salesPlace)) missing.push("sales_place");
  if (!i.hasDescription) missing.push("description");
  if (!(i.productCount >= 1)) missing.push("product");
  return { required: true, ready: missing.length === 0, missing };
}

/** Non-empty trimmed description (agents.description) or long-form about (agent_knowledge.about). */
export function hasDescriptionOf(description: unknown, about: unknown): boolean {
  return nonEmpty(description) || nonEmpty(about);
}

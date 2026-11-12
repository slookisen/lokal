// ─── Gårdssalg self-registration — skive 1 ───────────────────────────────────
//
// dev-request 2026-11-01-opplevagent-drikkeprodusent-selvregistrering
// (L4, Daniel live 2026-11-01). A drink producer that has no profile on
// opplevagent.no can register one at /for-tilbydere/registrer
// (routes/gardssalg-self-register.ts). Everything is behind
// GARDSSALG_SELF_REGISTER_ENABLED (default OFF).
//
// Skive 1 = the form, the server-side duplicate check (Spec A), the live Brreg
// gate (Spec B), the RFB filters (Spec C) and creating the HIDDEN row (the
// creation half of Spec E). Skive 2 (bottom of this file) adds the e-mail
// code and the draft-mode session. Nothing is ever published from here: the
// admin queue with approve/reject (skive 3) comes later.
//
// Order of the checks in submitSelfRegistration(), each one before anything
// is written:
//   1. RFB blocklist (isBlocked) on the typed name, website, e-mail and org.nr.
//   2. RFB description filters (looksLikeCodeArtifact, hasInternalNote,
//      looksLikeThemeSpam) on the description.
//   3. The experiences enrichment write-pause gate.
//   4. Duplicate check 1: the same org.nr in experience_providers, hidden and
//      merged rows included, merged_into followed to its target. A hit never
//      creates a row: a claimable profile sends the visitor to the claim page,
//      a hidden one leaves a minimal trail row («finnes skjult») for review.
//   5. The Brreg gate: live lookup of the org.nr. The unit must exist, be
//      active (not konkurs, not under avvikling or tvangsavvikling, not
//      deleted), have a primary NACE code in the drink/fruit/food families,
//      and its registered name must match the typed name (nameSimilarity at
//      the enrichment threshold). Brreg down / timeout: NO provider row;
//      the submission is stored as 'brreg_unavailable' for manual review.
//   6. The blocklist again, on the Brreg name (that is the name the profile
//      gets).
//   7. Duplicate checks 2 (similar name in the same kommune) and 3 (an RFB
//      agent with the same org.nr, read through knowledge-service's
//      findRegisterSiblingMatch — no cross-database write). A hit shows
//      «Er dette deg?»; only an explicit confirm_not_duplicate continues, and
//      the new row then carries possible_duplicate_of. Never merged.
//   8. Create: one transaction writes the experience_providers row (fields
//      from Brreg, never from the submitter; catalog_hidden=1,
//      catalog_hidden_reason='self_registered_pending_review',
//      origin='self_registered', booking_live=0, no epost) and the
//      gardssalg_self_registrations row that holds the submitter's own
//      name / e-mail / phone. The submitter's e-mail is never the profile's
//      epost before approval (dev-request 2026-08-06-aldri-gjett-epostadresse).

import { getDb } from "../database/db-factory";
import { getDb as getRfbDb } from "../database/init";
import { lookupBrregEnhet, type BrregEnhetLookup } from "./brreg-client";
import { nameSimilarity, BRREG_NAME_SIMILARITY_MIN } from "./experience-brreg";
import { isBlocked } from "./blocklist-service";
import { looksLikeCodeArtifact, hasInternalNote, looksLikeThemeSpam } from "./description-quality";
import {
  enrichmentWritePauseBlock,
  type EnrichmentWritePausedBody,
} from "./enrichment-write-pause";
import { findRegisterSiblingMatch, isSingleEmailAddress, EMAIL_ADDRESS_MAX_LENGTH } from "./knowledge-service";
import { createProvider, brregDisplayName, providerSlugFor } from "./experience-store";
import { isGardssalgVisibleOnSurface } from "./gardssalg-visibility";
import { GARDSSALG_NACE_PRODUCER_TYPE } from "./gardssalg-nace-producer-type";
import { SELF_REGISTERED_PENDING_REVIEW_REASON } from "./gardssalg-booking-gate";
import crypto, { randomUUID } from "crypto";

const VERTICAL = "experiences";

// ── Flag ─────────────────────────────────────────────────────────────────────

export const GARDSSALG_SELF_REGISTER_FLAG = "GARDSSALG_SELF_REGISTER_ENABLED";

/** GARDSSALG_SELF_REGISTER_ENABLED: "1" or "true" (any case, trimmed) = on;
 *  anything else, unset included, = off. Read on every request. */
export function isGardssalgSelfRegisterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[GARDSSALG_SELF_REGISTER_FLAG] || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

// ── Constants ────────────────────────────────────────────────────────────────

export const SELF_REGISTERED_ORIGIN = "self_registered";
export { SELF_REGISTERED_PENDING_REVIEW_REASON };

/** Primary NACE code prefixes the Brreg gate accepts (Spec B): beverages
 *  (11.0), perennial crops incl. grapes and fruit/berries (01.2) and the whole
 *  food-manufacturing division (10.). Every key of GARDSSALG_NACE_PRODUCER_TYPE
 *  (11.010–11.050, 01.210) falls inside these; the map is checked too so the
 *  two can never disagree. */
export const SELF_REGISTER_NACE_PREFIXES: readonly string[] = ["11.0", "01.2", "10."];

export function selfRegisterNaceAllowed(code: string | null | undefined): boolean {
  const c = String(code || "").trim();
  if (!c) return false;
  if (c in GARDSSALG_NACE_PRODUCER_TYPE) return true;
  return SELF_REGISTER_NACE_PREFIXES.some((p) => c.startsWith(p));
}

/** The form's producer types (value → label, producer_type). */
export const SELF_REGISTER_PRODUCER_TYPES: ReadonlyArray<{ value: string; label: string; producerType: string }> = [
  { value: "vin", label: "Vin", producerType: "vingård" },
  { value: "sider", label: "Sider", producerType: "sideri" },
  { value: "ol", label: "Øl", producerType: "bryggeri" },
  { value: "brennevin", label: "Brennevin", producerType: "destilleri" },
  { value: "annet", label: "Annet", producerType: "annet" },
];

/** Brreg's own NACE code decides the producer_type when it names one; the
 *  submitter's choice is only the fallback. */
export function selfRegisterProducerType(naeringskode: string | null, formValue: string): string {
  const fromNace = naeringskode ? GARDSSALG_NACE_PRODUCER_TYPE[naeringskode] : undefined;
  if (fromNace) return fromNace;
  return SELF_REGISTER_PRODUCER_TYPES.find((t) => t.value === formValue)?.producerType ?? "annet";
}

export const SELF_REGISTER_FIELD_LIMITS = {
  companyName: 120,
  place: 80,
  submitterName: 100,
  phone: 30,
  description: 1000,
  website: 200,
} as const;

// ── Input ────────────────────────────────────────────────────────────────────

export interface SelfRegisterInput {
  orgNr: string;
  companyName: string;
  place: string;
  submitterName: string;
  email: string;
  phone: string | null;
  description: string;
  producerType: string;
  website: string | null;
  /** The submitter ticked «Nei, dette er ikke oss — registrer likevel». */
  confirmNotDuplicate: boolean;
}

export type SelfRegisterField = "org_nr" | "company_name" | "place" | "submitter_name" | "email" | "phone" | "description" | "producer_type" | "website";

export type ParseSelfRegisterResult =
  | { ok: true; input: SelfRegisterInput }
  | { ok: false; errors: Partial<Record<SelfRegisterField, string>>; values: Record<string, string> };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/** The raw form values, trimmed, for re-rendering the form. */
export function selfRegisterFormValues(body: unknown): Record<string, string> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    org_nr: str(b.org_nr).slice(0, 20),
    company_name: str(b.company_name).slice(0, SELF_REGISTER_FIELD_LIMITS.companyName),
    place: str(b.place).slice(0, SELF_REGISTER_FIELD_LIMITS.place),
    submitter_name: str(b.submitter_name).slice(0, SELF_REGISTER_FIELD_LIMITS.submitterName),
    email: str(b.email).slice(0, EMAIL_ADDRESS_MAX_LENGTH),
    phone: str(b.phone).slice(0, SELF_REGISTER_FIELD_LIMITS.phone),
    description: str(b.description).slice(0, SELF_REGISTER_FIELD_LIMITS.description),
    producer_type: str(b.producer_type),
    website: str(b.website).slice(0, SELF_REGISTER_FIELD_LIMITS.website),
  };
}

export function parseSelfRegisterForm(body: unknown): ParseSelfRegisterResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors: Partial<Record<SelfRegisterField, string>> = {};
  const values = selfRegisterFormValues(body);

  const orgNr = str(b.org_nr).replace(/\s/g, "");
  if (!/^\d{9}$/.test(orgNr)) errors.org_nr = "Skriv organisasjonsnummeret med 9 siffer.";

  const companyName = str(b.company_name);
  if (companyName.length < 2 || companyName.length > SELF_REGISTER_FIELD_LIMITS.companyName) {
    errors.company_name = "Skriv bedriftsnavnet slik det står i Brønnøysundregistrene.";
  }
  const place = str(b.place);
  if (place.length < 2 || place.length > SELF_REGISTER_FIELD_LIMITS.place) errors.place = "Skriv kommune eller poststed.";

  const submitterName = str(b.submitter_name);
  if (submitterName.length < 2 || submitterName.length > SELF_REGISTER_FIELD_LIMITS.submitterName) {
    errors.submitter_name = "Skriv navnet ditt.";
  }
  const email = str(b.email).toLowerCase();
  if (!email || !isSingleEmailAddress(email)) errors.email = "Skriv en gyldig e-postadresse.";

  const phoneRaw = str(b.phone);
  if (phoneRaw && (phoneRaw.length > SELF_REGISTER_FIELD_LIMITS.phone || !/^[+0-9 ()-]{4,}$/.test(phoneRaw))) {
    errors.phone = "Skriv et gyldig telefonnummer, eller la feltet stå tomt.";
  }
  const description = str(b.description);
  if (description.length > SELF_REGISTER_FIELD_LIMITS.description) {
    errors.description = `Beskrivelsen kan være på høyst ${SELF_REGISTER_FIELD_LIMITS.description} tegn.`;
  }
  const producerType = str(b.producer_type);
  if (!SELF_REGISTER_PRODUCER_TYPES.some((t) => t.value === producerType)) errors.producer_type = "Velg hva dere lager.";

  const website = str(b.website);
  if (website && (website.length > SELF_REGISTER_FIELD_LIMITS.website || /\s/.test(website) || !/\./.test(website))) {
    errors.website = "Skriv en gyldig nettadresse, eller la feltet stå tomt.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return {
    ok: true,
    input: {
      orgNr,
      companyName,
      place,
      submitterName,
      email,
      phone: phoneRaw || null,
      description,
      producerType,
      website: website || null,
      confirmNotDuplicate: str(b.confirm_not_duplicate) === "1",
    },
  };
}

// ── Dependencies (test seam) ─────────────────────────────────────────────────

export interface SelfRegisterDeps {
  /** Live Brreg lookup of one org.nr. */
  brregLookup(orgNr: string): Promise<BrregEnhetLookup>;
  /** The RFB blocklist check (blocklist-service.ts). */
  isBlocked: typeof isBlocked;
  /** The experiences enrichment write-pause gate: null = may write. */
  writePauseBlock(): EnrichmentWritePausedBody | null;
  /** An RFB agent with the same org.nr, read only. */
  findRfbAgentByOrgNr(orgNr: string): { agentId: string } | null;
}

/** The Brreg lookup's timeout. A form POST waits for it, so shorter than the
 *  client's 15 s batch default. */
export const SELF_REGISTER_BRREG_TIMEOUT_MS = 8000;

export const defaultSelfRegisterDeps: SelfRegisterDeps = {
  brregLookup: (orgNr) => lookupBrregEnhet(orgNr, globalThis.fetch, SELF_REGISTER_BRREG_TIMEOUT_MS),
  isBlocked,
  // The pause table lives on the main database; the thunk makes a getDb()
  // that throws fail CLOSED as a 423 (see EnrichmentWriteDb).
  writePauseBlock: () => enrichmentWritePauseBlock(getRfbDb, "experiences"),
  findRfbAgentByOrgNr: (orgNr) => {
    try {
      const m = findRegisterSiblingMatch(getRfbDb(), { org_nr: orgNr });
      return m && m.match === "org_nr" ? { agentId: m.existingId } : null;
    } catch (err) {
      console.error("[gardssalg-self-register] RFB org.nr lookup failed (no signal):", err);
      return null;
    }
  },
};

let depsOverride: Partial<SelfRegisterDeps> | null = null;

/** Test-only: replace some dependencies; null restores the defaults. */
export function __setSelfRegisterDepsForTesting(d: Partial<SelfRegisterDeps> | null): void {
  depsOverride = d;
}

function deps(): SelfRegisterDeps {
  return { ...defaultSelfRegisterDeps, ...(depsOverride ?? {}) };
}

// ── Duplicate checks ─────────────────────────────────────────────────────────

interface ProviderDupRow {
  id: string;
  navn: string;
  slug: string | null;
  kommune: string | null;
  poststed: string | null;
  org_nr: string | null;
  producer_type: string | null;
  rfb_seed_source: string | null;
  catalog_hidden: number | null;
  catalog_hidden_reason: string | null;
  is_test_provider: number | null;
  merged_into: string | null;
}

const DUP_COLUMNS =
  "id, navn, slug, kommune, poststed, org_nr, producer_type, rfb_seed_source, catalog_hidden, catalog_hidden_reason, is_test_provider, merged_into";

/** Follows merged_into to the terminal row (at most 10 hops; a cycle or a
 *  dangling pointer stops at the last row found). */
function followMergedInto(db: ReturnType<typeof getDb>, row: ProviderDupRow): ProviderDupRow {
  let cur = row;
  const seen = new Set<string>([cur.id]);
  for (let i = 0; i < 10 && cur.merged_into && cur.merged_into !== ""; i++) {
    const next = db.prepare(`SELECT ${DUP_COLUMNS} FROM experience_providers WHERE id = ?`).get(cur.merged_into) as
      | ProviderDupRow
      | undefined;
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

export type OrgNrDuplicate =
  | { kind: "claimable"; providerId: string; slug: string }
  | { kind: "hidden"; providerId: string };

/**
 * Duplicate check 1 (Spec A): the same org.nr anywhere in experience_providers
 * — catalog_hidden rows and merged rows included; merged_into is followed to
 * its target. "claimable" = the target is visible on the claim surface (the
 * same rule GET /kategori/gardssalg/eier/:slug applies), so the visitor can
 * take it over; anything else is "hidden".
 */
export function findOrgNrDuplicate(orgNr: string): OrgNrDuplicate | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT ${DUP_COLUMNS} FROM experience_providers
        WHERE org_nr = @o OR REPLACE(org_nr, ' ', '') = @o
        ORDER BY (merged_into IS NULL OR merged_into = '') DESC, created_at ASC
        LIMIT 1`,
    )
    .get({ o: orgNr }) as ProviderDupRow | undefined;
  if (!row) return null;
  const target = followMergedInto(db, row);
  const claimable =
    !!target.slug &&
    (target.merged_into == null || target.merged_into === "") &&
    isGardssalgVisibleOnSurface(target, "claim");
  return claimable ? { kind: "claimable", providerId: target.id, slug: target.slug! } : { kind: "hidden", providerId: target.id };
}

export interface NameKommuneDuplicate {
  providerId: string;
  navn: string;
  /** Set only when the profile can be claimed (a link is shown). */
  claimSlug: string | null;
}

function normPlace(s: string | null | undefined): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\bkommune\b/g, "")
    .replace(/[^a-z0-9æøå]+/g, " ")
    .trim();
}

/**
 * Duplicate check 2 (Spec A): another provider whose name matches
 * (nameSimilarity at the enrichment threshold) in the same kommune/poststed.
 * Compared in JS, not SQL: SQLite's lower() is ASCII-only, so æøå would
 * never match. Merged-away rows are skipped (their target is the canonical
 * row and is itself a candidate).
 */
export function findNameKommuneDuplicates(names: string[], places: Array<string | null | undefined>, limit = 5): NameKommuneDuplicate[] {
  const wantedPlaces = new Set(places.map(normPlace).filter((p) => p.length > 0));
  const wantedNames = names.map((n) => String(n || "").trim()).filter((n) => n.length > 0);
  if (wantedPlaces.size === 0 || wantedNames.length === 0) return [];
  const db = getDb(VERTICAL);
  const rows = db
    .prepare(
      `SELECT ${DUP_COLUMNS} FROM experience_providers
        WHERE (merged_into IS NULL OR merged_into = '')
          AND (kommune IS NOT NULL OR poststed IS NOT NULL)`,
    )
    .all() as ProviderDupRow[];
  const out: NameKommuneDuplicate[] = [];
  for (const r of rows) {
    if (!wantedPlaces.has(normPlace(r.kommune)) && !wantedPlaces.has(normPlace(r.poststed))) continue;
    if (!wantedNames.some((n) => nameSimilarity(n, r.navn) >= BRREG_NAME_SIMILARITY_MIN)) continue;
    const claimable = !!r.slug && isGardssalgVisibleOnSurface(r, "claim");
    out.push({ providerId: r.id, navn: r.navn, claimSlug: claimable ? r.slug : null });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Submission ───────────────────────────────────────────────────────────────

export type BrregRejectReason = "not_found" | "inactive" | "wrong_nace" | "name_mismatch";
export type ContentRejectReason = "code_artifact" | "internal_note" | "theme_spam";

export type SelfRegisterOutcome =
  | { kind: "blocked" }
  | { kind: "content_rejected"; reason: ContentRejectReason }
  | { kind: "paused"; body: EnrichmentWritePausedBody }
  | { kind: "existing_claimable"; providerId: string; slug: string }
  | { kind: "existing_hidden"; providerId: string }
  | { kind: "brreg_rejected"; reason: BrregRejectReason }
  | { kind: "brreg_unavailable"; registrationId: string }
  | { kind: "possible_duplicate"; nameKommune: NameKommuneDuplicate[]; rfbAgent: boolean }
  | { kind: "created"; providerId: string; registrationId: string };

interface RegistrationRow {
  status: "pending_review" | "exists_hidden" | "brreg_unavailable";
  providerId: string | null;
  brregStatus: "verified" | "unavailable" | "not_checked";
  duplicateSignals: unknown;
  possibleDuplicateOf: string | null;
}

function insertRegistration(input: SelfRegisterInput, r: RegistrationRow): string {
  const db = getDb(VERTICAL);
  // One open trail per org.nr + submitter e-mail + status: a resubmission of
  // the same form does not stack rows in the review queue.
  const existing = db
    .prepare(
      `SELECT id FROM gardssalg_self_registrations
        WHERE org_nr = ? AND submitter_email = ? AND status = ? AND status != 'pending_review'
        LIMIT 1`,
    )
    .get(input.orgNr, input.email, r.status) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO gardssalg_self_registrations (
       id, status, provider_id, org_nr, submitted_name, submitted_place, submitted_producer_type,
       submitted_website, description, submitter_name, submitter_email, submitter_email_source,
       submitter_phone, brreg_status, brreg_checked_at, duplicate_signals, possible_duplicate_of
     ) VALUES (
       @id, @status, @provider_id, @org_nr, @submitted_name, @submitted_place, @submitted_producer_type,
       @submitted_website, @description, @submitter_name, @submitter_email, 'self_registered',
       @submitter_phone, @brreg_status, @brreg_checked_at, @duplicate_signals, @possible_duplicate_of
     )`,
  ).run({
    id,
    status: r.status,
    provider_id: r.providerId,
    org_nr: input.orgNr,
    submitted_name: input.companyName,
    submitted_place: input.place,
    submitted_producer_type: input.producerType,
    submitted_website: input.website,
    description: input.description || null,
    submitter_name: input.submitterName,
    submitter_email: input.email,
    submitter_phone: input.phone,
    brreg_status: r.brregStatus,
    brreg_checked_at: r.brregStatus === "not_checked" ? null : new Date().toISOString(),
    duplicate_signals: r.duplicateSignals == null ? null : JSON.stringify(r.duplicateSignals),
    possible_duplicate_of: r.possibleDuplicateOf,
  });
  return id;
}

function contentRejectReason(description: string): ContentRejectReason | null {
  if (!description) return null;
  if (looksLikeCodeArtifact(description)) return "code_artifact";
  if (hasInternalNote(description)) return "internal_note";
  if (looksLikeThemeSpam(description)) return "theme_spam";
  return null;
}

export async function submitSelfRegistration(input: SelfRegisterInput): Promise<SelfRegisterOutcome> {
  const d = deps();

  // 1. Blocklist on what the submitter typed — the same call RFB's
  //    POST /api/marketplace/register makes, plus the org.nr.
  const blocked = d.isBlocked({ name: input.companyName, website: input.website ?? undefined, email: input.email, orgNr: input.orgNr });
  if (blocked.blocked) {
    console.log(`[blocklist] refused gardssalg self-registration for ${input.orgNr} (matched ${blocked.matchedBy})`);
    return { kind: "blocked" };
  }

  // 2. RFB description filters.
  const contentReason = contentRejectReason(input.description);
  if (contentReason) return { kind: "content_rejected", reason: contentReason };

  // 3. Write pause for the experiences vertical.
  const pause = d.writePauseBlock();
  if (pause) return { kind: "paused", body: pause };

  // 4. Duplicate check 1 — same org.nr, before anything else is looked up.
  const sameOrg = findOrgNrDuplicate(input.orgNr);
  if (sameOrg?.kind === "claimable") {
    console.log(`[gardssalg-self-register] org.nr ${input.orgNr} already has a claimable profile ${sameOrg.providerId}; sent to the claim page`);
    return { kind: "existing_claimable", providerId: sameOrg.providerId, slug: sameOrg.slug };
  }
  if (sameOrg?.kind === "hidden") {
    insertRegistration(input, {
      status: "exists_hidden",
      providerId: sameOrg.providerId,
      brregStatus: "not_checked",
      duplicateSignals: { org_nr: sameOrg.providerId },
      possibleDuplicateOf: null,
    });
    console.log(`[gardssalg-self-register] org.nr ${input.orgNr} already has a hidden profile ${sameOrg.providerId}; trail stored for manual review`);
    return { kind: "existing_hidden", providerId: sameOrg.providerId };
  }

  // 5. Brreg gate.
  const brreg = await d.brregLookup(input.orgNr);
  if (brreg.kind === "error") {
    // Brreg did not answer. Never a profile: the submission is kept for
    // manual review with the signals we could compute without Brreg.
    const nameKommune = findNameKommuneDuplicates([input.companyName], [input.place]);
    const rfbAgent = d.findRfbAgentByOrgNr(input.orgNr);
    const registrationId = insertRegistration(input, {
      status: "brreg_unavailable",
      providerId: null,
      brregStatus: "unavailable",
      duplicateSignals: {
        name_kommune: nameKommune.map((c) => c.providerId),
        rfb_agent: rfbAgent ? rfbAgent.agentId : null,
      },
      possibleDuplicateOf: null,
    });
    console.warn(`[gardssalg-self-register] Brreg unavailable for ${input.orgNr}; stored ${registrationId} without a profile`);
    return { kind: "brreg_unavailable", registrationId };
  }
  if (brreg.kind === "not_found") return { kind: "brreg_rejected", reason: "not_found" };
  if (!brreg.active) return { kind: "brreg_rejected", reason: "inactive" };
  if (!selfRegisterNaceAllowed(brreg.naeringskode1)) return { kind: "brreg_rejected", reason: "wrong_nace" };
  if (!brreg.navn || nameSimilarity(input.companyName, brreg.navn) < BRREG_NAME_SIMILARITY_MIN) {
    return { kind: "brreg_rejected", reason: "name_mismatch" };
  }

  // 6. Blocklist on the registered name the profile will carry.
  const blockedBrreg = d.isBlocked({ name: brreg.navn, orgNr: input.orgNr });
  if (blockedBrreg.blocked) {
    console.log(`[blocklist] refused gardssalg self-registration for ${input.orgNr} on its Brreg name (matched ${blockedBrreg.matchedBy})`);
    return { kind: "blocked" };
  }

  // 7. Duplicate checks 2 and 3.
  const displayNavn = brregDisplayName(brreg.navn);
  const displayKommune = brreg.kommune ? brregDisplayName(brreg.kommune) : null;
  const displayPoststed = brreg.poststed ? brregDisplayName(brreg.poststed) : null;
  const nameKommune = findNameKommuneDuplicates(
    [input.companyName, displayNavn],
    [displayKommune, displayPoststed, input.place],
  );
  const rfbAgent = d.findRfbAgentByOrgNr(input.orgNr);
  if ((nameKommune.length > 0 || rfbAgent) && !input.confirmNotDuplicate) {
    return { kind: "possible_duplicate", nameKommune, rfbAgent: !!rfbAgent };
  }
  const possibleDuplicateOf = nameKommune.length > 0
    ? nameKommune[0]!.providerId
    : rfbAgent
    ? `rfb:${rfbAgent.agentId}`
    : null;

  // 8. Create the hidden row + the registration row, in one transaction.
  const db = getDb(VERTICAL);
  const producerType = selfRegisterProducerType(brreg.naeringskode1, input.producerType);
  try {
    const result = db.transaction(() => {
      const providerId = createProvider({
        org_nr: input.orgNr,
        navn: displayNavn,
        adresse: brreg.adresse ?? undefined,
        postnummer: brreg.postnummer ?? undefined,
        poststed: displayPoststed ?? undefined,
        kommune: displayKommune ?? undefined,
        kommunenummer: brreg.kommunenummer ?? undefined,
        organisasjonsform: brreg.orgForm ?? undefined,
        naeringskode: brreg.naeringskode1 ?? undefined,
        brreg_verified: 1,
        brreg_active: 1,
        source: SELF_REGISTERED_ORIGIN,
        confidence: "medium",
        verification_status: "needs_review",
      });
      db.prepare(
        `UPDATE experience_providers
            SET slug = @slug,
                catalog_hidden = 1,
                catalog_hidden_reason = @reason,
                origin = @origin,
                producer_type = @producer_type,
                possible_duplicate_of = @dup,
                booking_live = 0,
                brreg_checked_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = @id`,
      ).run({
        id: providerId,
        slug: providerSlugFor(displayNavn, providerId),
        reason: SELF_REGISTERED_PENDING_REVIEW_REASON,
        origin: SELF_REGISTERED_ORIGIN,
        producer_type: producerType,
        dup: possibleDuplicateOf,
      });
      const registrationId = insertRegistration(input, {
        status: "pending_review",
        providerId,
        brregStatus: "verified",
        duplicateSignals: {
          name_kommune: nameKommune.map((c) => c.providerId),
          rfb_agent: rfbAgent ? rfbAgent.agentId : null,
          confirmed_not_duplicate: input.confirmNotDuplicate,
        },
        possibleDuplicateOf,
      });
      return { providerId, registrationId };
    })();
    console.log(`[gardssalg-self-register] created hidden provider ${result.providerId} for ${input.orgNr} (registration ${result.registrationId})`);
    return { kind: "created", ...result };
  } catch (err: any) {
    // A concurrent submission for the same org.nr won the UNIQUE(org_nr) race.
    if (String(err?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const again = findOrgNrDuplicate(input.orgNr);
      if (again?.kind === "claimable") return { kind: "existing_claimable", providerId: again.providerId, slug: again.slug };
      if (again) return { kind: "existing_hidden", providerId: again.providerId };
    }
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Skive 2 — Spec D (e-mail code) + Spec E (draft mode)
// ═════════════════════════════════════════════════════════════════════════════
//
// D. After a "created" submission the route asks for a confirm link
//    (issueSelfRegisterConfirmToken) and e-mails it to the address the
//    submitter typed — the ONLY use of that address before approval
//    (dev-request 2026-08-06-aldri-gjett-epostadresse: never guessed, never
//    derived, never written to experience_providers.epost here). The token is
//    32 random bytes; only its SHA-256 is stored, with an expiry, and it can
//    be used once. The link opens a confirm page (GET changes nothing — mail
//    scanners open links); only the POST from that page confirms
//    (confirmSelfRegisterEmail). Confirming proves access to the mailbox, not
//    ownership, so the claim is assessed: until the 2026-10-30 assessment
//    module exists the result is ALWAYS 'yellow' and the registration stays
//    in Daniel's queue (claim_assessment, rule version below).
//
// E. The confirm also issues a draft-mode owner session: a gardssalg_claims
//    row (the same table, token shape and oa_owner_session cookie as
//    verifyClaimToken) with draft_mode=1 and used=0. used=0 keeps it out of
//    every "claimed / has an owner" query (all keyed on used=1), so no
//    «bekreftet av eier» badge, no claimed_at, no content_source='claim'.
//    verifyClaimToken and verifyGardssalgOwnerSessionToken refuse draft rows,
//    so the ordinary portal, its pause/resume (publish) and JSON routes stay
//    closed to it. Only verifySelfRegisterDraftSession below accepts it, and
//    only while the row is still hidden with reason
//    self_registered_pending_review. Edits go through the real
//    updateClaimedProviderProfile (CLAIM_EDITABLE_FIELDS), whose booking gate
//    (ownerBookingEnableBlock) refuses booking for the pending row.

/** How long the e-mailed confirm link is valid. */
export const SELF_REGISTER_CONFIRM_VALID_HOURS = 48;
/** How long the draft-mode session lasts (same as an ordinary claim session). */
export const SELF_REGISTER_DRAFT_SESSION_HOURS = 7 * 24;
/** The rule version recorded with every claim_assessment written here. */
export const SELF_REGISTER_ASSESSMENT_RULE_VERSION = "selvreg-s2-no-module-2026-11-12";
export const SELF_REGISTERED_CLAIM_EMAIL_SOURCE = "self_registered";

export function hashSelfRegisterToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedSelfRegisterConfirm {
  token: string;
  /** The submitter's own typed address — the code's only recipient. */
  to: string;
  providerName: string;
  expiresAt: string;
}

/**
 * Issue the e-mail code for one 'pending_review' registration whose provider
 * row is still hidden pending review. Replaces any earlier unused code of the
 * same registration. Returns null when the registration does not qualify.
 */
export function issueSelfRegisterConfirmToken(registrationId: string): IssuedSelfRegisterConfirm | null {
  const db = getDb(VERTICAL);
  const reg = db
    .prepare(
      `SELECT r.id, r.submitter_email, r.email_confirmed_at, p.navn
         FROM gardssalg_self_registrations r
         JOIN experience_providers p ON p.id = r.provider_id
        WHERE r.id = ? AND r.status = 'pending_review'
          AND p.catalog_hidden = 1 AND p.catalog_hidden_reason = ?`,
    )
    .get(registrationId, SELF_REGISTERED_PENDING_REVIEW_REASON) as
    | { id: string; submitter_email: string; email_confirmed_at: string | null; navn: string }
    | undefined;
  if (!reg || reg.email_confirmed_at) return null;
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SELF_REGISTER_CONFIRM_VALID_HOURS * 3600 * 1000).toISOString();
  db.prepare(
    `UPDATE gardssalg_self_registrations
        SET email_code_hash = @hash, email_code_expires_at = @expires, email_code_sent_at = @now, email_code_used_at = NULL
      WHERE id = @id`,
  ).run({ id: reg.id, hash: hashSelfRegisterToken(token), expires: expiresAt, now: now.toISOString() });
  return { token, to: reg.submitter_email, providerName: reg.navn, expiresAt };
}

export interface SelfRegisterClaimAssessment {
  result: "yellow";
  rule_version: string;
  assessed_at: string;
  reason: "assessment_module_missing";
  signals: Array<{ signal: string; value: unknown; source: string; at: string }>;
}

export type ConfirmSelfRegisterResult =
  | { ok: true; providerId: string; registrationId: string; sessionToken: string; assessment: SelfRegisterClaimAssessment }
  | { ok: false; error: "invalid" | "expired" | "used" };

/** Token shape: 64 lower-case hex characters (32 random bytes). */
function isTokenShape(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

/**
 * The POST half of the confirm link. Single use: the code is marked used in
 * the same transaction that issues the draft session, guarded on
 * email_code_used_at IS NULL so two concurrent POSTs cannot both win.
 */
export function confirmSelfRegisterEmail(token: unknown, now: Date = new Date()): ConfirmSelfRegisterResult {
  if (!isTokenShape(token)) return { ok: false, error: "invalid" };
  const db = getDb(VERTICAL);
  const reg = db
    .prepare(
      `SELECT r.id, r.provider_id, r.submitter_email, r.email_code_expires_at, r.email_code_used_at, r.brreg_status,
              r.duplicate_signals, r.possible_duplicate_of, p.catalog_hidden, p.catalog_hidden_reason
         FROM gardssalg_self_registrations r
         LEFT JOIN experience_providers p ON p.id = r.provider_id
        WHERE r.email_code_hash = ?`,
    )
    .get(hashSelfRegisterToken(token)) as
    | {
        id: string;
        provider_id: string | null;
        submitter_email: string;
        email_code_expires_at: string | null;
        email_code_used_at: string | null;
        brreg_status: string;
        duplicate_signals: string | null;
        possible_duplicate_of: string | null;
        catalog_hidden: number | null;
        catalog_hidden_reason: string | null;
      }
    | undefined;
  if (!reg || !reg.provider_id) return { ok: false, error: "invalid" };
  if (reg.email_code_used_at) return { ok: false, error: "used" };
  const expiresMs = Date.parse(String(reg.email_code_expires_at || ""));
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) return { ok: false, error: "expired" };
  // The row must still be the hidden, pending one (not approved, rejected or
  // re-hidden for another reason since the code was sent).
  if (Number(reg.catalog_hidden) !== 1 || reg.catalog_hidden_reason !== SELF_REGISTERED_PENDING_REVIEW_REASON) {
    return { ok: false, error: "invalid" };
  }

  const at = now.toISOString();
  const assessment: SelfRegisterClaimAssessment = {
    result: "yellow",
    rule_version: SELF_REGISTER_ASSESSMENT_RULE_VERSION,
    assessed_at: at,
    reason: "assessment_module_missing",
    signals: [
      { signal: "mailbox_access_proven", value: true, source: "self_register_email_code", at },
      { signal: "brreg_status", value: reg.brreg_status, source: "gardssalg_self_registrations", at },
      { signal: "possible_duplicate_of", value: reg.possible_duplicate_of, source: "gardssalg_self_registrations", at },
    ],
  };
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const claimId = `gsc_${crypto.randomBytes(8).toString("hex")}`;
  const sessionExpires = new Date(now.getTime() + SELF_REGISTER_DRAFT_SESSION_HOURS * 3600 * 1000).toISOString();

  const won = db.transaction((): boolean => {
    const upd = db
      .prepare(
        `UPDATE gardssalg_self_registrations
            SET email_code_used_at = @at, email_confirmed_at = @at, claim_assessment = @assessment
          WHERE id = @id AND email_code_used_at IS NULL`,
      )
      .run({ id: reg.id, at, assessment: JSON.stringify(assessment) });
    if (upd.changes !== 1) return false;
    db.prepare(
      `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at, is_test, draft_mode)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 1)`,
    ).run(claimId, reg.provider_id, reg.submitter_email, SELF_REGISTERED_CLAIM_EMAIL_SOURCE, sessionToken, at, sessionExpires);
    return true;
  })();
  if (!won) return { ok: false, error: "used" };
  console.log(`[gardssalg-self-register] e-mail confirmed for registration ${reg.id}; draft session issued for ${reg.provider_id} (assessment yellow → manual review)`);
  return { ok: true, providerId: reg.provider_id, registrationId: reg.id, sessionToken, assessment };
}

export interface SelfRegisterDraftSession {
  valid: boolean;
  providerId?: string;
}

/**
 * A draft-mode session: a gardssalg_claims row with draft_mode=1, used=0,
 * not revoked, not expired, whose provider row is still hidden pending
 * review. Anything else (an ordinary owner token included) is not a draft
 * session.
 */
export function verifySelfRegisterDraftSession(token: string | undefined | null, now: Date = new Date()): SelfRegisterDraftSession {
  if (!isTokenShape(token)) return { valid: false };
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT c.provider_id, c.expires_at
         FROM gardssalg_claims c
         JOIN experience_providers p ON p.id = c.provider_id
        WHERE c.token = ? AND c.draft_mode = 1 AND c.used = 0 AND c.revoked_at IS NULL
          AND p.catalog_hidden = 1 AND p.catalog_hidden_reason = ?`,
    )
    .get(token, SELF_REGISTERED_PENDING_REVIEW_REASON) as { provider_id: string; expires_at: string } | undefined;
  if (!row) return { valid: false };
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || exp <= now.getTime()) return { valid: false };
  return { valid: true, providerId: row.provider_id };
}

export interface SelfRegisterDraftProfile {
  id: string;
  navn: string;
  kommune: string | null;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  products: string | null;
  hjemmeside: string | null;
  booking_live: number | null;
  epost: string | null;
  booking_admin_brake_at: string | null;
  booking_admin_brake_note: string | null;
  catalog_hidden_reason: string | null;
}

export function getSelfRegisterDraftProfile(providerId: string): SelfRegisterDraftProfile | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, kommune, about_text, visit_text, opening_hours_text, products, hjemmeside, booking_live,
              epost, booking_admin_brake_at, booking_admin_brake_note, catalog_hidden_reason
         FROM experience_providers WHERE id = ?`,
    )
    .get(providerId) as SelfRegisterDraftProfile | undefined;
  return row ?? null;
}

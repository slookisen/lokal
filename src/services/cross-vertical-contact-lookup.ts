// ─── Cross-Vertical Contact Lookup (read-only) ──────────────────────
//
// dev-requests/2026-09-13-fjern-svar-kobles-ikke-paa-tvers-av-vertikaler.md
//
// The customer-service "fjern" (opt-out/removal) flow currently only acts
// on the single vertical an opt-out email arrived on — it never checks
// whether the same producer's contact email is also live on a DIFFERENT
// vertical (rfb / dental / experiences each have their own sqlite DB file
// and their own producer/agent table — there is no shared identity layer
// across them). Verified: no such cross-vertical lookup exists anywhere in
// the codebase today — crm-service.ts's resolveContact is scoped to one
// vertical's `crm_contacts` table only.
//
// This module is that lookup, and NOTHING else:
//   - EXACT email match only, never fuzzy name/organization matching. A
//     shared email (e.g. an accounting office serving multiple producers)
//     must never produce a false cross-vertical link via name similarity —
//     exact email is the only safe join key here.
//   - ACTIVE rows only — each vertical's own liveness convention is applied
//     as a WHERE-clause predicate, since a deactivated/terminal row must
//     never produce a false "still active" signal for the opt-out flow this
//     module backs. Each vertical spells "active" differently, so the
//     predicate is per-table, not a shared generic "status" check:
//       rfb          agents               is_active = 1
//       dental       dental_agents        verification_status != 'rejected'
//                                          AND (is_inactive IS NULL OR is_inactive = 0)
//                                          AND DENTAL_CLINIC_CLASS_SQL
//       experiences  experience_providers terminal_status IS NULL
//                                          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
//                                          AND (name_collision IS NULL OR name_collision != 1)
//     round-2 review fix-up (PR #860): dental's predicate was missing the
//     verification_status != 'rejected' half (a row a human/prior sweep
//     determined was never actually a dental clinic, e.g. a misclassified
//     hearing-aid supplier via a wrong NACE code — orthogonal to
//     is_inactive; see dental-store.ts's own combined-predicate precedent
//     below), and experiences' predicate never checked catalog_hidden — the
//     actual "fjern oss" delist lever for real producers (POST
//     /admin/gardssalg-provider-visibility, opplevelser.ts, which ALSO
//     atomically blocklists org_nr/website/epost) since the 2026-08-17 fix
//     documented in init-experiences.ts. Both are now the fuller predicate
//     the rest of the codebase already uses for these two tables.
//     round-3 review fix-up (PR #860): dental also ANDs in
//     DENTAL_CLINIC_CLASS_SQL (dental-catalog-class.ts) — excludes rows
//     positively classified as non-clinics (lab_leverandor/holding/
//     person_enk), orthogonal to verification_status/is_inactive — and
//     experiences also ANDs in `(name_collision IS NULL OR name_collision
//     != 1)` — excludes rows whose Brreg identity/email ownership is still
//     unresolved (init-experiences.ts:819). See each spec's own comment
//     below for the full rationale.
//   - Strictly read-only. Zero INSERT/UPDATE/DELETE/ALTER in this file.
//
// Each vertical's own producer/agent table + email column:
//   rfb          agents               (getDb() from ../database/init)      contact_email
//   dental       dental_agents        (getDb('dental') via db-factory)     epost
//   experiences  experience_providers (getDb('experiences') via db-factory) epost

import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { CRM_VERTICALS, CrmVertical } from "./crm-service";
import { DENTAL_CLINIC_CLASS_SQL } from "./dental-catalog-class";

export interface CrossVerticalHit {
  vertical: CrmVertical;
  id: string;
  name: string;
}

interface VerticalTableSpec {
  table: string;
  emailColumn: string;
  nameColumn: string;
  // WHERE-clause fragment (ANDed onto the email match) that selects only
  // LIVE/ACTIVE rows, in this table's own liveness convention — see the
  // file-header comment for why this is per-table rather than shared.
  activePredicate: string;
}

// One entry per CrmVertical — kept as a Record so TypeScript flags it if a
// future vertical is added to CRM_VERTICALS without a matching spec here.
const VERTICAL_TABLE_SPECS: Record<CrmVertical, VerticalTableSpec> = {
  rfb: {
    table: "agents",
    emailColumn: "contact_email",
    nameColumn: "name",
    // Same convention as crm-service.ts:228,242,253; is_active flipped to 0
    // by admin-agents-deactivate.ts on opt-out/deactivation.
    activePredicate: "is_active = 1",
  },
  dental: {
    table: "dental_agents",
    emailColumn: "epost",
    nameColumn: "navn",
    // Same convention as dental-store.ts:1236,1319,1379,1408,1477,1485 and
    // dental-verifier.ts:411: a row is live only if it was never determined
    // to be a non-dental-clinic (verification_status != 'rejected', set by
    // admin-dental-catalog-class-sonnet-sample.ts) AND is not permanently
    // closed (is_inactive IS NULL OR is_inactive = 0). Round-1's fix-up
    // only carried the is_inactive half over; round-2 adds the
    // verification_status half that the cited precedent lines actually use.
    // round-3 review fix-up (PR #860): also AND in DENTAL_CLINIC_CLASS_SQL
    // (services/dental-catalog-class.ts), the SAME "is this row actually a
    // clinic" gate ANDed onto this table everywhere else it's queried
    // (dental-store.ts:1150,1251,1324, init-dental.ts:726) -- it excludes
    // rows a classifier positively determined are NOT a patient-facing
    // clinic (lab_leverandor/holding/person_enk), which is orthogonal to
    // both verification_status and is_inactive: a misclassified supplier/
    // holding/individual can be neither rejected nor is_inactive and still
    // be the wrong kind of row to ever surface as a live "clinic contact"
    // for this module's cross-vertical check.
    activePredicate:
      "verification_status != 'rejected' AND (is_inactive IS NULL OR is_inactive = 0) AND " +
      DENTAL_CLINIC_CLASS_SQL,
  },
  experiences: {
    table: "experience_providers",
    emailColumn: "epost",
    nameColumn: "navn",
    // terminal_status is NULL by default; a non-NULL value ("krever_eier" /
    // "dod_kilde") marks the row permanently dead — see
    // init-experiences.ts:1707 and opplevelser.ts's
    // computeGardssalgReadinessTier for the write path. ALSO excludes
    // catalog_hidden=1 rows (round-2 fix-up): catalog_hidden is the actual
    // "fjern oss" delist lever for real producers, set atomically with an
    // org_nr/website/epost blocklist by POST /admin/gardssalg-provider-
    // visibility (opplevelser.ts, "gardssalg-provider-visibility hide (fjern
    // oss)") since the 2026-08-17 P0 consent-bug fix documented in
    // init-experiences.ts:791-805 — exactly the removal event this module
    // exists to detect cross-vertical exposure for. Same NULL-safe
    // `(catalog_hidden IS NULL OR catalog_hidden != 1)` form used
    // throughout experience-store.ts (e.g. its PUBLISH_GATE_SQL).
    // round-3 review fix-up (PR #860): also AND in
    // `(name_collision IS NULL OR name_collision != 1)`. name_collision is
    // an experience_providers column (init-experiences.ts:819,
    // dev-request 2026-09-13-navnekollisjon-brreg-gate) set when a Brreg
    // org-number lookup found >=2 candidates sharing the provider's name
    // with no kommune match to disambiguate them -- the row's own identity
    // (and therefore whose email this actually is) is UNRESOLVED, so it
    // must never count as a confirmed live match for the "same contact,
    // different vertical" cross-check this module backs, independent of
    // terminal_status/catalog_hidden.
    activePredicate:
      "terminal_status IS NULL AND (catalog_hidden IS NULL OR catalog_hidden != 1) AND " +
      "(name_collision IS NULL OR name_collision != 1)",
  },
};

/**
 * Look up whether the given email has an ACTIVE entry on any CRM vertical
 * OTHER than `excludeVertical`, by EXACT (case-insensitive) email match.
 * A deactivated rfb agent (is_active = 0), a rejected/is_inactive/
 * non-clinic-classed dental_agents row, or an experience_providers row with
 * a non-NULL terminal_status, catalog_hidden = 1 or name_collision = 1 is
 * treated as gone and never appears in the result — see
 * VERTICAL_TABLE_SPECS' per-table
 * activePredicate for the exact convention each vertical uses.
 *
 * Read-only diagnostic — never fuzzy-matches on name/organization, never
 * writes anything.
 */
export function findCrossVerticalEntriesByEmail(
  email: string,
  excludeVertical: CrmVertical,
): CrossVerticalHit[] {
  const normalized = email.trim().toLowerCase();
  // Guard explicitly against an empty needle — never run a query against an
  // empty string, which could in principle match a NULL/empty column in a
  // table with data-quality gaps.
  if (!normalized) return [];

  const hits: CrossVerticalHit[] = [];

  for (const vertical of CRM_VERTICALS) {
    if (vertical === excludeVertical) continue;

    const spec = VERTICAL_TABLE_SPECS[vertical];
    const db = vertical === "rfb" ? getDb() : getVerticalDb(vertical);

    const rows = db
      .prepare(
        `SELECT id, ${spec.nameColumn} AS name FROM ${spec.table} ` +
          `WHERE trim(lower(${spec.emailColumn})) = ? AND ${spec.activePredicate}`,
      )
      .all(normalized) as Array<{ id: string; name: string }>;

    for (const row of rows) {
      hits.push({ vertical, id: row.id, name: row.name });
    }
  }

  return hits;
}

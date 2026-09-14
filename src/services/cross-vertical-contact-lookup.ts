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
//       dental       dental_agents        (is_inactive IS NULL OR is_inactive = 0)
//       experiences  experience_providers terminal_status IS NULL
//   - Strictly read-only. Zero INSERT/UPDATE/DELETE/ALTER in this file.
//
// Each vertical's own producer/agent table + email column:
//   rfb          agents               (getDb() from ../database/init)      contact_email
//   dental       dental_agents        (getDb('dental') via db-factory)     epost
//   experiences  experience_providers (getDb('experiences') via db-factory) epost

import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { CRM_VERTICALS, CrmVertical } from "./crm-service";

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
    // Same convention as dental-store.ts:1236, dental-claim-service.ts:201,
    // admin-dental-hjemmeside-discovery.ts:273.
    activePredicate: "(is_inactive IS NULL OR is_inactive = 0)",
  },
  experiences: {
    table: "experience_providers",
    emailColumn: "epost",
    nameColumn: "navn",
    // terminal_status is NULL by default; a non-NULL value ("krever_eier" /
    // "dod_kilde") marks the row permanently dead — see
    // init-experiences.ts:1707 and opplevelser.ts's
    // computeGardssalgReadinessTier for the write path.
    activePredicate: "terminal_status IS NULL",
  },
};

/**
 * Look up whether the given email has an ACTIVE entry on any CRM vertical
 * OTHER than `excludeVertical`, by EXACT (case-insensitive) email match.
 * A deactivated rfb agent (is_active = 0), an is_inactive dental_agents row,
 * or an experience_providers row with a non-NULL terminal_status is treated
 * as gone and never appears in the result — see VERTICAL_TABLE_SPECS'
 * per-table activePredicate for the exact convention each vertical uses.
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

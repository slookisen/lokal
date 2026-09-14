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
}

// One entry per CrmVertical — kept as a Record so TypeScript flags it if a
// future vertical is added to CRM_VERTICALS without a matching spec here.
const VERTICAL_TABLE_SPECS: Record<CrmVertical, VerticalTableSpec> = {
  rfb: { table: "agents", emailColumn: "contact_email", nameColumn: "name" },
  dental: { table: "dental_agents", emailColumn: "epost", nameColumn: "navn" },
  experiences: { table: "experience_providers", emailColumn: "epost", nameColumn: "navn" },
};

/**
 * Look up whether the given email has an active entry on any CRM vertical
 * OTHER than `excludeVertical`, by EXACT (case-insensitive) email match.
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
        `SELECT id, ${spec.nameColumn} AS name FROM ${spec.table} WHERE lower(${spec.emailColumn}) = ?`,
      )
      .all(normalized) as Array<{ id: string; name: string }>;

    for (const row of rows) {
      hits.push({ vertical, id: row.id, name: row.name });
    }
  }

  return hits;
}

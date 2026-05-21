// ─── Bondens Marked Address Cleanup Service ─────────────────────
//
// One-off cleanup for the 2026-04-20/21 enrichment-worker bug that
// misattributed the address `Berrvellene 7, 6817 NAUSTDAL` (a Sogn og
// Fjordane postal code) to 20 unrelated Bondens Marked venue agents
// across Narvik, Lillehammer, Trondheim, Mandal, Kabelvåg/Lofoten and
// others. The error was most likely a contact-page address misread as
// a venue address during a bondensmarked.no scrape.
//
// One additional victim (Bondens Marked Stavanger) has the CORRECT
// street address but the WRONG postal code (`6817`) — that row only
// needs the postal_code stripped, not the full address.
//
// Daniel of Rett fra Bonden received an email from Bondens marked
// Hålogaland (the regional chapter) flagging this. This module is
// invoked once by an admin endpoint (see src/routes/admin-bm-cleanup.ts),
// runs to completion, and is then dead code — but we keep it in the
// tree as the audit record of what was scrubbed.
//
// Idempotent: re-running over an already-cleaned row is a no-op,
// because the address/postal_code regex match no longer fires.

import type Database from "better-sqlite3";

// ─── The 21 affected agent UUIDs ────────────────────────────────
// 20 are full victims (bogus address + bogus postal_code).
// 1 (Bondens Marked Stavanger) is a postal-code-only victim —
// the street address is correct and must be preserved.
const BM_VICTIMS: ReadonlyArray<string> = [
  "cac70771-81e6-4ad0-90de-d82957e59354", // Bondens marked — Bærums Verk
  "264fb3dd-0745-4148-978f-7f43f2d71951", // Bondens marked — Øystese
  "8845cedc-24d5-47c8-93e0-0e393dcd570c", // Bondens marked — Mandal
  "e0f54fb3-a557-441c-b875-7056304cecde", // Bondens marked — Kabelvåg/Lofoten
  "15567f75-013f-4af8-89f3-7c344947fc3d", // Bondens marked — Steinkjer
  "6e8d6ddd-1a20-451f-87d5-547d15f87abe", // Bondens marked — Narvik
  "4e88c352-9886-46b7-b722-4337c1cef01b", // Bondens marked — Levanger
  "93f24b51-ccb0-4e80-870e-a36660b67700", // Bondens marked — Lyngdal
  "e41e49d3-dd8e-4429-b36f-a4eda7cd0fa7", // Bondens marked — Risør
  "066a2a49-69c0-45cc-8962-a90bf863b568", // Bondens marked — Sogndal
  "8286bba3-087c-4543-8e68-2defd2b65a9b", // Bondens Marked Hønefoss
  "56a0e7bf-9f1a-4656-bcfd-3125d77c6ac8", // Bondens marked — Lena (Innlandet)
  "71bfb259-0848-49ac-87dd-b46e8e23d6c7", // Bondens Marked Stavanger — postal_code only
  "3f554df6-da6c-4a1e-b187-20104a24b296", // Bondens Marked Lillehammer
  "c42424b2-b6f1-4a4b-bbf6-e86ba88afc04", // Bondens marked — Kongensgate Trondheim
  "34cc4cfe-be89-4131-ac49-cdafb7646b8e", // Bondens marked — Brumunddal
  "f8eb2521-e0b1-4821-bb7f-587f15df8d9c", // Bondens marked — Jevnaker
  "82a36a8c-02b9-4b42-8143-d8124a8c89b2", // Bondens marked — Løten
  "354793ba-77a2-41fd-8781-0a3982189c08", // Bondens marked — Råholt
  "7ead992e-64d2-4e4c-ab03-3cc3e9105f8d", // Bondens marked — Stryn
  "f5f682be-8700-4ce3-ae77-7d68b5723137", // Bondens marked — Trysil
];

// Stavanger is the special-case (address correct, only postal_code is bogus).
const STAVANGER_ID = "71bfb259-0848-49ac-87dd-b46e8e23d6c7";

// Address smear pattern + bogus postal code.
const ADDRESS_SMEAR_RE = /^Berrvellene 7/i;
const BAD_POSTAL_CODE = "6817";

// Provenance source-value matchers — strip any entry whose value
// references the bogus address or postal code.
const PROVENANCE_BAD_VALUE_RE = /Berrvellene|6817/i;

export interface CleanupResult {
  cleaned_agent_ids: string[];
  preserved_address_cases: string[];
  total_provenance_entries_removed: number;
  dry_run: boolean;
}

interface KnowledgeRow {
  agent_id: string;
  address: string | null;
  postal_code: string | null;
  field_provenance: string | null;
}

interface ProvenanceSource {
  value?: unknown;
  [k: string]: unknown;
}

interface ProvenanceForField {
  sources?: ProvenanceSource[];
  [k: string]: unknown;
}

/**
 * Pure function: walks BM_VICTIMS, nulls bogus address/postal_code,
 * strips matching field_provenance.address sources. Returns a structured
 * report. When dryRun=true, computes the report without writing.
 */
export function cleanBmAddressBug({
  db,
  dryRun,
}: {
  db: Database.Database;
  dryRun: boolean;
}): CleanupResult {
  const selectStmt = db.prepare(
    "SELECT agent_id, address, postal_code, field_provenance FROM agent_knowledge WHERE agent_id = ?"
  );
  const updateFullStmt = db.prepare(
    "UPDATE agent_knowledge SET address = NULL, postal_code = NULL, field_provenance = ? WHERE agent_id = ?"
  );
  const updateStavangerStmt = db.prepare(
    "UPDATE agent_knowledge SET postal_code = NULL, field_provenance = ? WHERE agent_id = ?"
  );

  const cleaned: string[] = [];
  const preserved: string[] = [];
  let totalRemoved = 0;

  for (const agentId of BM_VICTIMS) {
    const row = selectStmt.get(agentId) as KnowledgeRow | undefined;
    if (!row) continue;

    const addressIsBogus =
      typeof row.address === "string" && ADDRESS_SMEAR_RE.test(row.address);
    const postalIsBogus = row.postal_code === BAD_POSTAL_CODE;

    if (!addressIsBogus && !postalIsBogus) {
      // Already cleaned (or never affected) — idempotent no-op.
      continue;
    }

    // ── Build the new field_provenance ──────────────────────────
    let newProvenanceStr: string | null = row.field_provenance ?? null;
    let removedThisAgent = 0;
    if (row.field_provenance) {
      try {
        const parsed = JSON.parse(row.field_provenance) as Record<
          string,
          ProvenanceForField | unknown
        >;
        const addrField = parsed.address as ProvenanceForField | undefined;
        if (
          addrField &&
          typeof addrField === "object" &&
          Array.isArray(addrField.sources)
        ) {
          const before = addrField.sources.length;
          addrField.sources = addrField.sources.filter((src) => {
            if (!src || typeof src !== "object") return true;
            const v = (src as ProvenanceSource).value;
            if (typeof v !== "string") return true;
            return !PROVENANCE_BAD_VALUE_RE.test(v);
          });
          removedThisAgent = before - addrField.sources.length;
        }
        newProvenanceStr = JSON.stringify(parsed);
      } catch {
        // Malformed JSON — leave untouched to avoid data loss.
        newProvenanceStr = row.field_provenance;
        removedThisAgent = 0;
      }
    }

    totalRemoved += removedThisAgent;

    const isStavanger = agentId === STAVANGER_ID;
    if (isStavanger) {
      // Address is correct — strip only postal_code. Track in
      // preserved_address_cases so the report can show
      // "address kept, postal_code only stripped" rows.
      preserved.push(agentId);
      cleaned.push(agentId);
      if (!dryRun) {
        updateStavangerStmt.run(newProvenanceStr, agentId);
      }
    } else {
      cleaned.push(agentId);
      if (!dryRun) {
        updateFullStmt.run(newProvenanceStr, agentId);
      }
    }
  }

  return {
    cleaned_agent_ids: cleaned,
    preserved_address_cases: preserved,
    total_provenance_entries_removed: totalRemoved,
    dry_run: dryRun,
  };
}

// Exported for tests / audit logs.
export const BM_ADDRESS_CLEANUP_VICTIM_IDS: ReadonlyArray<string> = BM_VICTIMS;
export const BM_ADDRESS_CLEANUP_STAVANGER_ID = STAVANGER_ID;

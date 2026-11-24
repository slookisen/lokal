// ─── A producer's affiliations as its public page shows them ────────────────
// The forward selection of the producer page (routes/seo.ts, «Tilknytninger»
// card + JSON-LD memberOf): an active umbrella (a.is_active = 1), the link
// active or an inferred pending one, and — without a valid Debio status — no
// umbrella or label that makes an organic claim (organic-claims.ts).
//
// «Mine valg» S3-2 (dev-request 2026-10-22-rfb-mine-valg-eierbrytere): the
// owner hides single rows (agent_affiliations.owner_hidden_at). The page
// leaves them out only when the S3-2 gate is open (`ownerHidden: "exclude"`);
// the owner's list in «Mine valg» reads them too (`"include"`), so a hidden
// row can be shown again. `"ignore"` is the query exactly as before.

import { isOrganicClaimUmbrella } from "./organic-claims";

export interface ProducerAffiliationRow {
  umbrella_id: string;
  umbrella_name: string;
  umbrella_type: string | null;
  labels: string | null;
  status: string;
  source: string;
  /** Only with ownerHidden "include"; otherwise undefined. */
  owner_hidden_at?: string | null;
}

export interface ProducerAffiliationOptions {
  /** The producer has a valid Debio status (organic-claim umbrellas are shown). */
  organicShown: boolean;
  /** "ignore" = as before; "exclude" = drop owner-hidden rows; "include" = all, with owner_hidden_at. */
  ownerHidden: "ignore" | "exclude" | "include";
}

export function producerAffiliationRows(db: any, producerId: string, opts: ProducerAffiliationOptions): ProducerAffiliationRow[] {
  const hiddenCol = opts.ownerHidden === "include" ? ", aff.owner_hidden_at" : "";
  const hiddenWhere = opts.ownerHidden === "exclude" ? "\n            AND aff.owner_hidden_at IS NULL" : "";
  const rows = db.prepare(`
          SELECT a.id AS umbrella_id, a.name AS umbrella_name, a.umbrella_type, aff.labels,
                 aff.status, aff.source${hiddenCol}
          FROM agent_affiliations aff
          INNER JOIN agents a ON a.id = aff.umbrella_id
          WHERE aff.producer_id = ?
            AND a.is_active = 1
            AND (aff.status = 'active'
              OR (aff.status = 'pending_confirmation' AND aff.source = 'inferred'))${hiddenWhere}
          ORDER BY a.name ASC
        `).all(producerId) as ProducerAffiliationRow[];
  return opts.organicShown ? rows : rows.filter((r) =>
    !isOrganicClaimUmbrella({ umbrella_type: r.umbrella_type, name: r.umbrella_name, labels: r.labels }));
}

// ─── outreach-suppression-signals.ts — shared suppression-check helpers ────
//
// dev-request 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-gate-
// felt: two of the REAL outreach gate's suppression checks
// (GET /admin/outreach-candidates?mode=first, admin-outreach-candidates.ts —
// "Step 2b: belt-and-suspenders" and "steg 4/4e: cross-platform cooldown")
// used to be inline SQL local to that one route handler. This file extracts
// them, UNCHANGED (same SQL, same cutoff derivation, same lowercase/trim
// normalization), into importable helpers so a second caller —
// GET /admin/pool-blocker-explain — can report the SAME verdict the real
// gate would produce instead of a parallel reimplementation that could
// silently drift from it. Pure extraction: no behavior change to
// admin-outreach-candidates.ts's own gate.
//
// Both helpers take the SAME `cooldownDays` the real gate's own
// `?cooldown_days=` query param drives (default 60, see
// admin-outreach-candidates.ts) — callers are responsible for passing a
// matching value if they want an identical verdict to a live gate call.

import { getOpenDbHandles } from "../database/db-factory";
import {
  CrossPlatformIndex,
  buildCrossPlatformIdentity,
} from "./cross-platform-match";

export interface CrossPlatformSuppressor {
  vertical: string;
  last_sent_at: string;
}

// Step 2b (belt-and-suspenders): the set of lowercased recipient email
// addresses that received a cold outbound send (out/sent, no inbound reply
// on that thread — a "cold outreach" shape) within `cooldownDays`. Reads
// crm_messages directly by RECIPIENT EMAIL, independent of
// agent_id/crm_contacts linkage or outreach_sent_log — see
// admin-outreach-candidates.ts's own header comment (points a/b of the
// 2026-07-11 P0 incident) for why this exists as an invariant on top of the
// outreach_sent_log-based cooldown.
export function getRecentlyEmailedAddresses(db: any, cooldownDays: number): Set<string> {
  const cutoff = new Date(Date.now() - cooldownDays * 86400 * 1000).toISOString();
  const recentMarketingSends = db.prepare(`
    SELECT m.to_emails FROM crm_messages m
    WHERE m.direction = 'out'
      AND m.delivery_status = 'sent'
      AND m.sent_at IS NOT NULL
      AND m.sent_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM crm_messages m2
        WHERE m2.thread_id = m.thread_id AND m2.direction = 'in'
      )
  `).all(cutoff) as Array<{ to_emails: string | null }>;

  const recentlyEmailedAddresses = new Set<string>();
  for (const msg of recentMarketingSends) {
    let addrs: unknown;
    try {
      addrs = JSON.parse(msg.to_emails || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(addrs)) continue;
    for (const a of addrs) {
      if (typeof a === "string" && a) recentlyEmailedAddresses.add(a.trim().toLowerCase());
    }
  }
  return recentlyEmailedAddresses;
}

// Probe for the `vertical_id` column on outreach_sent_log (added by the
// steg-3 migration). A database that hasn't run that migration yet would
// make a `vertical_id`-filtering query throw and take the whole gate down
// with it, so callers probe first and report a degraded/"unavailable" state
// instead of a confident (and wrong) zero. Exported so a caller can surface
// this same availability flag alongside getCrossPlatformSuppressors's result
// (see admin-outreach-candidates.ts's own `cross_platform_cooldown.unavailable`).
export function outreachSentLogHasVerticalColumn(db: any): boolean {
  return (db.prepare("PRAGMA table_info(outreach_sent_log)").all() as Array<{ name: string }>)
    .some((c) => c.name === "vertical_id");
}

// Steg 4 / 4e (cross-platform cooldown): an index of the most-recent NON-'rfb'
// vertical sends (and when), within `cooldownDays`, read from
// outreach_sent_log. Both platforms send from the same verified address, so a
// producer mailed recently by another vertical must be excluded from THIS
// vertical's outreach too — see admin-outreach-candidates.ts's own header
// comment for the full rationale.
//
// dev-request 2026-10-08-kryssplattform-karantene-produsent-og-domene: the
// index no longer answers on the exact e-mail address only. `find()` also
// matches the same (non-free-mail) e-mail domain, the same website host and
// the same org number — see cross-platform-match.ts — and says which rule hit.
// The prior send's website / org number are not stored in outreach_sent_log;
// for Opplevagent sends they are read from the experiences database when the
// caller passes it (`opts.expDb`). Without it only email + domain can match.
// Defensive: on a database that hasn't run the `vertical_id` migration yet,
// this returns an empty index rather than throwing (same probe the original
// inline code used).
export function getCrossPlatformSuppressors(
  db: any,
  cooldownDays: number,
  opts?: { expDb?: any },
): CrossPlatformIndex<CrossPlatformSuppressor> {
  const cutoff = new Date(Date.now() - cooldownDays * 86400 * 1000).toISOString();
  const index = new CrossPlatformIndex<CrossPlatformSuppressor>();

  if (outreachSentLogHasVerticalColumn(db)) {
    const opplevagentById = opts?.expDb ? loadOpplevagentIdentityByEmail(opts.expDb, cutoff) : new Map();
    for (const r of db
      .prepare(
        `SELECT LOWER(recipient_email) AS email, vertical_id, MAX(sent_at) AS last_sent_at
           FROM outreach_sent_log
          WHERE recipient_email IS NOT NULL AND recipient_email != ''
            AND sent_at >= ?
            AND vertical_id IS NOT NULL AND vertical_id != 'rfb'
          GROUP BY LOWER(recipient_email), vertical_id`,
      )
      .all(cutoff) as Array<{ email: string; vertical_id: string; last_sent_at: string }>) {
      const extra = opplevagentById.get(r.email) as { website: string | null; orgNr: string | null } | undefined;
      index.add(
        buildCrossPlatformIdentity({ email: r.email, website: extra?.website, orgNr: extra?.orgNr }),
        { vertical: r.vertical_id, last_sent_at: r.last_sent_at },
      );
    }
  }
  return index;
}

// `agents.org_nr` came with a later migration; a database (or fixture) that
// lacks it simply has no org-number matching, never a failing query.
export function agentsHasOrgNrColumn(db: any): boolean {
  try {
    return (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some((c) => c.name === "org_nr");
  } catch {
    return false;
  }
}

// The experiences (Opplevagent) database handle IF it is already open — the
// server opens it at boot (index.ts). Deliberately never opens it: a gate or
// diagnostic call must not create a database connection as a side effect, and
// without it the cross-platform check degrades to address + domain matching.
export function getOpenExperiencesDb(): any | null {
  try {
    return getOpenDbHandles().find((h) => h.vertical === "experiences")?.db ?? null;
  } catch {
    return null;
  }
}

// Opplevagent provider website + org number per recipient address, for the
// sends in the window. Best effort: a missing table / column (older or test
// database) just means no website / org_nr matching, never an error.
function loadOpplevagentIdentityByEmail(
  expDb: any,
  cutoff: string,
): Map<string, { website: string | null; orgNr: string | null }> {
  const out = new Map<string, { website: string | null; orgNr: string | null }>();
  try {
    for (const r of expDb
      .prepare(
        `SELECT LOWER(l.recipient_email) AS email, p.hjemmeside AS hjemmeside, p.org_nr AS org_nr
           FROM experience_outreach_sent_log l
           JOIN experience_providers p ON p.id = l.provider_id
          WHERE l.is_test = 0 AND l.sent_at >= ?`,
      )
      .all(cutoff) as Array<{ email: string; hjemmeside: string | null; org_nr: string | null }>) {
      out.set(r.email, { website: r.hjemmeside, orgNr: r.org_nr });
    }
  } catch {
    /* experiences schema not available — email + domain matching only */
  }
  return out;
}

export interface RfbSendForOpplevagent {
  last_sent_at: string;
  vertical_id: string;
}

// The mirror image for the Opplevagent lane: an index of what ANY lane sent
// from the RFB outreach_sent_log within the window, for Opplevagent's own
// candidate / eligibility checks.
//   • email key: every row, exactly as before (Opplevagent's own earlier
//     sends mirrored into this table keep their old exact-address behaviour);
//   • domain / website / org_nr keys: only rows of OTHER verticals than
//     'experiences' — an Opplevagent send must not widen into a
//     same-domain block against Opplevagent itself. Website and org number
//     of an 'rfb' send are resolved through its agent row
//     (agents.org_nr, COALESCE(agent_knowledge.website, agents.url)).
export function getRfbSendIndexForOpplevagent(
  rfbDb: any,
  cutoffIso: string,
): CrossPlatformIndex<RfbSendForOpplevagent> {
  const index = new CrossPlatformIndex<RfbSendForOpplevagent>();
  const rows = rfbDb
    .prepare(
      `SELECT LOWER(o.recipient_email) AS email, o.vertical_id AS vertical_id, o.sent_at AS sent_at,
              ${agentsHasOrgNrColumn(rfbDb) ? "a.org_nr" : "NULL"} AS org_nr,
              COALESCE(NULLIF(TRIM(k.website), ''), NULLIF(TRIM(a.url), '')) AS website
         FROM outreach_sent_log o
         LEFT JOIN agents a ON a.id = o.agent_id
         LEFT JOIN agent_knowledge k ON k.agent_id = o.agent_id
        WHERE o.recipient_email IS NOT NULL AND o.recipient_email != ''
          AND o.sent_at >= ?`,
    )
    .all(cutoffIso) as Array<{
    email: string;
    vertical_id: string | null;
    sent_at: string;
    org_nr: string | null;
    website: string | null;
  }>;
  for (const r of rows) {
    const payload = { last_sent_at: r.sent_at, vertical_id: r.vertical_id ?? "rfb" };
    if (payload.vertical_id === "experiences") {
      index.add(buildCrossPlatformIdentity({ email: r.email }), payload, ["email"]);
    } else if (payload.vertical_id === "rfb") {
      index.add(buildCrossPlatformIdentity({ email: r.email, website: r.website, orgNr: r.org_nr }), payload);
    } else {
      index.add(buildCrossPlatformIdentity({ email: r.email }), payload);
    }
  }
  return index;
}

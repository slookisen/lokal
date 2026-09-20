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

// Steg 4 / 4e (cross-platform cooldown): a map of lowercased recipient email
// -> the most-recent NON-'rfb' vertical send (and when), within
// `cooldownDays`, read from outreach_sent_log. Both platforms send from the
// same verified address, so a recipient mailed recently by another vertical
// must be excluded from THIS vertical's outreach too — see
// admin-outreach-candidates.ts's own header comment for the full rationale.
// Defensive: on a database that hasn't run the `vertical_id` migration yet,
// this returns an empty map rather than throwing (same probe the original
// inline code used).
export function getCrossPlatformSuppressors(
  db: any,
  cooldownDays: number,
): Map<string, CrossPlatformSuppressor> {
  const cutoff = new Date(Date.now() - cooldownDays * 86400 * 1000).toISOString();
  const crossPlatformSuppressors = new Map<string, CrossPlatformSuppressor>();

  if (outreachSentLogHasVerticalColumn(db)) {
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
      const prev = crossPlatformSuppressors.get(r.email);
      if (!prev || r.last_sent_at > prev.last_sent_at) {
        crossPlatformSuppressors.set(r.email, { vertical: r.vertical_id, last_sent_at: r.last_sent_at });
      }
    }
  }
  return crossPlatformSuppressors;
}

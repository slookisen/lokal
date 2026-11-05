// ─── agents.order_notifications_opt_in — the one owner write path ────────────
// dev-request 2026-09-16-handleliste slice 4 introduced the owner toggle
// «Motta bestillinger på e-post» (POST /api/agents/:id/order-notifications);
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2a registers the same
// column as the `orders.enabled` owner feature (owner-features/registry.ts
// storage adapter). Both write through here so there is one UPDATE for the
// owner side. The column stays the source of truth; isEligibleForRealOrder()
// (cart-service.ts) reads it unchanged.

/** Read the column. null = no such agent. */
export function readOrderNotificationsOptIn(db: any, agentId: string): boolean | null {
  const row = db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(agentId) as
    | { v: number | null }
    | undefined;
  if (!row) return null;
  return row.v === 1;
}

/**
 * dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2e: the confirmed order
 * address (agents.order_notification_email) as the `orders.email` owner
 * feature reads it. null = no override (orders go to the profile e-mail) or
 * no such agent. Written only by the S1b punkt 7 confirmation flow.
 */
export function readOrderNotificationEmailOverride(db: any, agentId: string): string | null {
  const row = db.prepare("SELECT order_notification_email AS v FROM agents WHERE id = ?").get(agentId) as
    | { v: string | null }
    | undefined;
  const v = (row?.v ?? "").trim();
  return v ? v : null;
}

/** Write the column. Returns false when no agent row was updated. */
export function writeOrderNotificationsOptIn(db: any, agentId: string, optIn: boolean): boolean {
  const info = db
    .prepare("UPDATE agents SET order_notifications_opt_in = ? WHERE id = ?")
    .run(optIn ? 1 : 0, agentId);
  return info.changes > 0;
}

/**
 * dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2b (review note N1 from
 * S2a): the old «Bestillinger» card / POST order-notifications routes write
 * the column through here, so a real change also gets its
 * owner_feature_audit row for `orders.enabled` (vertical 'rfb') in the same
 * transaction — the same row PUT /api/owner/:id/features/orders.enabled
 * writes. A write that does not change the value writes no audit row; the
 * column UPDATE itself is unchanged. Returns false when no agent row exists.
 */
export function writeOrderNotificationsOptInWithAudit(
  db: any,
  agentId: string,
  optIn: boolean,
  actor: { actor: "owner" | "admin" | "cs" | "system"; detail?: string | null },
): boolean {
  return db.transaction((): boolean => {
    const before = readOrderNotificationsOptIn(db, agentId);
    if (!writeOrderNotificationsOptIn(db, agentId, optIn)) return false;
    if (before !== null && before !== optIn) {
      db.prepare(
        `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at)
         VALUES ('rfb', ?, 'orders.enabled', ?, ?, ?, ?, ?)`,
      ).run(agentId, JSON.stringify(before), JSON.stringify(optIn), actor.actor, actor.detail ?? null, new Date().toISOString());
    }
    return true;
  })();
}

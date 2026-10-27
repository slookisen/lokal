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

/** Write the column. Returns false when no agent row was updated. */
export function writeOrderNotificationsOptIn(db: any, agentId: string, optIn: boolean): boolean {
  const info = db
    .prepare("UPDATE agents SET order_notifications_opt_in = ? WHERE id = ?")
    .run(optIn ? 1 : 0, agentId);
  return info.changes > 0;
}

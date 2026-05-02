// ─── Platform Trigger Contract ──────────────────────────────────
//
// What lands in `platform_triggers` when an external event fires our
// webhook, an internal cron emits a signal, or Daniel manually kicks
// something. Read by scheduled-agents that subscribe to specific
// event_types via GET /admin/triggers/pending?event_type=...
//
// See ARCHITECTURE.md §3.3 for design rationale.

/**
 * Allowed event types — whitelist on the way in. Add new ones as
 * subscriptions ship. Unknown types are rejected with 400.
 */
export const ALLOWED_EVENT_TYPES = [
  // Inbound from Google
  "gmail.received",
  "gmail.thread.replied",
  // Inbound from GitHub
  "deploy.completed",
  "deploy.failed",
  "issue.opened",
  // Inbound from Resend
  "email.bounced",
  "email.complaint",
  // Internal
  "agent.run.completed",
  "agent.run.failed",
  // Operator
  "manual.run",
  "manual.test",
] as const;

export type EventType = (typeof ALLOWED_EVENT_TYPES)[number];

export interface TriggerRecord {
  trigger_id: string;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  source: string;
  signature_verified: boolean;
  received_at: string;
  consumed_at?: string;
  consumed_by?: string;
  result?: string;
}

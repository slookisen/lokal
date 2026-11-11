// registration-confirmation.ts — S1 of the registration-confirmation
// dev-request (2026-11-10).
//
// After a successful public POST /api/marketplace/register (the 201 path
// only), the producer gets ONE short confirmation mail: we have the
// registration and look over the profile within two working days; replies go
// to customer service. The wording lives in registration-confirmation-texts.ts.
//
// Rules:
//   - Behind REGISTRATION_CONFIRMATION_EMAIL_ENABLED, active only when it is
//     exactly "true". Unset/anything else = off = nothing happens: no DB read,
//     no DB write, no send, no timer.
//   - At most one mail per address per 24 h. The address is normalized
//     (trim + lowercase) and the last send time is kept in
//     registration_confirmation_email_log (database/init.ts), so the limit
//     survives a restart. A send is recorded only once it SUCCEEDED (a failed
//     or dry-run send leaves no row, so the next registration may try again).
//     Two registrations for the same address that race inside one process are
//     held back by an in-flight set; across processes the race window is the
//     duration of one send (accepted: one extra mail at worst).
//   - Fire-and-forget: scheduleRegistrationConfirmation() is called after the
//     201 response has been written, defers its work to the next turn of the
//     event loop, and catches every error. It never touches `agents` (so
//     is_vetted and every other visibility field are unchanged).
//   - Logs never carry the address (maskEmails).

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { emailService, maskEmails } from "./email-service";

export const REGISTRATION_CONFIRMATION_FLAG = "REGISTRATION_CONFIRMATION_EMAIL_ENABLED";
export const REGISTRATION_CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isRegistrationConfirmationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REGISTRATION_CONFIRMATION_FLAG] === "true";
}

/** trim + lowercase; the key of the 24 h limit. */
export function normalizeRegistrationEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export type RegistrationConfirmationSkipReason =
  | "disabled"
  | "no_email"
  | "recently_sent"
  | "in_flight"
  | "dry_run"
  | "send_failed"
  | "error";

export type RegistrationConfirmationOutcome =
  | { sent: true }
  | { sent: false; reason: RegistrationConfirmationSkipReason };

export interface RegistrationConfirmationInput {
  email: unknown;
  name: string;
  agentId?: string;
}

export interface RegistrationConfirmationDeps {
  db?: () => Database.Database;
  send?: (email: string, name: string) => Promise<{ success: boolean; messageId?: string; error?: string }>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

// Addresses with a send under way in this process.
const inFlight = new Set<string>();
// Scheduled sends not yet settled (drained by tests).
const pending = new Set<Promise<void>>();

function log(msg: string): void {
  console.log(`[registration-confirmation] ${maskEmails(msg)}`);
}

/**
 * Sends the confirmation when the flag is on, there is an address, and the
 * address has not had one in the last 24 h. Never throws.
 */
export async function sendRegistrationConfirmationIfDue(
  input: RegistrationConfirmationInput,
  deps: RegistrationConfirmationDeps = {},
): Promise<RegistrationConfirmationOutcome> {
  if (!isRegistrationConfirmationEnabled(deps.env)) return { sent: false, reason: "disabled" };

  const key = normalizeRegistrationEmail(input.email);
  if (!key || !key.includes("@")) return { sent: false, reason: "no_email" };
  if (inFlight.has(key)) return { sent: false, reason: "in_flight" };

  inFlight.add(key);
  try {
    const db = (deps.db ?? getDb)();
    const now = (deps.now ?? (() => new Date()))();

    const row = db
      .prepare("SELECT last_sent_at FROM registration_confirmation_email_log WHERE email_normalized = ?")
      .get(key) as { last_sent_at: string } | undefined;
    if (row) {
      const last = Date.parse(row.last_sent_at);
      if (Number.isFinite(last) && now.getTime() - last < REGISTRATION_CONFIRMATION_WINDOW_MS) {
        return { sent: false, reason: "recently_sent" };
      }
    }

    const send = deps.send ?? ((to: string, name: string) => emailService.sendRegistrationConfirmation(to, name));
    const result = await send(String(input.email).trim(), input.name);
    if (!result.success) {
      log(`send failed: ${result.error ?? "unknown error"}`);
      return { sent: false, reason: "send_failed" };
    }
    if (result.messageId === "DRY_RUN") {
      // Nothing left the building, so nothing to rate-limit.
      return { sent: false, reason: "dry_run" };
    }

    const sentAt = (deps.now ?? (() => new Date()))().toISOString();
    db.prepare(
      `INSERT INTO registration_confirmation_email_log (email_normalized, last_sent_at, last_agent_id, send_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(email_normalized) DO UPDATE SET
         last_sent_at = excluded.last_sent_at,
         last_agent_id = excluded.last_agent_id,
         send_count = registration_confirmation_email_log.send_count + 1`,
    ).run(key, sentAt, input.agentId ?? null);
    return { sent: true };
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: "error" };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Fire-and-forget entry point for POST /register, called right after the 201
 * response. Flag off → returns at once and does nothing. Never throws.
 */
export function scheduleRegistrationConfirmation(
  input: RegistrationConfirmationInput,
  deps: RegistrationConfirmationDeps = {},
): void {
  try {
    if (!isRegistrationConfirmationEnabled(deps.env)) return;
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => sendRegistrationConfirmationIfDue(input, deps))
      .then(
        () => undefined,
        (err) => log(`error: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        pending.delete(p);
      });
    pending.add(p);
  } catch (err) {
    try {
      log(`schedule error: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* never let logging break the route */
    }
  }
}

/** Test-only: wait for every scheduled confirmation to settle. */
export async function __drainRegistrationConfirmationsForTesting(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

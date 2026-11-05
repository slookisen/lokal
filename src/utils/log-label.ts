/**
 * Non-reversible log labels for secrets and personal identifiers.
 *
 * Log lines must never carry a login/magic-link/session/confirm token in
 * clear text (anyone who can read the Fly logs could replay it), nor an
 * owner's e-mail address. These helpers return a short SHA-256 hex prefix
 * instead: enough to correlate log lines for the same token/address while
 * debugging, never enough to recover or replay the value.
 *
 * Moved here from src/services/order-activation-link.ts (dev-request
 * "eierportal bølge 0", slice T1) so owner-portal and other routes can share
 * it; order-activation-link re-exports tokenLogLabel unchanged.
 */
import crypto from "crypto";

const LABEL_HEX_CHARS = 10;

function sha256Prefix(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, LABEL_HEX_CHARS);
}

/** Short, non-reversible label for logs (never the token itself). */
export function tokenLogLabel(token: unknown): string {
  if (typeof token !== "string" || !token) return "none";
  return sha256Prefix(token);
}

/**
 * Short, non-reversible label for an e-mail address in logs. Hashes the
 * trimmed, lower-cased address so the same mailbox always gets the same
 * label regardless of the casing the user typed.
 */
export function emailLogLabel(email: unknown): string {
  if (typeof email !== "string" || !email.trim()) return "none";
  return `email#${sha256Prefix(email.trim().toLowerCase())}`;
}

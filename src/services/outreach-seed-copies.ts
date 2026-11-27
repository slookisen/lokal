/**
 * Seed copies ("kontrollkopier") of the two outreach jobs.
 *
 * dev-request 2026-11-26-innsyn-i-levering-dmarc-leveringsstatus-og-kontrollkopier,
 * spec point 3 (AK3/AK4). After a send run of the Opplevagent gårdssalg outreach or
 * the RFB outreach has really sent at least one e-mail, ONE copy of that run's first
 * real e-mail goes to each address in the server secret OUTREACH_SEED_RECIPIENTS
 * (comma-separated). The copy is built by the same code path as the real mail, so
 * From, Reply-To, subject, body and headers are the same; only `To` differs (and the
 * recipient-specific List-Unsubscribe token, which is signed for the seed address
 * itself, so a click can only ever suppress that seed address — never a producer).
 *
 * Isolation: a copy is a bare transport send. It never touches the send logs, the
 * RFB ledger, CRM (contacts/threads/messages/outbox), the daily caps, quarantine,
 * cooldown/max-touch or measurement. The run only records how many copies went out.
 *
 * Privacy: seed addresses are never logged, returned or written anywhere; only counts.
 * No secret (or no valid address in it) → no copies, and the run is unchanged.
 */

export const OUTREACH_SEED_RECIPIENTS_ENV = "OUTREACH_SEED_RECIPIENTS";

// Deliberately simple: one @, no whitespace/separators, a dot in the domain.
const SEED_ADDRESS_RE = /^[^\s@<>,;"'()]+@[^\s@<>,;"'()]+\.[^\s@<>,;"'()]+$/;

/** Parse a comma-separated address list: trim, lowercase, drop invalid, dedupe (first-occurrence order). */
export function parseOutreachSeedRecipients(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const addr = part.trim().toLowerCase();
    if (!addr || !SEED_ADDRESS_RE.test(addr)) continue;
    if (!out.includes(addr)) out.push(addr);
  }
  return out;
}

/** The seed addresses configured right now (read from process.env at call time). */
export function resolveOutreachSeedRecipients(): string[] {
  return parseOutreachSeedRecipients(process.env[OUTREACH_SEED_RECIPIENTS_ENV]);
}

export interface OutreachSeedCopyResult {
  /** Copies the transport accepted. */
  sent: number;
  /** Copies that failed or threw (never fatal to the run). */
  failed: number;
}

/**
 * Send one copy to each seed address via `sendOne`. Never throws: a failure or a
 * throw is counted, never propagated. Logs counts only.
 */
export async function sendOutreachSeedCopies(
  lane: string,
  recipients: ReadonlyArray<string>,
  sendOne: (to: string) => Promise<{ success: boolean }>,
): Promise<OutreachSeedCopyResult> {
  const result: OutreachSeedCopyResult = { sent: 0, failed: 0 };
  for (const to of recipients) {
    try {
      const r = await sendOne(to);
      if (r && r.success) result.sent += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  console.log(`[outreach-seed-copies] lane=${lane} seed_copies_sent=${result.sent} seed_copies_failed=${result.failed}`);
  return result;
}

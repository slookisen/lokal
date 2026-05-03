// ─── Run Envelope — Platform Contract v1 ────────────────────────
//
// Every scheduled-agent run (marketing, customer-service, enrichment,
// discovery, supervisor, verifier, …) ends with one of these objects.
//
// The platform-verifier reads `claims` and runs reality probes per
// claim (e.g., "is commit X actually live on prod?"). The orchestrator
// reads `next_suggested` to decide what to spawn next. Daniel reads
// the morning rollup that summarises status across all envelopes.
//
// This file is the single source of truth for the contract. If you
// change a shape here, every agent that emits an envelope must be
// updated, and the runs table migration must be revised.
//
// See ARCHITECTURE.md §3.2 for design rationale.

/**
 * What kind of thing is being claimed?
 *
 * - `commit` — a git commit hash that should be live somewhere
 * - `emails_sent` — a count of outbound emails sent via Resend / SMTP
 * - `db_state_change` — a count of rows inserted/updated/deleted
 * - `file_deployed` — a file (e.g. server.json, llms.txt) that should be live
 * - `http_endpoint` — an endpoint that should respond with a specific shape
 * - `external_api_call` — a third-party API call we expect to have succeeded
 * - `custom` — anything else; verifier falls back to the value in `meta.probe`
 */
export type ClaimType =
  | "commit"
  | "emails_sent"
  | "db_state_change"
  | "file_deployed"
  | "http_endpoint"
  | "external_api_call"
  | "custom";

export interface Claim {
  /** What kind of thing the agent claims to have done. */
  type: ClaimType;
  /** The primary value of the claim (e.g. commit SHA, email count, URL). */
  value: string | number | boolean;
  /** Free-form context the verifier may need to actually probe this claim. */
  meta?: Record<string, unknown>;
}

export interface Evidence {
  /** Index of the claim in `claims[]` this evidence supports. */
  claim_idx: number;
  /** A URL the verifier can fetch (e.g. github.com/.../commit/X). */
  url?: string;
  /** External IDs (e.g. Resend message_ids, Stripe charge_ids). */
  ids?: string[];
  /** Anything else useful for cross-source consistency checks. */
  meta?: Record<string, unknown>;
}

export type TriggerSource = "cron" | "webhook" | "signal" | "manual";

export type RunStatus = "completed" | "failed" | "partial";

export type VerifierState =
  | "pending" // not yet looked at
  | "verified" // every claim matched reality
  | "failed" // at least one claim failed a probe
  | "skipped"; // verifier decided not to probe (e.g. unverifiable claim)

export interface RunEnvelope {
  /** Unique ID for this run — convention: `run-YYYY-MM-DD-<agent>-<seq>-<vertical>`. */
  run_id: string;
  /** Which vertical this run belongs to. `rfb` for now; `tannlege` future. */
  vertical: string;
  /** Which agent emitted this envelope (matches scheduled-agents folder name). */
  agent: string;
  /** What started the run. */
  trigger_source: TriggerSource;
  /** ISO 8601, UTC. */
  started_at: string;
  /** ISO 8601, UTC. May equal started_at for instant runs. */
  finished_at: string;
  /** Outcome from the agent's own perspective (verifier may overrule later). */
  status: RunStatus;
  /** Things the agent claims to have done. Each gets verified. */
  claims: Claim[];
  /** Supporting evidence per claim (URLs, IDs). */
  evidence: Evidence[];
  /** Agent names the agent suggests should run next. Orchestrator decides. */
  next_suggested?: string[];
  /** Errors encountered, even if the run still partially succeeded. */
  errors?: Array<{ message: string; meta?: Record<string, unknown> }>;
  /** Free-form prose summary for the morning rollup (keep <500 chars). */
  notes?: string;
}


/**
 * What gets read back from the run-ledger API. Includes the original
 * `RunEnvelope` an agent emitted PLUS the verifier's view of it. Agents
 * never read this; only the dashboard, the verifier itself (to find what
 * to probe), and the orchestrator (to plan from past results).
 */
export interface RunRecord extends RunEnvelope {
  verifier_state: VerifierState;
  verifier_checked_at?: string;
  verifier_findings?: VerifierFinding[];
}

/**
 * What the platform-verifier writes back to the runs table after probing.
 * Lives in a separate column so the agent's own view (status) and the
 * verifier's view (verifier_state) cannot drift silently.
 */
export interface VerifierFinding {
  /** Index of the claim in `claims[]`. */
  claim_idx: number;
  /** What probe was run. */
  probe_kind: string;
  /** Did the probe match the claim?
   *  Note: when `skipped=true`, `matched=false` is the convention but should
   *  NOT be counted as a failure when rolling up the run's verifier_state. */
  matched: boolean;
  /** Free-form reason — especially useful when matched=false. */
  reason: string;
  /** When the probe ran. */
  probed_at: string;
  /** True when no probe was attempted (e.g. unknown claim.kind, missing endpoint).
   *  Aggregator MUST treat skipped findings as neutral, not as failures.
   *  Phase 2.7b — fixes the "unknown kind = failed run" misclassification. */
  skipped?: boolean;
}

/**
 * Helper for agent code: build an envelope as you go, finish() validates
 * required fields and returns the immutable envelope to write to the ledger.
 */
export class EnvelopeBuilder {
  private envelope: Partial<RunEnvelope> = {
    claims: [],
    evidence: [],
    errors: [],
  };

  constructor(args: {
    run_id: string;
    vertical: string;
    agent: string;
    trigger_source: TriggerSource;
  }) {
    this.envelope.run_id = args.run_id;
    this.envelope.vertical = args.vertical;
    this.envelope.agent = args.agent;
    this.envelope.trigger_source = args.trigger_source;
    this.envelope.started_at = new Date().toISOString();
  }

  claim(c: Claim): this {
    this.envelope.claims!.push(c);
    return this;
  }

  evidence(e: Evidence): this {
    this.envelope.evidence!.push(e);
    return this;
  }

  error(message: string, meta?: Record<string, unknown>): this {
    this.envelope.errors!.push({ message, meta });
    return this;
  }

  suggestNext(...agents: string[]): this {
    this.envelope.next_suggested = [
      ...(this.envelope.next_suggested ?? []),
      ...agents,
    ];
    return this;
  }

  notes(s: string): this {
    this.envelope.notes = s.length > 500 ? s.slice(0, 497) + "..." : s;
    return this;
  }

  finish(status: RunStatus): RunEnvelope {
    this.envelope.finished_at = new Date().toISOString();
    this.envelope.status = status;
    const required: Array<keyof RunEnvelope> = [
      "run_id",
      "vertical",
      "agent",
      "trigger_source",
      "started_at",
      "finished_at",
      "status",
      "claims",
      "evidence",
    ];
    for (const k of required) {
      if (this.envelope[k] === undefined) {
        throw new Error(`RunEnvelope missing required field: ${k}`);
      }
    }
    return this.envelope as RunEnvelope;
  }
}

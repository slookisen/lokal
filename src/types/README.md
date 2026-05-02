# `src/types/` — Platform contracts

Type definitions that span multiple services or live as inter-service
contracts. Anything that's "an envelope between two parts of the system"
goes here, not in a single service's folder.

## Current contracts

### `run-envelope.ts`

Every scheduled-agent run (marketing, customer-service, enrichment,
discovery, verifier, supervisor) emits a `RunEnvelope` at end-of-run.
The platform-verifier reads `claims` and reality-probes each one. The
orchestrator reads `next_suggested` to decide what to spawn next.

**For agent authors:** at the very end of your run, call
`recordRun(envelope)` from `src/services/run-ledger.ts`. Use the
`EnvelopeBuilder` to compose it incrementally. Required fields are
checked at `finish()` — you'll get a clear error if you forgot one.

**Shape contract version:** v1 (2026-05-02). Any breaking change here
must be coordinated with every agent that emits envelopes — see
ARCHITECTURE.md §3.2.

## Why types live here, not next to services

Types that cross service boundaries are platform infrastructure, not
service-internal detail. Putting them next to one service makes that
service look authoritative when it isn't. `src/types/` makes the
shared-ness obvious in the import path.

A type that's only used inside one service stays inside that service's
file (e.g., a private interface in `marketing-service.ts`). The bar for
moving here is "≥2 services or scheduled-agents reference it."

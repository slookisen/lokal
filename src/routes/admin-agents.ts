// ─── Admin: Agents Listing Endpoint (PR-93) ─────────────────────
//
// HTTP surface for browsing agents by status + recent update window:
//   GET /admin/agents
//
// Why this endpoint: the lokal-agent-verifier had been stuck on an
// 8-day SKIPPED-streak because it had no cheap way to ask "which
// agents changed in the last 24h, filtered by status?". The marketplace
// search endpoints are public/geo-shaped and don't expose internal
// status; admin-agent-audit reaches individual rows but not lists.
// This route fills that gap with a single, paginated, admin-gated GET.
//
// Schema note (read the report): the `agents` table does *not* have
// `updated_at` or `status` columns. We map:
//   - query.updated_since → filter on `last_seen_at`   (the only timestamp
//                                                       the table tracks
//                                                       per-write; created_at
//                                                       is immutable)
//   - query.status        → mapped onto (is_active, is_verified):
//        "active"   → is_active=1
//        "inactive" → is_active=0
//        "pending"  → is_active=1 AND is_verified=0
//   - response.status     → derived string mirror of above
//   - response.vertical   → `vertical_id` column (added in Phase 4.6a)
//   - response.updated_at → `last_seen_at`
//
// Auth: X-Admin-Key, mirrors the pattern from admin-runs.ts.

import { Router, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/init";
import {
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
  enrichmentWritePauseBlock,
  enrichmentWritePauseBlockForAgents,
  normalizeEnrichmentVertical,
} from "../services/enrichment-write-pause";
import { slugify } from "../utils/slug";
import {
  verifyOrgNumber,
  fetchBrregActivityDescription,
  findOrgnumberByName,
  normaliseName,
  BRREG_BASE_URL,
  BRREG_SEARCH_PATH,
  fetchBrregBusinessAddress,
  fetchBrregContact,
  type BrregVerifyResult,
  type BrregHit,
  type BrregAddress,
  type BrregContact,
} from "../services/brreg-client";
// POST /brreg-contact-backfill below (dev-request 2026-07-31-rfb-brreg-
// andrekilde-adresse-telefon): a Brreg phone value must clear the SAME
// write-time guard knowledge-service.ts's upsertKnowledge() already applies
// to every other phone write in this codebase (org-nr-as-phone leak class,
// dev-request 2026-07-28) before it may be used anywhere — column write OR
// provenance value.
import { validatePhoneForWrite } from "../services/contact-normalizer";
// Reused, unchanged, from the admin-knowledge factual-field write gate (see
// POST /brreg-description-fallback below): canCorrectFactualField's
// curated-lock refusal is the SAME hard rule every other admin write path
// goes through; mergeFieldProvenance is the SAME field_provenance merge
// every other write path uses.
import { canCorrectFactualField, mergeFieldProvenance } from "./admin-knowledge";
// dev-request rfb-kvalitetsgate-parity: RFB's own port of gårdssalg's
// LLM-judge quality-gate cascade (see judgeRfbAboutCandidate below) reuses
// ONLY the cheap, deterministic, universal prefilter — length/mangled-
// Unicode/boilerplate/Norwegian-language check — never the nav-menu-leakage/
// umbrella-membership regex heuristic layer (meetsAboutQualityBar), which
// stays exactly as-is for its existing caller (admin-knowledge.ts).
import { meetsAboutCheapBar, classifyAboutCheapBar, buildPageEvidence, type PageEvidence } from "../services/search-enrich";
// dev-request 2026-08-15-tynne-profiler-forbedringsloype (Slice 2): the same
// aggregator/directory-host denylist every other RFB write path that trusts
// a "verified" website already reuses (admin-knowledge.ts, admin-rfb-
// website-discovery.ts) — defensive re-check before crawling a website for
// generation source text, never assumed safe just because it cleared the
// (unrelated) website-discovery ownership gate.
import { isDirectoryOrAggregatorHost, hostFromUrlLike } from "../services/cross-source-validator";
// POST /org-nr-backfill below: RFB producer names carry the same "Navn —
// Sted" display suffix convention gårdssalg does — reuse the existing,
// already-tested stripper rather than re-implementing it.
import { parseNameLocationSuffix } from "../services/location-suffix-parser";
// "Billigere kilde først" — check the vendored Lokalmat/Debio extract before
// any Brreg network crawl (see local-orgnr-candidates.ts's own header for
// why this is a checked-in file rather than a runtime cross-repo read).
import { findLocalOrgnrCandidate, type LocalOrgnrHit } from "../services/local-orgnr-candidates";
// dev-request 2026-08-03-mikhailo-quarantine-gates, Gate 3: the
// self-registered-review-approve route below is the ONLY caller in this
// file — see that route for why the ping moved here from routes/marketplace.ts.
import { pingIndexNow } from "../services/indexnow-service";
// dev-request 2026-08-19-kursjustering-drikkefunnel-llm-og-supply, Grep 5b —
// shared LLM-judge + deterministic-backstop contact gate for
// POST /brreg-contact-backfill below (mirrors lokal#655's marketplace.ts
// pattern; see contact-candidate-judge.ts's own doc comment). Distinct from
// this file's own judgeRfbAboutCandidate below, which judges about-text
// quality, not contact-field candidates.
import { gateContactCandidates } from "../services/contact-candidate-judge";
// dev-request 2026-08-24-produsentbeskrivelser-skrapt-js-opprydding: cheap
// deterministic backstop ahead of the tynne-profiler judge call below — see
// the call site's own comment for why this is safe to add here (candidate
// text is LLM-generated, not raw scraped markup, so this is defense-in-depth
// rather than the primary gate for this write path).
import { looksLikeCodeArtifact } from "../services/description-quality";

const router = Router();

// ─── Slice 2 of dev-request 2026-06-30-brreg-verification-gate ─────────
// Wires verifyOrgNumber() (services/brreg-client.ts, Slice 1) into
// POST /admin/agents/register for the "rfb" and "experiences" verticals
// only — "dental" stays Legelisten-primary and is never Brreg-verified
// here (brreg_* columns stay at their DB defaults for dental rows).
//
// Feature flag: BRREG_VERIFY_ON_REGISTER — same `=== "true"` truthy-check
// convention as the sibling BRREG_NACE_DISCOVERY_ENABLED flag in
// scheduled-agents/brreg-nace-discovery.md (which defaults OFF/dry-run
// until Daniel flips it after a verified dry-run). We follow that same
// conservative default here: unset/falsy → skip verification entirely,
// so registration behaves exactly as it did before this slice. This is
// deliberately the rollback lever — Brreg outages or bad NACE data can
// be neutralised instantly by unsetting the env var, with zero code change.
function brregVerifyEnabled(): boolean {
  return process.env.BRREG_VERIFY_ON_REGISTER === "true";
}

// Per-vertical NACE allow-lists — identical to the lists already used by
// scheduled-agents/brreg-nace-discovery.md's own registration step, so a
// candidate that discovery already accepted is not silently rejected here.
const BRREG_NACE_ALLOWLIST: Record<string, readonly string[]> = {
  rfb: [
    "01.410", "01.450", "01.460", "01.490", "01.500",
    "10.110", "10.130", "10.510", "10.710", "11.020",
    "47.220", "47.270",
  ],
  experiences: [
    "93.291", "93.292", "79.121", "79.901", "79.902",
    "96.230", "55.200", "55.300",
  ],
};

// runBrregVerifyForRegister — computes (brreg_verified, brreg_flag,
// brreg_checked_at) for a register-time org-nr check. Never throws — any
// unexpected error (verifyOrgNumber itself already never throws, but we
// wrap defensively anyway: a Brreg outage must never break registration)
// resolves to the "unverified, unchecked" tuple.  brreg_checked_at is only
// stamped once the whole check has completed without error.
// Exported (not just used by /register) so the backlog sweep below
// (GET/POST /admin/agents/brreg-catalog-sweep, Slice 3) reuses the exact
// same classification rules rather than forking a second copy.
export async function runBrregVerifyForRegister(
  verticalId: string,
  orgNr: string,
): Promise<{ brreg_verified: number; brreg_flag: string | null; brreg_checked_at: string | null }> {
  try {
    const result: BrregVerifyResult = await verifyOrgNumber(orgNr);

    if (result.flag === "dissolved" || result.flag === "bankrupt") {
      return { brreg_verified: 0, brreg_flag: result.flag, brreg_checked_at: new Date().toISOString() };
    }
    if (!result.exists) {
      // Per verifyOrgNumber's SAFE_DEFAULT_VERIFY_RESULT contract, both the
      // not-found (404) and network/parse-error paths resolve with
      // flag: "no_orgnr" — we mirror that faithfully rather than assume.
      return { brreg_verified: 0, brreg_flag: "no_orgnr", brreg_checked_at: new Date().toISOString() };
    }
    if (result.active && result.flag === null) {
      const allowList = BRREG_NACE_ALLOWLIST[verticalId] ?? [];
      const overlap = result.nace.some((code) => allowList.includes(code));
      return {
        brreg_verified: overlap ? 1 : 0,
        brreg_flag: overlap ? null : "wrong_nace",
        brreg_checked_at: new Date().toISOString(),
      };
    }
    // Exists, not flagged dissolved/bankrupt, but not (active && flag===null)
    // either — e.g. underAvvikling/underTvangsavviklingEllerTvangsopplosning
    // with no slettedato/konkurs. Not explicitly specced; treated as
    // inconclusive rather than invented into one of the named flags.
    return { brreg_verified: 0, brreg_flag: null, brreg_checked_at: new Date().toISOString() };
  } catch (err) {
    console.warn(
      "[admin-agents] brreg verify failed unexpectedly (registration proceeds regardless):",
      err instanceof Error ? err.message : err,
    );
    return { brreg_verified: 0, brreg_flag: null, brreg_checked_at: null };
  }
}

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// dev-request 2026-08-03-mikhailo-quarantine-gates, Gate 3: this file has no
// existing absolute-URL builder (its routes return relative ids/counts, not
// URLs) — mirrors routes/marketplace.ts's own getBaseUrl() exactly (same
// BASE_URL env fallback, same req.protocol/req.get("host") shape) rather
// than hardcoding a host, so a non-prod BASE_URL (staging, tests) is
// respected the same way it is on the registration path.
function getAdminBaseUrl(req: Request): string {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

// Minimal shape check — POST /register's only use is to reject obvious
// garbage before it lands in agents.contact_email / agent_knowledge.email.
// Not a deliverability check; the caller's own evidence gate (e.g.
// lokal-agent-discovery Step 3's domain-match rule) is what decides
// whether an email is trustworthy in the first place.
function isValidEmailFormat(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ─── GET /admin/agents ────────────────────────────────────────
// List agents filtered by status + updated_since, paginated.
//
// Query params:
//   status         active | inactive | pending  (optional, default: all)
//   updated_since  ISO timestamp                 (optional, default: 24h ago)
//   limit          1..500                        (optional, default 50)
//   offset         >=0                           (optional, default 0)
//
// Response:
//   { success: true, count: <total before pagination>,
//     agents: [{ id, name, updated_at, status, vertical, umbrella_type }] }
//   umbrella_type (2026-07-26, dev-request umbrella-floor-chronic-regression-investigation):
//   diagnostic-only passthrough of the existing agents.umbrella_type column (string, e.g.
//   "venue", or null for ordinary non-umbrella agents) — lets callers identify which
//   inactive rows are umbrella agents without a new endpoint.
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── Parse + validate query params ─────────────────────────
  const rawStatus = (req.query.status as string) || "";
  const status = rawStatus.toLowerCase();
  if (status && !["active", "inactive", "pending"].includes(status)) {
    res.status(400).json({
      error: "invalid status",
      detail: "status must be one of: active, inactive, pending",
    });
    return;
  }

  // updated_since: default = 24h ago. Accept ISO 8601.
  let updatedSince = (req.query.updated_since as string) || "";
  if (!updatedSince) {
    updatedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } else {
    const parsed = Date.parse(updatedSince);
    if (Number.isNaN(parsed)) {
      res.status(400).json({
        error: "invalid updated_since",
        detail: "must be an ISO 8601 timestamp",
      });
      return;
    }
    // Normalise to ISO so SQLite's lexicographic compare works correctly
    // against the `datetime('now')`-style stamps the table uses.
    updatedSince = new Date(parsed).toISOString();
  }

  // limit: default 50, max 500
  let limit = 50;
  if (req.query.limit !== undefined) {
    const n = parseInt(req.query.limit as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      res.status(400).json({ error: "invalid limit", detail: "limit must be >= 1" });
      return;
    }
    limit = Math.min(n, 500);
  }

  // offset: default 0
  let offset = 0;
  if (req.query.offset !== undefined) {
    const n = parseInt(req.query.offset as string, 10);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "invalid offset", detail: "offset must be >= 0" });
      return;
    }
    offset = n;
  }

  // ── Build WHERE clause ────────────────────────────────────
  // Parameterised — never concatenate user input into SQL.
  const where: string[] = ["last_seen_at >= ?"];
  const params: (string | number)[] = [updatedSince];

  if (status === "active") {
    where.push("is_active = 1");
  } else if (status === "inactive") {
    where.push("is_active = 0");
  } else if (status === "pending") {
    // "pending" = active but not yet verified. This matches the verifier's
    // mental model: rows it still needs to look at.
    where.push("is_active = 1");
    where.push("is_verified = 0");
  }

  const whereSql = where.join(" AND ");

  try {
    const db = getDb();

    // Total count BEFORE pagination — required for the verifier to
    // know whether to paginate further.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${whereSql}`)
      .get(...params) as { n: number };
    const total = countRow?.n ?? 0;

    const rows = db
      .prepare(
        `SELECT id, name, last_seen_at, is_active, is_verified, vertical_id, umbrella_type
         FROM agents
         WHERE ${whereSql}
         ORDER BY last_seen_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
        id: string;
        name: string;
        last_seen_at: string;
        is_active: number;
        is_verified: number;
        vertical_id: string | null;
        umbrella_type: string | null;
      }>;

    const agents = rows.map((r) => ({
      id: r.id,
      name: r.name,
      updated_at: r.last_seen_at,
      status:
        r.is_active === 0
          ? "inactive"
          : r.is_verified === 0
            ? "pending"
            : "active",
      vertical: r.vertical_id ?? "rfb",
      umbrella_type: r.umbrella_type ?? null,
    }));

    res.json({ success: true, count: total, agents });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

// ─── POST /admin/agents/register ─────────────────────────────
// Register a net-new agent. Originally built for the brreg NACE discovery
// agent; extended (dev-request 2026-07-28-discovery-registrering-mangler-
// kontaktfelt-endepunkt) to also serve lokal-agent-discovery, whose
// candidates are not always Norwegian companies (no org_nr) and whose
// contact-evidence work (Step 3's strict HIGH-confidence gate) needs an
// actual write path for email/phone + provenance instead of being
// discarded at registration.
//
// Auth: X-Admin-Key header (same requireAdmin as above) — this IS the trust
// boundary for contact-field writes: only admin-keyed internal callers can
// reach this route, and each caller is responsible for its own evidence
// gate (e.g. lokal-agent-discovery's Step 3) before it ever sends
// email/phone here. This route's job is purely to persist what it's given
// — it does not re-derive or second-guess confidence.
//
// Dedup logic (in order):
//   1. org_nr tag match  → { success: false, duplicate: true, existing_id }
//      (skipped when org_nr is absent — nothing to match on)
//   2. name+city match   → { success: false, duplicate: true, existing_id }
//   3. Insert new agent with trust_score 0.3 (lower than owner-claimed 0.5)
//
// Columns: only those confirmed present in agents table are written.
//   vertical_id  → confirmed via ALTER TABLE (Phase 4.6a)
//   data_source  → on agent_knowledge, NOT agents — excluded
//   auto_sources → on agent_knowledge, NOT agents — excluded
//
// org_nr / source: OPTIONAL (loosened 2026-07-29 — see dev-request above).
// No in-repo caller of this route requires them mandatory (all callers are
// external cron-driven SKILL agents hitting this over HTTP); brreg-nace-
// discovery's own usage is untouched since it always sends both anyway.
//
// email / phone: OPTIONAL. When given, persisted to agent_knowledge.email /
// .phone plus field_provenance (this codebase's established per-write-path
// provenance convention — see mergeFieldProvenance below), source_type
// taken from the request's own `source` field (falls back to
// "agent_registration" when source is absent). `email` (a real, evidence-
// backed contact — distinct from the A2A-protocol-required placeholder)
// ALSO becomes agents.contact_email when given, replacing the
// "kontakt@rettfrabonden.com" placeholder that column otherwise gets.
router.post("/register", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
  // pause-mekanisk-gjerde) ───────────────────────────────────────────────────
  // This is the surface that registered 5 producers in violation on
  // 2026-08-20 while an RFB pause was live. The gate runs FIRST — before the
  // required-field validation below, before dedup, before the INSERT — and
  // fails CLOSED. A net-new agent has no row to read a vertical off, so the
  // vertical is taken from the one the request is registering under,
  // defaulting to 'rfb' exactly as `agents.vertical_id` itself does; an
  // unrecognised value also collapses to 'rfb' rather than escaping the gate
  // (the strict rejection of a bogus vertical_id still happens below, at 400).
  {
    // `getDb` (the thunk), not `getDb()` — evaluating it as an ARGUMENT put a
    // getDb() throw OUTSIDE the guard's try, so it surfaced as a bare 500 and
    // the fail_closed:true signal was lost (the write still never happened).
    // Passing the thunk moves that failure back inside the fence. PR review
    // finding 3, 2026-08-20.
    const pauseBlock = enrichmentWritePauseBlock(
      getDb,
      normalizeEnrichmentVertical((req.body as { vertical_id?: unknown } | undefined)?.vertical_id),
    );
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  // ── Validate required fields ───────────────────────────────
  const {
    name,
    url,
    city,
    vertical_id,
    org_nr,
    source,
    nace_code,
    categories,
    tags: extraTags,
    phone,
    email,
    description,
    lat,
    lng,
  } = req.body as {
    name?: string;
    url?: string;
    city?: string;
    vertical_id?: string;
    org_nr?: string;
    source?: string;
    nace_code?: string;
    categories?: string[];
    tags?: string[];
    phone?: string;
    email?: string;
    description?: string;
    lat?: number;
    lng?: number;
  };

  if (!name || !url || !city || !vertical_id) {
    res.status(400).json({
      error: "Missing required fields",
      detail: "name, url, city, vertical_id are all required",
    });
    return;
  }

  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (trimmedEmail && !isValidEmailFormat(trimmedEmail)) {
    res.status(400).json({
      error: "Invalid email",
      detail: "email must be a valid email address",
    });
    return;
  }
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";

  // dev-request 2026-08-24-produsentbeskrivelser-skrapt-js-opprydding
  // (round-3 repo-wide re-search finding): this INSERT below writes a
  // caller-supplied `description` straight into `agents.description` — the
  // same defect class the rest of this dev-request gates, and this
  // registration surface is literally the one the enrichment-write-pause
  // gate right above already treats as part of the same automated
  // agent-driven write family ("registered 5 producers in violation on
  // 2026-08-20"). An empty/omitted description falls through to a safe
  // generated fallback string below and is never checked here — only a
  // caller-supplied, non-empty value is.
  if (typeof description === "string" && description.trim() && looksLikeCodeArtifact(description)) {
    res.status(400).json({
      error: "description contains code/script artifacts — rejected",
      detail: "description contains code/script artifacts — rejected",
    });
    return;
  }

  const VALID_VERTICALS = ["rfb", "dental", "experiences"] as const;
  if (!VALID_VERTICALS.includes(vertical_id as typeof VALID_VERTICALS[number])) {
    res.status(400).json({
      error: "Invalid vertical_id",
      detail: "vertical_id must be one of: rfb, dental, experiences",
    });
    return;
  }

  try {
    const db = getDb();

    // ── Dedup 1: org_nr tag match ────────────────────────────
    // Tags are stored as a JSON array. We search for the literal
    // string "org_nr:<value>" inside the TEXT column. Skipped entirely
    // when org_nr is absent (non-Norwegian-verifiable candidates) — there
    // is nothing to match on, and dedup 2 (name+city) still applies.
    if (org_nr) {
      const orgNrTag = `org_nr:${org_nr}`;
      const byOrgNr = db
        .prepare(
          `SELECT id FROM agents WHERE tags LIKE ? LIMIT 1`
        )
        .get(`%"${orgNrTag}"%`) as { id: string } | undefined;

      if (byOrgNr) {
        res.json({
          success: false,
          duplicate: true,
          existing_id: byOrgNr.id,
          message: "Agent with this org_nr already exists",
        });
        return;
      }
    }

    // ── Dedup 2: name + city match (case-insensitive) ────────
    const byNameCity = db
      .prepare(
        `SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND LOWER(city) = LOWER(?) LIMIT 1`
      )
      .get(name, city) as { id: string } | undefined;

    if (byNameCity) {
      res.json({
        success: false,
        duplicate: true,
        existing_id: byNameCity.id,
        message: "Agent with this name+city already exists",
      });
      return;
    }

    // ── Build tags array ─────────────────────────────────────
    // org_nr / source are now optional (see header comment) — only tag
    // whichever of the two was actually supplied.
    const builtTags: string[] = [];
    if (org_nr) builtTags.push(`org_nr:${org_nr}`);
    if (source) builtTags.push(`source:${source}`);
    if (nace_code) builtTags.push(`nace:${nace_code}`);
    if (extraTags && Array.isArray(extraTags)) builtTags.push(...extraTags);

    // ── Slice 2 of dev-request 2026-06-30-brreg-verification-gate ────
    // rfb + experiences only — dental stays Legelisten-primary, brreg_*
    // columns stay at their DB defaults (0 / null / null) for dental and
    // for any registration where the flag is off. Never blocks the
    // registration itself, regardless of outcome.
    let brreg_verified = 0;
    let brreg_flag: string | null = null;
    let brreg_checked_at: string | null = null;

    if (
      brregVerifyEnabled() &&
      (vertical_id === "rfb" || vertical_id === "experiences") &&
      org_nr
    ) {
      const verifyOutcome = await runBrregVerifyForRegister(vertical_id, org_nr);
      brreg_verified = verifyOutcome.brreg_verified;
      brreg_flag = verifyOutcome.brreg_flag;
      brreg_checked_at = verifyOutcome.brreg_checked_at;
    }

    // ── Insert ───────────────────────────────────────────────
    // vertical_id is confirmed present (Phase 4.6a ALTER TABLE).
    // data_source + auto_sources live on agent_knowledge, not agents — excluded.
    const id = require("crypto").randomUUID();
    const api_key = `brreg_${require("crypto").randomBytes(20).toString("hex")}`;
    const agentDescription =
      (description ?? "").trim() ||
      (source ? `Oppdaget via ${source}` : "Oppdaget via automatisk registrering");

    // contact_email is A2A-protocol-required (NOT NULL) — historically a
    // placeholder, "updated when agent claims profile". When the caller
    // supplies a real, evidence-gated email (see header comment), use it
    // directly instead of the placeholder; agent_knowledge.email +
    // field_provenance carry the same value below, with provenance.
    const contactEmailValue = trimmedEmail || "kontakt@rettfrabonden.com";

    db.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url,
        role, api_key,
        city, lat, lng,
        categories, tags,
        trust_score, is_active, is_verified,
        vertical_id,
        org_nr, brreg_verified, brreg_flag, brreg_checked_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        'producer', ?,
        ?, ?, ?,
        ?, ?,
        0.3, 1, 0,
        ?,
        ?, ?, ?, ?
      )`
    ).run(
      id,
      name,
      agentDescription,
      name,                           // provider = business name
      contactEmailValue,
      url,
      api_key,
      city,
      lat ?? null,
      lng ?? null,
      JSON.stringify(categories && Array.isArray(categories) ? categories : []),
      JSON.stringify(builtTags),
      vertical_id,
      org_nr ?? null,
      brreg_verified,
      brreg_flag,
      brreg_checked_at,
    );

    // ── Contact-field enrichment: agent_knowledge.email/.phone + provenance ──
    // Only runs when at least one of email/phone was actually supplied —
    // registrations with no contact info at all (the common case for a
    // strict-evidence discovery agent) never touch agent_knowledge and never
    // fail because of it. Mirrors the "ensure a knowledge row exists" idiom
    // used elsewhere in this file (see POST /brreg-description-fallback
    // above, ~line 1052 pre-edit) via INSERT OR IGNORE + UPDATE, and reuses
    // mergeFieldProvenance — the SAME field_provenance merge every other
    // admin write path in this codebase uses — rather than hand-rolling a
    // new shape.
    if (trimmedEmail || trimmedPhone) {
      const nowIso = new Date().toISOString();
      // source_type: prefer the caller's own `source` (e.g.
      // "lokal-agent-discovery"); fall back to a generic label when absent
      // so a provenance record is never written with an empty source_type.
      const sourceType = source && source.trim() ? source.trim() : "agent_registration";

      db.prepare(
        `INSERT OR IGNORE INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)`
      ).run(id, nowIso);

      const existsRow = db
        .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
        .get(id) as { field_provenance?: string | null } | undefined;
      let existingProv: Record<string, unknown> = {};
      if (existsRow?.field_provenance) {
        try {
          const parsed = JSON.parse(existsRow.field_provenance);
          if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
        } catch {
          /* tolerate junk, mirrors other call sites */
        }
      }

      const incoming: Record<string, Array<{ value: string; source_type: string; fetched_at: string }>> = {};
      if (trimmedEmail) incoming.email = [{ value: trimmedEmail, source_type: sourceType, fetched_at: nowIso }];
      if (trimmedPhone) incoming.phone = [{ value: trimmedPhone, source_type: sourceType, fetched_at: nowIso }];
      const mergedProv = mergeFieldProvenance(existingProv, incoming);

      db.prepare(
        `UPDATE agent_knowledge SET email = ?, phone = ?, field_provenance = ?, updated_at = ? WHERE agent_id = ?`
      ).run(trimmedEmail || null, trimmedPhone || null, JSON.stringify(mergedProv), nowIso, id);
    }

    res.status(201).json({
      success: true,
      agent_id: id,
      slug: slugify(name),
      contact_email: contactEmailValue,
      message: "Agent registered",
    });
  } catch (err: any) {
    res.status(500).json({ error: "Registration failed", detail: err.message });
  }
});

// ─── DELETE /admin/agents/:id ─────────────────────────────────
// Rollback/undo path for a bad POST /register call (wrong org-nr match,
// data error, etc.) — no way to delete/deactivate a mis-registered agent
// existed before this route. Scoped, by an explicit guard (not just a
// comment), to a brand-new registration with zero history: before the
// actual DELETE, we check for any related rows in the four tables that
// signal "this agent has real history" and refuse (409) if any are found.
// This intentionally does NOT check agent_metrics, magic_links,
// outreach_sent_log, agent_affiliations, products, agent_salgskanal, or
// the changelog table — those cascade harmlessly and aren't the meaningful
// "has history" signal; see reviewer note / PR report.
//
// Why this matters: `agents` is referenced by ON DELETE CASCADE from
// agent_knowledge/listings/agent_claims (and others) — a bare DELETE would
// silently and irreversibly wipe those for ANY agent, not just a fresh one.
// Worse, conversations.seller_agent_id has NO ON DELETE clause (defaults
// NO ACTION), so deleting an agent that has ever been a conversation
// seller previously threw a raw SQLite FK-constraint error, surfaced as an
// unhelpful 500 — now caught upfront and reported as a clear 409 instead.
const AGENT_HISTORY_CHECKS: ReadonlyArray<{ table: string; sql: string }> = [
  { table: "agent_knowledge", sql: `SELECT 1 FROM agent_knowledge WHERE agent_id = ? LIMIT 1` },
  { table: "listings", sql: `SELECT 1 FROM listings WHERE agent_id = ? LIMIT 1` },
  { table: "agent_claims", sql: `SELECT 1 FROM agent_claims WHERE agent_id = ? LIMIT 1` },
  { table: "conversations", sql: `SELECT 1 FROM conversations WHERE seller_agent_id = ? LIMIT 1` },
];

router.delete("/:id", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;

  // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
  // pause-mekanisk-gjerde; PR review round 2) ────────────────────────────────
  // Sibling of DELETE /api/marketplace/agents/:id, gated for the same reason:
  // it runs a bare `DELETE FROM agents` below rather than going through an
  // already-gated primitive. Narrower than that sibling — the history guard
  // refuses any agent with agent_knowledge/listings/agent_claims/conversations
  // rows, so only a brand-new agent can be deleted here — but "narrower" is not
  // "impossible", and a delete while the fleet is known to be misidentifying
  // agents is exactly what this fence is for. Runs before the row is read, so a
  // rejection touches nothing; `getDb` as a thunk ⇒ fails CLOSED.
  {
    const pauseBlock = enrichmentWritePauseBlockForAgents(getDb, [typeof id === "string" ? id : ""]);
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  try {
    const db = getDb();

    const existing = db
      .prepare(`SELECT name, org_nr FROM agents WHERE id = ?`)
      .get(id) as { name: string; org_nr: string | null } | undefined;

    if (!existing) {
      res.status(404).json({ error: "Agent not found", agent_id: id });
      return;
    }

    // ── History guard ────────────────────────────────────────
    // Only a brand-new, no-history agent may be deleted here. Any match
    // in any of the four tables below → refuse with 409, listing every
    // matching category (not just the first one found).
    const blocking: string[] = [];
    for (const check of AGENT_HISTORY_CHECKS) {
      const hit = db.prepare(check.sql).get(id);
      if (hit) blocking.push(check.table);
    }

    if (blocking.length > 0) {
      res.status(409).json({
        error: "Agent has existing history, refusing delete",
        agent_id: id,
        blocking,
      });
      return;
    }

    db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);

    res.json({
      success: true,
      deleted_id: id,
      deleted_name: existing.name ?? null,
      deleted_org_nr: existing.org_nr ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Delete failed", detail: err.message });
  }
});

// ─── GET/POST /admin/agents/brreg-catalog-sweep (Slice 3 of dev-request ──────
//     2026-06-30-brreg-verification-gate) ──────────────────────────────────
//
// WHY: BRREG_VERIFY_ON_REGISTER (Slice 2, above) is unset in prod today, so
// almost no pre-existing `agents` row has `brreg_verified=1` yet even where
// registration-time wiring would have caught something. This is the one-time
// backfill sweep for that backlog — mirrors GET/POST /admin/description-
// truncation-sweep's dry-run-by-default convention (routes/admin-knowledge.ts)
// closely: read-only GET diagnostic, POST with a STRICT-FALSE dry_run parse,
// real writes scoped to exactly the columns this feature owns.
//
// Candidate set: agents rows with a non-null/non-empty org_nr that have
// NEVER been checked (brreg_checked_at IS NULL) — rows already checked
// (by registration-time wiring or a prior sweep run) are excluded, so
// re-running this sweep is naturally idempotent without a separate
// staleness/re-check window (out of scope for this slice, see dev-request).
//
// Vertical scoping judgment call: `agents` DOES carry a per-row vertical_id
// column (Phase 4.6a — see GET / above, `vertical: r.vertical_id ?? "rfb"`),
// so we use it rather than inventing a new signal or hardcoding "rfb" for
// every row. But we mirror POST /register's own gating (above) exactly:
// only "rfb" and "experiences" rows are ever verified — "dental" stays
// Legelisten-primary and is intentionally excluded from the candidate set,
// same as it's excluded from the registration-time verify call. A NULL
// vertical_id defaults to "rfb", matching the GET / listing endpoint's
// existing convention.
//
// Classification is NOT re-derived here — every row's outcome comes from
// runBrregVerifyForRegister() (exported above), the exact same function
// POST /register already uses, so a sweep-verified row and a
// registration-verified row are always classified identically.
//
// Hard batch cap: a single GET/POST call only ever scans/verifies up to
// BRREG_SWEEP_BATCH_CAP rows (oldest-registered-first, by created_at then
// id for a deterministic order), and reports remaining_count so a caller
// knows there's more backlog left — this endpoint NEVER walks the full
// backlog synchronously in one request (see the table-sizes / tasks-prune
// event-loop-blocking incidents this repo has already hit once).
//
// Writes: ONLY `UPDATE agents SET brreg_verified=?, brreg_flag=?,
// brreg_checked_at=? WHERE id=?`, one row at a time, for rows in the capped
// batch on a real (dry_run:false) run. NEVER DELETE, NEVER touches
// is_active or any other column — dissolved/bankrupt agents are only ever
// flagged, exactly like Slice 2. No filesystem writes; the `flagged_for_review`
// bucket is returned in the response only (a later slice's concern, not this
// one's, per the dev-request).
const BRREG_SWEEP_BATCH_CAP = 50;

// Only these two verticals are ever Brreg-verified (mirrors POST /register's
// own gating above) — "dental" rows are excluded from the candidate set
// entirely, never scanned/verified by this sweep.
const BRREG_SWEEP_ELIGIBLE_VERTICALS = ["rfb", "experiences"] as const;

// Outcomes that belong in the "review list" the dev-request asks for.
// "no_orgnr" and the inconclusive null case are deliberately NOT review-list
// material — they're either "nothing to check" or "not a named flag".
const BRREG_SWEEP_REVIEW_FLAGS = new Set(["dissolved", "bankrupt", "wrong_nace"]);

interface BrregSweepCandidateRow {
  id: string;
  name: string;
  org_nr: string;
  vertical_id: string | null;
}

interface BrregSweepRowResult {
  id: string;
  name: string;
  org_nr: string;
  vertical: string;
  brreg_verified: number;
  brreg_flag: string | null;
}

// Shared WHERE clause for both the count and the capped batch query, so the
// two can never drift out of sync with each other.
function brregSweepCandidateWhereSql(): string {
  return `org_nr IS NOT NULL AND TRIM(org_nr) != '' AND brreg_checked_at IS NULL
    AND COALESCE(vertical_id, 'rfb') IN ('${BRREG_SWEEP_ELIGIBLE_VERTICALS.join("','")}')`;
}

function countBrregSweepCandidates(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${brregSweepCandidateWhereSql()}`)
    .get() as { n: number };
  return row?.n ?? 0;
}

// Deterministic, oldest-registered-first ordering (created_at, then id as a
// tiebreaker) — a hard LIMIT means only up to BRREG_SWEEP_BATCH_CAP rows are
// ever scanned/verified per invocation; the rest of the backlog is reported
// via remaining_count, never processed synchronously in the same request.
function fetchBrregSweepBatch(db: ReturnType<typeof getDb>, cap: number): BrregSweepCandidateRow[] {
  return db
    .prepare(
      `SELECT id, name, org_nr, vertical_id FROM agents
       WHERE ${brregSweepCandidateWhereSql()}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(cap) as BrregSweepCandidateRow[];
}

// Computes (never writes) what runBrregVerifyForRegister would set for a
// candidate row — reused identically by the GET diagnostic and the POST
// dry-run preview, so both always agree.
async function computeBrregSweepRowResult(row: BrregSweepCandidateRow): Promise<BrregSweepRowResult> {
  const vertical = row.vertical_id ?? "rfb";
  const outcome = await runBrregVerifyForRegister(vertical, row.org_nr);
  return {
    id: row.id,
    name: row.name,
    org_nr: row.org_nr,
    vertical,
    brreg_verified: outcome.brreg_verified,
    brreg_flag: outcome.brreg_flag,
  };
}

// Atomically claims-and-writes a single candidate row's Brreg outcome.
//
// WHY this exists (race fix): runBrregVerifyForRegister() above is awaited
// — it's a real network call to the Brreg API — so any amount of time can
// pass between "we last knew this row was unchecked" and "we're ready to
// write its outcome". A SELECT-then-UPDATE re-check done BEFORE that await
// (or even done after the await but as two separate statements) still
// leaves a window: two concurrent callers (a second sweep run, or
// registration-time wiring) can both observe brreg_checked_at IS NULL,
// both make their own Brreg fetch for the same org_nr, and both believe
// they "won" the write.
//
// The fix folds the re-check into the UPDATE's WHERE clause so the claim
// and the write are a single atomic SQLite statement: only a caller whose
// UPDATE actually matched a still-NULL row gets `changes === 1`. A second
// caller racing against the first is guaranteed `changes === 0` once the
// first caller's UPDATE has committed — there is no read-then-write gap
// left to race.
export function applyBrregSweepRowUpdate(
  db: ReturnType<typeof getDb>,
  id: string,
  outcome: { brreg_verified: number; brreg_flag: string | null; brreg_checked_at: string | null },
): boolean {
  const result = db
    .prepare(
      "UPDATE agents SET brreg_verified = ?, brreg_flag = ?, brreg_checked_at = ? WHERE id = ? AND brreg_checked_at IS NULL",
    )
    .run(outcome.brreg_verified, outcome.brreg_flag, outcome.brreg_checked_at, id);
  return result.changes === 1;
}

function toFlaggedForReview(
  r: BrregSweepRowResult,
): { id: string; name: string; org_nr: string; brreg_flag: string } | null {
  if (r.brreg_flag && BRREG_SWEEP_REVIEW_FLAGS.has(r.brreg_flag)) {
    return { id: r.id, name: r.name, org_nr: r.org_nr, brreg_flag: r.brreg_flag };
  }
  return null;
}

router.get("/brreg-catalog-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const candidateCount = countBrregSweepCandidates(db);
    const batchRows = fetchBrregSweepBatch(db, BRREG_SWEEP_BATCH_CAP);

    const results: BrregSweepRowResult[] = [];
    for (const row of batchRows) {
      results.push(await computeBrregSweepRowResult(row));
    }
    const flaggedForReview = results
      .map(toFlaggedForReview)
      .filter((x): x is NonNullable<typeof x> => x !== null);

    res.json({
      success: true,
      dry_run: true,
      candidate_count: candidateCount,
      batch_size: results.length,
      remaining_count: Math.max(0, candidateCount - results.length),
      rows: results,
      flagged_for_review: flaggedForReview,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Sweep diagnostic failed", detail: err.message });
  }
});

router.post("/brreg-catalog-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // STRICT-FALSE parse — identical convention to POST /admin/
  // description-truncation-sweep: null / "false" / 0 / "" / undefined all
  // mean dry-run; only the literal JSON boolean `false` triggers real writes.
  const body = (req.body ?? {}) as { dry_run?: unknown };
  const dryRun = body.dry_run !== false;

  try {
    const db = getDb();
    const candidateCount = countBrregSweepCandidates(db);
    const batchRows = fetchBrregSweepBatch(db, BRREG_SWEEP_BATCH_CAP);

    if (dryRun) {
      const results: BrregSweepRowResult[] = [];
      for (const row of batchRows) {
        results.push(await computeBrregSweepRowResult(row));
      }
      const flaggedForReview = results
        .map(toFlaggedForReview)
        .filter((x): x is NonNullable<typeof x> => x !== null);

      res.json({
        success: true,
        dry_run: true,
        candidate_count: candidateCount,
        batch_size: results.length,
        remaining_count: Math.max(0, candidateCount - results.length),
        would_update_count: results.length,
        would_update: results,
        flagged_for_review: flaggedForReview,
      });
      return;
    }

    // Real run — write ONLY the three brreg_* columns for each row, and
    // ONLY if the row is still unclaimed (brreg_checked_at IS NULL) at
    // write time. The claim check and the write are a single atomic
    // conditional UPDATE (see applyBrregSweepRowUpdate above) — NOT a
    // separate pre-write SELECT — so a row that got checked by something
    // else (registration-time wiring or a concurrent sweep run) since the
    // scan above can never be clobbered, even though runBrregVerifyForRegister
    // below is an awaited network call.
    const updated: Array<{
      id: string; name: string; org_nr: string; vertical: string;
      brreg_verified: number; brreg_flag: string | null; brreg_checked_at: string | null;
    }> = [];
    const flaggedForReview: Array<{ id: string; name: string; org_nr: string; brreg_flag: string }> = [];
    const skippedAlreadyCheckedIds: string[] = [];

    for (const row of batchRows) {
      const vertical = row.vertical_id ?? "rfb";
      const outcome = await runBrregVerifyForRegister(vertical, row.org_nr);
      const wrote = applyBrregSweepRowUpdate(db, row.id, outcome);
      if (!wrote) {
        skippedAlreadyCheckedIds.push(row.id);
        continue;
      }
      updated.push({
        id: row.id,
        name: row.name,
        org_nr: row.org_nr,
        vertical,
        brreg_verified: outcome.brreg_verified,
        brreg_flag: outcome.brreg_flag,
        brreg_checked_at: outcome.brreg_checked_at,
      });
      if (outcome.brreg_flag && BRREG_SWEEP_REVIEW_FLAGS.has(outcome.brreg_flag)) {
        flaggedForReview.push({ id: row.id, name: row.name, org_nr: row.org_nr, brreg_flag: outcome.brreg_flag });
      }
    }

    res.json({
      success: true,
      dry_run: false,
      candidate_count: candidateCount,
      batch_size: batchRows.length,
      remaining_count: Math.max(0, candidateCount - batchRows.length),
      updated_count: updated.length,
      updated,
      skipped_already_checked_count: skippedAlreadyCheckedIds.length,
      skipped_already_checked_ids: skippedAlreadyCheckedIds,
      flagged_for_review: flaggedForReview,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Sweep failed", detail: err.message });
  }
});

// ─── POST /admin/agents/brreg-description-fallback (dev-request ─────────────
//     2026-06-30-open-stuck-verification-bucket) ─────────────────────────────
//
// WHY: ~800 agents are stuck failing verification; the `http_unreachable`
// bucket (~17% of failures) is agents whose homepage fetch failed during
// enrichment, so they never got a real `agents.description`. This endpoint
// falls back to Brreg's own registered NACE activity-description text
// (naeringskode{1,2,3}.beskrivelse, via fetchBrregActivityDescription() —
// services/brreg-client.ts) as the description when the homepage crawl
// failed. Brreg is already a trusted source elsewhere in this codebase
// (brreg-verification-gate, brreg-nace-discovery).
//
// Candidate set: agents rows with a non-null/non-empty org_nr AND a
// genuinely EMPTY description (TRIM(description) = '' — agents.description
// is NOT NULL, so "empty" always means empty-string here, never SQL NULL),
// AND not curated-locked for the `description` field (agent_knowledge.
// curated_fields). No boilerplate-detection heuristic here — that's a
// separate, already-built concern (description-quality.ts / isJunkDescription()
// per the dev-request's own non-goals) — this endpoint only ever targets
// TRUE-empty descriptions.
//
// dry_run (default) / apply=1&limit=N — SAME conventions as the sibling
// POST /admin/homepage-content-refresh (routes/admin-knowledge.ts): apply
// truthy (body.apply or ?apply=1/"true") turns dry-run off; limit defaults
// to 25, hard-capped at 100. A dry-run call still performs the Brreg fetch
// per candidate (a genuine preview of the text that WOULD be written, not a
// guess) but issues zero DB writes.
//
// Write path: gated through the EXISTING canCorrectFactualField() (admin-
// knowledge.ts) — same curated-lock hard refusal every other admin write
// path goes through, called with isPureAdd:true (see that function's own
// doc comment) since this endpoint's candidate set is BY CONSTRUCTION always
// a pure ADD (an already-non-empty description is never a candidate, so
// this never overwrites). Provenance is recorded via the existing
// mergeFieldProvenance() with a new source_type: "brreg_fallback" (no schema
// change — provenance rides the existing field_provenance JSON column,
// exactly like every other content-field source_type).
//
// Race-safety: the actual write is an atomic conditional
// `UPDATE agents SET description = ? WHERE id = ? AND TRIM(description) = ''`
// inside a per-row transaction that ALSO re-checks curated_fields
// immediately before writing — mirrors applyBrregSweepRowUpdate's atomic-
// claim pattern above and description-truncation-sweep's re-check-before-
// write convention (admin-knowledge.ts). A row locked or filled by anything
// else between the scan and the write is left alone; re-running apply is
// idempotent (a previously-filled agent is never re-selected — the SQL
// WHERE clause excludes it — and never re-written even if somehow re-
// selected, thanks to the atomic WHERE on the UPDATE itself).
const BRREG_DESCRIPTION_FALLBACK_DEFAULT_LIMIT = 25;
const BRREG_DESCRIPTION_FALLBACK_MAX_LIMIT = 100;
const BRREG_DESCRIPTION_FALLBACK_CONCURRENCY = 3;

interface BrregDescriptionFallbackCandidateRow {
  agent_id: string;
  name: string;
  org_nr: string;
  curated_fields: string | null;
}

// True iff the parsed curated_fields JSON locks the `description` field.
// Tolerates malformed/missing JSON (treated as "not locked"), matching the
// defensive-parse convention used throughout admin-knowledge.ts.
function isDescriptionCurated(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    return !!(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).description);
  } catch {
    return false;
  }
}

// Shared WHERE clause for both the count and the capped batch query (SQL
// pre-filter on curated_fields via NOT LIKE — same pragmatic convention
// POST /admin/homepage-content-refresh uses for field_provenance detection
// above; isDescriptionCurated() re-checked per-row, and again immediately
// before each write, is the authoritative check).
function brregDescriptionFallbackCandidateSql(): string {
  return `
    SELECT a.id AS agent_id, a.name AS name, a.org_nr AS org_nr,
           k.curated_fields AS curated_fields
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.org_nr IS NOT NULL AND TRIM(a.org_nr) != ''
       AND TRIM(a.description) = ''
       AND (
             k.curated_fields IS NULL
          OR k.curated_fields = '{}'
          OR k.curated_fields NOT LIKE '%"description"%'
           )
  `;
}

function countBrregDescriptionFallbackCandidates(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM (${brregDescriptionFallbackCandidateSql()})`)
    .get() as { n: number };
  return row?.n ?? 0;
}

function fetchBrregDescriptionFallbackBatch(
  db: ReturnType<typeof getDb>,
  cap: number,
): BrregDescriptionFallbackCandidateRow[] {
  return db
    .prepare(`${brregDescriptionFallbackCandidateSql()} ORDER BY a.created_at ASC, a.id ASC LIMIT ?`)
    .all(cap) as BrregDescriptionFallbackCandidateRow[];
}

router.post("/brreg-description-fallback", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown; limit?: unknown };
  // apply: dry-run by default. apply=1 / "1" / true (body) or ?apply=1 —
  // identical convention to POST /admin/homepage-content-refresh.
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  // limit: default 25, hard cap 100 — same as homepage-content-refresh.
  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : BRREG_DESCRIPTION_FALLBACK_DEFAULT_LIMIT,
    BRREG_DESCRIPTION_FALLBACK_MAX_LIMIT,
  );

  try {
    const db = getDb();
    const candidateCount = countBrregDescriptionFallbackCandidates(db);
    const batchRows = fetchBrregDescriptionFallbackBatch(db, limit);
    const nowIso = new Date().toISOString();

    if (dryRun) {
      const wouldWrite: Array<{ agent_id: string; name: string; org_nr: string; description_preview: string }> = [];
      const skipped: Array<{ agent_id: string; reason: string }> = [];

      async function previewOne(row: BrregDescriptionFallbackCandidateRow): Promise<void> {
        if (isDescriptionCurated(row.curated_fields)) {
          skipped.push({ agent_id: row.agent_id, reason: "curated_locked" });
          return;
        }
        const text = await fetchBrregActivityDescription(row.org_nr);
        if (!text) {
          skipped.push({ agent_id: row.agent_id, reason: "no_brreg_description" });
          return;
        }
        wouldWrite.push({ agent_id: row.agent_id, name: row.name, org_nr: row.org_nr, description_preview: text });
      }

      for (let i = 0; i < batchRows.length; i += BRREG_DESCRIPTION_FALLBACK_CONCURRENCY) {
        const slice = batchRows.slice(i, i + BRREG_DESCRIPTION_FALLBACK_CONCURRENCY);
        await Promise.all(slice.map((r) => previewOne(r)));
      }

      res.json({
        success: true,
        dry_run: true,
        candidate_count: candidateCount,
        batch_size: batchRows.length,
        remaining_count: Math.max(0, candidateCount - batchRows.length),
        would_write_count: wouldWrite.length,
        would_write: wouldWrite,
        skipped,
      });
      return;
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    const written: Array<{ agent_id: string; name: string; org_nr: string; description: string }> = [];
    const skipped: Array<{ agent_id: string; reason: string }> = [];
    const errors: Array<{ agent_id: string; error: string }> = [];

    async function applyOne(row: BrregDescriptionFallbackCandidateRow): Promise<void> {
      let text: string | null;
      try {
        text = await fetchBrregActivityDescription(row.org_nr);
      } catch (e: any) {
        errors.push({ agent_id: row.agent_id, error: e?.message ?? String(e) });
        return;
      }
      if (!text) {
        skipped.push({ agent_id: row.agent_id, reason: "no_brreg_description" });
        return;
      }

      const sourceUrl = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(row.org_nr)}`;

      try {
        const tx = db.transaction((): { ok: boolean; reason?: string } => {
          // Re-check curated lock + current description value RIGHT BEFORE
          // writing — a row locked or filled by anything else since the scan
          // above must never be clobbered (mirrors applyBrregSweepRowUpdate's
          // atomic-claim pattern and description-truncation-sweep's
          // re-check-before-write convention, both in this repo already).
          const cur = db
            .prepare(
              `SELECT a.description AS description, k.curated_fields AS curated_fields
                 FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
                WHERE a.id = ?`,
            )
            .get(row.agent_id) as { description: string; curated_fields: string | null } | undefined;
          if (!cur) return { ok: false, reason: "agent_not_found" };
          if (isDescriptionCurated(cur.curated_fields)) return { ok: false, reason: "curated_locked" };
          if (cur.description && cur.description.trim() !== "") {
            return { ok: false, reason: "already_has_description" };
          }

          // Ensure an agent_knowledge row exists (auto-created agents may lack one).
          const existsRow = db
            .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
            .get(row.agent_id) as { field_provenance?: string | null } | undefined;
          let existingProv: Record<string, unknown> = {};
          if (existsRow === undefined) {
            db.prepare(
              "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)",
            ).run(row.agent_id, nowIso);
          } else if (existsRow.field_provenance) {
            try {
              const parsed = JSON.parse(existsRow.field_provenance);
              if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
            } catch {
              /* tolerate junk, mirrors other call sites */
            }
          }

          // Same gate every other admin write path goes through. isPureAdd:true
          // because this call site's candidate set is, by construction, always
          // a genuinely empty column — never an overwrite (see header comment).
          const decision = canCorrectFactualField({
            field: "description",
            existingFieldProvenance: existingProv["description"],
            websiteOwnershipUnverified: false,
            incomingFieldProvenance: [
              { source_type: "brreg_fallback", value: text as string, fetched_at: nowIso, source_url: sourceUrl },
            ],
            isCurated: false, // already checked (and returned early) above
            isPureAdd: true,
          });
          if (!decision.allowed) return { ok: false, reason: decision.reason };

          const mergedProv = mergeFieldProvenance(existingProv, {
            description: {
              sources: [{ source_type: "brreg_fallback", value: text as string, fetched_at: nowIso, source_url: sourceUrl }],
            },
          });

          const upd = db
            .prepare("UPDATE agents SET description = ? WHERE id = ? AND TRIM(description) = ''")
            .run(text, row.agent_id);
          if (upd.changes !== 1) return { ok: false, reason: "already_has_description" };

          db.prepare("UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?").run(
            JSON.stringify(mergedProv),
            nowIso,
            row.agent_id,
          );
          return { ok: true };
        });

        const result = tx();
        if (result.ok) {
          written.push({ agent_id: row.agent_id, name: row.name, org_nr: row.org_nr, description: text });
        } else {
          skipped.push({ agent_id: row.agent_id, reason: result.reason ?? "unknown" });
        }
      } catch (e: any) {
        errors.push({ agent_id: row.agent_id, error: e?.message ?? String(e) });
      }
    }

    for (let i = 0; i < batchRows.length; i += BRREG_DESCRIPTION_FALLBACK_CONCURRENCY) {
      const slice = batchRows.slice(i, i + BRREG_DESCRIPTION_FALLBACK_CONCURRENCY);
      await Promise.all(slice.map((r) => applyOne(r)));
    }

    res.json({
      success: true,
      dry_run: false,
      candidate_count: candidateCount,
      batch_size: batchRows.length,
      remaining_count: Math.max(0, candidateCount - batchRows.length),
      written_count: written.length,
      written,
      skipped,
      errors,
    });
  } catch (err: any) {
    res.status(500).json({ error: "brreg-description-fallback failed", detail: err.message });
  }
});

// ─── POST/GET /admin/agents/org-nr-backfill + org-nr-review-queue + ─────────
//     org-nr-review-approve (dev-request 2026-07-26-rfb-outreach-tilsig- ────
//     blokkerdiagnose-og-orgnr, Steg 2) ────────────────────────────────────
//
// Steg 1 (blocker-diagnose, lokal#381) measured the 959-agent RFB
// pending_verify/review_required cohort: 454/959 lack 2+ corroborating
// address sources, 568/959 lack 2+ phone sources (GATING_FIELDS,
// cross-source-validator.ts). org_nr unlocks a DIRECT Brreg-by-orgnr lookup
// (fetchBrregBusinessAddress/fetchBrregContact, brreg-client.ts) as a second
// corroborating source for both — but almost no RFB agent has org_nr set
// yet (GET /brreg-catalog-sweep above reports candidate_count: 1, a
// synthetic test row). This is the acquisition step that fills it.
//
// Ported from the already-reviewed gårdssalg org_nr-backfill
// (POST /admin/gardssalg-orgnr-backfill, routes/opplevelser.ts, dev-request
// 2026-07-18-gardssalg-profilkvalitet-foer-outreach slice 5b) — SAME
// candidate generator (Brreg name-search, confidence >= 0.9 only) and SAME
// write-bar veto chain, adapted to this table's own field names and lock
// signal:
//
//   experience_providers.navn            -> agents.name
//   experience_providers.postnummer      -> agent_knowledge.postal_code
//   experience_providers.poststed        -> agents.city
//   content_source IN ('manual','claim') -> agents.claimed_at IS NOT NULL
//     (the owner-claimed-this-listing lock signal this codebase already
//     uses to exclude agents from other automated write pipelines — see
//     `a.claimed_at IS NULL` in admin-search-enrich.ts / search-enrich-
//     sweep.ts's own candidate-selection WHERE clauses)
//   gardssalgSearchName() "— Sted" strip -> parseNameLocationSuffix()'s
//     core_name (services/location-suffix-parser.ts) — RFB producer names
//     carry the SAME "Navn — Sted" display convention (see route-intent.ts's
//     doc comment and marketplace.ts:2727's existing em/en-dash strip), and
//     this helper is already tested against exactly that convention, so it
//     is reused rather than re-implemented.
//   gardssalg_content_audit / _orgnr_review_queue -> agents_org_nr_audit /
//     agents_org_nr_review_queue (src/database/init.ts, same shape, FK'd to
//     agents(id) instead of experience_providers(id))
//
// NEW relative to the gårdssalg original — "billigere kilde først": before
// any Brreg network call, findLocalOrgnrCandidate() (services/local-orgnr-
// candidates.ts) checks a vendored extract of two already-scraped discovery
// files (Lokalmat.no, Debio) for a same-or-better-confidence match. A local
// hit runs through the EXACT SAME veto chain as a Brreg hit below —
// including the live verifyOrgNumber() liveness check — since the vendored
// data is a snapshot (2026-05-14) and a business it names dissolved since
// must still never claim a row.
//
// Vertical/role scoping mirrors brregSweepCandidateWhereSql()'s own
// COALESCE(vertical_id,'rfb') convention above, plus role='producer' (org_nr
// identifies a business, not a consumer/logistics/quality/price-intel
// agent) and umbrella_type IS NULL (mirrors admin-outreach-pool.ts's own
// non-umbrella scoping for this exact cohort) and is_active = 1.
//
// Batch/limit convention: this file's own brreg-description-fallback route
// (immediately above) is the closest same-file analogue at RFB scale — its
// default 25 / hard cap 100 is reused verbatim here rather than gårdssalg's
// 48-total-cohort cap (959 agents is a very different scale to gårdssalg's
// 74 providers).
//
// Writes ONLY agents.org_nr (+ agent_knowledge.field_provenance under the
// "org_nr" key, mirroring how brreg-description-fallback above already
// stores an agents-table field's provenance in agent_knowledge — the
// established cross-table convention in this file) — never agents.url, never
// any agent_knowledge address/website field. Address/contact enrichment from
// the newly-acquired org_nr is explicitly Steg 3, gated on this slice
// landing first (RFB has no org_nr today; the gårdssalg sister dev-request,
// 2026-07-26-brreg-kontakt-backfill, already built the contact-backfill
// machinery this will reuse once org_nr exists here).

const AGENTS_ORGNR_BACKFILL_DEFAULT_LIMIT = 25;
const AGENTS_ORGNR_BACKFILL_MAX_LIMIT = 100;

// ─── injectable fetch seam for this route's own Brreg calls ────────────
// findOrgnumberByName/verifyOrgNumber (brreg-client.ts) already accept an
// explicit fetchImpl parameter (defaulting to the real global `fetch`), but
// this route was calling them with no third argument — meaning the ONLY way
// to stub Brreg I/O for this route in a test was reassigning
// `globalThis.fetch` itself, which is exactly the anti-pattern already fixed
// once for tests/test.ts's pr-56/pr-76 blocks (commit 8152553,
// "testsuite-determinism-3"): a global monkey-patch installed by one test
// block can silently poison a real fetch() call made by a DIFFERENT,
// concurrently-running block. Mirrors geocoding-service.ts's
// `__setGeocodingFetchForTesting` seam exactly — production code never
// calls the setter, so behavior is unchanged outside tests.
let agentsOrgNrBackfillFetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

export function __setAgentsOrgNrBackfillFetchForTesting(impl?: typeof fetch): void {
  agentsOrgNrBackfillFetchImpl = impl || ((...args: Parameters<typeof fetch>) => fetch(...args));
}

// Marker written into agents_org_nr_audit.source_url by a (future) rollback
// endpoint — mirrors GARDSSALG_ROLLBACK_MARKER (experience-store.ts). No
// endpoint writes this yet in this slice (see the init.ts migration's doc
// comment); the read-side check below exists so the write-bar already
// respects it the moment one is built.
const AGENTS_ORGNR_ROLLBACK_MARKER = "internal://rollback";

interface AgentOrgNrBackfillTargetRow {
  id: string;
  name: string;
  org_nr: string | null;
  claimed_at: string | null;
  postal_code: string | null;
  city: string | null;
}

// Exported (dev-request 2026-08-22-rfb-website-email-selvforsyning) so the
// sibling POST /admin/rfb-brreg-selfsufficiency route
// (admin-rfb-brreg-selfsufficiency.ts) can feed its OWN new candidate
// generators (domain-token-as-name, personal-name-ENK, kommune-pre-filter)
// into this exact shape rather than inventing a parallel one — "export,
// don't duplicate" (the same ground rule rfbWdExistingWebsiteHosts's own
// export comment names, admin-rfb-website-discovery.ts).
export interface AgentOrgNrReviewQueueEntry {
  agent_id: string;
  agent_name?: string | null;
  candidate_orgnr?: string | null;
  candidate_name?: string | null;
  candidate_confidence?: number | null;
  candidate_address?: string | null;
  candidate_source?: string | null;
  reason: string;
  batch_id?: string | null;
}

// Shared WHERE clause for both the count and the capped batch query (mirrors
// brregSweepCandidateWhereSql's "one source of truth for both" convention).
// Exported (2026-08-22-rfb-website-email-selvforsyning) so the sibling
// selvforsyning route's own org_nr-missing cohort selector reuses this EXACT
// predicate instead of drifting from it.
export function agentsOrgNrBackfillCandidateWhereSql(): string {
  return `
    a.role = 'producer'
    AND a.is_active = 1
    AND a.umbrella_type IS NULL
    AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
    AND (a.org_nr IS NULL OR TRIM(a.org_nr) = '')
    AND a.claimed_at IS NULL
  `;
}

function agentsOrgNrBackfillSelectSql(): string {
  return `
    SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.claimed_at AS claimed_at,
           k.postal_code AS postal_code, a.city AS city
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE ${agentsOrgNrBackfillCandidateWhereSql()}
  `;
}

function countAgentsOrgNrBackfillCandidates(db: ReturnType<typeof getDb>): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${agentsOrgNrBackfillSelectSql()})`).get() as { n: number };
  return row?.n ?? 0;
}

function fetchAgentsOrgNrBackfillBatch(db: ReturnType<typeof getDb>, cap: number): AgentOrgNrBackfillTargetRow[] {
  return db
    .prepare(`${agentsOrgNrBackfillSelectSql()} ORDER BY a.created_at ASC, a.id ASC LIMIT ?`)
    .all(cap) as AgentOrgNrBackfillTargetRow[];
}

// Explicit-agentIds override lookup — scoped to role/vertical only (NOT the
// blank-org_nr/claimed/active/umbrella filters), mirroring
// getGardssalgProviderOrgnrTarget's override semantics: an admin can force a
// lookup attempt on any RFB producer agent; eligibility (lock/already-filled)
// is still enforced at write time, just reported as a specific `unresolved`
// reason rather than silently omitted from the target list.
function getAgentOrgNrBackfillTarget(db: ReturnType<typeof getDb>, agentId: string): AgentOrgNrBackfillTargetRow | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.claimed_at AS claimed_at,
              k.postal_code AS postal_code, a.city AS city
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ? AND a.role = 'producer' AND COALESCE(a.vertical_id, 'rfb') = 'rfb'`,
    )
    .get(agentId) as AgentOrgNrBackfillTargetRow | undefined;
  return row ?? null;
}

/**
 * True only when an existing, non-blank postal_code OR city on the agent's
 * own row agrees with the Brreg/local-JSON hit's own postal fields.
 * postal_code is compared exactly; city is compared as an EXACT normalised
 * match against the hit's own poststed field — NOT a substring test against
 * a formatted address string (a short city name like "Nes" or "Os" is a
 * substring of unrelated towns like "Sandnes"/"Oslo" — see
 * gardssalgOrgnrPostalCorroborated's identical doc comment in
 * experience-store.ts, which this mirrors). A same-postal-code-REGION
 * mismatch (different first digit) vetoes outright rather than falling
 * through to the city check. Returns false when the agent has neither
 * field set, or when the hit has no comparable field for the one signal the
 * agent does have — "ved tvil: ikke skriv" (Daniel's binding identitetskrav)
 * means absence of a signal can never pass. Exported for unit tests.
 */
export function agentOrgNrPostalCorroborated(
  target: { postal_code: string | null; city: string | null },
  hit: { brreg_postal?: string | null; brreg_poststed?: string | null },
): boolean {
  const targetPostal = (target.postal_code || "").trim();
  const hitPostal = (hit.brreg_postal || "").trim();
  if (targetPostal && hitPostal && targetPostal === hitPostal) return true;
  if (targetPostal && hitPostal && targetPostal[0] !== hitPostal[0]) return false;

  const targetCity = normaliseName(target.city || "");
  const hitCity = normaliseName(hit.brreg_poststed || "");
  if (targetCity && hitCity && targetCity === hitCity) return true;

  return false;
}

/**
 * True only when the hit's own name-match confidence is the rubric's exact-
 * match tier (1.0) AND agentOrgNrPostalCorroborated agrees. This is the ONLY
 * gate that may ever auto-write an org_nr — anything else must go to the
 * review queue. Exported for unit tests.
 */
export function agentOrgNrAutoWriteEligible(
  target: { postal_code: string | null; city: string | null },
  hit: { confidence: number; brreg_postal?: string | null; brreg_poststed?: string | null },
): boolean {
  return hit.confidence === 1.0 && agentOrgNrPostalCorroborated(target, hit);
}

/**
 * True when this agent's LATEST org_nr audit row is a rollback (an admin
 * deliberately undid an earlier backfill) — see AGENTS_ORGNR_ROLLBACK_MARKER's
 * doc comment above for why this is currently a dormant check. Exported for
 * tests.
 */
export function agentOrgNrWasRolledBack(db: ReturnType<typeof getDb>, agentId: string): boolean {
  const latest = db
    .prepare(
      `SELECT source_url FROM agents_org_nr_audit
        WHERE agent_id = ? AND field_name = 'org_nr'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(agentId) as { source_url: string | null } | undefined;
  return !!latest && latest.source_url === AGENTS_ORGNR_ROLLBACK_MARKER;
}

/**
 * Apply a confirmed org_nr candidate to ONE agent. Fill-only + lock-guard +
 * UNIQUE-conflict discipline mirrors applyGardssalgProviderOrgnr
 * (experience-store.ts) exactly:
 *   - never writes if the agent is owner-claimed (claimed_at IS NOT NULL)
 *   - only writes if the row's own org_nr is currently blank (idempotent)
 *   - agents.org_nr has no DB-level UNIQUE constraint (unlike
 *     experience_providers.org_nr), so this re-checks for a conflicting
 *     row explicitly and skips (returns []) rather than creating a
 *     duplicate org_nr across two different agents
 * Provenance is merged into agent_knowledge.field_provenance under the
 * "org_nr" key via mergeFieldProvenance (admin-knowledge.ts) — the SAME
 * cross-table convention brreg-description-fallback above already uses for
 * an agents-table field's provenance (agent_knowledge row auto-created if
 * missing). Returns the field names actually written (empty array if
 * nothing to write — never throws for an expected refusal).
 */
export function applyAgentOrgNr(
  db: ReturnType<typeof getDb>,
  agentId: string,
  orgNr: string,
  evidenceUrl: string,
  sourceType: string,
  batchId?: string,
): string[] {
  const row = db.prepare(`SELECT id, org_nr, claimed_at FROM agents WHERE id = ?`).get(agentId) as
    | { id: string; org_nr: string | null; claimed_at: string | null }
    | undefined;
  if (!row) return [];
  if (row.claimed_at) return []; // owner-claimed -> locked, mirrors content_source manual/claim

  const cleanOrgNr = (orgNr || "").trim();
  // Norwegian org numbers are exactly 9 digits.
  if (!/^\d{9}$/.test(cleanOrgNr)) return [];
  if (row.org_nr && row.org_nr.trim() !== "") return []; // fill-only

  const conflict = db.prepare(`SELECT id FROM agents WHERE org_nr = ? AND id != ?`).get(cleanOrgNr, agentId) as
    | { id: string }
    | undefined;
  if (conflict) return [];

  const nowIso = new Date().toISOString();

  const applyWithAudit = db.transaction(() => {
    // Fill-only + lock guard repeated INSIDE the UPDATE's WHERE — makes the
    // statement itself unable to clobber a concurrently-set org_nr or a
    // concurrently-arrived owner claim (integration-review discipline
    // mirrored from applyGardssalgProviderOrgnr's own repeated guard).
    const upd = db
      .prepare(
        `UPDATE agents SET org_nr = @org_nr
          WHERE id = @id AND (org_nr IS NULL OR TRIM(org_nr) = '') AND claimed_at IS NULL`,
      )
      .run({ id: agentId, org_nr: cleanOrgNr });
    if (upd.changes === 0) throw new Error("orgnr_filled_concurrently");

    db.prepare(
      `INSERT INTO agents_org_nr_audit
         (id, agent_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @agent_id, 'org_nr', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`,
    ).run({
      id: uuid(),
      agent_id: agentId,
      old_value: row.org_nr ?? null,
      new_value: cleanOrgNr,
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });

    const kRow = db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
      | { field_provenance: string | null }
      | undefined;
    let existingProv: Record<string, unknown> = {};
    if (kRow === undefined) {
      db.prepare(`INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)`).run(
        agentId,
        nowIso,
      );
    } else if (kRow.field_provenance) {
      try {
        const parsed = JSON.parse(kRow.field_provenance);
        if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
      } catch {
        /* malformed existing JSON -> treat as empty rather than clobber the write */
      }
    }

    const mergedProv = mergeFieldProvenance(existingProv, {
      org_nr: { sources: [{ source_type: sourceType, value: cleanOrgNr, fetched_at: nowIso, source_url: evidenceUrl }] },
    });
    db.prepare(`UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?`).run(
      JSON.stringify(mergedProv),
      nowIso,
      agentId,
    );
  });

  try {
    applyWithAudit();
  } catch (e: any) {
    if (String(e?.message) === "orgnr_filled_concurrently") return [];
    throw e;
  }

  return ["org_nr"];
}

// Exported (2026-08-22-rfb-website-email-selvforsyning) — the selvforsyning
// route's new org_nr candidate generators (domain-token, personal-name-ENK)
// must land any non-auto-write outcome in the SAME review queue via the SAME
// upsert idiom, never a second write path.
export function upsertAgentOrgNrReviewQueue(db: ReturnType<typeof getDb>, entry: AgentOrgNrReviewQueueEntry): void {
  db.prepare(
    `INSERT INTO agents_org_nr_review_queue
       (id, agent_id, agent_name, candidate_orgnr, candidate_name, candidate_confidence,
        candidate_address, candidate_source, reason, batch_id, created_at, updated_at)
     VALUES (@id, @agent_id, @agent_name, @candidate_orgnr, @candidate_name, @candidate_confidence,
             @candidate_address, @candidate_source, @reason, @batch_id, datetime('now'), datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       candidate_orgnr = excluded.candidate_orgnr,
       candidate_name = excluded.candidate_name,
       candidate_confidence = excluded.candidate_confidence,
       candidate_address = excluded.candidate_address,
       candidate_source = excluded.candidate_source,
       reason = excluded.reason,
       batch_id = excluded.batch_id,
       updated_at = datetime('now')`,
  ).run({
    id: uuid(),
    agent_id: entry.agent_id,
    agent_name: entry.agent_name ?? null,
    candidate_orgnr: entry.candidate_orgnr ?? null,
    candidate_name: entry.candidate_name ?? null,
    candidate_confidence: entry.candidate_confidence ?? null,
    candidate_address: entry.candidate_address ?? null,
    candidate_source: entry.candidate_source ?? null,
    reason: entry.reason,
    batch_id: entry.batch_id ?? null,
  });
}

// Exported (2026-08-22-rfb-website-email-selvforsyning) — a confirmed
// selvforsyning-route write must clear any stale queue row the same way this
// route's own apply branch already does.
export function clearAgentOrgNrReviewQueueEntry(db: ReturnType<typeof getDb>, agentId: string): void {
  db.prepare(`DELETE FROM agents_org_nr_review_queue WHERE agent_id = ?`).run(agentId);
}

function listAgentOrgNrReviewQueue(
  db: ReturnType<typeof getDb>,
): (AgentOrgNrReviewQueueEntry & { id: string; created_at: string; updated_at: string })[] {
  return db
    .prepare(`SELECT * FROM agents_org_nr_review_queue ORDER BY updated_at DESC`)
    .all() as (AgentOrgNrReviewQueueEntry & { id: string; created_at: string; updated_at: string })[];
}

router.post("/org-nr-backfill", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : AGENTS_ORGNR_BACKFILL_DEFAULT_LIMIT,
    AGENTS_ORGNR_BACKFILL_MAX_LIMIT,
  );

  try {
    const db = getDb();
    const batchId = `agents-orgnr-backfill-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
    const candidateCount = countAgentsOrgNrBackfillCandidates(db);

    let targets: AgentOrgNrBackfillTargetRow[];
    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      const ids = Array.from(
        new Set(
          (body.agentIds as unknown[])
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim()),
        ),
      ).slice(0, limit);
      targets = ids
        .map((id) => getAgentOrgNrBackfillTarget(db, id))
        .filter((t): t is AgentOrgNrBackfillTargetRow => t !== null);
    } else {
      targets = fetchAgentsOrgNrBackfillBatch(db, limit);
    }

    // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
    // pause-mekanisk-gjerde; PR review round 2) ─────────────────────────────
    // The apply path writes `agents.org_nr` (applyAgentOrgNr above) plus its
    // audit row and the org_nr field_provenance. org_nr is PRODUCER CONTENT in
    // exactly the sense website and phone are: a wrong one written to an
    // out-of-scope agent during a pause is the same damage class as the
    // 2026-08-20 incident — and worse to unpick, since the write is fill-only,
    // so the route will never correct itself on a later run.
    //
    // APPLY branch only, mirroring prune-dead-urls / homepage-content-refresh
    // here: the dry run writes no agents row and stays reachable so an operator
    // can still measure. Placed AFTER target selection (so the gate judges the
    // verticals about to be written) and BEFORE the loop — everything above is
    // pure SELECT and the review-queue upserts live inside the loop, so a
    // rejected apply run changes ZERO rows and makes zero Brreg calls.
    // Per-REQUEST; `getDb` as a thunk (finding 3) ⇒ fails CLOSED.
    if (apply) {
      const pauseBlock = enrichmentWritePauseBlockForAgents(
        getDb,
        targets.map((t) => t.id),
      );
      if (pauseBlock) {
        res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
        return;
      }
    }

    let scanned = 0;
    const changed: Array<{ agent_id: string; org_nr: string; source: string; source_url: string }> = [];
    const skippedLocked: string[] = [];
    const unresolved: Array<{ agent_id: string; reason: string }> = [];
    const errors: Array<{ agent_id: string; error: string }> = [];

    for (const t of targets) {
      const agentId = t.id;

      if (t.claimed_at) {
        skippedLocked.push(agentId);
        continue;
      }
      if (t.org_nr && t.org_nr.trim() !== "") {
        // Only reachable via the explicit agentIds override — the auto-
        // selector already filters blank-org_nr rows.
        unresolved.push({ agent_id: agentId, reason: "already_filled" });
        continue;
      }

      // Strip the catalog's "Navn — Sted" display suffix before searching —
      // an exact company-name match must not be demoted to a lower
      // confidence tier by our own display convention. When stripping
      // actually changed the name, the write bar below is tightened.
      const { core_name } = parseNameLocationSuffix(t.name);
      const searchName = core_name || t.name;
      const nameWasStripped = searchName !== (t.name || "").replace(/\s+/g, " ").trim();

      let hit: BrregHit | LocalOrgnrHit | null;
      let sourceType: string;
      try {
        const localHit = findLocalOrgnrCandidate(searchName, t.postal_code);
        if (localHit && localHit.confidence >= 1.0) {
          // A local hit already at the rubric's max tier can never be beaten
          // by a live Brreg name-search (same rubric, same 1.0 ceiling) — so
          // calling Brreg too would be pure network waste. "Cheaper source
          // first" per this file's own header comment.
          hit = localHit;
          sourceType = `local_json_${localHit.local_source}`;
        } else {
          // Local hit is either absent or below the max tier — it must not
          // unconditionally shadow a possibly-better live Brreg match (a
          // sub-1.0 local hit can never itself cause an unsafe auto-write,
          // since agentOrgNrAutoWriteEligible below still requires
          // confidence === 1.0, but it CAN wrongly suppress a genuine Brreg
          // exact match and put a weaker candidate in front of a human
          // reviewer). Take whichever of the two scores higher; a tie keeps
          // the free local hit.
          const brregHit = await findOrgnumberByName(searchName, t.postal_code, agentsOrgNrBackfillFetchImpl);
          if (brregHit && (!localHit || brregHit.confidence > localHit.confidence)) {
            hit = brregHit;
            sourceType = "brreg_name_search";
          } else if (localHit) {
            hit = localHit;
            sourceType = `local_json_${localHit.local_source}`;
          } else {
            hit = null;
            sourceType = "brreg_name_search";
          }
        }
      } catch (e: any) {
        errors.push({ agent_id: agentId, error: e?.message ?? String(e) });
        continue;
      }
      scanned++;

      if (!hit) {
        unresolved.push({ agent_id: agentId, reason: "no_brreg_candidate" });
        upsertAgentOrgNrReviewQueue(db, {
          agent_id: agentId,
          agent_name: t.name,
          candidate_orgnr: null,
          candidate_name: null,
          candidate_confidence: null,
          candidate_address: null,
          candidate_source: null,
          reason: "no_brreg_candidate",
          batch_id: batchId,
        });
        continue;
      }

      // ── Write-bar veto chain — cheapest checks first, every non-auto-write
      // outcome lands in the review queue, never silently dropped.
      let vetoReason: string | null = null;
      if ((hit.exact_ties ?? (hit.confidence === 1.0 ? 1 : 0)) > 1) {
        vetoReason = "ambiguous_exact_name_ties";
      } else if (nameWasStripped && !agentOrgNrPostalCorroborated(t, hit)) {
        vetoReason = "stripped_name_requires_postal_match";
      } else {
        let rolledBack = false;
        try {
          rolledBack = agentOrgNrWasRolledBack(db, agentId);
        } catch {
          rolledBack = false;
        }
        if (rolledBack) vetoReason = "previously_rolled_back";
      }
      if (!vetoReason && agentOrgNrAutoWriteEligible(t, hit)) {
        // Liveness LAST (one extra Brreg call, cached) — ALWAYS against the
        // live Brreg API, even for a local-JSON-sourced hit (the vendored
        // file is a 2026-05-14 snapshot; a business it names may have gone
        // bankrupt/deregistered since).
        try {
          const ver = await verifyOrgNumber(hit.orgnumber, agentsOrgNrBackfillFetchImpl);
          if (!ver.exists || !ver.active) vetoReason = "brreg_not_active";
        } catch {
          vetoReason = "brreg_verify_failed";
        }
      }

      if (vetoReason || !agentOrgNrAutoWriteEligible(t, hit)) {
        const reason = vetoReason ?? "needs_human_review";
        unresolved.push({ agent_id: agentId, reason });
        upsertAgentOrgNrReviewQueue(db, {
          agent_id: agentId,
          agent_name: t.name,
          candidate_orgnr: hit.orgnumber,
          candidate_name: hit.name,
          candidate_confidence: hit.confidence,
          candidate_address: hit.address ?? null,
          candidate_source: sourceType,
          reason,
          batch_id: batchId,
        });
        continue;
      }

      const evidenceUrl =
        sourceType === "brreg_name_search"
          ? `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(hit.orgnumber)}`
          : `local-json://${(hit as LocalOrgnrHit).local_source}/${encodeURIComponent(hit.orgnumber)}`;

      if (dryRun) {
        changed.push({ agent_id: agentId, org_nr: hit.orgnumber, source: sourceType, source_url: evidenceUrl });
      } else {
        try {
          const written = applyAgentOrgNr(db, agentId, hit.orgnumber, evidenceUrl, sourceType, batchId);
          if (written.length > 0) {
            changed.push({ agent_id: agentId, org_nr: hit.orgnumber, source: sourceType, source_url: evidenceUrl });
            // A confirmed, applied write supersedes any stale review-queue
            // entry an earlier run may have left for this agent.
            clearAgentOrgNrReviewQueueEntry(db, agentId);
          } else {
            // Fresh-read-at-write-time found the field already non-blank,
            // the agent now claimed, or another agent already holds this
            // exact org_nr — same race class documented on the gårdssalg
            // original. Bucketed, not silently dropped.
            unresolved.push({ agent_id: agentId, reason: "already_filled_or_conflict_at_write_time" });
          }
        } catch (e: any) {
          errors.push({ agent_id: agentId, error: `write_failed: ${e?.message ?? String(e)}` });
        }
      }
    }

    res.json({
      success: true,
      dry_run: dryRun,
      batch_id: batchId,
      candidate_count: candidateCount,
      batch_size: targets.length,
      remaining_count: Math.max(0, candidateCount - targets.length),
      limit,
      scanned,
      agents_enriched: changed.length,
      changed,
      skipped_locked: skippedLocked,
      unresolved,
      errors,
    });
  } catch (err: any) {
    res.status(500).json({ error: "org-nr-backfill failed", detail: err.message });
  }
});

// ─── GET /admin/agents/org-nr-review-queue ──────────────────────────────────
// Read-only listing of every RFB agent the backfill route above could NOT
// auto-confirm an org_nr for — the durable counterpart to that route's
// per-run `unresolved[]` array. Mirrors GET /admin/gardssalg-orgnr-review-
// queue (routes/opplevelser.ts) exactly.
router.get("/org-nr-review-queue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const entries = listAgentOrgNrReviewQueue(db);
  res.json({ count: entries.length, entries });
});

// ─── POST /admin/agents/org-nr-review-approve ───────────────────────────────
// The review queue's APPLY lever — mirrors POST /admin/gardssalg-orgnr-
// review-approve's strict contract exactly: a human may ONLY approve the
// EXACT (agent_id, org_nr) pair the queue itself carries. The org_nr in the
// request must equal the queue entry's candidate_orgnr, or the item is
// rejected (`mismatch_with_queued_candidate`) — this is a confirmation
// surface, not an arbitrary-write surface. The write still goes through
// applyAgentOrgNr's fill-only/lock/conflict guards and lands in the same
// audit/provenance trail as an auto-write.
//
// Body: { approvals: [{agent_id, org_nr}], apply? } — dry-run by default.
router.post("/org-nr-review-approve", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { approvals?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.approvals) || body.approvals.length === 0) {
    res.status(400).json({ error: "Requires approvals: [{agent_id, org_nr}]" });
    return;
  }

  const db = getDb();
  const queue = listAgentOrgNrReviewQueue(db);
  const byAgent = new Map(queue.map((q) => [q.agent_id, q]));

  const approved: Array<{ agent_id: string; org_nr: string }> = [];
  const rejected: Array<{ agent_id: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const raw of body.approvals as unknown[]) {
    const a = (raw ?? {}) as { agent_id?: unknown; org_nr?: unknown };
    const agentId = typeof a.agent_id === "string" ? a.agent_id.trim() : "";
    const orgNr = typeof a.org_nr === "string" ? a.org_nr.replace(/\s+/g, "") : "";
    if (!agentId || !orgNr) {
      rejected.push({ agent_id: agentId || "<mangler>", reason: "invalid_item" });
      continue;
    }
    if (seen.has(agentId)) {
      rejected.push({ agent_id: agentId, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(agentId);

    const entry = byAgent.get(agentId);
    if (!entry) {
      rejected.push({ agent_id: agentId, reason: "not_in_review_queue" });
      continue;
    }
    if (!entry.candidate_orgnr || entry.candidate_orgnr.trim() !== orgNr) {
      rejected.push({ agent_id: agentId, reason: "mismatch_with_queued_candidate" });
      continue;
    }

    if (dryRun) {
      approved.push({ agent_id: agentId, org_nr: orgNr });
      continue;
    }
    try {
      const source = entry.candidate_source || "brreg_name_search";
      const evidenceUrl =
        source === "brreg_name_search"
          ? `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(orgNr)}`
          : `local-json://${source.replace(/^local_json_/, "")}/${encodeURIComponent(orgNr)}`;
      const written = applyAgentOrgNr(db, agentId, orgNr, evidenceUrl, `human_review_approved:${source}`);
      if (written.length > 0) {
        clearAgentOrgNrReviewQueueEntry(db, agentId);
        approved.push({ agent_id: agentId, org_nr: orgNr });
      } else {
        rejected.push({ agent_id: agentId, reason: "write_refused_filled_locked_or_conflict" });
      }
    } catch (e: any) {
      rejected.push({ agent_id: agentId, reason: `write_failed: ${e?.message ?? String(e)}` });
    }
  }

  res.json({ dry_run: dryRun, approved_count: approved.length, approved, rejected });
});

// ─── GET /admin/agents/self-registered-review-queue + ───────────────────────
//     POST /admin/agents/self-registered-review-approve ─────────────────────
//     (dev-request 2026-08-03-mikhailo-quarantine-gates, Gate 3) ────────────
//
// Companion to org-nr-review-queue/-approve above — same auth-check style
// (requireAdmin), same small-JSON-endpoint convention. This is the human
// release lever for Gate 1/2's quarantine: every agent the PUBLIC
// POST /register route creates lands with origin='self_registered',
// is_vetted=0 (see marketplace-registry.ts's register() and routes/
// marketplace.ts's /register handler) — invisible on every public discovery
// surface (Gate 1: discover()/search/produsent page) and permanently
// withheld the "Verifisert" claim badge even if claimed (Gate 2 — a hard
// gate, no automated evidence escape hatch in this slice, see the comment
// in knowledge-service.ts's verifyClaim()). This pair of routes is how a
// human (Daniel) actually looks at one of these profiles and lets it into
// the real marketplace — admin/script-called JSON endpoints only, no UI.
//
// GET lists the queue, oldest first — the incident this closes (Mikhailo T,
// 2026-07-30) was a same-day drive-by; there's no reason a newer spam
// signup should ever be reviewed ahead of an older, possibly-legitimate one.
router.get("/self-registered-review-queue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const entries = db.prepare(
    `SELECT id, name, contact_email, url, created_at
       FROM agents
      WHERE origin = 'self_registered' AND is_vetted = 0
      ORDER BY created_at ASC`
  ).all();
  res.json({ count: entries.length, entries });
});

// POST flips is_vetted to 1 for exactly one agent, then — and ONLY then —
// pings IndexNow for its /produsent/<slug> page, using the EXACT URL
// convention the old (now-removed) registration-time ping in routes/
// marketplace.ts used. Body: { agentId }.
router.post("/self-registered-review-approve", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentId?: unknown };
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!agentId) {
    res.status(400).json({ error: "Requires { agentId }" });
    return;
  }

  const db = getDb();
  const agent = db.prepare(
    `SELECT id, name, origin, is_vetted FROM agents WHERE id = ?`
  ).get(agentId) as { id: string; name: string; origin: string; is_vetted: number } | undefined;

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  // Confirmation surface, not an arbitrary-write surface — same principle
  // as org-nr-review-approve's exact-candidate check above: this lever may
  // ONLY release an agent that is actually in the self-registered quarantine
  // queue, never any other row.
  if (agent.origin !== "self_registered") {
    res.status(409).json({ error: "not_self_registered", detail: "Only self_registered agents go through this queue" });
    return;
  }
  if (agent.is_vetted === 1) {
    res.json({ success: true, agentId, isVetted: true, alreadyVetted: true });
    return;
  }

  db.prepare(`UPDATE agents SET is_vetted = 1 WHERE id = ?`).run(agentId);

  pingIndexNow([`${getAdminBaseUrl(req)}/produsent/${slugify(agent.name)}`], "rettfrabonden.com");

  res.json({ success: true, agentId, isVetted: true });
});

// ─── POST /admin/agents/brreg-contact-backfill ──────────────────────────────
//     (dev-request 2026-07-31-rfb-brreg-andrekilde-adresse-telefon) ─────────
//
// Why this exists: RFB's outreach pool requires >=2 independent Tier-A/B
// corroborating sources agreeing on `address`/`phone` before an agent is
// pool_eligible (cross-source-validator.ts's GATING_FIELDS gate — NOT
// touched by this slice). 981 RFB agents are blocked on this. The gate is
// correct; what's missing is that nobody writes Brreg's OWN registered
// address/phone as a Tier-B corroborating source for agents that now have
// org_nr (POST /org-nr-backfill above). This ports gårdssalg's own Brreg
// contact backfill (POST /admin/gardssalg-contact-backfill, opplevelser.ts)
// onto the `agents`/`agent_knowledge` tables, reusing fetchBrregBusinessAddress/
// fetchBrregContact (brreg-client.ts) unchanged.
//
// ── THE design point (read before touching this route) ─────────────────────
// cross-source-validator.ts's gate reads MULTIPLE provenance records per
// field out of agent_knowledge.field_provenance[fieldName] (array, merged
// ADDITIVELY by mergeFieldProvenance — admin-knowledge.ts). It does NOT read
// agent_knowledge.address/.phone (each a single, currently-displayed value).
// So this route does TWO independent things per field, and they are NOT the
// same operation:
//   1. Provenance add (the actual point of this slice) — merge a
//      { source_type: "brreg", value, fetched_at, source_url } record into
//      field_provenance WHENEVER a usable Brreg value exists, REGARDLESS of
//      whether the address/phone COLUMN already has a value. Most blocked
//      agents already have exactly 1 source in the column (351 for address,
//      299 for phone, per the dev-request's own measurement) — only adding
//      provenance when the column is blank would accomplish almost nothing.
//   2. Column fill-only write — the DISPLAY column (agent_knowledge.address/
//      .phone) is written ONLY when currently blank/null, mirroring
//      applyAgentOrgNr's fill-only + lock-guard SQL idiom above (re-checked
//      inside the UPDATE's own WHERE, wrapped in db.transaction()). An
//      existing display value is NEVER overwritten with Brreg's value even
//      when they differ.
// mergeFieldProvenance already dedups by `source_type::value`, so calling it
// repeatedly across wakes with the same Brreg value is naturally idempotent.
//
// ── source_type MUST be the literal string "brreg" ──────────────────────────
// tierForSource() (cross-source-validator.ts) does an EXACT string match
// against TIER_B = ["brreg", "facebook_official_page"] — no `:`-splitting.
// Any other spelling (e.g. "brreg_fallback") silently falls to Tier-C and
// contributes NOTHING to the gate, with no visible error. Never prefix it.
//
// ── Address: postboks guard ─────────────────────────────────────────────────
// fetchBrregBusinessAddress()'s pickBrregAddress (brreg-client.ts, private)
// treats any non-empty street-line array as "usable", including a PO box
// (e.g. "Postboks 123") — it does NOT filter those out. isPostboksAddress()
// below adds that guard: a postboks-shaped adresse is treated as NO usable
// Brreg address for that agent (same as a null result) — never written to
// the column, never added as a provenance source. Matched forms (case-
// insensitive, leading token only): "postboks", "postb."/"postb" (the common
// abbreviation), and a bare leading "boks" token (e.g. "Boks 44") — a
// judgment call: "boks" alone as agent 1 could in principle be part of a
// real street name, but Norwegian street names practically never start with
// the bare word "boks", while postal-box addresses commonly drop "post-" in
// casual registrations, so treating it as a postboks signal is the safer
// (lower false-negative) choice here. Prefers forretningsadresse over
// postadresse — that fallback is fetchBrregBusinessAddress's own existing
// behaviour (pickBrregAddress), not reimplemented here.
//
// ── Phone: validatePhoneForWrite gate ────────────────────────────────────────
// Every phone value from Brreg — column write OR provenance value — must
// pass validatePhoneForWrite(raw, orgNr) (contact-normalizer.ts, the SAME
// call knowledge-service.ts's upsertKnowledge() already makes for every
// other phone write in this codebase). A null result means "no usable phone
// from Brreg for this agent" — skip phone entirely for that agent.
//
// ── Audit rows (agent_knowledge_audit; no batch_id column -> batch id lives
// in `notes`, e.g. "batch:<batchId> source:brreg") ───────────────────────────
// Decision (documented here for the reviewer): an audit row is written for a
// field whenever EITHER (a) a NEW Brreg provenance record was added for that
// field (source_type/value pair not already present), OR (b) the display
// column was actually written this call. In practice these two nearly always
// coincide (a column write only ever happens on the same pass that also adds
// the provenance record for that exact value) — the split matters only for
// the idempotent-rerun case (row (a) is false the second time; no column
// write either -> correctly no audit row) and the already-corroborated-
// column-still-blank-by-coincidence edge case (still audited, since the
// column genuinely changed). old_value is the pre-write display-column
// value; new_value is the newly-written value if the column was actually
// written this call, else unchanged (== old_value) for a provenance-only
// touch. changed_by is always 'system'.
//
// ── Request/response shape (mirrors org-nr-backfill above + gårdssalg's own
// contact-backfill, opplevelser.ts ~4671) ────────────────────────────────────
//   Body: { agentIds?: string[], limit?: number, offset?: number, apply?: bool }
//   apply truthy (bool true/1/"1"/"true", or ?apply=1/?apply=true query) ->
//   real writes; default is dry-run (report only, zero writes).
//   Selector: RFB producer agents (role='producer', is_active=1,
//   umbrella_type IS NULL, COALESCE(vertical_id,'rfb')='rfb') that NOW HAVE
//   org_nr (org-nr-backfill's own cohort, once it has run) and are not
//   owner-claimed. Deliberately NOT filtered on address/phone blank state —
//   see the design point above. agentIds bypasses the WHERE selector
//   (existence-only lookup, same override semantics as org-nr-backfill's own
//   agentIds), so an explicitly-named agent can be processed even without
//   org_nr (reported unresolved: no_org_nr) or already fully filled.
//   Default limit 25 / hard cap 100 — same scale as org-nr-backfill's own
//   defaults immediately above (this file's own closest same-table analogue,
//   at RFB's ~1000-agent scale).

const AGENTS_BRREG_CONTACT_BACKFILL_DEFAULT_LIMIT = 25;
const AGENTS_BRREG_CONTACT_BACKFILL_MAX_LIMIT = 100;

// ─── injectable fetch seam for this route's own Brreg calls ────────────────
// Own seam, deliberately separate from __setAgentsOrgNrBackfillFetchForTesting
// above: that seam's tests and this route's tests run as independent, non-
// mutually-exclusive test suites (see admin-agents-org-nr-backfill.test.ts's
// own header on why a SHARED global fetch reassignment across concurrently-
// running blocks is unsafe) — a single shared module-level fetch variable
// would let one suite's stub silently leak into the other's calls if their
// runs ever overlapped. Same non-throwing default-to-real-fetch convention.
let agentsBrregContactBackfillFetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

export function __setAgentsBrregContactBackfillFetchForTesting(impl?: typeof fetch): void {
  agentsBrregContactBackfillFetchImpl = impl || ((...args: Parameters<typeof fetch>) => fetch(...args));
}

// See the "Address: postboks guard" doc comment above for the exact forms
// matched and why. Leading-token only (start of the trimmed string), case-
// insensitive. Exported for unit tests.
const POSTBOKS_ADDRESS_RE = /^\s*(?:postboks|postb\.?|boks)\b/i;

export function isPostboksAddress(adresse: string | null | undefined): boolean {
  if (!adresse) return false;
  return POSTBOKS_ADDRESS_RE.test(adresse);
}

interface AgentBrregContactBackfillTargetRow {
  id: string;
  name: string;
  org_nr: string | null;
  claimed_at: string | null;
}

// Shared WHERE clause for both the count and the capped batch query — one
// source of truth, mirrors agentsOrgNrBackfillCandidateWhereSql's own
// convention above.
function agentsBrregContactBackfillCandidateWhereSql(): string {
  return `
    a.role = 'producer'
    AND a.is_active = 1
    AND a.umbrella_type IS NULL
    AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
    AND a.org_nr IS NOT NULL AND TRIM(a.org_nr) != ''
    AND a.claimed_at IS NULL
  `;
}

function agentsBrregContactBackfillSelectSql(): string {
  return `
    SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.claimed_at AS claimed_at
      FROM agents a
     WHERE ${agentsBrregContactBackfillCandidateWhereSql()}
  `;
}

function countAgentsBrregContactBackfillCandidates(db: ReturnType<typeof getDb>): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${agentsBrregContactBackfillSelectSql()})`).get() as { n: number };
  return row?.n ?? 0;
}

function fetchAgentsBrregContactBackfillBatch(
  db: ReturnType<typeof getDb>,
  limit: number,
  offset: number,
): AgentBrregContactBackfillTargetRow[] {
  return db
    .prepare(`${agentsBrregContactBackfillSelectSql()} ORDER BY a.created_at ASC, a.id ASC LIMIT ? OFFSET ?`)
    .all(limit, offset) as AgentBrregContactBackfillTargetRow[];
}

// Explicit-agentIds override lookup — scoped to role/vertical only (NOT the
// org_nr-present/claimed/active/umbrella filters), same override semantics
// as getAgentOrgNrBackfillTarget above: an admin can force a lookup attempt
// on any RFB producer agent; org_nr-presence and the lock are still enforced
// downstream (reported as a specific unresolved/skipped_locked reason, never
// silently dropped).
function getAgentBrregContactBackfillTarget(
  db: ReturnType<typeof getDb>,
  agentId: string,
): AgentBrregContactBackfillTargetRow | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.org_nr AS org_nr, a.claimed_at AS claimed_at
         FROM agents a
        WHERE a.id = ? AND a.role = 'producer' AND COALESCE(a.vertical_id, 'rfb') = 'rfb'`,
    )
    .get(agentId) as AgentBrregContactBackfillTargetRow | undefined;
  return row ?? null;
}

/**
 * True when `field`'s existing (pre-merge) provenance array already carries
 * a `source_type: "brreg"` record whose value matches `value` (trimmed) —
 * i.e. mergeFieldProvenance would treat this exact record as a dup. Accepts
 * both on-disk provenance shapes mergeFieldProvenance itself tolerates (bare
 * array, or a `{ sources: [...] }` wrapper) — see admin-knowledge.ts's own
 * extractSources()/isWellFormedRecord() for the shapes this mirrors.
 */
function agentKnowledgeHasBrregValueAlready(
  existingProv: Record<string, unknown>,
  field: string,
  value: string,
): boolean {
  const raw = existingProv[field];
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { sources?: unknown }).sources)
      ? (raw as { sources: unknown[] }).sources
      : [];
  const trimmed = value.trim();
  return list.some(
    (r) =>
      r &&
      typeof r === "object" &&
      (r as Record<string, unknown>).source_type === "brreg" &&
      typeof (r as Record<string, unknown>).value === "string" &&
      ((r as Record<string, unknown>).value as string).trim() === trimmed,
  );
}

/**
 * Apply (or, with opts.dryRun, merely PREVIEW) a Brreg address/phone
 * candidate to ONE agent — see the file-header doc comment above for the
 * full design rationale. Returns the field names actually touched: in
 * dry-run mode this is what WOULD be touched (a pure read, zero writes —
 * no transaction is ever opened when dryRun is true); in apply mode it is
 * what WAS touched (provenance newly added and/or the display column newly
 * filled), after a FRESH re-read of both the owner-lock and the current
 * agent_knowledge row inside the write transaction (race-safety, mirrors
 * applyAgentOrgNr's own repeated-guard discipline above). "Touched" per
 * field means the field's incoming value is non-blank AND (the exact
 * source_type=brreg/value pair is not already in field_provenance for that
 * field, OR the display column was/would be newly filled) — an idempotent
 * rerun with an already-filled column and an already-recorded provenance
 * value touches nothing and returns []. A locked agent (claimed_at IS NOT
 * NULL, checked both up front and freshly inside the write transaction)
 * always returns [] and never opens a transaction that writes. Exported for
 * unit tests.
 */
export function applyAgentBrregContact(
  db: ReturnType<typeof getDb>,
  agentId: string,
  values: { address?: string | null; phone?: string | null },
  evidenceUrl: string,
  opts: { dryRun?: boolean; batchId?: string } = {},
): string[] {
  const dryRun = !!opts.dryRun;

  const agentRow = db.prepare(`SELECT id, claimed_at FROM agents WHERE id = ?`).get(agentId) as
    | { id: string; claimed_at: string | null }
    | undefined;
  if (!agentRow) return [];
  if (agentRow.claimed_at) return []; // owner-claimed -> locked, mirrors applyAgentOrgNr

  const addressVal = values.address && values.address.trim() !== "" ? values.address.trim() : null;
  const phoneVal = values.phone && values.phone.trim() !== "" ? values.phone.trim() : null;
  if (!addressVal && !phoneVal) return [];

  const kRow = db.prepare(`SELECT address, phone, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
    | { address: string | null; phone: string | null; field_provenance: string | null }
    | undefined;

  let existingProv: Record<string, unknown> = {};
  if (kRow?.field_provenance) {
    try {
      const parsed = JSON.parse(kRow.field_provenance);
      if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }

  const addressProvNew = !!addressVal && !agentKnowledgeHasBrregValueAlready(existingProv, "address", addressVal);
  const phoneProvNew = !!phoneVal && !agentKnowledgeHasBrregValueAlready(existingProv, "phone", phoneVal);
  const addressColumnBlank = !kRow?.address || kRow.address.trim() === "";
  const phoneColumnBlank = !kRow?.phone || kRow.phone.trim() === "";
  const addressWouldFillColumn = !!addressVal && addressColumnBlank;
  const phoneWouldFillColumn = !!phoneVal && phoneColumnBlank;

  const touched: string[] = [];
  if (addressVal && (addressProvNew || addressWouldFillColumn)) touched.push("address");
  if (phoneVal && (phoneProvNew || phoneWouldFillColumn)) touched.push("phone");

  if (dryRun || touched.length === 0) return touched;

  const nowIso = new Date().toISOString();
  const written: string[] = [];

  const applyWithAudit = db.transaction(() => {
    // Fresh lock + row re-check INSIDE the transaction — same race-safety
    // discipline as applyAgentOrgNr's repeated-guard convention above.
    const freshAgent = db.prepare(`SELECT claimed_at FROM agents WHERE id = ?`).get(agentId) as
      | { claimed_at: string | null }
      | undefined;
    if (!freshAgent || freshAgent.claimed_at) throw new Error("locked_concurrently");

    let freshK = db.prepare(`SELECT address, phone, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
      | { address: string | null; phone: string | null; field_provenance: string | null }
      | undefined;
    if (freshK === undefined) {
      db.prepare(`INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)`).run(agentId, nowIso);
      freshK = { address: null, phone: null, field_provenance: "{}" };
    }

    let freshProv: Record<string, unknown> = {};
    if (freshK.field_provenance) {
      try {
        const parsed = JSON.parse(freshK.field_provenance);
        if (parsed && typeof parsed === "object") freshProv = parsed as Record<string, unknown>;
      } catch {
        /* malformed existing JSON -> treat as empty rather than clobber the write */
      }
    }

    const incoming: Record<string, { sources: Array<{ source_type: string; value: string; fetched_at: string; source_url: string }> }> = {};
    const provenanceNewlyAdded: string[] = [];
    if (addressVal && !agentKnowledgeHasBrregValueAlready(freshProv, "address", addressVal)) {
      incoming.address = { sources: [{ source_type: "brreg", value: addressVal, fetched_at: nowIso, source_url: evidenceUrl }] };
      provenanceNewlyAdded.push("address");
    }
    if (phoneVal && !agentKnowledgeHasBrregValueAlready(freshProv, "phone", phoneVal)) {
      incoming.phone = { sources: [{ source_type: "brreg", value: phoneVal, fetched_at: nowIso, source_url: evidenceUrl }] };
      provenanceNewlyAdded.push("phone");
    }
    if (Object.keys(incoming).length > 0) {
      const merged = mergeFieldProvenance(freshProv, incoming);
      db.prepare(`UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?`).run(
        JSON.stringify(merged),
        nowIso,
        agentId,
      );
    }

    // Fill-only column writes — guard re-checked INSIDE the UPDATE's own
    // WHERE (mirrors applyAgentOrgNr's org_nr UPDATE above exactly).
    let addressColumnWritten = false;
    let phoneColumnWritten = false;
    if (addressVal) {
      const upd = db
        .prepare(
          `UPDATE agent_knowledge SET address = @val, updated_at = @now
            WHERE agent_id = @id AND (address IS NULL OR TRIM(address) = '')`,
        )
        .run({ id: agentId, val: addressVal, now: nowIso });
      addressColumnWritten = upd.changes > 0;
    }
    if (phoneVal) {
      const upd = db
        .prepare(
          `UPDATE agent_knowledge SET phone = @val, updated_at = @now
            WHERE agent_id = @id AND (phone IS NULL OR TRIM(phone) = '')`,
        )
        .run({ id: agentId, val: phoneVal, now: nowIso });
      phoneColumnWritten = upd.changes > 0;
    }

    // Audit rows — see the file-header "Audit rows" doc comment for the
    // provenance-newly-added-OR-column-written decision.
    const auditFields: string[] = [];
    if (addressVal && (provenanceNewlyAdded.includes("address") || addressColumnWritten)) auditFields.push("address");
    if (phoneVal && (provenanceNewlyAdded.includes("phone") || phoneColumnWritten)) auditFields.push("phone");

    for (const field of auditFields) {
      const oldVal = field === "address" ? (freshK.address ?? null) : (freshK.phone ?? null);
      const columnWrittenThisField = field === "address" ? addressColumnWritten : phoneColumnWritten;
      const newVal = columnWrittenThisField ? (field === "address" ? addressVal : phoneVal) : oldVal;
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(uuid(), agentId, field, oldVal, newVal, `batch:${opts.batchId ?? "manual"} source:brreg`);
      written.push(field);
    }
  });

  try {
    applyWithAudit();
  } catch (e: any) {
    if (String(e?.message) === "locked_concurrently") return [];
    throw e;
  }

  return written;
}

router.post("/brreg-contact-backfill", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown; offset?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0
      ? Math.floor(body.limit)
      : AGENTS_BRREG_CONTACT_BACKFILL_DEFAULT_LIMIT,
    AGENTS_BRREG_CONTACT_BACKFILL_MAX_LIMIT,
  );
  const offset = typeof body.offset === "number" && body.offset > 0 ? Math.floor(body.offset) : 0;

  try {
    const db = getDb();
    const batchId = `agents-brreg-contact-backfill-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
    const cohortTotal = countAgentsBrregContactBackfillCandidates(db);

    let targets: AgentBrregContactBackfillTargetRow[];
    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      const ids = Array.from(
        new Set(
          (body.agentIds as unknown[])
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim()),
        ),
      ).slice(0, limit);
      targets = ids
        .map((id) => getAgentBrregContactBackfillTarget(db, id))
        .filter((t): t is AgentBrregContactBackfillTargetRow => t !== null);
    } else {
      targets = fetchAgentsBrregContactBackfillBatch(db, limit, offset);
    }

    let scanned = 0;
    let brregHitAddress = 0;
    let brregHitPhone = 0;
    let brregHitAny = 0;
    const changed: Array<{ agent_id: string; fields: string[]; address: string | null; phone: string | null; source_url: string }> = [];
    const skippedLocked: string[] = [];
    const unresolved: Array<{ agent_id: string; reason: string }> = [];
    const errors: Array<{ agent_id: string; error: string }> = [];

    for (const t of targets) {
      const agentId = t.id;

      if (t.claimed_at) {
        skippedLocked.push(agentId);
        continue;
      }
      if (!t.org_nr || t.org_nr.trim() === "") {
        // Only reachable via the explicit agentIds override — the auto-
        // selector already filters org_nr-blank rows.
        unresolved.push({ agent_id: agentId, reason: "no_org_nr" });
        continue;
      }

      let brregAddress: BrregAddress | null;
      let brregContact: BrregContact | null;
      try {
        [brregAddress, brregContact] = await Promise.all([
          fetchBrregBusinessAddress(t.org_nr, agentsBrregContactBackfillFetchImpl),
          fetchBrregContact(t.org_nr, agentsBrregContactBackfillFetchImpl),
        ]);
      } catch (e: any) {
        // Both fetch functions are documented never-throw; this catch exists
        // so a contract violation degrades one row instead of the batch.
        errors.push({ agent_id: agentId, error: e?.message ?? String(e) });
        continue;
      }
      scanned++;

      // ── Address: postboks guard (see file-header doc comment) ────────────
      const usableAddress =
        brregAddress?.adresse && !isPostboksAddress(brregAddress.adresse) ? brregAddress.adresse : null;
      if (usableAddress) brregHitAddress++;

      // ── Phone: validatePhoneForWrite gate ─────────────────────────────────
      const usablePhone = brregContact?.telefon ? validatePhoneForWrite(brregContact.telefon, t.org_nr) : null;
      if (usablePhone) brregHitPhone++;

      if (usableAddress || usablePhone) brregHitAny++;

      if (!usableAddress && !usablePhone) {
        unresolved.push({ agent_id: agentId, reason: "no_usable_brreg_contact" });
        continue;
      }

      const evidenceUrl = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(t.org_nr)}`;

      // Grep 5b LLM-judge contact gate (dev-request 2026-08-19-kursjustering-
      // drikkefunnel-llm-og-supply): Brreg is a structured registry source
      // (lower risk than the scraped-HTML lanes 1-3 — see the dev-request's
      // own framing), but per its own "no exceptions" requirement this route
      // was still ungated before this slice. Both candidates are gated
      // together, independently, BEFORE either the dry-run preview or the
      // real write — a rejected field is treated exactly like Brreg never
      // having returned it. brreg_hits above already counted the RAW Brreg
      // yield (a data-quality signal, unaffected by the gate); this replaces
      // the values that actually reach applyAgentBrregContact.
      const gateSourceContext =
        `Data fra Brønnøysundregistrene (Brreg) for org.nr ${t.org_nr}: ` +
        `adresse=${JSON.stringify(usableAddress)}, telefon=${JSON.stringify(usablePhone)}.`;
      const gated = await gateContactCandidates({
        businessName: t.name,
        sourceContext: gateSourceContext,
        candidateAddress: usableAddress,
        candidatePhone: usablePhone,
      });
      if (usableAddress && !gated.address) {
        console.log(
          `[agents-brreg-contact-backfill] ${agentId} (${t.name}) address candidate "${usableAddress}" REJECTED by contact gate — ${gated.addressRejectedReason ?? "unknown reason"}; not applied`
        );
      }
      if (usablePhone && !gated.phone) {
        console.log(
          `[agents-brreg-contact-backfill] ${agentId} (${t.name}) phone candidate "${usablePhone}" REJECTED by contact gate — ${gated.phoneRejectedReason ?? "unknown reason"}; not applied`
        );
      }
      const gatedAddress = gated.address;
      const gatedPhone = gated.phone;
      if (!gatedAddress && !gatedPhone) {
        unresolved.push({ agent_id: agentId, reason: "contact_gate_rejected" });
        continue;
      }

      if (dryRun) {
        const wouldTouch = applyAgentBrregContact(
          db,
          agentId,
          { address: gatedAddress, phone: gatedPhone },
          evidenceUrl,
          { dryRun: true },
        );
        if (wouldTouch.length === 0) {
          unresolved.push({ agent_id: agentId, reason: "already_up_to_date" });
          continue;
        }
        changed.push({
          agent_id: agentId,
          fields: wouldTouch,
          address: wouldTouch.includes("address") ? gatedAddress : null,
          phone: wouldTouch.includes("phone") ? gatedPhone : null,
          source_url: evidenceUrl,
        });
      } else {
        try {
          const written = applyAgentBrregContact(
            db,
            agentId,
            { address: gatedAddress, phone: gatedPhone },
            evidenceUrl,
            { dryRun: false, batchId },
          );
          if (written.length > 0) {
            changed.push({
              agent_id: agentId,
              fields: written,
              address: written.includes("address") ? gatedAddress : null,
              phone: written.includes("phone") ? gatedPhone : null,
              source_url: evidenceUrl,
            });
          } else {
            // Idempotent rerun (column already filled + provenance already
            // recorded this exact value) or a concurrent lock/write raced
            // us between the dry-read above and the write transaction —
            // bucketed, never silently dropped.
            unresolved.push({ agent_id: agentId, reason: "already_up_to_date" });
          }
        } catch (e: any) {
          errors.push({ agent_id: agentId, error: `write_failed: ${e?.message ?? String(e)}` });
        }
      }
    }

    res.json({
      dry_run: dryRun,
      batch_id: batchId,
      cohort_total: cohortTotal,
      offset,
      limit,
      scanned,
      brreg_hits: { address: brregHitAddress, phone: brregHitPhone, any: brregHitAny },
      agents_enriched: changed.length,
      changed,
      skipped_locked: skippedLocked,
      unresolved,
      errors,
    });
  } catch (err: any) {
    res.status(500).json({ error: "brreg-contact-backfill failed", detail: err.message });
  }
});

// ─── GET /admin/agents/category-sanity-report ───────────────────
// Criterion 4 of dev-request 2026-07-25-rfb-kvalitetsgate-og-retroskann:
// report-only (never writes) detector for RFB producer rows whose
// `categories` set looks implausibly broad. Modeled directly on the
// Skakke Røykeri incident (a smoked-fish producer auto-tagged with
// categories meat,vegetables,fruit,bakery,honey,fish — six categories
// spanning unrelated product classes for a business that actually only
// does smoked fish/meat/game). That one row was fixed by hand; this
// endpoint is the systemic detector so rows like it surface for review
// instead of silently existing, since the auto-generated product rows
// inherit category errors directly from the category set.
//
// Query params:
//   min_categories  positive integer, default 5 (optional)
//
// Response:
//   { success: true, min_categories, scanned_count, flagged_count,
//     flagged: [{ id, name, org_nr, categories, category_count,
//                 includes_bakery_and_fish }] }
//   ordered by category_count DESC (worst offenders first).
//
// Scope: RFB producers only — same vertical-scoping idiom as
// brregSweepCandidateWhereSql() above (COALESCE(vertical_id, 'rfb') =
// 'rfb'), plus role = 'producer' (this report is about producer category
// tagging) and is_active = 1 (inactive/deleted rows aren't actionable).
router.get("/category-sanity-report", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // min_categories: default 5, must be a positive integer if provided.
  // Mirrors GET /'s own limit/offset validation style above.
  let minCategories = 5;
  if (req.query.min_categories !== undefined) {
    const n = parseInt(req.query.min_categories as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      res.status(400).json({
        error: "invalid min_categories",
        detail: "min_categories must be >= 1",
      });
      return;
    }
    minCategories = n;
  }

  try {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT id, name, org_nr, categories FROM agents
         WHERE COALESCE(vertical_id, 'rfb') = 'rfb'
           AND role = 'producer'
           AND is_active = 1`,
      )
      .all() as Array<{ id: string; name: string; org_nr: string | null; categories: string | null }>;

    const flagged: Array<{
      id: string;
      name: string;
      org_nr: string | null;
      categories: string[];
      category_count: number;
      includes_bakery_and_fish: boolean;
    }> = [];

    for (const row of rows) {
      let categories: unknown;
      try {
        categories = JSON.parse(row.categories || "[]");
      } catch (err) {
        console.warn(
          `[admin-agents] category-sanity-report: unparseable categories for agent ${row.id}, excluding from flagged set:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      if (!Array.isArray(categories) || categories.length < minCategories) continue;

      flagged.push({
        id: row.id,
        name: row.name,
        org_nr: row.org_nr,
        categories,
        category_count: categories.length,
        includes_bakery_and_fish: categories.includes("bakery") && categories.includes("fish"),
      });
    }

    flagged.sort((a, b) => b.category_count - a.category_count);

    res.json({
      success: true,
      min_categories: minCategories,
      scanned_count: rows.length,
      flagged_count: flagged.length,
      flagged,
    });
  } catch (err: any) {
    res.status(500).json({ error: "category-sanity-report failed", detail: err.message });
  }
});

// ─── judgeRfbAboutCandidate + meetsRfbAboutQualityBar + POST
//     /admin/agents/retro-scan (dev-request rfb-kvalitetsgate-parity) ───────
//
// RFB (rettfrabonden.com) port of gårdssalg's LLM-judge quality-gate cascade
// (judgeGardssalgAboutCandidate / meetsGardssalgAboutQualityBar,
// routes/opplevelser.ts, dev-request 2026-07-20-gardssalg-kvalitetsgate-
// redesign) + its retroactive re-scan (POST /admin/gardssalg-retro-scan).
// Two confirmed problems this ports the fix for:
//
//   1. NAV_BOILERPLATE_MARKERS (search-enrich.ts) was a flat literal-
//      substring list that missed real-world skip-link wording variants
//      ("Jump to ...", "Skip to the content", "Skip to main content", "skip
//      to navigation") — fixed separately, in search-enrich.ts itself, by a
//      normalizing NAV_SKIP_OR_JUMP_LINK_RE (see that file). That fix is
//      shared infrastructure, not specific to this section.
//   2. RFB had NO retroactive re-scan of already-stored `description`
//      (agents.description) / `about` (agent_knowledge.about) content — rows
//      enriched before a marker existed are never re-evaluated. This section
//      is that retroactive sweep, judging what's ALREADY STORED against a
//      cascade LLM judge (semantic judgment, not just a marker regex) —
//      exactly gårdssalg's retro-scan design, ported to RFB's two content
//      fields instead of gårdssalg's about_text/visit_text pair.
//
// SCOPING NOTE: only this retro-scan (a re-judge of ALREADY-STORED content)
// is wired to the new judge in this slice. The FORWARD write paths that
// originate description/about text (admin-agents.ts's own brreg-description-
// fallback above, PATCH /agents/:id and PUT /agents/:id/knowledge in
// marketplace.ts, and search-enrich's content_signals) are each their own
// established, separately-reviewed contract — brreg-description-fallback
// trusts Brreg's registry text by design (no heuristic at all, see that
// endpoint's own header comment); PATCH/PUT are owner/admin self-edit paths
// where auto-rejecting a producer's own words via an LLM would be a product
// change, not a quality-gate port. Wiring the judge into those FORWARD paths
// is left as an explicit, separately-reviewable follow-up — see this PR's
// description for the full reasoning.
//
// judgeRfbAboutCandidate mirrors judgeGardssalgAboutCandidate's EXACT
// sentinel/fail-closed contract: direct fetch to
// https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
// claude-opus-4-8. ANY doubt or failure — missing key, network failure,
// non-200, unparseable JSON, a response that isn't the exact expected
// verdict token — resolves to REJECT. Never throws, never silently
// approves. Placed in this ROUTE file (not services/search-enrich.ts) to
// preserve that service module's own documented "PURE, no network/IO"
// invariant — exactly mirroring gårdssalg's own layering (the LLM-calling
// judge lives in the route file, opplevelser.ts; the pure cheap prefilter it
// reuses lives in the service file, search-enrich.ts).
export interface RfbJudgeVerdict {
  approved: boolean;
  reasoning: string;
}

const RFB_JUDGE_APPROVE_TOKEN = "GODKJENN";
const RFB_JUDGE_REJECT_TOKEN = "AVVIS";
const RFB_JUDGE_CANDIDATE_CHAR_CAP = 4000;
// Every fail-closed branch's reasoning below ends in this exact literal
// suffix — isRfbJudgeInfraFailure() (used by the retro-scan's null-vs-leave
// decision) tells a genuine AVVIS verdict (real model reasoning) apart from
// an infra failure by checking for it. Mirrors
// GARDSSALG_JUDGE_INFRA_FAILURE_SUFFIX exactly (routes/opplevelser.ts).
const RFB_JUDGE_INFRA_FAILURE_SUFFIX = "avvist fail-closed";

export async function judgeRfbAboutCandidate(
  candidateText: string,
  producerName: string,
  kind: "description" | "about"
): Promise<RfbJudgeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reasoning: `ANTHROPIC_API_KEY mangler — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  const sectionLabel =
    kind === "description"
      ? "kort produsentbeskrivelse"
      : "utfyllende «Om produsenten»-tekst";
  const cappedCandidate = (candidateText || "").slice(0, RFB_JUDGE_CANDIDATE_CHAR_CAP);
  const prompt = `Du er en kvalitetsdommer for produsentprofiler på Rett fra Bonden, en norsk markedsplattform som kobler forbrukere direkte med lokale matprodusenter. Vurder om kandidatteksten under er egnet til å publiseres som ${sectionLabel} for produsenten "${producerName}".

Kandidattekst:
${cappedCandidate}

Godkjenn KUN hvis teksten er:
- sammenhengende, ekte norsk prosa spesifikt om DENNE produsenten (ikke en paraplyorganisasjon/bransjeforening sine mange medlemmer omtalt samlet),
- fri for lekket navigasjonsmeny-, sidetopp- eller bunntekst-innhold (lenkelister, "hjem"/"kontakt"/"meny"-navigasjon, "skip to content"/"jump to ..."-lenker, cookie-/samtykketekst, "hopp til innhold" og lignende),
- fri for åpenbart oppstykket, avkuttet eller ødelagt tekst,
- faktisk informativ om produsenten, ikke bare en generisk floskel.

Vurder ikke lengde, ikke volum — vurder KUN om teksten fremhever DENNE produsentens særegne egenskaper (produkter, sted, driftsform, historie, utmerkelser): en kort tekst som konkret navngir slikt skal godkjennes selv om den er kort, mens en lang men trekk-løs/generisk tekst skal avvises selv om den er lang. Kort-men-spesifikk = godkjenn; trekk-løs/generisk = avvis, uansett lengde.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${RFB_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${RFB_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${RFB_JUDGE_REJECT_TOKEN}.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { approved: false, reasoning: `nettverksfeil under dommer-kall — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` }; // never fabricate
  }

  if (!response.ok) {
    return { approved: false, reasoning: `dommer-API svarte status ${response.status} — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { approved: false, reasoning: `ikke-parsbar JSON fra dommer-API — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { approved: false, reasoning: `uventet svarformat fra dommer-API — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toUpperCase();
  const reasoning = lines.slice(1).join(" ").trim();

  // Only the EXACT approve token approves. Anything else — the reject
  // token, an empty response, garbage, a token that merely CONTAINS the
  // approve word inside a longer sentence — is a reject. Fail-closed on any
  // ambiguity, never a silent approval.
  if (verdictToken === RFB_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reasoning: reasoning || "godkjent av LLM-dommer" };
  }
  if (verdictToken === RFB_JUDGE_REJECT_TOKEN) {
    return { approved: false, reasoning: reasoning || "avvist av LLM-dommer" };
  }
  return { approved: false, reasoning: `uventet/tvetydig dommersvar — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
}

/**
 * True iff `verdict.reasoning` is one of judgeRfbAboutCandidate's own
 * fail-closed sentinel reasons (missing key / network / non-200 /
 * unparseable JSON / unexpected shape / ambiguous verdict) rather than a
 * genuine AVVIS verdict from the model. Used by the retro-scan below, which
 * — unlike every OTHER call site of this judge — must NOT treat an infra
 * failure the same as a real rejection: for a fresh CANDIDATE, "not
 * approved" safely means "don't publish it", but for the retro-scan, "not
 * approved" would otherwise mean "null out content that's already live" — a
 * destructive action an API outage must never trigger. Mirrors
 * isJudgeInfraFailure (routes/opplevelser.ts) exactly.
 */
export function isRfbJudgeInfraFailure(verdict: RfbJudgeVerdict): boolean {
  return verdict.reasoning.endsWith(RFB_JUDGE_INFRA_FAILURE_SUFFIX);
}

/**
 * The RFB-specific description/about quality gate: the cheap, deterministic
 * prefilter (meetsAboutCheapBar, search-enrich.ts) FIRST, and the LLM judge
 * above ONLY when that passes. Cost control: a candidate the cheap filter
 * would already reject never reaches the LLM at all. Mirrors
 * meetsGardssalgAboutQualityBar exactly (routes/opplevelser.ts), with
 * "description"/"about" in place of gårdssalg's "about"/"visit" kind pair.
 */
export async function meetsRfbAboutQualityBar(
  candidateText: string | null | undefined,
  producerName: string,
  kind: "description" | "about"
): Promise<boolean> {
  if (!meetsAboutCheapBar(candidateText)) return false;
  const verdict = await judgeRfbAboutCandidate(String(candidateText), producerName, kind);
  return verdict.approved;
}

// ─── POST /admin/agents/retro-scan (admin) ──────────────────────────────────
//
// The retroactive sweep: for every non-locked RFB agent (umbrella agents are
// out of SCOPE entirely — they aggregate multiple underlying members, so a
// single description/about judgment doesn't map onto one producer, mirrors
// admin-knowledge.ts's homepage-content-refresh and admin-wrong-entity-
// retro-sweep.ts's own umbrella exclusion), re-judges the CURRENTLY STORED
// agents.description / agent_knowledge.about against meetsRfbAboutQualityBar's
// cascade — not a freshly generated candidate, the value already live today.
// A field that no longer clears it is NULLED (apply mode); a passing field is
// left completely untouched.
//
// "Locked" for RFB: mirrors search-enrich-sweep.ts's / admin-search-enrich.ts's
// own `a.claimed_at IS NULL` convention — RFB has no gårdssalg-style single
// content_source enum column; `agents.claimed_at` (set once a producer claims
// their own agent) is the row-level equivalent of gårdssalg's content_source
// IN ('manual','claim') lock, and is checked FIRST, before anything else, on
// a fresh per-row snapshot (defense in depth against a claim landing between
// selection and write). On TOP of that row-level lock, RFB also has a
// per-FIELD lock (agent_knowledge.curated_fields) that every other RFB write
// path (brreg-description-fallback above, admin-knowledge.ts's homepage-
// content-refresh, owner-portal.ts) already treats as an absolute refusal —
// this sweep respects it too (a curated-locked field is never nulled, even
// if it would otherwise fail the gate), which gårdssalg's simpler schema
// has no equivalent of, so it is an ADDITIVE safety check here, not a gap.
//
// FAIL-CLOSED in the OPPOSITE direction from every other call site of this
// judge, per rfbRetroScanShouldNull's own doc comment below: an infra
// failure (isRfbJudgeInfraFailure) never nulls a field — only a genuine
// AVVIS verdict does.
//
// No homepage re-fetch (unlike gårdssalg's retro-scan): gårdssalg re-fetches
// the homepage before judging solely to obtain a fresh, genuinely-verified
// content_evidence_url for its write-discipline column (and to detect a now-
// dead homepage via recordProviderHomepageFetchResult). RFB's field_provenance
// write discipline does not require a fresh evidence_url for a NULL (there is
// no new value being sourced — the write only ever REMOVES a
// field_provenance entry, never adds one), and RFB has no equivalent "dead
// homepage" bookkeeping tied to this specific write. Re-fetching purely to
// manufacture an evidence_url nothing downstream reads would be exactly the
// kind of unnecessary complexity this fleet's own conventions ask to avoid.
//
// "Re-queue": no new queue mechanism is added. Nulling `description` (which
// this route stores as '' — agents.description is NOT NULL, so "empty" is
// always the empty string here, the SAME convention brreg-description-
// fallback's own candidate WHERE clause already uses) makes the row a
// candidate for that EXACT existing brreg-description-fallback sweep again
// (TRIM(a.description) = '' AND org_nr present AND not curated) — verified
// against that endpoint's own brregDescriptionFallbackCandidateSql() above,
// not assumed. Nulling `about` (agent_knowledge.about, nullable — set to
// SQL NULL) does not unconditionally re-feed admin-knowledge.ts's homepage-
// content-refresh auto-select, whose own WHERE clause requires SOME existing
// about/products content to already be present as its re-refresh trigger;
// a row whose about AND products are both blank falls outside that specific
// auto-select query (a pre-existing property of that query, not introduced
// here) but remains reachable by re-running homepage-content-refresh with an
// explicit `agentIds` override, which does not require pre-existing content.
const RFB_RETRO_SCAN_DEFAULT_LIMIT = 25;
const RFB_RETRO_SCAN_MAX_LIMIT = 100;
const RFB_RETRO_SCAN_CONCURRENCY = 3;
// Sanity ceiling for `offset`, comfortably above the ~1500-row eligible RFB
// catalog for the foreseeable future. Without an upper bound, a caller-
// supplied value like 1e19 passes Number.isInteger() (IEEE-754 doubles that
// large are always "integers") but crashes better-sqlite3's prepared
// `OFFSET ?` bind with an uncaught `SqliteError: datatype mismatch` — there's
// no error-handling middleware in src/index.ts, so that surfaces as an
// unhandled 500 instead of this endpoint's own {error, detail} 400 contract.
// Explicitly rejecting anything past a generous, named ceiling is better
// than silently returning an empty page (or crashing) for values nobody
// legitimate would ever pass.
const RFB_RETRO_SCAN_OFFSET_MAX = 100_000;

/**
 * Shared offset validation for both POST /retro-scan and GET
 * /tynne-profiler-cohort below (dev-request 2026-08-15-tynne-profiler-
 * forbedringsloype, Slice 1) — factored out so the cohort endpoint gets the
 * EXACT same non-negative-integer / non-scalar / ceiling checks the
 * retro-scan route already validated, rather than a second hand-rolled
 * copy. `raw === undefined` -> offset 0, reproducing today's default.
 */
function parseRfbRetroScanOffset(raw: unknown): { offset: number } | { error: string; detail: string } {
  if (raw === undefined) return { offset: 0 };
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { error: "invalid offset", detail: "offset must be a non-negative integer" };
  }
  const n = typeof raw === "number" ? raw : parseInt(raw as string, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > RFB_RETRO_SCAN_OFFSET_MAX) {
    return { error: "invalid offset", detail: "offset must be a non-negative integer" };
  }
  return { offset: n };
}

interface RfbRetroScanTarget {
  agent_id: string;
  name: string;
  description: string;
  about: string | null;
  curated_fields: string | null;
  field_provenance: string | null;
  claimed_at: string | null;
}

/** True iff the parsed curated_fields JSON locks `field` (any truthy value — a
 * bare `true` [brreg-description-fallback's own convention] or an owner-
 * portal-style `{locked_at, by}` object both count as locked). Tolerates
 * malformed/missing JSON (treated as "not locked"), matching the defensive-
 * parse convention used throughout this file and admin-knowledge.ts. */
function isRfbFieldCurated(curatedFieldsJson: string | null | undefined, field: "description" | "about"): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    return !!(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)[field]);
  } catch {
    return false;
  }
}

function rfbRetroScanAutoSelectSql(): string {
  return `
    SELECT a.id AS agent_id, a.name AS name, a.description AS description,
           k.about AS about, k.curated_fields AS curated_fields,
           k.field_provenance AS field_provenance, a.claimed_at AS claimed_at
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.umbrella_type IS NULL
       AND a.claimed_at IS NULL
       AND (
             TRIM(a.description) != ''
          OR (k.about IS NOT NULL AND TRIM(k.about) != '')
           )
  `;
}

function selectRfbAgentsForRetroScan(
  db: ReturnType<typeof getDb>,
  limit: number,
  offset: number,
): RfbRetroScanTarget[] {
  return db
    .prepare(`${rfbRetroScanAutoSelectSql()} ORDER BY a.created_at ASC LIMIT ? OFFSET ?`)
    .all(limit, offset) as RfbRetroScanTarget[];
}

/**
 * COUNT(*) over the exact same WHERE clause as rfbRetroScanAutoSelectSql()
 * (no LIMIT/OFFSET) — lets a caller paginating the auto-select path (e.g. a
 * full-catalog dry-run in batches of `limit`) know how many eligible rows
 * remain across the whole catalog, not just in this one page. Returned
 * regardless of which selection path (auto-select or explicit `agentIds`)
 * was actually used for this call — it's a property of the catalog, not of
 * the request — so a single cheap COUNT query is run unconditionally rather
 * than threading a condition through both call sites.
 */
function countRfbRetroScanEligible(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM (${rfbRetroScanAutoSelectSql()})`)
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Resolve an explicit agentId for the retro-scan's `agentIds` override.
 * Scoped to non-umbrella agents ONLY (umbrella agents are out of scope
 * entirely, see this section's header comment) — NOT the claimed_at lock,
 * so an explicitly-requested claimed agent still resolves to a target and is
 * then reported in skipped_locked by the route's own check, mirroring
 * getGardssalgProviderRetroScanTarget's identical convention. Returns null
 * when the agent doesn't exist or is an umbrella agent.
 */
function getRfbAgentRetroScanTarget(db: ReturnType<typeof getDb>, agentId: string): RfbRetroScanTarget | null {
  const row = db
    .prepare(
      `SELECT a.id AS agent_id, a.name AS name, a.description AS description,
              k.about AS about, k.curated_fields AS curated_fields,
              k.field_provenance AS field_provenance, a.claimed_at AS claimed_at,
              a.umbrella_type AS umbrella_type
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`
    )
    .get(agentId) as (RfbRetroScanTarget & { umbrella_type: string | null }) | undefined;
  if (!row || row.umbrella_type != null) return null;
  return row;
}

/** Which of rfbRetroScanShouldNull's two decision paths a flagged field went
 * through — surfaced by the retro-scan report's by_cause_class breakdown
 * (dev-request 2026-07-25-rfb-kvalitetsgate-og-retroskann kriterium 7,
 * acceptance (a): the report must show 0 rows flagged on length alone
 * without an LLM verdict). "deterministic_*" fields never call the judge;
 * "llm_rejected" is the ONLY class a too-short-but-otherwise-clean value can
 * land in. */
export type RfbRetroScanCauseClass =
  | "deterministic_mangled"
  | "deterministic_boilerplate"
  | "deterministic_foreign"
  | "llm_rejected";

/**
 * Decide whether ONE currently-stored description/about value should be
 * nulled by the retro-scan.
 *
 * Kriterium 7 (2026-08-14, Daniel live sign-off after the 278-row stikkprøve
 * showed 13-14/15 flagged rows were legitimate-but-short prose, not garbage):
 * pure LENGTH is evidence of INCOMPLETE, not evidence of WRONG — it is no
 * longer treated as deterministic garbage. Only classifyAboutCheapBar's three
 * genuine garbage classes (mangled Unicode, boilerplate/cookie chrome,
 * non-Norwegian) still null outright, with no judgment call. Everything else
 * — including a value that is short but otherwise clean, which used to
 * short-circuit here without ever reaching the judge — goes to the SAME
 * existing LLM-judge cascade a cheap-bar PASS already used, and ONLY a
 * genuine (non-infra-failure) rejection nulls; an infra failure leaves the
 * field untouched (fail-closed toward NOT destroying data, per this route's
 * own contract). Blank values are never flagged (nothing to judge). Mirrors
 * gardssalgRetroScanShouldNull's overall shape (routes/opplevelser.ts), with
 * the cheap-bar split kept local to RFB's retro-scan only — meetsRfbAbout-
 * QualityBar (the LIVE-write gate a brand-new candidate must clear before it
 * is ever written) is UNCHANGED: this split applies only to re-judging
 * content that is already live, where "too short" and "never verified" are
 * different claims.
 */
async function rfbRetroScanShouldNull(
  value: string | null | undefined,
  producerName: string,
  kind: "description" | "about"
): Promise<{ shouldNull: boolean; reason: string | null; causeClass: RfbRetroScanCauseClass | null }> {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { shouldNull: false, reason: null, causeClass: null };
  }
  const cheapBarClass = classifyAboutCheapBar(value);
  if (cheapBarClass === "mangled" || cheapBarClass === "boilerplate" || cheapBarClass === "foreign") {
    return {
      shouldNull: true,
      reason: `fails the cheap bar (${cheapBarClass})`,
      causeClass: `deterministic_${cheapBarClass}`,
    };
  }
  // cheapBarClass is "ok" or "too_short" — both now reach the judge.
  const verdict = await judgeRfbAboutCandidate(value, producerName, kind);
  if (verdict.approved) return { shouldNull: false, reason: null, causeClass: null };
  if (isRfbJudgeInfraFailure(verdict)) {
    // Never destroy data on doubt — leave the field exactly as it is.
    return { shouldNull: false, reason: null, causeClass: null };
  }
  return { shouldNull: true, reason: verdict.reasoning, causeClass: "llm_rejected" };
}

/**
 * Null a set of description/about fields on ONE RFB agent because the
 * retro-scan judged the CURRENTLY STORED value as no longer clearing the
 * RFB quality gate. Re-checks the row-level claimed_at lock AND the
 * per-field curated_fields lock against a FRESH snapshot immediately before
 * writing (defense in depth — the caller already checked both, but either
 * could in principle change between selection and this write, mirroring
 * brreg-description-fallback's own re-check-before-write convention above).
 *
 * `agents.description` is NOT NULL, so "nulling" it means the empty string
 * — the SAME "blank" convention brreg-description-fallback's own candidate
 * WHERE clause already uses (TRIM(description) = ''), which is what makes
 * that endpoint's own re-selection the genuine re-queue path for this field
 * (see this section's header comment). `agent_knowledge.about` is nullable,
 * so it is set to SQL NULL.
 *
 * field_provenance entries for nulled fields are REMOVED (read-modify-write,
 * preserves other fields' entries) — a blank field has no source backing it
 * any more. An `agent_knowledge_audit` row is written per field actually
 * nulled — mirrors owner-portal.ts's own insert convention exactly
 * (id/agent_id/field_name/old_value/new_value/changed_by/changed_by_email/
 * changed_at/notes), with changed_by:'system' (an automated sweep, not an
 * owner or admin action) and the judge's own reasoning (or the cheap-bar
 * reason) recorded in `notes` for GET /admin/agent-audit to surface.
 *
 * A field already blank, or curated-locked, is left alone (nothing to null);
 * an agent with nothing to null across the requested fields writes nothing
 * and returns [].
 */
function applyRfbRetroScanNull(
  db: ReturnType<typeof getDb>,
  agentId: string,
  fields: Array<"description" | "about">,
  reasons: Record<string, string>
): string[] {
  const row = db
    .prepare(
      `SELECT a.claimed_at AS claimed_at, a.description AS description,
              k.about AS about, k.curated_fields AS curated_fields,
              k.field_provenance AS field_provenance
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`
    )
    .get(agentId) as
    | {
        claimed_at: string | null;
        description: string;
        about: string | null;
        curated_fields: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return [];
  if (row.claimed_at) return []; // claimed since selection — never touch

  const oldValues: Record<string, string | null> = { description: row.description, about: row.about };
  const written: string[] = [];
  const auditRows: Array<{ field_name: string; old_value: string | null; new_value: string | null }> = [];

  const tx = db.transaction((): void => {
    for (const f of fields) {
      const current = oldValues[f];
      if (current === null || current === undefined || String(current).trim() === "") continue; // already blank
      if (isRfbFieldCurated(row.curated_fields, f)) continue; // re-checked right before writing

      if (f === "description") {
        db.prepare(`UPDATE agents SET description = '' WHERE id = ?`).run(agentId);
        auditRows.push({ field_name: f, old_value: current, new_value: "" });
      } else {
        db.prepare(`UPDATE agent_knowledge SET about = NULL WHERE agent_id = ?`).run(agentId);
        auditRows.push({ field_name: f, old_value: current, new_value: null });
      }
      written.push(f);
    }
    if (written.length === 0) return;

    // field_provenance merge — remove the entry for each nulled field.
    let provenance: Record<string, unknown> = {};
    if (row.field_provenance) {
      try {
        const parsed = JSON.parse(row.field_provenance);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          provenance = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed existing JSON -> treat as empty rather than clobber the write */
      }
    }
    for (const f of written) delete provenance[f];
    const nowIso = new Date().toISOString();

    const exists = db.prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?").get(agentId);
    if (!exists) {
      db.prepare(
        "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, ?, ?)",
      ).run(agentId, JSON.stringify(provenance), nowIso);
    } else {
      db.prepare("UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?").run(
        JSON.stringify(provenance),
        nowIso,
        agentId,
      );
    }

    const insertAudit = db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`
    );
    for (const ar of auditRows) {
      insertAudit.run(
        require("crypto").randomUUID(),
        agentId,
        ar.field_name,
        ar.old_value,
        ar.new_value,
        nowIso,
        reasons[ar.field_name] ?? null,
      );
    }
  });
  tx();

  return written;
}

/** One flagged-and-in-scope row from runRfbRetroScanCore's `changed[]` —
 * `name` and `cause_classes` are additive over the original POST
 * /retro-scan response shape (dev-request 2026-08-15-tynne-profiler-
 * forbedringsloype, Slice 1): GET /tynne-profiler-cohort below needs both
 * (the producer name for its persisted queue row, the per-field cause class
 * for its report) without re-querying the DB or re-running the judge, so
 * they're carried through here instead of bolted on separately. Purely
 * additive — existing POST /retro-scan callers/tests reading `agent_id`/
 * `fields`/`reasons` are unaffected. */
interface RfbRetroScanChangedEntry {
  agent_id: string;
  name: string;
  fields: string[];
  reasons: Record<string, string>;
  cause_classes: Partial<Record<"description" | "about", RfbRetroScanCauseClass>>;
}

interface RfbRetroScanCoreResult {
  dry_run: boolean;
  scanned: number;
  offset: number;
  total_eligible: number;
  by_field: Record<"description" | "about", { flagged: number; nulled: number }>;
  by_cause_class: Record<RfbRetroScanCauseClass, number>;
  changed: RfbRetroScanChangedEntry[];
  skipped_locked: string[];
  skipped_curated: Array<{ agent_id: string; fields: string[] }>;
  errors: Array<{ agent_id: string; error: string }>;
}

/**
 * The retro-scan's actual scan/judge/(maybe-)null loop, factored out of the
 * POST /retro-scan handler below so GET /tynne-profiler-cohort (dev-request
 * 2026-08-15-tynne-profiler-forbedringsloype, Slice 1) can call into the
 * SAME cohort logic — same judge cascade, same claimed_at row-lock, same
 * curated_fields field-lock — rather than duplicating it. Behavior is
 * unchanged from before this extraction; POST /retro-scan below is now a
 * thin request-parsing wrapper around this function.
 */
async function runRfbRetroScanCore(
  db: ReturnType<typeof getDb>,
  params: { limit: number; offset: number; agentIds?: unknown; apply: boolean },
): Promise<RfbRetroScanCoreResult> {
  const { limit, offset, agentIds, apply } = params;
  const dryRun = !apply;

  let targets: RfbRetroScanTarget[];
  if (Array.isArray(agentIds) && agentIds.length > 0) {
    const ids = (agentIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, limit);
    targets = ids
      .map((id) => getRfbAgentRetroScanTarget(db, id))
      .filter((t): t is RfbRetroScanTarget => t !== null);
  } else {
    targets = selectRfbAgentsForRetroScan(db, limit, offset);
  }

  const totalEligible = countRfbRetroScanEligible(db);

  let scanned = 0;
  const byField: Record<"description" | "about", { flagged: number; nulled: number }> = {
    description: { flagged: 0, nulled: 0 },
    about: { flagged: 0, nulled: 0 },
  };
  // Per-cause-class flagged counts (kriterium 7, acceptance (a)): proves by
  // construction, not by assertion, that nothing is ever flagged on length
  // alone without an LLM verdict — "too_short" simply never appears as a key
  // here, since rfbRetroScanShouldNull no longer produces that cause class.
  const byCauseClass: Record<RfbRetroScanCauseClass, number> = {
    deterministic_mangled: 0,
    deterministic_boilerplate: 0,
    deterministic_foreign: 0,
    llm_rejected: 0,
  };
  const changed: RfbRetroScanChangedEntry[] = [];
  const skippedLocked: string[] = [];
  const skippedCurated: Array<{ agent_id: string; fields: string[] }> = [];
  const errors: Array<{ agent_id: string; error: string }> = [];

  async function processOne(t: RfbRetroScanTarget): Promise<void> {
    // LOCK check — from the target's own row snapshot, so a claimed agent
    // never reaches the judge at all (same discipline as gårdssalg's
    // retro-scan's pre-fetch snapshot check).
    if (t.claimed_at) {
      skippedLocked.push(t.agent_id);
      return;
    }
    scanned++;

    try {
      const [descVerdict, aboutVerdict] = await Promise.all([
        rfbRetroScanShouldNull(t.description, t.name, "description"),
        rfbRetroScanShouldNull(t.about, t.name, "about"),
      ]);

      const wouldNullFields: Array<"description" | "about"> = [];
      const reasons: Record<string, string> = {};
      const causeClasses: Partial<Record<"description" | "about", RfbRetroScanCauseClass>> = {};
      if (descVerdict.shouldNull) {
        wouldNullFields.push("description");
        reasons.description = descVerdict.reason!;
        causeClasses.description = descVerdict.causeClass!;
      }
      if (aboutVerdict.shouldNull) {
        wouldNullFields.push("about");
        reasons.about = aboutVerdict.reason!;
        causeClasses.about = aboutVerdict.causeClass!;
      }
      if (wouldNullFields.length === 0) return;

      // Per-field curated lock — an absolute refusal, same as every other
      // RFB write path (see this section's header comment). A curated field
      // is never even reported as "would null" — it is fully out of scope,
      // the same way locked ROWS never reach this point at all.
      const curatedFields = wouldNullFields.filter((f) => isRfbFieldCurated(t.curated_fields, f));
      const nonCuratedFields = wouldNullFields.filter((f) => !isRfbFieldCurated(t.curated_fields, f));
      if (curatedFields.length > 0) {
        skippedCurated.push({ agent_id: t.agent_id, fields: curatedFields });
      }
      if (nonCuratedFields.length === 0) return;

      for (const f of nonCuratedFields) {
        byField[f].flagged += 1;
        byCauseClass[causeClasses[f]!] += 1;
      }

      if (dryRun) {
        changed.push({ agent_id: t.agent_id, name: t.name, fields: nonCuratedFields, reasons, cause_classes: causeClasses });
        return;
      }

      const written = applyRfbRetroScanNull(db, t.agent_id, nonCuratedFields, reasons);
      if (written.length > 0) {
        for (const f of written) byField[f as "description" | "about"].nulled += 1;
        changed.push({ agent_id: t.agent_id, name: t.name, fields: written, reasons, cause_classes: causeClasses });
      }
    } catch (e: any) {
      errors.push({ agent_id: t.agent_id, error: e?.message ?? String(e) });
    }
  }

  for (let i = 0; i < targets.length; i += RFB_RETRO_SCAN_CONCURRENCY) {
    const slice = targets.slice(i, i + RFB_RETRO_SCAN_CONCURRENCY);
    await Promise.all(slice.map((t) => processOne(t)));
  }

  return {
    dry_run: dryRun,
    scanned,
    offset,
    total_eligible: totalEligible,
    by_field: byField,
    by_cause_class: byCauseClass,
    changed,
    skipped_locked: skippedLocked,
    skipped_curated: skippedCurated,
    errors,
  };
}

router.post("/retro-scan", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown; offset?: unknown; apply?: unknown };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : RFB_RETRO_SCAN_DEFAULT_LIMIT,
    RFB_RETRO_SCAN_MAX_LIMIT,
  );

  // offset: default 0 — reproduces today's exact behavior for any caller
  // that doesn't pass it. Only meaningful for the auto-select path (the
  // explicit agentIds override below ignores it entirely, same as today),
  // but is parsed/validated up front, same shape as GET /admin/agents's own
  // limit/offset validation above ({error, detail}, 400 on invalid).
  const rawOffset = body.offset !== undefined ? body.offset : req.query?.offset;
  const parsedOffset = parseRfbRetroScanOffset(rawOffset);
  if ("error" in parsedOffset) {
    res.status(400).json(parsedOffset);
    return;
  }
  const offset = parsedOffset.offset;

  // apply=true + offset>0 is unsound: rfbRetroScanAutoSelectSql()'s WHERE
  // clause depends on the LIVE value of description/about, and apply mode
  // nulls exactly those columns. A row nulled on an earlier page drops out
  // of the eligible set and shifts every later row's position, so a caller
  // paging with fixed offsets across sequential apply:true calls would
  // silently skip rows at page boundaries. Offset pagination is only safe
  // for dry-run scans (the actual discovery use case); apply:true with
  // offset omitted/0 — a normal small-batch write — is unaffected.
  if (apply && offset > 0) {
    res.status(400).json({
      error: "invalid offset",
      detail:
        "offset pagination is only safe for dry-run scans — apply mode may not be combined with a nonzero offset, since applying nulls shifts row positions and can silently skip rows on later pages",
    });
    return;
  }

  const result = await runRfbRetroScanCore(db, { limit, offset, agentIds: body.agentIds, apply });
  res.json(result);
});

// ─── dev-request 2026-08-15-tynne-profiler-forbedringsloype (Slice 1) ──────
// GET /admin/agents/tynne-profiler-cohort + GET /admin/agents/tynne-profiler-
// queue + the agents_tynne_profiler_queue bookkeeping table (see
// src/database/init.ts for the CREATE TABLE).
//
// Daniel's wish (dev-requests/2026-08-15-tynne-profiler-forbedringsloype.md):
// profiles the RECALIBRATED judge still flags should be actively IMPROVED,
// not just re-classified or nulled. Slice 1 is the read-only half only:
// cohort-read (AC1) + the SAME lock/curated-skip filters retro-scan already
// applies (AC1's "samme lås-regler som retroskannet") + `no_source`
// residual-queue bookkeeping (half of AC4). Slice 2 (source-fetch + LLM
// generation + judge-gate + audit-write) and Slice 3 (quality-sample report)
// are explicitly NOT built here — see that dev-request's "Implementer-spec"
// section for the full 3-slice split.
//
// NO writes to `agents`/`agent_knowledge` content columns happen anywhere in
// this section, and no LLM generation call is made — the only LLM call
// reachable from here is the SAME existing judge call runRfbRetroScanCore
// already makes (via rfbRetroScanShouldNull -> judgeRfbAboutCandidate) to
// determine which rows are still flagged; that is reused, not duplicated,
// and is always invoked here with apply:false (dry-run only — this route
// does not accept an apply param at all).

/** AC1's own ordering: "prioritert: flagget-begge-felt først, deretter
 * description-only". Both-fields-flagged outranks description-only, which
 * outranks about-only. `about_only` is this slice's own addition for
 * completeness — the dev-request text names only the first two tiers
 * explicitly, so this ordering choice is worth the reviewer's eyes if a
 * different tie-break for about-only rows was actually intended. */
type TynneProfilerPriorityTier = "both_fields" | "description_only" | "about_only";

const TYNNE_PROFILER_PRIORITY_RANK: Record<TynneProfilerPriorityTier, number> = {
  both_fields: 0,
  description_only: 1,
  about_only: 2,
};

function tynneProfilerPriorityTier(fields: string[]): TynneProfilerPriorityTier {
  const hasDescription = fields.includes("description");
  const hasAbout = fields.includes("about");
  if (hasDescription && hasAbout) return "both_fields";
  if (hasDescription) return "description_only";
  return "about_only";
}

interface AgentTynneProfilerQueueEntry {
  agent_id: string;
  agent_name?: string | null;
  flagged_fields: string[];
  priority_tier: TynneProfilerPriorityTier;
  cause: string;
  cause_classes?: Partial<Record<"description" | "about", RfbRetroScanCauseClass>> | null;
  reasons?: Record<string, string> | null;
}

/**
 * Upsert-on-agent_id ("refresh, don't pile up") — mirrors
 * upsertAgentOrgNrReviewQueue's exact idiom above. A re-run of the cohort
 * read updates an already-queued row's snapshot in place (new reasons/cause
 * classes/priority, `status` reset to 'pending', `last_seen_at` bumped)
 * rather than accumulating a duplicate row for the same agent.
 */
function upsertAgentTynneProfilerQueue(db: ReturnType<typeof getDb>, entry: AgentTynneProfilerQueueEntry): void {
  db.prepare(
    `INSERT INTO agents_tynne_profiler_queue
       (id, agent_id, agent_name, flagged_fields, priority_tier, cause, cause_classes, reasons,
        status, first_seen_at, last_seen_at)
     VALUES (@id, @agent_id, @agent_name, @flagged_fields, @priority_tier, @cause, @cause_classes, @reasons,
             'pending', datetime('now'), datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       flagged_fields = excluded.flagged_fields,
       priority_tier = excluded.priority_tier,
       cause = excluded.cause,
       cause_classes = excluded.cause_classes,
       reasons = excluded.reasons,
       status = 'pending',
       last_seen_at = datetime('now')`,
  ).run({
    id: uuid(),
    agent_id: entry.agent_id,
    agent_name: entry.agent_name ?? null,
    flagged_fields: JSON.stringify(entry.flagged_fields),
    priority_tier: entry.priority_tier,
    cause: entry.cause,
    cause_classes: entry.cause_classes ? JSON.stringify(entry.cause_classes) : null,
    reasons: entry.reasons ? JSON.stringify(entry.reasons) : null,
  });
}

interface AgentTynneProfilerQueueRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  flagged_fields: string[];
  priority_tier: TynneProfilerPriorityTier;
  cause: string;
  cause_classes: Partial<Record<"description" | "about", RfbRetroScanCauseClass>> | null;
  reasons: Record<string, string> | null;
  status: "pending" | "resolved";
  first_seen_at: string;
  last_seen_at: string;
}

/** Defensive JSON parse — malformed/missing JSON becomes the given fallback
 * rather than throwing, same convention as isRfbFieldCurated above. */
function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Read-only listing of the persisted queue, pending rows only, ordered by
 * AC1's own priority (both_fields first) then oldest-flagged-first within a
 * tier — mirrors listAgentOrgNrReviewQueue's read-only-listing shape above. */
function listAgentTynneProfilerQueue(
  db: ReturnType<typeof getDb>,
): AgentTynneProfilerQueueRow[] {
  const rows = db
    .prepare(
      `SELECT id, agent_id, agent_name, flagged_fields, priority_tier, cause, cause_classes, reasons,
              status, first_seen_at, last_seen_at
         FROM agents_tynne_profiler_queue
        WHERE status = 'pending'
        ORDER BY CASE priority_tier
                   WHEN 'both_fields' THEN 0
                   WHEN 'description_only' THEN 1
                   ELSE 2
                 END ASC,
                 first_seen_at ASC`,
    )
    .all() as Array<{
      id: string; agent_id: string; agent_name: string | null; flagged_fields: string;
      priority_tier: TynneProfilerPriorityTier; cause: string; cause_classes: string | null;
      reasons: string | null; status: "pending" | "resolved"; first_seen_at: string; last_seen_at: string;
    }>;
  return rows.map((r) => ({
    ...r,
    flagged_fields: parseJsonColumn<string[]>(r.flagged_fields, []),
    cause_classes: parseJsonColumn<Partial<Record<"description" | "about", RfbRetroScanCauseClass>> | null>(r.cause_classes, null),
    reasons: parseJsonColumn<Record<string, string> | null>(r.reasons, null),
  }));
}

// ─── GET /admin/agents/tynne-profiler-cohort ────────────────────────────────
// Read-only cohort report: calls runRfbRetroScanCore (the EXISTING
// retro-scan cascade — same judge, same claimed_at/curated_fields skip
// logic) forced to dry-run, classifies each flagged row into a priority
// tier, and records every one of them into agents_tynne_profiler_queue with
// cause:'no_source' (AC4's residual-queue bookkeeping — Slice 2 does not
// exist yet, so no source-fetch has actually been attempted for any row;
// this is bookkeeping structure only, not a claim that a source genuinely
// doesn't exist). Locked rows (skipped_locked) and curated-locked fields
// (skipped_curated) never reach the queue at all — the exact same "never
// even reported as a candidate" discipline retro-scan itself uses.
router.get("/tynne-profiler-cohort", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();

  const rawLimit = req.query?.limit;
  const parsedLimit =
    typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? parseInt(rawLimit, 10) : undefined;
  const limit = Math.min(
    parsedLimit && parsedLimit > 0 ? parsedLimit : RFB_RETRO_SCAN_DEFAULT_LIMIT,
    RFB_RETRO_SCAN_MAX_LIMIT,
  );

  const parsedOffset = parseRfbRetroScanOffset(req.query?.offset);
  if ("error" in parsedOffset) {
    res.status(400).json(parsedOffset);
    return;
  }

  let agentIds: string[] | undefined;
  const rawAgentIds = req.query?.agentIds;
  if (typeof rawAgentIds === "string" && rawAgentIds.trim().length > 0) {
    agentIds = rawAgentIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  const scan = await runRfbRetroScanCore(db, { limit, offset: parsedOffset.offset, agentIds, apply: false });

  const byPriorityTier: Record<TynneProfilerPriorityTier, number> = {
    both_fields: 0,
    description_only: 0,
    about_only: 0,
  };

  const cohort = scan.changed
    .map((c) => {
      const tier = tynneProfilerPriorityTier(c.fields);
      byPriorityTier[tier] += 1;
      return {
        agent_id: c.agent_id,
        name: c.name,
        fields: c.fields,
        priority_tier: tier,
        reasons: c.reasons,
        cause_classes: c.cause_classes,
      };
    })
    .sort((a, b) => TYNNE_PROFILER_PRIORITY_RANK[a.priority_tier] - TYNNE_PROFILER_PRIORITY_RANK[b.priority_tier]);

  // Bookkeeping write — the ONLY write this endpoint makes, and it is to
  // agents_tynne_profiler_queue only, never to `agents`/`agent_knowledge`.
  for (const row of cohort) {
    upsertAgentTynneProfilerQueue(db, {
      agent_id: row.agent_id,
      agent_name: row.name,
      flagged_fields: row.fields,
      priority_tier: row.priority_tier,
      cause: "no_source",
      cause_classes: row.cause_classes,
      reasons: row.reasons,
    });
  }

  res.json({
    dry_run: true,
    scanned: scan.scanned,
    offset: scan.offset,
    total_eligible: scan.total_eligible,
    cohort_count: cohort.length,
    by_priority_tier: byPriorityTier,
    by_cause_class: scan.by_cause_class,
    cohort,
    skipped_locked: scan.skipped_locked,
    skipped_curated: scan.skipped_curated,
    errors: scan.errors,
    queue_recorded: cohort.length,
  });
});

// ─── GET /admin/agents/tynne-profiler-queue ─────────────────────────────────
// Read-only listing of the durable queue the cohort route above writes to —
// the counterpart to GET /org-nr-review-queue above. Lets a caller (e.g. the
// daily-brief routine, a future Slice 2/3) see the current pending backlog
// without re-running the (LLM-calling) cohort scan.
router.get("/tynne-profiler-queue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const entries = listAgentTynneProfilerQueue(db);
  res.json({ count: entries.length, entries });
});

// ─── dev-request 2026-08-15-tynne-profiler-forbedringsloype (Slice 2) ──────
// POST /admin/agents/tynne-profiler-improve
//
// Daniel's wish, the ACTIVE half: profiles the recalibrated judge still
// flags should be actively IMPROVED, not just re-classified (Slice 1) or
// nulled (POST /retro-scan). For each pending agents_tynne_profiler_queue
// row: fetch the producer's own verified website (source), GENERATE new
// Norwegian description/about text grounded ONLY in that source (a NEW LLM
// call, separate from the judge), gate the candidate through the EXISTING
// judgeRfbAboutCandidate cascade, and — apply mode only — write it through
// the SAME row-lock / curated-field-lock / field_provenance-merge / audit
// discipline every other RFB write path in this file already uses.
//
// CORRECTION vs this slice's own build brief: the verified website column is
// `agent_knowledge.website` (written ONLY by POST /admin/rfb-website-review-
// approve, gated on evaluateRfbWebsiteCandidate's evidence match — see that
// route's own header comment), NOT `agents.website` (no such column exists —
// verified directly against src/database/init.ts's CREATE TABLE agents
// block). The rest of that provenance reasoning (a non-blank website is
// already ownership-verified, so this route does not re-verify ownership,
// only defensively excludes aggregator/directory hosts) is unchanged.
//
// Never-fabricate contract (the highest-fabrication-risk part of this whole
// dev-request — see generateTynneProfilerCandidate below): the generator is
// prompted to assert ONLY facts present in the fetched source text (plus a
// small set of already-separately-verified structured facts — address/
// postal_code from agent_knowledge, see that function's own doc comment),
// with an explicit escape sentinel for "not enough material" and a fail-
// closed null on ANY doubt (missing key / network / non-200 / bad JSON /
// unexpected shape / the sentinel). The candidate's actual FITNESS to
// publish is never trusted to the generator or to this route's own code —
// it must first clear classifyAboutCheapBar's deterministic prefilter
// (mangled Unicode / boilerplate / non-Norwegian — see the cheap-bar call in
// processTynneProfilerRow, Step 3, mirroring rfbRetroScanShouldNull's own
// ordering), and only then the existing judgeRfbAboutCandidate cascade,
// exactly like every other write path in this file. IMPORTANT CAVEAT this
// comment previously overstated: the judge is never passed the source text,
// so it cannot and does not verify factual grounding against it — it only
// judges the candidate in isolation for coherence, genericness, and
// nav/boilerplate leakage (plus, as a soft instruction rather than a
// deterministic check, "ekte norsk prosa"). The actual "no fabrication"
// guarantee rests entirely on the GENERATION prompt's own instruction-
// following (see generateTynneProfilerCandidate below), not on any
// downstream re-check against the source — nothing in this route's
// pipeline re-verifies a candidate's claims against the fetched page text.
// This is inherited unchanged from the gårdssalg precedent's identical
// architecture (generateGardssalgAboutFromSource + meetsGardssalgAbout-
// QualityBar, routes/opplevelser.ts), not a new gap introduced here.
//
// Fields NOT re-verified here (deliberately, matching the write path this
// mirrors): a non-blank agent_knowledge.website is treated as already
// ownership-verified per the header comment above — this route does not
// re-run evaluateRfbWebsiteCandidate.

/** Per-field terminal/attempt state for ONE flagged field on ONE queue row.
 * "approved" (dry-run) becomes "written" or "write_lock_race" once apply
 * mode's write-time re-check has run — see processTynneProfilerRow below. */
type TynneProfilerFieldOutcome =
  | "written"
  | "approved" // dry-run only: judge approved, would be written under apply
  | "curated_locked"
  | "no_source"
  | "source_aggregator_host"
  | "source_fetch_failed"
  | "generation_failed"
  | "generation_failed_cheap_bar" // candidate generated, but classifyAboutCheapBar rejected it (mangled/boilerplate/foreign) BEFORE the judge ever saw it — see the cheap-bar prefilter call in processTynneProfilerRow below
  | "judge_rejected"
  | "judge_infra_failure"
  | "write_lock_race"; // approved, but the immediate-before-write re-check found the row/field newly locked

interface TynneProfilerFieldAttempt {
  field: "description" | "about";
  outcome: TynneProfilerFieldOutcome;
  text?: string; // present only for "approved"/"written"
  reasoning?: string; // judge reasoning, when a judge call happened
}

/** Priority order (most-blocking first) used to pick ONE representative
 * `cause` string for a queue row when more than one still-unresolved field
 * failed for different reasons. Roughly "how far the pipeline got": no
 * source at all outranks a locked field, which outranks a genuine judge
 * rejection (the pipeline ran furthest for that one). Documented here per
 * this slice's own build brief ("pick clear new cause strings and document
 * them in a comment") — these are ADDITIVE new cause values, never
 * colliding with Slice 1's 'no_source' or POST /retro-scan's
 * RfbRetroScanCauseClass values (a different column's vocabulary entirely). */
const TYNNE_PROFILER_ROW_CAUSE_PRIORITY: readonly TynneProfilerFieldOutcome[] = [
  "no_source",
  "source_aggregator_host",
  "source_fetch_failed",
  "curated_locked",
  "write_lock_race",
  "judge_infra_failure",
  "generation_failed",
  "generation_failed_cheap_bar",
  "judge_rejected",
];

function pickTynneProfilerRowCause(outcomes: TynneProfilerFieldOutcome[]): string {
  for (const c of TYNNE_PROFILER_ROW_CAUSE_PRIORITY) {
    if (outcomes.includes(c)) return c;
  }
  return outcomes[0] ?? "no_source"; // defensive — every real outcome above is covered
}

interface TynneProfilerAgentSnapshot {
  agent_id: string;
  name: string;
  claimed_at: string | null;
  description: string;
  about: string | null;
  curated_fields: string | null;
  field_provenance: string | null;
  website: string | null;
  address: string | null;
  postal_code: string | null;
}

/** Fresh per-agent read — used both for the initial per-row attempt AND
 * (separately, inside applyTynneProfilerFieldWrites' own transaction) for
 * the immediate-before-write re-check. Never cached across the async
 * generation/judge calls this route makes, so a row claimed or curated
 * mid-flight is always caught. */
function getTynneProfilerAgentSnapshot(
  db: ReturnType<typeof getDb>,
  agentId: string,
): TynneProfilerAgentSnapshot | undefined {
  return db
    .prepare(
      `SELECT a.id AS agent_id, a.name AS name, a.claimed_at AS claimed_at,
              a.description AS description, k.about AS about,
              k.curated_fields AS curated_fields, k.field_provenance AS field_provenance,
              k.website AS website, k.address AS address, k.postal_code AS postal_code
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(agentId) as TynneProfilerAgentSnapshot | undefined;
}

// ─── generateTynneProfilerCandidate — the generation LLM call ──────────────
// Mirrors gårdssalg's own source-grounded generation precedent
// (generateGardssalgAboutFromSource, routes/opplevelser.ts) EXACTLY: sync
// fetch to https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from
// env, model claude-haiku-4-5 (same model the judge above and gårdssalg's
// own generator use). Returns null — NEVER throws, NEVER fabricates — on
// missing key / network failure / non-200 / unparseable body / the escape
// sentinel / residual markdown / an empty result.
//
// Grounding: the prompt passes ONLY (a) the already-fetched, already-
// extracted visible page text (pageText — buildPageEvidence's contentText,
// capped like gårdssalg's own generator) and (b) a SMALL set of already-
// separately-verified structured facts (agent_knowledge.address/
// postal_code — written by OTHER, already-gated RFB write paths, not fresh
// unverified claims) as optional supplementary context, explicitly labelled
// as facts the model may use "where relevant" but must not invent beyond.
// This (b) half is this function's own deliberate design choice beyond the
// gårdssalg precedent (which passes only pageText+navn) — worth a
// reviewer's specific attention: it slightly widens what counts as
// "grounded" beyond the crawled text, on the argument that these fields are
// independently verified elsewhere in this codebase's own write paths, not
// asserted fresh by this generator. If that argument doesn't hold up on
// review, dropping the cachedFacts param entirely (source text only) is a
// one-line-call-site change.
//
// Daniel's own wording, carried into the prompt near-verbatim: "de særegne
// egenskapene" — produkter, sted, driftsform, historie, utmerkelser.
// Målform: instructed to match whatever the SOURCE text itself uses
// (bokmål vs nynorsk) — the "Avdem-presedensen" this dev-request cites
// (Avdem Gardsysteri's 2026-07-25 manual fix matched the producer's own
// nynorsk voice).
const TYNNE_PROFILER_GEN_SENTINEL = "INGEN_FORBEDRING_MULIG";
const TYNNE_PROFILER_SOURCE_CHAR_CAP = 6000;
// Defensive outer ceiling on the WRITTEN value — generous relative to the
// ~100–500 char prompt targets below (never expected to trip in practice),
// mirrors marketplace.ts's own PATCH /agents/:id description length cap
// (2000) so a runaway generation can never write something wildly outside
// what every other write path on this column already tolerates.
const TYNNE_PROFILER_GEN_MAX_LEN = 2000;

// Same markdown-artifact strip + residual-check discipline as gårdssalg's
// generateGardssalgAboutRewrite/generateGardssalgAboutFromSource (routes/
// opplevelser.ts) — kept as a local copy rather than a cross-file import
// (that helper isn't exported, and RFB's about/description template is its
// own rendering surface, same "kept local" precedent this file's retro-scan
// section already documents for its own cheap-bar split).
const TYNNE_PROFILER_RESIDUAL_MARKDOWN = /[*#`_\\[\]>~|]/;
function stripTynneProfilerMarkdownArtifacts(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^\s*>\s+/gm, "")
    .replace(/^[=\-_]{3,}\s*$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

export async function generateTynneProfilerCandidate(
  pageText: string,
  producerName: string,
  kind: "description" | "about",
  cachedFacts?: { address?: string | null; postalCode?: string | null },
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cappedSource = (pageText || "").slice(0, TYNNE_PROFILER_SOURCE_CHAR_CAP);
  const sectionLabel = kind === "description" ? "kort produsentbeskrivelse" : "utfyllende «Om produsenten»-tekst";
  const lenHint = kind === "description" ? "100–300" : "200–500";

  const factParts: string[] = [];
  if (cachedFacts?.address && cachedFacts.address.trim()) factParts.push(`Adresse: ${cachedFacts.address.trim()}`);
  if (cachedFacts?.postalCode && cachedFacts.postalCode.trim()) factParts.push(`Postnummer: ${cachedFacts.postalCode.trim()}`);
  const factsBlock =
    factParts.length > 0
      ? `\nKjente, allerede bekreftede fakta om produsenten (kan brukes der relevant, men ikke finn på mer enn dette):\n${factParts.join(", ")}\n`
      : "";

  const prompt = `Skriv en ${sectionLabel} på norsk for produsenten "${producerName}", på ca. ${lenHint} tegn. Fremhev nettopp DENNE produsentens særegne egenskaper — produkter, sted, driftsform, historie, utmerkelser — der kilden faktisk nevner slikt.
${factsBlock}
Kildetekst (hentet fra produsentens egen nettside):
${cappedSource}

Bruk KUN fakta som faktisk fremgår av kildeteksten over${factParts.length > 0 ? " (og de kjente faktaene ovenfor, der relevant)" : ""}. Ikke finn på detaljer, produkter, tall, historie eller utmerkelser som ikke er nevnt. Skriv på samme målform (bokmål eller nynorsk) som kildeteksten selv bruker. Svar i ren løpende tekst uten markdown-formatering — ingen stjerner, overskrifter, punktlister eller linjeskift. Hvis kildeteksten ikke gir nok materiale til en genuin, faktabasert tekst om nettopp denne produsentens særpreg, svar med nøyaktig ${TYNNE_PROFILER_GEN_SENTINEL} og ingenting annet.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network/fetch failure — never fabricate
  }

  if (!response.ok) return null;

  let result: any;
  try {
    result = await response.json();
  } catch {
    return null; // unparseable JSON body — never fabricate
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  if (cleaned === TYNNE_PROFILER_GEN_SENTINEL) return null; // explicit "not enough material" escape

  const plain = stripTynneProfilerMarkdownArtifacts(cleaned);
  if (!plain) return null;
  if (plain.includes(TYNNE_PROFILER_GEN_SENTINEL)) return null; // sentinel embedded/wrapped rather than verbatim
  if (TYNNE_PROFILER_RESIDUAL_MARKDOWN.test(plain)) return null; // unpaired markdown residue after stripping
  if (plain.length > TYNNE_PROFILER_GEN_MAX_LEN) return null; // defensive outer ceiling, see constant's doc comment

  return plain;
}

// ─── applyTynneProfilerFieldWrites — the actual write, apply mode only ────
// Mirrors applyRfbRetroScanNull's exact discipline (this same file, above):
// re-reads claimed_at + curated_fields from a FRESH row snapshot INSIDE the
// transaction (never trusts the caller's earlier snapshot — a row could
// have been claimed, or a field curated-locked, between the judge call and
// this write), writes description/about + merges field_provenance (via the
// SAME mergeFieldProvenance every other write path in this file uses,
// preserving other fields' existing entries) + inserts one
// agent_knowledge_audit row per field actually written
// (changed_by:'system', notes carries the judge's approval reasoning + the
// source URL).
interface TynneProfilerFieldWriteRequest {
  field: "description" | "about";
  text: string;
  sourceUrl: string;
  reasoning: string;
}

interface TynneProfilerWriteResult {
  writtenFields: Array<"description" | "about">;
  raceLockedFields: Array<"description" | "about">;
}

function applyTynneProfilerFieldWrites(
  db: ReturnType<typeof getDb>,
  agentId: string,
  approved: TynneProfilerFieldWriteRequest[],
): TynneProfilerWriteResult {
  if (approved.length === 0) return { writtenFields: [], raceLockedFields: [] };

  let result: TynneProfilerWriteResult = { writtenFields: [], raceLockedFields: [] };

  const tx = db.transaction((): void => {
    const fresh = db
      .prepare(
        `SELECT a.claimed_at AS claimed_at, a.description AS description,
                k.about AS about, k.curated_fields AS curated_fields,
                k.field_provenance AS field_provenance
           FROM agents a
           LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(agentId) as
      | { claimed_at: string | null; description: string; about: string | null; curated_fields: string | null; field_provenance: string | null }
      | undefined;

    // Agent vanished or was claimed since selection — never write. Every
    // requested field reports as a lock-race, same as the per-field curated
    // case below (row-level lock is an absolute refusal for the WHOLE row).
    if (!fresh || fresh.claimed_at) {
      result = { writtenFields: [], raceLockedFields: approved.map((a) => a.field) };
      return;
    }

    const nowIso = new Date().toISOString();
    const written: Array<"description" | "about"> = [];
    const raceLocked: Array<"description" | "about"> = [];
    const auditRows: Array<{ field_name: string; old_value: string | null; new_value: string; notes: string }> = [];
    const provenanceIncoming: Record<
      string,
      { sources: Array<{ source_type: string; value: string; source_url: string; fetched_at: string }> }
    > = {};

    for (const req of approved) {
      if (isRfbFieldCurated(fresh.curated_fields, req.field)) {
        raceLocked.push(req.field); // locked between judge call and this write
        continue;
      }
      const oldValue = req.field === "description" ? fresh.description : fresh.about;
      if (req.field === "description") {
        db.prepare(`UPDATE agents SET description = ? WHERE id = ?`).run(req.text, agentId);
      } else {
        const exists = db.prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        if (!exists) {
          db.prepare("INSERT INTO agent_knowledge (agent_id, about, updated_at) VALUES (?, ?, ?)").run(
            agentId,
            req.text,
            nowIso,
          );
        } else {
          db.prepare("UPDATE agent_knowledge SET about = ?, updated_at = ? WHERE agent_id = ?").run(
            req.text,
            nowIso,
            agentId,
          );
        }
      }
      written.push(req.field);
      auditRows.push({
        field_name: req.field,
        old_value: oldValue,
        new_value: req.text,
        notes: `tynne_profiler_slice2: godkjent av dommer ("${req.reasoning}") — kilde: ${req.sourceUrl}`,
      });
      provenanceIncoming[req.field] = {
        sources: [{ source_type: "homepage", value: req.text, source_url: req.sourceUrl, fetched_at: nowIso }],
      };
    }

    if (written.length > 0) {
      // field_provenance merge — read-modify-write via the SAME shared
      // helper every other write path uses; preserves entries for fields
      // NOT touched by this write (e.g. website, phone, address).
      let existingProv: Record<string, unknown> = {};
      if (fresh.field_provenance) {
        try {
          const parsed = JSON.parse(fresh.field_provenance);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingProv = parsed;
        } catch {
          /* malformed existing JSON -> treat as empty rather than clobber the write */
        }
      }
      const merged = mergeFieldProvenance(existingProv, provenanceIncoming);

      const existsRow = db.prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?").get(agentId);
      if (!existsRow) {
        db.prepare("INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, ?, ?)").run(
          agentId,
          JSON.stringify(merged),
          nowIso,
        );
      } else {
        db.prepare("UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?").run(
          JSON.stringify(merged),
          nowIso,
          agentId,
        );
      }

      const insertAudit = db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`,
      );
      for (const ar of auditRows) {
        insertAudit.run(uuid(), agentId, ar.field_name, ar.old_value, ar.new_value, nowIso, ar.notes);
      }
    }

    result = { writtenFields: written, raceLockedFields: raceLocked };
  });
  tx();

  return result;
}

// ─── queue-row update helper (apply mode only) ─────────────────────────────
// Plain UPDATE (not upsertAgentTynneProfilerQueue's upsert-on-agent_id — the
// row here is ALWAYS already-existing, sourced from the queue itself, so an
// upsert's INSERT branch would never fire and would just be dead code).
// Only ever called when the computed next state actually differs from the
// row's current state (tynneProfilerQueueStateEquals below) — keeps a
// no-op call (e.g. a still-no_source row where nothing changed) a genuine
// no-op, not a spurious last_seen_at bump.
function updateTynneProfilerQueueRow(
  db: ReturnType<typeof getDb>,
  agentId: string,
  next: { status: "pending" | "resolved"; cause: string; flagged_fields: string[]; priority_tier: TynneProfilerPriorityTier },
): void {
  db.prepare(
    `UPDATE agents_tynne_profiler_queue
        SET status = ?, cause = ?, flagged_fields = ?, priority_tier = ?, last_seen_at = datetime('now')
      WHERE agent_id = ?`,
  ).run(next.status, next.cause, JSON.stringify(next.flagged_fields), next.priority_tier, agentId);
}

function tynneProfilerQueueStateEquals(
  row: AgentTynneProfilerQueueRow,
  next: { status: string; cause: string; flagged_fields: string[]; priority_tier: string },
): boolean {
  return (
    row.status === next.status &&
    row.cause === next.cause &&
    row.priority_tier === next.priority_tier &&
    JSON.stringify(row.flagged_fields) === JSON.stringify(next.flagged_fields)
  );
}

interface TynneProfilerImproveRowResult {
  agent_id: string;
  name: string;
  outcome: "resolved" | "partial" | "unresolved" | "skipped_locked" | "error";
  website: string | null;
  cause: string | null;
  fields: Record<string, { outcome: TynneProfilerFieldOutcome; reasoning?: string; preview?: string }>;
}

// ─── processTynneProfilerRow — the per-row source-fetch/generate/judge/
//     (maybe-)write pipeline ───────────────────────────────────────────────
// Shared by BOTH dry-run and apply mode: fetch/generate/judge always run for
// real (a genuine preview, same "real judge calls, zero writes" contract as
// POST /retro-scan's own dry-run) — only the final write step (and the
// queue-row bookkeeping update) is apply-mode-only.
async function processTynneProfilerRow(
  db: ReturnType<typeof getDb>,
  queueRow: AgentTynneProfilerQueueRow,
  apply: boolean,
): Promise<TynneProfilerImproveRowResult> {
  const snapshot = getTynneProfilerAgentSnapshot(db, queueRow.agent_id);
  if (!snapshot) {
    // Agent vanished since the queue row was written (deleted, merged) —
    // the FK's ON DELETE CASCADE should have removed the queue row too, so
    // this is defensive-only; nothing to do, queue untouched.
    return { agent_id: queueRow.agent_id, name: queueRow.agent_name ?? "", outcome: "error", website: null, cause: null, fields: {} };
  }
  if (snapshot.claimed_at) {
    // Row-level lock — checked FIRST, before any fetch/generate/judge call,
    // same discipline as runRfbRetroScanCore's own processOne above. Queue
    // row is left completely untouched (an owner-claimed row is no longer
    // this route's business at all).
    return { agent_id: queueRow.agent_id, name: snapshot.name, outcome: "skipped_locked", website: snapshot.website, cause: null, fields: {} };
  }

  const flaggedFields = queueRow.flagged_fields as Array<"description" | "about">;
  const fieldResults: Record<string, TynneProfilerFieldAttempt> = {};

  // Per-field curated lock — excluded from generation entirely (never even
  // attempted), same "absolute refusal" every other RFB write path in this
  // file applies.
  const curatedFields = flaggedFields.filter((f) => isRfbFieldCurated(snapshot.curated_fields, f));
  for (const f of curatedFields) fieldResults[f] = { field: f, outcome: "curated_locked" };
  const remainingFields = flaggedFields.filter((f) => !curatedFields.includes(f));

  const website = (snapshot.website || "").trim();

  if (remainingFields.length > 0) {
    if (!website) {
      // No verified website on file at all -> no source. Leave the current
      // (already-flagged) content exactly as it is; AC4's residual-queue
      // bookkeeping (Slice 1's own default) already covers this cause.
      for (const f of remainingFields) fieldResults[f] = { field: f, outcome: "no_source" };
    } else {
      const host = hostFromUrlLike(website);
      if (host && isDirectoryOrAggregatorHost(host)) {
        // Defensive re-check (see this section's header comment): a
        // non-blank agent_knowledge.website is treated as already
        // ownership-verified, but an aggregator/directory host is never a
        // usable GENERATION source regardless — never fetched.
        for (const f of remainingFields) fieldResults[f] = { field: f, outcome: "source_aggregator_host" };
      } else {
        let evidence: PageEvidence | null = null;
        try {
          evidence = await buildPageEvidence(website);
        } catch {
          evidence = null; // never let a crawl exception escape this route — treat as no usable source
        }
        const contentText = (evidence?.contentText || "").trim();
        if (!evidence || contentText.length < TYNNE_PROFILER_MIN_SOURCE_TEXT_LEN) {
          // Fetch failed OR the page came back essentially empty — "no
          // usable source", never fabricated from nothing.
          for (const f of remainingFields) fieldResults[f] = { field: f, outcome: "source_fetch_failed" };
        } else {
          for (const f of remainingFields) {
            const candidate = await generateTynneProfilerCandidate(contentText, snapshot.name, f, {
              address: snapshot.address,
              postalCode: snapshot.postal_code,
            });
            if (!candidate) {
              fieldResults[f] = { field: f, outcome: "generation_failed" };
              continue;
            }
            // dev-request 2026-08-24-produsentbeskrivelser-skrapt-js-
            // opprydding: cheap deterministic code-artifact backstop, BEFORE
            // the classifyAboutCheapBar prefilter and the judge call below.
            // This write path is already gated (generation is LLM-produced
            // from page text that extractVisibleText/buildPageEvidence never
            // hands raw <script>/<style> markup to, and the result still
            // faces the judge below) — the root-cause defect this dev-
            // request fixes is PATCH /api/marketplace/agents/:id, a
            // DIFFERENT write path with no such gating, not this one. This
            // check is added here anyway per the byggspec's explicit ask, as
            // a free, cheap, defense-in-depth backstop: it costs one
            // deterministic regex pass and, when it fires, SAVES a judge/LLM
            // call rather than adding one, so there is no realistic
            // regression risk to weigh against adding it.
            if (looksLikeCodeArtifact(candidate)) {
              fieldResults[f] = {
                field: f,
                outcome: "generation_failed_cheap_bar",
                reasoning: "fails the cheap bar (code artifact)",
              };
              continue;
            }
            // Deterministic cheap-bar prefilter BEFORE the judge — same
            // ordering as rfbRetroScanShouldNull above (classifyAboutCheapBar
            // first, only escalate to the judge when the candidate isn't
            // mangled/boilerplate/foreign). The judge's "ekte norsk prosa"
            // instruction is a soft LLM judgment call, not a deterministic
            // gate, so a source page that isn't Norwegian (or that produced
            // Unicode-mangled/boilerplate-dominated text) must never reach a
            // producer's public profile on the judge's leniency alone.
            // "too_short" is deliberately NOT rejected here (same as
            // rfbRetroScanShouldNull): short is not evidence of WRONG, only
            // of incomplete, and generateTynneProfilerCandidate's own prompt
            // already targets a length range — a too-short candidate still
            // goes on to the judge, exactly like the retro-scan path.
            const cheapBarClass = classifyAboutCheapBar(candidate);
            if (cheapBarClass === "mangled" || cheapBarClass === "boilerplate" || cheapBarClass === "foreign") {
              fieldResults[f] = {
                field: f,
                outcome: "generation_failed_cheap_bar",
                reasoning: `fails the cheap bar (${cheapBarClass})`,
              };
              continue;
            }
            const verdict = await judgeRfbAboutCandidate(candidate, snapshot.name, f);
            if (isRfbJudgeInfraFailure(verdict)) {
              // Fail-closed, same direction as a fresh-candidate call site
              // (unlike retro-scan's null-vs-leave direction): infra doubt
              // never writes. Retryable — cause surfaces this distinctly
              // from a genuine reject so a future run knows to retry soon.
              fieldResults[f] = { field: f, outcome: "judge_infra_failure", reasoning: verdict.reasoning };
              continue;
            }
            if (!verdict.approved) {
              fieldResults[f] = { field: f, outcome: "judge_rejected", reasoning: verdict.reasoning };
              continue;
            }
            fieldResults[f] = { field: f, outcome: "approved", text: candidate, reasoning: verdict.reasoning };
          }
        }
      }
    }
  }

  if (apply) {
    const approvedReqs: TynneProfilerFieldWriteRequest[] = remainingFields
      .filter((f) => fieldResults[f]?.outcome === "approved")
      .map((f) => ({
        field: f,
        text: fieldResults[f].text as string,
        sourceUrl: website,
        reasoning: fieldResults[f].reasoning || "",
      }));
    if (approvedReqs.length > 0) {
      const writeResult = applyTynneProfilerFieldWrites(db, snapshot.agent_id, approvedReqs);
      for (const f of writeResult.writtenFields) fieldResults[f]!.outcome = "written";
      for (const f of writeResult.raceLockedFields) fieldResults[f]!.outcome = "write_lock_race";
    }
  }

  const stillFlagged = flaggedFields.filter((f) => fieldResults[f]?.outcome !== "written");
  let outcome: TynneProfilerImproveRowResult["outcome"];
  let cause: string | null;
  if (stillFlagged.length === 0) {
    outcome = "resolved";
    cause = "resolved";
  } else {
    outcome = stillFlagged.length < flaggedFields.length ? "partial" : "unresolved";
    cause = pickTynneProfilerRowCause(stillFlagged.map((f) => fieldResults[f]!.outcome));
  }

  if (apply) {
    const next =
      outcome === "resolved"
        ? { status: "resolved" as const, cause: "resolved", flagged_fields: [] as string[], priority_tier: queueRow.priority_tier }
        : {
            status: "pending" as const,
            cause: cause as string,
            flagged_fields: stillFlagged,
            priority_tier: tynneProfilerPriorityTier(stillFlagged),
          };
    if (!tynneProfilerQueueStateEquals(queueRow, next)) {
      updateTynneProfilerQueueRow(db, queueRow.agent_id, next);
    }
  }

  const fieldsOut: Record<string, { outcome: TynneProfilerFieldOutcome; reasoning?: string; preview?: string }> = {};
  for (const f of flaggedFields) {
    const fr = fieldResults[f];
    if (!fr) continue;
    fieldsOut[f] = { outcome: fr.outcome, reasoning: fr.reasoning, preview: fr.text ? fr.text.slice(0, 300) : undefined };
  }

  return { agent_id: snapshot.agent_id, name: snapshot.name, outcome, website: website || null, cause, fields: fieldsOut };
}

const TYNNE_PROFILER_MIN_SOURCE_TEXT_LEN = 40;
const TYNNE_PROFILER_IMPROVE_DEFAULT_LIMIT = 20;
const TYNNE_PROFILER_IMPROVE_MAX_LIMIT = 100;
// AC5's structural cap: apply mode may not touch more than this many rows in
// a single call without the caller explicitly opting in via
// confirm_large_batch:true. dry_run is never capped this way — see this
// section's header comment and the route handler below.
const TYNNE_PROFILER_IMPROVE_APPLY_MAX_BATCH = 20;
const TYNNE_PROFILER_IMPROVE_CONCURRENCY = 3;

function countPendingTynneProfilerQueue(db: ReturnType<typeof getDb>): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM agents_tynne_profiler_queue WHERE status = 'pending'`).get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** Select the page of pending queue rows this call will process — either an
 * explicit agentIds override (sliced to `limit`, same "explicit target list
 * still bounded by limit" convention runRfbRetroScanCore's own agentIds
 * override uses) or plain limit/offset pagination over the pending queue,
 * ordered by the SAME priority-tier-then-oldest ordering
 * listAgentTynneProfilerQueue already establishes. */
function selectTynneProfilerQueueRows(
  db: ReturnType<typeof getDb>,
  params: { limit: number; offset: number; agentIds?: string[] },
): AgentTynneProfilerQueueRow[] {
  const all = listAgentTynneProfilerQueue(db);
  if (params.agentIds && params.agentIds.length > 0) {
    const idSet = new Set(params.agentIds);
    return all.filter((r) => idSet.has(r.agent_id)).slice(0, params.limit);
  }
  return all.slice(params.offset, params.offset + params.limit);
}

router.post("/tynne-profiler-improve", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  const body = (req.body ?? {}) as {
    agentIds?: unknown;
    limit?: unknown;
    offset?: unknown;
    apply?: unknown;
    confirm_large_batch?: unknown;
  };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";

  const confirmLargeBatch =
    body.confirm_large_batch === true ||
    body.confirm_large_batch === 1 ||
    body.confirm_large_batch === "1" ||
    body.confirm_large_batch === "true";

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : TYNNE_PROFILER_IMPROVE_DEFAULT_LIMIT,
    TYNNE_PROFILER_IMPROVE_MAX_LIMIT,
  );

  // AC5 — structural refusal, checked BEFORE any selection/fetch/generation/
  // judge/write work happens (same "pure param validation, zero side
  // effects" idiom as POST /retro-scan's apply+offset>0 refusal above).
  // dry_run (apply omitted/false) is NEVER capped this way — safe to run
  // over the whole cohort, per this slice's own build brief.
  if (apply && limit > TYNNE_PROFILER_IMPROVE_APPLY_MAX_BATCH && !confirmLargeBatch) {
    res.status(400).json({
      error: "batch too large",
      detail: `apply mode is capped at ${TYNNE_PROFILER_IMPROVE_APPLY_MAX_BATCH} rows per call — pass confirm_large_batch:true to process more, or lower limit`,
    });
    return;
  }

  const parsedOffset = parseRfbRetroScanOffset(body.offset !== undefined ? body.offset : req.query?.offset);
  if ("error" in parsedOffset) {
    res.status(400).json(parsedOffset);
    return;
  }
  const offset = parsedOffset.offset;

  let agentIds: string[] | undefined;
  if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
    agentIds = (body.agentIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
  }

  const rows = selectTynneProfilerQueueRows(db, { limit, offset, agentIds });

  const results: TynneProfilerImproveRowResult[] = [];
  const byOutcome: Record<string, number> = { resolved: 0, partial: 0, unresolved: 0, skipped_locked: 0, error: 0 };

  async function processOne(row: AgentTynneProfilerQueueRow): Promise<void> {
    try {
      const r = await processTynneProfilerRow(db, row, apply);
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      results.push(r);
    } catch (e: any) {
      byOutcome.error += 1;
      results.push({
        agent_id: row.agent_id,
        name: row.agent_name ?? "",
        outcome: "error",
        website: null,
        cause: e?.message ?? String(e),
        fields: {},
      });
    }
  }

  for (let i = 0; i < rows.length; i += TYNNE_PROFILER_IMPROVE_CONCURRENCY) {
    const slice = rows.slice(i, i + TYNNE_PROFILER_IMPROVE_CONCURRENCY);
    await Promise.all(slice.map((r) => processOne(r)));
  }

  res.json({
    dry_run: !apply,
    processed: results.length,
    limit,
    offset,
    total_pending: countPendingTynneProfilerQueue(db),
    by_outcome: byOutcome,
    results,
  });
});

export default router;

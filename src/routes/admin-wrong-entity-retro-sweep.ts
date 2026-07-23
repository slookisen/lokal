// ─── Admin: GET /admin/wrong-entity-retro-sweep ─────────────────────────────
//
// dev-request 2026-07-16-wrong-entity-opprydding-rfb (slookisen/A2A) — the
// "retro-sveip over HELE basen" slice. Earlier slices of that dev-request
// manually cleaned up known cases of RFB (rettfrabonden.com) agent profiles
// contaminated with a DIFFERENT business's contact data (a wrong Google-
// Places/search match during enrichment — the Eidsmo-class incident
// documented in cross-source-validator.ts). This endpoint is the mechanical
// follow-up: a cheap, catalog-wide sweep for MORE candidates of the same
// contamination class, using only signals already sitting in the DB (no
// crawling, no external lookups).
//
// ── THIS IS A DETECTION TOOL, NOT A CORRECTION TOOL ─────────────────────────
// Read-only / report-only. There is no `apply` mode and this handler issues
// ZERO writes to any table — it only runs SELECTs. Unlike its sibling
// admin-domain-coherence.ts (which has a real apply:true write path), this
// endpoint exists purely to surface candidates for a human (or a future,
// separately-reviewed slice) to act on.
//
// Of the 4 heuristics named in the dev-request, only 2 are implemented here;
// the other 2 are deliberately skipped — see the `skipped_heuristics` array
// built below and the comments next to SKIPPED_HEURISTICS for why.
//
//   1. email_domain_mismatch  — BUILT. Reuses the existing, already-tested
//      domainCoherenceCheck (cross-source-validator.ts) by anchoring identity
//      to agent_knowledge.website instead of agents.url: calling
//      domainCoherenceCheck(website, website, email, opts) makes the
//      website-vs-website leg trivially agree and falls through to exactly
//      the email-vs-anchor-host check we want, for free inheriting:
//        - the FREE_MAIL_DOMAINS exclusion (gmail.com, hotmail.com, outlook.com,
//          icloud.com, yahoo.com, and the rest of that list) — personal mailbox
//          domains are never a mismatch signal, per the dev-request's own
//          instruction;
//        - the PLACEHOLDER_EMAIL_DOMAINS exclusion (info@domain.com-style
//          contact-form boilerplate is not a second entity's mailbox);
//        - the homepage-evidence rescue (hasHomepageEvidence) — an agent whose
//          field_provenance.email carries a source_type:"homepage" record
//          fetched from (a domain equivalent to) the website itself is NOT
//          flagged, which is exactly the dev-request's "no homepage-provenance
//          tying the two together" carve-out;
//        - domainsEquivalent's same-entity-variant handling (hyphenation,
//          IDN/punycode, Norwegian transliteration, cross-TLD same-brand) so
//          cosmetic domain variants are not miscounted as contamination.
//      This is the most defensible of the four heuristics (per the dev-
//      request's own ranking) and is built exactly as specified.
//
//   2. duplicate_opening_hours — BUILT. A single SELECT over agent_knowledge.
//      opening_hours, fingerprinted by exact (trimmed) string value; any
//      distinct non-empty value shared verbatim by 3+ different agents is
//      reported as a group. Cheap, mechanical, no guessing involved.
//
//   3. postalCode_vs_address — SKIPPED. Flagging a postnummer/address mismatch
//      requires a postnummer -> poststed (or postnummer -> fylke/kommune)
//      reference table to compare against. This repo has no such table for
//      the rfb/lokal vertical (searched src/database/init.ts and the
//      geocoding/Brreg service layer — nothing reusable). Fabricating a
//      Norwegian postnummer table from memory, as the dev-request explicitly
//      warns against, risks introducing the exact wrong-entity-shaped error
//      class this feature exists to catch. Left as an explicit follow-up that
//      needs real reference data (e.g. Posten's official postnummer register)
//      brought into the repo first.
//
//   4. retningsnummer_vs_fylke — SKIPPED. Norway's modern phone numbering plan
//      does not use true geographic area codes; any prefix-to-fylke mapping is
//      a fuzzy legacy convention with no reliable, verifiable source in this
//      repo. Building it from memory risks a high false-positive rate — i.e.
//      manufacturing the very "wrong-entity" false positives this tool exists
//      to catch. Left as an explicit non-goal for a future slice that has a
//      real, sourced phone-prefix-to-fylke reference.
//
// Scope: like admin-domain-coherence.ts, umbrella agents (agents.umbrella_type
// IS NOT NULL) are excluded — they aggregate multiple underlying members, so a
// single email/website/opening-hours comparison does not map onto one real
// business the way it does for a normal producer profile.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other admin
// route in this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  domainCoherenceCheck,
  hostFromUrlLike,
  registrableDomain,
  type ProvenanceRecord,
} from "../services/cross-source-validator";

// Parse field_provenance (may be a JSON string from SQLite, already an
// object, or null/missing) into the shape domainCoherenceCheck's opts expect
// — mirrors the identical helper in admin-domain-coherence.ts so both call
// sites treat the column identically.
function parseFieldProvenance(
  raw: string | null | undefined
): Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown> {
  if (!raw) return {};
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// hostFromUrlLike is exported by cross-source-validator; hostFromEmail is not
// (kept private there). Reimplemented locally exactly the same way (strip to
// the part after '@', parse with hostFromUrlLike) purely for the display-only
// email_domain/website_domain fields in the response — the actual
// mismatch/exclusion decision is made entirely by domainCoherenceCheck below,
// not by this helper.
function hostFromEmailLocal(raw: string): string | null {
  if (!raw.includes("@")) return null;
  const after = raw.split("@").pop();
  if (!after) return null;
  return hostFromUrlLike(after);
}

const router = Router();

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

interface EmailWebsiteRow {
  agent_id: string;
  name: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  field_provenance: string | null;
}

interface EmailDomainMismatch {
  agent_id: string;
  name: string;
  email_domain: string;
  website_domain: string;
}

interface OpeningHoursRow {
  agent_id: string;
  opening_hours: string;
}

interface DuplicateOpeningHours {
  value: string;
  agent_ids: string[];
}

// The 2 of the 4 dev-request heuristics NOT built in this slice, and why —
// see the file-header comment for the full reasoning. One string per skipped
// heuristic, "<heuristic_name>: <reason>" shape.
const SKIPPED_HEURISTICS: readonly string[] = [
  "postalCode_vs_address: no postnummer reference data in repo",
  "retningsnummer_vs_fylke: no reliable phone-prefix-to-fylke mapping available; high false-positive risk",
];

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── READ-ONLY / DRY-RUN ONLY ──────────────────────────────────────────
  // Every statement below is a SELECT. This handler must never contain an
  // INSERT/UPDATE/DELETE — it is a detection tool, not a correction tool.
  // There is deliberately no `apply` mode (unlike admin-domain-coherence.ts).
  try {
    const db = getDb();

    const total_agents_scanned = (
      db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE umbrella_type IS NULL AND is_active = 1`).get() as { c: number }
    ).c;

    // ── Heuristic 1: email-domain vs website-domain mismatch ────────────
    const emailWebsiteRows = db
      .prepare(
        `SELECT a.id AS agent_id, a.name, k.website, k.email, k.phone, k.address, k.field_provenance
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.umbrella_type IS NULL
            AND a.is_active = 1
            AND k.email IS NOT NULL AND TRIM(k.email) != ''
            AND k.website IS NOT NULL AND TRIM(k.website) != ''
       ORDER BY a.id`
      )
      .all() as EmailWebsiteRow[];

    const email_domain_mismatch: EmailDomainMismatch[] = [];
    for (const row of emailWebsiteRows) {
      const opts = {
        fieldProvenance: parseFieldProvenance(row.field_provenance),
        knowledgePhone: row.phone,
        knowledgeAddress: row.address,
      };
      // Anchor identity to the agent's OWN website (not agents.url) — passing
      // it as both the 1st and 2nd arg makes the website-vs-website leg
      // trivially agree, so the only way this returns incoherent is via the
      // email-vs-anchor-host check, which is the exact comparison heuristic 1
      // asks for (with FREE_MAIL_DOMAINS / PLACEHOLDER_EMAIL_DOMAINS /
      // homepage-evidence / domainsEquivalent already applied).
      const result = domainCoherenceCheck(row.website, row.website, row.email, opts);
      if (result.coherent) continue;
      if (!(result.reason || "").startsWith("knowledge.email host")) continue;

      const websiteHost = hostFromUrlLike(row.website!);
      const emailHost = hostFromEmailLocal(row.email!);
      if (!websiteHost || !emailHost) continue;

      email_domain_mismatch.push({
        agent_id: row.agent_id,
        name: row.name,
        email_domain: registrableDomain(emailHost),
        website_domain: registrableDomain(websiteHost),
      });
    }

    // ── Heuristic 2: duplicate boilerplate opening-hours ─────────────────
    const hoursRows = db
      .prepare(
        `SELECT a.id AS agent_id, k.opening_hours
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.umbrella_type IS NULL
            AND a.is_active = 1
            AND k.opening_hours IS NOT NULL
            AND TRIM(k.opening_hours) NOT IN ('', '[]')
       ORDER BY a.id`
      )
      .all() as OpeningHoursRow[];

    const hoursGroups = new Map<string, string[]>();
    for (const row of hoursRows) {
      const key = row.opening_hours.trim();
      const ids = hoursGroups.get(key) ?? [];
      ids.push(row.agent_id);
      hoursGroups.set(key, ids);
    }
    const duplicate_opening_hours: DuplicateOpeningHours[] = [];
    for (const [value, agent_ids] of hoursGroups) {
      if (agent_ids.length >= 3) duplicate_opening_hours.push({ value, agent_ids });
    }

    res.json({
      success: true,
      total_agents_scanned,
      email_domain_mismatch,
      duplicate_opening_hours,
      skipped_heuristics: SKIPPED_HEURISTICS,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;

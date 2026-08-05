// ─── Admin: POST /admin/agents/contact-email-dns-check ──────────────────────
//
// A prior slice (admin-agents-contact-email-write.ts's header) measured that
// ~200 of 1611 RFB producers carry a `contact_email` whose domain has NO DNS
// presence at all — typos, dead domains. Useless for outreach, and actively
// harmful (bounces hurt sender reputation).
//
// This route's job is ONLY to detect and record that fact as a diagnostic
// stamp on `agent_knowledge.field_provenance.contact_email_dns_check`. It
// deliberately does NOT:
//   * change any outreach selector or gate anything on this stamp (a future,
//     separately-reviewed slice decides how to use it),
//   * touch `email_bounces` (that table is REAL received Resend bounces — a
//     *predicted* dead domain is a different signal, and conflating the two
//     would corrupt it),
//   * write `agents.contact_email` or `agent_knowledge.email` (the actual
//     outreach address is the sibling write-route's job, not this one's).
//
// ── DNS classification (fail-closed on ambiguity) ───────────────────────────
//   1. resolveMx(domain). Non-empty -> live via "mx".
//   2. Empty MX, or MX throws ENODATA/ENOTFOUND -> fall back to resolve4, then
//      resolve6. Either non-empty -> live via "a_aaaa".
//   3. All three empty/ENODATA/ENOTFOUND -> dead ("none").
//   4. ANY other error (ETIMEOUT, ESERVFAIL, ECONNREFUSED, an unexpected
//      throw) at any step -> "unknown", NEVER "dead". A transient network
//      blip must never get recorded as a confirmed-dead domain.
//
// ── Write discipline ─────────────────────────────────────────────────────────
//   * dry-run by DEFAULT (mirrors contact-email-write.ts's convention
//     exactly: `apply` must be an explicit truthy form, body or query).
//   * `unknown` rows are NEVER written, in either mode — leave whatever stamp
//     (if any) already exists untouched, so a future run picks the row up
//     again instead of a network blip freezing it as wrong forever.
//   * `contact_email_dns_check` is OVERWRITTEN wholesale each time — this is a
//     current-status check, not an append-only audit log. No
//     agent_knowledge_audit row: this field is never owner-curated and has no
//     "old value to revert to" that matters (the DNS reality itself is what's
//     being recorded).
//   * Per-row try/catch, isolated from the rest of the batch (mirrors the
//     sibling route's per-row error isolation).

import { Router, Request, Response } from "express";
import * as dns from "dns";
import { getDb } from "../database/init";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
// Same seam shape/reasoning as admin-agents-contact-email-write.ts's
// __setContactEmailWriteDbForTesting: resolves the DB through one indirection
// a test can override for ITS OWN calls, touching no shared global. Production
// code never calls the setter.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setContactEmailDnsCheckDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// ── Injectable DNS resolver seam (tests only) ───────────────────────────────
// Same shape as geocoding-service.ts's __setGeocodingFetchForTesting: swaps
// the resolver used for every lookup so tests never make a real network
// call. Production default is the real `dns.promises`.
export interface DnsResolverSeam {
  resolveMx(hostname: string): Promise<unknown[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const realDnsResolver: DnsResolverSeam = {
  resolveMx: (hostname: string) => dns.promises.resolveMx(hostname),
  resolve4: (hostname: string) => dns.promises.resolve4(hostname),
  resolve6: (hostname: string) => dns.promises.resolve6(hostname),
};

let dnsResolverOverrideForTesting: DnsResolverSeam | null = null;

/** Test-only. Pass null/undefined to restore the real `dns.promises` resolver. */
export function __setDnsResolverForTesting(resolver?: DnsResolverSeam | null): void {
  dnsResolverOverrideForTesting = resolver ?? null;
}

function resolveDnsResolver(): DnsResolverSeam {
  return dnsResolverOverrideForTesting ?? realDnsResolver;
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

/** Hard cap per call — same reasoning as CONTACT_EMAIL_WRITE_MAX_ITEMS: bounded blast radius. */
export const CONTACT_EMAIL_DNS_CHECK_MAX_ITEMS = 200;

/** Repeat scheduled runs don't re-hit the same live domain constantly. */
const RECHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Domain part of an email, lowercased/trimmed. Returns null (not "") when
 * there's no '@' or an empty domain, so callers can tell "invalid" apart from
 * a domain that happens to classify as dead.
 */
export function extractDomain(rawEmail: string | null | undefined): string | null {
  const email = (rawEmail ?? "").trim();
  const at = email.indexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * True for the two DNS "this name/record genuinely doesn't exist" codes.
 * Everything else (ETIMEOUT, ESERVFAIL, ECONNREFUSED, ...) is ambiguous and
 * must NOT be treated as proof of a dead domain.
 */
function isNoRecordError(e: unknown): boolean {
  const code = (e as { code?: string } | null | undefined)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
}

function errorDetail(e: unknown): string {
  const err = e as { code?: string; message?: string } | null | undefined;
  return err?.code || err?.message || String(e);
}

type DnsClassification =
  | { outcome: "live"; method: "mx" | "a_aaaa" }
  | { outcome: "dead"; method: "none" }
  | { outcome: "unknown"; detail: string };

/**
 * Classifies ONE domain. MX first; empty/ENODATA/ENOTFOUND falls back to
 * A then AAAA; all-empty/ENODATA/ENOTFOUND is "dead". Any other error at any
 * step short-circuits to "unknown" immediately (fail-closed — see header).
 */
export async function classifyDomain(domain: string, resolver: DnsResolverSeam): Promise<DnsClassification> {
  try {
    const mx = await resolver.resolveMx(domain);
    if (Array.isArray(mx) && mx.length > 0) {
      return { outcome: "live", method: "mx" };
    }
    // Empty MX -> fall through to A/AAAA.
  } catch (e: unknown) {
    if (!isNoRecordError(e)) {
      return { outcome: "unknown", detail: errorDetail(e) };
    }
    // ENODATA/ENOTFOUND -> fall through to A/AAAA.
  }

  try {
    const a4 = await resolver.resolve4(domain);
    if (Array.isArray(a4) && a4.length > 0) {
      return { outcome: "live", method: "a_aaaa" };
    }
  } catch (e: unknown) {
    if (!isNoRecordError(e)) {
      return { outcome: "unknown", detail: errorDetail(e) };
    }
  }

  try {
    const a6 = await resolver.resolve6(domain);
    if (Array.isArray(a6) && a6.length > 0) {
      return { outcome: "live", method: "a_aaaa" };
    }
  } catch (e: unknown) {
    if (!isNoRecordError(e)) {
      return { outcome: "unknown", detail: errorDetail(e) };
    }
  }

  return { outcome: "dead", method: "none" };
}

/**
 * Reads the existing `contact_email_dns_check.checked_at` stamp (if any) out
 * of a raw `field_provenance` JSON string. Malformed/missing -> null (treated
 * as "never checked" -> eligible, sorts first). Mirrors the defensive-parse
 * convention used throughout this codebase (marketplace.ts, admin-agents.ts).
 */
function getCheckedAtMs(fieldProvenanceJson: string | null | undefined): number | null {
  if (!fieldProvenanceJson) return null;
  try {
    const parsed = JSON.parse(fieldProvenanceJson);
    if (!parsed || typeof parsed !== "object") return null;
    const stamp = (parsed as Record<string, unknown>)["contact_email_dns_check"];
    if (!stamp || typeof stamp !== "object") return null;
    const checkedAt = (stamp as Record<string, unknown>)["checked_at"];
    if (typeof checkedAt !== "string") return null;
    const t = Date.parse(checkedAt);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * Writes the diagnostic stamp for ONE agent. Manual read-parse-mutate-write
 * on `field_provenance` — mirrors marketplace.ts's `website_ownership` stamp
 * (~line 5768) exactly: defensive parse (malformed/missing -> {}, never
 * throw), mutate one top-level key, write back. `INSERT OR IGNORE` seeds a
 * missing agent_knowledge row first, mirroring admin-agents.ts's
 * brreg-description-fallback pattern (~line 1193). OVERWRITES any previous
 * stamp — this is a current-status check, not an append-only log, so no
 * agent_knowledge_audit row is written.
 */
function writeDnsCheckStamp(
  db: ReturnType<typeof getDb>,
  agentId: string,
  domain: string,
  live: boolean,
  method: "mx" | "a_aaaa" | "none",
  batchId: string,
): void {
  const tx = db.transaction((): void => {
    const nowIso = new Date().toISOString();
    const existsRow = db
      .prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`)
      .get(agentId) as { field_provenance?: string | null } | undefined;

    let existingProv: Record<string, unknown> = {};
    if (existsRow === undefined) {
      db.prepare(
        `INSERT OR IGNORE INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)`,
      ).run(agentId, nowIso);
    } else if (existsRow.field_provenance) {
      try {
        const parsed = JSON.parse(existsRow.field_provenance);
        if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
      } catch {
        /* tolerate junk, mirrors marketplace.ts's website_ownership call site */
      }
    }

    existingProv.contact_email_dns_check = {
      checked_at: nowIso,
      domain,
      live,
      method,
      batch_id: batchId,
    };

    db.prepare(`UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?`).run(
      JSON.stringify(existingProv),
      nowIso,
      agentId,
    );
  });
  tx();
}

type ItemOutcome =
  | "would_confirm_live"
  | "would_flag_dead"
  | "live"
  | "dead"
  | "unknown"
  | "skipped_invalid_email"
  | "error"
  | "not_found";

interface ResultItem {
  agent_id: string;
  domain?: string;
  outcome: ItemOutcome;
  method?: "mx" | "a_aaaa" | "none";
  detail?: string;
}

interface ScanRow {
  id: string;
  contact_email: string | null;
  field_provenance: string | null;
}

/**
 * Processes ONE row end to end: extract domain -> classify -> (dry-run:
 * report only) or (apply: write, unless unknown). Wrapped so one row's
 * failure can never abort the batch (mirrors applyContactEmail's isolation).
 */
async function processRow(
  row: ScanRow,
  dryRun: boolean,
  batchId: string,
  db: ReturnType<typeof getDb>,
  resolver: DnsResolverSeam,
): Promise<ResultItem> {
  try {
    const domain = extractDomain(row.contact_email);
    if (!domain) {
      return { agent_id: row.id, outcome: "skipped_invalid_email" };
    }

    let classification: DnsClassification;
    try {
      classification = await classifyDomain(domain, resolver);
    } catch (e: unknown) {
      // Any exception escaping classifyDomain is itself ambiguity, not a
      // confirmed-dead signal — fail closed the same as a caught DNS error.
      classification = { outcome: "unknown", detail: errorDetail(e) };
    }

    if (classification.outcome === "unknown") {
      return { agent_id: row.id, domain, outcome: "unknown", detail: classification.detail };
    }

    const live = classification.outcome === "live";
    const method = classification.method;

    if (dryRun) {
      return { agent_id: row.id, domain, outcome: live ? "would_confirm_live" : "would_flag_dead", method };
    }

    try {
      writeDnsCheckStamp(db, row.id, domain, live, method, batchId);
      return { agent_id: row.id, domain, outcome: live ? "live" : "dead", method };
    } catch (e: unknown) {
      return { agent_id: row.id, domain, outcome: "error", detail: errorDetail(e) };
    }
  } catch (e: unknown) {
    return { agent_id: row.id, outcome: "error", detail: errorDetail(e) };
  }
}

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agent_ids?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  let requestedIds: string[] | null = null;
  if (body.agent_ids !== undefined) {
    if (!Array.isArray(body.agent_ids) || body.agent_ids.some((x) => typeof x !== "string")) {
      res.status(400).json({ error: "agent_ids must be an array of strings" });
      return;
    }
    // De-dup, preserve caller order.
    const seen = new Set<string>();
    requestedIds = [];
    for (const raw of body.agent_ids as string[]) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      requestedIds.push(id);
    }
    if (requestedIds.length > CONTACT_EMAIL_DNS_CHECK_MAX_ITEMS) {
      res.status(400).json({ error: `Too many agent_ids (max ${CONTACT_EMAIL_DNS_CHECK_MAX_ITEMS} per call)` });
      return;
    }
  }

  const db = resolveDb();
  const batchId = `contact-email-dns-check-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15)}`;

  const notFoundResults: ResultItem[] = [];
  let selectedRows: ScanRow[] = [];

  if (requestedIds !== null) {
    // Explicit selection: use exactly those ids, no 30-day freshness filter —
    // an operator naming ids wants THOSE ids checked now, regardless of when
    // they were last checked.
    if (requestedIds.length > 0) {
      const placeholders = requestedIds.map(() => "?").join(",");
      const found = db
        .prepare(
          `SELECT a.id AS id, a.contact_email AS contact_email, k.field_provenance AS field_provenance
             FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id IN (${placeholders})`,
        )
        .all(...requestedIds) as ScanRow[];
      const byId = new Map(found.map((r) => [r.id, r]));
      for (const id of requestedIds) {
        const row = byId.get(id);
        if (row) selectedRows.push(row);
        else notFoundResults.push({ agent_id: id, outcome: "not_found" });
      }
    }
  } else {
    // Default scan: every agent with a non-empty contact_email, excluding
    // rows whose stamp is less than 30 days old, oldest/never-checked first,
    // capped at CONTACT_EMAIL_DNS_CHECK_MAX_ITEMS per call.
    const allRows = db
      .prepare(
        `SELECT a.id AS id, a.contact_email AS contact_email, k.field_provenance AS field_provenance
           FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.contact_email IS NOT NULL AND a.contact_email != ''`,
      )
      .all() as ScanRow[];

    const now = Date.now();
    selectedRows = allRows
      .map((r) => ({ row: r, checkedAtMs: getCheckedAtMs(r.field_provenance) }))
      .filter((x) => x.checkedAtMs === null || now - x.checkedAtMs >= RECHECK_INTERVAL_MS)
      .sort((a, b) => (a.checkedAtMs ?? -Infinity) - (b.checkedAtMs ?? -Infinity))
      .slice(0, CONTACT_EMAIL_DNS_CHECK_MAX_ITEMS)
      .map((x) => x.row);
  }

  const resolver = resolveDnsResolver();
  // Concurrent, not serial — a synchronous full scan of real DNS lookups is
  // the same cost class the fleet has already measured elsewhere (the
  // gårdssalg website-verification sweep took minutes over ~87 rows).
  const rowResults = await Promise.all(selectedRows.map((row) => processRow(row, dryRun, batchId, db, resolver)));

  const results: ResultItem[] = [...notFoundResults, ...rowResults];

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_id: batchId,
    scanned: results.length,
    counts,
    results,
  });
});

export default router;

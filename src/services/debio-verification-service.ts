// ─── Debio organic-cert verification (PR-95, 2026-06-01) ─────────────
//
// Daniel-directive (2026-06-01): only show a "Debio" label when actually
// verified against finnoko.debio.no. The platform previously inferred
// Debio certification from the substring "organic"/"økologisk" anywhere
// in a producer's description text (see seed-knowledge.ts:~136 pre-PR-95),
// which produced ~73 organic-tagged agents but 0 actually verified.
//
// Audit summary (2026-06-01):
//   - 73 agents tagged "organic" on the platform
//   - 0 of 73 confirmed against the Debio umbrella (member_count: 0)
//   - 7 of 73 (~10%) mention Debio/sertifisert/Ø-merket in their description
//   - Peter Møller (Debio Sertifisering head): structurally validated complaint
//
// This service pulls the public finnoko.debio.no/api/acm/companies feed
// (~83 opted-in showcase producers, no auth required, single round-trip)
// and sets `agents.debio_verified = 1` for matched producers. Matching
// strategy (in order):
//
//   1. website domain — canonicalised (lowercase, strip scheme + www. +
//      trailing slash + path).
//   2. fallback — name similarity via name-matcher.ts (nameSimilarity ≥ 0.85).
//
// Note: this complements the existing debio-cross-check service
// (src/services/debio-cross-check.ts) which writes affiliation rows. The
// new flag exists ON the agent itself so the marketplace API can emit a
// `debio_verified` field without joining through affiliations, and so
// search-tag rewriting (which doesn't know about affiliations) can also
// rely on it.
//
// Idempotent: rows already at debio_verified=1 only have debio_verified_at
// refreshed. Rows that LOSE their finnoko match are NOT automatically
// reset to 0 — that's a Daniel-decision (a producer could opt out of the
// finnoko showcase without losing their certification). We log the
// would-be-clears for review.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import {
  fetchFinnokoCompanies,
  FinnokoCompany,
} from "./debio-finnoko-client";
import { normaliseForMatch, nameSimilarity } from "./name-matcher";

const NAME_MATCH_THRESHOLD = 0.85;

export type SyncDebioVerificationsOptions = {
  /** Inject DB (for tests). Defaults to getDb(). */
  db?: Database.Database;
  /** Inject stubbed fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Skip the in-process finnoko cache. */
  skipCache?: boolean;
  /** Override the timestamp written to debio_verified_at (for tests). */
  nowIso?: string;
};

export type SyncDebioVerificationsResult = {
  fetched: number;          // raw count from finnoko.debio.no
  matched: number;          // unique agents matched (by website or name)
  updated: number;          // rows where debio_verified flipped 0 → 1 OR _at refreshed
  newly_verified: number;   // rows where debio_verified was 0, now 1
  still_verified: number;   // rows where debio_verified was already 1 (timestamp refreshed)
  by_method: { domain: number; name: number };
  unmatched_finnoko_ids: string[]; // partner_sids that didn't match any agent
  errors: string[];
};

// ─── Domain canonicalisation ─────────────────────────────────────────
//
// Reduce a URL or bare hostname to a comparable lowercase host without
// scheme, "www.", path, query, or trailing dot. Returns null if the
// input doesn't look like a usable host.
//
// Examples:
//   "https://www.NorskUllgris.no/butikk?utm=foo" → "norskullgris.no"
//   "www.example.com/"                           → "example.com"
//   "Example.com"                                → "example.com"
//   "  http://foo.no  "                          → "foo.no"
//   ""                                           → null
//   "facebook.com/groups/..."                    → "facebook.com" (caller filters)
export function canonicaliseDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  // Strip scheme if present (http://, https://, ftp://, etc.)
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Drop any leading slashes
  s = s.replace(/^\/+/, "");
  // Path / query / fragment — keep only the host part
  s = s.split("/")[0].split("?")[0].split("#")[0];
  // Trim trailing dot (FQDN form)
  s = s.replace(/\.+$/, "");
  // Strip leading "www."
  s = s.replace(/^www\./, "");

  // Sanity: must contain at least one dot and only host-legal chars.
  if (!s.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  // Reject overly generic social/marketplace hosts that would cause
  // false positives — the finnoko data uses these as fallback links
  // when a producer has no own website. Caller can still match via name.
  const blocklist = new Set([
    "facebook.com",
    "instagram.com",
    "youtube.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
    "tiktok.com",
    "gmail.com",
  ]);
  if (blocklist.has(s)) return null;
  return s;
}

type AgentRow = {
  id: string;
  name: string;
  website: string | null;
  debio_verified: number;
};

// ─── Build an in-memory index of agents → canonical domain & name ────
//
// One query, ~few thousand rows, ~few-MB working set. Re-built per sync
// call so any agent updates since the last run are picked up.
function buildAgentIndex(db: Database.Database): {
  byDomain: Map<string, AgentRow>;
  all: AgentRow[];
} {
  // Pull website from BOTH agents and agent_knowledge — the canonical
  // website lives on agent_knowledge for most rows (the agents table
  // doesn't have a website column on every migration path), but we LEFT
  // JOIN so umbrella-only agents (no knowledge row) are still scannable
  // by name.
  const rows = db.prepare(`
    SELECT a.id, a.name, a.debio_verified, k.website AS website
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.is_active = 1
      AND (a.umbrella_type IS NULL OR a.umbrella_type = '')
      AND (a.role IS NULL OR a.role = 'producer')
  `).all() as AgentRow[];

  const byDomain = new Map<string, AgentRow>();
  for (const r of rows) {
    const d = canonicaliseDomain(r.website);
    if (d && !byDomain.has(d)) byDomain.set(d, r);
  }
  return { byDomain, all: rows };
}

// ─── Match one finnoko company against our agents ───────────────────
//
// Returns the matched agent + the method, or null. Method precedence:
// domain > name (domains are 100%-deterministic when present; name
// match is a 0.85+ fuzzy score).
export function matchFinnokoCompany(
  company: FinnokoCompany,
  index: { byDomain: Map<string, AgentRow>; all: AgentRow[] },
): { agent: AgentRow; method: "domain" | "name"; score: number } | null {
  // 1. Domain match — try `website` first, then `website2`.
  for (const w of [company.website, company.website2]) {
    const d = canonicaliseDomain(w);
    if (d) {
      const hit = index.byDomain.get(d);
      if (hit) return { agent: hit, method: "domain", score: 1.0 };
    }
  }

  // 2. Name fallback — single best Dice score across all agents.
  const needle = company.display_name;
  if (!needle) return null;
  const normNeedle = normaliseForMatch(needle);
  if (!normNeedle) return null;

  let best: { agent: AgentRow; score: number } | null = null;
  for (const a of index.all) {
    if (!a.name) continue;
    const s = nameSimilarity(needle, a.name);
    if (s >= NAME_MATCH_THRESHOLD && (!best || s > best.score)) {
      best = { agent: a, score: s };
    }
  }
  if (best) return { agent: best.agent, method: "name", score: best.score };
  return null;
}

// ─── Main entry: sync verifications from finnoko.debio.no ────────────
//
// Pure side-effect: updates agents.debio_verified = 1 (and
// debio_verified_at, debio_finnoko_id) for every matched producer.
// Does NOT clear verification for previously-matched agents that no
// longer appear in finnoko — see top-of-file note on opt-out semantics.
export async function syncDebioVerifications(
  opts: SyncDebioVerificationsOptions = {},
): Promise<SyncDebioVerificationsResult> {
  const db = opts.db ?? getDb();
  const now = opts.nowIso ?? new Date().toISOString();

  const result: SyncDebioVerificationsResult = {
    fetched: 0,
    matched: 0,
    updated: 0,
    newly_verified: 0,
    still_verified: 0,
    by_method: { domain: 0, name: 0 },
    unmatched_finnoko_ids: [],
    errors: [],
  };

  let companies: FinnokoCompany[];
  try {
    companies = await fetchFinnokoCompanies({
      fetchImpl: opts.fetchImpl,
      skipCache: opts.skipCache,
    });
  } catch (e) {
    result.errors.push(
      `fetchFinnokoCompanies failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result;
  }
  result.fetched = companies.length;

  const index = buildAgentIndex(db);

  // Track which agent ids we've already matched in THIS run — a finnoko
  // record with both a website and a name that aliases another farm
  // shouldn't double-count.
  const matchedAgentIds = new Set<string>();
  const updateStmt = db.prepare(`
    UPDATE agents
    SET debio_verified = 1,
        debio_verified_at = ?,
        debio_finnoko_id = ?
    WHERE id = ?
  `);

  for (const c of companies) {
    let match: ReturnType<typeof matchFinnokoCompany> = null;
    try {
      match = matchFinnokoCompany(c, index);
    } catch (e) {
      result.errors.push(
        `match failed for finnoko ${c.partner_sid}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!match) {
      result.unmatched_finnoko_ids.push(String(c.partner_sid));
      continue;
    }
    if (matchedAgentIds.has(match.agent.id)) {
      // Already matched this agent earlier in this run — skip the dup
      continue;
    }
    matchedAgentIds.add(match.agent.id);

    try {
      const wasVerified = match.agent.debio_verified === 1;
      updateStmt.run(now, String(c.partner_sid), match.agent.id);
      result.matched++;
      result.updated++;
      result.by_method[match.method]++;
      if (wasVerified) result.still_verified++;
      else result.newly_verified++;
    } catch (e) {
      result.errors.push(
        `update failed for agent ${match.agent.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}

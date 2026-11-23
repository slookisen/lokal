// ─── Admin: GET /admin/agents/duplicate-groups (READ-ONLY) ──────────────────
//
// dev-request 2026-11-22-rfb-dubletter-samme-nettsted-sammenslaaing-og-
// utsending, point 1: lists groups of ACTIVE RFB profiles that share one
// identifying key, so a human can decide which pairs to feed into
// POST /admin/agents/duplicate-merge (which never detects by itself).
//
// Match keys (a profile can be in several groups, one per key it shares):
//   domain  the registrable domain of agents.url or agent_knowledge.website
//           (claim-domain-rule websiteHost → registrableDomain). Hosted
//           platforms / aggregators / public sector (isHostedPlatformHost)
//           and free-mail / ISP domains (isFreeMailDomain — e.g. personal
//           pages on home.online.no) are never a key: many unrelated farms
//           live there.
//   orgnr   agents.org_nr, whitespace stripped, exactly 9 digits.
//   email   agents.contact_email or agent_knowledge.email, normalized
//           (trim + lower case, one plausible address). Addresses on a
//           free-mail domain are left out of the GROUPS by default (the
//           domain says nothing about the business; ?include_free_mail=1
//           adds them). The address itself is NEVER returned: the key is a
//           short SHA-256 hash of the normalized address.
//
// Each group: key type + value (hash for e-mail), member ids/names, claimed
// status, whether the members have different street addresses / places, and
// whether any member has been sent to (outreach_sent_log, or an RFB marketing
// ledger row with status sent/unknown) or has replied (an inbound crm_message
// on a crm_contacts row of that member — the same agent_id chain the outreach
// gate's has_replied uses).
//
// Summary: group/profile counts (per key type and in total), groups whose
// members have differing addresses, and `shared_contact_emails`: the number
// of contact e-mail addresses shared by ≥2 active RFB profiles and the number
// of profiles holding one — counted over ALL addresses, free-mail included,
// independent of the group filter.
//
// ── STRICTLY READ-ONLY ──────────────────────────────────────────────────
// SELECTs only. No writes, no audit rows, no page-view logging.
//
// Auth: X-Admin-Key (ADMIN_KEY, falling back to ANALYTICS_ADMIN_KEY), same as
// the sibling duplicate-merge / duplicate-slugs routes. `adminLimiter` is
// applied at the mount site in src/index.ts.

import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { getDb } from "../database/init";
import {
  emailDomain,
  isFreeMailDomain,
  isHostedPlatformHost,
  registrableDomain,
  websiteHost,
} from "../services/claim-domain-rule";
import { normalizeEmail } from "../services/blocklist-service";
import { isSingleEmailAddress } from "../services/knowledge-service";

const router = Router();

// ── Injectable DB seam (tests only) — same convention as the siblings ──────
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setDuplicateGroupsDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
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

export const DUPLICATE_GROUPS_DEFAULT_LIMIT = 100;
export const DUPLICATE_GROUPS_MAX_LIMIT = 500;

export type DuplicateKeyType = "domain" | "orgnr" | "email";
const KEY_TYPES: readonly DuplicateKeyType[] = ["domain", "orgnr", "email"];

// ── Pure key helpers (exported for tests) ───────────────────────────────────

/** The grouping domain of a website value, or null when it is no key
 *  (unparseable, a hosted platform / aggregator, or a free-mail/ISP domain). */
export function websiteDomainKey(website: unknown): string | null {
  const host = websiteHost(website);
  if (!host) return null;
  if (isHostedPlatformHost(host)) return null;
  const reg = registrableDomain(host);
  if (!reg) return null;
  if (isHostedPlatformHost(reg) || isFreeMailDomain(reg)) return null;
  return reg;
}

/** A 9-digit org.nr. with whitespace stripped, or null. */
export function orgNrKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.replace(/\s+/g, "");
  return /^\d{9}$/.test(d) ? d : null;
}

/** A normalized single e-mail address, or null. */
export function emailKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = normalizeEmail(v);
  return e && isSingleEmailAddress(e) ? e : null;
}

/** The public stand-in for an address: a short SHA-256 hex prefix. */
export function emailHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function normText(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Data ────────────────────────────────────────────────────────────────────

interface ProfileRow {
  id: string;
  name: string;
  url: string | null;
  org_nr: string | null;
  contact_email: string | null;
  city: string | null;
  claimed_at: string | null;
  k_website: string | null;
  k_email: string | null;
  k_address: string | null;
  k_postal_code: string | null;
}

export interface DuplicateGroupMember {
  id: string;
  name: string;
  claimed: boolean;
  sent: boolean;
  replied: boolean;
}

export interface DuplicateGroup {
  key_type: DuplicateKeyType;
  /** domain / org.nr. as is; for e-mail a hash of the address (never the address). */
  key_value: string;
  /** e-mail groups only: whether the shared address is on a free-mail domain. */
  free_mail?: boolean;
  size: number;
  member_ids: string[];
  members: DuplicateGroupMember[];
  distinct_addresses: number;
  distinct_places: number;
  addresses_differ: boolean;
  any_claimed: boolean;
  any_sent: boolean;
  any_replied: boolean;
}

function tableExists(db: ReturnType<typeof getDb>, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function loadActiveRfbProfiles(db: ReturnType<typeof getDb>): ProfileRow[] {
  // Active, not merged, RFB, not an umbrella organisation (an umbrella's
  // member pages are not duplicates of the umbrella).
  return db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.url AS url, a.org_nr AS org_nr,
              a.contact_email AS contact_email, a.city AS city, a.claimed_at AS claimed_at,
              k.website AS k_website, k.email AS k_email, k.address AS k_address,
              k.postal_code AS k_postal_code
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE COALESCE(a.is_active, 1) = 1
          AND (a.merged_into IS NULL OR a.merged_into = '')
          AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
          AND a.umbrella_type IS NULL
        ORDER BY a.id`,
    )
    .all() as ProfileRow[];
}

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(id);
}

export interface DuplicateGroupsReport {
  summary: {
    active_rfb_profiles: number;
    groups: number;
    profiles: number;
    groups_with_differing_addresses: number;
    by_key_type: Record<DuplicateKeyType, { groups: number; profiles: number }>;
    shared_contact_emails: { addresses: number; profiles: number; free_mail_addresses: number };
    free_mail_email_groups_included: boolean;
  };
  total_groups: number;
  offset: number;
  limit: number;
  groups: DuplicateGroup[];
}

/**
 * Builds the report. Read-only. `keyType` filters the listed groups (the
 * summary always covers all key types); `offset`/`limit` page the list.
 */
export function buildDuplicateGroupsReport(
  db: ReturnType<typeof getDb>,
  opts: { keyType?: DuplicateKeyType; includeFreeMail?: boolean; offset?: number; limit?: number } = {},
): DuplicateGroupsReport {
  const includeFreeMail = !!opts.includeFreeMail;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(DUPLICATE_GROUPS_MAX_LIMIT, Math.max(1, opts.limit ?? DUPLICATE_GROUPS_DEFAULT_LIMIT));

  const profiles = loadActiveRfbProfiles(db);
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const keyed: Record<DuplicateKeyType, Map<string, Set<string>>> = {
    domain: new Map(),
    orgnr: new Map(),
    email: new Map(),
  };
  for (const p of profiles) {
    for (const site of [p.url, p.k_website]) {
      const d = websiteDomainKey(site);
      if (d) addTo(keyed.domain, d, p.id);
    }
    const o = orgNrKey(p.org_nr);
    if (o) addTo(keyed.orgnr, o, p.id);
    for (const raw of [p.contact_email, p.k_email]) {
      const e = emailKey(raw);
      if (e) addTo(keyed.email, e, p.id);
    }
  }

  // AC5 count: addresses shared by ≥2 active RFB profiles, ALL addresses.
  let sharedAddresses = 0;
  let sharedFreeMail = 0;
  const sharedProfiles = new Set<string>();
  for (const [addr, ids] of keyed.email) {
    if (ids.size < 2) continue;
    sharedAddresses++;
    const dom = emailDomain(addr);
    if (dom && isFreeMailDomain(dom)) sharedFreeMail++;
    for (const id of ids) sharedProfiles.add(id);
  }

  // Groups (size ≥ 2).
  interface RawGroup {
    key_type: DuplicateKeyType;
    key: string;
    ids: string[];
    free_mail?: boolean;
  }
  const raw: RawGroup[] = [];
  for (const kt of KEY_TYPES) {
    for (const [key, ids] of keyed[kt]) {
      if (ids.size < 2) continue;
      if (kt === "email") {
        const dom = emailDomain(key);
        const free = !!dom && isFreeMailDomain(dom);
        if (free && !includeFreeMail) continue;
        raw.push({ key_type: kt, key, ids: [...ids].sort(), free_mail: free });
      } else {
        raw.push({ key_type: kt, key, ids: [...ids].sort() });
      }
    }
  }

  const addressStats = (ids: string[]): { addresses: number; places: number } => {
    const addresses = new Set<string>();
    const places = new Set<string>();
    for (const id of ids) {
      const p = byId.get(id)!;
      const street = normText(p.k_address);
      if (street) addresses.add(`${street}|${normText(p.k_postal_code)}`);
      const place = normText(p.k_postal_code) || normText(p.city);
      if (place) places.add(place);
    }
    return { addresses: addresses.size, places: places.size };
  };

  const byKeyType: Record<DuplicateKeyType, { groups: number; profiles: number }> = {
    domain: { groups: 0, profiles: 0 },
    orgnr: { groups: 0, profiles: 0 },
    email: { groups: 0, profiles: 0 },
  };
  const allProfiles = new Set<string>();
  let differing = 0;
  const stats = new Map<RawGroup, { addresses: number; places: number }>();
  for (const kt of KEY_TYPES) {
    const members = new Set<string>();
    for (const g of raw) {
      if (g.key_type !== kt) continue;
      byKeyType[kt].groups++;
      for (const id of g.ids) {
        members.add(id);
        allProfiles.add(id);
      }
    }
    byKeyType[kt].profiles = members.size;
  }
  for (const g of raw) {
    const s = addressStats(g.ids);
    stats.set(g, s);
    if (s.addresses > 1 || s.places > 1) differing++;
  }

  // Listed groups: optional key-type filter, biggest first, then by the
  // PUBLIC key (the hash for e-mail, so the order says nothing about addresses).
  const shown = (g: RawGroup): string => (g.key_type === "email" ? emailHash(g.key) : g.key);
  const listed = raw
    .filter((g) => !opts.keyType || g.key_type === opts.keyType)
    .sort((a, b) => b.ids.length - a.ids.length || a.key_type.localeCompare(b.key_type) || shown(a).localeCompare(shown(b)));
  const page = listed.slice(offset, offset + limit);

  // Sent / replied flags only for the members on this page.
  const hasLedger = tableExists(db, "rfb_marketing_send_ledger");
  const sentLog = db.prepare(`SELECT 1 FROM outreach_sent_log WHERE agent_id = ? LIMIT 1`);
  const sentLedger = hasLedger
    ? db.prepare(`SELECT 1 FROM rfb_marketing_send_ledger WHERE agent_id = ? AND status IN ('sent', 'unknown') LIMIT 1`)
    : null;
  const replied = db.prepare(
    `SELECT 1 FROM crm_contacts cc
       JOIN crm_threads ct ON ct.contact_id = cc.id
       JOIN crm_messages cm ON cm.thread_id = ct.id
      WHERE cc.agent_id = ? AND cm.direction = 'in' LIMIT 1`,
  );
  const flagCache = new Map<string, { sent: boolean; replied: boolean }>();
  const flags = (id: string): { sent: boolean; replied: boolean } => {
    let f = flagCache.get(id);
    if (!f) {
      f = {
        sent: !!sentLog.get(id) || (sentLedger !== null && !!sentLedger.get(id)),
        replied: !!replied.get(id),
      };
      flagCache.set(id, f);
    }
    return f;
  };

  const groups: DuplicateGroup[] = page.map((g) => {
    const members: DuplicateGroupMember[] = g.ids.map((id) => {
      const p = byId.get(id)!;
      const f = flags(id);
      return { id, name: p.name, claimed: !!p.claimed_at, sent: f.sent, replied: f.replied };
    });
    const s = stats.get(g)!;
    return {
      key_type: g.key_type,
      key_value: shown(g),
      ...(g.key_type === "email" ? { free_mail: !!g.free_mail } : {}),
      size: g.ids.length,
      member_ids: g.ids,
      members,
      distinct_addresses: s.addresses,
      distinct_places: s.places,
      addresses_differ: s.addresses > 1 || s.places > 1,
      any_claimed: members.some((m) => m.claimed),
      any_sent: members.some((m) => m.sent),
      any_replied: members.some((m) => m.replied),
    };
  });

  return {
    summary: {
      active_rfb_profiles: profiles.length,
      groups: raw.length,
      profiles: allProfiles.size,
      groups_with_differing_addresses: differing,
      by_key_type: byKeyType,
      shared_contact_emails: {
        addresses: sharedAddresses,
        profiles: sharedProfiles.size,
        free_mail_addresses: sharedFreeMail,
      },
      free_mail_email_groups_included: includeFreeMail,
    },
    total_groups: listed.length,
    offset,
    limit,
    groups,
  };
}

function intParam(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return undefined;
  return Number(v);
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const q = req.query ?? {};
  const keyTypeRaw = typeof q.key_type === "string" ? q.key_type : undefined;
  if (keyTypeRaw !== undefined && !KEY_TYPES.includes(keyTypeRaw as DuplicateKeyType)) {
    res.status(400).json({ error: "key_type must be one of domain, orgnr, email" });
    return;
  }
  const includeFreeMail = q.include_free_mail === "1" || q.include_free_mail === "true";
  try {
    const report = buildDuplicateGroupsReport(resolveDb(), {
      keyType: keyTypeRaw as DuplicateKeyType | undefined,
      includeFreeMail,
      offset: intParam(q.offset),
      limit: intParam(q.limit),
    });
    res.json({ success: true, read_only: true, ...report });
  } catch (err: any) {
    res.status(500).json({ error: "duplicate-groups failed", detail: String(err?.message || err) });
  }
});

export default router;

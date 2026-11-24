// ─── RFB profiles on the same website domain ("siblings") ───────────────────
//
// dev-request 2026-11-22-rfb-dubletter-samme-nettsted-sammenslaaing-og-
// utsending. Shared by:
//   • GET /admin/agents/duplicate-groups (slice 2) — the `domain` match key
//     (websiteDomainKey) and the active-RFB-profile predicate.
//   • the RFB cold-outreach gate (computeOutreachCandidates, point 4) — "the
//     outreach gate sees the whole group": a profile is held back when ANOTHER
//     active RFB profile on the same registrable website domain has replied,
//     opted out / is blocklisted, or was sent to inside the cooldown window.
//
// Grouping rules (identical to slice 2): the registrable domain of agents.url
// or agent_knowledge.website. Hosted platforms / aggregators / public sector
// (isHostedPlatformHost) and free-mail / ISP domains (isFreeMailDomain) are
// never a key — many unrelated farms live there. Only active, non-merged,
// non-umbrella RFB profiles are siblings; a profile is never its own sibling.
//
// READ-ONLY: SELECTs only (isBlocked() is a read as well).

import type { getDb } from "../database/init";
import { isBlocked } from "./blocklist-service";
import { isFreeMailDomain, isHostedPlatformHost, registrableDomain, websiteHost } from "./claim-domain-rule";
import { hasContactRetentionMarkers } from "./privacy-retention";

type Db = ReturnType<typeof getDb>;

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

/** WHERE predicate for an active, not merged, RFB, non-umbrella profile on `agents <alias>`. */
export function activeRfbProfileWhereSql(alias: string): string {
  return `COALESCE(${alias}.is_active, 1) = 1
          AND (${alias}.merged_into IS NULL OR ${alias}.merged_into = '')
          AND COALESCE(${alias}.vertical_id, 'rfb') = 'rfb'
          AND ${alias}.umbrella_type IS NULL`;
}

// ── Outreach sibling hold ───────────────────────────────────────────────────

/** Env flag for ENFORCING the sibling hold in the outreach gate (default OFF). */
export const RFB_OUTREACH_SIBLING_DOMAIN_HOLD_FLAG = "RFB_OUTREACH_SIBLING_DOMAIN_HOLD_ENABLED";

/** Read at call time, so toggling the secret takes effect on the next run. */
export function rfbOutreachSiblingDomainHoldEnabled(): boolean {
  const v = String(process.env[RFB_OUTREACH_SIBLING_DOMAIN_HOLD_FLAG] ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/**
 * Why a sibling holds a profile back, most severe first. The gate reports each
 * as suppressed_counts.sibling_domain_<reason>.
 *   replied        the sibling has an inbound CRM message (agent_id-linked
 *                  contact, or its e-mail among the RFB replied addresses —
 *                  the same notion as the gate's has_replied), or a retention
 *                  reply marker.
 *   opted_out      a crm_contacts row of the sibling is not 'active', its
 *                  agent_knowledge.verification_status is 'opt_out', or its
 *                  address has a complaint/unsubscribe in email_bounces.
 *   blocklisted    isBlocked() on the sibling (agent_id, name, e-mail, website)
 *                  — the same call the gate makes for a single profile.
 *   recently_sent  the sibling was sent to inside the cooldown window:
 *                  outreach_sent_log (by agent_id or recipient address), the
 *                  RFB marketing send ledger (status sent/unknown) or a raw
 *                  outbound CRM send to its address.
 */
export type SiblingHoldReason = "replied" | "opted_out" | "blocklisted" | "recently_sent";
export const SIBLING_HOLD_REASONS: readonly SiblingHoldReason[] = ["replied", "opted_out", "blocklisted", "recently_sent"];

export interface SiblingHoldHit {
  reason: SiblingHoldReason;
  sibling_agent_id: string;
  domain: string;
}

export interface RfbSiblingDomainIndex {
  /** Number of domains shared by ≥2 active RFB profiles. */
  shared_domains: number;
  /** The most severe sibling signal for a profile, or null. Never the profile itself. */
  lookup(row: { agent_id: string; website: string | null | undefined; agent_url: string | null | undefined }): SiblingHoldHit | null;
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite) and ISO compare on one form. */
function isoish(ts: string): string {
  return ts.replace(" ", "T");
}

function norm(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return s ? s : null;
}

/**
 * Builds the sibling index ONCE per gate pass: one scan of the active RFB
 * profiles, then set-based reads for the signals of the profiles that share a
 * domain (no per-row query over the agents table; isBlocked() runs once per
 * grouped profile only).
 *
 * `repliedEmails`, `removalEmails` and `recentlyEmailedAddresses` are the sets
 * the gate already computed (loadRfbRepliedContactEmails, its single
 * email_bounces scan, getRecentlyEmailedAddresses), passed in so the sibling
 * check uses exactly the same notion and no table is read twice.
 */
export function buildRfbSiblingDomainIndex(
  db: Db,
  opts: {
    cooldownDays: number;
    repliedEmails: ReadonlySet<string>;
    /** Normalized addresses with a complaint / unsubscribe in email_bounces. */
    removalEmails: ReadonlySet<string>;
    recentlyEmailedAddresses: ReadonlySet<string>;
  },
): RfbSiblingDomainIndex {
  const profiles = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.url AS url, k.website AS k_website,
              k.email AS k_email, a.contact_email AS contact_email
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE ${activeRfbProfileWhereSql("a")}
        ORDER BY a.id`,
    )
    .all() as Array<{
    id: string;
    name: string;
    url: string | null;
    k_website: string | null;
    k_email: string | null;
    contact_email: string | null;
  }>;

  const byDomain = new Map<string, string[]>();
  for (const p of profiles) {
    const seen = new Set<string>();
    for (const site of [p.url, p.k_website]) {
      const d = websiteDomainKey(site);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      let ids = byDomain.get(d);
      if (!ids) byDomain.set(d, (ids = []));
      ids.push(p.id);
    }
  }
  for (const [d, ids] of byDomain) if (ids.length < 2) byDomain.delete(d);

  const grouped = new Set<string>();
  for (const ids of byDomain.values()) for (const id of ids) grouped.add(id);

  const signals = new Map<string, SiblingHoldReason>();
  if (grouped.size > 0) {
    // Agent-keyed sets, one query each.
    const ids = (sql: string): Set<string> =>
      new Set((db.prepare(sql).all() as Array<{ id: string | null }>).map((r) => r.id).filter((x): x is string => !!x));
    const repliedAgents = ids(
      `SELECT DISTINCT cc.agent_id AS id
         FROM crm_contacts cc
         JOIN crm_threads ct ON ct.contact_id = cc.id
         JOIN crm_messages cm ON cm.thread_id = ct.id
        WHERE cc.agent_id IS NOT NULL AND cm.direction = 'in'`,
    );
    if (hasContactRetentionMarkers(db)) {
      for (const id of ids(
        `SELECT DISTINCT agent_id AS id FROM crm_contacts
          WHERE agent_id IS NOT NULL AND retention_last_inbound_at IS NOT NULL`,
      ))
        repliedAgents.add(id);
    }
    const optedOutAgents = ids(
      `SELECT DISTINCT agent_id AS id FROM crm_contacts WHERE agent_id IS NOT NULL AND status != 'active'
       UNION
       SELECT DISTINCT agent_id AS id FROM agent_knowledge WHERE verification_status = 'opt_out'`,
    );
    // Most recent send per agent_id and per address, across the send records.
    const cutoff = new Date(Date.now() - opts.cooldownDays * 86400 * 1000).toISOString();
    const recentAgents = new Set<string>();
    const recentEmails = new Set<string>();
    const collect = (sql: string): void => {
      for (const r of db.prepare(sql).all() as Array<{ k: string | null; t: string | null; kind: string }>) {
        if (!r.k || !r.t || isoish(r.t) < cutoff) continue;
        (r.kind === "agent" ? recentAgents : recentEmails).add(r.k);
      }
    };
    collect(
      `SELECT agent_id AS k, MAX(sent_at) AS t, 'agent' AS kind FROM outreach_sent_log
        WHERE agent_id IS NOT NULL GROUP BY agent_id`,
    );
    collect(
      `SELECT LOWER(TRIM(recipient_email)) AS k, MAX(sent_at) AS t, 'email' AS kind FROM outreach_sent_log
        WHERE recipient_email IS NOT NULL AND recipient_email != '' GROUP BY LOWER(TRIM(recipient_email))`,
    );
    if (tableExists(db, "rfb_marketing_send_ledger")) {
      collect(
        `SELECT agent_id AS k, MAX(COALESCE(updated_at, reserved_at)) AS t, 'agent' AS kind
           FROM rfb_marketing_send_ledger WHERE status IN ('sent', 'unknown') GROUP BY agent_id`,
      );
      collect(
        `SELECT LOWER(TRIM(recipient_email)) AS k, MAX(COALESCE(updated_at, reserved_at)) AS t, 'email' AS kind
           FROM rfb_marketing_send_ledger WHERE status IN ('sent', 'unknown') GROUP BY LOWER(TRIM(recipient_email))`,
      );
    }

    for (const p of profiles) {
      if (!grouped.has(p.id)) continue;
      const emails = [norm(p.k_email), norm(p.contact_email)].filter((x): x is string => !!x);
      const anyEmail = (s: ReadonlySet<string>): boolean => emails.some((e) => s.has(e));
      let reason: SiblingHoldReason | null = null;
      if (repliedAgents.has(p.id) || anyEmail(opts.repliedEmails)) reason = "replied";
      else if (optedOutAgents.has(p.id) || anyEmail(opts.removalEmails)) reason = "opted_out";
      else if (
        isBlocked({
          agentId: p.id,
          name: p.name,
          email: (p.k_email ?? p.contact_email) || undefined,
          website: (p.k_website ?? "").trim() || p.url || undefined,
        }).blocked
      )
        reason = "blocklisted";
      else if (recentAgents.has(p.id) || anyEmail(recentEmails) || anyEmail(opts.recentlyEmailedAddresses))
        reason = "recently_sent";
      if (reason) signals.set(p.id, reason);
    }
  }

  const rank = (r: SiblingHoldReason): number => SIBLING_HOLD_REASONS.indexOf(r);

  return {
    shared_domains: byDomain.size,
    lookup(row) {
      if (signals.size === 0) return null;
      let best: SiblingHoldHit | null = null;
      const seen = new Set<string>();
      for (const site of [row.website, row.agent_url]) {
        const d = websiteDomainKey(site);
        if (!d || seen.has(d)) continue;
        seen.add(d);
        for (const sib of byDomain.get(d) ?? []) {
          if (sib === row.agent_id) continue;
          const r = signals.get(sib);
          if (r && (!best || rank(r) < rank(best.reason))) best = { reason: r, sibling_agent_id: sib, domain: d };
        }
      }
      return best;
    },
  };
}

// ── Shadow report (no e-mail addresses, no message content) ─────────────────

export const SIBLING_DOMAIN_SHADOW_EXAMPLES = 20;

export interface SiblingDomainShadowExample {
  agent_id: string;
  name: string;
  sibling_agent_id: string;
  domain: string;
  reason: SiblingHoldReason;
}

export interface SiblingDomainShadow {
  flag: string;
  flag_enabled: boolean;
  /** true when the index could not be built; then nothing was held or counted. */
  unavailable?: true;
  /** Profiles that pass every OTHER suppression and are held by this rule (flag on) / would be (flag off). */
  would_hold: number;
  by_reason: Record<SiblingHoldReason, number>;
  shared_domains: number;
  examples: SiblingDomainShadowExample[];
  truncated: boolean;
}

export function createSiblingDomainShadow(flagEnabled: boolean): SiblingDomainShadow {
  return {
    flag: RFB_OUTREACH_SIBLING_DOMAIN_HOLD_FLAG,
    flag_enabled: flagEnabled,
    would_hold: 0,
    by_reason: { replied: 0, opted_out: 0, blocklisted: 0, recently_sent: 0 },
    shared_domains: 0,
    examples: [],
    truncated: false,
  };
}

export function recordSiblingDomainShadow(
  shadow: SiblingDomainShadow,
  row: { agent_id: string; name: string },
  hit: SiblingHoldHit,
): void {
  shadow.would_hold++;
  shadow.by_reason[hit.reason]++;
  if (shadow.examples.length < SIBLING_DOMAIN_SHADOW_EXAMPLES) {
    shadow.examples.push({
      agent_id: row.agent_id,
      name: row.name,
      sibling_agent_id: hit.sibling_agent_id,
      domain: hit.domain,
      reason: hit.reason,
    });
  } else {
    shadow.truncated = true;
  }
}

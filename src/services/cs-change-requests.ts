// ─── CS på serveren, S4: endringer og fjerning — utført og verifisert av serveren ─
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S4 (erstatter
// 2026-11-10-fjerning-som-serverjobb).
//
// The CS routine no longer writes profiles or deletes. It files a CHANGE
// REQUEST; the server decides whether it may be executed, executes it through
// the SAME admin endpoints (and therefore the same gates and locks) the
// routine used, reads the result back from the public surfaces, and only then
// marks it `verified` — which is what releases a linked reply (S2).
//
//   profile_update  queued → executed → verified | verify_failed
//   removal         queued → hidden (hidden at once + blocklisted)
//                          → after 24 h: deleted (RFB) / stays hidden (Opplevagent,
//                            which has no single-provider delete) → four checks
//                          → verified | verify_failed
//                   cancel before the delete restores visibility and removes
//                   exactly the blocklist rows this request added.
//
// Who may ask (authority): the requester's address is the profile's registered
// address, or on the profile's own (non-free-mail, non-platform) domain, and
// the request came as an e-mail on our thread. Anything else — and anything
// from the public contact form — waits for Daniel in the approval queue.
//
// Every step is written to the request's `steps` log and to a run-ledger row
// (agent cs-change-requests), so what was done is always on record.

import { randomUUID } from "crypto";
import http from "http";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import * as blocklist from "./blocklist-service";
import { isFreeMailDomain, isHostedPlatformHost, isRootWebsite } from "./claim-domain-rule";
import { findCrossVerticalEntriesByEmail } from "./cross-vertical-contact-lookup";
import { slugify } from "../utils/slug";
import { marketplaceRegistry } from "./marketplace-registry";
import { recordRun } from "./run-ledger";
import { EnvelopeBuilder } from "../types/run-envelope";
import type { CrmVertical } from "./crm-service";

export const CS_CHANGE_REQUESTS_FLAG = "CS_CHANGE_REQUESTS_ENABLED";
export function csChangeRequestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[CS_CHANGE_REQUESTS_FLAG];
  return v === "1" || v === "true";
}

export type ChangeKind = "profile_update" | "removal";
export type ChangeVertical = "rfb" | "experiences";
export type ChangeStatus =
  | "approval_needed"
  | "queued"
  | "executing" // claimed by the worker (profile_update / hide in progress)
  | "executed"
  | "hidden"
  | "deleting" // RFB delete claimed by the worker
  | "verified"
  | "verify_failed"
  | "failed"
  | "cancelled"
  | "rejected";

/** Removal: hours between hiding and deleting. */
export const REMOVAL_GRACE_HOURS = 24;
/** profile_update: how long the server keeps re-reading the public surfaces before verify_failed. */
export const VERIFY_WINDOW_HOURS = 2;

// ─── Field maps (the only fields executed automatically) ─────────────

type RfbRoute = "description" | "patch" | "knowledge";
const RFB_FIELDS: Record<string, { route: RfbRoute; key: string; lock: string; column: { table: "agents" | "agent_knowledge"; name: string }; max: number }> = {
  name: { route: "description", key: "name", lock: "name", column: { table: "agents", name: "name" }, max: 200 },
  description: { route: "description", key: "description", lock: "description", column: { table: "agents", name: "description" }, max: 500 },
  city: { route: "patch", key: "city", lock: "city", column: { table: "agents", name: "city" }, max: 100 },
  email: { route: "knowledge", key: "email", lock: "email", column: { table: "agent_knowledge", name: "email" }, max: 254 },
  phone: { route: "knowledge", key: "phone", lock: "phone", column: { table: "agent_knowledge", name: "phone" }, max: 40 },
  address: { route: "knowledge", key: "address", lock: "address", column: { table: "agent_knowledge", name: "address" }, max: 300 },
  postalCode: { route: "knowledge", key: "postalCode", lock: "postal_code", column: { table: "agent_knowledge", name: "postal_code" }, max: 10 },
  website: { route: "knowledge", key: "website", lock: "website", column: { table: "agent_knowledge", name: "website" }, max: 500 },
  about: { route: "knowledge", key: "about", lock: "about", column: { table: "agent_knowledge", name: "about" }, max: 4000 },
};

const EXP_FIELDS: Record<string, { path: string; body: (v: string) => Record<string, unknown>; lock?: string; column: string; max: number }> = {
  name: { path: "gardssalg-set-provider-name", body: (v) => ({ value: v }), column: "navn", max: 200 },
  email: { path: "gardssalg-set-contact-email", body: (v) => ({ email: v, force: false }), column: "epost", max: 254 },
  phone: { path: "gardssalg-set-contact-phone", body: (v) => ({ phone: v }), column: "telefon", max: 40 },
  address: { path: "gardssalg-set-address", body: (v) => ({ value: v }), column: "adresse", max: 300 },
  about_text: { path: "gardssalg-set-content-field", body: (v) => ({ field: "about_text", value: v }), lock: "about_text", column: "about_text", max: 4000 },
  visit_text: { path: "gardssalg-set-content-field", body: (v) => ({ field: "visit_text", value: v }), lock: "visit_text", column: "visit_text", max: 4000 },
  opening_hours_text: { path: "gardssalg-set-content-field", body: (v) => ({ field: "opening_hours_text", value: v }), lock: "opening_hours_text", column: "opening_hours_text", max: 1000 },
};

/**
 * Fields the public surfaces may legitimately not render (an e-mail behind
 * «Vis e-post»). Only these may be verified from the database alone — every
 * other field must show on the public page / API.
 */
const NOT_RENDERED: Record<ChangeVertical, readonly string[]> = { rfb: ["email"], experiences: ["email"] };

export function supportedFields(vertical: ChangeVertical): string[] {
  return Object.keys(vertical === "rfb" ? RFB_FIELDS : EXP_FIELDS);
}

// ─── Transport seams (self-HTTP to the server's own routes) ──────────

export interface HttpResult {
  status: number;
  body: string;
  json: any;
  location: string | null;
}
export type AdminCall = (method: string, path: string, body?: unknown) => Promise<HttpResult>;
export type PublicFetch = (path: string, host: string) => Promise<HttpResult>;

function localRequest(method: string, path: string, headers: Record<string, string>, body?: string): Promise<HttpResult> {
  const port = Number(process.env.PORT || 3000);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "User-Agent": "lokal-cs-change-requests/1 (internal)", ...headers }, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        if (chunks.reduce((n, b) => n + b.length, 0) < 2_000_000) chunks.push(c);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, body: text, json, location: (res.headers.location as string | undefined) ?? null });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The server calling its own admin route: same gates, same locks, same audit as the routine used. The key never leaves the process. */
export const defaultAdminCall: AdminCall = (method, path, body) => {
  const key = process.env.ADMIN_KEY || "";
  if (!key) return Promise.reject(new Error("ADMIN_KEY is not set"));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return localRequest(method, path, {
    "X-Admin-Key": key,
    Host: "rettfrabonden.com",
    ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
  }, payload);
};

/** A public page or API exactly as a visitor gets it (no admin key, the platform's Host). */
export const defaultPublicFetch: PublicFetch = (path, host) => localRequest("GET", path, { Host: host, Accept: "text/html,application/json" });

// ─── Row ─────────────────────────────────────────────────────────────

export interface ChangeRequestRow {
  id: string;
  vertical: ChangeVertical;
  target_id: string;
  target_name: string | null;
  thread_id: string | null;
  requester_email: string;
  kind: ChangeKind;
  changes: string;
  evidence: string | null;
  authority: string;
  status: ChangeStatus;
  status_reason: string | null;
  steps: string;
  snapshot: string | null;
  blocklist_ids: string;
  cross_vertical: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
  hidden_at: string | null;
  delete_after: string | null;
  deleted_at: string | null;
  verified_at: string | null;
  attempts: number;
  /** A removal's blocklist plan (JSON array of {type, value}), saved before anything changes. */
  blocklist_plan: string | null;
}

/** The visibility before a removal, its blocklist plan and the rows that already existed. */
interface RemovalSnapshot {
  is_active?: number;
  catalog_hidden?: number;
  catalog_hidden_reason?: string | null;
  plan?: Array<{ type: string; value: string }>;
  blocklist_before?: string[];
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && Object.keys(v).length > 0 ? (v as T) : null;
  } catch {
    return null;
  }
}

export function getChangeRequest(id: string): ChangeRequestRow | null {
  return (getDb().prepare("SELECT * FROM cs_change_requests WHERE id = ?").get(id) as ChangeRequestRow | undefined) ?? null;
}

export function listChangeRequests(opts: { status?: string; threadId?: string; limit?: number } = {}): Array<ChangeRequestRow & { age_hours: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status === "open") where.push("status IN ('approval_needed', 'queued', 'executing', 'executed', 'hidden', 'deleting')");
  else if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.threadId) {
    where.push("thread_id = ?");
    params.push(opts.threadId);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return (
    getDb()
      .prepare(
        `SELECT *, (julianday('now') - julianday(created_at)) * 24.0 AS age_hours FROM cs_change_requests
          ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ${limit}`,
      )
      .all(...params) as Array<ChangeRequestRow & { age_hours: number }>
  ).map((r) => ({ ...r, age_hours: Math.round(Number(r.age_hours) * 10) / 10 }));
}

function addStep(id: string, step: string, ok: boolean, detail?: unknown, now: Date = new Date()): void {
  const db = getDb();
  const row = db.prepare("SELECT steps FROM cs_change_requests WHERE id = ?").get(id) as { steps: string } | undefined;
  let steps: unknown[] = [];
  try {
    steps = JSON.parse(row?.steps ?? "[]");
  } catch {
    steps = [];
  }
  steps.push({ at: now.toISOString(), step, ok, ...(detail === undefined ? {} : { detail }) });
  db.prepare("UPDATE cs_change_requests SET steps = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(steps).slice(0, 200_000), now.toISOString(), id);
}

/** Set the status; with `from`, only if the row is still in that status (compare-and-set). Returns whether it changed. */
function setStatus(
  id: string,
  status: ChangeStatus,
  reason: string | null,
  extra: Record<string, string | number | null> = {},
  now: Date = new Date(),
  from?: ChangeStatus,
): boolean {
  const cols = Object.keys(extra);
  const r = getDb()
    .prepare(
      `UPDATE cs_change_requests SET status = ?, status_reason = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")}
        WHERE id = ?${from ? " AND status = ?" : ""}`,
    )
    .run(status, reason, now.toISOString(), ...cols.map((c) => extra[c]), id, ...(from ? [from] : []));
  return r.changes === 1;
}

// ─── Targets ─────────────────────────────────────────────────────────

interface Target {
  id: string;
  name: string;
  emails: string[];
  domains: string[];
  websites: string[];
  slug: string | null;
  orgNr: string | null;
}

function domainOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = blocklist.normalizeDomain(s.includes("@") ? s.split("@").pop()! : s);
  return d || null;
}

/** A domain that may identify ONE business (never free-mail, ISP or a shared platform host). */
export function isOwnBusinessDomain(d: string | null): d is string {
  if (!d) return false;
  if (blocklist.PROTECTED_DOMAINS.has(d)) return false;
  if (isFreeMailDomain(d) || isHostedPlatformHost(d)) return false;
  return !["rettfrabonden.com", "opplevagent.no", "finn-tannlege.com", "lokal.fly.dev"].includes(d);
}

export function loadTarget(vertical: ChangeVertical, targetId: string): Target | null {
  if (vertical === "rfb") {
    const a = getDb()
      .prepare(
        `SELECT a.id, a.name, a.contact_email, a.url, a.org_nr, k.email AS k_email, k.website AS k_website
           FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`,
      )
      .get(targetId) as { id: string; name: string; contact_email: string | null; url: string | null; org_nr: string | null; k_email: string | null; k_website: string | null } | undefined;
    if (!a) return null;
    const emails = [a.contact_email, a.k_email].map((e) => blocklist.normalizeEmail(e)).filter((e): e is string => !!e);
    // Only a ROOT website on the business's own domain identifies it (claim
    // rule P1): never an e-mail's mail host, never a deep page on an umbrella
    // or shop domain.
    const websites = [a.url, a.k_website].filter((w): w is string => !!w && w.trim() !== "" && isRootWebsite(w));
    const domains = websites.map(domainOf).filter(isOwnBusinessDomain);
    return { id: a.id, name: a.name, emails: [...new Set(emails)], domains: [...new Set(domains)], websites, slug: slugify(a.name), orgNr: a.org_nr ?? null };
  }
  const p = getVerticalDb("experiences")
    .prepare(`SELECT id, navn, epost, hjemmeside, slug, org_nr FROM experience_providers WHERE id = ?`)
    .get(targetId) as { id: string; navn: string; epost: string | null; hjemmeside: string | null; slug: string | null; org_nr: string | null } | undefined;
  if (!p) return null;
  const emails = [blocklist.normalizeEmail(p.epost)].filter((e): e is string => !!e);
  const websites = [p.hjemmeside].filter((w): w is string => !!w && w.trim() !== "" && isRootWebsite(w));
  const domains = websites.map(domainOf).filter(isOwnBusinessDomain);
  return { id: p.id, name: p.navn, emails, domains: [...new Set(domains)], websites, slug: p.slug, orgNr: p.org_nr ?? null };
}

// ─── Authority ───────────────────────────────────────────────────────

export interface AuthorityResult {
  ok: boolean;
  authority: "registered_email" | "own_domain" | "none";
  reason: string | null;
}

/**
 * May this request be executed without Daniel? Only when the requester is
 * the profile's registered address or on its own domain AND the request is an
 * e-mail from that address on our thread (never the contact form alone).
 */
export function checkAuthority(input: {
  vertical: ChangeVertical;
  target: Target;
  requesterEmail: string;
  threadId: string | null;
  evidenceMessageId: string | null;
  kind?: ChangeKind;
}): AuthorityResult {
  const requester = blocklist.normalizeEmail(input.requesterEmail);
  const none = (reason: string): AuthorityResult => ({ ok: false, authority: "none", reason });
  if (!requester) return none("ugyldig_avsender");
  if (!input.threadId) return none("ingen_traad");
  if (input.threadId.startsWith("kontakt-")) return none("kontaktskjema");
  const db = getDb();
  const thread = db.prepare("SELECT id, vertical_id FROM crm_threads WHERE id = ?").get(input.threadId) as { id: string; vertical_id: string } | undefined;
  if (!thread) return none("ingen_traad");
  if (thread.vertical_id !== input.vertical) return none("feil_plattform");
  // A removal cannot be undone after 24 h: its evidence must be an e-mail the
  // SERVER received (Resend inbound). That is proven by the server's own
  // inbound_email_log row (written only by the webhook) whose message id the
  // CRM message carries — never by raw_metadata, which /admin/crm/ingest
  // stores as the caller sent it.
  const serverOnly = input.kind === "removal";
  const msg = db
    .prepare(
      `SELECT m.id FROM crm_messages m WHERE m.thread_id = ? AND m.direction = 'in' AND LOWER(TRIM(m.from_email)) = ?
         ${input.evidenceMessageId ? "AND m.id = ?" : ""}
         ${
           serverOnly
             ? `AND EXISTS (SELECT 1 FROM inbound_email_log l
                             WHERE ('rsnd-' || COALESCE(l.email_id, l.id)) = m.id
                               AND LOWER(TRIM(l.from_email)) = LOWER(TRIM(m.from_email)))`
             : ""
         }
        LIMIT 1`,
    )
    .get(...([input.threadId, requester, ...(input.evidenceMessageId ? [input.evidenceMessageId] : [])] as unknown[])) as { id: string } | undefined;
  if (!msg) return none(serverOnly ? "fjerning_krever_serverregistrert_e-post" : "ingen_melding_fra_avsender_i_traaden");
  if (input.target.emails.includes(requester)) return { ok: true, authority: "registered_email", reason: null };
  const d = domainOf(requester);
  if (isOwnBusinessDomain(d) && input.target.domains.includes(d!)) return { ok: true, authority: "own_domain", reason: null };
  return none("avsender_ikke_profilens_adresse");
}

// ─── Create ──────────────────────────────────────────────────────────

export interface CreateChangeRequestInput {
  vertical: ChangeVertical;
  targetId: string;
  threadId: string | null;
  requesterEmail: string;
  kind: ChangeKind;
  changes?: Record<string, string>;
  evidence?: { messageId?: string | null; quote?: string | null } | null;
  createdBy: "claude" | "daniel";
  apply?: boolean;
}

export type CreateChangeRequestResult =
  | { ok: true; dryRun: true; plan: Record<string, unknown> }
  | { ok: true; dryRun: false; request: ChangeRequestRow }
  | { ok: false; status: number; error: string; detail?: unknown };

export function createChangeRequest(input: CreateChangeRequestInput, deps: { env?: NodeJS.ProcessEnv; now?: Date } = {}): CreateChangeRequestResult {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const target = loadTarget(input.vertical, input.targetId);
  if (!target) return { ok: false, status: 404, error: "target_not_found" };
  const changes = input.changes ?? {};
  if (input.kind === "profile_update") {
    const keys = Object.keys(changes);
    if (keys.length === 0) return { ok: false, status: 400, error: "no_changes" };
    const allowed = supportedFields(input.vertical);
    const unsupported = keys.filter((k) => !allowed.includes(k));
    if (unsupported.length) return { ok: false, status: 422, error: "unsupported_fields", detail: { unsupported, supported: allowed } };
    for (const k of keys) {
      const max = (input.vertical === "rfb" ? RFB_FIELDS[k]?.max : EXP_FIELDS[k]?.max) ?? 1000;
      if (typeof changes[k] !== "string" || changes[k].length > max) return { ok: false, status: 400, error: "invalid_value", detail: { field: k, max } };
    }
  }
  const auth = checkAuthority({
    vertical: input.vertical,
    target,
    requesterEmail: input.requesterEmail,
    threadId: input.threadId,
    evidenceMessageId: input.evidence?.messageId ?? null,
    kind: input.kind,
  });
  // One open request per profile and kind: a retried apply must not create a
  // second one (two removals of one profile would defeat «cancel»).
  const open = getDb()
    .prepare(
      `SELECT id, status FROM cs_change_requests
        WHERE vertical = ? AND target_id = ? AND kind = ? AND status IN ('approval_needed', 'queued', 'executing', 'executed', 'hidden', 'deleting')
        LIMIT 1`,
    )
    .get(input.vertical, target.id, input.kind) as { id: string; status: string } | undefined;
  // (removals only: several open profile updates for one profile are fine)
  if (open && input.apply && input.kind === "removal") return { ok: false, status: 409, error: "open_request_exists", detail: open };
  const jobOn = csChangeRequestsEnabled(env);
  const status: ChangeStatus = auth.ok && jobOn ? "queued" : "approval_needed";
  const reason = !auth.ok ? auth.reason : jobOn ? null : "endringsjobben_er_av";
  const plan = {
    vertical: input.vertical,
    target: { id: target.id, name: target.name },
    kind: input.kind,
    changes: input.kind === "profile_update" ? changes : undefined,
    authority: auth.authority,
    would_be: status,
    reason,
    removal:
      input.kind === "removal"
        ? {
            hide_now: true,
            delete_after_hours: input.vertical === "rfb" ? REMOVAL_GRACE_HOURS : null,
            note: input.vertical === "experiences" ? "Opplevagent har ingen sletting av én tilbyder: skjult med «fjern oss» er den endelige fjerningen." : undefined,
            blocklist: removalBlocklistPlan(input.vertical, target, input.requesterEmail),
          }
        : undefined,
  };
  if (!input.apply) return { ok: true, dryRun: true, plan };

  const id = `chg-${randomUUID()}`;
  const ts = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO cs_change_requests
         (id, vertical, target_id, target_name, thread_id, requester_email, kind, changes, evidence, authority,
          status, status_reason, steps, blocklist_ids, created_by, created_at, updated_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, 0)`,
    )
    .run(
      id,
      input.vertical,
      target.id,
      target.name,
      input.threadId,
      blocklist.normalizeEmail(input.requesterEmail),
      input.kind,
      JSON.stringify(changes),
      input.evidence ? JSON.stringify(input.evidence) : null,
      auth.authority,
      status,
      reason,
      input.createdBy,
      ts,
      ts,
    );
  addStep(id, "created", true, { authority: auth.authority, status, reason }, now);
  return { ok: true, dryRun: false, request: getChangeRequest(id)! };
}

// ─── Blocklist for a removal ─────────────────────────────────────────

/**
 * Is this identifier used by ANOTHER active profile (either vertical)? Then it
 * is not blocklisted: an e-mail block stops that producer's order mails, a
 * domain or name block stops its listing.
 */
export function identifierUsedElsewhere(type: string, value: string, vertical: ChangeVertical, targetId: string): boolean {
  try {
    const db = getDb();
    const agents = db
      .prepare(`SELECT a.id, a.name, a.contact_email, a.url, a.org_nr, k.email AS k_email, k.website AS k_website FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.is_active = 1`)
      .all() as Array<{ id: string; name: string; contact_email: string | null; url: string | null; org_nr: string | null; k_email: string | null; k_website: string | null }>;
    const exp = getVerticalDb("experiences")
      .prepare(`SELECT id, navn, epost, hjemmeside, org_nr FROM experience_providers WHERE COALESCE(catalog_hidden, 0) = 0`)
      .all() as Array<{ id: string; navn: string; epost: string | null; hjemmeside: string | null; org_nr: string | null }>;
    const otherAgents = agents.filter((a) => !(vertical === "rfb" && a.id === targetId));
    const otherProviders = exp.filter((p) => !(vertical === "experiences" && p.id === targetId));
    if (type === "email") {
      return (
        otherAgents.some((a) => [a.contact_email, a.k_email].some((e) => blocklist.normalizeEmail(e) === value)) ||
        otherProviders.some((p) => blocklist.normalizeEmail(p.epost) === value)
      );
    }
    if (type === "website_domain") {
      return otherAgents.some((a) => [a.url, a.k_website].some((w) => domainOf(w) === value)) || otherProviders.some((p) => domainOf(p.hjemmeside) === value);
    }
    if (type === "name_normalized") {
      return otherAgents.some((a) => blocklist.normalizeName(a.name) === value) || otherProviders.some((p) => blocklist.normalizeName(p.navn) === value);
    }
    if (type === "org_nr") {
      return otherAgents.some((a) => blocklist.normalizeOrgNr(a.org_nr) === value) || otherProviders.some((p) => blocklist.normalizeOrgNr(p.org_nr) === value);
    }
    return false;
  } catch {
    // Cannot tell → do not block (a missing block is fixable; a wrong one silently hurts someone else).
    return true;
  }
}

export function removalBlocklistPlan(vertical: ChangeVertical, target: Target, requesterEmail: string): Array<{ type: string; value: string }> {
  const out: Array<{ type: string; value: string }> = [];
  const push = (type: string, value: string | null | undefined) => {
    if (!value || out.some((o) => o.type === type && o.value === value)) return;
    if (type !== "agent_id" && identifierUsedElsewhere(type, value, vertical, target.id)) return;
    out.push({ type, value });
  };
  push("email", blocklist.normalizeEmail(requesterEmail));
  for (const e of target.emails) push("email", e);
  for (const w of target.websites) {
    const d = domainOf(w);
    if (isOwnBusinessDomain(d)) push("website_domain", d);
  }
  if (vertical === "rfb") push("agent_id", target.id.toLowerCase());
  push("org_nr", blocklist.normalizeOrgNr(target.orgNr));
  push("name_normalized", blocklist.normalizeName(target.name));
  return out;
}

function blocklistIdsFor(pairs: Array<{ type: string; value: string }>): Map<string, number> {
  const m = new Map<string, number>();
  const stmt = getDb().prepare("SELECT id FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ?");
  for (const p of pairs) {
    const r = stmt.get(p.type, p.value) as { id: number } | undefined;
    if (r) m.set(`${p.type}|${p.value}`, r.id);
  }
  return m;
}

// ─── Execute ─────────────────────────────────────────────────────────

export interface ExecDeps {
  now?: Date;
  adminCall?: AdminCall;
  publicFetch?: PublicFetch;
  env?: NodeJS.ProcessEnv;
}

function normText(s: string): string {
  return s
    .replace(/<[^<>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function digits(s: string): string {
  return s.replace(/\D/g, "").replace(/^0047|^47(?=\d{8}$)/, "");
}

/** Does `value` show in `surface` (HTML or JSON text)? Field-aware normalization. */
export function valueShows(field: string, value: string, surface: string): boolean {
  if (!value.trim()) return false;
  if (field === "phone") {
    const d = digits(value);
    return d.length >= 8 && digits(surface).includes(d.slice(-8));
  }
  if (field === "website") {
    const v = value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    return surface.toLowerCase().includes(v);
  }
  return normText(surface).includes(normText(value));
}

interface Surfaces {
  text: string;
  /** Every surface answered 2xx — only then can a value's absence mean anything. */
  ok: boolean;
  statuses: Record<string, number>;
}

async function surfaces(vertical: ChangeVertical, target: Target, deps: ExecDeps): Promise<Surfaces> {
  const fetchPublic = deps.publicFetch ?? defaultPublicFetch;
  if (vertical === "rfb") {
    const card = await fetchPublic(`/api/marketplace/agents/${encodeURIComponent(target.id)}/card`, "rettfrabonden.com").catch(() => null);
    const page = await fetchPublic(`/produsent/${encodeURIComponent(slugify(target.name))}`, "rettfrabonden.com").catch(() => null);
    const cs = card?.status ?? 0;
    const ps = page?.status ?? 0;
    return { text: `${card?.body ?? ""}\n${page?.body ?? ""}`, ok: okStatus(cs) && okStatus(ps), statuses: { card: cs, page: ps } };
  }
  const page = target.slug ? await fetchPublic(`/kategori/gardssalg/produsent/${encodeURIComponent(target.slug)}`, "opplevagent.no").catch(() => null) : null;
  const ps = page?.status ?? 0;
  return { text: page?.body ?? "", ok: okStatus(ps), statuses: { page: ps } };
}

function dbValue(vertical: ChangeVertical, targetId: string, field: string): string | null {
  try {
    if (vertical === "rfb") {
      const f = RFB_FIELDS[field];
      const row = getDb()
        .prepare(f.column.table === "agents" ? `SELECT ${f.column.name} AS v FROM agents WHERE id = ?` : `SELECT ${f.column.name} AS v FROM agent_knowledge WHERE agent_id = ?`)
        .get(targetId) as { v: unknown } | undefined;
      return row?.v == null ? null : String(row.v);
    }
    const row = getVerticalDb("experiences").prepare(`SELECT ${EXP_FIELDS[field].column} AS v FROM experience_providers WHERE id = ?`).get(targetId) as { v: unknown } | undefined;
    return row?.v == null ? null : String(row.v);
  } catch {
    return null;
  }
}

function okStatus(s: number): boolean {
  return s >= 200 && s < 300;
}

const FAILED_CALL = (e: any): HttpResult => ({ status: 0, body: String(e?.message ?? e), json: null, location: null });

async function executeProfileUpdate(r: ChangeRequestRow, deps: ExecDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const call = deps.adminCall ?? defaultAdminCall;
  // Claim it: a cancel/reject that lands from here on finds it «executing».
  if (!setStatus(r.id, "executing", null, {}, now, "queued")) return;
  const changes = JSON.parse(r.changes || "{}") as Record<string, string>;
  const target = loadTarget(r.vertical, r.target_id);
  if (!target) {
    addStep(r.id, "load_target", false, "profilen finnes ikke lenger", now);
    setStatus(r.id, "failed", "profil_mangler", {}, now, "executing");
    return;
  }
  // A re-run after an interrupted attempt keeps the FIRST attempt's old
  // values: by now the database may already hold the new ones.
  const prior = parseJson<Record<string, { old: string | null }>>(r.snapshot);
  const snapshot: Record<string, { old: string | null }> = {};
  for (const f of Object.keys(changes)) snapshot[f] = prior && f in prior ? prior[f] : { old: dbValue(r.vertical, r.target_id, f) };
  getDb().prepare("UPDATE cs_change_requests SET snapshot = ? WHERE id = ?").run(JSON.stringify(snapshot), r.id);
  const evidence = (() => {
    try {
      return JSON.parse(r.evidence ?? "{}") as { messageId?: string };
    } catch {
      return {};
    }
  })();
  const source = `crm-thread:${r.thread_id ?? "-"} cs-change-request:${r.id}`;
  const meta = { locked_at: now.toISOString(), by: "rfb-customer-service", thread_id: r.thread_id, request_summary: `cs-change-request ${r.id}` };

  const failures: string[] = [];
  if (r.vertical === "rfb") {
    const desc: Record<string, string> = {};
    const patch: Record<string, string> = {};
    const know: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(changes)) {
      const m = RFB_FIELDS[f];
      if (m.route === "description") desc[m.key] = v;
      else if (m.route === "patch") patch[m.key] = v;
      else know[m.key] = v;
    }
    if (changes.phone !== undefined) {
      know.owner_relay_evidence = { channel: "email", ref: evidence.messageId ?? r.thread_id ?? r.id, received_at: r.created_at };
    }
    const base = `/api/marketplace/agents/${encodeURIComponent(r.target_id)}`;
    for (const [route, body] of [["description", desc], ["patch", patch], ["knowledge", know]] as const) {
      if (Object.keys(body).filter((k) => k !== "owner_relay_evidence").length === 0) continue;
      const res = await call(
        route === "patch" ? "PATCH" : "PUT",
        route === "description" ? `${base}/description` : route === "patch" ? base : `${base}/knowledge`,
        route === "knowledge" ? { ...body, dataSource: "owner" } : body,
      ).catch(FAILED_CALL);
      const skipped = res.json?.skipped;
      const phoneRefused = route === "knowledge" && changes.phone !== undefined && res.json?.phone_write && res.json.phone_write.allowed === false;
      const ok = okStatus(res.status) && !(Array.isArray(skipped) && skipped.length > 0) && !phoneRefused;
      addStep(r.id, `write_${route}`, ok, { status: res.status, fields: Object.keys(body), skipped: skipped ?? null, phone_write: res.json?.phone_write ?? null }, now);
      if (!ok) failures.push(`${route}: HTTP ${res.status}${skipped ? ` skipped=${JSON.stringify(skipped)}` : ""}${phoneRefused ? " telefon avvist" : ""}`);
    }
    if (failures.length === 0) {
      for (const f of Object.keys(changes)) {
        const res = await call("POST", `/api/marketplace/admin/agents/${encodeURIComponent(r.target_id)}/curated-fields`, { field: RFB_FIELDS[f].lock, meta }).catch(FAILED_CALL);
        addStep(r.id, `lock_${RFB_FIELDS[f].lock}`, okStatus(res.status), { status: res.status }, now);
      }
    }
    try {
      (marketplaceRegistry as any).invalidateCache?.();
    } catch {
      /* cache refreshes on its own within 60 s */
    }
  } else {
    for (const [f, v] of Object.entries(changes)) {
      const m = EXP_FIELDS[f];
      const res = await call("POST", `/api/opplevelser/admin/${m.path}`, { provider_id: r.target_id, source, ...m.body(v) }).catch(FAILED_CALL);
      const ok = okStatus(res.status) && res.json?.success !== false && !res.json?.error;
      addStep(r.id, `write_${f}`, ok, { status: res.status, response: res.json ?? res.body.slice(0, 300) }, now);
      if (!ok) {
        failures.push(`${f}: HTTP ${res.status}${res.json?.error ? ` ${res.json.error}` : ""}`);
        continue;
      }
      if (m.lock) {
        const l = await call("POST", "/api/opplevelser/admin/gardssalg-set-field-lock", { provider_id: r.target_id, field: m.lock, lock: true, source }).catch(FAILED_CALL);
        addStep(r.id, `lock_${m.lock}`, okStatus(l.status), { status: l.status }, now);
      }
    }
  }
  if (failures.length > 0) {
    setStatus(r.id, "failed", `skriving_feilet: ${failures.join("; ")}`.slice(0, 500), {}, now, "executing");
    return;
  }
  if (!setStatus(r.id, "executed", null, { executed_at: now.toISOString() }, now, "executing")) return;
  await verifyProfileUpdate(getChangeRequest(r.id)!, deps);
}

export async function verifyProfileUpdate(r: ChangeRequestRow, deps: ExecDeps): Promise<boolean> {
  const now = deps.now ?? new Date();
  const changes = JSON.parse(r.changes || "{}") as Record<string, string>;
  const snapshot = JSON.parse(r.snapshot || "{}") as Record<string, { old: string | null }>;
  const target = loadTarget(r.vertical, r.target_id);
  if (!target) {
    setStatus(r.id, "verify_failed", "profil_mangler", {}, now, "executed");
    return false;
  }
  const s = await surfaces(r.vertical, target, deps);
  const windowOver = now.getTime() - Date.parse(r.executed_at ?? r.updated_at) > VERIFY_WINDOW_HOURS * 3600_000;
  if (!s.ok) {
    // A page or API that did not answer proves nothing either way.
    addStep(r.id, "verify", false, { surfaces: s.statuses, note: "offentlig side/API svarte ikke 2xx — prøver igjen" }, now);
    if (windowOver) setStatus(r.id, "verify_failed", `offentlige flater svarte ikke: ${JSON.stringify(s.statuses)}`, {}, now, "executed");
    return false;
  }
  const results: Record<string, string> = {};
  let all = true;
  for (const [f, v] of Object.entries(changes)) {
    const stored = dbValue(r.vertical, r.target_id, f) ?? "";
    const inDb = stored === v || (f === "phone" && digits(v).length >= 8 && digits(stored).endsWith(digits(v).slice(-8)));
    if (!inDb) {
      results[f] = "ikke_lagret";
      all = false;
      continue;
    }
    if (v.trim() === "") {
      const old = snapshot[f]?.old;
      const gone = !old || !valueShows(f, old, s.text);
      results[f] = gone ? "fjernet_fra_siden" : "vises_fortsatt";
      all = all && gone;
      continue;
    }
    if (valueShows(f, v, s.text)) {
      results[f] = "vises_offentlig";
    } else if (NOT_RENDERED[r.vertical].includes(f)) {
      // This field is not rendered publicly (e.g. an e-mail behind «Vis e-post»):
      // read back from the database instead, and say so.
      results[f] = "lagret (feltet vises ikke offentlig)";
    } else {
      results[f] = "ikke_synlig_ennaa";
      all = false;
    }
  }
  addStep(r.id, "verify", all, { surfaces: s.statuses, fields: results }, now);
  if (all) {
    setStatus(r.id, "verified", null, { verified_at: now.toISOString() }, now, "executed");
    return true;
  }
  if (windowOver) setStatus(r.id, "verify_failed", `ikke synlig etter ${VERIFY_WINDOW_HOURS} t: ${JSON.stringify(results)}`.slice(0, 500), {}, now, "executed");
  return false;
}

/** Every blocklist row a removal of this target could add — ours AND the Opplevagent visibility route's own (org_nr, e-post, nettside). */
function trackedBlocklistPairs(vertical: ChangeVertical, target: Target, plan: Array<{ type: string; value: string }>): Array<{ type: string; value: string }> {
  const pairs = [...plan];
  const add = (type: string, value: string | null | undefined) => {
    if (value && !pairs.some((p) => p.type === type && p.value === value)) pairs.push({ type, value });
  };
  if (vertical === "experiences") {
    const p = getVerticalDb("experiences").prepare("SELECT org_nr, epost, hjemmeside FROM experience_providers WHERE id = ?").get(target.id) as
      | { org_nr: string | null; epost: string | null; hjemmeside: string | null }
      | undefined;
    if (p) {
      add("org_nr", blocklist.normalizeOrgNr(p.org_nr));
      add("email", blocklist.normalizeEmail(p.epost));
      add("website_domain", domainOf(p.hjemmeside));
    }
  }
  return pairs;
}

const REMOVAL_REASON = (id: string) => `kunden ba om fjerning — CS-forespørsel ${id}`;

async function executeRemovalHide(r: ChangeRequestRow, deps: ExecDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const call = deps.adminCall ?? defaultAdminCall;
  if (!setStatus(r.id, "executing", null, {}, now, "queued")) return;
  const target = loadTarget(r.vertical, r.target_id);
  if (!target) {
    addStep(r.id, "load_target", false, "profilen finnes ikke lenger", now);
    setStatus(r.id, "failed", "profil_mangler", {}, now, "executing");
    return;
  }
  // A re-run after an interrupted attempt reuses the first attempt's
  // snapshot: the visibility before the removal, the plan, and which
  // blocklist rows were already there — so a cancel still restores exactly
  // the state before the removal.
  const prior = parseJson<RemovalSnapshot>(r.snapshot);
  const plan = prior?.plan ?? removalBlocklistPlan(r.vertical, target, r.requester_email);
  const tracked = trackedBlocklistPairs(r.vertical, target, plan);
  const before = new Set(prior?.blocklist_before ?? [...blocklistIdsFor(tracked).keys()]);
  let snapshot: RemovalSnapshot;
  if (r.vertical === "rfb") {
    const prev = getDb().prepare("SELECT is_active, catalog_hidden FROM agents WHERE id = ?").get(r.target_id) as { is_active: number; catalog_hidden: number | null };
    snapshot = prior ?? { is_active: prev.is_active, catalog_hidden: prev.catalog_hidden ?? 0, plan, blocklist_before: [...before] };
  } else {
    const prev = getVerticalDb("experiences").prepare("SELECT catalog_hidden, catalog_hidden_reason FROM experience_providers WHERE id = ?").get(r.target_id) as
      | { catalog_hidden: number | null; catalog_hidden_reason: string | null }
      | undefined;
    snapshot = prior ?? { catalog_hidden: prev?.catalog_hidden ?? 0, catalog_hidden_reason: prev?.catalog_hidden_reason ?? null, plan, blocklist_before: [...before] };
  }
  const visibility = { ...snapshot, plan: undefined, blocklist_before: undefined };
  // Saved BEFORE anything changes.
  getDb().prepare("UPDATE cs_change_requests SET snapshot = ?, blocklist_plan = ? WHERE id = ?").run(JSON.stringify(snapshot), JSON.stringify(plan), r.id);
  if (r.vertical === "rfb") {
    const db = getDb();
    db.transaction(() => {
      db.prepare("UPDATE agents SET is_active = 0, catalog_hidden = 1 WHERE id = ?").run(r.target_id);
      db.prepare(
        `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'is_active', ?, '0', 'system', ?, ?, ?)`,
      ).run(randomUUID(), r.target_id, String(snapshot.is_active ?? 1), r.requester_email, now.toISOString(), `${REMOVAL_REASON(r.id)}: skjult, slettes etter ${REMOVAL_GRACE_HOURS} t`);
    })();
    try {
      (marketplaceRegistry as any).invalidateCache?.();
    } catch {
      /* ignore */
    }
    addStep(r.id, "hide", true, { is_active: 0, catalog_hidden: 1, previous: visibility }, now);
  } else {
    const xdb = getVerticalDb("experiences");
    const res = await call("POST", "/api/opplevelser/admin/gardssalg-provider-visibility", {
      providerIds: [r.target_id],
      hidden: true,
      apply: true,
      mode: "remove_request",
      confirm_owned: true,
      // The blocklist is written below from the plan (shared identifiers
      // left out); the route must not add its own rows.
      skip_blocklist: true,
    }).catch(FAILED_CALL);
    // 200 alone is not proof: the route answers 200 with the row in
    // skipped_locked / not_found too. Accept only «changed» (or «unchanged»
    // when it already was hidden as a removal) AND the row reads hidden now.
    const inBucket = (k: string) => Array.isArray(res.json?.[k]) && res.json[k].some((x: any) => x?.id === r.target_id);
    const now2 = xdb.prepare("SELECT catalog_hidden, catalog_hidden_reason FROM experience_providers WHERE id = ?").get(r.target_id) as
      | { catalog_hidden: number | null; catalog_hidden_reason: string | null }
      | undefined;
    const hiddenNow = now2?.catalog_hidden === 1;
    const ok = okStatus(res.status) && (inBucket("changed") || (inBucket("unchanged") && now2?.catalog_hidden_reason === "remove_request")) && hiddenNow;
    const bucket = ["changed", "unchanged", "skipped_locked", "skipped_owned", "skipped_owner_removed", "not_found"].find(inBucket) ?? "ingen";
    addStep(r.id, "hide", ok, { status: res.status, bucket, hidden_now: hiddenNow, previous: visibility }, now);
    if (!ok) {
      setStatus(r.id, "failed", `skjuling_feilet: HTTP ${res.status}, ${bucket}`, {}, now, "executing");
      return;
    }
  }
  const reason = REMOVAL_REASON(r.id);
  for (const p of plan) {
    try {
      if (p.type === "email") blocklist.add({ email: p.value, reason, sourceEmail: r.requester_email, agentNameForAudit: target.name });
      else if (p.type === "website_domain") blocklist.add({ website: p.value, reason, sourceEmail: r.requester_email, agentNameForAudit: target.name });
      else if (p.type === "agent_id") blocklist.add({ agentId: p.value, reason, sourceEmail: r.requester_email, agentNameForAudit: target.name });
      else if (p.type === "org_nr") blocklist.add({ orgNr: p.value, reason, sourceEmail: r.requester_email, agentNameForAudit: target.name });
      else if (p.type === "name_normalized") blocklist.add({ name: target.name, reason, sourceEmail: r.requester_email });
    } catch (e: any) {
      addStep(r.id, `blocklist_${p.type}`, false, String(e?.message ?? e), now);
    }
  }
  let after = blocklistIdsFor(tracked);
  // Anything this removal added that is NOT in the plan (a route that still
  // wrote its own rows) comes out again: the plan alone decides, and it
  // leaves out identifiers another active profile uses.
  const unplanned = [...after.entries()].filter(([k]) => !before.has(k) && !plan.some((p) => `${p.type}|${p.value}` === k));
  if (unplanned.length > 0) {
    for (const [, id] of unplanned) blocklist.remove({ id });
    addStep(r.id, "blocklist_unplanned_removed", true, { removed: unplanned.map(([k]) => k) }, now);
    after = blocklistIdsFor(tracked);
  }
  const added = [...after.entries()].filter(([k]) => !before.has(k)).map(([k, v]) => ({ key: k, id: v }));
  // The name row records which org.nr it was about, so a different business
  // with the same name is not blocked (blocklist isBlocked, Mål 3). Only on a
  // row this removal itself added.
  const orgNr = blocklist.normalizeOrgNr(target.orgNr);
  const nameRow = added.find((a) => a.key.startsWith("name_normalized|"));
  if (orgNr && nameRow) getDb().prepare("UPDATE agent_blocklist SET linked_org_nr = ? WHERE id = ? AND linked_org_nr IS NULL").run(orgNr, nameRow.id);
  addStep(r.id, "blocklist", plan.every((p) => after.has(`${p.type}|${p.value}`)), { planned: plan, added: added.map((a) => a.key), already: [...before] }, now);
  const cross = [...new Set([r.requester_email, ...target.emails])].flatMap((e) => {
    try {
      return findCrossVerticalEntriesByEmail(e, r.vertical as CrmVertical);
    } catch {
      return [];
    }
  });
  addStep(r.id, "cross_vertical", true, cross.length ? { hits: cross, note: "Ikke endret på andre plattformer — vurderes av Daniel." } : { hits: [] }, now);
  const deleteAfter = new Date(now.getTime() + REMOVAL_GRACE_HOURS * 3600_000).toISOString();
  getDb()
    .prepare("UPDATE cs_change_requests SET snapshot = ?, blocklist_ids = ?, cross_vertical = ? WHERE id = ?")
    .run(JSON.stringify(snapshot), JSON.stringify(added.map((a) => a.id)), JSON.stringify(cross), r.id);
  setStatus(r.id, "hidden", null, { hidden_at: now.toISOString(), delete_after: deleteAfter, executed_at: now.toISOString() }, now, "executing");
}

/**
 * Every blocklist row the removal planned is there (plus `always`). The plan
 * leaves out identifiers another active profile uses, so a shared address
 * does not keep a removal from verifying.
 */
function plannedRowsPresent(r: ChangeRequestRow, always: Array<{ type: string; value: string }>): boolean {
  const plan = parseJsonArray<{ type: string; value: string }>(r.blocklist_plan);
  const pairs = [...plan, ...always];
  const have = blocklistIdsFor(pairs);
  return pairs.every((p) => have.has(`${p.type}|${p.value}`));
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

async function removalChecks(r: ChangeRequestRow, deps: ExecDeps): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
  const fetchPublic = deps.publicFetch ?? defaultPublicFetch;
  const name = r.target_name ?? "";
  const checks: Record<string, unknown> = {};
  let ok = true;
  if (r.vertical === "rfb") {
    const card = await fetchPublic(`/api/marketplace/agents/${encodeURIComponent(r.target_id)}/card`, "rettfrabonden.com").catch(() => null);
    const slug = slugify(name);
    const page = await fetchPublic(`/produsent/${encodeURIComponent(slug)}`, "rettfrabonden.com").catch(() => null);
    const search = await fetchPublic(`/api/marketplace/search?q=${encodeURIComponent(name)}`, "rettfrabonden.com").catch(() => null);
    const pageGone = !!page && (page.status === 404 || (page.status >= 300 && page.status < 400 && !(page.location ?? "").endsWith(`/${slug}`)));
    checks.by_id = card?.status ?? "feil";
    checks.profile_page = page ? `${page.status}${page.location ? ` → ${page.location}` : ""}` : "feil";
    checks.not_in_search = !!search && okStatus(search.status) && !search.body.includes(r.target_id);
    const bl = plannedRowsPresent(r, [{ type: "agent_id", value: r.target_id.toLowerCase() }]);
    checks.blocklisted = bl;
    ok = card?.status === 404 && pageGone && checks.not_in_search === true && bl;
  } else {
    const t = loadTarget("experiences", r.target_id);
    const page = t?.slug ? await fetchPublic(`/kategori/gardssalg/produsent/${encodeURIComponent(t.slug)}`, "opplevagent.no").catch(() => null) : null;
    const disc = await fetchPublic(`/api/opplevelser/discover?category=gardssalg_smaking&q=${encodeURIComponent(name)}`, "opplevagent.no").catch(() => null);
    const hidden = (getVerticalDb("experiences").prepare("SELECT catalog_hidden FROM experience_providers WHERE id = ?").get(r.target_id) as { catalog_hidden: number } | undefined)?.catalog_hidden === 1;
    checks.hidden_in_db = hidden;
    checks.profile_page = page?.status ?? (t?.slug ? "feil" : "ingen_slug");
    checks.not_in_discover = !!disc && okStatus(disc.status) && !disc.body.includes(r.target_id) && !(t?.slug && disc.body.includes(t.slug));
    const bl = plannedRowsPresent(r, []);
    checks.blocklisted = bl;
    ok = hidden && (page === null ? !t?.slug : page.status === 404) && checks.not_in_discover === true && bl;
  }
  return { ok, checks };
}

async function executeRemovalFinish(r: ChangeRequestRow, deps: ExecDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const call = deps.adminCall ?? defaultAdminCall;
  if (r.vertical === "rfb" && !r.deleted_at) {
    // Claim the delete: a cancel from here on is refused (it only acts on
    // «hidden»). A «deleting» row here was reclaimed by the worker after an
    // interrupted delete (reclaimStale); DELETE is idempotent (404 accepted).
    if (r.status === "hidden") {
      if (!setStatus(r.id, "deleting", null, {}, now, "hidden")) return;
    } else if (r.status !== "deleting") {
      return;
    }
    const res = await call("DELETE", `/api/marketplace/agents/${encodeURIComponent(r.target_id)}?force=1`, {
      reason: REMOVAL_REASON(r.id),
      sourceEmail: r.requester_email,
      // The blocklist was written at hide time with the own-domain and
      // shared-identifier rules; the route's own fallback must not add more.
      skipBlocklist: true,
    }).catch(FAILED_CALL);
    const ok = okStatus(res.status) || res.status === 404;
    addStep(r.id, "delete", ok, { status: res.status, response: res.json ?? res.body.slice(0, 300) }, now);
    if (!ok) {
      // 423 = enrichment write pause, 0 = busy: still hidden, retried next tick.
      getDb().prepare("UPDATE cs_change_requests SET attempts = attempts + 1 WHERE id = ?").run(r.id);
      if (r.attempts + 1 >= 48) setStatus(r.id, "failed", `sletting_feilet: HTTP ${res.status} (${r.attempts + 1} forsøk)`, {}, now, "deleting");
      else setStatus(r.id, "hidden", `sletting utsatt: HTTP ${res.status}`, {}, now, "deleting");
      return;
    }
    getDb().prepare("UPDATE cs_change_requests SET deleted_at = ? WHERE id = ?").run(now.toISOString(), r.id);
  }
  const cur = getChangeRequest(r.id)!;
  const { ok, checks } = await removalChecks(cur, deps);
  addStep(r.id, "checks", ok, checks, now);
  const from: ChangeStatus = cur.status === "deleting" ? "deleting" : "hidden";
  if (ok) {
    setStatus(r.id, "verified", null, { verified_at: now.toISOString() }, now, from);
    return;
  }
  const base = Date.parse(r.delete_after ?? r.updated_at);
  if (now.getTime() - base > VERIFY_WINDOW_HOURS * 3600_000) setStatus(r.id, "verify_failed", `kontroller feilet: ${JSON.stringify(checks)}`.slice(0, 500), {}, now, from);
}

// ─── Daniel's actions ────────────────────────────────────────────────

export function approveChangeRequest(
  id: string,
  actor: "daniel" = "daniel",
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
  source: "admin-crm" | "api" = "api",
): { ok: true; request: ChangeRequestRow; note?: string } | { ok: false; status: number; error: string } {
  const r = getChangeRequest(id);
  if (!r) return { ok: false, status: 404, error: "not_found" };
  if (r.status !== "approval_needed") return { ok: false, status: 409, error: `status_${r.status}` };
  if (!setStatus(id, "queued", null, {}, now, "approval_needed")) return { ok: false, status: 409, error: "status_changed" };
  getDb().prepare("UPDATE cs_change_requests SET authority = 'approved' WHERE id = ?").run(id);
  addStep(id, "approved", true, { by: actor, source }, now);
  return { ok: true, request: getChangeRequest(id)!, ...(csChangeRequestsEnabled(env) ? {} : { note: `${CS_CHANGE_REQUESTS_FLAG} er av — utføres når jobben slås på` }) };
}

export function rejectChangeRequest(id: string, reason: string, actor: "daniel" | "claude" = "daniel", now: Date = new Date()): { ok: true } | { ok: false; status: number; error: string } {
  const r = getChangeRequest(id);
  if (!r) return { ok: false, status: 404, error: "not_found" };
  if (r.status !== "approval_needed" && r.status !== "queued") return { ok: false, status: 409, error: `status_${r.status}` };
  if (!setStatus(id, "rejected", reason, {}, now, r.status)) return { ok: false, status: 409, error: "status_changed" };
  addStep(id, "rejected", true, { by: actor, reason }, now);
  return { ok: true };
}

/** Undo a removal before the delete: visible again, and exactly the blocklist rows this request added are removed. */
export async function cancelChangeRequest(id: string, reason: string, deps: ExecDeps = {}): Promise<{ ok: true; request: ChangeRequestRow } | { ok: false; status: number; error: string }> {
  const now = deps.now ?? new Date();
  const r = getChangeRequest(id);
  if (!r) return { ok: false, status: 404, error: "not_found" };
  if (r.status === "approval_needed" || r.status === "queued") {
    if (!setStatus(id, "cancelled", reason, {}, now, r.status)) return { ok: false, status: 409, error: "status_changed" };
    addStep(id, "cancelled", true, { reason }, now);
    return { ok: true, request: getChangeRequest(id)! };
  }
  if (r.kind !== "removal" || r.status !== "hidden" || r.deleted_at) return { ok: false, status: 409, error: `cannot_cancel_${r.status}${r.deleted_at ? "_deleted" : ""}` };
  // Claim it first: the worker's delete only starts from «hidden».
  if (!setStatus(id, "executing", "angrer", {}, now, "hidden")) return { ok: false, status: 409, error: "status_changed" };
  const snap = JSON.parse(r.snapshot || "{}") as { is_active?: number; catalog_hidden?: number; catalog_hidden_reason?: string | null };
  if (r.vertical === "rfb") {
    const db = getDb();
    db.prepare("UPDATE agents SET is_active = ?, catalog_hidden = ? WHERE id = ?").run(snap.is_active ?? 1, snap.catalog_hidden ?? 0, r.target_id);
    db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_at, notes)
       VALUES (?, ?, 'is_active', '0', ?, 'system', ?, ?)`,
    ).run(randomUUID(), r.target_id, String(snap.is_active ?? 1), now.toISOString(), `fjern oss angret (cs-change-request ${r.id})`);
    try {
      (marketplaceRegistry as any).invalidateCache?.();
    } catch {
      /* ignore */
    }
  } else {
    const call = deps.adminCall ?? defaultAdminCall;
    const res = await call("POST", "/api/opplevelser/admin/gardssalg-provider-visibility", {
      providerIds: [r.target_id],
      hidden: false,
      apply: true,
      mode: "remove_request",
      confirm_owned: true,
      override_owner_removed: true,
    }).catch(FAILED_CALL);
    addStep(id, "unhide", okStatus(res.status), { status: res.status }, now);
    if (!okStatus(res.status)) {
      setStatus(id, "hidden", null, {}, now, "executing");
      return { ok: false, status: 502, error: `unhide_failed_${res.status}` };
    }
    // It was already hidden before the removal (quality, the owner's own
    // pause, …): put that back exactly. Written directly — the route only
    // knows the modes «quality» and «remove_request».
    if (snap.catalog_hidden === 1 && snap.catalog_hidden_reason !== "remove_request") {
      const xdb = getVerticalDb("experiences");
      xdb.prepare("UPDATE experience_providers SET catalog_hidden = 1, catalog_hidden_reason = ?, updated_at = datetime('now') WHERE id = ?").run(snap.catalog_hidden_reason ?? null, r.target_id);
      const back = xdb.prepare("SELECT catalog_hidden, catalog_hidden_reason FROM experience_providers WHERE id = ?").get(r.target_id) as
        | { catalog_hidden: number | null; catalog_hidden_reason: string | null }
        | undefined;
      const restored = back?.catalog_hidden === 1 && (back?.catalog_hidden_reason ?? null) === (snap.catalog_hidden_reason ?? null);
      addStep(id, "restore_previous_hide", restored, { reason: snap.catalog_hidden_reason ?? null }, now);
    }
  }
  const ids = JSON.parse(r.blocklist_ids || "[]") as number[];
  let removed = 0;
  for (const bid of ids) removed += blocklist.remove({ id: bid });
  addStep(id, "cancelled", true, { reason, restored: snap, blocklist_rows_removed: removed }, now);
  setStatus(id, "cancelled", reason, {}, now, "executing");
  return { ok: true, request: getChangeRequest(id)! };
}

// ─── Worker ──────────────────────────────────────────────────────────

/** A claim («executing», «deleting») older than this was interrupted (restart, deploy). Each step's HTTP calls time out after 30 s. */
export const STALE_CLAIM_MINUTES = 20;
const MAX_RECLAIMS = 3;

function reclaim(r: ChangeRequestRow, to: ChangeStatus, reason: string | null, now: Date): boolean {
  const res = getDb()
    .prepare("UPDATE cs_change_requests SET status = ?, status_reason = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ? AND status = ? AND updated_at = ?")
    .run(to, reason, now.toISOString(), r.id, r.status, r.updated_at);
  return res.changes === 1;
}

/**
 * Pick up a claim a restart left behind. A write or hide is re-run from
 * «queued» (both are idempotent, and the first attempt's snapshot is kept);
 * an interrupted cancel goes to «failed» for Daniel (half restored); a
 * delete is retried. After MAX_RECLAIMS it stops at «failed».
 */
async function reclaimStale(r: ChangeRequestRow, deps: ExecDeps): Promise<void> {
  const now = deps.now ?? new Date();
  if (r.status === "deleting") {
    if (!reclaim(r, "deleting", "sletting avbrutt underveis — prøver igjen", now)) return;
    addStep(r.id, "reclaimed", true, { from: "deleting", attempt: r.attempts + 1 }, now);
    await executeRemovalFinish(getChangeRequest(r.id)!, deps);
    return;
  }
  if (r.status_reason === "angrer") {
    if (reclaim(r, "failed", "angring avbrutt underveis — sjekk synlighet og sperreliste", now)) addStep(r.id, "reclaimed", false, { from: "executing", note: "angring avbrutt" }, now);
    return;
  }
  if (r.attempts >= MAX_RECLAIMS) {
    if (reclaim(r, "failed", `avbrutt underveis ${r.attempts} ganger`, now)) addStep(r.id, "reclaimed", false, { from: "executing", attempts: r.attempts }, now);
    return;
  }
  if (!reclaim(r, "queued", "avbrutt underveis — kjøres på nytt", now)) return;
  addStep(r.id, "reclaimed", true, { from: "executing", attempt: r.attempts + 1 }, now);
  const again = getChangeRequest(r.id)!;
  if (again.kind === "profile_update") await executeProfileUpdate(again, deps);
  else await executeRemovalHide(again, deps);
}

export interface ChangeRunResult {
  run_id: string | null;
  processed: Array<{ id: string; from: string; to: string }>;
  envelope_recorded: boolean;
}

export async function runCsChangeRequests(deps: ExecDeps & { trigger?: "cron" | "manual"; limit?: number } = {}): Promise<ChangeRunResult> {
  const now = deps.now ?? new Date();
  const db = getDb();
  const limit = Math.min(Math.max(deps.limit ?? 20, 1), 50);
  const due = db
    .prepare(
      `SELECT id FROM cs_change_requests
        WHERE status = 'queued'
           OR (status = 'executed' AND kind = 'profile_update')
           OR (status = 'hidden' AND kind = 'removal' AND julianday(delete_after) <= julianday(?))
           OR (status = 'deleting' AND kind = 'removal' AND deleted_at IS NOT NULL)
           OR (status IN ('executing', 'deleting') AND deleted_at IS NULL AND julianday(updated_at) <= julianday(?) - ? / 1440.0)
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), now.toISOString(), STALE_CLAIM_MINUTES, limit) as Array<{ id: string }>;
  const processed: ChangeRunResult["processed"] = [];
  for (const d of due) {
    const r = getChangeRequest(d.id);
    if (!r) continue;
    const from = r.status;
    try {
      if (r.status === "queued") {
        if (r.kind === "profile_update") await executeProfileUpdate(r, deps);
        else await executeRemovalHide(r, deps);
      } else if (r.status === "executed") {
        await verifyProfileUpdate(r, deps);
      } else if (r.status === "executing" || (r.status === "deleting" && !r.deleted_at)) {
        await reclaimStale(r, deps);
      } else if (r.status === "hidden" || r.status === "deleting") {
        await executeRemovalFinish(r, deps);
      }
    } catch (e: any) {
      addStep(r.id, "exception", false, String(e?.message ?? e), now);
      setStatus(r.id, "failed", `unntak: ${String(e?.message ?? e)}`.slice(0, 500), {}, now, getChangeRequest(r.id)?.status as ChangeStatus);
    }
    const after = getChangeRequest(d.id)!;
    if (after.status !== from || from === "queued" || after.attempts !== r.attempts) processed.push({ id: d.id, from, to: after.status });
  }
  if (processed.length === 0) return { run_id: null, processed, envelope_recorded: false };
  const runId = `run-${now.toISOString().slice(0, 19).replace(/[:]/g, "")}-cs-change-requests`;
  const env = new EnvelopeBuilder({ run_id: runId, vertical: "rfb", agent: "cs-change-requests", trigger_source: deps.trigger ?? "cron" });
  for (const p of processed) {
    const r = getChangeRequest(p.id)!;
    let steps: unknown[] = [];
    try {
      steps = JSON.parse(r.steps);
    } catch {
      steps = [];
    }
    env.claim({
      type: "custom",
      value: r.status === "verified" ? 1 : 0,
      meta: { kind: "cs_change_request", id: r.id, vertical: r.vertical, target: r.target_id, request_kind: r.kind, from: p.from, to: r.status, reason: r.status_reason, steps: steps.slice(-8) },
    });
    if (r.status === "failed" || r.status === "verify_failed") env.error(`${r.id} ${r.status}: ${r.status_reason ?? ""}`);
  }
  env.notes(processed.map((p) => `${p.id}: ${p.from}→${p.to}`).join("; ").slice(0, 2000));
  const bad = processed.some((p) => p.to === "failed" || p.to === "verify_failed");
  let recorded = false;
  try {
    recordRun(env.finish(bad ? "partial" : "completed"));
    recorded = true;
  } catch (e) {
    console.error("[cs-change-requests] recordRun failed:", e);
  }
  return { run_id: runId, processed, envelope_recorded: recorded };
}

// ─── Product import: outreach landing (Skive 3b-2, owner side) ──────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 3b-2: the
// owner side of the outreach pre-extraction (3b-1 staged the candidates).
//
//   Signed link   one per recipient: /eier/:id/varer/forslag?t=<token>
//                   token   = po1.<payload>.<sig>
//                   payload = base64url(JSON {a: agent_id, c: campaign, i: issued-at unix s})
//                   sig     = avmeld-service serverSignatureFor("product-import-outreach-v1", payload)
//                 (the per-purpose key derived from the existing server secret,
//                 as the /avmeld and /lagerstatus links; never the raw secret).
//                 Valid OUTREACH_LINK_VALID_DAYS (30) from issue; verified with
//                 a constant-time compare; bound to the agent in the path. The
//                 token is stateless (not stored); rotating the server secret
//                 invalidates every outstanding link. Never logged.
//                 The token alone never shows candidates and never writes
//                 anything except the append-only 'opened' log row: the page
//                 also needs the owner session (verifyOwnerSession) of a
//                 verified owner (isVerifiedOwner + agents.is_verified = 1).
//   Links         getOutreachLinks(): the admin list for POST /admin/crm/compose
//                 — recipients whose latest campaign run has ≥ 1 eligible
//                 candidate get a link; the rest are listed without one.
//   Freshness     resolveOutreachView(): the list shown is the campaign's
//                 3b-1 run, or the owner fetch started from this page when
//                 that list was older than OUTREACH_FRESH_DAYS (7). The
//                 re-fetch is the Skive 3 owner fetch (startOwnerFetch: counts
//                 against the 3/day limit, stages 'pending' candidates only,
//                 never touches products) and is started by a GET only for a
//                 verified owner's session — never for an e-mail scanner,
//                 which has no session — at most once per 7 days per
//                 recipient and campaign. While it runs the page refreshes
//                 itself; if it fails or cannot start (limit / busy), the
//                 previous list is shown with its fetch date.
//   Log           product_import_outreach_events: opened / refetch_started /
//                 confirmed (count, in_stock). getOutreachLog() is the admin
//                 read per recipient (extracted = the 3b-1 run).
//
// Flag: PRODUCT_IMPORT_OUTREACH_ENABLED (outreach-prepare.ts) — off = 404.

import crypto, { randomUUID } from "crypto";
import { getDb } from "../../database/init";
import { serverSignatureFor } from "../avmeld-service";
import { OUTREACH_CAMPAIGN_RE, outreachLlmAllowed } from "./outreach-prepare";
import { startOwnerFetch, type StartFetchResult } from "./owner-import";

export const OUTREACH_LINK_VALID_DAYS = 30;
export const OUTREACH_FRESH_DAYS = 7;
export const OUTREACH_LANDING_SUFFIX = "/varer/forslag";
export const OUTREACH_RETURN_COOKIE = "rfb_owner_return";
const SIGN_PURPOSE = "product-import-outreach-v1";
const TOKEN_VERSION = "po1";
const MAX_TOKEN_LENGTH = 600;
const DAY_MS = 86_400_000;
/** Issued-at may be at most this far in the future (clock skew between instances). */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** One 'opened' row per recipient, campaign and session state per hour (the running page refreshes itself). */
const OPENED_DEDUPE_MS = 60 * 60_000;

// ── Test seams ──────────────────────────────────────────────────────────────

let testNow: (() => number) | null = null;
/** Test-only: a fixed clock for the landing page and the links. */
export function __setOutreachLandingClockForTesting(now: (() => number) | null): void {
  testNow = now;
}
export function outreachNowMs(): number {
  return (testNow ?? Date.now)();
}

const sqlTs = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const parseTs = (ts: string | null | undefined): number => {
  if (!ts) return NaN;
  return new Date(/T/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`).getTime();
};

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ── Token ───────────────────────────────────────────────────────────────────

/** A signed token for (agent, campaign, issued-at); null when no server secret is set. */
export function makeOutreachToken(agentId: string, campaign: string, issuedAtMs: number): string | null {
  if (!agentId || !OUTREACH_CAMPAIGN_RE.test(campaign)) return null;
  const payload = b64url(Buffer.from(JSON.stringify({ a: agentId, c: campaign, i: Math.floor(issuedAtMs / 1000) }), "utf8"));
  const sig = serverSignatureFor(SIGN_PURPOSE, payload);
  return sig ? `${TOKEN_VERSION}.${payload}.${sig}` : null;
}

export type OutreachTokenState =
  | { state: "valid"; agent_id: string; campaign: string; issued_at_ms: number; expires_at_ms: number }
  | { state: "invalid" }
  | { state: "expired" };

/**
 * Signature, shape, agent binding and expiry. A token for another agent than
 * `agentId` (the path) is invalid. Never throws; reveals nothing on a bad token.
 */
export function verifyOutreachToken(token: unknown, agentId: string, nowMs: number = outreachNowMs()): OutreachTokenState {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { state: "invalid" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { state: "invalid" };
    const [, payload, sig] = parts as [string, string, string];
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return { state: "invalid" };
    const expected = serverSignatureFor(SIGN_PURPOSE, payload);
    if (!expected || !safeEqual(sig, expected)) return { state: "invalid" };
    const p = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!p || typeof p !== "object" || typeof p.a !== "string" || !p.a || typeof p.c !== "string"
      || !OUTREACH_CAMPAIGN_RE.test(p.c) || typeof p.i !== "number" || !Number.isFinite(p.i)) return { state: "invalid" };
    if (!agentId || !safeEqual(p.a, agentId)) return { state: "invalid" };
    const issued = p.i * 1000;
    if (issued > nowMs + MAX_FUTURE_SKEW_MS) return { state: "invalid" };
    const expires = issued + OUTREACH_LINK_VALID_DAYS * DAY_MS;
    if (nowMs >= expires) return { state: "expired" };
    return { state: "valid", agent_id: p.a, campaign: p.c, issued_at_ms: issued, expires_at_ms: expires };
  } catch {
    return { state: "invalid" };
  }
}

export function outreachLandingPath(agentId: string, token: string): string {
  return `/eier/${encodeURIComponent(agentId)}${OUTREACH_LANDING_SUFFIX}?t=${encodeURIComponent(token)}`;
}

export function outreachLandingUrl(agentId: string, token: string): string {
  const base = process.env.APP_URL || "https://rettfrabonden.com";
  return `${base}${outreachLandingPath(agentId, token)}`;
}

/**
 * The landing path to return to after the /eier magic-link login, from the
 * rfb_owner_return cookie the landing page set — only when it is exactly the
 * landing path of THIS agent (no open redirect). null otherwise.
 */
export function outreachReturnPathFor(cookieHeader: string | undefined, cookies: Record<string, unknown> | undefined, agentId: string): string | null {
  let raw: unknown = cookies?.[OUTREACH_RETURN_COOKIE];
  if (typeof raw !== "string" && cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const i = pair.indexOf("=");
      if (i > 0 && pair.slice(0, i).trim() === OUTREACH_RETURN_COOKIE) {
        try { raw = decodeURIComponent(pair.slice(i + 1).trim()); } catch { raw = undefined; }
      }
    }
  }
  if (typeof raw !== "string" || !agentId || raw.length > 800) return null;
  const prefix = `/eier/${encodeURIComponent(agentId)}${OUTREACH_LANDING_SUFFIX}?t=`;
  if (!raw.startsWith(prefix)) return null;
  return /^[A-Za-z0-9._%-]+$/.test(raw.slice(prefix.length)) ? raw : null;
}

// ── Runs of a recipient ─────────────────────────────────────────────────────

interface PrepareRunRow { id: string; status: string; created_at: string; finished_at: string | null }
interface OwnerRunRow { id: string; status: string; created_at: string }

/** The campaign's latest 3b-1 run for this agent, or null. */
export function latestPrepareRun(agentId: string, campaign: string): PrepareRunRow | null {
  return (getDb()
    .prepare(
      `SELECT id, status, created_at, finished_at FROM product_import_runs
        WHERE mode = 'outreach_prepare' AND agent_id = ? AND campaign = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(agentId, campaign) as PrepareRunRow | undefined) ?? null;
}

function refetchEvents(agentId: string, campaign: string): Array<{ run_id: string; created_at: string }> {
  return getDb()
    .prepare(
      `SELECT run_id, created_at FROM product_import_outreach_events
        WHERE campaign = ? AND agent_id = ? AND event = 'refetch_started' AND run_id IS NOT NULL
        ORDER BY created_at DESC, id DESC`,
    )
    .all(campaign, agentId) as Array<{ run_id: string; created_at: string }>;
}

function ownerRun(agentId: string, runId: string): OwnerRunRow | null {
  return (getDb()
    .prepare(`SELECT id, status, created_at FROM product_import_runs WHERE id = ? AND mode = 'owner_fetch' AND agent_id = ?`)
    .get(runId, agentId) as OwnerRunRow | undefined) ?? null;
}

function candidateCount(runId: string): number {
  return (getDb()
    .prepare(`SELECT COUNT(*) AS n FROM product_import_candidates WHERE run_id = ?`)
    .get(runId) as { n: number }).n;
}

// ── Freshness ───────────────────────────────────────────────────────────────

export type OutreachNotice = "refetch_failed" | "refetch_unavailable" | "stale";

export type OutreachView =
  | { kind: "none" }
  | { kind: "running"; run_id: string }
  | { kind: "list"; mode: "outreach_prepare" | "owner_fetch"; run_id: string; extracted_at: string; notice: OutreachNotice | null; refetch_error?: string };

/**
 * Which list the page shows. With `allowRefetch` (a verified owner's session)
 * a list older than OUTREACH_FRESH_DAYS starts one owner fetch — unless one
 * was already started from this page in the last OUTREACH_FRESH_DAYS. The
 * owner-fetch states mirror the Skive 3 preview: 'running' only while this
 * process runs the job (else it reads as failed / interrupted).
 */
export function resolveOutreachView(
  agentId: string,
  campaign: string,
  opts: { nowMs?: number; allowRefetch: boolean; isJobRunning: (runId: string) => boolean; startFetch?: (agentId: string) => StartFetchResult },
): OutreachView {
  const nowMs = opts.nowMs ?? outreachNowMs();
  const prep = latestPrepareRun(agentId, campaign);
  // No run, or one still marked running (in progress or cut off by a restart):
  // nothing to show yet — never a page that refreshes itself forever.
  if (!prep || prep.status === "running") return { kind: "none" };
  const events = refetchEvents(agentId, campaign);
  const latest = events.length ? ownerRun(agentId, events[0]!.run_id) : null;
  let current: { mode: "outreach_prepare" | "owner_fetch"; run_id: string; extracted_at: string } = {
    mode: "outreach_prepare", run_id: prep.id, extracted_at: prep.finished_at ?? prep.created_at,
  };
  let notice: OutreachNotice | null = null;
  if (latest) {
    if (latest.status === "running" && opts.isJobRunning(latest.id)) return { kind: "running", run_id: latest.id };
    // A re-fetch that found nothing counts as failed: the previous list stays.
    if (latest.status === "completed" && candidateCount(latest.id) > 0) {
      current = { mode: "owner_fetch", run_id: latest.id, extracted_at: latest.created_at };
    } else notice = "refetch_failed";
  }
  const age = nowMs - parseTs(current.extracted_at);
  if (!(age > OUTREACH_FRESH_DAYS * DAY_MS)) return { kind: "list", ...current, notice };
  const lastRefetchMs = events.length ? parseTs(events[0]!.created_at) : NaN;
  const recentlyTried = Number.isFinite(lastRefetchMs) && nowMs - lastRefetchMs < OUTREACH_FRESH_DAYS * DAY_MS;
  if (!opts.allowRefetch || recentlyTried) return { kind: "list", ...current, notice: notice ?? "stale" };
  // The 3b rule for the LLM tier holds for the re-fetch too: no LLM call unless
  // the measured accuracy allows it (the page also filters LLM rows out).
  const r = opts.startFetch ? opts.startFetch(agentId) : startOwnerFetch(agentId, undefined, { llmCap: outreachLlmAllowed() ? 1 : 0 });
  if (!r.ok) return { kind: "list", ...current, notice: "refetch_unavailable", refetch_error: r.error };
  logOutreachEvent({ campaign, agentId, event: "refetch_started", runId: r.run_id, nowMs });
  return { kind: "running", run_id: r.run_id };
}

// ── Log ─────────────────────────────────────────────────────────────────────

export type OutreachEvent = "opened" | "refetch_started" | "confirmed";

export function logOutreachEvent(e: {
  campaign: string; agentId: string; event: OutreachEvent; runId?: string | null; count?: number | null;
  inStock?: boolean | null; detail?: string | null; nowMs?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO product_import_outreach_events (id, campaign, agent_id, event, run_id, count, in_stock, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `poe-${randomUUID()}`, e.campaign, e.agentId, e.event, e.runId ?? null, e.count ?? null,
      e.inStock === undefined || e.inStock === null ? null : e.inStock ? 1 : 0, e.detail ?? null, sqlTs(e.nowMs ?? outreachNowMs()),
    );
}

/** 'opened', at most once per hour per recipient, campaign and session state. Best-effort, never throws. */
export function logOutreachOpened(campaign: string, agentId: string, detail: "no_session" | "not_verified" | "owner", nowMs: number = outreachNowMs()): void {
  try {
    const recent = getDb()
      .prepare(
        `SELECT 1 FROM product_import_outreach_events
          WHERE campaign = ? AND agent_id = ? AND event = 'opened' AND detail = ? AND created_at >= ? LIMIT 1`,
      )
      .get(campaign, agentId, detail, sqlTs(nowMs - OPENED_DEDUPE_MS));
    if (!recent) logOutreachEvent({ campaign, agentId, event: "opened", detail, nowMs });
  } catch {
    /* the log never blocks the page */
  }
}

// ── Admin: links + log (READ-ONLY apart from nothing) ──────────────────────

interface CampaignRunRow { id: string; agent_id: string; status: string; params_json: string; created_at: string; finished_at: string | null }

function latestCampaignRuns(campaign: string): CampaignRunRow[] {
  const runs = getDb()
    .prepare(
      `SELECT id, agent_id, status, params_json, created_at, finished_at FROM product_import_runs
        WHERE mode = 'outreach_prepare' AND campaign = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(campaign) as CampaignRunRow[];
  const latest = new Map<string, CampaignRunRow>();
  for (const r of runs) if (!latest.has(r.agent_id)) latest.set(r.agent_id, r);
  return [...latest.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

const agentNameOf = (r: CampaignRunRow): string | null => {
  try {
    const p = JSON.parse(r.params_json || "{}") as { agent_name?: string | null };
    return p.agent_name ?? null;
  } catch {
    return null;
  }
};

function eligibleCount(runId: string): number {
  return (getDb()
    .prepare(`SELECT COUNT(*) AS n FROM product_import_candidates WHERE run_id = ? AND status = 'eligible'`)
    .get(runId) as { n: number }).n;
}

export type OutreachLinksResult =
  | { ok: true; campaign: string; generated_at: string; expires_at: string; recipients: Array<{ agent_id: string; name: string | null; candidate_count: number; url: string }>; without_link: Array<{ agent_id: string; name: string | null; candidate_count: number; reason: "no_candidates" | "still_running" }> }
  | { ok: false; error: "not_found" | "secret_missing" };

/**
 * One signed link per recipient with ≥ 1 eligible candidate in the
 * campaign's latest run; recipients with 0 (or a run still going) get none.
 * Writes nothing (the tokens are stateless).
 */
export function getOutreachLinks(campaign: string, nowMs: number = outreachNowMs()): OutreachLinksResult {
  const runs = latestCampaignRuns(campaign);
  if (runs.length === 0) return { ok: false, error: "not_found" };
  const recipients: Extract<OutreachLinksResult, { ok: true }>["recipients"] = [];
  const without: Extract<OutreachLinksResult, { ok: true }>["without_link"] = [];
  for (const r of runs) {
    const n = eligibleCount(r.id);
    const name = agentNameOf(r);
    if (r.status === "running") { without.push({ agent_id: r.agent_id, name, candidate_count: n, reason: "still_running" }); continue; }
    if (n === 0) { without.push({ agent_id: r.agent_id, name, candidate_count: 0, reason: "no_candidates" }); continue; }
    const token = makeOutreachToken(r.agent_id, campaign, nowMs);
    if (!token) return { ok: false, error: "secret_missing" };
    recipients.push({ agent_id: r.agent_id, name, candidate_count: n, url: outreachLandingUrl(r.agent_id, token) });
  }
  return {
    ok: true,
    campaign,
    generated_at: new Date(nowMs).toISOString(),
    expires_at: new Date(Math.floor(nowMs / 1000) * 1000 + OUTREACH_LINK_VALID_DAYS * DAY_MS).toISOString(),
    recipients,
    without_link: without,
  };
}

interface EventRow { agent_id: string; event: string; run_id: string | null; count: number | null; in_stock: number | null; detail: string | null; created_at: string }

/** The per-recipient log of the campaign (pilot response rate). Never writes; null when the campaign has no runs. */
export function getOutreachLog(campaign: string, nowMs: number = outreachNowMs()) {
  const runs = latestCampaignRuns(campaign);
  if (runs.length === 0) return null;
  const events = getDb()
    .prepare(
      `SELECT agent_id, event, run_id, count, in_stock, detail, created_at FROM product_import_outreach_events
        WHERE campaign = ? ORDER BY created_at, id`,
    )
    .all(campaign) as EventRow[];
  const recipients = runs.map((r) => {
    const ev = events.filter((e) => e.agent_id === r.agent_id);
    const opened = ev.filter((e) => e.event === "opened");
    const confirmed = ev.filter((e) => e.event === "confirmed");
    const lastConfirm = confirmed[confirmed.length - 1] ?? null;
    return {
      agent_id: r.agent_id,
      name: agentNameOf(r),
      extracted: { run_id: r.id, status: r.status, at: r.finished_at ?? r.created_at, eligible: eligibleCount(r.id) },
      opened: {
        count: opened.length,
        first_at: opened[0]?.created_at ?? null,
        last_at: opened[opened.length - 1]?.created_at ?? null,
        by_owner: opened.some((e) => e.detail === "owner"),
      },
      refetches: ev.filter((e) => e.event === "refetch_started").map((e) => ({ run_id: e.run_id, at: e.created_at })),
      confirmed: {
        times: confirmed.length,
        count: confirmed.reduce((n, e) => n + (e.count ?? 0), 0),
        last_at: lastConfirm?.created_at ?? null,
      },
      in_stock: lastConfirm ? lastConfirm.in_stock === 1 : null,
    };
  });
  return {
    campaign,
    generated_at: new Date(nowMs).toISOString(),
    totals: {
      recipients: recipients.length,
      with_candidates: recipients.filter((r) => r.extracted.eligible > 0).length,
      opened: recipients.filter((r) => r.opened.count > 0).length,
      opened_by_owner: recipients.filter((r) => r.opened.by_owner).length,
      confirmed: recipients.filter((r) => r.confirmed.times > 0).length,
      in_stock: recipients.filter((r) => r.in_stock === true).length,
    },
    recipients,
  };
}

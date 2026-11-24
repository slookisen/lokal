// ─── Milestone owner e-mail: TEMPLATE only (no sending) ─────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-5. The owner-feature
// registry entry `notify.milestones` (surface email:owner_milestone, default
// on) promises «En e-post når profilen når 100, 500 og 1000 visninger». This
// module only RENDERS that e-mail for one producer and one milestone. Nothing
// here sends, schedules or writes: Daniel approves the first edition via the
// admin preview (routes/admin-owner-milestone-preview.ts) before any send job
// or flag is built. «Once per milestone» bookkeeping belongs to that future
// job — there is no "sent" state here.
//
// Views: the same definition as the monthly report (owner-monthly-report.ts,
// readProfileViews) — people's profile page views, the owner's own views, bots
// and AI assistants left out — summed cumulatively from the first classified
// day (AGENT_VIEW_CLASSIFIED_SINCE) up to and including today (UTC).
//
// Unsubscribe: a stateless signed token with its OWN purpose string
// (owner-milestone-unsub-v1, tag mu1), so a report-unsubscribe, /avmeld or
// preview token never validates as one and vice versa. The route
// `/milepael-avmeld/:token` (routes/rapport-avmeld.ts) confirms on GET and on
// POST / RFC 8058 one-click sets notify.milestones = false (registry
// `recipientOptOut`, also while the entry is coming_soon).

import type Database from "better-sqlite3";
import { customerRuleSql } from "./customer-rule";
import { AGENT_VIEW_CLASSIFIED_SINCE } from "./profile-year-compute";
import {
  esc,
  headerSafe,
  makeOwnerAgentToken,
  nbNum,
  ownerEmailPublicBase,
  ownerMineValgUrlFor,
  ownerProfilePath,
  readProfileViews,
  verifyOwnerAgentToken,
  type MonthMetric,
} from "./owner-monthly-report";
import { getOwnerFeature, ownerFeatureRegistryFor, ownerFeatureStatus, type OwnerFeatureEntry, type OwnerFeatureStatus } from "../owner-features/registry";
import { featureValue, setOwnerFeatureValue, type SetOwnerFeatureResult } from "../owner-features/resolve";

type Db = Database.Database;

/** The milestones, ascending (registry notify.milestones: 100, 500 and 1000 views). */
export const OWNER_MILESTONES = [100, 500, 1000] as const;
export type OwnerMilestone = (typeof OWNER_MILESTONES)[number];

export const OWNER_MILESTONE_UNSUB_PURPOSE = "owner-milestone-unsub-v1";
const OWNER_MILESTONE_UNSUB_TAG = "mu1";
export const OWNER_MILESTONE_UNSUB_PATH = "/milepael-avmeld/";
/** The value the milestone e-mail's unsubscribe link sets (registry notify.milestones.recipientOptOut). */
export const OWNER_MILESTONE_OFF_VALUE = false;

/** 100 | 500 | 1000 → that milestone; anything else → null. Accepts the query-string form. */
export function parseOwnerMilestone(raw: unknown): OwnerMilestone | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  if (!/^[1-9]\d{0,4}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return (OWNER_MILESTONES as readonly number[]).includes(n) ? (n as OwnerMilestone) : null;
}

/** The highest milestone with total >= milestone, or null when below the first. */
export function highestReachedMilestone(total: number): OwnerMilestone | null {
  let hit: OwnerMilestone | null = null;
  for (const m of OWNER_MILESTONES) if (total >= m) hit = m;
  return hit;
}

/** The first milestone not yet reached, or null when all are. */
export function nextMilestone(total: number): OwnerMilestone | null {
  for (const m of OWNER_MILESTONES) if (total < m) return m;
  return null;
}

// ── Unsubscribe token (own purpose) ─────────────────────────────────────────
export function makeOwnerMilestoneUnsubToken(agentId: string): string | null {
  return makeOwnerAgentToken(OWNER_MILESTONE_UNSUB_PURPOSE, OWNER_MILESTONE_UNSUB_TAG, agentId);
}

export function verifyOwnerMilestoneUnsubToken(token: string): string | null {
  return verifyOwnerAgentToken(OWNER_MILESTONE_UNSUB_PURPOSE, OWNER_MILESTONE_UNSUB_TAG, token);
}

export function ownerMilestoneUnsubscribeUrl(agentId: string): string | null {
  const token = makeOwnerMilestoneUnsubToken(agentId);
  return token ? `${ownerEmailPublicBase()}${OWNER_MILESTONE_UNSUB_PATH}${token}` : null;
}

export function ownerMineValgMilestonesUrl(agentId: string): string {
  return ownerMineValgUrlFor(agentId, "notify.milestones");
}

/**
 * A recipient's unsubscribe — sets the RFB owner feature notify.milestones to
 * false (one owner_feature_audit row when it changed, actor system, detail
 * «milepael-avmeld»). Idempotent. Only ever writes false.
 */
export function recordOwnerMilestoneUnsubscribe(db: Db, agentId: string): SetOwnerFeatureResult {
  return setOwnerFeatureValue(
    "rfb",
    agentId,
    "notify.milestones",
    OWNER_MILESTONE_OFF_VALUE,
    { actor: "system", detail: "milepael-avmeld" },
    { db, recipientOptOut: true },
  );
}

// ── Views ───────────────────────────────────────────────────────────────────
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Cumulative people's views from the first classified day to today (UTC). null = no source. */
export function readCumulativeProfileViews(db: Db, agentId: string, path: string, nowMs: number): MonthMetric | null {
  const to = utcDay(nowMs);
  if (to < AGENT_VIEW_CLASSIFIED_SINCE) return null;
  return readProfileViews(db, agentId, path, { from: AGENT_VIEW_CLASSIFIED_SINCE, to }, nowMs);
}

// ── Render ──────────────────────────────────────────────────────────────────
export interface OwnerMilestoneEmail {
  subject: string;
  text: string;
  html: string;
}

export interface OwnerMilestoneEmailInput {
  producerName: string;
  milestone: OwnerMilestone;
  mineValgUrl: string;
  /** null when no signing secret is configured (no one-click link). */
  unsubscribeUrl: string | null;
}

/** Pure: the e-mail for one milestone. */
export function renderOwnerMilestoneEmail(input: OwnerMilestoneEmailInput): OwnerMilestoneEmail {
  const name = String(input.producerName ?? "").trim() || "profilen din";
  const n = nbNum(input.milestone);
  const subject = headerSafe(`Profilen din har nådd ${n} besøk – Rett fra Bonden`);
  const congrats = `Gratulerer! Profilen til ${name} på Rett fra Bonden har nå hatt ${n} besøk.`;
  const what = "Et besøk er når en person åpner profilsiden din. Dine egne besøk teller ikke, og heller ikke søkemotorer, roboter eller AI-assistenter.";
  const why = "Vi sender denne e-posten én gang når profilen når 100, 500 og 1000 besøk.";

  const textLines: string[] = [
    "Hei!",
    "",
    congrats,
    "",
    what,
    "",
    "Se mer og bestem selv hva profilen din viser i «Mine valg»:",
    input.mineValgUrl,
    "",
    "Hilsen Rett fra Bonden",
    "",
    "--",
    `Du får denne e-posten fordi du eier profilen ${name} på Rett fra Bonden. ${why}`,
    `Slå av e-post om milepæler i «Mine valg»: ${input.mineValgUrl}`,
  ];
  if (input.unsubscribeUrl) textLines.push(`Ikke send flere e-poster om milepæler: ${input.unsubscribeUrl}`);
  const text = textLines.join("\n") + "\n";

  const unsub = input.unsubscribeUrl ? ` · <a href="${esc(input.unsubscribeUrl)}" style="color:#555">Ikke send flere e-poster om milepæler</a>` : "";
  const html = `<!doctype html><html lang="nb"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p>Hei!</p>
<p>${esc(congrats)}</p>
<p>${esc(what)}</p>
<p><a href="${esc(input.mineValgUrl)}" style="color:#2D5016">Se mer og bestem selv i «Mine valg»</a></p>
<p>Hilsen Rett fra Bonden</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">
<p style="color:#555;font-size:13px">Du får denne e-posten fordi du eier profilen ${esc(name)} på Rett fra Bonden. ${esc(why)}<br>
<a href="${esc(input.mineValgUrl)}" style="color:#555">Slå av e-post om milepæler i «Mine valg»</a>${unsub}</p>
</div></body></html>`;

  return { subject, text, html };
}

// ── Build (read + render) ───────────────────────────────────────────────────
export type MilestoneWouldSendReason =
  | "would_send_if_sending_existed"
  | "not_owner"
  | "inactive"
  | "setting_unreadable"
  | "notify_milestones_off"
  | "no_milestone_reached"
  | "milestone_not_reached"
  | "no_signing_secret";

export interface OwnerMilestonePreview {
  agentId: string;
  producerName: string;
  /** Cumulative people's views; null = no source covers any day yet. */
  totalViews: MonthMetric | null;
  reachedMilestone: OwnerMilestone | null;
  nextMilestone: OwnerMilestone | null;
  /** The milestone rendered: the requested one, else the highest reached; null = none. */
  milestone: OwnerMilestone | null;
  /** null when `milestone` is null. */
  email: OwnerMilestoneEmail | null;
  mineValgUrl: string;
  unsubscribeUrl: string | null;
  notifyMilestones: boolean | null;
  notifyMilestonesStatus: OwnerFeatureStatus;
  isOwner: boolean;
  wouldSend: boolean;
  wouldSendReason: MilestoneWouldSendReason;
}

/**
 * Reads the cumulative views and renders the milestone e-mail for one
 * producer. `milestone` picks the template; without it the highest reached
 * milestone is used. null = unknown agent. Read only: SELECTs, no writes, no
 * sending.
 */
export function buildOwnerMilestonePreview(
  db: Db,
  agentId: string,
  opts: { milestone?: OwnerMilestone | null; nowMs?: number; registry?: OwnerFeatureEntry[] } = {},
): OwnerMilestonePreview | null {
  const nowMs = opts.nowMs ?? Date.now();
  const row = db.prepare(
    `SELECT a.id AS id, a.name AS name, a.is_active AS is_active, ${customerRuleSql("a")} AS owned
       FROM agents a WHERE a.id = ?`,
  ).get(agentId) as { id: string; name: string | null; is_active: number | null; owned: number } | undefined;
  if (!row) return null;

  const producerName = String(row.name ?? "");
  const totalViews = readCumulativeProfileViews(db, agentId, ownerProfilePath(producerName), nowMs);
  const total = totalViews?.value ?? 0;
  const reachedMilestone = highestReachedMilestone(total);
  const milestone = opts.milestone ?? reachedMilestone;
  const mineValgUrl = ownerMineValgMilestonesUrl(agentId);
  const unsubscribeUrl = ownerMilestoneUnsubscribeUrl(agentId);

  let notifyMilestones: boolean | null = null;
  let settingOk = true;
  try {
    const v = featureValue("rfb", agentId, "notify.milestones", { db, ...(opts.registry ? { registry: opts.registry } : {}) });
    notifyMilestones = typeof v === "boolean" ? v : null;
  } catch {
    settingOk = false;
  }
  const isOwner = row.owned === 1;
  let wouldSendReason: MilestoneWouldSendReason = "would_send_if_sending_existed";
  if (!isOwner) wouldSendReason = "not_owner";
  else if (row.is_active !== 1) wouldSendReason = "inactive";
  else if (!settingOk) wouldSendReason = "setting_unreadable";
  else if (notifyMilestones === false) wouldSendReason = "notify_milestones_off";
  else if (reachedMilestone === null) wouldSendReason = "no_milestone_reached";
  else if (milestone !== null && milestone > reachedMilestone) wouldSendReason = "milestone_not_reached";
  else if (!unsubscribeUrl) wouldSendReason = "no_signing_secret";

  const email = milestone === null ? null : renderOwnerMilestoneEmail({ producerName, milestone, mineValgUrl, unsubscribeUrl });
  return {
    agentId,
    producerName,
    totalViews,
    reachedMilestone,
    nextMilestone: nextMilestone(total),
    milestone,
    email,
    mineValgUrl,
    unsubscribeUrl,
    notifyMilestones,
    notifyMilestonesStatus: ownerFeatureStatus(getOwnerFeature("notify.milestones", opts.registry ?? ownerFeatureRegistryFor("rfb"))),
    isOwner,
    wouldSend: wouldSendReason === "would_send_if_sending_existed",
    wouldSendReason,
  };
}

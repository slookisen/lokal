/**
 * Stock-check reminder (B2) — dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier,
 * owner feature `products.stock_check`.
 *
 * A producer-stated stock status (availability_source 'producer_dashboard')
 * stops counting after the staleness window (getSupplyGraphStaleDays(), 14
 * days, supply-graph.ts); the item is then no longer orderable. This module
 * tells the owner before that happens:
 *
 *   Trigger   at least one ORDERABLE row (cart-service orderabilityReasons(),
 *             the same core as the real-order gate) whose producer-stated
 *             status expires within STOCK_CHECK_WARN_DAYS (3) days, AND the
 *             owner feature `products.stock_check` is on for the producer —
 *             rfbFeatureOn(), which requires `orders.enabled` (the order
 *             opt-in) and honours the owner's own «av».
 *   Portal    the /eier portal shows a banner above «Varer som kan bestilles»
 *             (routes/owner-portal.ts, behind B1's OWNER_ORDERABILITY_PORTAL_ENABLED).
 *   E-mail    processStockCheckReminders(): at most ONE e-mail per producer per
 *             STOCK_CHECK_EMAIL_WINDOW_DAYS (14) days. The send is reserved
 *             BEFORE it is made: inside one BEGIN IMMEDIATE transaction the job
 *             checks that the producer has no stock_check_notices row newer
 *             than 14 days and inserts one (status 'claimed'). Only the run
 *             whose insert lands sends, so overlapping runs, two instances
 *             and restarts never double-send. A failed send stays recorded
 *             ('failed') and is not retried inside the window — a duplicate
 *             is worse than a miss, and the banner still shows.
 *   Link      the e-mail links to /lagerstatus/:token. The token is signed,
 *             expiring (STOCK_CHECK_LINK_VALID_DAYS) and bound to ONE producer
 *             and ONE notice row (the e-mail's list of items):
 *               s1.<payload>.<sig>
 *               payload = base64url(JSON {a: agent_id, n: nonce, x: expiry unix s})
 *               sig     = avmeld-service serverSignatureFor("stock-check-v1", payload)
 *             (the /avmeld/:token signing helper: a per-purpose key derived
 *             from the server secret). The notice row id is sha256(nonce): a
 *             token is valid only while that row exists for that agent.
 *             GET shows what will be confirmed and changes nothing; POST
 *             confirms (routes/stock-check.ts).
 *   Confirm   confirmStockCheckItems(): for the listed rows that are still
 *             orderable — or blocked ONLY by the expiry this confirmation
 *             fixes — and that B1's isConfirmable() accepts (never a category
 *             label, alcohol / service, a failed ban check, or an unpriced
 *             row), it writes 'in_stock' through the existing
 *             setProducerAvailabilityByProductId() (source
 *             'producer_dashboard'; an 'admin_producer_confirmed' row keeps
 *             its source, but such a row never expires and is never listed).
 *
 * The e-mail is behind STOCK_CHECK_EMAIL_ENABLED (default OFF; "1"/"true" =
 * on): off = no e-mail, no reservation row, no link page (404). The template
 * needs Daniel's approval (recorded in daniel-responses/) before the flag is
 * turned on (AC8).
 */

import crypto from "crypto";
import { getDb } from "../database/init";
import { orderabilityReasons, producerOrderability, type OrderabilityResult } from "./cart-service";
import { setProducerAvailabilityByProductId } from "./supply-graph";
import {
  auditOwnerProductChange,
  isConfirmable,
  readOwnerProductRows,
  type OwnerProductRow,
} from "./owner-orderability";
import { serverSignatureFor } from "./avmeld-service";
import { rfbFeatureOn } from "../owner-features/resolve";
import { osloHour } from "./order-cap-notice";

export const STOCK_CHECK_EMAIL_FLAG = "STOCK_CHECK_EMAIL_ENABLED";
/** A row is «soon expiring» when its producer-stated status expires within this many days. */
export const STOCK_CHECK_WARN_DAYS = 3;
/** At most one e-mail per producer per this many days. */
export const STOCK_CHECK_EMAIL_WINDOW_DAYS = 14;
/** The confirm link in the e-mail works this long. */
export const STOCK_CHECK_LINK_VALID_DAYS = 7;
/** E-mails go out from 07:00 until 20:59 Oslo time (not in the night). */
export const STOCK_CHECK_SEND_FROM_HOUR = 7;
export const STOCK_CHECK_SEND_UNTIL_HOUR = 21;
export const STOCK_CHECK_PATH = "/lagerstatus";

const DAY_MS = 86_400_000;
const TOKEN_VERSION = "s1";
const SIGN_PURPOSE = "stock-check-v1";
const MAX_TOKEN_LENGTH = 600;
const MAX_PRODUCT_IDS = 200;

export function isStockCheckEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[STOCK_CHECK_EMAIL_FLAG];
  return v === "1" || v === "true";
}

let _stockCheckTestDb: any = null;
export function __setStockCheckTestDb(db: any): void { _stockCheckTestDb = db; }
function dbOf(db?: any): any { return db ?? _stockCheckTestDb ?? getDb(); }

// ─── The owner feature ──────────────────────────────────────────────────────

/**
 * `products.stock_check` for this producer: on only when `orders.enabled` is
 * on (registry `requires`), the profile has a verified owner, and the owner
 * has not switched it off. A lookup that fails counts as off (no reminder).
 */
export function stockCheckOn(agentId: string, opts: { db?: any; env?: NodeJS.ProcessEnv } = {}): boolean {
  try {
    return rfbFeatureOn(agentId, "products.stock_check", { db: dbOf(opts.db), env: opts.env });
  } catch (err) {
    console.error(`[stock-check] feature lookup failed agent=${agentId}:`, (err as any)?.message ?? "error");
    return false;
  }
}

// ─── Which rows ─────────────────────────────────────────────────────────────

export interface StockCheckItem {
  id: string;
  name: string;
  price_nok: number | null;
  unit: string | null;
  /** When the producer-stated status stops / stopped counting (ISO). */
  expires_at: string;
}

function toItem(row: OwnerProductRow, r: OrderabilityResult): StockCheckItem {
  return { id: row.id, name: row.name, price_nok: row.price_nok, unit: row.unit, expires_at: r.stock_expires_at as string };
}

function evaluateRows(agentId: string, db: any, now: Date): Array<{ row: OwnerProductRow; r: OrderabilityResult }> {
  const producer = producerOrderability(db, agentId, false);
  return readOwnerProductRows(db, agentId).map((row) => ({ row, r: orderabilityReasons(db, row, now, producer) }));
}

/**
 * The trigger rows: orderable now, confirmable under B1's rule, and the
 * producer-stated status expires within STOCK_CHECK_WARN_DAYS. Does not look
 * at the owner feature.
 */
export function soonExpiringItems(agentId: string, opts: { db?: any; now?: Date } = {}): StockCheckItem[] {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const limit = now.getTime() + STOCK_CHECK_WARN_DAYS * DAY_MS;
  return evaluateRows(agentId, db, now)
    .filter(({ row, r }) => {
      if (!r.orderable || row.availability_source !== "producer_dashboard" || !r.stock_expires_at) return false;
      // Only rows the reminder's button / link can confirm (B1 rule: priced).
      if (!isConfirmable(r, row.price_nok)) return false;
      const exp = Date.parse(r.stock_expires_at);
      return exp > now.getTime() && exp <= limit;
    })
    .map(({ row, r }) => toItem(row, r));
}

/**
 * Whether a confirmation from the reminder may write this row now: a
 * producer-stated row whose status expires within the warning window or has
 * already expired, still orderable apart from that expiry (no other product
 * or profile reason), and confirmable under B1's rule (priced; not a label,
 * alcohol / service or a failed ban check).
 */
function reminderConfirmable(row: OwnerProductRow, r: OrderabilityResult, now: Date): boolean {
  if (row.availability_source !== "producer_dashboard" || !r.stock_expires_at) return false;
  if (Date.parse(r.stock_expires_at) > now.getTime() + STOCK_CHECK_WARN_DAYS * DAY_MS) return false;
  if (!r.reasons.every((x) => x.code === "stock_status_expired")) return false;
  return isConfirmable(r, row.price_nok);
}

/** The rows among `productIds` (this producer's only) a confirmation would write now. */
export function stockCheckConfirmableItems(
  agentId: string,
  productIds: readonly string[],
  opts: { db?: any; now?: Date } = {},
): StockCheckItem[] {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const wanted = new Set(productIds.filter((x) => typeof x === "string" && x.length > 0));
  if (wanted.size === 0) return [];
  return evaluateRows(agentId, db, now)
    .filter(({ row, r }) => wanted.has(row.id) && reminderConfirmable(row, r, now))
    .map(({ row, r }) => toItem(row, r));
}

/**
 * «Bekreft at varene fortsatt er på lager»: writes 'in_stock' (source
 * producer_dashboard, fresh timestamp) through the existing write path for
 * the listed rows that stockCheckConfirmableItems() accepts, in one
 * transaction, with one agent_knowledge_audit row (changed_by 'owner').
 */
export function confirmStockCheckItems(
  agentId: string,
  productIds: readonly string[],
  opts: { db?: any; now?: Date; actorEmail?: string | null; via: "link" | "portal" },
): { confirmed: StockCheckItem[] } {
  const db = dbOf(opts.db);
  const confirmed: StockCheckItem[] = [];
  db.transaction(() => {
    const items = stockCheckConfirmableItems(agentId, productIds, { db, now: opts.now });
    for (const it of items) {
      if (setProducerAvailabilityByProductId(agentId, it.id, "in_stock", db).success) confirmed.push(it);
    }
    if (confirmed.length > 0) {
      auditOwnerProductChange(db, agentId, "products.availability", null, "in_stock", opts.actorEmail ?? null,
        `owner confirmed still in stock (stock-check ${opts.via}): ${confirmed.length} item(s) (B2)`);
    }
  })();
  return { confirmed };
}

// ─── The confirm link ───────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nonceId(nonce: string): string {
  return crypto.createHash("sha256").update(nonce, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** A signed token for (agent, nonce, expiry); null when no server secret is set. */
export function makeStockCheckToken(agentId: string, nonce: string, expiresAt: Date): string | null {
  const payload = b64url(Buffer.from(JSON.stringify({ a: agentId, n: nonce, x: Math.floor(expiresAt.getTime() / 1000) }), "utf8"));
  const sig = serverSignatureFor(SIGN_PURPOSE, payload);
  return sig ? `${TOKEN_VERSION}.${payload}.${sig}` : null;
}

export function stockCheckUrl(token: string): string {
  const base = process.env.APP_URL || "https://rettfrabonden.com";
  return `${base}${STOCK_CHECK_PATH}/${token}`;
}

export type StockCheckTokenState =
  | { state: "valid"; agent_id: string; notice_id: string; product_ids: string[]; producer_name: string }
  | { state: "invalid" }
  | { state: "expired" };

/** Signature, shape, expiry and the notice row. Never throws; reveals nothing on a bad token. */
export function verifyStockCheckToken(token: unknown, opts: { db?: any; now?: Date } = {}): StockCheckTokenState {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { state: "invalid" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { state: "invalid" };
    const [, payload, sig] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return { state: "invalid" };
    const expected = serverSignatureFor(SIGN_PURPOSE, payload);
    if (!expected || !safeEqual(sig, expected)) return { state: "invalid" };
    const p = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!p || typeof p !== "object" || typeof p.a !== "string" || !p.a || typeof p.n !== "string" || p.n.length < 16
      || typeof p.x !== "number" || !Number.isFinite(p.x)) return { state: "invalid" };
    const db = dbOf(opts.db);
    const row = db.prepare(`SELECT n.id AS id, n.agent_id AS agent_id, n.product_ids AS product_ids, a.name AS name
                              FROM stock_check_notices n JOIN agents a ON a.id = n.agent_id WHERE n.id = ?`)
      .get(nonceId(p.n)) as { id: string; agent_id: string; product_ids: string; name: string | null } | undefined;
    if (!row || row.agent_id !== p.a) return { state: "invalid" };
    if ((opts.now ?? new Date()).getTime() >= p.x * 1000) return { state: "expired" };
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(row.product_ids);
      if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === "string").slice(0, MAX_PRODUCT_IDS);
    } catch { ids = []; }
    return { state: "valid", agent_id: row.agent_id, notice_id: row.id, product_ids: ids, producer_name: String(row.name || "") };
  } catch {
    return { state: "invalid" };
  }
}

/** Records the confirmation on the notice row (for the admin; never blocks). */
export function markStockCheckConfirmed(noticeId: string, count: number, opts: { db?: any; now?: Date } = {}): void {
  try {
    dbOf(opts.db).prepare(`UPDATE stock_check_notices SET confirmed_at = ?, confirmed_count = COALESCE(confirmed_count, 0) + ? WHERE id = ?`)
      .run((opts.now ?? new Date()).toISOString(), count, noticeId);
  } catch { /* best-effort */ }
}

// ─── The reservation ────────────────────────────────────────────────────────

/**
 * Reserves this producer's e-mail for the 14-day window: BEGIN IMMEDIATE,
 * no notice newer than the window → insert one. Returns the notice id and
 * the nonce for the link, or null when another run (or an earlier send,
 * failed or not) holds the window.
 */
export function reserveStockCheckNotice(
  agentId: string,
  items: StockCheckItem[],
  opts: { db?: any; now?: Date } = {},
): { notice_id: string; nonce: string; link_expires_at: Date } | null {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - STOCK_CHECK_EMAIL_WINDOW_DAYS * DAY_MS).toISOString();
  const nonce = b64url(crypto.randomBytes(18));
  const id = nonceId(nonce);
  const linkExpires = new Date(now.getTime() + STOCK_CHECK_LINK_VALID_DAYS * DAY_MS);
  const run = db.transaction((): boolean => {
    const recent = db.prepare(`SELECT 1 AS x FROM stock_check_notices WHERE agent_id = ? AND created_at > ? LIMIT 1`).get(agentId, windowStart);
    if (recent) return false;
    db.prepare(`
      INSERT INTO stock_check_notices (id, agent_id, product_ids, item_count, status, created_at, link_expires_at)
      VALUES (?, ?, ?, ?, 'claimed', ?, ?)
    `).run(id, agentId, JSON.stringify(items.map((i) => i.id).slice(0, MAX_PRODUCT_IDS)), items.length, now.toISOString(), linkExpires.toISOString());
    return true;
  });
  return run.immediate() ? { notice_id: id, nonce, link_expires_at: linkExpires } : null;
}

// ─── The job ────────────────────────────────────────────────────────────────

export interface StockCheckEmailInput {
  agent_id: string;
  producer_name: string;
  items: StockCheckItem[];
  confirm_url: string;
  link_expires_at: string;
}

export type StockCheckSender = (input: StockCheckEmailInput) => Promise<"sent" | "skipped" | "failed">;

export interface StockCheckRunResult {
  enabled: boolean;
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Producers with soon-expiring rows but the feature off (orders off / owner chose «av»). */
  feature_off: number;
  /** Producers whose 14-day window was already taken. */
  held: number;
}

/**
 * One run: every producer that could have a soon-expiring producer-stated
 * row (orders on, verified badge, at least one producer_dashboard in-stock
 * row, no notice inside the window) is evaluated with the shared core; the
 * ones with the feature on and at least one trigger row get the e-mail,
 * reserved first. `now`, `db`, `env` and `send` are injectable for the tests.
 */
export async function processStockCheckReminders(
  opts: { now?: Date; db?: any; env?: NodeJS.ProcessEnv; send?: StockCheckSender } = {},
): Promise<StockCheckRunResult> {
  const env = opts.env ?? process.env;
  const out: StockCheckRunResult = { enabled: isStockCheckEmailEnabled(env), candidates: 0, sent: 0, skipped: 0, failed: 0, feature_off: 0, held: 0 };
  if (!out.enabled) return out;
  const now = opts.now ?? new Date();
  const h = osloHour(now);
  if (h < STOCK_CHECK_SEND_FROM_HOUR || h >= STOCK_CHECK_SEND_UNTIL_HOUR) return out;
  const db = dbOf(opts.db);
  const send: StockCheckSender = opts.send ?? (async (input) => {
    const { sendProducerStockCheckReminder } = await import("./order-notify-service");
    return sendProducerStockCheckReminder(input);
  });
  const windowStart = new Date(now.getTime() - STOCK_CHECK_EMAIL_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = db.prepare(`
    SELECT DISTINCT p.agent_id AS agent_id
      FROM products p
      JOIN agents a ON a.id = p.agent_id
     WHERE p.availability_source = 'producer_dashboard' AND p.availability = 'in_stock'
       AND a.order_notifications_opt_in = 1 AND a.is_verified = 1
       AND NOT EXISTS (SELECT 1 FROM stock_check_notices n WHERE n.agent_id = p.agent_id AND n.created_at > ?)
     ORDER BY p.agent_id
  `).all(windowStart) as Array<{ agent_id: string }>;

  for (const { agent_id } of rows) {
    let items: StockCheckItem[];
    try {
      items = soonExpiringItems(agent_id, { db, now });
    } catch (err) {
      console.error(`[stock-check] evaluation failed agent=${agent_id}:`, (err as any)?.message ?? "error");
      continue;
    }
    if (items.length === 0) continue;
    out.candidates++;
    if (!stockCheckOn(agent_id, { db, env })) { out.feature_off++; continue; }
    // The order-notification recipient gate (opt-in, address, verified
    // contact, blocklist) before anything is reserved; the sender checks it
    // again.
    try {
      const { resolveOrderNotificationRecipient } = require("./order-notify-service") as typeof import("./order-notify-service");
      const rcpt = resolveOrderNotificationRecipient(agent_id);
      if (!rcpt.eligible) {
        out.skipped++;
        console.log(`[stock-check] skipped agent=${agent_id} reason=${rcpt.reason}`);
        continue;
      }
    } catch (err) {
      out.failed++;
      console.error(`[stock-check] recipient check failed agent=${agent_id}:`, (err as any)?.message ?? "error");
      continue;
    }
    let reserved: ReturnType<typeof reserveStockCheckNotice> = null;
    try {
      reserved = reserveStockCheckNotice(agent_id, items, { db, now });
    } catch (err) {
      out.failed++;
      console.error(`[stock-check] reservation failed agent=${agent_id}:`, (err as any)?.message ?? "error");
      continue;
    }
    if (!reserved) { out.held++; continue; }
    try {
      const token = makeStockCheckToken(agent_id, reserved.nonce, reserved.link_expires_at);
      let outcome: "sent" | "skipped" | "failed";
      if (!token) {
        console.error(`[stock-check] no signing secret — not sending agent=${agent_id}`);
        outcome = "failed";
      } else {
        const name = (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agent_id) as { name: string | null } | undefined)?.name ?? "";
        outcome = await send({
          agent_id, producer_name: String(name || ""), items,
          confirm_url: stockCheckUrl(token), link_expires_at: reserved.link_expires_at.toISOString(),
        });
      }
      db.prepare(`UPDATE stock_check_notices SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ?`)
        .run(outcome, outcome, new Date().toISOString(), reserved.notice_id);
      out[outcome]++;
    } catch (err) {
      out.failed++;
      try { db.prepare(`UPDATE stock_check_notices SET status = 'failed' WHERE id = ?`).run(reserved.notice_id); } catch { /* best-effort */ }
      console.error(`[stock-check] send failed agent=${agent_id}:`, (err as any)?.message ?? "error");
    }
  }
  return out;
}

// ─── Owner-facing words (bokmål) ────────────────────────────────────────────

/** «01.11.2026» in Norwegian time. */
export function formatStockCheckDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" });
}

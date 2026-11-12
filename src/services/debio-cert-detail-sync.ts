// ─── Debio certificate-detail weekly sync (økologi S4b-2) ───────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, slice S4 («avgrensning for godkjente med blandet drift»),
// step S4b-2: store Debio's per-product certificate-detail lines weekly, per
// register-checked organic producer, behind RFB_DEBIO_CERT_DETAIL_SYNC (off by
// default).
//
//   candidates  agent_debio_status rows with debio_status 'okologisk' and a
//               debio_sid, whose agent_debio_cert_detail row is missing or
//               older than 7 days; missing first, then oldest fetched_at;
//               at most maxPerRun (default 25, 1–50).
//   register    ONE fetchDebioRegister() per run (only when there is a
//               candidate): register sid → enquiryOrigSids[0]. Register
//               failure → no writes at all.
//   detail      one fetchDebioCertificateDetail() per candidate, sequential,
//               delayMs (default 2 s) between calls; normalizeCertDetail().
//   storage     agent_debio_cert_detail only: lines as {label, statusCode,
//               statusText, organic}, status counts, organic / total line
//               counts. Fetch failure → ok=0 + the client's body-free reason;
//               no id in the register → ok=0, 'no_enquiry_orig_sid'. Either
//               way the row waits 7 days before the next try.
//
// Never writes agents, agent_debio_status or debio_verified; nothing reads
// the stored lines yet (S4c decides the product «Øko» mark). Privacy (S1.6):
// partnerFullName and any other Debio name / street is never persisted — only
// the normalizer's label / status fields are.

import type Database from "better-sqlite3";
import { fetchDebioCertificateDetail, normalizeCertDetail } from "./debio-cert-detail-client";
import { fetchDebioRegister } from "./debio-register-client";

export const DEBIO_CERT_DETAIL_SYNC_ENV = "RFB_DEBIO_CERT_DETAIL_SYNC";
export const DEBIO_CERT_DETAIL_REFRESH_DAYS = 7;
export const DEBIO_CERT_DETAIL_DEFAULT_MAX = 25;
export const DEBIO_CERT_DETAIL_MAX_LIMIT = 50;
export const DEBIO_CERT_DETAIL_DEFAULT_DELAY_MS = 2000;
const REASON_MAX_CHARS = 300;
const DAY_MS = 86_400_000;

/** Is the weekly cert-detail sync on? Only the literal "1" turns it on. */
export function debioCertDetailSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEBIO_CERT_DETAIL_SYNC_ENV] === "1";
}

export interface CertDetailSyncOptions {
  /** Fetch for getcertificatedetail (tests). */
  fetchImpl?: typeof fetch;
  /** Fetch for the register (tests). */
  registerFetchImpl?: typeof fetch;
  now?: Date;
  /** Candidates per run; default 25, clamped to 1–50. */
  maxPerRun?: number;
  /** Pause between detail calls; default 2000 ms. */
  delayMs?: number;
  /** Register call only: report candidates / ids, no detail calls, no writes. */
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface CertDetailSyncResult {
  ok: boolean;
  reason?: string;
  dry_run: boolean;
  candidates: number;
  with_id: number;
  fetched: number;
  stored: number;
  recognized: number;
  errors: number;
  skipped_no_id: number;
  organic_lines: number;
}

export function clampCertDetailMax(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEBIO_CERT_DETAIL_DEFAULT_MAX;
  return Math.min(DEBIO_CERT_DETAIL_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** A register fetch error → a reason without any response body. */
function registerFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /^debio register HTTP (\d+)/.exec(msg);
  if (http) return `register_http_${http[1]}`;
  if (/^debio register JSON parse failed/.test(msg)) return "register_invalid_json";
  return `register_fetch_failed: ${msg}`.slice(0, REASON_MAX_CHARS);
}

interface Candidate { agent_id: string; debio_sid: string; fetched_at: string | null }

/** Candidates: okologisk + debio_sid, detail row missing or older than 7 days; missing first, then oldest. */
export function selectCertDetailCandidates(db: Database.Database, now: Date, max: number): Candidate[] {
  const cutoff = new Date(now.getTime() - DEBIO_CERT_DETAIL_REFRESH_DAYS * DAY_MS).toISOString();
  return db.prepare(`
    SELECT s.agent_id AS agent_id, s.debio_sid AS debio_sid, d.fetched_at AS fetched_at
      FROM agent_debio_status s
      LEFT JOIN agent_debio_cert_detail d ON d.agent_id = s.agent_id
     WHERE s.debio_status = 'okologisk'
       AND s.debio_sid IS NOT NULL AND TRIM(s.debio_sid) <> ''
       AND (d.agent_id IS NULL OR d.fetched_at < ?)
     ORDER BY (d.fetched_at IS NOT NULL), d.fetched_at ASC, s.agent_id ASC
     LIMIT ?
  `).all(cutoff, max) as Candidate[];
}

const UPSERT_SQL = `
  INSERT INTO agent_debio_cert_detail
    (agent_id, enquiry_orig_sid, fetched_at, ok, recognized, lines_json, status_counts_json, organic_line_count, line_count, last_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(agent_id) DO UPDATE SET
    enquiry_orig_sid = excluded.enquiry_orig_sid, fetched_at = excluded.fetched_at, ok = excluded.ok,
    recognized = excluded.recognized, lines_json = excluded.lines_json,
    status_counts_json = excluded.status_counts_json, organic_line_count = excluded.organic_line_count,
    line_count = excluded.line_count, last_error = excluded.last_error
`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function syncDebioCertDetails(db: Database.Database, opts: CertDetailSyncOptions = {}): Promise<CertDetailSyncResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const max = clampCertDetailMax(opts.maxPerRun);
  const delayMs = typeof opts.delayMs === "number" && opts.delayMs >= 0 ? opts.delayMs : DEBIO_CERT_DETAIL_DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const out: CertDetailSyncResult = {
    ok: true, dry_run: dryRun, candidates: 0, with_id: 0, fetched: 0, stored: 0,
    recognized: 0, errors: 0, skipped_no_id: 0, organic_lines: 0,
  };

  const candidates = selectCertDetailCandidates(db, now, max);
  out.candidates = candidates.length;
  if (candidates.length === 0) return out;

  let idBySid: Map<string, number>;
  try {
    const reg = await fetchDebioRegister({ fetchImpl: opts.registerFetchImpl, now });
    idBySid = new Map();
    for (const r of reg.rows) {
      if (r.sid && r.enquiryOrigSids.length > 0 && !idBySid.has(r.sid)) idBySid.set(r.sid, r.enquiryOrigSids[0]);
    }
  } catch (e) {
    return { ...out, ok: false, reason: registerFailureReason(e) };
  }

  const upsert = dryRun ? null : db.prepare(UPSERT_SQL);
  const fetchedAt = now.toISOString();
  let detailCalls = 0;
  for (const c of candidates) {
    const id = idBySid.get(c.debio_sid.trim());
    if (id === undefined) {
      out.skipped_no_id++;
      if (upsert) {
        upsert.run(c.agent_id, null, fetchedAt, 0, 0, null, null, 0, 0, "no_enquiry_orig_sid");
        out.stored++;
      }
      continue;
    }
    out.with_id++;
    if (dryRun) continue;

    if (detailCalls > 0 && delayMs > 0) await sleep(delayMs);
    detailCalls++;
    const fetched = await fetchDebioCertificateDetail(id, { fetchImpl: opts.fetchImpl });
    if (!fetched.ok) {
      out.errors++;
      upsert!.run(c.agent_id, id, fetchedAt, 0, 0, null, null, 0, 0, String(fetched.reason).slice(0, REASON_MAX_CHARS));
      out.stored++;
      continue;
    }
    out.fetched++;
    const norm = normalizeCertDetail(fetched.raw);
    // Only the four normalized fields — never any other value from the response.
    const lines = norm.lines.map((l) => ({ label: l.label, statusCode: l.statusCode, statusText: l.statusText, organic: l.organic }));
    const counts: Record<string, number> = {};
    for (const l of lines) {
      const k = l.statusCode === null ? "none" : String(l.statusCode);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const organic = lines.filter((l) => l.organic).length;
    if (norm.recognized) out.recognized++;
    out.organic_lines += organic;
    upsert!.run(c.agent_id, id, fetchedAt, 1, norm.recognized ? 1 : 0, JSON.stringify(lines), JSON.stringify(counts), organic, lines.length, null);
    out.stored++;
  }
  return out;
}

export interface CertDetailStatus {
  rows: number;
  ok_rows: number;
  recognized_rows: number;
  agents_with_organic_line: number;
  oldest_fetched_at: string | null;
  newest_fetched_at: string | null;
}

/** Counts and timestamps only — no labels, names or ids. */
export function certDetailStatus(db: Database.Database): CertDetailStatus {
  const r = db.prepare(`
    SELECT COUNT(*) AS rows,
           COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS ok_rows,
           COALESCE(SUM(CASE WHEN recognized = 1 THEN 1 ELSE 0 END), 0) AS recognized_rows,
           COALESCE(SUM(CASE WHEN organic_line_count > 0 THEN 1 ELSE 0 END), 0) AS agents_with_organic_line,
           MIN(fetched_at) AS oldest_fetched_at,
           MAX(fetched_at) AS newest_fetched_at
      FROM agent_debio_cert_detail
  `).get() as CertDetailStatus;
  return {
    rows: Number(r.rows), ok_rows: Number(r.ok_rows), recognized_rows: Number(r.recognized_rows),
    agents_with_organic_line: Number(r.agents_with_organic_line),
    oldest_fetched_at: r.oldest_fetched_at ?? null, newest_fetched_at: r.newest_fetched_at ?? null,
  };
}

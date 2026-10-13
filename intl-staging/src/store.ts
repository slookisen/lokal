// Queue, draft and verdict logic for the staging base.
//
// Proposer ≠ admitter (A2A management-tier charter): a draft can only be judged
// by a run whose run_id differs from the run that built it, and a verdict only
// counts from the run that holds the judge lease. The quality brake (DPIA R1/T3:
// wrong entity above the threshold stops the line) is enforced here, server
// side, so a misbehaving batch run cannot keep going past it.
import crypto from "node:crypto";
import { type DB, deleteMeta, getMeta, norm, setMeta } from "./db";
import { checkDraft, declaredPhoneDigits, type ExcerptIn, type FieldValue, hostOf, redactExcerpt } from "./checks";
import { findPersonnummer } from "./pii";

export const CANDIDATE_LEASE_MS = 3 * 60 * 60 * 1000;
export const JUDGE_LEASE_MS = 2 * 60 * 60 * 1000;
export const EXCERPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const MAX_LEASE = 25;
export const QUALITY_WINDOW = 50;
export const QUALITY_MIN_N = 20;
export const QUALITY_MAX_ENTITY_MISMATCH = 0.1;

const BUILD_OUTCOMES = ["drafted", "not_found", "not_direct_sale", "wrong_entity_risk", "no_own_source", "out_of_scope"] as const;
type BuildOutcome = (typeof BUILD_OUTCOMES)[number];

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
  ) {
    super(code);
  }
}

// ── pause ─────────────────────────────────────────────────────────────────

export function pausedState(db: DB): { reason: string; at: string } | null {
  const v = getMeta(db, "paused");
  return v ? JSON.parse(v) : null;
}
export function pause(db: DB, reason: string, now: Date): void {
  if (!pausedState(db)) setMeta(db, "paused", JSON.stringify({ reason, at: now.toISOString() }));
}
export function resume(db: DB, now: Date): void {
  deleteMeta(db, "paused");
  // The quality brake counts only verdicts after a resume, so the verdicts that
  // tripped it cannot re-trip it at the next good verdict (review 2026-10-13).
  setMeta(db, "quality_since", now.toISOString());
}
function assertNotPaused(db: DB): void {
  const p = pausedState(db);
  if (p) throw new HttpError(423, "paused", p);
}

// ── helpers ───────────────────────────────────────────────────────────────

function iso(d: Date): string {
  return d.toISOString();
}
function validRunId(runId: unknown): string {
  if (typeof runId !== "string" || !/^[A-Za-z0-9._:-]{6,120}$/.test(runId)) throw new HttpError(400, "bad_run_id");
  return runId;
}

interface UnitRow {
  unit_id: string;
  org_nr: string;
  name: string;
  trade_name: string | null;
  legal_form: string;
  sni: string;
  street: string | null;
  postal_code: string | null;
  postal_town: string | null;
  county: string | null;
  ad_block: number;
  signal: string | null;
}

function unitView(u: UnitRow) {
  return {
    org_nr: u.org_nr,
    name: u.name,
    trade_name: u.trade_name,
    legal_form: u.legal_form,
    sni: JSON.parse(u.sni),
    street: u.street,
    postal_code: u.postal_code,
    postal_town: u.postal_town,
    county: u.county,
    ad_block: !!u.ad_block,
    signal: u.signal ? JSON.parse(u.signal) : null,
  };
}

// ── housekeeping ──────────────────────────────────────────────────────────

export function purge(db: DB, now: Date): { excerpts_deleted: number; leases_released: number; judge_leases_released: number; exhausted: number } {
  const t = iso(now);
  const excerpts = db.prepare("DELETE FROM excerpts WHERE expires_at < ?").run(t).changes;
  const leases = db
    .prepare("UPDATE candidates SET status = 'new', lease_run_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'leased' AND lease_expires_at < ?")
    .run(t, t).changes;
  const judge = db
    .prepare("UPDATE drafts SET judge_lease_run_id = NULL, judge_lease_expires_at = NULL WHERE status = 'awaiting_judge' AND judge_lease_expires_at < ?")
    .run(t).changes;
  // Candidates that used up their attempts leave the queue for a human look.
  const exhausted = db
    .prepare("UPDATE candidates SET status = 'needs_review', status_reason = 'max_attempts', updated_at = ? WHERE status = 'new' AND attempts >= ?")
    .run(t, MAX_ATTEMPTS).changes;
  return { excerpts_deleted: excerpts, leases_released: leases, judge_leases_released: judge, exhausted };
}

// ── build side ────────────────────────────────────────────────────────────

export function leaseCandidates(db: DB, body: { run_id?: unknown; n?: unknown; county?: unknown }, now: Date) {
  assertNotPaused(db);
  const runId = validRunId(body.run_id);
  const n = Math.max(1, Math.min(MAX_LEASE, Number(body.n) || 10));
  const county = typeof body.county === "string" && body.county ? body.county : null;
  const t = iso(now);
  const expires = iso(new Date(now.getTime() + CANDIDATE_LEASE_MS));
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT c.candidate_id, c.origin, c.attempts, u.* FROM candidates c JOIN register_units u ON u.unit_id = c.candidate_id
         WHERE c.country = 'se' AND u.active = 1 AND c.attempts < ? AND (c.status = 'new' OR (c.status = 'leased' AND c.lease_expires_at < ?))
           AND (? IS NULL OR u.county = ?)
         ORDER BY c.priority, c.created_at LIMIT ?`,
      )
      .all(MAX_ATTEMPTS, t, county, county, n) as Array<UnitRow & { candidate_id: string; origin: string; attempts: number }>;
    const lease = db.prepare(
      "UPDATE candidates SET status = 'leased', lease_run_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE candidate_id = ?",
    );
    for (const r of rows) lease.run(runId, expires, t, r.candidate_id);
    return rows;
  });
  const rows = tx();
  return {
    run_id: runId,
    lease_expires_at: expires,
    candidates: rows.map((r) => ({ candidate_id: r.candidate_id, origin: r.origin, attempt: r.attempts + 1, unit: unitView(r) })),
  };
}

export function registerSearch(db: DB, q: { name?: unknown; town?: unknown }) {
  const name = typeof q.name === "string" ? norm(q.name) : "";
  const town = typeof q.town === "string" ? norm(q.town) : "";
  if (name.length < 3) throw new HttpError(400, "name_too_short");
  const like = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM register_units WHERE country = 'se' AND active = 1
         AND name_norm LIKE ? ESCAPE '\\' AND (? = '' OR town_norm = ?)
       ORDER BY name LIMIT 10`,
    )
    .all(like, town, town) as UnitRow[];
  return { matches: rows.map((u) => ({ unit_id: u.unit_id, ...unitView(u) })) };
}

/** Search-mode: a builder found a producer by web search and matched it to a register unit. */
export function addSearchCandidate(db: DB, body: { run_id?: unknown; org_nr?: unknown }, now: Date) {
  assertNotPaused(db);
  const runId = validRunId(body.run_id);
  const orgNr = typeof body.org_nr === "string" ? body.org_nr.replace(/\D/g, "") : "";
  if (!/^\d{10}$/.test(orgNr)) throw new HttpError(400, "bad_org_nr");
  const unitId = `se:${orgNr}`;
  const unit = db.prepare("SELECT * FROM register_units WHERE unit_id = ? AND active = 1").get(unitId) as UnitRow | undefined;
  // Sole traders and out-of-scope units are never in register_units — nothing is stored for them.
  if (!unit) throw new HttpError(404, "not_in_scope");
  const t = iso(now);
  const expires = iso(new Date(now.getTime() + CANDIDATE_LEASE_MS));
  const existing = db.prepare("SELECT status, lease_run_id, lease_expires_at, attempts FROM candidates WHERE candidate_id = ?").get(unitId) as
    | { status: string; lease_run_id: string | null; lease_expires_at: string | null; attempts: number }
    | undefined;
  if (existing) {
    const freeNew = existing.status === "new" || (existing.status === "leased" && (existing.lease_expires_at || "") < t);
    if (!freeNew) throw new HttpError(409, "already_candidate", { status: existing.status });
    if (existing.attempts >= MAX_ATTEMPTS) throw new HttpError(409, "max_attempts");
    db.prepare("UPDATE candidates SET status = 'leased', lease_run_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE candidate_id = ?").run(
      runId,
      expires,
      t,
      unitId,
    );
  } else {
    const countyRank = unit.county === "Västra Götaland" ? 1 : unit.county === "Skåne" ? 2 : 3;
    db.prepare(
      `INSERT INTO candidates (candidate_id, country, origin, priority, status, lease_run_id, lease_expires_at, attempts, created_at, updated_at)
       VALUES (?, 'se', 'search', ?, 'leased', ?, ?, 1, ?, ?)`,
    ).run(unitId, countyRank * 10 + 2, runId, expires, t, t);
  }
  return { candidate_id: unitId, lease_expires_at: expires, unit: unitView(unit) };
}

export function submitDraft(
  db: DB,
  candidateId: string,
  body: { run_id?: unknown; outcome?: unknown; fields?: unknown; excerpts?: unknown },
  now: Date,
) {
  const runId = validRunId(body.run_id);
  const outcome = body.outcome as BuildOutcome;
  if (!BUILD_OUTCOMES.includes(outcome)) throw new HttpError(400, "bad_outcome", { allowed: BUILD_OUTCOMES });
  const t = iso(now);
  const cand = db.prepare("SELECT status, lease_run_id, lease_expires_at FROM candidates WHERE candidate_id = ?").get(candidateId) as
    | { status: string; lease_run_id: string | null; lease_expires_at: string | null }
    | undefined;
  if (!cand) throw new HttpError(404, "no_such_candidate");
  if (cand.status !== "leased" || cand.lease_run_id !== runId || (cand.lease_expires_at || "") < t) throw new HttpError(409, "lease_not_held");

  if (outcome !== "drafted") {
    const status = outcome === "out_of_scope" ? "excluded" : "rejected";
    db.transaction(() => {
      db.prepare("INSERT INTO outcomes (candidate_id, run_id, outcome, created_at) VALUES (?, ?, ?, ?)").run(candidateId, runId, outcome, t);
      db.prepare("UPDATE candidates SET status = ?, status_reason = ?, lease_run_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE candidate_id = ?").run(
        status,
        outcome,
        t,
        candidateId,
      );
    })();
    return { candidate_id: candidateId, status };
  }

  const fields = body.fields as Record<string, FieldValue> | undefined;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new HttpError(400, "fields_required");
  const rawExcerpts = Array.isArray(body.excerpts) ? (body.excerpts as ExcerptIn[]) : [];
  if (rawExcerpts.length > 8) throw new HttpError(400, "too_many_excerpts");
  const perHost = new Map<string, number>();
  const excerpts: ExcerptIn[] = [];
  let redacted = 0;
  for (const e of rawExcerpts) {
    if (!e || typeof e.url !== "string" || typeof e.text !== "string") throw new HttpError(400, "bad_excerpt");
    const host = hostOf(e.url);
    if (!host) throw new HttpError(400, "bad_excerpt_url");
    perHost.set(host, (perHost.get(host) || 0) + 1);
    if ((perHost.get(host) as number) > 4) throw new HttpError(400, "more_than_4_pages_from_one_site", { host });
    const r = redactExcerpt(e.text.slice(0, 8000), declaredPhoneDigits(fields));
    redacted += r.redacted;
    // fetched_at is set by the server: a client value is free text that could
    // carry anything (review 2026-10-13).
    excerpts.push({ url: e.url, text: r.text });
  }
  // Excerpts already stored for this candidate (an earlier attempt within TTL) count too.
  const stored = db.prepare("SELECT url, text FROM excerpts WHERE candidate_id = ? AND expires_at >= ?").all(candidateId, t) as ExcerptIn[];
  const unit = db.prepare("SELECT org_nr, postal_town, street FROM register_units WHERE unit_id = ?").get(candidateId) as {
    org_nr: string;
    postal_town: string | null;
    street: string | null;
  };
  const check = checkDraft(fields, [...stored, ...excerpts], unit);
  if (!check.ok) throw new HttpError(422, "draft_failed_checks", { errors: check.errors, redacted_personnummer: redacted });

  const expires = iso(new Date(now.getTime() + EXCERPT_TTL_MS));
  const draftId = db.transaction(() => {
    const ins = db.prepare("INSERT INTO excerpts (candidate_id, url, text, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)");
    for (const e of excerpts) ins.run(candidateId, e.url, e.text, t, expires);
    db.prepare("UPDATE drafts SET status = 'superseded' WHERE candidate_id = ? AND status = 'awaiting_judge'").run(candidateId);
    const res = db
      .prepare("INSERT INTO drafts (candidate_id, builder_run_id, language, fields_json, check_json, status, created_at) VALUES (?, ?, 'sv', ?, ?, 'awaiting_judge', ?)")
      .run(candidateId, runId, JSON.stringify(fields), JSON.stringify({ ok: true, redacted_personnummer: redacted }), t);
    db.prepare("INSERT INTO outcomes (candidate_id, run_id, outcome, created_at) VALUES (?, ?, 'drafted', ?)").run(candidateId, runId, t);
    db.prepare("UPDATE candidates SET status = 'drafted', status_reason = NULL, lease_run_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE candidate_id = ?").run(
      t,
      candidateId,
    );
    return Number(res.lastInsertRowid);
  })();
  return { candidate_id: candidateId, status: "drafted", draft_id: draftId, redacted_personnummer: redacted };
}

// ── judge side ────────────────────────────────────────────────────────────

export function leaseDrafts(db: DB, body: { run_id?: unknown; n?: unknown }, now: Date) {
  assertNotPaused(db);
  const runId = validRunId(body.run_id);
  const n = Math.max(1, Math.min(MAX_LEASE, Number(body.n) || 10));
  const t = iso(now);
  const expires = iso(new Date(now.getTime() + JUDGE_LEASE_MS));
  const rows = db.transaction(() => {
    const drafts = db
      .prepare(
        `SELECT d.draft_id, d.candidate_id, d.fields_json, d.language, u.* FROM drafts d
         JOIN register_units u ON u.unit_id = d.candidate_id JOIN candidates c ON c.candidate_id = d.candidate_id
         WHERE d.status = 'awaiting_judge' AND c.status = 'drafted' AND u.active = 1
           AND d.builder_run_id != ? AND (d.judge_lease_run_id IS NULL OR d.judge_lease_expires_at < ?)
         ORDER BY d.created_at LIMIT ?`,
      )
      .all(runId, t, n) as Array<UnitRow & { draft_id: number; candidate_id: string; fields_json: string; language: string }>;
    const lease = db.prepare("UPDATE drafts SET judge_lease_run_id = ?, judge_lease_expires_at = ? WHERE draft_id = ?");
    for (const d of drafts) lease.run(runId, expires, d.draft_id);
    return drafts;
  })();
  const ex = db.prepare("SELECT url, text, fetched_at FROM excerpts WHERE candidate_id = ? AND expires_at >= ? ORDER BY excerpt_id");
  return {
    run_id: runId,
    lease_expires_at: expires,
    drafts: rows.map((d) => ({
      draft_id: d.draft_id,
      candidate_id: d.candidate_id,
      language: d.language,
      unit: unitView(d),
      fields: JSON.parse(d.fields_json),
      excerpts: ex.all(d.candidate_id, t),
    })),
  };
}

export function submitVerdict(
  db: DB,
  draftId: number,
  body: {
    run_id?: unknown;
    verdict?: unknown;
    entity_match?: unknown;
    direct_sale_ok?: unknown;
    language_ok?: unknown;
    personal_data_found?: unknown;
    excerpt_verified?: unknown;
    field_results?: unknown;
    reasons?: unknown;
  },
  now: Date,
) {
  const runId = validRunId(body.run_id);
  const verdict = body.verdict;
  if (verdict !== "approve" && verdict !== "reject" && verdict !== "needs_review") throw new HttpError(400, "bad_verdict");
  for (const k of ["entity_match", "direct_sale_ok", "language_ok", "personal_data_found"] as const) {
    if (typeof body[k] !== "boolean") throw new HttpError(400, `missing_boolean:${k}`);
  }
  const fieldResults = body.field_results as Record<string, unknown> | undefined;
  if (!fieldResults || typeof fieldResults !== "object" || Array.isArray(fieldResults)) throw new HttpError(400, "field_results_required");
  for (const v of Object.values(fieldResults)) {
    if (v !== "ok" && v !== "unsupported" && v !== "wrong") throw new HttpError(400, "bad_field_result", { allowed: ["ok", "unsupported", "wrong"] });
  }
  if (body.excerpt_verified !== undefined && typeof body.excerpt_verified !== "boolean") throw new HttpError(400, "bad_excerpt_verified");
  if (typeof body.reasons !== "string" || !body.reasons.trim()) throw new HttpError(400, "reasons_required");
  if (body.reasons.length > 2000) throw new HttpError(400, "reasons_too_long");
  const reasons = body.reasons;
  // The judge's own text is stored too, so it gets the same personnummer block.
  if (findPersonnummer(reasons).length) throw new HttpError(422, "personnummer_in_reasons");

  const t = iso(now);
  const d = db.prepare("SELECT candidate_id, builder_run_id, fields_json, status, judge_lease_run_id, judge_lease_expires_at FROM drafts WHERE draft_id = ?").get(draftId) as
    | { candidate_id: string; builder_run_id: string; fields_json: string; status: string; judge_lease_run_id: string | null; judge_lease_expires_at: string | null }
    | undefined;
  if (!d) throw new HttpError(404, "no_such_draft");
  if (d.builder_run_id === runId) throw new HttpError(403, "builder_cannot_judge_own_draft");
  if (d.status !== "awaiting_judge" || d.judge_lease_run_id !== runId || (d.judge_lease_expires_at || "") < t) throw new HttpError(409, "judge_lease_not_held");

  const cand = db.prepare("SELECT status FROM candidates WHERE candidate_id = ?").get(d.candidate_id) as { status: string } | undefined;
  if (!cand || cand.status !== "drafted") throw new HttpError(409, "candidate_not_drafted", { status: cand?.status });
  const fieldKeys = Object.keys(JSON.parse(d.fields_json));
  const missing = fieldKeys.filter((k) => !(k in fieldResults));
  if (missing.length) throw new HttpError(400, "field_results_incomplete", { missing });
  const extra = Object.keys(fieldResults).filter((k) => !fieldKeys.includes(k));
  if (extra.length) throw new HttpError(400, "field_results_unknown_fields", { extra });
  const allOk = fieldKeys.every((k) => fieldResults[k] === "ok");
  if (verdict === "approve" && !(body.entity_match && body.direct_sale_ok && body.language_ok && !body.personal_data_found && allOk)) {
    throw new HttpError(400, "approve_inconsistent_with_checks");
  }
  const status = verdict === "approve" ? "approved" : verdict === "reject" ? "rejected" : "needs_review";
  db.transaction(() => {
    db.prepare(
      `INSERT INTO verdicts (draft_id, judge_run_id, verdict, entity_match, direct_sale_ok, language_ok, personal_data_found, excerpt_verified, field_results_json, reasons, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      draftId,
      runId,
      verdict,
      body.entity_match ? 1 : 0,
      body.direct_sale_ok ? 1 : 0,
      body.language_ok ? 1 : 0,
      body.personal_data_found ? 1 : 0,
      body.excerpt_verified === undefined ? null : body.excerpt_verified ? 1 : 0,
      JSON.stringify(fieldResults),
      reasons,
      t,
    );
    db.prepare("UPDATE drafts SET status = 'judged', judge_lease_run_id = NULL, judge_lease_expires_at = NULL WHERE draft_id = ?").run(draftId);
    db.prepare("UPDATE candidates SET status = ?, status_reason = ?, updated_at = ? WHERE candidate_id = ?").run(status, `judge:${verdict}`, t, d.candidate_id);
  })();

  const quality = qualityWindow(db);
  if (quality.n >= QUALITY_MIN_N && quality.entity_mismatch_rate > QUALITY_MAX_ENTITY_MISMATCH) {
    pause(db, `quality: entity mismatch ${(quality.entity_mismatch_rate * 100).toFixed(1)} % over the last ${quality.n} verdicts`, now);
  }
  return { draft_id: draftId, candidate_status: status, quality, paused: pausedState(db) };
}

export function qualityWindow(db: DB) {
  const since = getMeta(db, "quality_since") || "";
  const rows = db
    .prepare("SELECT verdict, entity_match, excerpt_verified FROM verdicts WHERE created_at > ? ORDER BY verdict_id DESC LIMIT ?")
    .all(since, QUALITY_WINDOW) as Array<{ verdict: string; entity_match: number; excerpt_verified: number | null }>;
  const n = rows.length;
  const mismatch = rows.filter((r) => !r.entity_match).length;
  const approved = rows.filter((r) => r.verdict === "approve").length;
  const verified = rows.filter((r) => r.excerpt_verified === 1).length;
  return { n, since: since || null, entity_mismatch_rate: n ? mismatch / n : 0, approve_rate: n ? approved / n : 0, excerpt_verified_share: n ? verified / n : 0 };
}

// ── reporting ─────────────────────────────────────────────────────────────

export function stats(db: DB) {
  const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM candidates WHERE country = 'se' GROUP BY status").all() as Array<{ status: string; n: number }>;
  const byCounty = db
    .prepare(
      `SELECT COALESCE(u.county, 'Okänt') AS county, c.status, COUNT(*) AS n FROM candidates c JOIN register_units u ON u.unit_id = c.candidate_id
       WHERE c.country = 'se' GROUP BY 1, 2 ORDER BY 1`,
    )
    .all() as Array<{ county: string; status: string; n: number }>;
  const outcomes = db.prepare("SELECT outcome, COUNT(*) AS n FROM outcomes GROUP BY outcome").all() as Array<{ outcome: string; n: number }>;
  const units = (db.prepare("SELECT COUNT(*) AS n FROM register_units WHERE country = 'se' AND active = 1").get() as { n: number }).n;
  const awaitingJudge = (db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'awaiting_judge'").get() as { n: number }).n;
  const counties: Record<string, Record<string, number>> = {};
  for (const r of byCounty) (counties[r.county] ||= {})[r.status] = r.n;
  return {
    register_units_active: units,
    candidates: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    candidates_by_county: counties,
    build_outcomes: Object.fromEntries(outcomes.map((r) => [r.outcome, r.n])),
    drafts_awaiting_judge: awaitingJudge,
    quality_last_verdicts: qualityWindow(db),
    paused: pausedState(db),
  };
}

/** Random approved profiles with their fields, for a human spot check (DPIA T3). */
export function sample(db: DB, n: number) {
  const rows = db
    .prepare(
      `SELECT c.candidate_id, d.draft_id, d.fields_json, u.* FROM candidates c
       JOIN drafts d ON d.candidate_id = c.candidate_id AND d.status = 'judged'
       JOIN register_units u ON u.unit_id = c.candidate_id
       WHERE c.status = 'approved' ORDER BY RANDOM() LIMIT ?`,
    )
    .all(Math.max(1, Math.min(25, n))) as Array<UnitRow & { candidate_id: string; draft_id: number; fields_json: string }>;
  return rows.map((r) => ({ candidate_id: r.candidate_id, draft_id: r.draft_id, unit: unitView(r), fields: JSON.parse(r.fields_json) }));
}

// ── opt-out ───────────────────────────────────────────────────────────────

export function optoutKey(kind: "org_nr" | "domain", value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${kind}:${value.toLowerCase()}`).digest("hex");
}

export function isOptedOut(db: DB, orgNr: string, secret: string): boolean {
  return !!db.prepare("SELECT 1 FROM optout WHERE key_hash = ?").get(optoutKey("org_nr", orgNr, secret));
}

/** Removes everything held about an org number and blocks it from future imports. */
export function optout(db: DB, body: { org_nr?: unknown; reason?: unknown }, secret: string, now: Date) {
  const orgNr = typeof body.org_nr === "string" ? body.org_nr.replace(/\D/g, "") : "";
  if (!/^\d{10}$/.test(orgNr)) throw new HttpError(400, "bad_org_nr");
  const reason = typeof body.reason === "string" && body.reason ? body.reason.slice(0, 200) : "optout";
  const unitId = `se:${orgNr}`;
  db.transaction(() => {
    db.prepare("DELETE FROM verdicts WHERE draft_id IN (SELECT draft_id FROM drafts WHERE candidate_id = ?)").run(unitId);
    db.prepare("DELETE FROM drafts WHERE candidate_id = ?").run(unitId);
    db.prepare("DELETE FROM excerpts WHERE candidate_id = ?").run(unitId);
    db.prepare("DELETE FROM outcomes WHERE candidate_id = ?").run(unitId);
    db.prepare("DELETE FROM candidates WHERE candidate_id = ?").run(unitId);
    db.prepare("DELETE FROM register_units WHERE unit_id = ?").run(unitId);
    db.prepare("INSERT INTO optout (key_hash, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(key_hash) DO NOTHING").run(
      optoutKey("org_nr", orgNr, secret),
      reason,
      iso(now),
    );
  })();
  return { removed: unitId };
}

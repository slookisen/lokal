// ─── Admin order statistics (read-only) ─────────────────────────────────────
//
// Slice S1 of the admin order-statistics dev-request (orch-pr-20261108-admin-
// ordre). Pure READ functions over two databases:
//
//   * Rett fra Bonden (lokal.db): orders, order_items, order_events,
//     cart_handoffs, agents (producer display name + test identity).
//   * Opplevagent gårdssalg (experiences.db): gardssalg_bookings,
//     experience_providers (provider display name + test identity).
//
// Consumed by routes/admin-order-stats.ts (GET /admin/api/ordre/oversikt and
// GET /admin/api/ordre/liste, S2: GET /admin/api/ordre/eksport.csv) and by
// routes/admin-orders.ts (pilot-status order counts). Nothing here writes, and nothing here ever
// selects a buyer/guest column: every SELECT names its columns explicitly
// (never `SELECT *`), so buyer_name / buyer_email / buyer_phone /
// delivery_note (orders, carts) and guest_name / guest_email / guest_phone /
// notes (gardssalg_bookings) cannot reach a response even by accident.
//
// Honest numbers: test rows are counted apart from the main totals.
//   * RFB test producer = agents.origin IN ('test_fixture','test_claim_fixture')
//     (POST /admin/test-producer, POST /admin/test-claim-fixture) OR the
//     legacy pilot row «Test Gard Brreg» (LEGACY_TEST_FIXTURE_ID — the same id
//     routes/admin-test-producer.ts adopts; a test pins the two equal).
//   * Opplevagent test = experience_providers.is_test_provider = 1 OR
//     gardssalg_bookings.is_test = 1 (the booking-test-send-guard marker).
//
// Periods are UTC calendar dates on created_at (the moment the order /
// visit request was submitted); `til` is inclusive.

import type Database from "better-sqlite3";

type Db = Database.Database;

// ─── Constants ──────────────────────────────────────────────────────────────

export const RFB_ORDER_STATUSES = ["pending", "confirmed", "declined", "ready", "completed", "cancelled"] as const;
/** Statuses whose total_nok counts as turnover (accepted by the producer). */
export const RFB_REVENUE_STATUSES = ["confirmed", "ready", "completed"] as const;
export const GARDSSALG_STATUSES = ["reserved", "confirmed_attended", "no_show", "cancelled"] as const;
export const GARDSSALG_PRE_STATUSES = ["awaiting_provider", "provider_confirmed", "provider_declined", "time_suggested", "expired"] as const;

export const PLATTFORMER = ["rfb", "gardssalg", "alle"] as const;
export const OPPLOSNINGER = ["dag", "uke", "maaned"] as const;
export type Plattform = typeof PLATTFORMER[number];
export type Opplosning = typeof OPPLOSNINGER[number];

/** agents.origin values that mark an RFB test profile. */
export const RFB_TEST_ORIGINS = ["test_fixture", "test_claim_fixture"] as const;
/** «Test Gard Brreg» — same literal as routes/admin-test-producer.ts LEGACY_TEST_FIXTURE_ID. */
export const RFB_LEGACY_TEST_AGENT_ID = "dff0c55e-8770-47cb-9e19-bd8099fcd5d5";

export const LIST_CAP = 500;
export const DEFAULT_PERIOD_DAYS = 30;
/** Longest accepted period, so a zero-filled day series stays bounded. */
export const MAX_PERIOD_DAYS = 1096;
export const UNANSWERED_HOURS = 24;

// SQL fragments built only from the literal constants above (no user input).
const RFB_IS_TEST_SQL =
  `(COALESCE(a.origin, '') IN (${RFB_TEST_ORIGINS.map((o) => `'${o}'`).join(", ")}) OR o.agent_id = '${RFB_LEGACY_TEST_AGENT_ID}')`;
const RFB_HANDOFF_IS_TEST_SQL =
  `(COALESCE(a.origin, '') IN (${RFB_TEST_ORIGINS.map((o) => `'${o}'`).join(", ")}) OR h.agent_id = '${RFB_LEGACY_TEST_AGENT_ID}')`;
const GS_IS_TEST_SQL = `(COALESCE(p.is_test_provider, 0) = 1 OR COALESCE(b.is_test, 0) = 1)`;
const RFB_REVENUE_SQL = `(${RFB_REVENUE_STATUSES.map((s) => `'${s}'`).join(", ")})`;

// ─── Params ─────────────────────────────────────────────────────────────────

export interface Periode {
  fra: string;          // YYYY-MM-DD inclusive
  til: string;          // YYYY-MM-DD inclusive
  /** exclusive upper bound (til + 1 day), for created_at < ? */
  til_eksklusiv: string;
}

export interface OversiktParams { plattform: Plattform; periode: Periode; oppl: Opplosning }
export interface ListeParams { plattform: Plattform; periode: Periode; status: string | null }

export type ParseResult<T> = { ok: true; params: T } | { ok: false; error: string; detail: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDate(s: string): Date | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(d.getTime()) || isoDate(d) !== s) return null; // rejects 2026-02-30
  return d;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function firstString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return undefined; // repeated param → treated as invalid below
  return String(v);
}

function parsePlattform(q: Record<string, unknown>): ParseResult<Plattform> {
  if (Array.isArray(q.plattform)) return { ok: false, error: "ugyldig_plattform", detail: "plattform kan bare oppgis én gang" };
  const raw = firstString(q.plattform);
  const p = (raw === undefined || raw === "" ? "alle" : raw) as Plattform;
  if (!(PLATTFORMER as readonly string[]).includes(p)) {
    return { ok: false, error: "ugyldig_plattform", detail: `plattform må være en av ${PLATTFORMER.join(", ")}` };
  }
  return { ok: true, params: p };
}

function parsePeriode(q: Record<string, unknown>, now: Date): ParseResult<Periode> {
  if (Array.isArray(q.fra) || Array.isArray(q.til)) {
    return { ok: false, error: "ugyldig_dato", detail: "fra/til kan bare oppgis én gang" };
  }
  const fraRaw = firstString(q.fra);
  const tilRaw = firstString(q.til);
  let til: Date;
  if (tilRaw === undefined || tilRaw === "") {
    til = parseDate(isoDate(now))!;
  } else {
    const d = parseDate(tilRaw);
    if (!d) return { ok: false, error: "ugyldig_dato", detail: "til må være en gyldig dato på formen YYYY-MM-DD" };
    til = d;
  }
  let fra: Date;
  if (fraRaw === undefined || fraRaw === "") {
    fra = addDays(til, -(DEFAULT_PERIOD_DAYS - 1));
  } else {
    const d = parseDate(fraRaw);
    if (!d) return { ok: false, error: "ugyldig_dato", detail: "fra må være en gyldig dato på formen YYYY-MM-DD" };
    fra = d;
  }
  if (fra.getTime() > til.getTime()) {
    return { ok: false, error: "ugyldig_periode", detail: "fra kan ikke være etter til" };
  }
  const days = Math.round((til.getTime() - fra.getTime()) / 86_400_000) + 1;
  if (days > MAX_PERIOD_DAYS) {
    return { ok: false, error: "ugyldig_periode", detail: `perioden kan være høyst ${MAX_PERIOD_DAYS} dager` };
  }
  return { ok: true, params: { fra: isoDate(fra), til: isoDate(til), til_eksklusiv: isoDate(addDays(til, 1)) } };
}

export function parseOversiktParams(q: Record<string, unknown>, now: Date = new Date()): ParseResult<OversiktParams> {
  const p = parsePlattform(q);
  if (!p.ok) return p;
  const per = parsePeriode(q, now);
  if (!per.ok) return per;
  if (Array.isArray(q.oppl)) return { ok: false, error: "ugyldig_oppl", detail: "oppl kan bare oppgis én gang" };
  const oRaw = firstString(q.oppl);
  const oppl = (oRaw === undefined || oRaw === "" ? "dag" : oRaw) as Opplosning;
  if (!(OPPLOSNINGER as readonly string[]).includes(oppl)) {
    return { ok: false, error: "ugyldig_oppl", detail: `oppl må være en av ${OPPLOSNINGER.join(", ")}` };
  }
  return { ok: true, params: { plattform: p.params, periode: per.params, oppl } };
}

export function allowedStatuses(plattform: Plattform): string[] {
  if (plattform === "rfb") return [...RFB_ORDER_STATUSES];
  if (plattform === "gardssalg") return [...GARDSSALG_STATUSES];
  return Array.from(new Set<string>([...RFB_ORDER_STATUSES, ...GARDSSALG_STATUSES]));
}

export function parseListeParams(q: Record<string, unknown>, now: Date = new Date()): ParseResult<ListeParams> {
  const p = parsePlattform(q);
  if (!p.ok) return p;
  const per = parsePeriode(q, now);
  if (!per.ok) return per;
  if (Array.isArray(q.status)) return { ok: false, error: "ugyldig_status", detail: "status kan bare oppgis én gang" };
  const sRaw = firstString(q.status);
  let status: string | null = null;
  if (sRaw !== undefined && sRaw !== "") {
    const allowed = allowedStatuses(p.params);
    if (!allowed.includes(sRaw)) {
      return { ok: false, error: "ugyldig_status", detail: `status må være en av ${allowed.join(", ")} for plattform=${p.params}` };
    }
    status = sRaw;
  }
  return { ok: true, params: { plattform: p.params, periode: per.params, status } };
}

// ─── Buckets ────────────────────────────────────────────────────────────────

function bucketSql(col: string, oppl: Opplosning): string {
  if (oppl === "dag") return `date(${col})`;
  if (oppl === "uke") return `date(${col}, 'weekday 0', '-6 days')`; // Monday of the Mon–Sun week
  return `strftime('%Y-%m', ${col})`;
}

/** Every bucket key in the period, in order (same keys bucketSql() produces). */
export function bucketKeys(periode: Periode, oppl: Opplosning): string[] {
  const fra = parseDate(periode.fra)!;
  const til = parseDate(periode.til)!;
  const keys: string[] = [];
  if (oppl === "dag") {
    for (let d = fra; d.getTime() <= til.getTime(); d = addDays(d, 1)) keys.push(isoDate(d));
  } else if (oppl === "uke") {
    const dow = (fra.getUTCDay() + 6) % 7; // 0 = Monday
    for (let d = addDays(fra, -dow); d.getTime() <= til.getTime(); d = addDays(d, 7)) keys.push(isoDate(d));
  } else {
    let y = fra.getUTCFullYear();
    let m = fra.getUTCMonth();
    const endKey = isoDate(til).slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;
      keys.push(key);
      if (key >= endKey) break;
      m++; if (m === 12) { m = 0; y++; }
    }
  }
  return keys;
}

function zeroCounts(statuses: readonly string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const s of statuses) o[s] = 0;
  return o;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function stats(values: number[]): { measured: number; median_hours: number | null; avg_hours: number | null } {
  if (values.length === 0) return { measured: 0, median_hours: null, avg_hours: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { measured: s.length, median_hours: round2(median), avg_hours: round2(avg) };
}

function sqliteDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ─── RFB overview ───────────────────────────────────────────────────────────

export interface RfbProducerRow {
  agent_id: string;
  name: string | null;
  total: number;
  by_status: Record<string, number>;
  sum_nok: number;
}

export interface RfbOverview {
  available: true;
  forklaring: string;
  total: number;
  by_status: Record<string, number>;
  sum_nok: { amount: number; statuses: string[]; forklaring: string };
  producers: RfbProducerRow[];
  series: Array<{ bucket: string; total: number; by_status: Record<string, number>; sum_nok: number }>;
  response_time: { measured: number; unanswered: number; median_hours: number | null; avg_hours: number | null; forklaring: string };
  unanswered_over_24h: { count: number; hours: number; forklaring: string };
  cart_handoffs: { count: number; forklaring: string };
  test: {
    forklaring: string;
    total: number;
    by_status: Record<string, number>;
    sum_nok: number;
    unanswered_over_24h: number;
    cart_handoffs: number;
    producers: Array<{ agent_id: string; name: string | null; total: number }>;
  };
}

export function computeRfbOverview(db: Db, periode: Periode, oppl: Opplosning, now: Date = new Date()): RfbOverview {
  const range = [periode.fra, periode.til_eksklusiv];
  const bucket = bucketSql("o.created_at", oppl);

  // One grouped pass: producer × bucket × status × test flag.
  const rows = db.prepare(
    `SELECT o.agent_id AS agent_id, a.name AS name, o.status AS status, ${bucket} AS bucket,
            ${RFB_IS_TEST_SQL} AS is_test,
            COUNT(*) AS n,
            SUM(CASE WHEN o.status IN ${RFB_REVENUE_SQL} THEN COALESCE(o.total_nok, 0) ELSE 0 END) AS sum_nok
       FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
      WHERE o.created_at >= ? AND o.created_at < ?
      GROUP BY o.agent_id, o.status, bucket, is_test`
  ).all(...range) as Array<{ agent_id: string; name: string | null; status: string; bucket: string; is_test: number; n: number; sum_nok: number | null }>;

  const byStatus = zeroCounts(RFB_ORDER_STATUSES);
  const testByStatus = zeroCounts(RFB_ORDER_STATUSES);
  let total = 0, sumNok = 0, testTotal = 0, testSum = 0;
  const producers = new Map<string, RfbProducerRow>();
  const testProducers = new Map<string, { agent_id: string; name: string | null; total: number }>();
  const series = new Map<string, { bucket: string; total: number; by_status: Record<string, number>; sum_nok: number }>();
  for (const k of bucketKeys(periode, oppl)) series.set(k, { bucket: k, total: 0, by_status: zeroCounts(RFB_ORDER_STATUSES), sum_nok: 0 });

  for (const r of rows) {
    const amount = Number(r.sum_nok ?? 0);
    if (r.is_test) {
      testTotal += r.n;
      testByStatus[r.status] = (testByStatus[r.status] ?? 0) + r.n;
      testSum += amount;
      const tp = testProducers.get(r.agent_id) ?? { agent_id: r.agent_id, name: r.name, total: 0 };
      tp.total += r.n;
      testProducers.set(r.agent_id, tp);
      continue;
    }
    total += r.n;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    sumNok += amount;
    const p = producers.get(r.agent_id) ?? { agent_id: r.agent_id, name: r.name, total: 0, by_status: zeroCounts(RFB_ORDER_STATUSES), sum_nok: 0 };
    p.total += r.n;
    p.by_status[r.status] = (p.by_status[r.status] ?? 0) + r.n;
    p.sum_nok += amount;
    producers.set(r.agent_id, p);
    const s = series.get(r.bucket);
    if (s) {
      s.total += r.n;
      s.by_status[r.status] = (s.by_status[r.status] ?? 0) + r.n;
      s.sum_nok += amount;
    }
  }

  // Time from submission (orders.created_at) to the producer's first
  // transition (order_events with actor 'producer' / actor_role 'seller').
  const resp = db.prepare(
    `SELECT (julianday(fr.first_at) - julianday(fr.created_at)) * 24.0 AS hours
       FROM (
         SELECT o.created_at AS created_at,
                (SELECT MIN(e.created_at) FROM order_events e
                  WHERE e.order_id = o.id AND (e.actor = 'producer' OR e.actor_role = 'seller')) AS first_at
           FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
          WHERE o.created_at >= ? AND o.created_at < ? AND NOT ${RFB_IS_TEST_SQL}
       ) fr`
  ).all(...range) as Array<{ hours: number | null }>;
  const hours = resp.filter((r) => r.hours !== null && r.hours >= 0).map((r) => Number(r.hours));
  const respStats = stats(hours);

  // Snapshot now: pending orders older than 24 h (pay-at-pickup only — a
  // pending prepay order is waiting for payment, not for the producer; same
  // rule as GET /admin/orders/pilot-status).
  const cutoff = sqliteDateTime(new Date(now.getTime() - UNANSWERED_HOURS * 3_600_000));
  const unanswered = db.prepare(
    `SELECT ${RFB_IS_TEST_SQL} AS is_test, COUNT(*) AS n
       FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'pending' AND COALESCE(o.payment_mode, '') <> 'prepay' AND o.created_at <= ?
      GROUP BY is_test`
  ).all(cutoff) as Array<{ is_test: number; n: number }>;

  const handoffs = db.prepare(
    `SELECT ${RFB_HANDOFF_IS_TEST_SQL} AS is_test, COUNT(*) AS n
       FROM cart_handoffs h LEFT JOIN agents a ON a.id = h.agent_id
      WHERE h.created_at >= ? AND h.created_at < ?
      GROUP BY is_test`
  ).all(...range) as Array<{ is_test: number; n: number }>;
  const pick = (rs: Array<{ is_test: number; n: number }>, t: number) => rs.find((r) => Number(r.is_test) === t)?.n ?? 0;

  const producerList = [...producers.values()]
    .map((p) => ({ ...p, sum_nok: round2(p.sum_nok) }))
    .sort((a, b) => b.total - a.total || String(a.name ?? "").localeCompare(String(b.name ?? "")));

  return {
    available: true,
    forklaring:
      "Rett fra Bonden-bestillinger (tabellen orders) sendt inn i perioden (UTC-dato for innsending), " +
      "per status, per produsent og per tidsbolk. Testprodusenten er holdt utenfor og vist i test-blokken.",
    total,
    by_status: byStatus,
    sum_nok: {
      amount: round2(sumNok),
      statuses: [...RFB_REVENUE_STATUSES],
      forklaring: "Sum total_nok for bestillinger produsenten har akseptert (confirmed, ready, completed). Bestillinger uten pris teller 0.",
    },
    producers: producerList,
    series: [...series.values()].map((s) => ({ ...s, sum_nok: round2(s.sum_nok) })),
    response_time: {
      measured: respStats.measured,
      unanswered: resp.length - respStats.measured,
      median_hours: respStats.median_hours,
      avg_hours: respStats.avg_hours,
      forklaring:
        "Timer fra innsending til produsentens første statusendring (order_events med actor=producer / actor_role=seller). " +
        "Bestillinger uten svar fra produsent (også de systemet lukket) telles som 'unanswered'.",
    },
    unanswered_over_24h: {
      count: pick(unanswered, 0),
      hours: UNANSWERED_HOURS,
      forklaring:
        "Øyeblikksbilde nå, uavhengig av perioden: bestillinger som fortsatt står som pending og ble sendt inn for mer enn 24 timer siden " +
        "(forhåndsbetalte bestillinger som venter på betaling er holdt utenfor).",
    },
    cart_handoffs: {
      count: pick(handoffs, 0),
      forklaring: "Antall kontakt-overleveringer (cart_handoffs) i perioden: kjøperen fikk produsentens kontaktinfo i stedet for en bestilling.",
    },
    test: {
      forklaring:
        "Bestillinger og overleveringer hos testprodusenten (agents.origin test_fixture/test_claim_fixture eller «Test Gard Brreg»). " +
        "Ikke med i tallene over.",
      total: testTotal,
      by_status: testByStatus,
      sum_nok: round2(testSum),
      unanswered_over_24h: pick(unanswered, 1),
      cart_handoffs: pick(handoffs, 1),
      producers: [...testProducers.values()],
    },
  };
}

// ─── Gårdssalg overview ─────────────────────────────────────────────────────

export interface GardssalgUnavailable {
  available: false;
  forklaring: string;
  merknader: string[];
}

export interface GardssalgOverview {
  available: true;
  forklaring: string;
  total: number;
  by_status: Record<string, number>;
  by_pre_status: Record<string, number>;
  party_size_sum: number;
  attended: number;
  no_show: number;
  billable: { count: number; forklaring: string };
  providers: Array<{ provider_id: string; name: string | null; total: number; by_status: Record<string, number>; party_size_sum: number }>;
  series: Array<{ bucket: string; total: number; by_status: Record<string, number>; party_size_sum: number }>;
  response_time: { measured: number; median_hours: number | null; avg_hours: number | null; forklaring: string };
  merknader: string[];
  test: {
    forklaring: string;
    total: number;
    by_status: Record<string, number>;
    party_size_sum: number;
    providers: Array<{ provider_id: string; name: string | null; total: number }>;
  };
}

export function gardssalgUnavailable(reason: string): GardssalgUnavailable {
  return {
    available: false,
    forklaring: "Gårdssalg-besøksforespørsler (Opplevagent) kunne ikke leses.",
    merknader: [reason],
  };
}

export function computeGardssalgOverview(db: Db, periode: Periode, oppl: Opplosning): GardssalgOverview {
  const range = [periode.fra, periode.til_eksklusiv];
  const bucket = bucketSql("b.created_at", oppl);
  const rows = db.prepare(
    `SELECT b.provider_id AS provider_id, p.navn AS name, b.status AS status,
            COALESCE(b.pre_status, 'awaiting_provider') AS pre_status, ${bucket} AS bucket,
            ${GS_IS_TEST_SQL} AS is_test,
            COUNT(*) AS n, SUM(COALESCE(b.party_size, 0)) AS party,
            SUM(CASE WHEN COALESCE(b.billable, 0) = 1 THEN 1 ELSE 0 END) AS billable
       FROM gardssalg_bookings b LEFT JOIN experience_providers p ON p.id = b.provider_id
      WHERE b.created_at >= ? AND b.created_at < ?
      GROUP BY b.provider_id, b.status, pre_status, bucket, is_test`
  ).all(...range) as Array<{ provider_id: string; name: string | null; status: string; pre_status: string; bucket: string; is_test: number; n: number; party: number | null; billable: number | null }>;

  const byStatus = zeroCounts(GARDSSALG_STATUSES);
  const byPre = zeroCounts(GARDSSALG_PRE_STATUSES);
  const testByStatus = zeroCounts(GARDSSALG_STATUSES);
  let total = 0, party = 0, billable = 0, testTotal = 0, testParty = 0;
  const providers = new Map<string, GardssalgOverview["providers"][number]>();
  const testProviders = new Map<string, { provider_id: string; name: string | null; total: number }>();
  const series = new Map<string, GardssalgOverview["series"][number]>();
  for (const k of bucketKeys(periode, oppl)) series.set(k, { bucket: k, total: 0, by_status: zeroCounts(GARDSSALG_STATUSES), party_size_sum: 0 });

  for (const r of rows) {
    const ps = Number(r.party ?? 0);
    if (r.is_test) {
      testTotal += r.n;
      testByStatus[r.status] = (testByStatus[r.status] ?? 0) + r.n;
      testParty += ps;
      const tp = testProviders.get(r.provider_id) ?? { provider_id: r.provider_id, name: r.name, total: 0 };
      tp.total += r.n;
      testProviders.set(r.provider_id, tp);
      continue;
    }
    total += r.n;
    party += ps;
    billable += Number(r.billable ?? 0);
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    byPre[r.pre_status] = (byPre[r.pre_status] ?? 0) + r.n;
    const p = providers.get(r.provider_id) ?? { provider_id: r.provider_id, name: r.name, total: 0, by_status: zeroCounts(GARDSSALG_STATUSES), party_size_sum: 0 };
    p.total += r.n;
    p.by_status[r.status] = (p.by_status[r.status] ?? 0) + r.n;
    p.party_size_sum += ps;
    providers.set(r.provider_id, p);
    const s = series.get(r.bucket);
    if (s) {
      s.total += r.n;
      s.by_status[r.status] = (s.by_status[r.status] ?? 0) + r.n;
      s.party_size_sum += ps;
    }
  }

  // Producer response time: respond_token_used_at is stamped when the
  // producer confirms/declines directly. When the producer suggested a new
  // time (suggested_slot_at set) the stamp is the GUEST's later decision, so
  // those rows are left out rather than miscounted.
  const resp = db.prepare(
    `SELECT (julianday(b.respond_token_used_at) - julianday(b.created_at)) * 24.0 AS hours
       FROM gardssalg_bookings b LEFT JOIN experience_providers p ON p.id = b.provider_id
      WHERE b.created_at >= ? AND b.created_at < ? AND NOT ${GS_IS_TEST_SQL}
        AND b.respond_token_used_at IS NOT NULL AND b.suggested_slot_at IS NULL
        AND b.pre_status IN ('provider_confirmed', 'provider_declined')`
  ).all(...range) as Array<{ hours: number | null }>;
  const respStats = stats(resp.filter((r) => r.hours !== null && r.hours >= 0).map((r) => Number(r.hours)));

  const providerList = [...providers.values()]
    .sort((a, b) => b.total - a.total || String(a.name ?? "").localeCompare(String(b.name ?? "")));

  return {
    available: true,
    forklaring:
      "Opplevagent gårdssalg-besøksforespørsler (gardssalg_bookings) sendt inn i perioden (UTC-dato for forespørselen), " +
      "per status (etter besøket), per forhåndsstatus (produsentens svar), per tilbyder og per tidsbolk. " +
      "Testtilbydere og test-forespørsler er holdt utenfor og vist i test-blokken.",
    total,
    by_status: byStatus,
    by_pre_status: byPre,
    party_size_sum: party,
    attended: byStatus.confirmed_attended,
    no_show: byStatus.no_show,
    billable: {
      count: billable,
      forklaring: "Kun til informasjon: forespørsler merket billable=1. Ingen fakturering skjer ut fra dette tallet.",
    },
    providers: providerList,
    series: [...series.values()],
    response_time: {
      measured: respStats.measured,
      median_hours: respStats.median_hours,
      avg_hours: respStats.avg_hours,
      forklaring:
        "Timer fra forespørsel til produsenten bekreftet eller avslo direkte (respond_token_used_at). " +
        "Forespørsler der produsenten foreslo nytt tidspunkt er ikke med.",
    },
    merknader: [
      "Svartid måles bare når produsenten bekreftet eller avslo direkte; et forslag om nytt tidspunkt har ikke eget tidsstempel.",
      "Forespørsler uten created_at er ikke med i periodetallene.",
    ],
    test: {
      forklaring:
        "Forespørsler hos testtilbydere (experience_providers.is_test_provider=1) eller merket som test (is_test=1). Ikke med i tallene over.",
      total: testTotal,
      by_status: testByStatus,
      party_size_sum: testParty,
      providers: [...testProviders.values()],
    },
  };
}

// ─── Order list ─────────────────────────────────────────────────────────────

export interface OrderListRow {
  platform: "rfb" | "gardssalg";
  id: string;
  ref: string | null;
  date: string;
  producer_id: string;
  producer_name: string | null;
  status: string;
  pre_status: string | null;
  item_count: number | null;
  party_size: number | null;
  amount_nok: number | null;
  is_test: boolean;
}

export function listRfbOrders(db: Db, periode: Periode, status: string | null, limit: number = LIST_CAP + 1): OrderListRow[] {
  const args: unknown[] = [periode.fra, periode.til_eksklusiv];
  let statusSql = "";
  if (status) { statusSql = " AND o.status = ?"; args.push(status); }
  args.push(limit);
  const rows = db.prepare(
    `SELECT o.id AS id, o.created_at AS created_at, o.agent_id AS agent_id, a.name AS agent_name,
            o.status AS status, o.total_nok AS total_nok,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
            ${RFB_IS_TEST_SQL} AS is_test
       FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
      WHERE o.created_at >= ? AND o.created_at < ?${statusSql}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ?`
  ).all(...args) as Array<{ id: string; created_at: string; agent_id: string; agent_name: string | null; status: string; total_nok: number | null; item_count: number; is_test: number }>;
  return rows.map((r) => ({
    platform: "rfb",
    id: r.id,
    ref: null,
    date: r.created_at,
    producer_id: r.agent_id,
    producer_name: r.agent_name,
    status: r.status,
    pre_status: null,
    item_count: Number(r.item_count),
    party_size: null,
    amount_nok: r.total_nok === null || r.total_nok === undefined ? null : round2(Number(r.total_nok)),
    is_test: Number(r.is_test) === 1,
  }));
}

export function listGardssalgBookings(db: Db, periode: Periode, status: string | null, limit: number = LIST_CAP + 1): OrderListRow[] {
  const args: unknown[] = [periode.fra, periode.til_eksklusiv];
  let statusSql = "";
  if (status) { statusSql = " AND b.status = ?"; args.push(status); }
  args.push(limit);
  const rows = db.prepare(
    `SELECT b.booking_id AS id, b.booking_ref AS ref, b.created_at AS created_at, b.provider_id AS provider_id,
            p.navn AS provider_name, b.status AS status, COALESCE(b.pre_status, 'awaiting_provider') AS pre_status,
            b.party_size AS party_size, ${GS_IS_TEST_SQL} AS is_test
       FROM gardssalg_bookings b LEFT JOIN experience_providers p ON p.id = b.provider_id
      WHERE b.created_at >= ? AND b.created_at < ?${statusSql}
      ORDER BY b.created_at DESC, b.booking_id DESC
      LIMIT ?`
  ).all(...args) as Array<{ id: string; ref: string; created_at: string; provider_id: string; provider_name: string | null; status: string; pre_status: string; party_size: number; is_test: number }>;
  return rows.map((r) => ({
    platform: "gardssalg",
    id: r.id,
    ref: r.ref,
    date: r.created_at,
    producer_id: r.provider_id,
    producer_name: r.provider_name,
    status: r.status,
    pre_status: r.pre_status,
    item_count: null,
    party_size: Number(r.party_size),
    amount_nok: null,
    is_test: Number(r.is_test) === 1,
  }));
}

/** Comparable instant for mixed 'YYYY-MM-DD HH:MM:SS' / ISO created_at values. */
function sortKey(s: string): number {
  const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

/** Newest first across both platforms, capped at LIST_CAP. */
export function mergeOrderLists(lists: OrderListRow[][], cap: number = LIST_CAP): { rows: OrderListRow[]; truncated: boolean } {
  const all = lists.flat().sort((a, b) => sortKey(b.date) - sortKey(a.date) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { rows: all.slice(0, cap), truncated: all.length > cap };
}

// ─── Order counts by status (shared with GET /admin/orders/pilot-status) ────
//
// Slice S2: pilot-status's orders_30d block reads its counts from here so it
// and the oversikt numbers come from the same SQL and the same test rule.
// `real` / `test` are split with the same RFB_IS_TEST_SQL predicate as
// computeRfbOverview(); pilot-status keeps its own semantics (every order,
// test included) by adding the two with combineRfbStatusCounts().

export interface RfbStatusCounts {
  by_status: Record<string, number>;
  total: number;
  /** completed orders closed by the follow-ups job (orders.completion_source = 'auto'). */
  completed_auto: number;
}

/**
 * Orders with `from <= created_at` (and `created_at < toExclusive` when
 * given), per status, split into real and test. `from` / `toExclusive` are
 * compared as text against orders.created_at, like every other query here.
 */
export function countRfbOrdersByStatus(db: Db, from: string, toExclusive: string | null = null): { real: RfbStatusCounts; test: RfbStatusCounts } {
  const args: string[] = [from];
  let upper = "";
  if (toExclusive !== null) { upper = " AND o.created_at < ?"; args.push(toExclusive); }
  const rows = db.prepare(
    `SELECT o.status AS status, ${RFB_IS_TEST_SQL} AS is_test, COUNT(*) AS n,
            SUM(CASE WHEN o.status = 'completed' AND o.completion_source = 'auto' THEN 1 ELSE 0 END) AS auto
       FROM orders o LEFT JOIN agents a ON a.id = o.agent_id
      WHERE o.created_at >= ?${upper}
      GROUP BY o.status, is_test`
  ).all(...args) as Array<{ status: string; is_test: number; n: number; auto: number | null }>;
  const real: RfbStatusCounts = { by_status: zeroCounts(RFB_ORDER_STATUSES), total: 0, completed_auto: 0 };
  const test: RfbStatusCounts = { by_status: zeroCounts(RFB_ORDER_STATUSES), total: 0, completed_auto: 0 };
  for (const r of rows) {
    const c = Number(r.is_test) === 1 ? test : real;
    c.by_status[r.status] = (c.by_status[r.status] ?? 0) + r.n;
    c.total += r.n;
    c.completed_auto += Number(r.auto ?? 0);
  }
  return { real, test };
}

/** Real + test together (pilot-status counts every order). */
export function combineRfbStatusCounts(a: RfbStatusCounts, b: RfbStatusCounts): RfbStatusCounts {
  const by: Record<string, number> = zeroCounts(RFB_ORDER_STATUSES);
  for (const src of [a.by_status, b.by_status]) for (const [k, v] of Object.entries(src)) by[k] = (by[k] ?? 0) + v;
  return { by_status: by, total: a.total + b.total, completed_auto: a.completed_auto + b.completed_auto };
}

/** SQLite datetime('now', '-N days') computed from `now` (same text format). */
export function sqliteDaysAgo(now: Date, days: number): string {
  return sqliteDateTime(new Date(now.getTime() - days * 86_400_000));
}

// ─── CSV export (aggregates only) ───────────────────────────────────────────
//
// Slice S2: GET /admin/api/ordre/eksport.csv turns the oversikt body into
// one long-format table. Every row is ONE aggregate (a count, sum, hours
// figure or 0/1 availability flag) — never an order or a booking: no order
// id, booking id/ref, buyer or guest field, note or free text. The only text
// that comes from the database is the producer / provider display name.

export const CSV_COLUMNS = ["plattform", "omfang", "kategori", "noekkel", "navn", "maal", "verdi", "periode_fra", "periode_til", "oppl"] as const;
export type CsvRow = Record<typeof CSV_COLUMNS[number], string | number | null>;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * One CSV cell. Numbers are written as numbers. Text: any e-mail-like
 * substring is masked; a leading = + - @ (or tab / CR) gets a ' prefix so a
 * spreadsheet never evaluates it as a formula; quotes, commas and line
 * breaks are quoted per RFC 4180.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v).replace(EMAIL_RE, "[e-post skjult]");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows: CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export interface OversiktForCsv {
  plattform: Plattform;
  periode: Periode;
  oppl: Opplosning;
  rfb?: RfbOverview;
  gardssalg?: GardssalgOverview | GardssalgUnavailable;
}

/** The oversikt body as aggregate rows (see CSV_COLUMNS). */
export function oversiktCsvRows(o: OversiktForCsv): CsvRow[] {
  const rows: CsvRow[] = [];
  const add = (plattform: string, omfang: "ekte" | "test", kategori: string, noekkel: string | null, navn: string | null, maal: string, verdi: number | null) =>
    rows.push({ plattform, omfang, kategori, noekkel, navn, maal, verdi, periode_fra: o.periode.fra, periode_til: o.periode.til, oppl: o.oppl });

  if (o.rfb) {
    const r = o.rfb;
    const P = "rfb";
    add(P, "ekte", "tilgjengelig", null, null, "tilgjengelig", 1);
    add(P, "ekte", "total", null, null, "antall", r.total);
    for (const [s, n] of Object.entries(r.by_status)) add(P, "ekte", "status", s, null, "antall", n);
    add(P, "ekte", "omsetning", null, null, "sum_nok", r.sum_nok.amount);
    for (const p of r.producers) {
      add(P, "ekte", "produsent", p.agent_id, p.name, "antall", p.total);
      add(P, "ekte", "produsent", p.agent_id, p.name, "sum_nok", p.sum_nok);
    }
    for (const s of r.series) {
      add(P, "ekte", "bolk", s.bucket, null, "antall", s.total);
      add(P, "ekte", "bolk", s.bucket, null, "sum_nok", s.sum_nok);
    }
    add(P, "ekte", "svartid", null, null, "maalt", r.response_time.measured);
    add(P, "ekte", "svartid", null, null, "uten_svar", r.response_time.unanswered);
    add(P, "ekte", "svartid", null, null, "median_timer", r.response_time.median_hours);
    add(P, "ekte", "svartid", null, null, "snitt_timer", r.response_time.avg_hours);
    add(P, "ekte", "ubesvart_over_24t", null, null, "antall_naa", r.unanswered_over_24h.count);
    add(P, "ekte", "overleveringer", null, null, "antall", r.cart_handoffs.count);
    add(P, "test", "total", null, null, "antall", r.test.total);
    for (const [s, n] of Object.entries(r.test.by_status)) add(P, "test", "status", s, null, "antall", n);
    add(P, "test", "omsetning", null, null, "sum_nok", r.test.sum_nok);
    add(P, "test", "ubesvart_over_24t", null, null, "antall_naa", r.test.unanswered_over_24h);
    add(P, "test", "overleveringer", null, null, "antall", r.test.cart_handoffs);
    for (const p of r.test.producers) add(P, "test", "produsent", p.agent_id, p.name, "antall", p.total);
  }

  if (o.gardssalg) {
    const g = o.gardssalg;
    const P = "gardssalg";
    if (!g.available) {
      add(P, "ekte", "tilgjengelig", null, null, "tilgjengelig", 0);
    } else {
      add(P, "ekte", "tilgjengelig", null, null, "tilgjengelig", 1);
      add(P, "ekte", "total", null, null, "antall", g.total);
      for (const [s, n] of Object.entries(g.by_status)) add(P, "ekte", "status", s, null, "antall", n);
      for (const [s, n] of Object.entries(g.by_pre_status)) add(P, "ekte", "forhaandsstatus", s, null, "antall", n);
      add(P, "ekte", "personer", null, null, "sum_personer", g.party_size_sum);
      add(P, "ekte", "fakturerbar_info", null, null, "antall", g.billable.count);
      for (const p of g.providers) {
        add(P, "ekte", "tilbyder", p.provider_id, p.name, "antall", p.total);
        add(P, "ekte", "tilbyder", p.provider_id, p.name, "sum_personer", p.party_size_sum);
      }
      for (const s of g.series) {
        add(P, "ekte", "bolk", s.bucket, null, "antall", s.total);
        add(P, "ekte", "bolk", s.bucket, null, "sum_personer", s.party_size_sum);
      }
      add(P, "ekte", "svartid", null, null, "maalt", g.response_time.measured);
      add(P, "ekte", "svartid", null, null, "median_timer", g.response_time.median_hours);
      add(P, "ekte", "svartid", null, null, "snitt_timer", g.response_time.avg_hours);
      add(P, "test", "total", null, null, "antall", g.test.total);
      for (const [s, n] of Object.entries(g.test.by_status)) add(P, "test", "status", s, null, "antall", n);
      add(P, "test", "personer", null, null, "sum_personer", g.test.party_size_sum);
      for (const p of g.test.providers) add(P, "test", "tilbyder", p.provider_id, p.name, "antall", p.total);
    }
  }
  return rows;
}

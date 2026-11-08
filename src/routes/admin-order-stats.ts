// ─── Admin: read-only order statistics ──────────────────────────────────────
//
// Slice S1 of the admin order-statistics dev-request (orch-pr-20261108-admin-
// ordre). Mounted at /admin/api/ordre. GET only — no write, no table, no
// migration; the order / booking flows and GET /admin/orders/pilot-status are
// untouched.
//
//   GET /admin/api/ordre/oversikt?plattform=rfb|gardssalg|alle
//                                &fra=YYYY-MM-DD&til=YYYY-MM-DD&oppl=dag|uke|maaned
//     Sums + zero-filled time series per platform (default: last 30 days,
//     oppl=dag, plattform=alle). Test producer / test provider rows are in a
//     separate `test` block, never in the main totals.
//
//   GET /admin/api/ordre/liste?plattform=rfb|gardssalg|alle&status=&fra=&til=
//     Order / visit-request rows, newest first, capped at 500. Each row holds
//     ONLY id/ref, date, platform, producer id+name, status, item count or
//     party_size, and amount (RFB). No buyer or guest data.
//
// Unknown plattform/oppl/status or a bad date → 400. Auth: X-Admin-Key
// checked against ADMIN_KEY (ANALYTICS_ADMIN_KEY fallback); 401 for a missing
// or wrong key (same convention as /admin/orders/pilot-status), 503 when no
// admin key is configured. The experiences DB is read only when
// ENABLE_EXPERIENCES=1 (otherwise the gårdssalg block says it is unavailable
// instead of opening a database file).

import { Router, Request, Response } from "express";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import {
  parseOversiktParams,
  parseListeParams,
  computeRfbOverview,
  computeGardssalgOverview,
  gardssalgUnavailable,
  listRfbOrders,
  listGardssalgBookings,
  mergeOrderLists,
  LIST_CAP,
  type OrderListRow,
} from "../services/admin-order-stats";

type Db = Database.Database;

const router = Router();

// Test-only DB pins (same idiom as admin-orders.ts's __setAdminOrdersTestDb).
let _rfbTestDb: Db | null = null;
let _expTestDb: Db | null | undefined = undefined; // undefined = no pin; null = pinned "unavailable"
let _nowForTesting: Date | null = null;
export function __setAdminOrderStatsTestDbs(rfb: Db | null, exp?: Db | null): void {
  _rfbTestDb = rfb;
  _expTestDb = rfb === null ? undefined : exp;
}
export function __setAdminOrderStatsNowForTesting(now: Date | null): void { _nowForTesting = now; }

function rfbDb(): Db {
  return _rfbTestDb ?? getDb();
}

function expDb(): { db: Db } | { error: string } {
  if (_expTestDb !== undefined) {
    return _expTestDb ? { db: _expTestDb } : { error: "Opplevagent-databasen er ikke tilgjengelig i dette miljøet." };
  }
  if (process.env.ENABLE_EXPERIENCES !== "1") {
    return { error: "Opplevagent er ikke slått på i dette miljøet (ENABLE_EXPERIENCES er ikke 1)." };
  }
  try {
    const factory = require("../database/db-factory") as typeof import("../database/db-factory");
    return { db: factory.getDb("experiences") as Db };
  } catch (err) {
    return { error: `Opplevagent-databasen kunne ikke åpnes: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(401).json({ error: "Requires X-Admin-Key header" });
    return false;
  }
  return true;
}

function now(): Date {
  return _nowForTesting ?? new Date();
}

router.get("/oversikt", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = parseOversiktParams(req.query as Record<string, unknown>, now());
  if (!parsed.ok) {
    res.status(400).json({ success: false, error: parsed.error, detail: parsed.detail });
    return;
  }
  const { plattform, periode, oppl } = parsed.params;
  try {
    const body: Record<string, unknown> = {
      success: true,
      plattform,
      periode: { fra: periode.fra, til: periode.til, oppl, tidssone: "UTC" },
      generated_at: now().toISOString(),
      forklaring:
        "Lesetall for bestillinger (Rett fra Bonden) og besøksforespørsler på gårdssalg (Opplevagent). " +
        "Ingen kjøper- eller gjesteopplysninger. Testdata er talt for seg i hver plattforms test-blokk.",
    };
    if (plattform === "rfb" || plattform === "alle") {
      body.rfb = computeRfbOverview(rfbDb(), periode, oppl, now());
    }
    if (plattform === "gardssalg" || plattform === "alle") {
      const e = expDb();
      if ("error" in e) body.gardssalg = gardssalgUnavailable(e.error);
      else {
        try { body.gardssalg = computeGardssalgOverview(e.db, periode, oppl); }
        catch (err) { body.gardssalg = gardssalgUnavailable(`Lesing feilet: ${err instanceof Error ? err.message : String(err)}`); }
      }
    }
    res.json(body);
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/liste", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = parseListeParams(req.query as Record<string, unknown>, now());
  if (!parsed.ok) {
    res.status(400).json({ success: false, error: parsed.error, detail: parsed.detail });
    return;
  }
  const { plattform, periode, status } = parsed.params;
  try {
    const lists: OrderListRow[][] = [];
    const merknader: string[] = [];
    if (plattform === "rfb" || plattform === "alle") {
      // In 'alle', a booking-only status simply matches no RFB order.
      lists.push(listRfbOrders(rfbDb(), periode, status));
    }
    if (plattform === "gardssalg" || plattform === "alle") {
      const e = expDb();
      if ("error" in e) merknader.push(e.error);
      else {
        try { lists.push(listGardssalgBookings(e.db, periode, status)); }
        catch (err) { merknader.push(`Gårdssalg kunne ikke leses: ${err instanceof Error ? err.message : String(err)}`); }
      }
    }
    const merged = mergeOrderLists(lists, LIST_CAP);
    res.json({
      success: true,
      plattform,
      periode: { fra: periode.fra, til: periode.til, tidssone: "UTC" },
      status,
      count: merged.rows.length,
      cap: LIST_CAP,
      truncated: merged.truncated,
      forklaring:
        `Bestillinger/forespørsler sendt inn i perioden, nyeste først, høyst ${LIST_CAP} rader. ` +
        "Hver rad har bare referanse, dato, plattform, produsent, status, antall varelinjer eller personer og beløp (kun RFB). " +
        "Testdata er med, merket is_test=true.",
      merknader,
      rows: merged.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;

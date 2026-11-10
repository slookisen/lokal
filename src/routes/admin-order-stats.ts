// ─── Admin: read-only order statistics ──────────────────────────────────────
//
// Slice S1 of the admin order-statistics dev-request (orch-pr-20261108-admin-
// ordre). Mounted at /admin/api/ordre. GET only — no write, no table, no
// migration; the order / booking flows are untouched. Since S2,
// GET /admin/orders/pilot-status reads its 30-day counts from the same
// service module (countRfbOrdersByStatus), response shape unchanged.
//
//   GET /admin/api/ordre/oversikt?plattform=rfb|gardssalg|alle
//                                &fra=YYYY-MM-DD&til=YYYY-MM-DD&oppl=dag|uke|maaned
//     Sums + zero-filled time series per platform (default: last 30 days,
//     oppl=dag, plattform=alle). Test producer / test provider rows are in a
//     separate `test` block, never in the main totals.
//
//     Slice S3 adds `henvisninger.rfb` (contact clicks per type and period,
//     bot and test clicks apart) and `ai_leveranser.rfb` («levert til
//     AI-assistent», never added to clicks) for plattform=rfb|alle.
//
//   GET /admin/api/ordre/eksport.csv?plattform=&fra=&til=&oppl=   (slice S2)
//     The oversikt numbers as a CSV of aggregates only (no order rows).
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
import * as path from "path";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import {
  parseOversiktParams,
  parseListeParams,
  computeRfbOverview,
  computeGardssalgOverview,
  computeRfbReferrals,
  computeRfbAiDeliveries,
  gardssalgUnavailable,
  listRfbOrders,
  listGardssalgBookings,
  mergeOrderLists,
  LIST_CAP,
  oversiktCsvRows,
  toCsv,
  type OrderListRow,
  type OversiktForCsv,
  type Periode,
  type Plattform,
  type Opplosning,
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

/** The per-platform oversikt blocks (shared by /oversikt and /eksport.csv). */
type Blocks = Pick<OversiktForCsv, "rfb" | "gardssalg" | "henvisninger" | "ai_leveranser">;
function computeBlocks(plattform: Plattform, periode: Periode, oppl: Opplosning): Blocks {
  const out: Blocks = {};
  if (plattform === "rfb" || plattform === "alle") {
    out.rfb = computeRfbOverview(rfbDb(), periode, oppl, now());
  }
  if (plattform === "gardssalg" || plattform === "alle") {
    const e = expDb();
    if ("error" in e) out.gardssalg = gardssalgUnavailable(e.error);
    else {
      try { out.gardssalg = computeGardssalgOverview(e.db, periode, oppl); }
      catch (err) { out.gardssalg = gardssalgUnavailable(`Lesing feilet: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
  // Slice S3: RFB clicks (contact_clicks, /ut/) and «levert til
  // AI-assistent» (profile_ai_deliveries), kept as separate blocks.
  if (plattform === "rfb" || plattform === "alle") {
    out.henvisninger = { rfb: computeRfbReferrals(rfbDb(), periode, oppl) };
    out.ai_leveranser = { rfb: computeRfbAiDeliveries(rfbDb(), periode, oppl) };
  }
  return out;
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
        "Ingen kjøper- eller gjesteopplysninger. Testdata er talt for seg i hver plattforms test-blokk. " +
        "Henvisninger (klikk videre til produsenten) og leveranser til AI-assistenter er egne tall og er ikke lagt sammen.",
      ...computeBlocks(plattform, periode, oppl),
    };
    res.json(body);
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /eksport.csv — slice S2. Same parameters, auth and numbers as
// /oversikt, as one long-format CSV of AGGREGATES only (see
// services/admin-order-stats.ts oversiktCsvRows): no order or booking row,
// no id/ref of an order, no buyer/guest field, note or free text.
router.get("/eksport.csv", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = parseOversiktParams(req.query as Record<string, unknown>, now());
  if (!parsed.ok) {
    res.status(400).json({ success: false, error: parsed.error, detail: parsed.detail });
    return;
  }
  const { plattform, periode, oppl } = parsed.params;
  try {
    const csv = toCsv(oversiktCsvRows({ plattform, periode, oppl, ...computeBlocks(plattform, periode, oppl) }));
    // plattform/fra/til are validated (enum + YYYY-MM-DD), so the file name is safe.
    const filename = `ordre-oversikt-${plattform}-${periode.fra}-${periode.til}-${oppl}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    // UTF-8 BOM so spreadsheet programs read æ/ø/å correctly.
    res.status(200).send("\uFEFF" + csv);
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

// ─── GET /admin/ordre — the read-only HTML page (slice S2) ───────────────────
//
// Mounted separately at /admin/ordre (adminOrderPageRouter). Follows the
// admin-crm.html pattern exactly: the HTML itself is served WITHOUT a
// server-side key check (a browser navigation cannot send X-Admin-Key) and
// holds no data; the page asks for the admin key, keeps it in sessionStorage
// ('rfb_admin_key', shared with the CRM page) and every data call it makes
// (/admin/api/ordre/oversikt, /admin/api/ordre/eksport.csv) sends
// X-Admin-Key and gets 401 without it. noindex via meta + X-Robots-Tag.
export const ADMIN_ORDRE_HTML = path.join(__dirname, "..", "public", "admin-ordre.html");
export const adminOrderPageRouter = Router();
adminOrderPageRouter.get("/", (_req: Request, res: Response) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(ADMIN_ORDRE_HTML);
});

export default router;

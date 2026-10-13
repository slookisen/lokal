// Swedish register import: SCB företagsregister + Bolagsverket bulk files.
//
// Both files are official, free and keyless (A2A strategic-decisions/se-dk-fase1/
// se-notat.md §2). They are streamed straight from the HTTP response through an
// in-process unzip, filtered line by line in memory, and only legal persons in
// scope are ever written (Daniel live 2026-10-13: «Bare selskaper»; LIA SE §7:
// "Registerrader som ikke oppfyller kandidatkriteriene … filtreres i minnet";
// DPIA T7: personnummer never stored). Sole traders (JurForm 10) are skipped by
// their identifier shape before any field is read, and a second guard refuses any
// "org number" that has the date+Luhn shape of a personnummer.
import { Readable, Transform, pipeline } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { type DB, getMeta, norm, setMeta } from "./db";
import { directSaleSignal, type Signal } from "./keywords";
import { looksLikeSwedishPersonId } from "./pii";
import countyTable from "./data/se-postcode-county.json";

export const SCB_URL = "https://vardefulla-datamangder.bolagsverket.se/scb/scb_bulkfil.zip";
export const BOLAGSVERKET_URL = "https://vardefulla-datamangder.bolagsverket.se/bolagsverket/bolagsverket_bulkfil.zip";

// SCB JurForm codes in scope (se-notat §3.1): 41/42/43/49 AB, 31 HB/KB,
// 51 ekonomisk förening. 10 = enskild firma (out of scope), 21 = enkla bolag
// (no legal personality), 91 = dödsbo (DPIA T16) — all excluded.
const LEGAL_FORMS: Record<string, string> = {
  "41": "AB",
  "42": "AB",
  "43": "AB",
  "49": "AB",
  "31": "HB/KB",
  "51": "ekonomisk förening",
};

const SNI_PREFIXES = ["01", "03", "10", "11"];
const REINDEER_HERDING = "01481";

const SCB_REQUIRED = ["PeOrgNr", "JurForm", "FtgStat", "Namn", "Foretagsnamn", "Ng1", "Ng2", "Ng3", "Ng4", "Ng5", "Gatuadress", "PostNr", "PostOrt", "Reklamsparrtyp"];
const BV_REQUIRED = ["organisationsidentitet", "avregistreringsdatum", "verksamhetsbeskrivning"];

const COUNTY_PRIORITY: Record<string, number> = { "Västra Götaland": 1, "Skåne": 2 };

// ── unzip ─────────────────────────────────────────────────────────────────

/**
 * Streams the first entry of a ZIP archive. Both register files are single-
 * entry, deflate-compressed archives: the local file header is stripped and the
 * rest goes through a raw inflater, which ends at the end of the deflate stream
 * (the trailing data descriptor and central directory are ignored). `pipeline`
 * carries backpressure end to end, so a 1 GB entry never sits in memory.
 */
export function zipFirstEntry(source: Readable): Readable {
  let header = Buffer.alloc(0);
  let headerDone = false;
  const stripHeader = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (headerDone) return cb(null, chunk);
      header = Buffer.concat([header, chunk]);
      if (header.length < 30) return cb();
      if (header.readUInt32LE(0) !== 0x04034b50) return cb(new Error("not a zip local file header"));
      const method = header.readUInt16LE(8);
      if (method !== 8) return cb(new Error(`unsupported zip compression method ${method}`));
      const start = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (header.length < start) return cb();
      headerDone = true;
      cb(null, header.subarray(start));
    },
    flush(cb) {
      cb(headerDone ? null : new Error("zip stream ended before the entry header"));
    },
  });
  const inflate = createInflateRaw();
  pipeline(source, stripHeader, inflate, (err) => {
    if (err) inflate.destroy(err);
  });
  return inflate;
}

// ── line + record parsing ─────────────────────────────────────────────────

export async function* readLines(stream: Readable, encoding: "latin1" | "utf8"): AsyncGenerator<string> {
  let rest: Buffer = Buffer.alloc(0);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let buf: Buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      let end = nl;
      if (end > start && buf[end - 1] === 0x0d) end--;
      yield buf.toString(encoding, start, end);
      start = nl + 1;
    }
    rest = buf.subarray(start);
    buf = rest;
  }
  if (rest.length) yield rest.toString(encoding).replace(/\r$/, "");
}

/** Splits one CSV record. Returns null when a quoted field is still open. */
export function splitCsv(text: string, sep: string): string[] | null {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") {
      inQuotes = true;
    } else if (ch === sep) {
      fields.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (inQuotes) return null;
  fields.push(cur);
  return fields;
}

const MAX_RECORD_CHARS = 200_000;

export async function* readCsvRecords(lines: AsyncIterable<string>, sep: string, stats: { malformed: number }): AsyncGenerator<string[]> {
  let pending: string | null = null;
  for await (const line of lines) {
    const text: string = pending === null ? line : `${pending}\n${line}`;
    const rec = splitCsv(text, sep);
    if (rec) {
      pending = null;
      yield rec;
    } else if (text.length > MAX_RECORD_CHARS) {
      stats.malformed++;
      pending = null;
    } else {
      pending = text;
    }
  }
  if (pending !== null) stats.malformed++;
}

function columnIndex(header: string[], required: string[], file: string): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    idx[h.trim()] = i;
  });
  const missing = required.filter((c) => idx[c] === undefined);
  if (missing.length) throw new Error(`${file}: missing required column(s) ${missing.join(", ")}`);
  return idx;
}

// ── county ────────────────────────────────────────────────────────────────

const counties = (countyTable as { counties: string[] }).counties;
const byPrefix = (countyTable as { prefix: Record<string, number> }).prefix;
const byException = (countyTable as { exceptions: Record<string, number> }).exceptions;

export function countyForPostalCode(postalCode: string | null | undefined): string | null {
  const code = (postalCode || "").replace(/\D/g, "");
  if (code.length !== 5) return null;
  const exact = byException[code];
  if (exact !== undefined) return counties[exact];
  const pref = byPrefix[code.slice(0, 3)];
  return pref !== undefined ? counties[pref] : null;
}

export function priorityFor(county: string | null, signal: Signal): number {
  const countyRank = (county && COUNTY_PRIORITY[county]) || 3;
  return countyRank * 10 + (signal.a.length ? 0 : 1);
}

// ── import ────────────────────────────────────────────────────────────────

interface UnitRow {
  orgNr: string;
  name: string;
  tradeName: string | null;
  legalForm: string;
  sni: string[];
  street: string | null;
  postalCode: string | null;
  postalTown: string | null;
  adBlock: boolean;
  descriptions: string[];
}

export interface ImportCounts {
  scb_rows: number;
  in_scope_units: number;
  bolagsverket_records: number;
  bolagsverket_malformed: number;
  units_with_description: number;
  signal_units: number;
  new_candidates: number;
  deactivated_units: number;
  skipped_optout: number;
  by_county: Record<string, number>;
  deactivation_skipped?: string;
}

export interface ImportSources {
  openScb: () => Promise<Readable>;
  openBolagsverket: () => Promise<Readable>;
}

export async function fetchZipEntry(url: string): Promise<Readable> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return zipFirstEntry(Readable.fromWeb(res.body as never));
}

export const liveSources: ImportSources = {
  openScb: () => fetchZipEntry(SCB_URL),
  openBolagsverket: () => fetchZipEntry(BOLAGSVERKET_URL),
};

export async function runSeImport(
  db: DB,
  sources: ImportSources,
  opts: { importId: string; now: () => Date; isOptedOut?: (orgNr: string) => boolean; onProgress?: (c: ImportCounts) => void },
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    scb_rows: 0,
    in_scope_units: 0,
    bolagsverket_records: 0,
    bolagsverket_malformed: 0,
    units_with_description: 0,
    signal_units: 0,
    new_candidates: 0,
    deactivated_units: 0,
    skipped_optout: 0,
    by_county: {},
  };
  const units = new Map<string, UnitRow>();

  // Pass 1 — SCB: legal persons in scope only.
  {
    const lines = readLines(await sources.openScb(), "latin1");
    let idx: Record<string, number> | null = null;
    for await (const line of lines) {
      if (idx === null) {
        idx = columnIndex(line.split("\t"), SCB_REQUIRED, "SCB");
        continue;
      }
      if (!line) continue;
      counts.scb_rows++;
      const f = line.split("\t");
      const peOrgNr = f[idx.PeOrgNr] || "";
      // Legal persons carry "16" + their 10-digit org number. A sole trader's
      // identifier is a personnummer and is dropped here, before anything else.
      if (!/^16\d{10}$/.test(peOrgNr)) continue;
      const legalForm = LEGAL_FORMS[f[idx.JurForm]];
      if (!legalForm || f[idx.FtgStat] !== "1") continue;
      const orgNr = peOrgNr.slice(2);
      if (looksLikeSwedishPersonId(orgNr)) continue;
      const sni = [f[idx.Ng1], f[idx.Ng2], f[idx.Ng3], f[idx.Ng4], f[idx.Ng5]].map((s) => (s || "").trim()).filter(Boolean);
      if (!sni.some((c) => SNI_PREFIXES.includes(c.slice(0, 2)))) continue;
      if (sni[0] === REINDEER_HERDING) continue;
      if (opts.isOptedOut && opts.isOptedOut(orgNr)) {
        counts.skipped_optout++;
        continue;
      }
      const name = (f[idx.Namn] || "").trim() || (f[idx.Foretagsnamn] || "").trim();
      if (!name) continue;
      units.set(orgNr, {
        orgNr,
        name,
        tradeName: (f[idx.Foretagsnamn] || "").trim() || null,
        legalForm,
        sni,
        street: (f[idx.Gatuadress] || "").trim() || null,
        postalCode: (f[idx.PostNr] || "").replace(/\s/g, "") || null,
        postalTown: (f[idx.PostOrt] || "").trim() || null,
        adBlock: f[idx.Reklamsparrtyp] === "2",
        descriptions: [],
      });
    }
    if (idx === null) throw new Error("SCB: empty file");
    counts.in_scope_units = units.size;
    opts.onProgress?.(counts);
  }

  // Pass 2 — Bolagsverket: activity descriptions for the units kept above.
  {
    const malformed = { malformed: 0 };
    const records = readCsvRecords(readLines(await sources.openBolagsverket(), "utf8"), ";", malformed);
    let idx: Record<string, number> | null = null;
    for await (const rec of records) {
      if (idx === null) {
        idx = columnIndex(rec, BV_REQUIRED, "Bolagsverket");
        continue;
      }
      counts.bolagsverket_records++;
      const m = /^(\d{10})\$ORGNR-IDORG$/.exec(rec[idx.organisationsidentitet] || "");
      if (!m) continue;
      const unit = units.get(m[1]);
      if (!unit) continue;
      if ((rec[idx.avregistreringsdatum] || "").trim()) continue;
      const desc = (rec[idx.verksamhetsbeskrivning] || "").trim();
      if (desc) unit.descriptions.push(desc);
    }
    if (idx === null) throw new Error("Bolagsverket: empty file");
    counts.bolagsverket_malformed = malformed.malformed;
  }

  // Write.
  const nowIso = opts.now().toISOString();
  const upsertUnit = db.prepare(`
    INSERT INTO register_units (unit_id, country, org_nr, name, trade_name, name_norm, legal_form, sni, street, postal_code, postal_town, town_norm, county, ad_block, signal, active, last_seen_import, created_at, updated_at)
    VALUES (@unit_id, 'se', @org_nr, @name, @trade_name, @name_norm, @legal_form, @sni, @street, @postal_code, @postal_town, @town_norm, @county, @ad_block, @signal, 1, @import_id, @now, @now)
    ON CONFLICT(unit_id) DO UPDATE SET name = excluded.name, trade_name = excluded.trade_name, name_norm = excluded.name_norm, legal_form = excluded.legal_form,
      sni = excluded.sni, street = excluded.street, postal_code = excluded.postal_code, postal_town = excluded.postal_town, town_norm = excluded.town_norm,
      county = excluded.county, ad_block = excluded.ad_block, signal = excluded.signal, active = 1,
      last_seen_import = excluded.last_seen_import, updated_at = excluded.updated_at`);
  const insertCandidate = db.prepare(`
    INSERT INTO candidates (candidate_id, country, origin, priority, status, created_at, updated_at)
    VALUES (?, 'se', 'register_signal', ?, 'new', ?, ?) ON CONFLICT(candidate_id) DO NOTHING`);
  const reviveCandidate = db.prepare(`
    UPDATE candidates SET status = 'new', status_reason = NULL, updated_at = ?
    WHERE candidate_id = ? AND status = 'excluded' AND status_reason = 'register_inactive'`);

  const rows = [...units.values()];
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const tx = db.transaction((batch: UnitRow[]) => {
      for (const u of batch) {
        const unitId = `se:${u.orgNr}`;
        const county = countyForPostalCode(u.postalCode);
        const signal = u.descriptions.length ? directSaleSignal(u.descriptions.join(" ")) : null;
        if (u.descriptions.length) counts.units_with_description++;
        upsertUnit.run({
          unit_id: unitId,
          org_nr: u.orgNr,
          name: u.name,
          trade_name: u.tradeName,
          name_norm: norm(`${u.name} ${u.tradeName || ""}`),
          legal_form: u.legalForm,
          sni: JSON.stringify(u.sni),
          street: u.street,
          postal_code: u.postalCode,
          postal_town: u.postalTown,
          town_norm: norm(u.postalTown) || null,
          county,
          ad_block: u.adBlock ? 1 : 0,
          signal: signal ? JSON.stringify(signal) : null,
          import_id: opts.importId,
          now: nowIso,
        });
        reviveCandidate.run(nowIso, unitId);
        if (signal) {
          counts.signal_units++;
          const key = county || "Okänt";
          counts.by_county[key] = (counts.by_county[key] || 0) + 1;
          if (insertCandidate.run(unitId, priorityFor(county, signal), nowIso, nowIso).changes) counts.new_candidates++;
        }
      }
    });
    tx(rows.slice(i, i + BATCH));
    await new Promise((r) => setImmediate(r));
  }

  // Deactivate units that left the register or the scope — unless this import
  // saw suspiciously few units (a truncated download must not mass-exclude).
  const previouslyActive = (db.prepare("SELECT COUNT(*) AS n FROM register_units WHERE country = 'se' AND active = 1 AND last_seen_import != ?").get(opts.importId) as { n: number }).n;
  const seenNow = units.size;
  if (previouslyActive > 0 && seenNow < 0.5 * (previouslyActive + seenNow)) {
    counts.deactivation_skipped = `only ${seenNow} units seen against ${previouslyActive} not seen; deactivation skipped`;
  } else {
    const tx = db.transaction(() => {
      const stale = db.prepare("SELECT unit_id FROM register_units WHERE country = 'se' AND active = 1 AND last_seen_import != ?").all(opts.importId) as { unit_id: string }[];
      const deact = db.prepare("UPDATE register_units SET active = 0, updated_at = ? WHERE unit_id = ?");
      const excl = db.prepare("UPDATE candidates SET status = 'excluded', status_reason = 'register_inactive', lease_run_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE candidate_id = ? AND status != 'approved'");
      const review = db.prepare("UPDATE candidates SET status = 'needs_review', status_reason = 'register_inactive', updated_at = ? WHERE candidate_id = ? AND status = 'approved'");
      for (const s of stale) {
        deact.run(nowIso, s.unit_id);
        excl.run(nowIso, s.unit_id);
        review.run(nowIso, s.unit_id);
      }
      counts.deactivated_units = stale.length;
    });
    tx();
  }

  setMeta(db, "se_last_import", JSON.stringify({ import_id: opts.importId, finished_at: opts.now().toISOString(), counts }));
  return counts;
}

export function lastImport(db: DB): { import_id: string; finished_at: string; counts: ImportCounts } | null {
  const v = getMeta(db, "se_last_import");
  return v ? JSON.parse(v) : null;
}

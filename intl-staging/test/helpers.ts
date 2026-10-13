import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { createApp } from "../src/app";
import { openDb } from "../src/db";
import type { ImportSources } from "../src/se-import";

/** Builds a minimal single-entry deflate ZIP (local header + data + central directory). */
export function makeZip(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

export function chunked(buf: Buffer, size = 997): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

export const SCB_HEADER = [
  "ForAndrTyp", "COAdress", "Foretagsnamn", "FtgStat", "Gatuadress", "JEStat", "JurForm", "Namn",
  "Ng1", "Ng2", "Ng3", "Ng4", "Ng5", "PeOrgNr", "PostNr", "PostOrt", "RegDatKtid", "Reklamsparrtyp",
];

export function scbRow(r: Partial<Record<string, string>>): string {
  return SCB_HEADER.map((h) => r[h] ?? "").join("\t");
}

export function scbFile(rows: Array<Partial<Record<string, string>>>): Buffer {
  const text = `${SCB_HEADER.join("\t")}\t\r\n${rows.map((r) => `${scbRow(r)}\t`).join("\r\n")}\r\n`;
  return Buffer.from(text, "latin1");
}

export const BV_HEADER = [
  "organisationsidentitet", "namnskyddslopnummer", "registreringsland", "organisationsnamn", "organisationsform",
  "avregistreringsdatum", "avregistreringsorsak", "pagandeAvvecklingsEllerOmstruktureringsforfarande",
  "registreringsdatum", "verksamhetsbeskrivning", "postadress",
];

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function bvFile(rows: Array<Partial<Record<string, string>>>): Buffer {
  const lines = [BV_HEADER.join(";"), ...rows.map((r) => BV_HEADER.map((h) => (r[h] ? q(r[h] as string) : "")).join(";"))];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function sourcesFrom(scb: Buffer, bv: Buffer): ImportSources {
  const { zipFirstEntry } = require("../src/se-import") as typeof import("../src/se-import");
  return {
    openScb: async () => zipFirstEntry(chunked(makeZip("scb.txt", scb))),
    openBolagsverket: async () => zipFirstEntry(chunked(makeZip("bv.txt", bv))),
  };
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "intl-staging-test-"));
}

export const TOKEN = "test-token-123456";

export function makeTestApp(opts: { now?: () => Date; sources?: ImportSources; limits?: { diskMaxPct: number; dbMaxBytes: number } } = {}) {
  const dir = tmpDir();
  const dbFile = path.join(dir, "intl.db");
  const db = openDb(dbFile);
  const app = createApp({
    db,
    dataDir: dir,
    dbFile,
    token: TOKEN,
    hmacKey: "hmac-test-key",
    limits: opts.limits || { diskMaxPct: 101, dbMaxBytes: 2 ** 40 },
    now: opts.now || (() => new Date()),
    importSources: opts.sources || sourcesFrom(scbFile([]), bvFile([])),
  });
  return { app, db, dir, dbFile };
}

export async function withServer<T>(app: ReturnType<typeof createApp>, fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

export async function call(base: string, method: string, p: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json, headers: res.headers };
}

// Offsite DB backup to Fly Tigris — slice S2 of dev-request
// 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok (Daniel live 2026-10-09: backup off the
// machine to Fly Tigris; 2026-10-10: «start S2 backup nå»).
//
// Until now every backup lived on the same Fly volume as the live DBs
// (src/routes/admin-db-backup.ts), so losing the volume or the machine lost both.
//
// Nightly, in the 04 UTC hour (after the 03 UTC prune + WAL checkpoint, never 07–09 UTC),
// for each DB file — rfb (lokal.db), dental.db, experiences.db — one after the other:
//   better-sqlite3 .backup() (SQLite online backup, chunked between event-loop turns)
//   -> temp file on the volume -> gzip level 1 (zlib runs on the libuv threadpool)
//   -> streamed sha256 -> PUT to the private Tigris bucket -> temp files removed
//   -> bucket retention: the 7 newest objects + the newest object of each of the
//      4 most recent older ISO weeks. Retention runs only after a successful upload.
// Weekly (Sunday, same hour): restore test — download the newest object per DB, check its
// sha256, gunzip to a temp file, PRAGMA integrity_check in a worker thread, delete the file.
//
// Credentials come only from the five secrets `fly storage create` defines
// (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION, BUCKET_NAME).
// If any is missing the job is a no-op and reports `configured: false`. Credential values
// are never logged or returned.
//
// No AWS SDK: a small SigV4 signer (checked in the tests against AWS's documented example
// and against botocore) and node:https keep the image unchanged. Tigris only accepts
// virtual-hosted URLs for buckets created after 2025-02-19, so every request goes to
// https://<bucket>.<endpoint-host>/<key>.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import { pipeline } from "stream/promises";
import { Worker } from "worker_threads";
import { getJobLastCompletedAt, markJobCompleted } from "./boot-job-gate";

// ── Config ────────────────────────────────────────────────────────────

export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: URL;
  region: string;
  bucket: string;
}

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const accessKeyId = (env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY || "").trim();
  const endpointRaw = (env.AWS_ENDPOINT_URL_S3 || "").trim();
  const bucket = (env.BUCKET_NAME || "").trim();
  const region = (env.AWS_REGION || "").trim() || "auto";
  if (!accessKeyId || !secretAccessKey || !endpointRaw || !bucket) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return null;
  return { accessKeyId, secretAccessKey, endpoint, region, bucket };
}

// ── SigV4 ─────────────────────────────────────────────────────────────

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** SigV4 URI encoding: every byte except A-Z a-z 0-9 - _ . ~ is %XX; '/' kept only when keepSlash. */
export function awsUriEncode(s: string, keepSlash: boolean): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (c === "/" && keepSlash) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function canonicalQueryString(query: Record<string, string> | undefined): string {
  return Object.entries(query ?? {})
    .map(([k, v]) => [awsUriEncode(k, false), awsUriEncode(v, false)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export interface SignInput {
  method: string;
  /** Host header value (with :port when it is not the protocol default). */
  host: string;
  /** Already URI-encoded path, e.g. "/db/rfb/x.db.gz". */
  canonicalPath: string;
  query?: Record<string, string>;
  /** Extra headers to sign. */
  headers?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now: Date;
}

/** Returns every header to send (lower-case names), including authorization. */
export function signV4(input: SignInput): Record<string, string> {
  const service = input.service ?? "s3";
  const amzDate = input.now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const hdrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    hdrs[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }
  hdrs["host"] = input.host;
  hdrs["x-amz-content-sha256"] = input.payloadHash;
  hdrs["x-amz-date"] = amzDate;
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.canonicalPath,
    canonicalQueryString(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + input.secretAccessKey, dateStamp), input.region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    ...hdrs,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ── Minimal S3 client (virtual-hosted) ────────────────────────────────

export interface S3Deps {
  /** Test seam: open the TCP connection here; the Host header stays the virtual host. */
  connectHost?: string;
  now?: () => Date;
  /** Socket idle timeout. */
  timeoutMs?: number;
}

export interface S3Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function virtualHost(cfg: S3Config): { hostname: string; port: number; hostHeader: string } {
  const hostname = `${cfg.bucket}.${cfg.endpoint.hostname}`;
  const defaultPort = cfg.endpoint.protocol === "https:" ? 443 : 80;
  const port = cfg.endpoint.port ? Number(cfg.endpoint.port) : defaultPort;
  return { hostname, port, hostHeader: port === defaultPort ? hostname : `${hostname}:${port}` };
}

export function objectPath(key: string): string {
  return "/" + awsUriEncode(key, true);
}

interface SendOpts {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash?: string;
  bodyFile?: string;
  /** Stream a 200 response body to this file instead of buffering it. */
  toFile?: string;
}

const MAX_BUFFERED_BODY = 8 * 1024 * 1024;

async function s3Send(cfg: S3Config, method: string, key: string, opts: SendOpts, deps: S3Deps): Promise<S3Response> {
  const vh = virtualHost(cfg);
  const canonicalPath = key ? objectPath(key) : "/";
  const payloadHash = opts.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = signV4({
    method,
    host: vh.hostHeader,
    canonicalPath,
    query: opts.query,
    headers: opts.headers,
    payloadHash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    now: (deps.now ?? (() => new Date()))(),
  });
  if (opts.bodyFile) headers["content-length"] = String(fs.statSync(opts.bodyFile).size);
  const qs = canonicalQueryString(opts.query);
  const transport = cfg.endpoint.protocol === "https:" ? https : http;

  return new Promise<S3Response>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = transport.request(
      {
        hostname: deps.connectHost ?? vh.hostname,
        servername: vh.hostname,
        port: vh.port,
        method,
        path: canonicalPath + (qs ? "?" + qs : ""),
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (opts.toFile && status === 200) {
          pipeline(res, fs.createWriteStream(opts.toFile)).then(
            () => {
              if (settled) return;
              settled = true;
              resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
            },
            (err) => fail(err instanceof Error ? err : new Error(String(err))),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BUFFERED_BODY) chunks.push(c);
        });
        res.on("end", () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          if (status < 200 || status >= 300) {
            settled = true;
            const detail = body.toString("utf8").replace(/\s+/g, " ").slice(0, 300);
            reject(new Error(`S3 ${method} ${key || "/"} -> HTTP ${status}${detail ? ": " + detail : ""}`));
            return;
          }
          settled = true;
          resolve({ status, headers: res.headers, body });
        });
        res.on("error", fail);
      },
    );
    req.setTimeout(deps.timeoutMs ?? 120_000, () => req.destroy(new Error(`S3 ${method} ${key || "/"} timed out`)));
    req.on("error", fail);
    if (opts.bodyFile) {
      pipeline(fs.createReadStream(opts.bodyFile), req).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
    } else {
      req.end();
    }
  });
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function putObjectFromFile(
  cfg: S3Config,
  key: string,
  filePath: string,
  deps: S3Deps = {},
): Promise<{ size: number; sha256: string }> {
  const size = fs.statSync(filePath).size;
  const sha256 = await sha256File(filePath);
  await s3Send(cfg, "PUT", key, {
    payloadHash: sha256,
    bodyFile: filePath,
    headers: { "content-type": "application/gzip", "x-amz-meta-sha256": sha256 },
  }, deps);
  return { size, sha256 };
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: Date;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseListObjectsXml(xml: string): { objects: S3Object[]; nextToken: string | null } {
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    if (key === undefined) continue;
    const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
    const lm = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(body)?.[1] ?? "");
    objects.push({ key: xmlUnescape(key), size, lastModified: new Date(Number.isNaN(lm) ? 0 : lm) });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, nextToken: truncated && token ? xmlUnescape(token) : null };
}

export async function listObjects(cfg: S3Config, prefix: string, deps: S3Deps = {}): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await s3Send(cfg, "GET", "", { query }, deps);
    const parsed = parseListObjectsXml(res.body.toString("utf8"));
    out.push(...parsed.objects);
    token = parsed.nextToken;
    if (!token) break;
  }
  return out;
}

export async function deleteObject(cfg: S3Config, key: string, deps: S3Deps = {}): Promise<void> {
  await s3Send(cfg, "DELETE", key, {}, deps);
}

export async function getObjectToFile(
  cfg: S3Config,
  key: string,
  dest: string,
  deps: S3Deps = {},
): Promise<{ metaSha256: string | null }> {
  const res = await s3Send(cfg, "GET", key, { toFile: dest }, deps);
  const meta = res.headers["x-amz-meta-sha256"];
  return { metaSha256: typeof meta === "string" ? meta : null };
}

// ── Keys and retention ────────────────────────────────────────────────

export const OFFSITE_VERTICALS = ["rfb", "dental", "experiences"] as const;
export type OffsiteVertical = (typeof OFFSITE_VERTICALS)[number];

export function isOffsiteVertical(v: unknown): v is OffsiteVertical {
  return typeof v === "string" && (OFFSITE_VERTICALS as readonly string[]).includes(v);
}

export const OBJECT_KEY_RE = /^db\/(rfb|dental|experiences)\/(rfb|dental|experiences)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?Z\.db\.gz$/;

export function backupObjectKey(vertical: OffsiteVertical, now: Date): string {
  return `db/${vertical}/${vertical}-${now.toISOString().replace(/:/g, "-").replace(".", "-")}.db.gz`;
}

/** ISO-8601 week of a UTC date, e.g. "2026-W41". */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Keys to delete: everything except the `keepDaily` newest objects and the newest object of
 * each of the `keepWeekly` most recent ISO weeks among the rest. Only backup keys
 * (OBJECT_KEY_RE) are ever considered, so a foreign object in the bucket is never deleted.
 */
export function selectBackupsToDelete(objects: S3Object[], keepDaily = 7, keepWeekly = 4): string[] {
  const ours = objects
    .filter((o) => OBJECT_KEY_RE.test(o.key))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.key < b.key ? 1 : -1));
  const keep = new Set(ours.slice(0, keepDaily).map((o) => o.key));
  const weeks = new Set<string>();
  for (const o of ours.slice(keepDaily)) {
    const w = isoWeekKey(o.lastModified);
    if (weeks.has(w)) continue;
    if (weeks.size >= keepWeekly) break;
    weeks.add(w);
    keep.add(o.key);
  }
  return ours.filter((o) => !keep.has(o.key)).map((o) => o.key);
}

// ── Schedule ──────────────────────────────────────────────────────────

/** 04 UTC: after the 03 UTC prune + WAL checkpoint, before the 07–09 UTC send window. */
export const OFFSITE_BACKUP_HOUR_UTC = 4;

export function isOffsiteBlockedHour(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= 7 && h <= 9;
}

export function shouldRunOffsiteBackup(now: Date, lastRunAt: Date | null): boolean {
  if (now.getUTCHours() !== OFFSITE_BACKUP_HOUR_UTC) return false;
  return !lastRunAt || now.getTime() - lastRunAt.getTime() >= 20 * 3600_000;
}

export function shouldRunRestoreTest(now: Date, lastRunAt: Date | null): boolean {
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== OFFSITE_BACKUP_HOUR_UTC) return false;
  return !lastRunAt || now.getTime() - lastRunAt.getTime() >= 6 * 24 * 3600_000;
}

// ── One DB ────────────────────────────────────────────────────────────

export interface BackupTarget {
  vertical: OffsiteVertical;
  db: { name: string; backup(destination: string): Promise<unknown> };
}

export interface OffsiteDeps extends S3Deps {
  /** Directory for temp files; default <db dir>/backups/offsite-tmp. */
  tmpDir?: string;
  /** Free bytes at a directory; null = unknown (check skipped). */
  freeBytes?: (dir: string) => number | null;
}

export const OFFSITE_FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

function freeBytesAt(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tmpDirFor(dbFile: string, deps: OffsiteDeps): string {
  const dir = deps.tmpDir ?? path.join(path.dirname(dbFile), "backups", "offsite-tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface DbBackupResult {
  vertical: OffsiteVertical;
  ok: boolean;
  key?: string;
  dbBytes?: number;
  gzBytes?: number;
  sha256?: string;
  deleted?: string[];
  retentionError?: string;
  skipped?: "low_disk";
  error?: string;
  durationMs: number;
}

export async function backupOneDb(t: BackupTarget, cfg: S3Config, deps: OffsiteDeps = {}): Promise<DbBackupResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const done = (r: Omit<DbBackupResult, "vertical" | "durationMs">): DbBackupResult => ({
    vertical: t.vertical,
    ...r,
    durationMs: Date.now() - started,
  });
  let rawPath = "";
  let gzPath = "";
  try {
    const dbFile = t.db.name;
    const dir = tmpDirFor(dbFile, deps);
    const liveBytes = fileSize(dbFile) + fileSize(dbFile + "-wal");
    const needed = 2 * liveBytes + OFFSITE_FREE_SPACE_MARGIN_BYTES;
    const free = (deps.freeBytes ?? freeBytesAt)(dir);
    if (free !== null && free < needed) {
      return done({ ok: false, skipped: "low_disk", error: `free ${free} B < needed ${needed} B` });
    }
    const key = backupObjectKey(t.vertical, now);
    rawPath = path.join(dir, path.basename(key, ".gz"));
    gzPath = rawPath + ".gz";
    await t.db.backup(rawPath);
    const dbBytes = fileSize(rawPath);
    await pipeline(fs.createReadStream(rawPath), zlib.createGzip({ level: 1 }), fs.createWriteStream(gzPath));
    safeUnlink(rawPath);
    const { size: gzBytes, sha256 } = await putObjectFromFile(cfg, key, gzPath, deps);
    safeUnlink(gzPath);

    // Retention only after a successful upload; a retention error never fails the backup.
    const deleted: string[] = [];
    let retentionError: string | undefined;
    try {
      const objs = await listObjects(cfg, `db/${t.vertical}/`, deps);
      for (const k of selectBackupsToDelete(objs)) {
        if (k === key) continue;
        await deleteObject(cfg, k, deps);
        deleted.push(k);
      }
    } catch (err) {
      retentionError = errMsg(err);
    }
    return done({ ok: true, key, dbBytes, gzBytes, sha256, deleted, ...(retentionError ? { retentionError } : {}) });
  } catch (err) {
    return done({ ok: false, error: errMsg(err) });
  } finally {
    if (rawPath) safeUnlink(rawPath);
    if (gzPath) safeUnlink(gzPath);
  }
}

// ── Restore test ──────────────────────────────────────────────────────

/** Runs PRAGMA integrity_check on a DB file in a worker thread (never on the main thread). */
export function integrityCheckInWorker(dbPath: string, timeoutMs = 30 * 60_000): Promise<string[]> {
  const script = path.join(__dirname, "offsite-backup-worker" + path.extname(__filename));
  const options = { workerData: { dbPath }, resourceLimits: { maxOldGenerationSizeMb: 128 } };
  // Same bootstrap as offthread-stats.ts: tsx's hooks do not reach worker threads, so a .ts
  // entry registers tsx's require hook inside the worker first.
  const w = script.endsWith(".ts")
    ? new Worker(`require(${JSON.stringify(require.resolve("tsx/cjs"))});\nrequire(${JSON.stringify(script)});`, {
        ...options,
        eval: true,
      })
    : new Worker(script, options);
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void w.terminate().catch(() => {});
    };
    const timer = setTimeout(() => finish(() => reject(new Error("integrity_check timed out"))), timeoutMs);
    w.on("message", (m: { ok: boolean; result?: string[]; error?: string }) =>
      finish(() => (m.ok ? resolve(m.result ?? []) : reject(new Error(m.error || "integrity_check failed")))),
    );
    w.on("error", (e: Error) => finish(() => reject(e)));
    w.on("exit", (code) => finish(() => reject(new Error(`integrity worker exited (code ${code})`))));
  });
}

export interface RestoreTestResult {
  vertical: OffsiteVertical;
  ok: boolean;
  key?: string;
  integrity?: string;
  skipped?: "no_backup" | "low_disk";
  error?: string;
  durationMs: number;
}

export async function restoreTestOne(
  vertical: OffsiteVertical,
  liveDbFile: string,
  cfg: S3Config,
  deps: OffsiteDeps = {},
): Promise<RestoreTestResult> {
  const started = Date.now();
  const done = (r: Omit<RestoreTestResult, "vertical" | "durationMs">): RestoreTestResult => ({
    vertical,
    ...r,
    durationMs: Date.now() - started,
  });
  let gzPath = "";
  let rawPath = "";
  try {
    const objs = (await listObjects(cfg, `db/${vertical}/`, deps)).filter((o) => OBJECT_KEY_RE.test(o.key));
    if (objs.length === 0) return done({ ok: false, skipped: "no_backup" });
    objs.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.key < b.key ? 1 : -1));
    const newest = objs[0];
    const dir = tmpDirFor(liveDbFile, deps);
    const needed = newest.size + Math.ceil(1.2 * fileSize(liveDbFile)) + OFFSITE_FREE_SPACE_MARGIN_BYTES;
    const free = (deps.freeBytes ?? freeBytesAt)(dir);
    if (free !== null && free < needed) {
      return done({ ok: false, key: newest.key, skipped: "low_disk", error: `free ${free} B < needed ${needed} B` });
    }
    gzPath = path.join(dir, "restore-" + path.basename(newest.key));
    rawPath = gzPath.replace(/\.gz$/, "");
    const { metaSha256 } = await getObjectToFile(cfg, newest.key, gzPath, deps);
    if (metaSha256) {
      const actual = await sha256File(gzPath);
      if (actual !== metaSha256) return done({ ok: false, key: newest.key, error: "sha256 mismatch after download" });
    }
    await pipeline(fs.createReadStream(gzPath), zlib.createGunzip(), fs.createWriteStream(rawPath));
    safeUnlink(gzPath);
    const rows = await integrityCheckInWorker(rawPath);
    const integrity = rows.join("; ") || "(empty)";
    return done({ ok: integrity === "ok", key: newest.key, integrity });
  } catch (err) {
    return done({ ok: false, error: errMsg(err) });
  } finally {
    if (gzPath) safeUnlink(gzPath);
    if (rawPath) {
      safeUnlink(rawPath);
      safeUnlink(rawPath + "-wal");
      safeUnlink(rawPath + "-shm");
    }
  }
}

// ── Runs, state and status ────────────────────────────────────────────

export const JOB_BACKUP = "offsite-backup";
export const JOB_RESTORE = "offsite-restore-test";

type StateDb = Parameters<typeof getJobLastCompletedAt>[0];

let running: "backup" | "restore" | null = null;
let lastBackupResults: DbBackupResult[] = [];
let lastRestoreResults: RestoreTestResult[] = [];
let statusCache: { lastSuccessAt: Record<string, string | null>; lastRestoreOkAt: Record<string, string | null> } | null = null;

function defaultTarget(vertical: OffsiteVertical): BackupTarget {
  // Lazy require: keeps this module loadable in tests without opening the prod DBs.
  const factory = require("../database/db-factory") as typeof import("../database/db-factory");
  return { vertical, db: factory.getDb(vertical) as unknown as BackupTarget["db"] };
}

function defaultStateDb(): StateDb {
  const init = require("../database/init") as typeof import("../database/init");
  return init.getDb();
}

function loadStatusCache(stateDb: StateDb): NonNullable<typeof statusCache> {
  if (statusCache) return statusCache;
  const lastSuccessAt: Record<string, string | null> = {};
  const lastRestoreOkAt: Record<string, string | null> = {};
  for (const v of OFFSITE_VERTICALS) {
    lastSuccessAt[v] = getJobLastCompletedAt(stateDb, `${JOB_BACKUP}:${v}`)?.toISOString() ?? null;
    lastRestoreOkAt[v] = getJobLastCompletedAt(stateDb, `${JOB_RESTORE}:${v}`)?.toISOString() ?? null;
  }
  statusCache = { lastSuccessAt, lastRestoreOkAt };
  return statusCache;
}

export interface OffsiteRunOptions {
  verticals?: OffsiteVertical[];
  /** Scheduled runs also stamp the whole-run job so a restart inside the hour does not re-run it. */
  scheduled?: boolean;
  env?: NodeJS.ProcessEnv;
  getTarget?: (v: OffsiteVertical) => BackupTarget;
  stateDb?: StateDb;
  deps?: OffsiteDeps;
}

export type OffsiteRunSkip = "not_configured" | "already_running";

export async function runOffsiteBackupNow(
  opts: OffsiteRunOptions = {},
): Promise<{ skipped?: OffsiteRunSkip; results: DbBackupResult[] }> {
  const cfg = readS3Config(opts.env);
  if (!cfg) return { skipped: "not_configured", results: [] };
  if (running) return { skipped: "already_running", results: [] };
  running = "backup";
  try {
    const stateDb = opts.stateDb ?? defaultStateDb();
    const cache = loadStatusCache(stateDb);
    const results: DbBackupResult[] = [];
    for (const v of opts.verticals ?? OFFSITE_VERTICALS) {
      let r: DbBackupResult;
      try {
        r = await backupOneDb((opts.getTarget ?? defaultTarget)(v), cfg, opts.deps);
      } catch (err) {
        r = { vertical: v, ok: false, error: errMsg(err), durationMs: 0 };
      }
      if (r.ok) {
        const at = (opts.deps?.now ?? (() => new Date()))();
        markJobCompleted(stateDb, `${JOB_BACKUP}:${v}`, at);
        cache.lastSuccessAt[v] = at.toISOString();
      }
      results.push(r);
    }
    if (opts.scheduled) markJobCompleted(stateDb, JOB_BACKUP, (opts.deps?.now ?? (() => new Date()))());
    lastBackupResults = results;
    return { results };
  } finally {
    running = null;
  }
}

export async function runRestoreTestNow(
  opts: OffsiteRunOptions = {},
): Promise<{ skipped?: OffsiteRunSkip; results: RestoreTestResult[] }> {
  const cfg = readS3Config(opts.env);
  if (!cfg) return { skipped: "not_configured", results: [] };
  if (running) return { skipped: "already_running", results: [] };
  running = "restore";
  try {
    const stateDb = opts.stateDb ?? defaultStateDb();
    const cache = loadStatusCache(stateDb);
    const results: RestoreTestResult[] = [];
    for (const v of opts.verticals ?? OFFSITE_VERTICALS) {
      let r: RestoreTestResult;
      try {
        r = await restoreTestOne(v, (opts.getTarget ?? defaultTarget)(v).db.name, cfg, opts.deps);
      } catch (err) {
        r = { vertical: v, ok: false, error: errMsg(err), durationMs: 0 };
      }
      if (r.ok) {
        const at = (opts.deps?.now ?? (() => new Date()))();
        markJobCompleted(stateDb, `${JOB_RESTORE}:${v}`, at);
        cache.lastRestoreOkAt[v] = at.toISOString();
      }
      results.push(r);
    }
    if (opts.scheduled) markJobCompleted(stateDb, JOB_RESTORE, (opts.deps?.now ?? (() => new Date()))());
    lastRestoreResults = results;
    return { results };
  } finally {
    running = null;
  }
}

export function isOffsiteRunning(): boolean {
  return running !== null;
}

/** Cheap status for /health and the admin route (no network; boot_job_state read once). */
export function getOffsiteBackupStatus(opts: { env?: NodeJS.ProcessEnv; stateDb?: StateDb } = {}) {
  const configured = readS3Config(opts.env) !== null;
  let cache: typeof statusCache = null;
  try {
    cache = loadStatusCache(opts.stateDb ?? defaultStateDb());
  } catch {
    cache = null;
  }
  const brief = (r: DbBackupResult | RestoreTestResult) => ({
    vertical: r.vertical,
    ok: r.ok,
    ...(r.skipped ? { skipped: r.skipped } : {}),
    ...(r.error ? { error: r.error.slice(0, 200) } : {}),
  });
  return {
    configured,
    running,
    lastSuccessAt: cache?.lastSuccessAt ?? null,
    lastRestoreOkAt: cache?.lastRestoreOkAt ?? null,
    lastBackup: lastBackupResults.map(brief),
    lastRestore: lastRestoreResults.map(brief),
  };
}

function logBackup(r: DbBackupResult): void {
  console.log(
    `[offsite-backup] ${r.vertical} ok=${r.ok} key=${r.key ?? "-"} dbBytes=${r.dbBytes ?? "-"} gzBytes=${r.gzBytes ?? "-"} ` +
      `deleted=${r.deleted?.length ?? 0} ms=${r.durationMs}` +
      (r.skipped ? ` skipped=${r.skipped}` : "") +
      (r.error ? ` error=${r.error}` : "") +
      (r.retentionError ? ` retentionError=${r.retentionError}` : ""),
  );
}

function logRestore(r: RestoreTestResult): void {
  console.log(
    `[offsite-restore-test] ${r.vertical} ok=${r.ok} key=${r.key ?? "-"} integrity=${r.integrity ?? "-"} ms=${r.durationMs}` +
      (r.skipped ? ` skipped=${r.skipped}` : "") +
      (r.error ? ` error=${r.error}` : ""),
  );
}

/** Starts a manual run in the background (admin route). Never throws. */
export function startManualRun(kind: "backup" | "restore", verticals: OffsiteVertical[]): void {
  const run = kind === "backup"
    ? runOffsiteBackupNow({ verticals }).then((s) => s.results.forEach(logBackup))
    : runRestoreTestNow({ verticals }).then((s) => s.results.forEach(logRestore));
  run.catch((err) => console.error(`[offsite-${kind}] manual run failed (non-fatal):`, err));
}

/** Hourly scheduler tick for src/index.ts. Never throws. */
export function createOffsiteBackupTick(getStateDb: () => StateDb = defaultStateDb): () => Promise<void> {
  return async () => {
    try {
      if (!readS3Config() || running) return;
      const now = new Date();
      const stateDb = getStateDb();
      if (shouldRunOffsiteBackup(now, getJobLastCompletedAt(stateDb, JOB_BACKUP))) {
        const s = await runOffsiteBackupNow({ scheduled: true, stateDb });
        s.results.forEach(logBackup);
      }
      if (shouldRunRestoreTest(now, getJobLastCompletedAt(stateDb, JOB_RESTORE))) {
        const s = await runRestoreTestNow({ scheduled: true, stateDb });
        s.results.forEach(logRestore);
      }
    } catch (err) {
      console.error("[offsite-backup] tick failed (non-fatal):", err);
    }
  };
}

/** Test-only: reset module state. */
export function __resetOffsiteBackupForTesting(): void {
  running = null;
  lastBackupResults = [];
  lastRestoreResults = [];
  statusCache = null;
}

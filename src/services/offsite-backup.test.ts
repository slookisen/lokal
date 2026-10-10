/**
 * offsite-backup.test.ts — slice S2 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok.
 *
 * SigV4 vectors: the two GET examples from AWS's S3 SigV4 documentation, plus three
 * virtual-hosted Tigris requests whose expected signatures were generated with botocore
 * (S3SigV4Auth) for exactly the inputs below.
 */
import Database from "better-sqlite3";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as zlib from "zlib";
import * as crypto from "crypto";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

type Stored = { body: Buffer; lastModified: Date; meta: string | null };

/** Calls an Express router directly (same seam as src/routes/admin-db-backup.test.ts). */
function callRoute(router: any, method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const query: Record<string, string> = {};
    const qi = url.indexOf("?");
    if (qi !== -1) for (const pair of url.slice(qi + 1).split("&")) { const [k, v] = pair.split("="); query[k] = decodeURIComponent(v ?? ""); }
    const req: any = { method, url, query, headers };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "no route") } }));
  });
}

function startFakeS3(bucket: string, secret: string, ob: typeof import("./offsite-backup")) {
  const store = new Map<string, Stored>();
  const log: Array<{ method: string; key: string; status: number }> = [];
  const state = { failPut: false, failPutTimes: 0, putStatus: 500, failList: false, now: new Date("2026-10-10T04:00:05Z"), pageSize: 2 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url || "/", "http://x");
      const key = decodeURIComponent(url.pathname.slice(1));
      const send = (status: number, payload = "", headers: Record<string, string> = {}) => {
        log.push({ method: req.method || "", key, status });
        res.writeHead(status, headers);
        res.end(payload);
      };
      // Host must be the virtual host, and the signature must match the request as sent.
      const port = (server.address() as any).port;
      if (req.headers.host !== `${bucket}.127.0.0.1:${port}`) return send(400, "bad host");
      const auth = String(req.headers.authorization || "");
      const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      if (!m) return send(403, "no auth");
      const extra: Record<string, string> = {};
      for (const h of m[4].split(";")) {
        if (h !== "host" && h !== "x-amz-content-sha256" && h !== "x-amz-date") extra[h] = String(req.headers[h]);
      }
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      const amz = String(req.headers["x-amz-date"]);
      const expect = ob.signV4({
        method: req.method || "GET",
        host: String(req.headers.host),
        canonicalPath: url.pathname,
        query,
        headers: extra,
        payloadHash: String(req.headers["x-amz-content-sha256"]),
        accessKeyId: m[1],
        secretAccessKey: secret,
        region: m[3],
        now: new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`),
      });
      if (expect.authorization !== auth) return send(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");

      if (req.method === "PUT") {
        if (state.failPut || state.failPutTimes > 0) {
          if (state.failPutTimes > 0) state.failPutTimes--;
          const code = state.putStatus === 403 ? "AccessDenied" : "InternalError";
          return send(state.putStatus, `<Error><Code>${code}</Code><Message>details tid_LOCAL req-123</Message></Error>`);
        }
        if (crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) {
          return send(400, "<Error><Code>XAmzContentSHA256Mismatch</Code></Error>");
        }
        store.set(key, { body, lastModified: new Date(state.now), meta: (req.headers["x-amz-meta-sha256"] as string) || null });
        return send(200);
      }
      if (req.method === "DELETE") {
        store.delete(key);
        return send(204);
      }
      if (req.method === "GET" && query["list-type"] === "2") {
        if (state.failList) return send(500, "<Error><Code>InternalError</Code></Error>");
        const all = [...store.keys()].filter((k) => k.startsWith(query.prefix || "")).sort();
        const start = query["continuation-token"] ? Number(query["continuation-token"].replace("tok/", "")) : 0;
        const page = all.slice(start, start + state.pageSize);
        const more = start + state.pageSize < all.length;
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${more}</IsTruncated>` +
          page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>${store.get(k)!.lastModified.toISOString()}</LastModified><Size>${store.get(k)!.body.length}</Size></Contents>`).join("") +
          (more ? `<NextContinuationToken>tok/${start + state.pageSize}</NextContinuationToken>` : "") + `</ListBucketResult>`;
        return send(200, xml, { "content-type": "application/xml" });
      }
      if (req.method === "GET") {
        const o = store.get(key);
        if (!o) return send(404, "<Error><Code>NoSuchKey</Code></Error>");
        log.push({ method: "GET", key, status: 200 });
        res.writeHead(200, o.meta ? { "x-amz-meta-sha256": o.meta } : {});
        return res.end(o.body);
      }
      return send(405);
    });
  });
  return { server, store, log, state };
}

export async function runOffsiteBackupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) passed++;
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  }
  const ob = require("./offsite-backup") as typeof import("./offsite-backup");
  ob.__resetOffsiteBackupForTesting();

  // ── (1) SigV4 ─────────────────────────────────────────────────
  const E = ob.EMPTY_SHA256;
  const sigOf = (h: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(h.authorization)?.[1];
  const awsDoc = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z") };
  ok(sigOf(ob.signV4({ ...awsDoc, method: "GET", host: "examplebucket.s3.amazonaws.com", canonicalPath: "/test.txt", headers: { Range: "bytes=0-9" }, payloadHash: E })) ===
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41", "SigV4: AWS doc example GET Object");
  ok(sigOf(ob.signV4({ ...awsDoc, method: "GET", host: "examplebucket.s3.amazonaws.com", canonicalPath: "/", query: { "max-keys": "2", prefix: "J" }, payloadHash: E })) ===
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7", "SigV4: AWS doc example GET Bucket (list)");
  const tig = { accessKeyId: "tid_TESTKEY", secretAccessKey: "tsec_TESTSECRET/+abc", region: "auto", now: new Date("2026-10-10T04:00:05Z"), host: "lokal.fly.storage.tigris.dev" };
  const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  ok(sigOf(ob.signV4({ ...tig, method: "PUT", canonicalPath: ob.objectPath("db/rfb/rfb-2026-10-10T04-00-05-123Z.db.gz"), headers: { "content-type": "application/gzip", "x-amz-meta-sha256": sha }, payloadHash: sha })) ===
    "da55b12812bae9d9cd46a67ab1aefa5fa74ec7f61c29bad9f7bb1f58c2003213", "SigV4: Tigris PUT matches botocore");
  ok(sigOf(ob.signV4({ ...tig, method: "GET", canonicalPath: "/", query: { "list-type": "2", prefix: "db/rfb/", "continuation-token": "ab/+c=" }, payloadHash: E })) ===
    "d12bbbc08807c95a9907af72db9a00e7f6435257367116dceb370c09681e673a", "SigV4: Tigris LIST (encoded query, sorted) matches botocore");
  ok(sigOf(ob.signV4({ ...tig, method: "DELETE", canonicalPath: ob.objectPath("db/dental/test$file x.db.gz"), payloadHash: E })) ===
    "c52012d7c7647603f401546919a650a9faa624293abc6d6ffb0f0f5040e2a802", "SigV4: Tigris DELETE (encoded key) matches botocore");
  ok(ob.awsUriEncode("a b/ø~-_.", true) === "a%20b/%C3%B8~-_." && ob.awsUriEncode("a/b", false) === "a%2Fb", "awsUriEncode: RFC 3986, slash only when kept");

  // ── (2) config ────────────────────────────────────────────────
  const goodEnv = { AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev", AWS_REGION: "auto", BUCKET_NAME: "lokal" };
  const cfg = ob.readS3Config(goodEnv as any);
  ok(!!cfg && cfg.bucket === "lokal" && cfg.region === "auto" && cfg.endpoint.hostname === "fly.storage.tigris.dev", "readS3Config: the five fly-storage secrets");
  ok(ob.readS3Config({ ...goodEnv, BUCKET_NAME: "" } as any) === null, "readS3Config: missing bucket -> null");
  ok(ob.readS3Config({ ...goodEnv, AWS_SECRET_ACCESS_KEY: "" } as any) === null, "readS3Config: missing secret -> null");
  ok(ob.readS3Config({ ...goodEnv, BUCKET_NAME: "Bad_Name" } as any) === null, "readS3Config: invalid bucket -> null");
  ok(ob.readS3Config({ ...goodEnv, AWS_REGION: "" } as any)?.region === "auto", "readS3Config: region defaults to auto");
  ok(!!cfg && ob.virtualHost(cfg).hostHeader === "lokal.fly.storage.tigris.dev", "virtual-hosted host header for Tigris");

  // ── (3) list parsing ──────────────────────────────────────────
  const parsed = ob.parseListObjectsXml(
    "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>db/rfb/a&amp;b</Key><LastModified>2026-10-01T04:00:00.000Z</LastModified><Size>12</Size></Contents>" +
    "<NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>",
  );
  ok(parsed.objects.length === 1 && parsed.objects[0].key === "db/rfb/a&b" && parsed.objects[0].size === 12 &&
    parsed.objects[0].lastModified.toISOString() === "2026-10-01T04:00:00.000Z", "parseListObjectsXml: key unescaped, size, date");
  ok(parsed.nextToken === "t&1", "parseListObjectsXml: continuation token when truncated");
  ok(ob.parseListObjectsXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").nextToken === null, "parseListObjectsXml: no token when not truncated");

  // ── (4) retention ─────────────────────────────────────────────
  const day = (d: string) => new Date(`${d}T04:00:00Z`);
  const k = (d: string) => ob.backupObjectKey("rfb", day(d));
  ok(ob.OBJECT_KEY_RE.test(k("2026-10-10")), "backupObjectKey matches OBJECT_KEY_RE");
  ok(ob.isoWeekKey(day("2026-10-10")) === "2026-W41" && ob.isoWeekKey(day("2026-01-01")) === "2026-W01" && ob.isoWeekKey(day("2027-01-01")) === "2026-W53", "isoWeekKey");
  const objs: any[] = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 9, 10) - i * 86_400_000);
    objs.push({ key: ob.backupObjectKey("rfb", d), size: 1, lastModified: d });
  }
  objs.push({ key: "db/rfb/notes.txt", size: 1, lastModified: new Date("2020-01-01T00:00:00Z") });
  const del = ob.selectBackupsToDelete(objs);
  const kept = objs.filter((o) => !del.includes(o.key));
  ok(!del.includes("db/rfb/notes.txt"), "retention never deletes a foreign key");
  ok(kept.length === 7 + 4 + 1, "retention keeps 7 daily + 4 weekly (+ the foreign object)");
  ok(objs.slice(0, 7).every((o) => !del.includes(o.key)), "retention keeps the 7 newest");
  const weeklyKept = kept.filter((o) => o.key !== "db/rfb/notes.txt").slice(7).map((o) => ob.isoWeekKey(o.lastModified));
  ok(new Set(weeklyKept).size === 4, "retention: weekly copies are in 4 distinct ISO weeks");
  ok(ob.selectBackupsToDelete(objs.slice(0, 5)).length === 0, "retention: nothing deleted below the daily cap");
  const sameDay: any[] = [];
  for (let h = 0; h < 6; h++) {
    const d = new Date(Date.UTC(2026, 9, 10, 4 + h));
    sameDay.push({ key: ob.backupObjectKey("rfb", d), size: 1, lastModified: d });
  }
  const delSame = ob.selectBackupsToDelete([...sameDay, ...objs.slice(1)]);
  ok(delSame.length === 5 + (objs.length - 1 - 6 - 4 - 1) && !delSame.includes(sameDay[5].key) &&
    objs.slice(1, 7).every((o) => !delSame.includes(o.key)),
    "retention is per UTC day: 6 runs on one day keep only that day's newest and push out no older day");

  // ── (5) schedule ──────────────────────────────────────────────
  const at = (s: string) => new Date(s);
  ok(ob.shouldRunOffsiteBackup(at("2026-10-10T04:10:00Z"), null), "backup runs in the 04 UTC hour");
  ok(ob.shouldRunOffsiteBackup(at("2026-10-10T05:50:00Z"), null), "backup still catches up at 05:50 UTC");
  ok(!ob.shouldRunOffsiteBackup(at("2026-10-10T03:59:00Z"), null) && !ob.shouldRunOffsiteBackup(at("2026-10-10T06:00:00Z"), null), "backup does not run outside 04–05 UTC");
  ok(!ob.shouldRunOffsiteBackup(at("2026-10-10T04:40:00Z"), at("2026-10-10T04:05:00Z")), "backup not twice in the same window");
  ok(ob.shouldRunOffsiteBackup(at("2026-10-11T04:01:00Z"), at("2026-10-10T04:20:00Z")), "backup runs again the next night");
  ok(ob.shouldRunRestoreTest(at("2026-10-11T04:10:00Z"), null) && !ob.shouldRunRestoreTest(at("2026-10-10T04:10:00Z"), null), "restore test only Sunday 04–05 UTC");
  ok(!ob.shouldRunRestoreTest(at("2026-10-11T04:10:00Z"), at("2026-10-06T04:00:00Z")), "restore test at most weekly");
  ok(ob.isOffsiteBlockedHour(at("2026-10-10T08:00:00Z")) && ob.isOffsiteBlockedHour(at("2026-10-10T03:30:00Z")) &&
    !ob.isOffsiteBlockedHour(at("2026-10-10T04:00:00Z")) && !ob.isOffsiteBlockedHour(at("2026-10-10T12:00:00Z")),
    "03 UTC and 07–09 UTC are blocked for manual runs");

  // ── (6) admin routes: auth, validation, not configured (no DB, no network) ──
  {
    const keys = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "BUCKET_NAME"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      process.env.ADMIN_KEY = "test-admin";
      const router = (require("../routes/admin-db-backup") as typeof import("../routes/admin-db-backup")).default;
      ok((await callRoute(router, "POST", "/offsite-backup?vertical=dental")).status === 403, "admin POST without key -> 403");
      ok((await callRoute(router, "GET", "/offsite-backup")).status === 403, "admin GET without key -> 403");
      ok((await callRoute(router, "POST", "/offsite-backup/restore-test?vertical=dental", { "x-admin-key": "wrong" })).status === 403, "admin restore-test with wrong key -> 403");
      const auth = { "x-admin-key": "test-admin" };
      ok((await callRoute(router, "POST", "/offsite-backup", auth)).status === 400, "admin POST without vertical -> 400");
      ok((await callRoute(router, "POST", "/offsite-backup?vertical=lokal", auth)).status === 400, "admin POST with unknown vertical -> 400");
      const nc = await callRoute(router, "POST", "/offsite-backup?vertical=all", auth);
      ok(nc.status === 503 && /not configured/.test(nc.body?.error || ""), "admin POST without Tigris secrets -> 503, nothing started");
      ok(!ob.isOffsiteRunning(), "no run started by the refused requests");
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }

  // ── (7) end-to-end against a fake S3 ──────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-s2-"));
  const SECRET = "tsec_LOCAL/+secret";
  const fake = startFakeS3("bkt", SECRET, ob);
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
  const port = (fake.server.address() as any).port;
  const env = { AWS_ACCESS_KEY_ID: "tid_LOCAL", AWS_SECRET_ACCESS_KEY: SECRET, AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${port}`, AWS_REGION: "auto", BUCKET_NAME: "bkt" };
  const lcfg = ob.readS3Config(env as any)!;
  const tmpDir = path.join(tmp, "work");
  const deps = { connectHost: "127.0.0.1", tmpDir, retryDelaysMs: [0, 0], now: () => new Date("2026-10-10T04:00:05.123Z") };
  const live = new Database(path.join(tmp, "dental.db"));
  try {
    live.pragma("journal_mode = WAL");
    live.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = live.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 500; i++) ins.run("row-" + i + "-" + "x".repeat(50));
    const target = { vertical: "dental" as const, db: live as any };

    // seed older backups (W36 + W37) and a foreign object
    for (let d = 1; d <= 10; d++) {
      const date = new Date(Date.UTC(2026, 8, d, 4));
      fake.store.set(ob.backupObjectKey("dental", date), { body: Buffer.from("old"), lastModified: date, meta: null });
    }
    fake.store.set("db/dental/notes.txt", { body: Buffer.from("keep"), lastModified: new Date("2020-01-01T00:00:00Z"), meta: null });

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dental-orphan-from-a-dead-run.db"), "x".repeat(1000));
    const r = await ob.backupOneDb(target, lcfg, deps);
    ok(r.ok && r.key === "db/dental/dental-2026-10-10T04-00-05-123Z.db.gz", `backup ok with dated key (${r.error ?? r.key})`);
    ok(r.attempts === 1, "backup uploaded on the first attempt");
    const stored = r.key ? fake.store.get(r.key) : undefined;
    ok(!!stored && stored.meta === r.sha256 && crypto.createHash("sha256").update(stored.body).digest("hex") === r.sha256, "uploaded object sha256 = meta = result");
    let restoredRows = -1;
    if (stored) {
      const p = path.join(tmp, "check.db");
      fs.writeFileSync(p, zlib.gunzipSync(stored.body));
      const c = new Database(p, { readonly: true });
      restoredRows = (c.prepare("SELECT COUNT(*) AS n FROM t").get() as any).n;
      c.close();
    }
    ok(restoredRows === 500, "uploaded object gunzips to a valid DB with all rows");
    ok(fs.readdirSync(tmpDir).length === 0, "temp files (and a dead run's orphan) removed after a successful backup");
    const expectDeleted = [1, 2, 3].map((d) => ob.backupObjectKey("dental", new Date(Date.UTC(2026, 8, d, 4)))).sort();
    ok(JSON.stringify([...(r.deleted ?? [])].sort()) === JSON.stringify(expectDeleted), "retention after upload: deletes only the 3 oldest W36 copies (list paginated)");
    ok(fake.store.has("db/dental/notes.txt"), "foreign object in the bucket untouched");
    ok(fake.log.some((l) => l.method === "GET" && l.status === 200) && fake.log.every((l) => l.status !== 403), "every request passed the fake server's signature check");

    // restore test on the newest object
    const rt = await ob.restoreTestOne("dental", live.name, lcfg, deps);
    ok(rt.ok && rt.integrity === "ok" && rt.key === r.key, `restore test: newest object passes integrity_check in a worker (${rt.error ?? rt.integrity})`);
    ok(fs.readdirSync(tmpDir).length === 0, "temp files removed after the restore test");

    // tampered object -> sha mismatch; garbage DB -> not ok
    const newest = fake.store.get(r.key!)!;
    fake.store.set(r.key!, { ...newest, body: zlib.gzipSync(Buffer.from("not a database at all".repeat(100))) });
    const bad = await ob.restoreTestOne("dental", live.name, lcfg, deps);
    ok(!bad.ok && /sha256 mismatch/.test(bad.error || ""), "restore test: sha256 mismatch detected");
    fake.store.set(r.key!, { body: zlib.gzipSync(Buffer.from("not a database at all".repeat(100))), lastModified: newest.lastModified, meta: null });
    const bad2 = await ob.restoreTestOne("dental", live.name, lcfg, deps);
    ok(!bad2.ok && !!bad2.error, "restore test: a non-DB object fails");
    ok(fs.readdirSync(tmpDir).length === 0, "temp files removed after failed restore tests");

    // transient 5xx: retried, then succeeds
    const putsOf = () => fake.log.filter((l) => l.method === "PUT").length;
    fake.state.failPutTimes = 1;
    let p0 = putsOf();
    const retried = await ob.backupOneDb(target, lcfg, { ...deps, now: () => new Date("2026-10-10T05:00:05.000Z") });
    ok(retried.ok && retried.attempts === 2 && putsOf() - p0 === 2, "a transient 500 is retried and the upload succeeds");

    // persistent 5xx: 3 attempts, then failure; no retention, temp files gone, no raw S3 body
    fake.state.failPut = true;
    const before = fake.store.size;
    p0 = putsOf();
    const f = await ob.backupOneDb(target, lcfg, { ...deps, now: () => new Date("2026-10-11T04:00:05.000Z") });
    ok(!f.ok && f.error === "S3 PUT db/dental/dental-2026-10-11T04-00-05-000Z.db.gz -> HTTP 500 InternalError", `backup reports an upload failure with status + code only (${f.error})`);
    ok(putsOf() - p0 === 3, "persistent 500: exactly 3 attempts");
    ok(!/tid_LOCAL|req-123|details/.test(f.error || ""), "S3 error body text is not echoed");
    ok(fake.store.size === before, "no object deleted when the upload fails");
    ok(fs.readdirSync(tmpDir).length === 0, "temp files removed after a failed upload");

    // 4xx: not retried
    fake.state.putStatus = 403;
    p0 = putsOf();
    const f403 = await ob.backupOneDb(target, lcfg, deps);
    ok(!f403.ok && /HTTP 403 AccessDenied$/.test(f403.error || "") && putsOf() - p0 === 1, "a 403 is not retried");
    fake.state.failPut = false;
    fake.state.putStatus = 500;

    // the copy itself fails (source file missing): nothing uploaded, temp dir clean
    p0 = putsOf();
    const gone = await ob.backupOneDb({ vertical: "dental", db: { name: path.join(tmp, "missing.db") } }, lcfg, deps);
    ok(!gone.ok && !!gone.error && putsOf() === p0 && fs.readdirSync(tmpDir).length === 0, "copy failure: no upload, temp dir clean");

    // listing fails after a good upload: backup ok, retention skipped
    fake.state.failList = true;
    const sizeBefore = fake.store.size;
    const lf = await ob.backupOneDb(target, lcfg, { ...deps, now: () => new Date("2026-10-11T04:30:05.000Z") });
    ok(lf.ok && /HTTP 500/.test(lf.retentionError || "") && (lf.deleted ?? []).length === 0 && fake.store.size === sizeBefore + 1,
      "listing failure after upload: backup ok, nothing deleted, retentionError reported");
    fake.state.failList = false;

    // low disk: nothing written, nothing sent
    const puts = fake.log.filter((l) => l.method === "PUT").length;
    const low = await ob.backupOneDb(target, lcfg, { ...deps, freeBytes: () => 1 });
    ok(!low.ok && low.skipped === "low_disk" && fake.log.filter((l) => l.method === "PUT").length === puts, "low disk: skipped before any copy or upload");

    // run wrapper + status
    ob.__resetOffsiteBackupForTesting();
    const stateDb = new Database(":memory:");
    const nc = await ob.runOffsiteBackupNow({ env: {} as any, stateDb });
    ok(nc.skipped === "not_configured" && nc.results.length === 0, "run: not configured -> no-op");
    const run = await ob.runOffsiteBackupNow({
      env: env as any, stateDb, verticals: ["dental"], getTarget: () => target,
      deps: { ...deps, now: () => new Date("2026-10-12T04:00:05.000Z") },
    });
    ok(!run.skipped && run.results.length === 1 && run.results[0].ok, "run: dental backed up");
    const st = ob.getOffsiteBackupStatus({ env: env as any, stateDb });
    ok(st.configured && st.running === null && st.lastSuccessAt?.dental === "2026-10-12T04:00:05.000Z" && st.lastSuccessAt?.rfb === null,
      "status: configured, last success per DB from boot_job_state");
    ok(!JSON.stringify(st).includes(SECRET) && !JSON.stringify(st).includes("tid_LOCAL"), "status never contains credentials");
    const pub = ob.getOffsiteBackupHealth({ env: env as any, stateDb });
    ok(pub.configured && pub.lastSuccessAt?.dental === "2026-10-12T04:00:05.000Z" && pub.lastBackupOk.dental === true &&
      !/db\/dental\/|gzBytes|error/.test(JSON.stringify(pub)), "/health subset: timestamps and ok flags only, no keys/sizes/errors");
    const rr = await ob.runRestoreTestNow({ env: env as any, stateDb, verticals: ["dental"], getTarget: () => target, deps });
    ok(rr.results[0]?.ok === true && ob.getOffsiteBackupStatus({ env: env as any, stateDb }).lastRestoreOkAt?.dental !== null, "run: restore test recorded");
    stateDb.close();

    // scheduler tick: once per night in 04–05 UTC, restore test on Sunday, catch-up after a missed tick
    ob.__resetOffsiteBackupForTesting();
    const tickDb = new Database(":memory:");
    let tickNow = new Date("2026-10-10T04:10:00.000Z"); // Saturday
    const tick = ob.createOffsiteBackupTick({
      getStateDb: () => tickDb,
      now: () => tickNow,
      run: { env: env as any, verticals: ["dental"], getTarget: () => target, deps: { ...deps, now: () => tickNow } },
    });
    const gets = () => fake.log.filter((l) => l.method === "GET" && l.key.endsWith(".db.gz")).length;
    p0 = putsOf();
    await tick();
    ok(putsOf() - p0 === 1, "tick at 04:10 Saturday: one backup");
    tickNow = new Date("2026-10-10T04:25:00.000Z");
    await tick();
    ok(putsOf() - p0 === 1, "tick at 04:25: no second backup that night");
    tickNow = new Date("2026-10-10T12:00:00.000Z");
    await tick();
    ok(putsOf() - p0 === 1, "tick at noon: nothing");
    const g0 = gets();
    tickNow = new Date("2026-10-11T05:40:00.000Z"); // Sunday, late in the window (e.g. after a restart)
    await tick();
    ok(putsOf() - p0 === 2 && gets() - g0 === 1, "tick at 05:40 Sunday: catches up the backup, then runs the restore test");
    ok(ob.getOffsiteBackupStatus({ env: env as any, stateDb: tickDb }).lastRestoreOkAt?.dental === "2026-10-11T05:40:00.000Z", "tick: restore test stamped");
    ok((await ob.runOffsiteBackupNow({ env: {} as any, stateDb: tickDb })).skipped === "not_configured", "tick/run without secrets stays a no-op");
    tickDb.close();

    // a failed night: one retry later in the window, then no more attempts that night
    ob.__resetOffsiteBackupForTesting();
    const failDb = new Database(":memory:");
    tickNow = new Date("2026-10-13T04:05:00.000Z");
    const tick2 = ob.createOffsiteBackupTick({
      getStateDb: () => failDb,
      now: () => tickNow,
      run: { env: env as any, verticals: ["dental"], getTarget: () => target, deps: { ...deps, now: () => tickNow } },
    });
    fake.state.failPut = true;
    p0 = putsOf();
    await tick2();
    ok(putsOf() - p0 === 3, "failed night: first scheduled attempt (3 PUT tries)");
    tickNow = new Date("2026-10-13T04:20:00.000Z");
    await tick2();
    ok(putsOf() - p0 === 6, "failed night: one retry at the next tick");
    tickNow = new Date("2026-10-13T04:35:00.000Z");
    await tick2();
    ok(putsOf() - p0 === 6, "failed night: no third attempt");
    fake.state.failPut = false;
    tickNow = new Date("2026-10-14T04:05:00.000Z");
    await tick2();
    ok(putsOf() - p0 === 7 && ob.getOffsiteBackupStatus({ env: env as any, stateDb: failDb }).lastSuccessAt?.dental === "2026-10-14T04:05:00.000Z",
      "next night: backed up again");
    failDb.close();
  } finally {
    try { live.close(); } catch { /* ignore */ }
    fake.server.closeAllConnections(); // keep-alive sockets from the client agent
    await new Promise<void>((r) => fake.server.close(() => r()));
    ob.__resetOffsiteBackupForTesting();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

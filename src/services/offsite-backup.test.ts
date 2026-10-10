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

function startFakeS3(bucket: string, secret: string, ob: typeof import("./offsite-backup")) {
  const store = new Map<string, Stored>();
  const log: Array<{ method: string; key: string; status: number }> = [];
  const state = { failPut: false, now: new Date("2026-10-10T04:00:05Z"), pageSize: 2 };
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
        if (state.failPut) return send(500, "<Error><Code>InternalError</Code></Error>");
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

  // ── (5) schedule ──────────────────────────────────────────────
  const at = (s: string) => new Date(s);
  ok(ob.shouldRunOffsiteBackup(at("2026-10-10T04:10:00Z"), null), "backup runs in the 04 UTC hour");
  ok(!ob.shouldRunOffsiteBackup(at("2026-10-10T03:59:00Z"), null) && !ob.shouldRunOffsiteBackup(at("2026-10-10T05:00:00Z"), null), "backup does not run outside 04 UTC");
  ok(!ob.shouldRunOffsiteBackup(at("2026-10-10T04:40:00Z"), at("2026-10-10T04:05:00Z")), "backup not twice in the same window");
  ok(ob.shouldRunOffsiteBackup(at("2026-10-11T04:01:00Z"), at("2026-10-10T04:20:00Z")), "backup runs again the next night");
  ok(ob.shouldRunRestoreTest(at("2026-10-11T04:10:00Z"), null) && !ob.shouldRunRestoreTest(at("2026-10-10T04:10:00Z"), null), "restore test only Sunday 04 UTC");
  ok(!ob.shouldRunRestoreTest(at("2026-10-11T04:10:00Z"), at("2026-10-06T04:00:00Z")), "restore test at most weekly");
  ok(ob.isOffsiteBlockedHour(at("2026-10-10T08:00:00Z")) && !ob.isOffsiteBlockedHour(at("2026-10-10T04:00:00Z")), "07–09 UTC is blocked for manual runs");

  // ── (6) end-to-end against a fake S3 ──────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-s2-"));
  const SECRET = "tsec_LOCAL/+secret";
  const fake = startFakeS3("bkt", SECRET, ob);
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
  const port = (fake.server.address() as any).port;
  const env = { AWS_ACCESS_KEY_ID: "tid_LOCAL", AWS_SECRET_ACCESS_KEY: SECRET, AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${port}`, AWS_REGION: "auto", BUCKET_NAME: "bkt" };
  const lcfg = ob.readS3Config(env as any)!;
  const tmpDir = path.join(tmp, "work");
  const deps = { connectHost: "127.0.0.1", tmpDir, now: () => new Date("2026-10-10T04:00:05.123Z") };
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

    const r = await ob.backupOneDb(target, lcfg, deps);
    ok(r.ok && r.key === "db/dental/dental-2026-10-10T04-00-05-123Z.db.gz", `backup ok with dated key (${r.error ?? r.key})`);
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
    ok(fs.readdirSync(tmpDir).length === 0, "temp files removed after a successful backup");
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

    // upload failure: no retention, temp files gone
    fake.state.failPut = true;
    const before = fake.store.size;
    const f = await ob.backupOneDb(target, lcfg, { ...deps, now: () => new Date("2026-10-11T04:00:05.000Z") });
    ok(!f.ok && /HTTP 500/.test(f.error || ""), "backup reports an upload failure");
    ok(fake.store.size === before, "no object deleted when the upload fails");
    ok(fs.readdirSync(tmpDir).length === 0, "temp files removed after a failed upload");
    fake.state.failPut = false;

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
    const rr = await ob.runRestoreTestNow({ env: env as any, stateDb, verticals: ["dental"], getTarget: () => target, deps });
    ok(rr.results[0]?.ok === true && ob.getOffsiteBackupStatus({ env: env as any, stateDb }).lastRestoreOkAt?.dental !== null, "run: restore test recorded");
    stateDb.close();
  } finally {
    try { live.close(); } catch { /* ignore */ }
    await new Promise<void>((r) => fake.server.close(() => r()));
    ob.__resetOffsiteBackupForTesting();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

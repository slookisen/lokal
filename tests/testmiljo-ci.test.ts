/**
 * testmiljo-ci.test.ts — the test environment kept in step with the app
 * (dev-request 2026-11-25-testmiljo-lokal-kopi-med-testdata-foer-prodsetting,
 * point 7, «Vedlikehold i CI»).
 *
 * One ordinary test inside `npm test`, so it runs on every PR:
 *
 *   1. builds the seed data (scripts/testmiljo/seed.ts, the real CLI) into a
 *      fresh `<tmpdir>/<mkdtemp>/.testmiljo/` (the seed's own path guard
 *      accepts exactly that shape);
 *   2. starts the real app (tsx src/index.ts, as `npm run testmiljo` does)
 *      as a child process on a free port bound to 127.0.0.1, with the env
 *      from testmiljo.env built by launch.ts's own buildAppEnv(), TESTMILJO=1;
 *   3. fetches the main pages of all three sites (by their local host names)
 *      and, logged in as every seeded owner through /testmiljo (the ordinary
 *      login link, followed, cookie kept), every owner page: the RFB owner
 *      portal pages and the four tabs of the gårdssalg owner dashboard;
 *   4. requires 200 on every page and no error line in the app's output.
 *
 * So a change to the schema or the routes that the seed data does not follow
 * (a new NOT NULL column, a renamed column, a page that throws on seeded
 * data) turns this red.
 *
 * The owner dashboards are behind flags that testmiljo.env does not set
 * (OWNER_DASHBOARD_ENABLED, OWNER_ORDERABILITY_PORTAL_ENABLED,
 * OA_OWNER_FEATURES_ENABLED, GARDSSALG_OWNER_DASHBOARD_ENABLED and the
 * OWNER_FEATURES_ALLOWED_SUBJECTS allowlist). This test sets them in the
 * child's env only, with the seeded owners' ids read from the seeded files.
 *
 * Nothing touches this process's DB singletons: the seed and the app are
 * child processes; the seeded files are only read here. The child (its whole
 * process group on POSIX) is killed and the temp dir removed in `finally`.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx tests/testmiljo-ci.test.ts
 *   2. Wired into the gate: tests/test.ts calls runTestmiljoCiTests().
 */

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { ENV_FILE, buildAppEnv, parseEnvFile, tsxCli } from "../scripts/testmiljo/launch";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const REPO_ROOT = path.resolve(__dirname, "..");
const SEED = path.join(REPO_ROOT, "scripts", "testmiljo", "seed.ts");
const APP = path.join(REPO_ROOT, "src", "index.ts");

const RFB_HOST = "rettfrabonden.localhost";
const OA_HOST = "opplevagent.localhost";
const DENTAL_HOST = "finn-tannlege.localhost";

const BOOT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The main pages of each site. Flag-gated pages that are off in testmiljo.env
 * (e.g. /for-produsenter) are not listed: they answer 404 by design there.
 * Profile pages are added from the links these pages show (see PROFILE_LINK).
 *
 * The RFB search uses a product word: a free-text word the search does not
 * know as a product is looked up as a place at Kartverket (ws.geonorge.no),
 * which the testmiljø's outbound guard blocks — and that failure is logged
 * with a stack trace. That is the guard working, not a seed/route mismatch.
 */
const MAIN_PAGES: Record<string, string[]> = {
  [RFB_HOST]: ["/", "/sok?q=poteter", "/kategori", "/om", "/teknologi", "/selger", "/personvern", "/testmiljo", "/testmiljo/epost"],
  [OA_HOST]: [
    "/",
    "/opplevelser",
    "/sok",
    "/sok?q=sider",
    "/kategori/gardssalg",
    "/for-tilbydere",
    "/slik-fungerer-det",
    "/personvern",
    "/testmiljo",
  ],
  [DENTAL_HOST]: ["/", "/sok", "/sok?q=Oslo", "/om", "/hvordan-det-fungerer", "/personvern", "/fylke/oslo"],
};

/** Links to a producer / provider / clinic profile in a site's pages. Each one found is fetched too. */
const PROFILE_LINK: Record<string, RegExp> = {
  [RFB_HOST]: /href="(\/produsent\/[a-z0-9-]+)"/g,
  [OA_HOST]: /href="(\/kategori\/gardssalg\/produsent\/[a-z0-9-]+)"/g,
  [DENTAL_HOST]: /href="(\/klinikk\/(?:id\/)?[a-z0-9-]+)"/g,
};

const RFB_OWNER_TAILS = ["", "/portal", "/ordrer", "/varer", "/statistikk", "/valg"];
const GARDSSALG_TABS = ["/portal", "/besok", "/valg", "/statistikk"];

/**
 * An error line in the app's output: anything the app writes to stderr
 * (console.error / console.warn), and any stdout line that names an error, an
 * exception, a stack frame or an SQLite failure. Each benign line that would
 * match is listed below with its reason. Keep this list short.
 */
const STDOUT_ERROR_RE = /\berror\b|\w+Error\b|\bexception\b|\bunhandled\b|\buncaught\b|\bfatal\b|^\s+at\s+\S|SQLITE_[A-Z]+|no such (?:table|column)/i;
const BENIGN_LINES: RegExp[] = [
  // Node's own notice about an experimental runtime feature (depends on the
  // Node version running the suite, not on the app), and its follow-up hint.
  /^\(node:\d+\) ExperimentalWarning:/,
  /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/,
];

export function isErrorLine(line: string, stream: "stdout" | "stderr"): boolean {
  if (line.trim() === "") return false;
  if (BENIGN_LINES.some((re) => re.test(line))) return false;
  return stream === "stderr" || STDOUT_ERROR_RE.test(line);
}

/**
 * The inherited variables the children get: what a process needs to run on
 * Linux, macOS and Windows, nothing else. The suite's own process.env carries
 * test-only switches (NODE_ENV=test, flags other blocks set and restore), and
 * a CI shell may carry anything; the app must boot as `npm run testmiljo`
 * boots it. buildAppEnv() then drops credential-looking names as it always does.
 */
const BASE_ENV_KEYS = ["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL"];

function baseEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of BASE_ENV_KEYS) if (parent[k] !== undefined) env[k] = parent[k];
  return env;
}

/** spawn() failures that mean «this platform cannot start a child process», not «the app is broken». */
function cannotSpawn(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EAGAIN" || code === "ENOSYS" || code === "ENOMEM";
}

interface RunResult { code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }

function runSeed(dir: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [tsxCli(), SEED, "--dir", dir], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderr: String(err), spawnError: err as NodeJS.ErrnoException });
    }
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err), spawnError: err as NodeJS.ErrnoException }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One HTTP request to 127.0.0.1:port with the given Host (fetch() cannot set Host). No redirects followed. */
function request(port: number, host: string, p: string, opts: { method?: string; cookie?: string; form?: Record<string, string> } = {}): Promise<Res> {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  const headers: http.OutgoingHttpHeaders = { Host: `${host}:${port}`, Accept: "text/html", "User-Agent": "testmiljo-ci" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Content-Length"] = Buffer.byteLength(body);
    // The app's same-origin write guard: a browser posting from the page sends its own origin.
    headers.Origin = `http://${host}:${port}`;
    headers["Sec-Fetch-Site"] = "same-origin";
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: opts.method ?? (body !== undefined ? "POST" : "GET"), headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** name=value pairs, per cookie name, from Set-Cookie headers. */
class CookieJar {
  private readonly jar = new Map<string, string>();
  take(res: Res): void {
    for (const raw of res.headers["set-cookie"] ?? []) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  has(name: string): boolean {
    return !!this.jar.get(name);
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Same-host path of a Location header (the testmiljø rewrites production URLs to the local names). */
function samePath(location: string, host: string, port: number): string | null {
  const u = new URL(location, `http://${host}:${port}`);
  return u.hostname === host && u.port === String(port) ? u.pathname + u.search : null;
}

interface SeededOwners {
  rfb: Array<{ id: string }>;
  gardssalg: Array<{ id: string; slug: string }>;
}

/** The seeded owners, by the same rule /testmiljo lists them (verified claim; used, unrevoked gårdssalg claim). */
function readOwners(dir: string): SeededOwners {
  const rfbDb = new Database(path.join(dir, "lokal.db"), { readonly: true, fileMustExist: true });
  const oaDb = new Database(path.join(dir, "experiences.db"), { readonly: true, fileMustExist: true });
  try {
    const rfb = rfbDb
      .prepare(`SELECT a.id AS id FROM agents a WHERE EXISTS (SELECT 1 FROM agent_claims c WHERE c.agent_id = a.id AND c.status = 'verified') ORDER BY a.id`)
      .all() as Array<{ id: string }>;
    const gardssalg = oaDb
      .prepare(
        `SELECT p.id AS id, p.slug AS slug FROM experience_providers p
          WHERE EXISTS (SELECT 1 FROM gardssalg_claims c WHERE c.provider_id = p.id AND c.used = 1 AND c.revoked_at IS NULL AND COALESCE(c.draft_mode, 0) = 0)
          ORDER BY p.id`,
      )
      .all() as Array<{ id: string; slug: string }>;
    return { rfb, gardssalg };
  } finally {
    rfbDb.close();
    oaDb.close();
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = (sig: NodeJS.Signals) => {
      try {
        // POSIX: the whole group — tsx runs the app in a grandchild process.
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    const hard = setTimeout(() => kill("SIGKILL"), 5_000);
    const done = setTimeout(resolve, 10_000);
    child.once("exit", () => {
      clearTimeout(hard);
      clearTimeout(done);
      resolve();
    });
    kill("SIGTERM");
  });
}

const tail = (s: string, n = 1500) => (s.length > n ? "…" + s.slice(-n) : s);

export async function runTestmiljoCiTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, label: string, detail = "") => {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(label + (detail ? ` — ${detail}` : ""));
      if (log) console.log(`  FAIL ${label} ${detail}`);
    }
  };

  const started = Date.now();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testmiljo-ci-"));
  const dir = path.join(tmpRoot, ".testmiljo");
  fs.mkdirSync(dir);
  let child: ChildProcess | null = null;
  const output: Array<{ stream: "stdout" | "stderr"; line: string }> = [];

  try {
    // ── 1. Seed ─────────────────────────────────────────────────────────
    const env0 = { ...baseEnv(process.env), NODE_ENV: "development" };
    const seed = await runSeed(dir, env0);
    if (seed.spawnError && cannotSpawn(seed.spawnError)) {
      // The one allowed skip: this platform cannot start a child process at all.
      console.log(`  testmiljo-ci: SKIPPED — cannot spawn a child process here (${seed.spawnError.code}: ${seed.spawnError.message})`);
      return { passed, failed, failures };
    }
    check(seed.code === 0, "tmci-1: the seed builds all three databases", `exit ${seed.code}\n${tail(seed.stderr || seed.stdout)}`);
    if (seed.code !== 0) return { passed, failed, failures };

    const owners = readOwners(dir);
    check(owners.rfb.length > 0 && owners.gardssalg.length > 0, "tmci-2: the seed has RFB and gårdssalg owners", `rfb ${owners.rfb.length}, gårdssalg ${owners.gardssalg.length}`);

    // ── 2. Start the app ────────────────────────────────────────────────
    const port = await freePort();
    const fileEnv = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
    Object.assign(fileEnv, {
      PORT: String(port),
      HOST: "127.0.0.1",
      BASE_URL: `http://${RFB_HOST}:${port}`,
      DB_PATH: path.join(dir, "lokal.db"),
      DENTAL_DB_PATH: path.join(dir, "dental.db"),
      EXPERIENCES_DB_PATH: path.join(dir, "experiences.db"),
      TESTMILJO: "1",
      // The owner dashboards (off in testmiljo.env), for the seeded owners only.
      OWNER_DASHBOARD_ENABLED: "1",
      OWNER_ORDERABILITY_PORTAL_ENABLED: "1",
      OA_OWNER_FEATURES_ENABLED: "1",
      GARDSSALG_OWNER_DASHBOARD_ENABLED: "pilot",
      OWNER_FEATURES_ALLOWED_SUBJECTS: [...owners.rfb.map((o) => `rfb:${o.id}`), ...owners.gardssalg.map((o) => `gardssalg:${o.id}`)].join(","),
    });
    const appEnv = buildAppEnv(baseEnv(process.env), fileEnv);

    let spawnErr: NodeJS.ErrnoException | null = null;
    let exited: string | null = null;
    try {
      child = spawn(process.execPath, [tsxCli(), APP], {
        cwd: REPO_ROOT,
        env: appEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      spawnErr = err as NodeJS.ErrnoException;
    }
    if (spawnErr || !child) {
      if (cannotSpawn(spawnErr)) {
        console.log(`  testmiljo-ci: SKIPPED — cannot spawn the app here (${spawnErr?.code}: ${spawnErr?.message})`);
        return { passed, failed, failures };
      }
      throw spawnErr ?? new Error("spawn returned nothing");
    }
    for (const stream of ["stdout", "stderr"] as const) {
      let buf = "";
      child[stream]!.setEncoding("utf8");
      child[stream]!.on("data", (d: string) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) output.push({ stream, line });
      });
      child[stream]!.on("end", () => {
        if (buf) output.push({ stream, line: buf });
      });
    }
    child.on("error", (err) => (exited = `spawn error: ${String(err)}`));
    child.on("exit", (code, sig) => (exited = `exit ${code ?? ""}${sig ? ` signal ${sig}` : ""}`));

    const allOutput = () => output.map((o) => `[${o.stream}] ${o.line}`).join("\n");
    let healthy = false;
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (!healthy && !exited && Date.now() < deadline) {
      try {
        const h = await request(port, "127.0.0.1", "/health");
        healthy = h.status === 200;
      } catch {
        /* not listening yet */
      }
      if (!healthy) await new Promise((r) => setTimeout(r, 250));
    }
    check(healthy, "tmci-3: the app starts on the seeded databases and /health answers 200", `${exited ?? "timeout"}\n${tail(allOutput())}`);
    if (!healthy) return { passed, failed, failures };
    const bootMs = Date.now() - started;

    const covered: string[] = [];
    const expect200 = async (host: string, p: string, cookie?: string, mustContain?: string[]): Promise<string | null> => {
      let res: Res;
      try {
        res = await request(port, host, p, { cookie });
      } catch (err) {
        check(false, `tmci-page: ${host}${p} answers`, String(err));
        return null;
      }
      covered.push(`${host}${p}${cookie ? " (innlogget)" : ""}`);
      const missing = (mustContain ?? []).filter((s) => !res.body.includes(s));
      check(
        res.status === 200 && missing.length === 0,
        `tmci-page: ${host}${p}${cookie ? " as owner" : ""} → 200`,
        res.status !== 200 ? `got ${res.status}${res.headers.location ? ` → ${res.headers.location}` : ""} ${tail(res.body, 300)}` : `missing ${missing.join(", ")}`,
      );
      return res.status === 200 ? res.body : null;
    };

    // ── 3a. Main pages, and the profiles they link to ───────────────────
    for (const [host, pages] of Object.entries(MAIN_PAGES)) {
      const profiles = new Set<string>();
      for (const p of pages) {
        const body = await expect200(host, p);
        for (const m of (body ?? "").matchAll(PROFILE_LINK[host])) profiles.add(m[1]);
      }
      check(profiles.size > 0, `tmci-4: ${host} links to at least one seeded profile`);
      for (const p of [...profiles].sort()) await expect200(host, p);
    }

    // ── 3b. Owner pages, logged in through /testmiljo ───────────────────
    const login = async (host: string, site: "rfb" | "opplevagent", id: string, cookieName: string): Promise<string | null> => {
      const label = `tmci-login: ${site} owner ${id}`;
      const start = await request(port, host, "/testmiljo");
      if (!(start.status === 200 && start.body.includes(`value="${id}"`))) {
        check(false, `${label} is listed on /testmiljo`, `status ${start.status}`);
        return null;
      }
      const jar = new CookieJar();
      let res = await request(port, host, "/testmiljo/logg-inn", { form: { site, id } });
      let hops = 0;
      while (res.status >= 300 && res.status < 400 && res.headers.location && hops < 5) {
        jar.take(res);
        const next = samePath(res.headers.location, host, port);
        if (!next) break;
        res = await request(port, host, next, { cookie: jar.header() });
        hops++;
      }
      jar.take(res);
      const ok = res.status === 200 && jar.has(cookieName) && hops >= 2;
      check(ok, `${label} logs in (verify link followed, ${cookieName} set, lands on 200)`, `status ${res.status} after ${hops} redirects, cookie ${jar.has(cookieName)}`);
      return ok ? jar.header() : null;
    };

    for (const owner of owners.rfb) {
      const cookie = await login(RFB_HOST, "rfb", owner.id, "rfb_owner_session");
      if (!cookie) continue;
      const base = `/eier/${encodeURIComponent(owner.id)}`;
      for (const t of RFB_OWNER_TAILS) {
        // The owner shell's menu (OWNER_DASHBOARD_ENABLED on) links to every page.
        await expect200(RFB_HOST, base + t, cookie, t === "" ? [] : [`${base}/ordrer`, `${base}/statistikk`, `${base}/valg`]);
      }
    }
    for (const owner of owners.gardssalg) {
      const cookie = await login(OA_HOST, "opplevagent", owner.id, "oa_owner_session");
      if (!cookie) continue;
      const base = `/kategori/gardssalg/eier/${encodeURIComponent(owner.slug)}`;
      for (const t of GARDSSALG_TABS) {
        // The dashboard shell (GARDSSALG_OWNER_DASHBOARD_ENABLED) links to all four tabs.
        await expect200(OA_HOST, base + t, cookie, GARDSSALG_TABS.map((x) => `href="${base}${x}"`));
      }
    }

    // ── 4. No error lines ───────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 300)); // let the last log lines arrive
    const errors = output.filter((o) => isErrorLine(o.line, o.stream));
    check(errors.length === 0, "tmci-5: the app wrote no error lines while serving the pages", errors.slice(0, 20).map((o) => `[${o.stream}] ${o.line}`).join("\n"));
    check(!exited, "tmci-6: the app is still running after the last page", exited ?? "");

    if (log) {
      console.log(`  testmiljo-ci: ${covered.length} pages, boot ${bootMs} ms, total ${Date.now() - started} ms`);
      for (const c of covered) console.log(`    ${c}`);
    }
  } catch (err) {
    failed++;
    failures.push("unexpected error: " + String((err as Error)?.stack || err));
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runTestmiljoCiTests({ log: true }).then((r) => {
    console.log(`testmiljo-ci: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log("  FAIL " + f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

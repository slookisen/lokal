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
 * OA_OWNER_FEATURES_ENABLED, GARDSSALG_OWNER_DASHBOARD_ENABLED,
 * GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED and the
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

import { spawn, spawnSync, type ChildProcess } from "child_process";
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
export function cannotSpawn(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EAGAIN" || code === "ENOSYS" || code === "ENOMEM";
}

/**
 * What a failed spawn means for this test:
 *   "skip"  — this machine cannot start child processes at all (local run only);
 *   "fail"  — the same, but in CI (CI is set, as GitHub Actions does): a skip
 *             there would turn the AK6 guard off silently, so it is a failure;
 *   "error" — any other spawn failure: a failure, like any other.
 */
export function spawnFailureVerdict(err: unknown, env: NodeJS.ProcessEnv = process.env): "skip" | "fail" | "error" {
  if (!cannotSpawn(err)) return "error";
  return (env.CI ?? "").trim() !== "" ? "fail" : "skip";
}

/** A stderr line that is Node's own warning (its wording depends on the Node version, not only on the app). */
const NODE_WARNING_RE = /^\(node:\d+\) (?:\[[A-Z0-9]+\] )?\w*Warning:/;

const SEED_TIMEOUT_MS = 120_000;

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
    // N6 (review of #1673): a hung seed must not hang all of `npm test` silently.
    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      resolve({ code: -1, stdout, stderr: stderr + `\nseed.ts timed out after ${SEED_TIMEOUT_MS / 1000} s and was killed` });
    }, SEED_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err), spawnError: err as NodeJS.ErrnoException }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
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

/** Kill the child and everything it started, now (synchronous: usable from an exit handler). */
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // No process groups on Windows: taskkill /T takes the tsx grandchild too.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // POSIX: the whole group — tsx runs the app in a grandchild process.
      process.kill(-child.pid, sig);
    }
  } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

/**
 * While the test owns a temp dir and (later) a detached app, an interrupted
 * run (Ctrl-C, SIGTERM, process.exit elsewhere) must not leave either
 * behind: the app is in its own process group, so it does not get the
 * terminal's SIGINT, and `finally` does not run when this process dies of a
 * signal. These handlers kill the group and remove the dir synchronously.
 * Returns the function that removes them again (called in `finally`).
 */
function installEmergencyCleanup(tmpRoot: string, getChild: () => ChildProcess | null): () => void {
  const cleanup = () => {
    const child = getChild();
    if (child && child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const onSignal = (sig: NodeJS.Signals) => {
    cleanup();
    remove();
    // Re-raise: with our handler gone the default action ends the process
    // (unless someone else listens; then exit with the conventional code).
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    else process.exit(sig === "SIGINT" ? 130 : 143);
  };
  const onExit = () => cleanup();
  process.once("exit", onExit);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const remove = () => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  return remove;
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = (sig: NodeJS.Signals) => killTree(child, sig);
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
  const removeEmergencyCleanup = installEmergencyCleanup(tmpRoot, () => child);

  /** A spawn that failed: skip (locally, platform cannot spawn), else a failure. Returns true when the run must stop. */
  const spawnFailed = (what: string, err: NodeJS.ErrnoException): boolean => {
    const verdict = spawnFailureVerdict(err);
    if (verdict === "skip") {
      // The one allowed skip: this machine cannot start a child process at all, and this is not CI.
      console.log(`  testmiljo-ci: SKIPPED — cannot spawn ${what} here (${err.code}: ${err.message})`);
    } else {
      check(false, verdict === "fail" ? `tmci-0: cannot spawn ${what} in CI (a skip would switch this guard off)` : `tmci-0: spawning ${what} failed`, `${err.code}: ${err.message}`);
    }
    return true;
  };

  try {
    // ── 0. The skip rule itself (pure) ──────────────────────────────────
    const eagain = Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    check(
      spawnFailureVerdict(eagain, {}) === "skip" &&
        spawnFailureVerdict(eagain, { CI: "true" }) === "fail" &&
        spawnFailureVerdict(Object.assign(new Error("x"), { code: "EPERM" }), { CI: "1" }) === "fail" &&
        spawnFailureVerdict(Object.assign(new Error("x"), { code: "ENOENT" }), {}) === "error" &&
        spawnFailureVerdict(eagain, { CI: "" }) === "skip",
      "tmci-0: cannot-spawn is a skip only outside CI; in CI (CI set) it is a failure",
    );
    check(
      NODE_WARNING_RE.test("(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.") &&
        NODE_WARNING_RE.test("(node:9) Warning: something") &&
        !NODE_WARNING_RE.test("[owner-portal] GET /eier failed: TypeError: x"),
      "tmci-0: Node's own warnings on stderr are recognised (for the failure hint)",
    );

    // ── 1. Seed ─────────────────────────────────────────────────────────
    const env0 = { ...baseEnv(process.env), NODE_ENV: "development" };
    const seed = await runSeed(dir, env0);
    if (seed.spawnError && cannotSpawn(seed.spawnError)) {
      spawnFailed("the seed", seed.spawnError);
      return { passed, failed, failures };
    }
    check(seed.code === 0, "tmci-1: the seed builds all three databases", `exit ${seed.code}\n${tail(seed.stderr || seed.stdout)}`);
    if (seed.code !== 0) return { passed, failed, failures };

    const owners = readOwners(dir);
    check(owners.rfb.length > 0 && owners.gardssalg.length > 0, "tmci-2: the seed has RFB and gårdssalg owners", `rfb ${owners.rfb.length}, gårdssalg ${owners.gardssalg.length}`);

    // ── 2. Start the app ────────────────────────────────────────────────
    // One boot attempt. A failed boot is red, and `finally` stops the child.
    // (No retry on a fresh port: src/index.ts does not surface a listen
    // error, so an EADDRINUSE is not visible here to retry on.)
    const port = await freePort();
    let healthy = false;
    let exited: string | null = null;
    const allOutput = () => output.map((o) => `[${o.stream}] ${o.line}`).join("\n");
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
      // dev-request 2026-11-26-opplevagent-eier-endrer-adresse-selv: the owner's address form on the portal.
      GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED: "pilot",
      OWNER_FEATURES_ALLOWED_SUBJECTS: [...owners.rfb.map((o) => `rfb:${o.id}`), ...owners.gardssalg.map((o) => `gardssalg:${o.id}`)].join(","),
    });
    const appEnv = buildAppEnv(baseEnv(process.env), fileEnv);

    let spawnErr: NodeJS.ErrnoException | null = null;
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
      spawnFailed("the app", spawnErr ?? Object.assign(new Error("spawn returned nothing"), { code: "UNKNOWN" }));
      return { passed, failed, failures };
    }
    const proc: ChildProcess = child;
    const sink = output;
    for (const stream of ["stdout", "stderr"] as const) {
      let buf = "";
      proc[stream]!.setEncoding("utf8");
      proc[stream]!.on("data", (d: string) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) sink.push({ stream, line });
      });
      proc[stream]!.on("end", () => {
        if (buf) sink.push({ stream, line: buf });
      });
    }
    proc.on("error", (err) => (exited = `spawn error: ${String(err)}`));
    proc.on("exit", (code, sig) => (exited = `exit ${code ?? ""}${sig ? ` signal ${sig}` : ""}`));

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
        // The portal («Oversikt») carries the owner's address form (GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED).
        const extra = t === "/portal" ? ['id="gc-address-form"', `action="${base}/adresse"`] : [];
        await expect200(OA_HOST, base + t, cookie, [...GARDSSALG_TABS.map((x) => `href="${base}${x}"`), ...extra]);
      }
    }

    // ── 4. No error lines ───────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 300)); // let the last log lines arrive
    const errors = output.filter((o) => isErrorLine(o.line, o.stream));
    const nodeWarnings = errors.filter((o) => o.stream === "stderr" && NODE_WARNING_RE.test(o.line));
    const hint = nodeWarnings.length
      ? `\nHINT: ${nodeWarnings.length} of these are Node's own warnings (e.g. a DeprecationWarning). They can come from the Node version running the suite, not from an app change; check the Node version before hunting for an app bug.\n`
      : "";
    check(errors.length === 0, "tmci-5: the app wrote no error lines while serving the pages", hint + errors.slice(0, 20).map((o) => `[${o.stream}] ${o.line}`).join("\n"));
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
    removeEmergencyCleanup();
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

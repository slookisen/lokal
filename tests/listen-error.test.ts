/**
 * listen-error.test.ts — dev-request 2026-11-26-app-listen-feil-ignoreres.
 *
 * 1. Unit: handleListenError() logs one line and exits 1 on an error, nothing on success.
 * 2. Real app: started on a port a net.Server already holds. It must exit
 *    non-zero within a time limit, stderr carries the "[startup] listen failed"
 *    line and stdout never says "running at". Hard timeout; the app's whole process group is killed on timeout and in finally.
 *
 * Standalone: npx tsx tests/listen-error.test.ts. Gate: tests/test.ts.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { handleListenError } from "../src/listen-error";
import { tsxCli } from "../scripts/testmiljo/launch";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const REPO_ROOT = path.resolve(__dirname, "..");
const APP = path.join(REPO_ROOT, "src", "index.ts");
const HARD_TIMEOUT_MS = 90_000;

/** Kill the child and everything it started (tsx runs the app in a grandchild). Same pattern as testmiljo-ci's killTree. */
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, sig); // the whole process group (child is spawned detached)
    }
  } catch {
    try { child.kill(sig); } catch { /* already gone (ESRCH) */ }
  }
}

export async function runListenErrorTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const check = (ok: boolean, name: string, detail = "") => {
    if (ok) passed++; else { failed++; failures.push(name + (detail ? " — " + detail : "")); }
    if (opts.log) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  };

  // ── 1. unit ──
  {
    const lines: string[] = []; const codes: number[] = [];
    const r = handleListenError(Object.assign(new Error("address in use"), { code: "EADDRINUSE" }), "0.0.0.0", 3000, (c) => codes.push(c), (l) => lines.push(l));
    check(r === true && codes.length === 1 && codes[0] === 1, "listen-1: error -> exit(1) once");
    check(lines.length === 1 && lines[0].includes("[startup] listen failed on 0.0.0.0:3000: EADDRINUSE"), "listen-2: one clear error line", lines.join("|"));
    const l2: string[] = []; const c2: number[] = [];
    const r2 = handleListenError(undefined, "h", 1, (c) => c2.push(c), (l) => l2.push(l));
    check(r2 === false && c2.length === 0 && l2.length === 0, "listen-3: no error -> nothing happens");
    const l3: string[] = []; const c3: number[] = [];
    const r3 = handleListenError("boom" as unknown as Error, "h", 1, (c) => c3.push(c), (l) => l3.push(l));
    check(r3 === true && c3.length === 1 && c3[0] === 1 && l3.length === 1 && l3[0].includes("boom"), "listen-3b: non-Error value is logged and exits 1", l3.join("|"));
  }

  // ── 2. real app on a busy port ──
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "listen-err-"));
  const blocker = net.createServer();
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((res, rej) => { blocker.once("error", rej); blocker.listen(0, "127.0.0.1", () => res()); });
    const port = (blocker.address() as net.AddressInfo).port;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "LANG"]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    Object.assign(env, {
      NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", BASE_URL: `http://127.0.0.1:${port}`,
      DB_PATH: path.join(tmpRoot, "lokal.db"), DENTAL_DB_PATH: path.join(tmpRoot, "dental.db"), EXPERIENCES_DB_PATH: path.join(tmpRoot, "experiences.db"),
      DISPATCH_TICK_DISABLED: "1", RFB_DISABLE_URL_BACKFILL: "1", SKIP_TURNSTILE: "true",
    });
    let stdout = "", stderr = "";
    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      child = spawn(process.execPath, [tsxCli(), APP], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
      child.on("error", (e) => { stderr += String(e); resolve({ code: -1, timedOut: false }); });
      child.on("close", (code) => resolve({ code, timedOut: false }));
      timer = setTimeout(() => {
        if (child) {
          killTree(child, "SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        resolve({ code: null, timedOut: true }); // do not wait for 'close': pipes may stay open
      }, HARD_TIMEOUT_MS);
    });
    check(!result.timedOut, "listen-4: app exits on its own when the port is busy (no living process)");
    check(result.code !== null && result.code !== 0, "listen-5: exit code is non-zero", String(result.code));
    check(/\[startup\] listen failed on 127\.0\.0\.1:\d+: EADDRINUSE/.test(stderr), "listen-6: stderr has the listen-failed line", stderr.slice(-500));
    check(!stdout.includes("running at"), "listen-7: no 'running at' banner on stdout");
  } catch (err) {
    failed++; failures.push("unexpected error: " + String((err as Error)?.stack || err));
  } finally {
    if (timer) clearTimeout(timer);
    if (child) { killTree(child, "SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); } // whole group, even if the tsx parent already exited
    await new Promise<void>((r) => blocker.close(() => r()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runListenErrorTests({ log: true }).then((r) => {
    console.log(`listen-error: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log("  FAIL " + f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

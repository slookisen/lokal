/**
 * Testmiljø launcher (cross-platform: plain node/tsx, no shell syntax).
 *
 *   npm run testmiljo             seeds .testmiljo/ if a database is missing,
 *                                 then starts the app (tsx src/index.ts) with
 *                                 the settings in testmiljo.env (port 3100).
 *   npm run testmiljo:nullstill   deletes the .testmiljo/ databases and the
 *                                 captured e-mail, and seeds the databases
 *                                 again (does not start the app).
 *
 * Refuses to run when NODE_ENV=production or FLY_APP_NAME / FLY_MACHINE_ID is
 * set, and when a database path in testmiljo.env is outside .testmiljo/.
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { REPO_ROOT, assertInsideTestmiljo, refuseReason } from "./seed";

export const ENV_FILE = path.join(REPO_ROOT, "testmiljo.env");

/** KEY=VALUE lines; blank lines and # comments ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`testmiljo.env: ugyldig linje «${line}»`);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Inherited variable names that look like credentials — never passed to the app. */
const CREDENTIAL_PARTS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASS", "PASSWORD", "PAT", "CREDENTIAL", "CREDENTIALS"]);
export function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith("SMTP_") || upper.startsWith("FLY_") || upper === "DATABASE_URL") return true;
  return upper.split(/[^A-Z0-9]+/).some((part) => CREDENTIAL_PARTS.has(part));
}

export function buildAppEnv(parent: NodeJS.ProcessEnv, fileEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (!isCredentialName(k)) env[k] = v;
  }
  // DB paths and anything else set by the shell are overridden by the file.
  delete env.DB_PATH;
  delete env.DENTAL_DB_PATH;
  delete env.EXPERIENCES_DB_PATH;
  for (const [k, v] of Object.entries(fileEnv)) env[k] = v;
  for (const k of ["DB_PATH", "DENTAL_DB_PATH", "EXPERIENCES_DB_PATH"]) {
    if (!env[k]) throw new Error(`testmiljo.env mangler ${k}`);
    env[k] = assertInsideTestmiljo(path.resolve(REPO_ROOT, env[k]!));
  }
  return env;
}

/** Path of the tsx CLI script (run with process.execPath, so no shell or .cmd shim is needed). */
export function tsxCli(): string {
  const pkgPath = require.resolve("tsx/package.json", { paths: [REPO_ROOT] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.tsx;
  return path.join(path.dirname(pkgPath), bin);
}

/**
 * The e-mail outbox (src/testmiljo/outbox.ts) is a file beside the main
 * database. A reset that left it behind would show e-mail about data that no
 * longer exists.
 */
export function outboxFileBeside(dbPath: string): string {
  return path.join(path.dirname(dbPath), "outbox.jsonl");
}

export function removeOutbox(dbPath: string): void {
  fs.rmSync(assertInsideTestmiljo(outboxFileBeside(dbPath)), { force: true });
}

function dbFiles(env: NodeJS.ProcessEnv): string[] {
  return [env.DB_PATH!, env.DENTAL_DB_PATH!, env.EXPERIENCES_DB_PATH!];
}

function runSeed(env: NodeJS.ProcessEnv): void {
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [tsxCli(), path.join(__dirname, "seed.ts"), "--rfb", env.DB_PATH!, "--dental", env.DENTAL_DB_PATH!, "--experiences", env.EXPERIENCES_DB_PATH!],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  // Show the seed's own summary, not the schema-init migration chatter.
  const lines = (res.stdout || "").split(/\r?\n/).filter((l) => l.startsWith("[testmiljo") || l.startsWith("  "));
  for (const l of lines) console.log(l);
  if (res.status !== 0) {
    process.stderr.write(res.stderr || "");
    throw new Error(`seed feilet (exit ${res.status})`);
  }
  console.log(`[testmiljo] testdata bygd på ${Date.now() - started} ms`);
}

function main(): void {
  const reason = refuseReason();
  if (reason) throw new Error(reason);
  const nullstill = process.argv.includes("--nullstill");
  const env = buildAppEnv(process.env, parseEnvFile(fs.readFileSync(ENV_FILE, "utf8")));

  if (nullstill) {
    // The seed deletes and rebuilds each file itself (inside .testmiljo/ only).
    console.log("[testmiljo] nullstiller: sletter og bygger testdatabasene på nytt");
    runSeed(env);
    removeOutbox(env.DB_PATH!);
    return;
  }

  if (dbFiles(env).some((f) => !fs.existsSync(f))) {
    console.log("[testmiljo] testdatabaser mangler — bygger testdata");
    runSeed(env);
  }

  console.log(`[testmiljo] starter appen på ${env.BASE_URL || "http://localhost:" + env.PORT} (Ctrl+C stopper)`);
  const child = spawn(process.execPath, [tsxCli(), path.join(REPO_ROOT, "src", "index.ts")], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  const stop = (sig: NodeJS.Signals) => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[testmiljo] AVBRYTER: ${(err as Error).message}`);
    process.exit(2);
  }
}

/**
 * Testmiljø — snapshots ("øyeblikk") of the three test databases.
 *
 *   npm run testmiljo:lagre -- <navn>   saves lokal.db, dental.db and
 *                                        experiences.db (and outbox.jsonl if
 *                                        present) to .testmiljo/oyeblikk/<navn>/
 *   npm run testmiljo:hent -- <navn>    puts that snapshot back (the app must
 *                                        be stopped first)
 *   With no name: lists the snapshots that exist and exits non-zero.
 *
 * Saving uses SQLite's own consistent copy (VACUUM INTO), so it is correct
 * even while the app has the databases open in WAL mode. Restoring copies each
 * file to a temp file in the target directory and renames it into place.
 *
 * Safety: the same production refusal as the seed (checked before any write),
 * database paths come from testmiljo.env and must pass assertInsideTestmiljo,
 * snapshot names are restricted to [a-z0-9-], and no path under
 * .testmiljo/oyeblikk may be a symlink.
 *
 * Cross-platform: plain node/tsx, no shell syntax.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type BetterSqlite3 from "better-sqlite3";
import {
  DB_SIDECARS,
  REPO_ROOT,
  SeedPaths,
  assertInsideTestmiljo,
  assertNotSymlink,
  assertTestmiljoDir,
  countRows,
  refuseReason,
} from "./seed";

export const SNAPSHOT_DIR_NAME = "oyeblikk";
export const OUTBOX_FILE = "outbox.jsonl";
export const META_FILE = "meta.json";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Windows device names: a folder with one of these names cannot be created or opened there. */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const DB_KEYS: Array<keyof SeedPaths> = ["rfb", "dental", "experiences"];

export interface SnapshotMeta {
  name: string;
  created: string;
  git_head: string | null;
  outbox: boolean;
  files: Record<keyof SeedPaths, string>;
  counts: Record<keyof SeedPaths, Record<string, number>>;
}

export function validateSnapshotName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `Ugyldig navn på øyeblikk: «${name}». Bruk små bokstaver a–z, tall og bindestrek (maks 40 tegn, ikke bindestrek først).`,
    );
  }
  if (RESERVED_RE.test(name)) {
    throw new Error(
      `Ugyldig navn på øyeblikk: «${name}». Navnet er reservert i Windows (con, prn, aux, nul, com1–com9, lpt1–lpt9) — velg et annet navn.`,
    );
  }
  return name;
}

function refuseIfProduction(env: NodeJS.ProcessEnv): void {
  const reason = refuseReason(env);
  if (reason) throw new Error(reason);
}

/** Throws if `p` exists and is a symlink; returns whether it exists. */
function existsNoLink(p: string): boolean {
  assertNotSymlink(p);
  return fs.existsSync(p);
}

/** `<testmiljoDir>/oyeblikk`, checked: no symlink, a directory if present. */
function snapshotRoot(testmiljoDir: string): string {
  const dir = assertTestmiljoDir(testmiljoDir);
  assertNotSymlink(dir);
  const root = path.join(dir, SNAPSHOT_DIR_NAME);
  if (existsNoLink(root) && !fs.lstatSync(root).isDirectory()) {
    throw new Error(`${root} finnes, men er ikke en mappe — avbryter.`);
  }
  return root;
}

function snapshotFileName(key: keyof SeedPaths): string {
  return `${key}.db`;
}

/** Names of the saved snapshots (sorted), [] when there are none. */
export function listSnapshots(testmiljoDir: string): string[] {
  const root = snapshotRoot(testmiljoDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name) && !RESERVED_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** All three DB paths must be checked and sit in the same `.testmiljo` dir. */
function checkDbPaths(testmiljoDir: string, dbPaths: SeedPaths): SeedPaths {
  const dir = path.resolve(testmiljoDir);
  const out = {} as SeedPaths;
  for (const key of DB_KEYS) {
    const p = assertInsideTestmiljo(dbPaths[key]);
    if (path.dirname(p) !== dir) {
      throw new Error(`Databasen ${p} ligger ikke i ${dir} — avbryter.`);
    }
    out[key] = p;
  }
  return out;
}

function gitHead(): string | null {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const sha = (res.stdout || "").trim();
    return res.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function openDb(p: string, readonly: boolean): BetterSqlite3.Database {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3") as typeof BetterSqlite3;
  return new Database(p, { readonly, fileMustExist: true });
}

/**
 * Saves the three databases (+ outbox.jsonl when present) as snapshot `name`
 * under `<testmiljoDir>/oyeblikk/`. An existing snapshot with the same name
 * is replaced only after the new one is complete.
 */
export function saveSnapshot(
  testmiljoDir: string,
  name: string,
  dbPaths: SeedPaths,
  env: NodeJS.ProcessEnv = process.env,
): SnapshotMeta {
  refuseIfProduction(env);
  validateSnapshotName(name);
  const paths = checkDbPaths(testmiljoDir, dbPaths);
  const root = snapshotRoot(testmiljoDir);
  for (const key of DB_KEYS) {
    if (!existsNoLink(paths[key])) {
      throw new Error(`Testdatabasen ${paths[key]} finnes ikke — kjør «npm run testmiljo:nullstill» først.`);
    }
  }

  fs.mkdirSync(root, { recursive: true });
  assertNotSymlink(root);
  const finalDir = path.join(root, name);
  assertNotSymlink(finalDir);
  // Temp names start with "." — never a valid snapshot name, so never listed.
  const work = path.join(root, `.${name}.lagrer-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work);

  try {
    const counts = {} as SnapshotMeta["counts"];
    const files = {} as SnapshotMeta["files"];
    for (const key of DB_KEYS) {
      const dest = path.join(work, snapshotFileName(key));
      // Read-write on purpose: VACUUM INTO does not modify the source, but a
      // read-only connection to a WAL database leaves -wal/-shm behind on
      // close, which would then make `hent` refuse («stopp appen først»).
      const db = openDb(paths[key], false);
      try {
        db.prepare("VACUUM INTO ?").run(dest);
      } finally {
        db.close();
      }
      const copy = openDb(dest, true);
      try {
        counts[key] = countRows(copy);
      } finally {
        copy.close();
      }
      files[key] = snapshotFileName(key);
    }

    const outboxSrc = path.join(path.resolve(testmiljoDir), OUTBOX_FILE);
    const outbox = existsNoLink(outboxSrc);
    if (outbox) fs.copyFileSync(outboxSrc, path.join(work, OUTBOX_FILE));

    const meta: SnapshotMeta = { name, created: new Date().toISOString(), git_head: gitHead(), outbox, files, counts };
    fs.writeFileSync(path.join(work, META_FILE), JSON.stringify(meta, null, 2) + "\n");

    if (fs.existsSync(finalDir)) {
      const old = path.join(root, `.${name}.gammel-${process.pid}`);
      fs.rmSync(old, { recursive: true, force: true });
      fs.renameSync(finalDir, old);
      fs.renameSync(work, finalDir);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(work, finalDir);
    }
    return meta;
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw err;
  }
}

/** Reads and checks a snapshot: meta.json + every file it names, no symlinks. */
export function readSnapshot(testmiljoDir: string, name: string): { dir: string; meta: SnapshotMeta } {
  validateSnapshotName(name);
  const root = snapshotRoot(testmiljoDir);
  const dir = path.join(root, name);
  if (!existsNoLink(dir) || !fs.lstatSync(dir).isDirectory()) {
    const have = listSnapshots(testmiljoDir);
    throw new Error(`Øyeblikket «${name}» finnes ikke.${have.length ? " Finnes: " + have.join(", ") : ""}`);
  }
  const metaPath = path.join(dir, META_FILE);
  if (!existsNoLink(metaPath)) throw new Error(`Øyeblikket «${name}» er ufullstendig (mangler ${META_FILE}).`);
  let meta: SnapshotMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as SnapshotMeta;
  } catch {
    throw new Error(`Øyeblikket «${name}» er ufullstendig (${META_FILE} kan ikke leses).`);
  }
  const need = DB_KEYS.map(snapshotFileName);
  if (meta.outbox) need.push(OUTBOX_FILE);
  for (const f of need) {
    const p = path.join(dir, f);
    if (!existsNoLink(p) || !fs.lstatSync(p).isFile()) {
      throw new Error(`Øyeblikket «${name}» er ufullstendig (mangler ${f}).`);
    }
  }
  return { dir, meta };
}

/** Copy `src` to a temp file next to `dest`, then rename it over `dest`. */
function atomicCopy(src: string, dest: string): void {
  const tmp = `${dest}.hent-${process.pid}.tmp`;
  assertNotSymlink(tmp);
  fs.rmSync(tmp, { force: true });
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Restores snapshot `name` over the three databases. Refuses while any
 * database has a -wal / -shm / -journal file (the app is probably running).
 * Each file is replaced atomically on its own; the three together are not one
 * atomic step, so a failure midway is reported and `hent` should be rerun.
 */
export function restoreSnapshot(
  testmiljoDir: string,
  name: string,
  dbPaths: SeedPaths,
  env: NodeJS.ProcessEnv = process.env,
): SnapshotMeta {
  refuseIfProduction(env);
  validateSnapshotName(name);
  const paths = checkDbPaths(testmiljoDir, dbPaths);
  const { dir, meta } = readSnapshot(testmiljoDir, name);

  // Every check before the first write: no symlinked outbox target either.
  const outboxDest = path.join(path.resolve(testmiljoDir), OUTBOX_FILE);
  assertNotSymlink(outboxDest);
  const busy: string[] = [];
  for (const key of DB_KEYS) {
    for (const suffix of DB_SIDECARS) {
      if (existsNoLink(paths[key] + suffix)) busy.push(path.basename(paths[key] + suffix));
    }
  }
  if (busy.length) {
    throw new Error(
      `Appen ser ut til å kjøre (${busy.join(", ")} finnes) — stopp appen først, og prøv igjen. ` +
        "(hent bytter hver database atomisk for seg, ikke alle tre samlet, så appen må være stoppet.)",
    );
  }

  const done: string[] = [];
  try {
    for (const key of DB_KEYS) {
      assertNotSymlink(paths[key]);
      atomicCopy(path.join(dir, snapshotFileName(key)), paths[key]);
      done.push(path.basename(paths[key]));
    }
    if (meta.outbox) {
      atomicCopy(path.join(dir, OUTBOX_FILE), outboxDest);
    } else if (existsNoLink(outboxDest)) {
      fs.rmSync(outboxDest, { force: true });
    }
  } catch (err) {
    throw new Error(
      `hent stoppet underveis (${(err as Error).message}). Hver fil byttes atomisk for seg, ikke alle tre samlet: ` +
        `${done.length ? done.join(", ") + " er allerede hentet" : "ingen filer er byttet"} — kjør hent på nytt.`,
    );
  }
  return meta;
}

// ── CLI ─────────────────────────────────────────────────────────────────
function pathsFromEnvFile(): { dir: string; paths: SeedPaths } {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { ENV_FILE, parseEnvFile } = require("./launch") as typeof import("./launch");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const fileEnv = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
  const pick = (k: string): string => {
    if (!fileEnv[k]) throw new Error(`testmiljo.env mangler ${k}`);
    return assertInsideTestmiljo(path.resolve(REPO_ROOT, fileEnv[k]));
  };
  const paths: SeedPaths = { rfb: pick("DB_PATH"), dental: pick("DENTAL_DB_PATH"), experiences: pick("EXPERIENCES_DB_PATH") };
  return { dir: path.dirname(paths.rfb), paths };
}

function main(argv: string[]): number {
  const reason = refuseReason();
  if (reason) throw new Error(reason);
  const mode = argv[0];
  const name = argv[1];
  if (mode !== "lagre" && mode !== "hent") {
    throw new Error("bruk: snapshot.ts lagre|hent <navn>");
  }
  const { dir, paths } = pathsFromEnvFile();
  if (!name) {
    const have = listSnapshots(dir);
    console.error(`[testmiljo:${mode}] bruk: npm run testmiljo:${mode} -- <navn>`);
    if (mode === "hent") {
      console.error("  hent bytter hver database for seg (atomisk per fil, ikke samlet for alle tre) — stopp appen først.");
    }
    console.error(have.length ? `  øyeblikk som finnes: ${have.join(", ")}` : "  ingen øyeblikk er lagret ennå");
    return 1;
  }
  if (mode === "lagre") {
    const meta = saveSnapshot(dir, name, paths);
    console.log(`[testmiljo:lagre] lagret øyeblikket «${meta.name}» i ${path.join(dir, SNAPSHOT_DIR_NAME, meta.name)}`);
    if (meta.outbox) console.log(`  med ${OUTBOX_FILE}`);
  } else {
    const meta = restoreSnapshot(dir, name, paths);
    console.log(`[testmiljo:hent] hentet øyeblikket «${meta.name}» (lagret ${meta.created})`);
    console.log("  hver database ble byttet atomisk for seg (ikke samlet for alle tre)");
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[testmiljo] AVBRYTER: ${(err as Error).message}`);
    process.exit(2);
  }
}

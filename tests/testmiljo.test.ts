/**
 * testmiljo.test.ts — tests for the local test environment's seed
 * (scripts/testmiljo/seed.ts) and launcher env (scripts/testmiljo/launch.ts).
 *
 *   (a) seeding into a temp `.testmiljo/` twice gives identical row counts
 *       per table, in all three databases (AK5);
 *   (b) the seed refuses (non-zero exit, nothing written) with
 *       NODE_ENV=production, with FLY_APP_NAME / FLY_MACHINE_ID set, and for a
 *       target outside a `.testmiljo/` directory;
 *   (c) every seeded e-mail address ends in `.invalid`.
 * Plus: the launcher drops credential-looking variables, keeps PATH and
 * refuses DB paths outside .testmiljo/; the path guard accepts only the
 * repo's own .testmiljo/ (or one under the OS temp dir) and refuses symlinks;
 * snapshots (scripts/testmiljo/snapshot.ts) round-trip, refuse while a -wal
 * file exists, refuse bad names and refuse in production.
 *
 * The seed runs as a child process (the real CLI, through tsx), so it never
 * touches this process's DB singletons. Temp dirs are removed in `finally`.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx tests/testmiljo.test.ts
 *   2. Wired into the gate: tests/test.ts calls runTestmiljoTests().
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const REPO_ROOT = path.resolve(__dirname, "..");
const SEED = path.join(REPO_ROOT, "scripts", "testmiljo", "seed.ts");
const CHILD_TIMEOUT_MS = 120_000;
const SNAPSHOT = path.join(REPO_ROOT, "scripts", "testmiljo", "snapshot.ts");

function tsxCli(): string {
  const pkgPath = require.resolve("tsx/package.json", { paths: [REPO_ROOT] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.tsx;
  return path.join(path.dirname(pkgPath), bin);
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function throws(fn: () => unknown, re?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return re ? re.test((err as Error).message) : true;
  }
}

function runSeed(args: string[], envOver: Record<string, string | undefined>): Promise<RunResult> {
  return runScript(SEED, args, envOver);
}

function runScript(script: string, args: string[], envOver: Record<string, string | undefined>): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The suite sets NODE_ENV=test; FLY_* must not leak in from a CI shell.
  delete env.FLY_APP_NAME;
  delete env.FLY_MACHINE_ID;
  for (const [k, v] of Object.entries(envOver)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli(), script, ...args], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // N6 (review of #1673): a hung child must not hang all of `npm test` silently.
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
      resolve({ code: -1, stdout, stderr: stderr + `\n${path.basename(script)} timed out after ${CHILD_TIMEOUT_MS / 1000} s and was killed` });
    }, CHILD_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err) }); });
  });
}

type Counts = Record<string, Record<string, number>>;

function countsFromOutput(stdout: string): Counts | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("TESTMILJO_COUNTS "));
  return line ? (JSON.parse(line.slice("TESTMILJO_COUNTS ".length)) as Counts) : null;
}

/** Row counts per table, read straight from the files (not the seed's own report). */
function countsFromFiles(dir: string): Counts {
  const out: Counts = {};
  for (const [key, file] of [["rfb", "lokal.db"], ["dental", "dental.db"], ["experiences", "experiences.db"]]) {
    const db = new Database(path.join(dir, file), { fileMustExist: true }); // read-write: a read-only one leaves -wal/-shm on WAL DBs
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
      out[key] = {};
      for (const { name } of tables) {
        try {
          out[key][name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
        } catch {
          // unreadable virtual/shadow table — skip
        }
      }
    } finally {
      db.close();
    }
  }
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Every e-mail-shaped substring in any text cell of the three DBs. */
function emailsInFiles(dir: string): string[] {
  const found: string[] = [];
  for (const file of ["lokal.db", "dental.db", "experiences.db"]) {
    const db = new Database(path.join(dir, file), { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        let rows: Array<Record<string, unknown>>;
        try {
          rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
        } catch {
          continue;
        }
        for (const row of rows) {
          for (const v of Object.values(row)) {
            if (typeof v !== "string") continue;
            for (const m of v.match(EMAIL_RE) ?? []) found.push(`${file}:${name}:${m}`);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return found;
}

export async function runTestmiljoTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testmiljo-test-"));
  const extraRoots: string[] = [];
  /** A further accepted `<tmpdir>/<mkdtemp>/.testmiljo` (the guard wants a direct child of tmpdir). */
  const extraTestmiljo = (prefix: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    extraRoots.push(root);
    const d = path.join(root, ".testmiljo");
    fs.mkdirSync(d);
    return d;
  };
  try {
    const dir = path.join(tmpRoot, ".testmiljo");

    // (a) AK5: two seeds, identical row counts per table.
    const first = await runSeed(["--dir", dir], {});
    check(first.code === 0, "tm-a1: first seed exits 0", `exit ${first.code}: ${first.stderr.slice(-400)}`);
    const filesFirst = first.code === 0 ? countsFromFiles(dir) : null;
    const second = await runSeed(["--dir", dir], {});
    check(second.code === 0, "tm-a2: second seed (over the first) exits 0", `exit ${second.code}: ${second.stderr.slice(-400)}`);
    const filesSecond = second.code === 0 ? countsFromFiles(dir) : null;
    check(
      !!filesFirst && !!filesSecond && JSON.stringify(filesFirst) === JSON.stringify(filesSecond),
      "tm-a3: identical row counts per table across two runs (all three DBs)",
    );
    const reported = countsFromOutput(second.stdout);
    check(!!reported && JSON.stringify(reported) === JSON.stringify(filesSecond), "tm-a4: the seed's own count report matches the files");
    const rfb = filesSecond?.rfb ?? {};
    const exp = filesSecond?.experiences ?? {};
    const dental = filesSecond?.dental ?? {};
    check(rfb.agents === 7 && rfb.products === 6 && rfb.orders === 6 && rfb.agent_claims === 3, "tm-a5: rfb fixture sizes (7 agents, 6 products, 6 orders, 3 owners)", JSON.stringify({ a: rfb.agents, p: rfb.products, o: rfb.orders, c: rfb.agent_claims }));
    check(exp.experience_providers === 3 && exp.gardssalg_bookings === 9, "tm-a6: gårdssalg fixture sizes (3 providers, 9 visit requests)");
    check((dental.dental_agents ?? 0) >= 3, "tm-a7: dental has a small set of clinics");

    if (filesSecond) {
      const ldb = new Database(path.join(dir, "lokal.db"), { readonly: true });
      try {
        const dup = ldb.prepare("SELECT COUNT(*) AS c FROM agents WHERE org_nr = '999000005' AND is_active = 1").get() as { c: number };
        check(dup.c === 2, "tm-a8: duplicate group — two active profiles share one org.nr.");
        const locked = ldb.prepare("SELECT curated_fields FROM agent_knowledge WHERE curated_fields != '{}'").all() as Array<{ curated_fields: string }>;
        check(locked.length === 1 && "about" in JSON.parse(locked[0].curated_fields), "tm-a9: one locked profile (curated about lock)");
        const site = ldb.prepare("SELECT COUNT(*) AS c FROM agents WHERE url = 'http://localhost/eksempel'").get() as { c: number };
        check(site.c === 1, "tm-a10: one owner with a local example website URL");
      } finally {
        ldb.close();
      }
      const edb = new Database(path.join(dir, "experiences.db"), { readonly: true });
      try {
        const states = edb.prepare("SELECT DISTINCT status || '/' || pre_status AS s FROM gardssalg_bookings").all() as Array<{ s: string }>;
        const set = new Set(states.map((r) => r.s));
        const want = ["reserved/awaiting_provider", "reserved/provider_confirmed", "reserved/time_suggested", "reserved/provider_declined", "reserved/expired", "cancelled/provider_confirmed", "confirmed_attended/provider_confirmed", "no_show/provider_confirmed"];
        check(want.every((w) => set.has(w)), "tm-a11: visit requests cover every status/pre_status the code uses", [...set].join(","));
      } finally {
        edb.close();
      }

      // (c) every seeded e-mail ends in .invalid
      const emails = emailsInFiles(dir);
      const bad = emails.filter((e) => !e.toLowerCase().endsWith(".invalid"));
      check(emails.length > 0, "tm-c1: the seed wrote e-mail addresses at all");
      check(bad.length === 0, "tm-c2: every e-mail address in the seeded DBs ends in .invalid", bad.slice(0, 5).join(", "));
    }

    // (b) refusals: non-zero exit, nothing written.
    const refuseDir = path.join(tmpRoot, "refuse", ".testmiljo");
    const prod = await runSeed(["--dir", refuseDir], { NODE_ENV: "production" });
    check(prod.code !== 0 && /NODE_ENV=production/.test(prod.stderr), "tm-b1: refuses with NODE_ENV=production", `exit ${prod.code}`);
    const fly = await runSeed(["--dir", refuseDir], { FLY_APP_NAME: "lokal" });
    check(fly.code !== 0 && /FLY_APP_NAME/.test(fly.stderr), "tm-b2: refuses with FLY_APP_NAME set", `exit ${fly.code}`);
    const machine = await runSeed(["--dir", refuseDir], { FLY_MACHINE_ID: "abc123" });
    check(machine.code !== 0 && /FLY_MACHINE_ID/.test(machine.stderr), "tm-b3: refuses with FLY_MACHINE_ID set", `exit ${machine.code}`);
    check(!fs.existsSync(refuseDir), "tm-b4: a refused run creates nothing");
    const outside = path.join(tmpRoot, "not-testmiljo");
    const out = await runSeed(["--dir", outside], {});
    check(out.code !== 0 && /utenfor/.test(out.stderr) && !fs.existsSync(path.join(outside, "lokal.db")), "tm-b5: refuses a target outside .testmiljo/", `exit ${out.code}`);

    // Launcher env: credentials stripped, PATH kept, DB paths forced into .testmiljo/.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const launch = require("../scripts/testmiljo/launch") as typeof import("../scripts/testmiljo/launch");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fileEnv = launch.parseEnvFile(fs.readFileSync(launch.ENV_FILE, "utf8"));
    const appEnv = launch.buildAppEnv(
      { PATH: "/usr/bin", Path: "C:\\Windows", ANTHROPIC_API_KEY: "x", SMTP_HOST: "x", A2A_READ_PAT: "x", STRIPE_SECRET_KEY: "x", DB_PATH: "/app/data/lokal.db" },
      fileEnv,
    );
    check(appEnv.PATH === "/usr/bin" && appEnv.Path === "C:\\Windows", "tm-l1: launcher keeps PATH");
    check(!appEnv.ANTHROPIC_API_KEY && !appEnv.SMTP_HOST && !appEnv.A2A_READ_PAT && !appEnv.STRIPE_SECRET_KEY, "tm-l2: launcher drops credential-looking variables");
    check(
      [appEnv.DB_PATH, appEnv.DENTAL_DB_PATH, appEnv.EXPERIENCES_DB_PATH].every((p) => !!p && path.basename(path.dirname(p)) === ".testmiljo"),
      "tm-l3: launcher DB paths resolve into .testmiljo/ (shell DB_PATH ignored)",
    );
    check(fileEnv.NODE_ENV !== "production" && !Object.keys(fileEnv).some((k) => launch.isCredentialName(k)), "tm-l4: testmiljo.env holds no credential-named keys and is not production");
    for (const bad of ["data/lokal.db", path.join(tmpRoot, "elsewhere", "lokal.db"), "foo/.testmiljo/lokal.db"]) {
      check(
        throws(() => launch.buildAppEnv({ PATH: "/usr/bin" }, { ...fileEnv, DB_PATH: bad })),
        `tm-l5: launcher refuses a testmiljo.env DB_PATH outside .testmiljo/ (${bad})`,
      );
    }

    // N3 (review of #1664): inherited env is an allowlist, not a deny-list.
    const n3 = launch.buildAppEnv(
      {
        PATH: "/usr/bin", Path: "C:\\Windows", SystemRoot: "C:\\Windows", LC_ALL: "C.UTF-8", CI: "true",
        GSC_SERVICE_ACCOUNT_JSON: "{}", SENTRY_DSN: "https://x@sentry.io/1", RENDER_WORKER_URL: "https://w", LOKAL_API_URL: "https://api",
        FOO_BAR_URL: "https://foo", NODE_OPTIONS: "--require /x.js", NODE_ENV: "production",
      },
      { ...fileEnv, FROM_FILE: "yes" },
    );
    check(!n3.GSC_SERVICE_ACCOUNT_JSON && !n3.SENTRY_DSN && !n3.RENDER_WORKER_URL && !n3.LOKAL_API_URL, "tm-l6: launcher drops GSC_SERVICE_ACCOUNT_JSON, SENTRY_DSN, RENDER_WORKER_URL, LOKAL_API_URL");
    check(!n3.FOO_BAR_URL && !n3.NODE_OPTIONS, "tm-l7: launcher drops an unknown variable (FOO_BAR_URL) and NODE_OPTIONS");
    check(n3.PATH === "/usr/bin" && n3.Path === "C:\\Windows" && n3.SystemRoot === "C:\\Windows" && n3.LC_ALL === "C.UTF-8" && n3.CI === "true", "tm-l8: launcher passes PATH, Path, SystemRoot, LC_*, CI");
    check(n3.FROM_FILE === "yes" && n3.NODE_ENV === fileEnv.NODE_ENV, "tm-l9a: testmiljo.env values reach the app and NODE_ENV is not inherited");
    // N5 (review of #1673): an INHERITED name (TZ) set in both parent and file — the file value must win.
    const order = launch.buildAppEnv({ PATH: "/usr/bin", TZ: "America/New_York" }, { ...fileEnv, TZ: "Europe/Oslo" });
    check(order.TZ === "Europe/Oslo", "tm-l9: testmiljo.env wins over an inherited value (TZ in both parent and file)");
    check(launch.buildAppEnv({ TZ: "America/New_York" }, fileEnv).TZ === "America/New_York", "tm-l9b: without a file value the inherited TZ is passed through");
    // N1/N4 (review of #1673): names that DO match the allowlist but look like credentials are still dropped.
    check(
      !launch.isInheritedName("LC_SECRET") && !launch.isInheritedName("LC_API_KEY") && !launch.isInheritedName("TSX_TOKEN") && launch.isInheritedName("LC_CTYPE"),
      "tm-l10: an allowlist-matching but credential-looking name (LC_SECRET, LC_API_KEY, TSX_TOKEN) is never inherited; LC_CTYPE is",
    );
    check(
      !launch.isInheritedName("TSX_FOO") && !launch.isInheritedName("TSX_NODE_OPTIONS") && launch.isInheritedName("TSX_TSCONFIG_PATH"),
      "tm-l11: TSX_* is no open prefix: arbitrary TSX_ names are dropped, the concrete TSX_TSCONFIG_PATH is passed",
    );

    // Path guard (N1): only <repo>/.testmiljo or a .testmiljo under the OS temp dir.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const seed = require("../scripts/testmiljo/seed") as typeof import("../scripts/testmiljo/seed");
    /* eslint-enable @typescript-eslint/no-var-requires */
    check(throws(() => seed.assertInsideTestmiljo(path.join(REPO_ROOT, "foo", ".testmiljo", "x.db"))), "tm-g1: guard refuses <repo>/foo/.testmiljo/x.db (not the repo's own .testmiljo)");
    check(throws(() => seed.assertInsideTestmiljo(path.join(path.parse(REPO_ROOT).root, "srv", "app", ".testmiljo", "x.db"))), "tm-g2: guard refuses a .testmiljo/ outside the repo and the temp dir");
    check(throws(() => seed.assertInsideTestmiljo(path.join(tmpRoot, "x.db"))), "tm-g3: guard refuses a temp dir that is not named .testmiljo");
    check(!throws(() => seed.assertInsideTestmiljo(path.join(REPO_ROOT, ".testmiljo", "x.db"))), "tm-g4: guard accepts <repo>/.testmiljo/x.db");
    check(!throws(() => seed.assertInsideTestmiljo(path.join(dir, "x.db"))), "tm-g5: guard accepts <tmp>/…/.testmiljo/x.db");
    check(throws(() => seed.assertInsideTestmiljo(path.join(tmpRoot, "dypere", ".testmiljo", "x.db"))), "tm-g10: guard refuses a .testmiljo/ nested deeper than <tmpdir>/<one dir>/");
    {
      const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
      const fsRoot = path.parse(REPO_ROOT).root;
      try {
        process.env.TMPDIR = fsRoot;
        process.env.TEMP = fsRoot;
        process.env.TMP = fsRoot;
        const tmpNow = os.tmpdir();
        check(
          path.dirname(path.resolve(tmpNow)) !== path.resolve(tmpNow) || throws(() => seed.assertInsideTestmiljo(path.join(fsRoot, "srv", ".testmiljo", "x.db"))),
          "tm-g11: guard refuses the temp-dir exception when TMPDIR is the filesystem root",
          `tmpdir=${tmpNow}`,
        );
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    // Path guard (N2): a symlinked DB file (or sidecar), broken links included.
    const linkDir = extraTestmiljo("testmiljo-lenker-");
    const realTarget = path.join(tmpRoot, "ekte.db");
    fs.writeFileSync(realTarget, "");
    let canLink = true;
    try {
      fs.symlinkSync(realTarget, path.join(linkDir, "lenke.db"));
      fs.symlinkSync(path.join(tmpRoot, "finnes-ikke.db"), path.join(linkDir, "brutt.db"));
      fs.symlinkSync(realTarget, path.join(linkDir, "wal.db-wal"));
    } catch {
      canLink = false;
    }
    if (canLink) {
      check(throws(() => seed.assertInsideTestmiljo(path.join(linkDir, "lenke.db"))), "tm-g6: guard refuses a symlinked DB file");
      check(throws(() => seed.assertInsideTestmiljo(path.join(linkDir, "brutt.db"))), "tm-g7: guard refuses a broken symlink");
      check(throws(() => seed.assertInsideTestmiljo(path.join(linkDir, "wal.db"))), "tm-g8: guard refuses a DB whose -wal sidecar is a symlink");
      const linked = await runSeed(["--dir", linkDir, "--rfb", path.join(linkDir, "lenke.db")], {});
      check(linked.code !== 0 && fs.readFileSync(realTarget, "utf8") === "", "tm-g9: the seed refuses a symlinked target and leaves the link target untouched", `exit ${linked.code}`);

      // N8, step 1 (tm-g15a): a real directory whose basename is not .testmiljo is refused.
      const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testmiljo-vanlig-"));
      extraRoots.push(plainRoot);
      const plainReal = path.join(plainRoot, "data");
      fs.mkdirSync(plainReal);
      check(throws(() => seed.assertTestmiljoDir(plainReal), /ikke en godkjent/), "tm-g15a: guard refuses a real directory not named .testmiljo");
      // N8, step 2 (tm-g15): a path named .testmiljo that resolves to that other-named real directory is refused too.
      const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testmiljo-alias-"));
      extraRoots.push(aliasRoot);
      const alias = path.join(aliasRoot, ".testmiljo");
      fs.symlinkSync(plainReal, alias, "dir");
      check(throws(() => seed.assertTestmiljoDir(alias), /ikke en godkjent/), "tm-g15: guard refuses a .testmiljo whose real directory has another basename");

      // N9: the .testmiljo directory itself is a symlink (to another accepted .testmiljo/).
      const linkTarget = extraTestmiljo("testmiljo-maal-");
      const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testmiljo-lenket-mappe-"));
      extraRoots.push(linkRoot);
      const linkedDir = path.join(linkRoot, ".testmiljo");
      fs.symlinkSync(linkTarget, linkedDir, "dir");
      check(throws(() => seed.assertInsideTestmiljo(path.join(linkedDir, "lokal.db")), /symbolsk lenke/), "tm-g12: guard refuses a .testmiljo/ directory that is a symlink");
      const linkedSeed = await runSeed(["--dir", linkedDir], {});
      check(
        linkedSeed.code !== 0 && /symbolsk lenke/.test(linkedSeed.stderr) && fs.readdirSync(linkTarget).length === 0,
        "tm-g13: the seed refuses a symlinked .testmiljo/ and writes nothing through it",
        `exit ${linkedSeed.code}`,
      );
      // The repo's own <repo>/.testmiljo as a symlink — only when it does not exist yet.
      let repoLinked = false;
      try {
        fs.lstatSync(seed.DEFAULT_DIR);
      } catch {
        try {
          fs.symlinkSync(linkTarget, seed.DEFAULT_DIR, "dir");
          repoLinked = true;
        } catch {
          // cannot create it here
        }
      }
      if (repoLinked) {
        try {
          check(throws(() => seed.assertInsideTestmiljo(path.join(seed.DEFAULT_DIR, "lokal.db")), /symbolsk lenke/), "tm-g14: guard refuses <repo>/.testmiljo when it is a symlink");
        } finally {
          fs.unlinkSync(seed.DEFAULT_DIR);
        }
      } else if (log) {
        console.log("  skip tm-g14: <repo>/.testmiljo already exists");
      }
    } else if (log) {
      console.log("  skip tm-g6..g9: symlinks cannot be created here (Windows without privilege?)");
    }

    // Snapshots (lagre / hent).
    /* eslint-disable @typescript-eslint/no-var-requires */
    const snap = require("../scripts/testmiljo/snapshot") as typeof import("../scripts/testmiljo/snapshot");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const dbPaths = seed.defaultPaths(dir);
    const outbox = path.join(dir, "outbox.jsonl");
    const agentName = () => {
      // read-write: a read-only connection leaves -wal/-shm behind on a WAL database
      const db = new Database(dbPaths.rfb, { fileMustExist: true });
      try {
        return (db.prepare("SELECT name FROM agents WHERE id = ?").get("00000000-0000-4000-8001-000000000001") as { name: string }).name;
      } finally {
        db.close();
      }
    };
    const before = countsFromFiles(dir);
    const nameBefore = agentName();
    const meta = snap.saveSnapshot(dir, "rundtur", dbPaths);
    check(JSON.stringify(meta.counts) === JSON.stringify(before), "tm-s1: lagre records the same row counts as the live DBs");
    check(snap.listSnapshots(dir).includes("rundtur") && !meta.outbox, "tm-s2: the snapshot is listed (no outbox.jsonl yet)");
    {
      const db = new Database(dbPaths.rfb);
      db.prepare("UPDATE agents SET name = 'Endret navn' WHERE id = ?").run("00000000-0000-4000-8001-000000000001");
      db.prepare("DELETE FROM products WHERE agent_id = ?").run("00000000-0000-4000-8001-000000000004");
      db.close();
      const ddb = new Database(dbPaths.dental);
      ddb.prepare("DELETE FROM dental_agents").run();
      ddb.close();
    }
    fs.writeFileSync(outbox, '{"to":"x@y.invalid"}\n');
    check(agentName() === "Endret navn" && JSON.stringify(countsFromFiles(dir)) !== JSON.stringify(before), "tm-s3: the mutation changed the live DBs");
    snap.restoreSnapshot(dir, "rundtur", dbPaths);
    check(JSON.stringify(countsFromFiles(dir)) === JSON.stringify(before), "tm-s4: hent restores the row counts of every table in all three DBs");
    check(agentName() === nameBefore, "tm-s5: hent restores the mutated row");
    check(!fs.existsSync(outbox), "tm-s6: hent removes an outbox.jsonl the snapshot did not have");
    check(fs.readdirSync(dir).every((f) => !f.includes(".hent-")) && fs.readdirSync(path.join(dir, "oyeblikk")).every((f) => !f.startsWith(".")), "tm-s7: no temp files left behind");

    fs.writeFileSync(outbox, '{"to":"a@b.invalid"}\n');
    check(snap.saveSnapshot(dir, "med-outbox", dbPaths).outbox, "tm-s8: lagre includes outbox.jsonl when it exists");
    fs.rmSync(outbox);
    snap.restoreSnapshot(dir, "med-outbox", dbPaths);
    check(fs.existsSync(outbox) && fs.readFileSync(outbox, "utf8") === '{"to":"a@b.invalid"}\n', "tm-s9: hent puts outbox.jsonl back");

    // While a WAL writer (the app) has the DB open: lagre is consistent, hent refuses.
    {
      const live = new Database(dbPaths.rfb);
      try {
        live.pragma("journal_mode = WAL");
        live.prepare("UPDATE agents SET name = 'Kun i WAL' WHERE id = ?").run("00000000-0000-4000-8001-000000000001");
        check(fs.existsSync(dbPaths.rfb + "-wal"), "tm-s10: the app-like connection runs in WAL mode (-wal file exists)");
        let msg = "";
        try {
          snap.restoreSnapshot(dir, "rundtur", dbPaths);
        } catch (e) {
          msg = (e as Error).message;
        }
        check(/stopp appen først/.test(msg), "tm-s11: hent refuses while a -wal file exists («stopp appen først»)", msg);
        snap.saveSnapshot(dir, "under-kjoring", dbPaths);
        const copy = new Database(path.join(dir, "oyeblikk", "under-kjoring", "rfb.db"), { readonly: true });
        try {
          const row = copy.prepare("SELECT name FROM agents WHERE id = ?").get("00000000-0000-4000-8001-000000000001") as { name: string };
          check(row.name === "Kun i WAL", "tm-s12: lagre while the app runs captures committed WAL content");
        } finally {
          copy.close();
        }
      } finally {
        live.close();
      }
    }
    check(agentName() === "Kun i WAL", "tm-s13: hent refused → live DB left as it was");

    // B1: the app leaves the DBs in WAL mode; stopped app → lagre → hent must work.
    for (const key of ["rfb", "dental", "experiences"] as const) {
      const db = new Database(dbPaths[key]);
      db.pragma("journal_mode = WAL");
      db.close();
    }
    const sidecars = () =>
      (["rfb", "dental", "experiences"] as const).flatMap((k) => ["-wal", "-shm"].map((s) => dbPaths[k] + s)).filter((f) => fs.existsSync(f));
    check(sidecars().length === 0, "tm-s25: WAL-mode DBs with all connections closed have no -wal/-shm", sidecars().join(","));
    snap.saveSnapshot(dir, "wal-stoppet", dbPaths);
    check(sidecars().length === 0, "tm-s26: lagre on WAL-mode DBs leaves no -wal/-shm behind", sidecars().map((f) => path.basename(f)).join(","));
    check(!throws(() => snap.restoreSnapshot(dir, "wal-stoppet", dbPaths)), "tm-s27: stopped app → lagre → hent succeeds on WAL-mode DBs");
    check(agentName() === "Kun i WAL" && sidecars().length === 0, "tm-s28: the WAL round trip keeps the data and leaves no sidecars", sidecars().join(","));

    // Invalid names, missing / incomplete snapshots, symlinks, production.
    const badNames = ["../x", "..", "a/b", "a\\b", "a.b", "A", "", "-a", "a b", "x".repeat(41)];
    check(badNames.every((n) => throws(() => snap.saveSnapshot(dir, n, dbPaths)) && throws(() => snap.restoreSnapshot(dir, n, dbPaths))), "tm-s14: invalid snapshot names are refused by lagre and hent");
    const reserved = ["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])];
    check(
      reserved.every(
        (n) =>
          throws(() => snap.validateSnapshotName(n), /reservert i Windows/) &&
          throws(() => snap.saveSnapshot(dir, n, dbPaths), /reservert i Windows/) &&
          throws(() => snap.restoreSnapshot(dir, n, dbPaths), /reservert i Windows/),
      ),
      "tm-s29: Windows reserved device names are refused by lagre and hent",
    );
    check(["com10", "lpt0", "con1", "konsoll", "nul-x"].every((n) => !throws(() => snap.validateSnapshotName(n))), "tm-s30: names that only resemble reserved ones are accepted");
    check(fs.readdirSync(path.join(dir, "oyeblikk")).sort().join(",") === "med-outbox,rundtur,under-kjoring,wal-stoppet", "tm-s15: refused names create nothing", fs.readdirSync(path.join(dir, "oyeblikk")).join(","));
    // N1: a reserved-name directory made directly on disk (bypassing validation) is not listed.
    {
      const reservedDir = path.join(dir, "oyeblikk", "nul");
      fs.mkdirSync(reservedDir);
      try {
        const listed = snap.listSnapshots(dir);
        check(!listed.includes("nul") && listed.includes("rundtur"), "tm-s32: listSnapshots skips a reserved-name directory but lists normal snapshots", listed.join(","));
      } finally {
        fs.rmSync(reservedDir, { recursive: true, force: true });
      }
    }
    check(throws(() => snap.restoreSnapshot(dir, "finnes-ikke", dbPaths), /finnes ikke/), "tm-s16: hent refuses a missing snapshot");
    fs.rmSync(path.join(dir, "oyeblikk", "under-kjoring", "dental.db"));
    check(throws(() => snap.restoreSnapshot(dir, "under-kjoring", dbPaths), /ufullstendig/), "tm-s17: hent refuses an incomplete snapshot");
    // The other DB exists and sits in another accepted .testmiljo/: only the same-folder rule refuses it.
    const otherDir = extraTestmiljo("testmiljo-annen-");
    fs.copyFileSync(dbPaths.dental, path.join(otherDir, "dental.db"));
    check(!throws(() => seed.assertInsideTestmiljo(path.join(otherDir, "dental.db"))), "tm-s18a: the other folder is itself an accepted .testmiljo/");
    check(
      throws(() => snap.saveSnapshot(dir, "feil-mappe", { ...dbPaths, dental: path.join(otherDir, "dental.db") }), /ligger ikke i/) &&
        !fs.existsSync(path.join(dir, "oyeblikk", "feil-mappe")),
      "tm-s18: lagre refuses DB paths that are not in the given .testmiljo/",
    );
    if (canLink) {
      const symSnapDir = extraTestmiljo("testmiljo-lenket-oyeblikk-");
      fs.symlinkSync(path.join(dir, "oyeblikk"), path.join(symSnapDir, "oyeblikk"), "dir");
      check(throws(() => snap.listSnapshots(symSnapDir)) && throws(() => snap.restoreSnapshot(symSnapDir, "rundtur", seed.defaultPaths(symSnapDir))), "tm-s19: a symlinked oyeblikk/ directory is refused");

      // A symlinked outbox.jsonl: lagre does not follow it, hent writes nothing.
      fs.rmSync(outbox, { force: true });
      fs.writeFileSync(realTarget, '{"lenket":true}\n');
      fs.symlinkSync(realTarget, outbox);
      check(
        throws(() => snap.saveSnapshot(dir, "lenket-outbox", dbPaths), /symbolsk lenke/) && !fs.existsSync(path.join(dir, "oyeblikk", "lenket-outbox")),
        "tm-s23: lagre refuses a symlinked outbox.jsonl",
      );
      const nameNow = agentName();
      check(
        throws(() => snap.restoreSnapshot(dir, "rundtur", dbPaths), /symbolsk lenke/) && agentName() === nameNow && fs.lstatSync(outbox).isSymbolicLink(),
        "tm-s24: hent refuses a symlinked outbox.jsonl before touching any database",
      );
      fs.rmSync(outbox, { force: true });

      // N7: a file inside a snapshot that is a symlink → refused as a link (not only «ufullstendig»).
      const snapFile = path.join(dir, "oyeblikk", "rundtur", "rfb.db");
      const moved = path.join(tmpRoot, "rundtur-rfb.db");
      fs.renameSync(snapFile, moved);
      fs.symlinkSync(moved, snapFile);
      const nameBeforeLink = agentName();
      check(
        throws(() => snap.readSnapshot(dir, "rundtur"), /symbolsk lenke/) &&
          throws(() => snap.restoreSnapshot(dir, "rundtur", dbPaths), /symbolsk lenke/) &&
          agentName() === nameBeforeLink,
        "tm-s31: readSnapshot/hent refuse a snapshot whose file is a symlink",
      );
      fs.unlinkSync(snapFile);
      fs.renameSync(moved, snapFile);
    }
    const prodEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    check(
      throws(() => snap.saveSnapshot(dir, "prod", dbPaths, prodEnv), /NODE_ENV=production/) &&
        throws(() => snap.restoreSnapshot(dir, "rundtur", dbPaths, prodEnv), /NODE_ENV=production/) &&
        throws(() => snap.saveSnapshot(dir, "fly", dbPaths, { FLY_APP_NAME: "lokal" } as NodeJS.ProcessEnv), /FLY_APP_NAME/) &&
        !fs.existsSync(path.join(dir, "oyeblikk", "prod")),
      "tm-s20: lagre/hent refuse in production (nothing written)",
    );
    const cliProd = await runScript(SNAPSHOT, ["lagre", "prod"], { NODE_ENV: "production" });
    check(cliProd.code !== 0 && /NODE_ENV=production/.test(cliProd.stderr), "tm-s21: the snapshot CLI refuses with NODE_ENV=production", `exit ${cliProd.code}`);
    const cliBad = await runScript(SNAPSHOT, ["hent", "../x"], {});
    check(cliBad.code !== 0 && /Ugyldig navn/.test(cliBad.stderr), "tm-s22: the snapshot CLI refuses a name with a path in it", `exit ${cliBad.code}`);
  } catch (err) {
    failed++;
    failures.push("unexpected error: " + String((err as Error)?.stack || err));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (const r of extraRoots) fs.rmSync(r, { recursive: true, force: true });
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runTestmiljoTests({ log: true }).then((r) => {
    console.log(`testmiljo: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log("  FAIL " + f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}

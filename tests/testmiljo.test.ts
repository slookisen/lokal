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
 * Plus: the launcher drops credential-looking variables and keeps PATH.
 *
 * The seed runs as a child process (the real CLI, through tsx), so it never
 * touches this process's DB singletons. Temp dirs are removed in `finally`.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx tests/testmiljo.test.ts
 *   2. Wired into the gate: tests/test.ts calls runTestmiljoTests().
 */

import { spawn } from "child_process";
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

function tsxCli(): string {
  const pkgPath = require.resolve("tsx/package.json", { paths: [REPO_ROOT] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.tsx;
  return path.join(path.dirname(pkgPath), bin);
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function runSeed(args: string[], envOver: Record<string, string | undefined>): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The suite sets NODE_ENV=test; FLY_* must not leak in from a CI shell.
  delete env.FLY_APP_NAME;
  delete env.FLY_MACHINE_ID;
  for (const [k, v] of Object.entries(envOver)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli(), SEED, ...args], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
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
    const db = new Database(path.join(dir, file), { readonly: true });
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
  } catch (err) {
    failed++;
    failures.push("unexpected error: " + String((err as Error)?.stack || err));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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

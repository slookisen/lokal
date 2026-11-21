/**
 * google-connected-apps.test.ts — slice G1-1: Google Connected Apps domain
 * verification at /.well-known/google-connected-apps (behind
 * GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED).
 *
 * Proves routes/google-connected-apps.ts:
 *   AK1  flag off → 404 on rettfrabonden.com and opplevagent.no (also with
 *        tokens set), body never echoes the env value.
 *   AK2  flag on + tokens → 200 application/json {"verification_tokens":[...]}
 *        with exactly the configured tokens, on both hosts, no 3xx.
 *        JSON-file form and comma-list form; per-host opplevagent value with
 *        fallback to the shared one.
 *   Flag on + value missing/empty/invalid → 404 (never 500, never the env).
 *   Other paths / hosts / methods fall straight through (downstream answers
 *        as before: the test app's stand-in host gates still 301/404 them).
 *   src/index.ts mounts the middleware before the agentplatform.no,
 *        finn-tannlege.com and opplevagent.no host gates and express.static.
 *
 * A real Express app over Node's http module with stand-ins for the
 * downstream host gates (opplevagent.no 404s non-matching paths; a
 * rettfrabonden→opplevagent 301; an SPA fallback). Env is injected, never
 * mutated. No DB.
 *
 * Standalone: npx tsx src/routes/google-connected-apps.test.ts
 */

import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import {
  GOOGLE_CONNECTED_APPS_PATH,
  createGoogleConnectedAppsVerification,
  parseVerificationTokens,
} from "./google-connected-apps";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface Resp {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, urlPath: string, host: string, method = "GET"): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: { Host: host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function startApp(env: NodeJS.ProcessEnv): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(createGoogleConnectedAppsVerification(() => env));
  // Stand-ins for what index.ts mounts after it.
  app.use((req, res, next) => {
    const h = req.hostname;
    if (h === "opplevagent.no") {
      if (req.path.startsWith("/api/")) return next();
      return res.status(404).send("opplevagent 404");
    }
    if (h === "rettfrabonden.com" && req.path.startsWith("/.well-known/")) {
      return res.redirect(301, `https://opplevagent.no${req.originalUrl}`);
    }
    next();
  });
  app.use((_req, res) => res.status(200).type("text/html").send("<html>spa</html>"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const HOSTS = ["rettfrabonden.com", "opplevagent.no"];
const SECRET_LOOKING = "tok-should-not-leak-123";

export async function runGoogleConnectedAppsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = "") => {
    if (cond) {
      passed++;
      if (opts.log) console.log(`  ok   ${name}`);
    } else {
      failed++;
      failures.push(name + (detail ? ` — ${detail}` : ""));
      if (opts.log) console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const isRedirect = (s: number) => s >= 300 && s < 400;

  // ── parser ────────────────────────────────────────────────────────────
  check("parse: undefined → null", parseVerificationTokens(undefined) === null);
  check("parse: empty → null", parseVerificationTokens("   ") === null);
  check(
    "parse: JSON file form",
    JSON.stringify(parseVerificationTokens('{"verification_tokens":["abc","def"]}')) === '["abc","def"]',
  );
  check(
    "parse: comma list trims and drops empties",
    JSON.stringify(parseVerificationTokens(" abc , def,, ")) === '["abc","def"]',
  );
  check("parse: single token", JSON.stringify(parseVerificationTokens("abc")) === '["abc"]');
  check("parse: broken JSON → null", parseVerificationTokens('{"verification_tokens":["abc"') === null);
  check("parse: JSON without key → null", parseVerificationTokens('{"tokens":["abc"]}') === null);
  check("parse: JSON empty array → null", parseVerificationTokens('{"verification_tokens":[]}') === null);
  check("parse: JSON non-string token → null", parseVerificationTokens('{"verification_tokens":[1]}') === null);
  check("parse: bare JSON array → null", parseVerificationTokens('["abc"]') === null);
  check("parse: token with space → null", parseVerificationTokens("ab c,def") === null);
  check("parse: token with control char → null", parseVerificationTokens("ab\u0000c") === null);
  check("parse: overlong token → null", parseVerificationTokens("a".repeat(513)) === null);
  check("parse: too many tokens → null", parseVerificationTokens(Array.from({ length: 21 }, (_, i) => `t${i}`).join(",")) === null);

  const scenarios: Array<{ name: string; env: NodeJS.ProcessEnv; run: (port: number) => Promise<void> }> = [];

  // ── AK1: flag off ─────────────────────────────────────────────────────
  for (const flag of [undefined, "", "0", "false", "yes", "TRUE"]) {
    scenarios.push({
      name: `AK1 flag=${JSON.stringify(flag)}`,
      env: {
        ...(flag === undefined ? {} : { GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: flag }),
        GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: SECRET_LOOKING,
      },
      run: async (port) => {
        for (const host of HOSTS) {
          const r = await request(port, GOOGLE_CONNECTED_APPS_PATH, host);
          check(`AK1 flag=${JSON.stringify(flag)} ${host}: 404`, r.status === 404, `got ${r.status}`);
          check(`AK1 flag=${JSON.stringify(flag)} ${host}: no token in body`, !r.text.includes(SECRET_LOOKING));
        }
      },
    });
  }

  // ── AK2: flag on, JSON form ──────────────────────────────────────────
  for (const flag of ["1", "true"]) {
    scenarios.push({
      name: `AK2 JSON flag=${flag}`,
      env: {
        GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: flag,
        GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: '{"verification_tokens":["tokA","tokB"]}',
      },
      run: async (port) => {
        for (const host of HOSTS) {
          for (const method of ["GET", "HEAD"]) {
            const r = await request(port, GOOGLE_CONNECTED_APPS_PATH, host, method);
            check(`AK2 JSON flag=${flag} ${host} ${method}: 200`, r.status === 200, `got ${r.status}`);
            check(`AK2 JSON flag=${flag} ${host} ${method}: not a redirect`, !isRedirect(r.status) && !r.headers.location);
            check(
              `AK2 JSON flag=${flag} ${host} ${method}: application/json`,
              String(r.headers["content-type"] || "").startsWith("application/json"),
              String(r.headers["content-type"]),
            );
            if (method === "GET") {
              let body: any = null;
              try { body = JSON.parse(r.text); } catch { /* fails below */ }
              check(
                `AK2 JSON flag=${flag} ${host}: exact tokens`,
                JSON.stringify(body) === '{"verification_tokens":["tokA","tokB"]}',
                r.text,
              );
            }
          }
        }
      },
    });
  }

  // ── AK2: comma list ──────────────────────────────────────────────────
  scenarios.push({
    name: "AK2 comma list",
    env: {
      GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: "1",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: "tok1, tok2",
    },
    run: async (port) => {
      for (const host of HOSTS) {
        const r = await request(port, GOOGLE_CONNECTED_APPS_PATH, host);
        check(`AK2 comma ${host}: 200`, r.status === 200, `got ${r.status}`);
        check(`AK2 comma ${host}: exact tokens`, r.text === '{"verification_tokens":["tok1","tok2"]}', r.text);
      }
    },
  });

  // ── per-host opplevagent value, with fallback ───────────────────────
  scenarios.push({
    name: "per-host opplevagent value",
    env: {
      GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: "1",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: "rfbTok",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS_OPPLEVAGENT: '{"verification_tokens":["oaTok"]}',
    },
    run: async (port) => {
      const a = await request(port, GOOGLE_CONNECTED_APPS_PATH, "rettfrabonden.com");
      check("per-host: rettfrabonden.com gets shared tokens", a.status === 200 && a.text === '{"verification_tokens":["rfbTok"]}', a.text);
      const b = await request(port, GOOGLE_CONNECTED_APPS_PATH, "opplevagent.no");
      check("per-host: opplevagent.no gets its own tokens", b.status === 200 && b.text === '{"verification_tokens":["oaTok"]}', b.text);
    },
  });
  scenarios.push({
    name: "per-host only opplevagent set",
    env: {
      GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: "1",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS_OPPLEVAGENT: "oaOnly",
    },
    run: async (port) => {
      const a = await request(port, GOOGLE_CONNECTED_APPS_PATH, "rettfrabonden.com");
      check("per-host only-oa: rettfrabonden.com 404", a.status === 404, `got ${a.status}`);
      const b = await request(port, GOOGLE_CONNECTED_APPS_PATH, "opplevagent.no");
      check("per-host only-oa: opplevagent.no 200", b.status === 200 && b.text === '{"verification_tokens":["oaOnly"]}', b.text);
    },
  });
  scenarios.push({
    name: "per-host opplevagent invalid → 404 (no silent fallback)",
    env: {
      GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: "1",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: "rfbTok",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS_OPPLEVAGENT: "{broken",
    },
    run: async (port) => {
      const b = await request(port, GOOGLE_CONNECTED_APPS_PATH, "opplevagent.no");
      check("per-host invalid oa: opplevagent.no 404", b.status === 404, `got ${b.status}`);
      check("per-host invalid oa: no env echoed", !b.text.includes("broken") && !b.text.includes("rfbTok"));
      const a = await request(port, GOOGLE_CONNECTED_APPS_PATH, "rettfrabonden.com");
      check("per-host invalid oa: rettfrabonden.com still 200", a.status === 200, `got ${a.status}`);
    },
  });

  // ── flag on, value missing / invalid → 404 ──────────────────────────
  const badValues: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["empty", ""],
    ["broken JSON", `{"verification_tokens":["${SECRET_LOOKING}"`],
    ["wrong key", `{"tokens":["${SECRET_LOOKING}"]}`],
    ["empty array", '{"verification_tokens":[]}'],
    ["space in token", `${SECRET_LOOKING} x`],
  ];
  for (const [label, value] of badValues) {
    scenarios.push({
      name: `invalid ${label}`,
      env: {
        GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: "1",
        ...(value === undefined ? {} : { GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: value }),
      },
      run: async (port) => {
        for (const host of HOSTS) {
          const r = await request(port, GOOGLE_CONNECTED_APPS_PATH, host);
          check(`invalid ${label} ${host}: 404`, r.status === 404, `got ${r.status}`);
          check(`invalid ${label} ${host}: no env echoed`, !r.text.includes(SECRET_LOOKING));
        }
      },
    });
  }

  // ── fall-through: other paths / hosts / methods unchanged ────────────
  scenarios.push({
    name: "fall-through",
    env: {
      GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED: "1",
      GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS: "tokX",
    },
    run: async (port) => {
      const json = await request(port, GOOGLE_CONNECTED_APPS_PATH + ".json", "rettfrabonden.com");
      check("fall-through: .json variant not served by us (downstream 301)", json.status === 301, `got ${json.status}`);
      const other = await request(port, "/.well-known/agent-card.json", "opplevagent.no");
      check("fall-through: other well-known on opplevagent.no still downstream 404", other.status === 404 && other.text === "opplevagent 404");
      const foreign = await request(port, GOOGLE_CONNECTED_APPS_PATH, "finn-tannlege.com");
      check("fall-through: other host not served by us", foreign.status === 200 && foreign.text.includes("spa"));
      const www = await request(port, GOOGLE_CONNECTED_APPS_PATH, "www.opplevagent.no");
      check("fall-through: www host not served by us", !www.text.includes("tokX"));
      const post = await request(port, GOOGLE_CONNECTED_APPS_PATH, "rettfrabonden.com", "POST");
      check("fall-through: POST not served by us", post.status === 301 && !post.text.includes("tokX"), `got ${post.status}`);
      const query = await request(port, GOOGLE_CONNECTED_APPS_PATH + "?x=1", "rettfrabonden.com");
      check("fall-through: query string still served", query.status === 200 && query.text === '{"verification_tokens":["tokX"]}');
      const upper = await request(port, GOOGLE_CONNECTED_APPS_PATH, "OpplevAgent.no");
      check("host match is case-insensitive", upper.status === 200, `got ${upper.status}`);
    },
  });

  for (const s of scenarios) {
    const srv = await startApp(s.env);
    try {
      await s.run(srv.port);
    } catch (err: any) {
      check(`${s.name}: no throw`, false, String(err?.message || err));
    } finally {
      await srv.close();
    }
  }

  // ── src/index.ts mount order ─────────────────────────────────────────
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    const mount = src.indexOf("app.use(googleConnectedAppsVerification);");
    check("index.ts mounts googleConnectedAppsVerification once", mount > 0 && src.indexOf("app.use(googleConnectedAppsVerification);", mount + 1) === -1);
    const later = [
      ["agentplatform host gate", "app.use(createAgentplatformHostGate());"],
      ["opplevagent.no host gate", 'const EXPERIENCES_HOSTS = new Set(["opplevagent.no"'],
      ["finn-tannlege host gate", "https://finn-tannlege.com${req.originalUrl}"],
      ["express.static", "app.use(express.static("],
      ["agentReadinessRoutes", 'app.use("/", agentReadinessRoutes);'],
    ];
    for (const [label, needle] of later) {
      const at = src.indexOf(needle);
      check(`index.ts: mounted before ${label}`, at > 0 && mount > 0 && mount < at, `mount=${mount} ${label}=${at}`);
    }
  } catch (err: any) {
    check("index.ts mount order: readable", false, String(err?.message || err));
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runGoogleConnectedAppsTests({ log: true }).then((r) => {
    console.log(`\ngoogle-connected-apps: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

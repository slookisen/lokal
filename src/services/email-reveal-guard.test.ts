/**
 * email-reveal-guard.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 1.
 *
 *   S   the switch per host (default off) and the limit from the env
 *   C   CCBot by User-Agent, any case
 *   L   the limit: distinct profiles, repeat views free, a list counts each
 *       profile, the rest of a list over the limit gets nothing
 *   W   the sliding hour (injected clock)
 *   K   one counter per host and client; IPv6 grouped per /56; keys hashed
 *   M   the memory bound (client cap, least recently seen evicted, sweep)
 *   R   revealEmailFor: switch off = null (no-op, also for CCBot); CCBot and
 *       a missing IP get nothing; the log line has counts and ids only
 *
 * No DB, no HTTP. Standalone: npx tsx src/services/email-reveal-guard.test.ts
 * Wired into tests/test.ts via runEmailRevealGuardTests().
 */

import {
  EMAIL_REVEAL_DEFAULT_LIMIT,
  EmailRevealStore,
  emailRevealBaseLimit,
  emailRevealGuardEnabled,
  isCcBotUserAgent,
  revealEmailFor,
  __resetEmailRevealGuardForTesting,
} from "./email-reveal-guard";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runEmailRevealGuardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  const sorted = (s: ReadonlySet<string> | null) => (s === null ? null : [...s].sort());

  const envKeys = ["EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_GUARD_EXPERIENCES", "EMAIL_REVEAL_PER_IP_PER_HOUR"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  try {
    // ── S: switch and limit ──────────────────────────────────────────────
    eq(emailRevealGuardEnabled("dental", {}), false, "S1: no env -> off (default)");
    for (const v of ["on", "1", "true", " ON ", "True"]) {
      eq(emailRevealGuardEnabled("dental", { EMAIL_REVEAL_GUARD_DENTAL: v }), true, `S2: ${JSON.stringify(v)} -> on`);
    }
    for (const v of ["off", "0", "false", "", "yes", "enabled"]) {
      eq(emailRevealGuardEnabled("dental", { EMAIL_REVEAL_GUARD_DENTAL: v }), false, `S3: ${JSON.stringify(v)} -> off`);
    }
    eq(
      [emailRevealGuardEnabled("rfb", { EMAIL_REVEAL_GUARD_DENTAL: "on" }), emailRevealGuardEnabled("experiences", { EMAIL_REVEAL_GUARD_DENTAL: "on" }),
        emailRevealGuardEnabled("rfb", { EMAIL_REVEAL_GUARD_RFB: "1" }), emailRevealGuardEnabled("experiences", { EMAIL_REVEAL_GUARD_EXPERIENCES: "1" })],
      [false, false, true, true],
      "S4: one switch per host"
    );
    eq(emailRevealBaseLimit({}), EMAIL_REVEAL_DEFAULT_LIMIT, "S5: no limit env -> 30");
    eq(EMAIL_REVEAL_DEFAULT_LIMIT, 30, "S5b: the default is 30");
    eq([emailRevealBaseLimit({ EMAIL_REVEAL_PER_IP_PER_HOUR: "5" }), emailRevealBaseLimit({ EMAIL_REVEAL_PER_IP_PER_HOUR: " 0 " })], [5, 0], "S6: a whole number is taken");
    for (const v of ["-1", "abc", "2.5", "1e3", "9999999"]) {
      eq(emailRevealBaseLimit({ EMAIL_REVEAL_PER_IP_PER_HOUR: v }), 30, `S7: ${JSON.stringify(v)} -> the default`);
    }

    // ── C: CCBot ─────────────────────────────────────────────────────────
    for (const ua of ["CCBot/2.0 (https://commoncrawl.org/faq/)", "ccbot", "Mozilla/5.0 (compatible; CCBot/3.1)"]) {
      eq(isCcBotUserAgent(ua), true, `C1: ${JSON.stringify(ua)} is CCBot`);
    }
    for (const ua of ["Mozilla/5.0", "GPTBot/1.0", "ClaudeBot/1.0", "", undefined, null]) {
      eq(isCcBotUserAgent(ua as string | undefined), false, `C2: ${JSON.stringify(ua)} is not CCBot`);
    }

    // ── L: the limit ─────────────────────────────────────────────────────
    let t = 1_000_000;
    const clock = () => t;
    {
      const s = new EmailRevealStore({ now: clock });
      const k = s.clientKey("203.0.113.7");
      eq(sorted(s.reveal("dental", k, ["a", "b"], 3)), ["a", "b"], "L1: under the limit -> all");
      eq(sorted(s.reveal("dental", k, ["a", "b", "a"], 3)), ["a", "b"], "L2: repeat views (and duplicates) count once");
      eq(sorted(s.reveal("dental", k, ["c", "d", "e"], 3)), ["c"], "L3: a list counts each profile; once at the limit the rest get nothing");
      eq(sorted(s.reveal("dental", k, ["a", "d"], 3)), ["a"], "L4: over the limit, a profile already counted is still free; a new one is not");
      eq(sorted(s.reveal("dental", k, [], 3)), [], "L5: an empty list");
      eq(sorted(new EmailRevealStore({ now: clock }).reveal("dental", k, ["a"], 0)), [], "L6: limit 0 -> nothing");
      const s2 = new EmailRevealStore({ now: clock });
      const ids = Array.from({ length: 200 }, (_, i) => `p${i}`);
      let got = 0;
      for (const id of ids) got += s2.reveal("dental", k, [id], 30).size;
      eq(got, 30, "L7: 200 profiles one by one from one IP -> e-mail in exactly 30 (AC1 at the guard)");
      eq(s2.reveal("dental", k, ids, 30).size, 30, "L8: ... and the same 200 as one list -> the same 30");
    }

    // ── W: the sliding hour ──────────────────────────────────────────────
    {
      t = 5_000_000;
      const s = new EmailRevealStore({ now: clock });
      const k = s.clientKey("198.51.100.2");
      s.reveal("dental", k, ["a"], 3);
      t += 30 * 60_000;
      s.reveal("dental", k, ["b", "c"], 3);
      t += 29 * 60_000;
      eq(sorted(s.reveal("dental", k, ["d"], 3)), [], "W1: 59 min after the first -> still at the limit");
      t += 60_000;
      eq(sorted(s.reveal("dental", k, ["d", "e"], 3)), ["d"], "W2: 60 min after «a» -> one slot free again (sliding, not a fixed hour)");
      eq(sorted(s.reveal("dental", k, ["a"], 3)), [], "W3: «a» left the window, so it counts anew (and the window is full)");
      t += 30 * 60_000;
      eq(sorted(s.reveal("dental", k, ["a", "x"], 3)), ["a", "x"], "W4: «b» and «c» left too -> two new slots");
    }

    // ── K: keys and hosts ────────────────────────────────────────────────
    {
      const s = new EmailRevealStore({ now: clock });
      const k1 = s.clientKey("203.0.113.9");
      const k2 = s.clientKey("203.0.113.10");
      s.reveal("dental", k1, ["a", "b"], 2);
      eq(sorted(s.reveal("dental", k2, ["c"], 2)), ["c"], "K1: another IP has its own count");
      eq(sorted(s.reveal("rfb", k1, ["c"], 2)), ["c"], "K2: another host has its own count");
      eq(sorted(s.reveal("dental", k1, ["c"], 2)), [], "K3: the same host and IP share one count (pages and APIs alike)");
      ok(!k1.includes("203.0.113.9") && /^[A-Za-z0-9_-]{16}$/.test(k1), "K4: the key is a fixed-size hash, never the IP");
      eq(s.clientKey("2001:db8:1:100::1") === s.clientKey("2001:db8:1:1ff::2"), true, "K5: IPv6 grouped per /56, as the rate limiters do");
      eq(new EmailRevealStore().clientKey("203.0.113.9") === k1, false, "K6: the salt is random per store (process)");
    }

    // ── M: memory ────────────────────────────────────────────────────────
    {
      t = 10_000_000;
      const s = new EmailRevealStore({ now: clock, maxClients: 3 });
      const keys = ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5"].map((ip) => s.clientKey(ip));
      s.reveal("dental", keys[0]!, ["a"], 1);
      s.reveal("dental", keys[1]!, ["a"], 1);
      s.reveal("dental", keys[2]!, ["a"], 1);
      s.reveal("dental", keys[0]!, ["a"], 1); // seen again: now the most recent
      s.reveal("dental", keys[3]!, ["a"], 1);
      eq(s.size("dental"), 3, "M1: never more clients than the cap");
      eq(sorted(s.reveal("dental", keys[0]!, ["b"], 1)), [], "M2: a recently seen client keeps its count");
      eq(sorted(s.reveal("dental", keys[1]!, ["b"], 1)), ["b"], "M3: the least recently seen was evicted (its count starts again)");
      const big = new EmailRevealStore({ now: clock, maxClients: 50 });
      for (let i = 0; i < 1000; i++) big.reveal("dental", big.clientKey(`10.0.${i >> 8}.${i & 255}`), ["a", "b", "c"], 30);
      eq(big.size("dental"), 50, "M4: 1000 clients through a cap of 50 -> 50 held");
      t += 61 * 60_000;
      big.reveal("dental", big.clientKey("198.51.100.200"), ["a"], 30);
      eq(big.size("dental"), 1, "M5: after the hour, the sweep drops every expired client");
      const s3 = new EmailRevealStore({ now: clock });
      s3.reveal("dental", s3.clientKey("192.0.2.9"), ["z"], 0);
      eq(s3.size("dental"), 0, "M6: a client given nothing is not held");
    }

    // ── R: revealEmailFor ────────────────────────────────────────────────
    {
      const lines: string[] = [];
      t = 20_000_000;
      __resetEmailRevealGuardForTesting({ now: clock, log: (l) => lines.push(l) });
      const req = (ip: string | undefined, ua?: string) => ({ ip, headers: ua === undefined ? {} : { "user-agent": ua } }) as any;
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "2";
      eq(revealEmailFor(req("203.0.113.1"), "dental", ["a"]), null, "R1: switch off -> null (the caller changes nothing)");
      eq(revealEmailFor(req("203.0.113.1", "CCBot/2.0"), "dental", ["a"]), null, "R2: switch off -> null also for CCBot");
      eq(lines.length, 0, "R3: switch off -> nothing logged");
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      eq(revealEmailFor(req("203.0.113.1", "CCBot/2.0 (https://commoncrawl.org/faq/)"), "dental", ["a", "b"]), new Set() as any, "R4: CCBot -> nothing, also on its first request");
      eq(sorted(revealEmailFor(req("203.0.113.1", "Mozilla/5.0"), "dental", ["a", "b", "c"])), ["a", "b"],
        "R5: the same IP as a browser -> its own limit applies (CCBot's request counted nothing)");
      eq(sorted(revealEmailFor(req(""), "dental", ["a"])), [], "R6: no usable IP -> fail closed (nothing)");
      eq(sorted(revealEmailFor(req(undefined), "dental", ["a"])), [], "R6b: ... also when req.ip is undefined");
      eq(sorted(revealEmailFor(req("203.0.113.1"), "rfb", ["a"])), null, "R7: the RFB switch is still off");
      eq(sorted(revealEmailFor(req("203.0.113.1"), "dental", [])), [], "R8: switch on, no profile with e-mail -> empty, not null");
      const parsed = lines.map((l) => JSON.parse(l));
      eq(parsed.map((p) => [p.evt, p.reason, p.revealed, p.withheld]), [
        ["email_reveal_withheld", "ccbot", 0, 2],
        ["email_reveal_withheld", "limit", 2, 1],
        ["email_reveal_withheld", "no_ip", 0, 1],
        ["email_reveal_withheld", "no_ip", 0, 1],
      ], "R9: one log line per request with e-mail withheld: reason and counts");
      eq(parsed[1].profile_ids, ["c"], "R10: ... with the withheld profile ids");
      ok(lines.every((l) => !l.includes("@") && !l.includes("203.0.113")), "R11: no e-mail address and no IP in any log line");
      lines.length = 0;
      revealEmailFor(req("203.0.113.50"), "dental", Array.from({ length: 12 }, (_, i) => `id${i}`));
      eq(JSON.parse(lines[0]!).profile_ids.length, 5, "R12: at most five ids per log line");
    }
  } catch (err: any) {
    failed++;
    failures.push("email reveal guard: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    __resetEmailRevealGuardForTesting();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── email reveal guard (dev-request 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 1) ──");
  runEmailRevealGuardTests({ log: true }).then((r) => {
    console.log(`\nemail reveal guard: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

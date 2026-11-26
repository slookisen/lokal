/**
 * Testmiljø: the one switch.
 *
 * dev-request 2026-11-25-testmiljo-lokal-kopi-med-testdata-foer-prodsetting.
 *
 * The test environment is this same server started on a developer machine
 * against seeded databases. It adds things production must never have: a page
 * that logs you in as an owner without the e-mailed link, an outbox that
 * captures e-mail instead of sending it, and local host names for the three
 * sites. Every one of them asks isTestmiljo(), and isTestmiljo() is false in
 * production whatever TESTMILJO says.
 *
 * TESTMILJO set in production is ignored, and boot.ts logs one error line
 * saying so. It does not stop the process: a mistyped secret must not take
 * three sites down (Daniel, 2026-11-26). On a developer machine a wrong
 * set-up does refuse to start (assertTestmiljoBootSafe, called first thing
 * from src/testmiljo/boot.ts): a value other than 1, mail credentials present,
 * no own database files, or a network listen address.
 *
 * No imports from the rest of the app: this module is loaded before anything
 * else and must stay free of side effects.
 */

type Env = NodeJS.ProcessEnv;

export const TESTMILJO_ENV = "TESTMILJO";

function set(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

/** NODE_ENV=production or any Fly marker. Same rule as mayReturnDevClaimCode() and the gårdssalg test clock. */
export function isProductionLike(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" || set(env.FLY_APP_NAME) || set(env.FLY_MACHINE_ID) || set(env.FLY_ALLOC_ID);
}

/** TESTMILJO has any non-empty value (whether or not it is honoured). */
export function testmiljoVariableSet(env: Env = process.env): boolean {
  return set(env[TESTMILJO_ENV]);
}

/** True only for TESTMILJO=1 outside production. The single gate for every testmiljø behaviour. */
export function isTestmiljo(env: Env = process.env): boolean {
  return (env[TESTMILJO_ENV] ?? "").trim() === "1" && !isProductionLike(env);
}

/**
 * TESTMILJO set in production: the line boot.ts logs. null otherwise. The
 * variable has no effect there; this only makes the mistake visible.
 */
export function testmiljoProductionNotice(env: Env = process.env): string | null {
  if (!testmiljoVariableSet(env) || !isProductionLike(env)) return null;
  return "[testmiljo] TESTMILJO is set in production and is IGNORED: the test environment is off. Unset the variable.";
}

/**
 * Reasons this process must not start, or [] when it may. Always empty when
 * TESTMILJO is unset and always empty in production, so production boot never
 * depends on this variable.
 */
export function testmiljoBootProblems(env: Env = process.env): string[] {
  if (!testmiljoVariableSet(env)) return [];
  if (isProductionLike(env)) return [];
  const problems: string[] = [];
  if ((env[TESTMILJO_ENV] ?? "").trim() !== "1") {
    problems.push('TESTMILJO must be exactly "1" to turn the test environment on. Any other value is refused rather than ignored.');
    return problems;
  }
  // The outbox replaces the mail transport, so credentials are never used. A
  // test environment that holds them is still a mistake waiting to happen.
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) {
    if (set(env[key])) problems.push(`${key} is set. The test environment never holds mail credentials; unset it.`);
  }
  // Unset, these fall back to ./data/lokal.db and /app/data/<vertical>.db: a
  // developer's real local data, or C:\app\data on Windows.
  for (const key of ["DB_PATH", "DENTAL_DB_PATH", "EXPERIENCES_DB_PATH"]) {
    if (!set(env[key])) problems.push(`${key} is not set. The test environment needs its own database files.`);
  }
  // src/index.ts listens on HOST (default 0.0.0.0). boot.ts defaults it to
  // 127.0.0.1 here; a value that opens the port to the network is refused.
  if (set(env.HOST) && !isLoopbackBindHost(env.HOST ?? "")) {
    problems.push(`HOST=${(env.HOST ?? "").trim()} would open the test environment to the network. Leave it unset or use 127.0.0.1.`);
  }
  return problems;
}

/** A listen address that only this machine can reach. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Throws with every reason when the process must not start. */
export function assertTestmiljoBootSafe(env: Env = process.env): void {
  const problems = testmiljoBootProblems(env);
  if (problems.length === 0) return;
  throw new Error(`[testmiljo] refusing to start:\n  - ${problems.join("\n  - ")}`);
}

/** The TCP peer is this machine. Reads the socket, never a forwarding header. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

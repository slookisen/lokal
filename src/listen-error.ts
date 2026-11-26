/**
 * Listen-error handling for the HTTP server (dev-request 2026-11-26-app-listen-feil-ignoreres).
 *
 * Express 5's `app.listen(port, host, cb)` registers `cb` once on the server's
 * "error" event and also as the "listening" callback, wrapped in once(): a
 * listen failure (EADDRINUSE, EACCES) arrives as the callback's first argument,
 * exactly once. Ignoring it prints the banner and runs the startup work for a
 * server that is not listening, and the process stays alive.
 */
export function handleListenError(
  err: unknown,
  host: string,
  port: number | string,
  exit: (code: number) => void = (c) => process.exit(c),
  log: (line: string) => void = (l) => console.error(l),
): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  log(`[startup] listen failed on ${host}:${port}: ${e.code ?? "ERR"} ${e.message ?? String(err)}`);
  exit(1);
  return true;
}

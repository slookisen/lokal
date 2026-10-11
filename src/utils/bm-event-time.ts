// Bondens marked event times: the scraper stores the site's schema.org
// startDate/endDate verbatim, but bondensmarked.no writes Europe/Oslo LOCAL
// wall-clock time and labels it "+00:00". Public outputs (JSON-LD, API, MCP)
// pass every BM start/end through this ONE helper so the offset is honest.
// Pure, no dependencies. Only a trailing "Z" / "+00:00" is touched; any other
// offset (or a non-ISO value) is returned unchanged.

const UTC_LABELLED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})((?::\d{2})(?:\.\d+)?)?(?:Z|\+00:00)$/;

/** UTC ms of the last Sunday of `month` (0-based) at 01:00 UTC (EU DST switch). */
function euSwitchUtcMs(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const day = lastDay.getUTCDate() - lastDay.getUTCDay();
  return Date.UTC(year, month, day, 1, 0, 0);
}

export function normalizeBmEventTime<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string") return value;
  const m = UTC_LABELLED.exec(value);
  if (!m) return value;
  const [, y, mo, d, h, mi, rest] = m;
  const wallMs = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, 0);
  if (Number.isNaN(wallMs)) return value;
  // Summer time (+02:00) iff the instant (wall - 2h) lies in [last Sun Mar 01:00Z, last Sun Oct 01:00Z).
  // A wall time in the spring gap or the autumn overlap resolves deterministically.
  const instant = wallMs - 2 * 3600_000;
  const summer = instant >= euSwitchUtcMs(+y!, 2) && instant < euSwitchUtcMs(+y!, 9);
  return `${y}-${mo}-${d}T${h}:${mi}${rest ?? ""}${summer ? "+02:00" : "+01:00"}` as T;
}

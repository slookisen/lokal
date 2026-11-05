/**
 * gardssalg-mine-besok.test.ts — dev-request 2026-10-22-opplevagent-mine-valg-
 * gardssalg, slice O3: «Mine besøk» as a pure render function.
 *
 * Covers: the upcoming/past split around `now` and ordering; per-state action
 * visibility (Bekreft/Foreslå annen tid/Avslå only while the e-mail answer
 * link would accept them; Møtte/Ikke møtt only on a confirmed visit whose time
 * has passed); actions post to the SAME endpoints and form fields as the
 * e-mail pages; escaping of hostile guest input; empty states; purity (no
 * mutation of the input = nothing confirmed automatically); no mention of the
 * other platform.
 *
 * Exported runGardssalgMineBesokTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/owner-features/gardssalg-mine-besok.test.ts
 */

import fs from "fs";
import path from "path";
import type { GardssalgBooking } from "../services/booking-store";
import {
  renderGardssalgMineBesok,
  mineBesokActions,
  mineBesokStatusText,
  splitMineBesok,
} from "./gardssalg-mine-besok";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-10T12:00:00.000Z");
const HOUR = 3600_000;
const at = (offsetHours: number): string => new Date(NOW.getTime() + offsetHours * HOUR).toISOString();

let seq = 0;
function booking(over: Partial<GardssalgBooking> = {}): GardssalgBooking {
  seq++;
  return {
    booking_id: `bid-${seq}`,
    experience_id: null,
    provider_id: "prov-1",
    slot_at: at(48),
    party_size: 2,
    guest_name: "Kari Nordmann",
    guest_email: "kari@example.no",
    guest_phone: null,
    booking_ref: `GS-${String(seq).padStart(4, "0")}`,
    confirm_token: `ctok${seq}`,
    source: "web",
    status: "reserved",
    resolved_by: null,
    resolved_at: null,
    commission_rate: null,
    billable: 0,
    notes: null,
    created_at: at(-24),
    pre_status: "awaiting_provider",
    respond_token: `rtok${seq}`,
    respond_token_expires_at: at(24),
    respond_token_used_at: null,
    suggested_slot_at: null,
    guest_decision_token: null,
    guest_status_token: `gtok${seq}`,
    reminder_sent_at: null,
    expired_guest_notified_at: null,
    is_test: 0,
    ...over,
  };
}

/** The <li> card for one booking ref. */
function card(html: string, ref: string): string {
  const start = html.indexOf(`data-booking-ref="${ref}"`);
  if (start < 0) return "";
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return "";
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

export async function runGardssalgMineBesokTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = ""): void => {
    if (cond) {
      passed++;
      if (log) console.log(`  ✓ ${name}`);
    } else {
      failed++;
      failures.push(detail ? `${name} — ${detail}` : name);
      if (log) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  // ── split + ordering ────────────────────────────────────────────────────
  {
    const soon = booking({ slot_at: at(2) });
    const later = booking({ slot_at: at(72) });
    const justPast = booking({ slot_at: at(-1), pre_status: "provider_confirmed", respond_token_used_at: at(-20) });
    const longAgo = booking({ slot_at: at(-200), status: "confirmed_attended" });
    const broken = booking({ slot_at: "ikke-en-dato" });
    const { kommende, tidligere } = splitMineBesok([longAgo, later, broken, justPast, soon], NOW);
    check("split: upcoming = after now, soonest first", same(kommende.map((b) => b.booking_ref), [soon.booking_ref, later.booking_ref]));
    check(
      "split: past = at/before now, most recent first, unparseable last",
      same(tidligere.map((b) => b.booking_ref), [justPast.booking_ref, longAgo.booking_ref, broken.booking_ref]),
    );
    const exactlyNow = booking({ slot_at: NOW.toISOString() });
    check("split: a visit exactly at now is past", splitMineBesok([exactlyNow], NOW).tidligere.length === 1);
    const naked = booking({ slot_at: "2026-11-10T12:30" }); // Oslo 12:30 = 11:30Z → past
    check("split: naked datetime-local read as Oslo wall time", splitMineBesok([naked], NOW).tidligere.length === 1);

    const html = renderGardssalgMineBesok([longAgo, later, soon, justPast], NOW);
    const k = section(html, "besok-kommende");
    const t = section(html, "besok-tidligere");
    check("render: upcoming cards in «Kommende» in order", k.indexOf(soon.booking_ref) >= 0 && k.indexOf(soon.booking_ref) < k.indexOf(later.booking_ref));
    check("render: past cards in «Tidligere» in order", t.indexOf(justPast.booking_ref) >= 0 && t.indexOf(justPast.booking_ref) < t.indexOf(longAgo.booking_ref));
    check("render: no past card in «Kommende»", !k.includes(longAgo.booking_ref) && !k.includes(justPast.booking_ref));
    check("render: section headings", html.includes(">Kommende</h3>") && html.includes(">Tidligere</h3>"));
  }

  // ── date/time, party size, guest contact as the producer e-mail shows it ─
  {
    const b = booking({ slot_at: "2026-11-12T12:00:00.000Z", party_size: 1, guest_phone: "+47 900 00 000", notes: "Vi kommer med sykkel" });
    const html = card(renderGardssalgMineBesok([b], NOW), b.booking_ref);
    check("card: Oslo date/time in Norwegian", html.includes("torsdag 12. november 2026 kl. 13:00"), html);
    check("card: party size singular", html.includes("1 person<") && !html.includes("1 personer"));
    check("card: guest name, e-mail, phone, comment", ["Kari Nordmann", "kari@example.no", "+47 900 00 000", "Vi kommer med sykkel"].every((s) => html.includes(s)));
    const b2 = booking({ party_size: 4 });
    check("card: party size plural", card(renderGardssalgMineBesok([b2], NOW), b2.booking_ref).includes("4 personer"));
    check("card: no phone row when none", !card(renderGardssalgMineBesok([b2], NOW), b2.booking_ref).includes("Telefon:"));
  }

  // ── per-state actions ───────────────────────────────────────────────────
  {
    const pending = booking();
    check("pending: Bekreft / Foreslå / Avslå", same(mineBesokActions(pending, NOW), ["bekreft", "foresla", "avsla"]));
    check("pending: status text", mineBesokStatusText(pending, NOW) === "Venter på svaret ditt");
    const html = card(renderGardssalgMineBesok([pending], NOW), pending.booking_ref);
    const svar = `action="/kategori/gardssalg/svar/${pending.respond_token}"`;
    check("pending: forms post to the e-mail answer endpoint", (html.match(new RegExp(svar.replace(/[/]/g, "\\/"), "g")) || []).length === 3, html);
    check("pending: same action values as the svar page", ['value="bekreft"', 'value="foresla"', 'value="avsla"'].every((s) => html.includes(s)));
    check("pending: suggested time field has the svar page's name", html.includes('name="suggested_slot" type="datetime-local" required'));
    check("pending: all forms are POST", !/method="GET"/i.test(html) && html.includes('method="POST"'));
    check("pending: no attendance buttons", !html.includes('value="attended"') && !html.includes('value="no_show"'));
    check("pending: labels", [">Bekreft<", ">Foreslå annen tid<", ">Avslå<"].every((s) => html.includes(s)));
    check("pending: never the guest's tokens", !html.includes(pending.guest_status_token!));

    const pendingPast = booking({ slot_at: at(-3), respond_token_expires_at: at(5) });
    check("pending past its time: answer actions only, no attendance", same(mineBesokActions(pendingPast, NOW), ["bekreft", "foresla", "avsla"]));

    const expiredTok = booking({ respond_token_expires_at: at(-1) });
    check("deadline passed: no actions", mineBesokActions(expiredTok, NOW).length === 0);
    check("deadline passed: status", mineBesokStatusText(expiredTok, NOW) === "Utløpt – ikke besvart i tide");
    const expired = booking({ pre_status: "expired" });
    check("expired: no actions", mineBesokActions(expired, NOW).length === 0);

    const suggested = booking({ pre_status: "time_suggested", suggested_slot_at: at(30), guest_decision_token: "gdec1" });
    check("time_suggested: Foreslå / Avslå, no Bekreft", same(mineBesokActions(suggested, NOW), ["foresla", "avsla"]));
    const sHtml = card(renderGardssalgMineBesok([suggested], NOW), suggested.booking_ref);
    check("time_suggested: suggested time shown", sHtml.includes("Foreslått tid:"));
    check("time_suggested: guest decision token never shown", !sHtml.includes("gdec1"));

    const confirmedUpcoming = booking({ pre_status: "provider_confirmed", respond_token_used_at: at(-2) });
    check("confirmed, upcoming: no actions", mineBesokActions(confirmedUpcoming, NOW).length === 0);
    check("confirmed, upcoming: status", mineBesokStatusText(confirmedUpcoming, NOW) === "Bekreftet");

    const confirmedPast = booking({ slot_at: at(-2), pre_status: "provider_confirmed", respond_token_used_at: at(-30) });
    check("confirmed, past: Møtte / Ikke møtt", same(mineBesokActions(confirmedPast, NOW), ["attended", "no_show"]));
    const cpHtml = card(renderGardssalgMineBesok([confirmedPast], NOW), confirmedPast.booking_ref);
    check(
      "confirmed, past: forms post to the e-mail attendance endpoint",
      cpHtml.includes(`action="/kategori/gardssalg/bekreft/${confirmedPast.confirm_token}"`) &&
        cpHtml.includes('value="attended"') && cpHtml.includes('value="no_show"') &&
        cpHtml.includes(">Møtte<") && cpHtml.includes(">Ikke møtt<"),
      cpHtml,
    );
    check("confirmed, past: no answer actions", !cpHtml.includes("/kategori/gardssalg/svar/"));

    const declinedPast = booking({ slot_at: at(-2), pre_status: "provider_declined", respond_token_used_at: at(-30) });
    check("declined: no actions (also not attendance)", mineBesokActions(declinedPast, NOW).length === 0);
    check("declined: status", mineBesokStatusText(declinedPast, NOW) === "Avslått");

    const attended = booking({ slot_at: at(-50), status: "confirmed_attended", pre_status: "provider_confirmed" });
    const noShow = booking({ slot_at: at(-50), status: "no_show", pre_status: "provider_confirmed" });
    const cancelled = booking({ status: "cancelled" });
    check("attended: no actions + «Møtte»", mineBesokActions(attended, NOW).length === 0 && mineBesokStatusText(attended, NOW) === "Møtte");
    check("no_show: no actions + «Ikke møtt»", mineBesokActions(noShow, NOW).length === 0 && mineBesokStatusText(noShow, NOW) === "Ikke møtt");
    check("cancelled: no actions + «Kansellert»", mineBesokActions(cancelled, NOW).length === 0 && mineBesokStatusText(cancelled, NOW) === "Kansellert");
    check("cancelled: card has no forms", !card(renderGardssalgMineBesok([cancelled], NOW), cancelled.booking_ref).includes("<form"));

    const legacyPast = booking({ slot_at: at(-5), respond_token: null, respond_token_expires_at: null });
    const legacyUpcoming = booking({ respond_token: null, respond_token_expires_at: null });
    check("legacy row, past: attendance only", same(mineBesokActions(legacyPast, NOW), ["attended", "no_show"]));
    check("legacy row, upcoming: no actions", mineBesokActions(legacyUpcoming, NOW).length === 0);
  }

  // ── escaping ────────────────────────────────────────────────────────────
  {
    const evil = booking({
      guest_name: `<script>alert("x")</script>`,
      guest_email: `a"><img src=x onerror=alert(1)>@x.no`,
      guest_phone: `<b>tlf</b>`,
      notes: `'><svg onload=alert(2)>`,
      booking_ref: `GS-<i>9</i>`,
      respond_token: `r"tok/../x`,
    });
    const html = renderGardssalgMineBesok([evil], NOW);
    check("escape: no raw script tag", !html.includes("<script>"));
    check("escape: name escaped", html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
    check("escape: no raw img/svg/b/i tags", !/<img|<svg|<b>|<i>/.test(html));
    check("escape: e-mail and notes escaped", html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("&#039;&gt;&lt;svg onload=alert(2)&gt;"));
    check("escape: token URL-encoded in the form action", html.includes(`/kategori/gardssalg/svar/r%22tok%2F..%2Fx`));
  }

  // ── empty states ────────────────────────────────────────────────────────
  {
    const html = renderGardssalgMineBesok([], NOW);
    check("empty: both empty texts", html.includes("Ingen kommende besøk.") && html.includes("Ingen tidligere besøk."));
    check("empty: no list", !html.includes("<li"));
    const onlyPast = renderGardssalgMineBesok([booking({ slot_at: at(-5) })], NOW);
    check("empty: only «Kommende» empty when all are past", onlyPast.includes("Ingen kommende besøk.") && !onlyPast.includes("Ingen tidligere besøk."));
  }

  // ── purity / never automatic ────────────────────────────────────────────
  {
    const rows = [booking(), booking({ slot_at: at(-2), pre_status: "provider_confirmed" })];
    const before = JSON.stringify(rows);
    const h1 = renderGardssalgMineBesok(rows, NOW);
    const h2 = renderGardssalgMineBesok(rows, NOW);
    check("pure: input rows unchanged (nothing confirmed by rendering)", JSON.stringify(rows) === before);
    check("pure: same input → same output", h1 === h2);
    check("pure: pending row still shows «Venter på svaret ditt»", h1.includes("Venter på svaret ditt"));
  }

  // ── no mention of the other platform ────────────────────────────────────
  {
    const all = renderGardssalgMineBesok(
      [booking(), booking({ slot_at: at(-2), pre_status: "provider_confirmed" }), booking({ status: "cancelled" })],
      NOW,
    ) + renderGardssalgMineBesok([], NOW);
    const src = fs.readFileSync(path.join(__dirname, "gardssalg-mine-besok.ts"), "utf8");
    const re = /rett\s*fra\s*bonden|rettfrabonden/i;
    check("copy: no «Rett fra Bonden» in the output", !re.test(all));
    check("copy: no «Rett fra Bonden» in the module", !re.test(src));
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runGardssalgMineBesokTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) process.exit(1);
  });
}

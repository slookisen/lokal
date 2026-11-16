/**
 * gardssalg-attendance-guard.test.ts — O1-4 (audit findings R6, R7, R8).
 *
 * Covers:
 *   (t) text pack OA-1 §3, verbatim.
 *   (u) pure helpers: visitConfirmedByProducer / attendanceRefusal for every
 *       pre_status and a legacy row, the filled attendance.notConfirmed,
 *       deadlineAfterSuggestion (48 h, never shorter), guestTokenMatches.
 *   (a) AK1: resolveBooking() refuses attendance on a declined, expired,
 *       awaiting or time_suggested row — status stays 'reserved' and
 *       `billable` stays 0; a row resolved before O1-4 cannot be switched to
 *       «Møtte»; a confirmed row and a legacy row still resolve. Route: POST
 *       /kategori/gardssalg/bekreft/:token → 303 ?error=not_confirmed, the
 *       page shows attendance.notConfirmed and no «Møtte»/«Ikke møtt».
 *   (d) R7: «Foreslå nytt tidspunkt» moves respond_token_expires_at to 48 h
 *       after the suggestion (never earlier); the svar page shows
 *       suggest.deadlineNote under the form.
 *   (g) AK2/R8: GET on the confirmation page with only the reference shows
 *       no guest name, e-mail or note (page.guestDataHidden instead); a wrong
 *       token likewise; the guest's token shows them. The .ics download
 *       without the token has no ATTENDEE / name / e-mail. POST /book returns
 *       guest_token; the no-JS redirect carries ?t=; the form script appends
 *       it. With GARDSSALG_HONEST_RECEIPT_ENABLED the status link (receipt.
 *       statusLink) is shown only with the token.
 *
 * Fixtures are test producers in an in-memory experiences DB (example.no
 * addresses); every e-mail send is stubbed. No real data is touched.
 *
 * Standalone: npx tsx src/services/gardssalg-attendance-guard.test.ts
 * Gate: tests/test.ts imports runGardssalgAttendanceGuardTests().
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** A whole UTC hour `days` ahead as an ISO instant. */
function slotAhead(days: number): string {
  const base = new Date(Date.now() + days * 24 * 3600_000);
  base.setUTCHours(11, 0, 0, 0);
  return base.toISOString();
}

export function runGardssalgAttendanceGuardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;
    delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-attendance-guard"),
      require.resolve("../routes/opplevelser"),
      require.resolve("../routes/experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    let server: http.Server | null = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const g = require("./gardssalg-attendance-guard") as typeof import("./gardssalg-attendance-guard");

      // ── (t) text pack OA-1 §3, verbatim (approved by Daniel 2026-11-15) ─
      // Do not "fix" these here: a mismatch means the code drifted.
      const OA1_S3 = {
        "attendance.notConfirmed": "Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er {status}.",
        "suggest.deadlineNote": "Gjesten får 48 timer på å svare på forslaget. Svarer ikke gjesten, utløper forespørselen.",
        "page.guestDataHidden": "Åpne lenken i e-posten du fikk for å se detaljene.",
      };
      assertEq(Object.keys(g.OA1_ATTENDANCE_TEXTS).sort(), Object.keys(OA1_S3).sort(), "t1: exactly the OA-1 §3 keys");
      for (const [k, v] of Object.entries(OA1_S3)) {
        const got = (g.OA1_ATTENDANCE_TEXTS as Record<string, { nb: string }>)[k].nb;
        assertTrue(Buffer.from(got, "utf8").equals(Buffer.from(v, "utf8")), `t2: ${k} (nb) byte-equal`);
      }
      assertEq(g.OA1_ATTENDANCE_TEXTS["page.guestDataHidden"].en, "Open the link in the email we sent you to see the details.", "t3: page.guestDataHidden (en) byte-equal");

      // ── (u) pure helpers ────────────────────────────────────────────────
      const r = (pre_status: string, respond_token: string | null = "rt") => ({ pre_status, respond_token }) as any;
      assertEq(g.visitConfirmedByProducer(r("provider_confirmed")), true, "u1: provider_confirmed -> confirmed");
      for (const pre of ["awaiting_provider", "time_suggested", "provider_declined", "expired"]) {
        assertEq(g.visitConfirmedByProducer(r(pre)), false, `u2: ${pre} -> not confirmed`);
      }
      assertEq(g.visitConfirmedByProducer(r("awaiting_provider", null)), true, "u3: legacy row (no respond_token) -> outside the loop, allowed (same rule as «Mine besøk»)");
      assertEq(
        ["provider_declined", "expired", "awaiting_provider", "time_suggested", "provider_confirmed"].map((p) => g.attendanceRefusal(r(p))),
        ["declined", "expired", "pending", "pending", null],
        "u4: refusal reason per pre_status",
      );
      assertEq(g.attendanceNotConfirmedText(r("provider_declined")), "Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er avslått.", "u5: notConfirmed filled (declined)");
      assertEq(g.attendanceNotConfirmedText(r("expired")), "Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er utløpt.", "u6: notConfirmed filled (expired)");
      assertEq(g.attendanceNotConfirmedText(r("awaiting_provider")), "Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er ikke bekreftet ennå.", "u7: notConfirmed filled (pending)");
      assertEq(g.attendanceNotConfirmedText(r("provider_confirmed")), "", "u8: no text when allowed");
      const now = new Date("2026-11-16T10:00:00.000Z");
      assertEq(g.SUGGESTION_ANSWER_HOURS, 48, "u9: 48 hours");
      assertEq(g.deadlineAfterSuggestion("2026-11-16T12:00:00.000Z", now), "2026-11-18T10:00:00.000Z", "u10: earlier deadline -> 48 h after the suggestion");
      assertEq(g.deadlineAfterSuggestion("2026-11-19T00:00:00.000Z", now), "2026-11-19T00:00:00.000Z", "u11: a later deadline is never shortened");
      assertEq(g.deadlineAfterSuggestion(null, now), "2026-11-18T10:00:00.000Z", "u12: no deadline -> 48 h");
      assertEq(g.deadlineAfterSuggestion("garbage", now), "2026-11-18T10:00:00.000Z", "u13: unparseable deadline -> 48 h");
      const tok = { guest_status_token: "abc123" };
      assertEq(g.guestTokenMatches(tok, "abc123"), true, "u14: right token matches");
      for (const bad of ["abc124", "abc12", "", undefined, null, ["abc123"], 123]) {
        assertEq(g.guestTokenMatches(tok, bad), false, `u15: ${JSON.stringify(bad)} does not match`);
      }
      assertEq(g.guestTokenMatches({ guest_status_token: null }, "anything"), false, "u16: a row without a guest token never matches");
      assertEq(g.guestTokenQuery(tok), "?t=abc123", "u17: ?t= query");
      assertEq(g.guestTokenQuery({ guest_status_token: null }), "", "u18: no token -> no query");

      // ── fixtures ────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence)
         VALUES ('ag-p1', 'Oppmøtetest AS', 'experiences', 'Vestland', 'Voss', 'sideri', 'post@ag-p1.example.no', 1, 0,
            'ag-test-p1', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      const store = require("./booking-store") as typeof import("./booking-store");
      emailSvc.sendEmail = async () => ({ success: true, messageId: "stub" });
      const settle = () => new Promise((res) => setTimeout(res, 30));
      const rowOf = (ref: string) => store.getBookingByRef(ref)!;
      const past = (name: string) => store.createBooking({
        provider_id: "ag-p1", slot_at: "2020-01-06T12:00", party_size: 2,
        guest_name: name, guest_email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.no`,
      });
      const setPre = (ref: string, pre: string) =>
        db.prepare("UPDATE gardssalg_bookings SET pre_status = ? WHERE booking_ref = ?").run(pre, ref);

      // ── (a) AK1: store level ────────────────────────────────────────────
      const declined = past("Avslatt Gjest");
      assertTrue(!!store.producerRespondDecline(String(declined.respond_token)), "a0: producer declines (svar loop)");
      for (const st of ["confirmed_attended", "no_show"] as const) {
        assertEq(store.resolveBooking(declined.confirm_token, st, "ag-test"), null, `a1: ${st} on a declined row -> refused`);
      }
      assertEq([rowOf(declined.booking_ref).status, rowOf(declined.booking_ref).billable, rowOf(declined.booking_ref).resolved_at], ["reserved", 0, null], "a2: declined row untouched, billable 0");

      const expired = past("Utlopt Gjest");
      setPre(expired.booking_ref, "expired"); // what the followup job writes
      assertEq(store.resolveBooking(expired.confirm_token, "confirmed_attended", "ag-test"), null, "a3: attended on an expired row -> refused");
      assertEq([rowOf(expired.booking_ref).status, rowOf(expired.booking_ref).billable], ["reserved", 0], "a4: expired row untouched, billable 0");

      const awaiting = past("Venter Gjest");
      assertEq(store.resolveBooking(awaiting.confirm_token, "confirmed_attended", "ag-test"), null, "a5: attended on an unanswered request -> refused");
      setPre(awaiting.booking_ref, "time_suggested");
      assertEq(store.resolveBooking(awaiting.confirm_token, "no_show", "ag-test"), null, "a6: no_show on time_suggested -> refused");
      assertEq([rowOf(awaiting.booking_ref).status, rowOf(awaiting.booking_ref).billable], ["reserved", 0], "a7: unconfirmed row untouched");

      // A row resolved before O1-4 on a declined request cannot become billable.
      const oldNoShow = past("Gammel Gjest");
      setPre(oldNoShow.booking_ref, "provider_declined");
      db.prepare("UPDATE gardssalg_bookings SET status = 'no_show' WHERE booking_ref = ?").run(oldNoShow.booking_ref);
      assertEq(store.resolveBooking(oldNoShow.confirm_token, "confirmed_attended", "ag-test"), null, "a8: no_show -> attended on a declined row refused");
      assertEq([rowOf(oldNoShow.booking_ref).status, rowOf(oldNoShow.booking_ref).billable], ["no_show", 0], "a9: billable stays 0");
      assertEq(store.reopenBooking(oldNoShow.confirm_token)?.status, "reserved", "a10: «Angre» still works on such a row (billable off)");

      const confirmed = past("Bekreftet Gjest");
      assertTrue(!!store.producerRespondConfirm(String(confirmed.respond_token)), "a11: producer confirms");
      const att = store.resolveBooking(confirmed.confirm_token, "confirmed_attended", "ag-test");
      assertEq([att?.status, att?.billable], ["confirmed_attended", 1], "a12: confirmed visit -> attended, billable 1 (unchanged behaviour)");
      const ns = store.resolveBooking(confirmed.confirm_token, "no_show", "ag-test");
      assertEq([ns?.status, ns?.billable], ["no_show", 0], "a13: correction to no_show still works");

      const legacy = past("Legacy Gjest");
      db.prepare("UPDATE gardssalg_bookings SET respond_token = NULL WHERE booking_ref = ?").run(legacy.booking_ref);
      assertEq(store.resolveBooking(legacy.confirm_token, "confirmed_attended", "ag-test")?.billable, 1, "a14: legacy row (no answer loop) still resolves");

      // ── server ──────────────────────────────────────────────────────────
      const app = express();
      app.use(express.json());
      app.use("/api/opplevelser", (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any);
      app.use((require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any);
      server = http.createServer(app);
      await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const postForm = async (path: string, form: Record<string, string>) => {
        const res = await fetch(`${base}${path}`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString(), redirect: "manual",
        });
        await res.text();
        await settle();
        return { status: res.status, location: res.headers.get("location") || "" };
      };
      const getText = async (path: string) => {
        const res = await fetch(`${base}${path}`);
        return { status: res.status, text: await res.text() };
      };

      // ── (a) AK1: route level ────────────────────────────────────────────
      const declined2 = past("Rute Avslatt");
      store.producerRespondDecline(String(declined2.respond_token));
      const bekreft = `/kategori/gardssalg/bekreft/${declined2.confirm_token}`;
      const pa = await postForm(bekreft, { action: "attended" });
      assertEq([pa.status, pa.location], [303, `${bekreft}?error=not_confirmed`], "a15: POST attended on a declined row -> 303 ?error=not_confirmed");
      assertEq([rowOf(declined2.booking_ref).status, rowOf(declined2.booking_ref).billable], ["reserved", 0], "a16: nothing written, billable 0");
      const pErr = await getText(`${bekreft}?error=not_confirmed`);
      assertTrue(pErr.text.includes("Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er avslått."), "a17: banner = attendance.notConfirmed (avslått)");
      assertTrue(!pErr.text.includes('value="attended"') && !pErr.text.includes('value="no_show"'), "a18: no «Møtte»/«Ikke møtt» buttons");
      const expired2 = past("Rute Utlopt");
      setPre(expired2.booking_ref, "expired");
      const pExp = await getText(`/kategori/gardssalg/bekreft/${expired2.confirm_token}`);
      assertTrue(pExp.text.includes("Denne forespørselen er utløpt.") && !pExp.text.includes('value="attended"'), "a19: expired row: notConfirmed text, no attendance buttons");
      const pns = await postForm(`/kategori/gardssalg/bekreft/${expired2.confirm_token}`, { action: "no_show" });
      assertTrue(pns.location.endsWith("?error=not_confirmed") && rowOf(expired2.booking_ref).status === "reserved", "a20: POST no_show on an expired row refused");
      const confirmed2 = past("Rute Bekreftet");
      store.producerRespondConfirm(String(confirmed2.respond_token));
      const pOk = await getText(`/kategori/gardssalg/bekreft/${confirmed2.confirm_token}`);
      assertTrue(pOk.text.includes('value="attended"') && !pOk.text.includes("Oppmøte kan bare føres"), "a21: confirmed past visit still offers «Møtte»");
      const pOkPost = await postForm(`/kategori/gardssalg/bekreft/${confirmed2.confirm_token}`, { action: "attended" });
      assertTrue(pOkPost.location.endsWith("?done=confirmed_attended") && rowOf(confirmed2.booking_ref).billable === 1, "a22: confirmed visit -> attended via the route, billable 1");

      // ── (d) R7: suggestion deadline ─────────────────────────────────────
      const sugg = store.createBooking({
        provider_id: "ag-p1", slot_at: slotAhead(10), party_size: 2, guest_name: "Forslag Gjest", guest_email: "forslag@example.no",
      });
      const t0 = new Date();
      db.prepare("UPDATE gardssalg_bookings SET respond_token_expires_at = ? WHERE booking_ref = ?")
        .run(new Date(t0.getTime() + 3600_000).toISOString(), sugg.booking_ref);
      const newSlot = slotAhead(12).slice(0, 16); // naked datetime-local, as the form sends
      const s1 = store.producerSuggestTime(String(sugg.respond_token), newSlot, t0);
      assertEq(s1?.pre_status, "time_suggested", "d1: suggestion stored");
      assertEq(s1?.respond_token_expires_at, new Date(t0.getTime() + 48 * 3600_000).toISOString(), "d2: deadline = 48 h after the suggestion");
      const later = new Date(t0.getTime() + 100 * 3600_000).toISOString();
      db.prepare("UPDATE gardssalg_bookings SET respond_token_expires_at = ? WHERE booking_ref = ?").run(later, sugg.booking_ref);
      const s2 = store.producerSuggestTime(String(sugg.respond_token), slotAhead(13).slice(0, 16), t0);
      assertEq(s2?.respond_token_expires_at, later, "d3: a re-suggestion never shortens a later deadline");
      const svar = await getText(`/kategori/gardssalg/svar/${sugg.respond_token}`);
      assertTrue(svar.text.includes(`<p class="hint">Gjesten får 48 timer på å svare på forslaget. Svarer ikke gjesten, utløper forespørselen.</p>\n    </form>`), "d4: svar page shows suggest.deadlineNote under the suggestion form");
      const viaRoute = store.createBooking({
        provider_id: "ag-p1", slot_at: slotAhead(10), party_size: 2, guest_name: "Rute Forslag", guest_email: "rute-forslag@example.no",
      });
      db.prepare("UPDATE gardssalg_bookings SET respond_token_expires_at = ? WHERE booking_ref = ?")
        .run(new Date(Date.now() + 3600_000).toISOString(), viaRoute.booking_ref);
      const before = Date.now();
      await postForm(`/kategori/gardssalg/svar/${viaRoute.respond_token}`, { action: "foresla", suggested_slot: slotAhead(11).slice(0, 16) });
      const exp = Date.parse(String(rowOf(viaRoute.booking_ref).respond_token_expires_at));
      assertTrue(rowOf(viaRoute.booking_ref).pre_status === "time_suggested" && exp >= before + 48 * 3600_000 && exp <= Date.now() + 48 * 3600_000,
        "d5: POST foresla via the svar page extends the deadline to 48 h");

      // ── (g) AK2/R8: guest data only with the guest's token ──────────────
      const bookRes = await fetch(`${base}/api/opplevelser/book`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider_id: "ag-p1", slot_at: slotAhead(9), party_size: 3,
          guest_name: "Kari Hemmelig", guest_email: "kari-hemmelig@example.no", notes: "Hemmelig notat",
        }),
      });
      const body: any = await bookRes.json();
      await settle();
      const gb = rowOf(body.booking_ref);
      assertEq([bookRes.status, body.guest_token], [201, gb.guest_status_token], "g1: POST /book 201 returns the guest's own token");
      const confirmPath = `/kategori/gardssalg/book/ag-test-p1/confirm/${encodeURIComponent(gb.booking_ref)}`;
      const refOnly = await getText(confirmPath);
      assertEq(refOnly.status, 200, "g2: page with only the reference still renders");
      assertTrue(!refOnly.text.includes("Kari Hemmelig"), "g3 (AK2): no guest name with only the reference");
      assertTrue(!refOnly.text.includes("kari-hemmelig@example.no"), "g4: no guest e-mail with only the reference");
      assertTrue(!refOnly.text.includes("Hemmelig notat"), "g5: no note with only the reference");
      assertTrue(!refOnly.text.includes(String(gb.guest_status_token)), "g6: the guest token is not in the page");
      assertTrue(refOnly.text.includes(`<p class="hint">Åpne lenken i e-posten du fikk for å se detaljene.</p>`), "g7: page.guestDataHidden shown instead");
      assertTrue(refOnly.text.includes(gb.booking_ref), "g8: reference (and QR) still shown");
      const wrong = await getText(`${confirmPath}?t=${"0".repeat(32)}`);
      assertTrue(!wrong.text.includes("Kari Hemmelig") && !wrong.text.includes("kari-hemmelig@example.no"), "g9: a wrong token shows nothing either");
      const own = await getText(`${confirmPath}?t=${gb.guest_status_token}`);
      assertTrue(own.text.includes("<strong>Navn:</strong> Kari Hemmelig") && own.text.includes("Hemmelig notat") && own.text.includes("En bekreftelse er sendt til kari-hemmelig@example.no."), "g10: the guest's token shows name, note and e-mail (as before)");
      assertTrue(own.text.includes(`/ics?t=${gb.guest_status_token}"`), "g11: the .ics link keeps the token for the guest");
      assertTrue(refOnly.text.includes(`/api/opplevelser/book/${encodeURIComponent(gb.booking_ref)}/ics"`), "g12: ref-only page links the token-less download");

      const icsRef = await getText(`/api/opplevelser/book/${encodeURIComponent(gb.booking_ref)}/ics`);
      assertTrue(icsRef.status === 200 && !icsRef.text.includes("ATTENDEE") && !icsRef.text.includes("Kari Hemmelig") && !icsRef.text.includes("kari-hemmelig@example.no"), "g13: .ics with only the reference: no ATTENDEE, name or e-mail");
      const icsOwn = await getText(`/api/opplevelser/book/${encodeURIComponent(gb.booking_ref)}/ics?t=${gb.guest_status_token}`);
      assertTrue(icsOwn.text.includes("ATTENDEE;CN=Kari Hemmelig:mailto:kari-hemmelig@example.no"), "g14: .ics with the guest's token: unchanged (ATTENDEE)");
      const icsWrong = await getText(`/api/opplevelser/book/${encodeURIComponent(gb.booking_ref)}/ics?t=nope`);
      assertTrue(!icsWrong.text.includes("ATTENDEE"), "g15: .ics with a wrong token: no ATTENDEE");

      const form = await postForm("/kategori/gardssalg/book/ag-test-p1", {
        slot_at: slotAhead(8), party_size: "2", guest_name: "Skjema Gjest", guest_email: "skjema-gjest@example.no",
      });
      const formRef = decodeURIComponent((form.location.split("/confirm/")[1] || "").split("?")[0]);
      const formRow = store.getBookingByRef(formRef);
      assertEq(form.location, `/kategori/gardssalg/book/ag-test-p1/confirm/${encodeURIComponent(formRef)}?t=${formRow?.guest_status_token}`, "g16: no-JS redirect carries the guest's token");
      const panel = await getText("/kategori/gardssalg/book/ag-test-p1");
      assertTrue(panel.text.includes(`(res.data.guest_token ? "?t=" + encodeURIComponent(res.data.guest_token) : "")`), "g17: form script appends the guest token to the confirm URL");

      process.env.GARDSSALG_HONEST_RECEIPT_ENABLED = "true";
      const honestRef = await getText(confirmPath);
      assertTrue(!honestRef.text.includes("kari-hemmelig@example.no") && !honestRef.text.includes("/kategori/gardssalg/status/") && !honestRef.text.includes("Se status for forespørselen"), "g18: honest flag, ref only: no e-mail, no status link");
      assertTrue(honestRef.text.includes("Åpne lenken i e-posten du fikk for å se detaljene."), "g19: honest flag, ref only: page.guestDataHidden");
      const honestOwn = await getText(`${confirmPath}?t=${gb.guest_status_token}`);
      assertTrue(honestOwn.text.includes(`<p><a href="/kategori/gardssalg/status/${encodeURIComponent(gb.booking_ref)}/${gb.guest_status_token}">Se status for forespørselen</a></p>`), "g20: honest flag + token: receipt.statusLink to the guest's status page");
      assertTrue(honestOwn.text.includes("Forespørselen er sendt. Vi sender en kvittering til kari-hemmelig@example.no."), "g21: honest flag + token: receipt.formMessage as before");
      delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
      if (server) await new Promise<void>((res) => server!.close(() => res()));
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgAttendanceGuardTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

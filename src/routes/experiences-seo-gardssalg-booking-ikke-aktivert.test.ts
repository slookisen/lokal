/**
 * experiences-seo-gardssalg-booking-ikke-aktivert.test.ts — tests for
 * dev-request 2026-08-09-gardssalg-kommer-snart-fjernes-eier-aktivert-booking:
 * the "Kommer snart" chip is gone from the catalog/type-page cards, and the
 * paused state everywhere else states the honest fact — "Booking er ikke
 * aktivert for denne produsenten ennå." (BOOKING_NOT_ACTIVATED_MSG /
 * BOOKING_NOT_ACTIVATED_CONTACT_MSG, services/booking-store.ts — the ONE
 * copy source) — with a claim-CTA coupling on unclaimed surfaces only.
 *
 * Covers (mapping to the dev-request's acceptance criteria):
 *   AC1 — catalog cards (/kategori/gardssalg + a type page): zero
 *         "Kommer snart" occurrences; the "Book besøk" shortcut stays.
 *   AC2 — profile + booking panel paused state: explicit "ikke aktivert"
 *         copy; unclaimed surfaces carry the "Er dette din bedrift? Ta over
 *         profilen og aktiver booking" link to the claim flow; CLAIMED
 *         surfaces never do (the claimed-badge invariant from
 *         experiences-seo-gardssalg-claimed-badge.test.ts holds); the no-JS
 *         ?error=paused banner carries the same copy.
 *   2026-11-06-opplevagent-meld-interesse-fjernes-mens-booking-av — booking
 *         off ⇒ no interest/reservation form, no «Meld interesse», no
 *         «Reserver besøk» on profile or panel; the producer's contact info
 *         is shown instead (and a neutral no-contact line when there is
 *         none). Booking on ⇒ the reserve CTA and form are still there.
 *   AC4 — an activated provider (booking_live=1 + dispatch on) shows NO
 *         paused notice on profile or panel — same isBookingPaused() source.
 *   +   — POST /api/opplevelser/book against a paused provider returns the
 *         shared constant as its message (the panel JS renders res.data
 *         .message verbatim, so this IS the panel's live copy).
 *   AC5 — both options (chosen by Daniel in-session 2026-08-09): cards
 *         carry POSITIVE markers only — «Booking tilgjengelig» exactly on
 *         !isBookingPaused() rows, «✓ Eier-bekreftet» exactly on
 *         claimed_at-stamped rows; a page of paused+unclaimed rows shows
 *         no markers at all.
 *
 * (AC3 — the owner-portal activation switch — already existed: the portal's
 * field_booking_live checkbox + updateClaimedProviderProfile audit trail,
 * covered by gardssalg-claim.test.ts d11–d16 and the admin lever's AC7 in
 * opplevelser-gardssalg-booking-activation.test.ts. Not re-tested here.)
 *
 * Same synthetic router.handle() harness + in-memory-DB pattern as
 * experiences-seo-gardssalg-claimed-badge.test.ts; the JSON /book leg uses
 * the callRoute() recipe from opplevelser-gardssalg-booking-activation.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-gardssalg-booking-ikke-aktivert.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoGardssalgBookingIkkeAktivertTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-gardssalg-claimed-badge.test.ts.
function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

// Same pre-parsed-body JSON shortcut as opplevelser-gardssalg-booking-activation.test.ts.
function callJsonRoute(
  router: any,
  opts: { method?: "GET" | "POST"; url: string; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "POST",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: {},
      headers: {},
      body: opts.body,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

const CHIP = "Kommer snart";
const CTA_LINE = "Ta over profilen og aktiver booking";
const OLD_CTA_BUTTON = "Er dette din bedrift?";

export function runExperiencesSeoGardssalgBookingIkkeAktivertTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    // Dispatch ON for the whole run: paused fixtures stay paused via their
    // own booking_live=0/NULL, and the activated fixture is genuinely live —
    // exactly the AC4 "same isBookingPaused() source" split under test.
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const opplevelserPath = require.resolve("./opplevelser");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, bookingStorePath, claimSvcPath, opplevelserPath, seoPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
      const { BOOKING_NOT_ACTIVATED_MSG, BOOKING_NOT_ACTIVATED_CONTACT_MSG } = bookingStore;

      // Probe parity with the dev-request: the shared copy itself must never
      // smuggle the old promise back in.
      assertTrue(!BOOKING_NOT_ACTIVATED_MSG.toLowerCase().includes("kommer snart"), "s1: BOOKING_NOT_ACTIVATED_MSG carries no 'kommer snart'");
      assertTrue(BOOKING_NOT_ACTIVATED_CONTACT_MSG.includes(BOOKING_NOT_ACTIVATED_MSG), "s2: contact-variant extends the base message");
      assertTrue(!BOOKING_NOT_ACTIVATED_CONTACT_MSG.toLowerCase().includes("interesse"), "s3: contact-variant promises no interest message (nothing is stored)");

      // ── Fixtures — same raw-insert shape as
      // experiences-seo-gardssalg-typesider.test.ts. 7 providers ≥ the
      // GARDSSALG_VISIBILITY_THRESHOLD (5) so the catalog page renders. ────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence, claimed_at)
         VALUES
           (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', @producer_type, @booking_live, NULL, 60.63, 6.42,
            'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium', @claimed_at)`,
      );

      insertProvider.run({
        id: "gs-bna-paused-unclaimed", navn: "Pauset Uclaimet Bryggeri", producer_type: "bryggeri",
        booking_live: 0, slug: "pauset-uclaimet-bryggeri", claimed_at: null,
      });
      insertProvider.run({
        id: "gs-bna-paused-claimed", navn: "Pauset Claimet Cideri", producer_type: "cideri",
        booking_live: 0, slug: "pauset-claimet-cideri", claimed_at: "2026-08-01T09:00:00.000Z",
      });
      insertProvider.run({
        id: "gs-bna-live", navn: "Aktivert Vingård", producer_type: "vingård",
        booking_live: 1, slug: "aktivert-vingard", claimed_at: "2026-08-01T09:00:00.000Z",
      });
      for (let i = 1; i <= 4; i++) {
        insertProvider.run({
          id: `gs-bna-filler-${i}`, navn: `Fyllgård ${i}`, producer_type: "bryggeri",
          booking_live: i % 2 ? 0 : null, slug: `fyllgard-${i}`, claimed_at: null,
        });
      }

      // dev-request 2026-11-06-opplevagent-meld-interesse-fjernes-mens-booking-av:
      // a paused producer WITH contact info (phone, e-mail, website); the
      // other paused fixtures carry none and exercise the no-contact line.
      insertProvider.run({
        id: "gs-bna-paused-contact", navn: "Pauset Kontakt Mjøderi", producer_type: "mjøderi",
        booking_live: 0, slug: "pauset-kontakt-mjoderi", claimed_at: null,
      });
      // N1: special characters in phone + website host, for the /book escape test.
      insertProvider.run({
        id: "gs-bna-paused-escape", navn: "Pauset Escape Mjøderi", producer_type: "mjøderi",
        booking_live: 0, slug: "pauset-escape-mjoderi", claimed_at: null,
      });
      db.prepare(`UPDATE experience_providers SET telefon = ?, hjemmeside = ? WHERE id = ?`)
        .run("<script>x</script> 55 12 34 56 &", "https://a&b<i>.example.no", "gs-bna-paused-escape");
      db.prepare(`UPDATE experience_providers SET telefon = ?, epost = ?, hjemmeside = ? WHERE id = ?`)
        .run("+47 55 12 34 56", "post@kontakt-mjoderi.no", "https://kontakt-mjoderi.no", "gs-bna-paused-contact");

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── AC1: catalog + type-page cards — chip gone, Book-besøk stays ────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg");
        assertTrue(r.handled && r.status === 200, `a1: GET /kategori/gardssalg renders (status ${r.status})`);
        assertTrue(r.body.includes("Pauset Uclaimet Bryggeri"), "a2: a paused provider's card is present (sanity)");
        assertTrue(!r.body.includes(CHIP), "a3: no 'Kommer snart' anywhere on the catalog page");
        assertTrue(r.body.includes("Book besøk"), "a4: the 'Book besøk' card shortcut is still there");
      }
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/bryggeri");
        assertTrue(r.handled && r.status === 200, `b1: GET /kategori/gardssalg/bryggeri renders (status ${r.status})`);
        assertTrue(!r.body.includes(CHIP), "b2: no 'Kommer snart' on the type page either");
      }

      // ── AC2: profile paused, UNCLAIMED — honest copy + claim coupling ───
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pauset-uclaimet-bryggeri");
        assertTrue(r.handled && r.status === 200, `c1: unclaimed paused profile renders (status ${r.status})`);
        assertTrue(r.body.includes(BOOKING_NOT_ACTIVATED_MSG), "c2: profile shows the 'ikke aktivert' state");
        assertTrue(r.body.includes(CTA_LINE), "c3: ...coupled to the claim CTA ('Ta over profilen og aktiver booking')");
        assertTrue(r.body.includes('href="/kategori/gardssalg/eier/pauset-uclaimet-bryggeri"'), "c4: the coupling links to the claim flow");
        assertTrue(!r.body.toLowerCase().includes("kommer snart"), "c5: no 'kommer snart' left on the profile");
      }

      // ── AC2: profile paused, CLAIMED — honest copy, NO claim CTA ────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pauset-claimet-cideri");
        assertTrue(r.handled && r.status === 200, `d1: claimed paused profile renders (status ${r.status})`);
        assertTrue(r.body.includes(BOOKING_NOT_ACTIVATED_MSG), "d2: claimed profile still shows the honest state");
        assertTrue(r.body.includes("Bekreftet av eier"), "d3: the claimed badge is there (sanity)");
        assertTrue(!r.body.includes(OLD_CTA_BUTTON), "d4: claimed-badge invariant — no 'Er dette din bedrift?'");
        assertTrue(!r.body.includes("Ta over profilen"), "d5: ...and no 'Ta over profilen' text at all");
      }

      // ── 2026-11-06: booking off ⇒ contact info, no interest/reserve CTA ─
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pauset-kontakt-mjoderi");
        assertTrue(r.handled && r.status === 200, `m1: paused profile with contact info renders (status ${r.status})`);
        assertTrue(!r.body.includes("Meld interesse") && !r.body.includes("Reserver besøk"), "m2: no «Meld interesse» / «Reserver besøk» while booking is off");
        assertTrue(!r.body.includes('id="reserve-cta"') && !r.body.includes('href="/kategori/gardssalg/book/'), "m3: no reserve link / no link into the booking form");
        assertTrue(!r.body.includes('name="guest_name"') && !r.body.toLowerCase().includes("interessemelding"), "m4: no interest form and no interest-message promise");
        const card = r.body.slice(r.body.indexOf('id="reserve-contact"'), r.body.indexOf("</div>", r.body.indexOf('id="reserve-contact"')));
        assertTrue(r.body.includes('id="reserve-contact"') && r.body.includes("Kontakt produsenten"), "m5: the contact card replaces the reserve card");
        assertTrue(card.includes('href="tel:+47 55 12 34 56"'), "m6: contact card carries the phone as a tel: link");
        assertTrue(card.includes('href="mailto:post@kontakt-mjoderi.no"'), "m7: contact card carries the e-mail as a mailto: link");
        assertTrue(card.includes("kontakt-mjoderi.no</a>") && card.includes('rel="noopener nofollow"'), "m8: contact card carries the website");
        assertTrue(!card.includes("Vi har ikke kontaktinformasjon"), "m9: no no-contact fallback when contact info exists");
      }
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pauset-uclaimet-bryggeri");
        assertTrue(!r.body.includes("Meld interesse") && !r.body.includes("Reserver besøk") && !r.body.includes('id="reserve-cta"'), "n1: no-contact paused profile has no interest/reserve CTA either");
        assertTrue(r.body.includes('id="reserve-contact"') && r.body.includes('class="reserve-contact-none"'), "n2: no-contact paused profile shows the neutral fallback line");
        assertTrue(r.body.includes("Finn produsenten via egne kanaler"), "n3: fallback tells the visitor what they can do");
        const fallbackAt = r.body.indexOf(">", r.body.indexOf('class="reserve-contact-none"')) + 1;
        const fallback = r.body.slice(fallbackAt, r.body.indexOf("</p>", fallbackAt));
        assertTrue(!/svar|booking|reserv|interesse/i.test(fallback), `n4: fallback promises no reply/booking (got ${JSON.stringify(fallback)})`);
      }
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/pauset-kontakt-mjoderi");
        assertTrue(r.handled && r.status === 200 && !r.body.includes('id="book-form"'), `p1: paused panel with contact info renders without the form (status ${r.status})`);
        assertTrue(r.body.includes('href="tel:+47 55 12 34 56"') && r.body.includes("kontakt-mjoderi.no</a>"), "p2: paused panel shows phone + website");
        assertTrue(!r.body.includes("post@kontakt-mjoderi.no"), "p3: the panel does not print the e-mail (published only under the profile page's gates)");
      }

      {
        // B1: the hidden owner slot must stay hidden — `.reserve-cta-paused{display:block}`
        // alone would override the UA [hidden] rule and show an empty grey button.
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pauset-kontakt-mjoderi");
        assertTrue(r.body.includes('<a id="reserve-owner-cta" class="reserve-cta-paused" hidden></a>'), "q1: booking-off profile renders the hidden owner slot");
        assertTrue(/\.reserve-cta-paused\[hidden\]\s*\{\s*display\s*:\s*none\s*\}/.test(r.body), "q2: CSS hides .reserve-cta-paused[hidden] so the empty owner slot is never visible");
        assertTrue(r.body.indexOf(".reserve-cta-paused[hidden]") > r.body.indexOf(".reserve-cta-paused{display:block"), "q3: the [hidden] rule comes after the display:block rule");
      }
      {
        // N1: /book booking-off panel HTML-escapes phone + website host.
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/pauset-escape-mjoderi");
        assertTrue(r.handled && r.status === 200 && r.body.includes('id="book-contact"'), `r1: panel with special-char contact renders (status ${r.status})`);
        const panel = r.body.slice(r.body.indexOf('id="book-contact"'), r.body.indexOf("</div>", r.body.indexOf('id="book-contact"')));
        assertTrue(!panel.includes("<script") && !panel.includes("<i>"), "r2: no raw <script / <i> tag in the panel contact block");
        assertTrue(panel.includes("&lt;script&gt;") && panel.includes("&amp;"), "r3: phone text is HTML-escaped (&lt;script&gt;, &amp;)");
        assertTrue(/Nettside: <a [^>]*>[^<]*<\/a>/.test(panel) && !panel.includes("a&b<i>"), "r4: website host is not rendered raw");
      }

      // ── AC4: activated provider — no paused notice on the profile ───────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/aktivert-vingard");
        assertTrue(r.handled && r.status === 200, `e1: activated profile renders (status ${r.status})`);
        assertTrue(!r.body.includes(BOOKING_NOT_ACTIVATED_MSG), "e2: no 'ikke aktivert' notice for booking_live=1 + dispatch on");
        assertTrue(r.body.includes('<a id="reserve-cta" class="reserve-cta" href="/kategori/gardssalg/book/aktivert-vingard">Reserver besøk</a>'), "e2b: booking on keeps the «Reserver besøk» CTA exactly as before");
        assertTrue(!r.body.includes('id="reserve-contact"'), "e2c: no paused contact card when booking is on");
        assertTrue(!r.body.toLowerCase().includes("kommer snart"), "e3: and no 'kommer snart' either");
      }

      // ── AC2: booking panel paused, UNCLAIMED — notice + intact form ─────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/pauset-uclaimet-bryggeri");
        assertTrue(r.handled && r.status === 200, `f1: unclaimed paused panel renders (status ${r.status})`);
        assertTrue(r.body.includes('class="notice-paused"'), "f2: the paused notice block is rendered");
        assertTrue(r.body.includes("<strong>Booking ikke aktivert</strong>"), "f3: notice heading is 'Booking ikke aktivert' (not 'Kommer snart')");
        assertTrue(r.body.includes(BOOKING_NOT_ACTIVATED_CONTACT_MSG), "f4: notice body is the shared contact-variant copy");
        assertTrue(r.body.includes(CTA_LINE) && r.body.includes('href="/kategori/gardssalg/eier/pauset-uclaimet-bryggeri"'), "f5: claim coupling on the panel too");
        assertTrue(!r.body.includes('id="book-form"') && !r.body.includes('name="guest_name"'), "f6: no reservation/interest form while booking is off");
        assertTrue(!r.body.includes("Reserver besøk") && !r.body.includes("Meld interesse"), "f6b: no «Reserver besøk» / «Meld interesse» on the paused panel");
        assertTrue(r.body.includes('id="book-contact"') && r.body.includes('href="/kategori/gardssalg/produsent/pauset-uclaimet-bryggeri"'), "f6c: the panel points at the profile's contact info instead");
        assertTrue(!r.body.toLowerCase().includes("kommer snart"), "f7: no 'kommer snart' left on the panel");
      }

      // ── AC2: booking panel paused, CLAIMED — notice without claim CTA ───
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/pauset-claimet-cideri");
        assertTrue(r.handled && r.status === 200, `g1: claimed paused panel renders (status ${r.status})`);
        assertTrue(r.body.includes(BOOKING_NOT_ACTIVATED_CONTACT_MSG), "g2: honest notice present");
        assertTrue(!r.body.includes(OLD_CTA_BUTTON) && !r.body.includes(CTA_LINE), "g3: no claim CTA on a claimed provider's panel");
      }

      // ── AC4: booking panel for the activated provider — no notice ───────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/aktivert-vingard");
        assertTrue(r.handled && r.status === 200, `h1: activated panel renders (status ${r.status})`);
        assertTrue(!r.body.includes('class="notice-paused"'), "h2: no paused-notice block when genuinely bookable");
        assertTrue(r.body.includes('id="book-form"') && r.body.includes('name="guest_name"') && r.body.includes(">Reserver besøk</button>"), "h3: the reservation form is still there when booking is on");
        assertTrue(!r.body.includes('id="book-contact"'), "h4: no paused contact block when booking is on");
      }

      // ── AC2: the no-JS ?error=paused banner carries the same copy ───────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/pauset-uclaimet-bryggeri?error=paused");
        assertTrue(r.handled && r.status === 200, `i1: panel with ?error=paused renders (status ${r.status})`);
        assertTrue(r.body.includes(BOOKING_NOT_ACTIVATED_CONTACT_MSG), "i2: the error banner uses the shared copy");
      }

      // ── AC5 options: positive card markers, exact-count discipline ──────
      // Fixture census: 8 visible rows — gs-bna-live is the ONLY activated
      // one (booking_live=1, dispatch on) and is claimed; gs-bna-paused-
      // claimed is the only other claimed row; everything else is paused +
      // unclaimed. So: «Booking tilgjengelig» ×1, «Eier-bekreftet» ×2.
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg");
        const count = (s: string, needle: string) => s.split(needle).length - 1;
        assertTrue(count(r.body, "Booking tilgjengelig") === 1, `k1: exactly the activated row's card carries 'Booking tilgjengelig' (got ${count(r.body, "Booking tilgjengelig")})`);
        assertTrue(count(r.body, "Eier-bekreftet") === 2, `k2: exactly the two claimed rows carry '✓ Eier-bekreftet' (got ${count(r.body, "Eier-bekreftet")})`);
      }
      {
        // The bryggeri type page holds only paused+unclaimed fixtures — a
        // marker-free grid, proving markers never render as filler noise.
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/bryggeri");
        assertTrue(!r.body.includes("Booking tilgjengelig") && !r.body.includes("Eier-bekreftet"), "k3: paused+unclaimed-only type page shows no markers");
      }

      // ── The JSON API's paused message IS the shared constant — the panel
      // JS renders res.data.message verbatim, so this is the live copy. ────
      {
        const r = await callJsonRoute(opplevelserRouter, {
          url: "/book",
          body: {
            provider_id: "gs-bna-paused-unclaimed", slot_at: "2026-09-01T12:00",
            party_size: 2, guest_name: "Test Gjest", guest_email: "gjest@example.no",
          },
        });
        assertTrue(r.status === 200 && r.body?.paused === true && r.body?.success === false, `j1: POST /book against paused provider -> paused:true (status ${r.status})`);
        assertTrue(r.body?.message === BOOKING_NOT_ACTIVATED_MSG, `j2: paused message === BOOKING_NOT_ACTIVATED_MSG (got ${JSON.stringify(r.body?.message)})`);
      }

      return { passed, failed, failures };
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoGardssalgBookingIkkeAktivertTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Always exit explicitly — requiring ./opplevelser leaves module-level
    // timers alive (same reason opplevelser-gardssalg-booking-activation.
    // test.ts exits unconditionally).
    process.exit(result.failed > 0 ? 1 : 0);
  });
}

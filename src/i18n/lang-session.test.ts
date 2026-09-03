/**
 * lang-session.test.ts — Daniel 2026-09-03: «Om man har valgt å bytte til
 * Engelsk skal det språket være default for den brukeren frem til dem bytter
 * tilbake eller går ut av siden.»
 *
 * Drives a REAL express app (langMiddleware → a router carrying
 * rfbLangSessionMiddleware → a catch-all that echoes req.lang/req.path) over
 * loopback HTTP with redirect:"manual", so Set-Cookie attributes and 302
 * Locations are asserted exactly as a browser would see them. Sets and
 * restores LANG_COOKIE_REDIRECT_ENABLED / SV_LOCALE_ENABLED itself.
 *
 * Covers: flag off is a byte-identical no-op; a prefixed URL sets a SESSION
 * cookie (no Max-Age/Expires); an unprefixed localized URL + cookie + browser
 * navigation → 302 to the prefixed URL with the query kept; non-localized
 * pages (/selger) and /:city are never redirected to; non-HTML Accept and
 * POST pass through; ?setlang=no clears the cookie and strips the param;
 * ?setlang=en sets it; an unknown ?setlang touches nothing; sv only when
 * SV_LOCALE_ENABLED; the legacy client-side `lang` cookie is ignored;
 * isRfbLocalizedPath units.
 */

import express from "express";
import type { AddressInfo } from "net";
import { langMiddleware, rfbLangSessionMiddleware, isRfbLocalizedPath, LANG_SESSION_COOKIE } from "./middleware";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLangSessionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const prevFlag = process.env.LANG_COOKIE_REDIRECT_ENABLED;
    const prevSv = process.env.SV_LOCALE_ENABLED;

    const app = express();
    app.use(langMiddleware);
    const router = express.Router();
    router.use(rfbLangSessionMiddleware);
    router.use((req, res) => res.json({ lang: req.lang, path: req.path, url: req.originalUrl }));
    app.use("/", router);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    type R = { status: number; location: string | null; setCookie: string[]; body: any };
    async function get(path: string, o: { cookie?: string; accept?: string; method?: string } = {}): Promise<R> {
      const headers: Record<string, string> = { accept: o.accept ?? "text/html,application/xhtml+xml" };
      if (o.cookie) headers.cookie = o.cookie;
      const r = await fetch(base + path, { method: o.method ?? "GET", headers, redirect: "manual" });
      const setCookie = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : ([r.headers.get("set-cookie")].filter(Boolean) as string[]);
      let body: any = null;
      try {
        body = r.status === 200 ? await r.json() : await r.text();
      } catch {
        body = null;
      }
      return { status: r.status, location: r.headers.get("location"), setCookie, body };
    }
    const sess = (r: R) => r.setCookie.find((c) => c.startsWith(LANG_SESSION_COOKIE + "="));

    try {
      // ── isRfbLocalizedPath units ───────────────────────────────────────
      assertEq(isRfbLocalizedPath("/"), true, "u-01: / is localized");
      assertEq(isRfbLocalizedPath("/produsent/hanen"), true, "u-02: /produsent/:slug is localized");
      assertEq(isRfbLocalizedPath("/kategori"), true, "u-03: /kategori is localized");
      assertEq(isRfbLocalizedPath("/kategori/reko"), true, "u-04: /kategori/:slug is localized");
      assertEq(isRfbLocalizedPath("/kategori/"), false, "u-05: an empty slug is not a page");
      assertEq(isRfbLocalizedPath("/kontakt"), true, "u-06: /kontakt IS localized (its handler reads req.lang)");
      assertEq(isRfbLocalizedPath("/selger"), false, "u-07: /selger is NOT localized");
      assertEq(isRfbLocalizedPath("/samtaler"), false, "u-08: /samtaler is NOT localized");
      assertEq(isRfbLocalizedPath("/bergen"), false, "u-09: /:city deliberately excluded (falls through for unknown slugs)");

      // ── flag OFF: byte-identical no-op ─────────────────────────────────
      delete process.env.LANG_COOKIE_REDIRECT_ENABLED;
      let r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=en` });
      assertEq([r.status, r.body?.lang, sess(r) ?? null], [200, "no", null], "t-01: flag off — cookie ignored, no redirect, no Set-Cookie");
      r = await get("/en");
      assertEq([r.status, r.body?.lang, sess(r) ?? null], [200, "en", null], "t-02: flag off — /en renders but sets nothing");
      r = await get("/?setlang=en");
      assertEq([r.status, sess(r) ?? null], [200, null], "t-03: flag off — ?setlang is inert");

      // ── flag ON ────────────────────────────────────────────────────────
      process.env.LANG_COOKIE_REDIRECT_ENABLED = "true";
      delete process.env.SV_LOCALE_ENABLED;

      r = await get("/en");
      assertEq([r.status, r.body?.lang], [200, "en"], "t-04: prefixed URL renders as before (URL wins)");
      const c = sess(r) ?? "";
      assertTrue(c.startsWith(`${LANG_SESSION_COOKIE}=en`), "t-05: …and sets the session cookie to en");
      assertTrue(!/max-age|expires/i.test(c), "t-06: it is a SESSION cookie — no Max-Age, no Expires («går ut av siden»)");
      assertTrue(/httponly/i.test(c) && /samesite=lax/i.test(c) && /path=\//i.test(c), "t-07: HttpOnly; SameSite=Lax; Path=/");
      assertTrue(!/secure/i.test(c), "t-08: no Secure attribute over plain http (req.secure=false)");

      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=en` });
      assertEq([r.status, r.location], [302, "/en"], "t-09: unprefixed / + session en + browser navigation → 302 /en");
      r = await get("/produsent/hanen?utm=x", { cookie: `${LANG_SESSION_COOKIE}=en` });
      assertEq([r.status, r.location], [302, "/en/produsent/hanen?utm=x"], "t-10: producer page → 302 to the prefixed URL, query kept");
      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=en`, method: "HEAD" });
      assertEq([r.status, r.location], [302, "/en"], "t-11: HEAD navigations redirect too");

      r = await get("/selger", { cookie: `${LANG_SESSION_COOKIE}=en` });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-12: a NON-localized page is never redirected to (/en/selger would render Norwegian under an English URL)");
      r = await get("/bergen", { cookie: `${LANG_SESSION_COOKIE}=en` });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-13: /:city excluded");
      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=en`, accept: "*/*" });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-14: not a browser navigation (Accept */*) → no redirect");
      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=en`, method: "POST" });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-15: POST passes through");
      r = await get("/", { cookie: `lang=en` });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-16: the legacy client-side `lang` cookie is IGNORED (default stays Norwegian)");
      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=no` });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-17: a 'no' session value passes through");
      r = await get("/");
      assertEq([r.status, r.body?.lang, sess(r) ?? null], [200, "no", null], "t-18: no cookie at all — Norwegian, and nothing is set (a crawler sees canonical NO)");

      // ── ?setlang= ──────────────────────────────────────────────────────
      r = await get("/produsent/hanen?setlang=no", { cookie: `${LANG_SESSION_COOKIE}=en` });
      assertEq([r.status, r.location], [302, "/produsent/hanen"], "t-19: ?setlang=no → 302 to the clean unprefixed URL (Norsk sticks — no bounce back to /en)");
      const cleared = sess(r) ?? "";
      assertTrue(/max-age=0|expires=thu, 01 jan 1970/i.test(cleared), "t-20: …and the session cookie is CLEARED");
      r = await get("/produsent/hanen", { cookie: "" });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-21: after clearing, the unprefixed page renders Norwegian");
      r = await get("/en/produsent/hanen?setlang=en&q=1");
      assertEq([r.status, r.location], [302, "/en/produsent/hanen?q=1"], "t-22: ?setlang=en → cookie set, param stripped, other query kept");
      assertTrue((sess(r) ?? "").startsWith(`${LANG_SESSION_COOKIE}=en`), "t-23: …session cookie = en");
      r = await get("/?setlang=xx");
      assertEq([r.status, r.location, sess(r) ?? null], [302, "/", null], "t-24: an unknown ?setlang touches no cookie, param still stripped");

      // ── sv gated by SV_LOCALE_ENABLED ─────────────────────────────────
      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=sv` });
      assertEq([r.status, r.body?.lang], [200, "no"], "t-25: sv session ignored while SV_LOCALE_ENABLED is off");
      r = await get("/?setlang=sv");
      assertEq(sess(r) ?? null, null, "t-26: ?setlang=sv sets nothing while off");
      process.env.SV_LOCALE_ENABLED = "true";
      r = await get("/", { cookie: `${LANG_SESSION_COOKIE}=sv` });
      assertEq([r.status, r.location], [302, "/sv"], "t-27: with SV on, sv session → 302 /sv");
      r = await get("/sv/sok?q=ost");
      assertTrue((sess(r) ?? "").startsWith(`${LANG_SESSION_COOKIE}=sv`), "t-28: /sv/… sets the session to sv");
    } finally {
      if (prevFlag === undefined) delete process.env.LANG_COOKIE_REDIRECT_ENABLED; else process.env.LANG_COOKIE_REDIRECT_ENABLED = prevFlag;
      if (prevSv === undefined) delete process.env.SV_LOCALE_ENABLED; else process.env.SV_LOCALE_ENABLED = prevSv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return { passed, failed, failures };
  })();
}

/**
 * dental-seo.test.ts — dev-request 2026-09-02-dental-profilkvalitet-finn-
 * tannlege: route-level coverage for the parts of the profile page
 * (GET /klinikk/id/:id) that can only be verified against the actual
 * rendered HTML, not a lower-level store call:
 *
 *   5b — a thin profile (missing all 4 of address/phone/website/hours) gets
 *        <meta name="robots" content="noindex,follow"> and the "Ufullstendig
 *        oppføring" CTA with a mailto: link carrying the org number in the
 *        (URL-encoded) subject; a non-thin profile gets neither.
 *   5b — title template: catalog_class='person_enk' -> "Tannlege <navn> i
 *        <by>"; an ordinary clinic keeps the existing "<navn> —
 *        Tannlegeklinikk i <by>" wording byte-for-byte.
 *   5d — directory_url renders as a labeled link ("Oversikt hos
 *        fylkeskommunen" for a county host, "Facebook" for facebook.com,
 *        a generic fallback otherwise) and is never labeled "Hjemmeside".
 *
 * Setup mirrors dental.test.ts (this repo's convention for testing dental
 * route files not registered in tests/test.ts's supertest-style harness):
 * fresh in-memory dental DB via DENTAL_DB_PATH=":memory:" +
 * db-factory.__resetDbFactoryForTesting(), fresh require of the dental-seo
 * router per run, exercised via router.handle() directly with a minimal
 * req/res mock extended with send()/setHeader() (renderClinicProfile uses
 * res.send, not res.json).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function callRoute(
  router: any,
  opts: { method?: string; path: string; params?: Record<string, string> }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: {},
      headers: {},
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      send(payload: any) {
        resolve({ status: this.statusCode, body: String(payload ?? ""), headers });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: JSON.stringify(payload), headers });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: String(err), headers });
    });
  });
}

export async function runDentalSeoProfilkvalitetTests(
  opts: { log?: boolean } = {}
): Promise<TestSummary> {
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

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const dentalSeoPath = require.resolve("./dental-seo");
  const dentalStorePath = require.resolve("../services/dental-store");
  const cachePaths = [dbFactoryPath, dentalSeoPath, dentalStorePath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;

    // ── Subject 1: a thin, sole-proprietor (person_enk) profile ─────────
    const thinEnkId = store.createDentalAgent({
      navn: "Ola Nordmann",
      org_nr: "918800001",
      poststed: "OSLO",
      fylke: "Oslo",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'person_enk' WHERE id = ?").run(thinEnkId);

    const thinEnkResult = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${thinEnkId}` });
    assertTrue(thinEnkResult.status === 200, "thin ENK profile: GET /klinikk/id/:id returns 200");
    assertTrue(
      thinEnkResult.body.includes("<title>Tannlege Ola Nordmann i Oslo | Finn-tannlege.com</title>"),
      "thin ENK profile: title uses the sole-proprietor template 'Tannlege <navn> i <by>'"
    );
    assertTrue(
      thinEnkResult.body.includes('<meta name="robots" content="noindex,follow">'),
      "thin ENK profile: robots meta is noindex,follow"
    );
    assertTrue(
      thinEnkResult.body.includes("Ufullstendig oppføring"),
      "thin ENK profile: page shows the 'Ufullstendig oppføring' CTA text"
    );
    assertTrue(
      thinEnkResult.body.includes("Send oss riktig informasjon"),
      "thin ENK profile: CTA includes the 'Send oss riktig informasjon' link text"
    );
    const expectedSubject = encodeURIComponent(`Ufullstendig oppføring — org.nr 918800001`);
    assertTrue(
      thinEnkResult.body.includes(`mailto:kontakt@finn-tannlege.com?subject=${expectedSubject}`),
      "thin ENK profile: CTA mailto link carries the org number in a URL-encoded subject"
    );

    // ── Subject 2: a complete, ordinary clinic (not thin, not ENK) ──────
    const fullClinicId = store.createDentalAgent({
      navn: "Sentrum Tannklinikk AS",
      org_nr: "918800002",
      poststed: "OSLO",
      fylke: "Oslo",
      adresse: "Storgata 1",
      telefon: "22110099",
      hjemmeside: "https://sentrumtannklinikk.example.no",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(fullClinicId);

    const fullClinicResult = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${fullClinicId}` });
    assertTrue(fullClinicResult.status === 200, "full clinic profile: GET /klinikk/id/:id returns 200");
    assertTrue(
      fullClinicResult.body.includes("<title>Sentrum Tannklinikk AS — Tannlegeklinikk i Oslo | Finn-tannlege.com</title>"),
      "full clinic profile: title keeps the existing '<navn> — Tannlegeklinikk i <by>' wording unchanged"
    );
    assertTrue(
      fullClinicResult.body.includes('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">'),
      "full clinic profile: robots meta stays the default index,follow (not noindex)"
    );
    assertTrue(
      !fullClinicResult.body.includes("Ufullstendig oppføring"),
      "full clinic profile: no 'Ufullstendig oppføring' CTA shown"
    );

    // ── Subject 3: directory_url labeling (5d) — county host ────────────
    const countyClinicId = store.createDentalAgent({
      navn: "Fylkesklinikk AS",
      org_nr: "918800003",
      poststed: "OSLO",
      fylke: "Oslo",
      adresse: "Rådhusgata 5",
      telefon: "22110033",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', directory_url = ? WHERE id = ?").run(
      "https://www.oslo.kommune.no/tannhelse/fylkesklinikk", countyClinicId
    );
    const countyClinicResult = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${countyClinicId}` });
    assertTrue(
      countyClinicResult.body.includes(">Oversikt hos fylkeskommunen<"),
      "directory_url on a county/municipal host is labeled 'Oversikt hos fylkeskommunen'"
    );
    assertTrue(
      countyClinicResult.body.includes("oslo.kommune.no/tannhelse/fylkesklinikk"),
      "directory_url on a county host renders the link itself"
    );

    // ── Subject 4: directory_url labeling (5d) — Facebook ───────────────
    const fbClinicId = store.createDentalAgent({
      navn: "Facebook Klinikk AS",
      org_nr: "918800004",
      poststed: "OSLO",
      fylke: "Oslo",
      adresse: "Kirkegata 2",
      telefon: "22110044",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', directory_url = ? WHERE id = ?").run(
      "https://www.facebook.com/facebookklinikk", fbClinicId
    );
    const fbClinicResult = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${fbClinicId}` });
    assertTrue(
      fbClinicResult.body.includes(">Facebook<"),
      "directory_url on facebook.com is labeled 'Facebook'"
    );

    // ── Subject 5: directory_url labeling (5d) — generic fallback, and
    // never confused with the clinic's OWN homepage (hjemmeside) ────────
    const genericClinicId = store.createDentalAgent({
      navn: "Generisk Oversikt Klinikk AS",
      org_nr: "918800005",
      poststed: "OSLO",
      fylke: "Oslo",
      adresse: "Nedre gate 9",
      telefon: "22110055",
      hjemmeside: "https://generisk-klinikk.example.no",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', directory_url = ? WHERE id = ?").run(
      "https://tannlegerinorge.no/generisk-klinikk", genericClinicId
    );
    const genericClinicResult = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${genericClinicId}` });
    assertTrue(
      genericClinicResult.body.includes(">Ekstern oversikt<"),
      "directory_url on an unrecognized host gets a generic fallback label ('Ekstern oversikt')"
    );
    assertTrue(
      genericClinicResult.body.includes(">Hjemmeside<"),
      "the clinic's own hjemmeside is STILL labeled 'Hjemmeside' alongside the directory_url link"
    );
    // The directory_url link itself must not appear under the Hjemmeside
    // label's OWN info-value div (adjacent divs in the info grid are fine —
    // only the Hjemmeside entry's own value must stay the real homepage).
    const hjemmesideEntryMatch = genericClinicResult.body.match(
      /<div class="info-label">Hjemmeside<\/div><div class="info-value">([\s\S]*?)<\/div>/
    );
    assertTrue(!!hjemmesideEntryMatch, "found the Hjemmeside info-item in the rendered page");
    assertTrue(
      !!hjemmesideEntryMatch && !hjemmesideEntryMatch[1].includes("tannlegerinorge.no"),
      "directory_url is never rendered as if it were the clinic's own homepage (Hjemmeside value stays the real hjemmeside)"
    );
    assertTrue(
      !!hjemmesideEntryMatch && hjemmesideEntryMatch[1].includes("generisk-klinikk.example.no"),
      "Hjemmeside value is still the clinic's real homepage"
    );
  } catch (err: any) {
    failed++;
    failures.push("dental-seo profilkvalitet (5b/5d): unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalSeoProfilkvalitetTests({ log: true }).then((r) => {
    console.log(`\ndental-seo profilkvalitet (5b/5d): ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

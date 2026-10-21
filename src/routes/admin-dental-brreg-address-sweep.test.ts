/**
 * admin-dental-brreg-address-sweep.test.ts — tests for
 * POST /admin/dental/brreg-address-sweep (src/routes/admin-dental-brreg-
 * address-sweep.ts), dev-request 2026-10-21-dental-brreg-adresse-feil-for-
 * videre-sweep, spec 1-5.
 *
 * Setup mirrors admin-dental-mark-inactive.test.ts: fresh in-memory dental
 * DB via DENTAL_DB_PATH=":memory:" + db-factory __resetDbFactoryForTesting(),
 * fresh route module via swapOutModules(), exercised through router.handle().
 * Brreg and clinic-website requests go through the route's own fetch seam
 * (__setBrregAddressSweepFetchForTesting); globalThis.fetch is never touched
 * and no request leaves the process. A URL the stub does not know throws,
 * which the route must report as api_error (Brreg) or no support (website).
 *
 * Covers:
 *   (a) 403 without / with a wrong X-Admin-Key.
 *   (b) ENK (acceptance 1): without support no street line, only the empty
 *       poststed is filled; with another clinic row at the same address the
 *       street is written; the clinic's own website naming street and
 *       postnummer counts as support, a website that does not name them
 *       does not; an active sub-unit's beliggenhetsadresse counts.
 *   (c) acceptance 2: stored postnummer != Brreg postnummer -> nothing
 *       written, flagged; stored poststed differing with no postnummer too.
 *   (d) acceptance 3: underAvvikling, konkurs, slettet (slettedato and HTTP
 *       410) and land != Norge are skipped and flagged.
 *   (e) spec 4: an active sub-unit's beliggenhetsadresse wins over the
 *       forretningsadresse; a closed sub-unit is ignored; two distinct
 *       active sub-unit addresses with nothing to narrow them -> flagged.
 *   (f) spec 5: one results[] entry per row, never the address text;
 *       field_provenance gets address_source on address, postnummer and
 *       poststed.
 *   (g) dry run writes nothing (no stamp either); api_error is not stamped.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-dental-brreg-address-sweep.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminDentalBrregAddressSweepTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: "/brreg-address-sweep",
      originalUrl: "/brreg-address-sweep",
      path: "/brreg-address-sweep",
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
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
      resolve({ status: err ? 500 : 404, body: { error: String(err ?? "no route") } });
    });
  });
}

type Addr = { adresse: string[]; postnummer?: string; poststed?: string; land?: string; landkode?: string };
const no = (adresse: string, postnummer: string, poststed: string): Addr => ({
  adresse: [adresse], postnummer, poststed, land: "Norge", landkode: "NO",
});

export function runAdminDentalBrregAddressSweepTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "dental-brreg-address-sweep-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const routePath = require.resolve("./admin-dental-brreg-address-sweep");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      dbFactoryPath,
      routePath,
    ]);
    let routeMod: typeof import("./admin-dental-brreg-address-sweep") | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");
      routeMod = require("./admin-dental-brreg-address-sweep") as typeof import("./admin-dental-brreg-address-sweep");
      const router = routeMod.default as any;

      // ── Brreg + website fixtures ──────────────────────────────────────
      const enheter: Record<string, { status?: number; body?: any }> = {};
      const underenheter: Record<string, any[]> = {};
      const pages: Record<string, string> = {};
      const throwFor = new Set<string>();
      const enhet = (org: string, form: string, extra: Record<string, unknown>) => {
        enheter[org] = { body: { organisasjonsnummer: org, navn: "X", organisasjonsform: { kode: form }, ...extra } };
      };
      let fetchCalls = 0;
      const stub = (async (input: any) => {
        fetchCalls++;
        const url = new URL(String(input));
        if (url.hostname === "data.brreg.no") {
          const m = url.pathname.match(/\/enheter\/(\d{9})$/);
          if (m) {
            if (throwFor.has(m[1])) throw new Error("ECONNRESET stub");
            const e = enheter[m[1]];
            if (!e) return new Response("{}", { status: 404 });
            return new Response(JSON.stringify(e.body ?? {}), { status: e.status ?? 200, headers: { "content-type": "application/json" } });
          }
          if (url.pathname.endsWith("/underenheter")) {
            const subs = underenheter[url.searchParams.get("overordnetEnhet") || ""] || [];
            const body = subs.length ? { _embedded: { underenheter: subs }, page: { totalElements: subs.length } } : { page: { totalElements: 0 } };
            return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
          }
        }
        const html = pages[url.hostname];
        if (html !== undefined) return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
        throw new Error(`unexpected fetch in test: ${url.hostname}`);
      }) as unknown as typeof fetch;
      routeMod.__setBrregAddressSweepFetchForTesting(stub);

      const insert = db.prepare(
        `INSERT INTO dental_agents (id, org_nr, navn, postnummer, poststed, adresse, hjemmeside, organisasjonsform, field_provenance)
         VALUES (@id, @org_nr, @navn, @postnummer, @poststed, @adresse, @hjemmeside, @organisasjonsform, @field_provenance)`,
      );
      const row = (r: Partial<Record<string, string | null>> & { id: string }) =>
        insert.run({
          org_nr: null, navn: r.id, postnummer: null, poststed: null, adresse: null, hjemmeside: null,
          organisasjonsform: null, field_provenance: null, ...r,
        });

      // Another clinic row already at Storgata 10, 0155 (support for enk-row).
      row({ id: "other-clinic", navn: "Sentrum Tannklinikk", adresse: "Storgata 10, 0155 Oslo", postnummer: "0155", poststed: "Oslo" });

      // (b) ENK cases
      row({ id: "enk-unsupported", org_nr: "100000001", postnummer: "1234", hjemmeside: "https://enk1.example.no", organisasjonsform: "ENK" });
      enhet("100000001", "ENK", { forretningsadresse: no("Heimveien 3", "1234", "BYGD") });
      pages["enk1.example.no"] = "<html><body><p>Velkommen til tannlegen. Ring oss.</p></body></html>";

      row({ id: "enk-row", org_nr: "100000002", postnummer: "0155", organisasjonsform: "ENK" });
      enhet("100000002", "ENK", { forretningsadresse: no("Storgata 10", "0155", "OSLO") });

      row({ id: "enk-web", org_nr: "100000003", hjemmeside: "https://enk3.example.no" });
      enhet("100000003", "ENK", { forretningsadresse: no("Fjordveien 5", "5003", "BERGEN") });
      pages["enk3.example.no"] = "<html><body><footer>Besøk oss i <b>Fjordveien&nbsp;5</b>, 5003 Bergen</footer></body></html>";

      row({ id: "enk-sub", org_nr: "100000004", organisasjonsform: "ENK" });
      enhet("100000004", "ENK", { forretningsadresse: no("Hjemmegata 1", "7010", "TRONDHEIM") });
      underenheter["100000004"] = [
        { organisasjonsnummer: "900000004", beliggenhetsadresse: no("Gammel Klinikkvei 9", "7011", "TRONDHEIM"), nedleggelsesdato: "2020-01-01" },
        { organisasjonsnummer: "900000005", beliggenhetsadresse: no("Klinikkgata 2", "7012", "TRONDHEIM") },
      ];

      row({ id: "enk-nothing", org_nr: "100000005", postnummer: "9008", poststed: "Tromsø", organisasjonsform: "ENK" });
      enhet("100000005", "ENK", { forretningsadresse: no("Privatveien 7", "9008", "TROMSØ") });

      // (c) whole-address cases
      row({ id: "as-pn-mismatch", org_nr: "200000001", postnummer: "0150", poststed: "Oslo" });
      enhet("200000001", "AS", { forretningsadresse: no("Karl Johans gate 1", "0155", "OSLO") });
      row({ id: "as-ps-mismatch", org_nr: "200000002", poststed: "Bergen" });
      enhet("200000002", "AS", { forretningsadresse: no("Karl Johans gate 2", "0155", "OSLO") });
      row({
        id: "as-ok", org_nr: "200000003",
        field_provenance: JSON.stringify({ phone: [{ value: "12345678", source_type: "own_homepage" }] }),
      });
      enhet("200000003", "AS", { forretningsadresse: no("Torget 4", "4006", "STAVANGER") });

      // (d) status / country
      row({ id: "as-avvikling", org_nr: "300000001" });
      enhet("300000001", "AS", { underAvvikling: true, forretningsadresse: no("A 1", "0010", "OSLO") });
      row({ id: "as-konkurs", org_nr: "300000002" });
      enhet("300000002", "AS", { konkurs: true, forretningsadresse: no("A 2", "0010", "OSLO") });
      row({ id: "enk-slettet", org_nr: "300000003" });
      enhet("300000003", "ENK", { slettedato: "2026-10-15", forretningsadresse: no("A 3", "0010", "OSLO") });
      row({ id: "gone-410", org_nr: "300000004" });
      enheter["300000004"] = { status: 410, body: { organisasjonsnummer: "300000004", slettedato: "2026-01-01", respons_klasse: "SlettetEnhet" } };
      row({ id: "nuf-sverige", org_nr: "300000005" });
      enhet("300000005", "NUF", {
        forretningsadresse: { adresse: ["Drottninggatan 1"], postnummer: "11151", poststed: "STOCKHOLM", land: "Sverige", landkode: "SE" },
        postadresse: no("Postveien 1", "0010", "OSLO"),
      });

      // (e) sub-unit preference
      row({ id: "as-sub", org_nr: "400000001" });
      enhet("400000001", "AS", { forretningsadresse: no("Kontorveien 1", "0250", "OSLO") });
      underenheter["400000001"] = [{ organisasjonsnummer: "900000010", beliggenhetsadresse: no("Klinikkveien 8", "0251", "OSLO") }];
      row({ id: "as-sub-ambig", org_nr: "400000002" });
      enhet("400000002", "AS", { forretningsadresse: no("Kontorveien 2", "0250", "OSLO") });
      underenheter["400000002"] = [
        { organisasjonsnummer: "900000011", beliggenhetsadresse: no("Avdeling A 1", "0252", "OSLO") },
        { organisasjonsnummer: "900000012", beliggenhetsadresse: no("Avdeling B 2", "0253", "OSLO") },
      ];

      // (g) transport failure
      row({ id: "as-api-error", org_nr: "500000001" });
      throwFor.add("500000001");

      const ADDRESS_TEXTS = [
        "Heimveien", "Storgata", "Fjordveien", "Hjemmegata", "Klinikkgata", "Privatveien", "Karl Johans",
        "Torget", "Drottninggatan", "Kontorveien", "Klinikkveien", "Avdeling",
      ];
      const post = (body: any, key: string | false = testKey) =>
        callRoute(router, { headers: key === false ? {} : { "x-admin-key": key }, body });
      const byId = (r: RouteResult): Record<string, any> =>
        Object.fromEntries((r.body?.data?.results ?? []).map((x: any) => [x.id, x]));
      const get = (id: string): any => db.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id);

      // ── (a) admin gate ───────────────────────────────────────────────────
      assertEq((await post({}, false)).status, 403, "a1: missing X-Admin-Key -> 403");
      assertEq((await post({}, "wrong-key")).status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (g) dry run ──────────────────────────────────────────────────────
      const dry = await post({ limit: 100 });
      assertEq(dry.status, 200, "g1: dry run -> 200");
      assertEq(dry.body.data.dry_run, true, "g2: dry_run true by default");
      const d = byId(dry);
      assertEq(dry.body.data.results.length, 16, "g3: one result per candidate row (other-clinic is not a candidate)");
      assertEq(d["as-ok"].status, "would_write", "g4: dry run reports would_write");
      assertEq(get("as-ok").adresse, null, "g5: dry run writes no adresse");
      assertEq(get("enk-nothing").brreg_address_attempted_at, null, "g6: dry run stamps nothing");

      // ── write run ────────────────────────────────────────────────────────
      const wr = await post({ write: true, limit: 100 });
      assertEq(wr.status, 200, "w1: write run -> 200");
      const w = byId(wr);
      const resultsJson = JSON.stringify(wr.body.data.results);
      assertTrue(ADDRESS_TEXTS.every((t) => !resultsJson.includes(t)), "f1: results[] never contains an address");
      assertTrue(wr.body.data.results.every((x: any) => !("adresse" in x) && !("navn" in x)), "f2: results[] has no adresse/navn keys");
      assertTrue(
        wr.body.data.results.every((x: any) => typeof x.id === "string" && typeof x.outcome === "string" && Array.isArray(x.fields_written)),
        "f3: every result has id, outcome and fields_written",
      );

      // (b) acceptance 1 — ENK
      assertEq(w["enk-unsupported"].outcome, "write_postal_only", "b1: ENK without support -> write_postal_only");
      assertEq(w["enk-unsupported"].fields_written, ["poststed"], "b2: ENK without support fills only the empty poststed");
      assertEq(w["enk-unsupported"].enk_support, null, "b3: website without the address is no support");
      assertEq(get("enk-unsupported").adresse, null, "b4: ENK without support gets no street address in the DB");
      assertEq(get("enk-unsupported").poststed, "BYGD", "b5: ENK without support: poststed filled from the same Brreg address");
      assertEq(w["enk-row"].outcome, "write_address", "b6: ENK with another clinic row at the same address -> write_address");
      assertEq(w["enk-row"].enk_support, "other_clinic_row", "b7: support recorded as other_clinic_row");
      assertEq(get("enk-row").adresse, "Storgata 10", "b8: ENK with support gets the street address");
      assertEq(w["enk-web"].enk_support, "own_website", "b9: Brreg ENK (stored form empty) supported by its own website");
      assertEq(get("enk-web").adresse, "Fjordveien 5", "b10: website-supported ENK street written");
      assertEq([get("enk-web").postnummer, get("enk-web").poststed], ["5003", "BERGEN"], "b11: postnummer/poststed from the same address");
      assertEq(w["enk-sub"].enk_support, "sub_unit", "b12: ENK with an active sub-unit -> sub_unit support");
      assertEq(w["enk-sub"].address_source, "beliggenhetsadresse", "b13: ENK sub-unit address source");
      assertEq(get("enk-sub").adresse, "Klinikkgata 2", "b14: active sub-unit address, not the closed one or the forretningsadresse");
      assertEq(w["enk-nothing"].outcome, "enk_unsupported", "b15: ENK without support and nothing empty -> enk_unsupported");
      assertEq(w["enk-nothing"].status, "skipped", "b16: enk_unsupported is skipped");
      assertTrue(!!get("enk-nothing").brreg_address_attempted_at, "b17: enk_unsupported is stamped");
      assertEq(get("enk-nothing").adresse, null, "b18: enk_unsupported writes no street");

      // (c) acceptance 2 — whole address from one source
      assertEq(w["as-pn-mismatch"].outcome, "postnummer_mismatch", "c1: stored postnummer != Brreg -> postnummer_mismatch");
      assertEq(w["as-pn-mismatch"].flagged, true, "c2: postnummer_mismatch flagged");
      assertEq(w["as-pn-mismatch"].fields_written, [], "c3: postnummer_mismatch writes no field");
      assertEq([get("as-pn-mismatch").adresse, get("as-pn-mismatch").postnummer], [null, "0150"], "c4: DB unchanged on postnummer mismatch");
      assertEq(w["as-ps-mismatch"].outcome, "poststed_mismatch", "c5: no postnummer, stored poststed differs -> poststed_mismatch");
      assertEq(get("as-ps-mismatch").adresse, null, "c6: DB unchanged on poststed mismatch");
      assertEq(w["as-ok"].fields_written, ["adresse", "postnummer", "poststed"], "c7: AS with empty fields gets all three");
      assertEq(w["as-ok"].flagged, false, "c8: a normal write is not flagged");

      // (d) acceptance 3 — status and country
      for (const [id, outcome] of [
        ["as-avvikling", "under_liquidation"], ["as-konkurs", "bankrupt"], ["enk-slettet", "deleted"],
        ["gone-410", "deleted"], ["nuf-sverige", "foreign_address"],
      ] as const) {
        assertEq([w[id].outcome, w[id].status, w[id].flagged], [outcome, "skipped", true], `d: ${id} -> ${outcome}, skipped, flagged`);
        assertEq(get(id).adresse, null, `d: ${id} writes nothing`);
      }

      // (e) spec 4 — sub-unit preference
      assertEq(w["as-sub"].address_source, "beliggenhetsadresse", "e1: AS with an active sub-unit uses its beliggenhetsadresse");
      assertEq([get("as-sub").adresse, get("as-sub").postnummer], ["Klinikkveien 8", "0251"], "e2: sub-unit street and postnummer together");
      assertEq([w["as-sub-ambig"].outcome, w["as-sub-ambig"].flagged], ["ambiguous_sub_units", true], "e3: two sub-unit addresses -> flagged");

      // (f) provenance
      const prov = JSON.parse(get("as-ok").field_provenance);
      assertTrue(Array.isArray(prov.phone), "f4: unrelated provenance kept");
      for (const f of ["address", "postnummer", "poststed"]) {
        const last = prov[f]?.[prov[f].length - 1];
        assertEq([last?.source_type, last?.address_source], ["brreg", "forretningsadresse"], `f5: provenance ${f} has address_source`);
      }
      const provSub = JSON.parse(get("enk-sub").field_provenance);
      assertEq(provSub.address?.[0]?.address_source, "beliggenhetsadresse", "f6: sub-unit write provenance says beliggenhetsadresse");
      const provPostal = JSON.parse(get("enk-unsupported").field_provenance);
      assertEq([!!provPostal.address, provPostal.poststed?.[0]?.address_source], [false, "forretningsadresse"], "f7: postal-only write has poststed provenance, no address provenance");

      // (g) api_error
      assertEq(w["as-api-error"].status, "api_error", "g7: transport failure -> api_error");
      assertEq(get("as-api-error").brreg_address_attempted_at, null, "g8: api_error not stamped");
      assertEq(wr.body.data.flagged, 8, "g9: flagged counter = 2 mismatch + 5 status/country + 1 ambiguous");

      // A second write run asks only the unstamped row again.
      const before = fetchCalls;
      const again = await post({ write: true, limit: 100 });
      assertEq(again.body.data.results.map((x: any) => x.id), ["as-api-error"], "g10: only the unstamped api_error row is retried");
      assertTrue(fetchCalls - before === 1, "g11: the retry makes exactly one Brreg request");
    } finally {
      try {
        routeMod?.__setBrregAddressSweepFetchForTesting();
      } catch {
        // best-effort
      }
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-dental-brreg-address-sweep.test.ts`
if (require.main === module) {
  runAdminDentalBrregAddressSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) console.log(summary.failures.join("\n"));
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

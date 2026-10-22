/**
 * admin-dental-brreg-address-sweep.test.ts — tests for
 * POST /admin/dental/brreg-address-sweep (src/routes/admin-dental-brreg-
 * address-sweep.ts), dev-request 2026-10-21-dental-brreg-adresse-feil-for-
 * videre-sweep, spec 2-5 and Daniel's answer after filing (rule 1 for every
 * organisation form, plus the correct_mixed mode).
 *
 * Setup mirrors admin-dental-mark-inactive.test.ts: fresh in-memory dental
 * DB via DENTAL_DB_PATH=":memory:" + db-factory __resetDbFactoryForTesting(),
 * fresh route module via swapOutModules(), exercised through router.handle().
 * Brreg and clinic-website requests go through the route's own fetch seam
 * (__setBrregAddressSweepFetchForTesting); globalThis.fetch is never touched
 * and no request leaves the process. A URL the stub does not know throws.
 *
 * Covers:
 *   (a) 403 without / with a wrong X-Admin-Key; 400 for an unknown mode.
 *   (b) rule 1: an ENK without support now gets its forretningsadresse; a
 *       clinic row at the same address is support (basis other_clinic_row),
 *       but not when that row's own street came from a Brreg write; the
 *       clinic's website picks the postadresse it names over the
 *       forretningsadresse (basis own_website); a single registered address
 *       does not cost a page fetch; a street postadresse is used when the
 *       forretningsadresse has no street, a postbox never.
 *   (c) acceptance 2: stored postnummer != Brreg postnummer -> nothing
 *       written, flagged; stored poststed differing with no postnummer too.
 *   (d) acceptance 3: underAvvikling, konkurs, slettet (slettedato and HTTP
 *       410) and land != Norge are skipped and flagged.
 *   (e) beliggenhetsadresse before forretningsadresse, with the source in
 *       field_provenance; a closed sub-unit is ignored; two distinct active
 *       sub-unit addresses -> flagged.
 *   (f) spec 5: results[] never has the address or name; provenance has
 *       address_source and address_basis on address, postnummer, poststed.
 *   (g) dry run writes nothing (no stamp either); api_error is not stamped;
 *       changed_meanwhile when another writer changes the row first.
 *   (h) correct_mixed: dry run (default) reports and writes nothing; apply
 *       must be a strict boolean (400 otherwise, write is refused); apply
 *       sets postnummer/poststed from the Brreg address with the stored
 *       street and clears lat/lng; rows whose street is not from a Brreg
 *       write, consistent rows and a street Brreg no longer has are handled.
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
      const pageHits: string[] = [];
      const enhet = (org: string, form: string, extra: Record<string, unknown>) => {
        enheter[org] = { body: { organisasjonsnummer: org, navn: "X", organisasjonsform: { kode: form }, ...extra } };
      };
      let brregCalls = 0;
      const stub = (async (input: any) => {
        const url = new URL(String(input));
        if (url.hostname === "data.brreg.no") {
          brregCalls++;
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
        pageHits.push(url.hostname);
        const html = pages[url.hostname];
        if (html !== undefined) return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
        throw new Error(`unexpected fetch in test: ${url.hostname}`);
      }) as unknown as typeof fetch;
      routeMod.__setBrregAddressSweepFetchForTesting(stub);

      const insert = db.prepare(
        `INSERT INTO dental_agents (id, org_nr, navn, postnummer, poststed, adresse, hjemmeside, organisasjonsform, field_provenance, lat, lng)
         VALUES (@id, @org_nr, @navn, @postnummer, @poststed, @adresse, @hjemmeside, @organisasjonsform, @field_provenance, @lat, @lng)`,
      );
      const row = (r: Record<string, string | number | null> & { id: string }) =>
        insert.run({
          org_nr: null, navn: r.id, postnummer: null, poststed: null, adresse: null, hjemmeside: null,
          organisasjonsform: null, field_provenance: null, lat: null, lng: null, ...r,
        });
      const homepageProv = (v: string) => JSON.stringify({ address: [{ value: v, source_type: "own_homepage" }] });
      const SWEEP_AT = "2026-10-20T10:00:00.000Z";
      const brregProv = (v: string, src = "forretningsadresse", fetchedAt: string | null = SWEEP_AT) =>
        JSON.stringify({ address: [{ value: v, source_type: "brreg", address_source: src, ...(fetchedAt ? { fetched_at: fetchedAt } : {}) }] });

      // Rows that already have a street (support sources, not candidates).
      row({ id: "other-clinic", adresse: "Storgata 10, 0155 Oslo", postnummer: "0155", poststed: "Oslo", field_provenance: homepageProv("Storgata 10") });
      row({ id: "twin-src", adresse: "Bryggen 1", postnummer: "5003", poststed: "BERGEN", field_provenance: brregProv("Bryggen 1") });

      // (b) rule 1
      row({ id: "enk-plain", navn: "Tannlege Ola Navnesen", org_nr: "100000001", postnummer: "1234", hjemmeside: "https://enk1.example.no", organisasjonsform: "ENK" });
      enhet("100000001", "ENK", { forretningsadresse: no("Heimveien 3", "1234", "BYGD") });
      pages["enk1.example.no"] = "<html><body><p>Velkommen til tannlegen.</p></body></html>";
      row({ id: "enk-row", org_nr: "100000002", postnummer: "0155", organisasjonsform: "ENK" });
      enhet("100000002", "ENK", { forretningsadresse: no("Storgata 10", "0155", "OSLO") });
      row({ id: "brreg-twin", org_nr: "100000003", postnummer: "5003" });
      enhet("100000003", "ENK", { forretningsadresse: no("Bryggen 1", "5003", "BERGEN") });
      row({ id: "web-post", org_nr: "100000004", hjemmeside: "https://web.example.no" });
      enhet("100000004", "AS", { forretningsadresse: no("Kontorbygg 1", "5004", "BERGEN"), postadresse: no("Fjordveien 5", "5003", "BERGEN") });
      pages["web.example.no"] = "<html><body><footer>Besøk oss i <b>Fjordveien&nbsp;5</b>, 5003 Bergen</footer></body></html>";
      row({ id: "postbox-only", org_nr: "100000005" });
      enhet("100000005", "AS", { forretningsadresse: { adresse: [], postnummer: "0101", poststed: "OSLO", land: "Norge", landkode: "NO" }, postadresse: no("Postboks 12", "0101", "OSLO") });
      row({ id: "post-street", org_nr: "100000006" });
      enhet("100000006", "AS", { forretningsadresse: { adresse: [], postnummer: "0102", poststed: "OSLO" }, postadresse: no("Postgata 3", "0102", "OSLO") });

      row({ id: "nuf-nostreet", org_nr: "300000006" });
      enhet("300000006", "NUF", {
        forretningsadresse: { adresse: [], postnummer: "11151", poststed: "STOCKHOLM", land: "Sverige", landkode: "SE" },
        postadresse: no("Postveien 2", "0010", "OSLO"),
      });

      // (e) sub-units
      row({ id: "enk-sub", org_nr: "100000007", organisasjonsform: "ENK" });
      enhet("100000007", "ENK", { forretningsadresse: no("Hjemmegata 1", "7010", "TRONDHEIM") });
      underenheter["100000007"] = [
        { organisasjonsnummer: "900000004", beliggenhetsadresse: no("Gammel Klinikkvei 9", "7011", "TRONDHEIM"), nedleggelsesdato: "2020-01-01" },
        { organisasjonsnummer: "900000005", beliggenhetsadresse: no("Klinikkgata 2", "7012", "TRONDHEIM") },
      ];
      row({ id: "as-sub", org_nr: "400000001" });
      enhet("400000001", "AS", { forretningsadresse: no("Kontorveien 1", "0250", "OSLO") });
      underenheter["400000001"] = [{ organisasjonsnummer: "900000010", beliggenhetsadresse: no("Klinikkveien 8", "0251", "OSLO") }];
      row({ id: "as-sub-narrow", org_nr: "400000003", postnummer: "0255" });
      enhet("400000003", "AS", { forretningsadresse: no("Kontorveien 3", "0250", "OSLO") });
      underenheter["400000003"] = [
        { organisasjonsnummer: "900000013", beliggenhetsadresse: no("Avdeling C 3", "0254", "OSLO") },
        { organisasjonsnummer: "900000014", beliggenhetsadresse: no("Avdeling D 4", "0255", "OSLO") },
      ];
      row({ id: "as-sub-ambig", org_nr: "400000002" });
      enhet("400000002", "AS", { forretningsadresse: no("Kontorveien 2", "0250", "OSLO") });
      underenheter["400000002"] = [
        { organisasjonsnummer: "900000011", beliggenhetsadresse: no("Avdeling A 1", "0252", "OSLO") },
        { organisasjonsnummer: "900000012", beliggenhetsadresse: no("Avdeling B 2", "0253", "OSLO") },
      ];

      // (c) whole-address cases
      row({ id: "as-pn-mismatch", org_nr: "200000001", postnummer: "0150", poststed: "Oslo" });
      enhet("200000001", "AS", { forretningsadresse: no("Karl Johans gate 1", "0155", "OSLO") });
      row({ id: "as-ps-mismatch", org_nr: "200000002", poststed: "Bergen" });
      enhet("200000002", "AS", { forretningsadresse: no("Karl Johans gate 2", "0155", "OSLO") });
      row({ id: "as-ok", org_nr: "200000003", field_provenance: JSON.stringify({ phone: [{ value: "12345678", source_type: "own_homepage" }] }) });
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

      // (g) transport failure, concurrent writer
      row({ id: "as-api-error", org_nr: "500000001" });
      throwFor.add("500000001");
      row({ id: "cm-sweep", org_nr: "500000002" });
      enhet("500000002", "AS", { forretningsadresse: no("Raceveien 1", "0300", "OSLO") });

      const POSTSTED_TEXTS = ["BYGD", "OSLO", "Oslo", "BERGEN", "TRONDHEIM", "STAVANGER", "STOCKHOLM"];
      const ADDRESS_TEXTS = [
        "Heimveien", "Storgata", "Bryggen", "Kontorbygg", "Fjordveien", "Postboks", "Postgata", "Hjemmegata", "Klinikkgata",
        "Karl Johans", "Torget", "Drottninggatan", "Kontorveien", "Klinikkveien", "Avdeling", "Raceveien", "Elvegata", "Kungsgatan", "Norgegata", "Postvei", "Bryggeveien", "Christiania", "Lukkegata", "Flyttegata",
      ];
      const post = (body: any, key: string | false = testKey) =>
        callRoute(router, { headers: key === false ? {} : { "x-admin-key": key }, body });
      const byId = (r: RouteResult): Record<string, any> =>
        Object.fromEntries((r.body?.data?.results ?? []).map((x: any) => [x.id, x]));
      const get = (id: string): any => db.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id);
      const lastProv = (id: string, field: string): any => {
        const p = JSON.parse(get(id).field_provenance || "{}");
        return Array.isArray(p[field]) ? p[field][p[field].length - 1] : undefined;
      };

      // ── (a) admin gate, mode validation ─────────────────────────────────
      assertEq((await post({}, false)).status, 403, "a1: missing X-Admin-Key -> 403");
      assertEq((await post({}, "wrong-key")).status, 403, "a2: wrong X-Admin-Key -> 403");
      assertEq((await post({ mode: "fix_everything" })).status, 400, "a3: unknown mode -> 400");

      // ── (g) dry run ──────────────────────────────────────────────────────
      const dry = await post({ limit: 100 });
      assertEq(dry.status, 200, "g1: dry run -> 200");
      assertEq([dry.body.data.dry_run, dry.body.data.mode], [true, "sweep"], "g2: dry_run true, mode sweep by default");
      const d = byId(dry);
      assertEq(dry.body.data.results.length, 21, "g3: one result per candidate row (rows with a street are not candidates)");
      assertEq(d["as-ok"].status, "would_write", "g4: dry run reports would_write");
      {
        const dj = JSON.stringify(dry.body.data.results);
        assertTrue(ADDRESS_TEXTS.every((t) => !dj.includes(t)), "g4b: dry-run results[] have no address");
        assertTrue(POSTSTED_TEXTS.every((t) => !dj.includes(t)) && !dj.includes("Navnesen"), "g4c: dry-run results[] have no poststed or name");
      }
      assertEq(get("as-ok").adresse, null, "g5: dry run writes no adresse");
      assertEq(get("as-pn-mismatch").brreg_address_attempted_at, null, "g6: dry run stamps nothing");

      // ── write run ────────────────────────────────────────────────────────
      pageHits.length = 0;
      routeMod.__setBrregAddressSweepBeforeWriteForTesting((id) => {
        if (id === "cm-sweep") db.prepare("UPDATE dental_agents SET postnummer = '0301' WHERE id = 'cm-sweep'").run();
      });
      const wr = await post({ write: true, limit: 100 });
      routeMod.__setBrregAddressSweepBeforeWriteForTesting(null);
      assertEq(wr.status, 200, "w1: write run -> 200");
      const w = byId(wr);
      const resultsJson = JSON.stringify(wr.body.data.results);
      assertTrue(ADDRESS_TEXTS.every((t) => !resultsJson.includes(t)), "f1: results[] never contains an address");
      assertTrue(wr.body.data.results.every((x: any) => !("adresse" in x) && !("navn" in x)), "f2: results[] has no adresse/navn keys");
      assertTrue(
        wr.body.data.results.every((x: any) => typeof x.id === "string" && typeof x.outcome === "string" && Array.isArray(x.fields_written)),
        "f3: every result has id, outcome and fields_written",
      );

      // (b) rule 1, for every organisation form
      assertEq([w["enk-plain"].outcome, w["enk-plain"].address_basis], ["write_address", "forretningsadresse"], "b1: ENK without support gets its forretningsadresse");
      assertEq(w["enk-plain"].fields_written, ["adresse", "poststed"], "b2: street + the empty poststed");
      assertEq([get("enk-plain").adresse, get("enk-plain").poststed], ["Heimveien 3", "BYGD"], "b3: ENK street written from Brreg");
      assertTrue(!pageHits.includes("enk1.example.no"), "b4: one registered address -> no website fetch");
      assertEq(w["enk-row"].address_basis, "other_clinic_row", "b5: clinic row at the same address -> basis other_clinic_row");
      assertEq(get("enk-row").adresse, "Storgata 10", "b6: supported street written");
      assertEq(w["brreg-twin"].address_basis, "forretningsadresse", "b7: a row whose street came from a Brreg write is not support");
      assertEq([w["web-post"].address_basis, w["web-post"].address_source], ["own_website", "postadresse"], "b8: website picks the postadresse it names");
      assertEq([get("web-post").adresse, get("web-post").postnummer], ["Fjordveien 5", "5003"], "b9: website-supported street + its own postnummer");
      assertTrue(pageHits.includes("web.example.no"), "b10: two registered addresses -> website read");
      assertEq(w["postbox-only"].outcome, "no_address", "b11: a postbox postadresse is never a street");
      assertEq(get("postbox-only").adresse, null, "b12: postbox not written");
      assertEq([w["post-street"].address_basis, get("post-street").adresse], ["postadresse", "Postgata 3"], "b13: street postadresse used when forretningsadresse has no street");

      // (e) beliggenhetsadresse before forretningsadresse, source in provenance
      assertEq([w["enk-sub"].address_source, w["enk-sub"].address_basis], ["beliggenhetsadresse", "beliggenhetsadresse"], "e1: active sub-unit wins");
      assertEq(get("enk-sub").adresse, "Klinikkgata 2", "e2: active sub-unit address, not the closed one or the forretningsadresse");
      assertEq([get("as-sub").adresse, get("as-sub").postnummer], ["Klinikkveien 8", "0251"], "e3: sub-unit street and postnummer together");
      for (const f of ["address", "postnummer", "poststed"]) {
        const rec = lastProv("as-sub", f);
        assertEq([rec?.source_type, rec?.address_source, rec?.address_basis], ["brreg", "beliggenhetsadresse", "beliggenhetsadresse"], `e4: provenance ${f} names beliggenhetsadresse`);
      }
      assertEq([w["as-sub-ambig"].outcome, w["as-sub-ambig"].flagged], ["ambiguous_sub_units", true], "e5: two sub-unit addresses -> flagged");
      assertEq([w["as-sub-narrow"].outcome, get("as-sub-narrow").adresse], ["write_address", "Avdeling D 4"], "e6: two sub-unit addresses narrowed by the stored postnummer");

      // (c) acceptance 2
      assertEq([w["as-pn-mismatch"].outcome, w["as-pn-mismatch"].flagged, w["as-pn-mismatch"].fields_written], ["postnummer_mismatch", true, []], "c1: postnummer mismatch -> flagged, nothing written");
      assertEq([get("as-pn-mismatch").adresse, get("as-pn-mismatch").postnummer], [null, "0150"], "c2: DB unchanged on postnummer mismatch");
      assertEq(w["as-ps-mismatch"].outcome, "poststed_mismatch", "c3: no postnummer, stored poststed differs -> poststed_mismatch");
      assertEq(get("as-ps-mismatch").adresse, null, "c4: DB unchanged on poststed mismatch");
      assertEq([w["as-ok"].fields_written, w["as-ok"].flagged], [["adresse", "postnummer", "poststed"], false], "c5: AS with empty fields gets all three");

      // (d) acceptance 3
      for (const [id, outcome] of [
        ["as-avvikling", "under_liquidation"], ["as-konkurs", "bankrupt"], ["enk-slettet", "deleted"],
        ["gone-410", "deleted"], ["nuf-sverige", "foreign_address"], ["nuf-nostreet", "foreign_address"],
      ] as const) {
        assertEq([w[id].outcome, w[id].status, w[id].flagged], [outcome, "skipped", true], `d: ${id} -> ${outcome}, skipped, flagged`);
        assertEq(get(id).adresse, null, `d: ${id} writes nothing`);
      }

      // (f) provenance
      const asOkProv = JSON.parse(get("as-ok").field_provenance);
      assertTrue(Array.isArray(asOkProv.phone), "f4: unrelated provenance kept");
      for (const f of ["address", "postnummer", "poststed"]) {
        const rec = lastProv("as-ok", f);
        assertEq([rec?.address_source, rec?.address_basis], ["forretningsadresse", "forretningsadresse"], `f5: provenance ${f} has source and basis`);
      }
      assertEq(lastProv("web-post", "address")?.address_basis, "own_website", "f6: provenance basis own_website");

      // (g) api_error, changed_meanwhile, counters
      assertEq(w["as-api-error"].status, "api_error", "g7: transport failure -> api_error");
      assertEq(get("as-api-error").brreg_address_attempted_at, null, "g8: api_error not stamped");
      assertEq([w["cm-sweep"].outcome, w["cm-sweep"].fields_written], ["changed_meanwhile", []], "g9: concurrent change -> changed_meanwhile");
      assertEq([get("cm-sweep").adresse, get("cm-sweep").postnummer], [null, "0301"], "g10: changed_meanwhile writes nothing over the other writer");
      assertEq(wr.body.data.flagged, 9, "g11: flagged = 2 mismatch + 6 status/country + 1 ambiguous");
      const before = brregCalls;
      const again = await post({ write: true, limit: 100 });
      assertEq(again.body.data.results.map((x: any) => x.id).sort(), ["as-api-error", "cm-sweep"], "g12: only unstamped rows are asked again");
      assertTrue(brregCalls - before >= 1, "g13: the retry asks Brreg again");

      // ── (h) correct_mixed ──────────────────────────────────────────────
      row({ id: "mix-1", org_nr: "600000001", adresse: "Elvegata 4", postnummer: "0150", poststed: "OSLO", lat: 59.9, lng: 10.7, field_provenance: brregProv("Elvegata 4") });
      enhet("600000001", "AS", { forretningsadresse: no("Elvegata 4", "0155", "OSLO") });
      row({ id: "mix-gone", org_nr: "600000002", adresse: "Gammelgata 1", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Gammelgata 1") });
      enhet("600000002", "AS", { forretningsadresse: no("Nygata 2", "0151", "OSLO") });
      row({
        id: "mix-not-brreg", org_nr: "600000003", adresse: "Hjemmesidegata 1", postnummer: "0150", poststed: "OSLO",
        field_provenance: JSON.stringify({ address: [{ value: "Hjemmesidegata 1", source_type: "own_homepage" }], postnummer: [{ value: "0150", source_type: "brreg" }] }),
      });
      enhet("600000003", "AS", { forretningsadresse: no("Hjemmesidegata 1", "0155", "OSLO") });
      row({ id: "mix-cm", org_nr: "600000004", adresse: "Kappgata 5", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Kappgata 5") });
      enhet("600000004", "AS", { forretningsadresse: no("Kappgata 5", "0155", "OSLO") });

      row({ id: "mix-nuf", navn: "Svensk Tandvård Filial", org_nr: "600000005", adresse: "Drottninggatan 1", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Drottninggatan 1") });
      enhet("600000005", "NUF", { forretningsadresse: { adresse: ["Drottninggatan 1"], postnummer: "11143", poststed: "STOCKHOLM", land: "Sverige", landkode: "SE" } });
      row({ id: "mix-post-abroad", org_nr: "600000006", adresse: "Kungsgatan 2", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Kungsgatan 2", "postadresse") });
      enhet("600000006", "AS", {
        forretningsadresse: no("Norgegata 1", "0150", "OSLO"),
        postadresse: { adresse: ["Kungsgatan 2"], postnummer: "11156", poststed: "STOCKHOLM", land: "Sverige", landkode: "SE" },
      });
      row({ id: "mix-avvikling", org_nr: "600000007", adresse: "Lukkegata 1", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Lukkegata 1") });
      enhet("600000007", "AS", { underAvvikling: true, forretningsadresse: no("Lukkegata 1", "0155", "OSLO") });
      row({ id: "mix-konkurs", org_nr: "600000008", adresse: "Lukkegata 2", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Lukkegata 2") });
      enhet("600000008", "AS", { konkurs: true, forretningsadresse: no("Lukkegata 2", "0155", "OSLO") });
      row({ id: "mix-slettet", org_nr: "600000009", adresse: "Lukkegata 3", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Lukkegata 3") });
      enhet("600000009", "AS", { slettedato: "2026-09-01", forretningsadresse: no("Lukkegata 3", "0155", "OSLO") });
      row({ id: "mix-addr-race", org_nr: "600000010", adresse: "Flyttegata 1", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Flyttegata 1") });
      enhet("600000010", "AS", { forretningsadresse: no("Flyttegata 1", "0155", "OSLO") });

      row({ id: "mix-ps-only", org_nr: "600000011", adresse: "Elvegata 6", postnummer: "0155", poststed: "Christiania", field_provenance: brregProv("Elvegata 6") });
      enhet("600000011", "AS", { forretningsadresse: no("Elvegata 6", "0155", "OSLO") });
      row({ id: "mix-2", org_nr: "600000012", adresse: "Elvegata 8", postnummer: "0150", poststed: "Oslo", field_provenance: brregProv("Elvegata 8") });
      enhet("600000012", "AS", { forretningsadresse: no("Elvegata 8", "0155", "OSLO") });
      row({ id: "mix-3", org_nr: "600000013", adresse: "Elvegata 10", postnummer: "0150", poststed: "Christiania", field_provenance: brregProv("Elvegata 10") });
      enhet("600000013", "AS", { forretningsadresse: no("Elvegata 10", "0155", "OSLO") });
      row({ id: "mix-nuf-nostreet", org_nr: "600000014", adresse: "Postvei 7", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Postvei 7", "postadresse") });
      enhet("600000014", "NUF", {
        forretningsadresse: { adresse: [], postnummer: "11151", poststed: "STOCKHOLM", land: "Sverige", landkode: "SE" },
        postadresse: no("Postvei 7", "0155", "OSLO"),
      });
      row({ id: "mix-nuf-nopost", org_nr: "600000015", adresse: "Bryggeveien 2", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Bryggeveien 2", "postadresse") });
      enhet("600000015", "NUF", {
        forretningsadresse: { adresse: ["Drottninggatan 9"], postnummer: "11151", poststed: "STOCKHOLM", land: "Sverige", landkode: "SE" },
        postadresse: no("Bryggeveien 2", "0155", "OSLO"),
      });

      // Rows the sweep wrote carry the stamp; the Places-shaped and other rows below do not match it.
      db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ? WHERE id LIKE 'mix-%'").run(SWEEP_AT);
      row({ id: "mix-places", org_nr: "600000020", adresse: "Elvegata 20", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Elvegata 20", "forretningsadresse", null) });
      enhet("600000020", "AS", { forretningsadresse: no("Elvegata 20", "0155", "OSLO") });
      row({ id: "mix-stale-stamp", org_nr: "600000021", adresse: "Elvegata 21", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Elvegata 21", "forretningsadresse", "2026-09-01T08:00:00.000Z") });
      enhet("600000021", "AS", { forretningsadresse: no("Elvegata 21", "0155", "OSLO") });
      db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ? WHERE id = 'mix-stale-stamp'").run(SWEEP_AT);
      row({ id: "mix-inactive", org_nr: "600000022", adresse: "Elvegata 22", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Elvegata 22") });
      enhet("600000022", "AS", { forretningsadresse: no("Elvegata 22", "0155", "OSLO") });
      row({ id: "mix-rejected", org_nr: "600000023", adresse: "Elvegata 23", postnummer: "0150", poststed: "OSLO", field_provenance: brregProv("Elvegata 23") });
      enhet("600000023", "AS", { forretningsadresse: no("Elvegata 23", "0155", "OSLO") });
      db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ?, is_inactive = 1 WHERE id = 'mix-inactive'").run(SWEEP_AT);
      db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ?, verification_status = 'rejected' WHERE id = 'mix-rejected'").run(SWEEP_AT);

      assertEq((await post({ mode: "correct_mixed", apply: "true" })).status, 400, "h1: apply as a string -> 400");
      assertEq((await post({ mode: "correct_mixed", apply: 1 })).status, 400, "h2: apply as a number -> 400");
      assertEq((await post({ mode: "correct_mixed", write: true })).status, 400, "h3: write in correct_mixed -> 400");

      const cdry = await post({ mode: "correct_mixed", limit: 100 });
      assertEq([cdry.status, cdry.body.data.dry_run, cdry.body.data.mode], [200, true, "correct_mixed"], "h4: correct_mixed is a dry run by default");
      const cd = byId(cdry);
      assertEq([cd["mix-1"]?.outcome, cd["mix-1"]?.fields], ["would_correct", ["postnummer", "lat", "lng"]], "h5: mixed row reported as would_correct");
      assertEq([cd["mix-gone"]?.outcome, cd["mix-gone"]?.flagged], ["street_not_in_brreg", true], "h6: street Brreg no longer has -> flagged");
      assertTrue(!cd["mix-not-brreg"], "h7: street not from a Brreg write is not reported");
      assertTrue(cdry.body.data.not_from_brreg_write >= 1, "h8: counted as not_from_brreg_write");
      assertTrue(!cd["as-ok"] && cdry.body.data.consistent >= 1, "h9: rows the sweep wrote whole are consistent, not reported");
      const cdJson = JSON.stringify(cdry.body.data.results);
      assertTrue(ADDRESS_TEXTS.every((t) => !cdJson.includes(t)) && !cdJson.includes("Gammelgata"), "h10: correction results have no address");
      assertEq([get("mix-1").postnummer, get("mix-1").lat], ["0150", 59.9], "h11: dry run writes nothing");
      assertTrue(POSTSTED_TEXTS.every((t) => !cdJson.includes(t)) && !cdJson.includes("Navnesen") && !cdJson.includes("Tandv"), "h11b: correction results have no poststed or name");
      assertEq([cd["mix-nuf"]?.outcome, cd["mix-nuf"]?.flagged], ["foreign_address", true], "h11c: foreign forretningsadresse -> foreign_address, flagged (dry run)");
      assertEq([cd["mix-post-abroad"]?.outcome, cd["mix-post-abroad"]?.flagged], ["foreign_address", true], "h11d: matching address abroad -> foreign_address, flagged");
      for (const [id, outcome] of [["mix-avvikling", "under_liquidation"], ["mix-konkurs", "bankrupt"], ["mix-slettet", "deleted"]] as const) {
        assertEq([cd[id]?.outcome, cd[id]?.flagged], [outcome, true], `h11e: ${id} -> ${outcome}, flagged`);
      }

      routeMod.__setBrregAddressSweepBeforeWriteForTesting((id) => {
        if (id === "mix-cm") db.prepare("UPDATE dental_agents SET poststed = 'Annet' WHERE id = 'mix-cm'").run();
        if (id === "mix-addr-race") db.prepare("UPDATE dental_agents SET adresse = 'Annen gate 9' WHERE id = 'mix-addr-race'").run();
      });
      const capply = await post({ mode: "correct_mixed", apply: true, limit: 100 });
      routeMod.__setBrregAddressSweepBeforeWriteForTesting(null);
      const ca = byId(capply);
      assertEq([capply.body.data.dry_run, ca["mix-1"]?.outcome], [false, "corrected"], "h12: apply:true corrects");
      const m1 = get("mix-1");
      assertEq([m1.adresse, m1.postnummer, m1.poststed, m1.lat, m1.lng], ["Elvegata 4", "0155", "OSLO", null, null], "h13: postnummer from the same Brreg address, geo cleared");
      assertEq([lastProv("mix-1", "postnummer")?.correction, lastProv("mix-1", "postnummer")?.address_source], ["mixed_address", "forretningsadresse"], "h14: correction provenance");
      assertEq(ca["mix-cm"]?.outcome, "changed_meanwhile", "h15: correction re-checks the row at write time");
      assertEq(get("mix-cm").postnummer, "0150", "h16: changed_meanwhile correction writes nothing");
      assertEq(get("mix-gone").postnummer, "0150", "h17: flagged row not corrected");
      assertEq(get("mix-not-brreg").postnummer, "0150", "h18: row with street from elsewhere not corrected");
      assertEq([cd["mix-ps-only"]?.outcome, cd["mix-ps-only"]?.flagged, ca["mix-ps-only"]?.outcome], ["poststed_only_mismatch", true, "poststed_only_mismatch"], "h23: postnummer fits, poststed differs -> reported and flagged, not corrected");
      assertEq(get("mix-ps-only").poststed, "Christiania", "h24: poststed-only difference never written by apply");
      assertEq([ca["mix-2"]?.outcome, ca["mix-2"]?.fields], ["corrected", ["postnummer", "lat", "lng"]], "h25: poststed that fits is not in fields");
      assertEq([get("mix-2").postnummer, get("mix-2").poststed], ["0155", "Oslo"], "h26: poststed that fits is not rewritten");
      assertEq(lastProv("mix-2", "poststed"), undefined, "h27: no poststed provenance when poststed is not written");
      assertEq(lastProv("mix-1", "poststed"), undefined, "h28: mix-1 poststed fits, no poststed provenance");
      assertEq([ca["mix-3"]?.fields, get("mix-3").postnummer, get("mix-3").poststed], [["postnummer", "poststed", "lat", "lng"], "0155", "OSLO"], "h29: both differ -> both written");
      assertEq(lastProv("mix-3", "poststed")?.correction, "mixed_address", "h30: poststed provenance when poststed is written");
      assertEq([cd["mix-nuf-nostreet"]?.outcome, ca["mix-nuf-nostreet"]?.outcome, get("mix-nuf-nostreet").postnummer], ["foreign_address", "foreign_address", "0150"], "h31: foreign forretningsadresse without street line -> foreign_address, not corrected");
      assertEq([cd["mix-nuf-nopost"]?.outcome, ca["mix-nuf-nopost"]?.outcome, get("mix-nuf-nopost").postnummer], ["foreign_address", "foreign_address", "0150"], "h32: foreign forretningsadresse, Norwegian matching address -> foreign_address, not corrected");
      assertEq([ca["mix-nuf"]?.outcome, get("mix-nuf").postnummer, get("mix-nuf").poststed], ["foreign_address", "0150", "OSLO"], "h19: apply never writes a foreign address");
      assertEq([ca["mix-post-abroad"]?.outcome, get("mix-post-abroad").postnummer], ["foreign_address", "0150"], "h20: apply skips a matching address abroad");
      for (const id of ["mix-avvikling", "mix-konkurs", "mix-slettet"]) {
        assertEq(get(id).postnummer, "0150", `h21: apply does not correct ${id}`);
      }
      assertEq([ca["mix-addr-race"]?.outcome, get("mix-addr-race").postnummer], ["changed_meanwhile", "0150"], "h22: adresse changed before write -> changed_meanwhile, nothing written");
      for (const id of ["mix-places", "mix-stale-stamp", "mix-inactive", "mix-rejected"]) {
        assertTrue(!cd[id] && !ca[id], `h33: ${id} is never reported or corrected`);
        assertEq(get(id).postnummer, "0150", `h34: ${id} postnummer untouched by apply`);
      }
    } finally {
      try {
        routeMod?.__setBrregAddressSweepFetchForTesting();
        routeMod?.__setBrregAddressSweepBeforeWriteForTesting(null);
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

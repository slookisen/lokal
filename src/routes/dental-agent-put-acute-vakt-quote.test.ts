/**
 * dental-agent-put-acute-vakt-quote.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, F1-S4d (lokal punkt 1–4).
 *
 * «Akuttvakt» is shown only when an acute_vakt source stores the quote from
 * the clinic's page (F1-S4c, dental-acute-claim.ts). This is the write path
 * that stores it. By prefix:
 *   Q   normaliseSource via mergeFieldProvenance (admin-knowledge.ts): the
 *       quote survives in the array and the {sources} form, trimmed and cut
 *       to 300 code points (never inside a surrogate pair, trimmed at the
 *       end again, read from the first 600 UTF-16 units only); a quote that
 *       is not a string, or blank, is dropped; quote_basis only with a quote
 *       and one of the two values.
 *       Dedup: a source with a quote replaces, in the place of the first,
 *       every stored source with the same source_type::value (a stamp or an
 *       older quote), so the list does not grow; a source without a quote is
 *       a duplicate as before; the inputs are not changed.
 *   P   PUT /api/tannlege/agents/:id (dental.ts): with acute_vakt in the
 *       validated body the stored quotes are removed before the merge (with
 *       no field_provenance in the body nothing else in the column changes,
 *       audit entries such as inactive and hjemmeside included); an
 *       incoming quote is kept only on a source with value "1" when the body
 *       has acute_vakt = 1; the answer's acute_vakt_quote is stored, missing
 *       or dropped, and absent for a PUT that is not about acute_vakt.
 *   E   end to end: a PUT with a quote gives «Akuttvakt» on the card, on the
 *       /sok list card, in the A2A answer and in the SQL twin; a PUT without
 *       one gives «Tar imot akuttpasienter», also on a row whose old quote it
 *       removes.
 *
 * Setup mirrors dental-agent-put-field-provenance.test.ts: a fresh in-memory
 * dental DB (DENTAL_DB_PATH=":memory:"), fresh requires through
 * swapOutModules, and the router exercised with router.handle().
 *
 * Standalone: npx tsx src/routes/dental-agent-put-acute-vakt-quote.test.ts
 * Wired into tests/test.ts via runDentalAgentPutAcuteVaktQuoteTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method,
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: opts.query ?? {},
      headers: opts.headers ?? {},
      body: opts.body,
      ip: "127.0.0.1",
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      header() {
        return this;
      },
      set() {
        return this;
      },
      vary() {
        return this;
      },
      once() {
        return this;
      },
      send(payload: any) {
        resolve({ status: this.statusCode, body: payload, text: String(payload ?? "") });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, text: JSON.stringify(payload) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "unhandled") }, text: "" }));
  });
}

const QUOTE = "Vi tar imot nye pasienter for akutt behandling hver kveld til kl. 22 og i helgene.";
const OLD_QUOTE = "Akuttvakt for alle, også nye pasienter, lørdag og søndag 10–14.";
const PAGE = "https://klinikk.example.no/akutt";

export async function runDentalAgentPutAcuteVaktQuoteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  };
  // JSON with each object's keys sorted: a record's key order is not what is tested.
  const canon = (v: unknown): string =>
    JSON.stringify(v, (_key, x) =>
      x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x
    );
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(canon(actual) === canon(expected), `${label} (expected ${canon(expected)}, got ${canon(actual)})`);

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "dental-put-acute-vakt-quote-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;
  // dental-store holds its own db-factory binding (see the note in
  // dental-agent-put-field-provenance.test.ts), so it is swapped out with
  // db-factory and the two routers that read it.
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
  ]);
  const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  (analyticsService as any).logWebSearch = () => {};

  try {
    const { mergeFieldProvenance, PROVENANCE_QUOTE_MAX_CODE_POINTS } = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const { hasAcuteVaktQuote, DENTAL_ACUTE_VAKT_SQL, DENTAL_ACUTE_CLAIM_SQL } =
      require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");

    // ── Q: normaliseSource and the dedup in mergeFieldProvenance ──────────
    const stamp = { source_type: "own_homepage", value: "1", fetched_at: "2026-09-01T00:00:00Z", source_url: "https://klinikk.example.no" };
    const quoted = { source_type: "own_homepage", value: "1", fetched_at: "2026-10-20T00:00:00Z", source_url: PAGE, quote: QUOTE, quote_basis: "tider_i_sitatet" };
    const merged1 = (incoming: unknown[], existing: Record<string, unknown> = {}) =>
      mergeFieldProvenance(existing, { acute_vakt: incoming as any }).acute_vakt ?? [];
    {
      const flat = merged1([quoted]);
      const wrapped = mergeFieldProvenance({}, { acute_vakt: { sources: [quoted] } as any }).acute_vakt ?? [];
      eq(flat, [quoted], "Q1: the quote and quote_basis survive normaliseSource in the array form");
      eq(wrapped, [quoted], "Q2: ... and in the {sources} form");
      ok(hasAcuteVaktQuote({ acute_vakt: flat }), "Q3: the read rule (hasAcuteVaktQuote) sees the stored quote");
      eq(merged1([{ ...quoted, quote: `  \n${QUOTE}  ` }])[0]?.quote, QUOTE, "Q4: the quote is trimmed (String.prototype.trim)");
      const at300 = "a".repeat(PROVENANCE_QUOTE_MAX_CODE_POINTS);
      eq(merged1([{ ...quoted, quote: at300 + "bcd" }])[0]?.quote, at300, "Q5: a longer quote is cut to 300 code points");
      eq(merged1([{ ...quoted, quote: at300 }])[0]?.quote, at300, "Q6: a quote of exactly 300 code points is kept whole");
      const astral = "\u{1F9B7}".repeat(301);
      const cut = merged1([{ ...quoted, quote: astral }])[0]?.quote ?? "";
      ok(Array.from(cut).length === 300 && cut.length === 600 && cut === "\u{1F9B7}".repeat(300),
        "Q7: the cut counts code points, so a surrogate pair is never split (300 code points, 600 UTF-16 units)");
      const notQuotes: unknown[] = [1, 0, true, null, ["Akuttvakt"], { text: "Akuttvakt" }, "", "   ", " \n\t", "  　﻿"];
      ok(notQuotes.every((q) => { const r = merged1([{ ...quoted, quote: q }])[0]; return !!r && !("quote" in r) && !("quote_basis" in r) && r.value === "1"; }),
        "Q8: a quote that is not a string, or empty or blank, is dropped (with its quote_basis); the source is stored as a stamp");
      eq(merged1([{ ...quoted, quote_basis: "aapningstider_paa_siden" }])[0]?.quote_basis, "aapningstider_paa_siden", "Q9: quote_basis «aapningstider_paa_siden» is kept");
      ok(["annet", "TIDER_I_SITATET", " tider_i_sitatet", 1, null, ["tider_i_sitatet"]].every((b) => {
        const r = merged1([{ ...quoted, quote_basis: b }])[0];
        return r?.quote === QUOTE && !("quote_basis" in r);
      }), "Q10: any other quote_basis is dropped, the quote kept");
      const basisOnly = merged1([{ ...stamp, quote_basis: "tider_i_sitatet" }])[0];
      ok(!!basisOnly && !("quote_basis" in basisOnly) && !("quote" in basisOnly), "Q11: quote_basis without a quote is dropped");
    }
    {
      const brreg = { source_type: "brreg", value: "1", fetched_at: "2026-08-01T00:00:00Z" };
      const google = { source_type: "google_places", value: "1", fetched_at: "2026-08-02T00:00:00Z" };
      eq(merged1([quoted], { acute_vakt: [stamp] }), [quoted], "Q12: a quote replaces the stored stamp with the same source_type::value (the list does not grow)");
      eq(merged1([quoted], { acute_vakt: [brreg, stamp, google] }), [brreg, quoted, google], "Q13: ... in the stamp's place, the other sources untouched");
      const older = { ...stamp, quote: OLD_QUOTE, quote_basis: "aapningstider_paa_siden" };
      eq(merged1([quoted], { acute_vakt: [older] }), [quoted], "Q14: a quote replaces an older quote with the same key");
      eq(merged1([quoted], { acute_vakt: [stamp, google, older, { ...stamp, value: " 1 " }] }), [quoted, google],
        "Q15: every stored source with the key goes, the quote takes the first one's place (only the newest has a quote)");
      eq(merged1([quoted], { acute_vakt: { sources: [stamp, google] } }), [quoted, google], "Q16: a stored {sources} entry is replaced the same way");
      eq(merged1([stamp], { acute_vakt: [older] }), [older], "Q17: an incoming source without a quote is a duplicate as before (the stored quote stays)");
      eq(merged1([{ ...quoted, source_type: "stage_v_correction" }], { acute_vakt: [stamp] }).map((r) => r.source_type), ["own_homepage", "stage_v_correction"],
        "Q18: a quote with another source_type does not replace the stamp; it is added");
      eq(merged1([{ ...quoted, quote: OLD_QUOTE }, quoted], { acute_vakt: [stamp] }), [quoted], "Q19: two quotes with one key in one PUT: the last one stays, once");
      eq(merged1([quoted, stamp], {}), [quoted], "Q20: a quote then a stamp with the same key in one PUT: the quote stays");
      const existing = { acute_vakt: [brreg, stamp], telefon: [{ source_type: "brreg", value: "22110099", fetched_at: "t" }] };
      const before = JSON.stringify(existing);
      const incoming = { acute_vakt: [quoted] };
      const incomingBefore = JSON.stringify(incoming);
      const merged = mergeFieldProvenance(existing, incoming as any);
      ok(JSON.stringify(existing) === before && JSON.stringify(incoming) === incomingBefore && merged.acute_vakt !== existing.acute_vakt,
        "Q21: mergeFieldProvenance does not change its inputs");
      eq(merged.telefon, existing.telefon, "Q22: other fields' provenance is untouched");
      // Other callers never send a quote: the result is the one before F1-S4d.
      eq(
        mergeFieldProvenance({ phone: [{ source_type: "google_places", value: "12345678", fetched_at: "t1" }] }, {
          phone: { sources: [{ source_type: "google_places", raw_value: "12345678", captured_at: "t2" }, { source_type: "own_homepage", value: "12345678", fetched_at: "t3" }] },
        } as any),
        { phone: [{ source_type: "google_places", value: "12345678", fetched_at: "t1" }, { value: "12345678", source_type: "own_homepage", fetched_at: "t3" }] },
        "Q23: without a quote the merge is as before (dedup keeps the first, a new source is appended)"
      );
    }
    {
      const max = PROVENANCE_QUOTE_MAX_CODE_POINTS;
      const tooth = "\u{1F9B7}";
      const cutTo = (quote: string) => merged1([{ ...quoted, quote }])[0]?.quote;
      eq(cutTo("a".repeat(max - 2) + " \u3000" + "bcd"), "a".repeat(max - 2), "Q24: a quote whose cut at 300 code points ends on whitespace is trimmed at the end");
      eq(cutTo("a".repeat(max - 1) + "\n" + "b".repeat(10)), "a".repeat(max - 1), "Q25: ... also for a line break as the 300th code point");
      // Array.from reads the first 2 × 300 UTF-16 units; these straddle that slice and the 300th code point.
      eq(cutTo("a" + tooth.repeat(max)), "a" + tooth.repeat(max - 1), "Q26a: a pair the 600-unit slice splits lies past the 300 code points kept (no lone surrogate)");
      eq(cutTo(tooth.repeat(max) + "b"), tooth.repeat(max), "Q26b: 300 pairs filling the 600 units are kept whole");
      eq(cutTo("a".repeat(max - 1) + tooth + "c"), "a".repeat(max - 1) + tooth, "Q26c: a pair as the 300th code point is kept whole");
      eq(cutTo("a".repeat(max - 1) + tooth.repeat(max)), "a".repeat(max - 1) + tooth, "Q26d: ... also with more pairs past the 600-unit slice");
      // The cost of the cut does not grow with the quote: Array.from is
      // watched for the one merge and put back before anything else runs.
      const realFrom = Array.from;
      let longest = 0;
      let long: string | undefined;
      (Array as { from: unknown }).from = function (this: unknown, items: unknown, ...rest: unknown[]) {
        if (typeof items === "string") longest = Math.max(longest, items.length);
        return (realFrom as (...args: unknown[]) => unknown).apply(this, [items, ...rest]);
      };
      try {
        long = cutTo("x".repeat(100_000));
      } finally {
        Array.from = realFrom;
      }
      ok(long === "x".repeat(max) && longest > 0 && longest <= 2 * max,
        `Q27: Array.from reads at most 600 UTF-16 units of a 100 000-unit quote (read ${longest})`);
    }

    // ── P / E: the PUT route against an in-memory DB ──────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const { toDentalClinicCard, toDentalA2aClinic } = require("../services/dental-clinic-card") as typeof import("../services/dental-clinic-card");
    const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;
    const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;

    let org = 919900000;
    const mk = (navn: string, acuteVakt: 0 | 1 | null, fp: unknown): string => {
      const id = store.createDentalAgent({
        navn, org_nr: String(++org), poststed: "AKUTTBY", fylke: "Oslo", adresse: "Storgata 1",
        telefon: "22110099", hjemmeside: "https://klinikk.example.no",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', acute_vakt = ?, field_provenance = ? WHERE id = ?")
        .run(acuteVakt, fp === null ? null : typeof fp === "string" ? fp : JSON.stringify(fp), id);
      return id;
    };
    const put = (id: string, body: unknown) =>
      callRoute(dentalRouter, { method: "PUT", path: `/agents/${id}`, headers: { "x-admin-key": testKey }, body });
    const provColumn = (id: string) =>
      (db.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get(id) as { field_provenance: string | null }).field_provenance;
    const prov = (id: string) => JSON.parse(provColumn(id) ?? "null");
    const acuteVaktColumn = (id: string) => (db.prepare("SELECT acute_vakt FROM dental_agents WHERE id = ?").get(id) as { acute_vakt: number | null }).acute_vakt;
    const vaktIds = () => (db.prepare(`SELECT id FROM dental_agents WHERE ${DENTAL_ACUTE_VAKT_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
    const claimIds = () => (db.prepare(`SELECT id FROM dental_agents WHERE ${DENTAL_ACUTE_CLAIM_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
    const card = (id: string) => toDentalClinicCard(store.getDentalAgentById(id)!, "search");
    const telefonProv = [{ source_type: "brreg", value: "22110099", fetched_at: "2026-07-01T00:00:00Z" }];
    const withQuote = (extra: Record<string, unknown> = {}) => ({ source_type: "own_homepage", value: "1", fetched_at: "2026-10-20T00:00:00Z", source_url: PAGE, quote: QUOTE, quote_basis: "tider_i_sitatet", ...extra });
    const stampIn = (value = "1") => ({ source_type: "own_homepage", value, fetched_at: "2026-10-20T00:00:00Z", source_url: "https://klinikk.example.no" });
    const quotedStored = { ...stamp, quote: OLD_QUOTE };

    // P1/E1: a PUT with a quote on a stamped row → «Akuttvakt» everywhere.
    {
      const id = mk("Sitat Akuttvakt Tannklinikk AS", 1, { acute_vakt: [stamp], telefon: telefonProv });
      ok(card(id).akutt === "accepts" && !vaktIds().includes(id), "P0: before the PUT, the stamped row is «Tar imot akuttpasienter»");
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: { sources: [withQuote()] } } });
      ok(r.status === 200 && r.body?.updated === true, `P1: PUT acute_vakt 1 with a quote -> 200 (${r.status})`);
      eq(r.body?.acute_vakt_quote, "stored", "P2: the answer says acute_vakt_quote «stored»");
      const p = prov(id);
      eq(p.acute_vakt, [withQuote()], "P3: the stamp is replaced by the source with the quote, quote_basis and its page (one source)");
      eq(p.telefon, telefonProv, "P4: other fields' provenance stays");
      const c = card(id);
      ok(c.akutt === "vakt" && c.badges.includes("Akuttvakt") && !c.badges.includes("Tar imot akuttpasienter"), "E1: the clinic card says «Akuttvakt»");
      ok(toDentalA2aClinic(store.getDentalAgentById(id)!).acute_vakt === 1, "E2: the A2A answer gives acute_vakt 1");
      ok(vaktIds().includes(id) && claimIds().includes(id), "E3: the SQL twin DENTAL_ACUTE_VAKT_SQL picks the row (and the akutt filter still does)");
      const list = (await callRoute(seoRouter, { method: "GET", path: "/sok" })).text;
      const at = list.indexOf("Sitat Akuttvakt Tannklinikk AS");
      const listCard = at < 0 ? "" : list.slice(at, at + 1500).split("</article>")[0];
      ok(listCard.includes(`<span class="badge badge-akutt">Akuttvakt</span>`), "E4: the /sok list card says «Akuttvakt»");
    }

    // P5/E5: a PUT without a quote on a row that never had one.
    {
      const id = mk("Uten Sitat Tannklinikk AS", null, null);
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: { sources: [stampIn()] } } });
      ok(r.status === 200, "P5: PUT acute_vakt 1 without a quote -> 200 (stored)");
      eq(r.body?.acute_vakt_quote, "missing", "P6: the answer says acute_vakt_quote «missing»");
      ok(acuteVaktColumn(id) === 1 && !hasAcuteVaktQuote(prov(id)), "P7: acute_vakt 1 is stored, without a quote");
      const c = card(id);
      ok(c.akutt === "accepts" && c.badges.includes("Tar imot akuttpasienter") && !c.badges.includes("Akuttvakt"),
        "E5: the card says «Tar imot akuttpasienter», not «Akuttvakt»");
      ok(!vaktIds().includes(id) && claimIds().includes(id), "E6: not in the vakt twin, still in the akutt filter");
    }

    // P8/E7: acute_vakt without a quote on a row with an old quote removes it.
    {
      const id = mk("Gammelt Sitat Tannklinikk AS", 1, { acute_vakt: [quotedStored], telefon: telefonProv });
      ok(card(id).akutt === "vakt" && vaktIds().includes(id), "P8: before the PUT, the old quote gives «Akuttvakt»");
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [stampIn()] } });
      eq(r.body?.acute_vakt_quote, "missing", "P9: PUT acute_vakt 1 without a quote on a row with a quote -> «missing»");
      const p = prov(id);
      ok(!hasAcuteVaktQuote(p) && p.acute_vakt.length === 1 && !("quote" in p.acute_vakt[0]) && p.acute_vakt[0].fetched_at === stamp.fetched_at,
        "P10: the old quote is removed; the stamp it sat on stays (dedup keeps the stored source, as before)");
      eq(p.telefon, telefonProv, "P11: other fields' provenance stays");
      ok(card(id).akutt === "accepts" && !vaktIds().includes(id), "E7: the row is «Tar imot akuttpasienter» again, and out of the vakt twin");
    }
    {
      const id = mk("Gammelt Sitat Uten Proveniens Tannklinikk AS", 1, { acute_vakt: [{ ...quotedStored, quote_basis: "tider_i_sitatet" }], telefon: telefonProv });
      const r = await put(id, { acute_vakt: 1 });
      eq(r.body?.acute_vakt_quote, "missing", "P12: PUT acute_vakt 1 with no field_provenance on a row with a quote -> «missing»");
      const p = prov(id);
      ok(!hasAcuteVaktQuote(p) && p.acute_vakt.length === 1 && !("quote_basis" in p.acute_vakt[0]),
        "P13: ... the old quote and its quote_basis are removed though the body has no field_provenance");
      ok(Array.isArray(r.body?.fields_updated) && r.body.fields_updated.includes("field_provenance"), "P14: ... and fields_updated says field_provenance was written");
      eq(p.telefon, telefonProv, "P15: ... other fields' provenance stays");
    }
    {
      const id = mk("Uten Sitat Uten Proveniens Tannklinikk AS", 1, { acute_vakt: [stamp], telefon: telefonProv });
      const before = provColumn(id);
      const r = await put(id, { acute_vakt: 1 });
      eq(r.body?.acute_vakt_quote, "missing", "P16: PUT acute_vakt 1 alone on a row without a quote -> «missing»");
      ok(provColumn(id) === before && !r.body.fields_updated.includes("field_provenance"), "P17: ... with nothing to remove, field_provenance is not written (byte-identical)");
    }
    {
      const id = mk("Vakt Null Tannklinikk AS", 1, { acute_vakt: [quotedStored] });
      const r = await put(id, { acute_vakt: 0, field_provenance: { acute_vakt: [stampIn("0")] } });
      eq(r.body?.acute_vakt_quote, "missing", "P18: PUT acute_vakt 0 without a quote -> «missing»");
      ok(acuteVaktColumn(id) === 0 && !hasAcuteVaktQuote(prov(id)), "P19: acute_vakt 0 also removes the stored quote");
      ok(card(id).akutt === null, "P20: ... and the card has no akutt claim");
    }
    {
      const id = mk("Vakt Ukjent Tannklinikk AS", 1, { acute_vakt: [quotedStored] });
      const r = await put(id, { acute_vakt: null });
      ok(r.status === 200 && r.body?.acute_vakt_quote === "missing" && acuteVaktColumn(id) === null && !hasAcuteVaktQuote(prov(id)),
        "P21: acute_vakt null (valid in the schema) also removes the stored quote");
    }

    // P22–P30: a quote that is not kept.
    {
      const id = mk("Sitat Pa Null Tannklinikk AS", 0, null);
      const r = await put(id, { acute_vakt: 0, field_provenance: { acute_vakt: [withQuote({ value: "0" })] } });
      eq(r.body?.acute_vakt_quote, "dropped", "P22: a quote on a source with value \"0\" (acute_vakt 0) -> «dropped»");
      ok(!hasAcuteVaktQuote(prov(id)) && prov(id).acute_vakt.length === 1 && prov(id).acute_vakt[0].value === "0", "P23: ... it is not stored, the stamp is");
    }
    {
      const id = mk("Sitat Pa Feil Kilde Tannklinikk AS", 0, null);
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [withQuote({ value: "0" }), stampIn()] } });
      ok(r.body?.acute_vakt_quote === "dropped" && !hasAcuteVaktQuote(prov(id)) && card(id).akutt === "accepts",
        "P24: with acute_vakt 1, a quote on a source with value \"0\" is not stored either -> «dropped», «Tar imot akuttpasienter»");
    }
    {
      const id = mk("Sitat Uten Vaktfelt Tannklinikk AS", 1, { acute_vakt: [stamp] });
      const sent = withQuote();
      const body = { field_provenance: { acute_vakt: [sent] } };
      const r = await put(id, body);
      ok(r.body?.acute_vakt_quote === "dropped" && !hasAcuteVaktQuote(prov(id)) && card(id).akutt === "accepts",
        "P25: a quote with no acute_vakt in the body -> «dropped», not stored, no «Akuttvakt»");
      ok(body.field_provenance.acute_vakt[0] === sent && sent.quote === QUOTE, "P26: the request body is not changed");
    }
    {
      const id = mk("Sitat Strippet Vaktfelt Tannklinikk AS", 1, { acute_vakt: [quotedStored] });
      const before = prov(id);
      const r = await put(id, { acute_vakt: 2, field_provenance: { acute_vakt: [withQuote()] } });
      ok(r.status === 200 && r.body?.stripped_fields?.includes("acute_vakt") && r.body?.acute_vakt_quote === "dropped",
        "P27: acute_vakt stripped (2 is not 0 or 1) -> the incoming quote is «dropped»");
      ok(acuteVaktColumn(id) === 1 && canon(prov(id).acute_vakt) === canon(before.acute_vakt),
        "P28: ... and, with no acute_vakt in the validated body, the column and the stored quote are as they were");
    }
    {
      const id = mk("Sitat Ikke Streng Tannklinikk AS", 0, null);
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [withQuote({ quote: 42 }), withQuote({ quote: "   ", source_type: "homepage" })] } });
      ok(r.body?.acute_vakt_quote === "missing" && !hasAcuteVaktQuote(prov(id)), "P29: a quote that is not a string, or blank, is no quote -> «missing»");
    }
    {
      const id = mk("Sitat Uten Kildetype Tannklinikk AS", 0, null);
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [withQuote({ source_type: "" })] } });
      ok(r.body?.acute_vakt_quote === "dropped" && card(id).akutt === null, "P30: a quote on a source normaliseSource rejects (no source_type) -> «dropped»");
    }

    // P31–P36: the other shapes and PUTs that are not about acute_vakt.
    {
      const id = mk("Innpakket Sitat Tannklinikk AS", 1, { acute_vakt: { sources: [quotedStored] } });
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [stampIn()] } });
      ok(r.body?.acute_vakt_quote === "missing" && !hasAcuteVaktQuote(prov(id)) && card(id).akutt === "accepts", "P31: a stored {sources} entry loses its quote too");
    }
    {
      const id = mk("Enkeltpost Sitat Tannklinikk AS", 1, { acute_vakt: quotedStored });
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [stampIn()] } });
      const p = prov(id);
      ok(r.body?.acute_vakt_quote === "missing" && Array.isArray(p.acute_vakt) && !hasAcuteVaktQuote(p) && card(id).akutt === "accepts",
        "P32: a stored single-record entry (which the merge wraps in an array) loses its quote too");
    }
    {
      const id = mk("Annet Felt Tannklinikk AS", 1, { acute_vakt: [quotedStored], telefon: telefonProv });
      const before = provColumn(id);
      const r = await put(id, { telefon: "22110099" });
      ok(r.status === 200 && !("acute_vakt_quote" in r.body) && provColumn(id) === before, "P33: a PUT not about acute_vakt has no acute_vakt_quote and leaves field_provenance byte-identical");
      const r2 = await put(id, { patient_focus: ["barn"], field_provenance: { patient_focus: [{ source_type: "own_homepage", value: "barn", fetched_at: "t" }] } });
      ok(r2.status === 200 && !("acute_vakt_quote" in r2.body) && canon(prov(id).acute_vakt) === canon([quotedStored]) && card(id).akutt === "vakt",
        "P34: a PUT with another field's provenance keeps the stored acute_vakt quote");
    }
    {
      const id = mk("Nullstilt Proveniens Tannklinikk AS", 1, { acute_vakt: [quotedStored] });
      const r = await put(id, { acute_vakt: 1, field_provenance: null });
      ok(r.status === 200 && r.body?.acute_vakt_quote === "missing" && provColumn(id) === null, "P35: field_provenance null still clears the column, quote and all");
    }
    {
      const r = await put("finnes-ikke", { acute_vakt: 1, field_provenance: { acute_vakt: [withQuote()] } });
      eq(r.status, 404, "P36: an unknown id is still 404");
    }
    {
      const id = mk("Langt Sitat Tannklinikk AS", 0, null);
      const long = "Nye pasienter tas imot akutt hver kveld. ".repeat(10);
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [withQuote({ quote: long, quote_basis: "aapningstider_paa_siden" })] } });
      const stored = prov(id).acute_vakt[0];
      ok(r.body?.acute_vakt_quote === "stored" && Array.from(stored.quote as string).length === 300 && long.trim().startsWith(stored.quote) &&
        stored.quote_basis === "aapningstider_paa_siden", "P37: through the PUT, a long quote is stored cut to 300 code points, with its quote_basis");
    }
    {
      const id = mk("Nytt Sitat Tannklinikk AS", 1, { acute_vakt: [{ ...quotedStored, quote_basis: "aapningstider_paa_siden" }] });
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [withQuote({ quote_basis: "noe annet" })] } });
      const p = prov(id).acute_vakt;
      ok(r.body?.acute_vakt_quote === "stored" && p.length === 1 && p[0].quote === QUOTE && !("quote_basis" in p[0]),
        "P38: a new quote replaces the old one (one source); an unknown quote_basis is not stored and the old one does not linger");
    }

    // P39–P43: acute_vakt with no field_provenance in the body removes the
    // stored quotes and writes every other entry back as stored, also those
    // that are not lists of sources: `inactive` and `hjemmeside`, built here
    // by the helpers the mark-inactive and hjemmeside-cleanup routes write
    // with, and a source whose value is not a string.
    {
      const { mergeInactiveProvenance } = require("./admin-dental-mark-inactive") as typeof import("./admin-dental-mark-inactive");
      const { mergeHjemmesideCleanupProvenance } = require("./admin-dental-hjemmeside-cleanup") as typeof import("./admin-dental-hjemmeside-cleanup");
      const inactive = { reason: "Nedlagt ifølge Brønnøysund", marked_inactive_at: "2026-10-01T08:00:00.000Z" };
      const hjemmeside = { cleaned_reason: "directory", previous_value: "https://www.gulesider.no/klinikk", cleaned_at: "2026-10-02T09:00:00.000Z" };
      const behandlere = [{ source_type: "own_homepage", value: 4, fetched_at: "2026-09-01T00:00:00Z" }];
      const column = (acuteVaktEntry: unknown) =>
        mergeHjemmesideCleanupProvenance(
          mergeInactiveProvenance(JSON.stringify({ acute_vakt: acuteVaktEntry, telefon: telefonProv, antall_behandlere: behandlere }), inactive),
          hjemmeside
        );
      const quotedWithBasis = { ...quotedStored, quote_basis: "aapningstider_paa_siden" };
      const shapes: Array<[string, unknown, unknown]> = [
        ["array", [quotedWithBasis, { source_type: "brreg", value: "1", fetched_at: "t" }], [stamp, { source_type: "brreg", value: "1", fetched_at: "t" }]],
        ["{sources}", { sources: [quotedWithBasis], note: "stage_v" }, { sources: [stamp], note: "stage_v" }],
        ["single record", quotedWithBasis, stamp],
      ];
      for (const [shape, stored, expected] of shapes) {
        const id = mk(`Revisjon ${shape} Tannklinikk AS`, 1, column(stored));
        const r = await put(id, { acute_vakt: 1 });
        ok(r.status === 200 && r.body?.acute_vakt_quote === "missing" && r.body.fields_updated.includes("field_provenance"),
          `P39 (${shape}): PUT acute_vakt 1 with no field_provenance on a row with a quote and audit entries -> 200, «missing», field_provenance written`);
        ok(provColumn(id) === column(expected),
          `P40 (${shape}): the column is the stored one with only quote and quote_basis removed, byte for byte (got ${provColumn(id)})`);
        const p = prov(id);
        ok(canon(p.inactive) === canon(inactive) && canon(p.hjemmeside) === canon(hjemmeside) && canon(p.antall_behandlere) === canon(behandlere),
          `P41 (${shape}): the inactive and hjemmeside entries and the source with a number value survive`);
        ok(!(provColumn(id) ?? "").includes(`"quote`) && !hasAcuteVaktQuote(p) && card(id).akutt !== "vakt",
          `P42 (${shape}): the acute_vakt quote is gone (no «Akuttvakt»)`);
      }
      const id = mk("Revisjon Uten Sitat Tannklinikk AS", 1, column([stamp]));
      const before = provColumn(id);
      const r = await put(id, { acute_vakt: 1 });
      ok(r.status === 200 && provColumn(id) === before && !r.body.fields_updated.includes("field_provenance"),
        "P43: with audit entries and no quote to remove, field_provenance is not written (byte-identical)");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental-agent-put-acute-vakt-quote: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (analyticsService as any).logWebSearch = realLogWebSearch;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/dental-agent-put-acute-vakt-quote.test.ts`
if (require.main === module) {
  runDentalAgentPutAcuteVaktQuoteTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failures.length) console.log(summary.failures.join("\n"));
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

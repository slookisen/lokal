/**
 * dental-agent-put-audit-entries.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, F1-S4f.
 *
 * Other routes write audit entries into dental field_provenance on purpose:
 * `inactive` (admin-dental-mark-inactive), `hjemmeside` from the hjemmeside
 * cleanup (admin-dental-hjemmeside-cleanup) and `directory_url` from the
 * offentlig klinikk correction. The PR-28 filter in mergeFieldProvenance made
 * each of them `[]` on every dental PUT with field_provenance. By prefix:
 *   A   mergeFieldProvenance with keepAuditEntries (admin-knowledge.ts): an
 *       audit entry is kept as stored, as a field's entry or in its list;
 *       sources for a field with an audit entry go in a list after it,
 *       unchanged; PR-28 still drops malformed source records; an object
 *       with a quote or quote_basis is not an audit entry; the readers
 *       (fieldProvenanceRecords, buildProvenanceSummary, the akutt claim) see
 *       the same sources as without the audit entry; the inputs are not
 *       changed. Without the option (every caller but the dental PUT, the
 *       RFB/knowledge ones among them) the result is as before.
 *   U   PUT /api/tannlege/agents/:id (dental.ts): the audit entries survive
 *       a PUT with field_provenance for other fields and for their own
 *       field; the public answer, the Places rule, the provenance summary and
 *       the akutt claim and its SQL twins are as for a row without them.
 *   S   Stage V's correction (POST /admin/stage-v-drift-result →
 *       recordStageVFieldObservation, dental-store.ts) and
 *   P   the Places batch (POST /admin/google-places-batch, dental.ts), the
 *       other two dental writers that merge the column: the audit entries,
 *       also the PUT's list with the cleanup's entry first, survive byte for
 *       byte, and the writer's own sources are stored as on a row without
 *       them.
 *   N   (lock) the dental legacy-shape normalize (admin-agent-audit.ts)
 *       merges without the option: it only rewrites a {sources} wrapper, so
 *       the audit entries next to one stay as stored.
 *
 * Setup mirrors dental-agent-put-acute-vakt-quote.test.ts: a fresh in-memory
 * dental DB (DENTAL_DB_PATH=":memory:"), fresh requires through
 * swapOutModules, and the router exercised with router.handle(). The Places
 * batch gets a mocked global fetch (no network) and a test Places key.
 *
 * Standalone: npx tsx src/routes/dental-agent-put-audit-entries.test.ts
 * Wired into tests/test.ts via runDentalAgentPutAuditEntriesTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method,
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: {},
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
      send(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "unhandled") } }));
  });
}

const QUOTE = "Vi tar imot nye pasienter for akutt behandling hver kveld til kl. 22 og i helgene.";

export async function runDentalAgentPutAuditEntriesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  // Byte for byte: the audit entries are stored as written, key order and all.
  const same = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  // JSON with each object's keys sorted, for sources normaliseSource builds
  // (its key order is not what is tested).
  const canon = (v: unknown): string =>
    JSON.stringify(v, (_key, x) =>
      x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x
    );
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(canon(actual) === canon(expected), `${label} (expected ${canon(expected)}, got ${canon(actual)})`);
  // A list whose first element is an audit entry: that element byte for byte, the list as sources.
  const auditFirst = (actual: unknown, entry: unknown, expected: unknown[], label: string) =>
    ok(Array.isArray(actual) && JSON.stringify(actual[0]) === JSON.stringify(entry) && canon(actual) === canon([entry, ...expected]),
      `${label} (expected ${canon([entry, ...expected])}, got ${JSON.stringify(actual)})`);

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const prevFetch = (globalThis as any).fetch;
  const testKey = process.env.ADMIN_KEY || "dental-put-audit-entries-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental"),
    require.resolve("./admin-agent-audit"),
  ]);

  try {
    const { mergeFieldProvenance, isProvenanceAuditEntry } = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const { mergeInactiveProvenance } = require("./admin-dental-mark-inactive") as typeof import("./admin-dental-mark-inactive");
    const { mergeHjemmesideCleanupProvenance } = require("./admin-dental-hjemmeside-cleanup") as typeof import("./admin-dental-hjemmeside-cleanup");
    const { mergeOffentligKlinikkKorrigeringProvenance } =
      require("./admin-dental-offentlig-klinikk-hjemmeside-korrigering") as typeof import("./admin-dental-offentlig-klinikk-hjemmeside-korrigering");
    const { fieldProvenanceRecords, __setPlacesDisplayPolicyForTesting } =
      require("../services/places-display-policy") as typeof import("../services/places-display-policy");
    const { buildProvenanceSummary } = require("../services/cross-source-validator") as typeof import("../services/cross-source-validator");
    const { hasAcuteVaktProvenance, hasAcuteVaktQuote, resolveAcuteClaim, DENTAL_ACUTE_CLAIM_SQL, DENTAL_ACUTE_VAKT_SQL } =
      require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");

    // The entries as the three routes write them, through their own helpers.
    const inactive = { reason: "Nedlagt ifølge Brønnøysund", marked_inactive_at: "2026-10-01T08:00:00.000Z" };
    const hjemmeside = { cleaned_reason: "directory", previous_value: "https://www.gulesider.no/klinikk", cleaned_at: "2026-10-02T09:00:00.000Z" };
    const directoryUrl = { moved_reason: "offentlig_klinikk_korrigering" as const, previous_field: "hjemmeside" as const, moved_at: "2026-10-03T10:00:00.000Z" };
    const telefonProv = [{ source_type: "brreg", value: "22110099", fetched_at: "2026-07-01T00:00:00Z" }];
    const stamp = { source_type: "own_homepage", value: "1", fetched_at: "2026-09-01T00:00:00Z", source_url: "https://klinikk.example.no" };
    const auditColumn = (base: Record<string, unknown>) =>
      mergeHjemmesideCleanupProvenance(mergeInactiveProvenance(JSON.stringify(base), inactive), hjemmeside);
    const stored = JSON.parse(auditColumn({ telefon: telefonProv, acute_vakt: [stamp] })) as Record<string, unknown>;
    const keep = { keepAuditEntries: true } as const;
    const site = (value: string, source_type = "own_homepage", fetched_at = "2026-10-20T00:00:00Z") => ({ source_type, value, fetched_at, source_url: value });

    // ── A: mergeFieldProvenance ───────────────────────────────────────────
    {
      ok([inactive, hjemmeside, directoryUrl, { status: "unverified", url: "https://x.example" }].every(isProvenanceAuditEntry),
        "A1: the three routes' entries are audit entries (as is another object with no source key)");
      const notAudit: unknown[] = [
        null, undefined, "tekst", 4, true, [], [inactive], {},
        { source_type: "auto", source_url: "https://example.com", confidence: 0.7, fetched_at: "t" },
        { value: "X" }, { value: 4, source_type: "own_homepage" }, { sources: [] }, { sources: "not-an-array" },
        { quote: QUOTE }, { quote_basis: "tider_i_sitatet", note: "x" }, stamp,
      ];
      ok(notAudit.every((v) => !isProvenanceAuditEntry(v)),
        "A2: a primitive, a list, an empty object, a source record (well-formed or not), the {sources} wrapper and an object with quote or quote_basis are not");
    }
    {
      const incoming = { telefon: [{ source_type: "own_homepage", value: "22110099", fetched_at: "2026-10-20T00:00:00Z" }] };
      const merged = mergeFieldProvenance(stored, incoming as any, keep);
      same(merged.inactive, inactive, "A3: with keepAuditEntries, `inactive` survives a merge of another field's sources, as stored");
      same(merged.hjemmeside, hjemmeside, "A4: ... and the hjemmeside cleanup's entry");
      eq(merged.telefon, [...telefonProv, incoming.telefon[0]], "A5: ... while the other field merges as before");
      same(merged.acute_vakt, [stamp], "A6: ... and a field the PUT does not touch keeps its sources");
      const withDirectory = JSON.parse(mergeOffentligKlinikkKorrigeringProvenance("{}", directoryUrl, {
        source_type: "brreg_registered_website", value: "https://ny.example.no", source_url: "https://ny.example.no",
        replaced_offentlig_klinikk_host: "https://kommune.example.no", fetched_at: "2026-10-03T10:00:00.000Z",
      }));
      const merged2 = mergeFieldProvenance(withDirectory, incoming as any, keep);
      same(merged2.directory_url, directoryUrl, "A7: the offentlig klinikk correction's `directory_url` entry survives too");
      same(merged2.hjemmeside, [withDirectory.hjemmeside], "A8: ... and its hjemmeside source is a source (wrapped in a list, as before)");
    }
    {
      // Without the option: as before F1-S4f, for the RFB/knowledge callers.
      const incoming = { telefon: [{ source_type: "own_homepage", value: "22110099", fetched_at: "t2" }] };
      const merged = mergeFieldProvenance(stored, incoming as any);
      same(merged.inactive, [], "A9: without keepAuditEntries, `inactive` becomes [] as before (other callers unchanged)");
      same(merged.hjemmeside, [], "A10: ... and so does `hjemmeside`");
      const rfb = mergeFieldProvenance({ website_ownership: { status: "unverified", reason: "homepage_name_mismatch" }, phone: [] }, incoming as any);
      same(rfb.website_ownership, [], "A11: ... and RFB's website_ownership marker (no change for RFB in this slice)");
      same(mergeFieldProvenance(stored, incoming as any, { keepAuditEntries: false } as any), merged, "A12: keepAuditEntries false is the default");
    }
    {
      // PR-28 still applies to source records that are malformed.
      const legacy = { source_type: "auto", source_url: "https://example.com", evidence_level: "B", confidence: 0.7, fetched_at: "2026-05-01T00:00:00Z", verifier: "backfill-phase51" };
      const valueOnly = { value: "Storgata 1" };
      const numberValue = { source_type: "own_homepage", value: 4, fetched_at: "t" };
      const merged = mergeFieldProvenance({
        adresse: [legacy, valueOnly, { source_type: "brreg", value: "Storgata 1", fetched_at: "t" }],
        phone: legacy,
        antall_behandlere: [numberValue],
        lat: numberValue,
        z: { sources: "not-an-array" },
        w: { sources: [null, { source_type: "a", value: "1", fetched_at: "t1" }] },
        tekst: "en streng",
        tall: 4,
        tom: null,
        tomt_objekt: {},
        inactive,
      }, {}, keep);
      same(merged.adresse, [{ source_type: "brreg", value: "Storgata 1", fetched_at: "t" }],
        "A13: with the option, PR-28 still drops records without value or source_type from a list");
      same(merged.phone, [], "A14: ... and a single legacy record without value (wrapped, filtered)");
      same([merged.antall_behandlere, merged.lat], [[], []], "A15: ... and a source whose value is not a string");
      same([merged.z, merged.w], [[], [{ source_type: "a", value: "1", fetched_at: "t1" }]], "A16: ... and the {sources} wrapper reads as before");
      ok(!("tekst" in merged) && !("tall" in merged) && !("tom" in merged), "A17: a primitive or null entry is dropped as before");
      same(merged.tomt_objekt, [], "A18: an empty object records nothing and becomes [] as before");
      same(merged.inactive, inactive, "A19: ... while the audit entry next to them stays");
      const inList = mergeFieldProvenance({ hjemmeside: [hjemmeside, legacy, site("https://a.example.no")] }, {}, keep);
      same(inList.hjemmeside, [hjemmeside, site("https://a.example.no")], "A20: an audit entry in a list stays in its place; a malformed record next to it goes");
    }
    {
      // A PUT with sources for a field whose entry is an audit entry.
      const a = site("https://ny.example.no");
      const b = site("https://ny.example.no", "brreg_registered_website");
      const merged = mergeFieldProvenance(stored, { hjemmeside: { sources: [a, b, { ...a, fetched_at: "t9" }] } } as any, keep);
      auditFirst(merged.hjemmeside, hjemmeside, [a, b], "A21: sources for a field with an audit entry: a list with the entry first, unchanged, then the sources (deduped as before)");
      const none = mergeFieldProvenance(stored, { hjemmeside: [{ value: "https://ny.example.no" }, { source_type: "own_homepage", value: "  " }] } as any, keep);
      same(none.hjemmeside, hjemmeside, "A22: when no incoming source is kept, the audit entry stays as stored (not wrapped)");
      const next = mergeFieldProvenance(merged as Record<string, unknown>, { hjemmeside: [a, site("https://ny.example.no", "google_places")] } as any, keep);
      auditFirst(next.hjemmeside, hjemmeside, [a, b, site("https://ny.example.no", "google_places")],
        "A23: the next merge keeps the entry first: a duplicate is a duplicate, a new source is appended");
      const quoted = { ...a, quote: "Velkommen til klinikken.", fetched_at: "2026-10-21T00:00:00Z" };
      const replaced = mergeFieldProvenance(merged as Record<string, unknown>, { hjemmeside: [quoted] } as any, keep);
      auditFirst(replaced.hjemmeside, hjemmeside, [quoted, b], "A24: a source with a quote replaces its key's source (F1-S4d) and never the audit entry");
      // The readers see the same sources as for the same merge without the entry.
      const control = mergeFieldProvenance({ ...stored, hjemmeside: [] }, { hjemmeside: { sources: [a, b] } } as any, keep);
      same(fieldProvenanceRecords(merged, ["website", "hjemmeside"]), fieldProvenanceRecords(control, ["website", "hjemmeside"]),
        "A25: fieldProvenanceRecords (the Places rule) reads the same sources with the audit entry in the list");
      same(buildProvenanceSummary(merged, "2026-10-20T00:00:00Z"), buildProvenanceSummary(control, "2026-10-20T00:00:00Z"),
        "A26: ... as does buildProvenanceSummary (the provenance summary on /agents/:id)");
    }
    {
      // acute_vakt: the akutt claim reads every element of the list.
      const note = { kontrollert_at: "2026-10-05T00:00:00Z", merknad: "manuell" };
      const merged = mergeFieldProvenance({ acute_vakt: note }, { acute_vakt: [stamp] } as any, keep);
      auditFirst(merged.acute_vakt, note, [stamp], "A27: an audit entry under acute_vakt takes the sources after it");
      const control = mergeFieldProvenance({}, { acute_vakt: [stamp] } as any, keep);
      ok(hasAcuteVaktProvenance(merged) === hasAcuteVaktProvenance(control) && hasAcuteVaktQuote(merged) === hasAcuteVaktQuote(control) &&
        resolveAcuteClaim({ acute_vakt: 1, field_provenance: merged }) === resolveAcuteClaim({ acute_vakt: 1, field_provenance: control }),
        "A28: ... and the akutt claim is the one without it («Tar imot akuttpasienter», no «Akuttvakt»)");
      ok(resolveAcuteClaim({ acute_vakt: 1, field_provenance: mergeFieldProvenance({ acute_vakt: note }, {}, keep) }) ===
        resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: note } }), "A29: with nothing incoming the claim is the stored row's");
      const quoteOnly = mergeFieldProvenance({ acute_vakt: { quote: QUOTE, note: "x" } }, { acute_vakt: [stamp] } as any, keep);
      ok(!hasAcuteVaktQuote(quoteOnly) && resolveAcuteClaim({ acute_vakt: 1, field_provenance: quoteOnly }) === "accepts",
        "A30: an object with a quote but no source_type or value is not an audit entry: PR-28 drops it, so it never gives «Akuttvakt» from a list");
    }
    {
      const incoming = { hjemmeside: [site("https://ny.example.no")], telefon: [{ source_type: "own_homepage", value: "22110099", fetched_at: "t" }] };
      const before = JSON.stringify(stored);
      const incomingBefore = JSON.stringify(incoming);
      const merged = mergeFieldProvenance(stored, incoming as any, keep);
      ok(JSON.stringify(stored) === before && JSON.stringify(incoming) === incomingBefore && merged.hjemmeside !== stored.hjemmeside,
        "A31: mergeFieldProvenance with keepAuditEntries does not change its inputs");
    }

    // ── U: the PUT route against an in-memory DB ──────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const { dentalPlacesVerdicts } = require("../services/dental-places-display") as typeof import("../services/dental-places-display");
    const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;

    let org = 919800000;
    const mk = (navn: string, fp: unknown, extra: { acuteVakt?: 0 | 1 | null; hjemmeside?: string | null } = {}): string => {
      const id = store.createDentalAgent({
        navn, org_nr: String(++org), poststed: "REVISJONSBY", fylke: "Oslo", adresse: "Storgata 1", telefon: "22110099",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', acute_vakt = ?, hjemmeside = ?, field_provenance = ?, last_verified_at = ? WHERE id = ?")
        .run(extra.acuteVakt ?? null, extra.hjemmeside ?? null, typeof fp === "string" ? fp : JSON.stringify(fp), "2026-10-15T00:00:00Z", id);
      return id;
    };
    const put = (id: string, body: unknown) =>
      callRoute(dentalRouter, { method: "PUT", path: `/agents/${id}`, headers: { "x-admin-key": testKey }, body });
    const get = (id: string) => callRoute(dentalRouter, { method: "GET", path: `/agents/${id}` });
    const prov = (id: string) =>
      JSON.parse((db.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get(id) as { field_provenance: string }).field_provenance);
    const sqlIds = (where: string) => (db.prepare(`SELECT id FROM dental_agents WHERE ${where}`).all() as Array<{ id: string }>).map((r) => r.id);

    // U1–U4: a PUT with field_provenance for another field.
    {
      const id = mk("Revisjon Annet Felt Tannklinikk AS", auditColumn({ telefon: telefonProv, acute_vakt: [stamp] }), { acuteVakt: 1 });
      const newPhone = { source_type: "own_homepage", value: "22110099", fetched_at: "2026-10-20T00:00:00Z", source_url: "https://klinikk.example.no/kontakt" };
      const r = await put(id, { telefon: "22110099", field_provenance: { telefon: { sources: [newPhone] } } });
      ok(r.status === 200 && r.body?.updated === true && r.body.fields_updated.includes("field_provenance"), `U1: PUT telefon with field_provenance -> 200 (${r.status})`);
      const p = prov(id);
      same(p.inactive, inactive, "U2: `inactive` is in the column as mark-inactive wrote it");
      same(p.hjemmeside, hjemmeside, "U3: the hjemmeside cleanup's entry is too (the moved address and why)");
      eq([p.telefon, p.acute_vakt], [[...telefonProv, newPhone], [stamp]], "U4: the telefon source is merged and acute_vakt is untouched");
    }
    // U5–U7: the F1-S4d quote path (acute_vakt with a quote) on the same kind of row.
    {
      const id = mk("Revisjon Sitat Tannklinikk AS", auditColumn({ telefon: telefonProv, acute_vakt: [{ ...stamp, quote: "Gammelt sitat om akutt." }] }), { acuteVakt: 1 });
      const quoted = { ...stamp, fetched_at: "2026-10-20T00:00:00Z", source_url: "https://klinikk.example.no/akutt", quote: QUOTE, quote_basis: "tider_i_sitatet" };
      const r = await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [quoted] } });
      ok(r.status === 200 && r.body?.acute_vakt_quote === "stored", "U5: PUT acute_vakt 1 with a quote on a row with audit entries -> «stored»");
      const p = prov(id);
      ok(JSON.stringify(p.inactive) === JSON.stringify(inactive) && JSON.stringify(p.hjemmeside) === JSON.stringify(hjemmeside),
        "U6: ... and both audit entries survive it");
      eq(p.acute_vakt, [quoted], "U7: ... while the quote replaces the stamp as in F1-S4d");
    }
    // U8–U14: sources for hjemmeside on a row the cleanup has cleaned.
    {
      const own = { source_type: "own_homepage", value: "https://ny-klinikk.example.no", fetched_at: "2026-10-20T00:00:00Z", source_url: "https://ny-klinikk.example.no" };
      const places = { source_type: "google_places", value: "https://ny-klinikk.example.no", fetched_at: "2026-10-20T00:00:00Z" };
      const body = (source: unknown) => ({ hjemmeside: "https://ny-klinikk.example.no", field_provenance: { hjemmeside: [source] } });
      const audited = mk("Revisjon Hjemmeside Tannklinikk AS", auditColumn({ telefon: telefonProv }));
      const control = mk("Kontroll Hjemmeside Tannklinikk AS", { telefon: telefonProv, inactive: [], hjemmeside: [] });
      const r = await put(audited, body(own));
      await put(control, body(own));
      ok(r.status === 200, "U8: PUT hjemmeside with a source on a cleaned row -> 200");
      auditFirst(prov(audited).hjemmeside, hjemmeside, [own], "U9: the cleanup's entry stays, unchanged, first in the list, and the source is stored after it");
      same(prov(audited).inactive, inactive, "U10: `inactive` stays as stored");
      const shownA = (await get(audited)).body?.agent;
      const shownC = (await get(control)).body?.agent;
      ok(!!shownA && !!shownC && shownA.hjemmeside === shownC.hjemmeside && shownA.hjemmeside === "https://ny-klinikk.example.no" &&
        JSON.stringify(shownA.provenance) === JSON.stringify(shownC.provenance) && !("field_provenance" in shownA),
        "U11: the public answer (website and provenance summary) is the one for the same PUT on a row without audit entries");
      const second = { ...own, source_type: "brreg_registered_website" };
      await put(audited, body(second));
      auditFirst(prov(audited).hjemmeside, hjemmeside, [own, second], "U12: a second PUT keeps the entry first and appends the new source");

      __setPlacesDisplayPolicyForTesting(true);
      try {
        const placesA = mk("Revisjon Places Tannklinikk AS", auditColumn({ telefon: telefonProv }));
        const placesC = mk("Kontroll Places Tannklinikk AS", { telefon: telefonProv });
        await put(placesA, body(places));
        await put(placesC, body(places));
        const verdictA = dentalPlacesVerdicts(store.getDentalAgentById(placesA) as any, true).hjemmeside;
        const verdictC = dentalPlacesVerdicts(store.getDentalAgentById(placesC) as any, true).hjemmeside;
        ok(verdictA === "places_only" && verdictA === verdictC, `U13: a website only Google Places gives is hidden as on a row without the entry (${verdictA}/${verdictC})`);
        const publicA = (await get(placesA)).body?.agent;
        ok(publicA?.hjemmeside === null && JSON.stringify(prov(placesA).hjemmeside[0]) === JSON.stringify(hjemmeside) && canon(prov(placesA).hjemmeside) === canon([hjemmeside, places]),
          "U14: ... the public answer has no website, and the entry is still stored");
      } finally {
        __setPlacesDisplayPolicyForTesting(null);
      }
    }
    // U15–U17: PR-28 through the PUT, and the directory_url entry.
    {
      const legacy = { source_type: "auto", source_url: "https://example.com", confidence: 0.7, fetched_at: "2026-05-01T00:00:00Z" };
      const withDirectory = mergeOffentligKlinikkKorrigeringProvenance(
        auditColumn({ adresse: [legacy], antall_behandlere: [{ source_type: "own_homepage", value: 4, fetched_at: "t" }], telefon: telefonProv }),
        directoryUrl,
        { source_type: "search_verified_website", value: "https://ny.example.no", source_url: "https://ny.example.no", replaced_offentlig_klinikk_host: "https://kommune.example.no", fetched_at: "t" },
      );
      const id = mk("Revisjon PR28 Tannklinikk AS", withDirectory);
      const r = await put(id, { telefon: "22110099", field_provenance: { telefon: [{ source_type: "own_homepage", value: "22110099", fetched_at: "t2" }] } });
      const p = prov(id);
      ok(r.status === 200 && JSON.stringify([p.adresse, p.antall_behandlere]) === "[[],[]]",
        "U15: PR-28 still drops the malformed records (no value; a value that is not a string)");
      same(p.directory_url, directoryUrl, "U16: the offentlig klinikk correction's directory_url entry survives");
      ok(JSON.stringify(p.inactive) === JSON.stringify(inactive) && Array.isArray(p.hjemmeside) && p.hjemmeside[0]?.replaced_offentlig_klinikk_host === "https://kommune.example.no",
        "U17: ... next to `inactive`, and the correction's hjemmeside source is kept as a source");
    }
    // U18–U20: the akutt claim and its SQL twins on a row with an audit entry under acute_vakt.
    {
      const note = { kontrollert_at: "2026-10-05T00:00:00Z", merknad: "manuell" };
      const audited = mk("Revisjon Akutt Tannklinikk AS", { acute_vakt: note });
      const control = mk("Kontroll Akutt Tannklinikk AS", {});
      for (const id of [audited, control]) await put(id, { acute_vakt: 1, field_provenance: { acute_vakt: [{ ...stamp, fetched_at: "2026-10-20T00:00:00Z" }] } });
      auditFirst(prov(audited).acute_vakt, note, [{ ...stamp, fetched_at: "2026-10-20T00:00:00Z" }], "U18: the entry stays first under acute_vakt");
      const claimIds = sqlIds(DENTAL_ACUTE_CLAIM_SQL);
      const vaktIds = sqlIds(DENTAL_ACUTE_VAKT_SQL);
      ok(claimIds.includes(audited) && claimIds.includes(control) && !vaktIds.includes(audited) && !vaktIds.includes(control),
        "U19: the SQL twins treat both rows alike (in the akutt filter, not «Akuttvakt»)");
      ok(resolveAcuteClaim(store.getDentalAgentById(audited) as any) === "accepts" && resolveAcuteClaim(store.getDentalAgentById(control) as any) === "accepts",
        "U20: ... as does the card's claim («Tar imot akuttpasienter»)");
    }

    // ── S and P: the other two dental writers ─────────────────────────────
    const AUDIT_KEYS = ["inactive", "hjemmeside", "directory_url"];
    const korrigeringSource = {
      source_type: "brreg_registered_website", value: "https://ny.example.no", source_url: "https://ny.example.no",
      replaced_offentlig_klinikk_host: "https://kommune.example.no", fetched_at: "2026-10-03T10:00:00.000Z",
    };
    // All three audit entries, each written by its own route's helper (the
    // correction first, so the cleanup's hjemmeside entry is the one left).
    const allAudit = (base: Record<string, unknown>) =>
      mergeHjemmesideCleanupProvenance(
        mergeInactiveProvenance(mergeOffentligKlinikkKorrigeringProvenance(JSON.stringify(base), directoryUrl, korrigeringSource), inactive),
        hjemmeside,
      );
    // The writer's own sources carry the time of the run: compare them without it.
    const runStamped = (v: unknown, types: string[]) =>
      JSON.parse(JSON.stringify(v, (_key, x) =>
        x && typeof x === "object" && !Array.isArray(x) && types.includes(x.source_type) && typeof x.fetched_at === "string" ? { ...x, fetched_at: "<run>" } : x));
    const withoutAudit = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !AUDIT_KEYS.includes(k)));
    const post = (path: string, body: unknown) => callRoute(dentalRouter, { method: "POST", path, headers: { "x-admin-key": testKey }, body });
    const ownSite = { source_type: "own_homepage", value: "https://ny-klinikk.example.no", fetched_at: "2026-10-18T00:00:00Z", source_url: "https://ny-klinikk.example.no" };
    // The PUT's list for hjemmeside on a cleaned row: the cleanup's entry first, then the source.
    const putConflictRow = async (label: string, navn: string, base: Record<string, unknown>) => {
      const id = mk(navn, auditColumn(base));
      const r = await put(id, { hjemmeside: ownSite.value, field_provenance: { hjemmeside: [ownSite] } });
      ok(r.status === 200, `${label}: setup, PUT hjemmeside with a source on a cleaned row -> 200 (${r.status})`);
      auditFirst(prov(id).hjemmeside, hjemmeside, [ownSite], `${label}: setup, the PUT stored [the cleanup's entry, the source] for hjemmeside`);
      return id;
    };

    // S0–S7: Stage V's correction (two matching contradictions → helfo_agreement corrected).
    {
      const helfoProv = [{ source_type: "own_homepage", value: "true", fetched_at: "2026-08-01T00:00:00Z", source_url: "https://klinikk.example.no/helfo" }];
      const base = { telefon: telefonProv, helfo_agreement: helfoProv };
      const audited = mk("Revisjon Stage V Tannklinikk AS", allAudit(base));
      const control = mk("Kontroll Stage V Tannklinikk AS", base);
      const conflict = await putConflictRow("S0", "Revisjon Stage V Liste Tannklinikk AS", base);
      const conflictBefore = JSON.stringify(prov(conflict).hjemmeside);
      const observe = (id: string) => post("/admin/stage-v-drift-result", { agentId: id, field: "helfo_agreement", value: "false" });
      const corrected: boolean[] = [];
      for (const id of [audited, control, conflict]) {
        db.prepare("UPDATE dental_agents SET helfo_agreement = 'true' WHERE id = ?").run(id);
        const first = await observe(id);
        const second = await observe(id);
        corrected.push(first.status === 200 && first.body?.pending === true && second.status === 200 && second.body?.corrected === true);
      }
      ok(corrected.every(Boolean), `S1: Stage V corrects helfo_agreement on all three rows (${JSON.stringify(corrected)})`);
      const pA = prov(audited);
      same(pA.inactive, inactive, "S2: after Stage V's correction `inactive` is in the column as mark-inactive wrote it");
      same(pA.hjemmeside, hjemmeside, "S3: ... and the hjemmeside cleanup's entry");
      same(pA.directory_url, directoryUrl, "S4: ... and the offentlig klinikk correction's directory_url entry");
      eq(runStamped(pA.helfo_agreement, ["stage_v_correction"]), [...helfoProv, { source_type: "stage_v_correction", value: "false", fetched_at: "<run>" }],
        "S5: Stage V's source is appended to helfo_agreement as before");
      eq(runStamped(withoutAudit(pA), ["stage_v_correction"]), runStamped(prov(control), ["stage_v_correction"]),
        "S6: ... and the rest of the column is the one Stage V writes on a row without audit entries");
      ok(JSON.stringify(prov(conflict).hjemmeside) === conflictBefore && JSON.stringify(prov(conflict).inactive) === JSON.stringify(inactive),
        `S7: the PUT's list with the cleanup's entry first survives Stage V byte for byte (${JSON.stringify(prov(conflict).hjemmeside)})`);
    }

    // P0–P7: the Places batch (write:true, mocked Places answer, no network).
    // Run with the A6 switch on: the fixture asserts the pre-A6 website/phone writes.
    // Likewise the A5 switch: it asserts the pre-A5 Places address write.
    {
      (require("../services/places-match") as typeof import("../services/places-match")).__setDentalPlacesContactFieldsFetchForTesting(true);
      (require("../services/places-match") as typeof import("../services/places-match")).__setPlacesAddressFetchForTesting(true);
      process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
      const placesSite = "https://revisjon-places.example.no";
      (globalThis as any).fetch = async (url: unknown, init?: any) => {
        if (!String(url).includes("places.googleapis.com")) throw new Error(`unexpected fetch ${String(url)}`);
        const textQuery = String(JSON.parse(String(init?.body ?? "{}")).textQuery ?? "");
        const place = {
          displayName: { text: textQuery.replace(/ REVISJONSBY Norway$/, "") },
          addressComponents: [{ longText: "0150", shortText: "0150", types: ["postal_code"] }],
          formattedAddress: "Storgata 1, 0150 Oslo, Norge",
          internationalPhoneNumber: "+47 22 11 00 99",
          websiteUri: placesSite,
        };
        return { ok: true, status: 200, json: async () => ({ places: [place] }), text: async () => "{}" };
      };
      const base = { telefon: telefonProv };
      const audited = mk("Revisjon Places Batch Tannklinikk AS", allAudit(base));
      const control = mk("Kontroll Places Batch Tannklinikk AS", base);
      const conflict = await putConflictRow("P0", "Revisjon Places Batch Liste Tannklinikk AS", base);
      const conflictBefore = JSON.stringify(prov(conflict).hjemmeside);
      const ids = [audited, control, conflict];
      for (const id of ids) db.prepare("UPDATE dental_agents SET postnummer = '0150' WHERE id = ?").run(id);
      const r = await post("/admin/google-places-batch", { agentIds: ids, write: true });
      const statuses = (r.body?.data?.results ?? []).map((x: any) => x.status);
      ok(r.status === 200 && JSON.stringify(statuses) === JSON.stringify(["matched", "matched", "matched"]),
        `P1: the Places batch matches all three rows (${r.status} ${JSON.stringify(statuses)})`);
      const pA = prov(audited);
      same(pA.inactive, inactive, "P2: after the Places batch `inactive` is in the column as mark-inactive wrote it");
      same(pA.hjemmeside, hjemmeside, "P3: ... and the hjemmeside cleanup's entry");
      same(pA.directory_url, directoryUrl, "P4: ... and the offentlig klinikk correction's directory_url entry");
      ok(Array.isArray(pA.website) && pA.website.length === 1 && pA.website[0].source_type === "google_places" && pA.website[0].value === placesSite &&
        Array.isArray(pA.address) && pA.address[0]?.source_type === "google_places" && Array.isArray(pA.phone) && pA.phone[0]?.source_type === "google_places",
        `P5: the batch's google_places sources are stored (website, address, phone): ${JSON.stringify([pA.website, pA.address, pA.phone])}`);
      eq(runStamped(withoutAudit(pA), ["google_places"]), runStamped(prov(control), ["google_places"]),
        "P6: ... and the rest of the column is the one the batch writes on a row without audit entries");
      ok(JSON.stringify(prov(conflict).hjemmeside) === conflictBefore && JSON.stringify(prov(conflict).inactive) === JSON.stringify(inactive),
        `P7: the PUT's list with the cleanup's entry first survives the Places batch byte for byte (${JSON.stringify(prov(conflict).hjemmeside)})`);
      (require("../services/places-match") as typeof import("../services/places-match")).__setDentalPlacesContactFieldsFetchForTesting(null);
      (require("../services/places-match") as typeof import("../services/places-match")).__setPlacesAddressFetchForTesting(null);
    }

    // N1–N2 (lock): the legacy-shape normalize takes no option and needs none.
    {
      const auditRouter = (require("./admin-agent-audit") as typeof import("./admin-agent-audit")).default as any;
      const good = { source_type: "brreg", value: "22110099", fetched_at: "2026-07-01T00:00:00Z" };
      const id = mk("Revisjon Normalize Tannklinikk AS", allAudit({ telefon: { sources: [good, { source_type: "own_homepage", fetched_at: "t" }] } }));
      const r = await callRoute(auditRouter, {
        method: "POST", path: "/field-provenance-legacy-shape-normalize", headers: { "x-admin-key": testKey }, body: { apply: 1 },
      });
      const p = prov(id);
      ok(r.status === 200 && r.body?.apply === true && JSON.stringify(p.telefon) === JSON.stringify([good]),
        `N1: the normalize (apply) unwraps the {sources} wrapper and drops the malformed record (${r.status} ${JSON.stringify(p.telefon)})`);
      ok(JSON.stringify([p.inactive, p.hjemmeside, p.directory_url]) === JSON.stringify([inactive, hjemmeside, directoryUrl]),
        "N2: ... and leaves the three audit entries as stored, without keepAuditEntries");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental-agent-put-audit-entries: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
    (globalThis as any).fetch = prevFetch;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/dental-agent-put-audit-entries.test.ts`
if (require.main === module) {
  runDentalAgentPutAuditEntriesTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failures.length) console.log(summary.failures.join("\n"));
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}

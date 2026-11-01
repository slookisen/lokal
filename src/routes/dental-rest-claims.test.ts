/**
 * dental-rest-claims.test.ts -- A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S7 (Daniel's answer
 * to question 29, 2026-10-19). GET /api/tannlege/agents and /agents/:id give
 * acute_vakt and helfo_agreement as the clinic card does, without the admin
 * key; with it, the stored values as before. By prefix:
 *   S   the vakt twin (DENTAL_ACUTE_VAKT_SQL), which the raw acute_vakt=1
 *       filter uses, picks exactly the rows publicAcuteVakt() answers 1 for,
 *       over a table of provenance and patient_focus shapes;
 *   F   the fields without the key, list and /:id: acute_vakt 1 without a
 *       quote (a stamp, no provenance, akutt only in patient_focus) is null,
 *       with the quote 1; acute_vakt 0 and null as stored; helfo_agreement
 *       'true' without a source is "unknown", with one "true";
 *   K   the same fields with a valid X-Admin-Key: the stored values and
 *       field_provenance (a wrong key gets the public answer);
 *   M   every filter value without the key (acute_vakt 0/1, helfo_agreement
 *       true/false/unknown) lists exactly the rows whose field in the
 *       unfiltered answer has that value; with the key the column filters;
 *       the public search filter still lists the patient_focus clinic;
 *   C   for every clinic, REST and the card (toDentalClinicCard,
 *       toDentalA2aClinic) say the same about Helfo and akutt;
 *   H   Cache-Control: private and Vary: X-Admin-Key on both routes;
 *   O   the switch off: every answer and filter is the stored one, as on
 *       main (the admin-key answer, less field_provenance), and the admin
 *       answer is the same with the switch on or off;
 *   N   no row is written.
 *
 * Standalone: npx tsx src/routes/dental-rest-claims.test.ts
 * Wired into tests/test.ts via runDentalRestClaimsTests().
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

interface RouteResult { status: number; body: any; headers: Record<string, string>; vary: string[] }

function callRoute(router: any, path: string, query: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<RouteResult> {
  return new Promise((resolve) => {
    const id = path.startsWith("/agents/") ? path.slice("/agents/".length) : undefined;
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: id ? { id } : {}, query, headers, ip: "127.0.0.1", get() { return undefined; } };
    const set: Record<string, string> = {};
    const vary: string[] = [];
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      setHeader(k: string, v: string) { set[k.toLowerCase()] = v; return this; },
      set(k: string, v: string) { set[k.toLowerCase()] = v; return this; },
      header(k: string, v: string) { set[k.toLowerCase()] = v; return this; },
      vary(v: string) { vary.push(v); return this; },
      send(p: any) { resolve({ status: this.statusCode, body: p, headers: set, vary }); return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p, headers: set, vary }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: null, headers: set, vary }));
  });
}

export async function runDentalRestClaimsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => {
    if (c) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  const sorted = (xs: string[]) => [...xs].sort();

  const prevDb = process.env.DENTAL_DB_PATH;
  const prevKey = process.env.ADMIN_KEY;
  const adminKey = "dental-rest-claims-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = adminKey;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("../services/dental-clinic-card"),
    require.resolve("../services/dental-rest-claims"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const restClaims = require("../services/dental-rest-claims") as typeof import("../services/dental-rest-claims");

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const card = require("../services/dental-clinic-card") as typeof import("../services/dental-clinic-card");
    const { DENTAL_ACUTE_VAKT_SQL, resolveAcuteClaim } = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
    const { resolveHelfoClaim } = require("../services/dental-helfo-claim") as typeof import("../services/dental-helfo-claim");
    const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;
    const key = { "x-admin-key": adminKey };

    eq(restClaims.REST_CLAIMS_REQUIRE_SOURCE, true, "S0: the switch is on by default");

    // ── S: DENTAL_ACUTE_VAKT_SQL against publicAcuteVakt ────────────────
    {
      const provenances: Array<string | null> = [
        null, "", "{bad", "[]", "{}", '{"acute_vakt":null}', '{"acute_vakt":[]}', '{"acute_vakt":[null]}',
        '{"acute_vakt":[{"source_type":"homepage","value":1}]}',
        '{"acute_vakt":{"sources":[{"source_type":"stage_v_correction"}]}}',
        '{"acute_vakt":[{"source_type":"homepage","value":1,"quote":"Vi har akuttvakt i helgene."}]}',
        '{"acute_vakt":{"sources":[{"source_type":"stage_v_correction","quote":"Akuttvakt hver kveld"}]}}',
        '{"acute_vakt":[{"quote":""}]}', '{"acute_vakt":[{"quote":"  \\u00a0 "}]}', '{"acute_vakt":[{"quote":1}]}',
        '{"acute_vakt":{"quote":"utenfor sources"}}', '{"helfo_agreement":[{"quote":"Akuttvakt"}]}',
      ];
      const foci: Array<string | null> = [null, '["Tar imot akuttpasienter"]', '["barn"]', "{bad"];
      const ins = db.prepare("INSERT INTO dental_agents (id, navn, poststed, fylke, acute_vakt, field_provenance, patient_focus) VALUES (?,?,?,?,?,?,?)");
      let n = 0;
      for (const acute of [null, 0, 1]) for (const fp of provenances) for (const pf of foci) {
        ins.run(`spar-${n}`, `Paritet ${n}`, "PARITETBY", "Oslo", acute, fp, pf);
        n++;
      }
      const all = store.listDentalAgents({ poststed: "PARITETBY" }, 500, 0, { sourcedClaims: false });
      const jsIds = all.filter((r) => card.publicAcuteVakt(r) === 1).map((r) => r.id);
      const sqlIds = (db.prepare(`SELECT id FROM dental_agents WHERE id LIKE 'spar-%' AND ${DENTAL_ACUTE_VAKT_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
      ok(all.length === n && jsIds.length > 0 && jsIds.length < all.filter((r) => r.acute_vakt === 1).length,
        `S1: (the shape table has ${all.length} rows, ${jsIds.length} with «Akuttvakt»)`);
      eq(sorted(sqlIds), sorted(jsIds), "S2: DENTAL_ACUTE_VAKT_SQL picks exactly the rows publicAcuteVakt answers 1 for");
      const listed = store.listDentalAgents({ poststed: "PARITETBY", acute_vakt: 1 }, 500, 0, { sourcedClaims: true }).map((r) => r.id);
      eq(sorted(listed), sorted(jsIds), "S3: listDentalAgents with sourcedClaims and acute_vakt 1 lists the same rows");
      db.prepare("DELETE FROM dental_agents WHERE id LIKE 'spar-%'").run();
    }

    // ── The fixture: one place, every combination the rule tells apart ──
    const quote = [{ source_type: "homepage", source_url: "https://example.no/akutt", value: 1, quote: "Vi har akuttvakt alle kvelder." }];
    const stamp = [{ source_type: "homepage", source_url: "https://example.no/akutt", value: 1 }];
    const helfoSrc = [{ value: "true", source_type: "homepage", source_url: "https://example.no/helfo", fetched_at: "2026-09-15T10:00:00.000Z" }];
    const mk = (navn: string, org: string, acute: 0 | 1 | null, helfo: string, fp: object | null, focus: string[] | null) => {
      const id = store.createDentalAgent({ navn, org_nr: org, poststed: "RESTBY", fylke: "Oslo", adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class='klinikk', acute_vakt=?, helfo_agreement=?, field_provenance=?, patient_focus=? WHERE id=?")
        .run(acute, helfo, fp ? JSON.stringify(fp) : null, focus ? JSON.stringify(focus) : null, id);
      return { id, navn };
    };
    const VQ = mk("Vakt Sitat Tannklinikk AS", "918990001", 1, "true", { acute_vakt: quote, helfo_agreement: helfoSrc }, null);
    const VS = mk("Vakt Stempel Tannklinikk AS", "918990002", 1, "true", { acute_vakt: stamp }, null);
    const VU = mk("Vakt Uten Kilde Tannklinikk AS", "918990003", 1, "false", null, null);
    const FO = mk("Akutt Fokus Tannklinikk AS", "918990004", null, "unknown", null, ["Tar imot akuttpasienter"]);
    const FF = mk("Fokus Og Flagg Tannklinikk AS", "918990005", 1, "true", { helfo_agreement: [{ value: "true", fetched_at: "2026-09-15T10:00:00.000Z" }] }, ["Tar imot akuttpasienter"]);
    const NU = mk("Ingen Akutt Tannklinikk AS", "918990006", 0, "false", { acute_vakt: stamp }, null);
    const HO = mk("Helfo Objekt Tannklinikk AS", "918990007", null, "true", { helfo_agreement: { sources: [{ value: "true", source_type: "stage_v_correction" }] } }, null);
    const fixture = [VQ, VS, VU, FO, FF, NU, HO];
    const fixtureIds = fixture.map((c) => c.id);
    const columns = () => JSON.stringify(db.prepare("SELECT id, acute_vakt, helfo_agreement, field_provenance, patient_focus FROM dental_agents ORDER BY id").all());
    const before = columns();

    const list = async (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
      (await callRoute(dentalRouter, "/agents", { poststed: "RESTBY", limit: "500", ...query }, headers));
    const one = async (id: string, headers: Record<string, string> = {}) => (await callRoute(dentalRouter, `/agents/${id}`, {}, headers));
    const byId = (agents: any[]) => Object.fromEntries(agents.map((a) => [a.id, a]));
    const fields = (a: any) => [a?.acute_vakt, a?.helfo_agreement];

    // ── F: the fields without the key ───────────────────────────────────
    const expected: Record<string, [0 | 1 | null, string]> = {
      [VQ.id]: [1, "true"],
      [VS.id]: [null, "unknown"],
      [VU.id]: [null, "false"],
      [FO.id]: [null, "unknown"],
      [FF.id]: [null, "unknown"],
      [NU.id]: [0, "false"],
      [HO.id]: [null, "true"],
    };
    const pubList = await list();
    eq(pubList.status, 200, "F0: GET /agents without the key -> 200");
    eq(Object.keys(pubList.body), ["count", "agents"], "F0b: envelope {count, agents} unchanged");
    eq(sorted(pubList.body.agents.map((a: any) => a.id)), sorted(fixtureIds), "F0c: the same rows as before (no row left out)");
    const pubById = byId(pubList.body.agents);
    for (const c of fixture) {
      eq(fields(pubById[c.id]), expected[c.id], `F1 list ${c.navn}: acute_vakt and helfo_agreement as the card gives them`);
      const r = await one(c.id);
      eq(Object.keys(r.body), ["agent"], `F2 /:id ${c.navn}: envelope {agent} unchanged`);
      eq(fields(r.body.agent), expected[c.id], `F3 /:id ${c.navn}: the same values`);
      ok(!("field_provenance" in r.body.agent), `F4 /:id ${c.navn}: no field_provenance (A4-D, unchanged)`);
    }
    {
      const storedKeys = Object.keys((await list({}, key)).body.agents[0]).filter((k) => k !== "field_provenance");
      eq(Object.keys(pubList.body.agents[0]), storedKeys, "F5: every key in the same place as in the stored answer (less field_provenance)");
    }

    // ── K: with a valid key the stored values ───────────────────────────
    const adminList = await list({}, key);
    const adminById = byId(adminList.body.agents);
    for (const c of fixture) {
      const stored = store.getDentalAgentById(c.id)!;
      eq(fields(adminById[c.id]), [stored.acute_vakt, stored.helfo_agreement], `K1 list ${c.navn}: the stored values with the key`);
      const r = await one(c.id, key);
      eq(fields(r.body.agent), [stored.acute_vakt, stored.helfo_agreement], `K2 /:id ${c.navn}: the stored values with the key`);
      ok("field_provenance" in r.body.agent, `K3 /:id ${c.navn}: field_provenance with the key (as before)`);
      eq(fields((await one(c.id, { "x-admin-key": "wrong" })).body.agent), expected[c.id], `K4 /:id ${c.navn}: a wrong key gets the public values`);
    }

    // ── M: every filter value against the field ─────────────────────────
    const fieldOf = (field: "acute_vakt" | "helfo_agreement", value: string) =>
      pubList.body.agents.filter((a: any) => String(a[field]) === value).map((a: any) => a.id);
    for (const [field, value] of [["acute_vakt", "1"], ["acute_vakt", "0"], ["helfo_agreement", "true"], ["helfo_agreement", "false"], ["helfo_agreement", "unknown"]] as const) {
      const r = await list({ [field]: value });
      const ids = r.body.agents.map((a: any) => a.id);
      ok(r.body.agents.every((a: any) => String(a[field]) === value), `M1 ${field}=${value}: every listed clinic has ${field} ${value} in the answer`);
      eq(sorted(ids), sorted(fieldOf(field, value)), `M2 ${field}=${value}: exactly the clinics whose ${field} is ${value}`);
      const stored = sorted(store.listDentalAgents({ poststed: "RESTBY", [field]: field === "acute_vakt" ? Number(value) : value } as any, 500, 0).map((a) => a.id));
      eq(sorted((await list({ [field]: value }, key)).body.agents.map((a: any) => a.id)), stored, `M3 ${field}=${value}: with the key the stored column (as on main)`);
    }
    {
      const akutt = (await list({ acute_vakt: "1" })).body.agents.map((a: any) => a.id);
      eq(akutt, [VQ.id], "M4: acute_vakt=1 without the key: only the clinic with the quote");
      ok(!akutt.includes(VS.id) && !akutt.includes(VU.id), "M5: acute_vakt 1 without a quote (stamp or none) is not in acute_vakt=1 matches");
      ok(!akutt.includes(FO.id) && !akutt.includes(FF.id), "M6: akutt only in patient_focus is not in acute_vakt=1 matches");
      const helfo = (await list({ helfo_agreement: "true" })).body.agents.map((a: any) => a.id);
      eq(sorted(helfo), sorted([VQ.id, HO.id]), "M7: helfo_agreement=true without the key: only the clinics with a source");
      const publicAkutt = store.listPublicDentalAgents({ poststed: "RESTBY", acute_vakt: 1 } as any, 500, 0).map((a) => a.id);
      ok(publicAkutt.includes(FO.id) && publicAkutt.includes(FF.id) && publicAkutt.includes(VS.id),
        "M8: the public search filter (MCP, A2A, /sok) still lists the patient_focus and stamped clinics");
    }

    // ── C: REST and the card agree ──────────────────────────────────────
    for (const c of fixture) {
      const stored = store.getDentalAgentById(c.id)!;
      const rest = pubById[c.id];
      const search = card.toDentalClinicCard(stored, "search");
      const a2a = card.toDentalA2aClinic(stored);
      eq(rest.helfo_agreement, search.helfo_agreement, `C1 ${c.navn}: helfo_agreement as on the search card`);
      eq(rest.helfo_agreement, a2a.helfo_agreement, `C2 ${c.navn}: helfo_agreement as in A2A`);
      ok((rest.helfo_agreement === "true") === (resolveHelfoClaim(stored) !== null), `C3 ${c.navn}: "true" exactly when the card shows the Helfo claim`);
      ok((rest.acute_vakt === 1) === (a2a.acute_vakt === 1) && (rest.acute_vakt === 1) === (search.akutt === "vakt"),
        `C4 ${c.navn}: acute_vakt 1 exactly when the card says «Akuttvakt»`);
      ok(rest.acute_vakt !== 1 || resolveAcuteClaim(stored) === "vakt", `C5 ${c.navn}: no acute_vakt 1 without the quote`);
    }

    // ── H: the answer depends on the key, so no shared cache keeps it ────
    for (const [label, path, query] of [["/agents", "/agents", { poststed: "RESTBY" }], ["/agents/:id", `/agents/${VS.id}`, {}]] as const) {
      for (const [who, headers] of [["no key", {}], ["valid key", key], ["wrong key", { "x-admin-key": "wrong" }]] as const) {
        const r = await callRoute(dentalRouter, path, query as Record<string, string>, headers as Record<string, string>);
        ok(r.headers["cache-control"] === "private" && r.vary.includes("X-Admin-Key"), `H1 ${label}, ${who}: Cache-Control: private, Vary: X-Admin-Key`);
      }
    }
    {
      const policy = require("../services/places-display-policy") as typeof import("../services/places-display-policy");
      policy.__setPlacesDisplayPolicyForTesting(false);
      try {
        const r = await list();
        ok(r.headers["cache-control"] === "private" && r.vary.includes("X-Admin-Key"), "H2: with the Places rule off, F2-S7 still sets both headers");
        eq(fields(byId(r.body.agents)[VS.id]), expected[VS.id], "H3: ... and still gives the card's values");
      } finally {
        policy.__setPlacesDisplayPolicyForTesting(null);
      }
    }

    // ── O: the switch off -> as on main ─────────────────────────────────
    restClaims.__setRestClaimsRequireSourceForTesting(false);
    try {
      const offList = await list();
      const offAdmin = await list({}, key);
      const withoutProv = (a: any) => { const { field_provenance: _p, ...rest } = a; return rest; };
      eq(JSON.stringify(offList.body), JSON.stringify({ count: adminList.body.count, agents: adminList.body.agents.map(withoutProv) }),
        "O1: switch off -> /agents without the key is the stored answer less field_provenance (as on main)");
      eq(JSON.stringify(offAdmin.body), JSON.stringify(adminList.body), "O2: the admin answer is the same with the switch on and off");
      for (const c of fixture) {
        const off = (await one(c.id)).body.agent;
        eq(JSON.stringify(off), JSON.stringify(withoutProv((await one(c.id, key)).body.agent)), `O3 /:id ${c.navn}: switch off -> the stored answer less field_provenance`);
      }
      for (const [field, value] of [["acute_vakt", "1"], ["acute_vakt", "0"], ["helfo_agreement", "true"], ["helfo_agreement", "false"], ["helfo_agreement", "unknown"]] as const) {
        const stored = sorted(store.listDentalAgents({ poststed: "RESTBY", [field]: field === "acute_vakt" ? Number(value) : value } as any, 500, 0).map((a) => a.id));
        eq(sorted((await list({ [field]: value })).body.agents.map((a: any) => a.id)), stored, `O4 ${field}=${value}: switch off -> the stored column filter`);
      }
    } finally {
      restClaims.__setRestClaimsRequireSourceForTesting(null);
    }

    // ── N: nothing written ──────────────────────────────────────────────
    eq(columns() === before, true, "N1: no acute_vakt, helfo_agreement, field_provenance or patient_focus value was written");
  } catch (err: any) {
    failed++;
    failures.push("dental rest claims: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    restClaims.__setRestClaimsRequireSourceForTesting(null);
    if (prevDb === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDb;
    if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    restoreModuleCache();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalRestClaimsTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

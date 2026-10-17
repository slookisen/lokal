/**
 * dental-clinic-card.test.ts — A2A dev-request
 * 2026-10-16-tannlege-mcp-instrukser-og-klinikkort, S4b.
 *
 * One clinic card for MCP and A2A (services/dental-clinic-card.ts), against an
 * in-memory fixture DB. Groups, by prefix:
 *   K   the search card's key contract: the required keys always, the
 *       optional ones only with a value, every key the card had before S4b;
 *       buildSearchResults delegates to the card;
 *   V   values: address, postcode, booking link, compact opening hours,
 *       specialties, trimmed chain, akutt vakt/accepts/null, profile URL;
 *   H   compact opening hours (one line per set of hours);
 *   P   prisniva only with a source and a canonical band other than «ukjent»;
 *   R   no key with «rating» in any variant, although the row has a rating;
 *   T   phones only when isDisplayablePhone passes;
 *   A   A2A message/send (search list and single clinic): the row's keys and
 *       id kept, rating fields and field_provenance gone, acute_vakt only
 *       with provenance, phones displayable, every search-card key with the
 *       card's value (a row key the card leaves out is null); the clinic ids
 *       are read as before;
 *   D   tannlege_info (the detail card) keeps exactly its keys; e-mail only
 *       there;
 *   M   MCP tannlege_search / tannlege_akutt over a real server + client,
 *       and the same card values as the A2A clinic with the same id;
 *   Z   size: 25 clinics per call stay under 12 KB for a live-like mix, and
 *       under 16 KB when every clinic has every optional field.
 *
 * Standalone: npx tsx src/services/dental-clinic-card.test.ts
 * Wired into tests/test.ts via runDentalClinicCardTests().
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

/** The search card's keys, in order: required, and optional (left out without a value). */
const REQUIRED_KEYS = ["navn", "org_nr", "adresse", "postnummer", "poststed", "fylke", "telefon", "hjemmeside", "helfo_agreement", "akutt", "badges", "profil_url"];
const ALL_KEYS = [
  "navn", "org_nr", "adresse", "postnummer", "poststed", "fylke", "telefon", "hjemmeside", "online_booking_url", "apningstider",
  "helfo_agreement", "akutt", "spesialiteter", "chain_brand", "prisniva", "badges", "profil_url",
];
/** The search card before S4b (buildSearchResults, pr114-04). */
const PRE_S4B_KEYS = ["navn", "org_nr", "poststed", "fylke", "telefon", "hjemmeside", "helfo_agreement", "badges", "profil_url"];
/** tannlege_info's keys before S4b. */
const DETAIL_KEYS = [
  "id", "org_nr", "navn", "adresse", "postnummer", "poststed", "fylke", "telefon", "mobil", "epost", "hjemmeside", "helfo_agreement",
  "acute_vakt", "chain_brand", "is_chain_member", "available_specialties", "treatments", "opening_hours", "payment_options", "om_oss",
  "online_booking_url", "specialists", "badges", "profil_url",
];
const A2A_REMOVED = ["rating", "rating_count", "rating_source", "field_provenance"];

const PROVENANCE = { acute_vakt: [{ source_type: "homepage", value: 1 }], telefon: [{ source_type: "brreg" }] };
const UNDISPLAYABLE_PHONE = "+47 19 09 49";
const WEEKDAYS_8_16 = ["mon", "tue", "wed", "thu", "fri"].map((day) => ({ day, open: "08:00", close: "16:00" }));

export async function runDentalClinicCardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
    require.resolve("./dental-catalog-class"),
    require.resolve("./dental-search-gazetteer"),
    require.resolve("./dental-clinic-card"),
    require.resolve("../routes/dental-seo"),
    require.resolve("../routes/dental-mcp"),
    require.resolve("../routes/dental-a2a"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("./dental-store") as typeof import("./dental-store");
    (require("./dental-search-gazetteer") as typeof import("./dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const card = require("./dental-clinic-card") as typeof import("./dental-clinic-card");
    const seo = require("../routes/dental-seo") as typeof import("../routes/dental-seo");
    const mcp = require("../routes/dental-mcp") as typeof import("../routes/dental-mcp");
    const a2a = require("../routes/dental-a2a") as typeof import("../routes/dental-a2a");
    const { isDisplayablePhone } = require("./contact-normalizer") as typeof import("./contact-normalizer");
    const { hasAcuteVaktProvenance } = require("./dental-acute-claim") as typeof import("./dental-acute-claim");

    // ── Fixture ───────────────────────────────────────────────────────────
    // Columns createDentalAgent does not write (booking link, hours, price
    // source, provenance, rating, …) are set with an UPDATE, as the enrichment
    // and the PR-130 rating job store them.
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent(row as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", ...extra };
      const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
        .run({ ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, json(v)])), id });
      return id;
    };
    const full = add(
      {
        navn: "Tannlege Nordmann AS", org_nr: "918750001", adresse: "Strandgaten 12", postnummer: "5013", poststed: "BERGEN", fylke: "Vestland",
        telefon: "55 30 40 50", mobil: UNDISPLAYABLE_PHONE, epost: "post@tannlegenordmann.no", hjemmeside: "https://www.tannlegenordmann.no",
        helfo_agreement: "true", verification_status: "verified", available_specialties: ["kjeveortopedi"], chain_brand: "  Colosseum Tannlege ",
      },
      {
        online_booking_url: "https://tannlegenordmann.no/bestill-time",
        opening_hours: [...WEEKDAYS_8_16.slice(0, 3), { day: "thu", open: "08:00", close: "19:00" }, { day: "fri", open: "08:00", close: "15:00" }],
        price_band: "standard", price_band_source: "homepage", acute_vakt: 1, field_provenance: PROVENANCE,
        rating: 4.7, rating_count: 120, rating_source: "google_places",
      },
    );
    const bare = add(
      { navn: "Tann Uten Data AS", poststed: "OSLO", fylke: "Oslo", telefon: UNDISPLAYABLE_PHONE },
      { acute_vakt: 1, price_band: "premium", rating: 3.9, rating_count: 8, rating_source: "google_places" },
    );
    const soft = add(
      { navn: "Akuttfokus Tannklinikk AS", org_nr: "918750003", poststed: "BERGEN", fylke: "Vestland", telefon: "55112233" },
      { patient_focus: ["Akutt", "barn"], price_band: "ukjent", price_band_source: "homepage" },
    );
    // An off-spec band from before the 2026-08-25 enum guard, with a source.
    const offSpec = add({ navn: "Gammel Prisklasse Tann AS", org_nr: "918750004", poststed: "BERGEN", fylke: "Vestland" }, { price_band: "medium", price_band_source: "homepage" });
    // Blank values the card leaves out: a price source, a chain name and a booking link.
    const blankSource = add(
      { navn: "Blank Kilde Tann AS", org_nr: "918750005", poststed: "BERGEN", fylke: "Vestland" },
      { price_band: "rimelig", price_band_source: "  ", chain_brand: "   ", online_booking_url: "" },
    );
    const sourced = add({ navn: "Rimelig Med Kilde Tann AS", org_nr: "918750006", poststed: "BERGEN", fylke: "Vestland" }, { price_band: "rimelig", price_band_source: "website" });

    const row = (id: string) => store.getDentalAgentById(id)!;
    const search = (id: string) => card.toDentalClinicCard(row(id), "search") as Record<string, any>;

    // ── K: key contract ───────────────────────────────────────────────────
    eq(Object.keys(search(full)), ALL_KEYS, "K1: a clinic with every value has every key, in order");
    eq(Object.keys(search(bare)), REQUIRED_KEYS, "K2: a clinic without the optional values has only the required keys");
    for (const [label, id] of [["full", full], ["bare", bare]] as const) {
      ok(PRE_S4B_KEYS.every((k) => k in search(id)), `K3 ${label}: every key of the pre-S4b card is still there`);
    }
    {
      const rows = [full, bare, soft].map(row);
      ok(JSON.stringify(mcp.buildSearchResults(rows)) === JSON.stringify(rows.map((r) => card.toDentalClinicCard(r, "search"))), "K4: buildSearchResults is the search card");
    }

    // ── V: values ─────────────────────────────────────────────────────────
    {
      const c = search(full);
      eq([c.adresse, c.postnummer, c.online_booking_url], ["Strandgaten 12", "5013", "https://tannlegenordmann.no/bestill-time"], "V1: address, postcode and booking link");
      eq(c.apningstider, ["Man–Ons 08:00–16:00", "Tor 08:00–19:00", "Fre 08:00–15:00"], "V2: opening hours as compact lines");
      eq([c.spesialiteter, c.chain_brand], [["kjeveortopedi"], "Colosseum Tannlege"], "V3: specialties, and the chain name trimmed (display only)");
      eq([c.akutt, c.badges], ["vakt", ["Helfo-avtale", "Akuttvakt", "Verifisert", "Spesialist"]], "V4: akutt «vakt» with provenance, badges as before");
      eq([c.telefon, c.profil_url], ["55 30 40 50", seo.clinicProfileUrl(row(full))], "V5: displayable phone, profile URL from clinicProfileUrl");
    }
    {
      const c = search(bare);
      eq([c.adresse, c.postnummer, c.akutt], [null, null, null], "V6: no address -> null; acute_vakt without provenance -> akutt null");
      ok(c.profil_url === seo.clinicProfileUrl(row(bare)) && c.profil_url.endsWith(`/klinikk/id/${bare}`), "V7: a clinic without org.nr links to /klinikk/id/<id> (clinicProfileUrl)");
      eq([search(soft).akutt, search(soft).badges], ["accepts", ["Tar imot akuttpasienter"]], "V8: akutt focus without the flag -> «accepts» and the soft badge");
      {
        const r = row(blankSource);
        ok(r.chain_brand === "   " && r.online_booking_url === "", "V9: (the fixture row has a blank chain name and an empty booking link)");
        eq(["chain_brand", "online_booking_url"].filter((k) => k in search(blankSource)), [], "V10: a blank chain name and an empty booking link are left out of the card");
      }
    }

    // ── H: compact opening hours ──────────────────────────────────────────
    {
      const hours = (opening_hours: unknown) => card.toDentalClinicCard({ ...row(bare), opening_hours } as any, "search").apningstider;
      eq(hours(WEEKDAYS_8_16), ["Man–Fre 08:00–16:00"], "H1: Monday–Friday with the same hours is one line");
      eq(hours([{ day: "mon", open: "08:00", close: "16:00" }, { day: "tue", open: "09:00", close: "17:00" }, { day: "wed", open: "08:00", close: "16:00" }]),
        ["Man/Ons 08:00–16:00", "Tir 09:00–17:00"], "H2: days apart with the same hours share a line");
      eq(hours([...WEEKDAYS_8_16, { day: "sat", open: "10:00", close: "14:00" }]), ["Man–Fre 08:00–16:00", "Lør 10:00–14:00"], "H3: Saturday's own hours on their own line");
      eq(hours("Etter avtale"), ["Etter avtale"], "H4: stored free text is shown as it is");
      eq([hours(null), hours([])], [undefined, undefined], "H5: no hours -> no apningstider key");
      {
        const noted = { day: "tue", open: "08:00", close: "16:00", note: "Sesongåpent til ca. 20. september" };
        const { normalizeOpeningHours, openingHoursEntryText } = require("../utils/opening-hours") as typeof import("../utils/opening-hours");
        eq(hours([noted, ...WEEKDAYS_8_16.filter((h) => h.day === "mon" || h.day === "wed")]),
          [openingHoursEntryText(normalizeOpeningHours([noted])[0]!), "Man/Ons 08:00–16:00"], "H6: a day with a note of its own keeps its own line; the others share theirs");
      }
    }

    // ── P: prisniva ───────────────────────────────────────────────────────
    eq(search(full).prisniva, "standard", "P1: a canonical band with a source is shown");
    eq(search(sourced).prisniva, "rimelig", "P2: «rimelig» with a source is shown");
    ok(!("prisniva" in search(bare)), "P3: a band without a source is not shown");
    ok(!("prisniva" in search(soft)), "P4: «ukjent» is not shown, source or not");
    ok(!("prisniva" in search(offSpec)), "P5: an off-spec stored band («medium») is not shown");
    ok(!("prisniva" in search(blankSource)), "P6: a blank source is no source");

    // ── R: no rating ──────────────────────────────────────────────────────
    {
      const r = row(full);
      ok(r.rating === 4.7 && r.rating_count === 120 && r.rating_source === "google_places", "R0: (the fixture row has a Google rating)");
      const variants: Array<[string, object]> = [
        ["search", card.toDentalClinicCard(r, "search")],
        ["detail", card.toDentalClinicCard(r, "detail", { specialists: [] })],
        ["a2a", card.toDentalA2aClinic(r)],
      ];
      for (const [label, v] of variants) eq(Object.keys(v).filter((k) => /rating/i.test(k)), [], `R1 ${label}: no key contains «rating»`);
    }

    // ── T: phones ─────────────────────────────────────────────────────────
    {
      ok(!isDisplayablePhone(UNDISPLAYABLE_PHONE), "T0: (the fixture's bad number is not displayable)");
      const r = row(bare);
      eq([search(bare).telefon, card.toDentalClinicCard(r, "detail", { specialists: [] }).telefon, card.toDentalA2aClinic(r).telefon], [null, null, null],
        "T1: an undisplayable telefon is null in the search, detail and A2A card");
      const f = row(full);
      eq([card.toDentalClinicCard(f, "detail", { specialists: [] }).mobil, card.toDentalA2aClinic(f).mobil], [null, null], "T2: an undisplayable mobil is null in the detail and A2A card");
    }

    // ── A: A2A ────────────────────────────────────────────────────────────
    /** The keys of a card whose value differs in `other`, compared as JSON (as they go on the wire). */
    const differingKeys = (cardFields: Record<string, unknown>, other: Record<string, unknown>) =>
      Object.keys(cardFields).filter((k) => JSON.stringify(cardFields[k]) !== JSON.stringify(other[k]));
    /** The A2A list's clinics, compared with the MCP cards under M. */
    let a2aClinics: Array<Record<string, any>> = [];
    const a2aWireOf = (id: string) => JSON.parse(JSON.stringify(a2aClinics.find((c) => c.id === id) ?? {}));
    {
      const checkClinic = (c: Record<string, any>, label: string) => {
        const stored = row(c.id);
        eq(A2A_REMOVED.filter((k) => k in c), [], `${label}: no rating fields, no field_provenance`);
        ok(Object.keys(c).every((k) => !/rating/i.test(k)), `${label}: no key contains «rating»`);
        ok(c.telefon === null || isDisplayablePhone(c.telefon), `${label}: telefon is displayable or null`);
        ok(c.mobil === null || isDisplayablePhone(c.mobil), `${label}: mobil is displayable or null`);
        ok(c.acute_vakt === null || (c.acute_vakt === 1 && hasAcuteVaktProvenance(stored.field_provenance)), `${label}: acute_vakt is 1 only with provenance`);
        eq(Object.keys(stored).filter((k) => !A2A_REMOVED.includes(k) && !(k in c)), [], `${label}: every other key of the stored row is kept (today's form)`);
        // The values MCP shows: an A2A-only override of a card key (akutt from the raw
        // acute_vakt flag, the untrimmed chain name, …) fails here.
        const cardFields = card.toDentalClinicCard(stored, "search") as Record<string, unknown>;
        eq(differingKeys(cardFields, c), [], `${label}: every search-card key has the card's value`);
        eq(ALL_KEYS.filter((k) => !(k in cardFields) && k in c && c[k] !== null), [], `${label}: a key the card leaves out is null, not the row's raw value`);
      };
      const resp = a2a.handleDentalMessageSend({ message: { text: "tannlege" } }, "a2a-list") as any;
      const clinics: any[] = (a2aClinics = resp.result.artifacts[1].parts[0].data.clinics);
      ok(clinics.length === 6, `A0: (message/send lists the six fixture clinics, got ${clinics.length})`);
      for (const c of clinics) checkClinic(c, `A1 ${c.navn}`);
      // Ids are random per run: compared as a verdict, so a failure text stays the same across runs.
      ok(JSON.stringify(a2a.dentalAnswerProfileIds(resp).sort()) === JSON.stringify(clinics.map((c) => c.id).sort()), "A2: dentalAnswerProfileIds reads the clinic ids as before");
      const fullA2a = clinics.find((c) => c.id === full)!;
      const bareA2a = clinics.find((c) => c.id === bare)!;
      eq([fullA2a.acute_vakt, bareA2a.acute_vakt, row(bare).acute_vakt], [1, null, 1], "A3: acute_vakt 1 with provenance stays; without it becomes null (the row has 1)");
      eq([fullA2a.telefon, bareA2a.telefon], ["55 30 40 50", null], "A4: a displayable phone stays; an undisplayable one becomes null");

      const info = a2a.handleDentalMessageSend({ message: { text: "info om 918750001" } }, "a2a-info") as any;
      const single = info.result.artifacts[0].parts[0].data;
      ok(single.id === full, "A5: the single-clinic answer is the clinic");
      checkClinic(single, "A6 single clinic");
      ok(JSON.stringify(a2a.dentalAnswerProfileIds(info)) === JSON.stringify([full]), "A7: ... and its id is read as before");
    }

    // ── D + M: MCP over a real server + client ────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-clinic-card-test", version: "0.0.0" });
    mcp.registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-clinic-card-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const callText = async (name: string, args: Record<string, unknown>) =>
      String(((await client.callTool({ name, arguments: args })) as any).content[0].text);

    {
      const detail = JSON.parse(await callText("tannlege_info", { org_nr: "918750001" }));
      eq(Object.keys(detail), DETAIL_KEYS, "D1: tannlege_info keeps exactly its keys");
      eq([detail.epost, detail.acute_vakt, detail.mobil], ["post@tannlegenordmann.no", 1, null], "D2: e-mail shown, sourced acute_vakt, undisplayable mobil null");
      ok(!detail.badges.includes("Spesialist") && detail.profil_url === seo.clinicProfileUrl(row(full)), "D3: no «Spesialist» badge (as before), profile URL from clinicProfileUrl");
      ok(!("epost" in search(full)), "D4: the search card has no e-mail");
    }
    {
      const text = await callText("tannlege_search", { fylke: "Vestland", limit: 25 });
      const res = JSON.parse(text);
      const c = res.klinikker.find((k: any) => k.org_nr === "918750001");
      ok(!!c && !!c.adresse && !!c.postnummer && !!c.online_booking_url && Array.isArray(c.apningstider), "M1: a live search card for the enriched clinic has address, postcode, booking link and opening hours");
      ok(!/rating/i.test(text), "M2: no «rating» anywhere in the tannlege_search answer");
      eq(res.count, 5, "M3: count is unchanged (the five Vestland fixture clinics)");
      const akutt = JSON.parse(await callText("tannlege_akutt", { fylke: "Vestland" }));
      const a = akutt.klinikker.find((k: any) => k.org_nr === "918750001");
      ok(a?.akutt === "vakt" && typeof akutt.rad_om_kommunal_tannlegevakt === "string", "M4: tannlege_akutt gives the same card, akutt «vakt», and the tannlegevakt advice");
      // The same clinic over MCP and A2A message/send: one card, the same values.
      const a2aWire = a2aWireOf(full);
      ok(a2aWire.id === full && a2aWire.org_nr === "918750001", "M5: (the A2A list's clinic is the same clinic, by id)");
      eq([Object.keys(c ?? {}), differingKeys(c ?? {}, a2aWire)], [ALL_KEYS, []], "M6: the tannlege_search card (every key) has the same values as the A2A clinic with the same id");
      eq(differingKeys(a ?? { missing: true }, a2aWire), [], "M7: the tannlege_akutt card has the same values as the A2A clinic with the same id");
      // A clinic flagged acute_vakt = 1 without a source: not «vakt» on either surface.
      const oslo = JSON.parse(await callText("tannlege_search", { fylke: "Oslo", limit: 25 }));
      const b = oslo.klinikker.find((k: any) => k.navn === "Tann Uten Data AS");
      eq([b?.akutt, differingKeys(b ?? { missing: true }, a2aWireOf(bare))], [null, []], "M8: the unsourced acute_vakt clinic has akutt null and the same values over MCP and A2A");
    }

    // ── Z: size of a 25-clinic answer ─────────────────────────────────────
    {
      const surnames = ["Hansen", "Johansen", "Olsen", "Larsen", "Andersen", "Pedersen", "Nilsen", "Kristiansen", "Jensen", "Karlsen", "Johnsen",
        "Pettersen", "Eriksen", "Berg", "Haugen", "Hagen", "Johannessen", "Andreassen", "Jacobsen", "Dahl", "Halvorsen", "Henriksen", "Lund", "Strand", "Moen"];
      // Live-like mix (finn-tannlege /api/tannlege/agents?fylke=Vestland, 200 rows, 2026-10-17): every row
      // has a postcode, about 70 % an address, 60 % a phone, 30 % a website, 25 % opening hours, 10 % a booking
      // link and 10 % a chain. And the same 25 with every optional field set.
      // The limits against live rows (/api/tannlege/agents, Oslo, Vestland and Rogaland, 849 clinics
      // in pages of 25, measured 2026-10-17): a tannlege_search answer is 8 555–9 472 B in median and
      // at most 10 662 B; the 25 richest cards of a county give 12 907–13 457 B, under the 16 KB below.
      const seed = (fylke: string, prefix: string, rich: boolean) => surnames.forEach((name, i) => {
        const slug = name.toLowerCase();
        const has = (share: number) => rich || i % 20 < share * 20;
        add(
          {
            navn: `Tannlege ${name} AS`, org_nr: `${prefix}${String(i).padStart(2, "0")}`, postnummer: "4006", poststed: "STAVANGER", fylke,
            helfo_agreement: "true", verification_status: "verified",
            ...(has(0.7) ? { adresse: `Kirkegata ${i + 1}` } : {}),
            ...(has(0.6) ? { telefon: `5189${String(1000 + i)}` } : {}),
            ...(has(0.3) ? { hjemmeside: `https://www.tannlege${slug}.no` } : {}),
            ...(has(0.1) ? { chain_brand: "Colosseum Tannlege" } : {}),
            ...(rich ? { available_specialties: ["kjeveortopedi"] } : {}),
          },
          {
            acute_vakt: 1, field_provenance: PROVENANCE,
            ...(has(0.25) ? { opening_hours: [...WEEKDAYS_8_16.slice(0, 3), { day: "thu", open: "08:00", close: "18:00" }, { day: "fri", open: "08:00", close: "16:00" }] } : {}),
            ...(has(0.1) ? { online_booking_url: `https://tannlege${slug}.no/bestill-time` } : {}),
            ...(rich ? { price_band: "standard", price_band_source: "homepage" } : {}),
          },
        );
      });
      seed("Rogaland", "9187610", false);
      seed("Agder", "9187620", true);
      for (const [fylke, limitBytes, label] of [["Rogaland", 12 * 1024, "a live-like mix"], ["Agder", 16 * 1024, "every optional field on every clinic"]] as const) {
        const searchText = await callText("tannlege_search", { query: "tannlege", fylke, limit: 25 });
        const akuttText = await callText("tannlege_akutt", { fylke });
        const sizes = [Buffer.byteLength(searchText), Buffer.byteLength(akuttText)];
        if (log) console.log(`    ${fylke}: tannlege_search ${sizes[0]} B, tannlege_akutt ${sizes[1]} B`);
        eq([JSON.parse(searchText).klinikker.length, JSON.parse(akuttText).klinikker.length], [25, 25], `Z0 ${fylke}: (both answers carry 25 clinics)`);
        // Stable labels (no measured numbers): the CI determinism gate compares failure texts across runs.
        ok(sizes.every((n) => n < limitBytes), `Z1 ${fylke}: 25 clinics, ${label}: tannlege_search and tannlege_akutt under ${limitBytes / 1024} KB`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("dental clinic card: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (closeMcp) await closeMcp().catch(() => {});
    try {
      (require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch {
      // best-effort cleanup
    }
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalClinicCardTests({ log: true }).then((r) => {
    console.log(`\ndental clinic card: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

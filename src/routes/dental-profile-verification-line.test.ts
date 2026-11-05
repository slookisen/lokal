/**
 * dental-profile-verification-line.test.ts -- A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S3.
 *
 * The clinic profile shows what was checked, against what and when
 * («Kontroll og kilder»): the Brønnøysund check (brreg_checked_at), the
 * website ownership (only website_ownership = 'verified'), «Sist
 * kontrollert» (last_verified_at), or «Ikke kontrollert ennå» when none is
 * there; the Helfo source line only with a stored source
 * (field_provenance.helfo_agreement, array or object shape), the akutt
 * source line as resolveAcuteClaim decides; nothing for a closed clinic.
 * The JSON answers (REST GET /api/tannlege/agents/:id and MCP tannlege_info)
 * are byte-identical to the snapshot taken on main before this slice.
 *
 * Same harness as dental-inactive-hidden.test.ts (in-memory dental DB,
 * routers driven through router.handle()); MCP over a real session as in
 * mcp-input-limits.test.ts.
 *
 * Standalone: npx tsx src/routes/dental-profile-verification-line.test.ts
 * Wired into tests/test.ts via runDentalProfileVerificationLineTests().
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
}

function callRoute(router: any, path: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: path,
      originalUrl: path,
      path,
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
      setHeader() {
        return this;
      },
      send(payload: any) {
        resolve({ status: this.statusCode, text: String(payload ?? "") });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, text: JSON.stringify(payload) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, text: String(err) });
      else resolve({ status: 404, text: "unhandled" });
    });
  });
}

function post(url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function get(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

function parseMcp(text: string): any {
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
  return JSON.parse(line ? line.slice(5).trim() : text);
}

/** The «Kontroll og kilder» box of a profile page, or "" when there is none. */
function verificationBox(html: string): string {
  const m = /<div class="section-box verification-meta">[\s\S]*?<\/ul><\/div>/.exec(html);
  return m ? m[0] : "";
}

function boxLines(box: string): string[] {
  return Array.from(box.matchAll(/<li>([\s\S]*?)<\/li>/g)).map((m) => m[1]);
}

// The JSON contract (F2-S3 «Akseptanse»): taken on main 9c0b2b2, before this
// slice, for the FIXED_ID row below. REST GET /api/tannlege/agents/:id and the
// text of MCP tannlege_info must stay byte-identical.
const SNAPSHOT_REST =
  "{\"agent\":{\"id\":\"f2530000-0000-4000-8000-000000000001\",\"org_nr\":\"918959999\",\"navn\":\"Kontrakt Tannklinikk AS\",\"postnummer\":null,\"poststed\":\"OSLO\",\"fylke\":\"Oslo\",\"adresse\":\"Storgata 1\",\"telefon\":\"22110099\",\"mobil\":null,\"epost\":null,\"hjemmeside\":\"https://example.no\",\"antall_ansatte\":null,\"organisasjonsform\":null,\"registreringsdato\":null,\"naeringskode\":null,\"catalog_class\":\"klinikk\",\"directory_url\":null,\"updated_at\":\"2026-10-04T00:00:00.000Z\",\"is_inactive\":0,\"treatments\":[],\"helfo_agreement\":\"true\",\"languages_spoken\":[],\"acute_vakt\":1,\"price_band\":null,\"chain_brand\":null,\"is_chain_member\":0,\"chain_parent_orgnr\":null,\"available_specialties\":[],\"enrichment_state\":\"raw\",\"verification_status\":\"pending_verify\",\"price_band_source\":null,\"lat\":null,\"lng\":null,\"geocode_source\":null,\"geocode_confidence\":null,\"opening_hours\":null,\"om_oss\":null,\"specialists\":null,\"treatment_tech\":null,\"equipment_brands\":null,\"patient_focus\":null,\"accessibility\":null,\"payment_options\":null,\"online_booking_url\":null,\"social_media\":null,\"treatments_subtypes\":null,\"provenance\":{\"sources\":[\"homepage\"],\"last_verified\":\"2026-10-03T09:00:00.000Z\"}}}";
const SNAPSHOT_MCP =
  "{\n  \"id\": \"f2530000-0000-4000-8000-000000000001\",\n  \"org_nr\": \"918959999\",\n  \"navn\": \"Kontrakt Tannklinikk AS\",\n  \"adresse\": \"Storgata 1\",\n  \"postnummer\": null,\n  \"poststed\": \"OSLO\",\n  \"fylke\": \"Oslo\",\n  \"telefon\": \"22110099\",\n  \"mobil\": null,\n  \"epost\": null,\n  \"hjemmeside\": \"https://example.no\",\n  \"helfo_agreement\": \"true\",\n  \"acute_vakt\": null,\n  \"chain_brand\": null,\n  \"is_chain_member\": 0,\n  \"available_specialties\": [],\n  \"treatments\": [],\n  \"opening_hours\": null,\n  \"payment_options\": null,\n  \"om_oss\": null,\n  \"online_booking_url\": null,\n  \"specialists\": [],\n  \"badges\": [\n    \"Helfo-avtale\",\n    \"Tar imot akuttpasienter\"\n  ],\n  \"profil_url\": \"https://finn-tannlege.com/klinikk/kontrakt-tannklinikk-as--918959999\"\n}";

const FIXED_ID = "f2530000-0000-4000-8000-000000000001";

export async function runDentalProfileVerificationLineTests(
  opts: { log?: boolean; printSnapshot?: boolean } = {}
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = detail === undefined ? `✗ ${label}` : `✗ ${label} -- ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      failures.push(msg);
      if (log) console.log(`  ${msg}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const prevMainDb = __peekDbForTesting();
  const mainDb = new Database(":memory:");
  __setDbForTesting(mainDb as any);
  __initSchemaForTesting(mainDb as any);

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
    require.resolve("./dental-mcp"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  let server: http.Server | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const seoRouter = dentalSeo.default as any;
    const restRouter = (require("./dental") as any).default;

    let orgSeq = 918950001;
    const mk = (
      navn: string,
      cols: Record<string, unknown> = {},
      input: Record<string, unknown> = {}
    ): string => {
      const id = store.createDentalAgent({
        navn, org_nr: String(orgSeq++), poststed: "OSLO", fylke: "Oslo",
        adresse: "Storgata 1", telefon: "22110099", hjemmeside: "https://example.no",
        ...input,
      } as any);
      const all: Record<string, unknown> = { catalog_class: "klinikk", ...cols };
      const keys = Object.keys(all);
      db.prepare(`UPDATE dental_agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...keys.map((k) => {
          const v = all[k];
          return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        }), id);
      return id;
    };
    const page = async (id: string): Promise<{ status: number; html: string; box: string; lines: string[] }> => {
      const r = await callRoute(seoRouter, `/klinikk/id/${id}`);
      const box = verificationBox(r.text);
      return { status: r.status, html: r.text, box, lines: boxLines(box) };
    };

    // ── A. getDentalVerificationMeta (single-row read) ──────────────────
    {
      const id = mk("Meta Tannklinikk AS", {
        last_verified_at: "2026-10-03T09:00:00.000Z",
        brreg_status: "active",
        brreg_checked_at: "2026-10-01T08:00:00.000Z",
        website_ownership: "verified",
        website_ownership_checked_at: "2026-10-02T07:00:00.000Z",
        last_enriched_at: "2026-09-20T06:00:00.000Z",
      });
      assertEq(store.getDentalVerificationMeta(id), {
        last_verified_at: "2026-10-03T09:00:00.000Z",
        brreg_status: "active",
        brreg_checked_at: "2026-10-01T08:00:00.000Z",
        website_ownership: "verified",
        website_ownership_checked_at: "2026-10-02T07:00:00.000Z",
        last_enriched_at: "2026-09-20T06:00:00.000Z",
      }, "A1: getDentalVerificationMeta reads the six columns of the row");
      assertEq(store.getDentalVerificationMeta("no-such-id"), null, "A2: getDentalVerificationMeta is null for an unknown id");
      assertEq(dentalSeo.formatDentalCheckDate("2026-10-01T08:00:00.000Z"), "01.10.2026", "A3: dates read dd.mm.åååå");
      assertEq([dentalSeo.formatDentalCheckDate(null), dentalSeo.formatDentalCheckDate(""), dentalSeo.formatDentalCheckDate("igår"), dentalSeo.formatDentalCheckDate("2026-13-01")],
        [null, null, null, null], "A4: no date, or no ISO date, gives no date");
      assertEq([
        dentalSeo.formatDentalCheckDate("2026-10-01T22:30:00.000Z"),
        dentalSeo.formatDentalCheckDate("2026-12-31T23:30:00Z"),
        dentalSeo.formatDentalCheckDate("2026-10-01 23:00:00"),
        dentalSeo.formatDentalCheckDate("2026-10-02T00:30:00+02:00"),
        dentalSeo.formatDentalCheckDate("2026-10-01T21:59:59Z"),
      ], ["02.10.2026", "01.01.2027", "02.10.2026", "02.10.2026", "01.10.2026"],
        "A5: a timestamp near midnight UTC is the day in Europe/Oslo (summer and winter, SQLite's format, an offset)");
      assertEq([
        dentalSeo.formatDentalCheckDate("2026-02-31T10:00:00.000Z"),
        dentalSeo.formatDentalCheckDate("2026-02-29"),
        dentalSeo.formatDentalCheckDate("2026-04-31"),
        dentalSeo.formatDentalCheckDate("2026-10-01T25:00:00Z"),
        dentalSeo.formatDentalCheckDate("2024-02-29"),
      ], [null, null, null, null, "29.02.2024"], "A6: an impossible date or time gives no date, not a wrong one (a leap day is kept)");
    }

    // ── B. the check lines, with and without each date ─────────────────
    {
      const none = await page(mk("Ukontrollert Tannklinikk AS"));
      assertEq(none.status, 200, "B1: profile renders");
      assertTrue(none.box.includes("<h2>Kontroll og kilder</h2>"), "B2: the box is on an active profile", none.box);
      assertEq(none.lines, ["Ikke kontrollert ennå"], "B3: no date set -> only «Ikke kontrollert ennå»");

      const all = await page(mk("Kontrollert Tannklinikk AS", {
        brreg_status: "active",
        brreg_checked_at: "2026-10-01T08:00:00.000Z",
        website_ownership: "verified",
        website_ownership_checked_at: "2026-10-02T07:00:00.000Z",
        last_verified_at: "2026-10-03T09:00:00.000Z",
      }));
      assertEq(all.lines, [
        "Brønnøysundregistrene kontrollert: 01.10.2026",
        "Nettstedet bekreftet som klinikkens eget: 02.10.2026",
        "Sist kontrollert: 03.10.2026",
      ], "B4: every date set -> the three lines, in order, no «Ikke kontrollert ennå»");

      const brregOnly = await page(mk("Brreg Tannklinikk AS", { brreg_status: "active", brreg_checked_at: "2026-10-01T08:00:00.000Z" }));
      assertEq(brregOnly.lines, ["Brønnøysundregistrene kontrollert: 01.10.2026"], "B5: only an active Brreg check -> only the Brønnøysund line");
      for (const status of ["orgnr_not_found_or_unreachable", "dissolved", null]) {
        const failedLookup = await page(mk(`Brreg ${status} Tannklinikk AS`, { brreg_status: status, brreg_checked_at: "2026-10-01T08:00:00.000Z" }));
        assertEq(failedLookup.lines, ["Ikke kontrollert ennå"], `B5b: brreg_status = ${JSON.stringify(status)} with brreg_checked_at -> no Brønnøysund line, «Ikke kontrollert ennå»`);
      }
      const nearMidnight = await page(mk("Midnatt Tannklinikk AS", { last_verified_at: "2026-10-01T22:30:00.000Z" }));
      assertEq(nearMidnight.lines, ["Sist kontrollert: 02.10.2026"], "B5c: a check at 00:30 Oslo time shows that day, not the day before");
      const impossible = await page(mk("Umulig Dato Tannklinikk AS", { last_verified_at: "2026-02-31T10:00:00.000Z" }));
      assertEq(impossible.lines, ["Ikke kontrollert ennå"], "B5d: an impossible stored date shows no date");

      const verifiedOnly = await page(mk("Sjekket Tannklinikk AS", { last_verified_at: "2026-10-03T09:00:00.000Z" }));
      assertEq(verifiedOnly.lines, ["Sist kontrollert: 03.10.2026"], "B6: only last_verified_at -> only «Sist kontrollert»");

      const ownedOnly = await page(mk("Eid Tannklinikk AS", { website_ownership: "verified", website_ownership_checked_at: "2026-10-02T07:00:00.000Z" }));
      assertEq(ownedOnly.lines, ["Nettstedet bekreftet som klinikkens eget: 02.10.2026"], "B7: only a verified ownership -> only the ownership line");

      // updated_at keeps its own «sist oppdatert» line in the disclaimer.
      assertTrue(/<p class="disclaimer">[^<]*sist oppdatert \d{4}-\d{2}-\d{2}/.test(all.html), "B8: the updated_at line stays as «sist oppdatert»");
      assertTrue(all.html.indexOf('class="section-box verification-meta"') < all.html.indexOf('<p class="disclaimer">'), "B9: the box comes right before the disclaimer");
    }

    // ── C. website_ownership other than 'verified' gives no ownership line ──
    {
      for (const ownership of ["unverified", "n/a", "VERIFIED"]) {
        const p = await page(mk(`Ownership ${ownership} Tannklinikk AS`, {
          website_ownership: ownership,
          website_ownership_checked_at: "2026-10-02T07:00:00.000Z",
        }));
        assertEq(p.lines, ["Ikke kontrollert ennå"], `C1: website_ownership = '${ownership}' -> no ownership line`);
        assertTrue(!p.html.includes("Nettstedet bekreftet"), `C2: website_ownership = '${ownership}' -> the page never says the site is confirmed`);
      }
    }

    // ── D. Helfo: a line only with a stored source, array and object shape ──
    {
      const helfoLine = (lines: string[]) => lines.find((l) => l.startsWith("Helfo-direkteoppgjør")) ?? null;
      const src = { value: "true", source_type: "homepage", source_url: "https://example.no/helfo", fetched_at: "2026-09-15T10:00:00.000Z" };

      const arr = await page(mk("Helfo Array Tannklinikk AS", { helfo_agreement: "true", field_provenance: { helfo_agreement: [src, { ...src, fetched_at: "2026-08-01T10:00:00.000Z" }] } }));
      assertEq(helfoLine(arr.lines), "Helfo-direkteoppgjør: tolket automatisk fra klinikkens nettside, hentet 15.09.2026",
        "D1: array shape -> the Helfo source line with the newest fetch date");

      const obj = await page(mk("Helfo Objekt Tannklinikk AS", { helfo_agreement: "true", field_provenance: { helfo_agreement: { sources: [{ ...src, source_type: "stage_v_correction", fetched_at: "2026-09-16T10:00:00.000Z" }] } } }));
      assertEq(helfoLine(obj.lines), "Helfo-direkteoppgjør: tolket automatisk fra klinikkens nettside, hentet 16.09.2026",
        "D2: object shape ({sources: [...]}) -> the Helfo source line with its date");

      const legacy = await page(mk("Helfo Enkel Tannklinikk AS", { helfo_agreement: "true", field_provenance: { helfo_agreement: { ...src, fetched_at: "2026-09-17T10:00:00.000Z" } } }));
      assertEq(helfoLine(legacy.lines), "Helfo-direkteoppgjør: tolket automatisk fra klinikkens nettside, hentet 17.09.2026",
        "D3: legacy single-record object (coerceProvenanceToArrayShape) -> the Helfo source line with its date");

      const undated = await page(mk("Helfo Udatert Tannklinikk AS", { helfo_agreement: "true", field_provenance: { helfo_agreement: [{ value: "true", source_type: "homepage" }] } }));
      assertEq(helfoLine(undated.lines), "Helfo-direkteoppgjør: tolket automatisk fra klinikkens nettside",
        "D4: a source without fetched_at -> the line without «hentet»");

      const noSource = await page(mk("Helfo Uten Kilde Tannklinikk AS", { helfo_agreement: "true" }));
      assertEq(helfoLine(noSource.lines), null, "D5: helfo_agreement = 'true' without a source -> no Helfo line (spm. 24)");
      const emptySources = await page(mk("Helfo Tom Kilde Tannklinikk AS", { helfo_agreement: "true", field_provenance: { helfo_agreement: { sources: [] } } }));
      assertEq(helfoLine(emptySources.lines), null, "D6: an empty sources list is no source -> no Helfo line");
      for (const [label, prov] of [
        ["{}", { helfo_agreement: {} }],
        ["[{}]", { helfo_agreement: [{}] }],
        ["blank fields", { helfo_agreement: [{ value: "true", source_type: " ", source_url: "", fetched_at: "" }] }],
        ["{sources: [{}]}", { helfo_agreement: { sources: [{}] } }],
      ] as Array<[string, Record<string, unknown>]>) {
        const empty = await page(mk(`Helfo Tom ${label} Tannklinikk AS`, { helfo_agreement: "true", field_provenance: prov }));
        assertEq(helfoLine(empty.lines), null, `D6b: an entry naming no source (${label}) is no source -> no Helfo line`);
      }
      const notTrue = await page(mk("Helfo Nei Tannklinikk AS", { helfo_agreement: "false", field_provenance: { helfo_agreement: [src] } }));
      assertEq(helfoLine(notTrue.lines), null, "D7: helfo_agreement other than 'true' -> no Helfo line, even with a source");
    }

    // ── E. akutt: as resolveAcuteClaim decides, with the date the same way ──
    {
      const acuteLine = (lines: string[]) => lines.find((l) => l.includes("akutt") || l.startsWith("Akuttvakt")) ?? null;
      const stamp = { value: "1", source_type: "homepage", fetched_at: "2026-09-18T10:00:00.000Z" };
      const accepts = await page(mk("Akutt Tannklinikk AS", { acute_vakt: 1, field_provenance: { acute_vakt: [stamp] } }));
      assertEq(acuteLine(accepts.lines), "Tar imot akuttpasienter: tolket automatisk fra klinikkens nettside, hentet 18.09.2026",
        "E1: acute_vakt = 1 with a stamp -> «Tar imot akuttpasienter» source line with its date");
      const vakt = await page(mk("Vakt Tannklinikk AS", { acute_vakt: 1, field_provenance: { acute_vakt: { sources: [{ ...stamp, quote: "Vi har akuttvakt hele døgnet" }] } } }));
      assertEq(acuteLine(vakt.lines), "Akuttvakt: tolket automatisk fra klinikkens nettside, hentet 18.09.2026",
        "E2: a stored quote -> «Akuttvakt» source line (object shape)");
      const noProv = await page(mk("Akutt Uten Kilde Tannklinikk AS", { acute_vakt: 1 }));
      assertEq(acuteLine(noProv.lines), null, "E3: acute_vakt = 1 without provenance -> no akutt line (resolveAcuteClaim is null)");
    }

    // ── F. a closed clinic has no check line ───────────────────────────
    {
      const closed = await page(mk("Nedlagt Kontrollert Tannklinikk AS", {
        is_inactive: 1,
        brreg_checked_at: "2026-10-01T08:00:00.000Z",
        last_verified_at: "2026-10-03T09:00:00.000Z",
        helfo_agreement: "true",
        field_provenance: { helfo_agreement: [{ value: "true", source_type: "homepage", fetched_at: "2026-09-15T10:00:00.000Z" }] },
      }));
      assertEq(closed.status, 200, "F1: a closed clinic's profile still renders");
      assertTrue(closed.html.includes("Nedlagt"), "F2: … with its Nedlagt notice");
      assertEq(closed.box, "", "F3: … and no «Kontroll og kilder» box");
      assertTrue(!/Ikke kontrollert ennå|Sist kontrollert:|Brønnøysundregistrene kontrollert:|tolket automatisk fra klinikkens nettside/.test(closed.html),
        "F4: … and none of the check or source lines");
    }

    // ── G. escaping ────────────────────────────────────────────────────
    {
      const evil = "2026-10-01<script>alert(1)</script>";
      const p = await page(mk("Escape Tannklinikk AS", {
        brreg_status: "active",
        brreg_checked_at: evil,
        website_ownership: "verified",
        website_ownership_checked_at: "<img src=x onerror=alert(2)>",
        last_verified_at: "\"><b>x</b>",
      }));
      assertEq(p.lines, ["Brønnøysundregistrene kontrollert: 01.10.2026", "Nettstedet bekreftet som klinikkens eget"],
        "G1: only the date part of a stored value is shown; no date -> no date");
      assertTrue(!p.html.includes("<script>alert(1)") && !p.html.includes("onerror=alert(2)") && !p.html.includes("<b>x</b>"),
        "G2: nothing stored reaches the page unescaped");
      const html = dentalSeo.dentalVerificationSection(
        { helfo_agreement: "true", acute_vakt: null, patient_focus: null, field_provenance: { helfo_agreement: [{ value: "<i>", source_type: "<b>", fetched_at: "2026-09-15<script>" }] } } as any,
        null
      );
      assertTrue(html.includes("<li>Helfo-direkteoppgjør: tolket automatisk fra klinikkens nettside, hentet 15.09.2026</li>") && !html.includes("<script>") && !html.includes("<i>"),
        "G3: a source's text is never shown; only its date", html);
    }

    // ── H. the JSON contract is unchanged ──────────────────────────────
    {
      const id = mk("Kontrakt Tannklinikk AS", {
        brreg_status: "active",
        brreg_checked_at: "2026-10-01T08:00:00.000Z",
        website_ownership: "verified",
        website_ownership_checked_at: "2026-10-02T07:00:00.000Z",
        last_verified_at: "2026-10-03T09:00:00.000Z",
        last_enriched_at: "2026-09-20T06:00:00.000Z",
        helfo_agreement: "true",
        acute_vakt: 1,
        field_provenance: {
          helfo_agreement: [{ value: "true", source_type: "homepage", fetched_at: "2026-09-15T10:00:00.000Z" }],
          acute_vakt: [{ value: "1", source_type: "homepage", fetched_at: "2026-09-18T10:00:00.000Z" }],
        },
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-10-04T00:00:00.000Z",
      }, { org_nr: "918959999" });
      db.prepare("UPDATE dental_agents SET id = ? WHERE id = ?").run(FIXED_ID, id);

      // REST and MCP over real HTTP (express sets the headers the routes use).
      const mcpRouter = (require("./dental-mcp") as any).default;
      const app = express();
      app.use(express.json());
      app.use("/api/tannlege", restRouter);
      app.use("/mcp", mcpRouter);
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const restBefore = await get(`${origin}/api/tannlege/agents/${FIXED_ID}`);
      const profile = await page(FIXED_ID);
      const restAfter = await get(`${origin}/api/tannlege/agents/${FIXED_ID}`);
      assertEq(restBefore.status, 200, "H1: GET /api/tannlege/agents/:id -> 200");
      assertTrue(profile.lines.includes("Sist kontrollert: 03.10.2026"), "H2 control: the profile shows the check lines for the same row");
      assertTrue(restBefore.text === restAfter.text, "H3: rendering the profile writes nothing (REST JSON before = after)");

      // MCP tannlege_info over a real session.
      const url = `${origin}/mcp`;
      const base = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      const init = await post(url, JSON.stringify({
        jsonrpc: "2.0", id: "i", method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f2s3-test", version: "1" } },
      }), base);
      const sid = init.headers["mcp-session-id"] as string | undefined;
      assertTrue(!!sid, "H4 control: MCP session opened");
      let mcpText = "";
      if (sid) {
        const r = parseMcp((await post(url, JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "tannlege_info", arguments: { org_nr: "918959999" } } }), { ...base, "mcp-session-id": sid })).text);
        mcpText = (r?.result?.content ?? []).map((c: any) => String(c?.text ?? "")).join("\n");
        assertTrue(r?.result?.isError !== true && mcpText.includes("Kontrakt Tannklinikk AS"), "H5 control: tannlege_info answers for the row", mcpText.slice(0, 300));
      }

      if (opts.printSnapshot) {
        console.log("SNAPSHOT_REST=" + JSON.stringify(restBefore.text));
        console.log("SNAPSHOT_MCP=" + JSON.stringify(mcpText));
      }
      // F2-S7 (same dev-request) changes this answer on purpose: the row's
      // acute_vakt 1 has a stamp but no quote, so the public answer gives
      // null, as the card does. With its switch off the answer is main's.
      const restClaims = require("../services/dental-rest-claims") as typeof import("../services/dental-rest-claims");
      restClaims.__setRestClaimsRequireSourceForTesting(false);
      let restOff: { text: string };
      try {
        restOff = await get(`${origin}/api/tannlege/agents/${FIXED_ID}`);
      } finally {
        restClaims.__setRestClaimsRequireSourceForTesting(null);
      }
      assertTrue(restOff.text === SNAPSHOT_REST, "H6: GET /api/tannlege/agents/:id is byte-identical to the snapshot from main (F2-S7 switch off)", restOff.text);
      assertTrue(restBefore.text === SNAPSHOT_REST.replace('"acute_vakt":1,', '"acute_vakt":null,') && SNAPSHOT_REST.includes('"acute_vakt":1,'),
        "H6b: ... and with F2-S7 on, it differs only in acute_vakt 1 -> null (no quote)", restBefore.text);
      assertTrue(mcpText === SNAPSHOT_MCP, "H7: MCP tannlege_info is byte-identical to the snapshot from main", mcpText);
      const newWords = /Kontroll og kilder|Ikke kontrollert ennå|Sist kontrollert|Brønnøysundregistrene kontrollert|Nettstedet bekreftet|tolket automatisk/;
      assertTrue(!newWords.test(restBefore.text) && !newWords.test(mcpText), "H8: no page text of this slice in the JSON answers");
      assertTrue(!/"(brreg_checked_at|website_ownership_checked_at|last_enriched_at|brreg_status|website_ownership)"/.test(restBefore.text + mcpText),
        "H9: no verification column becomes a JSON key");
      // No new JSON-LD claim: the page's JSON-LD names none of it.
      const ld = Array.from(profile.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)).map((m) => m[1]).join("\n");
      assertTrue(ld.length > 0 && !newWords.test(ld) && !/03\.10\.2026|2026-10-03|2026-10-01T08/.test(ld), "H10: the JSON-LD carries no check date or line");
    }

    // ── I. a failed read of the check columns omits the box ────────────
    {
      const id = mk("Lesefeil Tannklinikk AS", { last_verified_at: "2026-10-03T09:00:00.000Z" });
      const handle = db as unknown as { prepare: (sql: string) => unknown };
      const realPrepare = handle.prepare;
      handle.prepare = function (this: unknown, sql: string) {
        if (/website_ownership_checked_at, last_enriched_at FROM dental_agents WHERE id/.test(sql)) throw new Error("no such column: brreg_checked_at");
        return realPrepare.call(this, sql);
      } as typeof realPrepare;
      let broken: { status: number; html: string; box: string } | null = null;
      try {
        broken = await page(id);
      } finally {
        handle.prepare = realPrepare;
      }
      assertEq(broken?.status, 200, "I1: the profile still renders when the check columns cannot be read");
      assertEq(broken?.box, "", "I2: … without the «Kontroll og kilder» box");
      assertTrue(!!broken && !/Ikke kontrollert ennå|Sist kontrollert/.test(broken.html), "I3: … and never claims «Ikke kontrollert ennå»");
      assertEq((await page(id)).lines, ["Sist kontrollert: 03.10.2026"], "I4 control: with the read back, the box is there");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental profile verification line: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
    if (prevMainDb) __setDbForTesting(prevMainDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalProfileVerificationLineTests({ log: true, printSnapshot: process.argv.includes("--print-snapshot") }).then((r) => {
    console.log(`\ndental profile verification line: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}

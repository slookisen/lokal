/**
 * Testmiljø — slice 1: invented seed data for a local copy of the platform.
 *
 * Builds the three SQLite databases FROM SCRATCH:
 *   - Rett fra Bonden  (lokal.db,       the app reads it via DB_PATH)
 *   - Finn-tannlege    (dental.db,      via DENTAL_DB_PATH)
 *   - Opplevagent      (experiences.db, via EXPERIENCES_DB_PATH)
 *
 * The schema comes from the app's own schema-init code (src/database/init.ts,
 * init-dental.ts, init-experiences.ts) — no CREATE TABLE is copied here, and
 * every insert names real columns, so a renamed column fails the seed loudly.
 *
 * Safety: never reads prod or the network. Refuses to run when NODE_ENV is
 * "production" or FLY_APP_NAME / FLY_MACHINE_ID is set, refuses any target
 * file that is not directly in `<repo>/.testmiljo/` (or in a `.testmiljo/`
 * under the OS temp dir, for the tests), and refuses symlinked target files.
 *
 * Deterministic: fixed ids, fixed created_at stamps (SEED_BASE), and visit /
 * order times relative to the UTC day the seed runs (so "upcoming" stays
 * upcoming). Two runs give identical row counts per table.
 *
 * Usage:
 *   npx tsx scripts/testmiljo/seed.ts                       (→ <repo>/.testmiljo/)
 *   npx tsx scripts/testmiljo/seed.ts --dir <…/.testmiljo>
 *   npx tsx scripts/testmiljo/seed.ts --rfb <p> --dental <p> --experiences <p>
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type BetterSqlite3 from "better-sqlite3";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const TESTMILJO_DIR_NAME = ".testmiljo";
export const DEFAULT_DIR = path.join(REPO_ROOT, TESTMILJO_DIR_NAME);

export interface SeedPaths {
  rfb: string;
  dental: string;
  experiences: string;
}

export function defaultPaths(dir: string = DEFAULT_DIR): SeedPaths {
  return {
    rfb: path.join(dir, "lokal.db"),
    dental: path.join(dir, "dental.db"),
    experiences: path.join(dir, "experiences.db"),
  };
}

/** Why the seed must not run in this environment, or null when it may. */
export function refuseReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.NODE_ENV || "").trim().toLowerCase() === "production") {
    return "NODE_ENV=production er satt — testmiljøet kjører aldri i produksjon.";
  }
  if (env.FLY_APP_NAME) return "FLY_APP_NAME er satt — dette ser ut som en Fly-maskin, ikke en lokal maskin.";
  if (env.FLY_MACHINE_ID) return "FLY_MACHINE_ID er satt — dette ser ut som en Fly-maskin, ikke en lokal maskin.";
  return null;
}

/**
 * Realpath of `p`, also when `p` (or a tail of it) does not exist yet: the
 * deepest existing ancestor is resolved and the missing tail appended.
 */
export function realpathLoose(p: string): string {
  const resolved = path.resolve(p);
  const tail: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return resolved;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** True when `child` is `parent` itself or lies below it (both already absolute/real). */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** SQLite sidecar files that belong to a database file. */
export const DB_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** Throws when `p` exists as a symlink (a broken symlink included). */
export function assertNotSymlink(p: string): void {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(p);
  } catch {
    return; // does not exist
  }
  if (st.isSymbolicLink()) {
    throw new Error(`${p} er en symbolsk lenke — testmiljøet følger ikke lenker. Avbryter.`);
  }
}

/**
 * Throws unless `dir` is an allowed `.testmiljo` directory: the repo's own
 * `<REPO_ROOT>/.testmiljo`, or `<tmpdir>/<one dir>/.testmiljo` (mkdtemp style,
 * what the tests use) when that is not inside the repo and the OS temp dir is
 * not the filesystem root (TMPDIR=/ would otherwise allow anything). Compared by realpath, so a symlinked parent
 * cannot point the guard elsewhere. Returns the resolved (non-real) path.
 */
export function assertTestmiljoDir(dir: string): string {
  const resolved = path.resolve(dir);
  const real = realpathLoose(resolved);
  const outside = new Error(`Mappen ${resolved} er ikke en godkjent ${TESTMILJO_DIR_NAME}/-mappe — avbryter.`);
  if (path.basename(resolved) !== TESTMILJO_DIR_NAME || path.basename(real) !== TESTMILJO_DIR_NAME) throw outside;
  if (real === realpathLoose(DEFAULT_DIR)) return resolved;
  const realTmp = realpathLoose(os.tmpdir());
  const tmpIsRoot = path.dirname(realTmp) === realTmp;
  const parent = path.dirname(real);
  if (!tmpIsRoot && path.dirname(parent) === realTmp && !isWithin(real, realpathLoose(REPO_ROOT))) return resolved;
  throw outside;
}

/**
 * Throws unless `p` is a file directly inside an allowed `.testmiljo`
 * directory (see assertTestmiljoDir), and neither it nor its SQLite sidecar
 * files exist as symlinks.
 */
export function assertInsideTestmiljo(p: string): string {
  if (!p || p === ":memory:") throw new Error(`Ugyldig databasesti: «${p}»`);
  const resolved = path.resolve(p);
  try {
    assertTestmiljoDir(path.dirname(resolved));
  } catch {
    throw new Error(`Databasestien ${resolved} ligger utenfor en ${TESTMILJO_DIR_NAME}/-mappe — avbryter.`);
  }
  assertNotSymlink(resolved);
  for (const suffix of DB_SIDECARS) assertNotSymlink(resolved + suffix);
  return resolved;
}

function removeDbFiles(p: string): void {
  for (const suffix of ["", ...DB_SIDECARS]) {
    const f = p + suffix;
    assertNotSymlink(f);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}

// ── Fixed time base ─────────────────────────────────────────────────────
/** created_at / verified_at stamps: one fixed instant, never "now". */
export const SEED_BASE = "2026-11-01T09:00:00.000Z";

function baseMinus(days: number): string {
  return new Date(Date.parse(SEED_BASE) - days * 86400000).toISOString();
}

/** Today 00:00 UTC — anchor for visit/order times that must stay future/past. */
function dayAnchor(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Naive "YYYY-MM-DDTHH:MM" (the gardssalg slot_at format) `days` from today at `hour`. */
function slotAt(days: number, hour = 13): string {
  return new Date(dayAnchor() + days * 86400000 + hour * 3600000).toISOString().slice(0, 16);
}

function isoFromToday(days: number, hour = 12): string {
  return new Date(dayAnchor() + days * 86400000 + hour * 3600000).toISOString();
}

// ── Helpers ─────────────────────────────────────────────────────────────
/** Deterministic UUID-shaped id: group (1 hex digit) + running number. */
function tid(group: number, n: number): string {
  return `00000000-0000-4000-800${group.toString(16)}-${n.toString().padStart(12, "0")}`;
}

function insert(db: BetterSqlite3.Database, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`;
  const params: Record<string, unknown> = {};
  for (const c of cols) {
    const v = row[c];
    params[c] = v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v;
  }
  db.prepare(sql).run(params);
}

function openFresh(p: string): BetterSqlite3.Database {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3") as typeof BetterSqlite3;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  removeDbFiles(p);
  const db = new Database(p);
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  return db;
}

// ── Rett fra Bonden ─────────────────────────────────────────────────────
interface RfbAgentSpec {
  n: number;
  name: string;
  city: string;
  lat: number;
  lng: number;
  url?: string;
  orgNr?: string;
  categories: string[];
  about: string;
  owner?: { name: string; email: string; claimedAt: string };
  curatedFields?: Record<string, unknown>;
}

function seedRfb(db: BetterSqlite3.Database): void {
  const agents: RfbAgentSpec[] = [
    {
      // 1. Profil uten eier
      n: 1, name: "Testgården Uteneier", city: "Hamar", lat: 60.7945, lng: 11.0680,
      categories: ["vegetables", "eggs"],
      about: "Oppdiktet gård uten eier. Brukes i testmiljøet for å vise en profil som ingen har tatt over ennå.",
    },
    {
      // 2. Profil med ny eier og ingen varer
      n: 2, name: "Testgården Nyeier", city: "Lillehammer", lat: 61.1153, lng: 10.4662,
      categories: ["dairy"],
      about: "Oppdiktet gård som nettopp har fått en eier, men som ikke har lagt inn varer.",
      owner: { name: "Nora Nyeier (test)", email: "nyeier@testgard-nyeier.invalid", claimedAt: baseMinus(1) },
    },
    {
      // 3. Eier med varer og bestillinger
      n: 3, name: "Testgården Varebod", city: "Gjøvik", lat: 60.7957, lng: 10.6916,
      categories: ["vegetables", "meat", "honey"],
      about: "Oppdiktet gård med eier, varer og bestillinger i ulike tilstander.",
      owner: { name: "Vera Varebod (test)", email: "eier@testgard-varebod.invalid", claimedAt: baseMinus(40) },
    },
    {
      // 4. Eier med nettside (lokal eksempelside)
      n: 4, name: "Testgården Nettside", city: "Elverum", lat: 60.8819, lng: 11.5623,
      url: "http://localhost/eksempel",
      categories: ["fruit", "juice"],
      about: "Oppdiktet gård med eier og en registrert nettside som peker til en lokal eksempelside.",
      owner: { name: "Nils Nettside (test)", email: "eier@testgard-nettside.invalid", claimedAt: baseMinus(20) },
    },
    {
      // 5 + 6. Dublettgruppe: to aktive profiler med samme org.nr.
      n: 5, name: "Testgården Dublett", city: "Tynset", lat: 62.2760, lng: 10.7808,
      orgNr: "999000005", categories: ["meat"],
      about: "Oppdiktet gård som ligger i en dublettgruppe (samme org.nr. som «Testgården Dublett AS»).",
    },
    {
      n: 6, name: "Testgården Dublett AS", city: "Tynset", lat: 62.2771, lng: 10.7790,
      orgNr: "999000005", categories: ["meat"],
      about: "Den andre profilen i dublettgruppen — samme org.nr. som «Testgården Dublett».",
    },
    {
      // 7. Låst profil: kundekuraterte felt låst mot automatisk berikelse
      n: 7, name: "Testgården Låst", city: "Kongsvinger", lat: 60.1906, lng: 11.9977,
      categories: ["bakery"],
      about: "Oppdiktet gård der om-teksten og åpningstidene er låst av kundeservice.",
      curatedFields: {
        about: { locked_at: baseMinus(5), by: "rfb-customer-service", thread_id: "testmiljo-thread-7", request_summary: "Testlås (oppdiktet)" },
        opening_hours: { locked_at: baseMinus(5), by: "rfb-customer-service", thread_id: "testmiljo-thread-7", request_summary: "Testlås (oppdiktet)" },
      },
    },
  ];

  for (const a of agents) {
    const id = tid(1, a.n);
    const slugPart = `testgard-${a.n}`;
    insert(db, "agents", {
      id,
      name: a.name,
      description: a.about,
      provider: a.name,
      contact_email: `post@${slugPart}.invalid`,
      url: a.url ?? "",
      role: "producer",
      api_key: `testmiljo-agent-${a.n}`,
      lat: a.lat,
      lng: a.lng,
      city: a.city,
      radius_km: 25,
      categories: a.categories,
      tags: ["testmiljo"],
      skills: [],
      capabilities: {},
      languages: ["no"],
      is_active: 1,
      is_verified: a.owner ? 1 : 0,
      created_at: baseMinus(60 - a.n),
      last_seen_at: SEED_BASE,
      vertical_id: "rfb",
      org_nr: a.orgNr ?? null,
      origin: "discovery",
      is_vetted: 1,
      claimed_at: a.owner?.claimedAt ?? null,
      claimed_via: a.owner ? "claim" : null,
      order_notifications_opt_in: a.n === 3 ? 1 : 0,
      order_notification_email: a.n === 3 ? a.owner!.email : null,
    });
    insert(db, "agent_knowledge", {
      agent_id: id,
      address: `Testveien ${a.n}`,
      postal_code: (2300 + a.n).toString(),
      website: a.url ?? null,
      phone: `+47 000 00 00${a.n}`,
      email: `post@${slugPart}.invalid`,
      about: a.about,
      opening_hours: [{ day: "lørdag", open: "10:00", close: "14:00" }],
      data_source: a.owner ? "hybrid" : "auto",
      curated_fields: a.curatedFields ?? {},
      created_at: baseMinus(60 - a.n),
      updated_at: SEED_BASE,
      vertical_id: "rfb",
    });
    if (a.owner) {
      // An owner = a verified claim (status 'verified'). claim_token stays NULL:
      // this slice builds no login (no usable owner credential is seeded).
      insert(db, "agent_claims", {
        id: tid(2, a.n),
        agent_id: id,
        claimant_name: a.owner.name,
        claimant_email: a.owner.email,
        verification_method: "email",
        status: "verified",
        source: "organic",
        created_at: a.owner.claimedAt,
        verified_at: a.owner.claimedAt,
        code_sent_to: a.owner.email,
        vertical_id: "rfb",
      });
    }
  }

  // Varer — only on «Testgården Varebod» (3) and «Testgården Nettside» (4).
  const products: Array<{ agent: number; n: number; name: string; unit: string; price: number; category: string; availability?: string }> = [
    { agent: 3, n: 1, name: "Testpoteter", unit: "kg", price: 30, category: "vegetables" },
    { agent: 3, n: 2, name: "Testgulrøtter", unit: "kg", price: 35, category: "vegetables" },
    { agent: 3, n: 3, name: "Testlammelår", unit: "stk", price: 420, category: "meat" },
    { agent: 3, n: 4, name: "Testhonning", unit: "glass", price: 120, category: "honey", availability: "out_of_stock" },
    { agent: 4, n: 5, name: "Testeplemost", unit: "liter", price: 60, category: "juice" },
    { agent: 4, n: 6, name: "Testepler", unit: "kg", price: 40, category: "fruit" },
  ];
  for (const p of products) {
    insert(db, "products", {
      id: tid(3, p.n),
      agent_id: tid(1, p.agent),
      name: p.name,
      name_norm: p.name.toLowerCase(),
      description: `${p.name} (oppdiktet testvare)`,
      unit: p.unit,
      price_nok: p.price,
      availability: p.availability ?? "in_stock",
      category: p.category,
      source: "owner",
      availability_source: "owner",
      created_at: baseMinus(10),
      updated_at: baseMinus(10),
      owner_confirmed_at: baseMinus(10),
    });
  }

  // Bestillinger på «Testgården Varebod» (3), én per tilstand.
  const orderStatuses = ["pending", "confirmed", "ready", "completed", "declined", "cancelled"] as const;
  orderStatuses.forEach((status, i) => {
    const n = i + 1;
    const orderId = tid(4, n);
    const qty = 1 + (n % 3);
    const product = products[i % 3];
    const total = qty * product.price;
    const createdAt = isoFromToday(-(7 - n), 10);
    insert(db, "orders", {
      id: orderId,
      agent_id: tid(1, 3),
      buyer_ref: `testmiljo-kjoper-${n}`,
      status,
      fulfilment: "pickup",
      pickup_time: isoFromToday(n % 2 === 0 ? 3 : -1, 15),
      total_nok: total,
      confirm_token: `testmiljo-ordre-${n}`,
      created_at: createdAt,
      updated_at: createdAt,
      cancel_reason: status === "cancelled" ? "Testkansellering (oppdiktet)" : null,
      source_client: "testmiljo",
      buyer_name: `Testkjøper ${n}`,
      buyer_email: `kjoper${n}@kunde.invalid`,
      buyer_phone: `+47 000 11 00${n}`,
      contact_consent_at: createdAt,
    });
    insert(db, "order_items", {
      id: tid(5, n),
      order_id: orderId,
      product_id: tid(3, product.n),
      name_snapshot: product.name,
      qty,
      unit_price_snapshot: product.price,
      line_total: total,
    });
  });
}

// ── Opplevagent gårdssalg ───────────────────────────────────────────────
function seedExperiences(db: BetterSqlite3.Database): void {
  const providers = [
    { n: 1, navn: "Testsideriet Uteneier", slug: "testsideriet-uteneier", type: "sideri", kommune: "Ullensvang", fylke: "Vestland", lat: 60.3196, lon: 6.6530, owner: null as string | null },
    { n: 2, navn: "Testbryggeriet Stille", slug: "testbryggeriet-stille", type: "bryggeri", kommune: "Voss", fylke: "Vestland", lat: 60.6280, lon: 6.4180, owner: "eier@testbryggeriet-stille.invalid" },
    { n: 3, navn: "Testmjøderiet Travelt", slug: "testmjoderiet-travelt", type: "mjøderi", kommune: "Lier", fylke: "Buskerud", lat: 59.7860, lon: 10.2440, owner: "eier@testmjoderiet-travelt.invalid" },
  ];

  for (const p of providers) {
    const id = tid(6, p.n);
    insert(db, "experience_providers", {
      id,
      org_nr: `99900010${p.n}`,
      navn: p.navn,
      vertical: "experiences",
      postnummer: `570${p.n}`,
      poststed: p.kommune,
      fylke: p.fylke,
      kommune: p.kommune,
      adresse: `Testvegen ${p.n}`,
      lat: p.lat,
      lon: p.lon,
      geocode_source: "testmiljo",
      geocode_confidence: "exact",
      telefon: `+47 000 22 00${p.n}`,
      epost: `post@${p.slug}.invalid`,
      organisasjonsform: "AS",
      provider_type: "gardssalg",
      brreg_verified: 1,
      brreg_active: 1,
      source: "testmiljo",
      confidence: "high",
      enrichment_state: "enriched",
      verification_status: "verified",
      created_at: baseMinus(30),
      updated_at: SEED_BASE,
      slug: p.slug,
      producer_type: p.type,
      tasting_available: 1,
      visit_required: 1,
      about_text: `${p.navn} er en oppdiktet drikkeprodusent i testmiljøet.`,
      visit_text: "Besøk etter avtale. Oppdiktet tekst.",
      opening_hours_text: "Lørdager 12–16 (oppdiktet)",
      content_source: p.owner ? "claim" : "testmiljo",
      booking_live: 1,
      catalog_hidden: 0,
      claimed_at: p.owner ? baseMinus(15) : null,
    });
    if (p.owner) {
      // Owner claim row: used=1 like a clicked claim link. The token is not a
      // usable session (not the app's 64-hex shape, already expired): this
      // slice builds no login.
      insert(db, "gardssalg_claims", {
        id: tid(7, p.n),
        provider_id: id,
        email: p.owner,
        email_source: "manual",
        token: `testmiljo-claim-${p.n}`,
        used: 1,
        used_at: baseMinus(15),
        created_at: baseMinus(15),
        expires_at: baseMinus(14),
      });
      insert(db, "gardssalg_notify_address", {
        provider_id: id,
        confirmed_email: p.owner,
        confirmed_at: baseMinus(15),
        updated_at: baseMinus(15),
      });
    }
  }

  // Besøksforespørsler på «Testmjøderiet Travelt» (3), én per tilstand koden kjenner:
  //   status (etter besøket): reserved | confirmed_attended | no_show | cancelled
  //   pre_status (før besøket): awaiting_provider | provider_confirmed |
  //                             provider_declined | time_suggested | expired
  type BookingSpec = {
    key: string; status: string; pre: string; slotDays: number;
    extra?: Record<string, unknown>;
  };
  const bookings: BookingSpec[] = [
    { key: "venter", status: "reserved", pre: "awaiting_provider", slotDays: 7,
      extra: { respond_token_expires_at: isoFromToday(2) } },
    { key: "bekreftet-kommende", status: "reserved", pre: "provider_confirmed", slotDays: 10,
      extra: { respond_token_used_at: isoFromToday(-1) } },
    { key: "bekreftet-passert", status: "reserved", pre: "provider_confirmed", slotDays: -3,
      extra: { respond_token_used_at: isoFromToday(-10) } },
    { key: "foreslatt", status: "reserved", pre: "time_suggested", slotDays: 8,
      extra: { suggested_slot_at: slotAt(12, 14), guest_decision_token: "testmiljo-gjestesvar-foreslatt" } },
    { key: "avslatt", status: "reserved", pre: "provider_declined", slotDays: 5,
      extra: { respond_token_used_at: isoFromToday(-2) } },
    { key: "utlopt", status: "reserved", pre: "expired", slotDays: -1,
      extra: { respond_token_expires_at: isoFromToday(-4) } },
    { key: "kansellert", status: "cancelled", pre: "provider_confirmed", slotDays: 6,
      extra: { respond_token_used_at: isoFromToday(-3), cancelled_at: isoFromToday(-1), cancelled_by: "guest",
               cancel_reason: "Testkansellering (oppdiktet)", resolved_at: isoFromToday(-1), resolved_by: "gjest" } },
    { key: "mott", status: "confirmed_attended", pre: "provider_confirmed", slotDays: -6,
      extra: { respond_token_used_at: isoFromToday(-12), resolved_by: "produsent", resolved_at: isoFromToday(-5), billable: 1 } },
    { key: "ikke-mott", status: "no_show", pre: "provider_confirmed", slotDays: -8,
      extra: { respond_token_used_at: isoFromToday(-14), resolved_by: "produsent", resolved_at: isoFromToday(-7), billable: 0 } },
  ];
  bookings.forEach((b, i) => {
    const n = i + 1;
    insert(db, "gardssalg_bookings", {
      booking_id: tid(8, n),
      provider_id: tid(6, 3),
      slot_at: slotAt(b.slotDays),
      party_size: 1 + (n % 4),
      guest_name: `Testgjest ${n}`,
      guest_email: `gjest${n}@gjest.invalid`,
      guest_phone: `+47 000 33 00${n}`,
      booking_ref: `GARD-TESTMILJO-${n.toString().padStart(2, "0")}`,
      confirm_token: `testmiljo-bekreft-${b.key}`,
      source: "opplevagent",
      status: b.status,
      pre_status: b.pre,
      respond_token: `testmiljo-svar-${b.key}`,
      respond_token_expires_at: isoFromToday(b.slotDays),
      guest_status_token: `testmiljo-status-${b.key}`,
      notes: `Oppdiktet forespørsel (${b.key})`,
      created_at: isoFromToday(Math.min(b.slotDays, 0) - 3),
      notify_sent_at: isoFromToday(Math.min(b.slotDays, 0) - 3),
      source_client: "testmiljo",
      guest_lang: "no",
      ...b.extra,
    });
  });
}

// ── Finn-tannlege ───────────────────────────────────────────────────────
function seedDental(db: BetterSqlite3.Database): void {
  const clinics = [
    { n: 1, navn: "Testklinikken Sentrum Tannlegesenter", poststed: "Oslo", postnummer: "0150", fylke: "Oslo", lat: 59.9127, lng: 10.7461, acute: 1, helfo: "yes" },
    { n: 2, navn: "Testtannlegene Bryggen", poststed: "Bergen", postnummer: "5003", fylke: "Vestland", lat: 60.3971, lng: 5.3245, acute: 0, helfo: "partial" },
    { n: 3, navn: "Testsmil Tannklinikk", poststed: "Trondheim", postnummer: "7011", fylke: "Trøndelag", lat: 63.4305, lng: 10.3951, acute: 0, helfo: "no" },
    { n: 4, navn: "Testtann Kjeveortopedi", poststed: "Stavanger", postnummer: "4006", fylke: "Rogaland", lat: 58.9700, lng: 5.7331, acute: 0, helfo: "unknown" },
  ];
  for (const c of clinics) {
    const slug = `testklinikk-${c.n}`;
    insert(db, "dental_agents", {
      id: tid(9, c.n),
      org_nr: `99900020${c.n}`,
      navn: c.navn,
      vertical: "dental",
      postnummer: c.postnummer,
      poststed: c.poststed,
      fylke: c.fylke,
      adresse: `Testgata ${c.n}`,
      telefon: `+47 000 44 00${c.n}`,
      epost: `post@${slug}.invalid`,
      organisasjonsform: "AS",
      naeringskode: "86.230",
      treatments: ["undersokelse", "fylling", "tannrens"],
      helfo_agreement: c.helfo,
      languages_spoken: ["no", "en"],
      acute_vakt: c.acute,
      enrichment_state: "enriched",
      verification_status: "verified",
      last_verified_at: SEED_BASE,
      created_at: baseMinus(30),
      updated_at: SEED_BASE,
      lat: c.lat,
      lng: c.lng,
      geocode_source: "testmiljo",
      geocode_confidence: "exact",
      om_oss: `${c.navn} er en oppdiktet klinikk i testmiljøet.`,
    });
  }
}

// ── Orchestration ───────────────────────────────────────────────────────
export interface SeedSummary {
  paths: SeedPaths;
  /** table → row count, per database */
  counts: Record<keyof SeedPaths, Record<string, number>>;
}

export function countRows(db: BetterSqlite3.Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    try {
      out[name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
    } catch {
      // virtual-table shadow tables etc. — skip unreadable ones
    }
  }
  return out;
}

export function seedTestmiljo(target: SeedPaths): SeedSummary {
  const reason = refuseReason();
  if (reason) throw new Error(reason);
  const paths: SeedPaths = {
    rfb: assertInsideTestmiljo(target.rfb),
    dental: assertInsideTestmiljo(target.dental),
    experiences: assertInsideTestmiljo(target.experiences),
  };

  // The app's own schema-init code. Required lazily so the refusal above
  // happens before any app module loads.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { __initSchemaForTesting } = require("../../src/database/init") as typeof import("../../src/database/init");
  const { initDentalSchema } = require("../../src/database/init-dental") as typeof import("../../src/database/init-dental");
  const { initExperiencesSchema } = require("../../src/database/init-experiences") as typeof import("../../src/database/init-experiences");
  /* eslint-enable @typescript-eslint/no-var-requires */

  const counts = {} as SeedSummary["counts"];
  const steps: Array<[keyof SeedPaths, (db: BetterSqlite3.Database) => void, (db: BetterSqlite3.Database) => void]> = [
    ["rfb", __initSchemaForTesting, seedRfb],
    ["dental", initDentalSchema, seedDental],
    ["experiences", initExperiencesSchema, seedExperiences],
  ];
  for (const [key, initSchema, seed] of steps) {
    const db = openFresh(paths[key]);
    try {
      initSchema(db);
      db.transaction(() => seed(db))();
      counts[key] = countRows(db);
    } finally {
      db.close();
    }
  }
  return { paths, counts };
}

function parseArgs(argv: string[]): SeedPaths {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const paths = defaultPaths(get("--dir") ?? DEFAULT_DIR);
  return {
    rfb: get("--rfb") ?? paths.rfb,
    dental: get("--dental") ?? paths.dental,
    experiences: get("--experiences") ?? paths.experiences,
  };
}

if (require.main === module) {
  const reason = refuseReason();
  if (reason) {
    console.error(`[testmiljo:seed] AVBRYTER: ${reason}`);
    process.exit(2);
  }
  try {
    const started = Date.now();
    const { paths, counts } = seedTestmiljo(parseArgs(process.argv.slice(2)));
    const nonEmpty = (c: Record<string, number>) =>
      Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(`[testmiljo:seed] ferdig på ${Date.now() - started} ms`);
    for (const key of Object.keys(paths) as Array<keyof SeedPaths>) {
      console.log(`  ${key}: ${paths[key]}\n    ${nonEmpty(counts[key])}`);
    }
    // Machine-readable last line, read by the tests.
    console.log("TESTMILJO_COUNTS " + JSON.stringify(counts));
  } catch (err) {
    console.error(`[testmiljo:seed] AVBRYTER: ${(err as Error).message}`);
    process.exit(2);
  }
}

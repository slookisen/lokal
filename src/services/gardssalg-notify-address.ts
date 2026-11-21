// ─── Gårdssalg: the owner confirms the address for visit requests (O4-3) ────
//
// A2A dev-request 2026-11-12-opplevagent-o4-epost-og-tekster, slice O4-3.
// Flag GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED: off unless exactly "true",
// read on every call like the other GARDSSALG_* flags. Off = nothing here
// is read, written, sent or shown, and every caller behaves as before.
//
// With the flag on:
//   - «Ta imot besøk» (booking_live) cannot be switched ON by the owner until
//     the address booking requests go to (experience_providers.epost) has
//     been confirmed (ownerBookingEnableBlock → `addr.required`).
//   - «Send bekreftelse» in «Mine valg» e-mails that address (3.2) a link
//     that works for 24 hours. The link opens a page (3.3); only the POST
//     from its button confirms. A GET changes nothing.
//   - The token is random (32 bytes), single-use, stored only as its SHA-256
//     hash, compared in constant time; a new send replaces the old token.
//   - When the address has changed since it was confirmed, it must be
//     confirmed again. Requests keep going to the old (confirmed) address
//     until the new one is confirmed (gardssalgNotifyRecipient, used by the
//     two producer-send paths in booking-store.ts), and the change notice
//     (3.4, which does not name the new address) goes to the old address,
//     once per new address, when the confirmation of the new one is sent.
//
// Texts: verbatim from tekstpakke OA-3 §3 (A2A marketing-drafts/2026-11-12-
// opplevagent-tekstpakke-oa-3.md), approved by Daniel 2026-11-15. Norwegian
// and English are both in the register; the owner pages and e-mails use
// Norwegian (the owner portal is Norwegian-only today). Do not reword here.

import crypto from "crypto";

export const GARDSSALG_NOTIFY_ADDRESS_CONFIRM_FLAG = "GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED";

/** Off unless exactly "true", read on every call. */
export function gardssalgNotifyAddressConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GARDSSALG_NOTIFY_ADDRESS_CONFIRM_FLAG] === "true";
}

// ─── Text register (OA-3 §3, nb + en, verbatim) ─────────────────────────────

export type AddressTextLang = "nb" | "en";

export const GARDSSALG_ADDRESS_TEXTS = {
  // 3.1 «Mine valg»
  "addr.label": { nb: "E-postadresse for forespørsler", en: "Email address for visit requests" },
  "addr.help": {
    nb: "Hit sender vi forespørsler om besøk. Bruk en adresse dere leser hver dag.",
    en: "We send visit requests to this address. Use one that is read every day.",
  },
  "addr.send": { nb: "Send bekreftelse", en: "Send confirmation" },
  "addr.sent": {
    nb: "Vi har sendt en e-post til {adresse}. Åpne den og bekreft adressen. Lenken virker i 24 timer.",
    en: "We have sent an email to {adresse}. Open it and confirm the address. The link works for 24 hours.",
  },
  "addr.confirmed": { nb: "Bekreftet {dato}", en: "Confirmed {dato}" },
  "addr.required": {
    nb: "Du må bekrefte adressen for forespørsler før du kan slå på «Ta imot besøk».",
    en: "You need to confirm the address for requests before you can turn on «Ta imot besøk».",
  },
  "addr.changed": {
    nb: "Adressen er endret og må bekreftes på nytt. Forespørsler går til den gamle adressen til den nye er bekreftet.",
    en: "The address has been changed and must be confirmed again. Requests go to the old address until the new one is confirmed.",
  },
  // 3.2 e-mail to the new address
  "addr.email.subject": {
    nb: "Bekreft adressen for besøksforespørsler — {produsent}",
    en: "Confirm the address for visit requests — {produsent}",
  },
  "addr.email.body": {
    nb: "Hei,\n\nNoen som er logget inn som eier av {produsent} på Opplevagent, har oppgitt denne adressen som mottaker av forespørsler om besøk.\n\nStemmer det, bekrefter du her: {lenke}\n\nLenken virker i 24 timer. Stemmer det ikke, trenger du ikke gjøre noe. Da sender vi ingenting hit.\n\nHilsen\nOpplevagent",
    en: "Hi,\n\nSomeone signed in as the owner of {produsent} on Opplevagent has given this address as the recipient of visit requests.\n\nIf that is right, confirm here: {lenke}\n\nThe link works for 24 hours. If it is not right, you do not need to do anything. We will then send nothing to this address.\n\nBest regards,\nOpplevagent",
  },
  // 3.3 the page the link opens
  "addr.page.heading": { nb: "Bekreft adressen for forespørsler", en: "Confirm the address for requests" },
  "addr.page.body": {
    nb: "Forespørsler om besøk hos {produsent} sendes til {adresse}.",
    en: "Visit requests for {produsent} will be sent to {adresse}.",
  },
  "addr.page.button": { nb: "Bekreft adressen", en: "Confirm the address" },
  "addr.page.done": {
    nb: "Adressen er bekreftet. Du kan nå slå på «Ta imot besøk» under «Mine valg».",
    en: "The address is confirmed. You can now turn on «Ta imot besøk» under «Mine valg».",
  },
  "addr.page.expired": {
    nb: "Lenken er utløpt eller brukt. Send en ny bekreftelse fra «Mine valg».",
    en: "The link has expired or has been used. Send a new confirmation from «Mine valg».",
  },
  // 3.4 notice to the old address
  "addr.changeNotice.subject": {
    nb: "Adressen for besøksforespørsler er endret — {produsent}",
    en: "The address for visit requests has been changed — {produsent}",
  },
  "addr.changeNotice.body": {
    nb: "Hei,\n\nAdressen som mottar forespørsler om besøk hos {produsent} på Opplevagent, er endret. Når den nye adressen er bekreftet, kommer forespørslene ikke lenger hit.\n\nHar dere ikke gjort endringen selv, svarer du på denne e-posten, så hjelper vi dere.\n\nHilsen\nOpplevagent",
    en: "Hi,\n\nThe address that receives visit requests for {produsent} on Opplevagent has been changed. Once the new address is confirmed, requests will no longer be sent here.\n\nIf you did not make this change, reply to this email and we will help you.\n\nBest regards,\nOpplevagent",
  },
} as const satisfies Record<string, { nb: string; en: string }>;

export type AddressTextKey = keyof typeof GARDSSALG_ADDRESS_TEXTS;

/** One text, placeholders ({adresse} {dato} {produsent} {lenke}) filled as given. */
export function addressText(key: AddressTextKey, vars: Record<string, string> = {}, lang: AddressTextLang = "nb"): string {
  return GARDSSALG_ADDRESS_TEXTS[key][lang].replace(/\{([a-zæøå_]+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

// ─── Storage ────────────────────────────────────────────────────────────────
// gardssalg_notify_address (experiences.db, init-experiences.ts): one row per
// producer. Additive; created IF NOT EXISTS.

/** 24 hours (OA-3 §3: «Lenken virker i 24 timer»). */
export const ADDRESS_CONFIRM_TTL_MS = 24 * 3600_000;
/** A second «Send bekreftelse» within this time re-uses the e-mail already sent. */
export const ADDRESS_CONFIRM_RESEND_MS = 60_000;
/** At most this many confirmation e-mails per producer per 24 hours. */
export const ADDRESS_CONFIRM_MAX_SENDS_PER_DAY = 5;

interface AddressRow {
  provider_id: string;
  confirmed_email: string | null;
  confirmed_at: string | null;
  pending_email: string | null;
  token_hash: string | null;
  token_expires_at: string | null;
  token_sent_at: string | null;
  send_window_start: string | null;
  send_count: number | null;
  change_notice_for: string | null;
  change_notice_sent_at: string | null;
}

function experiencesDb(): any {
  return (require("../database/db-factory") as typeof import("../database/db-factory")).getDb("experiences");
}

/** Comparison form of an address: trimmed, lower case; "" for none. */
export function normaliseNotifyAddress(epost: string | null | undefined): string {
  return typeof epost === "string" ? epost.trim().toLowerCase() : "";
}

function readRow(db: any, providerId: string): AddressRow | null {
  try {
    return (db.prepare(`SELECT * FROM gardssalg_notify_address WHERE provider_id = ?`).get(providerId) as AddressRow | undefined) ?? null;
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ─── State ──────────────────────────────────────────────────────────────────

export type NotifyAddressState =
  | { kind: "no_email" }
  | { kind: "confirmed"; email: string; confirmedAt: string }
  | { kind: "pending"; email: string; changedFrom: string | null }
  | { kind: "unconfirmed"; email: string; changedFrom: string | null };

/** The confirmation state of the producer's current address (read only). */
export function notifyAddressState(providerId: string, epost: string | null | undefined, now: Date = new Date()): NotifyAddressState {
  const current = normaliseNotifyAddress(epost);
  if (!current) return { kind: "no_email" };
  const email = String(epost).trim();
  const row = readRow(experiencesDb(), providerId);
  if (row && row.confirmed_email && normaliseNotifyAddress(row.confirmed_email) === current && row.confirmed_at) {
    return { kind: "confirmed", email, confirmedAt: row.confirmed_at };
  }
  const changedFrom = row && row.confirmed_email && normaliseNotifyAddress(row.confirmed_email) !== current
    ? row.confirmed_email
    : null;
  if (row && row.token_hash && normaliseNotifyAddress(row.pending_email) === current
      && row.token_expires_at && Date.parse(row.token_expires_at) > now.getTime()) {
    return { kind: "pending", email, changedFrom };
  }
  return { kind: "unconfirmed", email, changedFrom };
}

/**
 * With the flag on: true when the producer has an address but it is not
 * confirmed (booking cannot be switched on). Flag off or no address: false
 * (the existing no-address rule applies unchanged). Never throws.
 */
export function notifyAddressConfirmationMissing(providerId: string | null | undefined, epost: string | null | undefined): boolean {
  if (!gardssalgNotifyAddressConfirmEnabled() || !providerId) return false;
  try {
    const s = notifyAddressState(providerId, epost);
    return s.kind === "pending" || s.kind === "unconfirmed";
  } catch {
    return true; // flag on and the state cannot be read: fail closed (no switch-on)
  }
}

/**
 * Where a booking request for this producer goes. Flag on and the address
 * changed after a confirmation: the old, confirmed address (OA-3 addr.changed)
 * until the new one is confirmed. Otherwise the given address, unchanged.
 */
export function gardssalgNotifyRecipient(providerId: string, epost: string | null | undefined): string | null | undefined {
  if (!gardssalgNotifyAddressConfirmEnabled()) return epost;
  try {
    const current = normaliseNotifyAddress(epost);
    if (!current) return epost;
    const row = readRow(experiencesDb(), providerId);
    if (row && row.confirmed_email && row.confirmed_at && normaliseNotifyAddress(row.confirmed_email) !== current) {
      return row.confirmed_email;
    }
  } catch { /* fall back to the given address */ }
  return epost;
}

// ─── «Send bekreftelse» ─────────────────────────────────────────────────────

export type RequestConfirmationOutcome =
  | { kind: "off" }
  | { kind: "not_found" }
  | { kind: "no_email" }
  | { kind: "already_confirmed" }
  | { kind: "sent"; email: string; reused: boolean }
  | { kind: "throttled" }
  | { kind: "failed" };

function opplevagentBaseUrl(): string {
  return (process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no").replace(/\/$/, "");
}

/** The confirmation page for a token (opplevagent.no, under the claim host gate). */
export function addressConfirmPath(token: string): string {
  return `/kategori/gardssalg/eier/adresse/${token}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Plain body → text + HTML (paragraphs on blank lines; `lenke` becomes a link). */
function bodyParts(body: string, vars: Record<string, string>): { text: string; html: string } {
  const fill = (s: string, v: Record<string, string>) =>
    s.replace(/\{([a-zæøå_]+)\}/g, (m, n: string) => (Object.prototype.hasOwnProperty.call(v, n) ? v[n] : m));
  const esc: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) esc[k] = escHtml(v);
  if (vars.lenke) esc.lenke = `<a href="${escHtml(vars.lenke)}">${escHtml(vars.lenke)}</a>`;
  return {
    text: fill(body, vars),
    html: body.split("\n\n").map((p) => `<p>${p.split("\n").map((l) => fill(escHtml(l), esc)).join("<br>\n")}</p>`).join("\n"),
  };
}

/** The 3.2 e-mail (Norwegian). */
export function buildAddressConfirmEmail(produsent: string, link: string, lang: AddressTextLang = "nb"):
  { subject: string; htmlContent: string; textContent: string } {
  const p = bodyParts(GARDSSALG_ADDRESS_TEXTS["addr.email.body"][lang], { produsent, lenke: link });
  return { subject: addressText("addr.email.subject", { produsent }, lang), htmlContent: p.html, textContent: p.text };
}

/** The 3.4 notice to the old address (Norwegian). Never names the new address. */
export function buildAddressChangeNotice(produsent: string, lang: AddressTextLang = "nb"):
  { subject: string; htmlContent: string; textContent: string } {
  const p = bodyParts(GARDSSALG_ADDRESS_TEXTS["addr.changeNotice.body"][lang], { produsent });
  return { subject: addressText("addr.changeNotice.subject", { produsent }, lang), htmlContent: p.html, textContent: p.text };
}

async function sendPlatformEmail(to: string, mail: { subject: string; htmlContent: string; textContent: string }): Promise<boolean> {
  const { emailService } = require("./email-service") as typeof import("./email-service");
  const { crmFromHeader } = require("./crm-platform-identity") as typeof import("./crm-platform-identity");
  try {
    const r = await emailService.sendEmail({
      to,
      subject: mail.subject,
      htmlContent: mail.htmlContent,
      textContent: mail.textContent,
      replyTo: "kontakt@opplevagent.no",
      from: crmFromHeader("experiences"),
    });
    return !!r && r.success === true;
  } catch (e) {
    console.error("[gardssalg-notify-address] send failed:", e);
    return false;
  }
}

/**
 * «Send bekreftelse»: a new single-use token for the producer's current
 * address, the 3.2 e-mail to it, and — when the address changed after a
 * confirmation — the 3.4 notice to the old address (once per new address).
 * The caller has checked the owner session, the claim and the write guard.
 */
export async function requestNotifyAddressConfirmation(providerId: string, now: Date = new Date()): Promise<RequestConfirmationOutcome> {
  if (!gardssalgNotifyAddressConfirmEnabled()) return { kind: "off" };
  const db = experiencesDb();
  const provider = db.prepare(`SELECT id, navn, epost FROM experience_providers WHERE id = ?`).get(providerId) as
    | { id: string; navn: string | null; epost: string | null } | undefined;
  if (!provider) return { kind: "not_found" };
  const state = notifyAddressState(providerId, provider.epost, now);
  if (state.kind === "no_email") return { kind: "no_email" };
  if (state.kind === "confirmed") return { kind: "already_confirmed" };
  const email = state.email;
  const row = readRow(db, providerId);
  // A double click: the e-mail just sent stands.
  if (state.kind === "pending" && row?.token_sent_at && now.getTime() - Date.parse(row.token_sent_at) < ADDRESS_CONFIRM_RESEND_MS) {
    return { kind: "sent", email, reused: true };
  }
  const windowStart = row?.send_window_start && now.getTime() - Date.parse(row.send_window_start) < 24 * 3600_000
    ? row.send_window_start
    : now.toISOString();
  const count = windowStart === row?.send_window_start ? Number(row?.send_count ?? 0) : 0;
  if (count >= ADDRESS_CONFIRM_MAX_SENDS_PER_DAY) return { kind: "throttled" };

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expires = new Date(now.getTime() + ADDRESS_CONFIRM_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO gardssalg_notify_address
       (provider_id, pending_email, token_hash, token_expires_at, token_sent_at, send_window_start, send_count, updated_at)
     VALUES (@id, @email, @hash, @expires, @now, @ws, @count, @now)
     ON CONFLICT(provider_id) DO UPDATE SET
       pending_email = @email, token_hash = @hash, token_expires_at = @expires, token_sent_at = @now,
       send_window_start = @ws, send_count = @count, updated_at = @now`,
  ).run({ id: providerId, email, hash: tokenHash, expires, now: now.toISOString(), ws: windowStart, count: count + 1 });

  const produsent = String(provider.navn || "");
  const ok = await sendPlatformEmail(email, buildAddressConfirmEmail(produsent, `${opplevagentBaseUrl()}${addressConfirmPath(token)}`));
  if (!ok) {
    // Nothing was sent: the page must not say it was. Drop this token only.
    db.prepare(
      `UPDATE gardssalg_notify_address SET token_hash = NULL, token_expires_at = NULL, token_sent_at = NULL
        WHERE provider_id = ? AND token_hash = ?`,
    ).run(providerId, tokenHash);
    return { kind: "failed" };
  }

  // 3.4: the address changed after a confirmation → tell the old address, once per new address.
  const fresh = readRow(db, providerId);
  if (fresh?.confirmed_email && normaliseNotifyAddress(fresh.confirmed_email) !== normaliseNotifyAddress(email)
      && normaliseNotifyAddress(fresh.change_notice_for) !== normaliseNotifyAddress(email)) {
    const sent = await sendPlatformEmail(fresh.confirmed_email, buildAddressChangeNotice(produsent));
    if (sent) {
      db.prepare(`UPDATE gardssalg_notify_address SET change_notice_for = ?, change_notice_sent_at = ? WHERE provider_id = ?`)
        .run(email, now.toISOString(), providerId);
    }
  }
  console.log(`[gardssalg-notify-address] confirmation link sent for provider ${providerId}`);
  return { kind: "sent", email, reused: false };
}

// ─── The link ───────────────────────────────────────────────────────────────

export interface AddressTokenView {
  providerId: string;
  produsent: string;
  email: string;
}

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * READ ONLY: the producer and address a token confirms, or null when it is
 * unknown, used, expired, or the address has changed since it was sent.
 */
export function lookupAddressToken(token: string, now: Date = new Date()): AddressTokenView | null {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const db = experiencesDb();
  const hash = hashToken(token);
  const row = db.prepare(`SELECT * FROM gardssalg_notify_address WHERE token_hash = ?`).get(hash) as AddressRow | undefined;
  if (!row || !row.token_hash || !sameHash(row.token_hash, hash)) return null;
  if (!row.token_expires_at || Date.parse(row.token_expires_at) <= now.getTime()) return null;
  const provider = db.prepare(`SELECT navn, epost FROM experience_providers WHERE id = ?`).get(row.provider_id) as
    | { navn: string | null; epost: string | null } | undefined;
  if (!provider) return null;
  const current = normaliseNotifyAddress(provider.epost);
  if (!current || current !== normaliseNotifyAddress(row.pending_email)) return null;
  return { providerId: row.provider_id, produsent: String(provider.navn || ""), email: String(provider.epost).trim() };
}

/**
 * The POST: confirm the address and use up the token (single use, inside one
 * transaction). null = the link is unknown, used, expired or stale.
 */
export function confirmAddressToken(token: string, now: Date = new Date()): AddressTokenView | null {
  const db = experiencesDb();
  const txn = db.transaction((): AddressTokenView | null => {
    const view = lookupAddressToken(token, now);
    if (!view) return null;
    const r = db.prepare(
      `UPDATE gardssalg_notify_address
          SET confirmed_email = @email, confirmed_at = @now, pending_email = NULL, token_hash = NULL,
              token_expires_at = NULL, change_notice_for = NULL, updated_at = @now
        WHERE provider_id = @id AND token_hash = @hash`,
    ).run({ email: view.email, now: now.toISOString(), id: view.providerId, hash: hashToken(token) });
    return r.changes === 1 ? view : null;
  });
  const out = txn();
  if (out) console.log(`[gardssalg-notify-address] address confirmed for provider ${out.providerId}`);
  return out;
}

// ─── «Mine valg» block ──────────────────────────────────────────────────────

function osloDate(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Oslo" });
}

/**
 * The address block under the «Ta imot besøk» check (flag on only; the
 * caller passes nothing with the flag off). Plain POST form, no JavaScript.
 */
export function renderNotifyAddressBlock(state: NotifyAddressState, actionPath: string): string {
  if (state.kind === "no_email") return "";
  const T = (k: AddressTextKey, v: Record<string, string> = {}) => escHtml(addressText(k, v));
  const head = `<p class="mv-desc"><strong>${T("addr.label")}:</strong> ${escHtml(state.email)}</p>
            <p class="mv-desc">${T("addr.help")}</p>`;
  if (state.kind === "confirmed") {
    return `<div class="mv-addr" data-addr-state="confirmed">${head}
            <p class="mv-check" data-addr-confirmed="1">${T("addr.confirmed", { dato: osloDate(state.confirmedAt) })}</p></div>`;
  }
  const changed = state.changedFrom ? `<p class="mv-check mv-check-missing" data-addr-changed="1">${T("addr.changed")}</p>` : "";
  const status = state.kind === "pending"
    ? `<p class="mv-check" role="status" data-addr-sent="1">${T("addr.sent", { adresse: state.email })}</p>`
    : `<p class="mv-check mv-check-missing" data-addr-required="1">${T("addr.required")}</p>`;
  return `<div class="mv-addr" data-addr-state="${state.kind}">${head}${changed}${status}
            <form method="post" action="${escHtml(actionPath)}"><button type="submit" class="ep-btn ep-btn-secondary">${T("addr.send")}</button></form></div>`;
}

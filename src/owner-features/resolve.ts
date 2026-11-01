// ─── «Mine valg» — lookup and owner writes ──────────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2a.
//
// Resolution order per key (spec «Arkitektur → Oppslag»):
//   1. global kill switch (entry.killSwitch env "1"/"true")       → source killswitch
//   2. admin lock (owner_feature_settings.admin_locked = 1)        → source admin
//   3. not changeable / requirements: coming_soon, guarantee, «Gjelder ikke»
//      for the segment, lockedWhen / lockOnUnless, unmet `requires` → source locked
//      (coming_soon keeps the segment default, source default)
//   4. the owner's explicit value (owner_feature_settings row, or the adapter
//      column for adapter entries)                                → source owner
//   5. the segment default (`owner` when the profile has a verified owner by
//      customerRuleSql — the same rule as isVerifiedOwner — else `unclaimed`)
//                                                                 → source default
// Only explicit choices are ever stored, so a changed registry default never
// changes a stored value (AC9). featureOn() with an unknown key throws.

import { getDb } from "../database/init";
import { customerRuleSql } from "../services/customer-rule";
import {
  OWNER_FEATURE_REGISTRY,
  ownerFeatureRegistryFor,
  UnknownOwnerFeatureError,
  getOwnerFeature,
  findOwnerFeature,
  ownerFeatureStatus,
  visibleOwnerFeatureOptions,
  type LocalizedText,
  type OwnerFeatureCondition,
  type OwnerFeatureEntry,
  type OwnerFeatureKey,
  type OwnerFeatureValue,
  type OwnerFeatureVertical,
} from "./registry";
import { loadGardssalgSubjectFacts } from "./gardssalg-adapters";

export type OwnerFeatureSource = "default" | "owner" | "admin" | "locked" | "killswitch";

/** Why a key cannot be changed right now (null = changeable). */
export type OwnerFeatureBlock =
  | "killswitch" | "admin_locked" | "coming_soon" | "guarantee" | "locked"
  | "not_applicable" | "requirement_not_met" | "confirm_by_email";

export interface ResolvedOwnerFeature {
  key: string;
  value: OwnerFeatureValue;
  source: OwnerFeatureSource;
  changeable: boolean;
  block: OwnerFeatureBlock | null;
  /** Set when not changeable. */
  reason: LocalizedText | null;
}

export interface OwnerFeatureSubject {
  vertical: OwnerFeatureVertical;
  subjectId: string;
  exists: boolean;
  verifiedOwner: boolean;
  isVerifiedBadge: boolean;
  segment: "owner" | "unclaimed";
  /**
   * Per-subject condition state filled by the vertical's loader (gårdssalg:
   * the booking address, the admin brake, who controls visibility). A
   * condition listed here wins over the built-in evaluation; its reason
   * (when given) is the one shown.
   */
  conditions?: Partial<Record<OwnerFeatureCondition, { met: boolean; reason?: LocalizedText }>>;
}

export interface OwnerFeatureOptions {
  db?: any;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests (fixture entries); defaults to the real registry. */
  registry?: OwnerFeatureEntry[];
}

export interface ResolvedOwnerFeatures {
  subject: OwnerFeatureSubject;
  features: ResolvedOwnerFeature[];
  byKey: Record<string, ResolvedOwnerFeature>;
}

export const OWNER_FEATURE_VERTICALS: readonly OwnerFeatureVertical[] = ["rfb", "gardssalg"];

// ── Texts ──────────────────────────────────────────────────────────────────

const REASON_KILLSWITCH: LocalizedText = {
  no: "Denne funksjonen er midlertidig slått av for alle.",
  en: "This feature is temporarily switched off for everyone.",
};
const REASON_ADMIN: LocalizedText = {
  no: "Låst av Rett fra Bonden. Kontakt kontakt@rettfrabonden.com hvis du vil endre dette.",
  en: "Locked by Rett fra Bonden. Contact kontakt@rettfrabonden.com if you want to change this.",
};
const REASON_COMING_SOON: LocalizedText = { no: "Kommer snart.", en: "Coming soon." };
const REASON_GUARANTEE: LocalizedText = {
  no: "Dette er et løfte fra Rett fra Bonden og kan ikke slås av.",
  en: "This is a promise from Rett fra Bonden and cannot be switched off.",
};
// Gårdssalg (Opplevagent): no text names Rett fra Bonden (O1 principle 9).
const REASON_ADMIN_GARDSSALG: LocalizedText = {
  no: "Låst av Opplevagent. Kontakt kontakt@opplevagent.no hvis du vil endre dette.",
  en: "Locked by Opplevagent. Contact kontakt@opplevagent.no if you want to change this.",
};
const REASON_GUARANTEE_GARDSSALG: LocalizedText = {
  no: "Dette er et løfte fra Opplevagent og kan ikke slås av.",
  en: "This is a promise from Opplevagent and cannot be switched off.",
};
const REASON_NOT_APPLICABLE: LocalizedText = {
  no: "Gjelder bare profiler med bekreftet eier.",
  en: "Only applies to profiles with a verified owner.",
};
const REASON_CONFIRM_BY_EMAIL: LocalizedText = {
  no: "Endres med en bekreftelse: vi sender en lenke til den nye adressen, og den gjelder når lenken er brukt.",
  en: "Changed with a confirmation: we send a link to the new address, and it applies once the link is used.",
};
const CONDITION_REASONS: Record<OwnerFeatureCondition, LocalizedText> = {
  verifiedOwner: {
    no: "Krever bekreftet eierskap til profilen.",
    en: "Requires verified ownership of the profile.",
  },
  isVerifiedBadge: {
    no: "Krever at profilen er verifisert av Rett fra Bonden. Bekreft eierskap først.",
    en: "Requires the profile to be verified by Rett fra Bonden. Verify ownership first.",
  },
  stripeActive: {
    no: "Krever en aktiv betalingskonto og godkjente vilkår.",
    en: "Requires an active payment account and accepted terms.",
  },
  drinkProducer: {
    no: "Gjelder bare drikkeprodusenter med gårdssalg.",
    en: "Only applies to drink producers with farm sales.",
  },
  // Gårdssalg: the loader normally supplies the exact reason (with the admin
  // brake's note); these are the fallbacks.
  bookingRequestEmail: {
    no: "Krever en e-postadresse som besøksforespørslene kan sendes til. Ta kontakt med kontakt@opplevagent.no.",
    en: "Requires an e-mail address the visit requests can be sent to. Contact kontakt@opplevagent.no.",
  },
  noBookingAdminBrake: {
    no: "Booking er stanset av Opplevagent. Ta kontakt med kontakt@opplevagent.no.",
    en: "Booking was stopped by Opplevagent. Contact kontakt@opplevagent.no.",
  },
  visibilityOwnerControlled: {
    no: "Synligheten kan ikke endres herfra. Kontakt kontakt@opplevagent.no.",
    en: "Visibility cannot be changed from here. Contact kontakt@opplevagent.no.",
  },
};
const CONDITIONS = new Set<string>(Object.keys(CONDITION_REASONS));

function requiresKeyReason(label: LocalizedText): LocalizedText {
  return { no: `Krever at «${label.no}» er på.`, en: `Requires “${label.en}” to be on.` };
}
function lockedOnWhileReason(label: LocalizedText): LocalizedText {
  return { no: `Låst på så lenge «${label.no}» er på.`, en: `Locked on while “${label.en}” is on.` };
}
function onlyWhenReason(label: LocalizedText): LocalizedText {
  return { no: `Gjelder bare når «${label.no}» er på.`, en: `Only applies when “${label.en}” is on.` };
}
function lockedOnUnlessReason(label: LocalizedText): LocalizedText {
  return { no: `Låst på så lenge «${label.no}» er av.`, en: `Locked on while “${label.en}” is off.` };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function envOn(env: NodeJS.ProcessEnv, name: string | undefined): boolean {
  if (!name) return false;
  const v = env[name];
  return v === "1" || v === "true";
}

function isBooleanType(e: OwnerFeatureEntry): boolean {
  return e.type === "switch" || e.type === "locked" || e.type === "guarantee";
}

/** The value an entry has when it cannot apply (kill switch, unmet requirement). */
function offValue(e: OwnerFeatureEntry, segmentDefault: OwnerFeatureValue): OwnerFeatureValue {
  return isBooleanType(e) ? false : segmentDefault;
}

function sameValue(a: OwnerFeatureValue | undefined, b: OwnerFeatureValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function assertVertical(vertical: string): asserts vertical is OwnerFeatureVertical {
  if (!(OWNER_FEATURE_VERTICALS as readonly string[]).includes(vertical)) {
    throw new Error(`unsupported owner feature vertical: ${vertical}`);
  }
}

export function loadOwnerFeatureSubject(vertical: OwnerFeatureVertical, subjectId: string, db: any): OwnerFeatureSubject {
  assertVertical(vertical);
  if (vertical === "gardssalg") {
    // experience_providers.id in experiences.db; owner = a live verified claim.
    const f = loadGardssalgSubjectFacts(subjectId);
    return {
      vertical,
      subjectId,
      exists: f.exists,
      verifiedOwner: f.verifiedOwner,
      isVerifiedBadge: false,
      segment: f.verifiedOwner ? "owner" : "unclaimed",
      conditions: f.conditions,
    };
  }
  const row = db
    .prepare(`SELECT a.is_verified AS is_verified, ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`)
    .get(subjectId) as { is_verified: number | null; owned: number } | undefined;
  const verifiedOwner = !!row && row.owned === 1;
  return {
    vertical,
    subjectId,
    exists: !!row,
    verifiedOwner,
    isVerifiedBadge: !!row && row.is_verified === 1,
    segment: verifiedOwner ? "owner" : "unclaimed",
  };
}

interface StoredSetting {
  value: OwnerFeatureValue;
  set_by: string;
  admin_locked: boolean;
}

function loadStoredSettings(vertical: string, subjectId: string, db: any): Map<string, StoredSetting> {
  const rows = db
    .prepare(`SELECT key, value_json, set_by, admin_locked FROM owner_feature_settings WHERE vertical = ? AND subject_id = ?`)
    .all(vertical, subjectId) as Array<{ key: string; value_json: string; set_by: string; admin_locked: number }>;
  const out = new Map<string, StoredSetting>();
  for (const r of rows) {
    let value: OwnerFeatureValue;
    try { value = JSON.parse(r.value_json); } catch { continue; /* unreadable row → registry default */ }
    out.set(r.key, { value, set_by: r.set_by, admin_locked: r.admin_locked === 1 });
  }
  return out;
}

// ── Resolver ───────────────────────────────────────────────────────────────

/** Lazily resolves keys (and only the keys they depend on) for one subject. */
class Resolver {
  private memo = new Map<string, ResolvedOwnerFeature>();
  private inProgress = new Set<string>();

  constructor(
    readonly subject: OwnerFeatureSubject,
    private stored: Map<string, StoredSetting>,
    private registry: OwnerFeatureEntry[],
    private env: NodeJS.ProcessEnv,
    private db: any,
  ) {}

  reasonAdmin(): LocalizedText {
    return this.subject.vertical === "gardssalg" ? REASON_ADMIN_GARDSSALG : REASON_ADMIN;
  }

  reasonGuarantee(): LocalizedText {
    return this.subject.vertical === "gardssalg" ? REASON_GUARANTEE_GARDSSALG : REASON_GUARANTEE;
  }

  /** Is a non-key condition met for this subject? (loader state first) */
  conditionState(c: OwnerFeatureCondition): { met: boolean; reason: LocalizedText } {
    const given = this.subject.conditions?.[c];
    if (given) return { met: given.met, reason: given.reason ?? CONDITION_REASONS[c] };
    const met = c === "verifiedOwner" ? this.subject.verifiedOwner
      : c === "isVerifiedBadge" ? this.subject.isVerifiedBadge
      : false; // stripeActive / drinkProducer / gårdssalg conditions without loader state
    return { met, reason: CONDITION_REASONS[c] };
  }

  /** First unmet `enableRequires` condition's reason (checked only when switching on), or null. */
  unmetEnableRequirement(e: OwnerFeatureEntry): LocalizedText | null {
    for (const c of e.enableRequires ?? []) {
      const st = this.conditionState(c);
      if (!st.met) return st.reason;
    }
    return null;
  }

  segmentDefault(e: OwnerFeatureEntry): OwnerFeatureValue {
    return this.subject.segment === "owner" ? e.default.owner : e.default.unclaimed;
  }

  /** The owner's explicit value: adapter column or stored row. undefined = none. */
  explicitValue(e: OwnerFeatureEntry): { value: OwnerFeatureValue; source: OwnerFeatureSource } | undefined {
    if (e.storage) {
      const v = e.storage.read(this.db, this.subject.subjectId);
      if (v === null || v === undefined) return undefined;
      // The column has no "unset" state: equal to the default reads as default.
      return { value: v, source: sameValue(v, this.segmentDefault(e)) ? "default" : "owner" };
    }
    const s = this.stored.get(e.key);
    if (!s || s.admin_locked) return undefined;
    return { value: s.value, source: s.set_by === "owner" ? "owner" : "admin" };
  }

  /** First unmet requirement's reason, or null when all are met. */
  unmetRequirement(e: OwnerFeatureEntry): LocalizedText | null {
    for (const r of e.requires) {
      if (CONDITIONS.has(r)) {
        const st = this.conditionState(r as OwnerFeatureCondition);
        if (!st.met) return st.reason;
      } else if (this.resolve(r).value !== true) {
        return requiresKeyReason(getOwnerFeature(r, this.registry).label);
      }
    }
    return null;
  }

  resolve(key: string): ResolvedOwnerFeature {
    const hit = this.memo.get(key);
    if (hit) return hit;
    const e = getOwnerFeature(key, this.registry);
    if (this.inProgress.has(key)) throw new Error(`owner feature dependency cycle at ${key}`);
    this.inProgress.add(key);
    try {
      const r = this.compute(e);
      this.memo.set(key, r);
      return r;
    } finally {
      this.inProgress.delete(key);
    }
  }

  private compute(e: OwnerFeatureEntry): ResolvedOwnerFeature {
    const d = this.segmentDefault(e);
    const fixed = (value: OwnerFeatureValue, source: OwnerFeatureSource, block: OwnerFeatureBlock, reason: LocalizedText): ResolvedOwnerFeature =>
      ({ key: e.key, value, source, changeable: false, block, reason });

    // 1. global kill switch
    if (envOn(this.env, e.killSwitch)) return fixed(offValue(e, d), "killswitch", "killswitch", REASON_KILLSWITCH);
    // 2. admin lock
    const s = this.stored.get(e.key);
    if (s && s.admin_locked) return fixed(s.value, "admin", "admin_locked", this.reasonAdmin());
    // 3. not changeable / requirements (a liveFlag entry with its flag off is coming_soon)
    if (ownerFeatureStatus(e, this.env) === "coming_soon") return fixed(d, "default", "coming_soon", REASON_COMING_SOON);
    if (this.subject.segment === "unclaimed" && e.default.unclaimed === null) {
      return fixed(null, "locked", "not_applicable", REASON_NOT_APPLICABLE);
    }
    if (e.type === "guarantee") return fixed(d, "locked", "guarantee", this.reasonGuarantee());
    if (e.type === "locked" && e.lockedWhen) {
      const label = getOwnerFeature(e.lockedWhen, this.registry).label;
      return this.resolve(e.lockedWhen).value === true
        ? fixed(true, "locked", "locked", lockedOnWhileReason(label))
        : fixed(false, "locked", "locked", onlyWhenReason(label));
    }
    const unmet = this.unmetRequirement(e);
    if (unmet) return fixed(offValue(e, d), "locked", "requirement_not_met", unmet);
    if (e.lockOnUnless && this.resolve(e.lockOnUnless).value !== true) {
      return fixed(true, "locked", "locked", lockedOnUnlessReason(getOwnerFeature(e.lockOnUnless, this.registry).label));
    }
    // S2e: changed only through the e-mail confirmation flow (orders.email).
    if (e.confirmByEmail) {
      const cx = this.explicitValue(e);
      return { key: e.key, value: cx ? cx.value : d, source: cx ? cx.source : "default", changeable: false, block: "confirm_by_email", reason: REASON_CONFIRM_BY_EMAIL };
    }
    // 4. explicit owner value, 5. segment default
    const x = this.explicitValue(e);
    if (x) return { key: e.key, value: x.value, source: x.source, changeable: true, block: null, reason: null };
    return { key: e.key, value: d, source: "default", changeable: true, block: null, reason: null };
  }
}

function makeResolver(vertical: OwnerFeatureVertical, subjectId: string, opts: OwnerFeatureOptions): Resolver {
  const db = opts.db ?? getDb();
  const subject = loadOwnerFeatureSubject(vertical, subjectId, db);
  return new Resolver(
    subject,
    loadStoredSettings(vertical, subjectId, db),
    opts.registry ?? ownerFeatureRegistryFor(vertical),
    opts.env ?? process.env,
    db,
  );
}

/** Every registry entry, resolved for one subject, in registry order. */
export function resolveOwnerFeatures(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  opts: OwnerFeatureOptions = {},
): ResolvedOwnerFeatures {
  const r = makeResolver(vertical, subjectId, opts);
  const features = (opts.registry ?? ownerFeatureRegistryFor(vertical)).map((e) => r.resolve(e.key));
  const byKey: Record<string, ResolvedOwnerFeature> = {};
  for (const f of features) byKey[f.key] = f;
  return { subject: r.subject, features, byKey };
}

/**
 * Some keys, resolved for several subjects with one query (agents LEFT JOIN
 * owner_feature_settings) — for list surfaces. Subjects that do not exist
 * are left out of the map. Adapter entries among `keys` (or their
 * dependencies) still read their column per subject.
 */
export function resolveOwnerFeatureKeysForSubjects(
  vertical: OwnerFeatureVertical,
  subjectIds: Iterable<string>,
  keys: readonly OwnerFeatureKey[],
  opts: OwnerFeatureOptions = {},
): Map<string, Record<string, ResolvedOwnerFeature>> {
  assertVertical(vertical);
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  for (const key of keys) getOwnerFeature(key, registry);
  const ids = [...new Set(subjectIds)].filter((id) => typeof id === "string" && id.length > 0);
  const out = new Map<string, Record<string, ResolvedOwnerFeature>>();
  if (ids.length === 0) return out;
  if (vertical !== "rfb") {
    // Gårdssalg: one resolver per subject (the rows live in experiences.db).
    for (const id of ids) {
      const r = makeResolver(vertical, id, { ...opts, registry });
      if (!r.subject.exists) continue;
      const byKey: Record<string, ResolvedOwnerFeature> = {};
      for (const key of keys) byKey[key] = r.resolve(key);
      out.set(id, byKey);
    }
    return out;
  }
  const db = opts.db ?? getDb();
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.is_verified AS is_verified, ${customerRuleSql("a")} AS owned,
              s.key AS key, s.value_json AS value_json, s.set_by AS set_by, s.admin_locked AS admin_locked
         FROM agents a
         LEFT JOIN owner_feature_settings s ON s.vertical = ? AND s.subject_id = a.id
        WHERE a.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(vertical, ...ids) as Array<{
      id: string; is_verified: number | null; owned: number;
      key: string | null; value_json: string | null; set_by: string | null; admin_locked: number | null;
    }>;
  const subjects = new Map<string, { subject: OwnerFeatureSubject; stored: Map<string, StoredSetting> }>();
  for (const r of rows) {
    let s = subjects.get(r.id);
    if (!s) {
      const verifiedOwner = r.owned === 1;
      s = {
        subject: {
          vertical, subjectId: r.id, exists: true, verifiedOwner,
          isVerifiedBadge: r.is_verified === 1, segment: verifiedOwner ? "owner" : "unclaimed",
        },
        stored: new Map(),
      };
      subjects.set(r.id, s);
    }
    if (r.key === null || r.value_json === null) continue;
    try {
      s.stored.set(r.key, { value: JSON.parse(r.value_json), set_by: r.set_by || "", admin_locked: r.admin_locked === 1 });
    } catch { /* unreadable row → registry default */ }
  }
  const env = opts.env ?? process.env;
  for (const [id, s] of subjects) {
    const resolver = new Resolver(s.subject, s.stored, registry, env, db);
    const byKey: Record<string, ResolvedOwnerFeature> = {};
    for (const key of keys) byKey[key] = resolver.resolve(key);
    out.set(id, byKey);
  }
  return out;
}

/** One key, resolved. Unknown key → UnknownOwnerFeatureError. */
export function resolveOwnerFeature(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  key: OwnerFeatureKey,
  opts: OwnerFeatureOptions = {},
): ResolvedOwnerFeature {
  getOwnerFeature(key, opts.registry ?? ownerFeatureRegistryFor(vertical));
  return makeResolver(vertical, subjectId, opts).resolve(key);
}

/** The resolved value of any key. Unknown key → UnknownOwnerFeatureError. */
export function featureValue(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  key: OwnerFeatureKey,
  opts: OwnerFeatureOptions = {},
): OwnerFeatureValue {
  return resolveOwnerFeature(vertical, subjectId, key, opts).value;
}

/**
 * Is an on/off entry (switch, locked, guarantee) on for this subject?
 * Unknown key → UnknownOwnerFeatureError; a non-boolean entry → TypeError
 * (use featureValue). Never a silent false.
 */
export function featureOn(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  key: OwnerFeatureKey,
  opts: OwnerFeatureOptions = {},
): boolean {
  const e = getOwnerFeature(key, opts.registry ?? ownerFeatureRegistryFor(vertical));
  if (!isBooleanType(e)) throw new TypeError(`featureOn(${key}): ${e.type} entry has no on/off value — use featureValue`);
  return makeResolver(vertical, subjectId, opts).resolve(key).value === true;
}

/** Rett fra Bonden convenience wrappers (subject = agents.id). */
export function rfbFeatureOn(agentId: string, key: OwnerFeatureKey, opts: OwnerFeatureOptions = {}): boolean {
  return featureOn("rfb", agentId, key, opts);
}
export function resolveRfbOwnerFeatures(agentId: string, opts: OwnerFeatureOptions = {}): ResolvedOwnerFeatures {
  return resolveOwnerFeatures("rfb", agentId, opts);
}

/** Opplevagent gårdssalg convenience wrappers (subject = experience_providers.id). */
export function gardssalgFeatureOn(providerId: string, key: OwnerFeatureKey, opts: OwnerFeatureOptions = {}): boolean {
  return featureOn("gardssalg", providerId, key, opts);
}
export function resolveGardssalgOwnerFeatures(providerId: string, opts: OwnerFeatureOptions = {}): ResolvedOwnerFeatures {
  return resolveOwnerFeatures("gardssalg", providerId, opts);
}

// ── Value validation ───────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks a submitted value against the entry's type. */
export function validateOwnerFeatureValue(
  e: OwnerFeatureEntry,
  raw: unknown,
): { ok: true; value: OwnerFeatureValue } | { ok: false; reason: LocalizedText } {
  const bad = (no: string, en: string) => ({ ok: false as const, reason: { no, en } });
  if (raw === null && e.nullable && (e.type === "number" || e.type === "date" || e.type === "email")) {
    return { ok: true, value: null };
  }
  switch (e.type) {
    case "switch":
      return typeof raw === "boolean" ? { ok: true, value: raw } : bad("Verdien må være true eller false.", "The value must be true or false.");
    case "choice": {
      // A hidden option (auto.updates «Foreslå til meg») cannot be stored.
      const opts = visibleOwnerFeatureOptions(e).map((o) => o.value);
      return typeof raw === "string" && opts.includes(raw)
        ? { ok: true, value: raw }
        : bad(`Verdien må være en av: ${opts.join(", ")}.`, `The value must be one of: ${opts.join(", ")}.`);
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) return bad("Verdien må være et heltall.", "The value must be a whole number.");
      if ((e.min !== undefined && raw < e.min) || (e.max !== undefined && raw > e.max)) {
        return bad(`Verdien må være mellom ${e.min ?? "-∞"} og ${e.max ?? "∞"}.`, `The value must be between ${e.min ?? "-∞"} and ${e.max ?? "∞"}.`);
      }
      return { ok: true, value: raw };
    }
    case "date": {
      if (typeof raw !== "string" || !ISO_DATE.test(raw)) return bad("Datoen må ha formen ÅÅÅÅ-MM-DD.", "The date must be YYYY-MM-DD.");
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return bad("Ugyldig dato.", "Invalid date.");
      return { ok: true, value: raw };
    }
    case "email": {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (!v || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return bad("Skriv inn en gyldig e-postadresse.", "Enter a valid e-mail address.");
      return { ok: true, value: v };
    }
    default:
      // action / guarantee / locked carry no settable value
      return bad("Dette valget kan ikke settes til en verdi.", "This option cannot be set to a value.");
  }
}

// ── Owner write ────────────────────────────────────────────────────────────

export type SetOwnerFeatureResult =
  | { kind: "unknown_key" }
  | { kind: "not_found" }
  | { kind: "blocked"; block: OwnerFeatureBlock; reason: LocalizedText }
  | { kind: "invalid_value"; reason: LocalizedText }
  | { kind: "ok"; changed: boolean; feature: ResolvedOwnerFeature };

/**
 * The owner sets one key. Runs in one transaction: re-resolve, check, write
 * (owner_feature_settings row, or the adapter column), and exactly one
 * owner_feature_audit row when something changed. A no-op writes nothing.
 * Turning a key to its off value is allowed even when a requirement is unmet
 * (an owner can always drop a duty); every other block → `blocked`.
 * The caller has already checked ownership (isVerifiedOwner) and the allowlist.
 */
export function setOwnerFeatureValue(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  key: string,
  rawValue: unknown,
  actor: { actor: "owner" | "admin" | "cs" | "system"; detail?: string | null },
  opts: OwnerFeatureOptions = {},
): SetOwnerFeatureResult {
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  const e = findOwnerFeature(key, registry);
  if (!e) return { kind: "unknown_key" };
  const db = opts.db ?? getDb();
  const ropts: OwnerFeatureOptions = { ...opts, db, registry };
  // S2e: never a direct write, not even to the off value (the confirmation
  // flow owns the column).
  if (e.confirmByEmail) {
    const exists = loadOwnerFeatureSubject(vertical, subjectId, db).exists;
    return exists ? { kind: "blocked", block: "confirm_by_email", reason: REASON_CONFIRM_BY_EMAIL } : { kind: "not_found" };
  }

  try {
  return db.transaction((): SetOwnerFeatureResult => {
    const r = makeResolver(vertical, subjectId, ropts);
    if (!r.subject.exists) return { kind: "not_found" };
    const before = r.resolve(key);
    if (before.block && before.block !== "requirement_not_met") {
      return { kind: "blocked", block: before.block, reason: before.reason ?? REASON_COMING_SOON };
    }
    const v = validateOwnerFeatureValue(e, rawValue);
    if (!v.ok) return { kind: "invalid_value", reason: v.reason };
    const d = r.segmentDefault(e);
    if (!sameValue(v.value, offValue(e, d))) {
      const unmet = r.unmetRequirement(e) ?? r.unmetEnableRequirement(e);
      if (unmet) return { kind: "blocked", block: "requirement_not_met", reason: unmet };
    }

    // No-op: compare with the explicit value (or the default when none).
    const x = r.explicitValue(e);
    const current = x ? x.value : d;
    if (sameValue(current, v.value)) return { kind: "ok", changed: false, feature: before };

    const now = new Date().toISOString();
    // Order (O1a review): the lokal.db rows first — the audit row, and the
    // settings row for a stored entry — and an adapter's column LAST. A
    // gårdssalg adapter writes experiences.db, which this transaction does
    // not cover: written last, a failed log insert can never leave the
    // column changed without its «Mine valg» log row. An adapter that does
    // not write rolls the lokal.db rows back (AdapterRefusal below).
    db.prepare(
      `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(vertical, subjectId, key, JSON.stringify(current ?? null), JSON.stringify(v.value), actor.actor, actor.detail ?? null, now);
    if (e.storage) {
      const w = e.storage.write(db, subjectId, v.value);
      if (w !== true) {
        throw new AdapterRefusal(
          w && typeof w === "object"
            ? { kind: "blocked", block: "requirement_not_met", reason: w.blocked }
            : { kind: "not_found" },
        );
      }
    } else {
      db.prepare(
        `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(vertical, subject_id, key) DO UPDATE SET
           value_json = excluded.value_json, set_by = excluded.set_by, set_at = excluded.set_at`,
      ).run(vertical, subjectId, key, JSON.stringify(v.value), actor.actor, now);
    }

    const after = makeResolver(vertical, subjectId, ropts).resolve(key);
    return { kind: "ok", changed: true, feature: after };
  })();
  } catch (err) {
    if (err instanceof AdapterRefusal) return err.out;
    throw err;
  }
}

/** An adapter did not write: roll the lokal.db rows back and answer with `out`. */
class AdapterRefusal extends Error {
  constructor(readonly out: SetOwnerFeatureResult) { super("owner feature adapter refused"); }
}

export { UnknownOwnerFeatureError };

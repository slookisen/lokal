import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { getConfig } from "../config/vertical-config";
import { homepageRegistrableDomain } from "./experience-store";

// ─── CRM Service ────────────────────────────────────────────
// Core inbox-CRM logic.
// Handles upsert of threads/messages from Gmail (via the CS-agent),
// contact resolution (link to producers via domain/email matching),
// and read queries for the dashboard UI.

export type ContactType = "producer" | "marketing" | "vendor" | "unknown";
// Vertical split: rfb = rettfrabonden.com, dental = finn-tannlege.com,
// experiences = opplevagent.no. All CRM tables carry vertical_id (default
// 'rfb'). The closed union below is interpolated directly into SQL fragments
// — never raw user input.
export const CRM_VERTICALS = ["rfb", "dental", "experiences"] as const;
export type CrmVertical = (typeof CRM_VERTICALS)[number];

export function isCrmVertical(v: unknown): v is CrmVertical {
  return typeof v === "string" && (CRM_VERTICALS as readonly string[]).includes(v);
}

/**
 * FAIL-CLOSED vertical gate for every CRM WRITE.
 *
 * Daniel, 2026-07-27: «Det er ekstremt viktig at rfb og opplevagent.no håndteres
 * hver for seg og vi ikke begynner å blande henvendelser fra hver av plattformene.»
 *
 * Throwing is the whole point. `vertical_id` has a `DEFAULT 'rfb'` at the column
 * level, so ANY write that omits it silently files the row as Rett fra Bonden —
 * which is exactly how every row in the CRM ended up tagged 'rfb', including
 * genuine Opplevagent enquiries. A default here would recreate the damage this
 * function exists to stop, so there is deliberately no fallback parameter and no
 * "sensible default": an unroutable message must fail loudly and be triaged by a
 * human, never be quietly filed under the wrong platform.
 */
export function assertVertical(v: unknown, where: string): CrmVertical {
  if (!isCrmVertical(v)) {
    throw new Error(
      `[crm] ${where}: vertical must be one of ${CRM_VERTICALS.join("|")} — got ${JSON.stringify(v)}. ` +
        `Refusing to default to 'rfb'; a mis-filed platform is the bug this guard exists for.`,
    );
  }
  return v;
}

function vSql(column: string, vertical?: CrmVertical): string {
  if (vertical === undefined) return "";
  // Validated at the point of interpolation rather than trusted from the caller.
  // The value IS a closed union in TypeScript and today's only entry point
  // (parseVertical in routes/crm.ts) is a strict allowlist — but types do not
  // exist at runtime, and this builds SQL by string concatenation. One future
  // caller passing a raw query parameter turns this into injection, and nothing
  // in the type system would flag it. Cost of the check: one Array.includes.
  return ` AND ${column} = '${assertVertical(vertical, "vSql")}'`;
}
export type ThreadStatus = "new" | "in_progress" | "awaiting_review" | "done" | "archived";
export type ThreadCategory = "innkommende" | "system" | "marketing" | "leverandor" | "unknown";
export type AssignedTo = "unassigned" | "claude" | "daniel";
export type Severity = "p0" | "p1" | "p2" | "normal";
export type Direction = "in" | "out";
export type Actor = "claude" | "daniel" | "system";
export type OutboxIntent = "gmail_draft" | "resend_send";
export type OutboxStatus = "pending" | "processing" | "completed" | "failed";

export interface IngestThreadInput {
  threadId: string;                  // Gmail threadId — canonical
  subject?: string | null;
  category?: ThreadCategory;
  severity?: Severity;
  messages: IngestMessageInput[];
}

export interface IngestMessageInput {
  messageId: string;                 // Gmail messageId — canonical
  direction: Direction;
  fromEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
  sentAt?: string | null;            // ISO 8601
  rawMetadata?: Record<string, any>;
}

// Shared by the rfb agents-matching and the experiences provider-matching
// (steg 6): a freemail domain identifies a person, not an organisation, so a
// domain-level match on one of these proves nothing and is never attempted.
const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "live.com",
  "icloud.com", "online.no", "broadpark.no",
]);

const VENDOR_DOMAINS = new Set([
  "fly.io", "namecheap.com", "google.com", "googlemail.com", "cloudflare.com",
  "github.com", "stripe.com", "vercel.com", "resend.com", "anthropic.com",
  "claude.com", "openai.com", "mailchimp.com", "aws.amazon.com",
  "amazon.com", "amazonaws.com", "render.com", "smithery.ai", "glama.ai",
  "supabase.com", "neon.tech", "doppler.com", "sentry.io", "datadog.com",
  "intercom.com", "linear.app", "notion.so", "atlassian.com",
]);

class CrmService {
  // ─── Contacts ───────────────────────────────────────────────

  /**
   * Look up or create a contact by email. Auto-classifies type:
   *  - If email's domain matches a producer's contact_email or knowledge.website host → 'producer'
   *  - If domain ∈ VENDOR_DOMAINS → 'vendor'
   *  - Else 'unknown' (Daniel can re-classify later)
   */

  private matchesVendorDomain(domain: string): boolean {
    if (!domain) return false;
    if (VENDOR_DOMAINS.has(domain)) return true;
    // Check if any vendor domain is a suffix (e.g. accounts.google.com → google.com)
    for (const v of VENDOR_DOMAINS) {
      if (domain.endsWith("." + v)) return true;
    }
    return false;
  }

  /**
   * dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding, fix 2 (root-cause
   * guard). classifyEmail()'s email/domain matching has no way to know a matched
   * `agents` row IS the platform's own record rather than a real producer — that
   * is exactly how the 2026-05-11 marketing batch e23 templating bug linked 14
   * different contacts to agent 2b5fc7a6, whose name is literally "Rett fra
   * Bonden" (the platform's own display_name for the rfb vertical), role
   * 'logistics'. This is a general rule keyed on name-equals-platform-display-
   * name for the contact's OWN vertical, not a hardcoded check for that one
   * agent id.
   */
  private isPlatformNameAgent(agentId: string, vertical: CrmVertical): boolean {
    const db = getDb();
    const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as { name: string } | undefined;
    if (!row || !row.name) return false;
    let displayName: string | null = null;
    try {
      // vertical-config.ts is cold-loaded at boot (loadConfigsAtBoot), well
      // before any CRM write can happen — but getConfig() throws if that
      // hasn't run (e.g. a test harness that didn't load it), hence the guard.
      displayName = getConfig(vertical).display_name || null;
    } catch (e) {
      // Fail OPEN: this guard is defense-in-depth on top of classifyEmail's
      // existing matching, not the only thing standing between a contact and a
      // bad link. A vertical-config load hiccup should not take contact
      // resolution down with it — it should just skip the extra check.
      console.error(`[crm] isPlatformNameAgent: getConfig(${vertical}) failed, guard skipped:`, e);
      return false;
    }
    if (!displayName) return false;
    return row.name.trim().toLowerCase() === displayName.trim().toLowerCase();
  }

  /**
   * Classify an email against the contact's OWN vertical's entity table
   * (steg 6, funn 6). Used both at create-time and to re-evaluate existing
   * 'unknown'/unlinked contacts after entities are added/edited.
   *
   * Dispatch by vertical:
   *   - rfb          → agents table (unchanged legacy path), fills `agentId`
   *   - experiences  → experience_providers in experiences.db, fills `providerId`
   *   - dental       → NO entity matching (vendor allowlist only). Dental
   *                    clinics live in dental.db and the dental CRM lane isn't
   *                    live; until it is, the honest answer is 'unknown' —
   *                    matching against RFB agents (the pre-steg-6 behaviour)
   *                    produced exactly the cross-vertical links funn 6 is about.
   *
   * Exactly one of agentId/providerId can ever be non-null, and only for the
   * matching vertical — the schema-level triggers
   * (trg_crm_contacts_{agent,provider}_vertical_*) enforce the same invariant
   * on any write that bypasses this function.
   *
   * `vertical` also scopes the platform-name guard above (fix 2) to the
   * contact's own platform. `contactIdForLog`, when the contact row already
   * exists, is attached to the crm_actions row logged on a blocked match so a
   * human reviewing the CRM can jump straight to the contact; pass null for a
   * brand-new contact that hasn't been INSERTed yet (crm_actions.contact_id
   * has an ON DELETE SET NULL FK — logging against a not-yet-existing row
   * would violate it under foreign_keys=ON).
   */
  classifyEmail(
    email: string,
    vertical: CrmVertical,
    contactIdForLog: string | null = null,
  ): { type: ContactType; agentId: string | null; providerId: string | null } {
    const db = getDb();
    const lowerEmail = email.trim().toLowerCase();
    const domain = lowerEmail.split("@")[1] ?? "";

    if (vertical === "experiences") {
      const p = this.classifyEmailAgainstProviders(lowerEmail, domain);
      if (p) return { type: "producer", agentId: null, providerId: p };
      if (this.matchesVendorDomain(domain)) return { type: "vendor", agentId: null, providerId: null };
      return { type: "unknown", agentId: null, providerId: null };
    }
    if (vertical === "dental") {
      if (this.matchesVendorDomain(domain)) return { type: "vendor", agentId: null, providerId: null };
      return { type: "unknown", agentId: null, providerId: null };
    }

    // Returns true (and logs) if `agentId` is the platform's own house-bucket
    // record for `vertical` — callers must treat that as "no match" and NOT
    // auto-link, per the guard above.
    const blockIfPlatformNameAgent = (agentId: string): boolean => {
      if (!this.isPlatformNameAgent(agentId, vertical)) return false;
      console.warn(
        `[crm] classifyEmail: refusing to auto-link ${lowerEmail} to agent ${agentId} — ` +
          `its name matches the '${vertical}' platform's own display_name ` +
          `(house-bucket guard, dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding)`,
      );
      this.logAction({
        contactId: contactIdForLog,
        type: "crm_auto_link_blocked_platform_name_match",
        actor: "system",
        payload: { email: lowerEmail, vertical, blocked_agent_id: agentId },
      });
      return true;
    };

    // 1. Exact match
    const exact = db
      .prepare("SELECT id FROM agents WHERE LOWER(contact_email) = ? AND is_active = 1 LIMIT 1")
      .get(lowerEmail) as { id: string } | undefined;
    if (exact) {
      if (blockIfPlatformNameAgent(exact.id)) return { type: "unknown", agentId: null, providerId: null };
      return { type: "producer", agentId: exact.id, providerId: null };
    }

    // 1b. Exact match on agent_knowledge.email — this is the address marketing
    // actually sends outreach to, and it's often different from agents.contact_email
    // (e.g. a personal Gmail). Without this tier the contact never gets an agent_id,
    // and the outreach_sent_log auto-record trigger (PR-38) silently no-ops on its
    // agent_id IS NOT NULL guard, so the producer keeps reappearing in the pool.
    const exactKnowledge = db
      .prepare(
        "SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id WHERE LOWER(k.email) = ? AND a.is_active = 1 LIMIT 1"
      )
      .get(lowerEmail) as { id: string } | undefined;
    if (exactKnowledge) {
      if (blockIfPlatformNameAgent(exactKnowledge.id)) return { type: "unknown", agentId: null, providerId: null };
      return { type: "producer", agentId: exactKnowledge.id, providerId: null };
    }

    // 2. Domain match (skip generic freemail domains so we don't false-positive)
    if (domain && !FREEMAIL_DOMAINS.has(domain)) {
      const byDomain = db
        .prepare("SELECT id FROM agents WHERE LOWER(contact_email) LIKE ? AND is_active = 1 LIMIT 1")
        .get(`%@${domain}`) as { id: string } | undefined;
      if (byDomain) {
        if (blockIfPlatformNameAgent(byDomain.id)) return { type: "unknown", agentId: null, providerId: null };
        return { type: "producer", agentId: byDomain.id, providerId: null };
      }
    }

    // 3. Vendor allowlist (exact OR subdomain match)
    if (this.matchesVendorDomain(domain)) return { type: "vendor", agentId: null, providerId: null };

    return { type: "unknown", agentId: null, providerId: null };
  }

  /**
   * steg 6 — the experiences twin of the rfb agents-matching above. Returns the
   * experience_providers.id to link, or null for no match.
   *
   * Tiers mirror the rfb path's confidence ordering:
   *   1. Exact match on experience_providers.epost
   *   2. Domain match on epost (skipping freemail — a shared @gmail.com proves
   *      nothing about which org the sender belongs to)
   *   3. Domain match on hjemmeside, verified in JS via homepageRegistrableDomain
   *      (the SQL LIKE is only a prefilter — 'gard.no' LIKE-matches
   *      'ikkegard.no', so every candidate is re-checked properly)
   *
   * Providers with brreg_active = 0 (konkurs/avvikling) are excluded — the rfb
   * path's `is_active = 1` analog. NULL (never checked) is allowed through: most
   * harvested rows haven't had a Brreg check yet, and refusing to link ALL of
   * them would make this function a no-op in practice.
   *
   * Reads experiences.db via db-factory — a different database file, which is
   * the whole reason this is app-level matching and provider_id has no FK.
   */
  private classifyEmailAgainstProviders(lowerEmail: string, domain: string): string | null {
    let xdb: ReturnType<typeof getVerticalDb>;
    try {
      xdb = getVerticalDb("experiences");
    } catch (e) {
      // Fail SAFE, not loud: contact resolution must not die because the
      // experiences volume is briefly unavailable. An unlinked contact
      // self-heals on its next touch (same re-evaluation as the rfb path).
      console.error("[crm] classifyEmailAgainstProviders: experiences DB unavailable, no link made:", e);
      return null;
    }

    // 1. Exact epost
    const exact = xdb
      .prepare("SELECT id FROM experience_providers WHERE LOWER(epost) = ? AND brreg_active IS NOT 0 LIMIT 1")
      .get(lowerEmail) as { id: string } | undefined;
    if (exact) return exact.id;

    if (!domain || FREEMAIL_DOMAINS.has(domain)) return null;

    // 2. epost domain
    const byEpostDomain = xdb
      .prepare("SELECT id FROM experience_providers WHERE LOWER(epost) LIKE ? AND brreg_active IS NOT 0 LIMIT 1")
      .get(`%@${domain}`) as { id: string } | undefined;
    if (byEpostDomain) return byEpostDomain.id;

    // 3. hjemmeside registrable domain — LIKE prefilter, JS verification
    const candidates = xdb
      .prepare(
        `SELECT id, hjemmeside FROM experience_providers
          WHERE hjemmeside IS NOT NULL AND hjemmeside LIKE ? AND brreg_active IS NOT 0
          LIMIT 25`,
      )
      .all(`%${domain}%`) as Array<{ id: string; hjemmeside: string }>;
    for (const c of candidates) {
      if (homepageRegistrableDomain(c.hjemmeside) === domain) return c.id;
    }
    return null;
  }

  /**
   * Resolve (or create) the contact for `email` ON A SPECIFIC PLATFORM.
   *
   * `vertical` is required and scopes BOTH the lookup and the insert. Scoping the
   * lookup is what makes «adskilte kontakter» real: the same person writing to
   * rettfrabonden.com and to opplevagent.no gets two rows, two thread histories,
   * and two independent classifications. Without the scope, the first platform to
   * see an address would own that contact forever and every later message from the
   * other platform would be stapled onto its history.
   */
  resolveContact(email: string, hintName: string | null | undefined, vertical: CrmVertical): { id: string; created: boolean } {
    const db = getDb();
    const v = assertVertical(vertical, "resolveContact");
    const lowerEmail = email.trim().toLowerCase();
    const domain = lowerEmail.split("@")[1] ?? "";

    const existing = db
      .prepare("SELECT id, type, agent_id, provider_id FROM crm_contacts WHERE email = ? AND vertical_id = ?")
      .get(lowerEmail, v) as
      | { id: string; type: ContactType; agent_id: string | null; provider_id: string | null }
      | undefined;

    if (existing) {
      // Re-evaluate if currently 'unknown' OR stuck with no agent_id link (cheap,
      // one indexed lookup). The agent_id===null case matters on its own: a contact
      // that resolved to agent_id=null on first contact (e.g. the producer wasn't
      // yet 'verified'/didn't have an agent_knowledge row at that time) previously
      // stayed unlinked FOREVER, because this re-evaluation only ran for
      // type==='unknown'. An unlinked contact's outbound sends never satisfy the
      // outreach_sent_log auto-record trigger's `agent_id IS NOT NULL` guard (PR-38),
      // so the producer silently never gets suppressed and keeps reappearing in the
      // outreach pool on every batch — root cause of the 2026-07-11 P0 incident
      // (outreach-suppression-gate-failure, 91 recipients re-contacted 2-4 days
      // running). Retrying classifyEmail() here self-heals the link as soon as the
      // producer becomes resolvable, on the very next contact touch.
      //
      // Excludes 'vendor' AND 'marketing': classifyEmail() can never itself produce
      // either of those types with a non-null agentId (vendor's IS always null by
      // design; 'marketing' isn't a classifyEmail() outcome at all — it's only ever
      // set manually via POST /admin/crm/contacts/:id/type, e.g. a press/partner
      // contact whose email happens to domain-match a producer). Without this
      // exclusion, a manually-tagged 'marketing' contact would get silently flipped
      // back to 'producer' on its next touch (reviewer finding, 2026-07-11).
      //
      // steg 6: "unlinked" is judged against the contact's OWN vertical's
      // pointer — provider_id for experiences, agent_id for rfb. Judging an
      // experiences contact by agent_id would make it permanently "unlinked"
      // (its agent_id is ALWAYS null now, by trigger) and re-run classification
      // on every single touch.
      const entityLink = v === "experiences" ? existing.provider_id : existing.agent_id;
      const needsReclassify =
        existing.type === "unknown" ||
        (entityLink === null && existing.type !== "vendor" && existing.type !== "marketing");
      if (needsReclassify) {
        const c = this.classifyEmail(lowerEmail, v, existing.id);
        if (c.type !== "unknown") {
          db.prepare(
            "UPDATE crm_contacts SET type = ?, agent_id = ?, provider_id = ?, last_seen_at = datetime('now') WHERE id = ?",
          ).run(c.type, c.agentId, c.providerId, existing.id);
          return { id: existing.id, created: false };
        }
      }
      db.prepare("UPDATE crm_contacts SET last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
      return { id: existing.id, created: false };
    }

    // contactIdForLog is null here (not existing.id above): this contact row
    // doesn't exist yet — the INSERT is below — and crm_actions.contact_id is
    // an ON DELETE SET NULL FK, so logging against a not-yet-existing id would
    // violate it under foreign_keys=ON. A blocked-match log without a
    // contact_id still carries the email/vertical/agent_id a human needs.
    const c = this.classifyEmail(lowerEmail, v, null);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, domain, vertical_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, c.type, c.agentId, c.providerId, lowerEmail, hintName ?? null, domain || null, v);

    return { id, created: true };
  }

  /**
   * Bulk re-classify all 'unknown' contacts. Used after seeding new agents
   * or when admin notices misclassifications.
   */
  reclassifyUnknown(): { evaluated: number; reclassified: number } {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, email, COALESCE(vertical_id, 'rfb') AS vertical_id FROM crm_contacts WHERE type = 'unknown'"
    ).all() as Array<{ id: string; email: string; vertical_id: string }>;
    let reclassified = 0;
    for (const r of rows) {
      // Defensive fallback to 'rfb' for any unexpected stored value — this is
      // a bulk maintenance sweep, not a request-time write, so it deliberately
      // does not use assertVertical()'s fail-loud behavior here.
      const vertical: CrmVertical = isCrmVertical(r.vertical_id) ? r.vertical_id : "rfb";
      const c = this.classifyEmail(r.email, vertical, r.id);
      if (c.type !== "unknown") {
        db.prepare("UPDATE crm_contacts SET type = ?, agent_id = ?, provider_id = ? WHERE id = ?")
          .run(c.type, c.agentId, c.providerId, r.id);
        reclassified++;
      }
    }
    return { evaluated: rows.length, reclassified };
  }

  /**
   * Manual (admin) classification override.
   *
   * steg 6 validation, fail-loud on every branch:
   *   - agentId is only meaningful on an rfb contact; providerId only on an
   *     experiences contact. Passing the wrong pointer for the contact's
   *     vertical throws — the schema triggers would abort the write anyway,
   *     but a thrown Error here carries a message a human can act on, where
   *     the trigger's RAISE(ABORT) surfaces as a bare SQLite error.
   *   - providerId must exist in experience_providers (experiences.db). This
   *     is the code-level half of the cross-DB "FK" — the schema cannot
   *     REFERENCES across database files, so existence is checked here, at the
   *     ONE write path where a human supplies an arbitrary id. (classifyEmail's
   *     links come out of the providers table itself and can't dangle.)
   */
  setContactType(contactId: string, type: ContactType, agentId?: string | null, providerId?: string | null): void {
    const db = getDb();
    const contact = db
      .prepare("SELECT COALESCE(vertical_id,'rfb') AS vertical_id FROM crm_contacts WHERE id = ?")
      .get(contactId) as { vertical_id: string } | undefined;
    if (!contact) throw new Error(`[crm] setContactType: no contact ${contactId}`);

    if (agentId != null && providerId != null) {
      throw new Error("[crm] setContactType: a contact links to ONE entity — agentId and providerId are mutually exclusive");
    }
    if (agentId != null && contact.vertical_id !== "rfb") {
      throw new Error(
        `[crm] setContactType: agentId is an rfb pointer, but contact ${contactId} is '${contact.vertical_id}' — ` +
          `en kontakt kan aldri peke på en entitet i feil vertical (steg 6)`,
      );
    }
    if (providerId != null) {
      if (contact.vertical_id !== "experiences") {
        throw new Error(
          `[crm] setContactType: providerId is an experiences pointer, but contact ${contactId} is '${contact.vertical_id}' — ` +
            `en kontakt kan aldri peke på en entitet i feil vertical (steg 6)`,
        );
      }
      const exists = getVerticalDb("experiences")
        .prepare("SELECT 1 FROM experience_providers WHERE id = ?")
        .get(providerId);
      if (!exists) {
        throw new Error(`[crm] setContactType: provider ${providerId} does not exist in experience_providers`);
      }
    }

    db.prepare("UPDATE crm_contacts SET type = ?, agent_id = ?, provider_id = ? WHERE id = ?")
      .run(type, agentId ?? null, providerId ?? null, contactId);
  }

  setContactStatus(contactId: string, status: "active" | "blocked" | "archived"): void {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET status = ? WHERE id = ?").run(status, contactId);
  }

  setContactNotes(contactId: string, notes: string): void {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET notes = ? WHERE id = ?").run(notes, contactId);
  }

  // ─── Threads ────────────────────────────────────────────────

  /**
   * Idempotent ingestion: upserts a thread + its messages.
   * Called by the CS-agent each run with whatever new/updated threads it found.
   */
  ingestThread(
    input: IngestThreadInput,
    primaryFromEmail: string,
    vertical: CrmVertical,
  ): { threadId: string; contactId: string; newMessages: number } {
    const db = getDb();
    const v = assertVertical(vertical, "ingestThread");
    const threadId = input.threadId;

    // The thread lookup and the conflict guard run BEFORE resolveContact — see
    // the note below. Order is load-bearing, not stylistic.
    const existing = db.prepare("SELECT id, vertical_id FROM crm_threads WHERE id = ?").get(threadId) as
      { id: string; vertical_id: string } | undefined;

    // REVIEW B4 — a thread cannot change platform on re-ingest.
    //
    // vertical_id used to be written only in the `if (!existing)` branch below.
    // Every thread in production today is 'rfb', and CS ingest is idempotent by
    // design: it re-sends the same Gmail threadIds every run. So the first run
    // that correctly triaged an old thread as 'experiences' would have left the
    // THREAD 'rfb' while stamping its new MESSAGES 'experiences' — half one
    // platform, half the other — and stranded a second contact row attached to
    // nothing. Any reply then went out under thread.vertical_id = 'rfb', which is
    // the M13 scenario reached from the other direction.
    //
    // Refusing is right rather than merely safe: a thread genuinely arriving on
    // the other platform means the triage signal changed, and a human needs to
    // see that, not have one side silently overwrite the other.
    //
    // The guard sits ABOVE resolveContact deliberately. In the first version it
    // sat below, and a reviewer measured that the refused re-ingest still created
    // the contact row and orphaned it — the very "stranded a second contact row
    // attached to nothing" this guard exists to prevent, reproduced by the guard
    // itself. The claim "nothing was written" was true of messages and false of
    // contacts. Now it is true of both: the refusal happens before any write.
    if (existing && existing.vertical_id !== v) {
      throw new Error(
        `[crm] ingestThread: thread ${threadId} already belongs to vertical ` +
          `${JSON.stringify(existing.vertical_id)}, refusing to re-ingest it as ${JSON.stringify(v)}. ` +
          `A conversation does not change platform; triage this thread manually.`,
      );
    }

    const contact = this.resolveContact(primaryFromEmail, null, v);
    const contactId = contact.id;

    if (!existing) {
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        threadId,
        contactId,
        input.subject ?? null,
        input.category ?? "unknown",
        input.severity ?? "normal",
        v
      );
    } else if (input.subject || input.category || input.severity) {
      // Update fields if provided
      const updates: string[] = [];
      const params: any[] = [];
      if (input.subject) { updates.push("subject = ?"); params.push(input.subject); }
      if (input.category) { updates.push("category = ?"); params.push(input.category); }
      if (input.severity) { updates.push("severity = ?"); params.push(input.severity); }
      updates.push("updated_at = datetime('now')");
      params.push(threadId);
      db.prepare(`UPDATE crm_threads SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    // Upsert messages
    let newMessages = 0;
    const insertMsg = db.prepare(`
      INSERT OR IGNORE INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet, sent_at, raw_metadata, vertical_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of input.messages) {
      const result = insertMsg.run(
        m.messageId,
        threadId,
        m.direction,
        m.fromEmail.toLowerCase(),
        JSON.stringify(m.toEmails ?? []),
        JSON.stringify(m.ccEmails ?? []),
        m.subject ?? null,
        m.bodyText ?? null,
        m.bodyHtml ?? null,
        m.snippet ?? null,
        m.sentAt ?? null,
        JSON.stringify(m.rawMetadata ?? {}),
        v
      );
      if (result.changes > 0) newMessages++;
    }

    // Recompute denormalized fields
    const totalMessages = this.recomputeThreadStats(threadId);

    // Log ingest
    if (newMessages > 0) {
      this.logAction({
        threadId,
        contactId,
        type: "imported",
        actor: "system",
        payload: { newMessages, totalMessages },
      });
    }

    return { threadId, contactId, newMessages };
  }

  /**
   * Recompute a thread's denormalized rollup fields (message_count,
   * last_message_at, last_inbound_at, last_outbound_at) from its actual
   * crm_messages rows. Pulled out of ingestThread() so recordOutboundReply()
   * (dev-request 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk, skive 1)
   * can share the exact same derivation — the two write paths (inbound
   * ingest, outbound reply) must never disagree about how message_count is
   * computed, or the dashboard/CS-agent read one thing while a second query
   * computed another. Pure recompute from source data: calling it twice in a
   * row is a no-op, so every caller can call it unconditionally after any
   * crm_messages write.
   */
  private recomputeThreadStats(threadId: string): number {
    const db = getDb();
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS cnt,
        MAX(sent_at) AS last_msg,
        MAX(CASE WHEN direction = 'in' THEN sent_at END) AS last_in,
        MAX(CASE WHEN direction = 'out' THEN sent_at END) AS last_out
      FROM crm_messages WHERE thread_id = ?
    `).get(threadId) as any;

    db.prepare(`
      UPDATE crm_threads
      SET message_count = ?, last_message_at = ?, last_inbound_at = ?, last_outbound_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(stats.cnt ?? 0, stats.last_msg, stats.last_in, stats.last_out, threadId);

    return stats.cnt ?? 0;
  }

  /**
   * Record an outbound reply on an EXISTING thread — the POST
   * /threads/:id/send path (dev-request
   * 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk, skive 1).
   *
   * Before this, /threads/:id/send queued a crm_outbox row, sent the
   * message, and logged a crm_actions row — but never touched crm_messages.
   * A thread that HAD been answered kept its pre-reply message_count and
   * looked unanswered to anyone (dashboard, or the CS-agent itself) reading
   * the thread's message history, risking a second reply to the same
   * enquiry.
   *
   * Unlike composeNewThread(), this does NOT create a thread or contact —
   * both already exist for a reply on an existing thread. It only appends
   * the message row and recomputes the thread's denormalized counters via
   * the same recomputeThreadStats() ingestThread() uses.
   *
   * delivery_status is the ACTUAL outcome, never assumed:
   *   - 'sent'           resend_send succeeded — sentAt should be the real
   *                      send time.
   *   - 'failed'         resend_send failed or threw — sentAt stays null; a
   *                      failed attempt is still recorded (audit trail),
   *                      matching composeNewThread's own failure handling.
   *   - 'queued'         gmail_draft — flips to 'draft_in_gmail' later via
   *                      the existing /outbox/:id/result -> updateMessageDeliveryStatus
   *                      path (getLatestOutboundMessageId now finds this row
   *                      too, closing the "reply-from-thread sends don't
   *                      create crm_messages, so this no-ops" gap noted at
   *                      that call site).
   */
  recordOutboundReply(params: {
    threadId: string;
    vertical: CrmVertical;
    toEmails: string[];
    ccEmails?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    deliveryStatus: "sent" | "queued" | "draft_in_gmail" | "failed";
    /** ISO timestamp. Only meaningful when deliveryStatus === 'sent'; ignored otherwise. */
    sentAt?: string | null;
    rawMetadata?: Record<string, any>;
  }): { messageId: string } {
    const db = getDb();
    const v = assertVertical(params.vertical, "recordOutboundReply");
    const messageId = `msg-${randomUUID()}`;
    const recordedSentAt = params.deliveryStatus === "sent" ? (params.sentAt ?? new Date().toISOString()) : null;

    db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet, sent_at, raw_metadata, delivery_status, vertical_id)
      VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      params.threadId,
      JSON.stringify(params.toEmails),
      JSON.stringify(params.ccEmails ?? []),
      params.subject,
      params.bodyText,
      params.bodyHtml ?? null,
      (params.bodyText || "").slice(0, 200),
      recordedSentAt,
      JSON.stringify(params.rawMetadata ?? {}),
      params.deliveryStatus,
      v,
    );

    this.recomputeThreadStats(params.threadId);
    return { messageId };
  }

  /**
   * Double-send guard (dev-request
   * 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk, skive 1.3).
   *
   * Finding: on 2026-08-09 two `sent` crm_actions landed on the same thread
   * 4 seconds apart (15:30:32 / 15:30:36, DB time). Whether that was one
   * accidental double-click or two deliberate replies could not be
   * established after the fact — /threads/:id/send never wrote a
   * crm_messages row before this fix, so there was no stored body/subject to
   * compare the two sends against; only the (identical-shaped) crm_actions
   * log survived, which does not carry the reply text.
   *
   * Rather than guess at that one incident, the guard is scoped to the one
   * case a legitimate caller never has a reason to hit: BYTE-IDENTICAL
   * subject+body sent on the SAME thread within a short window. Two
   * genuinely different replies — even a second apart — are unaffected, so
   * this can never block a real second, distinct answer. Hard reject (409),
   * not a soft warning: there is no legitimate reason to send the exact same
   * reply twice within `windowSeconds`, so there is nothing for a human to
   * weigh — this is closer to a validation error than a judgment call.
   */
  findRecentIdenticalOutbound(
    threadId: string,
    subject: string,
    bodyText: string,
    windowSeconds = 30,
  ): { id: string; received_at: string } | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT id, received_at FROM crm_messages
      WHERE thread_id = ? AND direction = 'out'
        AND subject = ? AND body_text = ?
        AND received_at >= datetime('now', '-' || ? || ' seconds')
      ORDER BY received_at DESC LIMIT 1
    `).get(threadId, subject, bodyText, windowSeconds) as { id: string; received_at: string } | undefined;
    return row ?? null;
  }

  // ─── Compose a brand-new outbound thread ──────────────────
  // Used by the CRM "Ny epost" UI. Creates the contact (if missing),
  // a fresh thread, and one outbound message — then the route layer
  // sends via Resend or enqueues a Gmail draft. Mirrors ingestThread's
  // bookkeeping (denormalized counters, action log) so the new thread
  // appears in the dashboard the same as inbound ones.
  composeNewThread(input: {
    toEmail: string;
    contactName?: string | null;
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    category?: "innkommende" | "marketing" | "leverandor" | "system" | "unknown";
    severity?: "p0" | "p1" | "p2" | "normal";
    createdBy: "claude" | "daniel";
    /**
     * Initial delivery state for the outbound message we record.  Use 'queued'
     * when the actual send hasn't happened yet — caller must update via
     * updateMessageDeliveryStatus once Resend/Gmail has confirmed.  Default
     * 'sent' is for back-compat callers that genuinely send synchronously.
     */
    deliveryStatus?: "sent" | "queued" | "draft_in_gmail" | "failed";
    /** Which platform this thread belongs to. Required — see assertVertical. */
    vertical: CrmVertical;
  }): { threadId: string; contactId: string; messageId: string } {
    const db = getDb();
    const v = assertVertical(input.vertical, "composeNewThread");
    const lowerTo = input.toEmail.trim().toLowerCase();
    const contact = this.resolveContact(lowerTo, input.contactName ?? null, v);
    const contactId = contact.id;

    if (input.contactName && contact.created) {
      db.prepare("UPDATE crm_contacts SET name = COALESCE(name, ?) WHERE id = ?")
        .run(input.contactName, contactId);
    }

    const threadId = `compose-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category, severity, assigned_to, status, last_message_at, last_outbound_at, message_count, updated_at, vertical_id)
      VALUES (?, ?, ?, ?, ?, 'daniel', 'in_progress', ?, ?, 1, datetime('now'), ?)
    `).run(
      threadId,
      contactId,
      input.subject,
      input.category ?? "innkommende",
      input.severity ?? "normal",
      now,
      now,
      v,
    );

    const deliveryStatus = input.deliveryStatus ?? "sent";
    // For non-confirmed states, leave sent_at NULL so dashboards can render
    // an "ikke sendt"-banner instead of falsely showing a sent timestamp.
    const recordedSentAt = deliveryStatus === "sent" ? now : null;

    db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet, sent_at, raw_metadata, delivery_status, vertical_id)
      VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      threadId,
      JSON.stringify([lowerTo]),
      input.subject,
      input.bodyText,
      input.bodyHtml ?? null,
      (input.bodyText || "").slice(0, 200),
      recordedSentAt,
      JSON.stringify({ source: "crm-compose", createdBy: input.createdBy }),
      deliveryStatus,
      v,
    );

    this.logAction({
      threadId,
      contactId,
      type: "composed",
      actor: input.createdBy === "daniel" ? "daniel" : "claude",
      payload: { messageId, to: lowerTo, subject: input.subject, source: "crm-compose-ui" },
    });

    return { threadId, contactId, messageId };
  }

  /**
   * Update an outbound message's delivery_status after the actual send
   * outcome is known.  Sets sent_at to NOW only when transitioning to
   * 'sent' and sent_at was previously NULL — preserves audit accuracy.
   */
  updateMessageDeliveryStatus(messageId: string, status: "sent" | "queued" | "draft_in_gmail" | "failed"): void {
    const db = getDb();
    if (status === "sent") {
      db.prepare(`UPDATE crm_messages SET delivery_status = ?, sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?`).run(status, messageId);
    } else {
      db.prepare(`UPDATE crm_messages SET delivery_status = ? WHERE id = ?`).run(status, messageId);
    }
  }

  /**
   * Find the most recent outbound crm_messages id for a thread, for use
   * when the caller has only the threadId (e.g. /outbox/:id/result).
   */
  getLatestOutboundMessageId(threadId: string): string | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT id FROM crm_messages
      WHERE thread_id = ? AND direction = 'out'
      ORDER BY received_at DESC LIMIT 1
    `).get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  setThreadStatus(threadId: string, status: ThreadStatus, actor: Actor): void {
    const db = getDb();
    const prev = db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(threadId) as { status: string } | undefined;
    if (!prev) return;
    db.prepare("UPDATE crm_threads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, threadId);
    this.logAction({
      threadId,
      type: "status_changed",
      actor,
      payload: { from: prev.status, to: status },
    });
  }

  setThreadAssignee(threadId: string, assignedTo: AssignedTo, actor: Actor): void {
    const db = getDb();
    db.prepare("UPDATE crm_threads SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?").run(assignedTo, threadId);
    this.logAction({ threadId, type: "assignee_changed", actor, payload: { to: assignedTo } });
  }

  setThreadNotes(threadId: string, notes: string, actor: Actor): void {
    const db = getDb();
    db.prepare("UPDATE crm_threads SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(notes, threadId);
    this.logAction({ threadId, type: "note_added", actor, payload: { length: notes.length } });
  }

  // ─── Actions log ────────────────────────────────────────────

  logAction(params: {
    threadId?: string | null;
    contactId?: string | null;
    type: string;
    actor: Actor;
    payload?: Record<string, any>;
  }): string {
    const db = getDb();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.threadId ?? null,
      params.contactId ?? null,
      params.type,
      params.actor,
      JSON.stringify(params.payload ?? {})
    );
    return id;
  }

  // ─── Outbox (queued sends) ──────────────────────────────────

  enqueueOutbox(params: {
    threadId?: string | null;
    contactId?: string | null;
    intent: OutboxIntent;
    toEmails: string[];
    ccEmails?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    replyToMessageId?: string | null;
    createdBy: "claude" | "daniel";
    /** Which platform this send belongs to. Required — see assertVertical. */
    vertical: CrmVertical;
  }): { id: string } {
    const db = getDb();
    const v = assertVertical(params.vertical, "enqueueOutbox");
    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_outbox
        (id, thread_id, contact_id, intent, to_emails, cc_emails, subject, body_text, body_html, reply_to_message_id, created_by, vertical_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.threadId ?? null,
      params.contactId ?? null,
      params.intent,
      JSON.stringify(params.toEmails),
      JSON.stringify(params.ccEmails ?? []),
      params.subject,
      params.bodyText,
      params.bodyHtml ?? null,
      params.replyToMessageId ?? null,
      params.createdBy,
      v
    );
    this.logAction({
      threadId: params.threadId,
      contactId: params.contactId,
      type: params.intent === "gmail_draft" ? "draft_queued" : "send_queued",
      actor: params.createdBy,
      payload: { outboxId: id, to: params.toEmails, subject: params.subject },
    });
    return { id };
  }

  listPendingOutbox(intent?: OutboxIntent, limit = 50): any[] {
    const db = getDb();
    const sql = intent
      ? "SELECT * FROM crm_outbox WHERE status = 'pending' AND intent = ? ORDER BY created_at LIMIT ?"
      : "SELECT * FROM crm_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?";
    return intent ? db.prepare(sql).all(intent, limit) as any[] : db.prepare(sql).all(limit) as any[];
  }

  markOutboxResult(id: string, status: OutboxStatus, resultId?: string, error?: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE crm_outbox
      SET status = ?, result_id = ?, error = ?, processed_at = datetime('now')
      WHERE id = ?
    `).run(status, resultId ?? null, error ?? null, id);
  }

  // ─── Read queries (UI) ──────────────────────────────────────

  /**
   * List contacts grouped by type with thread counts.
   * Used for the three-tab landing page.
   */
  listContacts(type: ContactType, opts: { limit?: number; offset?: number; search?: string; vertical?: CrmVertical } = {}): any[] {
    const db = getDb();
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const searchClause = opts.search ? " AND (c.email LIKE ? OR c.name LIKE ?)" : "";
    const params: any[] = [type];
    if (opts.search) {
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    params.push(limit, offset);

    const rows = db.prepare(`
      SELECT
        c.id, c.email, c.name, c.domain, c.organization, c.status, c.notes,
        c.first_seen_at, c.last_seen_at, c.agent_id, c.provider_id,
        a.name AS agent_name, a.role AS agent_role,
        COUNT(DISTINCT t.id) AS thread_count,
        SUM(CASE WHEN t.status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN t.status = 'awaiting_review' THEN 1 ELSE 0 END) AS awaiting_count,
        MAX(t.last_message_at) AS last_message_at,
        SUM(t.message_count) AS total_messages
      FROM crm_contacts c
      LEFT JOIN crm_threads t ON t.contact_id = c.id
      LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.type = ?${searchClause}${vSql("c.vertical_id", opts.vertical)}
      GROUP BY c.id
      ORDER BY MAX(t.last_message_at) DESC NULLS LAST, c.last_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[];

    // dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding, fix 3: flag
    // any contact whose agent_id points at a non-producer agent record (e.g.
    // the "Rett fra Bonden" house-bucket, role='logistics') so an admin
    // UI/CS agent sees the mismatch immediately instead of silently
    // mis-searching for a "producer" that's actually an internal record.
    // Additive field only — every existing field above is untouched.
    for (const row of rows) {
      row.agent_role_mismatch = !!row.agent_id && !!row.agent_role && row.agent_role !== "producer";
    }
    this.attachProviderInfo(rows);
    return rows;
  }

  /**
   * steg 6 — the read-side half of provider_id. `agent_name` comes from a
   * LEFT JOIN in the SQL above; `provider_name` CANNOT (experience_providers
   * lives in a different database file, and SQLite doesn't join across open
   * handles without ATTACH). So linked provider names are fetched app-side in
   * one batched IN-query per page of results.
   *
   * `provider_missing: true` marks a dangling pointer (provider row deleted
   * after linking — there's no FK to stop that, see the schema comment).
   * Silent-nothing would leave a linked contact looking identical to an
   * unlinked one, which is the silence-failure class this dev-request is about.
   */
  private attachProviderInfo(rows: any[]): void {
    const ids = [...new Set(rows.map((r) => r.provider_id).filter(Boolean))] as string[];
    if (ids.length === 0) return;
    let names = new Map<string, string>();
    try {
      const found = getVerticalDb("experiences")
        .prepare(
          `SELECT id, navn FROM experience_providers WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as Array<{ id: string; navn: string }>;
      names = new Map(found.map((p) => [p.id, p.navn]));
    } catch (e) {
      // Reads must not die because the experiences DB is briefly unavailable —
      // provider_name simply comes back null this once.
      console.error("[crm] attachProviderInfo: experiences DB unavailable:", e);
      return;
    }
    for (const row of rows) {
      if (!row.provider_id) continue;
      row.provider_name = names.get(row.provider_id) ?? null;
      row.provider_missing = !names.has(row.provider_id);
    }
  }

  countContactsByType(vertical?: CrmVertical): Record<ContactType, number> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT type, COUNT(*) as cnt FROM crm_contacts WHERE 1=1${vSql("vertical_id", vertical)} GROUP BY type
    `).all() as { type: ContactType; cnt: number }[];
    const result: Record<ContactType, number> = { producer: 0, marketing: 0, vendor: 0, unknown: 0 };
    for (const r of rows) result[r.type] = r.cnt;
    return result;
  }

  getContactDetail(contactId: string): any {
    const db = getDb();
    const contact = db.prepare(`
      SELECT c.*, a.name AS agent_name, a.city AS agent_city, a.role AS agent_role
      FROM crm_contacts c
      LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.id = ?
    `).get(contactId) as any;
    if (!contact) return null;

    // dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding, fix 3 — see
    // the matching comment in listContacts() above. Additive field only.
    contact.agent_role_mismatch = !!contact.agent_id && !!contact.agent_role && contact.agent_role !== "producer";
    this.attachProviderInfo([contact]);

    const threads = db.prepare(`
      SELECT * FROM crm_threads
      WHERE contact_id = ?
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
    `).all(contactId);

    const actions = db.prepare(`
      SELECT * FROM crm_actions
      WHERE contact_id = ? OR thread_id IN (SELECT id FROM crm_threads WHERE contact_id = ?)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(contactId, contactId);

    return { contact, threads, actions };
  }

  getThreadDetail(threadId: string): any {
    const db = getDb();
    const thread = db.prepare(`
      SELECT t.*, c.email AS contact_email, c.name AS contact_name, c.type AS contact_type, c.agent_id
      FROM crm_threads t
      JOIN crm_contacts c ON c.id = t.contact_id
      WHERE t.id = ?
    `).get(threadId);
    if (!thread) return null;

    const messages = db.prepare(`
      SELECT * FROM crm_messages
      WHERE thread_id = ?
      ORDER BY sent_at ASC NULLS LAST, received_at ASC
    `).all(threadId);

    const actions = db.prepare(`
      SELECT * FROM crm_actions
      WHERE thread_id = ?
      ORDER BY created_at DESC
    `).all(threadId);

    return { thread, messages, actions };
  }

  /**
   * List threads filtered by status across all contacts.
   * Used by the dashboard "venter" / "nye" KPI badges to show what
   * needs attention without drilling into each contact tab.
   *
   * Returned rows are joined with contact info (email, name, type, agent_name)
   * + a snippet of the latest inbound message for quick context.
   *
   * `status` is optional (omit to search across all statuses) and `opts.contactEmail`
   * filters to a single contact (case-insensitive) regardless of status — used by the
   * per-contact thread lookup (`GET /admin/crm/threads?contact_email=`).
   */
  listThreadsByStatus(
    status: ThreadStatus | undefined,
    opts: { limit?: number; offset?: number; vertical?: CrmVertical; contactEmail?: string } = {}
  ): any[] {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 200, 500);
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: any[] = [];
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (opts.contactEmail) {
      conditions.push("LOWER(c.email) = LOWER(?)");
      params.push(opts.contactEmail);
    }
    if (opts.vertical) {
      conditions.push("t.vertical_id = ?");
      params.push(opts.vertical);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    return db.prepare(`
      SELECT
        t.id,
        t.subject,
        t.status,
        t.severity,
        t.category,
        t.assigned_to,
        t.message_count,
        t.last_message_at,
        t.created_at,
        c.id          AS contact_id,
        c.email       AS contact_email,
        c.name        AS contact_name,
        c.organization AS contact_organization,
        c.type        AS contact_type,
        c.agent_id,
        a.name        AS agent_name,
        (
          SELECT m.snippet
          FROM crm_messages m
          WHERE m.thread_id = t.id AND m.direction = 'in'
          ORDER BY m.sent_at DESC NULLS LAST, m.received_at DESC
          LIMIT 1
        ) AS last_inbound_snippet,
        (
          SELECT m.from_email
          FROM crm_messages m
          WHERE m.thread_id = t.id AND m.direction = 'in'
          ORDER BY m.sent_at DESC NULLS LAST, m.received_at DESC
          LIMIT 1
        ) AS last_inbound_from
      FROM crm_threads t
      JOIN crm_contacts c ON c.id = t.contact_id
      LEFT JOIN agents a ON a.id = c.agent_id
      ${whereSql}
      ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);
  }

  /**
   * Phase 4.10c — list outbound messages with thread + contact context for the
   * "Sendt-logg"-page. Used by the admin /admin/crm/sent-log dashboard so
   * Daniel can see every email leaving kontakt@rettfrabonden.com (autonomous
   * via Claude or manual via Daniel) on a single sortable page.
   *
   * NB: only returns messages with direction='out'. Filters by sent_at when
   * `since_hours` is given; otherwise all-time. Always orders newest first.
   */
  listSentMessages(opts: {
    sinceHours?: number;
    limit?: number;
    deliveryStatus?: "sent" | "queued" | "draft_in_gmail" | "failed";
  } = {}): Array<{
    message_id: string;
    thread_id: string;
    sent_at: string | null;
    received_at: string;
    delivery_status: string;
    from_email: string;
    to_emails: string;
    subject: string | null;
    actor: string | null;
    channel: string | null;
    contact_email: string | null;
    contact_name: string | null;
    contact_organization: string | null;
    thread_subject: string | null;
    thread_status: string | null;
    thread_origin: "compose" | "inbound";
  }> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 500, 2000);
    const where: string[] = ["m.direction = 'out'"];
    const params: unknown[] = [];

    if (opts.sinceHours) {
      const cutoff = new Date(Date.now() - opts.sinceHours * 3600_000).toISOString();
      where.push("(m.sent_at >= ? OR m.received_at >= ?)");
      params.push(cutoff, cutoff);
    }
    if (opts.deliveryStatus) {
      where.push("m.delivery_status = ?");
      params.push(opts.deliveryStatus);
    }

    const sql = `
      SELECT
        m.id              AS message_id,
        m.thread_id,
        m.sent_at,
        m.received_at,
        m.delivery_status,
        m.from_email,
        m.to_emails,
        m.subject,
        m.raw_metadata,
        t.subject         AS thread_subject,
        t.status          AS thread_status,
        c.email           AS contact_email,
        c.name            AS contact_name,
        c.organization    AS contact_organization,
        COALESCE(
          -- (1) Primary: the per-message action that carries this exact id.
          -- The compose route logs type='sent' with internalMessageId; back-compat
          -- callers that skip the route log type='composed' with messageId only.
          -- Prefer 'sent' when both exist (ORDER BY CASE ensures it ranks first).
          (
            SELECT a.actor
            FROM crm_actions a
            WHERE a.thread_id = m.thread_id
              AND a.type IN ('sent', 'composed')
              AND (
                json_extract(a.payload, '$.internalMessageId') = m.id
                OR json_extract(a.payload, '$.messageId') = m.id
              )
            ORDER BY
              CASE a.type WHEN 'sent' THEN 0 ELSE 1 END ASC,
              a.created_at DESC
            LIMIT 1
          ),
          -- (2) PR-B3 fix: rows ingested from Gmail by ingestThread() are keyed by
          -- the Gmail messageId, so no 'sent'/'composed' action's payload id ever
          -- equals m.id (the route logs the EXTERNAL Resend id, never the Gmail id).
          -- These dominate the sent-log, which is why actor was null platform-wide
          -- and PR-21-v2's compose-only repair never reached them. Bridge via the
          -- outbox, which records the authoritative actor (created_by) at send time.
          -- (2a) Precise: an outbox row whose result_id == this message id.
          (
            SELECT o.created_by FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.result_id = m.id
              AND o.created_by IS NOT NULL
            ORDER BY o.processed_at DESC LIMIT 1
          ),
          -- (2b) Thread-level: most recent completed outbox send on this thread.
          -- Outbound on a CRM thread is single-identity (kontakt@), and created_by
          -- distinguishes claude vs daniel, so thread-level attribution is sound
          -- when no precise id match exists.
          (
            SELECT o.created_by FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.status = 'completed'
              AND o.created_by IS NOT NULL
            ORDER BY o.processed_at DESC, o.created_at DESC LIMIT 1
          )
        ) AS sent_actor,
        COALESCE(
          -- Channel: prefer action payload's $.channel (set by sent-path).
          (
            SELECT json_extract(a.payload, '$.channel')
            FROM crm_actions a
            WHERE a.thread_id = m.thread_id
              AND a.type IN ('sent', 'composed')
              AND (
                json_extract(a.payload, '$.internalMessageId') = m.id
                OR json_extract(a.payload, '$.messageId') = m.id
              )
            ORDER BY
              CASE a.type WHEN 'sent' THEN 0 ELSE 1 END ASC,
              a.created_at DESC
            LIMIT 1
          ),
          -- PR-B3: derive channel from the bridging outbox row (see actor above).
          -- resend_send -> resend_smtp, gmail_draft -> gmail.
          (
            SELECT CASE o.intent WHEN 'resend_send' THEN 'resend_smtp' WHEN 'gmail_draft' THEN 'gmail' END
            FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.result_id = m.id
            ORDER BY o.processed_at DESC LIMIT 1
          ),
          (
            SELECT CASE o.intent WHEN 'resend_send' THEN 'resend_smtp' WHEN 'gmail_draft' THEN 'gmail' END
            FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.status = 'completed'
            ORDER BY o.processed_at DESC, o.created_at DESC LIMIT 1
          ),
          -- For compose-origin messages (thread_id starts with 'compose-') that
          -- reached delivery_status='sent' but have no channel anywhere,
          -- fall back to 'resend_smtp' — these go out exclusively via Resend.
          CASE
            WHEN m.delivery_status = 'sent'
              AND m.thread_id LIKE 'compose-%'
            THEN 'resend_smtp'
            ELSE NULL
          END
        ) AS sent_channel
      FROM crm_messages m
      JOIN crm_threads t ON t.id = m.thread_id
      JOIN crm_contacts c ON c.id = t.contact_id
      WHERE ${where.join(" AND ")}
      ORDER BY datetime(COALESCE(m.sent_at, m.received_at)) DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as any[];

    return rows.map((r: any) => {
      let actor: string | null = r.sent_actor ?? null;
      // Fallback: parse from raw_metadata.createdBy if no action found for actor
      if (!actor && r.raw_metadata) {
        try {
          const meta = JSON.parse(r.raw_metadata);
          actor = meta?.createdBy ?? null;
        } catch { /* ignore */ }
      }
      // channel: SQL subquery handles the primary lookup + compose-origin fallback.
      // TypeScript-level safety net: if subquery returned null for a compose-origin
      // sent message (e.g. very old row before action logging was added), fall back.
      let channel: string | null = r.sent_channel ?? null;
      if (!channel && r.delivery_status === 'sent' && String(r.thread_id).startsWith('compose-')) {
        channel = 'resend_smtp';
      }
      return {
        message_id: r.message_id,
        thread_id: r.thread_id,
        sent_at: r.sent_at,
        received_at: r.received_at,
        delivery_status: r.delivery_status,
        from_email: r.from_email,
        to_emails: r.to_emails,
        subject: r.subject,
        actor,
        channel,
        contact_email: r.contact_email,
        contact_name: r.contact_name,
        contact_organization: r.contact_organization,
        thread_subject: r.thread_subject,
        thread_status: r.thread_status,
        thread_origin: String(r.thread_id).startsWith("compose-") ? "compose" : "inbound",
      };
    });
  }

  /**
   * Cross-tab summary for the dashboard header.
   */
  getDashboardSummary(vertical?: CrmVertical): any {
    const db = getDb();
    const V = vSql("vertical_id", vertical);
    const counts = this.countContactsByType(vertical);
    const newThreads = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'new'${V}`).get() as any).c;
    const awaitingReview = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'awaiting_review'${V}`).get() as any).c;
    const inProgress = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'in_progress'${V}`).get() as any).c;
    const p0Open = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE severity = 'p0' AND status NOT IN ('done','archived')${V}`).get() as any).c;
    const pendingOutbox = (db.prepare(`SELECT COUNT(*) AS c FROM crm_outbox WHERE status = 'pending'${V}`).get() as any).c;

    return {
      contacts: counts,
      threads: { new: newThreads, in_progress: inProgress, awaiting_review: awaitingReview, p0_open: p0Open },
      outbox: { pending: pendingOutbox },
      vertical: vertical || "all",
      generated_at: new Date().toISOString(),
    };
  }
}

export const crmService = new CrmService();

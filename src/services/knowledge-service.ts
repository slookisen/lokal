import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { getDb } from "../database/init";

// ─── Agent Knowledge Service ──────────────────────────────────
// The "Google My Business" layer for food agents.
//
// Every agent gets a knowledge profile — auto-populated from
// public sources at registration, enriched over time.
//
// When a buyer agent asks about a seller, this service returns
// everything we know: address, products, hours, reviews, etc.
//
// When a seller claims their agent, they can override and enrich
// the auto-populated data with verified, first-party info.
//
// Data provenance is always tracked:
//   - 'auto'   = scraped/imported from public sources
//   - 'owner'  = seller-provided after claiming
//   - 'hybrid' = mix of both (auto base + owner overrides)

export interface AgentKnowledge {
  agentId: string;
  address?: string;
  postalCode?: string;
  website?: string;
  phone?: string;
  email?: string;
  openingHours: OpeningHour[];
  products: ProductInfo[];
  about?: string;
  specialties: string[];
  certifications: string[];
  paymentMethods: string[];
  deliveryOptions: string[];
  googleRating?: number;
  googleReviewCount?: number;
  tripadvisorRating?: number;
  externalReviews: ExternalReview[];
  externalLinks: ExternalLink[];
  images: string[];
  dataSource: "auto" | "owner" | "hybrid";
  autoSources: string[];
  lastEnrichedAt?: string;
  ownerUpdatedAt?: string;
  preferences: Record<string, any>;
}

export interface OpeningHour {
  day: string;       // "mon", "tue", etc. or "saturday" for markets
  open: string;      // "09:00"
  close: string;     // "17:00"
  note?: string;     // "Kun i sesong (juni-september)"
}

export interface ProductInfo {
  name: string;
  category: string;
  seasonal: boolean;
  months?: number[];  // [6,7,8,9] = June-September
  organic?: boolean;
  note?: string;
}

export interface ExternalReview {
  source: string;
  text: string;
  rating?: number;
  date?: string;
}

export interface ExternalLink {
  label: string;      // "Facebook-gruppe", "Neste marked"
  url: string;        // Full URL
  type: string;       // "facebook", "info", "schedule", "website"
}

// ─── Structured response for buyer agents ───────────────────
// This is what a buyer agent gets when asking about a seller.
// Clean, parseable, honest about data provenance.

export interface AgentInfoResponse {
  agent: {
    id: string;
    name: string;
    role: string;
    city?: string;
    trustScore: number;
    isVerified: boolean;
    isClaimed: boolean;
  };
  knowledge: {
    address?: string;
    postalCode?: string;
    website?: string;
    phone?: string;
    email?: string;
    openingHours: OpeningHour[];
    products: ProductInfo[];
    about?: string;
    specialties: string[];
    certifications: string[];
    paymentMethods: string[];
    deliveryOptions: string[];
    ratings?: {
      google?: { score: number; reviews: number };
      tripadvisor?: { score: number };
    };
  };
  meta: {
    dataSource: "auto" | "owner" | "hybrid";
    autoSources: string[];
    lastUpdated: string;
    disclaimer: string;
  };
}

class KnowledgeService {

  // ─── Get knowledge for an agent ──────────────────────────
  getKnowledge(agentId: string): AgentKnowledge | null {
    const db = getDb();
    const row = db.prepare(`SELECT agent_id, address, postal_code, website, phone, email,
      opening_hours, products, about, specialties, certifications, payment_methods,
      delivery_options, google_rating, google_review_count, tripadvisor_rating,
      external_reviews, external_links, data_source, auto_sources, last_enriched_at,
      owner_updated_at, preferences FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as any;
    if (!row) return null;
    return this.rowToKnowledge(row);
  }

  // ─── Get structured info response for buyer agents ────────
  // This is the main endpoint buyers use: "tell me about this seller"
  getAgentInfo(agentId: string): AgentInfoResponse | null {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return null;

    const knowledge = this.getKnowledge(agentId);
    const isClaimed = this.isAgentClaimed(agentId);

    const dataSource = knowledge?.dataSource || "auto";
    const lastUpdated = knowledge?.ownerUpdatedAt || knowledge?.lastEnrichedAt || agent.created_at;

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        city: agent.city,
        trustScore: agent.trust_score,
        isVerified: agent.is_verified === 1,
        isClaimed,
      },
      knowledge: {
        address: knowledge?.address,
        postalCode: knowledge?.postalCode,
        website: knowledge?.website,
        phone: knowledge?.phone,
        email: knowledge?.email,
        openingHours: knowledge?.openingHours || [],
        products: knowledge?.products || [],
        about: knowledge?.about || agent.description,
        specialties: knowledge?.specialties || [],
        certifications: knowledge?.certifications || [],
        paymentMethods: knowledge?.paymentMethods || [],
        deliveryOptions: knowledge?.deliveryOptions || [],
        ratings: this.buildRatings(knowledge),
      },
      meta: {
        dataSource,
        autoSources: knowledge?.autoSources || [],
        lastUpdated,
        disclaimer: dataSource === "owner"
          ? "Denne informasjonen er verifisert av eieren."
          : "Denne informasjonen er basert på offentlig tilgjengelige kilder og kan være utdatert. Kontakt selger direkte for oppdatert informasjon.",
      },
    };
  }

  // ─── Set/update knowledge (used by enrichment + owner) ────
  upsertKnowledge(agentId: string, data: Partial<AgentKnowledge>): void {
    const db = getDb();
    const existing = this.getKnowledge(agentId);
    const now = new Date().toISOString();

    if (!existing) {
      db.prepare(`
        INSERT INTO agent_knowledge (
          agent_id, address, postal_code, website, phone, email,
          opening_hours, products, about, specialties, certifications,
          payment_methods, delivery_options, google_rating, google_review_count,
          tripadvisor_rating, external_reviews, external_links, images,
          data_source, auto_sources, last_enriched_at, preferences,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agentId,
        data.address || null,
        data.postalCode || null,
        data.website || null,
        data.phone || null,
        data.email || null,
        JSON.stringify(data.openingHours || []),
        JSON.stringify(data.products || []),
        data.about || null,
        JSON.stringify(data.specialties || []),
        JSON.stringify(data.certifications || []),
        JSON.stringify(data.paymentMethods || []),
        JSON.stringify(data.deliveryOptions || []),
        data.googleRating || null,
        data.googleReviewCount || null,
        data.tripadvisorRating || null,
        JSON.stringify(data.externalReviews || []),
        JSON.stringify(data.externalLinks || []),
        JSON.stringify(data.images || []),
        data.dataSource || "auto",
        JSON.stringify(data.autoSources || []),
        now,
        JSON.stringify(data.preferences || {}),
        now, now,
      );
    } else {
      // Merge: owner data takes precedence over auto data
      const merged = this.mergeKnowledge(existing, data);
      const isOwnerUpdate = data.dataSource === "owner";

      db.prepare(`
        UPDATE agent_knowledge SET
          address = ?, postal_code = ?, website = ?, phone = ?, email = ?,
          opening_hours = ?, products = ?, about = ?, specialties = ?,
          certifications = ?, payment_methods = ?, delivery_options = ?,
          google_rating = ?, google_review_count = ?, tripadvisor_rating = ?,
          external_reviews = ?, external_links = ?, images = ?,
          data_source = ?,
          auto_sources = ?,
          last_enriched_at = CASE WHEN ? = 'auto' THEN ? ELSE last_enriched_at END,
          owner_updated_at = CASE WHEN ? = 'owner' THEN ? ELSE owner_updated_at END,
          preferences = ?,
          updated_at = ?
        WHERE agent_id = ?
      `).run(
        merged.address || null,
        merged.postalCode || null,
        merged.website || null,
        merged.phone || null,
        merged.email || null,
        JSON.stringify(merged.openingHours || []),
        JSON.stringify(merged.products || []),
        merged.about || null,
        JSON.stringify(merged.specialties || []),
        JSON.stringify(merged.certifications || []),
        JSON.stringify(merged.paymentMethods || []),
        JSON.stringify(merged.deliveryOptions || []),
        merged.googleRating || null,
        merged.googleReviewCount || null,
        merged.tripadvisorRating || null,
        JSON.stringify(merged.externalReviews || []),
        JSON.stringify(merged.externalLinks || []),
        JSON.stringify(merged.images || []),
        isOwnerUpdate ? (existing.dataSource === "auto" ? "hybrid" : "owner") : merged.dataSource,
        JSON.stringify(merged.autoSources || []),
        data.dataSource || "auto", now,
        data.dataSource || "auto", now,
        JSON.stringify(merged.preferences || {}),
        now,
        agentId,
      );
    }
  }

  // ─── Owner update (after claiming) ──────────────────────
  ownerUpdate(agentId: string, data: Partial<AgentKnowledge>): void {
    this.upsertKnowledge(agentId, { ...data, dataSource: "owner" });
  }

  // ─── Bulk enrich from auto sources ─────────────────────
  bulkEnrich(enrichments: Array<{ agentId: string; data: Partial<AgentKnowledge> }>): number {
    const db = getDb();
    let count = 0;
    const transaction = db.transaction(() => {
      for (const { agentId, data } of enrichments) {
        try {
          this.upsertKnowledge(agentId, { ...data, dataSource: "auto" });
          count++;
        } catch (e) {
          console.error(`Failed to enrich agent ${agentId}:`, e);
        }
      }
    });
    transaction();
    return count;
  }

  // ─── Claim system ──────────────────────────────────────

  isAgentClaimed(agentId: string): boolean {
    const db = getDb();
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status = 'verified'"
    ).get(agentId) as any;
    return row.c > 0;
  }

  requestClaim(agentId: string, opts: {
    claimantName: string;
    claimantEmail: string;
    claimantPhone?: string;
    source?: string;
  }): { claimId: string; verificationCode: string } {
    const db = getDb();
    const id = uuid();
    const code = this.generateVerificationCode();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    // Check if this specific email already has a verified claim on this agent
    const existingClaim = db.prepare(
      "SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND claimant_email = ? AND status = 'verified'"
    ).get(agentId, opts.claimantEmail) as any;
    if (existingClaim.c > 0) {
      throw new Error("Du har allerede gjort krav på denne agenten. Bruk innlogging med e-post.");
    }

    // Clear any stale pending claims (since email isn't implemented yet,
    // users can't complete old claims — let them try again)
    db.prepare(
      "DELETE FROM agent_claims WHERE agent_id = ? AND status IN ('pending','code_sent')"
    ).run(agentId);

    db.prepare(`
      INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_code, status, source, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'code_sent', ?, ?, ?)
    `).run(id, agentId, opts.claimantName, opts.claimantEmail, opts.claimantPhone || null, code, opts.source || 'organic', expiresAt, now);

    return { claimId: id, verificationCode: code };
  }

  verifyClaim(claimId: string, code: string): { success: boolean; claimToken?: string; error?: string } {
    const db = getDb();
    const claim = db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(claimId) as any;

    if (!claim) return { success: false, error: "Claim not found" };
    if (claim.status === "verified") return { success: false, error: "Already verified" };
    if (claim.status === "expired" || claim.status === "rejected") {
      return { success: false, error: `Claim is ${claim.status}` };
    }

    // Check expiry
    if (new Date(claim.expires_at) < new Date()) {
      db.prepare("UPDATE agent_claims SET status = 'expired' WHERE id = ?").run(claimId);
      return { success: false, error: "Claim has expired" };
    }

    // Verify code
    if (claim.verification_code !== code) {
      return { success: false, error: "Invalid verification code" };
    }

    // Success — generate claim token for future management (expires in 30 days)
    const claimToken = `claim_${crypto.randomBytes(32).toString("hex")}`;
    const now = new Date().toISOString();
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE agent_claims SET status = 'verified', claim_token = ?, claim_token_expires_at = ?, verified_at = ?
      WHERE id = ?
    `).run(claimToken, tokenExpiry, now, claimId);

    // Mark agent as verified
    db.prepare("UPDATE agents SET is_verified = 1 WHERE id = ?").run(claim.agent_id);

    // Update knowledge data_source
    const knowledge = this.getKnowledge(claim.agent_id);
    if (knowledge) {
      db.prepare("UPDATE agent_knowledge SET data_source = 'hybrid' WHERE agent_id = ? AND data_source = 'auto'")
        .run(claim.agent_id);
    }

    return { success: true, claimToken };
  }

  getClaimByToken(token: string): { agentId: string; claimantName: string; claimantEmail: string } | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT agent_id, claimant_name, claimant_email, claim_token_expires_at
       FROM agent_claims WHERE claim_token = ? AND status = 'verified'`
    ).get(token) as any;
    if (!row) return null;

    // Reject expired tokens (null expires_at = legacy token, allow for now)
    if (row.claim_token_expires_at && new Date(row.claim_token_expires_at) < new Date()) {
      return null;
    }

    return { agentId: row.agent_id, claimantName: row.claimant_name, claimantEmail: row.claimant_email };
  }

  // ─── Resend claim token (lost login) ─────────────
  resendClaimToken(agentId: string, email: string): { success: boolean; claimToken?: string; error?: string } {
    const db = getDb();
    const claim = db.prepare(
      "SELECT * FROM agent_claims WHERE agent_id = ? AND status = 'verified' AND claimant_email = ?"
    ).get(agentId, email) as any;

    if (!claim) {
      return { success: false, error: "Ingen verifisert krav funnet for denne e-postadressen" };
    }

    const newToken = `claim_${crypto.randomBytes(32).toString("hex")}`;
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agent_claims SET claim_token = ?, claim_token_expires_at = ? WHERE id = ?").run(newToken, tokenExpiry, claim.id);
    return { success: true, claimToken: newToken };
  }

  // ─── Magic Link Login ─────────────────────────────────

  createMagicLink(email: string): { success: boolean; token?: string; agentId?: string; agentName?: string; error?: string } {
    const db = getDb();

    // Find verified claim for this email
    const claim = db.prepare(
      `SELECT ac.agent_id, ac.claim_token, a.name as agent_name
       FROM agent_claims ac
       JOIN agents a ON a.id = ac.agent_id
       WHERE ac.claimant_email = ? AND ac.status = 'verified'
       ORDER BY ac.verified_at DESC LIMIT 1`
    ).get(email) as any;

    if (!claim) {
      return { success: false, error: "Ingen registrert agent funnet for denne e-postadressen" };
    }

    // Generate a secure magic link token (valid 15 min)
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const id = uuid();

    db.prepare(
      `INSERT INTO magic_links (id, email, token, agent_id, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, email, token, claim.agent_id, expiresAt);

    return { success: true, token, agentId: claim.agent_id, agentName: claim.agent_name };
  }

  verifyMagicLink(token: string): { success: boolean; agentId?: string; claimToken?: string; claimantName?: string; error?: string } {
    const db = getDb();

    const link = db.prepare(
      `SELECT ml.*, ac.claim_token, ac.claimant_name
       FROM magic_links ml
       JOIN agent_claims ac ON ac.agent_id = ml.agent_id AND ac.claimant_email = ml.email AND ac.status = 'verified'
       WHERE ml.token = ? AND ml.used = 0`
    ).get(token) as any;

    if (!link) {
      return { success: false, error: "Ugyldig eller brukt lenke" };
    }

    if (new Date(link.expires_at) < new Date()) {
      return { success: false, error: "Lenken har utløpt. Be om en ny." };
    }

    // Mark as used
    db.prepare(`UPDATE magic_links SET used = 1 WHERE token = ?`).run(token);

    // Clean up old magic links (older than 1 hour)
    db.prepare(`DELETE FROM magic_links WHERE expires_at < datetime('now', '-1 hour')`).run();

    // Refresh the claim token — extend expiry by 30 days on each successful login
    const crypto = require("crypto");
    const newToken = `claim_${crypto.randomBytes(32).toString("hex")}`;
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE agent_claims SET claim_token = ?, claim_token_expires_at = ? WHERE agent_id = ? AND claimant_email = ? AND status = 'verified'`
    ).run(newToken, newExpiry, link.agent_id, link.email);

    return {
      success: true,
      agentId: link.agent_id,
      claimToken: newToken,
      claimantName: link.claimant_name,
    };
  }

  // ─── Stats ────────────────────────────────────────────

  getKnowledgeStats(): { total: number; enriched: number; claimed: number; autoOnly: number; ownerOrHybrid: number } {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const enriched = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get() as any).c;
    const claimed = (db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE status = 'verified'").get() as any).c;
    const autoOnly = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source = 'auto'").get() as any).c;
    const ownerOrHybrid = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source IN ('owner','hybrid')").get() as any).c;

    return { total, enriched, claimed, autoOnly, ownerOrHybrid };
  }

  // ─── Private helpers ─────────────────────────────────────

  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private mergeKnowledge(existing: AgentKnowledge, update: Partial<AgentKnowledge>): AgentKnowledge {
    // Owner data always wins over auto data
    return {
      agentId: existing.agentId,
      address: update.address ?? existing.address,
      postalCode: update.postalCode ?? existing.postalCode,
      website: update.website ?? existing.website,
      phone: update.phone ?? existing.phone,
      email: update.email ?? existing.email,
      openingHours: update.openingHours?.length ? update.openingHours : existing.openingHours,
      products: update.products?.length ? update.products : existing.products,
      about: update.about ?? existing.about,
      specialties: update.specialties?.length ? update.specialties : existing.specialties,
      certifications: update.certifications?.length ? update.certifications : existing.certifications,
      paymentMethods: update.paymentMethods?.length ? update.paymentMethods : existing.paymentMethods,
      deliveryOptions: update.deliveryOptions?.length ? update.deliveryOptions : existing.deliveryOptions,
      googleRating: update.googleRating ?? existing.googleRating,
      googleReviewCount: update.googleReviewCount ?? existing.googleReviewCount,
      tripadvisorRating: update.tripadvisorRating ?? existing.tripadvisorRating,
      externalReviews: update.externalReviews?.length ? update.externalReviews : existing.externalReviews,
      externalLinks: update.externalLinks?.length ? update.externalLinks : existing.externalLinks,
      images: update.images?.length ? update.images : existing.images,
      dataSource: update.dataSource || existing.dataSource,
      autoSources: [...new Set([...(existing.autoSources || []), ...(update.autoSources || [])])],
      lastEnrichedAt: update.lastEnrichedAt ?? existing.lastEnrichedAt,
      ownerUpdatedAt: update.ownerUpdatedAt ?? existing.ownerUpdatedAt,
      preferences: { ...(existing.preferences || {}), ...(update.preferences || {}) },
    };
  }

  private buildRatings(knowledge: AgentKnowledge | null): AgentInfoResponse["knowledge"]["ratings"] {
    if (!knowledge) return undefined;
    const ratings: any = {};
    if (knowledge.googleRating) {
      ratings.google = { score: knowledge.googleRating, reviews: knowledge.googleReviewCount || 0 };
    }
    if (knowledge.tripadvisorRating) {
      ratings.tripadvisor = { score: knowledge.tripadvisorRating };
    }
    return Object.keys(ratings).length > 0 ? ratings : undefined;
  }

  private rowToKnowledge(row: any): AgentKnowledge {
    return {
      agentId: row.agent_id,
      address: row.address,
      postalCode: row.postal_code,
      website: row.website,
      phone: row.phone,
      email: row.email,
      openingHours: row.opening_hours ? JSON.parse(row.opening_hours) : [],
      products: row.products ? JSON.parse(row.products) : [],
      about: row.about,
      specialties: row.specialties ? JSON.parse(row.specialties) : [],
      certifications: row.certifications ? JSON.parse(row.certifications) : [],
      paymentMethods: row.payment_methods ? JSON.parse(row.payment_methods) : [],
      deliveryOptions: row.delivery_options ? JSON.parse(row.delivery_options) : [],
      googleRating: row.google_rating,
      googleReviewCount: row.google_review_count,
      tripadvisorRating: row.tripadvisor_rating,
      externalReviews: row.external_reviews ? JSON.parse(row.external_reviews) : [],
      externalLinks: row.external_links ? JSON.parse(row.external_links) : [],
      images: row.images ? JSON.parse(row.images) : [],
      dataSource: row.data_source || "auto",
      autoSources: row.auto_sources ? JSON.parse(row.auto_sources) : [],
      lastEnrichedAt: row.last_enriched_at,
      ownerUpdatedAt: row.owner_updated_at,
      preferences: row.preferences ? JSON.parse(row.preferences) : {},
    };
  }
}

// Singleton
export const knowledgeService = new KnowledgeService();

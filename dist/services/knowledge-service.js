"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.knowledgeService = void 0;
const uuid_1 = require("uuid");
const crypto_1 = __importDefault(require("crypto"));
const init_1 = require("../database/init");
class KnowledgeService {
    getKnowledge(agentId) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
        if (!row)
            return null;
        return this.rowToKnowledge(row);
    }
    getAgentInfo(agentId) {
        const db = (0, init_1.getDb)();
        const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
        if (!agent)
            return null;
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
                    : "Denne informasjonen er basert p\u00e5 offentlig tilgjengelige kilder og kan v\u00e6re utdatert. Kontakt selger direkte for oppdatert informasjon.",
            },
        };
    }
    upsertKnowledge(agentId, data) {
        const db = (0, init_1.getDb)();
        const existing = this.getKnowledge(agentId);
        const now = new Date().toISOString();
        if (!existing) {
            db.prepare(`
        INSERT INTO agent_knowledge (
          agent_id, address, postal_code, website, phone, email,
          opening_hours, products, about, specialties, certifications,
          payment_methods, delivery_options, google_rating, google_review_count,
          tripadvisor_rating, external_reviews, images,
          data_source, auto_sources, last_enriched_at, preferences,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agentId, data.address || null, data.postalCode || null, data.website || null, data.phone || null, data.email || null, JSON.stringify(data.openingHours || []), JSON.stringify(data.products || []), data.about || null, JSON.stringify(data.specialties || []), JSON.stringify(data.certifications || []), JSON.stringify(data.paymentMethods || []), JSON.stringify(data.deliveryOptions || []), data.googleRating || null, data.googleReviewCount || null, data.tripadvisorRating || null, JSON.stringify(data.externalReviews || []), JSON.stringify(data.images || []), data.dataSource || "auto", JSON.stringify(data.autoSources || []), now, JSON.stringify(data.preferences || {}), now, now);
        }
        else {
            const merged = this.mergeKnowledge(existing, data);
            const isOwnerUpdate = data.dataSource === "owner";
            db.prepare(`
        UPDATE agent_knowledge SET
          address = ?, postal_code = ?, website = ?, phone = ?, email = ?,
          opening_hours = ?, products = ?, about = ?, specialties = ?,
          certifications = ?, payment_methods = ?, delivery_options = ?,
          google_rating = ?, google_review_count = ?, tripadvisor_rating = ?,
          external_reviews = ?, images = ?,
          data_source = ?,
          auto_sources = ?,
          last_enriched_at = CASE WHEN ? = 'auto' THEN ? ELSE last_enriched_at END,
          owner_updated_at = CASE WHEN ? = 'owner' THEN ? ELSE owner_updated_at END,
          preferences = ?,
          updated_at = ?
        WHERE agent_id = ?
      `).run(merged.address || null, merged.postalCode || null, merged.website || null, merged.phone || null, merged.email || null, JSON.stringify(merged.openingHours || []), JSON.stringify(merged.products || []), merged.about || null, JSON.stringify(merged.specialties || []), JSON.stringify(merged.certifications || []), JSON.stringify(merged.paymentMethods || []), JSON.stringify(merged.deliveryOptions || []), merged.googleRating || null, merged.googleReviewCount || null, merged.tripadvisorRating || null, JSON.stringify(merged.externalReviews || []), JSON.stringify(merged.images || []), isOwnerUpdate ? (existing.dataSource === "auto" ? "hybrid" : "owner") : merged.dataSource, JSON.stringify(merged.autoSources || []), data.dataSource || "auto", now, data.dataSource || "auto", now, JSON.stringify(merged.preferences || {}), now, agentId);
        }
    }
    ownerUpdate(agentId, data) {
        this.upsertKnowledge(agentId, { ...data, dataSource: "owner" });
    }
    bulkEnrich(enrichments) {
        const db = (0, init_1.getDb)();
        let count = 0;
        const transaction = db.transaction(() => {
            for (const { agentId, data } of enrichments) {
                try {
                    this.upsertKnowledge(agentId, { ...data, dataSource: "auto" });
                    count++;
                }
                catch (e) {
                    console.error(`Failed to enrich agent ${agentId}:`, e);
                }
            }
        });
        transaction();
        return count;
    }
    isAgentClaimed(agentId) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status = 'verified'").get(agentId);
        return row.c > 0;
    }
    requestClaim(agentId, opts) {
        const db = (0, init_1.getDb)();
        const id = (0, uuid_1.v4)();
        const code = this.generateVerificationCode();
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        if (this.isAgentClaimed(agentId)) {
            throw new Error("This agent has already been claimed");
        }
        db.prepare("DELETE FROM agent_claims WHERE agent_id = ? AND status IN ('pending','code_sent')").run(agentId);
        db.prepare(`
      INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_code, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'code_sent', ?, ?)
    `).run(id, agentId, opts.claimantName, opts.claimantEmail, opts.claimantPhone || null, code, expiresAt, now);
        return { claimId: id, verificationCode: code };
    }
    verifyClaim(claimId, code) {
        const db = (0, init_1.getDb)();
        const claim = db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(claimId);
        if (!claim)
            return { success: false, error: "Claim not found" };
        if (claim.status === "verified")
            return { success: false, error: "Already verified" };
        if (claim.status === "expired" || claim.status === "rejected") {
            return { success: false, error: `Claim is ${claim.status}` };
        }
        if (new Date(claim.expires_at) < new Date()) {
            db.prepare("UPDATE agent_claims SET status = 'expired' WHERE id = ?").run(claimId);
            return { success: false, error: "Claim has expired" };
        }
        if (claim.verification_code !== code) {
            return { success: false, error: "Invalid verification code" };
        }
        const claimToken = `claim_${crypto_1.default.randomBytes(32).toString("hex")}`;
        const now = new Date().toISOString();
        db.prepare(`
      UPDATE agent_claims SET status = 'verified', claim_token = ?, verified_at = ?
      WHERE id = ?
    `).run(claimToken, now, claimId);
        db.prepare("UPDATE agents SET is_verified = 1 WHERE id = ?").run(claim.agent_id);
        const knowledge = this.getKnowledge(claim.agent_id);
        if (knowledge) {
            db.prepare("UPDATE agent_knowledge SET data_source = 'hybrid' WHERE agent_id = ? AND data_source = 'auto'")
                .run(claim.agent_id);
        }
        return { success: true, claimToken };
    }
    getClaimByToken(token) {
        const db = (0, init_1.getDb)();
        const row = db.prepare("SELECT agent_id, claimant_name, claimant_email FROM agent_claims WHERE claim_token = ? AND status = 'verified'").get(token);
        return row ? { agentId: row.agent_id, claimantName: row.claimant_name, claimantEmail: row.claimant_email } : null;
    }
    resendClaimToken(agentId, email) {
        const db = (0, init_1.getDb)();
        const claim = db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? AND status = 'verified' AND claimant_email = ?").get(agentId, email);
        if (!claim) {
            return { success: false, error: "Ingen verifisert krav funnet for denne e-postadressen" };
        }
        const newToken = `claim_${crypto_1.default.randomBytes(32).toString("hex")}`;
        db.prepare("UPDATE agent_claims SET claim_token = ? WHERE id = ?").run(newToken, claim.id);
        return { success: true, claimToken: newToken };
    }
    getKnowledgeStats() {
        const db = (0, init_1.getDb)();
        const total = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
        const enriched = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get().c;
        const claimed = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE status = 'verified'").get().c;
        const autoOnly = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source = 'auto'").get().c;
        const ownerOrHybrid = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source IN ('owner','hybrid')").get().c;
        return { total, enriched, claimed, autoOnly, ownerOrHybrid };
    }
    generateVerificationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }
    mergeKnowledge(existing, update) {
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
            images: update.images?.length ? update.images : existing.images,
            dataSource: update.dataSource || existing.dataSource,
            autoSources: [...new Set([...(existing.autoSources || []), ...(update.autoSources || [])])],
            lastEnrichedAt: update.lastEnrichedAt ?? existing.lastEnrichedAt,
            ownerUpdatedAt: update.ownerUpdatedAt ?? existing.ownerUpdatedAt,
            preferences: { ...(existing.preferences || {}), ...(update.preferences || {}) },
        };
    }
    buildRatings(knowledge) {
        if (!knowledge)
            return undefined;
        const ratings = {};
        if (knowledge.googleRating) {
            ratings.google = { score: knowledge.googleRating, reviews: knowledge.googleReviewCount || 0 };
        }
        if (knowledge.tripadvisorRating) {
            ratings.tripadvisor = { score: knowledge.tripadvisorRating };
        }
        return Object.keys(ratings).length > 0 ? ratings : undefined;
    }
    rowToKnowledge(row) {
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
exports.knowledgeService = new KnowledgeService();
//# sourceMappingURL=knowledge-service.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.knowledgeService = void 0;
exports.isProductHeader = isProductHeader;
exports.isProductNoise = isProductNoise;
exports.parseProductPrice = parseProductPrice;
const uuid_1 = require("uuid");
const crypto_1 = __importDefault(require("crypto"));
const init_1 = require("../database/init");
// ─── Shared product parsing utilities ─────────────────────
// Used by MCP, A2A, auto-response, and web routes to normalize product data.
/** Check if a product entry is a section header (e.g. "🐑 LAM", "📋 STYKNINGSDELER") */
function isProductHeader(name) {
    if (!name || name.length > 50)
        return false;
    const stripped = name.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, "").trim();
    return /^[A-ZÆØÅÉ\s&]+$/.test(stripped) && stripped.length >= 2;
}
/** Check if a product entry should be skipped (dividers, out-of-stock notes, metadata) */
function isProductNoise(name) {
    if (!name)
        return true;
    if (/^[❌⸻─—\s]+$/.test(name))
        return true; // dividers
    if (/^❌\s/.test(name))
        return true; // "❌ Tomt for ..."
    if (/^(Alle unntatt|Håndlaget med)/i.test(name))
        return true; // notes
    if (/^Kr\s*\.?\s*\d/i.test(name) && !name.includes("–"))
        return true; // price-only lines like "Kr.1000"
    return false;
}
/** Parse price from a product name like "Lammelår – kr 275/kg" → { cleanName, price } */
function parseProductPrice(p) {
    const name = (p.name || "").trim();
    // Section header?
    if (isProductHeader(name)) {
        const headerText = name.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, "").trim();
        const subInfo = p.price && !/^\d/.test(p.price) ? p.price : null;
        return { cleanName: headerText, price: null, section: subInfo || headerText };
    }
    // Skip noise
    if (isProductNoise(name))
        return { cleanName: name, price: null, section: null };
    // Use existing price field if it has a numeric value
    let price = (p.price || "").trim();
    if (price && !/\d/.test(price))
        price = ""; // non-numeric price field = descriptor, not price
    let cleanName = name;
    // Parse price from name: "Product – kr XXX/kg" or "Product – kr XXX"
    if (!price) {
        const m = name.match(/^(.+?)\s*[–\-—]\s*kr\.?\s*([\d,.\s]+(?:\/\w+)?)\s*$/i);
        if (m) {
            cleanName = m[1].trim();
            price = `kr ${m[2].trim()}`;
        }
    }
    // "Product kr.XXX" (no dash)
    if (!price) {
        const m = name.match(/^(.+?)\s+kr\.?\s*([\d,.\s]+(?:\/\w+)?)\s*$/i);
        if (m) {
            cleanName = m[1].trim();
            price = `kr ${m[2].trim()}`;
        }
    }
    return { cleanName, price: price || null, section: null };
}
class KnowledgeService {
    // ─── Get knowledge for an agent ──────────────────────────
    getKnowledge(agentId) {
        const db = (0, init_1.getDb)();
        const row = db.prepare(`SELECT agent_id, address, postal_code, website, phone, email,
      opening_hours, products, about, specialties, certifications, payment_methods,
      delivery_options, google_rating, google_review_count, tripadvisor_rating,
      external_reviews, external_links, images, seasonality, delivery_radius, min_order_value,
      data_source, auto_sources, last_enriched_at,
      owner_updated_at, preferences FROM agent_knowledge WHERE agent_id = ?`).get(agentId);
        if (!row)
            return null;
        return this.rowToKnowledge(row);
    }
    // ─── Get structured info response for buyer agents ────────
    // This is the main endpoint buyers use: "tell me about this seller"
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
                languages: agent.languages ? JSON.parse(agent.languages) : ["no"],
                schemaVersion: agent.schema_version || "urn:a2a:1.0",
                agentVersion: agent.agent_version || 1,
            },
            knowledge: {
                address: knowledge?.address,
                postalCode: knowledge?.postalCode,
                website: knowledge?.website,
                phone: knowledge?.phone,
                email: knowledge?.email,
                openingHours: knowledge?.openingHours || [],
                products: knowledge?.products || [],
                about: knowledge?.about || "",
                description: agent.description || "",
                specialties: knowledge?.specialties || [],
                certifications: knowledge?.certifications || [],
                paymentMethods: knowledge?.paymentMethods || [],
                deliveryOptions: knowledge?.deliveryOptions || [],
                images: knowledge?.images || [],
                seasonality: knowledge?.seasonality || [],
                deliveryRadius: knowledge?.deliveryRadius,
                minOrderValue: knowledge?.minOrderValue,
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
    // ─── Normalize products before storage ─────────────────
    // Extracts prices embedded in product names and moves them to the price field.
    // This handles data from sellers who paste AI-extracted product lists.
    normalizeProducts(products) {
        if (!products?.length)
            return products;
        return products.map(p => {
            const name = (p.name || "").trim();
            if (!name)
                return p;
            // Skip if price field already has a numeric value
            if (p.price && /\d/.test(p.price))
                return p;
            // Skip section headers and noise
            if (isProductHeader(name) || isProductNoise(name))
                return p;
            const { cleanName, price } = parseProductPrice(p);
            if (price && cleanName !== name) {
                return { ...p, name: cleanName, price, priceUnit: p.priceUnit || "kr" };
            }
            return p;
        });
    }
    // ─── Set/update knowledge (used by enrichment + owner) ────
    upsertKnowledge(agentId, data) {
        const db = (0, init_1.getDb)();
        const existing = this.getKnowledge(agentId);
        const now = new Date().toISOString();
        // Normalize products: extract prices from name field before storage
        if (data.products?.length) {
            data = { ...data, products: this.normalizeProducts(data.products) };
        }
        if (!existing) {
            db.prepare(`
        INSERT INTO agent_knowledge (
          agent_id, address, postal_code, website, phone, email,
          opening_hours, products, about, specialties, certifications,
          payment_methods, delivery_options, google_rating, google_review_count,
          tripadvisor_rating, external_reviews, external_links, images,
          seasonality, delivery_radius, min_order_value,
          data_source, auto_sources, last_enriched_at, preferences,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agentId, data.address || null, data.postalCode || null, data.website || null, data.phone || null, data.email || null, JSON.stringify(data.openingHours || []), JSON.stringify(data.products || []), data.about || null, JSON.stringify(data.specialties || []), JSON.stringify(data.certifications || []), JSON.stringify(data.paymentMethods || []), JSON.stringify(data.deliveryOptions || []), data.googleRating || null, data.googleReviewCount || null, data.tripadvisorRating || null, JSON.stringify(data.externalReviews || []), JSON.stringify(data.externalLinks || []), JSON.stringify(data.images || []), JSON.stringify(data.seasonality || []), data.deliveryRadius || null, data.minOrderValue || null, data.dataSource || "auto", JSON.stringify(data.autoSources || []), now, JSON.stringify(data.preferences || {}), now, now);
        }
        else {
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
          seasonality = ?, delivery_radius = ?, min_order_value = ?,
          data_source = ?,
          auto_sources = ?,
          last_enriched_at = CASE WHEN ? = 'auto' THEN ? ELSE last_enriched_at END,
          owner_updated_at = CASE WHEN ? = 'owner' THEN ? ELSE owner_updated_at END,
          preferences = ?,
          updated_at = ?
        WHERE agent_id = ?
      `).run(merged.address || null, merged.postalCode || null, merged.website || null, merged.phone || null, merged.email || null, JSON.stringify(merged.openingHours || []), JSON.stringify(merged.products || []), merged.about || null, JSON.stringify(merged.specialties || []), JSON.stringify(merged.certifications || []), JSON.stringify(merged.paymentMethods || []), JSON.stringify(merged.deliveryOptions || []), merged.googleRating || null, merged.googleReviewCount || null, merged.tripadvisorRating || null, JSON.stringify(merged.externalReviews || []), JSON.stringify(merged.externalLinks || []), JSON.stringify(merged.images || []), JSON.stringify(merged.seasonality || []), merged.deliveryRadius || null, merged.minOrderValue || null, isOwnerUpdate ? (existing.dataSource === "auto" ? "hybrid" : "owner") : merged.dataSource, JSON.stringify(merged.autoSources || []), data.dataSource || "auto", now, data.dataSource || "auto", now, JSON.stringify(merged.preferences || {}), now, agentId);
        }
        // Auto-increment agent_version on every knowledge change (A2A spec compliance)
        try {
            db.prepare(`UPDATE agents SET agent_version = COALESCE(agent_version, 0) + 1 WHERE id = ?`).run(agentId);
        }
        catch {
            // Column may not exist yet on older DBs — safe to skip
        }
    }
    // ─── Owner update (after claiming) ──────────────────────
    ownerUpdate(agentId, data) {
        this.upsertKnowledge(agentId, { ...data, dataSource: "owner" });
    }
    // ─── Bulk enrich from auto sources ─────────────────────
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
    // ─── Claim system ──────────────────────────────────────
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
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
        // Check if this specific email already has a verified claim on this agent
        const existingClaim = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND claimant_email = ? AND status = 'verified'").get(agentId, opts.claimantEmail);
        if (existingClaim.c > 0) {
            throw new Error("Du har allerede gjort krav på denne agenten. Bruk innlogging med e-post.");
        }
        // Clear any stale pending claims (since email isn't implemented yet,
        // users can't complete old claims — let them try again)
        db.prepare("DELETE FROM agent_claims WHERE agent_id = ? AND status IN ('pending','code_sent')").run(agentId);
        db.prepare(`
      INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_code, status, source, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'code_sent', ?, ?, ?)
    `).run(id, agentId, opts.claimantName, opts.claimantEmail, opts.claimantPhone || null, code, opts.source || 'organic', expiresAt, now);
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
        const claimToken = `claim_${crypto_1.default.randomBytes(32).toString("hex")}`;
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
    getClaimByToken(token) {
        const db = (0, init_1.getDb)();
        const row = db.prepare(`SELECT agent_id, claimant_name, claimant_email, claim_token_expires_at
       FROM agent_claims WHERE claim_token = ? AND status = 'verified'`).get(token);
        if (!row)
            return null;
        // Reject expired tokens (null expires_at = legacy token, allow for now)
        if (row.claim_token_expires_at && new Date(row.claim_token_expires_at) < new Date()) {
            return null;
        }
        return { agentId: row.agent_id, claimantName: row.claimant_name, claimantEmail: row.claimant_email };
    }
    // ─── Resend claim token (lost login) ─────────────
    resendClaimToken(agentId, email) {
        const db = (0, init_1.getDb)();
        const claim = db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? AND status = 'verified' AND claimant_email = ?").get(agentId, email);
        if (!claim) {
            return { success: false, error: "Ingen verifisert krav funnet for denne e-postadressen" };
        }
        const newToken = `claim_${crypto_1.default.randomBytes(32).toString("hex")}`;
        const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("UPDATE agent_claims SET claim_token = ?, claim_token_expires_at = ? WHERE id = ?").run(newToken, tokenExpiry, claim.id);
        return { success: true, claimToken: newToken };
    }
    // ─── Magic Link Login ─────────────────────────────────
    createMagicLink(email) {
        const db = (0, init_1.getDb)();
        // Find verified claim for this email
        const claim = db.prepare(`SELECT ac.agent_id, ac.claim_token, a.name as agent_name
       FROM agent_claims ac
       JOIN agents a ON a.id = ac.agent_id
       WHERE ac.claimant_email = ? AND ac.status = 'verified'
       ORDER BY ac.verified_at DESC LIMIT 1`).get(email);
        if (!claim) {
            return { success: false, error: "Ingen registrert agent funnet for denne e-postadressen" };
        }
        // Generate a secure magic link token (valid 15 min)
        const token = crypto_1.default.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const id = (0, uuid_1.v4)();
        db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, expires_at) VALUES (?, ?, ?, ?, ?)`).run(id, email, token, claim.agent_id, expiresAt);
        return { success: true, token, agentId: claim.agent_id, agentName: claim.agent_name };
    }
    verifyMagicLink(token) {
        const db = (0, init_1.getDb)();
        const link = db.prepare(`SELECT ml.*, ac.claim_token, ac.claimant_name
       FROM magic_links ml
       JOIN agent_claims ac ON ac.agent_id = ml.agent_id AND ac.claimant_email = ml.email AND ac.status = 'verified'
       WHERE ml.token = ? AND ml.used = 0`).get(token);
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
        db.prepare(`UPDATE agent_claims SET claim_token = ?, claim_token_expires_at = ? WHERE agent_id = ? AND claimant_email = ? AND status = 'verified'`).run(newToken, newExpiry, link.agent_id, link.email);
        return {
            success: true,
            agentId: link.agent_id,
            claimToken: newToken,
            claimantName: link.claimant_name,
        };
    }
    // ─── Stats ────────────────────────────────────────────
    getKnowledgeStats() {
        const db = (0, init_1.getDb)();
        const total = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
        const enriched = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get().c;
        const claimed = db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE status = 'verified'").get().c;
        const autoOnly = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source = 'auto'").get().c;
        const ownerOrHybrid = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source IN ('owner','hybrid')").get().c;
        return { total, enriched, claimed, autoOnly, ownerOrHybrid };
    }
    // ─── Private helpers ─────────────────────────────────────
    generateVerificationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }
    mergeKnowledge(existing, update) {
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
            seasonality: update.seasonality?.length ? update.seasonality : existing.seasonality,
            deliveryRadius: update.deliveryRadius ?? existing.deliveryRadius,
            minOrderValue: update.minOrderValue ?? existing.minOrderValue,
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
            externalLinks: row.external_links ? JSON.parse(row.external_links) : [],
            images: row.images ? JSON.parse(row.images) : [],
            seasonality: row.seasonality ? JSON.parse(row.seasonality) : [],
            deliveryRadius: row.delivery_radius || undefined,
            minOrderValue: row.min_order_value || undefined,
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
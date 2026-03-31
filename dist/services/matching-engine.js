"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchingEngine = exports.MatchingEngine = void 0;
const store_1 = require("./store");
// ─── Matching Engine ───────────────────────────────────────────
// This is where Lokal is philosophically different from every
// other food platform. We rank by CONSUMER VALUES, not by
// producer ad spend, popularity, or revenue.
//
// A tiny farm with 3 products but amazing freshness and low prices
// WILL outrank a large chain that's more expensive and less fresh.
//
// The algorithm:
// 1. Filter (hard constraints: distance, dietary, availability)
// 2. Score (weighted preference matching)
// 3. Compare (price vs chains — the killer feature)
// 4. Rank (sort by match score, not popularity)
class MatchingEngine {
    /**
     * Find and rank local producers for a consumer's search.
     * This is the core A2A interaction: consumer agent asks, we match.
     */
    search(request) {
        const allInventory = store_1.store.getAvailableInventory();
        const results = [];
        for (const inventory of allInventory) {
            const product = store_1.store.getProduct(inventory.productId);
            const producer = store_1.store.getProducer(inventory.producerId);
            if (!product || !producer)
                continue;
            // ── Step 1: Hard Filters ──────────────────────────────
            if (!this.passesFilters(request, inventory, product, producer))
                continue;
            // ── Step 2: Preference Scoring ────────────────────────
            const distance = this.calculateDistance(request.location.lat, request.location.lng, producer.location.lat, producer.location.lng);
            const matchScore = this.calculateMatchScore(request, inventory, product, producer, distance);
            const matchReasons = this.generateMatchReasons(inventory, product, producer, distance);
            // ── Step 3: Chain Price Comparison ─────────────────────
            const chainComparison = this.compareWithChains(product.name, inventory.pricePerUnit, product.isOrganic);
            if (chainComparison) {
                matchReasons.push(chainComparison.comparisonLabel);
            }
            // ── Step 4: Build Result ──────────────────────────────
            const freshnessHours = inventory.harvestedAt
                ? (Date.now() - new Date(inventory.harvestedAt).getTime()) / (1000 * 60 * 60)
                : undefined;
            results.push({
                producerId: producer.id,
                producerName: producer.name,
                producerType: producer.type,
                distanceKm: Math.round(distance * 10) / 10,
                trustScore: producer.trustScore,
                product: {
                    productId: product.id,
                    name: product.name,
                    pricePerUnit: inventory.pricePerUnit,
                    unit: inventory.unit,
                    quantityAvailable: inventory.quantityAvailable,
                    isOrganic: product.isOrganic,
                    isSeasonal: product.isSeasonal,
                    freshnessHours: freshnessHours
                        ? Math.round(freshnessHours * 10) / 10
                        : undefined,
                },
                matchScore: Math.round(matchScore * 100) / 100,
                matchReasons,
                chainComparison: chainComparison || undefined,
            });
        }
        // Sort by match score (descending) — NOT by popularity, NOT by revenue
        return results.sort((a, b) => b.matchScore - a.matchScore);
    }
    // ─── Filters ───────────────────────────────────────────────
    passesFilters(request, inventory, product, producer) {
        // Distance filter
        if (request.maxDistanceKm || request.consumerPreferences?.maxDistanceKm) {
            const maxDist = request.maxDistanceKm ||
                request.consumerPreferences?.maxDistanceKm ||
                5;
            const distance = this.calculateDistance(request.location.lat, request.location.lng, producer.location.lat, producer.location.lng);
            if (distance > maxDist)
                return false;
        }
        // Category filter
        if (request.category && product.category !== request.category)
            return false;
        // Price filter
        if (request.maxPricePerUnit &&
            inventory.pricePerUnit > request.maxPricePerUnit)
            return false;
        // Organic filter
        if (request.mustBeOrganic && !product.isOrganic)
            return false;
        // Seasonal filter
        if (request.mustBeSeasonal && !product.isSeasonal)
            return false;
        // Text search (simple substring match for MVP)
        if (request.query) {
            const q = request.query.toLowerCase();
            const searchable = `${product.name} ${product.category} ${product.description || ""} ${producer.name}`.toLowerCase();
            if (!searchable.includes(q))
                return false;
        }
        return true;
    }
    // ─── Scoring ───────────────────────────────────────────────
    // Each factor produces a 0–1 score, weighted by consumer preferences.
    calculateMatchScore(request, inventory, product, producer, distanceKm) {
        const prefs = request.consumerPreferences;
        let score = 0;
        let totalWeight = 0;
        // Price score — lower price = higher score
        const priceScore = this.priceScore(inventory, product);
        const priceWeight = prefs?.priceSensitivity ?? 0.5;
        score += priceScore * priceWeight;
        totalWeight += priceWeight;
        // Freshness score — recently harvested = higher score
        const freshScore = this.freshnessScore(inventory);
        const freshWeight = prefs?.freshnessWeight ?? 0.7;
        score += freshScore * freshWeight;
        totalWeight += freshWeight;
        // Distance score — closer = higher score
        const distScore = this.distanceScore(distanceKm, prefs?.maxDistanceKm ?? 5);
        const distWeight = prefs?.localityWeight ?? 0.6;
        score += distScore * distWeight;
        totalWeight += distWeight;
        // Organic bonus
        if (product.isOrganic) {
            const organicWeight = prefs?.organicPreference ?? 0.3;
            score += 1.0 * organicWeight;
            totalWeight += organicWeight;
        }
        else {
            totalWeight += prefs?.organicPreference ?? 0.3;
        }
        // Seasonal bonus
        if (product.isSeasonal) {
            const seasonalWeight = prefs?.seasonalPreference ?? 0.5;
            score += 1.0 * seasonalWeight;
            totalWeight += seasonalWeight;
        }
        else {
            totalWeight += prefs?.seasonalPreference ?? 0.5;
        }
        // Trust score — producers with good history rank higher
        score += producer.trustScore * 0.3;
        totalWeight += 0.3;
        return totalWeight > 0 ? score / totalWeight : 0;
    }
    priceScore(inventory, product) {
        // Compare against chain prices if available
        const chainPrice = store_1.store.getCheapestChainPrice(this.normalizeProductName(product.name), product.isOrganic);
        if (chainPrice) {
            // If local is cheaper than chain, score = 1.0 (perfect)
            // If local is same price, score = 0.7
            // If local is more expensive, score decreases
            const ratio = inventory.pricePerUnit / chainPrice.pricePerUnit;
            if (ratio <= 0.8)
                return 1.0; // 20%+ cheaper
            if (ratio <= 1.0)
                return 0.8; // cheaper or same
            if (ratio <= 1.2)
                return 0.5; // up to 20% more expensive
            return 0.2; // significantly more expensive
        }
        // No chain comparison available — give a neutral score
        return 0.6;
    }
    freshnessScore(inventory) {
        if (!inventory.harvestedAt)
            return 0.5; // unknown freshness
        const hoursSinceHarvest = (Date.now() - new Date(inventory.harvestedAt).getTime()) /
            (1000 * 60 * 60);
        if (hoursSinceHarvest <= 4)
            return 1.0; // ultra fresh
        if (hoursSinceHarvest <= 12)
            return 0.9;
        if (hoursSinceHarvest <= 24)
            return 0.7;
        if (hoursSinceHarvest <= 48)
            return 0.5;
        return 0.3;
    }
    distanceScore(distanceKm, maxDistanceKm) {
        if (distanceKm <= 0.5)
            return 1.0;
        if (distanceKm <= 1)
            return 0.9;
        if (distanceKm >= maxDistanceKm)
            return 0.1;
        // Linear interpolation between 1km and max
        return 1 - (distanceKm - 1) / (maxDistanceKm - 1) * 0.8;
    }
    // ─── Chain Price Comparison ────────────────────────────────
    // The "22% billigere enn Rema" feature
    compareWithChains(productName, localPrice, isOrganic) {
        const normalized = this.normalizeProductName(productName);
        const cheapest = store_1.store.getCheapestChainPrice(normalized, isOrganic);
        if (!cheapest)
            return null;
        const diff = localPrice - cheapest.pricePerUnit;
        const percentDiff = Math.round(((localPrice - cheapest.pricePerUnit) / cheapest.pricePerUnit) * 100);
        const chainDisplay = this.formatChainName(cheapest.chain);
        let label;
        if (percentDiff < -5) {
            label = `${Math.abs(percentDiff)}% billigere enn ${chainDisplay}`;
        }
        else if (percentDiff > 5) {
            label = `${percentDiff}% dyrere enn ${chainDisplay}, men lokalt og ferskt`;
        }
        else {
            label = `Omtrent samme pris som ${chainDisplay}`;
        }
        return {
            cheapestChain: cheapest.chain,
            chainPrice: cheapest.pricePerUnit,
            priceDifference: Math.round(diff * 100) / 100,
            percentDifference: percentDiff,
            comparisonLabel: label,
        };
    }
    // ─── Match Reasons (human-readable) ────────────────────────
    // Consumer agents show these to explain WHY this result ranked high.
    generateMatchReasons(inventory, product, producer, distanceKm) {
        const reasons = [];
        // Distance
        if (distanceKm < 1) {
            reasons.push(`${Math.round(distanceKm * 1000)}m unna`);
        }
        else {
            reasons.push(`${Math.round(distanceKm * 10) / 10}km unna`);
        }
        // Freshness
        if (inventory.harvestedAt) {
            const hours = (Date.now() - new Date(inventory.harvestedAt).getTime()) /
                (1000 * 60 * 60);
            if (hours < 4)
                reasons.push("Plukket for under 4 timer siden");
            else if (hours < 24)
                reasons.push(`Plukket for ${Math.round(hours)} timer siden`);
        }
        // Organic
        if (product.isOrganic)
            reasons.push("Økologisk");
        // Seasonal
        if (product.isSeasonal)
            reasons.push("Sesongvare");
        // Trust
        if (producer.trustScore >= 0.8)
            reasons.push("Høy tillit");
        // Producer type
        if (producer.type === "farm")
            reasons.push("Direkte fra gården");
        if (producer.type === "garden")
            reasons.push("Fra lokal hage");
        return reasons;
    }
    // ─── Utilities ─────────────────────────────────────────────
    calculateDistance(lat1, lng1, lat2, lng2) {
        // Haversine formula
        const R = 6371; // Earth's radius in km
        const dLat = this.toRad(lat2 - lat1);
        const dLng = this.toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(this.toRad(lat1)) *
                Math.cos(this.toRad(lat2)) *
                Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
    toRad(deg) {
        return (deg * Math.PI) / 180;
    }
    normalizeProductName(name) {
        return name
            .toLowerCase()
            .replace(/[æ]/g, "ae")
            .replace(/[ø]/g, "o")
            .replace(/[å]/g, "a")
            .trim();
    }
    formatChainName(chain) {
        const names = {
            "rema-1000": "Rema 1000",
            kiwi: "Kiwi",
            meny: "Meny",
            "coop-extra": "Coop Extra",
            "coop-mega": "Coop Mega",
            oda: "Oda",
            bunnpris: "Bunnpris",
        };
        return names[chain] || chain;
    }
}
exports.MatchingEngine = MatchingEngine;
exports.matchingEngine = new MatchingEngine();
//# sourceMappingURL=matching-engine.js.map
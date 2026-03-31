"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.visionScanner = exports.VisionScannerService = void 0;
const uuid_1 = require("uuid");
const store_1 = require("./store");
const producer_agent_1 = require("./producer-agent");
// ─── Norwegian Produce Knowledge Base ────────────────────────
// This is what makes the scanner smart even without a vision API.
// We know what produce looks like, what varieties exist in Norway,
// and what they typically cost. A vision model uses this as context.
const PRODUCE_KNOWLEDGE = {
    tomater: {
        category: "vegetables",
        varieties: [
            { name: "Cherry", traits: ["small", "round", "red", "cluster"] },
            { name: "San Marzano", traits: ["elongated", "red", "paste"] },
            { name: "Bifftomat", traits: ["large", "round", "red"] },
            { name: "Gule cherry", traits: ["small", "round", "yellow"] },
            { name: "Kumato", traits: ["medium", "dark-green-brown"] },
            { name: "Cocktail", traits: ["medium-small", "round", "cluster"] },
        ],
        defaultUnit: "kg",
        typicalPriceRange: [25, 55],
        seasonMonths: [6, 7, 8, 9, 10],
    },
    poteter: {
        category: "vegetables",
        varieties: [
            { name: "Mandel", traits: ["small", "elongated", "yellow"] },
            { name: "Gulløye", traits: ["round", "yellow-flesh"] },
            { name: "Folva", traits: ["oval", "light-yellow"] },
            { name: "Asterix", traits: ["oval", "red-skin", "yellow-flesh"] },
            { name: "Pimpernel", traits: ["red-skin", "elongated"] },
            { name: "Nypoteter", traits: ["small", "thin-skin", "any-color"] },
        ],
        defaultUnit: "kg",
        typicalPriceRange: [15, 35],
        seasonMonths: [6, 7, 8, 9, 10, 11],
    },
    epler: {
        category: "fruits",
        varieties: [
            { name: "Gravenstein", traits: ["green-red", "aromatic", "classic"] },
            { name: "Summerred", traits: ["red", "sweet", "early"] },
            { name: "Discovery", traits: ["red-green", "tart", "crisp"] },
            { name: "Aroma", traits: ["red", "large", "sweet-tart"] },
            { name: "Rød Prins", traits: ["dark-red", "sweet"] },
        ],
        defaultUnit: "kg",
        typicalPriceRange: [25, 50],
        seasonMonths: [8, 9, 10, 11],
    },
    gulrøtter: {
        category: "vegetables",
        varieties: [
            { name: "Vanlige", traits: ["orange", "long"] },
            { name: "Baby", traits: ["small", "thin", "orange"] },
            { name: "Lilla", traits: ["purple", "long"] },
            { name: "Gule", traits: ["yellow", "long"] },
        ],
        defaultUnit: "kg",
        typicalPriceRange: [18, 35],
        seasonMonths: [7, 8, 9, 10, 11],
    },
    løk: {
        category: "vegetables",
        varieties: [
            { name: "Gul løk", traits: ["yellow-brown", "round"] },
            { name: "Rødløk", traits: ["red-purple", "round"] },
            { name: "Sjalottløk", traits: ["small", "elongated", "golden"] },
            { name: "Vårløk", traits: ["green-white", "long", "thin"] },
        ],
        defaultUnit: "kg",
        typicalPriceRange: [15, 30],
        seasonMonths: [7, 8, 9, 10, 11],
    },
    jordbær: {
        category: "berries",
        varieties: [
            { name: "Korona", traits: ["large", "bright-red", "sweet"] },
            { name: "Polka", traits: ["medium", "dark-red"] },
            { name: "Sonata", traits: ["large", "glossy", "sweet"] },
        ],
        defaultUnit: "box",
        typicalPriceRange: [50, 80],
        seasonMonths: [6, 7, 8],
    },
    agurk: {
        category: "vegetables",
        varieties: [
            { name: "Slangeagurk", traits: ["long", "dark-green"] },
            { name: "Mini-agurk", traits: ["small", "crunchy"] },
        ],
        defaultUnit: "piece",
        typicalPriceRange: [12, 25],
        seasonMonths: [5, 6, 7, 8, 9],
    },
    kål: {
        category: "vegetables",
        varieties: [
            { name: "Hodekål", traits: ["round", "green", "large"] },
            { name: "Rødkål", traits: ["round", "purple"] },
            { name: "Blomkål", traits: ["white", "florets"] },
            { name: "Brokkoli", traits: ["green", "florets"] },
            { name: "Grønnkål", traits: ["dark-green", "curly", "leafy"] },
            { name: "Rosenkål", traits: ["small", "round", "green"] },
        ],
        defaultUnit: "piece",
        typicalPriceRange: [20, 45],
        seasonMonths: [7, 8, 9, 10, 11],
    },
    urter: {
        category: "herbs",
        varieties: [
            { name: "Basilikum", traits: ["green", "aromatic", "large-leaf"] },
            { name: "Persille", traits: ["green", "curly-or-flat"] },
            { name: "Dill", traits: ["green", "feathery"] },
            { name: "Gressløk", traits: ["green", "thin", "tubular"] },
            { name: "Koriander", traits: ["green", "flat-leaf", "pungent"] },
            { name: "Mynte", traits: ["green", "serrated", "aromatic"] },
        ],
        defaultUnit: "bunch",
        typicalPriceRange: [15, 35],
        seasonMonths: [5, 6, 7, 8, 9],
    },
    salat: {
        category: "vegetables",
        varieties: [
            { name: "Isbergsalat", traits: ["round", "crispy", "light-green"] },
            { name: "Romaine", traits: ["elongated", "dark-green"] },
            { name: "Ruccola", traits: ["small", "peppery", "dark-green"] },
            { name: "Feldsalat", traits: ["small", "round-leaf", "mild"] },
        ],
        defaultUnit: "piece",
        typicalPriceRange: [20, 35],
        seasonMonths: [5, 6, 7, 8, 9, 10],
    },
};
// ─── Scanner Service ─────────────────────────────────────────
class VisionScannerService {
    /**
     * Analyze images/video frames and auto-update producer inventory.
     *
     * In production, this sends frames to a vision API with the prompt:
     * "Identify all fresh produce in this image. For each item, determine:
     *  product type, specific variety, estimated quantity, visual quality.
     *  Context: Norwegian local produce market."
     *
     * The knowledge base above is included as context so the model knows
     * Norwegian varieties and can give accurate identifications.
     *
     * For MVP: we accept a description of what's in the image (simulating
     * what a vision model would return), and process it through our pipeline.
     */
    async scanAndUpdate(input) {
        const producer = store_1.store.getProducer(input.producerId);
        if (!producer)
            throw new Error(`Produsent ${input.producerId} ikke funnet`);
        const scanId = (0, uuid_1.v4)();
        const now = new Date().toISOString();
        // Step 1: Detect items (from vision API or structured input)
        let detectedItems;
        if (input.detectedItems && input.detectedItems.length > 0) {
            // Structured input — enrich with knowledge base
            detectedItems = input.detectedItems.map((item) => this.enrichDetectedItem(item));
        }
        else if (input.description) {
            // Text description — parse into detected items
            detectedItems = this.parseDescription(input.description);
        }
        else {
            throw new Error("Enten 'detectedItems' eller 'description' må oppgis. I produksjon erstattes dette med AI vision.");
        }
        // Step 2: Match against existing products or create new ones
        const productsUpdated = [];
        for (const item of detectedItems) {
            const result = await this.upsertProductAndInventory(input.producerId, item);
            productsUpdated.push(result);
        }
        // Step 3: Build summary
        const summary = this.buildSummary(detectedItems, productsUpdated, producer.name);
        return {
            scanId,
            producerId: input.producerId,
            timestamp: now,
            source: input.source || "photo",
            framesAnalyzed: input.frames?.length || 1,
            detectedItems,
            productsUpdated,
            summary,
        };
    }
    /**
     * Enrich a partially detected item with knowledge base data.
     * Fills in category, suggested price, variety details, etc.
     */
    enrichDetectedItem(partial) {
        const name = (partial.productName || "").toLowerCase();
        // Find matching knowledge base entry
        const knowledge = this.findKnowledge(name);
        const category = partial.category || knowledge?.category || "vegetables";
        const priceRange = knowledge?.typicalPriceRange || [20, 40];
        const midPrice = (priceRange[0] + priceRange[1]) / 2;
        // Map any Norwegian units to schema-valid units
        const unitMap = {
            kg: "kg", g: "g", stk: "piece", bunt: "bunch",
            kurv: "box", glass: "piece", "12-pk": "box",
            liter: "liter", pose: "bag", piece: "piece",
            bunch: "bunch", box: "box", bag: "bag",
        };
        const rawUnit = partial.estimatedUnit || knowledge?.defaultUnit || "kg";
        const mappedUnit = unitMap[rawUnit] || "kg";
        return {
            productName: partial.productName || "Ukjent produkt",
            variety: partial.variety || null,
            category: category,
            confidence: partial.confidence ?? 0.85,
            estimatedQuantity: partial.estimatedQuantity ?? 10,
            estimatedUnit: mappedUnit,
            qualityScore: partial.qualityScore ?? 0.8,
            looksOrganic: partial.looksOrganic ?? false,
            suggestedPricePerUnit: partial.suggestedPricePerUnit ?? midPrice,
            suggestedUnit: mappedUnit,
        };
    }
    /**
     * Parse a free-text description into detected items.
     * This simulates what a vision model would return.
     * e.g. "3 kasser cherry-tomater, 20kg mandelpoteter, urter"
     */
    parseDescription(description) {
        const items = [];
        const parts = description.split(/[,;]+/).map((s) => s.trim().toLowerCase());
        for (const part of parts) {
            if (!part)
                continue;
            // Try to extract quantity
            const qtyMatch = part.match(/(\d+)\s*(kg|g|stk|kasser?|bunter?|liter)?/);
            const quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 10;
            // Try to match against knowledge base
            let matched = false;
            for (const [productKey, knowledge] of Object.entries(PRODUCE_KNOWLEDGE)) {
                // Check product name match
                if (part.includes(productKey) || part.includes(productKey.replace("ø", "o"))) {
                    // Check for variety match
                    let detectedVariety = null;
                    for (const variety of knowledge.varieties) {
                        if (part.includes(variety.name.toLowerCase())) {
                            detectedVariety = variety.name;
                            break;
                        }
                    }
                    const midPrice = (knowledge.typicalPriceRange[0] + knowledge.typicalPriceRange[1]) / 2;
                    const pUnitMap = {
                        kg: "kg", g: "g", piece: "piece", bunch: "bunch",
                        liter: "liter", box: "box", bag: "bag",
                        stk: "piece", bunt: "bunch", kurv: "box",
                    };
                    const pUnit = pUnitMap[knowledge.defaultUnit] || "kg";
                    items.push({
                        productName: productKey.charAt(0).toUpperCase() + productKey.slice(1),
                        variety: detectedVariety,
                        category: knowledge.category,
                        confidence: detectedVariety ? 0.92 : 0.85,
                        estimatedQuantity: quantity,
                        estimatedUnit: pUnit,
                        qualityScore: 0.8,
                        looksOrganic: part.includes("øko") || part.includes("organic"),
                        suggestedPricePerUnit: midPrice,
                        suggestedUnit: pUnit,
                    });
                    matched = true;
                    break;
                }
            }
            // If no match, create a generic entry
            if (!matched && part.length > 2) {
                items.push({
                    productName: part.charAt(0).toUpperCase() + part.slice(1),
                    variety: null,
                    category: "other",
                    confidence: 0.5,
                    estimatedQuantity: quantity,
                    estimatedUnit: "kg",
                    qualityScore: 0.7,
                    looksOrganic: false,
                    suggestedPricePerUnit: null,
                    suggestedUnit: "kg",
                });
            }
        }
        return items;
    }
    /**
     * Create or update a product + inventory entry from a detected item.
     */
    async upsertProductAndInventory(producerId, item) {
        // Check if this product+variety already exists for this producer
        const existingProducts = store_1.store.getProductsByProducer(producerId);
        const displayName = item.variety
            ? `${item.productName} (${item.variety})`
            : item.productName;
        let existingProduct = existingProducts.find((p) => {
            const nameMatch = p.name.toLowerCase() === displayName.toLowerCase();
            const parentMatch = p.parentProduct?.toLowerCase() === item.productName.toLowerCase() &&
                p.variety?.toLowerCase() === item.variety?.toLowerCase();
            return nameMatch || parentMatch;
        });
        let action;
        let productId;
        if (existingProduct) {
            // Product exists — update it
            action = "updated";
            productId = existingProduct.id;
        }
        else {
            // New product — create it
            const newProduct = producer_agent_1.producerAgent.addProduct({
                producerId,
                name: displayName,
                category: item.category,
                unit: item.estimatedUnit,
                isOrganic: item.looksOrganic,
                isSeasonal: true,
                description: item.variety
                    ? `${item.variety} ${item.productName.toLowerCase()}, identifisert fra videoskanning`
                    : `${item.productName}, identifisert fra videoskanning`,
            });
            // Set variety fields directly on the stored product
            store_1.store.addProduct({
                ...newProduct,
                variety: item.variety || undefined,
                parentProduct: item.productName.toLowerCase(),
                detectedFromScan: true,
                scanConfidence: item.confidence,
            });
            action = "created";
            productId = newProduct.id;
        }
        // Update inventory with detected quantity
        let inventoryEntryId = null;
        if (item.suggestedPricePerUnit) {
            const entry = producer_agent_1.producerAgent.updateInventory({
                productId,
                producerId,
                quantityAvailable: item.estimatedQuantity,
                pricePerUnit: item.suggestedPricePerUnit,
                harvestedAt: new Date().toISOString(),
                availableUntilHours: 12, // default: available for 12 hours
            });
            inventoryEntryId = entry.id;
        }
        return {
            action,
            productId,
            productName: displayName,
            variety: item.variety,
            inventoryEntryId,
            pricePerUnit: item.suggestedPricePerUnit,
            quantityAvailable: item.estimatedQuantity,
        };
    }
    /**
     * Find knowledge base entry for a product name.
     */
    findKnowledge(name) {
        const normalized = name.toLowerCase().trim();
        for (const [key, knowledge] of Object.entries(PRODUCE_KNOWLEDGE)) {
            if (normalized.includes(key) || key.includes(normalized)) {
                return knowledge;
            }
        }
        return null;
    }
    /**
     * Build a human-readable summary in Norwegian.
     */
    buildSummary(items, updates, producerName) {
        const created = updates.filter((u) => u.action === "created").length;
        const updated = updates.filter((u) => u.action === "updated").length;
        const itemList = items
            .map((i) => {
            const variety = i.variety ? ` (${i.variety})` : "";
            const organic = i.looksOrganic ? ", økologisk" : "";
            const price = i.suggestedPricePerUnit
                ? `, ~${i.suggestedPricePerUnit} kr/${i.suggestedUnit}`
                : "";
            return `  • ${i.productName}${variety}: ~${i.estimatedQuantity} ${i.estimatedUnit}${organic}${price}`;
        })
            .join("\n");
        return (`📸 Skanning fullført for ${producerName}!\n\n` +
            `Fant ${items.length} produkt${items.length !== 1 ? "er" : ""}:\n${itemList}\n\n` +
            `${created > 0 ? `${created} nye produkter opprettet. ` : ""}` +
            `${updated > 0 ? `${updated} produkter oppdatert. ` : ""}` +
            `\nInventaret ditt er nå oppdatert. Konsument-agenter kan finne disse produktene umiddelbart.`);
    }
    /**
     * Quick price update — producer photographs a price tag or sends a message.
     * Simpler than full scan: just updates prices for existing products.
     * e.g. "Tomater (Cherry) nå 28kr/kg" or from a photo of a price sign.
     */
    async quickPriceUpdate(producerId, updates) {
        const products = store_1.store.getProductsByProducer(producerId);
        const updatedNames = [];
        const notFound = [];
        for (const update of updates) {
            const match = products.find((p) => p.name.toLowerCase() === update.productName.toLowerCase());
            if (match) {
                producer_agent_1.producerAgent.updateInventory({
                    productId: match.id,
                    producerId,
                    quantityAvailable: update.newQuantity ?? 10,
                    pricePerUnit: update.newPrice,
                    harvestedAt: new Date().toISOString(),
                    availableUntilHours: 12,
                });
                updatedNames.push(`${match.name}: ${update.newPrice} kr`);
            }
            else {
                notFound.push(update.productName);
            }
        }
        return { updated: updatedNames, notFound };
    }
    /**
     * Get available varieties for a product (for the producer UI).
     */
    getKnownVarieties(productName) {
        const knowledge = this.findKnowledge(productName);
        if (!knowledge)
            return [];
        return knowledge.varieties.map((v) => v.name);
    }
    /**
     * Get all known products in the knowledge base.
     */
    getKnownProducts() {
        return Object.keys(PRODUCE_KNOWLEDGE).map((k) => k.charAt(0).toUpperCase() + k.slice(1));
    }
}
exports.VisionScannerService = VisionScannerService;
exports.visionScanner = new VisionScannerService();
//# sourceMappingURL=vision-scanner.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.producerAgent = exports.ProducerAgentService = void 0;
const uuid_1 = require("uuid");
const store_1 = require("./store");
const models_1 = require("../models");
// ─── Producer Agent Service ────────────────────────────────────
// This is the "brain" of the producer side. In production, this
// would be exposed as a simple chat interface (WhatsApp/SMS).
//
// A producer should be able to:
// 1. Register their shop/farm in under 5 minutes
// 2. Update what they have today ("40kg tomater, 35kr/kg")
// 3. See incoming requests from consumer agents
// 4. Confirm/reject orders
//
// Philosophy: dead simple. If a farmer can't use this while
// standing in a field, it's too complex.
class ProducerAgentService {
    /**
     * Register a new producer.
     * In the real product, this would come from a chat message like:
     * "Hei, jeg er Kari fra Aker Gård. Vi selger grønnsaker i Oslo."
     */
    register(input) {
        const now = new Date().toISOString();
        const producer = models_1.ProducerSchema.parse({
            id: (0, uuid_1.v4)(),
            name: input.name,
            description: input.description || "",
            type: input.type,
            location: input.location,
            openingHours: input.openingHours || [],
            contactPhone: input.contactPhone,
            contactEmail: input.contactEmail,
            tags: input.tags || [],
            certifications: input.certifications || [],
            deliveryOptions: input.deliveryOptions || ["pickup"],
            maxDeliveryRadiusKm: input.maxDeliveryRadiusKm,
            trustScore: 0.5, // everyone starts neutral
            totalTransactions: 0,
            availabilityAccuracy: 0.5,
            registeredAt: now,
            lastActiveAt: now,
            isActive: true,
        });
        return store_1.store.addProducer(producer);
    }
    /**
     * Add a product to the producer's catalog.
     * Chat equivalent: "Vi selger tomater, agurk, og urter"
     */
    addProduct(input) {
        const producer = store_1.store.getProducer(input.producerId);
        if (!producer)
            throw new Error(`Producer ${input.producerId} not found`);
        const product = models_1.ProductSchema.parse({
            id: (0, uuid_1.v4)(),
            producerId: input.producerId,
            name: input.name,
            category: input.category,
            description: input.description,
            unit: input.unit,
            isOrganic: input.isOrganic ?? false,
            isSeasonal: input.isSeasonal ?? true,
            isLocallyGrown: true,
            growingMethod: input.growingMethod,
        });
        return store_1.store.addProduct(product);
    }
    /**
     * Update live inventory — this is the heartbeat of the supply graph.
     * Chat equivalent: "I dag har vi 40kg tomater, 35kr/kg, plukket i morges"
     *
     * This is the most important function in the entire system.
     * Without live inventory, we have no supply graph. No supply graph = no moat.
     */
    updateInventory(input) {
        const product = store_1.store.getProduct(input.productId);
        if (!product)
            throw new Error(`Product ${input.productId} not found`);
        const now = new Date();
        const availableUntil = new Date(now.getTime() + (input.availableUntilHours || 8) * 60 * 60 * 1000);
        const entry = models_1.InventoryEntrySchema.parse({
            id: (0, uuid_1.v4)(),
            productId: input.productId,
            producerId: input.producerId,
            quantityAvailable: input.quantityAvailable,
            unit: product.unit,
            pricePerUnit: input.pricePerUnit,
            currency: "NOK",
            harvestedAt: input.harvestedAt || now.toISOString(),
            availableFrom: now.toISOString(),
            availableUntil: availableUntil.toISOString(),
            status: input.quantityAvailable > 5
                ? "available"
                : input.quantityAvailable > 0
                    ? "low-stock"
                    : "sold-out",
            updatedAt: now.toISOString(),
        });
        // Mark producer as active
        store_1.store.updateProducer(input.producerId, {
            lastActiveAt: now.toISOString(),
        });
        return store_1.store.updateInventory(entry);
    }
    /**
     * Get everything a producer currently has available.
     * Used by the business dashboard: "Here's your inventory today."
     */
    getMyInventory(producerId) {
        return {
            producer: store_1.store.getProducer(producerId),
            products: store_1.store.getProductsByProducer(producerId),
            inventory: store_1.store.getInventoryByProducer(producerId),
        };
    }
    /**
     * Quick inventory update — for the farmer in the field.
     * "Tomatene er utsolgt" → marks all tomato inventory as sold-out.
     */
    markSoldOut(productId, producerId) {
        const inventory = store_1.store.getInventoryByProducer(producerId);
        for (const entry of inventory) {
            if (entry.productId === productId) {
                store_1.store.updateInventory({
                    ...entry,
                    status: "sold-out",
                    quantityAvailable: 0,
                    updatedAt: new Date().toISOString(),
                });
            }
        }
    }
}
exports.ProducerAgentService = ProducerAgentService;
exports.producerAgent = new ProducerAgentService();
//# sourceMappingURL=producer-agent.js.map
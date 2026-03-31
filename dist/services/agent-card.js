"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentCardService = exports.AgentCardService = void 0;
const store_1 = require("./store");
class AgentCardService {
    /**
     * Generate an A2A-compatible Agent Card for a producer.
     * Consumer agents read this to decide: "Should I ask this producer?"
     */
    generateCard(producerId, baseUrl) {
        const producer = store_1.store.getProducer(producerId);
        if (!producer)
            return null;
        const products = store_1.store.getProductsByProducer(producerId);
        const inventory = store_1.store.getInventoryByProducer(producerId);
        const categories = [...new Set(products.map((p) => p.category))];
        return {
            name: producer.name,
            description: this.generateDescription(producer, products.length),
            url: `${baseUrl}/agents/${producerId}`,
            version: "1.0.0",
            capabilities: {
                streaming: false, // MVP: no streaming, simple request/response
                pushNotifications: false,
                stateTransitionHistory: true,
            },
            skills: this.generateSkills(producer, categories),
            "x-lokal": {
                type: "producer",
                producerId: producer.id,
                producerType: producer.type,
                location: {
                    lat: producer.location.lat,
                    lng: producer.location.lng,
                    city: producer.location.city,
                    district: producer.location.district,
                },
                categories,
                tags: producer.tags,
                certifications: producer.certifications,
                deliveryOptions: producer.deliveryOptions,
                trustScore: producer.trustScore,
                isOpen: this.isCurrentlyOpen(producer),
                currentProductCount: inventory.length,
                priceLevel: this.estimatePriceLevel(inventory),
            },
        };
    }
    /**
     * Generate cards for ALL active producers — the "registry".
     * Consumer agents query this to discover who's available.
     */
    generateRegistry(baseUrl) {
        const producers = store_1.store.getAllProducers();
        return producers
            .map((p) => this.generateCard(p.id, baseUrl))
            .filter((card) => card !== null);
    }
    generateDescription(producer, productCount) {
        const typeLabel = {
            farm: "Gård",
            shop: "Butikk",
            market: "Marked",
            cooperative: "Andelslag",
            garden: "Hage",
        }[producer.type];
        const tagStr = producer.tags.length > 0 ? ` — ${producer.tags.join(", ")}` : "";
        return `${typeLabel} i ${producer.location.district || producer.location.city} med ${productCount} produkter${tagStr}`;
    }
    generateSkills(producer, categories) {
        const skills = [
            {
                id: "inventory-check",
                name: "Sjekk tilgjengelighet",
                description: "Spør hva som er tilgjengelig akkurat nå",
                inputModes: ["text/plain", "application/json"],
                outputModes: ["application/json"],
            },
            {
                id: "price-inquiry",
                name: "Prisforespørsel",
                description: "Få priser for produkter",
                inputModes: ["text/plain", "application/json"],
                outputModes: ["application/json"],
            },
        ];
        if (producer.deliveryOptions.includes("pickup")) {
            skills.push({
                id: "reserve-pickup",
                name: "Reserver for henting",
                description: "Reserver produkter for henting i butikk/gård",
                inputModes: ["application/json"],
                outputModes: ["application/json"],
            });
        }
        if (producer.deliveryOptions.includes("local-delivery")) {
            skills.push({
                id: "order-delivery",
                name: "Bestill med levering",
                description: "Bestill produkter med lokal levering",
                inputModes: ["application/json"],
                outputModes: ["application/json"],
            });
        }
        return skills;
    }
    isCurrentlyOpen(producer) {
        if (producer.openingHours.length === 0)
            return true; // assume always open
        const now = new Date();
        const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        const today = days[now.getDay()];
        const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const todayHours = producer.openingHours.find((h) => h.day === today);
        if (!todayHours)
            return false;
        return currentTime >= todayHours.open && currentTime <= todayHours.close;
    }
    estimatePriceLevel(inventory) {
        if (inventory.length === 0)
            return "moderate";
        const avg = inventory.reduce((sum, i) => sum + i.pricePerUnit, 0) / inventory.length;
        if (avg < 30)
            return "budget";
        if (avg < 60)
            return "moderate";
        return "premium";
    }
}
exports.AgentCardService = AgentCardService;
exports.agentCardService = new AgentCardService();
//# sourceMappingURL=agent-card.js.map
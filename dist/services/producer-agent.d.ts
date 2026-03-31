import { Producer, Product, InventoryEntry } from "../models";
export declare class ProducerAgentService {
    /**
     * Register a new producer.
     * In the real product, this would come from a chat message like:
     * "Hei, jeg er Kari fra Aker Gård. Vi selger grønnsaker i Oslo."
     */
    register(input: {
        name: string;
        type: Producer["type"];
        location: Producer["location"];
        tags?: string[];
        certifications?: string[];
        deliveryOptions?: Producer["deliveryOptions"];
        maxDeliveryRadiusKm?: number;
        openingHours?: Producer["openingHours"];
        contactPhone?: string;
        contactEmail?: string;
        description?: string;
    }): Producer;
    /**
     * Add a product to the producer's catalog.
     * Chat equivalent: "Vi selger tomater, agurk, og urter"
     */
    addProduct(input: {
        producerId: string;
        name: string;
        category: Product["category"];
        unit: Product["unit"];
        isOrganic?: boolean;
        isSeasonal?: boolean;
        description?: string;
        growingMethod?: string;
    }): Product;
    /**
     * Update live inventory — this is the heartbeat of the supply graph.
     * Chat equivalent: "I dag har vi 40kg tomater, 35kr/kg, plukket i morges"
     *
     * This is the most important function in the entire system.
     * Without live inventory, we have no supply graph. No supply graph = no moat.
     */
    updateInventory(input: {
        productId: string;
        producerId: string;
        quantityAvailable: number;
        pricePerUnit: number;
        harvestedAt?: string;
        availableUntilHours?: number;
    }): InventoryEntry;
    /**
     * Get everything a producer currently has available.
     * Used by the business dashboard: "Here's your inventory today."
     */
    getMyInventory(producerId: string): {
        producer: Producer | undefined;
        products: Product[];
        inventory: InventoryEntry[];
    };
    /**
     * Quick inventory update — for the farmer in the field.
     * "Tomatene er utsolgt" → marks all tomato inventory as sold-out.
     */
    markSoldOut(productId: string, producerId: string): void;
}
export declare const producerAgent: ProducerAgentService;
//# sourceMappingURL=producer-agent.d.ts.map
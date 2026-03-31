import { v4 as uuid } from "uuid";
import { store } from "./store";
import {
  Producer,
  ProducerSchema,
  Product,
  ProductSchema,
  InventoryEntry,
  InventoryEntrySchema,
} from "../models";

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

export class ProducerAgentService {
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
  }): Producer {
    const now = new Date().toISOString();

    const producer = ProducerSchema.parse({
      id: uuid(),
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

    return store.addProducer(producer);
  }

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
  }): Product {
    const producer = store.getProducer(input.producerId);
    if (!producer) throw new Error(`Producer ${input.producerId} not found`);

    const product = ProductSchema.parse({
      id: uuid(),
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

    return store.addProduct(product);
  }

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
    availableUntilHours?: number; // hours from now
  }): InventoryEntry {
    const product = store.getProduct(input.productId);
    if (!product) throw new Error(`Product ${input.productId} not found`);

    const now = new Date();
    const availableUntil = new Date(
      now.getTime() + (input.availableUntilHours || 8) * 60 * 60 * 1000
    );

    const entry = InventoryEntrySchema.parse({
      id: uuid(),
      productId: input.productId,
      producerId: input.producerId,
      quantityAvailable: input.quantityAvailable,
      unit: product.unit,
      pricePerUnit: input.pricePerUnit,
      currency: "NOK",
      harvestedAt: input.harvestedAt || now.toISOString(),
      availableFrom: now.toISOString(),
      availableUntil: availableUntil.toISOString(),
      status:
        input.quantityAvailable > 5
          ? "available"
          : input.quantityAvailable > 0
          ? "low-stock"
          : "sold-out",
      updatedAt: now.toISOString(),
    });

    // Mark producer as active
    store.updateProducer(input.producerId, {
      lastActiveAt: now.toISOString(),
    });

    return store.updateInventory(entry);
  }

  /**
   * Get everything a producer currently has available.
   * Used by the business dashboard: "Here's your inventory today."
   */
  getMyInventory(producerId: string): {
    producer: Producer | undefined;
    products: Product[];
    inventory: InventoryEntry[];
  } {
    return {
      producer: store.getProducer(producerId),
      products: store.getProductsByProducer(producerId),
      inventory: store.getInventoryByProducer(producerId),
    };
  }

  /**
   * Quick inventory update — for the farmer in the field.
   * "Tomatene er utsolgt" → marks all tomato inventory as sold-out.
   */
  markSoldOut(productId: string, producerId: string): void {
    const inventory = store.getInventoryByProducer(producerId);
    for (const entry of inventory) {
      if (entry.productId === productId) {
        store.updateInventory({
          ...entry,
          status: "sold-out",
          quantityAvailable: 0,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
}

export const producerAgent = new ProducerAgentService();

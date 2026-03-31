import { store } from "./store";
import { Producer } from "../models";

// ─── A2A Agent Card Generator ──────────────────────────────────
// Each producer gets an Agent Card (per the A2A protocol spec).
// This is how consumer agents DISCOVER producers.
//
// Standard A2A Agent Cards live at /.well-known/agent.json
// We extend them with Lokal-specific fields for food commerce.

export interface AgentCard {
  // Standard A2A fields
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: AgentSkill[];

  // Lokal extensions
  "x-lokal": {
    type: "producer";
    producerId: string;
    producerType: string;
    location: {
      lat: number;
      lng: number;
      city: string;
      district?: string;
    };
    categories: string[];
    tags: string[];
    certifications: string[];
    deliveryOptions: string[];
    trustScore: number;
    isOpen: boolean;
    currentProductCount: number;
    priceLevel: "budget" | "moderate" | "premium";
  };
}

interface AgentSkill {
  id: string;
  name: string;
  description: string;
  inputModes: string[];
  outputModes: string[];
}

export class AgentCardService {
  /**
   * Generate an A2A-compatible Agent Card for a producer.
   * Consumer agents read this to decide: "Should I ask this producer?"
   */
  generateCard(producerId: string, baseUrl: string): AgentCard | null {
    const producer = store.getProducer(producerId);
    if (!producer) return null;

    const products = store.getProductsByProducer(producerId);
    const inventory = store.getInventoryByProducer(producerId);
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
  generateRegistry(baseUrl: string): AgentCard[] {
    const producers = store.getAllProducers();
    return producers
      .map((p) => this.generateCard(p.id, baseUrl))
      .filter((card): card is AgentCard => card !== null);
  }

  private generateDescription(producer: Producer, productCount: number): string {
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

  private generateSkills(
    producer: Producer,
    categories: string[]
  ): AgentSkill[] {
    const skills: AgentSkill[] = [
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

  private isCurrentlyOpen(producer: Producer): boolean {
    if (producer.openingHours.length === 0) return true; // assume always open

    const now = new Date();
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const today = days[now.getDay()];
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const todayHours = producer.openingHours.find((h) => h.day === today);
    if (!todayHours) return false;

    return currentTime >= todayHours.open && currentTime <= todayHours.close;
  }

  private estimatePriceLevel(
    inventory: { pricePerUnit: number }[]
  ): "budget" | "moderate" | "premium" {
    if (inventory.length === 0) return "moderate";
    const avg =
      inventory.reduce((sum, i) => sum + i.pricePerUnit, 0) / inventory.length;
    if (avg < 30) return "budget";
    if (avg < 60) return "moderate";
    return "premium";
  }
}

export const agentCardService = new AgentCardService();

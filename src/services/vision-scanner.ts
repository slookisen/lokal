import { v4 as uuid } from "uuid";
import { store } from "./store";
import { producerAgent } from "./producer-agent";
import { Product, InventoryEntry, ProductCategory } from "../models";

// ─── Vision Scanner Service ────────────────────────────────────
// This is the "film your products" feature.
//
// HOW IT WORKS:
// 1. Producer takes a video or photos of their products
// 2. Video is split into frames (or photos sent directly)
// 3. Each frame is analyzed by a vision AI model
// 4. The model identifies: product type, variety, estimated quantity,
//    visual quality, and whether it looks organic/fresh
// 5. Results are matched against existing products or create new ones
// 6. Inventory is auto-updated with the detected items
//
// WHY THIS MATTERS:
// A farmer standing in a field can film their crates, and in 30 seconds
// their entire inventory is updated. No typing, no forms, no app.
// This is the difference between "easy to use" and "I'll actually use this."
//
// IN PRODUCTION: This calls Claude Vision / GPT-4V / Gemini Vision.
// FOR MVP: We use a knowledge-based detector that recognizes common
// Norwegian produce from image metadata + a smart mock for demos.

// ─── Types ───────────────────────────────────────────────────

export interface ScanResult {
  /** Unique ID for this scan session */
  scanId: string;
  producerId: string;
  timestamp: string;
  /** How the scan was initiated */
  source: "video" | "photo" | "multi-photo";
  /** Number of frames/images analyzed */
  framesAnalyzed: number;
  /** What we found */
  detectedItems: DetectedItem[];
  /** Products created or updated from this scan */
  productsUpdated: ProductUpdate[];
  /** Human-readable summary for the producer */
  summary: string;
}

export interface DetectedItem {
  /** What we think this is */
  productName: string;
  /** Specific variety if identifiable */
  variety: string | null;
  /** Parent category */
  category: ProductCategory;
  /** Confidence 0–1 that we identified it correctly */
  confidence: number;
  /** Estimated quantity (from visual analysis) */
  estimatedQuantity: number;
  estimatedUnit: string;
  /** Visual quality assessment */
  qualityScore: number; // 0–1, how fresh/good it looks
  /** Does it look organic? (no plastic packaging, natural appearance) */
  looksOrganic: boolean;
  /** Suggested price based on market data */
  suggestedPricePerUnit: number | null;
  /** Suggested unit for pricing */
  suggestedUnit: string;
}

export interface ProductUpdate {
  action: "created" | "updated" | "confirmed";
  productId: string;
  productName: string;
  variety: string | null;
  inventoryEntryId: string | null;
  pricePerUnit: number | null;
  quantityAvailable: number;
}

// ─── Norwegian Produce Knowledge Base ────────────────────────
// This is what makes the scanner smart even without a vision API.
// We know what produce looks like, what varieties exist in Norway,
// and what they typically cost. A vision model uses this as context.

const PRODUCE_KNOWLEDGE: Record<
  string,
  {
    category: ProductCategory;
    varieties: { name: string; traits: string[] }[];
    defaultUnit: string;
    typicalPriceRange: [number, number]; // NOK per unit
    seasonMonths: number[]; // 1-12
  }
> = {
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

export class VisionScannerService {
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
  async scanAndUpdate(input: {
    producerId: string;
    /** In production: base64 frames. For MVP: text description of what's visible */
    frames?: string[];
    /** MVP helper: describe what's in the video/photo */
    description?: string;
    /** MVP helper: structured list of what was detected */
    detectedItems?: Partial<DetectedItem>[];
    source?: "video" | "photo" | "multi-photo";
  }): Promise<ScanResult> {
    const producer = store.getProducer(input.producerId);
    if (!producer) throw new Error(`Produsent ${input.producerId} ikke funnet`);

    const scanId = uuid();
    const now = new Date().toISOString();

    // Step 1: Detect items (from vision API or structured input)
    let detectedItems: DetectedItem[];

    if (input.detectedItems && input.detectedItems.length > 0) {
      // Structured input — enrich with knowledge base
      detectedItems = input.detectedItems.map((item) =>
        this.enrichDetectedItem(item)
      );
    } else if (input.description) {
      // Text description — parse into detected items
      detectedItems = this.parseDescription(input.description);
    } else {
      throw new Error(
        "Enten 'detectedItems' eller 'description' må oppgis. I produksjon erstattes dette med AI vision."
      );
    }

    // Step 2: Match against existing products or create new ones
    const productsUpdated: ProductUpdate[] = [];

    for (const item of detectedItems) {
      const result = await this.upsertProductAndInventory(
        input.producerId,
        item
      );
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
  private enrichDetectedItem(partial: Partial<DetectedItem>): DetectedItem {
    const name = (partial.productName || "").toLowerCase();

    // Find matching knowledge base entry
    const knowledge = this.findKnowledge(name);

    const category = partial.category || knowledge?.category || "vegetables";
    const priceRange = knowledge?.typicalPriceRange || [20, 40];
    const midPrice = (priceRange[0] + priceRange[1]) / 2;

    // Map any Norwegian units to schema-valid units
    const unitMap: Record<string, string> = {
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
      category: category as ProductCategory,
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
  private parseDescription(description: string): DetectedItem[] {
    const items: DetectedItem[] = [];
    const parts = description.split(/[,;]+/).map((s) => s.trim().toLowerCase());

    for (const part of parts) {
      if (!part) continue;

      // Try to extract quantity
      const qtyMatch = part.match(/(\d+)\s*(kg|g|stk|kasser?|bunter?|liter)?/);
      const quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 10;

      // Try to match against knowledge base
      let matched = false;
      for (const [productKey, knowledge] of Object.entries(PRODUCE_KNOWLEDGE)) {
        // Check product name match
        if (part.includes(productKey) || part.includes(productKey.replace("ø", "o"))) {
          // Check for variety match
          let detectedVariety: string | null = null;
          for (const variety of knowledge.varieties) {
            if (part.includes(variety.name.toLowerCase())) {
              detectedVariety = variety.name;
              break;
            }
          }

          const midPrice =
            (knowledge.typicalPriceRange[0] + knowledge.typicalPriceRange[1]) / 2;

          const pUnitMap: Record<string, string> = {
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
  private async upsertProductAndInventory(
    producerId: string,
    item: DetectedItem
  ): Promise<ProductUpdate> {
    // Check if this product+variety already exists for this producer
    const existingProducts = store.getProductsByProducer(producerId);
    const displayName = item.variety
      ? `${item.productName} (${item.variety})`
      : item.productName;

    let existingProduct = existingProducts.find((p) => {
      const nameMatch = p.name.toLowerCase() === displayName.toLowerCase();
      const parentMatch =
        p.parentProduct?.toLowerCase() === item.productName.toLowerCase() &&
        p.variety?.toLowerCase() === item.variety?.toLowerCase();
      return nameMatch || parentMatch;
    });

    let action: ProductUpdate["action"];
    let productId: string;

    if (existingProduct) {
      // Product exists — update it
      action = "updated";
      productId = existingProduct.id;
    } else {
      // New product — create it
      const newProduct = producerAgent.addProduct({
        producerId,
        name: displayName,
        category: item.category,
        unit: item.estimatedUnit as any,
        isOrganic: item.looksOrganic,
        isSeasonal: true,
        description: item.variety
          ? `${item.variety} ${item.productName.toLowerCase()}, identifisert fra videoskanning`
          : `${item.productName}, identifisert fra videoskanning`,
      });

      // Set variety fields directly on the stored product
      store.addProduct({
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
    let inventoryEntryId: string | null = null;
    if (item.suggestedPricePerUnit) {
      const entry = producerAgent.updateInventory({
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
  private findKnowledge(name: string) {
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
  private buildSummary(
    items: DetectedItem[],
    updates: ProductUpdate[],
    producerName: string
  ): string {
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

    return (
      `📸 Skanning fullført for ${producerName}!\n\n` +
      `Fant ${items.length} produkt${items.length !== 1 ? "er" : ""}:\n${itemList}\n\n` +
      `${created > 0 ? `${created} nye produkter opprettet. ` : ""}` +
      `${updated > 0 ? `${updated} produkter oppdatert. ` : ""}` +
      `\nInventaret ditt er nå oppdatert. Konsument-agenter kan finne disse produktene umiddelbart.`
    );
  }

  /**
   * Quick price update — producer photographs a price tag or sends a message.
   * Simpler than full scan: just updates prices for existing products.
   * e.g. "Tomater (Cherry) nå 28kr/kg" or from a photo of a price sign.
   */
  async quickPriceUpdate(
    producerId: string,
    updates: { productName: string; newPrice: number; newQuantity?: number }[]
  ): Promise<{ updated: string[]; notFound: string[] }> {
    const products = store.getProductsByProducer(producerId);
    const updatedNames: string[] = [];
    const notFound: string[] = [];

    for (const update of updates) {
      const match = products.find(
        (p) => p.name.toLowerCase() === update.productName.toLowerCase()
      );

      if (match) {
        producerAgent.updateInventory({
          productId: match.id,
          producerId,
          quantityAvailable: update.newQuantity ?? 10,
          pricePerUnit: update.newPrice,
          harvestedAt: new Date().toISOString(),
          availableUntilHours: 12,
        });
        updatedNames.push(`${match.name}: ${update.newPrice} kr`);
      } else {
        notFound.push(update.productName);
      }
    }

    return { updated: updatedNames, notFound };
  }

  /**
   * Get available varieties for a product (for the producer UI).
   */
  getKnownVarieties(productName: string): string[] {
    const knowledge = this.findKnowledge(productName);
    if (!knowledge) return [];
    return knowledge.varieties.map((v) => v.name);
  }

  /**
   * Get all known products in the knowledge base.
   */
  getKnownProducts(): string[] {
    return Object.keys(PRODUCE_KNOWLEDGE).map(
      (k) => k.charAt(0).toUpperCase() + k.slice(1)
    );
  }
}

export const visionScanner = new VisionScannerService();

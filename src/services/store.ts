import {
  Producer,
  Product,
  InventoryEntry,
  ChainPrice,
} from "../models";

// ─── In-Memory Store ───────────────────────────────────────────
// MVP uses in-memory storage. Replace with PostgreSQL when we
// have real producers. The interface stays the same.
//
// Why in-memory first: We need to prove the matching engine and
// agent flow work before investing in infrastructure. A database
// adds zero value until we have real data.

class Store {
  private producers: Map<string, Producer> = new Map();
  private products: Map<string, Product> = new Map();
  private inventory: Map<string, InventoryEntry> = new Map();
  private chainPrices: Map<string, ChainPrice[]> = new Map(); // keyed by normalized product name

  // ─── Producers ─────────────────────────────────────────────

  addProducer(producer: Producer): Producer {
    this.producers.set(producer.id, producer);
    return producer;
  }

  getProducer(id: string): Producer | undefined {
    return this.producers.get(id);
  }

  getAllProducers(): Producer[] {
    return Array.from(this.producers.values()).filter((p) => p.isActive);
  }

  updateProducer(id: string, updates: Partial<Producer>): Producer | undefined {
    const existing = this.producers.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates, lastActiveAt: new Date().toISOString() };
    this.producers.set(id, updated);
    return updated;
  }

  // ─── Products ──────────────────────────────────────────────

  addProduct(product: Product): Product {
    this.products.set(product.id, product);
    return product;
  }

  getProduct(id: string): Product | undefined {
    return this.products.get(id);
  }

  getProductsByProducer(producerId: string): Product[] {
    return Array.from(this.products.values()).filter(
      (p) => p.producerId === producerId
    );
  }

  // ─── Inventory (the LIVE part) ─────────────────────────────

  updateInventory(entry: InventoryEntry): InventoryEntry {
    this.inventory.set(entry.id, entry);
    return entry;
  }

  getInventoryByProducer(producerId: string): InventoryEntry[] {
    return Array.from(this.inventory.values()).filter(
      (i) => i.producerId === producerId && i.status !== "sold-out"
    );
  }

  getAvailableInventory(): InventoryEntry[] {
    const now = new Date().toISOString();
    return Array.from(this.inventory.values()).filter(
      (i) =>
        i.status === "available" &&
        i.availableUntil > now &&
        i.quantityAvailable > 0
    );
  }

  getInventoryForProduct(productId: string): InventoryEntry[] {
    return Array.from(this.inventory.values()).filter(
      (i) => i.productId === productId && i.status === "available"
    );
  }

  // ─── Chain Prices (for comparison) ─────────────────────────

  setChainPrice(normalizedName: string, price: ChainPrice): void {
    const existing = this.chainPrices.get(normalizedName) || [];
    // Replace if same chain, otherwise add
    const filtered = existing.filter((p) => p.chain !== price.chain);
    filtered.push(price);
    this.chainPrices.set(normalizedName, filtered);
  }

  getChainPrices(normalizedName: string): ChainPrice[] {
    return this.chainPrices.get(normalizedName) || [];
  }

  getCheapestChainPrice(
    normalizedName: string,
    isOrganic: boolean = false
  ): ChainPrice | undefined {
    const prices = this.getChainPrices(normalizedName).filter(
      (p) => p.isOrganic === isOrganic
    );
    if (prices.length === 0) return undefined;
    return prices.reduce((min, p) =>
      p.pricePerUnit < min.pricePerUnit ? p : min
    );
  }

  // ─── Stats ─────────────────────────────────────────────────

  getStats() {
    return {
      producers: this.producers.size,
      products: this.products.size,
      inventoryEntries: this.inventory.size,
      chainPriceProducts: this.chainPrices.size,
      activeProducers: this.getAllProducers().length,
      availableItems: this.getAvailableInventory().length,
    };
  }
}

// Singleton — one store for the whole app
export const store = new Store();

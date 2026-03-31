"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.store = void 0;
// ─── In-Memory Store ───────────────────────────────────────────
// MVP uses in-memory storage. Replace with PostgreSQL when we
// have real producers. The interface stays the same.
//
// Why in-memory first: We need to prove the matching engine and
// agent flow work before investing in infrastructure. A database
// adds zero value until we have real data.
class Store {
    producers = new Map();
    products = new Map();
    inventory = new Map();
    chainPrices = new Map(); // keyed by normalized product name
    // ─── Producers ─────────────────────────────────────────────
    addProducer(producer) {
        this.producers.set(producer.id, producer);
        return producer;
    }
    getProducer(id) {
        return this.producers.get(id);
    }
    getAllProducers() {
        return Array.from(this.producers.values()).filter((p) => p.isActive);
    }
    updateProducer(id, updates) {
        const existing = this.producers.get(id);
        if (!existing)
            return undefined;
        const updated = { ...existing, ...updates, lastActiveAt: new Date().toISOString() };
        this.producers.set(id, updated);
        return updated;
    }
    // ─── Products ──────────────────────────────────────────────
    addProduct(product) {
        this.products.set(product.id, product);
        return product;
    }
    getProduct(id) {
        return this.products.get(id);
    }
    getProductsByProducer(producerId) {
        return Array.from(this.products.values()).filter((p) => p.producerId === producerId);
    }
    // ─── Inventory (the LIVE part) ─────────────────────────────
    updateInventory(entry) {
        this.inventory.set(entry.id, entry);
        return entry;
    }
    getInventoryByProducer(producerId) {
        return Array.from(this.inventory.values()).filter((i) => i.producerId === producerId && i.status !== "sold-out");
    }
    getAvailableInventory() {
        const now = new Date().toISOString();
        return Array.from(this.inventory.values()).filter((i) => i.status === "available" &&
            i.availableUntil > now &&
            i.quantityAvailable > 0);
    }
    getInventoryForProduct(productId) {
        return Array.from(this.inventory.values()).filter((i) => i.productId === productId && i.status === "available");
    }
    // ─── Chain Prices (for comparison) ─────────────────────────
    setChainPrice(normalizedName, price) {
        const existing = this.chainPrices.get(normalizedName) || [];
        // Replace if same chain, otherwise add
        const filtered = existing.filter((p) => p.chain !== price.chain);
        filtered.push(price);
        this.chainPrices.set(normalizedName, filtered);
    }
    getChainPrices(normalizedName) {
        return this.chainPrices.get(normalizedName) || [];
    }
    getCheapestChainPrice(normalizedName, isOrganic = false) {
        const prices = this.getChainPrices(normalizedName).filter((p) => p.isOrganic === isOrganic);
        if (prices.length === 0)
            return undefined;
        return prices.reduce((min, p) => p.pricePerUnit < min.pricePerUnit ? p : min);
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
exports.store = new Store();
//# sourceMappingURL=store.js.map
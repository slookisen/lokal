import { Producer, Product, InventoryEntry, ChainPrice } from "../models";
declare class Store {
    private producers;
    private products;
    private inventory;
    private chainPrices;
    addProducer(producer: Producer): Producer;
    getProducer(id: string): Producer | undefined;
    getAllProducers(): Producer[];
    updateProducer(id: string, updates: Partial<Producer>): Producer | undefined;
    addProduct(product: Product): Product;
    getProduct(id: string): Product | undefined;
    getProductsByProducer(producerId: string): Product[];
    updateInventory(entry: InventoryEntry): InventoryEntry;
    getInventoryByProducer(producerId: string): InventoryEntry[];
    getAvailableInventory(): InventoryEntry[];
    getInventoryForProduct(productId: string): InventoryEntry[];
    setChainPrice(normalizedName: string, price: ChainPrice): void;
    getChainPrices(normalizedName: string): ChainPrice[];
    getCheapestChainPrice(normalizedName: string, isOrganic?: boolean): ChainPrice | undefined;
    getStats(): {
        producers: number;
        products: number;
        inventoryEntries: number;
        chainPriceProducts: number;
        activeProducers: number;
        availableItems: number;
    };
}
export declare const store: Store;
export {};
//# sourceMappingURL=store.d.ts.map
import { ProductCategory } from "../models";
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
    qualityScore: number;
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
export declare class VisionScannerService {
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
    scanAndUpdate(input: {
        producerId: string;
        /** In production: base64 frames. For MVP: text description of what's visible */
        frames?: string[];
        /** MVP helper: describe what's in the video/photo */
        description?: string;
        /** MVP helper: structured list of what was detected */
        detectedItems?: Partial<DetectedItem>[];
        source?: "video" | "photo" | "multi-photo";
    }): Promise<ScanResult>;
    /**
     * Enrich a partially detected item with knowledge base data.
     * Fills in category, suggested price, variety details, etc.
     */
    private enrichDetectedItem;
    /**
     * Parse a free-text description into detected items.
     * This simulates what a vision model would return.
     * e.g. "3 kasser cherry-tomater, 20kg mandelpoteter, urter"
     */
    private parseDescription;
    /**
     * Create or update a product + inventory entry from a detected item.
     */
    private upsertProductAndInventory;
    /**
     * Find knowledge base entry for a product name.
     */
    private findKnowledge;
    /**
     * Build a human-readable summary in Norwegian.
     */
    private buildSummary;
    /**
     * Quick price update — producer photographs a price tag or sends a message.
     * Simpler than full scan: just updates prices for existing products.
     * e.g. "Tomater (Cherry) nå 28kr/kg" or from a photo of a price sign.
     */
    quickPriceUpdate(producerId: string, updates: {
        productName: string;
        newPrice: number;
        newQuantity?: number;
    }[]): Promise<{
        updated: string[];
        notFound: string[];
    }>;
    /**
     * Get available varieties for a product (for the producer UI).
     */
    getKnownVarieties(productName: string): string[];
    /**
     * Get all known products in the knowledge base.
     */
    getKnownProducts(): string[];
}
export declare const visionScanner: VisionScannerService;
//# sourceMappingURL=vision-scanner.d.ts.map
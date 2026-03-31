export interface VisionAnalysisRequest {
    /** File paths to images/video frames on disk */
    imagePaths: string[];
    /** MIME types of the files */
    mimeTypes: string[];
    /** Optional context: what kind of producer is this? */
    producerType?: "farm" | "shop" | "garden" | "cooperative";
    /** Optional hint from the producer */
    hint?: string;
}
export interface VisionDetection {
    /** What the AI thinks this product is */
    productName: string;
    /** Specific variety if identifiable (e.g. "Cherry" for tomater) */
    variety: string | null;
    /** Product category */
    category: string;
    /** Confidence 0–1 */
    confidence: number;
    /** Estimated quantity visible */
    estimatedQuantity: number;
    /** Unit for the quantity */
    estimatedUnit: string;
    /** Visual quality 0–1 */
    qualityScore: number;
    /** Does it look organic/unpackaged? */
    looksOrganic: boolean;
    /** If a price tag was visible in the image */
    detectedPrice: number | null;
}
export interface VisionAnalysisResult {
    provider: string;
    detections: VisionDetection[];
    processingTimeMs: number;
    /** Raw response from the AI (for debugging) */
    rawResponse?: string;
}
export interface VisionProvider {
    readonly name: string;
    analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
    isAvailable(): boolean;
}
export declare const NORWEGIAN_PRODUCE: {
    tomater: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    poteter: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    epler: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    gulrøtter: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    løk: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    jordbær: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    agurk: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    kål: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    urter: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    salat: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    paprika: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    honning: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
    egg: {
        category: string;
        varieties: string[];
        unit: string;
        priceRange: [number, number];
        visualCues: string[];
    };
};
export declare class SmartMockProvider implements VisionProvider {
    readonly name = "smart-mock";
    isAvailable(): boolean;
    analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
    private pickVariety;
    private randomPrice;
    private randomQuantity;
}
export declare class ClaudeVisionProvider implements VisionProvider {
    readonly name = "claude-vision";
    private apiKey;
    constructor();
    isAvailable(): boolean;
    analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
}
export declare class OpenAIVisionProvider implements VisionProvider {
    readonly name = "openai-vision";
    private apiKey;
    constructor();
    isAvailable(): boolean;
    analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
}
export declare class VisionProviderManager {
    private providers;
    constructor();
    /** Get the best available provider */
    getProvider(): VisionProvider;
    /** Get a specific provider by name */
    getProviderByName(name: string): VisionProvider | null;
    /** List all providers and their availability */
    listProviders(): {
        name: string;
        available: boolean;
    }[];
}
export declare const visionProviders: VisionProviderManager;
//# sourceMappingURL=vision-provider.d.ts.map
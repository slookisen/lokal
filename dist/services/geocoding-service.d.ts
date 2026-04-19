export interface GeoResult {
    lat: number;
    lng: number;
    name: string;
    radiusKm: number;
    source: "cache" | "hardcoded" | "database" | "kartverket";
}
declare class GeocodingService {
    /**
     * Resolve a place name to coordinates.
     * Returns null if the name can't be geocoded.
     */
    geocode(placeName: string): Promise<GeoResult | null>;
    /**
     * Extract location words from a search query and try to geocode them.
     * Returns the first successful geocode result.
     * Tries multi-word combos first ("mo i rana"), then single words.
     */
    extractAndGeocode(query: string): Promise<GeoResult | null>;
    private lookupInDatabase;
    private lookupKartverket;
    private cacheResult;
}
export declare const geocodingService: GeocodingService;
export {};
//# sourceMappingURL=geocoding-service.d.ts.map
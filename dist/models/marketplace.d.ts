import { z } from "zod";
export declare const AgentRegistrationSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    provider: z.ZodString;
    contactEmail: z.ZodString;
    url: z.ZodString;
    version: z.ZodDefault<z.ZodString>;
    capabilities: z.ZodDefault<z.ZodObject<{
        streaming: z.ZodDefault<z.ZodBoolean>;
        pushNotifications: z.ZodDefault<z.ZodBoolean>;
        stateTransitionHistory: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    skills: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        tags: z.ZodArray<z.ZodString>;
        inputModes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        outputModes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    role: z.ZodEnum<{
        producer: "producer";
        consumer: "consumer";
        logistics: "logistics";
        quality: "quality";
        "price-intel": "price-intel";
    }>;
    location: z.ZodOptional<z.ZodObject<{
        lat: z.ZodNumber;
        lng: z.ZodNumber;
        city: z.ZodString;
        radiusKm: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    categories: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    languages: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;
export declare const AdminRegistrationSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    provider: z.ZodDefault<z.ZodString>;
    contactEmail: z.ZodDefault<z.ZodString>;
    url: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    capabilities: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodAny>>;
    skills: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodDefault<z.ZodString>;
        name: z.ZodDefault<z.ZodString>;
        description: z.ZodDefault<z.ZodString>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        inputModes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        outputModes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    role: z.ZodDefault<z.ZodEnum<{
        producer: "producer";
        consumer: "consumer";
        logistics: "logistics";
        quality: "quality";
        "price-intel": "price-intel";
    }>>;
    location: z.ZodOptional<z.ZodObject<{
        lat: z.ZodNumber;
        lng: z.ZodNumber;
        city: z.ZodString;
        radiusKm: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    categories: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    languages: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type AdminRegistration = z.infer<typeof AdminRegistrationSchema>;
export declare const RegisteredAgentSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    provider: z.ZodString;
    contactEmail: z.ZodString;
    url: z.ZodString;
    version: z.ZodDefault<z.ZodString>;
    capabilities: z.ZodDefault<z.ZodObject<{
        streaming: z.ZodDefault<z.ZodBoolean>;
        pushNotifications: z.ZodDefault<z.ZodBoolean>;
        stateTransitionHistory: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    skills: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        tags: z.ZodArray<z.ZodString>;
        inputModes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        outputModes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    role: z.ZodEnum<{
        producer: "producer";
        consumer: "consumer";
        logistics: "logistics";
        quality: "quality";
        "price-intel": "price-intel";
    }>;
    location: z.ZodOptional<z.ZodObject<{
        lat: z.ZodNumber;
        lng: z.ZodNumber;
        city: z.ZodString;
        radiusKm: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    categories: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    languages: z.ZodDefault<z.ZodArray<z.ZodString>>;
    id: z.ZodString;
    apiKey: z.ZodString;
    registeredAt: z.ZodString;
    lastSeenAt: z.ZodString;
    isActive: z.ZodDefault<z.ZodBoolean>;
    isVerified: z.ZodDefault<z.ZodBoolean>;
    trustScore: z.ZodDefault<z.ZodNumber>;
    totalInteractions: z.ZodDefault<z.ZodNumber>;
    avgResponseTimeMs: z.ZodOptional<z.ZodNumber>;
    discoveryCount: z.ZodDefault<z.ZodNumber>;
    interactionCount: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type RegisteredAgent = z.infer<typeof RegisteredAgentSchema>;
export declare const DiscoveryQuerySchema: z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodEnum<{
        producer: "producer";
        consumer: "consumer";
        logistics: "logistics";
        quality: "quality";
        "price-intel": "price-intel";
    }>>;
    categories: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    location: z.ZodOptional<z.ZodObject<{
        lat: z.ZodNumber;
        lng: z.ZodNumber;
    }, z.core.$strip>>;
    maxDistanceKm: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type DiscoveryQuery = z.infer<typeof DiscoveryQuerySchema>;
export interface DiscoveryResult {
    agent: {
        id: string;
        name: string;
        description: string;
        url: string;
        role: string;
        skills: Array<{
            id: string;
            name: string;
            description: string;
            tags: string[];
        }>;
        location?: {
            city: string;
            distanceKm?: number;
        };
        trustScore: number;
        isVerified: boolean;
        categories: string[];
        tags: string[];
    };
    relevanceScore: number;
    matchReasons: string[];
}
//# sourceMappingURL=marketplace.d.ts.map
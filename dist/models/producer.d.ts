import { z } from "zod";
export declare const LocationSchema: z.ZodObject<{
    lat: z.ZodNumber;
    lng: z.ZodNumber;
    address: z.ZodOptional<z.ZodString>;
    city: z.ZodString;
    district: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OpeningHoursSchema: z.ZodObject<{
    day: z.ZodEnum<{
        mon: "mon";
        tue: "tue";
        wed: "wed";
        thu: "thu";
        fri: "fri";
        sat: "sat";
        sun: "sun";
    }>;
    open: z.ZodString;
    close: z.ZodString;
}, z.core.$strip>;
export declare const ProducerSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodEnum<{
        farm: "farm";
        shop: "shop";
        market: "market";
        cooperative: "cooperative";
        garden: "garden";
    }>;
    location: z.ZodObject<{
        lat: z.ZodNumber;
        lng: z.ZodNumber;
        address: z.ZodOptional<z.ZodString>;
        city: z.ZodString;
        district: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    openingHours: z.ZodArray<z.ZodObject<{
        day: z.ZodEnum<{
            mon: "mon";
            tue: "tue";
            wed: "wed";
            thu: "thu";
            fri: "fri";
            sat: "sat";
            sun: "sun";
        }>;
        open: z.ZodString;
        close: z.ZodString;
    }, z.core.$strip>>;
    contactPhone: z.ZodOptional<z.ZodString>;
    contactEmail: z.ZodOptional<z.ZodString>;
    tags: z.ZodArray<z.ZodString>;
    certifications: z.ZodArray<z.ZodString>;
    deliveryOptions: z.ZodArray<z.ZodEnum<{
        pickup: "pickup";
        "local-delivery": "local-delivery";
        shipping: "shipping";
    }>>;
    maxDeliveryRadiusKm: z.ZodOptional<z.ZodNumber>;
    trustScore: z.ZodDefault<z.ZodNumber>;
    totalTransactions: z.ZodDefault<z.ZodNumber>;
    availabilityAccuracy: z.ZodDefault<z.ZodNumber>;
    responseTimeAvgMs: z.ZodOptional<z.ZodNumber>;
    registeredAt: z.ZodString;
    lastActiveAt: z.ZodString;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type Producer = z.infer<typeof ProducerSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;
//# sourceMappingURL=producer.d.ts.map
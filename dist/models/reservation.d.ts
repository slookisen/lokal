import { z } from "zod";
export declare const ReservationItemSchema: z.ZodObject<{
    productId: z.ZodString;
    productName: z.ZodString;
    variety: z.ZodOptional<z.ZodString>;
    quantity: z.ZodNumber;
    unit: z.ZodString;
    pricePerUnit: z.ZodNumber;
    lineTotal: z.ZodNumber;
}, z.core.$strip>;
export declare const ReservationSchema: z.ZodObject<{
    id: z.ZodString;
    consumerId: z.ZodString;
    consumerName: z.ZodOptional<z.ZodString>;
    producerId: z.ZodString;
    producerName: z.ZodString;
    items: z.ZodArray<z.ZodObject<{
        productId: z.ZodString;
        productName: z.ZodString;
        variety: z.ZodOptional<z.ZodString>;
        quantity: z.ZodNumber;
        unit: z.ZodString;
        pricePerUnit: z.ZodNumber;
        lineTotal: z.ZodNumber;
    }, z.core.$strip>>;
    totalAmount: z.ZodNumber;
    currency: z.ZodDefault<z.ZodString>;
    fulfillment: z.ZodEnum<{
        pickup: "pickup";
        delivery: "delivery";
    }>;
    pickupTime: z.ZodOptional<z.ZodString>;
    deliveryAddress: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        requested: "requested";
        confirmed: "confirmed";
        rejected: "rejected";
        ready: "ready";
        "picked-up": "picked-up";
        delivered: "delivered";
        completed: "completed";
        cancelled: "cancelled";
    }>;
    createdAt: z.ZodString;
    confirmedAt: z.ZodOptional<z.ZodString>;
    readyAt: z.ZodOptional<z.ZodString>;
    completedAt: z.ZodOptional<z.ZodString>;
    consumerNote: z.ZodOptional<z.ZodString>;
    producerNote: z.ZodOptional<z.ZodString>;
    estimatedSavings: z.ZodOptional<z.ZodNumber>;
    savingsLabel: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type ReservationItem = z.infer<typeof ReservationItemSchema>;
//# sourceMappingURL=reservation.d.ts.map
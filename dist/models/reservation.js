"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReservationSchema = exports.ReservationItemSchema = void 0;
const zod_1 = require("zod");
// ─── Reservation Model ─────────────────────────────────────────
// A reservation is the transaction between consumer and producer.
// Flow: request → confirmed → ready → picked-up/delivered → completed
//
// The consumer's agent creates the reservation.
// The producer's agent confirms it.
// Both sides see status updates in real-time.
exports.ReservationItemSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    productName: zod_1.z.string(),
    variety: zod_1.z.string().optional(),
    quantity: zod_1.z.number().min(0.1),
    unit: zod_1.z.string(),
    pricePerUnit: zod_1.z.number(),
    lineTotal: zod_1.z.number(),
});
exports.ReservationSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    // Who
    consumerId: zod_1.z.string(), // consumer agent identifier
    consumerName: zod_1.z.string().optional(),
    producerId: zod_1.z.string().uuid(),
    producerName: zod_1.z.string(),
    // What
    items: zod_1.z.array(exports.ReservationItemSchema),
    totalAmount: zod_1.z.number(),
    currency: zod_1.z.string().default("NOK"),
    // How
    fulfillment: zod_1.z.enum(["pickup", "delivery"]),
    pickupTime: zod_1.z.string().datetime().optional(), // when consumer wants to pick up
    deliveryAddress: zod_1.z.string().optional(),
    // Status lifecycle
    status: zod_1.z.enum([
        "requested", // consumer agent sent the request
        "confirmed", // producer agent confirmed availability
        "rejected", // producer can't fulfill (out of stock, closed, etc.)
        "ready", // order is packed and ready for pickup/delivery
        "picked-up", // consumer has collected the order
        "delivered", // delivery completed
        "completed", // both sides confirmed — transaction done
        "cancelled", // cancelled by either side
    ]),
    // Timestamps
    createdAt: zod_1.z.string().datetime(),
    confirmedAt: zod_1.z.string().datetime().optional(),
    readyAt: zod_1.z.string().datetime().optional(),
    completedAt: zod_1.z.string().datetime().optional(),
    // Communication
    consumerNote: zod_1.z.string().optional(), // "Kan hente etter kl 16"
    producerNote: zod_1.z.string().optional(), // "Står klart ved inngangen"
    // Price comparison (shown to consumer)
    estimatedSavings: zod_1.z.number().optional(), // vs chain prices
    savingsLabel: zod_1.z.string().optional(), // "Du sparer ~42 kr vs Rema 1000"
});
//# sourceMappingURL=reservation.js.map
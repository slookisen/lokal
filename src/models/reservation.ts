import { z } from "zod";

// ─── Reservation Model ─────────────────────────────────────────
// A reservation is the transaction between consumer and producer.
// Flow: request → confirmed → ready → picked-up/delivered → completed
//
// The consumer's agent creates the reservation.
// The producer's agent confirms it.
// Both sides see status updates in real-time.

export const ReservationItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  variety: z.string().optional(),
  quantity: z.number().min(0.1),
  unit: z.string(),
  pricePerUnit: z.number(),
  lineTotal: z.number(),
});

export const ReservationSchema = z.object({
  id: z.string().uuid(),
  // Who
  consumerId: z.string(), // consumer agent identifier
  consumerName: z.string().optional(),
  producerId: z.string().uuid(),
  producerName: z.string(),

  // What
  items: z.array(ReservationItemSchema),
  totalAmount: z.number(),
  currency: z.string().default("NOK"),

  // How
  fulfillment: z.enum(["pickup", "delivery"]),
  pickupTime: z.string().datetime().optional(), // when consumer wants to pick up
  deliveryAddress: z.string().optional(),

  // Status lifecycle
  status: z.enum([
    "requested",   // consumer agent sent the request
    "confirmed",   // producer agent confirmed availability
    "rejected",    // producer can't fulfill (out of stock, closed, etc.)
    "ready",       // order is packed and ready for pickup/delivery
    "picked-up",   // consumer has collected the order
    "delivered",   // delivery completed
    "completed",   // both sides confirmed — transaction done
    "cancelled",   // cancelled by either side
  ]),

  // Timestamps
  createdAt: z.string().datetime(),
  confirmedAt: z.string().datetime().optional(),
  readyAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),

  // Communication
  consumerNote: z.string().optional(), // "Kan hente etter kl 16"
  producerNote: z.string().optional(), // "Står klart ved inngangen"

  // Price comparison (shown to consumer)
  estimatedSavings: z.number().optional(), // vs chain prices
  savingsLabel: z.string().optional(), // "Du sparer ~42 kr vs Rema 1000"
});

export type Reservation = z.infer<typeof ReservationSchema>;
export type ReservationItem = z.infer<typeof ReservationItemSchema>;

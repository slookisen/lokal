import { v4 as uuid } from "uuid";
import { store } from "./store";
import { Reservation, ReservationItem } from "../models";

// ─── Reservation Service ───────────────────────────────────────
// This is the TRANSACTION layer — where agents actually do business.
//
// Flow:
// 1. Consumer agent sends reservation request (items + pickup time)
// 2. We validate availability and calculate totals + chain savings
// 3. Producer agent confirms or rejects
// 4. Consumer picks up / gets delivery
// 5. Both sides rate the experience → trust scores update
//
// This is an A2A interaction: consumer agent → platform → producer agent.

// In-memory reservation store (replace with DB in production)
const reservations = new Map<string, Reservation>();

export class ReservationService {
  /**
   * Consumer agent creates a reservation request.
   * This is the primary A2A transaction endpoint.
   */
  create(input: {
    consumerId: string;
    consumerName?: string;
    producerId: string;
    items: { productId: string; quantity: number }[];
    fulfillment: "pickup" | "delivery";
    pickupTime?: string;
    deliveryAddress?: string;
    consumerNote?: string;
  }): Reservation {
    const producer = store.getProducer(input.producerId);
    if (!producer) throw new Error("Produsent ikke funnet");

    // Validate items and build line items
    const lineItems: ReservationItem[] = [];
    let totalAmount = 0;
    let totalChainCost = 0;
    let hasChainComparison = false;

    for (const reqItem of input.items) {
      const product = store.getProduct(reqItem.productId);
      if (!product) throw new Error(`Produkt ${reqItem.productId} ikke funnet`);

      const inventory = store.getInventoryForProduct(reqItem.productId);
      const available = inventory.find(
        (i) => i.producerId === input.producerId && i.status === "available"
      );

      if (!available) {
        throw new Error(`${product.name} er ikke tilgjengelig akkurat nå`);
      }
      if (available.quantityAvailable < reqItem.quantity) {
        throw new Error(
          `Kun ${available.quantityAvailable} ${available.unit} ${product.name} tilgjengelig (du ba om ${reqItem.quantity})`
        );
      }

      const lineTotal = reqItem.quantity * available.pricePerUnit;
      totalAmount += lineTotal;

      lineItems.push({
        productId: product.id,
        productName: product.name,
        variety: product.variety,
        quantity: reqItem.quantity,
        unit: available.unit,
        pricePerUnit: available.pricePerUnit,
        lineTotal: Math.round(lineTotal * 100) / 100,
      });

      // Calculate chain comparison for savings
      const normalized = product.name.toLowerCase()
        .replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[å]/g, "a");
      const chainPrice = store.getCheapestChainPrice(normalized, product.isOrganic);
      if (chainPrice) {
        totalChainCost += reqItem.quantity * chainPrice.pricePerUnit;
        hasChainComparison = true;
      }
    }

    const savings = hasChainComparison
      ? Math.round((totalChainCost - totalAmount) * 100) / 100
      : undefined;

    const reservation: Reservation = {
      id: uuid(),
      consumerId: input.consumerId,
      consumerName: input.consumerName,
      producerId: input.producerId,
      producerName: producer.name,
      items: lineItems,
      totalAmount: Math.round(totalAmount * 100) / 100,
      currency: "NOK",
      fulfillment: input.fulfillment,
      pickupTime: input.pickupTime,
      deliveryAddress: input.deliveryAddress,
      status: "requested",
      createdAt: new Date().toISOString(),
      consumerNote: input.consumerNote,
      estimatedSavings: savings && savings > 0 ? savings : undefined,
      savingsLabel:
        savings && savings > 0
          ? `Du sparer ~${Math.round(savings)} kr sammenlignet med butikkjeder`
          : undefined,
    };

    reservations.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * Producer agent confirms the reservation.
   */
  confirm(
    reservationId: string,
    producerNote?: string
  ): Reservation {
    const res = reservations.get(reservationId);
    if (!res) throw new Error("Reservasjon ikke funnet");
    if (res.status !== "requested") {
      throw new Error(`Kan ikke bekrefte — status er "${res.status}"`);
    }

    // Reduce inventory for confirmed items
    for (const item of res.items) {
      const inventory = store.getInventoryForProduct(item.productId);
      const entry = inventory.find((i) => i.producerId === res.producerId);
      if (entry) {
        store.updateInventory({
          ...entry,
          quantityAvailable: Math.max(0, entry.quantityAvailable - item.quantity),
          status:
            entry.quantityAvailable - item.quantity <= 0
              ? "sold-out"
              : entry.quantityAvailable - item.quantity <= 5
              ? "low-stock"
              : "available",
          updatedAt: new Date().toISOString(),
        });
      }
    }

    res.status = "confirmed";
    res.confirmedAt = new Date().toISOString();
    res.producerNote = producerNote;
    reservations.set(res.id, res);
    return res;
  }

  /**
   * Producer marks order as ready for pickup/delivery.
   */
  markReady(reservationId: string, producerNote?: string): Reservation {
    const res = reservations.get(reservationId);
    if (!res) throw new Error("Reservasjon ikke funnet");
    if (res.status !== "confirmed") {
      throw new Error(`Kan ikke merke klar — status er "${res.status}"`);
    }

    res.status = "ready";
    res.readyAt = new Date().toISOString();
    if (producerNote) res.producerNote = producerNote;
    reservations.set(res.id, res);
    return res;
  }

  /**
   * Complete the reservation (pickup done or delivered).
   */
  complete(reservationId: string): Reservation {
    const res = reservations.get(reservationId);
    if (!res) throw new Error("Reservasjon ikke funnet");
    if (res.status !== "ready") {
      throw new Error(`Kan ikke fullføre — status er "${res.status}"`);
    }

    res.status = "completed";
    res.completedAt = new Date().toISOString();
    reservations.set(res.id, res);

    // Update producer trust score (simple increment for MVP)
    const producer = store.getProducer(res.producerId);
    if (producer) {
      const newTotal = producer.totalTransactions + 1;
      store.updateProducer(res.producerId, {
        totalTransactions: newTotal,
        trustScore: Math.min(1, producer.trustScore + 0.01),
      });
    }

    return res;
  }

  /**
   * Reject or cancel a reservation.
   */
  cancel(reservationId: string, reason?: string): Reservation {
    const res = reservations.get(reservationId);
    if (!res) throw new Error("Reservasjon ikke funnet");
    if (["completed", "cancelled"].includes(res.status)) {
      throw new Error(`Kan ikke avbryte — allerede "${res.status}"`);
    }

    res.status = "cancelled";
    if (reason) res.producerNote = reason;
    reservations.set(res.id, res);
    return res;
  }

  /** Get a single reservation by ID. */
  get(id: string): Reservation | undefined {
    return reservations.get(id);
  }

  /** Get all reservations for a producer. */
  getByProducer(producerId: string): Reservation[] {
    return Array.from(reservations.values())
      .filter((r) => r.producerId === producerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Get all reservations for a consumer. */
  getByConsumer(consumerId: string): Reservation[] {
    return Array.from(reservations.values())
      .filter((r) => r.consumerId === consumerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const reservationService = new ReservationService();

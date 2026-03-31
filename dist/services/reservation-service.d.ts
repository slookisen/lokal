import { Reservation } from "../models";
export declare class ReservationService {
    /**
     * Consumer agent creates a reservation request.
     * This is the primary A2A transaction endpoint.
     */
    create(input: {
        consumerId: string;
        consumerName?: string;
        producerId: string;
        items: {
            productId: string;
            quantity: number;
        }[];
        fulfillment: "pickup" | "delivery";
        pickupTime?: string;
        deliveryAddress?: string;
        consumerNote?: string;
    }): Reservation;
    /**
     * Producer agent confirms the reservation.
     */
    confirm(reservationId: string, producerNote?: string): Reservation;
    /**
     * Producer marks order as ready for pickup/delivery.
     */
    markReady(reservationId: string, producerNote?: string): Reservation;
    /**
     * Complete the reservation (pickup done or delivered).
     */
    complete(reservationId: string): Reservation;
    /**
     * Reject or cancel a reservation.
     */
    cancel(reservationId: string, reason?: string): Reservation;
    /** Get a single reservation by ID. */
    get(id: string): Reservation | undefined;
    /** Get all reservations for a producer. */
    getByProducer(producerId: string): Reservation[];
    /** Get all reservations for a consumer. */
    getByConsumer(consumerId: string): Reservation[];
}
export declare const reservationService: ReservationService;
//# sourceMappingURL=reservation-service.d.ts.map
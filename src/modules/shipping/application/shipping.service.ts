import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export type ShipmentStatus = 'pending' | 'preparing' | 'shipped' | 'delivered' | 'failed';

export interface Shipment {
  id: string;
  orderId: string;
  brandId: string;
  status: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shippedAt?: string;
  deliveredAt?: string;
}

export interface ShipmentRepository {
  save(shipment: Shipment): Promise<Shipment>;
  findByOrderId?(orderId: string): Promise<Shipment | null>;
}

export interface UpdateShipmentInput {
  shipment: Shipment;
  nextStatus: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

@Injectable()
export class ShippingService {
  constructor(@Inject('ShipmentRepository') private readonly shipments: ShipmentRepository) {}

  createManualShipment(orderId: string, brandId: string): Shipment {
    return { id: randomUUID(), orderId, brandId, status: 'pending' };
  }

  async createPendingForPaidOrder(orderId: string, brandId: string): Promise<Shipment> {
    const existing = await this.shipments.findByOrderId?.(orderId);
    if (existing) {
      return existing;
    }

    return this.shipments.save(this.createManualShipment(orderId, brandId));
  }

  async updateStatus(input: UpdateShipmentInput): Promise<Shipment> {
    this.assertTransition(input.shipment.status, input.nextStatus);
    const next: Shipment = {
      ...input.shipment,
      status: input.nextStatus,
      carrier: input.carrier ?? input.shipment.carrier,
      trackingNumber: input.trackingNumber ?? input.shipment.trackingNumber,
      trackingUrl: input.trackingUrl ?? input.shipment.trackingUrl
    };

    if (input.nextStatus === 'shipped') {
      if (!next.carrier || !next.trackingNumber) {
        throw new BadRequestException('Carrier and tracking number are required when marking a shipment as shipped');
      }
      next.shippedAt ??= new Date().toISOString();
    }
    if (input.nextStatus === 'delivered') {
      next.deliveredAt ??= new Date().toISOString();
    }

    return this.shipments.save(next);
  }

  private assertTransition(from: ShipmentStatus, to: ShipmentStatus): void {
    const allowed: Record<ShipmentStatus, ShipmentStatus[]> = {
      pending: ['preparing', 'failed'],
      preparing: ['shipped', 'failed'],
      shipped: ['delivered', 'failed'],
      delivered: [],
      failed: []
    };

    if (!allowed[from].includes(to)) {
      throw new BadRequestException(`Invalid shipment transition from ${from} to ${to}`);
    }
  }
}

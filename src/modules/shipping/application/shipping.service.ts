import {BadRequestException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {requireBrandManagementAccess} from '../../brands/brand-management-access';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {SHIPPING, SHIPMENT_STATUS, applyShipmentAction, shipmentActionSchema, shipmentActions, type Shipment, type ShipmentResult} from '../domain/shipping.contract';
import type {ShipmentRepository} from '../domain/shipping.repository';

@Injectable()
export class ShippingService {
  constructor(@Inject(SHIPPING.repository) private readonly shipments: ShipmentRepository) {}
  createManualShipment(orderId: string, brandId: string): Shipment {
    return {id: randomUUID(), orderId, brandId, version: SHIPPING.revision.initial, status: SHIPMENT_STATUS.pending,
      carrier: null, trackingNumber: null, trackingUrl: null, shippedAt: null, deliveredAt: null, incidentReason: null, incidentAt: null};
  }
  createPendingForPaidOrder(orderId: string, brandId: string): Promise<Shipment> {
    return this.shipments.create(this.createManualShipment(orderId, brandId));
  }
  async updateForActor(actor: Pick<AuthenticatedUser, 'id'>, id: string, raw: unknown): Promise<ShipmentResult> {
    const parsed = shipmentActionSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(SHIPPING.failure.input);
    return this.shipments.transaction(async repository => {
      const reference = await repository.findById(id);
      if (!reference) throw new NotFoundException(SHIPPING.failure.missing);
      requireBrandManagementAccess(await repository.lockManagementAccess(reference.brandId, actor.id));
      const current = await repository.lockContext(id);
      if (!current || current.shipment.brandId !== reference.brandId) throw new NotFoundException(SHIPPING.failure.missing);
      const change = applyShipmentAction(current, parsed.data, new Date().toISOString());
      await repository.apply(change, current.shipment.version);
      return {shipment: change.shipment, orderStatus: change.orderStatus, actions: shipmentActions(change)};
    });
  }
}

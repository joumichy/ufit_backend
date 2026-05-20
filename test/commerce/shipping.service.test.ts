import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ShippingService, type Shipment, type ShipmentRepository } from '../../src/modules/shipping/application/shipping.service';

class FakeShipmentRepository implements ShipmentRepository {
  async save(shipment: Shipment): Promise<Shipment> {
    return structuredClone(shipment);
  }
}

describe('ShippingService', () => {
  it('requires carrier and tracking number when a shipment becomes shipped', async () => {
    const service = new ShippingService(new FakeShipmentRepository());
    const shipment = service.createManualShipment('order-1', 'brand-1');
    const preparing = await service.updateStatus({ shipment, nextStatus: 'preparing' });

    await expect(service.updateStatus({ shipment: preparing, nextStatus: 'shipped' })).rejects.toBeInstanceOf(
      BadRequestException
    );

    const shipped = await service.updateStatus({
      shipment: preparing,
      nextStatus: 'shipped',
      carrier: 'Swiss Post',
      trackingNumber: 'TRACK-1'
    });

    expect(shipped.status).toBe('shipped');
    expect(shipped.shippedAt).toBeDefined();
  });
});

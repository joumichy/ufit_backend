import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ShippingService, type Shipment, type ShipmentStatus } from '../application/shipping.service';

interface UpdateShipmentBody {
  shipment: Shipment;
  nextStatus: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

@Controller('shipping')
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @Patch('shipments/:id/status')
  updateStatus(@Param('id') _id: string, @Body() body: UpdateShipmentBody) {
    return this.shippingService.updateStatus(body);
  }
}

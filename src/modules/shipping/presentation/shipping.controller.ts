import { Body, Controller, Inject, Param, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { ShippingService, type Shipment, type ShipmentStatus } from '../application/shipping.service';

interface UpdateShipmentBody {
  shipment: Shipment;
  nextStatus: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

@Controller('shipping')
@UseGuards(AuthGuard, RoleGuard)
export class ShippingController {
  constructor(@Inject(ShippingService) private readonly shippingService: ShippingService) {}

  @Patch('shipments/:id/status')
  @Roles('brand_owner', 'brand_manager', 'admin', 'super_admin')
  updateStatus(@Param('id') _id: string, @Body() body: UpdateShipmentBody) {
    return this.shippingService.updateStatus(body);
  }
}

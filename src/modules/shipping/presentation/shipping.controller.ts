import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { Roles } from "../../../shared/presentation/decorators/roles.decorator";
import { CurrentUser } from "../../../shared/presentation/decorators/current-user.decorator";
import { AuthGuard } from "../../../shared/presentation/guards/auth.guard";
import { RoleGuard } from "../../../shared/presentation/guards/role.guard";
import type { AuthenticatedUser } from "../../identity/domain/user.types";
import { ShippingService } from "../application/shipping.service";
const SHIPPING_ROUTE = {
  root: "shipping",
  status: "shipments/:id/status",
  id: "id",
  roles: ["brand_owner", "brand_manager", "admin", "super_admin"] as const,
};
@Controller(SHIPPING_ROUTE.root)
@UseGuards(AuthGuard, RoleGuard)
export class ShippingController {
  constructor(
    @Inject(ShippingService) private readonly shipping: ShippingService,
  ) {}
  @Patch(SHIPPING_ROUTE.status)
  @Roles(...SHIPPING_ROUTE.roles)
  updateStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param(SHIPPING_ROUTE.id, ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.shipping.updateForActor(actor, id, body);
  }
}

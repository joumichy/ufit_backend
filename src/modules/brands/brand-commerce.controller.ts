import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../../shared/presentation/guards/auth.guard";
import { RoleGuard } from "../../shared/presentation/guards/role.guard";
import { Roles } from "../../shared/presentation/decorators/roles.decorator";
import { CurrentUser } from "../../shared/presentation/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/domain/user.types";
import { BrandCommerceService } from "./brand-commerce.service";
const BRANDS_ROUTE = "brands";
@Controller(BRANDS_ROUTE)
@UseGuards(AuthGuard, RoleGuard)
export class BrandCommerceController {
  constructor(
    @Inject(BrandCommerceService)
    private readonly commerce: BrandCommerceService,
  ) {}
  @Put(":id/commerce-policy")
  @Roles("brand_owner", "brand_manager", "admin", "super_admin")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: unknown,
  ) {
    return this.commerce.update(id, actor, input);
  }
}

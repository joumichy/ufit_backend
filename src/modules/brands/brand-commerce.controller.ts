import {
  Body,
  Controller,
  Inject,
  Get,
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
import {BRAND_COMMERCE} from './commerce-policy';
import {COUNTRY_CODES} from '../../shared/domain/countries';
import {CURRENCY_METADATA} from '../../shared/domain/currencies';
@Controller(BRAND_COMMERCE.routes.brands)
@UseGuards(AuthGuard, RoleGuard)
export class BrandCommerceController {
  constructor(
    @Inject(BrandCommerceService)
    private readonly commerce: BrandCommerceService,
  ) {}
  @Get(BRAND_COMMERCE.routes.metadata)
  @Roles(...BRAND_COMMERCE.roles)
  metadata() { return {countries: COUNTRY_CODES, currencies: CURRENCY_METADATA}; }
  @Get(BRAND_COMMERCE.routes.policy)
  @Roles(...BRAND_COMMERCE.roles)
  read(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.commerce.readManaged(id, actor);
  }
  @Put(BRAND_COMMERCE.routes.policy)
  @Roles(...BRAND_COMMERCE.roles)
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: unknown,
  ) {
    return this.commerce.update(id, actor, input);
  }
}

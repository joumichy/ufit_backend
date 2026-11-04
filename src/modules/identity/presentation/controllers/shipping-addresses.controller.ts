import {Body, Controller, Get, Header, Inject, Param, Put, Query, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../../shared/presentation/guards/auth.guard';
import type {AuthenticatedUser} from '../../domain/user.types';
import {SHIPPING_ADDRESSES as S} from '../../domain/shipping-addresses.contract';
import {ShippingAddressesService} from '../../application/shipping-addresses.service';
import {COUNTRY_CODES} from '../../../../shared/domain/countries';

@Controller(S.route.root)
@UseGuards(AuthGuard)
export class ShippingAddressesController {
  constructor(@Inject(ShippingAddressesService) private readonly addresses: ShippingAddressesService) {}
  @Get(S.route.countries)
  @Header(S.cache.header, S.cache.value)
  countries() { return {countries: COUNTRY_CODES}; }
  @Get(S.route.user)
  @Header(S.cache.header, S.cache.value)
  list(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.userParameter) userId: string, @Query() query: unknown) {
    return this.addresses.list(actor.id, userId, query);
  }
  @Get(S.route.address)
  @Header(S.cache.header, S.cache.value)
  find(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.userParameter) userId: string, @Param(S.route.addressParameter) addressId: string) {
    return this.addresses.find(actor.id, userId, addressId);
  }
  @Get(S.route.change)
  @Header(S.cache.header, S.cache.value)
  change(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.userParameter) userId: string, @Param(S.route.requestParameter) requestId: string) {
    return this.addresses.change(actor.id, userId, requestId);
  }
  @Put(S.route.change)
  @Header(S.cache.header, S.cache.value)
  apply(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.userParameter) userId: string,
    @Param(S.route.requestParameter) requestId: string, @Body() body: unknown) {
    return this.addresses.apply(actor.id, userId, requestId, body);
  }
}

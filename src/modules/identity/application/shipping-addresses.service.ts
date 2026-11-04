import {BadRequestException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {SHIPPING_ADDRESSES as S, shippingAddressIdentifierSchema, shippingAddressChangeSchema, shippingAddressListQuerySchema,
  type ShippingAddressesRepository} from '../domain/shipping-addresses.contract';
import {decodeShippingAddressCursor} from '../domain/shipping-addresses.cursor';

@Injectable()
export class ShippingAddressesService {
  constructor(@Inject(S.token) private readonly repository: ShippingAddressesRepository) {}
  list(actorId: string, target: string, raw: unknown) {
    const userId = owner(actorId, target), parsed = shippingAddressListQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(S.failure.invalid);
    return this.repository.list(userId, {limit: parsed.data.limit,
      ...(parsed.data.cursor ? {cursor: decodeShippingAddressCursor(parsed.data.cursor, userId)} : {})});
  }
  find(actorId: string, target: string, address: string) {
    return this.repository.find(owner(actorId, target), identifier(address));
  }
  change(actorId: string, target: string, request: string) {
    return this.repository.change(owner(actorId, target), identifier(request));
  }
  apply(actorId: string, target: string, request: string, raw: unknown) {
    const userId = owner(actorId, target), requestId = identifier(request), parsed = shippingAddressChangeSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(S.failure.invalid);
    return this.repository.apply(userId, requestId, parsed.data);
  }
}
function identifier(raw: string): string {
  const parsed = shippingAddressIdentifierSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException(S.failure.invalid);
  return parsed.data;
}
function owner(actorId: string, target: string): string {
  const userId = identifier(target);
  if (actorId !== userId) throw new NotFoundException(S.failure.unavailable);
  return userId;
}

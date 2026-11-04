import {BadRequestException} from '@nestjs/common';
import {SHIPPING_ADDRESSES as S, shippingAddressCursorSchema, type ShippingAddressCursor} from './shipping-addresses.contract';

export function encodeShippingAddressCursor(cursor: ShippingAddressCursor): string {
  return Buffer.from(JSON.stringify(shippingAddressCursorSchema.parse(cursor))).toString(S.pagination.cursorEncoding);
}
export function decodeShippingAddressCursor(raw: string, userId: string): ShippingAddressCursor {
  try {
    const cursor = shippingAddressCursorSchema.parse(JSON.parse(Buffer.from(raw, S.pagination.cursorEncoding).toString()));
    if (cursor.userId !== userId || encodeShippingAddressCursor(cursor) !== raw) throw new Error();
    return cursor;
  } catch { throw new BadRequestException(S.failure.invalid); }
}

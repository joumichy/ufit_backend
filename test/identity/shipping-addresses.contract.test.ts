import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {SHIPPING_ADDRESSES as S, shippingAddressChangeSchema as command, shippingAddressItemSchema as item,
  shippingAddressPageSchema as page, shippingAddressReceiptSchema as receipt, shippingAddressListQuerySchema as query} from '../../src/modules/identity/domain/shipping-addresses.contract';
import {shippingAddressSchema, ADDRESS_LIMIT as A} from '../../src/shared/domain/shipping-address';
import {checkoutRequestSchema} from '../../src/modules/orders/domain/checkout-request';
import {encodeShippingAddressCursor, decodeShippingAddressCursor} from '../../src/modules/identity/domain/shipping-addresses.cursor';
const P = {user: randomUUID(), other: randomUUID(), address: randomUUID(), request: randomUUID(), time: '2026-11-04T04:00:00.000Z',
  fullName: '  Qualification Ufit  ', line: '  Rue de qualification  ', postal: '1000', city: 'Lausanne', country: 'CH',
  phone: '  +41 00 000 00 00  ', blank: '', invalid: 'invalid', lowercaseCountry: 'ch', unknownCountry: 'ZZ', excess: 1, hashUnit: 'a'} as const;
const shipping = () => ({fullName: P.fullName, line1: P.line, postalCode: P.postal, city: P.city, country: P.country, phone: P.phone});
const save = () => ({action: S.action.save, expectedVersion: S.version.absent, addressId: P.address, shippingAddress: shipping(), makeDefault: false});
describe('Private shipping address canonical contract', () => {
  it('uses the exact checkout shipping schema and transformations', () => {
    const checkout = checkoutRequestSchema.parse({requestId: P.request, quoteFingerprint: P.hashUnit.repeat(64), shippingAddress: shipping()});
    const saved = command.parse(save());
    if (saved.action !== S.action.save) throw new Error(P.invalid);
    expect(saved.shippingAddress).toEqual(checkout.shippingAddress);
    expect(checkoutRequestSchema.shape.shippingAddress).toBe(shippingAddressSchema);
    expect(command.parse({...save(), addressId: P.address.toUpperCase()})).toEqual({...command.parse(save()), addressId: P.address});
  });
  it.each([
    {fullName: P.blank}, {fullName: P.fullName.repeat(A.fullName)}, {line1: P.blank}, {line2: P.line.repeat(A.line)},
    {postalCode: P.blank}, {city: P.blank}, {country: P.lowercaseCountry}, {country: P.unknownCountry},
    {country: undefined}, {phone: P.phone.repeat(A.phone)}, {region: P.city}, {line1: undefined},
  ])('does not invent another address validation rule: %j', change => {
    const address = {...shipping(), ...change};
    const checkout = checkoutRequestSchema.safeParse({requestId: P.request, quoteFingerprint: P.hashUnit.repeat(64), shippingAddress: address});
    expect(command.safeParse({...save(), shippingAddress: address}).success).toBe(checkout.success);
    expect(checkout.success).toBe(false);
  });
  it('keeps optional fields optional and accepts the same empty optional values as checkout', () => {
    expect(command.safeParse({...save(), shippingAddress: {...shipping(), line2: P.blank, phone: P.blank}}).success).toBe(true);
    const {phone: _phone, ...address} = shipping();
    expect(command.safeParse({...save(), shippingAddress: address}).success).toBe(true);
  });
  it.each([{makeDefault: undefined}, {makeDefault: P.invalid}, {expectedVersion: undefined}, {expectedVersion: -S.version.step},
    {expectedVersion: S.version.maximum}, {addressId: undefined}, {addressId: P.invalid}, {userId: P.other}, {isDefault: true}, {requestId: P.request}])
  ('rejects missing intent, extra ownership and malformed changes: %j', change => {
    expect(command.safeParse({...save(), ...change}).success).toBe(false);
  });
  it('permits an explicit nullable default only for a set_default command', () => {
    expect(command.parse({action: S.action.setDefault, expectedVersion: S.version.initial, addressId: null}).addressId).toBeNull();
    expect(command.safeParse({action: S.action.delete, expectedVersion: S.version.initial, addressId: null}).success).toBe(false);
    expect(command.safeParse({action: S.action.setDefault, expectedVersion: S.version.initial}).success).toBe(false);
  });
  it('publishes one default identity, no per-item contradictory flag, and explicit empty state', () => {
    const entry = {id: P.address, shippingAddress: shippingAddressSchema.parse(shipping()), createdAt: P.time, updatedAt: P.time};
    expect(item.parse(entry)).toEqual(entry);
    expect(item.safeParse({...entry, isDefault: true}).success).toBe(false);
    expect(page.parse({userId: P.user, version: S.version.absent, defaultAddressId: null, items: [], nextCursor: null}).items).toEqual([]);
    expect(page.safeParse({userId: P.user, version: S.version.absent, defaultAddressId: P.address, items: [entry], nextCursor: null}).success).toBe(false);
    expect(page.safeParse({userId: P.user, version: S.version.initial, defaultAddressId: null, items: [entry, entry], nextCursor: null}).success).toBe(false);
  });
  it('requires immutable receipts without address content', () => {
    const value = {requestId: P.request, action: S.action.delete, version: S.version.initial, addressId: P.address};
    expect(receipt.parse(value)).toEqual(value);
    expect(receipt.safeParse({...value, addressId: null}).success).toBe(false);
    expect(receipt.safeParse({...value, shippingAddress: shipping()}).success).toBe(false);
    expect(receipt.safeParse({...value, action: S.action.setDefault, addressId: null}).success).toBe(true);
  });
  it('binds opaque cursors to one owner and one version, and rejects malformed encodings', () => {
    const cursor = {userId: P.user, version: S.version.initial, afterId: P.address};
    expect(decodeShippingAddressCursor(encodeShippingAddressCursor(cursor), P.user)).toEqual(cursor);
    expect(() => decodeShippingAddressCursor(encodeShippingAddressCursor(cursor), P.other)).toThrow();
    for (const raw of [P.invalid, P.blank, encodeShippingAddressCursor(cursor) + P.hashUnit]) expect(() => decodeShippingAddressCursor(raw, P.user)).toThrow();
  });
  it('rejects repeated/boolean query values and excessive limits', () => {
    expect(query.parse({})).toEqual({limit: S.pagination.default});
    expect(query.parse({limit: String(S.pagination.maximum)}).limit).toBe(S.pagination.maximum);
    for (const limit of [true, [S.pagination.default], S.version.absent, S.pagination.maximum + P.excess, P.blank, P.invalid])
      expect(query.safeParse({limit}).success).toBe(false);
  });
});

import {z} from 'zod';
import {shippingAddressSchema} from '../../../shared/domain/shipping-address';

export const SHIPPING_ADDRESSES = {
  token: Symbol('SHIPPING_ADDRESSES_REPOSITORY'),
  route: {root: 'me/shipping-addresses', countries: 'countries', user: ':userId', address: ':userId/addresses/:addressId',
    change: ':userId/changes/:requestId', userParameter: 'userId', addressParameter: 'addressId', requestParameter: 'requestId'},
  action: {save: 'save', delete: 'delete', setDefault: 'set_default'},
  version: {absent: 0, initial: 1, step: 1, maximum: 2147483647},
  pagination: {default: 20, maximum: 100, extra: 1, cursorMaximumLength: 512, cursorEncoding: 'base64url', limitPattern: /^[1-9][0-9]*$/},
  digest: {algorithm: 'sha256', encoding: 'hex', pattern: '^[a-f0-9]{64}$'},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  persistence: {one: 1, lock: 'update', statuses: ['active', 'onboarding']},
  failure: {
    invalid: {code: 'shipping_addresses_invalid', message: 'Invalid shipping address book request'},
    unavailable: {code: 'shipping_addresses_unavailable', message: 'Shipping addresses unavailable for this account'},
    missing: {code: 'shipping_address_not_found', message: 'Shipping address not found'},
    changed: {code: 'shipping_addresses_changed', message: 'The shipping address book changed; reload before continuing'},
    reused: {code: 'shipping_address_request_changed', message: 'This request identifies a different address book change'},
    persisted: {code: 'shipping_addresses_invalid_response', message: 'The shipping address book could not be verified'},
  },
} as const;
const S = SHIPPING_ADDRESSES;
export const shippingAddressIdentifierSchema = z.uuid().transform(value => value.toLowerCase());
const expectedVersion = z.number().int().min(S.version.absent).max(S.version.maximum - S.version.step);
const version = z.number().int().min(S.version.absent).max(S.version.maximum);
const addressId = shippingAddressIdentifierSchema;
export const shippingAddressChangeSchema = z.discriminatedUnion('action', [
  z.object({expectedVersion, action: z.literal(S.action.save), addressId, shippingAddress: shippingAddressSchema, makeDefault: z.boolean()}).strict(),
  z.object({expectedVersion, action: z.literal(S.action.delete), addressId}).strict(),
  z.object({expectedVersion, action: z.literal(S.action.setDefault), addressId: addressId.nullable()}).strict(),
]);
export const shippingAddressItemSchema = z.object({id: addressId, shippingAddress: shippingAddressSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()}).strict();
export const shippingAddressReceiptSchema = z.object({requestId: shippingAddressIdentifierSchema,
  action: z.enum([S.action.save, S.action.delete, S.action.setDefault]),
  version: version.min(S.version.initial), addressId: addressId.nullable()}).strict()
  .refine(value => value.action === S.action.setDefault || value.addressId !== null);
export const shippingAddressPageSchema = z.object({userId: shippingAddressIdentifierSchema, version,
  defaultAddressId: addressId.nullable(), items: z.array(shippingAddressItemSchema), nextCursor: z.string().nullable()}).strict()
  .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length
    && (value.version !== S.version.absent || value.items.length === S.version.absent && value.defaultAddressId === null && value.nextCursor === null));
export const shippingAddressListQuerySchema = z.object({
  limit: z.union([z.number(), z.string().regex(S.pagination.limitPattern)])
    .transform(value => Number(value)).pipe(z.number().int().min(S.persistence.one).max(S.pagination.maximum)).default(S.pagination.default),
  cursor: z.string().min(S.persistence.one).max(S.pagination.cursorMaximumLength).optional(),
}).strict();
export const shippingAddressCursorSchema = z.object({userId: shippingAddressIdentifierSchema,
  version: version.min(S.version.initial), afterId: addressId}).strict();
export type ShippingAddressChange = z.infer<typeof shippingAddressChangeSchema>;
export type ShippingAddressItem = z.infer<typeof shippingAddressItemSchema>;
export type ShippingAddressReceipt = z.infer<typeof shippingAddressReceiptSchema>;
export type ShippingAddressPage = z.infer<typeof shippingAddressPageSchema>;
export type ShippingAddressCursor = z.infer<typeof shippingAddressCursorSchema>;
export interface ShippingAddressListInput {limit: number; cursor?: ShippingAddressCursor;}
export interface ShippingAddressesRepository {
  list(userId: string, input: ShippingAddressListInput): Promise<ShippingAddressPage>;
  find(userId: string, addressId: string): Promise<ShippingAddressItem>;
  change(userId: string, requestId: string): Promise<{receipt: ShippingAddressReceipt | null}>;
  apply(userId: string, requestId: string, command: ShippingAddressChange): Promise<ShippingAddressReceipt>;
}

import {z} from 'zod';
import {shippingCountrySchema} from '../../brands/commerce-policy';
const ADDRESS_LIMIT = {minimum: 1, fullName: 160, line: 200, postalCode: 32, city: 120, phone: 40} as const;
export const shippingAddressSchema = z.object({
  fullName: z.string().trim().min(ADDRESS_LIMIT.minimum).max(ADDRESS_LIMIT.fullName),
  line1: z.string().trim().min(ADDRESS_LIMIT.minimum).max(ADDRESS_LIMIT.line),
  line2: z.string().trim().max(ADDRESS_LIMIT.line).optional(),
  postalCode: z.string().trim().min(ADDRESS_LIMIT.minimum).max(ADDRESS_LIMIT.postalCode),
  city: z.string().trim().min(ADDRESS_LIMIT.minimum).max(ADDRESS_LIMIT.city),
  country: shippingCountrySchema,
  phone: z.string().trim().max(ADDRESS_LIMIT.phone).optional(),
}).strict();
export type ShippingAddressSnapshot = z.infer<typeof shippingAddressSchema>;

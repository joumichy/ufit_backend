import {z} from 'zod';
import {shippingAddressSchema} from './shipping-address';
import {shippingCountrySchema} from '../../brands/commerce-policy';

export const CHECKOUT_REQUEST = {
  route: {outcome: 'checkout-requests/:requestId', requestId: 'requestId', review: 'checkout-review'},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  fingerprint: {algorithm: 'sha256', encoding: 'hex', pattern: /^[a-f0-9]{64}$/},
  failure: {
    input: {code: 'checkout_input_invalid', message: 'Invalid checkout request'},
    changed: {code: 'checkout_quote_changed', message: 'Review the updated order total before payment'},
    reused: {code: 'checkout_request_conflict', message: 'Checkout request was already used for another purchase'},
    outcome: {code: 'checkout_recovery_invalid', message: 'The checkout outcome could not be verified'},
  },
} as const;

const requestId = z.uuid().toLowerCase();
export const checkoutRequestSchema = z.object({
  requestId, quoteFingerprint: z.string().regex(CHECKOUT_REQUEST.fingerprint.pattern),
  shippingAddress: shippingAddressSchema,
}).strict();

export const checkoutOutcomeSchema = z.object({requestId, orderId: z.uuid().toLowerCase().nullable()}).strict();
export const checkoutReviewRequestSchema = z.object({country: shippingCountrySchema}).strict();

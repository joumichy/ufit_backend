import {CURRENCY_CODES} from '../../../shared/domain/currencies';

// Stripe's wire units differ from Ufit accounting units for these currencies. Conversion is exact:
// never round a charge, refund, fee or recipient's balance at an adapter boundary.
// https://docs.stripe.com/currencies#special-cases
const UNITS = {
  zero: 0, one: 1, hundred: 100,
  maximum: Number.MAX_SAFE_INTEGER,
  scaledUp: ['ISK', 'UGX'],
  invalid: 'Stripe amount cannot be represented in the currency accounting units',
} as const;
export class StripeAmountError extends Error {
  constructor() { super(UNITS.invalid); }
}
function wireScale(currency: string): number {
  if (!CURRENCY_CODES.includes(currency)) throw new StripeAmountError();
  return UNITS.scaledUp.some(code => code === currency) ? UNITS.hundred : UNITS.one;
}
function exact(amount: number, numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(amount)) throw new StripeAmountError();
  const scaled = BigInt(amount) * BigInt(numerator), divisor = BigInt(denominator);
  if (scaled % divisor !== BigInt(UNITS.zero)) throw new StripeAmountError();
  const result = scaled / divisor;
  if (result > BigInt(UNITS.maximum) || result < -BigInt(UNITS.maximum)) throw new StripeAmountError();
  return Number(result);
}
export function toStripeAmount(amount: number, currency: string): number {
  return exact(amount, wireScale(currency), UNITS.one);
}
/** Invalid provider amounts stay invalid input for the caller's existing schema. */
export function fromStripeAmount(amount: unknown, currency: unknown): number | undefined {
  if (typeof amount !== 'number' || typeof currency !== 'string') return undefined;
  try {
    return exact(amount, UNITS.one, wireScale(currency.toUpperCase()));
  } catch { return undefined; }
}

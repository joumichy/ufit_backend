import Stripe from 'stripe';
import { getEnv } from '../../../config/env';
import { STRIPE_CLIENT, type StripePaymentsClient } from '../application/payments.service';

export const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  useFactory: (): StripePaymentsClient | null => {
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY) return null;
    return new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-04-22.dahlia'
    }) as unknown as StripePaymentsClient;
  }
};

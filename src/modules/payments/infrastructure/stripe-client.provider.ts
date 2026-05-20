import Stripe from 'stripe';
import { getEnv } from '../../../config/env';
import { STRIPE_CLIENT, type StripeCheckoutClient } from '../application/payments.service';

export const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  useFactory: (): StripeCheckoutClient => {
    const env = getEnv();
    return new Stripe(env.STRIPE_SECRET_KEY ?? 'sk_test_not_configured', {
      apiVersion: '2026-04-22.dahlia'
    }) as unknown as StripeCheckoutClient;
  }
};

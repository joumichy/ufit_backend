import {describe, expect, it} from 'vitest';
import {CUSTOMER_PAYMENT as C, customerPaymentSessionSchema, customerPaymentStatusSchema} from '../../src/modules/payments/domain/customer-payment';
import {customerPaymentDocument, readCustomerPaymentIntent} from '../../src/modules/payments/infrastructure/customer-payment-status';
import {CUSTOMER_INTENT_FIXTURE as F, customerOrder, customerIntent} from './customer-payment.fixture';

describe('owned customer payment facts', () => {
  it.each([
    [C.provider.method, C.state.ready], [C.provider.confirmation, C.state.ready], [C.provider.action, C.state.action],
    [C.provider.processing, C.state.processing], [C.provider.succeeded, C.state.confirming],
    [C.provider.cancelled, C.state.closed], [C.provider.capture, C.state.review],
  ])('projects %s without treating the order as paid', (status, state) => {
    const result = readCustomerPaymentIntent(customerOrder(), customerIntent(customerOrder(), status), false);
    expect(result.payment.state).toBe(state);
    expect(result.payment.orderStatus).toBe('pending_payment');
    expect(result.payment.liveMode).toBe(false);
  });
  it('distinguishes an explicitly failed attempt from an untouched collection', () => {
    const intent = {...customerIntent(), last_payment_error: F.error};
    expect(readCustomerPaymentIntent(customerOrder(), intent, false).payment.state).toBe(C.state.failed);
  });
  it('holds partial funding and manual confirmation away from a new client confirmation', () => {
    for (const intent of [{...customerIntent(), amount_received: C.limits.one},
      {...customerIntent(), confirmation_method: C.provider.manual}, {...customerIntent(), capture_method: C.provider.manual}]) {
      expect(readCustomerPaymentIntent(customerOrder(), intent, false).payment.state).toBe(C.state.review);
    }
  });
  it('rejects the wrong order, amount, currency, intent, mode, incomplete capture and missing canonical fields', () => {
    const valid = customerIntent(), {amount_received: omitted, ...incomplete} = valid;
    for (const raw of [{...valid, metadata: {}}, {...valid, amount: valid.amount + C.limits.one},
      {...valid, currency: 'usd'}, {...valid, livemode: true}, {...valid, status: C.provider.succeeded}, incomplete]) {
      expect(() => readCustomerPaymentIntent(customerOrder(), raw, false)).toThrow();
    }
    expect(() => readCustomerPaymentIntent({...customerOrder(), stripePaymentIntentId: 'pi_other'}, valid, false)).toThrow();
  });
  it('allows an explicit unstarted payment and local terminal order without inventing provider data', () => {
    expect(customerPaymentDocument(customerOrder(), C.state.notStarted, null).paymentIntentId).toBeNull();
    expect(customerPaymentDocument({...customerOrder(), status: 'paid'}, C.state.orderUpdated, null).state).toBe(C.state.orderUpdated);
    expect(() => customerPaymentDocument(customerOrder(), C.state.processing, null)).toThrow();
  });
  it('requires a matching secret only for a resumable session; reads expose no secret', () => {
    const result = readCustomerPaymentIntent(customerOrder(), customerIntent(), false);
    expect(customerPaymentSessionSchema.parse(result).clientSecret).toBe(F.secret);
    for (const secret of [null, 'other_secret']) expect(customerPaymentSessionSchema.safeParse({...result, clientSecret: secret}).success).toBe(false);
    for (const state of [C.state.processing, C.state.confirming, C.state.closed, C.state.review]) {
      const payment = {...result.payment, state};
      expect(customerPaymentSessionSchema.safeParse({payment, clientSecret: F.secret}).success).toBe(false);
      expect(customerPaymentSessionSchema.safeParse({payment, clientSecret: null}).success).toBe(true);
    }
    expect(customerPaymentStatusSchema.safeParse({...result.payment, clientSecret: F.secret}).success).toBe(false);
  });
});

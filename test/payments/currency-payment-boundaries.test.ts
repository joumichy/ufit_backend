import {describe, expect, it, vi} from 'vitest';
import {fromStripeAmount, toStripeAmount} from '../../src/modules/payments/infrastructure/stripe-amount';
import {readCustomerPaymentIntent} from '../../src/modules/payments/infrastructure/customer-payment-status';
import {PaymentsService} from '../../src/modules/payments/application/payments.service';
import {STRIPE_COMMERCE} from '../../src/modules/payments/application/stripe-commerce';
import {CANCELLATION} from '../../src/modules/orders/domain/order-lifecycle';
import {refundStripeReturn} from '../../src/modules/payments/infrastructure/stripe-order-return';
import {reverseStripeCancellation} from '../../src/modules/payments/infrastructure/stripe-order-cancellation';
import {readStripePaymentSettlement} from '../../src/modules/payments/infrastructure/stripe-payment-settlement';
import {readStripeRefundSettlement} from '../../src/modules/payments/infrastructure/stripe-refund-settlement';
import {projectTransfer, projectReversal} from '../../src/modules/payments/infrastructure/stripe-transfer-reconciliation';
import {executeStripeTransfer} from '../../src/modules/payments/infrastructure/stripe-transfer';
import {executeStripeTransferReversal} from '../../src/modules/payments/infrastructure/stripe-transfer-reversal';
import {customerOrder, customerIntent} from './customer-payment.fixture';
import {transferFixture, stripeFixture, providerTransfer, providerReversal, reversalFixture, F} from './payment-transfer.fixtures';

vi.mock('../../src/config/env', () => ({getEnv: () => ({
  STRIPE_SECRET_KEY: 'sk_test_currency_contract_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_currency_contract_fixture',
})}));
const CASES = [
  {currency:'ISK', minor:5000, wire:500000},
  {currency:'UGX', minor:5000, wire:500000},
  {currency:'MGA', minor:5000, wire:5000},
  {currency:'HUF', minor:5000, wire:5000},
  {currency:'COP', minor:5000, wire:5000},
  {currency:'JPY', minor:5000, wire:5000},
  {currency:'CHF', minor:5000, wire:5000},
  {currency:'BHD', minor:5000, wire:5000},
] as const;
const TEST = {zero:0, one:1, event:'evt_CurrencyAccounting', signature:'contract-signature', payload:'contract-payload',
  refund:'re_CurrencyAccounting', partial:2000, partialWireISK:200000, partialWireMGA:2000, fractionalMinor:5000.5,
  providerSeconds:1793923200, largestAmount:2147483647, largestWireISK:214748364700} as const;
function context(currency: string, minor: number, wire: number) {
  const order = {...customerOrder(), currency, totalAmount:minor, shippingAmount:TEST.zero};
  const intent = {...customerIntent(order), amount:wire};
  const stripe = {paymentIntents:{create:vi.fn().mockResolvedValue(intent),retrieve:vi.fn().mockResolvedValue(intent)},
    webhooks:{constructEvent:vi.fn()}, refunds:{}};
  const finalizer = {confirm:vi.fn().mockResolvedValue({duplicate:false,reversalRequired:false})};
  const orders = {getForCustomer:vi.fn().mockResolvedValue(order),attachPaymentIntent:vi.fn()};
  const service = new PaymentsService(stripe as never,finalizer,orders as never,{} as never,
    {assertSaleRecipients:vi.fn()} as never,{} as never,{assertOrderTerms:vi.fn()} as never,{} as never);
  return {order,intent,stripe,finalizer,orders,service};
}
describe('Currency accounting versus Stripe transport units',()=>{
  it.each(CASES)('encodes and decodes $currency without a display-precision assumption',({currency,minor,wire})=>{
    expect(toStripeAmount(minor,currency)).toBe(wire);
    expect(fromStripeAmount(wire,currency.toLowerCase())).toBe(minor);
    expect(fromStripeAmount(-wire,currency.toLowerCase())).toBe(-minor);
  });
  it('rejects inexact units, unsafe values and unknown currencies instead of rounding',()=>{
    expect(()=>toStripeAmount(TEST.fractionalMinor,'MGA')).toThrow();
    expect(fromStripeAmount(TEST.one,'isk')).toBeUndefined();
    expect(fromStripeAmount(TEST.one,'ugx')).toBeUndefined();
    expect(fromStripeAmount(TEST.fractionalMinor,'mga')).toBeUndefined();
    expect(()=>toStripeAmount(Number.MAX_SAFE_INTEGER,'ISK')).toThrow();
    expect(()=>toStripeAmount(TEST.one,'XXX')).toThrow();
    expect(fromStripeAmount(TEST.one,'XXX')).toBeUndefined();
    expect(fromStripeAmount(String(TEST.one),'CHF')).toBeUndefined();
  });
  it('accepts a safe provider wire amount above the domain integer cap after exact normalization',()=>{
    const s=context('ISK',TEST.largestAmount,TEST.largestWireISK);
    expect(readCustomerPaymentIntent(s.order,s.intent,false).payment.amount).toBe(TEST.largestAmount);
  });
  it.each(CASES)('creates $currency at the exact wire amount and returns canonical accounting units',async({currency,minor,wire})=>{
    const s=context(currency,minor,wire), result=await s.service.createPaymentIntent(s.order);
    expect(s.stripe.paymentIntents.create).toHaveBeenCalledWith({amount:wire,currency:currency.toLowerCase(),
      payment_method_types:['card'],metadata:{order_id:s.order.id},transfer_group:'order:'+s.order.id},
    {idempotencyKey:'payment-intent:'+s.order.id});
    expect(result.payment).toMatchObject({amount:minor,currency,state:'ready'});
    expect(s.finalizer.confirm).not.toHaveBeenCalled();
  });
  it.each(CASES)('normalizes a signed $currency webhook before the fulfillment boundary',async({currency,minor,wire})=>{
    const s=context(currency,minor,wire);
    s.stripe.webhooks.constructEvent.mockReturnValue({id:TEST.event,type:'payment_intent.succeeded',
      data:{object:{...s.intent,amount_received:wire,status:'succeeded'}}});
    await s.service.handleStripeWebhook(TEST.payload,TEST.signature);
    expect(s.finalizer.confirm).toHaveBeenCalledWith({eventId:TEST.event,orderId:s.order.id,
      paymentIntentId:s.intent.id,amount:minor,currency});
  });
  it('rejects provider fractions before fulfillment and unchargeable MGA precision before provider calls',async()=>{
    const s=context('ISK',TEST.one,TEST.one);
    s.stripe.webhooks.constructEvent.mockReturnValue({id:TEST.event,type:'payment_intent.succeeded',
      data:{object:{...s.intent,amount_received:TEST.one,status:'succeeded'}}});
    await expect(s.service.handleStripeWebhook(TEST.payload,TEST.signature)).rejects.toThrow();
    expect(s.finalizer.confirm).not.toHaveBeenCalled();
    const m=context('MGA',TEST.fractionalMinor,TEST.one);
    await expect(m.service.createPaymentIntent(m.order)).rejects.toMatchObject({response:STRIPE_COMMERCE.amountUnrepresentable});
    expect(m.stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(m.orders.attachPaymentIntent).not.toHaveBeenCalled();
  });
});

describe('Refund wire units and canonical recovery comparisons',()=>{
  it.each(CASES.filter(c=>['ISK','UGX','MGA'].includes(c.currency)))('returns and cancels $currency without multiplying a refund twice',async({currency,minor,wire})=>{
    const s=context(currency,minor,wire), partialWire=currency==='MGA'?TEST.partialWireMGA:TEST.partialWireISK;
    const metadata={order_id:s.order.id,return_id:F.id.other,return_refund_attempt_id:F.id.operation};
    s.stripe.paymentIntents.retrieve.mockResolvedValue({...s.intent,amount_received:wire,status:'succeeded'});
    const refund={id:TEST.refund,payment_intent:s.intent.id,amount:partialWire,currency:currency.toLowerCase(),status:'succeeded',metadata};
    const stripe={...s.stripe,refunds:{list:vi.fn().mockResolvedValue({data:[],has_more:false}),
      create:vi.fn().mockResolvedValue(refund),retrieve:vi.fn().mockResolvedValue(refund)}};
    const claim={returnId:F.id.other,orderId:s.order.id,attemptId:F.id.operation,paymentIntentId:s.intent.id,
      originalAmount:minor,amount:TEST.partial,currency,refundId:null};
    expect((await refundStripeReturn(stripe as never,claim)).state).toBe('succeeded');
    expect(stripe.refunds.create).toHaveBeenCalledWith({payment_intent:s.intent.id,amount:partialWire,
      reason:'requested_by_customer',metadata},{idempotencyKey:'return-refund:'+F.id.operation});
    // Recovery reads the exact provider result, without a second refund creation.
    stripe.refunds.create.mockClear();
    await refundStripeReturn(stripe as never,{...claim,refundId:TEST.refund});
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    const cancellationMetadata={order_id:s.order.id,cancellation_id:F.id.other,cancellation_refund_attempt_id:F.id.operation};
    stripe.refunds.create.mockResolvedValue({...refund,amount:wire,metadata:cancellationMetadata});
    const attempt={id:F.id.operation,cancellationId:F.id.other,attemptNumber:TEST.one,amount:minor,currency,
      paymentIntentId:s.intent.id,refundId:null,state:'queued' as const,providerStatus:null};
    const result=await reverseStripeCancellation(stripe as never,{id:F.id.other,orderId:s.order.id,originalStatus:'paid',
      reason:CANCELLATION.reason.customer,status:'requested',amount:minor,currency,paymentIntentId:s.intent.id,refund:null},async()=>attempt);
    expect(result.refund?.result.state).toBe('succeeded');
    expect(stripe.refunds.create).toHaveBeenCalledWith({payment_intent:s.intent.id,amount:wire,
      reason:'requested_by_customer',metadata:cancellationMetadata},{idempotencyKey:'cancel-refund:'+F.id.operation});
  });
});

describe('Capture and refund settlement normalization',()=>{
  it.each(CASES.filter(c=>['ISK','UGX','MGA'].includes(c.currency)))('keeps $currency presentment separate from actual USD settlement',async({currency,minor,wire})=>{
    const f=transferFixture(), sdk=stripeFixture(f.instruction), capture={...f.capture,chargeCurrency:currency,chargeAmount:minor};
    Object.assign(sdk.state.charge,{currency:currency.toLowerCase(),amount:wire,amount_captured:wire});
    const intent={id:F.provider.intent,metadata:{order_id:F.id.order},status:'succeeded',amount_received:wire,
      currency:currency.toLowerCase(),livemode:false,latest_charge:sdk.state.charge};
    const result=await readStripePaymentSettlement({paymentIntents:{retrieve:vi.fn().mockResolvedValue(intent)}} as never,
      {id:F.id.payment,orderId:F.id.order,orderNumber:F.id.order,status:'succeeded',createdAt:F.date.capture,
        providerPaymentIntentId:F.provider.intent,amount:minor,currency},false);
    expect(result).toMatchObject({kind:'receipt',receipt:{chargeAmount:minor,chargeCurrency:currency,
      settlementAmount:13200,settlementCurrency:'USD',feeAmount:350,netAmount:12850}});
    const partialWire=currency==='MGA'?TEST.partialWireMGA:TEST.partialWireISK;
    sdk.state.charge.amount_refunded=partialWire;
    sdk.state.refunds=[{id:TEST.refund,object:'refund',amount:partialWire,currency:currency.toLowerCase(),
      charge:F.provider.charge,payment_intent:F.provider.intent,status:'succeeded',created:TEST.providerSeconds,
      balance_transaction:null}];
    const refunds=await readStripeRefundSettlement(sdk.client,{paymentId:F.id.payment,orderId:F.id.order,
      paymentIntentId:F.provider.intent,capture},false);
    expect(refunds).toMatchObject({kind:'observed',snapshot:{amountRefunded:TEST.partial,
      items:[{amount:TEST.partial,currency,debit:null,failure:null}]}});
  });
  it('normalizes transfer and reversal receipts before comparing durable operation amounts',()=>{
    const f=transferFixture(), instruction={...f.instruction,currency:'ISK'};
    const raw=providerTransfer(instruction);
    expect(projectTransfer({...raw,amount:120000,amount_reversed:20000},instruction)).toMatchObject({amount:1200,reversedAmount:200,currency:'ISK'});
    expect(projectTransfer({...raw,amount:1200},instruction)).toBeUndefined();
    const reversal=reversalFixture(instruction), rawReversal=providerReversal(reversal);
    expect(projectReversal({...rawReversal,amount:20000},reversal)).toMatchObject({amount:200,currency:'ISK'});
    expect(projectReversal({...rawReversal,amount:20100},reversal)).toBeUndefined();
  });
  it('sends scaled transfer and reversal amounts only after the normal authorization and source checks',async()=>{
    const {instruction}=transferFixture();
    instruction.currency='ISK';
    instruction.capture.settlementCurrency='ISK';
    instruction.refunds.source.capture.settlementCurrency='ISK';
    const sdk=stripeFixture(instruction);
    Object.assign(sdk.state.charge.balance_transaction,{amount:1320000,fee:35000,net:1285000});
    sdk.state.transfer.amount=120000;
    sdk.state.reversal.amount=20000;
    const create=vi.fn().mockResolvedValue(sdk.state.transfer);
    const reverse=vi.fn().mockResolvedValue(sdk.state.reversal);
    sdk.client.transfers.create=create as never;
    sdk.client.transfers.createReversal=reverse as never;
    const result=await executeStripeTransfer(sdk.client,instruction,false,null,sdk.authorize);
    expect(result).toMatchObject({kind:'recorded',snapshot:{amount:1200,currency:'ISK'}});
    expect(create).toHaveBeenCalledWith(expect.objectContaining({amount:120000,currency:'isk'}),
      expect.objectContaining({idempotencyKey:'ufit-transfer:'+instruction.id}));
    expect(sdk.methods()).toContain(F.calls.authorize);
    const reversed=await executeStripeTransferReversal(sdk.client,reversalFixture(instruction),false,null,sdk.authorize);
    expect(reversed).toMatchObject({kind:'recorded',snapshot:{amount:200,currency:'ISK'}});
    expect(reverse).toHaveBeenCalledWith(F.provider.transfer,expect.objectContaining({amount:20000}),
      expect.objectContaining({idempotencyKey:'ufit-transfer-reversal:'+F.id.reversal}));
  });
});

import {describe, expect, it} from 'vitest';
import {allocateReturnRefund, assertSameRefundAmounts, returnDeadline, returnedCommissionAmount, type ReturnOrderAmounts, type ReturnOrderItem, type ReturnQuantity} from '../../src/modules/orders/domain/return-refund-policy';
import {createOrderReturnSchema, orderReturnActionSchema} from '../../src/modules/orders/domain/order-return.contract';
import {shipmentActionSchema} from '../../src/modules/shipping/domain/shipping.contract';

const fixture = {
  first: '733e512c-d506-41e5-a1a3-826614104cef', second: '59949b72-7505-4eea-84b8-c9048ef2d392',
  request: '2cb196e7-bdf5-4ff4-a5ea-614d19c8b178', foreign: '4f5fb691-cb69-4d1b-94dc-f1d26009acaf',
  reason: 'La taille ne convient pas.', instructions: 'Renvoyer les pièces dans leur emballage.', carrier: 'La Poste', tracking: 'UFITRETURN',
  delivered: new Date('2026-11-01T10:00:00.000Z'), deadline: new Date('2026-12-01T10:00:00.000Z'),
};
function order(): {amounts: ReturnOrderAmounts; items: ReturnOrderItem[]} {
  return {amounts: {subtotalAmount: 300, taxAmount: 25, shippingAmount: 80, totalAmount: 405},
    items: [{id: fixture.first, quantity: 3, unitPrice: 100, totalPrice: 300}]};
}
describe('Order return contracts', () => {
  it('accepts only owned line references and quantities as inputs, never client money or status', () => {
    const input = {requestId: fixture.request, reason: fixture.reason, quoteFingerprint: 'a'.repeat(64), items: [{orderItemId: fixture.first, quantity: 1}]};
    expect(createOrderReturnSchema.parse(input)).toEqual(input);
    expect(createOrderReturnSchema.parse({...input,requestId:fixture.request.toUpperCase(),items:[{orderItemId:fixture.first.toUpperCase(),quantity:1}]})).toEqual(input);
    for (const invalid of [{...input, refundAmount: 405}, {...input, status: 'refunded'}, {...input, brandId: fixture.foreign}, {...input, requestId: undefined}, {...input, reason: ' '}, {...input, items: []}, {...input, items: [input.items[0], input.items[0]]}, {...input, items: [{orderItemId: fixture.first, quantity: 1.5}]}, {...input, items: [{orderItemId: fixture.first, quantity: 0}]}]) {
      expect(createOrderReturnSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('requires version, the action-specific explanation, instructions and explicit restock quantity', () => {
    for (const input of [{action: 'approve', expectedVersion: 1, instructions: fixture.instructions}, {action: 'reject', expectedVersion: 1, reason: fixture.reason}, {action: 'dispute', expectedVersion: 1, reason: fixture.reason}, {action: 'withdraw', expectedVersion: 1}, {action: 'receive', expectedVersion: 1, items: [{orderItemId: fixture.first, restockQuantity: 0}]}, {action: 'arbitrate_approve', expectedVersion: 1, reason: fixture.reason, instructions: fixture.instructions}]) {
      expect(orderReturnActionSchema.safeParse(input).success).toBe(true);
    }
    for (const input of [{action: 'approve', expectedVersion: 1}, {action: 'reject', expectedVersion: 1}, {action: 'receive', expectedVersion: 1}, {action: 'receive', expectedVersion: 1, items: [{orderItemId: fixture.first}]}, {action: 'receive', expectedVersion: 1, items: [{orderItemId: fixture.first, restockQuantity: -1}]}, {action: 'withdraw', expectedVersion: 0}, {action: 'withdraw', expectedVersion: 1, amount: 5}, {action: 'arbitrate_reject', expectedVersion: 1, reason: ' '}]) {
      expect(orderReturnActionSchema.safeParse(input).success).toBe(false);
    }
  });
  it('shares the shipment parcel contract, including uppercase HTTPS and optional link removal', () => {
    const input = {action: 'send', expectedVersion: 1, carrier: fixture.carrier, trackingNumber: fixture.tracking};
    expect(orderReturnActionSchema.safeParse(input).success).toBe(true);
    expect(orderReturnActionSchema.safeParse({...input, trackingUrl: 'HTTPS://example.test/return'}).success).toBe(true);
    expect(orderReturnActionSchema.safeParse({...input, trackingUrl: null}).success).toBe(true);
    for (const invalid of [{...input, carrier: ' '}, {...input, trackingNumber: undefined}, {...input, trackingUrl: 'http://example.test/return'}, {...input, trackingUrl: 'https://'}]) {
      expect(orderReturnActionSchema.safeParse(invalid).success).toBe(false);
      expect(shipmentActionSchema.safeParse({...invalid, action: 'ship'}).success).toBe(false);
    }
  });
});
describe('Frozen return amounts', () => {
  it('refunds integer units, allocates tax cumulatively and includes shipping only on the final units', () => {
    const {amounts, items} = order();
    const first = allocateReturnRefund(amounts, items, [], [{orderItemId: fixture.first, quantity: 1}]);
    const second = allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 1}], [{orderItemId: fixture.first, quantity: 1}]);
    const last = allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 2}], [{orderItemId: fixture.first, quantity: 1}]);
    expect(first).toEqual({refundPolicyCode: 'proportional_tax_full_shipping_v1', merchandiseAmount: 100, taxAmount: 8, shippingAmount: 0, totalAmount: 108, completesOrder: false});
    expect(second).toMatchObject({taxAmount: 8, shippingAmount: 0, totalAmount: 108, completesOrder: false});
    expect(last).toMatchObject({taxAmount: 9, shippingAmount: 80, totalAmount: 189, completesOrder: true});
    expect(first.totalAmount + second.totalAmount + last.totalAmount).toBe(amounts.totalAmount);
    expect(() => assertSameRefundAmounts(first, {...first, totalAmount:first.totalAmount+1})).toThrow();
    expect(() => assertSameRefundAmounts(first, {...first, completesOrder:true})).toThrow();
    expect(allocateReturnRefund(amounts, items, [], [{orderItemId: fixture.first, quantity: 3}]).totalAmount).toBe(amounts.totalAmount);
  });
  it('handles distinct prices and multiple lines while conserving total refunded money', () => {
    const items = [{id: fixture.first, quantity: 2, unitPrice: 1555, totalPrice: 3110}, {id: fixture.second, quantity: 1, unitPrice: 1, totalPrice: 1}];
    const amounts = {subtotalAmount: 3111, taxAmount: 311, shippingAmount: 1500, totalAmount: 4922};
    const previous = [{orderItemId: fixture.first, quantity: 1}];
    const first = allocateReturnRefund(amounts, items, [], previous);
    const last = allocateReturnRefund(amounts, items, previous, [{orderItemId: fixture.second, quantity: 1}, {orderItemId: fixture.first, quantity: 1}]);
    expect(first).toMatchObject({merchandiseAmount: 1555, taxAmount: 155, shippingAmount: 0});
    expect(last).toMatchObject({merchandiseAmount: 1556, taxAmount: 156, shippingAmount: 1500});
    expect(first.totalAmount + last.totalAmount).toBe(4922);
  });
  it('rejects foreign, duplicate, empty and already returned quantities without allocating money', () => {
    const {amounts, items} = order();
    for (const selected of [[], [{orderItemId: fixture.foreign, quantity: 1}], [{orderItemId: fixture.first, quantity: 4}], [{orderItemId: fixture.first, quantity: 1}, {orderItemId: fixture.first, quantity: 1}]]) expect(() => allocateReturnRefund(amounts, items, [], selected)).toThrow();
    expect(() => allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 2}], [{orderItemId: fixture.first, quantity: 2}])).toThrow();
    expect(() => allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 3}], [{orderItemId: fixture.first, quantity: 1}])).toThrow();
  });
  it('rejects incoherent persisted prices, totals and prior quantities instead of synthesizing amounts', () => {
    const {amounts, items} = order();
    for (const broken of [{...amounts, totalAmount: 406}, {...amounts, subtotalAmount: -1}, {...amounts, taxAmount: Number.NaN}]) expect(() => allocateReturnRefund(broken, items, [], [{orderItemId: fixture.first, quantity: 1}])).toThrow();
    expect(() => allocateReturnRefund(amounts, [{...items[0], unitPrice: 101}], [], [{orderItemId: fixture.first, quantity: 1}])).toThrow();
    expect(() => allocateReturnRefund(amounts, items, [{orderItemId: fixture.foreign, quantity: 1}], [{orderItemId: fixture.first, quantity: 1}])).toThrow();
    expect(() => allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 4}], [{orderItemId: fixture.first, quantity: 1}])).toThrow();
  });
  it('supports free merchandise without dividing by zero or inventing a positive partial refund', () => {
    const amounts = {subtotalAmount: 0, shippingAmount: 80, taxAmount: 0, totalAmount: 80};
    const items = [{id: fixture.first, quantity: 2, unitPrice: 0, totalPrice: 0}];
    expect(allocateReturnRefund(amounts, items, [], [{orderItemId: fixture.first, quantity: 1}])).toMatchObject({totalAmount: 0, completesOrder: false});
    expect(allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 1}], [{orderItemId: fixture.first, quantity: 1}])).toMatchObject({totalAmount: 80, completesOrder: true});
  });
  it('conserves every minor unit across all partitions of small orders and quantity sequences', () => {
    for (let count = 1; count <= 9; count++) for (const price of [0, 1, 99, 1234]) for (const tax of [0, 1, 8, 97]) {
      const items = [{id: fixture.first, quantity: count, unitPrice: price, totalPrice: price * count}];
      const amounts = {subtotalAmount: price * count, shippingAmount: 77, taxAmount: tax, totalAmount: price * count + tax + 77};
      let sum = 0; const previous: ReturnQuantity[] = [];
      for (let i = 0; i < count; i++) {
        const result = allocateReturnRefund(amounts, items, previous, [{orderItemId: fixture.first, quantity: 1}]);
        expect(result.totalAmount).toBeGreaterThanOrEqual(0); sum += result.totalAmount;
        if (previous.length) previous[0].quantity++; else previous.push({orderItemId: fixture.first, quantity: 1});
      }
      expect(sum).toBe(amounts.totalAmount);
    }
  });
  it('uses exact integer arithmetic at the persistence amount limit', () => {
    const items = [{id: fixture.first, quantity: 2, unitPrice: 1, totalPrice: 2}];
    const amounts = {subtotalAmount: 2, shippingAmount: 0, taxAmount: 2147483645, totalAmount: 2147483647};
    const first = allocateReturnRefund(amounts, items, [], [{orderItemId: fixture.first, quantity: 1}]);
    const last = allocateReturnRefund(amounts, items, [{orderItemId: fixture.first, quantity: 1}], [{orderItemId: fixture.first, quantity: 1}]);
    expect(first.totalAmount).toBe(1073741823); expect(last.totalAmount).toBe(1073741824);
  });
});
describe('Return eligibility and commission quantities', () => {
  it('uses delivery and the frozen whole-day window, including the exact deadline', () => {
    expect(returnDeadline('delivered', fixture.delivered, 30, fixture.delivered)).toEqual(fixture.deadline);
    expect(returnDeadline('delivered', fixture.delivered, 30, fixture.deadline)).toEqual(fixture.deadline);
    expect(() => returnDeadline('delivered', fixture.delivered, 30, new Date(fixture.deadline.getTime() + 1))).toThrow();
  });
  it('does not allow returns before delivery, on unknown dates, zero-day policy or future delivery', () => {
    for (const status of ['paid', 'shipped', 'refunded', 'cancelled'] as const) expect(() => returnDeadline(status, fixture.delivered, 30, fixture.delivered)).toThrow();
    expect(() => returnDeadline('delivered', null, 30, fixture.delivered)).toThrow();
    expect(() => returnDeadline('delivered', fixture.delivered, 0, fixture.delivered)).toThrow();
    expect(() => returnDeadline('delivered', fixture.delivered, 30, new Date(fixture.delivered.getTime() - 1))).toThrow();
    for (const days of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) expect(() => returnDeadline('delivered', fixture.delivered, days, fixture.delivered)).toThrow();
  });
  it('allocates commission adjustment cumulatively from the original amount without per-return drift', () => {
    expect(returnedCommissionAmount(25, 3, 0)).toBe(0);
    expect(returnedCommissionAmount(25, 3, 1)).toBe(8);
    expect(returnedCommissionAmount(25, 3, 2)).toBe(16);
    expect(returnedCommissionAmount(25, 3, 3)).toBe(25);
    for (const input of [[25, 3, 4], [25, 0, 0], [-1, 3, 1], [25, 3, -1], [25, 3, 0.5]]) expect(() => returnedCommissionAmount(input[0], input[1], input[2])).toThrow();
  });
});

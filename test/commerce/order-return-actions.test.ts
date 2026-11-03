import {describe, expect, it} from 'vitest';
import {applyReturnAction, returnActions, type OrderReturn} from '../../src/modules/orders/domain/order-return';
import {orderReturnActionSchema, type OrderReturnAction} from '../../src/modules/orders/domain/order-return.contract';

const fixture = {
  item: '733e512c-d506-41e5-a1a3-826614104cef', second: '59949b72-7505-4eea-84b8-c9048ef2d392',
  now: '2026-11-02T10:00:00.000Z', instructions: 'Renvoyez les pièces à l’adresse indiquée.', reason: 'La demande est justifiée.',
};
function document(): OrderReturn {
  return {id: 'return', orderId: 'order', brandId: 'brand', version: 1, status: 'requested', reason: 'La taille ne convient pas.',
    items: [{orderItemId: fixture.item, quantity: 2}, {orderItemId: fixture.second, quantity: 1}],
    amounts: {refundPolicyCode: 'proportional_tax_full_shipping_v1', merchandiseAmount: 300, taxAmount: 25, shippingAmount: 80, totalAmount: 405, completesOrder: true},
    requestedAt: '2026-11-01T10:00:00.000Z', deadline: '2026-12-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', refundedAt: null,
    brandDecision: null, dispute: null, adminDecision: null, tracking: null, reception: null};
}
function command(input: unknown): OrderReturnAction { return orderReturnActionSchema.parse(input); }
function approve() { return applyReturnAction(document(), 'brand', command({action: 'approve', expectedVersion: 1, instructions: fixture.instructions}), fixture.now); }
describe('Versioned return actions', () => {
  it('accepts with instructions, sends with tracking, then requires explicit receipt before refund pending', () => {
    const approved = approve();
    expect(approved).toMatchObject({version: 2, status: 'approved', brandDecision: {decision: 'approved', instructions: fixture.instructions, reason: null, at: fixture.now}, reception: null});
    const sent = applyReturnAction(approved, 'customer', command({action: 'send', expectedVersion: 2, carrier: 'La Poste', trackingNumber: 'RETURNQUAL'}), fixture.now);
    expect(sent).toMatchObject({version: 3, status: 'in_transit', tracking: {carrier: 'La Poste', trackingNumber: 'RETURNQUAL', trackingUrl: null}});
    const received = applyReturnAction(sent, 'brand', command({action: 'receive', expectedVersion: 3, items: [{orderItemId: fixture.item, restockQuantity: 1}, {orderItemId: fixture.second, restockQuantity: 0}]}), fixture.now);
    expect(received).toMatchObject({version: 4, status: 'refund_pending', reception: {items: [{orderItemId: fixture.item, restockQuantity: 1}, {orderItemId: fixture.second, restockQuantity: 0}]}});
    expect(received.amounts).toEqual(document().amounts);
    expect(returnActions(received, 'customer')).toEqual([]); expect(returnActions(received, 'brand')).toEqual([]);
  });
  it('keeps the initial document immutable, including the snapshot item and amount arrays', () => {
    const initial = document(), before = structuredClone(initial);
    applyReturnAction(initial, 'brand', command({action: 'approve', expectedVersion: 1, instructions: fixture.instructions}), fixture.now);
    expect(initial).toEqual(before);
  });
  it('lets the customer correct return tracking without resetting the parcel sending date', () => {
    const sent = applyReturnAction(approve(), 'customer', command({action: 'send', expectedVersion: 2, carrier: 'La Poste', trackingNumber: 'RETURNQUAL', trackingUrl: 'https://example.test/return'}), fixture.now);
    expect(returnActions(sent, 'customer')).toEqual(['update_tracking']);
    const corrected = applyReturnAction(sent, 'customer', command({action: 'update_tracking', expectedVersion: 3, carrier: 'La Poste', trackingNumber: 'CORRECTED', trackingUrl: null}), '2026-11-03T10:00:00.000Z');
    expect(corrected).toMatchObject({version: 4, status: 'in_transit', tracking: {trackingNumber: 'CORRECTED', trackingUrl: null, sentAt: fixture.now}});
    expect(corrected.amounts).toEqual(sent.amounts);
  });
  it('refuses a stale action before considering its meaning and never rebases the captured version', () => {
    const approved = approve();
    expect(() => applyReturnAction(approved, 'customer', command({action: 'withdraw', expectedVersion: 1}), fixture.now)).toThrow(expect.objectContaining({response: expect.objectContaining({code: 'order_return_version_changed'})}));
    expect(approved.version).toBe(2);
  });
  it('does not let customer approve, brand arbitrate, or administrator pretend receipt', () => {
    expect(() => applyReturnAction(document(), 'customer', command({action: 'approve', expectedVersion: 1, instructions: fixture.instructions}), fixture.now)).toThrow();
    expect(returnActions({...document(), status: 'disputed'}, 'brand')).toEqual([]);
    expect(returnActions(approve(), 'administrator')).toEqual([]);
  });
  it('preserves the brand refusal and the customer dispute after an administrator accepts with a reason', () => {
    const rejected = applyReturnAction(document(), 'brand', command({action: 'reject', expectedVersion: 1, reason: 'Pièce annoncée non éligible.'}), fixture.now);
    const disputed = applyReturnAction(rejected, 'customer', command({action: 'dispute', expectedVersion: 2, reason: 'La pièce est intacte.'}), fixture.now);
    const resolved = applyReturnAction(disputed, 'administrator', command({action: 'arbitrate_approve', expectedVersion: 3, reason: fixture.reason, instructions: fixture.instructions}), fixture.now);
    expect(resolved).toMatchObject({version: 4, status: 'approved', brandDecision: {decision: 'rejected', reason: 'Pièce annoncée non éligible.'}, dispute: {reason: 'La pièce est intacte.'}, adminDecision: {decision: 'approved', reason: fixture.reason, instructions: fixture.instructions}});
    expect(returnActions(resolved, 'customer')).toEqual(['send', 'withdraw']);
  });
  it('closes a rejected arbitration without allowing a second dispute or receipt', () => {
    const result = applyReturnAction({...document(), status: 'disputed'}, 'administrator', command({action: 'arbitrate_reject', expectedVersion: 1, reason: fixture.reason}), fixture.now);
    expect(result.status).toBe('closed');
    for (const actor of ['customer', 'brand', 'administrator'] as const) expect(returnActions(result, actor)).toEqual([]);
  });
  it('allows withdrawal before sending and refuses it after the parcel has been sent', () => {
    for (const status of ['requested', 'approved', 'rejected'] as const) expect(applyReturnAction({...document(), status}, 'customer', command({action: 'withdraw', expectedVersion: 1}), fixture.now).status).toBe('withdrawn');
    for (const status of ['in_transit', 'refund_pending', 'refund_failed', 'refunded'] as const) expect(() => applyReturnAction({...document(), status}, 'customer', command({action: 'withdraw', expectedVersion: 1}), fixture.now)).toThrow();
  });
  it('permits physical receipt without in-app tracking but requires a choice for every requested line', () => {
    expect(returnActions(approve(), 'brand')).toEqual(['receive']);
    for (const items of [[{orderItemId: fixture.item, restockQuantity: 0}], [{orderItemId: fixture.item, restockQuantity: 3}, {orderItemId: fixture.second, restockQuantity: 0}], [{orderItemId: fixture.item, restockQuantity: 0}, {orderItemId: fixture.item, restockQuantity: 0}]]) {
      expect(() => applyReturnAction(approve(), 'brand', command({action: 'receive', expectedVersion: 2, items}), fixture.now)).toThrow();
    }
  });
  it('never calls a pending refund successful and exposes a controlled retry only to the brand or admin after failure', () => {
    const failed = {...document(), status: 'refund_failed' as const};
    expect(returnActions(failed, 'customer')).toEqual([]);
    for (const actor of ['brand', 'administrator'] as const) {
      expect(returnActions(failed, actor)).toEqual([]);
      expect(returnActions(failed, actor, 'failed')).toEqual([]);
      expect(returnActions(failed, actor, 'canceled')).toEqual(['retry_refund']);
      expect(applyReturnAction(failed, actor, command({action: 'retry_refund', expectedVersion: 1}), fixture.now, 'canceled')).toMatchObject({version: 2, status: 'refund_pending'});
    }
    expect(returnActions({...document(), status: 'refund_pending'}, 'brand')).toEqual([]);
  });
  it('closes all terminal actions and refuses revisions that can no longer be advanced', () => {
    for (const actor of ['customer', 'brand', 'administrator'] as const) for (const status of ['refunded', 'closed', 'withdrawn'] as const) expect(returnActions({...document(), status}, actor)).toEqual([]);
    expect(returnActions({...document(), version: 2147483647}, 'brand')).toEqual([]);
  });
});

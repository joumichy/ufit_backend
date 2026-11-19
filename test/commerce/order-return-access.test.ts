import 'reflect-metadata';
import {ForbiddenException} from '@nestjs/common';
import {describe, expect, it, vi} from 'vitest';
import {OrderReturnsService} from '../../src/modules/orders/application/order-returns.service';
import {RETURN_ACTOR} from '../../src/modules/orders/domain/order-return';
import {ORDER_RETURN, RETURN_ACTION, RETURN_STATUS} from '../../src/modules/orders/domain/order-return.contract';
import type {OrderReturnRepository, ReturnOrderContext, ReturnScope, StoredOrderReturn} from '../../src/modules/orders/domain/order-return.repository';
import {ORDER_PAYMENT, ORDER_STATUS} from '../../src/modules/orders/domain/order-lifecycle';
import {PUBLIC_PROFILE} from '../../src/shared/domain/public-profile.contract';

const fixture = {
  suite: 'Return access while waiting for the order lock',
  cases: [RETURN_ACTOR.brand, RETURN_ACTOR.customer, RETURN_ACTOR.administrator],
  revoked: 'rejects revoked %s access before saving or moving stock',
  denied: 'rejects an initially forbidden actor before looking up an order',
  creationRevoked: 'rejects a customer suspended while creation waits for the order',
  creationDenied: 'rejects an initially suspended customer before creation looks up an order',
  actorId: 'b4b09087-ff56-49a5-9e7a-215c7e39e334', orderId: '02b66e74-07b9-49ed-84e1-7a8260e398fd',
  brandId: 'c04142e4-b790-44bc-bec8-f99c5ba5e9ce', returnId: '2f832f5e-5f49-4319-b330-f766b0976a84',
  itemId: 'd5eb19a3-e024-4bf6-8e58-cd05ad2c77a1', requestId: '74706559-7cd7-4561-8f3e-2e1bc94d6d24',
  fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  at: '2026-11-19T10:00:00.000Z', orderNumber: 'TEST-RETURN-ACCESS', currency: 'CHF',
  reason: 'Return access qualification', instructions: 'Return the test item.', amount: 1000,
  roles: {brand: 'brand_owner', customer: 'customer', administrator: 'admin'}, owner: 'owner', suspended: 'suspended',
} as const;

function scenario(kind: typeof fixture.cases[number], initiallyAllowed = true) {
  let allowed = initiallyAllowed;
  const order: ReturnOrderContext = {
    id: fixture.orderId, customerId: fixture.actorId, brandId: fixture.brandId, orderNumber: fixture.orderNumber,
    currency: fixture.currency, status: ORDER_STATUS.delivered, items: [], deliveredAt: new Date(fixture.at),
    paymentProvider: ORDER_PAYMENT.provider, paymentIntentId: null, terms: null,
    amounts: {subtotalAmount: fixture.amount, shippingAmount: ORDER_RETURN.amount.zero, taxAmount: ORDER_RETURN.amount.zero, totalAmount: fixture.amount},
  };
  const stored: StoredOrderReturn = {
    requestId: fixture.requestId, requestFingerprint: fixture.fingerprint, returnPolicy: fixture.reason,
    allocationNumber: null, refund: null, externalSettlement: null,
    document: {
      id: fixture.returnId, orderId: fixture.orderId, brandId: fixture.brandId, version: ORDER_RETURN.revision.initial,
      status: kind === RETURN_ACTOR.administrator ? RETURN_STATUS.disputed : RETURN_STATUS.requested,
      reason: fixture.reason, items: [], requestedAt: fixture.at, updatedAt: fixture.at, deadline: fixture.at,
      refundedAt: null, brandDecision: null, dispute: null, adminDecision: null, tracking: null, reception: null,
      amounts: {refundPolicyCode: ORDER_RETURN.policy.code, merchandiseAmount: fixture.amount, taxAmount: ORDER_RETURN.amount.zero,
        shippingAmount: ORDER_RETURN.amount.zero, totalAmount: fixture.amount, completesOrder: true},
    },
  };
  const actorAccess = () => ({status: allowed ? PUBLIC_PROFILE.userStatus : fixture.suspended,
    roles: [allowed ? fixture.roles.administrator : fixture.roles.customer]});
  const repository = {
    transaction: async <T>(operation: (repository: OrderReturnRepository) => Promise<T>) => operation(repository as unknown as OrderReturnRepository),
    actorAccess: vi.fn(async () => actorAccess()),
    brandAccess: vi.fn(async () => ({brand: {id: fixture.brandId, brandName: fixture.reason, status: PUBLIC_PROFILE.status},
      actor: {id: fixture.actorId, status: PUBLIC_PROFILE.userStatus, roles: [fixture.roles.brand]}, memberRole: allowed ? fixture.owner : null})),
    reference: vi.fn(async () => ({orderId: fixture.orderId})),
    order: vi.fn(async () => {
      // An administrator revokes access while this transaction waits for another order owner.
      allowed = false;
      return order;
    }),
    find: vi.fn(async () => stored), save: vi.fn(async () => undefined), restock: vi.fn(async () => undefined),
    queueRefund: vi.fn(async () => undefined), findRequest: vi.fn(async () => undefined), insert: vi.fn(async () => undefined),
  };
  const scope: ReturnScope = kind === RETURN_ACTOR.brand ? {kind, brandId: fixture.brandId}
    : kind === RETURN_ACTOR.customer ? {kind, orderId: fixture.orderId} : {kind};
  const command = kind === RETURN_ACTOR.customer ? {action: RETURN_ACTION.withdraw, expectedVersion: ORDER_RETURN.revision.initial}
    : kind === RETURN_ACTOR.brand ? {action: RETURN_ACTION.approve, expectedVersion: ORDER_RETURN.revision.initial, instructions: fixture.instructions}
      : {action: RETURN_ACTION.arbitrateApprove, expectedVersion: ORDER_RETURN.revision.initial, instructions: fixture.instructions, reason: fixture.reason};
  return {repository, scope, command, service: new OrderReturnsService(repository as unknown as OrderReturnRepository)};
}

describe(fixture.suite, () => {
  it.each(fixture.cases)(fixture.revoked, async kind => {
    const value = scenario(kind);
    await expect(value.service.act(fixture.actorId, value.scope, fixture.returnId, value.command)).rejects.toBeInstanceOf(ForbiddenException);
    expect(value.repository.save).not.toHaveBeenCalled();
    expect(value.repository.restock).not.toHaveBeenCalled();
    expect(value.repository.queueRefund).not.toHaveBeenCalled();
  });

  it(fixture.denied, async () => {
    const value = scenario(RETURN_ACTOR.brand, false);
    await expect(value.service.act(fixture.actorId, value.scope, fixture.returnId, value.command)).rejects.toBeInstanceOf(ForbiddenException);
    expect(value.repository.order).not.toHaveBeenCalled();
    expect(value.repository.save).not.toHaveBeenCalled();
  });

  it(fixture.creationRevoked, async () => {
    const value = scenario(RETURN_ACTOR.customer);
    await expect(value.service.create(fixture.actorId, fixture.orderId, {
      requestId: fixture.requestId, quoteFingerprint: fixture.fingerprint, reason: fixture.reason,
      items: [{orderItemId: fixture.itemId, quantity: ORDER_RETURN.amount.minimumQuantity}],
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(value.repository.insert).not.toHaveBeenCalled();
  });

  it(fixture.creationDenied, async () => {
    const value = scenario(RETURN_ACTOR.customer, false);
    await expect(value.service.create(fixture.actorId, fixture.orderId, {
      requestId: fixture.requestId, quoteFingerprint: fixture.fingerprint, reason: fixture.reason,
      items: [{orderItemId: fixture.itemId, quantity: ORDER_RETURN.amount.minimumQuantity}],
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(value.repository.order).not.toHaveBeenCalled();
    expect(value.repository.insert).not.toHaveBeenCalled();
  });
});

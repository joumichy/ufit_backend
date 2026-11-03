import {ConflictException} from '@nestjs/common';
import {ORDER_RETURN, RETURN_ACTION, RETURN_STATUS, type OrderReturnAction, type ReturnActionName, type ReturnStatus} from './order-return.contract';
import type {ReturnQuantity, ReturnRefundAmounts} from './return-refund-policy';
import {RETURN_REFUND, type ReturnRefundProviderStatus} from './return-refund';

export const RETURN_ACTOR = {customer: 'customer', brand: 'brand', administrator: 'administrator'} as const;
export type ReturnActor = typeof RETURN_ACTOR[keyof typeof RETURN_ACTOR];
export interface ReturnRestockItem {orderItemId: string; restockQuantity: number;}
export interface ReturnDecision {
  decision: typeof RETURN_STATUS.approved | typeof RETURN_STATUS.rejected;
  reason: string | null; instructions: string | null; at: string;
}
export interface OrderReturn {
  id: string; orderId: string; brandId: string; version: number; status: ReturnStatus;
  reason: string; items: ReturnQuantity[]; amounts: ReturnRefundAmounts;
  requestedAt: string; deadline: string; updatedAt: string; refundedAt: string | null;
  brandDecision: ReturnDecision | null;
  dispute: {reason: string; at: string} | null;
  adminDecision: ReturnDecision | null;
  tracking: {carrier: string; trackingNumber: string; trackingUrl: string | null; sentAt: string} | null;
  reception: {at: string; items: ReturnRestockItem[]} | null;
}
export function returnActions(document: OrderReturn, actor: ReturnActor, providerStatus: ReturnRefundProviderStatus | null = null): ReturnActionName[] {
  if (document.version >= ORDER_RETURN.revision.maximum) return [];
  if (actor === RETURN_ACTOR.customer) {
    switch (document.status) {
      case RETURN_STATUS.requested: return [RETURN_ACTION.withdraw];
      case RETURN_STATUS.approved: return [RETURN_ACTION.send, RETURN_ACTION.withdraw];
      case RETURN_STATUS.rejected: return [RETURN_ACTION.dispute, RETURN_ACTION.withdraw];
      case RETURN_STATUS.inTransit: return [RETURN_ACTION.updateTracking];
      default: return [];
    }
  }
  if (actor === RETURN_ACTOR.administrator && document.status === RETURN_STATUS.disputed) return [RETURN_ACTION.arbitrateApprove, RETURN_ACTION.arbitrateReject];
  if (document.status === RETURN_STATUS.refundFailed) return providerStatus === RETURN_REFUND.providerStatus.cancelled ? [RETURN_ACTION.retryRefund] : [];
  if (actor === RETURN_ACTOR.brand) {
    switch (document.status) {
      case RETURN_STATUS.requested: return [RETURN_ACTION.approve, RETURN_ACTION.reject];
      case RETURN_STATUS.approved: case RETURN_STATUS.inTransit: return [RETURN_ACTION.receive];
      default: return [];
    }
  }
  return [];
}
/** Authorization resolves actor from current persisted facts before entering this policy. */
export function applyReturnAction(document: OrderReturn, actor: ReturnActor, input: OrderReturnAction, now: string, providerStatus: ReturnRefundProviderStatus | null = null): OrderReturn {
  if (document.version !== input.expectedVersion) throw new ConflictException(ORDER_RETURN.failure.changed);
  if (!returnActions(document, actor, providerStatus).includes(input.action)) throw new ConflictException(ORDER_RETURN.failure.state);
  const result = {...document, version: document.version + ORDER_RETURN.revision.step, updatedAt: now};
  switch (input.action) {
    case RETURN_ACTION.approve:
      result.status = RETURN_STATUS.approved;
      result.brandDecision = {decision: RETURN_STATUS.approved, instructions: input.instructions, reason: null, at: now}; break;
    case RETURN_ACTION.reject:
      result.status = RETURN_STATUS.rejected;
      result.brandDecision = {decision: RETURN_STATUS.rejected, instructions: null, reason: input.reason, at: now}; break;
    case RETURN_ACTION.withdraw: result.status = RETURN_STATUS.withdrawn; break;
    case RETURN_ACTION.dispute:
      result.status = RETURN_STATUS.disputed; result.dispute = {reason: input.reason, at: now}; break;
    case RETURN_ACTION.arbitrateApprove:
      result.status = RETURN_STATUS.approved;
      result.adminDecision = {decision: RETURN_STATUS.approved, instructions: input.instructions, reason: input.reason, at: now}; break;
    case RETURN_ACTION.arbitrateReject:
      result.status = RETURN_STATUS.closed;
      result.adminDecision = {decision: RETURN_STATUS.rejected, instructions: null, reason: input.reason, at: now}; break;
    case RETURN_ACTION.send:
      result.status = RETURN_STATUS.inTransit;
      result.tracking = {carrier: input.carrier, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl ?? null, sentAt: now}; break;
    case RETURN_ACTION.updateTracking:
      if (!document.tracking) throw new ConflictException(ORDER_RETURN.failure.persisted);
      result.tracking = {...document.tracking, carrier: input.carrier, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl ?? null}; break;
    case RETURN_ACTION.receive: {
      if (input.items.length !== document.items.length) throw new ConflictException(ORDER_RETURN.failure.quantity);
      const choices = new Map(input.items.map(item => [item.orderItemId, item.restockQuantity]));
      if (choices.size !== input.items.length || document.items.some(item => !choices.has(item.orderItemId) || choices.get(item.orderItemId)! > item.quantity)) throw new ConflictException(ORDER_RETURN.failure.quantity);
      result.status = RETURN_STATUS.refundPending;
      result.reception = {at: now, items: input.items.map(item => ({...item}))}; break;
    }
    case RETURN_ACTION.retryRefund: result.status = RETURN_STATUS.refundPending; break;
  }
  return result;
}

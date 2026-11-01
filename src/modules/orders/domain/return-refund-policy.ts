import {ConflictException} from '@nestjs/common';
import {ORDER_STATUS, type OrderStatus} from './order-lifecycle';
import {ORDER_RETURN} from './order-return.contract';

export interface ReturnOrderItem {
  id: string; quantity: number; unitPrice: number; totalPrice: number;
}
export interface ReturnQuantity {orderItemId: string; quantity: number;}
export interface ReturnOrderAmounts {
  subtotalAmount: number; shippingAmount: number; taxAmount: number; totalAmount: number;
}
export interface ReturnRefundAmounts {
  refundPolicyCode: typeof ORDER_RETURN.policy.code;
  merchandiseAmount: number; taxAmount: number; shippingAmount: number; totalAmount: number; completesOrder: boolean;
}
export function assertSameRefundAmounts(expected: ReturnRefundAmounts, actual: ReturnRefundAmounts): void {
  if (expected.refundPolicyCode !== actual.refundPolicyCode || expected.merchandiseAmount !== actual.merchandiseAmount || expected.taxAmount !== actual.taxAmount || expected.shippingAmount !== actual.shippingAmount || expected.totalAmount !== actual.totalAmount || expected.completesOrder !== actual.completesOrder) throw new ConflictException(ORDER_RETURN.failure.persisted);
}
const amountLimit = ORDER_RETURN.amount;
function money(value: number): boolean { return Number.isSafeInteger(value) && value >= amountLimit.zero && value <= amountLimit.maximum; }
function invalid(): never { throw new ConflictException(ORDER_RETURN.failure.persisted); }
function quantityMap(values: readonly ReturnQuantity[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of values) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < amountLimit.minimumQuantity || item.quantity > amountLimit.maximum || result.has(item.orderItemId)) invalid();
    result.set(item.orderItemId, item.quantity);
  }
  return result;
}
/** Cumulative allocation leaves all rounding remainders for the final returned unit. */
export function allocateReturnRefund(order: ReturnOrderAmounts, items: readonly ReturnOrderItem[], previous: readonly ReturnQuantity[], requested: readonly ReturnQuantity[]): ReturnRefundAmounts {
  if (!Object.values(order).every(money) || order.totalAmount !== order.subtotalAmount + order.shippingAmount + order.taxAmount || !items.length) invalid();
  const original = new Map(items.map(item => [item.id, item]));
  if (original.size !== items.length) invalid();
  let subtotal = BigInt(amountLimit.zero);
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < amountLimit.minimumQuantity || item.quantity > amountLimit.maximum || !money(item.unitPrice) || !money(item.totalPrice) || BigInt(item.unitPrice) * BigInt(item.quantity) !== BigInt(item.totalPrice)) invalid();
    subtotal += BigInt(item.totalPrice);
  }
  if (subtotal !== BigInt(order.subtotalAmount)) invalid();
  const before = quantityMap(previous), selected = quantityMap(requested);
  if (!selected.size) throw new ConflictException(ORDER_RETURN.failure.quantity);
  for (const id of before.keys()) if (!original.has(id)) invalid();
  for (const id of selected.keys()) if (!original.has(id)) throw new ConflictException(ORDER_RETURN.failure.quantity);
  let beforeAmount = BigInt(amountLimit.zero), addedAmount = BigInt(amountLimit.zero), beforeComplete = true, complete = true;
  for (const item of items) {
    const returned = before.get(item.id) ?? amountLimit.zero, added = selected.get(item.id) ?? amountLimit.zero;
    if (returned > item.quantity) invalid();
    if (returned + added > item.quantity) throw new ConflictException(ORDER_RETURN.failure.quantity);
    beforeComplete &&= returned === item.quantity; complete &&= returned + added === item.quantity;
    beforeAmount += BigInt(returned) * BigInt(item.unitPrice); addedAmount += BigInt(added) * BigInt(item.unitPrice);
  }
  if (beforeComplete) throw new ConflictException(ORDER_RETURN.failure.quantity);
  const tax = BigInt(order.taxAmount);
  const beforeTax = subtotal === BigInt(amountLimit.zero) ? BigInt(amountLimit.zero) : tax * beforeAmount / subtotal;
  const afterTax = complete ? tax : subtotal === BigInt(amountLimit.zero) ? BigInt(amountLimit.zero) : tax * (beforeAmount + addedAmount) / subtotal;
  const merchandiseAmount = Number(addedAmount), taxAmount = Number(afterTax - beforeTax), shippingAmount = complete ? order.shippingAmount : amountLimit.zero;
  const totalAmount = merchandiseAmount + taxAmount + shippingAmount;
  if (!money(totalAmount)) invalid();
  return {refundPolicyCode: ORDER_RETURN.policy.code, merchandiseAmount, taxAmount, shippingAmount, totalAmount, completesOrder: complete};
}
export function returnDeadline(status: OrderStatus, deliveredAt: Date | null, returnWindowDays: number, now: Date): Date {
  if (!Number.isSafeInteger(returnWindowDays) || returnWindowDays < amountLimit.zero || !Number.isFinite(now.getTime()) || (deliveredAt && !Number.isFinite(deliveredAt.getTime()))) invalid();
  if (status !== ORDER_STATUS.delivered || !deliveredAt || returnWindowDays === amountLimit.zero) throw new ConflictException(ORDER_RETURN.failure.expired);
  const deadline = new Date(deliveredAt.getTime() + returnWindowDays * ORDER_RETURN.time.dayMilliseconds);
  if (!Number.isFinite(deadline.getTime()) || deliveredAt.getTime() > now.getTime()) invalid();
  if (now.getTime() > deadline.getTime()) throw new ConflictException(ORDER_RETURN.failure.expired);
  return deadline;
}
export function returnedCommissionAmount(originalCommission: number, orderedQuantity: number, returnedQuantity: number): number {
  if (!money(originalCommission) || !Number.isSafeInteger(orderedQuantity) || orderedQuantity < amountLimit.minimumQuantity || orderedQuantity > amountLimit.maximum || !Number.isSafeInteger(returnedQuantity) || returnedQuantity < amountLimit.zero || returnedQuantity > orderedQuantity) invalid();
  return Number(BigInt(originalCommission) * BigInt(returnedQuantity) / BigInt(orderedQuantity));
}

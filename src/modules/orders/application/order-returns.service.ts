import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {createHash, randomUUID} from 'node:crypto';
import {BRAND_MANAGEMENT, requireBrandManagementAccess} from '../../brands/brand-management-access';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {ORDER_RETURN, RETURN_ACTION, RETURN_STATUS, createOrderReturnSchema, orderReturnActionSchema, returnSelectionSchema} from '../domain/order-return.contract';
import {RETURN_ACTOR, applyReturnAction, returnActions, type OrderReturn} from '../domain/order-return';
import {allocateReturnRefund, assertSameRefundAmounts, returnDeadline} from '../domain/return-refund-policy';
import type {OrderReturnRepository, ReturnScope, ReturnOrderContext, StoredOrderReturn, OrderReturnDetail, OrderReturnQuery} from '../domain/order-return.repository';
import {ORDER_STATUS, ORDER_PAYMENT} from '../domain/order-lifecycle';
import {RETURN_REFUND} from '../domain/return-refund';

export const RETURN_UNAVAILABLE = {
  notDelivered: 'not_delivered', missingTerms: 'missing_terms', windowClosed: 'window_closed', open: 'open_return', completed: 'all_returned',
} as const;
export type ReturnUnavailableReason = typeof RETURN_UNAVAILABLE[keyof typeof RETURN_UNAVAILABLE];

@Injectable()
export class OrderReturnsService {
  constructor(@Inject(ORDER_RETURN.repository) private readonly returns: OrderReturnRepository) {}
  list(actorId: string, scope: ReturnScope, query: OrderReturnQuery) {
    return this.returns.snapshot(async repository => {
      await this.authorize(repository, actorId, scope, false);
      if (scope.kind === RETURN_ACTOR.customer) this.requireOrder(await repository.order(scope.orderId, false), actorId, scope);
      return repository.list(scope, actorId, query);
    });
  }
  detail(actorId: string, scope: ReturnScope, id: string) {
    return this.returns.snapshot(async repository => {
      await this.authorize(repository, actorId, scope, false);
      const {stored, order} = await this.loadScoped(repository, actorId, scope, id, false);
      return presentReturn(stored, order, scope);
    });
  }
  options(actorId: string, orderId: string) {
    return this.returns.snapshot(async repository => {
      const scope = {kind: RETURN_ACTOR.customer, orderId};
      await this.authorize(repository, actorId, scope, false);
      const order = this.requireOrder(await repository.order(orderId, false), actorId, scope);
      const [previous, openReturnId] = await Promise.all([repository.returnedQuantities(orderId), repository.findOpen(orderId)]);
      const returned = new Map(previous.map(item => [item.orderItemId, item.quantity]));
      const items = order.items.map(item => {
        const quantity = returned.get(item.id) ?? ORDER_RETURN.amount.zero;
        if (quantity > item.quantity) throw new ConflictException(ORDER_RETURN.failure.persisted);
        return {...item, availableQuantity: item.quantity - quantity};
      });
      let unavailableReason: ReturnUnavailableReason | null = null, deadline: string | null = null;
      if (order.status === ORDER_STATUS.refunded) unavailableReason = RETURN_UNAVAILABLE.completed;
      else if (order.status !== ORDER_STATUS.delivered) unavailableReason = RETURN_UNAVAILABLE.notDelivered;
      else if (!order.terms) unavailableReason = RETURN_UNAVAILABLE.missingTerms;
      else {
        try { deadline = returnDeadline(order.status, order.deliveredAt, order.terms.returnWindowDays, new Date()).toISOString(); }
        catch (error) {
          if (!(error instanceof ConflictException) || (error.getResponse() as {code?: string}).code !== ORDER_RETURN.failure.expired.code) throw error;
          unavailableReason = RETURN_UNAVAILABLE.windowClosed;
        }
      }
      if (openReturnId) unavailableReason = RETURN_UNAVAILABLE.open;
      else if (!items.some(item => item.availableQuantity > ORDER_RETURN.amount.zero) && unavailableReason === null) unavailableReason = RETURN_UNAVAILABLE.completed;
      return {orderId: order.id, currency: order.currency, returnPolicy: order.terms?.returnPolicy ?? null, refundPolicyCode: ORDER_RETURN.policy.code,
        deadline, canRequest: unavailableReason === null, unavailableReason, openReturnId, items};
    });
  }
  preview(actorId: string, orderId: string, raw: unknown) {
    const parsed = returnSelectionSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(ORDER_RETURN.failure.input);
    return this.returns.snapshot(async repository => {
      const scope = {kind: RETURN_ACTOR.customer, orderId};
      await this.authorize(repository, actorId, scope, false);
      const order = this.requireOrder(await repository.order(orderId, false), actorId, scope);
      return this.quote(repository, order, parsed.data.items);
    });
  }
  create(actorId: string, orderId: string, raw: unknown) {
    const parsed = createOrderReturnSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(ORDER_RETURN.failure.input);
    const input = {...parsed.data, items: [...parsed.data.items].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId))};
    const fingerprint = returnFingerprint(input);
    return this.returns.transaction(async repository => {
      const scope = {kind: RETURN_ACTOR.customer, orderId};
      await this.authorize(repository, actorId, scope, true);
      const order = this.requireOrder(await repository.order(orderId, true), actorId, scope);
      const existing = await repository.findRequest(orderId, input.requestId);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new ConflictException(ORDER_RETURN.failure.reused);
        return presentReturn(existing, order, scope);
      }
      const quote = await this.quote(repository, order, input.items);
      if (quote.fingerprint !== input.quoteFingerprint) throw new ConflictException(ORDER_RETURN.failure.quote);
      const now = new Date().toISOString();
      const document: OrderReturn = {id: randomUUID(), orderId, brandId: order.brandId, version: ORDER_RETURN.revision.initial, status: RETURN_STATUS.requested,
        reason: input.reason, items: input.items, amounts: quote.amounts, requestedAt: now, updatedAt: now, deadline: quote.deadline, refundedAt: null,
        brandDecision: null, dispute: null, adminDecision: null, tracking: null, reception: null};
      await repository.insert(document, input.requestId, fingerprint, order.terms!.returnPolicy);
      const saved = await repository.find(document.id, false);
      if (!saved) throw new ConflictException(ORDER_RETURN.failure.persisted);
      return presentReturn(saved, order, scope);
    });
  }
  act(actorId: string, scope: ReturnScope, id: string, raw: unknown) {
    const parsed = orderReturnActionSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(ORDER_RETURN.failure.input);
    return this.returns.transaction(async repository => {
      await this.authorize(repository, actorId, scope, true);
      const {stored, order} = await this.loadScoped(repository, actorId, scope, id, true);
      const changed = applyReturnAction(stored.document, scope.kind, parsed.data, new Date().toISOString());
      if (parsed.data.action === RETURN_ACTION.receive || parsed.data.action === RETURN_ACTION.retryRefund) {
        if (order.status !== ORDER_STATUS.delivered || order.paymentProvider !== ORDER_PAYMENT.provider || !order.paymentIntentId) throw new ConflictException(RETURN_REFUND.failure.unavailable);
        const previous = await repository.returnedQuantities(order.id);
        const plan = allocateReturnRefund(order.amounts, order.items, previous, changed.items), amounts = changed.amounts;
        assertSameRefundAmounts(plan, amounts);
      }
      await repository.save(changed, parsed.data.expectedVersion);
      if (parsed.data.action === RETURN_ACTION.receive) await repository.restock(changed, order);
      if (parsed.data.action === RETURN_ACTION.receive || parsed.data.action === RETURN_ACTION.retryRefund) await repository.queueRefund(changed, parsed.data.action === RETURN_ACTION.retryRefund);
      const saved = await repository.find(id, false);
      if (!saved) throw new ConflictException(ORDER_RETURN.failure.persisted);
      return presentReturn(saved, order, scope);
    });
  }
  private async quote(repository: OrderReturnRepository, order: ReturnOrderContext, selected: OrderReturn['items']) {
    if (!order.terms) throw new ConflictException(ORDER_RETURN.failure.persisted);
    const deadline = returnDeadline(order.status, order.deliveredAt, order.terms.returnWindowDays, new Date()).toISOString();
    if (await repository.findOpen(order.id)) throw new ConflictException(ORDER_RETURN.failure.open);
    const previous = await repository.returnedQuantities(order.id);
    const amounts = allocateReturnRefund(order.amounts, order.items, previous, selected);
    const items = [...selected].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
    return {orderId: order.id, currency: order.currency, deadline, amounts, fingerprint: returnFingerprint({orderId: order.id, deadline, items, amounts})};
  }
  private async authorize(repository: OrderReturnRepository, actorId: string, scope: ReturnScope, lock: boolean) {
    if (scope.kind === RETURN_ACTOR.brand) {
      requireBrandManagementAccess(await repository.brandAccess(scope.brandId, actorId, lock), ORDER_RETURN.failure.access);
    } else {
      const access = await repository.actorAccess(actorId, lock);
      if (!access || access.status !== PUBLIC_PROFILE.userStatus || (scope.kind === RETURN_ACTOR.administrator && !BRAND_MANAGEMENT.adminRoles.some(role => access.roles.includes(role)))) throw new ForbiddenException(ORDER_RETURN.failure.access);
    }
  }
  private requireOrder(order: ReturnOrderContext | undefined, actorId: string, scope: ReturnScope): ReturnOrderContext {
    if (!order || (scope.kind === RETURN_ACTOR.customer && (order.customerId !== actorId || order.id !== scope.orderId.toLowerCase())) || (scope.kind === RETURN_ACTOR.brand && order.brandId !== scope.brandId.toLowerCase())) throw new NotFoundException(ORDER_RETURN.failure.missing);
    return order;
  }
  private async loadScoped(repository: OrderReturnRepository, actorId: string, scope: ReturnScope, id: string, lock: boolean) {
    const reference = await repository.reference(id);
    if (!reference) throw new NotFoundException(ORDER_RETURN.failure.missing);
    const order = this.requireOrder(await repository.order(reference.orderId, lock), actorId, scope);
    const stored = await repository.find(id, lock);
    if (!stored || stored.document.orderId !== order.id || stored.document.brandId !== order.brandId) throw new NotFoundException(ORDER_RETURN.failure.missing);
    return {stored, order};
  }
}
function returnFingerprint(value: object): string { return createHash(ORDER_RETURN.fingerprint.algorithm).update(JSON.stringify(value)).digest(ORDER_RETURN.fingerprint.encoding); }
function presentReturn(stored: StoredOrderReturn, order: ReturnOrderContext, scope: ReturnScope): OrderReturnDetail {
  const {document} = stored, original = new Map(order.items.map(item => [item.id, item]));
  const restocked = new Map(document.reception?.items.map(item => [item.orderItemId, item.restockQuantity]));
  return {...document, orderNumber: order.orderNumber, currency: order.currency, returnPolicy: stored.returnPolicy,
    items: document.items.map(item => {
      const source = original.get(item.orderItemId);
      if (!source) throw new ConflictException(ORDER_RETURN.failure.persisted);
      return {...item, orderedQuantity: source.quantity, name: source.name, sku: source.sku, size: source.size, color: source.color,
        imageUrl: source.imageUrl, unitPrice: source.unitPrice, merchandiseAmount: source.unitPrice * item.quantity, restockQuantity: restocked.get(item.orderItemId) ?? null};
    }), refund: stored.refund, actions: returnActions(document, scope.kind)};
}

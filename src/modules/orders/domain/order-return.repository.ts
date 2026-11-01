import type {BrandManagementAccess} from '../../brands/brands.repository';
import type {UserStatus, UserRole} from '../../identity/domain/user.types';
import {RETURN_ACTOR, type OrderReturn} from './order-return';
import {ORDER_RETURN, type ReturnStatus, type ReturnActionName} from './order-return.contract';
import type {FrozenOrderItem} from './frozen-order-item';
import type {OrderStatus} from './order-lifecycle';
import type {ReturnOrderAmounts, ReturnQuantity} from './return-refund-policy';
import type {ReturnRefundProviderStatus, ReturnRefundAttemptState} from './return-refund';

export type ReturnScope = {kind: typeof RETURN_ACTOR.customer; orderId: string} | {kind: typeof RETURN_ACTOR.brand; brandId: string} | {kind: typeof RETURN_ACTOR.administrator};
export interface ReturnActorAccess {status: UserStatus; roles: UserRole[];}
export interface ReturnOrderContext {
  id: string; customerId: string; brandId: string; orderNumber: string; currency: string; status: OrderStatus;
  amounts: ReturnOrderAmounts; items: FrozenOrderItem[]; deliveredAt: Date | null;
  paymentProvider: string; paymentIntentId: string | null;
  terms: {returnWindowDays: number; returnPolicy: string; refundPolicyCode: typeof ORDER_RETURN.policy.code} | null;
}
export interface ReturnRefundSummary {
  attemptNumber: number; amount: number; state: ReturnRefundAttemptState; providerStatus: ReturnRefundProviderStatus | null; updatedAt: string;
}
export interface StoredOrderReturn {
  document: OrderReturn; requestId: string; requestFingerprint: string; returnPolicy: string;
  refund: ReturnRefundSummary | null;
}
export interface OrderReturnSummary {
  id: string; orderId: string; brandId: string; orderNumber: string; version: number; status: ReturnStatus;
  requestedAt: string; itemCount: number; totalAmount: number; currency: string;
}
export interface OrderReturnPage {items: OrderReturnSummary[]; nextCursor: string | null;}
export interface OrderReturnQuery {limit: number; cursor?: string; status?: ReturnStatus;}
export interface OrderReturnRepository {
  transaction<T>(operation: (repository: OrderReturnRepository) => Promise<T>): Promise<T>;
  snapshot<T>(operation: (repository: OrderReturnRepository) => Promise<T>): Promise<T>;
  actorAccess(actorId: string, lock: boolean): Promise<ReturnActorAccess | undefined>;
  brandAccess(brandId: string, actorId: string, lock: boolean): Promise<BrandManagementAccess | undefined>;
  order(orderId: string, lock: boolean): Promise<ReturnOrderContext | undefined>;
  reference(id: string): Promise<{orderId: string} | undefined>;
  find(id: string, lock: boolean): Promise<StoredOrderReturn | undefined>;
  findRequest(orderId: string, requestId: string): Promise<StoredOrderReturn | undefined>;
  findOpen(orderId: string): Promise<string | null>;
  returnedQuantities(orderId: string): Promise<ReturnQuantity[]>;
  list(scope: ReturnScope, actorId: string, query: OrderReturnQuery): Promise<OrderReturnPage>;
  insert(document: OrderReturn, requestId: string, fingerprint: string, returnPolicy: string): Promise<void>;
  save(document: OrderReturn, expectedVersion: number): Promise<void>;
  restock(document: OrderReturn, order: ReturnOrderContext): Promise<void>;
  queueRefund(document: OrderReturn, retry: boolean): Promise<void>;
}
export interface OrderReturnDetail extends Omit<OrderReturn, 'items'> {
  orderNumber: string; currency: string; returnPolicy: string;
  items: Array<ReturnQuantity & {orderedQuantity: number; name: string; sku: string; size: string | null; color: string | null; imageUrl: string | null; unitPrice: number; merchandiseAmount: number; restockQuantity: number | null}>;
  refund: ReturnRefundSummary | null; actions: ReturnActionName[];
}

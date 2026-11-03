import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {ORDER_PAYMENT, ORDER_STATUS} from './order-lifecycle';
import {SHIPMENT_STATUS} from '../../shipping/domain/shipping.contract';
import type {Order} from '../application/orders.service';
import type {OrderReturnPage} from './order-return.repository';
import type {IdentityAccess} from '../../identity/domain/user.types';

export const ADMIN_ORDERS = {
  repository: Symbol('AdminOrderRepository'),
  route: {root: 'admin/orders', detail: ':id', returns: ':id/returns', id: 'id'},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  limit: {zero: 0, one: 1, page: 20, maximumPage: 50, search: 120, maximumAmount: 2_147_483_647},
  revision: {pattern: /^[a-f0-9]{32}$/, empty: '[]'},
  timestamp: {zone: 'UTC', format: 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'},
  search: {wildcard: '%', escape: '\\', escaped: /[\\%_]/g},
  failure: {
    input: {code: 'admin_orders_query_invalid', message: 'Invalid administration order query'},
    access: {code: 'admin_orders_access_required', message: 'Active administration access is required'},
    missing: {code: 'admin_order_not_found', message: 'Order not found'},
    changed: {code: 'admin_orders_changed', message: 'The orders changed; refresh the collection'},
    cursor: {code: 'admin_orders_cursor_invalid', message: 'Invalid administration order cursor'},
    persisted: {code: 'admin_order_document_invalid', message: 'The stored order requires correction'},
  },
} as const;
const l = ADMIN_ORDERS.limit;
const money = z.number().int().min(l.zero).max(l.maximumAmount);
const count = z.number().int().min(l.zero).max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(l.one);
const currency = z.string().refine(value => CURRENCY_CODES.includes(value));
const cursor = {cursor: z.uuid().optional(), revision: z.string().regex(ADMIN_ORDERS.revision.pattern).optional(),
  limit: z.coerce.number().int().min(l.one).max(l.maximumPage).default(l.page)};
const cursorPair = (value: {cursor?: string; revision?: string}) => (value.cursor === undefined) === (value.revision === undefined);
export const adminOrderQuerySchema = z.object({...cursor, search: z.string().trim().max(l.search).default(String()),
  status: z.enum(Object.values(ORDER_STATUS)).optional(), currency: currency.optional(),
  shipmentStatus: z.enum(Object.values(SHIPMENT_STATUS)).optional()}).strict().refine(cursorPair);
export const adminOrderReturnsQuerySchema = z.object({limit: cursor.limit, cursor: cursor.cursor}).strict();
export const adminOrderIdSchema = z.uuid().toLowerCase();
export type AdminOrderQuery = z.infer<typeof adminOrderQuerySchema>;
export type AdminOrderReturnsQuery = z.infer<typeof adminOrderReturnsQuerySchema>;
export const adminOrderSummarySchema = z.object({id: z.uuid(), orderNumber: text, brand: z.object({id: z.uuid(), name: text}).strict(),
  status: z.enum(Object.values(ORDER_STATUS)), createdAt: z.iso.datetime(), totalAmount: money, currency,
  itemCount: count, shipmentStatus: z.enum(Object.values(SHIPMENT_STATUS)).nullable(), paymentRecorded: z.boolean(), returnCount: count}).strict();
export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;
export const adminOrderPageSchema = z.object({items: z.array(adminOrderSummarySchema), nextCursor: z.uuid().nullable(),
  revision: z.string().regex(ADMIN_ORDERS.revision.pattern), totalCount: count, asOf: z.iso.datetime(), currencies: z.array(currency)}).strict()
  .refine(value => value.items.length <= l.maximumPage && value.items.length <= value.totalCount && new Set(value.items.map(item => item.id)).size === value.items.length &&
    new Set(value.currencies).size === value.currencies.length && (value.nextCursor === null || value.nextCursor === value.items.at(-l.one)?.id));
export type AdminOrderPage = z.infer<typeof adminOrderPageSchema>;
export const adminOrderPaymentSchema = z.object({id: z.uuid(), provider: z.literal(ORDER_PAYMENT.provider),
  status: z.enum(Object.values(ORDER_PAYMENT.status)), amount: money, currency,
  providerPaymentIntentId: text.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()}).strict();
export type AdminOrderPayment = z.infer<typeof adminOrderPaymentSchema>;
export interface AdminOrderDetail {order: Order; brand: AdminOrderSummary['brand']; payments: AdminOrderPayment[]; returnCount: number; asOf: string;}
export interface AdminOrderRepository {
  snapshot<T>(operation: (repository: AdminOrderRepository) => Promise<T>): Promise<T>;
  access(actorId: string): Promise<IdentityAccess | undefined>;
  page(query: AdminOrderQuery): Promise<AdminOrderPage>;
  detail(id: string): Promise<AdminOrderDetail | undefined>;
  relatedReturns(actorId: string, id: string, query: AdminOrderReturnsQuery): Promise<OrderReturnPage>;
}

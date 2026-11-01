import {z} from 'zod';
import {parcelTrackingFields} from '../../../shared/domain/parcel-tracking';

export const RETURN_STATUS = {
  requested: 'requested', approved: 'approved', rejected: 'rejected', disputed: 'disputed', inTransit: 'in_transit',
  refundPending: 'refund_pending', refundFailed: 'refund_failed', refunded: 'refunded', closed: 'closed', withdrawn: 'withdrawn',
} as const;
export type ReturnStatus = typeof RETURN_STATUS[keyof typeof RETURN_STATUS];
export const RETURN_ACTION = {
  approve: 'approve', reject: 'reject', withdraw: 'withdraw', dispute: 'dispute', send: 'send', receive: 'receive',
  arbitrateApprove: 'arbitrate_approve', arbitrateReject: 'arbitrate_reject', retryRefund: 'retry_refund',
} as const;
export type ReturnActionName = typeof RETURN_ACTION[keyof typeof RETURN_ACTION];
export const ORDER_RETURN = {
  repository: Symbol('OrderReturnRepository'),
  route: {customer: 'orders/:orderId/returns', brand: 'brands/:brandId/returns', admin: 'admin/returns', orderId: 'orderId', brandId: 'brandId', id: 'id', detail: ':id', actions: ':id/actions', options: 'options', preview: 'preview'},
  persistence: {lock: 'update', singleRow: 1, overflow: 1, lastRow: -1},
  revision: {initial: 1, step: 1, maximum: 2147483647},
  limit: {minimumText: 1, reason: 2000, instructions: 4000, minimumItems: 1, maximumItems: 50, zero: 0, firstRow: 0},
  amount: {maximum: 2147483647, zero: 0, minimumQuantity: 1},
  time: {dayMilliseconds: 86400000},
  policy: {code: 'proportional_tax_full_shipping_v1'},
  protocol: {action: 'action', duplicateMessage: 'Duplicate order item'},
  fingerprint: {pattern: /^[a-f0-9]{64}$/, algorithm: 'sha256', encoding: 'hex'},
  terminalStatuses: [RETURN_STATUS.refunded, RETURN_STATUS.closed, RETURN_STATUS.withdrawn],
  failure: {
    access: {code: 'order_return_access_required', message: 'Access to this return is required'},
    cursor: {code: 'order_return_cursor_invalid', message: 'Invalid return cursor'},
    input: {code: 'order_return_input_invalid', message: 'Invalid return request or action'},
    changed: {code: 'order_return_version_changed', message: 'The return changed; refresh before continuing'},
    state: {code: 'order_return_action_unavailable', message: 'This action is not available for this return'},
    persisted: {code: 'order_return_persisted_invalid', message: 'The saved order or return requires correction'},
    quantity: {code: 'order_return_quantity_unavailable', message: 'The requested quantities are no longer available for return'},
    expired: {code: 'order_return_window_closed', message: 'The return period has ended or returns are unavailable'},
    open: {code: 'order_return_already_open', message: 'An unresolved return already exists for this order'},
    reused: {code: 'order_return_request_conflict', message: 'This request identifier was already used for another return'},
    quote: {code: 'order_return_quote_changed', message: 'Review the updated return amounts before submitting'},
    missing: {code: 'order_return_not_found', message: 'Return not found'},
  },
} as const;
const expectedVersion = z.number().int().min(ORDER_RETURN.revision.initial).max(ORDER_RETURN.revision.maximum - ORDER_RETURN.revision.step);
const reason = z.string().trim().min(ORDER_RETURN.limit.minimumText).max(ORDER_RETURN.limit.reason);
const instructions = z.string().trim().min(ORDER_RETURN.limit.minimumText).max(ORDER_RETURN.limit.instructions);
const quantity = z.number().int().min(ORDER_RETURN.amount.minimumQuantity).max(ORDER_RETURN.amount.maximum);
function uniqueItems<T extends {orderItemId: string}>(items: T[]) { return new Set(items.map(item => item.orderItemId)).size === items.length; }
const uuid = z.uuid().toLowerCase();
export const returnItemsSchema = z.array(z.object({orderItemId: uuid, quantity}).strict())
  .min(ORDER_RETURN.limit.minimumItems).max(ORDER_RETURN.limit.maximumItems)
  .refine(uniqueItems, ORDER_RETURN.protocol.duplicateMessage);
export const returnSelectionSchema = z.object({items: returnItemsSchema}).strict();
export const createOrderReturnSchema = returnSelectionSchema.extend({requestId: uuid, reason, quoteFingerprint: z.string().regex(ORDER_RETURN.fingerprint.pattern)}).strict();
const receivedItems = z.array(z.object({orderItemId: uuid, restockQuantity: z.number().int().min(ORDER_RETURN.amount.zero).max(ORDER_RETURN.amount.maximum)}).strict())
  .min(ORDER_RETURN.limit.minimumItems).max(ORDER_RETURN.limit.maximumItems).refine(uniqueItems, ORDER_RETURN.protocol.duplicateMessage);
export const orderReturnActionSchema = z.discriminatedUnion(ORDER_RETURN.protocol.action, [
  z.object({action: z.literal(RETURN_ACTION.approve), expectedVersion, instructions}).strict(),
  z.object({action: z.literal(RETURN_ACTION.reject), expectedVersion, reason}).strict(),
  z.object({action: z.literal(RETURN_ACTION.withdraw), expectedVersion}).strict(),
  z.object({action: z.literal(RETURN_ACTION.dispute), expectedVersion, reason}).strict(),
  z.object({action: z.literal(RETURN_ACTION.send), expectedVersion, ...parcelTrackingFields}).strict(),
  z.object({action: z.literal(RETURN_ACTION.receive), expectedVersion, items: receivedItems}).strict(),
  z.object({action: z.literal(RETURN_ACTION.arbitrateApprove), expectedVersion, reason, instructions}).strict(),
  z.object({action: z.literal(RETURN_ACTION.arbitrateReject), expectedVersion, reason}).strict(),
  z.object({action: z.literal(RETURN_ACTION.retryRefund), expectedVersion}).strict(),
]);
export type CreateOrderReturn = z.infer<typeof createOrderReturnSchema>;
export type OrderReturnAction = z.infer<typeof orderReturnActionSchema>;

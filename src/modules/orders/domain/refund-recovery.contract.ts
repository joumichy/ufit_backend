import {z} from 'zod';
import {CANCELLATION_REFUND, type CancellationProviderStatus} from './order-lifecycle';

export const REFUND_RECOVERY = {
  repository: Symbol('RefundRecoveryRepository'),
  roles: ['admin', 'super_admin'] as const,
  cursorEncoding: 'base64url',
  search: {maximumLength: 120, minimumLength: 1, noMatch: 0},
  column: {kind: 'kind', id: 'origin_id', orderId: 'order_id', brandId: 'brand_id', brandName: 'brand_name', orderNumber: 'order_number', amount: 'amount', attemptAmount: 'attempt_amount', currency: 'currency', attemptCurrency: 'attempt_currency', failedAt: 'failed_at', attemptId: 'attempt_id', attemptNumber: 'attempt_number', state: 'refund_state', providerStatus: 'provider_status', refundId: 'refund_id'},
  route: {root: 'admin/refund-recoveries', detail: ':kind/:id', kind: 'kind', id: 'id'},
  kind: {orderReturn: 'return', cancellation: 'cancellation'},
  cause: {failed: 'original_method_failed', blocked: 'original_method_blocked'},
  page: {defaultLimit: 20, maximumLimit: 50, minimumLimit: 1, overflow: 1, first: 0, last: -1},
  amount: {zero: 0, maximum: 2147483647},
  query: {rows: 'refund_recovery_rows', returnLatest: 'refund_recovery_return_latest', cancellationLatest: 'refund_recovery_cancellation_latest'},
  failure: {
    input: {code: 'refund_recovery_input_invalid', message: 'Invalid refund recovery query'},
    cursor: {code: 'refund_recovery_cursor_changed', message: 'The refund recovery queue changed; refresh before continuing'},
    missing: {code: 'refund_recovery_not_found', message: 'This refund no longer requires recovery'},
    persisted: {code: 'refund_recovery_persisted_invalid', message: 'The recorded refund recovery is inconsistent'},
  },
} as const;
export type RefundRecoveryKind = typeof REFUND_RECOVERY.kind[keyof typeof REFUND_RECOVERY.kind];
export type RefundRecoveryCause = typeof REFUND_RECOVERY.cause[keyof typeof REFUND_RECOVERY.cause];
export const refundRecoveryKindSchema = z.enum(Object.values(REFUND_RECOVERY.kind));
export const refundRecoveryCursorSchema = z.object({kind: refundRecoveryKindSchema, id: z.uuid()}).strict();
export const refundRecoveryQuerySchema = z.object({
  limit: z.coerce.number().int().min(REFUND_RECOVERY.page.minimumLimit).max(REFUND_RECOVERY.page.maximumLimit).default(REFUND_RECOVERY.page.defaultLimit),
  search: z.string().trim().min(REFUND_RECOVERY.search.minimumLength).max(REFUND_RECOVERY.search.maximumLength).optional(),
  kind: refundRecoveryKindSchema.optional(), cursor: z.string().min(REFUND_RECOVERY.page.minimumLimit).optional(),
}).strict();
export interface RefundRecoveryQuery {limit: number; kind?: RefundRecoveryKind; search?: string; cursor?: z.infer<typeof refundRecoveryCursorSchema>;}
export interface RefundRecoverySummary {
  kind: RefundRecoveryKind; id: string; orderId: string; brandId: string; brandName: string; orderNumber: string;
  amount: number; currency: string; failedAt: string; cause: RefundRecoveryCause;
}
export interface RefundRecoveryDetail {
  summary: RefundRecoverySummary;
  attempt: {id: string; number: number; state: typeof CANCELLATION_REFUND.state.failed | typeof CANCELLATION_REFUND.state.blocked; providerStatus: CancellationProviderStatus | null; refundId: string | null};
}
export interface RefundRecoveryPage {items: RefundRecoverySummary[]; totalCount: number; nextCursor: string | null;}
export interface RefundRecoveryRepository {
  list(query: RefundRecoveryQuery): Promise<RefundRecoveryPage>;
  detail(kind: RefundRecoveryKind, id: string): Promise<RefundRecoveryDetail | undefined>;
}
export function refundRecoveryCursor(item: RefundRecoverySummary): string {
  const cursor: z.infer<typeof refundRecoveryCursorSchema> = {kind: item.kind, id: item.id};
  return Buffer.from(JSON.stringify(cursor)).toString(REFUND_RECOVERY.cursorEncoding);
}

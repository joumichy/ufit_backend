import {ConflictException} from '@nestjs/common';
import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {PROFILE_KIND} from '../../../shared/domain/profile-editing.contract';
import {commissionReleaseSchema, commissionReleaseStatus} from '../../commissions/domain/commission-release';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';

export const WORKSPACE_FINANCE = {
  scope: PROFILE_KIND,
  basis: {orderTotal: 'order_total', attributedMerchandise: 'attributed_merchandise'},
  zero: 0,
  single: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  lowStockThreshold: 3,
  basisPoints: 10000,
  timestamp: {zone: 'UTC', format: 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'},
  integerPattern: /^(0|[1-9][0-9]*)$/,
  failure: {
    persisted: {code: 'workspace_finance_persisted_invalid', message: 'The saved workspace financial records require verification'},
    access: {code: 'workspace_finance_access_required', message: 'Access to this workspace is required'},
  },
} as const;
export const WORKSPACE_COMMISSION_FIELDS = ['originalAmount', 'adjustedAmount', 'netAmount', 'estimatedAmount', 'pendingAmount', 'validatedAmount', 'paidAmount', 'paidAdjustmentAmount',
  'estimatedCount', 'pendingCount', 'validatedCount', 'paidCount', 'cancelledCount'] as const;
export type WorkspaceFinanceScope = {kind: (typeof PROFILE_KIND)[keyof typeof PROFILE_KIND]; profileId: string};
const integer = z.number().int().min(WORKSPACE_FINANCE.zero).max(WORKSPACE_FINANCE.maximum);
const currency = z.string().refine(value => CURRENCY_CODES.includes(value));
const sum = (values: number[]) => values.reduce((total, value) => total + BigInt(value), BigInt(WORKSPACE_FINANCE.zero));
export const workspaceSalesCurrencySchema = z.object({
  currency,
  capturedOrderCount: integer.min(WORKSPACE_FINANCE.single),
  capturedAmount: integer,
  refundedAmount: integer,
  refundInProgressAmount: integer,
  netAmount: integer,
}).strict().refine(value => BigInt(value.capturedAmount) - BigInt(value.refundedAmount) === BigInt(value.netAmount)
  && sum([value.refundedAmount, value.refundInProgressAmount]) <= BigInt(value.capturedAmount));
export const workspaceSalesSchema = z.object({
  basis: z.enum([WORKSPACE_FINANCE.basis.orderTotal, WORKSPACE_FINANCE.basis.attributedMerchandise]),
  currencies: z.array(workspaceSalesCurrencySchema),
}).strict().refine(value => new Set(value.currencies.map(row => row.currency)).size === value.currencies.length);
export type WorkspaceSalesCurrency = z.infer<typeof workspaceSalesCurrencySchema>;
export type WorkspaceSales = z.infer<typeof workspaceSalesSchema>;

export const workspaceCommissionCurrencySchema = z.object({
  currency,
  originalAmount: integer,
  adjustedAmount: integer,
  netAmount: integer,
  estimatedAmount: integer,
  pendingAmount: integer,
  validatedAmount: integer,
  paidAmount: integer,
  paidAdjustmentAmount: integer,
  estimatedCount: integer,
  pendingCount: integer,
  validatedCount: integer,
  paidCount: integer,
  cancelledCount: integer,
}).strict().refine(value => BigInt(value.originalAmount) - BigInt(value.adjustedAmount) === BigInt(value.netAmount)
  && sum([value.estimatedAmount, value.pendingAmount, value.validatedAmount, value.paidAmount]) - BigInt(value.paidAdjustmentAmount) === BigInt(value.netAmount)
  && value.paidAdjustmentAmount <= value.paidAmount);
export type WorkspaceCommissionCurrency = z.infer<typeof workspaceCommissionCurrencySchema>;
export const workspaceCommissionSchema = z.object({
  id: z.uuid(), orderItemId: z.uuid(), brandId: z.uuid(), sourceOutfitId: z.uuid(),
  status: z.enum(Object.values(ORDER_COMMISSION.status)), currency,
  baseAmount: integer, rateBps: integer.max(WORKSPACE_FINANCE.basisPoints),
  originalAmount: integer, adjustedAmount: integer, netAmount: integer, paidAdjustmentAmount: integer,
  release: commissionReleaseSchema, createdAt: z.iso.datetime(),
}).strict().refine(value => value.status === commissionReleaseStatus(value.release)
  && BigInt(value.originalAmount) - BigInt(value.adjustedAmount) === BigInt(value.netAmount)
  && (value.status === ORDER_COMMISSION.status.paid ? value.paidAdjustmentAmount === value.adjustedAmount : value.paidAdjustmentAmount === WORKSPACE_FINANCE.zero));
export type WorkspaceCommission = z.infer<typeof workspaceCommissionSchema>;

/** SQL emits explicit integer text, preserving exact sums before JSON serialization. */
export function workspaceInteger(value: unknown): number {
  if (typeof value !== 'string' || !WORKSPACE_FINANCE.integerPattern.test(value)) throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
  const parsed = BigInt(value);
  if (parsed > BigInt(WORKSPACE_FINANCE.maximum)) throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
  return Number(parsed);
}
export function requireWorkspaceProjection<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
  return parsed.data;
}

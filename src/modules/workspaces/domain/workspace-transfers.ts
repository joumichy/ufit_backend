import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {allocationIDSchema, PAYMENT_ALLOCATION} from '../../payments/domain/payment-allocation';
import {PAYMENT_TRANSFER, transferSnapshotSchema, reversalSnapshotSchema} from '../../payments/domain/payment-transfer';
import {DISBURSEMENT_EXECUTION} from '../../payments/domain/payment-disbursement.repository';
import {WORKSPACE_FINANCE} from './workspace-finance';

export const WORKSPACE_TRANSFERS = {
  route: {creator: 'creators/me/transfers', brand: 'brands/:brandProfileId/transfers', brandId: 'brandProfileId'},
  roles: {creator: ['creator'], brand: ['brand_owner', 'brand_manager']},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  limits: {zero: 0, one: 1, page: 20, maximumPage: 50, maximum: Number.MAX_SAFE_INTEGER},
  revision: {pattern: /^[a-f0-9]{32}$/, empty: '[]'},
  failure: {
    input: {code: 'workspace_transfers_input_invalid', message: 'Invalid transfer history query'},
    cursor: {code: 'workspace_transfers_cursor_invalid', message: 'The transfer history cursor is not available'},
    changed: {code: 'workspace_transfers_changed', message: 'The transfers changed; refresh before continuing'},
    persisted: {code: 'workspace_transfers_persisted_invalid', message: 'The recorded transfers require verification'},
  },
} as const;
const C = WORKSPACE_TRANSFERS, T = PAYMENT_TRANSFER, E = DISBURSEMENT_EXECUTION;
const integer = z.number().int().min(C.limits.zero).max(C.limits.maximum);
const positive = integer.min(C.limits.one), currency = z.enum(CURRENCY_CODES);
const nonempty = z.string().trim().min(C.limits.one);
export const workspaceTransferQuerySchema = z.object({
  limit: z.coerce.number().int().min(C.limits.one).max(C.limits.maximumPage).default(C.limits.page),
  cursor: allocationIDSchema.optional(), revision: z.string().regex(C.revision.pattern).optional(),
}).strict().refine(value => (value.cursor === undefined) === (value.revision === undefined));
export type WorkspaceTransferQuery = z.infer<typeof workspaceTransferQuerySchema>;
export const workspaceTransferEntrySchema = z.object({
  id: allocationIDSchema, kind: z.enum(Object.values(E.operation)), amount: positive.max(T.maximumAmount),
  currency, liveMode: z.boolean(), createdAt: z.iso.datetime(), recordedAt: z.iso.datetime(),
  orderNumber: nonempty, brandName: nonempty, itemName: nonempty.nullable(),
  receiptId: z.union([transferSnapshotSchema.shape.id, reversalSnapshotSchema.shape.id]), originalTransferId: transferSnapshotSchema.shape.id.nullable(),
}).strict().refine(value => value.kind === E.operation.transfer
  ? value.receiptId.startsWith(T.provider.transferPrefix) && value.originalTransferId === null
  : value.receiptId.startsWith(T.provider.reversalPrefix) && value.originalTransferId?.startsWith(T.provider.transferPrefix) === true);
export type WorkspaceTransferEntry = z.infer<typeof workspaceTransferEntrySchema>;
export const workspaceTransferCurrencySchema = z.object({
  currency, liveMode: z.boolean(), transferred: positive, recovered: integer, netTransferred: integer,
  transferCount: positive, reversalCount: integer,
}).strict().refine(value => BigInt(value.transferred) - BigInt(value.recovered) === BigInt(value.netTransferred));
export const workspaceTransferPageSchema = z.object({
  profileId: allocationIDSchema, kind: z.enum(Object.values(WORKSPACE_FINANCE.scope)), asOf: z.iso.datetime(),
  limit: positive.max(C.limits.maximumPage), totalCount: integer, nextCursor: allocationIDSchema.nullable(),
  revision: z.string().regex(C.revision.pattern), currencies: z.array(workspaceTransferCurrencySchema),
  items: z.array(workspaceTransferEntrySchema),
}).strict().refine(value => {
  const groups = value.currencies;
  return new Set(groups.map(row => JSON.stringify([row.currency, row.liveMode]))).size === groups.length
    && groups.reduce((sum, row) => sum + BigInt(row.transferCount) + BigInt(row.reversalCount), BigInt(C.limits.zero)) === BigInt(value.totalCount)
    && value.items.length <= value.limit && value.items.length <= value.totalCount
    && new Set(value.items.map(row => row.id)).size === value.items.length
    && value.items.every(row => groups.some(group => group.currency === row.currency && group.liveMode === row.liveMode)
      && (value.kind === PAYMENT_ALLOCATION.kind.creator ? row.itemName !== null : row.itemName === null))
    && (value.nextCursor === null || (value.items.length === value.limit && value.nextCursor === value.items.at(-C.limits.one)?.id));
});
export type WorkspaceTransferPage = z.infer<typeof workspaceTransferPageSchema>;

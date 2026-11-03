import {sql} from 'drizzle-orm';
import {PAYMENT_ALLOCATION as A} from '../../payments/domain/payment-allocation';
import {DISBURSEMENT_EXECUTION as E} from '../../payments/domain/payment-disbursement.repository';
import {transferSnapshotSchema, reversalSnapshotSchema} from '../../payments/domain/payment-transfer';
import {FROZEN_ITEM} from '../../orders/infrastructure/frozen-order-item';
import {WORKSPACE_FINANCE as F, type WorkspaceFinanceScope} from '../domain/workspace-finance';

const S = transferSnapshotSchema.keyof().enum, R = reversalSnapshotSchema.keyof().enum;

/** Relational allocation ownership scopes both transfers and their reversals. */
export function workspaceTransferFacts(scope: WorkspaceFinanceScope) {
  const owner = scope.kind === F.scope.creator ? sql`l.creator_id=${scope.profileId}` : sql`l.brand_id=${scope.profileId}`;
  const key = scope.kind === F.scope.creator
    ? sql`${A.kind.creator} || ${A.key.separator} || l.creator_id::text || ${A.key.separator} || l.commission_id::text`
    : sql`${A.kind.brand} || ${A.key.separator} || l.brand_id::text`;
  return sql`with transfer_records as (
    select op.id,op.kind,r.amount,r.currency,s.live_mode,r.recorded_at,
      r.snapshot->>${S.createdAt} as created_at,r.provider_id as receipt_id,
      original_receipt.provider_id as original_transfer_id,
      o.order_number,b.brand_name,
      case when l.kind=${A.kind.creator} then oi.product_snapshot->>${FROZEN_ITEM.name} else null end as item_name,
      (op.state<>${E.operationState.recorded} or r.operation_id is null or r.kind<>op.kind
        or op.kind not in (${E.operation.transfer},${E.operation.reversal})
        or r.amount<=${F.zero} or r.currency<>s.settlement_currency
        or r.snapshot->>${S.amount} is distinct from r.amount::text
        or r.snapshot->>${S.currency} is distinct from r.currency
        or r.snapshot->>${S.id} is distinct from r.provider_id
        or r.snapshot->>${S.createdAt} is null
        or o.id<>p.order_id or o.brand_id<>p.brand_id or b.brand_name is null
        or (l.kind=${A.kind.creator} and (c.id is null or c.creator_id<>l.creator_id or oi.order_id<>o.id
          or jsonb_typeof(oi.product_snapshot->${FROZEN_ITEM.name}) is distinct from ${FROZEN_ITEM.jsonString}))
        or (op.kind=${E.operation.transfer} and (op.original_operation_id is not null
          or r.snapshot->>${S.liveMode} is distinct from s.live_mode::text))
        or (op.kind=${E.operation.reversal} and (original_receipt.operation_id is null
          or original_op.kind<>${E.operation.transfer} or original_op.state<>${E.operationState.recorded}
          or original_op.payment_id<>op.payment_id or original_op.allocation_key<>op.allocation_key
          or r.snapshot->>${R.transferId} is distinct from original_receipt.provider_id))) as invalid
    from ufit.payment_allocation_lines l
    join ufit.payment_allocations p on p.payment_id=l.payment_id
    join ufit.payment_settlements s on s.payment_id=p.payment_id
    join ufit.orders o on o.id=p.order_id
    join ufit.brand_profiles b on b.id=o.brand_id
    join ufit.payment_transfer_operations op on op.payment_id=l.payment_id and op.allocation_key=${key}
    left join ufit.payment_transfer_receipts r on r.operation_id=op.id and r.payment_id=op.payment_id
    left join ufit.payment_transfer_operations original_op on original_op.id=op.original_operation_id
    left join ufit.payment_transfer_receipts original_receipt on original_receipt.operation_id=original_op.id
    left join ufit.commissions c on c.id=l.commission_id
    left join ufit.order_items oi on oi.id=c.order_item_id
    where l.kind=${scope.kind} and ${owner} and (op.state=${E.operationState.recorded} or r.operation_id is not null)
  )`;
}

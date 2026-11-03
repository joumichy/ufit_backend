import {sql} from 'drizzle-orm';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';
import {WORKSPACE_FINANCE,workspaceInteger,requireWorkspaceProjection} from '../../workspaces/domain/workspace-finance';
import {COMMISSION_RULE} from '../domain/commission-rule.contract';
import {COMMISSION_ENTRY,commissionEntrySchema,type CommissionEntry} from '../domain/commission-entry.contract';

export const commissionEntryColumns=sql`id,order_item_id as "orderItemId",brand_id as "brandId",source_outfit_id as "sourceOutfitId",
  creator_id as "creatorId",creator_name as "creatorName",order_number as "orderNumber",product_name as "productName",brand_name as "brandName",quantity::text as quantity,
  status,currency,release_state as "releaseState",available_at as "availableAt",base_amount::text as "baseAmount",
  (commission_rate*${COMMISSION_RULE.limits.basisPoints})::integer::text as "rateBps",original::text as "originalAmount",adjusted::text as "adjustedAmount",
  (original-adjusted)::text as "netAmount",(case when status=${ORDER_COMMISSION.status.paid} then returned else ${WORKSPACE_FINANCE.zero} end)::text as "paidAdjustmentAmount",
  to_char(created_at at time zone ${COMMISSION_ENTRY.timestamp.zone},${COMMISSION_ENTRY.timestamp.format}) as "createdAt"`;

export function projectCommissionEntry(row:Record<string,unknown>):CommissionEntry {
  return requireWorkspaceProjection(commissionEntrySchema,{
    id:row.id,orderItemId:row.orderItemId,brandId:row.brandId,sourceOutfitId:row.sourceOutfitId,
    creator:{id:row.creatorId,name:row.creatorName},sale:{orderNumber:row.orderNumber,productName:row.productName,brandName:row.brandName,quantity:workspaceInteger(row.quantity)},
    status:row.status,currency:row.currency,baseAmount:workspaceInteger(row.baseAmount),rateBps:workspaceInteger(row.rateBps),
    originalAmount:workspaceInteger(row.originalAmount),adjustedAmount:workspaceInteger(row.adjustedAmount),netAmount:workspaceInteger(row.netAmount),paidAdjustmentAmount:workspaceInteger(row.paidAdjustmentAmount),
    release:{state:row.releaseState,availableAt:row.availableAt},createdAt:row.createdAt,
  });
}

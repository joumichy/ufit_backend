import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';
import {COMMISSION_RULE} from './commission-rule.contract';
import {commissionReleaseSchema,commissionReleaseStatus} from './commission-release';

export const COMMISSION_ENTRY = {
  limit:{zero:0,one:1,maximum:Number.MAX_SAFE_INTEGER},
  timestamp:{zone:'UTC',format:'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'},
} as const;
const amount=z.number().int().min(COMMISSION_ENTRY.limit.zero).max(COMMISSION_ENTRY.limit.maximum);
const text=z.string().refine(value=>value.trim().length>=COMMISSION_ENTRY.limit.one);
export const commissionEntrySchema=z.object({
  id:z.uuid(),orderItemId:z.uuid(),brandId:z.uuid(),sourceOutfitId:z.uuid(),
  creator:z.object({id:z.uuid(),name:text}).strict(),
  sale:z.object({orderNumber:text,productName:text,brandName:text,quantity:amount.min(COMMISSION_ENTRY.limit.one)}).strict(),
  status:z.enum(Object.values(ORDER_COMMISSION.status)),currency:z.string().refine(value=>CURRENCY_CODES.includes(value)),
  baseAmount:amount,rateBps:amount.max(COMMISSION_RULE.limits.basisPoints),originalAmount:amount,adjustedAmount:amount,netAmount:amount,paidAdjustmentAmount:amount,
  release:commissionReleaseSchema,createdAt:z.iso.datetime(),
}).strict().refine(value=>value.status===commissionReleaseStatus(value.release)
  && BigInt(value.originalAmount)-BigInt(value.adjustedAmount)===BigInt(value.netAmount)
  && (value.status===ORDER_COMMISSION.status.paid?value.paidAdjustmentAmount===value.adjustedAmount:value.paidAdjustmentAmount===COMMISSION_ENTRY.limit.zero));
export type CommissionEntry=z.infer<typeof commissionEntrySchema>;

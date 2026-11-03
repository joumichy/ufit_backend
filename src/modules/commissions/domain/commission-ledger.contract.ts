import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {RETURN_STATUS} from '../../orders/domain/order-return.contract';
import {COMMISSION_RELEASE} from './commission-release';
import {COMMISSION_ENTRY,commissionEntrySchema} from './commission-entry.contract';
import {COMMISSION_RULE} from './commission-rule.contract';

export const COMMISSION_LEDGER={
  repository:Symbol('CommissionLedgerRepository'),route:{root:'admin/commissions',creator:'creators/me/commissions',id:':id',returns:':id/returns',idParameter:'id'},creatorRole:'creator',
  cache:{header:'Cache-Control',value:'private, no-store'},
  limits:{zero:0,one:1,page:20,maximumPage:50,search:200,maximum:Number.MAX_SAFE_INTEGER},
  revision:{pattern:/^[a-f0-9]{32}$/,emptyJson:'[]'},search:{wildcard:'%',escape:'\\'},
  failure:{
    input:{code:'commission_ledger_input_invalid',message:'Invalid commission ledger query'},
    access:{code:'commission_ledger_access_required',message:'Active administration access is required'},
    missing:{code:'commission_ledger_not_found',message:'Commission not found'},
    cursor:{code:'commission_ledger_cursor_invalid',message:'Invalid commission ledger cursor'},
    changed:{code:'commission_ledger_changed',message:'The commissions changed; refresh before continuing'},
  },
} as const;
const limits=COMMISSION_LEDGER.limits;
const amount=z.number().int().min(limits.zero).max(limits.maximum);
const currency=z.string().refine(value=>CURRENCY_CODES.includes(value));
const cursorFields={cursor:z.uuid().optional(),revision:z.string().regex(COMMISSION_LEDGER.revision.pattern).optional(),
  limit:z.coerce.number().int().min(limits.one).max(limits.maximumPage).default(limits.page)};
const cursorPair=(value:{cursor?:string;revision?:string})=>(value.cursor===undefined)===(value.revision===undefined);
export const commissionLedgerQuerySchema=z.object({...cursorFields,state:z.enum(Object.values(COMMISSION_RELEASE.state)).optional(),
  currency:currency.optional(),search:z.string().trim().max(limits.search).default(String())}).strict().refine(cursorPair);
export const commissionRelatedQuerySchema=z.object(cursorFields).strict().refine(cursorPair);
export type CommissionLedgerQuery=z.infer<typeof commissionLedgerQuerySchema>;
export type CommissionCursorQuery=z.infer<typeof commissionRelatedQuerySchema>;
export const commissionLedgerMetadataSchema=z.object({limit:amount.min(limits.one).max(limits.maximumPage),totalCount:amount,
  nextCursor:z.uuid().nullable(),revision:z.string().regex(COMMISSION_LEDGER.revision.pattern),asOf:z.iso.datetime(),currencies:z.array(currency)}).strict()
  .refine(value=>new Set(value.currencies).size===value.currencies.length);
export function commissionLedgerPageSchema<T extends {id:string}>(item:z.ZodType<T>){
  return commissionLedgerMetadataSchema.safeExtend({items:z.array(item)}).refine(value=>value.items.length<=value.limit&&value.items.length<=value.totalCount
    &&new Set(value.items.map(row=>row.id)).size===value.items.length
    &&(value.nextCursor===null||(value.items.length>limits.zero&&value.nextCursor===value.items.at(-limits.one)!.id)));
}
export type CommissionLedgerPage<T>={items:T[];limit:number;totalCount:number;nextCursor:string|null;revision:string;asOf:string;currencies:string[]};
const ruleSchema=z.object({id:z.uuid(),scopeId:z.uuid(),revision:amount.min(limits.one),creatorGradeCode:z.string().min(limits.one),
  baseRateBps:amount.max(COMMISSION_RULE.limits.basisPoints),bonusRateBps:amount.max(COMMISSION_RULE.limits.basisPoints),maxRateBps:amount.max(COMMISSION_RULE.limits.basisPoints).nullable()}).strict();
export const commissionLedgerDetailSchema=z.object({commission:commissionEntrySchema,orderId:z.uuid(),relatedReturnCount:amount,rule:ruleSchema.nullable(),asOf:z.iso.datetime()}).strict();
export type CommissionLedgerDetail=z.infer<typeof commissionLedgerDetailSchema>;
export const commissionRelatedReturnSchema=z.object({id:z.uuid(),status:z.enum(Object.values(RETURN_STATUS)),version:amount.min(limits.one),
  requestedAt:z.iso.datetime(),quantity:amount.min(limits.one),adjustedAmount:amount,currency}).strict();
export type CommissionRelatedReturn=z.infer<typeof commissionRelatedReturnSchema>;
export const commissionLedgerIdSchema=z.uuid();

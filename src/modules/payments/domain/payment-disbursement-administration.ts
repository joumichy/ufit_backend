import {z} from 'zod';
import {paymentSettlementIDSchema} from './payment-settlement';
import {allocationContextSchema,allocationDocumentSchema,PAYMENT_ALLOCATION as A} from './payment-allocation';
import {PAYMENT_DISBURSEMENT as D,disbursementAssessmentSchema} from './payment-disbursement';
import {DISBURSEMENT_EXECUTION as E} from './payment-disbursement.repository';
import {PAYMENT_TRANSFER as T} from './payment-transfer';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import type {IdentityAccess} from '../../identity/domain/user.types';

export const DISBURSEMENT_ADMINISTRATION={
  state:{absent:'not_requested'},
  route:{root:'admin/payments',document:':id/disbursements',resume:':id/disbursements-resume',id:'id'},
  cache:{header:'Cache-Control',value:'private, no-store'},accepted:202,
  failure:{invalid:{code:'disbursement_request_invalid',message:'Invalid disbursement request'},
    access:{code:'disbursement_admin_required',message:'Active administration access is required'},
    missing:{code:'disbursement_not_found',message:'The payment capture is not available'},
    persisted:{code:'disbursement_document_invalid',message:'The disbursement document requires verification'}},
} as const;
const C=DISBURSEMENT_ADMINISTRATION;
export const disbursementResumeSchema=z.object({}).strict();
export const disbursementDocumentSchema=z.object({paymentId:paymentSettlementIDSchema,orderId:paymentSettlementIDSchema,asOf:z.iso.datetime(),
  allocation:z.object({state:allocationDocumentSchema.shape.state,blockReason:allocationDocumentSchema.shape.blockReason,context:allocationContextSchema}).strict()
    .refine(value=>(value.state===A.state.blocked)===(value.blockReason!==null)),
  state:z.enum([C.state.absent,...Object.values(E.state)]),reason:z.string().nonempty().nullable(),nextAttemptAt:z.iso.datetime().nullable(),
  assessment:disbursementAssessmentSchema.nullable(),assessmentRecordedAt:z.iso.datetime().nullable(),operations:z.array(z.object({id:paymentSettlementIDSchema,
    kind:z.enum(Object.values(E.operation)),armed:z.boolean(),state:z.enum(Object.values(E.operationState)),allocationKey:z.string().nonempty(),
    originalOperationId:paymentSettlementIDSchema.nullable(),amount:z.number().int().positive().max(T.maximumAmount),currency:z.enum(CURRENCY_CODES),
    funding:z.enum(Object.values(T.funding)).nullable(),createdAt:z.iso.datetime(),
    receipt:z.object({id:z.string().nonempty(),recordedAt:z.iso.datetime()}).strict().nullable(),
  }).strict().refine(row=>(row.state===E.operationState.recorded)===(row.receipt!==null)
    && (row.kind===E.operation.transfer)===(row.funding!==null) && (row.kind===E.operation.reversal)===(row.originalOperationId!==null)))}).strict().refine(value=>{
    const allocation=value.allocation,assessment=value.assessment;
    if(allocation.state!==A.state.recorded)return assessment===null && value.operations.length===E.limits.zero;
    if(allocation.context.liveMode===null)return false;
    if(assessment===null || assessment.phase===D.phase.review)return value.operations.length===E.limits.zero;
    return assessment.paymentId===value.paymentId && assessment.orderId===value.orderId && assessment.brandId===allocation.context.brand.id
      && value.operations.every(operation=>operation.currency===assessment.currency
        && assessment.lines.some(line=>line.key===operation.allocationKey && line.recipient.kind!==A.kind.platform))
      && allocation.context.creatorItems.length===assessment.lines.filter(line=>line.recipient.kind===A.kind.creator).length
      && allocation.context.creatorItems.every(item=>assessment.lines.some(line=>line.recipient.kind===A.kind.creator
        && line.recipient.commissionId===item.commissionId && line.recipient.beneficiaryId===item.creatorId));
  });
export type DisbursementDocument=z.infer<typeof disbursementDocumentSchema>;
export interface DisbursementAdministrationSession {
  lockOrder(paymentId:string):Promise<void>;
  access(actorId:string,write:boolean):Promise<IdentityAccess|undefined>;
  document(paymentId:string):Promise<DisbursementDocument|undefined>;
  resume(paymentId:string):Promise<void>;
}
export interface DisbursementAdministrationRepository {
  administration<T>(write:boolean,operation:(session:DisbursementAdministrationSession)=>Promise<T>):Promise<T>;
}

import {z} from 'zod';
import {paymentSettlementIDSchema} from './payment-settlement';
import {disbursementAssessmentSchema} from './payment-disbursement';
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
  state:z.enum([C.state.absent,...Object.values(E.state)]),reason:z.string().nonempty().nullable(),nextAttemptAt:z.iso.datetime().nullable(),
  assessment:disbursementAssessmentSchema.nullable(),assessmentRecordedAt:z.iso.datetime().nullable(),operations:z.array(z.object({id:paymentSettlementIDSchema,
    kind:z.enum(Object.values(E.operation)),armed:z.boolean(),state:z.enum(Object.values(E.operationState)),allocationKey:z.string().nonempty(),
    originalOperationId:paymentSettlementIDSchema.nullable(),amount:z.number().int().positive().max(T.maximumAmount),currency:z.enum(CURRENCY_CODES),
    funding:z.enum(Object.values(T.funding)).nullable(),createdAt:z.iso.datetime(),
    receipt:z.object({id:z.string().nonempty(),recordedAt:z.iso.datetime()}).strict().nullable(),
  }).strict().refine(row=>(row.state===E.operationState.recorded)===(row.receipt!==null)
    && (row.kind===E.operation.transfer)===(row.funding!==null) && (row.kind===E.operation.reversal)===(row.originalOperationId!==null)))}).strict();
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

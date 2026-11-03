import {calculateDisbursement} from '../../src/modules/payments/domain/payment-disbursement';
import {type DisbursementContext,type DisbursementTransfer} from '../../src/modules/payments/domain/payment-disbursement.repository';
import {transferSnapshotSchema,PAYMENT_TRANSFER as T} from '../../src/modules/payments/domain/payment-transfer';
import {refundDocumentSchema} from '../../src/modules/payments/domain/refund-settlement';
import {F,transferFixture} from './payment-transfer.fixtures';

export const P={scan:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',otherOperation:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  otherTransfer:'tr_SecondPayment',reversal:'trr_RecoveredCreator',creatorKey:'creator/'+F.id.creator+'/'+F.id.commission} as const;
export function context():DisbursementContext {
  const brand=transferFixture(T.kind.brand),creator=transferFixture();
  const refunds=refundDocumentSchema.parse({source:brand.refunds.source,state:'synced',asOf:F.date.created,generation:1,observedGeneration:1,
    failureCode:null,nextAttemptAt:null,snapshot:{...brand.refunds,id:P.scan,generation:1,recordedAt:F.date.created}});
  const basis={plan:brand.plan,subtotal:F.money.subtotal,platformRateBps:F.money.platformBps,refunds,merchandiseRemaining:F.money.subtotal,
    refundLiability:0,remainingCommissions:[{commissionId:F.id.commission,amount:F.money.creator}],expectedStripeRefunds:[],refundOutstanding:false};
  return {plan:brand.plan,basis,assessment:calculateDisbursement(basis),availability:[brand,creator].map(f=>({key:f.instruction.allocationKey,
    releaseState:f.instruction.recipient.kind===T.kind.creator?'payable':null,allowed:true,reason:null,availableAt:null,account:f.account}))};
}
export function transfer(kind:typeof T.kind[keyof typeof T.kind]=T.kind.brand):DisbursementTransfer {
  const f=transferFixture(kind),i={...f.instruction,id:kind===T.kind.brand?F.id.operation:P.otherOperation};
  return {instruction:i,snapshot:transferSnapshotSchema.parse({id:kind===T.kind.brand?F.provider.transfer:P.otherTransfer,amount:i.amount,
    currency:i.currency,destination:i.account.stripeAccountId,sourceChargeId:i.capture.chargeId,transferGroup:'order:'+i.orderId,
    liveMode:false,createdAt:F.date.created,reversedAmount:0}),reversals:[]};
}

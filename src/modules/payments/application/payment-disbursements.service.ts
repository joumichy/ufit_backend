import {randomUUID} from 'node:crypto';
import {Inject, Injectable} from '@nestjs/common';
import {allocationRecipientKey, PAYMENT_ALLOCATION} from '../domain/payment-allocation';
import {getEnv} from '../../../config/env';
import {CONNECT} from '../domain/connect-account';
import {STRIPE_CLIENT} from './stripe-commerce';
import {DISBURSEMENT_EXECUTION as C, type DisbursementExecutionRepository, type DisbursementExecutionSession,
  type DisbursementOperation, type DisbursementTransfer} from '../domain/payment-disbursement.repository';
import {planDisbursement, matchesDisbursementDecision, validDisbursementLedger, fundedCommissionIds} from '../domain/payment-disbursement-planning';
import {PAYMENT_TRANSFER as T, transferInstructionSchema, reversalInstructionSchema, type TransferFailure} from '../domain/payment-transfer';
import {recoverStripeTransfer, recoverStripeReversal, type StripeTransferClient} from '../infrastructure/stripe-transfer-reconciliation';
import {executeStripeTransfer} from '../infrastructure/stripe-transfer';
import {executeStripeTransferReversal} from '../infrastructure/stripe-transfer-reversal';

@Injectable()
export class PaymentDisbursementsService {
  private readonly mode=selectedMode();
  constructor(@Inject(C.repository) private readonly repository:DisbursementExecutionRepository,
    @Inject(STRIPE_CLIENT) private readonly stripe:StripeTransferClient|null) {}
  get canExecute():boolean{return this.stripe!==null && this.mode!==undefined;}
  async recoverDue():Promise<void> {
    const stripe=this.stripe,mode=this.mode;
    if (!stripe || mode===undefined) return;
    await this.repository.discover();
    const claims=await this.repository.claim();
    await Promise.allSettled(claims.map(claim=>this.repository.withLease(claim,session=>this.execute(session,stripe,mode))));
  }
  private async execute(session:DisbursementExecutionSession,stripe:StripeTransferClient,mode:boolean):Promise<void> {
    const open=session.open;
    // An accepted transfer is a fact even if today's profile, deadline or refund now forbids a new one.
    if (open) {
      const operation=open.operation, original=operation.kind===C.operation.transfer?operation.instruction:operation.instruction.original;
      if (original.capture.liveMode!==mode) return session.finish(C.state.review,T.reason.mode,C.limits.zero);
      const recovered=operation.kind===C.operation.transfer?await recoverStripeTransfer(stripe,operation.instruction,null)
        :await recoverStripeReversal(stripe,operation.instruction,null);
      if (recovered.kind===T.result.found) {
        await session.record(open,recovered.snapshot);
        return session.finish(C.state.queued,null,C.limits.zero);
      }
      if (recovered.kind!==T.result.absent) return this.failed(session,recovered);
    }
    const context=session.context;
    if (!context) return session.finish(session.failure?C.state.review:C.state.waiting,session.failure??C.reason.absent,C.limits.recheckMs);
    await session.rememberAssessment(context.assessment);
    const ledger=await session.ledger();
    if (!validDisbursementLedger(context,ledger)) return session.finish(C.state.review,C.reason.ledger,C.limits.zero);
    const providerFailure=await this.verifyRecordedTransfers(stripe,ledger);
    if (providerFailure) return this.failed(session,providerFailure);
    const decision=planDisbursement(context,ledger);
    if (open && !matchesDisbursementDecision(decision,open.operation.instruction)) {
      // A timed-out POST can still be executing remotely. Absence alone cannot retire an armed instruction.
      if(open.armed)return session.finish(C.state.waiting,T.reason.uncertain,C.limits.retryMs);
      await session.supersede(open.id);
      return session.finish(C.state.queued,null,C.limits.zero);
    }
    if (!open) {
      await session.markPaid(fundedCommissionIds(context,ledger));
      if (decision.kind===C.decision.review) return session.finish(C.state.review,decision.reason,C.limits.zero);
      if (decision.kind===C.decision.hold) return session.finish(C.state.waiting,decision.reason,nextEvaluation(context.availability));
      if (decision.kind===C.decision.idle) return session.finish(C.state.waiting,C.reason.completed,C.limits.recheckMs);
      let operation:DisbursementOperation;
      if (decision.kind===C.decision.transfer) {
        const line=context.plan.lines.find(row=>allocationRecipientKey(row.recipient)===decision.key);
        if (!line || line.recipient.kind===PAYMENT_ALLOCATION.kind.platform) return session.finish(C.state.review,C.reason.ledger,C.limits.zero);
        const {snapshot,...account}=decision.account;
        operation={kind:C.operation.transfer,instruction:transferInstructionSchema.parse({id:randomUUID(),paymentId:context.plan.paymentId,
          orderId:context.plan.orderId,paymentIntentId:context.basis.refunds.source.paymentIntentId,allocationKey:decision.key,recipient:line.recipient,
          amount:decision.amount,currency:context.plan.settlementCurrency,capture:context.basis.refunds.source.capture,
          funding:decision.funding,refunds:decision.refunds,account})};
      } else operation={kind:C.operation.reversal,instruction:reversalInstructionSchema.parse({id:randomUUID(),original:decision.original,
        transferId:decision.snapshot.id,amount:decision.amount,expectedReversedAmount:decision.expectedReversedAmount})};
      // This transaction commits the instruction before a subsequent lease can send it to Stripe.
      await session.stage(operation,context.assessment);
      return session.finish(C.state.queued,null,C.limits.zero);
    }
    const authorize=async()=>{
      const current=await session.refreshContext();
      if (!current) return {allowed:false as const,reason:T.reason.local};
      const decision=planDisbursement(current,await session.ledger());
      if(!matchesDisbursementDecision(decision,open.operation.instruction))return {allowed:false as const,reason:T.reason.stale};
      return open.armed?{allowed:true as const}:{allowed:false as const,reason:T.reason.arm};
    };
    const operation=open.operation;
    const result=operation.kind===C.operation.transfer?await executeStripeTransfer(stripe,operation.instruction,mode,null,authorize)
      :await executeStripeTransferReversal(stripe,operation.instruction,mode,null,authorize);
    if (result.kind===T.result.recorded) {
      await session.record(open,result.snapshot);
      return session.finish(C.state.queued,null,C.limits.zero);
    }
    if (result.kind===T.result.blocked) {
      if(result.reason===T.reason.arm){await session.arm(open.id);return session.finish(C.state.queued,null,C.limits.zero);}
      if (result.reason===T.reason.refund) await session.requestRefundRead();
      return session.finish(C.state.waiting,result.reason,C.limits.retryMs);
    }
    return this.failed(session,result);
  }
  private async verifyRecordedTransfers(stripe:StripeTransferClient,ledger:DisbursementTransfer[]):Promise<TransferFailure|null> {
    for (const transfer of ledger) {
      const read=await recoverStripeTransfer(stripe,transfer.instruction,transfer.snapshot.id);
      if (read.kind!==T.result.found) return read.kind===T.result.absent?{kind:T.result.review,reason:T.reason.mismatch}:read;
      const expected=transfer.reversals.reduce((sum,row)=>sum+row.amount,C.limits.zero as number);
      if (read.snapshot.reversedAmount!==expected) return {kind:T.result.review,reason:T.reason.mismatch};
    }
    return null;
  }
  private failed(session:DisbursementExecutionSession,result:TransferFailure):Promise<void> {
    return session.finish(result.kind===T.result.review?C.state.review:C.state.waiting,result.reason,C.limits.retryMs);
  }
}
function selectedMode():boolean|undefined {
  const key=getEnv().STRIPE_SECRET_KEY;
  if (key && CONNECT.key.test.some(prefix=>key.startsWith(prefix))) return false;
  if (key && CONNECT.key.live.some(prefix=>key.startsWith(prefix))) return true;
  return undefined;
}
function nextEvaluation(availability:Array<{availableAt:string|null}>):number {
  const now=Date.now();
  return availability.reduce((delay,row)=>row.availableAt && Date.parse(row.availableAt)>now
    ?Math.min(delay,Date.parse(row.availableAt)-now):delay,C.limits.recheckMs as number);
}

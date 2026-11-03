import {describe,expect,it,vi} from 'vitest';
vi.mock('../../src/config/env',()=>({getEnv:()=>({STRIPE_SECRET_KEY:'sk_test_DisbursementFixture'})}));
import {PaymentDisbursementsService} from '../../src/modules/payments/application/payment-disbursements.service';
import {DISBURSEMENT_EXECUTION as C,type DisbursementExecutionRepository,type DisbursementExecutionSession,
  type DisbursementOperation,type DisbursementTransfer,type StoredDisbursementOperation,type DisbursementLease} from '../../src/modules/payments/domain/payment-disbursement.repository';
import {PAYMENT_TRANSFER as T,type TransferSnapshot,type ReversalSnapshot} from '../../src/modules/payments/domain/payment-transfer';
import {context,transfer} from './payment-disbursement.fixtures';
import {F,stripeFixture} from './payment-transfer.fixtures';

function fixture(){
  const c=context();c.availability[0].allowed=false;c.availability[0].reason=T.reason.account;
  let ledger:DisbursementTransfer[]=[];
  const events:string[]=[];
  const session:DisbursementExecutionSession={context:c,open:null,failure:null,
    async rememberAssessment(){return F.id.policy;},
    async ledger(){return ledger;},async refreshContext(){return this.context;},
    async stage(operation:DisbursementOperation){events.push('instruction');this.open={id:operation.instruction.id,armed:false,operation};},
    async record(operation:StoredDisbursementOperation,snapshot:TransferSnapshot|ReversalSnapshot){
      events.push('receipt');if(operation.operation.kind===C.operation.transfer)ledger.push({instruction:operation.operation.instruction,snapshot:snapshot as TransferSnapshot,reversals:[]});
      this.open=null;
    },
    async arm(){events.push('armed');if(this.open)this.open.armed=true;},
    async supersede(){events.push('superseded');this.open=null;},
    async requestRefundRead(){events.push('refund-read');},
    async markPaid(ids){if(ids.length)events.push('paid');},
    async finish(state,reason){events.push(state+':'+reason);},
  };
  const lease={paymentId:F.id.payment,token:F.id.other};let usable=true;
  const repository:DisbursementExecutionRepository={async discover(){},async claim(){return [lease];},
    async withLease<T>(claim:DisbursementLease,operation:(session:DisbursementExecutionSession)=>Promise<T>){expect(claim).toEqual(lease);return usable?operation(session):undefined;}};
  return {c,session,events,repository,setLedger:(rows:DisbursementTransfer[])=>ledger=rows,expire:()=>usable=false};
}
describe('durable disbursement orchestration',()=>{
  it('commits an instruction in its own lease before the first possible provider POST',async()=>{
    const f=fixture(),sdk=stripeFixture(transfer(T.kind.creator).instruction);
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();
    expect(f.session.open?.operation.kind).toBe(C.operation.transfer);expect(f.events).toEqual(['instruction','queued:null']);expect(sdk.calls).toEqual([]);
  });
  it('keeps an unavailable commission waiting without inventing an instruction or paid state',async()=>{
    const f=fixture(),sdk=stripeFixture(transfer(T.kind.creator).instruction);f.c.availability[1].allowed=false;f.c.availability[1].reason=T.reason.returnWindow;
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();expect(f.session.open).toBe(null);expect(f.events).not.toContain('paid');expect(sdk.calls).toEqual([]);
  });
  it('recovers a lost accepted response even after the local profile becomes ineligible',async()=>{
    const f=fixture();await new PaymentDisbursementsService(f.repository,null).recoverDue();
    const placeholder=stripeFixture(transfer(T.kind.creator).instruction);
    await new PaymentDisbursementsService(f.repository,placeholder.client).recoverDue();
    const operation=f.session.open!.operation;if(operation.kind!==C.operation.transfer)throw new Error('Expected transfer');
    const sdk=stripeFixture(operation.instruction),service=new PaymentDisbursementsService(f.repository,sdk.client);sdk.state.loseTransferResponse=true;
    await service.recoverDue();expect(sdk.count(F.calls.create)).toBe(0);expect(f.session.open?.armed).toBe(true);
    await service.recoverDue();expect(f.session.open).not.toBe(null);expect(sdk.count(F.calls.create)).toBe(1);expect(f.events).not.toContain('receipt');
    f.session.context=null;await service.recoverDue();expect(f.session.open).toBe(null);expect(f.events).toContain('receipt');expect(sdk.count(F.calls.create)).toBe(1);
  });
  it('retires an absent obsolete operation before querying account readiness or sending money',async()=>{
    const f=fixture(),placeholder=stripeFixture(transfer(T.kind.creator).instruction);
    await new PaymentDisbursementsService(f.repository,placeholder.client).recoverDue();
    const operation=f.session.open!.operation;if(operation.kind!==C.operation.transfer)throw new Error('Expected transfer');
    const sdk=stripeFixture(operation.instruction);f.c.availability[1].allowed=false;f.c.availability[1].reason=T.reason.returnOpen;
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();
    expect(f.events).toContain('superseded');expect(f.session.open).toBe(null);expect(sdk.methods()).toEqual([F.calls.list]);
  });
  it('keeps an armed stale instruction recoverable instead of replacing a possibly in-flight POST',async()=>{
    const f=fixture(),placeholder=stripeFixture(transfer(T.kind.creator).instruction);
    await new PaymentDisbursementsService(f.repository,placeholder.client).recoverDue();
    const operation=f.session.open!.operation;if(operation.kind!==C.operation.transfer)throw new Error('Expected transfer');
    const sdk=stripeFixture(operation.instruction),service=new PaymentDisbursementsService(f.repository,sdk.client);
    await service.recoverDue();expect(f.session.open?.armed).toBe(true);expect(sdk.count(F.calls.create)).toBe(0);
    f.c.availability[1].allowed=false;f.c.availability[1].reason=T.reason.returnOpen;
    await service.recoverDue();expect(f.session.open).not.toBe(null);expect(f.events).not.toContain('superseded');
    expect(f.events).toContain('waiting:'+T.reason.uncertain);expect(sdk.count(F.calls.create)).toBe(0);
    sdk.state.pages=[{data:[sdk.state.transfer],has_more:false}];
    await service.recoverDue();expect(f.session.open).toBe(null);expect(f.events).toContain('receipt');expect(sdk.count(F.calls.create)).toBe(0);
  });
  it('retains an open instruction when provider recovery is unreadable',async()=>{
    const f=fixture(),placeholder=stripeFixture(transfer(T.kind.creator).instruction);
    await new PaymentDisbursementsService(f.repository,placeholder.client).recoverDue();
    const operation=f.session.open!.operation;if(operation.kind!==C.operation.transfer)throw new Error('Expected transfer');
    const sdk=stripeFixture(operation.instruction);sdk.state.failures.add(F.calls.list);
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();expect(f.session.open).not.toBe(null);expect(f.events).not.toContain('superseded');expect(sdk.count(F.calls.create)).toBe(0);
  });
  it('detects an external reversal against recorded receipts before marking paid or issuing a top-up',async()=>{
    const f=fixture(),row=transfer(T.kind.creator),sdk=stripeFixture(row.instruction);f.setLedger([row]);sdk.state.transfer.id=row.snapshot.id;sdk.state.transfer.amount_reversed=1;
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();
    expect(f.events).toContain('needs_review:'+T.reason.mismatch);expect(f.events).not.toContain('paid');expect(sdk.count(F.calls.create)).toBe(0);
  });
  it('marks a fully funded commission paid only after fresh matching provider observation',async()=>{
    const f=fixture(),row=transfer(T.kind.creator),sdk=stripeFixture(row.instruction);f.setLedger([row]);sdk.state.transfer.id=row.snapshot.id;
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();expect(f.events).toContain('paid');expect(sdk.methods()).toEqual([F.calls.retrieve]);
  });
  it('does nothing with an expired or replaced lease',async()=>{
    const f=fixture(),sdk=stripeFixture(transfer(T.kind.creator).instruction);f.expire();
    await new PaymentDisbursementsService(f.repository,sdk.client).recoverDue();expect(f.events).toEqual([]);expect(sdk.calls).toEqual([]);
  });
});

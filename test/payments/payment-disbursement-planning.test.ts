import {describe,expect,it} from 'vitest';
import {calculateDisbursement} from '../../src/modules/payments/domain/payment-disbursement';
import {planDisbursement,fundedCommissionIds,matchesDisbursementDecision} from '../../src/modules/payments/domain/payment-disbursement-planning';
import {DISBURSEMENT_EXECUTION as C,type DisbursementContext,type DisbursementTransfer} from '../../src/modules/payments/domain/payment-disbursement.repository';
import {transferSnapshotSchema,PAYMENT_TRANSFER as T} from '../../src/modules/payments/domain/payment-transfer';
import {refundDocumentSchema} from '../../src/modules/payments/domain/refund-settlement';
import {F,transferFixture,providerTransfer} from './payment-transfer.fixtures';

import {P,context,transfer} from './payment-disbursement.fixtures';
describe('durable disbursement planning',()=>{
  it('chooses the brand first, then each commission, and never transfers the platform share',()=>{
    const c=context();expect(planDisbursement(c,[])).toMatchObject({kind:C.decision.transfer,amount:F.money.brandSettled,funding:T.funding.charge});
    expect(planDisbursement(c,[transfer()])).toMatchObject({kind:C.decision.transfer,key:P.creatorKey,amount:F.money.creatorSettled});
    expect(planDisbursement(c,[transfer(),transfer(T.kind.creator)])).toEqual({kind:C.decision.idle});
  });
  it('refuses a historical paid flag with no corresponding transfer receipt',()=>{
    const c=context();c.availability[1].releaseState='paid';
    expect(planDisbursement(c,[])).toEqual({kind:C.decision.review,reason:C.reason.ledger});
    expect(planDisbursement(c,[transfer(T.kind.creator)])).toMatchObject({kind:C.decision.transfer});
  });
  it('does not label an available commission paid until its exact receipt is in the ledger',()=>{
    const c=context();expect(fundedCommissionIds(c,[])).toEqual([]);expect(fundedCommissionIds(c,[transfer(T.kind.creator)])).toEqual([F.id.commission]);
    c.availability[1].allowed=false;expect(fundedCommissionIds(c,[transfer(T.kind.creator)])).toEqual([]);
  });
  it('skips an ineligible brand without locking an independently payable creator',()=>{
    const c=context();c.availability[0].allowed=false;c.availability[0].reason=T.reason.profile;
    expect(planDisbursement(c,[])).toMatchObject({kind:C.decision.transfer,key:P.creatorKey});
    expect(planDisbursement(c,[transfer(T.kind.creator)])).toEqual({kind:C.decision.hold,reason:T.reason.profile});
  });
  it('recovers overpaid money during a pending refund before permitting any new transfer',()=>{
    const c=context();c.basis.merchandiseRemaining=0;c.basis.refundLiability=F.money.total;c.basis.remainingCommissions[0].amount=0;c.basis.refundOutstanding=true;
    c.assessment=calculateDisbursement(c.basis);
    expect(planDisbursement(c,[transfer()])).toMatchObject({kind:C.decision.reversal,amount:F.money.brandSettled,expectedReversedAmount:0});
    expect(planDisbursement(c,[])).toEqual({kind:C.decision.hold,reason:T.reason.adjustment});
  });
  it('uses available balance for a legitimate brand top-up exceeding lifetime source-charge capacity',()=>{
    const c=context();c.basis.merchandiseRemaining=0;c.basis.refundLiability=F.money.total;c.basis.remainingCommissions[0].amount=0;
    c.assessment=calculateDisbursement(c.basis);
    const brand=transfer(),creator=transfer(T.kind.creator);
    expect(planDisbursement(c,[brand,creator])).toMatchObject({kind:C.decision.reversal,amount:F.money.creatorSettled});
    creator.reversals=[{id:P.reversal,transferId:creator.snapshot.id,amount:F.money.creatorSettled,currency:F.currency.settlement,createdAt:F.date.created}];
    expect(planDisbursement(c,[brand,creator])).toMatchObject({kind:C.decision.transfer,amount:F.money.net-F.money.brandSettled,funding:T.funding.balance});
  });
  it('does not treat untracked reversals or duplicate receipts as new available money',()=>{
    const c=context(),row=transfer();row.snapshot.reversedAmount=1;
    expect(planDisbursement(c,[row])).toEqual({kind:C.decision.review,reason:C.reason.ledger});
    expect(planDisbursement(c,[transfer(),transfer()])).toEqual({kind:C.decision.review,reason:C.reason.ledger});
  });
  it('supersedes a changed amount, account or financial checkpoint before new provider creation',()=>{
    const c=context(),decision=planDisbursement(c,[]),row=transfer();
    expect(matchesDisbursementDecision(decision,row.instruction)).toBe(true);
    expect(matchesDisbursementDecision(decision,{...row.instruction,amount:1})).toBe(false);
    expect(matchesDisbursementDecision(decision,{...row.instruction,account:{...row.instruction.account,stripeAccountId:F.provider.otherAccount}})).toBe(false);
    expect(matchesDisbursementDecision(decision,{...row.instruction,refunds:{...row.instruction.refunds,amountRefunded:1}})).toBe(false);
  });
  it('requires the exact cumulative reversal state to reuse an instruction',()=>{
    const c=context();c.basis.merchandiseRemaining=0;c.basis.refundLiability=F.money.total;c.basis.remainingCommissions[0].amount=0;c.basis.refundOutstanding=true;
    c.assessment=calculateDisbursement(c.basis);const row=transfer(),decision=planDisbursement(c,[row]);
    const instruction={id:F.id.reversal,original:row.instruction,transferId:row.snapshot.id,amount:row.snapshot.amount,expectedReversedAmount:0};
    expect(matchesDisbursementDecision(decision,instruction)).toBe(true);
    expect(matchesDisbursementDecision(decision,{...instruction,expectedReversedAmount:1})).toBe(false);
  });
});

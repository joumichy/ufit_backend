import {createHash, randomUUID} from 'node:crypto';
import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, eq, inArray, lte, or, sql} from 'drizzle-orm';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import type {DisbursementAdministrationRepository,DisbursementAdministrationSession as AdministrationPort} from '../domain/payment-disbursement-administration';
import {DisbursementAdministrationSession} from './disbursement-administration-session';
import {orders, payments, paymentSettlements, commissions, paymentDisbursementJobs as jobs, paymentDisbursementTargets as targets,
  paymentTransferOperations as operations, paymentTransferReceipts as receipts} from '../../../shared/infrastructure/database/schema';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';
import {DISBURSEMENT_EXECUTION as C, type DisbursementExecutionRepository, type DisbursementExecutionSession,
  type DisbursementLease, type DisbursementContext, type DisbursementOperation, type DisbursementTransfer,
  type StoredDisbursementOperation} from '../domain/payment-disbursement.repository';
import {PAYMENT_DISBURSEMENT, disbursementAssessmentSchema, type DisbursementAssessment} from '../domain/payment-disbursement';
import {transferInstructionSchema, reversalInstructionSchema, transferSnapshotSchema, reversalSnapshotSchema,
  type TransferSnapshot, type ReversalSnapshot} from '../domain/payment-transfer';
import {DrizzlePaymentAllocationsRepository} from './drizzle-payment-allocations.repository';
import {lockDisbursementRecipients} from './payment-disbursement-locks';
import {requestRefundSettlement} from './refund-settlement-queue';
import {readDisbursementContext} from './payment-disbursement-context';

@Injectable()
export class DrizzleDisbursementExecutionRepository implements DisbursementExecutionRepository,DisbursementAdministrationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  administration<T>(write:boolean,operation:(session:AdministrationPort)=>Promise<T>):Promise<T>{
    return this.database.db.transaction(tx=>operation(new DisbursementAdministrationSession({db:tx})),write?undefined:READ_SNAPSHOT);
  }
  async discover(): Promise<void> {
    // Captures with no frozen commercial policy cannot acquire a made-up historical allocation.
    await this.database.db.execute(sql`insert into ufit.payment_disbursement_jobs(payment_id,status,next_attempt_at)
      select s.payment_id,${C.state.queued},now() from ufit.payment_settlements s
      join ufit.payments p on p.id=s.payment_id join ufit.order_distribution_terms t on t.order_id=p.order_id
      on conflict(payment_id) do nothing`);
  }
  claim(): Promise<DisbursementLease[]> {
    return this.database.db.transaction(async tx => {
      const now = new Date();
      const factsChanged=sql`exists(select 1 from ufit.payments p join ufit.orders o on o.id=p.order_id
        where p.id=${jobs.paymentId} and (o.updated_at>${jobs.updatedAt}
          or exists(select 1 from ufit.payment_refund_jobs r where r.payment_id=p.id and r.updated_at>${jobs.updatedAt})
          or exists(select 1 from ufit.order_returns r where r.order_id=o.id and r.updated_at>${jobs.updatedAt})
          or exists(select 1 from ufit.shipments s where s.order_id=o.id and s.updated_at>${jobs.updatedAt})))`;
      const rows = await tx.select().from(jobs).where(or(and(inArray(jobs.status,[C.state.queued,C.state.waiting]),
        or(lte(jobs.nextAttemptAt,now),and(eq(jobs.status,C.state.waiting),factsChanged))),
        and(eq(jobs.status,C.state.processing),lte(jobs.leaseUntil,now))))
        .orderBy(asc(jobs.nextAttemptAt),asc(jobs.paymentId)).limit(C.limits.batch).for(C.lock,{skipLocked:true});
      const claims: DisbursementLease[]=[];
      for (const row of rows) {
        const token=randomUUID();
        await tx.update(jobs).set({status:C.state.processing,leaseToken:token,leaseUntil:new Date(now.getTime()+C.limits.leaseMs),
          nextAttemptAt:null,updatedAt:now}).where(eq(jobs.paymentId,row.paymentId));
        claims.push({paymentId:row.paymentId,token});
      }
      return claims;
    });
  }
  withLease<T>(lease: DisbursementLease, operation: (session: DisbursementExecutionSession)=>Promise<T>): Promise<T|undefined> {
    return this.database.db.transaction(async tx => {
      const database={db:tx};
      const [payment]=await tx.select().from(payments).where(eq(payments.id,lease.paymentId));
      if (!payment) return undefined;
      // Returns and cancellation hold this same order lock before changing any financial fact.
      await tx.select({id:orders.id}).from(orders).where(eq(orders.id,payment.orderId)).for(C.lock);
      const [job]=await tx.select().from(jobs).where(eq(jobs.paymentId,lease.paymentId)).for(C.lock);
      if (!job || job.status!==C.state.processing || job.leaseToken!==lease.token || !job.leaseUntil || job.leaseUntil<=new Date()) return undefined;
      const session=new DrizzleDisbursementSession(database,lease.paymentId);
      await session.initialize();
      // The row remains locked even if a slow provider read outlives the original lease.
      return operation(session);
    });
  }
}
class DrizzleDisbursementSession implements DisbursementExecutionSession {
  context:DisbursementContext|null=null;
  failure:string|null=null;
  open:StoredDisbursementOperation|null=null;
  private ownersLocked=false;
  constructor(private readonly database:DatabaseSession,private readonly paymentId:string) {}
  async initialize():Promise<void> {
    const [open]=await this.database.db.select().from(operations).where(and(eq(operations.paymentId,this.paymentId),eq(operations.state,C.operationState.open)));
    this.open=open?{id:open.id,armed:open.armed,operation:parseOperation(open)}:null;
    const allocations=new DrizzlePaymentAllocationsRepository(this.database);
    try {
      let plan=await allocations.storedPlan(this.paymentId);
      if (!plan && !this.open) plan=await this.database.db.transaction(tx=>new DrizzlePaymentAllocationsRepository({db:tx}).prepare(this.paymentId));
      if (!plan) return;
      const source=this.open?.operation.instruction;
      const receipt=source?undefined:(await this.database.db.select({liveMode:paymentSettlements.liveMode}).from(paymentSettlements)
        .where(eq(paymentSettlements.paymentId,this.paymentId)))[C.limits.zero];
      const liveMode=source?('original' in source?source.original.capture.liveMode:source.capture.liveMode):receipt?.liveMode;
      if (liveMode===undefined) return;
      this.ownersLocked=await lockDisbursementRecipients(this.database,plan,liveMode);
      await this.refreshContext();
    } catch(error) {
      if (!(error instanceof ConflictException) && !(error instanceof z.ZodError)) throw error;
      this.failure=PAYMENT_DISBURSEMENT.reason.sources;
    }
  }
  async refreshContext():Promise<DisbursementContext|null> {
    if (!this.ownersLocked) {this.failure=PAYMENT_DISBURSEMENT.reason.sources;return this.context=null;}
    try {this.context=(await readDisbursementContext(this.database,this.paymentId,true))??null;}
    catch(error) {if (!(error instanceof ConflictException) && !(error instanceof z.ZodError)) throw error;this.context=null;this.failure=PAYMENT_DISBURSEMENT.reason.sources;}
    return this.context;
  }
  async ledger():Promise<DisbursementTransfer[]> {
    const rows=await this.database.db.select({operation:operations,receipt:receipts}).from(operations)
      .innerJoin(receipts,eq(receipts.operationId,operations.id)).where(eq(operations.paymentId,this.paymentId));
    const ledger:DisbursementTransfer[]=[];
    for (const row of rows.filter(row=>row.operation.kind===C.operation.transfer)) {
      const operation=parseOperation(row.operation);
      if (operation.kind!==C.operation.transfer || row.operation.state!==C.operationState.recorded) throw new Error(C.reason.ledger);
      ledger.push({instruction:operation.instruction,snapshot:transferSnapshotSchema.parse(row.receipt.snapshot),reversals:[]});
    }
    for (const row of rows.filter(row=>row.operation.kind===C.operation.reversal)) {
      const operation=parseOperation(row.operation),original=ledger.find(line=>line.instruction.id===row.operation.originalOperationId);
      if (operation.kind!==C.operation.reversal || !original || row.operation.state!==C.operationState.recorded
        || JSON.stringify(operation.instruction.original)!==JSON.stringify(original.instruction)) throw new Error(C.reason.ledger);
      original.reversals.push(reversalSnapshotSchema.parse(row.receipt.snapshot));
    }
    return ledger;
  }
  async rememberAssessment(assessment:DisbursementAssessment):Promise<string|undefined> {
    assessment=disbursementAssessmentSchema.parse(assessment);
    if (assessment.phase===PAYMENT_DISBURSEMENT.phase.review) return undefined;
    const fingerprint=createHash(C.digest.algorithm).update(JSON.stringify(assessment)).digest(C.digest.encoding);
    let [target]=await this.database.db.select({id:targets.id}).from(targets).where(and(eq(targets.paymentId,this.paymentId),eq(targets.fingerprint,fingerprint)));
    if (!target) [target]=await this.database.db.insert(targets).values({id:randomUUID(),paymentId:this.paymentId,fingerprint,assessment,createdAt:new Date()}).returning({id:targets.id});
    return target.id;
  }
  async stage(operation:DisbursementOperation,assessment:DisbursementAssessment):Promise<void> {
    assessment=disbursementAssessmentSchema.parse(assessment);
    if (this.open) throw new ConflictException(C.reason.ledger);
    const instruction=operation.kind===C.operation.transfer?transferInstructionSchema.parse(operation.instruction):reversalInstructionSchema.parse(operation.instruction);
    const targetId=await this.rememberAssessment(assessment);
    if (!targetId) throw new ConflictException(C.reason.ledger);
    const original='original' in instruction?instruction.original:null;
    await this.database.db.insert(operations).values({id:instruction.id,paymentId:this.paymentId,targetId,kind:operation.kind,state:C.operationState.open,armed:false,
      allocationKey:original?original.allocationKey:('allocationKey' in instruction?instruction.allocationKey:C.reason.ledger),
      originalOperationId:original?original.id:null,instruction,createdAt:new Date()});
    this.open={id:instruction.id,armed:false,operation};
  }
  async record(operation:StoredDisbursementOperation,snapshot:TransferSnapshot|ReversalSnapshot):Promise<void> {
    const kind=operation.operation.kind;
    const parsed=kind===C.operation.transfer?transferSnapshotSchema.parse(snapshot):reversalSnapshotSchema.parse(snapshot);
    await this.database.db.insert(receipts).values({operationId:operation.id,paymentId:this.paymentId,providerId:parsed.id,kind,amount:parsed.amount,
      currency:parsed.currency,snapshot:parsed,recordedAt:new Date()});
    await this.database.db.update(operations).set({state:C.operationState.recorded}).where(and(eq(operations.id,operation.id),eq(operations.state,C.operationState.open)));
    this.open=null;
  }
  async arm(operationId:string):Promise<void> {
    await this.database.db.update(operations).set({armed:true}).where(and(eq(operations.id,operationId),eq(operations.paymentId,this.paymentId),eq(operations.state,C.operationState.open),eq(operations.armed,false)));
    if(this.open?.id===operationId)this.open.armed=true;
  }
  async supersede(operationId:string):Promise<void> {
    await this.database.db.update(operations).set({state:C.operationState.superseded}).where(and(eq(operations.id,operationId),eq(operations.paymentId,this.paymentId),eq(operations.state,C.operationState.open)));
    this.open=null;
  }
  requestRefundRead():Promise<void> {return requestRefundSettlement(this.database,this.paymentId);}
  async markPaid(commissionIds:string[]):Promise<void> {
    if (!commissionIds.length) return;
    await this.database.db.update(commissions).set({status:ORDER_COMMISSION.status.paid,updatedAt:new Date()})
      .where(and(inArray(commissions.id,commissionIds),inArray(commissions.status,[ORDER_COMMISSION.status.pending,ORDER_COMMISSION.status.validated])));
  }
  async finish(state:typeof C.state[keyof typeof C.state],reason:string|null,delay:number):Promise<void> {
    const now=new Date();
    await this.database.db.update(jobs).set({status:state,failureCode:reason,leaseToken:null,leaseUntil:null,
      nextAttemptAt:state===C.state.review?null:new Date(now.getTime()+delay),updatedAt:now}).where(eq(jobs.paymentId,this.paymentId));
  }
}
function parseOperation(row:typeof operations.$inferSelect):DisbursementOperation {
  if (row.kind===C.operation.transfer) return {kind:C.operation.transfer,instruction:transferInstructionSchema.parse(row.instruction)};
  if (row.kind===C.operation.reversal) return {kind:C.operation.reversal,instruction:reversalInstructionSchema.parse(row.instruction)};
  throw new Error(C.reason.ledger);
}

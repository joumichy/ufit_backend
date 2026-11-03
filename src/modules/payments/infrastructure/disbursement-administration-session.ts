import {ConflictException} from '@nestjs/common';
import {and, desc, eq} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders,payments,paymentSettlements,paymentDisbursementJobs as jobs,paymentDisbursementTargets as targets,
  paymentTransferOperations as operations,paymentTransferReceipts as receipts} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess,IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {DISBURSEMENT_EXECUTION as E} from '../domain/payment-disbursement.repository';
import {DISBURSEMENT_ADMINISTRATION as C,disbursementDocumentSchema,type DisbursementAdministrationSession as AdministrationPort} from '../domain/payment-disbursement-administration';
import {transferInstructionSchema,reversalInstructionSchema} from '../domain/payment-transfer';

export class DisbursementAdministrationSession implements AdministrationPort {
  constructor(private readonly database:DatabaseSession) {}
  async lockOrder(paymentId:string):Promise<void>{
    const [payment]=await this.database.db.select({orderId:payments.orderId}).from(payments).where(eq(payments.id,paymentId));
    if(payment)await this.database.db.select({id:orders.id}).from(orders).where(eq(orders.id,payment.orderId)).for(E.lock);
  }
  access(actorId:string,write:boolean){return findIdentityAccess(this.database,actorId,write?IdentityAccessMode.Lock:IdentityAccessMode.Read);}
  async document(paymentId:string){
    const [source]=await this.database.db.select({orderId:payments.orderId}).from(payments).innerJoin(paymentSettlements,eq(paymentSettlements.paymentId,payments.id)).where(eq(payments.id,paymentId));
    if(!source)return undefined;
    const [job]=await this.database.db.select().from(jobs).where(eq(jobs.paymentId,paymentId));
    const [target]=await this.database.db.select().from(targets).where(eq(targets.paymentId,paymentId)).orderBy(desc(targets.createdAt),desc(targets.id));
    const history=await this.database.db.select({operation:operations,receipt:receipts}).from(operations).leftJoin(receipts,eq(receipts.operationId,operations.id))
      .where(eq(operations.paymentId,paymentId)).orderBy(desc(operations.createdAt),desc(operations.id));
    const parsed=disbursementDocumentSchema.safeParse({paymentId,orderId:source.orderId,asOf:new Date().toISOString(),state:job?.status??C.state.absent,
      reason:job?job.failureCode:null,nextAttemptAt:job?.nextAttemptAt?job.nextAttemptAt.toISOString():null,assessment:target?target.assessment:null,assessmentRecordedAt:target?target.createdAt.toISOString():null,
      operations:history.map(({operation,receipt})=>{
        const instruction=operation.kind===E.operation.transfer?transferInstructionSchema.parse(operation.instruction):reversalInstructionSchema.parse(operation.instruction);
        return {id:operation.id,kind:operation.kind,armed:operation.armed,state:operation.state,allocationKey:operation.allocationKey,originalOperationId:operation.originalOperationId,
          amount:instruction.amount,currency:'original' in instruction?instruction.original.currency:instruction.currency,
          funding:'original' in instruction?null:instruction.funding,createdAt:operation.createdAt.toISOString(),
          receipt:receipt?{id:receipt.providerId,recordedAt:receipt.recordedAt.toISOString()}:null};
      })});
    if(!parsed.success)throw new ConflictException(C.failure.persisted);
    return parsed.data;
  }
  async resume(paymentId:string):Promise<void>{
    const now=new Date();
    // Preserve a live lease and its recovery instruction. Resuming never authorizes an amount or a destination.
    await this.database.db.insert(jobs).values({paymentId,status:E.state.queued,nextAttemptAt:now}).onConflictDoNothing();
    await this.database.db.update(jobs).set({status:E.state.queued,nextAttemptAt:now,failureCode:null,leaseToken:null,leaseUntil:null,updatedAt:now})
      .where(and(eq(jobs.paymentId,paymentId),eq(jobs.status,E.state.review)));
    await this.database.db.update(jobs).set({status:E.state.queued,nextAttemptAt:now,failureCode:null,updatedAt:now})
      .where(and(eq(jobs.paymentId,paymentId),eq(jobs.status,E.state.waiting)));
  }
}

import {DrizzleRefundProofRepository} from '../src/modules/orders/infrastructure/drizzle-refund-proof.repository';
import {REFUND_PROOF as P,prepareRefundProof,type RefundProofCommand} from '../src/modules/orders/domain/refund-proof.contract';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {eq,sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {users,orders,orderReturns,orderReturnRefunds,orderCancellations,orderCancellationRefunds} from '../src/shared/infrastructure/database/schema';
import {refundOrganizationCases,refundOrganizationRevisions} from '../src/shared/infrastructure/database/schema.refund-organizations';
import {DrizzleRefundOrganizationRepository} from '../src/modules/orders/infrastructure/drizzle-refund-organization.repository';
import {REFUND_ORGANIZATION as O,type RefundOrganizationAccess,type RefundOrganizationCommand} from '../src/modules/orders/domain/refund-organization';
import {REFUND_RECOVERY as R,type RefundRecoveryKind} from '../src/modules/orders/domain/refund-recovery.contract';
import {CANCELLATION,CANCELLATION_REFUND,ORDER_STATUS} from '../src/modules/orders/domain/order-lifecycle';
import {RETURN_STATUS,ORDER_RETURN} from '../src/modules/orders/domain/order-return.contract';
import {RETURN_REFUND} from '../src/modules/orders/domain/return-refund';

const fixture={
  profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},registry:homedir()+'/.codex/private/ufit/qualification.credentials.json',
  tables:"select tablename from pg_tables where schemaname='ufit' order by tablename",
  constraint:"select condeferrable,condeferred from pg_constraint where conname='refund_organization_current_revision_fk'",
  prefix:'QUAL-REFUND-ORGANIZATION-',intent:'pi_rollback_refund_organization_',refund:'re_rollback_refund_organization_',
  amount:500,zero:0,one:1,two:2,three:3,four:4,currency:'CHF',timestamp:'2026-11-03T00:00:00.000Z',fingerprint:'a'.repeat(64),
  method:'Virement convenu — SPECIMEN',instructions:'Qualification uniquement : communiquer une référence SPECIMEN, sans coordonnées réelles.',
  updatedInstructions:'Qualification uniquement : fournir une nouvelle référence SPECIMEN.',details:'SPECIMEN — aucun compte bancaire ni transfert réel.',
  updatedDetails:'SPECIMEN — réponse corrigée, aucun transfert réel.',reason:'Qualification transactionnelle annulée.',
  status:{denied:403,conflict:409},constraintValidation:'set constraints all immediate',
} as const;
class VerificationRollback extends Error {}
async function main(){
  const env=getEnv();assert(env.NODE_ENV===fixture.profile.node&&env.API_PORT===fixture.profile.port&&env.UFIT_DB_SCHEMA===fixture.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(fixture.profile.stripe));
  const registry=JSON.parse(await readFile(fixture.registry,'utf8')),database=new DatabaseService(),hashes=new Map<string,string>(),checks:string[]=[];
  async function digest(table:string){assert(/^[a-z_]+$/.test(table));return(await database.query<{digest:string}>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."${table}" t`)).rows[fixture.zero].digest;}
  try{
    for(const {tablename}of(await database.query<{tablename:string}>(fixture.tables)).rows)hashes.set(tablename,await digest(tablename));
    const ddl=(await database.query<{condeferrable:boolean;condeferred:boolean}>(fixture.constraint)).rows;assert.equal(ddl.length,fixture.one);assert(ddl[fixture.zero].condeferrable&&ddl[fixture.zero].condeferred);
    await assert.rejects(database.db.transaction(async tx=>{
      const repository=new DrizzleRefundOrganizationRepository({db:tx});
      async function actor(email:string){const[row]=await tx.select().from(users).where(eq(users.email,email));assert(row);return row.id;}
      const customerId=await actor(registry.customer.email),adminId=await actor(registry.admin.email),brandId=await actor(registry.brand.email),creatorId=await actor(registry.creator.email);
      const admin:RefundOrganizationAccess={scope:O.scope.administrator,actorId:adminId},customer:RefundOrganizationAccess={scope:O.scope.customer,actorId:customerId},brand:RefundOrganizationAccess={scope:O.scope.brand,actorId:brandId};
      const[source]=await tx.select().from(orders).where(eq(orders.id,registry.qualification.brandOrderFulfillment.orderID));assert(source);
      async function create(kind:RefundRecoveryKind){
        const id=randomUUID(),orderId=randomUUID(),intent=fixture.intent+orderId;
        await tx.insert(orders).values({id:orderId,orderNumber:fixture.prefix+orderId,customerId,brandId:source.brandId,status:ORDER_STATUS.cancelled,
          subtotalAmount:fixture.amount,shippingAmount:fixture.zero,taxAmount:fixture.zero,totalAmount:fixture.amount,currency:fixture.currency,
          shippingAddress:source.shippingAddress,commerceSnapshot:source.commerceSnapshot,stripePaymentIntentId:intent});
        if(kind===R.kind.orderReturn){
          await tx.insert(orderReturns).values({id,orderId,requestId:randomUUID(),requestFingerprint:fixture.fingerprint,status:RETURN_STATUS.refundFailed,
            reason:fixture.reason,returnPolicy:fixture.reason,deadline:new Date(fixture.timestamp),refundPolicyCode:ORDER_RETURN.policy.code,
            merchandiseAmount:fixture.amount,taxAmount:fixture.zero,shippingAmount:fixture.zero,totalAmount:fixture.amount,completesOrder:true,
            receivedAt:new Date(fixture.timestamp),allocationNumber:fixture.one});
          await tx.insert(orderReturnRefunds).values({returnId:id,attemptNumber:fixture.one,amount:fixture.amount,state:RETURN_REFUND.state.failed,
            providerStatus:RETURN_REFUND.providerStatus.failed,stripeRefundId:fixture.refund+id,nextRecoveryAt:new Date(fixture.timestamp)});
        }else{
          await tx.insert(orderCancellations).values({id,orderId,requestedBy:customerId,originalStatus:ORDER_STATUS.paid,reason:CANCELLATION.reason.customer,status:CANCELLATION.status.failed,paymentOutcome:CANCELLATION.outcome.refundFailed,effectsApplied:true});
          await tx.insert(orderCancellationRefunds).values({cancellationId:id,attemptNumber:fixture.one,paymentIntentId:intent,amount:fixture.amount,currency:fixture.currency,
            state:CANCELLATION_REFUND.state.failed,providerStatus:CANCELLATION_REFUND.providerStatus.failed,stripeRefundId:fixture.refund+id});
        }
        return {kind,id};
      }
      for(const kind of Object.values(R.kind)){
        const reference=await create(kind),arrange:RefundOrganizationCommand={requestId:randomUUID(),expectedVersion:O.revision.absent,action:O.action.arrange,methodLabel:fixture.method,instructions:fixture.instructions};
        const initial=await repository.read(admin,reference);assert.equal(initial.organization,null);assert.deepEqual(initial.actions,[O.action.arrange]);
        assert.deepEqual((await repository.read(customer,reference)).actions,[]);assert.deepEqual((await repository.read(brand,reference)).actions,[]);
        await assert.rejects(repository.read({scope:O.scope.customer,actorId:creatorId},reference),e=>(e as {status:number}).status===fixture.status.denied);
        await assert.rejects(repository.read({scope:O.scope.administrator,actorId:customerId},reference),e=>(e as {status:number}).status===fixture.status.denied);
        await assert.rejects(repository.read({scope:O.scope.customer,actorId:adminId},reference),e=>(e as {status:number}).status===fixture.status.denied);
        await assert.rejects(repository.apply(customer,reference,arrange),e=>(e as {status:number}).status===fixture.status.denied);
        await assert.rejects(repository.apply(brand,reference,arrange),e=>(e as {status:number}).status===fixture.status.denied);
        const first=await repository.apply(admin,reference,arrange);assert.equal(first.document.organization?.version,fixture.one);
        assert.deepEqual(await repository.apply(admin,reference,arrange),first);
        assert.deepEqual(await repository.receipt(admin,reference,arrange.requestId),first);
        await assert.rejects(repository.apply(admin,reference,{...arrange,instructions:fixture.updatedInstructions}),e=>(e as {status:number}).status===fixture.status.conflict);
        assert.equal((await repository.read(customer,reference)).organization?.instructions,fixture.instructions);
        const reply:RefundOrganizationCommand={requestId:randomUUID(),expectedVersion:fixture.one,action:O.action.provideDetails,details:fixture.details};
        const ready=await repository.apply(customer,reference,reply);assert.equal(ready.document.organization?.version,fixture.two);assert.equal(ready.document.organization?.status,O.status.ready);
        assert.equal((await repository.read(brand,reference)).organization?.customerDetails,fixture.details);
        const replay=await repository.apply(admin,reference,arrange);assert.equal(replay.receipt.version,fixture.one);assert.equal(replay.document.organization?.version,fixture.two);
        await assert.rejects(repository.receipt(customer,reference,arrange.requestId),e=>(e as {status:number}).status===fixture.status.denied);
        await assert.rejects(repository.apply(customer,reference,{...reply,requestId:randomUUID(),details:fixture.updatedDetails}),e=>(e as {status:number}).status===fixture.status.conflict);
        const revised=await repository.apply(customer,reference,{...reply,requestId:randomUUID(),expectedVersion:fixture.two,details:fixture.updatedDetails});assert.equal(revised.document.organization?.version,fixture.three);
        const renewed=await repository.apply(admin,reference,{...arrange,requestId:randomUUID(),expectedVersion:fixture.three,instructions:fixture.updatedInstructions});
        assert.equal(renewed.document.organization?.version,fixture.four);assert.equal(renewed.document.organization?.status,O.status.awaitingCustomer);assert.equal(renewed.document.organization?.customerDetails,null);
        const[stored]=await tx.select().from(refundOrganizationCases).where(kind===R.kind.orderReturn?eq(refundOrganizationCases.returnId,reference.id):eq(refundOrganizationCases.cancellationId,reference.id));assert(stored);
        const history=await tx.select().from(refundOrganizationRevisions).where(eq(refundOrganizationRevisions.caseId,stored.id)).orderBy(refundOrganizationRevisions.version);
        assert.equal(history.length,fixture.four);assert.equal(history[fixture.two].customerDetails,fixture.updatedDetails);
        assert.equal((await repository.read(customer,reference)).organization?.customerDetails,null);
        checks.push(kind+': persisted roles/ownership, exact replay and receipts, stale conflicts, current document after lost response, private customer/brand reads, immutable history and fresh response after new instructions');
        const proofs=new DrizzleRefundProofRepository({db:tx}),pdf=Buffer.from('%PDF-1.4\nSPECIMEN — no transfer\n%%EOF');
        const prepared=prepareRefundProof({buffer:pdf,mimetype:P.mime.pdf,size:pdf.length});
        const response=await repository.apply(customer,reference,{...reply,requestId:randomUUID(),expectedVersion:fixture.four});
        const proofCommand:RefundProofCommand={requestId:randomUUID(),replacesProofId:null,expectedVersion:response.document.organization!.version,transferReference:fixture.details,transferredOn:'2026-11-01'};
        await assert.rejects(proofs.reserve(customer,reference,proofCommand,prepared),e=>(e as {status:number}).status===fixture.status.denied);
        const pending=await proofs.reserve(brand,reference,proofCommand,prepared);
        assert.deepEqual(await proofs.reserve(brand,reference,proofCommand,prepared),pending);
        assert.equal((await proofs.receipt(brand,reference,proofCommand.requestId))?.state,P.state.pending);
        assert.equal((await repository.read(customer,reference)).proof,null);
        await assert.rejects(proofs.file(customer,reference,pending.id));
        await assert.rejects(proofs.reserve(brand,reference,{...proofCommand,transferReference:fixture.updatedDetails},prepared),e=>(e as {status:number}).status===fixture.status.conflict);
        const changed=await repository.apply(customer,reference,{...reply,requestId:randomUUID(),expectedVersion:proofCommand.expectedVersion,details:fixture.updatedDetails});
        await assert.rejects(proofs.submit(brand,reference,pending),e=>(e as {status:number}).status===fixture.status.conflict);
        const currentCommand={...proofCommand,requestId:randomUUID(),expectedVersion:changed.document.organization!.version};
        const current=await proofs.reserve(brand,reference,currentCommand,prepared);
        await tx.update(users).set({status:'suspended'}).where(eq(users.id,brandId));
        await assert.rejects(proofs.submit(brand,reference,current),e=>(e as {status:number}).status===fixture.status.denied);
        await tx.update(users).set({status:'active'}).where(eq(users.id,brandId));
        const submitted=await proofs.submit(brand,reference,current);
        assert.equal(submitted.state,P.state.submitted);assert.equal(submitted.proof?.amount,fixture.amount);assert.equal(submitted.proof?.currency,fixture.currency);
        assert.deepEqual(await proofs.submit(brand,reference,current),submitted);
        assert.deepEqual(await proofs.receipt(brand,reference,currentCommand.requestId),submitted);
        for(const access of [admin,brand,customer]){
          const doc=await repository.read(access,reference);assert.deepEqual(doc.proof,submitted.proof);assert.deepEqual(doc.actions,[]);
          assert.equal((await proofs.file(access,reference,current.id)).sha256,prepared.sha256);
        }
        await assert.rejects(proofs.file({scope:O.scope.customer,actorId:creatorId},reference,current.id),e=>(e as {status:number}).status===fixture.status.denied);
        await assert.rejects(repository.apply(admin,reference,{...arrange,requestId:randomUUID(),expectedVersion:currentCommand.expectedVersion}),e=>(e as {status:number}).status===fixture.status.conflict);
        await assert.rejects(repository.apply(customer,reference,{...reply,requestId:randomUUID(),expectedVersion:currentCommand.expectedVersion}),e=>(e as {status:number}).status===fixture.status.conflict);
        await assert.rejects(proofs.reserve(brand,reference,{...currentCommand,requestId:randomUUID()},prepared),e=>(e as {status:number}).status===fixture.status.conflict);
        assert.equal(await proofs.receipt(brand,reference,randomUUID()),undefined);
        checks.push(kind+': immutable proof reservation/replay, stale and revoked submission rejected, exact receipt, private reads across scopes, submitted evidence freezes instructions/details without financial success');

      }
      await tx.execute(sql.raw(fixture.constraintValidation));checks.push('deferred current-revision foreign keys resolve inside the real PostgreSQL transaction');
      throw new VerificationRollback();
    }),error=>error instanceof VerificationRollback);
    for(const[table,before]of hashes)assert.equal(await digest(table),before,'Rollback changed '+table);
    console.log(JSON.stringify({checks,preservedTables:hashes.size,persistedQualificationRows:fixture.zero}));
  }finally{await database.onModuleDestroy();}
}
await main();

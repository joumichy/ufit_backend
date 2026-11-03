import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {eq,sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import {users,orders,orderItems,shipments,payments,commissions,commissionRules,creatorProfiles,productVariants,orderCancellations,orderCancellationRefunds} from '../src/shared/infrastructure/database/schema';
import {orderReturnRefunds,returnCommissionAdjustments} from '../src/shared/infrastructure/database/schema.returns';
import {externalRefundSettlements,refundProofReviews} from '../src/shared/infrastructure/database/schema.refund-settlements';
import {DrizzleOrderReturnRepository} from '../src/modules/orders/infrastructure/drizzle-order-return.repository';
import {DrizzleReturnRefundRepository} from '../src/modules/orders/infrastructure/drizzle-return-refund.repository';
import {DrizzleOrderCancellationRepository} from '../src/modules/orders/infrastructure/drizzle-order-cancellation.repository';
import {DrizzleOrderRepository} from '../src/modules/orders/infrastructure/drizzle-orders.repository';
import {DrizzleBrandOrdersRepository} from '../src/modules/orders/infrastructure/drizzle-brand-orders.repository';
import {DrizzleRefundOrganizationRepository} from '../src/modules/orders/infrastructure/drizzle-refund-organization.repository';
import {DrizzleRefundProofRepository} from '../src/modules/orders/infrastructure/drizzle-refund-proof.repository';
import {DrizzleRefundProofReviewRepository} from '../src/modules/orders/infrastructure/drizzle-refund-proof-review.repository';
import {DrizzleWorkspaceFinanceReader} from '../src/modules/workspaces/infrastructure/drizzle-workspace-finance.reader';
import {OrderReturnsService} from '../src/modules/orders/application/order-returns.service';
import {ORDER_RETURN,RETURN_ACTION,RETURN_STATUS} from '../src/modules/orders/domain/order-return.contract';
import {CANCELLATION,CANCELLATION_REFUND,ORDER_COMMISSION,ORDER_PAYMENT,ORDER_STATUS} from '../src/modules/orders/domain/order-lifecycle';
import {RETURN_REFUND,type ReturnRefundClaim} from '../src/modules/orders/domain/return-refund';
import {REFUND_ORGANIZATION as O,type RefundOrganizationReference} from '../src/modules/orders/domain/refund-organization';
import {REFUND_RECOVERY as Recovery} from '../src/modules/orders/domain/refund-recovery.contract';
import {REFUND_PROOF as P,prepareRefundProof,type RefundProofAsset} from '../src/modules/orders/domain/refund-proof.contract';
import {REFUND_PROOF_REVIEW as R,type RefundProofReviewCommand} from '../src/modules/orders/domain/refund-proof-review';
import {SHIPMENT_STATUS} from '../src/modules/shipping/domain/shipping.contract';
import {WORKSPACE_FINANCE} from '../src/modules/workspaces/domain/workspace-finance';

const fixture={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},registry:homedir()+'/.codex/private/ufit/qualification.credentials.json',
  tables:"select tablename from pg_tables where schemaname='ufit' order by tablename",quantity:3,unit:100,subtotal:300,tax:25,shipping:80,total:405,
  currency:'CHF',rate:'0.0833',commission:25,firstRefund:108,lastRefund:297,firstAdjustment:8,lastAdjustment:17,
  reason:'Qualification transactionnelle annulée, aucun transfert réel.',instructions:'SPECIMEN — qualification uniquement.',reference:'SQL-ROLLBACK-ONLY',
  prefix:'QUAL-EXTERNAL-',intent:'pi_rollback_external_',refund:'re_rollback_external_',date:'2026-11-03',zero:0,one:1,two:2,
  denied:403,conflict:409,historyRows:22,historyPage:20,pdf:Buffer.from('%PDF-1.4\nSQL ROLLBACK SPECIMEN\n%%EOF'),
} as const;
class VerificationRollback extends Error {}
async function main(){
  const env=getEnv();assert(env.NODE_ENV===fixture.profile.node&&env.API_PORT===fixture.profile.port&&env.UFIT_DB_SCHEMA===fixture.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(fixture.profile.stripe));
  const registry=JSON.parse(await readFile(fixture.registry,'utf8')),database=new DatabaseService(),before=new Map<string,string>(),checks:string[]=[];
  async function digest(table:string){assert(/^[a-z_]+$/.test(table));return(await database.query<{digest:string}>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."${table}" t`)).rows[fixture.zero].digest;}
  try{
    for(const {tablename} of(await database.query<{tablename:string}>(fixture.tables)).rows)before.set(tablename,await digest(tablename));
    await assert.rejects(database.db.transaction(async tx=>{
      const session:DatabaseSession={db:tx},returns=new OrderReturnsService(new DrizzleOrderReturnRepository(session)),refunds=new DrizzleReturnRefundRepository(session),cancellations=new DrizzleOrderCancellationRepository(session);
      const organizations=new DrizzleRefundOrganizationRepository(session),proofs=new DrizzleRefundProofRepository(session),reviews=new DrizzleRefundProofReviewRepository(session),finance=new DrizzleWorkspaceFinanceReader(session);
      async function actor(role:string){const [row]=await tx.select().from(users).where(eq(users.email,registry[role].email));assert(row);return row;}
      const customer=await actor('customer'),brand=await actor('brand'),admin=await actor('admin'),creatorActor=await actor('creator');
      const access={customer:{scope:O.scope.customer,actorId:customer.id},brand:{scope:O.scope.brand,actorId:brand.id},admin:{scope:O.scope.administrator,actorId:admin.id}};
      const [source]=await tx.select().from(orders).where(eq(orders.id,registry.qualification.brandOrderFulfillment.orderID));assert(source);
      const [sourceItem]=await tx.select().from(orderItems).where(eq(orderItems.orderId,source.id));assert(sourceItem?.sourceCreatorId&&sourceItem.sourceOutfitId);
      const [creator]=await tx.select().from(creatorProfiles).where(eq(creatorProfiles.id,sourceItem.sourceCreatorId));assert(creator);
      const [rule]=await tx.insert(commissionRules).values({scopeId:randomUUID(),revision:fixture.one,brandId:source.brandId,productId:sourceItem.productId,creatorGradeCode:creator.gradeCode,baseRate:fixture.rate,bonusRate:String(fixture.zero),active:false,reason:fixture.reason,createdByUserId:admin.id,supersededAt:new Date()}).returning();
      const prepared=prepareRefundProof({buffer:fixture.pdf,mimetype:P.mime.pdf,size:fixture.pdf.length}),verified={sha256:prepared.sha256,byteSize:prepared.bytes.length};
      const brandScope={kind:WORKSPACE_FINANCE.scope.brand,profileId:source.brandId} as const;
      const creatorScope={kind:WORKSPACE_FINANCE.scope.creator,profileId:creator.id} as const;
      async function totals(){return {brand:(await finance.sales(brandScope)).currencies.find(row=>row.currency===fixture.currency),creator:(await finance.sales(creatorScope)).currencies.find(row=>row.currency===fixture.currency)};}
      async function stock(){return(await tx.select().from(productVariants).where(eq(productVariants.id,sourceItem.productVariantId)))[fixture.zero].stockQuantity;}
      async function create(paid=false){
        const id=randomUUID(),intent=fixture.intent+id,now=new Date();
        await tx.insert(orders).values({id,orderNumber:fixture.prefix+id,customerId:customer.id,brandId:source.brandId,sourceCreatorId:creator.id,sourceOutfitId:sourceItem.sourceOutfitId,
          status:paid?ORDER_STATUS.paid:ORDER_STATUS.delivered,subtotalAmount:fixture.subtotal,shippingAmount:fixture.shipping,taxAmount:fixture.tax,totalAmount:fixture.total,currency:fixture.currency,
          shippingAddress:source.shippingAddress,commerceSnapshot:{returnWindowDays:30,returnPolicy:fixture.instructions,refundPolicyCode:ORDER_RETURN.policy.code},paymentProvider:ORDER_PAYMENT.provider,stripePaymentIntentId:intent});
        const [item]=await tx.insert(orderItems).values({orderId:id,productId:sourceItem.productId,productVariantId:sourceItem.productVariantId,productSnapshot:sourceItem.productSnapshot,
          quantity:fixture.quantity,unitPrice:fixture.unit,totalPrice:fixture.subtotal,commissionRate:fixture.rate,commissionRuleId:rule.id,commissionCreatorGradeCode:creator.gradeCode,sourceCreatorId:creator.id,sourceOutfitId:sourceItem.sourceOutfitId}).returning();
        await tx.insert(payments).values({orderId:id,provider:ORDER_PAYMENT.provider,providerPaymentIntentId:intent,status:ORDER_PAYMENT.status.succeeded,amount:fixture.total,currency:fixture.currency});
        await tx.insert(shipments).values({orderId:id,brandId:source.brandId,status:paid?SHIPMENT_STATUS.pending:SHIPMENT_STATUS.delivered,carrier:fixture.reference,trackingNumber:id,shippedAt:paid?null:now,deliveredAt:paid?null:now});
        const [commission]=await tx.insert(commissions).values({orderItemId:item.id,creatorId:creator.id,brandId:source.brandId,sourceOutfitId:sourceItem.sourceOutfitId,
          baseAmount:fixture.subtotal,commissionRate:fixture.rate,commissionAmount:fixture.commission,status:ORDER_COMMISSION.status.pending}).returning();
        if(paid)await tx.update(productVariants).set({stockQuantity:sql`${productVariants.stockQuantity}-${fixture.quantity}`}).where(eq(productVariants.id,sourceItem.productVariantId));
        return {id,item,commission};
      }
      async function receive(order:Awaited<ReturnType<typeof create>>,quantity:number,restockQuantity:number,success=false){
        const selection={items:[{orderItemId:order.item.id,quantity}]},quote=await returns.preview(customer.id,order.id,selection);
        let document=await returns.create(customer.id,order.id,{...selection,requestId:randomUUID(),reason:fixture.reason,quoteFingerprint:quote.fingerprint});
        const scope={kind:O.scope.brand,brandId:source.brandId} as const;
        document=await returns.act(brand.id,scope,document.id,{action:RETURN_ACTION.approve,expectedVersion:document.version,instructions:fixture.instructions});
        document=await returns.act(brand.id,scope,document.id,{action:RETURN_ACTION.receive,expectedVersion:document.version,items:[{orderItemId:order.item.id,restockQuantity}]});
        const claim=(await refunds.claimRecoverable()).find(row=>row.returnId===document.id);assert(claim);
        await refunds.settle(claim,{state:success?RETURN_REFUND.state.succeeded:RETURN_REFUND.state.failed,providerStatus:success?RETURN_REFUND.providerStatus.succeeded:RETURN_REFUND.providerStatus.failed,refundId:fixture.refund+claim.attemptId});
        return {reference:{kind:Recovery.kind.orderReturn,id:document.id} as RefundOrganizationReference,claim};
      }
      async function organize(reference:RefundOrganizationReference){
        await organizations.apply(access.admin,reference,{requestId:randomUUID(),expectedVersion:O.revision.absent,action:O.action.arrange,methodLabel:fixture.reference,instructions:fixture.instructions});
        const ready=await organizations.apply(access.customer,reference,{requestId:randomUUID(),expectedVersion:O.revision.first,action:O.action.provideDetails,details:fixture.instructions});
        const command={requestId:randomUUID(),expectedVersion:ready.document.organization!.version,replacesProofId:null,transferReference:fixture.reference,transferredOn:fixture.date};
        const asset=await proofs.reserve(access.brand,reference,command,prepared);await proofs.submit(access.brand,reference,asset);
        return asset;
      }
      function decision(asset:RefundProofAsset,confirm=true):RefundProofReviewCommand {
        const base={requestId:randomUUID(),expectedVersion:asset.organizationVersion,proofId:asset.id,reason:fixture.reason};
        return confirm?{...base,decision:R.decision.confirm,verificationReference:fixture.reference}:{...base,decision:R.decision.reject};
      }
      const initial=await totals(),order=await create(),first=await receive(order,fixture.one,fixture.one),asset=await organize(first.reference),afterReception=await stock();
      const command=decision(asset);
      await assert.rejects(reviews.review(access.customer,first.reference,command,verified),e=>(e as {status:number}).status===fixture.denied);
      await assert.rejects(reviews.review(access.admin,first.reference,command,null),e=>(e as {status:number}).status===fixture.conflict);
      await assert.rejects(reviews.review(access.admin,first.reference,command,{...verified,sha256:'b'.repeat(64)}),e=>(e as {status:number}).status===fixture.conflict);
      await tx.update(users).set({status:'suspended'}).where(eq(users.id,admin.id));
      await assert.rejects(reviews.review(access.admin,first.reference,command,verified),e=>(e as {status:number}).status===fixture.denied);
      await tx.update(users).set({status:'active'}).where(eq(users.id,admin.id));
      checks.push('confirmation requires current persisted administrator, current proof/revision and verified immutable file bytes');
      await assert.rejects(tx.transaction(async nested=>{
        const session:DatabaseSession={db:nested},p=new DrizzleRefundProofRepository(session),r=new DrizzleRefundProofReviewRepository(session),o=new DrizzleRefundOrganizationRepository(session);
        const rejected=await r.review(access.admin,first.reference,decision(asset,false),null);assert.equal(rejected.document.proof?.status,R.status.rejected);assert.equal(rejected.document.settlement,null);
        const stale=await p.reserve(access.brand,first.reference,{requestId:randomUUID(),expectedVersion:asset.organizationVersion,replacesProofId:asset.id,transferReference:fixture.reference,transferredOn:fixture.date},prepared);
        let latest=asset;
        for(let index=fixture.zero;index<fixture.historyRows;index++){
          const next=await p.reserve(access.brand,first.reference,{requestId:randomUUID(),expectedVersion:asset.organizationVersion,replacesProofId:latest.id,transferReference:fixture.reference,transferredOn:fixture.date},prepared);
          await p.submit(access.brand,first.reference,next);latest=next;
          if(index<fixture.historyRows-fixture.one)await r.review(access.admin,first.reference,decision(next,false),null);
        }
        await assert.rejects(p.submit(access.brand,first.reference,stale),e=>(e as {status:number}).status===fixture.conflict);
        const page=await p.history(access.customer,first.reference,{limit:fixture.historyPage});assert.equal(page.items.length,fixture.historyPage);assert(page.nextCursor);
        const tail=await p.history(access.customer,first.reference,{limit:fixture.historyPage,cursor:page.nextCursor});assert.equal(tail.items.length,fixture.quantity);assert.equal(tail.nextCursor,null);
        assert.equal(new Set([...page.items,...tail.items].map(row=>row.id)).size,fixture.historyRows+fixture.one);
        assert.equal((await p.file(access.customer,first.reference,asset.id)).sha256,prepared.sha256);
        await assert.rejects(p.history({scope:O.scope.customer,actorId:creatorActor.id},first.reference,{limit:fixture.historyPage}),e=>(e as {status:number}).status===fixture.denied);
        assert.equal((await o.read(access.brand,first.reference)).proof?.id,latest.id);
        throw new VerificationRollback();
      }),error=>error instanceof VerificationRollback);
      checks.push('rejection/replacement preserve historical files and decisions, stale uploads cannot replace a newer proof, pagination20+3 and foreign access are enforced');
      const settled=await reviews.review(access.admin,first.reference,command,verified);assert.equal(settled.document.settlement?.amount,fixture.firstRefund);assert.equal(settled.document.proof?.status,R.status.verified);
      assert.deepEqual(await reviews.review(access.admin,first.reference,command,verified),settled);assert.deepEqual(await reviews.receipt(access.admin,first.reference,command.requestId),settled);
      await assert.rejects(reviews.review(access.admin,first.reference,{...command,reason:fixture.instructions},verified),e=>(e as {status:number}).status===fixture.conflict);
      const customerView=await returns.detail(customer.id,{kind:O.scope.customer,orderId:order.id},first.reference.id);assert.equal(customerView.status,RETURN_STATUS.refunded);assert.equal(customerView.refund?.state,RETURN_REFUND.state.failed);assert(customerView.externalSettlement);
      assert.equal((await tx.select().from(payments).where(eq(payments.orderId,order.id)))[fixture.zero].status,ORDER_PAYMENT.status.succeeded);
      assert.equal((await tx.select().from(returnCommissionAdjustments).where(eq(returnCommissionAdjustments.commissionId,order.commission.id)))[fixture.zero].amount,fixture.firstAdjustment);
      assert.equal(await stock(),afterReception);assert.equal(await refunds.settle(first.claim,{state:RETURN_REFUND.state.failed,providerStatus:RETURN_REFUND.providerStatus.failed,refundId:fixture.refund+first.claim.attemptId}),false);
      const partial=await totals();assert.equal(partial.brand!.refundedAmount-(initial.brand?.refundedAmount??fixture.zero),fixture.firstRefund);assert.equal(partial.creator!.refundedAmount-(initial.creator?.refundedAmount??fixture.zero),fixture.unit);
      checks.push('partial external refund remains separate from failed Stripe facts, adjusts commission once and never repeats physical reception');
      const last=await receive(order,fixture.two,fixture.zero),lastAsset=await organize(last.reference);await reviews.review(access.admin,last.reference,decision(lastAsset),verified);
      assert.equal((await tx.select().from(orders).where(eq(orders.id,order.id)))[fixture.zero].status,ORDER_STATUS.refunded);
      assert.equal((await tx.select().from(payments).where(eq(payments.orderId,order.id)))[fixture.zero].status,ORDER_PAYMENT.status.succeeded);
      const adjustments=await tx.select().from(returnCommissionAdjustments).where(eq(returnCommissionAdjustments.commissionId,order.commission.id));assert.equal(adjustments.length,fixture.two);assert.equal(adjustments.reduce((sum,row)=>sum+row.amount,fixture.zero),fixture.commission);
      const complete=await totals();assert.equal(complete.brand!.refundedAmount-(initial.brand?.refundedAmount??fixture.zero),fixture.total);assert.equal(complete.creator!.refundedAmount-(initial.creator?.refundedAmount??fixture.zero),fixture.subtotal);
      assert.equal(await stock(),afterReception);checks.push('all external partials conserve405 minor units and commission25, business order refunded while Stripe payment stays succeeded');
      const mixed=await create(),stripePart=await receive(mixed,fixture.one,fixture.zero,true),externalPart=await receive(mixed,fixture.two,fixture.zero),mixedAsset=await organize(externalPart.reference);
      await reviews.review(access.admin,externalPart.reference,decision(mixedAsset),verified);
      assert.equal((await tx.select().from(orders).where(eq(orders.id,mixed.id)))[fixture.zero].status,ORDER_STATUS.refunded);
      await refunds.settle(stripePart.claim,{state:RETURN_REFUND.state.failed,providerStatus:RETURN_REFUND.providerStatus.failed,refundId:fixture.refund+stripePart.claim.attemptId});
      assert.equal((await tx.select().from(orders).where(eq(orders.id,mixed.id)))[fixture.zero].status,ORDER_STATUS.delivered);assert.equal((await organizations.read(access.customer,externalPart.reference)).settlement?.amount,fixture.lastRefund);
      assert.equal((await tx.select().from(returnCommissionAdjustments).where(eq(returnCommissionAdjustments.commissionId,mixed.commission.id))).length,fixture.two);
      checks.push('mixed Stripe/external totals share one financial view; later Stripe failure cannot erase the external settlement or repeat commission/stock');
      const paidCommission=await create();await tx.update(commissions).set({status:ORDER_COMMISSION.status.paid}).where(eq(commissions.id,paidCommission.commission.id));
      const debtReturn=await receive(paidCommission,fixture.one,fixture.zero),debtAsset=await organize(debtReturn.reference);await reviews.review(access.admin,debtReturn.reference,decision(debtAsset),verified);
      assert.equal((await tx.select().from(commissions).where(eq(commissions.id,paidCommission.commission.id)))[fixture.zero].status,ORDER_COMMISSION.status.paid);
      assert.equal((await tx.select().from(returnCommissionAdjustments).where(eq(returnCommissionAdjustments.commissionId,paidCommission.commission.id)))[fixture.zero].amount,fixture.firstAdjustment);
      assert((await finance.creatorCommissions(creator.id)).find(row=>row.currency===fixture.currency)!.paidAdjustmentAmount>=fixture.firstAdjustment);
      checks.push('a previously paid creator commission remains paid with a separate reclaimable adjustment');
      const cancelled=await create(true),claim=await cancellations.claim(customer.id,cancelled.id),attempt=await cancellations.prepareRefund(claim);
      await cancellations.recordRefund(claim,attempt,{state:CANCELLATION_REFUND.state.failed,providerStatus:CANCELLATION_REFUND.providerStatus.failed,refundId:fixture.refund+attempt.id});
      const reference={kind:Recovery.kind.cancellation,id:claim.id},cancelAsset=await organize(reference);
      await assert.rejects(reviews.review(access.admin,reference,decision(cancelAsset),verified),e=>(e as {status:number}).status===fixture.conflict);
      await cancellations.complete(claim);const afterCancellation=await stock(),[shipment]=await tx.select().from(shipments).where(eq(shipments.orderId,cancelled.id));
      const cancellationReview=decision(cancelAsset),result=await reviews.review(access.admin,reference,cancellationReview,verified);assert.equal(result.document.settlement?.amount,fixture.total);
      assert.equal((await tx.select().from(orderCancellations).where(eq(orderCancellations.id,claim.id)))[fixture.zero].paymentOutcome,CANCELLATION.outcome.refundedExternally);
      assert.equal((await tx.select().from(payments).where(eq(payments.orderId,cancelled.id)))[fixture.zero].status,ORDER_PAYMENT.status.succeeded);
      assert.equal((await tx.select().from(orderCancellationRefunds).where(eq(orderCancellationRefunds.id,attempt.id)))[fixture.zero].state,CANCELLATION_REFUND.state.failed);
      assert.equal((await new DrizzleOrderRepository(session).findById(cancelled.id))?.cancellation?.externalSettlement?.amount,fixture.total);
      assert.equal((await new DrizzleBrandOrdersRepository(session).detail(source.brandId,cancelled.id))?.cancellation?.externalSettlement?.amount,fixture.total);
      assert.equal((await tx.select().from(shipments).where(eq(shipments.orderId,cancelled.id)))[fixture.zero].version,shipment.version);assert.equal(await stock(),afterCancellation);
      assert.equal(await cancellations.recordRefund(claim,attempt,{state:CANCELLATION_REFUND.state.failed,providerStatus:CANCELLATION_REFUND.providerStatus.failed,refundId:fixture.refund+attempt.id}),false);
      assert((await reviews.receipt(access.admin,reference,cancellationReview.requestId))?.document.settlement);await finance.sales(brandScope);await finance.sales(creatorScope);
      checks.push('cancellation settles only after its physical reversal, keeps failed Stripe attempt/payment truth and exposes the external fact to customer/brand without second stock/shipment effects');
      await tx.execute(sql`set constraints all immediate`);
      assert.equal((await tx.select().from(externalRefundSettlements)).length,fixture.quantity+fixture.two);
      throw new VerificationRollback();
    }),error=>error instanceof VerificationRollback);
    for(const[table,hash]of before)assert.equal(await digest(table),hash,'Rollback changed '+table);
    console.log(JSON.stringify({checks,preservedTables:before.size,persistedQualificationRows:fixture.zero,noStripeOrBankCalls:true}));
  }finally{await database.onModuleDestroy();}
}
await main();

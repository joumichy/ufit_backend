import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {and,eq,gt,sql} from 'drizzle-orm';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import * as schema from '../src/shared/infrastructure/database/schema';
import {ApplicationsService} from '../src/modules/applications/applications.service';
import {DrizzleApplicationsRepository} from '../src/modules/applications/drizzle-applications.repository';
import {DrizzleApplicationWorkflow} from '../src/modules/applications/drizzle-application-workflow';
import {DrizzleStripePaymentFinalizer} from '../src/modules/payments/infrastructure/drizzle-stripe-payment-finalizer';
import {DrizzleShipmentRepository} from '../src/modules/shipping/infrastructure/drizzle-shipping.repository';
import {applyShipmentAction,SHIPMENT_ACTION} from '../src/modules/shipping/domain/shipping.contract';
import {DrizzleOrderCancellationRepository} from '../src/modules/orders/infrastructure/drizzle-order-cancellation.repository';
import {DrizzleOrderReturnRepository} from '../src/modules/orders/infrastructure/drizzle-order-return.repository';
import {DrizzleReturnRefundRepository} from '../src/modules/orders/infrastructure/drizzle-return-refund.repository';
import {ORDER_STATUS,CANCELLATION} from '../src/modules/orders/domain/order-lifecycle';
import {RETURN_STATUS,ORDER_RETURN,RETURN_ACTION} from '../src/modules/orders/domain/order-return.contract';
import {applyReturnAction,type OrderReturn} from '../src/modules/orders/domain/order-return';
import {RETURN_REFUND} from '../src/modules/orders/domain/return-refund';

const FIXTURE={first:0,zero:0,one:1,two:2,three:3,amount:100,currency:'CHF',quantity:1,
  displayName:'Qualification notifications',reason:'Qualification annulée après vérification',
  domain:'@example.invalid',prefix:'notification-proof-',country:'CH',
  creatorDossier:{instagramUrl:'https://example.invalid/creator',dominantStyle:'Minimaliste',brandsWorn:'Marques indépendantes',
    outfitExampleUrls:['https://example.invalid/one','https://example.invalid/two','https://example.invalid/three']},
  brandDossier:{instagramUrl:'https://example.invalid/brand',country:'CH',priceRange:'Mode indépendante',lookbookUrl:'https://example.invalid/lookbook',shippingCapabilities:'Livraison manuelle',returnPolicy:'Retours sous trente jours'},
  shipment:{carrier:'Transport qualification',trackingNumber:'TRACK-PROOF'},
  dayMs:86_400_000,monthDays:30,refunded:'re_notification_proof_',fingerprint:'a'.repeat(64),
  mailFailure:'notification_proof_rejected',
} as const;
class RollbackProof extends Error {}

export async function verifyNotificationProducers(database:DatabaseSession):Promise<number> {
  let cases=FIXTURE.zero as number;
  try {await database.db.transaction(async db=>{
    const session={db};
    async function user(){const [row]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+FIXTURE.domain,displayName:FIXTURE.displayName}).returning();return row;}
    const applicant=await user(),reviewer=await user(),customer=await user(),manager=await user(),removed=await user(),suspended=await user(),roleless=await user();
    await db.insert(schema.userRoles).values([{userId:reviewer.id,role:'super_admin'},{userId:manager.id,role:'brand_owner'},
      {userId:manager.id,role:'brand_manager'},{userId:removed.id,role:'brand_manager'},{userId:suspended.id,role:'brand_manager'}]);
    await db.update(schema.users).set({status:'suspended'}).where(eq(schema.users.id,suspended.id));
    const service=new ApplicationsService(new DrizzleApplicationsRepository(session),new DrizzleApplicationWorkflow(session));
    async function messages(resourceId:string){return db.select().from(schema.notifications).where(eq(schema.notifications.resourceId,resourceId));}
    async function emailCount(){return (await db.select({count:sql<number>`count(*)::integer`}).from(schema.notificationEmailDeliveries))[FIXTURE.first].count;}
    const creatorInput={userId:applicant.id,email:applicant.email,displayName:FIXTURE.displayName,motivation:FIXTURE.reason,
      dossier:{...FIXTURE.creatorDossier,outfitExampleUrls:[...FIXTURE.creatorDossier.outfitExampleUrls]}};
    const creator=await service.submitCreatorApplication(creatorInput);
    assert.equal((await messages(creator.id)).length,FIXTURE.one);cases++;
    const creatorReviewed=await service.reviewApplication({applicationType:'creator',applicationId:creator.id,expectedVersion:creator.version,
      reviewerUserId:reviewer.id,decision:'needs_more_info',notes:FIXTURE.reason});
    assert.equal((await messages(creator.id)).length,FIXTURE.two);assert.equal(creatorReviewed.application.status,'needs_more_info');cases++;
    const corrected=await service.resubmitCreatorApplication(creator.id,creatorInput,creatorReviewed.application.version);
    assert.equal((await messages(creator.id)).length,FIXTURE.three);assert.equal(corrected.version,FIXTURE.three);cases++;
    const brand=await service.submitBrandApplication({userId:manager.id,email:manager.email,brandName:FIXTURE.displayName,websiteUrl:'https://example.invalid',
      productCategory:'Mode',positioning:FIXTURE.reason,dossier:FIXTURE.brandDossier});
    const accepted=await service.reviewApplication({applicationType:'brand',applicationId:brand.id,expectedVersion:brand.version,reviewerUserId:reviewer.id,decision:'accept'});
    const [profile]=await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.applicationId,brand.id));assert(profile);
    assert.equal((await messages(brand.id)).length,FIXTURE.two);cases++;
    await service.reviewApplication({applicationType:'brand',applicationId:brand.id,expectedVersion:accepted.application.version,reviewerUserId:reviewer.id,decision:'accept'});
    assert.equal((await messages(brand.id)).length,FIXTURE.two);cases++;
    await db.insert(schema.brandMembers).values([{brandProfileId:profile.id,userId:removed.id,role:'manager',status:'removed'},
      {brandProfileId:profile.id,userId:suspended.id,role:'manager',status:'active'},{brandProfileId:profile.id,userId:roleless.id,role:'manager',status:'active'}]);
    const [variant]=await db.select().from(schema.productVariants).where(gt(schema.productVariants.stockQuantity,FIXTURE.two)).limit(FIXTURE.one);assert(variant);
    async function order(customerId=customer.id){
      const id=randomUUID();const [row]=await db.insert(schema.orders).values({id,orderNumber:FIXTURE.prefix+id,customerId,brandId:profile.id,
        status:ORDER_STATUS.pendingPayment,subtotalAmount:FIXTURE.amount,totalAmount:FIXTURE.amount,currency:FIXTURE.currency,
        shippingAddress:{name:FIXTURE.displayName},stripePaymentIntentId:FIXTURE.prefix+id,paymentProvider:'stripe',
        commerceSnapshot:{returnWindowDays:FIXTURE.monthDays,returnPolicy:FIXTURE.reason,refundPolicyCode:ORDER_RETURN.policy.code}}).returning();
      const [item]=await db.insert(schema.orderItems).values({orderId:id,productId:variant.productId,productVariantId:variant.id,
        productSnapshot:{name:FIXTURE.displayName,sku:FIXTURE.prefix},quantity:FIXTURE.quantity,unitPrice:FIXTURE.amount,totalPrice:FIXTURE.amount}).returning();
      return {row,item};
    }
    const paid=await order(),finalizer=new DrizzleStripePaymentFinalizer(session);
    const paidInput={orderId:paid.row.id,paymentIntentId:paid.row.stripePaymentIntentId!,eventId:FIXTURE.prefix+randomUUID(),amount:FIXTURE.amount,currency:FIXTURE.currency};
    assert.equal((await finalizer.confirm(paidInput)).reversalRequired,false);
    let list=await messages(paid.row.id);assert.equal(list.length,FIXTURE.two);assert.deepEqual(list.map(row=>row.recipientUserId).sort(),[customer.id,manager.id].sort());
    assert.deepEqual(list.map(row=>row.audience).sort(),['brand','customer']);cases++;
    await finalizer.confirm(paidInput);await finalizer.confirm({...paidInput,eventId:FIXTURE.prefix+randomUUID()});
    assert.equal((await messages(paid.row.id)).length,FIXTURE.two);cases++;
    const shipmentRepository=new DrizzleShipmentRepository(session);
    const shipment=await shipmentRepository.findByOrderId(paid.row.id);assert(shipment);const shipmentId=shipment.id;
    async function ship(action:unknown){return shipmentRepository.transaction(async tx=>{
      const context=await tx.lockContext(shipmentId);assert(context);
      const parsed=(await import('../src/modules/shipping/domain/shipping.contract')).shipmentActionSchema.parse(action);
      const change=applyShipmentAction(context,parsed,new Date().toISOString());await tx.apply(change,context.shipment.version);return change;
    });}
    await ship({action:SHIPMENT_ACTION.prepare,expectedVersion:1});
    await ship({action:SHIPMENT_ACTION.ship,expectedVersion:2,...FIXTURE.shipment});
    const shipped=await ship({action:SHIPMENT_ACTION.updateTracking,expectedVersion:3,...FIXTURE.shipment});
    list=await messages(shipment.id);assert.equal(list.length,FIXTURE.three);assert(list.every(row=>row.recipientUserId===customer.id&&row.audience==='customer'));cases++;
    await assert.rejects(()=>shipmentRepository.transaction(tx=>tx.apply(shipped,3)));assert.equal((await messages(shipment.id)).length,FIXTURE.three);cases++;
    await ship({action:SHIPMENT_ACTION.deliver,expectedVersion:4});assert.equal((await messages(shipment.id)).length,4);cases++;
    const returns=new DrizzleOrderReturnRepository(session),now=new Date();
    const document:OrderReturn={id:randomUUID(),orderId:paid.row.id,brandId:profile.id,version:1,status:RETURN_STATUS.requested,
      reason:FIXTURE.reason,items:[{orderItemId:paid.item.id,quantity:1}],amounts:{merchandiseAmount:FIXTURE.amount,taxAmount:0,shippingAmount:0,totalAmount:FIXTURE.amount,completesOrder:true,refundPolicyCode:ORDER_RETURN.policy.code},
      requestedAt:now.toISOString(),updatedAt:now.toISOString(),deadline:new Date(now.getTime()+FIXTURE.dayMs*FIXTURE.monthDays).toISOString(),
      refundedAt:null,brandDecision:null,dispute:null,adminDecision:null,tracking:null,reception:null};
    await returns.transaction(tx=>tx.insert(document,randomUUID(),FIXTURE.fingerprint,FIXTURE.reason));
    assert.equal((await messages(document.id)).length,FIXTURE.two);cases++;
    const approved=applyReturnAction(document,'brand',{action:RETURN_ACTION.approve,expectedVersion:1,instructions:FIXTURE.reason},now.toISOString());
    await returns.transaction(tx=>tx.save(approved,1));assert.equal((await messages(document.id)).length,4);cases++;
    const sent=applyReturnAction(approved,'customer',{action:RETURN_ACTION.send,expectedVersion:2,...FIXTURE.shipment},now.toISOString());
    await returns.transaction(tx=>tx.save(sent,2));
    const received=applyReturnAction(sent,'brand',{action:RETURN_ACTION.receive,expectedVersion:3,items:[{orderItemId:paid.item.id,restockQuantity:0}]},now.toISOString());
    await returns.transaction(async tx=>{await tx.save(received,3);await tx.queueRefund(received,false);});
    assert.equal((await messages(document.id)).length,8);cases++;
    const [attempt]=await db.select().from(schema.orderReturnRefunds).where(eq(schema.orderReturnRefunds.returnId,document.id));assert(attempt);
    const refundClaim={returnId:document.id,orderId:paid.row.id,attemptId:attempt.id,paymentIntentId:paidInput.paymentIntentId,originalAmount:FIXTURE.amount,
      amount:FIXTURE.amount,currency:FIXTURE.currency,refundId:null};
    const refundResult={state:RETURN_REFUND.state.succeeded,refundId:FIXTURE.refunded+randomUUID(),providerStatus:RETURN_REFUND.providerStatus.succeeded};
    const refunds=new DrizzleReturnRefundRepository(session);await refunds.settle(refundClaim,refundResult);
    assert.equal((await messages(document.id)).length,10);cases++;
    await refunds.settle(refundClaim,refundResult);assert.equal((await messages(document.id)).length,10);cases++;
    const cancelled=await order();await finalizer.confirm({...paidInput,orderId:cancelled.row.id,paymentIntentId:cancelled.row.stripePaymentIntentId!,eventId:FIXTURE.prefix+randomUUID()});
    const cancellationRepository=new DrizzleOrderCancellationRepository(session),claim=await cancellationRepository.claim(customer.id,cancelled.row.id);
    await cancellationRepository.complete(claim,{outcome:CANCELLATION.outcome.refunded,refundId:FIXTURE.refunded+randomUUID()});
    assert.equal((await messages(cancelled.row.id)).length,4);cases++;
    await cancellationRepository.complete(claim,{outcome:CANCELLATION.outcome.refunded,refundId:FIXTURE.refunded+randomUUID()});
    assert.equal((await messages(cancelled.row.id)).length,4);cases++;
    // Force a storage failure at the actual email insertion boundary. Its decision and provisioning must roll back.
    const beforeEmail=await emailCount(),newApplicant=await user();
    await assert.rejects(()=>db.transaction(async failure=>{
      await failure.execute(sql.raw("create function pg_temp.reject_notification_proof() returns trigger language plpgsql as $$ begin raise exception 'notification_proof_rejected' using errcode='23514'; end $$; create trigger notification_proof_failure before insert on ufit.notification_email_deliveries for each row execute function pg_temp.reject_notification_proof();"));
      const failedService=new ApplicationsService(new DrizzleApplicationsRepository({db:failure}),new DrizzleApplicationWorkflow({db:failure}));
      await failedService.submitCreatorApplication({...creatorInput,userId:newApplicant.id,email:newApplicant.email});
    }));
    assert.equal((await db.select().from(schema.creatorApplications).where(eq(schema.creatorApplications.userId,newApplicant.id))).length,FIXTURE.zero);
    assert.equal(await emailCount(),beforeEmail);cases++;
    const selfPurchase=await order(manager.id);
    await finalizer.confirm({...paidInput,orderId:selfPurchase.row.id,paymentIntentId:selfPurchase.row.stripePaymentIntentId!,eventId:FIXTURE.prefix+randomUUID()});
    const selfMessages=await messages(selfPurchase.row.id);
    assert.equal(selfMessages.length,FIXTURE.two);assert(selfMessages.every(row=>row.recipientUserId===manager.id));
    assert.deepEqual(selfMessages.map(row=>row.audience).sort(),['brand','customer']);cases++;
    const failedOrder=await order(),failedEvent=FIXTURE.prefix+randomUUID();
    const [stockBefore]=await db.select({stock:schema.productVariants.stockQuantity}).from(schema.productVariants).where(eq(schema.productVariants.id,variant.id));
    await assert.rejects(()=>db.transaction(async failure=>{
      await failure.execute(sql.raw("create function pg_temp.reject_notification_proof() returns trigger language plpgsql as $$ begin raise exception 'notification_proof_rejected' using errcode='23514'; end $$; create trigger notification_proof_failure before insert on ufit.notification_email_deliveries for each row execute function pg_temp.reject_notification_proof();"));
      await new DrizzleStripePaymentFinalizer({db:failure}).confirm({...paidInput,orderId:failedOrder.row.id,paymentIntentId:failedOrder.row.stripePaymentIntentId!,eventId:failedEvent});
    }));
    const [unpaid]=await db.select().from(schema.orders).where(eq(schema.orders.id,failedOrder.row.id));
    assert.equal(unpaid.status,ORDER_STATUS.pendingPayment);
    assert.equal((await db.select().from(schema.payments).where(eq(schema.payments.orderId,failedOrder.row.id))).length,FIXTURE.zero);
    assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId,failedOrder.row.id))).length,FIXTURE.zero);
    assert.equal((await db.select().from(schema.stripeWebhookEvents).where(eq(schema.stripeWebhookEvents.stripeEventId,failedEvent))).length,FIXTURE.zero);
    const [stockAfter]=await db.select({stock:schema.productVariants.stockQuantity}).from(schema.productVariants).where(eq(schema.productVariants.id,variant.id));
    assert.equal(stockAfter.stock,stockBefore.stock);assert.equal((await messages(failedOrder.row.id)).length,FIXTURE.zero);cases++;
    const linked=await db.select({id:schema.notificationEmailDeliveries.id}).from(schema.notifications)
      .leftJoin(schema.notificationEmailDeliveries,eq(schema.notificationEmailDeliveries.notificationId,schema.notifications.id));
    assert(linked.every(row=>row.id!==null));cases++;
    throw new RollbackProof();
  });}catch(error){if(!(error instanceof RollbackProof))throw error;}
  return cases;
}

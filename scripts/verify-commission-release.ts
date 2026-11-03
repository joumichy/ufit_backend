import 'reflect-metadata';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {getEnv} from '../src/config/env';
import {orders,orderItems,shipments,commissions,commissionRules,creatorProfiles,orderReturns,orderReturnItems,returnCommissionAdjustments,orderCancellations} from '../src/shared/infrastructure/database/schema';
import {DrizzleAdminRepository} from '../src/modules/admin/infrastructure/drizzle-admin.repository';
import {DrizzleWorkspaceFinanceReader} from '../src/modules/workspaces/infrastructure/drizzle-workspace-finance.reader';
import {ORDER_RETURN,RETURN_STATUS} from '../src/modules/orders/domain/order-return.contract';
import {COMMISSION_RELEASE as RELEASE} from '../src/modules/commissions/domain/commission-release';
import {ORDER_STATUS,ORDER_COMMISSION,CANCELLATION} from '../src/modules/orders/domain/order-lifecycle';
import {SHIPMENT_STATUS} from '../src/modules/shipping/domain/shipping.contract';

const fixture = {
  node:'development',port:4014,schema:'ufit',keyPrefix:'sk_test_',
  registry:homedir()+'/.codex/private/ufit/qualification.credentials.json',
  tables:['orders','order_items','shipments','commissions','commission_rules','order_returns','order_return_items','return_commission_adjustments','order_cancellations'],
  windowDays:30,unit:100,quantity:3,base:300,commission:25,rate:'0.0833',zeroRate:'0.0000',
  currency:'CHF',prefix:'QUAL-COMMISSION-RELEASE-',reason:'Qualification disponibilité en transaction annulée.',
  fingerprint:'a'.repeat(64),millisecondInterval:'1 millisecond',zero:0,one:1,fullPage:50,conflict:409,adjustment:8,
} as const;
class VerificationRollback extends Error {}
async function verify() {
  const env=getEnv();assert.equal(env.NODE_ENV,fixture.node);assert.equal(env.API_PORT,fixture.port);assert.equal(env.UFIT_DB_SCHEMA,fixture.schema);assert(env.STRIPE_SECRET_KEY?.startsWith(fixture.keyPrefix));
  const registry=JSON.parse(await readFile(fixture.registry,'utf8')),db=new DatabaseService(),before=new Map<string,string>();let checks=fixture.zero as number;
  const digest=async(table:string)=>(await db.query<{digest:string}>('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) digest from "ufit"."'+table+'" t')).rows[fixture.zero].digest;
  try{for(const table of fixture.tables)before.set(table,await digest(table));
    await assert.rejects(db.db.transaction(async tx=>{
      const reader=new DrizzleWorkspaceFinanceReader({db:tx}),admin=new DrizzleAdminRepository({db:tx});
      const adminPage={limit:fixture.fullPage,offset:fixture.zero};
      const adminBaseline=(await admin.listQueue('commissions',adminPage)).page.total;
      const[source]=await tx.select().from(orders).where(eq(orders.id,registry.qualification.brandOrderFulfillment.orderID));assert(source);
      const[item]=await tx.select().from(orderItems).where(eq(orderItems.orderId,source.id));assert(item);
      const[original]=await tx.select().from(commissions).where(eq(commissions.orderItemId,item.id));assert(original);
      const[creator]=await tx.select().from(creatorProfiles).where(eq(creatorProfiles.id,original.creatorId));assert(creator);
      const ruleId=randomUUID();await tx.insert(commissionRules).values({id:ruleId,scopeId:randomUUID(),revision:fixture.one,brandId:source.brandId,baseRate:fixture.rate,bonusRate:fixture.zeroRate,active:false,reason:fixture.reason});
      const id=randomUUID(),itemId=randomUUID(),otherItemId=randomUUID(),commissionId=randomUUID(),otherCommissionId=randomUUID();
      const snapshot={...source.commerceSnapshot,returnWindowDays:fixture.windowDays};
      await tx.insert(orders).values({id,orderNumber:fixture.prefix+id,customerId:source.customerId,brandId:source.brandId,status:ORDER_STATUS.paid,
        subtotalAmount:fixture.base+fixture.base,shippingAmount:fixture.zero,taxAmount:fixture.zero,totalAmount:fixture.base+fixture.base,currency:fixture.currency,shippingAddress:source.shippingAddress,commerceSnapshot:snapshot});
      for(const currentId of [itemId,otherItemId])await tx.insert(orderItems).values({id:currentId,orderId:id,productId:item.productId,productVariantId:item.productVariantId,
        productSnapshot:item.productSnapshot,quantity:fixture.quantity,unitPrice:fixture.unit,totalPrice:fixture.base,commissionRate:fixture.rate,commissionRuleId:ruleId,
        commissionCreatorGradeCode:creator.gradeCode,sourceCreatorId:creator.id,sourceOutfitId:original.sourceOutfitId});
      for(const[currentId,currentItemId]of [[commissionId,itemId],[otherCommissionId,otherItemId]])await tx.insert(commissions).values({id:currentId,orderItemId:currentItemId,
        creatorId:creator.id,brandId:source.brandId,sourceOutfitId:original.sourceOutfitId,baseAmount:fixture.base,commissionRate:fixture.rate,commissionAmount:fixture.commission,status:ORDER_COMMISSION.status.pending});
      await tx.insert(shipments).values({orderId:id,brandId:source.brandId,status:SHIPMENT_STATUS.pending});
      const current=async()=>{const page=await reader.commissionPage(creator.id,{limit:fixture.fullPage,offset:fixture.zero});const value=page.items.find(row=>row.id===commissionId);assert(value);return value;};
      const expectRelease=async(state:string,status:string)=>{const value=await current();assert.equal(value.release.state,state);assert.equal(value.status,status);assert.equal(value.originalAmount,fixture.commission);return value;};
      assert.equal((await expectRelease(RELEASE.state.awaitingDelivery,ORDER_COMMISSION.status.pending)).release.availableAt,null);checks++;
      assert.equal((await admin.listQueue('commissions',adminPage)).page.total,adminBaseline+fixture.one+fixture.one);checks++;
      await tx.update(orders).set({status:ORDER_STATUS.delivered}).where(eq(orders.id,id));
      const rejects=()=>assert.rejects(current(),(error:any)=>error.getStatus()===fixture.conflict);
      await rejects();checks++;
      // PostgreSQL transaction time fixes the exact inclusive return boundary.
      await tx.update(shipments).set({status:SHIPMENT_STATUS.delivered,deliveredAt:sql`current_timestamp-(${fixture.windowDays}::numeric*${ORDER_RETURN.time.dayMilliseconds})*${fixture.millisecondInterval}::interval`}).where(eq(shipments.orderId,id));
      const boundary=await expectRelease(RELEASE.state.returnWindow,ORDER_COMMISSION.status.pending);assert(boundary.release.availableAt);checks++;
      await tx.update(shipments).set({deliveredAt:sql`current_timestamp-(${fixture.windowDays}::numeric*${ORDER_RETURN.time.dayMilliseconds}+${fixture.one})*${fixture.millisecondInterval}::interval`}).where(eq(shipments.orderId,id));
      await expectRelease(RELEASE.state.payable,ORDER_COMMISSION.status.validated);checks++;
      assert.equal((await admin.listQueue('commissions',adminPage)).page.total,adminBaseline);checks++;
      const beforeHold=(await reader.creatorCommissions(creator.id)).find(row=>row.currency===fixture.currency)!;
      const returnId=randomUUID();await tx.insert(orderReturns).values({id:returnId,orderId:id,requestId:randomUUID(),requestFingerprint:fixture.fingerprint,status:RETURN_STATUS.requested,
        reason:fixture.reason,returnPolicy:fixture.reason,deadline:sql`current_timestamp`,refundPolicyCode:ORDER_RETURN.policy.code,merchandiseAmount:fixture.unit,taxAmount:fixture.zero,shippingAmount:fixture.zero,totalAmount:fixture.unit,completesOrder:false});
      const[returnItem]=await tx.insert(orderReturnItems).values({returnId,orderId:id,orderItemId:itemId,quantity:fixture.one}).returning();
      for(const state of [RETURN_STATUS.requested,RETURN_STATUS.approved,RETURN_STATUS.rejected,RETURN_STATUS.disputed,RETURN_STATUS.inTransit]){
        await tx.update(orderReturns).set({status:state}).where(eq(orderReturns.id,returnId));await expectRelease(RELEASE.state.returnOpen,ORDER_COMMISSION.status.pending);checks++;
      }
      const adminHeld=await admin.listQueue('commissions',adminPage);const adminItem=adminHeld.items.find(row=>row.id===commissionId)!;
      assert.equal(adminHeld.page.total,adminBaseline+fixture.one);assert.equal(adminItem.status,ORDER_COMMISSION.status.pending);assert.equal(adminItem.currency,fixture.currency);assert.equal(adminItem.amount,fixture.commission);assert.equal(adminItem.title,fixture.prefix+id);checks++;
      const afterHold=(await reader.creatorCommissions(creator.id)).find(row=>row.currency===fixture.currency)!;
      assert.equal(beforeHold.validatedAmount-afterHold.validatedAmount,fixture.commission);assert.equal(afterHold.pendingAmount-beforeHold.pendingAmount,fixture.commission);
      const neighbour=(await reader.commissionPage(creator.id,{limit:fixture.fullPage,offset:fixture.zero})).items.find(row=>row.id===otherCommissionId)!;
      assert.equal(neighbour.release.state,RELEASE.state.payable);checks++;
      for(const state of [RETURN_STATUS.refundPending,RETURN_STATUS.refundFailed]){
        await tx.update(orderReturns).set({status:state,receivedAt:sql`current_timestamp`,allocationNumber:fixture.one}).where(eq(orderReturns.id,returnId));await expectRelease(RELEASE.state.returnOpen,ORDER_COMMISSION.status.pending);checks++;
      }
      await tx.insert(returnCommissionAdjustments).values({commissionId,returnItemId:returnItem.id,amount:fixture.adjustment});
      await tx.update(orderReturns).set({status:RETURN_STATUS.refunded,refundedAt:sql`current_timestamp`}).where(eq(orderReturns.id,returnId));
      assert.equal((await expectRelease(RELEASE.state.payable,ORDER_COMMISSION.status.validated)).netAmount,fixture.commission-fixture.adjustment);checks++;
      for(const state of [RETURN_STATUS.closed,RETURN_STATUS.withdrawn]){
        await tx.update(orderReturns).set({status:state,refundedAt:null}).where(eq(orderReturns.id,returnId));await expectRelease(RELEASE.state.payable,ORDER_COMMISSION.status.validated);checks++;
      }
      await tx.update(commissions).set({status:ORDER_COMMISSION.status.validated}).where(eq(commissions.id,commissionId));
      await tx.update(orderReturns).set({status:RETURN_STATUS.disputed}).where(eq(orderReturns.id,returnId));await expectRelease(RELEASE.state.returnOpen,ORDER_COMMISSION.status.pending);checks++;
      assert.equal((await admin.listQueue('commissions',adminPage)).items.find(row=>row.id===commissionId)!.amount,fixture.commission-fixture.adjustment);checks++;
      await tx.update(orderReturns).set({status:RETURN_STATUS.withdrawn}).where(eq(orderReturns.id,returnId));
      await tx.insert(orderCancellations).values({orderId:id,originalStatus:ORDER_STATUS.paid,reason:CANCELLATION.reason.customer,status:CANCELLATION.status.requested});
      await expectRelease(RELEASE.state.cancellationOpen,ORDER_COMMISSION.status.pending);checks++;
      await tx.update(orderCancellations).set({status:CANCELLATION.status.failed}).where(eq(orderCancellations.orderId,id));
      for(const value of [null,'30',-fixture.one,fixture.one/fixture.windowDays,Number.MAX_SAFE_INTEGER]){
        await tx.update(orders).set({commerceSnapshot:{...snapshot,returnWindowDays:value}}).where(eq(orders.id,id));await rejects();checks++;
      }
      await tx.update(orders).set({commerceSnapshot:{...snapshot,returnWindowDays:fixture.zero}}).where(eq(orders.id,id));
      await tx.update(shipments).set({deliveredAt:sql`current_timestamp-${fixture.millisecondInterval}::interval`}).where(eq(shipments.orderId,id));await expectRelease(RELEASE.state.payable,ORDER_COMMISSION.status.validated);checks++;
      await tx.update(shipments).set({deliveredAt:sql`current_timestamp+${fixture.millisecondInterval}::interval`}).where(eq(shipments.orderId,id));await rejects();checks++;
      await tx.update(shipments).set({deliveredAt:sql`current_timestamp`}).where(eq(shipments.orderId,id));
      await tx.update(commissions).set({status:ORDER_COMMISSION.status.paid}).where(eq(commissions.id,commissionId));
      const paid=await expectRelease(RELEASE.state.paid,ORDER_COMMISSION.status.paid);assert.equal(paid.paidAdjustmentAmount,fixture.adjustment);checks++;
      await tx.update(commissions).set({status:ORDER_COMMISSION.status.cancelled}).where(eq(commissions.id,commissionId));assert.equal((await expectRelease(RELEASE.state.cancelled,ORDER_COMMISSION.status.cancelled)).netAmount,fixture.zero);checks++;
      await tx.update(commissions).set({status:ORDER_COMMISSION.status.estimated}).where(eq(commissions.id,commissionId));await expectRelease(RELEASE.state.estimated,ORDER_COMMISSION.status.estimated);checks++;
      throw new VerificationRollback();
    }),VerificationRollback);
    for(const[table,hash]of before)assert.equal(await digest(table),hash,table+' changed after rollback');
    console.log(JSON.stringify({commissionReleaseSqlChecks:checks,exactBoundary:true,holdScopedToLine:true,rollbackVerified:true,providerCalls:fixture.zero}));
  }finally{await db.onModuleDestroy();}
}
void verify().catch(error=>{console.error(error instanceof Error?error.message:'Commission release verification failed');process.exitCode=1;});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {orders,orderItems,shipments,commissions,commissionRules,creatorProfiles,orderReturns,orderReturnItems,returnCommissionAdjustments} from '../src/shared/infrastructure/database/schema';
import {DrizzleCommissionLedgerRepository} from '../src/modules/commissions/infrastructure/drizzle-commission-ledger.repository';
import {COMMISSION_LEDGER as LEDGER,commissionLedgerQuerySchema,commissionRelatedQuerySchema} from '../src/modules/commissions/domain/commission-ledger.contract';
import {COMMISSION_RELEASE as RELEASE} from '../src/modules/commissions/domain/commission-release';
import {ORDER_STATUS,ORDER_COMMISSION} from '../src/modules/orders/domain/order-lifecycle';
import {ORDER_RETURN,RETURN_STATUS} from '../src/modules/orders/domain/order-return.contract';
import {SHIPMENT_STATUS} from '../src/modules/shipping/domain/shipping.contract';

const fixture={node:'development',port:4014,schema:'ufit',testKey:'sk_test_',registry:homedir()+'/.codex/private/ufit/qualification.credentials.json',
  tables:['orders','order_items','shipments','commissions','commission_rules','order_returns','order_return_items','return_commission_adjustments'],
  prefix:'QUAL-LEDGER-',quantity:1,unit:500,amount:25,rate:'0.0500',rateBps:500,bonus:'0.0100',cap:'0.0500',zeroRate:'0.0000',
  count:23,page:20,tail:3,zero:0,one:1,two:2,dayWindow:30,adjustment:5,currency:'CHF',otherCurrency:'JPY',
  reason:'Qualification du registre commissions en transaction annulée.',fingerprint:'a'.repeat(64),literal:'100%_',lookalike:'100ab',
  conflict:409,badRequest:400,microsecond:'1 microsecond',microsecondOffset:100,
} as const;
class VerificationRollback extends Error{}
async function verify(){
  const env=getEnv();assert.equal(env.NODE_ENV,fixture.node);assert.equal(env.API_PORT,fixture.port);assert.equal(env.UFIT_DB_SCHEMA,fixture.schema);assert(env.STRIPE_SECRET_KEY?.startsWith(fixture.testKey));
  const registry=JSON.parse(await readFile(fixture.registry,'utf8')),database=new DatabaseService(),before=new Map<string,string>();let checks=fixture.zero as number;
  const digest=async(table:string)=>(await database.query<{digest:string}>('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) digest from "ufit"."'+table+'" t')).rows[fixture.zero].digest;
  const rejects=async(operation:Promise<unknown>,status:number)=>assert.rejects(operation,(error:unknown)=>typeof error==='object'&&error!==null&&'getStatus'in error&&typeof error.getStatus==='function'&&error.getStatus()===status);
  try{
    for(const table of fixture.tables)before.set(table,await digest(table));
    await assert.rejects(database.db.transaction(async tx=>{
      const ledger=new DrizzleCommissionLedgerRepository({db:tx});
      const[source]=await tx.select().from(orders).where(eq(orders.id,registry.qualification.brandOrderFulfillment.orderID));assert(source);
      const[item]=await tx.select().from(orderItems).where(eq(orderItems.orderId,source.id));assert(item);
      const[original]=await tx.select().from(commissions).where(eq(commissions.orderItemId,item.id));assert(original);
      const[creator]=await tx.select().from(creatorProfiles).where(eq(creatorProfiles.id,original.creatorId));assert(creator);
      assert.equal(item.commissionRuleId,null);
      assert(item.productSnapshot!==null&&typeof item.productSnapshot==='object'&&!Array.isArray(item.productSnapshot));
      const prefix=fixture.prefix+randomUUID(),scope={kind:RELEASE.scope.creator,creatorId:creator.id};
      const ruleID=randomUUID();
      await tx.insert(commissionRules).values({id:ruleID,scopeId:randomUUID(),revision:fixture.one,brandId:source.brandId,baseRate:fixture.rate,bonusRate:fixture.bonus,maxRate:fixture.cap,active:false,supersededAt:new Date(),reason:fixture.reason});
      const ids:string[]=[],itemIds:string[]=[],orderIds:string[]=[];
      for(let index=fixture.zero as number;index<fixture.count;index++){
        const id=randomUUID(),itemID=randomUUID(),orderID=randomUUID();ids.push(id);itemIds.push(itemID);orderIds.push(orderID);
        const currency=index===fixture.zero?fixture.otherCurrency:fixture.currency;
        await tx.insert(orders).values({id:orderID,orderNumber:prefix+index,customerId:source.customerId,brandId:source.brandId,status:ORDER_STATUS.paid,
          subtotalAmount:fixture.unit,shippingAmount:fixture.zero,taxAmount:fixture.zero,totalAmount:fixture.unit,currency,shippingAddress:source.shippingAddress,
          commerceSnapshot:{...source.commerceSnapshot,returnWindowDays:fixture.dayWindow}});
        await tx.insert(orderItems).values({id:itemID,orderId:orderID,productId:item.productId,productVariantId:item.productVariantId,
          productSnapshot:{...item.productSnapshot,name:prefix+(index===fixture.zero?fixture.literal:fixture.lookalike)},quantity:fixture.quantity,
          unitPrice:fixture.unit,totalPrice:fixture.unit,commissionRate:fixture.rate,commissionRuleId:ruleID,
          commissionCreatorGradeCode:creator.gradeCode,sourceCreatorId:creator.id,sourceOutfitId:original.sourceOutfitId});
        await tx.insert(commissions).values({id,orderItemId:itemID,creatorId:creator.id,brandId:source.brandId,sourceOutfitId:original.sourceOutfitId,
          baseAmount:fixture.unit,commissionRate:fixture.rate,commissionAmount:fixture.amount,status:ORDER_COMMISSION.status.pending,
          createdAt:sql`date_trunc('milliseconds',current_timestamp)+(${fixture.microsecondOffset+index}*${fixture.microsecond}::interval)`});
        await tx.insert(shipments).values({orderId:orderID,brandId:source.brandId,status:SHIPMENT_STATUS.pending});
      }
      const query=commissionLedgerQuerySchema.parse({search:prefix});
      const first=await ledger.page(scope,query);assert.equal(first.items.length,fixture.page);assert.equal(first.totalCount,fixture.count);assert(first.nextCursor);checks++;
      const second=await ledger.page(scope,{...query,cursor:first.nextCursor,revision:first.revision});assert.equal(second.items.length,fixture.tail);assert.equal(second.nextCursor,null);checks++;
      assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,fixture.count);assert.deepEqual([...first.items,...second.items].map(row=>row.id),[...ids].reverse());checks++;
      assert(first.items.every(row=>row.creator.id===creator.id&&row.sale.quantity===fixture.quantity&&row.sale.orderNumber.startsWith(prefix)&&row.sale.productName.startsWith(prefix)));checks++;
      const literal=await ledger.page(scope,commissionLedgerQuerySchema.parse({search:prefix+fixture.literal}));assert.equal(literal.totalCount,fixture.one);assert.equal(literal.items[fixture.zero].id,ids[fixture.zero]);checks++;
      const filtered=await ledger.page(scope,{...query,currency:fixture.otherCurrency});assert.equal(filtered.totalCount,fixture.one);assert(filtered.currencies.includes(fixture.currency)&&filtered.currencies.includes(fixture.otherCurrency));checks++;
      const empty=await ledger.page(scope,{...query,state:RELEASE.state.paid});assert.equal(empty.totalCount,fixture.zero);assert.equal(empty.nextCursor,null);assert.equal(empty.items.length,fixture.zero);checks++;
      const detail=await ledger.detail(ids[fixture.one]);assert(detail?.rule);assert.equal(detail.rule.id,ruleID);assert.equal(detail.rule.maxRateBps,fixture.rateBps);assert.equal(detail.commission.rateBps,fixture.rateBps);assert.equal(detail.orderId,orderIds[fixture.one]);checks++;
      assert.equal((await ledger.detail(original.id))?.rule,null);assert.equal(await ledger.detail(randomUUID()),undefined);checks++;
      const emptyRelated=await ledger.relatedReturns(ids[fixture.one],commissionRelatedQuerySchema.parse({}));assert.equal(emptyRelated.totalCount,fixture.zero);checks++;
      const returnID=randomUUID();
      await tx.insert(orderReturns).values({id:returnID,orderId:orderIds[fixture.one],requestId:randomUUID(),requestFingerprint:fixture.fingerprint,status:RETURN_STATUS.withdrawn,reason:fixture.reason,returnPolicy:fixture.reason,deadline:sql`current_timestamp`,refundPolicyCode:ORDER_RETURN.policy.code,merchandiseAmount:fixture.unit,taxAmount:fixture.zero,shippingAmount:fixture.zero,totalAmount:fixture.unit,completesOrder:false});
      const[returnItem]=await tx.insert(orderReturnItems).values({returnId:returnID,orderId:orderIds[fixture.one],orderItemId:itemIds[fixture.one],quantity:fixture.one}).returning();
      await tx.insert(returnCommissionAdjustments).values({returnItemId:returnItem.id,commissionId:ids[fixture.one],amount:fixture.adjustment});
      const related=await ledger.relatedReturns(ids[fixture.one],commissionRelatedQuerySchema.parse({}));assert.equal(related.items[fixture.zero].adjustedAmount,fixture.adjustment);assert.equal(related.items[fixture.zero].status,RETURN_STATUS.withdrawn);assert.equal((await ledger.detail(ids[fixture.one]))?.relatedReturnCount,fixture.one);checks++;
      await rejects(ledger.page(scope,{...query,cursor:first.nextCursor,revision:first.revision}),fixture.conflict);checks++;
      const current=await ledger.page(scope,query);
      await rejects(ledger.page(scope,{...query,cursor:randomUUID(),revision:current.revision}),fixture.badRequest);checks++;
      await rejects(ledger.page(scope,{...query,currency:fixture.otherCurrency,cursor:first.items[fixture.zero].id,revision:filtered.revision}),fixture.badRequest);checks++;
      for(let index=fixture.one as number;index<fixture.count;index++){
        const nextReturnID=randomUUID();
        await tx.insert(orderReturns).values({id:nextReturnID,orderId:orderIds[fixture.one],requestId:randomUUID(),requestFingerprint:fixture.fingerprint,status:RETURN_STATUS.withdrawn,
          reason:fixture.reason,returnPolicy:fixture.reason,deadline:sql`current_timestamp`,refundPolicyCode:ORDER_RETURN.policy.code,merchandiseAmount:fixture.unit,
          taxAmount:fixture.zero,shippingAmount:fixture.zero,totalAmount:fixture.unit,completesOrder:false});
        await tx.insert(orderReturnItems).values({returnId:nextReturnID,orderId:orderIds[fixture.one],orderItemId:itemIds[fixture.one],quantity:fixture.one});
      }
      const relatedFirst=await ledger.relatedReturns(ids[fixture.one],commissionRelatedQuerySchema.parse({}));assert.equal(relatedFirst.items.length,fixture.page);assert(relatedFirst.nextCursor);checks++;
      const relatedLast=await ledger.relatedReturns(ids[fixture.one],commissionRelatedQuerySchema.parse({cursor:relatedFirst.nextCursor,revision:relatedFirst.revision}));
      assert.equal(relatedLast.items.length,fixture.tail);assert.equal(relatedLast.nextCursor,null);assert.equal(new Set([...relatedFirst.items,...relatedLast.items].map(row=>row.id)).size,fixture.count);checks++;
      assert.equal((await ledger.detail(ids[fixture.one]))?.relatedReturnCount,fixture.count);checks++;
      await tx.update(orderReturns).set({status:RETURN_STATUS.closed,version:fixture.two}).where(eq(orderReturns.id,returnID));
      await rejects(ledger.relatedReturns(ids[fixture.one],commissionRelatedQuerySchema.parse({cursor:relatedFirst.nextCursor,revision:relatedFirst.revision})),fixture.conflict);checks++;
      const administration=await ledger.page({kind:RELEASE.scope.administration},query);assert.equal(administration.totalCount,fixture.count);checks++;
      throw new VerificationRollback();
    }),VerificationRollback);
    for(const[table,hash]of before)assert.equal(await digest(table),hash,table+' changed after rollback');
    console.log(JSON.stringify({commissionLedgerSqlChecks:checks,keysetMicroseconds:true,rows:fixture.count,pages:[fixture.page,fixture.tail],literalSearch:true,frozenRule:true,rollbackVerified:true,providerCalls:fixture.zero}));
  }finally{await database.onModuleDestroy();}
}
void verify().catch(error=>{console.error(error instanceof Error?error.message:'Commission ledger verification failed');process.exitCode=1;});

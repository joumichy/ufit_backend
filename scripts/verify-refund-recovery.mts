import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {eq, sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {orderCancellationRefunds, orderCancellations, orderReturnRefunds, orderReturns, orders} from '../src/shared/infrastructure/database/schema';
import {DrizzleRefundRecoveryRepository} from '../src/modules/orders/infrastructure/drizzle-refund-recovery.repository';
import {RefundRecoveryService} from '../src/modules/orders/application/refund-recovery.service';
import {REFUND_RECOVERY, type RefundRecoveryKind, type RefundRecoverySummary} from '../src/modules/orders/domain/refund-recovery.contract';
import {CANCELLATION, CANCELLATION_REFUND, ORDER_STATUS} from '../src/modules/orders/domain/order-lifecycle';
import {ORDER_RETURN, RETURN_STATUS} from '../src/modules/orders/domain/order-return.contract';
import {RETURN_REFUND} from '../src/modules/orders/domain/return-refund';

const fixture = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  tableQuery: "select tablename from pg_tables where schemaname='ufit' order by tablename",
  prefix: 'QUAL-REFUND-RECOVERY-', refund: 're_rollback_refund_recovery_', intent: 'pi_rollback_refund_recovery_',
  zero: 0, one: 1, two: 2, three: 3, count: 21, page: 7, amount: 500, currency: 'CHF',
  timestamp: '2026-11-01T00:00:00.000Z', micros: [1, 2, 3], reason: 'Qualification transactionnelle annulée.',
  fingerprint: 'a'.repeat(64), policy: 'Qualification sans appel financier externe.',
  invalidSearch: '%_', invalidAmount: 499, invalidCurrency: 'EUR',
  result: {notFound: 404, conflict: 409},
} as const;
class VerificationRollback extends Error {}
async function main() {
  const env = getEnv();
  assert(env.NODE_ENV === fixture.profile.node && env.API_PORT === fixture.profile.port && env.UFIT_DB_SCHEMA === fixture.profile.schema && env.STRIPE_SECRET_KEY?.startsWith(fixture.profile.stripe));
  const registry = JSON.parse(await readFile(fixture.registry, 'utf8')), database = new DatabaseService();
  const prefix = fixture.prefix + randomUUID(), hashes = new Map<string,string>(), checks: string[] = [];
  async function digest(table: string) {
    assert(/^[a-z_]+$/.test(table));
    return (await database.query<{digest:string}>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."${table}" t`)).rows[fixture.zero].digest;
  }
  try {
    for(const {tablename} of (await database.query<{tablename:string}>(fixture.tableQuery)).rows) hashes.set(tablename, await digest(tablename));
    await assert.rejects(database.db.transaction(async tx => {
      const repository = new DrizzleRefundRecoveryRepository({db: tx}), service = new RefundRecoveryService(repository);
      const [source] = await tx.select().from(orders).where(eq(orders.id, registry.qualification.brandOrderFulfillment.orderID));
      assert(source);
      const expected: {id:string;kind:RefundRecoveryKind;micros:number;attemptId:string;orderId:string}[] = [];
      async function create(kind: RefundRecoveryKind, micros: number, blocked = false) {
        const id = randomUUID(), orderId = randomUUID(), attemptId = randomUUID(), intent = fixture.intent + orderId;
        await tx.insert(orders).values({id:orderId,orderNumber:prefix+orderId,customerId:source.customerId,brandId:source.brandId,
          status:ORDER_STATUS.cancelled,subtotalAmount:fixture.amount,shippingAmount:fixture.zero,taxAmount:fixture.zero,totalAmount:fixture.amount,
          currency:fixture.currency,shippingAddress:source.shippingAddress,commerceSnapshot:source.commerceSnapshot,stripePaymentIntentId:intent});
        if(kind===REFUND_RECOVERY.kind.orderReturn) {
          await tx.insert(orderReturns).values({id,orderId,requestId:randomUUID(),requestFingerprint:fixture.fingerprint,status:RETURN_STATUS.refundFailed,
            reason:fixture.reason,returnPolicy:fixture.policy,deadline:new Date(fixture.timestamp),refundPolicyCode:ORDER_RETURN.policy.code,
            merchandiseAmount:fixture.amount,taxAmount:fixture.zero,shippingAmount:fixture.zero,totalAmount:fixture.amount,completesOrder:true,
            receivedAt:new Date(fixture.timestamp),allocationNumber:fixture.one});
          await tx.insert(orderReturnRefunds).values({id:attemptId,returnId:id,attemptNumber:fixture.one,amount:fixture.amount,
            state:blocked?RETURN_REFUND.state.blocked:RETURN_REFUND.state.failed,providerStatus:blocked?null:RETURN_REFUND.providerStatus.failed,
            stripeRefundId:blocked?null:fixture.refund+attemptId,nextRecoveryAt:new Date(fixture.timestamp)});
          await tx.update(orderReturnRefunds).set({updatedAt:sql`${fixture.timestamp}::timestamptz + ${micros} * interval '1 microsecond'`}).where(eq(orderReturnRefunds.id,attemptId));
        } else {
          await tx.insert(orderCancellations).values({id,orderId,requestedBy:source.customerId,originalStatus:ORDER_STATUS.paid,reason:CANCELLATION.reason.customer,
            status:blocked?CANCELLATION.status.requested:CANCELLATION.status.failed,paymentOutcome:blocked?CANCELLATION.outcome.refundBlocked:CANCELLATION.outcome.refundFailed});
          await tx.insert(orderCancellationRefunds).values({id:attemptId,cancellationId:id,attemptNumber:fixture.one,paymentIntentId:intent,amount:fixture.amount,currency:fixture.currency,
            state:blocked?CANCELLATION_REFUND.state.blocked:CANCELLATION_REFUND.state.failed,providerStatus:blocked?null:CANCELLATION_REFUND.providerStatus.failed,
            stripeRefundId:blocked?null:fixture.refund+attemptId});
          await tx.update(orderCancellationRefunds).set({updatedAt:sql`${fixture.timestamp}::timestamptz + ${micros} * interval '1 microsecond'`}).where(eq(orderCancellationRefunds.id,attemptId));
        }
        return {id,kind,micros,attemptId,orderId};
      }
      for(let index=fixture.zero;index<fixture.count;index++) expected.push(await create(index%fixture.two===fixture.zero?REFUND_RECOVERY.kind.orderReturn:REFUND_RECOVERY.kind.cancellation,fixture.micros[index%fixture.three],index%fixture.three===fixture.zero));
      expected.sort((a,b)=>a.micros-b.micros || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      const actual: RefundRecoverySummary[] = []; let next: string | null = null;
      do {
        const page = await service.list({search:prefix,limit:fixture.page,...(next?{cursor:next}:{})});
        assert.equal(page.totalCount,fixture.count);actual.push(...page.items);next=page.nextCursor;
      } while(next);
      assert.deepEqual(actual.map(row=>({kind:row.kind,id:row.id})),expected.map(({kind,id})=>({kind,id})));
      assert.equal(new Set(actual.map(row=>row.failedAt)).size,fixture.one,'Display dates must truncate microseconds while keyset ordering must not');
      assert.equal(new Set(actual.map(row=>row.kind+row.id)).size,fixture.count);
      assert(actual.every(row=>row.amount===fixture.amount && row.currency===fixture.currency && row.brandId===source.brandId));
      checks.push('21 distinct origins over three PostgreSQL keyset pages; equal display dates preserve raw microseconds and kind/UUID ties');
      const defaultPage=await service.list({search:prefix});assert.equal(defaultPage.items.length,REFUND_RECOVERY.page.defaultLimit);assert(defaultPage.nextCursor);
      const last=await service.list({search:prefix,cursor:defaultPage.nextCursor});assert.equal(last.items.length,fixture.one);assert.equal(last.nextCursor,null);
      const returned=await service.list({search:prefix.toLowerCase(),kind:REFUND_RECOVERY.kind.orderReturn,limit:REFUND_RECOVERY.page.maximumLimit});
      assert.deepEqual(returned.items.map(row=>row.id),expected.filter(row=>row.kind===REFUND_RECOVERY.kind.orderReturn).map(row=>row.id));
      const literal=await service.list({search:fixture.invalidSearch});assert.equal(literal.totalCount,fixture.zero);
      checks.push('default page bound, actual kind filter, case-insensitive substring and literal SQL wildcard characters');
      const target=expected[fixture.zero], detail=await service.detail(target.kind,target.id);
      assert.deepEqual(Object.keys(detail).sort(),['attempt','summary']);assert.equal(detail.attempt.id,target.attemptId);
      assert.deepEqual(Object.keys(detail.summary).sort(),['amount','brandId','brandName','cause','currency','failedAt','id','kind','orderId','orderNumber'].sort());
      await assert.rejects(service.detail(target.kind,target.orderId),error=>(error as {status:number}).status===fixture.result.notFound);
      checks.push('exact nested response and composite origin lookup; an order UUID cannot impersonate a return/cancellation');
      const retry=expected.find(row=>row.kind===REFUND_RECOVERY.kind.orderReturn)!;
      await tx.insert(orderReturnRefunds).values({returnId:retry.id,attemptNumber:fixture.two,amount:fixture.amount,state:RETURN_REFUND.state.blocked,
        providerStatus:null,stripeRefundId:null,nextRecoveryAt:new Date(fixture.timestamp),updatedAt:new Date(fixture.timestamp)});
      const latest=await service.detail(retry.kind,retry.id);assert.equal(latest.attempt.number,fixture.two);assert.equal(latest.summary.cause,REFUND_RECOVERY.cause.blocked);
      assert.equal((await service.list({search:prefix})).totalCount,fixture.count);
      checks.push('latest blocked attempt replaces the failed attempt without duplicating the financial need');
      for(const kind of Object.values(REFUND_RECOVERY.kind)) {
        const canceled=await create(kind,fixture.one), pending=await create(kind,fixture.one), succeeded=await create(kind,fixture.one);
        if(kind===REFUND_RECOVERY.kind.orderReturn) {
          await tx.update(orderReturnRefunds).set({providerStatus:RETURN_REFUND.providerStatus.cancelled}).where(eq(orderReturnRefunds.id,canceled.attemptId));
          await tx.update(orderReturnRefunds).set({state:RETURN_REFUND.state.pending,providerStatus:RETURN_REFUND.providerStatus.pending}).where(eq(orderReturnRefunds.id,pending.attemptId));
          await tx.update(orderReturnRefunds).set({state:RETURN_REFUND.state.succeeded,providerStatus:RETURN_REFUND.providerStatus.succeeded}).where(eq(orderReturnRefunds.id,succeeded.attemptId));
        } else {
          await tx.update(orderCancellationRefunds).set({providerStatus:CANCELLATION_REFUND.providerStatus.cancelled}).where(eq(orderCancellationRefunds.id,canceled.attemptId));
          await tx.update(orderCancellationRefunds).set({state:CANCELLATION_REFUND.state.pending,providerStatus:CANCELLATION_REFUND.providerStatus.pending}).where(eq(orderCancellationRefunds.id,pending.attemptId));
          await tx.update(orderCancellationRefunds).set({state:CANCELLATION_REFUND.state.succeeded,providerStatus:CANCELLATION_REFUND.providerStatus.succeeded}).where(eq(orderCancellationRefunds.id,succeeded.attemptId));
        }
        for(const row of [canceled,pending,succeeded]) await assert.rejects(service.detail(kind,row.id),error=>(error as {status:number}).status===fixture.result.notFound);
      }
      assert.equal((await service.list({search:prefix})).totalCount,fixture.count);
      checks.push('provider-canceled, pending and successful attempts are excluded for both origin kinds');
      const firstPage=await service.list({search:prefix,limit:fixture.one});assert(firstPage.nextCursor);
      const anchor=firstPage.items[fixture.zero];
      if(anchor.kind===REFUND_RECOVERY.kind.orderReturn) await tx.update(orderReturns).set({status:RETURN_STATUS.closed}).where(eq(orderReturns.id,anchor.id));
      else await tx.update(orderCancellations).set({status:CANCELLATION.status.succeeded}).where(eq(orderCancellations.id,anchor.id));
      await assert.rejects(service.list({search:prefix,cursor:firstPage.nextCursor}),error=>(error as {status:number}).status===fixture.result.conflict);
      checks.push('a removed/ineligible cursor anchor requires refresh instead of silently skipping a page');
      const invalid=await create(REFUND_RECOVERY.kind.orderReturn,fixture.one);
      await tx.update(orderReturnRefunds).set({amount:fixture.invalidAmount}).where(eq(orderReturnRefunds.id,invalid.attemptId));
      await assert.rejects(service.detail(invalid.kind,invalid.id),error=>(error as {status:number}).status===fixture.result.conflict);
      const invalidCurrency=await create(REFUND_RECOVERY.kind.cancellation,fixture.one);
      await tx.update(orderCancellationRefunds).set({currency:fixture.invalidCurrency}).where(eq(orderCancellationRefunds.id,invalidCurrency.attemptId));
      await assert.rejects(service.detail(invalidCurrency.kind,invalidCurrency.id),error=>(error as {status:number}).status===fixture.result.conflict);
      checks.push('inconsistent parent/attempt amounts or currencies fail closed without inventing a refund value');
      throw new VerificationRollback();
    }),error=>error instanceof VerificationRollback);
    for(const [table,before] of hashes) assert.equal(await digest(table),before,'Rollback changed '+table);
    console.log(JSON.stringify({repositoryScenarios:checks.length,checks,preservedTables:hashes.size,persistedQualificationRows:fixture.zero}));
  } finally {await database.onModuleDestroy();}
}
await main();

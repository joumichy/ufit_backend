import 'reflect-metadata';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {count, eq, inArray, sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import {commissions, commissionRules, creatorProfiles, orderCancellations, orderCancellationRefunds, orderItems, orders, payments, productVariants, shipments, users} from '../src/shared/infrastructure/database/schema';
import {DrizzleOrderCancellationRepository} from '../src/modules/orders/infrastructure/drizzle-order-cancellation.repository';
import {DrizzleOrderRepository} from '../src/modules/orders/infrastructure/drizzle-orders.repository';
import {DrizzleBrandOrdersRepository} from '../src/modules/orders/infrastructure/drizzle-brand-orders.repository';
import {DrizzleStripePaymentFinalizer} from '../src/modules/payments/infrastructure/drizzle-stripe-payment-finalizer';
import {CANCELLATION, CANCELLATION_REFUND, ORDER_STATUS, ORDER_PAYMENT, ORDER_COMMISSION, type OrderStatus, type CancellationClaim, type CancellationRefundAttempt, type CancellationProviderStatus} from '../src/modules/orders/domain/order-lifecycle';
import {SHIPMENT_STATUS} from '../src/modules/shipping/domain/shipping.contract';

const fixture = {
  profile: {node: 'development', port: 4014, schema: 'ufit', keyPrefix: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  quantity: 2, unit: 100, total: 200, currency: 'CHF', rate: '0.1200', commission: 24,
  stock: 100, zero: 0, one: 1, cancelledVersion: 2,
  paymentPrefix: 'pi_qualification_cancellation_', eventPrefix: 'evt_qualification_cancellation_', refundPrefix: 're_qualification_cancellation_', orderPrefix: 'QUAL-CANCEL-',
  reason: 'Qualification financière transactionnelle.',

  schemaTables: "select tablename from pg_tables where schemaname = 'ufit' order by tablename",
  invalid: {state: 'pending', provider: null, refund: 're_invalid_provider_state'},
} as const;
class VerificationRollback extends Error {}
async function main() {
  const env = getEnv();
  assert(env.NODE_ENV === fixture.profile.node && env.API_PORT === fixture.profile.port && env.UFIT_DB_SCHEMA === fixture.profile.schema && env.STRIPE_SECRET_KEY?.startsWith(fixture.profile.keyPrefix));
  const registry = JSON.parse(await readFile(fixture.registry, 'utf8'));
  const database = new DatabaseService(), before = new Map<string,string>(), checks: string[] = [];
  const ids: string[] = [];
  async function digest(table: string) {
    assert(/^[a-z_]+$/.test(table));
    return (await database.query<{digest: string}>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."${table}" t`)).rows[fixture.zero].digest;
  }
  try {
    const [queue] = await database.db.select({value: count()}).from(orderCancellations).where(eq(orderCancellations.status, CANCELLATION.status.requested));
    assert.equal(queue.value, fixture.zero, 'Finish active cancellations before SQL verification');
    // Every existing table is compared after the rollback, including outboxes.
    const tables = (await database.query<{tablename:string}>(fixture.schemaTables)).rows.map(row=>row.tablename);
    for (const table of tables) before.set(table, await digest(table));
    await assert.rejects(database.db.transaction(async tx => {
      const session: DatabaseSession = {db: tx}, cancellations = new DrizzleOrderCancellationRepository(session), finalizer = new DrizzleStripePaymentFinalizer(session);
      const customerOrders = new DrizzleOrderRepository(session), brandOrders = new DrizzleBrandOrdersRepository(session);
      const [customer] = await tx.select().from(users).where(eq(users.email, registry.customer.email)).limit(fixture.one);
      const [admin] = await tx.select().from(users).where(eq(users.email, registry.admin.email)).limit(fixture.one);
      const [source] = await tx.select().from(orders).where(eq(orders.id, registry.qualification.brandOrderFulfillment.orderID)).limit(fixture.one);
      const [sourceItem] = await tx.select().from(orderItems).where(eq(orderItems.orderId, source.id)).limit(fixture.one);
      const [creator] = await tx.select().from(creatorProfiles).where(eq(creatorProfiles.id, sourceItem.sourceCreatorId!)).limit(fixture.one);
      assert(customer && admin && source && sourceItem && creator);
      const [rule] = await tx.insert(commissionRules).values({scopeId: randomUUID(), revision: fixture.one, brandId: source.brandId, productId: sourceItem.productId,
        creatorGradeCode: creator.gradeCode, baseRate: fixture.rate, bonusRate: String(fixture.zero), active: false, reason: fixture.reason, createdByUserId: admin.id, supersededAt: new Date()}).returning();
      const variantId = sourceItem.productVariantId;
      await tx.update(productVariants).set({stockQuantity: fixture.stock}).where(eq(productVariants.id, variantId));
      async function stock() {return (await tx.select().from(productVariants).where(eq(productVariants.id, variantId)))[fixture.zero].stockQuantity;}
      async function create(status: OrderStatus) {
        const id = randomUUID(), intent = fixture.paymentPrefix + id; ids.push(id);
        const [order] = await tx.insert(orders).values({id, orderNumber: fixture.orderPrefix+id, customerId: customer.id, brandId: source.brandId,
          status, subtotalAmount: fixture.total, shippingAmount: fixture.zero, taxAmount: fixture.zero, totalAmount: fixture.total, currency: fixture.currency,
          shippingAddress: source.shippingAddress, commerceSnapshot: source.commerceSnapshot, paymentProvider: ORDER_PAYMENT.provider, stripePaymentIntentId: intent}).returning();
        const [item] = await tx.insert(orderItems).values({orderId: id, productId: sourceItem.productId, productVariantId: variantId, productSnapshot: sourceItem.productSnapshot,
          quantity: fixture.quantity, unitPrice: fixture.unit, totalPrice: fixture.total, commissionRate: fixture.rate, commissionRuleId: rule.id,
          commissionCreatorGradeCode: creator.gradeCode, sourceCreatorId: creator.id, sourceOutfitId: sourceItem.sourceOutfitId}).returning();
        if (status !== ORDER_STATUS.pendingPayment) {
          await tx.update(productVariants).set({stockQuantity: sql`${productVariants.stockQuantity} - ${fixture.quantity}`}).where(eq(productVariants.id, variantId));
          await tx.insert(payments).values({orderId: id, provider: ORDER_PAYMENT.provider, providerPaymentIntentId: intent, status: ORDER_PAYMENT.status.succeeded, amount: fixture.total, currency: fixture.currency});
          await tx.insert(shipments).values({orderId: id, brandId: source.brandId, status: status === ORDER_STATUS.preparing ? SHIPMENT_STATUS.preparing : SHIPMENT_STATUS.pending});
          await tx.insert(commissions).values({orderItemId: item.id, creatorId: creator.id, brandId: source.brandId, sourceOutfitId: sourceItem.sourceOutfitId,
            baseAmount: fixture.total, commissionRate: fixture.rate, commissionAmount: fixture.commission, status: ORDER_COMMISSION.status.pending});
        }
        return {order,item};
      }
      async function record(claim: CancellationClaim, attempt: CancellationRefundAttempt, status: CancellationProviderStatus) {
        return cancellations.recordRefund(claim, attempt, {state: status === CANCELLATION_REFUND.providerStatus.succeeded ? CANCELLATION_REFUND.state.succeeded
          : status === CANCELLATION_REFUND.providerStatus.failed || status === CANCELLATION_REFUND.providerStatus.cancelled ? CANCELLATION_REFUND.state.failed : CANCELLATION_REFUND.state.pending,
        providerStatus: status, refundId: fixture.refundPrefix + attempt.id});
      }
      async function payment(id:string) {return (await tx.select().from(payments).where(eq(payments.orderId,id)))[fixture.zero];}
      async function cancellation(id:string) {return (await tx.select().from(orderCancellations).where(eq(orderCancellations.orderId,id)))[fixture.zero];}
      async function shipment(id:string) {return (await tx.select().from(shipments).where(eq(shipments.orderId,id)))[fixture.zero];}
      const paid = await create(ORDER_STATUS.paid), claim = await cancellations.claim(customer.id, paid.order.id), attempt = await cancellations.prepareRefund(claim);
      assert.equal((await cancellations.claim(customer.id, paid.order.id)).id,claim.id);
      assert.equal((await cancellations.prepareRefund(claim)).id,attempt.id);
      await record(claim,attempt,CANCELLATION_REFUND.providerStatus.pending); await cancellations.complete(claim);
      assert.equal(await stock(),fixture.stock-fixture.quantity); assert.equal((await cancellation(paid.order.id)).effectsApplied,false);
      assert.equal((await customerOrders.findById(paid.order.id))?.cancellation?.id,claim.id);
      assert.equal((await brandOrders.detail(source.brandId,paid.order.id))?.cancellation?.id,claim.id);
      assert.equal((await customerOrders.findById(paid.order.id))?.cancellation?.refund?.state,CANCELLATION_REFUND.state.pending);
      assert.equal((await brandOrders.detail(source.brandId,paid.order.id))?.cancellation?.refund?.state,CANCELLATION_REFUND.state.pending);
      checks.push('durable attempt identity, pending and coherent customer/brand projections');
      await record(claim,attempt,CANCELLATION_REFUND.providerStatus.succeeded); await cancellations.complete(claim); await cancellations.complete(claim);
      assert.equal(await stock(),fixture.stock); assert.equal((await payment(paid.order.id)).status,ORDER_PAYMENT.status.refunded);
      assert.equal((await shipment(paid.order.id)).version,fixture.cancelledVersion); assert.equal((await cancellation(paid.order.id)).effectsApplied,true);
      assert.equal((await tx.select().from(commissions).where(eq(commissions.orderItemId,paid.item.id)))[fixture.zero].status,ORDER_COMMISSION.status.cancelled);
      checks.push('successful cancellation reverses physical effects exactly once');
      assert.equal(await record(claim,attempt,CANCELLATION_REFUND.providerStatus.failed),true); await cancellations.complete(claim);
      assert.equal(await stock(),fixture.stock); assert.equal((await shipment(paid.order.id)).version,fixture.cancelledVersion);
      assert.equal((await payment(paid.order.id)).status,ORDER_PAYMENT.status.succeeded); assert.equal((await cancellation(paid.order.id)).status,CANCELLATION.status.failed);
      assert.equal((await cancellation(paid.order.id)).paymentOutcome,CANCELLATION.outcome.refundFailed);
      assert.equal(await record(claim,attempt,CANCELLATION_REFUND.providerStatus.pending),false); assert.equal(await record(claim,attempt,CANCELLATION_REFUND.providerStatus.succeeded),false);
      assert.equal((await cancellations.claim(customer.id,paid.order.id)).refund?.id,attempt.id);
      checks.push('late failure corrects financial truth and stale callbacks cannot resurrect it');
      await assert.rejects(cancellations.findRefund({orderId:paid.order.id,cancellationId:claim.id,attemptId:attempt.id,refundId:fixture.refundPrefix+randomUUID()}));
      await assert.rejects(cancellations.claim(admin.id,paid.order.id)); checks.push('refund identity and customer ownership are enforced');
      const interrupted=await create(ORDER_STATUS.paid), interruptedClaim=await cancellations.claim(customer.id,interrupted.order.id), interruptedAttempt=await cancellations.prepareRefund(interruptedClaim);
      await record(interruptedClaim,interruptedAttempt,CANCELLATION_REFUND.providerStatus.cancelled); await cancellations.complete(interruptedClaim);
      const retry=await cancellations.claim(customer.id,interrupted.order.id); assert(retry.refund && retry.refund.id!==interruptedAttempt.id); assert.equal(retry.refund.attemptNumber,fixture.cancelledVersion);
      assert.equal((await cancellations.claim(customer.id,interrupted.order.id)).refund?.id,retry.refund.id);
      await record(retry,retry.refund,CANCELLATION_REFUND.providerStatus.succeeded); await cancellations.complete(retry);
      assert.equal(await stock(),fixture.stock); assert.equal((await shipment(interrupted.order.id)).version,fixture.cancelledVersion);
      checks.push('explicit retry after provider cancellation creates one new attempt without restocking twice');
      const pending=await create(ORDER_STATUS.pendingPayment), pendingClaim=await cancellations.claim(customer.id,pending.order.id);
      await cancellations.complete(pendingClaim,{outcome:CANCELLATION.outcome.notCharged});
      const confirmation={eventId:fixture.eventPrefix+randomUUID(),orderId:pending.order.id,paymentIntentId:pending.order.stripePaymentIntentId!,amount:fixture.total,currency:fixture.currency};
      assert.equal((await finalizer.confirm(confirmation)).reversalRequired,true); assert.equal((await finalizer.confirm(confirmation)).reversalRequired,true);
      const lateClaim=await cancellations.findPending(pending.order.id); assert(lateClaim); assert.equal((await cancellation(pending.order.id)).effectsApplied,true);
      const lateAttempt=await cancellations.prepareRefund(lateClaim); await record(lateClaim,lateAttempt,CANCELLATION_REFUND.providerStatus.succeeded); await cancellations.complete(lateClaim);
      assert.equal(await stock(),fixture.stock); assert.equal(await shipment(pending.order.id),undefined); assert.equal((await finalizer.confirm(confirmation)).reversalRequired,false);
      checks.push('captured payment after a completed no-charge cancellation reopens only compensation');
      const race=await create(ORDER_STATUS.pendingPayment), raceClaim=await cancellations.claim(customer.id,race.order.id);
      await finalizer.confirm({...confirmation,eventId:fixture.eventPrefix+randomUUID(),orderId:race.order.id,paymentIntentId:race.order.stripePaymentIntentId!});
      await assert.rejects(cancellations.complete(raceClaim,{outcome:CANCELLATION.outcome.notCharged}));
      const raceAttempt=await cancellations.prepareRefund(raceClaim); await record(raceClaim,raceAttempt,CANCELLATION_REFUND.providerStatus.succeeded); await cancellations.complete(raceClaim);
      assert.equal(await stock(),fixture.stock); checks.push('capture racing with a no-charge response cannot be settled as uncharged');
      const preparing=await create(ORDER_STATUS.preparing); await assert.rejects(cancellations.claim(customer.id,preparing.order.id));
      assert.equal(await cancellation(preparing.order.id),undefined); checks.push('preparation prevents cancellation');
      const payout=await create(ORDER_STATUS.paid), payoutClaim=await cancellations.claim(customer.id,payout.order.id), payoutAttempt=await cancellations.prepareRefund(payoutClaim);
      await tx.update(commissions).set({status:ORDER_COMMISSION.status.paid}).where(eq(commissions.orderItemId,payout.item.id));
      await record(payoutClaim,payoutAttempt,CANCELLATION_REFUND.providerStatus.succeeded); await assert.rejects(cancellations.complete(payoutClaim));
      assert.equal((await payment(payout.order.id)).status,ORDER_PAYMENT.status.refunded); assert.equal((await cancellation(payout.order.id)).effectsApplied,false);
      assert.equal((await cancellation(payout.order.id)).paymentOutcome,CANCELLATION.outcome.refunded);
      checks.push('provider truth survives a physical reversal blocked by an already-paid commission');
      // Resolve only this transaction fixture to exercise the existing completion gate.
      await tx.update(commissions).set({status:ORDER_COMMISSION.status.pending}).where(eq(commissions.orderItemId,payout.item.id)); await cancellations.complete(payoutClaim);
      const short=await create(ORDER_STATUS.pendingPayment);
      const variants=await tx.select().from(productVariants).where(eq(productVariants.productId,sourceItem.productId));
      const other=variants.find(row=>row.id!==variantId); assert(other,'A second existing variant is required');
      await tx.update(productVariants).set({stockQuantity:fixture.zero}).where(eq(productVariants.id,other.id));
      await tx.insert(orderItems).values({orderId:short.order.id,productId:sourceItem.productId,productVariantId:other.id,productSnapshot:sourceItem.productSnapshot,quantity:fixture.quantity,unitPrice:fixture.unit,totalPrice:fixture.total,commissionRate:String(fixture.zero)});
      await tx.update(orders).set({subtotalAmount:fixture.total+fixture.total,totalAmount:fixture.total+fixture.total}).where(eq(orders.id,short.order.id));
      const shortStock=await stock(), shortConfirmation={...confirmation,eventId:fixture.eventPrefix+randomUUID(),orderId:short.order.id,paymentIntentId:short.order.stripePaymentIntentId!,amount:fixture.total+fixture.total};
      assert.equal((await finalizer.confirm(shortConfirmation)).reversalRequired,true); assert.equal(await stock(),shortStock);
      const shortClaim=await cancellations.findPending(short.order.id); assert(shortClaim); assert.equal(shortClaim.reason,CANCELLATION.reason.stockUnavailable);
      const shortAttempt=await cancellations.prepareRefund(shortClaim); await record(shortClaim,shortAttempt,CANCELLATION_REFUND.providerStatus.pending);
      assert((await cancellations.claimRecoverable()).some(row=>row.id===shortClaim.id)); assert(!(await cancellations.claimRecoverable()).some(row=>row.id===shortClaim.id));
      await record(shortClaim,shortAttempt,CANCELLATION_REFUND.providerStatus.succeeded); await cancellations.complete(shortClaim);
      assert.equal(await stock(),shortStock); assert.equal(await shipment(short.order.id),undefined); assert.equal((await finalizer.confirm(shortConfirmation)).reversalRequired,false);
      checks.push('stock shortage compensates without inventory mutation, with durable recovery lease');
      await assert.rejects(tx.transaction(async sp=>{await sp.insert(orderCancellationRefunds).values({cancellationId:claim.id,attemptNumber:fixture.cancelledVersion,paymentIntentId:attempt.paymentIntentId,amount:fixture.total,currency:fixture.currency,state:fixture.invalid.state,providerStatus:fixture.invalid.provider,stripeRefundId:fixture.invalid.refund});}));
      checks.push('SQL rejects a refund state whose required provider status is null');
      throw new VerificationRollback();
    }),error=>error instanceof VerificationRollback);
    assert.equal((await database.db.select({value:count()}).from(orders).where(inArray(orders.id,ids)))[fixture.zero].value,fixture.zero);
    for(const [table,hash] of before) assert.equal(await digest(table),hash,'Rollback changed '+table);
    console.log(JSON.stringify({repositoryScenarios:checks.length,checks,preservedTables:before.size,persistedQualificationRows:fixture.zero}));
  } finally {await database.onModuleDestroy();}
}
await main();

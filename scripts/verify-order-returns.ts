import 'reflect-metadata';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {and, count, eq, inArray, sql} from 'drizzle-orm';
import {z} from 'zod';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import {orders, orderItems, payments, shipments, users, brandMembers, commissions, productVariants} from '../src/shared/infrastructure/database/schema';
import {orderReturns, orderReturnItems, orderReturnRefunds, returnCommissionAdjustments} from '../src/shared/infrastructure/database/schema.returns';
import {OrderReturnsService} from '../src/modules/orders/application/order-returns.service';
import {DrizzleOrderReturnRepository} from '../src/modules/orders/infrastructure/drizzle-order-return.repository';
import {DrizzleReturnRefundRepository} from '../src/modules/orders/infrastructure/drizzle-return-refund.repository';
import type {ReturnScope} from '../src/modules/orders/domain/order-return.repository';
import {RETURN_REFUND_ATTEMPT, type ReturnRefundClaim} from '../src/modules/orders/domain/return-refund';
import {ORDER_RETURN} from '../src/modules/orders/domain/order-return.contract';

const fixture = {
  profile: {node: 'development', port: 4014, keyPrefix: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  orderPrefix: 'QUAL-RETURN-', paymentPrefix: 'pi_qualification_return_', refundPrefix: 're_qualification_return_',
  quantity: 3, unitPrice: 100, subtotal: 300, tax: 25, shipping: 80, total: 405, currency: 'CHF', commission: 25, rate: '0.0833',
  roles: ['customer', 'brand', 'admin'] as const,
  tables: ['orders', 'order_items', 'payments', 'commissions', 'product_variants', 'shipments', 'users', 'user_roles', 'brand_members', 'brand_profiles', 'order_status_history', 'order_returns', 'order_return_items', 'order_return_refunds', 'return_commission_adjustments'],
  reason: 'Qualification du retour.', instructions: 'Retourner la pièce à la marque de qualification.',
  paginationRows: 55, pageSize: 20, zero: 0, one: 1,
} as const;
const account = z.object({email: z.email()});
const registrySchema = z.object({customer: account, brand: account, admin: account,
  qualification: z.object({brandOrderFulfillment: z.object({orderID: z.uuid()})})});
class VerificationRollback extends Error {}

async function verify(): Promise<void> {
  const env = getEnv();
  assert(env.NODE_ENV === fixture.profile.node && env.API_PORT === fixture.profile.port && env.STRIPE_SECRET_KEY?.startsWith(fixture.profile.keyPrefix), 'Return verification requires the selected development4014 TEST profile');
  const registry = registrySchema.parse(JSON.parse(await readFile(fixture.registry, 'utf8')));
  const database = new DatabaseService(), before = new Map<string, string>();
  let passed = fixture.zero as number;
  const createdOrders: string[] = [];
  async function digest(table: string): Promise<string> {
    const result = await database.query<{digest: string}>('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.' + table + ' t');
    return result.rows[fixture.zero].digest;
  }
  async function denied(action: () => Promise<unknown>, status: number): Promise<void> {
    await assert.rejects(action, (error: unknown) => typeof error === 'object' && error !== null && 'getStatus' in error && typeof error.getStatus === 'function' && error.getStatus() === status);
  }
  try {
    const [pending] = await database.db.select({value: count()}).from(orderReturnRefunds).where(inArray(orderReturnRefunds.state, [RETURN_REFUND_ATTEMPT.queued, RETURN_REFUND_ATTEMPT.pending]));
    assert.equal(pending.value, fixture.zero, 'Finish the active return refund queue before running SQL qualification');
    for (const table of fixture.tables) before.set(table, await digest(table));
    await assert.rejects(database.db.transaction(async tx => {
      const session: DatabaseSession = {db: tx}, repository = new DrizzleOrderReturnRepository(session), service = new OrderReturnsService(repository), refunds = new DrizzleReturnRefundRepository(session);
      const actors = new Map<typeof fixture.roles[number], string>();
      for (const role of fixture.roles) {
        const [actor] = await tx.select({id: users.id}).from(users).where(eq(users.email, registry[role].email)).limit(fixture.one);
        assert(actor, 'A qualification actor is unavailable in the selected database'); actors.set(role, actor.id);
      }
      const customer = actors.get('customer')!, brand = actors.get('brand')!, admin = actors.get('admin')!;
      const [source] = await tx.select().from(orders).where(eq(orders.id, registry.qualification.brandOrderFulfillment.orderID)).limit(fixture.one);
      assert(source, 'The qualification source order is unavailable');
      const [sourceItem] = await tx.select().from(orderItems).where(eq(orderItems.orderId, source.id)).limit(fixture.one);
      assert(sourceItem, 'The qualification source item is unavailable');
      const [sourceCommission] = await tx.select().from(commissions).where(eq(commissions.orderItemId, sourceItem.id)).limit(fixture.one);
      assert(sourceItem && sourceCommission, 'The source item and creator attribution are required');
      const id = randomUUID(), itemId = randomUUID(), intentId = fixture.paymentPrefix + id, at = new Date(); createdOrders.push(id);
      await tx.insert(orders).values({id, orderNumber: fixture.orderPrefix + id, customerId: customer, brandId: source.brandId,
        sourceCreatorId: sourceCommission.creatorId, sourceOutfitId: sourceCommission.sourceOutfitId,
        status: 'delivered', subtotalAmount: fixture.subtotal, shippingAmount: fixture.shipping, taxAmount: fixture.tax, totalAmount: fixture.total, currency: fixture.currency,
        shippingAddress: source.shippingAddress, commerceSnapshot: {returnWindowDays: 30, returnPolicy: fixture.instructions, refundPolicyCode: ORDER_RETURN.policy.code},
        paymentProvider: 'stripe', stripePaymentIntentId: intentId});
      await tx.insert(orderItems).values({id: itemId, orderId: id, productId: sourceItem.productId, productVariantId: sourceItem.productVariantId,
        productSnapshot: sourceItem.productSnapshot, quantity: fixture.quantity, unitPrice: fixture.unitPrice, totalPrice: fixture.subtotal,
        commissionRate: fixture.rate, sourceCreatorId: sourceCommission.creatorId, sourceOutfitId: sourceCommission.sourceOutfitId});
      await tx.insert(payments).values({orderId: id, provider: 'stripe', providerPaymentIntentId: intentId, amount: fixture.total, currency: fixture.currency, status: 'succeeded'});
      await tx.insert(shipments).values({orderId: id, brandId: source.brandId, status: 'delivered', carrier: 'Qualification', trackingNumber: id, shippedAt: at, deliveredAt: at});
      const [commission] = await tx.insert(commissions).values({orderItemId: itemId, creatorId: sourceCommission.creatorId, brandId: source.brandId,
        sourceOutfitId: sourceCommission.sourceOutfitId, baseAmount: fixture.subtotal, commissionRate: fixture.rate, commissionAmount: fixture.commission, status: 'pending'}).returning();
      const customerScope: ReturnScope = {kind: 'customer', orderId: id}, brandScope: ReturnScope = {kind: 'brand', brandId: source.brandId}, adminScope: ReturnScope = {kind: 'administrator'};
      const selection = {items: [{orderItemId: itemId, quantity: 1}]};
      const originalStock = (await tx.select({value: productVariants.stockQuantity}).from(productVariants).where(eq(productVariants.id, sourceItem.productVariantId)))[fixture.zero].value;
      async function create() {
        const quote = await service.preview(customer, id, selection), input = {...selection, requestId: randomUUID(), reason: fixture.reason, quoteFingerprint: quote.fingerprint};
        const document = await service.create(customer, id, input);
        assert.equal((await service.create(customer, id, input)).id, document.id);
        return {document, quote};
      }
      let {document: current, quote} = await create(); assert.equal(quote.amounts.totalAmount, 108);
      await denied(() => service.detail(customer, adminScope, current.id), 403);
      await denied(() => service.detail(brand, customerScope, current.id), 404);
      await denied(() => service.detail(customer, {kind: 'customer', orderId: source.id}, current.id), 404); passed++;
      await assert.rejects(tx.transaction(async nested => {
        await nested.update(brandMembers).set({status: 'removed'}).where(and(eq(brandMembers.userId, brand), eq(brandMembers.brandProfileId, source.brandId)));
        await denied(() => new OrderReturnsService(new DrizzleOrderReturnRepository({db: nested})).act(brand, brandScope, current.id, {action: 'approve', expectedVersion: 1, instructions: fixture.instructions}), 403);
        throw new VerificationRollback();
      }), VerificationRollback); passed++;
      current = await service.act(brand, brandScope, current.id, {action: 'reject', expectedVersion: 1, reason: fixture.reason});
      current = await service.act(customer, customerScope, current.id, {action: 'dispute', expectedVersion: 2, reason: fixture.reason});
      current = await service.act(admin, adminScope, current.id, {action: 'arbitrate_approve', expectedVersion: 3, reason: fixture.reason, instructions: fixture.instructions});
      assert.equal(current.brandDecision?.decision, 'rejected'); assert(current.adminDecision?.reason); passed++;
      current = await service.act(customer, customerScope, current.id, {action: 'send', expectedVersion: 4, carrier: 'Qualification', trackingNumber: current.id});
      const receive = {action: 'receive', expectedVersion: 5, items: [{orderItemId: itemId, restockQuantity: 1}]};
      await assert.rejects(tx.transaction(async nested => {
        await new OrderReturnsService(new DrizzleOrderReturnRepository({db: nested})).act(brand, brandScope, current.id, receive); throw new VerificationRollback();
      }), VerificationRollback);
      assert.equal((await service.detail(customer, customerScope, current.id)).version, 5);
      assert.equal((await tx.select({value: count()}).from(orderReturnRefunds).innerJoin(orderReturns, eq(orderReturns.id, orderReturnRefunds.returnId)).where(eq(orderReturns.orderId, id)))[fixture.zero].value, 0); passed++;
      current = await service.act(brand, brandScope, current.id, receive);
      await denied(() => service.act(brand, brandScope, current.id, receive), 409);
      async function claim(): Promise<ReturnRefundClaim> {
        const claims = await refunds.claimRecoverable(), found = claims.find(value => value.orderId === id); assert(found, 'The return attempt was not recoverable');
        assert(!(await refunds.claimRecoverable()).some(value => value.orderId === id)); return found;
      }
      const firstClaim = await claim(), firstRefundId = fixture.refundPrefix + firstClaim.attemptId;
      await refunds.settle(firstClaim, {state: 'pending', refundId: firstRefundId, providerStatus: 'pending'});
      assert.equal((await service.detail(customer, customerScope, current.id)).version, 7);
      await refunds.settle(firstClaim, {state: 'pending', refundId: firstRefundId, providerStatus: 'pending'});
      assert.equal((await service.detail(customer, customerScope, current.id)).version, 7);
      await refunds.settle(firstClaim, {state: 'succeeded', refundId: firstRefundId, providerStatus: 'succeeded'});
      await refunds.settle(firstClaim, {state: 'succeeded', refundId: firstRefundId, providerStatus: 'succeeded'});
      assert.equal((await service.detail(customer, customerScope, current.id)).version, 8); passed++;
      const second = await create(); current = second.document; assert.equal(second.quote.amounts.totalAmount, 108);
      current = await service.act(brand, brandScope, current.id, {action: 'approve', expectedVersion: 1, instructions: fixture.instructions});
      current = await service.act(brand, brandScope, current.id, {action: 'receive', expectedVersion: 2, items: [{orderItemId: itemId, restockQuantity: 0}]});
      const failedClaim = await claim();
      await refunds.settle(failedClaim, {state: 'failed', refundId: fixture.refundPrefix + failedClaim.attemptId, providerStatus: 'failed'});
      current = await service.act(brand, brandScope, current.id, {action: 'retry_refund', expectedVersion: 4}); assert.equal(current.refund?.attemptNumber, 2);
      const retriedClaim = await claim(); assert.notEqual(retriedClaim.attemptId, failedClaim.attemptId);
      await refunds.settle(retriedClaim, {state: 'succeeded', refundId: fixture.refundPrefix + retriedClaim.attemptId, providerStatus: 'succeeded'}); passed++;
      const last = await create(); current = last.document;
      assert.equal(last.quote.amounts.taxAmount, 9); assert.equal(last.quote.amounts.shippingAmount, 80); assert.equal(last.quote.amounts.totalAmount, 189);
      current = await service.act(brand, brandScope, current.id, {action: 'approve', expectedVersion: 1, instructions: fixture.instructions});
      current = await service.act(brand, brandScope, current.id, {action: 'receive', expectedVersion: 2, items: [{orderItemId: itemId, restockQuantity: 0}]});
      const lastClaim = await claim(), finalRefund = {state: 'succeeded', refundId: fixture.refundPrefix + lastClaim.attemptId, providerStatus: 'succeeded'} as const;
      await assert.rejects(tx.transaction(async nested => {
        await nested.update(commissions).set({status: 'paid'}).where(eq(commissions.id, commission.id));
        await new DrizzleReturnRefundRepository({db: nested}).settle(lastClaim, finalRefund);
        assert.equal((await nested.select().from(commissions).where(eq(commissions.id, commission.id)))[fixture.zero].status, 'paid');
        assert.equal((await nested.select().from(returnCommissionAdjustments).where(eq(returnCommissionAdjustments.commissionId, commission.id))).reduce<number>((sum, row) => sum + row.amount, fixture.zero), 25);
        throw new VerificationRollback();
      }), VerificationRollback); passed++;
      await refunds.settle(lastClaim, finalRefund);
      assert.equal((await repository.order(id, false))?.status, 'refunded');
      assert.equal((await tx.select().from(commissions).where(eq(commissions.id, commission.id)))[fixture.zero].status, 'cancelled');
      const attempts = await tx.select({amount: orderReturnRefunds.amount, state: orderReturnRefunds.state}).from(orderReturnRefunds).innerJoin(orderReturns, eq(orderReturns.id, orderReturnRefunds.returnId)).where(eq(orderReturns.orderId, id));
      assert.equal(attempts.filter(row => row.state === 'succeeded').reduce<number>((sum, row) => sum + row.amount, fixture.zero), 405);
      assert.equal((await tx.select({value: productVariants.stockQuantity}).from(productVariants).where(eq(productVariants.id, sourceItem.productVariantId)))[fixture.zero].value, originalStock + 1); passed++;
      const ids = Array.from({length: fixture.paginationRows}, () => randomUUID());
      await tx.insert(orderReturns).values(ids.map(returnId => ({id: returnId, orderId: id, requestId: randomUUID(), requestFingerprint: 'b'.repeat(64), status: 'withdrawn', version: 2,
        reason: fixture.reason, returnPolicy: fixture.instructions, deadline: at, refundPolicyCode: ORDER_RETURN.policy.code, merchandiseAmount: 100, taxAmount: 8, shippingAmount: 0, totalAmount: 108, completesOrder: false, createdAt: at, updatedAt: at})));
      await tx.insert(orderReturnItems).values(ids.map(returnId => ({returnId, orderId: id, orderItemId: itemId, quantity: 1})));
      const seen: string[] = []; let cursor: string | undefined;
      do { const page = await service.list(brand, brandScope, {limit: fixture.pageSize, status: 'withdrawn', cursor}); seen.push(...page.items.filter(value => value.orderId === id).map(value => value.id)); cursor = page.nextCursor ?? undefined; } while (cursor);
      assert.deepEqual(new Set(seen), new Set(ids)); assert.equal(seen.length, fixture.paginationRows); passed++;
      throw new VerificationRollback();
    }), VerificationRollback);
    for (const [table, hash] of before) assert.equal(await digest(table), hash, 'Return verification did not restore ' + table);
    const [remaining] = await database.db.select({value: count()}).from(orders).where(inArray(orders.id, createdOrders)); assert.equal(remaining.value, fixture.zero);
    console.log(JSON.stringify({repositoryScenarios: passed, persistedQualificationRows: remaining.value, noStripeCalls: true, threePartialRefundsConserve405MinorUnits: true, allBusinessAndFinancialTablesRestored: true}));
  } finally {await database.onModuleDestroy();}
}
void verify().catch(error => {console.error(error instanceof Error ? error.message : 'Return verification failed'); process.exitCode = 1;});

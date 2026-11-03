import 'reflect-metadata';
import {DrizzleCommissionLedgerRepository} from '../src/modules/commissions/infrastructure/drizzle-commission-ledger.repository';
import {CommissionLedgerService} from '../src/modules/commissions/application/commission-ledger.service';
import {commissionLedgerQuerySchema} from '../src/modules/commissions/domain/commission-ledger.contract';
import {COMMISSION_RELEASE} from '../src/modules/commissions/domain/commission-release';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {eq, ne, sql, and, isNull} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {READ_SNAPSHOT} from '../src/shared/infrastructure/database/database-session';
import {orders, orderItems, payments, shipments, commissions, creatorProfiles, orderCancellations, orderReturns, orderReturnItems, orderReturnRefunds, returnCommissionAdjustments, users, userRoles, brandMembers, commissionRules} from '../src/shared/infrastructure/database/schema';
import {DrizzleWorkspaceFinanceReader} from '../src/modules/workspaces/infrastructure/drizzle-workspace-finance.reader';
import {DrizzleWorkspacesRepository} from '../src/modules/workspaces/infrastructure/drizzle-workspaces.repository';
import {WorkspacesService} from '../src/modules/workspaces/application/workspaces.service';
import {WORKSPACE_FINANCE, type WorkspaceSales} from '../src/modules/workspaces/domain/workspace-finance';
import {ORDER_RETURN} from '../src/modules/orders/domain/order-return.contract';

const fixture = {
  profile: {node: 'development', port: 4014, keyPrefix: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  orderPrefix: 'QUAL-FINANCE-', paymentPrefix: 'pi_qualification_finance_', refundPrefix: 're_qualification_finance_',
  currencies: ['CHF', 'JPY', 'BHD'], quantity: 3, unit: 100, merchandise: 300, other: 100, subtotal: 400, shipping: 80, tax: 25, total: 505,
  returnMerchandise: 100, returnTax: 8, returnTotal: 108, commission: 25, adjustment: 8, rate: '0.0833',
  tables: ['orders', 'order_items', 'payments', 'shipments', 'commissions', 'order_cancellations', 'order_returns', 'order_return_items', 'order_return_refunds', 'return_commission_adjustments', 'users', 'user_roles', 'brand_members', 'commission_rules'],
  returnWindowDays: 30,
  zeroRate: '0.0000', reason: 'Qualification financière en transaction annulée.', zero: 0, one: 1, two: 2, denied: 403, conflict: 409,
} as const;
class VerificationRollback extends Error {}

async function verify(): Promise<void> {
  const env = getEnv();
  assert(env.NODE_ENV === fixture.profile.node && env.API_PORT === fixture.profile.port && env.STRIPE_SECRET_KEY?.startsWith(fixture.profile.keyPrefix), 'Financial verification requires the selected development4014 TEST profile');
  const registry = JSON.parse(await readFile(fixture.registry, 'utf8'));
  const sourceId = registry.qualification.brandOrderFulfillment.orderID;
  assert(typeof sourceId === 'string');
  const database = new DatabaseService(), before = new Map<string, string>();
  let passed = fixture.zero as number;
  async function digest(table: string): Promise<string> {
    const result = await database.query<{digest: string}>('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.' + table + ' t');
    return result.rows[fixture.zero].digest;
  }
  async function denied(operation: () => Promise<unknown>, expected: number): Promise<void> {
    await assert.rejects(operation, (error: unknown) => typeof error === 'object' && error !== null && 'getStatus' in error && typeof error.getStatus === 'function' && error.getStatus() === expected);
  }
  try {
    for (const table of fixture.tables) before.set(table, await digest(table));
    await database.db.transaction(async tx => {
      const result = await tx.execute<{isolation: string; access: string}>(
        // These settings prove the snapshot options of the shared database owner.
        sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as access`);
      assert.equal(result.rows[fixture.zero].isolation, READ_SNAPSHOT.isolationLevel);
      assert.equal(result.rows[fixture.zero].access, 'on'); passed++;
    }, READ_SNAPSHOT);
    await assert.rejects(database.db.transaction(async tx => {
      const session = {db: tx}, reader = new DrizzleWorkspaceFinanceReader(session), ledger = new DrizzleCommissionLedgerRepository(session), ledgerService = new CommissionLedgerService(ledger);
      const [source] = await tx.select().from(orders).where(eq(orders.id, sourceId)); assert(source);
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.orderId, source.id)); assert(item?.sourceCreatorId);
      const [sourceCommission] = await tx.select().from(commissions).where(eq(commissions.orderItemId, item.id)); assert(sourceCommission);
      const creatorId = sourceCommission.creatorId;
      const [otherCreator] = await tx.select().from(creatorProfiles).where(ne(creatorProfiles.id, creatorId)); assert(otherCreator, 'Two owned creator profiles are required');
      const [creator] = await tx.select().from(creatorProfiles).where(eq(creatorProfiles.id, creatorId)); assert(creator);
      const [admin] = await tx.select().from(users).where(eq(users.email, registry.admin.email)); assert(admin);
      await tx.update(commissionRules).set({supersededAt: new Date()}).where(and(eq(commissionRules.brandId, source.brandId), isNull(commissionRules.supersededAt)));
      const ruleId = randomUUID();
      await tx.insert(commissionRules).values({id: ruleId, scopeId: randomUUID(), revision: fixture.one, brandId: source.brandId,
        baseRate: fixture.rate, bonusRate: fixture.zeroRate, active: true, reason: fixture.reason, createdByUserId: admin.id});
      const scopes = {brand: {kind: WORKSPACE_FINANCE.scope.brand, profileId: source.brandId}, creator: {kind: WORKSPACE_FINANCE.scope.creator, profileId: creatorId}};
      const baseline = {brand: await reader.sales(scopes.brand), creator: await reader.sales(scopes.creator)};
      const commissionBaseline = await reader.creatorCommissions(creatorId);
      const pick = (value: WorkspaceSales, currency: string) => value.currencies.find(row => row.currency === currency);
      async function assertDelta(currency: string, expected: {captured: number; refunded: number; pending: number}, creatorExpected: {captured: number; refunded: number; pending: number}) {
        for (const kind of ['brand', 'creator'] as const) {
          const current = pick(await reader.sales(scopes[kind]), currency)!, old = pick(baseline[kind], currency), delta = kind === 'brand' ? expected : creatorExpected;
          assert.equal(current.capturedOrderCount - (old?.capturedOrderCount ?? fixture.zero), fixture.one);
          assert.equal(current.capturedAmount - (old?.capturedAmount ?? fixture.zero), delta.captured);
          assert.equal(current.refundedAmount - (old?.refundedAmount ?? fixture.zero), delta.refunded);
          assert.equal(current.refundInProgressAmount - (old?.refundInProgressAmount ?? fixture.zero), delta.pending);
          assert.equal(current.netAmount - (old?.netAmount ?? fixture.zero), delta.captured - delta.refunded);
        }
      }
      async function capturedOrder(currency: string, captured = true) {
        const id = randomUUID(), itemId = randomUUID(), commissionId = randomUUID(), intent = fixture.paymentPrefix + id;
        await tx.insert(orders).values({id, orderNumber: fixture.orderPrefix + id, customerId: source.customerId, brandId: source.brandId,
          sourceCreatorId: otherCreator.id, sourceOutfitId: source.sourceOutfitId, status: 'delivered', subtotalAmount: fixture.subtotal,
          shippingAmount: fixture.shipping, taxAmount: fixture.tax, totalAmount: fixture.total, currency, shippingAddress: source.shippingAddress,
          commerceSnapshot: {...source.commerceSnapshot, returnWindowDays: fixture.returnWindowDays, refundPolicyCode: ORDER_RETURN.policy.code}, paymentProvider: 'stripe', stripePaymentIntentId: intent});
        await tx.insert(shipments).values({orderId: id, brandId: source.brandId, status: 'delivered', deliveredAt: sql`current_timestamp`});
        await tx.insert(orderItems).values([
          {id: itemId, orderId: id, productId: item.productId, productVariantId: item.productVariantId, productSnapshot: item.productSnapshot,
            quantity: fixture.quantity, unitPrice: fixture.unit, totalPrice: fixture.merchandise, commissionRate: fixture.rate, commissionRuleId: ruleId, commissionCreatorGradeCode: creator.gradeCode, sourceCreatorId: creatorId, sourceOutfitId: sourceCommission.sourceOutfitId},
          {orderId: id, productId: item.productId, productVariantId: item.productVariantId, productSnapshot: item.productSnapshot,
            quantity: fixture.one, unitPrice: fixture.other, totalPrice: fixture.other, commissionRate: fixture.rate, commissionRuleId: ruleId, commissionCreatorGradeCode: otherCreator.gradeCode, sourceCreatorId: otherCreator.id},
        ]);
        if (captured) await tx.insert(payments).values({orderId: id, provider: 'stripe', providerPaymentIntentId: intent, amount: fixture.total, currency, status: 'succeeded'});
        if (captured) await tx.insert(commissions).values({id: commissionId, orderItemId: itemId, creatorId, brandId: source.brandId, sourceOutfitId: sourceCommission.sourceOutfitId,
          baseAmount: fixture.merchandise, commissionRate: fixture.rate, commissionAmount: fixture.commission, status: 'pending'});
        return {id, itemId, commissionId};
      }
      const chf = await capturedOrder(fixture.currencies[fixture.zero]);
      const jpy = await capturedOrder(fixture.currencies[fixture.one]);
      const bhd = await capturedOrder(fixture.currencies[fixture.two]);
      const unpaid = await capturedOrder(fixture.currencies[fixture.zero], false);
      // Order status alone cannot create an encaissement.
      await tx.update(orders).set({status: 'paid'}).where(eq(orders.id, unpaid.id));
      await assertDelta('CHF', {captured: 505, refunded: 0, pending: 0}, {captured: 300, refunded: 0, pending: 0}); passed++;

      let allocationNumber = fixture.zero as number;
      async function returned(status: 'refunded' | 'refund_failed', attemptStates: ('succeeded' | 'failed')[]) {
        const id = randomUUID(), at = new Date();
        allocationNumber += fixture.one;
        await tx.insert(orderReturns).values({id, orderId: chf.id, requestId: randomUUID(), requestFingerprint: 'a'.repeat(64), status,
          reason: fixture.reason, returnPolicy: fixture.reason, deadline: at, refundPolicyCode: ORDER_RETURN.policy.code,
          merchandiseAmount: fixture.returnMerchandise, taxAmount: fixture.returnTax, shippingAmount: fixture.zero, totalAmount: fixture.returnTotal,
          completesOrder: false, receivedAt: at, refundedAt: status === 'refunded' ? at : null, allocationNumber});
        const [returnItem] = await tx.insert(orderReturnItems).values({returnId: id, orderId: chf.id, orderItemId: chf.itemId, quantity: fixture.one, restockQuantity: fixture.zero}).returning();
        for (const [index, state] of attemptStates.entries()) {
          await tx.insert(orderReturnRefunds).values({returnId: id, attemptNumber: index + fixture.one, amount: fixture.returnTotal,
            state, providerStatus: state, stripeRefundId: fixture.refundPrefix + randomUUID(), nextRecoveryAt: at});
        }
        await tx.insert(returnCommissionAdjustments).values({returnItemId: returnItem.id, commissionId: chf.commissionId, amount: fixture.adjustment});
        return id;
      }
      await returned('refunded', ['failed', 'succeeded']);
      await assertDelta('CHF', {captured: 505, refunded: 108, pending: 0}, {captured: 300, refunded: 100, pending: 0}); passed++;
      const pendingId = await returned('refund_failed', ['failed', 'failed']);
      await assertDelta('CHF', {captured: 505, refunded: 108, pending: 108}, {captured: 300, refunded: 100, pending: 100}); passed++;
      await tx.update(commissions).set({status: 'paid'}).where(eq(commissions.id, chf.commissionId));
      const currentCommission = (await reader.creatorCommissions(creatorId)).find(row => row.currency === 'CHF')!;
      const originalCommission = commissionBaseline.find(row => row.currency === 'CHF');
      assert.equal(currentCommission.originalAmount - (originalCommission?.originalAmount ?? fixture.zero), fixture.commission);
      assert.equal(currentCommission.paidAmount - (originalCommission?.paidAmount ?? fixture.zero), fixture.commission);
      assert.equal(currentCommission.paidAdjustmentAmount - (originalCommission?.paidAdjustmentAmount ?? fixture.zero), fixture.adjustment + fixture.adjustment);
      assert.equal(currentCommission.adjustedAmount - (originalCommission?.adjustedAmount ?? fixture.zero), fixture.adjustment + fixture.adjustment); passed++;

      for (const [order, status] of [[jpy, 'succeeded'], [bhd, 'requested']] as const) {
        await tx.insert(orderCancellations).values({orderId: order.id, originalStatus: 'paid', reason: 'customer_requested', status, paymentOutcome: status === 'succeeded' ? 'refunded' : null});
      }
      await tx.update(payments).set({status: 'refunded'}).where(eq(payments.orderId, jpy.id));
      await tx.update(orders).set({status: 'cancelled'}).where(eq(orders.id, jpy.id));
      await tx.update(commissions).set({status: 'cancelled'}).where(eq(commissions.id, jpy.commissionId));
      await assertDelta('JPY', {captured: 505, refunded: 505, pending: 0}, {captured: 300, refunded: 300, pending: 0});
      await assertDelta('BHD', {captured: 505, refunded: 0, pending: 505}, {captured: 300, refunded: 0, pending: 300});
      const cancelled = (await reader.creatorCommissions(creatorId)).find(row => row.currency === 'JPY')!;
      const priorCancelled = commissionBaseline.find(row => row.currency === 'JPY');
      assert.equal(cancelled.adjustedAmount - (priorCancelled?.adjustedAmount ?? fixture.zero), fixture.commission);
      assert.equal(cancelled.netAmount, priorCancelled?.netAmount ?? fixture.zero); passed++;

      // Invalid per-order facts cannot be hidden by a larger valid order of the same currency.
      await tx.update(orderReturns).set({totalAmount: fixture.total, merchandiseAmount: fixture.total, taxAmount: fixture.zero}).where(eq(orderReturns.id, pendingId));
      await denied(() => reader.sales(scopes.brand), fixture.conflict);
      await denied(() => reader.sales(scopes.creator), fixture.conflict); passed++;
      await tx.update(orderReturns).set({totalAmount: fixture.returnTotal, merchandiseAmount: fixture.returnMerchandise, taxAmount: fixture.returnTax}).where(eq(orderReturns.id, pendingId));
      await tx.update(payments).set({currency: 'JPY'}).where(eq(payments.orderId, chf.id));
      await denied(() => reader.sales(scopes.brand), fixture.conflict); passed++;
      await tx.update(payments).set({currency: 'CHF'}).where(eq(payments.orderId, chf.id));
      const commissionQuery = commissionLedgerQuerySchema.parse({limit: fixture.one});
      const commissionScope = {kind: COMMISSION_RELEASE.scope.creator, creatorId} as const;
      const paginated = await ledger.page(commissionScope, commissionQuery);
      let cursor: string | undefined, revision: string | undefined;
      const pagedIds = new Set<string>();
      for (let offset = fixture.zero as number; offset < paginated.totalCount; offset++) {
        const page = await ledger.page(commissionScope, {...commissionQuery,cursor,revision});
        assert.equal(page.items.length, fixture.one);
        const current = page.items[fixture.zero];
        assert(!pagedIds.has(current.id)); pagedIds.add(current.id);
        assert.equal(page.nextCursor===null, offset + fixture.one===paginated.totalCount);
        cursor=page.nextCursor===null?undefined:page.nextCursor;revision=page.nextCursor===null?undefined:page.revision;
        if (current.id === chf.commissionId) {
          assert.equal(current.currency, 'CHF'); assert.equal(current.originalAmount, fixture.commission);
          assert.equal(current.adjustedAmount, fixture.adjustment + fixture.adjustment);
          assert.equal(current.paidAdjustmentAmount, current.adjustedAmount);
          assert.equal(current.rateBps, 833);
        }
        assert(!('customerId' in current) && !('shippingAddress' in current) && !('commissionRate' in current) && !('commissionAmount' in current));
      }
      assert.equal(pagedIds.size, paginated.totalCount); passed++;
      await tx.update(commissions).set({status: 'validated'}).where(eq(commissions.id, bhd.commissionId));
      const validated = (await reader.creatorCommissions(creatorId)).find(row => row.currency === 'BHD')!;
      const oldBhd = commissionBaseline.find(row => row.currency === 'BHD');
      // A cached validation cannot release a commission during cancellation.
      assert.equal(validated.validatedAmount - (oldBhd?.validatedAmount ?? fixture.zero), fixture.zero);
      assert.equal(validated.pendingAmount - (oldBhd?.pendingAmount ?? fixture.zero), fixture.commission);
      await tx.update(commissions).set({status: 'estimated'}).where(eq(commissions.id, bhd.commissionId));
      const estimated = (await reader.creatorCommissions(creatorId)).find(row => row.currency === 'BHD')!;
      assert.equal(estimated.estimatedAmount - (oldBhd?.estimatedAmount ?? fixture.zero), fixture.commission); passed++;
      await tx.update(commissions).set({commissionAmount: fixture.one}).where(eq(commissions.id, chf.commissionId));
      await denied(() => reader.creatorCommissions(creatorId), fixture.conflict);
      await denied(() => ledger.page(commissionScope,commissionQuery), fixture.conflict); passed++;
      await tx.update(commissions).set({commissionAmount: fixture.commission}).where(eq(commissions.id, chf.commissionId));
      const service = new WorkspacesService(new DrizzleWorkspacesRepository(session));
      await service.getCreatorDashboard(creator.userId); passed++;
      await tx.update(users).set({status: 'suspended'}).where(eq(users.id, creator.userId));
      await denied(() => service.getCreatorDashboard(creator.userId), fixture.denied);
      await denied(() => ledgerService.listCreator(creator.userId, {}), fixture.denied); passed++;
      await tx.update(users).set({status: 'active'}).where(eq(users.id, creator.userId));
      const actorRoles = await tx.select().from(userRoles).where(eq(userRoles.userId, creator.userId));
      await tx.delete(userRoles).where(eq(userRoles.userId, creator.userId));
      await denied(() => service.getCreatorDashboard(creator.userId), fixture.denied);
      await denied(() => ledgerService.listCreator(creator.userId, {}), fixture.denied); passed++;
      await tx.insert(userRoles).values(actorRoles);
      const [member] = await tx.select().from(brandMembers).where(eq(brandMembers.brandProfileId, source.brandId)); assert(member);
      await tx.update(brandMembers).set({status: 'removed'}).where(eq(brandMembers.id, member.id));
      await denied(() => service.getBrandDashboard(source.brandId, member.userId), fixture.denied); passed++;
      throw new VerificationRollback();
    }), VerificationRollback);
    for (const [table, hash] of before) assert.equal(await digest(table), hash, 'Rollback changed ' + table);
    console.log(JSON.stringify({workspaceFinanceSqlScenarios: passed, rollbackVerified: true, providerCalls: fixture.zero}));
  } finally { await database.onModuleDestroy(); }
}
void verify().catch(error => { console.error(error instanceof Error ? error.message : 'Workspace finance verification failed'); process.exitCode = 1; });

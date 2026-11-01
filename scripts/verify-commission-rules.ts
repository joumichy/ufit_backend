import 'reflect-metadata';
import {CreatorGradesService} from '../src/modules/creators/grades/creator-grades.service';
import {DrizzleCreatorGradesRepository} from '../src/modules/creators/grades/drizzle-creator-grades.repository';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {and, eq, isNull, ne, sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {orders, orderItems, creatorProfiles, creatorGrades, users, userRoles, commissionRules, products} from '../src/shared/infrastructure/database/schema';
import {CommissionRulesService} from '../src/modules/commissions/application/commission-rules.service';
import {DrizzleCommissionRulesRepository, DrizzleCommissionRuleResolver} from '../src/modules/commissions/infrastructure/drizzle-commission-rules.repository';
import {OrdersService} from '../src/modules/orders/application/orders.service';
import {DrizzleOrderRepository, DrizzleProductSnapshotReader} from '../src/modules/orders/infrastructure/drizzle-orders.repository';
import type {Cart} from '../src/modules/cart/application/cart.service';
import type {CartQuote} from '../src/modules/cart/application/cart-quote.service';
import type {ShippingAddressSnapshot} from '../src/modules/orders/domain/shipping-address';
import {ORDER_RETURN} from '../src/modules/orders/domain/order-return.contract';

const proof = {
  profile: {node: 'development', port: 4014, stripePrefix: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  migrationFlag: '--with-migration', migration: '../src/shared/infrastructure/database/migrations/0021_commission_rule_revisions.sql',
  reason: 'Qualification des règles en transaction annulée.', gradePrefix: 'qual-rule-', label: 'Qualification',
  rates: {brand: 1000, grade: 1500, product: 2000, productGrade: 2500, bonus: 500, cap: 2700, revised: 3000, zero: 0},
  tables: ['commission_rules', 'creator_profiles', 'creator_grades', 'creator_grade_revisions', 'creator_grade_history', 'orders', 'order_items', 'commissions', 'payments', 'users', 'user_roles', 'schema_migrations'],
  active: 'active', admin: 'admin', suspended: 'suspended', customer: 'customer',
  status: {bad: 400, denied: 403, conflict: 409}, sql: {check: '23514', unique: '23505'},
  zero: 0, one: 1, two: 2, page: 1, request: 'qualification-rule-snapshot',
} as const;
let completedScenarios = proof.zero as number;
class VerificationRollback extends Error {}
function pgCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('actual' in error && error.actual instanceof Error) return pgCode(error.actual);
  if ('cause' in error && error.cause instanceof Error) return pgCode(error.cause);
  if ('code' in error) return error.code;
  return 'cause' in error ? pgCode(error.cause) : undefined;
}
async function statusRejected(operation: () => Promise<unknown>, status: number) {
  await assert.rejects(async () => operation(), (error: unknown) => typeof error === 'object' && error !== null && 'getStatus' in error && typeof error.getStatus === 'function' && error.getStatus() === status);
}

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === proof.profile.node && env.API_PORT === proof.profile.port && env.STRIPE_SECRET_KEY?.startsWith(proof.profile.stripePrefix), 'Commission verification requires development4014 and Stripe TEST');
  const registry = JSON.parse(await readFile(proof.registry, 'utf8'));
  const database = new DatabaseService(), before = new Map<string, string>();
  async function digest(table: string) {
    const result = await database.query<{digest: string}>('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.' + table + ' t');
    return result.rows[proof.zero].digest;
  }
  try {
    for (const table of proof.tables) before.set(table, await digest(table));
    await assert.rejects(database.db.transaction(async tx => {
      if (process.argv.includes(proof.migrationFlag)) await tx.execute(sql.raw(await readFile(resolve(__dirname, proof.migration), 'utf8')));
      const [source] = await tx.select().from(orders).where(eq(orders.id, registry.qualification.brandOrderFulfillment.orderID)); assert(source?.cartId);
      const [item] = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, source.id), sql`${orderItems.sourceCreatorId} is not null`)); assert(item?.sourceCreatorId);
      const [creator] = await tx.select().from(creatorProfiles).where(eq(creatorProfiles.id, item.sourceCreatorId)); assert(creator);
      const [admin] = await tx.select().from(users).where(eq(users.email, registry.admin.email)); assert(admin);
      const [otherProduct] = await tx.select().from(products).where(ne(products.brandId, source.brandId)); assert(otherProduct);
      await tx.update(commissionRules).set({supersededAt: new Date()}).where(and(eq(commissionRules.brandId, source.brandId), isNull(commissionRules.supersededAt)));
      const repository = new DrizzleCommissionRulesRepository({db: tx}), service = new CommissionRulesService(repository), resolver = new DrizzleCommissionRuleResolver({db: tx});
      const resolveInput = {brandId: source.brandId, productId: item.productId, creatorId: creator.id};
      await statusRejected(() => resolver.resolve(resolveInput), proof.status.conflict); completedScenarios++;
      await statusRejected(() => service.options(source.customerId, 'brands', {}), proof.status.denied); completedScenarios++;
      await statusRejected(() => service.options(admin.id, 'products', {}), proof.status.bad);
      await statusRejected(() => service.options(admin.id, 'grades', {brandId: source.brandId}), proof.status.bad); completedScenarios++;
      const brandIds = new Set<string>(); let optionCursor: string | null = null;
      do {
        const page = await service.options(admin.id, 'brands', {limit: proof.page, ...(optionCursor ? {cursor: optionCursor} : {})});
        assert.equal(page.kind, 'brands'); if (page.kind !== 'brands') throw new Error(proof.reason);
        assert.equal(page.items.length, proof.one); const option = page.items[proof.zero];
        assert(!brandIds.has(option.id)); assert(option.brandName.length > proof.zero); brandIds.add(option.id); optionCursor = page.nextCursor;
      } while (optionCursor);
      assert(brandIds.has(source.brandId) && brandIds.has(otherProduct.brandId)); completedScenarios++;
      const productOptions = await service.options(admin.id, 'products', {brandId: source.brandId});
      assert.equal(productOptions.kind, 'products'); if (productOptions.kind !== 'products') throw new Error(proof.reason);
      assert(productOptions.items.some(option => option.id === item.productId)); assert(productOptions.items.every(option => option.brandId === source.brandId)); completedScenarios++;
      await statusRejected(() => service.options(admin.id, 'products', {brandId: source.brandId, cursor: otherProduct.id}), proof.status.bad); completedScenarios++;
      const literalSearch = await service.options(admin.id, 'brands', {search: '%'}); assert.equal(literalSearch.items.length, proof.zero); completedScenarios++;
      const configuration = {baseRateBps: proof.rates.brand, bonusRateBps: proof.rates.zero, maxRateBps: null, active: true, reason: proof.reason};
      const scope = {brandId: source.brandId, productId: null, creatorGradeCode: null};
      await statusRejected(() => service.create(source.customerId, {...scope, ...configuration}), proof.status.denied); completedScenarios++;
      await statusRejected(() => service.create(admin.id, {...scope, ...configuration, baseRateBps: proof.rates.brand + 0.5}), proof.status.bad);
      await statusRejected(() => service.create(admin.id, {...scope, ...configuration, baseRate: 0.1}), proof.status.bad); completedScenarios++;
      await statusRejected(() => service.create(admin.id, {...scope, ...configuration, productId: otherProduct.id}), proof.status.bad); completedScenarios++;
      const brand = await service.create(admin.id, {...scope, ...configuration});
      assert.equal((await resolver.resolve(resolveInput)).rateBps, proof.rates.brand); completedScenarios++;
      await statusRejected(() => service.create(admin.id, {...scope, ...configuration}), proof.status.conflict); completedScenarios++;
      const grade = await service.create(admin.id, {...scope, ...configuration, creatorGradeCode: creator.gradeCode, baseRateBps: proof.rates.grade});
      assert.equal((await resolver.resolve(resolveInput)).id, grade.id); completedScenarios++;
      const product = await service.create(admin.id, {...scope, ...configuration, productId: item.productId, baseRateBps: proof.rates.product});
      assert.equal((await resolver.resolve(resolveInput)).id, product.id); completedScenarios++;
      const specific = await service.create(admin.id, {...scope, ...configuration, productId: item.productId, creatorGradeCode: creator.gradeCode, baseRateBps: proof.rates.productGrade, bonusRateBps: proof.rates.bonus, maxRateBps: proof.rates.cap});
      assert.equal((await resolver.resolve(resolveInput)).rateBps, proof.rates.cap); completedScenarios++;
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await service.list(admin.id, {brandId: source.brandId, limit: proof.page, ...(cursor ? {cursor} : {})});
        assert.equal(page.items.length, proof.one); assert(!ids.has(page.items[proof.zero].id)); ids.add(page.items[proof.zero].id); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(ids.size, proof.two + proof.two); completedScenarios++;
      await statusRejected(() => service.history(admin.id, brand.scopeId, {cursor: specific.id}), proof.status.bad); completedScenarios++;
      const cart: Cart = {id: source.cartId, userId: source.customerId, status: proof.active, brandId: source.brandId, currency: source.currency, subtotalAmount: item.unitPrice,
        sourceCreatorId: creator.id, sourceOutfitId: item.sourceOutfitId ?? undefined,
        items: [{id: randomUUID(), brandId: source.brandId, currency: source.currency, productId: item.productId, productVariantId: item.productVariantId, quantity: proof.one, unitPrice: item.unitPrice, sourceCreatorId: creator.id, sourceOutfitId: item.sourceOutfitId ?? undefined}]};
      const address = source.shippingAddress as ShippingAddressSnapshot;
      const quote: CartQuote = {cartId: cart.id, brandId: source.brandId, country: address.country, currency: source.currency, subtotalAmount: item.unitPrice, shippingAmount: proof.zero, taxAmount: proof.zero, totalAmount: item.unitPrice,
        returnWindowDays: proof.one, returnPolicy: proof.reason, taxNotice: proof.reason, customsNotice: proof.reason, pricesIncludeTaxes: true, refundPolicyCode: ORDER_RETURN.policy.code, fingerprint: proof.request, items: []};
      const orderRepository = new DrizzleOrderRepository({db: tx}), orderService = new OrdersService(orderRepository, new DrizzleProductSnapshotReader({db: tx}), resolver);
      const purchase = await orderService.createPendingFromCart(cart, address, {quote, requestId: randomUUID(), fingerprint: proof.request});
      assert.equal(purchase.items[proof.zero].commissionRuleId, specific.id);
      assert.equal(purchase.items[proof.zero].commissionCreatorGradeCode, creator.gradeCode);
      assert.equal(purchase.items[proof.zero].commissionRate, proof.rates.cap / 10_000); completedScenarios++;
      const revision = await service.revise(admin.id, specific.scopeId, {...configuration, expectedRevision: proof.one, baseRateBps: proof.rates.revised});
      assert.equal(revision.revision, proof.two); assert.equal(revision.previousRuleId, specific.id);
      assert.equal((await resolver.resolve(resolveInput)).rateBps, proof.rates.revised);
      const frozen = await orderRepository.findById(purchase.id); assert.equal(frozen!.items[proof.zero].commissionRuleId, specific.id); assert.equal(frozen!.items[proof.zero].commissionRate, proof.rates.cap / 10_000); completedScenarios++;
      await statusRejected(() => service.revise(admin.id, specific.scopeId, {...configuration, expectedRevision: proof.one}), proof.status.conflict); completedScenarios++;
      const history = await service.history(admin.id, specific.scopeId, {});
      assert.equal(history.items.length, proof.two); assert(history.items.some(row => row.id === specific.id && row.supersededAt !== null)); completedScenarios++;
      async function sqlRejected(operation: (nested: typeof tx) => Promise<unknown>, code: string) {
        await assert.rejects(tx.transaction(nested => operation(nested)), error => pgCode(error) === code);
      }
      await sqlRejected(nested => nested.update(commissionRules).set({baseRate: '0.9999'}).where(eq(commissionRules.id, specific.id)), proof.sql.check);
      await sqlRejected(nested => nested.delete(commissionRules).where(eq(commissionRules.id, revision.id)), proof.sql.check); completedScenarios++;
      await sqlRejected(nested => nested.update(orderItems).set({commissionRate: '0.9999'}).where(eq(orderItems.id, purchase.items[proof.zero].id)), proof.sql.check); completedScenarios++;
      await sqlRejected(nested => nested.insert(orderItems).values({orderId: purchase.id, productId: item.productId, productVariantId: item.productVariantId, productSnapshot: item.productSnapshot,
        quantity: proof.one, unitPrice: proof.one, totalPrice: proof.one, sourceCreatorId: creator.id, sourceOutfitId: item.sourceOutfitId}), proof.sql.check); completedScenarios++;
      const gradeCode = proof.gradePrefix + randomUUID();
      const grades = new CreatorGradesService(new DrizzleCreatorGradesRepository({db: tx}));
      await grades.create(admin.id, {code: gradeCode, label: proof.label, rank: proof.two, assignable: true, reason: proof.reason});
      await grades.change(admin.id, creator.id, {gradeCode, expectedVersion: creator.gradeVersion, reason: proof.reason});
      assert.equal((await resolver.resolve(resolveInput)).id, product.id);
      assert.equal((await orderRepository.findById(purchase.id))!.items[proof.zero].commissionCreatorGradeCode, creator.gradeCode); completedScenarios++;
      const gradeOptions = await service.options(admin.id, 'grades', {limit: proof.page});
      assert.equal(gradeOptions.kind, 'grades'); assert(gradeOptions.nextCursor);
      const nextGrades = await service.options(admin.id, 'grades', {limit: proof.page, cursor: gradeOptions.nextCursor});
      assert.equal(nextGrades.kind, 'grades');
      if (gradeOptions.kind !== 'grades' || nextGrades.kind !== 'grades') throw new Error(proof.reason);
      assert.notEqual(gradeOptions.items[proof.zero].code, nextGrades.items[proof.zero].code);
      assert(gradeOptions.items.concat(nextGrades.items).every(option => !('commissionBps' in option))); completedScenarios++;
      const labelled = await service.current(admin.id, specific.scopeId);
      const selectedBrand = await service.options(admin.id, 'brands', {search: labelled.brandName});
      assert.equal(selectedBrand.kind, 'brands'); if (selectedBrand.kind !== 'brands') throw new Error(proof.reason);
      assert(selectedBrand.items.some(option => option.id === labelled.brandId && option.brandName === labelled.brandName));
      assert.equal(typeof labelled.productName, 'string'); assert.equal(typeof labelled.creatorGradeLabel, 'string'); completedScenarios++;
      const disabledSpecific = await service.revise(admin.id, specific.scopeId, {...configuration, expectedRevision: proof.two, active: false});
      assert.equal((await resolver.resolve(resolveInput)).id, product.id); completedScenarios++;
      await service.revise(admin.id, product.scopeId, {...configuration, expectedRevision: proof.one, active: false});
      assert.equal((await resolver.resolve(resolveInput)).id, brand.id); completedScenarios++;
      await service.revise(admin.id, brand.scopeId, {...configuration, expectedRevision: proof.one, active: false});
      await statusRejected(() => resolver.resolve(resolveInput), proof.status.conflict); completedScenarios++;
      const zero = await service.revise(admin.id, product.scopeId, {...configuration, expectedRevision: proof.two, baseRateBps: proof.rates.zero});
      assert.equal((await resolver.resolve(resolveInput)).rateBps, proof.rates.zero);
      assert.equal((await orderRepository.findById(purchase.id))!.items[proof.zero].commissionRate, proof.rates.cap / 10_000); completedScenarios++;
      assert.equal(disabledSpecific.active, false); assert.equal(zero.active, true);
      const historyIds = new Set<string>(); let expectedHistoryRevision = disabledSpecific.revision;
      cursor = null;
      do {
        const page = await service.history(admin.id, specific.scopeId, {limit: proof.page, ...(cursor ? {cursor} : {})});
        assert.equal(page.items.length, proof.one); assert.equal(page.items[proof.zero].revision, expectedHistoryRevision--); assert(!historyIds.has(page.items[proof.zero].id)); historyIds.add(page.items[proof.zero].id); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(historyIds.size, proof.two + proof.one); completedScenarios++;
      await tx.update(users).set({status: proof.suspended}).where(eq(users.id, admin.id));
      await statusRejected(() => service.list(admin.id, {}), proof.status.denied);
      await statusRejected(() => service.revise(admin.id, product.scopeId, {...configuration, expectedRevision: proof.one}), proof.status.denied); completedScenarios++;
      await tx.update(users).set({status: proof.active}).where(eq(users.id, admin.id));
      await tx.delete(userRoles).where(and(eq(userRoles.userId, admin.id), sql`${userRoles.role} in ('admin', 'super_admin')`));
      await statusRejected(() => service.list(admin.id, {}), proof.status.denied); completedScenarios++;
      throw new VerificationRollback();
    }), error => error instanceof VerificationRollback);
    for (const table of proof.tables) assert.equal(await digest(table), before.get(table), 'Rollback changed ' + table);
    console.log(JSON.stringify({scenarios: completedScenarios, tablesUnchanged: proof.tables.length, providerCalls: proof.zero, rolledBack: true, migrationInRollback: process.argv.includes(proof.migrationFlag)}));
  } finally {await database.onModuleDestroy();}
}
verify().catch(error => {
  while (error?.actual instanceof Error || error?.cause instanceof Error) error = error.actual instanceof Error ? error.actual : error.cause;
  console.error(JSON.stringify({verification: 'commission_rules', failed: true, completedScenarios, code: pgCode(error), line: error?.stack?.match(/verify-commission-rules.ts:(\d+)/)?.[1], actual: typeof error?.actual === 'number' ? error.actual : undefined, expected: typeof error?.expected === 'number' ? error.expected : undefined})); process.exitCode = 1;
});

import {randomUUID} from 'node:crypto';
import {BadRequestException, ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, desc, eq, gt, isNull, lt, sql} from 'drizzle-orm';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, paymentDistributionPolicies as policies} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {PAYMENT_DISTRIBUTION as C, distributionBrandSchema, distributionBrandsSchema, distributionDocumentSchema,
  distributionHistorySchema, distributionRevisionSchema, type DistributionBrandQuery, type DistributionChange,
  type DistributionPageQuery, type DistributionRevision} from '../domain/payment-distribution';
import type {PaymentDistributionRepository} from '../domain/payment-distribution.repository';
import {assertFrozenDistributionTerms} from './order-distribution-terms';

@Injectable()
export class DrizzlePaymentDistributionRepository implements PaymentDistributionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: PaymentDistributionRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzlePaymentDistributionRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  access(actorId: string, write: boolean) { return findIdentityAccess(this.database, actorId, write ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
  async brands(query: DistributionBrandQuery) {
    const filter = query.search.length > C.limits.zero ? sql`position(lower(${query.search}) in lower(${brandProfiles.brandName}))>${C.limits.zero}` : undefined;
    if (query.cursor) {
      const [anchor] = await this.database.db.select({id: brandProfiles.id}).from(brandProfiles)
        .where(and(filter, eq(brandProfiles.id, query.cursor))).limit(C.limits.one);
      if (!anchor) throw new BadRequestException(C.failure.input);
    }
    const rows = await this.database.db.select({brand: {id: brandProfiles.id, name: brandProfiles.brandName, status: brandProfiles.status}, policy: policies})
      .from(brandProfiles).leftJoin(policies, and(eq(policies.brandId, brandProfiles.id), isNull(policies.supersededAt)))
      .where(and(filter, query.cursor ? gt(brandProfiles.id, query.cursor) : undefined)).orderBy(asc(brandProfiles.id)).limit(query.limit + C.limits.one);
    const selected = rows.slice(C.limits.zero, query.limit);
    return projection(distributionBrandsSchema, {items: selected.map(row => ({brand: row.brand, current: row.policy ? projectRevision(row.policy) : null})),
      nextCursor: rows.length > query.limit ? selected.at(-C.limits.one)!.brand.id : null});
  }
  async document(brandId: string, lock: boolean) {
    const asOf = new Date().toISOString();
    const query = this.database.db.select({id: brandProfiles.id, name: brandProfiles.brandName, status: brandProfiles.status})
      .from(brandProfiles).where(eq(brandProfiles.id, brandId)).limit(C.limits.one);
    const [brand] = await (lock ? query.for(C.lock) : query);
    if (!brand) return undefined;
    const [policy] = await this.database.db.select().from(policies).where(and(eq(policies.brandId, brandId), isNull(policies.supersededAt)));
    return projection(distributionDocumentSchema, {brand: projection(distributionBrandSchema, brand), current: policy ? projectRevision(policy) : null, asOf});
  }
  async history(brandId: string, query: DistributionPageQuery) {
    let anchor: typeof policies.$inferSelect | undefined;
    if (query.cursor) {
      [anchor] = await this.database.db.select().from(policies).where(and(eq(policies.brandId, brandId), eq(policies.id, query.cursor)));
      if (!anchor) throw new BadRequestException(C.failure.input);
    }
    const rows = await this.database.db.select().from(policies).where(and(eq(policies.brandId, brandId), anchor ? lt(policies.revision, anchor.revision) : undefined))
      .orderBy(desc(policies.revision)).limit(query.limit + C.limits.one);
    const selected = rows.slice(C.limits.zero, query.limit);
    return projection(distributionHistorySchema, {brandId, items: selected.map(projectRevision), nextCursor: rows.length > query.limit ? selected.at(-C.limits.one)!.id : null});
  }
  async change(requestId: string) {
    const [row] = await this.database.db.select().from(policies).where(eq(policies.requestId, requestId));
    return row ? {revision: projectRevision(row), actorId: row.createdByUserId, requestHash: row.requestHash} : undefined;
  }
  async revise(brandId: string, actorId: string, requestHash: string, input: DistributionChange, current: DistributionRevision | null) {
    const now = new Date();
    if (current) {
      const [retired] = await this.database.db.update(policies).set({supersededAt: now})
        .where(and(eq(policies.id, current.id), isNull(policies.supersededAt))).returning({id: policies.id});
      if (!retired) throw new ConflictException(C.failure.changed);
    }
    const [row] = await this.database.db.insert(policies).values({id: randomUUID(), brandId,
      revision: input.expectedRevision + C.limits.one, previousId: current?.id ?? null,
      requestId: input.requestId, requestHash, platformRateBps: input.platformRateBps, feeBearer: input.feeBearer,
      active: input.active, reason: input.reason, createdByUserId: actorId, createdAt: now})
      .onConflictDoNothing({target: policies.requestId}).returning();
    if (!row) throw new ConflictException(C.failure.reused);
    return projectRevision(row);
  }
  assertOrderTerms(orderId: string): Promise<void> { return assertFrozenDistributionTerms(this.database, orderId); }
}
function projectRevision(row: typeof policies.$inferSelect): DistributionRevision {
  return projection(distributionRevisionSchema, {id: row.id, brandId: row.brandId, requestId: row.requestId, revision: row.revision,
    previousId: row.previousId, platformRateBps: row.platformRateBps, feeBearer: row.feeBearer, active: row.active, reason: row.reason,
    createdAt: row.createdAt.toISOString(), supersededAt: row.supersededAt?.toISOString() ?? null});
}
function projection<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ConflictException(C.failure.persisted);
  return parsed.data;
}

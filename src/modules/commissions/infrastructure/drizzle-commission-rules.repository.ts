import {BadRequestException, ConflictException, Inject, Injectable} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {and, desc, eq, isNull, lt, or, sql} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, products, creatorGrades, creatorProfiles, users, commissionRules} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {COMMISSION_RULE, calculateRateBps, formatRateBps, parseStoredRate, type CommissionRuleRevision, type CommissionRuleQuery, type CreateCommissionRule, type ReviseCommissionRule, type CommissionRuleResolver} from '../domain/commission-rule.contract';
import {CommissionRuleOptionsReader} from './commission-rule-options.reader';
import type {CommissionOptionKind, CommissionOptionQuery} from '../domain/commission-rule-options.contract';
import type {CommissionRuleRepository} from '../domain/commission-rule.repository';

@Injectable()
export class DrizzleCommissionRulesRepository implements CommissionRuleRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: CommissionRuleRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleCommissionRulesRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  findAccess(actorId: string, write: boolean) {
    return findIdentityAccess(this.database, actorId, write ? IdentityAccessMode.Lock : IdentityAccessMode.Read);
  }
  options(kind: CommissionOptionKind, query: CommissionOptionQuery) {return new CommissionRuleOptionsReader(this.database).list(kind, query);}
  async referencesExist(input: Pick<CreateCommissionRule, 'brandId' | 'productId' | 'creatorGradeCode'>): Promise<boolean> {
    const [brand] = await this.database.db.select({id: brandProfiles.id}).from(brandProfiles).where(eq(brandProfiles.id, input.brandId)).for(COMMISSION_RULE.lock);
    if (!brand) return false;
    if (input.productId) {
      const [product] = await this.database.db.select({id: products.id}).from(products).where(and(eq(products.id, input.productId), eq(products.brandId, input.brandId))).for(COMMISSION_RULE.lock);
      if (!product) return false;
    }
    if (input.creatorGradeCode) {
      const [grade] = await this.database.db.select({code: creatorGrades.code}).from(creatorGrades).where(eq(creatorGrades.code, input.creatorGradeCode)).for(COMMISSION_RULE.lock);
      if (!grade) return false;
    }
    return true;
  }
  async list(query: CommissionRuleQuery, scopeId?: string) {
    const filter = and(query.brandId ? eq(commissionRules.brandId, query.brandId) : undefined,
      scopeId ? eq(commissionRules.scopeId, scopeId) : isNull(commissionRules.supersededAt));
    let anchor: typeof commissionRules.$inferSelect | undefined;
    if (query.cursor) {
      [anchor] = await this.database.db.select().from(commissionRules).where(and(filter, eq(commissionRules.id, query.cursor))).limit(COMMISSION_RULE.limits.singleRow);
      if (!anchor) throw new BadRequestException(COMMISSION_RULE.failure.cursor);
    }
    const rows = await readRules(this.database).where(and(filter,
      anchor ? scopeId ? lt(commissionRules.revision, anchor.revision) : sql`(${commissionRules.createdAt}, ${commissionRules.id}) < (select ${commissionRules.createdAt}, ${commissionRules.id} from ${commissionRules} where ${commissionRules.id} = ${anchor.id})` : undefined))
      .orderBy(...(scopeId ? [desc(commissionRules.revision)] : [desc(commissionRules.createdAt), desc(commissionRules.id)])).limit(query.limit + COMMISSION_RULE.limits.increment);
    const selected = rows.slice(COMMISSION_RULE.limits.firstRow, query.limit);
    return {items: selected.map(projectRule), nextCursor: rows.length > query.limit ? selected.at(-COMMISSION_RULE.limits.singleRow)!.rule.id : null};
  }
  async current(scopeId: string, lock: boolean) {
    if (lock) {
      await this.database.db.select({id: commissionRules.id}).from(commissionRules)
        .where(and(eq(commissionRules.scopeId, scopeId), eq(commissionRules.revision, COMMISSION_RULE.limits.initialRevision))).for(COMMISSION_RULE.lock);
    }
    const query = readRules(this.database).where(and(eq(commissionRules.scopeId, scopeId), isNull(commissionRules.supersededAt))).limit(COMMISSION_RULE.limits.singleRow);
    const [row] = await query;
    return row ? projectRule(row) : undefined;
  }
  async create(input: CreateCommissionRule, actorId: string) {
    const [row] = await this.database.db.insert(commissionRules).values({id: randomUUID(), scopeId: randomUUID(), revision: COMMISSION_RULE.limits.initialRevision,
      brandId: input.brandId, productId: input.productId, creatorGradeCode: input.creatorGradeCode, ...configuration(input, actorId)})
      .onConflictDoNothing().returning();
    return row ? this.revision(row.id) : undefined;
  }
  async revise(current: CommissionRuleRevision, input: ReviseCommissionRule, actorId: string) {
    const supersededAt = new Date();
    const [retired] = await this.database.db.update(commissionRules).set({supersededAt})
      .where(and(eq(commissionRules.id, current.id), isNull(commissionRules.supersededAt))).returning({id: commissionRules.id});
    if (!retired) throw new ConflictException(COMMISSION_RULE.failure.changed);
    const [row] = await this.database.db.insert(commissionRules).values({id: randomUUID(), scopeId: current.scopeId, revision: current.revision + COMMISSION_RULE.limits.increment,
      previousRuleId: current.id, brandId: current.brandId, productId: current.productId, creatorGradeCode: current.creatorGradeCode,
      createdAt: supersededAt, ...configuration(input, actorId)}).returning();
    return this.revision(row.id);
  }
  private async revision(id: string) {
    const [row] = await readRules(this.database).where(eq(commissionRules.id, id)).limit(COMMISSION_RULE.limits.singleRow);
    if (!row) throw new ConflictException(COMMISSION_RULE.failure.persisted);
    return projectRule(row);
  }
}

@Injectable()
export class DrizzleCommissionRuleResolver implements CommissionRuleResolver {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  resolve(input: {brandId: string; productId: string; creatorId: string}) {
    return this.database.db.transaction(async tx => {
      const [creator] = await tx.select({gradeCode: creatorProfiles.gradeCode}).from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
        .where(and(eq(creatorProfiles.id, input.creatorId), eq(creatorProfiles.status, COMMISSION_RULE.status.activeCreator), eq(users.status, COMMISSION_RULE.status.activeUser)))
        .limit(COMMISSION_RULE.limits.singleRow);
      if (!creator) throw new ConflictException(COMMISSION_RULE.failure.creator);
      const [row] = await tx.select().from(commissionRules).where(and(eq(commissionRules.brandId, input.brandId), eq(commissionRules.active, true), isNull(commissionRules.supersededAt),
        or(isNull(commissionRules.productId), eq(commissionRules.productId, input.productId)), or(isNull(commissionRules.creatorGradeCode), eq(commissionRules.creatorGradeCode, creator.gradeCode))))
        .orderBy(desc(sql`(case when ${commissionRules.productId} is not null then ${COMMISSION_RULE.specificity.product}::integer else ${COMMISSION_RULE.specificity.generic}::integer end)
          + (case when ${commissionRules.creatorGradeCode} is not null then ${COMMISSION_RULE.specificity.grade}::integer else ${COMMISSION_RULE.specificity.generic}::integer end)`))
        .limit(COMMISSION_RULE.limits.singleRow);
      if (!row) throw new ConflictException(COMMISSION_RULE.failure.unavailable);
      return {id: row.id, creatorGradeCode: creator.gradeCode, rateBps: calculateRateBps(storedRates(row))};
    }, READ_SNAPSHOT);
  }
}
function configuration(input: CreateCommissionRule | ReviseCommissionRule, actorId: string) {
  return {baseRate: formatRateBps(input.baseRateBps), bonusRate: formatRateBps(input.bonusRateBps), maxRate: input.maxRateBps === null ? null : formatRateBps(input.maxRateBps),
    active: input.active, reason: input.reason, createdByUserId: actorId};
}
function storedRates(row: typeof commissionRules.$inferSelect) {
  return {baseRateBps: parseStoredRate(row.baseRate), bonusRateBps: parseStoredRate(row.bonusRate), maxRateBps: row.maxRate === null ? null : parseStoredRate(row.maxRate)};
}
function readRules(database: DatabaseSession) {
  return database.db.select({rule: commissionRules, brandName: brandProfiles.brandName, productName: products.name, creatorGradeLabel: creatorGrades.label})
    .from(commissionRules).innerJoin(brandProfiles, eq(brandProfiles.id, commissionRules.brandId))
    .leftJoin(products, eq(products.id, commissionRules.productId)).leftJoin(creatorGrades, eq(creatorGrades.code, commissionRules.creatorGradeCode));
}
function projectRule(value: Awaited<ReturnType<typeof readRules>>[number]): CommissionRuleRevision {
  const row = value.rule, rates = storedRates(row);
  return {brandName: value.brandName, productName: value.productName, creatorGradeLabel: value.creatorGradeLabel, id: row.id, scopeId: row.scopeId, revision: row.revision, previousRuleId: row.previousRuleId,
    brandId: row.brandId, productId: row.productId, creatorGradeCode: row.creatorGradeCode, ...rates, rateBps: calculateRateBps(rates),
    active: row.active, reason: row.reason, createdByUserId: row.createdByUserId, createdAt: row.createdAt.toISOString(), supersededAt: row.supersededAt?.toISOString() ?? null};
}

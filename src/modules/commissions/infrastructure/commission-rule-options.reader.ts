import {BadRequestException} from '@nestjs/common';
import {and, asc, eq, ilike, or, sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, products, creatorGrades} from '../../../shared/infrastructure/database/schema';
import {COMMISSION_RULE} from '../domain/commission-rule.contract';
import {COMMISSION_OPTIONS, type CommissionOptionKind, type CommissionOptionQuery, type CommissionOptionPage} from '../domain/commission-rule-options.contract';

export class CommissionRuleOptionsReader {
  constructor(private readonly database: DatabaseSession) {}
  async list(kind: CommissionOptionKind, query: CommissionOptionQuery): Promise<CommissionOptionPage> {
    const search = query.search ? COMMISSION_OPTIONS.wildcard + query.search.replace(COMMISSION_OPTIONS.literalPattern, COMMISSION_OPTIONS.escapedLiteral) + COMMISSION_OPTIONS.wildcard : undefined;
    switch (kind) {
      case COMMISSION_OPTIONS.kind.brands: {
        const filter = search ? ilike(brandProfiles.brandName, search) : undefined;
        if (query.cursor) {
          const [anchor] = await this.database.db.select({id: brandProfiles.id}).from(brandProfiles).where(and(filter, eq(brandProfiles.id, query.cursor))).limit(COMMISSION_RULE.limits.singleRow);
          if (!anchor) throw new BadRequestException(COMMISSION_RULE.failure.cursor);
        }
        const rows = await this.database.db.select({id: brandProfiles.id, brandName: brandProfiles.brandName, status: brandProfiles.status}).from(brandProfiles)
          .where(and(filter, query.cursor ? sql`(${brandProfiles.brandName}, ${brandProfiles.id}) > (select ${brandProfiles.brandName}, ${brandProfiles.id} from ${brandProfiles} where ${brandProfiles.id} = ${query.cursor})` : undefined))
          .orderBy(asc(brandProfiles.brandName), asc(brandProfiles.id)).limit(query.limit + COMMISSION_RULE.limits.increment);
        const items = rows.slice(COMMISSION_RULE.limits.firstRow, query.limit);
        return {kind, items, nextCursor: rows.length > query.limit ? items.at(-COMMISSION_RULE.limits.singleRow)!.id : null};
      }
      case COMMISSION_OPTIONS.kind.products: {
        const filter = and(eq(products.brandId, query.brandId!), search ? ilike(products.name, search) : undefined);
        if (query.cursor) {
          const [anchor] = await this.database.db.select({id: products.id}).from(products).where(and(filter, eq(products.id, query.cursor))).limit(COMMISSION_RULE.limits.singleRow);
          if (!anchor) throw new BadRequestException(COMMISSION_RULE.failure.cursor);
        }
        const rows = await this.database.db.select({id: products.id, brandId: products.brandId, name: products.name, status: products.status}).from(products)
          .where(and(filter, query.cursor ? sql`(${products.name}, ${products.id}) > (select ${products.name}, ${products.id} from ${products} where ${products.id} = ${query.cursor})` : undefined))
          .orderBy(asc(products.name), asc(products.id)).limit(query.limit + COMMISSION_RULE.limits.increment);
        const items = rows.slice(COMMISSION_RULE.limits.firstRow, query.limit);
        return {kind, items, nextCursor: rows.length > query.limit ? items.at(-COMMISSION_RULE.limits.singleRow)!.id : null};
      }
      case COMMISSION_OPTIONS.kind.grades: {
        const filter = search ? or(ilike(creatorGrades.label, search), ilike(creatorGrades.code, search)) : undefined;
        if (query.cursor) {
          const [anchor] = await this.database.db.select({code: creatorGrades.code}).from(creatorGrades).where(and(filter, eq(creatorGrades.code, query.cursor))).limit(COMMISSION_RULE.limits.singleRow);
          if (!anchor) throw new BadRequestException(COMMISSION_RULE.failure.cursor);
        }
        const rows = await this.database.db.select({code: creatorGrades.code, label: creatorGrades.label, rank: creatorGrades.rank}).from(creatorGrades)
          .where(and(filter, query.cursor ? sql`(${creatorGrades.rank}, ${creatorGrades.code}) > (select ${creatorGrades.rank}, ${creatorGrades.code} from ${creatorGrades} where ${creatorGrades.code} = ${query.cursor})` : undefined))
          .orderBy(asc(creatorGrades.rank), asc(creatorGrades.code)).limit(query.limit + COMMISSION_RULE.limits.increment);
        const items = rows.slice(COMMISSION_RULE.limits.firstRow, query.limit);
        return {kind, items, nextCursor: rows.length > query.limit ? items.at(-COMMISSION_RULE.limits.singleRow)!.code : null};
      }
    }
  }
}

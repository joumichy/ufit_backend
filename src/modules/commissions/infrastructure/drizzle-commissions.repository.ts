import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { commissionRules, commissions, creatorGrades, creatorProfiles } from '../../../shared/infrastructure/database/schema';
import type { Commission, CommissionRepository } from '../application/commissions.service';
import type { CommissionRuleResolver } from '../../orders/application/orders.service';

@Injectable()
export class DrizzleCommissionRepository implements CommissionRepository {
  constructor(private readonly database: DatabaseService) {}

  async save(commission: Commission): Promise<Commission> {
    const [row] = await this.database.db
      .insert(commissions)
      .values({
        id: commission.id,
        orderItemId: commission.orderItemId,
        creatorId: commission.creatorId,
        brandId: commission.brandId,
        sourceOutfitId: commission.sourceOutfitId,
        baseAmount: commission.baseAmount,
        commissionRate: commission.commissionRate.toFixed(4),
        commissionAmount: commission.commissionAmount,
        status: commission.status
      })
      .returning();

    return {
      id: row.id,
      orderItemId: row.orderItemId,
      creatorId: row.creatorId,
      brandId: row.brandId,
      sourceOutfitId: row.sourceOutfitId,
      baseAmount: row.baseAmount,
      commissionRate: Number(row.commissionRate),
      commissionAmount: row.commissionAmount,
      status: row.status as Commission['status']
    };
  }
}

@Injectable()
export class DrizzleCommissionRuleResolver implements CommissionRuleResolver {
  constructor(private readonly database: DatabaseService) {}

  async resolve(input: { brandId: string; productId: string; creatorId: string; snapshotRate: number }) {
    const [creator] = await this.database.db
      .select({
        gradeCode: creatorProfiles.gradeCode,
        gradeBonusBps: creatorGrades.commissionBps
      })
      .from(creatorProfiles)
      .leftJoin(creatorGrades, eq(creatorProfiles.gradeCode, creatorGrades.code))
      .where(eq(creatorProfiles.id, input.creatorId))
      .limit(1);

    const rows = await this.database.db
      .select()
      .from(commissionRules)
      .where(and(eq(commissionRules.brandId, input.brandId), eq(commissionRules.active, true)));
    const matching = rows
      .filter((rule) => !rule.productId || rule.productId === input.productId)
      .filter((rule) => !rule.creatorGradeCode || rule.creatorGradeCode === creator?.gradeCode)
      .sort((left, right) => this.specificity(right) - this.specificity(left))[0];

    if (!matching) {
      return {
        baseRate: input.snapshotRate,
        bonusRate: (creator?.gradeBonusBps ?? 0) / 10_000
      };
    }

    return {
      baseRate: Number(matching.baseRate),
      bonusRate: Number(matching.bonusRate) + (creator?.gradeBonusBps ?? 0) / 10_000,
      maxRate: matching.maxRate === null ? undefined : Number(matching.maxRate)
    };
  }

  private specificity(rule: typeof commissionRules.$inferSelect): number {
    return (rule.productId ? 2 : 0) + (rule.creatorGradeCode ? 1 : 0);
  }
}

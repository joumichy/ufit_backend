import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import {formatRateBps, parseStoredRate} from '../domain/commission-rule.contract';
import { commissions } from '../../../shared/infrastructure/database/schema';
import type { Commission, CommissionRepository } from '../application/commissions.service';

@Injectable()
export class DrizzleCommissionRepository implements CommissionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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
        commissionRate: formatRateBps(commission.commissionRateBps),
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
      commissionRateBps: parseStoredRate(row.commissionRate),
      commissionAmount: row.commissionAmount,
      status: row.status as Commission['status']
    };
  }
}

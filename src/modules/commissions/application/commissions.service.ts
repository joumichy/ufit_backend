import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface CommissionRuleInput {
  baseRate: number;
  bonusRate?: number;
  maxRate?: number;
}

export interface CommissionInput {
  orderItemId: string;
  creatorId: string;
  brandId: string;
  sourceOutfitId: string;
  baseAmount: number;
  rule: CommissionRuleInput;
}

export interface Commission {
  id: string;
  orderItemId: string;
  creatorId: string;
  brandId: string;
  sourceOutfitId: string;
  baseAmount: number;
  commissionRate: number;
  commissionAmount: number;
  status: 'estimated' | 'pending' | 'validated' | 'paid' | 'cancelled';
}

export interface CommissionRepository {
  save(commission: Commission): Promise<Commission>;
}

@Injectable()
export class CommissionsService {
  constructor(@Inject('CommissionRepository') private readonly commissions: CommissionRepository) {}

  calculateRate(rule: CommissionRuleInput): number {
    const baseRate = this.assertRate(rule.baseRate, 'baseRate');
    const bonusRate = this.assertRate(rule.bonusRate ?? 0, 'bonusRate');
    const maxRate = rule.maxRate === undefined ? undefined : this.assertRate(rule.maxRate, 'maxRate');
    return Math.min(baseRate + bonusRate, maxRate ?? baseRate + bonusRate);
  }

  async createEstimated(input: CommissionInput): Promise<Commission> {
    if (input.baseAmount < 0) {
      throw new BadRequestException('Commission base amount cannot be negative');
    }

    const commissionRate = this.calculateRate(input.rule);
    const commission: Commission = {
      id: randomUUID(),
      orderItemId: input.orderItemId,
      creatorId: input.creatorId,
      brandId: input.brandId,
      sourceOutfitId: input.sourceOutfitId,
      baseAmount: input.baseAmount,
      commissionRate,
      commissionAmount: Math.round(input.baseAmount * commissionRate),
      status: 'estimated'
    };

    return this.commissions.save(commission);
  }

  private assertRate(rate: number, field: string): number {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new BadRequestException(`${field} must be a decimal rate between 0 and 1`);
    }
    return rate;
  }
}

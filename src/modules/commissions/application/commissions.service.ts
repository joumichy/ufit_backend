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
  status?: Commission['status'];
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

  calculateRate(rule: CommissionRuleInput): number { return calculateCommissionRate(rule); }

  async createEstimated(input: CommissionInput): Promise<Commission> {
    return this.create(input, 'estimated');
  }

  async createPending(input: CommissionInput): Promise<Commission> {
    return this.create(input, 'pending');
  }

  private async create(input: CommissionInput, defaultStatus: Commission['status']): Promise<Commission> {
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
      status: input.status ?? defaultStatus
    };

    return this.commissions.save(commission);
  }

 }

export function calculateCommissionRate(rule: CommissionRuleInput): number {
  for (const [field,rate] of Object.entries(rule)) {
    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 1)) throw new BadRequestException(`${field} must be a decimal rate between 0 and 1`);
  }
  const sum = rule.baseRate + (rule.bonusRate ?? 0);
  return Math.round(Math.min(sum, rule.maxRate ?? Math.min(sum, 1)) * 10000) / 10000;
}

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {COMMISSION_RULE, commissionRateSchema, calculateRateBps, calculateCommissionAmount, type CommissionRateInput} from '../domain/commission-rule.contract';
const COMMISSION_STATUS = {estimated: 'estimated', pending: 'pending'} as const;

export interface CommissionInput {
  orderItemId: string;
  creatorId: string;
  brandId: string;
  sourceOutfitId: string;
  baseAmount: number;
  rule: CommissionRateInput;
  status?: Commission['status'];
}

export interface Commission {
  id: string;
  orderItemId: string;
  creatorId: string;
  brandId: string;
  sourceOutfitId: string;
  baseAmount: number;
  commissionRateBps: number;
  commissionAmount: number;
  status: 'estimated' | 'pending' | 'validated' | 'paid' | 'cancelled';
}

export interface CommissionRepository {
  save(commission: Commission): Promise<Commission>;
}

@Injectable()
export class CommissionsService {
  constructor(@Inject(COMMISSION_RULE.token.commissions) private readonly commissions: CommissionRepository) {}

  calculateRateBps(input: unknown): number {
    const result = commissionRateSchema.safeParse(input);
    if (!result.success) throw new BadRequestException(COMMISSION_RULE.failure.input);
    return calculateRateBps(result.data);
  }

  async createEstimated(input: CommissionInput): Promise<Commission> {
    return this.create(input, COMMISSION_STATUS.estimated);
  }

  async createPending(input: CommissionInput): Promise<Commission> {
    return this.create(input, COMMISSION_STATUS.pending);
  }

  private async create(input: CommissionInput, defaultStatus: Commission['status']): Promise<Commission> {
    if (!Number.isSafeInteger(input.baseAmount) || input.baseAmount < COMMISSION_RULE.limits.zero) {
      throw new BadRequestException(COMMISSION_RULE.failure.amount);
    }

    const commissionRateBps = this.calculateRateBps(input.rule);
    const commission: Commission = {
      id: randomUUID(),
      orderItemId: input.orderItemId,
      creatorId: input.creatorId,
      brandId: input.brandId,
      sourceOutfitId: input.sourceOutfitId,
      baseAmount: input.baseAmount,
      commissionRateBps,
      commissionAmount: calculateCommissionAmount(input.baseAmount, commissionRateBps),
      status: input.status ?? defaultStatus
    };

    return this.commissions.save(commission);
  }

}

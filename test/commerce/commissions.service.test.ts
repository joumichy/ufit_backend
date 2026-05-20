import { describe, expect, it } from 'vitest';
import {
  CommissionsService,
  type Commission,
  type CommissionRepository
} from '../../src/modules/commissions/application/commissions.service';

class FakeCommissionRepository implements CommissionRepository {
  async save(commission: Commission): Promise<Commission> {
    return structuredClone(commission);
  }
}

describe('CommissionsService', () => {
  it('applies brand/product rate plus creator grade bonus capped by max rate', async () => {
    const service = new CommissionsService(new FakeCommissionRepository());

    const commission = await service.createEstimated({
      orderItemId: 'order-item-1',
      creatorId: 'creator-1',
      brandId: 'brand-1',
      sourceOutfitId: 'outfit-1',
      baseAmount: 20000,
      rule: {
        baseRate: 0.1,
        bonusRate: 0.05,
        maxRate: 0.12
      }
    });

    expect(commission.commissionRate).toBe(0.12);
    expect(commission.commissionAmount).toBe(2400);
    expect(commission.status).toBe('estimated');
  });
});

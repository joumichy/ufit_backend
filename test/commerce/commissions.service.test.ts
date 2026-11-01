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
        baseRateBps: 1000,
        bonusRateBps: 500,
        maxRateBps: 1200
      }
    });

    expect(commission.commissionRateBps).toBe(1200);
    expect(commission.commissionAmount).toBe(2400);
    expect(commission.status).toBe('estimated');
  });

  it('creates pending commissions for confirmed paid order items', async () => {
    const service = new CommissionsService(new FakeCommissionRepository());

    const commission = await service.createPending({
      orderItemId: 'order-item-1',
      creatorId: 'creator-1',
      brandId: 'brand-1',
      sourceOutfitId: 'outfit-1',
      baseAmount: 10000,
      rule: {
        baseRateBps: 800,
        bonusRateBps: 200, maxRateBps: null
      }
    });

    expect(commission.status).toBe('pending');
    expect(commission.commissionRateBps).toBe(1000);
    expect(commission.commissionAmount).toBe(1000);
  });
});

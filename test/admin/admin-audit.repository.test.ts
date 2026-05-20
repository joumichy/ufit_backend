import { describe, expect, it, vi } from 'vitest';
import { DrizzleAdminAuditRepository } from '../../src/modules/admin-audit/infrastructure/drizzle-admin-audit.repository';

describe('DrizzleAdminAuditRepository', () => {
  it('persists admin action logs through Drizzle', async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        adminUserId: '22222222-2222-4222-8222-222222222222',
        action: 'product.reviewed',
        targetType: 'product',
        targetId: '33333333-3333-4333-8333-333333333333',
        payload: { decision: 'active' },
        createdAt: new Date('2026-05-20T00:00:00.000Z')
      }
    ]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const repository = new DrizzleAdminAuditRepository({ db: { insert } } as never);

    const row = await repository.save({
      id: '11111111-1111-4111-8111-111111111111',
      adminUserId: '22222222-2222-4222-8222-222222222222',
      action: 'product.reviewed',
      targetType: 'product',
      targetId: '33333333-3333-4333-8333-333333333333',
      payload: { decision: 'active' },
      createdAt: '2026-05-20T00:00:00.000Z'
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'product.reviewed',
        payload: { decision: 'active' },
        createdAt: new Date('2026-05-20T00:00:00.000Z')
      })
    );
    expect(row.createdAt).toBe('2026-05-20T00:00:00.000Z');
  });
});

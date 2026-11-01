import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AdminService, type AdminRepository } from '../../src/modules/admin/application/admin.service';

describe('AdminService', () => {
  it('normalizes pagination and lists validation queues', async () => {
    const repository: AdminRepository = {
      countQueues: vi.fn(),
      countReviewQueues: vi.fn(),
      listQueue: vi.fn().mockResolvedValue({
        items: [],
        page: { limit: 50, offset: 0, total: 0, nextOffset: null }
      })
    };
    const service = new AdminService(repository);

    await service.listQueue('products', { limit: 500, offset: -10 });

    expect(repository.listQueue).toHaveBeenCalledWith('products', { limit: 50, offset: 0 });
  });

  it('rejects unknown queues', async () => {
    const service = new AdminService({
      countQueues: vi.fn(),
      countReviewQueues: vi.fn(),
      listQueue: vi.fn()
    });

    await expect(service.listQueue('cart', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

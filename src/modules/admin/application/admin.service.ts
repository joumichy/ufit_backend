import { BadRequestException, Inject, Injectable } from '@nestjs/common';

export const ADMIN_REPOSITORY = Symbol('ADMIN_REPOSITORY');

export type AdminQueueName = 'applications' | 'products' | 'outfits' | 'orders' | 'commissions';

export interface AdminPageInput {
  limit?: number;
  offset?: number;
}

export interface AdminPage<T> {
  items: T[];
  page: {
    limit: number;
    offset: number;
    total: number;
    nextOffset: number | null;
  };
}

export interface AdminQueueItem {
  id: string;
  type: string;
  status: string;
  submittedAt: string | null;
  ownerId?: string | null;
  title?: string | null;
  amount?: number | null;
  currency?: string | null;
}

export interface AdminSummary {
  queues: Record<AdminQueueName, number>;
}

export interface AdminRepository {
  countQueues(): Promise<Record<AdminQueueName, number>>;
  listQueue(queue: AdminQueueName, page: Required<AdminPageInput>): Promise<AdminPage<AdminQueueItem>>;
}

const queueNames: AdminQueueName[] = ['applications', 'products', 'outfits', 'orders', 'commissions'];

@Injectable()
export class AdminService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  async getSummary(): Promise<AdminSummary> {
    return { queues: await this.adminRepository.countQueues() };
  }

  async listQueue(queue: string, input: AdminPageInput): Promise<AdminPage<AdminQueueItem>> {
    if (!this.isQueueName(queue)) {
      throw new BadRequestException('Unknown admin queue');
    }

    return this.adminRepository.listQueue(queue, this.normalizePage(input));
  }

  private normalizePage(input: AdminPageInput): Required<AdminPageInput> {
    const rawLimit = input.limit ?? 20;
    const rawOffset = input.offset ?? 0;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 20, 1), 50);
    const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);
    return { limit, offset };
  }

  private isQueueName(queue: string): queue is AdminQueueName {
    return queueNames.includes(queue as AdminQueueName);
  }
}

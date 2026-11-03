import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {ADMIN_QUEUE, type AdminActivity} from '../domain/admin-activity.contract';

export const ADMIN_REPOSITORY = Symbol('ADMIN_REPOSITORY');

export type AdminQueueName = typeof ADMIN_QUEUE.kind[keyof typeof ADMIN_QUEUE.kind];

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
  countReviewQueues(): Promise<AdminActivity>;
  countQueues(): Promise<Record<AdminQueueName, number>>;
  listQueue(queue: AdminQueueName, page: Required<AdminPageInput>): Promise<AdminPage<AdminQueueItem>>;
}

const queueNames = Object.values(ADMIN_QUEUE.kind);

@Injectable()
export class AdminService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  getActivity(): Promise<AdminActivity> { return this.adminRepository.countReviewQueues(); }

  async getSummary(): Promise<AdminSummary> {
    return { queues: await this.adminRepository.countQueues() };
  }

  async listQueue(queue: string, input: AdminPageInput): Promise<AdminPage<AdminQueueItem>> {
    if (!this.isQueueName(queue)) {
      throw new BadRequestException(ADMIN_QUEUE.invalid);
    }

    return this.adminRepository.listQueue(queue, this.normalizePage(input));
  }

  private normalizePage(input: AdminPageInput): Required<AdminPageInput> {
    const rawLimit = input.limit ?? ADMIN_QUEUE.page.default;
    const rawOffset = input.offset ?? ADMIN_QUEUE.page.zero;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : ADMIN_QUEUE.page.default, ADMIN_QUEUE.page.minimum), ADMIN_QUEUE.page.maximum);
    const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : ADMIN_QUEUE.page.zero, ADMIN_QUEUE.page.zero);
    return { limit, offset };
  }

  private isQueueName(queue: string): queue is AdminQueueName {
    return queueNames.includes(queue as AdminQueueName);
  }
}

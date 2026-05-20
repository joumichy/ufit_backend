import { Injectable } from '@nestjs/common';
import type { Commission, CommissionRepository } from '../application/commissions.service';

@Injectable()
export class InMemoryCommissionRepository implements CommissionRepository {
  private readonly commissions = new Map<string, Commission>();

  async save(commission: Commission): Promise<Commission> {
    this.commissions.set(commission.id, structuredClone(commission));
    return structuredClone(commission);
  }
}

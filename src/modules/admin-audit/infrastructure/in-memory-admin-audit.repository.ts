import { Injectable } from '@nestjs/common';
import type { AdminActionLog, AdminAuditRepository } from '../application/admin-audit.service';

@Injectable()
export class InMemoryAdminAuditRepository implements AdminAuditRepository {
  private readonly logs: AdminActionLog[] = [];

  async save(log: AdminActionLog): Promise<AdminActionLog> {
    this.logs.push(structuredClone(log));
    return structuredClone(log);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const ADMIN_AUDIT_REPOSITORY = Symbol('ADMIN_AUDIT_REPOSITORY');

export interface AdminActionLog {
  id: string;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAuditRepository {
  save(log: AdminActionLog): Promise<AdminActionLog>;
}

@Injectable()
export class AdminAuditService {
  constructor(@Inject(ADMIN_AUDIT_REPOSITORY) private readonly auditLogs: AdminAuditRepository) {}

  async record(input: Omit<AdminActionLog, 'id' | 'createdAt'>): Promise<AdminActionLog> {
    return this.auditLogs.save({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

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
  constructor(@Inject('AdminAuditRepository') private readonly auditLogs: AdminAuditRepository) {}

  async record(input: Omit<AdminActionLog, 'id' | 'createdAt'>): Promise<AdminActionLog> {
    return this.auditLogs.save({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    });
  }
}

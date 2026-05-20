import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { adminActionLogs } from '../../../shared/infrastructure/database/schema';
import type { AdminActionLog, AdminAuditRepository } from '../application/admin-audit.service';

@Injectable()
export class DrizzleAdminAuditRepository implements AdminAuditRepository {
  constructor(private readonly database: DatabaseService) {}

  async save(log: AdminActionLog): Promise<AdminActionLog> {
    const [row] = await this.database.db
      .insert(adminActionLogs)
      .values({
        id: log.id,
        adminUserId: log.adminUserId,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        payload: log.payload,
        createdAt: new Date(log.createdAt)
      })
      .returning();

    return {
      id: row.id,
      adminUserId: row.adminUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId ?? undefined,
      payload: row.payload,
      createdAt: row.createdAt.toISOString()
    };
  }
}

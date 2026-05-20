import { Body, Controller, Headers, Post } from '@nestjs/common';
import { AdminAuditService } from '../application/admin-audit.service';

interface RecordAdminActionBody {
  action: string;
  targetType: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly adminAuditService: AdminAuditService) {}

  @Post('actions')
  record(@Headers('x-user-id') adminUserId: string, @Body() body: RecordAdminActionBody) {
    return this.adminAuditService.record({
      adminUserId,
      action: body.action,
      targetType: body.targetType,
      targetId: body.targetId,
      payload: body.payload ?? {}
    });
  }
}

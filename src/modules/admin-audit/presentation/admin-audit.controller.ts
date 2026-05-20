import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { AdminAuditService } from '../application/admin-audit.service';

interface RecordAdminActionBody {
  action: string;
  targetType: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

@Controller('admin/audit')
@UseGuards(AuthGuard, RoleGuard)
export class AdminAuditController {
  constructor(@Inject(AdminAuditService) private readonly adminAuditService: AdminAuditService) {}

  @Post('actions')
  @Roles('admin', 'super_admin')
  record(@CurrentUser() user: AuthenticatedUser, @Body() body: RecordAdminActionBody) {
    return this.adminAuditService.record({
      adminUserId: user.id,
      action: body.action,
      targetType: body.targetType,
      targetId: body.targetId,
      payload: body.payload ?? {}
    });
  }
}

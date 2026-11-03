import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { AdminService } from '../application/admin.service';
import {ADMIN_ACTIVITY} from '../domain/admin-activity.contract';

@Controller('admin')
@UseGuards(AuthGuard, RoleGuard)
@Roles(...ADMIN_ACTIVITY.roles)
export class AdminController {
  constructor(@Inject(AdminService) private readonly adminService: AdminService) {}

  @Get(ADMIN_ACTIVITY.route)
  getActivity() { return this.adminService.getActivity(); }

  @Get(ADMIN_ACTIVITY.summaries)
  getSummary() {
    return this.adminService.getSummary();
  }

  @Get(ADMIN_ACTIVITY.queues)
  listQueue(@Param(ADMIN_ACTIVITY.queueParam) queue: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.adminService.listQueue(queue, {
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset)
    });
  }
}

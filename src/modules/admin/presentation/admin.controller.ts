import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { AdminService } from '../application/admin.service';

@Controller('admin')
@UseGuards(AuthGuard, RoleGuard)
@Roles('admin', 'super_admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly adminService: AdminService) {}

  @Get('summaries')
  getSummary() {
    return this.adminService.getSummary();
  }

  @Get('validation/:queue')
  listQueue(@Param('queue') queue: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.adminService.listQueue(queue, {
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset)
    });
  }
}

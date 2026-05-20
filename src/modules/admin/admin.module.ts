import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { ADMIN_REPOSITORY, AdminService } from './application/admin.service';
import { DrizzleAdminRepository } from './infrastructure/drizzle-admin.repository';
import { AdminController } from './presentation/admin.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [AdminController],
  providers: [AdminService, { provide: ADMIN_REPOSITORY, useClass: DrizzleAdminRepository }],
  exports: [AdminService]
})
export class AdminModule {}

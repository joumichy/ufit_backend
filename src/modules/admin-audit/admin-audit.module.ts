import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { ADMIN_AUDIT_REPOSITORY, AdminAuditService } from './application/admin-audit.service';
import { DrizzleAdminAuditRepository } from './infrastructure/drizzle-admin-audit.repository';
import { AdminAuditController } from './presentation/admin-audit.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [AdminAuditController],
  providers: [
    AdminAuditService,
    { provide: ADMIN_AUDIT_REPOSITORY, useClass: DrizzleAdminAuditRepository }
  ],
  exports: [AdminAuditService]
})
export class AdminAuditModule {}

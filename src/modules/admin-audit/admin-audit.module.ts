import { Module } from '@nestjs/common';
import { AdminAuditService } from './application/admin-audit.service';
import { InMemoryAdminAuditRepository } from './infrastructure/in-memory-admin-audit.repository';
import { AdminAuditController } from './presentation/admin-audit.controller';

@Module({
  controllers: [AdminAuditController],
  providers: [
    AdminAuditService,
    { provide: 'AdminAuditRepository', useExisting: InMemoryAdminAuditRepository },
    InMemoryAdminAuditRepository
  ],
  exports: [AdminAuditService]
})
export class AdminAuditModule {}

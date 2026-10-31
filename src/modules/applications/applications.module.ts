import { DrizzleApplicationReader } from "./drizzle-application-reader";
import { ApplicationQueriesController } from "./application-queries.controller";
import { DrizzleApplicationWorkflow } from "./drizzle-application-workflow";
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { IdentityModule } from '../identity/identity.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { DrizzleApplicationsRepository } from './drizzle-applications.repository';
import { APPLICATIONS_REPOSITORY, APPLICATION_WORKFLOW } from './types/application.types';

@Module({
  imports: [DatabaseModule, IdentityModule, AdminAuditModule],
  controllers: [ApplicationsController, ApplicationQueriesController],
  providers: [
    ApplicationsService,
    DrizzleApplicationReader,
    { provide: APPLICATIONS_REPOSITORY, useClass: DrizzleApplicationsRepository },
    DrizzleApplicationWorkflow,
    {provide: APPLICATION_WORKFLOW, useExisting: DrizzleApplicationWorkflow}
  ]
})
export class ApplicationsModule {}

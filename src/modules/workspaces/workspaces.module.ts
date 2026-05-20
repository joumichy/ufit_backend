import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { WORKSPACES_REPOSITORY, WorkspacesService } from './application/workspaces.service';
import { DrizzleWorkspacesRepository } from './infrastructure/drizzle-workspaces.repository';
import { WorkspacesController } from './presentation/workspaces.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesService,
    { provide: WORKSPACES_REPOSITORY, useClass: DrizzleWorkspacesRepository }
  ],
  exports: [WorkspacesService]
})
export class WorkspacesModule {}

import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { EditorialService } from './application/editorial.service';
import { EDITORIAL_REPOSITORY } from './domain/editorial.types';
import { DrizzleEditorialRepository } from './infrastructure/drizzle-editorial.repository';
import { EditorialController } from './presentation/editorial.controller';

@Module({
  imports: [IdentityModule, DatabaseModule],
  controllers: [EditorialController],
  providers: [
    EditorialService,
    {
      provide: EDITORIAL_REPOSITORY,
      useClass: DrizzleEditorialRepository
    }
  ],
  exports: [EditorialService, EDITORIAL_REPOSITORY]
})
export class EditorialModule {}

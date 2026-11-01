import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { CreatorsController } from './creators.controller';
import {PublicCreatorsController} from './public-creators.controller';
import { CreatorsService } from './creators.service';
import { CREATORS_REPOSITORY, CREATORS_SERVICE } from './creators.tokens';
import { DrizzleCreatorsRepository } from './drizzle-creators.repository';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CreatorsController, PublicCreatorsController],
  providers: [
    CreatorsService,
    { provide: CREATORS_REPOSITORY, useClass: DrizzleCreatorsRepository },
    { provide: CREATORS_SERVICE, useExisting: CreatorsService }
  ],
  exports: [CREATORS_SERVICE]
})
export class CreatorsModule {}

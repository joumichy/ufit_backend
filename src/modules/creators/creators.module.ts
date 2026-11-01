import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { CreatorsController } from './creators.controller';
import {PublicCreatorsController} from './public-creators.controller';
import { CreatorsService } from './creators.service';
import { CREATORS_REPOSITORY, CREATORS_SERVICE } from './creators.tokens';
import { DrizzleCreatorsRepository } from './drizzle-creators.repository';

import {CreatorGradesService} from './grades/creator-grades.service';
import {CreatorGradeDefinitionsController, CreatorGradeAssignmentsController} from './grades/creator-grades.controller';
import {DrizzleCreatorGradesRepository} from './grades/drizzle-creator-grades.repository';
import {CREATOR_GRADE} from './grades/creator-grade.contract';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CreatorsController, PublicCreatorsController, CreatorGradeDefinitionsController, CreatorGradeAssignmentsController],
  providers: [
    CreatorsService, CreatorGradesService,
    {provide: CREATOR_GRADE.token.repository, useClass: DrizzleCreatorGradesRepository},
    { provide: CREATORS_REPOSITORY, useClass: DrizzleCreatorsRepository },
    { provide: CREATORS_SERVICE, useExisting: CreatorsService }
  ],
  exports: [CREATORS_SERVICE]
})
export class CreatorsModule {}

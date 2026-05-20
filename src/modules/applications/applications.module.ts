import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { BrandsModule } from '../brands/brands.module';
import { BrandsService } from '../brands/brands.service';
import { BRANDS_SERVICE } from '../brands/brands.tokens';
import { CreatorsModule } from '../creators/creators.module';
import { CreatorsService } from '../creators/creators.service';
import { CREATORS_SERVICE } from '../creators/creators.tokens';
import { IdentityModule } from '../identity/identity.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { DrizzleApplicationsRepository } from './drizzle-applications.repository';
import { APPLICATIONS_REPOSITORY, PROFILE_PROVISIONING_PORT } from './types/application.types';

@Module({
  imports: [DatabaseModule, IdentityModule, CreatorsModule, BrandsModule, AdminAuditModule],
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    { provide: APPLICATIONS_REPOSITORY, useClass: DrizzleApplicationsRepository },
    {
      provide: PROFILE_PROVISIONING_PORT,
      useFactory: (creatorsService: CreatorsService, brandsService: BrandsService) => ({
        provisionCreatorFromApplication: creatorsService.provisionFromApplication.bind(creatorsService),
        provisionBrandFromApplication: brandsService.provisionFromApplication.bind(brandsService)
      }),
      inject: [CREATORS_SERVICE, BRANDS_SERVICE]
    }
  ]
})
export class ApplicationsModule {}

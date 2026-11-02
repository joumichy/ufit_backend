import {PROFILE_IMAGE} from '../media/domain/profile-image.contract';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityService } from './application/identity.service';
import { IDENTITY_REPOSITORY } from './domain/identity.repository';
import { AUTH_TOKEN_VERIFIER, SupabaseJwtVerifier } from './infrastructure/auth/auth-token-verifier';
import { DrizzleIdentityRepository } from './infrastructure/persistence/drizzle-identity.repository';
import { MeController } from './presentation/controllers/me.controller';
import { AdminGuard } from '../../shared/presentation/guards/admin.guard';
import { AuthGuard } from '../../shared/presentation/guards/auth.guard';
import { OwnershipGuard } from '../../shared/presentation/guards/ownership.guard';
import { RoleGuard } from '../../shared/presentation/guards/role.guard';

import {UserAdministrationController} from './presentation/controllers/user-administration.controller';
import {UserAdministrationService} from './application/user-administration.service';
import {DrizzleUserAdministrationRepository} from './infrastructure/persistence/drizzle-user-administration.repository';
import {USER_ADMINISTRATION} from './domain/user-administration.contract';
import {ACCOUNT_DELETION} from './domain/account-deletion.contract';
import {AccountDeletionService} from './application/account-deletion.service';
import {AccountDeletionProcessor} from './application/account-deletion-processor';
import {AccountDeletionsController} from './presentation/controllers/account-deletions.controller';
import {DrizzleAccountDeletionRepository} from './infrastructure/persistence/drizzle-account-deletion.repository';
import {DrizzleAccountDeletionQueue} from './infrastructure/persistence/drizzle-account-deletion-queue';
import {SupabaseAccountDeletion} from './infrastructure/auth/supabase-account-deletion';
import {AccountDeletionsWorker} from './infrastructure/account-deletions.worker';
import {SupabaseImageStorage} from '../media/infrastructure/supabase-image.storage';
import {PRODUCT_MEDIA} from '../media/domain/product-media.contract';
import {OUTFIT_MEDIA} from '../media/domain/outfit-media.contract';

@Module({
  imports: [DatabaseModule],
  controllers: [MeController, UserAdministrationController,AccountDeletionsController],
  providers: [
    IdentityService, UserAdministrationService,
    AccountDeletionService,DrizzleAccountDeletionRepository,DrizzleAccountDeletionQueue,AccountDeletionsWorker,
    {provide:SupabaseAccountDeletion,useFactory:()=>new SupabaseAccountDeletion()},
    {provide:ACCOUNT_DELETION.token.processor,inject:[DrizzleAccountDeletionQueue,SupabaseAccountDeletion],
      useFactory:(queue:DrizzleAccountDeletionQueue,authority:SupabaseAccountDeletion)=>new AccountDeletionProcessor(queue,
        {[ACCOUNT_DELETION.media.product]:new SupabaseImageStorage(PRODUCT_MEDIA),[ACCOUNT_DELETION.media.outfit]:new SupabaseImageStorage(OUTFIT_MEDIA),[ACCOUNT_DELETION.media.profile]:new SupabaseImageStorage(PROFILE_IMAGE)},authority)},
    {provide: USER_ADMINISTRATION.token.repository, useClass: DrizzleUserAdministrationRepository},
    AuthGuard,
    RoleGuard,
    AdminGuard,
    OwnershipGuard,
    {
      provide: IDENTITY_REPOSITORY,
      useClass: DrizzleIdentityRepository
    },
    {
      provide: AUTH_TOKEN_VERIFIER,
      useClass: SupabaseJwtVerifier
    }
  ],
  exports: [IDENTITY_REPOSITORY, IdentityService, AuthGuard, RoleGuard, AdminGuard, OwnershipGuard, AUTH_TOKEN_VERIFIER]
})
export class IdentityModule {}

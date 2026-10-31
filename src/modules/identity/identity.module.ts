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

@Module({
  imports: [DatabaseModule],
  controllers: [MeController],
  providers: [
    IdentityService,
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

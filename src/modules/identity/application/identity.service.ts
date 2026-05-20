import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { IDENTITY_REPOSITORY, type IdentityRepository } from '../domain/identity.repository';
import type { AuthenticatedUser, SupabaseJwtClaims, UserProfilePatch, UserRole } from '../domain/user.types';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IDENTITY_REPOSITORY)
    private readonly repository: IdentityRepository
  ) {}

  async resolveCurrentUser(claims: SupabaseJwtClaims): Promise<AuthenticatedUser> {
    const existingUser = await this.repository.findBySupabaseUserId(claims.sub);

    if (existingUser) {
      if (existingUser.status === 'deleted' || existingUser.status === 'suspended') {
        throw new UnauthorizedException('User account is not active');
      }

      return existingUser;
    }

    return this.repository.createFromSupabaseClaims(claims);
  }

  async updateProfile(userId: string, patch: UserProfilePatch): Promise<AuthenticatedUser> {
    return this.repository.updateProfile(userId, patch);
  }

  async hasAnyRole(userId: string, roles: UserRole[]): Promise<boolean> {
    if (roles.length === 0) {
      return true;
    }

    return this.repository.hasAnyRole(userId, roles);
  }
}

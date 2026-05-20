import type { AuthenticatedUser, SupabaseJwtClaims, UserProfilePatch, UserRole } from './user.types';

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

export interface IdentityRepository {
  findById(userId: string): Promise<AuthenticatedUser | null>;
  findBySupabaseUserId(supabaseUserId: string): Promise<AuthenticatedUser | null>;
  createFromSupabaseClaims(claims: SupabaseJwtClaims): Promise<AuthenticatedUser>;
  updateProfile(userId: string, patch: UserProfilePatch): Promise<AuthenticatedUser>;
  hasAnyRole(userId: string, roles: UserRole[]): Promise<boolean>;
}

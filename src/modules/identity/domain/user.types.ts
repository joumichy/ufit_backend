export const USER_ROLES = ['customer', 'creator', 'brand_owner', 'brand_manager', 'admin', 'super_admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'onboarding', 'suspended', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  roles: UserRole[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SupabaseJwtClaims {
  sub: string;
  email?: string;
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
  };
}

export interface UserProfilePatch {
  displayName?: string | null;
  avatarUrl?: string | null;
}

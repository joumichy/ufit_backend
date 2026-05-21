import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infrastructure/database/database.service';
import { userRoles, users, type UserRoleRow, type UserRow } from '../../../../shared/infrastructure/database/schema';
import type { IdentityRepository } from '../../domain/identity.repository';
import type { AuthenticatedUser, SupabaseJwtClaims, UserProfilePatch, UserRole } from '../../domain/user.types';

@Injectable()
export class DrizzleIdentityRepository implements IdentityRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findById(userId: string): Promise<AuthenticatedUser | null> {
    const rows = await this.database.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];

    if (!user) {
      return null;
    }

    const roles = await this.findRoles(user.id);
    return this.toAuthenticatedUser(user, roles);
  }

  async findBySupabaseUserId(supabaseUserId: string): Promise<AuthenticatedUser | null> {
    const rows = await this.database.db.select().from(users).where(eq(users.supabaseUserId, supabaseUserId)).limit(1);
    const user = rows[0];

    if (!user) {
      return null;
    }

    const roles = await this.findRoles(user.id);
    return this.toAuthenticatedUser(user, roles);
  }

  async createFromSupabaseClaims(claims: SupabaseJwtClaims): Promise<AuthenticatedUser> {
    const email = claims.email?.trim().toLowerCase();

    if (!email) {
      throw new NotFoundException('Authenticated Supabase user has no email');
    }

    const name = claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? null;
    const avatarUrl = claims.user_metadata?.avatar_url ?? null;

    const inserted = await this.database.db
      .insert(users)
      .values({
        supabaseUserId: claims.sub,
        email,
        displayName: name,
        avatarUrl,
        status: 'active'
      })
      .onConflictDoNothing({ target: users.supabaseUserId })
      .returning();

    const user = inserted[0] ?? (await this.findUserBySupabaseIdOrThrow(claims.sub));

    await this.database.db
      .insert(userRoles)
      .values({
        userId: user.id,
        role: 'customer'
      })
      .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] });

    return this.toAuthenticatedUser(user, await this.findRoles(user.id));
  }

  async updateProfile(userId: string, patch: UserProfilePatch): Promise<AuthenticatedUser> {
    const rows = await this.database.db
      .update(users)
      .set({
        displayName: patch.displayName,
        avatarUrl: patch.avatarUrl,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();

    const user = rows[0];
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toAuthenticatedUser(user, await this.findRoles(user.id));
  }

  async hasAnyRole(userId: string, roles: UserRole[]): Promise<boolean> {
    if (roles.length === 0) {
      return true;
    }

    const rows = await this.database.db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), inArray(userRoles.role, roles)))
      .limit(1);

    return rows.length > 0;
  }

  private async findRoles(userId: string): Promise<UserRole[]> {
    const rows = await this.database.db.select().from(userRoles).where(eq(userRoles.userId, userId));
    return rows.map((row) => row.role);
  }

  private async findUserBySupabaseIdOrThrow(supabaseUserId: string): Promise<UserRow> {
    const rows = await this.database.db.select().from(users).where(eq(users.supabaseUserId, supabaseUserId)).limit(1);
    const user = rows[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private toAuthenticatedUser(user: UserRow, roles: UserRoleRow['role'][]): AuthenticatedUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      status: user.status,
      roles,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }
}

import {and, eq, inArray} from 'drizzle-orm';
import {PROFILE_EDITING, PROFILE_KIND, type ProfileOwner, type ProfileOwnerInfo} from '../../domain/profile-editing.contract';
import {PUBLIC_PROFILE} from '../../domain/public-profile.contract';
import type {DatabaseSession} from './database-session';
import {creatorProfiles, brandProfiles, brandMembers, users} from './schema';

export enum ProfileAccessMode {Read, Lock}
export async function findAuthoringProfile(database: DatabaseSession, owner: ProfileOwner, userId: string, mode: ProfileAccessMode): Promise<ProfileOwnerInfo | undefined> {
  if (owner.creatorId !== null && owner.brandId === null) {
    const query = database.db.select({id: creatorProfiles.id, name: creatorProfiles.displayName, status: creatorProfiles.status})
      .from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
      .where(and(eq(creatorProfiles.id, owner.creatorId), eq(creatorProfiles.userId, userId),
        inArray(creatorProfiles.status, PROFILE_EDITING.writableStatuses), eq(users.status, PUBLIC_PROFILE.userStatus)));
    const [row] = mode === ProfileAccessMode.Lock ? await query.for(PROFILE_EDITING.persistence.lock) : await query;
    return row ? {...row, kind: PROFILE_KIND.creator} : undefined;
  }
  if (owner.brandId !== null && owner.creatorId === null) {
    const query = database.db.select({id: brandProfiles.id, name: brandProfiles.brandName, status: brandProfiles.status})
      .from(brandProfiles).innerJoin(brandMembers, and(eq(brandMembers.brandProfileId, brandProfiles.id), eq(brandMembers.userId, userId), eq(brandMembers.status, PROFILE_EDITING.persistence.memberActive)))
      .innerJoin(users, eq(users.id, brandMembers.userId))
      .where(and(eq(brandProfiles.id, owner.brandId), inArray(brandProfiles.status, PROFILE_EDITING.writableStatuses), eq(users.status, PUBLIC_PROFILE.userStatus)));
    const [row] = mode === ProfileAccessMode.Lock ? await query.for(PROFILE_EDITING.persistence.lock) : await query;
    return row ? {...row, kind: PROFILE_KIND.brand} : undefined;
  }
  return undefined;
}

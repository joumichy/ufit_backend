import type { DatabaseSession } from "../../shared/infrastructure/database/database-session";
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, notInArray } from 'drizzle-orm';
import { PROFILE_EDITING, PROFILE_STATUS } from '../../shared/domain/profile-editing.contract';
import type { CreatorSocialAccountInput } from './creator-social.contract';
import type { CreatorProfileDetails } from './creators.repository';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import {
  creatorGradeHistory,
  creatorProfiles,
  creatorSocialAccounts,
  type CreatorProfileRow,
  type NewCreatorProfileRow
} from '../../shared/infrastructure/database/schema';
import type { CreatorsRepository } from './creators.repository';

@Injectable()
export class DrizzleCreatorsRepository implements CreatorsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  async findDetailsByUserId(userId: string): Promise<CreatorProfileDetails | undefined> {
    const rows = await this.database.db.select({profile: creatorProfiles,
      social: {platform: creatorSocialAccounts.platform, handle: creatorSocialAccounts.handle, url: creatorSocialAccounts.url}})
      .from(creatorProfiles).leftJoin(creatorSocialAccounts, eq(creatorSocialAccounts.creatorProfileId, creatorProfiles.id))
      .where(eq(creatorProfiles.userId, userId)).orderBy(creatorSocialAccounts.platform);
    const first = rows.at(PROFILE_EDITING.limits.firstRow);
    return first ? {profile: first.profile, socialAccounts: rows.flatMap(row => row.social ? [row.social] : [])} : undefined;
  }
  async findProfileByUserId(userId: string): Promise<CreatorProfileRow | undefined> {
    return this.database.db.query.creatorProfiles.findFirst({
      where: eq(creatorProfiles.userId, userId)
    });
  }

  async findProfileByApplicationId(applicationId: string): Promise<CreatorProfileRow | undefined> {
    return this.database.db.query.creatorProfiles.findFirst({
      where: eq(creatorProfiles.applicationId, applicationId)
    });
  }

  async createProfile(input: NewCreatorProfileRow): Promise<CreatorProfileRow> {
    const [row] = await this.database.db.insert(creatorProfiles).values(input).returning();
    return row;
  }

  async updateProfile(
    profileId: string,
    input: Partial<Pick<CreatorProfileRow, 'displayName' | 'bio' | 'avatarUrl' | 'status'>> & {socialAccounts?: CreatorSocialAccountInput[]},
    userId: string
  ): Promise<CreatorProfileRow | undefined> {
    return this.database.db.transaction(async tx => {
      const [locked] = await tx.select({id: creatorProfiles.id}).from(creatorProfiles)
        .where(and(eq(creatorProfiles.id, profileId), eq(creatorProfiles.userId, userId), ne(creatorProfiles.status, PROFILE_STATUS.suspended)))
        .for(PROFILE_EDITING.persistence.lock);
      if (!locked) return undefined;
      const {socialAccounts, ...fields} = input;
      const [row] = await tx.update(creatorProfiles).set({...fields, updatedAt: new Date()})
        .where(eq(creatorProfiles.id, locked.id)).returning();
      if (socialAccounts !== undefined) {
        const platforms = socialAccounts.map(account => account.platform);
        await tx.delete(creatorSocialAccounts).where(and(eq(creatorSocialAccounts.creatorProfileId, locked.id),
          platforms.length ? notInArray(creatorSocialAccounts.platform, platforms) : undefined));
        for (const account of socialAccounts) {
          const values = {handle: account.handle, url: account.url ?? null};
          await tx.insert(creatorSocialAccounts).values({...values, creatorProfileId: locked.id, platform: account.platform})
            .onConflictDoUpdate({target: [creatorSocialAccounts.creatorProfileId, creatorSocialAccounts.platform], set: values});
        }
      }
      return row;
    });
  }

  async addInitialGradeHistory(profileId: string): Promise<void> {
    await this.database.db
      .insert(creatorGradeHistory)
      .values({ creatorProfileId: profileId, toGradeCode: 'seed', reason: 'application_accepted' });
  }
}

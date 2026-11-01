import { READ_SNAPSHOT, type DatabaseSession } from "../../shared/infrastructure/database/database-session";
import {CREATOR_GRADE} from './grades/creator-grade.contract';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { and, eq, ne, notInArray, inArray, isNull, sql } from 'drizzle-orm';
import {PUBLIC_PROFILE} from '../../shared/domain/public-profile.contract';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES} from '../outfits/domain/public-outfit.contract';
import type {PublicCreatorProfile} from './public-creator.contract';
import { PROFILE_EDITING, PROFILE_STATUS } from '../../shared/domain/profile-editing.contract';
import type { CreatorSocialAccountInput } from './creator-social.contract';
import type { CreatorProfileDetails } from './creators.repository';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import {
  creatorGradeHistory,
  creatorGrades,
  creatorProfiles,
  creatorSocialAccounts,
  creatorFollows,
  outfits,
  users,
  type CreatorProfileRow,
  type NewCreatorProfileRow
} from '../../shared/infrastructure/database/schema';
import type { CreatorsRepository } from './creators.repository';

@Injectable()
export class DrizzleCreatorsRepository implements CreatorsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  async findPublicProfileById(id: string): Promise<PublicCreatorProfile | undefined> {
    return this.database.db.transaction(async tx => {
      const [profile] = await tx.select({id: creatorProfiles.id, displayName: creatorProfiles.displayName, slug: creatorProfiles.slug,
        bio: creatorProfiles.bio, avatarUrl: creatorProfiles.avatarUrl, grade: {code: creatorGrades.code, label: creatorGrades.label},
        stats: {
          followers: sql<number>`(select count(*)::integer from ${creatorFollows} where ${eq(creatorFollows.creatorId, creatorProfiles.id)})`,
          publishedOutfits: sql<number>`(select count(*)::integer from ${outfits} where ${and(eq(outfits.creatorId, creatorProfiles.id), isNull(outfits.brandId),
            eq(outfits.status, PUBLIC_OUTFIT.status), inArray(outfits.visibility, PUBLIC_OUTFIT_VISIBILITIES))})`,
        }})
        .from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId)).innerJoin(creatorGrades, eq(creatorGrades.code, creatorProfiles.gradeCode))
        .where(and(eq(creatorProfiles.id, id), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus)));
      if (!profile) return undefined;
      const socialAccounts = await tx.select({platform: creatorSocialAccounts.platform, handle: creatorSocialAccounts.handle, url: creatorSocialAccounts.url})
        .from(creatorSocialAccounts).where(eq(creatorSocialAccounts.creatorProfileId, id)).orderBy(creatorSocialAccounts.platform);
      return {...profile, socialAccounts};
    }, READ_SNAPSHOT);
  }

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
    const [current] = await this.database.db.select({profile: creatorProfiles, label: creatorGrades.label})
      .from(creatorProfiles).innerJoin(creatorGrades, eq(creatorGrades.code, creatorProfiles.gradeCode))
      .where(eq(creatorProfiles.id, profileId));
    if (!current || current.profile.gradeVersion !== CREATOR_GRADE.limits.initialVersion ||
        current.profile.gradeCode !== CREATOR_GRADE.initialCode) throw new InternalServerErrorException(CREATOR_GRADE.failure.persisted);
    await this.database.db.insert(creatorGradeHistory).values({creatorProfileId: profileId,
      toGradeCode: current.profile.gradeCode, toGradeLabel: current.label,
      version: current.profile.gradeVersion, source: CREATOR_GRADE.changeSource.application,
      reason: CREATOR_GRADE.initialReason});
  }
}

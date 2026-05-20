import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import {
  creatorGradeHistory,
  creatorProfiles,
  type CreatorProfileRow,
  type NewCreatorProfileRow
} from '../../shared/infrastructure/database/schema';
import type { CreatorsRepository } from './creators.repository';

@Injectable()
export class DrizzleCreatorsRepository implements CreatorsRepository {
  constructor(private readonly database: DatabaseService) {}

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
    input: Partial<Pick<CreatorProfileRow, 'displayName' | 'bio' | 'avatarUrl' | 'status'>>
  ): Promise<CreatorProfileRow> {
    const [row] = await this.database.db
      .update(creatorProfiles)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(creatorProfiles.id, profileId))
      .returning();
    return row;
  }

  async addInitialGradeHistory(profileId: string): Promise<void> {
    await this.database.db
      .insert(creatorGradeHistory)
      .values({ creatorProfileId: profileId, toGradeCode: 'seed', reason: 'application_accepted' });
  }
}

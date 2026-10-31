import { PROFILE_EDITING, PROFILE_STATUS } from '../../shared/domain/profile-editing.contract';
import type { DatabaseSession } from "../../shared/infrastructure/database/database-session";
import { COMMERCE_POLICY_KEY, type BrandCommercePolicy } from './commerce-policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import {
  brandMembers,
  brandProfiles,
  brandSettings,
  type BrandMemberRow,
  type BrandProfileRow,
  type NewBrandMemberRow,
  type NewBrandProfileRow
} from '../../shared/infrastructure/database/schema';
import type { BrandsRepository } from './brands.repository';

@Injectable()
export class DrizzleBrandsRepository implements BrandsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  async findSettings(brandProfileId: string) {
    return this.database.db.query.brandSettings.findFirst({where: eq(brandSettings.brandProfileId,brandProfileId)});
  }
  async saveCommercePolicy(brandProfileId: string, policy: BrandCommercePolicy): Promise<void> {
    const patch = {[COMMERCE_POLICY_KEY]:policy};
    await this.database.db.insert(brandSettings).values({brandProfileId,metadata:patch}).onConflictDoUpdate({
      target:brandSettings.brandProfileId,set:{metadata:sql`${brandSettings.metadata} || ${JSON.stringify(patch)}::jsonb`,updatedAt:new Date()}
    });
  }

  async findProfileByApplicationId(applicationId: string): Promise<BrandProfileRow | undefined> {
    return this.database.db.query.brandProfiles.findFirst({
      where: eq(brandProfiles.applicationId, applicationId)
    });
  }

  async findProfileById(brandProfileId: string): Promise<BrandProfileRow | undefined> {
    return this.database.db.query.brandProfiles.findFirst({
      where: eq(brandProfiles.id, brandProfileId)
    });
  }

  async createProfile(input: NewBrandProfileRow): Promise<BrandProfileRow> {
    const [row] = await this.database.db.insert(brandProfiles).values(input).returning();
    return row;
  }

  async createOwnerMember(input: NewBrandMemberRow): Promise<BrandMemberRow> {
    const [row] = await this.database.db.insert(brandMembers).values(input).returning();
    return row;
  }

  async createDefaultSettings(brandProfileId: string): Promise<void> {
    await this.database.db.insert(brandSettings).values({ brandProfileId }).onConflictDoNothing();
  }

  async findActiveMember(brandProfileId: string, userId: string): Promise<BrandMemberRow | undefined> {
    return this.database.db.query.brandMembers.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.brandProfileId, brandProfileId), eq(table.userId, userId), eq(table.status, PROFILE_EDITING.persistence.memberActive))
    });
  }

  async updateProfile(
    brandProfileId: string,
    input: Partial<Pick<BrandProfileRow, 'brandName' | 'bio' | 'websiteUrl' | 'status'>>,
    userId: string
  ): Promise<BrandProfileRow | undefined> {
    const [row] = await this.database.db
      .update(brandProfiles)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(brandProfiles.id, brandProfileId), ne(brandProfiles.status, PROFILE_STATUS.suspended),
        sql`exists (select ${PROFILE_EDITING.persistence.existsProjection} from ${brandMembers} where ${brandMembers.brandProfileId} = ${brandProfiles.id}
          and ${brandMembers.userId} = ${userId} and ${brandMembers.status} = ${PROFILE_EDITING.persistence.memberActive})`))
      .returning();
    return row;
  }
}

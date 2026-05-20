import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
  constructor(private readonly database: DatabaseService) {}

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
        and(eq(table.brandProfileId, brandProfileId), eq(table.userId, userId), eq(table.status, 'active'))
    });
  }

  async updateProfile(
    brandProfileId: string,
    input: Partial<Pick<BrandProfileRow, 'brandName' | 'bio' | 'websiteUrl' | 'status'>>
  ): Promise<BrandProfileRow> {
    const [row] = await this.database.db
      .update(brandProfiles)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(brandProfiles.id, brandProfileId))
      .returning();
    return row;
  }
}

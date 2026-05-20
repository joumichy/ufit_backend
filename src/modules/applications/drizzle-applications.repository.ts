import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  applicationReviews,
  brandApplications,
  creatorApplications,
  type ApplicationReviewRow,
  type BrandApplicationRow,
  type CreatorApplicationRow
} from '../../shared/infrastructure/database/schema';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import type {
  ApplicationStatus,
  ApplicationsRepository,
  ReviewApplicationInput,
  SubmitBrandApplicationInput,
  SubmitCreatorApplicationInput
} from './types/application.types';

const activeStatuses = ['submitted', 'under_review', 'waitlisted', 'needs_more_info'] as const;

@Injectable()
export class DrizzleApplicationsRepository implements ApplicationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findActiveCreatorApplication(userId: string): Promise<CreatorApplicationRow | undefined> {
    return this.database.db.query.creatorApplications.findFirst({
      where: (table, { and, eq, inArray }) => and(eq(table.userId, userId), inArray(table.status, activeStatuses))
    });
  }

  async findActiveBrandApplication(userId: string): Promise<BrandApplicationRow | undefined> {
    return this.database.db.query.brandApplications.findFirst({
      where: (table, { and, eq, inArray }) => and(eq(table.userId, userId), inArray(table.status, activeStatuses))
    });
  }

  async createCreatorApplication(input: SubmitCreatorApplicationInput): Promise<CreatorApplicationRow> {
    const [row] = await this.database.db.insert(creatorApplications).values(input).returning();
    return row;
  }

  async createBrandApplication(input: SubmitBrandApplicationInput): Promise<BrandApplicationRow> {
    const [row] = await this.database.db.insert(brandApplications).values(input).returning();
    return row;
  }

  async findCreatorApplication(applicationId: string): Promise<CreatorApplicationRow | undefined> {
    return this.database.db.query.creatorApplications.findFirst({
      where: eq(creatorApplications.id, applicationId)
    });
  }

  async findBrandApplication(applicationId: string): Promise<BrandApplicationRow | undefined> {
    return this.database.db.query.brandApplications.findFirst({
      where: eq(brandApplications.id, applicationId)
    });
  }

  async updateCreatorApplicationStatus(applicationId: string, status: ApplicationStatus): Promise<CreatorApplicationRow> {
    const [row] = await this.database.db
      .update(creatorApplications)
      .set({ status, updatedAt: new Date() })
      .where(eq(creatorApplications.id, applicationId))
      .returning();
    return row;
  }

  async updateBrandApplicationStatus(applicationId: string, status: ApplicationStatus): Promise<BrandApplicationRow> {
    const [row] = await this.database.db
      .update(brandApplications)
      .set({ status, updatedAt: new Date() })
      .where(eq(brandApplications.id, applicationId))
      .returning();
    return row;
  }

  async createReview(input: ReviewApplicationInput): Promise<ApplicationReviewRow> {
    const [row] = await this.database.db
      .insert(applicationReviews)
      .values({
        applicationType: input.applicationType,
        applicationId: input.applicationId,
        reviewerUserId: input.reviewerUserId,
        decision: input.decision,
        notes: input.notes
      })
      .returning();
    return row;
  }
}

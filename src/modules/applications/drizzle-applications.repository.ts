import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { applicationReviews, brandApplications, creatorApplications, creatorProfiles, users } from "../../shared/infrastructure/database/schema";
import { DatabaseService } from "../../shared/infrastructure/database/database.service";
import type { DatabaseSession } from "../../shared/infrastructure/database/database-session";
import { APPLICATION, APPLICATION_ACTIVE_STATUSES } from "./types/application-contract";
import type { ApplicationStatus, ApplicationType, ApplicationsRepository, ReviewApplicationInput, SubmitBrandApplicationInput, SubmitCreatorApplicationInput } from "./types/application.types";

@Injectable()
export class DrizzleApplicationsRepository implements ApplicationsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  async lockApplicant(userId: string, kind: ApplicationType): Promise<string | undefined> {
    const key = APPLICATION.persistence.applicantLock + kind + APPLICATION.persistence.separator + userId;
    await this.database.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, ${APPLICATION.persistence.lockSeed}))`);
    const [user] = await this.database.db.select({status: users.status}).from(users)
      .where(eq(users.id, userId)).limit(APPLICATION.limits.row).for(APPLICATION.persistence.rowLock);
    return user?.status;
  }
  async hasCreatorProfile(userId: string): Promise<boolean> {
    const rows = await this.database.db.select({id: creatorProfiles.id}).from(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId)).limit(APPLICATION.limits.row);
    return rows.length > APPLICATION.limits.zero;
  }
  async findActiveCreatorApplication(userId: string) {
    const [row] = await this.database.db.select().from(creatorApplications)
      .where(and(eq(creatorApplications.userId, userId), inArray(creatorApplications.status, [...APPLICATION_ACTIVE_STATUSES, APPLICATION.status.accepted])))
      .limit(APPLICATION.limits.row);
    return row;
  }
  async findActiveBrandApplication(userId: string) {
    const [row] = await this.database.db.select().from(brandApplications)
      .where(and(eq(brandApplications.userId, userId), inArray(brandApplications.status, APPLICATION_ACTIVE_STATUSES)))
      .limit(APPLICATION.limits.row);
    return row;
  }
  async createCreatorApplication(input: SubmitCreatorApplicationInput) {
    const [row] = await this.database.db.insert(creatorApplications).values(input).returning(); return row;
  }
  async createBrandApplication(input: SubmitBrandApplicationInput) {
    const [row] = await this.database.db.insert(brandApplications).values(input).returning(); return row;
  }
  async findCreatorApplication(id: string) {
    const [row] = await this.database.db.select().from(creatorApplications).where(eq(creatorApplications.id, id)).limit(APPLICATION.limits.row); return row;
  }
  async findBrandApplication(id: string) {
    const [row] = await this.database.db.select().from(brandApplications).where(eq(brandApplications.id, id)).limit(APPLICATION.limits.row); return row;
  }
  async lockCreatorApplication(id: string) {
    const [row] = await this.database.db.select().from(creatorApplications).where(eq(creatorApplications.id, id))
      .limit(APPLICATION.limits.row).for(APPLICATION.persistence.rowLock); return row;
  }
  async lockBrandApplication(id: string) {
    const [row] = await this.database.db.select().from(brandApplications).where(eq(brandApplications.id, id))
      .limit(APPLICATION.limits.row).for(APPLICATION.persistence.rowLock); return row;
  }
  async updateCreatorApplicationStatus(id: string, status: ApplicationStatus) {
    const [row] = await this.database.db.update(creatorApplications)
      .set({status, version: sql`${creatorApplications.version} + ${APPLICATION.limits.versionStep}`, updatedAt: new Date()})
      .where(eq(creatorApplications.id, id)).returning(); return row;
  }
  async updateBrandApplicationStatus(id: string, status: ApplicationStatus) {
    const [row] = await this.database.db.update(brandApplications)
      .set({status, version: sql`${brandApplications.version} + ${APPLICATION.limits.versionStep}`, updatedAt: new Date()})
      .where(eq(brandApplications.id, id)).returning(); return row;
  }
  async updateCreatorApplication(id: string, input: SubmitCreatorApplicationInput) {
    const [row] = await this.database.db.update(creatorApplications)
      .set({...input, portfolioUrl: input.portfolioUrl ?? null, audienceSummary: input.audienceSummary ?? null,
        status: APPLICATION.status.submitted, version: sql`${creatorApplications.version} + ${APPLICATION.limits.versionStep}`, updatedAt: new Date()})
      .where(eq(creatorApplications.id, id)).returning(); return row;
  }
  async updateBrandApplication(id: string, input: SubmitBrandApplicationInput) {
    const [row] = await this.database.db.update(brandApplications)
      .set({...input, status: APPLICATION.status.submitted, version: sql`${brandApplications.version} + ${APPLICATION.limits.versionStep}`, updatedAt: new Date()})
      .where(eq(brandApplications.id, id)).returning(); return row;
  }
  async createReview(input: ReviewApplicationInput) {
    const [row] = await this.database.db.insert(applicationReviews).values({applicationType: input.applicationType,
      applicationId: input.applicationId, reviewerUserId: input.reviewerUserId, decision: input.decision, notes: input.notes}).returning(); return row;
  }
}

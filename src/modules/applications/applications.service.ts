import {applicationNotification} from "./application-notifications";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { BrandApplicationRow, CreatorApplicationRow } from "../../shared/infrastructure/database/schema";
import { APPLICATION, APPLICATION_ACTIVE_STATUSES, APPLICATION_CORRECTABLE_STATUSES } from "./types/application-contract";
import { APPLICATIONS_REPOSITORY, APPLICATION_WORKFLOW, type ApplicationsRepository, type ApplicationWorkflow, type ReviewApplicationInput, type SubmitBrandApplicationInput, type SubmitCreatorApplicationInput } from "./types/application.types";
const decisionToStatus = {
  [APPLICATION.decision.accept]: APPLICATION.status.accepted,
  [APPLICATION.decision.reject]: APPLICATION.status.rejected,
  [APPLICATION.decision.waitlist]: APPLICATION.status.waitlisted,
  [APPLICATION.decision.needsMoreInfo]: APPLICATION.status.needsMoreInfo,
} as const;
function assertApplicant(status: string | undefined): void {
  if (status !== APPLICATION.applicantStatus.active && status !== APPLICATION.applicantStatus.onboarding)
    throw new ConflictException(APPLICATION.failure.applicant);
}
function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new ConflictException(APPLICATION.failure.changed);
}
@Injectable()
export class ApplicationsService {
  constructor(@Inject(APPLICATIONS_REPOSITORY) private readonly applications: ApplicationsRepository,
    @Inject(APPLICATION_WORKFLOW) private readonly workflow: ApplicationWorkflow) {}
  submitCreatorApplication(input: SubmitCreatorApplicationInput): Promise<CreatorApplicationRow> {
    return this.workflow.run(async tx => {
      assertApplicant(await tx.applications.lockApplicant(input.userId, APPLICATION.kind.creator));
      if (await tx.applications.hasCreatorProfile(input.userId)) throw new ConflictException(APPLICATION.failure.creatorExists);
      if (await tx.applications.findActiveCreatorApplication(input.userId)) throw new ConflictException(APPLICATION.failure.active);
      const application = await tx.applications.createCreatorApplication(input);
      await tx.notifications.record(applicationNotification(APPLICATION.kind.creator, application));
      return application;
    });
  }
  submitBrandApplication(input: SubmitBrandApplicationInput): Promise<BrandApplicationRow> {
    return this.workflow.run(async tx => {
      assertApplicant(await tx.applications.lockApplicant(input.userId, APPLICATION.kind.brand));
      if (await tx.applications.findActiveBrandApplication(input.userId)) throw new ConflictException(APPLICATION.failure.active);
      const application = await tx.applications.createBrandApplication(input);
      await tx.notifications.record(applicationNotification(APPLICATION.kind.brand, application));
      return application;
    });
  }
  resubmitCreatorApplication(id: string, input: SubmitCreatorApplicationInput, expectedVersion: number): Promise<CreatorApplicationRow> {
    return this.workflow.run(async tx => {
      assertApplicant(await tx.applications.lockApplicant(input.userId, APPLICATION.kind.creator));
      const row = await tx.applications.lockCreatorApplication(id);
      if (!row || row.userId !== input.userId) throw new NotFoundException(APPLICATION.failure.notFound);
      assertVersion(row.version, expectedVersion);
      if (!(APPLICATION_CORRECTABLE_STATUSES as readonly string[]).includes(row.status)) throw new ConflictException(APPLICATION.failure.correction);
      if (await tx.applications.hasCreatorProfile(input.userId)) throw new ConflictException(APPLICATION.failure.creatorExists);
      const active = await tx.applications.findActiveCreatorApplication(input.userId);
      if (active && active.id !== id) throw new ConflictException(APPLICATION.failure.active);
      const application = await tx.applications.updateCreatorApplication(id, input);
      await tx.notifications.record(applicationNotification(APPLICATION.kind.creator, application));
      return application;
    });
  }
  resubmitBrandApplication(id: string, input: SubmitBrandApplicationInput, expectedVersion: number): Promise<BrandApplicationRow> {
    return this.workflow.run(async tx => {
      assertApplicant(await tx.applications.lockApplicant(input.userId, APPLICATION.kind.brand));
      const row = await tx.applications.lockBrandApplication(id);
      if (!row || row.userId !== input.userId) throw new NotFoundException(APPLICATION.failure.notFound);
      assertVersion(row.version, expectedVersion);
      if (!(APPLICATION_CORRECTABLE_STATUSES as readonly string[]).includes(row.status)) throw new ConflictException(APPLICATION.failure.correction);
      const active = await tx.applications.findActiveBrandApplication(input.userId);
      if (active && active.id !== id) throw new ConflictException(APPLICATION.failure.active);
      const application = await tx.applications.updateBrandApplication(id, input);
      await tx.notifications.record(applicationNotification(APPLICATION.kind.brand, application));
      return application;
    });
  }
  async reviewApplication(input: ReviewApplicationInput): Promise<{application: CreatorApplicationRow | BrandApplicationRow}> {
    const reference = input.applicationType === APPLICATION.kind.creator
      ? await this.applications.findCreatorApplication(input.applicationId) : await this.applications.findBrandApplication(input.applicationId);
    if (!reference) throw new NotFoundException(APPLICATION.failure.notFound);
    return this.workflow.run(async tx => {
      // Applicant lock always precedes the application lock, including corrections and submissions.
      assertApplicant(await tx.applications.lockApplicant(reference.userId, input.applicationType));
      const application = input.applicationType === APPLICATION.kind.creator
        ? await tx.applications.lockCreatorApplication(input.applicationId) : await tx.applications.lockBrandApplication(input.applicationId);
      if (!application) throw new NotFoundException(APPLICATION.failure.notFound);
      assertVersion(application.version, input.expectedVersion);
      if (application.status === APPLICATION.status.accepted && input.decision === APPLICATION.decision.accept) {
        if (input.applicationType === APPLICATION.kind.creator) await tx.provisioning.provisionCreatorFromApplication(application as CreatorApplicationRow);
        else await tx.provisioning.provisionBrandFromApplication(application as BrandApplicationRow);
        await tx.identity.ensureRole(application.userId, APPLICATION.role[input.applicationType]);
        return {application};
      }
      if (!(APPLICATION_ACTIVE_STATUSES as readonly string[]).includes(application.status)) throw new ConflictException(APPLICATION.failure.closed);
      if (input.decision !== APPLICATION.decision.accept && (!input.notes || input.notes.trim().length < APPLICATION.limits.detailMin)) throw new BadRequestException(APPLICATION.failure.reason);
      if (input.decision === APPLICATION.decision.accept && !application.dossier) throw new ConflictException(APPLICATION.failure.dossier);
      const status = decisionToStatus[input.decision];
      await tx.applications.createReview(input);
      if (input.applicationType === APPLICATION.kind.creator) {
        const updated = await tx.applications.updateCreatorApplicationStatus(input.applicationId, status);
        if (status === APPLICATION.status.accepted) {
          await tx.provisioning.provisionCreatorFromApplication(updated);
          await tx.identity.ensureRole(updated.userId, APPLICATION.role.creator);
        }
        await tx.notifications.record(applicationNotification(APPLICATION.kind.creator, updated, input.notes));
        return {application: updated};
      }
      const updated = await tx.applications.updateBrandApplicationStatus(input.applicationId, status);
      if (status === APPLICATION.status.accepted) {
        await tx.provisioning.provisionBrandFromApplication(updated);
        await tx.identity.ensureRole(updated.userId, APPLICATION.role.brand);
      }
      await tx.notifications.record(applicationNotification(APPLICATION.kind.brand, updated, input.notes));
      return {application: updated};
    });
  }
}

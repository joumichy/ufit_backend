import { IDENTITY_REPOSITORY, type IdentityRepository } from '../identity/domain/identity.repository';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { BrandApplicationRow, CreatorApplicationRow } from '../../shared/infrastructure/database/schema';
import {
  APPLICATIONS_REPOSITORY,
  PROFILE_PROVISIONING_PORT,
  type ApplicationStatus,
  type ApplicationsRepository,
  type ProfileProvisioningPort,
  type ReviewApplicationInput,
  type SubmitBrandApplicationInput,
  type SubmitCreatorApplicationInput
} from './types/application.types';

const decisionToStatus: Record<ReviewApplicationInput['decision'], ApplicationStatus> = {
  accept: 'accepted',
  reject: 'rejected',
  waitlist: 'waitlisted',
  needs_more_info: 'needs_more_info'
};

@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(APPLICATIONS_REPOSITORY) private readonly applicationsRepository: ApplicationsRepository,
    @Inject(PROFILE_PROVISIONING_PORT) private readonly profileProvisioning: ProfileProvisioningPort,
    @Inject(IDENTITY_REPOSITORY) private readonly identity: Pick<IdentityRepository, 'ensureRole'>
  ) {}

  async submitCreatorApplication(input: SubmitCreatorApplicationInput): Promise<CreatorApplicationRow> {
    const existing = await this.applicationsRepository.findActiveCreatorApplication(input.userId);
    if (existing) {
      throw new ConflictException('A creator application is already active for this user');
    }

    return this.applicationsRepository.createCreatorApplication(input);
  }

  async submitBrandApplication(input: SubmitBrandApplicationInput): Promise<BrandApplicationRow> {
    const existing = await this.applicationsRepository.findActiveBrandApplication(input.userId);
    if (existing) {
      throw new ConflictException('A brand application is already active for this user');
    }

    return this.applicationsRepository.createBrandApplication(input);
  }

  async reviewApplication(input: ReviewApplicationInput): Promise<{ application: CreatorApplicationRow | BrandApplicationRow }> {
    const status = decisionToStatus[input.decision];

    if (input.applicationType === 'creator') {
      const application = await this.applicationsRepository.findCreatorApplication(input.applicationId);
      if (!application) {
        throw new NotFoundException('Creator application not found');
      }

      await this.applicationsRepository.createReview(input);
      const updated = await this.applicationsRepository.updateCreatorApplicationStatus(input.applicationId, status);
      if (status === 'accepted') {
        await this.profileProvisioning.provisionCreatorFromApplication(updated);
        await this.identity.ensureRole(updated.userId, 'creator');
      }
      return { application: updated };
    }

    const application = await this.applicationsRepository.findBrandApplication(input.applicationId);
    if (!application) {
      throw new NotFoundException('Brand application not found');
    }

    await this.applicationsRepository.createReview(input);
    const updated = await this.applicationsRepository.updateBrandApplicationStatus(input.applicationId, status);
    if (status === 'accepted') {
      await this.profileProvisioning.provisionBrandFromApplication(updated);
      await this.identity.ensureRole(updated.userId, 'brand_owner');
    }
    return { application: updated };
  }
}

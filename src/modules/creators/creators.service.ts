import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PROFILE_EDITING, PROFILE_STATUS } from '../../shared/domain/profile-editing.contract';
import type { CreatorProfileDetails } from './creators.repository';
import type { CreatorApplicationRow, CreatorProfileRow } from '../../shared/infrastructure/database/schema';
import type { UpdateCreatorProfileRequest } from './dto/update-creator-profile.request';
import type { CreatorsRepository } from './creators.repository';
import { CREATORS_REPOSITORY } from './creators.tokens';

const creatorProfileFailure = {notFound: 'Creator profile not found', suspended: 'Suspended creators cannot update their profile'} as const;

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'creator';
}

@Injectable()
export class CreatorsService {
  constructor(@Inject(CREATORS_REPOSITORY) private readonly creatorsRepository: CreatorsRepository) {}

  async provisionFromApplication(application: CreatorApplicationRow): Promise<void> {
    const existing = await this.creatorsRepository.findProfileByApplicationId(application.id);
    if (existing) {
      return;
    }

    const profile = await this.creatorsRepository.createProfile({
      userId: application.userId,
      applicationId: application.id,
      displayName: application.displayName,
      slug: `${slugify(application.displayName)}-${application.id.slice(0, 8)}`,
      status: PROFILE_STATUS.active,
      gradeCode: 'seed'
    });
    await this.creatorsRepository.addInitialGradeHistory(profile.id);
  }

  async getOwnProfile(userId: string): Promise<CreatorProfileRow> {
    const profile = await this.creatorsRepository.findProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException(creatorProfileFailure.notFound);
    }
    return profile;
  }

  async getOwnDetails(userId: string): Promise<CreatorProfileDetails> {
    const details = await this.creatorsRepository.findDetailsByUserId(userId);
    if (!details) throw new NotFoundException(creatorProfileFailure.notFound);
    return details;
  }

  async updateOwnProfile(userId: string, input: UpdateCreatorProfileRequest): Promise<CreatorProfileRow> {
    const profile = await this.getOwnProfile(userId);
    if (profile.status === PROFILE_STATUS.suspended) {
      throw new ForbiddenException(creatorProfileFailure.suspended);
    }

    const updated = await this.creatorsRepository.updateProfile(profile.id, input, userId);
    if (!updated) throw new ForbiddenException(PROFILE_EDITING.failure.changed);
    return updated;
  }
}

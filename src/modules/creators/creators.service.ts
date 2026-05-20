import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreatorApplicationRow, CreatorProfileRow } from '../../shared/infrastructure/database/schema';
import type { UpdateCreatorProfileRequest } from './dto/update-creator-profile.request';
import type { CreatorsRepository } from './creators.repository';
import { CREATORS_REPOSITORY } from './creators.tokens';

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
      status: 'active',
      gradeCode: 'seed'
    });
    await this.creatorsRepository.addInitialGradeHistory(profile.id);
  }

  async getOwnProfile(userId: string): Promise<CreatorProfileRow> {
    const profile = await this.creatorsRepository.findProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Creator profile not found');
    }
    return profile;
  }

  async updateOwnProfile(userId: string, input: UpdateCreatorProfileRequest): Promise<CreatorProfileRow> {
    const profile = await this.getOwnProfile(userId);
    if (profile.status === 'suspended') {
      throw new ForbiddenException('Suspended creators cannot update their profile');
    }

    return this.creatorsRepository.updateProfile(profile.id, input);
  }
}
